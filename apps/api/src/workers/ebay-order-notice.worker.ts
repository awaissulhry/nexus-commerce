/**
 * eBay order notices, Phase 4 — the worker half of "process this stored ORDER_CONFIRMATION now".
 *
 * The receiver queues one job per stored order notice after it has answered eBay 200
 * (services/cx/ebay-order-notice-kick.ts). This worker runs that one receipt through the stored-receipt protocol the
 * minute sweep uses (jobs/inbound-retry.job.ts): processEbayInbound, in the receipt's business, with no actor. So the
 * same switches hold it, the same claim decides who runs it (a kick and the sweep at once: one runs, the other is
 * not_claimed), and the same executor reads the order and writes it (processEbayOrderClaim).
 *
 * Safe to run twice, late or never: a finished, leased or backed-off receipt is refused by its claim, and the minute
 * sweep still runs every receipt this worker did not. Only an ORDER_CONFIRMATION receipt is run here; any other
 * receipt stays with the sweep.
 */

import { WorkspaceWorker as Worker } from '../lib/workspace-jobs.js'
import { redis } from '../lib/queue.js'
import prisma from '../db.js'
import { workspaceIdForQuery } from '../lib/workspace-context.js'
import { withIngressWorkspace } from '../lib/workspace-ingress.js'
import { processEbayInbound, type EbayProcessingOutcome } from '../services/cx/ingress/ebay-processing.js'
import { EBAY_ORDER_NOTICE_TOPIC } from '../services/cx/ebay-order-notice-kick.js'
import { logger } from '../utils/logger.js'

export type EbayOrderNoticeNowOutcome = EbayProcessingOutcome | { kind: 'skipped'; reason: 'not_an_order_notice' }

/** One receipt, in the business the job carries (WorkspaceWorker binds it), exactly as the sweep runs it. */
export async function processEbayOrderNoticeNow(receiptId: string): Promise<EbayOrderNoticeNowOutcome> {
  // The sweep's context: the receipt's business and no actor (withIngressWorkspace), never the queuer's.
  return withIngressWorkspace(workspaceIdForQuery(), async () => {
    const stored = await prisma.webhookEvent.findFirst({
      where: { id: receiptId, workspaceId: workspaceIdForQuery(), channel: 'EBAY', eventType: EBAY_ORDER_NOTICE_TOPIC },
      select: { id: true },
    })
    if (!stored) return { kind: 'skipped', reason: 'not_an_order_notice' }
    return processEbayInbound(receiptId)
  })
}

export function initializeEbayOrderNoticeWorker() {
  const worker = new Worker(
    'ebay-order-notice',
    async (job) => {
      const { receiptId } = job.data as { receiptId?: unknown }
      if (typeof receiptId !== 'string' || !receiptId) {
        logger.warn('[ebay-order-notice] job missing receiptId', { jobId: job.id })
        return
      }
      const outcome = await processEbayOrderNoticeNow(receiptId)
      logger.info('[ebay-order-notice] stored order notice run now', { receiptId, outcome: outcome.kind })
    },
    // Each job is one order read through the gateway's rate bucket; two lanes drain a burst of sales in seconds.
    { connection: redis.connection, concurrency: 2 },
  )
  worker.on('failed', (job, err) => {
    // The receipt's lease expires and the minute sweep claims it again; nothing is lost.
    logger.warn('[ebay-order-notice] job failed; the minute sweep will run the receipt', { jobId: job?.id, error: err.message })
  })
  return worker
}
