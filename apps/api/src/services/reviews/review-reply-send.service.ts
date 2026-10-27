/**
 * MCP full control 07 O13 — sending a public reply to a review, moved out of routes/reviews.routes.ts
 * (POST /reviews/:id/reply/send) so the review desk and Claude's `reply-to-review` run the same code. It answers as the
 * route did (RouteAnswer), proven by routes/review-actions-parity.vitest.test.ts.
 *
 * eBay: the real RespondToFeedback (Trading API, behind NEXUS_EBAY_REAL_API; one public reply per feedback; REST
 * respondToFeedback for feedback first read by eBay's REST Feedback API, whose id is REST's). Amazon
 * and Shopify have no public reply API: the reply is recorded MANUAL (the operator posts it on the platform). A reply
 * that went out marks the review RESPONDED and raises review.responded.
 *
 * Reviews Inbox (2026-10-26): the channel's reply rules (`reviewReplyRules`, @nexus/shared) decide, and this send
 * refuses what they refuse, before anything is posted or stored: a second reply where the channel allows one (409
 * already_replied), a closed reply window (409 window_closed), a reply over the limit (400 too_long). Only a rule in
 * 'send' mode posts through the channel (eBay feedback read from eBay); an imported row is recorded MANUAL.
 */

import { replyRefusal, reviewReplyRules } from '@nexus/shared/review-reply-rules'
import prisma from '../../db.js'
import { AnswerReply, RouteAnswer } from '../../lib/route-answer.js'
import { reviewKindOf } from './review-visibility.js'

/** Live or off, from the switch respondToEbayFeedback reads. */
export function ebayReplyMode(): 'live' | 'off' {
  return process.env.NEXUS_EBAY_REAL_API === 'true' ? 'live' : 'off'
}

/**
 * Feedback read with a seller reply already on it: eBay's GetFeedback `FeedbackResponse` or REST `replyComment.commentText`,
 * or the "Your Response" column of Amazon's seller feedback report (amazon-seller-feedback.service.ts stores it as
 * `yourResponse`).
 */
export function repliedOnChannel(channel: string, rawPayload: unknown): boolean {
  if (!rawPayload || typeof rawPayload !== 'object') return false
  if (channel === 'EBAY') {
    const response = (rawPayload as { FeedbackResponse?: unknown }).FeedbackResponse
    if (typeof response === 'string' && response.trim().length > 0) return true
    const rest = (rawPayload as { replyComment?: { commentText?: unknown } | null }).replyComment?.commentText
    return typeof rest === 'string' && rest.trim().length > 0
  }
  if (channel !== 'AMAZON') return false
  const response = (rawPayload as Record<string, unknown>).yourResponse
  return typeof response === 'string' && response.trim().length > 0
}

export interface ReplyBody {
  body?: string
  /** A DRAFT ReviewResponse to send (it becomes the sent one). */
  responseId?: string
  actor?: string
}

/** POST /reviews/:id/reply/send. */
export async function sendReviewReply(id: string, b: ReplyBody): Promise<RouteAnswer> {
  const reply = new AnswerReply()
  const review = await prisma.review.findUnique({
    where: { id },
    select: { id: true, channel: true, externalReviewId: true, marketplace: true, postedAt: true, ingestSource: true, kind: true, rawPayload: true, authorName: true },
  })
  if (!review) return reply.code(404).send({ error: 'not_found' })
  const text = (b.body ?? '').trim()
  if (!text) return reply.code(400).send({ error: 'empty_body' })
  // A saved draft is sent only from its own review (2026-10-02): another review's draft, or an unknown id, is refused
  // before eBay is called, and nothing changes.
  if (b.responseId) {
    const draft = await prisma.reviewResponse.findFirst({ where: { id: b.responseId, reviewId: id }, select: { id: true } })
    if (!draft) return reply.code(404).send({ error: 'response_not_found' })
  }

  const sent = await prisma.reviewResponse.count({ where: { reviewId: id, status: 'SENT' } })
  const rules = reviewReplyRules(review.channel, {
    kind: reviewKindOf(review.channel, review.kind),
    marketplace: review.marketplace,
    postedAt: review.postedAt,
    imported: (review.ingestSource ?? '').toUpperCase().startsWith('IMPORT'),
    replied: sent > 0 || repliedOnChannel(review.channel, review.rawPayload),
    buyerId: review.authorName,
  })
  const refusal = replyRefusal(rules, text)
  if (refusal) return reply.code(refusal.code === 'too_long' || refusal.code === 'empty_body' ? 400 : 409).send({ error: refusal.code, message: refusal.words })

  let code = 'MANUAL'
  let ok = true
  let errorMessage: string | null = null

  if (rules.mode === 'send' && review.channel === 'EBAY') {
    // Loaded here: the adapter builds the eBay auth service when imported, and the tool registry imports this file.
    // Feedback first read by eBay's REST API carries REST's feedback id: it is answered by REST respondToFeedback.
    const { respondToEbayFeedback, respondToEbayFeedbackByRest } = await import('./adapters/ebay-feedback.adapter.js')
    const res = review.ingestSource === 'EBAY_REST'
      ? await respondToEbayFeedbackByRest(review.externalReviewId, text, review.authorName ?? '')
      : await respondToEbayFeedback(review.externalReviewId, text, review.authorName ?? '')
    ok = res.ok
    code = res.code
    errorMessage = res.error ?? null
  }
  // Amazon/Shopify: no public reply API — stored as MANUAL (operator posts on-platform and confirms here).

  const baseData = {
    channel: review.channel,
    body: text,
    status: ok ? 'SENT' : 'FAILED',
    providerResponseCode: code,
    errorMessage,
    sentAt: ok ? new Date() : null,
    createdBy: b.actor ?? 'user:anonymous',
  }
  let row
  if (b.responseId) {
    row = await prisma.reviewResponse.update({ where: { id: b.responseId }, data: baseData })
  } else {
    row = await prisma.reviewResponse.create({ data: { reviewId: id, ...baseData } })
  }

  if (ok) {
    await prisma.review.update({
      where: { id },
      data: { triageStatus: 'RESPONDED', triageUpdatedAt: new Date() },
    })
    // Loaded here, not at the top: the review bus opens its cross-replica connection when it is first imported, and
    // the tool registry (which imports this file) must load without one.
    const { publishReviewEvent } = await import('../review-events.service.js')
    publishReviewEvent({
      type: 'review.responded',
      reviewId: id,
      channel: review.channel,
      ts: Date.now(),
    })
  }

  if (!ok) reply.code(502)
  return reply.send({ ok, response: row, code, error: errorMessage })
}
