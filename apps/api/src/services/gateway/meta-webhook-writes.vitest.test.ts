/**
 * Meta step 30 part 2 on the gateway: the webhook and alert-subscription changes reach Meta only on their EXACT
 * allow-list entries — the connection's OWN app with its app token (by the rule, as step 36's Page token: never at a
 * caller's ask), the callback exactly Nexus's receiver, the verify
 * token added by the gateway (never a caller's, never on the ledger), a DELETE always naming its object, the CHOSEN ad
 * account and Page only, every alert condition judged — and nothing else changes for the older rules. Made-up ids only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, answers: [] as Array<() => Response>, appId: '1234567' as string | null }))
vi.mock('./account.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('./ledger.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../cx/token.service.js', () => ({
  getAccessToken: vi.fn(async () => 'meta-system-user-token'),
  metaAppAccessToken: vi.fn(async () => '1234567|app-secret-for-tests'),
  metaAppIdOf: vi.fn(async () => h.appId),
  metaRenewalToken: vi.fn(async () => 'stored-meta-token'),
  metaRequestProof: vi.fn(async () => ({ appsecret_proof: 'proof', appsecret_time: '1760000000' })),
}))
vi.mock('../cx/deprecation-watch.service.js', () => ({ watchForDeprecation: vi.fn(async () => undefined) }))
vi.mock('../cx/connectors/meta/token-check.js', () => ({ forgetMetaTokenCheck: vi.fn(async () => undefined) }))

import { gatewayLedger, gatewayMetaChosen, gatewayMetaPage } from '../../test-support/gateway-stubs.js'
import { __rateTest } from './rate.js'
import { metaCall, metaWriteCall } from './meta.js'
import { metaWriteVerdict } from './meta-calls.js'
import { alertFiltersProblem, alertValueProblem, META_WEBHOOK_FIELDS } from './meta-webhook-rules.js'
import { META_WEBHOOK_TOPICS } from '../marketing/meta-ads/webhook-topics.js'
import { __metaObjectLimitsTest } from './meta-object-limits.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../meta/api-version.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const APP = '1234567'
const ACT = 'act_1234567890'
const PAGE = '120000000000010'
const CALLBACK = 'https://api.example.test/webhooks/meta/1234567'
const form = (o: Record<string, string>) => new URLSearchParams(o).toString()
const verdict = (input: { url: string; body?: unknown; objectKind?: string; method?: string; auth?: unknown; kind?: string }) =>
  metaWriteVerdict({ method: input.method ?? 'POST', url: input.url, kind: input.kind ?? 'write', body: input.body, objectKind: input.objectKind, auth: input.auth })
const problem = (input: Parameters<typeof verdict>[0]) => { const v = verdict(input); return 'problem' in v ? v.problem : null }
const subscribe = (o: Record<string, string>, auth?: unknown) => problem({ url: `${BASE}/${APP}/subscriptions`, body: form(o), objectKind: 'app', auth })
const SUB = { object: 'ad_account', callback_url: CALLBACK, fields: 'effective_status,with_issues_ad_objects', include_values: 'true' }
const filters = (extra: unknown[] = []) => JSON.stringify([{ field: 'entity_type', value: 'AD', operator: 'EQUAL' }, ...extra])
const alert = (o: Record<string, string>) => problem({ url: `${BASE}/${ACT}/subscriptions`, body: form(o), objectKind: 'adaccount' })
/** Meta's one change of an object every 30 s holds a second change of the same object: each send here is its own moment. */
const nextMoment = () => __metaObjectLimitsTest.useMemory()

