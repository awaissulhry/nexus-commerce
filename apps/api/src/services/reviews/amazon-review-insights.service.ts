/**
 * D.3/D.4 — Amazon official Customer Feedback API (v2024-06-01) insights.
 *
 * Amazon exposes NO seller API for individual review TEXT (confirmed by Amazon
 * staff). The Customer Feedback API is what sellers DO get: per ASIN × market it
 * returns the top positive/negative review TOPICS (mention counts, star-rating
 * impact, customer SNIPPETS) + a month-over-month star TREND. Refreshed weekly.
 * Available in IT/DE/FR/ES (+UK/US/JP). This is the real Amazon review signal —
 * surfaced as AmazonReviewInsight (aggregate), distinct from Review (individual,
 * from eBay feedback / import).
 *
 * Patterned on the SQP service (advertising/sqp.service.ts) — the other Brand-
 * Analytics-role-gated SP-API insight: same ASIN resolver, same honest 403 probe,
 * same defensive parser + debug capture. The one difference: this is a direct GET
 * (amazonSpApiClient.request), not the async report flow.
 *
 * Two unknowns handled honestly: (1) the Brand Analytics / Selling Partner
 * Insights ROLE may not be granted → probe + per-row accessStatus, never a fake
 * "0 reviews"; (2) the v2024-06-01 response SHAPE isn't reliably documented → the
 * parsers try common spellings and capture the raw payload via debugState so we
 * can tighten them against the first real response.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

const PATH_TOPICS = '/customerFeedback/2024-06-01/itemReviewTopics'
const PATH_TRENDS = '/customerFeedback/2024-06-01/itemReviewTrends'
// Denied-access signature (same as SQP probeSqpAccess). 'brand' catches
// "requires Brand Analytics role" style messages.
const DENIED_RE = /401|403|unauthori|not authori|access|forbidden|brand/i

function num(v: unknown): number | null { const n = Number(v); return Number.isFinite(n) ? n : null }
function str(v: unknown): string | null { return typeof v === 'string' && v.trim() ? v.trim() : null }

export interface InsightTopic { topic: string; mentionCount: number | null; ratingImpact: number | null; snippets: string[] }
export interface InsightTrendPoint { month: string; starRating: number | null; reviewCount: number | null }
export interface ParsedInsight {
  positiveTopics: InsightTopic[]
  negativeTopics: InsightTopic[]
  snippets: string[]
  starRating: number | null
  reviewCount: number | null
  trend: InsightTrendPoint[]
}

// Diagnostic: the last fetched raw shapes, surfaced via GET /reviews/insights/debug
// so the parsers can be finalised against Amazon's real fields without Railway log
// access. Captured on each probe/ingest.
export const insightsDebugState: { topics: { at: string; asin: string; topKeys: string[]; sample: string } | null; trends: { at: string; asin: string; topKeys: string[]; sample: string } | null } = { topics: null, trends: null }

function captureDebug(kind: 'topics' | 'trends', asin: string, payload: unknown) {
  const root = (payload ?? {}) as Record<string, unknown>
  insightsDebugState[kind] = { at: new Date().toISOString(), asin, topKeys: Object.keys(root), sample: JSON.stringify(payload)?.slice(0, 2000) ?? '' }
}

// ── ASIN + marketplace resolution (reused from SQP, kept local to avoid coupling) ──
async function resolveMarketplaceId(code: string): Promise<string | null> {
  const row = await prisma.marketplace.findUnique({ where: { channel_code: { channel: 'AMAZON', code } } }).catch(() => null)
  return row?.marketplaceId ?? null
}

/** Our Amazon ASINs for a marketplace — prefers PARENT asins, ACTIVE-first, deduped, capped. */
export async function ourAmazonAsinsForMarketplace(marketplace: string, limit = 50): Promise<string[]> {
  const listings = await prisma.channelListing.findMany({
    where: { channel: 'AMAZON', OR: [{ marketplace }, { region: marketplace }] },
    select: { externalParentId: true, externalListingId: true, listingStatus: true },
    take: 1000,
  })
  const ordered = [...listings].sort((a, b) => (a.listingStatus === 'ACTIVE' ? -1 : 1) - (b.listingStatus === 'ACTIVE' ? -1 : 1))
  const asins: string[] = []
  const seen = new Set<string>()
  for (const l of ordered) {
    const asin = l.externalParentId || l.externalListingId
    // Amazon ASINs are 10-char B0…; externalListingId can be a SKU — only accept ASIN-shaped ids.
    if (asin && /^[A-Z0-9]{10}$/.test(asin) && !seen.has(asin)) { seen.add(asin); asins.push(asin) }
    if (asins.length >= limit) break
  }
  return asins
}

