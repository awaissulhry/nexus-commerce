/**
 * MCP full control 07 O13 — sending a public reply to a review, moved out of routes/reviews.routes.ts
 * (POST /reviews/:id/reply/send) so the review desk and Claude's `reply-to-review` run the same code. It answers as the
 * route did (RouteAnswer), proven by routes/review-actions-parity.vitest.test.ts.
 *
 * eBay: the real RespondToFeedback (Trading API, behind NEXUS_EBAY_REAL_API; one public reply per feedback). Amazon
 * and Shopify have no public reply API: the reply is recorded MANUAL (the operator posts it on the platform). A reply
 * that went out marks the review RESPONDED and raises review.responded.
 */

import prisma from '../../db.js'
import { AnswerReply, RouteAnswer } from '../../lib/route-answer.js'

/** Live or off, from the switch respondToEbayFeedback reads. */
export function ebayReplyMode(): 'live' | 'off' {
  return process.env.NEXUS_EBAY_REAL_API === 'true' ? 'live' : 'off'
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
    select: { id: true, channel: true, externalReviewId: true },
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

  let code = 'MANUAL'
  let ok = true
  let errorMessage: string | null = null

  if (review.channel === 'EBAY') {
    // Loaded here: the adapter builds the eBay auth service when imported, and the tool registry imports this file.
    const { respondToEbayFeedback } = await import('./adapters/ebay-feedback.adapter.js')
    const res = await respondToEbayFeedback(review.externalReviewId, text)
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
