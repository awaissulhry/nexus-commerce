/**
 * ONE BRAIN AB-14 — the product cycle's cron (services/advertising/brain/cycle-run.ts, design
 * 2026-10-08-ads-one-brain/DESIGN.md §4, §8 row AB-14): hourly at :55 — away from the :00 / :15 / :20 / :45 / :50 ticks
 * other ads jobs share. Each enrolled product × market runs its levers in the design's order once per new settled data
 * day (from 05:55 UTC, after the night's reads), and its stops and state every hour; one change set per product and day;
 * the day's product report on the cycle. NEXUS_ADS_BRAIN_CYCLE_SCHEDULE moves it.
 *
 * Switch: NEXUS_ADS_BRAIN_CYCLE = off (the default: the tick returns at once, reading nothing, and every lever's own cron
 * runs as before) | on (each lever's own cron leaves the enrolled products to the cycle: brain/cycle-switch.ts).
 * With it on and no product enrolled, the tick prunes and records no run. A failure is logged, never thrown.
 * Cluster-safe through lib/cron/clustered.ts (hard rule 7); with business profiles on it runs once per business, inside
 * that business.
 */
import cron from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import type { CycleTickSummary } from '../services/advertising/brain/cycle-run.js'

export const BRAIN_CYCLE_SCHEDULE = '55 * * * *'
export const BRAIN_CYCLE_JOB = 'ads-brain-cycle'

/** One tick in the business the caller is in. Null when it is off, nothing is enrolled, or it failed (logged). */
export async function runBrainCycleTick(at?: Date): Promise<CycleTickSummary | null> {
  try {
    // Loaded at the tick, not when the scheduler boots (runtime/module-load-order.vitest.test.ts).
    const { cycleOn } = await import('../services/advertising/brain/cycle-switch.js')
    if (!cycleOn()) return null
    const { runCycleTick, cycleSummaryLine, pruneCycles } = await import('../services/advertising/brain/cycle-run.js')
    const { default: prisma } = await import('../db.js')
    const now = at ?? await (await import('./ad-rank-defend.job.js')).dbNow()
    // Nothing enrolled: the old cycles still go after 90 days, and no run is recorded.
    if (!(await prisma.adsBrainEnrollment.count())) { await pruneCycles(now); return null }
    let summary: CycleTickSummary | null = null
    await recordCronRun(BRAIN_CYCLE_JOB, async () => {
      summary = await runCycleTick({ now })
      return cycleSummaryLine(summary)
    })
    return summary
  } catch (err) {
    logger.error('[ads-brain-cycle] the tick failed', { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

let task: ReturnType<typeof cron.schedule> | null = null
let running = false
export function startBrainCycleCron(): void {
  if (task) return
  const schedule = process.env.NEXUS_ADS_BRAIN_CYCLE_SCHEDULE ?? BRAIN_CYCLE_SCHEDULE
  task = cron.schedule(schedule, async () => {
    if (running) { logger.warn('[ads-brain-cycle] previous tick still in flight — skipping'); return }
    running = true
    await runBrainCycleTick().finally(() => { running = false })
  }, { lockTtlMs: 50 * 60_000 })
  logger.info(`[ads-brain-cycle] cron scheduled (${schedule}, per business): each enrolled product's levers in the design's order once per new data day, its stops hourly — only while NEXUS_ADS_BRAIN_CYCLE=on`)
}
