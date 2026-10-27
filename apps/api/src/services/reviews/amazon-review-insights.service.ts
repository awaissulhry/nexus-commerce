import { workspaceKey } from '@nexus/database/workspace-context'
/**
 * D.3/D.4 — Amazon official Customer Feedback API (v2024-06-01) insights.
 *
 * Amazon exposes NO seller API for individual review TEXT (confirmed by Amazon
 * staff). The Customer Feedback API is what sellers DO get: per child ASIN × market
 * the top positive/negative review TOPICS (mentions, share of reviews, star-rating
 * impact, customer SNIPPETS) and, per topic, its 6-month TREND (share of reviews
 * that mention it, month by month). No star rating, average or review count.
 * Refreshed weekly, English only. Nexus reads UK/DE/FR/IT/ES (never Amazon.nl).
 * Surfaced as AmazonReviewInsight (aggregate), distinct from Review (individual,
 * from eBay feedback / import).
 *
 * The two operations, as Amazon's official model names them (checked 2026-10-27,
 * https://github.com/amzn/selling-partner-api-models/blob/main/models/customer-feedback-api-model/customerFeedback_2024-06-01.json;
 * docs/reviews/CHANNEL-FACTS.md rows 2a–2e):
 *  - getItemReviewTopics  GET /customerFeedback/2024-06-01/items/{asin}/reviews/topics?marketplaceId=&sortBy=MENTIONS
 *    (sortBy is required: MENTIONS | STAR_RATING_IMPACT) → topics.{positiveTopics,negativeTopics}[] of
 *    { topic, asinMetrics, parentAsinMetrics: { numberOfMentions, occurrencePercentage, starRatingImpact }, reviewSnippets }
 *  - getItemReviewTrends  GET /customerFeedback/2024-06-01/items/{asin}/reviews/trends?marketplaceId=
 *    → reviewTrends.{positiveTopics,negativeTopics}[] of { topic, trendMetrics[≤ 6 months] } (amazon-review-trends.ts)
 * Both take a CHILD ASIN ("The value must be a child ASIN"). A family is read once, with one of its child ASINs, and
 * keeps the parent's numbers (parentAsinMetrics); the row stays keyed by the family's ASIN.
 *
 * Both go through amazonSpApiClient.request → the channel gateway (same account, the same rate bucket
 * `GET /customerFeedback/2024-06-01/items`, which follows Amazon's x-amzn-RateLimit-Limit header: Amazon publishes no
 * fixed rate for these operations). Needs the Selling Partner Insights role → probe + per-row accessStatus, never a
 * fake "0 reviews"; the parsers keep a few older spellings and capture the raw payload via debugState.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { parseItemReviewTrends, type MetricsLevel, type StoredTrends } from './amazon-review-trends.js'
import { TOPIC_MARKETS } from './review-channel-math.js'

const API = '/customerFeedback/2024-06-01'
export const topicsPath = (asin: string) => `${API}/items/${encodeURIComponent(asin)}/reviews/topics`
export const trendsPath = (asin: string) => `${API}/items/${encodeURIComponent(asin)}/reviews/trends`
// Denied-access signature (same as SQP probeSqpAccess). 'brand' catches
// "requires Brand Analytics role" style messages.
const DENIED_RE = /401|403|unauthori|not authori|access|forbidden|brand/i

function num(v: unknown): number | null { const n = Number(v); return Number.isFinite(n) ? n : null }
function str(v: unknown): string | null { return typeof v === 'string' && v.trim() ? v.trim() : null }

// `share`: Amazon's own "share of reviews" for the topic (percent), when the payload carries one (Reviews Insights, PR E).
export interface InsightTopic { topic: string; mentionCount: number | null; ratingImpact: number | null; share?: number | null; snippets: string[] }
export interface ParsedInsight {
  positiveTopics: InsightTopic[]
  negativeTopics: InsightTopic[]
  snippets: string[]
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
  const row = await prisma.marketplace.findUnique({ where: { channel_code: workspaceKey({ channel: 'AMAZON', code }) } }).catch(() => null)
  return row?.marketplaceId ?? null
}

/** One family to read: `asin` keys the row (the parent ASIN, else the child's); `childAsin` is the one Amazon is asked. */
export interface InsightItem { asin: string; childAsin: string; level: MetricsLevel }

const ASIN_RE = /^[A-Z0-9]{10}$/

