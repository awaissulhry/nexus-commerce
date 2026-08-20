/** AIAD.4 — planGoalScaffold: the pure planner the preview renders and materialize executes. */
import { describe, it, expect } from 'vitest'
import { planGoalScaffold, MaterializeError } from './ai-goal-materialize.service.js'

const product = (asin: string, budgetCents: number | null = 1000) => ({ asin, sku: `SKU-${asin}`, name: `P ${asin}`, budgetCents })

describe('planGoalScaffold', () => {
  it('STRICT mode: one scaffold per product; SHARED: one for the set', () => {
    const strict = planGoalScaffold({ name: 'G', aiTarget: 'SALES', budgetMode: 'STRICT', products: [product('A1'), product('A2')], seedKeywords: ['kw'], marketplace: 'DE' })
    // 2 products × (AUTO, RESEARCH, PERF) = 6
    expect(strict.campaigns).toHaveLength(6)
    expect(new Set(strict.campaigns.map((c) => c.setLabel)).size).toBe(2)
    const shared = planGoalScaffold({ name: 'G', aiTarget: 'SALES', budgetMode: 'SHARED', totalBudgetCents: 3000, products: [product('A1'), product('A2')], seedKeywords: ['kw'], marketplace: 'DE' })
    expect(shared.campaigns).toHaveLength(3)
    expect(shared.campaigns.every((c) => c.products.length === 2)).toBe(true)
  })

  it('role split: seeds gate RESEARCH, product targets gate PAT; budgets sum to ~goal budget', () => {
    const s = planGoalScaffold({ name: 'G', aiTarget: 'SALES', budgetMode: 'SHARED', totalBudgetCents: 10_000, products: [product('A1')], seedKeywords: ['a'], productTargets: ['B00X'], marketplace: 'IT' })
    expect(s.campaigns.map((c) => c.role).sort()).toEqual(['AUTO', 'PAT', 'PERF', 'RESEARCH'])
    expect(s.totalDailyBudgetCents).toBe(10_000)
    const noSeeds = planGoalScaffold({ name: 'G', aiTarget: 'SALES', budgetMode: 'SHARED', totalBudgetCents: 10_000, products: [product('A1')], marketplace: 'IT' })
    expect(noSeeds.campaigns.map((c) => c.role).sort()).toEqual(['AUTO', 'PERF'])
    expect(noSeeds.warnings.some((w) => w.includes('No seed keywords'))).toBe(true)
  })

  it('seeds fan out broad→RESEARCH and exact→PERF; excludes bind on AUTO+RESEARCH both match types', () => {
    const s = planGoalScaffold({ name: 'G', aiTarget: 'SALES', budgetMode: 'SHARED', totalBudgetCents: 3000, products: [product('A1')], seedKeywords: ['red mug'], excludeKeywords: ['free'], marketplace: 'IT' })
    const research = s.campaigns.find((c) => c.role === 'RESEARCH')!
    const perf = s.campaigns.find((c) => c.role === 'PERF')!
    const auto = s.campaigns.find((c) => c.role === 'AUTO')!
    expect(research.seeds).toEqual([{ text: 'red mug', matchType: 'BROAD', bidCents: 75 }])
    expect(perf.seeds).toEqual([{ text: 'red mug', matchType: 'EXACT', bidCents: 75 }])
    expect(auto.negativeKeywords).toHaveLength(2) // EXACT + PHRASE
    expect(research.negativeKeywords).toHaveLength(2)
    expect(perf.negativeKeywords).toHaveLength(0)
  })

  it('clamps sub-€1 role budgets up to Amazon’s floor and says so', () => {
    const s = planGoalScaffold({ name: 'G', aiTarget: 'SALES', budgetMode: 'STRICT', products: [product('A1', 150)], seedKeywords: ['kw'], marketplace: 'IT' })
    expect(s.campaigns.every((c) => c.budgetCents >= 100)).toBe(true)
    expect(s.warnings.some((w) => w.includes('€1/day floor'))).toBe(true)
  })

  it('maps all five ai targets to conductor presets; unknown falls back to BALANCED', () => {
    const m = (t: string) => planGoalScaffold({ name: 'G', aiTarget: t, budgetMode: 'SHARED', totalBudgetCents: 1000, products: [product('A1')], marketplace: 'IT' }).planGoal
    expect(m('IMPRESSION')).toBe('LAUNCH')
    expect(m('SALES')).toBe('BALANCED')
    expect(m('ROAS')).toBe('PROFIT')
    expect(m('LIQUIDATE')).toBe('LIQUIDATE')
    expect(m('RANK')).toBe('DEFEND_RANK')
    expect(m('???')).toBe('BALANCED')
  })

  it('guardrails: goal dials override defaults, invalid dials fall back, cap = goal budget', () => {
    const s = planGoalScaffold({ name: 'G', aiTarget: 'ROAS', budgetMode: 'SHARED', totalBudgetCents: 5000, products: [product('A1')], marketplace: 'IT', targetAcosPct: 22, bidMinCents: 10, bidMaxCents: 150 })
    expect(s.guardrails.targetAcosPct).toBe(22)
    expect(s.guardrails.bidMinCents).toBe(10)
    expect(s.guardrails.bidMaxCents).toBe(150)
    expect(s.guardrails.maxDailySpendCents).toBe(5000)
    const bad = planGoalScaffold({ name: 'G', aiTarget: 'ROAS', budgetMode: 'SHARED', totalBudgetCents: 5000, products: [product('A1')], marketplace: 'IT', targetAcosPct: 900, bidMinCents: 100, bidMaxCents: 50 })
    expect(bad.guardrails.targetAcosPct).toBe(30) // default
    expect(bad.guardrails.bidMaxCents).toBe(300)  // default (max ≤ min rejected)
  })

  it('one harvest + one negative rule per scaffold set; missing marketplace warns and defaults', () => {
    const s = planGoalScaffold({ name: 'G', aiTarget: 'IMPRESSION', budgetMode: 'STRICT', products: [product('A1'), product('A2')], seedKeywords: ['kw'] })
    expect(s.rules).toHaveLength(4)
    expect(s.rules.filter((r) => r.kind === 'harvest')).toHaveLength(2)
    expect(s.marketplace).toBe('IT')
    expect(s.warnings.some((w) => w.includes('marketplace'))).toBe(true)
    // LAUNCH preset harvests aggressively → minOrders 1
    expect(s.rules[0].minOrders).toBe(1)
  })

  it('bid evidence flows into seeds and auto groups when provided (preview = launch)', () => {
    const s = planGoalScaffold(
      { name: 'G', aiTarget: 'SALES', budgetMode: 'SHARED', totalBudgetCents: 3000, products: [product('A1')], seedKeywords: ['Red Mug'], marketplace: 'IT' },
      { bidCentsByKeyword: { 'red mug': 120 }, autoBaseCents: 100 },
    )
    expect(s.campaigns.find((c) => c.role === 'PERF')!.seeds[0].bidCents).toBe(120)
    const auto = s.campaigns.find((c) => c.role === 'AUTO')!
    expect(auto.autoGroups.find((g) => g.key === 'CLOSE_MATCH')!.bidEur).toBe(1)
    expect(auto.autoGroups.find((g) => g.key === 'LOOSE_MATCH')!.bidEur).toBe(0.65)
  })

  it('refuses a goal with no products', () => {
    expect(() => planGoalScaffold({ name: 'G', aiTarget: 'SALES', budgetMode: 'SHARED', totalBudgetCents: 1000, products: [], marketplace: 'IT' })).toThrow(MaterializeError)
  })
})
