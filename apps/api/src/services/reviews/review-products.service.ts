/**
 * Reviews Insights › Products and the product pop-up (routes/reviews.routes.ts):
 *
 *   GET /api/reviews/insights/products?channel&market&period&page&pageSize&q&theme&minRating&maxRating&openAlert&tile&family&sort&dir
 *       → families (a parent product, or a product on its own) with their variants: rating, reviews, change, a 6-week
 *         line, the top complaint, the return rate and the open alert; plus the tiles (below 4 stars, rating dropped,
 *         top return reason).
 *   GET /api/reviews/insights/products/:productId?channel&market&period
 *       → one product (a family: all its variants): rating per channel and market with the words its source is shown
 *         with, the star spread, themes with star impact, fit per size (Phase 3: null, "coming later"), the 3 latest
 *         reviews with their translations, and returns by reason.
 *
 * Ratings mix every channel and market; eBay feedback counts as 5, 3 or 1 star (per channel and market eBay reads as
 * "% positive"). An Amazon star comes only from reviews a person imported: Amazon gives no rating by API (ruling 5),
 * so a product Amazon knows only by its topics has no rating, and says so. Return rate = returns with a reason over
 * orders, last 30 days. Every Review read is visible rows only (review-visibility.ts).
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { visibleReviewWhere } from './review-visibility.js'
import { variantWords } from './review-inbox-query.js'
import {
  averageRating, buyerShort, delta, ratingIn, ratingKindOf, round, sparkValues, sparkWindows, starCounts, themeWords,
  type RatingKind,
} from './overviewMath.js'
import {
  amazonTopicMarkets, clip, insightBounds, MIN_PRODUCT_RATINGS, MIN_THEME_MENTIONS, parseInsightPeriod, parseInsightScope,
  parseTopicRows, pct, ratingSourceWords, reasonWords, returnRate, snippetFrom, themeStarImpact, whereWords, THEME_KEYS,
  type InsightPeriod, type InsightScope, type ParsedTopic, type ThemeKey,
} from './review-insights-math.js'

const DAY = 86_400_000
const SPARK_DAYS = 42
const RETURN_DAYS = 30
/** A rating this much lower than the period before is a drop ("Rating dropped" tile). */
export const DROP_AT = -0.3
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

type ReviewFact = {
  id: string
  productId: string | null
  channel: string
  marketplace: string | null
  rating: number | null
  postedAt: Date
  ingestSource: string | null
  sentiment: { label: string; categories: string[] } | null
}

type ProductRow = { id: string; sku: string; name: string; parentId: string | null; isParent: boolean; variantAttributes: unknown }

export interface ReturnRateCell {
  /** Percent, one decimal. */
  rate: number | null
  returns: number
  orders: number
}

export interface ProductMetrics {
  productId: string
  name: string
  sku: string
  /** "M · Black" for a variant; null otherwise. */
  variant: string | null
  /** Average stars of the period (two decimals), every channel; null with too few rated reviews or none at all. */
  rating: number | null
  /** The words the rating is shown with (ruling 5: Amazon stars only from imported reviews). */
  ratingWords: string
  /** Reviews and feedback in the period. */
  count: number
  /** Stars against the period before (one decimal); null when either side has too few. */
  change: number | null
  /** Average stars a week, 6 weeks, oldest first; null = too few to trend. */
  spark: Array<number | null> | null
  tooFew: boolean
  topNegativeTheme: { key: string; label: string; count: number; from: 'reviews' | 'amazon_topic' } | null
  returnRate: ReturnRateCell | null
  openAlert: { count: number; id: string; theme: string; market: string } | null
}

export interface ProductFamilyRow extends ProductMetrics {
  /** The family's own id (a parent product, or the product itself when it has no family). */
  familyId: string
  variants: ProductMetrics[]
}

export interface ProductsAnswer {
  scope: InsightScope & { period: InsightPeriod }
  tiles: {
    productsWithReviews: number
    families: number
    below4: number
    dropped: number
    topReturnReason: { reason: string; share: number; returns: number; product: { id: string; name: string } | null } | null
  }
  families: ProductFamilyRow[]
  total: { families: number; products: number }
  page: number
  pageSize: number
  generatedAt: string
}

// ── Facts ────────────────────────────────────────────────────────────

const scopeWhere = (scope: InsightScope): Prisma.ReviewWhereInput => ({
  ...(scope.channel ? { channel: scope.channel } : {}),
  ...(scope.market ? { marketplace: scope.market } : {}),
})

interface ReturnFacts {
  /** productId → return ids with a reason. */
  returns: Map<string, Set<string>>
  /** productId → reason → return ids. */
  reasons: Map<string, Map<string, Set<string>>>
  /** productId → order ids. */
  orders: Map<string, Set<string>>
  /** return id → its order id. */
  returnOrder: Map<string, string | null>
}

