/**
 * Amazon Business step 4 — the Amazon push sends the business offer: a business row (`BUSINESS_PRICE_UPDATE`) alone, and
 * a percent-off business price after the normal price push it follows. The harness is the merge test's
 * (`outbound-sync.amazon-offer-merge.vitest.test.ts`): live mode, every outside call faked. Nothing reaches Amazon.
 * SKUs are fake; marketplace ids are Amazon's public ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => {
  const outbound = vi.fn(() => { throw new Error('Unexpected outbound fetch') }); vi.stubGlobal('fetch', outbound)
  return {
    outbound, read: vi.fn(), many: vi.fn(), seller: vi.fn(), audit: vi.fn(),
    get: vi.fn(), validate: vi.fn(), submit: vi.fn(), offerPatch: vi.fn(), windows: vi.fn(), exec: vi.fn(),
  }
})
vi.mock('../db.js', () => {
  const rows: Record<string, unknown> = {
    product: { id: 'p', sku: 'TEST-SKU-1', name: 'Jacket', translations: [], parent: null },
    marketplace: { currency: 'EUR', languages: ['it'], language: 'it' },
  }
  const table = (model: string) => ({
    findUnique: model === 'channelListing' ? m.read : vi.fn(async () => rows[model] ?? null),
    findMany: model === 'channelListing' ? m.many : vi.fn(async () => []),
    findFirst: vi.fn(async () => rows[model] ?? null),
    findUniqueOrThrow: vi.fn(async () => rows[model] ?? {}),
    findFirstOrThrow: vi.fn(async () => rows[model] ?? {}),
    create: vi.fn(async () => ({})), update: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 0 })),
    upsert: vi.fn(async () => ({})), count: vi.fn(async () => 0), aggregate: vi.fn(async () => ({ _sum: { quantity: null } })),
  })
  const cache = new Map<string, unknown>()
  return {
    default: new Proxy({}, {
      get: (_t, model: string) => {
        if (model === '$transaction') return async (run: any) => (typeof run === 'function' ? run({}) : run)
        // The business send keeps its outcome on the listing with one raw statement.
        if (model === '$executeRaw') return async (_strings: unknown, ...values: unknown[]) => { m.exec(...values); return 1 }
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
vi.mock('../clients/amazon-sp-api.client.js', () => ({
  amazonSpApiClient: {
    getListingsItem: vi.fn(async (options: any) => m.get(options)),
    validateListing: vi.fn(async (options: any) => { m.validate(options); return { ok: true, available: true, errors: null, warnings: [] } }),
    submitListingPayload: vi.fn(async (options: any) => { m.submit(options); return { success: true } }),
    patchPurchasableOffer: vi.fn(async (options: any) => m.offerPatch(options)),
  },
}))

const { OutboundSyncService } = await import('./outbound-sync.service.js')
const { IT, liveRead } = await import('../test-support/amazon-offer-model.js')
const service: any = new OutboundSyncService()

const SKU = 'TEST-SKU-1'
const priceOf = (v: number) => [{ schedule: [{ value_with_tax: v }] }]
const allIt = { audience: 'ALL', currency: 'EUR', marketplace_id: IT, our_price: priceOf(105), minimum_seller_allowed_price: priceOf(25) }
const b2bIt = (v: number) => ({ audience: 'B2B', currency: 'EUR', marketplace_id: IT, our_price: priceOf(v) })
const listing = (business: Record<string, unknown>) => ({
  id: 'l', marketplace: 'IT', platformAttributes: {}, syncPaused: false, fulfillmentMethod: 'FBM', salePrice: null,
  price: 105, priceOverride: 105, followMasterPrice: false, listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'ASIN-1',
  businessPriceRule: null, businessPricePercent: null, businessPrice: null, businessTiers: null, ...business,
})
const row = (syncType: string, payload: Record<string, unknown>, product: Record<string, unknown> = {}) => ({
  id: 'q', channelListingId: 'l', channelConnectionId: 'amz-1', targetChannel: 'AMAZON', targetRegion: 'IT', syncType,
  product: { id: 'p', sku: SKU, productType: 'OUTERWEAR', ...product }, payload,
})
const businessRow = (product?: Record<string, unknown>) => row('BUSINESS_PRICE_UPDATE', { syncBusiness: true, source: 'BUSINESS_PRICE_WRITE' }, product)
const pricePush = (price: number) => row('PRICE_UPDATE', { source: 'CHANNEL_PRICE_WRITE', marketplace: 'IT', price, salePrice: null, salePriceStart: null, salePriceEnd: null, productType: 'OUTERWEAR' })
const tiers = { type: 'percent', levels: [{ minQty: 2, value: 3 }, { minQty: 5, value: 5 }] }
const kept = () => JSON.parse(String(m.exec.mock.calls.at(-1)?.[0] ?? 'null'))

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXUS_ENABLE_AMAZON_PUBLISH', 'true'); vi.stubEnv('AMAZON_PUBLISH_MODE', 'live')
  m.seller.mockResolvedValue('seller')
  m.many.mockResolvedValue([])
  m.windows.mockResolvedValue(new Map())
  m.get.mockResolvedValue(liveRead([allIt]))
  m.offerPatch.mockResolvedValue({ success: true, sku: SKU, status: 'ACCEPTED' })
})
afterEach(() => { vi.unstubAllEnvs() })

describe('a business row sends the business offer alone', () => {
  it('a first business offer: replace with every live instance verbatim plus the new one; the normal push is not sent', async () => {
    m.read.mockResolvedValue(listing({ businessPriceRule: 'PERCENT_OFF', businessPricePercent: 5, businessTiers: tiers }))
    const result = await service.syncToAmazon(businessRow())
    expect(result, JSON.stringify(result)).toMatchObject({ success: true, status: 'SUCCESS', message: 'Sent to Amazon: business price EUR 99.75 · 2+ 96.76, 5+ 94.76.' })
    expect(m.submit).not.toHaveBeenCalled()
    expect(m.get).toHaveBeenCalledExactlyOnceWith({ sellerId: 'seller', sku: SKU, marketplaceId: IT, includedData: ['attributes', 'summaries'] })
    expect(m.offerPatch).toHaveBeenCalledExactlyOnceWith({
      sellerId: 'seller', sku: SKU, marketplaceId: IT, productType: 'OUTERWEAR', op: 'replace',
      value: [allIt, { marketplace_id: IT, currency: 'EUR', audience: 'B2B', our_price: priceOf(99.75), quantity_discount_plan: [{ schedule: [{ discount_type: 'percent', levels: [{ lower_bound: 2, value: 3 }, { lower_bound: 5, value: 5 }] }] }] }],
    })
    expect(kept()).toMatchObject({ status: 'SENT' })
    expect(m.exec.mock.calls.at(-1)?.[1]).toBe('l')
  })

  it('an exact price Amazon holds differently: merge naming only the business instance', async () => {
    m.read.mockResolvedValue(listing({ businessPriceRule: 'FIXED', businessPrice: 32.95 }))
    m.get.mockResolvedValue(liveRead([allIt, b2bIt(30)]))
    await service.syncToAmazon(businessRow())
    expect(m.offerPatch.mock.calls[0][0]).toMatchObject({ op: 'merge', value: [{ marketplace_id: IT, currency: 'EUR', audience: 'B2B', our_price: priceOf(32.95) }] })
    expect(m.offerPatch.mock.calls[0][0].value[0]).not.toHaveProperty('quantity_discount_plan')
  })

  it('Nexus keeps none any more: the business offer Amazon holds is deleted; the normal offer is never named', async () => {
    m.read.mockResolvedValue(listing({}))
    m.get.mockResolvedValue(liveRead([allIt, b2bIt(32.95)]))
    const result = await service.syncToAmazon(businessRow())
    expect(m.offerPatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ op: 'delete', value: [{ marketplace_id: IT, currency: 'EUR', audience: 'B2B' }] }))
    expect(result.message).toBe('The business offer was removed on Amazon.')
    expect(kept()).toMatchObject({ status: 'REMOVED' })
  })

  it('Amazon already holds exactly this: nothing is sent', async () => {
    m.read.mockResolvedValue(listing({ businessPriceRule: 'FIXED', businessPrice: 32.95 }))
    m.get.mockResolvedValue(liveRead([allIt, b2bIt(32.95)]))
    const result = await service.syncToAmazon(businessRow())
    expect(m.offerPatch).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: true, message: 'Amazon already holds the business price EUR 32.95.' })
  })

  it('the live offer cannot be read: nothing is sent, and the row is retried', async () => {
    m.read.mockResolvedValue(listing({ businessPriceRule: 'FIXED', businessPrice: 32.95 }))
    m.get.mockRejectedValue(new Error('socket hang up'))
    const result = await service.syncToAmazon(businessRow())
    expect(m.offerPatch).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: false, errorCode: 'AMAZON_OFFER_READ_FAILED', retryable: true })
  })

  it('a price Amazon would refuse (below the minimum price Amazon holds, set in Seller Central) is not sent, and is not retried', async () => {
    m.read.mockResolvedValue(listing({ businessPriceRule: 'FIXED', businessPrice: 50 }))
    m.get.mockResolvedValue(liveRead([{ ...allIt, minimum_seller_allowed_price: priceOf(60) }]))
    const result = await service.syncToAmazon(businessRow())
    expect(m.offerPatch).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: false, errorCode: 'AMAZON_BUSINESS_PRICE_REFUSED', retryable: false })
    expect(result.message).toContain('below this listing\'s minimum price')
    expect(kept()).toMatchObject({ status: 'REFUSED' })
  })

  it('Amazon refuses the patch: the row fails with Amazon\'s words, not retried', async () => {
    m.read.mockResolvedValue(listing({ businessPriceRule: 'FIXED', businessPrice: 99 }))
    m.offerPatch.mockResolvedValue({ success: false, sku: SKU, error: '90244: invalid value' })
    const result = await service.syncToAmazon(businessRow())
    expect(result).toMatchObject({ success: false, errorCode: 'AMAZON_BUSINESS_PRICE_REFUSED', retryable: false })
    expect(result.message).toContain('90244')
  })

  it('a family parent sends nothing', async () => {
    m.read.mockResolvedValue(listing({ businessPriceRule: 'FIXED', businessPrice: 99 }))
    const result = await service.syncToAmazon(businessRow({ isParent: true }))
    expect(m.get).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: false, errorCode: 'AMAZON_BUSINESS_PRICE_NOT_SENT', retryable: false })
  })

  it.each([['gated', undefined, undefined], ['dry-run', 'true', 'dry-run']])('%s mode: no live read and no patch', async (_mode, flag, mode) => {
    vi.unstubAllEnvs()
    if (flag) vi.stubEnv('NEXUS_ENABLE_AMAZON_PUBLISH', flag)
    if (mode) vi.stubEnv('AMAZON_PUBLISH_MODE', mode)
    m.read.mockResolvedValue(listing({ businessPriceRule: 'FIXED', businessPrice: 99 }))
    await service.syncToAmazon(businessRow())
    expect(m.get).not.toHaveBeenCalled()
    expect(m.offerPatch).not.toHaveBeenCalled()
  })
})

describe('a normal price push carries a percent-off business price', () => {
  it('percent off: the normal price goes first, then the business price follows it', async () => {
    m.read.mockResolvedValue(listing({ businessPriceRule: 'PERCENT_OFF', businessPricePercent: 5 }))
    m.get.mockResolvedValue(liveRead([allIt, b2bIt(99.75)]))
    const result = await service.syncToAmazon(pricePush(115))
    expect(result, JSON.stringify(result)).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(m.submit).toHaveBeenCalledTimes(1)
    expect(m.submit.mock.invocationCallOrder[0]).toBeLessThan(m.offerPatch.mock.invocationCallOrder[0]!)
    expect(m.offerPatch.mock.calls[0][0]).toMatchObject({ op: 'merge', value: [{ audience: 'B2B', our_price: priceOf(109.25) }] })
    expect(result.message).toContain('Sent to Amazon: business price EUR 109.25.')
  })

  it('an exact business price does not move with the normal price: nothing more is sent', async () => {
    m.read.mockResolvedValue(listing({ businessPriceRule: 'FIXED', businessPrice: 99 }))
    await service.syncToAmazon(pricePush(115))
    expect(m.submit).toHaveBeenCalledTimes(1)
    expect(m.offerPatch).not.toHaveBeenCalled()
  })

  it('the normal price push fails: the business price is not sent', async () => {
    m.read.mockResolvedValue(listing({ businessPriceRule: 'PERCENT_OFF', businessPricePercent: 5 }))
    const { amazonSpApiClient } = await import('../clients/amazon-sp-api.client.js')
    vi.mocked(amazonSpApiClient.submitListingPayload).mockResolvedValueOnce({ success: false, error: 'Throttled' } as never)
    await service.syncToAmazon(pricePush(115))
    expect(m.offerPatch).not.toHaveBeenCalled()
  })

  it('the business send fails after the normal price went: the price push still stands, and the failure is kept on the listing', async () => {
    m.read.mockResolvedValue(listing({ businessPriceRule: 'PERCENT_OFF', businessPricePercent: 5 }))
    m.offerPatch.mockResolvedValue({ success: false, sku: SKU, error: 'Throttled' })
    const result = await service.syncToAmazon(pricePush(115))
    expect(result).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(kept()).toMatchObject({ status: 'REFUSED' })
  })
})
