/**
 * MX.1 / Add 4(b) — the ONE channel price write (design §2 Change 2, §3.7; report 25 §5.2/5.3/5.8, report 19 §5.5).
 *
 * Three routes wrote three different columns: `channel-pricing` wrote `price`, the listings pricing route wrote
 * `price` while calling it `priceOverride`, and `pricing/bulk-override` wrote `priceOverride` WITHOUT
 * `followMasterPrice = false` — so the engine ignored it and the audit row, the timeline row and `updated: N` all
 * reported a change the resolved price did not reflect. The push reads `ChannelListing.price` and nothing else.
 *
 * Here, ONE shape, in ONE transaction per listing:
 *   - a price: `price` AND `priceOverride` = the value, `followMasterPrice = false`, `lastOverrideAt/By`;
 *     `null` clears both and hands the listing back to the master price (`followMasterPrice = true`).
 *   - a sale: `salePrice` + the two window columns (`sale-window.ts`); a value needs BOTH dates (Amazon's
 *     `discounted_price.schedule` requires start_at and end_at) — refused by name otherwise.
 *   - a `ChannelListingOverride` audit row and a `PriceChangeEvent` timeline row (the PH.1 helper's shape).
 *   - the pending PRICE_UPDATE rows for the listing are cancelled and ONE fresh PRICE_UPDATE row is enqueued through
 *     the existing instant lane with the price AND the sale window in its payload, so a price push never wipes the
 *     sale on Amazon (report 19 §5.9) and a sale push never wipes the price. An Amazon row that removes Nexus's own
 *     sale carries `saleRemoved: true`: with NEXUS_AMAZON_OFFER_MERGE on, Amazon's price push leaves any other sale
 *     alone, so a removal must be named.
 *   - CAS on `ChannelListing.version` (bumped on every applied row); `noop` spends nothing.
 *   - NCF D2 A — Shopify's compare-at price (`compareAt`), kept at `platformAttributes.compareAtPrice`
 *     (`compare-at-price.ts`), through the same CAS and audit. Record-only: it comes from Shopify's own file, and no
 *     PRICE_UPDATE carries it, so a sending write refuses it by name.
 *
 * `channel-pricing` PATCH, `pricing/bulk-override` and the Matrix door delegate here. No snapshot refresh: the
 * pricing engine's chain is in no publish path (M8) and its hourly cron re-materialises the snapshot.
 *
 * FOLLOWER MODE (2026-10-01, "pricing rules reach the channels") — every change to a listing's pricing rule, its
 * adjustment percent or its follow-master flag comes here too, and a hand-back (`price: null`) is one of them. The
 * columns are written in the same compare-and-set transaction; then, for a listing that follows the master, the
 * price is recomputed by the rules the master-price cascade applies (`follower-price.ts`, one module for both):
 *   - MATCH_AMAZON (no price from the master), or no master price → the price stays, nothing is queued;
 *   - the market sells in another currency than the master → the price stays, nothing is queued, and the cascade's
 *     refusal sentence comes back (`notSent`) and is logged as a sync-health conflict after the commit;
 *   - outside the product's own floor or ceiling, or zero or less → REFUSED, nothing is written;
 *   - a paused listing or a still-draft → the price is stored, nothing is queued (`notSent` says why);
 *   - the same price and no follow flag turned on → nothing to send (a no-op when nothing else changed);
 *   - otherwise `price` = the computed price, `masterPrice` = the master, and ONE PRICE_UPDATE row exactly as the
 *     cascade queues it (its payload fields, its 30 s hold) plus this door's sale window and `saleRemoved` handling.
 * A listing that stops following (`follow: false`) keeps the price it carries: flags only, nothing is sent.
 */
import { createOutboundRow } from '../outbound-rows.js'
import prisma from '../../db.js'
import type { Prisma } from '@prisma/client'
import { logger } from '../../utils/logger.js'
import { priceChangeData, type PriceChangeSourceLiteral } from '../price-history.service.js'
import { fireOutboundJobs } from '../outbound-enqueue.js'
import { readSaleWindows, saleWindowColumnsExist, validateSaleWindow, writeSaleWindow, type SaleWindow } from './sale-window.js'
import { decimalToNumber } from './sheet-rows.service.js'
import { CHANNEL_FIELD_MAP, channelOverrideKeys } from './channel-field-map.js'
import { afterDatabaseCommit } from '../../lib/database-context.js'
import { storedCompareAt, withCompareAt } from './compare-at-price.js'
import { adjustmentPercentProblem, normalisePricingRule, PRICING_RULE_REFUSAL, pricingRuleLabel, type PricingRuleName } from '@nexus/shared/listing-price'
import {
  FOLLOWER_PRICE_HOLD_MS, computeListingPrice, followerPricePayload, heldPriceSentence, holdsCascadedPrice, listingMarketCurrency,
  logMasterCurrencyRefusals, masterCurrencyRefusal, type MasterCurrencyRefusal,
} from './follower-price.js'
import { masterCurrency } from '../fx-rate.service.js'
import { masterPriceBoundsReason, priceBoundsOf } from '../price-bounds.service.js'
import type { MarketCurrencyRow } from './market-currency.js'

