/**
 * Reviews PR I × PR G — Etsy's one photo and Judge.me's photos are the review's media (`ReviewMedia`), against real SQL
 * (PGlite with the production schema and policies; Etsy, Judge.me and the AI are never called — the answers are parsed
 * from fixtures):
 *   - a new review stores its photos as media, in order; an edit replaces them as a set, a removed photo goes;
 *   - a review stored before Nexus kept media gets them on the next read;
 *   - the Inbox pop-up returns them for the Lightbox, and says where a Judge.me video is (Judge.me gives no video URL);
 *   - the Etsy and Shopify pages read the photos from the same media (Judge.me's thumbnails kept);
 *   - Okendo and Loox reviews land the same way (channel SHOPIFY, their own dedupe key, photos, the video mark, the
 *     store's reply), and an Okendo review is answered from Nexus while a Loox one links to Loox.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    redis: { connection: null },
  }
})
vi.mock('../review-events.service.js', () => ({
  publishReviewEvent: vi.fn(),
  subscribeReviewEvents: vi.fn(() => () => {}),
  getReviewListenerCount: vi.fn(() => 0),
  replayReviewEventsSince: vi.fn(() => []),
}))
vi.mock('./review-alert-notify.service.js', () => ({ notifyReviewAlert: vi.fn(async () => undefined) }))
vi.mock('./sentiment-extraction.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  extractSentiment: vi.fn(async ({ reviewId }: { reviewId: string }) => ({
    reviewId, label: 'NEUTRAL', score: 0, categories: [], topPhrases: [], model: 'test', inputTokens: 0, outputTokens: 0,
    cacheHitTokens: 0, cacheWriteTokens: 0, costUSD: 0, rawText: '', language: null, english: null,
  })),
  persistSentiment: vi.fn(async () => undefined),
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const NOW = new Date()
const secAgo = (days: number) => Math.floor((NOW.getTime() - days * 24 * 60 * 60 * 1000) / 1000)

/** An Etsy TransactionReview as the OpenAPI v3 schema names its fields. */
const etsyReview = (tx: number, over: Record<string, unknown> = {}) => ({
  shop_id: 123, listing_id: 555, transaction_id: tx, buyer_user_id: 42, rating: 5, review: `Etsy review ${tx}`, language: 'en',
  image_url_fullxfull: `https://i.etsystatic.example/review/${tx}_fullxfull.jpg`,
  create_timestamp: secAgo(10), created_timestamp: secAgo(10), update_timestamp: secAgo(10), updated_timestamp: secAgo(10), ...over,
})

/** A Judge.me review as its API v1 answers it (the e-mail is never kept). */
const jmReview = (id: number, pictures: string[], over: Record<string, unknown> = {}) => ({
  id, title: 'Gloves', body: `Judge.me review ${id}`, rating: 4, product_external_id: '8123456789', created_at: new Date(secAgo(5) * 1000).toISOString(),
  updated_at: new Date(secAgo(5) * 1000).toISOString(), reviewer: { name: `Reviewer ${id}`, email: 'reviewer@example.test' }, verified: 'buyer',
  hidden: false, has_published_pictures: pictures.length > 0, has_published_videos: false,
  pictures: pictures.map((name) => ({ hidden: false, urls: { original: `https://img.judge.example/${name}-o.jpg`, compact: `https://img.judge.example/${name}-c.jpg` } })),
  ...over,
})

const mediaOf = (externalReviewId: string) => inside(async () => {
  const row = await database.client.review.findFirst({ where: { externalReviewId }, include: { media: { orderBy: { position: 'asc' } } } })
  return row!.media.map((m) => [m.url, m.type, m.position])
})

