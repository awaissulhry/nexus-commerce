/**
 * "Refresh from Amazon": `POST /api/listings/:id/resync` for ONE listing (S.0 / C-3; rebuilt 2026-10-26).
 *
 * Amazon — a READ of the listing as Amazon holds it now (Listings Items `getListingsItem`), through the listing's OWN
 * account (the seller id and region of `channelConnectionId`) and the channel gateway, by the seller SKU Amazon knows
 * it by: the listing's own reported SKU (`reportedSkuOf`), else the product SKU — never the ASIN. The studio's live
 * read (`live-read/index.ts`) reads the same way, and both use the helpers of `live-read/amazon.ts`.
 *
 *   found     Only Amazon's own facts are stored: its status (the ASIN filler's rule, `amazonReadStatus`: an ended,
 *             inactive or failed row keeps its status), the ASIN when the row has none, Amazon's open messages
 *             (`recordAmazonListingIssues`, source `listings-api`: what Amazon no longer reports is resolved) and the read
 *             time (IN_SYNC / SUCCESS). Price, quantity and title are NEVER written: Amazon's values come back in the
 *             answer, beside Nexus's. A different stored ASIN is kept. A listing that is still a Nexus draft is not
 *             marked live: its pause would then be an operator's hold, and Publish would refuse it.
 *             (Amazon's Listings API names no parent ASIN — only parent SKUs — so `externalParentId` is not read here.)
 *   absent    Amazon's 404: answered 404 in words, the SyncAttempt is NOT_FOUND, the listing's push status is put back.
 *   error     502 (504 on a timeout) with the reason; the SyncAttempt records the failed read; the listing's push status
 *             is put back — a read that failed is not a push that failed — and `syncRetryCount` is not touched.
 *   refused   No account (409), no single seller SKU (409), no marketplace id (409), an account that cannot be used (its
 *             own status): nothing is marked and Amazon is not called.
 *
 * Other channels have no read primitive yet: 501, as before, with the attempt recorded and the listing untouched.
 * Single listing only; the bulk-action "resync" is a different path and unchanged.
 */
import type { ChannelListing } from '@prisma/client'
import { isStillDraftListing } from '@nexus/shared/push-lock'
import prisma from '../../db.js'
import { AmazonSpApiClient } from '../../clients/amazon-sp-api.client.js'
import { getAmazonRegion, getAmazonSellerId } from '../../lib/amazon-sp-client.js'
import { WorkspaceError } from '../../lib/workspace-context.js'
import { logger } from '../../utils/logger.js'
import { amazonReadStatus, summaryStatus } from '../amazon/listing-asin-fill.service.js'
import { configuredAmazonMarketplaceId } from '../categories/marketplace-ids.js'
import { b2cOfferOf, listingsItemRead, merchantAvailabilityOf } from '../live-read/amazon.js'
import { publishListingEvent } from '../listing-events.service.js'
import { recordAmazonListingIssues } from '../listing-issue-recorder.service.js'
import { announceListingValues } from '../listing-values-events.js'
import { MARKET_CATALOGUE } from '../pim/market-catalogue.js'
import { productReadCacheService } from '../product-read-cache.service.js'
import { CHANNEL_SKU_LISTING_SELECT } from './channel-sku.js'
import { reportedSkuOf } from './reported-sku.js'

/** One of Amazon's messages on the listing, as Amazon wrote it. */
export interface AmazonIssue { code: string; message: string; severity: string; attributeNames: string[] }

/** What Amazon holds for the listing now. Never stored as Nexus's price or quantity. */
export interface AmazonNow {
  readAt: string
  market: string
  /** The seller SKU Amazon was asked for. */
  sku: string
  /** Amazon's summary status (BUYABLE, DISCOVERABLE, …), first entry. */
  status: string | null
  asin: string | null
  price: number | null
  currency: string | null
  /** The merchant quantity. Null for FBA: Amazon's Listings API does not report Amazon-fulfilled stock. */
  quantity: number | null
  fulfillment: 'FBA' | 'FBM' | null
  /** Why `quantity` is null, in words. */
  quantityNote: string | null
  issues: AmazonIssue[]
  /** What the read did not record, and why. */
  notes: string[]
}

export type ResyncAnswer =
  | { ok: true; listing: ChannelListing; amazon?: AmazonNow }
  | { ok: false; status: number; body: { error: string; detail?: string } }

