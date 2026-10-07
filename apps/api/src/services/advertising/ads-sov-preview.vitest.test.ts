/**
 * The Share-of-Voice draft preview with NO campaigns picked.
 *
 * 🔴 Measured 2026-10-07: a dry run of the IT rule "Share of Voice < 10 %, ACOS ≤ 20 %, Orders ≥ 1 →
 * +10 %" on one portfolio, with no campaign picker, answered `selected: 0, matched: 0`
 * without building a single context — while the engine reads an empty picker as "no restriction" and
 * would act on every keyword in the market and portfolio. The preview now runs over that scope.
 *
 * Only the database, the SOV context builder, the share reader and the bid handler are stand-ins; the
 * translation, the conditions and the scope matcher are the engine's own.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  buildSovBidContexts: vi.fn(),
  bidApply: vi.fn(),
  count: vi.fn(),
  campaigns: vi.fn(),
}))

vi.mock('../../db.js', () => ({
  default: {
    adTarget: {
      count: h.count,
      findMany: vi.fn(async ({ where }: any) => (where.id.in as string[]).map((id) => ({
        id, expressionValue: `kw ${id}`, expressionType: 'EXACT', bidCents: 50, status: 'ENABLED', suppressedFromBidCents: null,
        adGroup: { campaign: { id: id.startsWith('de') ? 'c-de' : id.startsWith('x') ? 'c-other' : 'c-gale', name: 'n' } },
      }))),
    },
    // Two readers: the portfolio scope (id → portfolioId) and the suppressed-campaign check.
    campaign: { findMany: vi.fn(async (args: any) => (args.where.bidsSuppressedAt ? [] : h.campaigns(args))) },
  },
}))
vi.mock('../../jobs/advertising-rule-evaluator.job.js', () => ({ buildSovBidContexts: h.buildSovBidContexts, buildCampaignBudgetContexts: vi.fn(async () => []) }))
vi.mock('./ads-sov-keyword-share.service.js', () => ({ keywordMarketShares: vi.fn(async () => ({ byKey: new Map(), periods: [], measuredMarkets: [] })) }))
vi.mock('../automation-rule.service.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ACTION_HANDLERS: { bid_apply: h.bidApply } as Record<string, unknown>,
}))
vi.mock('./automation-action-handlers.js', () => ({}))

import { previewSovRule } from './ads-sov-preview.service.js'

const PORTFOLIO = 'pf-gale-it'
const ctx = (id: string, campaignId: string, marketplace: string, sovPct: number, acos: number | undefined, orders: number) => ({
  trigger: 'SOV_BID', marketplace, campaign: { id: campaignId }, adGroup: { id: `ag-${id}` },
  adTarget: { id, sovPct, orders, spendCents: 1000, salesCents: acos ? Math.round(1000 / acos) : 0, ...(acos != null ? { acos } : {}) },
})

/** The live rule in the builder's shape, with no campaign picker. */
const draft = (over: Record<string, unknown> = {}) => ({
  actions: [{ type: 'sov', bidCeiling: 0.8 }],
  conditions: [{
    match: 'all',
    action: { op: 'incPct', value: '10' },
    conditions: [
      { metric: 'Share of Voice', op: 'lt', value: '10' },
      { metric: 'ACOS', op: 'lte', value: '20' },
      { metric: 'Orders', op: 'gte', value: '1' },
    ],
  }],
  scopeMarketplace: 'IT',
  scopePortfolioId: PORTFOLIO,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.count.mockResolvedValue(3)
  h.campaigns.mockResolvedValue([
    { id: 'c-gale', portfolioId: PORTFOLIO }, { id: 'c-de', portfolioId: PORTFOLIO }, { id: 'c-other', portfolioId: '999' },
  ])
  h.buildSovBidContexts.mockResolvedValue([
    ctx('g1', 'c-gale', 'IT', 0.04, 0.1, 3),   // fires
    ctx('g2', 'c-gale', 'IT', 0.25, 0.1, 3),   // share too high
    ctx('g3', 'c-gale', 'IT', 0.04, undefined, 0), // no sales: acos absent
    ctx('de1', 'c-de', 'DE', 0.04, 0.1, 3),    // other market
    ctx('x1', 'c-other', 'IT', 0.04, 0.1, 3),  // other portfolio
  ])
  h.bidApply.mockImplementation(async (a: Record<string, unknown>) => ({ ok: true, output: { dryRun: true, adTargetId: a.adTargetId, wouldChange: '50¢ → 55¢' } }))
})

describe('SOV preview — no picks means the rule\'s scope, as the engine reads it', () => {
  it('runs over market + portfolio and matches what the rule would act on', async () => {
    const r = await previewSovRule(draft())
    expect(r.ok).toBe(true)
    expect(r.selected).toBe(0)
    expect(r.measurable).toBe(5)
    expect(r.inScope).toBe(3) // g1 g2 g3: IT and the portfolio
    expect(r.matched).toBe(1)
    expect(r.rows.map((x) => [x.adTargetId, x.currentEur, x.proposedEur])).toEqual([['g1', 0.5, 0.55]])
    // The handler got the rule's own action: +10 %, ceiling €0.80.
    expect(h.bidApply.mock.calls[0][0]).toMatchObject({ type: 'bid_apply', op: 'incPct', value: 10, maxEur: 0.8, adTargetId: 'g1' })
  })

  it('counts its census over the same scope, not over nothing', async () => {
    await previewSovRule(draft())
    for (const [args] of h.count.mock.calls) {
      expect(args.where.adGroup).toEqual({ campaign: { marketplace: 'IT', portfolioId: PORTFOLIO } })
    }
  })

  it('without a portfolio it reads the whole market, and never asks for portfolios', async () => {
    const r = await previewSovRule(draft({ scopePortfolioId: null }))
    expect(r.inScope).toBe(4) // + x1
    expect(r.matched).toBe(2)
    expect(h.campaigns).not.toHaveBeenCalled()
  })

  it('picked campaigns still bind exactly as before', async () => {
    const r = await previewSovRule(draft({ actions: [{ type: 'sov', bidCeiling: 0.8, campaigns: [{ id: 'c-other' }] }], scopePortfolioId: null }))
    expect(r.selected).toBe(1)
    expect(r.measurable).toBe(1)
    expect(r.rows.map((x) => x.adTargetId)).toEqual(['x1'])
  })
})
