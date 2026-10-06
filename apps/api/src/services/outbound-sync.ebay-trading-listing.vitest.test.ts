/**
 * 2026-10-06 (Trading stock sync) — a listing whose eBay item is a Trading item (created with AddFixedPriceItem, no
 * Inventory offer) gets its quantity and price rows through ReviseInventoryStatus, with its own ItemID and SKU.
 *
 * Before: every QUANTITY_UPDATE / PRICE_UPDATE of such a listing went to the Inventory API (`bulk_update_price_quantity`,
 * offers) and died with 25604 "SKU not found" — a 400, so terminal — and eBay kept the old numbers. The model is decided
 * once (`usesEbayInventory` over the item's family); the Trading branch runs after every Inventory-path guard (push lock,
 * pause policy, the routed pool ceiling, price bounds, publish mode, account, circuit, rate token).
 *
 * Live mode, every outside call faked: the Trading call (`callTradingApi`, the gateway-backed client) and
 * the Inventory calls (`ebaySend`) record what would go out. Nothing reaches eBay. Ids and SKUs are fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => {
  const outbound = vi.fn(() => { throw new Error('Unexpected outbound fetch') }); vi.stubGlobal('fetch', outbound)
  return {
    outbound, trading: vi.fn(), read: vi.fn(), family: vi.fn(), members: vi.fn(), stamp: vi.fn(), listingWrite: vi.fn(), issues: vi.fn(), send: vi.fn(), audit: vi.fn(),
    ledger: vi.fn(), writeAccount: vi.fn(), wrongAccount: vi.fn(() => false), circuit: vi.fn(() => ({ ok: true }) as { ok: boolean; error?: string }),
    token: vi.fn(async () => ({ ok: true }) as { ok: boolean; error?: string }),
    outcome: vi.fn(), mode: vi.fn(() => 'live'), policy: vi.fn(() => null), priceRefusal: vi.fn(async () => null as string | null),
    currency: vi.fn(async ({ where }: any) => ({ currency: where?.code === 'UK' ? 'GBP' : 'EUR' })),
  }
})
vi.mock('../db.js', () => ({
  default: {
    channelListing: { findUnique: m.read, findMany: m.family, updateMany: m.listingWrite },
    sharedListingMembership: { findMany: m.members, updateMany: m.stamp },
    listingIssue: { updateMany: m.issues },
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
vi.mock('./write-account-guard.js', () => ({ assertWriteAccount: m.writeAccount, isWrongAccountWriteError: m.wrongAccount }))
vi.mock('./connection-resolver.service.js', async (original) => ({ ...(await original<object>()),
  tryResolveConnection: vi.fn(async ({ accountId }: { accountId?: string }) => (accountId ? { id: accountId, channelType: 'EBAY' } : null)) }))
vi.mock('./ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: vi.fn(async (id: string) => `token-${id}`) } }))
vi.mock('./gateway/channels.js', async (original) => ({ ...(await original<object>()), ebayListingLanguage: vi.fn(async () => 'it-IT') }))
vi.mock('./ebay-publish-gate.service.js', async (original) => ({ ...(await original<object>()),
  getEbayPublishMode: m.mode, checkEbayCircuit: m.circuit, acquireEbayPublishToken: m.token, recordEbayOutcome: m.outcome,
  getEbayApiBaseForMode: () => 'https://api.ebay.test' }))
vi.mock('./gateway/ebay.js', async (original) => ({ ...(await original<object>()), ebaySend: m.send }))
vi.mock('./ebay-trading-api.service.js', async (original) => ({ ...(await original<object>()), callTradingApi: m.trading }))

const { OutboundSyncService, completedSyncQueueData, computeFailureDisposition, listingOutcomeOfCompletion, tradingRowRefusalKind } = await import('./outbound-sync.service.js')
const { TradingApiFailure } = await import('./ebay-trading-api.service.js')
const { syncLedgerOf } = await import('./sync-control-core.js')
const service: any = new OutboundSyncService()
const trading = m.trading

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
  m.members.mockResolvedValue([])
  m.stamp.mockResolvedValue({ count: 1 })
  m.listingWrite.mockResolvedValue({ count: 1 })
  m.issues.mockResolvedValue({ count: 0 })
  m.wrongAccount.mockReturnValue(false)
  m.circuit.mockReturnValue({ ok: true })
  m.token.mockResolvedValue({ ok: true })
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
    // N5 — a sibling with no account recorded is the same item too.
    expect(m.family).toHaveBeenCalledWith(expect.objectContaining({
      where: { channel: 'EBAY', externalListingId: ITEM, OR: [{ channelConnectionId: 'ebay-a' }, { channelConnectionId: null }] },
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

/** An ACTIVE shared listing membership of SKU on ITEM (what the shared fan-out reads). */
const membership = (over: Record<string, unknown> = {}) => ({
  id: 'mem-1', marketplace: 'IT', productId: 'p', followPool: true, pinnedQuantity: null, stockBuffer: 0, channelConnectionId: 'ebay-a', ...over,
})

