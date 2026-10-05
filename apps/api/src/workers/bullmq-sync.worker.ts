/**
 * Phase 13: Infrastructure Scale-Up - BullMQ Autopilot Worker
 *
 * Enterprise-grade message broker replacing node-cron polling
 * - Event-driven architecture with Redis backing
 * - Concurrency control (5 workers) to respect Amazon rate limits
 * - Grace period support via BullMQ native scheduling
 * - Automatic retry with exponential backoff
 */

import { DelayedError, Job } from 'bullmq'
import { WorkspaceWorker as Worker } from '../lib/workspace-jobs.js'
import { prisma } from '@nexus/database'
import { redis } from '../lib/queue.js'
import { logger } from '../utils/logger.js'
import { variationSyncProcessor } from '../services/variation-sync-processor.service.js'
import OutboundSyncService, { computeFailureDisposition, completedSyncQueueData, startAfterAnswer } from '../services/outbound-sync.service.js'
import { dispatchChannelDelist, applyDelistResultToQueue } from '../services/channel-delist.service.js'
import { productEventService } from '../services/product-event.service.js'
import { recordListingSyncOutcome } from '../services/listing-sync-outcome.js'

// Worker statistics
let processedCount = 0
let successCount = 0
let failureCount = 0
let cancelledCount = 0

/**
 * Initialize the BullMQ worker for outbound sync processing
 */
export function initializeBullMQWorker() {
  logger.info('🚀 Initializing BullMQ Autopilot Worker...')

  const worker = new Worker('outbound-sync', processOutboundSyncJob, {
    connection: redis.connection,
    concurrency: 5, // Respect Amazon rate limits
  })

  // Event listeners
  worker.on('completed', (job, result) => {
    if (result?.lifecycle) {
      logger.debug('Lifecycle attempt completed', { queueId: job.data.queueId, status: result.status })
      return // The lifecycle branch counts real acknowledgements only.
    }
    if (result?.status === 'SKIPPED') {
      logger.debug('Sync attempt skipped', { queueId: job.data.queueId })
      return
    }
    logger.debug('✅ Job completed', {
      jobId: job.id,
      queueId: job.data.queueId,
      processingTime: job.finishedOn ? job.finishedOn - job.processedOn! : 0,
    })
    successCount++
  })

  worker.on('failed', (job, error) => {
    logger.warn('❌ Job failed', {
      jobId: job?.id,
      queueId: job?.data?.queueId,
      error: error.message,
      attempt: job?.attemptsMade,
      maxAttempts: job?.opts.attempts,
    })
    failureCount++
  })

  worker.on('error', (error) => {
    logger.error('🔴 Worker error', {
      error: error instanceof Error ? error.message : String(error),
    })
  })

  logger.info('✅ BullMQ Autopilot Worker Started', {
    concurrency: 5,
    queueName: 'outbound-sync',
    timestamp: new Date().toISOString(),
  })

  return worker
}

/**
 * Process a single outbound sync job
 * 
 * Job data structure:
 * {
 *   queueId: string (OutboundSyncQueue.id)
 *   productId: string
 *   channelListingId: string
 *   targetChannel: string
 *   syncType: string
 * }
 */
/**
 * P1.3 — per-account concurrency. The worker runs 5 jobs at a time for all channels together; one
 * account's backlog could take all 5 and starve every other account. A job whose account already has
 * `NEXUS_OUTBOUND_ACCOUNT_CONCURRENCY` (default 2) jobs running in this process is postponed ~1 s with
 * BullMQ's own delayed move — not a failure, no attempt used. A row without an account is not limited.
 */
const accountRunning = new Map<string, number>()
const accountLimit = () => Math.max(1, Number(process.env.NEXUS_OUTBOUND_ACCOUNT_CONCURRENCY) || 2)
const ACCOUNT_BUSY_DELAY_MS = 1000

