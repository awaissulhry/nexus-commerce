/**
 * ONE BRAIN AB-13 — the brain's hourly research and painted plan (services/advertising/brain/hours-proposal.ts, design
 * 2026-10-08-ads-one-brain/DESIGN.md §2.3, §4 "Weekly … the painted hourly plan proposal (D3)").
 *
 * Daily at 04:50 UTC (after the night's ads report pulls and the native-rule read at 04:35, away from the :00 / :15 / :20
 * / :45 ticks other ads jobs share); each enrolled product × market is due once a week by default (hourProposalsPerWeek,
 * 7 ÷ that many days after its last research), never while its last painted plan still waits for a person. OBSERVE stores
 * the research and the painting in shadow; PROPOSE asks a person (apply-brain-hourly-plan); nothing is ever applied
 * without that approval. NEXUS_ADS_BRAIN_HOURS_SCHEDULE moves it, as the other ads crons; NEXUS_ADS_BRAIN_HOURS=0 stops it.
 *
 * With no product enrolled in the brain the tick reads nothing more than that, writes nothing and records no run.
 * AB-14 — while the product cycle is on (NEXUS_ADS_BRAIN_CYCLE=on) the cycle runs every enrolled product's hours step, so
 * this tick runs none (brain/cycle-switch.ts). Off (the default): as before.
 * Cluster-safe through lib/cron/clustered.ts (hard rule 7); with business profiles on it runs once per business, inside
 * that business.
 */
import cron from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import type { HoursRunSummary } from '../services/advertising/brain/hours-proposal.js'

export const BRAIN_HOURS_SCHEDULE = '50 4 * * *'
export const BRAIN_HOURS_JOB = 'ads-brain-hours'

export const brainHoursEnabled = (): boolean => process.env.NEXUS_ADS_BRAIN_HOURS !== '0'

/** One tick in the business the caller is in. Null when it failed (logged) or is switched off. */
export async function runBrainHoursTick(now: Date = new Date()): Promise<HoursRunSummary | null> {
  if (!brainHoursEnabled()) return null
  try {
    // Loaded at the tick, not when the scheduler boots (runtime/module-load-order.vitest.test.ts).
    const { runHoursOnce, hoursSummaryLine, anyProductEnrolled, NOTHING_ENROLLED } = await import('../services/advertising/brain/hours-proposal.js')
    if (!(await anyProductEnrolled())) return NOTHING_ENROLLED
    // AB-14 — while the product cycle is on it runs every enrolled product (its hours step, after the bids): left here.
    const { cycleOn, CYCLE_RUNS_IT } = await import('../services/advertising/brain/cycle-switch.js')
    if (cycleOn()) return { ...NOTHING_ENROLLED, why: `every enrolled product: ${CYCLE_RUNS_IT}` }
    let summary: HoursRunSummary | null = null
    await recordCronRun(BRAIN_HOURS_JOB, async () => {
      summary = await runHoursOnce({ now })
      return hoursSummaryLine(summary)
    })
    return summary
  } catch (error) {
    logger.error('[ads-brain-hours] the daily research failed', { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

let task: ReturnType<typeof cron.schedule> | null = null
export function startBrainHoursCron(): void {
  if (task) return
  const schedule = process.env.NEXUS_ADS_BRAIN_HOURS_SCHEDULE ?? BRAIN_HOURS_SCHEDULE
  task = cron.schedule(schedule, async () => { await runBrainHoursTick() }, { lockTtlMs: 15 * 60_000 })
  logger.info(`[ads-brain-hours] cron scheduled (${schedule}, per business): researches and paints the hourly plan of each enrolled product whose hours lever is OBSERVE or PROPOSE, once a week by default`)
}
