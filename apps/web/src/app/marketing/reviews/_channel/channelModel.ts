/**
 * Reviews › channel pages (Amazon, eBay — build spec §3.5, PR F) — what the page shows, in words, from
 * GET /api/reviews/area/channel: the period (kept in the address), the tiles, Amazon's topics and requests by Amazon's
 * answer, products to watch, eBay's detailed seller ratings and feedback by type, the feedback list's type filter and
 * search, why a reply is held, the market tabs and the channel's own sites. Every link goes through `_lib/reviewsLinks.ts`
 * with the page's lock (`?channel=&market=`).
 *
 * Amazon (ruling 5): no live Amazon rating, average or count anywhere — stars only "from imported reviews", or "No rating
 * data from Amazon — import reviews". eBay replies: 500 characters, one per feedback (`@nexus/shared/review-reply-rules`).
 * Pure (no React), tested in channelModel.vitest.test.ts.
 */
import { channelSiteDomain, reviewReplyRules } from '@nexus/shared/review-reply-rules'
import { inboxHref, insightsHref, needsReplyHref, requestsHref } from '../_lib/reviewsLinks'
import { NOT_MEASURABLE, rateNotMeasurable } from '../_lib/reviewWords'
import type { InboxRow } from '../inbox/inboxDatasource'
import type { BuyersToRate, EbayRevisions, EbayTopics } from './ebayToolsModel'
import { channelPath, lockParams, marketWord, scopeTitleWords, type ReviewsChannel, type ReviewsLock } from './reviewsScope'
import { sellerFeedbackTile, type AmazonSellerFeedback } from './sellerFeedbackModel'

// ── The address: the period ──────────────────────────────────────────

export type ChannelPeriod = '7d' | '30d' | '90d' | '12m'

/** The periods each page offers (as the boards draw them): Amazon by weeks, eBay up to eBay's own 12 months. */
export const CHANNEL_PERIODS: Record<ReviewsChannel, readonly ChannelPeriod[]> = {
  AMAZON: ['7d', '30d', '90d'],
  EBAY: ['30d', '90d', '12m'],
}
export const DEFAULT_CHANNEL_PERIOD: Record<ReviewsChannel, ChannelPeriod> = { AMAZON: '30d', EBAY: '12m' }

const PERIOD_WORDS: Record<ChannelPeriod, { label: string; short: string }> = {
  '7d': { label: 'last 7 days', short: '7 days' },
  '30d': { label: 'last 30 days', short: '30 days' },
  '90d': { label: 'last 90 days', short: '90 days' },
  '12m': { label: 'last 12 months', short: '12 months' },
}

export function periodLabel(period: ChannelPeriod): string {
  return PERIOD_WORDS[period].label
}

/** The header control's options. */
export function periodOptions(channel: ReviewsChannel): Array<{ value: ChannelPeriod; label: string }> {
  return CHANNEL_PERIODS[channel].map((value) => ({ value, label: PERIOD_WORDS[value].short }))
}

/** `?period=` → one of the page's periods; anything else (missing, misspelt, another page's) is the page's default. */
export function parseChannelPeriod(channel: ReviewsChannel, search: string): ChannelPeriod {
  const raw = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('period')?.trim().toLowerCase() ?? ''
  return (CHANNEL_PERIODS[channel] as readonly string[]).includes(raw) ? (raw as ChannelPeriod) : DEFAULT_CHANNEL_PERIOD[channel]
}

/** The query string for a period: empty for the page's default (the address leaves it out). */
export function periodSearch(channel: ReviewsChannel, period: ChannelPeriod): string {
  return period === DEFAULT_CHANNEL_PERIOD[channel] ? '' : `?period=${period}`
}

// ── The answer (GET /api/reviews/area/channel) ───────────────────────

export type Section<T> = { ok: true; data: T } | { ok: false; error: string }

export function sectionData<T>(section: Section<T> | null | undefined): T | null {
  return section && section.ok ? section.data : null
}
export function sectionError<T>(section: Section<T> | null | undefined): string | null {
  return section && !section.ok ? section.error : null
}

export interface ChannelMarket { code: string; label: string }
export type TrendBucket = 'day' | 'week' | 'month'
export interface TrendPoint { day: string; reviews: number; avg: number | null }

