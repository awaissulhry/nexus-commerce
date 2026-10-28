/**
 * Reviews (2026-10-28) — the one sender for the store review apps Okendo, Yotpo and Loox, and what their reads share.
 * Judge.me keeps its own sender (shopify-review-app.adapter.ts); these three work the same way:
 *
 *   - A review app is not a marketplace channel: it is not a host of the channel gateway
 *     (`apps/api/scripts/channel-gateway-ratchet.mts` HOSTS), so its sends are a plain `fetch` here, logged with `logger`
 *     and marked gateway-exempt — exactly as Judge.me's are.
 *   - Only https, only the app's own API host, a path under it (never a full URL from an answer), a 20-second timeout.
 *   - A secret (API key, API secret, a Yotpo access token) is never logged, never returned and never put in an error;
 *     an answer's body is never logged either (it holds buyers' e-mails).
 *   - A failed call becomes a `ReviewAppError` whose words a person can act on.
 *
 * What a read gives back (`AppReviewParsed`) is what Judge.me's read gives: the review for the shared ingest (channel
 * SHOPIFY), the Shopify product id when the app names it, and what Nexus keeps in `rawPayload` (`AppReviewPayload`:
 * never the reviewer's e-mail or IP address).
 */
import type { ReviewApp } from '@nexus/shared/review-reply-rules'
import { REVIEW_APP_NAME } from '@nexus/shared/review-reply-rules'
import { logger } from '../../../utils/logger.js'
import type { AdapterRawReview } from './types.js'

const TIMEOUT_MS = 20_000

export type ReviewAppFailure = 'refused' | 'not_found' | 'rate_limited' | 'unavailable' | 'rejected' | 'no_answer' | 'bad_answer'

/** A review-app call that did not work, in words a person can act on (never a key, never the app's answer). */
export class ReviewAppError extends Error {
  constructor(readonly app: ReviewApp, readonly kind: ReviewAppFailure, readonly status: number | null, words: string) {
    super(words)
    this.name = 'ReviewAppError'
  }
}

/** The words for a failed answer. `key` names what the person pasted ("the API key", "the store ID and API secret"). */
export function reviewAppFailure(app: ReviewApp, status: number, what: string, key: string): ReviewAppError {
  const name = REVIEW_APP_NAME[app]
  if (status === 401 || status === 403) return new ReviewAppError(app, 'refused', status, `${name} refused ${key} (HTTP ${status}). Paste them again from ${name}.`)
  if (status === 404) return new ReviewAppError(app, 'not_found', status, `${name} did not find ${what} (HTTP 404).`)
  if (status === 429) return new ReviewAppError(app, 'rate_limited', status, `${name} asked Nexus to slow down (HTTP 429). Nexus tries again at the next read.`)
  if (status >= 500) return new ReviewAppError(app, 'unavailable', status, `${name} did not answer properly (HTTP ${status}). Nexus tries again at the next read.`)
  return new ReviewAppError(app, 'rejected', status, `${name} refused ${what} (HTTP ${status}).`)
}

export interface ReviewAppCall {
  app: ReviewApp
  /** The app's API root, e.g. "https://api.okendo.io/enterprise" (constants in each adapter, never from an answer). */
  base: string
  method: 'GET' | 'POST'
  /** A path under `base` ("/reviews"), never a full URL. */
  path: string
  query?: Record<string, string | number | boolean | undefined>
  headers: Record<string, string>
  body?: unknown
}

