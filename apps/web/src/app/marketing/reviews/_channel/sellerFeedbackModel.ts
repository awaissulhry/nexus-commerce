/**
 * Reviews › Amazon seller feedback (PR H, build spec B20 + ruling 5) — what the Amazon page's seller-feedback card, the
 * Settings › Sources row and the review pop-up show, in words, from the API: each market's fetch state, why "Fetch now"
 * is held, and the removal check per feedback. Amazon's report holds only feedback of 1 to 3 stars and Amazon cannot
 * schedule it, so Nexus asks for it (daily, and on "Fetch now"). Nexus never asks Amazon to remove feedback (no API for
 * it): the only actions are "Open Feedback Manager" (a new tab) and "Mark as responded" in Nexus. Pure; tested in
 * sellerFeedbackModel.vitest.test.ts.
 */
import { marketWord } from './reviewsScope'

// ── The answers ──────────────────────────────────────────────────────

export type FetchStateKind = 'never' | 'fetching' | 'ok' | 'failed'

export interface MarketFetchState {
  market: string
  state: FetchStateKind
  lastFetchAt: string | null
  lastOkAt: string | null
  rows: number | null
  words: string
}

/** GET /reviews/amazon/seller-feedback (and the Amazon page's `sellerFeedback.fetch`). */
export interface SellerFeedbackState {
  on: boolean
  every: string
  markets: MarketFetchState[]
  canFetch: boolean
  held: string | null
  fixHref: string | null
  fetching: boolean
  lastFetchAt: string | null
  lastOkAt: string | null
}

export type RemovalVerdict = 'may_qualify' | 'struck_through_not_removed' | 'does_not_qualify' | 'too_old'

export interface RemovalCheck {
  verdict: RemovalVerdict
  label: string
  tone: 'info' | 'success' | 'neutral' | 'warning'
  why: string
  words: string
  reasons: string[]
  ageDays: number
  daysLeft: number
}

export interface AmazonSellerFeedbackRow {
  id: string
  rating: number | null
  postedAt: string
  text: string
  english: string | null
  language: string | null
  amazonOrderId: string | null
  orderId: string | null
  fulfilmentWords: string | null
  status: string
  replied: boolean
  check: RemovalCheck
}

export interface AmazonSellerFeedback {
  fetch: SellerFeedbackState
  total90: number
  rows: AmazonSellerFeedbackRow[]
  rules: string[]
}

/** POST /reviews/amazon/seller-feedback/fetch → 202. */
export interface FetchNowAnswer {
  ok: true
  words: string
  state: SellerFeedbackState
}

/** The rules the removal check reads (the API sends the same list; this is the copy shown before any answer). */
export const REMOVAL_RULES: readonly string[] = [
  'You can ask Amazon to remove feedback that is obscene, contains personal details, or is entirely a product review — within 90 days, in Feedback Manager (per Amazon staff guidance).',
  'Complaints only about FBA delivery (or a late order you shipped on time with Buy Shipping) are struck through, not removed.',
  'Reply in Seller Central (Feedback Manager). Public, one reply, can’t be edited; if you delete it you can’t reply again.',
  'Nexus only checks. You ask in Feedback Manager, and Amazon decides.',
]

export const MANAGE_FETCH = 'You need ‘Manage reviews’ to fetch Amazon’s seller feedback.'

// ── Words ────────────────────────────────────────────────────────────

/** "25 Oct, 09:12" in this browser's time zone; '' for none. */
export function fetchTimeWords(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const day = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${day}, ${time}`
}

/** "25 Oct" (UTC: feedback dates are days). */
export function feedbackDay(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

/** The card's line under its title: what the report is, the last fetch and the count. */
export function feedbackCardLine(f: AmazonSellerFeedback): string {
  const parts = ['Amazon’s report holds only 1–3 star feedback and is fetched on request (it can’t be scheduled)']
  if (!f.fetch.on) parts.push('not fetched in this setup yet')
  else if (f.fetch.fetching) parts.push('fetching now')
  else if (f.fetch.lastFetchAt) parts.push(`last fetch ${fetchTimeWords(f.fetch.lastFetchAt)}`)
  else parts.push('not fetched yet')
  parts.push(`${f.total90.toLocaleString('en')} in the last 90 days`)
  return parts.join(' · ')
}

/** Why "Fetch now" cannot run, in words; null when it can. A missing permission is said first. */
export function fetchHeldWords(state: SellerFeedbackState | null, canManage: boolean): string | null {
  if (!canManage) return MANAGE_FETCH
  if (!state) return 'Nexus could not check the fetches just now. Try again in a moment.'
  return state.canFetch ? null : (state.held ?? 'Nexus cannot fetch the report just now.')
}

/** Markets whose last fetch failed, as one line ("Spain: Amazon refused …"); null when none failed. */
export function failedFetchWords(state: SellerFeedbackState): string | null {
  const failed = state.markets.filter((m) => m.state === 'failed')
  if (failed.length === 0) return null
  return failed.map((m) => `${marketWord(m.market)}: ${m.words}`).join(' ')
}

/** The Amazon tile: feedback of the last 90 days and the change against the 90 days before. */
export function sellerFeedbackTile(t: { sellerFeedback90: number; sellerFeedbackPrev90: number; sellerFeedbackOn: boolean }): { value: string; hint: string } {
  const diff = t.sellerFeedback90 - t.sellerFeedbackPrev90
  const change = diff === 0 ? 'same as the 90 days before' : `${diff > 0 ? '+' : '−'}${Math.abs(diff)} on the 90 days before`
  if (!t.sellerFeedbackOn && t.sellerFeedback90 === 0) return { value: '—', hint: 'Not fetched in this setup yet' }
  return { value: t.sellerFeedback90.toLocaleString('en'), hint: `last 90 days · ${change}` }
}

export interface FeedbackRowView {
  id: string
  stars: number | null
  day: string
  text: string
  /** The English text when it differs from the buyer's own words. */
  english: string | null
  who: string
  check: RemovalCheck
  status: string
}

/** One feedback as the card lists it. */
export function feedbackRowView(r: AmazonSellerFeedbackRow): FeedbackRowView {
  const who = ['A buyer', r.amazonOrderId ? `order ${r.amazonOrderId}` : null, r.fulfilmentWords, r.replied ? 'you replied' : null]
    .filter(Boolean)
    .join(' · ')
  const english = r.english && r.english.trim() && r.english.trim() !== r.text.trim() ? r.english.trim() : null
  return {
    id: r.id,
    stars: r.rating,
    day: feedbackDay(r.postedAt),
    text: r.text.trim() || 'No comment',
    english,
    who,
    check: r.check,
    status: r.status,
  }
}
