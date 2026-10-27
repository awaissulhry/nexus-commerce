/**
 * RX.4 — AI Review Spotlight (Voice-of-Customer brief). Reviews Insights › Brief (2026-10-26, PR E).
 *
 * Synthesizes a window of reviews into an actionable brief: sentiment
 * mix, the top complaint + praise themes (with sample quotes), emerging
 * issues, and concrete recommendations (fix the sizing chart, clarify a
 * bullet, etc.). Persisted to ReviewSpotlight so the page reads a cached
 * brief instead of burning AI tokens on every load.
 *
 * Degrades to a heuristic brief (built from sentiment categories + top
 * phrases) when ANTHROPIC_API_KEY is absent or the call fails — so a
 * useful brief is always produced.
 *
 * PR E adds: the scope (`channel`, `marketplace`: every channel, one channel, or one market of it), numbered findings
 * with a trend and their evidence, a before / now table, what the brief was made from, the history of earlier briefs,
 * the "Brief for" options (each says whether a brief exists), and the rules the page holds the button with: at least
 * 20 reviews and Amazon topic mentions in the period, and 10 briefs a day per business. Amazon = topics only: the
 * brief never sees Amazon review text from Amazon — only Amazon's English topics, and reviews a person imported.
 */

import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { notAutomaticWhere, visibleReviewWhere } from './review-visibility.js'
import { countsAsStars } from './review-rating.js'
import { isImportedSource } from './review-inbox-query.js'
import { averageRating, channelWords, marketWords, round } from './overviewMath.js'
import { amazonTopicMarkets, parseInsightScope, parseTopicRows, pct, THEME_KEYS, type InsightScope, type ParsedTopic } from './review-insights-math.js'

const ENDPOINT = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const MODEL = process.env.NEXUS_REVIEW_SPOTLIGHT_MODEL ?? 'claude-haiku-4-5-20251001'

const CATEGORY_LABEL: Record<string, string> = {
  FIT_SIZING: 'Fit / Sizing',
  DURABILITY: 'Durability',
  SHIPPING: 'Shipping',
  VALUE: 'Value',
  DESIGN: 'Design',
  QUALITY: 'Quality',
  SAFETY: 'Safety',
  COMFORT: 'Comfort',
  OTHER: 'Other',
}

const RECO_BY_CATEGORY: Record<string, { title: string; detail: string; area: string }> = {
  FIT_SIZING: {
    title: 'Clarify sizing',
    detail: 'Add or refine the size chart and call out fit (runs small/large) in the bullets and A+ content.',
    area: 'listing',
  },
  DURABILITY: {
    title: 'Address durability concerns',
    detail: 'Investigate the failing component with QA; consider a materials note and warranty messaging.',
    area: 'product',
  },
  SHIPPING: {
    title: 'Review packaging / carrier',
    detail: 'Shipping complaints recurring — check packaging robustness and carrier performance for the affected market.',
    area: 'ops',
  },
  QUALITY: {
    title: 'QA the build quality',
    detail: 'Pull the flagged units, check the supplier batch, and tighten incoming inspection.',
    area: 'product',
  },
  SAFETY: {
    title: 'Escalate safety signal',
    detail: 'Safety-related comments — review against GPSR/recall criteria for helmets and protective gear immediately.',
    area: 'product',
  },
  COMFORT: {
    title: 'Improve comfort messaging',
    detail: 'Set comfort expectations (break-in period, padding) in the listing and consider design tweaks.',
    area: 'content',
  },
  DESIGN: {
    title: 'Capture design feedback',
    detail: 'Feed recurring design notes to product development for the next revision.',
    area: 'product',
  },
  VALUE: {
    title: 'Reframe value',
    detail: 'Reinforce value (quality, certifications, included accessories) in bullets to justify price.',
    area: 'listing',
  },
}

export interface SpotlightFinding {
  /** 1, 2, 3 … in the order the brief tells them. */
  n: number
  /** The theme it is about (FIT_SIZING …), when it is about one. */
  theme: string | null
  title: string
  trend: 'worse' | 'new' | 'steady' | 'better'
  text: string
  /** What backs it, for the page to link: reviews of the theme, an open alert, open fixes. */
  evidence: Array<{ kind: 'reviews'; theme: string; count: number } | { kind: 'alert'; id: string; market: string } | { kind: 'fixes'; theme: string; count: number } | { kind: 'theme'; theme: string; mentions: number }>
}

