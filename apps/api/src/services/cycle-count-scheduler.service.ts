/**
 * S.17 — ABC-driven recurring cycle-count scheduler.
 *
 * Best-in-class inventory teams count their high-velocity items more
 * often than the long tail. This service schedules a per-product
 * cadence based on Product.abcClass (S.16):
 *
 *   A — every 7 days   (top 80% of revenue — highest exposure)
 *   B — every 30 days  (next 15%)
 *   C — every 90 days  (sales-active tail)
 *   D — every 180 days (zero sales — rare check still valuable)
 *
 * Override the defaults via NEXUS_ABC_CADENCE_DAYS env var, e.g.
 * NEXUS_ABC_CADENCE_DAYS="A=7,B=30,C=90,D=180".
 *
 * Each daily cron run picks up products whose last count
 * (CycleCountItem joined back to CycleCount where status COMPLETED)
 * is older than their cadence, and creates a single DRAFT
 * CycleCount session at the target location with those items
 * pre-populated. The operator then starts and counts as usual.
 *
 * If no product is due, no session is created — the cron is a no-op.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'

const DEFAULT_CADENCE_DAYS: Record<'A' | 'B' | 'C' | 'D', number> = {
  A: 7,
  B: 30,
  C: 90,
  D: 180,
}

/** Parse `NEXUS_ABC_CADENCE_DAYS=A=7,B=30,C=90,D=180`. Tolerant —
 *  malformed entries fall back to defaults. */
export function getCadenceConfig(): Record<'A' | 'B' | 'C' | 'D', number> {
  const raw = process.env.NEXUS_ABC_CADENCE_DAYS
  if (!raw) return DEFAULT_CADENCE_DAYS
  const cfg = { ...DEFAULT_CADENCE_DAYS }
  for (const pair of raw.split(',')) {
    const [k, v] = pair.split('=').map((s) => s.trim())
    const cls = k as 'A' | 'B' | 'C' | 'D'
    const days = Number(v)
    if (cfg[cls] != null && Number.isFinite(days) && days > 0) {
      cfg[cls] = Math.floor(days)
    }
  }
  return cfg
}

export interface ScheduleResult {
  generatedAt: Date
  locationId: string
  cadenceDays: Record<'A' | 'B' | 'C' | 'D', number>
  due: { A: number; B: number; C: number; D: number; uncategorised: number }
  sessionId: string | null   // null when nothing due
  itemCount: number
  durationMs: number
}

/**
 * Identify products at the given location whose ABC-driven cadence
 * has elapsed since their last completed count (or which have never
 * been counted). Returns at most `limit` items so a single session
 * stays manageable on the warehouse floor; the cron picks the rest
 * up tomorrow.
 */
export async function findDueForCount(args: {
  locationId: string
  cadence?: Record<'A' | 'B' | 'C' | 'D', number>
  limit?: number
}): Promise<{
  productId: string
  variationId: string | null
  sku: string
  quantity: number
  abcClass: 'A' | 'B' | 'C' | 'D' | null
  lastCountedAt: Date | null
}[]> {
  const cadence = args.cadence ?? getCadenceConfig()
  const limit = Math.min(500, Math.max(1, args.limit ?? 100))

  const stockLevels = await prisma.stockLevel.findMany({
    where: { locationId: args.locationId },
    select: {
      productId: true,
      variationId: true,
      quantity: true,
      product: { select: { sku: true, abcClass: true } },
    },
  })
  if (stockLevels.length === 0) return []

  // Last completed count per product at this location. Single batched
  // query; we read every CycleCountItem joined to a COMPLETED count
  // for the location, then keep the freshest reconciledAt per product.
  const productIds = stockLevels.map((s) => s.productId)
  const lastCounts = await prisma.cycleCountItem.findMany({
    where: {
      productId: { in: productIds },
      reconciledAt: { not: null },
      cycleCount: { locationId: args.locationId, status: 'COMPLETED' },
    },
    orderBy: { reconciledAt: 'desc' },
    select: { productId: true, variationId: true, reconciledAt: true },
  })
  const lastBy = new Map<string, Date>()
  for (const c of lastCounts) {
    const key = `${c.productId}:${c.variationId ?? ''}`
    if (!lastBy.has(key)) lastBy.set(key, c.reconciledAt!)
  }

  const now = Date.now()
  const due: ReturnType<typeof findDueForCount> extends Promise<infer T> ? T : never = []
  for (const sl of stockLevels) {
    const cls = (sl.product.abcClass ?? null) as 'A' | 'B' | 'C' | 'D' | null
    // Uncategorised products (never been ABC-classified) inherit C
    // cadence — sufficient for the long-tail default.
    const cadenceDays = cls ? cadence[cls] : cadence.C
    const key = `${sl.productId}:${sl.variationId ?? ''}`
    const last = lastBy.get(key) ?? null
    const ageDays = last == null ? Number.POSITIVE_INFINITY : (now - last.getTime()) / 86400000
    if (ageDays >= cadenceDays) {
      due.push({
        productId: sl.productId,
        variationId: sl.variationId,
        sku: sl.product.sku,
        quantity: sl.quantity,
        abcClass: cls,
        lastCountedAt: last,
      })
    }
    if (due.length >= limit) break
  }

  // Sort: A first (highest priority), then never-counted items, then
  // oldest count first within each class.
  due.sort((a, b) => {
    const order = { A: 0, B: 1, C: 2, D: 3, null: 4 } as Record<string, number>
    const ac = order[a.abcClass ?? 'null']
    const bc = order[b.abcClass ?? 'null']
    if (ac !== bc) return ac - bc
    const at = a.lastCountedAt?.getTime() ?? 0
    const bt = b.lastCountedAt?.getTime() ?? 0
    return at - bt
  })

  return due
}

