/**
 * H.8 — saved-view alerts cron.
 *
 * Every 5 minutes, evaluates every active SavedViewAlert. For each:
 *   - run the saved-view's filter, count
 *   - update lastCheckedAt + lastCount
 *   - if condition is met AND cooldown elapsed: create a Notification
 *     and bump baselineCount + lastFiredAt
 *
 * See evaluator.service.ts for the comparison + cooldown semantics.
 *
 * Failure isolation: errors on one alert don't stop the batch. The
 * cron itself is wrapped in a global try/catch so a worst-case bug
 * never escalates to crashing the API process.
 *
 * Default cadence: every 5 minutes (`*\/5 * * * *`). Override via
 * `NEXUS_SAVED_VIEW_ALERTS_SCHEDULE`. Gated behind
 * `NEXUS_ENABLE_SAVED_VIEW_ALERTS_CRON` (default-ON; set to '0' to
 * opt out, useful for local dev where you don't want alert noise).
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { evaluateAllActiveAlerts } from '../services/saved-view-alerts/evaluator.service.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runSavedViewAlertsSweep(): Promise<{
  evaluated: number
  fired: number
}> {
  const t0 = Date.now()
  const results = await evaluateAllActiveAlerts({ prisma })
  const fired = results.filter((r) => r.fired).length
  const evaluated = results.length
  logger.info('saved-view-alerts sweep complete', {
    evaluated,
    fired,
    elapsedMs: Date.now() - t0,
  })
  return { evaluated, fired }
}

export function startSavedViewAlertsCron(): void {
  if (scheduledTask) {
    logger.warn('saved-view-alerts cron already started — skipping')
    return
  }
  const schedule =
    process.env.NEXUS_SAVED_VIEW_ALERTS_SCHEDULE ?? '*/5 * * * *'
  if (!cron.validate(schedule)) {
    logger.error('saved-view-alerts cron: invalid schedule expression', {
      schedule,
    })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void runSavedViewAlertsSweep().catch((err) => {
      logger.error('saved-view-alerts cron: failure', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  })
  logger.info('saved-view-alerts cron: scheduled', { schedule })
}

export function stopSavedViewAlertsCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}
