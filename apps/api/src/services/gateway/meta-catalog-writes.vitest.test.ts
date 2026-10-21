/**
 * Meta step 34 on the gateway: catalog changes reach Meta only on their EXACT allow-list entries — keys per edge and kind
 * (named, then confirmed), every value judged, JSON in one spelling with every key allow-listed at every depth — and only
 * for what is this business's: a catalog owned by the chosen ad account's portfolio (no other Nexus business's, shared with
 * none), a set / item / feed of one, the chosen portfolio for a new catalog, and each id inside a body. A DELETE's flag is a
 * rule of its own; earlier rules are untouched. Made-up ids only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; init: RequestInit }>,
  routes: new Map<string, unknown>(),
  taken: new Set<string>(),
  itemsRefusal: null as string | null,
  writerChecks: [] as Array<[string, unknown]>,
}))
// Review A3 — step 12's writer check, as the gateway runs it for an items delete, an item's delete and a catalog's delete.
vi.mock('../marketing/meta-ads/live.js', async (importActual) => ({
  ...(await importActual<typeof import('../marketing/meta-ads/live.js')>()),
  metaChosenAccount: vi.fn(async () => ({ connectionId: 'm-1', adAccountId: '1234567890', businessId: '120000000000090' })),
}))
vi.mock('../marketing/meta-ads/catalog-rule.js', async (importActual) => {
  const actual = await importActual<typeof import('../marketing/meta-ads/catalog-rule.js')>()
  const { MetaLiveRefusal } = await import('../marketing/meta-ads/live.js')
  return {
    ...actual,
    writableCatalog: vi.fn(async (_a: unknown, catalogId: string, purpose: unknown) => {
      h.writerChecks.push([catalogId, purpose])
      if (h.itemsRefusal) throw new MetaLiveRefusal(h.itemsRefusal)
      return { catalog: { catalogId }, writer: {}, fields: null }
    }),
  }
})
vi.mock('../marketing/meta-ads/taken.js', () => ({
  takenIds: vi.fn(async (_product: string, ids: string[]) => new Set(ids.filter((id) => h.taken.has(id)))),
  portfolioTaken: vi.fn(async (id: string) => (h.taken.has(id) ? { portfolioId: id, takenByAnotherBusiness: true, sentence: 'taken' } : null)),
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

import { gatewayLedger, gatewayMetaChosen, gatewayMetaPage } from '../../test-support/gateway-stubs.js'
import { __rateTest } from './rate.js'
import { metaWriteCall, type MetaWriteRequest } from './meta.js'
import { metaCallVerdict, metaWriteVerdict } from './meta-calls.js'
import { __metaObjectLimitsTest } from './meta-object-limits.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../meta/api-version.js'
import { META_FILTER_BODY_MAX, metaSetFilterProblem } from './meta-catalog-rules.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const V = `/${META_DEFAULT_GRAPH_API_VERSION}`
const ACT = 'act_1234567890'
const BUSINESS = '120000000000090'
const OTHER_BUSINESS = '120000000000091'
const CATALOG = '120000000000100'
const SEGMENT = '120000000000101'
const SET = '120000000000110'
const ITEM = '120000000000120'
const FEED = '120000000000130'
const PIXEL = '120000000000050'
const PAGE = '120000000000010'
const form = (o: Record<string, string>) => new URLSearchParams(o).toString()
const verdict = (input: { body?: unknown; objectKind?: string; url: string; method?: string; kind?: string }) =>
  metaWriteVerdict({ method: input.method ?? 'POST', url: input.url, kind: input.kind ?? 'write', body: input.body, objectKind: input.objectKind })
const problem = (input: Parameters<typeof verdict>[0]) => { const v = verdict(input); return 'problem' in v ? v.problem : null }
/** One change through the gateway; Meta's per-object 30-s limit and the rate bucket start fresh for each (a test sends several). */
const send = (req: Partial<MetaWriteRequest> & Pick<MetaWriteRequest, 'objectId' | 'objectKind' | 'params'>) => {
  __metaObjectLimitsTest.useMemory()
  __rateTest.useMemory()
  return metaWriteCall({ connectionId: 'm-1', operation: 'x', check: false, ...req }).catch((e) => e)
}

/** A GET answer by its path and fields (`<path>?<fields>`), else by its path; anything else: Meta refuses. */
function route(path: string, body: unknown, fields?: string) { h.routes.set(fields ? `${path}?${fields}` : path, body) }
function catalogNode(id: string, owner: string, segment = false) { route(id, { id, business: { id: owner }, is_catalog_segment: segment }, 'id,business{id},is_catalog_segment') }
function sharedWith(id: string, agencies: string[] = [], connected: string[] = [BUSINESS]) {
  route(`${id}/agencies`, { data: agencies.map((a) => ({ id: a })) })
  route(`${id}/connected_businesses`, { data: connected.map((a) => ({ id: a })) })
}
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

beforeEach(() => {
  __rateTest.useMemory()
  __metaObjectLimitsTest.useMemory()
  h.calls = []; h.routes = new Map(); h.taken = new Set(); h.itemsRefusal = null; h.writerChecks = []; gatewayLedger.length = 0
  for (const key of Object.keys(gatewayMetaChosen)) delete gatewayMetaChosen[key]
  for (const key of Object.keys(gatewayMetaPage)) delete gatewayMetaPage[key]
  route(ACT, { id: ACT, business: { id: BUSINESS } }, 'business{id}')
  catalogNode(CATALOG, BUSINESS)
  sharedWith(CATALOG)
  vi.stubEnv('NEXUS_META_ADS_WRITES', 'on')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    if ((init.method ?? 'GET') !== 'GET') return answer({ success: true })
    const u = new URL(String(url))
    const path = u.pathname.replace(`${V}/`, '')
    const body = h.routes.get(`${path}?${u.searchParams.get('fields') ?? ''}`) ?? h.routes.get(path)
    return body === undefined ? answer({ error: { code: 100, message: '(#100) Tried accessing nonexisting field' } }, 400) : answer(body)
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset(); __metaObjectLimitsTest.reset() })