describe('a shared listing: the quantity is the shared fan-out\'s only when the fan-out really sends it (review B1, S1, S3)', () => {
  it('a membership the fan-out sends (this product, follows the pool) → the quantity row is SKIPPED, no call', async () => {
    m.members.mockResolvedValue([membership()])
    const result = await service.syncToEbay(stockPush())
    expect(result).toMatchObject({ success: true, status: 'SKIPPED', errorCode: 'EBAY_SHARED_LISTING_OWNS_SKU', retryable: false })
    expect(m.members).toHaveBeenCalledWith(expect.objectContaining({ where: { marketplace: { in: ['IT'] }, itemId: ITEM, sku: SKU, status: 'ACTIVE' } }))
    expect(trading).not.toHaveBeenCalled()
    expect(m.send).not.toHaveBeenCalled()
    expect(completedSyncQueueData(result).syncStatus).toBe('SKIPPED')
  })

  it('a fixed number on the membership (PINNED) is the fan-out\'s too', async () => {
    m.members.mockResolvedValue([membership({ pinnedQuantity: 3 })])
    expect(await service.syncToEbay(stockPush())).toMatchObject({ status: 'SKIPPED', errorCode: 'EBAY_SHARED_LISTING_OWNS_SKU' })
    expect(trading).not.toHaveBeenCalled()
  })

  it.each([
    ['no product (an ambiguous colour at reconcile)', { productId: null }],
    ['another product', { productId: 'p-other' }],
  ])('a membership with %s is never sent by this product\'s fan-out → this row sends the quantity and stamps it', async (_label, over) => {
    m.members.mockResolvedValue([membership(over)])
    expect(await service.syncToEbay(stockPush(4))).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(xmlSent()).toContain('<Quantity>4</Quantity>')
    expect(m.stamp).toHaveBeenCalledWith({ where: { id: { in: ['mem-1'] } }, data: { lastQtyPushed: 4, lastPushedAt: expect.any(Date), lastError: null } })
  })

  it('a follow membership with no counted stock for its market (UNCOUNTED) is not sent by the fan-out → this row sends', async () => {
    // The row's own routed ceiling reads the ledger first (routed to eBay IT); the membership's read finds no IT route.
    m.ledger.mockImplementationOnce(ledgerWith(50))
    m.ledger.mockImplementationOnce(async (_db: unknown, ids: string[]) => new Map(ids.map((id) => [id, {
      productId: id, source: { kind: 'own' }, ledger: syncLedgerOf([{ locationCode: 'WH-DE', available: 50, syncRoutes: ['EBAY:DE'] }]),
      quantity: 50, available: 50, uncountedIsZero: false, fbaBucket: 0,
    }])))
    m.members.mockResolvedValue([membership()])
    expect(await service.syncToEbay(stockPush(4))).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(trading).toHaveBeenCalledTimes(1)
  })

  it('a variant Excluded from the shared stock (followPool off) gets no quantity from either lane', async () => {
    m.members.mockResolvedValue([membership({ followPool: false })])
    const result = await service.syncToEbay(stockPush())
    expect(result).toMatchObject({ success: true, status: 'SKIPPED', errorCode: 'EBAY_SHARED_VARIANT_EXCLUDED' })
    expect(trading).not.toHaveBeenCalled()
  })

  it('the price is always sent: a quantity + price row sends the price alone and says the quantity is the shared stock\'s', async () => {
    m.members.mockResolvedValue([membership()])
    const result = await service.syncToEbay(row('FULL_SYNC', { quantity: 3, price: 25, marketplaceId: 'EBAY_IT' }))
    expect(result).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(xmlSent()).toContain('<StartPrice currencyID="EUR">25.00</StartPrice>')
    expect(xmlSent()).not.toContain('<Quantity>')
    expect(result.message).toContain('its shared stock sends the quantity')
    expect(m.stamp).not.toHaveBeenCalled()
  })

  it('a price-only row does not read the memberships at all', async () => {
    m.members.mockResolvedValue([membership()])
    expect(await service.syncToEbay(pricePush(19.9))).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(m.members).not.toHaveBeenCalled()
    expect(xmlSent()).toContain('<StartPrice currencyID="EUR">19.90</StartPrice>')
  })

  it('an explicit push (Matrix / MCP "Push now") is sent through Trading whatever the membership, and stamps it', async () => {
    m.members.mockResolvedValue([membership()])
    const result = await service.syncToEbay(row('QUANTITY_UPDATE', { quantity: 0, source: 'MATRIX_PUSH_NOW', marketplace: 'IT' }))
    expect(result).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(xmlSent()).toContain('<Quantity>0</Quantity>')
    expect(m.stamp).toHaveBeenCalledWith({ where: { id: { in: ['mem-1'] } }, data: { lastQtyPushed: 0, lastPushedAt: expect.any(Date), lastError: null } })
  })

  it('a stamp that cannot be written does not fail the send', async () => {
    m.members.mockResolvedValue([membership({ productId: null })])
    m.stamp.mockRejectedValue(new Error('database down'))
    expect(await service.syncToEbay(stockPush())).toMatchObject({ success: true, status: 'SUCCESS' })
  })

  it('(N6) the memberships cannot be read → retried, nothing sent, the circuit untouched', async () => {
    m.members.mockRejectedValue(new Error('connection reset'))
    const result = await service.syncToEbay(stockPush())
    expect(result).toMatchObject({ success: false, status: 'FAILED', errorCode: 'EBAY_TRANSIENT', retryable: true })
    expect(trading).not.toHaveBeenCalled()
    expect(m.outcome).not.toHaveBeenCalled()
  })

  it('the shared stock behind a membership cannot be read → retried, nothing sent', async () => {
    m.members.mockResolvedValue([membership()])
    m.ledger.mockImplementationOnce(ledgerWith(50))
    m.ledger.mockImplementationOnce(async () => { throw new Error('pool read failed') })
    expect(await service.syncToEbay(stockPush())).toMatchObject({ success: false, errorCode: 'EBAY_TRANSIENT', retryable: true })
    expect(trading).not.toHaveBeenCalled()
  })
})