// ── Raw fetchers (direct GET; throw on non-2xx, caller classifies) ──
async function fetchItemReviewTopics(asin: string, marketplaceId: string): Promise<unknown> {
  const { amazonSpApiClient } = await import('../../clients/amazon-sp-api.client.js')
  return amazonSpApiClient.request('GET', PATH_TOPICS, { query: { asin, marketplaceId }, label: 'reviewInsights.topics' })
}
async function fetchItemReviewTrends(asin: string, marketplaceId: string): Promise<unknown> {
  const { amazonSpApiClient } = await import('../../clients/amazon-sp-api.client.js')
  return amazonSpApiClient.request('GET', PATH_TRENDS, { query: { asin, marketplaceId }, label: 'reviewInsights.trends' })
}

// ── Defensive parsers (the v2024-06-01 shape isn't reliably documented) ──
function parseTopic(raw: unknown): InsightTopic | null {
  const r = (raw ?? {}) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  const topic = str(r.topic ?? r.topicName ?? r.name ?? r.title ?? r.theme)
  if (!topic) return null
  const snipRaw = (r.snippets ?? r.reviewSnippets ?? r.customerSnippets ?? r.examples ?? []) as unknown[]
  const snippets = (Array.isArray(snipRaw) ? snipRaw : []).map((s) => (typeof s === 'string' ? s : str((s as Record<string, unknown>)?.text ?? (s as Record<string, unknown>)?.snippet ?? (s as Record<string, unknown>)?.review))).filter((s): s is string => !!s)
  return {
    topic,
    mentionCount: num(r.mentionCount ?? r.mentions ?? r.reviewMentions ?? r.count ?? r.reviewCount),
    ratingImpact: num(r.ratingImpact ?? r.starRatingImpact ?? r.impact ?? r.starImpact),
    snippets,
  }
}

export function parseTopics(payload: unknown): Pick<ParsedInsight, 'positiveTopics' | 'negativeTopics' | 'snippets'> {
  const root = (payload ?? {}) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  const pos: InsightTopic[] = []
  const neg: InsightTopic[] = []
  // Shape A: separate arrays. Shape B: one array with a sentiment field.
  const posRaw = (root.positiveTopics ?? root.positives ?? root.mostPositiveTopics) as unknown[] | undefined
  const negRaw = (root.negativeTopics ?? root.negatives ?? root.mostNegativeTopics) as unknown[] | undefined
  if (Array.isArray(posRaw) || Array.isArray(negRaw)) {
    for (const t of posRaw ?? []) { const p = parseTopic(t); if (p) pos.push(p) }
    for (const t of negRaw ?? []) { const p = parseTopic(t); if (p) neg.push(p) }
  } else {
    const all = (root.topics ?? root.reviewTopics ?? root.items ?? (Array.isArray(payload) ? payload : [])) as unknown[]
    for (const t of Array.isArray(all) ? all : []) {
      const p = parseTopic(t)
      if (!p) continue
      const sentiment = String((t as Record<string, unknown>)?.sentiment ?? (t as Record<string, unknown>)?.polarity ?? '').toUpperCase()
      const impact = p.ratingImpact
      if (sentiment.includes('NEG') || (impact != null && impact < 0)) neg.push(p)
      else pos.push(p)
    }
  }
  const snippets = [...pos, ...neg].flatMap((t) => t.snippets).slice(0, 12)
  return { positiveTopics: pos, negativeTopics: neg, snippets }
}

export function parseTrends(payload: unknown): Pick<ParsedInsight, 'starRating' | 'reviewCount' | 'trend'> {
  const root = (payload ?? {}) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  const arr = (root.trends ?? root.reviewTrends ?? root.monthlyTrends ?? root.dataByMonth ?? (Array.isArray(payload) ? payload : [])) as unknown[]
  const trend: InsightTrendPoint[] = []
  for (const raw of Array.isArray(arr) ? arr : []) {
    const r = (raw ?? {}) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
    const month = str(r.month ?? r.date ?? r.period ?? r.yearMonth)
    if (!month) continue
    trend.push({ month, starRating: num(r.starRating ?? r.averageStarRating ?? r.avgRating ?? r.rating), reviewCount: num(r.reviewCount ?? r.count ?? r.totalReviews) })
  }
  trend.sort((a, b) => a.month.localeCompare(b.month))
  const latest = trend.length ? trend[trend.length - 1] : null
  // Prefer an explicit top-level current rating if present, else the latest trend point.
  const starRating = num(root.starRating ?? root.averageStarRating ?? root.currentStarRating) ?? latest?.starRating ?? null
  const reviewCount = num(root.reviewCount ?? root.totalReviewCount ?? root.totalReviews) ?? latest?.reviewCount ?? null
  return { starRating, reviewCount, trend }
}

