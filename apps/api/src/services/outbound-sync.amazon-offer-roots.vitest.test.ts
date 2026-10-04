/**
 * Amazon sheet gaps (bug 2) — the price job and the stock job stop wiping Amazon's offer leaves.
 *
 * An Amazon PATCH `replace` of `/attributes/<root>` sets the WHOLE root. The stock job sent `[{DEFAULT, quantity}]`, so
 * every stock push cleared the handling time and the restock date; the price job sent `{currency, our_price, sale}`, so
 * with NEXUS_AMAZON_OFFER_MERGE off every price push cleared the min/max seller price, MAP price, offer window and
 * Automate Pricing rule. Both roots now come from THE send builder (`amazon/offer-attributes.ts`) over the listing's
 * LIVE facts (`offer-facts.ts`, job lane). Each expected payload below was written before the code.
 *
 * The harness is the merge test's (`outbound-sync.amazon-offer-merge.vitest.test.ts`): live mode, every outside call
 * faked, `submitListingPayload` records what would go out. Nothing reaches Amazon. SKUs are fake; marketplace ids are
 * Amazon's public ones.
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
// The product's ledger at send time: 50 units in a warehouse routed to Amazon IT.
vi.mock('./stock-pool/sync-ledgers.js', async (original) => ({ ...(await original<object>()), loadSyncLedgers: m.ledger }))
vi.mock('./sync-health.service.js', () => ({ syncHealthService: { logConflict: m.conflict } }))
vi.mock('../clients/amazon-sp-api.client.js', () => ({
  amazonSpApiClient: {
    getListingsItem: vi.fn(async (options: any) => m.get(options)),
    validateListing: vi.fn(async (options: any) => { m.validate(options); return { ok: true, available: true, errors: null, warnings: [] } }),
    submitListingPayload: vi.fn(async (options: any) => { m.submit(options); return { success: true } }),
  },
}))

const { OutboundSyncService, buildAmazonListingPatch } = await import('./outbound-sync.service.js')
const { readAmazonOfferFacts } = await import('./amazon/offer-facts.js')
const { syncLedgerOf } = await import('./sync-control-core.js')
const service: any = new OutboundSyncService()

const IT = 'APJ6JRA9NG5V4'
const SKU = 'TEST-SKU-1'
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
const RESTOCK = day(30)
const scheduled = (n: number) => [{ schedule: [{ value_with_tax: n }] }]

/** The listing row the job reads (its select). */
const listing = (over: Record<string, unknown> = {}) => ({
  id: 'l', marketplace: 'IT', syncPaused: false, offerClosedAt: null, fulfillmentMethod: 'FBM', quantity: 9, stockBuffer: 0,
  sourceLocationCodes: [], followMasterQuantity: true, price: 49.9, priceOverride: 49.9, followMasterPrice: false, salePrice: null,
  platformAttributes: {}, ...over,
})
const row = (syncType: string, payload: Record<string, unknown>, product: Record<string, unknown> = {}) => ({
  id: 'q', channelListingId: 'l', channelConnectionId: 'amz-1', targetChannel: 'AMAZON', targetRegion: 'IT', syncType,
  product: { id: 'p', sku: SKU, productType: 'OUTERWEAR', fulfillmentMethod: null, isParent: false, ...product }, payload,
})
const stockPush = (quantity: number) => row('QUANTITY_UPDATE', { source: 'STOCK_MOVEMENT', quantity, productType: 'OUTERWEAR' })
const pricePush = (extra: Record<string, unknown> = {}) => row('PRICE_UPDATE', { source: 'CHANNEL_PRICE_WRITE', marketplace: 'IT', price: 49.9, salePrice: null, salePriceStart: null, salePriceEnd: null, productType: 'OUTERWEAR', ...extra })

const submitted = () => m.submit.mock.calls[0][0].payload
const patchAt = (path: string) => submitted().patches.find((p: { path: string }) => p.path === `/attributes/${path}`)

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
  m.ledger.mockImplementation(async (_db: unknown, ids: string[]) => new Map(ids.map((id) => [id, {
    productId: id, source: { kind: 'own' }, ledger: syncLedgerOf([{ locationCode: 'WH-IT', available: 50, syncRoutes: ['AMAZON:IT'] }]),
    quantity: 50, available: 50, uncountedIsZero: false, fbaBucket: 0,
  }])))
})
afterEach(() => { vi.unstubAllEnvs() })

