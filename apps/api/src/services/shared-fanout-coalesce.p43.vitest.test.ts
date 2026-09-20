/**
 * P4.3e — the shared eBay fan-out coalesces its own superseded rows.
 *
 * Three propositions:
 *   A. the scope of the cancel — what it matches and, more importantly, what it
 *      must NOT match (another product's row on the same shared ItemID);
 *   B. the fan-out runs it, before the insert, for exactly the ItemIDs it is
 *      replacing;
 *   C. a narrowed run (`args.sku`) does not coalesce, because it cannot claim to
 *      supersede a row carrying the product's other SKUs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { coalescePendingSharedQuantityRows } from './sync-coalesce.js'
import { enqueueSharedTradingFanout } from './ebay-shared-fanout.service.js'
import { syncLedgerOf } from './sync-control-core.js'

// ── A. the cancel's scope ───────────────────────────────────────────────────
describe('P4.3e coalescePendingSharedQuantityRows', () => {
  const txWith = () => {
    const updateMany = vi.fn(async () => ({ count: 2 }))
    return { updateMany, tx: { outboundSyncQueue: { updateMany } } }
  }

  it('cancels only this product\'s PENDING shared quantity rows for the named ItemIDs', async () => {
    const { updateMany, tx } = txWith()
    expect(await coalescePendingSharedQuantityRows(tx as never, 'p-1', ['111', '222'])).toBe(2)
    expect(updateMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        productId: 'p-1',
        channelListingId: null,
        externalListingId: { in: ['111', '222'] },
        syncType: 'QUANTITY_UPDATE',
        syncStatus: 'PENDING',
      },
      data: { syncStatus: 'CANCELLED' },
    })
  })

  it('🔴 productId is part of the scope — one ItemID can carry several products\' SKUs', async () => {
    // Cancelling by ItemID alone would throw away another product's pending
    // update to the same shared listing. Assert the field is THERE, by value.
    const { updateMany, tx } = txWith()
    await coalescePendingSharedQuantityRows(tx as never, 'p-1', ['111'])
    expect(updateMany.mock.calls[0][0].where.productId).toBe('p-1')
  })

  it('🔴 channelListingId: null keeps it off the ChannelListing lane\'s rows', async () => {
    const { updateMany, tx } = txWith()
    await coalescePendingSharedQuantityRows(tx as never, 'p-1', ['111'])
    expect(updateMany.mock.calls[0][0].where.channelListingId).toBeNull()
  })

  it('it never touches an IN_PROGRESS row or a non-quantity row', async () => {
    const { updateMany, tx } = txWith()
    await coalescePendingSharedQuantityRows(tx as never, 'p-1', ['111'])
    expect(updateMany.mock.calls[0][0].where.syncStatus).toBe('PENDING')
    expect(updateMany.mock.calls[0][0].where.syncType).toBe('QUANTITY_UPDATE')
  })

  it.each([
    ['no item ids', 'p-1', []],
    ['blank item ids', 'p-1', ['', '   ']],
    ['no product', '', ['111']],
  ])('%s: writes nothing at all', async (_name, productId, itemIds) => {
    const { updateMany, tx } = txWith()
    expect(await coalescePendingSharedQuantityRows(tx as never, productId, itemIds)).toBe(0)
    expect(updateMany).not.toHaveBeenCalled()
  })

  it('duplicate ItemIDs are collapsed — one item, one entry', async () => {
    const { updateMany, tx } = txWith()
    await coalescePendingSharedQuantityRows(tx as never, 'p-1', ['111', '111', '222'])
    expect(updateMany.mock.calls[0][0].where.externalListingId.in).toEqual(['111', '222'])
  })
})

// ── B / C. the fan-out runs it ──────────────────────────────────────────────
const ledger = (available: number) => syncLedgerOf([{ locationCode: 'IT-MAIN', available, syncRoutes: [] }])

function mockDb(members: any[]) {
  const created: any[] = []
  const calls: string[] = []
  return {
    created, calls,
    sharedListingMembership: { findMany: vi.fn(async () => members) },
    outboundSyncQueue: {
      createMany: vi.fn(async ({ data }: any) => { calls.push('createMany'); created.push(...data); return { count: data.length } }),
      findMany: vi.fn(async () => created.map((_, i) => ({ id: `q${i}` }))),
      updateMany: vi.fn(async () => { calls.push('updateMany'); return { count: 1 } }),
    },
  }
}

const member = (sku: string, itemId: string, lastQtyPushed: number | null = null) => ({
  sku, itemId, marketplace: 'IT', productId: 'p-1', lastQtyPushed,
  followPool: true, stockBuffer: 0, pinnedQuantity: null,
})

describe('P4.3e: the fan-out coalesces before it inserts', () => {
  beforeEach(() => { vi.unstubAllEnvs() })

  it('cancels the superseded rows for exactly the ItemIDs it writes, BEFORE the insert', async () => {
    const db = mockDb([member('A', '111'), member('B', '222')])
    await enqueueSharedTradingFanout(db as never, {
      productId: 'p-1', holdUntil: new Date(), scLedger: ledger(5), uncountedIsZero: true,
    })
    // Order matters: cancelling AFTER the insert would cancel the fresh rows.
    expect(db.calls).toEqual(['updateMany', 'createMany'])
    const where = db.outboundSyncQueue.updateMany.mock.calls[0][0].where
    expect(where.productId).toBe('p-1')
    // cancel-scope == replace-scope: the ItemIDs cancelled are the ItemIDs written.
    expect([...where.externalListingId.in].sort()).toEqual(['111', '222'])
    expect([...db.created.map((r: any) => r.externalListingId)].sort()).toEqual(['111', '222'])
  })

  it('a run that writes NOTHING cancels nothing', async () => {
    // Every member already at its number → no rows → nothing to supersede.
    const db = mockDb([member('A', '111', 5)])
    await enqueueSharedTradingFanout(db as never, {
      productId: 'p-1', holdUntil: new Date(), scLedger: ledger(5), uncountedIsZero: true,
    })
    expect(db.calls).toEqual([])
    expect(db.outboundSyncQueue.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 a run narrowed to one SKU does NOT coalesce', async () => {
    // It covers only that SKU's memberships, so its row cannot claim to
    // supersede a pending row that may carry the product's other SKUs.
    const db = mockDb([member('A', '111')])
    await enqueueSharedTradingFanout(db as never, {
      productId: 'p-1', sku: 'A', holdUntil: new Date(), scLedger: ledger(5), uncountedIsZero: true,
    })
    expect(db.calls).toEqual(['createMany'])
    expect(db.outboundSyncQueue.updateMany).not.toHaveBeenCalled()
  })

  it('the kill-switch turns it off, and the insert still happens', async () => {
    vi.stubEnv('NEXUS_SYNC_ORDERING_V2', '0')
    const db = mockDb([member('A', '111')])
    await enqueueSharedTradingFanout(db as never, {
      productId: 'p-1', holdUntil: new Date(), scLedger: ledger(5), uncountedIsZero: true,
    })
    expect(db.calls).toEqual(['createMany'])
    vi.unstubAllEnvs()
  })
})