/**
 * Cron entrypoint. Resolves the target location (defaults to IT-MAIN),
 * finds due items, and if any exist, creates a DRAFT CycleCount with
 * those items and a notes field describing the schedule.
 *
 * Idempotency: if a DRAFT or IN_PROGRESS cycle count already exists at
 * the location with notes='auto-scheduled', we skip — the operator
 * hasn't worked through the previous batch yet, so piling on a second
 * session would just add noise.
 */
export async function scheduleAutoCount(args: {
  locationCode?: string
  cadence?: Record<'A' | 'B' | 'C' | 'D', number>
  limit?: number
}): Promise<ScheduleResult> {
  const startedAt = Date.now()
  const code = args.locationCode ?? 'IT-MAIN'
  const location = await prisma.stockLocation.findUnique({
    where: { code },
    select: { id: true, code: true },
  })
  if (!location) throw new Error(`scheduleAutoCount: location ${code} not found`)
  const cadence = args.cadence ?? getCadenceConfig()

  // Idempotency guard.
  const existing = await prisma.cycleCount.findFirst({
    where: {
      locationId: location.id,
      status: { in: ['DRAFT', 'IN_PROGRESS'] as any },
      notes: { startsWith: 'auto-scheduled' },
    },
    select: { id: true },
  })
  if (existing) {
    return {
      generatedAt: new Date(),
      locationId: location.id,
      cadenceDays: cadence,
      due: { A: 0, B: 0, C: 0, D: 0, uncategorised: 0 },
      sessionId: null,
      itemCount: 0,
      durationMs: Date.now() - startedAt,
    }
  }

  const due = await findDueForCount({ locationId: location.id, cadence, limit: args.limit })
  if (due.length === 0) {
    return {
      generatedAt: new Date(),
      locationId: location.id,
      cadenceDays: cadence,
      due: { A: 0, B: 0, C: 0, D: 0, uncategorised: 0 },
      sessionId: null,
      itemCount: 0,
      durationMs: Date.now() - startedAt,
    }
  }

  const counts = { A: 0, B: 0, C: 0, D: 0, uncategorised: 0 }
  for (const d of due) {
    if (d.abcClass) counts[d.abcClass]++
    else counts.uncategorised++
  }

  const noteSummary = `auto-scheduled (A=${counts.A} B=${counts.B} C=${counts.C} D=${counts.D} U=${counts.uncategorised})`
  const session = await prisma.$transaction(async (tx) => {
    const cc = await tx.cycleCount.create({
      data: {
        locationId: location.id,
        status: 'DRAFT',
        notes: noteSummary,
        createdBy: 'system:abc-scheduler',
      },
    })
    await tx.cycleCountItem.createMany({
      data: due.map((d) => ({
        cycleCountId: cc.id,
        productId: d.productId,
        variationId: d.variationId,
        sku: d.sku,
        expectedQuantity: d.quantity,
        status: 'PENDING' as const,
      })),
    })
    return cc
  })

  logger.info('cycle-count-scheduler: session created', {
    locationCode: location.code,
    sessionId: session.id,
    itemCount: due.length,
    counts,
  })

  return {
    generatedAt: new Date(),
    locationId: location.id,
    cadenceDays: cadence,
    due: counts,
    sessionId: session.id,
    itemCount: due.length,
    durationMs: Date.now() - startedAt,
  }
}
