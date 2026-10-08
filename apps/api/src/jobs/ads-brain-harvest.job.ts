/**
 * ONE BRAIN AB-11 — the harvest's daily run (services/advertising/brain/harvest-run.ts, design
 * 2026-10-08-ads-one-brain/DESIGN.md §2.8, §2.9, §4 step 4).
 *
 * Daily at 05:25 UTC: after the term ledger's shadow run (05:05), on the same settled search terms, away from the :00 /
 * :15 / :20 / :45 ticks other ads jobs share. One run a day: search terms settle once a day, and a harvest is judged in
 * days, so a faster cadence would only add database reads (Neon cost). NEXUS_ADS_BRAIN_HARVEST_SCHEDULE moves it.
 *
 * It decides only for products whose harvest lever is OBSERVE or higher. With none (production today) the tick reads the
 * enrollments, prunes rows past their keep (none) and records no run. At OBSERVE (the default) it writes its own table
 * only (shadow rows). It asks a person or writes to Amazon only for a product whose harvest lever is PROPOSE or AUTO AND
 * under the env ceiling NEXUS_ADS_BRAIN_HARVEST_MODE=live — through the approval gate, the write gate and the channel
 * gateway. Cluster-safe through lib/cron/clustered.ts (hard rule 7); with business profiles on it runs once per business,
 * inside that business.
 */
import cron from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import type { HarvestRunSummary } from '../services/advertising/brain/harvest-run.js'

export const BRAIN_HARVEST_SCHEDULE = '25 5 * * *'
export const BRAIN_HARVEST_JOB = 'ads-brain-harvest'

/** One tick in the business the caller is in. Null when it failed (logged). */
export async function runBrainHarvestTick(now: Date = new Date()): Promise<HarvestRunSummary | null> {
  try {
    // Loaded at the tick, not when the scheduler boots (runtime/module-load-order.vitest.test.ts).
    const { harvestDue } = await import('../services/advertising/brain/harvest-load.js')
    const { runHarvestOnce, harvestSummaryLine } = await import('../services/advertising/brain/harvest-run.js')
    const all = await harvestDue()
    // AB-14 — a product the product cycle runs (NEXUS_ADS_BRAIN_CYCLE=on) gets its harvest step there, after its negatives:
    // left here (brain/cycle-switch.ts). Off (the default): every due product, as before.
    const { withoutOrchestrated, CYCLE_RUNS_IT } = await import('../services/advertising/brain/cycle-switch.js')
    const left = await withoutOrchestrated(all.products)
    const due = left.skipped.length ? { ...all, ...(left.kept.length ? { products: left.kept } : { due: false, why: `${left.skipped.length} due product${left.skipped.length === 1 ? '' : 's'}: ${CYCLE_RUNS_IT}`, products: [] }) } : all
    // Nothing due: only the prune runs, and no run is recorded.
    if (!due.due) return await runHarvestOnce({ now, due })
    let summary: HarvestRunSummary | null = null
    await recordCronRun(BRAIN_HARVEST_JOB, async () => {
      summary = await runHarvestOnce({ now, due })
      return harvestSummaryLine(summary)
    })
    return summary
  } catch (error) {
    logger.error('[ads-brain-harvest] run failed', { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

let task: ReturnType<typeof cron.schedule> | null = null
export function startBrainHarvestCron(): void {
  if (task) return
  const schedule = process.env.NEXUS_ADS_BRAIN_HARVEST_SCHEDULE ?? BRAIN_HARVEST_SCHEDULE
  task = cron.schedule(schedule, async () => { await runBrainHarvestTick() }, { lockTtlMs: 20 * 60_000 })
  logger.info(`[ads-brain-harvest] cron scheduled (${schedule}, per business): the harvest module for products whose harvest lever is OBSERVE or higher (writes only at PROPOSE/AUTO under NEXUS_ADS_BRAIN_HARVEST_MODE=live)`)
}
