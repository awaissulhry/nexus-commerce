/**
 * 4a (review 4.2, 4.14) — a rule acts on the campaigns picked in the builder, and the tick, Simulate
 * and the reach number all say so.
 *
 * The defect: only a Budget rule was matched on its picks. A Bid, SOV, Keyword Tracker or Placement
 * rule was evaluated on every campaign in the account; its handler skipped an unpicked one only
 * after the execution row existed, so unpicked campaigns spent the rule's daily cap. Live: "Trim Top
 * of Search on zero-sale clicks — GALE BROAD IT" picks 1 campaign and read reach 220. Simulate also
 * ignored the budget assignment, the picks and the rule's own lookback.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  assignments: vi.fn(),
  campaigns: vi.fn(),
  adProductAds: vi.fn(),
  products: vi.fn(),
  rules: vi.fn(),
  rule: vi.fn(),
  perf: vi.fn(),
  lanes: vi.fn(),
  evalAll: vi.fn(),
  evalOne: vi.fn(),
}))

vi.mock('../../db.js', () => ({
  default: {
    campaignRuleAssignment: { findMany: h.assignments },
    campaign: { findMany: h.campaigns },
    adProductAd: { findMany: h.adProductAds },
    product: { findMany: h.products },
    automationRule: { findMany: h.rules, findUnique: h.rule },
    amazonAdsDailyPerformance: { groupBy: h.perf },
    amazonAdsPlacementReport: { groupBy: h.lanes },
  },
}))
// Only the two evaluation entry points are stubbed: the tests assert WHICH contexts reach them.
vi.mock('../automation-rule.service.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  evaluateAllRulesForTrigger: h.evalAll,
  evaluateRule: h.evalOne,
}))
vi.mock('./automation-action-handlers.js', () => ({}))

import { resolveAssignedCampaignIds } from './ads-rule-scope-resolver.js'
import { reachForRules } from './ads-rule-reach.service.js'
import { applyMarketplaceScope, simulateOneRule } from '../../jobs/advertising-rule-evaluator.job.js'

const PICK = 'c-gale-broad-it'
const picks = (ids: string[]) => ids.map((id) => ({ id, name: id, marketplace: 'IT' }))

/** The live "Trim Top of Search on zero-sale clicks — GALE BROAD IT" shape: placement, 1 pick, no market. */
const trimTos = (over: Record<string, unknown> = {}) => ({
  id: 'rule-trim-tos',
  name: 'Trim Top of Search on zero-sale clicks — GALE BROAD IT',
  domain: 'advertising',
  trigger: 'CAMPAIGN_PERFORMANCE_BUDGET',
  enabled: true,
  scopeMarketplace: null, scopePortfolioId: null, scopeCampaignId: null, scopeProductId: null,
  lastEvaluatedAt: null,
  actions: [{ type: 'placement', campaigns: picks([PICK]), placeFloor: 0, placeCeiling: 900, mappings: [], ...over }],
  conditions: [],
})

/** 220 campaigns, as the account has; the pick is one of them. */
const ACCOUNT = Array.from({ length: 220 }, (_, i) => ({
  id: i === 0 ? PICK : `c-${i}`,
  marketplace: ['IT', 'DE', 'FR', 'ES'][i % 4],
  portfolioId: null,
  status: 'ENABLED',
  externalCampaignId: `ext-${i}`,
}))

beforeEach(() => {
  vi.clearAllMocks()
  h.assignments.mockResolvedValue([])
  h.adProductAds.mockResolvedValue([])
  h.products.mockResolvedValue([])
  h.lanes.mockResolvedValue([])
  h.evalAll.mockResolvedValue([{ matched: true, status: 'DRY_RUN' }])
  h.evalOne.mockResolvedValue({ matched: true, status: 'DRY_RUN', actionResults: [] })
})

