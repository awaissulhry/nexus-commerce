/**
 * Meta step 29 — Meta's automated rules as pure drafts: a new rule is made OFF unless asked, every spec built in Meta's
 * shape with money in its base unit (from minor units), Meta's rules for each kind of rule said in words before anything
 * is sent; an update sends the whole rule (the parts not named exactly as Meta has them); SPENDS MONEY for a switch-on,
 * a run or a making-on that can raise spend, and for removing a brake; undo records that parse again. Made-up ids.
 */
import { describe, expect, it } from 'vitest'
import { adRuleDraft, removeRuleDraft, ruleInputOf, specsOf, RuleRefusal, type AdRuleRequest, type RuleDraftContext } from './change-ad-rule.js'
import { mapRule } from './live-optimize.js'
import type { LiveRule } from './live-rules.js'
import type { MetaChosenAccount } from './live.js'
import { wholeRuleSpecsProblem } from '../../gateway/meta-ad-rule-rules.js'

const RULE = '120000000000101'
const AD_SET = '120000000000002'
const chosen = (currency = 'EUR') => ({ connection: { systemUser: { id: '100009' } }, connectionId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency, timeZone: 'Europe/Rome', businessId: null, pageId: null, instagramId: null }) as unknown as MetaChosenAccount
const words = (currency = 'EUR') => (raw: Record<string, unknown>) => mapRule(raw, chosen(currency))

const EVAL = { evaluation_type: 'SCHEDULE', filters: [{ field: 'entity_type', value: 'ADSET', operator: 'EQUAL' }, { field: 'time_preset', value: 'LAST_7D', operator: 'EQUAL' }, { field: 'cost_per_purchase_fb', value: 2500, operator: 'GREATER_THAN' }] }
// Meta may send an option's value back as a JSON string.
const CUT = { execution_type: 'CHANGE_BUDGET', execution_options: [{ field: 'change_spec', value: '{"amount":-20,"unit":"PERCENTAGE"}', operator: 'EQUAL' }] }
const RAISE = { execution_type: 'CHANGE_BUDGET', execution_options: [{ field: 'change_spec', value: { amount: 20, unit: 'PERCENTAGE', limit: 20000 }, operator: 'EQUAL' }] }
const live = (o: Partial<LiveRule> & { execution?: Record<string, unknown>; evaluation?: Record<string, unknown>; schedule?: Record<string, unknown> | null } = {}): LiveRule => {
  const specs = { evaluation: o.evaluation ?? EVAL, execution: o.execution ?? CUT, schedule: o.schedule === undefined ? { schedule_type: 'DAILY' } : o.schedule }
  const status = o.status ?? 'ENABLED'
  return { id: RULE, name: o.name ?? 'Rule A', status, disableErrorCode: null, specs, words: mapRule({ name: o.name ?? 'Rule A', status, evaluation_spec: specs.evaluation, execution_spec: specs.execution, schedule_spec: specs.schedule }, chosen()) }
}
const ctx = (o: Partial<RuleDraftContext> = {}): RuleDraftContext => ({ adAccountId: '1234567890', currency: 'EUR', live: null, preview: null, words: words(), ...o })
const draft = (request: AdRuleRequest, c: Partial<RuleDraftContext> = {}) => adRuleDraft(request, ctx(c))
const refusal = (request: AdRuleRequest, c: Partial<RuleDraftContext> = {}) => { try { draft(request, c); return null } catch (err) { if (err instanceof RuleRefusal) return err.message; throw err } }

const pauseRule: AdRuleRequest = {
  action: 'create', name: 'Pause costly ad sets',
  evaluation: { type: 'SCHEDULE', filters: [{ field: 'entity_type', operator: 'EQUAL', value: 'ADSET' }, { field: 'time_preset', operator: 'EQUAL', value: 'LAST_7D' }, { field: 'spent', operator: 'GREATER_THAN', valueCents: 5000 }, { field: 'website_purchase_roas', operator: 'LESS_THAN', valueAsMeta: 0.5 }] },
  execution: { type: 'PAUSE', notifyUserIds: ['100001'] },
  schedule: { type: 'CUSTOM', times: [{ days: [1, 2, 3, 4, 5], startMinute: 480 }] },
}

