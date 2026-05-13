/**
 * IS.2 — Real-time Amazon order detection via SP-API Notifications + SQS.
 *
 * Runs every 30 seconds (two ticks per cron minute using setInterval inside
 * the cron handler). When Amazon places or updates a FBM order it pushes an
 * ORDER_CHANGE notification to the configured SQS queue; this job drains
 * that queue so the stock cascade fires in ~30–90 seconds rather than waiting
 * for the 15-min polling cron.
 *
 * Gate: NEXUS_ENABLE_AMAZON_SQS_POLL=1 AND AMAZON_SQS_QUEUE_URL set.
 *
 * For setup instructions see docs/IS-SETUP.md.
 */

import cron from 'node-cron'
import { isSqsConfigured, pollSqsMessages, deleteSqsMessage } from '../services/amazon-sqs.service.js'
import { amazonOrdersService } from '../services/amazon-orders.service.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let running = false

async function runSqsPoll(): Promise<void> {
  if (running) return   // skip if previous tick is still in flight
  if (!isSqsConfigured()) return
  if (!amazonOrdersService.isConfigured()) return

  running = true
  try {
    await recordCronRun('amazon-sqs-poll', async () => {
      const messages = await pollSqsMessages(10)
      if (messages.length === 0) return 'no messages'

      let processed = 0
      let skipped = 0

      for (const msg of messages) {
        const { amazonOrderId, orderStatus, fulfillmentType } = msg.notification

        // FBA orders are managed by Amazon's warehouse — no stock action needed here.
        if (fulfillmentType === 'AFN') {
          await deleteSqsMessage(msg.receiptHandle)
          skipped++
          continue
        }

        try {
          // syncNewOrders with a very short window covers this specific order
          // (SP-API returns it by LastUpdatedAfter). Idempotent — the service
          // upserts on (channel, channelOrderId).
          const since = new Date(Date.now() - 5 * 60 * 1000) // last 5 min
          await amazonOrdersService.syncNewOrders(since, { limit: 50 })
          processed++
          logger.info('[SQS poll] processed ORDER_CHANGE', { amazonOrderId, orderStatus })
        } catch (err) {
          logger.warn('[SQS poll] order sync failed', {
            amazonOrderId,
            error: err instanceof Error ? err.message : String(err),
          })
          // Don't delete — let SQS retry (visibility timeout will expire)
          continue
        }

        await deleteSqsMessage(msg.receiptHandle)
      }

      return `messages=${messages.length} processed=${processed} skipped=${skipped}`
    })
  } finally {
    running = false
  }
}

export function startAmazonSqsPollCron(): void {
  if (!process.env.NEXUS_ENABLE_AMAZON_SQS_POLL || process.env.NEXUS_ENABLE_AMAZON_SQS_POLL !== '1') return
  if (!isSqsConfigured()) {
    logger.info('amazon-sqs-poll: AMAZON_SQS_QUEUE_URL not configured — skipping')
    return
  }
  if (scheduledTask) {
    logger.warn('amazon-sqs-poll: already started')
    return
  }

  // Every minute in cron; we run the poll twice per tick (at 0s and 30s)
  // using a setTimeout so effective interval is ~30 seconds.
  scheduledTask = cron.schedule('* * * * *', () => {
    void runSqsPoll()
    setTimeout(() => { void runSqsPoll() }, 30_000)
  })

  logger.info('amazon-sqs-poll: started (every ~30s)')
}

export function stopAmazonSqsPollCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}
