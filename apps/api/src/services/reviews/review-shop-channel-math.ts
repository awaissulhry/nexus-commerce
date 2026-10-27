/**
 * Reviews › Etsy and Shopify pages (2026-10-27, build spec §3.5 / B21, PR I) — the pure rules behind
 * GET /api/reviews/area/shop-channel (review-shop-channel.service.ts): the reply window of each Etsy review (100 days
 * from the buyer's last edit, `@nexus/shared/review-reply-rules`), the tiles of both pages, the photo and video of a
 * review from what Nexus stored, and whether Etsy is read, in words. No database, no clock of its own: tested in
 * review-shop-channel.vitest.test.ts.
 *
 * The reply tiles ("Not replied yet", "Window closing", "Needs a reply") are NOT counted here: the service counts them
 * with the Inbox's own `where` for the tile's link (the one needs-a-reply rule, review-visibility.ts), so a tile's
 * number is the rows its link opens (lane N8, 2026-10-28). They come in as `ReplyTileCounts`.
 */
import { isReviewOpen, reviewReplyRules } from '@nexus/shared/review-reply-rules'
import { averageRating } from './overviewMath.js'

const DAY_MS = 24 * 60 * 60 * 1000
/** The pages' "New reviews" tile counts this many days, against the same span before. */
export const NEW_DAYS = 30

export interface WindowView {
  days: number
  day: number
  daysLeft: number
  closed: boolean
  endsAt: string
}

/** One Etsy review's reply window, from the buyer's last edit (else the posted time). Null without a date. */
export function etsyWindow(review: { postedAt: Date | string; editedAt: Date | string | null }, now: Date): WindowView | null {
  const w = reviewReplyRules('ETSY', { postedAt: review.postedAt, lastEditedAt: review.editedAt }, now).window
  return w ? { days: w.days, day: w.day, daysLeft: w.daysLeft, closed: w.closed, endsAt: w.endsAt } : null
}

/** A review counts as answered once a reply was recorded (sent or marked) or its status says so. */
export function answered(row: { status: string | null; sentReplies: number }): boolean {
  return row.sentReplies > 0 || row.status === 'RESPONDED'
}

export interface TileFacts {
  rating: number | null
  postedAt: Date
  editedAt: Date | null
  status: string | null
  sentReplies: number
  hasPhoto: boolean
  hasVideo?: boolean
  /** Read in from a file: old history, never waiting for a reply (review-visibility.ts, the one needs-a-reply rule). */
  imported?: boolean
}

/** No reply recorded, open and not imported: once Etsy's window ran out, the "Window closed" tile counts it. */
function unansweredOpen(r: TileFacts): boolean {
  return !answered(r) && isReviewOpen(r.status) && !r.imported
}

/** The reply tiles, counted by the service with the Inbox's `where` for each tile's link (never here). */
export interface EtsyReplyCounts {
  /** The Inbox's `reply=needed&channel=ETSY`: the one needs-a-reply rule (inside the 100 days, not positive, …). */
  notReplied: number
  /** The Inbox's `reply=closing&channel=ETSY`: of those, the windows that close within CLOSING_DAYS. */
  closing: number
}

export interface ShopifyReplyCounts {
  /** The Inbox's `reply=needed&channel=SHOPIFY`. */
  needReply: number
  /** When the oldest of those rows was posted; null when none waits. */
  oldestPostedAt: Date | null
}

export interface EtsyTiles {
  average: number | null
  reviews: number
  newReviews: number
  newDelta: number | null
  withPhoto: number
  /** Needs a reply by the one rule (the Inbox's "Needs a reply" for Etsy): open, inside the window, not positive. */
  notReplied: number
  /** …of those, at most CLOSING_DAYS left (the Inbox's `reply=closing`). */
  closing: number
  /** No reply recorded and not closed by a person, but the window closed: no reply is possible any more. */
  closed: number
}

function newCounts(rows: readonly TileFacts[], now: Date): { now: number; before: number } {
  const from = now.getTime() - NEW_DAYS * DAY_MS
  const prevFrom = from - NEW_DAYS * DAY_MS
  let a = 0
  let b = 0
  for (const r of rows) {
    const t = r.postedAt.getTime()
    if (t > from && t <= now.getTime()) a++
    else if (t > prevFrom && t <= from) b++
  }
  return { now: a, before: b }
}

/** The Etsy page's six tiles; the two reply tiles are the Inbox's counts (`reply`). */
export function etsyTiles(rows: readonly TileFacts[], now: Date, reply: EtsyReplyCounts): EtsyTiles {
  const fresh = newCounts(rows, now)
  const closed = rows.filter((r) => unansweredOpen(r) && etsyWindow({ postedAt: r.postedAt, editedAt: r.editedAt }, now)?.closed === true).length
  return {
    average: averageRating(rows.map((r) => r.rating)),
    reviews: rows.length,
    newReviews: fresh.now,
    newDelta: fresh.before > 0 || fresh.now > 0 ? fresh.now - fresh.before : null,
    withPhoto: rows.filter((r) => r.hasPhoto).length,
    notReplied: reply.notReplied,
    closing: reply.closing,
    closed,
  }
}

export interface ShopifyTiles {
  average: number | null
  reviews: number
  newReviews: number
  newDelta: number | null
  withMedia: number
  videos: number
  /** The Inbox's "Needs a reply" for Shopify (the one rule). */
  needReply: number
  /** Hours the oldest of those waits; null when none waits. */
  oldestWaitHours: number | null
}