export interface SpotlightChange {
  key: 'avgRating' | 'negativeShare' | 'topComplaint' | 'replied' | 'reviews'
  what: string
  before: number | null
  now: number | null
  /** now − before; null when either is unknown. */
  change: number | null
  /** Whether a rise is good news (for the colour). */
  higherIsBetter: boolean
  unit: 'stars' | 'percent' | 'count'
}

export interface SpotlightContent {
  sentiment: { positive: number; neutral: number; negative: number; total: number; avgRating: number | null }
  complaints: { theme: string; count: number; severity: 'high' | 'medium' | 'low'; quotes: string[] }[]
  praises: { theme: string; count: number; quotes: string[] }[]
  emerging: { theme: string; note: string }[]
  recommendations: { title: string; detail: string; area: string; sku?: string }[]
  /** PR E — numbered findings with a trend and their evidence. */
  findings?: SpotlightFinding[]
  /** PR E — the window against the one before it. */
  changes?: SpotlightChange[]
  /** PR E — what the brief was made from. */
  sources?: { reviews: number; amazonTopics: number; amazonTopicsAt: string | null; amazonReviewText: false }
}

export interface SpotlightOptions {
  productId?: string | null
  /** PR E — 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'ETSY', or null for every channel. */
  channel?: string | null
  marketplace?: string | null
  windowDays?: number
  now?: Date
}

/** A brief needs this many reviews and Amazon topic mentions in its window. */
export const BRIEF_MIN_REVIEWS = 20
/** Briefs a business may make a day (UTC day). */
export const BRIEF_DAILY_LIMIT = 10
const DAY = 86_400_000

export class SpotlightHeldError extends Error {
  constructor(message: string, readonly statusCode: 409 | 429, readonly reason: 'too_few' | 'daily_limit') {
    super(message)
  }
}

/** The brief's scope from a request: a known channel or none, a market code or none. */
export function spotlightScope(raw: { channel?: unknown; marketplace?: unknown; market?: unknown }): InsightScope {
  return parseInsightScope(raw)
}

/** "All channels and markets", "Amazon — all markets", "Amazon Germany", "Shopify". */
export function scopeLabel(scope: { channel: string | null; market: string | null }): string {
  if (!scope.channel) return scope.market ? `Every channel in ${marketWords(scope.market) ?? scope.market}` : 'All channels and markets'
  if (scope.market) return `${channelWords(scope.channel)} ${marketWords(scope.market) ?? scope.market}`
  return scope.channel === 'AMAZON' || scope.channel === 'EBAY' ? `${channelWords(scope.channel)} — all markets` : channelWords(scope.channel)
}

/** Amazon review text the brief may read: only reviews a person imported (Amazon gives no review text by API). */
export function mayReadText(row: { channel: string; ingestSource: string | null }): boolean {
  return row.channel.toUpperCase() !== 'AMAZON' || isImportedSource(row.ingestSource)
}

// eBay's automatic feedback is eBay's text, not the buyer's voice: never in a brief (live audit B10).
const scopeWhere = (opts: SpotlightOptions): Prisma.ReviewWhereInput => ({
  ...(opts.productId ? { productId: opts.productId } : {}),
  ...(opts.channel ? { channel: opts.channel } : {}),
  ...(opts.marketplace ? { marketplace: opts.marketplace } : {}),
  AND: [notAutomaticWhere()],
})

