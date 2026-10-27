/**
 * Reviews › Etsy and Shopify pages (build spec §3.5, PR I) — what the two pages show, in words, from
 * GET /api/reviews/area/shop-channel?channel=ETSY|SHOPIFY: the header line, the tiles, each Etsy review's reply window
 * ("Day 2 of 100", "4 days left", "Closed" — 100 days from the buyer's LAST edit, `@nexus/shared/review-reply-rules`),
 * what a row's reply cell offers, the review app's state, and the ticked rows as a CSV file (the Export of the bulk bar,
 * ruling 7). Every link to the Inbox goes through `_lib/reviewsLinks.ts` with the page's channel.
 *
 * Etsy has no reply API: a reply is written and copied in the Inbox's reply box, posted on Etsy.com, then marked as
 * responded (Nexus records only what a person marks). Judge.me replies go out from the reply box (Nexus posts them).
 * Pure (no React), tested in shopChannelModel.vitest.test.ts.
 */
import { reviewReplyRules, ETSY_REPLY_WINDOW_DAYS } from '@nexus/shared/review-reply-rules'
import { inboxHref, needsReplyHref } from '../_lib/reviewsLinks'
import type { InboxRow } from '../inbox/inboxDatasource'
import { count, dayMonth, plural, type Section, type TileView } from './channelModel'

export type ShopChannel = 'ETSY' | 'SHOPIFY'

// ── The answer ───────────────────────────────────────────────────────

export interface WindowView { days: number; day: number; daysLeft: number; closed: boolean; endsAt: string }

export interface EtsyRow extends InboxRow {
  photoUrl: string | null
  /** The buyer's last edit (ISO): the 100 days count from it. */
  editedAt: string | null
  window: WindowView | null
}

export interface ShopifyRow extends InboxRow {
  /** The review's photos with their thumbnails; the Inbox row's `photos` is their count. */
  photoItems: Array<{ url: string; thumb: string }>
  hasVideo: boolean
  /** JUDGEME when read through Nexus's connection; null for a file import. */
  app: string | null
}

export interface ReviewList<R> { rows: R[]; total: number; owners: string[] }

export type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'info'

export interface EtsySource {
  state: 'ok' | 'waiting' | 'off' | 'not_connected' | 'needs_fix' | 'failed'
  stateWords: string
  tone: Tone
  words: string
  lastReadAt: string | null
  reviews: number
  reconnectHref: string | null
}

export interface EtsyTiles {
  average: number | null
  reviews: number
  newReviews: number
  newDelta: number | null
  withPhoto: number
  notReplied: number
  closing: number
  closed: number
}

export interface ShopifyTiles {
  average: number | null
  reviews: number
  newReviews: number
  newDelta: number | null
  withMedia: number
  videos: number
  needReply: number
  oldestWaitHours: number | null
}

export type ReviewAppKey = 'JUDGEME' | 'OKENDO' | 'YOTPO' | 'LOOX'

export interface ReviewAppView {
  app: ReviewAppKey
  name: string
  what: string
  state: 'connected' | 'waiting' | 'needs_fix' | 'disconnected' | 'not_connected' | 'later'
  stateWords: string
  tone: Tone
  words: string
  shopDomain: string | null
  connectedAt: string | null
  lastReadAt: string | null
  lastReadCount: number | null
  canReply: boolean
  connectable: boolean
}

export interface ShopifyApps { apps: ReviewAppView[]; readOn: boolean; lastImportAt: string | null; imported: number }

export interface EtsySections { source: Section<EtsySource>; tiles: Section<EtsyTiles>; reviews: Section<ReviewList<EtsyRow>> }
export interface ShopifySections { app: Section<ShopifyApps>; tiles: Section<ShopifyTiles>; reviews: Section<ReviewList<ShopifyRow>> }

export interface ShopChannelResponse<S> { channel: ShopChannel; label: string; generatedAt: string; sections: S }

// ── Words ────────────────────────────────────────────────────────────

/** "+3", "−2", "0". */
function signedCount(n: number): string {
  return n > 0 ? `+${count(n)}` : n < 0 ? `−${count(-n)}` : '0'
}

const average = (n: number | null) => (n == null ? '—' : n.toFixed(1))

/** Where Etsy's reviews are answered (the reply rules' own link). */
export const ETSY_REVIEWS_HREF = reviewReplyRules('ETSY').open?.href ?? 'https://www.etsy.com/your/shops/me/reviews'

