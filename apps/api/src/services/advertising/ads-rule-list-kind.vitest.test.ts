/**
 * 4e (review 4.7) — the rule board says what a rule IS from what its translation writes.
 *
 * A builder rule stores its slug (`placement`, `budget`, `bid`), which no category claimed, so every builder rule read
 * "Other changes"; and a Placement rule runs on the budget trigger by design (PLC-P7), so a surface keyed on the trigger
 * called "Trim Top of Search" a budget rule. The board now gives each rule its category and a `kind` from
 * `producedActionTypes`.
 */
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ rules: [] as Array<Record<string, unknown>> }))
vi.mock('../../db.js', () => ({
  default: {
    automationRule: { findMany: vi.fn(async () => h.rules) },
    adKeywordProtection: { count: vi.fn(async () => 0) },
    automationRuleExecution: { groupBy: vi.fn(async () => []) },
  },
}))
vi.mock('./ads-rule-reach.service.js', () => ({ reachForRules: vi.fn(async () => new Map()) }))

import { ruleCategory } from './rule-category.js'
import { listAdsRuleBoard } from './ads-rule-list.service.js'

const rule = (id: string, name: string, trigger: string, actions: unknown[], conditions: unknown[] = []) => ({
  id, name, trigger, actions, conditions, enabled: true, dryRun: true, autonomyLevel: 'PROPOSE', priority: 100,
  maxExecutionsPerDay: 10, maxValueCentsEur: null, maxWritesPerDay: null, maxDailyAdSpendCentsEur: 10000,
  scopeMarketplace: 'IT', scopePortfolioId: null, scopeCampaignId: null, scopeProductId: null,
  evaluationCount: 0, matchCount: 0, executionCount: 0, lastEvaluatedAt: null, lastMatchedAt: null, lastExecutedAt: null,
  createdAt: new Date('2026-10-01T00:00:00Z'), description: null,
})

describe('rule-category — the builder actions', () => {
  it('placement_apply is Placement and bid_apply is Bids', () => {
    expect(ruleCategory(['placement_apply'])).toBe('placement')
    expect(ruleCategory(['bid_apply'])).toBe('bid')
    expect(ruleCategory(['budget_apply'])).toBe('budget')
  })
})

describe('the rule board — category and kind from what the rule writes', () => {
  it('🔴 "Trim ToS — GALE BROAD IT" (a Placement rule on the budget trigger) is Placement, not Budget or Other', async () => {
    h.rules = [
      rule('r-tos', 'Trim ToS — GALE BROAD IT', 'CAMPAIGN_PERFORMANCE_BUDGET',
        [{ type: 'placement', campaigns: [{ id: 'c1' }], placeFloor: 0, placeCeiling: 900 }],
        [{ match: 'all', action: { op: 'decPct', value: '20', placeTarget: 'tos' }, conditions: [{ metric: 'ACOS', op: 'gt', value: '40', scope: 'tos' }] }]),
      rule('r-bud', 'Reclaim idle budget — DE', 'CAMPAIGN_PERFORMANCE_BUDGET',
        [{ type: 'budget', campaigns: [{ id: 'c2' }] }],
        [{ conditions: [{ metric: 'ACOS', op: 'lte', value: '20' }], action: { op: 'inc', value: '15' } }]),
      rule('r-eng', 'Alert: ACOS spike', 'CAC_SPIKE', [{ type: 'alert_operator' }]),
    ]
    const { items } = await listAdsRuleBoard()
    const by = Object.fromEntries(items.map((i) => [i.id, i]))
    expect(by['r-tos']).toMatchObject({ kind: 'placement', category: 'placement', categoryLabel: 'Placement' })
    expect(by['r-bud']).toMatchObject({ kind: 'budget', category: 'budget', categoryLabel: 'Budget' })
    // an engine-native rule is judged by its own stored types, as before
    expect(by['r-eng']).toMatchObject({ kind: 'alert', category: 'alert' })
  })
})
