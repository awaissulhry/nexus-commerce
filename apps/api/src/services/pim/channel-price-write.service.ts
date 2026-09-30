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
 *     sale on Amazon (report 19 §5.9) and a sale push never wipes the price.
 *   - CAS on `ChannelListing.version` (bumped on every applied row); `noop` spends nothing.
 *   - NCF D2 A — Shopify's compare-at price (`compareAt`), kept at `platformAttributes.compareAtPrice`
 *     (`compare-at-price.ts`), through the same CAS and audit. Record-only: it comes from Shopify's own file, and no
 *     PRICE_UPDATE carries it, so a sending write refuses it by name.
 *
 * `channel-pricing` PATCH, `pricing/bulk-override` and the Matrix door delegate here. No snapshot refresh: the
 * pricing engine's chain is in no publish path (M8) and its hourly cron re-materialises the snapshot.
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

const VALID_SYNC_TARGETS = new Set(['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE'])
/** The same operator grace window the FOLLOW/PIN primitives use: 30 s to undo before the push leaves. */
const PRICE_HOLD_MS = 30 * 1000

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
}

export interface PriceWriteResult { results: PriceWriteOutcome[]; applied: number; refused: number; noop: number; conflict: number }

const round2 = (n: number) => Math.round(n * 100) / 100

