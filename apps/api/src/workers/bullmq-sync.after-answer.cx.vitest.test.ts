/**
 * CX review 2026-09-26 — work that must run AFTER a queue row has its answer (the eBay price read-back, B1) is started
 * by the BullMQ worker only once the row is written: never before, never inside the row's dispatch budget, and a
 * failure there never changes the row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected outbound fetch') }))
  return { read: vi.fn(), update: vi.fn(), claim: vi.fn() }
})
vi.mock('../db.js', () => ({ default: { outboundSyncQueue: { findUnique: m.read, findMany: vi.fn(async () => []), update: m.update, updateMany: m.claim } } }))
vi.mock('@nexus/database', () => ({ prisma: { outboundSyncQueue: { findUnique: m.read, update: m.update } } }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, addJobSafely: vi.fn(), readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
vi.mock('../lib/workspace-jobs.js', () => ({ WorkspaceWorker: class { on() { return this } } }))
vi.mock('../services/product-event.service.js', () => ({ productEventService: { emit: vi.fn(async () => undefined) } }))
vi.mock('../services/variation-sync-processor.service.js', () => ({ variationSyncProcessor: {} }))
vi.mock('../services/repricer.service.js', () => ({ calculateTargetPrice: vi.fn() }))

const { default: service } = await import('../services/outbound-sync.service.js')
const { processOutboundSyncJob, resetBullMQWorkerStats } = await import('./bullmq-sync.worker.js')

const job = { id: 'job-1', attemptsMade: 0, data: { queueId: 'q1', productId: 'p1', targetChannel: 'EBAY', syncType: 'PRICE_UPDATE' } } as any
beforeEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks(); resetBullMQWorkerStats()
  m.read.mockResolvedValue({ id: 'q1', productId: 'p1', channelListingId: null, targetChannel: 'EBAY', syncType: 'PRICE_UPDATE', syncStatus: 'PENDING', payload: {}, retryCount: 0, maxRetries: 3 })
  m.update.mockResolvedValue({})
})

describe('BullMQ worker — after-answer work starts only once the row is written', () => {
  it('SUCCESS is written first, then the after-answer work starts (once)', async () => {
    // The write takes time: the work must wait for it to FINISH, not merely to be called.
    let written = false
    m.update.mockImplementation(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); written = true; return {} })
    let writtenWhenStarted: boolean | null = null
    const afterAnswer = vi.fn(async () => { writtenWhenStarted = written })
    vi.spyOn(service, 'processSingle').mockResolvedValue({ success: true, queueId: 'q1', channel: 'EBAY', status: 'SUCCESS', message: 'ok', afterAnswer } as any)
    const result = await processOutboundSyncJob(job)
    expect(result).toMatchObject({ status: 'SUCCESS', queueId: 'q1' })
    expect(m.update).toHaveBeenCalledTimes(1)
    expect(m.update.mock.calls[0][0].data).toMatchObject({ syncStatus: 'SUCCESS' })
    expect(afterAnswer).toHaveBeenCalledTimes(1)
    expect(writtenWhenStarted).toBe(true)
  })
  it('an after-answer failure does not reach the job or the row', async () => {
    const afterAnswer = vi.fn(async () => { throw new Error('read-back exploded') })
    vi.spyOn(service, 'processSingle').mockResolvedValue({ success: true, queueId: 'q1', channel: 'EBAY', status: 'SUCCESS', message: 'ok', afterAnswer } as any)
    await expect(processOutboundSyncJob(job)).resolves.toMatchObject({ status: 'SUCCESS' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(afterAnswer).toHaveBeenCalledTimes(1)
    expect(m.update).toHaveBeenCalledTimes(1)
  })
  it('a failed row never starts after-answer work', async () => {
    const afterAnswer = vi.fn(async () => undefined)
    vi.spyOn(service, 'processSingle').mockResolvedValue({ success: false, queueId: 'q1', channel: 'EBAY', status: 'FAILED', message: 'no', error: 'no', retryable: false, afterAnswer } as any)
    await processOutboundSyncJob(job)
    expect(afterAnswer).not.toHaveBeenCalled()
  })
})
