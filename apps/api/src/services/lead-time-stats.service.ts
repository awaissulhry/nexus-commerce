/**
 * R.11 — Lead-time stats service.
 *
 * Nightly cron computes per-supplier mean + std dev of observed
 * lead times (PO createdAt → InboundShipment.arrivedAt). Persists
 * to Supplier.leadTimeStdDevDays / leadTimeSampleCount /
 * leadTimeStatsUpdatedAt so the hot replenishment path can read
 * one column instead of joining shipment history per request.
 *
 * Why createdAt → arrivedAt (not expectedDeliveryDate → arrivedAt):
 * we want the variance the operator should buffer for. The promise
 * (expectedDeliveryDate) is what Supplier.leadTimeDays already
 * reflects; σ_LT measures real-world delivery jitter against that
 * promise.
 *
 * History window: 365 days back. Enough to smooth seasonal lead-
 * time shifts (e.g. Q4 customs delays), short enough that an
 * improving supplier shows up in the stats within a year.
 *
 * Min sample count: 3. With n<3, sample std dev is too noisy to
 * trust — we leave leadTimeStdDevDays NULL so the math layer
 * collapses to R.4 deterministic-LT behavior.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { computeLeadTimeStats } from './replenishment-math.service.js'

export const HISTORY_DAYS = 365
export const MIN_SAMPLE_COUNT = 3

export interface RecomputeSummary {
  suppliersScanned: number
  suppliersUpdated: number
  suppliersWithSufficientHistory: number
  errorCount: number
  durationMs: number
}

/**
 * Pull observed (createdAt → arrivedAt) lead times in days for one
 * supplier. Returns days clipped to [0, 365] — wildly negative or
 * absurd values are typically data entry errors and shouldn't
 * pollute the stats.
 */
export async function getObservedLeadTimes(
  supplierId: string,
  windowDays: number = HISTORY_DAYS,
): Promise<number[]> {
  const since = new Date(Date.now() - windowDays * 86400_000)
  // Pull POs with at least one InboundShipment that has arrivedAt.
  const pos = await prisma.purchaseOrder.findMany({
    where: { supplierId, createdAt: { gte: since } },
    select: {
      createdAt: true,
      inboundShipments: {
        where: { arrivedAt: { not: null } },
        select: { arrivedAt: true },
        orderBy: { arrivedAt: 'asc' },
        take: 1, // first arrival = realised lead time
      },
    },
  })

  const days: number[] = []
  for (const po of pos) {
    const arrived = po.inboundShipments[0]?.arrivedAt
    if (!arrived) continue
    const ms = arrived.getTime() - po.createdAt.getTime()
    const d = ms / 86400_000
    if (!Number.isFinite(d)) continue
    if (d < 0 || d > 365) continue // clip outliers
    days.push(d)
  }
  return days
}

/**
 * Recompute stats for one supplier and write to the row. Returns
 * the new stats. When the sample is too thin, writes NULL stdDev
 * so the math layer degrades gracefully.
 */
export async function recomputeLeadTimeStatsForSupplier(supplierId: string): Promise<{
  count: number
  mean: number
  stdDev: number | null
}> {
  const observed = await getObservedLeadTimes(supplierId)
  const stats = computeLeadTimeStats(observed)
  const stdDevToWrite = stats.count >= MIN_SAMPLE_COUNT && stats.stdDev > 0
    ? stats.stdDev
    : null

  await prisma.supplier.update({
    where: { id: supplierId },
    data: {
      leadTimeStdDevDays: stdDevToWrite,
      leadTimeSampleCount: stats.count,
      leadTimeStatsUpdatedAt: new Date(),
    },
  })

  return {
    count: stats.count,
    mean: stats.mean,
    stdDev: stdDevToWrite,
  }
}

/**
 * Cron entry point. Walks every active supplier, recomputes stats.
 * Idempotent — same inputs produce same outputs.
 */
export async function recomputeAllLeadTimeStats(): Promise<RecomputeSummary> {
  const start = Date.now()
  const suppliers = await prisma.supplier.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
  })

  let updated = 0
  let withHistory = 0
  let errors = 0
  for (const s of suppliers) {
    try {
      const r = await recomputeLeadTimeStatsForSupplier(s.id)
      updated++
      if (r.count >= MIN_SAMPLE_COUNT) withHistory++
    } catch (err) {
      errors++
      logger.warn('lead-time-stats: per-supplier failed', {
        supplierId: s.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    suppliersScanned: suppliers.length,
    suppliersUpdated: updated,
    suppliersWithSufficientHistory: withHistory,
    errorCount: errors,
    durationMs: Date.now() - start,
  }
}

/**
 * Read-side helper: latest stats summary for the dashboard surface.
 */
export async function getLeadTimeStatsStatus() {
  const lastUpdated = await prisma.supplier.findFirst({
    where: { leadTimeStatsUpdatedAt: { not: null } },
    orderBy: { leadTimeStatsUpdatedAt: 'desc' },
    select: { leadTimeStatsUpdatedAt: true },
  })
  const counts = await prisma.supplier.groupBy({
    by: ['isActive'],
    where: { isActive: true },
    _count: { id: true },
    _avg: { leadTimeSampleCount: true },
  })
  const withSigma = await prisma.supplier.count({
    where: { isActive: true, leadTimeStdDevDays: { not: null } },
  })
  return {
    lastUpdatedAt: lastUpdated?.leadTimeStatsUpdatedAt ?? null,
    activeSupplierCount: counts[0]?._count.id ?? 0,
    avgSampleCount: counts[0]?._avg.leadTimeSampleCount ?? 0,
    suppliersWithSigma: withSigma,
    historyWindowDays: HISTORY_DAYS,
    minSampleCount: MIN_SAMPLE_COUNT,
  }
}
