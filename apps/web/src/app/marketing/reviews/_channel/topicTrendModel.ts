/**
 * Reviews › Amazon — one topic's 6-month trend, as a line and in words. Amazon's Customer Feedback API
 * (`getItemReviewTrends`, read with the weekly topics) gives, per topic, the share of each month's reviews that mention
 * it, for up to six months; the channel answer carries it as `trend` (api `services/reviews/amazon-review-trends.ts`).
 *
 * The sentence is the line's text alternative: "Rose from 4% to 9% of reviews over 6 months". A topic that several reads
 * share (several products, or one product in several markets) is weighted by its mentions, and says so. No trend → true
 * words: not read yet, Amazon did not send it, or Amazon gives none for this topic. Pure, tested in
 * topicTrendModel.vitest.test.ts.
 */
import type { SparkDomain } from '@/design-system/components/sparklineModel'

export interface TopicTrendPoint { month: string; share: number | null }

/**
 * The line's axis: from 0 % to at least the highest month, so a share that moves 11 → 11.2 % draws flat and 4 → 9 %
 * climbs — the DS Sparkline's fixed axis (`domain`), not the readings' own low and high.
 */
export const SHARE_AXIS: SparkDomain = [0, null]

export type TopicTrend =
  | { state: 'ok'; points: TopicTrendPoint[]; reads: number; products: number; markets: number }
  | { state: 'none' | 'refused' | 'not_read' }

export interface TopicTrendView {
  /** The line: shares, oldest month first (a null keeps its month and breaks the line); null when there is no line. */
  values: Array<number | null> | null
  /** The months at the two ends of the line: "May", "Oct 2026" (both with a year when the years differ). */
  from: string | null
  to: string | null
  /** What the trend says, in words. */
  words: string
  /** The line's accessible name: the words and the months. */
  label: string
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2026-05" → "May" (or "May 2026"); anything else → "". */
export function monthWord(month: string, withYear = false): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month)
  const name = m ? MONTH_NAMES[Number(m[2]) - 1] : undefined
  if (!m || !name) return ''
  return withYear ? `${name} ${m[1]}` : name
}

/** The months from one to the other, both counted: "2026-05" → "2026-10" is 6. */
export function monthsSpanned(first: string, last: string): number {
  const at = (month: string) => {
    const [y, m] = month.split('-').map(Number)
    return y * 12 + (m - 1)
  }
  return Math.max(1, at(last) - at(first) + 1)
}

/** A share of reviews: "28%" from 10 up, "4.5%" below (Amazon sends two decimals). */
export function shareWords(n: number): string {
  const shown = n >= 10 ? Math.round(n) : Math.round(n * 10) / 10
  return `${shown}%`
}

export const TREND_NOT_READ = '6-month trend: not read yet — Nexus reads it with the weekly topics'
export const TREND_REFUSED = '6-month trend: Amazon did not send it in the last read'
export const TREND_NONE = '6-month trend: Amazon gives none for this topic'

const wordsOnly = (words: string): TopicTrendView => ({ values: null, from: null, to: null, words, label: words })

/** One topic's trend for the topic row. `null` (an answer from before trends were read) is "not read yet". */
export function topicTrendView(trend: TopicTrend | null | undefined): TopicTrendView {
  if (!trend) return wordsOnly(TREND_NOT_READ)
  if (trend.state !== 'ok') return wordsOnly(trend.state === 'refused' ? TREND_REFUSED : trend.state === 'none' ? TREND_NONE : TREND_NOT_READ)

  const points = trend.points.filter((p) => /^\d{4}-\d{2}$/.test(p.month))
  const known = points.filter((p): p is { month: string; share: number } => p.share != null && Number.isFinite(p.share))
  if (known.length === 0) return wordsOnly(TREND_NONE)

  const firstMonth = points[0].month
  const lastMonth = points[points.length - 1].month
  const sameYear = firstMonth.slice(0, 4) === lastMonth.slice(0, 4)
  const from = monthWord(firstMonth, !sameYear)
  const to = monthWord(lastMonth, true)

  const first = known[0]
  const last = known[known.length - 1]
  let words: string
  if (known.length === 1) {
    words = `${shareWords(last.share)} of reviews in ${monthWord(last.month, true)} — Amazon sent no other month`
  } else {
    const months = monthsSpanned(first.month, last.month)
    const a = shareWords(first.share)
    const b = shareWords(last.share)
    words = a === b
      ? `Held at ${b} of reviews over ${months} months`
      : `${last.share > first.share ? 'Rose' : 'Fell'} from ${a} to ${b} of reviews over ${months} months`
  }
  if (trend.reads > 1) {
    if (trend.products > 1) words += ` · ${trend.products} products, weighted by mentions`
    else if (trend.markets > 1) words += ` · ${trend.markets} markets, weighted by mentions`
  }
  const months = from === to ? to : `${from}–${to}`
  return { values: points.map((p) => p.share), from, to, words, label: `${words}, ${months}` }
}
