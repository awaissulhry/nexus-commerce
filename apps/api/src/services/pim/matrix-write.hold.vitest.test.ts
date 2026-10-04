/**
 * Build shape v2 (P13) — the Matrix's "Push quantity now" and "Retry" send no quantity to a listing whose selling is
 * paused (Inactive: `offerClosedAt`, the product sheet's Pause offer or Amazon's market close), even when the read the
 * verb started from still said Follow: the store is asked again where the push is written. Positive control: the same
 * verb on a listing that is not paused queues its push.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MatrixRead } from '@nexus/shared/matrix-contract'
import { SELLING_PAUSED_SENTENCE } from '@nexus/shared/push-lock'

const m = vi.hoisted(() => ({
  read: vi.fn(),
  held: false,
  createRow: vi.fn(async () => ({ id: 'q-new', productId: 'c1', syncType: 'QUANTITY_UPDATE', holdUntil: null })),
  fire: vi.fn(async () => undefined),
  addJob: vi.fn(async () => null),
  failedRow: { id: 'q-failed', productId: 'c1', channelListingId: 'l-c1', targetChannel: 'EBAY', syncType: 'QUANTITY_UPDATE' },
  queueUpdate: vi.fn(async () => ({})),
}))
const listingRow = () => ({ id: 'l-c1', region: 'IT', externalListingId: '1234', marketplace: 'IT', channelConnectionId: 'acc', offerClosedAt: m.held ? new Date() : null })
vi.mock('../../db.js', () => ({
  default: {
    $transaction: async (work: (tx: unknown) => unknown) => work({
      channelListing: { updateMany: async () => ({ count: 1 }), findMany: async () => [listingRow()], findUnique: async () => ({ version: 3 }) },
    }),
    channelListing: {
      updateMany: async () => ({ count: 1 }),
      findFirst: async (args: { where: { offerClosedAt?: unknown } }) => (args.where.offerClosedAt && m.held ? { id: 'l-c1' } : null),
    },
    outboundSyncQueue: { findFirst: async () => m.failedRow, update: (...a: unknown[]) => m.queueUpdate(...(a as [])) },
    bulkOperation: { create: async () => ({ id: 'op', createdAt: new Date('2026-10-04T00:00:00Z') }) },
    stockPoolLink: { findFirst: async () => null },
  },
}))
vi.mock('../outbound-rows.js', () => ({ createOutboundRow: (...a: unknown[]) => m.createRow(...(a as [])) }))
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: (...a: unknown[]) => m.fire(...(a as [])) }))
vi.mock('../../lib/queue.js', () => ({ addJobSafely: (...a: unknown[]) => m.addJob(...(a as [])), outboundSyncQueue: null }))
vi.mock('../sync-coalesce.js', () => ({ coalescePendingQuantityRows: async () => 0 }))
vi.mock('../follow-master.service.js', () => ({ setFollowMasterQuantity: vi.fn(), setStockBuffer: vi.fn(), amazonManagedListingIds: async () => new Set<string>() }))
vi.mock('../stock-movement.service.js', () => ({ recascadeAfterSyncControlChange: vi.fn() }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshMany: async () => undefined } }))
vi.mock('./fulfillment-method.service.js', () => ({ setFulfillmentMethod: vi.fn() }))
vi.mock('./channel-price-write.service.js', () => ({ writeChannelPrices: vi.fn() }))
vi.mock('./matrix.service.js', () => ({ getMatrixRead: (...a: unknown[]) => m.read(...(a as [])) }))

import { runMatrixVerb } from './matrix-write.service.js'

/** One eBay IT variant that the read says follows the stock (10), last push failed — so both verbs offer a change. */
const read = (): MatrixRead => ({
  version: 1, productId: 'root', source: 'live', generatedAt: '2026-10-04T00:00:00.000Z', policies: [],
  coordinates: [
    { key: 'EBAY:IT', kind: 'market', channel: 'EBAY', market: 'IT', label: 'eBay · IT', region: 'EU', alias: null, accountId: 'acc', currency: 'EUR', connected: true, listed: 1, draft: 0, cells: ['listing', 'syncMode', 'syncQty', 'syncBuffer', 'syncState', 'price'], absent: [], sharedInventoryWith: null, inventoryOn: null, vocabulary: {} },
  ],
  rows: [
    { id: 'c1', sku: 'TEST-SKU-HOLD-1', role: 'variant', stock: { available: 10, uncounted: false, locations: [{ code: 'IT-MAIN', available: 10 }] }, basePrice: 100, status: 'ACTIVE', cells: {
      'EBAY:IT': { listingId: 'l-c1', version: 3, listing: { state: 'listed', externalId: '1234', detail: null, published: true }, fulfilment: null,
        sync: { kind: 'FOLLOW', via: null, mode: 'FOLLOW', intended: 10, held: 10, buffer: 0, poolAvailable: 10, routedLocations: ['IT-MAIN'], fbaAtAmazon: null, oversold: false },
        queue: { state: 'failed', at: '2026-10-04T00:00:00.000Z', reason: 'timeout', syncType: 'QUANTITY_UPDATE', via: null },
        price: null, sale: null, writable: { syncMode: true, syncQty: true, syncBuffer: true }, writeBlockedReason: {} },
    } },
  ],
} as unknown as MatrixRead)

const ctx = { productId: 'root', actor: 'person@example.test', can: () => true }
const run = (verb: 'push-now' | 'retry-sync') => runMatrixVerb(ctx, { params: { verb }, targets: [{ rowId: 'c1', coordinateKey: 'EBAY:IT' }], commit: true }) as
  Promise<{ results: Array<{ outcome: string; reason?: string }> }>

beforeEach(() => {
  vi.clearAllMocks()
  m.read.mockImplementation(async () => read())
  m.held = false
})

describe('Push quantity now', () => {
  it('sends nothing to a listing paused after the read: refused with the plain sentence, no push row, no job', async () => {
    m.held = true
    const out = await run('push-now')
    expect(out.results).toEqual([expect.objectContaining({ outcome: 'refused', reason: SELLING_PAUSED_SENTENCE })])
    expect(m.createRow).not.toHaveBeenCalled()
    expect(m.fire).not.toHaveBeenCalled()
  })
  it('control: a listing that is not paused gets its push queued', async () => {
    const out = await run('push-now')
    expect(out.results).toEqual([expect.objectContaining({ outcome: 'applied' })])
    expect(m.createRow).toHaveBeenCalledTimes(1)
    expect(m.fire).toHaveBeenCalledTimes(1)
  })
})

describe('Retry', () => {
  it('does not re-queue the failed push of a paused listing', async () => {
    m.held = true
    const out = await run('retry-sync')
    expect(out.results).toEqual([expect.objectContaining({ outcome: 'refused', reason: SELLING_PAUSED_SENTENCE })])
    expect(m.queueUpdate).not.toHaveBeenCalled()
    expect(m.addJob).not.toHaveBeenCalled()
  })
  it('control: a listing that is not paused gets its failed push re-queued', async () => {
    const out = await run('retry-sync')
    expect(out.results).toEqual([expect.objectContaining({ outcome: 'applied' })])
    expect(m.queueUpdate).toHaveBeenCalledTimes(1)
    expect(m.addJob).toHaveBeenCalledTimes(1)
  })
})
