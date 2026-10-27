/**
 * Reviews (2026-10-27, build spec B21 / PR I) — the store's review app for Shopify. Shopify keeps no reviews itself: they
 * live in the review app the store installed. Today Nexus connects to Judge.me (Owner ruling 8: the store uses
 * Judge.me); Okendo, Yotpo and Loox are named in words only (`@nexus/shared/review-reply-rules`) until they are built.
 *
 * Judge.me API v1 (OpenAPI spec https://judge.me/api/docs.yaml, docs https://judge.me/api/docs, read 2026-10-27):
 *   - server `https://api.judge.me/api/v1`; a private API token goes in the `X-Api-Token` header and the store in the
 *     `shop_domain` query parameter ("example.myshopify.com").
 *   - read:  `GET /reviews?shop_domain=&per_page=&page=` (scope `read_reviews`) → `{ current_page, per_page, reviews[] }`;
 *            a review: id (Judge.me's own id), title, body (raw, NOT sanitized), rating 1–5, product_external_id (the
 *            Shopify product id), product_title, product_handle, reviewer { id, name, email, … }, source, curated
 *            (ok | spam | not-yet), hidden (archived), verified, created_at, updated_at, ip_address,
 *            has_published_pictures, has_published_videos, pictures[] { hidden, urls { small, compact, huge, original } }.
 *            No video URLs and no reply are in the answer.
 *   - reply: `POST /replies` (scope `write_replies`) with `{ review_id: <Judge.me id>, reply: { content } }` (and
 *            `send_reply_email`, default true: Judge.me e-mails the reply to the reviewer) → 200, or 422 `{ error }`.
 *
 * Judge.me is a review app, not a marketplace: it is not a channel host of the channel gateway
 * (`scripts/channel-gateway-ratchet.mts` HOSTS), so its one send below is a plain `fetch` logged with `logger` and marked
 * gateway-exempt (this file's path names Shopify, which the ratchet would otherwise count). The API token is never
 * logged, never returned and never put in an error; an answer's body is never logged either (it holds buyers' e-mails).
 *
 * What Nexus keeps of a review: the text, stars, the reviewer's NAME (never the e-mail or IP address), the product,
 * the published photos as the review's `ReviewMedia` images (in Judge.me's order; the Inbox pop-up shows them in the
 * Lightbox, like eBay's), and in `rawPayload` the photo URLs with their thumbnails and whether it has a video (Judge.me
 * gives no video URL, so a video is a mark, never media). Archived reviews (hidden) are left out.
 */
import { logger } from '../../../utils/logger.js'
import type { AdapterRawReview } from './types.js'

export const JUDGEME_API = 'https://api.judge.me/api/v1'
/** Reviews asked per page (Judge.me's answer says how many it gives; fewer than that = the last page). */
export const JUDGEME_PAGE_SIZE = 100
/** Pages one read takes at most (2,000 reviews); a bigger store is read on in the next runs. */
export const JUDGEME_MAX_PAGES = 20
const TIMEOUT_MS = 20_000

/** Judge.me's verified states that count as a verified buyer (docs: Review.verified). */
const VERIFIED = new Set(['confirmed-buyer', 'buyer', 'verified-purchase', 'semi-verified-purchase', 'admin'])

export type JudgemeFailure = 'refused' | 'not_found' | 'rate_limited' | 'unavailable' | 'rejected' | 'no_answer' | 'bad_answer'

/** A Judge.me call that did not work, in words a person can act on (never the key, never Judge.me's body). */
export class JudgemeError extends Error {
  constructor(readonly kind: JudgemeFailure, readonly status: number | null, words: string) {
    super(words)
    this.name = 'JudgemeError'
  }
}

/** "Example.myshopify.com", "https://example.myshopify.com/admin" → "example.myshopify.com"; anything else → null. */
export function normalizeShopDomain(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const host = raw.trim().toLowerCase().replace(/^https?:\/\//, '').split(/[/?#]/)[0]
  return /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/.test(host) ? host : null
}

/** A pasted API token: one word of 8–200 visible characters; null otherwise. */
export function normalizeApiToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const token = raw.trim()
  return /^[\x21-\x7e]{8,200}$/.test(token) ? token : null
}

