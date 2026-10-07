/**
 * MCP full control 08 S6 — set a product's absolute on-hand at ONE location (the products grid cell, the inventory
 * editor and Claude's set-stock). Moved as it was out of routes/stock.routes.ts (stock-change.vitest.test.ts holds the
 * routes' answers): a fresh server-side read, the delta derived here, never from the caller; FBA and Shopify locations
 * are read-only (computeLocationAdjustment); one audited movement through applyStockMovementInTx.
 *
 * Step 3 (cases): the stock editor also sends the absolute SEALED case count of the same cell (`cases`). Units and cases
 * of one cell run in ONE transaction under the product's stock lock: the fresh read sits inside the lock, the unit
 * movement first, then `setCasesInTx` checks the count against the NEW units. A refused count rolls the units back too,
 * so the cell is either saved whole or not at all. A caller that sends no `cases` (Claude's set-stock, the products-grid
 * cell) gets the same answer as before.
 */
import prisma from '../../db.js'
import { afterStockMovementCommit, applyStockMovementInTx, type StockMovementTxResult } from '../stock-movement.service.js'
import { computeLocationAdjustment } from '../location-adjustment.js'
import { summarizeProductStock } from '../stock-summary.js'
import { lockProductStock } from '../stock-lock.js'
import { setCasesInTx } from './stock-cases.service.js'

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
  /** Step 3 — the absolute sealed case count at this location. Omitted = leave the cases as they are. */
  cases?: number
  reason: AdjustReason
  notes?: string
  actor: string
}

export async function adjustOneLocation(input: AdjustOneLocationInput) {
  const { productId, locationId, value, cases, reason, notes, actor } = input
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
    /** Only when the call named `cases`: the sealed count after it (absent otherwise — the answer as before). */
    ...(done.counted ? { cases: done.counted.after } : {}),
  }
}