/** The Etsy page's six tiles (the board): average, new, with a photo, not replied yet, window closing, window closed. */
export function etsyTileViews(t: EtsyTiles): TileView[] {
  // The one needs-a-reply list (open, inside Etsy's window, not imported): the Inbox shows this same number.
  const open = needsReplyHref({ channel: 'ETSY' })
  return [
    { key: 'average', label: 'Average rating', value: average(t.average), hint: plural(t.reviews, 'review', 'reviews') },
    {
      key: 'new', label: 'New reviews', value: count(t.newReviews),
      hint: `${t.newDelta == null ? '' : `${signedCount(t.newDelta)} · `}last 30 days`, href: inboxHref({ channel: 'ETSY', period: '30d' }),
    },
    { key: 'photo', label: 'With a photo', value: count(t.withPhoto), hint: 'one per review' },
    { key: 'open', label: 'Not replied yet', value: count(t.notReplied), hint: 'window still open', href: open, accent: t.notReplied > 0 ? 'var(--nds-warning)' : undefined },
    { key: 'closing', label: 'Window closing', value: count(t.closing), hint: '10 days or less left', href: open, accent: t.closing > 0 ? 'var(--nds-danger)' : undefined },
    { key: 'closed', label: 'Window closed', value: count(t.closed), hint: 'no reply possible' },
  ]
}

/** "6 h", "2 days". */
export function waitHoursWords(hours: number | null): string {
  if (hours == null) return 'nothing waits'
  if (hours < 1) return 'oldest less than an hour'
  if (hours < 48) return `oldest ${hours} h`
  return `oldest ${Math.floor(hours / 24)} days`
}

/** The Shopify page's four tiles (the board): average, new, with photo or video, needs a reply. */
export function shopifyTileViews(t: ShopifyTiles): TileView[] {
  return [
    { key: 'average', label: 'Average rating', value: average(t.average), hint: plural(t.reviews, 'review', 'reviews') },
    {
      key: 'new', label: 'New reviews', value: count(t.newReviews),
      hint: `${t.newDelta == null ? '' : `${signedCount(t.newDelta)} · `}last 30 days`, href: inboxHref({ channel: 'SHOPIFY', period: '30d' }),
    },
    { key: 'media', label: 'With photo or video', value: count(t.withMedia), hint: t.videos > 0 ? plural(t.videos, 'video', 'videos') : 'no videos' },
    {
      key: 'reply', label: 'Needs a reply', value: count(t.needReply), hint: waitHoursWords(t.oldestWaitHours),
      // The one needs-a-reply list (audit A4): the Inbox shows this same number.
      href: needsReplyHref({ channel: 'SHOPIFY' }), accent: t.needReply > 0 ? 'var(--nds-danger)' : undefined,
    },
  ]
}

// ── Etsy: the reply window ───────────────────────────────────────────

export interface WindowWords {
  /** "Day 2 of 100", "Closed". */
  label: string
  /** "98 days left", "4 days left", "closed 3 Feb". */
  note: string
  tone: 'neutral' | 'warning' | 'danger'
}

/** A row's reply window in words; "Replied" rows still show their window (the board). */
export function windowWords(w: WindowView | null): WindowWords {
  if (!w) return { label: 'No date', note: 'Etsy gave no date', tone: 'neutral' }
  if (w.closed) return { label: 'Closed', note: `closed ${dayMonth(w.endsAt)}`, tone: 'neutral' }
  return { label: `Day ${w.day} of ${w.days}`, note: `${plural(w.daysLeft, 'day', 'days')} left`, tone: w.daysLeft <= 10 ? 'danger' : 'neutral' }
}

/** A review counts as answered once a reply was recorded (sent or marked) or a person set Responded. */
export function isAnswered(row: Pick<InboxRow, 'status' | 'responses'>): boolean {
  return row.responses.sent > 0 || row.status === 'RESPONDED'
}

export interface ReplyCellView {
  /** Write a reply (the Inbox's reply box: copy, open Etsy, mark as responded) — or held, with why. */
  write: { href: string | null; held: string | null }
  /** "Replied 24 Oct", "Window open", "Closed". */
  note: string
}

const MANAGE_REPLY = 'You need ‘Manage reviews’ to reply to reviews.'

/** What the Etsy row's Reply cell offers. */
export function etsyReplyCell(row: EtsyRow, canManage: boolean): ReplyCellView {
  const href = inboxHref({ channel: 'ETSY', review: row.id })
  if (isAnswered(row)) return { write: { href, held: null }, note: 'Responded' }
  if (row.window?.closed) return { write: { href: null, held: `Etsy’s 100 days to reply ran out on ${dayMonth(row.window.endsAt)}: no reply is possible now.` }, note: 'Closed' }
  if (!canManage) return { write: { href: null, held: MANAGE_REPLY }, note: 'Needs a reply' }
  return { write: { href, held: null }, note: row.status === 'IGNORED' || row.status === 'RESOLVED' ? 'No reply needed' : 'Needs a reply' }
}

/** "last edit 24 Oct" (the board's line under each Etsy review). */
export function lastEditWords(row: Pick<EtsyRow, 'editedAt' | 'postedAt'>): string {
  return `last edit ${dayMonth(row.editedAt ?? row.postedAt)}`
}

// ── Shopify: the app and each row's reply ────────────────────────────

/** The review app the page is about (Judge.me today). */
export function judgeme(apps: ShopifyApps | null): ReviewAppView | null {
  return apps?.apps.find((a) => a.app === 'JUDGEME') ?? null
}

export function isAppConnected(app: ReviewAppView | null): boolean {
  return !!app && (app.state === 'connected' || app.state === 'waiting')
}

