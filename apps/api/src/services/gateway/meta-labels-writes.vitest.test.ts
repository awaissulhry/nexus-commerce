/**
 * Meta step 21 on the gateway: set-meta-labels, set-meta-value-rules and create-meta-reach-frequency reach Meta only on their
 * EXACT allow-list entries — every key judged, JSON in one spelling, text only where a person types it — and every label,
 * value rule set, prediction, ad set or destination they name is confirmed to be the chosen ad account's own (or its chosen
 * Page / Instagram account) before anything is sent. Made-up ids only.
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

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gatewayLedger, gatewayMetaChosen, gatewayMetaInstagram, gatewayMetaPage, gatewayMetaStored } from '../../test-support/gateway-stubs.js'
import { __rateTest } from './rate.js'
import { metaWriteCall } from './meta.js'
import { metaWriteVerdict } from './meta-calls.js'
import { __metaObjectLimitsTest } from './meta-object-limits.js'
import { valueRulesProblem } from './meta-labels-rules.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../meta/api-version.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const ACT = 'act_1234567890'
const CAMPAIGN = '120000000000001'
const ADSET = '120000000000002'
const LABEL = '120000000000070'
const SET = '120000000000080'
const PREDICTION = '120000000000090'
const PAGE = '120000000000085'
const IG = '120000000000086'
const verdict = (input: { body?: unknown; objectKind?: string; url: string; method?: string; kind?: string }) =>
  metaWriteVerdict({ method: input.method ?? 'POST', url: input.url, kind: input.kind ?? 'write', body: input.body, objectKind: input.objectKind })
const problem = (input: Parameters<typeof verdict>[0]) => { const v = verdict(input); return 'problem' in v ? v.problem : null }
const form = (o: Record<string, string>) => new URLSearchParams(o).toString()
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status })

const RULES = JSON.stringify([{ name: 'Young men', adjust_sign: 'INCREASE', adjust_value: 20, criterias: [{ criteria_type: 'AGE', operator: 'CONTAINS', criteria_values: ['18-24'], criteria_value_types: ['NONE'] }, { criteria_type: 'GENDER', operator: 'CONTAINS', criteria_values: ['MALE'], criteria_value_types: ['NONE'] }] }])
const TARGET = JSON.stringify({ geo_locations: { countries: ['IT'] }, age_min: 18, publisher_platforms: ['facebook', 'instagram'] })
/** 2099-01-01 → 2099-01-20 (UTC Unix seconds). */
const PREDICT = { prediction_mode: '1', start_time: '4070908800', stop_time: '4072550400', target_spec: TARGET, budget: '500000', frequency_cap: '3', destination_ids: JSON.stringify([PAGE, IG]) }

