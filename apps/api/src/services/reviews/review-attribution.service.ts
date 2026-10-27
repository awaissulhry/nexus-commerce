/**
 * RV.9.7 — Persist review→request→rule attribution to the Review table.
 *
 * Companion to review-analytics.service.ts. The analytics view computes
 * attribution on the fly; this service writes it back to disk so other
 * consumers (the Review table UI, exports, future ML) can see which
 * rule produced which review without redoing the join.
 *
 * Idempotent: only writes when the Review row currently has
 * attributedRequestId IS NULL. Reviews ingested *before* a request
 * was ever sent stay null forever (they were organic).
 *
 * The rule (review-rate.service.ts reads the result: ONE review rate for every page):
 *   - A review that names its order (eBay feedback, Amazon seller feedback: Review.orderId) → that order's SENT
 *     request, sent before the review (audit B2: eBay feedback has no product, so the product match never found one).
 *   - Any other review: a SENT request for the same (channel, marketplace, productId)
 *   - Sent at sentAt; Review posted at postedAt; sentAt <= postedAt AND (postedAt - sentAt) <= attributionWindow (30 days)
 *   - Pick the latest matching SENT request (most recent outreach wins); one review per request
 *   - Fixture rows (ingestSource FIXTURE) never count (review-visibility.ts).
 *
 * Returns counts so callers can log or expose progress.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { visibleReviewWhere } from './review-visibility.js'
import { ATTRIBUTION_DAYS } from './review-rate.service.js'

interface RunArgs {
  /** Look back this many days for both Reviews and SENT requests. */
  windowDays?: number
  /** Maximum age delta (Review.postedAt − ReviewRequest.sentAt). */
  attributionWindowDays?: number
  /** Cap total updates per run; keeps long-running scripts off the API. */
  limit?: number
}

interface RunResult {
  scanned: number
  attributed: number
  durationMs: number
}

export async function runReviewAttributionOnce(args: RunArgs = {}): Promise<RunResult> {
  const startedAt = Date.now()
  const windowDays = Math.min(Math.max(args.windowDays ?? 30, 7), 180)
  const attributionWindowDays = Math.min(Math.max(args.attributionWindowDays ?? ATTRIBUTION_DAYS, 7), 60)
  const limit = Math.min(Math.max(args.limit ?? 5000, 1), 50_000)

  const now = new Date()
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000)

  // Reviews currently lacking attribution. Cap at limit so a single
  // tick doesn't dominate the API.
  const reviews = await prisma.review.findMany({
    where: visibleReviewWhere({
      attributedRequestId: null,
      postedAt: { gte: since, lte: now },
      OR: [{ productId: { not: null } }, { orderId: { not: null } }],
      channel: { in: ['AMAZON', 'EBAY', 'SHOPIFY'] },
    }),
    select: { id: true, channel: true, marketplace: true, productId: true, orderId: true, postedAt: true },
    take: limit,
  })

  if (reviews.length === 0) {
    return { scanned: 0, attributed: 0, durationMs: Date.now() - startedAt }
  }

  // Pre-fetch SENT requests in a broader window (so a request from 21
  // days before the earliest review is still findable).
  const sentSince = new Date(since.getTime() - attributionWindowDays * 24 * 60 * 60 * 1000)
  const sentRequests = await prisma.reviewRequest.findMany({
    where: {
      status: 'SENT',
      sentAt: { gte: sentSince, lte: now },
    },
    select: {
      id: true,
      sentAt: true,
      channel: true,
      marketplace: true,
      ruleId: true,
      orderId: true,
      order: {
        select: { items: { take: 1, select: { productId: true } } },
      },
    },
  })

  // Index by order, and by (channel|marketplace|productId), each sorted desc by sentAt.
  const byOrder = new Map<string, typeof sentRequests>()
  for (const r of sentRequests) {
    const arr = byOrder.get(r.orderId) ?? []
    arr.push(r)
    byOrder.set(r.orderId, arr)
  }
  for (const arr of byOrder.values()) arr.sort((a, b) => (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0))
  const bucket = new Map<string, typeof sentRequests>()
  for (const r of sentRequests) {
    const productId = r.order?.items[0]?.productId ?? null
    if (!productId) continue
    const key = `${r.channel}|${r.marketplace ?? ''}|${productId}`
    const arr = bucket.get(key) ?? []
    arr.push(r)
    bucket.set(key, arr)
  }
  for (const arr of bucket.values()) {
    arr.sort((a, b) => (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0))
  }

  const attributionMs = attributionWindowDays * 24 * 60 * 60 * 1000
  const usedRequestIds = new Set<string>()
  let attributed = 0
  for (const rv of reviews) {
    // A review that names its order matches that order's request only; else the product's.
    const matches = rv.orderId
      ? byOrder.get(rv.orderId)
      : rv.productId ? bucket.get(`${rv.channel}|${rv.marketplace ?? ''}|${rv.productId}`) : undefined
    if (!matches) continue
    const postedMs = rv.postedAt.getTime()
    let chosen: (typeof sentRequests)[number] | null = null
    for (const req of matches) {
      if (!req.sentAt) continue
      if (usedRequestIds.has(req.id)) continue
      const sentMs = req.sentAt.getTime()
      if (sentMs <= postedMs && postedMs - sentMs <= attributionMs) {
        chosen = req
        break
      }
    }
    if (!chosen) continue
    usedRequestIds.add(chosen.id)
    await prisma.review.update({
      where: { id: rv.id },
      data: {
        attributedRequestId: chosen.id,
        attributedRuleId: chosen.ruleId ?? null,
        attributedAt: new Date(),
      },
    })
    attributed += 1
  }

  const durationMs = Date.now() - startedAt
  logger.info('[review-attribution] tick complete', {
    scanned: reviews.length,
    attributed,
    durationMs,
  })
  return { scanned: reviews.length, attributed, durationMs }
}
