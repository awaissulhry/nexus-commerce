/**
 * Reviews Overview — the answer of GET /api/reviews/area/overview and /needs-you, and every word the page shows for it:
 * changes against the period before, ratings in each channel's measure (stars, or eBay's % positive), Etsy's dash for
 * requests, "Too few to trend", the Needs-you footer, theme counts and the links each item opens. Pure (no React), so
 * overviewModel.vitest.test.ts checks the words. A section the API could not read stays an error here — never zeros.
 */
import {
  inboxHref, insightsHref, productReviewsHref, requestsHref, type InboxLinkParams,
} from '../_lib/reviewsLinks'
import { channelMarketWords } from '../_lib/reviewWords'
import type { NeedsFilter, OverviewPeriod, StarsFilter } from './overviewQuery'

// ── The API's answer (apps/api/src/services/reviews/review-overview.service.ts) ──

export type Section<T> = { ok: true; data: T } | { ok: false; error: string }
export type RatingKind = 'stars' | 'positive'
export type TrendBucket = 'day' | 'week' | 'month'

export interface OverviewTiles {
  avgRating: number | null
  avgDelta: number | null
  newReviews: number
  newDelta: number | null
  needReply: number
  oldestWaitDays: number | null
  requestsSent: number
  requestsFailed: number
  reviewRate: number | null
  rateDelta: number | null
  openAlerts: number
  newAlertsToday: number
}

export interface TrendPoint { day: string; reviews: number; avg: number | null }

export interface OverviewSpread { counts: [number, number, number, number, number]; product: number; seller: number; note: string | null }

export interface OverviewChannelRow {
  channel: string
  market: string | null
  label: string
  ratingKind: RatingKind
  rating: number | null
  reviews: number
  change: number | null
  sent: number | null
  rate: number | null
  lastReviewAt: string | null
  state: 'ok' | 'not_updating'
  reason: string | null
  since: string | null
  reconnectHref: string | null
  what: string
  lastNote: string | null
}

export interface OverviewTheme {
  key: string
  label: string
  share: number | null
  shareOf: 'positive' | 'negative' | 'amazon'
  mentions: number
  source: 'amazon_topic' | 'review'
  quote: string | null
  quoteFrom: string | null
  english: string | null
  impact: number | null
  market: string | null
}

export interface OverviewWatchRow {
  productId: string
  name: string
  sku: string | null
  channel: string
  market: string | null
  where: string
  kind: RatingKind
  ratingNow: number | null
  ratingBefore: number | null
  change: number
  reviews: number
  topTheme: string | null
  spark: Array<number | null>
  tooFew: boolean
}

export interface SetupProblem { id: string; title: string; words: string; actionLabel: string; href: string; fingerprint: string }

export interface OverviewResponse {
  period: { key: string; from: string | null; to: string; prevFrom: string | null; prevTo: string | null }
  generatedAt: string
  sections: {
    tiles: Section<OverviewTiles>
    trend: Section<{ bucket: TrendBucket; points: TrendPoint[] }>
    spread: Section<OverviewSpread>
    channels: Section<OverviewChannelRow[]>
    themes: Section<{ love: OverviewTheme[]; fix: OverviewTheme[] }>
    watch: Section<OverviewWatchRow[]>
    setup: Section<SetupProblem[]>
  }
}

export type NeedsPage = 'inbox' | 'review' | 'requests' | 'alerts'

export interface NeedsYouItem {
  kind: 'review' | 'alert' | 'request'
  id: string
  label: string
  tone: 'danger' | 'warning'
  title: string
  detail: string
  at: string
  action: { label: string; page: NeedsPage; params: Record<string, string | number> }
}

export interface NeedsYouResponse { items: NeedsYouItem[]; total: number; counts: { reply: number; requests: number; alerts: number } }

/** A section's error words, or null when it was read. A failed section is never shown as zeros. */
export function sectionError<T>(section: Section<T> | null | undefined): string | null {
  return section && !section.ok ? section.error : null
}

/** A section's data, or null when it failed (the card then shows its error, not an empty or zero state). */
export function sectionData<T>(section: Section<T> | null | undefined): T | null {
  return section && section.ok ? section.data : null
}

// ── Numbers in words ─────────────────────────────────────────────────

const MINUS = '−'

/** "+0.1", "−0.3", "0.0" (one decimal by default; a real minus sign). */
export function signed(n: number, digits = 1): string {
  const fixed = Math.abs(n).toFixed(digits)
  if (Number(fixed) === 0) return (0).toFixed(digits)
  return `${n > 0 ? '+' : MINUS}${fixed}`
}

