/**
 * ONE BRAIN AB-10 — the negatives run, daily (services/advertising/brain/negatives-run.ts, design
 * 2026-10-08-ads-one-brain/DESIGN.md §2.7, §4 step 4, §5).
 *
 * Daily at 05:25 UTC: after the term ledger's shadow (05:05) on the same settled search terms, away from the :00 / :15 /
 * :20 / :45 ticks other ads jobs share. One run a day: search terms settle once a day and the cap is per day.
 * NEXUS_ADS_BRAIN_NEGATIVES_SCHEDULE moves it, as the other ads crons.
 *
 * It decides only for products whose negatives lever is OBSERVE or higher. With none (production today) the tick reads
 * the enrollments, prunes log rows older than 30 days (none) and records no run. Each campaign acts at its own level of
 * the lever: OBSERVE logs, PROPOSE asks a person (one change plan a day), AUTO writes as the brain through the existing
 * negative write paths (the write gate, then the channel gateway) — after the shadow days and only under the live server
 * switch. Cluster-safe through lib/cron/clustered.ts (hard rule 7); with business profiles on it runs once per business,
 * inside that business.
 */
import cron from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import type { NegativesRunSummary } from '../services/advertising/brain/negatives-run.js'

export const BRAIN_NEGATIVES_SCHEDULE = '25 5 * * *'
export const BRAIN_NEGATIVES_JOB = 'ads-brain-negatives'

/** One tick in the business the caller is in. Null when it failed (logged). */
export async function runBrainNegativesTick(now: Date = new Date()): Promise<NegativesRunSummary | null> {
  try {
    // Loaded at the tick, not when the scheduler boots (runtime/module-load-order.vitest.test.ts).
    const { negativesDue, runNegativesOnce, negativesSummaryLine } = await import('../services/advertising/brain/negatives-run.js')
    const due = await negativesDue()
    // Nothing due: only the 30-day prune runs, and no run is recorded.
    if (!due.due) return await runNegativesOnce({ now, due })
    let summary: NegativesRunSummary | null = null
    await recordCronRun(BRAIN_NEGATIVES_JOB, async () => {
      summary = await runNegativesOnce({ now, due })
      return negativesSummaryLine(summary)
    })
    return summary
  } catch (error) {
    logger.error('[ads-brain-negatives] run failed', { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

let task: ReturnType<typeof cron.schedule> | null = null
export function startBrainNegativesCron(): void {
  if (task) return
  const schedule = process.env.NEXUS_ADS_BRAIN_NEGATIVES_SCHEDULE ?? BRAIN_NEGATIVES_SCHEDULE
  task = cron.schedule(schedule, async () => { await runBrainNegativesTick() }, { lockTtlMs: 15 * 60_000 })
  logger.info(`[ads-brain-negatives] cron scheduled (${schedule}, per business): the day's negatives for products whose negatives lever is OBSERVE or higher, each campaign at its own level`)
}
