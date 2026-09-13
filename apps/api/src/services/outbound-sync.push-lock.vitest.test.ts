import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => {
  const outbound = vi.fn(() => { throw new Error('Unexpected outbound fetch') }); vi.stubGlobal('fetch', outbound)
  return { outbound, read: vi.fn(), many: vi.fn(), seller: vi.fn(), audit: vi.fn() }
})
vi.mock('../db.js', () => ({ default: { channelListing: { findUnique: m.read, findMany: m.many } } }))
vi.mock('../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: m.seller }))
vi.mock('../lib/queue.js', () => ({ addJobSafely: vi.fn(), outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
vi.mock('./sync-control-policy.service.js', () => ({ loadChannelPolicies: async () => new Map(), policyFor: () => null }))
vi.mock('./channel-publish-audit.service.js', () => ({ writeAttemptLog: m.audit, digestPayload: () => 'stub' }))
const { OutboundSyncService } = await import('./outbound-sync.service.js')
const service: any = new OutboundSyncService()
const paths = ['syncToAmazon', 'syncToEbay', 'syncSharedTradingQuantity', 'syncToShopify', 'syncToWoocommerce']
const holds = [
  [{ syncPaused: true }, 'PUSH_SYNC_PAUSED'], [{ offerClosedAt: new Date() }, 'PUSH_OFFER_CLOSED'],
  ...['HELD', 'WITHDRAWN', 'ENDED', 'DISCONTINUED', 'RELEASED'].map(presenceIntent => [{ presenceIntent }, `PUSH_INTENT_${presenceIntent}`]),
] as const
const row = (syncType = 'STATUS_UPDATE') => ({ id: 'q', channelListingId: 'l', targetChannel: 'AMAZON', targetRegion: 'IT', syncType, product: { id: 'p', sku: 'SKU', productType: 'OUTERWEAR' }, payload: {} })
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('AMAZON_PUBLISH_MODE', 'dry-run'); vi.stubEnv('NEXUS_ENABLE_AMAZON_PUBLISH', 'false'); vi.stubEnv('NEXUS_ENABLE_EBAY_PUBLISH', 'false'); vi.stubEnv('NEXUS_ENABLE_SHOPIFY_PUBLISH', 'false')
  m.seller.mockResolvedValue('seller'); m.read.mockResolvedValue({ id: 'l', marketplace: 'IT', platformAttributes: {}, syncPaused: false }); m.many.mockResolvedValue([])
})
afterEach(() => { expect(m.outbound).not.toHaveBeenCalled(); vi.unstubAllEnvs() })
describe('W1.5-QUEUE every push consults the shared lock', () => {
  for (const path of paths) it.each(holds)(`${path} refuses %j`, async (lock, code) => {
    m.read.mockResolvedValue(lock)
    expect(await service[path](row())).toMatchObject({ success: false, retryable: false, errorCode: code, error: expect.any(String) })
    expect(m.seller).not.toHaveBeenCalled(); expect(m.audit).not.toHaveBeenCalled()
  })
  for (const path of paths) it(`${path} positive control allows an unlocked row to reach its existing mode/containment branch`, async () => {
    const result = await service[path](row())
    expect(result.errorCode?.startsWith('PUSH_') ?? false).toBe(false)
    expect(m.read).toHaveBeenCalled()
  })
  it.each(['STATUS_UPDATE', 'PRICE_UPDATE', 'QUANTITY_UPDATE', 'CONTENT_UPDATE'])('dispatchSync preserves the refusal for %s', async (syncType) => {
    m.read.mockResolvedValue({ syncPaused: true })
    expect(await service.dispatchSync(row(syncType))).toMatchObject({ success: false, errorCode: 'PUSH_SYNC_PAUSED', retryable: false })
  })
  it('a shared ItemID is held if any of its current coordinates is held, even without channelListingId', async () => {
    m.many.mockResolvedValue([{ syncPaused: false }, { syncPaused: true }])
    expect(await service.syncSharedTradingQuantity({ id: 'q', externalListingId: 'ITEM', payload: { pushVia: 'TRADING', itemId: 'ITEM', market: 'GB', channelConnectionId: 'owner' } })).toMatchObject({ errorCode: 'PUSH_SYNC_PAUSED' })
    expect(m.many).toHaveBeenCalledWith({ where: { channel: 'EBAY', externalListingId: 'ITEM', marketplace: { in: ['GB', 'UK'] }, channelConnectionId: 'owner' } })
  })
  it('a failed control read never falls through to a channel client', async () => {
    m.read.mockRejectedValue(new Error('database unavailable'))
    await expect(service.syncToAmazon(row())).rejects.toThrow('database unavailable')
    expect(m.seller).not.toHaveBeenCalled()
  })
})