describe('what else is not sent from this lane', () => {
  it('content alone (title, description, photos, aspects) goes through Publish → SKIPPED, nothing sent', async () => {
    for (const payload of [{ title: 'A title' }, { description: 'Copy' }, { images: ['https://img.test/1.jpg'] }, { mappingAspects: { Colour: ['Red'] } }]) {
      const result = await service.syncToEbay(row('FULL_SYNC', { ...payload, marketplaceId: 'EBAY_IT' }))
      expect(result).toMatchObject({ success: true, status: 'SKIPPED', errorCode: 'EBAY_TRADING_CONTENT_VIA_PUBLISH', retryable: false,
        message: 'Content for an eBay Trading listing goes through Publish; nothing was sent.' })
      expect(completedSyncQueueData(result).syncStatus).toBe('SKIPPED')
    }
    expect(trading).not.toHaveBeenCalled()
    expect(m.send).not.toHaveBeenCalled()
  })

  it('(S4) content beside a quantity: the quantity is sent, and the row says the content waits for Publish', async () => {
    const result = await service.syncToEbay(row('FULL_SYNC', { title: 'A title', quantity: 3, marketplaceId: 'EBAY_IT' }))
    expect(result).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(xmlSent()).toContain('<Quantity>3</Quantity>')
    expect(xmlSent()).not.toContain('A title')
    expect(result.message).toContain('goes through Publish and was not sent')
    expect(m.send).not.toHaveBeenCalled()
  })

  it('a family parent\'s row (no stock of its own on a variation item) → SKIPPED with the reason, nothing sent', async () => {
    const result = await service.syncToEbay(stockPush(4, { product: { id: 'p', sku: 'TEST-PARENT', isParent: true } }))
    expect(result).toMatchObject({ success: true, status: 'SKIPPED', errorCode: 'EBAY_TRADING_PARENT_NO_STOCK', retryable: false })
    expect(result.message).toMatch(/parent of a variation family/)
    expect(trading).not.toHaveBeenCalled()
    expect(m.send).not.toHaveBeenCalled()
  })
})