/**
 * Our Amazon items for a marketplace: one per family (ACTIVE listings first, deduped, capped). Amazon's operations take a
 * CHILD ASIN, so each family is asked with one of its child ASINs (`externalListingId`) and keeps its parent's numbers.
 * `externalListingId` can be a SKU — only ASIN-shaped ids count.
 */
export async function ourAmazonItemsForMarketplace(marketplace: string, limit = 50): Promise<InsightItem[]> {
  const listings = await prisma.channelListing.findMany({
    where: { channel: 'AMAZON', OR: [{ marketplace }, { region: marketplace }] },
    select: { externalParentId: true, externalListingId: true, listingStatus: true },
    take: 1000,
  })
  return pickInsightItems(listings, limit)
}

/** Pure: the families to read from a market's Amazon listings (see ourAmazonItemsForMarketplace). */
export function pickInsightItems(
  listings: ReadonlyArray<{ externalParentId: string | null; externalListingId: string | null; listingStatus: string | null }>,
  limit = 50,
): InsightItem[] {
  const ordered = [...listings].sort((a, b) => (a.listingStatus === 'ACTIVE' ? -1 : 1) - (b.listingStatus === 'ACTIVE' ? -1 : 1))
  const items: InsightItem[] = []
  const seen = new Set<string>()
  for (const l of ordered) {
    const child = l.externalListingId?.trim() ?? ''
    if (!ASIN_RE.test(child)) continue
    const parent = l.externalParentId?.trim() ?? ''
    const family = ASIN_RE.test(parent) && parent !== child ? parent : child
    if (seen.has(family)) continue
    seen.add(family)
    items.push({ asin: family, childAsin: child, level: family === child ? 'asin' : 'parent' })
    if (items.length >= limit) break
  }
  return items
}

/** Our Amazon ASINs for a marketplace (the family keys) — kept for callers that only need the ids. */
export async function ourAmazonAsinsForMarketplace(marketplace: string, limit = 50): Promise<string[]> {
  return (await ourAmazonItemsForMarketplace(marketplace, limit)).map((i) => i.asin)
}

/** Amazon's Customer Feedback API: UK, DE, FR, IT, ES for Nexus (never Amazon.nl; GB is the UK). */
export function servesReviewTopics(marketplaceCode: string): boolean {
  const code = marketplaceCode.trim().toUpperCase()
  return TOPIC_MARKETS.has(code === 'GB' ? 'UK' : code)
}

// ── Raw fetchers (through the gateway; throw on non-2xx, caller classifies; 204 → undefined) ──
async function fetchItemReviewTopics(childAsin: string, marketplaceId: string): Promise<unknown> {
  const { amazonSpApiClient } = await import('../../clients/amazon-sp-api.client.js')
  return amazonSpApiClient.request('GET', topicsPath(childAsin), { query: { marketplaceId, sortBy: 'MENTIONS' }, label: 'getItemReviewTopics' })
}
async function fetchItemReviewTrends(childAsin: string, marketplaceId: string): Promise<unknown> {
  const { amazonSpApiClient } = await import('../../clients/amazon-sp-api.client.js')
  return amazonSpApiClient.request('GET', trendsPath(childAsin), { query: { marketplaceId }, label: 'getItemReviewTrends' })
}

// ── Parsers: Amazon's model first (topics.{positiveTopics,negativeTopics}[] with asinMetrics / parentAsinMetrics),
// then the older spellings this file guessed before the model was read ──
type AnyRecord = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

