/**
 * MCP full control 08 S6 — set a product's absolute on-hand at ONE location (the products grid cell, the inventory
 * editor and Claude's set-stock). Moved as it was out of routes/stock.routes.ts (stock-change.vitest.test.ts holds the
 * routes' answers): a fresh server-side read, the delta derived here, never from the caller; FBA and Shopify locations
 * are read-only (computeLocationAdjustment); one audited movement through applyStockMovementInTx.
 *
 * Step 3 (cases): the stock editor also sends the absolute SEALED case counts of the same cell, per case size
 * (`cases: [{ unitsPerCase, cases }]`; sizes not named keep theirs). Units and cases
 * of one cell run in ONE transaction under the product's stock lock: the fresh read sits inside the lock, the unit
 * movement first, then `setCasesInTx` checks the count against the NEW units. A refused count rolls the units back too,
 * so the cell is either saved whole or not at all. A caller that sends no `cases` (Claude's set-stock, the products-grid
 * cell) gets the same answer as before.
 *
 * Expected base: a caller sends the on-hand it SAW (`expected`) with the new value, and the fresh read inside the
 * lock is checked against it (checkSeenOnHand, location-adjustment.ts): a sale that landed while the person typed
 * refuses the save (STALE_ON_HAND, with the current number) instead of being overwritten. The Stock page's FBM cell
 * (`setFbmOnHand`) follows the same rule over the product's non-FBA total.
 */
import prisma from '../../db.js'
import { afterStockMovementCommit, applyStockMovementInTx, type StockMovementTxResult } from '../stock-movement.service.js'
import { checkSeenOnHand, computeLocationAdjustment, LocationAdjustmentError } from '../location-adjustment.js'
import { summarizeProductStock } from '../stock-summary.js'
import { lockProductStock } from '../stock-lock.js'
import { setCasesInTx } from './stock-cases.service.js'
import type { CaseCount } from '@nexus/shared/stock-cases'

export const ALLOWED_ADJUST_REASONS = ['MANUAL_ADJUSTMENT', 'INVENTORY_COUNT', 'WRITE_OFF'] as const
export type AdjustReason = (typeof ALLOWED_ADJUST_REASONS)[number]
export const adjustReasonOf = (raw: unknown): AdjustReason =>
  (ALLOWED_ADJUST_REASONS as readonly string[]).includes(String(raw ?? '')) ? (raw as AdjustReason) : 'MANUAL_ADJUSTMENT'

export class NoLocationError extends Error { code = 'NO_LOCATION' as const }

export interface AdjustOneLocationInput {
  productId: string
  locationId: string
  /** The absolute on-hand. Omitted = leave the units as they are (a case-only count); at least one of value/cases. */
  value?: number
  /** The on-hand the caller saw when it chose `value` (checkSeenOnHand). Omitted = no check, as before. */
  expected?: number
  /** Step 3 — the absolute sealed case counts at this location, per named size. Omitted = leave the cases as they are. */
  cases?: CaseCount[]
  reason: AdjustReason
  notes?: string
  actor: string
}