describe('resolveAssignedCampaignIds — what each rule is bound to', () => {
  it('🔴 a Placement rule is bound to its picks (it used to reach the matcher unbound)', async () => {
    const m = await resolveAssignedCampaignIds([trimTos()])
    expect(m.get('rule-trim-tos')).toEqual([PICK])
    // No engine budget rule in the set → the assignment table is not read at all.
    expect(h.assignments).not.toHaveBeenCalled()
  })

  it('Bid, SOV and Keyword Tracker rules are bound to their picks too', async () => {
    const m = await resolveAssignedCampaignIds(['bid', 'sov', 'keyword-tracker'].map((type) => (
      { id: type, actions: [{ type, campaigns: picks(['c1', 'c2']) }] })))
    expect([...m.values()]).toEqual([['c1', 'c2'], ['c1', 'c2'], ['c1', 'c2']])
  })

  it('a non-budget rule with NO picks stays unbound — account-wide, exactly as its handler reads it', async () => {
    const m = await resolveAssignedCampaignIds([
      { id: 'p', actions: [{ type: 'placement', campaigns: [] }] },
      { id: 'b', actions: [{ type: 'bid' }] },
    ])
    expect(m.has('p')).toBe(false)
    expect(m.has('b')).toBe(false)
  })

  it('a builder Budget rule keeps its three states: picks, [] (matches nothing), no array (unbound)', async () => {
    const m = await resolveAssignedCampaignIds([
      { id: 'picked', actions: [{ type: 'budget', campaigns: picks(['c1']) }] },
      { id: 'none', actions: [{ type: 'budget', campaigns: [] }] },
      { id: 'legacy', actions: [{ type: 'budget' }] },
    ])
    expect(m.get('picked')).toEqual(['c1'])
    expect(m.get('none')).toEqual([])
    expect(m.has('legacy')).toBe(false)
  })

  it('an engine budget rule reads CampaignRuleAssignment, seeded with [] so "unassigned" matches nothing', async () => {
    h.assignments.mockResolvedValue([{ ruleId: 'eng-1', campaignId: 'c9' }])
    const m = await resolveAssignedCampaignIds([
      { id: 'eng-1', actions: [{ type: 'adjust_ad_budget' }] },
      { id: 'eng-2', actions: [{ type: 'adjust_ad_budget' }] },
      { id: 'other', actions: [{ type: 'notify' }] },
    ])
    expect(h.assignments).toHaveBeenCalledWith(expect.objectContaining({ where: { ruleId: { in: ['eng-1', 'eng-2'] }, kind: 'budget' } }))
    expect(m.get('eng-1')).toEqual(['c9'])
    expect(m.get('eng-2')).toEqual([])
    expect(m.has('other')).toBe(false)
  })

  it('Negative Targeting and Keyword Harvesting stay unbound — their ad-group mappings bind them in the handler', async () => {
    const m = await resolveAssignedCampaignIds([
      { id: 'neg', actions: [{ type: 'negative-targeting', mappings: [{ groups: [{ id: 'ag1', campaignId: 'c1' }] }] }] },
      { id: 'harvest', actions: [{ type: 'keyword-harvesting', mappings: [{ groups: [{ id: 'ag2', campaignId: 'c2' }] }] }] },
    ])
    expect(m.size).toBe(0)
  })
})

describe('reachForRules — the number on the row', () => {
  beforeEach(() => { h.campaigns.mockResolvedValue(ACCOUNT) })

  it('🔴 "Trim Top of Search — GALE BROAD IT" (placement, 1 pick) reaches 1 of 220, not 220', async () => {
    const r = await reachForRules([trimTos()])
    expect(r.get('rule-trim-tos')).toEqual({ campaigns: 1, enabledCampaigns: 1, total: 220 })
  })

  it('control: the same rule with no picks still reaches the whole account', async () => {
    const r = await reachForRules([trimTos({ campaigns: [] })])
    expect(r.get('rule-trim-tos')?.campaigns).toBe(220)
  })
})

/** Three IT campaign contexts on the budget/placement trigger; only the first is picked. */
const ctx = (id: string) => ({ trigger: 'CAMPAIGN_PERFORMANCE_BUDGET', marketplace: 'IT', campaign: { id, name: id } })

