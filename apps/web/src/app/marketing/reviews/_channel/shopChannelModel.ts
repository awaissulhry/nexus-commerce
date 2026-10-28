/**
 * Reviews › Etsy and Shopify pages (build spec §3.5, PR I) — what the two pages show, in words, from
 * GET /api/reviews/area/shop-channel?channel=ETSY|SHOPIFY: the header line, the tiles, each Etsy review's reply window
 * ("Day 2 of 100", "4 days left", "Closed" — 100 days from the buyer's LAST edit, `@nexus/shared/review-reply-rules`),
 * what a row's reply cell offers, the review app's state, and the ticked rows as a CSV file (the Export of the bulk bar,
 * ruling 7). Every link to the Inbox goes through `_lib/reviewsLinks.ts` with the page's channel.
 *
 * Etsy has no reply API: a reply is written and copied in the Inbox's reply box, posted on Etsy.com, then marked as
 * responded (Nexus records only what a person marks). Judge.me and Okendo replies go out from the reply box (Nexus posts
 * them); Yotpo and Loox replies are posted in the app ("Reply in Yotpo"), then marked as responded.
 * Pure (no React), tested in shopChannelModel.vitest.test.ts.
 */
import { reviewReplyRules, ETSY_REPLY_WINDOW_DAYS } from '@nexus/shared/review-reply-rules'
import { etsyClosedHref, etsyClosingHref, inboxHref, needsReplyHref } from '../_lib/reviewsLinks'
import { STATUS_WORD } from '../_lib/reviewWords'
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
  /** The review app it was read from (JUDGEME, OKENDO, YOTPO, LOOX); null for a file import. */
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

/** One thing an app's connect window asks for (the API decides, per app). */
export interface ReviewAppField { key: string; label: string; hint: string; secret: boolean; placeholder: string | null }

