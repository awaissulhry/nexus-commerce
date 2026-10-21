/**
 * Meta step 21 — set-meta-value-rules as a draft (pure): sets made and changed as Meta takes them (a kept rule and criterion
 * by id), deleted only on explicit ask, attached only to an ad set Meta allows (bid strategy, special categories, legacy bid
 * multipliers replaced only on ask), detached with ONLY value_rules_applied=false, translated without making anything; what
 * can raise bids is SPENDS MONEY, with paused wording when no ad set using it is on; every request judged by the gateway.
 * Made-up ids.
 */
import { describe, expect, it } from 'vitest'
import { onlyLowers, undoRulesOf, valueRulesDraft, wireRules, type RecordedRule, type ValueRuleAsk, type ValueRulesLive, type ValueRulesRequest } from './change-value-rules.js'
import type { MetaChangeDraft, MetaChangeRequest } from './change-draft.js'
import type { LiveRuleSet, RulesAdSet } from './live-labels-rules.js'
import { metaWriteVerdict } from '../../gateway/meta-calls.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../../meta/api-version.js'

const SET = '120000000000080'
const SET2 = '120000000000081'
const S = '120000000000002'
const RAISE: LiveRuleSet = {
  id: SET, name: 'Set A', status: 'ACTIVE', productType: null,
  rules: [{ id: '120000000000082', name: 'Young', sign: 'INCREASE', percent: 20, status: 'ACTIVE', criteria: [{ id: '120000000000083', type: 'AGE', values: ['18-24'], valueTypes: ['NONE'] }] }],
}
const LOWER: LiveRuleSet = {
  id: SET2, name: 'Set B', status: 'ACTIVE', productType: null,
  rules: [{ id: '120000000000084', name: 'Desktop', sign: 'DECREASE', percent: 30, status: 'ACTIVE', criteria: [{ id: '120000000000085', type: 'DEVICE_PLATFORM', values: ['DESKTOP'], valueTypes: ['NONE'] }] }],
}
const AD_SET: RulesAdSet = {
  id: S, name: 'Ad set B', status: 'ACTIVE', effectiveStatus: 'ACTIVE', bidStrategy: 'LOWEST_COST_WITHOUT_CAP', legacyBidMultipliers: null, valueRuleSetId: null, valueRulesApplied: null, rfPredictionId: null,
  campaign: { id: '120000000000001', name: 'Campaign A', status: 'ACTIVE', buyingType: 'AUCTION', bidStrategy: null, specialAdCategories: [] },
}
const LIVE: ValueRulesLive = { adAccountId: '1234567890', ruleSets: [RAISE, LOWER], users: [], usersMore: false, adSet: AD_SET }
const draft = (r: ValueRulesRequest, live: Partial<ValueRulesLive> = {}) => valueRulesDraft(r, { ...LIVE, ...live })
const ok = (r: ValueRulesRequest, live: Partial<ValueRulesLive> = {}) => { const d = draft(r, live); if ('refusal' in d) throw new Error(d.refusal); return d }
const no = (r: ValueRulesRequest, live: Partial<ValueRulesLive> = {}) => { const d = draft(r, live); return 'refusal' in d ? d.refusal : null }
const judged = (q: MetaChangeRequest) => metaWriteVerdict({
  method: q.method ?? 'POST', url: `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}/${q.objectId}${q.edge ? `/${q.edge}` : ''}`, kind: 'write',
  body: Object.keys(q.params).length ? new URLSearchParams(q.params).toString() : undefined, objectKind: q.objectKind ?? q.kind,
})
const rule = (d: MetaChangeDraft) => { const v = judged(d.requests[0]); return 'write' in v ? v.write.rule : v.problem }
const young: ValueRuleAsk = { name: 'Young', adjust: 'INCREASE', percent: 20, criteria: [{ type: 'AGE', values: ['18-24'] }] }

