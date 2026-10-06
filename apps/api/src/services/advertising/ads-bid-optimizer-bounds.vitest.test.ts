/**
 * CC-4 — the Target ACoS rule's own Min/Max bid. The builders store `minBidEur` / `maxBidEur` on the rule ("the
 * algorithm never bids below Min or above Max") and the handler never read them.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))

import { clampProposalsToRuleBounds, type BidProposal } from './ads-bid-optimizer.service.js'

const p = (targetId: string, currentBidCents: number, proposedBidCents: number): BidProposal => ({
  targetId, expression: targetId, matchType: 'EXACT', currentBidCents, proposedBidCents, deltaCents: proposedBidCents - currentBidCents,
  acos: 0.5, spendCents: 1000, salesCents: 2000, clicks: 10, reason: 'acos', targetAcosUsed: 0.3, targetBasis: 'flat',
})

describe('CC-4 — clampProposalsToRuleBounds', () => {
  it('no bounds → proposals unchanged', () => {
    const list = [p('a', 50, 80)]
    expect(clampProposalsToRuleBounds(list, undefined, undefined)).toBe(list)
  })

  it('🔴 a raise above Max stops at Max; a cut below Min stops at Min; the delta follows', () => {
    const out = clampProposalsToRuleBounds([p('a', 50, 200), p('b', 100, 10)], 0.2, 1.5)
    expect(out.map((x) => [x.targetId, x.proposedBidCents, x.deltaCents])).toEqual([['a', 150, 100], ['b', 20, -80]])
    expect(out[0].reason).toContain('Max')
    expect(out[1].reason).toContain('Min')
  })

  it('a proposal that the bound brings back to the current bid is dropped (nothing to change)', () => {
    expect(clampProposalsToRuleBounds([p('a', 150, 200)], undefined, 1.5)).toEqual([])
  })

  it('inside the bounds → untouched', () => {
    const inside = p('a', 50, 80)
    expect(clampProposalsToRuleBounds([inside], 0.2, 1.5)).toEqual([inside])
  })
})
