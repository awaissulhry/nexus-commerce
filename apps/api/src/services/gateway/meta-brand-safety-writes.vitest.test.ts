/**
 * Meta step 39 on the gateway — brand safety reaches Meta ONLY as its exact allow-list entries, and only for THIS
 * business's objects: an ad set's targeting may differ from its LIVE targeting (read by the gateway itself, in the same
 * one read as its owner and kind check) only in the brand-safety keys; the account's filter only on the chosen ad
 * account; block lists only of the chosen ad account or its own business portfolio (never a portfolio another business
 * in Nexus uses), shared only with another business's portfolio that is not a Nexus business's; a draft only one this
 * gateway saw made; the URL file only as Nexus writes it, as one multipart part; a DELETE's keys in its body; the content
 * block list CSV export only as its one PUT. Made-up ids only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, answers: [] as Array<() => Response>, events: [] as string[] }))
// Review A2 — which comes first, the call's rate slot or the gateway's own live read (a write's slot costs 3, a read's 1).
vi.mock('./rate.js', async (importActual) => {
  const real = await importActual<typeof import('./rate.js')>()
  return { ...real, takeToken: vi.fn(async (...args: Parameters<typeof real.takeToken>) => { h.events.push(`slot:${args[4] ?? 1}`); return real.takeToken(...args) }) }
})
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

import { gatewayLedger, gatewayMetaChosen, gatewayMetaPortfolio, gatewayMetaStored, gatewayMetaSharedPortfolios } from '../../test-support/gateway-stubs.js'
import { __rateTest } from './rate.js'
import { gatewayCall } from './gateway.js'
import { metaRestFileExport, metaWriteCall } from './meta.js'
import { metaReadOnlyProblem, metaWriteVerdict } from './meta-calls.js'
import { metaUrl } from './meta.js'
import { __metaObjectLimitsTest } from './meta-object-limits.js'
import { __brandSafetyOwnerTest } from './meta-brand-safety-owner.js'
import { blockListEntry, blockListFileOf, blockListFileProblem, targetingOutsideProblem, BRAND_SAFETY_TARGETING_KEYS } from './meta-brand-safety-rules.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../meta/api-version.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const AD_SET = '120000000000002'
const ACCOUNT = '1234567890'
const PORTFOLIO = '9876543210'
const LIST = '120000000000601'
const CBL = '120000000000701'
/** A catalog of the same portfolio: it answers `business` too, but is no content block list (review A1). */
const CATALOG = '120000000000901'
const portfolioLists = (...ids: string[]) => json({ data: ids.map((id) => ({ id })) })
const OTHER_PORTFOLIO = '5550000002'
const LIVE = { geo_locations: { countries: ['IT'] }, age_min: 18, flexible_spec: [{ interests: [{ id: '6003000000000', name: 'Motò' }] }], brand_safety_content_filter_levels: ['FEED_STANDARD'] }
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status })
const form = (params: Record<string, string>) => new URLSearchParams(params).toString()
const targetingBody = (t: unknown) => form({ targeting: JSON.stringify(t) })
const verdict = (input: Partial<Parameters<typeof metaWriteVerdict>[0]>) => metaWriteVerdict({ method: 'POST', url: `${BASE}/${AD_SET}`, kind: 'write', ...input })
const problem = (input: Partial<Parameters<typeof metaWriteVerdict>[0]>) => { const v = verdict(input); return 'problem' in v ? v.problem : null }
const sent = (i: number) => ({ method: h.calls[i].init.method, url: new URL(h.calls[i].url), body: h.calls[i].init.body, headers: h.calls[i].init.headers as Record<string, string> })
const adSetLive = (targeting: unknown = LIVE, account = ACCOUNT) => json({ id: AD_SET, account_id: account, optimization_goal: 'OFFSITE_CONVERSIONS', billing_event: 'IMPRESSIONS', targeting })
const brandSafety = (targeting: unknown) => metaWriteCall({ connectionId: 'm-1', operation: 'adset.brandSafety', objectId: AD_SET, objectKind: 'adsettargeting', params: { targeting: JSON.stringify(targeting) }, check: false })

