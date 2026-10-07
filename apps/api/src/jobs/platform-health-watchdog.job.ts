/**
 * Platform health watchdog (2026-10-07) — once a day, every check of services/platform-health/ measured, stored and
 * alerted on (platform-health.service.ts). "Run now" on the Sync Logs hub runs the same work (cron-registry.ts).
 *
 * Through lib/cron/clustered.ts (hard rule 7): one replica per tick, and with business profiles on the tick runs inside
 * EACH active business — every read, row and alert is that business's own.
 *
 * 06:20 UTC by default: after the night's jobs (Data Kiosk 03:20, sqp-ingest 03:45 with its up-to-75-minute pass, the FBA
 * drift detector 05:00) and before the daily Claude ads run (09:35 Rome), which reads the result first.
 * NEXUS_PLATFORM_HEALTH_SCHEDULE moves it; NEXUS_ENABLE_PLATFORM_HEALTH_CRON=0 turns it off.
 *
 * The run records ONE CronRun row ('platform-health-watchdog'): PARTIAL when a check could not measure — a run that left
 * a part unwatched did not prove what it exists to prove.
 */
import cron from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { recordCronRun, type CronHandlerResult } from '../utils/cron-observability.js'

export const PLATFORM_HEALTH_JOB = 'platform-health-watchdog'
export const PLATFORM_HEALTH_SCHEDULE = '20 6 * * *'
let task: ReturnType<typeof cron.schedule> | null = null

/** One watchdog run in the caller's business, without the CronRun wrapper (the hub's Run now adds its own). */
export async function runPlatformHealthWatchdogOnce(triggeredBy: 'cron' | 'manual' = 'cron'): Promise<Exclude<CronHandlerResult, string | void | undefined>> {
  // Loaded at the tick, not when the scheduler boots: the checks reach the ads and automation services.
  const { runPlatformHealthWatchdog, watchdogSummary } = await import('../services/platform-health/platform-health.service.js')
  const run = await runPlatformHealthWatchdog({ triggeredBy })
  if (run.counts.fail || run.alerts.fired.length || run.alerts.escalated.length) {
    logger.warn('[platform-health] problems found', { summary: watchdogSummary(run) })
  }
  return { summary: watchdogSummary(run), cronStatus: run.counts.unknown ? 'PARTIAL' : 'SUCCESS' }
}

export function startPlatformHealthWatchdogCron(): void {
  if (process.env.NEXUS_ENABLE_PLATFORM_HEALTH_CRON === '0') {
    logger.info('[platform-health] cron disabled (NEXUS_ENABLE_PLATFORM_HEALTH_CRON=0)')
    return
  }
  if (task) return
  const schedule = process.env.NEXUS_PLATFORM_HEALTH_SCHEDULE || PLATFORM_HEALTH_SCHEDULE
  if (!cron.validate(schedule)) {
    logger.error('[platform-health] invalid schedule — cron not started', { schedule })
    return
  }
  task = cron.schedule(schedule, async () => {
    await recordCronRun(PLATFORM_HEALTH_JOB, () => runPlatformHealthWatchdogOnce('cron')).catch((error) => {
      logger.error('[platform-health] run failed', { error: error instanceof Error ? error.message : String(error) })
    })
  })
  logger.info('[platform-health] cron scheduled', { schedule })
}
