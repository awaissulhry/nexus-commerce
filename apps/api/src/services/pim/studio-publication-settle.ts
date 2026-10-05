/**
 * Sheet publish parity, step 2 (docs/sheet-publish-parity/PLAN.md, item 1) — a publication reaches its result by itself.
 *
 * Until now only the submitter's own status read settled a publication: an Amazon feed nobody asked about stayed
 * SUBMITTED, and its destination stayed blocked for every later publish. The settle core lives here, with no user
 * filter, so two callers share it:
 *   - the status read (`studioPublicationResult`), which still checks that the reader submitted it;
 *   - the result sweep (`jobs/studio-publication-settle.job.ts`), which claims due rows by their `nextCheckAt` lease.
 *
 * Settling has real side effects (journals, draft promotion, ASIN read, held prices), so it happens ONCE: `storeResult`
 * is a compare-and-set on the status, and only its winner does them.
 *
 * First-deploy safety: only a row the new code scheduled (`checkCount` not null, `nextCheckAt` set) is ever swept or
 * rescheduled. A publication made before this step keeps `nextCheckAt` null, so no sweep can settle it — and send its
 * held prices — with nobody watching. Its own submitter can still read it, as before.
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import type { StudioPublishResult } from '@nexus/shared/studio-publication'
import { STILL_DRAFT_LISTING } from '@nexus/shared/push-lock'
import { ETSY_VARIATION_HIDDEN_REASON, SHEET_PAUSE_REASON } from '@nexus/shared/listing-actions'
import { explainAmazonRelist } from '@nexus/shared/publish-actions'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { object } from './studio-publication-plan.js'
import { readAmazonPublication } from './studio-publication-amazon.js'
import { readEbayPublication } from './studio-publication-ebay.js'
import { settlePublicationRecords, type PublicationRecordContext } from './studio-publication-records.js'
import { CHANNEL_SKU_LISTING_SELECT, confirmLiveChannelSku } from '../listings/channel-sku.js'
import { liveChannelSku } from '../listings/channel-sku.pure.js'
import { isStillDraftListing } from '@nexus/shared/push-lock'

export const PUBLICATION_KIND = 'studio-publication'
export const IN_FLIGHT = ['PUBLISHING', 'UNVERIFIED', 'SUBMITTED']
export const RECEIPT_DEADLINE_MS = 30 * 60_000
export const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

/**
 * D3 (Owner, 2026-10-01) — a publication still waiting for a result blocks every later publish to its destination. A
 * person who checked it on the channel may mark it checked: its status stays (Nexus never invents a result), it closes
 * (`completedAt` = when it was checked, `summary.checkedAt/checkedBy/checkedNote` say who and why), it stops blocking,
 * and the sweep leaves it. A real result that still arrives later is stored as usual and keeps the mark.
 * A publication blocks only while it is in flight AND not closed: every blocking read uses this filter.
 */
export const OPEN_PUBLICATION = { status: { in: IN_FLIGHT }, completedAt: null }

export interface PublicationCheckMark { checkedAt: string; checkedBy: string | null; checkedNote: string | null }

/** The person's check on a publication, read from its summary; null when nobody marked it. */
export function checkedMark(summary: unknown): PublicationCheckMark | null {
  const value = object(summary)
  if (typeof value.checkedAt !== 'string') return null
  return { checkedAt: value.checkedAt, checkedBy: typeof value.checkedBy === 'string' ? value.checkedBy : null,
    checkedNote: typeof value.checkedNote === 'string' ? value.checkedNote : null }
}

const MINUTE = 60_000
/** Amazon processing report: 2, 4, 8, 15 minutes, then every 30. */
const AMAZON_LADDER_MINUTES = [2, 4, 8, 15, 30]
/** eBay Trading read-back: the same start, then hourly and three-hourly — twelve tries is about a day. */
const EBAY_LADDER_MINUTES = [2, 4, 8, 15, 30, 60, 180]
/** After this an Amazon feed is no longer polled; the publication says it needs a person to check. */
export const AMAZON_CHECK_WINDOW_MS = 7 * 24 * 60 * MINUTE
export const EBAY_MAX_CHECKS = 12
const ladder = (steps: number[], attempt: number) => steps[Math.min(Math.max(attempt, 0), steps.length - 1)] * MINUTE

export interface PublicationCheck {
  /** When the sweep looks again; null = never (finished, not pollable, or given up). */
  nextCheckAt: Date | null
  /** The sweep gave up: the status stays as it is and a person must check the channel. */
  needsCheck: boolean
}

/**
 * PURE. When the result sweep next looks at a publication in `status`, after `checkCount` claims.
 * Only these are polled: a PUBLISHING row (to turn it UNVERIFIED at its 30-minute deadline), an Amazon feed still
 * SUBMITTED, and an eBay Trading item still UNVERIFIED with an item number. An eBay Inventory read-back that differed,
 * a Shopify result, and an UNVERIFIED with no channel reference need a person, not a poll.
 */
export function nextPublicationCheck(input: { channel: string; status: string; inventory: boolean; reference: boolean;
  checkCount: number; submittedAt: Date | null; now: Date }): PublicationCheck {
  const now = input.now.getTime()
  if (!IN_FLIGHT.includes(input.status)) return { nextCheckAt: null, needsCheck: false }
  if (input.status === 'PUBLISHING') {
    const deadline = (input.submittedAt?.getTime() ?? now) + RECEIPT_DEADLINE_MS + MINUTE
    return { nextCheckAt: new Date(Math.max(deadline, now + MINUTE)), needsCheck: false }
  }
  if (input.channel === 'AMAZON' && input.status === 'SUBMITTED') {
    if (input.submittedAt && now - input.submittedAt.getTime() >= AMAZON_CHECK_WINDOW_MS) return { nextCheckAt: null, needsCheck: true }
    return { nextCheckAt: new Date(now + ladder(AMAZON_LADDER_MINUTES, input.checkCount)), needsCheck: false }
  }
  if (input.channel === 'EBAY' && input.status === 'UNVERIFIED' && !input.inventory && input.reference) {
    if (input.checkCount >= EBAY_MAX_CHECKS) return { nextCheckAt: null, needsCheck: true }
    return { nextCheckAt: new Date(now + ladder(EBAY_LADDER_MINUTES, input.checkCount)), needsCheck: false }
  }
  return { nextCheckAt: null, needsCheck: false }
}

