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
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { publishOrderEvent } from '../services/order-events.service.js'
import { auditSalesDrift } from '../services/revenue/drift-audit.service.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runSalesDriftDetector(): Promise<void> {
  try {
    await recordCronRun('sales-drift-detector', async () => {
      const lookbackDays = Number(
        process.env.NEXUS_SALES_DRIFT_LOOKBACK_DAYS ?? 7,
      )
      const lookback =
        Number.isFinite(lookbackDays) && lookbackDays > 0 ? lookbackDays : 7

      // DA-RT.13 — query + merge moved to shared auditSalesDrift
      // helper so the same logic powers GET /admin/sales-drift/audit.
      // This cron is now just: audit + publish/log drifting windows.
      const audit = await auditSalesDrift({ lookbackDays: lookback })

      const nowTs = Date.now()
      for (const w of audit.windows) {
        if (w.driftPairs.length === 0) continue

        // Backwards-compat: legacy `delta*` fields surface the
        // order-vs-aggregate pair (DA-RT.5 semantics) when present;
        // otherwise the first drifting pair so subscribers built
        // before DA-RT.10 still get a usable signal.
        const legacyPair =
          w.driftPairs.find((p) => p.a === 'order' && p.b === 'aggregate') ??
          w.driftPairs[0]!

        publishOrderEvent({
          type: 'sales.drift.detected',
          day: w.day,
          marketplace: w.marketplace,
          orderSumCents: w.orderCents,
          aggregateSumCents: w.aggregateCents,
          financialSumCents: w.financialCents ?? undefined,
          deltaCents: legacyPair.deltaCents,
          deltaPct: legacyPair.deltaPct,
          driftPairs: w.driftPairs,
          ts: nowTs,
        })
        logger.warn('[sales-drift-detector] drift detected', {
          day: w.day,
          marketplace: w.marketplace,
          orderSumCents: w.orderCents,
          aggregateSumCents: w.aggregateCents,
          financialSumCents: w.financialCents,
          driftPairs: w.driftPairs.map(
            (p) => `${p.a}↔${p.b}: ${p.deltaCents}¢ (${p.deltaPct.toFixed(2)}%)`,
          ),
        })
      }

      return `windows=${audit.windows.length} drifted=${audit.driftedCount} lookbackDays=${lookback}`
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
