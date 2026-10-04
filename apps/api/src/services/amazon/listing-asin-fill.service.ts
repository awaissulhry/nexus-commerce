/**
 * The ASIN of a published Amazon listing, read back from Amazon (Owner, 2026-09-27).
 *
 * Amazon's feed processing report accepts a SKU without naming the ASIN it assigned. So a row Publish promotes
 * (`promoteAcceptedDrafts`: published, ACTIVE, unpaused) keeps `externalListingId` null, and no scheduled job wrote one.
 * This is the one writer: Listings Items (`getListingsItem`, summaries) through each row's OWN account and the channel
 * gateway, then a write scoped to that row's coordinate that never replaces an ASIN already recorded.
 *
 *  - `filled`           Amazon returned an ASIN. It is written, with Amazon's status stored as Amazon reports it (the
 *                       flat-file pull's rule) on a DRAFT or live row, and a row still marked DRAFT becomes published. An
 *                       ended, inactive or failed row gains its ASIN only. `version` moves (sheet CAS).
 *  - `not_visible_yet`  Amazon answered 404 or without an ASIN: still propagating. Nothing changes.
 *  - `already_had_asin` The row carries an ASIN already. Amazon is not read.
 *  - `error`            The row cannot be read (no account, an ambiguous seller SKU, Amazon refused). Nothing changes.
 *
 * Amazon is called outside any database transaction, a few rows at a time; the gateway owns rate limits and retries.
 * `dryRun` reads Amazon and reports the same outcomes, and writes nothing.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { AmazonSpApiClient } from '../../clients/amazon-sp-api.client.js'
import { getAmazonRegion, getAmazonSellerId } from '../../lib/amazon-sp-client.js'
import { configuredAmazonMarketplaceId } from '../categories/marketplace-ids.js'
import { AMAZON_LISTING_SKU_KEYS } from '../channel-mapping/defaults.js'
import { productReadCacheService } from '../product-read-cache.service.js'
import { AMAZON_LIVE_STATUSES } from '@nexus/shared/listing-risk'
import { announceListingValues } from '../listing-values-events.js'

export type AsinFillOutcome = 'filled' | 'not_visible_yet' | 'already_had_asin' | 'error'

export interface AsinFillRow {
  id: string
  sku: string | null
  marketplace: string | null
  outcome: AsinFillOutcome
  asin?: string
  status?: string
  reason?: string
}

export interface AsinFillReport {
  dryRun: boolean
  rows: AsinFillRow[]
  counts: Record<AsinFillOutcome, number>
}

/** Rows one call reads at most: the operator route's cap. */
export const ASIN_FILL_MAX = 200
/** Rows the retry sweep reads per business and run. */
export const ASIN_SWEEP_BATCH = 50
/** How long after its last update a promoted row keeps being retried. */
export const ASIN_SWEEP_WINDOW_MS = 7 * 24 * 60 * 60_000
const CONCURRENCY = 3

const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

const LISTING_SELECT = {
  id: true, productId: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true,
  externalListingId: true, isPublished: true, listingStatus: true, platformAttributes: true, flatFileSnapshot: true,
  offers: { select: { sku: true, isActive: true } }, product: { select: { sku: true } },
} as const

interface FillListing {
  aliasKey: string
  offers: Array<{ sku: string; isActive: boolean }>
  platformAttributes: unknown
  flatFileSnapshot: unknown
  product: { sku: string } | null
}

/**
 * The seller SKU Publish sends for this row, by `prepareAmazonPublication`'s rule: its one active offer's SKU or the
 * SKU stored on the listing, else the product SKU. An alias listing needs a seller SKU of its own.
 */
export function sellerSkuOf(listing: FillListing): { sku: string } | { reason: string } {
  const offers = [...new Set(listing.offers.filter(o => o.isActive).map(o => o.sku))]
  if (offers.length > 1) return { reason: 'This listing has more than one active seller SKU. Select its offer first.' }
  const pa = object(listing.platformAttributes)
  const ff = object(listing.flatFileSnapshot)
  const identities = [...new Set([...offers, ...[...AMAZON_LISTING_SKU_KEYS.platformAttributes.map(k => pa[k]), ...AMAZON_LISTING_SKU_KEYS.flatFileSnapshot.map(k => ff[k])]
    .filter((v): v is string => typeof v === 'string' && !!v.trim())])]
  if (identities.length > 1) return { reason: 'This listing carries conflicting seller SKUs. Reconcile its identity first.' }
  if (identities[0]) return { sku: identities[0] }
  if (listing.aliasKey) return { reason: 'This listing alias has no seller SKU of its own.' }
  return listing.product?.sku ? { sku: listing.product.sku } : { reason: 'The product has no SKU.' }
}

