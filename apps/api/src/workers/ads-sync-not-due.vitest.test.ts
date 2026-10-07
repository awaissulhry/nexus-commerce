/**
 * W4-12 — a BullMQ job never sends an ad write before it is due.
 *
 * Until W4-12 every ad write's job id ("ads-sync:<row>") was refused by BullMQ, so only the drain sent writes, and the
 * drain selects a row only once its hold and its retry backoff have passed. Now the job runs too: it fires at the end of
 * the grace window, but a hold made longer since, or a retry's backoff, must still make it wait. The job leaves such a
 * row PENDING for the drain; a due row goes on to the gate.
 *
 * The worker's processor is taken from its BullMQ Worker (a stand-in that records it); the queue row is a stand-in read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  processor: null as null | ((job: unknown) => Promise<{ status: string; queueId: string }>),
  row: null as null | Record<string, unknown>,
  claims: 0,
}))

vi.mock('../lib/workspace-jobs.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  WorkspaceWorker: class {
    constructor(_name: string, processor: never) { state.processor = processor }
    on() { return this }
    close() { return Promise.resolve() }
  },
}))
vi.mock('../lib/queue.js', () => ({ redis: { connection: {} } }))
vi.mock('../db.js', () => ({
  default: {
    outboundSyncQueue: { findUnique: vi.fn(async () => state.row), update: vi.fn(async () => ({})) },
  },
}))
vi.mock('../services/advertising/ads-mutation.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  // Past the not-due check the worker serialises per entity first: count it as reaching the send path, then stop.
  claimEntityWrite: vi.fn(async () => { state.claims++; return false }),
}))

const { initializeAdsSyncWorker } = await import('./ads-sync.worker.js')

const job = { id: 'ads-sync-q-1', data: { queueId: 'q-1', syncType: 'AD_TARGET_UPDATE' } }
const minutes = (n: number) => new Date(Date.now() + n * 60_000)

describe('W4-12 — the ads-sync job and a write that is not due', () => {
  beforeEach(() => {
    state.claims = 0
    if (!state.processor) initializeAdsSyncWorker()
  })

  it('a hold made longer since the job was queued: left PENDING for the drain', async () => {
    state.row = { id: 'q-1', syncStatus: 'PENDING', holdUntil: minutes(3), nextRetryAt: null, payload: { entityType: 'AD_TARGET', entityId: 't-1' } }
    await expect(state.processor!(job)).resolves.toEqual({ status: 'NOT_DUE', queueId: 'q-1' })
    expect(state.claims).toBe(0)
  })

  it('a retry still in its backoff: left PENDING for the drain', async () => {
    state.row = { id: 'q-1', syncStatus: 'PENDING', holdUntil: minutes(-6), nextRetryAt: minutes(2), payload: { entityType: 'AD_TARGET', entityId: 't-1' } }
    await expect(state.processor!(job)).resolves.toEqual({ status: 'NOT_DUE', queueId: 'q-1' })
    expect(state.claims).toBe(0)
  })

  it('a due row goes on toward the send (control)', async () => {
    state.row = { id: 'q-1', syncStatus: 'PENDING', holdUntil: minutes(-1), nextRetryAt: null, payload: { entityType: 'AD_TARGET', entityId: 't-1' } }
    // The stand-in claim says another write is in flight, so it defers here: past the not-due check.
    await expect(state.processor!(job)).resolves.toEqual({ status: 'DEFERRED', queueId: 'q-1' })
    expect(state.claims).toBe(1)
  })
})
