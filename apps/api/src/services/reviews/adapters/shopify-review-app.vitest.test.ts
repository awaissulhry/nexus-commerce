/**
 * Reviews PR I — the store's review app (Judge.me): parsing a review (never the e-mail or IP address), the read's calls
 * (URL, header, shop_domain, pages), the reply call's exact shape (`POST /api/v1/replies`, `{ review_id, reply: { content } }`)
 * and the token never reaching a log line or an error. A fake fetch stands in for Judge.me: nothing is called for real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const logged = vi.hoisted(() => ({ lines: [] as unknown[] }))
vi.mock('../../../utils/logger.js', () => {
  const push = (...args: unknown[]) => { logged.lines.push(args) }
  return { logger: { info: push, warn: push, error: push, debug: push } }
})

const {
  normalizeShopDomain, normalizeApiToken, parseJudgemeReview, plainText, readJudgemeReviews, postJudgemeReply, judgemeReplyBody, JUDGEME_PAGE_SIZE,
} = await import('./shopify-review-app.adapter.js')

const TOKEN = 'priv-TOKEN-0123456789abcdef'
const SHOP = 'example-store.myshopify.com'

/** A Judge.me review as https://judge.me/api/docs.yaml (Review) names its fields. */
const jmReview = (over: Record<string, unknown> = {}) => ({
  id: 77001, title: 'Great <b>gloves</b>', body: 'Warm &amp; tough.<br>Would buy again.', rating: 5,
  product_external_id: 8123456789, product_title: 'Winter gloves', product_handle: 'winter-gloves',
  reviewer: { id: 501, name: 'A. Buyer', email: 'buyer@example.com', phone: '+100000000' },
  source: 'email', curated: 'ok', hidden: false, verified: 'buyer', created_at: '2026-10-20T09:00:00+00:00', updated_at: '2026-10-21T10:00:00+00:00',
  ip_address: '203.0.113.9', has_published_pictures: true, has_published_videos: true,
  pictures: [
    { hidden: false, urls: { small: 'https://img.judge.me/s.jpg', compact: 'https://img.judge.me/c.jpg', huge: 'https://img.judge.me/h.jpg', original: 'https://img.judge.me/o.jpg' } },
    { hidden: true, urls: { original: 'https://img.judge.me/hidden.jpg' } },
  ],
  ...over,
})

interface Sent { url: string; method: string; headers: Record<string, string>; body: unknown }
/** Judge.me, faked: the global fetch is replaced for the test (nothing leaves the machine). */
function fakeFetch(answers: Array<{ status: number; body?: unknown }>) {
  const sent: Sent[] = []
  const impl = (async (url: string, init: RequestInit) => {
    sent.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined })
    const a = answers.shift()
    if (!a) throw new Error('no answer configured')
    return new Response(a.body === undefined ? '' : JSON.stringify(a.body), { status: a.status })
  }) as unknown as typeof fetch
  vi.stubGlobal('fetch', impl)
  return { sent }
}

beforeEach(() => {
  logged.lines = []
  // Nothing may reach Judge.me from a test: every fetch is refused unless a test fakes the answers.
  vi.stubGlobal('fetch', async () => { throw new Error('network disabled in tests') })
})

describe('input', () => {
  it('the shop domain is a myshopify address; anything else is refused', () => {
    expect(normalizeShopDomain(' https://Example-Store.myshopify.com/admin ')).toBe(SHOP)
    expect(normalizeShopDomain('example.com')).toBeNull()
    expect(normalizeShopDomain('evil.myshopify.com.attacker.net')).toBeNull()
    expect(normalizeShopDomain(undefined)).toBeNull()
  })
  it('the token is one word of visible characters', () => {
    expect(normalizeApiToken(`  ${TOKEN} `)).toBe(TOKEN)
    expect(normalizeApiToken('short')).toBeNull()
    expect(normalizeApiToken('has a space in it')).toBeNull()
  })
})

describe('parseJudgemeReview', () => {
  it('a Shopify review with the reviewer’s name, never the e-mail, phone or IP address', () => {
    const p = parseJudgemeReview(jmReview())!
    expect(p.raw).toMatchObject({ externalReviewId: '77001', channel: 'SHOPIFY', rating: 5, title: 'Great gloves', body: 'Warm & tough.\nWould buy again.', authorName: 'A. Buyer', verifiedPurchase: true, postedAt: '2026-10-20T09:00:00.000Z' })
    expect(p.productExternalId).toBe('8123456789')
    const stored = JSON.stringify(p)
    expect(stored).not.toContain('buyer@example.com')
    expect(stored).not.toContain('203.0.113.9')
    expect(stored).not.toContain('+100000000')
  })
  it('published photos (original + thumbnail) and the video mark; hidden photos are left out', () => {
    const parsed = parseJudgemeReview(jmReview())!
    const payload = parsed.raw.rawPayload as { photos: unknown; hasVideo: boolean }
    expect(payload.photos).toEqual([{ url: 'https://img.judge.me/o.jpg', thumb: 'https://img.judge.me/c.jpg' }])
    expect(payload.hasVideo).toBe(true)
    // The photos are the review's media (ReviewMedia), in order; a video is a mark only (Judge.me gives no video URL).
    expect(parsed.raw.media).toEqual([{ url: 'https://img.judge.me/o.jpg', type: 'image', position: 0 }])
  })
  it('an archived (hidden) review, or one without an id or date, is not a review', () => {
    expect(parseJudgemeReview(jmReview({ hidden: true }))).toBeNull()
    expect(parseJudgemeReview(jmReview({ id: undefined }))).toBeNull()
    expect(parseJudgemeReview(jmReview({ created_at: 'nope' }))).toBeNull()
  })
  it('plain text from Judge.me’s raw body', () => {
    expect(plainText('<p>One</p><p>Two</p>')).toBe('One\n\nTwo')
    expect(plainText(null)).toBe('')
  })
})

