/**
 * MCP full control 07 O13 — `request-review` and `reply-to-review`. Each runs the service the Nexus page runs
 * (services/reviews/review-request.service.ts, services/reviews/review-reply-send.service.ts), in the caller's business
 * only. Both reach a buyer or the public and cannot be taken back: they always wait for a person's approval in Nexus
 * (never confirm, never auto), the preview says whether the channel call is live, and a run whose approval no longer
 * describes the order or the review is refused (stale).
 *
 *   - request-review: Amazon's "Request a Review" (Solicitations), delivered 4–30 days ago, no active return, no
 *     refund, once per order. eBay and Shopify buyers get Nexus's own review e-mail from the review rules' schedule
 *     (jobs/review-request-mailer.job.ts); this tool never sends it (Reviews area PR C, B12).
 *   - reply-to-review: eBay only (RespondToFeedback: public, one reply per feedback, at most 500 characters). Amazon
 *     and Shopify have no reply call: post it there, the review desk can then record it.
 *   - leave-buyer-feedback (Reviews eBay REST, PR G): POSITIVE feedback from the seller for the buyer of one eBay sale
 *     that eBay lists as waiting for it (eBay's REST leaveFeedback; at most 500 characters, within 90 days of the sale,
 *     never while the order has an open return). The Reviews › eBay page asks for it (one request, or one change plan for
 *     several sales); Claude may ask for it too. Either way a person approves each one in Nexus.
 */

import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { lintBuyerCopy } from '../../comms/message-lint.js'
import { amazonSolicitationMode, requestReviewForOrder, reviewRequestCheck } from '../../reviews/review-request.service.js'
import { ebayReplyMode, sendReviewReply } from '../../reviews/review-reply-send.service.js'
import { EBAY_BUYER_FEEDBACK_LIMIT, buyerFeedbackDaysLeft, buyerFeedbackLineHeld, buyerFeedbackTextHeld } from '@nexus/shared/review-reply-rules'
import { staleRefusal } from './stale-preview.js'
import type { AgentTool, ToolContext, ToolResult } from '../tool-types.js'

const toolLog = {
  warn: (...args: unknown[]) => logger.warn('[review actions]', { detail: String(args[1] ?? args[0]) }),
  error: (...args: unknown[]) => logger.error('[review actions]', { detail: JSON.stringify(args[1] ?? args[0]) }),
}

async function freshOrStale(preview: () => Promise<ToolResult>, ctx: ToolContext, fields: string[], what: string) {
  const fresh = await preview()
  if (!fresh.ok) return { refusal: fresh }
  const stale = staleRefusal(ctx.approvedPreview, fresh.preview, fields, what)
  return stale ? { refusal: { ok: false, error: stale } as ToolResult } : { fresh }
}

// ── request-review ──────────────────────────────────────────────────────────────────────────────────

const requestInput = z.object({
  orderId: z.string().trim().min(1).max(64).describe('Nexus order id (from order-search): an Amazon order delivered 4–30 days ago'),
})
type RequestArgs = z.infer<typeof requestInput>

/** The route's refusal in a sentence for the person. */
const REQUEST_REFUSAL: Record<string, string> = {
  'Order not yet delivered': 'it is not delivered yet (Amazon allows a request 4–30 days after delivery)',
  'Too soon — Amazon requires ≥4 days post-delivery': 'it was delivered less than 4 days ago (Amazon allows a request 4–30 days after delivery)',
  'Too late — Amazon blocks requests after 30 days': 'it was delivered more than 30 days ago (Amazon allows a request 4–30 days after delivery)',
  'Order has an active return — solicitation suppressed': 'it has an open return, so no review is asked for',
  'Order has a refund — solicitation suppressed': 'it was refunded, so no review is asked for',
  'Missing amazonOrderId or unknown marketplace': 'Nexus does not know its Amazon marketplace',
}

