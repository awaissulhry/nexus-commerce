import './registrations.js'
import { initializeQueue, closeQueue } from '../lib/queue.js'
import { initializeBullMQWorker } from '../workers/bullmq-sync.worker.js'
import { initializeChannelSyncWorker } from '../workers/channel-sync.worker.js'
import { initializeBulkListWorker } from '../workers/bulk-list.worker.js'
import { initializeBulkJobWorker } from '../workers/bulk-job.worker.js'
import { initializeReadCacheWorker } from '../workers/read-cache.worker.js'
import { initializeReadinessWorker } from '../workers/readiness.worker.js'
import { initializeSearchIndexWorker } from '../workers/search-index.worker.js'
import { initializeAdsSyncWorker } from '../workers/ads-sync.worker.js'
import { initializeSyncWorker } from '../workers/sync.worker.js'
import { startEventInfrastructure, stopEventInfrastructure } from '../workers/event-relay.worker.js'
import { closeBroker } from '../lib/events/index.js'
import { startStockPoolWorker } from '../services/stock-pool/pool-tasks.js'
import { startAssortmentSyncWorker } from '../services/assortment/sync-worker.js'
import { startAmazonMediaWorker, stopAmazonMediaWorker } from '../jobs/amazon-media.job.js'
import { stopScheduledTasks } from '../lib/cron/clustered.js'
import { envEnabled } from '../utils/env-flag.js'
import { startAmazonSqsPollCron } from '../jobs/amazon-sqs-poll.job.js'
import { startAmazonSecretRotationCron } from '../jobs/amazon-secret-rotation.job.js'
import { startAmsSqsPollCron } from '../jobs/ams-sqs-poll.job.js'
import { startInboundRetryCron } from '../jobs/inbound-retry.job.js'
import { registerStatusSection } from '../lib/runtime-status/process-snapshot.js'
import { amsPollerFacts } from '../services/ams-sqs.service.js'

/** The API may enqueue work with ENABLE_QUEUE_WORKERS=1 but never consumes it. */
export async function startWorker(): Promise<() => Promise<void>> {
  if (process.env.ENABLE_QUEUE_WORKERS !== '1') throw new Error('Worker requires ENABLE_QUEUE_WORKERS=1')
  const workers: Array<{ close(): Promise<void> }> = []
  const stopPollers: Array<() => Promise<void>> = []
  const stop = async () => {
    await Promise.all([...stopPollers.map(stopPoller => stopPoller()), stopScheduledTasks(), stopAmazonMediaWorker(), ...workers.map(worker => worker.close())])
    await stopEventInfrastructure()
    await closeBroker()
    await closeQueue()
  }
  try {
    await initializeQueue()
    for (const initialize of [initializeBullMQWorker, initializeChannelSyncWorker, initializeBulkListWorker, initializeBulkJobWorker, initializeReadCacheWorker, initializeReadinessWorker]) {
      workers.push(initialize())
    }
    if (process.env.SEARCH_ENGINE_ENABLED === '1') workers.push(initializeSearchIndexWorker())
    if (envEnabled('NEXUS_ENABLE_AMAZON_ADS_CRON')) workers.push(initializeAdsSyncWorker())
    await startEventInfrastructure({ relay: true, intake: false, watchdog: true })
    initializeSyncWorker()
    startAmazonSqsPollCron()
    startAmazonSecretRotationCron()
    startInboundRetryCron()
    if (envEnabled('NEXUS_ENABLE_AMAZON_ADS_CRON')) startAmsSqsPollCron()
    // GET /api/advertising/cron-status reads the AMS poller's configuration from here, where it runs.
    registerStatusSection('ams', amsPollerFacts)
    if (process.env.NEXUS_ENABLE_STOCK_POOL_WORKER !== '0') stopPollers.push(startStockPoolWorker())
    if (process.env.NEXUS_ENABLE_ASSORTMENT_SYNC !== '0') stopPollers.push(startAssortmentSyncWorker())
    startAmazonMediaWorker()
    return stop
  } catch (error) {
    await stop()
    throw error
  }
}