beforeEach(() => {
  __rateTest.useMemory()
  __metaObjectLimitsTest.useMemory()
  h.calls = []; h.answers = []; gatewayLedger.length = 0
  for (const store of [gatewayMetaChosen, gatewayMetaStored, gatewayMetaPage, gatewayMetaInstagram] as Array<Record<string, unknown>>) for (const key of Object.keys(store)) delete store[key]
  vi.stubEnv('NEXUS_META_ADS_WRITES', 'on')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response(JSON.stringify({ success: true }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset(); __metaObjectLimitsTest.reset() })

describe('labels: exactly as Meta documents them', () => {
  it('make one on the chosen ad account; rename one by its own id; delete one with no body', () => {
    expect(verdict({ url: `${BASE}/${ACT}/adlabels`, objectKind: 'adaccount', body: 'name=Spring' })).toMatchObject({ write: { rule: 'adlabel.create', objectId: ACT, kinds: ['adaccount'] } })
    expect(problem({ url: `${BASE}/${ACT}/adlabels`, objectKind: 'adaccount', body: 'name=Spring&color=red' })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/${ACT}/adlabels`, objectKind: 'adaccount', body: `name=${encodeURIComponent('a‮b')}` })).toMatch(/printable text/)
    expect(problem({ url: `${BASE}/${ACT}/adlabels`, objectKind: 'adaccount', body: `name=${'x'.repeat(101)}` })).toMatch(/1 to 100 characters/)
    expect(verdict({ url: `${BASE}/${LABEL}`, objectKind: 'adlabel', body: 'name=Summer' })).toMatchObject({ write: { rule: 'adlabel.rename', objectId: LABEL } })
    expect(problem({ url: `${BASE}/${LABEL}`, objectKind: 'adlabel', body: 'name=Summer&status=PAUSED' })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/${LABEL}`, objectKind: 'adlabel', body: form({ adlabels: JSON.stringify([{ id: LABEL }]) }) })).toMatch(/only Meta change/)
    expect(verdict({ url: `${BASE}/${LABEL}`, objectKind: 'adlabel', method: 'DELETE' })).toMatchObject({ write: { rule: 'adlabel.delete', method: 'DELETE', body: '' } })
    expect(problem({ url: `${BASE}/${LABEL}`, objectKind: 'adlabel', method: 'DELETE', body: 'x=1' })).toMatch(/deletes on Meta only/)
  })
  it('a campaign\'s add edge and a campaign\'s or ad set\'s whole list: entries by id or name, each once, ≤ 50, one spelling', () => {
    const added = JSON.stringify([{ id: LABEL }, { name: 'New label' }])
    expect(verdict({ url: `${BASE}/${CAMPAIGN}/adlabels`, objectKind: 'campaign', body: form({ adlabels: added }) })).toMatchObject({ write: { rule: 'campaign.adlabels.add', ids: [{ id: LABEL, kind: 'adlabel' }] } })
    // No labels edge for an ad set (RECHECK AS-085): only its whole list on POST /<ad set>.
    expect(problem({ url: `${BASE}/${ADSET}/adlabels`, objectKind: 'adset', body: form({ adlabels: added }) })).toMatch(/only Meta change/)
    expect(verdict({ url: `${BASE}/${ADSET}`, objectKind: 'adset', body: form({ adlabels: '[]' }) })).toMatchObject({ write: { rule: 'object.adlabels' } })
    expect(verdict({ url: `${BASE}/${CAMPAIGN}`, objectKind: 'campaign', body: form({ adlabels: JSON.stringify([{ id: LABEL }]) }) })).toMatchObject({ write: { rule: 'object.adlabels', ids: [{ id: LABEL, kind: 'adlabel' }] } })
    expect(problem({ url: `${BASE}/${CAMPAIGN}/adlabels`, objectKind: 'campaign', body: form({ adlabels: '[]' }) })).toMatch(/1 to 50 labels/)
    expect(problem({ url: `${BASE}/${ADSET}`, objectKind: 'adset', body: form({ adlabels: '[{"id": "1"}]' }) })).toMatch(/one spelling/)
    expect(problem({ url: `${BASE}/${ADSET}`, objectKind: 'adset', body: form({ adlabels: JSON.stringify([{ id: LABEL }, { id: LABEL }]) }) })).toMatch(/each label once/)
    expect(problem({ url: `${BASE}/${ADSET}`, objectKind: 'adset', body: form({ adlabels: JSON.stringify([{ id: LABEL, name: 'x' }]) }) })).toMatch(/each label is/)
    expect(problem({ url: `${BASE}/${ADSET}`, objectKind: 'adset', body: form({ adlabels: JSON.stringify([{ id: 'act_1' }]) }) })).toMatch(/each label is/)
    expect(problem({ url: `${BASE}/${ADSET}`, objectKind: 'adset', body: form({ adlabels: JSON.stringify(Array.from({ length: 51 }, (_, i) => ({ id: String(1000 + i) }))) }) })).toMatch(/1 to 50|0 to 50/)
    expect(problem({ url: `${BASE}/${ADSET}`, objectKind: 'adset', body: form({ adlabels: JSON.stringify([{ id: LABEL }]), name: 'x' }) })).toMatch(/is not a key|only Meta change/)
  })
})

