/**
 * S.24 — Amazon MCF status sync cron.
 *
 * Schedule: '*\/15 * * * *' UTC (every 15 minutes). Walks active
 * MCFShipment rows (status NOT in any terminal state) and pulls the
 * latest status from Amazon. The webhook path catches most updates
 * faster, but the poll is the safety net for missed deliveries.
 *
 * Default-on; opt out via NEXUS_ENABLE_MCF_STATUS_CRON=0.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { syncMCFStatus, unconfiguredAdapter, type MCFAdapter } from '../services/amazon-mcf.service.js'
import { recordCronRun } from '../utils/cron-observability.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastSummary: { checked: number; changed: number; failed: number } | null = null

const TERMINAL_STATUSES = ['COMPLETE', 'COMPLETE_PARTIALLED', 'CANCELLED', 'UNFULFILLABLE', 'INVALID']

/**
 * Resolve the production MCF adapter. Today this returns the
 * unconfiguredAdapter — the real SP-API wrapper plugs in when the
 * MCF integration goes live (S.24 ships the surface; the wired
 * adapter follows in a focused commit). Tests inject directly.
 */
function resolveAdapter(): MCFAdapter {
  if (process.env.AMAZON_MCF_LIVE === '1') {
    // TODO: wire the real SP-API client. Same shape as
    // amazon-inventory.service uses.
  }
  return unconfiguredAdapter
}

export async function runMCFStatusSyncOnce(): Promise<void> {
  if (process.env.NEXUS_ENABLE_MCF_STATUS_CRON === '0') {
    logger.info('amazon-mcf-status cron: disabled via NEXUS_ENABLE_MCF_STATUS_CRON=0')
    return
  }
  const adapter = resolveAdapter()
  if (adapter === unconfiguredAdapter) {
    logger.info('amazon-mcf-status cron: adapter unconfigured — skipping')
    return
  }

  const summary = { checked: 0, changed: 0, failed: 0 }
  try {
    await recordCronRun('amazon-mcf-status', async () => {
      const active = await prisma.mCFShipment.findMany({
        where: { status: { notIn: TERMINAL_STATUSES } },
        orderBy: { lastSyncedAt: 'asc' },
        take: 100,
        select: { amazonFulfillmentOrderId: true },
      })
      for (const s of active) {
        summary.checked++
        try {
          const r = await syncMCFStatus(adapter, s.amazonFulfillmentOrderId)
          if (r.changed) summary.changed++
        } catch (err) {
          summary.failed++
          logger.warn('amazon-mcf-status cron: per-row sync failed', {
            amazonFulfillmentOrderId: s.amazonFulfillmentOrderId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      lastRunAt = new Date()
      lastSummary = summary
      if (summary.checked > 0) {
        logger.info('amazon-mcf-status cron: completed', summary)
      }
      return `checked=${summary.checked} changed=${summary.changed} failed=${summary.failed}`
    })
  } catch (err) {
    logger.error('amazon-mcf-status cron: top-level failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startAmazonMCFStatusCron(): void {
  if (scheduledTask) {
    logger.warn('amazon-mcf-status cron already started — skipping')
    return
  }
  const schedule = process.env.NEXUS_AMAZON_MCF_STATUS_SCHEDULE ?? '*/15 * * * *'
  if (!cron.validate(schedule)) {
    logger.error('amazon-mcf-status cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => { void runMCFStatusSyncOnce() })
  logger.info('amazon-mcf-status cron: scheduled', { schedule })
}

export function stopAmazonMCFStatusCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getMCFStatusCronStatus() {
  return { scheduled: scheduledTask !== null, lastRunAt, lastSummary }
}
