/**
 * 2026-10-01 — the BullMQ worker (the path a price takes 30 s after an edit) records each row's end on the listing:
 * a real send → the listing's own status follows it (`recordListingSyncOutcome`), a dead-lettered failure → FAILED; a
 * skip, a retry or a deferral → nothing. Before, the listing kept reading "Pending" after its price reached Amazon.
 * The helper's SQL is proven on PostgreSQL in `services/listing-sync-outcome.vitest.test.ts`; this file proves the wiring.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected outbound fetch') }))
  return { read: vi.fn(), update: vi.fn(), claim: vi.fn(), outcome: vi.fn(async () => undefined) }
})
vi.mock('../db.js', () => ({ default: { outboundSyncQueue: { findUnique: m.read, findMany: vi.fn(async () => []), update: m.update, updateMany: m.claim } } }))
vi.mock('@nexus/database', () => ({ prisma: { outboundSyncQueue: { findUnique: m.read, update: m.update } } }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, addJobSafely: vi.fn(), readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
vi.mock('../lib/workspace-jobs.js', () => ({ WorkspaceWorker: class { on() { return this } } }))
vi.mock('../services/product-event.service.js', () => ({ productEventService: { emit: vi.fn(async () => undefined) } }))
vi.mock('../services/variation-sync-processor.service.js', () => ({ variationSyncProcessor: {} }))
vi.mock('../services/repricer.service.js', () => ({ calculateTargetPrice: vi.fn() }))
vi.mock('../services/listing-sync-outcome.js', () => ({ recordListingSyncOutcome: m.outcome }))

const { default: service } = await import('../services/outbound-sync.service.js')
const { processOutboundSyncJob, resetBullMQWorkerStats } = await import('./bullmq-sync.worker.js')

const job = { id: 'job-1', attemptsMade: 0, data: { queueId: 'q1', productId: 'p1', targetChannel: 'AMAZON', syncType: 'PRICE_UPDATE' } } as any
const answer = (over: Record<string, unknown>) => ({ success: true, queueId: 'q1', channel: 'AMAZON', status: 'SUCCESS', message: 'ok', ...over }) as any
beforeEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks(); resetBullMQWorkerStats()
  m.read.mockResolvedValue({ id: 'q1', productId: 'p1', channelListingId: 'l1', targetChannel: 'AMAZON', syncType: 'PRICE_UPDATE', syncStatus: 'PENDING', payload: {}, retryCount: 0, maxRetries: 3 })
  m.update.mockResolvedValue({})
})

describe('BullMQ worker — the listing follows the row', () => {
  it('a real send: the row is written SUCCESS first, then the listing is told "sent"', async () => {
    let written = false
    m.update.mockImplementation(async () => { written = true; return {} })
    let writtenFirst: boolean | null = null
    m.outcome.mockImplementation(async () => { writtenFirst = written })
    vi.spyOn(service, 'processSingle').mockResolvedValue(answer({}))
    await expect(processOutboundSyncJob(job)).resolves.toMatchObject({ status: 'SUCCESS' })
    expect(m.outcome).toHaveBeenCalledTimes(1)
    expect(m.outcome).toHaveBeenCalledWith(expect.anything(), { channelListingId: 'l1', productId: 'p1', outcome: 'sent' })
    expect(writtenFirst).toBe(true)
  })

  it('a row that sent nothing (SKIPPED, dry run) tells the listing nothing', async () => {
    vi.spyOn(service, 'processSingle').mockResolvedValue(answer({ status: 'SKIPPED' }))
    await processOutboundSyncJob(job)
    vi.spyOn(service, 'processSingle').mockResolvedValue(answer({ dryRun: true }))
    await processOutboundSyncJob(job)
    expect(m.outcome).not.toHaveBeenCalled()
  })

  it('a non-retryable failure (dead-lettered): the listing is told "failed" with the error', async () => {
    vi.spyOn(service, 'processSingle').mockResolvedValue(answer({ success: false, status: 'FAILED', error: 'Price is not valid', retryable: false }))
    await processOutboundSyncJob(job)
    expect(m.update.mock.calls[0][0].data).toMatchObject({ syncStatus: 'FAILED', isDead: true })
    expect(m.outcome).toHaveBeenCalledWith(expect.anything(), { channelListingId: 'l1', productId: 'p1', outcome: 'failed', error: 'Price is not valid' })
  })

  it('a retryable failure with retries left tells the listing nothing (it is still on its way)', async () => {
    vi.spyOn(service, 'processSingle').mockResolvedValue(answer({ success: false, status: 'FAILED', error: 'Temporary error', retryable: true }))
    await expect(processOutboundSyncJob(job)).rejects.toThrow('Temporary error')
    expect(m.outcome).not.toHaveBeenCalled()
  })
})