/** Returns with a reason and orders of the last 30 days, per product, in scope. */
async function readReturnFacts(productIds: string[], scope: InsightScope, now: Date): Promise<ReturnFacts> {
  const since = new Date(now.getTime() - RETURN_DAYS * DAY)
  const facts: ReturnFacts = { returns: new Map(), reasons: new Map(), orders: new Map(), returnOrder: new Map() }
  if (productIds.length === 0) return facts
  const channelWhere = scope.channel ? { channel: scope.channel as never } : {}
  const [returnItems, orderItems] = await Promise.all([
    prisma.returnItem.findMany({
      where: {
        productId: { in: productIds },
        return: { createdAt: { gte: since, lte: now }, reason: { not: null }, status: { not: 'REJECTED' }, ...(scope.channel ? { channel: scope.channel } : {}), ...(scope.market ? { marketplace: scope.market } : {}) },
      },
      select: { productId: true, returnId: true, return: { select: { reason: true, orderId: true } } },
    }),
    prisma.orderItem.findMany({
      where: {
        productId: { in: productIds },
        order: {
          ...channelWhere,
          ...(scope.market ? { marketplace: scope.market } : {}),
          status: { not: 'CANCELLED' },
          OR: [{ purchaseDate: { gte: since, lte: now } }, { purchaseDate: null, createdAt: { gte: since, lte: now } }],
        },
      },
      select: { productId: true, orderId: true },
    }),
  ])
  for (const item of returnItems) {
    const reason = reasonWords(item.return.reason)
    if (!item.productId || !reason) continue
    const set = facts.returns.get(item.productId) ?? new Set<string>()
    set.add(item.returnId)
    facts.returns.set(item.productId, set)
    const byReason = facts.reasons.get(item.productId) ?? new Map<string, Set<string>>()
    const ids = byReason.get(reason) ?? new Set<string>()
    ids.add(item.returnId)
    byReason.set(reason, ids)
    facts.reasons.set(item.productId, byReason)
    facts.returnOrder.set(item.returnId, item.return.orderId ?? null)
  }
  for (const item of orderItems) {
    if (!item.productId) continue
    const set = facts.orders.get(item.productId) ?? new Set<string>()
    set.add(item.orderId)
    facts.orders.set(item.productId, set)
  }
  return facts
}

/** The return rate of a set of products: returns with a reason over orders, each counted once. */
export function returnRateOf(ids: readonly string[], facts: ReturnFacts): ReturnRateCell | null {
  const returns = new Set<string>()
  const orders = new Set<string>()
  for (const id of ids) {
    for (const r of facts.returns.get(id) ?? []) returns.add(r)
    for (const o of facts.orders.get(id) ?? []) orders.add(o)
  }
  if (orders.size === 0 && returns.size === 0) return null
  return { rate: returnRate(returns.size, orders.size), returns: returns.size, orders: orders.size }
}