/**
 * Sheet publish parity (step 1) — a publication's result in counts, kept as `BulkOperation.summary` so a publish
 * history lists it without loading `changes`. The counts are disjoint: accepted + verified + failed + submitted =
 * products. The migration `20261004a_publication_history_columns` fills earlier publications the same way.
 */
export function publicationSummary(result: StudioPublishResult) {
  const count = (status: StudioPublishResult['results'][number]['status']) => result.results.filter(row => row.status === status).length
  return { message: result.message, products: result.results.length, accepted: count('ACCEPTED'), verified: count('VERIFIED'),
    failed: count('FAILED'), submitted: count('SUBMITTED') }
}

export const recordContext = (id: string, data: Record<string, any>, userId: string | null): PublicationRecordContext => ({
  reviewId: id, userId, channel: data.scope.channel, marketplace: data.scope.marketplace,
  accountId: data.scope.accountId, aliasKey: data.delivery?.aliasKey ?? '',
})

/** The columns of a publication row the sweep, the event and the schedule read. */
interface PublicationRow {
  status: string
  productId?: string | null
  channel?: string | null
  marketplace?: string | null
  channelConnectionId?: string | null
  aliasKey?: string | null
  batchId?: string | null
  checkCount?: number | null
  submittedAt?: Date | null
  completedAt?: Date | null
  summary?: unknown
}

/**
 * Tell open sheets and the publish history that a publication moved. A refresh hint on the listing bus (the ephemeral
 * lane): never awaited, never thrown — a dropped one costs a screen its next poll, not a wrong state.
 */
export function announcePublication(id: string, row: Omit<PublicationRow, 'status'>, data: Record<string, any>, status: string,
  options: { terminal?: boolean } = {}) {
  const event = {
    type: 'publication.status_changed' as const,
    publicationId: id,
    batchId: row.batchId ?? null,
    productId: String(row.productId ?? data.productId ?? ''),
    channel: String(row.channel ?? data.scope?.channel ?? ''),
    marketplace: String(row.marketplace ?? data.scope?.marketplace ?? ''),
    accountId: String(row.channelConnectionId ?? data.scope?.accountId ?? ''),
    aliasKey: String(row.aliasKey ?? data.delivery?.aliasKey ?? ''),
    status,
    // A publication a person marked checked is final for the sheet and the history, though its status stays in flight.
    terminal: options.terminal ?? (!IN_FLIGHT.includes(status) && status !== 'PREVIEW'),
    ts: Date.now(),
  }
  if (!event.productId || !event.channel || !event.marketplace || !event.accountId) return
  void import('../listing-events.service.js')
    .then(({ publishListingEvent }) => publishListingEvent(event))
    .catch(error => logger.warn('studio publication: status event not published', { publicationId: id, error: error instanceof Error ? error.message : String(error) }))
}

/** The schedule a stored status earns. Terminal → never again; in flight → only rows the new code scheduled. */
function scheduleAfter(row: PublicationRow | null, data: Record<string, any>, result: StudioPublishResult): PublicationCheck | null {
  if (!IN_FLIGHT.includes(result.status)) return { nextCheckAt: null, needsCheck: false }
  if (row?.checkCount == null) return null
  return nextPublicationCheck({ channel: String(row.channel ?? data.scope?.channel ?? ''), status: result.status, inventory: data.inventory === true,
    reference: !!result.results[0]?.reference, checkCount: row.checkCount, now: new Date(),
    submittedAt: row.submittedAt ?? (data.startedAt ? new Date(data.startedAt) : null) })
}

/**
 * Channels whose accepted SKU turns its still-draft row into a live listing here: Amazon only. eBay
 * Trading does it in `reconcileEbayReceipt` with the ItemID. Shopify's synchronisation writes every
 * delivered row itself, with the Shopify ids and the status Shopify verified (ACTIVE, or INACTIVE for a
 * Shopify draft), so promoting here could only overrule an honest INACTIVE. Etsy has its own step
 * (`promoteEtsyVariations`): a new variation joins the family's one Etsy listing, and Etsy has no closed offer.
 */
const PROMOTE_ON_ACCEPTANCE = new Set(['AMAZON'])

/**
 * The rows whose SKU the channel accepted in this publication — per SKU, as the settled records say —
 * become published, ACTIVE and unpaused, but only while they are still drafts (DRAFT, unpublished,
 * no channel id). A live listing is never one, so an operator's own pause on it is never undone.
 * Returns the rows it promoted.
 */
