/**
 * D-PLC-2 — a Placement rule may not be armed to AUTO against the rank engine.
 *
 * The verdict is pure and tested here without a database, because the part that matters to an
 * operator is the SENTENCE: a refusal that does not say what to do instead is the silent-refusal
 * defect wearing a different hat.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 4e — the reads behind the check, and the rule edit that demotes; the pure tests above them touch none of these.
const h = vi.hoisted(() => ({
  schedFindMany: vi.fn(), targetFindMany: vi.fn(), eventFindMany: vi.fn(), campFindMany: vi.fn(),
  ruleFindUnique: vi.fn(), ruleUpdate: vi.fn(), logCreate: vi.fn(),
}))
vi.mock('../../db.js', () => ({
  default: {
    adSchedule: { findMany: h.schedFindMany },
    rankTarget: { findMany: h.targetFindMany },
    rankScheduleEvent: { findMany: h.eventFindMany },
    campaign: { findMany: h.campFindMany },
    automationRule: { findUnique: h.ruleFindUnique, update: h.ruleUpdate },
    advertisingActionLog: { create: h.logCreate },
  },
}))
vi.mock('./rule-campaign-binding.service.js', () => ({ syncRuleCampaignBinding: vi.fn(async () => undefined) }))

import { placementAutoVerdict, ENGINE_CONTESTED_LANES, placementLanesOf, contestedLaneSkipReason, checkPlacementAutoAllowed } from './ads-placement-autonomy.js'
import { updateAdsRule } from './ads-rule-crud.service.js'

const TOP = 'PLACEMENT_TOP'
const REST = 'PLACEMENT_REST_OF_SEARCH'
const PDP = 'PLACEMENT_PRODUCT_PAGE'

describe('which lanes the engine contests', () => {
  it('🔴 Product Pages is NOT contested — 2 engine writes in 30 days against 12,197 on Top of Search', () => {
    expect(ENGINE_CONTESTED_LANES).toContain(TOP)
    expect(ENGINE_CONTESTED_LANES).toContain(REST)
    expect(ENGINE_CONTESTED_LANES).not.toContain(PDP)
  })
})

describe('the verdict', () => {
  it('refuses a Top of Search rule on a governed campaign', () => {
    const v = placementAutoVerdict([TOP], ['GALE BROAD IT'])
    expect(v.blocked).toBe(true)
    expect(v.message).toContain('Top of Search')
    expect(v.message).toContain('GALE BROAD IT')
  })

  it('🔴 ALLOWS a Product Pages rule on the same governed campaign — the exception is the point', () => {
    const v = placementAutoVerdict([PDP], ['GALE BROAD IT'])
    expect(v.blocked).toBe(false)
  })

  it('allows a contested lane when NO campaign is governed', () => {
    expect(placementAutoVerdict([TOP, REST], []).blocked).toBe(false)
  })

  it('refuses a multi-block rule if ANY block writes a contested lane', () => {
    // one block on Product Pages, one on Rest of Search: the second is a write loop on its own
    expect(placementAutoVerdict([PDP, REST], ['X']).blocked).toBe(true)
  })

  it('names both lanes when the rule writes both', () => {
    const v = placementAutoVerdict([TOP, REST], ['X'])
    expect(v.message).toContain('Top of Search and Rest of Search')
    expect(v.message).toContain('those lanes')
  })

  describe('the sentence has to be actionable, not just correct', () => {
    const v = placementAutoVerdict([TOP], ['A', 'B', 'C', 'D', 'E'])
    it('says WHY, in terms of what the operator will observe', () => {
      expect(v.message).toMatch(/reverted within the hour/)
    })
    it('offers BOTH ways out — the mode, and the picker', () => {
      expect(v.message).toMatch(/Manual/)
      expect(v.message).toMatch(/remove those campaigns/)
    })
    it('names the lane that WOULD work rather than leaving a dead end', () => {
      expect(v.message).toContain('Product Pages')
    })
    it('names a few campaigns and counts the rest, instead of printing all of them', () => {
      expect(v.message).toContain('A, B, C')
      expect(v.message).toContain('and 2 more')
    })
    it('gets the singular right for one campaign', () => {
      const one = placementAutoVerdict([TOP], ['Solo'])
      expect(one.message).toContain('1 campaign that')
      expect(one.message).toContain('remove that campaign')
    })
  })
})

describe('placementLanesOf', () => {
  it('reads the lane an engine-native rule carries on its action', () => {
    expect(placementLanesOf({ id: 'r', actions: [{ type: 'placement_apply', placement: REST }] })).toEqual([REST])
  })
  it('returns nothing for a rule that names no lane, rather than guessing Top of Search', () => {
    expect(placementLanesOf({ id: 'r', actions: [{ type: 'budget_apply' }] })).toEqual([])
  })
})

/**
 * 4e (review 5.3) — Product Pages is contested where the schedule can hold a BLEND, and an edit can no longer leave an
 * AUTO placement rule writing a lane the engine holds.
 */
describe('4e — Product Pages under a blend', () => {
  it('the verdict refuses Product Pages when the engine writes it there, and stops offering it as the way out', () => {
    const v = placementAutoVerdict([PDP], ['GALE BROAD IT'], [TOP, REST, PDP])
    expect(v.blocked).toBe(true)
    expect(v.message).toContain('Product Pages on 1 campaign')
    expect(v.message).toMatch(/Product Pages does not hold here either: the hourly plan on that campaign is a blend/)
    expect(v.message).not.toMatch(/the one lane the rank engine does not touch/)
  })

  it('the skip sentence names the lane, the cause and both ways out', () => {
    expect(contestedLaneSkipReason(TOP)).toBe(
      'Rank & Dayparting controls Top of Search on this campaign: it rewrites that lane every time it runs, so this rule did not write it — '
      + 'the change would be reverted within the hour. Set the rule to Manual to approve such changes yourself, '
      + 'or remove this campaign from the rule.',
    )
    expect(contestedLaneSkipReason(PDP)).toMatch(/Product Pages on this campaign: its hourly plan here is a blend, which sets every lane it does not name to 0/)
  })
})