const sent = () => h.calls.filter((c) => c.init.method !== 'GET').map((c) => [c.init.method, new URL(c.url).pathname, c.init.body ? String(c.init.body) : null])

describe('catalog.create and catalog.segment.create: POST /<portfolio>/owned_product_catalogs', () => {
  const url = `${BASE}/${BUSINESS}/owned_product_catalogs`
  it('takes a name and vertical commerce (and the display settings); a segment its parent and filter, the parent named for the check', () => {
    expect(verdict({ url, objectKind: 'catalogbusiness', body: form({ name: 'Catalog A', vertical: 'commerce' }) })).toEqual({ write: { rule: 'catalog.create', objectId: BUSINESS, check: false, body: 'name=Catalog+A&vertical=commerce', budget: false, kinds: ['catalogbusiness'] } })
    expect(problem({ url, objectKind: 'catalogbusiness', body: form({ name: 'Catalog A', vertical: 'commerce', da_display_settings: '{"carousel_ad":{"transformation_type":"none"},"single_ad":{"transformation_type":"background_padding"}}' }) })).toBeNull()
    expect(verdict({ url, objectKind: 'catalogbusiness', body: form({ name: 'Seg A', parent_catalog_id: CATALOG, catalog_segment_filter: '{"brand":{"eq":"Shop A"}}' }) }))
      .toMatchObject({ write: { rule: 'catalog.segment.create', ids: [{ id: CATALOG, kind: 'catalogparent' }] } })
  })
  it('refuses another vertical, a partner token, a store catalog, half display settings, an unknown filter field, the segment\'s SDK-only set id', () => {
    expect(problem({ url, objectKind: 'catalogbusiness', body: form({ name: 'A', vertical: 'hotels' }) })).toMatch(/vertical is exactly commerce/)
    expect(problem({ url, objectKind: 'catalogbusiness', body: form({ name: 'A', vertical: 'commerce', partner_integration: '{"external_merchant_id":"1"}' }) })).toMatch(/only Meta change/)
    expect(problem({ url, objectKind: 'catalogbusiness', body: form({ name: 'A', vertical: 'commerce', store_catalog_settings: '{"page_id":"1"}' }) })).toMatch(/only Meta change/)
    expect(problem({ url, objectKind: 'catalogbusiness', body: form({ name: 'A', vertical: 'commerce', da_display_settings: '{"carousel_ad":{"transformation_type":"none"}}' }) })).toMatch(/both/)
    expect(problem({ url, objectKind: 'catalogbusiness', body: form({ name: 'A', parent_catalog_id: CATALOG, catalog_segment_filter: '{"visibility":{"eq":"published"}}' }) })).toMatch(/not a field Nexus filters on/)
    expect(problem({ url, objectKind: 'catalogbusiness', body: form({ name: 'A', parent_catalog_id: CATALOG, catalog_segment_product_set_id: SET }) })).toMatch(/only Meta change/)
    expect(problem({ url, objectKind: 'business', body: form({ name: 'A', vertical: 'commerce' }) })).toMatch(/only Meta change/)
    expect(problem({ url, objectKind: 'catalogbusiness', body: form({ name: 'A‮', vertical: 'commerce' }) })).toMatch(/printable text|characters of text/)
  })
  it('through the gateway: only on the chosen ad account\'s own portfolio, never one another Nexus business uses', async () => {
    const other = await send({ objectId: OTHER_BUSINESS, objectKind: 'catalogbusiness', edge: 'owned_product_catalogs', params: { name: 'A', vertical: 'commerce' } })
    expect(other).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/makes a catalog only there/) })
    h.taken.add(BUSINESS)
    const taken = await send({ objectId: BUSINESS, objectKind: 'catalogbusiness', edge: 'owned_product_catalogs', params: { name: 'A', vertical: 'commerce' } })
    expect(taken).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/another business in Nexus uses/) })
    h.taken.clear()
    expect(sent()).toEqual([])
    const ok = await send({ objectId: BUSINESS, objectKind: 'catalogbusiness', edge: 'owned_product_catalogs', params: { name: 'A', vertical: 'commerce' } })
    expect(ok.ok).toBe(true)
    expect(sent()).toEqual([['POST', `${V}/${BUSINESS}/owned_product_catalogs`, 'name=A&vertical=commerce']])
  })
  it('through the gateway: a segment\'s parent is a catalog of this business, never a segment or a client catalog', async () => {
    const params = { name: 'Seg', parent_catalog_id: SEGMENT, catalog_segment_filter: '{}' }
    catalogNode(SEGMENT, BUSINESS, true); sharedWith(SEGMENT)
    expect(await send({ objectId: BUSINESS, objectKind: 'catalogbusiness', edge: 'owned_product_catalogs', params })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/inside this change, catalog 120000000000101 is a segment itself/) })
    catalogNode(SEGMENT, OTHER_BUSINESS)
    expect(await send({ objectId: BUSINESS, objectKind: 'catalogbusiness', edge: 'owned_product_catalogs', params })).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/client catalog is another business's/) })
    expect(sent()).toEqual([])
    expect((await send({ objectId: BUSINESS, objectKind: 'catalogbusiness', edge: 'owned_product_catalogs', params: { ...params, parent_catalog_id: CATALOG } })).ok).toBe(true)
  })
})

