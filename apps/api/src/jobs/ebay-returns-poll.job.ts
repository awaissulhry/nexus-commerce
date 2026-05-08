/**
 * R4.2 — eBay returns poller cron.
 *
 * Default schedule: every 5 minutes. Each tick walks active OAuth-
 * managed eBay connections, polls the Post Order Return /search
 * endpoint for OPEN returns, and ingests them into Nexus Return
 * rows. Idempotency is handled by the ingest service via channel-
 * ReturnId — re-polling the same return is a no-op.
 *
 * Default-OFF in development. Flip NEXUS_ENABLE_EBAY_RETURNS_POLL=1
 * to enable; the wiring lives in apps/api/src/index.ts.
 *
 * Most other crons run reactively (the eBay token refresh cron at
 * 30 min is a good baseline); 5 min for returns is defensible
 * because eBay's RBM (Resolution Centre) escalates "no seller
 * response" within hours and operators want to see the case land
 * in Nexus quickly.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { pollEbayReturns } from '../services/ebay-returns/ingest.service.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

async function runPollSweep(): Promise<void> {
  const startedAt = Date.now()
  try {
    const result = await pollEbayReturns()
    logger.info('ebay-returns-poll cron: tick complete', {
      durationMs: Date.now() - startedAt,
      ...result,
    })
  } catch (err) {
    logger.error('ebay-returns-poll cron: failure', {
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startEbayReturnsPollCron(): void {
  if (scheduledTask) {
    logger.warn('ebay-returns-poll cron already started — skipping')
    return
  }
  if (process.env.NEXUS_ENABLE_EBAY_RETURNS_POLL !== '1') {
    logger.info('ebay-returns-poll cron: disabled (set NEXUS_ENABLE_EBAY_RETURNS_POLL=1 to enable)')
    return
  }
  const schedule = process.env.NEXUS_EBAY_RETURNS_POLL_SCHEDULE ?? '*/5 * * * *'
  if (!cron.validate(schedule)) {
    logger.error('ebay-returns-poll cron: invalid schedule expression', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void runPollSweep()
  })
  logger.info('ebay-returns-poll cron: scheduled', { schedule })
}

export function stopEbayReturnsPollCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getEbayReturnsPollCronStatus(): {
  enabled: boolean
  scheduled: boolean
  schedule: string | null
} {
  return {
    enabled: process.env.NEXUS_ENABLE_EBAY_RETURNS_POLL === '1',
    scheduled: scheduledTask !== null,
    schedule: process.env.NEXUS_EBAY_RETURNS_POLL_SCHEDULE ?? '*/5 * * * *',
  }
}

export { runPollSweep }
