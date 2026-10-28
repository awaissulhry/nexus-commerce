/**
 * Reviews channel pages — every reply tile counts the rows its link opens in the Inbox (lane N8, 2026-10-28), against
 * real SQL (PGlite with the production schema and policies). The Etsy page's "Not replied yet", "Window closing" and
 * "Window closed" and the Shopify page's "Needs a reply" follow the ONE needs-a-reply rule (review-visibility.ts): a
 * positive review (4–5 stars, or no stars and a happy mood), an answered, imported or fixture row never count, and an
 * Etsy review whose 100-day window (from the buyer's last edit) closed counts only under "Window closed" — so the Inbox
 * the tile links to shows exactly the tile's number. The Amazon and eBay pages' "Needs a reply" are held to the same.
 * Each list row says why it needs no reply by the same rule (`noReply`). Nothing leaves this machine: no channel is called.
 *
 * The links are the literal addresses the web builds (reviewsLinks.ts `needsReplyHref`, `etsyClosingHref`,
 * `etsyClosedHref`; the web's shopChannelModel and reviewsLinks tests assert the same strings).
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
// eBay's feedback summary is never read here (no eBay account is connected); a call would fail the test.
vi.mock('./adapters/ebay-feedback.adapter.js', () => ({
  fetchEbayFeedbackSummary: vi.fn(async () => { throw new Error('no eBay call in this test') }),
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const NOW = new Date()
const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY)

/** The Inbox address a tile links to, as the web writes it → the Inbox's own query parameters. */
const linkParams = (href: string) => Object.fromEntries(new URLSearchParams(href.slice(href.indexOf('?') + 1)))
const LINKS = {
  etsyNotReplied: '/marketing/reviews/inbox?period=all&channel=ETSY&reply=needed',
  etsyClosing: '/marketing/reviews/inbox?period=all&channel=ETSY&reply=closing',
  etsyClosed: '/marketing/reviews/inbox?period=all&channel=ETSY&reply=closed',
  shopifyNeedReply: '/marketing/reviews/inbox?period=all&channel=SHOPIFY&reply=needed',
  amazonItNeedReply: '/marketing/reviews/inbox?period=all&channel=AMAZON&market=IT&reply=needed',
  ebayItNeedReply: '/marketing/reviews/inbox?period=all&channel=EBAY&market=IT&reply=needed',
}

/** The rows the Inbox shows for a link: its total and every id (one page of 200 holds them all here). */
async function inboxRows(href: string): Promise<{ total: number; ids: string[] }> {
  const { listInbox } = await import('./review-inbox.service.js')
  const page = await inside(() => listInbox({ ...linkParams(href), pageSize: 200 }, NOW))
  return { total: page.total, ids: page.rows.map((r) => r.id).sort() }
}

