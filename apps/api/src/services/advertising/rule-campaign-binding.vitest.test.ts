/**
 * BUD-P2 — the two mirrors that make ONE binding truth for budget rules, driven for real
 * (mocked I/O). Pinned here because the failure they fix is silent by construction: a builder
 * budget rule stores `type: 'budget'` while the column, the evaluator's assignment block and
 * `reachForRules` all tested `adjust_ad_budget`, so the two mechanisms could disagree forever
 * without anything erroring.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    campaign: { findMany: vi.fn() },
    automationRule: { findMany: vi.fn(), update: vi.fn() },
    campaignRuleAssignment: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    $transaction: vi.fn(),
  },
}))
vi.mock('@nexus/database', () => ({ Prisma: {} }))

import prisma from '../../db.js'
import {
  syncRuleCampaignBinding,
  syncBuilderRuleFromAssignments,
} from './rule-campaign-binding.service.js'
import {
  isEngineBudgetRule,
  builderBudgetCampaignIds,
  isBudgetRuleOfAnyShape,
} from './ads-rule-adapter.service.js'

const db = vi.mocked(prisma, true)

/** The transaction client the service sees — the same mocks, so assertions read straight off db. */
const tx = {
  campaignRuleAssignment: db.campaignRuleAssignment,
}

const builderBudget = (campaignIds: string[]) => [
  { type: 'budget', campaigns: campaignIds.map((id) => ({ id, name: `C ${id}` })), budgetFloor: 1 },
]

beforeEach(() => {
  vi.clearAllMocks()
  ;(db.$transaction as unknown as { mockImplementation: (f: unknown) => void })
    .mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx))
  db.campaignRuleAssignment.deleteMany.mockResolvedValue({ count: 0 } as never)
  db.campaignRuleAssignment.createMany.mockResolvedValue({ count: 0 } as never)
})

describe('the shape tests (the root cause)', () => {
  it('recognises BOTH budget shapes — the engine-native one is not the only one', () => {
    const engine = [{ type: 'adjust_ad_budget', percent: 10 }]
    expect(isEngineBudgetRule(engine)).toBe(true)
    expect(builderBudgetCampaignIds(engine)).toBeNull()

    const builder = builderBudget(['c1', 'c2'])
    // 🔴 This is the defect in one line: the old catalogue/evaluator/reach test said "false".
    expect(isEngineBudgetRule(builder)).toBe(false)
    expect(builderBudgetCampaignIds(builder)).toEqual(['c1', 'c2'])

    expect(isBudgetRuleOfAnyShape(engine)).toBe(true)
    expect(isBudgetRuleOfAnyShape(builder)).toBe(true)
  })

  it('separates "governed by nothing" from "not governed" — the load-bearing distinction', () => {
    // Picker emptied (column "None") => [] => matches NO campaign.
    expect(builderBudgetCampaignIds(builderBudget([]))).toEqual([])
    // A pre-EA4 budget rule with no campaigns array at all stays UNGOVERNED (null), rather than
    // silently becoming a rule that matches nothing.
    expect(builderBudgetCampaignIds([{ type: 'budget', budgetFloor: 1 }])).toBeNull()
    // Non-budget rules are never assignment-governed.
    expect(builderBudgetCampaignIds([{ type: 'negative-targeting', campaigns: [{ id: 'c1' }] }])).toBeNull()
    expect(isBudgetRuleOfAnyShape([{ type: 'bid', campaigns: [{ id: 'c1' }] }])).toBe(false)
  })
})

