/**
 * Reviews (2026-10-28) — Yotpo, the store's review app, read through Yotpo's UGC (merchant) API. Read only: Yotpo's
 * merchant API has no endpoint to comment on a review (index https://apidocs.yotpo.com/llms.txt); its comment endpoint
 * belongs to the partner-only App Developer API ("Store tokens from api.yotpo.com are not accepted here",
 * https://develop.yotpo.com/reference/comment-on-a-review). A reply is posted in Yotpo (the reply box links there).
 *
 * Yotpo API (read 2026-10-28):
 *   - token: `POST https://api.yotpo.com/oauth/token` `{ client_id: <store ID>, client_secret: <API secret>,
 *            grant_type: "client_credentials" }` → `{ access_token, token_type: "bearer" }`; merchant endpoints take it in
 *            the `X-Yotpo-Token` header. "If a call returns 401, generate a new token and retry the call once."
 *            (https://apidocs.yotpo.com/docs/authenticate-and-make-your-first-call). The store ID ("formerly App Key")
 *            and the API secret are in Yotpo's Account Settings › General Settings; "Only the account administrator can
 *            see the API secret" (https://support.yotpo.com/docs/finding-your-yotpo-app-key-and-secret-key).
 *   - read:  `GET /v1/apps/{store_id}/reviews?count=&page=&since_updated_at=` (https://apidocs.yotpo.com/reference/retrieve-all-reviews):
 *            "up to 100 reviews per page (count)", `since_updated_at` = "Earliest update date of returned reviews"
 *            (YYYY-MM-DD), unpublished reviews only with `deleted=true` → `{ reviews[] }`; a review: id, title, content
 *            ("Special characters are HTML-encoded"), score 1–5, created_at, updated_at, sku ("Your product ID" — the
 *            Shopify product id on a Shopify store), name, email, reviewer_type (verified_buyer | verified_reviewer),
 *            deleted, archived. "limited to 5,000 requests/minute, per app key"; "Data is retrieved with a delay of 1 hour."
 *   - photos and videos: `GET /v1/apps/{store_id}/images/export?source=review&media_type=image|video&page=&per_page=&since=`
 *            (https://apidocs.yotpo.com/reference/get-media): `per_page` up to 100 → `{ response: { pagination, images[] } }`;
 *            a review photo: review_id, original_image_url, standard_resolution, thumbnail; a video: video_url …
 *   - Access: "Integrate via API & Webhooks" is on Yotpo's Premium plan (https://www.yotpo.com/pricing/reviews/).
 *
 * Nexus reads the published reviews: the first read up to 50 pages (5,000 reviews), then only the reviews created or
 * changed since two days before the last read. It keeps the photos as the review's images and marks a video. Never the
 * reviewer's e-mail.
 */
import { plainText } from './shopify-review-app.adapter.js'
import {
  appRawReview, httpsUrl, isoOf, reviewAppFailure, reviewAppFetch, reviewAppJson, ReviewAppError, starsOf, str,
  type AppReviewParsed, type AppReviewPayload, type AppReviewPhoto, type AppReviewRead,
} from './review-app-http.js'

export const YOTPO_API = 'https://api.yotpo.com'
export const YOTPO_PAGE_SIZE = 100
export const YOTPO_MAX_PAGES = 50
export const YOTPO_MEDIA_MAX_PAGES = 20
/** A later read asks for what changed since this long before the last read (Yotpo's dates are whole days, 1 hour late). */
const OVERLAP_MS = 2 * 24 * 60 * 60 * 1000
const KEY_WORDS = 'the store ID or the API secret'

export interface YotpoKey { storeId: string; apiSecret: string }

/** An access token for one read (Yotpo: reuse it, ask again after a 401). Throws ReviewAppError. */
export async function yotpoAccessToken(key: YotpoKey): Promise<string> {
  const res = await reviewAppFetch({
    app: 'YOTPO', base: YOTPO_API, method: 'POST', path: '/oauth/token', headers: {},
    body: { client_id: key.storeId, client_secret: key.apiSecret, grant_type: 'client_credentials' },
  })
  // A wrong store ID or secret answers 401 (or 400 for an unknown client): both mean "paste them again".
  if (res.status === 400) throw reviewAppFailure('YOTPO', 401, 'the sign-in', KEY_WORDS)
  if (!res.ok) throw reviewAppFailure('YOTPO', res.status, 'the sign-in', KEY_WORDS)
  const body = await reviewAppJson('YOTPO', res, 'an access token')
  const token = str(body.access_token)
  if (!token) throw new ReviewAppError('YOTPO', 'bad_answer', res.status, 'Yotpo answered without an access token.')
  return token
}

/**
 * One Yotpo review → a Nexus review, or null (no id, no date, deleted or archived). `media` is what Yotpo holds for it;
 * undefined = this read did not look (the photos Nexus holds stay).
 */