beforeEach(() => {
  __rateTest.useMemory()
  __metaObjectLimitsTest.useMemory()
  __brandSafetyOwnerTest.reset()
  h.calls = []; h.answers = []; h.events = []; gatewayLedger.length = 0
  for (const record of [gatewayMetaChosen, gatewayMetaStored, gatewayMetaPortfolio]) for (const key of Object.keys(record)) delete (record as Record<string, unknown>)[key]
  gatewayMetaSharedPortfolios.clear()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    h.events.push(`${init.method}:${new URL(String(url)).pathname}`)
    return h.answers.shift()?.() ?? new Response(JSON.stringify({ success: true }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset(); __metaObjectLimitsTest.reset() })

describe('the brand-safety allow-list entries (metaWriteVerdict)', () => {
  it('an ad set\'s targeting: one JSON object in Nexus\'s one spelling, named an ad set; never without its kind, never another key', () => {
    const ok = verdict({ body: targetingBody(LIVE), objectKind: 'adsettargeting' })
    expect(ok).toMatchObject({ write: { rule: 'adset.brand_safety', objectId: AD_SET, kinds: ['adsettargeting'], targeting: { sent: LIVE } } })
    // Its own kind: an ad set's settings change (step 18) never takes targeting.
    expect(problem({ body: targetingBody(LIVE), objectKind: 'adset' })).toMatch(/only Meta change/)
    expect(problem({ body: targetingBody(LIVE) })).toMatch(/only Meta change Nexus sends is a status change/)
    expect(problem({ body: targetingBody(LIVE), objectKind: 'campaign' })).toMatch(/only Meta change/)
    expect(problem({ body: form({ targeting: JSON.stringify(LIVE).replace(':', ': ') }), objectKind: 'adsettargeting' })).toMatch(/one spelling only/)
    expect(problem({ body: form({ targeting: '[1]' }), objectKind: 'adsettargeting' })).toMatch(/one JSON object/)
    expect(problem({ body: form({ targeting: JSON.stringify(LIVE), status: 'PAUSED' }), objectKind: 'adsettargeting' })).toMatch(/only Meta change/)
    expect(problem({ body: form({ targeting: '{"custom_audiences":[{"id":123456789012345678}]}' }), objectKind: 'adsettargeting' })).toMatch(/one spelling only|exactly/)
    expect(problem({ body: form({ targeting: `{"a":"x${String.fromCharCode(7)}"}` }), objectKind: 'adsettargeting' })).toMatch(/printable text/)
    expect(problem({ body: form({ targeting: JSON.stringify({ zips: Array.from({ length: 12000 }, (_, i) => `IT:${i}`) }) }), objectKind: 'adsettargeting' })).toMatch(/at most 200000 characters/)
  })
  it('the account\'s filter: documented levels only, one per placement, on act_<id> named an ad account', () => {
    const url = `${BASE}/act_${ACCOUNT}/brand_safety_content_filter_levels`
    expect(verdict({ url, body: form({ brand_safety_content_filter_levels: '["FACEBOOK_STRICT","FEED_STANDARD"]' }), objectKind: 'adaccount' })).toMatchObject({ write: { rule: 'adaccount.brand_safety_filter', objectId: `act_${ACCOUNT}` } })
    expect(problem({ url, body: form({ brand_safety_content_filter_levels: '["FEED_SELECT"]' }), objectKind: 'adaccount' })).toMatch(/one to three of/)
    expect(problem({ url, body: form({ brand_safety_content_filter_levels: '["FEED_STRICT","FEED_RELAXED"]' }), objectKind: 'adaccount' })).toMatch(/one level per placement/)
    expect(problem({ url, body: form({ brand_safety_content_filter_levels: '[]' }), objectKind: 'adaccount' })).toMatch(/one to three/)
    expect(problem({ url, body: form({ brand_safety_content_filter_levels: '[ "FEED_STRICT" ]' }), objectKind: 'adaccount' })).toMatch(/one spelling/)
    expect(problem({ url, body: form({ brand_safety_content_filter_levels: '["FEED_STRICT"]', business_id: PORTFOLIO }), objectKind: 'adaccount' })).toMatch(/only Meta change/)
    expect(problem({ url, body: form({ brand_safety_content_filter_levels: '["FEED_STRICT"]' }) })).toMatch(/only Meta change/)
  })
  it('the URL file: one multipart part Nexus wrote, judged line by line; never another field, path or a file elsewhere', () => {
    const url = `${BASE}/${PORTFOLIO}/block_list_drafts`
    const file = blockListFileOf(['Example.com', 'https://www.facebook.com/a-page', 'example.com'])
    expect(file).toEqual({ text: 'example.com\nhttps://www.facebook.com/a-page', entries: ['example.com', 'https://www.facebook.com/a-page'] })
    const text = (file as { text: string }).text
    // The merge with step 23: the text and its name go as form keys; the gateway makes them the ONE file part (MetaWriteRule.file).
    const body = form({ publisher_urls_file: text, publisher_urls_file_name: 'publisher_urls.txt' })
    expect(verdict({ url, body, objectKind: 'business' })).toMatchObject({ write: { rule: 'blocklist.draft', objectId: PORTFOLIO, body: '', bulky: true, multipart: { fields: [], file: { key: 'publisher_urls_file', filename: 'publisher_urls.txt', contentType: 'text/plain', text } } } })
    expect(problem({ url, body: form({ publisher_urls_file: text, publisher_urls_file_name: 'publisher_urls.txt', name: 'x' }), objectKind: 'business' })).toMatch(/only Meta change/)
    expect(problem({ url, objectKind: 'business', body: 'publisher_urls_file=example.com' })).toMatch(/only Meta change/)
    expect(problem({ url, body: form({ publisher_urls_file: text, publisher_urls_file_name: 'other.txt' }), objectKind: 'business' })).toMatch(/not a file name this change sends/)
    expect(problem({ url, body: form({ publisher_urls_file: 'http://example.com', publisher_urls_file_name: 'publisher_urls.txt' }), objectKind: 'business' })).toMatch(/block-list file/)
    expect(problem({ url: `${BASE}/${PORTFOLIO}/publisher_block_lists`, body, objectKind: 'business' })).toMatch(/only Meta change/)
    expect(problem({ url, body })).toMatch(/only Meta change/)
    for (const bad of ['Example.com', 'http://example.com', 'https://user:pw@example.com', 'https://example.com/?access_token=EAAAAAAAAAAAAAAAAAAAAAAAAA', 'https://example.com/x?sig=1',
      'https://example.com:8443/x', 'example.com\nexample.com', '', 'https://example.com/#top', 'ftp://example.com', 'exa mple.com']) {
      expect(blockListFileProblem(bad), bad).not.toBeNull()
    }
    expect(blockListFileProblem(Array.from({ length: 251 }, (_, i) => `site${i}.example.com`).join('\n'))).toMatch(/1 to 250 lines/)
    expect(blockListEntry('https://play.google.com/store/apps/details?id=com.example.app')).toEqual({ entry: 'https://play.google.com/store/apps/details?id=com.example.app' })
    expect(blockListEntry('www.facebook.com/a-page')).toEqual({ entry: 'https://www.facebook.com/a-page' })
    expect(blockListFileOf(Array.from({ length: 251 }, (_, i) => `site${i}.example.com`))).toMatchObject({ problem: expect.stringMatching(/at most 250/) })
  })
  it('a list from a draft: name (any printable text) and the draft; a replace names the list; both ids go to the owner check', () => {
    const url = `${BASE}/${PORTFOLIO}/publisher_block_lists`
    expect(verdict({ url, body: form({ name: 'Liste sûre', draft_id: '120000000000801' }), objectKind: 'business' })).toMatchObject({ write: { rule: 'blocklist.create', ids: [{ id: '120000000000801', kind: 'blocklistdraft' }] } })
    expect(verdict({ url, body: form({ name: 'List A', draft_id: '120000000000801', block_list_id: LIST }), objectKind: 'business' })).toMatchObject({ write: { ids: [{ id: '120000000000801', kind: 'blocklistdraft' }, { id: LIST, kind: 'publisherblocklist' }] } })
    expect(problem({ url, body: form({ name: `List${String.fromCharCode(1)}`, draft_id: '1' }), objectKind: 'business' })).toMatch(/printable text/)
    expect(problem({ url, body: form({ name: ' List', draft_id: '1' }), objectKind: 'business' })).toMatch(/no space at either end/)
    expect(problem({ url, body: form({ name: 'List', draft_id: 'x1' }), objectKind: 'business' })).toMatch(/draft_id is a Meta id/)
    expect(problem({ url, body: form({ name: 'List' }), objectKind: 'business' })).toMatch(/only Meta change/)
  })
  it('DELETEs: a list or a content list with no body; an unshare, a person, posts or an ad account with their keys in the body', () => {
    expect(verdict({ method: 'DELETE', url: `${BASE}/${LIST}`, objectKind: 'publisherblocklist' })).toMatchObject({ write: { rule: 'blocklist.delete', method: 'DELETE', body: '' } })
    expect(problem({ method: 'DELETE', url: `${BASE}/${LIST}`, objectKind: 'publisherblocklist', body: 'agency_id=1' })).toMatch(/Nexus deletes on Meta only/)
    expect(verdict({ method: 'DELETE', url: `${BASE}/${LIST}/agencies`, objectKind: 'publisherblocklist', body: form({ agency_id: OTHER_PORTFOLIO }) })).toMatchObject({ write: { rule: 'blocklist.unshare', method: 'DELETE', body: `agency_id=${OTHER_PORTFOLIO}` } })
    expect(problem({ method: 'DELETE', url: `${BASE}/${LIST}/agencies`, objectKind: 'publisherblocklist' })).toMatch(/Nexus deletes on Meta only/)
    expect(verdict({ method: 'DELETE', url: `${BASE}/${CBL}/content`, objectKind: 'contentblocklist', body: form({ facebook_ids: '["120000000000901_120000000000902"]' }) })).toMatchObject({ write: { rule: 'contentblocklist.remove', method: 'DELETE' } })
    expect(verdict({ method: 'DELETE', url: `${BASE}/${CBL}/applied_ad_accounts`, objectKind: 'contentblocklist', body: form({ account_id: ACCOUNT }) })).toMatchObject({ write: { ids: [{ id: ACCOUNT, kind: 'adaccount' }] } })
    // Since step 22 (main): an ad set's DELETE is step 19's object.delete rule (the undo of a create, or an explicit ask).
    expect(verdict({ method: 'DELETE', url: `${BASE}/${AD_SET}`, objectKind: 'adset' })).toMatchObject({ write: { rule: 'object.delete', method: 'DELETE' } })
    expect(problem({ method: 'DELETE', url: `${BASE}/${AD_SET}` })).toMatch(/cancels no async batch/)
  })
  it('shares, roles, ad accounts and posts: exact keys and values', () => {
    const share = (body: Record<string, string>) => problem({ url: `${BASE}/${LIST}/agencies`, objectKind: 'publisherblocklist', body: form(body) })
    expect(share({ agency_id: OTHER_PORTFOLIO, permitted_roles: '["APPLY_BLOCK_LIST"]' })).toBeNull()
    expect(verdict({ url: `${BASE}/${LIST}/agencies`, objectKind: 'publisherblocklist', body: form({ agency_id: OTHER_PORTFOLIO, permitted_roles: '["MANAGE_BLOCK_LIST"]' }) })).toMatchObject({ write: { ids: [{ id: OTHER_PORTFOLIO, kind: 'agency' }] } })
    expect(share({ agency_id: OTHER_PORTFOLIO, permitted_roles: "['APPLY_BLOCK_LIST']" })).toMatch(/permitted_roles/)
    expect(share({ agency_id: OTHER_PORTFOLIO, permitted_roles: '["APPLY_BLOCK_LIST","MANAGE_BLOCK_LIST"]' })).toMatch(/permitted_roles/)
    expect(share({ agency_id: OTHER_PORTFOLIO })).toMatch(/only Meta change/)
    const apply = (body: Record<string, string>) => verdict({ url: `${BASE}/${LIST}/auto_applied_ad_accounts`, objectKind: 'publisherblocklist', body: form(body) })
    expect(apply({ account_id: ACCOUNT, is_auto_blocking_on: 'true', business_id: PORTFOLIO })).toMatchObject({ write: { ids: [{ id: ACCOUNT, kind: 'adaccount' }, { id: PORTFOLIO, kind: 'business' }] } })
    expect(problem({ url: `${BASE}/${LIST}/auto_applied_ad_accounts`, objectKind: 'publisherblocklist', body: form({ account_id: ACCOUNT, is_auto_blocking_on: '*true*' }) })).toMatch(/is_auto_blocking_on/)
    const posts = (body: Record<string, string>) => problem({ url: `${BASE}/${CBL}/content`, objectKind: 'contentblocklist', body: form(body) })
    expect(posts({ instagram_ids: '["17800000000000001"]', threads_ids: '["17900000000000001"]' })).toBeNull()
    expect(posts({ instagram_ids: '["1_2"]' })).toMatch(/instagram_ids/)
    expect(posts({ facebook_ids: '[]' })).toMatch(/1 to 250/)
    expect(posts({ facebook_ids: JSON.stringify(Array.from({ length: 251 }, (_, i) => String(1000 + i))) })).toMatch(/1 to 250/)
    expect(posts({})).toMatch(/form body/)
    expect(problem({ url: `${BASE}/${CBL}`, objectKind: 'contentblocklist', body: form({ name: 'Liste B' }) })).toBeNull()
    expect(problem({ url: `${BASE}/${CBL}`, objectKind: 'publisherblocklist', body: form({ name: 'Liste B' }) })).toMatch(/only Meta change/)
  })
})

describe('an ad set\'s targeting against its LIVE targeting (Q7)', () => {
  const keys = new Set(BRAND_SAFETY_TARGETING_KEYS)
  it('every key but the brand-safety ones must be exactly the live one: none changed, added or dropped; effective_ keys never sent', () => {
    expect(targetingOutsideProblem(LIVE, { ...LIVE, brand_safety_content_filter_levels: ['FEED_STRICT'], excluded_publisher_categories: ['dating'] }, keys)).toBeNull()
    expect(targetingOutsideProblem(LIVE, { ...LIVE, age_min: 21 }, keys)).toMatch(/targeting.age_min differs/)
    expect(targetingOutsideProblem(LIVE, { ...LIVE, geo_locations: { countries: ['IT', 'DE'] } }, keys)).toMatch(/geo_locations differs/)
    expect(targetingOutsideProblem(LIVE, { ...LIVE, age_max: 65 }, keys)).toMatch(/age_max is not in the ad set's live targeting/)
    const { flexible_spec: _dropped, ...rest } = LIVE
    expect(targetingOutsideProblem(LIVE, rest, keys)).toMatch(/flexible_spec of the ad set's live targeting is missing/)
    expect(targetingOutsideProblem({ ...LIVE, effective_publisher_platforms: ['facebook'] }, LIVE, keys)).toBeNull()
    expect(targetingOutsideProblem(LIVE, { ...LIVE, effective_publisher_platforms: ['facebook'] }, keys)).toMatch(/read-only/)
    // A brand-safety key Meta wrote with an undocumented value goes back as it is; Nexus never SETS one.
    expect(targetingOutsideProblem({ ...LIVE, brand_safety_content_filter_levels: ['FEED_SELECT'] }, { ...LIVE, brand_safety_content_filter_levels: ['FEED_SELECT'], excluded_publisher_categories: ['gambling'] }, keys)).toBeNull()
    expect(targetingOutsideProblem(LIVE, { ...LIVE, brand_safety_content_filter_levels: ['FEED_SELECT'] }, keys)).toMatch(/one level per placement|at most three of/)
    expect(targetingOutsideProblem(LIVE, { ...LIVE, excluded_publisher_categories: ['news'] }, keys)).toMatch(/excluded_publisher_categories lists/)
  })
  it('the gateway reads the ad set itself (even one in Nexus\'s rows), then sends the judged targeting once', async () => {
    gatewayMetaStored[AD_SET] = { adAccountId: ACCOUNT, kind: 'adset' }
    h.answers.push(adSetLive(), json({ success: true }))
    const next = { ...LIVE, brand_safety_content_filter_levels: ['FEED_STRICT'], excluded_publisher_categories: ['gambling'] }
    const res = await brandSafety(next)
    expect(res.ok).toBe(true)
    expect(h.calls.map((c) => c.init.method)).toEqual(['GET', 'POST'])
    // Review A2: the write holds its slot first, THEN the live targeting is read, right before the send.
    expect(h.events).toEqual(['slot:3', 'slot:1', `GET:/v26.0/${AD_SET}`, `POST:/v26.0/${AD_SET}`])
    expect(sent(0).url.pathname).toBe(`/v26.0/${AD_SET}`)
    expect(sent(0).url.searchParams.get('fields')).toBe('account_id,optimization_goal,billing_event,targeting')
    expect(sent(1).body).toBe(targetingBody(next))
    expect(sent(1).headers['Content-Type']).toBe('application/x-www-form-urlencoded')
  })
  it('refused, nothing sent: another business\'s ad set, an ad set whose other targeting moved, no live read, writes off', async () => {
    h.answers.push(adSetLive(LIVE, '5555555555'))
    const other = await brandSafety({ ...LIVE, excluded_publisher_categories: ['dating'] }).catch((e) => e)
    expect(other).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    expect(other.message).not.toContain('5555555555')
    h.answers.push(adSetLive({ ...LIVE, age_min: 25 }))
    expect(await brandSafety({ ...LIVE, excluded_publisher_categories: ['dating'] }).catch((e) => e)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/age_min differs/) })
    h.answers.push(json({ error: { code: 100, message: 'Tried accessing nonexisting field (optimization_goal) on node type (Campaign)' } }, 400))
    expect(await brandSafety(LIVE).catch((e) => e)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not an ad set/) })
    h.answers.push(json({ error: { code: 1, message: 'Unknown error' } }, 500))
    expect(await brandSafety(LIVE).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_UNCONFIRMED' })
    h.answers.push(json({ id: AD_SET, account_id: ACCOUNT, optimization_goal: 'REACH', billing_event: 'IMPRESSIONS' }))
    expect(await brandSafety(LIVE).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_UNCONFIRMED', message: expect.stringMatching(/no targeting/) })
    expect(h.calls.every((c) => c.init.method === 'GET')).toBe(true)
    vi.stubEnv('NEXUS_META_ADS_WRITES', 'off')
    expect(await brandSafety(LIVE).catch((e) => e)).toMatchObject({ outcome: 'gated', code: 'PUBLISH_GATED' })
  })
  it('review A7 — a live answer the gateway had to scrub (a token-shaped value) is never sent back as Meta\'s: refused', async () => {
    const scrubbed = { ...LIVE, flexible_spec: [{ interests: [{ id: '6003000000000', name: `EAA${'B'.repeat(30)}` }] }] }
    h.answers.push(adSetLive(scrubbed))
    expect(await brandSafety({ ...LIVE, excluded_publisher_categories: ['dating'] }).catch((e) => e)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/shaped like a token, which Nexus removed/) })
    expect(h.calls.map((c) => c.init.method)).toEqual(['GET'])
  })
  it('review B1 — subscriber_universe is read-only like effective_ keys: dropped from what is sent, never sent', () => {
    const keys = new Set(BRAND_SAFETY_TARGETING_KEYS)
    const live = { ...LIVE, subscriber_universe: { messaging_customer_base_for_whatsapp: { id: '1', name: 'Base A' } } }
    expect(targetingOutsideProblem(live, LIVE, keys)).toBeNull()
    expect(targetingOutsideProblem(live, live, keys)).toMatch(/subscriber_universe is read-only/)
  })
  it('a block list newly excluded must be one the chosen ad account may use (owned, or listed for it); one kept is not read again', async () => {
    const withList = (ids: string[]) => ({ ...LIVE, excluded_publisher_list_ids: ids })
    h.answers.push(adSetLive(withList(['120000000000600'])), json({ id: LIST, owner_ad_account_id: `act_${ACCOUNT}` }), json({ success: true }))
    expect((await brandSafety(withList(['120000000000600', LIST]))).ok).toBe(true)
    expect(sent(1).url.pathname).toBe(`/v26.0/${LIST}`)
    expect(sent(1).url.searchParams.get('fields')).toBe('id,business_owner_id,owner_ad_account_id')
    h.calls = []
    __metaObjectLimitsTest.useMemory()
    // Another business's list, not listed for the chosen ad account: refused.
    h.answers.push(adSetLive(LIVE), json({ id: LIST, owner_ad_account_id: 'act_5555555555', business_owner_id: OTHER_PORTFOLIO }), json({ data: [{ id: '120000000000600' }] }))
    expect(await brandSafety(withList([LIST])).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/inside this change, publisher block list/) })
    expect(sent(2).url.pathname).toBe(`/v26.0/act_${ACCOUNT}/publisher_block_lists`)
    expect(h.calls.map((c) => c.init.method)).toEqual(['GET', 'GET', 'GET'])
    // …but one Meta lists for the chosen ad account (shared with it) may be applied.
    h.calls = []
    h.answers.push(adSetLive(LIVE), json({ id: LIST, owner_ad_account_id: 'act_5555555555' }), json({ data: [{ id: LIST }] }), json({ success: true }))
    expect((await brandSafety(withList([LIST]))).ok).toBe(true)
  })
})