// ETSY since 2026-09-30: `syncToEtsy` sends a PRICE_UPDATE (P4.6e). It was left off while Etsy was read-only (D6,
// overridden 2026-09-21), so an Etsy price was saved here and never queued.
const VALID_SYNC_TARGETS = new Set(['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY'])
/** The same operator grace window the FOLLOW/PIN primitives and the master-price cascade use: 30 s to undo before the push leaves. */
const PRICE_HOLD_MS = FOLLOWER_PRICE_HOLD_MS

/**
 * 🔴 PLAN Step 2.2 — the reasons a price write may run with NO version guard.
 *
 * A closed set, never free text. `expectedVersion` used to be optional, so a caller that had no
 * version simply omitted it and the compare-and-set quietly did nothing — three surfaces, one
 * column, and one version check between them.
 *
 * The step rejected *"defaulting `expectedVersion` to the row's current version"* because **that is
 * a compare-and-set that always succeeds. It looks safe and is not.** Reading the row moments
 * before writing it is the same thing wearing a number. So a caller with no operator-seen version
 * does not get to invent one: it NAMES why it has none, the name reaches the outcome and the
 * timeline, and adding a new one is a decision somebody makes on purpose.
 */
export type PriceWriteUnguardedReason =
  /** `pricing.routes.ts` bulk override: a run over price SNAPSHOTS. No per-row version was shown to anyone. */
  | 'bulk-override-snapshot'
  /** `POST /api/listings/bulk-action` (set price, pricing rule, follow / unfollow master): a SELECTION of listings, no version per row. */
  | 'listings-bulk-action'
  /** `PATCH /api/listings/:id` from a caller that sends no version (the flat files' and OverrideBadge's reset buttons). */
  | 'listing-patch-unversioned'
  /** `PATCH /api/products/:id/channel-follows` — the master sheet's "price follows" cell names a coordinate, not a version. */
  | 'channel-follows'
  /** `POST /api/products/:id/channel-listing/:clId/reset` — a reset to the master names a field, not a version. */
  | 'channel-listing-reset'
  /** The FF2 flat-file import's apply: a diff of a FILE, no version per row was shown to anyone. */
  | 'flat-file-import'
  /** `POST /api/dashboard/stock-drift/:id/resync` — the drift panel's Resync names a listing, not a version. */
  | 'dashboard-drift-resync'

/**
 * CFI-6 (R-CFI-1 Q2, BUILD.md D2) — the reasons a price may be RECORDED without being sent. A closed set, like
 * `PriceWriteUnguardedReason`: the price came FROM the channel (its own file), so the channel already holds it.
 * Same column writes, compare-and-set, `ChannelListingOverride` audit and `PriceChangeEvent` timeline — but no
 * `PRICE_UPDATE` row, no cancel of pending rows, no fire, and the listing's sync state is left alone (nothing is waiting).
 * A listing with a PENDING `PRICE_UPDATE` is refused: an operator's unsent price change is never silently overtaken.
 */
export type PriceWriteRecordOnlyReason = 'channel-file-import'

interface PriceWriteFields {
  listingId: string
  /** `undefined` = untouched; a number sets it here; `null` clears it back to the master price. */
  price?: number | null
  /** `undefined` = untouched; `{ value: null }` clears the sale. */
  sale?: { value: number | null; start: string | null; end: string | null }
  /** NCF D2 A — Shopify's compare-at price. `undefined` = untouched; `null` = Shopify holds none. Record-only. */
  compareAt?: number | null
  /**
   * Follower mode — the pricing rule (any case; stored upper case) and/or the adjustment percent (2 decimals, above
   * -100, at most 999.99), written in this compare-and-set; a following listing's price is recomputed with them.
   */
  rule?: { pricingRule?: string; priceAdjustmentPercent?: number }
  /**
   * Follower mode — `true` hands the listing back to the master (the same as `price: null`): its price is recomputed
   * by its rule and sent. `false` stops following and keeps the price the listing carries: flags only, nothing sent.
   */
  follow?: boolean
}

/**
 * 🔴 R5 — make the wrong thing impossible to compile. One of the two is required, never neither
 * and never both: a version to check against, or a named reason there is none.
 */
export type PriceWriteTarget =
  | (PriceWriteFields & { expectedVersion: number; expectedPrice?: number | null; unguardedReason?: never })
  | (PriceWriteFields & { expectedVersion?: never; expectedPrice?: never; unguardedReason: PriceWriteUnguardedReason })

