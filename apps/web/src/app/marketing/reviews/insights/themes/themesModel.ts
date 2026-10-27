/**
 * Reviews › Insights › Themes — the words and numbers of the page (build spec §3.4, the Themes board): the tiles, a
 * theme's mood, star impact and change, the heatmap's matrix and the words of each cell, and where a theme or a cell
 * opens the Inbox. Pure (no React), tested in themesModel.vitest.test.ts. The numbers are the API's
 * (`GET /api/reviews/insights/themes`, `GET /api/reviews/heatmap`); this file only says them.
 *
 * Amazon (ruling 5): Amazon gives topics only — weekly, in English, for the UK, Germany, France, Italy and Spain, never
 * Amazon.nl. No Amazon star rating is read or shown.
 */
import { inboxHref } from '../../_lib/reviewsLinks'
import { themeWord } from '../../_lib/reviewWords'
import { amazonTopicsInScope, periodWords, type InsightsPeriod, type InsightsScope } from '../_shared/insightsScope'

// ── The API's answers ───────────────────────────────────────────────

export type ThemeMood = 'positive' | 'negative' | 'mixed' | 'too_few'

export interface ThemeSnippet {
  text: string
  english: string | null
  source: 'amazon_topic' | 'review'
  channel: string
  market: string | null
  from: string
  reviewId: string | null
}

export interface InsightTheme {
  key: string
  label: string
  mood: ThemeMood
  mentions: number
  share: number | null
  starImpact: number | null
  starImpactFrom: 'reviews' | 'amazon_topic' | null
  change: number | null
  trend: number[] | null
  tooFew: boolean
  sources: { reviews: number; amazonTopics: number }
  snippets: ThemeSnippet[]
}

export interface AmazonTopicMarket {
  market: string
  label: string
  state: 'ok' | 'needs_role' | 'error' | 'no_data'
  words: string
  topicsAt: string | null
}

export interface ThemesAnswer {
  scope: { channel: string | null; market: string | null; period: string; sort: string }
  summary: {
    reviewsRead: number
    negativeShare: number | null
    negativeShareChange: number | null
    biggestRiser: { key: string; label: string; change: number } | null
    themeCount: number
    amazonTopicMarkets: number
    amazonTopicsAt: string | null
  }
  themes: InsightTheme[]
  amazon: { markets: AmazonTopicMarket[]; notOffered: string | null }
  generatedAt: string
}

export interface HeatmapCell {
  date: string
  category: string
  total: number
  positive: number
  neutral: number
  negative: number
  value: number
}

export interface HeatmapAnswer {
  dates: string[]
  categories: string[]
  cells: HeatmapCell[]
  sinceDays: number
  marketplace: string | null
  channel: string | null
  metric: HeatMetric
}

// ── Sort and heatmap mode ───────────────────────────────────────────

export const THEME_SORTS = ['mentions', 'impact', 'change'] as const
export type ThemeSort = (typeof THEME_SORTS)[number]
export const THEME_SORT_OPTIONS: Array<{ value: ThemeSort; label: string }> = [
  { value: 'mentions', label: 'Mentions' },
  { value: 'impact', label: 'Star impact' },
  { value: 'change', label: 'Change' },
]

export function parseThemeSort(raw: string | null | undefined): ThemeSort {
  return (THEME_SORTS as readonly string[]).includes(raw ?? '') ? (raw as ThemeSort) : 'mentions'
}

export type HeatMetric = 'mentions' | 'negativeShare'
export const HEAT_METRIC_OPTIONS: Array<{ value: HeatMetric; label: string }> = [
  { value: 'mentions', label: 'Mentions' },
  { value: 'negativeShare', label: 'Negative share' },
]

export function parseHeatMetric(raw: string | null | undefined): HeatMetric {
  return raw === 'negativeShare' ? 'negativeShare' : 'mentions'
}

// ── Numbers in words ────────────────────────────────────────────────

const signed = (n: number, digits: number) => {
  const text = Math.abs(n).toFixed(digits)
  return n > 0 ? `+${text}` : n < 0 ? `−${text}` : text
}

/** "+6 pts", "−2 pts", "Same"; unknown → "—". */
export function pointsWords(change: number | null | undefined): string {
  if (change == null || !Number.isFinite(change)) return '—'
  if (change === 0) return 'Same'
  return `${signed(change, Number.isInteger(change) ? 0 : 1)} pts`
}

/** "18%"; unknown → "—". */
export function shareWords(share: number | null | undefined): string {
  if (share == null || !Number.isFinite(share)) return '—'
  return `${Number.isInteger(share) ? share : share.toFixed(1)}%`
}