export function count(n: number): string {
  return n.toLocaleString('en')
}

const PERIOD_WORDS: Record<OverviewPeriod, { label: string; prev: string; prevShort: string }> = {
  '7d': { label: 'last 7 days', prev: 'the 7 days before', prevShort: 'week before' },
  '30d': { label: 'last 30 days', prev: 'the 30 days before', prevShort: 'month before' },
  '90d': { label: 'last 90 days', prev: 'the 90 days before', prevShort: 'quarter before' },
  '12m': { label: 'last 12 months', prev: 'the 12 months before', prevShort: 'year before' },
}

export function overviewPeriodWords(period: OverviewPeriod) {
  return PERIOD_WORDS[period]
}

/** A tile's change, in MetricStrip's `delta` shape: `tone` colours it (positive green, negative red, neutral grey). */
export interface DeltaView { value: string; tone: 'positive' | 'negative' | 'neutral' }

/**
 * A change against the period before, for a tile: "+0.1 vs month before", "+14 vs month before", "+0.6 pts". Up is
 * good for every Overview number that has one; no change reads "same as the month before" in the neutral tone (neither
 * green nor red). Unknown → null.
 */
export function deltaView(delta: number | null, unit: 'stars' | 'count' | 'points', period: OverviewPeriod): DeltaView | null {
  if (delta == null || !Number.isFinite(delta)) return null
  const { prevShort } = PERIOD_WORDS[period]
  const zero = unit === 'count' ? delta === 0 : Math.abs(delta) < 0.05
  if (zero) return { value: `same as the ${prevShort}`, tone: 'neutral' }
  const text = unit === 'count' ? `${delta > 0 ? '+' : MINUS}${count(Math.abs(delta))}` : signed(delta)
  return { value: unit === 'points' ? `${text} pts vs ${prevShort}` : `${text} vs ${prevShort}`, tone: delta > 0 ? 'positive' : 'negative' }
}

/** "4.4", "—". */
export function ratingText(kind: RatingKind, rating: number | null): string {
  if (rating == null) return '—'
  return kind === 'positive' ? `${rating.toFixed(1)}%` : rating.toFixed(1)
}

export interface ChangeView { text: string; tone: 'up' | 'down' | 'flat' }

/** A rating's change in its own measure: "+0.1", "−0.2", "+0.2 pts" (eBay), "—" when unknown. */
export function changeView(change: number | null, kind: RatingKind): ChangeView {
  if (change == null || !Number.isFinite(change)) return { text: '—', tone: 'flat' }
  const text = signed(change)
  const flat = Number(Math.abs(change).toFixed(1)) === 0
  return { text: kind === 'positive' && !flat ? `${text} pts` : text, tone: flat ? 'flat' : change > 0 ? 'up' : 'down' }
}

/** "7.4%", "—". */
export function rateText(rate: number | null): string {
  return rate == null ? '—' : `${rate.toFixed(1)}%`
}

const DAY = 86_400_000

/** How long something has waited: "less than an hour", "5 h", "3 days". */
export function ageWords(iso: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(iso))
  if (!Number.isFinite(ms)) return '—'
  const days = Math.floor(ms / DAY)
  if (days >= 1) return `${days} ${days === 1 ? 'day' : 'days'}`
  const hours = Math.floor(ms / 3_600_000)
  return hours >= 1 ? `${hours} h` : 'less than an hour'
}

