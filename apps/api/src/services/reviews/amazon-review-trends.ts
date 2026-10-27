/**
 * Amazon's 6-month topic trends (Customer Feedback API v2024-06-01, `getItemReviewTrends`) — pure: Amazon's answer read
 * into the shape Nexus keeps in `AmazonReviewInsight.trend`, and one topic's trend for the Amazon channel page. Tested in
 * amazon-review-trends.vitest.test.ts with the example of Amazon's own model.
 *
 * What Amazon gives (official model, checked 2026-10-27:
 * https://github.com/amzn/selling-partner-api-models/blob/main/models/customer-feedback-api-model/customerFeedback_2024-06-01.json):
 *  - `GET /customerFeedback/2024-06-01/items/{asin}/reviews/trends?marketplaceId=` — "an item's positive and negative
 *    review trends for the past six months"; the path's ASIN is a child ASIN ("This API takes child ASIN as an input").
 *  - `ItemReviewTrendsResponse.reviewTrends.{positiveTopics, negativeTopics}` — at most 10 topics each, `null` "if there
 *    are not enough positive (negative) reviews". A topic: `{ topic, trendMetrics[] }`, at most 6 points, one per month:
 *    `dateRange.startDate`, `asinMetrics.occurrencePercentage` ("the percentage of reviews that mention the topic") and
 *    `parentAsinMetrics.occurrencePercentage` (`null` "if there isn't enough topic data for the parent ASIN").
 *  - No star rating, average or review count, per month or otherwise (docs/reviews/CHANNEL-FACTS.md row 2e).
 *  - Markets: the API serves the US, UK, FR, IT, DE, ES and JP; Nexus reads the UK, DE, FR, IT and ES, never Amazon.nl
 *    (row 2a, https://developer-docs.amazon.com/sp-api/docs/customer-feedback-api). Refreshed weekly, English only,
 *    needs the Selling Partner Insights role (rows 2b–2d).
 *  - Rate limit: neither the model nor the reference pages publish a number — only the `x-amzn-RateLimit-Limit` answer
 *    header ("Your rate limit (requests per second) for this operation"). The channel gateway's Amazon bucket follows that
 *    header; the topics and trends reads share one bucket (`GET /customerFeedback/2024-06-01/items`).
 */

export type TopicPolarity = 'POSITIVE' | 'NEGATIVE'

/** One month of a topic: the share of that month's reviews that mention it (percent); null when Amazon sent none. */
export interface TopicTrendPoint { month: string; share: number | null }

export interface StoredTopicTrend { topic: string; polarity: TopicPolarity; points: TopicTrendPoint[] }

/** How the last trends read went: Amazon answered (OK), refused it (REFUSED — 401/403), or failed otherwise (ERROR). */
export type TrendRead = 'OK' | 'REFUSED' | 'ERROR'

/** `AmazonReviewInsight.trend` since 2026-10-27. Rows written before hold an array (a star trend Amazon never gives). */
export interface StoredTrends { read: TrendRead; at: string; topics: StoredTopicTrend[] }

/** Whose numbers a row keeps: the asked child ASIN's own, or its parent's (the whole family, when the listing has one). */
export type MetricsLevel = 'asin' | 'parent'

/** Amazon gives a trend of at most six months. */
export const TREND_MONTHS = 6

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const finite = (v: unknown): number | null => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null)
const round2 = (n: number) => Math.round(n * 100) / 100

/** `2024-06-01T00:00:00.000Z` → `2024-06`; anything that does not start with a year and a month → null. */
export function monthOf(raw: unknown): string | null {
  const m = typeof raw === 'string' ? /^(\d{4})-(\d{2})/.exec(raw.trim()) : null
  if (!m) return null
  const month = Number(m[2])
  return month >= 1 && month <= 12 ? `${m[1]}-${m[2]}` : null
}

/** A topic's months, oldest first, one point per month (the last one read wins), at most the newest six. */
function cleanPoints(points: TopicTrendPoint[]): TopicTrendPoint[] {
  const byMonth = new Map<string, number | null>()
  for (const p of points) byMonth.set(p.month, p.share)
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-TREND_MONTHS)
    .map(([month, share]) => ({ month, share }))
}

/** Amazon's `getItemReviewTrends` answer → the topics' monthly shares, at the row's level (child ASIN or parent). */
export function parseItemReviewTrends(payload: unknown, level: MetricsLevel = 'asin'): StoredTopicTrend[] {
  const root = asRecord(payload)
  const trends = asRecord(root.reviewTrends)
  const out: StoredTopicTrend[] = []
  for (const polarity of ['POSITIVE', 'NEGATIVE'] as const) {
    const list = polarity === 'POSITIVE' ? trends.positiveTopics : trends.negativeTopics
    if (!Array.isArray(list)) continue // null: "not enough reviews"
    for (const raw of list) {
      const t = asRecord(raw)
      const topic = typeof t.topic === 'string' ? t.topic.trim() : ''
      if (!topic || !Array.isArray(t.trendMetrics)) continue
      const points: TopicTrendPoint[] = []
      for (const rawPoint of t.trendMetrics) {
        const p = asRecord(rawPoint)
        const month = monthOf(asRecord(p.dateRange).startDate)
        if (!month) continue
        const metrics = asRecord(level === 'parent' ? p.parentAsinMetrics : p.asinMetrics)
        const share = finite(metrics.occurrencePercentage)
        points.push({ month, share: share == null ? null : round2(Math.min(100, Math.max(0, share))) })
      }
      const clean = cleanPoints(points)
      if (clean.length) out.push({ topic, polarity, points: clean })
    }
  }
  return out
}

