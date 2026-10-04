/**
 * Amazon sheet gaps (D4=B) — the price and stock jobs send LIVE offer facts only, never a product-sheet draft.
 *
 * On a live Amazon listing an offer edit on the product sheet is saved as a draft (`platformAttributes.amazonOfferDraft`)
 * that goes to Amazon only on Publish. Meanwhile the background jobs keep sending the live values (`offer-facts.ts`, job
 * lane) — and keep every leaf, so nothing is cleared and nothing of the draft leaks. Old sheet values saved in
 * `overrideData` (never sent) are not read either. Expected payloads first; the harness is the merge test's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => {
  const outbound = vi.fn(() => { throw new Error('Unexpected outbound fetch') }); vi.stubGlobal('fetch', outbound)
  return { outbound, read: vi.fn(), many: vi.fn(), seller: vi.fn(), audit: vi.fn(), get: vi.fn(), validate: vi.fn(), submit: vi.fn(), windows: vi.fn(), ledger: vi.fn(), writes: vi.fn() }
})
vi.mock('../db.js', () => {
  const rows: Record<string, unknown> = {
    product: { id: 'p', sku: 'TEST-SKU-1', name: 'Jacket', translations: [], parent: null },
    marketplace: { currency: 'EUR', languages: ['it'], language: 'it' },
  }
  const write = (model: string, op: string) => vi.fn(async (args: unknown) => { m.writes(model, op, args); return op === 'updateMany' ? { count: 0 } : {} })
  const table = (model: string) => ({
    findUnique: model === 'channelListing' ? m.read : vi.fn(async () => rows[model] ?? null),
    findMany: model === 'channelListing' ? m.many : vi.fn(async () => []),
    findFirst: vi.fn(async () => (model === 'offer' ? null : rows[model] ?? null)),
    findUniqueOrThrow: vi.fn(async () => rows[model] ?? {}),
    findFirstOrThrow: vi.fn(async () => rows[model] ?? {}),
    create: write(model, 'create'), update: write(model, 'update'), updateMany: write(model, 'updateMany'), upsert: write(model, 'upsert'),
    count: vi.fn(async () => 0), aggregate: vi.fn(async () => ({ _sum: { quantity: null } })),
  })
  const cache = new Map<string, unknown>()
  return {
    default: new Proxy({}, {
      get: (_t, model: string) => {
        if (model === '$transaction') return async (run: any) => (typeof run === 'function' ? run({}) : run)
        if (model === '$executeRaw' || model === '$executeRawUnsafe') return async (...args: unknown[]) => { m.writes('raw', model, args); return 0 }
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
vi.mock('../clients/amazon-sp-api.client.js', () => ({
  amazonSpApiClient: {
    getListingsItem: vi.fn(async (options: any) => m.get(options)),
    validateListing: vi.fn(async (options: any) => { m.validate(options); return { ok: true, available: true, errors: null, warnings: [] } }),
    submitListingPayload: vi.fn(async (options: any) => { m.submit(options); return { success: true } }),
  },
}))

const { OutboundSyncService } = await import('./outbound-sync.service.js')
const { syncLedgerOf } = await import('./sync-control-core.js')
const { liveRead } = await import('../test-support/amazon-offer-model.js')
const service: any = new OutboundSyncService()

const IT = 'APJ6JRA9NG5V4'
const RESTOCK = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)
const scheduled = (n: number) => [{ schedule: [{ value_with_tax: n }] }]
const saved = (value: unknown, base: unknown) => ({ value, base, savedAt: '2026-10-02T08:00:00.000Z', savedBy: 'sheet@test' })

// Live: 49.90 pinned · min 30 · max 60 · MAP 40 · rule R1 · handling 2 days · a restock date.
// Drafts waiting for Publish: price 44.90 · min 35 · handling 5. Old never-sent sheet values in overrideData.
const platformAttributes = () => ({
  amazonOffer: { minimum_seller_allowed_price: 30, maximum_seller_allowed_price: 60, map_price: 40, automated_pricing_rule_id: 'R1' },
  amazonFulfillment: { lead_time_to_ship_max_days: 2, restock_date: RESTOCK },
  amazonOfferDraft: { v: 1, leaves: {
    our_price: saved({ pin: 44.9 }, { pin: 49.9 }),
    minimum_seller_allowed_price: saved(35, 30),
    lead_time_to_ship_max_days: saved(5, 2),
  } },
})
const listing = () => ({
  id: 'l', marketplace: 'IT', syncPaused: false, offerClosedAt: null, fulfillmentMethod: 'FBM', quantity: 7, stockBuffer: 0, sourceLocationCodes: [],
  followMasterQuantity: true, price: 49.9, priceOverride: 49.9, followMasterPrice: false, salePrice: null,
  platformAttributes: platformAttributes(),
  overrideData: { purchasable_offer__our_price: 41, fulfillment_availability__lead_time_to_ship_max_days: 9, purchasable_offer__map_price: 12 },
})
const row = (syncType: string, payload: Record<string, unknown>) => ({
  id: 'q', channelListingId: 'l', channelConnectionId: 'amz-1', targetChannel: 'AMAZON', targetRegion: 'IT', syncType,
  product: { id: 'p', sku: 'TEST-SKU-1', productType: 'OUTERWEAR', fulfillmentMethod: null, isParent: false }, payload,
})
// The rows the price door and the stock cascade queue: the live price and the listing's quantity.
const pricePush = () => row('PRICE_UPDATE', { source: 'CHANNEL_PRICE_WRITE', marketplace: 'IT', price: 49.9, salePrice: null, salePriceStart: null, salePriceEnd: null, productType: 'OUTERWEAR' })
const stockPush = () => row('QUANTITY_UPDATE', { source: 'STOCK_MOVEMENT', quantity: 7, productType: 'OUTERWEAR' })
const submitted = () => m.submit.mock.calls[0][0].payload

const LIVE_OFFER = {
  currency: 'EUR', marketplace_id: IT, our_price: scheduled(49.9),
  minimum_seller_allowed_price: scheduled(30), maximum_seller_allowed_price: scheduled(60), map_price: scheduled(40),
  automated_pricing_merchandising_rule_plan: [{ merchandising_rule: { rule_id: 'R1' } }],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXUS_ENABLE_AMAZON_PUBLISH', 'true'); vi.stubEnv('AMAZON_PUBLISH_MODE', 'live')
  vi.stubEnv('NEXUS_AMAZON_OFFER_MERGE', '')
  m.seller.mockResolvedValue('seller')
  m.read.mockResolvedValue(listing())
  m.many.mockResolvedValue([])
  m.windows.mockResolvedValue(new Map())
  m.ledger.mockImplementation(async (_db: unknown, ids: string[]) => new Map(ids.map((id) => [id, {
    productId: id, source: { kind: 'own' }, ledger: syncLedgerOf([{ locationCode: 'WH-IT', available: 50, syncRoutes: ['AMAZON:IT'] }]),
    quantity: 50, available: 50, uncountedIsZero: false, fbaBucket: 0,
  }])))
})
afterEach(() => { vi.unstubAllEnvs() })

const noListingWrite = () => {
  const touched = m.writes.mock.calls.filter(([model, , args]) => model === 'channelListing' || model === 'raw'
    || JSON.stringify(args ?? '').includes('platformAttributes') || JSON.stringify(args ?? '').includes('overrideData'))
  expect(touched).toEqual([])
}

describe('a price push while drafts wait for Publish', () => {
  it('the replace carries the live 49.90 / 30 / 60 / 40 / R1 — never the draft 44.90 / 35, never overrideData', async () => {
    expect(await service.syncToAmazon(pricePush())).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(submitted().patches).toEqual([{ op: 'replace', path: '/attributes/purchasable_offer', value: [LIVE_OFFER] }])
    const body = JSON.stringify(submitted())
    expect(body).not.toContain('44.9')
    expect(body).not.toContain('"value_with_tax":35')
    expect(body).not.toContain('"value_with_tax":41')
    expect(body).not.toContain('"value_with_tax":12')
    noListingWrite()
  })

  it('merge mode: the held leaves are the live ones, and only Nexus\'s own store (Amazon keeps the rest)', async () => {
    vi.stubEnv('NEXUS_AMAZON_OFFER_MERGE', '1')
    m.get.mockResolvedValue(liveRead([{ audience: 'ALL', currency: 'EUR', marketplace_id: IT, our_price: scheduled(49.9), minimum_seller_allowed_price: scheduled(28), start_at: { value: '2026-01-01' } }]))
    expect(await service.syncToAmazon(pricePush())).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(submitted().patches).toEqual([{
      op: 'merge', path: '/attributes/purchasable_offer',
      value: [{ ...LIVE_OFFER, audience: 'ALL' }],
    }])
    noListingWrite()
  })
})

describe('a quantity push while drafts wait for Publish', () => {
  it('[{DEFAULT, 7, lead 2, restock}] — the live handling time, never the draft 5, never overrideData\'s 9', async () => {
    expect(await service.syncToAmazon(stockPush())).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(submitted().patches).toEqual([
      { op: 'replace', path: '/attributes/fulfillment_availability', value: [{ fulfillment_channel_code: 'DEFAULT', quantity: 7, lead_time_to_ship_max_days: 2, restock_date: RESTOCK }] },
    ])
    noListingWrite()
  })
})

it('the draft is left exactly as it was: the jobs read it never and write it never', async () => {
  const before = JSON.stringify(listing().platformAttributes)
  await service.syncToAmazon(pricePush())
  await service.syncToAmazon(stockPush())
  expect(m.submit).toHaveBeenCalledTimes(2)
  noListingWrite()
  expect(JSON.stringify((await m.read.mock.results[0].value).platformAttributes)).toBe(before)
})
