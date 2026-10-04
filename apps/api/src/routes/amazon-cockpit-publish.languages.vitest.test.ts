import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

/**
 * A-22 (R-18) — the cockpit publish builds ONE language's feed, so it refuses a market that carries
 * more, named, per market; the other markets in the same call go ahead. Dry run only: nothing is
 * sent, and every outside service is faked.
 */
const m = vi.hoisted(() => ({
  listing: vi.fn(), product: vi.fn(), marketplace: vi.fn(), resolve: vi.fn(), feed: vi.fn(),
}))
vi.mock('../db.js', () => ({ default: {
  product: { findUnique: m.product },
  channelListing: { findFirst: m.listing },
  marketplace: { findFirst: m.marketplace },
} }))
vi.mock('../services/amazon-market-offer.service.js', () => ({ closedMarketSet: vi.fn(async () => new Set()) }))
vi.mock('../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: vi.fn(async () => 'SELLER'), amazonSpClient: vi.fn() }))
vi.mock('../services/connection-resolver.service.js', () => ({ primaryConnectionIds: vi.fn(async () => new Map([['AMAZON', 'acct']])) }))
vi.mock('../services/pim/mapping/resolve-batch.service.js', () => ({ resolveBatch: m.resolve }))
vi.mock('../services/pim/channel-specs/index.js', () => ({ loadAmazonSpec: vi.fn(async () => ({ fields: [] })) }))
vi.mock('../services/amazon/mapping-payload.js', () => ({ applyResolvedMappingToAmazonFeed: m.feed }))
vi.mock('../services/categories/schema-sync.service.js', () => ({ CategorySchemaService: class {} }))
vi.mock('../services/marketplaces/amazon.service.js', () => ({ AmazonService: class {} }))
vi.mock('../services/amazon/flat-file.service.js', () => ({
  MARKETPLACE_ID_MAP: { IT: 'APJ6JRA9NG5V4', BE: 'AMEN7PMS3EDWL' },
  AmazonFlatFileService: class { async getFeedSchemaHints() { return {} } buildJsonFeedBody() { return '{"messages":[]}' } },
  withAmazonOfferRoots: (body: string) => body,
}))
vi.mock('../services/amazon/offer-facts.js', () => ({ loadAmazonOfferFacts: vi.fn(async (_db: unknown, ids: string[]) => new Map(ids.map(id => [id, {}]))) }))
vi.mock('../services/amazon/send-quantity.js', () => ({ loadAmazonSendQuantity: vi.fn(async () => ({ quantity: 1, fba: false, refusal: null })) }))
vi.mock('../services/amazon-publish-gate.service.js', () => ({ getAmazonPublishMode: () => 'dry-run' }))
vi.mock('../services/listing-preflight.service.js', () => ({ checkLengthLimits: () => [] }))
vi.mock('../clients/amazon-sp-api.client.js', () => ({ amazonSpApiClient: {} }))
vi.mock('../services/listing-issues.service.js', () => ({ mirrorListingIssues: vi.fn() }))
vi.mock('../services/amazon/cockpit-publish-row.js', () => ({ buildRow: () => ({ product_type: 'OUTERWEAR' }), COCKPIT_EXPANDED_FIELDS: {} }))
import cockpitRoutes from './amazon-cockpit-publish.routes.js'

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset()
  m.product.mockResolvedValue({ id: 'p', sku: 'SKU', parentId: null, images: [] })
  m.listing.mockImplementation(async ({ where }: { where: { marketplace: string } }) =>
    ({ id: `l-${where.marketplace}`, productId: 'p', marketplace: where.marketplace, channelConnectionId: 'acct', aliasKey: '', isPublished: true }))
  // Amazon BE carries Dutch and French — the only such market, production and local.
  m.marketplace.mockImplementation(async ({ where }: { where: { code: string } }) =>
    ({ languages: where.code === 'BE' ? ['nl', 'fr'] : ['it'], language: null }))
  m.resolve.mockResolvedValue({ products: [{ category: { channelCategoryId: 'OUTERWEAR' } }] })
  m.feed.mockReturnValue('{"messages":[]}')
})

describe('cockpit publish on a market with more than one language', () => {
  it('refuses Amazon BE by name, before resolving it, and still publishes IT in the same call', async () => {
    const app = Fastify()
    await app.register(cockpitRoutes)
    const res = await app.inject({ method: 'POST', url: '/products/p/publish-amazon', payload: { marketplaces: ['BE', 'IT'], dryRun: true } })
    expect(res.statusCode, res.body).toBe(200)
    const [be, it_] = res.json().submissions
    expect(be).toMatchObject({ marketplace: 'BE', ok: false,
      error: 'Amazon · BE carries 2 languages (nl, fr), and this path sends one. Publish its content through the listing editor, which sends every language.' })
    expect(it_).toMatchObject({ marketplace: 'IT', ok: true, error: null })
    expect(m.resolve.mock.calls.map(call => call[0].marketplace)).toEqual(['IT'])
  })

  // A-23 (R-19): the publisher's map has no NL id; it used to fall back to ITALY's.
  it('refuses a market with no marketplace id instead of sending it to Italy; IT still goes ahead', async () => {
    const app = Fastify()
    await app.register(cockpitRoutes)
    const res = await app.inject({ method: 'POST', url: '/products/p/publish-amazon', payload: { marketplaces: ['NL', 'IT'], dryRun: true } })
    expect(res.statusCode, res.body).toBe(200)
    const [nl, it_] = res.json().submissions
    expect(nl).toMatchObject({ marketplace: 'NL', ok: false, error: 'Amazon · NL has no marketplace id in this publisher, so nothing was sent.' })
    expect(it_).toMatchObject({ marketplace: 'IT', ok: true })
    expect(m.listing.mock.calls.map(call => call[0].where.marketplace)).toEqual(['IT'])
    expect(m.resolve.mock.calls.map(call => call[0].marketplace)).toEqual(['IT'])
  })
})
