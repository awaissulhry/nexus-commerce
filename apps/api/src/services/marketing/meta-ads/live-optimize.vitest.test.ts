/**
 * Meta ads step 8 — the pure parts of live-optimize.ts: THE money helper (Meta's base unit of the account currency →
 * minor units), Meta's times, a study's state from its times, which rule fields are money, a rule and its history in
 * Nexus's words (money only under …Cents keys, trigger rules marked invisible in Ads Manager), lift and creative-test
 * results (cost metrics apart), and how to act on each recommendation type. Made-up ids only.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db.js', () => ({ default: {} }))
vi.mock('../../meta/meta-accounts.service.js', () => ({ listMetaConnections: vi.fn(async () => []) }))

import { howToAct, isMoneyRuleField, isPlainRuleField, mapResults, mapRule, metaBudgetCents, metaTime, studyState } from './live-optimize.js'
import type { MetaChosenAccount } from './live.js'
import { currencyExponent } from './money.js'

const account = (currency = 'EUR'): MetaChosenAccount => ({
  connection: { systemUser: { id: '9000000000001', name: null } } as MetaChosenAccount['connection'],
  connectionId: 'conn-1', adAccountId: '1234567890', name: 'Shop A ads', currency, timeZone: 'Europe/Rome', businessId: '9876543210', pageId: null, instagramId: null,
})

describe('metaBudgetCents — the one money helper', () => {
  it('reads Meta\'s base unit (cents for EUR/USD) as minor units; numbers, strings, decimals and signs', () => {
    expect(metaBudgetCents('5000', 'EUR')).toBe(5000)
    expect(metaBudgetCents(5000, 'USD')).toBe(5000)
    expect(metaBudgetCents('-50', 'EUR')).toBe(-50)
    expect(metaBudgetCents('150.5', 'EUR')).toBe(151)
    expect(metaBudgetCents(' 1000 ', 'EUR')).toBe(1000)
  })
  it('an offset-1 currency (Meta sends whole units) becomes the currency\'s own minor unit (money.ts currencyExponent)', () => {
    expect(metaBudgetCents('5000', 'JPY')).toBe(5000)
    expect(metaBudgetCents('5000', 'HUF')).toBe(5000 * 10 ** currencyExponent('HUF'))
    expect(metaBudgetCents('5000', 'ISK')).toBe(5000 * 10 ** currencyExponent('ISK'))
  })
  it('no value or not a number is null, never 0', () => {
    for (const v of [null, undefined, '', 'abc', '12,5', true, {}, [1]]) expect(metaBudgetCents(v, 'EUR'), String(v)).toBeNull()
  })
})

describe('metaTime and studyState', () => {
  it('reads Meta\'s +0000 times and epoch seconds', () => {
    expect(metaTime('2026-10-01T08:00:00+0000')).toBe('2026-10-01T08:00:00.000Z')
    expect(metaTime('1760000000')).toBe('2025-10-09T08:53:20.000Z')
    expect(metaTime(1760000000)).toBe('2025-10-09T08:53:20.000Z')
    expect(metaTime('soon')).toBeNull()
    expect(metaTime(null)).toBeNull()
  })
  it('Meta keeps no status: planned, running, measuring, finished and cancelled come from the times', () => {
    const now = new Date('2026-10-21T12:00:00Z')
    const s = (startTime: string | null, endTime: string | null, observationEndTime: string | null = null, canceledTime: string | null = null) => studyState({ startTime, endTime, observationEndTime, canceledTime }, now)
    expect(s('2026-10-25T00:00:00Z', '2026-11-01T00:00:00Z')).toBe('planned')
    expect(s('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z')).toBe('running')
    expect(s('2026-10-01T00:00:00Z', '2026-10-15T00:00:00Z', '2026-10-30T00:00:00Z')).toBe('measuring')
    expect(s('2026-09-01T00:00:00Z', '2026-09-15T00:00:00Z', '2026-09-30T00:00:00Z')).toBe('finished')
    expect(s('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z', null, '2026-10-05T00:00:00Z')).toBe('cancelled')
    expect(s(null, null)).toBeNull()
  })
})

describe('rules — a plain value only for a known non-money field; money under …Cents, everything else …AsMeta', () => {
  it('knows which rule fields are money (spend, budgets, caps, bids, every cost metric; prefixed and advanced too)', () => {
    for (const f of ['spent', 'today_spent', 'lifetime_spent', 'adset.daily_budget', 'campaign.spend_cap', 'bid_amount', 'cpc', 'cpm', 'cpa', 'cost_per', 'cost_per_purchase_fb', 'campaign.28d_view_1d_click:lifetime_spent']) {
      expect(isMoneyRuleField(f), f).toBe(true)
    }
    for (const f of ['impressions', 'website_purchase_roas', 'daily_ratio_spent', 'entity_type', 'time_preset', 'app_custom_event.fb_mobile_spent_credits', 'frequency', null]) {
      expect(isMoneyRuleField(f), String(f)).toBe(false)
    }
  })
  it('review fix N1 — the allow-list of plain rule fields: ROAS, ratios of spend and anything new are not on it', () => {
    for (const f of ['entity_type', 'id', 'time_preset', 'attribution_window', 'hours_since_creation', 'impressions', 'reach', 'clicks', 'frequency', 'ctr', 'results', 'adset.effective_status', 'placement.page_types', 'offsite_conversion.fb_pixel_purchase', 'app_custom_event.fb_mobile_spent_credits']) {
      expect(isPlainRuleField(f), f).toBe(true)
    }
    for (const f of ['website_purchase_roas', 'mobile_app_purchase_roas', 'daily_ratio_spent', 'lifetime_ratio_spent', 'spent', 'adset.daily_budget', 'cost_per_purchase_fb', 'some_new_metric', 'estimated_budget_spending_percentage', 'offsite_conversion.fb_pixel_purchase_value', 'app_custom_event.fb_mobile_purchase_roas', null]) {
      expect(isPlainRuleField(f), String(f)).toBe(false)
    }
  })
  it('a schedule rule: conditions in words, money in minor units, a budget raise can raise spend; the creator is an id only', () => {
    const rule = mapRule({
      id: '23850000000000001', account_id: '1234567890', name: 'Raise winners', status: 'ENABLED',
      evaluation_spec: { evaluation_type: 'SCHEDULE', filters: [
        { field: 'entity_type', value: 'ADSET', operator: 'EQUAL' }, { field: 'time_preset', value: 'LAST_7_DAYS', operator: 'EQUAL' },
        { field: 'spent', value: 1000, operator: 'GREATER_THAN' }, { field: 'cost_per_purchase_fb', value: [500, 1500], operator: 'IN_RANGE' },
        { field: 'website_purchase_roas', value: 3, operator: 'GREATER_THAN' },
      ] },
      execution_spec: { execution_type: 'CHANGE_BUDGET', execution_options: [
        { field: 'change_spec', value: { amount: 20, unit: 'PERCENTAGE', limit: 5000 }, operator: 'EQUAL' },
        { field: 'action_frequency', value: 10080, operator: 'EQUAL' }, { field: 'user_ids', value: [9000000000001, 9000000000002], operator: 'EQUAL' },
      ] },
      schedule_spec: { schedule_type: 'CUSTOM', schedule: [{ start_minute: 0, end_minute: 60, days: [2, 5] }] },
      created_by: { id: '9000000000002' }, created_time: '2026-10-01T08:00:00+0000',
    }, account())
    expect(rule).toMatchObject({ ruleId: '23850000000000001', status: 'ENABLED', statusText: 'on', evaluationType: 'SCHEDULE', visibleInAdsManager: true, appliesTo: 'ADSET', canRaiseSpend: true })
    expect(rule.filters).toEqual([
      { field: 'entity_type', operator: 'EQUAL', value: 'ADSET' }, { field: 'time_preset', operator: 'EQUAL', value: 'LAST_7_DAYS' },
      { field: 'spent', operator: 'GREATER_THAN', valueCents: 1000 }, { field: 'cost_per_purchase_fb', operator: 'IN_RANGE', valueCents: [500, 1500] },
      { field: 'website_purchase_roas', operator: 'GREATER_THAN', valueAsMeta: 3 },
    ])
    expect(rule.action.options).toEqual([
      { option: 'change_spec', unit: 'PERCENTAGE', targetField: null, amountPercent: 20, limitCents: 5000 },
      { option: 'action_frequency', value: 10080 },
      { option: 'user_ids', people: [{ id: '9000000000001', isThisSystemUser: true }, { id: '9000000000002', isThisSystemUser: false }] },
    ])
    expect(rule.schedule).toEqual({ type: 'CUSTOM', text: 'at the set times', times: [{ days: [2, 5], startMinute: 0, endMinute: 60 }] })
    expect(rule.createdBy).toEqual({ id: '9000000000002', isThisSystemUser: false })
    expect(JSON.stringify(rule)).not.toMatch(/"value":1000|"value":\[500|"value":3/)
  })
  it('a trigger rule is marked invisible in Ads Manager; a stopped rule says so; a pause cannot raise spend', () => {
    const rule = mapRule({
      id: '23850000000000002', status: 'HAS_ISSUES', disable_error_code: 1815,
      evaluation_spec: { evaluation_type: 'TRIGGER', trigger: { type: 'STATS_MILESTONE', field: 'spent', value: 5000, operator: 'EQUAL' }, filters: [{ field: 'entity_type', value: 'AD', operator: 'EQUAL' }] },
      execution_spec: { execution_type: 'PAUSE' },
    }, account())
    expect(rule).toMatchObject({ evaluationType: 'TRIGGER', visibleInAdsManager: false, hasIssues: true, disableErrorCode: 1815, canRaiseSpend: false })
    expect(rule.trigger).toEqual({ type: 'STATS_MILESTONE', typeText: 'each time a number reaches a milestone', field: 'spent', operator: 'EQUAL', valueCents: 5000 })
    // A ROAS trigger's value is restricted too.
    const roas = mapRule({ evaluation_spec: { evaluation_type: 'TRIGGER', trigger: { type: 'STATS_CHANGE', field: 'mobile_app_purchase_roas', value: 2, operator: 'LESS_THAN' } } }, account())
    expect(roas.trigger).toEqual({ type: 'STATS_CHANGE', typeText: 'when a number crosses its threshold', field: 'mobile_app_purchase_roas', operator: 'LESS_THAN', valueAsMeta: 2 })
    expect(rule.statusText).toMatch(/stopped by Meta/)
    expect(rule.schedule?.text).toMatch(/trigger fires/)
  })
  it('change_spec: an amount in the account currency, a target on a cost field, a JSON-string spec, a JPY account', () => {
    const opt = (value: unknown, currency = 'EUR') => mapRule({ execution_spec: { execution_type: 'CHANGE_BID', execution_options: [{ field: 'change_spec', value, operator: 'EQUAL' }] } }, account(currency)).action.options[0]
    expect(opt({ amount: 300, unit: 'ACCOUNT_CURRENCY', limit: 2000 })).toEqual({ option: 'change_spec', unit: 'ACCOUNT_CURRENCY', targetField: null, amountCents: 300, limitCents: 2000 })
    expect(opt({ amount: 1200, target_field: 'cost_per_purchase_fb', limit: [400, 3000] })).toEqual({ option: 'change_spec', unit: null, targetField: 'cost_per_purchase_fb', targetValueCents: 1200, limitCents: [400, 3000] })
    // A ROAS target is restricted (Nexus restricts ROAS everywhere); a target on a plain field is not.
    expect(opt({ amount: 4, target_field: 'website_purchase_roas' })).toEqual({ option: 'change_spec', unit: null, targetField: 'website_purchase_roas', targetValueAsMeta: 4 })
    expect(opt({ amount: 2.5, target_field: 'frequency' })).toEqual({ option: 'change_spec', unit: null, targetField: 'frequency', targetValue: 2.5 })
    expect(opt('{"amount":-50,"unit":"PERCENTAGE"}')).toEqual({ option: 'change_spec', unit: 'PERCENTAGE', targetField: null, amountPercent: -50 })
    expect(opt({ amount: 300, unit: 'ACCOUNT_CURRENCY' }, 'JPY')).toMatchObject({ amountCents: 300 })
    // An option Nexus does not know is restricted as Meta gives it.
    expect(mapRule({ execution_spec: { execution_type: 'REBALANCE_BUDGET', execution_options: [{ field: 'rebalance_spec', value: { type: 'PROPORTIONAL', target_field: 'cost_per_purchase_fb' }, operator: 'EQUAL' }] } }, account()).action.options[0])
      .toEqual({ option: 'rebalance_spec', operator: 'EQUAL', valueAsMeta: { type: 'PROPORTIONAL', target_field: 'cost_per_purchase_fb' } })
    // A cut never raises spend; a raise does.
    expect(mapRule({ execution_spec: { execution_type: 'CHANGE_BID', execution_options: [{ field: 'change_spec', value: { amount: -50, unit: 'PERCENTAGE' } }] } }, account()).canRaiseSpend).toBe(false)
  })
})

describe('study results — only known plain metrics unrestricted, a creative test\'s outcome', () => {
  it('reads Meta\'s JSON-string rows per group; spend, costs, any sales or value metric and anything nested go to moneyAsMeta', () => {
    const out = mapResults([
      JSON.stringify({
        cell_id: '6000000000001', population_test: 2334212, impressions: 19020874, spend: 26059, conversions_incremental: -162.9, conversions_confidence: 0.69,
        conversions_raw_pValue: 0.12, conversions_CPiC: -159.95, buyers_CPiB: -20.7, conversions_sales_value: 4200.5, incremental_purchase_value: 99,
        conversions_test: { nested: 1 }, brand_new_metric: 7,
      }),
      'not json',
    ])
    expect(out.unreadable).toBe(1)
    expect(out.rows).toEqual([{
      cellId: '6000000000001', age: null, gender: null, country: null,
      numbers: { population_test: 2334212, impressions: 19020874, conversions_incremental: -162.9, conversions_confidence: 0.69, conversions_raw_pValue: 0.12 },
      moneyAsMeta: { spend: 26059, conversions_CPiC: -159.95, buyers_CPiB: -20.7, conversions_sales_value: 4200.5, incremental_purchase_value: 99, conversions_test: { nested: 1 }, brand_new_metric: 7 },
    }])
  })
  it('a creative test: high performers are the outcome; the winner fields Meta leaves empty are not shown as a result', () => {
    const out = mapResults([{ high_performer_ids: ['120000000000301'], confidence_by_ad_object_id: { 120000000000301: 0.93 }, winner_ad_object_id: null, winner_confidence: null }])
    expect(out.rows[0].creativeTest).toMatchObject({ highPerformerAdIds: ['120000000000301'], confidenceByAdId: { 120000000000301: 0.93 } })
    expect(out.rows[0].numbers).toEqual({})
    // A confidence map that is not plain numbers is not shown unrestricted.
    const odd = mapResults([{ confidence_by_ad_object_id: { 120000000000301: { value: 0.9 } } }])
    expect(odd.rows[0]).toMatchObject({ creativeTest: { confidenceByAdId: null }, moneyAsMeta: { confidence_by_ad_object_id: { 120000000000301: { value: 0.9 } } } })
  })
})

describe('how to act on a recommendation (RC-023)', () => {
  it('a type Meta applies, with its signature: apply-meta-recommendations, which comes with a later step; a budget raise SPENDS MONEY', () => {
    expect(howToAct('SCALE_GOOD_CAMPAIGN', true)).toMatchObject({ byApi: true, tool: 'apply-meta-recommendations', toolComesWith: 'a later Nexus step (step 28)', spendsMoney: 'yes' })
    expect(howToAct('SCALE_GOOD_CAMPAIGN', true).sentence).toMatch(/SPENDS MONEY/)
    expect(howToAct('SCALE_GOOD_CAMPAIGN', true).sentence).toMatch(/comes with a later Nexus step \(step 28\)/)
    expect(howToAct('MUSIC', true)).toMatchObject({ byApi: true, spendsMoney: 'no' })
  })
  it('the same type without a signature cannot be applied by API now', () => {
    expect(howToAct('MUSIC', false)).toMatchObject({ byApi: false, tool: null })
    expect(howToAct('MUSIC', false).sentence).toMatch(/no signature/)
  })
  it('a read-only type names the Nexus tool that does the same, or Meta\'s screens', () => {
    expect(howToAct('BUDGET_LIMITED', false)).toMatchObject({ byApi: false, spendsMoney: 'yes', nexusTools: ['set-meta-ad-set', 'set-meta-campaign'] })
    expect(howToAct('SIGNALS_GROWTH_CAPI_V2', false).nexusTools).toEqual(['meta-datasets', 'upload-meta-events'])
    expect(howToAct('UNIFIED_INBOX', false).sentence).toMatch(/Ads Manager link/)
    expect(howToAct(null, false)).toMatchObject({ byApi: false, nexusTools: [] })
  })
})
