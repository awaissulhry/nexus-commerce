/**
 * Reviews PR I — Etsy shop reviews: parsing Etsy's TransactionReview, the reply window from the buyer's LAST EDIT, the
 * page path, the read going through the account reader (the channel gateway), what an edit changes, and the switch.
 * Only the gateway, the account and the token are stubbed (as receipts-read.vitest.test.ts does); nothing calls Etsy.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ pages: [] as unknown[], calls: [] as Array<{ url: string; channel: string; kind: string }> }))
vi.mock('../gateway/gateway.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gateway/gateway.js')>()),
  gatewayFetch: vi.fn(async (req: { url: string; channel: string; kind: string }) => {
    h.calls.push({ url: req.url, channel: req.channel, kind: req.kind })
    const body = h.pages.shift()
    if (body === undefined) throw new Error('no page configured')
    return new Response(JSON.stringify(body), { status: 200 })
  }),
}))
vi.mock('./account.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./account.js')>()),
  etsyAccount: vi.fn(async (accountId: string) => ({ accountId, shopId: '123', apiKey: 'key:secret' })),
}))
vi.mock('../cx/token.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cx/token.service.js')>()),
  getAccessToken: vi.fn(async () => 'etsy-token'),
}))
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const {
  parseEtsyReview, etsyReviewsPath, readEtsyShopReviews, etsyChanges, etsyReviewsReadOn, readEtsyReviewsOnce, ETSY_REVIEWS_PAGE,
} = await import('./reviews-read.js')
const { etsyWindow } = await import('../reviews/review-shop-channel-math.js')

const NOW = new Date('2026-10-27T12:00:00Z')
const secAgo = (days: number) => Math.floor((NOW.getTime() - days * 24 * 60 * 60 * 1000) / 1000)

/** An Etsy TransactionReview as the OpenAPI v3 schema names its fields. */
const etsyReview = (over: Record<string, unknown> = {}) => ({
  shop_id: 123, listing_id: 555, transaction_id: 9001, buyer_user_id: 42, rating: 5, review: 'Lovely jacket, fits well.',
  language: 'en', image_url_fullxfull: 'https://i.etsystatic.com/review/abc_fullxfull.jpg',
  create_timestamp: secAgo(40), created_timestamp: secAgo(40), update_timestamp: secAgo(3), updated_timestamp: secAgo(3), ...over,
})

beforeEach(() => { h.pages = []; h.calls = [] })

describe('parseEtsyReview', () => {
  it('keeps the rating, text, language, the one photo and the ids; the transaction is the review id', () => {
    const p = parseEtsyReview(etsyReview())!
    expect(p.raw).toMatchObject({ externalReviewId: '9001', channel: 'ETSY', rating: 5, body: 'Lovely jacket, fits well.', authorId: '42', verifiedPurchase: true })
    expect(p.raw.postedAt).toBe(new Date(secAgo(40) * 1000).toISOString())
    expect(p).toMatchObject({ transactionId: '9001', listingId: '555', language: 'en' })
    expect(p.raw.rawPayload).toMatchObject({ source: 'etsy', image_url_fullxfull: 'https://i.etsystatic.com/review/abc_fullxfull.jpg', listing_id: 555 })
  })

  it('the buyer’s last edit is the update time when it is after the creation, else the creation', () => {
    expect(parseEtsyReview(etsyReview())!.editedAt).toBe(new Date(secAgo(3) * 1000).toISOString())
    const never = parseEtsyReview(etsyReview({ update_timestamp: secAgo(40), updated_timestamp: secAgo(40) }))!
    expect(never.editedAt).toBe(never.raw.postedAt)
    const missing = parseEtsyReview(etsyReview({ update_timestamp: undefined, updated_timestamp: undefined }))!
    expect(missing.editedAt).toBe(missing.raw.postedAt)
  })

  it('fields Etsy hides for privacy are simply absent; an empty review keeps its stars', () => {
    const p = parseEtsyReview(etsyReview({ buyer_user_id: null, image_url_fullxfull: null, review: '' }))!
    expect(p.raw.authorId).toBeUndefined()
    expect(p.raw.body).toBe('')
    expect((p.raw.rawPayload as { image_url_fullxfull: unknown }).image_url_fullxfull).toBeNull()
  })

  it('refuses what cannot be a review: no transaction, no date, a rating outside 1–5, a non-https photo', () => {
    expect(parseEtsyReview(etsyReview({ transaction_id: undefined }))).toBeNull()
    expect(parseEtsyReview(etsyReview({ create_timestamp: undefined, created_timestamp: undefined }))).toBeNull()
    expect(parseEtsyReview(etsyReview({ rating: 6 }))).toBeNull()
    expect(parseEtsyReview(null)).toBeNull()
    expect((parseEtsyReview(etsyReview({ image_url_fullxfull: 'http://x/y.jpg' }))!.raw.rawPayload as { image_url_fullxfull: unknown }).image_url_fullxfull).toBeNull()
  })
})