function dayMonth(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

/** When a review last arrived: "3 h ago", "24 Oct", "None yet". */
export function lastWords(iso: string | null, now: number): string {
  if (!iso) return 'None yet'
  const ms = now - Date.parse(iso)
  if (!Number.isFinite(ms)) return 'None yet'
  if (ms < 3_600_000) return 'Less than an hour ago'
  if (ms < DAY) return `${Math.floor(ms / 3_600_000)} h ago`
  return dayMonth(iso)
}

// ── Header and chart ─────────────────────────────────────────────────

const CHANNEL_NAMES: Record<string, string> = { AMAZON: 'Amazon', EBAY: 'eBay', SHOPIFY: 'Shopify', ETSY: 'Etsy' }

function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** "128 reviews in the last 30 days on Amazon, eBay and Shopify" — or just the period while the numbers are out. */
export function headerSubtitle(period: OverviewPeriod, tiles: OverviewTiles | null, channels: readonly OverviewChannelRow[] | null): string {
  const { label } = PERIOD_WORDS[period]
  if (!tiles) return label.charAt(0).toUpperCase() + label.slice(1)
  const names = [...new Set((channels ?? []).map(c => CHANNEL_NAMES[c.channel] ?? c.channel))]
  const where = names.length ? ` on ${listWords(names)}` : ''
  return `${count(tiles.newReviews)} ${tiles.newReviews === 1 ? 'review' : 'reviews'} in the ${label}${where}`
}

export function chartUnit(bucket: TrendBucket): string {
  return bucket === 'day' ? 'Reviews per day' : bucket === 'week' ? 'Reviews per week' : 'Reviews per month'
}

/** A bucket key in words: "20 Oct" (a day, or the Monday of a week), "Oct 2026" (a month). */
export function bucketLabel(key: string, bucket: TrendBucket): string {
  if (bucket === 'month') {
    const [y, m] = key.split('-').map(Number)
    return new Date(Date.UTC(y, (m || 1) - 1, 1)).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })
  }
  return dayMonth(`${key}T00:00:00Z`)
}

export interface TrendRow { when: string; reviews: number; avg: number | null }

export function trendRows(points: readonly TrendPoint[], bucket: TrendBucket): TrendRow[] {
  return points.map(p => ({ when: bucketLabel(p.day, bucket), reviews: p.reviews, avg: p.avg }))
}

/** The chart in words, for a screen reader: totals, the rating's low, high and latest reading. */
export function trendSummary(points: readonly TrendPoint[], bucket: TrendBucket, period: OverviewPeriod): string {
  const total = points.reduce((n, p) => n + p.reviews, 0)
  const rated = points.filter(p => p.avg != null).map(p => p.avg as number)
  const head = `${chartUnit(bucket)} and average rating, ${PERIOD_WORDS[period].label}: ${count(total)} ${total === 1 ? 'review' : 'reviews'} in all`
  if (rated.length === 0) return `${head}; no star ratings.`
  const lo = Math.min(...rated).toFixed(1)
  const hi = Math.max(...rated).toFixed(1)
  return `${head}; average rating between ${lo} and ${hi}, latest ${rated[rated.length - 1].toFixed(1)}.`
}

export function chartSubtitle(bucket: TrendBucket, period: OverviewPeriod, channelScope: string | null): string {
  return `${chartUnit(bucket)} and the average rating, ${PERIOD_WORDS[period].label}, ${channelScope ?? 'all channels'} · Amazon: imported reviews only`
}

// ── Rating spread ────────────────────────────────────────────────────

const STAR_WORDS = ['', 'one', 'two', 'three', 'four', 'five']

/** How many ratings a bar holds (counts are 5 stars first). */
export function starsCount(counts: OverviewSpread['counts'], stars: StarsFilter): number {
  return counts[5 - stars] ?? 0
}

/** "Open 6 one-star reviews in the Inbox". */
export function starsLinkWords(stars: StarsFilter, n: number): string {
  return `Open ${count(n)} ${STAR_WORDS[stars]}-star ${n === 1 ? 'review' : 'reviews'} in the Inbox`
}

/** Why a bar with no ratings cannot open anything. */
export function zeroStarsReason(stars: StarsFilter, period: OverviewPeriod): string {
  return `No ${STAR_WORDS[stars]}-star reviews in the ${PERIOD_WORDS[period].label}, so there is nothing to open.`
}

// ── Channel table ────────────────────────────────────────────────────

export interface ChannelViewRow {
  id: string
  label: string
  what: string
  href: string | null
  ratingKind: RatingKind
  rating: number | null
  /** Amazon with no imported reviews: "No rating data from Amazon — import reviews". */
  noAmazonData: boolean
  reviews: string
  change: ChangeView
  sent: string
  sentNote: string | null
  rate: string
  state: 'ok' | 'not_updating' | 'later'
  last: string
  lastNote: string | null
  reason: string | null
  reconnectHref: string | null
  /** A labelled placeholder with sample numbers (a channel Nexus reads from a later phase). */
  sample: boolean
}

/**
 * ⛔ KEEP — build spec §8 ruling 3: Etsy reviews arrive in Phase 3 (PR I). Until then its row stays in the table as a
 * labelled placeholder ("Coming later", "sample numbers"); the placeholders are the roadmap. Never real data.
 */