describe('catalog.update, categories, event sources: a catalog of this business', () => {
  it('settings: exact keys, https images, both display settings', () => {
    expect(verdict({ url: `${BASE}/${CATALOG}`, objectKind: 'catalog', body: form({ name: 'Catalog B' }) })).toMatchObject({ write: { rule: 'catalog.update', objectId: CATALOG } })
    expect(problem({ url: `${BASE}/${CATALOG}`, objectKind: 'catalog', body: form({ default_image_url: 'http://example.com/a.jpg' }) })).toMatch(/https address/)
    expect(problem({ url: `${BASE}/${CATALOG}`, objectKind: 'catalog', body: form({ default_image_url: 'https://user:pw@example.com/a.jpg' }) })).toMatch(/https address/)
    expect(problem({ url: `${BASE}/${CATALOG}`, objectKind: 'catalog', body: form({ fallback_image_url: 'https://example.com/b.jpg' }) })).toBeNull()
    expect(problem({ url: `${BASE}/${CATALOG}`, objectKind: 'catalog', body: form({ vertical: 'commerce' }) })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/${CATALOG}`, objectKind: 'catalog', body: form({ name: 'A', status: 'PAUSED' }) })).toMatch(/only Meta change/)
    // The status rule never takes a catalog, and a catalog rule never a campaign.
    expect(problem({ url: `${BASE}/${CATALOG}`, objectKind: 'catalog', body: form({ status: 'PAUSED' }) })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/${CATALOG}`, objectKind: 'campaign', body: form({ name: 'A', default_image_url: 'https://example.com/a.jpg' }) })).toMatch(/only Meta change/)
  })
  it('categories: Meta\'s documented keys only, name ≤ 40, description ≤ 20, an empty landing page skips; no tokens', () => {
    const cat = (c: unknown) => problem({ url: `${BASE}/${CATALOG}/categories`, objectKind: 'catalog', body: form({ data: JSON.stringify(c) }) })
    expect(cat([{ categorization_criteria: 'BRAND', criteria_value: 'Brand A', name: 'Brand A', destination_uri: 'https://example.com/a' }])).toBeNull()
    expect(cat([{ categorization_criteria: 'PRODUCT_TYPE', criteria_value: 'Jackets', destination_uri: '' }])).toBeNull()
    expect(cat([{ categorization_criteria: 'BRAND', criteria_value: 'A', name: 'x'.repeat(41) }])).toMatch(/name is 1 to 40/)
    expect(cat([{ categorization_criteria: 'BRAND', criteria_value: 'A', description: 'x'.repeat(21) }])).toMatch(/description is 1 to 20/)
    expect(cat([{ categorization_criteria: 'BRAND', criteria_value: 'A', name: 'A', tokens: { a: 'b' } }])).toMatch(/names only/)
    expect(cat([{ categorization_criteria: 'brand', criteria_value: 'A', name: 'A' }])).toMatch(/BRAND, CATEGORY, PRODUCT_TYPE/)
    expect(cat([{ categorization_criteria: 'BRAND', criteria_value: 'A' }])).toMatch(/changes nothing/)
    expect(cat([{ categorization_criteria: 'BRAND', criteria_value: 'A', name: 'A' }, { categorization_criteria: 'BRAND', criteria_value: 'A', name: 'B' }])).toMatch(/twice/)
    expect(problem({ url: `${BASE}/${CATALOG}/categories`, objectKind: 'catalog', body: form({ data: '[{"categorization_criteria": "BRAND","criteria_value":"A","name":"A"}]' }) })).toMatch(/one spelling/)
    expect(problem({ url: `${BASE}/${CATALOG}/categories`, objectKind: 'catalog', method: 'DELETE', body: form({ data: '[]' }) })).toMatch(/deletes on Meta only|only Meta change/)
  })
  it('event sources: connect names pixels for the account check; disconnect is a DELETE with its form body', () => {
    expect(verdict({ url: `${BASE}/${CATALOG}/external_event_sources`, objectKind: 'catalog', body: form({ external_event_sources: `["${PIXEL}"]` }) })).toMatchObject({ write: { rule: 'catalog.eventsources.connect', ids: [{ id: PIXEL, kind: 'catalogpixel' }] } })
    expect(verdict({ url: `${BASE}/${CATALOG}/external_event_sources`, objectKind: 'catalog', method: 'DELETE', body: form({ external_event_sources: `["${PIXEL}"]` }) })).toMatchObject({ write: { rule: 'catalog.eventsources.disconnect', method: 'DELETE', ids: [{ id: PIXEL, kind: 'catalogsource' }] } })
    expect(problem({ url: `${BASE}/${CATALOG}/external_event_sources`, objectKind: 'catalog', body: form({ external_event_sources: `[${PIXEL}]` }) })).toMatch(/string of digits/)
    expect(problem({ url: `${BASE}/${CATALOG}/external_event_sources`, objectKind: 'catalog', body: form({ external_event_sources: `["${PIXEL}","${PIXEL}"]` }) })).toMatch(/each id once/)
    expect(problem({ url: `${BASE}/${CATALOG}/external_event_sources`, objectKind: 'catalog', method: 'DELETE' })).toMatch(/deletes on Meta only/)
  })
  it('through the gateway: never a client catalog, one shared with another Nexus business, or another kind of object', async () => {
    const params = { name: 'Catalog B' }
    catalogNode(CATALOG, OTHER_BUSINESS)
    expect(await send({ objectId: CATALOG, objectKind: 'catalog', params })).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/client catalog is another business's/) })
    catalogNode(CATALOG, BUSINESS)
    sharedWith(CATALOG, [OTHER_BUSINESS])
    h.taken.add(OTHER_BUSINESS)
    expect(await send({ objectId: CATALOG, objectKind: 'catalog', params })).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/shared with a business portfolio another business in Nexus uses/) })
    h.taken.clear()
    // Another kind of object (a product set named as a catalog): Meta's "nonexisting field" — not confirmed, nothing sent.
    expect(await send({ objectId: SET, objectKind: 'catalog', params })).toMatchObject({ code: 'META_ACCOUNT_UNCONFIRMED', message: expect.stringMatching(/as a Meta catalog/) })
    // Who else has it cannot be read in full (more pages than Nexus reads): refused.
    sharedWith(CATALOG)
    route(`${CATALOG}/agencies`, { data: [{ id: '1' }], paging: { cursors: { after: 'c' }, next: 'https://graph.facebook.com/next' } })
    expect(await send({ objectId: CATALOG, objectKind: 'catalog', params })).toMatchObject({ code: 'META_ACCOUNT_UNCONFIRMED' })
    expect(sent()).toEqual([])
    sharedWith(CATALOG)
    expect((await send({ objectId: CATALOG, objectKind: 'catalog', params })).ok).toBe(true)
  })
  it('through the gateway: a pixel connected is the chosen account\'s own; a source disconnected is connected to this catalog', async () => {
    route(`${ACT}/adspixels`, { data: [{ id: '120000000000051' }] })
    const foreign = await send({ objectId: CATALOG, objectKind: 'catalog', edge: 'external_event_sources', params: { external_event_sources: `["${PIXEL}"]` } })
    expect(foreign).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/inside this change, pixel 120000000000050 is not one of the chosen ad account's own pixels/) })
    route(`${ACT}/adspixels`, { data: [{ id: PIXEL }] })
    expect((await send({ objectId: CATALOG, objectKind: 'catalog', edge: 'external_event_sources', params: { external_event_sources: `["${PIXEL}"]` } })).ok).toBe(true)
    route(`${CATALOG}/external_event_sources`, { data: [] })
    expect(await send({ objectId: CATALOG, objectKind: 'catalog', edge: 'external_event_sources', method: 'DELETE', params: { external_event_sources: `["${PIXEL}"]` } })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not connected to catalog/) })
    route(`${CATALOG}/external_event_sources`, { data: [{ id: PIXEL }] })
    expect((await send({ objectId: CATALOG, objectKind: 'catalog', edge: 'external_event_sources', method: 'DELETE', params: { external_event_sources: `["${PIXEL}"]` } })).ok).toBe(true)
    expect(sent().map((s) => s.slice(0, 2))).toEqual([['POST', `${V}/${CATALOG}/external_event_sources`], ['DELETE', `${V}/${CATALOG}/external_event_sources`]])
    expect(sent()[1][2]).toBe(form({ external_event_sources: `["${PIXEL}"]` }))
  })
})

