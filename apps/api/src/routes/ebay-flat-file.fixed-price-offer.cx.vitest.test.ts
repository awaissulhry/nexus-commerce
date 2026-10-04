/**
 * CX (main-session ruling 2026-09-26) — the eBay flat-file routes act on the ONE FIXED_PRICE offer of the market
 * (ebayFixedPriceOfferOf), never `offers[0]`: getOffers lists an auction offer beside the fixed-price one when both
 * exist, and the routes then re-published, priced, ended or deleted the auction.
 *
 *   publish (re-publish) · push single-SKU offer writer · push "end" action · delete offer.
 *
 * Harness: the presence-push route harness (known to drive these routes), with the transport answering getOffers
 * with an auction FIRST.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => {
  const send = vi.fn()
  vi.stubGlobal('fetch', async (...args: unknown[]) => (await import('../test-support/gateway-stubs.js')).asResponse(send(...args)))
  return { send, read: vi.fn(), update: vi.fn(), job: vi.fn(), offers: [] as Array<Record<string, unknown>> }
})
vi.mock('../db.js', () => ({ default: {
  product: { findUnique: async () => ({ id: 'p', sku: 'SKU', name: 'Fixture', basePrice: 20, productType: 'COAT', translations: [] }), findFirst: async () => ({ brand: 'Fixture' }) },
  channelListing: {
    findMany: async () => [],
    findFirst: async () => ({ id: 'listing', productId: 'p', product: { sku: 'SKU' }, quantity: 2, marketplace: 'IT', region: 'IT' }),
    update: s.update, updateMany: s.update },
  sharedListingMembership: { findMany: async () => [], findFirst: async () => null },
  marketplace: { findFirst: async ({ where }: { where: { code: string } }) => where.code === 'IT' ? { marketplaceId: 'EBAY_IT', languages: ['it'], language: 'it', currency: 'EUR' } : null },
  stockLevel: { findMany: async () => [] }, fbaInventoryDetail: { findMany: async () => [] },
  ebayPushJob: { findFirst: async () => null, create: async () => ({ id: 'job' }), update: s.job },
} }))
vi.mock('../services/listing-push-controls.js', () => ({ readPushControls: s.read }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, addJobSafely: vi.fn(), redis: { connection: null } }))
vi.mock('../services/outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn() }))
vi.mock('../services/content-auto-publish.service.js', () => ({ enqueueContentSyncIfEnabled: vi.fn() }))
vi.mock('../services/listing-activation-sync.service.js', () => ({ syncActivatedListings: vi.fn() }))
vi.mock('../services/pim/publish-review-gate.js', () => ({ resolvePublishContent: vi.fn(async () => ({})), publishContentIssues: () => [], requireReviewedContent: vi.fn() }))
vi.mock('../services/ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: async () => 'fixture' } }))
vi.mock('../services/connection-resolver.service.js', () => ({ tryResolveConnection: async () => ({ id: 'account', connectionMetadata: {} }) }))
vi.mock('../services/ebay-category.service.js', () => ({ EbayCategoryService: class {} }))
vi.mock('../services/ebay-account.service.js', () => ({ ebayAccountService: {}, resolvePolicyDisplayNames: vi.fn() }))
vi.mock('../services/ebay-publish-gate.service.js', () => ({ getEbayPublishMode: () => 'live', ebayWriteRefusal: () => null, ebayHostOf: () => 'production' }))
vi.mock('../services/ebay-policy-reconcile.service.js', () => ({ reconcileEbayPolicies: async () => ({ policies: { fulfillmentPolicyId: 'fulfill', paymentPolicyId: 'pay', returnPolicyId: 'return', merchantLocationKey: 'here' } }) }))
vi.mock('../services/amazon-mcf.service.js', () => ({ getPendingMcfReservedByProduct: async () => new Map() }))
vi.mock('../services/order-events.service.js', () => ({ publishOrderEvent: vi.fn() }))
vi.mock('../services/gateway/account.js', () => import('../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('../services/gateway/ledger.js', () => import('../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../services/ebay-feed.service.js', () => ({ buildInventoryNdjson: () => 'fixture', createInventoryTask: vi.fn(), uploadFeedFile: vi.fn(), getTaskStatus: vi.fn() }))
vi.mock('../services/ebay-flat-file-pull-preview.service.js', () => ({ startEbayPullPreviewJob: vi.fn(), getEbayPullPreviewJobStatus: vi.fn() }))
vi.mock('../services/ebay-variation-push.service.js', () => ({
  MARKETS: ['IT', 'DE', 'UK'], toMarketplaceId: (m: string) => `EBAY_${m}`, toChannelMarket: (m: string) => `EBAY_${m}`,
  CONDITION_ID_TO_ENUM: {}, buildPackageWeightAndSize: () => null,
  resolvePerMarketContent: (_listing: unknown, fallback: unknown) => fallback,
  buildFlatRow: vi.fn(), packSharedFields: vi.fn(), applyEbayFlatFileSnapshot: vi.fn(), buildBestOfferTerms: vi.fn(), resolveQuantityLimitPerBuyer: vi.fn(),
  pushVariationGroup: vi.fn(), pushOffersOnly: vi.fn(), axisSynonymKey: (v: string) => v.toLowerCase(),
}))
vi.mock('../services/ebay-shared-listing-push.service.js', () => ({ pushSharedListings: vi.fn(), POOL_DEFAULT_QTY_SENTINEL: -1 }))
vi.mock('../services/ebay-trading-api.service.js', () => ({ callTradingApi: vi.fn(), siteIdForMarket: () => '101', escapeXml: (v: string) => v }))
vi.mock('../services/ebay-membership-reconcile.service.js', () => ({ reconcileMembershipsFromEbay: vi.fn(), parseLiveVariations: vi.fn() }))
vi.mock('../services/ebay-variation-relabel.service.js', () => ({ adoptSkulessVariations: vi.fn(), relabelListingToPoolSkus: vi.fn() }))
vi.mock('../services/ebay-variation-add.service.js', () => ({ addVariationsToListing: vi.fn() }))
vi.mock('../services/ebay-variation-order-apply.service.js', () => ({ applyVariationOrderForFamily: vi.fn() }))
vi.mock('../services/ebay-description-theme.service.js', () => ({ renderListingDescriptionSafe: async () => ({ html: 'Fixture', warnings: [] }), stampDescriptionPushSafe: vi.fn() }))

import ebayRoutes from './ebay-flat-file.routes.js'

let app: FastifyInstance
beforeAll(async () => { app = Fastify(); await app.register(ebayRoutes, { prefix: '/api' }); await app.ready() })
afterAll(async () => { await app?.close(); vi.unstubAllGlobals() })

const offer = (offerId: string, format: string) => ({ offerId, sku: 'SKU', marketplaceId: 'EBAY_IT', format, status: 'PUBLISHED', availableQuantity: 5,
  pricingSummary: { price: { value: '20.00', currency: 'EUR' } }, listingPolicies: { fulfillmentPolicyId: 'fulfill' }, merchantLocationKey: 'here', categoryId: '123' })
beforeEach(() => {
  vi.clearAllMocks()
  s.read.mockResolvedValue([{}])
  s.update.mockResolvedValue({ count: 1 })
  s.job.mockResolvedValue({ id: 'job' })
  // eBay lists the auction FIRST.
  s.offers = [offer('au-1', 'AUCTION'), offer('fp-1', 'FIXED_PRICE')]
  s.send.mockImplementation(async (url: string) => ({ ok: true, status: 200, text: async () => '',
    json: async () => (url.includes('/offer?') ? { offers: s.offers } : { listingId: 'remote', offerId: 'created' }) }))
})
/** The push runs in the background: wait for its job's final record, and return the per-row results. */
async function pushed(payload: object) {
  const r = await app.inject({ method: 'POST', url: '/api/ebay/flat-file/push', payload })
  expect(r.statusCode, r.body).toBe(200)
  await vi.waitFor(() => expect(s.job.mock.calls.some((c) => c[0]?.data?.completedAt)).toBe(true), { timeout: 5_000 })
  return s.job.mock.calls.find((c) => c[0]?.data?.completedAt)![0].data.perSkuResults
}
/** Every write to an offer id, as "METHOD /offer/<id>[/publish]". */
const offerWrites = () => s.send.mock.calls
  .map(([url, init]) => [String(url), String((init as RequestInit | undefined)?.method ?? 'GET')] as const)
  .filter(([url, method]) => method !== 'GET' && /\/sell\/inventory\/v1\/offer\/[^/?]+/.test(url))
  .map(([url, method]) => `${method} ${new URL(url).pathname.replace('/sell/inventory/v1', '')}`)

