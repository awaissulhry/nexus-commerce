/**
 * Meta step 19 on the gateway: the creates of create-meta-campaign and create-meta-ad-set, the copies of copy-meta-ads (one
 * by one, in the background, asynchronous ads) and the DELETE their undo sends reach Meta only on their EXACT allow-list
 * entries — a create only to the chosen ad account itself (act_<id>, kind adaccount), keys per edge, every value judged,
 * JSON in one spelling only — and every id inside a body (a campaign, custom audiences, the Page, a custom conversion, a
 * product set, each background part's object) is of the chosen ad account or its chosen Page. Made-up ids only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, answers: [] as Array<() => Response> }))
vi.mock('../marketing/meta-ads/taken.js', () => ({ takenIds: vi.fn(async () => new Set<string>()) }))
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

import { gatewayLedger, gatewayMetaChosen, gatewayMetaPage, gatewayMetaStored } from '../../test-support/gateway-stubs.js'
import { __rateTest } from './rate.js'
import { metaWriteCall } from './meta.js'
import { metaWriteVerdict } from './meta-calls.js'
import { META_PCA_UNIFIED_FROM } from './meta-create-rules.js'
import { __metaObjectLimitsTest } from './meta-object-limits.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../meta/api-version.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const ACT = 'act_1234567890'
const CAMPAIGN = '120000000000001'
const AD_SET = '120000000000002'
const AD = '120000000000003'
const form = (o: Record<string, string>) => new URLSearchParams(o).toString()
const verdict = (input: { body?: unknown; objectKind?: string; url?: string; method?: string; kind?: string }) =>
  metaWriteVerdict({ method: input.method ?? 'POST', url: input.url ?? `${BASE}/${ACT}/campaigns`, kind: input.kind ?? 'write', body: input.body, objectKind: input.objectKind ?? 'adaccount' })
const problem = (input: Parameters<typeof verdict>[0]) => { const v = verdict(input); return 'problem' in v ? v.problem : null }
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status })

const CAMPAIGN_CREATE = { name: 'Shop A — spring 🌸', objective: 'OUTCOME_SALES', special_ad_categories: '[]', status: 'PAUSED', bid_strategy: 'LOWEST_COST_WITHOUT_CAP', daily_budget: '5000' }
const campaignCreate = (o: Record<string, string | undefined>) => problem({ body: form(Object.fromEntries(Object.entries({ ...CAMPAIGN_CREATE, ...o }).filter(([, v]) => v !== undefined)) as Record<string, string>) })
const TARGETING = '{"geo_locations":{"countries":["IT"]},"targeting_automation":{"advantage_audience":0}}'
const AD_SET_CREATE = { name: 'Ad set B', campaign_id: CAMPAIGN, optimization_goal: 'LINK_CLICKS', billing_event: 'IMPRESSIONS', targeting: TARGETING, status: 'PAUSED', daily_budget: '2000', bid_strategy: 'LOWEST_COST_WITHOUT_CAP' }
const adSetCreate = (o: Record<string, string | undefined>) => problem({ url: `${BASE}/${ACT}/adsets`, body: form(Object.fromEntries(Object.entries({ ...AD_SET_CREATE, ...o }).filter(([, v]) => v !== undefined)) as Record<string, string>) })
const copy = (kind: string, id: string, o: Record<string, string>) => verdict({ url: `${BASE}/${id}/copies`, objectKind: kind, body: form(o) })
const copyProblem = (kind: string, id: string, o: Record<string, string>) => { const v = copy(kind, id, o); return 'problem' in v ? v.problem : null }

beforeEach(() => {
  __rateTest.useMemory()
  __metaObjectLimitsTest.useMemory()
  h.calls = []; h.answers = []; gatewayLedger.length = 0
  for (const key of Object.keys(gatewayMetaChosen)) delete gatewayMetaChosen[key]
  for (const key of Object.keys(gatewayMetaStored)) delete gatewayMetaStored[key]
  for (const key of Object.keys(gatewayMetaPage)) delete gatewayMetaPage[key]
  gatewayMetaStored[CAMPAIGN] = { adAccountId: '1234567890', kind: 'campaign' }
  gatewayMetaStored[AD_SET] = { adAccountId: '1234567890', kind: 'adset' }
  gatewayMetaStored[AD] = { adAccountId: '1234567890', kind: 'ad' }
  vi.stubEnv('NEXUS_META_ADS_WRITES', 'on')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response(JSON.stringify({ id: '120000000000099' }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); __rateTest.reset(); __metaObjectLimitsTest.reset() })

describe('campaign.create: POST /act_<id>/campaigns', () => {
  it('takes the documented create, named the ad account; the same body on a campaign or with no kind is refused', () => {
    expect(verdict({ body: form(CAMPAIGN_CREATE) })).toMatchObject({ write: { rule: 'campaign.create', objectId: ACT, check: false, budget: false, kinds: ['adaccount'] } })
    expect(problem({ body: form(CAMPAIGN_CREATE), objectKind: 'campaign' })).toMatch(/only Meta change/)
    expect(metaWriteVerdict({ method: 'POST', url: `${BASE}/${ACT}/campaigns`, kind: 'write', body: form(CAMPAIGN_CREATE) })).toMatchObject({ problem: expect.stringMatching(/only Meta change/) })
    expect(problem({ url: `${BASE}/${CAMPAIGN}/campaigns`, body: form(CAMPAIGN_CREATE) })).toMatch(/only Meta change/)
  })
  it('always says its bid strategy, its special ad category and its status; ad set budget sharing when it has no campaign budget', () => {
    expect(campaignCreate({ bid_strategy: undefined })).toMatch(/only Meta change/)
    expect(campaignCreate({ special_ad_categories: undefined })).toMatch(/only Meta change/)
    expect(campaignCreate({ daily_budget: undefined })).toMatch(/is_adset_budget_sharing_enabled explicitly/)
    expect(campaignCreate({ daily_budget: undefined, is_adset_budget_sharing_enabled: 'false' })).toBeNull()
    expect(campaignCreate({ is_adset_budget_sharing_enabled: 'true' })).toMatch(/WITHOUT a campaign budget/)
    expect(campaignCreate({ lifetime_budget: '90000' })).toMatch(/not both/)
    expect(campaignCreate({ status: 'ARCHIVED' })).toMatch(/status/)
  })
  it('never political ads, never CREDIT, never a legacy objective; a category with its countries', () => {
    expect(campaignCreate({ special_ad_categories: '["ISSUES_ELECTIONS_POLITICS"]' })).toMatch(/never political/)
    expect(campaignCreate({ special_ad_categories: '["CREDIT"]' })).toMatch(/special_ad_categories lists/)
    expect(campaignCreate({ special_ad_categories: '["NONE"]' })).toMatch(/special_ad_categories lists/)
    expect(campaignCreate({ special_ad_categories: '["HOUSING"]' })).toMatch(/goes with its countries/)
    expect(campaignCreate({ special_ad_categories: '["HOUSING"]', special_ad_category_country: '["IT"]' })).toBeNull()
    expect(campaignCreate({ objective: 'CONVERSIONS' })).toMatch(/legacy objectives are refused/)
  })
  it('JSON in one spelling; a spend cap is a real cap; reach and frequency without cap or category', () => {
    expect(campaignCreate({ special_ad_categories: '[ ]' })).toMatch(/one spelling/)
    expect(campaignCreate({ spend_cap: '922337203685478' })).toMatch(/never "no cap"/)
    expect(campaignCreate({ spend_cap: '100000' })).toBeNull()
    expect(campaignCreate({ spend_cap: '0' })).toMatch(/spend_cap/)
    expect(campaignCreate({ buying_type: 'RESERVED', spend_cap: '100000' })).toMatch(/RESERVED/)
    expect(campaignCreate({ buying_type: 'RESERVED' })).toBeNull()
    expect(campaignCreate({ buying_type: 'FIXED_CPM' })).toMatch(/buying_type/)
  })
  it('Meta\'s check (validate_only, with or without recommendations) goes as a read; no other execution option', () => {
    expect(verdict({ kind: 'read', body: form({ ...CAMPAIGN_CREATE, execution_options: '["validate_only","include_recommendations"]' }) })).toMatchObject({ write: { rule: 'campaign.create', check: true } })
    expect(verdict({ kind: 'read', body: form({ ...CAMPAIGN_CREATE, execution_options: '["validate_only"]' }) })).toMatchObject({ write: { check: true } })
    expect(problem({ kind: 'write', body: form({ ...CAMPAIGN_CREATE, execution_options: '["validate_only"]' }) })).toMatch(/goes as a read/)
    expect(campaignCreate({ execution_options: '["include_recommendations"]' })).toMatch(/only execution_options/)
  })
  it('budget schedules: daily budget only, at least 3 hours, the four keys', () => {
    const spec = (o: Record<string, unknown>) => JSON.stringify([{ time_start: 1893456000, time_end: 1893477600, budget_value: 20, budget_value_type: 'ABSOLUTE', ...o }])
    expect(campaignCreate({ budget_schedule_specs: spec({}) })).toBeNull()
    expect(campaignCreate({ budget_schedule_specs: spec({ time_end: 1893459600 }) })).toMatch(/at least 3 hours/)
    expect(campaignCreate({ budget_schedule_specs: spec({ recurrence_type: 'WEEKLY' }) })).toMatch(/exactly time_start/)
    expect(campaignCreate({ budget_schedule_specs: spec({ budget_value_type: 'MULTIPLIER', budget_value: 800 }) })).toMatch(/at most 700/)
    expect(campaignCreate({ daily_budget: undefined, lifetime_budget: '90000', budget_schedule_specs: spec({}) })).toMatch(/daily budget only/)
  })
  it('CMP-087 — is_pca_unified only from 2026-10-22, only true, only for Sales', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(META_PCA_UNIFIED_FROM - 1000)
    expect(campaignCreate({ is_pca_unified: 'true' })).toMatch(/from 2026-10-22/)
    vi.setSystemTime(META_PCA_UNIFIED_FROM)
    expect(campaignCreate({ is_pca_unified: 'true' })).toBeNull()
    expect(campaignCreate({ is_pca_unified: 'false' })).toMatch(/only as true/)
    expect(campaignCreate({ is_pca_unified: 'true', objective: 'OUTCOME_TRAFFIC' })).toMatch(/OUTCOME_SALES objective only/)
  })
  it('names the source campaign and the promoted object\'s ids for the account check', () => {
    expect(verdict({ body: form({ ...CAMPAIGN_CREATE, source_campaign_id: CAMPAIGN, promoted_object: '{"pixel_id":"120000000000050","custom_event_type":"PURCHASE"}' }) }))
      .toMatchObject({ write: { ids: [{ id: CAMPAIGN, kind: 'campaign' }, { id: '120000000000050', kind: 'pixel' }] } })
  })
})

describe('adset.create: POST /act_<id>/adsets', () => {
  it('takes the documented create with its minimal targeting', () => {
    expect(verdict({ url: `${BASE}/${ACT}/adsets`, body: form(AD_SET_CREATE) })).toMatchObject({ write: { rule: 'adset.create', objectId: ACT, budget: false, ids: [{ id: CAMPAIGN, kind: 'campaign' }] } })
    expect(adSetCreate({ targeting: undefined })).toMatch(/only Meta change/)
    expect(adSetCreate({ campaign_id: undefined })).toMatch(/only Meta change/)
  })
  it('targeting: an exact shape, Advantage+ audience always said, never location_types', () => {
    expect(adSetCreate({ targeting: '{"geo_locations":{"countries":["IT"]}}' })).toMatch(/targeting has geo_locations and targeting_automation/)
    expect(adSetCreate({ targeting: '{"geo_locations":{"countries":["IT"],"location_types":["home"]},"targeting_automation":{"advantage_audience":0}}' })).toMatch(/nothing else/)
    expect(adSetCreate({ targeting: '{"geo_locations":{},"targeting_automation":{"advantage_audience":0}}' })).toMatch(/countries, regions or cities/)
    expect(adSetCreate({ targeting: '{"geo_locations":{"countries":["IT"]},"interests":[{"id":"1"}],"targeting_automation":{"advantage_audience":0}}' })).toMatch(/and only/)
    expect(adSetCreate({ targeting: '{"geo_locations":{"countries":["IT"]},"age_max":40,"targeting_automation":{"advantage_audience":1}}' })).toMatch(/no age_max/)
    expect(adSetCreate({ targeting: '{"geo_locations":{"countries":["IT"]},"age_min":30,"targeting_automation":{"advantage_audience":1}}' })).toMatch(/25 at most/)
    expect(adSetCreate({ targeting: '{"geo_locations":{"cities":[{"key":"1000001","radius":10,"distance_unit":"kilometer"}]},"targeting_automation":{"advantage_audience":0}}' })).toMatch(/radius 17–80/)
    expect(adSetCreate({ targeting: '{"geo_locations":{"cities":[{"key":"1000001","radius":20,"distance_unit":"kilometer"}],"regions":[{"key":"1000002"}]},"age_min":18,"age_max":54,"genders":[2],"targeting_automation":{"advantage_audience":0}}' })).toBeNull()
    expect(adSetCreate({ targeting: '{"geo_locations":{"countries":["IT"]},"genders":[1,2],"targeting_automation":{"advantage_audience":0}}' })).toMatch(/genders/)
    expect(adSetCreate({ targeting: '{"geo_locations": {"countries":["IT"]},"targeting_automation":{"advantage_audience":0}}' })).toMatch(/one spelling/)
  })
  it('budgets, bids and the EU payer as step 18 judges them; a ROAS floor may go alone (the campaign\'s strategy)', () => {
    expect(adSetCreate({ lifetime_budget: '90000' })).toMatch(/not both/)
    expect(adSetCreate({ daily_budget: undefined, lifetime_budget: '90000' })).toMatch(/needs an end time/)
    expect(adSetCreate({ dsa_payor: 'Shop A' })).toMatch(/go together/)
    expect(adSetCreate({ dsa_payor: 'Shop A', dsa_beneficiary: 'Shop A‮' })).toMatch(/printable text/)
    expect(adSetCreate({ bid_strategy: 'LOWEST_COST_WITH_MIN_ROAS', bid_amount: '150' })).toMatch(/no bid_amount/)
    expect(adSetCreate({ bid_strategy: undefined, daily_budget: undefined, bid_constraints: '{"roas_average_floor":20000}' })).toBeNull()
    expect(adSetCreate({ bid_constraints: '{"roas_average_floor":20000}' })).toMatch(/go with the LOWEST_COST_WITH_MIN_ROAS/)
    expect(adSetCreate({ destination_type: 'SHOP_AUTOMATIC', is_dynamic_creative: 'true' })).toBeNull()
    expect(adSetCreate({ destination_type: 'STORE' })).toMatch(/destination_type/)
  })
  it('names every id inside: campaign, custom audiences, Page, custom conversion, product sets, pixel', () => {
    const targeting = '{"geo_locations":{"countries":["IT"]},"custom_audiences":[{"id":"120000000000070"}],"excluded_custom_audiences":[{"id":"120000000000071"}],"targeting_automation":{"advantage_audience":0}}'
    const promoted = '{"page_id":"120000000000080","custom_conversion_id":"120000000000081","product_set_id":"120000000000061","boosted_product_set_id":"120000000000062"}'
    const v = verdict({ url: `${BASE}/${ACT}/adsets`, body: form({ ...AD_SET_CREATE, targeting, promoted_object: promoted }) })
    expect(v).toMatchObject({ write: { ids: [
      { id: CAMPAIGN, kind: 'campaign' }, { id: '120000000000070', kind: 'customaudience' }, { id: '120000000000071', kind: 'customaudience' },
      { id: '120000000000080', kind: 'page' }, { id: '120000000000081', kind: 'customconversion' }, { id: '120000000000062', kind: 'productset' }, { id: '120000000000061', kind: 'productset' },
    ] } })
    expect(adSetCreate({ promoted_object: '{"boosted_product_set_id":"120000000000062"}' })).toMatch(/goes with the catalog's product_set_id/)
    expect(adSetCreate({ promoted_object: '{"application_id":"1"}' })).toMatch(/promoted_object has only/)
  })
})

describe('copies: POST /<id>/copies, one rule per kind', () => {
  it('a campaign\'s, an ad set\'s and an ad\'s copy, each its own keys; status_option always said', () => {
    expect(copy('campaign', CAMPAIGN, { status_option: 'PAUSED', deep_copy: 'true' })).toMatchObject({ write: { rule: 'campaign.copy', objectId: CAMPAIGN, kinds: ['campaign'] } })
    expect(copy('adset', AD_SET, { status_option: 'PAUSED', campaign_id: CAMPAIGN })).toMatchObject({ write: { rule: 'adset.copy', ids: [{ id: CAMPAIGN, kind: 'campaign' }] } })
    expect(copy('ad', AD, { status_option: 'INHERITED_FROM_SOURCE', adset_id: AD_SET })).toMatchObject({ write: { rule: 'ad.copy', ids: [{ id: AD_SET, kind: 'adset' }] } })
    expect(copyProblem('campaign', CAMPAIGN, { deep_copy: 'true' })).toMatch(/only Meta change/)
    expect(copyProblem('campaign', CAMPAIGN, { status_option: 'PAUSED', campaign_id: CAMPAIGN })).toMatch(/only Meta change/)
    expect(copyProblem('ad', AD, { status_option: 'PAUSED', deep_copy: 'true' })).toMatch(/only Meta change/)
    expect(copyProblem('adset', AD_SET, { status_option: 'DELETED' })).toMatch(/status_option/)
  })
  it('a campaign\'s times only with its children; one budget override only; rename and creative in one shape', () => {
    expect(copyProblem('campaign', CAMPAIGN, { status_option: 'PAUSED', start_time: '1893456000' })).toMatch(/deep_copy=true only/)
    expect(copyProblem('campaign', CAMPAIGN, { status_option: 'PAUSED', deep_copy: 'true', start_time: '1893456000', end_time: '0' })).toBeNull()
    expect(copyProblem('campaign', CAMPAIGN, { status_option: 'PAUSED', parameter_overrides: '{"daily_budget":7000}' })).toBeNull()
    expect(copyProblem('campaign', CAMPAIGN, { status_option: 'PAUSED', parameter_overrides: '{"daily_budget":7000,"name":"x"}' })).toMatch(/exactly one of/)
    expect(copyProblem('adset', AD_SET, { status_option: 'PAUSED', rename_options: '{"rename_strategy":"DEEP_RENAME","rename_suffix":" — IT"}' })).toMatch(/rename_suffix is 1 to 100/)
    expect(copyProblem('adset', AD_SET, { status_option: 'PAUSED', rename_options: '{"rename_strategy":"DEEP_RENAME","rename_suffix":"— IT"}' })).toBeNull()
    expect(copyProblem('adset', AD_SET, { status_option: 'PAUSED', rename_options: '{"rename_strategy":"ALL"}' })).toMatch(/rename_strategy is one of/)
    expect(copyProblem('ad', AD, { status_option: 'PAUSED', creative_parameters: '{"name":"Copy A","url_tags":"utm_source=meta&utm_medium=paid"}' })).toBeNull()
    expect(copyProblem('ad', AD, { status_option: 'PAUSED', creative_parameters: '{"object_story_spec":{}}' })).toMatch(/name and \/ or url_tags only/)
    expect(copyProblem('ad', AD, { status_option: 'PAUSED', creative_parameters: '{"url_tags":"a b"}' })).toMatch(/url_tags/)
  })
})

describe('background copies (CMP-054) and asynchronous ad copies (AD-048)', () => {
  const part = (o: Record<string, unknown>) => ({ name: 'campaign_copy_1', relative_url: `${CAMPAIGN}/copies`, body: 'status_option=PAUSED&deep_copy=true', ...o })
  const background = (parts: unknown[], name = 'Nexus copy') => verdict({ url: `${BASE}/${ACT}/async_batch_requests`, body: form({ name, adbatch: JSON.stringify(parts) }) })
  const backgroundProblem = (parts: unknown[]) => { const v = background(parts); return 'problem' in v ? v.problem : null }
  it('an async batch of deep copies only, each part judged as the copy it is and named for the account check', () => {
    expect(background([part({}), part({ name: 'adset_copy_2', relative_url: `${AD_SET}/copies`, body: `status_option=PAUSED&deep_copy=true&campaign_id=${CAMPAIGN}` })]))
      .toMatchObject({ write: { rule: 'copy.background', objectId: ACT, ids: [{ id: CAMPAIGN, kind: 'campaign' }, { id: AD_SET, kind: 'adset' }, { id: CAMPAIGN, kind: 'campaign' }] } })
    expect(backgroundProblem([part({ name: 'one' })])).toMatch(/named campaign_copy_1/)
    expect(backgroundProblem([part({ body: 'status_option=PAUSED' })])).toMatch(/deep copy/)
    expect(backgroundProblem([part({ relative_url: CAMPAIGN, body: 'status=PAUSED' })])).toMatch(/relative_url is <id>\/copies/)
    expect(backgroundProblem([part({ body: 'deep_copy=true&status_option=PAUSED&deep_copy=true' })])).toMatch(/one spelling, each key once/)
    expect(backgroundProblem([part({ body: 'status_option=PAUSED&deep_copy=true&campaign_id=1' })])).toMatch(/campaign_id is not a key/)
    expect(backgroundProblem(Array.from({ length: 9 }, (_, i) => part({ name: `campaign_copy_${i + 1}`, relative_url: `12000000000000${i + 10}/copies` })))).toMatch(/1 to 8 copies/)
    expect(backgroundProblem([part({}), part({ name: 'campaign_copy_2' })])).toMatch(/each object once/)
    expect(backgroundProblem([{ ...part({}), method: 'DELETE' }])).toMatch(/exactly name, relative_url and body/)
  })
  it('asyncadcopies: the ads\' ids and the copy\'s own keys, each ad named for the account check', () => {
    const v = verdict({ url: `${BASE}/${ACT}/asyncadcopies`, body: form({ ad_ids: `["${AD}","120000000000004"]`, status_option: 'PAUSED', adset_id: AD_SET }) })
    expect(v).toMatchObject({ write: { rule: 'ad.copy.background', ids: [{ id: AD, kind: 'ad' }, { id: '120000000000004', kind: 'ad' }, { id: AD_SET, kind: 'adset' }] } })
    expect(problem({ url: `${BASE}/${ACT}/asyncadcopies`, body: form({ ad_ids: '[]', status_option: 'PAUSED' }) })).toMatch(/1 to 50 ad ids/)
  })
})

describe('object.delete: the undo of a create or a copy', () => {
  it('a DELETE of a campaign, ad set or ad named with its kind, with no body; nothing else', () => {
    for (const kind of ['campaign', 'adset', 'ad']) {
      expect(verdict({ url: `${BASE}/${CAMPAIGN}`, method: 'DELETE', objectKind: kind })).toMatchObject({ write: { rule: 'object.delete', method: 'DELETE', body: '' } })
    }
    expect(problem({ url: `${BASE}/${CAMPAIGN}`, method: 'DELETE', objectKind: 'campaign', body: 'x=1' })).toMatch(/deletes nothing on Meta yet/)
    expect(metaWriteVerdict({ method: 'DELETE', url: `${BASE}/${CAMPAIGN}`, kind: 'write' })).toMatchObject({ problem: expect.stringMatching(/deletes nothing/) })
    expect(problem({ url: `${BASE}/${ACT}`, method: 'DELETE', objectKind: 'adaccount' })).toMatch(/deletes nothing/)
  })
})

describe('through the gateway: a create goes only to the chosen ad account; every id inside is its own', () => {
  it('a create of another ad account sends nothing; the chosen one goes, and Meta\'s check of it goes as a read', async () => {
    const other = await metaWriteCall({ connectionId: 'm-1', operation: 'campaign.create', objectId: 'act_5555555555', objectKind: 'adaccount', edge: 'campaigns', params: CAMPAIGN_CREATE, check: false }).catch((e) => e)
    expect(other).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    expect(other.message).not.toContain('5555555555')
    expect(h.calls).toHaveLength(0)
    const check = await metaWriteCall({ connectionId: 'm-1', operation: 'campaign.create.check', objectId: ACT, objectKind: 'adaccount', edge: 'campaigns', params: CAMPAIGN_CREATE, check: true, recommendations: true })
    expect(check.ok).toBe(true)
    expect(new URLSearchParams(String(h.calls[0].init.body)).get('execution_options')).toBe('["validate_only","include_recommendations"]')
    expect(new URL(h.calls[0].url).pathname).toBe(`/v26.0/${ACT}/campaigns`)
    gatewayMetaChosen['m-2'] = null
    expect(await metaWriteCall({ connectionId: 'm-2', operation: 'x', objectId: ACT, objectKind: 'adaccount', edge: 'campaigns', params: CAMPAIGN_CREATE, check: false }).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
  })
  it('the Page of a promoted object is the chosen Page; a custom conversion one of the account\'s own', async () => {
    const promoted = (o: Record<string, string>) => ({ ...AD_SET_CREATE, promoted_object: JSON.stringify(o) })
    const noPage = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'adaccount', edge: 'adsets', params: promoted({ page_id: '120000000000080' }), check: false }).catch((e) => e)
    expect(noPage).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/Page 120000000000080 is not the Facebook Page this business chose/) })
    gatewayMetaPage['m-1'] = '120000000000080'
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'adaccount', edge: 'adsets', params: promoted({ page_id: '120000000000080' }), check: false })).ok).toBe(true)
    h.calls = []
    h.answers.push(json({ data: [{ id: '120000000000082' }] }))
    const foreign = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'adaccount', edge: 'adsets', params: promoted({ custom_conversion_id: '120000000000081' }), check: false }).catch((e) => e)
    expect(foreign).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/custom conversion 120000000000081/) })
    expect(new URL(h.calls[0].url).pathname).toBe(`/v26.0/${ACT}/customconversions`)
    expect(h.calls.every((c) => c.init.method === 'GET')).toBe(true)
  })
  it('a background copy of another account\'s campaign sends nothing; a DELETE of another account\'s ad set neither', async () => {
    gatewayMetaStored['120000000000009'] = { adAccountId: '5555555555', kind: 'campaign' }
    const adbatch = JSON.stringify([{ name: 'campaign_copy_1', relative_url: '120000000000009/copies', body: 'status_option=PAUSED&deep_copy=true' }])
    const err = await metaWriteCall({ connectionId: 'm-1', operation: 'copy.background', objectId: ACT, objectKind: 'adaccount', edge: 'async_batch_requests', params: { name: 'Nexus copy', adbatch }, check: false }).catch((e) => e)
    expect(err).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/inside this change/) })
    gatewayMetaStored['120000000000019'] = { adAccountId: '5555555555', kind: 'adset' }
    const del = await metaWriteCall({ connectionId: 'm-1', operation: 'adset.delete', objectId: '120000000000019', objectKind: 'adset', params: {}, check: false, method: 'DELETE' }).catch((e) => e)
    expect(del).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    expect(h.calls).toHaveLength(0)
    const ok = await metaWriteCall({ connectionId: 'm-1', operation: 'adset.delete', objectId: AD_SET, objectKind: 'adset', params: {}, check: false, method: 'DELETE' })
    expect(ok.ok).toBe(true)
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).pathname, c.init.body || null])).toEqual([['DELETE', `/v26.0/${AD_SET}`, null]])
  })
})
