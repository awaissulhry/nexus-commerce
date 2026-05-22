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
import prisma from '../db.js'

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
        // P3.4 — Persist to WebhookEvent so the message appears in
        // /sync-logs/webhooks and can be replayed. Upsert on (channel, externalId)
        // so polling the same message twice (before ack) is idempotent.
        //
        // RT.3 — capture the SP-API EventTime (when Amazon emitted the
        // notification) so /api/admin/push-latency can compute the
        // (ingestedAt - providerTimestamp) percentile per source.
        let webhookEventId: string | null = null
        if (msg.messageId) {
          const raw = msg.rawPayload as any
          const eventTimeRaw =
            raw?.EventTime ?? raw?.eventTime ?? raw?.Payload?.EventTime ?? null
          const providerTimestamp =
            typeof eventTimeRaw === 'string' && !Number.isNaN(Date.parse(eventTimeRaw))
              ? new Date(eventTimeRaw)
              : null
          try {
            const we = await prisma.webhookEvent.upsert({
              where: { channel_externalId: { channel: 'AMAZON', externalId: msg.messageId } },
              create: {
                channel: 'AMAZON',
                eventType: msg.notificationType,
                externalId: msg.messageId,
                payload: msg.rawPayload as any,
                isProcessed: false,
                providerTimestamp,
              },
              update: {},  // don't overwrite if already persisted
              select: { id: true },
            })
            webhookEventId = we.id
          } catch {
            // Non-fatal — proceed with processing regardless
          }
        }

        // RT.6 — FBA Outbound (Multi-Channel Fulfillment) shipment
        // status path. Calls syncMCFStatus inline so MCF status updates
        // land in ~30s instead of waiting for the 15-min cron tick.
        // Uses the same unconfiguredAdapter as the 15-min cron until
        // AMAZON_MCF_LIVE is wired with a real SP-API adapter — at
        // that point both code paths pick up the production client.
        if (msg.mcfNotification) {
          const { sellerFulfillmentOrderId, status } = msg.mcfNotification
          try {
            if (sellerFulfillmentOrderId) {
              const { syncMCFStatus, unconfiguredAdapter } = await import(
                '../services/amazon-mcf.service.js'
              )
              await syncMCFStatus(unconfiguredAdapter, sellerFulfillmentOrderId)
            }
            await deleteSqsMessage(msg.receiptHandle)
            if (webhookEventId) {
              await prisma.webhookEvent.update({
                where: { id: webhookEventId },
                data: { isProcessed: true, processedAt: new Date() },
              }).catch(() => {})
            }
            processed++
            logger.info('[SQS poll] processed FBA_OUTBOUND_SHIPMENT_STATUS', {
              sellerFulfillmentOrderId,
              status,
            })
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            // unconfiguredAdapter throws by design — log + ack so we
            // don't loop. Production adapter will replace this.
            const isUnconfigured = /not configured|unconfigured/i.test(errMsg)
            if (isUnconfigured) {
              await deleteSqsMessage(msg.receiptHandle)
              if (webhookEventId) {
                await prisma.webhookEvent.update({
                  where: { id: webhookEventId },
                  data: {
                    isProcessed: true,
                    processedAt: new Date(),
                    error: 'MCF adapter not configured — see AMAZON_MCF_LIVE',
                  },
                }).catch(() => {})
              }
              skipped++
              logger.info('[SQS poll] MCF adapter unconfigured — acked', {
                sellerFulfillmentOrderId,
              })
            } else {
              logger.warn('[SQS poll] MCF status sync failed', {
                sellerFulfillmentOrderId,
                error: errMsg,
              })
              if (webhookEventId) {
                await prisma.webhookEvent.update({
                  where: { id: webhookEventId },
                  data: { error: errMsg.slice(0, 2000) },
                }).catch(() => {})
              }
              // Don't delete — let SQS retry (visibility timeout will expire)
            }
          }
          continue
        }

        if (!msg.notification) {
          // Defensive — unknown notification shape. Persisted to
          // WebhookEvent for forensics; ack so we don't loop.
          await deleteSqsMessage(msg.receiptHandle)
          skipped++
          continue
        }
        const { amazonOrderId, orderStatus, fulfillmentType } = msg.notification

        // FBA orders are managed by Amazon's warehouse — no stock action needed here.
        if (fulfillmentType === 'AFN') {
          await deleteSqsMessage(msg.receiptHandle)
          if (webhookEventId) {
            await prisma.webhookEvent.update({
              where: { id: webhookEventId },
              data: { isProcessed: true, processedAt: new Date() },
            }).catch(() => {})
          }
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

          if (webhookEventId) {
            await prisma.webhookEvent.update({
              where: { id: webhookEventId },
              data: { isProcessed: true, processedAt: new Date() },
            }).catch(() => {})
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          logger.warn('[SQS poll] order sync failed', { amazonOrderId, error: errMsg })

          if (webhookEventId) {
            await prisma.webhookEvent.update({
              where: { id: webhookEventId },
              data: { error: errMsg.slice(0, 2000) },
            }).catch(() => {})
          }
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