function parseTopic(raw: unknown, level: MetricsLevel = 'asin'): InsightTopic | null {
  const r = (raw ?? {}) as AnyRecord
  const topic = str(r.topic ?? r.topicName ?? r.name ?? r.title ?? r.theme)
  if (!topic) return null
  const snipRaw = (r.reviewSnippets ?? r.snippets ?? r.customerSnippets ?? r.examples ?? []) as unknown[]
  const snippets = (Array.isArray(snipRaw) ? snipRaw : []).map((s) => (typeof s === 'string' ? s : str((s as Record<string, unknown>)?.text ?? (s as Record<string, unknown>)?.snippet ?? (s as Record<string, unknown>)?.review))).filter((s): s is string => !!s)
  // The model: a topic's numbers sit in asinMetrics (the asked child ASIN) and parentAsinMetrics (its family; null
  // when Amazon has too little data for the parent).
  const own = r.asinMetrics && typeof r.asinMetrics === 'object' ? (r.asinMetrics as AnyRecord) : null
  const parent = r.parentAsinMetrics && typeof r.parentAsinMetrics === 'object' ? (r.parentAsinMetrics as AnyRecord) : null
  const m = (level === 'parent' ? parent ?? own : own) ?? null
  if (m) {
    return {
      topic,
      mentionCount: num(m.numberOfMentions),
      ratingImpact: num(m.starRatingImpact),
      share: num(m.occurrencePercentage),
      snippets,
    }
  }
  return {
    topic,
    mentionCount: num(r.mentionCount ?? r.mentions ?? r.reviewMentions ?? r.count ?? r.reviewCount),
    ratingImpact: num(r.ratingImpact ?? r.starRatingImpact ?? r.impact ?? r.starImpact),
    share: num(r.share ?? r.reviewPercentage ?? r.percentageOfReviews ?? r.percentOfReviews ?? r.mentionPercentage),
    snippets,
  }
}