describe('a quantity-only push keeps the handling time and the restock date', () => {
  it('[{DEFAULT, 9, lead 4, restock}] — and no offer root', async () => {
    m.read.mockResolvedValue(listing({ platformAttributes: { amazonFulfillment: { lead_time_to_ship_max_days: 4, restock_date: RESTOCK } } }))
    const result = await service.syncToAmazon(stockPush(9))
    expect(result, JSON.stringify(result)).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(submitted().patches).toEqual([
      { op: 'replace', path: '/attributes/fulfillment_availability', value: [{ fulfillment_channel_code: 'DEFAULT', quantity: 9, lead_time_to_ship_max_days: 4, restock_date: RESTOCK }] },
    ])
  })

  it('Amazon\'s own report (the pull\'s mirror) is echoed when Nexus holds no value: always available stays as reported', async () => {
    m.read.mockResolvedValue(listing({ platformAttributes: { attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 3, lead_time_to_ship_max_days: 6, is_inventory_available: false }] } } }))
    await service.syncToAmazon(stockPush(9))
    expect(patchAt('fulfillment_availability').value).toEqual([{ fulfillment_channel_code: 'DEFAULT', quantity: 9, lead_time_to_ship_max_days: 6, is_inventory_available: false }])
  })

  it('a restock date that has passed is not sent; Nexus\'s own cleared value (null) beats the mirror', async () => {
    m.read.mockResolvedValue(listing({ platformAttributes: {
      amazonFulfillment: { lead_time_to_ship_max_days: null, restock_date: day(-1) },
      attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', lead_time_to_ship_max_days: 6 }] },
    } }))
    await service.syncToAmazon(stockPush(9))
    expect(patchAt('fulfillment_availability').value).toEqual([{ fulfillment_channel_code: 'DEFAULT', quantity: 9 }])
  })

  it('the builder alone: buildAmazonListingPatch({quantity: 9}, …, FBM, no content, {lead: 4}) carries lead 4', async () => {
    const facts = readAmazonOfferFacts({ marketplace: 'IT', platformAttributes: { amazonFulfillment: { lead_time_to_ship_max_days: 4 } } }, 'job')
    const built = await buildAmazonListingPatch({ quantity: 9 } as never, 'IT', 'OUTERWEAR', 'FBM', undefined, { facts })
    expect(built.patches).toEqual([{ op: 'replace', path: '/attributes/fulfillment_availability', value: [{ fulfillment_channel_code: 'DEFAULT', quantity: 9, lead_time_to_ship_max_days: 4 }] }])
  })
})

describe('a price-only push keeps every offer leaf Nexus knows', () => {
  const offer = { minimum_seller_allowed_price: 30, maximum_seller_allowed_price: 60, map_price: 40, start_at: '2026-01-01', end_at: '2027-12-31', automated_pricing_rule_id: 'R1' }

  it('our price + sale + min/max + MAP + offer window + Automate Pricing rule — and no fulfilment root', async () => {
    m.read.mockResolvedValue(listing({ platformAttributes: { amazonOffer: offer, amazonFulfillment: { lead_time_to_ship_max_days: 4 } } }))
    const result = await service.syncToAmazon(pricePush({ salePrice: 39.9, salePriceStart: '2026-10-10', salePriceEnd: '2026-10-20' }))
    expect(result, JSON.stringify(result)).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(submitted().patches).toEqual([{
      op: 'replace', path: '/attributes/purchasable_offer',
      value: [{
        currency: 'EUR', marketplace_id: IT,
        our_price: scheduled(49.9),
        discounted_price: [{ schedule: [{ start_at: '2026-10-10', end_at: '2026-10-20', value_with_tax: 39.9 }] }],
        minimum_seller_allowed_price: scheduled(30),
        maximum_seller_allowed_price: scheduled(60),
        map_price: scheduled(40),
        start_at: { value: '2026-01-01' },
        end_at: { value: '2027-12-31' },
        automated_pricing_merchandising_rule_plan: [{ merchandising_rule: { rule_id: 'R1' } }],
      }],
    }])
  })

  it('the leaves Amazon reported (the pull\'s mirror) ride the replace when Nexus holds none — a replace never drops them', async () => {
    m.read.mockResolvedValue(listing({ platformAttributes: { attributes: { purchasable_offer: [{
      marketplace_id: IT, currency: 'EUR', audience: 'ALL', our_price: scheduled(45), map_price: scheduled(41), maximum_seller_allowed_price: scheduled(80),
    }] } } }))
    await service.syncToAmazon(pricePush())
    expect(patchAt('purchasable_offer').value).toEqual([{ currency: 'EUR', marketplace_id: IT, our_price: scheduled(49.9), map_price: scheduled(41), maximum_seller_allowed_price: scheduled(80) }])
  })

  it('a leaf Nexus cleared (null in its own store) is left out, even though the mirror still has it', async () => {
    m.read.mockResolvedValue(listing({ platformAttributes: {
      amazonOffer: { map_price: null },
      attributes: { purchasable_offer: [{ marketplace_id: IT, currency: 'EUR', map_price: scheduled(41) }] },
    } }))
    await service.syncToAmazon(pricePush())
    expect(patchAt('purchasable_offer').value).toEqual([{ currency: 'EUR', marketplace_id: IT, our_price: scheduled(49.9) }])
  })
})