describe('value rules: exactly as Meta documents them', () => {
  it('a set made on the chosen account, changed by its own id, deleted with an EMPTY POST', () => {
    expect(verdict({ url: `${BASE}/${ACT}/value_rule_set`, objectKind: 'adaccount', body: form({ name: 'Set A', rules: RULES }) })).toMatchObject({ write: { rule: 'valueruleset.create' } })
    expect(verdict({ url: `${BASE}/${ACT}/value_rule_set`, objectKind: 'adaccount', body: form({ name: 'Set A', rules: RULES, product_type: 'AUDIENCE' }) })).toMatchObject({ write: { rule: 'valueruleset.create' } })
    expect(problem({ url: `${BASE}/${ACT}/value_rule_set`, objectKind: 'adaccount', body: form({ name: 'Set A', rules: RULES, entry_point: 'L2_GLOBAL' }) })).toMatch(/only Meta change/)
    expect(verdict({ url: `${BASE}/${SET}`, objectKind: 'valueruleset', body: form({ name: 'Set A', rules: RULES }) })).toMatchObject({ write: { rule: 'valueruleset.update', objectId: SET } })
    expect(verdict({ url: `${BASE}/${SET}/delete_rule_set`, objectKind: 'valueruleset' })).toMatchObject({ write: { rule: 'valueruleset.delete', body: '', objectId: SET } })
    expect(problem({ url: `${BASE}/${SET}/delete_rule_set`, objectKind: 'valueruleset', body: 'status=DELETED' })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/${SET}/delete_rule_set`, objectKind: 'valueruleset', kind: 'read' })).toMatch(/goes as a write/)
    // A bare POST only where a rule names no key for that kind: anything else still needs its body.
    expect(problem({ url: `${BASE}/${CAMPAIGN}`, objectKind: 'campaign' })).toMatch(/form body/)
    expect(problem({ url: `${BASE}/${CAMPAIGN}/delete_rule_set`, objectKind: 'campaign' })).toMatch(/form body/)
  })
  it('every rule judged: signs, ranges, criteria types and values, ids only on an update', () => {
    const rule = (over: Record<string, unknown>, criteria?: unknown[]) => JSON.stringify([{ name: 'R', adjust_sign: 'INCREASE', adjust_value: 20, criterias: criteria ?? [{ criteria_type: 'AGE', operator: 'CONTAINS', criteria_values: ['18-24'], criteria_value_types: ['NONE'] }], ...over }])
    expect(valueRulesProblem(RULES, false)).toBeNull()
    expect(valueRulesProblem(rule({ adjust_value: 1001 }), false)).toMatch(/1 to 1000/)
    expect(valueRulesProblem(rule({ adjust_sign: 'DECREASE', adjust_value: 91 }), false)).toMatch(/1 to 90/)
    expect(valueRulesProblem(rule({ id: '1' }), false)).toMatch(/exactly name/)
    expect(valueRulesProblem(rule({ id: '1', status: 'ACTIVE' }), true)).toBeNull()
    expect(valueRulesProblem(rule({ status: 'ACTIVE' }), true)).toMatch(/only with its id/)
    expect(valueRulesProblem(rule({}, [{ criteria_type: 'AGE', operator: 'CONTAINS', criteria_values: ['18-65'], criteria_value_types: ['NONE'] }]), false)).toMatch(/under 65/)
    expect(valueRulesProblem(rule({}, [{ criteria_type: 'AGE', operator: 'CONTAINS', criteria_values: ['45+'], criteria_value_types: ['NONE'] }]), false)).toBeNull()
    expect(valueRulesProblem(rule({}, [{ criteria_type: 'LOCATION', operator: 'CONTAINS', criteria_values: ['IT', '527'], criteria_value_types: ['LOCATION_COUNTRY', 'LOCATION_REGION'] }]), false)).toBeNull()
    expect(valueRulesProblem(rule({}, [{ criteria_type: 'LOCATION', operator: 'CONTAINS', criteria_values: ['501'], criteria_value_types: ['LOCATION_DMA'] }]), false)).toMatch(/never LOCATION_DMA/)
    expect(valueRulesProblem(rule({}, [{ criteria_type: 'PLACEMENT', operator: 'CONTAINS', criteria_values: ['IG_REELS'], criteria_value_types: ['NONE'] }, { criteria_type: 'PLACEMENT', operator: 'CONTAINS', criteria_values: ['FB_FEED'], criteria_value_types: ['NONE'] }]), false)).toMatch(/same type/)
    expect(valueRulesProblem(rule({}, [{ criteria_type: 'GENDER', operator: 'EQUAL', criteria_values: ['MALE'], criteria_value_types: ['NONE'] }]), false)).toMatch(/CONTAINS/)
    expect(valueRulesProblem(rule({}, [{ criteria_type: 'GENDER', operator: 'CONTAINS', criteria_values: ['male'], criteria_value_types: ['NONE'] }]), false)).toMatch(/MALE or FEMALE/)
    expect(valueRulesProblem(rule({}, [{ criteria_type: 'GENDER', operator: 'CONTAINS', criteria_values: ['MALE'], criteria_value_types: ['NONE'], extra: 1 }]), false)).toMatch(/exactly criteria_type/)
    expect(valueRulesProblem(JSON.stringify(Array.from({ length: 11 }, () => JSON.parse(RULES)[0])), false)).toMatch(/1 to 10 rules/)
    expect(valueRulesProblem('[ ]', false)).toMatch(/one spelling/)
    expect(valueRulesProblem(rule({ name: 'a‮b' }), false)).toMatch(/printable text/)
  })
  it('attach: the set + value_rules_applied=true (+ bid_adjustments {} only); detach: ONLY value_rules_applied=false', () => {
    expect(verdict({ url: `${BASE}/${ADSET}`, objectKind: 'adset', body: form({ value_rule_set_id: SET, value_rules_applied: 'true' }) })).toMatchObject({ write: { rule: 'adset.valueRules.attach', ids: [{ id: SET, kind: 'valueruleset' }] } })
    expect(verdict({ url: `${BASE}/${ADSET}`, objectKind: 'adset', body: form({ value_rule_set_id: SET, value_rules_applied: 'true', bid_adjustments: '{}' }) })).toMatchObject({ write: { rule: 'adset.valueRules.attach' } })
    expect(problem({ url: `${BASE}/${ADSET}`, objectKind: 'adset', body: form({ value_rule_set_id: SET, value_rules_applied: 'true', bid_adjustments: '{"age":{"18-24":0.5}}' }) })).toMatch(/only \{\}/)
    // A valid id with false attaches it all the same (RECHECK AS-097): never sent.
    expect(problem({ url: `${BASE}/${ADSET}`, objectKind: 'adset', body: form({ value_rule_set_id: SET, value_rules_applied: 'false' }) })).toMatch(/attaches it all the same/)
    expect(verdict({ url: `${BASE}/${ADSET}`, objectKind: 'adset', body: form({ value_rules_applied: 'false' }) })).toMatchObject({ write: { rule: 'adset.valueRules.detach' } })
    expect(problem({ url: `${BASE}/${ADSET}`, objectKind: 'adset', body: form({ value_rules_applied: 'true' }) })).toMatch(/only value_rules_applied=false/)
    expect(problem({ url: `${BASE}/${CAMPAIGN}`, objectKind: 'campaign', body: form({ value_rules_applied: 'false' }) })).toMatch(/only Meta change/)
  })
  it('translate: exactly {"bid_multiplier_ad_set_id": "<ad set>"}, the ad set named for the account check', () => {
    const source = JSON.stringify({ bid_multiplier_ad_set_id: ADSET })
    expect(verdict({ url: `${BASE}/${ACT}/value_rule_set_translation`, objectKind: 'adaccount', body: form({ source }) })).toMatchObject({ write: { rule: 'valueruleset.translate', ids: [{ id: ADSET, kind: 'adset' }] } })
    expect(problem({ url: `${BASE}/${ACT}/value_rule_set_translation`, objectKind: 'adaccount', body: form({ source: JSON.stringify({ bid_multiplier_parameter_set: { gender: { male: 0.5 } } }) }) })).toMatch(/exactly/)
    expect(problem({ url: `${BASE}/${ACT}/value_rule_set_translation`, objectKind: 'adaccount', body: form({ source: JSON.stringify({ bid_multiplier_ad_set_id: Number(ADSET) }) }) })).toMatch(/exactly/)
  })
})

describe('reach & frequency: a prediction, a booking, a cancel, an ad set\'s reservation', () => {
  it('a prediction: its keys judged, one country, destinations named for the Page / Instagram check', () => {
    expect(verdict({ url: `${BASE}/${ACT}/reachfrequencypredictions`, objectKind: 'adaccount', body: form(PREDICT) })).toMatchObject({ write: { rule: 'rf.predict', ids: [{ id: PAGE, kind: 'destination' }, { id: IG, kind: 'destination' }] } })
    const two = JSON.stringify({ geo_locations: { countries: ['IT', 'DE'] } })
    expect(problem({ url: `${BASE}/${ACT}/reachfrequencypredictions`, objectKind: 'adaccount', body: form({ ...PREDICT, target_spec: two }) })).toMatch(/exactly one country/)
    expect(problem({ url: `${BASE}/${ACT}/reachfrequencypredictions`, objectKind: 'adaccount', body: form({ ...PREDICT, reach: '1000000' }) })).toMatch(/prediction_mode 1 names a budget/)
    expect(problem({ url: `${BASE}/${ACT}/reachfrequencypredictions`, objectKind: 'adaccount', body: form({ ...PREDICT, interval_frequency_cap_reset_period: '36' }) })).toMatch(/multiple of 24/)
    expect(problem({ url: `${BASE}/${ACT}/reachfrequencypredictions`, objectKind: 'adaccount', body: form({ ...PREDICT, stop_time: String(Number(PREDICT.start_time) + 91 * 86_400) }) })).toMatch(/at most 90 days/)
    expect(problem({ url: `${BASE}/${ACT}/reachfrequencypredictions`, objectKind: 'adaccount', body: form({ ...PREDICT, deal_id: '1' }) })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/${ACT}/reachfrequencypredictions`, objectKind: 'adaccount', body: form({ ...PREDICT, instream_packages: '["REGULAR_POLITICS"]' }) })).toMatch(/instream_packages/)
    expect(problem({ url: `${BASE}/${ACT}/reachfrequencypredictions`, objectKind: 'adaccount', body: form({ ...PREDICT, target_spec: JSON.stringify({ geo_locations: { countries: ['IT'] }, custom_audiences: [{ id: '1' }] }) }) })).toMatch(/target_spec has geo_locations and only/)
    expect(verdict({ url: `${BASE}/${ACT}/reachfrequencypredictions`, objectKind: 'adaccount', body: form({ ...PREDICT, campaign_group_id: CAMPAIGN, rf_prediction_id_to_share: PREDICTION }) })).toMatchObject({ write: { ids: expect.arrayContaining([{ id: CAMPAIGN, kind: 'campaign' }, { id: PREDICTION, kind: 'rfprediction' }]) } })
  })
  it('reserve (+ one point of the curve, all three) or cancel (nothing else); the prediction named for the account check', () => {
    expect(verdict({ url: `${BASE}/${ACT}/reachfrequencypredictions`, objectKind: 'adaccount', body: form({ action: 'reserve', rf_prediction_id: PREDICTION }) })).toMatchObject({ write: { rule: 'rf.reservation', ids: [{ id: PREDICTION, kind: 'rfprediction' }] } })
    expect(verdict({ url: `${BASE}/${ACT}/reachfrequencypredictions`, objectKind: 'adaccount', body: form({ action: 'reserve', rf_prediction_id: PREDICTION, reach: '1000000', budget: '500000', impression: '3000000' }) })).toMatchObject({ write: { rule: 'rf.reservation' } })
    expect(problem({ url: `${BASE}/${ACT}/reachfrequencypredictions`, objectKind: 'adaccount', body: form({ action: 'reserve', rf_prediction_id: PREDICTION, reach: '1000000' }) })).toMatch(/together/)
    expect(verdict({ url: `${BASE}/${ACT}/reachfrequencypredictions`, objectKind: 'adaccount', body: form({ action: 'cancel', rf_prediction_id: PREDICTION }) })).toMatchObject({ write: { rule: 'rf.reservation' } })
    expect(problem({ url: `${BASE}/${ACT}/reachfrequencypredictions`, objectKind: 'adaccount', body: form({ action: 'cancel', rf_prediction_id: PREDICTION, budget: '1' }) })).toMatch(/a cancel names only/)
    expect(problem({ url: `${BASE}/${ACT}/reachfrequencypredictions`, objectKind: 'adaccount', body: form({ action: 'quote', rf_prediction_id: PREDICTION }) })).toMatch(/reserve or cancel/)
  })
  it('an ad set takes a reservation (rf_prediction_id) or lets it go (0)', () => {
    expect(verdict({ url: `${BASE}/${ADSET}`, objectKind: 'adset', body: form({ rf_prediction_id: PREDICTION }) })).toMatchObject({ write: { rule: 'adset.rfPrediction', ids: [{ id: PREDICTION, kind: 'rfprediction' }] } })
    expect(verdict({ url: `${BASE}/${ADSET}`, objectKind: 'adset', body: form({ rf_prediction_id: '0' }) })).toMatchObject({ write: { rule: 'adset.rfPrediction' } })
    expect((verdict({ url: `${BASE}/${ADSET}`, objectKind: 'adset', body: form({ rf_prediction_id: '0' }) }) as { write: { ids?: unknown } }).write.ids).toBeUndefined()
    expect(problem({ url: `${BASE}/${ADSET}`, objectKind: 'adset', body: form({ rf_prediction_id: 'null' }) })).toMatch(/or 0/)
    expect(problem({ url: `${BASE}/${CAMPAIGN}`, objectKind: 'campaign', body: form({ rf_prediction_id: PREDICTION }) })).toMatch(/only Meta change/)
  })
})