export const MOOD_WORDS: Record<ThemeMood, string> = {
  negative: 'Mostly negative',
  positive: 'Mostly positive',
  mixed: 'Mixed',
  too_few: 'Too few to say',
}

export interface ImpactView {
  /** "−0.80 ★", "+0.20 ★", "—". */
  text: string
  tone: 'danger' | 'warning' | 'success' | 'neutral'
  /** "0.80 stars below your average, from Amazon’s topics". */
  words: string
}

/**
 * Star impact: how many stars the reviews that mention a theme sit above or below the average. Half a star or more
 * below is danger, any harm is a warning, a lift is success; none (too few rated mentions) says so.
 */
export function impactView(theme: Pick<InsightTheme, 'starImpact' | 'starImpactFrom' | 'tooFew'>): ImpactView {
  const n = theme.starImpact
  if (n == null || !Number.isFinite(n)) {
    return { text: '—', tone: 'neutral', words: theme.tooFew ? 'Too few mentions to measure its effect on stars' : 'Too few rated reviews to measure its effect on stars' }
  }
  const from = theme.starImpactFrom === 'amazon_topic' ? ', from Amazon’s topics' : ''
  const size = Math.abs(n).toFixed(2)
  const tone = n <= -0.5 ? 'danger' : n < 0 ? 'warning' : n > 0 ? 'success' : 'neutral'
  const words = n === 0 ? `No effect on stars${from}` : `${size} ${size === '1.00' ? 'star' : 'stars'} ${n < 0 ? 'below' : 'above'} your average${from}`
  return { text: `${signed(n, 2)} ★`, tone, words }
}

/** A change in share: a rise is bad news for a complaint, good for praise — so the page colours by the mood. */
export function changeTone(theme: Pick<InsightTheme, 'change' | 'mood'>): 'bad' | 'good' | null {
  const c = theme.change
  if (c == null || c === 0 || theme.mood === 'mixed' || theme.mood === 'too_few') return null
  const rising = c > 0
  return (theme.mood === 'negative') === rising ? 'bad' : 'good'
}

/** The 8-week line's name for a reader: "Mentions a week, last 8 weeks: 2, 3, 0 …"; none → too few to trend. */
export function trendLabel(theme: Pick<InsightTheme, 'label' | 'trend'>): string {
  if (!theme.trend) return `${theme.label}: too few to trend`
  return `${theme.label}, mentions a week over the last 8 weeks: ${theme.trend.join(', ')}`
}

/** "12 reviews · 40 Amazon topic mentions". */
export function sourcesWords(theme: Pick<InsightTheme, 'sources'>): string {
  const parts: string[] = []
  if (theme.sources.reviews) parts.push(`${theme.sources.reviews} ${theme.sources.reviews === 1 ? 'review' : 'reviews'}`)
  if (theme.sources.amazonTopics) parts.push(`${theme.sources.amazonTopics} Amazon topic ${theme.sources.amazonTopics === 1 ? 'mention' : 'mentions'}`)
  return parts.join(' · ') || 'No mentions'
}

// ── Tiles ───────────────────────────────────────────────────────────

export interface ThemesTiles {
  read: string
  readHint: string
  negative: string
  negativeDelta: { value: string; positive: boolean } | null
  riser: string
  riserDelta: { value: string; positive: boolean } | null
  riserHint: string
  themes: string
}

export function themesTiles(answer: ThemesAnswer): ThemesTiles {
  const s = answer.summary
  const topics = s.amazonTopicMarkets
  const riser = s.biggestRiser
  return {
    read: s.reviewsRead.toLocaleString('en-IE'),
    readHint: topics ? `plus Amazon topics for ${topics} ${topics === 1 ? 'market' : 'markets'}` : 'reviews and feedback in the period',
    negative: shareWords(s.negativeShare == null ? null : Math.round(s.negativeShare)),
    // Fewer 1- and 2-star reviews is good news.
    negativeDelta: s.negativeShareChange == null || s.negativeShareChange === 0 ? null : { value: pointsWords(Math.round(s.negativeShareChange)), positive: s.negativeShareChange < 0 },
    riser: riser ? riser.label : 'None',
    riserDelta: riser ? { value: pointsWords(Math.round(riser.change)), positive: false } : null,
    riserHint: riser ? 'share of reviews, against the period before' : 'no theme came up more often',
    themes: String(s.themeCount),
  }
}

// ── Amazon's topics ─────────────────────────────────────────────────

export interface TopicsBanner {
  tone: 'info' | 'warning'
  title: string
  text: string
  /** Markets whose topics could not be read, in words ("Amazon Spain: …"). */
  problems: string[]
}

