/**
 * Meta step 28 on the gateway: an apply of a recommendation, a new study, a study change and a Page video test reach
 * Meta only on their EXACT allow-list entries — keys per kind of object (named and then confirmed), every value judged,
 * JSON (and JSON inside JSON) in one spelling only — and only for what is the chosen ad account's (or Page's): the act_
 * of an apply, the portfolio of a new study, a study that touches the account, each id inside a body. Step 17's status
 * rule and step 18's settings rules are untouched. Made-up ids only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, answers: [] as Array<() => Response>, page: '120000000000010' as string | null }))
vi.mock('../marketing/meta-ads/taken.js', () => ({ takenIds: vi.fn(async () => new Set<string>()) }))
vi.mock('../../db.js', () => ({ default: { metaAccountLink: { findFirst: vi.fn(async () => (h.page ? { externalId: h.page } : null)) } } }))
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
import { __metaObjectLimitsTest } from './meta-object-limits.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../meta/api-version.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const ACT = 'act_1234567890'
const CAMPAIGN = '120000000000001'
const AD_SET = '120000000000002'
const AD = '120000000000003'
const BUSINESS = '120000000000090'
const STUDY = '120000000000041'
const PIXEL = '120000000000050'
const PAGE = '120000000000010'
const form = (o: Record<string, string>) => new URLSearchParams(o).toString()
const verdict = (input: { body?: unknown; objectKind?: string; url: string; method?: string; kind?: string }) =>
  metaWriteVerdict({ method: input.method ?? 'POST', url: input.url, kind: input.kind ?? 'write', body: input.body, objectKind: input.objectKind })
const problem = (input: Parameters<typeof verdict>[0]) => { const v = verdict(input); return 'problem' in v ? v.problem : null }
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status })

const apply = (extra: unknown, signature: unknown = '1234567') => problem({ url: `${BASE}/${ACT}/recommendations`, objectKind: 'adaccount', body: form({ recommendation_signature: JSON.stringify(signature), extra_data: typeof extra === 'string' ? extra : JSON.stringify(extra) }) })
const T0 = 4_102_444_800 // 2100-01-01
const studyBody = (o: Record<string, unknown>) => form(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])))
const create = (o: Record<string, unknown>) => problem({ url: `${BASE}/${BUSINESS}/ad_studies`, objectKind: 'business', body: studyBody(o) })
const update = (o: Record<string, unknown>) => problem({ url: `${BASE}/${STUDY}`, objectKind: 'adstudy', body: studyBody(o) })
const AB = { name: 'Test A', type: 'SPLIT_TEST', start_time: String(T0), end_time: String(T0 + 14 * 86400), cells: [{ name: 'A', treatment_percentage: 50, adsets: [AD_SET] }, { name: 'B', treatment_percentage: 50, adsets: ['120000000000004'] }] }

beforeEach(() => {
  __rateTest.useMemory()
  __metaObjectLimitsTest.useMemory()
  h.calls = []; h.answers = []; h.page = PAGE; gatewayLedger.length = 0
  for (const key of Object.keys(gatewayMetaChosen)) delete gatewayMetaChosen[key]
  for (const key of Object.keys(gatewayMetaStored)) delete gatewayMetaStored[key]
  gatewayMetaStored[CAMPAIGN] = { adAccountId: '1234567890', kind: 'campaign' }
  gatewayMetaStored[AD_SET] = { adAccountId: '1234567890', kind: 'adset' }
  gatewayMetaStored[AD] = { adAccountId: '1234567890', kind: 'ad' }
  gatewayMetaStored['120000000000004'] = { adAccountId: '1234567890', kind: 'adset' }
  vi.stubEnv('NEXUS_META_ADS_WRITES', 'on')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response(JSON.stringify({ success: true }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset(); __metaObjectLimitsTest.reset() })

describe('recommendation.apply: POST /act_<id>/recommendations', () => {
  it('takes Meta\'s documented extra_data shapes, each id named for the account check', () => {
    expect(verdict({ url: `${BASE}/${ACT}/recommendations`, objectKind: 'adaccount', body: form({ recommendation_signature: '"1234567"', extra_data: '{}' }) }))
      .toEqual({ write: { rule: 'recommendation.apply', objectId: ACT, check: false, body: 'recommendation_signature=%221234567%22&extra_data=%7B%7D', budget: false, kinds: ['adaccount'] } })
    expect(apply({ object_selection: `${AD_SET},120000000000004` })).toBeNull()
    expect(verdict({ url: `${BASE}/${ACT}/recommendations`, objectKind: 'adaccount', body: form({ recommendation_signature: '"1"', extra_data: JSON.stringify({ object_selection: `${AD_SET},${AD}` }) }) }))
      .toMatchObject({ write: { ids: [{ id: AD_SET, kind: 'adsetorad' }, { id: AD, kind: 'adsetorad' }] } })
    const overrides = JSON.stringify([{ ad_id: AD, opted_in_creative_feature_names: ['standard_enhancements', 'image_touchups'] }])
    expect(apply({ object_selection: AD, creative_feature_opt_in_overrides: overrides })).toBeNull()
    expect(verdict({ url: `${BASE}/${ACT}/recommendations`, objectKind: 'adaccount', body: form({ recommendation_signature: '"1"', extra_data: JSON.stringify({ action_type: 'OPT_OUT', object_selection: AD }) }) }))
      .toMatchObject({ write: { ids: [{ id: AD, kind: 'ad' }] } })
    const raises = JSON.stringify([{ ad_object_id: AD_SET, additional_budget: 6000 }])
    expect(verdict({ url: `${BASE}/${ACT}/recommendations`, objectKind: 'adaccount', body: form({ recommendation_signature: '"1"', extra_data: JSON.stringify({ adsets: raises, campaigns: JSON.stringify([{ ad_object_id: CAMPAIGN, additional_budget: 10000 }]) }) }) }))
      .toMatchObject({ write: { budget: false, ids: [{ id: AD_SET, kind: 'adset' }, { id: CAMPAIGN, kind: 'campaign' }] } })
  })
  it('refuses every other shape: other keys, a second spelling, features without standard_enhancements, mixed families', () => {
    expect(apply({ object_selection: AD, music_parameters: '{}' })).toMatch(/extra_data has only/)
    expect(apply('{"object_selection": "120000000000003"}')).toMatch(/one spelling/)
    expect(apply('{"object_selection":"1","object_selection":"2"}')).toMatch(/one spelling/)
    expect(apply({ object_selection: `${AD},${AD}` })).toMatch(/each once/)
    expect(apply({ object_selection: ['1'] })).toMatch(/comma list/)
    expect(apply({ object_selection: AD, creative_feature_opt_in_overrides: JSON.stringify([{ ad_id: AD, opted_in_creative_feature_names: ['image_touchups'] }]) })).toMatch(/always includes standard_enhancements/)
    expect(apply({ object_selection: AD, creative_feature_opt_in_overrides: JSON.stringify([{ ad_id: '120000000000099', opted_in_creative_feature_names: ['standard_enhancements'] }]) })).toMatch(/one ad of object_selection/)
    expect(apply({ object_selection: AD, creative_feature_opt_in_overrides: JSON.stringify([{ ad_id: AD, opted_in_creative_feature_names: ['standard_enhancements', 'deep_fake'] }]) })).toMatch(/opted_in_creative_feature_names lists/)
    expect(apply({ object_selection: AD, creative_feature_opt_in_overrides: '[{"ad_id": "1"}]' })).toMatch(/JSON list/)
    expect(apply({ action_type: 'OPT_IN' })).toMatch(/goes with object_selection/)
    expect(apply({ action_type: 'MAYBE', object_selection: AD })).toMatch(/OPT_IN or OPT_OUT/)
    expect(apply({ object_selection: AD, adsets: JSON.stringify([{ ad_object_id: AD_SET, additional_budget: 6000 }]) })).toMatch(/goes alone/)
    expect(apply({ adsets: JSON.stringify([{ ad_object_id: AD_SET, additional_budget: 60.5 }]) })).toMatch(/whole number/)
    expect(apply({ adsets: JSON.stringify([{ ad_object_id: AD_SET, additional_budget: 6000, bid: 1 }]) })).toMatch(/exactly \{ad_object_id, additional_budget\}/)
    expect(apply({ adsets: JSON.stringify([{ ad_object_id: AD_SET, additional_budget: 6000 }]), campaigns: JSON.stringify([{ ad_object_id: AD_SET, additional_budget: 6000 }]) })).toMatch(/never both/)
    expect(apply({}, 1234567)).toMatch(/as a JSON string/)
    expect(apply({}, 'sig"1')).toMatch(/as a JSON string/)
  })
  it('the edge, the kind named and nothing more: no query, no other key, never another account\'s act_', () => {
    expect(problem({ url: `${BASE}/${ACT}/recommendations`, objectKind: 'campaign', body: form({ recommendation_signature: '"1"', extra_data: '{}' }) })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/${ACT}/recommendations`, objectKind: 'adaccount', body: form({ recommendation_signature: '"1"', extra_data: '{}', locale: 'it_IT' }) })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/${ACT}/recommendations?x=1`, objectKind: 'adaccount', body: form({ recommendation_signature: '"1"', extra_data: '{}' }) })).toMatch(/never in the URL/)
    expect(problem({ url: `${BASE}/${CAMPAIGN}/recommendations`, objectKind: 'adaccount', body: form({ recommendation_signature: '"1"', extra_data: '{}' }) })).toMatch(/only Meta change/)
  })
  it('through the gateway: only on the chosen act_, and each object inside of the chosen account (ad set, else ad)', async () => {
    const other = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: 'act_5555555555', objectKind: 'adaccount', edge: 'recommendations', params: { recommendation_signature: '"1"', extra_data: '{}' }, check: false }).catch((e) => e)
    expect(other).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    expect(other.message).not.toContain('5555555555')
    expect(h.calls).toHaveLength(0)
    // An unknown id of object_selection: read as an ad set (Meta: nonexisting field), then as an ad of the chosen account.
    h.answers.push(json({ error: { code: 100, message: '(#100) Tried accessing nonexisting field (optimization_goal)' } }, 400), json({ id: '120000000000005', account_id: '1234567890', adset_id: AD_SET, creative: { id: '9' } }), json({ success: true }))
    const res = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'adaccount', edge: 'recommendations', params: { recommendation_signature: '"1"', extra_data: JSON.stringify({ object_selection: '120000000000005' }) }, check: false })
    expect(res.ok).toBe(true)
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).pathname])).toEqual([['GET', '/v26.0/120000000000005'], ['GET', '/v26.0/120000000000005'], ['POST', `/v26.0/${ACT}/recommendations`]])
    // An ad of another account inside: nothing is sent, the account never named.
    h.calls = []
    h.answers.push(json({ error: { code: 100, message: '(#100) Tried accessing nonexisting field (optimization_goal)' } }, 400), json({ id: '120000000000006', account_id: '5555555555', adset_id: '1', creative: { id: '9' } }))
    const foreign = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'adaccount', edge: 'recommendations', params: { recommendation_signature: '"1"', extra_data: JSON.stringify({ object_selection: '120000000000006' }) }, check: false }).catch((e) => e)
    expect(foreign).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/inside this change/) })
    expect(foreign.message).not.toContain('5555555555')
    expect(h.calls.every((c) => c.init.method === 'GET')).toBe(true)
  })
})

describe('study.create: POST /<business>/ad_studies', () => {
  it('an A/B test, a creative test and a lift study as Meta documents them', () => {
    expect(create(AB)).toBeNull()
    expect(verdict({ url: `${BASE}/${BUSINESS}/ad_studies`, objectKind: 'business', body: studyBody(AB) })).toMatchObject({ write: { rule: 'study.create', objectId: BUSINESS, ids: [{ id: AD_SET, kind: 'adset' }, { id: '120000000000004', kind: 'adset' }] } })
    const v2 = { name: 'Creative', type: 'SPLIT_TEST_V2', start_time: String(T0), cooldown_start_time: String(T0), end_time: String(T0 + 86400), observation_end_time: String(T0 + 86400), creative_test_config: { daily_budget: 15000 }, cells: [{ name: 'a', treatment_percentage: 50, ads: [AD] }, { name: 'b', treatment_percentage: 50, ads: ['120000000000005'] }] }
    expect(create(v2)).toBeNull()
    const lift = { name: 'Lift', type: 'LIFT', start_time: String(T0), end_time: String(T0 + 86400), observation_end_time: String(T0 + 2 * 86400), cells: [{ name: 'test', treatment_percentage: 90, control_percentage: 10, adaccounts: ['1234567890'] }], objectives: [{ name: 'Purchases', is_primary: true, type: 'CONVERSIONS', adspixels: [{ id: PIXEL, event_names: ['fb_pixel_purchase'] }] }] }
    expect(create(lift)).toBeNull()
    expect(verdict({ url: `${BASE}/${BUSINESS}/ad_studies`, objectKind: 'business', body: studyBody(lift) })).toMatchObject({ write: { ids: [{ id: '1234567890', kind: 'adaccount' }, { id: PIXEL, kind: 'pixel' }] } })
    // A cell's name may be any script (the name key's own text rule), but no control character.
    expect(create({ ...AB, cells: [{ name: 'Città 🏍️', treatment_percentage: 50, adsets: [AD_SET] }, { name: 'B', treatment_percentage: 50, adsets: ['120000000000004'] }] })).toBeNull()
    expect(create({ ...AB, cells: [{ name: 'A‮B', treatment_percentage: 50, adsets: [AD_SET] }, { name: 'B', treatment_percentage: 50, adsets: ['120000000000004'] }] })).toMatch(/printable text|control or format/)
  })
  it('refuses what Meta does not take, or Nexus never sends', () => {
    expect(create({ ...AB, cells: [{ name: 'A', treatment_percentage: 5, adsets: [AD_SET] }, { name: 'B', treatment_percentage: 50, adsets: ['120000000000004'] }] })).toMatch(/at least 10/)
    expect(create({ ...AB, cells: [{ name: 'A', treatment_percentage: 60, adsets: [AD_SET] }, { name: 'B', treatment_percentage: 50, adsets: ['120000000000004'] }] })).toMatch(/at most 100/)
    expect(create({ ...AB, cells: [{ name: 'A', treatment_percentage: 50, adsets: [AD_SET] }, { name: 'B', treatment_percentage: 50, campaigns: [CAMPAIGN] }] })).toMatch(/one level/)
    expect(create({ ...AB, cells: [{ name: 'A', treatment_percentage: 50, adsets: [AD_SET] }, { name: 'B', treatment_percentage: 50, adsets: [AD_SET] }] })).toMatch(/one cell only/)
    expect(create({ ...AB, cells: [{ name: 'A', treatment_percentage: 50, adsets: [AD_SET], campaigns: [CAMPAIGN] }, { name: 'B', treatment_percentage: 50, adsets: ['120000000000004'] }] })).toMatch(/exactly one kind/)
    expect(create({ ...AB, cells: [{ id: '1', name: 'A', treatment_percentage: 50, adsets: [AD_SET] }, { name: 'B', treatment_percentage: 50, adsets: ['120000000000004'] }] })).toMatch(/no id/)
    expect(create({ ...AB, type: 'GEO_LIFT' })).toMatch(/type/)
    expect(create({ ...AB, viewers: ['1'] })).toMatch(/only Meta change/)
    expect(create({ ...AB, end_time: String(T0) })).toMatch(/end_time is after start_time/)
    expect(create({ ...AB, observation_end_time: String(T0 + 20 * 86400) })).toMatch(/no cooldown or observation/)
    expect(create({ ...AB, objectives: [{ name: 'P', is_primary: true, type: 'CONVERSIONS', adspixels: [{ id: PIXEL, event_names: ['fb_pixel_purchase'] }] }] })).toMatch(/lift study's/)
    expect(create({ ...AB, creative_test_config: { daily_budget: 1 } })).toMatch(/creative test's only/)
    const v2 = { name: 'C', type: 'SPLIT_TEST_V2', start_time: String(T0), cooldown_start_time: String(T0), end_time: String(T0 + 86400), observation_end_time: String(T0 + 86400), creative_test_config: { daily_budget: 15000 }, cells: [{ name: 'a', treatment_percentage: 50, ads: [AD] }, { name: 'b', treatment_percentage: 50, ads: ['120000000000005'] }] }
    expect(create({ ...v2, observation_end_time: String(T0 + 2 * 86400) })).toMatch(/observation_end_time = end_time/)
    expect(create({ ...v2, cells: [{ name: 'a', treatment_percentage: 50.5, ads: [AD] }, { name: 'b', treatment_percentage: 49.5, ads: ['120000000000005'] }] })).toMatch(/whole number/)
    expect(create({ ...v2, cells: [{ name: 'a', treatment_percentage: 50, ads: [AD, '120000000000007'] }, { name: 'b', treatment_percentage: 50, ads: ['120000000000005'] }] })).toMatch(/exactly one id/)
    expect(create({ ...v2, cells: [{ name: 'a', treatment_percentage: 40, ads: [AD] }, { name: 'b', treatment_percentage: 50, ads: ['120000000000005'] }] })).toMatch(/sum to exactly 100/)
    expect(create({ ...v2, creative_test_config: { daily_budget: 15000, lifetime_budget_percentage: 5 } })).toMatch(/exactly/)
    const lift = { name: 'Lift', type: 'LIFT', start_time: String(T0), end_time: String(T0 + 86400), cells: [{ name: 'test', treatment_percentage: 90, control_percentage: 10, campaigns: [CAMPAIGN] }] }
    expect(create(lift)).toMatch(/at least one objective/)
    expect(create({ ...lift, cooldown_start_time: String(T0), objectives: [{ name: 'P', is_primary: true, type: 'CONVERSIONS', adspixels: [{ id: PIXEL, event_names: ['fb_pixel_purchase'] }] }] })).toMatch(/deprecated/)
    expect(create({ ...lift, objectives: [{ name: 'P', is_primary: false, type: 'CONVERSIONS', adspixels: [{ id: PIXEL, event_names: ['fb_pixel_purchase'] }] }] })).toMatch(/exactly one objective is the primary/)
    expect(create({ ...lift, objectives: [{ name: 'P', is_primary: true, type: 'CONVERSIONS', applications: [{ id: '1' }] }] })).toMatch(/and only adspixels, customconversions/)
    expect(create({ ...lift, objectives: [{ name: 'P', is_primary: true, type: 'CONVERSIONS', adspixels: [{ id: PIXEL, event_names: ['fb_mobile_purchase'] }] }] })).toMatch(/event_names lists/)
    // Review B3 — a lift cell has a holdout above 0; one cell's share and holdout make 100; a pixel names its events.
    const objective = [{ name: 'P', is_primary: true, type: 'CONVERSIONS', adspixels: [{ id: PIXEL, event_names: ['fb_pixel_purchase'] }] }]
    expect(create({ ...lift, cells: [{ name: 'test', treatment_percentage: 90, campaigns: [CAMPAIGN] }], objectives: objective })).toMatch(/has a holdout/)
    expect(create({ ...lift, cells: [{ name: 'test', treatment_percentage: 80, control_percentage: 10, campaigns: [CAMPAIGN] }], objectives: objective })).toMatch(/treatment_percentage \+ control_percentage = 100/)
    expect(create({ ...lift, objectives: [{ name: 'P', is_primary: true, type: 'CONVERSIONS', adspixels: [{ id: PIXEL }] }] })).toMatch(/exactly \{id, event_names\}/)
    expect(create({ ...lift, cells: [{ name: 'test', treatment_percentage: 90, control_percentage: 20, campaigns: [CAMPAIGN] }], objectives: [{ name: 'P', is_primary: true, type: 'CONVERSIONS', adspixels: [{ id: PIXEL, event_names: ['fb_pixel_purchase'] }] }] })).toMatch(/at most 100/)
  })
  it('through the gateway: only on the chosen ad account\'s own portfolio', async () => {
    h.answers.push(json({ id: ACT, business: { id: '120000000000099' } }))
    const other = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: BUSINESS, objectKind: 'business', edge: 'ad_studies', params: Object.fromEntries(new URLSearchParams(studyBody(AB))), check: false }).catch((e) => e)
    expect(other).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/is not the business portfolio/) })
    expect(new URL(h.calls[0].url).searchParams.get('fields')).toBe('business{id}')
    h.calls = []
    h.answers.push(json({ id: ACT, business: { id: BUSINESS } }), json({ id: STUDY }))
    const res = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: BUSINESS, objectKind: 'business', edge: 'ad_studies', params: Object.fromEntries(new URLSearchParams(studyBody(AB))), check: false })
    expect(res.ok).toBe(true)
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).pathname])).toEqual([['GET', `/v26.0/${ACT}`], ['POST', `/v26.0/${BUSINESS}/ad_studies`]])
  })
})

describe('study.update: POST /<study>', () => {
  it('names, times, cells (existing by id, new ones), objectives and viewers', () => {
    expect(update({ name: 'New name', end_time: String(T0 + 86400) })).toBeNull()
    expect(update({ cells: [{ id: '120000000000061', treatment_percentage: 40 }, { id: '120000000000062', treatment_percentage: 40 }, { name: 'C', treatment_percentage: 20, adsets: ['120000000000004'] }] })).toBeNull()
    expect(update({ cells: [{ id: '120000000000061', adsets: [AD_SET, '120000000000004'] }, { id: '120000000000062' }] })).toBeNull()
    expect(update({ viewers: ['100000000000001', '100000000000002'] })).toBeNull()
    expect(verdict({ url: `${BASE}/${STUDY}`, objectKind: 'adstudy', body: studyBody({ viewers: ['100000000000001'] }) })).toMatchObject({ write: { rule: 'study.update', ids: [{ id: '100000000000001', kind: 'person' }] } })
    expect(update({ viewers: [] })).toBeNull()
  })
  it('refuses the rest; a study body named a campaign goes nowhere, a status named a study neither', () => {
    expect(update({})).toBeTruthy()
    expect(update({ type: 'LIFT' })).toMatch(/only Meta change/)
    // Review A5 — a creative test's budget is set at its creation only.
    expect(update({ creative_test_config: { daily_budget: 100 } })).toMatch(/only Meta change/)
    expect(update({ cells: [{ id: '1', treatment_percentage: 60 }, { id: '2', treatment_percentage: 60 }] })).toMatch(/at most 100/)
    expect(update({ end_time: String(T0 + 86400), observation_end_time: String(T0) })).toMatch(/at or after end_time/)
    expect(update({ viewers: ['1', '1'] })).toMatch(/each once/)
    expect(problem({ url: `${BASE}/${STUDY}`, objectKind: 'campaign', body: studyBody({ end_time: String(T0) }) })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/${STUDY}`, objectKind: 'adstudy', body: 'status=PAUSED' })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/${STUDY}`, objectKind: 'adstudy', method: 'DELETE' })).toMatch(/deletes on Meta only/)
  })
  it('through the gateway: the study touches the chosen account and is its portfolio\'s; a new viewer has a role on the account', async () => {
    const reads = () => [json({ id: ACT, business: { id: BUSINESS } }), json({ id: STUDY, type: 'SPLIT_TEST', business: { id: BUSINESS } })]
    h.answers.push(...reads(), json({ data: [{ id: '120000000000049' }] }))
    const notTouching = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: STUDY, objectKind: 'adstudy', params: { name: 'B' }, check: false }).catch((e) => e)
    expect(notTouching).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/does not touch/) })
    expect(new URL(h.calls[2].url).pathname).toBe(`/v26.0/${ACT}/impacting_ad_studies`)
    h.calls = []
    h.answers.push(json({ id: ACT, business: { id: BUSINESS } }), json({ id: STUDY, type: 'SPLIT_TEST', business: { id: '120000000000099' } }))
    const otherOwner = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: STUDY, objectKind: 'adstudy', params: { name: 'B' }, check: false }).catch((e) => e)
    expect(otherOwner).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/not owned by the business portfolio/) })
    // Paged: the study is on the second page of the account's list.
    h.calls = []
    h.answers.push(...reads(), json({ data: [{ id: '1' }], paging: { cursors: { after: 'c2' }, next: 'https://graph.facebook.com/next' } }), json({ data: [{ id: STUDY }] }), json({ success: true }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: STUDY, objectKind: 'adstudy', params: { name: 'B' }, check: false })).ok).toBe(true)
    expect(new URL(h.calls[3].url).searchParams.get('after')).toBe('c2')
    expect(h.calls.at(-1)!.init.method).toBe('POST')
    // A viewer: kept when already one, else one of the account's assigned users.
    h.calls = []
    h.answers.push(...reads(), json({ data: [{ id: STUDY }] }), json({ data: [{ id: '100000000000001' }] }), json({ id: ACT, business: { id: BUSINESS } }), json({ data: [{ id: '100000000000003' }] }))
    const stranger = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: STUDY, objectKind: 'adstudy', params: { viewers: '["100000000000001","100000000000002"]' }, check: false }).catch((e) => e)
    expect(stranger).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/person 100000000000002 has no role/) })
    expect(h.calls.map((c) => new URL(c.url).pathname)).toContain(`/v26.0/${ACT}/assigned_users`)
    expect(new URL(h.calls.find((c) => c.url.includes('assigned_users'))!.url).searchParams.get('business')).toBe(BUSINESS)
    // A cell named by id: one of THIS study's cells only.
    h.calls = []
    h.answers.push(...reads(), json({ data: [{ id: STUDY }] }), json({ data: [{ id: '120000000000061' }] }))
    const foreignCell = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: STUDY, objectKind: 'adstudy', params: { cells: '[{"id":"120000000000069","treatment_percentage":50}]' }, check: false }).catch((e) => e)
    expect(foreignCell).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/cell 120000000000069 is not one of this study's cells/) })
    expect(new URL(h.calls.at(-1)!.url).pathname).toBe(`/v26.0/${STUDY}/cells`)
    expect(h.calls.every((c) => c.init.method === 'GET')).toBe(true)
  })
})

describe('Page video tests', () => {
  const video = { name: 'Reels test', description: 'Two cuts', optimization_goal: 'REELS_PLAYS', control_video_id: '120000000000071', experiment_video_ids: '["120000000000071","120000000000072"]' }
  it('the create takes the guide\'s keys; 2–4 videos, the control among them', () => {
    expect(problem({ url: `${BASE}/${PAGE}/ab_tests`, objectKind: 'page', body: form(video) })).toBeNull()
    expect(problem({ url: `${BASE}/${PAGE}/ab_tests`, objectKind: 'page', body: form({ ...video, duration: '600' }) })).toMatch(/duration/)
    expect(problem({ url: `${BASE}/${PAGE}/ab_tests`, objectKind: 'page', body: form({ ...video, control_video_id: '120000000000073' }) })).toMatch(/control video is one of/)
    expect(problem({ url: `${BASE}/${PAGE}/ab_tests`, objectKind: 'page', body: form({ ...video, optimization_goal: 'SALES' }) })).toMatch(/optimization_goal/)
    expect(problem({ url: `${BASE}/${PAGE}/ab_tests`, objectKind: 'page', body: form({ ...video, experiment_video_ids: '["120000000000071"]' }) })).toMatch(/2 to 4/)
  })
  it('through the gateway: the chosen Page only, each video posted by it; a delete only of the Page\'s own test', async () => {
    const other = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: '120000000000011', objectKind: 'page', edge: 'ab_tests', params: video, check: false }).catch((e) => e)
    expect(other).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    // Gap 46b (the live read of 2026-10-26) — a Page video's owner read (id,from{id}) goes with the chosen Page's own token.
    const pageToken = () => json({ id: PAGE, access_token: 'EAAPageTokenForGap46bOptimizeTests1234' })
    gatewayMetaPage['m-1'] = PAGE
    h.answers.push(pageToken(), json({ id: '120000000000071', from: { id: PAGE } }), pageToken(), json({ id: '120000000000072', from: { id: '120000000000011' } }))
    const foreignVideo = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: PAGE, objectKind: 'page', edge: 'ab_tests', params: video, check: false }).catch((e) => e)
    expect(foreignVideo).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/video 120000000000072/) })
    h.page = null
    const noPage = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: PAGE, objectKind: 'page', edge: 'ab_tests', params: video, check: false }).catch((e) => e)
    expect(noPage).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/no Facebook Page/) })
    h.page = PAGE
    h.calls = []
    h.answers.push(json({ id: '120000000000081', control_video_id: '120000000000071', optimization_goal: 'REELS_PLAYS' }), pageToken(), json({ id: '120000000000071', from: { id: PAGE } }), json({ success: true }))
    const del = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: '120000000000081', objectKind: 'pagevideotest', params: {}, check: false, method: 'DELETE' })
    expect(del.ok).toBe(true)
    expect(h.calls.map((c) => c.init.method)).toEqual(['GET', 'GET', 'GET', 'DELETE'])
    expect(new URL(h.calls[2].url).searchParams.get('access_token')).toBe('EAAPageTokenForGap46bOptimizeTests1234')
  })
})
