/**
 * ADS AUTONOMY — auto-undo (automation A19), daily at 06:15 UTC: after the night's ads reports have landed and before
 * the daily Claude ads run, every automatic ad change due a judgement is judged and, at its level, recorded, asked of a
 * person or put back (services/advertising/ads-auto-undo.service.ts).
 *
 * Through lib/cron/clustered.ts (hard rule 7): one replica per tick, and with business profiles on it runs inside EACH
 * active business's own context. Started in the scheduler's Amazon ads block (NEXUS_ENABLE_AMAZON_ADS_CRON);
 * NEXUS_ADS_AUTO_UNDO_SCHEDULE moves it, NEXUS_ENABLE_ADS_AUTO_UNDO_CRON=0 stops it. The level is the business's own
 * switch (born OBSERVE) under the env and the account dial: OFF skips the run. Run now: the cron registry's
 * `ads-auto-undo` (the Sync Logs hub), and Claude's run-ad-engine-now `auto-undo`.
 */
import cron from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

const JOB_NAME = 'ads-auto-undo'
export const AUTO_UNDO_SCHEDULE = process.env.NEXUS_ADS_AUTO_UNDO_SCHEDULE ?? '15 6 * * *'
let task: ReturnType<typeof cron.schedule> | null = null

/** One run in the business the caller is in, and its one-line summary (the scheduled tick's and Run now's alike). */
export async function runAdsAutoUndoOnce(): Promise<string> {
  // Loaded at the tick, not when the scheduler boots: its module graph is no business of the boot.
  const { runAutoUndo, autoUndoSummaryLine } = await import('../services/advertising/ads-auto-undo.service.js')
  return autoUndoSummaryLine(await runAutoUndo())
}

export async function runAdsAutoUndoCron(): Promise<void> {
  await recordCronRun(JOB_NAME, () => runAdsAutoUndoOnce())
    .catch((error) => logger.error('[ads-auto-undo] cron failure', { error: error instanceof Error ? error.message : String(error) }))
}

export function startAdsAutoUndoCron(): void {
  if (process.env.NEXUS_ENABLE_ADS_AUTO_UNDO_CRON === '0') {
    logger.info('[ads-auto-undo] cron disabled (NEXUS_ENABLE_ADS_AUTO_UNDO_CRON=0)')
    return
  }
  if (task) return
  if (!cron.validate(AUTO_UNDO_SCHEDULE)) {
    logger.error('[ads-auto-undo] invalid schedule', { schedule: AUTO_UNDO_SCHEDULE })
    return
  }
  task = cron.schedule(AUTO_UNDO_SCHEDULE, async () => {
    await runAdsAutoUndoCron()
  })
  logger.info('[ads-auto-undo] cron scheduled', { schedule: AUTO_UNDO_SCHEDULE })
}