export async function adjustOneLocation(input: AdjustOneLocationInput) {
  const { productId, locationId, value, expected, cases, reason, notes, actor } = input
  const location = await prisma.stockLocation.findUnique({ where: { id: locationId }, select: { type: true } })
  if (!location) throw new NoLocationError('Location not found')

  const done = await prisma.$transaction(async (tx) => {
    // The stock lock FIRST, then the fresh read: a sale that lands between the read and the write can no longer make
    // the derived delta wrong (it waits for this transaction, or this one reads after it).
    await lockProductStock(tx, [productId])
    let moved: StockMovementTxResult | null = null
    // A case-only count (`value` omitted) moves no units. Without `cases` the value is required, as before.
    if (value !== undefined || cases === undefined) {
      const existing = await tx.stockLevel.findFirst({
        where: { locationId, productId, variationId: null },
        select: { quantity: true, reserved: true },
      })
      const adj = computeLocationAdjustment({
        locationType: location.type,
        currentQuantity: existing?.quantity ?? 0,
        currentReserved: existing?.reserved ?? 0,
        value: value as number,
        expected,
      })
      if (!adj.noop) moved = await applyStockMovementInTx(tx, { productId, locationId, change: adj.change, reason, notes, actor })
    }
    // Checked against the units AFTER the movement above; a refusal (CaseCountError) rolls the units back with it.
    const counted = cases === undefined ? null : await setCasesInTx(tx, { productId, locationId, cases, reason, notes, actor })
    return { moved, counted }
  })
  // Post-commit only: the instant push, the stockout hook and the read-cache refresh of the movement.
  if (done.moved) await afterStockMovementCommit({ productId, reason }, done.moved)

  // Recompute the product's split so a grid cell can reconcile.
  const levels = await prisma.stockLevel.findMany({
    where: { productId },
    select: { quantity: true, reserved: true, available: true, locationId: true, location: { select: { type: true } } },
  })
  const totals = summarizeProductStock(levels.map((l) => ({ locationType: l.location.type, quantity: l.quantity })))
  const level = levels.find((l) => l.locationId === locationId)
  return {
    noop: !done.moved && (done.counted?.noop ?? true),
    movement: (done.moved?.movement ?? null) as unknown,
    totals,
    quantity: level?.quantity ?? 0,
    reserved: level?.reserved ?? 0,
    available: level?.available ?? 0,
    /** Only when the call named `cases`: the sealed counts after it, every size (absent otherwise — the answer as before). */
    ...(done.counted ? { cases: done.counted.after } : {}),
  }
}

/** The FBA / FBM split the Stock page shows: on-hand units, FBA = Amazon's mirror (read-only), FBM = every other location. */
function splitOf(levels: Array<{ quantity: number; location: { type: string } }>) {
  const { fbaStock, fbmStock } = summarizeProductStock(levels.map((l) => ({ locationType: l.location.type, quantity: l.quantity })))
  return { fbaStock, fbmStock }
}

export type FbmOnHandCode = 'NO_FBM_BUCKET' | 'INSUFFICIENT_BUCKET' | 'STALE_ON_HAND'
export class FbmOnHandError extends Error {
  /** STALE_ON_HAND only: the numbers the server holds now. */
  stock?: { fbaStock: number; fbmStock: number }
  constructor(readonly code: FbmOnHandCode, message: string, stock?: { fbaStock: number; fbmStock: number }) {
    super(message)
    if (stock) this.stock = stock
  }
}

/** The bucket a non-FBA total change lands on: WAREHOUSE first, then SHOPIFY_LOCATION, then CHANNEL_RESERVED; the biggest of a type. */
const FBM_BUCKET_PRIORITY: Record<string, number> = { WAREHOUSE: 0, SHOPIFY_LOCATION: 1, CHANNEL_RESERVED: 2 }

/**
 * M.3 — the Stock page's FBM cell (`PATCH /api/products/:id/fbm-stock`): the new non-FBA on-hand TOTAL (`value`, with
 * the total the person saw as `expected` — the same rule as adjustOneLocation, checkSeenOnHand), or a signed `change`.
 * Moved here from products.routes.ts so the read sits inside the stock lock with the write. The delta lands on one
 * bucket (FBM_BUCKET_PRIORITY); a decrease bigger than that bucket is refused (INSUFFICIENT_BUCKET). FBA is never written.
 */
