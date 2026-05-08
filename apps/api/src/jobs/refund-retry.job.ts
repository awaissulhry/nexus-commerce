/**
 * R5.3 — failed-refund retry cron.
 *
 * Default schedule: hourly. Each tick walks Returns where
 * refundStatus='CHANNEL_FAILED', filters to those past their
 * exponential-backoff window, and re-runs the channel publisher.
 * Outcomes accumulate in Refund + RefundAttempt rows so the audit
 * trail survives the restart.
 *
 * Default-OFF in development. Operators flip
 * NEXUS_ENABLE_REFUND_RETRY=1 in production once the channel
 * adapters are confirmed live (eBay needs OAuth, Shopify needs
 * NEXUS_ENABLE_SHOPIFY_REFUND=true). Running this cron with stub
 * adapters would just churn — every retry returns NOT_IMPLEMENTED
 * which the service treats as success and clears CHANNEL_FAILED,
 * masking the real issue.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { processRetryQueue } from '../services/refunds/retry.service.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

async function runRetrySweep(): Promise<void> {
  const startedAt = Date.now()
  try {
    const result = await processRetryQueue()
    logger.info('refund-retry cron: tick complete', {
      durationMs: Date.now() - startedAt,
      ...result,
    })
  } catch (err) {
    logger.error('refund-retry cron: failure', {
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startRefundRetryCron(): void {
  if (scheduledTask) {
    logger.warn('refund-retry cron already started — skipping')
    return
  }
  if (process.env.NEXUS_ENABLE_REFUND_RETRY !== '1') {
    logger.info('refund-retry cron: disabled (set NEXUS_ENABLE_REFUND_RETRY=1 to enable)')
    return
  }
  // 5 past the hour to dodge other on-the-hour crons clustering.
  const schedule = process.env.NEXUS_REFUND_RETRY_SCHEDULE ?? '5 * * * *'
  if (!cron.validate(schedule)) {
    logger.error('refund-retry cron: invalid schedule expression', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void runRetrySweep()
  })
  logger.info('refund-retry cron: scheduled', { schedule })
}

export function stopRefundRetryCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getRefundRetryCronStatus(): {
  enabled: boolean
  scheduled: boolean
  schedule: string | null
} {
  return {
    enabled: process.env.NEXUS_ENABLE_REFUND_RETRY === '1',
    scheduled: scheduledTask !== null,
    schedule: process.env.NEXUS_REFUND_RETRY_SCHEDULE ?? '5 * * * *',
  }
}

export { runRetrySweep }