describe('a set made or changed', () => {
  it('create: Meta\'s shape (criterias, CONTAINS, NONE types; a LOCATION its own types); nothing spends (no ad set uses it)', () => {
    const d = ok({ action: 'create', name: 'Set C', rules: [young, { name: 'Italy', adjust: 'DECREASE', percent: 10, criteria: [{ type: 'LOCATION', values: ['IT', '527'], locationTypes: ['LOCATION_COUNTRY', 'LOCATION_REGION'] }] }] })
    expect(JSON.parse(d.requests[0].params.rules)).toEqual([
      { name: 'Young', adjust_sign: 'INCREASE', adjust_value: 20, criterias: [{ criteria_type: 'AGE', operator: 'CONTAINS', criteria_values: ['18-24'], criteria_value_types: ['NONE'] }] },
      { name: 'Italy', adjust_sign: 'DECREASE', adjust_value: 10, criterias: [{ criteria_type: 'LOCATION', operator: 'CONTAINS', criteria_values: ['IT', '527'], criteria_value_types: ['LOCATION_COUNTRY', 'LOCATION_REGION'] }] },
    ])
    expect(d.requests[0]).toMatchObject({ objectId: 'act_1234567890', edge: 'value_rule_set', objectKind: 'adaccount', check: 'none', raisesSpend: false })
    expect(rule(d)).toBe('valueruleset.create')
    expect(d.spendsMoney).toEqual([])
    expect(no({ action: 'create', name: 'x', rules: [{ ...young, criteria: [{ type: 'LOCATION', values: ['IT'] }] }] })).toMatch(/one location type per value/)
    expect(no({ action: 'create', name: 'x', rules: [{ ...young, percent: 95, adjust: 'DECREASE' }] })).toMatch(/1 to 90/)
    expect(no({ action: 'create', name: 'x', rules: [young] }, { ruleSets: Array.from({ length: 20 }, (_, i) => ({ ...RAISE, id: String(1000 + i) })) })).toMatch(/Meta allows 20/)
  })
  it('change: the whole set, a kept rule and its criterion by id (+ its status); a set some ad set uses — SPENDS MONEY unless it only lowers', () => {
    const users = [{ id: S, name: 'Ad set B', status: 'ACTIVE', campaignStatus: 'ACTIVE', valueRuleSetId: SET }]
    const up = ok({ action: 'change', ruleSetId: SET, rules: [{ ...young, ruleId: '120000000000082', percent: 50 }] }, { users })
    expect(JSON.parse(up.requests[0].params.rules)).toEqual([{ id: '120000000000082', name: 'Young', adjust_sign: 'INCREASE', adjust_value: 50, status: 'ACTIVE', criterias: [{ id: '120000000000083', criteria_type: 'AGE', operator: 'CONTAINS', criteria_values: ['18-24'], criteria_value_types: ['NONE'] }] }])
    expect(up.requests[0]).toMatchObject({ objectId: SET, objectKind: 'valueruleset', raisesSpend: true, params: { name: 'Set A' } })
    expect(up.spendsMoney.join(' ')).toMatch(/1 ad set using it is on .*bids can go up for some people from now/)
    expect(rule(up)).toBe('valueruleset.update')
    const down = ok({ action: 'change', ruleSetId: SET, rules: [{ ...young, ruleId: '120000000000082', percent: 10 }] }, { users })
    expect(down.spendsMoney).toEqual([])
    const paused = ok({ action: 'change', ruleSetId: SET, rules: [{ ...young, ruleId: '120000000000082', percent: 50 }] }, { users: [{ ...users[0], campaignStatus: 'PAUSED' }] })
    expect(paused.spendsMoney.join(' ')).toMatch(/nothing spends yet/)
    expect(no({ action: 'change', ruleSetId: SET, rules: [{ ...young, ruleId: '120000000000082' }] })).toMatch(/Nothing to change/)
    // More than 500 ad sets: one Nexus did not read may use it and be on.
    expect(ok({ action: 'change', ruleSetId: SET, rules: [{ ...young, ruleId: '120000000000082', percent: 50 }] }, { users: [], usersMore: true }).spendsMoney.join(' ')).toMatch(/first 500 ad sets .* may be on/)
    expect(ok({ action: 'change', ruleSetId: SET, rules: [{ ...young, ruleId: '120000000000082', percent: 50 }] }).spendsMoney).toEqual([])
    expect(no({ action: 'change', ruleSetId: SET, rules: [{ ...young, ruleId: '5555555555' }] })).toMatch(/not a rule of value rule set/)
    expect(no({ action: 'change', ruleSetId: '5555555555', rules: [young] })).toMatch(/not a value rule set of the chosen ad account/)
  })
  it('only lowers = same rules, order and criteria, no adjustment higher', () => {
    const r = (sign: string, percent: number, values = ['18-24']): RecordedRule => ({ id: null, name: 'R', sign, percent, criteria: [{ type: 'AGE', values, valueTypes: ['NONE'] }] })
    expect(onlyLowers([r('INCREASE', 20)], [r('INCREASE', 10)])).toBe(true)
    expect(onlyLowers([r('INCREASE', 20)], [r('DECREASE', 10)])).toBe(true)
    expect(onlyLowers([r('DECREASE', 20)], [r('DECREASE', 10)])).toBe(false)
    expect(onlyLowers([r('INCREASE', 20)], [r('INCREASE', 10, ['25-34'])])).toBe(false)
    expect(onlyLowers([r('DECREASE', 20)], [])).toBe(false)
  })
  it('undo of a change: the earlier rules; a rule still in the set by its id, one removed since as a new rule', () => {
    const before: RecordedRule[] = [{ id: '120000000000086', name: 'Kept', sign: 'INCREASE', percent: 20, criteria: [{ type: 'LOCATION', values: ['IT'], valueTypes: ['LOCATION_COUNTRY'] }] }, { id: '120000000000087', name: 'Gone', sign: 'DECREASE', percent: 5, criteria: [{ type: 'GENDER', values: ['MALE'], valueTypes: ['NONE'] }] }]
    const after: RecordedRule[] = [{ ...before[0], percent: 40 }]
    expect(undoRulesOf(before, after)).toEqual([
      { ruleId: '120000000000086', name: 'Kept', adjust: 'INCREASE', percent: 20, criteria: [{ type: 'LOCATION', values: ['IT'], locationTypes: ['LOCATION_COUNTRY'] }] },
      { name: 'Gone', adjust: 'DECREASE', percent: 5, criteria: [{ type: 'GENDER', values: ['MALE'] }] },
    ])
    expect('value' in wireRules(undoRulesOf(before, after), { ...RAISE, rules: [{ ...RAISE.rules[0], id: '120000000000086' }] })).toBe(true)
  })
})

