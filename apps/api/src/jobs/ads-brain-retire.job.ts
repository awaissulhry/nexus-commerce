/**
 * ONE BRAIN AB-20 — the retired writers' cron (services/advertising/brain/retire-run.ts, design
 * 2026-10-08-ads-one-brain/DESIGN.md §3, §8 row AB-20): every 15 minutes at :08 / :23 / :38 / :53 — away from the other ads
 * ticks. It gives back each configuration row a product's brain retired whose retirement no longer holds (the product left the
 * brain, a lever went back from AUTO or from the Owner's choice, a kill switch, the server switch NEXUS_BID_BRAIN_MODE no
 * longer live, a campaign no longer the product's own) — each only while nobody changed it since. Once an hour (the :08 tick)
 * it also looks for ready products with rows to retire: under NEXUS_ADS_BRAIN_RETIRE=ask it asks a person once for each (never
 * while a request waits, never within 14 days of one declined); off (the default) it only says so in its line.
 * NEXUS_ADS_BRAIN_RETIRE_SCHEDULE moves it.
 *
 * Nothing retired and nothing enrolled in the business (production as AB-20 ships): one or two cheap queries, no run recorded.
 * A failure is logged, never thrown. Cluster-safe through lib/cron/clustered.ts (hard rule 7); with business profiles on it
 * runs once per business, inside that business. Nothing here writes to Amazon.
 */
import cron from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import type { RetireTickSummary } from '../services/advertising/brain/retire-run.js'

export const BRAIN_RETIRE_SCHEDULE = '8,23,38,53 * * * *'
export const BRAIN_RETIRE_JOB = 'ads-brain-retire'

/** One tick in the business the caller is in. Null when there was nothing to look at, or it failed (logged). */
export async function runBrainRetireTick(at?: Date): Promise<RetireTickSummary | null> {
  try {
    // Loaded at the tick, not when the scheduler boots (runtime/module-load-order.vitest.test.ts).
    const { default: prisma } = await import('../db.js')
    const now = at ?? new Date()
    // The hourly scan of ready products runs at the first tick of the hour.
    const scan = now.getUTCMinutes() < 15
    const [retired, enrolled] = await Promise.all([
      prisma.adsBrainRetirement.count({ where: { status: 'RETIRED' } }),
      scan ? prisma.adsBrainEnrollment.count() : Promise.resolve(0),
    ])
    if (!retired && !enrolled) return null
    const { runRetireTick, retireTickLine } = await import('../services/advertising/brain/retire-run.js')
    let summary: RetireTickSummary | null = null
    await recordCronRun(BRAIN_RETIRE_JOB, async () => {
      summary = await runRetireTick({ now, scan: scan && enrolled > 0 })
      return retireTickLine(summary)
    })
    return summary
  } catch (err) {
    logger.error('[ads-brain-retire] the tick failed', { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

let task: ReturnType<typeof cron.schedule> | null = null
let running = false
export function startBrainRetireCron(): void {
  if (task) return
  const schedule = process.env.NEXUS_ADS_BRAIN_RETIRE_SCHEDULE ?? BRAIN_RETIRE_SCHEDULE
  task = cron.schedule(schedule, async () => {
    if (running) { logger.warn('[ads-brain-retire] previous tick still in flight — skipping'); return }
    running = true
    await runBrainRetireTick().finally(() => { running = false })
  }, { lockTtlMs: 14 * 60_000 })
  logger.info(`[ads-brain-retire] cron scheduled (${schedule}, per business): gives back the writers a brain retired once their retirement no longer holds; asks to retire only under NEXUS_ADS_BRAIN_RETIRE=ask`)
}