describe('the reply window counts 100 days from the buyer’s last edit', () => {
  it('posted 150 days ago but edited 3 days ago: day 4 of 100, open', () => {
    const p = parseEtsyReview(etsyReview({ create_timestamp: secAgo(150), created_timestamp: secAgo(150) }))!
    expect(etsyWindow({ postedAt: p.raw.postedAt, editedAt: p.editedAt }, NOW)).toMatchObject({ day: 4, daysLeft: 97, closed: false })
  })
  it('never edited, posted 101 days ago: closed', () => {
    const p = parseEtsyReview(etsyReview({ create_timestamp: secAgo(101), created_timestamp: secAgo(101), update_timestamp: secAgo(101), updated_timestamp: secAgo(101) }))!
    expect(etsyWindow({ postedAt: p.raw.postedAt, editedAt: p.editedAt }, NOW)).toMatchObject({ closed: true, daysLeft: 0 })
  })
})

describe('reading a shop', () => {
  it('the page path: the account’s shop, limit 100, an offset and the look-back window', () => {
    expect(etsyReviewsPath('123', { offset: 200, minCreated: 1_700_000_000 })).toBe('/shops/123/reviews?limit=100&offset=200&min_created=1700000000')
    expect(() => etsyReviewsPath('12x', { offset: 0, minCreated: 1_700_000_000 })).toThrow(/shop identity/)
    expect(() => etsyReviewsPath('123', { offset: -1, minCreated: 1_700_000_000 })).toThrow(/offset/)
  })

  it('reads page by page through the gateway (Etsy, read) until a short page', async () => {
    const full = Array.from({ length: ETSY_REVIEWS_PAGE }, (_, i) => etsyReview({ transaction_id: 1000 + i }))
    h.pages = [{ count: 101, results: full }, { count: 101, results: [etsyReview({ transaction_id: 5000 })] }]
    const read = await readEtsyShopReviews('account-1', { now: NOW })
    expect(read).toMatchObject({ pages: 2, count: 101, more: false })
    expect(read.reviews).toHaveLength(101)
    expect(h.calls.map((c) => [c.channel, c.kind])).toEqual([['ETSY', 'read'], ['ETSY', 'read']])
    expect(h.calls[0].url).toMatch(/^https:\/\/api\.etsy\.com\/v3\/application\/shops\/123\/reviews\?limit=100&offset=0&min_created=\d+$/)
    expect(h.calls[1].url).toContain('offset=100')
  })

  it('stops at the page cap and says more wait', async () => {
    const full = Array.from({ length: ETSY_REVIEWS_PAGE }, (_, i) => etsyReview({ transaction_id: 1 + i }))
    h.pages = [{ count: 500, results: full }]
    const read = await readEtsyShopReviews('account-1', { now: NOW, maxPages: 1 })
    expect(read).toMatchObject({ pages: 1, more: true })
  })

  it('an answer without a list is a failure, not an empty shop', async () => {
    h.pages = [{ count: 0 }]
    await expect(readEtsyShopReviews('account-1', { now: NOW })).rejects.toThrow(/without a review list/)
  })
})

describe('an edit updates the stored review', () => {
  const parsed = parseEtsyReview(etsyReview({ rating: 3, review: 'Changed my mind, sleeves short.' }))!
  it('new stars and text, the edit time and the photo; the old translation is dropped', () => {
    const change = etsyChanges({ rating: 5, body: 'Lovely jacket, fits well.', channelEditedAt: new Date(secAgo(40) * 1000), rawPayload: {} }, parsed)
    expect(change).toMatchObject({ rating: 3, body: 'Changed my mind, sleeves short.', bodyEnglish: null })
    expect((change!.channelEditedAt as Date).toISOString()).toBe(parsed.editedAt)
  })
  it('nothing changed → nothing written', () => {
    const same = { rating: 3, body: 'Changed my mind, sleeves short.', channelEditedAt: new Date(parsed.editedAt!), rawPayload: parsed.raw.rawPayload }
    expect(etsyChanges(same, parsed)).toBeNull()
  })
})

describe('the switch', () => {
  it('off unless NEXUS_ENABLE_ETSY_REVIEWS_READ is 1; off reads nothing', async () => {
    expect(etsyReviewsReadOn({})).toBe(false)
    expect(etsyReviewsReadOn({ NEXUS_ENABLE_ETSY_REVIEWS_READ: 'true' })).toBe(false)
    expect(etsyReviewsReadOn({ NEXUS_ENABLE_ETSY_REVIEWS_READ: '1' })).toBe(true)
    const before = process.env.NEXUS_ENABLE_ETSY_REVIEWS_READ
    delete process.env.NEXUS_ENABLE_ETSY_REVIEWS_READ
    try {
      expect(await readEtsyReviewsOnce({ now: NOW })).toEqual({ enabled: false, accounts: [] })
      expect(h.calls).toHaveLength(0)
    } finally {
      if (before !== undefined) process.env.NEXUS_ENABLE_ETSY_REVIEWS_READ = before
    }
  })
})
