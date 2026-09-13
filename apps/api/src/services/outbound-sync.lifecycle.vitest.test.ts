import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => {
  const outbound = vi.fn(() => { throw new Error('Unexpected outbound fetch') }); vi.stubGlobal('fetch', outbound)
  return { outbound, update: vi.fn(), claim: vi.fn(), findMany: vi.fn(), emit: vi.fn() }
})
vi.mock('../db.js', () => ({ default: { outboundSyncQueue: { update: m.update, updateMany: m.claim, findMany: m.findMany } } }))
vi.mock('./product-event.service.js', () => ({ productEventService: { emit: m.emit } }))
const { default: OutboundSyncService } = await import('./outbound-sync.service.js')
let service: any
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('AMAZON_PUBLISH_MODE', 'dry-run'); service = OutboundSyncService
  m.claim.mockResolvedValue({ count: 1 }); m.emit.mockResolvedValue(undefined)
  for (const name of ['syncToAmazon', 'syncToEbay', 'syncToShopify', 'syncToWoocommerce']) vi.spyOn(service, name).mockResolvedValue({ success: true })
})
afterEach(() => { expect(m.outbound).not.toHaveBeenCalled(); vi.unstubAllEnvs() })
describe('W1.2 dispatchSync lifecycle containment', () => {
  for (const targetChannel of ['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE']) {
    it.each(['UNPUBLISH_LISTING', 'DELETE_LISTING'])(`${targetChannel} %s never enters an update adapter`, async (syncType) => {
      const row = { id: 'q-lifecycle', syncStatus: 'PENDING', targetChannel, syncType, payload: { quantity: 0 }, retryCount: 0, maxRetries: 3 }
      expect(await service.dispatchSync(row)).toMatchObject({ success: false, retryable: false, errorCode: 'LIFECYCLE_DISPATCH_REFUSED' })
      m.findMany.mockResolvedValue([row]); await service.processPendingSyncs()
      expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ syncStatus: 'FAILED', isDead: true, errorCode: 'LIFECYCLE_DISPATCH_REFUSED' }) }))
      for (const name of ['syncToAmazon', 'syncToEbay', 'syncToShopify', 'syncToWoocommerce']) expect(service[name]).not.toHaveBeenCalled()
    })
  }
  it.each(['PRICE_UPDATE', 'QUANTITY_UPDATE', 'STATUS_UPDATE', 'CONTENT_UPDATE', 'FULL_SYNC', 'ATTRIBUTE_UPDATE'])('positive control: ordinary %s reaches its existing adapter', async (syncType) => {
    expect(await service.dispatchSync({ id: 'q-normal', targetChannel: 'SHOPIFY', syncType, payload: {} })).toEqual({ success: true })
    expect(service.syncToShopify).toHaveBeenCalledOnce()
  })
  for (const syncType of ['UNPUBLISH_LISTING', 'DELETE_LISTING']) {
    it.each(['PENDING', 'FAILED'])(`${syncType}: a %s drain refusal preserves the previous unknown channel attempt`, async (syncStatus) => {
      const row = {
        id: 'q-unknown', targetChannel: 'EBAY', syncType, syncStatus,
        retryCount: 1, maxRetries: 3, nextRetryAt: new Date(0), holdUntil: new Date(0),
        errorCode: 'DELIST_TRANSPORT_UNKNOWN', errorMessage: 'Connection lost after request.',
        payload: { delistOutcome: 'UNKNOWN', channelFact: 'UNKNOWN', sellerSku: 'captured-sku' },
      }
      m.findMany.mockResolvedValueOnce(syncStatus === 'PENDING' ? [row] : [])
        .mockResolvedValueOnce(syncStatus === 'FAILED' ? [row] : [])
      const stats = await service.processPendingSyncs()
      expect(stats).toMatchObject({ processed: 1, skipped: 1, succeeded: 0, failed: 0 })
      expect(m.update).toHaveBeenCalledExactlyOnceWith({ where: { id: row.id }, data: expect.objectContaining({
        syncStatus: 'SKIPPED', syncedAt: null, nextRetryAt: null, isDead: true,
        errorCode: 'DELIST_TRANSPORT_UNKNOWN',
        errorMessage: expect.stringContaining(row.errorMessage),
        payload: { ...row.payload, delistDispatchErrorCode: 'LIFECYCLE_DISPATCH_REFUSED', delistDispatchError: expect.any(String) },
      }) })
      expect(m.update.mock.calls[0][0].data.retryCount).toBeUndefined()
      expect(m.emit).not.toHaveBeenCalled()
      for (const name of ['syncToAmazon', 'syncToEbay', 'syncToShopify', 'syncToWoocommerce']) expect(service[name]).not.toHaveBeenCalled()
    })
  }
})
