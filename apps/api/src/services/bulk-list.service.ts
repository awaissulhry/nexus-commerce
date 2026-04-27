import { Queue } from 'bullmq'
import { redis } from '../lib/queue.js'

/**
 * Job data type for bulk eBay listing operations
 */
export interface BulkListJobData {
  productIds: string[]
  marketplaceId: 'EBAY_IT' | 'EBAY_US' | 'EBAY_DE' | 'EBAY_FR' | 'EBAY_UK'
  pricingMarkupPercent?: number
  dryRun?: boolean
}

/**
 * Job result type for bulk listing completion
 */
export interface BulkListJobResult {
  listed: number
  skipped: number
  failed: number
  errors: Array<{
    productId: string
    reason: string
  }>
  totalProcessed: number
  duration: number
}

/**
 * Create and export the bulk-ebay-listing queue
 */
export const bulkListQueue = new Queue<BulkListJobData>('bulk-ebay-listing', {
  connection: redis,
  defaultJobOptions: {
    attempts: 1, // No retries for bulk jobs - one failure shouldn't kill the entire job
    removeOnComplete: {
      age: 3600, // Keep completed jobs for 1 hour
    },
    removeOnFail: {
      age: 86400, // Keep failed jobs for 24 hours
    },
  },
})

/**
 * Enqueue a bulk listing job
 * @param data Job data with productIds, marketplaceId, and optional pricing/dryRun
 * @returns Job ID for polling status
 */
export async function enqueueBulkList(data: BulkListJobData): Promise<string> {
  const job = await bulkListQueue.add('bulk-publish', data, {
    jobId: `bulk-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
  })
  return job.id
}