describe('reading', () => {
  it('GET /api/v1/reviews with shop_domain, per_page, page and the X-Api-Token header; stops at a short page', async () => {
    const page1 = Array.from({ length: JUDGEME_PAGE_SIZE }, (_, i) => jmReview({ id: i + 1 }))
    const { sent } = fakeFetch([{ status: 200, body: { current_page: 1, per_page: 100, reviews: page1 } }, { status: 200, body: { current_page: 2, per_page: 100, reviews: [jmReview({ id: 999 })] } }])
    const read = await readJudgemeReviews({ shopDomain: SHOP, apiToken: TOKEN })
    expect(read).toMatchObject({ pages: 2, more: false })
    expect(read.reviews).toHaveLength(101)
    expect(sent[0]).toMatchObject({ method: 'GET', url: `https://api.judge.me/api/v1/reviews?shop_domain=${SHOP}&per_page=100&page=1` })
    expect(sent[0].headers['X-Api-Token']).toBe(TOKEN)
    expect(sent[1].url).toContain('page=2')
  })
  it('a smaller page size from Judge.me is followed, not mistaken for the end', async () => {
    const ten = (from: number) => Array.from({ length: 10 }, (_, i) => jmReview({ id: from + i }))
    fakeFetch([{ status: 200, body: { per_page: 10, reviews: ten(1) } }, { status: 200, body: { per_page: 10, reviews: [] } }])
    const read = await readJudgemeReviews({ shopDomain: SHOP, apiToken: TOKEN })
    expect(read).toMatchObject({ pages: 2, more: false })
    expect(read.reviews).toHaveLength(10)
  })
  it('a refused token says so in words, without the token; nothing logs it', async () => {
    fakeFetch([{ status: 401, body: { error: 'Failed to authenticate' } }])
    const err = await readJudgemeReviews({ shopDomain: SHOP, apiToken: TOKEN }).catch((e: unknown) => e)
    expect(err).toMatchObject({ kind: 'refused', status: 401 })
    expect((err as Error).message).toMatch(/refused the API token/)
    expect((err as Error).message).not.toContain(TOKEN)
    expect(JSON.stringify(logged.lines)).not.toContain(TOKEN)
  })
})

describe('replying', () => {
  it('POST /api/v1/replies with { review_id, reply: { content } } for the store', async () => {
    const { sent } = fakeFetch([{ status: 200 }])
    const res = await postJudgemeReply({ shopDomain: SHOP, apiToken: TOKEN, reviewId: '77001', text: 'Thank you!' })
    expect(res).toEqual({ ok: true, code: 'JUDGEME_200' })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ method: 'POST', url: `https://api.judge.me/api/v1/replies?shop_domain=${SHOP}`, body: { review_id: 77001, reply: { content: 'Thank you!' } } })
    expect(sent[0].headers).toMatchObject({ 'X-Api-Token': TOKEN, 'Content-Type': 'application/json' })
    expect(judgemeReplyBody('abc', 'x')).toEqual({ review_id: 'abc', reply: { content: 'x' } })
  })
  it('422 → not sent, in words; 403 → the token needs replacing; no answer → never throws', async () => {
    fakeFetch([{ status: 422, body: { error: 'nope' } }, { status: 403 }])
    expect(await postJudgemeReply({ shopDomain: SHOP, apiToken: TOKEN, reviewId: '1', text: 'x' }))
      .toMatchObject({ ok: false, code: 'JUDGEME_422' })
    expect(await postJudgemeReply({ shopDomain: SHOP, apiToken: TOKEN, reviewId: '1', text: 'x' }))
      .toMatchObject({ ok: false, refusedKey: true })
    const down = await postJudgemeReply({ shopDomain: SHOP, apiToken: TOKEN, reviewId: '1', text: 'x' })
    expect(down).toMatchObject({ ok: false, code: 'JUDGEME_NO_ANSWER' })
    expect(JSON.stringify(logged.lines)).not.toContain(TOKEN)
  })
  it('a bad shop domain is refused before anything is sent', async () => {
    const { sent } = fakeFetch([{ status: 200 }])
    const res = await postJudgemeReply({ shopDomain: 'example.com', apiToken: TOKEN, reviewId: '1', text: 'x' })
    expect(res.ok).toBe(false)
    expect(sent).toHaveLength(0)
  })
})