describe('the chosen account\'s own, before anything is sent', () => {
  it('a label renamed or deleted only when the chosen account\'s own list holds it (paged by cursor)', async () => {
    h.answers.push(json({ data: [{ id: '120000000000071' }], paging: { cursors: { after: 'C1' }, next: 'x' } }))
    h.answers.push(json({ data: [{ id: '120000000000072' }] }))
    const foreign = await metaWriteCall({ connectionId: 'm-1', operation: 'label.rename', objectId: LABEL, objectKind: 'adlabel', params: { name: 'Summer' }, check: false }).catch((e) => e)
    expect(foreign).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/label 120000000000070 is not one of the chosen ad account's own/) })
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).pathname, new URL(c.url).searchParams.get('after')])).toEqual([['GET', `/v26.0/${ACT}/adlabels`, null], ['GET', `/v26.0/${ACT}/adlabels`, 'C1']])
    h.calls = []
    h.answers.push(json({ data: [{ id: LABEL }] }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'label.delete', objectId: LABEL, objectKind: 'adlabel', params: {}, check: false, method: 'DELETE' })).ok).toBe(true)
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).pathname])).toEqual([['GET', `/v26.0/${ACT}/adlabels`], ['DELETE', `/v26.0/${LABEL}`]])
  })
  it('labels inside a body: every id on the chosen account\'s list, the list read once', async () => {
    h.answers.push(json({ data: [{ id: LABEL }, { id: '120000000000071' }] }))
    gatewayMetaStored[ADSET] = { adAccountId: '1234567890', kind: 'adset' }
    const ok = await metaWriteCall({ connectionId: 'm-1', operation: 'adset.labels', objectId: ADSET, objectKind: 'adset', params: { adlabels: JSON.stringify([{ id: LABEL }, { id: '120000000000071' }]) }, check: false })
    expect(ok.ok).toBe(true)
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).pathname])).toEqual([['GET', `/v26.0/${ACT}/adlabels`], ['POST', `/v26.0/${ADSET}`]])
    h.calls = []
    h.answers.push(json({ data: [{ id: LABEL }] }))
    const foreign = await metaWriteCall({ connectionId: 'm-1', operation: 'adset.labels', objectId: ADSET, objectKind: 'adset', params: { adlabels: JSON.stringify([{ id: '5555555555' }]) }, check: false }).catch((e) => e)
    expect(foreign).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/inside this change, label 5555555555/) })
    expect(h.calls.every((c) => c.init.method === 'GET')).toBe(true)
  })
  it('a value rule set changed, deleted or attached only when it is the chosen account\'s; an empty POST for a delete', async () => {
    h.answers.push(json({ data: [{ id: '120000000000081' }] }))
    const foreign = await metaWriteCall({ connectionId: 'm-1', operation: 'valueRuleSet.delete', objectId: SET, objectKind: 'valueruleset', edge: 'delete_rule_set', params: {}, check: false }).catch((e) => e)
    expect(foreign).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/value rule set 120000000000080/) })
    h.calls = []
    h.answers.push(json({ data: [{ id: SET }] }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'valueRuleSet.delete', objectId: SET, objectKind: 'valueruleset', edge: 'delete_rule_set', params: {}, check: false })).ok).toBe(true)
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).pathname, c.init.body])).toEqual([['GET', `/v26.0/${ACT}/value_rule_set`, undefined], ['POST', `/v26.0/${SET}/delete_rule_set`, '']])
    expect(new URL(h.calls[0].url).searchParams.get('fields')).toBe('id')
  })
  it('Meta\'s check is never asked of a label or a value rule set', async () => {
    const err = await metaWriteCall({ connectionId: 'm-1', operation: 'label.rename.check', objectId: LABEL, objectKind: 'adlabel', params: { name: 'x' }, check: true }).catch((e) => e)
    expect(err).toBeTruthy()
    expect(h.calls.filter((c) => c.init.method !== 'GET')).toHaveLength(0)
  })
  it('a prediction\'s destinations: the chosen Page or Instagram account only; its prediction ids the account\'s own', async () => {
    const noPage = await metaWriteCall({ connectionId: 'm-1', operation: 'rf.predict', objectId: ACT, objectKind: 'adaccount', edge: 'reachfrequencypredictions', params: PREDICT, check: false }).catch((e) => e)
    expect(noPage).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/neither the Facebook Page nor the Instagram account/) })
    gatewayMetaPage['m-1'] = PAGE
    gatewayMetaInstagram['m-1'] = IG
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'rf.predict', objectId: ACT, objectKind: 'adaccount', edge: 'reachfrequencypredictions', params: PREDICT, check: false })).ok).toBe(true)
    h.calls = []
    h.answers.push(json({ data: [{ id: '120000000000099' }] }))
    const foreign = await metaWriteCall({ connectionId: 'm-1', operation: 'rf.reserve', objectId: ACT, objectKind: 'adaccount', edge: 'reachfrequencypredictions', params: { action: 'reserve', rf_prediction_id: PREDICTION }, check: false }).catch((e) => e)
    expect(foreign).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/reach and frequency prediction 120000000000090/) })
    expect(new URL(h.calls[0].url).pathname).toBe(`/v26.0/${ACT}/reachfrequencypredictions`)
    const otherAccount = await metaWriteCall({ connectionId: 'm-1', operation: 'rf.reserve', objectId: 'act_5555555555', objectKind: 'adaccount', edge: 'reachfrequencypredictions', params: { action: 'reserve', rf_prediction_id: PREDICTION }, check: false }).catch((e) => e)
    expect(otherAccount).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
  })
})

