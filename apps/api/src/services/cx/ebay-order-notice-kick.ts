/**
 * eBay order notices, Phase 4 — a stored, verified ORDER_CONFIRMATION runs within seconds, not at the next minute.
 *
 * The receiver (routes/ebay-notification.routes.ts) stores the notice and answers eBay 200 first. Only then does it
 * call `kickStoredEbayOrderNotice`, which asks the worker to run THAT one receipt now: one job on the
 * "ebay-order-notice" queue, jobId "ebay-order-notice-<receiptId>", in the receipt's own business. The worker
 * (workers/ebay-order-notice.worker.ts) runs it through the same stored-receipt protocol as the minute sweep
 * (jobs/inbound-retry.job.ts → processEbayInbound → the receipt claim → processEbayOrderClaim), so the claim
 * decides who runs it: a kick and a sweep at the same moment, one wins and the other is not_claimed.
 *
 * Asked only when the sweep would run the receipt too:
 *   - admission routed it to a business (`accepted`) — never a quarantined or rejected notice;
 *   - it is an ORDER_CONFIRMATION (read here from the verified body, and again from the STORED receipt by the worker);
 *   - eBay inbound processing is ready AND order notices are switched on (ebay-processing-policy.ts).
 * This module never throws. Redis down, a queue timeout or no workers: it logs and returns. The receipt is already
 * stored, so the minute sweep processes it. Nothing here can change or delay eBay's 200.
 */
import { logger } from '../../utils/logger.js'
import { withIngressWorkspace } from '../../lib/workspace-ingress.js'
import { readEbayNoticeIdentity } from './ingress/ebay-revocation-notice.js'
import type { EbayAdmissionOutcome } from './ingress/ebay-admission.js'

export const EBAY_ORDER_NOTICE_TOPIC = 'ORDER_CONFIRMATION'
/** One job per receipt. BullMQ refuses a custom id with a single ":" (lib/bullmq-job-ids.vitest.test.ts). */
export const ebayOrderNoticeJobId = (receiptId: string) => `ebay-order-notice-${receiptId}`

export type EbayOrderNoticeKick =
  | { kicked: true }
  | { kicked: false; reason: 'not_routed' | 'not_an_order_notice' | 'held' | 'workers_off' | 'enqueue_failed' }

/** The body was verified by admission; an unreadable one is simply not an order notice. */
function topicOf(rawBody: Buffer): string | null {
  try { return readEbayNoticeIdentity(JSON.parse(rawBody.toString('utf8'))).topic } catch { return null }
}

/** Called by the receiver AFTER eBay's 200, not awaited. Every refusal or failure leaves the receipt to the sweep. */
export async function kickStoredEbayOrderNotice(outcome: EbayAdmissionOutcome, rawBody: Buffer): Promise<EbayOrderNoticeKick> {
  try {
    if (outcome.kind !== 'accepted') return { kicked: false, reason: 'not_routed' }
    if (topicOf(rawBody) !== EBAY_ORDER_NOTICE_TOPIC) return { kicked: false, reason: 'not_an_order_notice' }
    // Loaded only for an order notice, so the receiver's other paths load no queue and no token service.
    const { ebayInboundProcessingReady, ebayOrderNoticesEnabled } = await import('./ingress/ebay-processing-policy.js')
    if (!ebayInboundProcessingReady() || !ebayOrderNoticesEnabled()) return { kicked: false, reason: 'held' }
    const { addJobSafely, ebayOrderNoticeQueue } = await import('../../lib/queue.js')
    // In the receipt's business: WorkspaceQueue stamps it on the job and prefixes the job id with it.
    const result = await withIngressWorkspace(outcome.workspaceId, () => addJobSafely(ebayOrderNoticeQueue, 'process-receipt',
      { receiptId: outcome.receiptId }, { jobId: ebayOrderNoticeJobId(outcome.receiptId) }))
    if (result.enqueued) return { kicked: true }
    if (result.workersOff) return { kicked: false, reason: 'workers_off' }
    logger.warn('[eBay order notice] the worker was not asked to run it now; the minute sweep will', {
      receiptId: outcome.receiptId, timedOut: !!result.timedOut, circuitOpen: !!result.skipped })
    return { kicked: false, reason: 'enqueue_failed' }
  } catch (error) {
    logger.warn('[eBay order notice] the worker was not asked to run it now; the minute sweep will', {
      receiptId: outcome.kind === 'accepted' ? outcome.receiptId : undefined, error: error instanceof Error ? error.name : 'unknown' })
    return { kicked: false, reason: 'enqueue_failed' }
  }
}
