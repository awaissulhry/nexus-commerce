/**
 * Reviews › Etsy and Shopify pages (2026-10-27, build spec §3.5 / B21, PR I) — the pure rules behind
 * GET /api/reviews/area/shop-channel (review-shop-channel.service.ts): the reply window of each Etsy review (100 days
 * from the buyer's last edit, `@nexus/shared/review-reply-rules`), the tiles of both pages, the photo and video of a
 * review from what Nexus stored, and whether Etsy is read, in words. No database, no clock of its own: tested in
 * review-shop-channel.vitest.test.ts.
 */
import { isReviewOpen, reviewReplyRules } from '@nexus/shared/review-reply-rules'
import { averageRating } from './overviewMath.js'

const DAY_MS = 24 * 60 * 60 * 1000
/** "Window closing" = at most this many days left (the board's tile). */
export const CLOSING_DAYS = 10
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
}

export interface EtsyTiles {
  average: number | null
  reviews: number
  newReviews: number
  newDelta: number | null
  withPhoto: number
  /** Open (no reply, not closed by a person) and the window still open. */
  notReplied: number
  /** …of those, at most CLOSING_DAYS left. */
  closing: number
  /** Open, but the window closed: no reply is possible any more. */
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

/** The Etsy page's six tiles. */
export function etsyTiles(rows: readonly TileFacts[], now: Date): EtsyTiles {
  const fresh = newCounts(rows, now)
  let notReplied = 0
  let closing = 0
  let closed = 0
  for (const r of rows) {
    if (answered(r) || !isReviewOpen(r.status)) continue
    const w = etsyWindow({ postedAt: r.postedAt, editedAt: r.editedAt }, now)
    if (!w) continue
    if (w.closed) closed++
    else {
      notReplied++
      if (w.daysLeft <= CLOSING_DAYS) closing++
    }
  }
  return {
    average: averageRating(rows.map((r) => r.rating)),
    reviews: rows.length,
    newReviews: fresh.now,
    newDelta: fresh.before > 0 || fresh.now > 0 ? fresh.now - fresh.before : null,
    withPhoto: rows.filter((r) => r.hasPhoto).length,
    notReplied,
    closing,
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
  needReply: number
  /** Hours the oldest open review waits; null when none waits. */
  oldestWaitHours: number | null
}

/** The Shopify page's four tiles. */
export function shopifyTiles(rows: readonly TileFacts[], now: Date): ShopifyTiles {
  const fresh = newCounts(rows, now)
  const waiting = rows.filter((r) => !answered(r) && isReviewOpen(r.status))
  const oldest = waiting.reduce<number | null>((min, r) => (min == null || r.postedAt.getTime() < min ? r.postedAt.getTime() : min), null)
  return {
    average: averageRating(rows.map((r) => r.rating)),
    reviews: rows.length,
    newReviews: fresh.now,
    newDelta: fresh.before > 0 || fresh.now > 0 ? fresh.now - fresh.before : null,
    withMedia: rows.filter((r) => r.hasPhoto || r.hasVideo).length,
    videos: rows.filter((r) => r.hasVideo).length,
    needReply: waiting.length,
    oldestWaitHours: oldest == null ? null : Math.max(0, Math.floor((now.getTime() - oldest) / (60 * 60 * 1000))),
  }
}

// ── Media from what Nexus stored ─────────────────────────────────────

/** The Etsy review's one photo (Etsy's `image_url_fullxfull`, kept in rawPayload), or null. */
export function etsyPhotoOf(rawPayload: unknown): string | null {
  if (!rawPayload || typeof rawPayload !== 'object') return null
  const url = (rawPayload as { image_url_fullxfull?: unknown }).image_url_fullxfull
  return typeof url === 'string' && /^https:\/\//.test(url) ? url : null
}

export interface MediaView { photos: Array<{ url: string; thumb: string }>; hasVideo: boolean }

/** A Judge.me review's photos and whether it has a video (Judge.me gives no video URL), from rawPayload. */
export function appMediaOf(rawPayload: unknown): MediaView {
  if (!rawPayload || typeof rawPayload !== 'object') return { photos: [], hasVideo: false }
  const p = rawPayload as { photos?: unknown; hasVideo?: unknown }
  const photos = Array.isArray(p.photos)
    ? p.photos.flatMap((x) => {
        if (!x || typeof x !== 'object') return []
        const { url, thumb } = x as { url?: unknown; thumb?: unknown }
        return typeof url === 'string' && /^https:\/\//.test(url) ? [{ url, thumb: typeof thumb === 'string' && /^https:\/\//.test(thumb) ? thumb : url }] : []
      })
    : []
  return { photos, hasVideo: p.hasVideo === true }
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