describe('access: people and partners', () => {
  it('assigned_users takes user + tasks (Meta\'s four), and a DELETE user; agencies ALWAYS business + permitted_tasks', () => {
    expect(verdict({ url: `${BASE}/${CATALOG}/assigned_users`, objectKind: 'catalog', body: form({ user: '100000000000001', tasks: '["ADVERTISE"]' }) })).toMatchObject({ write: { rule: 'catalog.users.assign', ids: [{ id: '100000000000001', kind: 'catalogperson' }] } })
    expect(problem({ url: `${BASE}/${CATALOG}/assigned_users`, objectKind: 'catalog', body: form({ user: '100000000000001', tasks: '["ADMIN"]' }) })).toMatch(/lists only MANAGE, ADVERTISE, MANAGE_AR, AA_ANALYZE/)
    expect(problem({ url: `${BASE}/${CATALOG}/assigned_users`, objectKind: 'catalog', body: form({ user: '100000000000001' }) })).toMatch(/only Meta change/)
    expect(verdict({ url: `${BASE}/${CATALOG}/assigned_users`, objectKind: 'catalog', method: 'DELETE', body: form({ user: '100000000000001' }) })).toMatchObject({ write: { rule: 'catalog.users.remove', ids: [{ id: '100000000000001', kind: 'catalogassignee' }] } })
    expect(problem({ url: `${BASE}/${CATALOG}/agencies`, objectKind: 'catalog', body: form({ business: OTHER_BUSINESS }) })).toMatch(/only Meta change/)
    expect(verdict({ url: `${BASE}/${CATALOG}/agencies`, objectKind: 'catalog', body: form({ business: OTHER_BUSINESS, permitted_tasks: '["ADVERTISE"]' }) })).toMatchObject({ write: { rule: 'catalog.agencies.share', ids: [{ id: OTHER_BUSINESS, kind: 'catalogagency' }] } })
    expect(problem({ url: `${BASE}/${CATALOG}/agencies`, objectKind: 'catalog', body: form({ business: OTHER_BUSINESS, permitted_tasks: '["ADVERTISE"]', permitted_roles: '["ADMIN"]' }) })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/${CATALOG}/agencies`, objectKind: 'catalog', body: form({ business: OTHER_BUSINESS, permitted_tasks: '["ADVERTISE"]', skip_defaults: 'true' }) })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/${CATALOG}/agencies`, objectKind: 'catalog', body: form({ business: OTHER_BUSINESS, permitted_tasks: '["ADVERTISE"]', utm_settings: '{"campaign_source":"fb","utm_term":"x"}' }) })).toMatch(/utm_settings names/)
    expect(verdict({ url: `${BASE}/${CATALOG}/agencies`, objectKind: 'catalog', method: 'DELETE', body: form({ business: OTHER_BUSINESS }) })).toMatchObject({ write: { rule: 'catalog.agencies.unshare', ids: [{ id: OTHER_BUSINESS, kind: 'catalogpartner' }] } })
  })
  it('through the gateway: a person of the portfolio only; never takes Nexus\'s own system user off; removes only who is assigned', async () => {
    route('me', { id: '100000000000009' }, 'id')
    route(`${BUSINESS}/business_users`, { data: [{ id: '100000000000001' }] })
    route(`${BUSINESS}/system_users`, { data: [{ id: '100000000000009' }] })
    expect(await send({ objectId: CATALOG, objectKind: 'catalog', edge: 'assigned_users', params: { user: '100000000000002', tasks: '["ADVERTISE"]' } })).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/not a person or system user of the chosen business portfolio/) })
    expect((await send({ objectId: CATALOG, objectKind: 'catalog', edge: 'assigned_users', params: { user: '100000000000001', tasks: '["ADVERTISE"]' } })).ok).toBe(true)
    route('me', { id: '100000000000009' }, 'id')
    route(`${CATALOG}/assigned_users`, { data: [{ id: '100000000000001' }, { id: '100000000000009' }] })
    expect(await send({ objectId: CATALOG, objectKind: 'catalog', edge: 'assigned_users', method: 'DELETE', params: { user: '100000000000009' } })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/Nexus's own system user/) })
    expect(await send({ objectId: CATALOG, objectKind: 'catalog', edge: 'assigned_users', method: 'DELETE', params: { user: '100000000000003' } })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not assigned to catalog/) })
    expect((await send({ objectId: CATALOG, objectKind: 'catalog', edge: 'assigned_users', method: 'DELETE', params: { user: '100000000000001' } })).ok).toBe(true)
    expect(new URL(h.calls.find((c) => new URL(c.url).pathname === `${V}/${CATALOG}/assigned_users` && c.init.method === 'GET')!.url).searchParams.get('business')).toBe(BUSINESS)
    expect(sent().map((s) => s[0])).toEqual(['POST', 'DELETE'])
  })
  it('through the gateway: never shares with a portfolio another Nexus business uses or its own; collab terms only on a segment', async () => {
    h.taken.add(OTHER_BUSINESS)
    expect(await send({ objectId: CATALOG, objectKind: 'catalog', edge: 'agencies', params: { business: OTHER_BUSINESS, permitted_tasks: '["ADVERTISE"]' } })).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/used by another business in Nexus/) })
    h.taken.clear()
    expect(await send({ objectId: CATALOG, objectKind: 'catalog', edge: 'agencies', params: { business: BUSINESS, permitted_tasks: '["ADVERTISE"]' } })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/own business portfolio/) })
    expect(await send({ objectId: CATALOG, objectKind: 'catalog', edge: 'agencies', params: { business: OTHER_BUSINESS, permitted_tasks: '["ADVERTISE"]', enabled_collab_terms: '["ENFORCE_CREATE_NEW_AD_ACCOUNT"]' } })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/only with the share of a catalog segment/) })
    catalogNode(SEGMENT, BUSINESS, true); sharedWith(SEGMENT)
    expect((await send({ objectId: SEGMENT, objectKind: 'catalog', edge: 'agencies', params: { business: OTHER_BUSINESS, permitted_tasks: '["ADVERTISE"]', utm_settings: '{"campaign_source":"fb"}' } })).ok).toBe(true)
    route(`${CATALOG}/agencies`, { data: [] })
    expect(await send({ objectId: CATALOG, objectKind: 'catalog', edge: 'agencies', method: 'DELETE', params: { business: OTHER_BUSINESS } })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/is not shared with/) })
    expect(sent()).toEqual([['POST', `${V}/${SEGMENT}/agencies`, form({ business: OTHER_BUSINESS, permitted_tasks: '["ADVERTISE"]', utm_settings: '{"campaign_source":"fb"}' })]])
  })
})

