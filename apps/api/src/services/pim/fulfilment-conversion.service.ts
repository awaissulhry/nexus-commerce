/**
 * Amazon fulfilment conversion (Owner 2026-10-07: "A fulfillment channel change from FBA to FBM or from FBM to FBA must
 * actually reach the channel … make sure that it is certain").
 *
 * The Matrix's set-fulfilment on an Amazon coordinate (the cell, the Set fulfilment… verb, Claude's set-listing-stock
 * set-fulfilment, and the revert of any of them) is a REAL conversion: ONE Listings Items patch per open marketplace of
 * the coordinate (the Amazon EU group: every open EU market of the seller SKU), through the channel gateway
 * (`amazonSpApiClient.submitListingPayload`), that adds the new fulfilment record and deletes the old one
 * (`conversionPatches`, Owner 2026-10-08 "Option B"):
 *
 *   FBA → FBM  add    [{ fulfillment_channel_code: 'DEFAULT', quantity: N, lead_time_to_ship_max_days: H }]   (H only when known)
 *              delete [{ fulfillment_channel_code: 'AMAZON_EU' }]
 *   FBM → FBA  add    [{ fulfillment_channel_code: 'AMAZON_EU' }]                                             (never a quantity)
 *              delete [{ fulfillment_channel_code: 'DEFAULT' }]
 *
 * Why add + delete (not one `replace`): Amazon keys `fulfillment_availability` records by `fulfillment_channel_code`
 * ("an array that accepts one or more distinct fulfillment records, each keyed by the fulfillment_channel_code"; DEFAULT
 * and AMAZON_xx can live side by side, FBA stock sold first), so a `replace [{DEFAULT}]` only sets the DEFAULT record and
 * leaves AMAZON_EU in place (selling-partner-api-models #2061; the 12 GALE sizes of 2026-10-07 stayed AFN). Amazon's own
 * channel switch is `add` the new code + `delete` the old one in one patch
 * (developer-docs.amazon/sp-api/docs/additional-functionality-fulfillment-inbound); FBA → FBM is the same pair, mirrored.
 * Entries carry no `marketplace_id`: the market is the request's `marketplaceIds` (`offer-attributes.ts`).
 *
 * Order, so the stock cascade never sends Amazon a number for the wrong method:
 *   - FBA → FBM: records (SENDING) → the patch per market → Nexus writes FBM on the markets Amazon ACCEPTED (unguarded:
 *     Amazon answered) and stores the quantity sent, so the cascade has nothing new to push. At least one accepted =
 *     Nexus manages the merchant quantity (the product's FBA mark moves when no FBA units or active FBA offer remain; an
 *     untyped Amazon listing that relied on that mark is first set FBA explicitly, so nothing else loses its guard).
 *     All refused = Nexus stays FBA. Refused markets are named.
 *   - FBM → FBA: Nexus writes FBA first (the guard closes: from here the push layer, `send-quantity.ts` step 1 and
 *     `buildAmazonListingPatch`, sends this listing no merchant quantity) and cancels the listing's waiting quantity
 *     pushes → the patch per market, whose `delete DEFAULT` takes the last merchant quantity off Amazon → a market Amazon
 *     refused gets its method back through the same door (the product's FBA mark stays while another market is FBA, so
 *     no market of the SKU pushes a merchant quantity); all refused = everything back, the product's mark too.
 * The FBA hard block lets the FBM patch through only when it is exactly the patch its SENDING record holds
 * (`fulfilment-conversion-guard.ts`); a delete of AMAZON_* passes nowhere else.
 *
 * An accepted patch is SENT, not done ("accepted for processing"): the confirmation job
 * (`jobs/fulfilment-conversion-confirm.job.ts`) reads the merchant listings report's fulfillment-channel column and
 * moves each record to CONFIRMED, STILL_OLD or NOT_IN_REPORT; the Matrix's Fulfilment cell shows the newest run.
 */
import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { assertPushAllowed, isStillDraftListing } from '@nexus/shared/push-lock'
import { amazonConversionRefusal, type AmazonFulfilmentFacts } from '@nexus/shared/matrix-preview'
import type { FulfilmentCell, FulfilmentConversionState, FulfilmentConversionStatus } from '@nexus/shared/matrix-contract'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { amazonSpApiClient } from '../../clients/amazon-sp-api.client.js'
import { getAmazonRegion, getAmazonSellerId } from '../../lib/amazon-sp-client.js'
import { afterDatabaseCommit } from '../../lib/database-context.js'
import { describeAmazonFulfilmentCode, hasFbaFulfilmentCode, isFbaFulfilmentCode, keptAmazonFulfilmentCodes, normaliseAmazonFulfilmentCode } from '../../lib/amazon-fulfilment-programme.js'
import { marketplaceCodeToId } from '../../utils/marketplace-code.js'
import { AMAZON_EU_SHARED_MARKETS } from '../amazon-eu-quantity-guard.js'
import { readAmazonOfferFacts } from '../amazon/offer-facts.js'
import { listingSendSku } from '../listings/listing-send-sku.js'
import { announceListingValues } from '../listing-values-events.js'
import { loadSyncLedgers } from '../stock-pool/sync-ledgers.js'
import { recascadeAfterSyncControlChange } from '../stock-movement.service.js'
import { coalescePendingQuantityRows } from '../sync-coalesce.js'
import { loadChannelPolicies, policyFor } from '../sync-control-policy.service.js'
import { readFbaUnits } from './fulfilment-conversion-guard.js'
import { setFulfillmentMethod } from './fulfillment-method.service.js'
import { listingQuantityVerdict } from './listing-quantity-verdict.js'
import { compareMarkets } from './matrix-cells.js'
import { sharesAmazonEuInventory } from './shared-inventory-targets.js'

export type ConversionMethod = 'FBA' | 'FBM'
export type ConversionOrigin = 'matrix-verb' | 'matrix-revert'