async function previewRequest(a: RequestArgs): Promise<ToolResult> {
  const order = await prisma.order.findFirst({ where: { id: a.orderId, deletedAt: null }, select: { id: true, channel: true, channelOrderId: true, marketplace: true } })
  if (!order) return { ok: false, error: 'Order not found' }
  const which = `Order ${order.channelOrderId}`
  if (order.channel === 'EBAY') return { ok: false, error: `${which} is an eBay order: its buyer is written to only through eBay, which asks for feedback itself. Nothing was queued.` }
  if (order.channel !== 'AMAZON') return { ok: false, error: `${which} is a ${order.channel} order: Nexus asks for a review only through Amazon's Request a Review (the review e-mails of the review rules cover the other channels). Nothing was queued.` }
  const checked = await reviewRequestCheck(order.id)
  if (checked.ok === false) {
    const why = checked.status === 409 ? `a review was asked for already (${checked.error.replace('Already ', '')})` : REQUEST_REFUSAL[checked.error] ?? checked.error
    return { ok: false, error: `${which}: ${why}. Nothing was queued.` }
  }
  const mode = amazonSolicitationMode()
  return {
    ok: true,
    preview: {
      action: 'request-review',
      order: { id: order.id, channel: order.channel, marketplace: order.marketplace, channelOrderId: order.channelOrderId },
      deliveredDaysAgo: checked.daysSinceDelivery,
      earlier: checked.existing ? checked.existing.status : null,
      request: 'Amazon\'s "Request a Review" e-mail (product review and seller feedback), written and sent by Amazon in the buyer\'s language',
      mode: mode === 'live' ? 'live: Amazon sends it to the buyer' : 'dry run: Amazon is not called (NEXUS_ENABLE_AMAZON_SOLICITATIONS off); Nexus records the request as skipped',
      note: 'Amazon allows one request per order; it cannot be taken back.',
    },
  }
}

const requestReviewTool: AgentTool = {
  name: 'request-review',
  title: 'Ask a buyer for a review',
  input: requestInput,
  requires: [F.ordersEdit, F.reviewsManage],
  category: 'orders',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  description:
    'Ask the buyer of an Amazon order of this business for a review, through Amazon\'s "Request a Review" (Amazon writes '
    + 'and sends it; live or a dry run, as the preview says). Amazon orders only: 4–30 days after delivery, never with an '
    + 'open return or a refund, once per order. eBay and Shopify buyers are asked by Nexus\'s own e-mail on the review '
    + 'rules\' schedule (Reviews › Requests); this tool does not send those. '
    + 'Always waits for a person to approve it in Nexus; it cannot be undone.',
  handler: (args) => previewRequest(args as RequestArgs),
  async execute(args, ctx) {
    const a = args as RequestArgs
    const checked = await freshOrStale(() => previewRequest(a), ctx, ['order', 'earlier', 'mode'], 'the order')
    if ('refusal' in checked) return checked.refusal
    const before = (checked.fresh.preview as { earlier: string | null }).earlier
    const answer = await requestReviewForOrder(a.orderId, toolLog)
    if (!answer.ok) return { ok: false, error: answer.body?.error ?? `not asked (${answer.status})` }
    const row = answer.body as { status: string; providerResponseCode: string | null; errorMessage: string | null; suppressedReason: string | null }
    if (row.status === 'FAILED') return { ok: false, error: `Amazon refused the request (${row.providerResponseCode ?? 'error'}): ${row.errorMessage ?? 'no detail'}. Nothing reached the buyer; it shows as failed on the order.` }
    return {
      ok: true,
      data: { orderId: a.orderId, status: row.status, providerResponseCode: row.providerResponseCode, suppressedReason: row.suppressedReason },
      change: { before: { orderId: a.orderId, request: before }, after: { orderId: a.orderId, request: row.status } },
    }
  },
}

// ── reply-to-review ─────────────────────────────────────────────────────────────────────────────────

const replyInput = z.object({
  reviewId: z.string().trim().min(1).max(64).describe('Nexus review id (from review-search): eBay feedback'),
  body: z.string().trim().min(2).max(500).describe('the public reply, as it will appear under the feedback (eBay allows at most 500 characters)'),
})
type ReplyArgs = z.infer<typeof replyInput>

