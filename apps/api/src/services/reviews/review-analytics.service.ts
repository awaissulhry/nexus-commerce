/**
 * RV.8.1 — Review conversion-rate analytics.
 *
 * Joins the two halves of the pipeline:
 *
 *   1. ReviewRequest where status='SENT' — outreach we fired.
 *   2. Review (ingested by the SR.1 review-ingest cron) — reviews
 *      customers actually left, regardless of whether we asked.
 *
 * Attribution is heuristic — Amazon doesn't tell us which review was
 * caused by which Solicitations call. We approximate by: for each SENT
 * request, look for a matching Review (same channel + marketplace +
 * productId) posted within `attributionWindowDays` of sentAt. If found,
 * count the request as "converted".
 *
 * Anti-double-count: each Review can only attribute to the most recent
 * SENT request whose sentAt is within window before postedAt.
 *
 * Industry baseline: Amazon Solicitations conversion is ~5-15% across
 * categories. Negative-feedback diversion (RV.6) typically raises the
 * average-rating effect (not the request→review %) so numbers will be
 * higher for review-quality than review-volume.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

export interface ReviewAnalyticsResult {
  window: { since: string; until: string; days: number }
  overall: {
    sent: number
    reviewedAfter: number
    conversionRate: number // 0..1
  }
  perMarketplace: Array<{ marketplace: string; sent: number; reviewedAfter: number; conversionRate: number }>
  perProductType: Array<{ productType: string; sent: number; reviewedAfter: number; conversionRate: number }>
  // RV.9.4 — per-rule rollup so operators can A/B compare rule configs.
  perRule: Array<{
    ruleId: string | null
    ruleName: string
    ruleScope: string | null
    ruleMarketplace: string | null
    ruleActive: boolean
    sent: number
    reviewedAfter: number
    conversionRate: number
  }>
  daily: Array<{ date: string; sent: number; reviewedAfter: number }>
}

interface AnalyticsArgs {
  /** Look back this many days. Default 30. Max 180. */
  windowDays?: number
  /** Attribute a Review to a SENT request when postedAt is within
   *  this many days after sentAt. Default 21 (matches helmet+rideability
   *  window in the timing table). */
  attributionWindowDays?: number
}

