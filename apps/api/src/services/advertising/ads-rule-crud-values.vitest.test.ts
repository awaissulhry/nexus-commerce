/**
 * 4b (review 4.1) — an Amazon Ads rule's create and edit refuse a number that cannot be read or is out of range, with
 * a 400 and a plain sentence, before anything is stored; a decimal comma is a number like any other.
 *
 * The database is a stub: every case here is decided before the first write, and the success cases only need to see
 * what would be written.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  automationRule: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  advertisingActionLog: { create: vi.fn(async () => ({})) },
}))
vi.mock('../../db.js', () => ({ default: db }))
vi.mock('./rule-campaign-binding.service.js', () => ({ syncRuleCampaignBinding: vi.fn(async () => undefined) }))

const { createAdsRule, updateAdsRule } = await import('./ads-rule-crud.service.js')

const budgetRule = (a0: Record<string, unknown>, groups: unknown[]) => ({
  name: 'Budget rule', trigger: 'CAMPAIGN_PERFORMANCE_BUDGET',
  actions: [{ type: 'budget', campaigns: [{ id: 'c1' }], ...a0 }],
  conditions: groups,
})
const group = (conditions: Array<{ metric: string; op: string; value: unknown }>, action: { op: string; value: unknown }) =>
  ({ match: 'all', conditions, action })
const STORED = {
  id: 'r1', domain: 'advertising', name: 'Stored rule', trigger: 'CAMPAIGN_PERFORMANCE_BUDGET',
  actions: [{ type: 'budget', campaigns: [{ id: 'c1' }], budgetFloor: 1, budgetCeiling: 30 }],
  conditions: [group([{ metric: 'Spend', op: 'gte', value: '5' }], { op: 'set', value: '10' })],
  maxDailyAdSpendCentsEur: 10000,
}

beforeEach(() => {
  vi.clearAllMocks()
  db.automationRule.create.mockImplementation(async ({ data }: { data: object }) => ({ id: 'new', ...data }))
  db.automationRule.findUnique.mockResolvedValue(STORED)
  db.automationRule.update.mockImplementation(async ({ data }: { data: object }) => ({ ...STORED, ...data }))
})

describe('4b — create', () => {
  it('🔴 a decimal comma is read: "2,5", "12,50" and a "12,50" ceiling save as they read', async () => {
    const out = await createAdsRule(budgetRule({ budgetCeiling: '12,50' }, [group([{ metric: 'Spend', op: 'gte', value: '2,5' }], { op: 'set', value: '12,50' })]), 'user:test')
    expect(out.ok).toBe(true)
    expect(db.automationRule.create).toHaveBeenCalledTimes(1)
  })

  it('🔴 a value that cannot be read is refused with a sentence naming it — never stored as 0', async () => {
    const out = await createAdsRule(budgetRule({}, [group([{ metric: 'Spend', op: 'gte', value: 'abc' }], { op: 'set', value: '5' })]), 'user:test')
    expect(out).toEqual({
      ok: false, status: 400,
      body: {
        error: 'Spend: "abc" is not a number — type digits with at most one decimal comma or point, for example 2,5.',
        problems: ['Spend: "abc" is not a number — type digits with at most one decimal comma or point, for example 2,5.'],
      },
    })
    expect(db.automationRule.create).not.toHaveBeenCalled()
  })

  it('holds each value to its range: a decrease at most 100%, a placement 0–900%, money never negative', async () => {
    const decrease = await createAdsRule(budgetRule({}, [group([{ metric: 'Clicks', op: 'gte', value: '10' }], { op: 'decPct', value: '150' })]), 'user:test')
    expect(decrease.ok === false && decrease.body.error).toBe('The “Decrease by %” value must be at most 100 (it is 150).')
    const placement = await createAdsRule({
      name: 'Placement rule', trigger: 'CAMPAIGN_PERFORMANCE_BUDGET',
      actions: [{ type: 'placement', campaigns: [{ id: 'c1' }], placeFloor: 0, placeCeiling: 900 }],
      conditions: [group([{ metric: 'ACOS', op: 'gt', value: '30' }], { op: 'set', value: '1000' })],
    }, 'user:test')
    expect(placement.ok === false && placement.body.error).toBe('The “Set to %” value must be at most 900 (it is 1000).')
    const bid = await createAdsRule({
      name: 'Bid rule', trigger: 'KEYWORD_HIGH_ACOS',
      actions: [{ type: 'bid', campaigns: [{ id: 'c1' }], bidFloor: '-0,05', bidCeiling: null }],
      conditions: [group([{ metric: 'ACOS', op: 'gt', value: '30' }], { op: 'setCpc', value: '' })],
    }, 'user:test')
    expect(bid.ok === false && bid.body.error).toBe('Bid floor must be at least 0 (it is -0.05).')
    expect(db.automationRule.create).not.toHaveBeenCalled()
  })

  it('a floor above its ceiling is refused; every problem is named, block by block', async () => {
    const out = await createAdsRule(budgetRule({ budgetFloor: 20, budgetCeiling: '12,50' }, [
      group([{ metric: 'Clicks', op: 'gte', value: '10' }], { op: 'set', value: '15' }),
      group([{ metric: 'Spend', op: 'gte', value: '' }], { op: 'incPct', value: '-5' }),
    ]), 'user:test')
    expect(out.ok === false && out.body.problems).toEqual([
      'Criteria 2: Spend is empty: type a number.',
      'Criteria 2: The “Increase by %” value must be at least 0 (it is -5).',
      'Budget floor (20) is above the budget ceiling (12.5): lower the floor or raise the ceiling.',
    ])
  })

  it('🔴 a cap that cannot be read is refused, not stored as "no cap"; one sent as text is stored as its number', async () => {
    const junk = await createAdsRule({ name: 'Caps', trigger: 'SCHEDULE', maxDailyAdSpendCentsEur: 'abc' as never }, 'user:test')
    expect(junk.ok === false && junk.body.error).toMatch(/^Daily spend ceiling \(cents\): "abc" is not a number/)
    const half = await createAdsRule({ name: 'Caps', trigger: 'SCHEDULE', maxValueCentsEur: 12.5 }, 'user:test')
    expect(half.ok === false && half.body.error).toBe('Max value per run (cents) must be a whole number (it is 12.5).')
    expect(db.automationRule.create).not.toHaveBeenCalled()
    await createAdsRule({ name: 'Caps', trigger: 'SCHEDULE', maxDailyAdSpendCentsEur: '5000' as never, maxWritesPerDay: 3 }, 'user:test')
    expect(db.automationRule.create.mock.calls[0][0].data).toMatchObject({ maxDailyAdSpendCentsEur: 5000, maxWritesPerDay: 3, maxExecutionsPerDay: 10 })
  })
})

describe('4b — edit', () => {
  it('🔴 a spend cap that cannot be read leaves the stored cap alone; null still clears it (a choice)', async () => {
    const junk = await updateAdsRule('r1', { maxDailyAdSpendCentsEur: '50,x' as never }, 'user:test')
    expect(junk.ok === false && junk.status).toBe(400)
    expect(db.automationRule.update).not.toHaveBeenCalled()
    await updateAdsRule('r1', { maxDailyAdSpendCentsEur: null }, 'user:test')
    expect(db.automationRule.update.mock.calls[0][0].data).toEqual({ maxDailyAdSpendCentsEur: null })
  })

  it('checks the MERGED rule: new criteria against the stored actions, and new actions against the stored criteria', async () => {
    const criteria = await updateAdsRule('r1', { conditions: [group([{ metric: 'Spend', op: 'gte', value: '2,5,0' }], { op: 'set', value: '10' })] }, 'user:test')
    expect(criteria.ok === false && criteria.body.error).toMatch(/^Spend: "2,5,0" is not a number/)
    const actions = await updateAdsRule('r1', { actions: [{ type: 'budget', campaigns: [{ id: 'c1' }], budgetFloor: 40, budgetCeiling: 30 }] }, 'user:test')
    expect(actions.ok === false && actions.body.error).toBe('Budget floor (40) is above the budget ceiling (30): lower the floor or raise the ceiling.')
    expect(db.automationRule.update).not.toHaveBeenCalled()
    const ok = await updateAdsRule('r1', { conditions: [group([{ metric: 'Spend', op: 'gte', value: '2,5' }], { op: 'decPct', value: '12,5' })] }, 'user:test')
    expect(ok.ok).toBe(true)
  })

  it('an edit that touches neither criteria nor actions does not re-check them', async () => {
    db.automationRule.findUnique.mockResolvedValue({ ...STORED, actions: [{ type: 'budget', campaigns: [], budgetFloor: 40, budgetCeiling: 30 }] })
    const out = await updateAdsRule('r1', { name: 'Renamed' }, 'user:test')
    expect(out.ok).toBe(true)
  })
})
