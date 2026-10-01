/**
 * The BullMQ worker never rewrites a listing's price (2026-10-01, "pricing rules reach the channels").
 *
 * 🔴 WHAT THIS GUARDS. On a job that carries `channelListingId` (the queue page's retries, the matrix's retry) the
 * worker ran a "PHASE 28 pricing calculation": it stored `repricer.calculateTargetPrice` — a cost-margin floor no edit
 * applies, MATCH_AMAZON read as the master — into `ChannelListing.price`, while the dispatch sends the row's own
 * `payload.price`. Nexus then held a price the channel was never sent. A following listing's price is computed when it
 * changes (the master-price cascade and the channel price door, one rule set); the worker only sends the row.
 *
 * The real repricer is loaded on purpose: with it, the old code wrote 11.4 (cost 9.50 + 20% margin) over the 11.00
 * the row sends.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected outbound fetch') }))
  return { readRow: vi.fn(), updateRow: vi.fn(), readListing: vi.fn(), writeListing: vi.fn(), readProduct: vi.fn() }
})
const client = {
  outboundSyncQueue: { findUnique: m.readRow, update: m.updateRow, findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 1 })) },
  channelListing: { findUnique: m.readListing, update: m.writeListing, updateMany: m.writeListing },
  product: { findUnique: m.readProduct },
}
vi.mock('../db.js', () => ({ default: client }))
vi.mock('@nexus/database', () => ({ prisma: client }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, addJobSafely: vi.fn(), readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
vi.mock('../lib/workspace-jobs.js', () => ({ WorkspaceWorker: class { on() { return this } } }))
vi.mock('../services/product-event.service.js', () => ({ productEventService: { emit: vi.fn(async () => undefined) } }))
vi.mock('../services/variation-sync-processor.service.js', () => ({ variationSyncProcessor: {} }))

let service: typeof import('../services/outbound-sync.service.js').default
let worker: typeof import('./bullmq-sync.worker.js')
beforeAll(async () => {
  service = (await import('../services/outbound-sync.service.js')).default
  worker = await import('./bullmq-sync.worker.js')
})

beforeEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks(); worker.resetBullMQWorkerStats()
  m.readRow.mockResolvedValue({ id: 'q-retry', productId: 'p-1', channelListingId: 'cl-1', targetChannel: 'EBAY', syncType: 'PRICE_UPDATE', syncStatus: 'PENDING',
    payload: { price: 11 }, retryCount: 1, maxRetries: 3 })
  m.updateRow.mockResolvedValue({})
  // A listing following master 10 at +10% (so 11.00), on a product whose cost (9.50) + 20% margin is 11.40.
  m.readListing.mockResolvedValue({ id: 'cl-1', isPublished: true, offers: [], pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10,
    priceOverride: null, followMasterPrice: true, price: 11 })
  m.readProduct.mockResolvedValue({ basePrice: 10, costPrice: 9.5, minMargin: 20 })
})

describe('the worker sends the row; it never stores a price of its own', () => {
  it('🔴 a retry job naming its listing does not write ChannelListing.price', async () => {
    vi.spyOn(service, 'processSingle').mockResolvedValue({ success: true, queueId: 'q-retry', channel: 'EBAY', status: 'SUCCESS', message: 'ok' } as any)
    const job = { id: 'cl-1:PRICE_UPDATE:retry:1', attemptsMade: 0, data: { queueId: 'q-retry', productId: 'p-1', channelListingId: 'cl-1', targetChannel: 'EBAY', syncType: 'PRICE_UPDATE' } } as any
    await expect(worker.processOutboundSyncJob(job)).resolves.toMatchObject({ status: 'SUCCESS', queueId: 'q-retry' })
    expect(service.processSingle).toHaveBeenCalledWith('q-retry')
    const priceWrites = m.writeListing.mock.calls.filter(([args]) => args?.data && 'price' in args.data)
    expect(priceWrites).toEqual([])
  })
})