beforeEach(() => {
  __rateTest.useMemory()
  __metaObjectLimitsTest.useMemory()
  h.calls = []; h.answers = []; h.appId = APP; gatewayLedger.length = 0
  for (const key of Object.keys(gatewayMetaChosen)) delete gatewayMetaChosen[key]
  for (const key of Object.keys(gatewayMetaPage)) delete gatewayMetaPage[key]
  vi.stubEnv('NEXUS_META_ADS_WRITES', 'on')
  vi.stubEnv('NEXUS_PUBLIC_API_URL', 'https://api.example.test')
  vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN', 'a-long-verify-token-for-tests')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response(JSON.stringify({ success: true }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset(); __metaObjectLimitsTest.reset() })

describe('the app subscription (POST / DELETE /<app>/subscriptions)', () => {
  it('with the app token by its rule, Nexus\'s own callback for that app, include_values on, fields Nexus\'s receiver takes', () => {
    const v = verdict({ url: `${BASE}/${APP}/subscriptions`, body: form(SUB), objectKind: 'app' })
    expect(v).toMatchObject({ write: { rule: 'app.subscriptions', objectId: APP, auth: 'app', verifyToken: true, appId: APP } })
    // The token is the rule's (step 36's model): a caller never asks for one, the app's nor a Page's.
    expect(subscribe(SUB, 'app')).toMatch(/only with the account's own system-user token/)
    expect(subscribe(SUB, 'page')).toMatch(/only with the account's own system-user token/)
    expect(subscribe({ ...SUB, callback_url: 'https://elsewhere.example/hook' })).toMatch(/exactly Nexus's own Meta receiver/)
    expect(subscribe({ ...SUB, callback_url: 'https://api.example.test/webhooks/meta/7654321' })).toMatch(/exactly Nexus's own Meta receiver/)
    expect(subscribe({ ...SUB, include_values: 'false' })).toMatch(/include_values is true/)
    expect(subscribe({ ...SUB, fields: 'effective_status,photos' })).toMatch(/the ad_account fields are only/)
    expect(subscribe({ ...SUB, fields: 'effective_status,effective_status' })).toMatch(/each field once/)
    expect(subscribe({ ...SUB, object: 'instagram', fields: 'comments' })).toMatch(/Instagram and WhatsApp only in Meta's App Dashboard/)
    // A caller never names the verify token (the gateway adds the server's own), nor mTLS or anything else.
    expect(subscribe({ ...SUB, verify_token: 'mine' })).toMatch(/which no Nexus change sends/)
    expect(subscribe({ ...SUB, include_client_certificate: 'true' })).toMatch(/the only Meta change Nexus sends/)
    // Review A4 — own keys only: never an object (or field) named after Object's own properties.
    for (const object of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) expect(subscribe({ ...SUB, object })).toMatch(/^object is ad_account/)
    expect(problem({ url: `${BASE}/${APP}/subscriptions?object=constructor`, method: 'DELETE', objectKind: 'app' })).toMatch(/would remove every subscription/)
    vi.stubEnv('NEXUS_PUBLIC_API_URL', '')
    vi.stubEnv('PUBLIC_API_URL', '')
    vi.stubEnv('RAILWAY_PUBLIC_DOMAIN', '')
    expect(subscribe(SUB)).toMatch(/Nexus has no callback to give Meta/)
  })

  it('a DELETE names its object (Meta would otherwise remove every subscription), in the query, with the app token', () => {
    expect(verdict({ url: `${BASE}/${APP}/subscriptions?object=page`, method: 'DELETE', objectKind: 'app' })).toMatchObject({ write: { rule: 'app.subscriptions.delete', method: 'DELETE', body: '', auth: 'app', appId: APP } })
    expect(verdict({ url: `${BASE}/${APP}/subscriptions?object=page&fields=leadgen,feed`, method: 'DELETE', objectKind: 'app' })).toHaveProperty('write')
    expect(problem({ url: `${BASE}/${APP}/subscriptions`, method: 'DELETE', objectKind: 'app' })).toMatch(/takes object, fields/)
    expect(problem({ url: `${BASE}/${APP}/subscriptions?object=user`, method: 'DELETE', objectKind: 'app' })).toMatch(/would remove every subscription/)
    expect(problem({ url: `${BASE}/${APP}/subscriptions?object=page&object=catalog`, method: 'DELETE', objectKind: 'app' })).toMatch(/each parameter once/)
    // Its keys ride in the query only: never as a form body (main's keyed DELETE), nor in both.
    expect(problem({ url: `${BASE}/${APP}/subscriptions?object=page`, method: 'DELETE', objectKind: 'app', body: 'object=page' })).toMatch(/in the URL's query, never in a body/)
    expect(problem({ url: `${BASE}/${APP}/subscriptions`, method: 'DELETE', objectKind: 'app', body: 'object=page' })).toMatch(/in the URL's query, never in a body/)
    expect(problem({ url: `${BASE}/${APP}/subscriptions?object=page`, method: 'DELETE', objectKind: 'app', auth: 'app' })).toMatch(/only with the account's own system-user token/)
    expect(problem({ url: `${BASE}/${APP}/subscriptions?object=page&access_token=x`, method: 'DELETE', objectKind: 'app' })).toMatch(/takes object, fields/)
    expect(problem({ url: `${BASE}/${APP}/subscriptions?object=page`, method: 'DELETE', objectKind: 'app', kind: 'read' })).toMatch(/goes as a write/)
  })

  it('a query is judged ONLY on a DELETE rule made for one: every other call with a query is refused', () => {
    // Main's bare DELETE (a budget schedule's), main's keyed DELETE (an image's hash as the body), a POST, a PATCH.
    expect(problem({ url: `${BASE}/120000000000020?object=page`, method: 'DELETE', objectKind: 'highdemandperiod' })).toMatch(/never in the URL/)
    expect(problem({ url: `${BASE}/${ACT}/adimages?hash=abc`, method: 'DELETE', objectKind: 'adaccount' })).toMatch(/never in the URL/)
    expect(problem({ url: `${BASE}/${ACT}/adimages?hash=abc`, method: 'DELETE', objectKind: 'adaccount', body: 'hash=abc' })).toMatch(/never in the URL/)
    expect(problem({ url: `${BASE}/${APP}/subscriptions?object=page`, body: form(SUB), objectKind: 'app' })).toMatch(/never in the URL/)
    expect(problem({ url: `${BASE}/${ACT}/subscriptions/120000000000040?status=DISABLED`, method: 'PATCH', body: form({ status: 'DISABLED' }), objectKind: 'adaccount' })).toMatch(/never in the URL/)
    // The query rules are kind-bound: the app's path named another kind is no app subscription.
    expect(problem({ url: `${BASE}/${APP}/subscriptions?object=page`, method: 'DELETE', objectKind: 'campaign' })).toMatch(/never in the URL/)
    // The ad account's connected app: app_id in the query, never a body; a form body on its DELETE is refused.
    expect(verdict({ url: `${BASE}/${ACT}/subscribed_apps?app_id=${APP}`, method: 'DELETE', objectKind: 'adaccount' })).toMatchObject({ write: { rule: 'adaccount.subscribed_apps.delete', appId: APP } })
    expect(problem({ url: `${BASE}/${ACT}/subscribed_apps`, method: 'DELETE', objectKind: 'adaccount', body: `app_id=${APP}` })).toMatch(/in the URL's query, never in a body/)
  })

  it('every field Nexus subscribes is a topic its receiver knows, and every topic it acts on can be subscribed', () => {
    for (const [object, fields] of Object.entries(META_WEBHOOK_FIELDS)) {
      for (const field of fields) expect(Object.keys(META_WEBHOOK_TOPICS), `${object}.${field}`).toContain(object === 'ad_account' && field === 'effective_status' ? 'ad_account.effective_status' : `${object}.${field}`)
    }
    for (const topic of Object.keys(META_WEBHOOK_TOPICS).filter((t) => !t.startsWith('instagram.') && t !== 'ad_account.field_changed')) {
      const [object, field] = topic.split('.')
      expect(META_WEBHOOK_FIELDS[object], topic).toContain(field)
    }
  })

  it('on the wire: the app token, the verify token added from the server (never on the ledger); none set → held, nothing sent', async () => {
    const res = await metaWriteCall({ connectionId: 'm-1', operation: 'webhooks.subscribeApp', objectId: APP, objectKind: 'app', edge: 'subscriptions', params: SUB, check: false })
    expect(res.ok).toBe(true)
    const sent = h.calls[0]
    expect(sent.init.method).toBe('POST')
    expect(new URL(sent.url).searchParams.get('access_token')).toBe('1234567|app-secret-for-tests')
    expect(new URLSearchParams(String(sent.init.body)).get('verify_token')).toBe('a-long-verify-token-for-tests')
    expect(JSON.stringify(gatewayLedger)).not.toContain('a-long-verify-token-for-tests')
    vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN', '')
    h.calls = []
    await expect(metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: APP, objectKind: 'app', edge: 'subscriptions', params: SUB, check: false })).rejects.toMatchObject({ code: 'META_VERIFY_TOKEN_UNSET' })
    expect(h.calls).toEqual([])
  })

  it('another app than the connection\'s own: nothing sent', async () => {
    h.appId = '7654321'
    await expect(metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: APP, objectKind: 'app', edge: 'subscriptions', params: SUB, check: false })).rejects.toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    expect(h.calls).toEqual([])
  })
})

describe('the chosen ad account\'s connected app and the chosen Page', () => {
  it('connect and disconnect only the connection\'s own app on the CHOSEN ad account; a DELETE carries app_id in the query', async () => {
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'adaccount', edge: 'subscribed_apps', params: { app_id: APP }, check: false })).ok).toBe(true)
    expect(String(h.calls[0].init.body)).toBe('app_id=1234567')
    nextMoment()
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'adaccount', edge: 'subscribed_apps', params: {}, query: { app_id: APP }, method: 'DELETE', check: false })).ok).toBe(true)
    expect([h.calls[1].init.method, new URL(h.calls[1].url).pathname, new URL(h.calls[1].url).searchParams.get('app_id'), String(h.calls[1].init.body ?? '')]).toEqual(['DELETE', `/v26.0/${ACT}/subscribed_apps`, APP, ''])
    // The ad account's connected app goes with the account's system-user token (its rule names no other).
    expect(new URL(h.calls[1].url).searchParams.get('access_token')).toBe('meta-system-user-token')
    nextMoment()
    await expect(metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'adaccount', edge: 'subscribed_apps', params: { app_id: '7654321' }, check: false })).rejects.toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    await expect(metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: 'act_5555555555', objectKind: 'adaccount', edge: 'subscribed_apps', params: { app_id: APP }, check: false })).rejects.toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    // The same route named another kind, or the account's edge with a campaign's kind: refused before anything.
    expect(problem({ url: `${BASE}/${ACT}/subscribed_apps`, body: form({ app_id: APP }), objectKind: 'campaign' })).toMatch(/the only Meta change Nexus sends/)
    expect(h.calls).toHaveLength(2)
  })

  it('the CHOSEN Page: the app removed with the app token; another Page never', async () => {
    gatewayMetaPage['m-1'] = PAGE
    // The removal is the app's (its rule's token), never the Page's: step 36's Page token goes only on a rule marked `page`.
    expect(verdict({ url: `${BASE}/${PAGE}/subscribed_apps`, method: 'DELETE', objectKind: 'page' })).toMatchObject({ write: { rule: 'page.subscribed_apps.delete', auth: 'app' } })
    expect(problem({ url: `${BASE}/${PAGE}/subscribed_apps`, method: 'DELETE', objectKind: 'page', auth: 'page' })).toMatch(/only with the account's own system-user token/)
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: PAGE, objectKind: 'page', edge: 'subscribed_apps', params: {}, method: 'DELETE', check: false })).ok).toBe(true)
    expect(new URL(h.calls[0].url).searchParams.get('access_token')).toBe('1234567|app-secret-for-tests')
    nextMoment()
    gatewayMetaPage['m-1'] = '120000000000011'
    await expect(metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: PAGE, objectKind: 'page', edge: 'subscribed_apps', params: {}, method: 'DELETE', check: false })).rejects.toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    delete gatewayMetaPage['m-1']
    await expect(metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: PAGE, objectKind: 'page', edge: 'subscribed_apps', params: {}, method: 'DELETE', check: false })).rejects.toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    expect(h.calls).toHaveLength(1)
  })
})

