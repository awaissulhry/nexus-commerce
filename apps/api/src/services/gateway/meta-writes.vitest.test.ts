/**
 * Meta on the gateway, step 17 (write base): a change reaches Meta ONLY when it is on the write ALLOW-list — today a status
 * change of one campaign, ad set or ad (POST /<id> status=ACTIVE|PAUSED|ARCHIVED), or Meta's check of one (validate_only,
 * a campaign's only, sent as a read) — and its object is of the ad account THIS business chose through THIS connection
 * (its own stored rows, else ONE live read of account_id): a forged id of another business's account is refused before
 * anything is sent. Every batch is refused (none allowed yet; each part judged as its own change). Meta's per-object
 * limits hold only that object. The body sent is the body judged. Made-up ids only.
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
import { __rateTest, bucketKey, takeToken } from './rate.js'
import { gatewayCall, GatewayRefusal } from './gateway.js'
import { metaCall, metaReportRunCall, metaWriteCall } from './meta.js'
import { META_BATCH_KINDS_ALLOWED, META_UPDATE_CHECK_PROVEN, metaBatchProblem, metaCheckAllowed, metaWriteVerdict } from './meta-calls.js'
import { __metaObjectLimitsTest, metaObjectState, metaObjectWait } from './meta-object-limits.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../meta/api-version.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const CAMPAIGN = '120000000000001'
const AD_SET = '120000000000002'
const OTHER_BUSINESS_CAMPAIGN = '120000000000099'
const CAMPAIGN_KIND = 'campaign' as const
const ADSET_KIND = 'adset' as const

const verdict = (input: Partial<Parameters<typeof metaWriteVerdict>[0]> & { body?: unknown }) =>
  metaWriteVerdict({ method: 'POST', url: `${BASE}/${CAMPAIGN}`, kind: 'write', ...input })
const problem = (input: Partial<Parameters<typeof metaWriteVerdict>[0]> & { body?: unknown }) => {
  const v = verdict(input)
  return 'problem' in v ? v.problem : null
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status })
const sent = (i: number) => ({ method: h.calls[i].init.method, url: new URL(h.calls[i].url), body: h.calls[i].init.body, headers: h.calls[i].init.headers as Record<string, string> })

beforeEach(() => {
  __rateTest.useMemory()
  __metaObjectLimitsTest.useMemory()
  h.calls = []; h.answers = []; gatewayLedger.length = 0
  for (const key of Object.keys(gatewayMetaChosen)) delete gatewayMetaChosen[key]
  for (const key of Object.keys(gatewayMetaStored)) delete gatewayMetaStored[key]
  gatewayMetaStored[CAMPAIGN] = { adAccountId: '1234567890', kind: 'campaign' }
  gatewayMetaStored[AD_SET] = { adAccountId: '1234567890', kind: 'adset' }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response(JSON.stringify({ id: CAMPAIGN, status: 'PAUSED', effective_status: 'PAUSED' }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset(); __metaObjectLimitsTest.reset() })

describe('the write allow-list (metaWriteVerdict)', () => {
  it('lets a status change of one object through as a write, the body written again in one order', () => {
    expect(verdict({ body: 'status=PAUSED' })).toEqual({ write: { rule: 'object.status', objectId: CAMPAIGN, check: false, body: 'status=PAUSED', budget: false } })
    expect(verdict({ body: 'fields=id%2Cstatus%2Ceffective_status&status=ACTIVE' })).toMatchObject({ write: { body: 'status=ACTIVE&fields=id%2Cstatus%2Ceffective_status' } })
    expect(verdict({ body: 'status=ARCHIVED' })).toMatchObject({ write: { check: false } })
  })
  it('Meta\'s check (validate_only) is a read: exactly the string ["validate_only"], never with a read-back', () => {
    expect(verdict({ kind: 'read', body: 'status=PAUSED&execution_options=%5B%22validate_only%22%5D' })).toMatchObject({ write: { check: true, body: 'status=PAUSED&execution_options=%5B%22validate_only%22%5D' } })
    expect(problem({ kind: 'write', body: 'status=PAUSED&execution_options=["validate_only"]' })).toMatch(/goes as a read/)
    expect(problem({ kind: 'read', body: 'status=PAUSED' })).toMatch(/goes as a write/)
    expect(problem({ kind: 'read', body: 'status=PAUSED&execution_options=["include_recommendations"]' })).toMatch(/only execution_options/)
    expect(problem({ kind: 'read', body: 'status=PAUSED&execution_options=["validate_only","include_recommendations"]' })).toMatch(/only execution_options/)
    expect(problem({ kind: 'read', body: 'status=PAUSED&execution_options=validate_only' })).toMatch(/exactly \["validate_only"\]/)
    // Another spelling of the same list is refused: what is sent is exactly the string judged.
    expect(problem({ kind: 'read', body: 'status=PAUSED&execution_options=[ "validate_only" ]' })).toMatch(/exactly/)
    expect(problem({ kind: 'read', body: 'status=PAUSED&execution_options=["validate_only"]&fields=id' })).toMatch(/reads nothing back/)
    expect(problem({ kind: 'action', body: 'status=PAUSED' })).toMatch(/goes as a write/)
  })
  it('review fix A2 — until LIVE-PROBE ST17-01, Meta\'s check only of a pause; after it (the flag flipped), of every status', () => {
    expect(META_UPDATE_CHECK_PROVEN).toBe(false)
    expect(['PAUSED', 'ACTIVE', 'ARCHIVED', 'DELETED'].map((s) => metaCheckAllowed(s))).toEqual([true, false, false, false])
    expect(['PAUSED', 'ACTIVE', 'ARCHIVED', 'DELETED'].map((s) => metaCheckAllowed(s, true))).toEqual([true, true, true, false])
    expect(problem({ kind: 'read', body: 'status=ACTIVE&execution_options=["validate_only"]' })).toMatch(/does not use Meta's check for a change to ACTIVE yet/)
    expect(problem({ kind: 'read', body: 'status=ARCHIVED&execution_options=["validate_only"]' })).toMatch(/to ARCHIVED yet/)
  })
  it('refuses DELETED (its own tool), any other status, any other key, and a read-back outside its fields', () => {
    expect(problem({ body: 'status=DELETED' })).toMatch(/deletes nothing/)
    expect(problem({ body: 'status=paused' })).toMatch(/status is ACTIVE, PAUSED, ARCHIVED/)
    expect(problem({ body: 'status=PAUSED&name=Shop%20A' })).toMatch(/only Meta change Nexus sends is a status change/)
    expect(problem({ body: 'status=PAUSED&daily_budget=1000' })).toMatch(/only Meta change/)
    expect(problem({ body: 'name=Shop%20A' })).toMatch(/only Meta change/)
    expect(problem({ body: 'status=PAUSED&fields=id,name' })).toMatch(/reads back only/)
    expect(problem({ body: 'status=PAUSED&fields=adset{id}' })).toMatch(/reads back only/)
    expect(problem({ body: 'status=PAUSED&fields=id,id' })).toMatch(/each field once/)
  })
  it('refuses every other path: a create edge, an object\'s edge, the ad account, a root call', () => {
    expect(problem({ url: `${BASE}/act_1234567890/campaigns`, body: 'status=PAUSED' })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/${CAMPAIGN}/copies`, body: 'status=PAUSED' })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/act_1234567890`, body: 'status=PAUSED' })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/me`, body: 'status=PAUSED' })).toMatch(/only Meta change/)
  })
  it('refuses parameters on the URL, a JSON or empty body, a key twice, a gateway key, a method override, odd values', () => {
    expect(problem({ url: `${BASE}/${CAMPAIGN}?status=ACTIVE`, body: 'status=PAUSED' })).toMatch(/never in the URL/)
    expect(problem({ url: `${BASE}/${CAMPAIGN}?fields=id`, body: 'status=PAUSED' })).toMatch(/never in the URL/)
    expect(problem({ body: '{"status":"PAUSED"}' })).toMatch(/is not one Meta reads/)
    expect(problem({ body: '' })).toMatch(/form body/)
    expect(problem({ body: undefined })).toMatch(/form body/)
    expect(problem({ body: 'status=PAUSED&status=ACTIVE' })).toMatch(/more than once/)
    expect(problem({ body: 'status=PAUSED&access_token=EAAforged' })).toMatch(/no Nexus change sends/)
    expect(problem({ body: 'status=PAUSED&appsecret_proof=x' })).toMatch(/no Nexus change sends/)
    expect(problem({ body: 'status=PAUSED&method=delete' })).toMatch(/no Nexus change sends/)
    expect(problem({ body: 'status=PAUSED&_method=delete' })).toMatch(/no Nexus change sends/)
    expect(problem({ body: 'Status=PAUSED' })).toMatch(/is not one Meta reads/)
    expect(problem({ body: 'status=PAUS%C3%89D' })).toMatch(/plain ASCII/)
    expect(problem({ body: `status=PAUSED&fields=${'id,'.repeat(800)}id` })).toMatch(/at most 2000/)
  })
  it('refuses DELETE, PUT, a caller\'s header, any token but the account\'s, another host, version or an odd path', () => {
    expect(problem({ method: 'DELETE', body: undefined })).toMatch(/deletes nothing on Meta yet/)
    expect(problem({ method: 'PUT', body: 'status=PAUSED' })).toMatch(/no PUT/)
    expect(problem({ body: 'status=PAUSED', headers: { 'X-HTTP-Method-Override': 'DELETE' } })).toMatch(/no header/)
    expect(problem({ body: 'status=PAUSED', auth: 'app' })).toMatch(/system-user token/)
    expect(problem({ body: 'status=PAUSED', auth: 'none' })).toMatch(/system-user token/)
    expect(problem({ body: 'status=PAUSED', auth: { token: 'EAAx', appSecret: 's' } })).toMatch(/system-user token/)
    expect(problem({ url: `https://graph-video.facebook.com/v26.0/${CAMPAIGN}`, body: 'status=PAUSED' })).toMatch(/graph\.facebook\.com/)
    expect(problem({ url: `https://graph.facebook.com/v25.0/${CAMPAIGN}`, body: 'status=PAUSED' })).toMatch(/v26\.0/)
    expect(problem({ url: `${BASE}/%31${CAMPAIGN.slice(1)}`, body: 'status=PAUSED' })).toMatch(/percent-encoded/)
    expect(problem({ url: `${BASE}//${CAMPAIGN}`, body: 'status=PAUSED' })).toMatch(/empty segment/)
  })
})

describe('batches (ACC-022/023/025–027): the plumbing judges each part, and nothing is allowed through it yet', () => {
  const batch = (parts: unknown[]) => `batch=${encodeURIComponent(JSON.stringify(parts))}`
  it('no batch kind is allowed', () => {
    expect([...META_BATCH_KINDS_ALLOWED]).toEqual([])
  })
  it('a Graph batch is refused as a batch, naming the first part Nexus would not send even on its own', () => {
    const ok = verdict({ url: `${BASE}/`, body: batch([{ method: 'POST', relative_url: `v26.0/${CAMPAIGN}`, body: 'status=PAUSED' }]) })
    expect(ok).toMatchObject({ batch: true, problem: expect.stringMatching(/sends no Meta batch request yet.*not all|one by one/) })
    expect(problem({ url: `${BASE}/`, body: batch([{ method: 'POST', relative_url: CAMPAIGN, body: 'status=PAUSED' }, { method: 'DELETE', relative_url: AD_SET }]) })).toMatch(/part 2: Nexus deletes nothing/)
    expect(problem({ url: `${BASE}/`, body: batch([{ method: 'POST', relative_url: CAMPAIGN, body: 'status={result=one:$.id}' }]) })).toMatch(/depends on another part/)
    expect(problem({ url: `${BASE}/`, body: batch([{ method: 'POST', relative_url: 'v26.0/', body: 'batch=[]' }]) })).toMatch(/batch inside a batch/)
    expect(problem({ url: `${BASE}/`, body: batch(Array.from({ length: 51 }, () => ({ method: 'POST', relative_url: CAMPAIGN, body: 'status=PAUSED' }))) })).toMatch(/at most 50/)
    expect(problem({ url: `${BASE}/`, body: 'batch=not-json' })).toMatch(/batch is not JSON/)
  })
  it('an async batch is refused too; renaming or cancelling an async request set is not on the allow-list', () => {
    const body = `name=Set%20A&adbatch=${encodeURIComponent(JSON.stringify([{ name: 'one', relative_url: `v26.0/${CAMPAIGN}`, body: 'status=PAUSED' }]))}`
    expect(verdict({ url: `${BASE}/act_1234567890/async_batch_requests`, body })).toMatchObject({ batch: true, problem: expect.stringMatching(/no Meta async batch yet/) })
    expect(metaBatchProblem('POST', 'act_1234567890/async_batch_requests', 'name=x')).toMatch(/names no adbatch/)
    expect(problem({ body: 'name=Set%20B&notification_mode=OFF' })).toMatch(/only Meta change/)
    expect(problem({ method: 'DELETE', body: undefined })).toMatch(/cancels no async batch/)
  })
  it('the gateway refuses a batch META_BATCH_NOT_ALLOWED with its ledger row, sending nothing', async () => {
    const err = await gatewayCall({ channel: 'META', operation: 'batch', kind: 'write', connectionId: 'm-1', url: `${BASE}/`, method: 'POST', body: batch([{ method: 'POST', relative_url: CAMPAIGN, body: 'status=PAUSED' }]) }).catch((e) => e)
    expect(err).toMatchObject({ code: 'META_BATCH_NOT_ALLOWED', outcome: 'refused' })
    expect(h.calls).toHaveLength(0)
    expect(gatewayLedger).toEqual([expect.objectContaining({ errorCode: 'META_BATCH_NOT_ALLOWED' })])
  })
})

describe('a change through the gateway', () => {
  it('a status change of a stored campaign of the chosen account goes once: POST, the judged form body, the token on the URL only', async () => {
    const res = await metaWriteCall({ connectionId: 'm-1', operation: 'campaign.status', objectId: CAMPAIGN, objectKind: CAMPAIGN_KIND, params: { status: 'PAUSED', fields: 'id,status,effective_status' }, check: false })
    expect(res.ok).toBe(true)
    expect(h.calls).toHaveLength(1)
    const call = sent(0)
    expect(call.method).toBe('POST')
    expect(call.url.pathname).toBe(`/v26.0/${CAMPAIGN}`)
    expect(call.url.searchParams.get('access_token')).toBe('meta-system-user-token')
    expect([...call.url.searchParams.keys()].sort()).toEqual(['access_token', 'appsecret_proof', 'appsecret_time'])
    expect(call.body).toBe('status=PAUSED&fields=id%2Cstatus%2Ceffective_status')
    expect(call.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(gatewayLedger).toEqual([expect.objectContaining({ channel: 'META', method: 'POST', outcome: 'sent', success: true, endpoint: `graph.facebook.com/v26.0/${CAMPAIGN}` })])
    expect(JSON.stringify(gatewayLedger)).not.toContain('meta-system-user-token')
  })
  it('writes switched off (off, false, 0, no — any case): a change AND Meta\'s check are gated, whatever the caller says', async () => {
    for (const brake of ['off', 'FALSE', '0', 'No']) {
      vi.stubEnv('NEXUS_META_ADS_WRITES', brake)
      const err = await gatewayCall({ channel: 'META', operation: 'campaign.status', kind: 'write', connectionId: 'm-1', url: `${BASE}/${CAMPAIGN}`, method: 'POST', body: 'status=ACTIVE', modeAppliedByCaller: true, metaObjectKind: 'campaign' }).catch((e) => e)
      expect(err, brake).toMatchObject({ outcome: 'gated', code: 'PUBLISH_GATED' })
      const check = await metaWriteCall({ connectionId: 'm-1', operation: 'campaign.status.check', objectId: CAMPAIGN, objectKind: CAMPAIGN_KIND, params: { status: 'PAUSED' }, check: true }).catch((e) => e)
      expect(check, brake).toMatchObject({ outcome: 'gated', code: 'PUBLISH_GATED', message: expect.stringMatching(/not asked to check one either/) })
    }
    expect(h.calls).toHaveLength(0)
    vi.stubEnv('NEXUS_META_ADS_WRITES', 'on')
    h.answers.push(json({ success: true }))
    const check = await metaWriteCall({ connectionId: 'm-1', operation: 'campaign.status.check', objectId: CAMPAIGN, objectKind: CAMPAIGN_KIND, params: { status: 'PAUSED' }, check: true })
    expect(check.ok).toBe(true)
    expect(sent(0).body).toBe('status=PAUSED&execution_options=%5B%22validate_only%22%5D')
  })
  it('Meta has a check only for campaigns: an ad set\'s check is refused, nothing sent', async () => {
    const err = await metaWriteCall({ connectionId: 'm-1', operation: 'adset.status.check', objectId: AD_SET, objectKind: ADSET_KIND, params: { status: 'PAUSED' }, check: true }).catch((e) => e)
    expect(err).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/only for campaign changes/) })
    expect(h.calls).toHaveLength(0)
  })
  it('review fix B4 — the KIND is confirmed: none named, a stored row of another kind, a creative id: refused, no change sent', async () => {
    const none = await gatewayCall({ channel: 'META', operation: 'x', kind: 'write', connectionId: 'm-1', url: `${BASE}/${CAMPAIGN}`, method: 'POST', body: 'status=PAUSED' }).catch((e) => e)
    expect(none).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/names the kind of object/) })
    const wrong = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: AD_SET, objectKind: CAMPAIGN_KIND, params: { status: 'PAUSED' }, check: false }).catch((e) => e)
    expect(wrong).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not a campaign Nexus can confirm \(Nexus has it as a ad set\)/) })
    expect(h.calls).toHaveLength(0)
    // A creative of the chosen account, named an ad: Meta has no adset_id on a creative, so the one read refuses it.
    h.answers.push(json({ error: { code: 100, message: 'Tried accessing nonexisting field (adset_id) on node type (AdCreative)' } }, 400))
    const creative = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: '120000000000077', objectKind: 'ad', params: { status: 'PAUSED' }, check: false }).catch((e) => e)
    expect(creative).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not a ad Nexus can confirm.*nonexisting field/) })
    expect(sent(0).url.searchParams.get('fields')).toBe('account_id,adset_id,creative')
    // Meta answers the account but not the kind's own field: not confirmed as that kind either.
    h.answers.push(json({ id: '120000000000078', account_id: '1234567890' }))
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: '120000000000078', objectKind: ADSET_KIND, params: { status: 'PAUSED' }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    expect(sent(1).url.searchParams.get('fields')).toBe('account_id,optimization_goal,billing_event')
    expect(h.calls.map((c) => c.init.method)).toEqual(['GET', 'GET'])
  })
  it('re-review — a ReachFrequencyPrediction (account_id, objective, optimization_goal) is no campaign and no ad set: two kind fields, both required', async () => {
    // Meta answers the second field's absence on that node with an error…
    h.answers.push(json({ error: { code: 100, message: 'Tried accessing nonexisting field (effective_status) on node type (ReachFrequencyPrediction)' } }, 400))
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: '120000000000081', objectKind: CAMPAIGN_KIND, params: { status: 'PAUSED' }, check: false }).catch((e) => e))
      .toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not a campaign Nexus can confirm/) })
    // …and an RFP-shaped answer with only one of a kind's two fields is refused too.
    const rfp = { id: '120000000000082', account_id: '1234567890', objective: 'REACH', optimization_goal: 'REACH', buying_type: 'RESERVED', campaign_id: '120000000000001' }
    h.answers.push(json(rfp))
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: rfp.id, objectKind: CAMPAIGN_KIND, params: { status: 'PAUSED' }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    h.answers.push(json(rfp))
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: rfp.id, objectKind: ADSET_KIND, params: { status: 'PAUSED' }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).searchParams.get('fields')])).toEqual([
      ['GET', 'account_id,objective,effective_status'], ['GET', 'account_id,objective,effective_status'], ['GET', 'account_id,optimization_goal,billing_event'],
    ])
    // The real kinds pass with both fields: an ad set, then an ad (no POST is sent before the kind is confirmed).
    h.calls = []
    h.answers.push(json({ id: '120000000000083', account_id: '1234567890', optimization_goal: 'OFFSITE_CONVERSIONS', billing_event: 'IMPRESSIONS' }), json({ id: '120000000000083', status: 'PAUSED' }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: '120000000000083', objectKind: ADSET_KIND, params: { status: 'PAUSED' }, check: false })).ok).toBe(true)
    h.answers.push(json({ id: '120000000000084', account_id: '1234567890', adset_id: '120000000000083', creative: { id: '120000000000085' } }), json({ id: '120000000000084', status: 'PAUSED' }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: '120000000000084', objectKind: 'ad', params: { status: 'PAUSED' }, check: false })).ok).toBe(true)
    expect(h.calls.map((c) => c.init.method)).toEqual(['GET', 'POST', 'GET', 'POST'])
  })
  it('an object stored for another account of this business, or no ad account chosen: refused, nothing sent', async () => {
    gatewayMetaStored[CAMPAIGN] = { adAccountId: '1234567891', kind: 'campaign' }
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: CAMPAIGN, objectKind: CAMPAIGN_KIND, params: { status: 'PAUSED' }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    gatewayMetaChosen['m-2'] = null
    expect(await metaWriteCall({ connectionId: 'm-2', operation: 'x', objectId: AD_SET, objectKind: ADSET_KIND, params: { status: 'PAUSED' }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/no Meta ad account chosen/) })
    expect(h.calls).toHaveLength(0)
  })
  it('a FORGED id of another business\'s ad account: ONE live read of its account_id, then refused — no change sent, the other account never named', async () => {
    // Not in this business's rows (row-level security hides the other business's); the shared system user can still see it.
    h.answers.push(json({ account_id: '5555555555', id: OTHER_BUSINESS_CAMPAIGN }))
    const err = await metaWriteCall({ connectionId: 'm-1', operation: 'campaign.status', objectId: OTHER_BUSINESS_CAMPAIGN, objectKind: CAMPAIGN_KIND, params: { status: 'ACTIVE' }, check: false }).catch((e) => e)
    expect(err).toBeInstanceOf(GatewayRefusal)
    expect(err).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', outcome: 'refused' })
    expect(err.message).not.toContain('5555555555')
    expect(h.calls).toHaveLength(1)
    expect(sent(0).method).toBe('GET')
    expect(sent(0).url.pathname).toBe(`/v26.0/${OTHER_BUSINESS_CAMPAIGN}`)
    expect(sent(0).url.searchParams.get('fields')).toBe('account_id,objective,effective_status')
    expect(gatewayLedger.map((r) => [r.operation, r.outcome, r.errorCode ?? null])).toEqual([['write.ownerCheck', 'sent', null], ['campaign.status', 'refused', 'META_ACCOUNT_NOT_CHOSEN']])
  })
  it('a campaign made since the last daily read: the live read places it in the chosen account, then the change goes', async () => {
    h.answers.push(json({ account_id: '1234567890', id: '120000000000005', objective: 'OUTCOME_SALES', effective_status: 'ACTIVE' }), json({ id: '120000000000005', status: 'PAUSED' }))
    const res = await metaWriteCall({ connectionId: 'm-1', operation: 'campaign.status', objectId: '120000000000005', objectKind: CAMPAIGN_KIND, params: { status: 'PAUSED' }, check: false })
    expect(res.ok).toBe(true)
    expect(h.calls.map((c) => c.init.method)).toEqual(['GET', 'POST'])
  })
  it('a check of an object Nexus has not read asks account_id and objective: an ad set (no objective) is refused', async () => {
    h.answers.push(json({ error: { code: 100, message: 'Tried accessing nonexisting field (objective) on node type (AdSet)' } }, 400))
    const err = await metaWriteCall({ connectionId: 'm-1', operation: 'x.check', objectId: '120000000000006', objectKind: CAMPAIGN_KIND, params: { status: 'PAUSED' }, check: true }).catch((e) => e)
    expect(err).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    expect(sent(0).url.searchParams.get('fields')).toBe('account_id,objective,effective_status')
    expect(h.calls).toHaveLength(1)
  })
  it('Meta does not place the object (an error, or no account_id): refused META_ACCOUNT_UNCONFIRMED', async () => {
    h.answers.push(json({ error: { code: 100, error_subcode: 33, message: 'Object does not exist' } }, 400))
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: '120000000000007', objectKind: CAMPAIGN_KIND, params: { status: 'PAUSED' }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_UNCONFIRMED' })
    h.answers.push(json({ id: '120000000000008' }))
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: '120000000000008', objectKind: CAMPAIGN_KIND, params: { status: 'PAUSED' }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_UNCONFIRMED' })
    expect(h.calls.every((c) => c.init.method === 'GET')).toBe(true)
  })
  it('a change names its connection', async () => {
    const err = await gatewayCall({ channel: 'META', operation: 'x', kind: 'write', connectionId: null, appLevel: true, url: `${BASE}/${CAMPAIGN}`, method: 'POST', body: 'status=PAUSED' }).catch((e) => e)
    expect(err).toMatchObject({ code: 'ACCOUNT_REQUIRED' })
  })
  it('a change is never retried (5xx: one call), not even when a caller calls it idempotent; Meta\'s check is, once', async () => {
    h.answers.push(json({ error: { code: 1, message: 'Unknown error' } }, 500))
    const res = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: CAMPAIGN, objectKind: CAMPAIGN_KIND, params: { status: 'PAUSED' }, check: false })
    expect(res.ok).toBe(false)
    expect(h.calls).toHaveLength(1)
    h.calls = []
    __metaObjectLimitsTest.useMemory()
    h.answers.push(json({ error: { code: 1, message: 'Unknown error' } }, 500), json({ id: CAMPAIGN, status: 'PAUSED' }))
    const forced = await gatewayCall({ channel: 'META', operation: 'x', kind: 'write', connectionId: 'm-1', url: `${BASE}/${CAMPAIGN}`, method: 'POST', body: 'status=PAUSED', idempotent: true, maxTransientRetries: 3, retryBackoffMs: 1, metaObjectKind: 'campaign' })
    expect(forced.ok).toBe(false)
    expect(h.calls).toHaveLength(1)
    h.calls = []; h.answers = []
    __metaObjectLimitsTest.useMemory()
    h.answers.push(json({ error: { code: 1, message: 'Unknown error' } }, 500), json({ success: true }))
    const check = await gatewayCall({ channel: 'META', operation: 'x.check', kind: 'read', connectionId: 'm-1', url: `${BASE}/${CAMPAIGN}`, method: 'POST', body: 'status=PAUSED&execution_options=["validate_only"]', retryBackoffMs: 1, metaObjectKind: 'campaign' })
    expect(check.ok).toBe(true)
    expect(h.calls).toHaveLength(2)
  })
  it('a change takes 3 tokens of the account\'s bucket (Meta scores a write 3 points, a read 1)', async () => {
    await metaCall({ connectionId: 'm-5', operation: 'r', path: 'act_1234567890/campaigns', query: { fields: 'id' } })
    const afterRead = await takeToken('META', bucketKey('META', 'm-5', 'ads'), 0)
    gatewayMetaChosen['m-6'] = '1234567890'
    await metaWriteCall({ connectionId: 'm-6', operation: 'w', objectId: CAMPAIGN, objectKind: CAMPAIGN_KIND, params: { status: 'PAUSED' }, check: false })
    const afterWrite = await takeToken('META', bucketKey('META', 'm-6', 'ads'), 0)
    expect(afterRead.tokensLeft - afterWrite.tokensLeft).toBeCloseTo(2, 0)
  })
})

describe('Meta\'s per-object limits hold only that object', () => {
  it('a second change of the same object within 30 s is refused RATE_LIMITED_LOCAL (nothing sent); another object goes; a check is not held', async () => {
    await metaWriteCall({ connectionId: 'm-1', operation: 'w', objectId: CAMPAIGN, objectKind: CAMPAIGN_KIND, params: { status: 'PAUSED' }, check: false })
    const err = await metaWriteCall({ connectionId: 'm-1', operation: 'w', objectId: CAMPAIGN, objectKind: CAMPAIGN_KIND, params: { status: 'ACTIVE' }, check: false }).catch((e) => e)
    expect(err).toMatchObject({ code: 'RATE_LIMITED_LOCAL', message: expect.stringMatching(/one change of the same object every 30 s/) })
    expect(err.retryAfterMs).toBeGreaterThan(25_000)
    expect(err.retryAfterMs).toBeLessThanOrEqual(30_000)
    await metaWriteCall({ connectionId: 'm-1', operation: 'w', objectId: AD_SET, objectKind: ADSET_KIND, params: { status: 'PAUSED' }, check: false })
    h.answers.push(json({ success: true }))
    await metaWriteCall({ connectionId: 'm-1', operation: 'c', objectId: CAMPAIGN, objectKind: CAMPAIGN_KIND, params: { status: 'PAUSED' }, check: true })
    expect(h.calls).toHaveLength(3)
  })
  it('613/4841018 holds that object 30 s, never the account\'s bucket', async () => {
    h.answers.push(json({ error: { code: 613, error_subcode: 4841018, message: 'Calls to this api have exceeded the rate limit.' } }, 400))
    const res = await metaWriteCall({ connectionId: 'm-7', operation: 'w', objectId: CAMPAIGN, objectKind: CAMPAIGN_KIND, params: { status: 'PAUSED' }, check: false })
    expect(res.ok).toBe(false)
    const state = await metaObjectState('m-7', CAMPAIGN)
    expect(state.heldUntil! - Date.now()).toBeGreaterThan(25_000)
    expect(metaObjectWait(state, false)?.why).toMatch(/4841018/)
    await metaCall({ connectionId: 'm-7', operation: 'r', path: 'act_1234567890/campaigns', query: { fields: 'id' } })
    expect(h.calls).toHaveLength(2)
  })
  it('613/1487632 holds only that ad set\'s BUDGET changes for an hour (Meta: "the budget change for that ad set is blocked"), never the bucket', async () => {
    h.answers.push(json({ error: { code: 613, error_subcode: 1487632, message: 'You can only change your ad set budget 4 times per hour.' } }, 400))
    await metaWriteCall({ connectionId: 'm-8', operation: 'w', objectId: AD_SET, objectKind: ADSET_KIND, params: { status: 'PAUSED' }, check: false })
    const state = await metaObjectState('m-8', AD_SET)
    expect(state.budgetHeldUntil! - Date.now()).toBeGreaterThan(3_500_000)
    expect(metaObjectWait(state, true)?.why).toMatch(/1487632/)
    expect(metaObjectWait({ ...state, touchedAt: null }, false)).toBeNull()
    expect(await takeToken('META', bucketKey('META', 'm-8', 'ads'), 0)).toMatchObject({ ok: true })
  })
})

describe('step 7 — a report run (POST /act_<id>/insights) is a READ of the chosen ad account: every key and value judged', () => {
  const RUN_URL = `${BASE}/act_1234567890/insights`
  const form = (params: Record<string, unknown>) => new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])).toString()
  const runProblem = (params: Record<string, unknown>, kind = 'read', url = RUN_URL) => {
    const v = metaWriteVerdict({ method: 'POST', url, kind, body: form(params) })
    return 'problem' in v ? v.problem : null
  }
  it('lets a report run through as a read of that ad account, the body written again in one order', () => {
    const v = metaWriteVerdict({ method: 'POST', url: RUN_URL, kind: 'read', body: form({ fields: 'campaign_id,spend', level: 'campaign', date_preset: 'last_7d' }) })
    expect(v).toEqual({ write: { rule: 'insights.reportRun', objectId: '1234567890', check: false, body: form({ level: 'campaign', fields: 'campaign_id,spend', date_preset: 'last_7d' }), budget: false, reportRun: true } })
    expect(runProblem({ level: 'adset', breakdowns: ['mmm'], export_format: 'csv', fields: 'impressions,spend', time_increment: 1, filtering: [{ field: 'country', operator: 'IN', value: ['IT'] }] })).toBeNull()
    expect(runProblem({ level: 'ad', fields: 'ad_id,spend', breakdowns: ['age', 'gender'], time_ranges: [{ since: '2026-10-01', until: '2026-10-07' }], export_format: 'xls', export_name: 'Shop A' })).toBeNull()
  })
  it('refuses what a read would not send: a change kind, keys off the list, values off the lists, an MMM export Meta would not take', () => {
    expect(runProblem({ level: 'campaign', fields: 'spend' }, 'write')).toMatch(/changes nothing on Meta and goes as a read/)
    expect(runProblem({ fields: 'spend' })).toMatch(/only Meta change/)
    expect(runProblem({ level: 'campaign', fields: 'spend', graph_cache: false })).toMatch(/only Meta change/)
    expect(runProblem({ level: 'campaign', fields: 'spend', use_unified_attribution_setting: true })).toMatch(/only Meta change/)
    expect(runProblem({ level: 'campaign', fields: 'spend,access_token' })).toMatch(/no Nexus change sends|only metrics on Nexus's insights list/)
    expect(runProblem({ level: 'campaign', fields: 'spend,name' })).toMatch(/only metrics on Nexus's insights list/)
    expect(runProblem({ level: 'everything', fields: 'spend' })).toMatch(/names its level/)
    expect(runProblem({ level: 'campaign', breakdowns: ['dma'] })).toMatch(/breakdowns are breakdowns on Nexus's list/)
    expect(runProblem({ level: 'campaign', breakdowns: ['country', 'age'] })).toMatch(/does not combine/)
    expect(runProblem({ level: 'campaign', action_attribution_windows: ['28d_view'] })).toMatch(/action_attribution_windows is not a value/)
    expect(runProblem({ level: 'campaign', filtering: [{ field: 'user.email', operator: 'EQUAL', value: 'x' }] })).toMatch(/not a filter Nexus sends/)
    expect(runProblem({ level: 'campaign', export_format: 'pdf' })).toMatch(/csv or xls/)
    expect(runProblem({ level: 'campaign', export_name: 'x' })).toMatch(/with an export_format/)
    expect(runProblem({ level: 'campaign', breakdowns: ['mmm'], export_format: 'csv' })).toMatch(/level adset with export_format csv/)
    expect(runProblem({ level: 'adset', breakdowns: ['mmm'] })).toMatch(/level adset with export_format csv/)
    expect(runProblem({ level: 'adset', breakdowns: ['mmm'], export_format: 'csv', fields: 'reach' })).toMatch(/impressions and spend only/)
    expect(runProblem({ level: 'adset', breakdowns: ['mmm'], export_format: 'csv', filtering: [{ field: 'campaign.name', operator: 'EQUAL', value: 'x' }] })).toMatch(/takes only these filters/)
    expect(runProblem({ level: 'adset', breakdowns: ['mmm'], export_format: 'csv', time_increment: 7 })).toMatch(/by day \(1\) or for the whole period/)
    // Only on the account's own insights edge: never an object's (Meta documents the POST on /act_{id}/insights only).
    expect(runProblem({ level: 'campaign', fields: 'spend' }, 'read', `${BASE}/${CAMPAIGN}/insights`)).toMatch(/only Meta change/)
    expect(runProblem({ level: 'campaign', fields: 'spend' }, 'read', `${RUN_URL}?level=ad`)).toMatch(/never in the URL/)
  })
  it('the gateway sends it as a read of the chosen account only — never braked by NEXUS_META_ADS_WRITES, never held per object, never retried', async () => {
    vi.stubEnv('NEXUS_META_ADS_WRITES', 'off')
    h.answers.push(json({ report_run_id: '6000000000001' }))
    const res = await gatewayCall({ channel: 'META', operation: 'report.start', kind: 'read', connectionId: 'm-1', url: RUN_URL, method: 'POST', body: form({ level: 'campaign', fields: 'spend' }), maxTransientRetries: 0 })
    expect(res.ok).toBe(true)
    expect(sent(0)).toMatchObject({ method: 'POST', body: form({ level: 'campaign', fields: 'spend' }) })
    expect(sent(0).headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(sent(0).url.searchParams.get('appsecret_proof')).toBe('proof')
    expect(await metaObjectState('m-1', '1234567890')).toMatchObject({ touchedAt: null, heldUntil: null })
    // Another ad account than the one this business chose through this connection: nothing sent.
    gatewayMetaChosen['m-2'] = '5550001112'
    const err = await gatewayCall({ channel: 'META', operation: 'report.start', kind: 'read', connectionId: 'm-2', url: RUN_URL, method: 'POST', body: form({ level: 'campaign', fields: 'spend' }) }).catch((e) => e)
    expect(err).toBeInstanceOf(GatewayRefusal)
    expect(err).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    gatewayMetaChosen['m-3'] = null
    expect(await gatewayCall({ channel: 'META', operation: 'report.start', kind: 'read', connectionId: 'm-3', url: RUN_URL, method: 'POST', body: form({ level: 'campaign', fields: 'spend' }) }).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    expect(h.calls).toHaveLength(1)
    // A 5xx is not sent again (a second run would only cost a read, but nobody asked for it).
    h.answers.push(json({ error: { message: 'oops', code: 2 } }, 500))
    const failed = await gatewayCall({ channel: 'META', operation: 'report.start', kind: 'read', connectionId: 'm-1', url: RUN_URL, method: 'POST', body: form({ level: 'campaign', fields: 'spend' }), maxTransientRetries: 3 })
    expect(failed.ok).toBe(false)
    expect(h.calls).toHaveLength(2)
  })
  it('review round 1 — A-F3: Object.prototype\'s names in a report run\'s fields, breakdowns or filters are refused; A-F6: the path in lower case only', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(runProblem({ level: 'ad', fields: `spend,${name}` }), name).toMatch(/only metrics on Nexus's insights list/)
      expect(runProblem({ level: 'ad', breakdowns: [name] }), name).toMatch(/breakdowns are breakdowns on Nexus's list/)
      expect(() => runProblem({ level: 'adset', breakdowns: ['mmm'], export_format: 'csv', filtering: [{ field: name, operator: 'IN', value: ['1'] }] })).not.toThrow()
      expect(runProblem({ level: 'adset', breakdowns: ['mmm'], export_format: 'csv', filtering: [{ field: name, operator: 'IN', value: ['1'] }] }), name).toMatch(/takes only these filters/)
      expect(runProblem({ level: 'ad', filtering: [{ field: name, operator: 'IN', value: ['1'] }] }), name).toMatch(/not a filter Nexus sends/)
    }
    expect(runProblem({ level: 'ad', fields: 'spend' }, 'read', `${BASE}/ACT_1234567890/insights`)).toMatch(/written in lower case/)
    expect(runProblem({ level: 'ad', fields: 'spend' }, 'read', `${BASE}/act_1234567890/INSIGHTS`)).toMatch(/written in lower case/)
    expect(runProblem({ level: 'ad', fields: 'spend' })).toBeNull()
  })
  it('metaReportRunCall sends exactly that: the form body of the read, as a read, for the named account', async () => {
    h.answers.push(json({ report_run_id: '6000000000002' }))
    const res = await metaReportRunCall({ connectionId: 'm-1', operation: 'report.start', adAccountId: '1234567890', params: { level: 'adset', breakdowns: ['mmm'], export_format: 'csv', fields: 'impressions,spend', time_increment: 1 } })
    expect(res.json()).toEqual({ report_run_id: '6000000000002' })
    expect(sent(0).url.pathname).toBe(`/${META_DEFAULT_GRAPH_API_VERSION}/act_1234567890/insights`)
    expect(new URLSearchParams(String(sent(0).body)).get('breakdowns')).toBe('["mmm"]')
  })
})