export interface AmazonTiles {
  importedRating: number | null
  importedInPeriod: number
  importedTotal: number
  lastImportAt: string | null
  topicsToFix: number | null
  topicsWeekOf: string | null
  needReply: number
  oldestWaitDays: number | null
  requestsSent: number
  reviewRate: number | null
  /** "Not measurable: …" when no review can follow these requests (the API's one rate). */
  rateWords?: string | null
  /** Amazon seller feedback (1–3 stars) of the last 90 days and the 90 days before (PR H). */
  sellerFeedback90: number
  sellerFeedbackPrev90: number
  sellerFeedbackOn: boolean
}

export interface AmazonTopic {
  key: string
  label: string
  share: number | null
  mentions: number
  quote: string | null
  impact: number | null
  market: string | null
  trend: null
}

export type TopicsState = 'ok' | 'role_missing' | 'not_on_market' | 'none'

export interface AmazonTopics {
  state: TopicsState
  words: string | null
  where: string
  weekOf: string | null
  productCount: number
  like: AmazonTopic[]
  dislike: AmazonTopic[]
  products: Array<{ key: string; name: string; like: AmazonTopic[]; dislike: AmazonTopic[] }>
}

export interface AmazonRequests {
  sent: number
  tooEarly: number
  alreadyAsked: number
  notAllowed: number
  failed: number
  skipped: number
  waiting: number
  reviewRate: number | null
  /** "Not measurable: …" when no review can follow these requests (the API's one rate). */
  rateWords?: string | null
}

export interface AmazonWatchRow {
  productId: string
  name: string
  sku: string | null
  ratingNow: number | null
  ratingBefore: number | null
  change: number | null
  imported: number
  topTopic: string | null
  topShare: number | null
  topMentions: number | null
}

export interface AmazonSections {
  tiles: Section<AmazonTiles>
  trend: Section<{ bucket: TrendBucket; points: TrendPoint[] }>
  spread: Section<{ counts: [number, number, number, number, number]; average: number | null; rated: number; lastImportAt: string | null }>
  topics: Section<AmazonTopics>
  requests: Section<AmazonRequests>
  watch: Section<AmazonWatchRow[]>
  sellerFeedback: Section<AmazonSellerFeedback>
}

export interface EbayReadState {
  channel: 'EBAY'
  market: string | null
  label: string
  ok: boolean
  reason: string | null
  since: string | null
  reconnectHref: string | null
}

export interface EbayTiles {
  positive: number
  neutral: number
  negative: number
  score: number | null
  positivePct: number | null
  positiveFrom: 'ebay' | 'nexus'
  needReply: number
  oldestWaitDays: number | null
  /** PR G — the "Leave feedback for buyers" queue's counts; null when it could not be read. */
  buyersToRate: BuyersToRate | null
}

export interface EbayPeriodCounts { days: number; positive: number; neutral: number; negative: number }
export interface EbayDetailedRating { key: string; label: string; rating: number | null; count: number }

export interface EbaySummary {
  state: 'read' | 'partial' | 'not_read' | 'no_account'
  words: string | null
  readAt: string | null
  accountWide: boolean
  accounts: number
  score: number | null
  periods: EbayPeriodCounts[]
  dsr: EbayDetailedRating[]
  dsrPeriod: 'FiftyTwoWeeks' | 'ThirtyDays' | null
}

export interface EbaySections {
  readState: Section<EbayReadState[]>
  tiles: Section<EbayTiles>
  summary: Section<EbaySummary>
  feedback: Section<{ rows: InboxRow[]; total: number; owners: string[] }>
  /** PR G — eBay's AI topics of the feedback in scope (an older answer has none). */
  topics?: Section<EbayTopics>
  /** PR G — revision requests and eBay's yearly allowance (an older answer has none). */
  revisions?: Section<EbayRevisions>
}

export interface ChannelResponse<S> {
  channel: ReviewsChannel
  market: string | null
  label: string
  period: { key: ChannelPeriod; from: string | null; to: string }
  generatedAt: string
  markets: ChannelMarket[]
  sections: S
}

// ── Numbers in words ─────────────────────────────────────────────────

const MINUS = '−'

export function count(n: number): string {
  return n.toLocaleString('en')
}

