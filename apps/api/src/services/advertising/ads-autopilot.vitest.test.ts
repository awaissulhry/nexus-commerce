import { describe, it, expect } from 'vitest'
import { describeBidProposal, summarizeAutopilotPlan } from './ads-autopilot.service.js'
import type { BidProposal } from './ads-bid-optimizer.service.js'
import type { DefendTosResult } from './ads-top-of-search.service.js'

const mkBid = (over: Partial<BidProposal>): BidProposal => ({
  targetId: 't1', expression: 'giacca moto pelle', matchType: 'EXACT',
  currentBidCents: 34, proposedBidCents: 29, deltaCents: -5,
  acos: 0.45, spendCents: 1000, salesCents: 2200, clicks: 40, reason: 'x',
  targetAcosUsed: 0.26, targetBasis: 'profit', ...over,
})
const emptyTos: DefendTosResult = { evaluated: 0, changed: 0, applied: 0, skippedNotAllowlisted: 0, dryRun: true, sample: [] }

describe('describeBidProposal', () => {
  it('says Lower when the bid drops, with profit framing + €-delta', () => {
    const a = describeBidProposal(mkBid({ currentBidCents: 34, proposedBidCents: 29, targetBasis: 'profit' }))
    expect(a.kind).toBe('bid')
    expect(a.summary.startsWith('Lower')).toBe(true)
    expect(a.summary).toContain('profit')
    expect(a.deltaLabel).toBe('€0.34 → €0.29')
  })
  it('says Raise when the bid increases', () => {
    const a = describeBidProposal(mkBid({ currentBidCents: 20, proposedBidCents: 25 }))
    expect(a.summary.startsWith('Raise')).toBe(true)
  })
  it('uses sparse-data framing for a bayesian basis', () => {
    const a = describeBidProposal(mkBid({ targetBasis: 'bayesian' }))
    expect(a.summary.toLowerCase()).toContain('sparse')
  })
})

describe('summarizeAutopilotPlan', () => {
  it('headline counts both bid + top-of-search changes', () => {
    const tos: DefendTosResult = { evaluated: 5, changed: 2, applied: 0, skippedNotAllowlisted: 0, dryRun: true, sample: [
      { campaign: 'BMM_Misano', fromPct: 25, toPct: 40, action: 'raise', reason: 'converts' },
      { campaign: 'Gale Exact', fromPct: 60, toPct: 45, action: 'lower', reason: 'over target' },
    ] }
    const plan = summarizeAutopilotPlan('profit', [mkBid({}), mkBid({ targetId: 't2', expression: 'casco' })], tos)
    expect(plan.counts.bidChanges).toBe(2)
    expect(plan.counts.topOfSearchChanges).toBe(2)
    expect(plan.actions).toHaveLength(4)
    expect(plan.headline).toContain('2 keyword bids')
    expect(plan.headline).toContain('2 top-of-search')
    expect(plan.northStar.mode).toBe('profit')
  })

  it('empty plan reads reassuringly, not as an error', () => {
    const plan = summarizeAutopilotPlan('balanced', [], emptyTos)
    expect(plan.counts.bidChanges).toBe(0)
    expect(plan.headline.toLowerCase()).toContain('nothing to change')
    expect(plan.actions).toHaveLength(0)
  })

  it('growth vs profit mode changes the headline intent', () => {
    const g = summarizeAutopilotPlan('growth', [mkBid({})], emptyTos)
    const p = summarizeAutopilotPlan('profit', [mkBid({})], emptyTos)
    expect(g.headline).toContain('grow sales')
    expect(p.headline).toContain('protect profit')
  })
})