describe('channel reply tiles = the Inbox rows they link to (real SQL)', () => {
  beforeAll(async () => {
    database = await formulaDatabase()
    await inside(async () => {
      const c = database.client
      const review = (id: string, data: Record<string, unknown>) => c.review.create({
        data: { id, externalReviewId: `TEST-${id}`, body: 'Strap feels thin.', rating: 2, postedAt: daysAgo(5), ...data } as never,
      })
      const etsy = (id: string, data: Record<string, unknown>) => review(id, { channel: 'ETSY', marketplace: 'IT', ingestSource: 'ETSY_API', ...data })
      // Etsy — needs a reply: inside the window and not positive.
      await etsy('etsy-open-2', { rating: 2, postedAt: daysAgo(20), channelEditedAt: daysAgo(20) }) // 80 days left
      await etsy('etsy-closing-1', { rating: 1, postedAt: daysAgo(150), channelEditedAt: daysAgo(96) }) // 4 days left, from the last edit
      await etsy('etsy-closing-3', { rating: 3, postedAt: daysAgo(92), channelEditedAt: null }) // 8 days left, never edited
      // Etsy — never work: positive (also when its window closes soon), answered, imported, a fixture, the window closed.
      await etsy('etsy-happy-5', { rating: 5, postedAt: daysAgo(10), channelEditedAt: null })
      await etsy('etsy-happy-4-closing', { rating: 4, postedAt: daysAgo(130), channelEditedAt: daysAgo(95) })
      await etsy('etsy-answered', { rating: 2, postedAt: daysAgo(3), triageStatus: 'RESPONDED' })
      await etsy('etsy-imported', { rating: 1, postedAt: daysAgo(4), ingestSource: 'IMPORT_CSV' })
      await etsy('etsy-fixture', { rating: 1, postedAt: daysAgo(4), ingestSource: 'FIXTURE' })
      // Etsy — needed a reply, but the 100 days from the last edit ran out ("Window closed").
      await etsy('etsy-closed', { rating: 1, postedAt: daysAgo(130), channelEditedAt: daysAgo(120) })
      await etsy('etsy-closed-noedit', { rating: 3, postedAt: daysAgo(101), channelEditedAt: null })
      // Etsy — window closed, but never needed a reply: positive, answered, imported.
      await etsy('etsy-closed-happy', { rating: 5, postedAt: daysAgo(140), channelEditedAt: daysAgo(110) })
      await etsy('etsy-closed-answered', { rating: 2, postedAt: daysAgo(150), triageStatus: 'RESPONDED' })
      await etsy('etsy-closed-imported', { rating: 1, postedAt: daysAgo(150), ingestSource: 'IMPORT_CSV' })

      const shop = (id: string, data: Record<string, unknown>) => review(id, { channel: 'SHOPIFY', marketplace: null, ingestSource: 'JUDGEME', ...data })
      // Shopify — needs a reply: a 2-star review three days old (the oldest that waits).
      await shop('shop-low', { rating: 2, postedAt: daysAgo(3) })
      // Shopify — never work: a positive review older than it, a happy review with no stars, an answered and an imported one.
      await shop('shop-happy', { rating: 5, postedAt: daysAgo(30) })
      await shop('shop-mood-happy', { rating: null, postedAt: daysAgo(40) })
      await c.reviewSentiment.create({ data: { reviewId: 'shop-mood-happy', label: 'POSITIVE', score: 0.8, categories: [], model: 'test' } as never })
      await shop('shop-answered', { rating: 1, postedAt: daysAgo(50), triageStatus: 'RESPONDED' })
      await shop('shop-imported', { rating: 1, postedAt: daysAgo(60), ingestSource: 'IMPORT_CSV' })

      // Amazon Italy: seller feedback can take a reply; a product review never can (Amazon lets nobody reply).
      await review('amz-seller-2', { channel: 'AMAZON', marketplace: 'IT', kind: 'SELLER', ingestSource: 'AMAZON_SELLER_FEEDBACK', rating: 2 })
      await review('amz-product-1', { channel: 'AMAZON', marketplace: 'IT', kind: 'PRODUCT', ingestSource: 'AMAZON_VOC', rating: 1 })
      // eBay Italy: negative feedback waits; positive and eBay's automatic feedback never do.
      await review('ebay-neg', { channel: 'EBAY', marketplace: 'IT', ingestSource: 'EBAY_API', rating: 1, postedAt: daysAgo(2) })
      await review('ebay-pos', { channel: 'EBAY', marketplace: 'IT', ingestSource: 'EBAY_API', rating: 5, postedAt: daysAgo(9) })
      await review('ebay-auto', { channel: 'EBAY', marketplace: 'IT', ingestSource: 'EBAY_API', rating: 5, body: 'Order delivered on time with no issues', postedAt: daysAgo(12) })
    })
  }, 180_000)

  afterAll(async () => {
    await database?.close()
  })

  it('the service counts with the very addresses the web links to', async () => {
    const { REPLY_TILE_LINKS } = await import('./review-shop-channel.service.js')
    expect(REPLY_TILE_LINKS.etsyNotReplied).toEqual(linkParams(LINKS.etsyNotReplied))
    expect(REPLY_TILE_LINKS.etsyClosing).toEqual(linkParams(LINKS.etsyClosing))
    expect(REPLY_TILE_LINKS.etsyClosed).toEqual(linkParams(LINKS.etsyClosed))
    expect(REPLY_TILE_LINKS.shopifyNeedReply).toEqual(linkParams(LINKS.shopifyNeedReply))
  })

  it('Etsy: "Not replied yet", "Window closing" and "Window closed" are the Inbox rows they open — positive reviews never count', async () => {
    const { reviewsShopChannel } = await import('./review-shop-channel.service.js')
    const page = await inside(() => reviewsShopChannel({ channel: 'ETSY', now: NOW }))
    const s = page.sections as import('./review-shop-channel.service.js').EtsySections
    if (!s.tiles.ok) throw new Error(JSON.stringify(s.tiles))

    const open = await inboxRows(LINKS.etsyNotReplied)
    expect(open.ids).toEqual(['etsy-closing-1', 'etsy-closing-3', 'etsy-open-2'])
    expect(s.tiles.data.notReplied).toBe(open.total)
    expect(open.total).toBe(3)

    const closing = await inboxRows(LINKS.etsyClosing)
    expect(closing.ids).toEqual(['etsy-closing-1', 'etsy-closing-3'])
    expect(s.tiles.data.closing).toBe(closing.total)
    expect(closing.total).toBe(2)

    // Needed a reply, the window ran out: never the positive, answered or imported ones whose window closed too.
    const closed = await inboxRows(LINKS.etsyClosed)
    expect(closed.ids).toEqual(['etsy-closed', 'etsy-closed-noedit'])
    expect(s.tiles.data.closed).toBe(closed.total)
    expect(closed.total).toBe(2)

    // The page's own count of reviews is every visible Etsy row (the fixture never shows).
    expect(s.tiles.data.reviews).toBe(12)
  })

  it('Etsy and Shopify lists: each row says why it needs no reply, by the same rule (null = needs one)', async () => {
    const { reviewsShopChannel } = await import('./review-shop-channel.service.js')
    const etsy = (await inside(() => reviewsShopChannel({ channel: 'ETSY', now: NOW }))).sections as import('./review-shop-channel.service.js').EtsySections
    if (!etsy.reviews.ok) throw new Error(JSON.stringify(etsy.reviews))
    const why = new Map(etsy.reviews.data.rows.map((r) => [r.id, r.noReply]))
    expect(Object.fromEntries(['etsy-open-2', 'etsy-closing-1', 'etsy-happy-5', 'etsy-happy-4-closing', 'etsy-answered', 'etsy-imported', 'etsy-closed', 'etsy-closed-happy'].map((id) => [id, why.get(id)])))
      .toEqual({
        'etsy-open-2': null, 'etsy-closing-1': null, 'etsy-happy-5': 'positive', 'etsy-happy-4-closing': 'positive',
        'etsy-answered': 'closed', 'etsy-imported': 'imported', 'etsy-closed': 'window_closed', 'etsy-closed-happy': 'window_closed',
      })
    // Exactly the rows "Not replied yet" opens need a reply.
    expect(etsy.reviews.data.rows.filter((r) => r.noReply == null).map((r) => r.id).sort()).toEqual((await inboxRows(LINKS.etsyNotReplied)).ids)

    const shop = (await inside(() => reviewsShopChannel({ channel: 'SHOPIFY', now: NOW }))).sections as import('./review-shop-channel.service.js').ShopifySections
    if (!shop.reviews.ok) throw new Error(JSON.stringify(shop.reviews))
    expect(Object.fromEntries(shop.reviews.data.rows.map((r) => [r.id, r.noReply])))
      .toEqual({ 'shop-low': null, 'shop-happy': 'positive', 'shop-mood-happy': 'positive', 'shop-answered': 'closed', 'shop-imported': 'imported' })
  })

  it('Etsy: the Inbox`s reply=closing is Needs you`s closing list — one rule, never a second count', async () => {
    const { reviewNeedsYou } = await import('./review-needs-you.service.js')
    const needs = await inside(() => reviewNeedsYou({ only: 'reply', channel: 'ETSY', now: NOW }))
    const closingItems = needs.items.filter((i) => i.dueAt).map((i) => i.id).sort()
    expect(closingItems).toEqual((await inboxRows(LINKS.etsyClosing)).ids)
    expect(needs.counts.reply).toBe((await inboxRows(LINKS.etsyNotReplied)).total)
  })

  it('Shopify: "Needs a reply" is the Inbox rows it opens, and the oldest wait is the oldest of them', async () => {
    const { reviewsShopChannel } = await import('./review-shop-channel.service.js')
    const page = await inside(() => reviewsShopChannel({ channel: 'SHOPIFY', now: NOW }))
    const s = page.sections as import('./review-shop-channel.service.js').ShopifySections
    if (!s.tiles.ok) throw new Error(JSON.stringify(s.tiles))

    const waiting = await inboxRows(LINKS.shopifyNeedReply)
    expect(waiting.ids).toEqual(['shop-low'])
    expect(s.tiles.data.needReply).toBe(waiting.total)
    // The 5-star review of 30 days ago no longer sets "oldest": the 2-star one of three days ago does.
    expect(s.tiles.data.oldestWaitHours).toBe(Math.floor((3 * DAY) / HOUR))
  })

  it('Amazon and eBay: "Needs a reply" is the Inbox rows it opens', async () => {
    const { reviewsChannel } = await import('./review-channel.service.js')
    const amazon = await inside(() => reviewsChannel({ channel: 'AMAZON', market: 'IT', period: '30d', now: NOW }))
    const a = amazon.sections as import('./review-channel.service.js').AmazonSections
    if (!a.tiles.ok) throw new Error(JSON.stringify(a.tiles))
    const amazonRows = await inboxRows(LINKS.amazonItNeedReply)
    expect(amazonRows.ids).toEqual(['amz-seller-2'])
    expect(a.tiles.data.needReply).toBe(amazonRows.total)

    const ebay = await inside(() => reviewsChannel({ channel: 'EBAY', market: 'IT', period: '30d', now: NOW }))
    const e = ebay.sections as import('./review-channel.service.js').EbaySections
    if (!e.tiles.ok) throw new Error(JSON.stringify(e.tiles))
    const ebayRows = await inboxRows(LINKS.ebayItNeedReply)
    expect(ebayRows.ids).toEqual(['ebay-neg'])
    expect(e.tiles.data.needReply).toBe(ebayRows.total)
  })
})
