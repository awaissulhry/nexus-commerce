/**
 * Meta step 18 on the gateway: the settings changes of set-meta-campaign, set-meta-ad-set and set-meta-budget-schedule
 * reach Meta only on their EXACT allow-list entries — keys per kind of object (named and then confirmed), every value
 * judged, JSON in one spelling only, text only where a person types it — and every id inside a body (child ad sets, ads,
 * custom audiences, the pixel) and every budget schedule (through its campaign or ad set) is of the chosen ad account.
 * Step 17's status rule is untouched. Made-up ids only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, answers: [] as Array<() => Response>, takenPortfolios: new Set<string>(), takenFails: false }))
// Review A4 — which portfolios another Nexus business uses (nexus_meta_links_taken PORTFOLIO): a stand-in.
vi.mock('../marketing/meta-ads/taken.js', () => {
  const takenIds = vi.fn(async (_product: string, ids: string[]) => {
    if (h.takenFails) throw new Error('connection to the database lost')
    return new Set(ids.filter((id) => h.takenPortfolios.has(id)))
  })
  return {
    takenIds,
    portfolioTaken: vi.fn(async (id: string) => ((await takenIds('PORTFOLIO', [id])).has(id) ? { portfolioId: id, takenByAnotherBusiness: true, sentence: 'taken' } : null)),
  }
})
vi.mock('./account.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('./ledger.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../cx/token.service.js', () => ({
  getAccessToken: vi.fn(async () => 'meta-system-user-token'),
  metaAppAccessToken: vi.fn(async () => '1234567|app-secret-for-tests'),
  metaAppIdOf: vi.fn(async () => '1234567'),
  metaRenewalToken: vi.fn(async () => 'stored-meta-token'),
  metaRequestProof: vi.fn(async () => ({ appsecret_proof: 'proof', appsecret_time: '1760000000' })),
}))
vi.mock('../cx/deprecation-watch.service.js', () => ({ watchForDeprecation: vi.fn(async () => undefined) }))
vi.mock('../cx/connectors/meta/token-check.js', () => ({ forgetMetaTokenCheck: vi.fn(async () => undefined) }))

import { gatewayLedger, gatewayMetaChosen, gatewayMetaStored } from '../../test-support/gateway-stubs.js'
import { __rateTest } from './rate.js'
import { metaWriteCall } from './meta.js'
import { metaWriteVerdict } from './meta-calls.js'
import { META_NO_CAP, META_SETTINGS_CHECK_PROVEN, metaSettingsCheckAllowed } from './meta-settings-rules.js'
import { campaignSettingsCheck } from '../marketing/meta-ads/change-settings-common.js'
import { __metaObjectLimitsTest } from './meta-object-limits.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../meta/api-version.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const CAMPAIGN = '120000000000001'
const AD_SET = '120000000000002'
const AD = '120000000000003'
const PERIOD = '120000000000031'
const form = (o: Record<string, string>) => new URLSearchParams(o).toString()
const verdict = (input: { body?: unknown; objectKind?: string; url?: string; method?: string; kind?: string }) =>
  metaWriteVerdict({ method: input.method ?? 'POST', url: input.url ?? `${BASE}/${CAMPAIGN}`, kind: input.kind ?? 'write', body: input.body, objectKind: input.objectKind })
const problem = (input: Parameters<typeof verdict>[0]) => { const v = verdict(input); return 'problem' in v ? v.problem : null }
const campaign = (o: Record<string, string>) => problem({ body: form(o), objectKind: 'campaign' })
const adSet = (o: Record<string, string>) => problem({ body: form(o), objectKind: 'adset', url: `${BASE}/${AD_SET}` })
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status })

beforeEach(() => {
  __rateTest.useMemory()
  __metaObjectLimitsTest.useMemory()
  h.calls = []; h.answers = []; h.takenPortfolios.clear(); h.takenFails = false; gatewayLedger.length = 0
  for (const key of Object.keys(gatewayMetaChosen)) delete gatewayMetaChosen[key]
  for (const key of Object.keys(gatewayMetaStored)) delete gatewayMetaStored[key]
  gatewayMetaStored[CAMPAIGN] = { adAccountId: '1234567890', kind: 'campaign' }
  gatewayMetaStored[AD_SET] = { adAccountId: '1234567890', kind: 'adset' }
  gatewayMetaStored[AD] = { adAccountId: '1234567890', kind: 'ad' }
  vi.stubEnv('NEXUS_META_ADS_WRITES', 'on')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response(JSON.stringify({ id: CAMPAIGN }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset(); __metaObjectLimitsTest.reset() })

describe('kinds: a settings rule matches only the kind the call names', () => {
  it('a campaign\'s settings go as campaign.settings; the same body named an ad set or an ad, or no kind, is refused', () => {
    expect(verdict({ body: form({ daily_budget: '5000' }), objectKind: 'campaign' })).toEqual({ write: { rule: 'campaign.settings', objectId: CAMPAIGN, check: false, body: 'daily_budget=5000', budget: false, kinds: ['campaign'] } })
    expect(problem({ body: form({ spend_cap: '100000' }), objectKind: 'adset' })).toMatch(/only Meta change Nexus sends is a status change/)
    expect(problem({ body: form({ name: 'Shop A' }), objectKind: 'ad' })).toMatch(/only Meta change/)
    expect(problem({ body: form({ name: 'Shop A' }) })).toMatch(/only Meta change/)
  })
  it('the status rule stays step 17\'s: a status change named a budget schedule is refused', () => {
    expect(verdict({ body: 'status=PAUSED', objectKind: 'campaign' })).toEqual({ write: { rule: 'object.status', objectId: CAMPAIGN, check: false, body: 'status=PAUSED', budget: false } })
    expect(problem({ body: 'status=PAUSED', objectKind: 'highdemandperiod' })).toMatch(/only Meta change/)
    expect(campaign({ status: 'PAUSED', name: 'Shop A' })).toMatch(/only Meta change/)
  })
  it('an ad set\'s budget is a budget change (Meta\'s 4 an hour); its other settings are not', () => {
    expect(verdict({ body: form({ daily_budget: '5000' }), objectKind: 'adset', url: `${BASE}/${AD_SET}` })).toMatchObject({ write: { rule: 'adset.settings', budget: true } })
    expect(verdict({ body: form({ bid_amount: '150' }), objectKind: 'adset', url: `${BASE}/${AD_SET}` })).toMatchObject({ write: { rule: 'adset.settings', budget: false } })
  })
})

describe('campaign.settings values', () => {
  it('takes the documented values', () => {
    expect(campaign({ spend_cap: META_NO_CAP })).toBeNull()
    expect(campaign({ is_adset_budget_sharing_enabled: 'false' })).toBeNull()
    expect(campaign({ pacing_type: '["no_pacing"]' })).toBeNull()
    expect(campaign({ special_ad_category: 'HOUSING', special_ad_category_country: '["IT","DE"]' })).toBeNull()
    expect(campaign({ bid_strategy: 'COST_CAP', adset_bid_amounts: `{"${AD_SET}":150}` })).toBeNull()
    expect(campaign({ adset_budgets: `[{"adset_id":"${AD_SET}","daily_budget":2500}]` })).toBeNull()
    expect(campaign({ promoted_object: '{"pixel_id":"120000000000050","custom_event_type":"PURCHASE"}' })).toBeNull()
    expect(campaign({ name: 'Saldi 🏍️ estate — città' })).toBeNull()
  })
  it('refuses what Nexus never sends: sharing on, political ads, a status with settings, both budgets', () => {
    expect(campaign({ is_adset_budget_sharing_enabled: 'true' })).toMatch(/only switches it off/)
    expect(campaign({ special_ad_category: 'ISSUES_ELECTIONS_POLITICS' })).toMatch(/special_ad_category is one of/)
    expect(campaign({ adset_budgets: `[{"adset_id":"${AD_SET}","daily_budget":2500}]`, daily_budget: '5000' })).toMatch(/never go together/)
    expect(campaign({ objective: 'CONVERSIONS' })).toMatch(/objective is one of/)
    expect(campaign({ smart_promotion_type: 'GUIDED_CREATION' })).toMatch(/only Meta change/)
    expect(campaign({ start_time: '1793520000' })).toMatch(/only Meta change/)
    expect(campaign({ budget_rebalance_flag: 'true' })).toMatch(/only Meta change/)
  })
  it('JSON in one spelling only, every key on the list', () => {
    expect(campaign({ adset_budgets: `[{"adset_id": "${AD_SET}","daily_budget":2500}]` })).toMatch(/one spelling/)
    expect(campaign({ adset_budgets: `[{"adset_id":"${AD_SET}","daily_budget":2500,"daily_budget":9999}]` })).toMatch(/one spelling/)
    expect(campaign({ adset_budgets: `[{"adset_id":"${AD_SET}","daily_budget":2500,"bid_amount":1}]` })).toMatch(/exactly one of daily_budget, lifetime_budget/)
    expect(campaign({ adset_budgets: `[{"adset_id":"${AD_SET}","daily_budget":2500},{"adset_id":"120000000000004","lifetime_budget":2500}]` })).toMatch(/same kind/)
    expect(campaign({ adset_budgets: JSON.stringify(Array.from({ length: 71 }, (_, i) => ({ adset_id: String(120000000000100 + i), daily_budget: 100 }))) })).toMatch(/1 to 70/)
    expect(campaign({ promoted_object: '{"page_id":"120000000000060"}' })).toMatch(/promoted_object has only/)
    expect(campaign({ promoted_object: '{"pixel_id":120000000000050}' })).toMatch(/as a JSON string/)
    expect(campaign({ promoted_object: '{"custom_event_type":"STEAL"}' })).toMatch(/event types/)
    expect(campaign({ special_ad_category_country: '["it"]' })).toMatch(/two-letter/)
  })
  it('text only for the name (no control characters); every other value plain ASCII; each rule\'s length', () => {
    expect(campaign({ name: 'Shop\u0007A' })).toMatch(/printable text/)
    expect(campaign({ name: 'x'.repeat(401) })).toMatch(/1 to 400/)
    expect(campaign({ objective: 'OUTCOME_SALÉS' })).toMatch(/plain ASCII/)
    expect(campaign({ promoted_object: '{"custom_event_str":"acquisto è"}' })).toMatch(/plain ASCII/)
  })
  it('review A5 — Meta\'s check of a SETTINGS change has its own flag (not step 17\'s status one): both states', () => {
    expect(META_SETTINGS_CHECK_PROVEN).toBe(false)
    expect([metaSettingsCheckAllowed(), metaSettingsCheckAllowed(true)]).toEqual([false, true])
    expect([campaignSettingsCheck(), campaignSettingsCheck(true)]).toEqual(['not-yet', 'meta'])
    expect(problem({ body: form({ name: 'Shop A', execution_options: '["validate_only"]' }), objectKind: 'campaign', kind: 'read' })).toMatch(/ST18-03/)
  })
  it('review A8 / B3 — text refuses format characters; a pixel rule only on an ad set, in one exact shape', () => {
    expect(campaign({ name: 'Shop \u202eA' })).toMatch(/no control or format characters/)
    expect(adSet({ dsa_payor: 'Shop \u200bA', dsa_beneficiary: 'Shop A' })).toMatch(/no control or format characters/)
    const rule = (r: unknown) => JSON.stringify({ pixel_id: '120000000000050', pixel_rule: JSON.stringify(r) })
    expect(adSet({ promoted_object: rule({ url: { i_contains: 'thank-you' } }) })).toBeNull()
    expect(adSet({ promoted_object: rule({ and: [{ event: { eq: 'Purchase' } }, { value: { gt: 10 } }] }) })).toBeNull()
    expect(campaign({ promoted_object: rule({ url: { i_contains: 'thank-you' } }) })).toMatch(/promoted_object has only/)
    expect(adSet({ promoted_object: rule({ url: { regex: '.*' } }) })).toMatch(/not a pixel rule operator/)
    expect(adSet({ promoted_object: rule({ and: [{ or: [{ and: [{ url: { eq: 'x' } }] }] }] }) })).toMatch(/at most 3 levels/)
    expect(adSet({ promoted_object: rule({ url: { eq: 'x' }, event: { eq: 'y' } }) })).toMatch(/exactly one key/)
    expect(adSet({ promoted_object: rule({ 'URL-X': { eq: 'x' } }) })).toMatch(/not a pixel rule field/)
    expect(adSet({ promoted_object: rule({ url: { eq: { nested: 1 } } }) })).toMatch(/plain text, a number/)
    expect(adSet({ promoted_object: JSON.stringify({ pixel_rule: '{"url": {"eq":"x"}}' }) })).toMatch(/one spelling/)
  })
  it('round 2 — a NAME may join two emoji with U+200D; nothing else of the format characters; the EU payer stays strict', () => {
    expect(campaign({ name: 'Saldi 👨‍👩‍👧 città' })).toBeNull()
    expect(adSet({ name: 'Team 👩🏽‍💻' })).toBeNull()
    expect(campaign({ name: 'Sal\u200ddi' })).toMatch(/no control or format characters/)
    expect(campaign({ name: 'Shop\u{E0041}A' })).toMatch(/no control or format characters/)
    expect(campaign({ name: 'Shop\u200cA' })).toMatch(/no control or format characters/)
    expect(campaign({ name: 'Shop\u00adA' })).toMatch(/no control or format characters/)
    expect(adSet({ dsa_payor: 'Shop 👨‍👩‍👧', dsa_beneficiary: 'Shop A' })).toMatch(/no control or format characters/)
  })
  it('review B9 — frequency caps count impressions only', () => {
    expect(adSet({ frequency_control_specs: '[{"event":"VIDEO_VIEWS","interval_days":7,"max_frequency":2}]' })).toMatch(/event is one of IMPRESSIONS/)
  })
  it('Meta\'s check only once proven; the read-back only of the campaign\'s own fields', () => {
    expect(problem({ body: form({ daily_budget: '5000', execution_options: '["validate_only"]' }), objectKind: 'campaign', kind: 'read' })).toMatch(/does not use Meta's check for a campaign settings change yet/)
    expect(campaign({ daily_budget: '5000', fields: 'id,daily_budget,spend_cap' })).toBeNull()
    expect(campaign({ daily_budget: '5000', fields: 'id,targeting' })).toMatch(/reads back only/)
  })
  it('names the ids inside the body for the gateway\'s account check', () => {
    expect(verdict({ body: form({ bid_strategy: 'COST_CAP', adset_bid_amounts: `{"${AD_SET}":150}`, promoted_object: '{"pixel_id":"120000000000050"}' }), objectKind: 'campaign' }))
      .toMatchObject({ write: { ids: [{ id: AD_SET, kind: 'adset' }, { id: '120000000000050', kind: 'pixel' }] } })
  })
})

describe('adset.settings values', () => {
  it('takes the documented shapes', () => {
    expect(adSet({ bid_strategy: 'LOWEST_COST_WITH_MIN_ROAS', bid_constraints: '{"roas_average_floor":25000}' })).toBeNull()
    expect(adSet({ bid_strategy: 'LOWEST_COST_WITHOUT_CAP', bid_constraints: '{}' })).toBeNull()
    expect(adSet({ pacing_type: '["day_parting"]', adset_schedule: '[{"start_minute":540,"end_minute":720,"days":[1,2,3],"timezone_type":"USER"}]' })).toBeNull()
    expect(adSet({ pacing_type: '["standard"]', adset_schedule: '[]' })).toBeNull()
    expect(adSet({ frequency_control_specs: '[{"event":"IMPRESSIONS","interval_days":7,"max_frequency":2}]' })).toBeNull()
    expect(adSet({ attribution_spec: '[{"event_type":"CLICK_THROUGH","window_days":7},{"event_type":"VIEW_THROUGH","window_days":1}]' })).toBeNull()
    expect(adSet({ end_time: '0' })).toBeNull()
    expect(adSet({ daily_spend_cap: META_NO_CAP, daily_min_spend_target: '0' })).toBeNull()
    expect(adSet({ dsa_payor: 'Negozio A — città', dsa_beneficiary: 'Negozio A — città' })).toBeNull()
    expect(adSet({ ad_set_goal: '{"type":2,"existing_customers_exclusions":["120000000000070"]}' })).toBeNull()
    expect(adSet({ regional_regulated_categories: '["TAIWAN_UNIVERSAL"]', regional_regulation_identities: '{"taiwan_universal_payer":"120000000000080","taiwan_universal_beneficiary":"120000000000081"}' })).toBeNull()
    expect(adSet({ brand_safety_config: '{"comment_moderation_filter":"AD_DISABLED"}', contextual_bundling_spec: '{"status":"OPT_OUT"}' })).toBeNull()
    expect(adSet({ full_funnel_exploration_mode: 'LIMITED_EXPLORATION', automatic_manual_state: 'MANUAL', is_incremental_attribution_enabled: 'true' })).toBeNull()
  })
  it('refuses the shapes Meta does not take, or Nexus never sends', () => {
    expect(adSet({ bid_constraints: '{"roas_average_floor":50}' })).toMatch(/100 and 10,000,000/)
    expect(adSet({ bid_constraints: '{"roas_average_floor":25000,"x":1}' })).toMatch(/bid_constraints/)
    expect(adSet({ adset_schedule: '[{"start_minute":545,"end_minute":720,"days":[1],"timezone_type":"USER"}]' })).toMatch(/on the hour/)
    expect(adSet({ adset_schedule: '[{"start_minute":540,"end_minute":720,"days":[7],"timezone_type":"USER"}]' })).toMatch(/0 \(Sunday\)/)
    expect(adSet({ frequency_control_specs: '[{"event":"IMPRESSIONS","interval_days":91,"max_frequency":2}]' })).toMatch(/1 to 90/)
    expect(adSet({ frequency_control_specs: '[{"event":"IMPRESSIONS","interval_days":7,"max_frequency":2,"type":"CAP"}]' })).toMatch(/exactly event/)
    expect(adSet({ attribution_spec: '[{"event_type":"VIEW_THROUGH","window_days":28}]' })).toMatch(/four combinations/)
    expect(adSet({ ad_set_goal: '{"type":3}' })).toMatch(/type is 0/)
    expect(adSet({ ad_set_goal: '{"type":2,"other":[]}' })).toMatch(/ad_set_goal has type and only/)
    expect(adSet({ dsa_payor: 'Shop A' })).toMatch(/go together/)
    expect(adSet({ dsa_payor: 'x'.repeat(513), dsa_beneficiary: 'Shop A' })).toMatch(/1 to 512/)
    expect(adSet({ regional_regulation_identities: '{"eu_payer":"1"}' })).toMatch(/documented keys/)
    expect(adSet({ daily_budget: '5000', lifetime_budget: '9000' })).toMatch(/not both/)
    expect(adSet({ targeting: '{}' })).toMatch(/only Meta change/)
    expect(adSet({ status: 'ACTIVE', end_time: '1893456000' })).toMatch(/only Meta change/)
    expect(problem({ body: form({ name: 'x', execution_options: '["validate_only"]' }), objectKind: 'adset', url: `${BASE}/${AD_SET}`, kind: 'read' })).toMatch(/only Meta change/)
  })
  it('ad ids past 2^53 are judged and named as digits, never through a JS number', () => {
    const big = '120212345678901234'
    const v = verdict({ body: form({ time_based_ad_rotation_id_blocks: `[[${big}],[${AD}]]`, time_based_ad_rotation_intervals: '[1793520000,1793606400]' }), objectKind: 'adset', url: `${BASE}/${AD_SET}` })
    expect(v).toMatchObject({ write: { ids: [{ id: big, kind: 'ad' }, { id: AD, kind: 'ad' }] } })
    expect(adSet({ time_based_ad_rotation_id_blocks: `[[${big}]]`, time_based_ad_rotation_intervals: '[1793520000]' })).toMatch(/2 to 50 lists/)
    expect(adSet({ time_based_ad_rotation_id_blocks: `[[${big}],[${AD}]]`, time_based_ad_rotation_intervals: '[1793520000]' })).toMatch(/2 to 50 UTC/)
    expect(adSet({ time_based_ad_rotation_id_blocks: `[[${big}],[${AD}]]` })).toMatch(/go together/)
  })
  it('names custom audiences, ads of a sequence and the pixel for the account check', () => {
    expect(verdict({ body: form({ ad_set_goal: '{"type":1,"existing_customers_exclusions":["120000000000070"],"engaged_audiences_exclusions":["120000000000071"]}', creative_sequence: `["${AD}"]` }), objectKind: 'adset', url: `${BASE}/${AD_SET}` }))
      .toMatchObject({ write: { ids: [{ id: '120000000000070', kind: 'customaudience' }, { id: '120000000000071', kind: 'customaudience' }, { id: AD, kind: 'ad' }] } })
  })
})

describe('budget schedules', () => {
  const create = (o: Record<string, string>, objectKind = 'campaign') => problem({ url: `${BASE}/${CAMPAIGN}/budget_schedules`, body: form(o), objectKind })
  it('a create on a campaign\'s or ad set\'s edge, with the four required keys; at least 3 hours', () => {
    const ok = { budget_value: '20', budget_value_type: 'ABSOLUTE', time_start: '1793520000', time_end: '1793563200' }
    expect(verdict({ url: `${BASE}/${CAMPAIGN}/budget_schedules`, body: form(ok), objectKind: 'campaign' })).toMatchObject({ write: { rule: 'budget_schedule.create', objectId: CAMPAIGN } })
    expect(create(ok, 'adset')).toBeNull()
    expect(create(ok, 'ad')).toMatch(/only Meta change/)
    expect(create({ ...ok, time_end: '1793530000' })).toMatch(/at least 3 hours/)
    expect(create({ ...ok, budget_value: '0' })).toMatch(/between 1/)
    expect(create({ ...ok, budget_value_type: 'PERCENT' })).toMatch(/ABSOLUTE, MULTIPLIER/)
    expect(create({ ...ok, recurrence_type: 'WEEKLY' })).toMatch(/only Meta change/)
    expect(create({ budget_value: '20', budget_value_type: 'ABSOLUTE', time_start: '1793520000' })).toMatch(/only Meta change/)
    expect(create({ ...ok, fields: 'id,budget_value' })).toBeNull()
  })
  it('a change of a period (SDK only) names it a high-demand period; a DELETE only so, with no body', () => {
    expect(verdict({ url: `${BASE}/${PERIOD}`, body: form({ budget_value: '30' }), objectKind: 'highdemandperiod' })).toMatchObject({ write: { rule: 'budget_schedule.update', kinds: ['highdemandperiod'] } })
    expect(verdict({ url: `${BASE}/${PERIOD}`, method: 'DELETE', objectKind: 'highdemandperiod' })).toEqual({ write: { rule: 'budget_schedule.delete', objectId: PERIOD, check: false, body: '', budget: false, kinds: ['highdemandperiod'], method: 'DELETE' } })
    expect(problem({ url: `${BASE}/${PERIOD}`, method: 'DELETE', objectKind: 'highdemandperiod', body: 'x=1' })).toMatch(/deletes on Meta only a scheduled budget increase/)
    // Step 19 — a campaign's DELETE is on the list now (object.delete: the undo of a create or a copy); with a body, never.
    expect(verdict({ url: `${BASE}/${CAMPAIGN}`, method: 'DELETE', objectKind: 'campaign' })).toMatchObject({ write: { rule: 'object.delete', method: 'DELETE' } })
    expect(problem({ url: `${BASE}/${CAMPAIGN}`, method: 'DELETE', objectKind: 'campaign', body: 'x=1' })).toMatch(/deletes on Meta only/)
    expect(problem({ url: `${BASE}/${PERIOD}`, method: 'DELETE', objectKind: 'highdemandperiod', kind: 'read' })).toMatch(/goes as a write/)
  })
})

describe('through the gateway: the ids inside a body and a period\'s campaign are of the chosen account', () => {
  it('a period is changed only when its campaign is the account\'s AND Meta lists it among the campaign\'s schedules', async () => {
    const none = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: PERIOD, objectKind: 'highdemandperiod', params: { budget_value: '30' }, check: false }).catch((e) => e)
    expect(none).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/names the campaign or ad set it belongs to/) })
    h.answers.push(json({ data: [{ id: '120000000000032' }] }))
    const foreign = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: PERIOD, objectKind: 'highdemandperiod', params: { budget_value: '30' }, check: false, parent: { kind: 'campaign', id: CAMPAIGN } }).catch((e) => e)
    expect(foreign).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/is not a budget schedule of campaign/) })
    expect(new URL(h.calls[0].url).pathname).toBe(`/v26.0/${CAMPAIGN}/budget_schedules`)
    gatewayMetaStored['120000000000009'] = { adAccountId: '5555555555', kind: 'campaign' }
    const otherAccount = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: PERIOD, objectKind: 'highdemandperiod', params: { budget_value: '30' }, check: false, parent: { kind: 'campaign', id: '120000000000009' } }).catch((e) => e)
    expect(otherAccount).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    h.calls = []
    h.answers.push(json({ data: [{ id: PERIOD }] }), json({ success: true }))
    const res = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: PERIOD, objectKind: 'highdemandperiod', params: {}, check: false, method: 'DELETE', parent: { kind: 'campaign', id: CAMPAIGN } })
    expect(res.ok).toBe(true)
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).pathname])).toEqual([['GET', `/v26.0/${CAMPAIGN}/budget_schedules`], ['DELETE', `/v26.0/${PERIOD}`]])
  })
  it('a create goes on the campaign\'s edge after the campaign\'s own account check', async () => {
    const res = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: CAMPAIGN, objectKind: 'campaign', edge: 'budget_schedules', params: { budget_value: '20', budget_value_type: 'ABSOLUTE', time_start: '1793520000', time_end: '1793563200' }, check: false })
    expect(res.ok).toBe(true)
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).pathname])).toEqual([['POST', `/v26.0/${CAMPAIGN}/budget_schedules`]])
  })
  it('a child ad set of another business\'s account inside adset_budgets: nothing is sent, the other account never named', async () => {
    h.answers.push(json({ id: '120000000000099', account_id: '5555555555', optimization_goal: 'REACH', billing_event: 'IMPRESSIONS' }))
    const err = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: CAMPAIGN, objectKind: 'campaign', params: { adset_budgets: '[{"adset_id":"120000000000099","daily_budget":2500}]' }, check: false }).catch((e) => e)
    expect(err).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/inside this change/) })
    expect(err.message).not.toContain('5555555555')
    expect(h.calls.every((c) => c.init.method === 'GET')).toBe(true)
  })
  it('a custom audience inside a customer goal is read with the fields only an audience has', async () => {
    h.answers.push(json({ id: '120000000000070', account_id: '1234567890', subtype: 'CUSTOM', time_created: 1700000000 }), json({ id: AD_SET }))
    const res = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: AD_SET, objectKind: 'adset', params: { ad_set_goal: '{"type":2,"existing_customers_exclusions":["120000000000070"]}' }, check: false })
    expect(res.ok).toBe(true)
    expect(new URL(h.calls[0].url).searchParams.get('fields')).toBe('account_id,subtype,time_created')
    expect(h.calls.map((c) => c.init.method)).toEqual(['GET', 'POST'])
  })
  it('review A4 + owner fix — a catalog or a product set inside a promoted object follows step 12\'s read rule (portfolio, owner not another business\'s)', async () => {
    const PORTFOLIO = '120000000000090'
    const promoted = (o: Record<string, string>) => ({ promoted_object: JSON.stringify(o) })
    expect(verdict({ body: form(promoted({ product_catalog_id: '120000000000060', product_set_id: '120000000000061' })), objectKind: 'campaign' }))
      .toMatchObject({ write: { ids: [{ id: '120000000000060', kind: 'catalog' }, { id: '120000000000061', kind: 'productset' }] } })
    // A forged catalog id: neither the portfolio's own nor one of its client catalogs.
    h.answers.push(json({ id: 'act_1234567890', business: { id: PORTFOLIO } }), json({ id: '120000000000069', business: { id: '120000000000099' } }), json({ data: [] }))
    const forged = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: CAMPAIGN, objectKind: 'campaign', params: promoted({ product_catalog_id: '120000000000069' }), check: false }).catch((e) => e)
    expect(forged).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/inside this change, That catalog is not owned by the chosen ad account's business portfolio, nor shared with it as a client catalog/) })
    expect(h.calls.map((c) => new URL(c.url).pathname)).toEqual(['/v26.0/act_1234567890', '/v26.0/120000000000069', `/v26.0/${PORTFOLIO}/client_product_catalogs`])
    // OWNER FIX — a client catalog whose owner is a portfolio another business in Nexus uses: refused, nothing is sent.
    h.calls = []
    h.takenPortfolios.add('120000000000081')
    h.answers.push(json({ id: 'act_1234567890', business: { id: PORTFOLIO } }), json({ id: '120000000000063', business: { id: '120000000000081' } }), json({ data: [{ id: '120000000000063' }] }))
    const ofAnother = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: CAMPAIGN, objectKind: 'campaign', params: promoted({ product_catalog_id: '120000000000063' }), check: false }).catch((e) => e)
    expect(ofAnother).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/belongs to a business portfolio another business in Nexus uses/) })
    expect(h.calls.every((c) => c.init.method === 'GET')).toBe(true)
    h.takenPortfolios.clear()
    // A product set of a foreign catalog.
    h.calls = []
    h.answers.push(json({ id: 'act_1234567890', business: { id: PORTFOLIO } }), json({ id: '120000000000061', product_catalog: { id: '120000000000068' } }), json({ id: '120000000000068', business: { id: '120000000000099' } }), json({ data: [] }))
    const foreignSet = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: AD_SET, objectKind: 'adset', params: promoted({ product_set_id: '120000000000061' }), check: false }).catch((e) => e)
    expect(foreignSet).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    // A portfolio another Nexus business uses: nothing is named from it, before any catalog is read.
    h.calls = []
    h.takenPortfolios.add(PORTFOLIO)
    h.answers.push(json({ id: 'act_1234567890', business: { id: PORTFOLIO } }))
    const taken = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: CAMPAIGN, objectKind: 'campaign', params: promoted({ product_catalog_id: '120000000000060' }), check: false }).catch((e) => e)
    expect(taken).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/shared with another business in Nexus/) })
    expect(h.calls).toHaveLength(1)
    // The portfolio's own catalog goes.
    h.calls = []
    h.takenPortfolios.clear()
    h.answers.push(json({ id: 'act_1234567890', business: { id: PORTFOLIO } }), json({ id: '120000000000060', business: { id: PORTFOLIO } }), json({ id: CAMPAIGN }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: CAMPAIGN, objectKind: 'campaign', params: promoted({ product_catalog_id: '120000000000060' }), check: false })).ok).toBe(true)
    expect(h.calls.map((c) => c.init.method)).toEqual(['GET', 'GET', 'POST'])
  })
  it('round 2 — a catalog lookup that FAILS (Meta refuses it, or the database) refuses the change: nothing is sent', async () => {
    const promoted = { promoted_object: JSON.stringify({ product_catalog_id: '120000000000060' }) }
    h.answers.push(json({ error: { code: 200, message: 'Permissions error' } }, 400))
    const metaFails = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: CAMPAIGN, objectKind: 'campaign', params: promoted, check: false }).catch((e) => e)
    expect(metaFails).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/could not confirm the catalog/) })
    h.takenFails = true
    h.answers.push(json({ id: 'act_1234567890', business: { id: '120000000000090' } }))
    const dbFails = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: CAMPAIGN, objectKind: 'campaign', params: promoted, check: false }).catch((e) => e)
    expect(dbFails).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/could not confirm the catalog \(connection to the database lost\)/) })
    expect(h.calls.every((c) => c.init.method === 'GET')).toBe(true)
  })
  it('a pixel inside a promoted object must be one of the chosen account\'s own pixels', async () => {
    h.answers.push(json({ data: [{ id: '120000000000051' }] }))
    const err = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: CAMPAIGN, objectKind: 'campaign', params: { promoted_object: '{"pixel_id":"120000000000050"}' }, check: false }).catch((e) => e)
    expect(err).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/pixel 120000000000050/) })
    expect(new URL(h.calls[0].url).pathname).toBe('/v26.0/act_1234567890/adspixels')
    h.calls = []
    h.answers.push(json({ data: [{ id: '120000000000050' }] }), json({ id: CAMPAIGN }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: CAMPAIGN, objectKind: 'campaign', params: { promoted_object: '{"pixel_id":"120000000000050"}' }, check: false })).ok).toBe(true)
    expect(h.calls.map((c) => c.init.method)).toEqual(['GET', 'POST'])
  })
})