describe('forward mirror — builder save → assignment rows', () => {
  it('creates the links the picker names, and skips ids that no longer exist', async () => {
    db.campaign.findMany.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }] as never)
    db.campaignRuleAssignment.findMany.mockResolvedValue([] as never)
    db.campaignRuleAssignment.createMany.mockResolvedValue({ count: 2 } as never)

    const r = await syncRuleCampaignBinding('rule-1', builderBudget(['c1', 'c2', 'ghost']), 'tester')

    expect(r.applied).toBe(true)
    expect(r.created).toBe(2)
    expect(r.skipped).toEqual(['ghost'])
    const data = db.campaignRuleAssignment.createMany.mock.calls[0][0].data as Array<Record<string, unknown>>
    expect(data.map((d) => d.campaignId).sort()).toEqual(['c1', 'c2'])
    expect(data.every((d) => d.kind === 'budget' && d.createdBy === 'tester')).toBe(true)
  })

  it('removes links the picker dropped — an edit that REMOVES a campaign must reach the column', async () => {
    db.campaign.findMany.mockResolvedValue([{ id: 'c1' }] as never)
    db.campaignRuleAssignment.findMany.mockResolvedValue([
      { id: 'l1', campaignId: 'c1' }, { id: 'l2', campaignId: 'c2' },
    ] as never)
    db.campaignRuleAssignment.deleteMany.mockResolvedValue({ count: 1 } as never)

    const r = await syncRuleCampaignBinding('rule-1', builderBudget(['c1']))

    expect(r.removed).toBe(1)
    expect(db.campaignRuleAssignment.deleteMany.mock.calls[0][0].where).toEqual({ id: { in: ['l2'] } })
    // c1 was already linked — no duplicate write.
    expect(db.campaignRuleAssignment.createMany).not.toHaveBeenCalled()
  })

  it('an emptied picker clears every link (H10’s "None")', async () => {
    db.campaignRuleAssignment.findMany.mockResolvedValue([{ id: 'l1', campaignId: 'c1' }] as never)
    db.campaignRuleAssignment.deleteMany.mockResolvedValue({ count: 1 } as never)

    const r = await syncRuleCampaignBinding('rule-1', builderBudget([]))

    expect(r.applied).toBe(true)
    expect(r.removed).toBe(1)
    expect(db.campaign.findMany).not.toHaveBeenCalled()
  })

  it('is a no-op for an engine-native rule and for every non-budget rule', async () => {
    for (const actions of [
      [{ type: 'adjust_ad_budget', percent: 10 }],
      [{ type: 'bid', campaigns: [{ id: 'c1' }] }],
      [],
      null,
    ]) {
      const r = await syncRuleCampaignBinding('rule-x', actions)
      expect(r.applied).toBe(false)
    }
    expect(db.$transaction).not.toHaveBeenCalled()
  })
})

