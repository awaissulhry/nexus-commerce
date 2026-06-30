import { describe, it, expect, vi } from 'vitest'
import { coalescePendingQuantityRows } from './sync-coalesce.js'

describe('coalescePendingQuantityRows', () => {
  it('cancels prior PENDING QUANTITY_UPDATE rows for the given listings', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 3 })
    const tx = { outboundSyncQueue: { updateMany } }
    const n = await coalescePendingQuantityRows(tx, ['l1', 'l2'])
    expect(n).toBe(3)
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        channelListingId: { in: ['l1', 'l2'] },
        syncType: 'QUANTITY_UPDATE',
        syncStatus: 'PENDING',
      },
      data: { syncStatus: 'CANCELLED' },
    })
  })

  it('is a no-op (no query) for an empty listing set', async () => {
    const updateMany = vi.fn()
    const tx = { outboundSyncQueue: { updateMany } }
    const n = await coalescePendingQuantityRows(tx, [])
    expect(n).toBe(0)
    expect(updateMany).not.toHaveBeenCalled()
  })
})