describe('owners of the account, portfolio and lists', () => {
  const call = (path: string, objectKind: Parameters<typeof metaWriteCall>[0]['objectKind'], params: Record<string, string>, method?: 'DELETE') =>
    metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: path.split('/')[0], edge: (path.split('/')[1] as never) || undefined, objectKind, params, check: false, ...(method ? { method } : {}) })
  it('the account\'s filter only on the chosen ad account (no read needed)', async () => {
    expect((await call(`act_${ACCOUNT}/brand_safety_content_filter_levels`, 'adaccount', { brand_safety_content_filter_levels: '["FEED_STRICT"]' })).ok).toBe(true)
    expect(h.calls.map((c) => [c.init.method, sent(0).url.pathname])).toEqual([['POST', `/v26.0/act_${ACCOUNT}/brand_safety_content_filter_levels`]])
    expect(await call('act_1234567891/brand_safety_content_filter_levels', 'adaccount', { brand_safety_content_filter_levels: '["FEED_STRICT"]' }).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
  })
  it('the portfolio: only the chosen ad account\'s own, never one another business in Nexus uses, never when there is none', async () => {
    expect((await call(`${PORTFOLIO}/content_block_lists`, 'business', { name: 'List A' })).ok).toBe(true)
    expect(await call(`${OTHER_PORTFOLIO}/content_block_lists`, 'business', { name: 'List A' }).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/not the chosen ad account's own/) })
    gatewayMetaSharedPortfolios.add(PORTFOLIO)
    expect(await call(`${PORTFOLIO}/content_block_lists`, 'business', { name: 'List B' }).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/also used by another business in Nexus/) })
    gatewayMetaSharedPortfolios.clear()
    gatewayMetaPortfolio['m-1'] = null
    expect(await call(`${PORTFOLIO}/content_block_lists`, 'business', { name: 'List C' }).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/names no business portfolio/) })
    expect(h.calls).toHaveLength(1)
  })
  it('the URL file goes as ONE multipart part (the rule\'s key, name, type); a list is made only from a draft this gateway saw made here', async () => {
    const text = 'example.com\nexample.org'
    h.answers.push(json({ id: '120000000000801' }))
    const draft = await metaWriteCall({ connectionId: 'm-1', operation: 'blockList.draft', objectId: PORTFOLIO, edge: 'block_list_drafts', objectKind: 'business', params: { publisher_urls_file: text, publisher_urls_file_name: 'publisher_urls.txt' }, check: false, run: 'run-a' })
    expect(draft.ok).toBe(true)
    const upload = sent(0)
    expect(upload.method).toBe('POST')
    expect(upload.url.pathname).toBe(`/v26.0/${PORTFOLIO}/block_list_drafts`)
    expect(upload.headers['Content-Type']).toBeUndefined()
    expect(upload.body).toBeInstanceOf(FormData)
    const part = (upload.body as FormData).get('publisher_urls_file') as File
    expect([part.name, part.type, await part.text()]).toEqual(['publisher_urls.txt', 'text/plain', text])
    expect([...(upload.body as FormData).keys()]).toEqual(['publisher_urls_file'])
    expect(JSON.stringify(gatewayLedger)).not.toContain('example.org')
    // Review A9 — only the SAME run's draft, once: no run, another run, another connection, a second use are refused.
    const create = (run: string | undefined, connectionId = 'm-1', draftId = '120000000000801') => {
      __metaObjectLimitsTest.useMemory()
      return metaWriteCall({ connectionId, operation: 'x', objectId: PORTFOLIO, edge: 'publisher_block_lists', objectKind: 'business', params: { name: 'List A', draft_id: draftId }, check: false, ...(run ? { run } : {}) }).catch((e) => e)
    }
    gatewayMetaPortfolio['m-2'] = PORTFOLIO
    gatewayMetaChosen['m-2'] = ACCOUNT
    expect(await create(undefined)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not the one Nexus uploaded in this same run/) })
    expect(await create('run-b')).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    expect(await create('run-a', 'm-2')).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    expect(await create('run-a', 'm-1', '120000000000899')).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/draft 120000000000899 is not the one/) })
    expect(h.calls).toHaveLength(1)
    // The same run's own draft goes — once.
    expect((await create('run-a')).ok).toBe(true)
    expect(await create('run-a')).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/a draft is used once/) })
    expect(h.calls).toHaveLength(2)
    h.calls = []
    // A bad file never leaves Nexus.
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: PORTFOLIO, edge: 'block_list_drafts', objectKind: 'business', params: { publisher_urls_file: 'http://example.com', publisher_urls_file_name: 'publisher_urls.txt' }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    expect(h.calls).toHaveLength(0)
  })
  it('a publisher list: owned by the chosen ad account or its own portfolio; another business\'s is never changed (even one shared with it)', async () => {
    h.answers.push(json({ id: LIST, owner_ad_account_id: ACCOUNT }), json({ success: true }))
    expect((await call(`${LIST}/agencies`, 'publisherblocklist', { agency_id: OTHER_PORTFOLIO, permitted_roles: '["APPLY_BLOCK_LIST"]' })).ok).toBe(true)
    h.calls = []
    __metaObjectLimitsTest.useMemory()
    h.answers.push(json({ id: LIST, business_owner_id: PORTFOLIO }), json({ success: true }))
    expect((await call(LIST, 'publisherblocklist', {}, 'DELETE')).ok).toBe(true)
    // The merge with main: a DELETE without keys sends no form field (main's gateway passes its empty body on).
    expect(sent(1).method).toBe('DELETE')
    expect(sent(1).body ?? '').toBe('')
    h.calls = []
    __metaObjectLimitsTest.useMemory()
    gatewayMetaSharedPortfolios.add(PORTFOLIO)
    h.answers.push(json({ id: LIST, business_owner_id: PORTFOLIO }))
    expect(await call(LIST, 'publisherblocklist', {}, 'DELETE').catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    gatewayMetaSharedPortfolios.clear()
    h.answers.push(json({ id: LIST, owner_ad_account_id: '5555555555', business_owner_id: OTHER_PORTFOLIO }))
    expect(await call(`${LIST}/assigned_users`, 'publisherblocklist', { user: '100000000000001', permitted_roles: '["MANAGE_BLOCK_LIST"]' }).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    expect(h.calls.every((c) => c.init.method === 'GET')).toBe(true)
  })
  it('shared only with another business\'s portfolio — never this business\'s own, never one another business in Nexus uses', async () => {
    h.answers.push(json({ id: LIST, owner_ad_account_id: ACCOUNT }))
    expect(await call(`${LIST}/agencies`, 'publisherblocklist', { agency_id: PORTFOLIO, permitted_roles: '["APPLY_BLOCK_LIST"]' }).catch((e) => e)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/this business's own portfolio/) })
    gatewayMetaSharedPortfolios.add(OTHER_PORTFOLIO)
    h.answers.push(json({ id: LIST, owner_ad_account_id: ACCOUNT }))
    expect(await call(`${LIST}/agencies`, 'publisherblocklist', { agency_id: OTHER_PORTFOLIO, permitted_roles: '["APPLY_BLOCK_LIST"]' }).catch((e) => e)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/another business in Nexus uses/) })
    // Review A6 — an unshare is judged the same way.
    h.answers.push(json({ id: LIST, owner_ad_account_id: ACCOUNT }))
    expect(await call(`${LIST}/agencies`, 'publisherblocklist', { agency_id: OTHER_PORTFOLIO }, 'DELETE').catch((e) => e)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/inside this change, .*another business in Nexus uses/) })
    expect(h.calls.every((c) => c.init.method === 'GET')).toBe(true)
  })
  it('applied only to the chosen ad account, with its own portfolio; a DELETE carries its keys in its body', async () => {
    h.answers.push(json({ id: LIST, owner_ad_account_id: ACCOUNT }))
    expect(await call(`${LIST}/auto_applied_ad_accounts`, 'publisherblocklist', { account_id: '1234567891', is_auto_blocking_on: 'true' }).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/inside this change, 1234567891 is not the Meta ad account/) })
    h.answers.push(portfolioLists(CBL), json({ success: true }))
    expect((await call(`${CBL}/applied_ad_accounts`, 'contentblocklist', { account_id: ACCOUNT }, 'DELETE')).ok).toBe(true)
    expect(sent(h.calls.length - 2).url.pathname).toBe(`/v26.0/${PORTFOLIO}/content_block_lists`)
    const del = sent(h.calls.length - 1)
    expect([del.method, del.url.pathname, del.body, del.headers['Content-Type']]).toEqual(['DELETE', `/v26.0/${CBL}/applied_ad_accounts`, `account_id=${ACCOUNT}`, 'application/x-www-form-urlencoded'])
  })
  it('review A1 — a content block list is one Meta LISTS for the portfolio (every page): a catalog or custom conversion of the portfolio is refused for every change', async () => {
    const changes: Array<[string, Record<string, string>, ('DELETE' | undefined)?]> = [
      [CATALOG, { name: 'List B' }], [CATALOG, {}, 'DELETE'], [`${CATALOG}/content`, { facebook_ids: '["1"]' }], [`${CATALOG}/content`, { facebook_ids: '["1"]' }, 'DELETE'],
      [`${CATALOG}/applied_ad_accounts`, { account_id: ACCOUNT }], [`${CATALOG}/applied_ad_accounts`, { account_id: ACCOUNT }, 'DELETE'],
    ]
    for (const [path, params, method] of changes) {
      h.calls = []
      __metaObjectLimitsTest.useMemory()
      // Page 1 lists another list and says more follow; page 2 lists one more: the catalog is on neither.
      h.answers.push(() => new Response(JSON.stringify({ data: [{ id: CBL }], paging: { cursors: { after: 'p2' }, next: 'n' } })), portfolioLists('120000000000702'))
      expect(await call(path, 'contentblocklist', params, method).catch((e) => e), `${method ?? 'POST'} ${path}`).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/not one of the content block lists of the chosen ad account's business portfolio/) })
      expect(h.calls.map((c) => [c.init.method, sent(h.calls.indexOf(c)).url.searchParams.get('after')])).toEqual([['GET', null], ['GET', 'p2']])
    }
    // A listing Meta could not finish confirms nothing.
    h.calls = []
    __metaObjectLimitsTest.useMemory()
    h.answers.push(() => new Response(JSON.stringify({ data: [{ id: '120000000000702' }], paging: { cursors: { after: 'p2' }, next: 'n' } })), json({ error: { code: 1, message: 'Unknown error' } }, 500))
    expect(await call(`${CBL}/content`, 'contentblocklist', { facebook_ids: '["1"]' }).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_UNCONFIRMED' })
    // A custom conversion id: the export refuses it the same way, with no PUT.
    h.calls = []
    h.answers.push(portfolioLists(CBL))
    expect(await metaRestFileExport({ connectionId: 'm-1', operation: 'x', contentBlockListId: '120000000000902' }).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    expect(h.calls.map((c) => c.init.method)).toEqual(['GET'])
  })
})