describe('a set deleted', () => {
  it('only on explicit ask; an empty POST to delete_rule_set; the ad sets using it listed; a set that lowered bids SPENDS MONEY', () => {
    expect(no({ action: 'delete', ruleSetId: SET2 })).toMatch(/explicitly asked to delete it \(confirmDelete: true\)/)
    const users = [{ id: S, name: 'Ad set B', status: 'ACTIVE', campaignStatus: 'ACTIVE', valueRuleSetId: SET2 }]
    const d = ok({ action: 'delete', ruleSetId: SET2, confirmDelete: true }, { users })
    expect(d.requests[0]).toMatchObject({ objectId: SET2, objectKind: 'valueruleset', edge: 'delete_rule_set', params: {}, undoable: false, raisesSpend: true })
    expect(rule(d)).toBe('valueruleset.delete')
    expect(d.alsoDeleted).toEqual({ usedBy: [{ id: S, name: 'Ad set B', status: 'ACTIVE' }], more: false })
    expect(d.warnings.join(' ')).toMatch(/DELETING IS FINAL/)
    expect(ok({ action: 'delete', ruleSetId: SET, confirmDelete: true }).spendsMoney).toEqual([])
  })
})

describe('an ad set: attach, detach, translate', () => {
  it('attach: the set + value_rules_applied=true; a set that raises SPENDS MONEY (paused wording when the ad set is off); undo detaches', () => {
    const d = ok({ action: 'attach', adSetId: S, ruleSetId: SET })
    expect(d.requests[0]).toMatchObject({ objectId: S, kind: 'adset', params: { value_rule_set_id: SET, value_rules_applied: 'true' }, raisesSpend: true, expect: { value_rule_set_id: SET } })
    expect(rule(d)).toBe('adset.valueRules.attach')
    expect(d.spendsMoney.join(' ')).toMatch(/raises bids for some people: ad set "Ad set B" \(120000000000002\) is on/)
    expect(ok({ action: 'attach', adSetId: S, ruleSetId: SET }, { adSet: { ...AD_SET, status: 'PAUSED' } }).spendsMoney.join(' ')).toMatch(/nothing spends yet/)
    expect(ok({ action: 'attach', adSetId: S, ruleSetId: SET2 }).spendsMoney).toEqual([])
    expect(d.before).toEqual({ op: 'attach', adSet: { id: S, valueRuleSetId: null } })
  })
  it('attach refused where Meta refuses: a ROAS goal or bid cap, AGE / GENDER in a housing, employment or credit campaign, legacy multipliers not asked to go', () => {
    expect(no({ action: 'attach', adSetId: S, ruleSetId: SET }, { adSet: { ...AD_SET, bidStrategy: 'LOWEST_COST_WITH_MIN_ROAS' } })).toMatch(/takes value rules only with LOWEST_COST_WITHOUT_CAP or COST_CAP/)
    expect(no({ action: 'attach', adSetId: S, ruleSetId: SET }, { adSet: { ...AD_SET, campaign: { ...AD_SET.campaign, specialAdCategories: ['HOUSING'] } } })).toMatch(/AGE or GENDER/)
    const legacy = { ...AD_SET, legacyBidMultipliers: { age: { '18-24': 0.5 } } }
    expect(no({ action: 'attach', adSetId: S, ruleSetId: SET2 }, { adSet: legacy })).toMatch(/replaceLegacyBidMultipliers: true/)
    const d = ok({ action: 'attach', adSetId: S, ruleSetId: SET2, replaceLegacyBidMultipliers: true }, { adSet: legacy })
    expect(d.requests[0].params).toEqual({ value_rule_set_id: SET2, value_rules_applied: 'true', bid_adjustments: '{}' })
    expect(rule(d)).toBe('adset.valueRules.attach')
    expect(d.spendsMoney.join(' ')).toMatch(/legacy bid multipliers go/)
    expect(d.before).toMatchObject({ noUndo: [expect.stringMatching(/cannot be undone by Nexus/)] })
    expect(no({ action: 'attach', adSetId: S, ruleSetId: SET }, { adSet: { ...AD_SET, valueRuleSetId: SET } })).toMatch(/Nothing to change/)
  })
  it('detach: ONLY value_rules_applied=false; a set that lowered bids SPENDS MONEY; nothing attached is said', () => {
    const d = ok({ action: 'detach', adSetId: S }, { adSet: { ...AD_SET, valueRuleSetId: SET2 } })
    expect(d.requests[0]).toMatchObject({ params: { value_rules_applied: 'false' }, raisesSpend: true, expect: { value_rules_applied: 'false' } })
    expect(Object.keys(d.requests[0].params)).toEqual(['value_rules_applied'])
    expect(rule(d)).toBe('adset.valueRules.detach')
    expect(ok({ action: 'detach', adSetId: S }, { adSet: { ...AD_SET, valueRuleSetId: SET } }).spendsMoney).toEqual([])
    expect(no({ action: 'detach', adSetId: S })).toMatch(/uses no value rule set/)
    expect(no({ action: 'detach', adSetId: S }, { adSet: { ...AD_SET, valueRuleSetId: SET, valueRulesApplied: false } })).toMatch(/uses no value rule set/)
  })
  it('translate: the ad set\'s legacy multipliers into a proposal on act_<id>/value_rule_set_translation; nothing made, nothing spent', () => {
    expect(no({ action: 'translate', adSetId: S })).toMatch(/no legacy bid multipliers/)
    const d = ok({ action: 'translate', adSetId: S }, { adSet: { ...AD_SET, legacyBidMultipliers: { age: { '18-24': 0.5 } } } })
    expect(d.requests[0]).toMatchObject({ objectId: 'act_1234567890', edge: 'value_rule_set_translation', params: { source: JSON.stringify({ bid_multiplier_ad_set_id: S }) }, raisesSpend: false })
    expect(rule(d)).toBe('valueruleset.translate')
    expect(d.spendsMoney).toEqual([])
  })
})