export const ETSY_SAMPLE_ROW: ChannelViewRow = {
  id: 'ETSY|sample',
  label: 'Etsy',
  what: 'Shop reviews · sample',
  href: null,
  ratingKind: 'stars',
  rating: 4.8,
  noAmazonData: false,
  reviews: '12',
  change: { text: '—', tone: 'flat' },
  sent: '—',
  sentNote: 'Etsy asks buyers itself',
  rate: '—',
  state: 'later',
  last: 'Coming later',
  lastNote: 'sample numbers',
  reason: null,
  reconnectHref: null,
  sample: true,
}

/** The channel table's rows in words; each opens that channel's reviews. */
export function channelViewRows(rows: readonly OverviewChannelRow[], now: number, withSample = true): ChannelViewRow[] {
  const out = rows.map((r): ChannelViewRow => {
    const amazon = r.channel === 'AMAZON'
    const etsy = r.channel === 'ETSY'
    return {
      id: `${r.channel}|${r.market ?? ''}`,
      label: channelMarketWords(r.channel, r.market),
      what: r.what,
      href: inboxHref({ channel: r.channel, market: r.market }),
      ratingKind: r.ratingKind,
      rating: r.rating,
      noAmazonData: amazon && r.rating == null,
      reviews: amazon && r.rating == null && r.reviews === 0 ? '—' : count(r.reviews),
      change: changeView(r.change, r.ratingKind),
      sent: r.sent == null ? '—' : count(r.sent),
      sentNote: etsy ? 'Etsy asks buyers itself' : !amazon && (r.sent ?? 0) > 0 ? 'by email' : null,
      rate: rateText(r.rate),
      state: r.state,
      last: r.state === 'ok' ? lastWords(r.lastReviewAt, now) : 'Not updating',
      lastNote: r.state === 'ok' ? r.lastNote : null,
      reason: r.reason,
      reconnectHref: r.reconnectHref,
      sample: false,
    }
  })
  return withSample && !rows.some(r => r.channel === 'ETSY') ? [...out, ETSY_SAMPLE_ROW] : out
}

/** The card's warning: "eBay Germany behind", "2 channels behind"; none → null. */
export function behindWords(rows: readonly ChannelViewRow[]): string | null {
  const behind = rows.filter(r => r.state === 'not_updating')
  if (behind.length === 0) return null
  return behind.length === 1 ? `${behind[0].label} behind` : `${behind.length} channels behind`
}

// ── Needs you ────────────────────────────────────────────────────────

export const NEEDS_WORDS: Record<NeedsFilter, string> = {
  reply: 'Needs a reply',
  requests: 'Requests: problems',
  alerts: 'Open alerts',
}

/** How many to ask for: five with no filter (the board), eight for one kind. */
export function needsLimit(show: NeedsFilter | null): number {
  return show ? 8 : 5
}

/** With a filter tile on, `total` counts that kind only: none of it is not "nothing waits" (other kinds may). */
export function needsSubtitle(shown: number, total: number, show: NeedsFilter | null): string {
  if (total === 0) return show ? 'Nothing of this kind waits for you' : 'Nothing waits for you'
  if (show) return `${count(shown)} shown, most urgent first`
  return `${count(total)} ${total === 1 ? 'thing' : 'things'}, most urgent first`
}

/** "Showing 5 of 8", "Showing 3 of 12 reviews that need a reply", "Showing all 4". */
export function needsFooter(shown: number, total: number, show: NeedsFilter | null): string {
  if (shown >= total) return shown === 0 ? '' : `Showing all ${count(shown)}`
  return show === 'reply' ? `Showing ${count(shown)} of ${count(total)} reviews that need a reply` : `Showing ${count(shown)} of ${count(total)}`
}

export function needsEmptyWords(show: NeedsFilter | null): { title: string; description: string } {
  if (show === 'reply') return { title: 'No review needs a reply', description: 'New reviews that need a reply show here as they arrive.' }
  if (show === 'alerts') return { title: 'No open alerts', description: 'An alert opens when complaints about one theme rise fast.' }
  if (show === 'requests') return { title: 'No request problems', description: 'Failed review requests and requests waiting to try again show here.' }
  return { title: 'Nothing needs you', description: 'No review waits for a reply, no alert is open and no review request failed.' }
}

function text(params: Record<string, string | number>, key: string): string | null {
  const v = params[key]
  return v == null || v === '' ? null : String(v)
}

