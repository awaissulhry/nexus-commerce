/**
 * Reviews Insights › Products, the product pop-up and Themes against real SQL (PGlite with the production schema and
 * policies): families with their variants, ratings mixed over channels (eBay feedback as 5/3/1), the return rate
 * (returns with a reason over orders, 30 days), the words a rating's source is shown with, and Amazon: a product
 * Amazon knows only by its topics has NO rating — the row's Amazon starRating / reviewCount is never read (ruling 5).
 * Fixture rows never count. Nothing leaves this machine.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

const { insightsProducts, insightsProductDetail, returnRateOf } = await import('./review-products.service.js')
const { insightsThemes } = await import('./review-themes.service.js')
const { returnRate, ratingSourceWords } = await import('./review-insights-math.js')

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const NOW = new Date()
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000)

let seq = 0
async function review(productId: string, channel: string, marketplace: string | null, rating: number | null, days: number, extra: { source?: string; label?: string; themes?: string[]; body?: string } = {}) {
  seq += 1
  await database.client.review.create({
    data: {
      channel, marketplace, externalReviewId: `test-${seq}`, productId, rating, body: extra.body ?? `Test review ${seq}`, postedAt: daysAgo(days),
      ingestSource: extra.source ?? (channel === 'EBAY' ? 'EBAY_API' : channel === 'AMAZON' ? 'IMPORT_CSV' : 'MANUAL'),
      sentiment: { create: { label: extra.label ?? (rating != null && rating <= 2 ? 'NEGATIVE' : 'POSITIVE'), score: 0, categories: extra.themes ?? [], model: 'test' } },
    } as never,
  })
}

describe('Reviews Insights › Products (real SQL)', () => {
  beforeAll(async () => {
    database = await formulaDatabase()
    await inside(async () => {
      const c = database.client
      await c.product.create({ data: { id: 'test-jacket', sku: 'TEST-JKT', name: 'Test touring jacket', basePrice: 10, isParent: true } as never })
      await c.product.create({ data: { id: 'test-jacket-m', sku: 'TEST-JKT-M', name: 'Test touring jacket M', basePrice: 10, parentId: 'test-jacket', variantAttributes: { Size: 'M', Colour: 'Black' } } as never })
      await c.product.create({ data: { id: 'test-jacket-l', sku: 'TEST-JKT-L', name: 'Test touring jacket L', basePrice: 10, parentId: 'test-jacket', variantAttributes: { Size: 'L' } } as never })
      await c.product.create({ data: { id: 'test-gloves', sku: 'TEST-GLV', name: 'Test gloves', basePrice: 10 } as never })

      // Jacket M: eBay feedback 5, 5, 1 · Shopify 4, 4 · imported Amazon DE 2, 2, 3 (fit complaints) — now.
      for (const r of [5, 5, 1]) await review('test-jacket-m', 'EBAY', 'IT', r, 3, r === 1 ? { themes: ['SHIPPING'] } : {})
      for (const r of [4, 4]) await review('test-jacket-m', 'SHOPIFY', null, r, 4)
      for (const r of [2, 2, 3]) await review('test-jacket-m', 'AMAZON', 'DE', r, 5, { themes: ['FIT_SIZING'], label: 'NEGATIVE' })
      // The period before: Shopify 5, 5, 5 → the rating dropped.
      for (const r of [5, 5, 5]) await review('test-jacket-m', 'SHOPIFY', null, r, 40)
      // Jacket L: three Shopify 5s, and a fixture 1-star that must never count.
      for (const r of [5, 5, 5]) await review('test-jacket-l', 'SHOPIFY', null, r, 2)
      await review('test-jacket-l', 'SHOPIFY', null, 1, 2, { source: 'FIXTURE' })

      // Gloves: Amazon only, by its topics. The row's starRating / reviewCount are Amazon numbers that must never show.
      await c.channelListing.create({ data: { productId: 'test-gloves', channelMarket: 'AMAZON_DE', channel: 'AMAZON', region: 'DE', marketplace: 'DE', listingStatus: 'ACTIVE', externalListingId: 'B0TESTGLV1' } as never })
      await c.amazonReviewInsight.create({
        data: {
          asin: 'B0TESTGLV1', marketplace: 'DE', productId: 'test-gloves', starRating: 4.6, reviewCount: 120, accessStatus: 'OK',
          positiveTopics: [{ topic: 'Comfortable fit', mentionCount: 14, ratingImpact: 0.2, snippets: ['Very comfortable'] }],
          negativeTopics: [{ topic: 'Stitching came apart', mentionCount: 9, ratingImpact: -0.7, share: 8, snippets: ['Seams split after a month'] }],
        } as never,
      })

      // Orders of the last 30 days with jacket M: 4 count, a cancelled one does not; one return with a reason, one without.
      const order = (key: string, status: string, days: number) => c.order.create({
        data: {
          id: `test-order-${key}`, channel: 'SHOPIFY', channelOrderId: `TEST-${key}`, status, currencyCode: 'EUR', totalPrice: '50.00',
          customerName: 'Test Buyer', customerEmail: 'buyer@example.test', shippingAddress: { city: 'Testville' }, fulfillmentMethod: 'MFN', purchaseDate: daysAgo(days),
          items: { create: [{ productId: 'test-jacket-m', sku: 'TEST-JKT-M', quantity: 1, price: '50.00' }] },
        } as never,
      })
      for (const k of ['a', 'b', 'c', 'd']) await order(k, 'DELIVERED', 10)
      await order('x', 'CANCELLED', 10)
      await order('old', 'DELIVERED', 50)
      await c.return.create({ data: { orderId: 'test-order-a', channel: 'SHOPIFY', rmaNumber: 'TEST-RMA-1', status: 'RECEIVED', reason: 'too_small', createdAt: daysAgo(5), items: { create: [{ productId: 'test-jacket-m', sku: 'TEST-JKT-M', quantity: 1 }] } } as never })
      await c.return.create({ data: { orderId: 'test-order-b', channel: 'SHOPIFY', rmaNumber: 'TEST-RMA-2', status: 'RECEIVED', reason: null, createdAt: daysAgo(5), items: { create: [{ productId: 'test-jacket-m', sku: 'TEST-JKT-M', quantity: 1 }] } } as never })
    })
  }, 120_000)

  afterAll(async () => {
    await database?.close()
  })

  it('return rate = returns with a reason over orders (cancelled orders and reasonless returns do not count)', async () => {
    expect(returnRate(1, 4)).toBe(25)
    expect(returnRate(0, 0)).toBeNull()
    const out = await inside(() => insightsProducts({ now: NOW }))
    const jacket = out.families.find((f) => f.familyId === 'test-jacket')!
    const m = jacket.variants.find((v) => v.productId === 'test-jacket-m')!
    expect(m.returnRate).toEqual({ rate: 25, returns: 1, orders: 4 })
    expect(jacket.returnRate).toEqual({ rate: 25, returns: 1, orders: 4 })
    expect(out.tiles.topReturnReason).toMatchObject({ reason: 'Too small', share: 100, returns: 1, product: { id: 'test-jacket' } })
    expect(returnRateOf(['nobody'], { returns: new Map(), reasons: new Map(), orders: new Map(), returnOrder: new Map() })).toBeNull()
  })

  it('families with variants: mixed rating (eBay as 5/3/1), change, top complaint, words — fixtures never count', async () => {
    const out = await inside(() => insightsProducts({ now: NOW }))
    const jacket = out.families.find((f) => f.familyId === 'test-jacket')!
    expect(jacket.variants.map((v) => v.productId)).toEqual(['test-jacket-l', 'test-jacket-m'])
    const m = jacket.variants.find((v) => v.productId === 'test-jacket-m')!
    // (5+5+1+4+4+2+2+3)/8 = 3.25; before 5 → −1.75, to one decimal −1.7
    expect(m).toMatchObject({ rating: 3.25, count: 8, change: -1.7, variant: 'M · Black', tooFew: false })
    expect(m.ratingWords).toBe('stars from every channel; eBay feedback counts as 5, 3 or 1 star; Amazon from imported reviews')
    expect(m.topNegativeTheme).toMatchObject({ key: 'FIT_SIZING', count: 3, from: 'reviews' })
    const l = jacket.variants.find((v) => v.productId === 'test-jacket-l')!
    expect(l).toMatchObject({ rating: 5, count: 3, ratingWords: 'stars from reviews' })
    expect(out.tiles).toMatchObject({ dropped: 1, below4: 1 })
  })

  it('Amazon only by its topics: no rating, no count, and the words say so (never the 4.6 / 120 Amazon numbers)', async () => {
    expect(ratingSourceWords('AMAZON', [])).toBe('No rating data from Amazon — import reviews')
    expect(ratingSourceWords('AMAZON', ['IMPORT_CSV'])).toBe('stars from imported reviews')
    const out = await inside(() => insightsProducts({ now: NOW }))
    const gloves = out.families.find((f) => f.familyId === 'test-gloves')!
    expect(gloves).toMatchObject({ rating: null, count: 0, ratingWords: 'No rating data from Amazon — import reviews', variants: [] })
    expect(gloves.topNegativeTheme).toMatchObject({ key: 'DURABILITY', from: 'amazon_topic', count: 9 })
    expect(JSON.stringify(gloves)).not.toMatch(/4\.6|120/)
  })

  it('filters and pages: a tile, a complaint, a search', async () => {
    const dropped = await inside(() => insightsProducts({ now: NOW, tile: 'dropped' }))
    expect(dropped.families.map((f) => [f.familyId, f.variants.map((v) => v.productId)])).toEqual([['test-jacket', ['test-jacket-m']]])
    const durability = await inside(() => insightsProducts({ now: NOW, theme: 'durability' }))
    expect(durability.families.map((f) => f.familyId)).toEqual(['test-gloves'])
    const search = await inside(() => insightsProducts({ now: NOW, q: 'black' }))
    expect(search.families.map((f) => f.familyId)).toEqual(['test-jacket'])
    const paged = await inside(() => insightsProducts({ now: NOW, pageSize: 1, page: 2 }))
    expect(paged).toMatchObject({ page: 2, pageSize: 1, total: { families: 2 } })
    expect(paged.families).toHaveLength(1)
  })

  it('the product pop-up: rating per channel and market with its source words, spread, themes, fit coming later, latest, returns', async () => {
    const d = await inside(() => insightsProductDetail('test-jacket-m', { now: NOW }))
    expect(d.product).toMatchObject({ id: 'test-jacket-m', family: { id: 'test-jacket' }, variant: 'M · Black' })
    const byLabel = Object.fromEntries(d.markets.map((m) => [m.label, m]))
    expect(byLabel['Amazon Germany']).toMatchObject({ kind: 'stars', rating: 2.33, count: 3, words: 'stars from imported reviews' })
    expect(byLabel['eBay Italy']).toMatchObject({ kind: 'positive', rating: 66.7, count: 3, words: 'seller feedback, % positive' })
    expect(byLabel.Shopify).toMatchObject({ rating: 4, count: 2, change: -1 })
    expect(d.spread).toEqual([2, 2, 1, 2, 1])
    expect(d.fit).toBeNull()
    expect(d.fitWords).toMatch(/comes later/)
    expect(d.latest).toHaveLength(3)
    expect(d.returns).toMatchObject({ windowDays: 30, rate: { rate: 25, returns: 1, orders: 4 }, topReason: { reason: 'Too small', share: 100 } })
    expect(d.themes.find((t) => t.key === 'FIT_SIZING')).toMatchObject({ mentions: 3, share: 38 })

    const gloves = await inside(() => insightsProductDetail('test-gloves', { now: NOW }))
    expect(gloves.markets).toEqual([expect.objectContaining({ label: 'Amazon Germany', rating: null, count: 0, words: 'topics only — No rating data from Amazon; import reviews' })])
    expect(gloves.summary.rating).toBeNull()
    await expect(inside(() => insightsProductDetail('nope', { now: NOW }))).rejects.toMatchObject({ statusCode: 404 })
  })

  it('Themes for Amazon Germany: the imported reviews and Amazon’s topics, no Amazon star rating anywhere', async () => {
    const out = await inside(() => insightsThemes({ channel: 'AMAZON', market: 'DE', now: NOW }))
    expect(out.summary).toMatchObject({ reviewsRead: 3, amazonTopicMarkets: 1 })
    const durability = out.themes.find((t) => t.key === 'DURABILITY')!
    expect(durability).toMatchObject({ mentions: 9, share: 8, starImpactFrom: 'amazon_topic', starImpact: -0.7, sources: { reviews: 0, amazonTopics: 9 } })
    expect(out.amazon.markets).toEqual([expect.objectContaining({ market: 'DE', state: 'ok' })])
    expect(JSON.stringify(out)).not.toMatch(/"starRating"|"reviewCount"/)
    const nl = await inside(() => insightsThemes({ channel: 'AMAZON', market: 'NL', now: NOW }))
    expect(nl.amazon.notOffered).toMatch(/Amazon\.nl/)
    expect(nl.themes).toEqual([])
  })
})