export function plural(n: number, one: string, many: string): string {
  return `${count(n)} ${n === 1 ? one : many}`
}

/** "+0.2", "−0.3", "0.0". */
export function signed(n: number, digits = 1): string {
  const fixed = Math.abs(n).toFixed(digits)
  if (Number(fixed) === 0) return (0).toFixed(digits)
  return `${n > 0 ? '+' : MINUS}${fixed}`
}

/** "24 Oct" (UTC: the API's dates are days). */
export function dayMonth(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

/** "oldest waits 2 days", "nothing waits". */
export function waitWords(days: number | null): string {
  if (days == null) return 'nothing waits'
  if (days < 1) return 'oldest waits less than a day'
  return `oldest waits ${days} ${days === 1 ? 'day' : 'days'}`
}

/** "8.9%", "—". */
export function percent(n: number | null): string {
  return n == null ? '—' : `${n.toFixed(1)}%`
}

// ── Links with the lock ──────────────────────────────────────────────

/** The Inbox, Requests and Insights links of a page: each carries its channel (and market). */
export function lockedLinks(lock: ReviewsLock, period: ChannelPeriod) {
  const scope = lockParams(lock)
  return {
    inbox: (more: Parameters<typeof inboxHref>[0] = {}) => inboxHref({ ...scope, period, ...more }),
    /** The reviews of this page that need a reply, every date (the tile's own number). */
    needsReply: () => needsReplyHref(scope),
    requests: (more: Parameters<typeof requestsHref>[0] = {}) => requestsHref({ ...scope, period, ...more }),
    insights: (page: Parameters<typeof insightsHref>[0], more: Parameters<typeof insightsHref>[1] = {}) => insightsHref(page, { ...scope, period, ...more }),
  }
}

/** Seller Central for a market ("https://sellercentral.amazon.it"); every market → the European one. */
export function sellerCentralHref(market: string | null): string {
  if (!market) return 'https://sellercentral-europe.amazon.com'
  return `https://${(channelSiteDomain('AMAZON', market) ?? 'www.amazon.com').replace(/^www\./, 'sellercentral.')}`
}

/** Feedback Manager in Seller Central (seller feedback: ask for removal or reply there). */
export function feedbackManagerHref(market: string | null): string {
  return `${sellerCentralHref(market)}/feedback-manager/index.html`
}

/** eBay Seller Hub on a market's site (Italy's when the page is every market). */
export function sellerHubHref(market: string | null): string {
  return `https://${channelSiteDomain('EBAY', market ?? 'IT')}/sh/ovw`
}

// ── Header ───────────────────────────────────────────────────────────

/** Amazon's header line: products with topics · topics week · stars from imports · seller feedback fetched on request. */
export function amazonSubtitle(tiles: AmazonTiles | null, topics: AmazonTopics | null): string {
  const parts: string[] = []
  if (topics && topics.state === 'ok') parts.push(`${plural(topics.productCount, 'product', 'products')} with Amazon topics`)
  if (topics?.weekOf) parts.push(`topics weekly, week of ${dayMonth(topics.weekOf)}`)
  else if (topics?.state === 'not_on_market') parts.push('no Amazon topics on this market')
  if (tiles) parts.push(tiles.lastImportAt ? `stars from reviews imported ${dayMonth(tiles.lastImportAt)}` : 'no reviews imported yet')
  parts.push('seller feedback fetched on request')
  return parts.join(' · ')
}

/** eBay's header line: where it reads, and whether every market is read. */
export function ebaySubtitle(lock: ReviewsLock, readState: readonly EbayReadState[] | null, summary: EbaySummary | null): string {
  const where = lock.marketplace ? scopeTitleWords(lock) : 'every eBay market'
  const behind = (readState ?? []).filter((r) => !r.ok).map((r) => r.label)
  const parts = [`Seller feedback on ${where}`, behind.length ? `${behind.join(', ')} not read` : 'read every 30 min']
  if (summary?.readAt) parts.push(`eBay’s summary read ${timeWords(summary.readAt)}`)
  return parts.join(' · ')
}

/** "10:42" today, else "24 Oct". */
export function timeWords(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

// ── Tiles ────────────────────────────────────────────────────────────

export interface TileView {
  key: string
  label: string
  value: string
  hint: string
  href?: string
  accent?: string
}

/** Amazon's six tiles (the board): rating from imports, topics to fix, 1–3 star feedback, reply, requests, rate. */
export function amazonTiles(t: AmazonTiles, lock: ReviewsLock, period: ChannelPeriod): TileView[] {
  const links = lockedLinks(lock, period)
  return [
    {
      key: 'rating',
      label: 'Rating · imported',
      value: t.importedRating == null ? '—' : t.importedRating.toFixed(1),
      hint: t.importedRating == null
        ? (t.importedTotal > 0 ? `No imported review in the ${periodLabel(period)}` : 'No rating data from Amazon — import reviews')
        : `${plural(t.importedInPeriod, 'review', 'reviews')}${t.lastImportAt ? `, file of ${dayMonth(t.lastImportAt)}` : ''}`,
      href: links.insights('products', { sort: 'rating' }),
    },
    {
      key: 'topics',
      label: 'Topics to fix',
      value: t.topicsToFix == null ? '—' : count(t.topicsToFix),
      hint: t.topicsToFix == null ? 'No Amazon topics here' : `Amazon topics${t.topicsWeekOf ? `, week of ${dayMonth(t.topicsWeekOf)}` : ''}`,
      href: links.insights('themes'),
    },
    {
      key: 'seller',
      label: '1–3 star feedback',
      ...sellerFeedbackTile(t),
      href: links.inbox({ kind: 'seller', period: '90d' }),
    },
    {
      key: 'reply',
      label: 'Needs a reply',
      value: count(t.needReply),
      hint: waitWords(t.oldestWaitDays),
      // The one needs-a-reply rule, every date: the Inbox shows this same number (audit A4).
      href: links.needsReply(),
      accent: t.needReply > 0 ? 'var(--nds-danger)' : undefined,
    },
    { key: 'sent', label: 'Requests sent', value: count(t.requestsSent), hint: periodLabel(period), href: links.requests({ status: 'SENT' }) },
    {
      key: 'rate',
      label: 'Review rate',
      value: rateNotMeasurable(t.reviewRate, t.rateWords) ? NOT_MEASURABLE : percent(t.reviewRate),
      hint: t.rateWords ?? (t.reviewRate == null ? 'nothing sent in this period' : 'estimate, from imported reviews'),
      href: links.requests(),
    },
  ]
}

/** eBay's six tiles: score, % positive, neutral, negative, reply, buyers to rate (the leave-feedback queue). */
export function ebayTiles(t: EbayTiles, summary: EbaySummary | null, lock: ReviewsLock, period: ChannelPeriod): TileView[] {
  const links = lockedLinks(lock, period)
  const wide = summary?.accountWide ? 'whole eBay account' : 'eBay’s number'
  return [
    { key: 'score', label: 'Feedback score', value: t.score == null ? '—' : count(t.score), hint: t.score == null ? 'eBay was not read' : wide },
    {
      key: 'positive',
      label: 'Positive',
      value: percent(t.positivePct),
      hint: t.positiveFrom === 'ebay' ? 'last 12 months, eBay’s counts' : `${periodLabel(period)}, feedback Nexus read`,
    },
    { key: 'neutral', label: 'Neutral', value: count(t.neutral), hint: periodLabel(period), href: links.inbox({ kind: 'seller', stars: [3] }) },
    {
      key: 'negative',
      label: 'Negative',
      value: count(t.negative),
      hint: periodLabel(period),
      href: links.inbox({ kind: 'seller', stars: [1, 2] }),
      accent: t.negative > 0 ? 'var(--nds-danger)' : undefined,
    },
    {
      key: 'reply',
      label: 'Needs a reply',
      value: count(t.needReply),
      hint: waitWords(t.oldestWaitDays),
      href: links.needsReply(),
      accent: t.needReply > 0 ? 'var(--nds-danger)' : undefined,
    },
    { key: 'buyers', label: 'Buyers to rate', ...buyersTile(t.buyersToRate) },
  ]
}

/**
 * "Buyers to rate": the sales eBay lists as waiting for the seller's feedback, from the queue of "Leave feedback for
 * buyers" below. No number when eBay's list was never read; an old number says so when Nexus does not read eBay now.
 */
export function buyersTile(b: BuyersToRate | null | undefined): Pick<TileView, 'value' | 'hint'> {
  if (!b) return { value: '—', hint: 'The list could not be read' }
  if (!b.readAt) return { value: '—', hint: b.reading ? 'eBay’s list not read yet' : 'Nexus does not read eBay here' }
  if (!b.reading) return { value: count(b.awaiting), hint: `as read ${dayMonth(b.readAt)} · eBay not read now` }
  if (b.awaiting === 0) return { value: '0', hint: 'No sale waits for your feedback' }
  const parts = [
    b.ready > 0 ? `${count(b.ready)} ready to send` : null,
    b.waitingApproval > 0 ? `${count(b.waitingApproval)} waiting for approval` : null,
  ].filter((p): p is string => p != null)
  return { value: count(b.awaiting), hint: parts.length > 0 ? parts.join(' · ') : 'All held · the list below says why' }
}

// ── Amazon: requests, topics, products to watch ─────────────────────

export interface RequestRow { key: string; label: string; value: string; note: string; tone: 'success' | 'warning' | 'neutral' | 'danger' | 'info' }

/** "Asking for reviews": requests by Amazon's answer, then the review rate (an estimate). */
export function requestRows(r: AmazonRequests): RequestRow[] {
  return [
    { key: 'sent', label: 'Sent — Amazon accepted', value: count(r.sent), note: 'Amazon sends its own email, in the buyer’s language', tone: 'success' },
    { key: 'early', label: 'Too early — tried again daily', value: count(r.tooEarly), note: 'Amazon’s 5–30 day window has not opened yet; stops at day 30', tone: 'warning' },
    { key: 'asked', label: 'Already asked', value: count(r.alreadyAsked), note: 'Asked before, from Seller Central or by Nexus — one request per order', tone: 'neutral' },
    { key: 'refused', label: 'Not allowed', value: count(r.notAllowed), note: 'Amazon’s day 30 passed — too late to ask', tone: 'neutral' },
    // The same requests as Requests › Failed and the Overview's "failed" (live audit B01).
    { key: 'failed', label: 'Failed', value: count(r.failed), note: 'No try left: Amazon refused or did not answer — Requests says which', tone: 'danger' },
    { key: 'skipped', label: 'Skipped', value: count(r.skipped), note: 'Left out by a rule or a person (refunded, returned, cancelled …)', tone: 'neutral' },
    { key: 'waiting', label: 'Waiting', value: count(r.waiting), note: 'Waiting for the first try, or for Nexus to try again', tone: 'info' },
    {
      key: 'rate',
      label: 'Review rate',
      value: rateNotMeasurable(r.reviewRate, r.rateWords) ? NOT_MEASURABLE : percent(r.reviewRate),
      note: r.rateWords ?? (r.reviewRate == null ? 'Nothing sent in this period' : 'Reviews that followed ÷ requests sent · an estimate: Amazon gives no review count'),
      tone: 'info',
    },
  ]
}

export interface TopicView { key: string; label: string; quote: string | null; mentions: string; share: string; impact: string; impactTone: 'up' | 'down' | 'flat'; trend: string }

/** One topic row: mentions, share of reviews, star effect (±), its English snippet; the 6-month trend comes later. */
export function topicView(t: AmazonTopic): TopicView {
  const impact = t.impact == null ? '—' : `${signed(t.impact)} stars`
  return {
    key: t.key,
    label: t.label,
    quote: t.quote,
    mentions: plural(t.mentions, 'mention', 'mentions'),
    share: t.share == null ? '' : `${t.share}% of reviews`,
    impact,
    impactTone: t.impact == null || Math.abs(t.impact) < 0.05 ? 'flat' : t.impact > 0 ? 'up' : 'down',
    trend: '6-month trend: coming later',
  }
}

export const ALL_PRODUCTS = 'all'

/** The topics card's product picker: "All 12 products", then each product. */
export function topicProductOptions(topics: AmazonTopics): Array<{ value: string; label: string }> {
  return [
    { value: ALL_PRODUCTS, label: topics.productCount === 1 ? 'The 1 product' : `All ${count(topics.productCount)} products` },
    ...topics.products.map((p) => ({ value: p.key, label: p.name })),
  ]
}

/** The like / dislike columns for the picked product (or all products), at most `limit` each. */
export function topicColumns(topics: AmazonTopics, product: string, limit = 5): { like: TopicView[]; dislike: TopicView[] } {
  const picked = product === ALL_PRODUCTS ? topics : topics.products.find((p) => p.key === product) ?? topics
  return { like: picked.like.slice(0, limit).map(topicView), dislike: picked.dislike.slice(0, limit).map(topicView) }
}

export interface WatchView {
  id: string
  productId: string
  name: string
  sub: string
  hasRating: boolean
  rating: number | null
  ratingText: string
  change: string
  changeTone: 'up' | 'down' | 'flat'
  imported: string
  topic: string
  topicSub: string
}

export const NO_RATING_WORDS = 'No rating data from Amazon — import reviews'

/** A product to watch, in words: stars only from imports; a topic-only product says how to get a rating. */
export function watchView(row: AmazonWatchRow): WatchView {
  return {
    id: row.productId,
    productId: row.productId,
    name: row.name,
    sub: row.sku ?? '',
    hasRating: row.ratingNow != null,
    rating: row.ratingNow,
    ratingText: row.ratingNow == null ? NO_RATING_WORDS : row.ratingNow.toFixed(1),
    change: row.change == null ? '—' : signed(row.change),
    changeTone: row.change == null || Math.abs(row.change) < 0.05 ? 'flat' : row.change > 0 ? 'up' : 'down',
    imported: count(row.imported),
    topic: row.topTopic ?? 'No topics yet',
    topicSub: row.topTopic
      ? [row.topShare != null ? `${row.topShare}% of reviews` : null, row.topMentions != null ? plural(row.topMentions, 'mention', 'mentions') : null].filter(Boolean).join(' · ')
      : 'Amazon needs more reviews',
  }
}

// ── eBay: summary, ratings, by type, the list ────────────────────────

/** Words under eBay's summary cards: whose numbers they are and when eBay was asked. Null when there is nothing to add. */
export function summaryNote(summary: EbaySummary, lock: ReviewsLock): string | null {
  const parts: string[] = []
  if (summary.accountWide && lock.marketplace) parts.push(`eBay counts feedback per account: these are the whole account’s numbers, not ${marketWord(lock.marketplace)}’s alone.`)
  if (summary.readAt) parts.push(`eBay is asked at most once an hour; last asked ${timeWords(summary.readAt)}.`)
  return parts.length ? parts.join(' ') : null
}

/** The four detailed seller ratings, in eBay's order, with their counts. */
export function dsrRows(summary: EbaySummary): Array<{ key: string; label: string; rating: number | null; value: string; count: string }> {
  return summary.dsr.map((d) => ({
    key: d.key,
    label: d.label,
    rating: d.rating,
    value: d.rating == null ? '—' : d.rating.toFixed(1),
    count: d.count > 0 ? plural(d.count, 'rating', 'ratings') : 'No ratings',
  }))
}

/** "Last 30 days", "Last 6 months", "Last 12 months", "Last 45 days". */
export function periodDaysWords(days: number): string {
  if (days === 365) return 'Last 12 months'
  if (days >= 28 && days % 30 === 0 && days > 30) return `Last ${days / 30} months`
  return `Last ${days} days`
}

export interface TypeChartRow { when: string; positive: number; neutral: number; negative: number; pct: number | null; [key: string]: number | string | null }

/** Feedback by type per eBay period (stacked bars) with eBay's % positive (the line). */
export function typeChartRows(summary: EbaySummary): TypeChartRow[] {
  return summary.periods.map((p) => {
    const counted = p.positive + p.negative
    return {
      when: periodDaysWords(p.days),
      positive: p.positive,
      neutral: p.neutral,
      negative: p.negative,
      pct: counted > 0 ? Math.round((p.positive / counted) * 1000) / 10 : null,
    }
  })
}

/** The same chart in words, for a screen reader. */
export function typeChartWords(rows: readonly TypeChartRow[]): string {
  if (rows.length === 0) return 'eBay gave no feedback counts.'
  return rows.map((r) => `${r.when}: ${count(r.positive)} positive, ${count(r.neutral)} neutral, ${count(r.negative)} negative${r.pct == null ? '' : ` (${r.pct.toFixed(1)}% positive)`}`).join('; ') + '.'
}

export type FeedbackType = 'positive' | 'neutral' | 'negative'
export type FeedbackFilter = 'all' | FeedbackType

/** Stored eBay feedback: 5 positive, 3 neutral, 1 negative (4 counts as positive, 2 as negative). */
export function feedbackTypeOf(rating: number | null): FeedbackType | null {
  if (rating == null) return null
  return rating >= 4 ? 'positive' : rating <= 2 ? 'negative' : 'neutral'
}

export const TYPE_WORD: Record<FeedbackType, string> = { positive: 'Positive', neutral: 'Neutral', negative: 'Negative' }
export const TYPE_TONE: Record<FeedbackType, 'success' | 'neutral' | 'danger'> = { positive: 'success', neutral: 'neutral', negative: 'danger' }

/** The list's type control and search: case-blind over the text, its English, the buyer, the product and the order. */
export function filterFeedback(rows: readonly InboxRow[], type: FeedbackFilter, search: string): InboxRow[] {
  const q = search.trim().toLowerCase()
  return rows.filter((r) => {
    if (type !== 'all' && feedbackTypeOf(r.rating) !== type) return false
    if (!q) return true
    return [r.snippet, r.english, r.buyer, r.product?.name, r.product?.sku, r.order?.label].some((v) => (v ?? '').toLowerCase().includes(q))
  })
}

/** The type control's options, each with its count. */
export function typeOptions(rows: readonly InboxRow[]): Array<{ value: FeedbackFilter; label: string }> {
  const n = (t: FeedbackType) => rows.filter((r) => feedbackTypeOf(r.rating) === t).length
  return [
    { value: 'all', label: `All ${count(rows.length)}` },
    ...(['positive', 'neutral', 'negative'] as const).map((t) => ({ value: t, label: `${TYPE_WORD[t]} ${count(n(t))}` })),
  ]
}

/**
 * Why a row's Reply is held, or null: the market is not read (replies wait for a reconnect), the feedback came from a
 * file, eBay allows one reply and it went out — eBay's rules from `@nexus/shared/review-reply-rules`.
 */
export function replyHeld(row: InboxRow, readState: readonly EbayReadState[] | null, now: Date = new Date()): string | null {
  const behind = (readState ?? []).find((r) => !r.ok && r.market === row.market)
  if (behind) return `${behind.label} must be reconnected before a reply can be sent.`
  const rules = reviewReplyRules(row.channel, { kind: row.kind, marketplace: row.market, postedAt: row.postedAt, imported: row.imported, replied: row.responses.sent > 0 }, now)
  if (rules.held) return rules.held
  if (rules.mode !== 'send') return 'This feedback came from a file: reply on eBay itself.'
  return null
}

/** The reply column's note: "Replied", "Draft saved", "Needs a reply", "No reply needed". */
export function replyNote(row: InboxRow): string {
  if (row.responses.sent > 0 || row.status === 'RESPONDED') return 'Replied'
  if (row.responses.draft > 0) return 'Draft saved'
  if (row.status === 'NEW' || row.status === 'IN_PROGRESS') return row.overdue ? 'Overdue' : 'Needs a reply'
  return 'No reply needed'
}

// ── Market tabs ──────────────────────────────────────────────────────

export interface MarketTab { id: string; label: string; href: string; behind: boolean }

/** "All markets" then each market, as links (the page is the lock); a market not read says so. */
export function marketTabs(lock: ReviewsLock, markets: readonly ChannelMarket[], readState: readonly EbayReadState[] | null): MarketTab[] {
  const behind = new Set((readState ?? []).filter((r) => !r.ok && r.market).map((r) => r.market as string))
  const codes = [...markets.map((m) => m.code), ...(lock.marketplace && !markets.some((m) => m.code === lock.marketplace) ? [lock.marketplace] : [])]
  return [
    { id: 'all', label: 'All markets', href: channelPath({ channel: lock.channel, marketplace: '' }), behind: false },
    ...codes.map((code) => ({ id: code, label: marketWord(code), href: channelPath({ channel: lock.channel, marketplace: code }), behind: behind.has(code) })),
  ]
}
