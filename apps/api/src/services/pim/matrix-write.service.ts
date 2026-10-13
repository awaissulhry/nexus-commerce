/**
 * MX.1 — the Matrix WRITE DOOR, the VERBS and the REVERT (design §3.7, §3.8, D-MX9; the semantics `store.ts` gives
 * the page in preview mode, made real).
 *
 * ONE door. Every cell write is CAS-checked on the listing's `ChannelListing.version` (a stale `expectedVersion` is a
 * `conflict` carrying the CURRENT version — unless the write's field stamp still holds: the cell's own field(s) are what
 * the person saw, so it goes ahead at the fresh version, `@nexus/shared/matrix-stamp`), refused BY NAME with the read's
 * own sentence (FBA → `Amazon-managed` or the guard's sentence, the parent, a formula-owned price, a missing
 * `products.price.edit`, a pinned buffer), a `noop` when nothing would change (no version spent), and `applied` with the NEW version. Every applied write bumps the version
 * FIRST (`updateMany where { id, version }`) and only then delegates — so a concurrent writer conflicts instead of
 * being clobbered, and the follow / pin / buffer primitives are told not to bump a second time (`bumpVersion: false`):
 *
 *   syncMode / syncQty → `setFollowMasterQuantity` (FOLLOW, or PIN; typing into a Follow cell pins AT THE TYPED VALUE,
 *                        D-MX3 — the value is staged into `quantity` inside the CAS transaction and the primitive's
 *                        snapshot rule pins exactly it)
 *   syncBuffer         → `setStockBuffer`
 *   fulfilment         → `fulfillment-method.service.ts` (Add 4(a))
 *   price / salePrice  → `channel-price-write.service.ts` (Add 4(b); `products.price.edit` enforced here too, Add 4(d))
 *   businessPrice      → `business-price-write.service.ts` (Amazon Business step 5): the WHOLE setting — rule, percent or
 *   businessTiers        exact price, and the quantity tiers (`BusinessPriceSetting`; `null` = no business offer). Both
 *                        columns send the whole setting (the Tiers column under its own kind, for its own round-trip
 *                        mark). `products.price.edit`.
 *   source             → "Sells from" (Step 2): `ChannelListing.sourceLocationCodes` under the same CAS bump, audited,
 *                        announced (`stockSource`) and re-pushed (`recascadeAfterSyncControlChange`); `inventory.adjust`
 *
 * A REGION cell (`AMAZON:EU`) lands on EVERY EU row of the SKU inside one transaction — every row's version is
 * checked, every row is bumped, or nothing is written (never a partial EU write) — and answers `expandedTo`.
 *
 * VERBS: `commit:false` runs the SHARED `previewVerb` on the live read (the page runs the same function on its own
 * read — identical by construction). `commit:true` re-verifies EVERY carried change by re-running the shared preview
 * for that one target with params rebuilt from `change.to`, refuses what the fresh preview does not reproduce, applies
 * the rest through the door as ONE `BulkOperation` (`kind: 'studio-matrix-verb'`, the D15 import store) that captures
 * every touched cell BY VALUE, and answers `VerbOperation`. REVERT restores the fields the run changed, by value, through
 * the same door (versions bump) — each only while the cell still holds what the run wrote (a newer value stays and the
 * cell answers `changedSince`) — and marks the operation `REVERTED` (or `PARTIAL`, never a lie). Every applied cell of a
 * run or a revert names the version it was checked at (`writtenAt`), so the page records it as its own move.
 */
import { createOutboundRow } from '../outbound-rows.js'
import prisma from '../../db.js'
import type { Prisma } from '@prisma/client'
import { inventoryCoordinate, previewVerb, PREVIEW_WORDS, sameSourceCodes, sellsFromCodes, SOURCE_PERMISSION, sourceCodesProblem, type AmazonFulfilmentFacts, type PreviewContext } from '@nexus/shared/matrix-preview'
import { matrixCellStamp, matrixStampHolds } from '@nexus/shared/matrix-stamp'
import {
  MATRIX_COPY,
  type CoordinateKey,
  type FulfilmentMethod,
  type MatrixCells,
  type MatrixCoordinate,
  type MatrixDoorKind,
  type MatrixListingVersion,
  type MatrixRead,
  type MatrixRowRead,
  type MatrixVerbId,
  type MatrixVerbParams,
  type MatrixVerbRequest,
  type MatrixWritableKind,
  type MatrixWriteCell,
  type MatrixWriteOutcome,
  type MatrixWriteResult,
  type VerbChange,
  type VerbOperation,
  type VerbPreview,
} from '@nexus/shared/matrix-contract'
import { logger } from '../../utils/logger.js'
import { outboundSyncQueue, addJobSafely } from '../../lib/queue.js'
import { safeJobId } from '../../lib/job-id.js'
import { setFollowMasterQuantity, setStockBuffer, amazonManagedListingIds } from '../follow-master.service.js'
import { recascadeAfterSyncControlChange } from '../stock-movement.service.js'
import { coalescePendingQuantityRows } from '../sync-coalesce.js'
import { fireOutboundJobs } from '../outbound-enqueue.js'
import { productReadCacheService } from '../product-read-cache.service.js'
import { canonical } from './import-diff.service.js'
import { setFulfillmentMethod, type FulfilmentWrite } from './fulfillment-method.service.js'
import { convertAmazonFulfilment, loadConversionPlan, type ConversionOrigin } from './fulfilment-conversion.service.js'
import { writeChannelPrices } from './channel-price-write.service.js'
import { writeBusinessPrices } from './business-price-write.service.js'
import type { BusinessPriceSetting } from '@nexus/shared/business-price'
import { getMatrixRead } from './matrix.service.js'
import { roundCents } from '@nexus/shared/listing-price'
import type { ListingCoordinate } from '../../lib/listing-coordinate.js'
import { businessSettingOfCell, PRICE_PERMISSION_REASON, sharedStockReason } from './matrix-cells.js'
import { loadSharedInventoryTargets, type SharedInventoryOptions } from './shared-inventory-targets.js'
import { announceListingValues } from '../listing-values-events.js'
import { SELLING_PAUSED_SENTENCE } from '@nexus/shared/push-lock'

export interface DoorContext {
  productId: string
  actor: string
  can: (permission: string) => boolean
  /** The account the caller's read used (`GET …/studio/matrix?accountId=`): the door reads with it, so it resolves the same listings. */
  accountId?: string | null
  /**
   * Amazon fulfilment conversion (2026-10-07): set only by a run a person confirmed — the verb's commit (the Matrix's typed
   * confirmation, an approved Claude preview) or a revert. An Amazon Fulfilment cell is converted on Amazon only then; a
   * direct cell write is refused with `MATRIX_COPY.fulfilmentViaVerb`.
   */
  conversion?: ConversionOrigin
}

const PRICE_PERMISSION = 'products.price.edit'
const REVERTIBLE_HOURS = 24
const OP_KIND = 'studio-matrix-verb'

/* ── the read, and the listing rows a coordinate stands for ─────────────────────────────────── */

export interface Target { id: string; marketplace: string; version: number }
export type Located = { row: MatrixRowRead; coord: MatrixCoordinate; cells: MatrixCells }

export function locate(read: MatrixRead, rowId: string, key: CoordinateKey): Located | null {
  const row = read.rows.find((r) => r.id === rowId)
  const coord = read.coordinates.find((c) => c.key === key)
  const cells = row?.cells[key]
  return row && coord && cells ? { row, coord, cells } : null
}

/**
 * The listing rows a write on this coordinate lands on: the one listing, or — on the region group — every EU row of
 * the SKU that is not closed (SCT.6: consenting to an EU-wide quantity action must never reopen a closed offer), by the
 * one EU rule (`loadSharedInventoryTargets`). The region cell's own `listingId`/`version` is the PRIMARY market's; its
 * fresh version must still match.
 */
export async function targetsOf(read: MatrixRead, hit: Located, expectedVersion: number, options: SharedInventoryOptions = {}): Promise<{ targets: Target[]; expandedTo?: CoordinateKey[] } | { conflict: number }> {
  if (!hit.coord.sharedInventoryWith) return { targets: [{ id: hit.cells.listingId!, marketplace: hit.coord.market, version: expectedVersion }] }
  // The primary's own market: the market coordinate of this row that holds the same listing (read in memory).
  const own = read.coordinates.find((c) => c.channel === hit.coord.channel && !c.alias && c.key !== hit.coord.key
    && hit.coord.sharedInventoryWith!.includes(c.market) && hit.row.cells[c.key]?.listingId === hit.cells.listingId)?.market
    ?? (await prisma.channelListing.findUnique({ where: { id: hit.cells.listingId! }, select: { marketplace: true } }))?.marketplace
  if (!own) return { conflict: 0 }
  const resolved = await loadSharedInventoryTargets(prisma, {
    id: hit.cells.listingId!, productId: hit.row.id, channel: hit.coord.channel, marketplace: own,
    channelConnectionId: hit.coord.accountId, aliasKey: '', version: expectedVersion,
  }, options)
  if ('conflict' in resolved) return resolved
  return { targets: resolved.targets, expandedTo: (resolved.expandedTo ?? []).map((m) => `${hit.coord.channel}:${m}`) }
}