async function promoteAcceptedDrafts(tx: Prisma.TransactionClient, context: PublicationRecordContext, data: Record<string, any> = {}): Promise<string[]> {
  if (!PROMOTE_ON_ACCEPTANCE.has(context.channel)) return []
  const accepted = await tx.channelListingSnapshot.findMany({ where: { publishEventId: context.reviewId, reason: 'publish', outcome: 'ACCEPTED',
    channel: context.channel, marketplace: context.marketplace, aliasKey: context.aliasKey, payload: { path: ['channelConnectionId'], equals: context.accountId } },
  select: { channelListingId: true } })
  if (!accepted.length) return []
  const destination = { channel: context.channel, marketplace: context.marketplace, channelConnectionId: context.accountId, aliasKey: context.aliasKey, ...STILL_DRAFT_LISTING }
  const drafts = await tx.channelListing.findMany({ where: { id: { in: accepted.map(row => row.channelListingId) }, ...destination },
    select: { id: true, productId: true, followMasterQuantity: true, quantityOverride: true } })
  if (!drafts.length) return []
  const live = { isPublished: true, listingStatus: 'ACTIVE', syncPaused: false, version: { increment: 1 } } as const
  // New listings (ND1 A) — a row created Inactive (without this market's offer) becomes live AND paused in the same step,
  // marked exactly as the engine's Amazon Pause marks a closed offer (SCT.6's fields, reason `sheet-pause`): its Status
  // reads Inactive and Resume (Active + Publish) puts the offer back from Nexus's price (no offer was remembered).
  const inactive = createdInactive(data)
  for (const row of drafts.filter(draft => inactive.has(draft.productId))) {
    const fact = inactive.get(row.productId)!
    await tx.channelListing.updateMany({ where: { id: row.id, ...destination }, data: { ...live, offerClosedAt: new Date(), offerActive: false,
      offerClosedBy: context.userId ?? 'publish', offerCloseReason: SHEET_PAUSE_REASON,
      offerCloseSnapshot: { purchasableOffer: [], productType: fact.productType, snapshotSource: 'created-inactive', createdInactive: true, publicationId: context.reviewId,
        ...(fact.fba ? { fulfillment: 'FBA' } : {}), control: { followMasterQuantity: row.followMasterQuantity, quantityOverride: row.quantityOverride, syncPaused: false } } as never } })
  }
  const active = drafts.filter(draft => !inactive.has(draft.productId)).map(row => row.id)
  if (active.length) await tx.channelListing.updateMany({ where: { id: { in: active }, ...destination }, data: live })
  return drafts.map(row => row.id)
}

/**
 * E2 — a variation that is new on Etsy joins the family's ONE Etsy listing when the send added it: Etsy holds a whole
 * family as one listing, so the row takes the listing id the family's live rows already carry, and the owner row's
 * status and sync pause (a paused listing stays paused; nothing here lifts an operator's hold). The row's SKU is the one
 * its journal names (what Nexus sent). Only rows that are still drafts at this destination, only under a VERIFIED
 * result (the records accept a journal only then, studio-publication-records.ts; checked here as well), and only when
 * the family's live rows name exactly one Etsy listing — two would be a family split across listings, which Nexus
 * does not guess about.
 *
 * There is no Amazon-style closed offer for Etsy (no `purchasableOffer`, no `productType`). Two holds, written in the
 * same update (hidden wins):
 * - a row the publication created Inactive (D6, `inactiveProductIds`) joined the listing hidden (`is_enabled: false`):
 *   it gets the Etsy variation hold (`ETSY_VARIATION_HIDDEN_REASON`), so its Status reads Inactive and no stock push
 *   reaches it until it is shown again;
 * - a row that joins a listing paused as a whole (a family row INACTIVE, or held with `sheet-pause` — the rule of the
 *   Etsy action adapter's `etsyListingPaused`) gets that listing-level hold (`SHEET_PAUSE_REASON`), so its price and
 *   stock pushes stay held with the rest of the listing, and the listing's Resume lifts it and sends its stock.
 *
 * Returns the promoted rows that SELL — the ones whose held prices go now; a row promoted held is not among them.
 */
async function promoteEtsyVariations(tx: Prisma.TransactionClient, context: PublicationRecordContext, data: Record<string, any>,
  result: StudioPublishResult): Promise<string[]> {
  if (context.channel !== 'ETSY' || result.status !== 'VERIFIED') return []
  const accepted = await tx.channelListingSnapshot.findMany({ where: { publishEventId: context.reviewId, reason: 'publish', outcome: 'ACCEPTED',
    channel: context.channel, marketplace: context.marketplace, aliasKey: context.aliasKey, payload: { path: ['channelConnectionId'], equals: context.accountId } },
  select: { channelListingId: true, payload: true } })
  if (!accepted?.length) return []
  const destination = { channel: context.channel, marketplace: context.marketplace, channelConnectionId: context.accountId, aliasKey: context.aliasKey }
  const drafts = await tx.channelListing.findMany({ where: { id: { in: accepted.map(row => row.channelListingId) }, ...destination, ...STILL_DRAFT_LISTING },
    select: { id: true, productId: true } })
  if (!drafts.length) return []
  const productIds: string[] = Array.isArray(data.delivery?.productIds) ? data.delivery.productIds.filter((id: unknown): id is string => typeof id === 'string') : []
  const live = await tx.channelListing.findMany({ where: { ...destination, productId: { in: productIds }, externalListingId: { not: null } },
    select: { productId: true, externalListingId: true, listingStatus: true, isPublished: true, syncPaused: true, offerClosedAt: true, offerCloseReason: true } })
  const listingIds = [...new Set(live.map(row => row.externalListingId).filter((id): id is string => typeof id === 'string' && id !== ''))]
  if (listingIds.length !== 1) {
    logger.warn('studio publication: Etsy variations not promoted — the family\'s live rows do not name exactly one Etsy listing', {
      publicationId: context.reviewId, listings: listingIds.length, drafts: drafts.length })
    return []
  }
  const [etsyListingId] = listingIds
  const owner = live.find(row => row.productId === data.productId)
  const skuOf = new Map(accepted.map(row => { const sku = object(row.payload).sku; return [row.channelListingId, typeof sku === 'string' && sku.trim() ? sku.trim() : null] }))
  const inactive = createdInactive(data)
  // The listing is paused as a whole: the same rule as the Etsy action adapter (`etsyListingPaused`).
  const listingPaused = live.some(row => row.listingStatus === 'INACTIVE' || (!!row.offerClosedAt && row.offerCloseReason === SHEET_PAUSE_REASON))
  const shown: string[] = []
  for (const draft of drafts) {
    const hidden = inactive.has(draft.productId)
    const held = hidden || listingPaused
    const sku = skuOf.get(draft.id) ?? null
    const promoted = await tx.channelListing.updateMany({ where: { id: draft.id, ...destination, ...STILL_DRAFT_LISTING }, data: {
      // E3 — and the owner row's `isPublished`: a variation joining an Etsy DRAFT (created by Nexus: unpublished and paused)
      // stays inert like its draft; E4's go-live lifts them together.
      externalListingId: etsyListingId, isPublished: owner?.isPublished ?? true, listingStatus: owner?.listingStatus ?? 'ACTIVE',
      // The owner row's pause, or — with no owner row to follow — the pause the draft already had kept (never lifted on a guess).
      ...(owner ? { syncPaused: owner.syncPaused } : {}),
      ...(sku ? { liveChannelSku: sku } : {}),
      lastSyncedAt: new Date(), lastSyncStatus: 'SUCCESS', version: { increment: 1 },
      ...(held ? { offerClosedAt: new Date(), offerClosedBy: context.userId ?? 'publish', offerActive: false,
        offerCloseReason: hidden ? ETSY_VARIATION_HIDDEN_REASON : SHEET_PAUSE_REASON,
        offerCloseSnapshot: (hidden
          ? { channel: 'ETSY', source: 'publish', createdInactive: true, publicationId: context.reviewId, etsyListingId }
          : { channel: 'ETSY', source: 'publish', listingPaused: true, publicationId: context.reviewId, etsyListingId }) as never } : {}),
    } })
    if (promoted.count && !held) shown.push(draft.id)
  }
  return shown
}

