/**
 * E2 (D5, 2026-10-05) — a job that did not get its row writes nothing.
 *
 * `processSingle` answers `claim-lost` when another run won the PENDING → IN_PROGRESS compare-and-swap, and
 * `not-pending` when the row had already moved on by the time it looked (outbound-sync.service.ts, AS.5). That row
 * belongs to the run that has it — the cron backstop, or the Etsy lane sending it in one write with its listing's
 * other rows — and that run records its answer. Before this guard the losing job wrote PENDING/FAILED (and a retry
 * count, a dead letter, a listing status) over the winner's row. Every other answer is written exactly as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected outbound fetch') }))
  return {
    workerRead: vi.fn(), workerUpdate: vi.fn(),
    read: vi.fn(), update: vi.fn(), claim: vi.fn(),
    outcome: vi.fn(async () => undefined), emit: vi.fn(async () => undefined),
  }
})
// The service's client (processSingle) and the worker's own client are mocked apart, so a write by either shows.
vi.mock('../db.js', () => ({ default: { outboundSyncQueue: { findUnique: m.read, findMany: vi.fn(async () => []), update: m.update, updateMany: m.claim } } }))
vi.mock('@nexus/database', () => ({ prisma: { outboundSyncQueue: { findUnique: m.workerRead, update: m.workerUpdate } } }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, addJobSafely: vi.fn(), readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
vi.mock('../lib/workspace-jobs.js', () => ({ WorkspaceWorker: class { on() { return this } } }))
vi.mock('../services/product-event.service.js', () => ({ productEventService: { emit: m.emit } }))
vi.mock('../services/variation-sync-processor.service.js', () => ({ variationSyncProcessor: {} }))
vi.mock('../services/repricer.service.js', () => ({ calculateTargetPrice: vi.fn() }))
vi.mock('../services/listing-sync-outcome.js', () => ({ recordListingSyncOutcome: m.outcome }))

const { default: service } = await import('../services/outbound-sync.service.js')
const { processOutboundSyncJob, resetBullMQWorkerStats } = await import('./bullmq-sync.worker.js')

// No channelListingId on the job: the publishing-control read is not the subject here.
const job = { id: 'job-1', attemptsMade: 0, data: { queueId: 'q1', productId: 'p1', targetChannel: 'ETSY', syncType: 'QUANTITY_UPDATE' } } as any
const pendingRow = { id: 'q1', productId: 'p1', channelListingId: 'l1', targetChannel: 'ETSY', syncType: 'QUANTITY_UPDATE', syncStatus: 'PENDING', holdUntil: null, payload: {}, retryCount: 0, maxRetries: 3 }

beforeEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks(); resetBullMQWorkerStats()
  m.workerRead.mockResolvedValue(pendingRow)
  m.workerUpdate.mockResolvedValue({})
  m.update.mockResolvedValue({})
})

const nothingWritten = () => {
  expect(m.workerUpdate).not.toHaveBeenCalled()
  expect(m.update).not.toHaveBeenCalled()
  expect(m.outcome).not.toHaveBeenCalled()
  expect(m.emit).not.toHaveBeenCalled()
}

describe('E2 (D5) — the worker writes nothing over a row another run holds', () => {
  it('claim-lost: SKIPPED with the reason, and no row, retry count, dead letter or listing status written', async () => {
    vi.spyOn(service, 'processSingle').mockResolvedValue({ success: false, queueId: 'q1', channel: 'ETSY', status: 'SKIPPED', message: 'Lost dispatch claim (already being processed)', error: 'claim-lost' } as any)
    await expect(processOutboundSyncJob(job)).resolves.toEqual({ status: 'SKIPPED', queueId: 'q1', reason: 'Lost dispatch claim (already being processed)' })
    nothingWritten()
  })

  it('not-pending: SKIPPED with the reason, nothing written', async () => {
    vi.spyOn(service, 'processSingle').mockResolvedValue({ success: false, queueId: 'q1', channel: 'ETSY', status: 'SKIPPED', message: 'Not PENDING (IN_PROGRESS)', error: 'not-pending' } as any)
    await expect(processOutboundSyncJob(job)).resolves.toEqual({ status: 'SKIPPED', queueId: 'q1', reason: 'Not PENDING (IN_PROGRESS)' })
    nothingWritten()
  })

  it('through the real processSingle: the compare-and-swap lost after the worker read PENDING → nothing written', async () => {
    m.read.mockResolvedValue({ ...pendingRow, product: null, channelListing: null })
    m.claim.mockResolvedValue({ count: 0 })
    await expect(processOutboundSyncJob(job)).resolves.toMatchObject({ status: 'SKIPPED', queueId: 'q1', reason: 'Lost dispatch claim (already being processed)' })
    expect(m.claim).toHaveBeenCalledWith({ where: { id: 'q1', syncStatus: 'PENDING' }, data: { syncStatus: 'IN_PROGRESS' } })
    nothingWritten()
  })

  it('through the real processSingle: the row moved on (another run holds it IN_PROGRESS) → nothing written, no claim tried', async () => {
    m.read.mockResolvedValue({ ...pendingRow, syncStatus: 'IN_PROGRESS', product: null, channelListing: null })
    await expect(processOutboundSyncJob(job)).resolves.toMatchObject({ status: 'SKIPPED', reason: 'Not PENDING (IN_PROGRESS)' })
    expect(m.claim).not.toHaveBeenCalled()
    nothingWritten()
  })

  it('control: any other failure is still written as before (the guard is that narrow)', async () => {
    vi.spyOn(service, 'processSingle').mockResolvedValue({ success: false, queueId: 'q1', channel: 'ETSY', status: 'FAILED', message: 'Refused', error: 'Refused', errorCode: 'NO_PRICE', retryable: false } as any)
    await expect(processOutboundSyncJob(job)).resolves.toMatchObject({ status: 'FAILED', queueId: 'q1' })
    expect(m.workerUpdate).toHaveBeenCalledTimes(1)
    expect(m.workerUpdate.mock.calls[0][0].data).toMatchObject({ syncStatus: 'FAILED', errorCode: 'NO_PRICE', isDead: true })
    expect(m.outcome).toHaveBeenCalledWith(expect.anything(), { channelListingId: 'l1', productId: 'p1', outcome: 'failed', error: 'Refused' })
  })

  it('control: a SKIPPED success (nothing sent) is still written SKIPPED', async () => {
    vi.spyOn(service, 'processSingle').mockResolvedValue({ success: true, queueId: 'q1', channel: 'ETSY', status: 'SKIPPED', message: 'A newer change to this SKU went to Etsy in the same write.', errorCode: 'ETSY_SUPERSEDED' } as any)
    await expect(processOutboundSyncJob(job)).resolves.toMatchObject({ status: 'SKIPPED' })
    expect(m.workerUpdate.mock.calls[0][0].data).toMatchObject({ syncStatus: 'SKIPPED', errorCode: 'ETSY_SUPERSEDED', errorMessage: 'A newer change to this SKU went to Etsy in the same write.' })
  })
})