export function parseYotpoReview(input: unknown, media?: { photos: AppReviewPhoto[]; hasVideo: boolean }): AppReviewParsed | null {
  if (!input || typeof input !== 'object') return null
  const r = input as Record<string, unknown>
  const id = str(r.id)
  const postedAt = isoOf(r.created_at)
  if (!id || !postedAt || r.deleted === true || r.archived === true) return null
  const sku = str(r.sku)
  // "yotpo_site_reviews" is the store's own (site) review, about no product.
  const productExternalId = sku && sku !== 'yotpo_site_reviews' ? sku : null
  const payload: AppReviewPayload = {
    source: 'yotpo',
    appReviewId: id,
    productExternalId,
    productTitle: null,
    shopDomain: null,
    status: str(r.reviewer_type),
    photos: media?.photos ?? [],
    hasVideo: media?.hasVideo ?? false,
    storeReply: null,
    updatedAt: isoOf(r.updated_at),
    ...(media ? {} : { mediaKnown: false as const }),
  }
  return {
    raw: appRawReview({
      payload,
      rating: starsOf(r.score),
      title: plainText(r.title) || null,
      body: plainText(r.content),
      authorName: str(r.name),
      verified: r.reviewer_type === 'verified_buyer',
      postedAt,
    }),
    productExternalId,
    editedAt: payload.updatedAt,
  }
}

/** YYYY-MM-DD of a time (Yotpo's date filters). */
const dayOf = (d: Date) => d.toISOString().slice(0, 10)

/** A GET with the token; a 401 asks for a new token and tries once more (Yotpo's own advice). */
async function yotpoGet(key: YotpoKey, auth: { token: string }, path: string, query: Record<string, string | number | boolean | undefined>, what: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await reviewAppFetch({ app: 'YOTPO', base: YOTPO_API, method: 'GET', path, query, headers: { 'X-Yotpo-Token': auth.token } })
    if (res.status === 401 && attempt === 0) {
      auth.token = await yotpoAccessToken(key)
      continue
    }
    if (!res.ok) throw reviewAppFailure('YOTPO', res.status, what, KEY_WORDS)
    return reviewAppJson('YOTPO', res, what)
  }
  throw reviewAppFailure('YOTPO', 401, what, KEY_WORDS)
}

/** The review photos and video marks Yotpo holds, by its review id (since a day, when given). */
export async function readYotpoMedia(key: YotpoKey, auth: { token: string }, opts: { since?: Date | null; maxPages?: number } = {}): Promise<Map<string, { photos: AppReviewPhoto[]; hasVideo: boolean }>> {
  const byReview = new Map<string, { photos: AppReviewPhoto[]; hasVideo: boolean }>()
  const entry = (id: string) => {
    let e = byReview.get(id)
    if (!e) byReview.set(id, (e = { photos: [], hasVideo: false }))
    return e
  }
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? YOTPO_MEDIA_MAX_PAGES, YOTPO_MEDIA_MAX_PAGES))
  for (const mediaType of ['image', 'video'] as const) {
    for (let page = 1; page <= maxPages; page++) {
      const body = await yotpoGet(key, auth, `/v1/apps/${encodeURIComponent(key.storeId)}/images/export`, {
        source: 'review', media_type: mediaType, page, per_page: YOTPO_PAGE_SIZE, since: opts.since ? dayOf(opts.since) : undefined,
      }, 'the review photos')
      const response = body.response && typeof body.response === 'object' ? body.response as Record<string, unknown> : {}
      const items = Array.isArray(response.images) ? response.images as unknown[] : []
      for (const item of items) {
        if (!item || typeof item !== 'object') continue
        const m = item as Record<string, unknown>
        const reviewId = str(m.review_id)
        if (!reviewId) continue
        if (mediaType === 'video') {
          entry(reviewId).hasVideo = true
          continue
        }
        const url = httpsUrl(m.original_image_url) ?? httpsUrl(m.standard_resolution)
        if (url) entry(reviewId).photos.push({ url, thumb: httpsUrl(m.thumbnail) ?? url })
      }
      if (items.length < YOTPO_PAGE_SIZE) break
    }
  }
  return byReview
}

/**
 * Reads the store's published reviews with their photos. `since` (the last read) asks only for what changed after two
 * days before it; without it, the first read takes up to 50 pages. Throws ReviewAppError.
 */
export async function readYotpoReviews(key: YotpoKey, opts: { since?: Date | null; maxPages?: number } = {}): Promise<AppReviewRead> {
  const auth = { token: await yotpoAccessToken(key) }
  const since = opts.since ? new Date(opts.since.getTime() - OVERLAP_MS) : null
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? YOTPO_MAX_PAGES, YOTPO_MAX_PAGES))
  const items: unknown[] = []
  let pages = 0
  let more = true
  for (let page = 1; page <= maxPages; page++) {
    const body = await yotpoGet(key, auth, `/v1/apps/${encodeURIComponent(key.storeId)}/reviews`, {
      count: YOTPO_PAGE_SIZE, page, since_updated_at: since ? dayOf(since) : undefined,
    }, 'the review list')
    if (!Array.isArray(body.reviews)) throw new ReviewAppError('YOTPO', 'bad_answer', 200, 'Yotpo answered without a review list.')
    pages++
    items.push(...body.reviews)
    if (body.reviews.length < YOTPO_PAGE_SIZE) {
      more = false
      break
    }
  }
  const media = items.length > 0 ? await readYotpoMedia(key, auth, { since }) : new Map<string, { photos: AppReviewPhoto[]; hasVideo: boolean }>()
  // A full read saw every photo: a review without one has none. A later read saw only the new photos: a review edited
  // since then but without new photos keeps the ones Nexus holds.
  const none = since ? undefined : { photos: [], hasVideo: false }
  const reviews = items.flatMap((item) => {
    const id = item && typeof item === 'object' ? str((item as { id?: unknown }).id) : null
    const parsed = parseYotpoReview(item, (id ? media.get(id) : undefined) ?? none)
    return parsed ? [parsed] : []
  })
  return { reviews, pages, more }
}