/** Return reasons of a set of products, most first. */
export function reasonsOf(ids: readonly string[], facts: ReturnFacts): Array<{ reason: string; count: number; share: number }> {
  const merged = new Map<string, Set<string>>()
  const all = new Set<string>()
  for (const id of ids) {
    for (const [reason, set] of facts.reasons.get(id) ?? []) {
      const into = merged.get(reason) ?? new Set<string>()
      for (const r of set) {
        into.add(r)
        all.add(r)
      }
      merged.set(reason, into)
    }
  }
  return [...merged.entries()]
    .map(([reason, set]) => ({ reason, count: set.size, share: pct(set.size, all.size, 0) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
}

// ── Metrics (pure) ───────────────────────────────────────────────────

const isComplaint = (r: ReviewFact) => r.sentiment?.label === 'NEGATIVE' || (r.rating != null && r.rating <= 2)

/** The complaint mentioned most (Other not counted): from the reviews, or with none, from Amazon's negative topics. */
export function topComplaint(rows: readonly ReviewFact[], topics: readonly ParsedTopic[]): ProductMetrics['topNegativeTheme'] {
  const counts = new Map<string, number>()
  for (const r of rows) {
    if (!isComplaint(r)) continue
    for (const c of new Set(r.sentiment?.categories ?? [])) if (c !== 'OTHER') counts.set(c, (counts.get(c) ?? 0) + 1)
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
  if (top) return { key: top[0], label: themeWords(top[0]), count: top[1], from: 'reviews' }
  const amazon = new Map<string, number>()
  for (const t of topics) if (t.polarity === 'negative' && t.theme !== 'OTHER') amazon.set(t.theme, (amazon.get(t.theme) ?? 0) + t.mentions)
  const topAmazon = [...amazon.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
  return topAmazon && topAmazon[1] > 0 ? { key: topAmazon[0], label: themeWords(topAmazon[0]), count: topAmazon[1], from: 'amazon_topic' } : null
}

/** The words a mixed rating is shown with. */
export function mixedRatingWords(rows: readonly ReviewFact[], amazonKnown: boolean): string {
  const channels = [...new Set(rows.map((r) => r.channel.toUpperCase()))]
  if (channels.length === 0) return amazonKnown ? ratingSourceWords('AMAZON', []) : 'No reviews in this period'
  if (channels.length === 1) return ratingSourceWords(channels[0], rows.map((r) => r.ingestSource))
  const amazon = rows.filter((r) => r.channel.toUpperCase() === 'AMAZON')
  return `stars from every channel${channels.includes('EBAY') ? '; eBay feedback counts as 5, 3 or 1 star' : ''}${amazon.length ? '; Amazon from imported reviews' : ''}`
}

export function metricsOf(input: {
  product: { id: string; name: string; sku: string; variant: string | null }
  now: readonly ReviewFact[]
  before: readonly ReviewFact[]
  spark: readonly ReviewFact[]
  topics: readonly ParsedTopic[]
  amazonKnown: boolean
  returnRate: ReturnRateCell | null
  alerts: ReadonlyArray<{ id: string; category: string; marketplace: string }>
  sparkNow: Date
}): ProductMetrics {
  const ratedNow = input.now.filter((r) => r.rating != null)
  const ratedBefore = input.before.filter((r) => r.rating != null)
  const tooFew = ratedNow.length < MIN_PRODUCT_RATINGS
  const avgNow = averageRating(ratedNow.map((r) => r.rating))
  const avgBefore = averageRating(ratedBefore.map((r) => r.rating))
  const spark = sparkValues('stars', input.spark, sparkWindows(input.sparkNow, 6, 7))
  const alert = input.alerts[0]
  return {
    productId: input.product.id,
    name: input.product.name,
    sku: input.product.sku,
    variant: input.product.variant,
    rating: tooFew || avgNow == null ? null : round(avgNow, 2),
    ratingWords: tooFew && ratedNow.length > 0 ? 'too few to rate' : mixedRatingWords(input.now, input.amazonKnown),
    count: input.now.length,
    change: !tooFew && ratedBefore.length >= MIN_PRODUCT_RATINGS ? delta(avgNow, avgBefore, 1) : null,
    spark: tooFew || spark.tooFew ? null : spark.values,
    tooFew,
    topNegativeTheme: topComplaint(input.now, input.topics),
    returnRate: input.returnRate,
    openAlert: alert ? { count: input.alerts.length, id: alert.id, theme: themeWords(alert.category), market: alert.marketplace } : null,
  }
}

/** Below 4 stars on at least one channel-and-market with enough rated reviews (eBay's "% positive" not counted). */
export function belowFourSomewhere(rows: readonly ReviewFact[]): boolean {
  const groups = new Map<string, number[]>()
  for (const r of rows) {
    if (r.rating == null || ratingKindOf(r.channel) !== 'stars') continue
    const key = `${r.channel}|${r.marketplace ?? ''}`
    groups.set(key, [...(groups.get(key) ?? []), r.rating])
  }
  return [...groups.values()].some((ratings) => ratings.length >= MIN_PRODUCT_RATINGS && (averageRating(ratings) ?? 5) < 4)
}

// ── The list ─────────────────────────────────────────────────────────

export interface ProductsInput {
  channel?: unknown
  market?: unknown
  marketplace?: unknown
  period?: unknown
  page?: unknown
  pageSize?: unknown
  q?: unknown
  theme?: unknown
  minRating?: unknown
  maxRating?: unknown
  openAlert?: unknown
  tile?: unknown
  family?: unknown
  sort?: unknown
  dir?: unknown
  now?: Date
}

const num = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const text = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

interface Gathered {
  scope: InsightScope
  period: InsightPeriod
  bounds: ReturnType<typeof insightBounds>
  now: Date
  rows: ReviewFact[]
  topics: ParsedTopic[]
  products: Map<string, ProductRow>
  returns: ReturnFacts
  alerts: Array<{ id: string; productId: string | null; category: string; marketplace: string; status: string }>
}

async function gather(input: { channel?: unknown; market?: unknown; marketplace?: unknown; period?: unknown; now?: Date }, only?: string[]): Promise<Gathered> {
  const now = input.now ?? new Date()
  const period = parseInsightPeriod(input.period)
  const scope = parseInsightScope(input)
  const bounds = insightBounds(period, now)
  const sparkFrom = new Date(now.getTime() - SPARK_DAYS * DAY)
  const readFrom = bounds.prevFrom < sparkFrom ? bounds.prevFrom : sparkFrom
  const markets = amazonTopicMarkets(scope)
  const [rows, insightRows] = await Promise.all([
    prisma.review.findMany({
      where: visibleReviewWhere({ ...scopeWhere(scope), productId: only ? { in: only } : { not: null }, postedAt: { gte: readFrom, lte: now } }),
      select: {
        id: true, productId: true, channel: true, marketplace: true, rating: true, postedAt: true, ingestSource: true,
        sentiment: { select: { label: true, categories: true } },
      },
    }),
    markets.length
      ? prisma.amazonReviewInsight.findMany({
          where: { accessStatus: 'OK', marketplace: { in: markets }, productId: only ? { in: only } : { not: null } },
          select: { marketplace: true, productId: true, fetchedAt: true, positiveTopics: true, negativeTopics: true },
        })
      : Promise.resolve([]),
  ])
  const topics = parseTopicRows(insightRows)
  const ids = new Set<string>([...rows.map((r) => r.productId!).filter(Boolean), ...topics.map((t) => t.productId!).filter(Boolean)])
  const found = ids.size
    ? await prisma.product.findMany({ where: { id: { in: [...ids] }, deletedAt: null }, select: { id: true, sku: true, name: true, parentId: true, isParent: true, variantAttributes: true } })
    : []
  const parentIds = [...new Set(found.map((p) => p.parentId).filter((id): id is string => !!id && !ids.has(id)))]
  const parents = parentIds.length
    ? await prisma.product.findMany({ where: { id: { in: parentIds } }, select: { id: true, sku: true, name: true, parentId: true, isParent: true, variantAttributes: true } })
    : []
  const products = new Map<string, ProductRow>([...found, ...parents].map((p) => [p.id, p]))
  const [returns, alerts] = await Promise.all([
    readReturnFacts([...ids], scope, now),
    ids.size
      ? prisma.reviewSpike.findMany({
          where: { productId: { in: [...ids] }, status: { in: ['OPEN', 'ACKNOWLEDGED'] }, ...(scope.market ? { marketplace: scope.market } : {}) },
          orderBy: { detectedAt: 'desc' },
          select: { id: true, productId: true, category: true, marketplace: true, status: true },
        })
      : Promise.resolve([]),
  ])
  return { scope, period, bounds, now, rows: rows as ReviewFact[], topics, products, returns, alerts }
}

const indexes = new WeakMap<Gathered, { rows: Map<string, ReviewFact[]>; topics: Map<string, ParsedTopic[]>; alerts: Map<string, Gathered['alerts']> }>()

/** Rows, topics and alerts per product, built once per read (a family takes the rows of all its products). */
function indexOf(g: Gathered) {
  let index = indexes.get(g)
  if (!index) {
    const group = <T>(items: readonly T[], key: (item: T) => string | null | undefined) => {
      const map = new Map<string, T[]>()
      for (const item of items) {
        const k = key(item)
        if (!k) continue
        const list = map.get(k)
        if (list) list.push(item)
        else map.set(k, [item])
      }
      return map
    }
    index = { rows: group(g.rows, (r) => r.productId), topics: group(g.topics, (t) => t.productId), alerts: group(g.alerts, (a) => a.productId) }
    indexes.set(g, index)
  }
  return index
}

function slices(g: Gathered, ids: readonly string[]) {
  const index = indexOf(g)
  const mine = ids.flatMap((id) => index.rows.get(id) ?? [])
  const sparkFrom = new Date(g.now.getTime() - SPARK_DAYS * DAY)
  return {
    now: mine.filter((r) => r.postedAt >= g.bounds.from),
    before: mine.filter((r) => r.postedAt >= g.bounds.prevFrom && r.postedAt < g.bounds.prevTo),
    spark: mine.filter((r) => r.postedAt >= sparkFrom),
    topics: ids.flatMap((id) => index.topics.get(id) ?? []),
    alerts: ids.flatMap((id) => index.alerts.get(id) ?? []),
  }
}

function measure(g: Gathered, product: { id: string; name: string; sku: string; variant: string | null }, ids: readonly string[]): ProductMetrics {
  const s = slices(g, ids)
  return metricsOf({
    product,
    now: s.now,
    before: s.before,
    spark: s.spark,
    topics: s.topics,
    amazonKnown: s.topics.length > 0,
    returnRate: returnRateOf(ids, g.returns),
    alerts: s.alerts,
    sparkNow: g.now,
  })
}

const SORTS = ['reviews', 'rating', 'change', 'returnRate', 'name'] as const
type ProductSort = (typeof SORTS)[number]

function sortValue(row: ProductMetrics, sort: ProductSort): number | string | null {
  if (sort === 'rating') return row.rating
  if (sort === 'change') return row.change
  if (sort === 'returnRate') return row.returnRate?.rate ?? null
  if (sort === 'name') return row.name.toLowerCase()
  return row.count
}

export async function insightsProducts(input: ProductsInput = {}): Promise<ProductsAnswer> {
  const g = await gather(input)
  // Families: a variant belongs to its parent; a product with no parent is its own family.
  const members = new Map<string, string[]>()
  const dataIds = new Set<string>([...g.rows.map((r) => r.productId!), ...g.topics.map((t) => t.productId!)].filter((id) => id && g.products.has(id)))
  for (const id of dataIds) {
    const p = g.products.get(id)!
    const familyId = p.parentId && g.products.has(p.parentId) ? p.parentId : p.id
    const list = members.get(familyId)
    if (list) list.push(id)
    else members.set(familyId, [id])
  }

  let families: ProductFamilyRow[] = [...members.entries()].map(([familyId, ids]) => {
    const head = g.products.get(familyId)!
    const variants = ids
      .filter((id) => id !== familyId)
      .map((id) => {
        const p = g.products.get(id)!
        return measure(g, { id: p.id, name: p.name, sku: p.sku, variant: variantWords(p.variantAttributes) }, [id])
      })
      .sort((a, b) => a.name.localeCompare(b.name))
    return { familyId, ...measure(g, { id: head.id, name: head.name, sku: head.sku, variant: null }, ids), variants }
  })

  // Tiles count products (a variant, or a product on its own), over every family before the filters.
  const leaves = families.flatMap((f) => (f.variants.length ? f.variants : [f]))
  const nowBy = indexOf(g).rows
  const below = new Set(leaves.filter((p) => belowFourSomewhere((nowBy.get(p.productId) ?? []).filter((r) => r.postedAt >= g.bounds.from))).map((p) => p.productId))
  const dropped = new Set(leaves.filter((p) => p.change != null && p.change <= DROP_AT).map((p) => p.productId))
  const allReasons = reasonsOf([...dataIds], g.returns)
  const topReason = allReasons[0] ?? null
  let topReasonProduct: { id: string; name: string } | null = null
  if (topReason) {
    let best = 0
    for (const f of families) {
      const n = reasonsOf(members.get(f.familyId) ?? [], g.returns).find((r) => r.reason === topReason.reason)?.count ?? 0
      if (n > best) {
        best = n
        topReasonProduct = { id: f.productId, name: f.name }
      }
    }
  }
  const allReturns = allReasons.reduce((n, r) => n + r.count, 0)

  // Filters (a family stays when it, or one of its variants, matches; only matching variants are listed).
  const q = text(input.q)?.toLowerCase() ?? null
  const theme = text(input.theme, 40)?.toUpperCase() ?? null
  const minRating = num(input.minRating)
  const maxRating = num(input.maxRating)
  const openAlert = input.openAlert === true || input.openAlert === '1' || input.openAlert === 'true'
  const tile = input.tile === 'below4' || input.tile === 'dropped' ? input.tile : null
  const familyFilter = text(input.family, 64)
  const matches = (row: ProductMetrics): boolean => {
    if (q && !`${row.name} ${row.sku} ${row.variant ?? ''}`.toLowerCase().includes(q)) return false
    if (theme && row.topNegativeTheme?.key !== theme) return false
    if (minRating != null && (row.rating == null || row.rating < minRating)) return false
    if (maxRating != null && (row.rating == null || row.rating > maxRating)) return false
    if (openAlert && !row.openAlert) return false
    if (tile === 'below4' && !below.has(row.productId)) return false
    if (tile === 'dropped' && !dropped.has(row.productId)) return false
    return true
  }
  const filtering = !!(q || theme || minRating != null || maxRating != null || openAlert || tile)
  if (familyFilter) families = families.filter((f) => f.familyId === familyFilter)
  if (filtering) {
    // A product on its own stays when it matches. A family stays with the variants that match; with none, it stays
    // whole when the family itself matches (its name, its rating), else it goes.
    families = families.flatMap((f) => {
      if (f.variants.length === 0) return matches(f) ? [f] : []
      const variants = f.variants.filter(matches)
      if (variants.length) return [{ ...f, variants }]
      return matches(f) ? [f] : []
    })
  }

  const sort: ProductSort = (SORTS as readonly string[]).includes(String(input.sort)) ? (input.sort as ProductSort) : 'reviews'
  const asc = input.dir === 'asc' || (input.dir !== 'desc' && (sort === 'name' || sort === 'rating'))
  families.sort((a, b) => {
    const va = sortValue(a, sort)
    const vb = sortValue(b, sort)
    if (va == null && vb == null) return a.name.localeCompare(b.name)
    if (va == null) return 1
    if (vb == null) return -1
    const diff = typeof va === 'string' ? va.localeCompare(vb as string) : (va as number) - (vb as number)
    return (asc ? diff : -diff) || a.name.localeCompare(b.name)
  })

  const pageSize = Math.min(Math.max(Math.trunc(num(input.pageSize) ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE)
  const page = Math.max(Math.trunc(num(input.page) ?? 1), 1)
  const products = families.reduce((n, f) => n + (f.variants.length || 1), 0)
  return {
    scope: { ...g.scope, period: g.period },
    tiles: {
      productsWithReviews: leaves.filter((p) => p.count > 0).length,
      families: members.size,
      below4: below.size,
      dropped: dropped.size,
      topReturnReason: topReason ? { reason: topReason.reason, share: pct(topReason.count, allReturns, 0) ?? 0, returns: topReason.count, product: topReasonProduct } : null,
    },
    families: families.slice((page - 1) * pageSize, page * pageSize),
    total: { families: families.length, products },
    page,
    pageSize,
    generatedAt: g.now.toISOString(),
  }
}

// ── The product pop-up ───────────────────────────────────────────────

export interface ProductMarketRating {
  channel: string
  market: string | null
  label: string
  kind: RatingKind
  /** Stars (two decimals) or % positive (eBay); null = no rating data (Amazon without imported reviews). */
  rating: number | null
  count: number
  change: number | null
  /** "stars from imported reviews", "seller feedback, % positive", "No rating data from Amazon — import reviews", "topics only". */
  words: string
}

export interface ProductDetailTheme {
  key: ThemeKey
  label: string
  mentions: number
  share: number | null
  starImpact: number | null
  starImpactFrom: 'reviews' | 'amazon_topic' | null
  quote: { text: string; english: string | null; from: string; source: 'amazon_topic' | 'review' } | null
}

export interface ProductDetailReview {
  id: string
  channel: string
  market: string | null
  where: string
  /** "imported from a file" for an imported review (Amazon gives no review text by API). */
  imported: boolean
  kind: 'stars' | 'feedback'
  rating: number | null
  text: string
  english: string | null
  language: string | null
  buyer: string | null
  postedAt: string
  themes: string[]
}

export interface ProductDetail {
  product: { id: string; name: string; sku: string; variant: string | null; family: { id: string; name: string } | null; isFamily: boolean; variants: number }
  scope: InsightScope & { period: InsightPeriod }
  summary: { rating: number | null; ratingWords: string; change: number | null; reviews: number; reviewsAllTime: number; soldOn: string[] }
  openAlerts: Array<{ id: string; theme: string; market: string; status: string }>
  markets: ProductMarketRating[]
  /** Stars per star, 5 first, in the period. */
  spread: [number, number, number, number, number]
  themes: ProductDetailTheme[]
  /** Fit per size: Phase 3 (ruling 3) — always null for now, never invented. */
  fit: null
  fitWords: string
  latest: ProductDetailReview[]
  returns: {
    windowDays: number
    rate: ReturnRateCell | null
    family: ReturnRateCell | null
    /** Returns whose order also has a review. */
    withReview: number
    topReason: { reason: string; share: number } | null
    reasons: Array<{ reason: string; count: number; share: number }>
  }
  topicsAt: string | null
  generatedAt: string
}

export class ProductNotFoundError extends Error {
  readonly statusCode = 404
}

export async function insightsProductDetail(productId: string, input: { channel?: unknown; market?: unknown; marketplace?: unknown; period?: unknown; now?: Date } = {}): Promise<ProductDetail> {
  const product = await prisma.product.findFirst({
    where: { id: productId, deletedAt: null },
    select: { id: true, sku: true, name: true, parentId: true, isParent: true, variantAttributes: true, children: { where: { deletedAt: null }, select: { id: true } } },
  })
  if (!product) throw new ProductNotFoundError('No product with this id in this business.')
  const childIds = product.children.map((c) => c.id)
  const ids = [product.id, ...childIds]
  const parent = product.parentId ? await prisma.product.findUnique({ where: { id: product.parentId }, select: { id: true, name: true, children: { where: { deletedAt: null }, select: { id: true } } } }) : null
  const familyIds = parent ? [parent.id, ...parent.children.map((c) => c.id)] : ids

  const g = await gather(input, [...new Set([...ids, ...familyIds])])
  const s = slices(g, ids)
  const scopeW = scopeWhere(g.scope)
  const [latestRows, allTime, listings, insightRows] = await Promise.all([
    prisma.review.findMany({
      where: visibleReviewWhere({ ...scopeW, productId: { in: ids } }),
      orderBy: [{ postedAt: 'desc' }, { id: 'desc' }],
      take: 3,
      select: {
        id: true, channel: true, marketplace: true, rating: true, body: true, bodyEnglish: true, language: true, authorName: true, postedAt: true, ingestSource: true,
        sentiment: { select: { categories: true } },
      },
    }),
    prisma.review.count({ where: visibleReviewWhere({ ...scopeW, productId: { in: ids } }) }),
    prisma.channelListing.findMany({ where: { productId: { in: ids }, listingStatus: 'ACTIVE' }, select: { channel: true, marketplace: true }, distinct: ['channel', 'marketplace'] }),
    prisma.amazonReviewInsight.findMany({ where: { productId: { in: ids } }, select: { marketplace: true, accessStatus: true, fetchedAt: true } }),
  ])

  // Rating per channel and market: every place with reviews, and every Amazon market it sells on or has topics for.
  const groups = new Map<string, { channel: string; market: string | null; now: ReviewFact[]; before: ReviewFact[] }>()
  const key = (channel: string, market: string | null) => `${channel.toUpperCase()}|${(market ?? '').toUpperCase()}`
  const put = (r: ReviewFact, side: 'now' | 'before') => {
    const k = key(r.channel, r.marketplace)
    const slot = groups.get(k) ?? { channel: r.channel.toUpperCase(), market: r.marketplace?.toUpperCase() ?? null, now: [], before: [] }
    slot[side].push(r)
    groups.set(k, slot)
  }
  for (const r of s.now) put(r, 'now')
  for (const r of s.before) put(r, 'before')
  const listingMarket = (m: string | null) => (m && m.toUpperCase() !== 'DEFAULT' ? m.toUpperCase() : null)
  const amazonMarkets = new Set<string>([
    ...listings.filter((l) => l.channel.toUpperCase() === 'AMAZON' && listingMarket(l.marketplace)).map((l) => listingMarket(l.marketplace)!),
    ...insightRows.map((r) => r.marketplace.toUpperCase()),
  ])
  for (const m of amazonMarkets) {
    if (g.scope.channel && g.scope.channel !== 'AMAZON') continue
    if (g.scope.market && g.scope.market !== m) continue
    if (!groups.has(key('AMAZON', m))) groups.set(key('AMAZON', m), { channel: 'AMAZON', market: m, now: [], before: [] })
  }
  const topicMarkets = new Set(insightRows.filter((r) => r.accessStatus === 'OK').map((r) => r.marketplace.toUpperCase()))
  const markets: ProductMarketRating[] = [...groups.values()].map((grp) => {
    const kind = ratingKindOf(grp.channel)
    const nowRatings = grp.now.map((r) => r.rating)
    const rated = nowRatings.filter((r) => r != null).length
    const rating = rated > 0 ? ratingIn(kind, nowRatings) : null
    const before = grp.before.filter((r) => r.rating != null).length > 0 ? ratingIn(kind, grp.before.map((r) => r.rating)) : null
    let words = ratingSourceWords(grp.channel, grp.now.map((r) => r.ingestSource))
    if (grp.channel === 'AMAZON' && grp.now.length === 0) words = topicMarkets.has(grp.market ?? '') ? 'topics only — No rating data from Amazon; import reviews' : 'No rating data from Amazon — import reviews'
    return {
      channel: grp.channel,
      market: grp.market,
      label: whereWords(grp.channel, grp.market),
      kind,
      rating,
      count: grp.now.length,
      change: rating != null && before != null ? delta(rating, before, 1) : null,
      words,
    }
  }).sort((a, b) => a.channel.localeCompare(b.channel) || b.count - a.count || (a.market ?? '').localeCompare(b.market ?? ''))

  // Themes of this product: its reviews' themes and its Amazon topics, with star impact against its own average.
  const overall = averageRating(s.now.map((r) => r.rating))
  const reviewQuotes = await prisma.review.findMany({
    where: visibleReviewWhere({ ...scopeW, productId: { in: ids }, postedAt: { gte: g.bounds.from, lte: g.now } }),
    orderBy: { postedAt: 'desc' },
    take: 200,
    select: { id: true, channel: true, marketplace: true, body: true, bodyEnglish: true, language: true, ingestSource: true, sentiment: { select: { categories: true, topPhrases: true } } },
  })
  const themes: ProductDetailTheme[] = []
  for (const k of THEME_KEYS) {
    const mentioning = s.now.filter((r) => r.sentiment?.categories.includes(k))
    const amazon = s.topics.filter((t) => t.theme === k)
    const mentions = mentioning.length + amazon.reduce((n, t) => n + t.mentions, 0)
    if (mentions === 0) continue
    const reviewImpact = mentions >= MIN_THEME_MENTIONS ? themeStarImpact(mentioning.map((r) => r.rating), overall) : null
    const amazonWeight = amazon.reduce((n, t) => n + (t.starEffect != null ? t.mentions : 0), 0)
    const amazonImpact = mentions >= MIN_THEME_MENTIONS && amazonWeight > 0 ? round(amazon.reduce((n, t) => n + (t.starEffect ?? 0) * (t.starEffect != null ? t.mentions : 0), 0) / amazonWeight, 2) : null
    const quoteRow = reviewQuotes.find((r) => r.sentiment?.categories.includes(k))
    const topTopic = [...amazon].filter((t) => t.snippets.length).sort((a, b) => b.mentions - a.mentions)[0]
    let quote: ProductDetailTheme['quote'] = null
    if (quoteRow) {
      const english = quoteRow.language && quoteRow.language.toLowerCase() !== 'en' ? clip(quoteRow.bodyEnglish, 90) : null
      const t = english ? clip(quoteRow.body, 90) : clip(quoteRow.sentiment?.topPhrases[0] ?? quoteRow.body, 90)
      if (t) quote = { text: t, english, from: snippetFrom('review', quoteRow.channel, quoteRow.marketplace, quoteRow.ingestSource), source: 'review' }
    } else if (topTopic) {
      quote = { text: clip(topTopic.snippets[0], 90)!, english: null, from: snippetFrom('amazon_topic', 'AMAZON', topTopic.market), source: 'amazon_topic' }
    }
    themes.push({
      key: k,
      label: themeWords(k),
      mentions,
      share: s.now.length > 0 ? pct(mentioning.length, s.now.length, 0) : null,
      starImpact: reviewImpact ?? amazonImpact,
      starImpactFrom: reviewImpact != null ? 'reviews' : amazonImpact != null ? 'amazon_topic' : null,
      quote,
    })
  }
  themes.sort((a, b) => b.mentions - a.mentions || a.label.localeCompare(b.label))

  const reasons = reasonsOf(ids, g.returns)
  const returnIds = new Set(ids.flatMap((id) => [...(g.returns.returns.get(id) ?? [])]))
  const returnOrders = [...returnIds].map((r) => g.returns.returnOrder.get(r)).filter((o): o is string => !!o)
  const withReview = returnOrders.length
    ? await prisma.review.count({ where: visibleReviewWhere({ orderId: { in: [...new Set(returnOrders)] } }) })
    : 0
  const totalReturns = reasons.reduce((n, r) => n + r.count, 0)
  const head = metricsOf({
    product: { id: product.id, name: product.name, sku: product.sku, variant: variantWords(product.variantAttributes) },
    now: s.now,
    before: s.before,
    spark: s.spark,
    topics: s.topics,
    amazonKnown: s.topics.length > 0,
    returnRate: null,
    alerts: s.alerts,
    sparkNow: g.now,
  })
  const topicsAt = insightRows.filter((r) => r.accessStatus === 'OK').reduce<Date | null>((acc, r) => (!acc || r.fetchedAt > acc ? r.fetchedAt : acc), null)

  return {
    product: {
      id: product.id,
      name: product.name,
      sku: product.sku,
      variant: variantWords(product.variantAttributes),
      family: parent ? { id: parent.id, name: parent.name } : null,
      isFamily: childIds.length > 0,
      variants: childIds.length,
    },
    scope: { ...g.scope, period: g.period },
    summary: {
      rating: head.rating,
      ratingWords: head.ratingWords,
      change: head.change,
      reviews: s.now.length,
      reviewsAllTime: allTime,
      soldOn: [...new Set(listings.map((l) => whereWords(l.channel, listingMarket(l.marketplace))))].sort(),
    },
    openAlerts: s.alerts.map((a) => ({ id: a.id, theme: themeWords(a.category), market: a.marketplace, status: a.status })),
    markets,
    spread: starCounts(s.now.map((r) => r.rating)),
    themes,
    fit: null,
    fitWords: 'Fit per size comes later: it needs fit mentions and size returns per family and size.',
    latest: latestRows.map((r) => ({
      id: r.id,
      channel: r.channel,
      market: r.marketplace,
      where: whereWords(r.channel, r.marketplace),
      imported: (r.ingestSource ?? '').toUpperCase().startsWith('IMPORT'),
      kind: ratingKindOf(r.channel) === 'positive' ? 'feedback' : 'stars',
      rating: r.rating,
      text: r.body,
      english: r.language && r.language.toLowerCase() !== 'en' ? r.bodyEnglish : null,
      language: r.language,
      buyer: buyerShort(r.authorName),
      postedAt: r.postedAt.toISOString(),
      themes: (r.sentiment?.categories ?? []).map(themeWords),
    })),
    returns: {
      windowDays: RETURN_DAYS,
      rate: returnRateOf(ids, g.returns),
      family: parent || childIds.length ? returnRateOf(familyIds, g.returns) : null,
      withReview,
      topReason: reasons[0] ? { reason: reasons[0].reason, share: pct(reasons[0].count, totalReturns, 0) ?? 0 } : null,
      reasons,
    },
    topicsAt: topicsAt?.toISOString() ?? null,
    generatedAt: g.now.toISOString(),
  }
}