const HERE = fileURLToPath(new URL('.', import.meta.url))

describe('the destructive POST of step 21 (a value rule set\'s delete_rule_set) is built only in change-value-rules.ts, once', () => {
  it('pinned', () => {
    const SRC = join(HERE, '../..')
    const files = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) { if (entry.name !== 'node_modules') files(path, out) } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.') && !entry.name.endsWith('.d.ts')) out.push(path)
      }
      return out
    }
    const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
    const all = files(SRC).map((p) => ({ path: p.slice(SRC.length + 1), text: code(readFileSync(p, 'utf8')) }))
    const naming = Object.fromEntries(all.map((f) => [f.path, (f.text.match(/edge: ['"`]delete_rule_set['"`]/g) ?? []).length]).filter(([, n]) => n))
    expect(naming).toEqual({ 'services/marketing/meta-ads/change-value-rules.ts': 1 })
    // Review A6 — the word itself, anywhere in code: a computed edge would need it spelled somewhere else.
    const word = Object.fromEntries(all.map((f) => [f.path, (f.text.match(/delete_rule_set/g) ?? []).length]).filter(([, n]) => n))
    expect(word).toEqual({
      'services/gateway/meta.ts': 1, // the edge's type (MetaLabelsEdge)
      'services/gateway/meta-labels-rules.ts': 1, // the valueruleset.delete rule's path (a judge)
      'services/marketing/meta-ads/change-value-rules.ts': 1, // the one request
    })
    // And no request builder computes its edge: only the kit passes on a request's own.
    const builders = all.filter((f) => /^services\/(marketing\/meta-ads\/change-[\w-]+|agents\/tools\/meta-ads-[\w-]+(\.tools)?)\.ts$/.test(f.path))
    const computed = builders.flatMap((f) => [...f.text.matchAll(/(?<=[{,]\s*)edge:\s*([^,}\n]+)/g)].map((m) => m[1].trim())
      // Step 40 — the ONE literal edge outside [a-z_]: Meta spells the insights-feature edge with a slash and a hyphen
      // (insights/breakdowns: POST act_<id>/insights/feature-settings). It is this exact literal, never computed.
      .filter((v) => !/^(['"`])[a-z_]+\1( as const)?$/.test(v) && v !== "'insights/feature-settings'").map((v) => `${f.path}: ${v}`))
    // Step 31 — audienceRequest passes on the literal edge its caller names (customaudiences, users, ad_accounts, …).
    // Step 36 — the kit's plan hash names a request's own edge too (planOf: no sender).
    expect(computed).toEqual(['services/agents/tools/meta-ads-kit.ts: r.edge', 'services/agents/tools/meta-ads-kit.ts: request.edge', 'services/marketing/meta-ads/change-audiences.ts: o.edge'])
    const draft = code(readFileSync(join(SRC, 'services/marketing/meta-ads/change-value-rules.ts'), 'utf8'))
    expect(draft.indexOf('request.confirmDelete !== true')).toBeGreaterThan(0)
    expect(draft.indexOf('request.confirmDelete !== true')).toBeLessThan(draft.indexOf("edge: 'delete_rule_set'"))
  })
})
