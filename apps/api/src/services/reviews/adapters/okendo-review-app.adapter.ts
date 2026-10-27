/**
 * Reviews (2026-10-28) — Okendo, the store's review app, read and answered through Okendo's Merchant REST API.
 *
 * Okendo Merchant REST API (read 2026-10-28):
 *   - https://docs.okendo.io/docs/merchant-rest-api/usage — HTTPS only; HTTP Basic auth: "The username is your Okendo
 *     User ID and the password is a unique, 32-character string. Both … can be found in the integration settings section
 *     of the Okendo app." Every request sends `okendo-api-version` (the one value listed: 2025-02-01). A list may hold a
 *     `nextUrl`: append it to the base path for the next page; no `nextUrl` = the last page. Rate: "a consistent rate of
 *     2 requests per second, with a small burst capacity above that" (HTTP 429 beyond).
 *   - Server `https://api.okendo.io/enterprise` (the spec's `servers`, https://docs.okendo.io/docs/open-api/merchant-rest-api/okendo-enterprise-api).
 *   - read:  `GET /reviews` (https://docs.okendo.io/docs/open-api/merchant-rest-api/list-reviews): `limit` 1–100 (default
 *            25), `lastEvaluated` (the cursor of the next page), `orderBy` '(date|rating) (asc|desc)' (default
 *            'date desc'), `status` approved | pending | rejected (default approved) → `{ reviews[], nextUrl? }`. A review:
 *            reviewId (uuid), productId ("shopify-123456789"), productName, rating 1–5, title, body, dateCreated,
 *            status, reviewer { name, displayName, email, isVerified, verifiedStatus 'Verified Buyer' | 'Verified
 *            Reviewer' }, media[] { type 'image' | 'video', fullSizeUrl, largeUrl, thumbnailUrl, isHidden, streamId },
 *            reply { body (html), rawBody, dateCreated, isPrivate }. No date of a later edit.
 *   - reply: `POST /reviews/{reviewId}/reply` (https://docs.okendo.io/docs/open-api/merchant-rest-api/reply-to-a-review)
 *            with `{ reply: { body, isPrivate }, shouldEmailReply }` → 200 the review with its reply; 400, 401, 404.
 *   - Access: the spec calls it the API "available to enterprise customers"; Okendo's pricing lists "API access" from the
 *     Growth plan, and as an add-on on Essentials (https://www.okendo.io/pricing/). The connect window says so.
 *
 * Nexus reads the approved (published) reviews, newest first, 100 a page, up to 20 pages a read. It keeps the photos
 * (not the hidden ones) as the review's images; a video is a mark (the docs do not say which URL plays it). Never the
 * reviewer's e-mail.
 */
import { logger } from '../../../utils/logger.js'
import { plainText } from './shopify-review-app.adapter.js'
import {
  appRawReview, httpsUrl, isoOf, reviewAppFailure, reviewAppFetch, reviewAppJson, ReviewAppError, starsOf, str,
  type AppReplyResult, type AppReviewParsed, type AppReviewPayload, type AppReviewPhoto, type AppReviewRead,
} from './review-app-http.js'

export const OKENDO_API = 'https://api.okendo.io/enterprise'
export const OKENDO_API_VERSION = '2025-02-01'
export const OKENDO_PAGE_SIZE = 100
export const OKENDO_MAX_PAGES = 20
const KEY_WORDS = 'the User ID or the API key'

export interface OkendoKey { userId: string; apiKey: string }

/** Okendo's User ID is a UUID ("Your user id within Okendo", format uuid). */
export function normalizeOkendoUserId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const id = raw.trim().toLowerCase()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ? id : null
}

function headers(key: OkendoKey): Record<string, string> {
  return {
    Authorization: `Basic ${Buffer.from(`${key.userId}:${key.apiKey}`).toString('base64')}`,
    'okendo-api-version': OKENDO_API_VERSION,
  }
}