/**
 * E3 — a VERIFIED create of a new Etsy listing. The id itself was stored the moment Etsy answered the POST
 * (`storeEtsyCreatedListing`, the go-live write of a create: DRAFT, unpublished, paused); what only a verified result
 * may add is here, in the settle's transaction:
 * - each inventory row whose journal this publication accepted records the SKU it was sent under as the SKU Etsy holds
 *   (`liveChannelSku`): only the family's inventory products (`changePlan.publication.inventoryProducts`; a family's
 *   main row is the listing, not a variation, and holds no SKU on Etsy);
 * - every delivered row now on that listing (`externalListingId` = the result's reference) records the successful sync.
 * Only the rows of this destination (account and alias). Nothing under UNVERIFIED: a create Nexus could not confirm keeps
 * only its id, and the next Publish (an E2 update of the draft) sends what still differs.
 */
async function settleEtsyCreate(tx: Prisma.TransactionClient, context: PublicationRecordContext, data: Record<string, any>, result: StudioPublishResult): Promise<void> {
  if (context.channel !== 'ETSY' || data?.etsyCreate !== true || result.status !== 'VERIFIED') return
  const reference = result.results.map(row => row.reference).find((value): value is string => typeof value === 'string' && /^[1-9]\d*$/.test(value))
  if (!reference) {
    logger.warn('studio publication: a verified Etsy create names no listing id; nothing settled', { publicationId: context.reviewId })
    return
  }
  const destination = { channel: context.channel, marketplace: context.marketplace, channelConnectionId: context.accountId, aliasKey: context.aliasKey }
  const inventory = object(object(data.changePlan).publication).inventoryProducts
  const inventoryIds = new Set((Array.isArray(inventory) ? inventory : []).map(entry => object(entry).productId).filter((id): id is string => typeof id === 'string'))
  const accepted = await tx.channelListingSnapshot.findMany({ where: { publishEventId: context.reviewId, reason: 'publish', outcome: 'ACCEPTED',
    channel: context.channel, marketplace: context.marketplace, aliasKey: context.aliasKey, payload: { path: ['channelConnectionId'], equals: context.accountId } },
  select: { channelListingId: true, payload: true } })
  for (const row of accepted ?? []) {
    const journal = object(row.payload)
    const sku = typeof journal.sku === 'string' ? journal.sku.trim() : ''
    if (!sku || typeof journal.productId !== 'string' || !inventoryIds.has(journal.productId)) continue
    await tx.channelListing.updateMany({ where: { id: row.channelListingId, ...destination, externalListingId: reference }, data: { liveChannelSku: sku } })
  }
  const productIds: string[] = Array.isArray(data.delivery?.productIds) ? data.delivery.productIds.filter((id: unknown): id is string => typeof id === 'string') : []
  if (productIds.length) await tx.channelListing.updateMany({ where: { ...destination, productId: { in: productIds }, externalListingId: reference },
    data: { lastSyncedAt: new Date(), lastSyncStatus: 'SUCCESS', version: { increment: 1 } } })
}

/**
 * S3 (per-channel SKU) — Amazon accepted these rows under the seller SKU each one's journal names (the SKU that was
 * sent), so that is the SKU Amazon holds for them now (`ChannelListing.liveChannelSku`, `confirmLiveChannelSku`). Every
 * row this publication got accepted, live or draft; idempotent. S4 — eBay the same: an accepted eBay publication (Trading
 * or Inventory) records the SKU each journal names, the SKU the row was sent under (`ebayPublishSku`), as the SKU eBay
 * holds now.
 *
 * S5 — Shopify too: its studio publication journals each variant under the SKU the native publisher sent, and its
 * result is VERIFIED only after Shopify read every variant back with that SKU (shopify/content-publisher.ts), so an
 * ACCEPTED row's journal SKU is the SKU Shopify holds. Only rows Shopify now maps to a variant (`variantId`): a grouped
 * family's main row is the product's content owner and holds no SKU on Shopify. Etsy: E2 moves no SKU (a new variation's
 * journal SKU is recorded when it is promoted, `promoteEtsyVariations`).
 */
