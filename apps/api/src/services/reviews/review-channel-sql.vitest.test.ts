/**
 * Reviews › channel pages — GET /api/reviews/area/channel against real SQL (PGlite with the production schema and
 * policies). Amazon: stars only from imported reviews (a feed's or a fixture's never count), topics from Amazon's
 * Customer Feedback rows (never Amazon.nl), requests by Amazon's answer, products to watch. eBay: eBay's own summary
 * (the eBay read is mocked — nothing leaves this machine), the Inbox's seller-feedback rows, the read state per market.
 * The markets each page exists for, and the product studio card's review numbers.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
const ebay = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('./adapters/ebay-feedback.adapter.js', () => ({
  fetchEbayFeedbackSummary: vi.fn(async (connectionId: string) => {
    ebay.calls.push(connectionId)
    return {
      ok: true,
      summary: {
        score: 1786,
        periods: [{ days: 30, positive: 9, neutral: 1, negative: 0 }, { days: 365, positive: 115, neutral: 5, negative: 1 }],
        dsrPeriod: 'FiftyTwoWeeks',
        dsr: [
          { key: 'ItemAsDescribed', label: 'Item as described', rating: 4.9, count: 118 },
          { key: 'Communication', label: 'Communication', rating: 5, count: 117 },
          { key: 'ShippingTime', label: 'Shipping time', rating: 4.8, count: 119 },
          { key: 'ShippingAndHandlingCharges', label: 'Shipping charges', rating: 4.9, count: 118 },
        ],
      },
    }
  }),
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const NOW = new Date()
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000)

describe('Reviews channel pages (real SQL)', () => {
  beforeAll(async () => {
    database = await formulaDatabase()
    await inside(async () => {
      const c = database.client
      await c.product.create({ data: { id: 'test-jacket', sku: 'TEST-JACKET', name: 'Test jacket', basePrice: 10, isParent: true } as never })
      await c.product.create({ data: { id: 'test-jacket-m', sku: 'TEST-JACKET-M', name: 'Test jacket M', basePrice: 10, parentId: 'test-jacket' } as never })
      await c.product.create({ data: { id: 'test-gloves', sku: 'TEST-GLOVES', name: 'Test gloves', basePrice: 10 } as never })
      const review = (id: string, data: Record<string, unknown>) => c.review.create({
        data: { id, channel: 'AMAZON', marketplace: 'IT', externalReviewId: `TEST-${id}`, body: 'Fine', rating: 4, postedAt: daysAgo(2), ...data } as never,
      })
      // Amazon Italy: three imported now (5, 4, 3), three imported in the 30 days before (5, 5, 5) — a drop of 1 star.
      for (const [i, rating] of [5, 4, 3].entries()) await review(`imp-now-${i}`, { rating, productId: 'test-jacket-m', ingestSource: 'IMPORT_CSV', postedAt: daysAgo(3 + i) })
      for (const i of [0, 1, 2]) await review(`imp-before-${i}`, { rating: 5, productId: 'test-jacket-m', ingestSource: 'IMPORT_CSV', postedAt: daysAgo(40 + i) })
      // Never counted for stars: a review feed's row and a fixture.
      await review('feed-1', { rating: 1, ingestSource: 'AMAZON_VOC', productId: 'test-jacket-m' })
      await review('fixture-1', { rating: 1, ingestSource: 'FIXTURE' })
      // eBay: positive and negative feedback in Germany, one old positive in Italy.
      await review('ebay-de-1', { channel: 'EBAY', marketplace: 'DE', rating: 5, ingestSource: 'EBAY_API', authorName: 'buyer-a', productId: 'test-gloves' })
      await review('ebay-de-2', { channel: 'EBAY', marketplace: 'DE', rating: 1, ingestSource: 'EBAY_API', authorName: 'buyer-b', triageStatus: 'RESPONDED' })
      await review('ebay-it-1', { channel: 'EBAY', marketplace: 'IT', rating: 3, ingestSource: 'EBAY_API', authorName: 'buyer-c', postedAt: daysAgo(200) })

      const topic = (name: string, mentions: number, impact: number) => ({ topic: name, mentionCount: mentions, ratingImpact: impact, snippets: [`about ${name.toLowerCase()}`] })
      await c.amazonReviewInsight.create({ data: {
        asin: 'B0TEST0001', marketplace: 'IT', productId: 'test-jacket', reviewCount: 100, accessStatus: 'OK', fetchedAt: daysAgo(3),
        positiveTopics: [topic('Waterproof', 18, 0.2)], negativeTopics: [topic('Runs small', 9, -0.3), topic('Zip quality', 4, -0.2)],
        // Amazon's 6-month trend (getItemReviewTrends), as the weekly read stores it: a line for "Runs small" only.
        trend: { read: 'OK', at: daysAgo(3).toISOString(), topics: [{ topic: 'Runs small ', polarity: 'NEGATIVE', points: [
          { month: '2026-05', share: 4 }, { month: '2026-06', share: 5 }, { month: '2026-07', share: null },
          { month: '2026-08', share: 6 }, { month: '2026-09', share: 8 }, { month: '2026-10', share: 9 },
        ] }] },
      } as never })
      await c.amazonReviewInsight.create({ data: {
        asin: 'B0TEST0001', marketplace: 'NL', productId: 'test-jacket', reviewCount: 50, accessStatus: 'OK', fetchedAt: daysAgo(3),
        positiveTopics: [topic('Warm', 5, 0.1)], negativeTopics: [],
      } as never })

      const order = (id: string) => c.order.create({ data: {
        id, channel: 'AMAZON', channelOrderId: `405-${id}`, marketplace: 'IT', status: 'DELIVERED', currencyCode: 'EUR', totalPrice: '50.00',
        customerName: 'Test Buyer', customerEmail: `${id}@example.test`, shippingAddress: { city: 'Testville' }, fulfillmentMethod: 'MFN',
        purchaseDate: daysAgo(20), deliveredAt: daysAgo(15),
      } as never })
      for (const id of ['o1', 'o2', 'o3', 'o4']) await order(id)
      await c.reviewRequest.create({ data: { orderId: 'o1', channel: 'AMAZON', marketplace: 'IT', status: 'SENT', sentAt: daysAgo(5) } as never })
      await c.reviewRequest.create({ data: { orderId: 'o2', channel: 'AMAZON', marketplace: 'IT', status: 'SCHEDULED', scheduledFor: new Date(NOW.getTime() + 86_400_000), providerResponseCode: 'OUTSIDE_WINDOW' } as never })
      await c.reviewRequest.create({ data: { orderId: 'o3', channel: 'AMAZON', marketplace: 'IT', status: 'SKIPPED', providerResponseCode: 'ALREADY_SOLICITED' } as never })
      await c.reviewRequest.create({ data: { orderId: 'o4', channel: 'AMAZON', marketplace: 'IT', status: 'FAILED', providerResponseCode: 'HTTP_503', attemptCount: 3 } as never })

      await c.channelConnection.create({ data: { id: 'test-ebay-account', channelType: 'EBAY', marketplace: null, isActive: true, isPrimary: true, authStatus: 'connected' } as never })
      await c.marketplace.create({ data: { channel: 'AMAZON', code: 'FR', name: 'Amazon France', region: 'EU', currency: 'EUR', language: 'fr', isActive: true, isParticipating: true } as never })
    })
  }, 180_000)

  afterAll(async () => {
    await database?.close()
  })

  it('Amazon Italy: stars only from imported reviews; topics, requests and products to watch', async () => {
    const { reviewsChannel } = await import('./review-channel.service.js')
    const page = await inside(() => reviewsChannel({ channel: 'amazon', market: 'it', period: '30d', now: NOW }))
    expect(page).toMatchObject({ channel: 'AMAZON', market: 'IT', label: 'Amazon Italy' })
    const s = page.sections as import('./review-channel.service.js').AmazonSections
    if (!s.tiles.ok || !s.spread.ok || !s.topics.ok || !s.requests.ok || !s.watch.ok || !s.trend.ok) throw new Error(JSON.stringify(s))

    // 5, 4, 3 imported in the period → 4.0; the feed's 1 star and the fixture never count.
    expect(s.tiles.data).toMatchObject({ importedRating: 4, importedInPeriod: 3, importedTotal: 6, topicsToFix: 2, requestsSent: 1 })
    expect(s.spread.data).toMatchObject({ counts: [1, 1, 1, 0, 0], average: 4, rated: 3 })
    expect(s.trend.data.bucket).toBe('week')
    expect(s.trend.data.points.reduce((n, p) => n + p.reviews, 0)).toBe(3)

    expect(s.topics.data).toMatchObject({ state: 'ok', words: null, productCount: 1 })
    expect(s.topics.data.dislike.map(t => [t.label, t.mentions, t.share, t.impact])).toEqual([['Runs small', 9, 9, -0.3], ['Zip quality', 4, 4, -0.2]])
    expect(s.topics.data.like.map(t => t.label)).toEqual(['Waterproof'])
    // Each topic carries Amazon's 6-month trend, or why it has none.
    expect(s.topics.data.dislike[0].trend).toEqual({ state: 'ok', reads: 1, products: 1, markets: 1, points: [
      { month: '2026-05', share: 4 }, { month: '2026-06', share: 5 }, { month: '2026-07', share: null },
      { month: '2026-08', share: 6 }, { month: '2026-09', share: 8 }, { month: '2026-10', share: 9 },
    ] })
    expect(s.topics.data.dislike[1].trend).toEqual({ state: 'none' })
    expect(s.topics.data.like[0].trend).toEqual({ state: 'none' })
    expect(s.topics.data.products[0].dislike[0].trend).toMatchObject({ state: 'ok', reads: 1 })
    expect(s.topics.data.products).toEqual([expect.objectContaining({ key: 'test-jacket', name: 'Test jacket' })])
    expect(s.topics.data.where).toMatch(/not on Amazon\.nl/)

    expect(s.requests.data).toMatchObject({ sent: 1, tooEarly: 1, alreadyAsked: 1, failed: 1, notAllowed: 0 })

    // The variant's imported stars dropped from 5.0 to 4.0 (three on each side).
    expect(s.watch.data[0]).toMatchObject({ productId: 'test-jacket-m', ratingNow: 4, ratingBefore: 5, change: -1, imported: 3 })
    // The parent has topics but no imported review: "No rating data from Amazon", last.
    expect(s.watch.data.find(r => r.productId === 'test-jacket')).toMatchObject({ ratingNow: null, topTopic: 'Runs small', topShare: 9 })

    // The chips: markets with reviews, topics or Amazon's participation.
    expect(page.markets.map(m => m.code)).toEqual(['IT', 'FR', 'NL'])
  })

  it('Amazon.nl: no topics, whatever rows exist', async () => {
    const { reviewsChannel } = await import('./review-channel.service.js')
    const page = await inside(() => reviewsChannel({ channel: 'AMAZON', market: 'NL', now: NOW }))
    const s = page.sections as import('./review-channel.service.js').AmazonSections
    if (!s.topics.ok || !s.tiles.ok) throw new Error('read')
    expect(s.topics.data).toMatchObject({ state: 'not_on_market', words: 'Amazon gives no review topics on Amazon.nl.', like: [], dislike: [] })
    expect(s.tiles.data.topicsToFix).toBeNull()
    expect(s.tiles.data.importedRating).toBeNull()
  })

  it("eBay Germany: eBay's numbers for the whole account (one sign-in for every site), the feedback list, read once", async () => {
    // PR G — the leave-feedback queue: one sale waits in Germany, one in Italy; the German page's tile counts one.
    await inside(async () => {
      const c = database.client
      for (const market of ['DE', 'IT']) {
        await c.order.create({ data: {
          id: `ebay-o-${market}`, channel: 'EBAY', channelOrderId: `12-00000-0000${market === 'DE' ? 1 : 2}`, marketplace: market, status: 'DELIVERED',
          currencyCode: 'EUR', totalPrice: '40.00', customerName: 'Test Buyer', customerEmail: `ebay-${market}@example.test`,
          shippingAddress: { city: 'Testville' }, purchaseDate: daysAgo(10),
        } as never })
        await c.ebayBuyerFeedback.create({ data: { connectionId: 'test-ebay-account', orderLineItemId: `TEST-LINE-${market}`, orderId: `ebay-o-${market}`, lastSeenAt: NOW } as never })
      }
    })
    const { reviewsChannel } = await import('./review-channel.service.js')
    const page = await inside(() => reviewsChannel({ channel: 'EBAY', market: 'DE', period: '12m', now: NOW }))
    const s = page.sections as import('./review-channel.service.js').EbaySections
    if (!s.tiles.ok || !s.summary.ok || !s.feedback.ok || !s.readState.ok) throw new Error(JSON.stringify(s))
    expect(s.summary.data).toMatchObject({ state: 'read', accountWide: true, accounts: 1, score: 1786 })
    expect(s.summary.data.dsr.map(d => d.rating)).toEqual([4.9, 5, 4.8, 4.9])
    // eBay's 12-month % positive (115 ÷ 116), not the two rows Nexus holds for Germany. Needs a reply: none — the
    // positive feedback needs none (Owner 2026-10-27) and the negative one was answered.
    expect(s.tiles.data).toMatchObject({ score: 1786, positivePct: 99.1, positiveFrom: 'ebay', positive: 1, neutral: 0, negative: 1, needReply: 0 })
    expect(s.tiles.data.buyersToRate).toMatchObject({ awaiting: 1, ready: 1, waitingApproval: 0, readAt: NOW.toISOString() })
    expect(s.feedback.data.rows.map(r => r.id).sort()).toEqual(['ebay-de-1', 'ebay-de-2'])
    expect(s.feedback.data.rows.find(r => r.id === 'ebay-de-2')).toMatchObject({ kind: 'seller', status: 'RESPONDED' })
    expect(s.readState.data.map(r => r.market)).toEqual(['DE'])

    // A second page within the hour asks eBay nothing.
    await inside(() => reviewsChannel({ channel: 'EBAY', now: NOW }))
    expect(ebay.calls).toEqual(['test-ebay-account'])
  })

  it('refuses a page that is not Amazon or eBay, and a market that is not two letters', async () => {
    const { reviewsChannel, ChannelInputError } = await import('./review-channel.service.js')
    await expect(inside(() => reviewsChannel({ channel: 'SHOPIFY' }))).rejects.toBeInstanceOf(ChannelInputError)
    await expect(inside(() => reviewsChannel({ channel: 'AMAZON', market: 'ITA' }))).rejects.toBeInstanceOf(ChannelInputError)
  })

  it("the sub-sidebar's markets: per channel, in the menu's order", async () => {
    const { reviewChannelMarkets } = await import('./review-channel.service.js')
    const markets = await inside(() => reviewChannelMarkets())
    expect(markets.AMAZON.map(m => m.code)).toEqual(['IT', 'FR', 'NL'])
    expect(markets.EBAY).toEqual([{ code: 'IT', label: 'Italy' }, { code: 'DE', label: 'Germany' }])
  })

  it("the product studio card: the product's and its variants' reviews, Amazon from imports only, eBay as % positive", async () => {
    const { getProductAnalytics } = await import('../product-analytics.service.js')
    const jacket = await inside(() => getProductAnalytics(database.client as never, 'test-jacket'))
    // Six imported reviews of the variant (5, 4, 3, 5, 5, 5): the feed's 1 star never counts.
    expect(jacket?.reviews).toMatchObject({ avgRating: 4.5, reviewCount: 6, byChannel: [{ channel: 'AMAZON', kind: 'stars', rating: 4.5, count: 6 }] })
    const gloves = await inside(() => getProductAnalytics(database.client as never, 'test-gloves'))
    expect(gloves?.reviews).toMatchObject({ avgRating: null, reviewCount: 0, byChannel: [{ channel: 'EBAY', kind: 'positive', rating: 100, count: 1 }] })
  })
})