describe('part 3 — the app installed on the CHOSEN Page with the Page\'s own token (step 36\'s mode)', () => {
  const PAGE_TOKEN = 'EAAPageTokenForTests1234567890'
  const pageToken = () => new Response(JSON.stringify({ id: PAGE, access_token: PAGE_TOKEN }), { status: 200 })
  const install = (fields: string, extra: Record<string, unknown> = {}) => metaWriteCall({ connectionId: 'm-1', operation: 'webhooks.installPage', objectId: PAGE, objectKind: 'page', edge: 'subscribed_apps', params: { subscribed_fields: fields }, check: false, ...extra })

  it('the rule: POST subscribed_fields (the receiver\'s Page fields, each once) by the rule\'s Page token, never a caller\'s ask', () => {
    expect(verdict({ url: `${BASE}/${PAGE}/subscribed_apps`, body: form({ subscribed_fields: 'leadgen,feed' }), objectKind: 'page' })).toMatchObject({ write: { rule: 'page.subscribed_apps', objectId: PAGE, auth: 'page', kinds: ['page'], edgeCall: true } })
    expect(problem({ url: `${BASE}/${PAGE}/subscribed_apps`, body: form({ subscribed_fields: 'leadgen,ratings' }), objectKind: 'page' })).toMatch(/the Page's subscribed fields are only/)
    expect(problem({ url: `${BASE}/${PAGE}/subscribed_apps`, body: form({ subscribed_fields: 'leadgen,leadgen' }), objectKind: 'page' })).toMatch(/each field once/)
    expect(problem({ url: `${BASE}/${PAGE}/subscribed_apps`, body: form({ subscribed_fields: 'leadgen' }), objectKind: 'page', auth: 'page' })).toMatch(/only with the account's own system-user token/)
    expect(problem({ url: `${BASE}/${PAGE}/subscribed_apps`, body: form({ subscribed_fields: 'leadgen' }), objectKind: 'campaign' })).toMatch(/the only Meta change Nexus sends/)
    expect(problem({ url: `${BASE}/${PAGE}/subscribed_apps`, body: form({ subscribed_fields: 'leadgen', access_token: 'x' }), objectKind: 'page' })).toMatch(/which no Nexus change sends/)
    expect(problem({ url: `${BASE}/${PAGE}/subscribed_apps?subscribed_fields=leadgen`, body: form({ subscribed_fields: 'leadgen' }), objectKind: 'page' })).toMatch(/never in the URL/)
  })

  it('on the wire: the gateway reads the CHOSEN Page\'s token, then sends the install with it (never the system user\'s, never the app\'s)', async () => {
    gatewayMetaPage['m-1'] = PAGE
    h.answers.push(pageToken)
    expect((await install('leadgen,feed')).ok).toBe(true)
    expect(h.calls).toHaveLength(2)
    expect([new URL(h.calls[0].url).pathname, new URL(h.calls[0].url).searchParams.get('fields'), new URL(h.calls[0].url).searchParams.get('access_token')]).toEqual([`/v26.0/${PAGE}`, 'access_token', 'meta-system-user-token'])
    const sent = h.calls[1]
    expect([sent.init.method, new URL(sent.url).pathname, new URL(sent.url).searchParams.get('access_token'), String(sent.init.body)]).toEqual(['POST', `/v26.0/${PAGE}/subscribed_apps`, PAGE_TOKEN, 'subscribed_fields=leadgen%2Cfeed'])
    expect(JSON.stringify(gatewayLedger)).not.toContain(PAGE_TOKEN)
    // An edge of the Page: no 30-s gap holds the next one (the undo's DELETE right after).
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: PAGE, objectKind: 'page', edge: 'subscribed_apps', params: {}, method: 'DELETE', check: false })).ok).toBe(true)
    expect(new URL(h.calls[2].url).searchParams.get('access_token')).toBe('1234567|app-secret-for-tests')
  })

  it('another Page, no Page chosen, Meta changes switched off, or no Page token from Meta: nothing sent', async () => {
    gatewayMetaPage['m-1'] = '120000000000011'
    await expect(install('leadgen')).rejects.toMatchObject({ code: 'META_PAGE_NOT_CHOSEN' })
    delete gatewayMetaPage['m-1']
    await expect(install('leadgen')).rejects.toMatchObject({ code: 'META_PAGE_NOT_CHOSEN' })
    expect(h.calls).toHaveLength(0)
    gatewayMetaPage['m-1'] = PAGE
    h.answers.push(() => new Response(JSON.stringify({ id: PAGE }), { status: 200 }))
    await expect(install('leadgen')).rejects.toMatchObject({ code: 'META_PAGE_TOKEN_UNAVAILABLE', message: expect.stringMatching(/the app installed on the Page and its connected apps read \(set-meta-webhooks\): Manage, Create content or Moderate/) })
    expect(h.calls).toHaveLength(1)
    vi.stubEnv('NEXUS_META_ADS_WRITES', 'off')
    await expect(install('leadgen')).rejects.toMatchObject({ code: 'PUBLISH_GATED' })
    expect(h.calls).toHaveLength(1)
  })

  it('the ONE Page-token read: the chosen Page\'s connected apps, with id, name, subscribed_fields only; the token never in the answer', async () => {
    gatewayMetaPage['m-1'] = PAGE
    h.answers.push(pageToken, () => new Response(JSON.stringify({ data: [{ id: APP, name: 'Nexus', subscribed_fields: ['leadgen'], echo: PAGE_TOKEN }] }), { status: 200 }))
    const read = await metaCall({ connectionId: 'm-1', operation: 'webhooks.setup.pageApps', path: `${PAGE}/subscribed_apps`, query: { fields: 'id,subscribed_fields', limit: 100 } })
    expect(read.ok).toBe(true)
    expect(new URL(h.calls[1].url).searchParams.get('access_token')).toBe(PAGE_TOKEN)
    expect(read.text).not.toContain(PAGE_TOKEN)
    h.calls = []
    for (const query of [{ fields: 'id,access_token' }, { fields: 'id', summary: 'true' }, {}] as Array<Record<string, string>>) {
      await expect(metaCall({ connectionId: 'm-1', operation: 'x', path: `${PAGE}/subscribed_apps`, query })).rejects.toMatchObject({ code: 'META_READ_ONLY' })
    }
    await expect(metaCall({ connectionId: 'm-1', operation: 'x', path: `${PAGE}/subscribed_apps`, query: { fields: 'id' }, auth: 'app' })).rejects.toMatchObject({ code: 'META_READ_ONLY' })
    await expect(metaCall({ connectionId: 'm-1', operation: 'x', path: '120000000000011/subscribed_apps', query: { fields: 'id' } })).rejects.toMatchObject({ code: 'META_PAGE_NOT_CHOSEN' })
    expect(h.calls).toHaveLength(0)
    // An ad account's connected apps stay a read with the system-user token.
    h.answers.push(() => new Response(JSON.stringify({ data: [] }), { status: 200 }))
    expect((await metaCall({ connectionId: 'm-1', operation: 'x', path: `${ACT}/subscribed_apps`, query: { fields: 'app_id,app_name' } })).ok).toBe(true)
    expect(new URL(h.calls[0].url).searchParams.get('access_token')).toBe('meta-system-user-token')
  })
})