const CONFIRMS_SENT_SKU: ReadonlySet<string> = new Set(['AMAZON', 'EBAY', 'SHOPIFY'])
/** The results under which `settlePublicationRecords` accepts a row (a refused or unknown result accepts none). */
const ACCEPTING_RESULTS: ReadonlySet<string> = new Set(['ACCEPTED', 'VERIFIED', 'PARTIAL'])
async function confirmAcceptedSellerSkus(tx: Prisma.TransactionClient, context: PublicationRecordContext, result: StudioPublishResult): Promise<void> {
  if (!CONFIRMS_SENT_SKU.has(context.channel) || !ACCEPTING_RESULTS.has(result.status)) return
  const accepted = await tx.channelListingSnapshot.findMany({ where: { publishEventId: context.reviewId, reason: 'publish', outcome: 'ACCEPTED',
    channel: context.channel, marketplace: context.marketplace, aliasKey: context.aliasKey, payload: { path: ['channelConnectionId'], equals: context.accountId } },
  select: { channelListingId: true, payload: true } })
  let rows = accepted ?? []
  if (context.channel === 'SHOPIFY' && rows.length) {
    const variants = await tx.channelListing.findMany({ where: { id: { in: rows.map(row => row.channelListingId) } }, select: { id: true, platformAttributes: true } })
    const mapped = new Set(variants.filter(listing => { const id = object(listing.platformAttributes).variantId; return (typeof id === 'string' || typeof id === 'number') && String(id).trim() !== '' }).map(listing => listing.id))
    rows = rows.filter(row => mapped.has(row.channelListingId))
  }
  for (const row of rows) {
    const sku = object(row.payload).sku
    if (typeof sku !== 'string' || !sku.trim()) continue
    // S10 — an eBay row this publication renamed in place: its shared-listing membership follows the new SKU (the stock
    // fan-out and order matching read it by SKU), as the variation relabel does. A membership already under the new SKU
    // is left as it is.
    if (context.channel === 'EBAY') await followEbayRename(tx, context, row.channelListingId, sku.trim())
    await confirmLiveChannelSku(tx, row.channelListingId, sku)
  }
}

/** S10 — the membership of an eBay row renamed from the SKU eBay held to `sku` (before that SKU is recorded as live). */
async function followEbayRename(tx: Prisma.TransactionClient, context: PublicationRecordContext, listingId: string, sku: string): Promise<void> {
  const listing = await tx.channelListing.findUnique({ where: { id: listingId }, select: CHANNEL_SKU_LISTING_SELECT })
  if (!listing?.externalListingId || isStillDraftListing(listing)) return
  const before = liveChannelSku(listing, listing.product?.sku)?.sku
  if (!before || before === sku) return
  const where = { marketplace: context.marketplace.toUpperCase(), itemId: listing.externalListingId }
  if (await tx.sharedListingMembership.findFirst({ where: { ...where, sku }, select: { id: true } })) return
  await tx.sharedListingMembership.updateMany({ where: { ...where, sku: before, OR: [{ productId: listing.productId }, { productId: null }] }, data: { sku } })
}

/** New listings — the rows a publication created Inactive (`inactiveProductIds`), with Amazon's product type and FBA fact. */
function createdInactive(data: Record<string, any>): Map<string, { productType: string | null; fba: boolean }> {
  const ids: string[] = Array.isArray(data?.inactiveProductIds) ? data.inactiveProductIds.filter((id: unknown): id is string => typeof id === 'string') : []
  const facts = object(data?.createInactive)
  return new Map(ids.map(id => {
    const fact = object(facts[id])
    return [id, { productType: typeof fact.productType === 'string' ? fact.productType : null, fba: fact.fba === true }]
  }))
}

/**
 * Amazon's processing report names no ASIN, so a promoted row reads its own from Amazon once the promotion has
 * COMMITTED — never inside the transaction, and without holding up the status response. A row Amazon has not made
 * visible yet is retried by the ASIN sweep (`amazon-asin-fill.job.ts`).
 */
function fillPromotedAsins(listingIds: string[]) {
  void import('../amazon/listing-asin-fill.service.js')
    .then(({ fillAmazonListingAsins }) => fillAmazonListingAsins(listingIds))
    .catch(error => logger.warn('studio publication: ASIN read after promotion failed; the ASIN sweep retries it', { error: error instanceof Error ? error.message : String(error) }))
}

/**
 * Round 5 (2026-10-01) — the drafts that just went live: the price changes their publication did not carry (a following
 * draft's rule price that is not the master price, a sale) were kept in Nexus as held rows; the price door sends each
 * ONCE now (`sendHeldPrices`). Loaded here, not at the top: the door's module loads the outbound queue. Never throws.
 */