const LISTING_SELECT = {
  id: true, productId: true, channel: true, marketplace: true, region: true, externalListingId: true, price: true, priceOverride: true,
  overrideData: true, salePrice: true, followMasterPrice: true, version: true, fulfillmentMethod: true, product: { select: { sku: true, basePrice: true } },
  platformAttributes: true,
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
  if (t.expectedPrice === undefined || t.sale !== undefined || t.compareAt !== undefined) return false
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
  const marketKeys = [...new Set(listings.map((l) => `${l.channel}|${l.marketplace}`))]
  const marketplaces = await db.marketplace.findMany({ where: { OR: marketKeys.map((k) => ({ channel: k.split('|')[0], code: k.split('|')[1] })) }, select: { channel: true, code: true, currency: true } })
  const currencyOf = new Map(marketplaces.map((m) => [`${m.channel}|${m.code}`, m.currency]))
  const queued: Array<{ id: string; productId: string | null; syncType: string; holdUntil: Date | null }> = []

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
      if (t.price === undefined && t.sale === undefined && t.compareAt === undefined) { push({ ...base, outcome: 'noop', version: l.version }); continue targets }
      if (t.compareAt !== undefined && l.channel !== 'SHOPIFY') { push({ ...base, outcome: 'refused', reason: 'Only a Shopify listing has a compare-at price', version: l.version }); continue targets }
      if (t.compareAt !== undefined && !input.recordOnly) { push({ ...base, outcome: 'refused', reason: 'A compare-at price is recorded from Shopify’s own file only; change it in the Shopify tab.', version: l.version }); continue targets }
      const nextCompare = t.compareAt === undefined ? undefined : t.compareAt === null ? null : round2(Number(t.compareAt))
      if (nextCompare !== undefined && nextCompare !== null && (!Number.isFinite(nextCompare) || nextCompare < 0)) { push({ ...base, outcome: 'refused', reason: 'A compare-at price is zero or more', version: l.version }); continue targets }
      const currentCompare = storedCompareAt(l.platformAttributes)
      const currency = currencyOf.get(`${l.channel}|${l.marketplace}`) ?? 'EUR'
      const currentPrice = decimalToNumber(l.price)
      const currentOverride = decimalToNumber(l.priceOverride)
      const nextPrice = t.price === undefined ? undefined : t.price == null ? null : round2(Number(t.price))
      if (nextPrice !== undefined && nextPrice !== null && (!Number.isFinite(nextPrice) || nextPrice < 0)) { push({ ...base, outcome: 'refused', reason: 'A price is zero or more', version: l.version }); continue targets }
      const currentSale: { value: number | null } & SaleWindow = { value: decimalToNumber(l.salePrice), ...(windows.get(l.id) ?? { start: null, end: null }) }
      const nextSale = t.sale === undefined ? undefined : { value: t.sale.value == null ? null : round2(Number(t.sale.value)), start: t.sale.value == null ? null : t.sale.start, end: t.sale.value == null ? null : t.sale.end }
      if (nextSale) {
        const problem = validateSaleWindow(nextSale.value, nextSale)
        if (problem) { push({ ...base, outcome: 'refused', reason: problem, version: l.version }); continue targets }
        if (nextSale.value != null && !hasWindow) { push({ ...base, outcome: 'refused', reason: 'This database has no sale-window columns yet — the sale cannot be scheduled', version: l.version }); continue targets }
      }
      // A-18: the storage contract owns the historical keys. A dirty reset is a write even
      // when the explicit columns already follow master; the resolver still reads the JSON bag.
      const priceKeys = legacyPriceKeys(l.channel)
      const dirtyPrice = priceKeys.some(key => Object.prototype.hasOwnProperty.call(l.overrideData ?? {}, key))
      const priceChanges = nextPrice !== undefined && (dirtyPrice || !(nextPrice === null ? l.followMasterPrice !== false && currentOverride == null : currentPrice === nextPrice && currentOverride === nextPrice && l.followMasterPrice === false))
      const saleChanges = nextSale !== undefined && (nextSale.value !== currentSale.value || nextSale.start !== currentSale.start || nextSale.end !== currentSale.end)
      const compareChanges = nextCompare !== undefined && (currentCompare.state !== 'stored' || currentCompare.value !== nextCompare)
      if (!priceChanges && !saleChanges && !compareChanges) { push({ ...base, outcome: 'noop', version: l.version }); continue targets }

      const basePrice = decimalToNumber(l.product?.basePrice)
      const effectivePrice = priceChanges ? (nextPrice ?? basePrice) : (currentPrice ?? (l.followMasterPrice !== false ? basePrice : currentOverride))
      const effectiveSale = saleChanges ? nextSale! : currentSale
      const sentences: string[] = []
      if (priceChanges) sentences.push(nextPrice == null ? `price cleared (was ${money(currentPrice, currency)}) — follows the base price` : `price ${money(currentPrice, currency)} → ${money(nextPrice, currency)}`)
      if (saleChanges) sentences.push(nextSale!.value == null ? `sale cleared (was ${money(currentSale.value, currency)})` : `sale ${money(nextSale!.value, currency)} ${nextSale!.start} → ${nextSale!.end}`)
      if (compareChanges) sentences.push(`compare-at ${money(currentCompare.value, currency)} → ${money(nextCompare!, currency)}`)
      const reason = [input.reason, sentences.join(' · ')].filter(Boolean).join(': ')
      if (input.recordOnly && await db.outboundSyncQueue.count({ where: { channelListingId: l.id, syncType: 'PRICE_UPDATE', syncStatus: 'PENDING' } })) {
        push({ ...base, outcome: 'refused', reason: `A price change is waiting to be sent to ${l.channel}. Send or cancel it before importing the channel's price.`, version: l.version })
        continue targets
      }

      const written = await inTransaction(async (tx) => {
        // A recorded channel price leaves the sync state alone: nothing is queued, so nothing is pending.
        const data: Prisma.ChannelListingUpdateManyMutationInput = input.recordOnly ? { version: { increment: 1 } } : { syncStatus: 'PENDING', lastSyncStatus: 'PENDING', version: { increment: 1 } }
        if (priceChanges) {
          if (nextPrice == null) Object.assign(data, { price: null, priceOverride: null, followMasterPrice: true, lastOverrideAt: new Date(), lastOverrideBy: input.actor })
          else Object.assign(data, { price: nextPrice, priceOverride: nextPrice, followMasterPrice: false, lastOverrideAt: new Date(), lastOverrideBy: input.actor })
        }
        if (saleChanges) data.salePrice = effectiveSale.value
        // The bag as read with this version: the compare-and-set below proves nobody changed it since.
        if (compareChanges) data.platformAttributes = withCompareAt(l.platformAttributes, nextCompare!) as Prisma.InputJsonValue
        const guarded = await tx.channelListing.updateMany({ where: { id: l.id, version: l.version }, data })
        if (guarded.count !== 1) return null
        if (priceChanges && dirtyPrice) await tx.$executeRaw`
          UPDATE "ChannelListing" SET "overrideData" = COALESCE("overrideData", '{}'::jsonb) - ${priceKeys}::text[]
          WHERE id = ${l.id}
        `
        if (saleChanges) await writeSaleWindow(tx, l.id, { start: effectiveSale.start, end: effectiveSale.end })
        if (priceChanges) {
          await tx.channelListingOverride.create({ data: { channelListingId: l.id, fieldName: 'price', previousValue: currentOverride == null ? (currentPrice == null ? null : String(currentPrice)) : String(currentOverride), newValue: nextPrice == null ? null : String(nextPrice), reason, changedBy: input.actor } })
          await tx.priceChangeEvent.create({ data: priceChangeData({ productId: l.productId, sku: l.product?.sku ?? '', channel: l.channel, marketplace: l.marketplace, fulfillmentMethod: l.fulfillmentMethod ?? null, oldPrice: currentPrice, newPrice: nextPrice ?? basePrice, currency, source: input.source, reason, actor: input.actor }) })
        }
        if (compareChanges) {
          await tx.channelListingOverride.create({ data: { channelListingId: l.id, fieldName: 'compareAtPrice', previousValue: currentCompare.value == null ? null : String(currentCompare.value), newValue: nextCompare == null ? null : String(nextCompare), reason, changedBy: input.actor } })
        }
        if (saleChanges) {
          await tx.channelListingOverride.create({ data: { channelListingId: l.id, fieldName: 'salePrice', previousValue: currentSale.value == null ? null : `${currentSale.value} ${currentSale.start ?? ''}→${currentSale.end ?? ''}`.trim(), newValue: effectiveSale.value == null ? null : `${effectiveSale.value} ${effectiveSale.start}→${effectiveSale.end}`, reason, changedBy: input.actor } })
        }
        let queueId: string | null = null
        if (!input.recordOnly && VALID_SYNC_TARGETS.has(l.channel)) {
          await tx.outboundSyncQueue.updateMany({ where: { channelListingId: l.id, syncType: 'PRICE_UPDATE', syncStatus: 'PENDING' }, data: { syncStatus: 'CANCELLED', errorMessage: 'Replaced by a newer price change for this listing' } })
          const holdUntil = new Date(Date.now() + PRICE_HOLD_MS)
          const row = await createOutboundRow(tx, {
            data: {
              productId: l.productId, channelListingId: l.id, targetChannel: l.channel as never, targetRegion: l.region,
              syncStatus: 'PENDING' as never, syncType: 'PRICE_UPDATE', holdUntil, externalListingId: l.externalListingId, maxRetries: 3,
              payload: {
                source: 'CHANNEL_PRICE_WRITE', marketplace: l.marketplace, actor: input.actor,
                productSku: l.product?.sku ?? null,
                price: effectivePrice ?? undefined,
                salePrice: effectiveSale.value, salePriceStart: effectiveSale.start, salePriceEnd: effectiveSale.end,
              } as Prisma.InputJsonValue,
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
      push({ ...base, outcome: 'applied', version: written.version, queueId: written.queueId })
      continue targets
    }
  }
  // Post-commit: the instant lane honours each row's own holdUntil; the drain cron is the fallback (never hangs).
  if (queued.length) await afterDatabaseCommit(`channel-prices:${queued.map(row => row.id).join(',')}`,
    () => fireOutboundJobs(queued, { source: 'CHANNEL_PRICE_WRITE' }))
  logger.info('channel-price-write: applied', { actor: input.actor, source: input.source, ...(input.recordOnly ? { recordOnly: input.recordOnly } : {}), applied: result.applied, refused: result.refused, noop: result.noop, conflict: result.conflict })
  return result
}
