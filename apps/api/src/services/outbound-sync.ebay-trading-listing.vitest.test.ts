/**
 * 2026-10-06 (Trading stock sync) — a listing whose eBay item is a Trading item (created with AddFixedPriceItem, no
 * Inventory offer) gets its quantity and price rows through ReviseInventoryStatus, with its own ItemID and SKU.
 *
 * Before: every QUANTITY_UPDATE / PRICE_UPDATE of such a listing went to the Inventory API (`bulk_update_price_quantity`,
 * offers) and died with 25604 "SKU not found" — a 400, so terminal — and eBay kept the old numbers. The model is decided
 * once (`usesEbayInventory` over the item's family); the Trading branch runs after every Inventory-path guard (push lock,
 * pause policy, the routed pool ceiling, price bounds, publish mode, account, circuit, rate token).
 *
 * Live mode, every outside call faked: the Trading call (`__ebayTrading.callTradingApi`, the gateway-backed client) and
 * the Inventory calls (`ebaySend`) record what would go out. Nothing reaches eBay. Ids and SKUs are fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => {
  const outbound = vi.fn(() => { throw new Error('Unexpected outbound fetch') }); vi.stubGlobal('fetch', outbound)
  return {
    outbound, read: vi.fn(), family: vi.fn(), member: vi.fn(), send: vi.fn(), audit: vi.fn(), ledger: vi.fn(), writeAccount: vi.fn(),
    outcome: vi.fn(), mode: vi.fn(() => 'live'), policy: vi.fn(() => null), priceRefusal: vi.fn(async () => null as string | null),
    currency: vi.fn(async ({ where }: any) => ({ currency: where?.code === 'UK' ? 'GBP' : 'EUR' })),
  }
})
vi.mock('../db.js', () => ({
  default: {
    channelListing: { findUnique: m.read, findMany: m.family },
    sharedListingMembership: { findFirst: m.member },
    marketplace: { findFirst: m.currency, findMany: vi.fn(async () => [{ channel: 'EBAY', code: 'IT', currency: 'EUR' }]) },
    product: { findUnique: vi.fn(async () => ({ minPrice: null, maxPrice: null })) },
    offer: { findFirst: vi.fn(async () => null) },
    stockPoolLink: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => []),
  },
}))
vi.mock('../lib/queue.js', () => ({ addJobSafely: vi.fn(), outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
vi.mock('./sync-control-policy.service.js', () => ({ loadChannelPolicies: async () => new Map(), policyFor: m.policy }))
vi.mock('./channel-publish-audit.service.js', () => ({ writeAttemptLog: m.audit, digestPayload: () => 'stub' }))
vi.mock('./stock-pool/sync-ledgers.js', async (original) => ({ ...(await original<object>()), loadSyncLedgers: m.ledger }))
vi.mock('./price-bounds.service.js', async (original) => ({ ...(await original<object>()), priceRefusalFor: m.priceRefusal }))
vi.mock('./write-account-guard.js', () => ({ assertWriteAccount: m.writeAccount, isWrongAccountWriteError: () => false }))
vi.mock('./connection-resolver.service.js', async (original) => ({ ...(await original<object>()),
  tryResolveConnection: vi.fn(async ({ accountId }: { accountId?: string }) => (accountId ? { id: accountId, channelType: 'EBAY' } : null)) }))
vi.mock('./ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: vi.fn(async (id: string) => `token-${id}`) } }))
vi.mock('./gateway/channels.js', async (original) => ({ ...(await original<object>()), ebayListingLanguage: vi.fn(async () => 'it-IT') }))
vi.mock('./ebay-publish-gate.service.js', async (original) => ({ ...(await original<object>()),
  getEbayPublishMode: m.mode, checkEbayCircuit: () => ({ ok: true }), acquireEbayPublishToken: async () => ({ ok: true }), recordEbayOutcome: m.outcome,
  getEbayApiBaseForMode: () => 'https://api.ebay.test' }))
vi.mock('./gateway/ebay.js', async (original) => ({ ...(await original<object>()), ebaySend: m.send }))

const { OutboundSyncService, __ebayTrading, completedSyncQueueData } = await import('./outbound-sync.service.js')
const { TradingApiFailure } = await import('./ebay-trading-api.service.js')
const { syncLedgerOf } = await import('./sync-control-core.js')
const service: any = new OutboundSyncService()
const trading = vi.spyOn(__ebayTrading, 'callTradingApi')

const SKU = 'TEST-SKU-1'
const ITEM = '110000000001'
/** A live listing the studio created with AddFixedPriceItem: an ItemID, no Inventory offer id. */
const listing = (over: Record<string, unknown> = {}) => ({
  id: 'l', productId: 'p', channel: 'EBAY', aliasKey: '', marketplace: 'IT', syncPaused: false, offerClosedAt: null, fulfillmentMethod: 'FBM',
  quantity: null, stockBuffer: 0, sourceLocationCodes: [], channelConnectionId: 'ebay-a', channelSku: null, liveChannelSku: null,
  listingStatus: 'ACTIVE', isPublished: true, externalListingId: ITEM, platformAttributes: {}, ...over,
})
const row = (syncType: string, payload: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  id: 'q', channelListingId: 'l', channelConnectionId: 'ebay-a', targetChannel: 'EBAY', targetRegion: 'IT', syncType,
  product: { id: 'p', sku: SKU }, payload, ...over,
})
const stockPush = (quantity = 4, over: Record<string, unknown> = {}) => row('QUANTITY_UPDATE', { quantity, marketplaceId: 'EBAY_IT' }, over)
const pricePush = (price = 19.9) => row('PRICE_UPDATE', { price, marketplaceId: 'EBAY_IT' })
const ok = (ack = 'Success', extra: Record<string, unknown> = {}) => ({ ack, itemId: ITEM, errors: [], raw: `<Ack>${ack}</Ack>`, ...extra })
/** A product's routed stock: `available` units in a warehouse that feeds eBay IT (own stock, or a lent pool). */
const ledgerWith = (available: number, source: Record<string, unknown> = { kind: 'own' }) => async (_db: unknown, ids: string[]) => new Map(ids.map((id) => [id, {
  productId: id, source, ledger: syncLedgerOf([{ locationCode: 'WH-IT', available, syncRoutes: ['EBAY:IT'] }]),
  quantity: available, available, uncountedIsZero: false, fbaBucket: 0,
}]))
const xmlSent = (call = 0) => String(trading.mock.calls[call]?.[1] ?? '')
const response = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) })
const inventoryCalls = () => m.send.mock.calls.map(([, url]: [string, string]) => url)