describe('FBA: no fulfilment root and no merchant quantity, ever', () => {
  const fbaCases: Array<[string, () => void]> = [
    ['the listing says FBA', () => m.read.mockResolvedValue(listing({ fulfillmentMethod: 'FBA', platformAttributes: { amazonFulfillment: { lead_time_to_ship_max_days: 4 } } }))],
    ['an AMAZON_EU code in Nexus\'s own entry, the listing marker says FBM', () => m.read.mockResolvedValue(listing({ platformAttributes: { amazonFulfillment: { lead_time_to_ship_max_days: 4 }, fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] } }))],
    ['a Remote Fulfilment code beside DEFAULT', () => m.read.mockResolvedValue(listing({ platformAttributes: { attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 2 }, { fulfillment_channel_code: 'AMAZON_EU_RAFN' }] } } }))],
    ['FBA stock on hand', () => m.fbaStock.mockResolvedValue({ _sum: { quantity: 12 } })],
    ['an active FBA offer', () => m.fbaOffer.mockResolvedValue({ id: 'offer-1' })],
  ]
  it.each(fbaCases)('stock push, %s → nothing sent', async (_label, arrange) => {
    arrange()
    const result = await service.syncToAmazon(stockPush(9))
    expect(m.submit).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: true, status: 'SKIPPED', errorCode: 'AMAZON_EMPTY_PATCH_NOT_SENT', retryable: false })
    expect(result.message).toBe('Amazon manages the FBA quantity. Nothing was sent to the channel.')
  })

  it('D9 = A: an old AMAZON_EU only in the copy Amazon\'s pull left does not stop the stock push of an FBM listing', async () => {
    m.read.mockResolvedValue(listing({ platformAttributes: { amazonFulfillment: { lead_time_to_ship_max_days: 4 }, attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] } } }))
    await service.syncToAmazon(stockPush(9))
    expect(m.submit).toHaveBeenCalled()
    expect(patchAt('fulfillment_availability').value).toEqual([{ fulfillment_channel_code: 'DEFAULT', quantity: 9, lead_time_to_ship_max_days: 4 }])
  })

  it('a price + quantity push on an FBA listing sends the offer alone: no fulfilment root, no quantity anywhere', async () => {
    m.read.mockResolvedValue(listing({ fulfillmentMethod: 'FBA', platformAttributes: { amazonFulfillment: { lead_time_to_ship_max_days: 4 }, amazonOffer: { map_price: 40 } } }))
    await service.syncToAmazon(row('FULL_SYNC', { price: 49.9, quantity: 9, productType: 'OUTERWEAR' }))
    const body = JSON.stringify(submitted())
    expect(submitted().patches.map((p: { path: string }) => p.path)).toEqual(['/attributes/purchasable_offer'])
    expect(body).not.toContain('fulfillment_availability')
    expect(body).not.toMatch(/"quantity"/)
    expect(body).not.toContain('lead_time_to_ship_max_days')
  })
})