async function heldPricesAfterGoLive(listingIds: string[], userId: string | null) {
  try {
    const { sendHeldPrices } = await import('./channel-price-write.service.js')
    await sendHeldPrices({ listingIds, actor: userId ?? 'publish', cause: 'publish' })
  } catch (error) {
    logger.warn('studio publication: held prices not sent after go-live; the next resume or price change sends them', { error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Receipt and accepted baseline move together; legacy operations never acquire an invented send record.
 * A compare-and-set on `statuses`: only the winner settles the records, promotes drafts and sends held prices, and
 * only a real status change is announced. It also sets the sweep's next look (`scheduleAfter`).
 */
export async function storeResult(id: string, data: Record<string, any>, userId: string | null, result: StudioPublishResult, statuses: string[]) {
  let promoted: string[] = []
  let etsyShown: string[] = []
  let before: PublicationRow | null = null
  const stored = await prisma.$transaction(async tx => {
    before = await tx.bulkOperation.findFirst({ where: { id }, select: { status: true, productId: true, channel: true, marketplace: true,
      channelConnectionId: true, aliasKey: true, batchId: true, checkCount: true, submittedAt: true, completedAt: true, summary: true } }) as PublicationRow | null
    const inFlight = IN_FLIGHT.includes(result.status)
    // D3 — a publication a person marked checked stays closed and unswept while its result is still unknown; a real
    // result that arrives later is stored as usual. Either way the mark is kept.
    const mark = checkedMark((before as PublicationRow | null)?.summary)
    const schedule = mark && inFlight ? { nextCheckAt: null, needsCheck: false } : scheduleAfter(before, data, result)
    const completedAt = !inFlight ? new Date() : mark ? ((before as PublicationRow | null)?.completedAt ?? new Date(mark.checkedAt)) : null
    const stored = await tx.bulkOperation.updateMany({ where: { id, status: { in: statuses } },
      data: { status: result.status, completedAt,
        summary: json({ ...publicationSummary(result), ...(schedule?.needsCheck ? { needsCheck: true } : {}), ...(mark ?? {}) }),
        ...(schedule ? { nextCheckAt: schedule.nextCheckAt } : {}), changes: json({ ...data, result }) } })
    if (stored.count && data.captureVersion === 1) {
      const context = recordContext(id, data, userId)
      await settlePublicationRecords(tx, context, result)
      await confirmAcceptedSellerSkus(tx, context, result)
      promoted = await promoteAcceptedDrafts(tx, context, data)
      etsyShown = await promoteEtsyVariations(tx, context, data, result)
      await settleEtsyCreate(tx, context, data, result)
    }
    return stored
  })
  const previous = before as PublicationRow | null
  if (stored.count && previous && previous.status !== result.status) announcePublication(id, previous, data, result.status)
  // Build shape v2 (P6) — a Full update's waiting value resets once the channel accepted that row; so does the choice that
  // listed a deleted row again (delete and relist), and a new row's Status choice (New listings). Never throws.
  if (stored.count && ['fullProductIds', 'relistProductIds', 'createChoiceProductIds'].some(key => Array.isArray(data[key]) && data[key].length))
    await (await import('./publish-plan.js')).afterContentSettled(id, data, result)
  if (promoted.length) {
    fillPromotedAsins(promoted)
    // Round 5 — a price change the publication did not carry (a following draft's rule price, a sale), kept in Nexus
    // while the row was a draft, is sent once now that it is live. Never throws.
    await heldPricesAfterGoLive(promoted, userId)
  }
  // E2 — the Etsy variations that joined their listing and sell: their held prices go once now (never an ASIN read:
  // that is Amazon's). A variation that joined hidden keeps its prices held until it is shown. Never throws.
  if (etsyShown.length) await heldPricesAfterGoLive(etsyShown, userId)
  // Amazon sheet gaps — the offer drafts Amazon accepted become live, once, in their own transaction; the result sweep
  // recovers a run that never committed. Loaded here: the doors load the outbound queue. Never throws.
  if (stored.count && data.captureVersion === 1) await import('./studio-publication-offer-promotion.js')
    .then(({ promoteOffersAfterResult }) => promoteOffersAfterResult(id, data, result, userId))
    .catch(error => logger.warn('studio publication: offer promotion not loaded; the result sweep runs it', { publicationId: id, error: error instanceof Error ? error.message : String(error) }))
  // S10 (per-channel SKU) — live Amazon listings this publication moved to a new SKU: each OLD whose NEW Amazon accepted is
  // deleted there now, once (`studio-publication-amazon-move.ts`; the result sweep recovers a run that never finished).
  // A refused NEW deletes nothing. The sentences join `result.warnings`. Never throws.
  if (stored.count && data.captureVersion === 1 && Array.isArray(data.skuMoves) && data.skuMoves.length) await import('./studio-publication-amazon-move.js')
    .then(({ finishAmazonMovesAfterResult }) => finishAmazonMovesAfterResult(id, data, result, userId))
    .catch(error => logger.warn('studio publication: SKU moves not loaded; the result sweep runs them', { publicationId: id, error: error instanceof Error ? error.message : String(error) }))
  return stored
}

export async function reconcileEbayReceipt(data: Record<string, any>, previous: StudioPublishResult, userId: string | null): Promise<StudioPublishResult> {
  const reference = previous.results[0]?.reference
  if (!reference || !data.delivery) return previous
  const receipt = await readEbayPublication(reference, data.scope.accountId, data.scope.marketplace)
  if (!receipt) return previous
  const warnings = [...new Set([...(previous.warnings ?? []), ...receipt.warnings])]
  if (!receipt.verified) return { ...previous, warnings, status: 'UNVERIFIED', message: `eBay acknowledged item ${reference}, but its active listing status could not be confirmed. Review the channel messages before publishing again.` }
  // Idempotent recovery after a receipt was stored but the local listing update failed.
  const destination = { productId: { in: data.delivery.productIds }, channel: 'EBAY',
    marketplace: data.scope.marketplace, channelConnectionId: data.scope.accountId, aliasKey: data.delivery.aliasKey }
  const live = { externalListingId: reference, isPublished: true, listingStatus: 'ACTIVE', version: { increment: 1 } } as const
  // A still-draft becomes the live listing and loses the pause that kept it inert. It runs first: once promoted, a row
  // no longer matches the second write, so no row is bumped twice. Any other row keeps its own pause.
  const draftRows = await prisma.channelListing.findMany({ where: { ...destination, ...STILL_DRAFT_LISTING }, select: { id: true, productId: true } })
  const drafts = draftRows.map(row => row.id)
  // New listings — a row created Inactive (at quantity 0) becomes live AND held in the same step, exactly as an eBay
  // Pause holds it (`offerClosedAt`, reason `sheet-pause`): nothing pushes stock until Resume sends the current stock.
  const inactive = createdInactive(data)
  const held = draftRows.filter(row => inactive.has(row.productId)).map(row => row.id)
  if (held.length) await prisma.channelListing.updateMany({ where: { ...destination, ...STILL_DRAFT_LISTING, id: { in: held } }, data: { ...live, syncPaused: false,
    offerClosedAt: new Date(), offerClosedBy: userId ?? 'publish', offerCloseReason: SHEET_PAUSE_REASON, offerActive: false,
    offerCloseSnapshot: { channel: 'EBAY', source: 'product-sheet', previewId: previous.id, createdInactive: true } as never } })
  await prisma.channelListing.updateMany({ where: { ...destination, ...STILL_DRAFT_LISTING }, data: { ...live, syncPaused: false } })
  await prisma.channelListing.updateMany({ where: { ...destination,
    OR: [{ externalListingId: null }, { externalListingId: { not: reference } }, { isPublished: false }, { listingStatus: { not: 'ACTIVE' } }] },
    data: live })
  // Round 5 — a held price change the publication did not carry is sent once the drafts are live (only those still held
  // rows whose listing is live now are sent; a second reconcile finds none left). Never throws.
  if (drafts.length) await heldPricesAfterGoLive(drafts, userId)
  const projected = await prisma.channelListing.count({ where: { productId: { in: data.delivery.productIds }, channel: 'EBAY',
    marketplace: data.scope.marketplace, channelConnectionId: data.scope.accountId, aliasKey: data.delivery.aliasKey,
    externalListingId: reference, isPublished: true, listingStatus: 'ACTIVE' } })
  if (projected !== new Set(data.delivery.productIds).size) throw new Error('The channel receipt is saved, but a local listing is missing from this destination. Restore its listing before checking again.')
  return { ...previous, status: 'ACCEPTED', warnings, message: `eBay accepted item ${reference} and reports it active.` }
}

type AmazonReport = NonNullable<Awaited<ReturnType<typeof readAmazonPublication>>>


/** The Amazon attributes one journaled feed message carried: an UPDATE's attributes, or a PATCH's paths. */
function carriedAttributes(request: unknown): string[] {
  const message = object(object(request).message)
  const names = new Set<string>(Object.keys(object(message.attributes)))
  for (const patch of Array.isArray(message.patches) ? message.patches : []) {
    const name = String(object(patch).path ?? '').split('/')[2]
    if (name) names.add(name)
  }
  return [...names]
}

/**
 * A settled Amazon feed's issues onto the EXACT listings this publication wrote (its journal names them), never by
 * product SKU. An accepted SKU first resolves the open feed issues about attributes it carried — and only those.
 * Runs after the result committed; never throws (it reports on a result, it is not part of it).
 */
async function fileAmazonIssues(id: string, data: Record<string, any>, report: AmazonReport) {
  try {
    const journal = await prisma.channelListingSnapshot.findMany({ where: { publishEventId: id, reason: 'publish', channel: 'AMAZON',
      marketplace: data.scope.marketplace, aliasKey: data.delivery?.aliasKey ?? '' }, select: { channelListingId: true, payload: true } })
    if (!journal.length) return
    const listingIdsBySku = new Map<string, string[]>()
    const carriedBySku = new Map<string, Set<string>>()
    for (const row of journal) {
      const payload = object(row.payload)
      if (payload.channelConnectionId !== data.scope.accountId || typeof payload.sku !== 'string') continue
      listingIdsBySku.set(payload.sku, [...(listingIdsBySku.get(payload.sku) ?? []), row.channelListingId])
      const carried = carriedBySku.get(payload.sku) ?? new Set<string>()
      for (const request of Array.isArray(payload.requests) ? payload.requests : []) for (const name of carriedAttributes(request)) carried.add(name)
      carriedBySku.set(payload.sku, carried)
    }
    const [{ recordFeedReportIssues }, { resolveCarriedListingIssues, fingerprintIssue }, { resolveIssueAttributes }] = await Promise.all([
      import('../listing-issue-recorder.service.js'), import('../listing-issues.service.js'), import('../channel-issue-attributes.js')])
    const client = prisma as unknown as PrismaClient
    for (const row of report.results) {
      if (row.failed) continue
      const keep = (row.issues ?? []).map(issue => fingerprintIssue(String(issue.code ?? '').trim() || 'UNKNOWN', resolveIssueAttributes(issue.attributeNames, issue.message)))
      for (const listingId of listingIdsBySku.get(row.sku) ?? [])
        await resolveCarriedListingIssues(client, listingId, 'amazon-feed', [...(carriedBySku.get(row.sku) ?? [])], keep)
    }
    await recordFeedReportIssues({ marketplace: data.scope.marketplace, occurredAt: report.completedAt ?? new Date(), listingIdsBySku, source: 'amazon-feed', channel: 'AMAZON',
      perSku: report.results.map(row => ({ sku: row.sku, status: row.failed ? 'error' : (row.issues ?? []).length ? 'warning' : 'success', issues: row.issues ?? [] })) })
  } catch (error) {
    logger.warn('studio publication: Amazon issues not filed on the listings', { publicationId: id, error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Step 6 — where this publication sits in its Amazon feed. A batch of many families sends one feed per account and
 * market, so a publication records its own messages (`feedMessages`, renumbered in the shared feed) and the feed's
 * size (`feedTotal`). A publication sent alone has neither and is read as messages 1..n, as before.
 */
export function amazonFeedPlacement(data: Record<string, any>): { messages?: Array<{ messageId: number; sku: string }>; feedTotal?: number } {
  const messages = Array.isArray(data.feedMessages)
    ? data.feedMessages.filter((m: any) => m && Number.isSafeInteger(m.messageId) && m.messageId > 0 && typeof m.sku === 'string' && m.sku) : []
  const total = Number(data.feedTotal)
  if (!messages.length || messages.length !== (Array.isArray(data.feedMessages) ? data.feedMessages.length : 0) || !Number.isSafeInteger(total) || total < messages.length) return {}
  return { messages: messages.map((m: any) => ({ messageId: m.messageId, sku: m.sku })), feedTotal: total }
}

export interface SettleOutcome {
  result: StudioPublishResult
  /** This call stored a result (it won the compare-and-set). False = nothing new, or another caller stored it first. */
  stored: boolean
}

/**
 * Settle one publication as far as the channel allows today. No user filter: the caller decides who may ask (the
 * status route checks the submitter; the sweep acts for the business). `actorUserId` is who asked — the records and
 * the held-price actor stay the submitter's, as they were when only the submitter could settle.
 * Returns null when `id` is not a publication.
 */
export async function settleStudioPublication(id: string, options: { actorUserId: string | null }): Promise<SettleOutcome | null> {
  const operation = await prisma.bulkOperation.findFirst({ where: { id } })
  const data = object(operation?.changes)
  if (!operation || data.kind !== PUBLICATION_KIND) return null
  const userId = operation.userId ?? null
  if (data.result) {
    const previous = data.result as StudioPublishResult
    if (operation.status === 'UNVERIFIED' && data.scope.channel === 'EBAY' && data.inventory !== true && previous.results[0]?.reference) {
      const result = await reconcileEbayReceipt(data, previous, userId)
      const stored = await storeResult(id, data, userId, result, ['UNVERIFIED'])
      return { result, stored: stored.count === 1 }
    }
    if (operation.status === 'SUBMITTED' && data.scope.channel === 'AMAZON') {
      const reference = previous.results[0]?.reference
      if (reference) {
        const skus = previous.results.map(r => r.sku)
        const placement = amazonFeedPlacement(data)
        const report = placement.messages
          ? await readAmazonPublication(reference, data.scope.accountId, skus, placement)
          : await readAmazonPublication(reference, data.scope.accountId, skus)
        if (report) {
          const failed = report.results.filter(r => r.failed).length
          const result: StudioPublishResult = { id, status: failed === report.results.length ? 'FAILED' : failed ? 'PARTIAL' : 'ACCEPTED',
            message: failed ? `${failed} products were rejected by Amazon. Review the processing messages before publishing corrected values.` : `Amazon processed feed ${reference}. Storefront visibility is still determined by Amazon.`,
            results: report.results.map(r => ({ sku: r.sku, status: r.failed ? 'FAILED' : 'ACCEPTED', message: r.failed ? explainAmazonRelist(data, r.sku, r.issues ?? [], r.message) : r.message,
              reference, ...(r.issues?.length ? { issues: r.issues } : {}) })) }
          const stored = await storeResult(id, data, userId, result, ['SUBMITTED'])
          if (stored.count === 1) await fileAmazonIssues(id, data, report)
          return { result, stored: stored.count === 1 }
        }
      }
    }
    return { result: previous, stored: false }
  }
  const startedAt = data.startedAt ? new Date(data.startedAt).getTime() : operation.createdAt?.getTime()
  if (operation.status === 'PUBLISHING' && startedAt && Date.now() - startedAt > RECEIPT_DEADLINE_MS) {
    const result: StudioPublishResult = { id, status: 'UNVERIFIED', message: 'The submission did not record a channel receipt within 30 minutes. It may have reached the channel. Check its submission history before retrying; Nexus will not send a duplicate automatically.', results: [] }
    const updated = await storeResult(id, data, userId, result, ['PUBLISHING'])
    if (updated.count) return { result, stored: true }
    const again = await settleStudioPublication(id, options)
    return again && { ...again, stored: false }
  }
  return { stored: false, result: { id, status: operation.status === 'PUBLISHING' ? 'PUBLISHING' : 'FAILED', message: operation.status === 'PUBLISHING' ? 'The channel is processing this publication. Check again for its result.' : 'This review has not been submitted.', results: [] } }
}

/**
 * The sweep's follow-up when a claimed row did not store a new result (the report is still pending, the read failed,
 * or another caller settled it first): the next look by the backoff, or give up and mark it for a person.
 * Only rows still in flight are touched, and only while their status is the one read here.
 */
export async function reschedulePublication(id: string, now = new Date()): Promise<PublicationCheck | null> {
  const row = await prisma.bulkOperation.findFirst({ where: { id }, select: { status: true, channel: true, checkCount: true, submittedAt: true,
    completedAt: true, summary: true, changes: true } })
  // A publication a person marked checked (D3) is closed: the sweep never looks at it again.
  if (!row || !IN_FLIGHT.includes(row.status) || row.checkCount == null || row.completedAt || checkedMark(row.summary)) return null
  const data = object(row.changes)
  const check = nextPublicationCheck({ channel: String(row.channel ?? data.scope?.channel ?? ''), status: row.status, inventory: data.inventory === true,
    reference: !!data.result?.results?.[0]?.reference, checkCount: row.checkCount, now,
    submittedAt: row.submittedAt ?? (data.startedAt ? new Date(data.startedAt) : null) })
  await prisma.bulkOperation.updateMany({ where: { id, status: row.status, completedAt: null }, data: { nextCheckAt: check.nextCheckAt,
    ...(check.needsCheck ? { summary: json({ ...object(row.summary), needsCheck: true }) } : {}) } })
  return check
}
