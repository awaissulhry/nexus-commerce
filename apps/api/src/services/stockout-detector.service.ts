/**
 * R.12 — Stockout ledger service.
 *
 * Two detection paths:
 *   1. Movement-driven (immediate): applyStockMovement calls
 *      handleMovementStockoutTransition() at end of its transaction.
 *      Catches stockouts as they happen.
 *   2. Cron sweep (safety net): nightly walk over StockLevel + open
 *      events. Catches anything the hook missed + refreshes running
 *      loss estimates for ongoing events.
 *
 * Lost-margin math (computeLoss):
 *   estimatedLostUnits   = velocityAtStart × durationDays
 *   estimatedLostRevenue = lostUnits × sellingPriceCents
 *   estimatedLostMargin  = lostUnits × (sellingPrice - unitCost)
 *
 * Edge cases:
 * - velocity = 0: lostUnits = 0 (a SKU that never sold doesn't
 *   "lose" money when out of stock).
 * - unitCost null: marginCents null but revenue still logged.
 * - Negative duration: clamped to 0 (graceful).
 */

import prisma from '../db.js'
import { Prisma } from '@prisma/client'
import { logger } from '../utils/logger.js'

export type DetectorTrigger = 'cron' | 'movement' | 'manual'

// ─── Pure functions ──────────────────────────────────────────────

export function classifyMovement(args: {
  prevAvailable: number
  nextAvailable: number
}): 'STOCKOUT_OPENED' | 'STOCKOUT_CLOSED' | 'NO_TRANSITION' {
  const prev = Math.max(0, args.prevAvailable)
  const next = Math.max(0, args.nextAvailable)
  if (prev > 0 && next === 0) return 'STOCKOUT_OPENED'
  if (prev === 0 && next > 0) return 'STOCKOUT_CLOSED'
  return 'NO_TRANSITION'
}

export interface LossInput {
  velocityAtStart: number
  durationDays: number
  sellingPriceCents: number | null
  unitCostCents: number | null
}

export interface LossResult {
  durationDays: number
  estimatedLostUnits: number
  estimatedLostRevenue: number | null
  estimatedLostMargin: number | null
  marginCentsPerUnit: number | null
}

export function computeLoss(input: LossInput): LossResult {
  const duration = Math.max(0, input.durationDays)
  const v = Math.max(0, input.velocityAtStart)
  const lostUnits = Math.round(v * duration)

  const sell = input.sellingPriceCents ?? null
  const cost = input.unitCostCents ?? null
  const marginCents = sell != null && cost != null ? sell - cost : null

  return {
    durationDays: Number(duration.toFixed(2)),
    estimatedLostUnits: lostUnits,
    estimatedLostRevenue: sell != null ? lostUnits * sell : null,
    estimatedLostMargin: marginCents != null ? lostUnits * marginCents : null,
    marginCentsPerUnit: marginCents,
  }
}

// ─── Snapshot resolver ──────────────────────────────────────────
// Pulls velocity / cost / price for the event at start. Velocity
// comes from DailySalesAggregate (last 30 days mean). Cost prefers
// SupplierProduct over Product.costPrice. Selling price = basePrice.

interface SnapshotInput {
  productId: string
  sku: string
}

interface Snapshot {
  velocityAtStart: number
  unitCostCents: number | null
  sellingPriceCents: number | null
}

async function resolveSnapshot(args: SnapshotInput): Promise<Snapshot> {
  const since = new Date(Date.now() - 30 * 86400_000)
  // Product has no back-relation to ReplenishmentRule (one-way: rule
  // points at product). Query rule separately when costPrice is null.
  const [agg, product, rule] = await Promise.all([
    prisma.dailySalesAggregate.aggregate({
      where: { sku: args.sku, day: { gte: since } },
      _sum: { unitsSold: true },
    }),
    prisma.product.findUnique({
      where: { id: args.productId },
      select: { basePrice: true, costPrice: true },
    }),
    prisma.replenishmentRule.findUnique({
      where: { productId: args.productId },
      select: { preferredSupplierId: true },
    }),
  ])

  const totalSold = agg._sum.unitsSold ?? 0
  const velocity = totalSold / 30

  let unitCostCents: number | null = null
  if (product?.costPrice != null) {
    unitCostCents = Math.round(Number(product.costPrice) * 100)
  } else if (rule?.preferredSupplierId) {
    const sp = await prisma.supplierProduct.findFirst({
      where: { supplierId: rule.preferredSupplierId, productId: args.productId },
      select: { costCents: true },
    })
    if (sp?.costCents != null) unitCostCents = sp.costCents
  }

  const sellingPriceCents = product?.basePrice != null
    ? Math.round(Number(product.basePrice) * 100)
    : null

  return { velocityAtStart: velocity, unitCostCents, sellingPriceCents }
}

