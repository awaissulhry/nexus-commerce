import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

/**
 * Amazon sheet gaps U4b (bug 10) — the cockpit publish (`POST /products/:id/publish-amazon`, the sheet's PublishControl)
 * sends a full UPDATE, which replaces both offer roots whole. They are built by the ONE builder over the `job` lane:
 * every leaf Nexus or Amazon holds (live price, sale with its dates, min/max/MAP, Automate Pricing rule, handling time,
 * restock date), never a draft; the quantity is the stock job's own (`send-quantity.ts`); FBA gets no merchant entry.
 * Dry run: nothing is sent; the real row builder and feed builder run, every outside service is faked. Expected payloads
 * are written out in full.
 */
const IT = 'APJ6JRA9NG5V4'
const sched = (n: number) => [{ schedule: [{ value_with_tax: n }] }]
const m = vi.hoisted(() => ({
  listing: vi.fn(), product: vi.fn(), sendQuantity: vi.fn(),
  row: null as any, saleWindow: null as any,
}))
vi.mock('../db.js', () => ({ default: {
  product: { findUnique: m.product },
  channelListing: { findFirst: m.listing },
  marketplace: { findFirst: vi.fn(async () => ({ languages: ['it'], language: null })) },
} }))
vi.mock('../services/amazon-market-offer.service.js', () => ({ closedMarketSet: vi.fn(async () => new Set()) }))
vi.mock('../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: vi.fn(async () => 'SELLER'), amazonSpClient: vi.fn() }))
vi.mock('../services/connection-resolver.service.js', () => ({ primaryConnectionIds: vi.fn(async () => new Map([['AMAZON', 'acct']])) }))
vi.mock('../services/pim/mapping/resolve-batch.service.js', () => ({ resolveBatch: vi.fn(async () => ({ products: [{ category: { channelCategoryId: 'GLOVES' } }] })) }))
vi.mock('../services/pim/channel-specs/index.js', () => ({ loadAmazonSpec: vi.fn(async () => ({ fields: [] })) }))
vi.mock('../services/amazon/mapping-payload.js', () => ({ applyResolvedMappingToAmazonFeed: (body: string) => body }))
vi.mock('../services/categories/schema-sync.service.js', () => ({ CategorySchemaService: class {} }))
vi.mock('../services/marketplaces/amazon.service.js', () => ({ AmazonService: class {} }))
vi.mock('../services/amazon-publish-gate.service.js', () => ({ getAmazonPublishMode: () => 'dry-run' }))
vi.mock('../services/listing-preflight.service.js', () => ({ checkLengthLimits: () => [] }))
vi.mock('../clients/amazon-sp-api.client.js', () => ({ amazonSpApiClient: {} }))
vi.mock('../services/listing-issues.service.js', () => ({ mirrorListingIssues: vi.fn() }))
// The real reader over the test's listing (the loader's two reads are the listing and its sale window).
vi.mock('../services/amazon/offer-facts.js', async importOriginal => {
  const real = await importOriginal<typeof import('../services/amazon/offer-facts.js')>()
  return { ...real, loadAmazonOfferFacts: vi.fn(async (_db: unknown, ids: string[], lane: 'job' | 'publish') =>
    new Map(ids.map(id => [id, real.readAmazonOfferFacts({ ...m.row, saleWindow: m.saleWindow }, lane)]))) }
})
vi.mock('../services/amazon/send-quantity.js', () => ({ loadAmazonSendQuantity: m.sendQuantity }))
import cockpitRoutes from './amazon-cockpit-publish.routes.js'

const LISTING = {
  id: 'l-IT', productId: 'p', marketplace: 'IT', channelConnectionId: 'acct', aliasKey: '', isPublished: true,
  price: 49.9, priceOverride: 49.9, followMasterPrice: false, salePrice: 39.9, quantity: 12, quantityOverride: null,
  title: 'Guanti moto', description: 'Guanti', bulletPointsOverride: null,
  platformAttributes: {
    amazonOffer: { minimum_seller_allowed_price: 30, maximum_seller_allowed_price: 60, map_price: 40 },
    amazonFulfillment: { lead_time_to_ship_max_days: 2 },
    // Saved on the sheet, waiting for Publish: never sent by this route.
    amazonOfferDraft: { v: 1, leaves: {
      minimum_seller_allowed_price: { value: 35, base: 30, savedAt: '2026-10-01T00:00:00Z', savedBy: 'u' },
      lead_time_to_ship_max_days: { value: 5, base: 2, savedAt: '2026-10-01T00:00:00Z', savedBy: 'u' },
    } },
    attributes: {
      purchasable_offer: [{ marketplace_id: IT, currency: 'EUR', our_price: sched(49.9),
        automated_pricing_merchandising_rule_plan: [{ merchandising_rule: { rule_id: 'R1' } }] }],
      fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 3, restock_date: '2026-11-01' }],
    },
  },
}
const PRODUCT = { id: 'p', sku: 'SKU', name: 'Guanti moto', brand: 'Xavia', parentId: null, isParent: false, images: [] }
const SENT = { quantity: 7, fba: false, refusal: null, code: null, requested: 7, available: 20, clamped: false, euConflict: null, listingFound: true }

