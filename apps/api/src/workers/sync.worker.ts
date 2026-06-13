/**
 * Phase 11: The Autopilot - Background Sync Worker
 * 
 * Runs every minute to automatically process pending outbound syncs.
 * Prevents duplicate processing with a lock mechanism.
 */

import cron from 'node-cron'
import OutboundSyncService from '../services/outbound-sync.service.js'
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
        const job = await outboundSyncQueue.getJob(queueId)
        if (!job) return false
        const state = await job.getState()
        return ['waiting', 'active', 'delayed', 'prioritized', 'waiting-children'].includes(state)
      } catch {
        return false // Redis hiccup → don't skip; process it (BullMQ may be down → we're the backstop)
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

  // Schedule the cron job to run every minute
  const job = cron.schedule('* * * * *', async () => {
    // Prevent overlapping executions
    if (isProcessing) {
      logger.warn('⏳ Previous sync still processing, skipping this cycle', {
        lastProcessingTime: new Date(lastProcessingTime).toISOString(),
        elapsedSeconds: Math.round((Date.now() - lastProcessingTime) / 1000),
      })
      return
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