function failureOf(status: number, what: string): JudgemeError {
  if (status === 401 || status === 403) return new JudgemeError('refused', status, `Judge.me refused the API token or the shop domain (HTTP ${status}). Paste a private API token from Judge.me again.`)
  if (status === 404) return new JudgemeError('not_found', status, `Judge.me did not find ${what} (HTTP 404).`)
  if (status === 429) return new JudgemeError('rate_limited', status, 'Judge.me asked Nexus to slow down (HTTP 429). Nexus tries again at the next read.')
  if (status >= 500) return new JudgemeError('unavailable', status, `Judge.me did not answer properly (HTTP ${status}). Nexus tries again at the next read.`)
  return new JudgemeError('rejected', status, `Judge.me refused ${what} (HTTP ${status}).`)
}

export interface JudgemeCall {
  method: 'GET' | 'POST'
  /** A path under the API ("/reviews"), never a full URL. */
  path: string
  query?: Record<string, string | number>
  body?: unknown
  shopDomain: string
  apiToken: string
}

/** The one place Nexus sends to Judge.me. */
export async function judgemeFetch(call: JudgemeCall): Promise<Response> {
  if (!call.path.startsWith('/') || call.path.includes('//') || call.path.includes('://')) throw new Error('Invalid Judge.me path.')
  const shop = normalizeShopDomain(call.shopDomain)
  if (!shop) throw new JudgemeError('rejected', null, 'The shop domain is not a Shopify store address (name.myshopify.com).')
  const query = new URLSearchParams({ shop_domain: shop })
  for (const [k, v] of Object.entries(call.query ?? {})) query.set(k, String(v))
  const url = `${JUDGEME_API}${call.path}?${query.toString()}`
  const started = Date.now()
  let response: Response
  try {
    // gateway-exempt: Judge.me (api.judge.me) is the store's review app, not a marketplace channel the gateway serves.
    response = await fetch(url, {
      method: call.method,
      headers: { 'X-Api-Token': call.apiToken, Accept: 'application/json', ...(call.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: call.body !== undefined ? JSON.stringify(call.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    logger.warn('[judgeme] no answer', { method: call.method, path: call.path, ms: Date.now() - started, error: err instanceof Error ? err.name : 'error' })
    throw new JudgemeError('no_answer', null, 'Judge.me did not answer. Nexus tries again at the next read.')
  }
  logger.info('[judgeme] call', { method: call.method, path: call.path, status: response.status, ms: Date.now() - started })
  return response
}

// ── Reading ──────────────────────────────────────────────────────────

export interface JudgemePhoto { url: string; thumb: string }

/** What the review keeps of Judge.me's answer in `rawPayload` (no e-mail, no IP address). */
export interface JudgemePayload {
  source: 'judgeme'
  judgemeId: string
  productExternalId: string | null
  productTitle: string | null
  productHandle: string | null
  curated: string | null
  verified: string | null
  reviewSource: string | null
  photos: JudgemePhoto[]
  hasVideo: boolean
  updatedAt: string | null
}

export interface JudgemeParsed {
  raw: AdapterRawReview
  /** The Shopify product id the review is about (Judge.me's product_external_id). */
  productExternalId: string | null
  editedAt: string | null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : null)

/** Judge.me's body is raw (not sanitized): line breaks kept, tags dropped, entities for &, <, >, quotes read. */
export function plainText(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&amp;/g, '&')
    .trim()
}

function isoOf(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** One Judge.me review → a Nexus review (channel SHOPIFY), or null when it cannot be one (no id, no date, archived). */
export function parseJudgemeReview(input: unknown): JudgemeParsed | null {
  if (!input || typeof input !== 'object') return null
  const r = input as Record<string, unknown>
  const id = str(r.id)
  const postedAt = isoOf(r.created_at)
  if (!id || !postedAt || r.hidden === true) return null
  const rating = typeof r.rating === 'number' && Number.isInteger(r.rating) && r.rating >= 1 && r.rating <= 5 ? r.rating : undefined
  const reviewer = r.reviewer && typeof r.reviewer === 'object' ? r.reviewer as Record<string, unknown> : null
  const photos: JudgemePhoto[] = Array.isArray(r.pictures)
    ? (r.pictures as unknown[]).flatMap((p) => {
        if (!p || typeof p !== 'object' || (p as { hidden?: unknown }).hidden === true) return []
        const urls = ((p as { urls?: unknown }).urls ?? {}) as Record<string, unknown>
        const url = str(urls.original) ?? str(urls.huge) ?? str(urls.compact) ?? str(urls.small)
        if (!url || !/^https:\/\//.test(url)) return []
        return [{ url, thumb: str(urls.compact) ?? str(urls.small) ?? url }]
      })
    : []
  const verified = str(r.verified)
  const productExternalId = str(r.product_external_id)
  const payload: JudgemePayload = {
    source: 'judgeme',
    judgemeId: id,
    productExternalId,
    productTitle: str(r.product_title),
    productHandle: str(r.product_handle),
    curated: str(r.curated),
    verified,
    reviewSource: str(r.source),
    photos,
    hasVideo: r.has_published_videos === true,
    updatedAt: isoOf(r.updated_at),
  }
  return {
    raw: {
      externalReviewId: id,
      channel: 'SHOPIFY',
      rating,
      title: plainText(r.title) || undefined,
      body: plainText(r.body),
      authorName: str(reviewer?.name) ?? undefined,
      verifiedPurchase: verified ? VERIFIED.has(verified) : false,
      postedAt,
      rawPayload: payload,
      media: photos.map((photo, position) => ({ url: photo.url, type: 'image' as const, position })),
    },
    productExternalId,
    editedAt: payload.updatedAt,
  }
}

export interface JudgemeRead {
  reviews: JudgemeParsed[]
  pages: number
  /** More pages were waiting when the read stopped at its page cap. */
  more: boolean
}

/** Reads the store's reviews, newest pages first as Judge.me gives them, up to `maxPages` pages. Throws JudgemeError. */
export async function readJudgemeReviews(opts: { shopDomain: string; apiToken: string; maxPages?: number }): Promise<JudgemeRead> {
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? JUDGEME_MAX_PAGES, JUDGEME_MAX_PAGES))
  const reviews: JudgemeParsed[] = []
  let pages = 0
  for (let page = 1; page <= maxPages; page++) {
    const res = await judgemeFetch({ method: 'GET', path: '/reviews', query: { per_page: JUDGEME_PAGE_SIZE, page }, shopDomain: opts.shopDomain, apiToken: opts.apiToken })
    if (!res.ok) throw failureOf(res.status, 'the review list')
    let body: unknown
    try {
      body = await res.json()
    } catch {
      throw new JudgemeError('bad_answer', res.status, 'Judge.me answered without a review list.')
    }
    const list = body && typeof body === 'object' ? (body as { reviews?: unknown }).reviews : undefined
    if (!Array.isArray(list)) throw new JudgemeError('bad_answer', res.status, 'Judge.me answered without a review list.')
    pages++
    for (const item of list) {
      const parsed = parseJudgemeReview(item)
      if (parsed) reviews.push(parsed)
    }
    const given = Number((body as { per_page?: unknown }).per_page)
    const pageSize = Number.isFinite(given) && given > 0 ? Math.min(given, JUDGEME_PAGE_SIZE) : JUDGEME_PAGE_SIZE
    if (list.length === 0 || list.length < pageSize) return { reviews, pages, more: false }
  }
  return { reviews, pages, more: true }
}

// ── Replying ─────────────────────────────────────────────────────────

/** The body of `POST /replies` (Judge.me RequestCreateReply): the review's Judge.me id and the reply's text. */
export function judgemeReplyBody(reviewId: string, text: string): { review_id: number | string; reply: { content: string } } {
  const numeric = /^\d+$/.test(reviewId) ? Number(reviewId) : reviewId
  return { review_id: Number.isSafeInteger(numeric) ? numeric : reviewId, reply: { content: text } }
}

export interface JudgemeReplyResult {
  ok: boolean
  /** JUDGEME_200, JUDGEME_422, JUDGEME_REFUSED, JUDGEME_NO_ANSWER … (ReviewResponse.providerResponseCode). */
  code: string
  error?: string
  /** Judge.me refused the key itself: the connection needs a new token. */
  refusedKey?: boolean
}

/** Posts one public reply under a Judge.me review. Never throws. */
export async function postJudgemeReply(opts: { shopDomain: string; apiToken: string; reviewId: string; text: string }): Promise<JudgemeReplyResult> {
  try {
    const res = await judgemeFetch({ method: 'POST', path: '/replies', body: judgemeReplyBody(opts.reviewId, opts.text), shopDomain: opts.shopDomain, apiToken: opts.apiToken })
    if (res.ok) return { ok: true, code: `JUDGEME_${res.status}` }
    const failure = failureOf(res.status, 'the reply')
    return { ok: false, code: `JUDGEME_${res.status}`, error: failure.message, refusedKey: failure.kind === 'refused' }
  } catch (err) {
    const words = err instanceof JudgemeError ? err.message : 'Judge.me could not be reached.'
    return { ok: false, code: err instanceof JudgemeError && err.kind === 'no_answer' ? 'JUDGEME_NO_ANSWER' : 'JUDGEME_NOT_SENT', error: words }
  }
}
