/**
 * S4 (per-channel SKU, docs/sheet-ids-sku-rows/PLAN.md) — the eBay queue push (`syncToEbay`, Inventory API) names the SKU
 * eBay HOLDS for THIS listing (`listingSendSku`): the product SKU for a listing with none of its own (exactly as before),
 * its own confirmed SKU otherwise. An extra listing's alias SKU and a wanted SKU eBay has not confirmed are not named
 * (eBay never received them); a still-draft row and a row with no listing name what they named before.
 *
 * Live mode, every outside call faked: `ebaySend` (the channel gateway) records what would go out and answers. Nothing
 * reaches eBay. SKUs are fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => {
  const outbound = vi.fn(() => { throw new Error('Unexpected outbound fetch') }); vi.stubGlobal('fetch', outbound)
  return { outbound, read: vi.fn(), send: vi.fn(), audit: vi.fn(), ledger: vi.fn(), writeAccount: vi.fn() }
})
vi.mock('../db.js', () => ({
  default: {
    channelListing: { findUnique: m.read, findMany: vi.fn(async () => []) },
    marketplace: { findFirst: vi.fn(async () => ({ currency: 'EUR', languages: ['it'], language: 'it' })), findMany: vi.fn(async () => [{ channel: 'EBAY', code: 'IT', currency: 'EUR' }]) },
    product: { findUnique: vi.fn(async () => ({ minPrice: null, maxPrice: null })) },
    offer: { findFirst: vi.fn(async () => null) },
    stockPoolLink: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => []),
  },
}))
vi.mock('../lib/queue.js', () => ({ addJobSafely: vi.fn(), outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
vi.mock('./sync-control-policy.service.js', () => ({ loadChannelPolicies: async () => new Map(), policyFor: () => null }))
vi.mock('./channel-publish-audit.service.js', () => ({ writeAttemptLog: m.audit, digestPayload: () => 'stub' }))
vi.mock('./stock-pool/sync-ledgers.js', async (original) => ({ ...(await original<object>()), loadSyncLedgers: m.ledger }))
vi.mock('./price-bounds.service.js', async (original) => ({ ...(await original<object>()), priceRefusalFor: vi.fn(async () => null) }))
vi.mock('./write-account-guard.js', () => ({ assertWriteAccount: m.writeAccount, isWrongAccountWriteError: () => false }))
vi.mock('./connection-resolver.service.js', async (original) => ({ ...(await original<object>()),
  tryResolveConnection: vi.fn(async ({ accountId }: { accountId?: string }) => (accountId ? { id: accountId, channelType: 'EBAY' } : null)) }))
vi.mock('./ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: vi.fn(async (id: string) => `token-${id}`) } }))
vi.mock('./gateway/channels.js', async (original) => ({ ...(await original<object>()), ebayListingLanguage: vi.fn(async () => 'it-IT') }))
vi.mock('./ebay-publish-gate.service.js', async (original) => ({ ...(await original<object>()),
  getEbayPublishMode: () => 'live', checkEbayCircuit: () => ({ ok: true }), acquireEbayPublishToken: async () => ({ ok: true }), recordEbayOutcome: () => undefined,
  getEbayApiBaseForMode: () => 'https://api.ebay.test' }))
vi.mock('./gateway/ebay.js', async (original) => ({ ...(await original<object>()), ebaySend: m.send }))

const { OutboundSyncService } = await import('./outbound-sync.service.js')
const { syncLedgerOf } = await import('./sync-control-core.js')
const service: any = new OutboundSyncService()

const SKU = 'TEST-SKU-1'
// The item is on eBay's Inventory API (its offer id stored, `usesEbayInventory`): this file pins the Inventory calls. A
// Trading item's rows go out with ReviseInventoryStatus (outbound-sync.ebay-trading-listing.vitest.test.ts).
const LIVE = { listingStatus: 'ACTIVE', isPublished: true, externalListingId: '110000000001', platformAttributes: { __offerIds: { EBAY_IT: 'OFF-1' } } }
/** The listing row the job reads (its select), live, with no SKU of its own unless `over` gives one. */
const listing = (over: Record<string, unknown> = {}) => ({
  id: 'l', productId: 'p', channel: 'EBAY', aliasKey: '', marketplace: 'IT', syncPaused: false, offerClosedAt: null, fulfillmentMethod: 'FBM', quantity: 9, stockBuffer: 0,
  sourceLocationCodes: [], channelConnectionId: 'ebay-a', channelSku: null, liveChannelSku: null, ...LIVE, ...over,
})
const row = (syncType: string, payload: Record<string, unknown>) => ({
  id: 'q', channelListingId: 'l', channelConnectionId: 'ebay-a', targetChannel: 'EBAY', targetRegion: 'IT', syncType,
  product: { id: 'p', sku: SKU }, payload,
})
const stockPush = () => row('QUANTITY_UPDATE', { quantity: 4, marketplaceId: 'EBAY_IT' })
const contentPush = () => row('FULL_SYNC', { title: 'A title', description: 'Copy', marketplaceId: 'EBAY_IT' })
const pricePush = () => row('PRICE_UPDATE', { price: 19.9, marketplaceId: 'EBAY_IT' })
const offer = { offerId: 'OFF-1', sku: 'x', marketplaceId: 'EBAY_IT', format: 'FIXED_PRICE', pricingSummary: { price: { value: '18.00', currency: 'EUR' } }, availableQuantity: 4 }
const response = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) })
/** Every SKU the push named to eBay: in a URL (`inventory_item/{sku}`, `offer?sku=`) or a bulk request body. */
const namedSkus = () => m.send.mock.calls.flatMap(([, url, init]: [string, string, RequestInit | undefined]) => {
  const found: string[] = []
  const path = /inventory_item\/([^?/]+)/.exec(url)?.[1] ?? new URL(url).searchParams.get('sku')
  if (path) found.push(decodeURIComponent(path))
  if (typeof init?.body === 'string' && url.includes('bulk_update_price_quantity')) found.push(...(JSON.parse(init.body).requests ?? []).map((r: any) => r.sku))
  return found
})

