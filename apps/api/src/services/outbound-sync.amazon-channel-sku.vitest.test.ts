/**
 * S3 (per-channel SKU, docs/sheet-ids-sku-rows/PLAN.md) — the Amazon queue push names the seller SKU Amazon holds for
 * THIS listing (`listingSendSku`): the product SKU for a listing with none of its own (exactly as before), its own SKU
 * otherwise. The EU shared-quantity guard is per seller SKU; FBA still never gets a merchant quantity.
 *
 * The harness is the offer-roots test's (`outbound-sync.amazon-offer-roots.vitest.test.ts`): live mode, every outside
 * call faked, `submitListingPayload` records what would go out. Nothing reaches Amazon. SKUs are fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => {
  const outbound = vi.fn(() => { throw new Error('Unexpected outbound fetch') }); vi.stubGlobal('fetch', outbound)
  return { outbound, read: vi.fn(), many: vi.fn(), seller: vi.fn(), audit: vi.fn(), get: vi.fn(), validate: vi.fn(), submit: vi.fn(), windows: vi.fn(), fbaStock: vi.fn(), fbaOffer: vi.fn(), ledger: vi.fn(), conflict: vi.fn() }
})
vi.mock('../db.js', () => {
  const rows: Record<string, unknown> = {
    product: { id: 'p', sku: 'TEST-SKU-1', name: 'Jacket', translations: [], parent: null },
    marketplace: { currency: 'EUR', languages: ['it'], language: 'it' },
  }
  const table = (model: string) => ({
    findUnique: model === 'channelListing' ? m.read : vi.fn(async () => rows[model] ?? null),
    findMany: model === 'channelListing' ? m.many : vi.fn(async () => []),
    findFirst: model === 'offer' ? m.fbaOffer : vi.fn(async () => rows[model] ?? null),
    findUniqueOrThrow: vi.fn(async () => rows[model] ?? {}),
    findFirstOrThrow: vi.fn(async () => rows[model] ?? {}),
    create: vi.fn(async () => ({})), update: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 0 })),
    upsert: vi.fn(async () => ({})), count: vi.fn(async () => 0),
    aggregate: model === 'stockLevel' ? m.fbaStock : vi.fn(async () => ({ _sum: { quantity: null } })),
  })
  const cache = new Map<string, unknown>()
  return {
    default: new Proxy({}, {
      get: (_t, model: string) => {
        if (model === '$transaction') return async (run: any) => (typeof run === 'function' ? run({}) : run)
        if (!cache.has(model)) cache.set(model, table(model))
        return cache.get(model)
      },
    }),
  }
})
vi.mock('../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: m.seller }))
vi.mock('../lib/queue.js', () => ({ addJobSafely: vi.fn(), outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
vi.mock('./sync-control-policy.service.js', () => ({ loadChannelPolicies: async () => new Map(), policyFor: () => null }))
vi.mock('./channel-publish-audit.service.js', () => ({ writeAttemptLog: m.audit, digestPayload: () => 'stub' }))
vi.mock('./pim/market-languages.js', async (original) => ({ ...(await original<object>()), marketLanguages: vi.fn(async () => ['it']) }))
vi.mock('./pim/sale-window.js', async (original) => ({ ...(await original<object>()), readSaleWindows: m.windows }))
vi.mock('./stock-pool/sync-ledgers.js', async (original) => ({ ...(await original<object>()), loadSyncLedgers: m.ledger }))
vi.mock('./sync-health.service.js', () => ({ syncHealthService: { logConflict: m.conflict } }))
vi.mock('../clients/amazon-sp-api.client.js', () => ({
  amazonSpApiClient: {
    getListingsItem: vi.fn(async (options: any) => m.get(options)),
    validateListing: vi.fn(async (options: any) => { m.validate(options); return { ok: true, available: true, errors: null, warnings: [] } }),
    submitListingPayload: vi.fn(async (options: any) => { m.submit(options); return { success: true } }),
  },
}))

const { OutboundSyncService } = await import('./outbound-sync.service.js')
const { syncLedgerOf } = await import('./sync-control-core.js')
const service: any = new OutboundSyncService()

const SKU = 'TEST-SKU-1'
const LIVE = { listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'B0TEST0001' }
/** The listing row the job reads (its select), live, with no SKU of its own unless `over` gives one. */
const listing = (over: Record<string, unknown> = {}) => ({
  id: 'l', productId: 'p', aliasKey: '', marketplace: 'IT', syncPaused: false, offerClosedAt: null, fulfillmentMethod: 'FBM', quantity: 9, stockBuffer: 0,
  sourceLocationCodes: [], followMasterQuantity: true, price: 49.9, priceOverride: 49.9, followMasterPrice: false, salePrice: null,
  platformAttributes: {}, flatFileSnapshot: null, channelSku: null, liveChannelSku: null, offers: [], ...LIVE, ...over,
})
const row = (syncType: string, payload: Record<string, unknown>, product: Record<string, unknown> = {}) => ({
  id: 'q', channelListingId: 'l', channelConnectionId: 'amz-1', targetChannel: 'AMAZON', targetRegion: 'IT', syncType,
  product: { id: 'p', sku: SKU, productType: 'OUTERWEAR', fulfillmentMethod: null, isParent: false, ...product }, payload,
})
const stockPush = (quantity: number) => row('QUANTITY_UPDATE', { source: 'STOCK_MOVEMENT', quantity, productType: 'OUTERWEAR' })
const pricePush = () => row('PRICE_UPDATE', { source: 'CHANNEL_PRICE_WRITE', marketplace: 'IT', price: 49.9, salePrice: null, salePriceStart: null, salePriceEnd: null, productType: 'OUTERWEAR' })
/** A sibling Amazon row as the EU guard reads it (its select, with the seller-SKU facts). */
const sibling = (marketplace: string, over: Record<string, unknown> = {}) => ({
  marketplace, followMasterQuantity: true, quantityOverride: null, quantity: 9, syncPaused: false, fulfillmentMethod: 'FBM',
  aliasKey: '', channelSku: null, liveChannelSku: null, platformAttributes: {}, flatFileSnapshot: null, offers: [], product: { sku: SKU }, ...LIVE, ...over,
})
const pinnedAtZero = { followMasterQuantity: false, quantityOverride: 0, quantity: 0 }
const sentSku = () => m.submit.mock.calls[0][0].sku

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXUS_ENABLE_AMAZON_PUBLISH', 'true'); vi.stubEnv('AMAZON_PUBLISH_MODE', 'live')
  vi.stubEnv('NEXUS_AMAZON_OFFER_MERGE', '')
  m.seller.mockResolvedValue('seller')
  m.read.mockResolvedValue(listing())
  m.many.mockResolvedValue([])
  m.windows.mockResolvedValue(new Map())
  m.fbaStock.mockResolvedValue({ _sum: { quantity: null } })
  m.fbaOffer.mockResolvedValue(null)
  m.get.mockResolvedValue({ success: true, rawResponse: { attributes: {}, summaries: [] } })
  m.ledger.mockImplementation(async (_db: unknown, ids: string[]) => new Map(ids.map((id) => [id, {
    productId: id, source: { kind: 'own' }, ledger: syncLedgerOf([{ locationCode: 'WH-IT', available: 50, syncRoutes: ['AMAZON:IT', 'AMAZON:DE'] }]),
    quantity: 50, available: 50, uncountedIsZero: false, fbaBucket: 0,
  }])))
})
afterEach(() => { vi.unstubAllEnvs() })

