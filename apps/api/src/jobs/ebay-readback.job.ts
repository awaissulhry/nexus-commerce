/**
 * P5.2 — 30-minute eBay inventory read-back cron.
 *
 * Gated by NEXUS_EBAY_READBACK (set to '0' to disable).
 * Schedule overridable via NEXUS_EBAY_READBACK_SCHEDULE (default every 30 min).
 *
 * Mirrors reservation-reconcile.job.ts scaffolding.
 */
import cron from 'node-cron'
import { readBackEbayInventory } from '../services/ebay-inventory-readback.service.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { logger } from '../utils/logger.js'

const JOB = 'ebay-readback'
let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export function startEbayReadbackCron(): void {
  if (process.env.NEXUS_EBAY_READBACK === '0') {
    logger.info('ebay-readback cron: disabled via NEXUS_EBAY_READBACK=0')
    return
  }
  if (scheduledTask) {
    logger.warn('ebay-readback cron already started — skipping')
    return
  }
  const schedule =
    process.env.NEXUS_EBAY_READBACK_SCHEDULE ?? '*/30 * * * *'
  if (!cron.validate(schedule)) {
    logger.error('ebay-readback cron: invalid schedule, not starting', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void recordCronRun(JOB, async () => {
      const r = await readBackEbayInventory()
      return `checked=${r.checked} recorded=${r.recorded} errors=${r.errors}${r.capped ? ' (capped)' : ''}`
    }).catch((err) => {
      logger.error('ebay-readback cron: run failed', {
        err: err instanceof Error ? err.message : String(err),
      })
    })
  })
  logger.info('ebay-readback cron started', { schedule })
}
