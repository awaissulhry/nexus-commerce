/**
 * NAF.C — the three preview-only ads tools. Handlers are dry-run previews
 * (read-only); none has an execute, so an approved item cannot reach
 * Amazon by construction until Phase F. Hard denials (protected term,
 * already-negated, pinned) return ok:false so the gate never queues them
 * even if the critic were bypassed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db.js', () => ({
  default: {
    campaign: { findFirst: vi.fn() },
    adTarget: { findMany: vi.fn(), findUnique: vi.fn() },
    adKeywordProtection: { findMany: vi.fn() },
    amazonAdsSearchTerm: { aggregate: vi.fn() },
  },
}))

import prisma from '../../../db.js'
import { ADS_PROPOSE_TOOLS } from './ads-propose.tools.js'

const db = vi.mocked(prisma, true)
const byName = new Map(ADS_PROPOSE_TOOLS.map((t) => [t.name, t]))

beforeEach(() => {
  vi.clearAllMocks()
  db.campaign.findFirst.mockResolvedValue({
    id: 'c1',
    name: 'GALE | IT | Phrase',
    marketplace: 'IT',
    pinPlacement: false,
    pinBids: false,
    pinBudget: false,
    pinNote: null,
  } as never)
  db.adTarget.findMany.mockResolvedValue([] as never)
  db.adKeywordProtection.findMany.mockResolvedValue([] as never)
  db.amazonAdsSearchTerm.aggregate.mockResolvedValue({
    _sum: { impressions: 900, clicks: 25, costMicros: 42000000n, orders7d: 0 },
  } as never)
})

describe('registry shape', () => {
  it('registers exactly three preview-only advertising tools', () => {
    expect(ADS_PROPOSE_TOOLS).toHaveLength(3)
    for (const t of ADS_PROPOSE_TOOLS) {
      expect(t.category).toBe('advertising')
      expect(t.riskTier).toBe('high')
      expect(t.requiresApprovalDefault).toBe(true)
      expect(t.execute).toBeUndefined() // structural: nothing can reach Amazon
    }
    expect([...byName.keys()].sort()).toEqual([
      'create-negative-keyword',
      'graduate-keyword',
      'set-target-bid',
    ])
  })
})

describe('create-negative-keyword', () => {
  const args = {
    externalCampaignId: 'ec1',
    keywordText: 'giacca pelle',
    matchType: 'NEGATIVE_EXACT',
    scope: 'AD_GROUP',
    externalAdGroupId: 'eag1',
    marketplace: 'IT',
  }

  it('previews a clean negation with metrics and campaign context', async () => {
    const r = await byName.get('create-negative-keyword')!.handler(args, {})
    expect(r.ok).toBe(true)
    const p = r.preview as Record<string, unknown>
    expect(p.term).toBe('giacca pelle')
    expect(p.campaign).toMatchObject({ name: 'GALE | IT | Phrase' })
    expect((p.metrics as Record<string, unknown>).clicks).toBe(25)
    expect(p.protectedDenial).toBeNull()
    expect(p.alreadyNegated).toBe(false)
  })

  it('DENIES a whitelisted (protected) term, naming it', async () => {
    db.adKeywordProtection.findMany.mockResolvedValue([
      { term: 'Giacca  Pelle', isPrefix: false, matchType: null, reason: 'brand core term' },
    ] as never)
    const r = await byName.get('create-negative-keyword')!.handler(args, {})
    expect(r.ok).toBe(false)
    expect(r.error).toContain('giacca pelle')
    expect(r.error).toContain('brand core term')
  })

  it('DENIES when the term is already negated — read via isNegative, never expressionType', async () => {
    db.adTarget.findMany.mockResolvedValue([
      { expressionValue: 'GIACCA PELLE', negativeLevel: 'AD_GROUP' },
    ] as never)
    const r = await byName.get('create-negative-keyword')!.handler(args, {})
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/already negated/i)
    const where = db.adTarget.findMany.mock.calls[0]![0]!.where as Record<string, unknown>
    expect(where.isNegative).toBe(true)
    expect(JSON.stringify(where)).not.toContain('expressionType')
  })

  it('errors on an unknown campaign', async () => {
    db.campaign.findFirst.mockResolvedValue(null as never)
    const r = await byName.get('create-negative-keyword')!.handler(args, {})
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/campaign/i)
  })
})

describe('graduate-keyword', () => {
  const args = {
    query: 'motorrad jacke herren',
    sourceExternalCampaignId: 'ec1',
    sourceExternalAdGroupId: 'eag1',
  }

  it('previews with a suggested bid derived from real cost/clicks', async () => {
    const r = await byName.get('graduate-keyword')!.handler(args, {})
    expect(r.ok).toBe(true)
    const p = r.preview as Record<string, unknown>
    // 42000000 micros = 4200 cents / 25 clicks = 168c cpc
    expect(p.suggestedBidCents).toBe(168)
    expect(p.alreadyExact).toBe(false)
  })

  it('DENIES when the destination campaign has a bids pin', async () => {
    db.campaign.findFirst.mockResolvedValue({
      id: 'c1',
      name: 'Pinned',
      marketplace: 'IT',
      pinPlacement: false,
      pinBids: true,
      pinBudget: false,
      pinNote: 'operator holds bids here',
    } as never)
    const r = await byName.get('graduate-keyword')!.handler(args, {})
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/pin/i)
  })

  it('DENIES when an exact keyword already exists for the query', async () => {
    db.adTarget.findMany.mockResolvedValue([
      { expressionValue: 'Motorrad Jacke Herren', expressionType: 'EXACT' },
    ] as never)
    const r = await byName.get('graduate-keyword')!.handler(args, {})
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/already exists/i)
  })
})

describe('set-target-bid', () => {
  beforeEach(() => {
    db.adTarget.findUnique.mockResolvedValue({
      id: 't1',
      expressionValue: 'giacca moto',
      expressionType: 'EXACT',
      bidCents: 80,
      isNegative: false,
      adGroup: {
        campaign: {
          id: 'c1',
          name: 'GALE',
          pinPlacement: false,
          pinBids: false,
          pinBudget: false,
          pinNote: null,
        },
      },
    } as never)
  })

  it('previews the delta against the current bid', async () => {
    const r = await byName.get('set-target-bid')!.handler(
      { targetId: 't1', proposedBidCents: 60 },
      {},
    )
    expect(r.ok).toBe(true)
    const p = r.preview as Record<string, unknown>
    expect(p.currentBidCents).toBe(80)
    expect(p.proposedBidCents).toBe(60)
    expect(p.deltaCents).toBe(-20)
  })

  it('DENIES below the 5c floor', async () => {
    const r = await byName.get('set-target-bid')!.handler(
      { targetId: 't1', proposedBidCents: 3 },
      {},
    )
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/floor/i)
  })

  it('DENIES on a bids pin', async () => {
    db.adTarget.findUnique.mockResolvedValue({
      id: 't1',
      expressionValue: 'giacca moto',
      expressionType: 'EXACT',
      bidCents: 80,
      isNegative: false,
      adGroup: {
        campaign: { id: 'c1', name: 'Pinned', pinPlacement: false, pinBids: true, pinBudget: false, pinNote: 'held' },
      },
    } as never)
    const r = await byName.get('set-target-bid')!.handler(
      { targetId: 't1', proposedBidCents: 60 },
      {},
    )
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/pin/i)
  })
})
