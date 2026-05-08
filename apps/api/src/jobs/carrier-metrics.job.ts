/**
 * CR.23 — daily CarrierMetric pre-warm.
 *
 * The Performance tab in the carrier drawer (CR.15) computes its
 * stats live by walking Shipment + Order rows for the requested
 * window. That's fine at single-warehouse volume; it'll be a noisy
 * read at scale. CR.3 added the CarrierMetric table specifically to
 * absorb this load. CR.23 finally populates it.
 *
 * Each day at 03:00 (between CR.12's catalog sync at 02:00 and CR.21's
 * pickup dispatch at 04:00):
 *   1. For each Carrier row, for each window in {30, 90, 365}:
 *      a. Aggregate Shipment counts + cost + on-time/late from the
 *         window.
 *      b. Median delivery hours when sample size ≥ 5 (smaller samples
 *         make noisy medians; null is honest).
 *      c. Upsert CarrierMetric on (carrierId, windowDays).
 *   2. The Performance endpoint can switch to reading from
 *      CarrierMetric when present + falling back to live aggregation
 *      when stale or missing — that switch lands as a follow-up
 *      tweak so this commit stays focused on the cron.
 *
 * Idempotency: upsert on (carrierId, windowDays) — same day's run
 * overwrites the prior value cleanly.
 *
 * Per-carrier failures don't fail the run. Per-window failures don't
 * fail the carrier.
 *
 * Default-ON via NEXUS_ENABLE_CARRIER_METRICS_CRON; the cost is small
 * and the value is real once volume picks up.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastRowCount = 0
let lastError: string | null = null

const WINDOWS = [30, 90, 365] as const
const MEDIAN_MIN_SAMPLES = 5

/** Median of a numeric array. Caller must have non-empty input. */
function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

/** One full sweep. Exposed for manual invocation. */
export async function runCarrierMetricsSweep(): Promise<{
  carriersScanned: number
  rowsUpserted: number
}> {
  const carriers = await prisma.carrier.findMany({ select: { id: true, code: true } })
  let upserted = 0

  for (const carrier of carriers) {
    for (const windowDays of WINDOWS) {
      try {
        const since = new Date(Date.now() - windowDays * 86400000)
        const shipments = await prisma.shipment.findMany({
          where: { carrierCode: carrier.code as any, createdAt: { gte: since } },
          select: {
            costCents: true,
            shippedAt: true,
            deliveredAt: true,
            order: { select: { shipByDate: true } },
          },
        })

        let totalCost = 0
        let costSamples = 0
        let onTime = 0
        let late = 0
        let exceptions = 0
        const deliveryHours: number[] = []

        for (const s of shipments) {
          if (s.costCents != null) {
            totalCost += s.costCents
            costSamples++
          }
          if (s.shippedAt && s.order?.shipByDate) {
            if (s.shippedAt.getTime() > s.order.shipByDate.getTime()) late++
            else onTime++
          }
          if (s.deliveredAt && s.shippedAt) {
            deliveryHours.push((s.deliveredAt.getTime() - s.shippedAt.getTime()) / 3_600_000)
          }
        }

        const medianHours = deliveryHours.length >= MEDIAN_MIN_SAMPLES
          ? median(deliveryHours)
          : null

        await prisma.carrierMetric.upsert({
          where: {
            carrierId_windowDays: { carrierId: carrier.id, windowDays },
          },
          create: {
            carrierId: carrier.id,
            windowDays,
            shipmentCount: shipments.length,
            totalCostCents: totalCost,
            avgCostCents: costSamples > 0 ? Math.round(totalCost / costSamples) : null,
            onTimeCount: onTime,
            lateCount: late,
            exceptionCount: exceptions,
            medianDeliveryHours: medianHours,
          },
          update: {
            shipmentCount: shipments.length,
            totalCostCents: totalCost,
            avgCostCents: costSamples > 0 ? Math.round(totalCost / costSamples) : null,
            onTimeCount: onTime,
            lateCount: late,
            exceptionCount: exceptions,
            medianDeliveryHours: medianHours,
            computedAt: new Date(),
          },
        })
        upserted++
      } catch (err) {
        logger.warn('carrier-metrics: window failed', {
          carrierCode: carrier.code,
          windowDays,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  lastRunAt = new Date()
  lastRowCount = upserted
  lastError = null
  if (upserted > 0) {
    logger.info('carrier-metrics: complete', {
      carriersScanned: carriers.length,
      rowsUpserted: upserted,
    })
  }
  return { carriersScanned: carriers.length, rowsUpserted: upserted }
}

export function startCarrierMetricsCron(): void {
  if (process.env.NEXUS_ENABLE_CARRIER_METRICS_CRON === '0') {
    logger.info('carrier-metrics cron: disabled by env')
    return
  }
  if (scheduledTask) {
    logger.warn('carrier-metrics cron already started — skipping')
    return
  }
  const schedule = process.env.NEXUS_CARRIER_METRICS_SCHEDULE ?? '0 3 * * *'
  if (!cron.validate(schedule)) {
    logger.error('carrier-metrics cron: invalid schedule expression', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void runCarrierMetricsSweep().catch((err) => {
      lastError = err instanceof Error ? err.message : String(err)
      logger.error('carrier-metrics cron: failure', { error: lastError })
    })
  })
  logger.info('carrier-metrics cron: scheduled', { schedule })
}

export function stopCarrierMetricsCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getCarrierMetricsStatus(): {
  scheduled: boolean
  lastRunAt: Date | null
  lastRowCount: number
  lastError: string | null
} {
  return {
    scheduled: scheduledTask !== null,
    lastRunAt,
    lastRowCount,
    lastError,
  }
}

export const __test = { median }