export class ResyncTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Channel did not respond within ${timeoutMs}ms.`)
    this.name = 'ResyncTimeoutError'
  }
}

/** Amazon SP-API P50 is under 2 s, P99 around 8 s: past this the person gets an answer rather than a hanging request. */
const TIMEOUT_MS = 10_000
const INCLUDED_DATA = ['summaries', 'offers', 'fulfillmentAvailability', 'issues'] as const
export const NO_AMAZON_ACCOUNT = 'This listing has no Amazon account. Link it to an account first.'
export const FBA_QUANTITY_NOTE = 'Amazon-fulfilled (FBA): Amazon’s Listings API does not report this stock.'
const DRAFT_NOTE = 'Nexus still holds this listing as a draft, so the read did not mark it live or link its ASIN. Publish sends it.'
const CHANGED = 'This listing changed while Amazon was read. Nothing was written; refresh again.'

const LISTING_SELECT = { ...CHANNEL_SKU_LISTING_SELECT, syncStatus: true, lastSyncStatus: true } as const

const refused = (status: number, error: string): ResyncAnswer => ({ ok: false, status, body: { error } })
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** "Italy" for IT (the market catalogue's "Amazon Italy"), else the code. */
function marketName(code: string): string {
  const name = MARKET_CATALOGUE.find((m) => m.channel === 'AMAZON' && m.code === code)?.name
  return name ? name.replace(/^Amazon\s+/i, '') : code
}

const readListing = (id: string) => prisma.channelListing.findUnique({ where: { id }, select: LISTING_SELECT })
type Listing = NonNullable<Awaited<ReturnType<typeof readListing>>>

/** Read one listing from its channel and record what the channel says. */
export async function resyncListing(id: string, options: { source?: string; timeoutMs?: number } = {}): Promise<ResyncAnswer> {
  const listing = await readListing(id)
  if (!listing) return refused(404, 'Listing not found')
  const source = options.source ?? 'manual'
  if (listing.channel === 'AMAZON') return refreshFromAmazon(listing, source, options.timeoutMs ?? TIMEOUT_MS)

  if (!listing.externalListingId) return refused(400, 'Listing has no externalListingId — never been published. Cannot resync.')
  // eBay, Shopify, WooCommerce, Etsy: no fetch-listing-state primitive yet. Said plainly; the listing is not touched.
  const detail = `Resync is not yet implemented for channel "${listing.channel}".`
  await prisma.syncAttempt.create({ data: { listingId: id, status: 'NOT_IMPLEMENTED', source, durationMs: 0, error: detail } })
  publishListingEvent({ type: 'listing.synced', listingId: id, status: 'NOT_IMPLEMENTED', durationMs: 0, ts: Date.now() })
  return { ok: false, status: 501, body: { error: 'NOT_IMPLEMENTED', detail } }
}

async function refreshFromAmazon(listing: Listing, source: string, timeoutMs: number): Promise<ResyncAnswer> {
  // Everything that can refuse is decided before anything is marked or Amazon is called.
  const accountId = listing.channelConnectionId
  if (!accountId) return refused(409, NO_AMAZON_ACCOUNT)
  const skuAnswer = reportedSkuOf(listing, listing.product?.sku)
  if (skuAnswer.sku === null) return refused(409, skuAnswer.conflict.sentence)
  const sku = skuAnswer.sku
  const market = listing.marketplace
  const marketplaceId = await configuredAmazonMarketplaceId(market)
  if (!marketplaceId) return refused(409, `No Amazon marketplace is configured for ${market}.`)
  let sellerId: string
  let region: string
  try {
    sellerId = await getAmazonSellerId(accountId)
    region = await getAmazonRegion(accountId)
  } catch (error) {
    if (error instanceof WorkspaceError) return refused(error.statusCode, error.message)
    throw error
  }

  // The attempt is on the timeline even if the call hangs; the listing shows the read in flight.
  const startedAt = Date.now()
  const before = { syncStatus: listing.syncStatus, lastSyncStatus: listing.lastSyncStatus }
  const attempt = await prisma.syncAttempt.create({ data: { listingId: listing.id, status: 'IN_PROGRESS', source }, select: { id: true } })
  await prisma.channelListing.update({ where: { id: listing.id }, data: { syncStatus: 'SYNCING', lastSyncStatus: 'PENDING' } })
  publishListingEvent({ type: 'listing.syncing', listingId: listing.id, ts: Date.now() })

  const finish = async (status: 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'NOT_FOUND', error?: string) => {
    const durationMs = Date.now() - startedAt
    await prisma.syncAttempt.update({ where: { id: attempt.id }, data: { status, durationMs, ...(error ? { error } : {}) } })
    publishListingEvent({ type: 'listing.synced', listingId: listing.id, status, durationMs, ts: Date.now() })
  }
  // A read that did not land changes nothing: the push status goes back, unless something else moved it meanwhile.
  const putBack = () => prisma.channelListing.updateMany({ where: { id: listing.id, syncStatus: 'SYNCING', lastSyncStatus: 'PENDING' }, data: before })
  const failed = async (status: number, attemptStatus: 'FAILED' | 'TIMEOUT' | 'NOT_FOUND', error: string): Promise<ResyncAnswer> => {
    await putBack()
    await finish(attemptStatus, error)
    return refused(status, error)
  }

  let result: Awaited<ReturnType<AmazonSpApiClient['getListingsItem']>>
  try {
    const client = new AmazonSpApiClient({ id: accountId, region })
    result = await withTimeout(timeoutMs, () => client.getListingsItem({ sellerId, sku, marketplaceId, includedData: [...INCLUDED_DATA] }))
  } catch (error) {
    if (error instanceof ResyncTimeoutError) return failed(504, 'TIMEOUT', `Amazon did not answer in time (${timeoutMs / 1000} s). Nothing was changed.`)
    return failed(502, 'FAILED', `Amazon could not read this listing: ${message(error)}`)
  }
  const read = listingsItemRead(result)
  if (read.status === 'error') return failed(502, 'FAILED', `Amazon could not read this listing: ${read.reason}`)
  if (read.status === 'absent') return failed(404, 'NOT_FOUND', `Amazon has no listing with seller SKU ${sku} in ${marketName(market)}.`)

  // Found: Amazon's own facts only.
  const raw = read.raw
  const status = summaryStatus({ rawResponse: raw })
  const asin = typeof result.asin === 'string' && result.asin.trim() ? result.asin.trim() : null
  const notes: string[] = []
  const facts: { isPublished?: true; listingStatus?: string; externalListingId?: string } = {}
  if (isStillDraftListing(listing)) notes.push(DRAFT_NOTE)
  else {
    Object.assign(facts, amazonReadStatus(listing, status))
    const stored = listing.externalListingId?.trim() ?? null
    if (asin && listing.externalListingId === null) facts.externalListingId = asin
    else if (asin && stored && stored !== asin) notes.push(`Nexus links this listing to ASIN ${stored}; Amazon reports ${asin} for this SKU. The link was not changed.`)
  }
  const readAt = new Date()
  // Written only on the facts it was decided on: a row that changed meanwhile is not overwritten.
  const { count } = await prisma.channelListing.updateMany({
    where: { id: listing.id, listingStatus: listing.listingStatus, isPublished: listing.isPublished, externalListingId: listing.externalListingId },
    data: { ...facts, syncStatus: 'IN_SYNC', lastSyncStatus: 'SUCCESS', lastSyncedAt: readAt, lastSyncError: null, version: { increment: 1 } },
  })
  if (count !== 1) return failed(409, 'FAILED', CHANGED)

  const issues: AmazonIssue[] = (result.issues ?? []).map((issue) => ({
    code: String(issue.code ?? 'UNKNOWN'),
    message: String(issue.message ?? ''),
    severity: String(issue.severity ?? 'ERROR'),
    attributeNames: Array.isArray(issue.attributeNames) ? issue.attributeNames.map(String) : [],
  }))
  // Amazon's messages are the listing's whole current verdict (a REPLACE source): what it no longer reports is resolved.
  // Only when Amazon sent the list: a read without one says nothing about the messages.
  if (Array.isArray(result.issues)) await recordAmazonListingIssues({ listingId: listing.id, sku, marketplaceId, issues })
  await finish('SUCCESS')

  if (facts.listingStatus || facts.externalListingId) {
    await productReadCacheService.refreshMany([listing.productId]).catch((error) => logger.warn('amazon refresh: read cache refresh failed', { error: message(error) }))
  }
  announceListingValues([listing.id], facts.externalListingId ? ['syncState', 'externalListingId'] : ['syncState'], 'amazon-refresh')

  const offer = b2cOfferOf(raw, marketplaceId)
  const amount = offer?.price?.amount != null ? Number(offer.price.amount) : NaN
  const merchant = merchantAvailabilityOf(raw)
  const quantity = Number.isSafeInteger(merchant?.quantity) ? (merchant!.quantity as number) : null
  const amazonFulfilled = Array.isArray(raw.fulfillmentAvailability)
    && raw.fulfillmentAvailability.some((f: { fulfillmentChannelCode?: unknown }) => typeof f?.fulfillmentChannelCode === 'string' && f.fulfillmentChannelCode !== 'DEFAULT')
  const fulfillment = quantity === null && amazonFulfilled ? 'FBA' : merchant ? 'FBM' : null
  const updated = await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })
  return {
    ok: true,
    listing: updated,
    amazon: {
      readAt: readAt.toISOString(),
      market,
      sku,
      status,
      asin,
      price: Number.isFinite(amount) ? amount : null,
      currency: typeof offer?.price?.currencyCode === 'string' ? offer.price.currencyCode : null,
      quantity,
      fulfillment,
      quantityNote: quantity !== null ? null : fulfillment === 'FBA' ? FBA_QUANTITY_NOTE : 'Amazon reports no quantity for this seller SKU.',
      issues,
      notes,
    },
  }
}

function withTimeout<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ResyncTimeoutError(ms)), ms)
    fn().then(
      (value) => { clearTimeout(timer); resolve(value) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })
}
