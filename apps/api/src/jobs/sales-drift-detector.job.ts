/**
 * DA-RT.5 — Sales drift detector cron.
 *
 * Compares the two local stores of "what we sold on day X in
 * marketplace Y":
 *
 *   A. Order.totalPrice sum (per the snapshot's MS.6 + GS-RT.3
 *      reconciliation endpoint logic)
 *   B. DailySalesAggregate.grossRevenue sum (per F.1 + DA-RT.2 —
 *      already TZ-aware + apportionment-corrected as of DA-RT.2)
 *
 * When the absolute delta exceeds tolerance (max(€1, 0.5%)), publishes
 * `sales.drift.detected` on the order-events bus + logs a warning.
 * Existing notification + global alert banner machinery (RT.16/17)
 * surfaces the event to the operator.
 *
 * Scope (this cron)
 * -----------------
 * - Looks back 7 days (configurable via env). Today's day is
 *   intentionally excluded because the aggregate cron hasn't
 *   necessarily run yet and intraday drift is expected (orders
 *   continue to land; aggregate stays one tick behind).
 * - Schedule: every 03:30 UTC by default — runs AFTER the Amazon
 *   T+1 report ingest (~03:00) AND after sales-aggregate-refresh
 *   so both stores are settled before comparison.
 * - Per (day, marketplace) tuple. Days with zero orders on both
 *   sides are skipped silently.
 *
 * Gated behind NEXUS_ENABLE_SALES_DRIFT_DETECTOR=1 (default OFF
 * during rollout).
 *
 * Future (DA-RT.10): add a third store comparison —
 * AmazonFinancialEvents.shipmentItem — for 3-way agreement.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { publishOrderEvent } from '../services/order-events.service.js'

const OPERATOR_TIMEZONE = 'Europe/Rome'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

/** YYYY-MM-DD for the local-tz calendar date of `d`. Matches GA-RT.1
 *  + DA-RT.2's helpers so day keys align across the codebase. */
function isoLocalDay(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: OPERATOR_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

function toleranceFor(maxCents: number): number {
  // max(€1, 0.5% of max). €1 floor catches near-empty days where
  // 0.5% would be unhelpfully small.
  return Math.max(100, Math.round(maxCents * 0.005))
}

export async function runSalesDriftDetector(): Promise<void> {
  try {
    await recordCronRun('sales-drift-detector', async () => {
      const lookbackDays = Number(
        process.env.NEXUS_SALES_DRIFT_LOOKBACK_DAYS ?? 7,
      )
      const lookback =
        Number.isFinite(lookbackDays) && lookbackDays > 0 ? lookbackDays : 7

      // Date window: last N days NOT including today. End-exclusive
      // = local midnight today (Europe/Rome).
      const now = new Date()
      const todayIso = isoLocalDay(now)
      const dayRangeEnd = new Date(`${todayIso}T00:00:00Z`)
      const dayRangeStart = new Date(
        dayRangeEnd.getTime() - lookback * 24 * 60 * 60_000,
      )

      // Pull both stores' per-(day, marketplace) sums in TZ-aware
      // buckets so the keys line up exactly.
      const [orderRows, aggregateRows] = await Promise.all([
        prisma.$queryRaw<
          Array<{ day: Date; marketplace: string | null; cents: bigint }>
        >`
          SELECT
            date_trunc('day', "purchaseDate" AT TIME ZONE 'Europe/Rome')::date AS day,
            "marketplace",
            COALESCE(SUM(ROUND("totalPrice" * 100)), 0)::bigint AS cents
          FROM "Order"
          WHERE "deletedAt" IS NULL
            AND "channel" = 'AMAZON'
            AND "currencyCode" = 'EUR'
            AND "status" != 'CANCELLED'
            AND "purchaseDate" >= ${dayRangeStart}
            AND "purchaseDate" <  ${dayRangeEnd}
          GROUP BY day, "marketplace"
        `,
        prisma.$queryRaw<
          Array<{ day: Date; marketplace: string | null; cents: bigint }>
        >`
          SELECT
            "day",
            "marketplace",
            COALESCE(SUM(ROUND("grossRevenue" * 100)), 0)::bigint AS cents
          FROM "DailySalesAggregate"
          WHERE "channel" = 'AMAZON'
            AND "day" >= ${dayRangeStart}::date
            AND "day" <  ${dayRangeEnd}::date
          GROUP BY "day", "marketplace"
        `,
      ])

      // Merge by (day|marketplace) key. Either side may be missing.
      type Sums = { orderCents: number; aggregateCents: number }
      const merged = new Map<string, Sums>()
      const keyFor = (day: Date, mkt: string | null): string =>
        `${day.toISOString().slice(0, 10)}|${mkt ?? 'NULL'}`

      for (const r of orderRows) {
        const key = keyFor(r.day, r.marketplace)
        merged.set(key, {
          orderCents: Number(r.cents),
          aggregateCents: 0,
        })
      }
      for (const r of aggregateRows) {
        const key = keyFor(r.day, r.marketplace)
        const existing = merged.get(key) ?? { orderCents: 0, aggregateCents: 0 }
        existing.aggregateCents = Number(r.cents)
        merged.set(key, existing)
      }

      const driftedKeys: Array<{ day: string; marketplace: string | null }> = []
      const nowTs = Date.now()
      for (const [key, sums] of merged.entries()) {
        const max = Math.max(sums.orderCents, sums.aggregateCents)
        if (max === 0) continue // skip empty days both sides
        const delta = sums.orderCents - sums.aggregateCents
        const absDelta = Math.abs(delta)
        const tol = toleranceFor(max)
        if (absDelta <= tol) continue

        const [day, mktRaw] = key.split('|')
        const marketplace = mktRaw === 'NULL' ? null : mktRaw
        const deltaPct = max > 0 ? (delta / max) * 100 : 0

        // Publish — operator notification machinery handles the rest.
        publishOrderEvent({
          type: 'sales.drift.detected',
          day: day ?? '',
          marketplace,
          orderSumCents: sums.orderCents,
          aggregateSumCents: sums.aggregateCents,
          deltaCents: delta,
          deltaPct,
          ts: nowTs,
        })
        driftedKeys.push({ day: day ?? '', marketplace })
        logger.warn('[sales-drift-detector] drift detected', {
          day,
          marketplace,
          orderSumCents: sums.orderCents,
          aggregateSumCents: sums.aggregateCents,
          deltaCents: delta,
          deltaPct: deltaPct.toFixed(2),
        })
      }

      return `windows=${merged.size} drifted=${driftedKeys.length} lookbackDays=${lookback}`
    })
  } catch (err) {
    logger.error('[sales-drift-detector] top-level failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startSalesDriftDetectorCron(): void {
  if (scheduledTask) {
    logger.warn('sales-drift-detector cron already started — skipping')
    return
  }

  // Default 03:30 UTC daily. Override via NEXUS_SALES_DRIFT_DETECTOR_SCHEDULE.
  // Runs AFTER the Amazon T+1 report ingest (~03:00 UTC) so the
  // DailySalesAggregate side is up to date before comparison.
  const schedule = process.env.NEXUS_SALES_DRIFT_DETECTOR_SCHEDULE ?? '30 3 * * *'
  if (!cron.validate(schedule)) {
    logger.error('sales-drift-detector cron: invalid schedule expression', {
      schedule,
    })
    return
  }

  scheduledTask = cron.schedule(schedule, () => {
    void runSalesDriftDetector()
  })

  logger.info('sales-drift-detector cron: started', { schedule })
}