describe('alert subscriptions (act_<id>/subscriptions)', () => {
  it('create: each event type with its own condition; money in minor units; ranges and lists as JSON in one spelling', () => {
    expect(alert({ event_type: 'OBJECT_CREATED', filters: filters() })).toBeNull()
    expect(alert({ event_type: 'OBJECT_CREATED', filters: filters(), field: 'name' })).toMatch(/takes no field/)
    expect(alert({ event_type: 'INSIGHTS_UPDATED', filters: filters(), field: 'cpc', operator: 'GREATER_THAN', value: '200' })).toBeNull()
    expect(alert({ event_type: 'INSIGHTS_UPDATED', filters: filters(), field: 'cpc', operator: 'GREATER_THAN', value: '2.5' })).toMatch(/minor unit, a whole number/)
    expect(alert({ event_type: 'INSIGHTS_UPDATED', filters: filters(), field: 'ctr', operator: 'IN_RANGE', value: '["1.5","3"]' })).toBeNull()
    expect(alert({ event_type: 'INSIGHTS_UPDATED', filters: filters(), field: 'ctr', operator: 'IN_RANGE', value: '["3","1.5"]' })).toMatch(/low then high/)
    expect(alert({ event_type: 'INSIGHTS_UPDATED', filters: filters(), field: 'ctr', operator: 'IN_RANGE', value: '[ "1","3"]' })).toMatch(/one spelling/)
    expect(alert({ event_type: 'INSIGHTS_UPDATED', filters: filters(), field: 'name', operator: 'EQUAL', value: 'x' })).toMatch(/not a field INSIGHTS_UPDATED watches/)
    const level = (entity: string) => JSON.stringify([{ field: 'entity_type', value: entity, operator: 'EQUAL' }])
    expect(alert({ event_type: 'OBJECT_UPDATED', filters: level('ADSET'), field: 'daily_budget' })).toBeNull()
    expect(alert({ event_type: 'OBJECT_UPDATED', filters: level('CAMPAIGN'), field: 'objective', operator: 'IN', value: '["OUTCOME_SALES"]' })).toBeNull()
    expect(alert({ event_type: 'OBJECT_UPDATED', filters: level('CAMPAIGN'), field: 'objective', operator: 'GREATER_THAN', value: '1' })).toMatch(/objective takes IN, NOT_IN/)
    // Review B5 — a setting of the level the alert watches (Meta's table), and a milestone a whole number.
    expect(alert({ event_type: 'OBJECT_UPDATED', filters: level('CAMPAIGN'), field: 'daily_budget' })).toMatch(/daily_budget is a setting of an ad set \(not of a campaign\)/)
    expect(alert({ event_type: 'OBJECT_UPDATED', filters: level('AD'), field: 'objective', operator: 'IN', value: '["OUTCOME_SALES"]' })).toMatch(/objective is a setting of a campaign \(not of an ad\)/)
    expect(alert({ event_type: 'OBJECT_UPDATED', filters: level('AD'), field: 'bid_amount', operator: 'GREATER_THAN', value: '150' })).toBeNull()
    expect(alert({ event_type: 'OBJECT_UPDATED', filters: level('AD'), field: 'constructor' })).toMatch(/not a field OBJECT_UPDATED watches/)
    expect(alert({ event_type: 'INSIGHTS_MILESTONE_REACHED', filters: filters(), field: 'impressions', operator: 'EQUAL', value: '500' })).toMatch(/at least 1000/)
    expect(alert({ event_type: 'INSIGHTS_MILESTONE_REACHED', filters: filters(), field: 'impressions', operator: 'EQUAL', value: '1500.5' })).toMatch(/a whole number/)
    expect(alert({ event_type: 'INSIGHTS_MILESTONE_REACHED', filters: filters(), field: 'toString', operator: 'EQUAL', value: '1000' })).toMatch(/not a field INSIGHTS_MILESTONE_REACHED watches/)
    expect(alert({ event_type: 'INSIGHTS_MILESTONE_REACHED', filters: filters(), field: 'spent', operator: 'EQUAL', value: '1000' })).toBeNull()
    expect(alert({ event_type: 'INSIGHTS_UPDATED', filters: filters(), field: 'cpc', operator: 'GREATER_THAN', value: '200', status: 'PAUSED' })).toMatch(/ENABLED or DISABLED/)
    expect(alert({ event_type: 'OBJECT_DELETED', filters: filters() })).toMatch(/event_type is/)
  })

  it('filters: entity_type first, at most 20 (Meta), each {field, value, operator} in order, of the level watched; IN / NOT_IN a real list', () => {
    const campaign = (extra: unknown[]) => JSON.stringify([{ field: 'entity_type', value: 'CAMPAIGN', operator: 'EQUAL' }, ...extra])
    // Review B2 — an IN filter's value is a JSON list in the list (as ad-rule filters), not a string holding one.
    expect(alertFiltersProblem(campaign([{ field: 'objective', value: ['OUTCOME_SALES', 'OUTCOME_LEADS'], operator: 'IN' }]))).toBeNull()
    expect(alertFiltersProblem(campaign([{ field: 'objective', value: '["OUTCOME_SALES"]', operator: 'IN' }]))).toMatch(/IN takes a list of 1 to 20/)
    expect(alertFiltersProblem(campaign([{ field: 'objective', value: ['OUTCOME_SALES'], operator: 'EQUAL' }]))).toMatch(/EQUAL takes one of Meta's values/)
    expect(alertFiltersProblem(campaign([{ field: 'objective', value: [], operator: 'NOT_IN' }]))).toMatch(/NOT_IN takes a list of 1 to 20/)
    expect(alertFiltersProblem(campaign([{ field: 'objective', value: ['outcome_sales'], operator: 'IN' }]))).toMatch(/IN takes a list/)
    expect(alertFiltersProblem(filters([{ field: 'objective', value: 'OUTCOME_SALES', operator: 'EQUAL' }]))).toMatch(/filter objective is a setting of a campaign \(not of an ad\)/)
    expect(alertFiltersProblem(JSON.stringify([{ field: 'objective', value: 'OUTCOME_SALES', operator: 'EQUAL' }]))).toMatch(/first filter is entity_type/)
    expect(alertFiltersProblem(campaign(Array.from({ length: 20 }, () => ({ field: 'objective', value: 'X', operator: 'EQUAL' }))))).toMatch(/1 to 20/)
    expect(alertFiltersProblem(JSON.stringify([{ value: 'AD', field: 'entity_type', operator: 'EQUAL' }]))).toMatch(/in that order/)
    expect(alertFiltersProblem(filters([{ field: 'campaign.id', value: '1', operator: 'EQUAL' }]))).toMatch(/a filter is entity_type or one of/)
    expect(alertFiltersProblem(filters([{ field: 'constructor', value: 'X', operator: 'EQUAL' }]))).toMatch(/a filter is entity_type or one of/)
    expect(alertFiltersProblem(campaign([{ field: 'objective', value: 'X', operator: 'EQUAL' }, { field: 'objective', value: 'Y', operator: 'EQUAL' }]))).toMatch(/each filter field once/)
    expect(alertValueProblem('text', 'CONTAIN', ' padded')).toMatch(/plain text/)
  })

  it('status is a PATCH of one subscription of the chosen account; remove is a DELETE; another account never', async () => {
    expect(problem({ url: `${BASE}/${ACT}/subscriptions/120000000000040`, method: 'PATCH', body: form({ status: 'DISABLED' }), objectKind: 'adaccount' })).toBeNull()
    expect(problem({ url: `${BASE}/${ACT}/subscriptions/120000000000040`, method: 'PATCH', body: form({ status: 'DISABLED', field: 'cpc' }), objectKind: 'adaccount' })).toMatch(/the only Meta change Nexus sends/)
    expect(problem({ url: `${BASE}/${ACT}/subscriptions/120000000000040`, method: 'PUT', body: form({ status: 'DISABLED' }), objectKind: 'adaccount' })).toMatch(/Nexus sends Meta no PUT/)
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'adaccount', path: `${ACT}/subscriptions/120000000000040`, params: { status: 'DISABLED' }, method: 'PATCH', check: false })).ok).toBe(true)
    expect([h.calls[0].init.method, String(h.calls[0].init.body)]).toEqual(['PATCH', 'status=DISABLED'])
    expect(new URL(h.calls[0].url).searchParams.get('access_token')).toBe('meta-system-user-token')
    nextMoment()
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'adaccount', path: `${ACT}/subscriptions/120000000000040`, params: {}, method: 'DELETE', check: false })).ok).toBe(true)
    nextMoment()
    gatewayMetaChosen['m-1'] = '5555555555'
    await expect(metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'adaccount', path: `${ACT}/subscriptions/120000000000040`, params: {}, method: 'DELETE', check: false })).rejects.toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    expect(h.calls).toHaveLength(2)
  })
})

