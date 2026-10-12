/**
 * One listing's problem never holds the whole Amazon market (MOSS IT 2026-10-12: three stock pushes of listings with no
 * product type were refused with 4000003; each refusal counted against the IT circuit, which re-opened every ~12 minutes
 * and held every Amazon IT push of the business for ~1 h 40 min).
 *   - no product type → nothing is sent, the row fails once (not retried), the circuit is untouched;
 *   - Amazon refuses THIS item (`itemLevel`) → the row fails once (not retried), the circuit is untouched;
 *   - an account or Amazon failure → retried and counted against the circuit, as before.
 *
 * The harness is the channel-SKU test's (`outbound-sync.amazon-channel-sku.vitest.test.ts`): live mode, every outside
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
    submitListingPayload: vi.fn(async (options: any) => m.submit(options) ?? { success: true }),
  },
}))

const { OutboundSyncService } = await import('./outbound-sync.service.js')
const { syncLedgerOf } = await import('./sync-control-core.js')
const { checkAmazonCircuit, resetAllAmazonCircuits } = await import('./amazon-publish-gate.service.js')
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

beforeEach(() => {
  vi.clearAllMocks()
  resetAllAmazonCircuits()
  vi.stubEnv('NEXUS_ENABLE_AMAZON_PUBLISH', 'true'); vi.stubEnv('AMAZON_PUBLISH_MODE', 'live')
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
afterEach(() => { vi.unstubAllEnvs(); resetAllAmazonCircuits() })

/** A stock push whose listing and product name no product type, as a row linked to an item Nexus did not publish. */
const untyped = () => row('QUANTITY_UPDATE', { source: 'STOCK_MOVEMENT', quantity: 9 }, { productType: null })
const marketOpen = () => checkAmazonCircuit('seller', 'IT')
const REFUSED = '4000003: The Amazon product type specified is invalid or not supported.'

describe('no product type — nothing is sent, the market stays open', () => {
  it('fails the row once with a plain reason, without calling Amazon', async () => {
    const result = await service.syncToAmazon(untyped())
    expect(result).toMatchObject({ success: false, errorCode: 'NO_AMAZON_PRODUCT_TYPE', retryable: false })
    expect(result.error).toContain(`${SKU} has no Amazon product type`)
    expect(m.submit).not.toHaveBeenCalled()
  })

  it('three of them leave the Amazon IT circuit closed: the next listing still goes out', async () => {
    for (let i = 0; i < 3; i++) await service.syncToAmazon(untyped())
    expect(marketOpen()).toMatchObject({ ok: true, state: 'closed' })
    expect(await service.syncToAmazon(stockPush(9))).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(m.submit).toHaveBeenCalledOnce()
  })

  it('the listing\'s own product type is enough (the product has none)', async () => {
    m.read.mockResolvedValue(listing({ platformAttributes: { productType: 'outerwear' } }))
    expect(await service.syncToAmazon(untyped())).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(m.submit.mock.calls[0][0].payload.productType).toBe('OUTERWEAR')
  })
})

describe('Amazon refuses THIS listing — the row fails once, the market stays open', () => {
  it('is not retried and not counted against the circuit', async () => {
    m.submit.mockReturnValue({ success: false, sku: SKU, error: REFUSED, itemLevel: true })
    for (let i = 0; i < 3; i++) {
      expect(await service.syncToAmazon(stockPush(9))).toMatchObject({ success: false, error: REFUSED, errorCode: 'AMAZON_LISTING_REFUSED', retryable: false })
    }
    expect(marketOpen()).toMatchObject({ ok: true, state: 'closed' })
  })
})

describe('an account or Amazon failure — retried and counted, as before', () => {
  it('stays retryable and three of them open the circuit', async () => {
    m.submit.mockReturnValue({ success: false, sku: SKU, error: 'HTTP 503 — ServiceUnavailable' })
    const first = await service.syncToAmazon(stockPush(9))
    expect(first).toMatchObject({ success: false })
    expect(first.retryable).toBeUndefined()
    expect(first.errorCode).toBeUndefined()
    for (let i = 0; i < 2; i++) await service.syncToAmazon(stockPush(9))
    expect(marketOpen()).toMatchObject({ ok: false, state: 'open' })
  })
})