async function gather(opts: SpotlightOptions) {
  const windowDays = opts.windowDays ?? 30
  const now = opts.now ?? new Date()
  const since = new Date(now.getTime() - windowDays * DAY)
  const before = new Date(since.getTime() - windowDays * DAY)
  const counted = { channel: true, ingestSource: true, kind: true, rating: true, triageStatus: true, sentiment: { select: { label: true, categories: true } } } as const
  const markets = amazonTopicMarkets({ channel: opts.channel ?? null, market: opts.marketplace ?? null })
  const inWindow = visibleReviewWhere({ ...scopeWhere(opts), postedAt: { gte: since, lte: now } })
  const [all, prev, textRows, topicRows] = await Promise.all([
    // Every review of the window and the one before, for the counts and the before / now table (no text).
    prisma.review.findMany({ where: inWindow, select: counted }),
    prisma.review.findMany({ where: visibleReviewWhere({ ...scopeWhere(opts), postedAt: { gte: before, lt: since } }), select: counted }),
    // The newest reviews with their text, for the AI and the quotes.
    prisma.review.findMany({
      where: inWindow,
      orderBy: { postedAt: 'desc' },
      take: 300,
      select: {
        id: true, channel: true, marketplace: true, rating: true, body: true, ingestSource: true, kind: true, postedAt: true,
        sentiment: { select: { label: true, categories: true, topPhrases: true } },
        product: { select: { sku: true, name: true } },
      },
    }),
    markets.length
      ? prisma.amazonReviewInsight.findMany({
          where: { accessStatus: 'OK', marketplace: { in: markets }, ...(opts.productId ? { productId: opts.productId } : {}) },
          select: { marketplace: true, productId: true, fetchedAt: true, positiveTopics: true, negativeTopics: true },
        })
      : Promise.resolve([]),
  ])
  const topics = parseTopicRows(topicRows)
  const topicsAt = topicRows.reduce<Date | null>((acc, r) => (!acc || r.fetchedAt > acc ? r.fetchedAt : acc), null)
  // Amazon = topics only: review text from Amazon never reaches the brief, only what a person imported.
  const reviews = textRows.filter(mayReadText).slice(0, 150)
  return { windowDays, now, all, reviews, prev, topics, topicsAt }
}

type Gathered = Awaited<ReturnType<typeof gather>>

function heuristicBrief(reviews: Gathered['reviews']): SpotlightContent {
  const counts = { positive: 0, neutral: 0, negative: 0 }
  const negCat: Record<string, { count: number; quotes: Set<string> }> = {}
  const posCat: Record<string, { count: number; quotes: Set<string> }> = {}
  let ratingSum = 0
  let ratingN = 0
  for (const r of reviews) {
    // Stars of product reviews only: eBay feedback is never stars (review-rating.ts).
    if (r.rating != null && countsAsStars({ channel: r.channel, kind: r.kind, ingestSource: r.ingestSource })) {
      ratingSum += r.rating
      ratingN += 1
    }
    const s = r.sentiment
    if (!s) continue
    if (s.label === 'POSITIVE') counts.positive += 1
    else if (s.label === 'NEGATIVE') counts.negative += 1
    else counts.neutral += 1
    const bucket = s.label === 'NEGATIVE' ? negCat : s.label === 'POSITIVE' ? posCat : null
    if (bucket) {
      for (const c of s.categories) {
        const e = (bucket[c] ??= { count: 0, quotes: new Set() })
        e.count += 1
        for (const p of s.topPhrases.slice(0, 1)) if (e.quotes.size < 3) e.quotes.add(p)
      }
    }
  }
  const toList = (m: typeof negCat) =>
    Object.entries(m)
      .map(([cat, v]) => ({ cat, count: v.count, quotes: Array.from(v.quotes) }))
      .sort((a, b) => b.count - a.count)
  const complaints = toList(negCat)
    .slice(0, 5)
    .map((c) => ({
      theme: CATEGORY_LABEL[c.cat] ?? c.cat,
      count: c.count,
      severity: (c.count >= 5 ? 'high' : c.count >= 2 ? 'medium' : 'low') as 'high' | 'medium' | 'low',
      quotes: c.quotes,
    }))
  const praises = toList(posCat)
    .slice(0, 5)
    .map((c) => ({ theme: CATEGORY_LABEL[c.cat] ?? c.cat, count: c.count, quotes: c.quotes }))
  const recommendations = toList(negCat)
    .slice(0, 4)
    .map((c) => {
      const reco = RECO_BY_CATEGORY[c.cat]
      return reco
        ? { title: reco.title, detail: reco.detail, area: reco.area }
        : { title: `Address ${CATEGORY_LABEL[c.cat] ?? c.cat}`, detail: 'Recurring complaint theme — investigate.', area: 'product' }
    })
  return {
    sentiment: {
      positive: counts.positive,
      neutral: counts.neutral,
      negative: counts.negative,
      total: counts.positive + counts.neutral + counts.negative,
      avgRating: ratingN > 0 ? ratingSum / ratingN : null,
    },
    complaints,
    praises,
    emerging: [],
    recommendations,
  }
}

// ── Findings and the before / now table (pure) ──────────────────────

type CountRow = { channel?: string; kind?: string | null; ingestSource?: string | null; rating: number | null; triageStatus: string | null; sentiment: { label: string; categories: string[] } | null }