describe('eBay flat-file routes act on the fixed-price offer, never the auction eBay lists first', () => {
  it('re-publish (POST /ebay/flat-file/publish)', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/ebay/flat-file/publish', payload: { rowIds: ['p'], markets: ['IT'] } })
    expect(r.statusCode, r.body).toBe(200)
    expect(offerWrites().some((w) => w.includes('/offer/fp-1'))).toBe(true)
    expect(offerWrites().filter((w) => w.includes('au-1'))).toEqual([])
  })
  it('delete offer (DELETE /ebay/flat-file/offer)', async () => {
    const r = await app.inject({ method: 'DELETE', url: '/api/ebay/flat-file/offer', payload: { rowIds: ['p'], markets: ['IT'] } })
    expect(r.statusCode, r.body).toBe(200)
    expect(offerWrites()).toEqual(['DELETE /offer/fp-1'])
  })
  it('push, action "end" on a variation row', async () => {
    const results = await pushed({ rows: [{ sku: 'SKU', row_action: 'end' }], markets: ['IT'], mode: 'api' })
    expect(offerWrites(), JSON.stringify(results)).toEqual(['DELETE /offer/fp-1'])
  })
  it('push, single-SKU offer writer (price and quantity)', async () => {
    const row = { sku: 'SKU', title: 'Fixture', brand: 'Fixture', price: 20, quantity: 2, category_id: '123', image_1: 'https://fixture.invalid/a.jpg', condition: 'NEW' }
    const results = await pushed({ rows: [row], markets: ['IT'], mode: 'api' })
    expect(offerWrites(), JSON.stringify(results)).toEqual(['PUT /offer/fp-1', 'POST /offer/fp-1/publish'])
  })
  it('push, single-SKU row without a condition: refused by name, never sent as NEW, nothing reaches eBay (E1)', async () => {
    const row = { sku: 'SKU', title: 'Fixture', brand: 'Fixture', price: 20, quantity: 2, category_id: '123', image_1: 'https://fixture.invalid/a.jpg', condition: '' }
    const results = await pushed({ rows: [row], markets: ['IT'], mode: 'api' })
    expect(results, JSON.stringify(results)).toEqual(expect.arrayContaining([expect.objectContaining({ sku: 'SKU', status: 'ERROR', message: 'Condition is empty on this listing\'s main row; Nexus does not guess one.' })]))
    // No write of any kind (the inventory item included) went to eBay.
    expect(s.send.mock.calls.filter(([, init]) => String((init as RequestInit | undefined)?.method ?? 'GET') !== 'GET')).toEqual([])
  })
})
