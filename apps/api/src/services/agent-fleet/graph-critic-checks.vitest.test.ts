/**
 * NAF.H — H2 acceptance: the critic catches a SEEDED self-competition
 * case the pairwise same-term check cannot see — a CANNIBALIZES edge
 * between campaigns with zero literal keyword overlap. Structural, from
 * the graph; adTarget is never consulted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    campaign: { findMany: vi.fn() },
    graphEdge: { findMany: vi.fn() },
    product: { findMany: vi.fn() },
  },
}))

import prisma from '../../db.js'
import { computeGraphAdvisories } from './graph-critic-checks.js'

const db = vi.mocked(prisma, true)

const ITEM = {
  findingId: 'f1',
  rank: 1,
  tool: 'graduate-keyword',
  args: { query: 'motorrad jacke herren', bidCents: 25, sourceExternalCampaignId: 'ext-1' },
  expectedEffect: { metric: 'sales', direction: 'increase', magnitudePct: 5, horizonDays: 30, basis: 't' },
  dependsOn: [],
  reversible: true,
} as never

beforeEach(() => {
  vi.clearAllMocks()
  db.campaign.findMany.mockResolvedValue([
    { id: 'c1', name: 'DE Broad', externalCampaignId: 'ext-1' },
  ] as never)
  db.graphEdge.findMany.mockResolvedValue([] as never)
  db.product.findMany.mockResolvedValue([] as never)
})

describe('computeGraphAdvisories', () => {
  it('SEEDED: a CANNIBALIZES edge fires no_self_competition with NO term overlap', async () => {
    db.graphEdge.findMany.mockImplementation((async (args: {
      where: { relation: { in: string[] } }
    }) => {
      if (args.where.relation.in.includes('CANNIBALIZES')) {
        return [
          {
            fromType: 'campaign',
            fromId: 'c1',
            toType: 'campaign',
            toId: 'c2',
            relation: 'CANNIBALIZES',
            weight: null,
            // the shared intent was found via normalisation upstream —
            // no literal term appears in any enabled target of c1
            properties: { on: 'kw:motorradjacke|EXACT' },
          },
        ]
      }
      return []
    }) as never)

    const advisories = await computeGraphAdvisories([ITEM] as never)
    const selfComp = advisories.filter((a) => a.check === 'no_self_competition')
    expect(selfComp).toHaveLength(1)
    expect(selfComp[0]!.findingId).toBe('f1')
    expect(selfComp[0]!.note).toContain('cannibalizes campaign c2')
    expect(selfComp[0]!.note).toContain('structural')
  })

  it('zero pooled stock fires inventory_supports_spend', async () => {
    db.graphEdge.findMany.mockImplementation((async (args: {
      where: { relation: { in: string[] } }
    }) => {
      if (args.where.relation.in.includes('TARGETS')) {
        return [
          { fromType: 'campaign', fromId: 'c1', toType: 'product', toId: 'p1', relation: 'TARGETS', weight: null, properties: {} },
          { fromType: 'campaign', fromId: 'c1', toType: 'product', toId: 'p2', relation: 'TARGETS', weight: null, properties: {} },
        ]
      }
      return []
    }) as never)
    db.product.findMany.mockResolvedValue([{ totalStock: 0 }, { totalStock: 0 }] as never)

    const advisories = await computeGraphAdvisories([ITEM] as never)
    const inv = advisories.filter((a) => a.check === 'inventory_supports_spend')
    expect(inv).toHaveLength(1)
    expect(inv[0]!.note).toContain('ZERO stock')
  })

  it('an empty graph yields no advisories — never a fabricated concern', async () => {
    const advisories = await computeGraphAdvisories([ITEM] as never)
    expect(advisories).toHaveLength(0)
  })

  it('items with no campaign reference are skipped without queries', async () => {
    const bidItem = { ...(ITEM as Record<string, unknown>), args: { targetId: 't1', proposedBidCents: 30 } }
    const advisories = await computeGraphAdvisories([bidItem] as never)
    expect(advisories).toHaveLength(0)
    expect(db.campaign.findMany).not.toHaveBeenCalled()
  })
})