beforeEach(() => {
  vi.clearAllMocks()
  m.read.mockResolvedValue(listing())
  m.ledger.mockImplementation(async (_db: unknown, ids: string[]) => new Map(ids.map((id) => [id, {
    productId: id, source: { kind: 'own' }, ledger: syncLedgerOf([{ locationCode: 'WH-IT', available: 50, syncRoutes: ['EBAY:IT'] }]),
    quantity: 50, available: 50, uncountedIsZero: false, fbaBucket: 0,
  }])))
  m.send.mockImplementation(async (_account: string, url: string, init?: RequestInit) => {
    if (url.includes('bulk_update_price_quantity')) return response({ responses: [{ statusCode: 200 }] })
    if (url.includes('/offer?sku=')) return response({ offers: [offer] })
    if (url.includes('/inventory_item/') && (!init?.method || init.method === 'GET')) return response({ product: { title: 'Old' }, availability: {} })
    return response({}, 204)
  })
})
afterEach(() => { vi.unstubAllEnvs() })

describe('parity — a listing with no SKU of its own is sent under the product SKU, as before', () => {
  it.each([
    ['a stock push (offer read + bulk quantity)', stockPush],
    ['a content push (inventory_item GET + PUT)', contentPush],
    ['a price push (offer read + offer PUT)', pricePush],
  ])('%s', async (_name, make) => {
    const result = await service.syncToEbay(make())
    expect(result, JSON.stringify(result)).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(namedSkus().length).toBeGreaterThan(0)
    expect(new Set(namedSkus())).toEqual(new Set([SKU]))
  })

  it('a row with no listing names the product SKU (no listing to read a SKU from)', async () => {
    m.read.mockResolvedValue(null)
    expect(await service.syncToEbay({ ...stockPush(), channelListingId: null })).toMatchObject({ success: true })
    expect(new Set(namedSkus())).toEqual(new Set([SKU]))
  })
})

describe('a listing with its own SKU on eBay is sent under that SKU', () => {
  it.each([
    ['stock', stockPush],
    ['content', contentPush],
    ['price', pricePush],
  ])('%s push: every call names the confirmed own SKU', async (_name, make) => {
    m.read.mockResolvedValue(listing({ liveChannelSku: 'OWN-IT', channelSku: 'OWN-IT' }))
    expect(await service.syncToEbay(make())).toMatchObject({ success: true, status: 'SUCCESS', message: 'Product OWN-IT synced to eBay' })
    expect(new Set(namedSkus())).toEqual(new Set(['OWN-IT']))
  })

  it('the SKU eBay holds wins over a wanted one not yet published', async () => {
    m.read.mockResolvedValue(listing({ liveChannelSku: 'OLD-IT', channelSku: 'NEW-IT' }))
    await service.syncToEbay(stockPush())
    expect(new Set(namedSkus())).toEqual(new Set(['OLD-IT']))
  })

  it('a wanted SKU eBay has not confirmed is not named (eBay still holds the product SKU)', async () => {
    m.read.mockResolvedValue(listing({ channelSku: 'WANT-IT' }))
    await service.syncToEbay(pricePush())
    expect(new Set(namedSkus())).toEqual(new Set([SKU]))
  })

  it('an extra listing (alias) row: the alias SKU was never sent to eBay, so the product SKU is named', async () => {
    m.read.mockResolvedValue(listing({ aliasKey: 'alias-1' }))
    await service.syncToEbay(stockPush())
    expect(new Set(namedSkus())).toEqual(new Set([SKU]))
  })

  it('a still-draft row names what it named before (the product SKU), never its wanted SKU', async () => {
    m.read.mockResolvedValue(listing({ listingStatus: 'DRAFT', isPublished: false, externalListingId: null, channelSku: 'WANT-IT' }))
    await service.syncToEbay(contentPush())
    expect(namedSkus().every((sku) => sku === SKU)).toBe(true)
  })

  it('the calls go through the row\'s own account, and the write-account check reads the listing', async () => {
    m.read.mockResolvedValue(listing({ liveChannelSku: 'OWN-IT' }))
    await service.syncToEbay(stockPush())
    expect(new Set(m.send.mock.calls.map(([account]: [string]) => account))).toEqual(new Set(['ebay-a']))
    expect(m.writeAccount).toHaveBeenCalledWith('EBAY', 'ebay-a', { listingIds: ['l'] })
  })
})
