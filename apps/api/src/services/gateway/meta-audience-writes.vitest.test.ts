/**
 * Meta step 31 on the gateway: the audience changes (create-meta-audience, set-meta-audience, set-meta-audience-members,
 * set-meta-audience-sharing, remove-meta-audience) reach Meta only on their EXACT allow-list entries — path and kind of
 * object, keys, every value judged, JSON in one spelling only — and every id inside a body is the business's own; the
 * hashed people of a customer list go only as SHA-256 hashes (EMAIL_SHA256, at most 10,000 a request): out in a DELETE,
 * and — consent PR 2 — in with POST /users or a replace session with POST /usersreplace, only while the business's
 * "Upload customer lists to Meta" is on (asked again here) and only into a custom audience of the chosen ad account; the
 * ledger keeps neither them nor Meta's answer. Steps 17 and 18's rules are untouched. Made-up ids and example.com
 * addresses only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; init: RequestInit }>,
  answers: [] as Array<() => Response>,
  idProblems: new Map<string, string>(),
  idAsked: [] as Array<{ id: string; kind: string }>,
  uploadsOn: true,
  switchFails: false,
  switchAsked: 0,
}))
vi.mock('../marketing/meta-ads/customer-lists-switch.js', () => ({
  metaCustomerListsSwitch: vi.fn(async () => {
    h.switchAsked += 1
    if (h.switchFails) throw new Error('connection to the database lost')
    return { on: h.uploadsOn, since: null, by: null }
  }),
}))
vi.mock('../marketing/meta-ads/taken.js', () => ({ takenIds: vi.fn(async () => new Set<string>()) }))
// The audience-id rules have their own test (audience-ids.vitest.test.ts): here a stand-in says which ids are not the business's.
vi.mock('../marketing/meta-ads/audience-ids.js', () => ({
  metaAudienceIdProblem: vi.fn(async (_connectionId: string, inner: { id: string; kind: string }) => { h.idAsked.push(inner); return h.idProblems.get(inner.id) ?? null }),
}))
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

import { createHash } from 'node:crypto'
import { gatewayLedger, gatewayMetaChosen, gatewayMetaPage, gatewayMetaStored } from '../../test-support/gateway-stubs.js'
import { __rateTest } from './rate.js'
import { metaWriteCall } from './meta.js'
import { metaWriteVerdict } from './meta-calls.js'
import { audienceRuleProblem, lookalikeSpecProblem, MEMBERS_PER_REQUEST } from './meta-audience-rules.js'
import { NO_CONSENT } from '../marketing/meta-ads/audience-members.js'
import { __metaObjectLimitsTest } from './meta-object-limits.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../meta/api-version.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const ACT = 'act_1234567890'
const AUDIENCE = '120000000000040'
const PIXEL = '120000000000050'
const PAGE = '120000000000080'
const form = (o: Record<string, string>) => new URLSearchParams(o).toString()
const verdict = (input: { body?: unknown; objectKind?: string; url?: string; method?: string; kind?: string }) =>
  metaWriteVerdict({ method: input.method ?? 'POST', url: input.url ?? `${BASE}/${ACT}/customaudiences`, kind: input.kind ?? 'write', body: input.body, objectKind: input.objectKind ?? 'adaccount' })
const problem = (input: Parameters<typeof verdict>[0]) => { const v = verdict(input); return 'problem' in v ? v.problem : null }
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status })
const hash = (email: string) => createHash('sha256').update(email).digest('hex')

const WEBSITE_RULE = { inclusions: { operator: 'or', rules: [{ event_sources: [{ id: PIXEL, type: 'pixel' }], retention_seconds: 2592000, filter: { operator: 'and', filters: [{ field: 'url', operator: 'i_contains', value: 'helmets' }] } }] } }
const PAYLOAD = JSON.stringify({ schema: 'EMAIL_SHA256', data: [hash('a@example.com'), hash('b@example.com')] })
const SESSION = JSON.stringify({ session_id: 123456789, batch_seq: 1, last_batch_flag: true, estimated_num_total: 2 })
const EVENT = { operator: 'and', filters: [{ field: 'event', operator: 'eq', value: 'page_engaged' }] }

beforeEach(() => {
  __rateTest.useMemory()
  __metaObjectLimitsTest.useMemory()
  h.calls = []; h.answers = []; h.idProblems.clear(); h.idAsked = []; gatewayLedger.length = 0; h.uploadsOn = true; h.switchFails = false; h.switchAsked = 0
  for (const key of Object.keys(gatewayMetaChosen)) delete gatewayMetaChosen[key]
  for (const key of Object.keys(gatewayMetaStored)) delete gatewayMetaStored[key]
  for (const key of Object.keys(gatewayMetaPage)) delete gatewayMetaPage[key]
  vi.stubEnv('NEXUS_META_ADS_WRITES', 'on')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response(JSON.stringify({ id: AUDIENCE }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset(); __metaObjectLimitsTest.reset() })

describe('creates on the ad account\'s edges', () => {
  it('a customer list: subtype CUSTOM, its source, nothing else; the account named as the object', () => {
    expect(verdict({ body: form({ name: 'List A', subtype: 'CUSTOM', customer_file_source: 'USER_PROVIDED_ONLY' }) }))
      .toEqual({ write: { rule: 'audience.create.customerList', objectId: ACT, check: false, body: 'name=List+A&subtype=CUSTOM&customer_file_source=USER_PROVIDED_ONLY', budget: false, kinds: ['adaccount'] } })
    expect(problem({ body: form({ name: 'List A', subtype: 'CUSTOM', customer_file_source: 'FROM_ANYWHERE' }) })).toMatch(/customer_file_source is one of/)
    expect(problem({ body: form({ name: 'List A', subtype: 'CUSTOM', customer_file_source: 'USER_PROVIDED_ONLY', enable_fetch_or_create: 'true' }) })).toMatch(/only Meta change/)
    expect(problem({ body: form({ name: 'List A', subtype: 'CUSTOM', customer_file_source: 'USER_PROVIDED_ONLY', use_for_products: '["ADS"]' }) })).toMatch(/only Meta change/)
    expect(problem({ body: form({ name: 'List A', subtype: 'LOOKALIKE', customer_file_source: 'USER_PROVIDED_ONLY' }) })).toMatch(/subtype CUSTOM/)
    // Named as an audience, or no kind: no rule matches.
    expect(problem({ body: form({ name: 'List A', subtype: 'CUSTOM', customer_file_source: 'USER_PROVIDED_ONLY' }), objectKind: 'customaudience' })).toMatch(/only Meta change/)
    expect(problem({ body: form({ name: 'List A', subtype: 'CUSTOM', customer_file_source: 'USER_PROVIDED_ONLY' }), objectKind: 'campaign' })).toMatch(/only Meta change/)
  })
  it('a website rule: Meta\'s syntax in one spelling, its pixel named for the gateway\'s check', () => {
    const ok = verdict({ body: form({ name: 'Visitors A', rule: JSON.stringify(WEBSITE_RULE), prefill: 'true' }) })
    expect(ok).toMatchObject({ write: { rule: 'audience.create.rule', ids: [{ id: PIXEL, kind: 'pixel' }] } })
    expect(problem({ body: form({ name: 'Visitors A', rule: JSON.stringify(WEBSITE_RULE).replace(':', ': ') }) })).toMatch(/one spelling only/)
    expect(problem({ body: form({ name: 'Visitors A', rule: JSON.stringify(WEBSITE_RULE, null, 1) }) })).toMatch(/printable text/)
    expect(problem({ body: form({ name: 'Visitors A', rule: JSON.stringify({ ...WEBSITE_RULE, template: 'X' }) }) })).toMatch(/inclusions, exclusions/)
    const bad = (rule: unknown) => problem({ body: form({ name: 'Visitors A', rule: JSON.stringify(rule) }) })
    expect(bad({ inclusions: { operator: 'xor', rules: WEBSITE_RULE.inclusions.rules } })).toMatch(/and or or/)
    expect(bad({ inclusions: { operator: 'or', rules: [{ ...WEBSITE_RULE.inclusions.rules[0], event_sources: [{ id: PIXEL, type: 'app' }] }] } })).toMatch(/an event source is/)
    expect(bad({ inclusions: { operator: 'or', rules: [{ ...WEBSITE_RULE.inclusions.rules[0], filter: { operator: 'and', filters: [{ field: 'event', operator: 'contains', value: 'Purchase' }] } }] } })).toMatch(/event filter takes =/)
    expect(bad({ inclusions: { operator: 'or', rules: Array(11).fill(WEBSITE_RULE.inclusions.rules[0]) } })).toMatch(/1 to 10 rules/)
    expect(bad({ inclusions: { operator: 'or', rules: [{ ...WEBSITE_RULE.inclusions.rules[0], retention_seconds: 10 ** 9 }] } })).toMatch(/retention_seconds/)
    expect(bad({ inclusions: { operator: 'or', rules: [{ ...WEBSITE_RULE.inclusions.rules[0], event_sources: [{ id: '12a', type: 'pixel' }] }] } })).toMatch(/an event source is/)
    // An engagement rule names its Page for the gateway's check.
    const page = { inclusions: { operator: 'or', rules: [{ event_sources: [{ id: PAGE, type: 'page' }], retention_seconds: 31536000, filter: EVENT }] } }
    // Review B4 — a rule without its filter is refused (every visitor is url i_contains "").
    expect(bad({ inclusions: { operator: 'or', rules: [{ event_sources: [{ id: PIXEL, type: 'pixel' }], retention_seconds: 86400 }] } })).toMatch(/filter is required/)
    expect(verdict({ body: form({ name: 'Fans A', rule: JSON.stringify(page) }) })).toMatchObject({ write: { ids: [{ id: PAGE, kind: 'page' }] } })
  })
  it('a video audience (subtype ENGAGEMENT, the array rule) names its videos; a lookalike one source', () => {
    const video = JSON.stringify([{ object_id: '120000000000090', event_name: 'video_watched' }])
    expect(verdict({ body: form({ name: 'Viewers A', subtype: 'ENGAGEMENT', rule: video }) })).toMatchObject({ write: { rule: 'audience.create.video', ids: [{ id: '120000000000090', kind: 'sourcevideo' }] } })
    expect(problem({ body: form({ name: 'Viewers A', subtype: 'ENGAGEMENT', rule: JSON.stringify([{ object_id: '1', event_name: 'video_liked' }]) }) })).toMatch(/video rule/)
    const spec = JSON.stringify({ ratio: 0.03, starting_ratio: 0.01 })
    expect(verdict({ body: form({ name: 'Look A', subtype: 'LOOKALIKE', origin_audience_id: AUDIENCE, lookalike_spec: spec }) }))
      .toMatchObject({ write: { rule: 'audience.create.lookalike', ids: [{ id: AUDIENCE, kind: 'customaudience' }] } })
    expect(problem({ body: form({ name: 'Look A', subtype: 'LOOKALIKE', lookalike_spec: spec }) })).toMatch(/ONE source/)
    expect(problem({ body: form({ name: 'Look A', subtype: 'LOOKALIKE', origin_audience_id: AUDIENCE, lookalike_spec: JSON.stringify({ ratio: 0.03, country: 'IT' }) }) })).toMatch(/never country/)
    const campaigns = JSON.stringify({ ratio: 0.05, origin_ids: ['120000000000001', '120000000000002'], conversion_type: 'campaign_conversions' })
    expect(verdict({ body: form({ name: 'Look B', subtype: 'LOOKALIKE', lookalike_spec: campaigns }) })).toMatchObject({ write: { ids: [{ id: '120000000000001', kind: 'campaignOrAdset' }, { id: '120000000000002', kind: 'campaignOrAdset' }] } })
    expect(problem({ body: form({ name: 'Look B', subtype: 'LOOKALIKE', origin_audience_id: AUDIENCE, lookalike_spec: campaigns }) })).toMatch(/ONE source/)
    expect(lookalikeSpecProblem({ ratio: 0.25 })).toMatch(/0.01 to 0.20/)
    expect(lookalikeSpecProblem({ ratio: 0.035 })).toMatch(/steps of 0.01/)
    expect(lookalikeSpecProblem({ ratio: 0.03, starting_ratio: 0.03 })).toMatch(/below ratio/)
    expect(lookalikeSpecProblem({ type: 'similarity' })).toBeNull()
    expect(lookalikeSpecProblem({ type: 'custom_ratio' })).toMatch(/names its ratio/)
    expect(lookalikeSpecProblem({ ratio: 0.01, origin_ids: ['1'], conversion_type: 'campaign_conversions', page_id: '2' })).toMatch(/no Page/)
    // Review B3 — converters and Page fans take a ratio, never a type alone.
    expect(lookalikeSpecProblem({ type: 'similarity', origin_ids: ['1'], conversion_type: 'campaign_conversions' })).toMatch(/names its ratio/)
    expect(lookalikeSpecProblem({ type: 'reach', page_id: '2', conversion_type: 'page_like' })).toMatch(/names its ratio/)
  })
  it('a catalog product audience on act_<id>/product_audiences: one event per rule, its product set and pixel named', () => {
    const body = form({ name: 'Carts A', product_set_id: '120000000000061', inclusions: '[{"retention_seconds":604800,"rule":{"event":{"eq":"AddToCart"}}}]', exclusions: '[{"retention_seconds":604800,"rule":{"event":{"eq":"Purchase"}}}]', event_sources: `[{"id":"${PIXEL}","type":"PIXEL"}]` })
    expect(verdict({ url: `${BASE}/${ACT}/product_audiences`, body })).toMatchObject({ write: { rule: 'audience.create.product', ids: [{ id: '120000000000061', kind: 'productset' }, { id: PIXEL, kind: 'pixel' }] } })
    expect(problem({ url: `${BASE}/${ACT}/product_audiences`, body: form({ name: 'Carts A', product_set_id: '1', inclusions: '[{"retention_seconds":604800,"rule":{"event":{"eq":"Wishlist"}}}]' }) })).toMatch(/inclusions: a rule is/)
    expect(problem({ url: `${BASE}/${ACT}/product_audiences`, body: form({ name: 'Carts A', product_set_id: '1', inclusions: '[{"retention_seconds":604800,"rule":{"and":[{"event":{"eq":"AddToCart"}},{"event":{"eq":"Purchase"}}]}}]' }) })).toMatch(/inclusions: a rule is/)
  })
})

describe('changes of one audience and of the account', () => {
  it('an update names the audience; its keys only; a rule as on create', () => {
    const url = `${BASE}/${AUDIENCE}`
    expect(verdict({ url, objectKind: 'customaudience', body: form({ name: 'List B', opt_out_link: 'https://shop.example/optout' }) }))
      .toEqual({ write: { rule: 'audience.update', objectId: AUDIENCE, check: false, body: 'name=List+B&opt_out_link=https%3A%2F%2Fshop.example%2Foptout', budget: false, kinds: ['customaudience'] } })
    expect(problem({ url, objectKind: 'customaudience', body: form({ status: 'PAUSED' }) })).toMatch(/only Meta change/)
    expect(problem({ url, objectKind: 'customaudience', body: form({ opt_out_link: 'javascript:alert(1)' }) })).toMatch(/opt_out_link/)
    expect(problem({ url, objectKind: 'customaudience', body: form({ audience_labels: '["HIGH_VALUE_CUSTOMERS","HIGH_VALUE_CUSTOMERS"]' }) })).toMatch(/each once/)
    expect(problem({ url, objectKind: 'customaudience', body: form({ lookalike_spec: '{"ratio":0.04,"origin_ids":["1"],"conversion_type":"campaign_conversions"}' }) })).toMatch(/takes type, ratio, starting_ratio, allow_international_seeds only/)
    expect(problem({ url, objectKind: 'customaudience', body: form({ name: 'List ‮B' }) })).toMatch(/printable text/)
    // The same body named a campaign is not an audience change.
    expect(problem({ url, objectKind: 'campaign', body: form({ opt_out_link: 'https://shop.example/optout' }) })).toMatch(/only Meta change/)
  })
  it('the account\'s existing customers (the whole list, ids named) and its audience-type tags', () => {
    const url = `${BASE}/${ACT}`
    expect(verdict({ url, body: form({ existing_customers: `["${AUDIENCE}"]` }) })).toMatchObject({ write: { rule: 'adaccount.audiences', objectId: ACT, ids: [{ id: AUDIENCE, kind: 'customaudience' }] } })
    expect(verdict({ url, body: form({ existing_customers: '[]' }) })).toMatchObject({ write: { rule: 'adaccount.audiences' } })
    expect(problem({ url, body: form({ custom_audience_info: '{"audience_type_param_name":"audience_type"}' }) })).toMatch(/new_customer_tag and \/ or existing_customer_tag/)
    expect(verdict({ url, body: form({ custom_audience_info: '{"audience_type_param_name":"audience_type","new_customer_tag":"prospecting"}' }) })).toMatchObject({ write: { rule: 'adaccount.audiences' } })
    // Nothing else of the account: never its spend cap or DSA defaults here.
    // Step 40 — the spending limit and the DSA defaults are set-meta-spend-cap's and set-meta-account-settings' own rules
    // (adaccount.spend_cap, adaccount.settings): never mixed into an audience change.
    expect(problem({ url, body: form({ spend_cap: '100', existing_customers: '[]' }) })).toMatch(/only Meta change/)
    expect(problem({ url, body: form({ default_dsa_payor: 'Shop A', default_dsa_beneficiary: 'Shop A', existing_customers: '[]' }) })).toMatch(/only Meta change/)
    expect(verdict({ url, body: form({ spend_cap: '100' }) })).toMatchObject({ write: { rule: 'adaccount.spend_cap' } })
  })
  it('sharing: POST and DELETE /<audience>/ad_accounts, the recipients named; never replace', () => {
    const url = `${BASE}/${AUDIENCE}/ad_accounts`
    expect(verdict({ url, objectKind: 'customaudience', body: form({ adaccounts: '["1234567891"]', permissions: 'targeting' }) }))
      .toMatchObject({ write: { rule: 'audience.share', ids: [{ id: '1234567891', kind: 'shareaccount' }] } })
    expect(problem({ url, objectKind: 'customaudience', body: form({ adaccounts: '["1234567891"]', replace: 'true' }) })).toMatch(/only Meta change/)
    expect(problem({ url, objectKind: 'customaudience', body: form({ adaccounts: '["act_1234567891"]' }) })).toMatch(/Meta ids/)
    // Review A1 — an unshare names no recipient to check: taking access away is how a share with another business ends.
    const unshare = verdict({ url, method: 'DELETE', objectKind: 'customaudience', body: form({ adaccounts: '["1234567891"]' }) })
    expect(unshare).toMatchObject({ write: { rule: 'audience.unshare', method: 'DELETE' } })
    expect('write' in unshare && unshare.write.ids).toBeUndefined()
    expect(problem({ url, method: 'DELETE', objectKind: 'customaudience', body: form({ adaccounts: '["1234567891"]', permissions: 'targeting' }) })).toMatch(/only Meta change/)
  })
  it('a delete of an audience: no body, named an audience — never a campaign; step 18\'s budget schedule delete unchanged', () => {
    expect(verdict({ url: `${BASE}/${AUDIENCE}`, method: 'DELETE', objectKind: 'customaudience' })).toEqual({ write: { rule: 'audience.delete', objectId: AUDIENCE, check: false, body: '', budget: false, kinds: ['customaudience'], method: 'DELETE' } })
    // Step 22's campaign delete is its own rule (remove-meta-ads-items), never the audience's.
    expect(verdict({ url: `${BASE}/${AUDIENCE}`, method: 'DELETE', objectKind: 'campaign' })).not.toMatchObject({ write: { rule: 'audience.delete' } })
    expect(problem({ url: `${BASE}/${AUDIENCE}`, method: 'DELETE', objectKind: 'customaudience', body: 'x=1' })).toMatch(/Nexus deletes on Meta only .*for audiences \(step 31\)/)
    expect(verdict({ url: `${BASE}/120000000000031`, method: 'DELETE', objectKind: 'highdemandperiod' })).toMatchObject({ write: { rule: 'budget_schedule.delete' } })
    // Review A5 — a DELETE body that is not form text is refused, never sent as an empty one.
    expect(problem({ url: `${BASE}/${AUDIENCE}`, method: 'DELETE', objectKind: 'customaudience', body: new Uint8Array([1]) })).toMatch(/form text/)
    expect(problem({ url: `${BASE}/${AUDIENCE}`, method: 'DELETE', objectKind: 'customaudience', body: { a: 1 } })).toMatch(/form text/)
  })
})

describe('the people of a customer list: hashes only, in a DELETE', () => {
  it('remove from one list and opt out everywhere: EMAIL_SHA256 hashes only, and no session (review B1)', () => {
    const one = verdict({ url: `${BASE}/${AUDIENCE}/users`, method: 'DELETE', objectKind: 'customaudience', body: form({ payload: PAYLOAD }) })
    expect(one).toMatchObject({ write: { rule: 'audience.users.remove', method: 'DELETE', personal: true, objectId: AUDIENCE } })
    expect(verdict({ url: `${BASE}/${ACT}/usersofanyaudience`, method: 'DELETE', body: form({ payload: PAYLOAD }) })).toMatchObject({ write: { rule: 'adaccount.usersofanyaudience', personal: true, objectId: ACT } })
    expect(problem({ url: `${BASE}/${AUDIENCE}/users`, method: 'DELETE', objectKind: 'customaudience', body: form({ payload: PAYLOAD, session: SESSION }) })).toMatch(/only Meta change/)
  })
  it('never a plain e-mail, never more than 10,000, never another schema', () => {
    const del = (payload: unknown, extra: Record<string, string> = {}) => problem({ url: `${BASE}/${AUDIENCE}/users`, method: 'DELETE', objectKind: 'customaudience', body: form({ payload: JSON.stringify(payload), ...extra }) })
    expect(del({ schema: 'EMAIL_SHA256', data: ['a@example.com'] })).toMatch(/SHA-256 hash/)
    expect(del({ schema: 'EMAIL_SHA256', data: [hash('a@example.com').toUpperCase()] })).toMatch(/SHA-256 hash/)
    expect(del({ schema: 'EMAIL', data: [hash('a@example.com')] })).toMatch(/hashed e-mails only/)
    expect(del({ schema: ['EMAIL', 'PHONE'], data: [[hash('a@example.com'), '']] })).toMatch(/hashed e-mails only/)
    expect(del({ schema: 'EMAIL_SHA256', data: Array(MEMBERS_PER_REQUEST + 1).fill(hash('a@example.com')) })).toMatch(/1 to 10000/)
    // Consent PR 2 — an add takes no session (review B1), a replace no less than its session.
    expect(problem({ url: `${BASE}/${AUDIENCE}/users`, objectKind: 'customaudience', body: form({ payload: PAYLOAD, session: SESSION }) })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/${AUDIENCE}/usersreplace`, objectKind: 'customaudience', body: form({ payload: PAYLOAD }) })).toMatch(/only Meta change/)
    // A DELETE of people without a body, or named as the account: refused.
    expect(problem({ url: `${BASE}/${AUDIENCE}/users`, method: 'DELETE', objectKind: 'customaudience' })).toMatch(/Nexus deletes on Meta only/)
    expect(problem({ url: `${BASE}/${AUDIENCE}/users`, method: 'DELETE', objectKind: 'adaccount', body: form({ payload: PAYLOAD }) })).toMatch(/Nexus deletes on Meta only/)
  })
  it('through the gateway: the body goes with the DELETE, and a refused one leaves no hash in the ledger', async () => {
    h.answers.push(json({ id: AUDIENCE, account_id: '1234567890', subtype: 'CUSTOM', time_created: 1700000000 }), json({ error: { code: 100, message: 'Invalid parameter' } }, 400))
    const res = await metaWriteCall({ connectionId: 'm-1', operation: 'audience.users.remove', objectId: AUDIENCE, objectKind: 'customaudience', edge: 'users', method: 'DELETE', params: { payload: PAYLOAD }, check: false })
    expect(res.ok).toBe(false)
    expect(res.verdict?.channelMessage).toBe('Invalid parameter')
    const del = h.calls[1]
    expect([del.init.method, new URL(del.url).pathname]).toEqual(['DELETE', `/v26.0/${AUDIENCE}/users`])
    expect(new URLSearchParams(String(del.init.body)).get('payload')).toBe(PAYLOAD)
    const row = gatewayLedger.at(-1)!
    const kept = JSON.stringify(row)
    expect(kept).not.toContain(hash('a@example.com'))
    expect(kept).not.toContain('example.com')
    expect(row.requestPayload).toMatchObject({ __personal: true })
    expect(row.responsePayload).toMatchObject({ __personal: true })
  })
  it('review A4 — an answer that is not Meta\'s error JSON is never kept as words: only Meta\'s own message fields', async () => {
    h.answers.push(json({ id: AUDIENCE, account_id: '1234567890', subtype: 'CUSTOM', time_created: 1700000000 }), () => new Response(`<html>${hash('a@example.com')}</html>`, { status: 502 }))
    const res = await metaWriteCall({ connectionId: 'm-1', operation: 'audience.users.remove', objectId: AUDIENCE, objectKind: 'customaudience', edge: 'users', method: 'DELETE', params: { payload: PAYLOAD }, check: false })
    expect(res.verdict?.channelMessage).toBe('Meta answered HTTP 502 without an error message.')
    expect(JSON.stringify(gatewayLedger.at(-1))).not.toContain(hash('a@example.com'))
  })
  it('opt out everywhere goes only to the chosen ad account', async () => {
    gatewayMetaChosen['m-1'] = '1234567890'
    const other = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: 'act_5555555555', objectKind: 'adaccount', edge: 'usersofanyaudience', method: 'DELETE', params: { payload: PAYLOAD }, check: false }).catch((e) => e)
    expect(other).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    expect(h.calls).toHaveLength(0)
    h.answers.push(json({ audience_id: '', session_id: '1', num_received: 2, num_invalid_entries: 0, invalid_entry_samples: {} }))
    const res = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'adaccount', edge: 'usersofanyaudience', method: 'DELETE', params: { payload: PAYLOAD }, check: false })
    expect(res.ok).toBe(true)
    expect([h.calls[0].init.method, new URL(h.calls[0].url).pathname]).toEqual(['DELETE', `/v26.0/${ACT}/usersofanyaudience`])
  })
})

describe('consent PR 2 — the people of a customer list IN: POST /users and a replace session, hashes only', () => {
  const add = (payload: unknown, extra: Record<string, string> = {}, objectKind = 'customaudience') => verdict({ url: `${BASE}/${AUDIENCE}/users`, objectKind, body: form({ payload: typeof payload === 'string' ? payload : JSON.stringify(payload), ...extra }) })
  const replace = (session: unknown, payload: unknown = JSON.parse(PAYLOAD)) => verdict({ url: `${BASE}/${AUDIENCE}/usersreplace`, objectKind: 'customaudience', body: form({ payload: JSON.stringify(payload), session: typeof session === 'string' ? session : JSON.stringify(session) }) })
  const no = (v: ReturnType<typeof verdict>) => ('problem' in v ? v.problem : null)
  const S = { session_id: 123456789, batch_seq: 1, last_batch_flag: true, estimated_num_total: 2 }

  it('an add: EMAIL_SHA256 hashes only, the payload only, into a custom audience; personal', () => {
    expect(add(JSON.parse(PAYLOAD))).toEqual({ write: { rule: 'audience.users.add', objectId: AUDIENCE, check: false, body: form({ payload: PAYLOAD }), budget: false, kinds: ['customaudience'], personal: true } })
    expect(no(add({ schema: 'EMAIL_SHA256', data: ['a@example.com'] }))).toMatch(/SHA-256 hash/)
    expect(no(add({ schema: 'PHONE_SHA256', data: [hash('a@example.com')] }))).toMatch(/hashed e-mails only/)
    expect(no(add({ schema: ['EMAIL', 'LOOKALIKE_VALUE'], data: [[hash('a@example.com'), 10]] }))).toMatch(/hashed e-mails only/)
    expect(no(add({ schema: 'EMAIL_SHA256', data: Array(MEMBERS_PER_REQUEST + 1).fill(hash('a@example.com')) }))).toMatch(/1 to 10000/)
    expect(no(add({ schema: 'EMAIL_SHA256', data: [] }))).toMatch(/1 to 10000/)
    expect(no(add({ schema: 'EMAIL_SHA256', data: [hash('a@example.com')], is_raw: true }))).toMatch(/hashed e-mails only/)
    expect(no(add(PAYLOAD.replace('{"', '{ "')))).toMatch(/one spelling only/)
    expect(no(add(JSON.parse(PAYLOAD), { namespace: 'x' }))).toMatch(/only Meta change/)
    // Never named as the ad account, nor as a campaign.
    expect(no(add(JSON.parse(PAYLOAD), {}, 'adaccount'))).toMatch(/only Meta change/)
    expect(no(add(JSON.parse(PAYLOAD), {}, 'campaign'))).toMatch(/only Meta change/)
  })
  it('a replace: its payload and ONE session — all four keys, a positive id, batch 1 to 10, a flag, a total', () => {
    expect(replace(S)).toEqual({ write: { rule: 'audience.users.replace', objectId: AUDIENCE, check: false, body: form({ payload: PAYLOAD, session: JSON.stringify(S) }), budget: false, kinds: ['customaudience'], personal: true } })
    expect(no(replace({ ...S, batch_seq: 10, last_batch_flag: false, estimated_num_total: 100_000 }))).toBeNull()
    const { last_batch_flag: _flag, ...three } = S
    expect(no(replace(three))).toMatch(/all four/)
    expect(no(replace({ ...S, extra: 1 }))).toMatch(/all four/)
    expect(no(replace({ ...S, session_id: 0 }))).toMatch(/session_id is a positive whole number/)
    expect(no(replace({ ...S, session_id: '123456789' }))).toMatch(/session_id is a positive whole number/)
    expect(no(replace({ ...S, session_id: 1.5 }))).toMatch(/session_id is a positive whole number/)
    expect(no(replace({ ...S, batch_seq: 0 }))).toMatch(/batch_seq is 1 to 10/)
    expect(no(replace({ ...S, batch_seq: 11 }))).toMatch(/batch_seq is 1 to 10/)
    expect(no(replace({ ...S, last_batch_flag: 'true' }))).toMatch(/last_batch_flag is true or false/)
    expect(no(replace({ ...S, estimated_num_total: 100_001 }))).toMatch(/estimated_num_total is 1 to 100000/)
    expect(no(replace(JSON.stringify(S).replace(':', ': ')))).toMatch(/one spelling only/)
    expect(no(replace(S, { schema: 'EMAIL_SHA256', data: ['b@example.com'] }))).toMatch(/SHA-256 hash/)
  })
  it('through the gateway: refused, nothing sent, while "Upload customer lists to Meta" is off or unreadable — asked for every add and replace', async () => {
    h.uploadsOn = false
    for (const [edge, params] of [['users', { payload: PAYLOAD }], ['usersreplace', { payload: PAYLOAD, session: SESSION }]] as const) {
      const res = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: AUDIENCE, objectKind: 'customaudience', edge, params, check: false }).catch((e) => e)
      expect(res).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
      expect(String(res.message ?? res.sentence ?? JSON.stringify(res))).toContain(NO_CONSENT.slice(0, 60))
    }
    expect(h.switchAsked).toBe(2)
    expect(h.calls).toHaveLength(0)
    // A switch Nexus cannot read counts as off.
    h.uploadsOn = true
    h.switchFails = true
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: AUDIENCE, objectKind: 'customaudience', edge: 'users', params: { payload: PAYLOAD }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    expect(h.calls).toHaveLength(0)
    h.switchFails = false
    h.switchAsked = 2
    // A removal never asks it.
    h.answers.push(json({ id: AUDIENCE, account_id: '1234567890', subtype: 'CUSTOM', time_created: 1700000000 }), json({ num_received: 2 }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: AUDIENCE, objectKind: 'customaudience', edge: 'users', method: 'DELETE', params: { payload: PAYLOAD }, check: false })).ok).toBe(true)
    expect(h.switchAsked).toBe(2)
  })
  it('switched on: step 31\'s owner check of the audience, then the POST; the ledger keeps no hash; another account\'s audience gets nothing', async () => {
    h.answers.push(json({ id: AUDIENCE, account_id: '5555555555', subtype: 'CUSTOM', time_created: 1700000000 }))
    const other = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: AUDIENCE, objectKind: 'customaudience', edge: 'users', params: { payload: PAYLOAD }, check: false }).catch((e) => e)
    expect(other).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    expect(h.calls.map((c) => c.init.method)).toEqual(['GET'])
    h.calls = []
    h.answers.push(json({ id: AUDIENCE, account_id: '1234567890', subtype: 'CUSTOM', time_created: 1700000000 }), json({ audience_id: AUDIENCE, session_id: '1', num_received: 2, num_invalid_entries: 0, invalid_entry_samples: { [hash('a@example.com')]: 'x' } }))
    const res = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: AUDIENCE, objectKind: 'customaudience', edge: 'usersreplace', params: { payload: PAYLOAD, session: SESSION }, check: false })
    expect(res.ok).toBe(true)
    const post = h.calls[1]
    expect([post.init.method, new URL(post.url).pathname]).toEqual(['POST', `/v26.0/${AUDIENCE}/usersreplace`])
    expect(new URLSearchParams(String(post.init.body)).get('session')).toBe(SESSION)
    const kept = JSON.stringify(gatewayLedger.at(-1))
    expect(kept).not.toContain(hash('a@example.com'))
    expect(kept).not.toContain('example.com')
    // The owner read of an upload also asks is_value_based (a removal's does not).
    expect(new URL(h.calls[0].url).searchParams.get('fields')).toBe('account_id,subtype,time_created,is_value_based')
  })
  it('review NIT 2 — defence in depth: the gateway sends people only into a CUSTOM list that is not value-based', async () => {
    for (const [answer, words] of [
      [{ id: AUDIENCE, account_id: '1234567890', subtype: 'WEBSITE', time_created: 1700000000 }, /is not a customer list \(subtype CUSTOM\)/],
      [{ id: AUDIENCE, account_id: '1234567890', subtype: 'CUSTOM', time_created: 1700000000, is_value_based: true }, /is a value-based customer list/],
    ] as const) {
      for (const [edge, params] of [['users', { payload: PAYLOAD }], ['usersreplace', { payload: PAYLOAD, session: SESSION }]] as const) {
        h.calls = []
        h.answers.push(json(answer))
        const res = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: AUDIENCE, objectKind: 'customaudience', edge, params, check: false }).catch((e) => e)
        expect(res).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
        expect(String(res.message)).toMatch(words)
        expect(h.calls.map((c) => c.init.method)).toEqual(['GET'])
      }
    }
    // A removal from a value-based list is not judged so (taking people out is always allowed).
    h.calls = []
    h.answers.push(json({ id: AUDIENCE, account_id: '1234567890', subtype: 'CUSTOM', time_created: 1700000000 }), json({ num_received: 2 }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: AUDIENCE, objectKind: 'customaudience', edge: 'users', method: 'DELETE', params: { payload: PAYLOAD }, check: false })).ok).toBe(true)
    expect(new URL(h.calls[0].url).searchParams.get('fields')).toBe('account_id,subtype,time_created')
  })
})

describe('the ids inside an audience change are the business\'s own', () => {
  it('a Page inside a rule is step 19\'s `page` (the chosen Page): another is refused, nothing is sent', async () => {
    gatewayMetaPage['m-1'] = '120000000000089'
    const page = { inclusions: { operator: 'or', rules: [{ event_sources: [{ id: PAGE, type: 'page' }], retention_seconds: 86400, filter: EVENT }] } }
    const err = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'adaccount', edge: 'customaudiences', params: { name: 'Fans A', rule: JSON.stringify(page) }, check: false }).catch((e) => e)
    expect(err).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/Page 120000000000080 is not the Facebook Page this business chose/) })
    expect(h.calls).toHaveLength(0)
    expect(h.idAsked).toEqual([])
    gatewayMetaPage['m-1'] = PAGE
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'adaccount', edge: 'customaudiences', params: { name: 'Fans A', rule: JSON.stringify(page) }, check: false })).ok).toBe(true)
  })
  it('merge — step 31\'s own kinds go to audience-ids.ts; step 22\'s `video` and step 28\'s `adaccount` keep main\'s checks', async () => {
    // A source video (step 31): audience-ids.ts as `video`; a share recipient: audience-ids.ts as `adaccount`.
    h.idProblems.set('120000000000090', 'That video is not in the chosen ad account\'s library or on the chosen Facebook Page, so it is not read.')
    const video = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'adaccount', edge: 'customaudiences', params: { name: 'Viewers A', subtype: 'ENGAGEMENT', rule: '[{"object_id":"120000000000090","event_name":"video_watched"}]' }, check: false }).catch((e) => e)
    expect(video).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/inside this change, That video is not/) })
    h.answers.push(json({ id: AUDIENCE, account_id: '1234567890', subtype: 'CUSTOM', time_created: 1700000000 }))
    await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: AUDIENCE, objectKind: 'customaudience', edge: 'ad_accounts', params: { adaccounts: '["1234567891"]' }, check: false })
    expect(h.idAsked).toEqual([{ id: '120000000000090', kind: 'video' }, { id: '1234567891', kind: 'adaccount' }])
    // Step 22's `video` (a library removal) is listed in the ad account's library by main's own check — never audience-ids.ts.
    h.idAsked = []; h.calls = []
    h.answers.push(json({ data: [{ id: '120000000000095' }] }), json({ success: true }))
    const removal = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: 'act_1234567890', objectKind: 'adaccount', edge: 'advideos', method: 'DELETE', params: { video_id: '120000000000095' }, check: false }).catch((e) => e)
    expect(h.idAsked).toEqual([])
    expect(h.calls.some((c) => new URL(c.url).pathname === '/v26.0/act_1234567890/advideos' && (c.init.method ?? 'GET') === 'GET')).toBe(true)
    void removal
    // Step 28's `adaccount` (a lift cell's account) is exactly the chosen one by main's own check — never audience-ids.ts.
    h.idAsked = []; h.calls = []
    const T0 = 4_102_444_800
    const lift = {
      name: 'Lift', type: 'LIFT', start_time: String(T0), end_time: String(T0 + 86400), observation_end_time: String(T0 + 2 * 86400),
      cells: JSON.stringify([{ name: 'test', treatment_percentage: 90, control_percentage: 10, adaccounts: ['5555555555'] }]),
      objectives: JSON.stringify([{ name: 'Purchases', is_primary: true, type: 'CONVERSIONS', adspixels: [{ id: PIXEL, event_names: ['fb_pixel_purchase'] }] }]),
    }
    h.answers.push(json({ id: ACT, business: { id: '120000000000090' } }))
    const cell = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: '120000000000090', objectKind: 'business', edge: 'ad_studies', params: lift, check: false }).catch((e) => e)
    expect(cell).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/an ad account named is not the one this business chose/) })
    expect(h.idAsked).toEqual([])
    expect(h.calls.every((c) => (c.init.method ?? 'GET') === 'GET')).toBe(true)
  })
  it('a campaign or ad set a lookalike learns from: of the chosen account as either kind', async () => {
    gatewayMetaStored['120000000000001'] = { adAccountId: '1234567890', kind: 'adset' }
    gatewayMetaStored['120000000000002'] = { adAccountId: '5555555555', kind: 'campaign' }
    const spec = (ids: string[]) => JSON.stringify({ ratio: 0.02, origin_ids: ids, conversion_type: 'campaign_conversions' })
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'adaccount', edge: 'customaudiences', params: { name: 'Look A', subtype: 'LOOKALIKE', lookalike_spec: spec(['120000000000001']) }, check: false })).ok).toBe(true)
    const err = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'adaccount', edge: 'customaudiences', params: { name: 'Look B', subtype: 'LOOKALIKE', lookalike_spec: spec(['120000000000002']) }, check: false }).catch((e) => e)
    expect(err).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/not a campaign or ad set Nexus can confirm/) })
    expect(err.message).not.toContain('5555555555')
  })
  it('a recipient of a share is checked before the share goes', async () => {
    h.answers.push(json({ id: AUDIENCE, account_id: '1234567890', subtype: 'CUSTOM', time_created: 1700000000 }))
    h.idProblems.set('1234567891', 'ad account 1234567891 is one another business in Nexus uses: an audience is never shared across Nexus businesses.')
    const err = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: AUDIENCE, objectKind: 'customaudience', edge: 'ad_accounts', params: { adaccounts: '["1234567891"]' }, check: false }).catch((e) => e)
    expect(err).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/never shared across Nexus businesses/) })
    expect(h.calls.every((c) => c.init.method === 'GET')).toBe(true)
  })
  it('an audience of another ad account is never changed (its account_id)', async () => {
    h.answers.push(json({ id: AUDIENCE, account_id: '5555555555', subtype: 'CUSTOM', time_created: 1700000000 }))
    const err = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: AUDIENCE, objectKind: 'customaudience', params: {}, method: 'DELETE', check: false }).catch((e) => e)
    expect(err).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    expect(h.calls.map((c) => c.init.method)).toEqual(['GET'])
  })
})

describe('the rule judge on its own', () => {
  it('two filter levels at most, 100 leaves at most, an aggregation as documented', () => {
    const rule = (filter: unknown, aggregation?: unknown) => ({ inclusions: { operator: 'or', rules: [{ event_sources: [{ id: PIXEL, type: 'pixel' }], retention_seconds: 86400, filter, ...(aggregation ? { aggregation } : {}) }] } })
    const leaf = { field: 'url', operator: 'i_contains', value: 'x' }
    expect(audienceRuleProblem(rule({ operator: 'and', filters: [leaf, { operator: 'or', filters: [leaf] }] }))).toBeNull()
    expect(audienceRuleProblem(rule({ operator: 'and', filters: [{ operator: 'or', filters: [{ operator: 'or', filters: [leaf] }] }] }))).toMatch(/two levels/)
    expect(audienceRuleProblem(rule({ operator: 'and', filters: Array(101).fill(leaf) }))).toMatch(/1 to 100 filters/)
    expect(audienceRuleProblem(rule({ operator: 'and', filters: [leaf] }, { type: 'sum', field: 'value', operator: '>', value: 100 }))).toBeNull()
    expect(audienceRuleProblem(rule({ operator: 'and', filters: [leaf] }, { type: 'sum', operator: '>', value: 100 }))).toMatch(/names its field/)
    expect(audienceRuleProblem(rule({ operator: 'and', filters: [leaf] }, { type: 'count', operator: '>', value: 2, method: 'percentile' }))).toMatch(/in_range/)
    // Review B4 — the types that need Meta's undocumented config are not sent.
    expect(audienceRuleProblem(rule({ operator: 'and', filters: [leaf] }, { type: 'time_spent', field: 'x', operator: '>', value: 2 }))).toMatch(/aggregation type is one of count, sum, avg, min, max$/)
  })
})