const has = (r: CountRow, label: string, theme: string) => r.sentiment?.label === label && r.sentiment.categories.includes(theme)

/** Amazon topic mentions, every topic counted. */
export function topicMentions(topics: readonly ParsedTopic[]): number {
  return topics.reduce((n, t) => n + t.mentions, 0)
}

/** The window against the one before it: average stars, negative share, the top complaint, replies, reviews. */
export function briefChanges(now: readonly CountRow[], before: readonly CountRow[]): SpotlightChange[] {
  const avg = (rows: readonly CountRow[]) => {
    // Stars of product reviews only (review-rating.ts): eBay feedback is never stars, Amazon's 1–3 star seller feedback
    // never averaged, Amazon stars only from imported reviews.
    const a = averageRating(rows.filter((r) => countsAsStars({ channel: r.channel ?? '', kind: r.kind, ingestSource: r.ingestSource ?? null })).map((r) => r.rating))
    return a == null ? null : round(a, 2)
  }
  const negative = (rows: readonly CountRow[]) => {
    const rated = rows.filter((r) => r.rating != null)
    return pct(rated.filter((r) => (r.rating as number) <= 2).length, rated.length)
  }
  const replied = (rows: readonly CountRow[]) => pct(rows.filter((r) => r.triageStatus === 'RESPONDED').length, rows.length)
  const complaints = new Map<string, number>()
  for (const r of now) if (r.sentiment?.label === 'NEGATIVE') for (const c of r.sentiment.categories) if (c !== 'OTHER') complaints.set(c, (complaints.get(c) ?? 0) + 1)
  const top = [...complaints.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null
  const diff = (a: number | null, b: number | null, digits = 1) => (a == null || b == null ? null : round(a - b, digits))
  const rows: SpotlightChange[] = [
    { key: 'avgRating', what: 'Average rating', before: avg(before), now: avg(now), change: diff(avg(now), avg(before), 2), higherIsBetter: true, unit: 'stars' },
    { key: 'negativeShare', what: 'Share of negative reviews', before: negative(before), now: negative(now), change: diff(negative(now), negative(before)), higherIsBetter: false, unit: 'percent' },
  ]
  if (top) {
    const count = (rs: readonly CountRow[]) => rs.filter((r) => has(r, 'NEGATIVE', top)).length
    rows.push({ key: 'topComplaint', what: `${CATEGORY_LABEL[top] ?? top} complaints`, before: count(before), now: count(now), change: count(now) - count(before), higherIsBetter: false, unit: 'count' })
  }
  rows.push({ key: 'replied', what: 'Reviews that got a reply', before: replied(before), now: replied(now), change: diff(replied(now), replied(before)), higherIsBetter: true, unit: 'percent' })
  rows.push({ key: 'reviews', what: 'Reviews and feedback', before: before.length, now: now.length, change: now.length - before.length, higherIsBetter: true, unit: 'count' })
  return rows
}

export interface BriefEvidence {
  alerts: ReadonlyArray<{ id: string; category: string; marketplace: string }>
  fixes: ReadonlyMap<string, number>
}

function evidenceFor(theme: string, count: number, ev: BriefEvidence, topicCount: number): SpotlightFinding['evidence'] {
  const out: SpotlightFinding['evidence'] = []
  if (count > 0) out.push({ kind: 'reviews', theme, count })
  if (topicCount > 0) out.push({ kind: 'theme', theme, mentions: topicCount })
  for (const a of ev.alerts.filter((a) => a.category === theme).slice(0, 2)) out.push({ kind: 'alert', id: a.id, market: a.marketplace })
  const fixes = ev.fixes.get(theme) ?? 0
  if (fixes > 0) out.push({ kind: 'fixes', theme, count: fixes })
  return out
}

/** Up to 4 complaints (growing, new, steady or fading) and the strongest praise, each with its evidence. */
export function briefFindings(input: { now: readonly CountRow[]; before: readonly CountRow[]; topics: readonly ParsedTopic[]; windowDays: number }, ev: BriefEvidence): SpotlightFinding[] {
  const { now, before, topics, windowDays } = input
  const found: SpotlightFinding[] = []
  const complaints = THEME_KEYS.filter((k) => k !== 'OTHER')
    .map((k) => {
      const n = now.filter((r) => has(r, 'NEGATIVE', k)).length
      const b = before.filter((r) => has(r, 'NEGATIVE', k)).length
      const amazon = topics.filter((t) => t.theme === k && t.polarity === 'negative').reduce((x, t) => x + t.mentions, 0)
      return { k, n, b, amazon }
    })
    .filter((c) => c.n + c.amazon > 0)
    .sort((a, b) => b.n + b.amazon - (a.n + a.amazon) || a.k.localeCompare(b.k))
    .slice(0, 4)
  for (const c of complaints) {
    const label = CATEGORY_LABEL[c.k] ?? c.k
    const shareNow = pct(c.n, now.length) ?? 0
    const shareBefore = pct(c.b, before.length)
    const moved = shareBefore == null ? null : round(shareNow - shareBefore, 1)
    const trend: SpotlightFinding['trend'] = c.b === 0 && c.n > 0 ? 'new' : moved != null && moved >= 2 ? 'worse' : moved != null && moved <= -2 ? 'better' : 'steady'
    const title = trend === 'new' ? `${label}: a new complaint` : trend === 'worse' ? `${label} complaints are growing` : trend === 'better' ? `${label} complaints are fading` : `${label} complaints hold steady`
    const parts = [
      c.n > 0 ? `${c.n} of ${now.length} reviews complain about ${label.toLowerCase()} (${shareNow}%)` : `No review complains about ${label.toLowerCase()}`,
      moved != null && c.n > 0 ? `, ${moved >= 0 ? 'up' : 'down'} ${Math.abs(moved)} points against the ${windowDays} days before.` : '.',
      c.amazon > 0 ? ` Amazon’s topics add ${c.amazon} mentions.` : '',
    ]
    found.push({ n: 0, theme: c.k, title, trend, text: parts.join(''), evidence: evidenceFor(c.k, c.n, ev, c.amazon) })
  }
  const praise = THEME_KEYS.filter((k) => k !== 'OTHER')
    .map((k) => ({ k, n: now.filter((r) => has(r, 'POSITIVE', k)).length + topics.filter((t) => t.theme === k && t.polarity === 'positive').reduce((x, t) => x + t.mentions, 0) }))
    .filter((p) => p.n > 0)
    .sort((a, b) => b.n - a.n || a.k.localeCompare(b.k))[0]
  if (praise) {
    const label = CATEGORY_LABEL[praise.k] ?? praise.k
    found.push({ n: 0, theme: praise.k, title: `${label} is why people buy`, trend: 'steady', text: `${praise.n} reviews and topic mentions praise ${label.toLowerCase()}: the strongest reason to put first in the bullets.`, evidence: [{ kind: 'theme', theme: praise.k, mentions: praise.n }] })
  }
  return found.map((f, i) => ({ ...f, n: i + 1 }))
}

function stripJson(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
}

async function aiBrief(
  g: Gathered,
  fallback: SpotlightContent,
  ev: BriefEvidence,
): Promise<{ content: SpotlightContent; usedAi: boolean }> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey || (g.reviews.length === 0 && g.topics.length === 0)) return { content: fallback, usedAi: false }

  const compact = g.reviews
    .slice(0, 120)
    .map((r) => {
      const label = r.sentiment?.label ?? 'NEUTRAL'
      const star = r.rating != null ? `${r.rating}★` : '—'
      const themes = r.sentiment?.categories.length ? ` {${r.sentiment.categories.join(',')}}` : ''
      return `[${star} ${label}${themes}] ${r.body.replace(/\s+/g, ' ').slice(0, 220)}`
    })
    .join('\n')
  const topicLines = g.topics
    .slice(0, 60)
    .map((t) => `[Amazon ${t.market} ${t.polarity} {${t.theme}}] ${t.topic} — ${t.mentions} mentions${t.starEffect != null ? `, star effect ${t.starEffect}` : ''}`)
    .join('\n')

  const system =
    `You are a senior e-commerce CX analyst. Synthesize customer reviews into a JSON "Voice of the Customer" brief. ` +
    `Output ONLY valid JSON (no prose, no markdown) matching exactly this TypeScript type:\n` +
    `{ "complaints": {"theme": string, "count": number, "severity": "high"|"medium"|"low", "quotes": string[]}[],` +
    ` "praises": {"theme": string, "count": number, "quotes": string[]}[],` +
    ` "emerging": {"theme": string, "note": string}[],` +
    ` "recommendations": {"title": string, "detail": string, "area": "listing"|"product"|"ops"|"content"}[],` +
    ` "findings": {"theme": ${JSON.stringify(THEME_KEYS.join('|'))} | null, "title": string, "trend": "worse"|"new"|"steady"|"better", "text": string}[] }\n` +
    `Rules: ≤5 complaints, ≤5 praises, ≤3 emerging, ≤5 recommendations, 3 to 5 findings in plain English (each title ≤ 8 words, text ≤ 45 words, with the numbers that back it). ` +
    `Quotes are short verbatim snippets from the reviews (≤12 words), max 3 per theme. Recommendations must be concrete and actionable for the seller. ` +
    `Amazon lines are Amazon's own topic summaries (no review text): use their mentions, never invent quotes for them. Be specific to what customers actually said.`

  const userText = `Reviews (most recent first):\n${compact || '(none)'}\n\nAmazon topics:\n${topicLines || '(none)'}\n\nProduce the JSON brief now.`

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        temperature: 0.3,
        system,
        messages: [{ role: 'user', content: userText }],
      }),
    })
    if (!res.ok) throw new Error(`anthropic HTTP ${res.status}`)
    const json = (await res.json()) as { content?: { type: string; text?: string }[] }
    const text = (json.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
    const parsed = JSON.parse(stripJson(text)) as Partial<SpotlightContent> & { findings?: Array<{ theme?: unknown; title?: unknown; trend?: unknown; text?: unknown }> }
    const trends = ['worse', 'new', 'steady', 'better']
    const aiFindings = Array.isArray(parsed.findings)
      ? parsed.findings
          .filter((f) => typeof f?.title === 'string' && typeof f?.text === 'string')
          .slice(0, 5)
          .map((f, i): SpotlightFinding => {
            const theme = typeof f.theme === 'string' && (THEME_KEYS as readonly string[]).includes(f.theme) ? f.theme : null
            const count = theme ? g.all.filter((r) => r.sentiment?.categories.includes(theme)).length : 0
            const topicCount = theme ? g.topics.filter((t) => t.theme === theme).reduce((n, t) => n + t.mentions, 0) : 0
            return {
              n: i + 1,
              theme,
              title: String(f.title).slice(0, 120),
              trend: (trends.includes(String(f.trend)) ? f.trend : 'steady') as SpotlightFinding['trend'],
              text: String(f.text).slice(0, 600),
              evidence: theme ? evidenceFor(theme, count, ev, topicCount) : [],
            }
          })
      : []
    return {
      content: {
        sentiment: fallback.sentiment, // counts are deterministic — keep ours
        complaints: parsed.complaints ?? fallback.complaints,
        praises: parsed.praises ?? fallback.praises,
        emerging: parsed.emerging ?? [],
        recommendations: parsed.recommendations ?? fallback.recommendations,
        findings: aiFindings.length ? aiFindings : fallback.findings,
      },
      usedAi: true,
    }
  } catch (err) {
    logger.warn('[review-spotlight] AI brief failed, using heuristic', {
      error: err instanceof Error ? err.message : String(err),
    })
    return { content: fallback, usedAi: false }
  }
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/** How many briefs this business made today (UTC), and how many it may still make. */
export async function briefLimit(now = new Date()): Promise<{ perDay: number; usedToday: number; left: number }> {
  const usedToday = await prisma.reviewSpotlight.count({ where: { generatedAt: { gte: startOfUtcDay(now) } } })
  return { perDay: BRIEF_DAILY_LIMIT, usedToday, left: Math.max(0, BRIEF_DAILY_LIMIT - usedToday) }
}

