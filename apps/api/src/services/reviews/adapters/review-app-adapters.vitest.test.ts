/**
 * Reviews (2026-10-28) — the Okendo, Yotpo and Loox adapters against fixtures built from each app's documented answers
 * (Okendo: the Merchant REST API spec's schema and its example values, https://docs.okendo.io/docs/open-api/merchant-rest-api/list-reviews;
 * Yotpo: the docs' example answers verbatim, https://apidocs.yotpo.com/reference/retrieve-all-reviews and
 * https://apidocs.yotpo.com/reference/get-media; Loox: the spec's example answer verbatim,
 * https://developers.loox.app/documentation/). Parsing (never the e-mail), the calls (URL, auth header, paging), the
 * reply's exact shape (Okendo only) and a key never reaching a log line or an error. A fake fetch stands in for every app.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const logged = vi.hoisted(() => ({ lines: [] as unknown[] }))
vi.mock('../../../utils/logger.js', () => {
  const push = (...args: unknown[]) => { logged.lines.push(args) }
  return { logger: { info: push, warn: push, error: push, debug: push } }
})

const okendo = await import('./okendo-review-app.adapter.js')
const yotpo = await import('./yotpo-review-app.adapter.js')
const loox = await import('./loox-review-app.adapter.js')
const http = await import('./review-app-http.js')

const SECRET = 'app-SECRET-0123456789abcdef'

interface Sent { url: string; method: string; headers: Record<string, string>; body: unknown }
/** The app, faked: the global fetch answers from the list (nothing leaves the machine). */
function fakeFetch(answers: Array<{ status: number; body?: unknown }>) {
  const sent: Sent[] = []
  vi.stubGlobal('fetch', (async (url: string, init: RequestInit) => {
    sent.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined })
    const a = answers.shift()
    if (!a) throw new Error('no answer configured')
    return new Response(a.body === undefined ? '' : JSON.stringify(a.body), { status: a.status })
  }) as unknown as typeof fetch)
  return { sent }
}

beforeEach(() => {
  logged.lines = []
  vi.stubGlobal('fetch', async () => { throw new Error('network disabled in tests') })
})

// ── Okendo ──────────────────────────────────────────────────────────

/** An Okendo review as the Merchant REST API schema names its fields (values from the spec's examples). */
const okendoReview = (over: Record<string, unknown> = {}) => ({
  subscriberId: '0f9d5e1a-1111-4a2b-9c3d-2e4f6a8b0c1d',
  reviewId: '3f2c9a8e-5b1d-4c7e-9a6f-1d2e3f4a5b6c',
  productId: 'shopify-123456789',
  productName: 'MacBook Pro',
  title: 'Love these shoes!',
  body: 'Great quality! Great price! Would buy again!',
  rating: 5,
  dateCreated: '2026-10-20T09:00:00.000Z',
  status: 'approved',
  helpfulCount: 0,
  unhelpfulCount: 0,
  reviewer: { name: 'Tim Cook', displayName: 'Tim C.', email: 'tim@example.com', isVerified: true, verifiedStatus: 'Verified Buyer', location: { country: { code: 'au', name: 'Australia' } } },
  media: [
    { streamId: '11111111-2222-4333-8444-555555555555', type: 'image', fullSizeUrl: 'https://media.okendo.example/full.jpg', largeUrl: 'https://media.okendo.example/large.jpg', thumbnailUrl: 'https://media.okendo.example/thumb.jpg', isHidden: false },
    { streamId: '66666666-2222-4333-8444-555555555555', type: 'image', fullSizeUrl: 'https://media.okendo.example/hidden.jpg', thumbnailUrl: 'https://media.okendo.example/hidden-t.jpg', isHidden: true },
    { streamId: '77777777-2222-4333-8444-555555555555', type: 'video', fullSizeUrl: 'https://media.okendo.example/video', thumbnailUrl: 'https://media.okendo.example/video-t.jpg', isHidden: false },
  ],
  reply: { body: '<p><b>Thanks</b> for your review</p>', rawBody: '*Thanks* for your review', isPrivate: false },
  ...over,
})