/** The Shopify row's reply note: who posts it. */
export function shopifyReplyNote(row: Pick<ShopifyRow, 'app' | 'status' | 'responses'>, appConnected: boolean): string {
  if (isAnswered(row)) return 'Responded'
  if (row.app === 'JUDGEME') return appConnected ? 'Reply from Nexus' : 'Judge.me not connected'
  return 'Copy and post in the app'
}

/** "3 photos · video", "1 photo", "". */
export function mediaWords(row: Pick<ShopifyRow, 'photoItems' | 'hasVideo'>): string {
  return [row.photoItems.length ? plural(row.photoItems.length, 'photo', 'photos') : null, row.hasVideo ? 'video in Judge.me' : null].filter(Boolean).join(' · ')
}

// ── Header lines ─────────────────────────────────────────────────────

/** "10:42" today, else "24 Oct". */
export function shortTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

export function etsySubtitle(source: EtsySource | null, tiles: EtsyTiles | null): string {
  const parts: string[] = []
  if (tiles) parts.push(plural(tiles.reviews, 'review', 'reviews'))
  if (source) parts.push(source.state === 'ok' ? `read every 30 min${source.lastReadAt ? `, last ${shortTime(source.lastReadAt)}` : ''}` : source.stateWords.toLowerCase())
  parts.push(`reply on Etsy.com within ${ETSY_REPLY_WINDOW_DAYS} days of the buyer’s last edit`)
  return parts.join(' · ')
}

export function shopifySubtitle(apps: ShopifyApps | null): string {
  const app = judgeme(apps)
  if (!app || !isAppConnected(app)) return 'Your store · Shopify keeps no reviews itself: they live in the store’s review app'
  return `Your store · Judge.me · ${app.lastReadAt ? `read every 30 min, last ${shortTime(app.lastReadAt)}` : app.stateWords.toLowerCase()}`
}

// ── Export (the bulk bar) ────────────────────────────────────────────

function csvCell(value: string | number | null | undefined): string {
  const text = value == null ? '' : String(value)
  // A cell a spreadsheet would run as a formula starts with ', so it stays text.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** The ticked reviews as a CSV file (UTF-8, one row each): what the grid shows, never a buyer's e-mail. */
export function reviewsCsv(channel: ShopChannel, rows: ReadonlyArray<EtsyRow | ShopifyRow>): string {
  const head = channel === 'ETSY'
    ? ['Posted', 'Last edit', 'Stars', 'Review', 'Buyer', 'Item', 'Order', 'Reply window', 'Status', 'Owner', 'Photo']
    : ['Posted', 'Stars', 'Title and review', 'Buyer', 'Product', 'Order', 'Photos', 'Video', 'Status', 'Owner']
  const lines = rows.map((r) => {
    const product = r.product ? `${r.product.name}${r.product.variant ? ` (${r.product.variant})` : ''}` : ''
    if (channel === 'ETSY') {
      const e = r as EtsyRow
      const w = windowWords(e.window)
      return [e.postedAt.slice(0, 10), (e.editedAt ?? e.postedAt).slice(0, 10), e.rating, e.snippet, e.buyer, product, e.order?.label, `${w.label} (${w.note})`, e.status, e.assignee, e.photoUrl]
    }
    const s = r as ShopifyRow
    return [s.postedAt.slice(0, 10), s.rating, s.snippet, s.buyer, product, s.order?.label, s.photoItems.map((p) => p.url).join(' '), s.hasVideo ? 'yes' : '', s.status, s.assignee]
  })
  return [head, ...lines].map((line) => line.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

/** "etsy-reviews-2026-10-27.csv". */
export function csvFileName(channel: ShopChannel, now: Date = new Date()): string {
  return `${channel.toLowerCase()}-reviews-${now.toISOString().slice(0, 10)}.csv`
}

// ── Connecting Judge.me ──────────────────────────────────────────────

/** The store address as the API takes it, or null (the form says why). */
export function shopDomainOf(raw: string): string | null {
  const host = raw.trim().toLowerCase().replace(/^https?:\/\//, '').split(/[/?#]/)[0]
  return /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/.test(host) ? host : null
}

/** Why Connect is held, or null: the permission first, then each field in order. */
export function connectHeld(input: { canManage: boolean; shopDomain: string; apiToken: string; busy: boolean }): string | null {
  if (!input.canManage) return 'You need ‘Manage reviews’ to connect a review app.'
  if (input.busy) return 'Connecting… this takes a moment.'
  if (!input.shopDomain.trim()) return 'Type the store’s Shopify address first.'
  if (!shopDomainOf(input.shopDomain)) return 'The store address ends in .myshopify.com (the Shopify address, not the shop’s own domain).'
  const token = input.apiToken.trim()
  if (!token) return 'Paste the private API token from Judge.me first.'
  if (!/^[\x21-\x7e]{8,200}$/.test(token)) return 'That does not look like a Judge.me API token: one word, at least 8 characters.'
  return null
}
