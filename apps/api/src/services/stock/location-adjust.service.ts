/**
 * MCP full control 08 S6 — set a product's absolute on-hand at ONE location (the products grid cell, the inventory
 * editor and Claude's set-stock). Moved as it was out of routes/stock.routes.ts (stock-change.vitest.test.ts holds the
 * routes' answers): a fresh server-side read, the delta derived here, never from the caller; FBA and Shopify locations
 * are read-only (computeLocationAdjustment); one audited movement through applyStockMovement.
 */
import prisma from '../../db.js'
import { applyStockMovement } from '../stock-movement.service.js'
import { computeLocationAdjustment } from '../location-adjustment.js'
import { summarizeProductStock } from '../stock-summary.js'

export const ALLOWED_ADJUST_REASONS = ['MANUAL_ADJUSTMENT', 'INVENTORY_COUNT', 'WRITE_OFF'] as const
export type AdjustReason = (typeof ALLOWED_ADJUST_REASONS)[number]
export const adjustReasonOf = (raw: unknown): AdjustReason =>
  (ALLOWED_ADJUST_REASONS as readonly string[]).includes(String(raw ?? '')) ? (raw as AdjustReason) : 'MANUAL_ADJUSTMENT'

export class NoLocationError extends Error { code = 'NO_LOCATION' as const }

export async function adjustOneLocation(input: { productId: string; locationId: string; value: number; reason: AdjustReason; notes?: string; actor: string }) {
  const { productId, locationId, value, reason, notes, actor } = input
  const location = await prisma.stockLocation.findUnique({ where: { id: locationId }, select: { type: true } })
  if (!location) throw new NoLocationError('Location not found')

  // Fresh server-side read → delta derived here, never from the client.
  const existing = await prisma.stockLevel.findFirst({
    where: { locationId, productId, variationId: null },
    select: { quantity: true, reserved: true },
  })
  const currentQuantity = existing?.quantity ?? 0
  const currentReserved = existing?.reserved ?? 0
  const adj = computeLocationAdjustment({ locationType: location.type, currentQuantity, currentReserved, value })

  let movement: unknown = null
  if (!adj.noop) {
    movement = await applyStockMovement({ productId, locationId, change: adj.change, reason, notes, actor })
  }
  // Recompute the product's split so a grid cell can reconcile.
  const levels = await prisma.stockLevel.findMany({
    where: { productId },
    select: { quantity: true, reserved: true, available: true, locationId: true, location: { select: { type: true } } },
  })
  const totals = summarizeProductStock(levels.map((l) => ({ locationType: l.location.type, quantity: l.quantity })))
  const level = levels.find((l) => l.locationId === locationId)
  return { noop: adj.noop, movement, totals, quantity: level?.quantity ?? 0, reserved: level?.reserved ?? 0, available: level?.available ?? 0 }
}