describe('a price outside the seller\'s own minimum and maximum is refused, nothing sent', () => {
  it.each([
    ['above the maximum (Nexus\'s own store)', { amazonOffer: { minimum_seller_allowed_price: 30, maximum_seller_allowed_price: 60 } }, 70, null,
      'TEST-SKU-1: 70.00 is above the maximum price on Amazon (60.00), so Amazon would refuse it. Change the price or the maximum price.'],
    ['below the minimum (Amazon\'s report)', { attributes: { purchasable_offer: [{ marketplace_id: IT, currency: 'EUR', minimum_seller_allowed_price: scheduled(30) }] } }, 25, null,
      'TEST-SKU-1: 25.00 is below the minimum price on Amazon (30.00), so Amazon would refuse it. Change the price or the minimum price.'],
    ['a sale below the minimum', { amazonOffer: { minimum_seller_allowed_price: 30 } }, 49.9, { salePrice: 20, salePriceStart: '2026-10-10', salePriceEnd: '2026-10-20' },
      'TEST-SKU-1: The sale price 20.00 is below the minimum price on Amazon (30.00), so Amazon would refuse it. Change the price or the minimum price.'],
  ])('%s', async (_label, platformAttributes, price, sale, sentence) => {
    m.read.mockResolvedValue(listing({ platformAttributes }))
    const result = await service.syncToAmazon(pricePush({ price, ...(sale ?? {}) }))
    expect(m.submit).not.toHaveBeenCalled()
    expect(m.validate).not.toHaveBeenCalled()
    expect(result).toEqual({ success: false, queueId: 'q', channel: 'AMAZON', status: 'FAILED', message: sentence, error: sentence, errorCode: 'AMAZON_PRICE_OUTSIDE_SELLER_BOUNDS', retryable: false })
  })

  it('control: inside the bounds the price is sent', async () => {
    m.read.mockResolvedValue(listing({ platformAttributes: { amazonOffer: { minimum_seller_allowed_price: 30, maximum_seller_allowed_price: 60 } } }))
    expect(await service.syncToAmazon(pricePush({ price: 60 }))).toMatchObject({ success: true, status: 'SUCCESS' })
  })

  it('a stock push is never refused for the price bounds', async () => {
    m.read.mockResolvedValue(listing({ price: 70, priceOverride: 70, platformAttributes: { amazonOffer: { maximum_seller_allowed_price: 60 } } }))
    expect(await service.syncToAmazon(stockPush(9))).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(submitted().patches.map((p: { path: string }) => p.path)).toEqual(['/attributes/fulfillment_availability'])
  })
})

describe('the stock job sends THE send quantity (`amazon/send-quantity.ts`), with its answers as before', () => {
  it('the committed listing quantity beats the row\'s, and is clamped to the routed stock minus the buffer', async () => {
    m.read.mockResolvedValue(listing({ quantity: 80, stockBuffer: 5 }))
    await service.syncToAmazon(stockPush(3))
    expect(patchAt('fulfillment_availability').value).toEqual([{ fulfillment_channel_code: 'DEFAULT', quantity: 45 }])
  })

  it('no location routed to the market → refused, never capped to 0', async () => {
    m.ledger.mockImplementation(async (_db: unknown, ids: string[]) => new Map(ids.map((id) => [id, {
      productId: id, source: { kind: 'own' }, ledger: syncLedgerOf([{ locationCode: 'WH-DE', available: 50, syncRoutes: ['AMAZON:DE'] }]),
      quantity: 50, available: 50, uncountedIsZero: false, fbaBucket: 0,
    }])))
    const result = await service.syncToAmazon(stockPush(9))
    expect(m.submit).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: false, status: 'FAILED', errorCode: 'NO_ROUTED_LOCATION', retryable: false })
    expect(result.error).toMatch(/^Nothing was sent to Amazon: no stock location is routed to IT/)
  })

  it('EU siblings that disagree → refused (SKIPPED), never overwritten', async () => {
    m.many.mockResolvedValue([
      { marketplace: 'IT', followMasterQuantity: true, quantityOverride: null, quantity: 9, syncPaused: false, fulfillmentMethod: 'FBM' },
      { marketplace: 'DE', followMasterQuantity: false, quantityOverride: 0, quantity: 0, syncPaused: false, fulfillmentMethod: 'FBM' },
    ])
    const result = await service.syncToAmazon(stockPush(9))
    expect(m.submit).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: false, status: 'SKIPPED', error: 'eu-shared-qty-conflict' })
    expect(result.message).toMatch(/^EU shared-quantity conflict for TEST-SKU-1: /)
    expect(m.conflict).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      channel: 'AMAZON', conflictType: 'EU_SHARED_QTY_CONFLICT', message: result.message, productId: 'p', remoteData: { attemptedQuantity: 9, marketplace: 'IT' },
    }))
  })

  it('the EU guard cannot read the siblings → held (SKIPPED), never sent blind', async () => {
    m.many.mockRejectedValue(new Error('connection reset'))
    const result = await service.syncToAmazon(stockPush(9))
    expect(m.submit).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: false, status: 'SKIPPED', error: 'eu-shared-qty-guard-unavailable' })
    expect(result.message).toMatch(/^EU shared-quantity guard could not run for TEST-SKU-1 \(connection reset\)\. Push held rather than sent blind/)
    expect(m.conflict).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ conflictType: 'EU_SHARED_QTY_GUARD_UNAVAILABLE', localData: { guardError: 'connection reset' } }))
  })
})

describe('a parent has no offer of its own', () => {
  it('a price push to a parent sends no offer root (never one that clears Amazon\'s price)', async () => {
    const result = await service.syncToAmazon(row('PRICE_UPDATE', { price: 49.9, productType: 'OUTERWEAR' }, { isParent: true }))
    expect(m.submit).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: 'SKIPPED', errorCode: 'AMAZON_EMPTY_PATCH_NOT_SENT' })
  })
})