async function previewReply(a: ReplyArgs): Promise<ToolResult> {
  const review = await prisma.review.findFirst({
    where: { id: a.reviewId },
    select: { id: true, channel: true, marketplace: true, rating: true, body: true, postedAt: true, triageStatus: true },
  })
  if (!review) return { ok: false, error: 'Review not found' }
  const which = `Review ${review.id} (${review.channel}${review.marketplace ? ` ${review.marketplace}` : ''})`
  if (review.channel !== 'EBAY') return { ok: false, error: `${which}: ${review.channel} has no public reply call Nexus can make. Post the reply on ${review.channel}; the review desk can then record it. Nothing was queued.` }
  if (ebayReplyMode() !== 'live') return { ok: false, error: `${which}: replies to eBay are switched off on this server, so eBay would not be called. Nothing was queued.` }
  const sent = await prisma.reviewResponse.findFirst({ where: { reviewId: review.id, status: 'SENT' }, select: { sentAt: true } })
  if (sent) return { ok: false, error: `${which}: it was answered already${sent.sentAt ? ` on ${sent.sentAt.toISOString().slice(0, 10)}` : ''}; eBay allows one reply per feedback. Nothing was queued.` }
  return {
    ok: true,
    preview: {
      action: 'reply-to-review',
      review: { id: review.id, channel: review.channel, marketplace: review.marketplace, rating: review.rating, postedAt: review.postedAt.toISOString(), excerpt: review.body.slice(0, 200), triageStatus: review.triageStatus },
      reply: a.body,
      lint: lintBuyerCopy(a.body),
      mode: 'live: eBay publishes it under the feedback, for everyone to read',
      note: 'One reply per feedback; eBay does not let it be edited or removed.',
    },
  }
}

const replyToReviewTool: AgentTool = {
  name: 'reply-to-review',
  title: 'Reply to a review',
  input: replyInput,
  requires: [F.reviewsManage],
  category: 'orders',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  description:
    'Post a public reply under an eBay feedback of this business (at most 500 characters; one reply per feedback). The '
    + 'preview shows the marketplace copy checks (no incentives, no links, no asking to change a review). Amazon and '
    + 'Shopify have no reply call: post there. Always waits for a person to approve it in Nexus; it cannot be undone. '
    + 'If the review changes before the approval runs, nothing is posted.',
  handler: (args) => previewReply(args as ReplyArgs),
  async execute(args, ctx) {
    const a = args as ReplyArgs
    const checked = await freshOrStale(() => previewReply(a), ctx, ['review', 'reply', 'mode'], 'the review')
    if ('refusal' in checked) return checked.refusal
    const before = (checked.fresh.preview as { review: { triageStatus: string | null } }).review.triageStatus
    const answer = await sendReviewReply(a.reviewId, { body: a.body, actor: `${ctx.via}:${ctx.userId ?? 'unknown'}` })
    const body = answer.body as { ok?: boolean; response?: { id: string }; code?: string; error?: string | null }
    if (!answer.ok) return { ok: false, error: answer.status === 502 ? `eBay refused the reply (${body.code}): ${body.error ?? 'no detail'}. Nothing was published.` : String((answer.body as { error?: string })?.error ?? answer.status) }
    return {
      ok: true,
      data: { reviewId: a.reviewId, responseId: body.response?.id ?? null, code: body.code },
      change: { before: { reviewId: a.reviewId, triageStatus: before }, after: { reviewId: a.reviewId, responseId: body.response?.id ?? null, triageStatus: 'RESPONDED' } },
    }
  },
}

// ── leave-buyer-feedback ────────────────────────────────────────────────────────────────────────────

const leaveInput = z.object({
  lineId: z.string().trim().min(1).max(64).describe('the eBay sale waiting for the seller\'s feedback (Reviews › eBay › Leave feedback for buyers)'),
  text: z.string().trim().min(2).max(EBAY_BUYER_FEEDBACK_LIMIT).describe('the positive feedback for the buyer, as eBay will show it (at most 500 characters)'),
})
type LeaveArgs = z.infer<typeof leaveInput>