/** `GET /api/reviews/apps` → one app (review-app-connection.service.ts `ReviewAppView`). Never a secret. */
export interface ReviewAppView {
  app: ReviewAppKey
  name: string
  what: string
  state: 'connected' | 'waiting' | 'needs_fix' | 'disconnected' | 'not_connected'
  stateWords: string
  tone: Tone
  words: string
  fields: ReviewAppField[]
  /** The plan the app's API needs, and what to do on another plan. */
  planWords: string
  /** What the app knows the store by (not a secret). */
  storeId: string | null
  storeWords: string | null
  connectedAt: string | null
  lastReadAt: string | null
  lastReadCount: number | null
  /** The app lets Nexus post replies (Judge.me, Okendo). */
  replies: boolean
  canReply: boolean
  /** Where a reply is posted by hand in the app; null for Judge.me. */
  replyHref: string | null
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
  // Each reply tile links to the Inbox rows it counts (the API counts with the Inbox's own query for the same address):
  // the one needs-a-reply list for Etsy (open, inside the window, not imported, not positive), of it the windows that
  // close within 10 days, and the reviews that needed a reply by the same rule but whose window ran out.
  const open = needsReplyHref({ channel: 'ETSY' })
  return [
    { key: 'average', label: 'Average rating', value: average(t.average), hint: plural(t.reviews, 'review', 'reviews') },
    {
      key: 'new', label: 'New reviews', value: count(t.newReviews),
      hint: `${t.newDelta == null ? '' : `${signedCount(t.newDelta)} · `}last 30 days`, href: inboxHref({ channel: 'ETSY', period: '30d' }),
    },
    { key: 'photo', label: 'With a photo', value: count(t.withPhoto), hint: 'one per review' },
    { key: 'open', label: 'Not replied yet', value: count(t.notReplied), hint: 'window still open', href: open, accent: t.notReplied > 0 ? 'var(--nds-warning)' : undefined },
    { key: 'closing', label: 'Window closing', value: count(t.closing), hint: '10 days or less left', href: etsyClosingHref(), accent: t.closing > 0 ? 'var(--nds-danger)' : undefined },
    { key: 'closed', label: 'Window closed', value: count(t.closed), hint: 'needed a reply, too late now', href: etsyClosedHref() },
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
  /** "Responded", "Window closed", "Needs a reply", "No reply needed: positive" (`replyNeedWords`). */
  note: string
  /** The line under the buttons: "Needs a reply · New · Anna", "Marked as responded". */
  sub: string
}

/**
 * Whether a review that has no reply yet needs one, by the API's one needs-a-reply rule (`noReply`, the same rule the
 * tiles and the Inbox's "Needs a reply" count): "Needs a reply" only when it says so.
 */
export function replyNeedWords(row: Pick<InboxRow, 'noReply'>): string {
  if (row.noReply == null) return 'Needs a reply'
  if (row.noReply === 'window_closed') return 'Window closed'
  if (row.noReply === 'positive') return 'No reply needed: positive'
  if (row.noReply === 'imported') return 'No reply needed: imported'
  return 'No reply needed'
}

const MANAGE_REPLY = 'You need ‘Manage reviews’ to reply to reviews.'

/** What the Etsy row's Reply cell offers, and says: "Needs a reply" only when the one rule says so. */
export function etsyReplyCell(row: EtsyRow, canManage: boolean): ReplyCellView {
  const href = inboxHref({ channel: 'ETSY', review: row.id })
  const who = row.assignee ? ` · ${row.assignee}` : ''
  if (isAnswered(row)) return { write: { href, held: null }, note: 'Responded', sub: `Marked as responded${who}` }
  const w = row.window
  const note = w?.closed ? 'Window closed' : replyNeedWords(row)
  const sub = `${note} · ${STATUS_WORD[row.status] ?? row.status}${who}`
  if (w?.closed) return { write: { href: null, held: `Etsy’s 100 days to reply ran out on ${dayMonth(w.endsAt)}: no reply is possible now.` }, note, sub }
  return { write: canManage ? { href, held: null } : { href: null, held: MANAGE_REPLY }, note, sub }
}

/** "last edit 24 Oct" (the board's line under each Etsy review). */
export function lastEditWords(row: Pick<EtsyRow, 'editedAt' | 'postedAt'>): string {
  return `last edit ${dayMonth(row.editedAt ?? row.postedAt)}`
}

// ── Shopify: the app and each row's reply ────────────────────────────

export function isAppConnected(app: Pick<ReviewAppView, 'state'> | null | undefined): boolean {
  return !!app && (app.state === 'connected' || app.state === 'waiting')
}

/** The apps a person connected (read, or waiting for their read), in the API's order. */
export function connectedApps(apps: ShopifyApps | null): ReviewAppView[] {
  return apps?.apps.filter(isAppConnected) ?? []
}

/** The apps that need a person: a key the app refused. */
export function appsNeedingFix(apps: ShopifyApps | null): ReviewAppView[] {
  return apps?.apps.filter((a) => a.state === 'needs_fix') ?? []
}

/** "Judge.me", "Judge.me and Okendo", "Judge.me, Okendo and Loox". */
export function namesWords(names: readonly string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

const APP_NAME: Record<string, string> = { JUDGEME: 'Judge.me', OKENDO: 'Okendo', YOTPO: 'Yotpo', LOOX: 'Loox' }

/** The review app's name for a row's `app` ("Okendo"), or null for a file import. */
export function appName(app: string | null | undefined): string | null {
  return app ? APP_NAME[app] ?? null : null
}

/** The Shopify row's reply note: who posts it, from the apps' states (`GET /api/reviews/apps`). */
export function shopifyReplyNote(row: Pick<ShopifyRow, 'app' | 'status' | 'responses' | 'noReply'>, apps: ReadonlyArray<Pick<ReviewAppView, 'app' | 'replies' | 'state'>>): string {
  if (isAnswered(row)) return 'Responded'
  // The one rule says no reply is needed (positive, imported, closed by a person): never "Reply from Nexus" or
  // "Reply in Yotpo" as if work were waiting.
  if (row.noReply != null) return replyNeedWords(row)
  const name = appName(row.app)
  if (!name) return 'Copy and post in the app'
  const app = apps.find((a) => a.app === row.app)
  if (app?.replies) return isAppConnected(app) ? 'Reply from Nexus' : `${name} not connected`
  return `Reply in ${name}`
}

/** "3 photos · video in Okendo", "1 photo", "". */
export function mediaWords(row: Pick<ShopifyRow, 'photoItems' | 'hasVideo' | 'app'>): string {
  return [
    row.photoItems.length ? plural(row.photoItems.length, 'photo', 'photos') : null,
    row.hasVideo ? `video in ${appName(row.app) ?? 'the review app'}` : null,
  ].filter(Boolean).join(' · ')
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
  const live = connectedApps(apps)
  if (live.length === 0) return 'Your store · Shopify keeps no reviews itself: they live in the store’s review app'
  const last = live.map((a) => a.lastReadAt).filter((x): x is string => !!x).sort().pop() ?? null
  return `Your store · ${namesWords(live.map((a) => a.name))} · ${last ? `read every 30 min, last ${shortTime(last)}` : live[0].stateWords.toLowerCase()}`
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

// ── Connecting a review app ──────────────────────────────────────────

/** The store address as Judge.me takes it, or null (the form says why). */
export function shopDomainOf(raw: string): string | null {
  const host = raw.trim().toLowerCase().replace(/^https?:\/\//, '').split(/[/?#]/)[0]
  return /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/.test(host) ? host : null
}

/** Why one field's value cannot go yet, or null. The API checks again and answers in words. */
function fieldHeld(app: ReviewAppKey, field: ReviewAppField, raw: string): string | null {
  const value = raw.trim()
  if (!value) return field.secret ? `Paste the ${field.label} first.` : field.key === 'shopDomain' ? 'Type the store’s Shopify address first.' : `Paste the ${field.label} first.`
  if (field.key === 'shopDomain' && !shopDomainOf(value)) return 'The store address ends in .myshopify.com (the Shopify address, not the shop’s own domain).'
  if (app === 'OKENDO' && field.key === 'userId' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return 'That does not look like an Okendo User ID: 36 letters, digits and dashes.'
  }
  if (!field.secret && field.key === 'storeId' && !/^[A-Za-z0-9._-]{6,200}$/.test(value)) return `That does not look like a ${field.label}: letters, digits, dots and dashes.`
  if (field.secret && !/^[\x21-\x7e]{8,200}$/.test(value)) return `That does not look like a ${field.label}: one word, at least 8 characters.`
  return null
}

/** Why Connect is held, or null: the permission first, then each field in order. */
export function connectHeld(input: { canManage: boolean; app: Pick<ReviewAppView, 'app' | 'fields'>; values: Record<string, string>; busy: boolean }): string | null {
  if (!input.canManage) return 'You need ‘Manage reviews’ to connect a review app.'
  if (input.busy) return 'Connecting… this takes a moment.'
  for (const field of input.app.fields) {
    const held = fieldHeld(input.app.app, field, input.values[field.key] ?? '')
    if (held) return held
  }
  return null
}

/** The window's first values: what the app knows the store by is filled back in; a secret never is. */
export function initialValues(app: Pick<ReviewAppView, 'fields' | 'storeId'>): Record<string, string> {
  return Object.fromEntries(app.fields.map((f) => [f.key, !f.secret && app.storeId ? app.storeId : '']))
}

/** The button that opens an app in the list: connect it, or manage it. */
export function appActionLabel(app: Pick<ReviewAppView, 'name' | 'state'>): string {
  return app.state === 'connected' || app.state === 'waiting' || app.state === 'needs_fix' ? `Manage ${app.name}…` : `Connect ${app.name}…`
}
