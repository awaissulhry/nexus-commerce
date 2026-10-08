/**
 * ONE BRAIN AB-12 — the state brain's cron (services/advertising/brain/state-run.ts, design 2026-10-08-ads-one-brain/
 * DESIGN.md §2.4, §4 "stops and state"): hourly at :50 — away from the :00 / :15 / :20 / :45 ticks other ads jobs share —
 * every product whose state lever is OBSERVE or higher has each campaign's state decided, acted on at its level (OBSERVE
 * logs, PROPOSE asks a person, AUTO writes through the normal status path and the write gate) and logged. Hourly, so a
 * stop that ends is resumed within the hour once its minimum pause has stood; NEXUS_ADS_BRAIN_STATE_SCHEDULE moves it.
 *
 * With no such product (production today) the tick reads one table, prunes the log rows older than 30 days and records
 * no run. Its own lever levels decide, not the bid brain's switch (AUTO still writes only while NEXUS_BID_BRAIN_MODE is
 * live: the gate judges the brain's writes only then). The clock is the database's (rank-defend's dbNow: a container
 * clock once ran two hours late). A failure is logged, never thrown.
 * Cluster-safe through lib/cron/clustered.ts (hard rule 7); with business profiles on it runs once per business, inside
 * that business.
 */
import cron from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

export const BRAIN_STATE_SCHEDULE = '50 * * * *'
export const BRAIN_STATE_JOB = 'ads-brain-state'

/** One tick in the business the caller is in. */
export async function runBrainStateTick(at?: Date): Promise<void> {
  try {
    // Loaded at the tick, not when the scheduler boots (runtime/module-load-order.vitest.test.ts).
    const { runStateBrainOnce, stateSummaryLine, pruneStateDecisions } = await import('../services/advertising/brain/state-run.js')
    const { stateWatchProducts } = await import('../services/advertising/brain/state-load.js')
    const now = at ?? await (await import('./ad-rank-defend.job.js')).dbNow()
    const products = await stateWatchProducts()
    // Nothing watched: the old decisions still go after 30 days (a product that left the brain leaves none behind).
    if (!products.length) { await pruneStateDecisions(now); return }
    await recordCronRun(BRAIN_STATE_JOB, async () => stateSummaryLine(await runStateBrainOnce({ now, products })))
  } catch (err) { logger.error('ads-brain state run failure', { error: err instanceof Error ? err.message : String(err) }) }
}

let task: ReturnType<typeof cron.schedule> | null = null
let running = false
export function startBrainStateCron(): void {
  if (task) return
  const schedule = process.env.NEXUS_ADS_BRAIN_STATE_SCHEDULE ?? BRAIN_STATE_SCHEDULE
  task = cron.schedule(schedule, async () => {
    if (running) { logger.warn('[ads-brain-state] previous tick still in flight — skipping'); return }
    running = true
    await runBrainStateTick().finally(() => { running = false })
  }, { lockTtlMs: 10 * 60_000 })
  logger.info(`[ads-brain-state] cron scheduled (${schedule}, per business): pauses, resumes and archive proposals for products whose state lever is OBSERVE or higher`)
}