describe('(S5) a skip that ends the listing\'s wait is recorded on the listing', () => {
  it.each(['EBAY_SHARED_LISTING_OWNS_SKU', 'EBAY_SHARED_VARIANT_EXCLUDED', 'EBAY_TRADING_CONTENT_VIA_PUBLISH', 'EBAY_TRADING_PARENT_NO_STOCK'])('%s → "skipped" with the reason', (code) => {
    expect(listingOutcomeOfCompletion(completedSyncQueueData({ status: 'SKIPPED', message: 'Why.', errorCode: code })))
      .toEqual({ outcome: 'skipped', error: `${code}: Why.` })
  })
  it('a real send is "sent"; any other skip and a dry run tell the listing nothing, as before', () => {
    expect(listingOutcomeOfCompletion(completedSyncQueueData({ status: 'SUCCESS', message: 'ok' }))).toEqual({ outcome: 'sent' })
    expect(listingOutcomeOfCompletion(completedSyncQueueData({ status: 'SKIPPED', message: 'x', errorCode: 'OUTBOUND_NOT_SENT' }))).toBeNull()
    expect(listingOutcomeOfCompletion(completedSyncQueueData({ status: 'SKIPPED', message: 'x' }))).toBeNull()
    expect(listingOutcomeOfCompletion(completedSyncQueueData({ status: 'SUCCESS', message: 'x', dryRun: true }))).toBeNull()
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

/** eBay's Trading refusal with its error block, as `callTradingApi` throws it. */
const tradingFailure = (code: string, words: string, classification = 'RequestError') =>
  new TradingApiFailure(`eBay ReviseInventoryStatus Failure: ${words} (code ${code})`, false, undefined, [{ code, message: words }],
    `<Ack>Failure</Ack><Errors><ShortMessage>${words}</ShortMessage><LongMessage>${words}</LongMessage><ErrorCode>${code}</ErrorCode><SeverityCode>Error</SeverityCode><ErrorClassification>${classification}</ErrorClassification></Errors>`)
/** eBay's offers of SKU on IT: one fixed-price offer published on `listingId`. */
const offersOn = (listingId: string, offerId = 'OFF-9') => response({ offers: [{
  offerId, sku: SKU, marketplaceId: 'EBAY_IT', format: 'FIXED_PRICE', listing: { listingId }, pricingSummary: { price: { value: '18.00', currency: 'EUR' } },
}] })

describe('(premise) an unmarked item that eBay holds in the Inventory API: Trading first, then the Inventory path in the same row', () => {
  beforeEach(() => {
    m.send.mockImplementation(async (_account: string, url: string) => {
      if (url.includes('bulk_update_price_quantity')) return response({ responses: [{ statusCode: 200 }] })
      if (url.includes('/offer?sku=')) return offersOn(ITEM)
      return response({}, 204)
    })
  })

  it('21919474 → the offer of THIS ItemID is looked up, merged into the listing (other keys kept), and the quantity goes out by bulk update', async () => {
    m.read.mockResolvedValue(listing({ version: 7, platformAttributes: { __lastPublishedAxes: { EBAY_IT: ['Size'] }, __offerIds: {} } }))
    trading.mockRejectedValue(tradingFailure('21919474', 'This operation is not allowed for inventory items.'))
    const result = await service.syncToEbay(stockPush(4))
    expect(result, JSON.stringify(result)).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(trading).toHaveBeenCalledTimes(1)
    const urls = inventoryCalls()
    expect(urls[0]).toBe(`https://api.ebay.test/sell/inventory/v1/offer?sku=${SKU}&marketplace_id=EBAY_IT`)
    expect(urls.some((url: string) => url.includes('bulk_update_price_quantity'))).toBe(true)
    const bulk = m.send.mock.calls.find(([, url]: [string, string]) => url.includes('bulk_update_price_quantity'))
    expect(JSON.parse(bulk[2].body)).toEqual({ requests: [{ sku: SKU, shipToLocationAvailability: { quantity: 4 }, offers: [{ offerId: 'OFF-9', availableQuantity: 4 }] }] })
    expect(m.listingWrite).toHaveBeenCalledWith({
      where: { id: 'l', version: 7 },
      data: { version: { increment: 1 }, platformAttributes: { __lastPublishedAxes: { EBAY_IT: ['Size'] }, __offerIds: { EBAY_IT: 'OFF-9' } } },
    })
    // eBay's "this is an Inventory item" is Nexus's routing, not the listing's problem: closed, no circuit failure, no failed attempt.
    expect(m.issues).toHaveBeenCalledWith({ where: { listingId: 'l', source: 'ebay-write', code: '21919474', resolvedAt: null }, data: { resolvedAt: expect.any(Date) } })
    expect(m.outcome).not.toHaveBeenCalledWith('ebay-a', 'EBAY_IT', false)
    expect(m.audit).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }))
  })

  it('eBay\'s Italian words without a code are recognised', async () => {
    trading.mockRejectedValue(new TradingApiFailure('eBay ReviseInventoryStatus Failure: operazione non consentita per gli oggetti del magazzino', false))
    expect(await service.syncToEbay(stockPush())).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(m.listingWrite).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ platformAttributes: { __offerIds: { EBAY_IT: 'OFF-9' } } }) }))
    expect(inventoryCalls().some((url: string) => url.includes('bulk_update_price_quantity'))).toBe(true)
  })

  it('a PartialFailure answer carrying 21919474 falls back the same way', async () => {
    trading.mockResolvedValue(ok('PartialFailure', { errors: ['This operation is not allowed for inventory items.'],
      raw: '<Ack>PartialFailure</Ack><Errors><ErrorCode>21919474</ErrorCode><SeverityCode>Error</SeverityCode></Errors>' }))
    expect(await service.syncToEbay(stockPush())).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(m.listingWrite).toHaveBeenCalledTimes(1)
  })

  it('no offer of this ItemID (the SKU\'s offer is another item\'s): nothing stored, the Inventory path still runs', async () => {
    m.send.mockImplementation(async (_account: string, url: string) => {
      if (url.includes('bulk_update_price_quantity')) return response({ responses: [{ statusCode: 200 }] })
      if (url.includes('/offer?sku=')) return offersOn('110000000099')
      return response({}, 204)
    })
    trading.mockRejectedValue(tradingFailure('21919474', 'This operation is not allowed for inventory items.'))
    expect(await service.syncToEbay(stockPush())).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(m.listingWrite).not.toHaveBeenCalled()
    expect(inventoryCalls().some((url: string) => url.includes('bulk_update_price_quantity'))).toBe(true)
  })

  it('a marker that cannot be written does not fail the row', async () => {
    m.listingWrite.mockRejectedValue(new Error('database down'))
    trading.mockRejectedValue(tradingFailure('21919474', 'This operation is not allowed for inventory items.'))
    expect(await service.syncToEbay(stockPush())).toMatchObject({ success: true, status: 'SUCCESS' })
  })

  it('a price row falls back to the offer price write', async () => {
    trading.mockRejectedValue(tradingFailure('21919474', 'This operation is not allowed for inventory items.'))
    expect(await service.syncToEbay(pricePush(19.9))).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(m.send.mock.calls.some(([, url, init]: [string, string, any]) => url.endsWith('/offer/OFF-9') && init?.method === 'PUT')).toBe(true)
  })

  it('a marked item never calls Trading', async () => {
    m.read.mockResolvedValue(listing({ platformAttributes: { __offerIds: { EBAY_IT: 'OFF-9' } } }))
    expect(await service.syncToEbay(stockPush())).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(trading).not.toHaveBeenCalled()
  })

  it('(N6) the family cannot be read → the Inventory path, as before this lane', async () => {
    m.family.mockRejectedValue(new Error('connection reset'))
    expect(await service.syncToEbay(stockPush())).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(trading).not.toHaveBeenCalled()
    expect(inventoryCalls().some((url: string) => url.includes('bulk_update_price_quantity'))).toBe(true)
  })
})

