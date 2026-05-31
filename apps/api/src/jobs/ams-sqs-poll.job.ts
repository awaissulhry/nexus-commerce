/**
 * Apex B.1 — AMS SQS poll cron.
 *
 * Drains the AMS queue every minute (the active SP/SD/SB stream subscriptions
 * push hourly traffic/conversion records there), ingesting each into
 * AmazonAdsHourlyPerformance via ingestMarketingStream. Self-gated on
 * NEXUS_AMS_SQS_QUEUE_URL + AWS creds, so it stays dormant until the queue is
 * configured. This is read-from-SQS → write-to-our-DB only (no live Amazon
 * writes), so no write-gate concerns. Registered in CRON_REGISTRY for manual
 * triggering.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { isAmsSqsConfigured, pollAmsRaw, deleteAmsMessage, parseAmsBody } from '../services/ams-sqs.service.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
const MAX_BATCHES_PER_TICK = 5 // drain up to ~50 messages/tick

export async function runAmsSqsPoll(): Promise<void> {
  if (!isAmsSqsConfigured()) return
  try {
    await recordCronRun('ams-sqs-poll', async () => {
      const { ingestMarketingStream } = await import('../services/advertising/ads-marketing-stream.service.js')
      let received = 0
      let upserted = 0
      let deleted = 0
      let failed = 0
      for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
        const raw = await pollAmsRaw(10)
        if (raw.length === 0) break
        for (const msg of raw) {
          try {
            const records = parseAmsBody(msg.body)
            received += records.length
            if (records.length > 0) {
              const res = await ingestMarketingStream(records as never)
              upserted += res.upserted
            }
            // Ack even when 0 records (e.g. a non-perf dataset we skip) — leaving
            // it would just redeliver forever.
            await deleteAmsMessage(msg.receiptHandle)
            deleted += 1
          } catch (err) {
            // Don't delete → SQS redelivers after the visibility timeout.
            failed += 1
            logger.warn('[ams-sqs-poll] message failed (will redeliver)', { error: err instanceof Error ? err.message : String(err) })
          }
        }
      }
      return `received=${received} upserted=${upserted} deleted=${deleted} failed=${failed}`
    })
  } catch (err) {
    logger.error('ams-sqs-poll cron: failure', { error: err instanceof Error ? err.message : String(err) })
  }
}

export function startAmsSqsPollCron(): void {
  if (scheduledTask) {
    logger.warn('ams-sqs-poll cron already started')
    return
  }
  if (!isAmsSqsConfigured()) {
    logger.info('ams-sqs-poll NOT scheduled (NEXUS_AMS_SQS_QUEUE_URL + AWS creds not set) — manual trigger still available')
    return
  }
  scheduledTask = cron.schedule('* * * * *', () => void runAmsSqsPoll())
  logger.info('ams-sqs-poll cron scheduled (* * * * *)')
}