describe('parity — a listing with no SKU of its own is sent under the product SKU, as before', () => {
  it.each([
    ['a price push', pricePush],
    ['a stock push', () => stockPush(9)],
  ])('%s', async (_name, make) => {
    const result = await service.syncToAmazon(make())
    expect(result, JSON.stringify(result)).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(sentSku()).toBe(SKU)
  })

  it('an old store holding the product SKU itself changes nothing', async () => {
    m.read.mockResolvedValue(listing({ offers: [{ sku: SKU, isActive: true, fulfillmentMethod: 'FBM' }], platformAttributes: { sellerSku: SKU }, flatFileSnapshot: { item_sku: SKU } }))
    await service.syncToAmazon(pricePush())
    expect(sentSku()).toBe(SKU)
  })

  it('a row with no listing still names the product SKU (no listing to read a SKU from)', async () => {
    const noListing = { ...pricePush(), channelListingId: null, payload: { ...pricePush().payload, marketplaceId: 'IT' } }
    m.read.mockResolvedValue(null)
    await service.syncToAmazon(noListing)
    expect(sentSku()).toBe(SKU)
  })
})

describe('a listing with its own seller SKU is sent under that SKU', () => {
  it('the confirmed live SKU (price push)', async () => {
    m.read.mockResolvedValue(listing({ liveChannelSku: 'OWN-IT', channelSku: 'OWN-IT' }))
    expect(await service.syncToAmazon(pricePush())).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(sentSku()).toBe('OWN-IT')
  })

  it('the SKU Amazon holds wins over a wanted one not yet published', async () => {
    m.read.mockResolvedValue(listing({ liveChannelSku: 'OLD-IT', channelSku: 'NEW-IT' }))
    await service.syncToAmazon(stockPush(9))
    expect(sentSku()).toBe('OLD-IT')
  })

  it('an old store\'s one value (an active offer)', async () => {
    m.read.mockResolvedValue(listing({ offers: [{ sku: 'OFFER-IT', isActive: true, fulfillmentMethod: 'FBM' }] }))
    await service.syncToAmazon(pricePush())
    expect(sentSku()).toBe('OFFER-IT')
  })

  it('the live offer read (offer merge on) and the content pre-check name the same SKU', async () => {
    vi.stubEnv('NEXUS_AMAZON_OFFER_MERGE', '1')
    m.read.mockResolvedValue(listing({ liveChannelSku: 'OWN-IT' }))
    await service.syncToAmazon(pricePush())
    expect(m.get).toHaveBeenCalledWith(expect.objectContaining({ sku: 'OWN-IT' }))
    expect(sentSku()).toBe('OWN-IT')
  })
})