describe('the older rules are untouched', () => {
  it('a status change still goes; a DELETE of a campaign goes by main\'s rule only; the app token never changes a campaign', () => {
    expect(verdict({ url: `${BASE}/120000000000001`, body: form({ status: 'PAUSED' }) })).toMatchObject({ write: { rule: 'object.status' } })
    expect(verdict({ url: `${BASE}/120000000000001`, body: form({ status: 'PAUSED' }) })).not.toHaveProperty('write.auth')
    expect(verdict({ url: `${BASE}/120000000000001`, method: 'DELETE', objectKind: 'campaign' })).toMatchObject({ write: { rule: 'object.delete', method: 'DELETE' } })
    expect(verdict({ url: `${BASE}/120000000000001`, method: 'DELETE', objectKind: 'campaign' })).not.toHaveProperty('write.auth')
    expect(problem({ url: `${BASE}/120000000000001`, method: 'DELETE', objectKind: 'app' })).toMatch(/Nexus deletes on Meta only/)
    expect(problem({ url: `${BASE}/120000000000001`, body: form({ status: 'PAUSED' }), auth: 'app' })).toMatch(/system-user token/)
    expect(problem({ url: `${BASE}/120000000000001?status=PAUSED`, body: form({ status: 'PAUSED' }) })).toMatch(/never in the URL/)
  })
})
