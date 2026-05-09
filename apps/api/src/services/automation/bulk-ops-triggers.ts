/**
 * W7.2 — Bulk-ops trigger emission.
 *
 * Bridges domain events into the AutomationRule evaluator. The
 * evaluator fires rules where `domain='bulk-operations' && trigger=X`
 * — this module owns the `X` values and the context shape each
 * trigger carries.
 *
 * Emit calls are fire-and-forget: a rule throwing inside the
 * evaluator must never block the bulk-action / schedule path that
 * fired the trigger. Failures log and move on.
 */

import { evaluateAllRulesForTrigger } from '../automation-rule.service.js'
import { logger } from '../../utils/logger.js'

const DOMAIN = 'bulk-operations'

export interface BulkJobCompletedContext {
  job: {
    id: string
    jobName: string
    actionType: string
    channel: string | null
    status: string
    totalItems: number
    processedItems: number
    failedItems: number
    skippedItems: number
    progressPercent: number
    /** Failure rate as a 0..1 fraction. Lets rules write
     *  `bulk.failureRate gt 0.2` without recomputing. */
    failureRate: number
    durationMs: number | null
    createdBy: string | null
  }
}

export interface ScheduleFiredContext {
  schedule: {
    id: string
    name: string
    actionType: string
    runCount: number
    cronExpression: string | null
  }
  jobId: string | null
}

export interface BulkCronTickContext {
  /** ISO timestamp of the tick — useful for time-based rules. */
  tickAt: string
}

/**
 * Fire the `bulk_job_completed` trigger. Called from
 * BulkActionService.processJob after the terminal status update.
 * Emits in the background — the caller doesn't await.
 */
export function emitBulkJobCompleted(args: {
  jobId: string
  jobName: string
  actionType: string
  channel: string | null
  status: string
  totalItems: number
  processedItems: number
  failedItems: number
  skippedItems: number
  progressPercent: number
  startedAt: Date | null
  completedAt: Date | null
  createdBy: string | null
}): void {
  const total = Math.max(args.totalItems, 1)
  const failureRate = args.failedItems / total
  const durationMs =
    args.startedAt && args.completedAt
      ? args.completedAt.getTime() - args.startedAt.getTime()
      : null
  const ctx: BulkJobCompletedContext = {
    job: {
      id: args.jobId,
      jobName: args.jobName,
      actionType: args.actionType,
      channel: args.channel,
      status: args.status,
      totalItems: args.totalItems,
      processedItems: args.processedItems,
      failedItems: args.failedItems,
      skippedItems: args.skippedItems,
      progressPercent: args.progressPercent,
      failureRate,
      durationMs,
      createdBy: args.createdBy,
    },
  }
  void evaluateAllRulesForTrigger({
    domain: DOMAIN,
    trigger: 'bulk_job_completed',
    context: ctx,
  }).catch((err) => {
    logger.warn(
      `[automation] bulk_job_completed evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  })
}

/**
 * Fire the `schedule_fired` trigger. Called from the W6.2 worker
 * after each schedule successfully creates a BulkActionJob.
 */
export function emitScheduleFired(args: {
  scheduleId: string
  name: string
  actionType: string
  runCount: number
  cronExpression: string | null
  jobId: string | null
}): void {
  const ctx: ScheduleFiredContext = {
    schedule: {
      id: args.scheduleId,
      name: args.name,
      actionType: args.actionType,
      runCount: args.runCount,
      cronExpression: args.cronExpression,
    },
    jobId: args.jobId,
  }
  void evaluateAllRulesForTrigger({
    domain: DOMAIN,
    trigger: 'schedule_fired',
    context: ctx,
  }).catch((err) => {
    logger.warn(
      `[automation] schedule_fired evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  })
}

/**
 * Fire the recurring `bulk_cron_tick` trigger. Mirrors the
 * replenishment 'cron_tick' but with domain='bulk-operations' so
 * bulk-ops rules don't fire when the replenishment evaluator runs.
 */
export async function fireBulkCronTick(): Promise<void> {
  const ctx: BulkCronTickContext = { tickAt: new Date().toISOString() }
  await evaluateAllRulesForTrigger({
    domain: DOMAIN,
    trigger: 'bulk_cron_tick',
    context: ctx,
  })
}