describe('inverse mirror — column edit → the rule’s own campaigns', () => {
  it('rewrites the picker list from the links, so a column edit REACHES the engine', async () => {
    db.automationRule.findMany.mockResolvedValue([
      { id: 'rule-1', actions: builderBudget(['c1']) },
    ] as never)
    db.campaignRuleAssignment.findMany.mockResolvedValue([
      { ruleId: 'rule-1', campaignId: 'c1' }, { ruleId: 'rule-1', campaignId: 'c2' },
    ] as never)
    db.campaign.findMany.mockResolvedValue([
      { id: 'c1', name: 'One', marketplace: 'IT', status: 'ENABLED', targetingType: 'MANUAL', adProduct: 'SP', dailyBudget: 5, portfolioId: null },
      { id: 'c2', name: 'Two', marketplace: 'DE', status: 'ENABLED', targetingType: 'AUTO', adProduct: 'SP', dailyBudget: 1, portfolioId: 'p1' },
    ] as never)

    const r = await syncBuilderRuleFromAssignments(['rule-1'], 'tester')

    expect(r.updated).toEqual(['rule-1'])
    const written = db.automationRule.update.mock.calls[0][0].data.actions as Array<Record<string, unknown>>
    const camps = written[0].campaigns as Array<Record<string, unknown>>
    expect(camps.map((c) => c.id).sort()).toEqual(['c1', 'c2'])
    // The stored objects carry what the builder's picker renders, not bare ids.
    expect(camps.find((c) => c.id === 'c2')).toMatchObject({ name: 'Two', marketplace: 'DE', adProduct: 'SP', dailyBudget: 1 })
    // Non-campaign fields of the action survive the rewrite.
    expect(written[0].budgetFloor).toBe(1)
    expect(written[0].type).toBe('budget')
  })

  it('clears the list when the last link is removed — the uncheck-all case', async () => {
    db.automationRule.findMany.mockResolvedValue([
      { id: 'rule-1', actions: builderBudget(['c1']) },
    ] as never)
    db.campaignRuleAssignment.findMany.mockResolvedValue([] as never)

    const r = await syncBuilderRuleFromAssignments(['rule-1'])

    expect(r.updated).toEqual(['rule-1'])
    const written = db.automationRule.update.mock.calls[0][0].data.actions as Array<Record<string, unknown>>
    expect(written[0].campaigns).toEqual([])
  })

  it('writes NOTHING when the two already agree — no updatedAt heartbeat on an unrelated Apply', async () => {
    db.automationRule.findMany.mockResolvedValue([
      { id: 'rule-1', actions: builderBudget(['c1', 'c2']) },
    ] as never)
    db.campaignRuleAssignment.findMany.mockResolvedValue([
      { ruleId: 'rule-1', campaignId: 'c2' }, { ruleId: 'rule-1', campaignId: 'c1' },
    ] as never)
    db.campaign.findMany.mockResolvedValue([] as never)

    const r = await syncBuilderRuleFromAssignments(['rule-1'])

    expect(r.updated).toEqual([])
    expect(db.automationRule.update).not.toHaveBeenCalled()
  })

  it('leaves engine-native budget rules alone — they are governed by the table it just wrote', async () => {
    db.automationRule.findMany.mockResolvedValue([
      { id: 'rule-e', actions: [{ type: 'adjust_ad_budget', percent: 10 }] },
    ] as never)

    const r = await syncBuilderRuleFromAssignments(['rule-e'])

    expect(r.updated).toEqual([])
    expect(db.automationRule.update).not.toHaveBeenCalled()
    expect(db.campaignRuleAssignment.findMany).not.toHaveBeenCalled()
  })
})

describe('round trip', () => {
  it('save → mirror → column edit → inverse mirror lands on ONE list both sides agree on', async () => {
    // 1. Builder saves a rule bound to c1.
    db.campaign.findMany.mockResolvedValue([{ id: 'c1' }] as never)
    db.campaignRuleAssignment.findMany.mockResolvedValue([] as never)
    db.campaignRuleAssignment.createMany.mockResolvedValue({ count: 1 } as never)
    await syncRuleCampaignBinding('rule-1', builderBudget(['c1']))
    expect((db.campaignRuleAssignment.createMany.mock.calls[0][0].data as Array<Record<string, unknown>>)[0].campaignId).toBe('c1')

    // 2. The column adds c2; the inverse mirror rewrites the rule.
    vi.clearAllMocks()
    db.automationRule.findMany.mockResolvedValue([{ id: 'rule-1', actions: builderBudget(['c1']) }] as never)
    db.campaignRuleAssignment.findMany.mockResolvedValue([
      { ruleId: 'rule-1', campaignId: 'c1' }, { ruleId: 'rule-1', campaignId: 'c2' },
    ] as never)
    db.campaign.findMany.mockResolvedValue([
      { id: 'c1', name: 'One', marketplace: 'IT', status: 'ENABLED', targetingType: 'MANUAL', adProduct: 'SP', dailyBudget: 5, portfolioId: null },
      { id: 'c2', name: 'Two', marketplace: 'IT', status: 'ENABLED', targetingType: 'MANUAL', adProduct: 'SP', dailyBudget: 5, portfolioId: null },
    ] as never)
    await syncBuilderRuleFromAssignments(['rule-1'])

    // 3. What the ENGINE now reads off the rule is the column's decision.
    const written = db.automationRule.update.mock.calls[0][0].data.actions
    expect(builderBudgetCampaignIds(written)!.sort()).toEqual(['c1', 'c2'])
  })
})