export function parseTopics(payload: unknown, level: MetricsLevel = 'asin'): ParsedInsight {
  const top = (payload ?? {}) as AnyRecord
  // The model nests both lists under `topics`; each is null when Amazon has too few reviews.
  const root = (top.topics && typeof top.topics === 'object' && !Array.isArray(top.topics) ? top.topics : top) as AnyRecord
  const pos: InsightTopic[] = []
  const neg: InsightTopic[] = []
  // Shape A: separate arrays. Shape B: one array with a sentiment field.
  const posRaw = (root.positiveTopics ?? root.positives ?? root.mostPositiveTopics) as unknown[] | undefined
  const negRaw = (root.negativeTopics ?? root.negatives ?? root.mostNegativeTopics) as unknown[] | undefined
  if (Array.isArray(posRaw) || Array.isArray(negRaw) || 'positiveTopics' in root || 'negativeTopics' in root) {
    for (const t of Array.isArray(posRaw) ? posRaw : []) { const p = parseTopic(t, level); if (p) pos.push(p) }
    for (const t of Array.isArray(negRaw) ? negRaw : []) { const p = parseTopic(t, level); if (p) neg.push(p) }
  } else {
    const all = (root.topics ?? root.reviewTopics ?? root.items ?? (Array.isArray(payload) ? payload : [])) as unknown[]
    for (const t of Array.isArray(all) ? all : []) {
      const p = parseTopic(t, level)
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

// ── Access probe — the gating unknown: is the Selling Partner Insights role granted? ──
export interface InsightsProbeResult { available: boolean; marketplace: string; asinTested: string | null; detail: string }

export async function probeAmazonReviewInsightsAccess(marketplaceCode: string): Promise<InsightsProbeResult> {
  if (!servesReviewTopics(marketplaceCode)) return { available: false, marketplace: marketplaceCode, asinTested: null, detail: `Amazon gives review topics for UK, DE, FR, IT and ES only (not ${marketplaceCode})` }
  const marketplaceId = await resolveMarketplaceId(marketplaceCode)
  if (!marketplaceId) return { available: false, marketplace: marketplaceCode, asinTested: null, detail: `no Marketplace row for AMAZON:${marketplaceCode}` }
  const item = (await ourAmazonItemsForMarketplace(marketplaceCode, 1))[0]
  if (!item) return { available: false, marketplace: marketplaceCode, asinTested: null, detail: `no Amazon child ASIN found for ${marketplaceCode} (ChannelListing externalListingId)` }
  try {
    const payload = await fetchItemReviewTopics(item.childAsin, marketplaceId)
    captureDebug('topics', item.childAsin, payload)
    return { available: true, marketplace: marketplaceCode, asinTested: item.childAsin, detail: 'getItemReviewTopics request accepted' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const denied = DENIED_RE.test(msg)
    return { available: !denied, marketplace: marketplaceCode, asinTested: item.childAsin, detail: msg.slice(0, 300) }
  }
}

// ── Ingest (D.4): one upsert per family; per-ASIN 403 → accessStatus, never a throw ──
export interface InsightsIngestResult {
  marketplace: string
  asinsRequested: number
  upserted: number
  deniedAsins: number
  failedAsins: number
  noAsin: boolean
  /** Amazon's 6-month trends: read, refused (401/403) or failed, per family whose topics were read. */
  trendsRead?: number
  trendsDenied?: number
  trendsFailed?: number
  /** Not one of the five markets Amazon gives topics for: nothing asked. */
  notServed?: boolean
}

/** The trends read of one family, as `AmazonReviewInsight.trend` keeps it (amazon-review-trends.ts). */
async function readTrends(item: InsightItem, marketplaceId: string, marketplaceCode: string): Promise<StoredTrends> {
  const at = new Date().toISOString()
  try {
    const payload = await fetchItemReviewTrends(item.childAsin, marketplaceId)
    captureDebug('trends', item.childAsin, payload)
    return { read: 'OK', at, topics: parseItemReviewTrends(payload, item.level) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const denied = DENIED_RE.test(msg)
    if (!denied) logger.warn('[review-insights] trends fetch failed', { marketplace: marketplaceCode, asin: item.childAsin, error: msg })
    return { read: denied ? 'REFUSED' : 'ERROR', at, topics: [] }
  }
}

export async function ingestAmazonReviewInsights(args: { marketplaceCode: string; limit?: number; asins?: string[] }): Promise<InsightsIngestResult> {
  const empty = { marketplace: args.marketplaceCode, asinsRequested: 0, upserted: 0, deniedAsins: 0, failedAsins: 0, noAsin: false }
  if (!servesReviewTopics(args.marketplaceCode)) return { ...empty, notServed: true }
  const marketplaceId = await resolveMarketplaceId(args.marketplaceCode)
  if (!marketplaceId) throw new Error(`ingestAmazonReviewInsights: no Marketplace row for AMAZON:${args.marketplaceCode}`)
  const items: InsightItem[] = args.asins?.length
    ? args.asins.map((asin) => ({ asin, childAsin: asin, level: 'asin' as const }))
    : await ourAmazonItemsForMarketplace(args.marketplaceCode, args.limit ?? 50)
  if (items.length === 0) return { ...empty, noAsin: true }

  let upserted = 0, deniedAsins = 0, failedAsins = 0, trendsRead = 0, trendsDenied = 0, trendsFailed = 0
  for (const item of items) {
    const { asin } = item
    let topicsPayload: unknown = null
    let accessStatus = 'OK'
    try {
      topicsPayload = await fetchItemReviewTopics(item.childAsin, marketplaceId)
      captureDebug('topics', item.childAsin, topicsPayload)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (DENIED_RE.test(msg)) { accessStatus = 'NEEDS_BRAND_ANALYTICS_ROLE'; deniedAsins += 1 }
      else { accessStatus = 'ERROR'; failedAsins += 1; logger.warn('[review-insights] topics fetch failed', { marketplace: args.marketplaceCode, asin: item.childAsin, error: msg }) }
    }
    // The trends read follows a topics read Amazon answered (same account, same rate bucket); a refused or failed
    // topics read leaves the trend unread ([], as before) — the row's accessStatus already says why.
    let trend: StoredTrends | [] = []
    if (accessStatus === 'OK') {
      trend = await readTrends(item, marketplaceId, args.marketplaceCode)
      if (trend.read === 'OK') trendsRead += 1
      else if (trend.read === 'REFUSED') trendsDenied += 1
      else trendsFailed += 1
    }

    const topics = accessStatus === 'OK' ? parseTopics(topicsPayload, item.level) : { positiveTopics: [], negativeTopics: [], snippets: [] }
    const product = await prisma.product.findFirst({ where: { amazonAsin: asin }, select: { id: true } }).catch(() => null)
    // Amazon gives no star rating, average or review count (CHANNEL-FACTS row 2e): those two columns stay empty.
    const data = {
      productId: product?.id ?? null,
      starRating: null, reviewCount: null,
      positiveTopics: topics.positiveTopics as object, negativeTopics: topics.negativeTopics as object,
      snippets: topics.snippets as object, trend: trend as object,
      accessStatus, raw: (topicsPayload ?? null) as object,
    }

    await prisma.amazonReviewInsight.upsert({
      where: { asin_marketplace: workspaceKey({ asin, marketplace: args.marketplaceCode }) },
      create: { asin, marketplace: args.marketplaceCode, ...data },
      update: { ...data, fetchedAt: new Date() },
    })
    upserted += 1
  }
  return { marketplace: args.marketplaceCode, asinsRequested: items.length, upserted, deniedAsins, failedAsins, noAsin: false, trendsRead, trendsDenied, trendsFailed }
}
