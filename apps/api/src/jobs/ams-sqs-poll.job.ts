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

import cron, { schedulePlatform } from '../lib/cron/clustered.js'
import { legacyIngress, verifiedChannelWorkspace, withIngressWorkspace } from '../lib/workspace-ingress.js'
import { completeInbound, inboundNotRecorded, recordInbound } from '../services/cx/ingress/ledger.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { isAmsSqsConfigured, pollAmsRaw, deleteAmsMessage, parseAmsBody } from '../services/ams-sqs.service.js'
import { amsRecordAdvertiser, routeRecords } from '../services/ads-core/ams-dataset.js'
import { ingestEntityChanges, ingestBudgetUsage } from '../services/advertising/ads-stream-change.service.js'

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
      let changed = 0
      let budgetEvents = 0
      let unmatched = 0
      let unknownDs = 0
      let duplicates = 0
      for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
        const raw = await pollAmsRaw(10)
        if (raw.length === 0) break
        for (const msg of raw) {
          try {
            const records = parseAmsBody(msg.body)
            received += records.length

            // P2.7 — dedupe, through the P2.1 inbound ledger.
            //
            // The hourly write INCREMENTS: Amazon sends corrections as deltas, so the
            // upsert's `update` adds rather than replaces. SQS is at-least-once, and
            // the visibility timeout here is 30 seconds against a batch that routes
            // each record to its own business profile — so a slow batch is redelivered
            // while the first pass is still applying, and the second pass adds the
            // same numbers again. Nothing errors. Spend, clicks and impressions are
            // simply larger than they were.
            //
            // The queue's own message id is the only thing that can tell those apart,
            // and `pollAmsRaw` was discarding it. It is now the ledger's key, which
            // also gives AMS the retry, dead-letter and replay the other channels got
            // in P2.1 — rather than a second dedupe table beside the first.
            //
            // Recorded in the platform's workspace: one message carries records for
            // several advertisers, so it belongs to no single business. The per-record
            // routing below is unchanged and still decides where the DATA goes.
            const seen = await legacyIngress(() => recordInbound({
              channel: 'AMAZON_ADS',
              eventType: String((records[0] as Record<string, unknown> | undefined)?.dataset_id ?? 'ams'),
              externalId: msg.messageId || undefined,
              payload: { messageId: msg.messageId, recordCount: records.length },
              // The queue's IAM policy is what establishes trust, as on the SP-API
              // side. `null` says that; `false` would claim a check failed.
              signatureOk: null,
              verifiedBy: 'sqs_iam',
              status: 'pending',
            }))
            if (!seen.id) {
              // Ledger first, same rule as the SP-API poller: without a row we cannot
              // tell a redelivery from a new message, and with an incrementing write
              // that is the one situation where guessing is expensive. Leave it on the
              // queue.
              logger.error(`[ams-sqs-poll] message retained: ${inboundNotRecorded(seen)}`, { messageId: msg.messageId })
              failed += 1
              continue
            }
            if (seen.duplicate && seen.existingStatus === 'done') {
              // Already applied. Ack it so it stops coming back, and do NOT ingest:
              // that is the double-count this whole block exists to prevent.
              duplicates += 1
              await deleteAmsMessage(msg.receiptHandle)
              deleted += 1
              continue
            }

            if (records.length > 0) {
              // AX-ZD.2 — three families arrive down one queue and answer
              // different questions. Previously everything went to the metrics
              // ingest, which SKIPped anything without traffic/conversion in
              // its id — so change and budget events were silently discarded.
              // IAM authenticates the shared queue; each record still needs its
              // own advertiser/profile destination before any business write.
              const batches = process.env.NEXUS_WORKSPACES_ENABLED === '1' ? records.map(record => [record]) : [records]
              for (const batchRecords of batches) {
              const ingest = async () => {
              const routed = routeRecords(batchRecords as Array<Record<string, unknown>>)
              if (routed.performance.length) {
                const res = await ingestMarketingStream(routed.performance as never)
                upserted += res.upserted
              }
              if (routed.change.length) {
                const c = await ingestEntityChanges(routed.change)
                changed += c.campaigns + c.adGroups + c.targets
                unmatched += c.unmatched
              }
              if (routed.budget.length) {
                const b = await ingestBudgetUsage(routed.budget)
                budgetEvents += b.exhausted + b.warning
              }
              if (routed.unknown.length) {
                // Visible, not invisible: an unrecognised dataset means Amazon
                // added one, and we should find out from a log rather than from
                // a gap in the data months later.
                unknownDs += routed.unknown.length
              }
              }
              if (process.env.NEXUS_WORKSPACES_ENABLED === '1') {
                const externalId = amsRecordAdvertiser(batchRecords[0] as Record<string, unknown>)
                if (!externalId) throw new Error('AMS record does not identify an advertiser.')
                const owner = await verifiedChannelWorkspace('AMAZON_ADS', externalId)
                await withIngressWorkspace(owner.workspaceId, ingest)
              } else await ingest()
              }
            }
            // Ack even when 0 records (e.g. a non-perf dataset we skip) — leaving
            // it would just redeliver forever.
            await legacyIngress(() => completeInbound(seen.id, true))
            await deleteAmsMessage(msg.receiptHandle)
            deleted += 1
          } catch (err) {
            // Don't delete → SQS redelivers after the visibility timeout. The ledger
            // row stays at `failed` with its reason, so a redelivery is recognised as
            // a retry of THIS message rather than as new data.
            failed += 1
            logger.warn('[ams-sqs-poll] message failed (will redeliver)', { error: err instanceof Error ? err.message : String(err) })
          }
        }
      }
      if (unknownDs > 0) {
        logger.warn('[ams-sqs-poll] unrecognised AMS dataset(s) received', { count: unknownDs })
      }
      return `received=${received} upserted=${upserted} changed=${changed} budget=${budgetEvents} unmatched=${unmatched} unknownDataset=${unknownDs} duplicates=${duplicates} deleted=${deleted} failed=${failed}`
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
  scheduledTask = schedulePlatform('* * * * *', async () => { await runAmsSqsPoll() })
  logger.info('ams-sqs-poll cron scheduled (* * * * *)')
}
