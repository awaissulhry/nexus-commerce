/**
 * ONE BRAIN AB-9 — the term ledger's daily shadow run (services/advertising/brain/terms-shadow.ts, design
 * 2026-10-08-ads-one-brain/DESIGN.md §2.7, §2.8, §4 steps 3–4).
 *
 * Daily at 05:05 UTC: after the night's search-term reports (report creates 01:15–02:00, gap fill 02:05, the reconcile
 * 03:30) and the read of Amazon's own rules (04:35), away from the :00 / :15 / :20 / :45 ticks other ads jobs share. One run
 * a day: search terms settle once a day, so a faster cadence would only add database reads (Neon cost).
 * NEXUS_ADS_BRAIN_TERMS_SCHEDULE moves it, as the other ads crons.
 *
 * It decides only for products whose negatives or harvest lever is OBSERVE or higher. With none (production today) the
 * tick reads the enrollments, prunes rows older than 30 days (none) and records no run. SHADOW: it writes its own two
 * tables and nothing else — never Amazon, never a queue.
 * Cluster-safe through lib/cron/clustered.ts (hard rule 7); with business profiles on it runs once per business, inside
 * that business.
 */
import cron from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import type { TermsRunSummary } from '../services/advertising/brain/terms-shadow.js'

export const BRAIN_TERMS_SCHEDULE = '5 5 * * *'
export const BRAIN_TERMS_JOB = 'ads-brain-terms-shadow'

/** One tick in the business the caller is in. Null when it failed (logged). */
export async function runBrainTermsTick(now: Date = new Date()): Promise<TermsRunSummary | null> {
  try {
    // Loaded at the tick, not when the scheduler boots (runtime/module-load-order.vitest.test.ts).
    const { termsDue, runTermsOnce, termsSummaryLine } = await import('../services/advertising/brain/terms-shadow.js')
    const due = await termsDue()
    // Nothing due: only the 30-day prune runs, and no run is recorded.
    if (!due.due) return await runTermsOnce({ now, due })
    let summary: TermsRunSummary | null = null
    await recordCronRun(BRAIN_TERMS_JOB, async () => {
      summary = await runTermsOnce({ now, due })
      return termsSummaryLine(summary)
    })
    return summary
  } catch (error) {
    logger.error('[ads-brain-terms] shadow run failed', { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

let task: ReturnType<typeof cron.schedule> | null = null
export function startBrainTermsCron(): void {
  if (task) return
  const schedule = process.env.NEXUS_ADS_BRAIN_TERMS_SCHEDULE ?? BRAIN_TERMS_SCHEDULE
  task = cron.schedule(schedule, async () => { await runBrainTermsTick() }, { lockTtlMs: 15 * 60_000 })
  logger.info(`[ads-brain-terms] cron scheduled (${schedule}, per business): the term ledger and the market arbiter in shadow, for products whose negatives or harvest lever is OBSERVE or higher`)
}