/**
 * Write a brief for a scope. Held (SpotlightHeldError, in words) when the business made 10 today, or the scope has
 * fewer than 20 reviews and Amazon topic mentions in the window. The AI never reads Amazon review text from Amazon.
 */
export async function generateSpotlight(opts: SpotlightOptions = {}) {
  const now = opts.now ?? new Date()
  const limit = await briefLimit(now)
  if (limit.left <= 0) {
    throw new SpotlightHeldError(`${BRIEF_DAILY_LIMIT} briefs a day for this business: ${limit.usedToday} made today. Try again tomorrow.`, 429, 'daily_limit')
  }
  const g = await gather({ ...opts, now })
  const scope = { channel: opts.channel ?? null, market: opts.marketplace ?? null }
  const material = g.all.length + topicMentions(g.topics)
  if (material < BRIEF_MIN_REVIEWS) {
    throw new SpotlightHeldError(
      `A brief needs at least ${BRIEF_MIN_REVIEWS} reviews and Amazon topic mentions in the period; ${scopeLabel(scope)} has ${material} in ${g.windowDays} days. Pick a longer period, or more markets.`,
      409,
      'too_few',
    )
  }
  const [alerts, fixRows] = await Promise.all([
    prisma.reviewSpike.findMany({
      where: { status: { in: ['OPEN', 'ACKNOWLEDGED'] }, ...(opts.marketplace ? { marketplace: opts.marketplace } : {}), ...(opts.productId ? { productId: opts.productId } : {}) },
      orderBy: { detectedAt: 'desc' },
      take: 50,
      select: { id: true, category: true, marketplace: true },
    }),
    prisma.reviewActionItem.groupBy({ by: ['category'], where: { status: 'OPEN', ...(opts.marketplace ? { marketplace: opts.marketplace } : {}), ...(opts.productId ? { productId: opts.productId } : {}) }, _count: { _all: true } }),
  ])
  const ev: BriefEvidence = { alerts, fixes: new Map(fixRows.filter((f) => f.category).map((f) => [f.category!, f._count._all])) }
  const fallback: SpotlightContent = { ...heuristicBrief(g.reviews), findings: briefFindings({ now: g.all, before: g.prev, topics: g.topics, windowDays: g.windowDays }, ev) }
  const { content, usedAi } = await aiBrief(g, fallback, ev)
  content.changes = briefChanges(g.all, g.prev)
  content.sources = { reviews: g.all.filter(mayReadText).length, amazonTopics: g.topics.length, amazonTopicsAt: g.topicsAt?.toISOString() ?? null, amazonReviewText: false }
  const first = content.findings?.[0]
  const headline =
    content.sentiment.total === 0 && g.topics.length === 0
      ? 'No reviews in this window yet.'
      : first
        ? `${first.title}.`
        : content.complaints.length > 0
          ? `Top concern: ${content.complaints[0].theme} (${content.complaints[0].count})`
          : 'Sentiment is healthy — no dominant complaint theme.'
  const row = await prisma.reviewSpotlight.create({
    data: {
      productId: opts.productId ?? null,
      channel: opts.channel ?? null,
      marketplace: opts.marketplace ?? null,
      windowDays: g.windowDays,
      reviewCount: g.all.length,
      headline,
      content: content as unknown as object,
      model: usedAi ? MODEL : 'heuristic',
      usedAi,
    },
  })
  return row
}