describe('product sets', () => {
  const filter = JSON.stringify({ and: [{ brand: { eq: 'Shop A' } }, { availability: { is_any: ['in stock'] } }, { price_amount: { gte: 4990 } }] })
  it('create and change: exact keys, the filter judged at every depth (fields, operators, value types), ≤ 500 KiB', () => {
    expect(verdict({ url: `${BASE}/${CATALOG}/product_sets`, objectKind: 'catalog', body: form({ name: 'Set A', filter }) })).toMatchObject({ write: { rule: 'productset.create', objectId: CATALOG } })
    expect(problem({ url: `${BASE}/${CATALOG}/product_sets`, objectKind: 'catalog', body: form({ name: 'Set A' }) })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/${CATALOG}/product_sets`, objectKind: 'catalog', body: form({ name: 'Set A', filter: '{}' }) })).toBeNull()
    expect(problem({ url: `${BASE}/${CATALOG}/product_sets`, objectKind: 'catalog', body: form({ name: 'Set A', filter, ordering_info: '[1,2]' }) })).toMatch(/only Meta change/)
    expect(verdict({ url: `${BASE}/${SET}`, objectKind: 'productset', body: form({ filter }) })).toMatchObject({ write: { rule: 'productset.update' } })
    expect(problem({ url: `${BASE}/${CATALOG}/product_sets`, objectKind: 'catalog', body: form({ name: 'A', filter: '{}', publish_to_shops: '[]' }) })).toMatch(/1 to 20 shops/)
    expect(verdict({ url: `${BASE}/${SET}`, objectKind: 'productset', body: form({ publish_to_shops: '[{"shop_id":"120000000000140","ordering_index":0}]' }) })).toMatchObject({ write: { ids: [{ id: '120000000000140', kind: 'catalogshop' }] } })
    expect(problem({ url: `${BASE}/${SET}`, objectKind: 'productset', body: form({ metadata: '{"description":"Jackets","owner":"x"}' }) })).toMatch(/metadata names/)
  })
  it('the filter judge: allow-listed fields and operators at every depth, value types per field, one spelling, Meta\'s cap', () => {
    expect(metaSetFilterProblem('{"or":[{"product_type":{"i_contains":"shirt"}},{"retailer_id":{"is_any":["A","B"]}}]}')).toBeNull()
    expect(metaSetFilterProblem('{"and":[{"brand":{"eq":"A"}},{"or":[{"color":{"eq":"red"}}]}]}')).toBeNull()
    expect(metaSetFilterProblem('{"brand":{"regex":"A"}}')).toMatch(/takes eq/)
    expect(metaSetFilterProblem('{"availability":{"contains":"in"}}')).toMatch(/takes eq, neq, is_any, is_not_any/)
    expect(metaSetFilterProblem('{"availability":{"eq":"sold"}}')).toMatch(/one of Meta's values/)
    expect(metaSetFilterProblem('{"brand":{"starts_with":"A"}}')).toMatch(/starts_with on category only/)
    expect(metaSetFilterProblem('{"price_amount":{"gte":"4990"}}')).toMatch(/whole number/)
    expect(metaSetFilterProblem('{"price_amount":{"gte":49.9}}')).toMatch(/whole number/)
    expect(metaSetFilterProblem('{"custom_label_0":{"eq":"Caffè"}}')).toMatch(/non-English/)
    expect(metaSetFilterProblem('{"brand":{"eq":"Caffè"}}')).toBeNull()
    expect(metaSetFilterProblem('{"brand":{"eq":"A","neq":"B"}}')).toMatch(/one operator/)
    expect(metaSetFilterProblem('{"brand":{"eq":{"$ne":1}}}')).toMatch(/1 to 200 characters/)
    expect(metaSetFilterProblem('{"and":{"brand":{"eq":"A"}}}')).toMatch(/lists 1 to 50 parts/)
    expect(metaSetFilterProblem('{"and":[]}')).toMatch(/lists 1 to 50 parts/)
    expect(metaSetFilterProblem('{"retailer_id":{"is_any":["A","A"]}}')).toMatch(/each value once/)
    expect(metaSetFilterProblem('{ "brand":{"eq":"A"}}')).toMatch(/one spelling/)
    expect(metaSetFilterProblem('[{"brand":{"eq":"A"}}]')).toMatch(/names a field/)
    let deep = '{"brand":{"eq":"A"}}'
    for (let i = 0; i < 12; i++) deep = `{"and":[${deep}]}`
    expect(metaSetFilterProblem(deep)).toMatch(/levels deep/)
    expect(metaSetFilterProblem(JSON.stringify({ retailer_id: { is_any: Array.from({ length: 100 }, (_, i) => `${'x'.repeat(190)}${i}`) }, or: Array.from({ length: 40 }, (_, i) => ({ brand: { eq: `b${i}${'y'.repeat(190)}` } })) }))).toBeNull()
    const huge = JSON.stringify({ or: Array.from({ length: 50 }, (_, j) => ({ retailer_id: { is_any: Array.from({ length: 100 }, (_, i) => `${j}-${i}-${'z'.repeat(150)}`) } })) })
    expect(metaSetFilterProblem(huge)).toMatch(/at most 512000 bytes/)
    expect(META_FILTER_BODY_MAX).toBeGreaterThan(3 * 500 * 1024)
  })
  it('a set\'s delete: no body, or the live flag exactly true as its form body — never another key', () => {
    expect(verdict({ url: `${BASE}/${SET}`, objectKind: 'productset', method: 'DELETE' })).toMatchObject({ write: { rule: 'productset.delete', method: 'DELETE', body: '' } })
    expect(verdict({ url: `${BASE}/${SET}`, objectKind: 'productset', method: 'DELETE', body: form({ allow_live_product_set_deletion: 'true' }) })).toMatchObject({ write: { rule: 'productset.delete.live', method: 'DELETE', body: 'allow_live_product_set_deletion=true' } })
    expect(problem({ url: `${BASE}/${SET}`, objectKind: 'productset', method: 'DELETE', body: form({ allow_live_product_set_deletion: 'false' }) })).toMatch(/exactly true/)
    expect(problem({ url: `${BASE}/${SET}`, objectKind: 'productset', method: 'DELETE', body: form({ allow_live_product_set_deletion: 'true', x: '1' }) })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/${SET}`, objectKind: 'productset', method: 'DELETE', body: form({ allow_delete_catalog_with_live_product_set: 'true' }) })).toMatch(/only Meta change/)
  })
  it('through the gateway: the set\'s own catalog is this business\'s; an item or a catalog named as a set sends nothing', async () => {
    route(SET, { id: SET, product_catalog: { id: CATALOG }, filter: '{}' }, 'id,product_catalog{id},filter')
    expect((await send({ objectId: SET, objectKind: 'productset', params: { name: 'Set B' } })).ok).toBe(true)
    route(SET, { id: SET, product_catalog: { id: '120000000000109' }, filter: '{}' }, 'id,product_catalog{id},filter')
    catalogNode('120000000000109', OTHER_BUSINESS)
    expect(await send({ objectId: SET, objectKind: 'productset', params: { name: 'Set B' } })).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    expect(await send({ objectId: ITEM, objectKind: 'productset', params: { name: 'Set B' } })).toMatchObject({ code: 'META_ACCOUNT_UNCONFIRMED', message: expect.stringMatching(/as a product set/) })
    expect(sent()).toEqual([['POST', `${V}/${SET}`, 'name=Set+B']])
  })
  it('through the gateway: a shop a set is published to is a shop of the chosen Page', async () => {
    route(SET, { id: SET, product_catalog: { id: CATALOG }, filter: '{}' }, 'id,product_catalog{id},filter')
    const params = { publish_to_shops: '[{"shop_id":"120000000000140","ordering_index":0}]' }
    expect(await send({ objectId: SET, objectKind: 'productset', params })).toMatchObject({ code: 'META_ACCOUNT_UNCONFIRMED', message: expect.stringMatching(/shops of the chosen Facebook Page/) })
    gatewayMetaPage['m-1'] = PAGE
    route(`${PAGE}/commerce_merchant_settings`, { data: [{ id: '120000000000150' }] })
    route('120000000000150/shops', { data: [{ id: '120000000000141' }] })
    expect(await send({ objectId: SET, objectKind: 'productset', params })).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/not a shop of the chosen Facebook Page/) })
    route('120000000000150/shops', { data: [{ id: '120000000000140' }] })
    expect((await send({ objectId: SET, objectKind: 'productset', params })).ok).toBe(true)
  })
})

