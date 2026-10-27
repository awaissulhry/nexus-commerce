/**
 * The weekly Amazon topics read (amazon-review-insights.service.ts) against real SQL (PGlite with the production schema)
 * and Amazon's own example answers (the official model's 200 examples): one family read with a child ASIN, at Amazon's
 * documented paths, its topics and its 6-month trends stored on the family's row; a refused trends read, a refused
 * topics read, and Amazon.nl (never asked). The SP-API client is mocked — nothing leaves this machine.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { readStoredTrends } from './amazon-review-trends.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

const examples = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'customer-feedback-2024-06-01.examples.json'), 'utf8')) as {
  getItemReviewTrends: unknown
  getItemReviewTopics: unknown
}

type Call = { method: string; path: string; query: Record<string, unknown>; label?: string }
const amazon = vi.hoisted(() => ({ calls: [] as Call[], refuse: new Set<string>() }))
vi.mock('../../clients/amazon-sp-api.client.js', () => ({
  amazonSpApiClient: {
    request: vi.fn(async (method: string, p: string, opts: { query?: Record<string, unknown>; label?: string } = {}) => {
      amazon.calls.push({ method, path: p, query: opts.query ?? {}, label: opts.label })
      const kind = p.endsWith('/reviews/topics') ? 'topics' : 'trends'
      if (amazon.refuse.has(kind)) throw new Error('HTTP 403 — {"errors":[{"code":"Unauthorized","message":"Access to requested resource is denied."}]}')
      return kind === 'topics' ? examples.getItemReviewTopics : examples.getItemReviewTrends
    }),
  },
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

describe('Amazon topics read with their 6-month trends (real SQL)', () => {
  beforeAll(async () => {
    database = await formulaDatabase()
    await inside(async () => {
      const c = database.client
      for (const [code, marketplaceId] of [['DE', 'TEST-MKT-DE'], ['FR', 'TEST-MKT-FR'], ['NL', 'TEST-MKT-NL']]) {
        await c.marketplace.create({ data: { channel: 'AMAZON', code, name: `Amazon ${code}`, marketplaceId, region: 'EU', currency: 'EUR', language: 'en', isActive: true } as never })
      }
      await c.product.create({ data: { id: 'test-family', sku: 'TEST-FAMILY', name: 'Test family', basePrice: 10, isParent: true, amazonAsin: 'B0TESTPAR1' } as never })
      await c.product.create({ data: { id: 'test-child', sku: 'TEST-FAMILY-M', name: 'Test family M', basePrice: 10, parentId: 'test-family', amazonAsin: 'B0TESTCH01' } as never })
      for (const market of ['DE', 'FR', 'NL']) {
        await c.channelListing.create({ data: {
          productId: 'test-child', channel: 'AMAZON', marketplace: market, region: market, channelMarket: `AMAZON_${market}`, listingStatus: 'ACTIVE',
          externalListingId: 'B0TESTCH01', externalParentId: 'B0TESTPAR1',
        } as never })
      }
    })
  }, 180_000)

  afterAll(async () => {
    await database?.close()
  })

  beforeEach(() => {
    amazon.calls.length = 0
    amazon.refuse.clear()
  })

  it("asks Amazon's documented paths with the child ASIN, stores the family's topics and trends", async () => {
    const { ingestAmazonReviewInsights } = await import('./amazon-review-insights.service.js')
    const result = await inside(() => ingestAmazonReviewInsights({ marketplaceCode: 'DE' }))
    expect(result).toMatchObject({ asinsRequested: 1, upserted: 1, deniedAsins: 0, trendsRead: 1, trendsDenied: 0 })

    expect(amazon.calls).toEqual([
      { method: 'GET', path: '/customerFeedback/2024-06-01/items/B0TESTCH01/reviews/topics', query: { marketplaceId: 'TEST-MKT-DE', sortBy: 'MENTIONS' }, label: 'getItemReviewTopics' },
      { method: 'GET', path: '/customerFeedback/2024-06-01/items/B0TESTCH01/reviews/trends', query: { marketplaceId: 'TEST-MKT-DE' }, label: 'getItemReviewTrends' },
    ])

    const row = await inside(() => database.client.amazonReviewInsight.findFirstOrThrow({ where: { marketplace: 'DE' } }))
    // Keyed by the family; the family's (parent) numbers.
    expect(row).toMatchObject({ asin: 'B0TESTPAR1', productId: 'test-family', accessStatus: 'OK', starRating: null, reviewCount: null })
    expect(row.positiveTopics).toEqual([
      expect.objectContaining({ topic: 'Assembly/Installation', mentionCount: 107, share: 18.01, ratingImpact: 3, snippets: ['Easy installation!', 'Easy to install.', 'Easy to assemble'] }),
      expect.objectContaining({ topic: 'Strong', mentionCount: 107, share: 18.01, ratingImpact: 3.8 }),
    ])
    expect(row.negativeTopics).toEqual([expect.objectContaining({ topic: 'Assembly/Installation', mentionCount: 107, ratingImpact: -2.6 })])

    const trend = readStoredTrends(row.trend)
    expect(trend?.read).toBe('OK')
    expect(trend?.topics.map((t) => [t.polarity, t.topic, t.points.length])).toEqual([
      ['POSITIVE', 'Quality-Overall', 6], ['POSITIVE', 'Assembly/Installation', 6], ['NEGATIVE', 'Weak and fragile', 6],
    ])
    expect(trend?.topics[0].points[0]).toEqual({ month: '2024-01', share: 27.58 })
  })

  it('a refused trends read keeps the topics and says the trend was refused', async () => {
    amazon.refuse.add('trends')
    const { ingestAmazonReviewInsights } = await import('./amazon-review-insights.service.js')
    const result = await inside(() => ingestAmazonReviewInsights({ marketplaceCode: 'FR' }))
    expect(result).toMatchObject({ upserted: 1, deniedAsins: 0, trendsRead: 0, trendsDenied: 1 })
    const row = await inside(() => database.client.amazonReviewInsight.findFirstOrThrow({ where: { marketplace: 'FR' } }))
    expect(row.accessStatus).toBe('OK')
    expect((row.positiveTopics as unknown[]).length).toBe(2)
    expect(readStoredTrends(row.trend)).toMatchObject({ read: 'REFUSED', topics: [] })
  })

  it('a refused topics read (the missing role): the trend is not asked, the row says why', async () => {
    amazon.refuse.add('topics')
    const { ingestAmazonReviewInsights } = await import('./amazon-review-insights.service.js')
    const result = await inside(() => ingestAmazonReviewInsights({ marketplaceCode: 'DE' }))
    expect(result).toMatchObject({ upserted: 1, deniedAsins: 1, trendsRead: 0, trendsDenied: 0 })
    expect(amazon.calls.map((c) => c.label)).toEqual(['getItemReviewTopics'])
    const row = await inside(() => database.client.amazonReviewInsight.findFirstOrThrow({ where: { marketplace: 'DE' } }))
    expect(row).toMatchObject({ accessStatus: 'NEEDS_BRAND_ANALYTICS_ROLE', positiveTopics: [], trend: [] })
    expect(readStoredTrends(row.trend)).toBeNull()
  })

  it('Amazon.nl: Amazon gives no topics there, so nothing is asked', async () => {
    const { ingestAmazonReviewInsights, servesReviewTopics } = await import('./amazon-review-insights.service.js')
    expect(await inside(() => ingestAmazonReviewInsights({ marketplaceCode: 'NL' }))).toMatchObject({ notServed: true, upserted: 0 })
    expect(amazon.calls).toEqual([])
    expect(['UK', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'US'].filter(servesReviewTopics)).toEqual(['UK', 'GB', 'DE', 'FR', 'IT', 'ES'])
  })
})

describe('which ASIN Amazon is asked', () => {
  it('one per family, with a child ASIN (Amazon takes child ASINs only); active listings first; SKUs never', async () => {
    const { pickInsightItems } = await import('./amazon-review-insights.service.js')
    expect(pickInsightItems([
      { externalParentId: 'B0PARENT01', externalListingId: 'B0CHILD002', listingStatus: 'INACTIVE' },
      { externalParentId: 'B0PARENT01', externalListingId: 'B0CHILD001', listingStatus: 'ACTIVE' },
      { externalParentId: null, externalListingId: 'B0SINGLE01', listingStatus: 'ACTIVE' },
      { externalParentId: 'B0PARENT02', externalListingId: 'SELLER-SKU-1', listingStatus: 'ACTIVE' },
    ])).toEqual([
      { asin: 'B0PARENT01', childAsin: 'B0CHILD001', level: 'parent' },
      { asin: 'B0SINGLE01', childAsin: 'B0SINGLE01', level: 'asin' },
    ])
  })
})
