/**
 * NAF.B — the three analyst evidence builders. Engines are mocked at module
 * boundaries; the tests pin the honesty contract: caps applied AND counted,
 * `isNegative`-only filtering (never expressionType), `source:'daily'`
 * passed explicitly, overlap caveat present, account-scope declared, and
 * dataVintage derived from the underlying data's max(date)+24h.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db.js', () => ({
  default: {
    adTarget: { findMany: vi.fn() },
    amazonAdsSearchTerm: { aggregate: vi.fn() },
    amazonAdsDailyPerformance: { aggregate: vi.fn() },
    productProfitDaily: { groupBy: vi.fn() },
  },
}))
vi.mock('../../advertising/ads-harvest.service.js', () => ({
  previewHarvest: vi.fn(),
}))
vi.mock('../../advertising/ads-ngram.service.js', () => ({
  analyzeNgrams: vi.fn(),
}))
vi.mock('../../advertising/ads-bid-optimizer.service.js', () => ({
  previewBidOptimization: vi.fn(),
}))
vi.mock('../../advertising/ads-target-acos.service.js', () => ({
  computeProductTargetAcos: vi.fn(),
}))

import prisma from '../../../db.js'
import { previewBidOptimization } from '../../advertising/ads-bid-optimizer.service.js'
import { previewHarvest } from '../../advertising/ads-harvest.service.js'
import { analyzeNgrams } from '../../advertising/ads-ngram.service.js'
import { computeProductTargetAcos } from '../../advertising/ads-target-acos.service.js'
import { bidProposalsBuilder } from './bid-proposals.observation.js'
import { harvestCandidatesBuilder } from './harvest-candidates.observation.js'
import { negativeCandidatesBuilder } from './negative-candidates.observation.js'

const db = vi.mocked(prisma, true)
const harvest = vi.mocked(previewHarvest)
const ngrams = vi.mocked(analyzeNgrams)
const bids = vi.mocked(previewBidOptimization)
const productAcos = vi.mocked(computeProductTargetAcos)

const YESTERDAY = new Date(Date.now() - 20 * 3600_000)

function negCandidate(i: number) {
  return {
    query: `waste term ${i}`,
    externalCampaignId: `ec${i}`,
    externalAdGroupId: `eag${i}`,
    impressions: 1000,
    clicks: 30,
    costCents: 5000 - i,
    orders: 0,
    salesCents: 0,
  }
}
function gradCandidate(i: number) {
  return { ...negCandidate(i), orders: 3, salesCents: 9000 }
}

beforeEach(() => {
  vi.clearAllMocks()
  db.amazonAdsSearchTerm.aggregate.mockResolvedValue({
    _max: { date: YESTERDAY },
  } as never)
  db.amazonAdsDailyPerformance.aggregate.mockResolvedValue({
    _max: { date: YESTERDAY },
  } as never)
  db.adTarget.findMany.mockResolvedValue([
    { expressionValue: 'waste term 1', negativeLevel: 'AD_GROUP' },
  ] as never)
  harvest.mockResolvedValue({
    negatives: Array.from({ length: 40 }, (_, i) => negCandidate(i)),
    productNegatives: Array.from({ length: 15 }, (_, i) => negCandidate(100 + i)),
    graduations: Array.from({ length: 40 }, (_, i) => gradCandidate(i)),
    productGraduations: Array.from({ length: 15 }, (_, i) => gradCandidate(100 + i)),
    windowDays: 60,
  } as never)
  ngrams.mockResolvedValue({
    windowDays: 60,
    winning: [],
    wasteful: Array.from({ length: 30 }, (_, i) => ({
      gram: `gram${i}`,
      n: 1,
      terms: 4,
      impressions: 500,
      clicks: 10,
      costCents: 900 - i,
      orders: 0,
      salesCents: 0,
      acos: null,
      roas: null,
    })),
  } as never)
  bids.mockResolvedValue({
    targetAcos: 0.3,
    profitMode: true,
    bayesian: true,
    proposals: Array.from({ length: 60 }, (_, i) => ({
      targetId: `t${i}`,
      expression: `kw ${i}`,
      matchType: 'EXACT',
      currentBidCents: 50,
      proposedBidCents: 50 + (60 - i),
      deltaCents: 60 - i,
      acos: 0.5,
      spendCents: 1000,
      salesCents: 2000,
      clicks: 20,
      reason: 'acos above target',
      targetAcosUsed: 0.3,
      targetBasis: 'bayesian' as const,
    })),
  } as never)
  db.productProfitDaily.groupBy.mockResolvedValue([
    { productId: 'p1', _sum: { grossRevenueCents: 100000 } },
  ] as never)
  productAcos.mockResolvedValue({
    productId: 'p1',
    marketplace: 'IT',
    windowDays: 30,
    dataPoints: 10,
    basis: 'fallback',
    breakevenAcos: null,
    targetAcos: 0.3,
    marginPct: null,
    tacos: null,
    tacop: null,
    grossRevenueCents: 100000,
    adSpendCents: 5000,
    trueProfitCents: null,
  } as never)
})

describe('negative-candidates', () => {
  it('caps lists, counts trims, and states the overlap caveat + account scope', async () => {
    const { payload, dataVintage } = await negativeCandidatesBuilder.build({})
    const p = payload as Record<string, never> & {
      scope: string
      negatives: unknown[]
      productNegatives: unknown[]
      ngramWasteful: unknown[]
      counts: Record<string, number>
      caveats: string[]
    }
    expect(p.scope).toBe('account')
    expect(p.negatives.length).toBe(25)
    expect(p.productNegatives.length).toBe(10)
    expect(p.ngramWasteful.length).toBe(15)
    expect(p.counts.negativesTotal).toBe(40)
    expect(p.counts.negativesTrimmed).toBe(15)
    expect(p.caveats.join(' ')).toMatch(/overlap/i)
    // vintage = end of covered day (max(date) + 24h)
    expect(dataVintage.getTime()).toBe(YESTERDAY.getTime() + 24 * 3600_000)
  })

  it('queries existing negatives with isNegative only — never expressionType', async () => {
    await negativeCandidatesBuilder.build({})
    expect(db.adTarget.findMany).toHaveBeenCalledTimes(1)
    const where = db.adTarget.findMany.mock.calls[0]![0]!.where as Record<string, unknown>
    expect(where.isNegative).toBe(true)
    expect(JSON.stringify(where)).not.toContain('expressionType')
  })
})

describe('harvest-candidates', () => {
  it('caps graduations and counts trims', async () => {
    const { payload } = await harvestCandidatesBuilder.build({})
    const p = payload as { graduations: unknown[]; productGraduations: unknown[]; counts: Record<string, number> }
    expect(p.graduations.length).toBe(25)
    expect(p.productGraduations.length).toBe(10)
    expect(p.counts.graduationsTotal).toBe(40)
  })
})

describe('bid-proposals', () => {
  it('passes profitMode+bayesian+source:daily explicitly and caps by |delta|', async () => {
    const { payload } = await bidProposalsBuilder.build({})
    expect(bids).toHaveBeenCalledWith(
      expect.objectContaining({ profitMode: true, bayesian: true, source: 'daily' }),
    )
    const p = payload as { proposals: Array<{ deltaCents: number }>; counts: Record<string, number>; targetAcosSummary: { byBasis: Record<string, number> } }
    expect(p.proposals.length).toBe(25)
    // sorted by |delta| desc — first is the biggest mover
    expect(p.proposals[0]!.deltaCents).toBe(60)
    expect(p.counts.proposalsTotal).toBe(60)
    // basis carried verbatim, counted
    expect(p.targetAcosSummary.byBasis.fallback).toBe(1)
    // bounded: exactly one engine call per top-revenue product (10 max)
    expect(productAcos).toHaveBeenCalledTimes(1)
  })
})