describe('review fixes, round 1', () => {
  it('A2 — the gateway refuses to give Nexus\'s own system user tasks (as it refuses to take it off)', async () => {
    route('me', { id: '100000000000009' }, 'id')
    route(`${BUSINESS}/business_users`, { data: [] })
    route(`${BUSINESS}/system_users`, { data: [{ id: '100000000000009' }] })
    expect(await send({ objectId: CATALOG, objectKind: 'catalog', edge: 'assigned_users', params: { user: '100000000000009', tasks: '["ADVERTISE"]' } })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/inside this change, 100000000000009 is Nexus's own system user/) })
    h.routes.delete('me?id')
    expect(await send({ objectId: CATALOG, objectKind: 'catalog', edge: 'assigned_users', params: { user: '100000000000001', tasks: '["ADVERTISE"]' } })).toMatchObject({ code: 'META_ACCOUNT_UNCONFIRMED', message: expect.stringMatching(/could not read which system user it is/) })
    expect(sent()).toEqual([])
  })
  it('A3 — D7 at the gateway: items, an item and a catalog are deleted only where step 12\'s writer check (items) allows; a segment\'s delete needs none', async () => {
    const batch = { item_type: 'PRODUCT_ITEM', requests: '[{"method":"DELETE","data":{"id":"SKU-A"}}]', allow_upsert: 'false' }
    h.itemsRefusal = 'Shopify writes its items; Nexus must not write items here (D7).'
    expect(await send({ objectId: CATALOG, objectKind: 'catalog', edge: 'items_batch', params: batch })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/Shopify owns these items: remove them in Shopify\. Shopify writes its items/) })
    expect(await send({ objectId: CATALOG, objectKind: 'catalog', params: {}, method: 'DELETE' })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/Shopify owns these items/) })
    route(ITEM, { id: ITEM, product_catalog: { id: CATALOG }, retailer_id: 'SKU-A', availability: 'in stock' }, 'id,product_catalog{id},retailer_id,availability')
    expect(await send({ objectId: ITEM, objectKind: 'productitem', params: {}, method: 'DELETE' })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/Shopify owns these items/) })
    expect(h.writerChecks).toEqual([[CATALOG, 'items'], [CATALOG, 'items'], [CATALOG, 'items']])
    expect(sent()).toEqual([])
    catalogNode(SEGMENT, BUSINESS, true); sharedWith(SEGMENT)
    h.writerChecks = []
    expect((await send({ objectId: SEGMENT, objectKind: 'catalog', params: {}, method: 'DELETE' })).ok).toBe(true)
    expect(h.writerChecks).toEqual([])
    h.itemsRefusal = null
    expect((await send({ objectId: CATALOG, objectKind: 'catalog', params: { allow_delete_catalog_with_live_product_set: 'true' }, method: 'DELETE' })).ok).toBe(true)
    expect(sent().map((s) => s.slice(0, 2))).toEqual([['DELETE', `${V}/${SEGMENT}`], ['DELETE', `${V}/${CATALOG}`]])
  })
  it('A6 — a segment is shared with MANAGE and / or ADVERTISE only, at the gateway too', async () => {
    catalogNode(SEGMENT, BUSINESS, true); sharedWith(SEGMENT)
    expect(await send({ objectId: SEGMENT, objectKind: 'catalog', edge: 'agencies', params: { business: OTHER_BUSINESS, permitted_tasks: '["AA_ANALYZE"]' } })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/MANAGE and \/ or ADVERTISE only/) })
    expect((await send({ objectId: SEGMENT, objectKind: 'catalog', edge: 'agencies', params: { business: OTHER_BUSINESS, permitted_tasks: '["ADVERTISE","MANAGE"]' } })).ok).toBe(true)
    expect((await send({ objectId: CATALOG, objectKind: 'catalog', edge: 'agencies', params: { business: OTHER_BUSINESS, permitted_tasks: '["AA_ANALYZE"]' } })).ok).toBe(true)
  })
  it('B2 — publish_to_shops is a list of 1 to 20 shops: an empty list (out of every shop, undocumented) is never sent', () => {
    expect(problem({ url: `${BASE}/${SET}`, objectKind: 'productset', body: form({ publish_to_shops: '[]' }) })).toMatch(/1 to 20 shops.*no way to take a set out of every shop/)
  })
  it('B1 — the reads of who uses a catalog pass the read allow-list (campaigns, ad sets, ads with their creative\'s set)', () => {
    const read = (path: string, fields: string) => metaCallVerdict({ method: 'GET', url: `${BASE}/${path}?fields=${encodeURIComponent(fields)}&limit=100`, kind: 'read' }).problem
    expect(read(`${ACT}/campaigns`, 'id,name,effective_status,promoted_object')).toBeNull()
    expect(read(`${ACT}/adsets`, 'id,name,effective_status,promoted_object')).toBeNull()
    // Review N1 — the whole targeting (product audiences, custom and dynamic audiences) on the account's ad sets.
    expect(read(`${ACT}/adsets`, 'id,name,effective_status,promoted_object,targeting')).toBeNull()
    expect(read(`${ACT}/ads`, 'id,name,adset_id,effective_status,creative{product_set_id}')).toBeNull()
    expect(read('me', 'id')).toBeNull()
  })
})