export async function computeReviewAnalytics(
  args: AnalyticsArgs = {},
): Promise<ReviewAnalyticsResult> {
  const startedAt = Date.now()
  const windowDays = Math.min(Math.max(args.windowDays ?? 30, 7), 180)
  const attributionWindowDays = Math.min(Math.max(args.attributionWindowDays ?? 21, 7), 60)
  const now = new Date()
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000)

  // 1. Pull all SENT requests in the window with the bits we need.
  const sentRequests = await prisma.reviewRequest.findMany({
    where: {
      status: 'SENT',
      sentAt: { gte: since, lte: now },
    },
    select: {
      id: true,
      sentAt: true,
      channel: true,
      marketplace: true,
      orderId: true,
      ruleId: true,
      order: {
        select: {
          items: {
            take: 1,
            select: { productId: true, product: { select: { productType: true } } },
          },
        },
      },
    },
  })

  // RV.9.4 — load rule metadata in one go so the per-rule rollup can
  // surface name/scope/marketplace without N+1.
  const ruleIds = Array.from(new Set(sentRequests.map((r) => r.ruleId).filter((v): v is string => !!v)))
  const ruleMeta = ruleIds.length
    ? await prisma.reviewRule.findMany({
        where: { id: { in: ruleIds } },
        select: { id: true, name: true, scope: true, marketplace: true, isActive: true },
      })
    : []
  const ruleMetaById = new Map(ruleMeta.map((r) => [r.id, r]))

  // 2. Pull all Reviews posted in the window (slightly extended by
  //    attributionWindow on the front so we catch ones from earlier
  //    sent requests that resolved late).
  const reviewSince = new Date(since.getTime() - attributionWindowDays * 24 * 60 * 60 * 1000)
  const reviews = await prisma.review.findMany({
    where: {
      postedAt: { gte: reviewSince, lte: now },
      channel: { in: ['AMAZON', 'EBAY', 'SHOPIFY'] },
    },
    select: {
      id: true,
      channel: true,
      marketplace: true,
      productId: true,
      postedAt: true,
    },
  })

  // 3. Attribution: for each Review, find the latest SENT request that
  //    matches (channel, marketplace, productId) AND whose sentAt is
  //    in [postedAt - attributionWindow, postedAt]. Mark that request
  //    as converted; one review attributes to at most one request.
  const attributedRequestIds = new Set<string>()
  const sentBy = (() => {
    // Index requests by (channel, marketplace, productId) for fast lookup.
    const map = new Map<string, typeof sentRequests>()
    for (const r of sentRequests) {
      const productId = r.order?.items[0]?.productId ?? '_none'
      const key = `${r.channel}|${r.marketplace ?? ''}|${productId}`
      const arr = map.get(key) ?? []
      arr.push(r)
      map.set(key, arr)
    }
    // Sort each bucket by sentAt desc so we can find the latest match easily.
    for (const arr of map.values()) {
      arr.sort((a, b) => (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0))
    }
    return map
  })()

  const attributionMs = attributionWindowDays * 24 * 60 * 60 * 1000
  for (const rv of reviews) {
    if (!rv.productId) continue
    const key = `${rv.channel}|${rv.marketplace ?? ''}|${rv.productId}`
    const bucket = sentBy.get(key)
    if (!bucket) continue
    const postedMs = rv.postedAt.getTime()
    for (const req of bucket) {
      if (!req.sentAt) continue
      if (attributedRequestIds.has(req.id)) continue
      const sentMs = req.sentAt.getTime()
      if (sentMs <= postedMs && postedMs - sentMs <= attributionMs) {
        attributedRequestIds.add(req.id)
        break
      }
    }
  }

  // 4. Roll up overall + per-marketplace + per-productType + per-rule + daily.
  const perMarketplaceMap = new Map<string, { sent: number; reviewedAfter: number }>()
  const perProductTypeMap = new Map<string, { sent: number; reviewedAfter: number }>()
  // Key '__nullrule__' captures requests that ran without an active rule
  // (pre-RV.3 traffic or fallback path).
  const perRuleMap = new Map<string, { sent: number; reviewedAfter: number }>()
  const dailyMap = new Map<string, { sent: number; reviewedAfter: number }>()
  // Seed daily buckets so empty days show 0
  for (let i = 0; i < windowDays; i++) {
    const d = new Date(since.getTime() + i * 24 * 60 * 60 * 1000)
    dailyMap.set(d.toISOString().slice(0, 10), { sent: 0, reviewedAfter: 0 })
  }

  let totalSent = 0
  let totalReviewed = 0
  for (const req of sentRequests) {
    totalSent++
    const converted = attributedRequestIds.has(req.id) ? 1 : 0
    totalReviewed += converted

    const mp = req.marketplace ?? '—'
    const m = perMarketplaceMap.get(mp) ?? { sent: 0, reviewedAfter: 0 }
    m.sent++
    m.reviewedAfter += converted
    perMarketplaceMap.set(mp, m)

    const pt = req.order?.items[0]?.product?.productType ?? '—'
    const p = perProductTypeMap.get(pt) ?? { sent: 0, reviewedAfter: 0 }
    p.sent++
    p.reviewedAfter += converted
    perProductTypeMap.set(pt, p)

    const ruleKey = req.ruleId ?? '__nullrule__'
    const ru = perRuleMap.get(ruleKey) ?? { sent: 0, reviewedAfter: 0 }
    ru.sent++
    ru.reviewedAfter += converted
    perRuleMap.set(ruleKey, ru)

    if (req.sentAt) {
      const day = req.sentAt.toISOString().slice(0, 10)
      const d = dailyMap.get(day) ?? { sent: 0, reviewedAfter: 0 }
      d.sent++
      d.reviewedAfter += converted
      dailyMap.set(day, d)
    }
  }

  const perMarketplace = Array.from(perMarketplaceMap.entries())
    .map(([marketplace, v]) => ({
      marketplace,
      sent: v.sent,
      reviewedAfter: v.reviewedAfter,
      conversionRate: v.sent > 0 ? v.reviewedAfter / v.sent : 0,
    }))
    .sort((a, b) => b.sent - a.sent)

  const perProductType = Array.from(perProductTypeMap.entries())
    .map(([productType, v]) => ({
      productType,
      sent: v.sent,
      reviewedAfter: v.reviewedAfter,
      conversionRate: v.sent > 0 ? v.reviewedAfter / v.sent : 0,
    }))
    .sort((a, b) => b.sent - a.sent)
    .slice(0, 10) // top 10

  const perRule = Array.from(perRuleMap.entries())
    .map(([key, v]) => {
      const meta = key === '__nullrule__' ? null : ruleMetaById.get(key) ?? null
      return {
        ruleId: key === '__nullrule__' ? null : key,
        ruleName: meta?.name ?? (key === '__nullrule__' ? '(no rule — fallback path)' : '(deleted rule)'),
        ruleScope: meta?.scope ?? null,
        ruleMarketplace: meta?.marketplace ?? null,
        ruleActive: meta?.isActive ?? false,
        sent: v.sent,
        reviewedAfter: v.reviewedAfter,
        conversionRate: v.sent > 0 ? v.reviewedAfter / v.sent : 0,
      }
    })
    .sort((a, b) => b.sent - a.sent)

  const daily = Array.from(dailyMap.entries())
    .map(([date, v]) => ({ date, sent: v.sent, reviewedAfter: v.reviewedAfter }))
    .sort((a, b) => a.date.localeCompare(b.date))

  logger.info('[review-analytics] computed', {
    windowDays,
    attributionWindowDays,
    totalSent,
    totalReviewed,
    durationMs: Date.now() - startedAt,
  })

  return {
    window: { since: since.toISOString(), until: now.toISOString(), days: windowDays },
    overall: {
      sent: totalSent,
      reviewedAfter: totalReviewed,
      conversionRate: totalSent > 0 ? totalReviewed / totalSent : 0,
    },
    perMarketplace,
    perProductType,
    perRule,
    daily,
  }
}
