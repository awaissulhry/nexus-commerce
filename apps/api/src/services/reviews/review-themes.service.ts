/**
 * Reviews Insights › Themes — GET /api/reviews/insights/themes?channel&market&period&sort (routes/reviews.routes.ts).
 *
 * One row per theme: mentions, share of reviews, star impact (the average stars of the reviews that mention it minus
 * the overall average), change in share against the period before, mentions a week for 8 weeks, and two quotes that
 * name their source. Reviews are the visible Review rows (fixtures never count, review-visibility.ts) with their
 * sentiment themes; Amazon adds its Customer Feedback API topics (AmazonReviewInsight, weekly, English, never
 * Amazon.nl) — topics only: no Amazon star rating, average or count is read or shown (ruling 5). The arithmetic is pure,
 * in review-insights-math.ts. `fit` is the fit table (runs small / true to size / runs large per family and size, from
 * reviews and size returns in the period; review-fit.ts, reads in review-fit.service.ts).
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { visibleReviewWhere } from './review-visibility.js'
import { marketWords } from './overviewMath.js'
import { fitTable } from './review-fit.service.js'
import type { FitTable } from './review-fit.js'
import {
  amazonTopicMarkets, buildThemes, insightBounds, parseInsightPeriod, parseInsightScope, parseThemeSort, parseTopicRows,
  sortThemes, themesSummary, THEME_KEYS, type InsightPeriod, type InsightScope, type InsightTheme, type ThemeReviewRow, type ThemeSort,
  type ThemesSummary,
} from './review-insights-math.js'

const DAY = 86_400_000
const TREND_DAYS = 56

export interface ThemesInput {
  channel?: unknown
  market?: unknown
  marketplace?: unknown
  period?: unknown
  sort?: unknown
  now?: Date
}

export type AmazonTopicState = 'ok' | 'needs_role' | 'error' | 'no_data'

export interface AmazonTopicMarket {
  market: string
  label: string
  state: AmazonTopicState
  words: string
  /** When Amazon's topics for this market were last read (ISO); null when never. */
  topicsAt: string | null
}

export interface ThemesAnswer {
  scope: InsightScope & { period: InsightPeriod; sort: ThemeSort }
  summary: ThemesSummary & { amazonTopicMarkets: number; amazonTopicsAt: string | null }
  themes: InsightTheme[]
  amazon: {
    /** The Amazon markets in scope that can have topics, each with its state in words. */
    markets: AmazonTopicMarket[]
    /** Set when the scope is an Amazon market Amazon gives no topics for (Amazon.nl). */
    notOffered: string | null
  }
  /** Fit by family and size in the period (review-fit.ts): runs small / true to size / runs large, 5 signals a size. */
  fit: FitTable
  generatedAt: string
}

const STATE_WORDS: Record<AmazonTopicState, string> = {
  ok: 'Topics are read every week, in English.',
  needs_role: 'Amazon refused the topics: the Selling Partner account needs the Brand Analytics role for this market.',
  error: 'Amazon’s topics could not be read last time; Nexus tries again next week.',
  no_data: 'No topics from Amazon yet for this market.',
}

/** Each Amazon market's topic state, from the rows the weekly read left (one per ASIN). */
export function topicStates(rows: ReadonlyArray<{ marketplace: string; accessStatus: string; fetchedAt: Date }>, markets: readonly string[]): AmazonTopicMarket[] {
  return markets.map((market) => {
    const mine = rows.filter((r) => r.marketplace.toUpperCase() === market)
    const ok = mine.filter((r) => r.accessStatus === 'OK')
    const state: AmazonTopicState = ok.length > 0 ? 'ok' : mine.some((r) => r.accessStatus === 'NEEDS_BRAND_ANALYTICS_ROLE') ? 'needs_role' : mine.some((r) => r.accessStatus === 'ERROR') ? 'error' : 'no_data'
    const latest = ok.reduce<Date | null>((acc, r) => (!acc || r.fetchedAt > acc ? r.fetchedAt : acc), null)
    return { market, label: `Amazon ${marketWords(market) ?? market}`, state, words: STATE_WORDS[state], topicsAt: latest?.toISOString() ?? null }
  })
}