// ── Access probe — the gating unknown: is the Brand Analytics role granted? ──
export interface InsightsProbeResult { available: boolean; marketplace: string; asinTested: string | null; detail: string }

export async function probeAmazonReviewInsightsAccess(marketplaceCode: string): Promise<InsightsProbeResult> {
  const marketplaceId = await resolveMarketplaceId(marketplaceCode)
  if (!marketplaceId) return { available: false, marketplace: marketplaceCode, asinTested: null, detail: `no Marketplace row for AMAZON:${marketplaceCode}` }
  const asin = (await ourAmazonAsinsForMarketplace(marketplaceCode, 1))[0]
  if (!asin) return { available: false, marketplace: marketplaceCode, asinTested: null, detail: `no Amazon ASIN found for ${marketplaceCode} (ChannelListing externalParentId/externalListingId)` }
  try {
    const payload = await fetchItemReviewTopics(asin, marketplaceId)
    captureDebug('topics', asin, payload)
    return { available: true, marketplace: marketplaceCode, asinTested: asin, detail: 'itemReviewTopics request accepted' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const denied = DENIED_RE.test(msg)
    return { available: !denied, marketplace: marketplaceCode, asinTested: asin, detail: msg.slice(0, 300) }
  }
}

// ── Ingest (D.4): one upsert per ASIN; per-ASIN 403 → accessStatus, never a throw ──
export interface InsightsIngestResult { marketplace: string; asinsRequested: number; upserted: number; deniedAsins: number; failedAsins: number; noAsin: boolean }

export async function ingestAmazonReviewInsights(args: { marketplaceCode: string; limit?: number; asins?: string[] }): Promise<InsightsIngestResult> {
  const marketplaceId = await resolveMarketplaceId(args.marketplaceCode)
  if (!marketplaceId) throw new Error(`ingestAmazonReviewInsights: no Marketplace row for AMAZON:${args.marketplaceCode}`)
  const asins = args.asins?.length ? args.asins : await ourAmazonAsinsForMarketplace(args.marketplaceCode, args.limit ?? 50)
  if (asins.length === 0) return { marketplace: args.marketplaceCode, asinsRequested: 0, upserted: 0, deniedAsins: 0, failedAsins: 0, noAsin: true }

  let upserted = 0, deniedAsins = 0, failedAsins = 0
  for (const asin of asins) {
    let topicsPayload: unknown = null, trendsPayload: unknown = null
    let accessStatus = 'OK'
    try {
      topicsPayload = await fetchItemReviewTopics(asin, marketplaceId)
      captureDebug('topics', asin, topicsPayload)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (DENIED_RE.test(msg)) { accessStatus = 'NEEDS_BRAND_ANALYTICS_ROLE'; deniedAsins += 1 }
      else { accessStatus = 'ERROR'; failedAsins += 1; logger.warn('[review-insights] topics fetch failed', { marketplace: args.marketplaceCode, asin, error: msg }) }
    }
    if (accessStatus === 'OK') {
      try { trendsPayload = await fetchItemReviewTrends(asin, marketplaceId); captureDebug('trends', asin, trendsPayload) }
      catch (err) { logger.warn('[review-insights] trends fetch failed', { marketplace: args.marketplaceCode, asin, error: err instanceof Error ? err.message : String(err) }) }
    }

    const topics = accessStatus === 'OK' ? parseTopics(topicsPayload) : { positiveTopics: [], negativeTopics: [], snippets: [] }
    const trends = accessStatus === 'OK' ? parseTrends(trendsPayload) : { starRating: null, reviewCount: null, trend: [] }
    const product = await prisma.product.findFirst({ where: { amazonAsin: asin }, select: { id: true } }).catch(() => null)

    await prisma.amazonReviewInsight.upsert({
      where: { asin_marketplace: { asin, marketplace: args.marketplaceCode } },
      create: {
        asin, marketplace: args.marketplaceCode, productId: product?.id ?? null,
        starRating: trends.starRating, reviewCount: trends.reviewCount,
        positiveTopics: topics.positiveTopics as object, negativeTopics: topics.negativeTopics as object,
        snippets: topics.snippets as object, trend: trends.trend as object,
        accessStatus, raw: (topicsPayload ?? null) as object,
      },
      update: {
        productId: product?.id ?? null,
        starRating: trends.starRating, reviewCount: trends.reviewCount,
        positiveTopics: topics.positiveTopics as object, negativeTopics: topics.negativeTopics as object,
        snippets: topics.snippets as object, trend: trends.trend as object,
        accessStatus, fetchedAt: new Date(), raw: (topicsPayload ?? null) as object,
      },
    })
    upserted += 1
  }
  return { marketplace: args.marketplaceCode, asinsRequested: asins.length, upserted, deniedAsins, failedAsins, noAsin: false }
}