export async function takeAccountSlot(job: Job, token: string | undefined): Promise<(() => void) | null> {
  if (!token) return null // called outside a worker (tests, manual runs): nothing to postpone
  const row = await prisma.outboundSyncQueue.findUnique({ where: { id: job.data?.queueId }, select: { channelConnectionId: true } }).catch(() => null)
  const account = row?.channelConnectionId
  if (!account) return null
  const running = accountRunning.get(account) ?? 0
  if (running >= accountLimit()) {
    await job.moveToDelayed(Date.now() + ACCOUNT_BUSY_DELAY_MS + Math.floor(Math.random() * 250), token)
    throw new DelayedError()
  }
  accountRunning.set(account, running + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const now = (accountRunning.get(account) ?? 1) - 1
    if (now <= 0) accountRunning.delete(account)
    else accountRunning.set(account, now)
  }
}

export const __accountSlotsTest = { running: (account: string) => accountRunning.get(account) ?? 0, reset: () => accountRunning.clear() }

export async function processOutboundSyncJob(job: Job, token?: string) {
  const release = await takeAccountSlot(job, token)
  try {
    return await processOutboundSyncJobInner(job)
  } finally {
    release?.()
  }
}

async function processOutboundSyncJobInner(job: Job) {
  const { queueId, productId, channelListingId, targetChannel, syncType } = job.data

  logger.info('⚙️ Processing sync job', {
    jobId: job.id,
    queueId,
    productId,
    targetChannel,
    syncType,
    attempt: job.attemptsMade + 1,
  })

  try {
    // ─────────────────────────────────────────────────────────────────────
    // CRUCIAL CHECK: Grace Period (Phase 12a)
    // If user hit "Undo" during grace period, syncStatus will be CANCELLED
    // ─────────────────────────────────────────────────────────────────────
    const queueRecord = await prisma.outboundSyncQueue.findUnique({
      where: { id: queueId },
    })

    if (!queueRecord) {
      logger.warn('Queue record not found', { queueId })
      throw new Error(`Queue record ${queueId} not found`)
    }

    // If user cancelled during grace period, skip processing
    if ((queueRecord.syncStatus as any) === 'CANCELLED') {
      logger.info('⏭️ Skipping cancelled sync', {
        queueId,
        productId,
        reason: 'User cancelled during grace period',
      })
      cancelledCount++
      return { status: 'CANCELLED', queueId, ...((queueRecord.syncType === 'UNPUBLISH_LISTING' || queueRecord.syncType === 'DELETE_LISTING') ? { lifecycle: true } : {}) }
    }

    // Verify status is still PENDING
    if (queueRecord.syncStatus !== 'PENDING') {
      logger.warn('Queue record not in PENDING status', {
        queueId,
        currentStatus: queueRecord.syncStatus,
      })
      return { status: 'SKIPPED', queueId, reason: 'Not in PENDING status', ...((queueRecord.syncType === 'UNPUBLISH_LISTING' || queueRecord.syncType === 'DELETE_LISTING') ? { lifecycle: true } : {}) }
    }

    // ─────────────────────────────────────────────────────────────────────
    // D.2 — Delist branch. UNPUBLISH_LISTING / DELETE_LISTING rows are
    // enqueued by /products bulk-hard-delete (D.1) to push the local
    // delete out to Amazon/eBay/Shopify. By the time we drain, the
    // Product + ChannelListing rows are typically gone, so we skip
    // every downstream check (publishing controls, pricing recompute,
    // VARIATION_SYNC routing) and go straight to the channel adapter
    // using only the data on the OutboundSyncQueue row itself.
    if (queueRecord.syncType === 'UNPUBLISH_LISTING' || queueRecord.syncType === 'DELETE_LISTING') {
      // BullMQ delays are advisory; enforce the stored grace/retry hold and
      // atomically compete with cancellation/the cron on this lifecycle row.
      const now = new Date()
      if (queueRecord.holdUntil && queueRecord.holdUntil > now) {
        return { status: 'SKIPPED', queueId, lifecycle: true, reason: 'Still within grace window' }
      }
      const claimed = await prisma.outboundSyncQueue.updateMany({
        where: { id: queueId, syncStatus: 'PENDING', OR: [{ holdUntil: null }, { holdUntil: { lte: now } }] },
        data: { syncStatus: 'IN_PROGRESS' },
      })
      if (!claimed.count) return { status: 'SKIPPED', queueId, lifecycle: true, reason: 'Lost dispatch claim' }
      const result = await dispatchChannelDelist({
        queueId,
        productId: queueRecord.productId,
        channelListingId: queueRecord.channelListingId,
        targetChannel: queueRecord.targetChannel,
        targetRegion: queueRecord.targetRegion,
        externalListingId: queueRecord.externalListingId,
        syncType: queueRecord.syncType,
        payload: queueRecord.payload,
      })
      await applyDelistResultToQueue(queueId, result)
      if (result.dryRun) return { status: 'SKIPPED', queueId, lifecycle: true, result }
      if (result.outcome === 'UNKNOWN') {
        return { status: 'UNKNOWN', queueId, lifecycle: true, result }
      }
      if (result.success) {
        successCount++
        return { status: 'SUCCESS', queueId, lifecycle: true, result }
      }
      failureCount++
      return { status: 'FAILED', queueId, lifecycle: true, result }
    }

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 15: Publishing Control Checks
    // Skip sync if listing is unpublished or offers are inactive
    // ─────────────────────────────────────────────────────────────────────
    if (channelListingId) {
      const channelListing = await prisma.channelListing.findUnique({
        where: { id: channelListingId },
        include: { offers: true },
      })

      if (!channelListing) {
        logger.warn('Channel listing not found', { channelListingId })
        throw new Error(`Channel listing ${channelListingId} not found`)
      }

      // Check if listing is published
      if (!channelListing.isPublished) {
        logger.info('⏭️ Skipping unpublished listing', {
          queueId,
          channelListingId,
          reason: 'Listing isPublished = false',
        })
        await prisma.outboundSyncQueue.update({
          where: { id: queueId },
          data: {
            syncStatus: 'SKIPPED',
            errorMessage: 'Listing is unpublished (isPublished = false)',
          },
        })
        return { status: 'SKIPPED', queueId, reason: 'Listing unpublished' }
      }

      // Check if all offers are inactive (for offer-specific syncs)
      if (syncType === 'OFFER_SYNC' && channelListing.offers.length > 0) {
        const activeOffers = channelListing.offers.filter((o) => o.isActive !== false)
        if (activeOffers.length === 0) {
          logger.info('⏭️ Skipping sync with no active offers', {
            queueId,
            channelListingId,
            reason: 'All offers are inactive',
          })
          await prisma.outboundSyncQueue.update({
            where: { id: queueId },
            data: {
              syncStatus: 'SKIPPED',
              errorMessage: 'No active offers to sync',
            },
          })
          return { status: 'SKIPPED', queueId, reason: 'No active offers' }
        }
      }
    }

    // 2026-10-01 — the PHASE 28 "pricing calculation" that stood here is gone. On a job carrying `channelListingId`
    // (the queue page's retries, the matrix's retry) it rewrote `ChannelListing.price` with the repricer's
    // `calculateTargetPrice` — a cost-margin floor no edit applies, and MATCH_AMAZON read as the master price — while
    // the dispatch below sends the row's own `payload.price`. So it stored a price that was never sent, and the next
    // reader saw a number the channel did not have. A following listing's price is computed when it changes — by the
    // master-price cascade and the channel price door, with the same rules (`services/pim/follower-price.ts`) — and
    // the row carries exactly the price that is stored.

    // ─────────────────────────────────────────────────────────────────────
    // SYNC PROCESSING
    // Route to appropriate sync processor based on syncType
    // ─────────────────────────────────────────────────────────────────────
    let syncResult: any

    if (syncType === 'VARIATION_SYNC') {
      // Phase 12d: Variation Sync Engine
      logger.info('🔄 Processing variation sync', { queueId, productId })
      syncResult = await variationSyncProcessor.processVariationSync(queueRecord)
    } else {
      // A2.2 — process ONLY this job's row. Was processPendingSyncs(), which
      // drained the WHOLE table per job (and set this queueId's status from the
      // batch's aggregate result). processSingle returns a real SyncResult for
      // this row, so the per-job status/retry update below is correct and the
      // jobId=queueId dedup finally takes effect.
      logger.info('🔄 Processing standard sync', { queueId, productId, targetChannel })
      syncResult = await OutboundSyncService.processSingle(queueId)
    }

    // ─────────────────────────────────────────────────────────────────────
    // UPDATE QUEUE RECORD
    // ─────────────────────────────────────────────────────────────────────
    // E2 (D5, 2026-10-05) — a row this job did not get (another run claimed it first, or already moved it on: the
    // cron backstop, or the Etsy lane sending it in one write with its listing's other rows) belongs to that run,
    // which records its answer. Writing PENDING/FAILED here would overwrite the winner's row, so nothing is written.
    if (!syncResult.success && (syncResult.error === 'claim-lost' || syncResult.error === 'not-pending')) {
      return { status: 'SKIPPED', queueId, reason: syncResult.message }
    }
    if (syncResult.success) {
      const completion = completedSyncQueueData(syncResult)
      await prisma.outboundSyncQueue.update({
        where: { id: queueId },
        data: {
          ...completion,
          payload: {
            ...(queueRecord.payload as any),
            processedBy: 'BullMQ',
            jobId: job.id,
          },
        },
      })
      // 2026-10-01 — the listing's own status follows the send (it stayed "Pending" after a successful send).
      if (completion.syncStatus === 'SUCCESS') await recordListingSyncOutcome(prisma, { channelListingId: queueRecord.channelListingId, productId: queueRecord.productId, outcome: 'sent' })
      // CX (review 2026-09-26) — report-only follow-up (the eBay price read-back) only once the row is written.
      startAfterAnswer(syncResult)

      logger.info(completion.syncStatus === 'SKIPPED' ? 'Sync skipped; nothing sent' : '✅ Sync completed successfully', {
        queueId,
        productId,
        targetChannel,
        processingTime: job.finishedOn ? job.finishedOn - job.processedOn! : 0,
      })

      processedCount++
      return { status: completion.syncStatus, queueId, result: syncResult }
    } else {
      // AS.1 — episode-class failures (circuit open / rate limited / debounced /
      // auth outage) must not consume the retry budget on this path either
      // (RT.0 gave the cron drain this semantics; the worker kept burning
      // budget on them). Park the row as a deferral and COMPLETE the job —
      // no BullMQ retry; the 60s cron re-arms the row once nextRetryAt is due.
      const disposition = computeFailureDisposition(
        queueRecord,
        syncResult.error || 'Unknown error',
        { errorCode: syncResult.errorCode, retryable: syncResult.retryable },
      )
      if (disposition.kind === 'deferral') {
        await prisma.outboundSyncQueue.update({
          where: { id: queueId },
          data: {
            syncStatus: 'FAILED',
            errorMessage: syncResult.error || 'Unknown error',
            errorCode: disposition.errorCode,
            // retryCount deliberately NOT incremented — the failure belongs
            // to the episode, not to this row.
            nextRetryAt: disposition.nextRetryAt,
            payload: {
              ...(queueRecord.payload as any),
              processedBy: 'BullMQ',
              jobId: job.id,
              lastError: syncResult.error,
            },
          },
        })
        logger.warn('⏸️ Sync deferred (episode-class failure, no budget spent)', {
          queueId,
          productId,
          errorCode: disposition.errorCode,
          nextRetryAt: disposition.nextRetryAt,
        })
        return { status: 'DEFERRED', queueId, errorCode: disposition.errorCode }
      }

      // Determine if this is a retryable error
      const isRetryable = syncResult.retryable !== false
      const newRetryCount = (queueRecord.retryCount || 0) + 1
      const exhausted = newRetryCount >= (queueRecord.maxRetries ?? 3)
      const nextRetryAt = isRetryable && !exhausted
        ? new Date(Date.now() + Math.pow(2, job.attemptsMade) * 5000)
        : null

      // RT.0 — a row is terminal when retries are exhausted OR the failure is
      // non-retryable (validation-class). Both shapes must dead-letter: a
      // terminal row without isDead is invisible to the DLQ tab forever.
      const terminal = exhausted || !isRetryable
      await prisma.outboundSyncQueue.update({
        where: { id: queueId },
        data: {
          syncStatus: (isRetryable && !exhausted) ? 'PENDING' : 'FAILED',
          errorMessage: syncResult.error || 'Unknown error',
          errorCode: syncResult.errorCode,
          retryCount: newRetryCount,
          nextRetryAt,
          // P3.2 — mark dead on any terminal outcome
          ...(terminal ? { isDead: true, diedAt: new Date() } : {}),
          payload: {
            ...(queueRecord.payload as any),
            processedBy: 'BullMQ',
            jobId: job.id,
            lastError: syncResult.error,
          },
        },
      })

      if (terminal) {
        await recordListingSyncOutcome(prisma, { channelListingId: queueRecord.channelListingId, productId: queueRecord.productId, outcome: 'failed', error: syncResult.error || 'Unknown error' })
        productEventService.emit({
          aggregateId: queueRecord.productId ?? queueId,
          aggregateType: 'ChannelListing',
          eventType: 'SYNC_DEAD',
          data: {
            queueId,
            channel: targetChannel,
            syncType,
            error: syncResult.error,
            retryCount: newRetryCount,
          },
          metadata: { source: 'SYSTEM' },
        }).catch(() => {})
      }

      if (isRetryable) {
        logger.warn('⚠️ Sync failed, will retry', {
          queueId,
          productId,
          error: syncResult.error,
          retryCount: (queueRecord.retryCount || 0) + 1,
          nextRetryAt,
        })
        throw new Error(syncResult.error) // BullMQ will retry
      } else {
        logger.error('❌ Sync failed permanently', {
          queueId,
          productId,
          error: syncResult.error,
          errorCode: syncResult.errorCode,
        })
        return { status: 'FAILED', queueId, error: syncResult.error }
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    const errorCode = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : undefined
    const disposition = computeFailureDisposition({ retryCount: job.attemptsMade ?? 0 }, errorMsg, { errorCode })
    if (disposition.kind === 'deferral') {
      await prisma.outboundSyncQueue.update({
        where: { id: queueId },
        data: { syncStatus: 'FAILED', errorMessage: errorMsg, errorCode: disposition.errorCode, nextRetryAt: disposition.nextRetryAt },
      })
      logger.warn('Sync deferred before dispatch completed; no retry budget spent', { queueId, errorCode: disposition.errorCode })
      return { status: 'DEFERRED', queueId, errorCode: disposition.errorCode }
    }
    logger.error('❌ Job processing error', {
      jobId: job.id,
      queueId,
      error: errorMsg,
      attempt: job.attemptsMade + 1,
      stack: error instanceof Error ? error.stack : undefined,
    })

    // Update queue record with error
    try {
      await prisma.outboundSyncQueue.update({
        where: { id: queueId },
        data: {
          errorMessage: errorMsg,
          retryCount: (job.attemptsMade || 0) + 1,
        },
      })
    } catch (updateError) {
      logger.error('Failed to update queue record with error', {
        queueId,
        error: updateError instanceof Error ? updateError.message : String(updateError),
      })
    }

    // Re-throw to let BullMQ handle retry
    throw error
  }
}

/**
 * Get worker statistics for monitoring
 */
export function getBullMQWorkerStats() {
  return {
    processed: processedCount,
    succeeded: successCount,
    failed: failureCount,
    cancelled: cancelledCount,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Reset worker statistics (for testing)
 */
export function resetBullMQWorkerStats() {
  processedCount = 0
  successCount = 0
  failureCount = 0
  cancelledCount = 0
  logger.info('🔄 BullMQ Worker stats reset')
}