describe('create', () => {
  it('ONE POST on the account\'s rule library, made DISABLED, every spec in Meta\'s shape; Meta has no check; the 2703 hint', () => {
    const d = draft(pauseRule)
    expect(d.requests).toHaveLength(1)
    const r = d.requests[0]
    expect(r).toMatchObject({ objectId: 'act_1234567890', objectKind: 'adaccount', edge: 'adrules_library', operation: 'adRule.create', check: 'none', raisesSpend: false, expect: { status: 'DISABLED' } })
    expect(r.params.status).toBe('DISABLED')
    expect(JSON.parse(r.params.evaluation_spec)).toEqual({ evaluation_type: 'SCHEDULE', filters: [
      { field: 'entity_type', value: 'ADSET', operator: 'EQUAL' }, { field: 'time_preset', value: 'LAST_7D', operator: 'EQUAL' },
      { field: 'spent', value: 5000, operator: 'GREATER_THAN' }, { field: 'website_purchase_roas', value: 0.5, operator: 'LESS_THAN' },
    ] })
    expect(JSON.parse(r.params.execution_spec)).toEqual({ execution_type: 'PAUSE', execution_options: [{ field: 'user_ids', value: ['100001'], operator: 'EQUAL' }] })
    expect(JSON.parse(r.params.schedule_spec)).toEqual({ schedule_type: 'CUSTOM', schedule: [{ start_minute: 480, days: [1, 2, 3, 4, 5] }] })
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings.join(' ')).toMatch(/no check/)
    expect(d.warnings.join(' ')).toMatch(/2703/)
    expect(d.warnings.join(' ')).toMatch(/cannot check who they are/)
    expect(d.warnings.join(' ')).toMatch(/made switched OFF/)
    expect(d.before).toMatchObject({ action: 'create', exists: 'no' })
    expect(wholeRuleSpecsProblem(JSON.parse(r.params.evaluation_spec), JSON.parse(r.params.execution_spec), JSON.parse(r.params.schedule_spec))).toBeNull()
  })
  it('enable: true with a raise is SPENDS MONEY and ENABLED; a raise left off is not', () => {
    const raise: AdRuleRequest = { ...pauseRule, execution: { type: 'CHANGE_BUDGET', change: { unit: 'PERCENTAGE', amountPercent: 15, limitCents: 20000 }, maxActionsPerObject: 3 } }
    const on = draft({ ...raise, enable: true })
    expect(on.requests[0]).toMatchObject({ raisesSpend: true, params: { status: 'ENABLED' } })
    expect(on.spendsMoney[0]).toMatch(/made ON .* spend more/)
    expect(JSON.parse(on.requests[0].params.execution_spec).execution_options).toEqual([
      { field: 'change_spec', value: { amount: 15, limit: 20000, unit: 'PERCENTAGE' }, operator: 'EQUAL' }, { field: 'execution_count_limit', value: 3, operator: 'EQUAL' },
    ])
    expect(draft(raise).spendsMoney).toEqual([])
  })
  it('money in minor units becomes Meta\'s base unit (BHD: thousandths → hundredths); one Meta cannot hold is refused', () => {
    const bhd = { ...pauseRule, evaluation: { ...pauseRule.evaluation!, filters: [...pauseRule.evaluation!.filters!.slice(0, 2), { field: 'spent', operator: 'GREATER_THAN' as const, valueCents: 1230 }] } }
    expect(JSON.parse(draft(bhd, { currency: 'BHD', words: words('BHD') }).requests[0].params.evaluation_spec).filters[2].value).toBe(123)
    const odd = { ...pauseRule, evaluation: { ...pauseRule.evaluation!, filters: [...pauseRule.evaluation!.filters!.slice(0, 2), { field: 'spent', operator: 'GREATER_THAN' as const, valueCents: 1234 }] } }
    expect(() => draft(odd, { currency: 'BHD', words: words('BHD') })).toThrow(/cannot be sent exactly/)
  })
  it('each field takes its own value key (money valueCents, plain value, anything else valueAsMeta)', () => {
    const withFilter = (f: Record<string, unknown>) => refusal({ ...pauseRule, evaluation: { ...pauseRule.evaluation!, filters: [...pauseRule.evaluation!.filters!.slice(0, 2), f as never] } })
    expect(withFilter({ field: 'spent', operator: 'GREATER_THAN', value: 5000 })).toMatch(/spent is money: give valueCents/)
    expect(withFilter({ field: 'impressions', operator: 'GREATER_THAN', valueCents: 5000 })).toMatch(/plain value/)
    expect(withFilter({ field: 'website_purchase_roas', operator: 'LESS_THAN', value: 0.5 })).toMatch(/valueAsMeta/)
    expect(withFilter({ field: 'adset.id', operator: 'IN', value: [AD_SET] })).toBeNull()
    expect(withFilter({ field: 'adset.id', operator: 'IN', value: [120000000000002] })).toBeNull()
    expect(withFilter({ field: 'adset.id', operator: 'IN', value: [1.2e19] })).toMatch(/Meta ids, as text/)
    expect(withFilter({ field: 'ad.adset.spent', operator: 'GREATER_THAN', valueAsMeta: 1 })).toMatch(/not a rule field Meta documents/)
  })
  it('Meta\'s rules said in words before anything is sent', () => {
    const base = pauseRule.evaluation!.filters!
    expect(refusal({ ...pauseRule, evaluation: { type: 'SCHEDULE', filters: [base[0], base[2]] } })).toMatch(/needs a time_preset/)
    expect(refusal({ ...pauseRule, schedule: undefined })).toMatch(/names its schedule/)
    expect(refusal({ ...pauseRule, enabled: true })).toMatch(/enable \(true\), not enabled/)
    expect(refusal({ ...pauseRule, execution: { type: 'CHANGE_BUDGET' } })).toMatch(/names its change/)
    expect(refusal({ ...pauseRule, execution: { type: 'CHANGE_CAMPAIGN_BUDGET', change: { unit: 'PERCENTAGE', amountPercent: -10 } } })).toMatch(/campaigns only/)
    expect(refusal({ ...pauseRule, execution: { type: 'ROTATE' } })).toMatch(/ROTATE needs an entity_type AD/)
    expect(refusal({ ...pauseRule, execution: { type: 'PING_ENDPOINT' } })).toMatch(/trigger rules only/)
    const trigger = (t: AdRuleRequest['evaluation'], execution: AdRuleRequest['execution'] = { type: 'NOTIFICATION' }) => refusal({ action: 'create', name: 'T', evaluation: t, execution })
    const lifetime = [{ field: 'entity_type', operator: 'EQUAL' as const, value: 'AD' }, { field: 'time_preset', operator: 'EQUAL' as const, value: 'LIFETIME' }]
    expect(trigger({ type: 'TRIGGER', filters: lifetime, trigger: { type: 'STATS_MILESTONE', field: 'impressions', operator: 'EQUAL', value: 500 } })).toMatch(/at least 1000/)
    expect(trigger({ type: 'TRIGGER', filters: lifetime, trigger: { type: 'STATS_MILESTONE', field: 'spent', operator: 'EQUAL', valueCents: 500 } })).toMatch(/at least 1000 in Meta's base unit/)
    expect(trigger({ type: 'TRIGGER', filters: lifetime, trigger: { type: 'STATS_MILESTONE', field: 'impressions', operator: 'EQUAL', value: 1000 } })).toBeNull()
    expect(trigger({ type: 'TRIGGER', filters: [lifetime[0], { field: 'time_preset', operator: 'EQUAL', value: 'LAST_7D' }], trigger: { type: 'STATS_CHANGE', field: 'cpc', operator: 'GREATER_THAN', valueCents: 100 } })).toMatch(/includes today/)
    expect(trigger({ type: 'TRIGGER', filters: [...lifetime, { field: 'hours_since_creation', operator: 'GREATER_THAN', value: 48 }], trigger: { type: 'METADATA_CREATION' } })).toMatch(/schedule rules only/)
    expect(trigger({ type: 'TRIGGER', filters: lifetime, trigger: { type: 'METADATA_UPDATE', field: 'daily_budget' } }, { type: 'CHANGE_BID', change: { unit: 'PERCENTAGE', amountPercent: 5 } })).toMatch(/trigger rule takes NOTIFICATION/)
    expect(trigger({ type: 'TRIGGER', filters: lifetime, trigger: { type: 'METADATA_UPDATE', field: 'daily_budget' } }, { type: 'PING_ENDPOINT' })).toBeNull()
  })
  it('a trigger rule: no schedule, the webhook warning, Ads Manager never shows it', () => {
    const d = draft({ action: 'create', name: 'Ping', evaluation: { type: 'TRIGGER', filters: [{ field: 'entity_type', operator: 'EQUAL', value: 'ADSET' }], trigger: { type: 'METADATA_UPDATE', field: 'daily_budget' } }, execution: { type: 'PING_ENDPOINT' } })
    expect(d.requests[0].params.schedule_spec).toBeUndefined()
    expect(d.warnings.join(' ')).toMatch(/callback URL of this Meta app's webhook subscription for the ads_rules_engine field/)
    expect(d.warnings.join(' ')).not.toMatch(/step 30/)
    expect(d.warnings.join(' ')).toMatch(/Ads Manager never shows it/)
  })
})

describe('update, status, run, remove', () => {
  it('update of the conditions only: the WHOLE rule is sent, the action and schedule exactly as Meta has them; undo has the old parts', () => {
    const preview = { read: true, objects: [{ id: AD_SET, name: 'Ad set B' }], more: false, sentence: 'Meta\'s preview: the rule would act on 1 object now.' }
    const d = draft({ action: 'update', ruleId: RULE, evaluation: { filters: [{ field: 'entity_type', operator: 'EQUAL', value: 'ADSET' }, { field: 'time_preset', operator: 'EQUAL', value: 'LAST_14D' }, { field: 'cost_per_purchase_fb', operator: 'GREATER_THAN', valueCents: 3000 }] } }, { live: live(), preview })
    const p = d.requests[0].params
    expect(Object.keys(p).sort()).toEqual(['evaluation_spec', 'execution_spec', 'schedule_spec'])
    expect(JSON.parse(p.execution_spec)).toEqual({ execution_type: 'CHANGE_BUDGET', execution_options: [{ field: 'change_spec', value: { amount: -20, unit: 'PERCENTAGE' }, operator: 'EQUAL' }] })
    expect(JSON.parse(p.schedule_spec)).toEqual({ schedule_type: 'DAILY' })
    expect(d.requests[0]).toMatchObject({ objectId: RULE, objectKind: 'adrule', operation: 'adRule.update', expect: { status: 'ENABLED' } })
    const undo = (d.before as { undo: Record<string, any> }).undo
    expect(undo).toMatchObject({ action: 'update', ruleId: RULE, execution: { type: 'CHANGE_BUDGET', change: { unit: 'PERCENTAGE', amountPercent: -20 } }, schedule: { type: 'DAILY' } })
    expect(undo.evaluation.filters[2]).toEqual({ field: 'cost_per_purchase_fb', operator: 'GREATER_THAN', valueCents: 2500 })
    // A cut rule that is on, changed: it may stop less — SPENDS MONEY.
    expect(d.spendsMoney[0]).toMatch(/may stop or cut less/)
    expect(d.warnings.join(' ')).toMatch(/before this change/)
    // The same parts again: nothing to send.
    expect(draft({ action: 'update', ruleId: RULE, evaluation: { filters: undo.evaluation.filters } }, { live: live() }).requests).toEqual([])
    // A rename alone goes alone.
    const renamed = draft({ action: 'update', ruleId: RULE, name: 'Rule B' }, { live: live() })
    expect(renamed.requests[0].params).toEqual({ name: 'Rule B' })
    expect((renamed.before as { undo: unknown }).undo).toEqual({ action: 'update', ruleId: RULE, name: 'Rule A' })
  })
  it('update of a rule that is on into a raise is SPENDS MONEY; parts Nexus cannot send back refuse a partial change', () => {
    const d = draft({ action: 'update', ruleId: RULE, execution: { type: 'CHANGE_BUDGET', change: { unit: 'PERCENTAGE', amountPercent: 25 } } }, { live: live() })
    expect(d.spendsMoney[0]).toMatch(/is on: from its next run .* spend more/)
    expect(d.requests[0].raisesSpend).toBe(true)
    const onceOff = live({ execution: { execution_type: 'PAUSE', is_once_off: true } })
    expect(refusal({ action: 'update', ruleId: RULE, evaluation: { filters: [{ field: 'entity_type', operator: 'EQUAL', value: 'ADSET' }] } }, { live: onceOff })).toMatch(/cannot send back exactly \(Meta's is_once_off/)
    const bigId = live({ evaluation: { evaluation_type: 'SCHEDULE', filters: [{ field: 'id', value: [12020000000000000001], operator: 'IN' }] } })
    expect(refusal({ action: 'update', ruleId: RULE, execution: { type: 'PAUSE' } }, { live: bigId })).toMatch(/too long to read exactly/)
  })
  it('status: switching on a rule that can raise spend is SPENDS MONEY with Meta\'s preview; switching off a brake that is on too', () => {
    const preview = { read: true, objects: [{ id: AD_SET, name: null }], more: true, sentence: 'Meta\'s preview: the rule would act on 1+ objects now (120000000000002).' }
    const on = draft({ action: 'status', ruleId: RULE, enabled: true }, { live: live({ status: 'DISABLED', execution: RAISE }), preview })
    expect(on.requests[0]).toMatchObject({ params: { status: 'ENABLED' }, raisesSpend: true, expect: { status: 'ENABLED' } })
    expect(on.spendsMoney[0]).toMatch(/Meta's preview: 1\+ now/)
    expect(on.warnings).toContain(preview.sentence)
    expect((on.before as { undo: unknown }).undo).toEqual({ action: 'status', ruleId: RULE, enabled: false })
    const off = draft({ action: 'status', ruleId: RULE, enabled: false }, { live: live() })
    expect(off.spendsMoney[0]).toMatch(/switched off, what it would have stopped keeps spending/)
    expect(draft({ action: 'status', ruleId: RULE, enabled: true }, { live: live() }).requests).toEqual([])
    const issues = draft({ action: 'status', ruleId: RULE, enabled: false }, { live: live({ status: 'HAS_ISSUES' }) })
    expect((issues.before as { undo: unknown }).undo).toBeNull()
    expect(refusal({ action: 'status', ruleId: RULE, enabled: true }, { live: live({ status: 'DELETED' }) })).toMatch(/deleted on Meta/)
  })
  it('run: a schedule rule only, no body, the objects Meta\'s preview lists are part of what it stands on; no undo', () => {
    const preview = { read: true, objects: [{ id: '120000000000004', name: null }, { id: AD_SET, name: null }], more: false, sentence: 'x' }
    const d = draft({ action: 'run', ruleId: RULE }, { live: live({ execution: RAISE }), preview })
    expect(d.requests[0]).toMatchObject({ edge: 'execute', params: {}, operation: 'adRule.run', undoable: false, raisesSpend: true })
    expect(d.stands).toMatchObject({ matches: { ids: [AD_SET, '120000000000004'], more: false } })
    expect(d.spendsMoney[0]).toMatch(/on the 2 object\(s\) Meta's preview lists/)
    expect((d.before as { undo: unknown }).undo).toBeNull()
    const trigger = live({ evaluation: { evaluation_type: 'TRIGGER', filters: [{ field: 'entity_type', value: 'AD', operator: 'EQUAL' }], trigger: { type: 'METADATA_CREATION' } }, execution: { execution_type: 'NOTIFICATION' }, schedule: null })
    expect(refusal({ action: 'run', ruleId: RULE }, { live: trigger })).toMatch(/trigger rule: Meta runs it when its trigger fires/)
    expect(draft({ action: 'run', ruleId: RULE }, { live: live({ status: 'DISABLED' }), preview }).warnings.join(' ')).toMatch(/its answer decides/)
  })
  it('remove: a DELETE; deleting a brake that is on is SPENDS MONEY; undo makes it again, ON as it was', () => {
    const d = removeRuleDraft(ctx({ live: live() }))
    expect(d.requests[0]).toMatchObject({ method: 'DELETE', objectKind: 'adrule', operation: 'adRule.delete', raisesSpend: true })
    expect(d.spendsMoney[0]).toMatch(/without it, what it would have stopped keeps spending/)
    expect((d.before as { undo: Record<string, unknown> }).undo).toMatchObject({ action: 'create', name: 'Rule A', enable: true, schedule: { type: 'DAILY' } })
    expect(d.after).toMatchObject({ exists: 'no' })
  })
})

describe('review round 1', () => {
  const rotate: AdRuleRequest = { action: 'create', name: 'Rotate', evaluation: { type: 'SCHEDULE', filters: [{ field: 'entity_type', operator: 'EQUAL', value: 'AD' }, { field: 'adset.id', operator: 'IN', value: [AD_SET] }] }, execution: { type: 'ROTATE' }, schedule: { type: 'DAILY' } }
  const ROTATE = { execution_type: 'ROTATE' }
  const TARGET = { execution_type: 'CHANGE_BID', execution_options: [{ field: 'change_spec', value: { amount: 1500, target_field: 'cost_per_purchase_fb' }, operator: 'EQUAL' }] }
  it('A1 — ROTATE switches the next ad on: SPENDS MONEY when made on, switched on, changed while on, or run', () => {
    const on = draft({ ...rotate, enable: true })
    expect(on.spendsMoney[0]).toMatch(/switches the next ad of the ad set on/)
    expect(on.requests[0].raisesSpend).toBe(true)
    expect(draft(rotate).spendsMoney).toEqual([])
    const rotateRule = live({ execution: ROTATE, evaluation: { evaluation_type: 'SCHEDULE', filters: [{ field: 'entity_type', value: 'AD', operator: 'EQUAL' }, { field: 'adset.id', value: [AD_SET], operator: 'IN' }] } })
    expect(draft({ action: 'status', ruleId: RULE, enabled: true }, { live: { ...rotateRule, status: 'DISABLED' } }).spendsMoney[0]).toMatch(/switches the next ad of the ad set on/)
    expect(draft({ action: 'run', ruleId: RULE }, { live: rotateRule }).spendsMoney[0]).toMatch(/switches the next ad of the ad set on/)
    expect(draft({ action: 'update', ruleId: RULE, schedule: { type: 'HOURLY' } }, { live: rotateRule }).spendsMoney[0]).toMatch(/spend more/)
  })
  it('A4 — a move towards a target cuts too: switching it off, changing it or deleting it while on is SPENDS MONEY', () => {
    const target = live({ execution: TARGET })
    expect(draft({ action: 'status', ruleId: RULE, enabled: false }, { live: target }).spendsMoney[0]).toMatch(/keeps spending/)
    expect(removeRuleDraft(ctx({ live: target })).spendsMoney[0]).toMatch(/keeps spending/)
  })
  it('A5 — money Meta holds that does not go back to exactly the same amount is never named again', () => {
    const half = { evaluation: { evaluation_type: 'SCHEDULE', filters: [{ field: 'entity_type', value: 'ADSET', operator: 'EQUAL' }, { field: 'time_preset', value: 'LAST_7D', operator: 'EQUAL' }, { field: 'spent', value: '50.5', operator: 'GREATER_THAN' }] }, execution: { execution_type: 'PAUSE' }, schedule: { schedule_type: 'DAILY' } }
    expect(ruleInputOf(half, 'EUR')).toMatchObject({ why: expect.stringMatching(/cannot name again exactly/) })
    const ugx = { ...half, evaluation: { ...half.evaluation, filters: [half.evaluation.filters[0], half.evaluation.filters[1], { field: 'spent', value: 5050, operator: 'GREATER_THAN' }] } }
    expect(ruleInputOf(ugx, 'UGX')).toMatchObject({ why: expect.any(String) })
    const whole = { ...half, evaluation: { ...half.evaluation, filters: [half.evaluation.filters[0], half.evaluation.filters[1], { field: 'spent', value: 5000, operator: 'GREATER_THAN' }] } }
    expect(ruleInputOf({ ...whole, execution: { execution_type: 'CHANGE_BUDGET', execution_options: [{ field: 'change_spec', value: { amount: 30.5, unit: 'ACCOUNT_CURRENCY' }, operator: 'EQUAL' }] } }, 'EUR')).toMatchObject({ why: expect.stringMatching(/exactly in minor units/) })
    expect(ruleInputOf({ ...ugx, evaluation: { ...ugx.evaluation, filters: [half.evaluation.filters[0], half.evaluation.filters[1], { field: 'spent', value: 5000, operator: 'GREATER_THAN' }] } }, 'UGX')).not.toHaveProperty('why')
  })
  it('B3 — a trigger takes no prefixed result and milestones only on Meta\'s fields; settings take their own operators', () => {
    const t = (trigger: NonNullable<AdRuleRequest['evaluation']>['trigger'], filters = [{ field: 'entity_type', operator: 'EQUAL' as const, value: 'ADSET' }, { field: 'time_preset', operator: 'EQUAL' as const, value: 'TODAY' }]) =>
      refusal({ action: 'create', name: 'T', evaluation: { type: 'TRIGGER', filters, trigger }, execution: { type: 'NOTIFICATION' } })
    expect(t({ type: 'STATS_CHANGE', field: 'adset.cpc', operator: 'GREATER_THAN', valueCents: 100 })).toMatch(/not allowed as a trigger/)
    expect(t({ type: 'METADATA_CREATION' }, [{ field: 'entity_type', operator: 'EQUAL', value: 'ADSET' }, { field: 'time_preset', operator: 'EQUAL', value: 'TODAY' }, { field: 'campaign.today_spent', operator: 'GREATER_THAN', valueCents: 100 }])).toMatch(/schedule rules only/)
    expect(t({ type: 'STATS_MILESTONE', field: 'ctr', operator: 'EQUAL', value: 2 }, [{ field: 'entity_type', operator: 'EQUAL', value: 'ADSET' }, { field: 'time_preset', operator: 'EQUAL', value: 'LIFETIME' }])).toMatch(/milestone fields/)
    expect(refusal({ ...pauseRule, evaluation: { ...pauseRule.evaluation!, filters: [...pauseRule.evaluation!.filters!, { field: 'campaign.objective', operator: 'EQUAL', value: 'OUTCOME_SALES' }] } })).toMatch(/objective takes IN, NOT_IN/)
  })
})

describe('Meta → request → Meta', () => {
  it('a rule as Meta sends it is named again exactly (numbers as text, options as JSON strings)', () => {
    const specs = { evaluation: { evaluation_type: 'SCHEDULE', filters: [{ field: 'id', value: ['120000000000002'], operator: 'IN' }, { field: 'time_preset', value: 'LAST_7D', operator: 'EQUAL' }, { field: 'spent', value: '5000', operator: 'GREATER_THAN' }] }, execution: CUT, schedule: { schedule_type: 'HOURLY' } }
    const input = ruleInputOf(specs, 'EUR')
    expect('why' in input).toBe(false)
    const again = specsOf(input as never, 'EUR')
    expect(again.evaluation.filters).toEqual([{ field: 'id', value: ['120000000000002'], operator: 'IN' }, { field: 'time_preset', value: 'LAST_7D', operator: 'EQUAL' }, { field: 'spent', value: 5000, operator: 'GREATER_THAN' }])
    expect(ruleInputOf({ ...specs, execution: { execution_type: 'AUDIENCE_CONSOLIDATION' } }, 'EUR')).toMatchObject({ why: expect.stringMatching(/nine Meta documents/) })
  })
})