describe('Okendo', () => {
  it('a review: text, stars, the display name (never the e-mail), the Shopify product, photos without the hidden one, the video mark, the store’s reply', () => {
    const parsed = okendo.parseOkendoReview(okendoReview())!
    expect(parsed.productExternalId).toBe('123456789')
    expect(parsed.raw).toMatchObject({
      externalReviewId: 'okendo:3f2c9a8e-5b1d-4c7e-9a6f-1d2e3f4a5b6c', channel: 'SHOPIFY', rating: 5, title: 'Love these shoes!',
      body: 'Great quality! Great price! Would buy again!', authorName: 'Tim C.', verifiedPurchase: true, postedAt: '2026-10-20T09:00:00.000Z',
      media: [{ url: 'https://media.okendo.example/full.jpg', type: 'image', position: 0 }],
    })
    expect(parsed.raw.rawPayload).toMatchObject({ source: 'okendo', photos: [{ url: 'https://media.okendo.example/full.jpg', thumb: 'https://media.okendo.example/thumb.jpg' }], hasVideo: true, storeReply: '*Thanks* for your review' })
    expect(JSON.stringify(parsed)).not.toContain('tim@example.com')
    expect(okendo.parseOkendoReview(okendoReview({ status: 'pending' }))).toBeNull()
    expect(okendo.parseOkendoReview(okendoReview({ dateCreated: 'never' }))).toBeNull()
  })

  it('reads newest first with Basic auth and the API version, following the cursor of nextUrl (never its URL)', async () => {
    const { sent } = fakeFetch([
      { status: 200, body: { reviews: [okendoReview()], nextUrl: '/reviews?lastEvaluated=%7B%22k%22%3A1%7D&limit=100' } },
      { status: 200, body: { reviews: [okendoReview({ reviewId: '4f2c9a8e-5b1d-4c7e-9a6f-1d2e3f4a5b6c' })] } },
    ])
    const read = await okendo.readOkendoReviews({ userId: '0f9d5e1a-1111-4a2b-9c3d-2e4f6a8b0c1d', apiKey: SECRET })
    expect(read).toMatchObject({ pages: 2, more: false })
    expect(read.reviews).toHaveLength(2)
    expect(sent[0].url).toBe('https://api.okendo.io/enterprise/reviews?limit=100&orderBy=date+desc&status=approved')
    expect(sent[1].url).toBe('https://api.okendo.io/enterprise/reviews?limit=100&orderBy=date+desc&status=approved&lastEvaluated=%7B%22k%22%3A1%7D')
    expect(sent[0].headers['okendo-api-version']).toBe('2025-02-01')
    expect(sent[0].headers.Authorization).toBe(`Basic ${Buffer.from(`0f9d5e1a-1111-4a2b-9c3d-2e4f6a8b0c1d:${SECRET}`).toString('base64')}`)
    expect(JSON.stringify(logged.lines)).not.toContain(SECRET)
  })

  it('a refused key is a fix in words without the key; the reply body is the documented one', async () => {
    fakeFetch([{ status: 401 }])
    const err = await okendo.readOkendoReviews({ userId: '0f9d5e1a-1111-4a2b-9c3d-2e4f6a8b0c1d', apiKey: SECRET }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(http.ReviewAppError)
    expect((err as InstanceType<typeof http.ReviewAppError>).kind).toBe('refused')
    expect(String((err as Error).message)).not.toContain(SECRET)
    expect(okendo.okendoReplyBody('Thank you for your feedback!')).toEqual({ reply: { body: 'Thank you for your feedback!', isPrivate: false }, shouldEmailReply: true })
    expect(await okendo.postOkendoReply({ userId: 'x', apiKey: SECRET }, '../../admin', 'Hi')).toMatchObject({ ok: false, code: 'OKENDO_NOT_SENT' })
  })
})

// ── Yotpo ───────────────────────────────────────────────────────────

/** The first review of the docs' example answer, verbatim. */
const YOTPO_REVIEW = { id: 34789515, title: 'GREAT shirts', content: 'I now have several of these shirts and they are great. Great quality and look. My only minor complaint is that I have had one or two that have been SLIGHTLY on the small side. That said, their order process is easy and the product is great I will continue to buy most of my shirts from them.', score: 4, votes_up: 0, votes_down: 0, created_at: '2016-12-27T14:43:58.000Z', updated_at: '2017-04-13T18:56:19.000Z', sentiment: 0.963555, sku: '1', name: 'Robert S.', email: 'robsmith@example.com', reviewer_type: 'verified_buyer', deleted: false, user_reference: null, is_incentivized: true, incentive_type: 'free_product' }
/** A review photo of the docs' media example, verbatim (review 69982867). */
const YOTPO_PHOTO = { source: 'review', review_id: 69982867, image_id: 58948851, standard_resolution: 'https://ddcfq0gxiontw.cloudfront.net/Review/69982867/58948851/standard.jpg?1538599248', thumbnail: 'https://ddcfq0gxiontw.cloudfront.net/Review/69982867/58948851/square.jpg?1538599248', low_resolution: 'https://ddcfq0gxiontw.cloudfront.net/Review/69982867/58948851/medium_square.jpg?1538599248', original_image_url: 'https://ddcfq0gxiontw.cloudfront.net/Review/69982867/58948851/original.jpg?1538599248', tagged_products: ['538465337388'], post: { title: 'Love it!', content: 'Love the product!', user_name: 'Stacey', user_email: 'stacey@example.com' }, albums: null }
const media = (images: unknown[]) => ({ status: { code: 200, message: 'OK' }, response: { pagination: { page: 1, per_page: 100, total: images.length }, images } })

describe('Yotpo', () => {
  it('a review: HTML-decoded text, the score, the verified buyer, the product key; deleted, archived or site-wide handled', () => {
    const parsed = yotpo.parseYotpoReview({ ...YOTPO_REVIEW, content: 'Fits &amp; looks great' }, { photos: [], hasVideo: false })!
    expect(parsed.raw).toMatchObject({ externalReviewId: 'yotpo:34789515', rating: 4, title: 'GREAT shirts', body: 'Fits & looks great', authorName: 'Robert S.', verifiedPurchase: true, postedAt: '2016-12-27T14:43:58.000Z', media: [] })
    expect(parsed.productExternalId).toBe('1')
    expect(JSON.stringify(parsed)).not.toContain('robsmith@example.com')
    expect(yotpo.parseYotpoReview({ ...YOTPO_REVIEW, deleted: true })).toBeNull()
    expect(yotpo.parseYotpoReview({ ...YOTPO_REVIEW, archived: true })).toBeNull()
    expect(yotpo.parseYotpoReview({ ...YOTPO_REVIEW, sku: 'yotpo_site_reviews' })!.productExternalId).toBeNull()
    // Photos not looked at by this read: the photos Nexus holds stay (no media given).
    expect(yotpo.parseYotpoReview(YOTPO_REVIEW)!.raw.media).toBeUndefined()
  })

  it('a first read: token, every page of reviews, then the review photos and videos matched by review id', async () => {
    const { sent } = fakeFetch([
      { status: 200, body: { access_token: 'tok-1', token_type: 'bearer' } },
      { status: 200, body: { reviews: [YOTPO_REVIEW, { ...YOTPO_REVIEW, id: 69982867 }] } },
      { status: 200, body: media([YOTPO_PHOTO]) },
      { status: 200, body: media([{ source: 'review', review_id: 34789515, video_url: 'https://example.invalid/video' }]) },
    ])
    const read = await yotpo.readYotpoReviews({ storeId: 'AbCdEf0123456789', apiSecret: SECRET })
    expect(sent[0]).toMatchObject({ url: 'https://api.yotpo.com/oauth/token', method: 'POST', body: { client_id: 'AbCdEf0123456789', client_secret: SECRET, grant_type: 'client_credentials' } })
    expect(sent[1].url).toBe('https://api.yotpo.com/v1/apps/AbCdEf0123456789/reviews?count=100&page=1')
    expect(sent[1].headers['X-Yotpo-Token']).toBe('tok-1')
    expect(sent[2].url).toBe('https://api.yotpo.com/v1/apps/AbCdEf0123456789/images/export?source=review&media_type=image&page=1&per_page=100')
    expect(read).toMatchObject({ pages: 1, more: false })
    const [first, second] = read.reviews
    expect(first.raw.rawPayload).toMatchObject({ photos: [], hasVideo: true })
    expect(first.raw.media).toEqual([])
    expect(second.raw.media).toEqual([{ url: YOTPO_PHOTO.original_image_url, type: 'image', position: 0 }])
    expect(second.raw.rawPayload).toMatchObject({ photos: [{ url: YOTPO_PHOTO.original_image_url, thumb: YOTPO_PHOTO.thumbnail }] })
    expect(JSON.stringify(read)).not.toContain('stacey@example.com')
    expect(JSON.stringify(logged.lines)).not.toContain(SECRET)
    expect(JSON.stringify(logged.lines)).not.toContain('tok-1')
  })

  it('a later read asks only for what changed since two days before it; a 401 asks for a new token once', async () => {
    const { sent } = fakeFetch([
      { status: 200, body: { access_token: 'tok-1' } },
      { status: 401 },
      { status: 200, body: { access_token: 'tok-2' } },
      { status: 200, body: { reviews: [YOTPO_REVIEW] } },
      { status: 200, body: media([]) },
      { status: 200, body: media([]) },
    ])
    const read = await yotpo.readYotpoReviews({ storeId: 'AbCdEf0123456789', apiSecret: SECRET }, { since: new Date('2026-10-27T10:00:00Z') })
    expect(sent[1].url).toBe('https://api.yotpo.com/v1/apps/AbCdEf0123456789/reviews?count=100&page=1&since_updated_at=2026-10-25')
    expect(sent[3].headers['X-Yotpo-Token']).toBe('tok-2')
    expect(sent[4].url).toContain('since=2026-10-25')
    // Edited since, no new photo: the photos Nexus holds stay.
    expect(read.reviews[0].raw.media).toBeUndefined()
  })

  it('a wrong store ID or secret is a fix in words', async () => {
    fakeFetch([{ status: 401, body: { error: 'invalid_client' } }])
    const err = await yotpo.readYotpoReviews({ storeId: 'AbCdEf0123456789', apiSecret: SECRET }).catch((e: unknown) => e)
    expect(err).toMatchObject({ kind: 'refused' })
    expect(String((err as Error).message)).toBe('Yotpo refused the store ID or the API secret (HTTP 401). Paste them again from Yotpo.')
  })
})

// ── Loox ────────────────────────────────────────────────────────────

/** The docs' example product review, verbatim. */
const LOOX_REVIEW = { id: '64a1f2b3c4d5e6f7a8b9c0d1', rating: 5, body: 'Amazing quality, fast shipping!', date: '2024-01-15T00:00:00.000Z', createdAt: '2024-01-15T08:30:00.000Z', verified: true, status: 'published', reviewer: { name: 'John Doe', firstName: 'John', lastName: 'Doe', nickname: null, email: 'john.doe@example.com', customerId: '5234567890123' }, orderId: '4567890123456', isFeatured: false, product: { id: '7891234567890', name: 'Classic White T-Shirt', url: 'https://mystore.myshopify.com/products/classic-white-t-shirt', imageUrl: 'https://cdn.shopify.com/s/files/1/0001/classic-white-t-shirt.jpg' }, media: [{ type: 'image', url: 'https://loox.io/assets/reviews/64a1f2b3c4d5e6f7a8b9c0d1/photo.jpg' }], reply: { body: 'Thank you for the kind words!', repliedAt: '2024-01-16T10:00:00.000Z' }, customQuestions: [], highlights: ['great quality', 'fast shipping'], originalLanguage: 'en', location: { country: 'United States', countryCode: 'US' } }
/** The docs' example store review, verbatim. */
const LOOX_STORE_REVIEW = { id: '64a1f2b3c4d5e6f7a8b9c0d2', rating: 5, body: 'Fantastic store, will shop again!', createdAt: '2024-02-10T09:00:00.000Z', status: 'published', reviewer: { name: 'Sarah Miller', firstName: 'Sarah', lastName: 'Miller', nickname: null, email: 'sarah.miller@example.com', customerId: '6345678901234' }, reply: null, originalLanguage: 'en' }

describe('Loox', () => {
  it('a review: text, stars, the name, the Shopify product, the photo ("image" or "photo"), a video mark, the store’s reply and its myshopify address', () => {
    const parsed = loox.parseLooxReview({ ...LOOX_REVIEW, media: [...LOOX_REVIEW.media, { type: 'photo', url: 'https://loox.io/p2.jpg' }, { type: 'video', url: 'https://loox.io/v.m3u8', thumbnailUrl: 'https://loox.io/v.jpg' }] })!
    expect(parsed.productExternalId).toBe('7891234567890')
    expect(parsed.raw).toMatchObject({
      externalReviewId: 'loox:64a1f2b3c4d5e6f7a8b9c0d1', rating: 5, body: 'Amazing quality, fast shipping!', authorName: 'John Doe', verifiedPurchase: true, postedAt: '2024-01-15T08:30:00.000Z',
      media: [{ url: 'https://loox.io/assets/reviews/64a1f2b3c4d5e6f7a8b9c0d1/photo.jpg', type: 'image', position: 0 }, { url: 'https://loox.io/p2.jpg', type: 'image', position: 1 }],
    })
    expect(parsed.raw.title).toBeUndefined()
    expect(parsed.raw.rawPayload).toMatchObject({ source: 'loox', hasVideo: true, storeReply: 'Thank you for the kind words!', shopDomain: 'mystore.myshopify.com', productTitle: 'Classic White T-Shirt' })
    expect(JSON.stringify(parsed)).not.toContain('john.doe@example.com')
    expect(loox.parseLooxReview({ ...LOOX_REVIEW, status: 'pending' })).toBeNull()
    expect(loox.parseLooxReview(LOOX_STORE_REVIEW)).toMatchObject({ productExternalId: null, raw: { externalReviewId: 'loox:64a1f2b3c4d5e6f7a8b9c0d2', media: [] } })
  })

  it('reads product then store reviews, newest first, with the key in X-Api-Secret-Key, page by page while hasMore', async () => {
    const { sent } = fakeFetch([
      { status: 200, body: { reviews: [LOOX_REVIEW], pagination: { total: 2, page: 1, limit: 250, hasMore: true, nextPageUrl: '/api/v1/store/4JG3Fn92E.37d12ab29/product-reviews?page=2&limit=250&total=2' } } },
      { status: 200, body: { reviews: [{ ...LOOX_REVIEW, id: '64a1f2b3c4d5e6f7a8b9c0d9' }], pagination: { total: 2, page: 2, limit: 250, hasMore: false, nextPageUrl: null } } },
      { status: 200, body: { reviews: [LOOX_STORE_REVIEW], pagination: { total: 1, page: 1, limit: 250, hasMore: false, nextPageUrl: null } } },
    ])
    const read = await loox.readLooxReviews({ storeId: '4JG3Fn92E.37d12ab29', apiKey: SECRET })
    expect(read).toMatchObject({ pages: 3, more: false })
    expect(read.reviews.map((r) => r.raw.externalReviewId)).toEqual(['loox:64a1f2b3c4d5e6f7a8b9c0d1', 'loox:64a1f2b3c4d5e6f7a8b9c0d9', 'loox:64a1f2b3c4d5e6f7a8b9c0d2'])
    expect(sent[0].url).toBe('https://api.loox.io/api/v1/store/4JG3Fn92E.37d12ab29/product-reviews?status=published&sort=date&direction=desc&limit=250&page=1')
    expect(sent[1].url).toContain('page=2')
    expect(sent[2].url).toBe('https://api.loox.io/api/v1/store/4JG3Fn92E.37d12ab29/store-reviews?status=published&sort=date&direction=desc&limit=250&page=1')
    expect(sent[0].headers['X-Api-Secret-Key']).toBe(SECRET)
    expect(JSON.stringify(logged.lines)).not.toContain(SECRET)
  })

  it('a refused key (HTTP 401) is a fix in words', async () => {
    fakeFetch([{ status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Invalid or missing API key.' } } }])
    expect(await loox.readLooxReviews({ storeId: '4JG3Fn92E.37d12ab29', apiKey: SECRET }).catch((e: unknown) => e)).toMatchObject({ kind: 'refused', message: 'Loox refused the store ID or the API key (HTTP 401). Paste them again from Loox.' })
  })
})

describe('the shared sender', () => {
  it('only a path under the app’s own base; no answer is words, not a crash', async () => {
    await expect(http.reviewAppFetch({ app: 'LOOX', base: 'https://api.loox.io', method: 'GET', path: 'https://evil.example/x', headers: {} })).rejects.toThrow('Invalid review app path.')
    await expect(http.reviewAppFetch({ app: 'LOOX', base: 'https://api.loox.io', method: 'GET', path: '/a/../b', headers: {} })).rejects.toThrow('Invalid review app path.')
    await expect(http.reviewAppFetch({ app: 'LOOX', base: 'https://api.loox.io', method: 'GET', path: '/x', headers: {} })).rejects.toMatchObject({ kind: 'no_answer', message: 'Loox did not answer. Nexus tries again at the next read.' })
    expect(http.appReviewIdOf('OKENDO', 'okendo:abc')).toBe('abc')
    expect(http.appReviewIdOf('OKENDO', 'yotpo:abc')).toBeNull()
    expect(http.myshopifyHostOf('https://www.shop.example/products/x')).toBeNull()
  })
})
