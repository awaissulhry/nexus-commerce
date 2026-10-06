/**
 * ADS AUTONOMY W4-2 — the daily Claude ads run's watchdog, hourly at :40 (services/agents/ads-manager-watchdog.service.ts).
 *
 * Through lib/cron/clustered.ts (hard rule 7): one replica per tick, and with business profiles on it runs the tick
 * inside EACH active business's own context — the fleet-resync trap (a boot job outside any business) cannot happen
 * here: every read and alert is that business's. :40 catches a report due on the hour (deadline :30) ten minutes late.
 *
 * On by default: a business without an expected report time and without a started run does nothing.
 * NEXUS_ENABLE_ADS_RUN_WATCHDOG_CRON=0 turns it off. A CronRun row is written only for a business whose check is on
 * (an expected time set) or where an alert went, so an idle business does not fill the run log every hour.
 */
import cron from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import type { WatchdogTick } from '../services/agents/ads-manager-watchdog.service.js'

const JOB_NAME = 'claude-ads-run-watchdog'
export const WATCHDOG_SCHEDULE = '40 * * * *'
let task: ReturnType<typeof cron.schedule> | null = null

const summaryOf = (tick: WatchdogTick) =>
  `expected=${tick.expected ? `${tick.expected.time} ${tick.expected.timeZone}` : 'off'} missing=${tick.missing ? 1 : 0} stuck=${tick.stuck.length}`

/** One tick in the business the caller is in. */
export async function runAdsRunWatchdogTick(now = new Date()): Promise<WatchdogTick | null> {
  try {
    // Loaded at the tick, not when the scheduler boots: the scheduler imports this job early, and the watchdog's module
    // graph is no business of its boot (runtime/module-load-order.vitest.test.ts).
    const { runWatchdogOnce } = await import('../services/agents/ads-manager-watchdog.service.js')
    const tick = await runWatchdogOnce(now)
    if (tick.expected || tick.missing || tick.stuck.length) {
      await recordCronRun(JOB_NAME, async () => summaryOf(tick)).catch(() => { /* the run log never breaks the job */ })
    }
    if (tick.missing || tick.stuck.length) logger.warn('[claude-ads-run-watchdog] alerted', { summary: summaryOf(tick) })
    return tick
  } catch (error) {
    logger.error('[claude-ads-run-watchdog] tick failed', { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

export function startAdsRunWatchdogCron(): void {
  if (process.env.NEXUS_ENABLE_ADS_RUN_WATCHDOG_CRON === '0') {
    logger.info('[claude-ads-run-watchdog] cron disabled (NEXUS_ENABLE_ADS_RUN_WATCHDOG_CRON=0)')
    return
  }
  if (task) return
  task = cron.schedule(WATCHDOG_SCHEDULE, async () => {
    await runAdsRunWatchdogTick()
  })
  logger.info('[claude-ads-run-watchdog] cron started (hourly at :40, per business)')
}
