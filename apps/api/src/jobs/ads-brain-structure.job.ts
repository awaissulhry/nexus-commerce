/**
 * ONE BRAIN AB-16 — the structure lever's daily run (services/advertising/brain/structure-run.ts, design
 * 2026-10-08-ads-one-brain/DESIGN.md §2.9, §4 "Weekly (Monday, Europe/Rome): structure proposals").
 *
 * Daily at 05:35 UTC (after the harvest at 05:25, on the same settled search terms, away from the :00 / :15 / :20 / :45
 * ticks other ads jobs share): every day it follows what its earlier requests became (a build approved → built, its
 * go-live asked; live; a split's last step); on Monday in the market's time zone it decides the week's proposals —
 * single-keyword campaigns, splits of shared campaigns, the move into the product's one portfolio. NEXUS_ADS_BRAIN_STRUCTURE_SCHEDULE
 * moves it.
 *
 * It runs only for products whose structure lever is OBSERVE, PROPOSE or locked. With none (production today) the tick
 * reads the enrollments, prunes rows past their keep (none) and records no run. At OBSERVE (the default) it writes its own
 * table only (shadow rows). It asks a person only for a product whose structure lever is PROPOSE AND under the env ceiling
 * NEXUS_ADS_BRAIN_STRUCTURE_MODE=live — through the approval gate; it never writes to Amazon itself (never AUTO: every build,
 * go-live, move and low-bid stop is a request a person approves). AB-14 — a product the product cycle runs
 * (NEXUS_ADS_BRAIN_CYCLE=on) gets its structure step there: left here. Cluster-safe through lib/cron/clustered.ts (hard rule
 * 7); with business profiles on it runs once per business, inside that business.
 */
import cron from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import type { StructureRunSummary } from '../services/advertising/brain/structure-run.js'

export const BRAIN_STRUCTURE_SCHEDULE = '35 5 * * *'
export const BRAIN_STRUCTURE_JOB = 'ads-brain-structure'

/** One tick in the business the caller is in. Null when it failed (logged). */
export async function runBrainStructureTick(now: Date = new Date()): Promise<StructureRunSummary | null> {
  try {
    // Loaded at the tick, not when the scheduler boots (runtime/module-load-order.vitest.test.ts).
    const { structureDue } = await import('../services/advertising/brain/structure-load.js')
    const { runStructureOnce, structureSummaryLine } = await import('../services/advertising/brain/structure-run.js')
    const all = await structureDue()
    // AB-14 — a product the product cycle runs gets its structure step there: left here (brain/cycle-switch.ts).
    const { withoutOrchestrated, CYCLE_RUNS_IT } = await import('../services/advertising/brain/cycle-switch.js')
    const left = await withoutOrchestrated(all.products)
    const due = left.skipped.length ? { ...all, ...(left.kept.length ? { products: left.kept } : { due: false, why: `${left.skipped.length} due product${left.skipped.length === 1 ? '' : 's'}: ${CYCLE_RUNS_IT}`, products: [] }) } : all
    // Nothing due: only the prune runs, and no run is recorded.
    if (!due.due) return await runStructureOnce({ now, due })
    let summary: StructureRunSummary | null = null
    await recordCronRun(BRAIN_STRUCTURE_JOB, async () => {
      summary = await runStructureOnce({ now, due })
      return structureSummaryLine(summary)
    })
    return summary
  } catch (error) {
    logger.error('[ads-brain-structure] run failed', { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

let task: ReturnType<typeof cron.schedule> | null = null
export function startBrainStructureCron(): void {
  if (task) return
  const schedule = process.env.NEXUS_ADS_BRAIN_STRUCTURE_SCHEDULE ?? BRAIN_STRUCTURE_SCHEDULE
  task = cron.schedule(schedule, async () => { await runBrainStructureTick() }, { lockTtlMs: 20 * 60_000 })
  logger.info(`[ads-brain-structure] cron scheduled (${schedule}, per business): the structure lever for products whose structure lever is OBSERVE or higher — proposals on Monday, requests only at PROPOSE under NEXUS_ADS_BRAIN_STRUCTURE_MODE=live, never AUTO`)
}
