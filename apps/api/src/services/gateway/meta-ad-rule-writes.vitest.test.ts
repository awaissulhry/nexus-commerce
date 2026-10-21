/**
 * Meta step 29 on the gateway: Meta's automated rules (set-meta-ad-rule, remove-meta-ad-rule) reach Meta only on their
 * EXACT allow-list entries — a create on the chosen account's own rule library with its status always named, an update
 * of a rule with the WHOLE rule, a status change alone, a run and Meta's preview with no body (the preview as a read,
 * under Meta changes' switch, never holding the rule 30 s), a delete — every spec judged as canonical JSON with Meta's
 * keys, operators and value shapes only; the rule of the chosen account (never one of Nexus's stored campaigns, never
 * another account's); every object and label inside it of the chosen account. Steps 17 and 18 stay as they were.
 * Made-up ids only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, answers: [] as Array<() => Response> }))
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
import { metaRulePreviewCall, metaWriteCall } from './meta.js'
import { metaWriteVerdict } from './meta-calls.js'
import { ruleBodyIds, ruleFieldProblem, wholeRuleSpecsProblem } from './meta-ad-rule-rules.js'
import { __metaObjectLimitsTest, metaObjectState } from './meta-object-limits.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../meta/api-version.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const ACT = 'act_1234567890'
const RULE = '120000000000101'
const CAMPAIGN = '120000000000001'
const AD_SET = '120000000000002'
const form = (o: Record<string, string>) => new URLSearchParams(o).toString()
const verdict = (input: { body?: unknown; objectKind?: string; url?: string; method?: string; kind?: string }) =>
  metaWriteVerdict({ method: input.method ?? 'POST', url: input.url ?? `${BASE}/${RULE}`, kind: input.kind ?? 'write', body: input.body, objectKind: input.objectKind })
const problem = (input: Parameters<typeof verdict>[0]) => { const v = verdict(input); return 'problem' in v ? v.problem : null }
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status })

const EVAL = { evaluation_type: 'SCHEDULE', filters: [{ field: 'entity_type', value: 'ADSET', operator: 'EQUAL' }, { field: 'time_preset', value: 'LAST_7D', operator: 'EQUAL' }, { field: 'spent', value: 5000, operator: 'GREATER_THAN' }] }
const PAUSE = { execution_type: 'PAUSE' }
const DAILY = { schedule_type: 'DAILY' }
const createBody = (o: Record<string, unknown> = {}) => form({
  name: 'Rule A', evaluation_spec: JSON.stringify(o.evaluation ?? EVAL), execution_spec: JSON.stringify(o.execution ?? PAUSE),
  ...(o.schedule === null ? {} : { schedule_spec: JSON.stringify(o.schedule ?? DAILY) }), ...(o.status === null ? {} : { status: (o.status as string) ?? 'DISABLED' }),
})
const create = (o: Record<string, unknown> = {}) => problem({ url: `${BASE}/${ACT}/adrules_library`, objectKind: 'adaccount', body: createBody(o) })
const update = (o: Record<string, string>) => problem({ objectKind: 'adrule', body: form(o) })

beforeEach(() => {
  __rateTest.useMemory()
  __metaObjectLimitsTest.useMemory()
  h.calls = []; h.answers = []; gatewayLedger.length = 0
  for (const key of Object.keys(gatewayMetaChosen)) delete gatewayMetaChosen[key]
  for (const key of Object.keys(gatewayMetaStored)) delete gatewayMetaStored[key]
  gatewayMetaStored[CAMPAIGN] = { adAccountId: '1234567890', kind: 'campaign' }
  gatewayMetaStored[AD_SET] = { adAccountId: '1234567890', kind: 'adset' }
  vi.stubEnv('NEXUS_META_ADS_WRITES', 'on')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response(JSON.stringify({ success: true }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset(); __metaObjectLimitsTest.reset() })

describe('the rule entries of the write allow-list', () => {
  it('a create goes to the account\'s rule library as adRule.create, its status ALWAYS named', () => {
    const v = verdict({ url: `${BASE}/${ACT}/adrules_library`, objectKind: 'adaccount', body: createBody() })
    expect(v).toMatchObject({ write: { rule: 'adRule.create', objectId: ACT, check: false, budget: false, kinds: ['adaccount'] } })
    expect(create({ status: null })).toMatch(/only Meta change/)
    expect(create({ status: 'DELETED' })).toMatch(/ENABLED or DISABLED/)
    // Named a rule, a campaign, or nothing: not the rule library.
    expect(problem({ url: `${BASE}/${ACT}/adrules_library`, objectKind: 'adrule', body: createBody() })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/${ACT}/adrules_library`, body: createBody() })).toMatch(/only Meta change/)
    // RU-024 / RU-022 — recommended_rule_key and is_once_off are never sent.
    expect(problem({ url: `${BASE}/${ACT}/adrules_library`, objectKind: 'adaccount', body: `${createBody()}&recommended_rule_key=x` })).toMatch(/only Meta change/)
    expect(create({ execution: { execution_type: 'PAUSE', is_once_off: true } })).toMatch(/no is_once_off/)
    expect(create({ execution: { execution_type: 'UPDATE_CREATIVE' } })).toMatch(/nine Meta documents/)
  })
  it('every spec is canonical JSON with Meta\'s keys at every depth', () => {
    expect(problem({ url: `${BASE}/${ACT}/adrules_library`, objectKind: 'adaccount', body: createBody().replace(encodeURIComponent('"evaluation_type"'), encodeURIComponent(' "evaluation_type"')) })).toMatch(/one spelling only/)
    expect(create({ evaluation: { ...EVAL, extra: 1 } })).toMatch(/evaluation_spec is \{evaluation_type, filters, trigger\}/)
    expect(create({ evaluation: { ...EVAL, filters: [{ field: 'entity_type', value: 'ADSET', operator: 'EQUAL', note: 'x' }] } })).toMatch(/filter 1 is \{field, value, operator\}/)
    expect(create({ execution: { execution_type: 'CHANGE_BUDGET', execution_options: [{ field: 'change_spec', value: { amount: 10, unit: 'PERCENTAGE', extra: 1 }, operator: 'EQUAL' }] } })).toMatch(/change_spec is \{amount/)
    expect(create({ schedule: { schedule_type: 'CUSTOM', schedule: [{ start_minute: 15 }] } })).toMatch(/multiple of 30/)
    expect(create({ schedule: { schedule_type: 'DAILY', schedule: [{ days: [1] }] } })).toMatch(/only a CUSTOM schedule/)
  })
  it('operators, special fields and ids follow Meta\'s tables', () => {
    const withFilter = (f: Record<string, unknown>) => create({ evaluation: { ...EVAL, filters: [{ field: 'entity_type', value: 'ADSET', operator: 'EQUAL' }, f] } })
    expect(withFilter({ field: 'spent', value: '5000', operator: 'GREATER_THAN' })).toMatch(/compares a number/)
    expect(withFilter({ field: 'cpc', value: [5, 1], operator: 'IN_RANGE' })).toMatch(/\[low, high\]/)
    expect(withFilter({ field: 'time_preset', value: 'LAST_9D', operator: 'EQUAL' })).toMatch(/one of Meta's presets/)
    expect(withFilter({ field: 'attribution_window', value: '7D_CLICK', operator: 'EQUAL' })).toMatch(/only EQUAL ACCOUNT_DEFAULT/)
    expect(withFilter({ field: 'adset.id', value: [120000000000002], operator: 'IN' })).toMatch(/as JSON strings/)
    expect(withFilter({ field: 'adset.id', value: [AD_SET], operator: 'IN' })).toBeNull()
    expect(withFilter({ field: 'adlabel_ids', value: ['120000000000301'], operator: 'IN' })).toMatch(/ANY, ALL or NONE/)
    expect(withFilter({ field: 'name', value: 'Saldi città', operator: 'CONTAIN' })).toBeNull()
    expect(withFilter({ field: 'name', value: 'Saldi ‮città', operator: 'CONTAIN' })).toMatch(/printable text/)
    expect(withFilter({ field: 'spent', value: 1, operator: 'LIKE' })).toMatch(/operator is one of/)
    expect(create({ evaluation: { evaluation_type: 'SCHEDULE', filters: [{ field: 'spent', value: 1, operator: 'GREATER_THAN' }] } })).toMatch(/entity_type or an id filter/)
    expect(create({ evaluation: { ...EVAL, filters: [...EVAL.filters, { field: 'time_preset', value: 'TODAY', operator: 'EQUAL' }] } })).toMatch(/at most one time_preset/)
  })
  it('field names: Meta\'s grammar (prefixes, aggregate, formulas of at most 6 fields), nothing else', () => {
    for (const ok of ['spent', 'adset.daily_budget', 'campaign.28d_view_1d_click:lifetime_results', 'yesterday_spent', 'offsite_conversion.fb_pixel_purchase', 'aggregate(lifetime_reach)', 'today_spent / adset.daily_budget', '0.8 * cpc + 0.2 * cpm', '(adset.spent - spent)']) {
      expect(ruleFieldProblem(ok), ok).toBeNull()
    }
    for (const bad of ['Spent', 'lifetime_campaign.spent x', 'ad.adset.spent', 'today_impressions/yesterday_impressions', 'spent; DROP', '(spent', 'a + b + c + d + e + f + g', 'aggregate(adset.reach)', `${'x'.repeat(201)}`]) {
      expect(ruleFieldProblem(bad), bad).not.toBeNull()
    }
  })
  it('trigger rules: one trigger, no schedule, today\'s presets, the actions Meta allows', () => {
    const trig = (trigger: Record<string, unknown>, more: Record<string, unknown> = {}) => create({
      evaluation: { evaluation_type: 'TRIGGER', filters: [{ field: 'entity_type', value: 'AD', operator: 'EQUAL' }, { field: 'time_preset', value: 'LIFETIME', operator: 'EQUAL' }], trigger }, schedule: null, ...more,
    })
    expect(trig({ type: 'STATS_MILESTONE', field: 'impressions', value: 1000, operator: 'EQUAL' })).toBeNull()
    expect(trig({ type: 'STATS_MILESTONE', field: 'impressions', value: 1000, operator: 'GREATER_THAN' })).toMatch(/EQUAL a positive number/)
    expect(trig({ type: 'METADATA_CREATION', field: 'name' })).toMatch(/type only/)
    expect(trig({ type: 'METADATA_UPDATE', field: 'daily_budget' }, { execution: { execution_type: 'PING_ENDPOINT' } })).toBeNull()
    expect(trig({ type: 'STATS_CHANGE', field: 'cost_per_purchase_fb', value: 1000, operator: 'EQUAL' })).toMatch(/GREATER_THAN, LESS_THAN/)
    expect(trig({ type: 'METADATA_UPDATE', field: 'daily_budget' }, { schedule: DAILY })).toMatch(/no schedule_spec/)
    expect(trig({ type: 'METADATA_UPDATE', field: 'daily_budget' }, { execution: { execution_type: 'CHANGE_BID', execution_options: [{ field: 'change_spec', value: { amount: 10, unit: 'PERCENTAGE' }, operator: 'EQUAL' }] } })).toMatch(/a trigger rule takes NOTIFICATION/)
    expect(trig({ type: 'METADATA_UPDATE', field: 'daily_budget' }, { execution: { execution_type: 'PAUSE', execution_options: [{ field: 'user_ids', value: ['100001'], operator: 'EQUAL' }] } })).toMatch(/no execution option but the people/)
    expect(create({ execution: { execution_type: 'PING_ENDPOINT' } })).toMatch(/PING_ENDPOINT is for trigger rules only/)
    expect(create({ schedule: null })).toMatch(/names its schedule_spec/)
  })
  it('actions and their options: change_spec, rebalance_spec, limits, people', () => {
    const opt = (type: string, options: unknown[]) => create({ execution: { execution_type: type, execution_options: options } })
    const change = (value: unknown) => ({ field: 'change_spec', value, operator: 'EQUAL' })
    expect(opt('CHANGE_BUDGET', [change({ amount: -20, unit: 'PERCENTAGE' })])).toBeNull()
    expect(opt('CHANGE_BUDGET', [change({ amount: 3000, unit: 'ACCOUNT_CURRENCY', limit: 20000 })])).toBeNull()
    expect(opt('CHANGE_BID', [change({ amount: 1500, limit: [500, 3000], target_field: 'cost_per_purchase_fb' })])).toBeNull()
    expect(opt('CHANGE_BID', [change({ amount: 1500, unit: 'ACCOUNT_CURRENCY', target_field: 'cpa' })])).toMatch(/no unit/)
    expect(opt('CHANGE_BUDGET', [change({ amount: 30.5, unit: 'ACCOUNT_CURRENCY' })])).toMatch(/whole amount/)
    expect(opt('CHANGE_BUDGET', [])).toMatch(/names its change_spec/)
    expect(opt('PAUSE', [change({ amount: 10, unit: 'PERCENTAGE' })])).toMatch(/only a budget or bid change takes a change_spec/)
    expect(opt('REBALANCE_BUDGET', [{ field: 'rebalance_spec', value: { type: 'EVEN' }, operator: 'EQUAL' }])).toBeNull()
    expect(opt('REBALANCE_BUDGET', [{ field: 'rebalance_spec', value: { type: 'PROPORTIONAL' }, operator: 'EQUAL' }])).toMatch(/target_field/)
    expect(opt('REBALANCE_BUDGET', [{ field: 'rebalance_spec', value: { type: 'INVERSE_PROPORTIONAL', target_field: 'cpa' }, operator: 'EQUAL' }])).toMatch(/rebalance_spec.type is one of/)
    expect(opt('NOTIFICATION', [{ field: 'user_ids', value: ['100001', '100002'], operator: 'EQUAL' }])).toBeNull()
    expect(opt('NOTIFICATION', [{ field: 'user_ids', value: [100001], operator: 'EQUAL' }])).toMatch(/Facebook user ids/)
    expect(opt('NOTIFICATION', [{ field: 'user_ids', value: ['100001'], operator: 'IN' }])).toMatch(/operator is EQUAL/)
    expect(opt('PAUSE', [{ field: 'execution_count_limit', value: 3, operator: 'EQUAL' }])).toMatch(/budget or bid change only/)
    expect(opt('CHANGE_BID', [change({ amount: 5, unit: 'PERCENTAGE' }), { field: 'action_frequency', value: 1440, operator: 'EQUAL' }, { field: 'execution_count_limit', value: 3, operator: 'EQUAL' }])).toBeNull()
  })
  it('an update: a name, the WHOLE rule (RU-026), or a status alone — never mixed, never DELETED', () => {
    expect(verdict({ objectKind: 'adrule', body: form({ name: 'Rule B' }) })).toMatchObject({ write: { rule: 'adRule.update', objectId: RULE, kinds: ['adrule'] } })
    expect(update({ evaluation_spec: JSON.stringify(EVAL) })).toMatch(/specs go together/)
    expect(update({ evaluation_spec: JSON.stringify(EVAL), execution_spec: JSON.stringify(PAUSE) })).toMatch(/names its schedule_spec/)
    expect(update({ evaluation_spec: JSON.stringify(EVAL), execution_spec: JSON.stringify(PAUSE), schedule_spec: JSON.stringify(DAILY) })).toBeNull()
    expect(update({ status: 'ENABLED' })).toBeNull()
    expect(update({ status: 'ENABLED', name: 'Rule B' })).toMatch(/goes on its own/)
    expect(update({ status: 'DELETED' })).toMatch(/remove-meta-ad-rule/)
    // Step 17's status rule is untouched: the same body named a campaign is a campaign's status change, and fails its values.
    expect(problem({ objectKind: 'campaign', body: form({ status: 'ENABLED' }) })).toMatch(/status is ACTIVE, PAUSED, ARCHIVED/)
  })
  it('a run and Meta\'s preview go with NO body; the preview as a read, the run as a write; the delete as a DELETE', () => {
    expect(verdict({ url: `${BASE}/${RULE}/execute`, objectKind: 'adrule', body: '' })).toEqual({ write: { rule: 'adRule.run', objectId: RULE, check: false, body: '', budget: false, kinds: ['adrule'] } })
    expect(problem({ url: `${BASE}/${RULE}/execute`, objectKind: 'adrule', body: 'x=1' })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/${RULE}/execute`, objectKind: 'adrule', body: '', kind: 'read' })).toMatch(/goes as a write/)
    expect(verdict({ url: `${BASE}/${RULE}/preview`, objectKind: 'adrule', body: '', kind: 'read' })).toEqual({ write: { rule: 'adRule.preview', objectId: RULE, check: true, body: '', budget: false, kinds: ['adrule'], readOnly: true } })
    expect(problem({ url: `${BASE}/${RULE}/preview`, objectKind: 'adrule', body: '' })).toMatch(/only reads and goes as a read/)
    expect(problem({ url: `${BASE}/${CAMPAIGN}/execute`, objectKind: 'campaign', body: '' })).toMatch(/form body/)
    // Step 17: an empty body anywhere else is still refused.
    expect(problem({ url: `${BASE}/${CAMPAIGN}`, body: '' })).toMatch(/form body/)
    expect(problem({ url: `${BASE}/${RULE}`, objectKind: 'adrule', body: '' })).toMatch(/form body/)
    expect(verdict({ method: 'DELETE', objectKind: 'adrule', body: undefined })).toMatchObject({ write: { rule: 'adRule.delete', objectId: RULE, method: 'DELETE' } })
    expect(problem({ method: 'DELETE', body: undefined })).toMatch(/deletes nothing on Meta yet/)
    expect(problem({ method: 'DELETE', url: `${BASE}/${RULE}/execute`, objectKind: 'adrule', body: undefined })).toMatch(/deletes nothing on Meta yet/)
  })
  it('the ids inside a rule, with the kind of object each names', () => {
    const body = form({ evaluation_spec: JSON.stringify({ evaluation_type: 'SCHEDULE', filters: [
      { field: 'id', value: [CAMPAIGN], operator: 'IN' }, { field: 'adset.id', value: AD_SET, operator: 'EQUAL' }, { field: 'campaign.adlabel_ids', value: ['120000000000301'], operator: 'ANY' },
      { field: 'aggregation_id', value: ['120000000000003'], operator: 'IN' }, { field: 'name', value: '120000000000009', operator: 'CONTAIN' },
    ] }) })
    expect(ruleBodyIds(body)).toEqual([
      { id: CAMPAIGN, kind: 'adobject' }, { id: AD_SET, kind: 'adset' }, { id: '120000000000301', kind: 'adlabel' }, { id: '120000000000003', kind: 'adobject' },
    ])
    expect(wholeRuleSpecsProblem(EVAL, PAUSE, DAILY)).toBeNull()
  })
})

describe('the gateway sends a rule change only for the chosen ad account', () => {
  it('a create on the chosen account\'s library goes (one POST); another account\'s library: nothing is sent', async () => {
    const ok = await metaWriteCall({ connectionId: 'm-1', operation: 'adRule.create', objectId: ACT, objectKind: 'adaccount', edge: 'adrules_library', params: Object.fromEntries(new URLSearchParams(createBody())), check: false })
    expect(ok.ok).toBe(true)
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).pathname])).toEqual([['POST', `/v26.0/${ACT}/adrules_library`]])
    expect(new URLSearchParams(String(h.calls[0].init.body)).get('status')).toBe('DISABLED')
    h.calls = []
    const other = await metaWriteCall({ connectionId: 'm-1', operation: 'adRule.create', objectId: 'act_5555555555', objectKind: 'adaccount', edge: 'adrules_library', params: Object.fromEntries(new URLSearchParams(createBody())), check: false }).catch((e) => e)
    expect(other).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    expect(h.calls).toHaveLength(0)
  })
  it('a rule is confirmed by its account_id and the two fields only a rule has; a stored campaign named a rule is refused', async () => {
    h.answers.push(json({ id: RULE, account_id: '1234567890', evaluation_spec: EVAL, execution_spec: PAUSE }), json({ success: true }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'adRule.status', objectId: RULE, objectKind: 'adrule', params: { status: 'ENABLED' }, check: false })).ok).toBe(true)
    expect(new URL(h.calls[0].url).searchParams.get('fields')).toBe('account_id,evaluation_spec,execution_spec')
    expect(h.calls.map((c) => c.init.method)).toEqual(['GET', 'POST'])
    h.calls = []
    h.answers.push(json({ id: RULE, account_id: '5555555555', evaluation_spec: EVAL, execution_spec: PAUSE }))
    const foreign = await metaWriteCall({ connectionId: 'm-1', operation: 'adRule.status', objectId: RULE, objectKind: 'adrule', params: { status: 'DISABLED' }, check: false }).catch((e) => e)
    expect(foreign).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    expect(foreign.message).not.toContain('5555555555')
    h.calls = []
    h.answers.push(json({ error: { code: 100, message: '(#100) Tried accessing nonexisting field (evaluation_spec) on node type (Campaign)' } }, 400))
    const notRule = await metaWriteCall({ connectionId: 'm-1', operation: 'adRule.status', objectId: '120000000000009', objectKind: 'adrule', params: { status: 'DISABLED' }, check: false }).catch((e) => e)
    expect(notRule).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not a Meta rule/) })
    h.calls = []
    const stored = await metaWriteCall({ connectionId: 'm-1', operation: 'adRule.status', objectId: CAMPAIGN, objectKind: 'adrule', params: { status: 'DISABLED' }, check: false }).catch((e) => e)
    expect(stored).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/Nexus has it as a campaign/) })
    expect(h.calls).toHaveLength(0)
  })
  it('every object and label inside a rule is of the chosen account: an ad set of another account, nothing is sent', async () => {
    const params = (filters: unknown[]) => Object.fromEntries(new URLSearchParams(createBody({ evaluation: { evaluation_type: 'SCHEDULE', filters: [{ field: 'entity_type', value: 'ADSET', operator: 'EQUAL' }, ...filters] } })))
    // A stored ad set of the chosen account, and a label of it, go.
    h.answers.push(json({ account: { id: ACT } }), json({ id: RULE }))
    const ok = await metaWriteCall({ connectionId: 'm-1', operation: 'adRule.create', objectId: ACT, objectKind: 'adaccount', edge: 'adrules_library', params: params([{ field: 'id', value: [AD_SET], operator: 'IN' }, { field: 'adlabel_ids', value: ['120000000000301'], operator: 'ANY' }]), check: false })
    expect(ok.ok).toBe(true)
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).pathname, new URL(c.url).searchParams.get('fields')])).toEqual([['GET', '/v26.0/120000000000301', 'account{id}'], ['POST', `/v26.0/${ACT}/adrules_library`, null]])
    // An ad set Nexus has not read, of another account: nothing is sent, the other account never named.
    h.calls = []
    h.answers.push(json({ id: '120000000000008', account_id: '5555555555', optimization_goal: 'REACH', billing_event: 'IMPRESSIONS' }))
    const foreign = await metaWriteCall({ connectionId: 'm-1', operation: 'adRule.create', objectId: ACT, objectKind: 'adaccount', edge: 'adrules_library', params: params([{ field: 'adset.id', value: ['120000000000008'], operator: 'IN' }]), check: false }).catch((e) => e)
    expect(foreign).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/inside this rule/) })
    expect(foreign.message).not.toContain('5555555555')
    expect(h.calls.every((c) => c.init.method === 'GET')).toBe(true)
    // An unprefixed id of another account (one live read of its account_id).
    h.calls = []
    h.answers.push(json({ id: '120000000000007', account_id: '5555555555' }))
    const other = await metaWriteCall({ connectionId: 'm-1', operation: 'adRule.create', objectId: ACT, objectKind: 'adaccount', edge: 'adrules_library', params: params([{ field: 'id', value: ['120000000000007'], operator: 'IN' }]), check: false }).catch((e) => e)
    expect(other).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    expect(new URL(h.calls[0].url).searchParams.get('fields')).toBe('account_id')
  })
  it('Meta\'s preview: a POST with no body, as a read — sent only while Meta changes are on, and it holds the rule for nothing', async () => {
    h.answers.push(json({ id: RULE, account_id: '1234567890', evaluation_spec: EVAL, execution_spec: PAUSE }), json({ data: [{ id: AD_SET, name: 'Ad set B' }] }))
    const res = await metaRulePreviewCall({ connectionId: 'm-1', ruleId: RULE })
    expect(res.ok).toBe(true)
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).pathname])).toEqual([['GET', `/v26.0/${RULE}`], ['POST', `/v26.0/${RULE}/preview`]])
    expect(h.calls[1].init.body).toBe('')
    expect(gatewayLedger.at(-1)).toMatchObject({ operation: 'rules.preview' })
    expect((await metaObjectState('m-1', RULE)).touchedAt).toBeNull()
    // A run of the same rule is a change: it holds the rule 30 s (Meta's per-object limit).
    h.answers.push(json({ id: RULE, account_id: '1234567890', evaluation_spec: EVAL, execution_spec: PAUSE }), json({ success: true }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'adRule.run', objectId: RULE, objectKind: 'adrule', edge: 'execute', params: {}, check: false })).ok).toBe(true)
    expect(h.calls.at(-1)).toMatchObject({ init: { method: 'POST', body: '' } })
    expect((await metaObjectState('m-1', RULE)).touchedAt).not.toBeNull()
    // Meta changes switched off: no preview is sent either.
    h.calls = []
    vi.stubEnv('NEXUS_META_ADS_WRITES', 'off')
    const off = await metaRulePreviewCall({ connectionId: 'm-1', ruleId: RULE }).catch((e) => e)
    expect(off).toMatchObject({ code: 'PUBLISH_GATED' })
    expect(h.calls).toHaveLength(0)
  })
  it('a delete of a rule of the chosen account goes as a DELETE with no body', async () => {
    h.answers.push(json({ id: RULE, account_id: '1234567890', evaluation_spec: EVAL, execution_spec: PAUSE }), json({ success: true }))
    const res = await metaWriteCall({ connectionId: 'm-1', operation: 'adRule.delete', objectId: RULE, objectKind: 'adrule', params: {}, check: false, method: 'DELETE' })
    expect(res.ok).toBe(true)
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).pathname])).toEqual([['GET', `/v26.0/${RULE}`], ['DELETE', `/v26.0/${RULE}`]])
  })
})