/*
 * 🔴 A-17 (R-12) — `expectedPrice`: the listing's own price the caller SAW (a number = pinned at it;
 * `null` = following the master). A version conflict alone cannot tell "someone changed this price"
 * from "a quantity write bumped the same version". When the stored price is still the one the caller
 * saw, nobody touched the price, and the write goes ahead ONCE on the current version, reported
 * `retried: true`. When it is not, the conflict stands. Never re-read-and-overwrite: 15.5 (b) as
 * first written was a lost update by design. Only on a guarded target (the type refuses it on an
 * unguarded one) and only for a price-only write — a sale change is never retried.
 */

export interface PriceWriteOutcome {
  listingId: string
  productId: string | null
  channel: string | null
  marketplace: string | null
  outcome: 'applied' | 'refused' | 'noop' | 'conflict'
  reason?: string
  version: number
  /**
   * 🔴 Step 2.2 — was this write compare-and-set checked? `false` means the caller named a reason
   * it had no version. An unguarded write is a real risk of a lost update, so it is REPORTED
   * rather than being indistinguishable from a guarded one.
   */
  guarded: boolean
  /** A-17 — the version had moved, but the price was the one the caller saw; the write went ahead once. */
  retried?: true
  /** The PRICE_UPDATE queue row id when one was enqueued (null on a channel with no outbound lane). */
  queueId: string | null
  /**
   * Follower mode — the change was written, but no price was sent, and why: the market sells in another currency
   * (the cascade's refusal sentence), the listing is paused or a draft (the price is kept in Nexus), the rule takes
   * no price from the master, or the listing does not follow the master.
   */
  notSent?: string
}

export interface PriceWriteResult { results: PriceWriteOutcome[]; applied: number; refused: number; noop: number; conflict: number }

const round2 = (n: number) => Math.round(n * 100) / 100

const LISTING_SELECT = {
  id: true, productId: true, channel: true, marketplace: true, region: true, externalListingId: true, price: true, priceOverride: true,
  overrideData: true, salePrice: true, followMasterPrice: true, version: true, fulfillmentMethod: true,
  product: { select: { sku: true, basePrice: true, minPrice: true, maxPrice: true } },
  platformAttributes: true,
  // Follower mode: the rule, the master snapshot and the facts that hold a price in Nexus (`holdsCascadedPrice`).
  pricingRule: true, priceAdjustmentPercent: true, masterPrice: true, syncPaused: true, listingStatus: true, isPublished: true,
} satisfies Prisma.ChannelListingSelect

/** A-18 — the storage contract's historical `overrideData` keys that still carry this channel's price. */
function legacyPriceKeys(channel: string): string[] {
  return [...new Set(['price', ...Object.keys(CHANNEL_FIELD_MAP)
    .filter(field => CHANNEL_FIELD_MAP[field] === 'price' && field.startsWith(`${channel.toLowerCase()}_`))
    .flatMap(channelOverrideKeys)])]
}

/** A-17 — is the stored own price exactly the one the caller saw? Anything ambiguous answers no. */
function priceAsSeen(t: PriceWriteTarget, row: { channel: string; price: unknown; priceOverride: unknown; followMasterPrice: boolean | null; overrideData: unknown }): boolean {
  // A compare-at write is never retried: its value lives in the platform bag another writer may have changed in the gap.
  // A rule or follow change is never retried either: it is not a price-only write.
  if (t.expectedPrice === undefined || t.sale !== undefined || t.compareAt !== undefined || t.rule !== undefined || t.follow !== undefined) return false
  const bag = row.overrideData && typeof row.overrideData === 'object' ? row.overrideData : {}
  // A legacy key is a price the columns do not show; the caller cannot have seen it.
  if (legacyPriceKeys(row.channel).some(key => Object.prototype.hasOwnProperty.call(bag, key))) return false
  const override = decimalToNumber(row.priceOverride)
  const own = row.followMasterPrice === false ? override ?? decimalToNumber(row.price) : override == null ? null : undefined
  if (own === undefined) return false
  return own === (t.expectedPrice === null ? null : round2(t.expectedPrice))
}
const money = (v: number | null, currency: string) => (v == null ? '—' : `${currency} ${v.toFixed(2)}`)