/** One Okendo review → a Nexus review, or null (no id, no date, not approved). */
export function parseOkendoReview(input: unknown): AppReviewParsed | null {
  if (!input || typeof input !== 'object') return null
  const r = input as Record<string, unknown>
  const id = str(r.reviewId)
  const postedAt = isoOf(r.dateCreated)
  const status = str(r.status)
  if (!id || !postedAt || (status && status !== 'approved')) return null
  const media = Array.isArray(r.media) ? (r.media as unknown[]).filter((m): m is Record<string, unknown> => !!m && typeof m === 'object' && (m as { isHidden?: unknown }).isHidden !== true) : []
  const photos: AppReviewPhoto[] = media.flatMap((m) => {
    if (m.type !== 'image') return []
    const url = httpsUrl(m.fullSizeUrl) ?? httpsUrl(m.largeUrl)
    return url ? [{ url, thumb: httpsUrl(m.thumbnailUrl) ?? url }] : []
  })
  const reviewer = r.reviewer && typeof r.reviewer === 'object' ? r.reviewer as Record<string, unknown> : {}
  const reply = r.reply && typeof r.reply === 'object' ? r.reply as Record<string, unknown> : null
  const product = str(r.productId)
  const productExternalId = product ? product.replace(/^shopify-/, '') : null
  const payload: AppReviewPayload = {
    source: 'okendo',
    appReviewId: id,
    productExternalId,
    productTitle: str(r.productName),
    shopDomain: null,
    status,
    photos,
    hasVideo: media.some((m) => m.type === 'video'),
    storeReply: reply ? (str(reply.rawBody) ?? (plainText(reply.body) || null)) : null,
    updatedAt: null,
  }
  return {
    raw: appRawReview({
      payload,
      rating: starsOf(r.rating),
      title: plainText(r.title) || null,
      body: plainText(r.body),
      authorName: str(reviewer.displayName) ?? str(reviewer.name),
      verified: reviewer.verifiedStatus === 'Verified Buyer' || reviewer.isVerified === true,
      postedAt,
    }),
    productExternalId,
    editedAt: null,
  }
}

/** The cursor of the next page from Okendo's `nextUrl` ("/reviews?lastEvaluated=…"); only the cursor is used, never the URL. */
export function okendoCursorOf(nextUrl: unknown): string | null {
  const s = str(nextUrl)
  if (!s) return null
  try {
    return new URL(s, 'https://cursor.invalid').searchParams.get('lastEvaluated')
  } catch {
    return null
  }
}

/** Reads the store's approved reviews, newest first, up to `maxPages` pages. Throws ReviewAppError. */
export async function readOkendoReviews(key: OkendoKey, opts: { maxPages?: number } = {}): Promise<AppReviewRead> {
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? OKENDO_MAX_PAGES, OKENDO_MAX_PAGES))
  const reviews: AppReviewParsed[] = []
  let cursor: string | null = null
  for (let page = 1; page <= maxPages; page++) {
    const res = await reviewAppFetch({
      app: 'OKENDO', base: OKENDO_API, method: 'GET', path: '/reviews', headers: headers(key),
      query: { limit: OKENDO_PAGE_SIZE, orderBy: 'date desc', status: 'approved', lastEvaluated: cursor ?? undefined },
    })
    if (!res.ok) throw reviewAppFailure('OKENDO', res.status, 'the review list', KEY_WORDS)
    const body = await reviewAppJson('OKENDO', res, 'a review list')
    if (!Array.isArray(body.reviews)) throw new ReviewAppError('OKENDO', 'bad_answer', res.status, 'Okendo answered without a review list.')
    for (const item of body.reviews) {
      const parsed = parseOkendoReview(item)
      if (parsed) reviews.push(parsed)
    }
    cursor = okendoCursorOf(body.nextUrl)
    if (!cursor) return { reviews, pages: page, more: false }
  }
  return { reviews, pages: maxPages, more: true }
}

/** The body of `POST /reviews/{reviewId}/reply`: public, and Okendo e-mails it to the reviewer (as Judge.me does). */
export function okendoReplyBody(text: string): { reply: { body: string; isPrivate: boolean }; shouldEmailReply: boolean } {
  return { reply: { body: text, isPrivate: false }, shouldEmailReply: true }
}

/** Posts one public reply under an Okendo review (its Okendo id). Never throws. */
export async function postOkendoReply(key: OkendoKey, reviewId: string, text: string): Promise<AppReplyResult> {
  if (!/^[0-9a-f-]{8,64}$/i.test(reviewId)) return { ok: false, code: 'OKENDO_NOT_SENT', error: 'This review has no Okendo id Nexus can answer. Nothing was sent.' }
  try {
    const res = await reviewAppFetch({ app: 'OKENDO', base: OKENDO_API, method: 'POST', path: `/reviews/${reviewId}/reply`, headers: headers(key), body: okendoReplyBody(text) })
    if (res.ok) return { ok: true, code: `OKENDO_${res.status}` }
    const failure = reviewAppFailure('OKENDO', res.status, 'the reply', KEY_WORDS)
    return { ok: false, code: `OKENDO_${res.status}`, error: failure.message, refusedKey: failure.kind === 'refused' }
  } catch (err) {
    const words = err instanceof ReviewAppError ? err.message : 'Okendo could not be reached.'
    if (!(err instanceof ReviewAppError)) logger.warn('[okendo] reply not sent', { error: err instanceof Error ? err.name : 'error' })
    return { ok: false, code: err instanceof ReviewAppError && err.kind === 'no_answer' ? 'OKENDO_NO_ANSWER' : 'OKENDO_NOT_SENT', error: words }
  }
}