export async function insightsThemes(input: ThemesInput = {}): Promise<ThemesAnswer> {
  const now = input.now ?? new Date()
  const period = parseInsightPeriod(input.period)
  const sort = parseThemeSort(input.sort)
  const scope = parseInsightScope(input)
  const bounds = insightBounds(period, now)
  const trendFrom = new Date(now.getTime() - TREND_DAYS * DAY)
  const readFrom = bounds.prevFrom < trendFrom ? bounds.prevFrom : trendFrom

  const scoped: Prisma.ReviewWhereInput = {
    ...(scope.channel ? { channel: scope.channel } : {}),
    ...(scope.market ? { marketplace: scope.market } : {}),
    postedAt: { gte: readFrom, lte: now },
  }
  const markets = amazonTopicMarkets(scope)
  const [reviews, insightRows, fit] = await Promise.all([
    prisma.review.findMany({
      where: visibleReviewWhere(scoped),
      select: {
        id: true, channel: true, marketplace: true, rating: true, postedAt: true, ingestSource: true, kind: true, body: true, bodyEnglish: true, language: true,
        sentiment: { select: { label: true, categories: true, topPhrases: true } },
      },
    }),
    markets.length
      ? prisma.amazonReviewInsight.findMany({
          where: { marketplace: { in: markets } },
          select: { marketplace: true, productId: true, accessStatus: true, fetchedAt: true, positiveTopics: true, negativeTopics: true },
        })
      : Promise.resolve([]),
    fitTable({ scope, from: bounds.from, now }),
  ])

  const rows = reviews as ThemeReviewRow[]
  const inPeriod = rows.filter((r) => r.postedAt >= bounds.from)
  const before = rows.filter((r) => r.postedAt >= bounds.prevFrom && r.postedAt < bounds.prevTo)
  const trendRows = rows.filter((r) => r.postedAt >= trendFrom)
  const okRows = insightRows.filter((r) => r.accessStatus === 'OK')
  const topics = parseTopicRows(okRows)
  const themes = sortThemes(buildThemes({ rows: inPeriod, prevRows: before, trendRows, topics, now }), sort)
  const states = topicStates(insightRows, markets)
  const topicsAt = states.reduce<string | null>((acc, s) => (s.topicsAt && (!acc || s.topicsAt > acc) ? s.topicsAt : acc), null)

  return {
    scope: { ...scope, period, sort },
    summary: { ...themesSummary(inPeriod, before, themes), amazonTopicMarkets: states.filter((s) => s.state === 'ok').length, amazonTopicsAt: topicsAt },
    themes,
    amazon: {
      markets: states,
      notOffered: scope.market && (!scope.channel || scope.channel === 'AMAZON') && markets.length === 0 && scope.market === 'NL'
        ? 'Amazon gives no review topics for Amazon.nl: its themes come only from reviews you import.'
        : null,
    },
    fit,
    generatedAt: now.toISOString(),
  }
}

// ── The heatmap: when themes come up ────────────────────────────────

export type HeatmapMetric = 'mentions' | 'negativeShare'

export interface HeatmapCell {
  date: string
  category: string
  total: number
  positive: number
  neutral: number
  negative: number
  /** What the chosen metric draws: mentions, or the percent of them that are negative (one decimal). */
  value: number
}

export interface HeatmapAnswer {
  dates: string[]
  categories: string[]
  /** Only days with reviews have a cell: a day without one is drawn striped ("no reviews"), never a 0. */
  cells: HeatmapCell[]
  sinceDays: number
  marketplace: string | null
  channel: string | null
  metric: HeatmapMetric
}

const PERIOD_SINCE: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90, '12m': 90 }

/**
 * GET /api/reviews/heatmap?sinceDays|period&marketplace|market&channel&metric — day × theme from the visible reviews
 * (fixtures never count) and their sentiment themes. 7 to 90 days (12 months shows the last 90 days).
 */
export async function insightsHeatmap(input: { sinceDays?: unknown; period?: unknown; marketplace?: unknown; market?: unknown; channel?: unknown; metric?: unknown; now?: Date } = {}): Promise<HeatmapAnswer> {
  const now = input.now ?? new Date()
  const asked = Number(input.sinceDays) || PERIOD_SINCE[String(input.period ?? '')] || 30
  const sinceDays = Math.min(Math.max(asked, 7), 90)
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (sinceDays - 1) * DAY)
  const scope = parseInsightScope(input)
  const metric: HeatmapMetric = input.metric === 'negativeShare' ? 'negativeShare' : 'mentions'
  const rows = await prisma.review.findMany({
    where: visibleReviewWhere({
      ...(scope.channel ? { channel: scope.channel } : {}),
      ...(scope.market ? { marketplace: scope.market } : {}),
      postedAt: { gte: since, lte: now },
      sentiment: { isNot: null },
    }),
    select: { postedAt: true, sentiment: { select: { label: true, categories: true } } },
  })
  return heatmapCells(rows, since, now, sinceDays, metric, scope)
}

/** The cube from rows (pure): one cell per day and theme that has reviews. */
export function heatmapCells(
  rows: ReadonlyArray<{ postedAt: Date; sentiment: { label: string; categories: string[] } | null }>,
  since: Date,
  now: Date,
  sinceDays: number,
  metric: HeatmapMetric,
  scope: InsightScope,
): HeatmapAnswer {
  const cells = new Map<string, HeatmapCell>()
  for (const r of rows) {
    if (!r.sentiment) continue
    const date = r.postedAt.toISOString().slice(0, 10)
    for (const category of new Set(r.sentiment.categories)) {
      const key = `${date}::${category}`
      const cell = cells.get(key) ?? { date, category, total: 0, positive: 0, neutral: 0, negative: 0, value: 0 }
      cell.total += 1
      if (r.sentiment.label === 'POSITIVE') cell.positive += 1
      else if (r.sentiment.label === 'NEGATIVE') cell.negative += 1
      else cell.neutral += 1
      cells.set(key, cell)
    }
  }
  for (const cell of cells.values()) cell.value = metric === 'negativeShare' ? Math.round((cell.negative / cell.total) * 1000) / 10 : cell.total
  const dates: string[] = []
  for (let t = since.getTime(); t <= now.getTime(); t += DAY) dates.push(new Date(t).toISOString().slice(0, 10))
  const present = new Set([...cells.values()].map((c) => c.category))
  const order: readonly string[] = THEME_KEYS
  const categories = [...order.filter((k) => present.has(k)), ...[...present].filter((k) => !order.includes(k)).sort()]
  return {
    dates,
    categories,
    cells: [...cells.values()].sort((a, b) => a.date.localeCompare(b.date) || a.category.localeCompare(b.category)),
    sinceDays,
    marketplace: scope.market,
    channel: scope.channel,
    metric,
  }
}