export async function writeChannelPrices(input: {
  targets: PriceWriteTarget[]
  actor: string
  source: PriceChangeSourceLiteral
  /** The timeline sentence prefix, e.g. `bulk-override SET_FIXED 89.99`; the service appends what changed. */
  reason?: string
  /** CFI-6 — record the channel's own price; nothing is sent (see `PriceWriteRecordOnlyReason`). */
  recordOnly?: PriceWriteRecordOnlyReason
  /** Run inside the caller's open transaction (every read and write), instead of one transaction per listing. */
  tx?: Prisma.TransactionClient
}): Promise<PriceWriteResult> {
  const result: PriceWriteResult = { results: [], applied: 0, refused: 0, noop: 0, conflict: 0 }
  if (input.targets.length === 0) return result
  const db = (input.tx ?? prisma) as typeof prisma
  const inTransaction = <T,>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> => input.tx ? work(input.tx) : prisma.$transaction(work)
  const ids = [...new Set(input.targets.map((t) => t.listingId))]
  /**
   * 🔴 PLAN 15.5 (a) — this was one `where: { id: { in: ids } }` with no limit. A 5,000-row price
   * edit is one enormous `IN` list, and the same list goes to `readSaleWindows`. Chunked so the
   * query stays a query whatever the edit's size; the service's own shape is unchanged, because
   * 15.5's point is that *"the bones are right; only the limits are missing."*
   */
  const READ_CHUNK = 500
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += READ_CHUNK) chunks.push(ids.slice(i, i + READ_CHUNK))
  const [listingChunks, windowChunks, hasWindow] = await Promise.all([
    Promise.all(chunks.map((chunk) => db.channelListing.findMany({
      where: { id: { in: chunk } },
      select: LISTING_SELECT,
    }))),
    Promise.all(chunks.map((chunk) => readSaleWindows(db as never, chunk))),
    saleWindowColumnsExist(db as never),
  ])
  const listings = listingChunks.flat()
  // 🔴 A MAP, not an object. `Object.assign` type-checks here and merges NOTHING — every sale
  // window would vanish, silently, and only on edits large enough to chunk. Caught by a test that
  // chunks; tsc was perfectly happy with it.
  const windows = new Map(windowChunks.flatMap((part) => [...part]))
  const byId = new Map(listings.map((l) => [l.id, l]))
  // Every market row of the channels involved: `listingMarketCurrency` reads a market the way the cascade does (GB is
  // UK, `EBAY_IT` is IT), and an unconfigured market is never the master currency.
  const channels = [...new Set(listings.map((l) => l.channel))]
  const currencyRows: MarketCurrencyRow[] = channels.length
    ? await db.marketplace.findMany({ where: { channel: { in: channels } }, select: { channel: true, code: true, currency: true } })
    : []
  const master = masterCurrency()
  const queued: Array<{ id: string; productId: string | null; syncType: string; holdUntil: Date | null }> = []
  const refusals: Array<{ productId: string | null; masterPrice: number; refusal: MasterCurrencyRefusal }> = []

  targets: for (const t of input.targets) {
    const found = byId.get(t.listingId)
    let retried = false
    // `guarded` is set HERE, from the target, so no outcome site can forget it and no unguarded
    // write can report itself as checked. `retried` likewise, so a retried write always says so.
    const push = (o: Omit<PriceWriteOutcome, 'listingId' | 'guarded'>) => {
      result.results.push({ listingId: t.listingId, guarded: t.expectedVersion !== undefined, ...(retried ? { retried: true as const } : {}), ...o })
      result[o.outcome]++
    }
    if (!found) { push({ productId: null, channel: null, marketplace: null, outcome: 'refused', reason: 'No listing with this id', version: 0, queueId: null }); continue }
    // 🔴 The compare-and-set. `undefined` here is only reachable when the caller NAMED an
    // `unguardedReason` — the type refuses it otherwise — and that write is reported `guarded:false`.
    if (t.expectedVersion !== undefined && t.expectedVersion !== found.version) {
      if (!priceAsSeen(t, found)) { push({ productId: found.productId, channel: found.channel, marketplace: found.marketplace, queueId: null, outcome: 'conflict', reason: 'Changed elsewhere — reloaded', version: found.version }); continue }
      retried = true
    }
    let current = found
    // At most two attempts: the second exists only for a compare-and-set lost to a write that did
    // not touch the price (A-17). Every outcome inside leaves through `continue targets`.
    for (let attempt = 0; attempt < 2; attempt++) {
      const l = current
      const base = { productId: l.productId, channel: l.channel, marketplace: l.marketplace, queueId: null as string | null }
      const refuse = (reason: string) => push({ ...base, outcome: 'refused', reason, version: l.version })
      if (t.price === undefined && t.sale === undefined && t.compareAt === undefined && t.rule === undefined && t.follow === undefined) { push({ ...base, outcome: 'noop', version: l.version }); continue targets }
      if (t.compareAt !== undefined && l.channel !== 'SHOPIFY') { refuse('Only a Shopify listing has a compare-at price'); continue targets }
      if (t.compareAt !== undefined && !input.recordOnly) { refuse('A compare-at price is recorded from Shopify’s own file only; change it in the Shopify tab.'); continue targets }
      if (input.recordOnly && (t.rule !== undefined || t.follow !== undefined)) { refuse('A price recorded from the channel’s own file carries no pricing rule or follow-master change.'); continue targets }
      if ((t.follow === true && typeof t.price === 'number') || (t.follow === false && t.price === null)) {
        refuse('A listing cannot follow the master and be pinned at its own price in the same change.')
        continue targets
      }
      const nextCompare = t.compareAt === undefined ? undefined : t.compareAt === null ? null : round2(Number(t.compareAt))
      if (nextCompare !== undefined && nextCompare !== null && (!Number.isFinite(nextCompare) || nextCompare < 0)) { refuse('A compare-at price is zero or more'); continue targets }
      const currentCompare = storedCompareAt(l.platformAttributes)
      const currency = listingMarketCurrency(l, currencyRows) ?? 'EUR'
      const currentPrice = decimalToNumber(l.price)
      const currentOverride = decimalToNumber(l.priceOverride)
      const nextPrice = t.price === undefined ? undefined : t.price == null ? null : round2(Number(t.price))
      if (nextPrice !== undefined && nextPrice !== null && (!Number.isFinite(nextPrice) || nextPrice < 0)) { refuse('A price is zero or more'); continue targets }
      const currentSale: { value: number | null } & SaleWindow = { value: decimalToNumber(l.salePrice), ...(windows.get(l.id) ?? { start: null, end: null }) }
      const nextSale = t.sale === undefined ? undefined : { value: t.sale.value == null ? null : round2(Number(t.sale.value)), start: t.sale.value == null ? null : t.sale.start, end: t.sale.value == null ? null : t.sale.end }
      if (nextSale) {
        const problem = validateSaleWindow(nextSale.value, nextSale)
        if (problem) { refuse(problem); continue targets }
        if (nextSale.value != null && !hasWindow) { refuse('This database has no sale-window columns yet — the sale cannot be scheduled'); continue targets }
      }

      // ── Follower mode: the rule columns, the follow flag, and the price they give ──────────────────────────────
      let nextRule: PricingRuleName | undefined
      if (t.rule?.pricingRule !== undefined) {
        const name = normalisePricingRule(t.rule.pricingRule)
        if (!name) { refuse(PRICING_RULE_REFUSAL); continue targets }
        nextRule = name
      }
      let nextAdj: number | undefined
      if (t.rule?.priceAdjustmentPercent !== undefined) {
        const problem = adjustmentPercentProblem(t.rule.priceAdjustmentPercent)
        if (problem) { refuse(problem); continue targets }
        nextAdj = round2(Number(t.rule.priceAdjustmentPercent))
      }
      const basePrice = decimalToNumber(l.product?.basePrice)
      const wasFollowing = l.followMasterPrice !== false
      const currentRule = (l.pricingRule ?? 'FIXED') as string
      const currentAdj = decimalToNumber(l.priceAdjustmentPercent)
      const ruleAfter = nextRule ?? currentRule
      const adjAfter = nextAdj !== undefined ? nextAdj : currentAdj
      const handBack = t.price === null || t.follow === true
      const pin = typeof nextPrice === 'number'
      const unfollow = t.follow === false && t.price === undefined
      const followAfter = handBack ? true : pin || unfollow ? false : wasFollowing
      const ruleColumns: { pricingRule?: PricingRuleName; priceAdjustmentPercent?: number } = {}
      if (nextRule !== undefined && nextRule !== currentRule) ruleColumns.pricingRule = nextRule
      if (nextAdj !== undefined && nextAdj !== currentAdj) ruleColumns.priceAdjustmentPercent = nextAdj
      const ruleChanges = Object.keys(ruleColumns).length > 0

      // A-18: the storage contract owns the historical keys. A dirty reset is a write even
      // when the explicit columns already follow master; the resolver still reads the JSON bag.
      const priceKeys = legacyPriceKeys(l.channel)
      const dirtyPrice = priceKeys.some(key => Object.prototype.hasOwnProperty.call(l.overrideData ?? {}, key))
      const followColumns: { followMasterPrice?: boolean; priceOverride?: null } = {}
      if (handBack && (!wasFollowing || currentOverride != null)) Object.assign(followColumns, { followMasterPrice: true, priceOverride: null })
      if (unfollow && wasFollowing) followColumns.followMasterPrice = false
      const clearLegacy = (handBack || pin) && dirtyPrice

      // The price a following listing carries under its (new) rule — the cascade's rules, from the one module.
      let follower: { next: number; store: boolean; send: boolean } | null = null
      let notSent: string | undefined
      // Recorded only once the change is written (a lost compare-and-set records nothing).
      let currencyRefusal: MasterCurrencyRefusal | null = null
      const followerMode = !pin && (handBack || t.rule !== undefined || t.follow !== undefined)
      if (followerMode && followAfter) {
        const next = basePrice == null ? null : computeListingPrice(basePrice, ruleAfter, true, adjAfter)
        if (next === null) {
          notSent = basePrice == null
            ? 'This product has no master price, so no price was sent.'
            : 'Match Amazon takes this listing’s price from Amazon’s pricing, not from the master, so no price was sent.'
        } else {
          const marketCur = listingMarketCurrency(l, currencyRows)
          if (marketCur !== master) {
            // Refuse, don't convert — exactly as the cascade: the price stays, nothing is queued, and it is recorded.
            currencyRefusal = { listingId: l.id, channel: l.channel, marketplace: l.marketplace, currency: marketCur, masterCurrency: master }
            notSent = masterCurrencyRefusal(currencyRefusal, basePrice!)
          } else {
            const who = `${l.product?.sku ?? 'This listing'} on ${l.channel} ${l.marketplace}`
            if (next <= 0) { refuse(`${who} would follow ${pricingRuleLabel(ruleAfter, adjAfter)} at ${next.toFixed(2)}: a price must be above 0. Nothing was changed.`); continue targets }
            const outside = masterPriceBoundsReason(next, priceBoundsOf(l.product ?? {}))
            if (outside) { refuse(`${who} would follow ${pricingRuleLabel(ruleAfter, adjAfter)} at ${next.toFixed(2)}, but ${outside}. Change the rule, or the floor or ceiling on the product. Nothing was changed.`); continue targets }
            const held = holdsCascadedPrice(l)
            const moves = next !== currentPrice
            follower = { next, store: moves, send: !held && (moves || !wasFollowing) }
            if (held && moves) notSent = heldPriceSentence(l, next)
          }
        }
      } else if (ruleChanges && !followAfter && !pin) {
        notSent = `This listing keeps its own price ${money(currentPrice, currency)}: it does not follow the master. The rule applies once it follows the master again.`
      }

      const priceChanges = pin && (dirtyPrice || !(currentPrice === nextPrice && currentOverride === nextPrice && l.followMasterPrice === false))
      const saleChanges = nextSale !== undefined && (nextSale.value !== currentSale.value || nextSale.start !== currentSale.start || nextSale.end !== currentSale.end)
      const compareChanges = nextCompare !== undefined && (currentCompare.state !== 'stored' || currentCompare.value !== nextCompare)
      const followChanges = Object.keys(followColumns).length > 0
      const followerWrites = !!follower?.store || !!follower?.send || followChanges || ruleChanges || (handBack && clearLegacy)
      if (!priceChanges && !saleChanges && !compareChanges && !followerWrites) { push({ ...base, outcome: 'noop', version: l.version }); continue targets }

      const sendsPrice = priceChanges || !!follower?.send
      const effectivePrice = priceChanges ? nextPrice! : follower?.store || follower?.send ? follower.next
        : (currentPrice ?? (wasFollowing && basePrice != null ? computeListingPrice(basePrice, currentRule, true, currentAdj) : currentOverride))
      const effectiveSale = saleChanges ? nextSale! : currentSale
      const sentences: string[] = []
      if (priceChanges) sentences.push(`price ${money(currentPrice, currency)} → ${money(nextPrice!, currency)}`)
      if (ruleChanges) {
        if (ruleColumns.pricingRule) sentences.push(`pricing rule ${currentRule} → ${ruleColumns.pricingRule}`)
        if (ruleColumns.priceAdjustmentPercent !== undefined) sentences.push(`adjustment ${currentAdj == null ? '—' : `${currentAdj}%`} → ${ruleColumns.priceAdjustmentPercent}%`)
      }
      if (handBack) sentences.push(follower?.store ? `price ${money(currentPrice, currency)} → ${money(follower.next, currency)} — follows ${pricingRuleLabel(ruleAfter, adjAfter)}` : `follows ${pricingRuleLabel(ruleAfter, adjAfter)} (price ${money(currentPrice, currency)} kept)`)
      else if (follower?.store) sentences.push(`price ${money(currentPrice, currency)} → ${money(follower.next, currency)} — follows ${pricingRuleLabel(ruleAfter, adjAfter)}`)
      if (unfollow && followChanges) sentences.push(`stops following the master (keeps ${money(currentPrice, currency)})`)
      if (saleChanges) sentences.push(nextSale!.value == null ? `sale cleared (was ${money(currentSale.value, currency)})` : `sale ${money(nextSale!.value, currency)} ${nextSale!.start} → ${nextSale!.end}`)
      if (compareChanges) sentences.push(`compare-at ${money(currentCompare.value, currency)} → ${money(nextCompare!, currency)}`)
      if (notSent) sentences.push(`not sent: ${notSent}`)
      const reason = [input.reason, sentences.join(' · ')].filter(Boolean).join(': ')
      if (input.recordOnly && await db.outboundSyncQueue.count({ where: { channelListingId: l.id, syncType: 'PRICE_UPDATE', syncStatus: 'PENDING' } })) {
        refuse(`A price change is waiting to be sent to ${l.channel}. Send or cancel it before importing the channel's price.`)
        continue targets
      }
      // A follower change that sends nothing (a rule on a pinned listing, a refused currency, a held listing, MATCH_AMAZON)
      // leaves the sync state alone: nothing is waiting to be sent.
      const queues = !input.recordOnly && (sendsPrice || saleChanges)

      const written = await inTransaction(async (tx) => {
        // A recorded channel price leaves the sync state alone: nothing is queued, so nothing is pending.
        const data: Prisma.ChannelListingUpdateManyMutationInput = queues ? { syncStatus: 'PENDING', lastSyncStatus: 'PENDING', version: { increment: 1 } } : { version: { increment: 1 } }
        if (priceChanges) Object.assign(data, { price: nextPrice, priceOverride: nextPrice, followMasterPrice: false, lastOverrideAt: new Date(), lastOverrideBy: input.actor })
        if (follower?.store) Object.assign(data, { price: follower.next, masterPrice: basePrice })
        if (followChanges || ruleChanges) Object.assign(data, followColumns, ruleColumns, { lastOverrideAt: new Date(), lastOverrideBy: input.actor })
        if (saleChanges) data.salePrice = effectiveSale.value
        // The bag as read with this version: the compare-and-set below proves nobody changed it since.
        if (compareChanges) data.platformAttributes = withCompareAt(l.platformAttributes, nextCompare!) as Prisma.InputJsonValue
        const guarded = await tx.channelListing.updateMany({ where: { id: l.id, version: l.version }, data })
        if (guarded.count !== 1) return null
        if (clearLegacy) await tx.$executeRaw`
          UPDATE "ChannelListing" SET "overrideData" = COALESCE("overrideData", '{}'::jsonb) - ${priceKeys}::text[]
          WHERE id = ${l.id}
        `
        if (saleChanges) await writeSaleWindow(tx, l.id, { start: effectiveSale.start, end: effectiveSale.end })
        const previousOwn = currentOverride == null ? (currentPrice == null ? null : String(currentPrice)) : String(currentOverride)
        if (priceChanges) {
          await tx.channelListingOverride.create({ data: { channelListingId: l.id, fieldName: 'price', previousValue: previousOwn, newValue: String(nextPrice), reason, changedBy: input.actor } })
        } else if (handBack || follower?.store) {
          // A hand-back, or a follower price that moved: the listing's own price is gone, the rule's price is what it carries.
          await tx.channelListingOverride.create({ data: { channelListingId: l.id, fieldName: 'price', previousValue: previousOwn, newValue: follower?.store ? String(follower.next) : null, reason, changedBy: input.actor } })
        }
        if (ruleColumns.pricingRule) await tx.channelListingOverride.create({ data: { channelListingId: l.id, fieldName: 'pricingRule', previousValue: currentRule, newValue: ruleColumns.pricingRule, reason, changedBy: input.actor } })
        if (ruleColumns.priceAdjustmentPercent !== undefined) await tx.channelListingOverride.create({ data: { channelListingId: l.id, fieldName: 'priceAdjustmentPercent', previousValue: currentAdj == null ? null : String(currentAdj), newValue: String(ruleColumns.priceAdjustmentPercent), reason, changedBy: input.actor } })
        if (unfollow && followChanges) await tx.channelListingOverride.create({ data: { channelListingId: l.id, fieldName: 'followMasterPrice', previousValue: 'true', newValue: 'false', reason, changedBy: input.actor } })
        if (priceChanges || follower?.store) {
          const newPrice = priceChanges ? nextPrice! : follower!.next
          await tx.priceChangeEvent.create({ data: priceChangeData({ productId: l.productId, sku: l.product?.sku ?? '', channel: l.channel, marketplace: l.marketplace, fulfillmentMethod: l.fulfillmentMethod ?? null, oldPrice: currentPrice, newPrice, currency, source: input.source, reason, actor: input.actor }) })
        }
        if (compareChanges) {
          await tx.channelListingOverride.create({ data: { channelListingId: l.id, fieldName: 'compareAtPrice', previousValue: currentCompare.value == null ? null : String(currentCompare.value), newValue: nextCompare == null ? null : String(nextCompare), reason, changedBy: input.actor } })
        }
        if (saleChanges) {
          await tx.channelListingOverride.create({ data: { channelListingId: l.id, fieldName: 'salePrice', previousValue: currentSale.value == null ? null : `${currentSale.value} ${currentSale.start ?? ''}→${currentSale.end ?? ''}`.trim(), newValue: effectiveSale.value == null ? null : `${effectiveSale.value} ${effectiveSale.start}→${effectiveSale.end}`, reason, changedBy: input.actor } })
        }
        let queueId: string | null = null
        if (queues && VALID_SYNC_TARGETS.has(l.channel)) {
          // Amazon — with NEXUS_AMAZON_OFFER_MERGE on, a price push leaves the sale Amazon holds alone (a merge,
          // `amazon/purchasable-offer.ts`), so a person REMOVING Nexus's own sale (a value with both dates: the only sale
          // Nexus sends) must say so on the row, and keep saying so when a later write in the grace window cancels that
          // row for this one. Written whether the switch is on or not: OFF ignores it (its replace drops the sale anyway),
          // and a row queued just before the switch goes on still carries the removal. Other channels: unchanged.
          const saleRemoved = l.channel === 'AMAZON' && effectiveSale.value == null && (
            (saleChanges && currentSale.value != null && !!currentSale.start && !!currentSale.end)
            || !!(await tx.outboundSyncQueue.findFirst({ where: { channelListingId: l.id, syncType: 'PRICE_UPDATE', syncStatus: 'PENDING', payload: { path: ['saleRemoved'], equals: true } }, select: { id: true } })))
          await tx.outboundSyncQueue.updateMany({ where: { channelListingId: l.id, syncType: 'PRICE_UPDATE', syncStatus: 'PENDING' }, data: { syncStatus: 'CANCELLED', errorMessage: 'Replaced by a newer price change for this listing' } })
          const holdUntil = new Date(Date.now() + PRICE_HOLD_MS)
          const sale = {
            salePrice: effectiveSale.value, salePriceStart: effectiveSale.start, salePriceEnd: effectiveSale.end,
            ...(saleRemoved ? { saleRemoved: true } : {}),
          }
          // A follower price is queued with the cascade's payload fields (`followerPricePayload`), so a row from the
          // cascade and a row from this door say the same things; a pin keeps this door's own payload.
          const payload = follower?.send && !priceChanges
            ? {
                ...followerPricePayload({
                  source: 'CHANNEL_PRICE_WRITE', productId: l.productId, productSku: l.product?.sku ?? null, channel: l.channel,
                  marketplace: l.marketplace, price: follower.next, oldPrice: currentPrice, masterPrice: basePrice!,
                  oldMasterPrice: decimalToNumber(l.masterPrice), pricingRule: ruleAfter, priceAdjustmentPercent: adjAfter,
                  reason, idempotencyKey: null,
                }),
                actor: input.actor, ...sale,
              }
            : {
                source: 'CHANNEL_PRICE_WRITE', marketplace: l.marketplace, actor: input.actor,
                productSku: l.product?.sku ?? null,
                price: effectivePrice ?? undefined,
                ...sale,
              }
          const row = await createOutboundRow(tx, {
            data: {
              productId: l.productId, channelListingId: l.id, targetChannel: l.channel as never, targetRegion: l.region,
              syncStatus: 'PENDING' as never, syncType: 'PRICE_UPDATE', holdUntil, externalListingId: l.externalListingId, maxRetries: 3,
              payload: payload as Prisma.InputJsonValue,
            },
            select: { id: true, productId: true, syncType: true, holdUntil: true },
          })
          queueId = row.id
          queued.push(row)
        }
        return { version: l.version + 1, queueId }
      })
      if (!written) {
        const fresh = await db.channelListing.findUnique({ where: { id: l.id }, select: LISTING_SELECT })
        // A-17 — lost the compare-and-set to a write in the gap. Retry once, only if the price is still
        // the one the caller saw; the re-read row (and its sale window) is what the second attempt uses.
        if (attempt === 0 && fresh && priceAsSeen(t, fresh)) {
          const window = (await readSaleWindows(db as never, [fresh.id])).get(fresh.id)
          if (window) windows.set(fresh.id, window); else windows.delete(fresh.id)
          current = fresh
          retried = true
          continue
        }
        push({ ...base, outcome: 'conflict', reason: 'Changed elsewhere — reloaded', version: fresh?.version ?? l.version })
        continue targets
      }
      if (currencyRefusal) refusals.push({ productId: l.productId, masterPrice: basePrice!, refusal: currencyRefusal })
      push({ ...base, outcome: 'applied', version: written.version, queueId: written.queueId, ...(notSent ? { notSent } : {}) })
      continue targets
    }
  }
  // Post-commit: the instant lane honours each row's own holdUntil; the drain cron is the fallback (never hangs).
  if (queued.length) await afterDatabaseCommit(`channel-prices:${queued.map(row => row.id).join(',')}`,
    () => fireOutboundJobs(queued, { source: 'CHANNEL_PRICE_WRITE' }))
  // The cascade's currency refusals, recorded the same way once the change is committed. Best effort.
  if (refusals.length) await afterDatabaseCommit(`channel-price-currency:${refusals.map(r => r.refusal.listingId).join(',')}`,
    async () => { for (const r of refusals) await logMasterCurrencyRefusals(r.productId, r.masterPrice, [r.refusal]) })
  logger.info('channel-price-write: applied', { actor: input.actor, source: input.source, ...(input.recordOnly ? { recordOnly: input.recordOnly } : {}), applied: result.applied, refused: result.refused, noop: result.noop, conflict: result.conflict })
  return result
}
