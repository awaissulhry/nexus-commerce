/**
 * L.16.0 — Alert evaluator cron.
 *
 * Runs every minute. The evaluator service does the heavy lifting;
 * this file just wraps it in recordCronRun and schedules.
 *
 * Default-ON. Set NEXUS_DISABLE_ALERT_EVALUATOR=1 to opt out.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { runAlertEvaluator } from '../services/alert-evaluator.service.js'
import { recordCronRun } from '../utils/cron-observability.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export function startAlertEvaluatorCron(): void {
  if (scheduledTask) {
    logger.warn('alert-evaluator cron already started — skipping')
    return
  }
  if (process.env.NEXUS_DISABLE_ALERT_EVALUATOR === '1') {
    logger.info('alert-evaluator: disabled via env')
    return
  }

  // Default every minute. Tighter doesn't help — operators don't need
  // sub-minute alert latency for ops-tier sync issues; looser misses
  // short spikes.
  const schedule = process.env.NEXUS_ALERT_EVALUATOR_SCHEDULE ?? '* * * * *'

  if (!cron.validate(schedule)) {
    logger.error('alert-evaluator cron: invalid schedule', { schedule })
    return
  }

  scheduledTask = cron.schedule(schedule, () => {
    void recordCronRun('alert-evaluator', async () => {
      const r = await runAlertEvaluator()
      return `evaluated=${r.rulesEvaluated} fired=${r.rulesFired} resolved=${r.rulesResolved} unchanged=${r.rulesUnchanged} errors=${r.errors}`
    }).catch((err) => {
      logger.error('alert-evaluator cron: failure', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  })

  logger.info('alert-evaluator cron: scheduled', { schedule })
}

export function stopAlertEvaluatorCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}