describe('applyMarketplaceScope — the tick evaluates picked campaigns only', () => {
  beforeEach(() => {
    h.campaigns.mockImplementation(async () => ACCOUNT.slice(0, 3).map((c) => ({ id: c.id, externalCampaignId: c.externalCampaignId, portfolioId: null })))
  })

  it('🔴 an unpicked campaign is never evaluated, so it writes no run row and spends none of the daily cap', async () => {
    h.rules.mockResolvedValue([trimTos()])
    const r = await applyMarketplaceScope('CAMPAIGN_PERFORMANCE_BUDGET', [ctx(PICK), ctx('c-1'), ctx('c-2')], true)
    expect(h.evalAll).toHaveBeenCalledTimes(1)
    expect(h.evalAll.mock.calls[0][0]).toMatchObject({ context: { campaign: { id: PICK } }, ruleIds: ['rule-trim-tos'] })
    expect(r.evaluations).toBe(1)
  })

  it('control: with no picks the rule is still evaluated on every campaign, as before', async () => {
    h.rules.mockResolvedValue([trimTos({ campaigns: [] })])
    await applyMarketplaceScope('CAMPAIGN_PERFORMANCE_BUDGET', [ctx(PICK), ctx('c-1'), ctx('c-2')], true)
    expect(h.evalAll).toHaveBeenCalledTimes(3)
  })
})

describe('simulateOneRule — the same scope and the same window as the tick', () => {
  const ENABLED = ACCOUNT.slice(0, 3).map((c) => ({ id: c.id, name: c.id, externalCampaignId: c.externalCampaignId, marketplace: 'IT', dailyBudget: 10 }))
  beforeEach(() => {
    // The context builder reads ENABLED campaigns; the identity lookup reads by id.
    h.campaigns.mockImplementation(async (args: { where?: { status?: string } }) => (args?.where?.status === 'ENABLED'
      ? ENABLED
      : ENABLED.map((c) => ({ id: c.id, externalCampaignId: c.externalCampaignId, portfolioId: null }))))
    h.perf.mockResolvedValue(ENABLED.map((c) => ({ localEntityId: c.id, _sum: { costMicros: 5_000_000, sales7dCents: 0, sales14dCents: 0, impressions: 100, clicks: 10, orders7d: 0 } })))
  })
  /** Days spanned by the window the context builder queried. */
  const queriedDays = () => {
    // 6c — the window is per ad product now; the Sponsored Products branch carries the same length.
    const where = (h.perf.mock.calls[0][0] as { where: { OR: Array<{ date: { gte: Date; lte: Date } }> } }).where.OR[0]
    return Math.round((where.date.lte.getTime() - where.date.gte.getTime()) / 86_400_000)
  }

  it('🔴 simulates on the picked campaign only — it used to report every campaign', async () => {
    h.rule.mockResolvedValue(trimTos())
    const out = await simulateOneRule('rule-trim-tos')
    expect(out).toMatchObject({ ok: true, contextsBuilt: 3, contextsInScope: 1, matched: 1 })
    expect(h.evalOne).toHaveBeenCalledTimes(1)
    expect(h.evalOne.mock.calls[0][0]).toMatchObject({ context: { campaign: { id: PICK } }, forceDryRun: true, noPersist: true })
  })

  it('🔴 builds the contexts over the rule\'s OWN lookback (14 days), as the tick\'s per-window pass does', async () => {
    h.rule.mockResolvedValue(trimTos({ windowDays: 14 }))
    await simulateOneRule('rule-trim-tos')
    expect(queriedDays()).toBe(14)
  })

  it('control: a rule with no lookback of its own uses the trigger\'s 7 days', async () => {
    h.rule.mockResolvedValue(trimTos())
    await simulateOneRule('rule-trim-tos')
    expect(queriedDays()).toBe(7)
  })

  it('an assigned engine budget rule simulates on its assigned campaigns only', async () => {
    h.rule.mockResolvedValue({ ...trimTos(), id: 'eng-1', actions: [{ type: 'adjust_ad_budget' }] })
    h.assignments.mockResolvedValue([{ ruleId: 'eng-1', campaignId: 'c-2' }])
    const out = await simulateOneRule('eng-1')
    expect(out).toMatchObject({ contextsBuilt: 3, contextsInScope: 1 })
    expect(h.evalOne.mock.calls[0][0]).toMatchObject({ context: { campaign: { id: 'c-2' } } })
  })
})