beforeEach(() => {
  vi.clearAllMocks()
  m.mode.mockReturnValue('live')
  m.policy.mockReturnValue(null)
  m.priceRefusal.mockResolvedValue(null)
  m.read.mockResolvedValue(listing())
  m.family.mockResolvedValue([{ platformAttributes: {} }])
  m.member.mockResolvedValue(null)
  m.ledger.mockImplementation(ledgerWith(50))
  trading.mockResolvedValue(ok())
  m.send.mockImplementation(async (_account: string, url: string) => {
    if (url.includes('bulk_update_price_quantity')) return response({ responses: [{ statusCode: 200 }] })
    if (url.includes('/offer?sku=')) return response({ offers: [{ offerId: 'OFF-1', sku: SKU, marketplaceId: 'EBAY_IT', format: 'FIXED_PRICE', pricingSummary: { price: { value: '18.00', currency: 'EUR' } } }] })
    return response({}, 204)
  })
})
afterEach(() => { vi.unstubAllEnvs() })

describe('a Trading item: the quantity goes out with ReviseInventoryStatus', () => {
  it('one call, its own ItemID and SKU, through the row\'s account — and no Inventory call at all', async () => {
    const result = await service.syncToEbay(stockPush(4))
    expect(result, JSON.stringify(result)).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(result.dryRun).toBeUndefined()
    expect(trading).toHaveBeenCalledTimes(1)
    const [callName, xml, ctx] = trading.mock.calls[0]
    expect(callName).toBe('ReviseInventoryStatus')
    expect(xml).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <InventoryStatus>
    <ItemID>${ITEM}</ItemID>
    <SKU>${SKU}</SKU>
    <Quantity>4</Quantity>
  </InventoryStatus>
</ReviseInventoryStatusRequest>`)
    expect(ctx).toMatchObject({ oauthToken: 'token-ebay-a', siteId: '101', connectionId: 'ebay-a', market: 'IT', listingId: 'l' })
    expect(m.send).not.toHaveBeenCalled()
    expect(m.outbound).not.toHaveBeenCalled()
    expect(m.outcome).toHaveBeenCalledWith('ebay-a', 'EBAY_IT', true)
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ channel: 'EBAY', marketplace: 'EBAY_IT', sku: SKU, mode: 'live', outcome: 'success' }))
    expect(completedSyncQueueData(result).syncStatus).toBe('SUCCESS')
  })

  it('the family is read by ItemID on the listing\'s own account', async () => {
    await service.syncToEbay(stockPush())
    expect(m.family).toHaveBeenCalledWith(expect.objectContaining({
      where: { channel: 'EBAY', externalListingId: ITEM, channelConnectionId: 'ebay-a' },
    }))
  })

  it('a main listing and its two aliases (three ItemIDs, the same SKU) are each revised on their own item', async () => {
    const items: Record<string, string> = { main: '110000000011', alias1: '110000000012', alias2: '110000000013' }
    m.read.mockImplementation(async ({ where }: any) => listing({ id: where.id, aliasKey: where.id === 'main' ? '' : where.id, externalListingId: items[where.id] }))
    for (const id of Object.keys(items)) {
      expect(await service.syncToEbay(stockPush(2, { id: `q-${id}`, channelListingId: id }))).toMatchObject({ success: true, status: 'SUCCESS' })
    }
    expect(trading).toHaveBeenCalledTimes(3)
    const sent = trading.mock.calls.map(([, xml, ctx]: any) => ({ item: /<ItemID>(\d+)<\/ItemID>/.exec(xml)?.[1], sku: /<SKU>([^<]+)<\/SKU>/.exec(xml)?.[1], listingId: ctx.listingId }))
    expect(sent).toEqual([
      { item: '110000000011', sku: SKU, listingId: 'main' },
      { item: '110000000012', sku: SKU, listingId: 'alias1' },
      { item: '110000000013', sku: SKU, listingId: 'alias2' },
    ])
    expect(m.send).not.toHaveBeenCalled()
  })

  it('the SKU eBay holds for the listing is the one named (its own confirmed SKU)', async () => {
    m.read.mockResolvedValue(listing({ liveChannelSku: 'OWN-IT', channelSku: 'OWN-IT' }))
    await service.syncToEbay(stockPush())
    expect(xmlSent()).toContain('<SKU>OWN-IT</SKU>')
  })

  it('a Warning from eBay is a send', async () => {
    trading.mockResolvedValue(ok('Warning', { errors: ['A harmless note'] }))
    const result = await service.syncToEbay(stockPush())
    expect(result).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(result.message).toContain('A harmless note')
  })
})

describe('the Inventory path is unchanged where eBay holds an Inventory offer, or there is no item yet', () => {
  it('a family sibling with an offer id → the Inventory calls, no Trading call', async () => {
    m.family.mockResolvedValue([{ platformAttributes: {} }, { platformAttributes: { __offerIds: { EBAY_IT: 'OFF-1' } } }])
    expect(await service.syncToEbay(stockPush())).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(trading).not.toHaveBeenCalled()
    expect(inventoryCalls().some((url: string) => url.includes('bulk_update_price_quantity'))).toBe(true)
  })

  it('the listing\'s own offer id → Inventory, without reading the family', async () => {
    m.read.mockResolvedValue(listing({ platformAttributes: { offerId: 'OFF-1' } }))
    await service.syncToEbay(stockPush())
    expect(m.family).not.toHaveBeenCalled()
    expect(trading).not.toHaveBeenCalled()
    expect(inventoryCalls().length).toBeGreaterThan(0)
  })

  it('a still-draft listing (no ItemID) and a row with no listing keep the Inventory path', async () => {
    m.read.mockResolvedValue(listing({ listingStatus: 'DRAFT', isPublished: false, externalListingId: null }))
    await service.syncToEbay(stockPush())
    m.read.mockResolvedValue(null)
    await service.syncToEbay({ ...stockPush(), channelListingId: null })
    expect(trading).not.toHaveBeenCalled()
    // No family read by ItemID (the row with no listing reads its push-lock listings by product, as before).
    expect(m.family.mock.calls.filter(([args]: any) => args?.where?.externalListingId !== undefined)).toEqual([])
    expect(inventoryCalls().length).toBeGreaterThan(0)
  })
})

describe('every guard of the eBay lane still answers first', () => {
  it('the routed pool ceiling: a lent pool of 1 sends Quantity 1, whatever the row or the listing asked', async () => {
    m.ledger.mockImplementation(ledgerWith(1, { kind: 'pool', grantId: 'g-1', ownerWorkspaceId: 'w-lender', locations: [] }))
    m.read.mockResolvedValue(listing({ quantity: 10 }))
    expect(await service.syncToEbay(stockPush(10))).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(xmlSent()).toContain('<Quantity>1</Quantity>')
  })

  it('an empty pool sends Quantity 0', async () => {
    m.ledger.mockImplementation(ledgerWith(0, { kind: 'pool', grantId: 'g-1', ownerWorkspaceId: 'w-lender', locations: [] }))
    await service.syncToEbay(stockPush(10))
    expect(xmlSent()).toContain('<Quantity>0</Quantity>')
  })

  it('a paused listing (push lock) is skipped before any call', async () => {
    m.read.mockResolvedValue(listing({ offerClosedAt: new Date('2026-10-01T00:00:00Z') }))
    expect(await service.syncToEbay(stockPush())).toMatchObject({ success: false, status: 'SKIPPED', errorCode: 'PUSH_OFFER_CLOSED' })
    expect(trading).not.toHaveBeenCalled()
  })

  it('paused channel-market pushes (Sync Control policy) are skipped before any call', async () => {
    m.policy.mockReturnValue({ pushesPaused: true } as never)
    expect(await service.syncToEbay(stockPush())).toMatchObject({ success: false, status: 'SKIPPED' })
    expect(trading).not.toHaveBeenCalled()
  })

  it('gated mode sends nothing', async () => {
    m.mode.mockReturnValue('gated')
    expect(await service.syncToEbay(stockPush())).toMatchObject({ success: false, status: 'FAILED' })
    expect(trading).not.toHaveBeenCalled()
  })
})

describe('what is not sent from this lane', () => {
  it('an active shared listing membership holds the SKU on this item → SKIPPED, no call (the shared fan-out revises it)', async () => {
    m.member.mockResolvedValue({ id: 'mem-1' })
    const result = await service.syncToEbay(stockPush())
    expect(result).toMatchObject({ success: true, status: 'SKIPPED', errorCode: 'EBAY_SHARED_LISTING_OWNS_SKU', retryable: false })
    expect(m.member).toHaveBeenCalledWith(expect.objectContaining({ where: { marketplace: { in: ['IT'] }, itemId: ITEM, sku: SKU, status: 'ACTIVE' } }))
    expect(trading).not.toHaveBeenCalled()
    expect(m.send).not.toHaveBeenCalled()
    expect(completedSyncQueueData(result).syncStatus).toBe('SKIPPED')
  })

  it('content (title, description, photos, aspects) goes through Publish → SKIPPED, nothing sent', async () => {
    for (const payload of [{ title: 'A title' }, { description: 'Copy' }, { images: ['https://img.test/1.jpg'] }, { mappingAspects: { Colour: ['Red'] } }, { title: 'A title', quantity: 3 }]) {
      const result = await service.syncToEbay(row('FULL_SYNC', { ...payload, marketplaceId: 'EBAY_IT' }))
      expect(result).toMatchObject({ success: true, status: 'SKIPPED', errorCode: 'EBAY_TRADING_CONTENT_VIA_PUBLISH', retryable: false,
        message: 'Content for an eBay Trading listing goes through Publish; nothing was sent.' })
      expect(completedSyncQueueData(result).syncStatus).toBe('SKIPPED')
    }
    expect(trading).not.toHaveBeenCalled()
    expect(m.send).not.toHaveBeenCalled()
  })
})

describe('dry runs are never a green send', () => {
  it.each(['dry-run', 'sandbox'])('%s mode: no call, a dry-run result', async (mode) => {
    m.mode.mockReturnValue(mode)
    const result = await service.syncToEbay(stockPush())
    expect(result).toMatchObject({ success: true, dryRun: true })
    expect(completedSyncQueueData(result).syncStatus).toBe('SKIPPED')
    expect(trading).not.toHaveBeenCalled()
    expect(m.send).not.toHaveBeenCalled()
  })

  it('a DRYRUN- answer (the real eBay API is not enabled here) is a dry run', async () => {
    trading.mockResolvedValue({ ack: 'Success', itemId: 'DRYRUN-ReviseInventoryStatus', errors: [], raw: '' })
    const result = await service.syncToEbay(stockPush())
    expect(result).toMatchObject({ success: true, dryRun: true })
    expect(completedSyncQueueData(result).syncStatus).toBe('SKIPPED')
  })
})

describe('eBay\'s answer decides the outcome', () => {
  it('Failure → terminal EBAY_VALIDATION in eBay\'s words; the marketplace circuit is not tripped', async () => {
    trading.mockRejectedValue(new TradingApiFailure('eBay ReviseInventoryStatus Failure: The SKU is not in this listing. (code 21916585)', false))
    const result = await service.syncToEbay(stockPush())
    expect(result).toMatchObject({ success: false, status: 'FAILED', errorCode: 'EBAY_VALIDATION', retryable: false })
    expect(result.error).toContain('The SKU is not in this listing')
    expect(m.outcome).not.toHaveBeenCalledWith('ebay-a', 'EBAY_IT', false)
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }))
  })

  it('PartialFailure → terminal EBAY_VALIDATION, no circuit outcome', async () => {
    trading.mockResolvedValue(ok('PartialFailure', { errors: ['Variation not found'], raw: '<Ack>PartialFailure</Ack><Errors><ErrorCode>21916585</ErrorCode></Errors>' }))
    const result = await service.syncToEbay(stockPush())
    expect(result).toMatchObject({ success: false, errorCode: 'EBAY_VALIDATION', retryable: false })
    expect(result.error).toContain('Variation not found')
    expect(m.outcome).not.toHaveBeenCalled()
  })

  it('an ended item → terminal EBAY_LISTING_ENDED, no circuit outcome', async () => {
    trading.mockRejectedValue(new TradingApiFailure('eBay ReviseInventoryStatus Failure: You cannot revise an ended listing. (code 21916750)', false))
    const result = await service.syncToEbay(stockPush())
    expect(result).toMatchObject({ success: false, status: 'FAILED', errorCode: 'EBAY_LISTING_ENDED', retryable: false })
    expect(m.outcome).not.toHaveBeenCalled()
  })

  it('no answer (network / HTTP error) → EBAY_TRANSIENT, retried, and it counts toward the circuit', async () => {
    trading.mockRejectedValue(new Error('eBay ReviseInventoryStatus HTTP 503'))
    const result = await service.syncToEbay(stockPush())
    expect(result).toMatchObject({ success: false, status: 'FAILED', errorCode: 'EBAY_TRANSIENT', retryable: true })
    expect(m.outcome).toHaveBeenCalledWith('ebay-a', 'EBAY_IT', false)
  })

  it('the gateway held it (account needs sign-in) → nothing sent, deferred as an auth hold, no circuit outcome', async () => {
    trading.mockRejectedValue(Object.assign(new Error('Held, nothing sent: the eBay account needs to be reconnected (needs_reauth).'),
      { name: 'GatewayRefusal', code: 'ACCOUNT_NEEDS_SIGNIN', outcome: 'held', statusCode: 409 }))
    const result = await service.syncToEbay(stockPush())
    expect(result).toMatchObject({ success: false, errorCode: 'ACCOUNT_NEEDS_SIGNIN' })
    expect(m.outcome).not.toHaveBeenCalled()
  })
})

describe('price: StartPrice in the market\'s currency, after the price bounds', () => {
  it('a price row sends StartPrice (two decimals, EUR for Italy) and no quantity', async () => {
    expect(await service.syncToEbay(pricePush(19.9))).toMatchObject({ success: true, status: 'SUCCESS' })
    const xml = xmlSent()
    expect(xml).toContain('<StartPrice currencyID="EUR">19.90</StartPrice>')
    expect(xml).not.toContain('<Quantity>')
    expect(m.send).not.toHaveBeenCalled()
  })

  it('a UK listing is priced in GBP on the UK site', async () => {
    m.read.mockResolvedValue(listing({ marketplace: 'GB' }))
    expect(await service.syncToEbay(row('PRICE_UPDATE', { price: 12.5, marketplaceId: 'EBAY_GB' }, { targetRegion: 'GB' }))).toMatchObject({ success: true })
    expect(xmlSent()).toContain('<StartPrice currencyID="GBP">12.50</StartPrice>')
    expect(trading.mock.calls[0][2]).toMatchObject({ siteId: '3' })
  })

  it('a row with a quantity and a price sends both in one InventoryStatus', async () => {
    await service.syncToEbay(row('FULL_SYNC', { quantity: 3, price: 25, marketplaceId: 'EBAY_IT' }))
    expect(trading).toHaveBeenCalledTimes(1)
    expect(xmlSent()).toContain('<Quantity>3</Quantity>\n    <StartPrice currencyID="EUR">25.00</StartPrice>')
  })

  it('a price outside the product\'s bounds is refused first: nothing sent', async () => {
    m.priceRefusal.mockResolvedValue('The price 1.00 is below the floor of 10.00.')
    expect(await service.syncToEbay(pricePush(1))).toMatchObject({ success: false, errorCode: 'PRICE_OUT_OF_BOUNDS', retryable: false })
    expect(trading).not.toHaveBeenCalled()
  })

  it('a market with no configured currency: the price is refused, nothing sent', async () => {
    m.currency.mockResolvedValueOnce({ currency: null } as never)
    expect(await service.syncToEbay(pricePush())).toMatchObject({ success: false, status: 'FAILED', retryable: false })
    expect(trading).not.toHaveBeenCalled()
  })
})