describe('the content block list\'s CSV export (BS-033): the ONE PUT of Meta\'s REST host', () => {
  it('only the portfolio\'s own list: one Graph owner read, then the PUT with the token as a Bearer header, no body, no query, never retried', async () => {
    h.answers.push(portfolioLists(CBL), json({ content_block_list_id: CBL, download_url: 'https://example.com/f.csv?oh=abc&oe=def', file_metadata: { name: 'content_ids.csv', size_bytes: 100 } }))
    const res = await metaRestFileExport({ connectionId: 'm-1', operation: 'safety.contentBlockListFile', contentBlockListId: CBL })
    expect(res.ok).toBe(true)
    expect(h.calls.map((c) => c.init.method)).toEqual(['GET', 'PUT'])
    expect(sent(0).url.pathname).toBe(`/v26.0/${PORTFOLIO}/content_block_lists`)
    const put = sent(1)
    expect(`${put.url.host}${put.url.pathname}`).toBe(`api.facebook.com/content_block_lists/${CBL}/file_download`)
    expect([...put.url.searchParams.keys()]).toEqual([])
    expect(put.headers.Authorization).toBe('Bearer meta-system-user-token')
    expect(put.headers['X-API-Version']).toBe('1.0.0')
    expect(put.body).toBeUndefined()
    // A list the portfolio does not list: no PUT.
    h.calls = []
    h.answers.push(portfolioLists('120000000000702'))
    expect(await metaRestFileExport({ connectionId: 'm-1', operation: 'x', contentBlockListId: CBL }).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    expect(h.calls.map((c) => c.init.method)).toEqual(['GET'])
  })
  it('exactly that call: no query, no body, declared a read, the account\'s token; any other PUT is refused', async () => {
    const put = (url: string, extra: Record<string, unknown> = {}) => gatewayCall({ channel: 'META', operation: 'x', kind: 'read', connectionId: 'm-1', url, method: 'PUT', ...extra } as never).catch((e) => e)
    expect(await put(`https://api.facebook.com/content_block_lists/${CBL}/file_download?x=1`)).toMatchObject({ code: 'META_READ_ONLY' })
    expect(await put(`https://api.facebook.com/content_block_lists/${CBL}/file_download`, { body: 'x=1' })).toMatchObject({ code: 'META_READ_ONLY' })
    expect(await put(`https://api.facebook.com/content_block_lists/${CBL}/file_download`, { kind: 'write' })).toMatchObject({ code: 'META_READ_ONLY' })
    expect(await put(`https://api.facebook.com/content_block_lists/${CBL}/file_download`, { auth: 'app' })).toMatchObject({ code: 'META_READ_ONLY' })
    expect(await put('https://api.facebook.com/adjacent_content_delivery_reports/9876543210/file_download')).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    expect(await put(`${BASE}/${CBL}`)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    expect(h.calls).toHaveLength(0)
  })
})

describe('the reads step 39 makes pass the read gate as they are', () => {
  it('the ad set with its targeting, the account\'s filter, its delivering campaigns, a draft\'s status and every read-back', () => {
    const reads: Array<[string, Record<string, unknown>]> = [
      [AD_SET, { fields: 'id,name,account_id,status,optimization_goal,billing_event,campaign{id,name,status},targeting' }],
      [AD_SET, { fields: 'id,targeting' }],
      [`act_${ACCOUNT}`, { fields: 'id,brand_safety_content_filter_levels' }],
      [`act_${ACCOUNT}/campaigns`, { effective_status: ['ACTIVE'], fields: 'id', limit: 1 }],
      ['120000000000801', { fields: 'id,async_job_status,async_percent_completion' }],
      [`${LIST}/agencies`, { fields: 'id' }],
      [`${LIST}/auto_applied_ad_accounts`, { fields: 'id' }],
      [`${CBL}/applied_ad_accounts`, { fields: 'id,account_id' }],
      [LIST, { fields: 'id,name' }],
      [LIST, { fields: 'id,business_owner_id,owner_ad_account_id' }],
      [`act_${ACCOUNT}/publisher_block_lists`, { fields: 'id', limit: 100 }],
      [CBL, { fields: 'id,business' }],
    ]
    for (const [path, query] of reads) expect(metaReadOnlyProblem({ method: 'GET', url: metaUrl(path, query as never), kind: 'read' }), path).toBeNull()
  })
})