/** Bump every target's version under CAS inside the caller's transaction; `false` = someone else moved a row → roll back. */
async function bumpAll(tx: Prisma.TransactionClient, targets: readonly Target[], extra: Prisma.ChannelListingUpdateManyMutationInput = {}): Promise<boolean> {
  for (const t of targets) {
    const r = await tx.channelListing.updateMany({ where: { id: t.id, version: t.version }, data: { ...extra, version: { increment: 1 } } })
    if (r.count !== 1) return false
  }
  return true
}

/** A compare-and-set lost to another write; carries the listing's CURRENT version. */
export class Conflict extends Error { constructor(readonly version: number) { super('conflict') } }

/**
 * Build shape v2 — the listing's selling is paused (Inactive: `offerClosedAt`, the product sheet's Pause offer or Amazon's
 * market close). Push quantity now and Retry send nothing to it, whatever the read said a moment ago: the store is asked
 * again where the push is written (inside its transaction), so a pause that landed after the read still wins.
 */
class SellingPaused extends Error { constructor() { super(SELLING_PAUSED_SENTENCE) } }

async function bumpTx(targets: readonly Target[], extra?: Prisma.ChannelListingUpdateManyMutationInput): Promise<void> {
  await prisma.$transaction(async (tx) => {
    if (!(await bumpAll(tx, targets, extra))) throw new Conflict((await tx.channelListing.findUnique({ where: { id: targets[0]!.id }, select: { version: true } }))?.version ?? targets[0]!.version)
  })
}

const asInt = (v: unknown): number | null => { const n = typeof v === 'number' ? v : Number(v); return Number.isInteger(n) ? n : null }

/**
 * The listings among these that are live Amazon offers — published, not ended or removed: the push layer's own rule
 * (`readEuIntentRows`) and Sync Control's EU check. A never-published draft (an SE row prepared beside a Pan-EU group)
 * has no offer at Amazon, so it holds no Amazon-managed quantity and never votes in the FBA verdict of a quantity write.
 */
