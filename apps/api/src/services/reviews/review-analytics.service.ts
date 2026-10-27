/**
 * RV.8.1 — "What requests brought" (GET /api/reviews/analytics: the Requests page's results card): requests sent in the
 * window, the reviews that followed and the review rate, overall, by market, by product type, by rule and by day.
 *
 * Since the 2026-10-27 audit (C2) every number here is the ONE review rate (review-rate.service.ts): the reviews the
 * attribution job linked to a request (by order for eBay and Amazon seller feedback, by product otherwise), divided by
 * the requests sent where a review can follow. A row where nothing can follow has `conversionRate: null` and its words
 * ("Not measurable: …") — never 0 %. Fixture rows never count.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { readRateFacts, readRateRequests, rateOf, type RateFacts, type RateRequest } from './review-rate.service.js'

export interface RateRollup {
  sent: number
  /** Sent where a review can follow. */
  measured: number
  reviewedAfter: number
  /** 0..1; null when nothing measurable was sent. */
  conversionRate: number | null
  /** Why requests are left out of the rate, or why there is none; null when every sent request counts. */
  words: string | null
}

export interface ReviewAnalyticsResult {
  window: { since: string; until: string; days: number }
  overall: RateRollup
  perMarketplace: Array<RateRollup & { marketplace: string }>
  perProductType: Array<RateRollup & { productType: string }>
  // RV.9.4 — per-rule rollup so operators can compare rule configs.
  perRule: Array<RateRollup & {
    ruleId: string | null
    ruleName: string
    ruleScope: string | null
    ruleMarketplace: string | null
    ruleActive: boolean
  }>
  daily: Array<{ date: string; sent: number; reviewedAfter: number }>
}

interface AnalyticsArgs {
  /** Look back this many days. Default 30. Max 180. */
  windowDays?: number
  /** Kept for callers; the review rate always counts reviews within 30 days of the request (review-rate.service.ts). */
  attributionWindowDays?: number
}

/** One rollup of a group of sent requests. Pure. */
function rollupOf(rows: readonly RateRequest[], facts: RateFacts): RateRollup {
  const r = rateOf(rows, facts)
  return { sent: r.sent, measured: r.measured, reviewedAfter: r.followed, conversionRate: r.rate, words: r.words }
}

function groupBy<T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const row of rows) {
    const key = keyOf(row)
    const list = out.get(key) ?? []
    list.push(row)
    out.set(key, list)
  }
  return out
}

export async function computeReviewAnalytics(args: AnalyticsArgs = {}): Promise<ReviewAnalyticsResult> {
  const startedAt = Date.now()
  const windowDays = Math.min(Math.max(args.windowDays ?? 30, 7), 180)
  const now = new Date()
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000)

  const [rows, facts] = await Promise.all([readRateRequests({ from: since, to: now }), readRateFacts()])

  const ruleIds = [...new Set(rows.map((r) => r.ruleId).filter((v): v is string => !!v))]
  const ruleMeta = ruleIds.length
    ? await prisma.reviewRule.findMany({ where: { id: { in: ruleIds } }, select: { id: true, name: true, scope: true, marketplace: true, isActive: true } })
    : []
  const ruleMetaById = new Map(ruleMeta.map((r) => [r.id, r]))

  const perMarketplace = [...groupBy(rows, (r) => r.marketplace ?? '—')]
    .map(([marketplace, list]) => ({ marketplace, ...rollupOf(list, facts) }))
    .sort((a, b) => b.sent - a.sent)
  const perProductType = [...groupBy(rows, (r) => r.productType ?? '—')]
    .map(([productType, list]) => ({ productType, ...rollupOf(list, facts) }))
    .sort((a, b) => b.sent - a.sent)
    .slice(0, 10)
  const perRule = [...groupBy(rows, (r) => r.ruleId ?? '__nullrule__')]
    .map(([key, list]) => {
      const meta = key === '__nullrule__' ? null : ruleMetaById.get(key) ?? null
      return {
        ruleId: key === '__nullrule__' ? null : key,
        ruleName: meta?.name ?? (key === '__nullrule__' ? 'No rule (default timing)' : 'A deleted rule'),
        ruleScope: meta?.scope ?? null,
        ruleMarketplace: meta?.marketplace ?? null,
        ruleActive: meta?.isActive ?? false,
        ...rollupOf(list, facts),
      }
    })
    .sort((a, b) => b.sent - a.sent)

  const daily = new Map<string, { sent: number; reviewedAfter: number }>()
  for (let i = 0; i < windowDays; i++) daily.set(new Date(since.getTime() + i * 86_400_000).toISOString().slice(0, 10), { sent: 0, reviewedAfter: 0 })
  for (const r of rows) {
    if (!r.sentAt) continue
    const day = r.sentAt.toISOString().slice(0, 10)
    const d = daily.get(day) ?? { sent: 0, reviewedAfter: 0 }
    d.sent += 1
    if (r.followed) d.reviewedAfter += 1
    daily.set(day, d)
  }

  const overall = rollupOf(rows, facts)
  logger.info('[review-analytics] computed', { windowDays, sent: overall.sent, followed: overall.reviewedAfter, durationMs: Date.now() - startedAt })
  return {
    window: { since: since.toISOString(), until: now.toISOString(), days: windowDays },
    overall,
    perMarketplace,
    perProductType,
    perRule,
    daily: [...daily.entries()].map(([date, v]) => ({ date, ...v })).sort((a, b) => a.date.localeCompare(b.date)),
  }
}