/** What a row's `trend` holds, read safely; null for a row written before trends were read (an array) or anything else. */
export function readStoredTrends(raw: unknown): StoredTrends | null {
  const r = asRecord(raw)
  if (r.read !== 'OK' && r.read !== 'REFUSED' && r.read !== 'ERROR') return null
  const topics: StoredTopicTrend[] = []
  for (const rawTopic of Array.isArray(r.topics) ? r.topics : []) {
    const t = asRecord(rawTopic)
    const topic = typeof t.topic === 'string' ? t.topic.trim() : ''
    if (!topic || (t.polarity !== 'POSITIVE' && t.polarity !== 'NEGATIVE')) continue
    const points = (Array.isArray(t.points) ? t.points : [])
      .map((p) => asRecord(p))
      .map((p) => ({ month: monthOf(p.month), share: finite(p.share) }))
      .filter((p): p is TopicTrendPoint => p.month != null)
    topics.push({ topic, polarity: t.polarity, points: cleanPoints(points) })
  }
  return { read: r.read, at: typeof r.at === 'string' ? r.at : '', topics }
}

// ── One topic's trend on the channel page ─────────────────────────────

/**
 * A topic's 6-month trend as the Amazon page gets it:
 *  - `ok` — the monthly shares (oldest first). A topic that several reads mention (several products, or one product in
 *    several markets) gets each month's shares weighted by the topic's mentions in each read — the same weighting the
 *    Insights page gives Amazon's share of reviews; `reads`, `products` and `markets` say how many went into it.
 *  - `none` — Amazon's trend was read but has no line for this topic (Amazon lists its own top ten).
 *  - `refused` — Amazon refused or failed the last trends read of every product that mentions it.
 *  - `not_read` — no trends read yet for the products that mention it (read with the weekly topics from 2026-10-27).
 */
export type TopicTrend =
  | { state: 'ok'; points: TopicTrendPoint[]; reads: number; products: number; markets: number }
  | { state: 'none' | 'refused' | 'not_read' }

export interface TrendSourceRow {
  asin: string
  marketplace: string
  productId: string | null
  positiveTopics: unknown
  negativeTopics: unknown
  trend: unknown
}

const sameTopic = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

function mentionsIn(list: unknown, label: string): number | null {
  if (!Array.isArray(list)) return null
  for (const raw of list) {
    const t = asRecord(raw)
    if (typeof t.topic === 'string' && sameTopic(t.topic, label)) return Math.max(0, finite(t.mentionCount) ?? 0)
  }
  return null
}

/** The trend of one topic (by its label, as Amazon's topics are merged) over the rows of a page's scope. */
export function topicTrend(rows: ReadonlyArray<TrendSourceRow>, polarity: TopicPolarity, label: string): TopicTrend {
  const lines: Array<{ row: TrendSourceRow; weight: number; points: TopicTrendPoint[] }> = []
  let readOk = false
  let refused = false
  for (const row of rows) {
    const mentions = mentionsIn(polarity === 'POSITIVE' ? row.positiveTopics : row.negativeTopics, label)
    if (mentions == null) continue // this read does not have the topic
    const stored = readStoredTrends(row.trend)
    if (!stored) continue
    if (stored.read !== 'OK') { refused = true; continue }
    readOk = true
    const line = stored.topics.find((t) => t.polarity === polarity && sameTopic(t.topic, label))
    if (line && line.points.some((p) => p.share != null)) lines.push({ row, weight: Math.max(1, mentions), points: line.points })
  }
  if (lines.length === 0) return { state: readOk ? 'none' : refused ? 'refused' : 'not_read' }

  const months = [...new Set(lines.flatMap((l) => l.points.map((p) => p.month)))].sort().slice(-TREND_MONTHS)
  const points = months.map((month) => {
    let sum = 0
    let weight = 0
    for (const l of lines) {
      const share = l.points.find((p) => p.month === month)?.share
      if (share == null) continue
      sum += share * l.weight
      weight += l.weight
    }
    return { month, share: weight > 0 ? round2(sum / weight) : null }
  })
  return {
    state: 'ok',
    points,
    reads: lines.length,
    products: new Set(lines.map((l) => l.row.productId ?? `asin:${l.row.asin}`)).size,
    markets: new Set(lines.map((l) => l.row.marketplace.toUpperCase())).size,
  }
}
