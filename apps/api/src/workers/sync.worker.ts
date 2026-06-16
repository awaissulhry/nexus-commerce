/**
 * Phase 11: The Autopilot - Background Sync Worker
 * 
 * Runs every minute to automatically process pending outbound syncs.
 * Prevents duplicate processing with a lock mechanism.
 */

import cron from 'node-cron'
import OutboundSyncService, { withTimeout } from '../services/outbound-sync.service.js'
import { logger } from '../utils/logger.js'

// Lock mechanism to prevent overlapping sync jobs
let isProcessing = false
let lastProcessingTime = 0
let syncCount = 0
let errorCount = 0

/**
 * A2.3 — when BullMQ is enabled, build a predicate that skips rows already owned
 * by a live BullMQ job, so this cron only sweeps orphans (rows written without a
 * job, or jobs that died) instead of racing the BullMQ worker on every row. When
 * BullMQ is off, returns null → the cron is the sole consumer and drains all.
 */
async function buildBullMQSkip(): Promise<((queueId: string) => Promise<boolean>) | null> {
  if (process.env.ENABLE_QUEUE_WORKERS !== '1') return null
  try {
    const { outboundSyncQueue } = await import('../lib/queue.js')
    return async (queueId: string): Promise<boolean> => {
      try {
        // PD-Q — Redis can HANG (not just error) when unreachable; a bare await
        // here wedged the whole sync loop (isProcessing stuck → backlog). Bound
        // the Redis calls so a hang fails open (process the row, we're the backstop).
        const job = await withTimeout(outboundSyncQueue.getJob(queueId), 3000, 'getJob')
        if (!job) return false
        const state = await withTimeout(job.getState(), 3000, 'getState')
        return ['waiting', 'active', 'delayed', 'prioritized', 'waiting-children'].includes(state)
      } catch {
        return false // Redis hiccup/timeout → don't skip; process it (BullMQ may be down → we're the backstop)
      }
    }
  } catch {
    return null // queue lib unavailable → process everything
  }
}

/**
 * Initialize the background sync worker
 * Runs every minute (* * * * *)
 */
export function initializeSyncWorker() {
  logger.info('🤖 Initializing Autopilot Sync Worker...')

  // PD-Q — if a cycle ever wedges (hung downstream call), isProcessing would
  // stick true forever and every later cycle would skip → silent backlog. After
  // STALE_LOCK_MS we presume the previous cycle dead and force-reset, so the
  // worker self-heals instead of deadlocking.
  const STALE_LOCK_MS = Math.max(60_000, Number(process.env.NEXUS_SYNC_STALE_LOCK_MS ?? '300000') || 300_000)

  // Schedule the cron job to run every minute
  const job = cron.schedule('* * * * *', async () => {
    // Prevent overlapping executions
    if (isProcessing) {
      const heldMs = Date.now() - lastProcessingTime
      if (heldMs > STALE_LOCK_MS) {
        logger.error('🔓 Sync worker lock stuck — force-resetting (previous cycle presumed dead)', {
          heldMs,
          lastProcessingTime: new Date(lastProcessingTime).toISOString(),
        })
        isProcessing = false // fall through and run this cycle
      } else {
        logger.warn('⏳ Previous sync still processing, skipping this cycle', {
          lastProcessingTime: new Date(lastProcessingTime).toISOString(),
          elapsedSeconds: Math.round(heldMs / 1000),
        })
        return
      }
    }

    isProcessing = true
    lastProcessingTime = Date.now()
    const cycleStartTime = Date.now()

    try {
      logger.info('💓 Autopilot Heartbeat - Starting sync cycle', {
        timestamp: new Date().toISOString(),
        cycleNumber: syncCount + 1,
      })

      // A2.3 — backstop mode: skip BullMQ-owned rows when BullMQ is enabled.
      const skip = await buildBullMQSkip()
      const result = await OutboundSyncService.processPendingSyncs(skip ? { skip } : undefined)

      const processingTime = Date.now() - cycleStartTime

      if (result.processed > 0) {
        logger.info('✅ Autopilot Sync Completed', {
          processed: result.processed,
          succeeded: result.succeeded,
          failed: result.failed,
          skipped: result.skipped,
          processingTimeMs: processingTime,
          timestamp: new Date().toISOString(),
        })
        syncCount++
      } else {
        logger.debug('⏸️ No pending syncs in queue', {
          processingTimeMs: processingTime,
          timestamp: new Date().toISOString(),
        })
      }
    } catch (error) {
      errorCount++
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error('❌ Autopilot Sync Error', {
        error: errorMsg,
        errorCount,
        timestamp: new Date().toISOString(),
        stack: error instanceof Error ? error.stack : undefined,
      })
    } finally {
      isProcessing = false
    }
  })

  // Log startup confirmation
  logger.info('🚀 Autopilot Sync Worker Started', {
    schedule: 'Every minute (* * * * *)',
    lockMechanism: 'Enabled (prevents overlapping)',
    timestamp: new Date().toISOString(),
  })

  // Return the job for potential cleanup
  return job
}

/**
 * Get worker status for monitoring
 */
export function getSyncWorkerStatus() {
  return {
    isRunning: true,
    isProcessing,
    totalSyncsProcessed: syncCount,
    totalErrors: errorCount,
    lastProcessingTime: lastProcessingTime ? new Date(lastProcessingTime).toISOString() : null,
    uptime: new Date().toISOString(),
  }
}

/**
 * Reset worker statistics (for testing/debugging)
 */
export function resetSyncWorkerStats() {
  syncCount = 0
  errorCount = 0
  isProcessing = false
  lastProcessingTime = 0
  logger.info('🔄 Autopilot Worker stats reset')
}
