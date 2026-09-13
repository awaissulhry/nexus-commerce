import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => {
  const send = vi.fn()
  vi.stubGlobal('fetch', send)
  return { send, read: vi.fn(), amazon: vi.fn(), job: vi.fn(), update: vi.fn(), feed: vi.fn(), upload: vi.fn(), review: vi.fn() }
})
vi.mock('../db.js', () => ({ default: {
  product: { findUnique: async () => ({ id: 'p', sku: 'SKU', name: 'Fixture', basePrice: 20, productType: 'COAT', translations: [] }), findFirst: async () => ({ brand: 'Fixture' }) },
  channelListing: { findMany: async () => [], findFirst: async () => ({ id: 'listing', productId: 'p', product: { sku: 'SKU' }, quantity: 2 }), update: s.update, updateMany: s.update },
  stockLevel: { findMany: async () => [] }, fbaInventoryDetail: { findMany: async () => [] },
  ebayPushJob: { findFirst: async () => null, create: async () => ({ id: 'job' }), update: s.job },
} }))
vi.mock('../services/listing-push-controls.js', () => ({ readPushControls: s.read }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, addJobSafely: vi.fn(), redis: { connection: null } }))
vi.mock('../services/outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn() }))
vi.mock('../services/content-auto-publish.service.js', () => ({ enqueueContentSyncIfEnabled: vi.fn() }))
vi.mock('../services/listing-activation-sync.service.js', () => ({ syncActivatedListings: vi.fn() }))
vi.mock('../services/marketplaces/amazon.service.js', () => ({ AmazonService: class { isConfigured = async () => true } }))
vi.mock('../clients/amazon-sp-api.client.js', () => ({ amazonSpApiClient: { putListingsItem: s.amazon } }))
vi.mock('../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: async () => 'seller' }))
vi.mock('../services/categories/marketplace-ids.js', () => ({ configuredAmazonMarketplaceId: async () => 'AMAZON_IT' }))
vi.mock('../services/pim/amazon-content-payload.js', () => ({ buildAmazonContentAttributes: async () => ({}) }))
vi.mock('../services/pim/publish-review-gate.js', () => ({ resolvePublishContent: s.review, publishContentIssues: () => [], requireReviewedContent: vi.fn() }))
vi.mock('../services/ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: async () => 'fixture' } }))
vi.mock('../services/connection-resolver.service.js', () => ({ tryResolveConnection: async () => ({ id: 'account', connectionMetadata: {} }) }))
vi.mock('../services/ebay-category.service.js', () => ({ EbayCategoryService: class {} }))
vi.mock('../services/ebay-account.service.js', () => ({ ebayAccountService: {}, resolvePolicyDisplayNames: vi.fn() }))
vi.mock('../services/ebay-publish-gate.service.js', () => ({ getEbayPublishMode: () => 'live' }))
vi.mock('../services/amazon-mcf.service.js', () => ({ getPendingMcfReservedByProduct: async () => new Map() }))
vi.mock('../services/order-events.service.js', () => ({ publishOrderEvent: vi.fn() }))
vi.mock('../services/ebay-feed.service.js', () => ({ buildInventoryNdjson: () => 'fixture', createInventoryTask: s.feed, uploadFeedFile: s.upload, getTaskStatus: vi.fn() }))
vi.mock('../services/ebay-flat-file-pull-preview.service.js', () => ({ startEbayPullPreviewJob: vi.fn(), getEbayPullPreviewJobStatus: vi.fn() }))
vi.mock('../services/ebay-variation-push.service.js', () => ({
  MARKETS: ['IT', 'DE', 'UK'], toMarketplaceId: (m: string) => `EBAY_${m}`, toChannelMarket: (m: string) => `EBAY_${m}`,
  toListingLanguage: () => 'it-IT', CONDITION_ID_TO_ENUM: {}, buildPackageWeightAndSize: () => null,
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
vi.mock('../services/ebay-description-theme.service.js', () => ({ renderListingDescriptionSafe: async () => ({ html: 'Fixture' }), stampDescriptionPushSafe: vi.fn() }))

import marketplaceRoutes from './marketplaces.routes.js'
import ebayRoutes from './ebay-flat-file.routes.js'

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(marketplaceRoutes, { prefix: '/api' })
  await app.register(ebayRoutes, { prefix: '/api' })
  await app.ready()
})
afterAll(async () => { await app?.close(); vi.unstubAllGlobals() })
beforeEach(() => {
  vi.clearAllMocks()
  s.read.mockResolvedValue([{}])
  s.review.mockResolvedValue({})
  s.amazon.mockResolvedValue({ success: true, status: 'SUBMITTED' })
  s.update.mockResolvedValue({ count: 1 })
  s.job.mockResolvedValue({ id: 'job' })
  s.feed.mockResolvedValue('task')
  s.upload.mockResolvedValue(undefined)
  s.send.mockImplementation(async (url: string) => ({ ok: true, status: 200, text: async () => '', json: async () => url.includes('?sku=') ? { offers: [{ offerId: 'offer', availableQuantity: 2 }] } : { listingId: 'remote' } }))
})

const row = { sku: 'SKU', title: 'Fixture', brand: 'Fixture', price: 20, quantity: 2 }
const cases = [
  ['Amazon publish', '/api/products/p/listings/AMAZON/IT/publish', {}],
  ['eBay publish', '/api/ebay/flat-file/publish', { rowIds: ['p'], markets: ['IT'] }],
  ['eBay API push', '/api/ebay/flat-file/push', { rows: [row], markets: ['IT'], mode: 'api' }],
  ['eBay feed push', '/api/ebay/flat-file/push', { rows: [row], markets: ['IT'], mode: 'feed' }],
] as const
const locks = [{ syncPaused: true }, { offerClosedAt: new Date('2026-09-13') }, ...['HELD', 'WITHDRAWN', 'ENDED', 'DISCONTINUED', 'RELEASED'].map(presenceIntent => ({ presenceIntent }))]

async function invoke(url: string, payload: unknown) {
  const response = await app.inject({ method: 'POST', url, payload: payload as object })
  if (response.json().async) await vi.waitFor(() => expect(s.job).toHaveBeenCalled(), { timeout: 1000 })
  return { response, text: response.body + JSON.stringify(s.job.mock.calls) }
}

describe.each(cases)('%s push lock', (name, url, payload) => {
  it.each(locks)('refuses %j before outbound work', async lock => {
    s.read.mockResolvedValue([lock])
    const result = await invoke(url, payload)
    expect(result.text).toContain('PUSH_')
    expect(s.read).toHaveBeenCalled()
    expect(s.amazon).not.toHaveBeenCalled()
    expect(s.send).not.toHaveBeenCalled()
    expect(s.feed).not.toHaveBeenCalled()
    expect(s.upload).not.toHaveBeenCalled()
  })
  it('refuses a failed controls read before outbound work', async () => {
    s.read.mockRejectedValue(new Error('PUSH_CONTROL_UNAVAILABLE'))
    expect((await invoke(url, payload)).text).toContain('PUSH_CONTROL_UNAVAILABLE')
    expect(s.amazon).not.toHaveBeenCalled()
    expect(s.send).not.toHaveBeenCalled()
    expect(s.feed).not.toHaveBeenCalled()
  })
  it('allows the existing unlocked mocked transport', async () => {
    const result = await invoke(url, payload)
    expect(result.response.statusCode, result.text).toBe(200)
    expect(result.text).not.toContain('PUSH_')
    if (name === 'Amazon publish') expect(s.amazon).toHaveBeenCalledOnce()
    else if (name === 'eBay feed push') { expect(s.feed).toHaveBeenCalledOnce(); expect(s.upload).toHaveBeenCalledOnce() }
    else expect(s.send).toHaveBeenCalledWith(expect.stringContaining('/sell/inventory/'), expect.objectContaining({ method: expect.stringMatching(/PUT|POST/) }))
  })
})

it('rechecks a hold acquired after API acceptance before the background write', async () => {
  s.read.mockResolvedValueOnce([{}]).mockResolvedValueOnce([{ syncPaused: true }])
  const result = await invoke('/api/ebay/flat-file/push', { rows: [row], markets: ['IT'], mode: 'api' })
  expect(result.response.json().async).toBe(true)
  expect(result.text).toContain('PUSH_SYNC_PAUSED')
  expect(s.read).toHaveBeenCalledTimes(2)
  expect(s.send).not.toHaveBeenCalled()
})

it('keeps a skipped row excluded without asking for an ordinary-push permission', async () => {
  s.read.mockResolvedValue([{ syncPaused: true }])
  const result = await invoke('/api/ebay/flat-file/push', { rows: [{ ...row, row_action: 'skip' }], markets: ['IT'], mode: 'api' })
  expect(result.text).not.toContain('PUSH_SYNC_PAUSED')
  expect(s.read).not.toHaveBeenCalled()
  expect(s.send).not.toHaveBeenCalled()
  expect(s.job).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'DONE', pushed: 0 }) }))
})