describe('a still-draft row sends nothing it did not send before', () => {
  it('a draft with its own wanted SKU is pushed under the product SKU, as before (its own SKU is Publish\'s to send)', async () => {
    m.read.mockResolvedValue(listing({ listingStatus: 'DRAFT', isPublished: false, externalListingId: null, channelSku: 'WANT-IT' }))
    await service.syncToAmazon(pricePush())
    expect(sentSku()).toBe(SKU)
  })
})

describe('two seller SKUs on record → nothing is sent (never a guess)', () => {
  it.each([
    ['two active offers', { offers: [{ sku: 'A-1', isActive: true, fulfillmentMethod: 'FBM' }, { sku: 'A-2', isActive: true, fulfillmentMethod: 'FBM' }] },
      'TEST-SKU-1 has multiple seller SKUs. Select its offer before publishing. Nothing was sent.'],
    ['two stored identities', { platformAttributes: { sellerSku: 'A-1' }, flatFileSnapshot: { item_sku: 'A-2' } },
      'TEST-SKU-1: conflicting Amazon seller SKUs. Reconcile this listing\'s identity before publishing. Nothing was sent.'],
  ])('%s', async (_name, over, sentence) => {
    m.read.mockResolvedValue(listing(over))
    const result = await service.syncToAmazon(stockPush(9))
    expect(result).toEqual({ success: false, queueId: 'q', channel: 'AMAZON', status: 'FAILED', message: sentence, error: sentence, errorCode: 'CHANNEL_SKU_UNRESOLVED', retryable: false })
    expect(m.submit).not.toHaveBeenCalled()
    expect(m.validate).not.toHaveBeenCalled()
  })
})