/** The one place Nexus sends to Okendo, Yotpo and Loox. */
export async function reviewAppFetch(call: ReviewAppCall): Promise<Response> {
  if (!/^https:\/\/[a-z0-9.-]+(\/[a-z0-9/_-]*)?$/i.test(call.base)) throw new Error('Invalid review app base.')
  if (!call.path.startsWith('/') || call.path.includes('//') || call.path.includes('://') || call.path.includes('..')) throw new Error('Invalid review app path.')
  const query = new URLSearchParams()
  for (const [k, v] of Object.entries(call.query ?? {})) if (v !== undefined) query.set(k, String(v))
  const qs = query.toString()
  const url = `${call.base}${call.path}${qs ? `?${qs}` : ''}`
  const started = Date.now()
  const app = call.app.toLowerCase()
  let response: Response
  try {
    // gateway-exempt: Okendo, Yotpo and Loox are the store's review app, not a marketplace channel the gateway serves.
    response = await fetch(url, {
      method: call.method,
      headers: { Accept: 'application/json', ...call.headers, ...(call.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: call.body !== undefined ? JSON.stringify(call.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    logger.warn(`[${app}] no answer`, { method: call.method, path: call.path, ms: Date.now() - started, error: err instanceof Error ? err.name : 'error' })
    throw new ReviewAppError(call.app, 'no_answer', null, `${REVIEW_APP_NAME[call.app]} did not answer. Nexus tries again at the next read.`)
  }
  logger.info(`[${app}] call`, { method: call.method, path: call.path, status: response.status, ms: Date.now() - started })
  return response
}

/** The answer's JSON, or a ReviewAppError in words. */
export async function reviewAppJson(app: ReviewApp, res: Response, what: string): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new ReviewAppError(app, 'bad_answer', res.status, `${REVIEW_APP_NAME[app]} answered without ${what}.`)
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ReviewAppError(app, 'bad_answer', res.status, `${REVIEW_APP_NAME[app]} answered without ${what}.`)
  return body as Record<string, unknown>
}

/** A reply posted through an app (Judge.me's `JudgemeReplyResult` has the same shape). */
export interface AppReplyResult {
  ok: boolean
  /** OKENDO_200, OKENDO_401, OKENDO_NO_ANSWER … (ReviewResponse.providerResponseCode). */
  code: string
  error?: string
  /** The app refused the key itself: the connection needs a new one. */
  refusedKey?: boolean
}

// ── What a read gives back ──────────────────────────────────────────

export interface AppReviewPhoto { url: string; thumb: string }

/** What the review keeps of the app's answer in `rawPayload` (no e-mail, no IP address). */
export interface AppReviewPayload {
  source: 'okendo' | 'yotpo' | 'loox'
  /** The app's own id of the review. */
  appReviewId: string
  productExternalId: string | null
  productTitle: string | null
  /** The store's myshopify address when the app says it (Loox's product URL): the "Reply in Loox" link. */
  shopDomain: string | null
  /** Okendo's / Loox's moderation status, Yotpo's reviewer type … as the app words it. */
  status: string | null
  photos: AppReviewPhoto[]
  /** The buyer added a video: Nexus marks it and links to the app (the apps give no file a browser can play for sure). */
  hasVideo: boolean
  /** The store's reply already on the review in the app (its text), or null. */
  storeReply: string | null
  updatedAt: string | null
  /**
   * False when this read did not look at the review's photos (Yotpo's later reads ask only for new photos): the photos
   * Nexus already holds stay as they are. Left out = the photos above are the review's photos.
   */
  mediaKnown?: false
}

export interface AppReviewParsed {
  raw: AdapterRawReview
  /** The Shopify product id (or the product key Yotpo was sent) the review is about. */
  productExternalId: string | null
  editedAt: string | null
}

export interface AppReviewRead {
  reviews: AppReviewParsed[]
  pages: number
  /** More pages were waiting when the read stopped at its page cap (read on at the next runs). */
  more: boolean
}

/** A trimmed string from a string or a finite number; null otherwise. */
export const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : null)

/** An ISO time from a date string, or null. */
export function isoOf(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** Whole stars 1–5, else undefined. */
export function starsOf(v: unknown): number | undefined {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 5 ? n : undefined
}

/** An https URL, else null (a review photo is shown from the app; nothing else is kept). */
export function httpsUrl(v: unknown): string | null {
  const s = str(v)
  return s && /^https:\/\/[^\s]+$/i.test(s) ? s : null
}

/** The myshopify address in a URL ("https://a-store.myshopify.com/products/x" → "a-store.myshopify.com"), else null. */
export function myshopifyHostOf(v: unknown): string | null {
  const s = str(v)
  if (!s) return null
  try {
    const host = new URL(s).hostname.toLowerCase()
    return /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/.test(host) ? host : null
  } catch {
    return null
  }
}

/** A pasted secret: one word of 8–200 visible characters; null otherwise. */
export function normalizeSecret(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const token = raw.trim()
  return /^[\x21-\x7e]{8,200}$/.test(token) ? token : null
}

/** A pasted store identifier that goes into an API path: letters, digits, dots, dashes, underscores (6–200). */
export function normalizeStoreId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const id = raw.trim()
  return /^[A-Za-z0-9._-]{6,200}$/.test(id) ? id : null
}

/** The review as Nexus stores it: channel SHOPIFY, the app's id prefixed so two apps never share a dedupe key. */
export function appRawReview(input: {
  payload: AppReviewPayload
  rating: number | undefined
  title: string | null
  body: string
  authorName: string | null
  verified: boolean
  postedAt: string
}): AdapterRawReview {
  const p = input.payload
  return {
    externalReviewId: `${p.source}:${p.appReviewId}`,
    channel: 'SHOPIFY',
    rating: input.rating,
    title: input.title || undefined,
    body: input.body,
    authorName: input.authorName ?? undefined,
    verifiedPurchase: input.verified,
    postedAt: input.postedAt,
    rawPayload: p,
    media: p.mediaKnown === false ? undefined : p.photos.map((photo, position) => ({ url: photo.url, type: 'image' as const, position })),
  }
}

/** The app's own id of a review Nexus stored ("okendo:<id>" → "<id>"); null when it is not that app's. */
export function appReviewIdOf(app: ReviewApp, externalReviewId: string): string | null {
  const prefix = `${app.toLowerCase()}:`
  return externalReviewId.startsWith(prefix) && externalReviewId.length > prefix.length ? externalReviewId.slice(prefix.length) : null
}
