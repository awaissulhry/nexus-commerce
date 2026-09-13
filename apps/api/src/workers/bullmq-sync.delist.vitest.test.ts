import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => {
  const outbound = vi.fn(() => { throw new Error('Unexpected outbound fetch') }); vi.stubGlobal('fetch', outbound)
  return { outbound, read: vi.fn(), update: vi.fn(), claim: vi.fn(), dispatch: vi.fn(), apply: vi.fn(), completed: null as any }
})
vi.mock('@nexus/database', () => ({ prisma: { outboundSyncQueue: { findUnique: m.read, update: m.update, updateMany: m.claim } } }))
vi.mock('../lib/workspace-jobs.js', () => ({ WorkspaceWorker: class { on(event: string, handler: any) { if (event === 'completed') m.completed = handler; return this } } }))
vi.mock('../lib/queue.js', () => ({ redis: { connection: null } }))
vi.mock('../services/variation-sync-processor.service.js', () => ({ variationSyncProcessor: {} }))
vi.mock('../services/outbound-sync.service.js', () => ({ default: {}, computeFailureDisposition: vi.fn() }))
vi.mock('../services/channel-delist.service.js', () => ({ dispatchChannelDelist: m.dispatch, applyDelistResultToQueue: m.apply }))
vi.mock('../services/repricer.service.js', () => ({ calculateTargetPrice: vi.fn() }))
vi.mock('../services/product-event.service.js', () => ({ productEventService: {} }))
const { processOutboundSyncJob, initializeBullMQWorker, getBullMQWorkerStats, resetBullMQWorkerStats } = await import('./bullmq-sync.worker.js')
const row = () => ({ id: 'q', syncStatus: 'PENDING', productId: null, channelListingId: null, targetChannel: 'EBAY', targetRegion: 'GB', syncType: 'DELETE_LISTING', externalListingId: 'FAKE', payload: { channelConnectionId: 'owner' } })
const job = () => ({ id: 'bull-q', attemptsMade: 0, data: { queueId: 'q', targetChannel: 'AMAZON', syncType: 'STATUS_UPDATE' } }) as any
beforeEach(() => { vi.clearAllMocks(); m.read.mockResolvedValue(row()); m.claim.mockResolvedValue({ count: 1 }); m.dispatch.mockResolvedValue({ success: true }); m.apply.mockResolvedValue(undefined) })
afterEach(() => expect(m.outbound).not.toHaveBeenCalled())
describe('lifecycle worker reads the durable queue row', () => {
  it('uses row channel and lifecycle type even when BullMQ data is wrong or stale', async () => {
    expect(await processOutboundSyncJob(job())).toMatchObject({ status: 'SUCCESS' })
    expect(m.dispatch).toHaveBeenCalledWith(expect.objectContaining({ targetChannel: 'EBAY', syncType: 'DELETE_LISTING', targetRegion: 'GB', externalListingId: 'FAKE' }))
  })
  it('cancellation prevents dispatch', async () => {
    m.read.mockResolvedValue({ ...row(), syncStatus: 'CANCELLED' })
    expect(await processOutboundSyncJob(job())).toMatchObject({ status: 'CANCELLED' }); expect(m.dispatch).not.toHaveBeenCalled()
  })
  it.each([{ success: false, outcome: 'UNKNOWN' }, { success: true, dryRun: true }])('reports an honest outcome %j', async (result) => {
    m.dispatch.mockResolvedValue(result)
    expect(await processOutboundSyncJob(job())).toMatchObject({ status: result.dryRun ? 'SKIPPED' : 'UNKNOWN' })
    expect(m.apply).toHaveBeenCalledWith('q', result)
  })
})
it('honours the row hold even when BullMQ fires too early', async () => {
  m.read.mockResolvedValue({ ...row(), holdUntil: new Date(Date.now() + 300_000) })
  expect(await processOutboundSyncJob(job())).toMatchObject({ status: 'SKIPPED', reason: 'Still within grace window' })
  expect(m.claim).not.toHaveBeenCalled(); expect(m.dispatch).not.toHaveBeenCalled()
})
it('losing the cancellation/cron CAS prevents a duplicate channel attempt', async () => {
  m.claim.mockResolvedValue({ count: 0 })
  expect(await processOutboundSyncJob(job())).toMatchObject({ status: 'SKIPPED', reason: 'Lost dispatch claim' })
  expect(m.dispatch).not.toHaveBeenCalled()
})

it('BullMQ completion of UNKNOWN/refused/dry-run/cancelled does not turn counters green', async () => {
  resetBullMQWorkerStats(); initializeBullMQWorker()
  for (const status of ['UNKNOWN', 'FAILED', 'SKIPPED', 'CANCELLED']) m.completed(job(), { lifecycle: true, status })
  expect(getBullMQWorkerStats().succeeded).toBe(0)
  m.completed(job(), { status: 'SUCCESS' }) // existing non-lifecycle completion behavior
  expect(getBullMQWorkerStats().succeeded).toBe(1)
})
