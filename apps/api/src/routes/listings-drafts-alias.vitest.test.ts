/**
 * Aliases (Owner 2026-10-05) — the Drafts lens's "Publish →" opens the studio on the draft's own listing: the drafts read
 * names each draft's account and listing alias ('' = the main listing). Fake ids only; the database is mocked.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

const mocks = vi.hoisted(() => ({ listings: vi.fn(), products: vi.fn() }))
vi.mock('../db.js', () => ({ default: { channelListing: { findMany: mocks.listings }, product: { findMany: mocks.products } } }))
vi.mock('../lib/api-key-hook.js', () => ({ allowApiKeyScope: () => async () => {} }))
vi.mock('../services/listing-events.service.js', () => ({ publishListingEvent: vi.fn(), subscribeListingEvents: vi.fn() }))
vi.mock('../services/product-event.service.js', () => ({ productEventService: {} }))
vi.mock('../services/ai/providers/index.js', () => ({ getProvider: vi.fn() }))
vi.mock('../services/amazon-publish-gate.service.js', () => ({ getAmazonPublishMode: vi.fn(), isAmazonPublishEnabled: vi.fn() }))
vi.mock('../services/ebay-publish-gate.service.js', () => ({ getEbayPublishMode: vi.fn(), isEbayPublishEnabled: vi.fn() }))
vi.mock('../services/shopify-publish-gate.service.js', () => ({ getShopifyPublishMode: vi.fn(), isShopifyPublishEnabled: vi.fn() }))
vi.mock('../services/amazon-participations.service.js', () => ({ refreshAmazonParticipations: vi.fn() }))
vi.mock('../services/bulk-action.service.js', () => ({ KNOWN_BULK_ACTION_TYPES: new Set(['LISTING_BULK_ACTION']) }))
vi.mock('../services/fulfillment-derivation.service.js', () => ({ deriveFulfillmentMethod: vi.fn() }))
vi.mock('../services/follow-master.service.js', () => ({ setFollowMasterQuantity: vi.fn(), setStockBuffer: vi.fn() }))
vi.mock('../services/outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn() }))
vi.mock('../services/connection-resolver.service.js', () => ({ tryResolveConnection: vi.fn() }))
import { listingsSyndicationRoutes } from './listings-syndication.routes.js'

const app = Fastify()
beforeAll(async () => { await app.register(listingsSyndicationRoutes) })
afterAll(async () => { await app.close() })

const draft = (over: Record<string, unknown>) => ({
  id: 'cl-main', productId: 'fam-1', channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'acc-1', aliasKey: '', listingStatus: 'DRAFT',
  price: null, title: null, updatedAt: '2026-10-05T08:00:00.000Z', translations: [],
  product: { id: 'fam-1', sku: 'FAKE-SKU', name: 'Fake product', basePrice: null }, ...over,
})

it('names each draft\'s account and listing alias, so "Publish →" lands on that listing', async () => {
  mocks.listings.mockImplementation(async (args: { where?: { listingStatus?: string } }) => args.where?.listingStatus === 'DRAFT'
    ? [draft({}), draft({ id: 'cl-alt1', aliasKey: 'alias-1' })]
    : [])
  mocks.products.mockResolvedValue([])
  const response = await app.inject({ method: 'GET', url: '/listings/drafts?channel=EBAY&marketplace=IT' })
  expect(response.statusCode).toBe(200)
  const drafts = response.json().drafts as Array<Record<string, unknown>>
  expect(drafts.map(d => [d.id, d.channelConnectionId, d.aliasKey])).toEqual([['cl-main', 'acc-1', ''], ['cl-alt1', 'acc-1', 'alias-1']])
})