/** The Amazon banner for a scope: none for another channel; "not on Amazon.nl" for the Netherlands. */
export function topicsBanner(answer: ThemesAnswer, scope: Pick<InsightsScope, 'channel' | 'market'>): TopicsBanner | null {
  if (answer.amazon.notOffered) {
    return { tone: 'warning', title: 'Not available on Amazon.nl', text: answer.amazon.notOffered, problems: [] }
  }
  if (!amazonTopicsInScope(scope)) return null
  return {
    tone: 'info',
    title: 'Amazon topics are weekly and in English only.',
    text:
      'Amazon gives no review text and no star rating. Its topics for the UK, Germany, France, Italy and Spain — mentions, share of reviews, effect on stars and short English snippets — are updated weekly; not available on Amazon.nl. Themes from eBay, Shopify and imported reviews come from the review text in its own language, with an English translation. Etsy reviews and the Shopify review app come in a later step.',
    problems: answer.amazon.markets.filter((m) => m.state !== 'ok').map((m) => `${m.label}: ${m.words}`),
  }
}

// ── The heatmap ─────────────────────────────────────────────────────

const DAY = 86_400_000

const dayTitle = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
const dayShort = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

export interface HeatMatrix {
  keys: string[]
  rowLabels: string[]
  colLabels: string[]
  colTitles: string[]
  data: Array<Array<number | null>>
  /** The cell behind each value, for its words. */
  cells: Array<Array<HeatmapCell | null>>
}

/** Rows = themes (the API's order), columns = days; a day without a mention of the theme has no measurement (null). */
export function heatMatrix(answer: HeatmapAnswer): HeatMatrix {
  const at = new Map(answer.cells.map((c) => [`${c.category}|${c.date}`, c]))
  const step = answer.dates.length > 45 ? 14 : 7
  const cells = answer.categories.map((key) => answer.dates.map((date) => at.get(`${key}|${date}`) ?? null))
  return {
    keys: answer.categories,
    rowLabels: answer.categories.map(themeWord),
    // A label every week (every 2 weeks over 45 days), counted back from today so the newest column always has one.
    colLabels: answer.dates.map((d, i) => ((answer.dates.length - 1 - i) % step === 0 ? dayShort(d) : '')),
    colTitles: answer.dates.map(dayTitle),
    data: cells.map((row) => row.map((c) => (c ? c.value : null))),
    cells,
  }
}

/** "Fit & sizing · Fri 24 Oct: 5 mentions, 2 negative — opens these reviews"; no cell → "no reviews mention it". */
export function heatCellText(themeLabel: string, date: string, cell: HeatmapCell | null, metric: HeatMetric): string {
  const where = `${themeLabel} · ${dayTitle(date)}`
  if (!cell) return `${where}: no reviews mention it`
  const mentions = `${cell.total} ${cell.total === 1 ? 'mention' : 'mentions'}`
  const negative = `${cell.negative} negative`
  const body = metric === 'negativeShare' ? `${shareWords(cell.value)} negative (${negative} of ${mentions})` : `${mentions}, ${negative}`
  return `${where}: ${body} — opens these reviews in the Inbox`
}

/** The Inbox's shortest period that still holds a day (the Inbox reads periods, not single days). */
export function inboxPeriodFor(date: string, now: Date): InsightsPeriod {
  const age = (now.getTime() - new Date(`${date}T00:00:00Z`).getTime()) / DAY
  if (age < 7) return '7d'
  if (age < 30) return '30d'
  if (age < 90) return '90d'
  return '12m'
}

/** A heatmap cell → the Inbox: that theme, in the scope, over the shortest period that holds the day. */
export function heatCellHref(themeKey: string, date: string, scope: Pick<InsightsScope, 'channel' | 'market'>, now: Date): string {
  return inboxHref({ theme: themeKey, channel: scope.channel, market: scope.market, period: inboxPeriodFor(date, now) })
}

/** A theme → its reviews in the Inbox, in the scope and the period. */
export function themeHref(themeKey: string, scope: InsightsScope): string {
  return inboxHref({ theme: themeKey, channel: scope.channel, market: scope.market, period: scope.period })
}

/** The heatmap card's line: "Mentions a day, last 30 days · Amazon Germany". */
export function heatSubtitle(answer: HeatmapAnswer | null, metric: HeatMetric, period: InsightsPeriod): string {
  const what = metric === 'negativeShare' ? 'Share of a theme’s mentions that are negative, a day' : 'Mentions a day'
  const days = answer?.sinceDays
  const span = days ? `last ${days} days` : periodWords(period).label
  return period === '12m' ? `${what}, last 90 days (the map shows at most 90 days)` : `${what}, ${span}`
}
