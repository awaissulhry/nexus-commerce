/**
 * RV.9.2 — Stale CronRun row sweeper.
 *
 * When a cron handler crashes mid-run (OOM kill, container restart,
 * uncaught throw past the wrapper), the CronRun row stays at
 * status='RUNNING' forever — `recordCronRun` only updates the row on
 * normal completion or caught exception. Stale RUNNING rows pollute
 * the dashboard health view AND can confuse cron observability
 * downstream (e.g. a stuck row blocks a "is this cron healthy?" check).
 *
 * This sweeper runs every 30 minutes:
 *   1. Find CronRun rows with status='RUNNING' AND startedAt < now-2h
 *   2. Mark them FAILED with errorMessage='stale (auto-swept after Nh)'
 *
 * The 2h threshold leaves room for genuinely-slow jobs (the
 * orders-delivered-backfill can take 55 min in the worst case across
 * 11 EU markets). Anything longer is almost certainly orphaned.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'

const STALE_THRESHOLD_HOURS = 2

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runCronOrphanSweepOnce(): Promise<{ swept: number }> {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_HOURS * 60 * 60 * 1000)
  // Find first so we can log what we touched.
  const stale = await prisma.cronRun.findMany({
    where: { status: 'RUNNING', startedAt: { lt: cutoff } },
    select: { id: true, jobName: true, startedAt: true },
  })
  if (stale.length === 0) return { swept: 0 }

  for (const row of stale) {
    const hoursStuck = (Date.now() - row.startedAt.getTime()) / 3_600_000
    await prisma.cronRun.update({
      where: { id: row.id },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        errorMessage: `stale (auto-swept after ${hoursStuck.toFixed(1)}h)`,
      },
    })
    logger.warn('[cron-orphan-sweeper] marked stale CronRun as FAILED', {
      id: row.id,
      jobName: row.jobName,
      startedAt: row.startedAt.toISOString(),
      hoursStuck: hoursStuck.toFixed(1),
    })
  }
  return { swept: stale.length }
}

export function startCronOrphanSweeperCron(): void {
  if (scheduledTask) {
    logger.warn('cron-orphan-sweeper already started — skipping')
    return
  }
  // Every 30 minutes — keeps the dashboard's stale-RUNNING count near zero.
  const schedule = process.env.NEXUS_CRON_ORPHAN_SWEEPER_SCHEDULE ?? '*/30 * * * *'
  if (!cron.validate(schedule)) {
    logger.error('cron-orphan-sweeper: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void runCronOrphanSweepOnce().catch((err) => {
      logger.warn('[cron-orphan-sweeper] tick failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  })
  logger.info('cron-orphan-sweeper: scheduled', { schedule })
}

export function stopCronOrphanSweeperCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}
