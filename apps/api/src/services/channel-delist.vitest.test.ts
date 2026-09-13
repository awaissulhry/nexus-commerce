import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => {
  const outbound = vi.fn(() => { throw new Error('Unexpected outbound fetch') })
  vi.stubGlobal('fetch', outbound)
  return {
    outbound, removeAmazon: vi.fn(), removeShopify: vi.fn(), updateShopify: vi.fn(),
    seller: vi.fn(), end: vi.fn(), token: vi.fn(), resolve: vi.fn(),
    update: vi.fn(), read: vi.fn(), event: vi.fn(),
  }
})
vi.mock('../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: m.seller }))
vi.mock('../clients/amazon-sp-api.client.js', () => ({ amazonSpApiClient: { deleteListingsItem: m.removeAmazon } }))
vi.mock('./marketplaces/shopify.service.js', () => ({ ShopifyService: class {
  deleteProduct = m.removeShopify
  updateProduct = m.updateShopify
} }))
vi.mock('@nexus/database', () => { const db = { outboundSyncQueue: { updateMany: m.update, findUnique: m.read }, productEvent: { create: m.event } }; return { prisma: { ...db, $transaction: async (run: any) => run(db) } } })
vi.mock('./ebay-trading-api.service.js', async (original) => ({
  ...await original<typeof import('./ebay-trading-api.service.js')>(), endFixedPriceItem: m.end,
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
})
afterEach(() => {
  expect(m.outbound).not.toHaveBeenCalled()
  vi.unstubAllEnvs()
})
describe('W1.1 no adapter escalates', () => {
  it('Amazon unpublish refuses before seller resolution or deleteListingsItem', async () => {
    expect(await dispatchChannelDelist(job('AMAZON'))).toMatchObject({
      success: false, retryable: false, errorCode: 'AMAZON_UNPUBLISH_NOT_IMPLEMENTED',
      error: 'Amazon has no reversible unpublish in this client yet',
    })
    expect(m.removeAmazon).not.toHaveBeenCalled()
    expect(m.seller).not.toHaveBeenCalled()
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
  it('eBay unpublish refuses instead of ending the ItemID', async () => {
    expect(await dispatchChannelDelist(job('EBAY'))).toMatchObject({
      success: false, retryable: false, errorCode: 'EBAY_UNPUBLISH_NOT_IMPLEMENTED',
    })
    expect(m.end).not.toHaveBeenCalled()
    expect(m.token).not.toHaveBeenCalled()
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
    expect(m.end).toHaveBeenCalledWith(expect.anything(), { oauthToken: 'fake-token', siteId: '3' })
  })
  it.each([null, 'ZZ'])('market %s refuses before auth', async (targetRegion) => {
    expect(await dispatchChannelDelist({ ...job('EBAY', 'DELETE_LISTING'), targetRegion })).toMatchObject({ errorCode: targetRegion === null ? 'EBAY_DELIST_NO_REGION' : 'EBAY_UNKNOWN_MARKET', retryable: false })
    expect(m.token).not.toHaveBeenCalled(); expect(m.resolve).not.toHaveBeenCalled()
  })
})
