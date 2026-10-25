/**
 * MCP full control 07 O13 — asking a buyer for a review, moved out of routes/orders-reviews.routes.ts
 * (POST /orders/:id/request-review) so the order page and Claude's `request-review` run the same code. It answers as
 * the route did (RouteAnswer), proven by routes/review-actions-parity.vitest.test.ts.
 *
 * The rules (Amazon's, applied to every channel): delivered 4–30 days ago; no active return; no refund (on the channel,
 * or a return refunded in Nexus); not already
 * SENT or SCHEDULED. Amazon: the Solicitations call (live behind NEXUS_ENABLE_AMAZON_SOLICITATIONS; off = recorded
 * SKIPPED). Other channels have no request API: recorded SKIPPED (track only).
 */

import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../db.js'
import { AnswerReply, RouteAnswer, answered, type RouteLog } from '../../lib/route-answer.js'
import {
  amazonMarketplaceIdFor,
  benignSuppressedReason,
  isBenignFailure,
  sendAmazonSolicitation,
} from './amazon-solicitations.service.js'

/** Returns in these states suppress a review request. */
export const ACTIVE_RETURN_STATUSES = ['REQUESTED', 'AUTHORIZED', 'IN_TRANSIT', 'RECEIVED', 'INSPECTING'] as const
/** Review requests that have not gone out yet (a FAILED one is retried by the mailer). */
export const PENDING_REVIEW_REQUEST_STATUSES = ['ELIGIBLE', 'SCHEDULED', 'FAILED'] as const

/**
 * A return of this order was refunded in Nexus: its review requests that have not gone out are suppressed (2026-10-02;
 * a refunded buyer is not asked for a review). Called by every refund path once the return is REFUNDED.
 */
export async function suppressReviewRequestsForRefund(orderId: string, rmaNumber: string | null): Promise<number> {
  const suppressed = await prisma.reviewRequest.updateMany({
    where: { orderId, status: { in: [...PENDING_REVIEW_REQUEST_STATUSES] } },
    data: { status: 'SUPPRESSED', suppressedReason: `Order refunded in Nexus${rmaNumber ? ` (return ${rmaNumber})` : ''} — no review is asked for`, nextRetryAt: null },
  })
  return suppressed.count
}
const DAY_MS = 24 * 60 * 60 * 1000

/** The Amazon Order ID Amazon expects: Order.channelOrderId of an Amazon order. */
function extractAmazonOrderId(order: { channel: string; channelOrderId: string }): string | null {
  return order.channel === 'AMAZON' ? order.channelOrderId : null
}

/** Live or a dry run, from the switch sendAmazonSolicitation reads. */
export function amazonSolicitationMode(): 'live' | 'dry run' {
  return process.env.NEXUS_ENABLE_AMAZON_SOLICITATIONS === 'true' ? 'live' : 'dry run'
}

/**
 * Why a review request for this order is refused now (the route's status and words), or the order and any earlier
 * request when it may go. Reads only.
 */
export async function reviewRequestCheck(id: string) {
  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      returns: { select: { status: true } },
      financialTransactions: { where: { transactionType: 'Refund' }, select: { id: true } },
    },
  })
  if (!order) return { ok: false as const, status: 404, error: 'Order not found' }
  if (!order.deliveredAt) return { ok: false as const, status: 400, error: 'Order not yet delivered' }
  const days = (Date.now() - order.deliveredAt.getTime()) / DAY_MS
  if (days < 4) return { ok: false as const, status: 400, error: 'Too soon — Amazon requires ≥4 days post-delivery' }
  if (days > 30) return { ok: false as const, status: 400, error: 'Too late — Amazon blocks requests after 30 days' }
  if (order.returns.some((r) => (ACTIVE_RETURN_STATUSES as readonly string[]).includes(r.status))) {
    return { ok: false as const, status: 400, error: 'Order has an active return — solicitation suppressed' }
  }
  // A refund on the channel (financial events) or in Nexus (a REFUNDED return) — 2026-10-02.
  if (order.financialTransactions.length > 0 || order.returns.some((r) => r.status === 'REFUNDED')) {
    return { ok: false as const, status: 400, error: 'Order has a refund — solicitation suppressed' }
  }
  const existing = await prisma.reviewRequest.findUnique({
    where: { orderId_channel: workspaceKey({ orderId: order.id, channel: order.channel }) },
  })
  if (existing && (existing.status === 'SENT' || existing.status === 'SCHEDULED')) {
    return { ok: false as const, status: 409, error: `Already ${existing.status}` }
  }
  if (order.channel === 'AMAZON' && (!extractAmazonOrderId(order) || !amazonMarketplaceIdFor(order.marketplace))) {
    return { ok: false as const, status: 400, error: 'Missing amazonOrderId or unknown marketplace' }
  }
  return { ok: true as const, order, existing, daysSinceDelivery: Math.floor(days) }
}

/** POST /orders/:id/request-review. */
export async function requestReviewForOrder(id: string, log: RouteLog): Promise<RouteAnswer> {
  const reply = new AnswerReply()
  try {
    const checked = await reviewRequestCheck(id)
    if (checked.ok === false) return reply.status(checked.status).send({ error: checked.error })
    const { order, existing } = checked

    // For Amazon: the SP-API call now. For others: track only.
    if (order.channel === 'AMAZON') {
      const amazonOrderId = extractAmazonOrderId(order)!
      const result = await sendAmazonSolicitation({ amazonOrderId, marketplaceCode: order.marketplace ?? '' })
      const benign = isBenignFailure(result.errorCode)
      const newStatus = result.ok ? 'SENT' as const : benign ? 'SKIPPED' as const : 'FAILED' as const
      const data = {
        orderId: order.id,
        channel: order.channel,
        marketplace: order.marketplace,
        status: newStatus,
        sentAt: result.ok ? new Date() : null,
        providerRequestId: result.providerRequestId ?? null,
        providerResponseCode: result.errorCode ?? null,
        errorMessage: benign ? null : result.errorMessage ?? null,
        suppressedReason: benignSuppressedReason(result.errorCode),
      }
      const upserted = existing
        ? await prisma.reviewRequest.update({ where: { id: existing.id }, data })
        : await prisma.reviewRequest.create({ data })
      return answered(upserted)
    }

    // Non-Amazon: track-only skeleton
    const data = {
      orderId: order.id,
      channel: order.channel,
      marketplace: order.marketplace,
      status: 'SKIPPED' as const,
      suppressedReason: 'Channel does not support native solicitation API — wire third-party app first',
    }
    const upserted = existing
      ? await prisma.reviewRequest.update({ where: { id: existing.id }, data })
      : await prisma.reviewRequest.create({ data })
    return answered(upserted)
  } catch (err: any) {
    log.error('[REVIEW ENGINE] manual request failed', { message: err.message })
    return reply.status(500).send({ error: err.message })
  }
}
