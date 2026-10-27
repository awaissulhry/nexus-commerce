/**
 * Reviews › "Complaint spike" alert (Settings › Alerts) — the pure rules of the hourly spike check
 * (spike-detector.service.ts), ONE source for the check, the Settings page's words and the notice.
 *
 *   Cohort      one product (as the review is linked: a size or colour counts on its own), one market, one theme.
 *   Counts      ReviewCategoryRate: per posted day, the reviews whose AI reading named the theme (`total`) and how many
 *               of them it read as negative (`negative`), counted when the review arrived (review-ingest.service.ts) —
 *               every channel and file imports alike; sample rows and reviews with no product or no market never.
 *   Windows     recent = the last 7 days (from midnight UTC 7 days ago); baseline = the last 28 days, which include them.
 *   Spike       at least `minNegative` negative reviews about the theme in the recent window, at least `minReviews`
 *               reviews about it in the baseline, and the recent negative share at least `multiplier` × the baseline's.
 *   Once        one alert per product, market and theme: an open or acknowledged one stops a second; a resolved one
 *               stops a new one for `reopenAfterDays` (as "Rating drop", and as Insights › Alerts' Resolve says).
 *
 * The numbers can be tuned per deployment (NEXUS_REVIEW_SPIKE_MIN_7D, NEXUS_REVIEW_SPIKE_MIN_BASELINE,
 * NEXUS_REVIEW_SPIKE_MULTIPLIER); the Settings page reads them from GET /api/reviews/settings, so its words stay true.
 * No database and no clock of its own: complaint-spike.vitest.test.ts checks each rule with plain numbers.
 */
import { round, themeWords } from './overviewMath.js'
import { ratingDropWhere } from './rating-drop-math.js'

const DAY = 86_400_000

export interface ComplaintSpikeRule {
  /** The recent window, in days. */
  recentDays: number
  /** The baseline window, in days (it includes the recent window). */
  baselineDays: number
  /** The fewest negative reviews about the theme in the recent window. */
  minNegative: number
  /** The fewest reviews about the theme in the baseline window. */
  minReviews: number
  /** The recent negative share must be at least this many times the baseline's. */
  multiplier: number
  /** After a resolve, no new alert for the same product, market and theme for this many days. */
  reopenAfterDays: number
}

function envNumber(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return value != null && value.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : fallback
}

export function complaintSpikeRule(env: Record<string, string | undefined> = process.env): ComplaintSpikeRule {
  return {
    recentDays: 7,
    baselineDays: 28,
    minNegative: envNumber(env.NEXUS_REVIEW_SPIKE_MIN_7D, 3),
    minReviews: envNumber(env.NEXUS_REVIEW_SPIKE_MIN_BASELINE, 5),
    multiplier: envNumber(env.NEXUS_REVIEW_SPIKE_MULTIPLIER, 2),
    reopenAfterDays: 7,
  }
}

/** The rule this deployment runs (read once at start, like the check always did). */
export const COMPLAINT_SPIKE_RULE: ComplaintSpikeRule = complaintSpikeRule()

/** One cohort's sums: the recent window's negative / all reviews about the theme, and the baseline's. */
export interface SpikeStats {
  rate7dNumerator: number
  rate7dDenominator: number
  rate28dNumerator: number
  rate28dDenominator: number
}

/** Whether a cohort spikes, and by how many times (99 = negatives where the baseline had none). */
export function complaintSpikeVerdict(stats: SpikeStats, rule: ComplaintSpikeRule = COMPLAINT_SPIKE_RULE): { spike: boolean; multiplier: number | null } {
  if (stats.rate7dNumerator < rule.minNegative) return { spike: false, multiplier: null }
  if (stats.rate28dDenominator < rule.minReviews) return { spike: false, multiplier: null }
  const rate7d = stats.rate7dNumerator / Math.max(1, stats.rate7dDenominator)
  const rate28d = stats.rate28dNumerator / Math.max(1, stats.rate28dDenominator)
  // Pure novelty: negatives now, none in the baseline — itself a spike.
  if (rate28d === 0) return { spike: true, multiplier: 99 }
  const multiplier = rate7d / rate28d
  return { spike: multiplier >= rule.multiplier, multiplier }
}

export interface ExistingSpike {
  status: string
  resolvedAt: Date | null
}

/** Why no new alert opens for a cohort that spikes (null = a new one opens). */
export function complaintSpikeHeld(existing: readonly ExistingSpike[], now: Date, rule: ComplaintSpikeRule = COMPLAINT_SPIKE_RULE): 'open' | 'resolved recently' | null {
  if (existing.some((a) => a.status === 'OPEN' || a.status === 'ACKNOWLEDGED')) return 'open'
  const since = now.getTime() - rule.reopenAfterDays * DAY
  if (existing.some((a) => a.status === 'RESOLVED' && a.resolvedAt != null && a.resolvedAt.getTime() >= since)) return 'resolved recently'
  return null
}

// ── Words ───────────────────────────────────────────────────────────

const share = (n: number, of: number) => (of > 0 ? `${round((n / of) * 100, 0)}%` : '—')

export interface ComplaintSpikeNoticeInput extends SpikeStats {
  /** The theme's key (FIT_SIZING …). */
  theme: string
  market: string
  /** The channels of the recent window's negative reviews about the theme. */
  channels: readonly string[]
  productName: string | null
  /** A few of the buyers' own words, as the check kept them. */
  phrases: readonly string[]
}

/** The bell notice and e-mail of a new complaint spike. */
export function complaintSpikeNoticeWords(input: ComplaintSpikeNoticeInput, rule: ComplaintSpikeRule = COMPLAINT_SPIKE_RULE): { title: string; body: string } {
  const where = ratingDropWhere(input.market, input.channels)
  const about = input.productName ? ` · ${input.productName}` : ''
  const theme = themeWords(input.theme)
  const n = input.rate7dDenominator
  const quotes = [...new Set(input.phrases.map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 3)
  return {
    title: `Complaint spike: ${theme} on ${where}${about}`,
    body: [
      `${input.rate7dNumerator} of ${n} ${n === 1 ? 'review' : 'reviews'} about ${theme} in the last ${rule.recentDays} days are negative (${share(input.rate7dNumerator, n)}), against ${share(input.rate28dNumerator, input.rate28dDenominator)} over the last ${rule.baselineDays} days.`,
      quotes.length ? `Buyers wrote: ${quotes.map((q) => `“${q.length > 80 ? `${q.slice(0, 79)}…` : q}”`).join(', ')}.` : null,
    ].filter(Boolean).join(' '),
  }
}