/** Where an item's action goes — through the one link module, so it always names a page that exists today. */
export function needsActionHref(action: NeedsYouItem['action']): string {
  const p = action.params ?? {}
  switch (action.page) {
    case 'review':
      // Reply: the Inbox, with that review's pop-up open.
      return inboxHref({ channel: text(p, 'channel'), market: text(p, 'market'), status: text(p, 'status'), review: text(p, 'id') } satisfies InboxLinkParams)
    case 'inbox':
      return inboxHref({ channel: text(p, 'channel'), market: text(p, 'market'), status: text(p, 'status') } satisfies InboxLinkParams)
    case 'requests':
      return requestsHref({ status: text(p, 'status'), channel: text(p, 'channel'), market: text(p, 'market') })
    case 'alerts':
      return insightsHref('alerts', { channel: text(p, 'channel'), market: text(p, 'market') })
  }
}

/** A reply is a change: it needs "Manage reviews". Opening a page does not. */
export function needsActionHeld(item: NeedsYouItem, canManage: boolean): string | null {
  return !canManage && item.kind === 'review' ? "You need 'Manage reviews' to reply to reviews." : null
}

// ── Themes ───────────────────────────────────────────────────────────

/** "34% of positive reviews · 212 mentions · −0.6 stars". */
export function themeCountWords(t: OverviewTheme): string {
  const of = t.shareOf === 'positive' ? 'positive reviews' : t.shareOf === 'negative' ? 'negative reviews' : 'Amazon reviews'
  const parts = [
    t.share != null ? `${t.share}% of ${of}` : null,
    `${count(t.mentions)} ${t.mentions === 1 ? 'mention' : 'mentions'}`,
    t.impact != null && Math.abs(t.impact) >= 0.1 ? `${signed(t.impact)} ${Math.abs(t.impact) === 1 ? 'star' : 'stars'}` : null,
  ]
  return parts.filter(Boolean).join(' · ')
}

/** A review theme opens the Inbox on that theme; an Amazon topic opens the themes page (the Inbox has no topic filter). */
export function themeHref(t: OverviewTheme, period: OverviewPeriod): string {
  return t.source === 'review' ? inboxHref({ theme: t.key, period }) : insightsHref('themes', { channel: 'AMAZON', market: t.market })
}

// ── Products to watch ────────────────────────────────────────────────

export interface WatchView {
  id: string
  name: string
  href: string
  reviews: string
  where: string
  now: string
  before: string
  change: string
  theme: string | null
  spark: Array<number | null>
  sparkLabel: string
  tooFew: boolean
  kind: RatingKind
}

export const TOO_FEW_WORDS = 'Too few to trend'

export function watchView(row: OverviewWatchRow): WatchView {
  const positive = row.kind === 'positive'
  return {
    id: `${row.productId}|${row.channel}|${row.market ?? ''}`,
    name: row.name,
    href: productReviewsHref(row.productId),
    reviews: `${count(row.reviews)} ${positive ? 'feedback' : row.reviews === 1 ? 'review' : 'reviews'} in this period`,
    where: row.where,
    now: ratingText(row.kind, row.ratingNow),
    before: `was ${ratingText(row.kind, row.ratingBefore)}`,
    change: changeView(row.change, row.kind).text,
    theme: row.topTheme,
    spark: row.spark,
    sparkLabel: positive ? 'Positive feedback, 6 weeks' : 'Average rating, 6 weeks',
    tooFew: row.tooFew,
    kind: row.kind,
  }
}

export function watchEmptyWords(period: OverviewPeriod): { title: string; description: string } {
  return { title: 'No product lost rating', description: `No product with at least three ratings in the ${PERIOD_WORDS[period].label} and in ${PERIOD_WORDS[period].prev} rated lower.` }
}

// ── Setup banner ─────────────────────────────────────────────────────

/** The problems still to show: one a viewer hid stays hidden until its fingerprint changes. */
export function visibleSetup(problems: readonly SetupProblem[], hidden: ReadonlySet<string>): SetupProblem[] {
  return problems.filter(p => !hidden.has(p.fingerprint))
}

/** Words of a removable scope chip: "Only eBay Italy". */
export function scopeWords(channel: string | null, market: string | null): string | null {
  if (!channel && !market) return null
  return `Only ${channel ? channelMarketWords(channel, market) : market}`
}

/** Link to the Inbox for a period (the "New reviews" tile). */
export function newReviewsHref(period: OverviewPeriod, channel: string | null, market: string | null): string {
  return inboxHref({ period, channel, market })
}