async function liveAmazonOfferIds(listingIds: readonly string[]): Promise<Set<string>> {
  if (!listingIds.length) return new Set()
  const rows = await prisma.channelListing.findMany({
    where: { id: { in: [...listingIds] }, isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
    select: { id: true },
  })
  return new Set(rows.map((r) => r.id))
}

/** Owner rule (FBA quantity untouchable): does any LIVE Amazon offer among the targets read Amazon-managed? */
async function liveAmazonManaged(channel: string, targets: readonly Target[]): Promise<boolean> {
  if (channel !== 'AMAZON') return false
  const live = await liveAmazonOfferIds(targets.map((t) => t.id))
  return (await amazonManagedListingIds(targets.filter((t) => live.has(t.id)).map((t) => t.id))).size > 0
}

/** A row the primitive skipped as FBA refuses the write — on Amazon only when it is a live offer (a draft is not one). */
async function skippedLiveFba(channel: string, results: ReadonlyArray<{ listingId: string; action: string }>): Promise<boolean> {
  const skipped = results.filter((x) => x.action === 'SKIPPED_FBA').map((x) => x.listingId)
  if (!skipped.length) return false
  if (channel !== 'AMAZON') return true
  return (await liveAmazonOfferIds(skipped)).size > 0
}

/**
 * The quantity MODE writes of the matrix's Mode and Qty cells — ONE implementation for every screen that changes how a
 * listing's quantity is set (the Studio matrix, the listings grid's stock cell, the listing drawer's and the bulk
 * bar's follow toggles, the reset to master, 2026-10-01), so they cannot drift:
 *   1. Owner rule: FBA quantity is untouchable. Any Amazon-managed target that is a live offer refuses the whole write
 *      BEFORE anything is staged (`amazonManagedListingIds`, the primitive's own verdict), so neither the FBA row nor
 *      half of an EU group is written. `staged: false`. A never-published draft is no offer: it does not vote.
 *   2. Every target's version is bumped under CAS — with a typed quantity staged into `quantity` (D-MX3) — and a lost
 *      one throws `Conflict`.
 *   3. The follow/pin primitive (`setFollowMasterQuantity`): FOLLOW rejoins the stock and publishes it; PIN snapshots
 *      the (typed) quantity into the three quantity columns. Either queues the QUANTITY_UPDATE. A live offer it still
 *      skips as FBA refuses with `staged: true`; a draft it skips is left as it is (nothing at Amazon to protect).
 *   4. (Checked before 2.) A PIN on a SKU that sells from another business's stock is refused with the Matrix's
 *      sentence (`sharedStockReason`), `staged: false` — the shared-stock rule of #230.
 * `coordinates` narrows the primitive to exactly the target listings (the listing screens); the matrix narrows by markets.
 */
/**
 * Shared stock by SKU (#230, Owner 2026-10-01): the business whose stock this product sells from, or null. Asked
 * exactly as the database's quantity guard asks it (stock-pool.sql, nexus_stock_pool_quantity_guard: an ACTIVE
 * StockPoolLink on the product), so a fixed number is refused here, with the Matrix's sentence, in every case the
 * database would refuse it with an error.
 */
export async function sharedStockLender(productId: string): Promise<string | null> {
  const link = await prisma.stockPoolLink.findFirst({
    where: { productId, status: 'active' },
    select: { grant: { select: { ownerWorkspace: { select: { name: true } } } } },
  })
  return link ? link.grant?.ownerWorkspace?.name ?? 'another business' : null
}

export async function writeQuantityMode(input: {
  productId: string
  channel: string
  targets: readonly Target[]
  follow: boolean
  /** PIN only: the typed quantity to pin at; without it a PIN keeps the number the listing shows now. */
  quantity?: number
  actor: string
  coordinates?: ListingCoordinate[]
}): Promise<{ refused?: string; staged?: boolean }> {
  if (await liveAmazonManaged(input.channel, input.targets)) return { refused: MATRIX_COPY.amazonManaged, staged: false }
  // 4. Shared stock by SKU (#230): a SKU that sells from another business's stock gets no fixed number — neither a PIN
  //    of what it shows nor a typed one (the Matrix holds its Qty and Mode cells the same way). Back to Follow is fine.
  //    Refused before anything is staged; the database refuses it too (nexus_stock_pool_quantity_guard).
  if (!input.follow) {
    const lender = await sharedStockLender(input.productId)
    if (lender) return { refused: sharedStockReason(lender), staged: false }
  }
  await bumpTx(input.targets, !input.follow && input.quantity !== undefined ? { quantity: input.quantity } : undefined)
  /* The door bumped every target above, under CAS: the primitive must not bump again (the answer names version + 1). */
  const r = await setFollowMasterQuantity({ productIds: [input.productId], channel: input.channel as 'AMAZON' | 'EBAY', markets: input.targets.map((t) => t.marketplace), follow: input.follow, actor: input.actor, ...(input.coordinates ? { coordinates: input.coordinates } : {}), bumpVersion: false })
  if (await skippedLiveFba(input.channel, r.results)) return { refused: MATRIX_COPY.amazonManaged, staged: true }
  return {}
}

/** The Qty cell's PIN at a typed quantity (`writeQuantityMode`, follow: false). */
export function pinTypedQuantity(input: Omit<Parameters<typeof writeQuantityMode>[0], 'follow' | 'quantity'> & { quantity: number }) {
  return writeQuantityMode({ ...input, follow: false })
}

/* ── one cell through the door ──────────────────────────────────────────────────────────────── */

/** The sentence for a business value the door cannot read. */
export const BUSINESS_VALUE_REASON = 'A business price is a percent below the price or an exact price, with up to 5 quantity discounts — or none'

const moneyOrNull = (v: unknown): number | null | undefined => (v == null ? null : typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/**
 * The business cell's value as the door takes it: `BusinessPriceSetting` (`{ rule, percent, price, tiers }`), or `null`
 * for no business offer. `undefined` = not that shape — refused whole, never half read. The rules (ranges, order, Amazon's
 * limits) are the business price door's own (`businessPriceProblems`).
 */
export function businessSettingFromValue(value: unknown): BusinessPriceSetting | null | undefined {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  if (v.rule !== 'PERCENT_OFF' && v.rule !== 'FIXED') return undefined
  const percent = moneyOrNull(v.percent)
  const price = moneyOrNull(v.price)
  if (percent === undefined || price === undefined) return undefined
  if (v.tiers == null) return { rule: v.rule, percent, price, tiers: null }
  const t = v.tiers as { type?: unknown; levels?: unknown }
  if ((t.type !== 'percent' && t.type !== 'fixed') || !Array.isArray(t.levels)) return undefined
  const levels: Array<{ minQty: number; value: number }> = []
  for (const l of t.levels as Array<Record<string, unknown> | null>) {
    if (!l || typeof l.minQty !== 'number' || typeof l.value !== 'number' || !Number.isFinite(l.minQty) || !Number.isFinite(l.value)) return undefined
    levels.push({ minQty: l.minQty, value: l.value })
  }
  return { rule: v.rule, percent, price, tiers: { type: t.type, levels } }
}

/**
 * One cell through the door. Field stamps (2026-10-13): a version that moved says the LISTING changed — a sale, a stock or
 * price cascade, another cell. When this cell's own field(s) are still what the person saw (`matrixStampHolds`), the write
 * goes ahead at the fresh version and says so (`writtenAt`); when they moved, it is refused with them as they are now
 * (`current`). A write without a stamp (an older client, a verb, a revert) is checked on the version alone, as before.
 * Owner 4A: a Follow Qty cell stamps its mode only, so a typed number pins at itself after a sale moved the follow number.
 */
export async function applyCell(read: MatrixRead, w: MatrixWriteCell, ctx: DoorContext): Promise<MatrixWriteOutcome> {
  const cells = locate(read, w.rowId, w.coordinateKey)?.cells
  const sameListing = !!cells?.listingId && (w.expectedListingId === undefined || cells.listingId === w.expectedListingId)
  if (sameListing && cells!.version !== w.expectedVersion && matrixStampHolds(w.cell, w.expected, cells)) {
    const at = cells!.version
    const out = await applyCellAt(read, { ...w, expectedVersion: at }, ctx)
    // Every outcome that moved a version (applied, or refused after staging) names the version it was checked at.
    return out.outcome === 'applied' || out.listings?.length ? { ...out, writtenAt: at } : out
  }
  return applyCellAt(read, w, ctx)
}

async function applyCellAt(read: MatrixRead, w: MatrixWriteCell, ctx: DoorContext): Promise<MatrixWriteOutcome> {
  const base = { rowId: w.rowId, coordinateKey: w.coordinateKey, cell: w.cell }
  const hit = locate(read, w.rowId, w.coordinateKey)
  /* The caller saw another listing on this coordinate (another account's, or one replaced since): never write over it. */
  if (hit && w.expectedListingId !== undefined && hit.cells.listingId !== w.expectedListingId) return { ...base, outcome: 'conflict', reason: MATRIX_COPY.changedElsewhere, version: hit.cells.version }
  if (!hit || !hit.cells.listingId) return { ...base, outcome: 'refused', reason: PREVIEW_WORDS.notOnMarket, version: hit?.cells.version ?? 0 }
  const { row, coord, cells } = hit
  /* A stamped write lands here only when its stamp did NOT hold: the conflict names the field(s) as they are now. */
  if (cells.version !== w.expectedVersion) {
    const current = w.expected ? matrixCellStamp(w.cell, cells) : undefined
    return { ...base, outcome: 'conflict', reason: MATRIX_COPY.changedElsewhere, version: cells.version, ...(current ? { current } : {}) }
  }
  /* "Sells from" is not one of the cell kinds: its own gate (`cells.source`), its own write. */
  if (w.cell === 'source') return applySource(read, hit, w, ctx)
  if (cells.writable[w.cell] !== true) return { ...base, outcome: 'refused', reason: cells.writeBlockedReason[w.cell] ?? 'This cell cannot be changed here', version: cells.version }
  const refuse = (reason: string): MatrixWriteOutcome => ({ ...base, outcome: 'refused', reason, version: cells.version })
  const noop = (): MatrixWriteOutcome => ({ ...base, outcome: 'noop', version: cells.version })

  const resolved = await targetsOf(read, hit, w.expectedVersion)
  if ('conflict' in resolved) return { ...base, outcome: 'conflict', reason: MATRIX_COPY.changedElsewhere, version: resolved.conflict }
  const { targets, expandedTo } = resolved
  /* `listings`: every row the write moved, at its version after it — the door bumps each target once; the fulfilment and
     price doors answer their own. A refusal after staging moved them too (`staged`). */
  const bumped = (): MatrixListingVersion[] => targets.map((t) => ({ listingId: t.id, productId: row.id, version: t.version + 1 }))
  const moved = (rs: ReadonlyArray<{ listingId: string; productId: string | null; outcome: string; version: number }>): MatrixListingVersion[] =>
    rs.filter((x) => x.outcome === 'applied').map((x) => ({ listingId: x.listingId, productId: x.productId ?? row.id, version: x.version }))
  const applied = (version = cells.version + 1, listings = bumped()): MatrixWriteOutcome => ({ ...base, outcome: 'applied', version, ...(expandedTo ? { expandedTo } : {}), listings })
  const stagedRefusal = (reason: string): MatrixWriteOutcome => ({ ...base, outcome: 'refused', reason, version: cells.version + 1, listings: bumped() })
  const channel = coord.channel as 'AMAZON' | 'EBAY'
  const markets = targets.map((t) => t.marketplace)
  /* Owner rule: FBA quantity is untouchable. An inventory cell lands on every target — on Amazon EU, every open EU row
     of the SKU — and the staging below writes them BEFORE the primitive skips an FBA row. So an Amazon-managed target
     that is a live offer refuses the cell here, with the primitive's own verdict (`amazonManagedListingIds`) and the pin
     step's sentence, and nothing is written: not the FBA row, and not half of the group either. A never-published draft
     (no offer at Amazon) does not vote. */
  const amazonManaged = () => liveAmazonManaged(channel, targets)
  const managedRefusal = (): MatrixWriteOutcome => ({ ...base, outcome: 'refused', reason: MATRIX_COPY.amazonManaged, version: cells.version })

  try {
    switch (w.cell) {
      case 'syncMode': {
        const s = cells.sync; if (!s) return refuse(PREVIEW_WORDS.noStockHere)
        const mode = w.value === 'PINNED' ? 'PINNED' : w.value === 'FOLLOW' ? 'FOLLOW' : null
        if (!mode) return refuse('Mode is Follow or Pinned')
        if (s.mode === mode) return noop()
        /* `writeQuantityMode`: the one implementation the listing screens' follow toggles use too — FBA refused, and a
           PIN on a SKU that sells from another business's stock refused with `sharedStockReason` (shared stock by SKU,
           #230; the read holds the cell with the same sentence). */
        const moded = await writeQuantityMode({ productId: row.id, channel, targets, follow: mode === 'FOLLOW', actor: ctx.actor })
        if (moded.refused) return moded.staged ? stagedRefusal(moded.refused) : refuse(moded.refused)
        return applied()
      }
      case 'syncQty': {
        const s = cells.sync; if (!s) return refuse(PREVIEW_WORDS.noStockHere)
        const n = asInt(w.value)
        if (n == null || n < 0) return refuse('A pinned quantity is a whole number, zero or more')
        /* A pinned row's value is `intended` when the resolver speaks and `held` (the lockstep-written quantity) under a
           pause — measured in the rehearsal: comparing `intended` alone spent a version on a re-pin of a paused row. */
        if (s.mode === 'PINNED' && (s.intended ?? s.held) === n) return noop()
        /* D-MX3: the typed value is staged into `quantity` under CAS; the PIN primitive snapshots exactly that —
           `pinTypedQuantity`, the one implementation the listings grid uses too. */
        const pinned = await pinTypedQuantity({ productId: row.id, channel, targets, quantity: n, actor: ctx.actor })
        if (pinned.refused) return pinned.staged ? stagedRefusal(pinned.refused) : refuse(pinned.refused)
        return applied()
      }
      case 'syncBuffer': {
        const s = cells.sync; if (!s) return refuse(PREVIEW_WORDS.noStockHere)
        const n = asInt(w.value)
        if (n == null || n < 0) return refuse('A buffer is a whole number, zero or more')
        if (s.buffer === n) return noop()
        if (await amazonManaged()) return managedRefusal()
        await bumpTx(targets)
        const r = await setStockBuffer({ productIds: [row.id], channel, markets, buffer: n, actor: ctx.actor, bumpVersion: false })
        if (await skippedLiveFba(channel, r.results)) return stagedRefusal(MATRIX_COPY.amazonManaged)
        return applied()
      }
      case 'fulfilment': {
        const f = cells.fulfilment; if (!f) return refuse('This channel has no fulfilment method')
        const m = w.value === 'FBA' || w.value === 'FBM' || w.value === 'MCF' ? (w.value as FulfilmentMethod) : w.value === null ? null : undefined
        if (m === undefined) return refuse('Fulfilment is FBA, FBM or MCF')
        if (m && !coord.vocabulary.fulfilment?.includes(m)) return refuse(`${m} is not a method on ${coord.label}`)
        /* Amazon (2026-10-07): a real conversion, sent to Amazon and confirmed from its report — only from a confirmed run,
           never a value-only write (`fulfilment-conversion.service.ts`). eBay (MCF) stays Nexus's own, below. */
        if (coord.channel === 'AMAZON') {
          if (!ctx.conversion) return refuse(MATRIX_COPY.fulfilmentViaVerb)
          if (m !== 'FBA' && m !== 'FBM') return refuse('On Amazon the method is FBA or FBM — a conversion needs one of them')
          const r = await convertAmazonFulfilment({ primaryListingId: cells.listingId, targets, to: m, cell: f, actor: ctx.actor, origin: ctx.conversion })
          const mine = r.listings.find((x) => x.listingId === cells.listingId)?.version ?? cells.version
          if (r.outcome === 'noop') return noop()
          if (r.outcome === 'conflict') return { ...base, outcome: 'conflict', reason: MATRIX_COPY.changedElsewhere, version: r.conflictVersion ?? cells.version }
          if (r.outcome === 'refused') return { ...base, outcome: 'refused', reason: r.reason, version: mine, ...(r.listings.length ? { listings: r.listings } : {}) }
          return { ...base, outcome: 'applied', version: mine, ...(r.reason ? { reason: r.reason } : {}), ...(expandedTo ? { expandedTo } : {}), listings: r.listings }
        }
        if (m && f.method === m && f.source === 'set') return noop()
        const typed: FulfilmentWrite = m === null ? null : m === 'MCF' ? 'FBA' : m
        const r = await setFulfillmentMethod({ targets: targets.map((t) => ({ listingId: t.id, method: typed, expectedVersion: t.version })), actor: ctx.actor })
        const mine = r.results.find((x) => x.listingId === cells.listingId) ?? r.results[0]!
        if (mine.outcome === 'applied') return applied(mine.version, moved(r.results))
        return { ...base, outcome: mine.outcome, reason: mine.reason, version: mine.version }
      }
      case 'price': {
        const p = cells.price; if (!p) return refuse(PREVIEW_WORDS.noPriceHere)
        if (!ctx.can(PRICE_PERMISSION)) return refuse(PRICE_PERMISSION_REASON)
        const v = w.value === null ? null : typeof w.value === 'number' ? w.value : Number(w.value)
        // A typed price is above 0, as the price door requires (2026-10-01); rounded with the one cents helper.
        if (v !== null && (!Number.isFinite(v) || v <= 0)) return refuse(PREVIEW_WORDS.priceAboveZero)
        const rounded = v === null ? null : roundCents(v)
        if (rounded !== null && p.value === rounded && p.source === 'override') return noop()
        if (rounded === null && p.source === 'master') return noop()
        /* A-17 (R-12): this read passed the version check above, so its price is the one the operator saw. A verb
           runs row after row on one read; a quantity write in between would otherwise turn a price nobody touched
           into a conflict. A clamped number is not the stored override, so it is never a basis for a retry. */
        const seen = p.clamped ? undefined : p.source === 'override' ? p.value : p.source === 'master' ? null : undefined
        const r = await writeChannelPrices({ targets: [{ listingId: cells.listingId, price: rounded, expectedVersion: cells.version, ...(seen !== undefined ? { expectedPrice: seen } : {}) }], actor: ctx.actor, source: 'MANUAL_OVERRIDE', reason: 'matrix' })
        const mine = r.results[0]!
        return mine.outcome === 'applied' ? applied(mine.version, moved(r.results)) : { ...base, outcome: mine.outcome, reason: mine.reason, version: mine.version }
      }
      /* The Tiers column writes through the same door: its value is the WHOLE setting too (the engine keeps the price
         part as the cell has it), so each column keeps its own round-trip mark. */
      case 'businessPrice':
      case 'businessTiers': {
        if (!cells.business) return refuse(cells.writeBlockedReason[w.cell] ?? cells.writeBlockedReason.businessPrice ?? PREVIEW_WORDS.noPriceHere)
        if (!ctx.can(PRICE_PERMISSION)) return refuse(PRICE_PERMISSION_REASON)
        const setting = businessSettingFromValue(w.value)
        if (setting === undefined) return refuse(BUSINESS_VALUE_REASON)
        /* The business price door: its own CAS on this version, B2B and Amazon's rules, the audit row, and the send to
           Amazon (queued, or kept until the listing can be sent to). Saved with a word (`notSent`, warnings) → said. */
        const r = await writeBusinessPrices({ targets: [{ listingId: cells.listingId, setting, expectedVersion: cells.version }], actor: ctx.actor, reason: 'matrix' })
        const mine = r.results[0]!
        if (mine.outcome !== 'applied') return { ...base, outcome: mine.outcome, ...(mine.reason ? { reason: mine.reason } : {}), version: mine.version }
        const said = [mine.notSent, ...mine.warnings].filter(Boolean).join(' ')
        return { ...base, outcome: 'applied', version: mine.version, ...(said ? { reason: said } : {}), listings: [{ listingId: mine.listingId, productId: mine.productId ?? row.id, version: mine.version }] }
      }
      case 'salePrice': {
        const sale = cells.sale; if (!sale) return refuse('This market has no sale price here')
        if (!ctx.can(PRICE_PERMISSION)) return refuse(PRICE_PERMISSION_REASON)
        const v = (w.value ?? null) as { value?: number | null; start?: string | null; end?: string | null } | null
        const next = { value: v?.value ?? null, start: v?.start ?? null, end: v?.end ?? null }
        if (sale.value === next.value && sale.start === next.start && sale.end === next.end) return noop()
        const r = await writeChannelPrices({ targets: [{ listingId: cells.listingId, sale: next, expectedVersion: cells.version }], actor: ctx.actor, source: 'MANUAL_OVERRIDE', reason: 'matrix' })
        const mine = r.results[0]!
        return mine.outcome === 'applied' ? applied(mine.version, moved(r.results)) : { ...base, outcome: mine.outcome, reason: mine.reason, version: mine.version }
      }
    }
  } catch (err) {
    if (err instanceof Conflict) return { ...base, outcome: 'conflict', reason: MATRIX_COPY.changedElsewhere, version: err.version }
    throw err
  }
  return refuse('This cell cannot be changed here')
}

/**
 * Step 2 — "Sells from": the warehouses a listing sells from, in sale order (Owner 2026-10-07: a default per market for the
 * business, per-product exceptions here; sum only; list order = sale order; Amazon EU = ONE choice for the whole group).
 *   - `inventory.adjust`; the read's own gate (parent, FBA, shared stock) — and FBA and shared stock asked again now;
 *   - the codes: at most 20, never twice, ACTIVE warehouses of this business (read now, stored in their own spelling);
 *   - a list equal to the market default is stored `[]` (an exception exists only when it differs); the same list → noop;
 *   - Amazon EU: the same list on EVERY EU row of the SKU, closed offers included (a reopened market must not sell from
 *     another list), each row version-checked in one transaction (`includeClosed`);
 *   - audited per row (`SyncControlAudit` LISTING · `sourceLocationCodes`), announced (`stockSource`, `quantity`) and
 *     re-pushed in the background (`recascadeAfterSyncControlChange`, the Sync Control route's own re-push).
 */
async function applySource(read: MatrixRead, hit: Located, w: MatrixWriteCell, ctx: DoorContext): Promise<MatrixWriteOutcome> {
  const { row, coord, cells } = hit
  const base = { rowId: w.rowId, coordinateKey: w.coordinateKey, cell: 'source' as const }
  const refuse = (reason: string): MatrixWriteOutcome => ({ ...base, outcome: 'refused', reason, version: cells.version })
  if (!ctx.can(SOURCE_PERMISSION)) return refuse(MATRIX_COPY.sourcePermission)
  const src = cells.source
  if (!src) return refuse(MATRIX_COPY.sourceNone)
  if (!src.writable) return refuse(src.blockedReason ?? MATRIX_COPY.sourceNone)
  if (!Array.isArray(w.value) || w.value.some((c) => typeof c !== 'string')) return refuse('Sells from is a list of location codes')
  const chosen = (w.value as string[]).map((c) => c.trim()).filter(Boolean)
  const warehouses = await prisma.stockLocation.findMany({ where: { type: 'WAREHOUSE' }, select: { code: true, name: true, isActive: true } })
  const problem = sourceCodesProblem(chosen, warehouses.map((l) => ({ code: l.code, name: l.name, active: l.isActive !== false })))
  if (problem) return refuse(problem)
  const spelled = chosen.map((c) => warehouses.find((l) => l.code.trim().toUpperCase() === c.toUpperCase())!.code)
  const to = sellsFromCodes(spelled, src.marketDefault)
  if (sameSourceCodes(to, src.own)) return { ...base, outcome: 'noop', version: cells.version }
  const lender = await sharedStockLender(row.id)
  if (lender) return refuse(sharedStockReason(lender))

  try {
    const resolved = await targetsOf(read, hit, w.expectedVersion, { includeClosed: true })
    if ('conflict' in resolved) return { ...base, outcome: 'conflict', reason: MATRIX_COPY.changedElsewhere, version: resolved.conflict }
    const { targets, expandedTo } = resolved
    if (coord.channel === 'AMAZON' && (await amazonManagedListingIds(targets.map((t) => t.id))).size > 0) return refuse(MATRIX_COPY.sourceFba)
    const before = new Map((await prisma.channelListing.findMany({ where: { id: { in: targets.map((t) => t.id) } }, select: { id: true, sourceLocationCodes: true } })).map((l) => [l.id, l.sourceLocationCodes]))
    await bumpTx(targets, { sourceLocationCodes: to })
    await prisma.syncControlAudit.createMany({
      data: targets.map((t) => ({
        actor: ctx.actor, scopeType: 'LISTING', scopeId: t.id, scopeName: `${row.sku}@${coord.channel}:${t.marketplace}`, field: 'sourceLocationCodes',
        before: { sourceLocationCodes: before.get(t.id) ?? [] }, after: { sourceLocationCodes: to }, reason: 'matrix',
      })),
    }).catch((err) => logger.warn('matrix: sells-from audit write failed', { productId: row.id, error: err instanceof Error ? err.message : String(err) }))
    announceListingValues(targets.map((t) => t.id), ['stockSource', 'quantity'], 'matrix')
    void recascadeAfterSyncControlChange([row.id], ctx.actor).then((r) => logger.info('matrix: recascade after sells-from change', { ...r, productId: row.id, actor: ctx.actor }))
    return { ...base, outcome: 'applied', version: cells.version + 1, ...(expandedTo ? { expandedTo } : {}), listings: targets.map((t) => ({ listingId: t.id, productId: row.id, version: t.version + 1 })) }
  } catch (err) {
    if (err instanceof Conflict) return { ...base, outcome: 'conflict', reason: MATRIX_COPY.changedElsewhere, version: err.version }
    throw err
  }
}

/** The read the door works on: the caller's account, and the caller's price and stock rights (they gate the cells). */
const doorRead = (ctx: DoorContext) =>
  getMatrixRead({ productId: ctx.productId, accountId: ctx.accountId ?? null, canEditPrice: ctx.can(PRICE_PERMISSION), canAdjustStock: ctx.can(SOURCE_PERMISSION) })

/** Every listing's version in a read, before any write of the request. */
function listingVersions(read: MatrixRead): Map<string, number> {
  const out = new Map<string, number>()
  for (const row of read.rows) for (const cells of Object.values(row.cells)) if (cells?.listingId && !out.has(cells.listingId)) out.set(cells.listingId, cells.version)
  return out
}

/** A listing's new version on every coordinate of the read that holds it (a listing can sit under its market and its region). */
function setListingVersion(read: MatrixRead, listingId: string, version: number): void {
  for (const row of read.rows) for (const cells of Object.values(row.cells)) if (cells?.listingId === listingId) cells.version = version
}

/**
 * The one door: every cell write, in order, each CAS-checked on its own listing version; the read is taken once.
 *
 * 🔴 A request is ONE view of the page (a paste, a fill, an undo of several cells): a cell whose listing an EARLIER cell of
 * this request already moved, and that was read at the version the listing had before this request, is checked against
 * the version that earlier cell left — the same person's same view, never "changed elsewhere" against itself (e.g. the B2B
 * price and Tiers of one listing, or its Price and B2B price). A cell read at any other version is still a conflict.
 */
export async function writeMatrixCells(ctx: DoorContext, cells: readonly MatrixWriteCell[]): Promise<MatrixWriteResult> {
  const read = await doorRead(ctx)
  const results: MatrixWriteOutcome[] = []
  const before = listingVersions(read)
  const moved = new Map<string, number>()
  for (const w of cells) {
    const listingId = locate(read, w.rowId, w.coordinateKey)?.cells.listingId ?? null
    const rebased = listingId && moved.has(listingId) && before.get(listingId) === w.expectedVersion
    const outcome = await applyCell(read, rebased ? { ...w, expectedVersion: moved.get(listingId)! } : w, ctx)
    if (outcome.outcome === 'applied') {
      const landed = outcome.listings?.length ? outcome.listings : listingId ? [{ listingId, version: outcome.version }] : []
      for (const l of landed) { moved.set(l.listingId, l.version); setListingVersion(read, l.listingId, l.version) }
    }
    results.push(outcome)
  }
  await refreshCache(read, results)
  return { results, version: read.version }
}

async function refreshCache(read: MatrixRead, results: readonly MatrixWriteOutcome[]): Promise<void> {
  const touched = [...new Set(results.filter((r) => r.outcome === 'applied').map((r) => r.rowId))]
  if (touched.length === 0) return
  await productReadCacheService.refreshMany(touched).catch((err) => logger.warn('matrix: read-cache refresh failed (reconcile cron will heal)', { productId: read.productId, error: err instanceof Error ? err.message : String(err) }))
}

/* ── the state verbs: pause · resume · push now · retry ─────────────────────────────────────── */

/** Retry's row: the newest failed (or dead) quantity or price push of these listings, the one Retry sends again. */
export function newestFailedPush(listingIds: readonly string[]) {
  return prisma.outboundSyncQueue.findFirst({
    where: { channelListingId: { in: [...listingIds] }, syncType: { in: ['QUANTITY_UPDATE', 'PRICE_UPDATE'] }, OR: [{ syncStatus: 'FAILED' }, { isDead: true }] },
    orderBy: { createdAt: 'desc' }, select: { id: true, productId: true, channelListingId: true, targetChannel: true, syncType: true, errorMessage: true },
  })
}

async function applySyncState(read: MatrixRead, change: VerbChange, verb: MatrixVerbId, ctx: DoorContext): Promise<MatrixWriteOutcome> {
  const base = { rowId: change.rowId, coordinateKey: change.coordinateKey, cell: 'syncMode' as MatrixWritableKind }
  const hit = locate(read, change.rowId, change.coordinateKey)
  if (!hit?.cells.sync || !hit.cells.listingId) return { ...base, outcome: 'refused', reason: PREVIEW_WORDS.noStockHere, version: hit?.cells.version ?? 0 }
  const { row, cells, coord } = hit
  if (cells.sync.kind === 'FBA_EXCLUDED') return { ...base, outcome: 'refused', reason: MATRIX_COPY.amazonManaged, version: cells.version }
  const resolved = await targetsOf(read, hit, cells.version)
  if ('conflict' in resolved) return { ...base, outcome: 'conflict', reason: MATRIX_COPY.changedElsewhere, version: resolved.conflict }
  const { targets, expandedTo } = resolved
  /* Every state verb bumps each target once; open sheets and Matrix tabs re-read the Sync cell after commit. */
  const applied = (): MatrixWriteOutcome => {
    announceListingValues(targets.map((t) => t.id), ['syncState'], 'matrix')
    return { ...base, outcome: 'applied', version: cells.version + 1, ...(expandedTo ? { expandedTo } : {}), listings: targets.map((t) => ({ listingId: t.id, productId: row.id, version: t.version + 1 })) }
  }
  const scopeName = (t: Target) => `${row.sku}@${coord.channel}:${t.marketplace}`
  try {
    if (verb === 'pause-sync' || verb === 'resume-sync') {
      const pause = verb === 'pause-sync'
      if (pause && cells.sync.kind === 'PAUSED') return { ...base, outcome: 'noop', version: cells.version }
      if (!pause && cells.sync.kind !== 'PAUSED') return { ...base, outcome: 'noop', version: cells.version }
      if (!pause && cells.sync.via === 'POLICY') return { ...base, outcome: 'refused', reason: 'Held by the channel policy — resuming here changes nothing; resume in Sync Control', version: cells.version }
      await bumpTx(targets, { syncPaused: pause })
      await prisma.syncControlAudit.createMany({ data: targets.map((t) => ({ actor: ctx.actor, scopeType: 'LISTING', scopeId: t.id, scopeName: scopeName(t), field: 'syncPaused', before: { syncPaused: !pause }, after: { syncPaused: pause }, reason: 'matrix' })) }).catch(() => undefined)
      if (!pause) void recascadeAfterSyncControlChange([row.id], ctx.actor).then((r) => logger.info('matrix: recascade after resume', { ...r, actor: ctx.actor }))
      return applied()
    }
    if (verb === 'push-now') {
      const intended = cells.sync.intended
      if (cells.sync.kind === 'PAUSED') return { ...base, outcome: 'refused', reason: 'Paused — resume to push', version: cells.version }
      if (cells.sync.kind === 'CLOSED') return { ...base, outcome: 'refused', reason: MATRIX_COPY.closedHint, version: cells.version }
      if (intended == null) return { ...base, outcome: 'refused', reason: MATRIX_COPY.uncountedHint, version: cells.version }
      const rows = await prisma.$transaction(async (tx) => {
        if (!(await bumpAll(tx, targets, { quantity: intended, lastSyncStatus: 'PENDING' }))) throw new Conflict(cells.version)
        await coalescePendingQuantityRows(tx, targets.map((t) => t.id))
        const listings = await tx.channelListing.findMany({ where: { id: { in: targets.map((t) => t.id) } }, select: { id: true, region: true, externalListingId: true, marketplace: true, channelConnectionId: true, offerClosedAt: true } })
        if (listings.some((l) => l.offerClosedAt)) throw new SellingPaused()
        const out: Array<{ id: string; productId: string | null; syncType: string; holdUntil: Date | null }> = []
        for (const l of listings) {
          const q = await createOutboundRow(tx, {
            data: { productId: row.id, channelListingId: l.id, channelConnectionId: l.channelConnectionId, targetChannel: coord.channel as never, targetRegion: l.region, syncStatus: 'PENDING' as never, syncType: 'QUANTITY_UPDATE', holdUntil: new Date(), externalListingId: l.externalListingId, maxRetries: 3, payload: { quantity: intended, source: 'MATRIX_PUSH_NOW', marketplace: l.marketplace, actor: ctx.actor } },
            select: { id: true, productId: true, syncType: true, holdUntil: true },
          })
          out.push(q)
        }
        return out
      })
      await fireOutboundJobs(rows, { source: 'MATRIX_PUSH_NOW' })
      return applied()
    }
    if (verb === 'retry-sync') {
      const failed = await newestFailedPush(targets.map((t) => t.id))
      if (!failed) return { ...base, outcome: 'refused', reason: PREVIEW_WORDS.nothingToRetry, version: cells.version }
      if (await prisma.channelListing.findFirst({ where: { id: { in: targets.map((t) => t.id) }, offerClosedAt: { not: null } }, select: { id: true } })) throw new SellingPaused()
      await bumpTx(targets)
      /* The explicit row id, never the unscoped bulk route (report 28 §5.4) — the same statement `POST /api/outbound-queue/:id/retry` runs. */
      await prisma.outboundSyncQueue.update({ where: { id: failed.id }, data: { syncStatus: 'PENDING', retryCount: 0, errorMessage: null, errorCode: null, nextRetryAt: null, isDead: false, diedAt: null } })
      await addJobSafely(outboundSyncQueue, 'sync-job', { queueId: failed.id, productId: failed.productId, channelListingId: failed.channelListingId, targetChannel: failed.targetChannel, syncType: failed.syncType }, { jobId: safeJobId(failed.channelListingId, failed.syncType, 'retry', Date.now()) })
      return applied()
    }
  } catch (err) {
    if (err instanceof Conflict) return { ...base, outcome: 'conflict', reason: MATRIX_COPY.changedElsewhere, version: err.version }
    if (err instanceof SellingPaused) return { ...base, outcome: 'refused', reason: SELLING_PAUSED_SENTENCE, version: cells.version }
    throw err
  }
  return { ...base, outcome: 'refused', reason: `${verb} is not a state verb`, version: cells.version }
}

/* ── verbs ──────────────────────────────────────────────────────────────────────────────────── */

const STATE_VERBS = new Set<MatrixVerbId>(['pause-sync', 'resume-sync', 'push-now', 'retry-sync'])

/** Params that make the shared preview reproduce ONE carried change — the server's re-verification of a client-carried preview. */
export function paramsForChange(verb: MatrixVerbId, change: VerbChange): MatrixVerbParams | null {
  switch (verb) {
    case 'set-price': case 'adjust-prices': case 'copy-prices': return typeof change.to === 'number' ? { verb: 'set-price', value: change.to } : null
    case 'pin-quantity': return typeof change.to === 'number' ? { verb: 'pin-quantity', value: change.to } : null
    case 'set-buffer': return typeof change.to === 'number' ? { verb: 'set-buffer', value: change.to } : null
    case 'set-follow': return { verb: 'set-follow' }
    case 'set-fulfilment': return change.to === 'FBA' || change.to === 'FBM' || change.to === 'MCF' ? { verb: 'set-fulfilment', method: change.to } : null
    case 'pause-sync': case 'resume-sync': case 'push-now': case 'retry-sync': return { verb }
    case 'set-source': return Array.isArray(change.to) && change.to.every((c) => typeof c === 'string') ? { verb: 'set-source', codes: [...(change.to as string[])] } : null
  }
}

export type VerbCommitResult = { operation: VerbOperation; results: MatrixWriteOutcome[] }

/**
 * MCP full control L8 — eBay ENDS a listing pinned at 0 unless the account's out-of-stock option is ON. For a pin to 0 on
 * eBay coordinates (a fresh request, or a carried preview), the option is read from eBay ONCE per account and market
 * (`readEbayOutOfStockPreference`: through the channel gateway, bounded, unknown on any failure) and handed to the shared
 * preview, which refuses the pin unless it is ON — in the preview the page shows and in every commit's re-check.
 */
async function ebayZeroAllowed(read: MatrixRead, req: MatrixVerbRequest & { preview?: VerbPreview }): Promise<PreviewContext['ebayZeroAllowed']> {
  const p = req.params as { verb: MatrixVerbId; value?: unknown }
  const zero = p.verb === 'pin-quantity' && (p.value === 0 || (req.preview?.changes ?? []).some((c) => c.cell === 'syncQty' && c.to === 0))
  if (!zero) return undefined
  const pairs = new Map<string, { accountId: string | null; market: string }>()
  for (const t of [...req.targets, ...(req.preview?.changes ?? [])]) {
    const coord = read.coordinates.find((c) => c.key === inventoryCoordinate(read, t.coordinateKey))
    if (coord?.channel === 'EBAY') pairs.set(JSON.stringify([coord.accountId, coord.market]), { accountId: coord.accountId, market: coord.market })
  }
  if (!pairs.size) return undefined
  return ebayZeroAllowedFor(pairs.values())
}

/**
 * The same check for any caller that pins eBay listings or shared variants to 0 (Sync Control for Claude, 08 S7): the
 * account's out-of-stock option, read from eBay ONCE per account and market. true = ON (a pin to 0 is allowed), false =
 * OFF, null = could not be read — both refused, with the Matrix's sentence (`EBAY_ZERO_REFUSAL`).
 */
export async function ebayZeroAllowedFor(pairs: Iterable<{ accountId: string | null; market: string }>): Promise<(accountId: string | null, market: string) => boolean | null> {
  const { readEbayOutOfStockPreference } = await import('../channel-delist.service.js')
  const answers = new Map<string, boolean | null>()
  for (const { accountId, market } of pairs) {
    const key = JSON.stringify([accountId, market])
    if (answers.has(key)) continue
    const state = accountId ? await readEbayOutOfStockPreference(accountId, market) : 'UNKNOWN'
    answers.set(key, state === 'ON' ? true : state === 'OFF' ? false : null)
  }
  return (accountId, market) => answers.get(JSON.stringify([accountId, market])) ?? null
}

/**
 * Amazon fulfilment conversion (2026-10-07) — the server's facts for every Amazon target of a set-fulfilment (a fresh
 * request, or a carried preview), read now (`loadConversionPlan`): the open markets, the Inactive ones, FBA units, an
 * active FBA offer, an Amazon-only code, a draft, a lock, the FBM quantity and the newest conversion. A target whose
 * facts could not be read gets none, and the shared preview refuses it (never sent unchecked).
 */
async function amazonFulfilmentFacts(read: MatrixRead, req: MatrixVerbRequest & { preview?: VerbPreview }): Promise<PreviewContext['amazonFulfilment']> {
  if (req.params.verb !== 'set-fulfilment') return undefined
  const keys = new Map<string, { rowId: string; key: CoordinateKey }>()
  for (const t of [...req.targets, ...(req.preview?.changes ?? [])]) {
    const key = inventoryCoordinate(read, t.coordinateKey)
    if (read.coordinates.find((c) => c.key === key)?.channel !== 'AMAZON') continue
    keys.set(`${t.rowId}|${key}`, { rowId: t.rowId, key })
  }
  const facts = new Map<string, AmazonFulfilmentFacts | null>()
  // The method asked for (a fresh request names it; a carried preview's change holds it): every fixable refusal at once.
  const asked = 'method' in req.params ? req.params.method : req.preview?.changes.find((c) => c.cell === 'fulfilment')?.to
  const to = asked === 'FBA' || asked === 'FBM' ? asked : undefined
  for (const [k, { rowId, key }] of keys) {
    const hit = locate(read, rowId, key)
    if (!hit?.cells.listingId || hit.row.role === 'parent') continue
    try {
      const landed = await targetsOf(read, hit, hit.cells.version)
      facts.set(k, 'conflict' in landed ? null : (await loadConversionPlan({ primaryListingId: hit.cells.listingId, targetIds: landed.targets.map((t) => t.id), to }))?.facts ?? null)
    } catch (err) {
      logger.warn('matrix: Amazon fulfilment facts not read — the target is refused', { rowId, key, error: err instanceof Error ? err.message : String(err) })
      facts.set(k, null)
    }
  }
  return (rowId, key) => facts.get(`${rowId}|${key}`) ?? null
}

export async function runMatrixVerb(ctx: DoorContext, req: MatrixVerbRequest & { preview?: VerbPreview }): Promise<VerbPreview | VerbCommitResult> {
  const read = await doorRead(ctx)
  const pctx: PreviewContext = { can: ctx.can, simulated: false, ebayZeroAllowed: await ebayZeroAllowed(read, req), amazonFulfilment: await amazonFulfilmentFacts(read, req) }
  if (!req.commit) return previewVerb(read, { ...req, commit: false }, pctx)
  const verb = req.params.verb
  /* The page commits with `params: { verb }` + the preview it showed; a caller with full params gets a fresh preview. */
  const carried = req.preview?.changes ?? previewVerb(read, { ...req, commit: false }, pctx).changes

  const before: Array<{ rowId: string; coordinateKey: CoordinateKey; cells: MatrixCells }> = []
  const seen = new Set<string>()
  for (const ch of carried) {
    const k = `${ch.rowId}|${ch.coordinateKey}`
    if (seen.has(k)) continue
    seen.add(k)
    const cells = read.rows.find((r) => r.id === ch.rowId)?.cells[ch.coordinateKey]
    if (cells) before.push({ rowId: ch.rowId, coordinateKey: ch.coordinateKey, cells: JSON.parse(JSON.stringify(cells)) })
  }

  const results: MatrixWriteOutcome[] = []
  for (const ch of carried) {
    const params = paramsForChange(verb, ch)
    const fresh = params ? previewVerb(read, { params, targets: [{ rowId: ch.rowId, coordinateKey: ch.coordinateKey }], commit: false }, pctx) : null
    const same = fresh?.changes.find((c) => c.rowId === ch.rowId && c.coordinateKey === ch.coordinateKey && c.cell === ch.cell && canonical(c.to) === canonical(ch.to))
    if (!same) {
      const reason = fresh?.refusals.find((r) => r.rowId === ch.rowId)?.reason ?? 'Changed since the preview — reload and run the verb again'
      results.push({ rowId: ch.rowId, coordinateKey: ch.coordinateKey, cell: ch.cell === 'syncState' ? 'syncMode' : (ch.cell as MatrixDoorKind), outcome: 'refused', reason, version: read.rows.find((r) => r.id === ch.rowId)?.cells[ch.coordinateKey]?.version ?? 0 })
      continue
    }
    const cells = locate(read, ch.rowId, ch.coordinateKey)?.cells
    const at = cells?.version ?? 0
    const outcome = ch.cell === 'syncState' || STATE_VERBS.has(verb)
      ? await applySyncState(read, ch, verb, ctx)
      : await applyCell(read, { rowId: ch.rowId, coordinateKey: ch.coordinateKey, cell: ch.cell as MatrixDoorKind, value: ch.to, expectedVersion: at }, verb === 'set-fulfilment' ? { ...ctx, conversion: 'matrix-verb' } : ctx)
    if (outcome.outcome === 'applied' && cells) cells.version = outcome.version
    results.push(checkedAt(outcome, at))
  }
  await refreshCache(read, results)

  const applied = results.filter((r) => r.outcome === 'applied').length
  const refused = results.length - applied
  const op = await prisma.bulkOperation.create({
    data: {
      userId: ctx.actor, productCount: new Set(carried.map((c) => c.rowId)).size, changeCount: carried.length,
      changes: { kind: OP_KIND, verb, productId: ctx.productId, before, changes: carried, outcomes: results, phase: 'apply' } as unknown as Prisma.InputJsonValue,
      status: refused > 0 ? 'PARTIAL' : 'COMPLETED', processed: results.length, total: carried.length,
      completedAt: new Date(), expiresAt: new Date(Date.now() + REVERTIBLE_HOURS * 3600_000),
    },
    select: { id: true, createdAt: true },
  })
  return { operation: { id: op.id, verb, appliedAt: op.createdAt.toISOString(), applied, refused, before }, results }
}

/* ── revert: restore by VALUE through the same door ─────────────────────────────────────────── */

export class OperationNotRevertibleError extends Error {
  readonly code = 'operation_not_revertible'
  constructor(readonly statusCode: number, message: string) { super(message); this.name = 'OperationNotRevertibleError' }
}

interface StoredOp { kind?: string; verb?: MatrixVerbId; productId?: string; before?: VerbOperation['before']; changes?: VerbChange[]; outcomes?: MatrixWriteOutcome[]; phase?: string }

/** The part of a cell one restore write puts back — one per kind of change a verb makes. */
export type RestoreField = 'state' | 'fulfilment' | 'quantity' | 'buffer' | 'price' | 'sale' | 'business' | 'source'

/**
 * The cell writes that take `live` back to `before`, in the order the door must run them — of `only` those fields when it
 * is given (a revert puts back what its verb changed, never another field someone else moved since).
 */
export function restoreWrites(rowId: string, key: CoordinateKey, before: MatrixCells, live: MatrixCells, only?: ReadonlySet<RestoreField>): Array<{ kind: 'state'; verb: 'pause-sync' | 'resume-sync' } | { kind: 'cell'; cell: MatrixDoorKind; value: unknown }> {
  const out: Array<{ kind: 'state'; verb: 'pause-sync' | 'resume-sync' } | { kind: 'cell'; cell: MatrixDoorKind; value: unknown }> = []
  const b = before, l = live
  const wants = (field: RestoreField) => !only || only.has(field)
  if (b.sync && l.sync && wants('state')) {
    if (b.sync.kind === 'PAUSED' && b.sync.via === 'LISTING' && l.sync.kind !== 'PAUSED') out.push({ kind: 'state', verb: 'pause-sync' })
    if (b.sync.kind !== 'PAUSED' && l.sync.kind === 'PAUSED' && l.sync.via === 'LISTING') out.push({ kind: 'state', verb: 'resume-sync' })
  }
  /* Amazon: never a value-only fulfilment write — a set-fulfilment is reverted by the opposite CONVERSION (`revertMatrixOperation`). */
  if (b.fulfilment && l.fulfilment && wants('fulfilment') && b.fulfilment.method !== l.fulfilment.method && !isAmazonKey(key)) out.push({ kind: 'cell', cell: 'fulfilment', value: b.fulfilment.source === 'set' ? b.fulfilment.method : null })
  if (b.sync && l.sync && b.sync.kind !== 'FBA_EXCLUDED') {
    if (wants('quantity')) {
      if (b.sync.mode === 'PINNED' && (l.sync.mode !== 'PINNED' || l.sync.intended !== b.sync.intended)) out.push({ kind: 'cell', cell: 'syncQty', value: b.sync.intended ?? b.sync.held ?? 0 })
      else if (b.sync.mode === 'FOLLOW' && l.sync.mode !== 'FOLLOW') out.push({ kind: 'cell', cell: 'syncMode', value: 'FOLLOW' })
    }
    if (wants('buffer') && b.sync.buffer !== l.sync.buffer) out.push({ kind: 'cell', cell: 'syncBuffer', value: b.sync.buffer })
  }
  if (b.price && l.price && b.price.source !== 'formula' && wants('price')) {
    if (b.price.source === 'override' && (l.price.value !== b.price.value || l.price.source !== 'override')) out.push({ kind: 'cell', cell: 'price', value: b.price.value })
    else if (b.price.source === 'master' && l.price.source === 'override') out.push({ kind: 'cell', cell: 'price', value: null })
  }
  if (b.sale && l.sale && wants('sale') && (b.sale.value !== l.sale.value || b.sale.start !== l.sale.start || b.sale.end !== l.sale.end)) out.push({ kind: 'cell', cell: 'salePrice', value: { ...b.sale } })
  /* Amazon Business: the whole setting as it was (`null` = no business offer) — one write, the tiers with it. */
  if (b.business && l.business && wants('business')) {
    const was = businessSettingOfCell(b.business)
    if (canonical(was) !== canonical(businessSettingOfCell(l.business))) out.push({ kind: 'cell', cell: 'businessPrice', value: was })
  }
  /* "Sells from": back to the listing's own list as it was (`[]` = the market default again). */
  if (b.source && l.source && wants('source') && !sameSourceCodes(b.source.own, l.source.own)) out.push({ kind: 'cell', cell: 'source', value: [...b.source.own] })
  void rowId
  return out
}

/** The field a verb's change writes (`restoreWrites`' word for it); null = none to put back (a push, a retry). */
export function restoreFieldOf(change: Pick<VerbChange, 'cell' | 'to'>): RestoreField | null {
  switch (change.cell) {
    case 'syncState': return change.to === 'PAUSED' || change.to === 'FOLLOW' || change.to === 'PINNED' ? 'state' : null
    case 'syncMode': case 'syncQty': return 'quantity'
    case 'syncBuffer': return 'buffer'
    case 'fulfilment': return 'fulfilment'
    case 'price': return 'price'
    case 'salePrice': return 'sale'
    case 'businessPrice': case 'businessTiers': return 'business'
    case 'source': return 'source'
    default: return null
  }
}

/**
 * Does the live cell still hold what this applied change wrote? A revert puts a cell back only then: a newer value — the
 * person's own edit made after the run, or anyone else's — is never written over (`MATRIX_COPY.changedSince`).
 */
export function holdsChange(change: Pick<VerbChange, 'cell' | 'to'>, live: MatrixCells): boolean {
  const to = change.to
  const s = live.sync
  switch (change.cell) {
    case 'price': {
      const p = live.price
      if (!p || p.source !== 'override' || typeof to !== 'number') return false
      // A clamped price shows the floor or the ceiling, not the stored override: it cannot tell, and the version decides.
      return p.clamped != null || p.value === roundCents(to)
    }
    case 'syncQty': return !!s && s.mode === 'PINNED' && (s.intended ?? s.held) === to
    case 'syncMode': return !!s && s.mode === to
    case 'syncBuffer': return !!s && s.buffer === to
    case 'syncState':
      if (!s) return false
      if (to === 'PAUSED') return s.kind === 'PAUSED' && s.via === 'LISTING'
      if (to === 'FOLLOW' || to === 'PINNED') return s.kind !== 'PAUSED'
      return true
    // Amazon: the conversion Nexus sent last is still this one (the method itself changes once Amazon's report confirms it).
    case 'fulfilment': return !!live.fulfilment && (live.fulfilment.method === to || live.fulfilment.conversion?.to === to)
    case 'source': return !!live.source && Array.isArray(to) && sameSourceCodes(to as string[], live.source.own)
    default: return true
  }
}

const isAmazonKey = (key: CoordinateKey): boolean => /^AMAZON:/i.test(key)

/** An applied outcome names the version it was checked at (`writtenAt`): the page records the move as its own. */
const checkedAt = (outcome: MatrixWriteOutcome, version: number): MatrixWriteOutcome =>
  outcome.outcome === 'applied' && outcome.writtenAt === undefined ? { ...outcome, writtenAt: version } : outcome

export async function revertMatrixOperation(ctx: DoorContext, operationId: string): Promise<VerbCommitResult> {
  const op = await prisma.bulkOperation.findUnique({ where: { id: operationId } })
  const stored = (op?.changes && typeof op.changes === 'object' ? op.changes : {}) as StoredOp
  if (!op || stored.kind !== OP_KIND || stored.productId !== ctx.productId) throw new OperationNotRevertibleError(404, 'No Matrix operation with this id on this product')
  if (op.status !== 'COMPLETED' && op.status !== 'PARTIAL') throw new OperationNotRevertibleError(409, `This operation is ${op.status.toLowerCase()} — it can be reverted once, from completed or partial`)
  if (op.expiresAt && op.expiresAt.getTime() <= Date.now()) throw new OperationNotRevertibleError(409, 'This operation is past its revert window')
  const claimed = await prisma.bulkOperation.updateMany({ where: { id: op.id, status: op.status }, data: { status: 'RUNNING' } })
  if (claimed.count !== 1) throw new OperationNotRevertibleError(409, 'This operation is already being reverted')

  const read = await doorRead(ctx)
  const results: MatrixWriteOutcome[] = []
  /* What the run CHANGED, per cell: a carried change and its outcome share their place in the run (one outcome each). An
     operation stored without outcomes counts every carried change. */
  const changed = (stored.changes ?? []).filter((_, i) => !stored.outcomes || stored.outcomes[i]?.outcome === 'applied')
  try {
    for (const b of stored.before ?? []) {
      const hit = locate(read, b.rowId, b.coordinateKey)
      if (!hit) { results.push({ rowId: b.rowId, coordinateKey: b.coordinateKey, cell: 'syncMode', outcome: 'refused', reason: `${PREVIEW_WORDS.notOnMarket} any more`, version: 0 }); continue }
      /* 2026-10-13 (one save line): a cell is put back only while it still holds what the run wrote there. A newer value —
         the person's own edit after the run, or anyone else's — stays, and the cell answers `changedSince`; the other
         cells are still put back. Only the fields the run changed are put back, never another field moved since. */
      const mine = changed.filter((c) => c.rowId === b.rowId && c.coordinateKey === b.coordinateKey)
      const only = new Set<RestoreField>()
      for (const c of mine) {
        const field = restoreFieldOf(c)
        if (!field) continue
        if (holdsChange(c, hit.cells)) { only.add(field); continue }
        results.push({ rowId: b.rowId, coordinateKey: b.coordinateKey, cell: c.cell === 'syncState' ? 'syncMode' : (c.cell as MatrixDoorKind), outcome: 'conflict', reason: MATRIX_COPY.changedSince, version: hit.cells.version })
      }
      /* Amazon fulfilment (2026-10-07): the revert of a conversion that reached Amazon is the OPPOSITE conversion, through
         the same door with fresh checks (refused with the reason when they fail) — never a value-only write. */
      const sent = isAmazonKey(b.coordinateKey) && only.has('fulfilment') ? mine.find((c) => c.cell === 'fulfilment') : undefined
      if (sent) {
        const at = hit.cells.version
        const outcome = await applyCell(read, { rowId: b.rowId, coordinateKey: b.coordinateKey, cell: 'fulfilment', value: sent.to === 'FBA' ? 'FBM' : 'FBA', expectedVersion: at }, { ...ctx, conversion: 'matrix-revert' })
        if (outcome.outcome === 'applied') hit.cells.version = outcome.version
        results.push(checkedAt(outcome, at))
      }
      for (const w of restoreWrites(b.rowId, b.coordinateKey, b.cells, hit.cells, only)) {
        const at = hit.cells.version
        const outcome = w.kind === 'state'
          ? await applySyncState(read, { rowId: b.rowId, sku: hit.row.sku, coordinateKey: b.coordinateKey, cell: 'syncState', from: null, to: null, fromLabel: '', toLabel: '' }, w.verb, ctx)
          : await applyCell(read, { rowId: b.rowId, coordinateKey: b.coordinateKey, cell: w.cell, value: w.value, expectedVersion: at }, ctx)
        if (outcome.outcome === 'applied') hit.cells.version = outcome.version
        results.push(checkedAt(outcome, at))
      }
    }
  } catch (err) {
    await prisma.bulkOperation.update({ where: { id: op.id }, data: { status: 'FAILED', completedAt: new Date(), errors: [{ stage: 'revert', error: err instanceof Error ? err.message : String(err) }] as unknown as Prisma.InputJsonValue } })
    throw err
  }
  await refreshCache(read, results)
  const refused = results.filter((r) => r.outcome === 'refused' || r.outcome === 'conflict').length
  await prisma.bulkOperation.update({
    where: { id: op.id },
    data: { status: refused > 0 ? 'PARTIAL' : 'REVERTED', completedAt: new Date(), processed: results.length, changes: { ...stored, phase: 'revert', revertOutcomes: results } as unknown as Prisma.InputJsonValue },
  })
  return {
    operation: { id: op.id, verb: stored.verb ?? 'set-follow', appliedAt: op.createdAt.toISOString(), applied: results.filter((r) => r.outcome === 'applied').length, refused, before: stored.before ?? [] },
    results,
  }
}