export async function setFbmOnHand(input: { productId: string; value?: number; change?: number; expected?: number; reason: string; notes?: string; actor: string }) {
  const { productId, notes, actor } = input
  const reason = input.reason as never
  const done = await prisma.$transaction(async (tx) => {
    await lockProductStock(tx, [productId])
    const levels = await tx.stockLevel.findMany({
      where: { productId },
      select: { quantity: true, location: { select: { id: true, type: true, code: true } } },
    })
    const fbmLevels = levels.filter((sl) => sl.location.type !== 'AMAZON_FBA')
    if (fbmLevels.length === 0) throw new FbmOnHandError('NO_FBM_BUCKET', 'This product has no FBM StockLevel. Add a warehouse bucket first.')
    const before = splitOf(levels)
    let change: number
    if (input.value !== undefined) {
      const target = Math.max(0, Math.floor(input.value))
      try {
        checkSeenOnHand({ current: before.fbmStock, expected: input.expected, value: target })
      } catch (error) {
        if (error instanceof LocationAdjustmentError && error.code === 'STALE_ON_HAND') throw new FbmOnHandError('STALE_ON_HAND', error.message, before)
        throw error
      }
      change = target - before.fbmStock
    } else {
      change = Math.floor(input.change as number)
    }
    if (change === 0) return { moved: null, before }
    const bucket = [...fbmLevels].sort((a, b) =>
      (FBM_BUCKET_PRIORITY[a.location.type] ?? 99) - (FBM_BUCKET_PRIORITY[b.location.type] ?? 99) || b.quantity - a.quantity)[0]
    // Removing more than the bucket holds is refused: the person spreads the decrease per location on the Stock page.
    if (change < 0 && bucket.quantity + change < 0) {
      throw new FbmOnHandError('INSUFFICIENT_BUCKET', `Cannot reduce ${bucket.location.code} below 0 — currently ${bucket.quantity}. Adjust per-location on /fulfillment/stock.`)
    }
    const moved = await applyStockMovementInTx(tx, { productId, locationId: bucket.location.id, change, reason, notes, actor })
    return { moved, before }
  })
  if (!done.moved) return { noChange: true as const, movement: null, ...done.before }
  await afterStockMovementCommit({ productId, reason }, done.moved)
  const after = await prisma.stockLevel.findMany({ where: { productId }, select: { quantity: true, location: { select: { type: true } } } })
  return { noChange: false as const, movement: done.moved.movement as unknown, ...splitOf(after) }
}

/** The note on every Pause movement: the reason a person reads in the stock history. */
export const PAUSE_NOTE = 'Paused (Pause Listings on the FBA page): sellable own-warehouse stock set to 0; reserved units kept'

/**
 * The FBA page's "Pause Listings" (`POST /api/stock/pause`, /products/fba): a real, recorded stock change. Every own
 * WAREHOUSE level of the chosen products — and of their variations, which are child products — is set to its reserved
 * count, so nothing is left to sell: one audited MANUAL_ADJUSTMENT movement per level (PAUSE_NOTE), and the movement's
 * cascade sends 0 to every listing that follows stock. Units reserved for open orders stay. Amazon FBA units are never
 * written (Amazon's number), nor Shopify locations (Shopify's). Each level is its own transaction with the stock lock
 * taken before the fresh read, so a sale landing meanwhile is kept, never overwritten. A level already at 0 sellable
 * books nothing, so pausing twice books nothing.
 */
export async function pauseOwnStock(input: { productIds: string[]; actor: string }) {
  const ids = [...new Set(input.productIds.filter((id) => typeof id === 'string' && id.length > 0))]
  const found = ids.length ? await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true } }) : []
  const roots = found.map((p) => p.id)
  const children = roots.length ? await prisma.product.findMany({ where: { parentId: { in: roots } }, select: { id: true } }) : []
  const productIds = [...new Set([...roots, ...children.map((c) => c.id)])]
  const levels = productIds.length
    ? await prisma.stockLevel.findMany({
        where: { productId: { in: productIds }, variationId: null, location: { type: 'WAREHOUSE' } },
        select: { productId: true, locationId: true },
      })
    : []
  let movements = 0
  let units = 0
  for (const { productId, locationId } of levels) {
    const moved = await prisma.$transaction(async (tx) => {
      await lockProductStock(tx, [productId])
      const now = await tx.stockLevel.findFirst({ where: { productId, locationId, variationId: null }, select: { quantity: true, reserved: true } })
      if (!now || now.quantity <= now.reserved) return null
      const adj = computeLocationAdjustment({ locationType: 'WAREHOUSE', currentQuantity: now.quantity, currentReserved: now.reserved, value: now.reserved })
      if (adj.noop) return null
      return applyStockMovementInTx(tx, { productId, locationId, change: adj.change, reason: 'MANUAL_ADJUSTMENT', notes: PAUSE_NOTE, actor: input.actor })
    })
    if (!moved) continue
    await afterStockMovementCommit({ productId, reason: 'MANUAL_ADJUSTMENT' }, moved)
    movements += 1
    units += -(moved.movement as { change: number }).change
  }
  return { products: roots.length, notFound: ids.length - roots.length, variations: productIds.length - roots.length, movements, units }
}