/** Amazon's summary status as the codebase stores it (`amazon.service.ts`): the first entry of the status array, else `itemStatus`. */
export function summaryStatus(read: { status?: unknown; rawResponse?: unknown }): string | null {
  const summaries = object(read.rawResponse).summaries
  const summary = object(Array.isArray(summaries) ? summaries[0] : null)
  const raw = (Array.isArray(summary.status) ? summary.status[0] : summary.status) ?? summary.itemStatus
    ?? (Array.isArray(read.status) ? read.status[0] : read.status)
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

async function eachLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++])
  }))
}

/** One read client per account, built once per call. */
function accountReaders() {
  const accounts = new Map<string, Promise<{ client: AmazonSpApiClient; sellerId: string }>>()
  const markets = new Map<string, Promise<string | undefined>>()
  return {
    account: (accountId: string) => {
      if (!accounts.has(accountId)) accounts.set(accountId, (async () => ({
        client: new AmazonSpApiClient({ id: accountId, region: await getAmazonRegion(accountId) }),
        sellerId: await getAmazonSellerId(accountId),
      }))())
      return accounts.get(accountId)!
    },
    marketplaceId: (code: string) => {
      if (!markets.has(code)) markets.set(code, configuredAmazonMarketplaceId(code))
      return markets.get(code)!
    },
  }
}