describe('(S2) eBay\'s error codes and classification decide retry, sign-in wait or refusal', () => {
  it.each([['931', 'Auth token is invalid.'], ['932', 'Auth token is hard expired.'], ['16110', 'Token revoked.'], ['17470', 'Please login again now.']])(
    'a token error (%s) waits for the account to sign in again: retried without spending the budget, no circuit outcome', async (code, words) => {
      trading.mockRejectedValue(tradingFailure(code, words))
      const result = await service.syncToEbay(stockPush())
      expect(result).toMatchObject({ success: false, status: 'FAILED', errorCode: 'AUTH_REQUIRED', retryable: true })
      expect(m.outcome).not.toHaveBeenCalled()
      expect(computeFailureDisposition({ retryCount: 2, maxRetries: 3 }, result.error, result)).toMatchObject({ kind: 'deferral', errorCode: 'AUTH_REQUIRED' })
    })

  it.each([['10007', 'Internal error to the application.', 'SystemError'], ['518', 'Call usage limit has been reached.', 'RequestError'], ['99999', 'Something on eBay\'s side.', 'SystemError']])(
    '%s (system error / call limit / SystemError) is transient: retried, and it counts toward the circuit', async (code, words, classification) => {
      trading.mockRejectedValue(tradingFailure(code, words, classification))
      const result = await service.syncToEbay(stockPush())
      expect(result).toMatchObject({ success: false, status: 'FAILED', errorCode: 'EBAY_TRANSIENT', retryable: true })
      expect(m.outcome).toHaveBeenCalledWith('ebay-a', 'EBAY_IT', false)
    })

  it('a token error read from the sentence alone (no error block kept) still waits for sign-in', async () => {
    trading.mockRejectedValue(new TradingApiFailure('eBay ReviseInventoryStatus Failure: Auth token is hard expired. (code 932)', false))
    expect(await service.syncToEbay(stockPush())).toMatchObject({ errorCode: 'AUTH_REQUIRED', retryable: true })
  })

  it('a RequestError eBay does not list stays a terminal refusal', async () => {
    trading.mockRejectedValue(tradingFailure('21916585', 'The SKU is not in this listing.'))
    expect(await service.syncToEbay(stockPush())).toMatchObject({ errorCode: 'EBAY_VALIDATION', retryable: false })
    expect(m.outcome).not.toHaveBeenCalled()
  })

  it('a PartialFailure with a system error block is transient', async () => {
    trading.mockResolvedValue(ok('PartialFailure', { errors: ['Internal error'],
      raw: '<Ack>PartialFailure</Ack><Errors><ErrorCode>10007</ErrorCode><SeverityCode>Error</SeverityCode><ErrorClassification>SystemError</ErrorClassification></Errors>' }))
    expect(await service.syncToEbay(stockPush())).toMatchObject({ errorCode: 'EBAY_TRANSIENT', retryable: true })
  })

  it('tradingRowRefusalKind reads only the error blocks: a warning\'s code does not decide', () => {
    const raw = '<Errors><ErrorCode>10007</ErrorCode><SeverityCode>Warning</SeverityCode></Errors><Errors><ErrorCode>21916585</ErrorCode><SeverityCode>Error</SeverityCode><ErrorClassification>RequestError</ErrorClassification></Errors>'
    expect(tradingRowRefusalKind(raw, [])).toBe('refused')
    expect(tradingRowRefusalKind(undefined, ['518'])).toBe('transient')
    expect(tradingRowRefusalKind('', [])).toBe('refused')
  })
})

describe('(N1) step 4b runs after the account, circuit and rate guards: none of them lets a Trading call out', () => {
  it('the marketplace circuit is open → no call', async () => {
    m.circuit.mockReturnValue({ ok: false, error: 'Circuit open for EBAY_IT' })
    expect(await service.syncToEbay(stockPush())).toMatchObject({ success: false, status: 'FAILED' })
    expect(trading).not.toHaveBeenCalled()
  })

  it('no rate token → no call', async () => {
    m.token.mockResolvedValue({ ok: false, error: 'Rate limited' })
    expect(await service.syncToEbay(stockPush())).toMatchObject({ success: false, status: 'FAILED' })
    expect(trading).not.toHaveBeenCalled()
  })

  it('the listing is not the row\'s account\'s (assertWriteAccount) → no call', async () => {
    m.writeAccount.mockRejectedValue(Object.assign(new Error('This listing belongs to another eBay account.'), { code: 'WRONG_ACCOUNT_WRITE' }))
    m.wrongAccount.mockReturnValue(true)
    expect(await service.syncToEbay(stockPush())).toMatchObject({ success: false, errorCode: 'WRONG_ACCOUNT_WRITE', retryable: false })
    expect(trading).not.toHaveBeenCalled()
  })
})
