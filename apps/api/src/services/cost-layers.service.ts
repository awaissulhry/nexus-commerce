/**
 * S.20 — Cost layers service.
 *
 * Single entrypoint for COGS-correct inventory accounting.
 *
 *   receiveLayer({ productId, units, unitCost, ... })
 *     Creates a StockCostLayer for a receive event (PO inbound,
 *     manual restock, transfer-in). Updates Product.weightedAvgCost-
 *     Cents when method=WAC. FIFO/LIFO methods record the layer
 *     untouched.
 *
 *   consume({ productId, units }) → cogsCents
 *     Computes the COGS for a stock-out event (order ship, write-off)
 *     using the product's costingMethod. FIFO/LIFO deplete
 *     StockCostLayer.unitsRemaining oldest-first / newest-first; WAC
 *     simply returns weightedAvgCostCents × units.
 *
 *   getCurrentCost(productId) → unit cents
 *     Reads the product's "current cost" using its method:
 *     FIFO → oldest open layer; LIFO → newest open layer; WAC →
 *     Product.weightedAvgCostCents.
 *
 *   recomputeWac(productId)
 *     Sums every layer (units × unitCost) and divides by total
 *     unitsRemaining. Used after a backfill or method switch.
 */

import prisma from '../db.js'
import type { Prisma } from '@prisma/client'
import { logger } from '../utils/logger.js'

export type CostingMethod = 'FIFO' | 'LIFO' | 'WAC'
type Tx = Prisma.TransactionClient

export interface ReceiveLayerArgs {
  productId: string
  variationId?: string
  locationId?: string
  unitsReceived: number
  /** Per-unit cost in cents. The breakdown fields are sub-categories
   *  of this total — caller can pass either or both. When the
   *  breakdown is supplied without a total, we derive it. */
  unitCostCents?: number
  freightCents?: number
  dutyCents?: number
  insuranceCents?: number
  brokerCents?: number
  /** T.6 — supplier-invoice currency (ISO-4217). Defaults to EUR.
   *  When != EUR, exchangeRate is required and unitCostCents is
   *  expected to already be EUR-converted at exchangeRate. */
  costCurrency?: string
  /** Rate from costCurrency to base (EUR) at receivedAt. Required
   *  when costCurrency != 'EUR' (DB CHECK enforces). */
  exchangeRate?: number
  inboundShipmentId?: string
  stockMovementId?: string
  notes?: string
  /** Override receivedAt for backfill / replay. Defaults to now. */
  receivedAt?: Date
}

/**
 * Tx-aware variant. Caller supplies a Prisma transaction client;
 * applyStockMovement uses this from inside its outer transaction so
 * the layer write rolls back atomically with the stock-level update.
 */
export async function receiveLayerInTx(tx: Tx, args: ReceiveLayerArgs): Promise<{
  layerId: string
  newWacCents: number
}> {
  const {
    productId, variationId, locationId, unitsReceived,
    inboundShipmentId, stockMovementId, notes, receivedAt,
  } = args
  if (unitsReceived <= 0) {
    throw new Error('receiveLayer: unitsReceived must be > 0')
  }

  // Compute the per-unit total. If the operator passed a breakdown
  // without a total, sum the components. If both are passed, prefer
  // the explicit total (the breakdown might be for reporting only).
  const breakdownSum =
    (args.freightCents ?? 0) +
    (args.dutyCents ?? 0) +
    (args.insuranceCents ?? 0) +
    (args.brokerCents ?? 0)
  const unitCostCents = args.unitCostCents ?? breakdownSum
  if (!Number.isFinite(unitCostCents) || unitCostCents < 0) {
    throw new Error('receiveLayer: unit cost must be a non-negative integer (cents)')
  }
  const unitCost = unitCostCents / 100

  const costCurrency = (args.costCurrency ?? 'EUR').toUpperCase()
  if (costCurrency !== 'EUR' && (args.exchangeRate == null || args.exchangeRate <= 0)) {
    throw new Error(`receiveLayer: exchangeRate required when costCurrency=${costCurrency}`)
  }

  const layer = await tx.stockCostLayer.create({
    data: {
      productId,
      variationId: variationId ?? null,
      locationId: locationId ?? null,
      unitCost,
      unitsReceived,
      unitsRemaining: unitsReceived,
      freightCents: args.freightCents ?? null,
      dutyCents: args.dutyCents ?? null,
      insuranceCents: args.insuranceCents ?? null,
      brokerCents: args.brokerCents ?? null,
      costCurrency,
      exchangeRateOnReceive: args.exchangeRate ?? null,
      inboundShipmentId: inboundShipmentId ?? null,
      stockMovementId: stockMovementId ?? null,
      notes: notes ?? null,
      ...(receivedAt ? { receivedAt } : {}),
    },
    select: { id: true },
  })

  const wac = await computeWacInTx(tx, productId)
  await tx.product.update({
    where: { id: productId },
    data: { weightedAvgCostCents: wac },
  })
  return { layerId: layer.id, newWacCents: wac }
}

