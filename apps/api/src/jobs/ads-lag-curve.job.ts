/**
 * BID BRAIN BB-15 — the nightly fit of the attribution lag curves (services/advertising/bid-brain/lag-curve-store.ts):
 * per market, the share of a day's final orders and sales that a copy pulled at each age holds, from the vintages BB-13
 * keeps, seeded from the settled 1d/7d ratio; with its calibration on the newest settled days. One row per market (and per
 * product with enough orders of its own) in AdsLagCurve, replaced. Reads only Nexus rows; never asks Amazon.
 *
 * Daily at 05:10 UTC: after the night's report pulls and their ingest (report creates 01:15–02:00, the settle catch-up and
 * the reconcile after them) and before the bid brain's 06:45 full run, which reads the curve; away from the :00 / :15 /
 * :20 / :45 ticks other ads jobs share. NEXUS_ADS_LAG_CURVE_SCHEDULE moves it, as the other ads crons.
 *
 * It fits only while the bid brain runs (NEXUS_BID_BRAIN_MODE not off) and the nowcast is not off
 * (NEXUS_BID_BRAIN_NOWCAST: shadow by default); otherwise the tick reads nothing, writes nothing and records no run.
 * Cluster-safe through lib/cron/clustered.ts (hard rule 7); with business profiles on it runs once per business, inside
 * that business. Idempotent: a rerun on the same rows writes the same curves.
 */
import cron from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import type { LagFitSummary } from '../services/advertising/bid-brain/lag-curve-store.js'

export const LAG_CURVE_SCHEDULE = '10 5 * * *'
export const LAG_CURVE_JOB = 'ads-lag-curve-fit'

/** Why the tick does nothing, or null when it fits. */
export async function lagFitIdle(): Promise<string | null> {
  const [{ bidBrainMode }, { nowcastMode }] = await Promise.all([
    import('../services/advertising/bid-brain/shadow.js'),
    import('../services/advertising/bid-brain/nowcast.js'),
  ])
  if (bidBrainMode() === 'off') return 'the bid brain is off (NEXUS_BID_BRAIN_MODE): no curve to fit'
  if (nowcastMode() === 'off') return 'the nowcast is off (NEXUS_BID_BRAIN_NOWCAST): no curve to fit'
  return null
}

/** One tick in the business the caller is in. Null when it did nothing or failed (logged). */
export async function runLagCurveTick(now: Date = new Date()): Promise<LagFitSummary | null> {
  try {
    if (await lagFitIdle()) return null
    // Loaded at the tick, not when the scheduler boots (runtime/module-load-order.vitest.test.ts).
    const { fitLagCurves, lagFitSummaryLine } = await import('../services/advertising/bid-brain/lag-curve-store.js')
    let summary: LagFitSummary | null = null
    await recordCronRun(LAG_CURVE_JOB, async () => {
      summary = await fitLagCurves({ now })
      return lagFitSummaryLine(summary)
    })
    return summary
  } catch (error) {
    logger.error('[ads-lag-curve] nightly fit failed — the stored curves stay as they were', { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

let task: ReturnType<typeof cron.schedule> | null = null
export function startLagCurveCron(): void {
  if (task) return
  const schedule = process.env.NEXUS_ADS_LAG_CURVE_SCHEDULE ?? LAG_CURVE_SCHEDULE
  task = cron.schedule(schedule, async () => { await runLagCurveTick() }, { lockTtlMs: 10 * 60_000 })
  logger.info(`[ads-lag-curve] cron scheduled (${schedule}, per business): fits the attribution lag curves the bid brain's nowcast reads`)
}
