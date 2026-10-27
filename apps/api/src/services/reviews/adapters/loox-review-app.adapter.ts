/**
 * Reviews (2026-10-28) — Loox, the store's review app, read through the Loox Merchant API. Read only: "Can I create,
 * update, or delete reviews through the API? … No. Both APIs are read-only." A reply is posted in Loox (inside the
 * Shopify admin; the reply box links there).
 *
 * Loox Merchant API (read 2026-10-28; https://help.loox.io/support/solutions/articles/501000356871-loox-reviews-api-and-webhooks,
 * spec https://developers.loox.app/documentation/):
 *   - "Available on the Convert and Unlimited plans." The `publicStoreId` ("can be safely shared") and an API key are in
 *     Loox's Settings › API Keys ("Generate"; "it is only shown in full once"). "Every request requires an API key passed
 *     in the X-Api-Secret-Key header." Base `https://api.loox.io/api/v1/store/{publicStoreId}`. "The Merchant API is rate
 *     limited to 120 requests per minute per API key."
 *   - read:  `GET …/product-reviews` (operation merchant_listProductReviews) and `GET …/store-reviews`: `status`
 *            published | unpublished | pending | all (default published), `sort` featured | date | rating (default
 *            featured, so Nexus asks `date`), `direction` asc | desc, `page` (1-based), `limit` ("Maximum is 250") →
 *            `{ reviews[], pagination { total, page, limit, hasMore, nextPageUrl } }`. A review: id, rating, body, date,
 *            createdAt, verified, status, reviewer { name, … email }, orderId, product { id (Shopify product ID), name,
 *            url }, media[] { type photo | video, url ("For photo: full-size image URL. For video: the video stream
 *            URL."), thumbnailUrl (videos only) } ("Active (approved) media"), reply { body, repliedAt } or null. No
 *            title; no date of a later edit. A 401 is "Missing or invalid X-Api-Secret-Key header" or a wrong store id.
 *
 * Nexus reads the published product and store reviews, newest first, 250 a page (up to 8 pages of product reviews and
 * 4 of store reviews a read). It keeps the photos as the review's images (the docs' example names a photo "image", the
 * schema "photo": both count) and marks a video (a stream URL is not a file a browser plays for sure). Never the
 * reviewer's e-mail.
 */
import { plainText } from './shopify-review-app.adapter.js'
import {
  appRawReview, httpsUrl, isoOf, myshopifyHostOf, reviewAppFailure, reviewAppFetch, reviewAppJson, ReviewAppError, starsOf, str,
  type AppReviewParsed, type AppReviewPayload, type AppReviewPhoto, type AppReviewRead,
} from './review-app-http.js'

export const LOOX_API = 'https://api.loox.io'
export const LOOX_PAGE_SIZE = 250
export const LOOX_MAX_PRODUCT_PAGES = 8
export const LOOX_MAX_STORE_PAGES = 4
const KEY_WORDS = 'the store ID or the API key'

export interface LooxKey { storeId: string; apiKey: string }

/** One Loox review (product or store) → a Nexus review, or null (no id, no date, not published). */
export function parseLooxReview(input: unknown): AppReviewParsed | null {
  if (!input || typeof input !== 'object') return null
  const r = input as Record<string, unknown>
  const id = str(r.id)
  const postedAt = isoOf(r.createdAt) ?? isoOf(r.date)
  const status = str(r.status)
  if (!id || !postedAt || (status && status !== 'published')) return null
  const media = Array.isArray(r.media) ? (r.media as unknown[]).filter((m): m is Record<string, unknown> => !!m && typeof m === 'object') : []
  const photos: AppReviewPhoto[] = media.flatMap((m) => {
    if (m.type !== 'photo' && m.type !== 'image') return []
    const url = httpsUrl(m.url)
    return url ? [{ url, thumb: httpsUrl(m.thumbnailUrl) ?? url }] : []
  })
  const reviewer = r.reviewer && typeof r.reviewer === 'object' ? r.reviewer as Record<string, unknown> : {}
  const product = r.product && typeof r.product === 'object' ? r.product as Record<string, unknown> : null
  const reply = r.reply && typeof r.reply === 'object' ? r.reply as Record<string, unknown> : null
  const productExternalId = product ? str(product.id) : null
  const payload: AppReviewPayload = {
    source: 'loox',
    appReviewId: id,
    productExternalId,
    productTitle: product ? str(product.name) : null,
    shopDomain: product ? myshopifyHostOf(product.url) : null,
    status,
    photos,
    hasVideo: media.some((m) => m.type === 'video'),
    storeReply: reply ? (plainText(reply.body) || null) : null,
    updatedAt: null,
  }
  return {
    raw: appRawReview({
      payload,
      rating: starsOf(r.rating),
      title: null,
      body: plainText(r.body),
      authorName: str(reviewer.name) ?? str(reviewer.nickname),
      verified: r.verified === true,
      postedAt,
    }),
    productExternalId,
    editedAt: null,
  }
}

async function readList(key: LooxKey, list: 'product-reviews' | 'store-reviews', maxPages: number): Promise<{ items: AppReviewParsed[]; pages: number; more: boolean }> {
  const items: AppReviewParsed[] = []
  for (let page = 1; page <= maxPages; page++) {
    const res = await reviewAppFetch({
      app: 'LOOX', base: LOOX_API, method: 'GET', path: `/api/v1/store/${encodeURIComponent(key.storeId)}/${list}`,
      headers: { 'X-Api-Secret-Key': key.apiKey },
      query: { status: 'published', sort: 'date', direction: 'desc', limit: LOOX_PAGE_SIZE, page },
    })
    if (!res.ok) throw reviewAppFailure('LOOX', res.status, 'the review list', KEY_WORDS)
    const body = await reviewAppJson('LOOX', res, 'a review list')
    if (!Array.isArray(body.reviews)) throw new ReviewAppError('LOOX', 'bad_answer', res.status, 'Loox answered without a review list.')
    for (const item of body.reviews) {
      const parsed = parseLooxReview(item)
      if (parsed) items.push(parsed)
    }
    const pagination = body.pagination && typeof body.pagination === 'object' ? body.pagination as { hasMore?: unknown } : {}
    if (pagination.hasMore !== true || body.reviews.length === 0) return { items, pages: page, more: false }
  }
  return { items, pages: maxPages, more: true }
}

/** Reads the store's published product reviews, then its store reviews, newest first. Throws ReviewAppError. */
export async function readLooxReviews(key: LooxKey): Promise<AppReviewRead> {
  const product = await readList(key, 'product-reviews', LOOX_MAX_PRODUCT_PAGES)
  const store = await readList(key, 'store-reviews', LOOX_MAX_STORE_PAGES)
  return { reviews: [...product.items, ...store.items], pages: product.pages + store.pages, more: product.more || store.more }
}
