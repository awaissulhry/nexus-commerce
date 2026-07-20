/**
 * RT.0 — OutboundSyncQueue janitor.
 *
 * The queue accumulated three classes of stuck rows in prod (measured
 * 2026-07-19): IN_PROGRESS rows orphaned by a crashed/timed-out dispatch
 * (oldest: 23 days), stale PENDING rows whose intent has long been
 * superseded, and terminally-FAILED rows that were never dead-lettered
 * (isDead=false → invisible to the Dead Letters tab). This cron sweeps
 * all three every 15 minutes with narrow, bounded updateMany filters.
 *
 * Ads rows (AD_*) are excluded — they are owned by the dedicated
 * ads-sync drain and have their own lifecycle.
 *
 * Gate: default ON; opt out with NEXUS_QUEUE_JANITOR=0.
 * Schedule: every 15 min; override NEXUS_QUEUE_JANITOR_SCHEDULE.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

const JOB_NAME = 'outbound-queue-janitor'

const AD_SYNC_TYPES = [
  'AD_BID_UPDATE',
  'AD_BUDGET_UPDATE',
  'AD_ENTITY_STATE_UPDATE',
  'AD_BIDDING_STRATEGY_UPDATE',
]

/** IN_PROGRESS older than this is a crashed dispatch — reclaim to PENDING. */
export const RECLAIM_IN_PROGRESS_AFTER_MS = 30 * 60_000
/** PENDING older than this is stale intent — cancel (dispatch re-reads the
 *  live quantity anyway, so draining a week-old row adds nothing). */
export const EXPIRE_PENDING_AFTER_MS = 7 * 24 * 3600_000
/** Circuit-deferral rows still failing after this long are a real outage —
 *  dead-letter them for operator visibility instead of deferring forever. */
export const DEAD_LETTER_DEFERRALS_AFTER_MS = 48 * 3600_000

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runOutboundQueueJanitor(): Promise<string> {
  const now = Date.now()

  // 1. Reclaim crashed IN_PROGRESS rows → PENDING (drain picks them up).
  const reclaimed = await prisma.outboundSyncQueue.updateMany({
    where: {
      syncStatus: 'IN_PROGRESS',
      syncType: { notIn: AD_SYNC_TYPES },
      updatedAt: { lt: new Date(now - RECLAIM_IN_PROGRESS_AFTER_MS) },
    },
    data: {
      syncStatus: 'PENDING',
      errorCode: 'JANITOR_RECLAIMED',
      errorMessage: 'janitor: reclaimed stale IN_PROGRESS (dispatch crashed or timed out)',
    },
  })

  // 2. Expire ancient PENDING rows.
  const expired = await prisma.outboundSyncQueue.updateMany({
    where: {
      syncStatus: 'PENDING',
      syncType: { notIn: AD_SYNC_TYPES },
      createdAt: { lt: new Date(now - EXPIRE_PENDING_AFTER_MS) },
    },
    data: {
      syncStatus: 'CANCELLED',
      errorCode: 'JANITOR_EXPIRED',
      errorMessage: 'janitor: expired stale PENDING (>7d old — intent superseded)',
    },
  })

  // 3. Dead-letter terminally-FAILED rows the old cron path left invisible.
  const deadLettered = await prisma.outboundSyncQueue.updateMany({
    where: {
      syncStatus: 'FAILED',
      isDead: false,
      errorCode: 'MAX_RETRIES_EXCEEDED',
    },
    data: { isDead: true, diedAt: new Date() },
  })

  // 4. Dead-letter deferral rows stuck for 48h+ (real outage, not an episode).
  // AS.1 — AUTH_REQUIRED deferrals (credential outage) age out the same way:
  // after 48h the outage is a standing incident, and the DLQ tab is the
  // durable surface for it. Retry-after-fix re-drives them.
  const staleDeferrals = await prisma.outboundSyncQueue.updateMany({
    where: {
      syncStatus: 'FAILED',
      isDead: false,
      errorCode: { in: ['CIRCUIT_OPEN_DEFERRED', 'AUTH_REQUIRED'] },
      updatedAt: { lt: new Date(now - DEAD_LETTER_DEFERRALS_AFTER_MS) },
    },
    data: { isDead: true, diedAt: new Date() },
  })

  const summary = `reclaimed=${reclaimed.count} expired=${expired.count} deadLettered=${deadLettered.count} staleDeferrals=${staleDeferrals.count}`
  if (reclaimed.count || expired.count || deadLettered.count || staleDeferrals.count) {
    logger.info(`[${JOB_NAME}] ${summary}`)
  }
  return summary
}

export function startOutboundQueueJanitorCron(): void {
  if (process.env.NEXUS_QUEUE_JANITOR === '0') {
    logger.info(`${JOB_NAME}: disabled via NEXUS_QUEUE_JANITOR=0`)
    return
  }
  if (scheduledTask) return

  const schedule = process.env.NEXUS_QUEUE_JANITOR_SCHEDULE ?? '*/15 * * * *'
  if (!cron.validate(schedule)) {
    logger.error(`${JOB_NAME}: invalid schedule`, { schedule })
    return
  }

  scheduledTask = cron.schedule(schedule, () => {
    void recordCronRun(JOB_NAME, runOutboundQueueJanitor).catch((err) =>
      logger.error(`${JOB_NAME} run failed`, {
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  })
  logger.info(`${JOB_NAME} cron: scheduled`, { schedule })
}

export function stopOutboundQueueJanitorCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}
