/**
 * Meta step 32 on the gateway: the dataset, custom conversion and event source group changes reach Meta only on their
 * EXACT allow-list entries — keys per kind of object (named, then confirmed by signals-rule.ts), every value judged, JSON
 * in one spelling, a DELETE with a form body only for the two rules Meta documents that way (a dataset's ad account, a
 * partner) — and the gateway asks the ONE ownership rule (signals-rule.ts) before anything is sent. Step 17's status rule
 * and step 18's settings rules stay as they were. Made-up ids only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; init: RequestInit }>,
  problem: null as null | { code: string; sentence: string },
  asked: [] as Array<{ connectionId: string; rule: string; objectId: string; body: string; kind: string }>,
}))
vi.mock('../marketing/meta-ads/signals-rule.js', () => ({
  metaSignalsProblem: vi.fn(async (connectionId: string, write: { rule: string; objectId: string; body: string }, kind: string) => {
    h.asked.push({ connectionId, rule: write.rule, objectId: write.objectId, body: write.body, kind })
    return h.problem
  }),
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

import { gatewayLedger, gatewayMetaStored } from '../../test-support/gateway-stubs.js'
import { __rateTest } from './rate.js'
import { metaWriteCall } from './meta.js'
import { metaWriteVerdict } from './meta-calls.js'
import { isMetaSignalsKind, META_SIGNALS_KINDS } from './meta-signals-rules.js'
import { __metaObjectLimitsTest } from './meta-object-limits.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../meta/api-version.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const ACCOUNT = '1234567890'
const PORTFOLIO = '9876543210'
const PIXEL = '120000000000501'
const CC = '120000000000701'
const GROUP = '120000000000801'
const CAMPAIGN = '120000000000001'
const form = (o: Record<string, string>) => new URLSearchParams(o).toString()
const verdict = (path: string, objectKind: string | undefined, body?: Record<string, string> | string, method = 'POST') =>
  metaWriteVerdict({ method, url: `${BASE}/${path}`, kind: 'write', body: typeof body === 'string' ? body : body ? form(body) : undefined, objectKind })
const problem = (...a: Parameters<typeof verdict>) => { const v = verdict(...a); return 'problem' in v ? v.problem : null }
const rule = (...a: Parameters<typeof verdict>) => { const v = verdict(...a); return 'write' in v ? v.write.rule : `refused: ${v.problem}` }

beforeEach(() => {
  __rateTest.useMemory()
  __metaObjectLimitsTest.useMemory()
  h.calls = []; h.asked = []; h.problem = null; gatewayLedger.length = 0
  gatewayMetaStored[CAMPAIGN] = { adAccountId: ACCOUNT, kind: 'campaign' }
  vi.stubEnv('NEXUS_META_ADS_WRITES', 'on')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return new Response(JSON.stringify({ success: true }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset(); __metaObjectLimitsTest.reset() })

describe('the step 32 rules: exact keys per kind of object', () => {
  it('each change matches its own rule, and only for the kind it names', () => {
    expect(rule(`act_${ACCOUNT}/adspixels`, 'adaccount', { name: 'Shop A' })).toBe('dataset.create')
    expect(rule(`${PORTFOLIO}/adspixels`, 'business', { name: 'Shop A' })).toBe('dataset.createInBusiness')
    expect(rule('120000000000010/dataset', 'page', { dataset_name: 'Shop A chats' })).toBe('dataset.createForMessaging')
    expect(rule(PIXEL, 'pixel', { data_use_setting: 'ANALYTICS_ONLY' })).toBe('dataset.settings')
    expect(rule(`${PIXEL}/shared_accounts`, 'pixel', { account_id: ACCOUNT, business: PORTFOLIO })).toBe('dataset.connectAccount')
    expect(rule(`${PIXEL}/agencies`, 'pixel', { business: '5555', permitted_tasks: '["ANALYZE"]' })).toBe('dataset.sharePartner')
    expect(rule(`${PIXEL}/assigned_users`, 'pixel', { user: '777', tasks: '["ADVERTISE"]' })).toBe('dataset.assignPerson')
    expect(rule(`${PORTFOLIO}/event_source_groups`, 'business', { event_sources: `["${PIXEL}"]`, name: 'Group A' })).toBe('eventSourceGroup.create')
    expect(rule(GROUP, 'eventsourcegroup', { name: 'Group B' })).toBe('eventSourceGroup.update')
    expect(rule(`${GROUP}/shared_accounts`, 'eventsourcegroup', { accounts: `["${ACCOUNT}"]` })).toBe('eventSourceGroup.share')
    expect(rule(`act_${ACCOUNT}/customconversions`, 'adaccount', { name: 'Thanks', event_source_id: PIXEL, rule: '{"url":{"i_contains":"thank-you"}}', custom_event_type: 'PURCHASE' })).toBe('customConversion.create')
    expect(rule(CC, 'customconversion', { default_conversion_value: '12.5' })).toBe('customConversion.update')
    expect(rule(`${PORTFOLIO}/claim_custom_conversions`, 'business', { custom_conversion_id: CC })).toBe('customConversion.claim')
    // The same bodies named another kind, or no kind: refused.
    expect(problem(PIXEL, 'campaign', { data_use_setting: 'ANALYTICS_ONLY' })).toMatch(/only Meta change/)
    expect(problem(PIXEL, undefined, { name: 'Shop A' })).toMatch(/only Meta change/)
    expect(problem(CC, 'pixel', { default_conversion_value: '12.5' })).toMatch(/only Meta change/)
    expect(problem(`act_${ACCOUNT}/adspixels`, 'business', { name: 'Shop A' })).toMatch(/only Meta change/)
    expect(problem(`${PORTFOLIO}/adspixels`, 'adaccount', { name: 'Shop A' })).toMatch(/only Meta change/)
  })
  it('no extra key, no duplicate, nothing on the URL, no Meta check', () => {
    expect(problem(PIXEL, 'pixel', { name: 'Shop A', server_events_business_ids_add: '["1"]' })).toMatch(/only Meta change/)
    expect(problem(PIXEL, 'pixel', 'name=Shop+A&name=Shop+B')).toMatch(/more than once/)
    expect(problem(`act_${ACCOUNT}/customconversions`, 'adaccount', { name: 'X', event_source_id: PIXEL, rule: '{"url":{"eq":"a"}}', custom_event_type: 'PURCHASE', advanced_rule: '{}' })).toMatch(/only Meta change/)
    expect(problem(CC, 'customconversion', { rule: '{"url":{"eq":"a"}}' })).toMatch(/only Meta change/)
    expect(metaWriteVerdict({ method: 'POST', url: `${BASE}/${PIXEL}?name=x`, kind: 'write', body: form({ name: 'Shop A' }), objectKind: 'pixel' })).toMatchObject({ problem: expect.stringMatching(/never in the URL/) })
    expect(problem(PIXEL, 'pixel', { name: 'Shop A', execution_options: '["validate_only"]' })).toMatch(/only Meta change/)
    expect(problem(`${PIXEL}%2Fagencies`, 'pixel', { business: '5555', permitted_tasks: '["ANALYZE"]' })).toMatch(/percent-encoded/)
  })
  it('values: enums, ids, JSON lists in one spelling, each once; the rule in its one shape; the value as a plain decimal', () => {
    expect(problem(PIXEL, 'pixel', { first_party_cookie_status: 'ON' })).toMatch(/first_party_cookie_status is one of/)
    expect(problem(PIXEL, 'pixel', { automatic_matching_fields: '["em", "ph"]' })).toMatch(/one spelling/)
    expect(problem(PIXEL, 'pixel', { automatic_matching_fields: '["em","em"]' })).toMatch(/each once/)
    expect(problem(PIXEL, 'pixel', { automatic_matching_fields: '["email"]' })).toMatch(/lists of em/)
    expect(problem(PIXEL, 'pixel', { server_events_business_ids: '[1]' })).toMatch(/business portfolio ids/)
    expect(rule(PIXEL, 'pixel', { server_events_business_ids: '[]' })).toBe('dataset.settings')
    expect(problem(`${PIXEL}/agencies`, 'pixel', { business: '5555', permitted_tasks: '["AA_ANALYZE"]' })).toMatch(/permitted_tasks lists of/)
    expect(problem(`${PIXEL}/shared_accounts`, 'pixel', { account_id: `act_${ACCOUNT}`, business: PORTFOLIO })).toMatch(/account_id is a Meta id/)
    expect(problem(`${GROUP}/shared_accounts`, 'eventsourcegroup', { accounts: `["${ACCOUNT}","5555"]` })).toMatch(/1 to 1/)
    const cc = (o: Record<string, string>) => problem(`act_${ACCOUNT}/customconversions`, 'adaccount', { name: 'X', event_source_id: PIXEL, custom_event_type: 'PURCHASE', rule: '{"url":{"eq":"a"}}', ...o })
    expect(cc({ rule: '{"url": {"eq": "a"}}' })).toMatch(/one spelling/)
    expect(cc({ rule: '{"url":{"regex_match":"thank.*"}}' })).toBeNull()
    expect(cc({ rule: '{"url":{"is_any":["a"]}}' })).toMatch(/not a custom conversion operator/)
    expect(cc({ default_conversion_value: '12.50' })).toMatch(/plain decimal/)
    expect(cc({ default_conversion_value: '-1' })).toMatch(/plain decimal/)
    expect(cc({ default_conversion_value: '12.5' })).toBeNull()
    expect(cc({ custom_event_type: 'PAGE_VIEW' })).toMatch(/custom_event_type is one of/)
    expect(cc({ action_source_type: 'WEBSITE' })).toMatch(/action_source_type is one of/)
  })
  it('text only where a person types it (a name, a description): no control or format character; everything else plain ASCII', () => {
    expect(rule(PIXEL, 'pixel', { name: 'Negozio è 🏍️' })).toBe('dataset.settings')
    expect(problem(PIXEL, 'pixel', { name: 'Shop‮A' })).toMatch(/printable text/)
    expect(problem(PIXEL, 'pixel', { name: ' Shop A' })).toMatch(/no space at either end/)
    expect(problem(`${PIXEL}/agencies`, 'pixel', { business: '5555', permitted_tasks: '["ANALYZE"] ' })).toMatch(/plain ASCII/)
  })
  it('DELETE: a form body only for a dataset\'s ad account and a partner; a custom conversion\'s with none; never a pixel itself', () => {
    expect(verdict(`${PIXEL}/shared_accounts`, 'pixel', { account_id: ACCOUNT, business: PORTFOLIO }, 'DELETE')).toEqual({
      write: { rule: 'dataset.disconnectAccount', objectId: PIXEL, check: false, body: `account_id=${ACCOUNT}&business=${PORTFOLIO}`, budget: false, kinds: ['pixel'], method: 'DELETE' },
    })
    expect(rule(`${PIXEL}/agencies`, 'pixel', { business: '5555' }, 'DELETE')).toBe('dataset.removePartner')
    expect(problem(`${PIXEL}/shared_accounts`, 'pixel', undefined, 'DELETE')).toMatch(/form body/)
    expect(problem(`${PIXEL}/agencies`, 'pixel', { business: '5555', extra: '1' }, 'DELETE')).toMatch(/only Meta change/)
    expect(verdict(CC, 'customconversion', undefined, 'DELETE')).toEqual({ write: { rule: 'customConversion.delete', objectId: CC, check: false, body: '', budget: false, kinds: ['customconversion'], method: 'DELETE' } })
    expect(problem(CC, 'customconversion', { name: 'x' }, 'DELETE')).toMatch(/deletes nothing on Meta yet/)
    expect(problem(PIXEL, 'pixel', undefined, 'DELETE')).toMatch(/deletes nothing on Meta yet/)
    expect(problem(`${PIXEL}/assigned_users`, 'pixel', { user: '777' }, 'DELETE')).toMatch(/deletes nothing on Meta yet/)
    expect(problem(`${GROUP}/shared_accounts`, 'eventsourcegroup', { accounts: `["${ACCOUNT}"]` }, 'DELETE')).toMatch(/deletes nothing on Meta yet/)
  })
  it('step 17 and step 18 are unchanged: a status change and a budget schedule delete still go as before', () => {
    expect(verdict(CAMPAIGN, 'campaign', { status: 'PAUSED' })).toEqual({ write: { rule: 'object.status', objectId: CAMPAIGN, check: false, body: 'status=PAUSED', budget: false } })
    expect(verdict('120000000000031', 'highdemandperiod', undefined, 'DELETE')).toEqual({ write: { rule: 'budget_schedule.delete', objectId: '120000000000031', check: false, body: '', budget: false, kinds: ['highdemandperiod'], method: 'DELETE' } })
    expect(problem('120000000000031', 'highdemandperiod', { budget_value: '1' }, 'DELETE')).toMatch(/deletes nothing on Meta yet/)
    expect(META_SIGNALS_KINDS.every(isMetaSignalsKind)).toBe(true)
    expect(isMetaSignalsKind('campaign')).toBe(false)
  })
})

describe('through the gateway: the ONE ownership rule is asked before anything is sent', () => {
  it('a dataset change asks it with the judged write and its kind, then sends the judged body', async () => {
    const res = await metaWriteCall({ connectionId: 'm-1', operation: 'dataset.settings', objectId: PIXEL, objectKind: 'pixel', params: { data_use_setting: 'ANALYTICS_ONLY' }, check: false })
    expect(res.ok).toBe(true)
    expect(h.asked).toEqual([{ connectionId: 'm-1', rule: 'dataset.settings', objectId: PIXEL, body: 'data_use_setting=ANALYTICS_ONLY', kind: 'pixel' }])
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).pathname, String(c.init.body)])).toEqual([['POST', `/v26.0/${PIXEL}`, 'data_use_setting=ANALYTICS_ONLY']])
  })
  it('its refusal: nothing is sent, the words come back', async () => {
    h.problem = { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: 'Nothing was sent to Meta: That pixel is also connected to an ad account another business in Nexus uses.' }
    const err = await metaWriteCall({ connectionId: 'm-1', operation: 'dataset.settings', objectId: PIXEL, objectKind: 'pixel', params: { name: 'Shop A' }, check: false }).catch((e) => e)
    expect(err).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/another business in Nexus/) })
    expect(h.calls).toEqual([])
  })
  it('an edge create goes on the edge; a DELETE with keys goes as DELETE with its form body; a custom conversion\'s DELETE with none', async () => {
    await metaWriteCall({ connectionId: 'm-1', operation: 'dataset.create', objectId: `act_${ACCOUNT}`, objectKind: 'adaccount', edge: 'adspixels', params: { name: 'Shop A' }, check: false })
    await metaWriteCall({ connectionId: 'm-1', operation: 'dataset.disconnectAccount', objectId: PIXEL, objectKind: 'pixel', edge: 'shared_accounts', method: 'DELETE', params: { account_id: ACCOUNT, business: PORTFOLIO }, check: false })
    await metaWriteCall({ connectionId: 'm-1', operation: 'customConversion.delete', objectId: CC, objectKind: 'customconversion', method: 'DELETE', params: {}, check: false })
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).pathname, c.init.body ?? null])).toEqual([
      ['POST', `/v26.0/act_${ACCOUNT}/adspixels`, 'name=Shop+A'],
      ['DELETE', `/v26.0/${PIXEL}/shared_accounts`, `account_id=${ACCOUNT}&business=${PORTFOLIO}`],
      // No keys: an empty body, as step 18's delete of a budget schedule.
      ['DELETE', `/v26.0/${CC}`, ''],
    ])
    expect((h.calls[1].init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(h.asked.map((a) => [a.rule, a.kind])).toEqual([['dataset.create', 'adaccount'], ['dataset.disconnectAccount', 'pixel'], ['customConversion.delete', 'customconversion']])
  })
  it('a campaign change never asks the step 32 rule (its own account check runs as before)', async () => {
    await metaWriteCall({ connectionId: 'm-1', operation: 'status.change', objectId: CAMPAIGN, objectKind: 'campaign', params: { status: 'PAUSED' }, check: false })
    expect(h.asked).toEqual([])
    expect(h.calls.map((c) => c.init.method)).toEqual(['POST'])
  })
  it('with Meta changes switched off nothing is sent and the rule is not even asked', async () => {
    vi.stubEnv('NEXUS_META_ADS_WRITES', 'off')
    const err = await metaWriteCall({ connectionId: 'm-1', operation: 'dataset.settings', objectId: PIXEL, objectKind: 'pixel', params: { name: 'Shop A' }, check: false }).catch((e) => e)
    expect(err).toMatchObject({ code: expect.stringMatching(/GATED|PUBLISH/) })
    expect(h.calls).toEqual([])
  })
})