const CONVERSION_LISTING_SELECT = {
  id: true, productId: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true, version: true,
  channelSku: true, liveChannelSku: true, listingStatus: true, isPublished: true, externalListingId: true,
  platformAttributes: true, flatFileSnapshot: true, overrideData: true,
  offers: { select: { sku: true, isActive: true, fulfillmentMethod: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
  alias: { select: { sku: true, productId: true } },
  fulfillmentMethod: true, offerClosedAt: true, syncPaused: true,
  followMasterQuantity: true, quantity: true, stockBuffer: true, sourceLocationCodes: true,
  product: { select: { id: true, sku: true, fulfillmentMethod: true, productType: true } },
} satisfies Prisma.ChannelListingSelect
type ConversionListing = Prisma.ChannelListingGetPayload<{ select: typeof CONVERSION_LISTING_SELECT }>

/** One market the patch goes to. */
export interface ConversionPlanRow {
  id: string
  marketplace: string
  marketplaceId: string
  version: number
  sellerSku: string
  channelConnectionId: string | null
  productType: string
  fulfillmentMethod: string | null
  /** FBM: the merchant quantity for this market (the Amazon EU group sends one number). */
  quantity: number | null
  leadTime: number | null
}

export interface ConversionPlan {
  facts: AmazonFulfilmentFacts
  rows: ConversionPlanRow[]
  productId: string
  productSku: string
  productFlag: string | null
}

/** A listing that exists on Amazon (an offer to convert), as opposed to a Nexus draft. */
const isLiveOnAmazon = (l: Pick<ConversionListing, 'listingStatus' | 'isPublished' | 'externalListingId'>): boolean =>
  !isStillDraftListing(l) && (l.isPublished === true || !!l.externalListingId)

const leadTimeOf = (l: ConversionListing): number | null => {
  const v = readAmazonOfferFacts({ marketplace: l.marketplace, platformAttributes: l.platformAttributes }, 'job').values.lead_time_to_ship_max_days
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 120 ? v : null
}

/* ── the newest run, as the Matrix shows it ─────────────────────────────────────────────────── */

export interface ConversionRecordFacts {
  runId: string
  channelListingId: string
  marketplace: string
  toMethod: string
  status: string
  message: string | null
  createdAt: Date
  sentAt: Date | null
  confirmedAt: Date | null
  lastReportAt: Date | null
  updatedAt: Date
}

export const CONVERSION_RECORD_SELECT = {
  runId: true, channelListingId: true, marketplace: true, toMethod: true, status: true, message: true,
  createdAt: true, sentAt: true, confirmedAt: true, lastReportAt: true, updatedAt: true,
} satisfies Prisma.FulfilmentConversionSelect

/**
 * PURE — the Fulfilment cell's `conversion`: the newest run among `records` (any order), folded over its markets. A run
 * that reached Amazon somewhere reads by its accepted markets (refused ones named in `message`): STILL_OLD, then
 * NOT_IN_REPORT, then SENDING, then SENT, else CONFIRMED; a run refused everywhere reads REFUSED. A record still SENDING or
 * SENT after the confirmation window (24 h: the job reads it no more) is no longer on its way: it reads STILL_OLD, so the
 * same change can be sent again instead of "Already sent" forever (the 2026-10-07 GALE records).
 */
export function conversionStatusOf(records: readonly ConversionRecordFacts[], now: Date = new Date()): FulfilmentConversionStatus | null {
  if (records.length === 0) return null
  const newest = [...records].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!
  const unconfirmed = (r: ConversionRecordFacts): ConversionRecordFacts =>
    (r.status === 'SENT' || r.status === 'SENDING') && now.getTime() - r.createdAt.getTime() > CONFIRM_WINDOW_MS
      ? { ...r, status: 'STILL_OLD', lastReportAt: r.lastReportAt ?? r.sentAt ?? r.createdAt, message: UNCONFIRMED_AFTER_WINDOW }
      : r
  const run = records.filter((r) => r.runId === newest.runId).map(unconfirmed).sort((a, b) => compareMarkets(a.marketplace, b.marketplace))
  const refused = run.filter((r) => r.status === 'REFUSED')
  const reached = run.filter((r) => r.status !== 'REFUSED')
  const to = (newest.toMethod === 'FBA' ? 'FBA' : 'FBM') as 'FBA' | 'FBM'
  // The time the status names: confirmed → when the report confirmed it; sent → when it was sent; still old / not in
  // the report → the last report read; refused → when it was refused.
  const timeOf = (r: ConversionRecordFacts) => (r.status === 'CONFIRMED' ? r.confirmedAt ?? r.updatedAt
    : r.status === 'SENT' || r.status === 'SENDING' ? r.sentAt ?? r.createdAt
      : r.status === 'STILL_OLD' || r.status === 'NOT_IN_REPORT' ? r.lastReportAt ?? r.updatedAt : r.updatedAt).getTime()
  const latestAt = (rs: readonly ConversionRecordFacts[]) => new Date(Math.max(...rs.map(timeOf))).toISOString()
  const refusedWords = refused.length ? `Amazon ${refused.map((r) => r.marketplace).join(' ')} refused: ${refused[0]!.message ?? 'refused'}` : null
  if (reached.length === 0) return { status: 'REFUSED', to, at: latestAt(run), markets: run.map((r) => r.marketplace), message: refused[0]?.message ?? null }
  const order: FulfilmentConversionState[] = ['STILL_OLD', 'NOT_IN_REPORT', 'SENDING', 'SENT', 'CONFIRMED']
  const status = order.find((s) => reached.some((r) => r.status === s)) ?? 'SENT'
  const these = reached.filter((r) => r.status === status)
  const message = [status === 'STILL_OLD' || status === 'NOT_IN_REPORT' ? these[0]!.message : null, refusedWords].filter(Boolean).join(' · ') || null
  return { status, to, at: latestAt(these), markets: reached.map((r) => r.marketplace), message }
}

/** The newest runs of these listings (one query): the records of each listing's newest runs, by listing id. */
export async function loadConversionRecords(listingIds: readonly string[]): Promise<Map<string, ConversionRecordFacts[]>> {
  const out = new Map<string, ConversionRecordFacts[]>()
  if (listingIds.length === 0) return out
  const rows = await prisma.fulfilmentConversion.findMany({
    where: { channelListingId: { in: [...listingIds] }, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
    orderBy: { createdAt: 'desc' }, take: 2000, select: CONVERSION_RECORD_SELECT,
  })
  for (const r of rows) out.set(r.channelListingId, [...(out.get(r.channelListingId) ?? []), r])
  return out
}

/* ── the plan: the server's facts, fresh ────────────────────────────────────────────────────── */

/**
 * The plan of one Amazon coordinate: the rows the conversion would send to and every fact its preview refuses or tells
 * by. `primaryListingId` = the coordinate's own listing; `targetIds` = the Matrix door's open targets for it
 * (`targetsOf`: the open Amazon EU group, or the listing alone). `to` = the method asked for: with it, every refusal a
 * person can fix is said at once (`conversionRefusals`), not one per try. Null = the primary listing is gone.
 */
export async function loadConversionPlan(input: { primaryListingId: string; targetIds: readonly string[]; to?: ConversionMethod }): Promise<ConversionPlan | null> {
  const primary = await prisma.channelListing.findUnique({ where: { id: input.primaryListingId }, select: CONVERSION_LISTING_SELECT })
  if (!primary || primary.channel !== 'AMAZON') return null
  const group: ConversionListing[] = sharesAmazonEuInventory(primary)
    ? await prisma.channelListing.findMany({
      where: { productId: primary.productId, channel: 'AMAZON', marketplace: { in: [...AMAZON_EU_SHARED_MARKETS] }, aliasKey: '', channelConnectionId: primary.channelConnectionId },
      select: CONVERSION_LISTING_SELECT,
    })
    : [primary]
  group.sort((a, b) => compareMarkets(a.marketplace, b.marketplace))
  const targetIds = new Set(input.targetIds)
  const productSku = primary.product?.sku ?? ''
  const skipped: Array<{ market: string; why: 'inactive' | 'not-listed' }> = []
  const live: ConversionListing[] = []
  for (const l of group) {
    if (l.offerClosedAt) { skipped.push({ market: l.marketplace, why: 'inactive' }); continue }
    if (!targetIds.has(l.id)) continue
    if (!isLiveOnAmazon(l)) { skipped.push({ market: l.marketplace, why: 'not-listed' }); continue }
    live.push(l)
  }
  const anyLive = group.some((l) => isLiveOnAmazon(l))

  const [policies, ledgers, records] = await Promise.all([loadChannelPolicies(), loadSyncLedgers(prisma as never, [primary.productId]), loadConversionRecords(group.map((l) => l.id))])
  const ledger = ledgers.get(primary.productId)
  // The send locks, each said ONCE with every market it holds (a pause on DE FR is one line, not two).
  const locks = new Map<string, { markets: string[]; say: (markets: string) => string }>()
  const lock = (key: string, mk: string, say: (markets: string) => string) => {
    const at = locks.get(key) ?? { markets: [], say }
    if (!at.markets.includes(mk)) at.markets.push(mk)
    locks.set(key, at)
  }
  const rows: ConversionPlanRow[] = []
  const quantities: Array<{ market: string; quantity: number | null; refusal: string | null }> = []
  let keptCodeReason: string | null = null
  for (const l of live) {
    const mk = l.marketplace.toUpperCase()
    // (A closed offer is skipped above, so the lock's "Inactive here" sentence never applies to a market sent to.)
    const pushLock = assertPushAllowed(l)
    if (pushLock) lock(`push:${pushLock.sentence}`, mk, (m) => `Amazon ${m}: ${pushLock.sentence}`)
    if (policyFor(policies, 'AMAZON', mk, l.channelConnectionId)?.pushesPaused) lock('policy', mk, policyPausedSentence)
    const held = listingSendSku({ ...l, channel: 'AMAZON' }, productSku, productSku)
    if (held.sku === null) lock(`sku:${held.refusal}`, mk, (m) => `Amazon ${m}: ${held.refusal}`)
    const marketplaceId = marketplaceCodeToId(mk === 'GB' ? 'UK' : mk)
    if (!marketplaceId) lock('marketplace-id', mk, (m) => `Amazon ${m}: no marketplace id in Nexus, so nothing can be sent there`)
    const kept = keptAmazonFulfilmentCodes(l.platformAttributes)[0]
    if (kept && !keptCodeReason) keptCodeReason = describeAmazonFulfilmentCode(kept).readOnlyReason
    // The FBM number: the cell's intended quantity, read as if the listing were FBM (Follow: pool − buffer; Pinned: the pin).
    const verdict = listingQuantityVerdict({
      listing: { channel: 'AMAZON', marketplace: mk, fulfillmentMethod: 'FBM', platformAttributes: {}, offerClosedAt: null, followMasterQuantity: l.followMasterQuantity,
        syncPaused: false, quantity: l.quantity, stockBuffer: l.stockBuffer, sourceLocationCodes: l.sourceLocationCodes },
      productFulfillmentMethod: 'FBM', ledger, fbaStockQty: 0, hasActiveFbaOffer: false, channelPolicy: null,
    })
    const r = verdict.resolution
    let quantity: number | null = (r.kind === 'FOLLOW' || r.kind === 'PINNED') && typeof r.quantity === 'number' ? r.quantity : null
    // The job's oversell clamp: never more than the stock routed to this market minus the buffer.
    if (quantity != null && process.env.NEXUS_OVERSELL_CLAMP !== '0' && verdict.publishable != null && verdict.routed.length > 0) quantity = Math.min(quantity, verdict.publishable)
    quantities.push({ market: mk, quantity, refusal: quantity == null ? (r.kind === 'UNCOUNTED' ? `no stock location is routed to Amazon ${mk} for this SKU` : `no quantity could be worked out for Amazon ${mk}`) : null })
    const pa = (l.platformAttributes ?? {}) as Record<string, unknown>
    rows.push({
      id: l.id, marketplace: mk, marketplaceId: marketplaceId ?? '', version: l.version, sellerSku: held.sku ?? productSku,
      channelConnectionId: l.channelConnectionId, fulfillmentMethod: l.fulfillmentMethod,
      productType: (String(pa.productType ?? l.product?.productType ?? '').toUpperCase() || 'PRODUCT'),
      quantity, leadTime: leadTimeOf(l),
    })
  }
  // Amazon EU keeps ONE merchant quantity per seller SKU: the group sends one number, or none.
  const distinct = [...new Set(quantities.map((q) => q.quantity))]
  const firstRefusal = quantities.find((q) => q.refusal)?.refusal ?? null
  const disagree = distinct.length > 1 && !firstRefusal ? `the open EU markets would send different quantities (${quantities.map((q) => `${q.market} ${q.quantity}`).join(' · ')}); Amazon EU keeps one per SKU — set one quantity first` : null
  const quantity = firstRefusal || disagree ? null : distinct[0] ?? null
  const units = (await readFbaUnits([primary.productId], [productSku, ...rows.map((r) => r.sellerSku)])).get(primary.productId) ?? { onHand: 0, reserved: 0, inbound: 0 }
  const lockLines = [...locks.values()].map((x) => x.say(x.markets.join(' ')))
  const facts: AmazonFulfilmentFacts = {
    markets: rows.map((r) => r.marketplace),
    skipped,
    quantity,
    quantityRefusal: firstRefusal ?? disagree,
    fbaUnits: units,
    activeFbaOffer: live.some((l) => l.offers.some((o) => o.isActive && o.fulfillmentMethod === 'FBA')),
    keptCodeReason,
    notListed: !anyLive,
    locked: null,
    latest: conversionStatusOf(group.flatMap((l) => records.get(l.id) ?? [])),
  }
  facts.locked = allRefusalsLine(conversionRefusals(facts, lockLines, input.to ?? null)) ?? lockLines[0] ?? null
  return { facts, rows: rows.map((r) => ({ ...r, quantity })), productId: primary.productId, productSku, productFlag: primary.product?.fulfillmentMethod ?? null }
}

/** A Sync Control pause on markets the conversion sends to: what it is and what to do, in one line. */
export const policyPausedSentence = (markets: string): string =>
  `Pushes to Amazon ${markets} are paused — release them in Sync Control, or set ${markets} Inactive in the product sheet if you do not sell there`

/** A cell that is never a no-change, so the shared rule says every refusal it holds (`conversionRefusals`). */
const PROBE_CELL: Pick<FulfilmentCell, 'method' | 'source' | 'guard' | 'reported'> = { method: null, source: 'derived', guard: null, reported: null }

/**
 * PURE — every refusal of one conversion a person can fix, each once, so the preview and the run say them ALL at once
 * instead of one per try (the shared `amazonConversionRefusal` returns the first). The send locks are `lockLines`
 * (Nexus's own sentences); the FBA units, an active FBA offer and the FBM quantity are asked of the shared rule one fact
 * at a time, so their words stay the preview's own. A refusal that leaves nothing to fix — not listed, an Amazon-only
 * code, no open market — or a change already on its way is said alone by the shared rule, before this list is read.
 * `to` null = only the locks (the method is not known).
 */
export function conversionRefusals(facts: AmazonFulfilmentFacts, lockLines: readonly string[], to: ConversionMethod | null): string[] {
  const out = [...lockLines]
  if (!to) return out
  const clear: AmazonFulfilmentFacts = {
    ...facts, latest: null, notListed: false, keptCodeReason: null, markets: facts.markets.length ? facts.markets : ['—'], locked: null,
    fbaUnits: { onHand: 0, reserved: 0, inbound: 0 }, activeFbaOffer: false, quantity: facts.quantity ?? 0, quantityRefusal: null,
  }
  const ask = (over: Partial<AmazonFulfilmentFacts>) => {
    const v = amazonConversionRefusal({ ...clear, ...over }, to, PROBE_CELL)
    if (v && v !== 'noop') out.push(v.reason)
  }
  const u = facts.fbaUnits
  if (u.onHand > 0) ask({ fbaUnits: { onHand: u.onHand, reserved: 0, inbound: 0 } })
  if (u.reserved > 0) ask({ fbaUnits: { onHand: 0, reserved: u.reserved, inbound: 0 } })
  if (u.inbound > 0) ask({ fbaUnits: { onHand: 0, reserved: 0, inbound: u.inbound } })
  if (facts.activeFbaOffer) ask({ activeFbaOffer: true })
  if (facts.quantity == null) ask({ quantity: null, quantityRefusal: facts.quantityRefusal })
  return out
}

/**
 * PURE — two or more refusals as ONE line: "Refused — 2 things to fix: 1) … 2) …". What repeats is said once: the
 * "Refused — " lead and any clause an earlier item already said (the FBA units' shared "Amazon must hold no FBA units …").
 * Null = fewer than two (the shared rule's own sentence is used then).
 */
export function allRefusalsLine(reasons: readonly string[]): string | null {
  if (reasons.length < 2) return null
  const seen = new Set<string>()
  const items = reasons.map((r) => r.replace(/^Refused — /, '').split('; ').filter((clause) => {
    const key = clause.trim().toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).join('; ')).filter(Boolean)
  return items.length < 2 ? `Refused — ${items[0] ?? ''}` : `Refused — ${items.length} things to fix: ${items.map((x, i) => `${i + 1}) ${x}`).join(' ')}`
}

/* ── the run ────────────────────────────────────────────────────────────────────────────────── */

export interface ConversionOutcome {
  outcome: 'applied' | 'refused' | 'noop' | 'conflict'
  reason?: string
  /** conflict: the moved listing's current version (0 = gone). */
  conflictVersion?: number
  /** Every listing Nexus wrote, at its version after the write. */
  listings: Array<{ listingId: string; productId: string; version: number }>
  runId?: string
  accepted: string[]
  refused: Array<{ market: string; reason: string }>
}

/** Flat on purpose: `apps/api` is not strict, so a discriminated union would not narrow. */
type Sent = { ok: boolean; submissionId?: string | null; status?: string | null; reason?: string; issues?: unknown }

/** A row of the run moved between the read and the claim. */
class ClaimLost extends Error { constructor(readonly listingId: string) { super('claim lost') } }

/** One patch to one market, through the gateway; the answer in Nexus's words. */
async function sendOne(row: ConversionPlanRow, patches: ConversionPatch[], conversionId: string, sellerId: string): Promise<Sent> {
  const payload = { productType: row.productType, patches }
  try {
    const r = await amazonSpApiClient.submitListingPayload({
      sellerId, sku: row.sellerSku, marketplaceId: row.marketplaceId, payload, conversionId, ...(row.channelConnectionId ? { accountId: row.channelConnectionId } : {}),
    })
    if (r.dryRun) return { ok: false, reason: 'Amazon publishing is not live on this server (gated or dry run), so nothing reached Amazon' }
    if (r.status === 'SKIPPED_FBA_HARD_BLOCK') return { ok: false, reason: 'Nexus\'s FBA guard stripped the conversion patch (FBA units at Amazon now, or it is not the patch this conversion recorded), so nothing reached Amazon' }
    if (!r.success) return { ok: false, reason: `Amazon refused it: ${r.error ?? 'no reason given'}`, issues: (r.rawResponse as { issues?: unknown } | undefined)?.issues ?? null }
    const raw = (r.rawResponse ?? {}) as { submissionId?: unknown; status?: unknown }
    return { ok: true, submissionId: typeof raw.submissionId === 'string' ? raw.submissionId : null, status: typeof raw.status === 'string' ? raw.status : r.status ?? null }
  } catch (err) {
    return { ok: false, reason: `Not sent: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export const FULFILMENT_PATH = '/attributes/fulfillment_availability'
export interface ConversionPatch { op: 'add' | 'delete'; path: typeof FULFILMENT_PATH; value: Array<Record<string, unknown>> }

/**
 * PURE — the ONE patch a conversion sends to one marketplace: add the new fulfilment record, delete the old one, in that
 * order (Amazon's documented channel switch). `fbaCode` = the account region's Amazon code (`AMAZON_EU` / `_NA` / `_JP`).
 * A delete names the record by its key alone, as Amazon's example does. FBM carries the merchant quantity (the Amazon EU
 * group's one number) and the handling time when known; FBA never carries a quantity.
 */
export function conversionPatches(to: ConversionMethod, row: Pick<ConversionPlanRow, 'quantity' | 'leadTime'>, fbaCode: string): ConversionPatch[] {
  const merchant = { fulfillment_channel_code: 'DEFAULT', quantity: row.quantity, ...(row.leadTime != null ? { lead_time_to_ship_max_days: row.leadTime } : {}) }
  return to === 'FBM'
    ? [{ op: 'add', path: FULFILMENT_PATH, value: [merchant] }, { op: 'delete', path: FULFILMENT_PATH, value: [{ fulfillment_channel_code: fbaCode }] }]
    : [{ op: 'add', path: FULFILMENT_PATH, value: [{ fulfillment_channel_code: fbaCode }] }, { op: 'delete', path: FULFILMENT_PATH, value: [{ fulfillment_channel_code: 'DEFAULT' }] }]
}

/**
 * Convert one Amazon coordinate's offer to `to`, fresh checks first (the preview's own refusals, re-read now), then the
 * send order above. `targets` = the Matrix door's open targets with the versions the caller saw (CAS). `cell` = the
 * Fulfilment cell the caller read (the no-change test). The whole run is one `runId`.
 */
export async function convertAmazonFulfilment(input: {
  primaryListingId: string
  targets: ReadonlyArray<{ id: string; marketplace: string; version: number }>
  to: ConversionMethod
  cell: Pick<FulfilmentCell, 'method' | 'source' | 'guard' | 'reported'>
  actor: string
  origin: ConversionOrigin
}): Promise<ConversionOutcome> {
  const none = { listings: [], accepted: [], refused: [] }
  const plan = await loadConversionPlan({ primaryListingId: input.primaryListingId, targetIds: input.targets.map((t) => t.id), to: input.to })
  if (!plan) return { outcome: 'refused', reason: 'No Amazon listing on this coordinate any more', ...none }
  const verdict = amazonConversionRefusal(plan.facts, input.to, input.cell)
  if (verdict === 'noop') return { outcome: 'noop', ...none }
  if (verdict) return { outcome: 'refused', reason: verdict.reason, ...none }
  // CAS: every row the run sends to must still be at the version the caller saw — and is CLAIMED now (its version moves
  // before anything is sent), so a second run of the same change (a double click, another tab) conflicts here instead
  // of sending Amazon the patch twice.
  for (const row of plan.rows) {
    const seen = input.targets.find((t) => t.id === row.id)
    if (!seen || seen.version !== row.version) return { outcome: 'conflict', reason: 'Changed elsewhere — reloaded', conflictVersion: row.version, ...none }
  }
  try {
    await prisma.$transaction(async (tx) => {
      for (const row of plan.rows) {
        const r = await tx.channelListing.updateMany({ where: { id: row.id, version: row.version }, data: { version: { increment: 1 } } })
        if (r.count !== 1) throw new ClaimLost(row.id)
      }
    })
  } catch (err) {
    if (!(err instanceof ClaimLost)) throw err
    const current = await prisma.channelListing.findUnique({ where: { id: err.listingId }, select: { version: true } })
    return { outcome: 'conflict', reason: 'Changed elsewhere — reloaded', conflictVersion: current?.version ?? 0, ...none }
  }
  const versions = new Map<string, number>(plan.rows.map((r) => [r.id, r.version + 1]))

  const runId = randomUUID()
  const fbaCode = `AMAZON_${({ eu: 'EU', na: 'NA', fe: 'JP' } as const)[await getAmazonRegion(plan.rows[0]?.channelConnectionId ?? undefined).catch(() => 'eu' as const)]}`
  const patchesOf = (row: ConversionPlanRow): ConversionPatch[] => conversionPatches(input.to, row, fbaCode)
  const from: ConversionMethod = input.to === 'FBM' ? 'FBA' : 'FBM'
  const records = new Map<string, string>()
  for (const row of plan.rows) {
    const rec = await prisma.fulfilmentConversion.create({
      data: {
        channelListingId: row.id, productId: plan.productId, runId, channelConnectionId: row.channelConnectionId, sku: row.sellerSku,
        marketplace: row.marketplace, marketplaceId: row.marketplaceId, fromMethod: input.cell.method === 'FBA' || input.cell.method === 'FBM' ? input.cell.method : from,
        toMethod: input.to, quantity: input.to === 'FBM' ? row.quantity : null, payload: patchesOf(row) as unknown as Prisma.InputJsonValue,
        status: 'SENDING', operatorConfirmed: true, origin: input.origin, actor: input.actor,
      },
      select: { id: true },
    })
    records.set(row.id, rec.id)
  }
  const sellers = new Map<string, string>()
  const sellerOf = async (row: ConversionPlanRow): Promise<string> => {
    const key = row.channelConnectionId ?? ''
    if (!sellers.has(key)) sellers.set(key, await getAmazonSellerId(row.channelConnectionId ?? undefined))
    return sellers.get(key)!
  }

  /** Send to every market, record each answer. */
  const sendAll = async () => {
    const accepted: ConversionPlanRow[] = []
    const refused: Array<{ row: ConversionPlanRow; reason: string }> = []
    for (const row of plan.rows) {
      const id = records.get(row.id)!
      let sent: Sent
      try { sent = await sendOne(row, patchesOf(row), id, await sellerOf(row)) } catch (err) { sent = { ok: false, reason: `Not sent: ${err instanceof Error ? err.message : String(err)}` } }
      if (sent.ok) {
        accepted.push(row)
        await prisma.fulfilmentConversion.update({ where: { id }, data: { status: 'SENT', sentAt: new Date(), submissionId: sent.submissionId, submissionStatus: sent.status, message: `Amazon accepted the patch (${sent.status ?? 'ACCEPTED'}) — waiting for Amazon's report` } })
      } else {
        refused.push({ row, reason: sent.reason })
        await prisma.fulfilmentConversion.update({ where: { id }, data: { status: 'REFUSED', message: sent.reason, ...(sent.issues != null ? { issues: sent.issues as Prisma.InputJsonValue } : {}) } })
        logger.error(`🔴 Amazon fulfilment conversion to ${input.to} NOT applied on ${row.marketplace}`, { critical: true, sku: row.sellerSku, marketplace: row.marketplace, reason: sent.reason, runId })
      }
    }
    return { accepted, refused }
  }
  const words = (rs: ReadonlyArray<{ row: ConversionPlanRow; reason: string }>) => rs.map((r) => `Amazon ${r.row.marketplace} refused: ${r.reason}`).join(' · ')
  const note = (r: { results: Array<{ listingId: string; outcome: string; version: number }> }) => { for (const x of r.results) if (x.outcome === 'applied') versions.set(x.listingId, x.version) }
  const finish = (accepted: ConversionPlanRow[], refused: ReadonlyArray<{ row: ConversionPlanRow; reason: string }>, outcome: ConversionOutcome['outcome'], reason?: string): ConversionOutcome => {
    announceListingValues(plan.rows.map((r) => r.id), ['fulfilment'], 'fulfilment-conversion')
    return {
      outcome, ...(reason ? { reason } : {}), runId,
      listings: [...versions].map(([listingId, version]) => ({ listingId, productId: plan.productId, version })),
      accepted: accepted.map((r) => r.marketplace), refused: refused.map((r) => ({ market: r.row.marketplace, reason: r.reason })),
    }
  }

  if (input.to === 'FBM') {
    const { accepted, refused } = await sendAll()
    if (accepted.length === 0) return finish([], refused, 'refused', `Nothing changed on Amazon or in Nexus — ${words(refused)}`)
    // Amazon accepted: Nexus manages the merchant quantity now (never an accepted FBM market left unmanaged).
    const written = await setFulfillmentMethod({ targets: accepted.map((r) => ({ listingId: r.id, method: 'FBM' })), actor: input.actor, unguarded: 'amazon-accepted' })
    note(written)
    await prisma.channelListing.updateMany({ where: { id: { in: accepted.map((r) => r.id) } }, data: { quantity: accepted[0]!.quantity } })
    await takeOverProductMark(plan, accepted.map((r) => r.id), input.actor, note)
    return finish(accepted, refused, 'applied', refused.length ? `Sent to Amazon ${accepted.map((r) => r.marketplace).join(' ')} — ${words(refused)}` : undefined)
  }

  // FBM → FBA: Nexus first (the guard closes), waiting quantity pushes cancelled, then Amazon.
  const before = await prisma.channelListing.findMany({ where: { id: { in: plan.rows.map((r) => r.id) } }, select: { id: true, fulfillmentMethod: true } })
  const typedBefore = new Map(before.map((b) => [b.id, b.fulfillmentMethod as 'FBA' | 'FBM' | null]))
  const closed = await setFulfillmentMethod({ targets: plan.rows.map((r) => ({ listingId: r.id, method: 'FBA', expectedVersion: versions.get(r.id)! })), actor: input.actor })
  note(closed)
  const blocked = closed.results.find((x) => x.outcome === 'refused' || x.outcome === 'conflict')
  if (blocked) {
    const back = closed.results.filter((x) => x.outcome === 'applied').map((x) => ({ listingId: x.listingId, method: typedBefore.get(x.listingId) === 'FBA' ? 'FBA' as const : 'FBM' as const }))
    if (back.length) note(await setFulfillmentMethod({ targets: back, actor: input.actor, unguarded: 'amazon-refused' }))
    if (closed.results.some((x) => x.productFlag === 'FBA')) await putBackProductMark(plan, input.actor)
    for (const id of records.values()) await prisma.fulfilmentConversion.update({ where: { id }, data: { status: 'REFUSED', message: `Not sent — ${blocked.reason ?? 'the listing changed elsewhere'}` } })
    const moved = [...versions].map(([listingId, version]) => ({ listingId, productId: plan.productId, version }))
    return blocked.outcome === 'conflict'
      ? { outcome: 'conflict', reason: blocked.reason, conflictVersion: blocked.version, ...none, listings: moved }
      : { outcome: 'refused', reason: blocked.reason, ...none, listings: moved }
  }
  const cancelled = await coalescePendingQuantityRows(prisma as never, plan.rows.map((r) => r.id))
  if (cancelled) logger.info('fulfilment conversion: waiting quantity pushes cancelled before FBA', { runId, cancelled })
  const markMoved = closed.results.some((x) => x.productFlag === 'FBA')
  const { accepted, refused } = await sendAll()
  if (refused.length) {
    // Amazon still has FBM on these markets: Nexus says so again, through the same door.
    const back = refused.map(({ row }) => ({ listingId: row.id, method: typedBefore.get(row.id) === 'FBA' ? 'FBA' as const : 'FBM' as const }))
    note(await setFulfillmentMethod({ targets: back, actor: input.actor, unguarded: 'amazon-refused' }))
    if (accepted.length === 0 && markMoved) await putBackProductMark(plan, input.actor)
  }
  if (accepted.length === 0) return finish([], refused, 'refused', `Nothing changed on Amazon; Nexus is back to FBM — ${words(refused)}`)
  return finish(accepted, refused, 'applied', refused.length
    ? `Sent to Amazon ${accepted.map((r) => r.marketplace).join(' ')} — ${words(refused)}. Nexus now sends no quantity for this SKU while ${refused.map((r) => r.row.marketplace).join(' ')} stay FBM on Amazon: check them in Seller Central`
    : undefined)
}

/**
 * FBA → FBM accepted: the product's FBA mark is one of the guard's signals, so a product still marked FBA would keep
 * every merchant quantity from reaching the markets Amazon just converted. The door moves the mark when no other listing
 * is FBA; here the mark also moves when the only FBA listings left are other markets (closed, or refused by Amazon) —
 * each keeps its OWN FBA method, set explicitly first when it had none, so its guard does not change — and only while
 * Nexus mirrors no FBA units and no active FBA offer for the product. Otherwise the mark stays and the reason is logged.
 */
async function takeOverProductMark(plan: ConversionPlan, converted: readonly string[], actor: string, note: (r: { results: Array<{ listingId: string; outcome: string; version: number }> }) => void): Promise<void> {
  const product = await prisma.product.findUnique({ where: { id: plan.productId }, select: { fulfillmentMethod: true } })
  if (String(product?.fulfillmentMethod ?? '').toUpperCase() !== 'FBA') return
  const units = (await readFbaUnits([plan.productId], [plan.productSku, ...plan.rows.map((r) => r.sellerSku)])).get(plan.productId)
  const offer = await prisma.offer.findFirst({ where: { channelListing: { productId: plan.productId }, fulfillmentMethod: 'FBA', isActive: true }, select: { id: true } })
  if (!units || units.onHand + units.reserved + units.inbound > 0 || offer) {
    logger.error('🔴 fulfilment conversion: Amazon accepted FBM but the product stays marked FBA (FBA units or an active FBA offer remain) — Nexus does not send the merchant quantity', { critical: true, productId: plan.productId, units, activeOffer: !!offer })
    return
  }
  const others = await prisma.channelListing.findMany({
    where: { productId: plan.productId, channel: 'AMAZON', id: { notIn: [...converted] } },
    select: { id: true, fulfillmentMethod: true, platformAttributes: true },
  })
  // An untyped Amazon listing that is FBA only through the product's mark: set FBA explicitly before the mark moves.
  const leaning = others.filter((l) => l.fulfillmentMethod == null && !hasFbaFulfilmentCode(l.platformAttributes))
  if (leaning.length) note(await setFulfillmentMethod({ targets: leaning.map((l) => ({ listingId: l.id, method: 'FBA' })), actor }))
  const moved = await prisma.product.updateMany({ where: { id: plan.productId, fulfillmentMethod: 'FBA' }, data: { fulfillmentMethod: 'FBM' } })
  if (moved.count === 0) return
  await prisma.syncControlAudit.create({ data: { actor, scopeType: 'PRODUCT', scopeId: plan.productId, scopeName: plan.productSku, field: 'fulfillmentMethod', before: { method: 'FBA' }, after: { method: 'FBM', keptFba: leaning.map((l) => l.id) }, reason: 'amazon-accepted' } }).catch(() => undefined)
  void afterDatabaseCommit(`fulfilment-conversion-recascade:${plan.productId}`, () =>
    recascadeAfterSyncControlChange([plan.productId], actor).then((r) => logger.info('fulfilment conversion: recascade after FBM', { ...r, productId: plan.productId })))
}

/** FBM → FBA refused everywhere: the product's mark goes back to what it was before the run. */
async function putBackProductMark(plan: ConversionPlan, actor: string): Promise<void> {
  if (String(plan.productFlag ?? '').toUpperCase() === 'FBA') return
  const moved = await prisma.product.updateMany({ where: { id: plan.productId, fulfillmentMethod: 'FBA' }, data: { fulfillmentMethod: (plan.productFlag ?? null) as never } })
  if (moved.count) await prisma.syncControlAudit.create({ data: { actor, scopeType: 'PRODUCT', scopeId: plan.productId, scopeName: plan.productSku, field: 'fulfillmentMethod', before: { method: 'FBA' }, after: { method: plan.productFlag ?? null }, reason: 'amazon-refused' } }).catch(() => undefined)
}

/* ── confirmation: Amazon's merchant listings report ────────────────────────────────────────── */

/** The confirmation window: records older than this are no longer read. */
export const CONFIRM_WINDOW_MS = 24 * 3_600_000
/** A send the report never confirmed within the window. */
export const UNCONFIRMED_AFTER_WINDOW = 'Amazon\'s report did not confirm it within 24 h — check Seller Central → Manage Inventory'
/** STILL_OLD after this many pulls AND this long since the send. */
export const STILL_OLD_AFTER_PULLS = 3
export const STILL_OLD_AFTER_MS = 4 * 3_600_000

/** The report's fulfillment-channel → the method: DEFAULT / MFN / blank = FBM; any AMAZON_* or AFN = FBA. */
export function reportMethod(channel: string | null | undefined): ConversionMethod | null {
  const c = normaliseAmazonFulfilmentCode(channel ?? '')
  if (c === '' || c === 'DEFAULT' || c === 'MFN') return 'FBM'
  return isFbaFulfilmentCode(c) ? 'FBA' : null
}

export interface ConfirmRecord {
  id: string
  sku: string
  status: string
  fromMethod: string
  toMethod: string
  reportPulls: number
  sentAt: Date | null
  createdAt: Date
}

/** PURE — one record's next state from one report read (`present` = the SKU is in the report, `channel` its column). */
export function confirmVerdict(rec: ConfirmRecord, read: { present: boolean; channel: string | null }, now: Date): {
  status: FulfilmentConversionState; reportPulls: number; message: string; confirmed: boolean
} {
  const pulls = rec.reportPulls + 1
  const since = now.getTime() - (rec.sentAt ?? rec.createdAt).getTime()
  const late = pulls >= STILL_OLD_AFTER_PULLS && since >= STILL_OLD_AFTER_MS
  if (!read.present) {
    return pulls >= STILL_OLD_AFTER_PULLS
      ? { status: 'NOT_IN_REPORT', reportPulls: pulls, confirmed: false, message: `Amazon's merchant listings report does not list ${rec.sku} — check Seller Central → Manage Inventory` }
      : { status: rec.status as FulfilmentConversionState, reportPulls: pulls, confirmed: false, message: `Not in Amazon's report yet (read ${pulls}×) — waiting` }
  }
  const method = reportMethod(read.channel)
  const shown = read.channel || '(blank)'
  if (method === rec.toMethod) return { status: 'CONFIRMED', reportPulls: pulls, confirmed: true, message: `Amazon reports ${shown}` }
  if (late) return { status: 'STILL_OLD', reportPulls: pulls, confirmed: false, message: `Amazon still reports ${method ?? 'an unknown method'} (${shown}) — check Seller Central → Manage Inventory` }
  return { status: rec.status as FulfilmentConversionState, reportPulls: pulls, confirmed: false, message: `Amazon still reports ${shown} (read ${pulls}×) — waiting for Amazon's report` }
}

/** PURE — the reported copy (`attributes.fulfillment_availability`) after a confirmation: what Amazon's report now says. */
export function withConfirmedReport(platformAttributes: unknown, to: ConversionMethod, channel: string | null): Record<string, unknown> {
  const pa = { ...((platformAttributes && typeof platformAttributes === 'object' ? platformAttributes : {}) as Record<string, unknown>) }
  const attrs = { ...((pa.attributes && typeof pa.attributes === 'object' ? pa.attributes : {}) as Record<string, unknown>) }
  const existing = Array.isArray(attrs.fulfillment_availability) ? (attrs.fulfillment_availability as unknown[]) : []
  const code = to === 'FBM' ? 'DEFAULT' : (normaliseAmazonFulfilmentCode(channel ?? '') || 'AMAZON_EU')
  if (to === 'FBM') {
    const merchant = existing.find((e) => reportMethod((e as { fulfillment_channel_code?: string } | null)?.fulfillment_channel_code) === 'FBM') as Record<string, unknown> | undefined
    attrs.fulfillment_availability = [{ ...(merchant ?? {}), fulfillment_channel_code: code }]
  } else attrs.fulfillment_availability = [{ fulfillment_channel_code: code }]
  pa.attributes = attrs
  return pa
}

export interface ConfirmDeps {
  /** The merchant listings report of one marketplace on one account (`AmazonService.fetchActiveCatalog`). */
  fetchCatalog: (marketplaceId: string, accountId?: string) => Promise<Array<{ sku: string; fulfillmentChannel?: string | null }>>
  now?: () => Date
}

/** Are there records the job should read? (No report is pulled when there are none.) */
export async function conversionsAwaitingReport(now = new Date()): Promise<number> {
  return prisma.fulfilmentConversion.count({ where: { status: { in: ['SENT', 'STILL_OLD'] }, createdAt: { gte: new Date(now.getTime() - CONFIRM_WINDOW_MS) } } })
}

/**
 * One pass: every SENT / STILL_OLD record under 24 h, grouped by account and marketplace, ONE report pull per group.
 * A failed pull counts as no read (nothing moves). A confirmed record also rewrites the listing's reported copy, so the
 * Matrix's `reported` stops showing a months-old code.
 */
export async function confirmFulfilmentConversions(deps: ConfirmDeps): Promise<{ read: number; confirmed: number; stillOld: number; notInReport: number; pullsFailed: number }> {
  const now = deps.now?.() ?? new Date()
  const open = await prisma.fulfilmentConversion.findMany({
    where: { status: { in: ['SENT', 'STILL_OLD'] }, createdAt: { gte: new Date(now.getTime() - CONFIRM_WINDOW_MS) } },
    select: { id: true, sku: true, status: true, fromMethod: true, toMethod: true, reportPulls: true, sentAt: true, createdAt: true, marketplaceId: true, channelConnectionId: true, channelListingId: true },
    orderBy: { createdAt: 'asc' },
  })
  const out = { read: 0, confirmed: 0, stillOld: 0, notInReport: 0, pullsFailed: 0 }
  const groups = new Map<string, typeof open>()
  for (const r of open) { const k = `${r.channelConnectionId ?? ''}|${r.marketplaceId}`; groups.set(k, [...(groups.get(k) ?? []), r]) }
  const touched = new Set<string>()
  for (const [key, recs] of groups) {
    const [accountId, marketplaceId] = key.split('|') as [string, string]
    let catalog: Array<{ sku: string; fulfillmentChannel?: string | null }>
    try {
      catalog = await deps.fetchCatalog(marketplaceId, accountId || undefined)
    } catch (err) {
      out.pullsFailed++
      logger.warn('fulfilment conversion confirm: report pull failed — nothing moves this pass', { marketplaceId, error: err instanceof Error ? err.message : String(err) })
      continue
    }
    const bySku = new Map(catalog.map((i) => [i.sku, i.fulfillmentChannel ?? null]))
    for (const rec of recs) {
      out.read++
      const v = confirmVerdict(rec, { present: bySku.has(rec.sku), channel: bySku.get(rec.sku) ?? null }, now)
      await prisma.fulfilmentConversion.update({
        where: { id: rec.id },
        data: { status: v.status, reportPulls: v.reportPulls, lastReportAt: now, reportChannel: bySku.get(rec.sku) ?? null, message: v.message, ...(v.confirmed ? { confirmedAt: now } : {}) },
      })
      if (v.status !== rec.status) touched.add(rec.channelListingId)
      if (v.confirmed) {
        out.confirmed++
        // The reported copy, under compare-and-set on the version (no bump: it is Amazon's report, not a person's
        // write); a listing written in between is read again once.
        for (let attempt = 0; attempt < 2; attempt++) {
          const l = await prisma.channelListing.findUnique({ where: { id: rec.channelListingId }, select: { platformAttributes: true, version: true } })
          if (!l) break
          const done = await prisma.channelListing.updateMany({
            where: { id: rec.channelListingId, version: l.version },
            data: { platformAttributes: withConfirmedReport(l.platformAttributes, rec.toMethod as ConversionMethod, bySku.get(rec.sku) ?? null) as Prisma.InputJsonValue },
          })
          if (done.count === 1) break
        }
      } else if (v.status === 'STILL_OLD' && rec.status !== 'STILL_OLD') {
        out.stillOld++
        logger.error('🔴 Amazon fulfilment conversion: Amazon still reports the old method', { critical: true, sku: rec.sku, marketplaceId, to: rec.toMethod, message: v.message })
      } else if (v.status === 'NOT_IN_REPORT' && rec.status !== 'NOT_IN_REPORT') {
        out.notInReport++
        logger.error('🔴 Amazon fulfilment conversion: the SKU is not in Amazon\'s merchant listings report', { critical: true, sku: rec.sku, marketplaceId })
      }
    }
  }
  if (touched.size) announceListingValues([...touched], ['fulfilment'], 'fulfilment-conversion')
  return out
}

/**
 * The drift detector's question: of these (seller SKU, marketplace id) pairs, which did an operator convert to FBM —
 * the newest conversion of the pair is to FBM and was not refused? Those are the operator's choice, never "drift".
 */
export async function operatorFbmConversions(pairs: ReadonlyArray<{ sku: string; marketplaceId: string }>): Promise<Set<string>> {
  const out = new Set<string>()
  if (pairs.length === 0) return out
  const rows = await prisma.fulfilmentConversion.findMany({
    where: { sku: { in: [...new Set(pairs.map((p) => p.sku))] } },
    orderBy: { createdAt: 'desc' }, select: { sku: true, marketplaceId: true, toMethod: true, status: true },
  })
  const seen = new Set<string>()
  for (const r of rows) {
    const k = `${r.sku}|${r.marketplaceId}`
    if (seen.has(k)) continue
    seen.add(k)
    if (r.toMethod === 'FBM' && r.status !== 'REFUSED') out.add(k)
  }
  return out
}