/**
 * Create a cost layer for a receive event (top-level entrypoint —
 * opens its own transaction). Use receiveLayerInTx when calling
 * from inside an existing tx (e.g. applyStockMovement).
 */
export async function receiveLayer(args: ReceiveLayerArgs): Promise<{
  layerId: string
  newWacCents: number
}> {
  return await prisma.$transaction((tx) => receiveLayerInTx(tx, args))
}

/**
 * Compute Weighted Average Cost in cents over every open layer.
 * Returns 0 when no open layers exist (matches the pre-S.20 default
 * for products that have never received stock).
 */
async function computeWacInTx(tx: Tx, productId: string): Promise<number> {
  const layers = await tx.stockCostLayer.findMany({
    where: { productId, unitsRemaining: { gt: 0 } },
    select: { unitsRemaining: true, unitCost: true },
  })
  let totalUnits = 0
  let weightedCents = 0
  for (const l of layers) {
    totalUnits += l.unitsRemaining
    weightedCents += l.unitsRemaining * Math.round(Number(l.unitCost) * 100)
  }
  return totalUnits === 0 ? 0 : Math.round(weightedCents / totalUnits)
}

export async function recomputeWac(productId: string): Promise<number> {
  return await prisma.$transaction(async (tx) => {
    const wac = await computeWacInTx(tx, productId)
    await tx.product.update({
      where: { id: productId },
      data: { weightedAvgCostCents: wac },
    })
    return wac
  })
}

/**
 * Consume `units` from a product's cost layers using its costing
 * method. Returns the COGS for the consumption in cents. Caller
 * stores this on StockMovement.cogsCents.
 *
 * Idempotency: this is NOT idempotent — call exactly once per
 * stock-out event. The applyStockMovement guard ensures change is
 * applied once, and consumeLayers fires from there.
 */
export interface ConsumeArgs {
  productId: string
  units: number
  /** Optional movement link for audit. */
  stockMovementId?: string
}
export interface ConsumeResult {
  cogsCents: number
  layersTouched: number
  detail: Array<{ layerId: string; unitsTaken: number; unitCostCents: number }>
}

