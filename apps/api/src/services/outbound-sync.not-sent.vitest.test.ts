import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => {
  const outbound = vi.fn(() => { throw new Error('Unexpected outbound fetch') })
  vi.stubGlobal('fetch', outbound)
  vi.stubEnv('AMAZON_PUBLISH_MODE', 'dry-run')
  return { outbound, read: vi.fn(), many: vi.fn(), update: vi.fn(), claim: vi.fn(), publish: vi.fn(), completed: null as any }
})
vi.mock('../db.js', () => ({ default: {
  outboundSyncQueue: { findUnique: m.read, findMany: m.many, update: m.update, updateMany: m.claim },
  channelListing: { findMany: async () => [] },
  marketplace: { findFirst: async () => ({ languages: ['it'] }) },
} }))
vi.mock('@nexus/database', () => ({ prisma: { outboundSyncQueue: { findUnique: m.read, update: m.update } } }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, addJobSafely: vi.fn(), readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
vi.mock('../lib/workspace-jobs.js', () => ({ WorkspaceWorker: class { on(event: string, handler: any) { if (event === 'completed') m.completed = handler; return this } } }))
vi.mock('../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: async () => 'fake-seller' }))
vi.mock('./listing-publish.service.js', () => ({ listingPublishService: { publish: m.publish } }))
vi.mock('./sync-control-policy.service.js', () => ({ loadChannelPolicies: async () => new Map(), policyFor: () => null }))
vi.mock('./channel-publish-audit.service.js', () => ({ writeAttemptLog: vi.fn(), digestPayload: () => 'fake-digest' }))
vi.mock('./product-event.service.js', () => ({ productEventService: { emit: vi.fn() } }))
vi.mock('./variation-sync-processor.service.js', () => ({ variationSyncProcessor: {} }))
vi.mock('./repricer.service.js', () => ({ calculateTargetPrice: vi.fn() }))

const { default: service } = await import('./outbound-sync.service.js')
const { processOutboundSyncJob, initializeBullMQWorker, resetBullMQWorkerStats, getBullMQWorkerStats } = await import('../workers/bullmq-sync.worker.js')
const row = (syncStatus = 'PENDING') => ({ id: 'q-empty', productId: 'fake-product', channelListingId: null, targetChannel: 'AMAZON', syncType: 'STATUS_UPDATE', syncStatus,
  product: { id: 'fake-product', sku: 'SELLER-SKU', productType: 'OUTERWEAR' }, payload: { status: 'INACTIVE', marketplaceId: 'IT' }, retryCount: 0, maxRetries: 3 })
beforeEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks(); resetBullMQWorkerStats()
  m.claim.mockResolvedValue({ count: 1 }); m.read.mockResolvedValue(row()); m.many.mockResolvedValue([])
  m.publish.mockResolvedValue({ success: true, mode: 'live', message: 'Accepted by synthetic publisher' })
})
afterEach(() => expect(m.outbound).not.toHaveBeenCalled())
const assertNotSent = () => {
  const final = m.update.mock.calls.at(-1)![0].data
  expect(final).toMatchObject({ syncStatus: 'SKIPPED', syncedAt: null, errorCode: 'AMAZON_EMPTY_PATCH_NOT_SENT', errorMessage: expect.stringContaining('Nothing was sent') })
  expect(m.publish).not.toHaveBeenCalled()
}
describe('W1.9 empty STATUS_UPDATE remains not sent at every completion writer', () => {
  it('real Amazon adapter supplies a named, terminal reason without reaching publish', async () => {
    expect(await (service as any).dispatchSync(row())).toMatchObject({ success: true, status: 'SKIPPED', retryable: false, errorCode: 'AMAZON_EMPTY_PATCH_NOT_SENT', message: expect.stringContaining('Nothing was sent') })
    expect(m.publish).not.toHaveBeenCalled()
  })
  it.each(['PENDING', 'FAILED'])('%s drain retains SKIPPED and excludes it from succeeded count', async syncStatus => {
    m.many.mockResolvedValueOnce(syncStatus === 'PENDING' ? [row(syncStatus)] : []).mockResolvedValueOnce(syncStatus === 'FAILED' ? [row(syncStatus)] : [])
    expect(await service.processPendingSyncs()).toMatchObject({ processed: 1, succeeded: 0, failed: 0, skipped: 1 })
    assertNotSent()
  })
  it('BullMQ completion retains the empty-patch reason and does not increment success', async () => {
    initializeBullMQWorker()
    const job = { id: 'fake-job', attemptsMade: 0, data: { queueId: 'q-empty', productId: 'fake-product', targetChannel: 'AMAZON', syncType: 'STATUS_UPDATE' } } as any
    const result = await processOutboundSyncJob(job)
    expect(result).toMatchObject({ status: 'SKIPPED' }); assertNotSent()
    m.completed(job, result)
    expect(getBullMQWorkerStats().succeeded).toBe(0)
  })
  it.each([false, true])('positive publisher control with dryRun=%s persists the right completion', async dryRun => {
    const price = { ...row(), syncType: 'PRICE_UPDATE', payload: { price: 19.99, marketplaceId: 'IT' } }
    m.publish.mockResolvedValue({ success: true, mode: dryRun ? 'dry-run' : 'live', message: dryRun ? 'Dry run; no channel change' : 'Accepted' })
    m.many.mockResolvedValueOnce([price]).mockResolvedValueOnce([])
    const stats = await service.processPendingSyncs()
    expect(m.publish).toHaveBeenCalledOnce()
    expect(m.update.mock.calls.at(-1)![0].data).toMatchObject({ syncStatus: dryRun ? 'SKIPPED' : 'SUCCESS', syncedAt: dryRun ? null : expect.any(Date) })
    expect(stats).toMatchObject({ succeeded: dryRun ? 0 : 1, skipped: dryRun ? 1 : 0 })
  })
})