const pdpRule = (extra: Record<string, unknown> = {}) => ({
  id: 'r-pdp', domain: 'advertising', name: 'Raise Product Pages — GALE', enabled: true, dryRun: false, autonomyLevel: 'AUTO',
  actions: [{ type: 'placement', campaigns: [{ id: 'c1' }], placeFloor: 0, placeCeiling: 900 }],
  conditions: [{ match: 'all', action: { op: 'set', value: '25', placeTarget: 'pdp' }, conditions: [{ metric: 'ACOS', op: 'lte', value: '20' }] }],
  ...extra,
})
const schedule = (targetKey: string) => [{ campaignId: 'c1', windows: [{ days: [1], startHour: 8, endHour: 20, targetKey }], defaultTargetKey: null, targetOverrides: {}, groupId: null }]

describe('4e — checkPlacementAutoAllowed reads the blend', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.eventFindMany.mockResolvedValue([])
    h.campFindMany.mockResolvedValue([{ name: 'GALE BROAD IT' }])
  })

  it('🔴 refuses AUTO on a Product Pages rule whose picked campaign holds a blend', async () => {
    h.schedFindMany.mockResolvedValue(schedule('blend-day'))
    h.targetFindMany.mockResolvedValue([{ key: 'blend-day', placement: TOP, lanes: [{ placement: TOP, biasPct: 100 }] }])
    const v = await checkPlacementAutoAllowed(pdpRule(), 'AUTO', ['placement_apply'])
    expect(v.blocked).toBe(true)
    expect(v.lanes).toEqual([PDP])
    expect(h.schedFindMany.mock.calls[0][0].where).toEqual({ enabled: true, campaignId: { in: ['c1'] } })
  })

  it('allows it under a single Top of Search target, as before', async () => {
    h.schedFindMany.mockResolvedValue(schedule('own-top'))
    h.targetFindMany.mockResolvedValue([{ key: 'own-top', placement: TOP, lanes: null }])
    expect((await checkPlacementAutoAllowed(pdpRule(), 'AUTO', ['placement_apply'])).blocked).toBe(false)
  })
})

describe('4e — an edit that makes an AUTO placement rule contested moves it back to PROPOSE', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.eventFindMany.mockResolvedValue([])
    h.campFindMany.mockResolvedValue([{ name: 'GALE BROAD IT' }])
    h.logCreate.mockResolvedValue({})
    h.schedFindMany.mockResolvedValue(schedule('blend-day'))
    h.targetFindMany.mockResolvedValue([{ key: 'blend-day', placement: TOP, lanes: [{ placement: TOP, biasPct: 100 }] }])
  })

  it('🔴 demotes, writes the audit row with the reason, and returns the demoted rule', async () => {
    const before = pdpRule({ actions: [{ type: 'placement', campaigns: [{ id: 'c9' }], placeFloor: 0, placeCeiling: 900 }] })
    h.ruleFindUnique.mockResolvedValue(before)
    h.ruleUpdate
      .mockResolvedValueOnce(pdpRule()) // the edit: picker widened to c1
      .mockResolvedValueOnce(pdpRule({ autonomyLevel: 'PROPOSE', dryRun: true }))
    const out = await updateAdsRule('r-pdp', { actions: pdpRule().actions }, 'user:owner')
    expect(out.ok).toBe(true)
    expect(h.ruleUpdate).toHaveBeenCalledTimes(2)
    expect(h.ruleUpdate.mock.calls[1][0]).toEqual({ where: { id: 'r-pdp' }, data: { autonomyLevel: 'PROPOSE', dryRun: true } })
    const audit = h.logCreate.mock.calls.map(([a]) => a.data).find((d) => d.actionType === 'set_rule_autonomy')
    expect(audit.payloadAfter).toEqual({ level: 'PROPOSE', dryRun: true })
    expect(audit.evidence.note).toMatch(/→ PROPOSE after an edit: This rule writes Product Pages/)
    expect((out as { value: { rule: { autonomyLevel: string } } }).value.rule.autonomyLevel).toBe('PROPOSE')
  })

  it('leaves a PROPOSE rule alone — a proposal is a person’s write', async () => {
    h.ruleFindUnique.mockResolvedValue(pdpRule({ autonomyLevel: 'PROPOSE', dryRun: true }))
    h.ruleUpdate.mockResolvedValueOnce(pdpRule({ autonomyLevel: 'PROPOSE', dryRun: true }))
    await updateAdsRule('r-pdp', { actions: pdpRule().actions }, 'user:owner')
    expect(h.ruleUpdate).toHaveBeenCalledTimes(1)
    expect(h.schedFindMany).not.toHaveBeenCalled()
  })

  it('a rename does not re-judge the level', async () => {
    h.ruleFindUnique.mockResolvedValue(pdpRule())
    h.ruleUpdate.mockResolvedValueOnce(pdpRule({ name: 'Renamed' }))
    await updateAdsRule('r-pdp', { name: 'Renamed' }, 'user:owner')
    expect(h.ruleUpdate).toHaveBeenCalledTimes(1)
    expect(h.schedFindMany).not.toHaveBeenCalled()
  })
})
