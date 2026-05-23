/**
 * DA-RT.5 / DA-RT.10 — Sales drift detector cron.
 *
 * Compares the THREE local stores of "what we sold on day X in
 * marketplace Y":
 *
 *   A. Order.totalPrice sum (per the snapshot's MS.6 + GS-RT.3
 *      reconciliation endpoint logic) — live operator DB.
 *   B. DailySalesAggregate.grossRevenue sum (per F.1 + DA-RT.2 —
 *      already TZ-aware + apportionment-corrected as of DA-RT.2) —
 *      cron-materialised denormalisation.
 *   C. FinancialTransaction.grossRevenue WHERE transactionType='Order'
 *      (per amazon-financial-events.service.ts, DA-RT.10) — pulled
 *      directly from Amazon SP-API ListFinancialEvents = the "ground
 *      truth" once Amazon has settled the order.
 *
 * For each (day, marketplace) tuple we check all 3 pairs:
 *   (order vs aggregate), (order vs financial), (aggregate vs financial).
 * When any pair's absolute delta exceeds tolerance (max(€1, 0.5%)),
 * publishes `sales.drift.detected` on the order-events bus with the
 * per-pair breakdown + logs a warning. Existing notification + global
 * alert banner machinery (RT.16/17) surfaces the event to the operator.
 *
 * Store C may legitimately be zero for very recent days — Amazon's
 * ListFinancialEvents settles T+1 to T+7 depending on the event type.
 * We only flag a pair as drifting when BOTH sides have non-zero data,
 * so empty-financial-side windows don't false-fire.
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
 * - Per (day, marketplace) tuple. Days with zero orders on all
 *   sides are skipped silently.
 *
 * Gated behind NEXUS_ENABLE_SALES_DRIFT_DETECTOR=1 (default OFF
 * during rollout).
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

      // Pull all 3 stores' per-(day, marketplace) sums in TZ-aware
      // buckets so the keys line up exactly. Store C (financial) is
      // joined to Order so we can apply the same TZ + marketplace
      // grouping the other two stores use.
      const [orderRows, aggregateRows, financialRows] = await Promise.all([
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
        // DA-RT.10 — Store C: Amazon-confirmed financial events.
        // JOIN Order so we get the same TZ bucket + marketplace key
        // the other two stores group by. Same status/currency filters
        // for consistency (a CANCELLED order shouldn't show up here
        // either, even though Amazon sometimes still reports a
        // "RefundEvent" pair — that's a separate event type).
        prisma.$queryRaw<
          Array<{ day: Date; marketplace: string | null; cents: bigint }>
        >`
          SELECT
            date_trunc('day', o."purchaseDate" AT TIME ZONE 'Europe/Rome')::date AS day,
            o."marketplace",
            COALESCE(SUM(ROUND(ft."grossRevenue" * 100)), 0)::bigint AS cents
          FROM "FinancialTransaction" ft
          JOIN "Order" o ON o.id = ft."orderId"
          WHERE o."deletedAt" IS NULL
            AND o."channel" = 'AMAZON'
            AND o."currencyCode" = 'EUR'
            AND o."status" != 'CANCELLED'
            AND o."purchaseDate" >= ${dayRangeStart}
            AND o."purchaseDate" <  ${dayRangeEnd}
            AND ft."transactionType" = 'Order'
          GROUP BY day, o."marketplace"
        `,
      ])

      // Merge by (day|marketplace) key. Any side may be missing.
      // financialCents is `null` when Store C has no rows for that
      // bucket — distinct from `0` (which would mean "Amazon settled
      // a €0 order for this day"). We use null to suppress false
      // drift on recent days where ListFinancialEvents hasn't caught
      // up yet (T+1 to T+7 settlement window).
      type Sums = {
        orderCents: number
        aggregateCents: number
        financialCents: number | null
      }
      const merged = new Map<string, Sums>()
      const keyFor = (day: Date, mkt: string | null): string =>
        `${day.toISOString().slice(0, 10)}|${mkt ?? 'NULL'}`

      const getOrCreate = (key: string): Sums => {
        let existing = merged.get(key)
        if (!existing) {
          existing = { orderCents: 0, aggregateCents: 0, financialCents: null }
          merged.set(key, existing)
        }
        return existing
      }
      for (const r of orderRows) {
        getOrCreate(keyFor(r.day, r.marketplace)).orderCents = Number(r.cents)
      }
      for (const r of aggregateRows) {
        getOrCreate(keyFor(r.day, r.marketplace)).aggregateCents = Number(r.cents)
      }
      for (const r of financialRows) {
        getOrCreate(keyFor(r.day, r.marketplace)).financialCents = Number(r.cents)
      }

      // Pair check helper. Returns `null` when either side is missing
      // data (Store C may legitimately be `null` for recent windows).
      // Returns the deltaCents + deltaPct when both sides are present
      // AND the absolute delta exceeds tolerance.
      const checkPair = (
        a: number | null,
        b: number | null,
      ): { deltaCents: number; deltaPct: number } | null => {
        if (a === null || b === null) return null
        const max = Math.max(a, b)
        if (max === 0) return null
        const delta = a - b
        const absDelta = Math.abs(delta)
        if (absDelta <= toleranceFor(max)) return null
        return { deltaCents: delta, deltaPct: (delta / max) * 100 }
      }

      const driftedKeys: Array<{ day: string; marketplace: string | null }> = []
      const nowTs = Date.now()
      for (const [key, sums] of merged.entries()) {
        // 3 candidate pairs; financial may be null and is excluded
        // automatically by checkPair when missing.
        const pairs: Array<{
          a: 'order' | 'aggregate' | 'financial'
          b: 'order' | 'aggregate' | 'financial'
          delta: { deltaCents: number; deltaPct: number } | null
        }> = [
          { a: 'order',     b: 'aggregate', delta: checkPair(sums.orderCents,     sums.aggregateCents) },
          { a: 'order',     b: 'financial', delta: checkPair(sums.orderCents,     sums.financialCents) },
          { a: 'aggregate', b: 'financial', delta: checkPair(sums.aggregateCents, sums.financialCents) },
        ]
        const driftPairs = pairs
          .filter((p) => p.delta !== null)
          .map((p) => ({
            a: p.a,
            b: p.b,
            deltaCents: p.delta!.deltaCents,
            deltaPct: p.delta!.deltaPct,
          }))
        if (driftPairs.length === 0) continue

        const [day, mktRaw] = key.split('|')
        const marketplace = mktRaw === 'NULL' ? null : mktRaw

        // Backwards-compat: legacy `delta*` fields surface the
        // order-vs-aggregate pair (DA-RT.5 semantics) when present;
        // otherwise the first drifting pair so subscribers built
        // before DA-RT.10 still get a usable signal.
        const legacyPair =
          driftPairs.find((p) => p.a === 'order' && p.b === 'aggregate') ??
          driftPairs[0]!

        publishOrderEvent({
          type: 'sales.drift.detected',
          day: day ?? '',
          marketplace,
          orderSumCents: sums.orderCents,
          aggregateSumCents: sums.aggregateCents,
          financialSumCents: sums.financialCents ?? undefined,
          deltaCents: legacyPair.deltaCents,
          deltaPct: legacyPair.deltaPct,
          driftPairs,
          ts: nowTs,
        })
        driftedKeys.push({ day: day ?? '', marketplace })
        logger.warn('[sales-drift-detector] drift detected', {
          day,
          marketplace,
          orderSumCents: sums.orderCents,
          aggregateSumCents: sums.aggregateCents,
          financialSumCents: sums.financialCents,
          driftPairs: driftPairs.map(
            (p) => `${p.a}↔${p.b}: ${p.deltaCents}¢ (${p.deltaPct.toFixed(2)}%)`,
          ),
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