// ─── Open / close DB helpers ─────────────────────────────────────

export async function openStockoutEvent(args: {
  productId: string
  sku: string
  locationId: string | null
  detectedBy: DetectorTrigger
}): Promise<{ id: string; alreadyOpen: boolean } | null> {
  // Idempotent: short-circuit if an open event for this scope already exists.
  const existing = await prisma.stockoutEvent.findFirst({
    where: { productId: args.productId, locationId: args.locationId, endedAt: null },
    select: { id: true },
  })
  if (existing) return { id: existing.id, alreadyOpen: true }

  const snap = await resolveSnapshot({ productId: args.productId, sku: args.sku })
  try {
    const created = await prisma.stockoutEvent.create({
      data: {
        productId: args.productId,
        sku: args.sku,
        locationId: args.locationId,
        startedAt: new Date(),
        detectedBy: args.detectedBy,
        velocityAtStart: snap.velocityAtStart,
        unitCostCents: snap.unitCostCents,
        sellingPriceCents: snap.sellingPriceCents,
        marginCentsPerUnit:
          snap.sellingPriceCents != null && snap.unitCostCents != null
            ? snap.sellingPriceCents - snap.unitCostCents
            : null,
      },
      select: { id: true },
    })
    return { id: created.id, alreadyOpen: false }
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // Race: another caller opened the event a moment earlier. Re-read.
      const refreshed = await prisma.stockoutEvent.findFirst({
        where: { productId: args.productId, locationId: args.locationId, endedAt: null },
        select: { id: true },
      })
      if (refreshed) return { id: refreshed.id, alreadyOpen: true }
    }
    logger.warn('stockout-detector: open failed', {
      productId: args.productId,
      locationId: args.locationId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

export async function closeStockoutEvent(args: {
  productId: string
  locationId: string | null
  closedBy: DetectorTrigger
}): Promise<{ id: string; loss: LossResult } | null> {
  const open = await prisma.stockoutEvent.findFirst({
    where: { productId: args.productId, locationId: args.locationId, endedAt: null },
  })
  if (!open) return null

  const now = new Date()
  const durationDays = (now.getTime() - open.startedAt.getTime()) / 86400_000
  const loss = computeLoss({
    velocityAtStart: Number(open.velocityAtStart),
    durationDays,
    sellingPriceCents: open.sellingPriceCents,
    unitCostCents: open.unitCostCents,
  })

  await prisma.stockoutEvent.update({
    where: { id: open.id },
    data: {
      endedAt: now,
      closedBy: args.closedBy,
      durationDays: loss.durationDays,
      estimatedLostUnits: loss.estimatedLostUnits,
      estimatedLostRevenue: loss.estimatedLostRevenue,
      estimatedLostMargin: loss.estimatedLostMargin,
    },
  })
  return { id: open.id, loss }
}

// ─── Movement-driven hook ───────────────────────────────────────
// Called from applyStockMovement after the transaction commits.
// Failures must not block the movement — log + continue.

export async function handleMovementStockoutTransition(args: {
  productId: string
  sku: string
  locationId: string | null
  prevAvailable: number
  nextAvailable: number
}): Promise<void> {
  if (process.env.NEXUS_ENABLE_STOCKOUT_DETECTOR === '0') return

  const transition = classifyMovement({
    prevAvailable: args.prevAvailable,
    nextAvailable: args.nextAvailable,
  })
  if (transition === 'NO_TRANSITION') return

  try {
    if (transition === 'STOCKOUT_OPENED') {
      await openStockoutEvent({
        productId: args.productId,
        sku: args.sku,
        locationId: args.locationId,
        detectedBy: 'movement',
      })
    } else {
      await closeStockoutEvent({
        productId: args.productId,
        locationId: args.locationId,
        closedBy: 'movement',
      })
    }
  } catch (err) {
    logger.warn('stockout-detector: movement hook failed', {
      productId: args.productId,
      transition,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// ─── Cron sweep ─────────────────────────────────────────────────

export async function runStockoutSweep(): Promise<{
  opened: number
  closed: number
  updatedRunning: number
  durationMs: number
}> {
  const start = Date.now()

  // 1. Find StockLevel rows currently at 0 with no open event.
  const zeroLevels = await prisma.stockLevel.findMany({
    where: { available: 0 },
    select: { productId: true, locationId: true, product: { select: { sku: true } } },
  })

  let opened = 0
  for (const sl of zeroLevels) {
    const r = await openStockoutEvent({
      productId: sl.productId,
      sku: sl.product.sku,
      locationId: sl.locationId,
      detectedBy: 'cron',
    })
    if (r && !r.alreadyOpen) opened++
  }

  // 2. Find open events whose level is now > 0.
  const openEvents = await prisma.stockoutEvent.findMany({
    where: { endedAt: null },
    select: { productId: true, locationId: true },
  })
  let closed = 0
  for (const ev of openEvents) {
    if (ev.locationId == null) continue
    const sl = await prisma.stockLevel.findFirst({
      where: { productId: ev.productId, locationId: ev.locationId },
      select: { available: true },
    })
    if (sl && sl.available > 0) {
      await closeStockoutEvent({
        productId: ev.productId,
        locationId: ev.locationId,
        closedBy: 'cron',
      })
      closed++
    }
  }

  // 3. Refresh running loss estimates for events still open after step 2.
  const stillOpen = await prisma.stockoutEvent.findMany({
    where: { endedAt: null },
  })
  let updatedRunning = 0
  const now = Date.now()
  for (const ev of stillOpen) {
    const durationDays = (now - ev.startedAt.getTime()) / 86400_000
    const loss = computeLoss({
      velocityAtStart: Number(ev.velocityAtStart),
      durationDays,
      sellingPriceCents: ev.sellingPriceCents,
      unitCostCents: ev.unitCostCents,
    })
    await prisma.stockoutEvent.update({
      where: { id: ev.id },
      data: {
        durationDays: loss.durationDays,
        estimatedLostUnits: loss.estimatedLostUnits,
        estimatedLostRevenue: loss.estimatedLostRevenue,
        estimatedLostMargin: loss.estimatedLostMargin,
      },
    })
    updatedRunning++
  }

  return { opened, closed, updatedRunning, durationMs: Date.now() - start }
}

// ─── Read helpers ────────────────────────────────────────────────

export async function getStockoutSummary(args: { windowDays?: number } = {}) {
  const windowDays = args.windowDays ?? 30
  const since = new Date(Date.now() - windowDays * 86400_000)

  const [open, closedInWindow, agg] = await Promise.all([
    prisma.stockoutEvent.count({ where: { endedAt: null } }),
    prisma.stockoutEvent.count({ where: { startedAt: { gte: since } } }),
    prisma.stockoutEvent.aggregate({
      where: { startedAt: { gte: since } },
      _sum: {
        durationDays: true,
        estimatedLostUnits: true,
        estimatedLostRevenue: true,
        estimatedLostMargin: true,
      },
    }),
  ])

  // Worst single SKU (longest duration in window)
  const worst = await prisma.stockoutEvent.findFirst({
    where: { startedAt: { gte: since }, durationDays: { not: null } },
    orderBy: { durationDays: 'desc' },
    select: { sku: true, durationDays: true, estimatedLostMargin: true, locationId: true },
  })

  return {
    windowDays,
    openCount: open,
    eventsInWindow: closedInWindow,
    totalDurationDays: agg._sum.durationDays != null ? Number(agg._sum.durationDays) : 0,
    totalLostUnits: agg._sum.estimatedLostUnits ?? 0,
    totalLostRevenueCents: agg._sum.estimatedLostRevenue ?? 0,
    totalLostMarginCents: agg._sum.estimatedLostMargin ?? 0,
    worstSku: worst,
  }
}

export async function listStockoutEvents(args: {
  status?: 'open' | 'closed' | 'all'
  limit?: number
  // S.29 — extended filters for the stockout history report.
  locationId?: string
  sku?: string
  sinceDays?: number
}) {
  const limit = Math.max(1, Math.min(500, args.limit ?? 50))
  const where: any = {}
  if (args.status === 'open') where.endedAt = null
  else if (args.status === 'closed') where.endedAt = { not: null }
  if (args.locationId) where.locationId = args.locationId
  if (args.sku) where.sku = { contains: args.sku, mode: 'insensitive' }
  if (args.sinceDays && args.sinceDays > 0) {
    where.startedAt = { gte: new Date(Date.now() - args.sinceDays * 86400_000) }
  }
  const rows = await prisma.stockoutEvent.findMany({
    where,
    orderBy: { startedAt: 'desc' },
    take: limit,
    include: { location: { select: { code: true, name: true } } },
  })
  return { items: rows, count: rows.length }
}
