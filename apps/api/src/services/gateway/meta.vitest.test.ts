/**
 * Meta on the gateway (step 1): READ ONLY by construction — a GET to the pinned Graph version only, never a method
 * override, a batch, a token revoke or a sign-in call but the token renewal; every call signed with a fresh
 * appsecret_proof the token service makes (the secret never reaches the caller); the token on the URL that is sent,
 * never on the URL the ledger, the trace or the answer carry; Meta's usage headers hold the bucket; Graph error codes
 * classified. Every refusal has its ledger row and sends nothing.
 */
import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, answers: [] as Array<() => Response>, proofs: [] as string[], forgotten: [] as string[] }))
vi.mock('./account.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('./ledger.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../cx/token.service.js', () => ({
  getAccessToken: vi.fn(async () => 'meta-system-user-token'),
  metaAppAccessToken: vi.fn(async () => '1234567|app-secret-for-tests'),
  metaAppIdOf: vi.fn(async () => '1234567'),
  metaRequestProof: vi.fn(async (_connectionId: string, token: string) => {
    h.proofs.push(token)
    return { appsecret_proof: `proof-of-${token.length}`, appsecret_time: '1760000000' }
  }),
}))
vi.mock('../cx/deprecation-watch.service.js', () => ({ watchForDeprecation: vi.fn(async () => undefined) }))
vi.mock('../cx/connectors/meta/token-check.js', () => ({ forgetMetaTokenCheck: vi.fn(async (id: string) => { h.forgotten.push(id) }) }))

import { gatewayLedger } from '../../test-support/gateway-stubs.js'
import { __rateTest, bucketKey, defaultsFor, META_BUCKETS, META_FULL_BUCKETS, observeRate, takeToken } from './rate.js'
import { gatewayCall, GatewayRefusal } from './gateway.js'
import { metaCall, metaUrl } from './meta.js'
import { metaAppSecretProof, metaCallGroup, metaReadOnlyProblem, metaSendUrl } from './meta-calls.js'
import { authHeadersOf, bucketGroupOf, publishModeOf, apiVersionOf } from './channels.js'
import { classifyChannelAnswer } from './vocabulary.js'
import { ledgerSafeBody } from './redact.js'
import { metaRateReading, metaUsageOf } from '../cx/rate-readings.js'
import { META_DEFAULT_GRAPH_API_VERSION, metaGraphApiVersion, metaGraphBase } from '../meta/api-version.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const sentUrl = (i = 0) => new URL(h.calls[i].url)

