/**
 * CC-15 — the autopilot's linked harvest/negative rules.
 *
 *   · A plan with NO campaigns gets no rule (the SP Super Wizard's AI Control created every plan with `campaignIds: []`,
 *     and this file then created rules that read every search term in the market). It says so once in the plan's feed.
 *   · A plan with campaigns gets rules carrying exactly those `campaignIds` (which `builderScopeCampaignIds` now binds).
 *   · A rule a PERSON switched off in Rules stays off: the sync used to re-enable it every 15 minutes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  automationRule: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
  autopilotDecision: { findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
  adsRuleSuggestion: { findMany: vi.fn() },
}))
vi.mock('../../../db.js', () => ({ default: db }))

import { syncLinkedRules } from './coordination.js'
import { builderScopeCampaignIds } from '../ads-rule-adapter.service.js'

const plan = (over: Record<string, unknown> = {}) => ({
  id: 'plan-1', name: 'Gale', marketplace: 'DE', goal: 'BALANCED', autonomy: 'SUGGEST',
  campaignIds: ['c1', 'c2'], modules: {}, linkedRuleIds: [], ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  db.automationRule.create.mockImplementation(async ({ data }: { data: { name: string } }) => ({ id: `rule-${data.name.includes('Harvest') ? 'h' : 'n'}` }))
  db.automationRule.update.mockResolvedValue({})
  db.autopilotDecision.findFirst.mockResolvedValue(null)
  db.autopilotDecision.create.mockResolvedValue({})
})

describe('CC-15 — provisioning', () => {
  it('🔴 a plan with no campaigns gets NO harvest/negative rule, and its feed says why (once per sentence)', async () => {
    const links = await syncLinkedRules(plan({ campaignIds: [] }))
    expect(links).toEqual([])
    expect(db.automationRule.create).not.toHaveBeenCalled()
    expect(db.autopilotDecision.create).toHaveBeenCalledTimes(2)
    expect(db.autopilotDecision.create.mock.calls[0][0].data).toMatchObject({ planId: 'plan-1', module: 'harvest', action: 'NOOP', status: 'SKIPPED', reason: 'No harvest rule was created: this plan lists no campaigns.' })

    vi.clearAllMocks()
    db.autopilotDecision.findFirst.mockResolvedValue({ reason: 'No harvest rule was created: this plan lists no campaigns.' })
    await syncLinkedRules(plan({ campaignIds: [], modules: { negate: { on: false } } }))
    expect(db.autopilotDecision.create).not.toHaveBeenCalled()
  })

  it('a plan with campaigns gets rules bound to exactly those campaigns, scoped to its market', async () => {
    const links = await syncLinkedRules(plan())
    expect(db.automationRule.create).toHaveBeenCalledTimes(2)
    for (const [{ data }] of db.automationRule.create.mock.calls) {
      expect(data.scopeMarketplace).toBe('DE')
      expect(data.actions[0].campaignIds).toEqual(['c1', 'c2'])
      // …and the engine reads that list as the rule's scope.
      expect(builderScopeCampaignIds(data.actions)).toEqual(['c1', 'c2'])
    }
    expect(links).toEqual([
      { module: 'harvest', ruleId: 'rule-h', syncedEnabled: true },
      { module: 'negate', ruleId: 'rule-n', syncedEnabled: true },
    ])
  })
})

describe('CC-15 — a rule a person switched off stays off', () => {
  const legacy = (enabled: boolean) => ({ id: 'rule-h', name: 'Autopilot · Harvest — Gale', enabled, actions: [{ type: 'keyword-harvesting', control: 'manual', campaignIds: ['c1', 'c2'] }] })

  it('🔴 found OFF while the sync last left it ON → not re-enabled, remembered, said once in the feed', async () => {
    db.automationRule.findUnique.mockResolvedValue(legacy(false))
    const links = await syncLinkedRules(plan({ modules: { negate: { on: false } }, linkedRuleIds: [{ module: 'harvest', ruleId: 'rule-h', syncedEnabled: true }] }))
    expect(db.automationRule.update).not.toHaveBeenCalled()
    expect(links).toEqual([{ module: 'harvest', ruleId: 'rule-h', syncedEnabled: true, personOff: true }])
    expect(db.autopilotDecision.create.mock.calls[0][0].data.reason).toMatch(/was switched off in Rules\. The plan leaves it off/)
  })

  it('a link made before this (no recorded value) is treated the same way: off stays off', async () => {
    db.automationRule.findUnique.mockResolvedValue(legacy(false))
    const links = await syncLinkedRules(plan({ modules: { negate: { on: false } }, linkedRuleIds: [{ module: 'harvest', ruleId: 'rule-h' }] }))
    expect(db.automationRule.update).not.toHaveBeenCalled()
    expect(links[0].personOff).toBe(true)
  })

  it('stays off on later ticks without touching the rule', async () => {
    db.automationRule.findUnique.mockResolvedValue(legacy(false))
    const links = await syncLinkedRules(plan({ modules: { negate: { on: false } }, linkedRuleIds: [{ module: 'harvest', ruleId: 'rule-h', syncedEnabled: true, personOff: true }] }))
    expect(db.automationRule.update).not.toHaveBeenCalled()
    expect(db.autopilotDecision.create).not.toHaveBeenCalled()
    expect(links[0]).toMatchObject({ personOff: true })
  })

  it('switched on again by a person → handed back to the plan and synced', async () => {
    db.automationRule.findUnique.mockResolvedValue(legacy(true))
    const links = await syncLinkedRules(plan({ modules: { negate: { on: false } }, linkedRuleIds: [{ module: 'harvest', ruleId: 'rule-h', syncedEnabled: true, personOff: true }] }))
    expect(db.automationRule.update).toHaveBeenCalledTimes(1)
    expect(links).toEqual([{ module: 'harvest', ruleId: 'rule-h', syncedEnabled: true }])
  })

  it('OFF because the sync itself turned it off (module was off) → the plan turns it back on as before', async () => {
    db.automationRule.findUnique.mockResolvedValue(legacy(false))
    const links = await syncLinkedRules(plan({ modules: { negate: { on: false } }, linkedRuleIds: [{ module: 'harvest', ruleId: 'rule-h', syncedEnabled: false }] }))
    expect(db.automationRule.update).toHaveBeenCalledTimes(1)
    expect(db.automationRule.update.mock.calls[0][0].data).toMatchObject({ enabled: true })
    expect(links).toEqual([{ module: 'harvest', ruleId: 'rule-h', syncedEnabled: true }])
  })

  it('the goal-materialized shape (harvest_and_negate) keeps a person\'s OFF too', async () => {
    db.automationRule.findUnique.mockResolvedValue({ id: 'rule-h', name: 'Goal — Harvest', enabled: false, actions: [{ type: 'harvest_and_negate', sources: [] }] })
    await syncLinkedRules(plan({ modules: { negate: { on: false } }, linkedRuleIds: [{ module: 'harvest', ruleId: 'rule-h', syncedEnabled: true }] }))
    expect(db.automationRule.update).not.toHaveBeenCalled()
  })
})

describe('CC-15 — an existing legacy rule of a plan with no campaigns', () => {
  it('is rewritten with the empty list (which now binds it to no campaign) and the feed says it acts on none', async () => {
    db.automationRule.findUnique.mockResolvedValue({ id: 'rule-h', name: 'Autopilot · Harvest — Gale', enabled: true, actions: [{ type: 'keyword-harvesting', campaignIds: [] }] })
    await syncLinkedRules(plan({ campaignIds: [], modules: { negate: { on: false } }, linkedRuleIds: [{ module: 'harvest', ruleId: 'rule-h', syncedEnabled: true }] }))
    const data = db.automationRule.update.mock.calls[0][0].data
    expect(data.actions[0].campaignIds).toEqual([])
    expect(builderScopeCampaignIds(data.actions)).toEqual([])
    expect(db.autopilotDecision.create.mock.calls[0][0].data.reason).toMatch(/lists no campaigns, so its harvest rule .* acts on none/)
  })
})