/** The newest brief of a scope (exactly that scope), or one earlier brief by id (read-only). */
export async function getLatestSpotlight(opts: SpotlightOptions & { id?: string | null } = {}) {
  if (opts.id) return prisma.reviewSpotlight.findUnique({ where: { id: opts.id } })
  return prisma.reviewSpotlight.findFirst({
    where: {
      productId: opts.productId ?? null,
      channel: opts.channel ?? null,
      marketplace: opts.marketplace ?? null,
    },
    orderBy: { generatedAt: 'desc' },
  })
}

export interface SpotlightHistoryRow {
  id: string
  generatedAt: string
  channel: string | null
  marketplace: string | null
  label: string
  windowDays: number
  reviewCount: number
  headline: string | null
  usedAi: boolean
}

/** Earlier briefs, newest first: every business-wide brief, or only one scope's when a channel or market is named. */
export async function spotlightHistory(input: { channel?: unknown; marketplace?: unknown; market?: unknown; limit?: unknown } = {}): Promise<{ items: SpotlightHistoryRow[] }> {
  const scope = spotlightScope(input)
  const named = input.channel !== undefined || input.marketplace !== undefined || input.market !== undefined
  const rows = await prisma.reviewSpotlight.findMany({
    where: { productId: null, ...(named ? { channel: scope.channel, marketplace: scope.market } : {}) },
    orderBy: { generatedAt: 'desc' },
    take: Math.min(Math.max(Number(input.limit) || 20, 1), 100),
    select: { id: true, generatedAt: true, channel: true, marketplace: true, windowDays: true, reviewCount: true, headline: true, usedAi: true },
  })
  return {
    items: rows.map((r) => ({
      id: r.id,
      generatedAt: r.generatedAt.toISOString(),
      channel: r.channel,
      marketplace: r.marketplace,
      label: scopeLabel({ channel: r.channel, market: r.marketplace }),
      windowDays: r.windowDays,
      reviewCount: r.reviewCount,
      headline: r.headline,
      usedAi: r.usedAi,
    })),
  }
}

