/**
 * Meta step 40 on the gateway: the chosen ad account's own settings, its spending limit, its tracking specs and its
 * insights features reach Meta only on their EXACT allow-list entries — one rule per kind of change, the account itself
 * (`act_<id>`, no leading zero) or one of its two edges, keys exact, every value judged, JSON in one spelling only, text
 * only where a person types it — and only to the ad account this business chose, with every Page inside the chosen Page
 * and every pixel one of the account's own. The brake (NEXUS_META_ADS_WRITES) holds them all. Made-up ids only.
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
import { __metaObjectLimitsTest } from './meta-object-limits.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../meta/api-version.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const ACT = 'act_1234567890'
const PAGE = '120000000000080'
const PIXEL = '120000000000050'
const form = (o: Record<string, string>) => new URLSearchParams(o).toString()
const verdict = (input: { body?: unknown; objectKind?: string; url?: string; method?: string; kind?: string }) =>
  metaWriteVerdict({ method: input.method ?? 'POST', url: input.url ?? `${BASE}/${ACT}`, kind: input.kind ?? 'write', body: input.body, objectKind: input.objectKind ?? 'adaccount' })
const problem = (input: Parameters<typeof verdict>[0]) => { const v = verdict(input); return 'problem' in v ? v.problem : null }
const account = (o: Record<string, string>, extra: Partial<Parameters<typeof verdict>[0]> = {}) => problem({ body: form(o), ...extra })
const tracking = (specs: string) => problem({ url: `${BASE}/${ACT}/tracking`, body: form({ tracking_specs: specs }) })
const feature = (name: string, url = `${BASE}/${ACT}/insights/feature-settings`) => problem({ url, body: form({ feature_name: name }) })
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status })

beforeEach(() => {
  __rateTest.useMemory()
  __metaObjectLimitsTest.useMemory()
  h.calls = []; h.answers = []; gatewayLedger.length = 0
  for (const key of Object.keys(gatewayMetaChosen)) delete gatewayMetaChosen[key]
  for (const key of Object.keys(gatewayMetaStored)) delete gatewayMetaStored[key]
  for (const key of Object.keys(gatewayMetaPage)) delete gatewayMetaPage[key]
  vi.stubEnv('NEXUS_META_ADS_WRITES', 'on')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response(JSON.stringify({ success: true }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset(); __metaObjectLimitsTest.reset() })

describe('adaccount.settings: POST /act_<id>', () => {
  it('takes the account\'s own settings, named the ad account; the same body on a campaign, or with no kind, is refused', () => {
    expect(verdict({ body: form({ name: 'Shop A ads', fields: 'id,name' }) })).toEqual({ write: { rule: 'adaccount.settings', objectId: ACT, check: false, body: 'name=Shop+A+ads&fields=id%2Cname', budget: false, kinds: ['adaccount'] } })
    expect(account({ name: 'Shop A' }, { objectKind: 'campaign' })).toMatch(/only Meta change/)
    expect(metaWriteVerdict({ method: 'POST', url: `${BASE}/${ACT}`, kind: 'write', body: form({ name: 'Shop A' }) })).toMatchObject({ problem: expect.stringMatching(/only Meta change/) })
    expect(account({ name: 'Shop A' }, { kind: 'read' })).toMatch(/goes as a write/)
    expect(problem({ body: form({ name: 'Shop A' }), objectKind: 'adset' })).toMatch(/only Meta change/)
  })
  it('the path is exactly act_<digits> with no leading zero, never another edge or object', () => {
    expect(account({ name: 'Shop A' }, { url: `${BASE}/act_01234567890` })).toMatch(/only Meta change/)
    expect(account({ name: 'Shop A' }, { url: `${BASE}/act_0` })).toMatch(/only Meta change/)
    expect(account({ name: 'Shop A' }, { url: `${BASE}/1234567890` })).toMatch(/only Meta change/)
    expect(account({ name: 'Shop A' }, { url: `${BASE}/${ACT}/users` })).toMatch(/only Meta change/)
    expect(account({ name: 'Shop A' }, { url: `${BASE}/${ACT}?name=x` })).toMatch(/in its body, never in the URL/)
  })
  it('never sends currency, timezone_id, attribution_spec or any key Nexus does not send', () => {
    for (const key of ['currency', 'timezone_id', 'attribution_spec', 'custom_audience_info', 'tos_accepted', 'existing_customers', 'is_ba_skip_delayed_eligible', 'spend_cap', 'status']) {
      expect(account({ name: 'Shop A', [key]: key === 'attribution_spec' ? '[{"event_type":"CLICK_THROUGH","window_days":7}]' : 'EUR' }), key).toMatch(/only Meta change/)
    }
    expect(account({ currency: 'EUR' })).toMatch(/only Meta change/)
    expect(account({ fields: 'id,name' })).toMatch(/only Meta change/)
    expect(account({ name: 'Shop A', fields: 'id,spend_cap' })).toMatch(/reads back only/)
    expect(account({ name: 'Shop A', fields: 'id,id' })).toMatch(/each field once/)
  })
  it('a name is printable text (emoji allowed, no format character)', () => {
    expect(account({ name: 'Shop A 🏍️' })).toBeNull()
    expect(account({ name: 'Shop ‮A' })).toMatch(/printable text/)
    expect(account({ name: '' })).toMatch(/1 to 200/)
    expect(account({ name: 'x'.repeat(201) })).toMatch(/1 to 200/)
  })
  it('the EU payer and beneficiary go together: both set, or both empty (which clears both)', () => {
    expect(account({ default_dsa_payor: 'Shop A', default_dsa_beneficiary: 'Shop A' })).toBeNull()
    expect(account({ default_dsa_payor: '', default_dsa_beneficiary: '' })).toBeNull()
    expect(account({ default_dsa_payor: 'Shop A' })).toMatch(/go together/)
    expect(account({ default_dsa_beneficiary: 'Shop A' })).toMatch(/go together/)
    expect(account({ default_dsa_payor: 'Shop A', default_dsa_beneficiary: '' })).toMatch(/both set, or both empty/)
    expect(account({ default_dsa_payor: 'Shop ​A', default_dsa_beneficiary: 'Shop A' })).toMatch(/printable text/)
    expect(account({ default_dsa_payor: 'x'.repeat(513), default_dsa_beneficiary: 'Shop A' })).toMatch(/1 to 512/)
  })
  it('business_info: only the seven business_* keys, JSON in one spelling, every value printable text', () => {
    expect(account({ business_info: '{"business_city":"Città A","business_country_code":"IT","business_zip":""}' })).toBeNull()
    expect(account({ business_info: '{"business_city":"A","business_email":"a@example.com"}' })).toMatch(/has only business_name/)
    expect(account({ business_info: '{ "business_city":"A"}' })).toMatch(/one spelling only/)
    expect(account({ business_info: '{"business_city":"A","business_city":"B"}' })).toMatch(/one spelling only/)
    expect(account({ business_info: '{}' })).toMatch(/at least one/)
    expect(account({ business_info: '{"business_city":"A\\u0007"}' })).toMatch(/printable text/)
    expect(account({ business_info: '{"business_city":"A‮"}' })).toMatch(/printable text/)
    expect(account({ business_info: '{"business_country_code":"it"}' })).toMatch(/two capital letters/)
    expect(account({ business_info: '{"business_city":12}' })).toMatch(/printable text/)
  })
  it('notifications are true or false', () => {
    expect(account({ is_notifications_enabled: 'false' })).toBeNull()
    expect(account({ is_notifications_enabled: '0' })).toMatch(/is_notifications_enabled is one of true, false/)
  })
  it('end advertiser, media agency, partner: NONE, UNFOUND or a Page id — the Page goes to the gateway\'s chosen-Page check', () => {
    expect(verdict({ body: form({ end_advertiser: PAGE }) })).toMatchObject({ write: { rule: 'adaccount.settings', ids: [{ id: PAGE, kind: 'page' }] } })
    expect(verdict({ body: form({ media_agency: 'NONE', partner: 'UNFOUND' }) })).toMatchObject({ write: { rule: 'adaccount.settings' } })
    expect('ids' in ((verdict({ body: form({ media_agency: 'NONE' }) }) as { write: Record<string, unknown> }).write)).toBe(false)
    expect(account({ end_advertiser: 'shopa' })).toMatch(/NONE, UNFOUND or a Page id/)
    expect(account({ partner: '0123' })).toMatch(/NONE, UNFOUND or a Page id/)
    expect(account({ media_agency: 'none' })).toMatch(/NONE, UNFOUND or a Page id/)
  })
  it('the agency declaration: its own keys only, flags "0" / "1", never the client\'s e-mail', () => {
    expect(account({ agency_client_declaration: '{"agency_representing_client":"1","client_country_code":"FR","client_name":"Client A"}' })).toBeNull()
    expect(account({ agency_client_declaration: '{"client_email_address":"a@example.com"}' })).toMatch(/never the client's e-mail/)
    expect(account({ agency_client_declaration: '{"agency_representing_client":"true"}' })).toMatch(/"0" or "1"/)
    expect(account({ agency_client_declaration: '{"client_country_code":"France"}' })).toMatch(/two capital letters/)
  })
})

describe('adaccount.spend_cap: POST /act_<id> with spend_cap or spend_cap_action', () => {
  it('a new limit in standard units (two decimals or none), positive; never 0', () => {
    expect(verdict({ body: form({ spend_cap: '500.00', fields: 'id,spend_cap,amount_spent' }) })).toMatchObject({ write: { rule: 'adaccount.spend_cap', objectId: ACT, kinds: ['adaccount'] } })
    expect(account({ spend_cap: '1250' })).toBeNull()
    expect(account({ spend_cap: '0.50' })).toBeNull()
    for (const bad of ['0', '0.00', '-5.00', '5.5', '5.000', '1e3', '05.00', ' 5.00', '5,00']) expect(account({ spend_cap: bad }), bad).not.toBeNull()
    expect(account({ spend_cap: '0' })).toMatch(/no spending limit/)
  })
  it('an action is reset or delete; never with a new limit in the same request, never with another setting', () => {
    expect(account({ spend_cap_action: 'reset' })).toBeNull()
    expect(account({ spend_cap_action: 'delete' })).toBeNull()
    expect(account({ spend_cap_action: 'remove' })).toMatch(/spend_cap_action is one of reset, delete/)
    expect(account({ spend_cap: '500.00', spend_cap_action: 'reset' })).toMatch(/never both/)
    expect(account({ spend_cap: '500.00', name: 'Shop A' })).toMatch(/only Meta change/)
    expect(account({ spend_cap: '500.00', fields: 'id,name' })).toMatch(/reads back only/)
  })
})

describe('adaccount.tracking: POST /act_<id>/tracking tracking_specs', () => {
  it('Nexus\'s four shapes only, each id a list of one, the whole list at most 20; the pixel and the Page go to the gateway\'s checks', () => {
    const specs = `[{"action.type":["offsite_conversion"],"fb_pixel":["${PIXEL}"]},{"action.type":["link_click"],"object":["${PAGE}"]}]`
    expect(verdict({ url: `${BASE}/${ACT}/tracking`, body: form({ tracking_specs: specs }) })).toMatchObject({ write: { rule: 'adaccount.tracking', objectId: ACT, ids: [{ id: PIXEL, kind: 'pixel' }, { id: PAGE, kind: 'page' }] } })
    // Fix round 1 (B-3) — never an empty list (Meta documents no way to remove account-level specs).
    expect(tracking('[]')).toMatch(/at least one spec/)
    expect(tracking(`[{"action.type":["app_install"],"application":["${PAGE}"]}]`)).toMatch(/action.type is a list of one of/)
    expect(tracking(`[{"action.type":["like"],"fb_pixel":["${PIXEL}"]}]`)).toMatch(/exactly action.type and page/)
    expect(tracking(`[{"action.type":["like"],"page":["${PAGE}"],"post":["1"]}]`)).toMatch(/exactly action.type and page/)
    expect(tracking(`[{"action.type":["like"],"page":["${PAGE}","${PIXEL}"]}]`)).toMatch(/a list of one Meta id/)
    expect(tracking(`[{"action.type":["like"],"page":[${PAGE}]}]`)).toMatch(/a list of one Meta id/)
    expect(tracking(`[{"action.type":["like","link_click"],"page":["${PAGE}"]}]`)).toMatch(/action.type is a list of one/)
    expect(tracking(`[{"action.type":["like"],"page":["${PAGE}"]},{"action.type":["like"],"page":["${PAGE}"]}]`)).toMatch(/each spec once/)
    expect(tracking(`[{"action.type": ["like"],"page":["${PAGE}"]}]`)).toMatch(/one spelling only/)
    expect(tracking(JSON.stringify(Array.from({ length: 21 }, (_, i) => ({ 'action.type': ['offsite_conversion'], fb_pixel: [String(PIXEL.slice(0, -2)) + String(10 + i)] }))))).toMatch(/at most 20/)
    expect(problem({ url: `${BASE}/${ACT}/tracking`, body: form({ tracking_specs: '[]', fields: 'id' }) })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/act_0123/tracking`, body: form({ tracking_specs: '[]' }) })).toMatch(/only Meta change/)
  })
})

describe('adaccount.insights_feature: POST /act_<id>/insights/feature-settings feature_name', () => {
  it('one of Meta\'s four features, on exactly that path', () => {
    expect(verdict({ url: `${BASE}/${ACT}/insights/feature-settings`, body: form({ feature_name: 'impression_device' }) })).toMatchObject({ write: { rule: 'adaccount.insights_feature', objectId: ACT, check: false } })
    for (const name of ['comscore', 'impression_device', 'time_of_day_viewer_tz', 'frequency_value']) expect(feature(name), name).toBeNull()
    expect(feature('dma')).toMatch(/feature_name is one of/)
    expect(feature('impression_device', `${BASE}/${ACT}/insights/feature-settings/list-features`)).toMatch(/only Meta change/)
    expect(feature('impression_device', `${BASE}/act_0123/insights/feature-settings`)).toMatch(/only Meta change/)
    expect(feature('impression_device', `${BASE}/${ACT}/insights`)).toMatch(/report run|only Meta change|level/)
    expect(problem({ url: `${BASE}/${ACT}/insights/feature-settings`, body: form({ feature_name: 'comscore', fields: 'id' }) })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/${ACT}/insights/feature-settings`, method: 'DELETE', body: form({ feature_name: 'comscore' }) })).toMatch(/deletes on Meta only/)
  })
})

describe('through the gateway: only the chosen ad account, its chosen Page, its own pixels; the brake holds', () => {
  it('a change of another ad account sends nothing; the chosen one goes as a form POST', async () => {
    const other = await metaWriteCall({ connectionId: 'm-1', operation: 'account.settings', objectId: 'act_5555555555', objectKind: 'adaccount', params: { name: 'Shop A' }, check: false }).catch((e) => e)
    expect(other).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/a change of an ad account goes only to the Meta ad account this business chose/) })
    expect(other.message).not.toContain('5555555555')
    expect(h.calls).toHaveLength(0)
    const ok = await metaWriteCall({ connectionId: 'm-1', operation: 'account.spendCap', objectId: ACT, objectKind: 'adaccount', params: { spend_cap: '500.00' }, check: false })
    expect(ok.ok).toBe(true)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].init.method).toBe('POST')
    expect(new URL(h.calls[0].url).pathname).toBe(`/v26.0/${ACT}`)
    expect(new URLSearchParams(String(h.calls[0].init.body)).get('spend_cap')).toBe('500.00')
    // Meta's check is never asked of an account change (validate_only is documented on campaign changes and creates only).
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'adaccount', params: { name: 'Shop A' }, check: true }).catch((e) => e)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
  })
  it('the brake: with Meta changes switched off nothing is sent', async () => {
    vi.stubEnv('NEXUS_META_ADS_WRITES', 'off')
    for (const [edge, params] of [[undefined, { spend_cap_action: 'delete' }], ['tracking', { tracking_specs: `[{"action.type":["offsite_conversion"],"fb_pixel":["${PIXEL}"]}]` }], ['insights/feature-settings', { feature_name: 'comscore' }]] as const) {
      const out = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'adaccount', ...(edge ? { edge } : {}), params, check: false }).catch((e) => e)
      expect(out, String(edge)).toMatchObject({ code: 'PUBLISH_GATED' })
    }
    expect(h.calls).toHaveLength(0)
  })
  it('fix round 1 (B-1) — Meta\'s 10 spending-limit changes a day (17/1885172) hold nothing: a pause still goes; a real throttle holds', async () => {
    gatewayMetaStored['120000000000001'] = { adAccountId: '1234567890', kind: 'campaign' }
    const daily = () => new Response(JSON.stringify({ error: { code: 17, error_subcode: 1885172, message: 'User request limit reached' } }), { status: 400 })
    h.answers.push(daily)
    const refused = await metaWriteCall({ connectionId: 'm-1', operation: 'account.spendCap', objectId: ACT, objectKind: 'adaccount', params: { spend_cap: '500.00' }, check: false })
    expect(refused.ok).toBe(false)
    expect(refused.verdict).toMatchObject({ channelCode: '17/1885172' })
    // The business's other Meta changes go on at once — a pause above all.
    const pause = await metaWriteCall({ connectionId: 'm-1', operation: 'status.change', objectId: '120000000000001', objectKind: 'campaign', params: { status: 'PAUSED' }, check: false })
    expect(pause.ok).toBe(true)
    expect(h.calls).toHaveLength(2)
    // A real throttle (17 with another subcode) still holds the account's bucket: the next call is not sent.
    h.answers.push(() => new Response(JSON.stringify({ error: { code: 17, error_subcode: 2446079, message: 'User request limit reached' } }), { status: 400 }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'account.spendCap', objectId: ACT, objectKind: 'adaccount', params: { spend_cap: '600.00' }, check: false })).ok).toBe(false)
    const held = await metaWriteCall({ connectionId: 'm-1', operation: 'status.change', objectId: '120000000000001', objectKind: 'campaign', params: { status: 'PAUSED' }, check: false }).catch((e) => e)
    expect(held).toMatchObject({ code: 'RATE_LIMITED_LOCAL' })
  })
  it('a Page named as end advertiser must be the chosen Page', async () => {
    const noPage = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'adaccount', params: { end_advertiser: PAGE }, check: false }).catch((e) => e)
    expect(noPage).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(new RegExp(`Page ${PAGE} is not the Facebook Page this business chose`)) })
    expect(h.calls).toHaveLength(0)
    gatewayMetaPage['m-1'] = PAGE
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'adaccount', params: { end_advertiser: PAGE }, check: false })).ok).toBe(true)
  })
  it('a tracking spec\'s pixel must be one of the chosen account\'s own pixels; its Page the chosen Page', async () => {
    h.answers.push(json({ data: [{ id: '120000000000051' }] }))
    const foreign = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'adaccount', edge: 'tracking', params: { tracking_specs: `[{"action.type":["offsite_conversion"],"fb_pixel":["${PIXEL}"]}]` }, check: false }).catch((e) => e)
    expect(foreign).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(new RegExp(`pixel ${PIXEL}`)) })
    expect(h.calls.map((c) => c.init.method)).toEqual(['GET'])
    h.calls = []
    h.answers.push(json({ data: [{ id: PIXEL }] }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'adaccount', edge: 'tracking', params: { tracking_specs: `[{"action.type":["offsite_conversion"],"fb_pixel":["${PIXEL}"]}]` }, check: false })).ok).toBe(true)
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).pathname])).toEqual([['GET', `/v26.0/${ACT}/adspixels`], ['POST', `/v26.0/${ACT}/tracking`]])
    const page = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'adaccount', edge: 'tracking', params: { tracking_specs: `[{"action.type":["like"],"page":["${PAGE}"]}]` }, check: false }).catch((e) => e)
    expect(page).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
  })
  it('an insights feature is switched on only on the chosen account', async () => {
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: 'act_5555555555', objectKind: 'adaccount', edge: 'insights/feature-settings', params: { feature_name: 'comscore' }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    h.answers.push(json({ id: ACT }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'adaccount', edge: 'insights/feature-settings', params: { feature_name: 'comscore' }, check: false })).ok).toBe(true)
    expect(new URL(h.calls[0].url).pathname).toBe(`/v26.0/${ACT}/insights/feature-settings`)
  })
})