async function publish(): Promise<any> {
  const app = Fastify()
  await app.register(cockpitRoutes)
  const res = await app.inject({ method: 'POST', url: '/products/p/publish-amazon', payload: { marketplaces: ['IT'], dryRun: true } })
  expect(res.statusCode, res.body).toBe(200)
  return res.json().submissions[0]
}
const attributesOf = (submission: any) => submission.payload.messages[0].attributes as Record<string, any>

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-02T09:00:00Z')) })
afterAll(() => { vi.useRealTimers() })
beforeEach(() => {
  m.row = LISTING
  m.saleWindow = { start: '2026-10-10', end: '2026-10-20' }
  m.listing.mockReset().mockImplementation(async () => m.row)
  m.product.mockReset().mockResolvedValue(PRODUCT)
  m.sendQuantity.mockReset().mockResolvedValue(SENT)
})

describe('cockpit publish — both offer roots from the one builder, job lane', () => {
  it('FBM: every live leaf, the sale with its dates, Amazon\'s rule and restock date, the job\'s quantity — no draft value', async () => {
    const submission = await publish()
    expect(submission).toMatchObject({ marketplace: 'IT', ok: true, error: null })
    const message = submission.payload.messages[0]
    expect(message.operationType).toBe('UPDATE')
    expect(message.attributes.purchasable_offer).toEqual([{
      currency: 'EUR', marketplace_id: IT, condition_type: 'new_new',
      our_price: sched(49.9),
      discounted_price: [{ schedule: [{ start_at: '2026-10-10', end_at: '2026-10-20', value_with_tax: 39.9 }] }],
      minimum_seller_allowed_price: sched(30),
      maximum_seller_allowed_price: sched(60),
      map_price: sched(40),
      automated_pricing_merchandising_rule_plan: [{ merchandising_rule: { rule_id: 'R1' } }],
    }])
    expect(message.attributes.fulfillment_availability).toEqual([
      { fulfillment_channel_code: 'DEFAULT', quantity: 7, lead_time_to_ship_max_days: 2, restock_date: '2026-11-01' },
    ])
    expect(m.sendQuantity).toHaveBeenCalledWith(expect.anything(), { listingId: 'l-IT' })
  })

  it('FBA: the fulfilment root is the code alone — no quantity, no handling time, no restock date', async () => {
    m.row = { ...LISTING, platformAttributes: { ...LISTING.platformAttributes, attributes: {
      ...LISTING.platformAttributes.attributes, fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] } } }
    m.sendQuantity.mockResolvedValue({ ...SENT, quantity: null, fba: true, requested: null, available: null })
    const attributes = attributesOf(await publish())
    expect(attributes.fulfillment_availability).toEqual([{ fulfillment_channel_code: 'AMAZON_EU' }])
    expect(attributes.purchasable_offer[0].minimum_seller_allowed_price).toEqual(sched(30))
  })

  it('a quantity the job would refuse sends nothing for that market, with the job\'s sentence', async () => {
    const refusal = 'Nothing was sent to Amazon: no stock location is routed to IT for this listing, so the quantity it may promise cannot be worked out. Route a location to this market in Sync Control.'
    m.sendQuantity.mockResolvedValue({ ...SENT, quantity: null, refusal, code: 'NO_ROUTED_LOCATION' })
    const submission = await publish()
    expect(submission).toMatchObject({ marketplace: 'IT', ok: false, error: refusal })
    expect(submission.payload).toBeUndefined()
  })

  it('a parent carries neither offer root', async () => {
    m.product.mockResolvedValue({ ...PRODUCT, isParent: true })
    const attributes = attributesOf(await publish())
    expect(attributes.purchasable_offer).toBeUndefined()
    expect(attributes.fulfillment_availability).toBeUndefined()
  })

  it('no price anywhere: no offer root (an offer without a price would clear Amazon\'s)', async () => {
    m.row = { ...LISTING, price: null, priceOverride: null, salePrice: null,
      platformAttributes: { amazonOffer: LISTING.platformAttributes.amazonOffer, amazonFulfillment: LISTING.platformAttributes.amazonFulfillment,
        attributes: { fulfillment_availability: LISTING.platformAttributes.attributes.fulfillment_availability } } }
    m.product.mockResolvedValue({ ...PRODUCT, basePrice: null })
    const attributes = attributesOf(await publish())
    expect(attributes.purchasable_offer).toBeUndefined()
    expect(attributes.fulfillment_availability).toEqual([{ fulfillment_channel_code: 'DEFAULT', quantity: 7, lead_time_to_ship_max_days: 2, restock_date: '2026-11-01' }])
  })
})