beforeEach(() => {
  __rateTest.useMemory()
  h.calls = []; h.answers = []; h.proofs = []; h.forgotten = []; gatewayLedger.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response(JSON.stringify({ data: [] }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset() })

describe('the pinned version', () => {
  it('is v26.0 by default, META_GRAPH_API_VERSION when written vNN.N, and the default for anything else', () => {
    expect(metaGraphApiVersion()).toBe('v26.0')
    vi.stubEnv('META_GRAPH_API_VERSION', 'v27.0')
    expect(metaGraphBase()).toBe('https://graph.facebook.com/v27.0')
    vi.stubEnv('META_GRAPH_API_VERSION', 'latest')
    expect(metaGraphApiVersion()).toBe('v26.0')
  })
  it('the ledger reads the version from the path', () => {
    expect(apiVersionOf('META', `${BASE}/me`)).toBe('v26.0')
  })
})

describe('read only by construction', () => {
  const ok = (url: string, extra: Partial<Parameters<typeof metaReadOnlyProblem>[0]> = {}) => metaReadOnlyProblem({ method: 'GET', url, kind: 'read', ...extra })
  it('lets a plain GET of the pinned version through', () => {
    expect(ok(`${BASE}/act_1234567890/campaigns?fields=id,name&limit=200`)).toBeNull()
    expect(ok(`${BASE}/debug_token?input_token=x`)).toBeNull()
  })
  it('refuses every other method, kind, body, host and version', () => {
    expect(metaReadOnlyProblem({ method: 'POST', url: `${BASE}/act_1234567890/campaigns`, kind: 'read' })).toMatch(/POST/)
    expect(metaReadOnlyProblem({ method: 'DELETE', url: `${BASE}/120000000000001`, kind: 'read' })).toMatch(/DELETE/)
    expect(ok(`${BASE}/me`, { kind: 'write' })).toMatch(/not declared a read/)
    expect(ok(`${BASE}/me`, { body: '{"name":"x"}' })).toMatch(/no body/)
    expect(ok('https://graph-video.facebook.com/v26.0/act_1234567890/advideos')).toMatch(/graph\.facebook\.com/)
    expect(ok('http://graph.facebook.com/v26.0/me')).toMatch(/graph\.facebook\.com/)
    expect(ok('https://graph.facebook.com/v25.0/me')).toMatch(/v26\.0/)
    expect(ok('https://graph.facebook.com/me')).toMatch(/no version/)
  })
  it('refuses a GET that is not a read: method override, batch, the Graph root, a token revoke', () => {
    expect(ok(`${BASE}/120000000000001?method=delete`)).toMatch(/"method"/)
    expect(ok(`${BASE}/120000000000001?_method=post`)).toMatch(/"_method"/)
    expect(ok(`${BASE}/?ids=1,2`)).toMatch(/Graph root/)
    expect(ok(`${BASE}/me?batch=[]`)).toMatch(/"batch"/)
    expect(ok(`${BASE}/oauth/revoke?revoke_token=x`, { auth: 'none' })).toMatch(/revoke/)
  })
  it('refuses a token the caller put on the URL: access_token and the proof are the gateway\'s', () => {
    expect(ok(`${BASE}/me?access_token=x`)).toMatch(/only the gateway sets/)
    expect(ok(`${BASE}/me?appsecret_proof=x`)).toMatch(/only the gateway sets/)
  })
  it('the only sign-in call is the system-user token renewal, exactly Meta\'s five keys once each, with no account token', () => {
    const renew = `${BASE}/oauth/access_token?grant_type=fb_exchange_token&client_id=1&client_secret=s&set_token_expires_in_60_days=true&fb_exchange_token=t`
    expect(ok(renew, { auth: 'none' })).toBeNull()
    expect(ok(renew, { auth: 'account' })).toMatch(/token renewal/)
    expect(ok(`${BASE}/oauth/access_token?grant_type=client_credentials`, { auth: 'none' })).toMatch(/token renewal/)
    expect(ok(`${renew}&client_id=2`, { auth: 'none' })).toMatch(/token renewal/)
    expect(ok(`${renew}&redirect_uri=x`, { auth: 'none' })).toMatch(/token renewal/)
    expect(ok(renew.replace('&set_token_expires_in_60_days=true', ''), { auth: 'none' })).toMatch(/token renewal/)
    expect(ok(renew.replace('grant_type=fb_exchange_token', 'grant_type=client_credentials'), { auth: 'none' })).toMatch(/token renewal/)
  })
  it('a read never brings a token back: access_token in fields (also nested), Pages without fields, a bare node without fields', () => {
    expect(ok(`${BASE}/me/accounts?fields=id,access_token`)).toMatch(/never asks Meta for an access_token/)
    expect(ok(`${BASE}/me?fields=accounts{id,access_token}`)).toMatch(/never asks Meta for an access_token/)
    expect(ok(`${BASE}/me?fields=accounts{id, access_token }`)).toMatch(/never asks Meta for an access_token/)
    expect(ok(`${BASE}/me/accounts`)).toMatch(/Pages \(accounts\) names its fields/)
    expect(ok(`${BASE}/120000000000010`)).toMatch(/names its fields/)
    expect(ok(`${BASE}/120000000000010?fields=id,name`)).toBeNull()
    expect(ok(`${BASE}/me/accounts?fields=id,name`)).toBeNull()
    expect(ok(`${BASE}/me?fields=id,access_token_expires`)).toBeNull()
  })
  it('a caller\'s own headers never travel on a Meta call', () => {
    expect(ok(`${BASE}/me?fields=id`, { headers: { 'X-HTTP-Method-Override': 'POST' } })).toMatch(/no header/)
  })
  it('the publish mode is gated: there is no switch that lets a Meta write out', () => {
    expect(publishModeOf('META')).toBe('gated')
  })
})

describe('signing and the token', () => {
  it('appsecret_proof is HMAC-SHA256 of "<token>|<time>" keyed with the app secret, hex (Meta Login Security)', () => {
    const proof = metaAppSecretProof('token-1', 'secret-1', 1760000000)
    expect(proof).toEqual({ appsecret_proof: createHmac('sha256', 'secret-1').update('token-1|1760000000').digest('hex'), appsecret_time: '1760000000' })
  })
  it('a read goes once, with the token and its proof on the URL sent — never on the URL the ledger and the answer carry', async () => {
    const res = await metaCall({ connectionId: 'm-1', operation: 'campaigns.list', path: 'act_1234567890/campaigns', query: { fields: 'id,name', effective_status: ['ACTIVE', 'PAUSED'] } })
    expect(res.status).toBe(200)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].init.method).toBe('GET')
    const sent = sentUrl()
    expect(sent.searchParams.get('access_token')).toBe('meta-system-user-token')
    expect(sent.searchParams.get('appsecret_proof')).toBe('proof-of-22')
    expect(sent.searchParams.get('appsecret_time')).toBe('1760000000')
    expect(sent.searchParams.get('effective_status')).toBe('["ACTIVE","PAUSED"]')
    expect(h.proofs).toEqual(['meta-system-user-token'])
    expect(res.url).not.toContain('access_token')
    expect(res.url).not.toContain('appsecret_proof')
    expect((h.calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined()
    expect(authHeadersOf('META', 't')).toEqual({})
    expect(gatewayLedger).toEqual([expect.objectContaining({ channel: 'META', connectionId: 'm-1', operation: 'campaigns.list', outcome: 'sent', success: true, apiVersion: 'v26.0', endpoint: 'graph.facebook.com/v26.0/act_1234567890/campaigns' })])
  })
  it('the app token (debug_token) is signed too; a caller-held token is signed with the secret it brings', async () => {
    await metaCall({ connectionId: 'm-1', operation: 'token.debug', path: 'debug_token', query: { input_token: 'x' }, auth: 'app' })
    expect(sentUrl().searchParams.get('access_token')).toBe('1234567|app-secret-for-tests')
    await metaCall({ connectionId: null, operation: 'identity.me', path: 'me', query: { fields: 'id' }, auth: { token: 'held-token', appSecret: 'held-secret' } })
    const proof = sentUrl(1).searchParams.get('appsecret_proof')
    const time = sentUrl(1).searchParams.get('appsecret_time')
    expect(proof).toBe(createHmac('sha256', 'held-secret').update(`held-token|${time}`).digest('hex'))
  })
  it('a caller-held token without its secret is held: nothing is sent unsigned', async () => {
    const err = await gatewayCall({ channel: 'META', operation: 'identity.me', kind: 'read', connectionId: null, appLevel: true, url: metaUrl('me'), method: 'GET', auth: { token: 'held-token' } }).catch((e) => e)
    expect(err).toBeInstanceOf(GatewayRefusal)
    expect(err).toMatchObject({ outcome: 'held', code: 'META_APP_SECRET_UNAVAILABLE' })
    expect(h.calls).toHaveLength(0)
  })
  it('the token renewal goes with no account token at all, and only for the connection\'s own app', async () => {
    const renewal = (clientId: string) => metaUrl('oauth/access_token', { grant_type: 'fb_exchange_token', client_id: clientId, client_secret: 's', set_token_expires_in_60_days: 'true', fb_exchange_token: 't' })
    await gatewayCall({ channel: 'META', operation: 'token.renew', kind: 'read', connectionId: 'm-1', url: renewal('1234567'), method: 'GET', auth: 'none' })
    expect(sentUrl().searchParams.get('access_token')).toBeNull()
    expect(sentUrl().searchParams.get('appsecret_proof')).toBeNull()
    const err = await gatewayCall({ channel: 'META', operation: 'token.renew', kind: 'read', connectionId: 'm-1', url: renewal('7654321'), method: 'GET', auth: 'none' }).catch((e) => e)
    expect(err).toMatchObject({ code: 'META_READ_ONLY', message: expect.stringMatching(/connection's own Meta app/) })
    expect(h.calls).toHaveLength(1)
  })
  it('metaSendUrl only adds the three parameters', () => {
    expect(metaSendUrl(`${BASE}/me?fields=id`, 't', { appsecret_proof: 'p', appsecret_time: '1' })).toBe(`${BASE}/me?fields=id&access_token=t&appsecret_proof=p&appsecret_time=1`)
  })
})

describe('refusals send nothing and have their ledger row', () => {
  it('a POST through the gateway is refused META_READ_ONLY, before the token or the network', async () => {
    const err = await gatewayCall({ channel: 'META', operation: 'campaigns.create', kind: 'write', connectionId: 'm-1', url: `${BASE}/act_1234567890/campaigns`, method: 'POST', body: '{"name":"Shop A"}' }).catch((e) => e)
    expect(err).toBeInstanceOf(GatewayRefusal)
    expect(err).toMatchObject({ outcome: 'refused', code: 'META_READ_ONLY', statusCode: 403 })
    expect(h.calls).toHaveLength(0)
    expect(h.proofs).toHaveLength(0)
    expect(gatewayLedger).toEqual([expect.objectContaining({ channel: 'META', outcome: 'refused', errorCode: 'META_READ_ONLY' })])
  })
  it('a GET declared a write is refused too (the declared kind and the call itself must both read)', async () => {
    const err = await gatewayCall({ channel: 'META', operation: 'x', kind: 'write', connectionId: 'm-1', url: `${BASE}/me`, method: 'GET' }).catch((e) => e)
    expect(err).toMatchObject({ code: 'META_READ_ONLY' })
    expect(h.calls).toHaveLength(0)
  })
})

describe('rate limits', () => {
  it('a bucket per kind of call: insights and the sign-in apart from the rest', () => {
    expect(metaCallGroup(`${BASE}/act_1234567890/insights?level=campaign`)).toBe('insights')
    expect(metaCallGroup(`${BASE}/debug_token?input_token=x`)).toBe('auth')
    expect(metaCallGroup(`${BASE}/oauth/access_token`)).toBe('auth')
    expect(metaCallGroup(`${BASE}/act_1234567890/campaigns`)).toBe('ads')
    expect(bucketGroupOf('META', 'GET', `${BASE}/120000000000001/insights`)).toBe('insights')
    expect(defaultsFor('META', bucketKey('META', 'm-1', 'insights'))).toEqual(META_BUCKETS.insights)
    expect(defaultsFor('META', bucketKey('META', 'm-1', 'ads'))).toEqual(META_BUCKETS.ads)
  })
  it('reads the usage headers: the highest percent as headroom; back off at 75 % for the reset Meta names', () => {
    const headers = new Headers({
      'x-business-use-case-usage': JSON.stringify({ '9876543210': [{ type: 'ads_management', call_count: 20, total_cputime: 12, total_time: 30, estimated_time_to_regain_access: 0, ads_api_access_tier: 'development_access' }] }),
      'x-ad-account-usage': JSON.stringify({ acc_id_util_pct: 80, reset_time_duration: 120, ads_api_access_tier: 'development_access' }),
    })
    expect(metaRateReading(headers, 200)).toEqual({ model: 'points', remaining: 20, limit: 100, retryAfterSec: 120, tier: 'development_access' })
    expect(metaRateReading(new Headers({ 'x-app-usage': '{"call_count":5,"total_cputime":1,"total_time":2}' }), 200)).toEqual({ model: 'points', remaining: 95, limit: 100 })
    expect(metaRateReading(new Headers(), 200)).toBeNull()
  })
  it('while Meta says access is blocked, the bucket is held for that many minutes', () => {
    const headers = new Headers({ 'x-business-use-case': JSON.stringify({ '1': [{ type: 'ads_insights', call_count: 100, total_cputime: 40, total_time: 50, estimated_time_to_regain_access: 7 }] }) })
    expect(metaRateReading(headers, 400)).toMatchObject({ retryAfterSec: 420, remaining: 0 })
  })
  it('a held bucket refuses the next call RATE_LIMITED_LOCAL without sending it (Meta asks callers to stop)', async () => {
    h.answers.push(() => new Response('{"data":[]}', { status: 200, headers: { 'x-ad-account-usage': '{"acc_id_util_pct":90,"reset_time_duration":300}' } }))
    await metaCall({ connectionId: 'm-1', operation: 'campaigns.list', path: 'act_1234567890/campaigns' })
    const err = await gatewayCall({ channel: 'META', operation: 'campaigns.list', kind: 'read', connectionId: 'm-1', url: metaUrl('act_1234567890/campaigns'), method: 'GET', maxRateWaitMs: 10 }).catch((e) => e)
    expect(err).toMatchObject({ code: 'RATE_LIMITED_LOCAL' })
    expect(h.calls).toHaveLength(1)
  })
  it('a throttle answer with no usage header still holds the bucket: 300 s, an hour for ad-set budget changes', async () => {
    h.answers.push(() => new Response(JSON.stringify({ error: { code: 17, error_subcode: 2446079, message: 'User request limit reached' } }), { status: 400 }))
    await metaCall({ connectionId: 'm-2', operation: 'campaigns.list', path: 'act_1234567890/campaigns', query: { fields: 'id' } })
    const held = await takeToken('META', bucketKey('META', 'm-2', 'ads'), 0)
    expect(held.ok).toBe(false)
    expect(held.waitMs).toBeGreaterThan(290_000)
    expect(held.waitMs).toBeLessThanOrEqual(300_000)
    h.answers.push(() => new Response(JSON.stringify({ error: { code: 613, error_subcode: 1487632 } }), { status: 400 }))
    await metaCall({ connectionId: 'm-3', operation: 'adsets.list', path: 'act_1234567890/adsets', query: { fields: 'id' } })
    expect((await takeToken('META', bucketKey('META', 'm-3', 'ads'), 0)).waitMs).toBeGreaterThan(3_500_000)
  })
  it('the Full tier, as the headers name it, sizes the bucket up; Limited sizes it back', async () => {
    const key = bucketKey('META', 'm-4', 'ads')
    await observeRate('META', key, { tier: 'standard_access' })
    const full = await takeToken('META', key, 0)
    expect(full.tokensLeft).toBe(META_FULL_BUCKETS.ads.capacity - 1)
    expect(META_BUCKETS.ads).toEqual({ capacity: 45, refillPerSec: 0.08 })
  })
  it('a dead token answer makes the next heartbeat check the token again at once', async () => {
    h.answers.push(() => new Response(JSON.stringify({ error: { code: 190, error_subcode: 460, message: 'Password changed' } }), { status: 400 }))
    await metaCall({ connectionId: 'm-5', operation: 'campaigns.list', path: 'act_1234567890/campaigns', query: { fields: 'id' } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(h.forgotten).toEqual(['m-5'])
  })
  it('spells out the usage for a person (meta-connection view check)', () => {
    const usage = metaUsageOf(new Headers({
      'x-ad-account-usage': '{"acc_id_util_pct":9.5,"reset_time_duration":0,"ads_api_access_tier":"standard_access"}',
      'x-ad-api-version-warning': 'The call was upgraded to v26.0',
    }))
    expect(usage).toMatchObject({ adAccount: { usedPct: 9.5, resetSeconds: 0, tier: 'standard_access' }, tier: 'standard_access', versionWarning: 'The call was upgraded to v26.0', businessUseCase: [] })
  })
})

describe('Graph error codes (developers.facebook.com/docs/graph-api/guides/error-handling)', () => {
  const body = (code: number, subcode?: number, message = 'm') => JSON.stringify({ error: { message, type: 'OAuthException', code, ...(subcode ? { error_subcode: subcode } : {}), fbtrace_id: 'x' } })
  it('the token: 190/463 expired, any other 190 revoked; both need a new token', () => {
    expect(classifyChannelAnswer('META', 400, body(190, 463))).toMatchObject({ errorClass: 'auth_expired', channelCode: '190/463' })
    expect(classifyChannelAnswer('META', 400, body(190, 460))).toMatchObject({ errorClass: 'auth_revoked', channelCode: '190/460' })
    expect(classifyChannelAnswer('META', 401, body(190))).toMatchObject({ errorClass: 'auth_revoked', channelCode: '190' })
  })
  it('rate limits: 4, 17, 32, 613 and 80000–80014, whatever the HTTP status', () => {
    for (const code of [4, 17, 32, 613, 80000, 80004, 80014]) expect(classifyChannelAnswer('META', 400, body(code)).errorClass, String(code)).toBe('rate_limited')
    expect(classifyChannelAnswer('META', 400, body(613, 1487632))).toMatchObject({ errorClass: 'rate_limited', channelCode: '613/1487632', retryable: true })
  })
  it('permissions, parameters, a missing object, an old version, Meta unwell', () => {
    expect(classifyChannelAnswer('META', 403, body(10)).errorClass).toBe('forbidden')
    expect(classifyChannelAnswer('META', 400, body(200)).errorClass).toBe('forbidden')
    expect(classifyChannelAnswer('META', 400, body(100)).errorClass).toBe('validation')
    expect(classifyChannelAnswer('META', 400, body(100, 33)).errorClass).toBe('not_found')
    expect(classifyChannelAnswer('META', 400, body(2635)).errorClass).toBe('configuration')
    expect(classifyChannelAnswer('META', 500, body(2)).errorClass).toBe('transient')
    expect(classifyChannelAnswer('META', 503, 'not json').errorClass).toBe('transient')
  })
  it('a person reads Meta\'s own title and message first, with the trace id Meta support asks for and the field it blames', () => {
    const text = JSON.stringify({ error: { message: 'Invalid parameter', code: 100, error_user_title: 'Budget too low', error_user_msg: 'The budget is too low.', fbtrace_id: 'Abc123', error_data: { blame_field_specs: [['daily_budget']] } } })
    expect(classifyChannelAnswer('META', 400, text)).toMatchObject({ errorClass: 'validation', channelMessage: 'Budget too low: The budget is too low. (Meta trace Abc123)', attribute: 'daily_budget' })
  })
  it('100/33 says "not found or no access"; a negative code routes on its subcode; is_transient is transient', () => {
    expect(classifyChannelAnswer('META', 400, body(100, 33, 'Unsupported get request')).channelMessage).toMatch(/^Not found or no access \(is the system user assigned to it\?\)/)
    expect(classifyChannelAnswer('META', 400, body(-1, 613))).toMatchObject({ errorClass: 'rate_limited', channelCode: '-1/613' })
    expect(classifyChannelAnswer('META', 500, body(-2)).errorClass).toBe('transient')
    expect(classifyChannelAnswer('META', 400, JSON.stringify({ error: { code: 100, is_transient: true } })).errorClass).toBe('transient')
  })
})

describe('the ledger never keeps a Meta secret', () => {
  it('masks the token, the proof, the renewed token and the inspected token in a text body', () => {
    const safe = ledgerSafeBody('access_token=a&appsecret_proof=b&fb_exchange_token=c&input_token=d&client_secret=e&fields=id') as string
    expect(safe).toBe('access_token=[redacted]&appsecret_proof=[redacted]&fb_exchange_token=[redacted]&input_token=[redacted]&client_secret=[redacted]&fields=id')
  })
})