export interface SpotlightScopeOption {
  channel: string | null
  marketplace: string | null
  label: string
  /** Reviews in the window plus Amazon topic mentions. */
  material: number
  tooFew: boolean
  latest: { id: string; generatedAt: string } | null
  /** "Brief from 26 Oct", "No brief yet", "Too few reviews (13)". */
  note: string
}

const shortDate = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

/** The "Brief for" options: every channel and market with reviews (or Amazon topics), each saying whether a brief exists. */
export async function spotlightScopes(input: { windowDays?: number; now?: Date } = {}): Promise<{ options: SpotlightScopeOption[]; limit: { perDay: number; usedToday: number; left: number }; minReviews: number; windowDays: number }> {
  const now = input.now ?? new Date()
  const windowDays = input.windowDays ?? 30
  const since = new Date(now.getTime() - windowDays * DAY)
  const [groups, topicRows, briefs, limit] = await Promise.all([
    prisma.review.groupBy({ by: ['channel', 'marketplace'], where: visibleReviewWhere({ postedAt: { gte: since, lte: now } }), _count: { _all: true } }),
    prisma.amazonReviewInsight.findMany({ where: { accessStatus: 'OK', marketplace: { in: amazonTopicMarkets({ channel: 'AMAZON', market: null }) } }, select: { marketplace: true, fetchedAt: true, positiveTopics: true, negativeTopics: true } }),
    prisma.reviewSpotlight.findMany({ where: { productId: null }, orderBy: { generatedAt: 'desc' }, take: 500, select: { id: true, channel: true, marketplace: true, generatedAt: true } }),
    briefLimit(now),
  ])
  const topicsBy = new Map<string, number>()
  for (const t of parseTopicRows(topicRows)) topicsBy.set(t.market, (topicsBy.get(t.market) ?? 0) + t.mentions)
  const reviewsBy = new Map<string, number>()
  const add = (k: string, n: number) => reviewsBy.set(k, (reviewsBy.get(k) ?? 0) + n)
  for (const g of groups) {
    const ch = g.channel.toUpperCase()
    const m = g.marketplace?.toUpperCase() ?? ''
    add('|', g._count._all)
    add(`${ch}|`, g._count._all)
    if (m && (ch === 'AMAZON' || ch === 'EBAY')) add(`${ch}|${m}`, g._count._all)
  }
  for (const [m, n] of topicsBy) {
    add('|', n)
    add('AMAZON|', n)
    add(`AMAZON|${m}`, n)
  }
  const keys = new Set<string>(['|', ...reviewsBy.keys()])
  for (const b of briefs) keys.add(`${b.channel ?? ''}|${b.channel ? b.marketplace ?? '' : ''}`)
  const order = (k: string) => {
    const [ch, m] = k.split('|')
    const ci = ch ? ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY'].indexOf(ch) : -1
    return [ci === -1 && ch ? 9 : ci, m ? 1 : 0, m] as const
  }
  const options = [...keys]
    .filter((k) => {
      const [ch] = k.split('|')
      return !ch || ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY'].includes(ch)
    })
    .sort((a, b) => {
      const [ca, ma, na] = order(a)
      const [cb, mb, nb] = order(b)
      return ca - cb || ma - mb || na.localeCompare(nb)
    })
    .map((k): SpotlightScopeOption => {
      const [ch, m] = k.split('|')
      const channel = ch || null
      const marketplace = m || null
      const material = reviewsBy.get(k) ?? 0
      const brief = briefs.find((b) => (b.channel ?? null) === channel && (b.marketplace ?? null) === marketplace)
      const tooFew = material < BRIEF_MIN_REVIEWS
      return {
        channel,
        marketplace,
        label: scopeLabel({ channel, market: marketplace }),
        material,
        tooFew,
        latest: brief ? { id: brief.id, generatedAt: brief.generatedAt.toISOString() } : null,
        note: brief ? `Brief from ${shortDate(brief.generatedAt)}` : tooFew ? `Too few reviews (${material})` : 'No brief yet',
      }
    })
  return { options, limit, minReviews: BRIEF_MIN_REVIEWS, windowDays }
}