describe('the EU shared-quantity guard is per seller SKU', () => {
  it('control (as before): DE pinned at 0 under the same SKU fights IT following the pool → refused', async () => {
    m.many.mockResolvedValue([sibling('IT'), sibling('DE', pinnedAtZero)])
    const result = await service.syncToAmazon(stockPush(9))
    expect(m.submit).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: false, status: 'SKIPPED', error: 'eu-shared-qty-conflict' })
  })

  it('DE pinned at 0 under ITS OWN seller SKU is another quantity: the IT push goes out', async () => {
    m.many.mockResolvedValue([sibling('IT'), sibling('DE', { ...pinnedAtZero, liveChannelSku: 'OWN-DE' })])
    const result = await service.syncToAmazon(stockPush(9))
    expect(result, JSON.stringify(result)).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(sentSku()).toBe(SKU)
  })

  it('the DE listing pushing under its own SKU is checked against the rows holding THAT SKU only', async () => {
    m.read.mockResolvedValue(listing({ marketplace: 'DE', liveChannelSku: 'OWN-DE' }))
    m.many.mockResolvedValue([sibling('IT', pinnedAtZero), sibling('DE', { liveChannelSku: 'OWN-DE' }), sibling('FR', { liveChannelSku: 'OWN-DE' })])
    const result = await service.syncToAmazon(row('QUANTITY_UPDATE', { source: 'STOCK_MOVEMENT', quantity: 9, productType: 'OUTERWEAR' }))
    expect(result, JSON.stringify(result)).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(sentSku()).toBe('OWN-DE')
    // …and FR pinned at 0 under that same SKU is refused.
    vi.clearAllMocks()
    m.many.mockResolvedValue([sibling('DE', { liveChannelSku: 'OWN-DE' }), sibling('FR', { ...pinnedAtZero, liveChannelSku: 'OWN-DE' })])
    const refused = await service.syncToAmazon(row('QUANTITY_UPDATE', { source: 'STOCK_MOVEMENT', quantity: 9, productType: 'OUTERWEAR' }))
    expect(refused).toMatchObject({ success: false, status: 'SKIPPED', error: 'eu-shared-qty-conflict' })
    expect(refused.message).toMatch(/^EU shared-quantity conflict for OWN-DE: /)
  })

  it('a sibling whose SKU cannot be told still counts (the guard fails closed)', async () => {
    m.many.mockResolvedValue([sibling('IT'), sibling('DE', { ...pinnedAtZero, platformAttributes: { sellerSku: 'X-1' }, flatFileSnapshot: { item_sku: 'X-2' } })])
    const result = await service.syncToAmazon(stockPush(9))
    expect(result).toMatchObject({ success: false, status: 'SKIPPED', error: 'eu-shared-qty-conflict' })
  })
})

describe('FBA: a listing with its own seller SKU still never gets a merchant quantity', () => {
  it('stock push on an FBA listing with its own SKU → nothing sent', async () => {
    m.read.mockResolvedValue(listing({ fulfillmentMethod: 'FBA', liveChannelSku: 'OWN-FBA' }))
    const result = await service.syncToAmazon(stockPush(9))
    expect(m.submit).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: true, status: 'SKIPPED', errorCode: 'AMAZON_EMPTY_PATCH_NOT_SENT', message: 'Amazon manages the FBA quantity. Nothing was sent to the channel.' })
  })

  it('FBA evidence from an active FBA offer under the listing\'s own SKU → nothing sent', async () => {
    m.read.mockResolvedValue(listing({ offers: [{ sku: 'OWN-FBA', isActive: true, fulfillmentMethod: 'FBA' }] }))
    m.fbaOffer.mockResolvedValue({ id: 'offer-1' })
    const result = await service.syncToAmazon(stockPush(9))
    expect(m.submit).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: 'SKIPPED', errorCode: 'AMAZON_EMPTY_PATCH_NOT_SENT' })
  })

  it('price + quantity on an FBA listing with its own SKU: the offer alone goes, under that SKU, with no quantity anywhere', async () => {
    m.read.mockResolvedValue(listing({ fulfillmentMethod: 'FBA', liveChannelSku: 'OWN-FBA' }))
    await service.syncToAmazon(row('FULL_SYNC', { price: 49.9, quantity: 9, productType: 'OUTERWEAR' }))
    expect(sentSku()).toBe('OWN-FBA')
    const body = JSON.stringify(m.submit.mock.calls[0][0].payload)
    expect(body).not.toContain('fulfillment_availability')
    expect(body).not.toMatch(/"quantity"/)
  })
})