/** The Shopify page's four tiles; "Needs a reply" is the Inbox's count (`reply`). */
export function shopifyTiles(rows: readonly TileFacts[], now: Date, reply: ShopifyReplyCounts): ShopifyTiles {
  const fresh = newCounts(rows, now)
  const oldest = reply.oldestPostedAt?.getTime() ?? null
  return {
    average: averageRating(rows.map((r) => r.rating)),
    reviews: rows.length,
    newReviews: fresh.now,
    newDelta: fresh.before > 0 || fresh.now > 0 ? fresh.now - fresh.before : null,
    withMedia: rows.filter((r) => r.hasPhoto || r.hasVideo).length,
    videos: rows.filter((r) => r.hasVideo).length,
    needReply: reply.needReply,
    oldestWaitHours: oldest == null ? null : Math.max(0, Math.floor((now.getTime() - oldest) / (60 * 60 * 1000))),
  }
}

// ── Media from what Nexus stored ─────────────────────────────────────

/** One stored photo of a review (`ReviewMedia`). */
export interface StoredMedia { url: string; type: string; position: number }

export interface MediaView { photos: Array<{ url: string; thumb: string }>; hasVideo: boolean }

const https = (v: unknown): v is string => typeof v === 'string' && /^https:\/\//.test(v)

/**
 * A review's photos from its stored media (`ReviewMedia`: Etsy's one photo, Judge.me's photos — https images only, in
 * order), each with the small copy Judge.me gives (kept in rawPayload) as its thumbnail when there is one; and whether
 * Judge.me marks a video (it gives no video URL, so a video is never media).
 */
export function storedMediaOf(media: readonly StoredMedia[] | null | undefined, rawPayload: unknown): MediaView {
  const raw = rawPayload && typeof rawPayload === 'object' ? rawPayload as { photos?: unknown; hasVideo?: unknown } : {}
  const thumbs = new Map<string, string>()
  if (Array.isArray(raw.photos)) {
    for (const x of raw.photos) {
      const { url, thumb } = (x && typeof x === 'object' ? x : {}) as { url?: unknown; thumb?: unknown }
      if (https(url) && https(thumb)) thumbs.set(url, thumb)
    }
  }
  const photos = [...(media ?? [])]
    .filter((m) => m.type === 'image' && https(m.url))
    .sort((a, b) => a.position - b.position)
    .map((m) => ({ url: m.url, thumb: thumbs.get(m.url) ?? m.url }))
  return { photos, hasVideo: raw.hasVideo === true }
}

// ── Is Etsy read? ────────────────────────────────────────────────────

export interface EtsySourceFacts {
  /** This business's own Etsy accounts. */
  connections: Array<{ id: string; isActive: boolean; authStatus: string; shopName: string | null }>
  readOn: boolean
  lastRun: { status: string; startedAt: Date; errorMessage: string | null } | null
  lastOkAt: Date | null
  reviews: number
}

export interface EtsySource {
  state: 'ok' | 'waiting' | 'off' | 'not_connected' | 'needs_fix' | 'failed'
  stateWords: string
  tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info'
  words: string
  lastReadAt: string | null
  reviews: number
  reconnectHref: string | null
}

const BROKEN: Record<string, string> = { needs_reauth: 'The Etsy sign-in expired', revoked: 'Access was removed on Etsy', disconnected: 'Etsy is not connected' }

/** Whether Nexus reads Etsy reviews, in words (never a setting name). Pure. */
export function etsySource(f: EtsySourceFacts): EtsySource {
  const lastReadAt = f.lastOkAt?.toISOString() ?? null
  const base = { lastReadAt, reviews: f.reviews, reconnectHref: null as string | null }
  const active = f.connections.filter((c) => c.isActive)
  if (active.length === 0) {
    return { ...base, state: 'not_connected', stateWords: 'Not connected', tone: 'neutral', words: 'No Etsy shop is connected to Nexus. Connect Etsy in Settings › Channels and its reviews are read every 30 minutes.', reconnectHref: '/settings/channels/etsy' }
  }
  const broken = active.map((c) => BROKEN[c.authStatus]).find(Boolean)
  if (broken) {
    return { ...base, state: 'needs_fix', stateWords: 'Needs a fix', tone: 'danger', words: `${broken}. Nexus cannot read new Etsy reviews until someone connects Etsy again.`, reconnectHref: '/settings/channels/etsy' }
  }
  if (!f.readOn) {
    return { ...base, state: 'off', stateWords: 'Connected · not read yet', tone: 'info', words: 'Etsy is connected, but Nexus does not read Etsy reviews in this setup yet. Reviews already read stay.' }
  }
  if (f.lastRun?.status === 'FAILED') {
    return { ...base, state: 'failed', stateWords: 'Last read failed', tone: 'warning', words: `The last read of Etsy reviews failed; Nexus tries again every 30 minutes.${lastReadAt ? '' : ' No read has worked yet.'}` }
  }
  if (!f.lastOkAt) {
    return { ...base, state: 'waiting', stateWords: 'Waiting for the first read', tone: 'info', words: 'Etsy is connected. Nexus reads its reviews every 30 minutes; the first read has not run yet.' }
  }
  return { ...base, state: 'ok', stateWords: 'On', tone: 'success', words: `Read every 30 minutes · ${f.reviews.toLocaleString('en')} ${f.reviews === 1 ? 'review' : 'reviews'} read.` }
}