async function previewLeave(a: LeaveArgs, now = new Date()): Promise<ToolResult> {
  // Loaded here: the service reaches the eBay adapters, and the tool registry imports this file.
  const { buyerFeedbackLine } = await import('../../reviews/ebay-buyer-feedback.service.js')
  const line = await buyerFeedbackLine(a.lineId)
  if (!line) return { ok: false, error: 'This eBay sale is not in this business’s list of sales waiting for feedback. Nothing was queued.' }
  const which = `eBay sale ${line.orderLineItemId}${line.title ? ` (${line.title.slice(0, 60)})` : ''}`
  // Its own waiting approval is not a reason to refuse: this preview is that approval's, or the plan's step.
  const held = buyerFeedbackLineHeld({ state: line.state, soldAt: line.soldAt, openReturn: line.openReturn }, now)
  if (held) return { ok: false, error: `${which}: ${held} Nothing was queued.` }
  const textHeld = buyerFeedbackTextHeld(a.text)
  if (textHeld) return { ok: false, error: `${which}: ${textHeld} Nothing was queued.` }
  const daysLeft = buyerFeedbackDaysLeft(line.soldAt, now)
  return {
    ok: true,
    preview: {
      action: 'leave-buyer-feedback',
      line: { id: line.id, orderLineItemId: line.orderLineItemId, state: line.state, title: line.title, buyer: line.buyer, order: line.order?.label ?? null, market: line.order?.market ?? null, soldAt: line.soldAt?.toISOString() ?? null },
      rating: 'Positive (a seller can leave positive feedback only)',
      text: a.text,
      lint: lintBuyerCopy(a.text),
      window: daysLeft == null ? 'Nexus does not have this order, so it cannot count the 90 days; eBay still lists the sale as waiting for feedback.' : `${daysLeft} of 90 days left to leave it`,
      mode: ebayReplyMode() === 'live'
        ? 'live: eBay publishes it on the buyer\'s feedback profile'
        : 'dry run: eBay is not called (eBay posting is off on this server); approving it leaves nothing and the sale keeps waiting',
      note: 'Feedback for a buyer cannot be changed or taken back once it is left; one follow-up can be added on eBay later.',
    },
  }
}

const leaveBuyerFeedbackTool: AgentTool = {
  name: 'leave-buyer-feedback',
  title: 'Leave feedback for an eBay buyer',
  input: leaveInput,
  requires: [F.reviewsManage],
  category: 'orders',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  description:
    'Leave positive feedback for the buyer of one eBay sale of this business that eBay lists as waiting for the seller\'s '
    + 'feedback (at most 500 characters, within 90 days of the sale, never while the order has an open return). eBay lets '
    + 'a seller leave positive feedback only. Always waits for a person to approve it in Nexus; it cannot be undone. If the '
    + 'sale changes before the approval runs, nothing is left.',
  handler: (args) => previewLeave(args as LeaveArgs),
  async execute(args, ctx) {
    const a = args as LeaveArgs
    const checked = await freshOrStale(() => previewLeave(a), ctx, ['line', 'text', 'mode'], 'the sale')
    if ('refusal' in checked) return checked.refusal
    const [{ buyerFeedbackLine, markBuyerFeedbackLeft, markBuyerFeedbackRefused }, { leaveEbayBuyerFeedback }] = await Promise.all([
      import('../../reviews/ebay-buyer-feedback.service.js'),
      import('../../reviews/adapters/ebay-feedback-rest.adapter.js'),
    ])
    const line = await buyerFeedbackLine(a.lineId)
    if (!line) return { ok: false, error: 'This eBay sale is no longer in the list. Nothing was left.' }
    const answer = await leaveEbayBuyerFeedback(line.connectionId, { orderLineItemId: line.orderLineItemId, listingId: line.listingId, transactionId: line.transactionId, text: a.text })
    if (!answer.ok) {
      const words = answer.code === 'OPT_IN_OFF' ? answer.error ?? 'eBay posting is off. Nothing was sent.' : `eBay refused the feedback (${answer.code}): ${answer.error ?? 'no detail'}. Nothing was left.`
      await markBuyerFeedbackRefused(line.id, words)
      return { ok: false, error: words }
    }
    await markBuyerFeedbackLeft(line.id, { text: a.text, feedbackId: answer.feedbackId ?? null, by: `${ctx.via}:${ctx.userId ?? 'unknown'}` })
    return {
      ok: true,
      data: { lineId: line.id, orderLineItemId: line.orderLineItemId, feedbackId: answer.feedbackId ?? null },
      change: { before: { lineId: line.id, state: line.state }, after: { lineId: line.id, state: 'LEFT', feedbackId: answer.feedbackId ?? null } },
    }
  },
}

export const REVIEW_ACTION_TOOLS: AgentTool[] = [requestReviewTool, replyToReviewTool, leaveBuyerFeedbackTool]