describe('deletes of a catalog, items, an item, a feed', () => {
  it('items_batch: DELETE records only, by id, item_type PRODUCT_ITEM, allow_upsert ALWAYS false — no item field (D7)', () => {
    const url = `${BASE}/${CATALOG}/items_batch`
    const body = (requests: unknown, extra: Record<string, string> = {}) => form({ item_type: 'PRODUCT_ITEM', requests: JSON.stringify(requests), allow_upsert: 'false', ...extra })
    expect(verdict({ url, objectKind: 'catalog', body: body([{ method: 'DELETE', data: { id: 'SKU-A' } }]) })).toMatchObject({ write: { rule: 'catalog.items.delete', objectId: CATALOG } })
    expect(problem({ url, objectKind: 'catalog', body: body([{ method: 'UPDATE', data: { id: 'SKU-A', price: '49.90 EUR' } }]) })).toMatch(/Nexus writes no item field here/)
    expect(problem({ url, objectKind: 'catalog', body: body([{ method: 'DELETE', data: { id: 'SKU-A', title: 'x' } }]) })).toMatch(/names only the item's id/)
    expect(problem({ url, objectKind: 'catalog', body: body([{ method: 'DELETE', data: { id: 'SKU-A' } }, { method: 'DELETE', data: { id: 'SKU-A' } }]) })).toMatch(/each item once/)
    expect(problem({ url, objectKind: 'catalog', body: form({ item_type: 'PRODUCT_ITEM', requests: '[{"method":"DELETE","data":{"id":"A"}}]' }) })).toMatch(/only Meta change/)
    expect(problem({ url, objectKind: 'catalog', body: body([{ method: 'DELETE', data: { id: 'A' } }], { allow_upsert: 'true' }) })).toMatch(/allow_upsert is exactly false/)
    expect(problem({ url, objectKind: 'catalog', body: form({ item_type: 'HOTEL', requests: '[{"method":"DELETE","data":{"id":"A"}}]', allow_upsert: 'false' }) })).toMatch(/item_type is exactly PRODUCT_ITEM/)
    expect(problem({ url, objectKind: 'catalog', body: body(Array.from({ length: 251 }, (_, i) => ({ method: 'DELETE', data: { id: `S${i}` } }))) })).toMatch(/1 to 250 deletes/)
    expect(problem({ url: `${BASE}/${CATALOG}/batch`, objectKind: 'catalog', body: body([{ method: 'DELETE', data: { id: 'A' } }]) })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/${CATALOG}/localized_items_batch`, objectKind: 'catalog', body: body([{ method: 'DELETE', data: { id: 'A' } }]) })).toMatch(/only Meta change/)
  })
  it('a catalog\'s delete: no body, or its own live flag; an item and a feed by their own kinds', () => {
    expect(verdict({ url: `${BASE}/${CATALOG}`, objectKind: 'catalog', method: 'DELETE' })).toMatchObject({ write: { rule: 'catalog.delete', method: 'DELETE' } })
    expect(verdict({ url: `${BASE}/${CATALOG}`, objectKind: 'catalog', method: 'DELETE', body: form({ allow_delete_catalog_with_live_product_set: 'true' }) })).toMatchObject({ write: { rule: 'catalog.delete.live' } })
    expect(verdict({ url: `${BASE}/${ITEM}`, objectKind: 'productitem', method: 'DELETE' })).toMatchObject({ write: { rule: 'productitem.delete' } })
    expect(verdict({ url: `${BASE}/${FEED}`, objectKind: 'productfeed', method: 'DELETE' })).toMatchObject({ write: { rule: 'productfeed.delete' } })
    expect(problem({ url: `${BASE}/${FEED}`, objectKind: 'productfeed', method: 'DELETE', body: form({ x: '1' }) })).toMatch(/deletes on Meta only|only Meta change/)
    // Earlier deletes are untouched: a campaign's DELETE still names its own kind.
    expect(verdict({ url: `${BASE}/120000000000001`, objectKind: 'campaign', method: 'DELETE' })).toMatchObject({ write: { rule: 'object.delete' } })
  })
  it('through the gateway: items never on a segment; an item\'s catalog is this business\'s; a feed only a supplementary one of the named catalog', async () => {
    const batch = { item_type: 'PRODUCT_ITEM', requests: '[{"method":"DELETE","data":{"id":"SKU-A"}}]', allow_upsert: 'false' }
    catalogNode(SEGMENT, BUSINESS, true); sharedWith(SEGMENT)
    expect(await send({ objectId: SEGMENT, objectKind: 'catalog', edge: 'items_batch', params: batch })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/segment/) })
    route(CATALOG, { id: CATALOG, business: { id: BUSINESS } }, 'id,business{id},is_catalog_segment')
    expect(await send({ objectId: CATALOG, objectKind: 'catalog', edge: 'items_batch', params: batch })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/does not say whether it is one/) })
    catalogNode(CATALOG, BUSINESS)
    expect((await send({ objectId: CATALOG, objectKind: 'catalog', edge: 'items_batch', params: batch })).ok).toBe(true)
    route(ITEM, { id: ITEM, product_catalog: { id: SEGMENT }, retailer_id: 'SKU-A', availability: 'in stock' }, 'id,product_catalog{id},retailer_id,availability')
    expect(await send({ objectId: ITEM, objectKind: 'productitem', params: {}, method: 'DELETE' })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/segment/) })
    route(ITEM, { id: ITEM, product_catalog: { id: CATALOG }, retailer_id: 'SKU-A', availability: 'in stock' }, 'id,product_catalog{id},retailer_id,availability')
    expect((await send({ objectId: ITEM, objectKind: 'productitem', params: {}, method: 'DELETE' })).ok).toBe(true)
    // A feed: the change names its catalog; the feed is in that catalog's feeds and supplementary.
    expect(await send({ objectId: FEED, objectKind: 'productfeed', params: {}, method: 'DELETE' })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/names the catalog it belongs to/) })
    route(`${CATALOG}/product_feeds`, { data: [{ id: FEED }] })
    route(FEED, { id: FEED, ingestion_source_type: 'PRIMARY_FEED' }, 'id,ingestion_source_type')
    expect(await send({ objectId: FEED, objectKind: 'productfeed', params: {}, method: 'DELETE', parent: { kind: 'catalog', id: CATALOG } })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not a supplementary feed/) })
    route(`${CATALOG}/product_feeds`, { data: [{ id: '120000000000131' }] })
    expect(await send({ objectId: FEED, objectKind: 'productfeed', params: {}, method: 'DELETE', parent: { kind: 'catalog', id: CATALOG } })).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/not a feed of catalog/) })
    route(`${CATALOG}/product_feeds`, { data: [{ id: FEED }] })
    route(FEED, { id: FEED, ingestion_source_type: 'SUPPLEMENTARY_FEED' }, 'id,ingestion_source_type')
    expect((await send({ objectId: FEED, objectKind: 'productfeed', params: {}, method: 'DELETE', parent: { kind: 'catalog', id: CATALOG } })).ok).toBe(true)
    expect(sent()).toEqual([
      ['POST', `${V}/${CATALOG}/items_batch`, form(batch)],
      ['DELETE', `${V}/${ITEM}`, null],
      ['DELETE', `${V}/${FEED}`, null],
    ])
  })
  it('never a Meta check of a catalog change (validate_only is documented on none of these edges)', async () => {
    expect(problem({ url: `${BASE}/${CATALOG}`, objectKind: 'catalog', body: form({ name: 'A', execution_options: '["validate_only"]' }) })).toMatch(/only Meta change/)
    const check = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: CATALOG, objectKind: 'catalog', params: { name: 'A' }, check: true }).catch((e) => e)
    expect(check).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    expect(sent()).toEqual([])
  })
})
