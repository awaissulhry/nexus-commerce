/**
 * G.1 — Repricer cron entry.
 *
 *   Cron schedule: every 30 minutes (asterisk-slash-30 in cron syntax).
 *
 * Gated behind two layers:
 *   - NEXUS_ENABLE_PRICING_CRON=1 (the same global pricing-cron gate
 *     that controls FX / snapshot / promotion / fee / competitive
 *     refresh; if pricing crons are disabled wholesale, repricer
 *     stays off too)
 *   - NEXUS_REPRICER_LIVE=1 (the per-feature kill switch — when 0,
 *     the scheduler runs in dry-run mode and the cron still ticks
 *     so the audit trail stays continuous)
 *
 * The scheduler service handles its own dry-run vs live distinction;
 * this file just orchestrates the cron registration.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { runRepricerTick } from '../services/repricer-scheduler.service.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

let task: ReturnType<typeof cron.schedule> | null = null

async function tick(): Promise<void> {
  try {
    await recordCronRun('repricer', async () => {
      const r = await runRepricerTick(prisma)
      return `live=${r.liveMode} scanned=${r.snapshotsScanned} enqueued=${r.enqueued} dryRunWould=${r.dryRunWouldEnqueue} subThreshold=${r.skippedSubThreshold}`
    })
  } catch (err) {
    logger.error('G.1 repricer cron: tick failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startRepricerCron(): void {
  if (task) {
    logger.warn('repricer cron already started — skipping')
    return
  }
  const schedule = process.env.NEXUS_REPRICER_CRON ?? '*/30 * * * *'
  if (schedule === 'off' || schedule === '0' || schedule === 'false') {
    logger.info('repricer cron disabled via NEXUS_REPRICER_CRON')
    return
  }
  if (!cron.validate(schedule)) {
    logger.error('repricer cron: invalid schedule', { schedule })
    return
  }
  task = cron.schedule(schedule, () => void tick())
  logger.info('G.1 repricer cron scheduled', {
    schedule,
    liveMode: process.env.NEXUS_REPRICER_LIVE === '1',
  })
}

export function stopRepricerCron(): void {
  if (task) {
    task.stop()
    task = null
  }
}

export { tick as runRepricerCronTick }
