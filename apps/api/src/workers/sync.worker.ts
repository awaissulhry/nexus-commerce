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

      // Call the existing OutboundSyncService
      const result = await OutboundSyncService.processPendingSyncs()

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