describe('Etsy and Judge.me photos as review media (real SQL)', () => {
  beforeAll(async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    database = await formulaDatabase()
    await inside(async () => {
      // A Judge.me review stored before Nexus kept media: its photos only in rawPayload.
      await database.client.review.create({
        data: {
          id: 'jm-before', channel: 'SHOPIFY', externalReviewId: '70009', body: 'Stored before media', rating: 5, postedAt: new Date(secAgo(20) * 1000),
          ingestSource: 'JUDGEME_API', rawPayload: { source: 'judgeme', judgemeId: '70009', photos: [{ url: 'https://img.judge.example/b-o.jpg', thumb: 'https://img.judge.example/b-c.jpg' }], hasVideo: false, updatedAt: null },
        } as never,
      })
    })
  }, 180_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    await database?.close()
  })

  it('Etsy: the one photo is stored as media; an edit replaces it; a photo Etsy no longer shows goes', async () => {
    const { parseEtsyReview, storeEtsyReviews } = await import('../etsy/reviews-read.js')
    const first = await inside(() => storeEtsyReviews([parseEtsyReview(etsyReview(9001))!, parseEtsyReview(etsyReview(9002, { image_url_fullxfull: null }))!], { connectionMarket: 'IT' }))
    expect(first).toMatchObject({ inserted: 2, updated: 0, errors: [] })
    expect(await mediaOf('9001')).toEqual([['https://i.etsystatic.example/review/9001_fullxfull.jpg', 'image', 0]])
    expect(await mediaOf('9002')).toEqual([])

    // The buyer edited: a new photo. Then Etsy shows none (the buyer removed it or keeps it private).
    const edited = parseEtsyReview(etsyReview(9001, { image_url_fullxfull: 'https://i.etsystatic.example/review/9001b_fullxfull.jpg', update_timestamp: secAgo(1), updated_timestamp: secAgo(1) }))!
    expect(await inside(() => storeEtsyReviews([edited], { connectionMarket: 'IT' }))).toMatchObject({ inserted: 0, updated: 1 })
    expect(await mediaOf('9001')).toEqual([['https://i.etsystatic.example/review/9001b_fullxfull.jpg', 'image', 0]])
    // Nothing changed: nothing written.
    expect(await inside(() => storeEtsyReviews([edited], { connectionMarket: 'IT' }))).toMatchObject({ inserted: 0, updated: 0 })
    const hidden = parseEtsyReview(etsyReview(9001, { image_url_fullxfull: null, update_timestamp: secAgo(1), updated_timestamp: secAgo(1) }))!
    expect(await inside(() => storeEtsyReviews([hidden], { connectionMarket: 'IT' }))).toMatchObject({ updated: 1 })
    expect(await mediaOf('9001')).toEqual([])
  })

  it('Judge.me: the photos in order; an edit replaces them; a review stored before media gets them on the next read', async () => {
    const { parseJudgemeReview } = await import('./adapters/shopify-review-app.adapter.js')
    const { storeAppReviews } = await import('./review-app-connection.service.js')
    const storeJudgemeReviews = (parsed: Parameters<typeof storeAppReviews>[1]) => storeAppReviews('JUDGEME', parsed)
    const video = parseJudgemeReview(jmReview(70001, ['a', 'b'], { has_published_videos: true }))!
    const before = parseJudgemeReview(jmReview(70009, ['b'], { body: 'Stored before media', rating: 5, created_at: new Date(secAgo(20) * 1000).toISOString(), updated_at: null }))!
    const out = await inside(() => storeJudgemeReviews([video, before]))
    expect(out).toMatchObject({ inserted: 1, updated: 1, errors: [] })
    expect(await mediaOf('70001')).toEqual([['https://img.judge.example/a-o.jpg', 'image', 0], ['https://img.judge.example/b-o.jpg', 'image', 1]])
    expect(await mediaOf('70009')).toEqual([['https://img.judge.example/b-o.jpg', 'image', 0]])
    expect(JSON.stringify(await inside(() => database.client.review.findMany({ where: { channel: 'SHOPIFY' } })))).not.toContain('reviewer@example.test')

    const fewer = parseJudgemeReview(jmReview(70001, ['b'], { has_published_videos: true, updated_at: new Date(secAgo(1) * 1000).toISOString() }))!
    expect(await inside(() => storeJudgemeReviews([fewer]))).toMatchObject({ inserted: 0, updated: 1 })
    expect(await mediaOf('70001')).toEqual([['https://img.judge.example/b-o.jpg', 'image', 0]])
  })

  it('the Inbox pop-up gives the photos to the Lightbox and says where the Judge.me video is; the pages read the same media', async () => {
    const { getInboxReview } = await import('./review-detail.service.js')
    const { listInbox } = await import('./review-inbox.service.js')
    const { reviewsShopChannel } = await import('./review-shop-channel.service.js')
    const jm = (await inside(() => database.client.review.findFirst({ where: { externalReviewId: '70001' } })))!
    const detail = (await inside(() => getInboxReview(jm.id)))!
    expect(detail.media.map((m) => [m.url, m.type, m.position])).toEqual([['https://img.judge.example/b-o.jpg', 'image', 0]])
    expect(detail.videoIn).toBe('Judge.me')
    const etsy = (await inside(() => database.client.review.findFirst({ where: { externalReviewId: '9002' } })))!
    expect((await inside(() => getInboxReview(etsy.id)))!).toMatchObject({ media: [], videoIn: null })

    // The Inbox's "Has photos" counts Etsy and Judge.me rows too.
    const withPhotos = await inside(() => listInbox({ photos: '1', channel: 'SHOPIFY' }))
    expect(withPhotos.rows.map((r) => [r.id, r.photos]).sort()).toEqual([[jm.id, 1], ['jm-before', 1]].sort())

    const shopify = await inside(() => reviewsShopChannel({ channel: 'SHOPIFY', now: NOW }))
    const sections = shopify.sections as import('./review-shop-channel.service.js').ShopifySections
    expect(sections.reviews.ok).toBe(true)
    const row = sections.reviews.ok ? sections.reviews.data.rows.find((r) => r.id === jm.id) : undefined
    expect(row).toMatchObject({ photos: 1, photoItems: [{ url: 'https://img.judge.example/b-o.jpg', thumb: 'https://img.judge.example/b-c.jpg' }], hasVideo: true, app: 'JUDGEME' })
    expect(sections.tiles).toMatchObject({ ok: true, data: { withMedia: 2, videos: 1 } })
  })

  it('Okendo and Loox: the same channel, their own ids, photos and the video mark; a reply from Nexus only where the app takes one', async () => {
    const { parseOkendoReview } = await import('./adapters/okendo-review-app.adapter.js')
    const { parseLooxReview } = await import('./adapters/loox-review-app.adapter.js')
    const { storeAppReviews } = await import('./review-app-connection.service.js')
    const { getInboxReview } = await import('./review-detail.service.js')
    const ok = parseOkendoReview({
      reviewId: '3f2c9a8e-5b1d-4c7e-9a6f-1d2e3f4a5b6c', productId: 'shopify-8123456789', title: 'Fits', body: 'Okendo review', rating: 5,
      dateCreated: new Date(secAgo(3) * 1000).toISOString(), status: 'approved', reviewer: { name: 'Tim Cook', displayName: 'Tim C.', email: 'tim@example.test' },
      media: [{ type: 'image', fullSizeUrl: 'https://media.okendo.example/1.jpg', thumbnailUrl: 'https://media.okendo.example/1t.jpg', isHidden: false, streamId: 'a' }, { type: 'video', fullSizeUrl: 'https://media.okendo.example/v', thumbnailUrl: 'https://media.okendo.example/vt.jpg', isHidden: false, streamId: 'b' }],
    })!
    const lx = parseLooxReview({
      id: '64a1f2b3c4d5e6f7a8b9c0d1', rating: 2, body: 'Loox review', createdAt: new Date(secAgo(2) * 1000).toISOString(), verified: true, status: 'published',
      reviewer: { name: 'John Doe', email: 'john@example.test' }, product: { id: '8123456789', url: 'https://mystore.myshopify.com/products/gloves' },
      media: [{ type: 'image', url: 'https://loox.example/p.jpg' }], reply: { body: 'Thank you!' },
    })!
    expect(await inside(() => storeAppReviews('OKENDO', [ok]))).toMatchObject({ inserted: 1, errors: [] })
    expect(await inside(() => storeAppReviews('LOOX', [lx]))).toMatchObject({ inserted: 1, errors: [] })
    // The same read again changes nothing.
    expect(await inside(() => storeAppReviews('LOOX', [lx]))).toMatchObject({ inserted: 0, updated: 0 })
    expect(await mediaOf('okendo:3f2c9a8e-5b1d-4c7e-9a6f-1d2e3f4a5b6c')).toEqual([['https://media.okendo.example/1.jpg', 'image', 0]])
    expect(await mediaOf('loox:64a1f2b3c4d5e6f7a8b9c0d1')).toEqual([['https://loox.example/p.jpg', 'image', 0]])
    const rows = await inside(() => database.client.review.findMany({ where: { externalReviewId: { in: ['okendo:3f2c9a8e-5b1d-4c7e-9a6f-1d2e3f4a5b6c', 'loox:64a1f2b3c4d5e6f7a8b9c0d1'] } }, orderBy: { externalReviewId: 'asc' } }))
    expect(rows.map((r) => [r.channel, r.ingestSource])).toEqual([['SHOPIFY', 'LOOX_API'], ['SHOPIFY', 'OKENDO_API']])
    expect(JSON.stringify(rows)).not.toMatch(/tim@example\.test|john@example\.test/)

    const okDetail = (await inside(() => getInboxReview(rows[1].id)))!
    expect(okDetail).toMatchObject({ videoIn: 'Okendo', app: 'Okendo' })
    // Okendo is not connected in this database: the reply is copied, with a link to Okendo.
    expect(okDetail.reply).toMatchObject({ mode: 'copy', via: 'Okendo', open: { label: 'Reply in Okendo' } })
    const lxDetail = (await inside(() => getInboxReview(rows[0].id)))!
    // Loox: read only — "Reply in Loox" opens the store's Shopify admin; the store's reply on Loox counts as a reply.
    expect(lxDetail.reply).toMatchObject({ mode: 'copy', via: 'Loox', open: { label: 'Reply in Loox', href: 'https://admin.shopify.com/store/mystore/apps/loox' } })
    expect(lxDetail.videoIn).toBeNull()
  })
})