/** Read each listing's ASIN from Amazon and write the ones Amazon returns. `dryRun` writes nothing. */
export async function fillAmazonListingAsins(listingIds: readonly string[], options: { dryRun?: boolean } = {}): Promise<AsinFillReport> {
  const dryRun = options.dryRun === true
  const ids = [...new Set(listingIds)]
  if (ids.length > ASIN_FILL_MAX) throw new Error(`At most ${ASIN_FILL_MAX} listings can be read at once.`)
  const listings = ids.length ? await prisma.channelListing.findMany({ where: { id: { in: ids }, channel: 'AMAZON' }, select: LISTING_SELECT }) : []
  const byId = new Map(listings.map(listing => [listing.id, listing]))
  const readers = accountReaders()
  const report = new Map<string, AsinFillRow>()
  const written = new Set<string>()
  const filled: string[] = []

  await eachLimited(ids, CONCURRENCY, async id => {
    const row = byId.get(id)
    if (!row) { report.set(id, { id, sku: null, marketplace: null, outcome: 'error', reason: 'No Amazon listing with this id in this business profile.' }); return }
    const base = { id, marketplace: row.marketplace }
    const identity = sellerSkuOf(row)
    const sku = 'sku' in identity ? identity.sku : null
    if (row.externalListingId?.trim()) { report.set(id, { ...base, sku, outcome: 'already_had_asin', asin: row.externalListingId }); return }
    if (row.externalListingId !== null) { report.set(id, { ...base, sku, outcome: 'error', reason: 'The listing records a blank ASIN. Clear it before reading Amazon.' }); return }
    if (!row.channelConnectionId) { report.set(id, { ...base, sku, outcome: 'error', reason: 'This listing has no Amazon account.' }); return }
    if (!sku) { report.set(id, { ...base, sku, outcome: 'error', reason: (identity as { reason: string }).reason }); return }
    try {
      const marketplaceId = await readers.marketplaceId(row.marketplace)
      if (!marketplaceId) { report.set(id, { ...base, sku, outcome: 'error', reason: `No Amazon marketplace is configured for ${row.marketplace}.` }); return }
      const { client, sellerId } = await readers.account(row.channelConnectionId)
      const read = await client.getListingsItem({ sellerId, sku, marketplaceId, includedData: ['summaries'] })
      if (!read.success) { report.set(id, { ...base, sku, outcome: 'error', reason: read.error ?? 'Amazon could not read this listing.' }); return }
      const asin = typeof read.asin === 'string' ? read.asin.trim() : ''
      // The client answers HTTP 404 as success with no ASIN: the listing is still propagating.
      if (!asin) { report.set(id, { ...base, sku, outcome: 'not_visible_yet', reason: 'Amazon has not made this listing visible yet.' }); return }
      const status = summaryStatus(read)
      if (!dryRun) {
        const current = (row.listingStatus ?? '').trim().toUpperCase()
        const draft = !current || current === 'DRAFT'
        // A row still marked DRAFT that Amazon holds becomes published. It, and a published row in a live status, take
        // Amazon's status (a DRAFT row with none reported becomes ACTIVE, the flat-file pull's default). Any other row —
        // ended, inactive, in error — gains its ASIN only, so a read never lifts a lock such as ENDED.
        const takesStatus = draft || (row.isPublished === true && AMAZON_LIVE_STATUSES.includes(current))
        const listingStatus = takesStatus ? status ?? (draft ? 'ACTIVE' : null) : null
        const updated = await prisma.channelListing.updateMany({
          where: { id, channel: 'AMAZON', channelConnectionId: row.channelConnectionId, marketplace: row.marketplace, aliasKey: row.aliasKey, externalListingId: null },
          data: { externalListingId: asin, version: { increment: 1 }, ...(draft ? { isPublished: true } : {}), ...(listingStatus ? { listingStatus } : {}) },
        })
        if (updated.count !== 1) {
          const now = await prisma.channelListing.findFirst({ where: { id }, select: { externalListingId: true } })
          report.set(id, now?.externalListingId?.trim()
            ? { ...base, sku, outcome: 'already_had_asin', asin: now.externalListingId, reason: 'Another write recorded an ASIN first.' }
            : { ...base, sku, outcome: 'error', reason: 'The listing changed while Amazon was read. Nothing was written.' })
          return
        }
        written.add(row.productId)
        filled.push(id)
      }
      report.set(id, { ...base, sku, outcome: 'filled', asin, ...(status ? { status } : {}) })
    } catch (error) {
      report.set(id, { ...base, sku, outcome: 'error', reason: message(error) })
    }
  })

  // The /products grid reads listing status from its cache; keep it in step with what was just written.
  if (written.size) await productReadCacheService.refreshMany([...written]).catch(error => logger.warn('amazon asin fill: read cache refresh failed', { error: message(error) }))
  // Open sheets and Matrix tabs show the new ASIN (and the listing's new version) without a reload.
  if (filled.length) announceListingValues(filled, ['externalListingId'], 'asin-fill')
  const rows = ids.map(id => report.get(id)!)
  const counts: Record<AsinFillOutcome, number> = { filled: 0, not_visible_yet: 0, already_had_asin: 0, error: 0 }
  for (const row of rows) counts[row.outcome]++
  logger.info('amazon asin fill', { dryRun, ...counts })
  return { dryRun, rows, counts }
}

/**
 * The operator's default set: Amazon rows Amazon may hold with no ASIN recorded — published, or past DRAFT (old creators
 * left `DRAFT` rows `isPublished: true`). Newest first, at most `ASIN_FILL_MAX`.
 */
export async function unfilledAmazonListingIds(limit = ASIN_FILL_MAX): Promise<string[]> {
  const rows = await prisma.channelListing.findMany({
    where: { channel: 'AMAZON', externalListingId: null, product: { deletedAt: null }, OR: [{ isPublished: true }, { listingStatus: { not: 'DRAFT' } }] },
    select: { id: true }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: Math.min(limit, ASIN_FILL_MAX),
  })
  return rows.map(row => row.id)
}

/** The retry sweep's set: published Amazon rows in a live status with no ASIN, updated in the last seven days. */
export async function pendingAsinListingIds(now = Date.now(), limit = ASIN_SWEEP_BATCH): Promise<string[]> {
  const rows = await prisma.channelListing.findMany({
    where: { channel: 'AMAZON', externalListingId: null, isPublished: true, listingStatus: { in: [...AMAZON_LIVE_STATUSES] },
      channelConnectionId: { not: null }, updatedAt: { gte: new Date(now - ASIN_SWEEP_WINDOW_MS) } },
    select: { id: true }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: limit,
  })
  return rows.map(row => row.id)
}
