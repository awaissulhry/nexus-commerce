/**
 * S.17 — Daily ABC-driven cycle-count scheduler cron.
 *
 * Schedule: '30 2 * * *' UTC (02:30). After the daily aggregation
 * settles but before the operator's morning shift in IT.
 *
 * Default-on; opt out via NEXUS_ENABLE_CYCLE_COUNT_SCHEDULER=0.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { scheduleAutoCount } from '../services/cycle-count-scheduler.service.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastSummary: Awaited<ReturnType<typeof scheduleAutoCount>> | null = null

export async function runCycleCountSchedulerOnce(): Promise<void> {
  if (process.env.NEXUS_ENABLE_CYCLE_COUNT_SCHEDULER === '0') {
    logger.info('cycle-count-scheduler cron: disabled via NEXUS_ENABLE_CYCLE_COUNT_SCHEDULER=0')
    return
  }
  try {
    const r = await scheduleAutoCount({})
    lastRunAt = new Date()
    lastSummary = r
    if (r.sessionId) {
      logger.info('cycle-count-scheduler cron: session created', {
        sessionId: r.sessionId,
        itemCount: r.itemCount,
        due: r.due,
      })
    }
  } catch (err) {
    logger.error('cycle-count-scheduler cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startCycleCountSchedulerCron(): void {
  if (scheduledTask) {
    logger.warn('cycle-count-scheduler cron already started — skipping')
    return
  }
  const schedule = process.env.NEXUS_CYCLE_COUNT_SCHEDULER_SCHEDULE ?? '30 2 * * *'
  if (!cron.validate(schedule)) {
    logger.error('cycle-count-scheduler cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => { void runCycleCountSchedulerOnce() })
  logger.info('cycle-count-scheduler cron: scheduled', { schedule })
}

export function stopCycleCountSchedulerCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getCycleCountSchedulerStatus() {
  return {
    scheduled: scheduledTask !== null,
    lastRunAt,
    lastSummary,
  }
}
