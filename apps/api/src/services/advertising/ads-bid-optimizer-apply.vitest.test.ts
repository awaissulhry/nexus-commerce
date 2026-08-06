/**
 * Pre-F fix (NAF V9): applyBidOptimization must speak
 * bulkUpdateAdTargetBids' actual contract ({entries: [{adTargetId,
 * bidCents}]}, namespaced AdsActor) — the old call passed {updates}
 * under `as never` and crashed on entries.length before writing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))
vi.mock('./ads-mutation.service.js', () => ({
  bulkUpdateAdTargetBids: vi.fn(),
}))

import { bulkUpdateAdTargetBids } from './ads-mutation.service.js'
import { applyBidOptimization } from './ads-bid-optimizer.service.js'

const bulk = vi.mocked(bulkUpdateAdTargetBids)

beforeEach(() => {
  vi.clearAllMocks()
  bulk.mockResolvedValue({ applied: 2, skipped: 0, failed: 0, outcomes: [], chunks: 1 } as never)
})

describe('applyBidOptimization', () => {
  it('maps changes into the bulk contract and namespaces the actor', async () => {
    const out = await applyBidOptimization({
      changes: [
        { targetId: 't1', proposedBidCents: 30 },
        { targetId: 't2', proposedBidCents: 45 },
      ],
    })
    expect(bulk).toHaveBeenCalledWith({
      entries: [
        { adTargetId: 't1', bidCents: 30 },
        { adTargetId: 't2', bidCents: 45 },
      ],
      actor: 'automation:bid-optimizer',
      reason: 'AX.8 target-ACOS optimization',
    })
    expect(out).toEqual({ applied: 2, dryRun: false })
  })

  it('passes a user: actor through untouched', async () => {
    await applyBidOptimization({
      changes: [{ targetId: 't1', proposedBidCents: 30 }],
      actor: 'user:u42',
    })
    expect(bulk.mock.calls[0]![0]!.actor).toBe('user:u42')
  })

  it('dry-run writes nothing', async () => {
    const out = await applyBidOptimization({
      changes: [{ targetId: 't1', proposedBidCents: 30 }],
      dryRun: true,
    })
    expect(out).toEqual({ applied: 0, dryRun: true })
    expect(bulk).not.toHaveBeenCalled()
  })

  it('reports the gate-verdict counts, not the request size', async () => {
    bulk.mockResolvedValue({ applied: 1, skipped: 1, failed: 0, outcomes: [], chunks: 1 } as never)
    const out = await applyBidOptimization({
      changes: [
        { targetId: 't1', proposedBidCents: 30 },
        { targetId: 't2', proposedBidCents: 45 },
      ],
    })
    expect(out.applied).toBe(1)
  })
})