export async function consumeLayersInTx(tx: Tx, args: ConsumeArgs): Promise<ConsumeResult> {
  const { productId, units } = args
  if (units <= 0) throw new Error('consumeLayers: units must be > 0')

  const product = await tx.product.findUnique({
    where: { id: productId },
    select: { costingMethod: true, weightedAvgCostCents: true },
  })
  if (!product) throw new Error(`consumeLayers: product not found (${productId})`)
  const method = (product.costingMethod ?? 'WAC') as CostingMethod

  // WAC: COGS = wac × units. Still deplete layers oldest-first so
  // unitsRemaining reports stay accurate.
  if (method === 'WAC') {
    const wac = product.weightedAvgCostCents ?? 0
    const layers = await tx.stockCostLayer.findMany({
      where: { productId, unitsRemaining: { gt: 0 } },
      orderBy: { receivedAt: 'asc' },
    })
    let remaining = units
    const detail: ConsumeResult['detail'] = []
    for (const l of layers) {
      if (remaining <= 0) break
      const take = Math.min(remaining, l.unitsRemaining)
      await tx.stockCostLayer.update({
        where: { id: l.id },
        data: { unitsRemaining: l.unitsRemaining - take },
      })
      detail.push({ layerId: l.id, unitsTaken: take, unitCostCents: Math.round(Number(l.unitCost) * 100) })
      remaining -= take
    }
    const newWac = await computeWacInTx(tx, productId)
    await tx.product.update({
      where: { id: productId },
      data: { weightedAvgCostCents: newWac },
    })
    return { cogsCents: units * wac, layersTouched: detail.length, detail }
  }

  // FIFO/LIFO: walk layers in receive order.
  const layers = await tx.stockCostLayer.findMany({
    where: { productId, unitsRemaining: { gt: 0 } },
    orderBy: { receivedAt: method === 'FIFO' ? 'asc' : 'desc' },
  })
  let remaining = units
  let cogsCents = 0
  const detail: ConsumeResult['detail'] = []
  for (const l of layers) {
    if (remaining <= 0) break
    const take = Math.min(remaining, l.unitsRemaining)
    const unitCostCents = Math.round(Number(l.unitCost) * 100)
    cogsCents += take * unitCostCents
    detail.push({ layerId: l.id, unitsTaken: take, unitCostCents })
    await tx.stockCostLayer.update({
      where: { id: l.id },
      data: { unitsRemaining: l.unitsRemaining - take },
    })
    remaining -= take
  }
  // Negative-stock fallback: gap consumed at WAC.
  if (remaining > 0 && product.weightedAvgCostCents != null) {
    cogsCents += remaining * product.weightedAvgCostCents
  }
  const newWac = await computeWacInTx(tx, productId)
  await tx.product.update({
    where: { id: productId },
    data: { weightedAvgCostCents: newWac },
  })
  return { cogsCents, layersTouched: detail.length, detail }
}

/**
 * Top-level entrypoint (own transaction). Use consumeLayersInTx
 * when calling from inside an existing tx.
 */
export async function consumeLayers(args: ConsumeArgs): Promise<ConsumeResult> {
  return await prisma.$transaction((tx) => consumeLayersInTx(tx, args))
}

/**
 * Operator-friendly "what does this product cost right now?" query.
 * FIFO returns the oldest open layer's cost (next unit to ship);
 * LIFO returns the newest. WAC returns the rolling avg.
 */
export async function getCurrentCost(productId: string): Promise<number> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { costingMethod: true, weightedAvgCostCents: true },
  })
  if (!product) return 0
  const method = (product.costingMethod ?? 'WAC') as CostingMethod
  if (method === 'WAC') return product.weightedAvgCostCents ?? 0

  const layer = await prisma.stockCostLayer.findFirst({
    where: { productId, unitsRemaining: { gt: 0 } },
    orderBy: { receivedAt: method === 'FIFO' ? 'asc' : 'desc' },
    select: { unitCost: true },
  })
  return layer ? Math.round(Number(layer.unitCost) * 100) : (product.weightedAvgCostCents ?? 0)
}

/** Per-product layer history — used by the drawer audit section. */
export async function listLayers(productId: string, limit = 100): Promise<Array<{
  id: string
  receivedAt: Date
  unitCostCents: number
  unitsReceived: number
  unitsRemaining: number
  freightCents: number | null
  dutyCents: number | null
  insuranceCents: number | null
  brokerCents: number | null
  inboundShipmentId: string | null
  stockMovementId: string | null
  notes: string | null
  locationCode: string | null
}>> {
  const rows = await prisma.stockCostLayer.findMany({
    where: { productId },
    orderBy: { receivedAt: 'desc' },
    take: Math.min(500, Math.max(1, limit)),
    include: { location: { select: { code: true } } },
  })
  return rows.map((r) => ({
    id: r.id,
    receivedAt: r.receivedAt,
    unitCostCents: Math.round(Number(r.unitCost) * 100),
    unitsReceived: r.unitsReceived,
    unitsRemaining: r.unitsRemaining,
    freightCents: r.freightCents,
    dutyCents: r.dutyCents,
    insuranceCents: r.insuranceCents,
    brokerCents: r.brokerCents,
    inboundShipmentId: r.inboundShipmentId,
    stockMovementId: r.stockMovementId,
    notes: r.notes,
    locationCode: r.location?.code ?? null,
  }))
}
