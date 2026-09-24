import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => {
  const outbound = vi.fn(() => { throw new Error('Unexpected outbound fetch') })
  vi.stubGlobal('fetch', outbound)
  return {
    outbound, removeAmazon: vi.fn(), removeShopify: vi.fn(), updateShopify: vi.fn(),
    seller: vi.fn(), end: vi.fn(), token: vi.fn(), resolve: vi.fn(),
    update: vi.fn(), read: vi.fn(), event: vi.fn(),
    // PLAN Step 1.3 — the channel reads and writes an unpublish makes
    getListing: vi.fn(), patchOffer: vi.fn(), trading: vi.fn(),
  }
})
vi.mock('../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: m.seller }))
vi.mock('../clients/amazon-sp-api.client.js', () => ({ amazonSpApiClient: { deleteListingsItem: m.removeAmazon, getListingsItem: m.getListing, patchPurchasableOffer: m.patchOffer } }))
vi.mock('./amazon/flat-file.service.js', () => ({ MARKETPLACE_ID_MAP: { IT: 'APJ6JRA9NG5V4' } }))
// The SCT.6 service (loaded by the Amazon unpublish) imports the app's db handle; it writes nothing on this path.
vi.mock('../db.js', () => ({ default: {} }))
vi.mock('@nexus/database', () => { const db = { outboundSyncQueue: { updateMany: m.update, findUnique: m.read }, productEvent: { create: m.event } }; return { prisma: { ...db, $transaction: async (run: any) => run(db) } } })
vi.mock('./ebay-trading-api.service.js', async (original) => ({
  ...await original<typeof import('./ebay-trading-api.service.js')>(), endFixedPriceItem: m.end, callTradingApi: m.trading,
}))
vi.mock('./ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: m.token } }))
vi.mock('./connection-resolver.service.js', () => ({ tryResolveConnection: m.resolve }))

const { dispatchChannelDelist } = await import('./channel-delist.service.js')
const job = (targetChannel: string, syncType: 'UNPUBLISH_LISTING' | 'DELETE_LISTING' = 'UNPUBLISH_LISTING') => ({
  queueId: 'q-pr2', productId: 'p-pr2', channelListingId: 'l-pr2',
  targetChannel, targetRegion: 'IT', externalListingId: 'FAKE-ASIN-NOT-SELLER-SKU', syncType,
  payload: { channelConnectionId: 'account-owner', aliasKey: '', sellerSku: 'PR2-SELLER-SKU' },
})
beforeEach(() => {
  vi.clearAllMocks()
  m.update.mockResolvedValue({ count: 1 })
  vi.stubEnv('AMAZON_PUBLISH_MODE', 'dry-run')
  m.seller.mockResolvedValue('seller-owner')
  m.resolve.mockResolvedValue({ id: 'account-owner', channelType: 'EBAY' })
  m.token.mockResolvedValue('fake-token')
  m.removeAmazon.mockResolvedValue({ success: true, dryRun: true })
  m.end.mockResolvedValue({ ack: 'Success' })
  m.getListing.mockResolvedValue(amazonRead())
  m.patchOffer.mockResolvedValue({ success: true, sku: 'PR2-SELLER-SKU', status: 'ACCEPTED', submissionId: 'sub-close' })
  m.trading.mockImplementation(ebayTrading())
})
afterEach(() => {
  expect(m.outbound).not.toHaveBeenCalled()
  vi.unstubAllEnvs()
})
// ── PLAN Step 1.3 fixtures: what Amazon and eBay answer ──────────────────────────────────────────
// The offer shape read live on 2026-09-23 (A-38 results, xracingbxn48 Amazon·IT).
const LIVE_OFFER = { currency: 'EUR', audience: 'ALL', our_price: [{ schedule: [{ value_with_tax: 399.95 }] }], marketplace_id: 'APJ6JRA9NG5V4' }
function amazonRead(over: { offers?: unknown[]; channels?: string[]; success?: boolean } = {}) {
  const channels = over.channels ?? ['DEFAULT']
  return {
    success: over.success ?? true, asin: 'B0TEST',
    rawResponse: { summaries: [{ productType: 'APPAREL' }], attributes: {
      purchasable_offer: over.offers ?? [LIVE_OFFER],
      fulfillment_availability: channels.map(code => ({ fulfillment_channel_code: code, quantity: 2 })),
    } },
  }
}
function getItemXml(o: { oos?: string | null; status?: string; variations?: Array<[string, number, number]>; quantity?: [number, number] } = {}) {
  const oos = o.oos === null ? '' : `<OutOfStockControl>${o.oos ?? 'true'}</OutOfStockControl>`
  const vars = o.variations ?? [['V-1', 5, 3], ['V-2', 2, 2], ['V-3', 4, 0], ['V-4', 1, 0], ['V-5', 7, 1], ['V-6', 3, 0]]
  const body = o.quantity
    ? `<Quantity>${o.quantity[0]}</Quantity><SellingStatus><QuantitySold>${o.quantity[1]}</QuantitySold><ListingStatus>${o.status ?? 'Active'}</ListingStatus></SellingStatus>`
    : `<SellingStatus><ListingStatus>${o.status ?? 'Active'}</ListingStatus></SellingStatus><Variations>${vars.map(([sku, q, sold]) => `<Variation><SKU>${sku}</SKU><Quantity>${q}</Quantity><SellingStatus><QuantitySold>${sold}</QuantitySold></SellingStatus></Variation>`).join('')}</Variations>`
  return `<GetItemResponse><Ack>Success</Ack><Item><ItemID>FAKE-ASIN-NOT-SELLER-SKU</ItemID>${body}${oos}</Item></GetItemResponse>`
}
function ebayTrading(o: Parameters<typeof getItemXml>[0] = {}, revise: (xml: string, n: number) => unknown = () => ({ ack: 'Success', errors: [], raw: '<Ack>Success</Ack>' })) {
  let n = 0
  return async (callName: string, xml: string) => {
    if (callName === 'GetItem') return { ack: 'Success', errors: [], raw: getItemXml(o) }
    if (callName === 'ReviseInventoryStatus') return revise(xml, n++)
    if (callName === 'GetUserPreferences') return { ack: 'Success', errors: [], raw: '<OutOfStockControlPreference>true</OutOfStockControlPreference>' }
    throw new Error(`unexpected Trading call ${callName}`)
  }
}
const reviseCalls = () => m.trading.mock.calls.filter(([name]) => name === 'ReviseInventoryStatus').map(([, xml]) => xml as string)
const skusOf = (xml: string) => [...xml.matchAll(/<SKU>([^<]+)<\/SKU>/g)].map(x => x[1])
const quantitiesOf = (xml: string) => [...xml.matchAll(/<Quantity>([^<]+)<\/Quantity>/g)].map(x => Number(x[1]))

describe('W1.1 no adapter escalates', () => {
  it('Amazon unpublish never calls deleteListingsItem — it closes the offer (Step 1.3 inverts the old refusal)', async () => {
    expect(await dispatchChannelDelist(job('AMAZON'))).toMatchObject({ success: true, outcome: 'SUCCESS' })
    expect(m.removeAmazon).not.toHaveBeenCalled()
    expect(m.patchOffer).toHaveBeenCalledOnce()
  })
  it.each(['UNPUBLISH_LISTING', 'DELETE_LISTING'] as const)('Shopify %s refuses with or without env credentials', async (syncType) => {
    for (const credential of ['', 'present-but-never-used']) {
      vi.stubEnv('SHOPIFY_SHOP_NAME', credential)
      vi.stubEnv('SHOPIFY_ACCESS_TOKEN', credential)
      expect(await dispatchChannelDelist(job('SHOPIFY', syncType))).toMatchObject({
        success: false, retryable: false, errorCode: 'SHOPIFY_DELIST_NOT_IMPLEMENTED',
      })
    }
    expect(m.removeShopify).not.toHaveBeenCalled()
    expect(m.updateShopify).not.toHaveBeenCalled()
  })
  it('eBay unpublish never ends the ItemID — it sets quantity 0 (Step 1.3 inverts the old refusal)', async () => {
    expect(await dispatchChannelDelist(job('EBAY'))).toMatchObject({ success: true, outcome: 'SUCCESS', channelFact: 'NOT_SELLING' })
    expect(m.end).not.toHaveBeenCalled()
    expect(reviseCalls().length).toBeGreaterThan(0)
  })
  it('positive control: explicit delete reaches the stubbed Amazon delete client', async () => {
    expect(await dispatchChannelDelist(job('AMAZON', 'DELETE_LISTING'))).toMatchObject({ success: true, dryRun: true })
    expect(m.removeAmazon).toHaveBeenCalledOnce()
  })
})

const { applyDelistResultToQueue, COULD_NOT_ASK, ENDED_CONFIRMED } = await import('./channel-delist.service.js')
const { DELIST_OPERATOR_COPY } = await import('./delist-error-codes.js')
describe('W1.2 honest outcomes', () => {
  it.each(['Unknown', 'PartialFailure', ''])('unconfirmed eBay acknowledgement %s cannot be green', async (ack) => {
    m.end.mockResolvedValue({ ack })
    expect(await dispatchChannelDelist(job('EBAY', 'DELETE_LISTING'))).toMatchObject({ success: false, outcome: 'UNKNOWN', errorCode: 'EBAY_DELIST_UNVERIFIED', retryable: true })
  })
  it.each(['Success', 'Warning'])('positive eBay acknowledgement %s records only the write outcome', async (ack) => {
    m.end.mockResolvedValue({ ack })
    const result = await dispatchChannelDelist(job('EBAY', 'DELETE_LISTING'))
    expect(result).toMatchObject({ success: true, outcome: 'SUCCESS' })
    expect(result.channelFact).not.toBe('NOT_SELLING')
  })
  const refused = ['item cannot be accessed', 'item not active', 'item is not available', 'listing not active', 'listing is not available', 'listing not found', 'item not found', 'invalid item', 'not currently available']
  const ended = ['already ended', 'already closed', 'auction already closed', 'item has already been deleted', 'item has already been removed']
  it.each(refused)('%s means UNKNOWN / REFUSED', async (message) => {
    m.end.mockRejectedValue(new Error(`eBay EndFixedPriceItem Failure: ${message}`))
    expect(await dispatchChannelDelist(job('EBAY', 'DELETE_LISTING'))).toMatchObject({ success: false, outcome: 'UNKNOWN', channelFact: 'REFUSED', retryable: false, errorCode: 'EBAY_DELIST_COULD_NOT_ASK' })
  })
  it.each(ended)('%s positively confirms ended', async (message) => {
    m.end.mockRejectedValue(new Error(`eBay EndFixedPriceItem Failure: ${message}`))
    expect(await dispatchChannelDelist(job('EBAY', 'DELETE_LISTING'))).toMatchObject({ success: true, outcome: 'SUCCESS', channelFact: 'NOT_SELLING' })
  })
  it('all ten original patterns belong to a tested successor set', () => {
    expect(COULD_NOT_ASK).toHaveLength(6); expect(ENDED_CONFIRMED).toHaveLength(4)
    for (const pattern of COULD_NOT_ASK) expect(refused.some(message => pattern.test(message))).toBe(true)
    for (const pattern of ENDED_CONFIRMED) expect(ended.some(message => pattern.test(message))).toBe(true)
    for (const message of [...refused, ...ended]) expect(Number(COULD_NOT_ASK.some(p => p.test(message))) + Number(ENDED_CONFIRMED.some(p => p.test(message)))).toBe(1)
  })
  it('access refusal takes priority over ended prose in the same response', async () => {
    m.end.mockRejectedValue(new Error('already ended; item cannot be accessed'))
    expect(await dispatchChannelDelist(job('EBAY', 'DELETE_LISTING'))).toMatchObject({ outcome: 'UNKNOWN', channelFact: 'REFUSED' })
  })
  it.each(['AMAZON', 'EBAY'])('%s transport failure is UNKNOWN with a retry hold', async (channel) => {
    m.removeAmazon.mockRejectedValue(new TypeError('fetch failed')); m.end.mockRejectedValue(new TypeError('fetch failed'))
    m.read.mockResolvedValue({ retryCount: 0, maxRetries: 3, payload: { coordinate: 'retained' }, syncStatus: 'IN_PROGRESS' })
    const before = Date.now(), result = await dispatchChannelDelist(job(channel, 'DELETE_LISTING'))
    expect(result).toMatchObject({ success: false, outcome: 'UNKNOWN', errorCode: 'DELIST_TRANSPORT_UNKNOWN', retryable: true })
    await applyDelistResultToQueue('q-pr2', result)
    const data = m.update.mock.calls.at(-1)![0].data
    expect(data).toMatchObject({ syncStatus: 'PENDING', retryCount: 1, payload: { coordinate: 'retained', delistOutcome: 'UNKNOWN', channelFact: 'UNKNOWN' } })
    expect(data.holdUntil.getTime()).toBeGreaterThanOrEqual(before + 60_000); expect(data.nextRetryAt).toEqual(data.holdUntil)
  })
  it('exhausted UNKNOWN never records FAILED', async () => {
    m.read.mockResolvedValue({ retryCount: 2, maxRetries: 3, payload: {}, syncStatus: 'IN_PROGRESS' })
    await applyDelistResultToQueue('q-pr2', { success: false, outcome: 'UNKNOWN', retryable: true, errorCode: 'DELIST_TRANSPORT_UNKNOWN' })
    expect(m.update.mock.calls.at(-1)![0].data).toMatchObject({ syncStatus: 'SKIPPED', isDead: true, payload: { delistOutcome: 'UNKNOWN' }, holdUntil: expect.any(Date) })
  })
  it('non-retryable access refusal persists UNKNOWN/REFUSED', async () => {
    m.read.mockResolvedValue({ retryCount: 0, maxRetries: 3, payload: {}, syncStatus: 'IN_PROGRESS' })
    m.end.mockRejectedValue(new Error('item cannot be accessed'))
    await applyDelistResultToQueue('q-pr2', await dispatchChannelDelist(job('EBAY', 'DELETE_LISTING')))
    expect(m.update.mock.calls.at(-1)![0].data).toMatchObject({ syncStatus: 'SKIPPED', errorCode: 'EBAY_DELIST_COULD_NOT_ASK', payload: { delistOutcome: 'UNKNOWN', channelFact: 'REFUSED' } })
  })
  it('dry run persists NOT_SENT / SKIPPED and never syncedAt', async () => {
    m.read.mockResolvedValue({ retryCount: 0, maxRetries: 3, payload: {}, syncStatus: 'IN_PROGRESS' })
    await applyDelistResultToQueue('q-pr2', { success: true, dryRun: true })
    expect(m.update.mock.calls.at(-1)![0].data).toMatchObject({ syncStatus: 'SKIPPED', syncedAt: null, errorCode: 'DELIST_DRY_RUN', payload: { delistOutcome: 'NOT_SENT' } })
  })
  it('cancelled row is never overwritten by a late result', async () => {
    m.read.mockResolvedValue({ syncStatus: 'CANCELLED' })
    await applyDelistResultToQueue('q-pr2', { success: true }); expect(m.update).not.toHaveBeenCalled()
  })
  it('one shared-ItemID outcome retains every coordinate in its durable event', async () => {
    const coordinates = ['alias-A', 'alias-B'].map(aliasKey => ({ productId: 'p', channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'owner', aliasKey }))
    m.read.mockResolvedValue({ retryCount: 0, maxRetries: 3, payload: { channelListingId: 'original', coordinates }, syncStatus: 'IN_PROGRESS' })
    await applyDelistResultToQueue('q-pr2', { success: true, outcome: 'SUCCESS' })
    expect(m.event.mock.calls.at(-1)![0].data.data.coordinates).toEqual(coordinates)
  })
  it('every code carries operator copy', () => {
    expect(Object.keys(DELIST_OPERATOR_COPY).length).toBeGreaterThan(10)
    for (const sentence of Object.values(DELIST_OPERATOR_COPY)) expect(sentence.length).toBeGreaterThan(25)
  })
})

vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, addJobSafely: vi.fn() }))
const { sellerSkuForDelist } = await import('./outbound-enqueue.js')
describe('W1.3 exact targeting', () => {
  it.each(['AMAZON', 'EBAY', 'SHOPIFY'])('%s explicit unknown account cannot borrow a stale payload account', async targetChannel => {
    expect(await dispatchChannelDelist({ ...job(targetChannel, 'DELETE_LISTING'), channelConnectionId: null })).toMatchObject({ success: false, retryable: false })
    expect(m.seller).not.toHaveBeenCalled(); expect(m.resolve).not.toHaveBeenCalled(); expect(m.removeAmazon).not.toHaveBeenCalled(); expect(m.end).not.toHaveBeenCalled()
  })
  it('an explicitly unresolved seller SKU cannot borrow a stale payload SKU', async () => {
    expect(await dispatchChannelDelist({ ...job('AMAZON', 'DELETE_LISTING'), sellerSku: null })).toMatchObject({ errorCode: 'AMAZON_DELIST_NO_SKU', retryable: false })
    expect(m.removeAmazon).not.toHaveBeenCalled()
  })
  it('seller SKU differs from ASIN and the captured owning account resolves its seller', async () => {
    await dispatchChannelDelist(job('AMAZON', 'DELETE_LISTING'))
    expect(m.removeAmazon).toHaveBeenCalledWith(expect.objectContaining({ sku: 'PR2-SELLER-SKU', sellerId: 'seller-owner' }))
    expect(m.seller).toHaveBeenCalledWith('account-owner')
  })
  it('zero Offers falls back to Product.sku; named Offer scope wins; ambiguous all refuses', () => {
    const listing = { product: { sku: 'MASTER-SKU' }, offers: [
      { sku: 'FBM-SKU', fulfillmentMethod: 'FBM', isActive: true },
      { sku: 'FBA-SKU', fulfillmentMethod: 'FBA', isActive: true },
    ] }
    expect(sellerSkuForDelist({ product: listing.product, offers: [] })).toBe('MASTER-SKU')
    expect(sellerSkuForDelist(listing, 'FBM')).toBe('FBM-SKU')
    expect(sellerSkuForDelist(listing, 'FBA')).toBe('FBA-SKU')
    expect(sellerSkuForDelist(listing)).toBeNull()
    expect(sellerSkuForDelist({ product: { sku: null } })).toBeNull()
  })
  it('missing seller SKU cannot fall back to the ASIN', async () => {
    const row = job('AMAZON', 'DELETE_LISTING'); delete (row.payload as any).sellerSku
    expect(await dispatchChannelDelist(row)).toMatchObject({ errorCode: 'AMAZON_DELIST_NO_SKU', retryable: false })
    expect(m.removeAmazon).not.toHaveBeenCalled()
  })
  it('eBay uses the captured owning account, never primary', async () => {
    await dispatchChannelDelist(job('EBAY', 'DELETE_LISTING'))
    expect(m.resolve).toHaveBeenCalledExactlyOnceWith({ accountId: 'account-owner' })
    expect(m.token).toHaveBeenCalledWith('account-owner')
  })
  it.each(['EBAY', 'SHOPIFY'])('%s refuses a missing account without env/primary fallback', async (channel) => {
    const row = job(channel, 'DELETE_LISTING'); delete (row.payload as any).channelConnectionId
    expect(await dispatchChannelDelist(row)).toMatchObject({ success: false, retryable: false, errorCode: channel === 'EBAY' ? 'EBAY_DELIST_NO_CONNECTION' : 'SHOPIFY_DELIST_NO_ACCOUNT' })
    expect(m.resolve).not.toHaveBeenCalled(); expect(m.end).not.toHaveBeenCalled(); expect(m.removeShopify).not.toHaveBeenCalled()
  })
  it.each(['GB', 'UK'])('%s ends only at site 3', async (targetRegion) => {
    await dispatchChannelDelist({ ...job('EBAY', 'DELETE_LISTING'), targetRegion })
    expect(m.end).toHaveBeenCalledWith(expect.anything(), { oauthToken: 'fake-token', siteId: '3', connectionId: 'account-owner' })
  })
  it.each([null, 'ZZ'])('market %s refuses before auth', async (targetRegion) => {
    expect(await dispatchChannelDelist({ ...job('EBAY', 'DELETE_LISTING'), targetRegion })).toMatchObject({ errorCode: targetRegion === null ? 'EBAY_DELIST_NO_REGION' : 'EBAY_UNKNOWN_MARKET', retryable: false })
    expect(m.token).not.toHaveBeenCalled(); expect(m.resolve).not.toHaveBeenCalled()
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════════
// PLAN Step 1.3 (R-39) — unpublish = stop selling, keep the identifiers. Every arm that refuses is
// paired with one that sends, so a gate that refuses everything cannot pass.
// ════════════════════════════════════════════════════════════════════════════════════════════════
const { delistCapability, readEbayOutOfStockPreference, parseOutOfStockControl } = await import('./channel-delist.service.js')

describe('Step 1.3 — Amazon unpublish is SCT.6\'s close, through the shared channel half', () => {
  it('closes THIS market\'s offer by its selectors and keeps the verbatim offer as evidence', async () => {
    const result = await dispatchChannelDelist(job('AMAZON'))
    expect(result).toMatchObject({ success: true, outcome: 'SUCCESS', submissionId: 'sub-close' })
    expect(m.getListing).toHaveBeenCalledWith(expect.objectContaining({ sellerId: 'seller-owner', sku: 'PR2-SELLER-SKU', marketplaceId: 'APJ6JRA9NG5V4' }))
    expect(m.patchOffer).toHaveBeenCalledExactlyOnceWith({
      sellerId: 'seller-owner', sku: 'PR2-SELLER-SKU', marketplaceId: 'APJ6JRA9NG5V4', productType: 'APPAREL',
      op: 'delete', value: [{ marketplace_id: 'APJ6JRA9NG5V4', currency: 'EUR', audience: 'ALL' }],
    })
    expect(result.evidence).toMatchObject({ offerSnapshot: [LIVE_OFFER], snapshotSource: 'live', productType: 'APPAREL', submissionId: 'sub-close', fulfillmentChannels: ['DEFAULT'] })
  })
  it('the evidence is saved on the job\'s record and its durable event, for a hand restore', async () => {
    m.read.mockResolvedValue({ retryCount: 0, maxRetries: 3, payload: { channelListingId: 'l-pr2' }, syncStatus: 'IN_PROGRESS' })
    await applyDelistResultToQueue('q-pr2', await dispatchChannelDelist(job('AMAZON')))
    expect(m.update.mock.calls.at(-1)![0].data).toMatchObject({ syncStatus: 'SUCCESS', payload: { delistOutcome: 'SUCCESS', channelEvidence: { offerSnapshot: [LIVE_OFFER] } } })
    expect(m.event.mock.calls.at(-1)![0].data.data.channelEvidence).toMatchObject({ offerSnapshot: [LIVE_OFFER], productType: 'APPAREL' })
  })
  it.each([['AMAZON_EU', 'DEFAULT'], ['AMAZON_EU']])('FBA stock found at job time (%s) → refused by name, nothing sent', async (...channels) => {
    m.getListing.mockResolvedValue(amazonRead({ channels }))
    expect(await dispatchChannelDelist(job('AMAZON'))).toMatchObject({ success: false, outcome: 'REFUSED', retryable: false, errorCode: 'AMAZON_UNPUBLISH_FBA' })
    expect(m.patchOffer).not.toHaveBeenCalled(); expect(m.removeAmazon).not.toHaveBeenCalled()
  })
  it('the payload says FBA → refused before the seller or the channel is asked', async () => {
    const row = job('AMAZON'); (row.payload as any).fulfillmentMethod = 'FBA'
    expect(await dispatchChannelDelist(row)).toMatchObject({ success: false, errorCode: 'AMAZON_UNPUBLISH_FBA' })
    expect(m.seller).not.toHaveBeenCalled(); expect(m.getListing).not.toHaveBeenCalled(); expect(m.patchOffer).not.toHaveBeenCalled()
  })
  it('no offer in this market → not selling, nothing sent', async () => {
    m.getListing.mockResolvedValue(amazonRead({ offers: [] }))
    const result = await dispatchChannelDelist(job('AMAZON'))
    expect(result).toMatchObject({ success: true, outcome: 'SUCCESS', channelFact: 'NOT_SELLING' })
    expect(result.evidence).toMatchObject({ offerSnapshot: [] })
    expect(m.patchOffer).not.toHaveBeenCalled()
  })
  it.each(['answer', 'throw'] as const)('a failed live read (%s) → UNKNOWN, retried later, nothing sent — FBA cannot be ruled out', async (how) => {
    if (how === 'answer') m.getListing.mockResolvedValue({ success: false, error: 'Amazon listing read failed (500)' })
    else m.getListing.mockRejectedValue(new TypeError('fetch failed'))
    expect(await dispatchChannelDelist(job('AMAZON'))).toMatchObject({ success: false, outcome: 'UNKNOWN', retryable: true, errorCode: 'AMAZON_UNPUBLISH_READ_FAILED' })
    expect(m.patchOffer).not.toHaveBeenCalled()
  })
  it('the publish gate\'s dry run → NOT_SENT', async () => {
    m.patchOffer.mockResolvedValue({ success: true, sku: 'PR2-SELLER-SKU', status: 'ACCEPTED', submissionId: 'dry-run-1', dryRun: true })
    expect(await dispatchChannelDelist(job('AMAZON'))).toMatchObject({ success: true, outcome: 'NOT_SENT', dryRun: true })
  })
  it('Amazon rejects the close → UNKNOWN, never green', async () => {
    m.patchOffer.mockResolvedValue({ success: false, sku: 'PR2-SELLER-SKU', error: 'INVALID' })
    expect(await dispatchChannelDelist(job('AMAZON'))).toMatchObject({ success: false, outcome: 'UNKNOWN', errorCode: 'AMAZON_DELIST_UNVERIFIED' })
  })
})

describe('Step 1.3 — eBay unpublish is quantity 0 under the item\'s out-of-stock control', () => {
  it('zeroes every variation SKU that still has stock, ≤4 per call, and never ends the item', async () => {
    const result = await dispatchChannelDelist(job('EBAY'))
    expect(result).toMatchObject({ success: true, outcome: 'SUCCESS', channelFact: 'NOT_SELLING' })
    const calls = reviseCalls()
    expect(calls).toHaveLength(2)
    expect(calls.map(skusOf)).toEqual([['V-1', 'V-3', 'V-4', 'V-5'], ['V-6']])
    expect(calls.flatMap(quantitiesOf)).toEqual([0, 0, 0, 0, 0])
    expect(calls.every(xml => xml.includes('<ItemID>FAKE-ASIN-NOT-SELLER-SKU</ItemID>'))).toBe(true)
    expect(result.evidence).toMatchObject({ outOfStockControl: 'ON', remainingBefore: [{ sku: 'V-1', remaining: 2 }, { sku: 'V-2', remaining: 0 }, { sku: 'V-3', remaining: 4 }, { sku: 'V-4', remaining: 1 }, { sku: 'V-5', remaining: 6 }, { sku: 'V-6', remaining: 3 }] })
    expect(m.end).not.toHaveBeenCalled()
  })
  it('a single-SKU item: one call, the ItemID and quantity 0, no SKU', async () => {
    m.trading.mockImplementation(ebayTrading({ quantity: [9, 4] }))
    expect(await dispatchChannelDelist(job('EBAY'))).toMatchObject({ success: true, channelFact: 'NOT_SELLING' })
    const calls = reviseCalls()
    expect(calls).toHaveLength(1); expect(skusOf(calls[0])).toEqual([]); expect(quantitiesOf(calls[0])).toEqual([0])
  })
  it.each([['false', 'EBAY_UNPUBLISH_OOS_OFF'], [null, 'EBAY_UNPUBLISH_OOS_UNKNOWN'], ['maybe', 'EBAY_UNPUBLISH_OOS_UNKNOWN']] as const)('out-of-stock control %s → refused by name, nothing sent', async (oos, code) => {
    m.trading.mockImplementation(ebayTrading({ oos }))
    expect(await dispatchChannelDelist(job('EBAY'))).toMatchObject({ success: false, outcome: 'REFUSED', retryable: false, errorCode: code })
    expect(reviseCalls()).toHaveLength(0); expect(m.end).not.toHaveBeenCalled()
  })
  it('an item that is not Active → not selling, nothing sent', async () => {
    m.trading.mockImplementation(ebayTrading({ status: 'Completed' }))
    expect(await dispatchChannelDelist(job('EBAY'))).toMatchObject({ success: true, channelFact: 'NOT_SELLING' })
    expect(reviseCalls()).toHaveLength(0)
  })
  it('every quantity already 0 → not selling, nothing sent', async () => {
    m.trading.mockImplementation(ebayTrading({ variations: [['V-1', 3, 3], ['V-2', 1, 1]] }))
    expect(await dispatchChannelDelist(job('EBAY'))).toMatchObject({ success: true, channelFact: 'NOT_SELLING' })
    expect(reviseCalls()).toHaveLength(0)
  })
  it('the second call is rejected → FAILURE, retryable, names the partial result', async () => {
    m.trading.mockImplementation(ebayTrading({}, (_xml, n) => { if (n === 1) throw new Error('eBay ReviseInventoryStatus Failure: Invalid SKU'); return { ack: 'Success', errors: [], raw: '' } }))
    const result = await dispatchChannelDelist(job('EBAY'))
    expect(result).toMatchObject({ success: false, outcome: 'FAILURE', retryable: true, errorCode: 'EBAY_UNPUBLISH_PARTIAL' })
    expect(result.evidence).toMatchObject({ zeroed: ['V-1', 'V-3', 'V-4', 'V-5'] })
  })
  it('a lost answer on a revise → UNKNOWN', async () => {
    m.trading.mockImplementation(ebayTrading({}, () => { throw new TypeError('fetch failed') }))
    expect(await dispatchChannelDelist(job('EBAY'))).toMatchObject({ success: false, outcome: 'UNKNOWN', errorCode: 'DELIST_TRANSPORT_UNKNOWN' })
  })
  it('a PartialFailure acknowledgement is never green', async () => {
    m.trading.mockImplementation(ebayTrading({}, () => ({ ack: 'PartialFailure', errors: [], raw: '' })))
    expect(await dispatchChannelDelist(job('EBAY'))).toMatchObject({ success: false, outcome: 'FAILURE', errorCode: 'EBAY_UNPUBLISH_FAILED' })
  })
  it('a local dry run (no real eBay API) → NOT_SENT, nothing validated', async () => {
    m.trading.mockResolvedValue({ ack: 'Success', itemId: 'DRYRUN-GetItem', errors: [], raw: '' })
    expect(await dispatchChannelDelist(job('EBAY'))).toMatchObject({ success: true, outcome: 'NOT_SENT', dryRun: true })
    expect(m.trading).toHaveBeenCalledTimes(1)
  })
  it('the eBay write gate refuses the first revise → NOT_SENT', async () => {
    m.trading.mockImplementation(ebayTrading({}, () => { const e = new Error('eBay writes are off'); e.name = 'EbayWriteRefusedError'; throw e }))
    expect(await dispatchChannelDelist(job('EBAY'))).toMatchObject({ success: true, outcome: 'NOT_SENT', dryRun: true })
  })
})

describe('Step 1.3 — the one capability table, per listing', () => {
  it.each([
    ['listing', { amazonListing: { fulfillmentMethod: 'FBA' } }],
    ['product', { amazonListing: { fulfillmentMethod: 'FBM', product: { fulfillmentMethod: 'FBA' } } }],
    ['attributes', { amazonListing: { platformAttributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] } } }],
    ['offer evidence', { amazonListing: { fulfillmentMethod: 'FBM' }, amazonFbaEvidence: { hasActiveFbaOffer: true } }],
  ] as const)('Amazon unpublish of an FBA listing (%s) is refused', (_label, facts) => {
    expect(delistCapability('AMAZON', 'unpublish', facts as any)).toEqual({ removes: false, errorCode: 'AMAZON_UNPUBLISH_FBA' })
  })
  it('positive control: Amazon unpublish of a merchant listing removes it; delete is unchanged', () => {
    expect(delistCapability('AMAZON', 'unpublish', { amazonListing: { fulfillmentMethod: 'FBM' } })).toEqual({ removes: true })
    expect(delistCapability('AMAZON', 'delete', { amazonListing: { fulfillmentMethod: 'FBA' } })).toEqual({ removes: true })
  })
  it('eBay unpublish removes only with the out-of-stock control ON', () => {
    expect(delistCapability('EBAY', 'unpublish', { ebayOutOfStockControl: 'ON' })).toEqual({ removes: true })
    expect(delistCapability('EBAY', 'unpublish', { ebayOutOfStockControl: 'OFF' })).toEqual({ removes: false, errorCode: 'EBAY_UNPUBLISH_OOS_OFF' })
    expect(delistCapability('EBAY', 'unpublish', { ebayOutOfStockControl: 'UNKNOWN' })).toEqual({ removes: false, errorCode: 'EBAY_UNPUBLISH_OOS_UNKNOWN' })
    expect(delistCapability('EBAY', 'unpublish')).toEqual({ removes: false, errorCode: 'EBAY_UNPUBLISH_OOS_UNKNOWN' })
    expect(delistCapability('EBAY', 'delete')).toEqual({ removes: true })
  })
  it('Shopify is unchanged', () => {
    for (const action of ['unpublish', 'delete'] as const) expect(delistCapability('SHOPIFY', action)).toEqual({ removes: false, errorCode: 'SHOPIFY_DELIST_NOT_IMPLEMENTED' })
  })
})

describe('Step 1.3 — the account\'s out-of-stock preference (read by the route before its transaction)', () => {
  it.each([['true', 'ON'], ['false', 'OFF'], ['', 'UNKNOWN']] as const)('%j → %s', async (value, want) => {
    m.trading.mockResolvedValue({ ack: 'Success', errors: [], raw: value ? `<OutOfStockControlPreference>${value}</OutOfStockControlPreference>` : '<Ack>Success</Ack>' })
    expect(await readEbayOutOfStockPreference('account-owner', 'IT')).toBe(want)
    expect(m.trading).toHaveBeenCalledWith('GetUserPreferences', expect.stringContaining('<ShowOutOfStockControlPreference>true</ShowOutOfStockControlPreference>'), expect.objectContaining({ oauthToken: 'fake-token', siteId: '101', connectionId: 'account-owner' }))
  })
  it('a failure, a dry run, another channel\'s account, or a timeout → UNKNOWN (fail closed)', async () => {
    m.trading.mockRejectedValueOnce(new Error('eBay GetUserPreferences HTTP 500'))
    expect(await readEbayOutOfStockPreference('account-owner', 'IT')).toBe('UNKNOWN')
    m.trading.mockResolvedValueOnce({ ack: 'Success', itemId: 'DRYRUN-GetUserPreferences', errors: [], raw: '' })
    expect(await readEbayOutOfStockPreference('account-owner', 'IT')).toBe('UNKNOWN')
    m.resolve.mockResolvedValueOnce({ id: 'account-owner', channelType: 'AMAZON' })
    expect(await readEbayOutOfStockPreference('account-owner', 'IT')).toBe('UNKNOWN')
    m.trading.mockImplementationOnce(() => new Promise(() => {}))
    expect(await readEbayOutOfStockPreference('account-owner', 'IT', 20)).toBe('UNKNOWN')
  })
  it('parseOutOfStockControl reads only true/false', () => {
    expect(parseOutOfStockControl('<OutOfStockControl> true </OutOfStockControl>', 'OutOfStockControl')).toBe('ON')
    expect(parseOutOfStockControl('<OutOfStockControl>FALSE</OutOfStockControl>', 'OutOfStockControl')).toBe('OFF')
    expect(parseOutOfStockControl('<OutOfStockControlPreference>true</OutOfStockControlPreference>', 'OutOfStockControl')).toBe('UNKNOWN')
  })
})
