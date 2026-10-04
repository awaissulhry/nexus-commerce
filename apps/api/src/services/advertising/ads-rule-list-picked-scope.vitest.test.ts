/**
 * 4i — the rule board says a builder rule bound to its picked campaigns is bound to them.
 *
 * Such a rule has no single scope campaign or portfolio, so it fell through to `{ kind: 'account' }` and the Automations
 * page read "Whole account" — while the tick (4a) runs it on its picks only. It is now `{ kind: 'picked', count }`.
 */
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ rules: [] as Array<Record<string, unknown>> }))
vi.mock('../../db.js', () => ({
  default: {
    automationRule: { findMany: vi.fn(async () => h.rules) },
    adKeywordProtection: { count: vi.fn(async () => 0) },
    automationRuleExecution: { groupBy: vi.fn(async () => []) },
    // 7b — the capped chip reads the refusal record.
    automationRefusalDaily: { findMany: vi.fn(async () => []) },
    campaign: { findMany: vi.fn(async () => [{ id: 'c7', name: 'GALE | DE | Broad' }]) },
    amazonAdsPortfolio: { findMany: vi.fn(async () => [{ externalPortfolioId: 'p1', name: 'Xavia GALE DE' }]) },
  },
}))
vi.mock('./ads-rule-reach.service.js', () => ({ reachForRules: vi.fn(async () => new Map()) }))

import { listAdsRuleBoard } from './ads-rule-list.service.js'

const rule = (id: string, actions: unknown[], scope: { scopeCampaignId?: string | null; scopePortfolioId?: string | null } = {}) => ({
  id, name: id, trigger: 'CAMPAIGN_PERFORMANCE_BUDGET', actions, conditions: [], enabled: true, dryRun: true, autonomyLevel: 'PROPOSE',
  priority: 100, maxExecutionsPerDay: 10, maxValueCentsEur: null, maxWritesPerDay: null, maxDailyAdSpendCentsEur: 10000,
  scopeMarketplace: 'DE', scopePortfolioId: scope.scopePortfolioId ?? null, scopeCampaignId: scope.scopeCampaignId ?? null, scopeProductId: null,
  evaluationCount: 0, matchCount: 0, executionCount: 0, lastEvaluatedAt: null, lastMatchedAt: null, lastExecutedAt: null,
  createdAt: new Date('2026-10-01T00:00:00Z'), description: null,
})

describe('the rule board — a rule bound to picked campaigns', () => {
  it('🔴 "Reclaim idle budget — DE" with 3 picks reads "3 campaigns" picked, not the whole account', async () => {
    h.rules = [
      rule('r-bud', [{ type: 'budget', campaigns: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }] }]),
      rule('r-one', [{ type: 'placement', campaigns: [{ id: 'c9' }] }]),
    ]
    const { items } = await listAdsRuleBoard()
    const by = Object.fromEntries(items.map((i) => [i.id, i]))
    expect(by['r-bud'].scope).toMatchObject({ kind: 'picked', id: null, name: '3 campaigns', count: 3 })
    expect(by['r-one'].scope).toMatchObject({ kind: 'picked', name: '1 campaign', count: 1 })
  })

  it('a rule with no picks stays account-wide; a single scope campaign or portfolio still wins', async () => {
    h.rules = [
      rule('r-none', [{ type: 'bid', campaigns: [] }]),
      rule('r-engine', [{ type: 'adjust_ad_budget', percent: -10 }]),
      rule('r-camp', [{ type: 'budget', campaigns: [{ id: 'c1' }] }], { scopeCampaignId: 'c7' }),
      rule('r-port', [{ type: 'bid', campaigns: [{ id: 'c1' }] }], { scopePortfolioId: 'p1' }),
    ]
    const { items } = await listAdsRuleBoard()
    const by = Object.fromEntries(items.map((i) => [i.id, i]))
    expect(by['r-none'].scope).toMatchObject({ kind: 'account', id: null, name: null })
    expect(by['r-engine'].scope).toMatchObject({ kind: 'account' })
    expect(by['r-camp'].scope).toMatchObject({ kind: 'campaign', id: 'c7' })
    expect(by['r-port'].scope).toMatchObject({ kind: 'portfolio', id: 'p1' })
  })
})
