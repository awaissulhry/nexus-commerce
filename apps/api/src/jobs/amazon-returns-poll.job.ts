/**
 * R4.3 — Amazon returns report poller cron.
 *
 * Default schedule: every hour. Each tick pulls both
 * GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE (FBM) and
 * GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA (FBA) for the past 25
 * hours so a 24-hour run guarantees no row falls through the
 * cracks. Idempotency lives in the ingest service; re-polling is
 * always safe.
 *
 * Default-OFF in development. Flip
 * NEXUS_ENABLE_AMAZON_RETURNS_POLL=1 to enable; the wiring lives in
 * apps/api/src/index.ts.
 *
 * Hourly is the right cadence because:
 *   - Amazon's report-generation latency is 5-30 minutes; tighter
 *     polling burns the SP-API report quota with no fresher data.
 *   - Operators want returns visible same-day, not same-minute —
 *     these aren't channel webhooks, they're back-office sweeps.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { pollAmazonReturns } from '../services/amazon-returns/ingest.service.js'
import { recordCronRun } from '../utils/cron-observability.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

async function runPollSweep(): Promise<void> {
  const startedAt = Date.now()
  await recordCronRun('amazon-returns-poll', async () => {
    const result = await pollAmazonReturns()
    logger.info('amazon-returns cron: tick complete', {
      durationMs: Date.now() - startedAt,
      ...result,
    })
    return `fbmCreated=${result.fbmCreated} fbmDup=${result.fbmDuplicate} fbmFailed=${result.fbmFailed} fbaCreated=${result.fbaCreated} fbaDup=${result.fbaDuplicate} fbaFailed=${result.fbaFailed}`
  }).catch((err) => {
    logger.error('amazon-returns cron: failure', {
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    })
  })
}

export function startAmazonReturnsPollCron(): void {
  if (scheduledTask) {
    logger.warn('amazon-returns cron already started — skipping')
    return
  }
  if (process.env.NEXUS_ENABLE_AMAZON_RETURNS_POLL !== '1') {
    logger.info('amazon-returns cron: disabled (set NEXUS_ENABLE_AMAZON_RETURNS_POLL=1 to enable)')
    return
  }
  // Top of every hour by default. Off-by-one minute if other crons
  // already cluster at :00 — bump via env if needed.
  const schedule = process.env.NEXUS_AMAZON_RETURNS_POLL_SCHEDULE ?? '0 * * * *'
  if (!cron.validate(schedule)) {
    logger.error('amazon-returns cron: invalid schedule expression', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void runPollSweep()
  })
  logger.info('amazon-returns cron: scheduled', { schedule })
}

export function stopAmazonReturnsPollCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getAmazonReturnsPollCronStatus(): {
  enabled: boolean
  scheduled: boolean
  schedule: string | null
} {
  return {
    enabled: process.env.NEXUS_ENABLE_AMAZON_RETURNS_POLL === '1',
    scheduled: scheduledTask !== null,
    schedule: process.env.NEXUS_AMAZON_RETURNS_POLL_SCHEDULE ?? '0 * * * *',
  }
}

export { runPollSweep }
