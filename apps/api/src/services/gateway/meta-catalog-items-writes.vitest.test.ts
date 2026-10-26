/**
 * Meta step 35 on the gateway: item, override, item-group, feed and Instagram product-tag changes reach Meta only on their
 * EXACT allow-list entries — keys per edge and kind, every value judged, JSON in one spelling with every key allow-listed at
 * every depth, a file Nexus wrote judged column by column — and only for what is this business's (the catalog and its
 * children, the chosen Instagram account and its media) and what D7 allows (step 12's writer checks, run again here: the
 * live module is a stand-in that records which check was asked). Earlier rules are untouched. Made-up ids only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; init: RequestInit }>,
  routes: new Map<string, unknown>(),
  taken: new Set<string>(),
  checks: [] as Array<[string, string, unknown]>,
  refuse: null as string | null,
  own: [] as string[],
  kinds: new Map<string, string>(),
}))
vi.mock('../marketing/meta-ads/live.js', async (importActual) => ({
  ...(await importActual<typeof import('../marketing/meta-ads/live.js')>()),
  metaChosenAccount: vi.fn(async () => ({ connectionId: 'm-1', adAccountId: '1234567890', businessId: '120000000000090' })),
}))
vi.mock('../marketing/meta-ads/live-catalog-items.js', async () => {
  const { MetaLiveRefusal } = await import('../marketing/meta-ads/live.js')
  const check = (kind: string) => vi.fn(async (_a: unknown, catalogId: string, use?: unknown) => {
    h.checks.push([kind, catalogId, use])
    if (h.refuse) throw new MetaLiveRefusal(h.refuse)
    return { catalog: { catalogId }, writer: {}, fields: Array.isArray(use) ? use : [] }
  })
  return {
    ownCatalogFeedIds: vi.fn(async () => h.own),
    ownCatalogFeeds: vi.fn(async () => new Map(h.own.map((id) => [id, h.kinds.get(id) ?? 'products']))),
    itemsWriteCheck: check('items'),
    feedWriteCheck: check('feed'),
    d7WriteCheck: check('d7-upload'),
    d7RulesCheck: check('d7-rules'),
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

import { gatewayLedger, gatewayMetaChosen, gatewayMetaInstagram } from '../../test-support/gateway-stubs.js'
import { __rateTest } from './rate.js'
import { metaWriteCall, type MetaWriteRequest } from './meta.js'
import { metaCallVerdict, metaWriteVerdict } from './meta-calls.js'
import { __metaObjectLimitsTest } from './meta-object-limits.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../meta/api-version.js'
import { csvCell, META_D7_COLUMNS, META_ITEM_D7_FIELDS, META_ITEM_STATE_FIELDS, metaFeedFileProblem, metaPublicFetchUrlProblem, metaScheduleProblem, META_ITEM_FILE_COLUMNS, parseNexusCsv } from './meta-catalog-items-rules.js'
import { metaCatalogItemsOwnerProblem } from './meta-catalog-items-owner.js'
import type { MetaJudgedWrite } from './meta-calls.js'
import { D7_NEXUS_COLUMNS } from '../marketing/meta-ads/catalog-rule.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const V = `/${META_DEFAULT_GRAPH_API_VERSION}`
const ACT = 'act_1234567890'
const BUSINESS = '120000000000090'
const OTHER_BUSINESS = '120000000000091'
const CATALOG = '120000000000100'
const SEGMENT = '120000000000101'
const GROUP = '120000000000115'
const ITEM = '120000000000120'
const FEED = '120000000000130'
const SUPP = '120000000000131'
const RULE = '120000000000135'
const UPLOAD = '120000000000136'
const IG = '170000000000000'
const MEDIA = '170000000000001'
const form = (o: Record<string, string>) => new URLSearchParams(o).toString()
const verdict = (input: { body?: unknown; objectKind?: string; url: string; method?: string; kind?: string }) =>
  metaWriteVerdict({ method: input.method ?? 'POST', url: input.url, kind: input.kind ?? 'write', body: input.body, objectKind: input.objectKind })
const problem = (input: Parameters<typeof verdict>[0]) => { const v = verdict(input); return 'problem' in v ? v.problem : null }
const send = (req: Partial<MetaWriteRequest> & Pick<MetaWriteRequest, 'objectId' | 'objectKind' | 'params'>) => {
  __metaObjectLimitsTest.useMemory()
  __rateTest.useMemory()
  return metaWriteCall({ connectionId: 'm-1', operation: 'x', check: false, ...req }).catch((e) => e)
}
function route(path: string, body: unknown, fields?: string) { h.routes.set(fields ? `${path}?${fields}` : path, body) }
function catalogNode(id: string, owner: string, segment = false) { route(id, { id, business: { id: owner }, is_catalog_segment: segment }, 'id,business{id},is_catalog_segment') }
function sharedWith(id: string, agencies: string[] = []) {
  route(`${id}/agencies`, { data: agencies.map((a) => ({ id: a })) })
  route(`${id}/connected_businesses`, { data: [{ id: BUSINESS }] })
}
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const sent = () => h.calls.filter((c) => c.init.method !== 'GET').map((c) => [c.init.method, new URL(c.url).pathname])

/** A CREATE record with every field Meta requires. */
const fullItem = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: 'Jacket A', description: 'A jacket.', availability: 'in stock', condition: 'new', price: '49.90 EUR', link: 'https://shop.example.com/a', image: [{ url: 'https://shop.example.com/a.jpg' }], brand: 'Shop A', ...extra,
})
const items = (records: unknown, extra: Record<string, string> = {}) => form({ item_type: 'PRODUCT_ITEM', requests: JSON.stringify(records), allow_upsert: 'false', ...extra })

beforeEach(() => {
  __rateTest.useMemory()
  __metaObjectLimitsTest.useMemory()
  h.calls = []; h.routes = new Map(); h.taken = new Set(); h.checks = []; h.refuse = null; h.own = []; h.kinds = new Map([[SUPP, 'supplementary']]); gatewayLedger.length = 0
  for (const key of Object.keys(gatewayMetaChosen)) delete gatewayMetaChosen[key]
  for (const key of Object.keys(gatewayMetaInstagram)) delete gatewayMetaInstagram[key]
  route(ACT, { id: ACT, business: { id: BUSINESS } }, 'business{id}')
  catalogNode(CATALOG, BUSINESS)
  sharedWith(CATALOG)
  route(`${CATALOG}/product_feeds`, { data: [{ id: FEED }, { id: SUPP }] })
  route(FEED, { id: FEED, ingestion_source_type: 'primary_feed' }, 'id,ingestion_source_type,override_type')
  route(SUPP, { id: SUPP, ingestion_source_type: 'supplementary_feed' }, 'id,ingestion_source_type,override_type')
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

describe('items_batch create and update (catalogitems)', () => {
  const url = `${BASE}/${CATALOG}/items_batch`
  it('a CREATE carries Meta\'s required fields; an UPDATE the id and at least one field; allow_upsert is ALWAYS false', () => {
    expect(verdict({ url, objectKind: 'catalogitems', body: items([{ method: 'CREATE', data: fullItem('SKU-A') }]) })).toMatchObject({ write: { rule: 'catalog.items.write', objectId: CATALOG, bulky: true, edgeCall: true } })
    expect(problem({ url, objectKind: 'catalogitems', body: items([{ method: 'CREATE', data: { id: 'SKU-A', title: 'A' } }]) })).toMatch(/needs description, availability, condition, price, link, image, brand/)
    expect(problem({ url, objectKind: 'catalogitems', body: items([{ method: 'UPDATE', data: { id: 'SKU-A', availability: 'out of stock' } }]) })).toBeNull()
    expect(problem({ url, objectKind: 'catalogitems', body: items([{ method: 'UPDATE', data: { id: 'SKU-A' } }]) })).toMatch(/at least one field besides id/)
    expect(problem({ url, objectKind: 'catalogitems', body: items([{ method: 'UPDATE', data: { id: 'SKU-A', availability: 'in stock' } }], { allow_upsert: 'true' }) })).toMatch(/allow_upsert is exactly false/)
    expect(problem({ url, objectKind: 'catalogitems', body: form({ item_type: 'PRODUCT_ITEM', requests: '[{"method":"UPDATE","data":{"id":"A","availability":"in stock"}}]' }) })).toMatch(/only Meta change/)
    expect(problem({ url, objectKind: 'catalogitems', body: items([{ method: 'DELETE', data: { id: 'SKU-A' } }]) })).toMatch(/a delete is remove-meta-catalog-items/)
    // Step 34's DELETE rule (kind catalog) never takes a CREATE or an UPDATE, and step 35's rule never a DELETE.
    expect(problem({ url, objectKind: 'catalog', body: items([{ method: 'UPDATE', data: { id: 'SKU-A', availability: 'in stock' } }]) })).toMatch(/Nexus writes no item field here \(D7\)/)
    expect(verdict({ url, objectKind: 'catalog', body: items([{ method: 'DELETE', data: { id: 'SKU-A' } }]) })).toMatchObject({ write: { rule: 'catalog.items.delete' } })
  })
  it('every field allow-listed and judged at every depth: price text, labels, images, shipping, address, numbers', () => {
    const update = (data: Record<string, unknown>) => problem({ url, objectKind: 'catalogitems', body: items([{ method: 'UPDATE', data: { id: 'SKU-A', ...data } }]) })
    expect(update({ price: '49.90 EUR', sale_price: '39.90 EUR', sale_price_effective_date: '2026-11-01T00:00+0100/2026-11-30T23:59+0100' })).toBeNull()
    expect(update({ price: '€49.90' })).toMatch(/49.90 EUR/)
    expect(update({ price: '49,90 EUR' })).toMatch(/49.90 EUR/)
    expect(update({ sale_price_effective_date: '2026-11-30T00:00+0100/2026-11-01T00:00+0100' })).toMatch(/the start before the end/)
    expect(update({ internal_label: ['summer', 'sale'] })).toBeNull()
    expect(update({ internal_label: ["it's"] })).toMatch(/no quotes, commas or brackets|except quotes, commas and brackets/)
    expect(update({ internal_label: ['Sale', 'sale'] })).toMatch(/each label once/)
    expect(update({ custom_number_0: 4_294_967_296 })).toMatch(/0 to 4294967295/)
    expect(update({ custom_number_0: '7' })).toMatch(/whole number/)
    expect(update({ image: [{ url: 'https://shop.example.com/a.jpg', tag: ['front'] }] })).toBeNull()
    expect(update({ image: [{ url: 'http://shop.example.com/a.jpg' }] })).toMatch(/https address/)
    expect(update({ image: [{ url: 'https://shop.example.com/a.jpg', width: 500 }] })).toMatch(/nothing else/)
    expect(update({ shipping: [{ shipping_country: 'IT', shipping_service: 'Home delivery', shipping_price_value: '4.90', shipping_price_currency: 'EUR' }] })).toBeNull()
    expect(update({ shipping: [{ shipping_country: 'IT', shipping_service: 'Home', shipping_price_value: '4.90', shipping_price_currency: 'EUR', cost: 1 }] })).toMatch(/names only/)
    expect(update({ importer_address: { street1: 'Via A 1', city: 'Roma', country: 'IT' } })).toBeNull()
    expect(update({ importer_address: { street1: 'Via A 1', city: 'Roma', country: 'IT', phone: '+39 000 000 0000' } })).toMatch(/names only/)
    expect(update({ disabled_capabilities: ['da', 'shops'] })).toBeNull()
    expect(update({ disabled_capabilities: ['ads'] })).toMatch(/lists only/)
    expect(update({ additional_variant_attribute: 'Scent:Fruity,Flavor:Apple' })).toBeNull()
    expect(update({ additional_variant_attribute: 'Scent:Fruity:Sweet' })).toMatch(/Name:Value/)
    expect(update({ quantity_to_sell_on_facebook: 5 })).toMatch(/not an item field Nexus writes/)
    expect(update({ manufacturer_info: 'x' })).toMatch(/not an item field Nexus writes/)
    expect(update({ title: 'A‮B' })).toMatch(/printable text|control or format/)
    expect(update({ status: 'archived', expiration_date: '2026-12-31' })).toBeNull()
    expect(update({ expiration_date: '2026-02-30' })).toMatch(/YYYY-MM-DD/)
    // Review B-F1 (items_batch): user_rating 1.0–5.0 with one decimal, rating_count > 0, used together.
    expect(update({ user_rating: 4.5, rating_count: 12 })).toBeNull()
    expect(update({ user_rating: 4.55, rating_count: 12 })).toMatch(/1.0 to 5.0 with at most one decimal/)
    expect(update({ user_rating: 0.5, rating_count: 12 })).toMatch(/1.0 to 5.0/)
    expect(update({ user_rating: 4, rating_count: 0 })).toMatch(/whole number from 1/)
    expect(update({ user_rating: 4 })).toMatch(/both or neither/)
    expect(update({ rating_count: 3 })).toMatch(/both or neither/)
  })
  it('one spelling, each item once, at most 250 records', () => {
    expect(problem({ url, objectKind: 'catalogitems', body: form({ item_type: 'PRODUCT_ITEM', requests: '[{"method": "UPDATE","data":{"id":"A","size":"M"}}]', allow_upsert: 'false' }) })).toMatch(/one spelling/)
    expect(problem({ url, objectKind: 'catalogitems', body: items([{ method: 'UPDATE', data: { id: 'A', size: 'M' } }, { method: 'UPDATE', data: { id: 'A', size: 'L' } }]) })).toMatch(/each item once/)
    expect(problem({ url, objectKind: 'catalogitems', body: items(Array.from({ length: 251 }, (_, i) => ({ method: 'UPDATE', data: { id: `S${i}`, size: 'M' } }))) })).toMatch(/1 to 250/)
    expect(problem({ url, objectKind: 'catalogitems', body: items([{ method: 'UPDATE', data: { size: 'M', id: 'A' } }]) })).toMatch(/id first/)
  })
  it('through the gateway: the catalog is this business\'s, not a segment, and step 12\'s items check passes — else nothing goes', async () => {
    const params = { item_type: 'PRODUCT_ITEM', requests: JSON.stringify([{ method: 'UPDATE', data: { id: 'SKU-A', availability: 'in stock' } }]), allow_upsert: 'false' }
    h.refuse = 'Shopify owns these items: remove them in Shopify. Shopify writes its items; Nexus must not write items here (D7).'
    expect(await send({ objectId: CATALOG, objectKind: 'catalogitems', edge: 'items_batch', params })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/Shopify owns these items/) })
    expect(h.checks).toEqual([['items', CATALOG, undefined]])
    h.refuse = null
    catalogNode(SEGMENT, BUSINESS, true); sharedWith(SEGMENT)
    expect(await send({ objectId: SEGMENT, objectKind: 'catalogitems', edge: 'items_batch', params })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/is a segment of another catalog/) })
    catalogNode(CATALOG, OTHER_BUSINESS)
    expect(await send({ objectId: CATALOG, objectKind: 'catalogitems', edge: 'items_batch', params })).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/client catalog is another business's/) })
    catalogNode(CATALOG, BUSINESS)
    h.taken.add(BUSINESS)
    expect(await send({ objectId: CATALOG, objectKind: 'catalogitems', edge: 'items_batch', params })).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/another business in Nexus uses/) })
    h.taken.clear()
    expect(sent()).toEqual([])
    expect((await send({ objectId: CATALOG, objectKind: 'catalogitems', edge: 'items_batch', params })).ok).toBe(true)
    expect(sent()).toEqual([['POST', `${V}/${CATALOG}/items_batch`]])
    // The ledger keeps the body's length only (an item's text and prices).
    expect(JSON.stringify(gatewayLedger)).not.toContain('SKU-A')
  })
})

describe('localized_items_batch (catalogitems): overrides', () => {
  const url = `${BASE}/${CATALOG}/localized_items_batch`
  const body = (records: unknown) => form({ item_type: 'PRODUCT_ITEM', requests: JSON.stringify(records) })
  it('price, sale and availability only by country; text only by language; a DELETE names only the id', () => {
    expect(verdict({ url, objectKind: 'catalogitems', body: body([{ method: 'UPDATE', data: { id: 'SKU-A', price: '44.90 EUR' }, localization: { type: 'COUNTRY', value: 'IT' } }]) })).toMatchObject({ write: { rule: 'catalog.items.localize' } })
    expect(problem({ url, objectKind: 'catalogitems', body: body([{ method: 'UPDATE', data: { id: 'SKU-A', price: '44.90 EUR' }, localization: { type: 'LANGUAGE', value: 'it_IT' } }]) })).toMatch(/only by country/)
    expect(problem({ url, objectKind: 'catalogitems', body: body([{ method: 'UPDATE', data: { id: 'SKU-A', title: 'Giacca A' }, localization: { type: 'LANGUAGE', value: 'it_IT' } }]) })).toBeNull()
    expect(problem({ url, objectKind: 'catalogitems', body: body([{ method: 'UPDATE', data: { id: 'SKU-A', title: 'Jacket' }, localization: { type: 'LANGUAGE_AND_COUNTRY', value: 'en_XX|CH' } }]) })).toBeNull()
    expect(problem({ url, objectKind: 'catalogitems', body: body([{ method: 'UPDATE', data: { id: 'SKU-A', title: 'Jacket' }, localization: { type: 'COUNTRY', value: 'IT' } }]) })).toMatch(/not a country override field/)
    expect(problem({ url, objectKind: 'catalogitems', body: body([{ method: 'UPDATE', data: { id: 'SKU-A', price: '44.90 EUR' }, localization: { type: 'COUNTRY', value: 'Italy' } }]) })).toMatch(/a country \(IT\)/)
    expect(problem({ url, objectKind: 'catalogitems', body: body([{ method: 'DELETE', data: { id: 'SKU-A' }, localization: { type: 'COUNTRY', value: 'IT' } }]) })).toBeNull()
    expect(problem({ url, objectKind: 'catalogitems', body: body([{ method: 'DELETE', data: { id: 'SKU-A', price: '1.00 EUR' }, localization: { type: 'COUNTRY', value: 'IT' } }]) })).toMatch(/names only the item's id/)
    expect(problem({ url, objectKind: 'catalogitems', body: body([{ method: 'CREATE', data: { id: 'SKU-A', title: 'A' }, localization: { type: 'LANGUAGE', value: 'it_IT' } }]) })).toMatch(/UPDATE" \| "DELETE"/)
    expect(problem({ url, objectKind: 'catalogitems', body: body([{ method: 'UPDATE', data: { id: 'SKU-A', title: 'A' }, localization: { type: 'language', value: 'it_IT' } }]) })).toMatch(/COUNTRY" \| "LANGUAGE"/)
  })
})

describe('item groups (productgroup)', () => {
  it('a default item (SDK only) and a delete that always names its deletion method', () => {
    expect(verdict({ url: `${BASE}/${GROUP}`, objectKind: 'productgroup', body: form({ default_product_id: ITEM }) })).toMatchObject({ write: { rule: 'productgroup.default' } })
    expect(problem({ url: `${BASE}/${GROUP}`, objectKind: 'productgroup', body: form({ default_product_id: ITEM, variants: '[]' }) })).toMatch(/only Meta change/)
    expect(verdict({ url: `${BASE}/${GROUP}`, objectKind: 'productgroup', method: 'DELETE', body: form({ deletion_method: 'ONLY_IF_EMPTY' }) })).toMatchObject({ write: { rule: 'productgroup.delete', method: 'DELETE' } })
    expect(problem({ url: `${BASE}/${GROUP}`, objectKind: 'productgroup', method: 'DELETE' })).toMatch(/deletes on Meta only/)
    expect(problem({ url: `${BASE}/${GROUP}`, objectKind: 'productgroup', method: 'DELETE', body: form({ deletion_method: 'ALL' }) })).toMatch(/ONLY_IF_EMPTY, DELETE_ITEMS/)
  })
  it('through the gateway: the group\'s own catalog, the items check, and a default that is one of its items', async () => {
    route(GROUP, { id: GROUP, product_catalog: { id: CATALOG }, retailer_id: 'GROUP-A' }, 'id,product_catalog{id},retailer_id,variants')
    route(`${GROUP}/products`, { data: [{ id: ITEM }] })
    expect(await send({ objectId: GROUP, objectKind: 'productgroup', params: { default_product_id: '120000000000121' } })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not an item of group/) })
    expect((await send({ objectId: GROUP, objectKind: 'productgroup', params: { default_product_id: ITEM } })).ok).toBe(true)
    expect((await send({ objectId: GROUP, objectKind: 'productgroup', method: 'DELETE', params: { deletion_method: 'ONLY_IF_EMPTY' } })).ok).toBe(true)
    expect(h.checks.map((c) => c[0])).toEqual(['items', 'items'])
    expect(await send({ objectId: ITEM, objectKind: 'productgroup', params: { default_product_id: ITEM } })).toMatchObject({ code: 'META_ACCOUNT_UNCONFIRMED', message: expect.stringMatching(/as an item group/) })
  })
})

describe('feeds: create (catalogfeeds), change and uploads (catalogfeed)', () => {
  const create = (o: Record<string, string>) => problem({ url: `${BASE}/${CATALOG}/product_feeds`, objectKind: 'catalogfeeds', body: form(o) })
  const schedule = '{"interval":"DAILY","url":"https://feeds.example.com/items.csv","hour":3}'
  it('a feed of items always names deletion_enabled; a supplementary feed its primaries and no schedule; overrides take no type', () => {
    expect(create({ name: 'Feed A', feed_type: 'PRODUCTS', deletion_enabled: 'false', schedule })).toBeNull()
    expect(create({ name: 'Feed A', feed_type: 'PRODUCTS', schedule })).toMatch(/deletion_enabled is always sent/)
    expect(create({ name: 'Labels', ingestion_source_type: 'SUPPLEMENTARY_FEED', primary_feed_ids: `["${FEED}"]` })).toBeNull()
    expect(create({ name: 'Labels', ingestion_source_type: 'SUPPLEMENTARY_FEED' })).toMatch(/names the primary feeds/)
    expect(create({ name: 'Labels', ingestion_source_type: 'SUPPLEMENTARY_FEED', primary_feed_ids: `["${FEED}"]`, schedule })).toMatch(/takes no schedule/)
    expect(create({ name: 'Country IT', override_type: 'COUNTRY', deletion_enabled: 'false' })).toBeNull()
    expect(create({ name: 'Country IT', override_type: 'COUNTRY', feed_type: 'PRODUCTS', deletion_enabled: 'false' })).toMatch(/takes no feed_type/)
    expect(create({ name: 'Country IT', override_type: 'COUNTRY', deletion_enabled: 'true' })).toMatch(/deletion_enabled false/)
    expect(create({ name: 'Offers', feed_type: 'OFFER', deletion_enabled: 'false' })).toBeNull()
    expect(create({ name: 'Reviews', feed_type: 'PRODUCT_RATINGS_AND_REVIEWS', deletion_enabled: 'false' })).toBeNull()
    expect(create({ name: 'Hotels', feed_type: 'HOTEL', deletion_enabled: 'false' })).toMatch(/one of PRODUCTS, OFFER/)
    expect(create({ name: 'Feed A', feed_type: 'PRODUCTS', deletion_enabled: 'false', use_case: 'CREATOR_ASSET' })).toMatch(/only Meta change/)
    expect(create({ name: 'Feed A', feed_type: 'PRODUCTS', deletion_enabled: 'false', primary_feed_ids: `["${FEED}"]` })).toMatch(/only with a supplementary feed/)
    // Review B-F2: rules at create are Meta's list<JSON-encoded string> — a list of objects is refused.
    const rules = (...r: unknown[]) => JSON.stringify(r.map((x) => JSON.stringify(x)))
    const fallback = (attribute: string, value: string) => ({ attribute, rule_type: 'fallback_rule', params: { user_default_value: value } })
    expect(create({ name: 'Feed A', feed_type: 'PRODUCTS', deletion_enabled: 'false', rules: rules(fallback('custom_label_0', 'none')) })).toBeNull()
    expect(create({ name: 'Feed A', feed_type: 'PRODUCTS', deletion_enabled: 'false', rules: '[{"attribute":"custom_label_0","rule_type":"fallback_rule","params":{"user_default_value":"none"}}]' })).toMatch(/JSON-encoded string/)
    expect(create({ name: 'Feed A', feed_type: 'PRODUCTS', deletion_enabled: 'false', rules: rules(fallback('custom_label_0', 'a'), fallback('custom_label_0', 'b')) })).toMatch(/one rule per rule type and attribute/)
    // Review A-F1 (D7): a supplementary feed's rules name the D7 columns only.
    expect(create({ name: 'Labels', ingestion_source_type: 'SUPPLEMENTARY_FEED', primary_feed_ids: `["${FEED}"]`, rules: rules(fallback('custom_label_1', 'x')) })).toBeNull()
    expect(create({ name: 'Labels', ingestion_source_type: 'SUPPLEMENTARY_FEED', primary_feed_ids: `["${FEED}"]`, rules: rules({ attribute: 'price', rule_type: 'mapping_rule', params: { map_from: 'custom_label_0' } }, fallback('title', 'x')) })).toMatch(/D7 columns only .*not price, title/)
  })
  it('a schedule: Meta\'s keys only, never a user or password, a public https address without a key in it', () => {
    expect(metaScheduleProblem(schedule)).toBeNull()
    expect(metaScheduleProblem('{"interval":"DAILY","url":"https://feeds.example.com/items.csv","password":"x"}')).toMatch(/password for the feed's host is set in Commerce Manager/)
    expect(metaScheduleProblem('{"interval":"EVERY_MINUTE","url":"https://feeds.example.com/items.csv"}')).toMatch(/at most once an hour/)
    expect(metaScheduleProblem('{"interval":"DAILY","url":"https://feeds.example.com/items.csv","day_of_week":"MONDAY"}')).toMatch(/WEEKLY schedule only/)
    expect(metaPublicFetchUrlProblem('https://feeds.example.com/items.csv?token=abc')).toMatch(/looks like a key or a password/)
    expect(metaPublicFetchUrlProblem('https://10.0.0.5/items.csv')).toMatch(/public host by its name/)
    expect(metaPublicFetchUrlProblem('https://localhost/items.csv')).toMatch(/public host by its name|not a local or internal host/)
    expect(metaPublicFetchUrlProblem('https://files.internal/items.csv')).toMatch(/not a local or internal host/)
    expect(metaPublicFetchUrlProblem('http://feeds.example.com/items.csv')).toMatch(/https address/)
    expect(metaPublicFetchUrlProblem('https://feeds.example.com/items.csv?lang=it')).toBeNull()
    // Review A-N4: judged as a resolver reads it — case and trailing dots off, every IPv4 spelling an IP.
    expect(metaPublicFetchUrlProblem('https://localhost./items.csv')).toMatch(/public host by its name|not a local or internal host/)
    expect(metaPublicFetchUrlProblem('https://FILES.Internal./items.csv')).toMatch(/not a local or internal host/)
    expect(metaPublicFetchUrlProblem('https://127.1/items.csv')).toMatch(/public host by its name/)
    expect(metaPublicFetchUrlProblem('https://0x7f000001/items.csv')).toMatch(/public host by its name/)
    expect(metaPublicFetchUrlProblem('https://[::1]/items.csv')).toMatch(/public host by its name/)
    expect(metaPublicFetchUrlProblem('https://1.0.0.127.in-addr.arpa/items.csv')).toMatch(/not a local or internal host/)
    expect(metaPublicFetchUrlProblem('https://feeds.example.com./items.csv')).toBeNull()
  })
  it('a change: Meta\'s updatable keys only; deletion only turned ON; country, type and source type never', () => {
    expect(verdict({ url: `${BASE}/${FEED}`, objectKind: 'catalogfeed', body: form({ name: 'Feed B' }) })).toMatchObject({ write: { rule: 'catalog.feed.update' } })
    expect(problem({ url: `${BASE}/${FEED}`, objectKind: 'catalogfeed', body: form({ deletion_enabled: 'false' }) })).toMatch(/only turns it on/)
    expect(problem({ url: `${BASE}/${FEED}`, objectKind: 'catalogfeed', body: form({ country: 'IT' }) })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/${FEED}`, objectKind: 'catalogfeed', body: form({ ingestion_source_type: 'PRIMARY_FEED' }) })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/${FEED}`, objectKind: 'catalogfeed', body: form({ update_schedule: schedule }) })).toBeNull()
  })
  it('a file Nexus wrote: a labels file carries id + D7 columns update-only; a file of items a full replace\'s required columns', () => {
    const labels = [`${csvCell('id')},${csvCell('internal_label')},${csvCell('custom_label_0')}`, `${csvCell('SKU-A')},${csvCell("['summer','sale']")},${csvCell('')}`].join('\n')
    const upload = (file: string, name: string, updateOnly: string) => problem({ url: `${BASE}/${FEED}/uploads`, objectKind: 'catalogfeed', body: form({ file, file_part_name: name, update_only: updateOnly }) })
    expect(upload(labels, 'nexus-labels.csv', 'true')).toBeNull()
    expect(upload(labels, 'nexus-labels.csv', 'false')).toMatch(/update-only/)
    expect(upload(labels.replace('custom_label_0', 'title'), 'nexus-labels.csv', 'true')).toMatch(/not a column this upload may carry/)
    expect(upload(labels, 'items.csv', 'true')).toMatch(/not a file name/)
    const update = [`${csvCell('id')},${csvCell('availability')}`, `${csvCell('SKU-A')},${csvCell('in stock')}`, `${csvCell('SKU-B')},${csvCell('')}`].join('\n')
    expect(upload(update, 'nexus-items.csv', 'true')).toMatch(/an empty availability/)
    expect(upload(update, 'nexus-items.csv', 'false')).toMatch(/required columns/)
    expect(verdict({ url: `${BASE}/${FEED}/uploads`, objectKind: 'catalogfeed', body: form({ file: labels, file_part_name: 'nexus-labels.csv', update_only: 'true' }) }))
      .toMatchObject({ write: { rule: 'catalog.feed.upload.file', body: '', multipart: { fields: [['update_only', 'true']], file: { key: 'file', filename: 'nexus-labels.csv', contentType: 'text/csv', text: labels } } } })
    expect(parseNexusCsv(labels)).toEqual([['id', 'internal_label', 'custom_label_0'], ['SKU-A', "['summer','sale']", '']])
    expect(metaFeedFileProblem('id,title\nA,B', META_ITEM_FILE_COLUMNS, 'update')).toMatch(/CSV Nexus wrote/)
    // Review B-F4: a file's images are image_link + additional_image_link; a full file Meta's required columns and one of brand / gtin / mpn.
    const csv = (rows: string[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\n')
    const head = ['id', 'title', 'description', 'availability', 'condition', 'price', 'link', 'image_link', 'brand']
    const row = ['SKU-A', 'Jacket A', 'A jacket.', 'in stock', 'new', '49.90 EUR', 'https://shop.example.com/a', 'https://shop.example.com/a.jpg', 'Shop A']
    expect(metaFeedFileProblem(csv([head, row]), META_ITEM_FILE_COLUMNS, 'full')).toBeNull()
    expect(metaFeedFileProblem(csv([head.slice(0, -1), row.slice(0, -1)]), META_ITEM_FILE_COLUMNS, 'full')).toMatch(/one of brand, gtin, mpn/)
    expect(metaFeedFileProblem(csv([[...head.slice(0, 7), 'image', 'brand'], [...row.slice(0, 7), '[{"url":"https://shop.example.com/a.jpg"}]', 'Shop A']]), META_ITEM_FILE_COLUMNS, 'full')).toMatch(/"image" is not a column/)
    expect(metaFeedFileProblem(csv([['id', 'additional_image_link'], ['SKU-A', 'https://shop.example.com/b.jpg,https://shop.example.com/c.jpg']]), META_ITEM_FILE_COLUMNS, 'update')).toBeNull()
    expect(metaFeedFileProblem(csv([['id', 'additional_image_link'], ['SKU-A', 'https://shop.example.com/b.jpg, https://shop.example.com/c.jpg']]), META_ITEM_FILE_COLUMNS, 'update')).toMatch(/separated by commas/)
    expect(metaFeedFileProblem(csv([['id', 'user_rating'], ['SKU-A', '4.5']]), META_ITEM_FILE_COLUMNS, 'update')).toMatch(/both or neither/)
    expect(problem({ url: `${BASE}/${FEED}/uploads`, objectKind: 'catalogfeed', body: form({ url: 'https://feeds.example.com/items.csv', update_only: 'true' }) })).toBeNull()
    expect(problem({ url: `${BASE}/${FEED}/uploads`, objectKind: 'catalogfeed', body: form({ url: 'https://feeds.example.com/items.csv', update_only: 'true', username: 'a' }) })).toMatch(/only Meta change/)
  })
  it('through the gateway: a supplementary feed attaches to this catalog\'s primary sources under the D7 check; a feed of items under the feed check', async () => {
    route(`${CATALOG}/data_sources`, { data: [{ id: FEED }] })
    const supp = (primaries: string) => send({ objectId: CATALOG, objectKind: 'catalogfeeds', edge: 'product_feeds', params: { name: 'Labels', ingestion_source_type: 'SUPPLEMENTARY_FEED', primary_feed_ids: primaries } })
    expect(await supp(`["${SUPP}"]`)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not a primary data source of catalog/) })
    expect((await supp(`["${FEED}"]`)).ok).toBe(true)
    expect(h.checks).toEqual([['d7-upload', CATALOG, ['id', 'internal_label']]])
    // Review A-F1: its rules run step 12's { rules } check too.
    h.checks = []
    const ruled = { name: 'Labels', ingestion_source_type: 'SUPPLEMENTARY_FEED', primary_feed_ids: `["${FEED}"]`, rules: JSON.stringify([JSON.stringify({ attribute: 'custom_label_1', rule_type: 'fallback_rule', params: { user_default_value: 'x' } })]) }
    expect((await send({ objectId: CATALOG, objectKind: 'catalogfeeds', edge: 'product_feeds', params: ruled })).ok).toBe(true)
    expect(h.checks).toEqual([['d7-upload', CATALOG, ['id', 'internal_label']], ['d7-rules', CATALOG, ['custom_label_1']]])
    expect(new URL(h.calls.find((c) => new URL(c.url).pathname === `${V}/${CATALOG}/data_sources`)!.url).searchParams.get('ingestion_source_type')).toBe('PRIMARY')
    h.checks = []
    expect((await send({ objectId: CATALOG, objectKind: 'catalogfeeds', edge: 'product_feeds', params: { name: 'Feed A', feed_type: 'PRODUCTS', deletion_enabled: 'false' } })).ok).toBe(true)
    expect(h.checks.map((c) => c[0])).toEqual(['feed'])
    expect(await send({ objectId: CATALOG, objectKind: 'catalogfeeds', edge: 'product_feeds', params: { name: 'Feed B', feed_type: 'PRODUCTS', deletion_enabled: 'false', migrated_from_feed_id: FEED } })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not one Nexus made/) })
  })
  it('through the gateway: a labels file to the Shopify feed (D7 check with its columns), never into another source\'s supplementary feed', async () => {
    const labels = [`${csvCell('id')},${csvCell('custom_label_0')}`, `${csvCell('SKU-A')},${csvCell('Sale')}`].join('\n')
    const params = { file: labels, file_part_name: 'nexus-labels.csv', update_only: 'true' }
    expect((await send({ objectId: FEED, objectKind: 'catalogfeed', edge: 'uploads', params, parent: { kind: 'catalog', id: CATALOG } })).ok).toBe(true)
    expect(h.checks).toEqual([['d7-upload', CATALOG, ['id', 'custom_label_0']]])
    expect(await send({ objectId: SUPP, objectKind: 'catalogfeed', edge: 'uploads', params, parent: { kind: 'catalog', id: CATALOG } })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/supplementary feed Nexus did not make/) })
    h.own = [SUPP]
    expect((await send({ objectId: SUPP, objectKind: 'catalogfeed', edge: 'uploads', params, parent: { kind: 'catalog', id: CATALOG } })).ok).toBe(true)
    expect(await send({ objectId: FEED, objectKind: 'catalogfeed', edge: 'uploads', params })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/names the catalog it belongs to/) })
    expect(await send({ objectId: '120000000000139', objectKind: 'catalogfeed', edge: 'uploads', params, parent: { kind: 'catalog', id: CATALOG } })).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/not a feed of catalog/) })
    h.refuse = 'Shopify writes its items; Nexus must not write items here (D7). Nexus adds D7 fields only beside Shopify'
    expect(await send({ objectId: FEED, objectKind: 'catalogfeed', edge: 'uploads', params, parent: { kind: 'catalog', id: CATALOG } })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    // The multipart upload: the file as its own part, the judged field beside it, no form body.
    const upload = h.calls.find((c) => c.init.method === 'POST')!
    expect(upload.init.body).toBeInstanceOf(FormData)
    expect((upload.init.body as FormData).get('update_only')).toBe('true')
    expect(((upload.init.body as FormData).get('file') as File).name).toBe('nexus-labels.csv')
  })
  it('through the gateway: a file of items, a URL, a schedule or a change goes only to a feed Nexus made, under the feed check', async () => {
    const items = [`${csvCell('id')},${csvCell('availability')}`, `${csvCell('SKU-A')},${csvCell('in stock')}`].join('\n')
    const go = (objectId: string, extra: Partial<MetaWriteRequest> & Pick<MetaWriteRequest, 'params'>) => send({ objectId, objectKind: 'catalogfeed', parent: { kind: 'catalog', id: CATALOG }, ...extra })
    expect(await go(FEED, { edge: 'uploads', params: { file: items, file_part_name: 'nexus-items.csv', update_only: 'true' } })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not one Nexus made/) })
    expect(await go(FEED, { params: { name: 'Feed B' } })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not one Nexus made/) })
    expect(await go(FEED, { method: 'DELETE', params: {} })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not one Nexus made/) })
    h.own = [FEED, SUPP]
    expect((await go(FEED, { edge: 'uploads', params: { file: items, file_part_name: 'nexus-items.csv', update_only: 'true' } })).ok).toBe(true)
    expect((await go(FEED, { edge: 'uploads', params: { url: 'https://feeds.example.com/items.csv', update_only: 'true' } })).ok).toBe(true)
    expect((await go(FEED, { edge: 'upload_schedules', params: { upload_schedule: schedule } })).ok).toBe(true)
    expect(h.checks.map((c) => c[0])).toEqual(['feed', 'feed', 'feed'])
    expect((await go(SUPP, { params: { name: 'Labels B' } })).ok).toBe(true)
    expect(await go(SUPP, { params: { update_schedule: schedule } })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/takes a new name only/) })
    expect(await go(SUPP, { edge: 'uploads', params: { url: 'https://feeds.example.com/items.csv', update_only: 'true' } })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/labels files Nexus writes/) })
    expect((await go(SUPP, { method: 'DELETE', params: {} })).ok).toBe(true)
    // Review B-F5: a file of items only to a feed Nexus made as kind products (its record) — not an offers feed, nor an override feed.
    h.kinds.set(FEED, 'offers')
    expect(await go(FEED, { edge: 'uploads', params: { file: items, file_part_name: 'nexus-items.csv', update_only: 'true' } })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not a primary feed of items Nexus made/) })
    expect((await go(FEED, { edge: 'uploads', params: { url: 'https://feeds.example.com/offers.csv', update_only: 'true' } })).ok).toBe(true)
    // Review A-F5 (M8): a URL upload and an upload schedule only to a feed Nexus made.
    h.own = []
    expect(await go(FEED, { edge: 'uploads', params: { url: 'https://feeds.example.com/items.csv', update_only: 'true' } })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not one Nexus made/) })
    expect(await go(FEED, { edge: 'upload_schedules', params: { upload_schedule: schedule } })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not one Nexus made/) })
  })
  it('through the gateway: a labels file never goes to an override feed (review B-F5)', async () => {
    route(FEED, { id: FEED, ingestion_source_type: 'primary_feed', override_type: 'country' }, 'id,ingestion_source_type,override_type')
    const labels = [`${csvCell('id')},${csvCell('custom_label_0')}`, `${csvCell('SKU-A')},${csvCell('Sale')}`].join('\n')
    expect(await send({ objectId: FEED, objectKind: 'catalogfeed', edge: 'uploads', params: { file: labels, file_part_name: 'nexus-labels.csv', update_only: 'true' }, parent: { kind: 'catalog', id: CATALOG } })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/override feed/) })
    expect(h.checks).toEqual([])
  })
  it('the owner check on its own (re-review NF4, M2): a supplementary feed carrying a price rule is refused even past the values judge', async () => {
    route(`${CATALOG}/data_sources`, { data: [{ id: FEED }] })
    const io = {
      chosenAdAccount: async () => ACT.replace('act_', ''),
      read: async (path: string, query: Record<string, string>) => (h.routes.get(`${path}?${query.fields ?? ''}`) ?? h.routes.get(path) ?? null) as Record<string, unknown> | null,
      objectProblem: async () => null,
    }
    const rules = (attribute: string) => JSON.stringify([JSON.stringify({ attribute, rule_type: 'mapping_rule', params: { map_from: 'custom_label_0' } })])
    const create = (attribute: string) => ({ rule: 'catalog.feed.create', objectId: CATALOG, check: false, budget: false, body: new URLSearchParams({ name: 'Labels', ingestion_source_type: 'SUPPLEMENTARY_FEED', primary_feed_ids: `["${FEED}"]`, rules: rules(attribute) }).toString() }) as unknown as MetaJudgedWrite
    expect(await metaCatalogItemsOwnerProblem('m-1', create('price'), 'catalogfeeds', io)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', sentence: expect.stringMatching(/D7 columns only .*not price/) })
    expect(h.checks).toEqual([])
    expect(await metaCatalogItemsOwnerProblem('m-1', create('custom_label_2'), 'catalogfeeds', io)).toBeNull()
    expect(h.checks.map((c) => c[0])).toEqual(['d7-upload', 'd7-rules'])
  })
  it('the owner check on its own (review A-F5, M3): a labels file with a column besides id and the D7 ones is refused even past the values judge', async () => {
    const io = {
      chosenAdAccount: async () => ACT.replace('act_', ''),
      read: async (path: string, query: Record<string, string>) => (h.routes.get(`${path}?${query.fields ?? ''}`) ?? h.routes.get(path) ?? null) as Record<string, unknown> | null,
      objectProblem: async () => null,
    }
    const write = (text: string) => ({ rule: 'catalog.feed.upload.file', objectId: FEED, body: '', check: false, budget: false, multipart: { fields: [['update_only', 'true']], file: { key: 'file', filename: 'nexus-labels.csv', contentType: 'text/csv', text } } }) as unknown as MetaJudgedWrite
    const labels = (column: string) => [`${csvCell('id')},${csvCell(column)}`, `${csvCell('SKU-A')},${csvCell('x')}`].join('\n')
    expect(await metaCatalogItemsOwnerProblem('m-1', write(labels('title')), 'catalogfeed', io, { kind: 'catalog', id: CATALOG })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', sentence: expect.stringMatching(/id and the D7 columns only/) })
    expect(await metaCatalogItemsOwnerProblem('m-1', write(labels('custom_label_0')), 'catalogfeed', io, { kind: 'catalog', id: CATALOG })).toBeNull()
  })
})

describe('feed rules, error reports', () => {
  it('a rule\'s params by its type, in one spelling; the attribute an item field Nexus knows', () => {
    const rule = (o: Record<string, string>) => problem({ url: `${BASE}/${FEED}/rules`, objectKind: 'catalogfeed', body: form(o) })
    expect(rule({ attribute: 'custom_label_0', rule_type: 'fallback_rule', params: '{"user_default_value":"none"}' })).toBeNull()
    expect(rule({ attribute: 'title', rule_type: 'letter_case_rule', params: '{"type":"capitalize_first"}' })).toBeNull()
    expect(rule({ attribute: 'color', rule_type: 'value_mapping_rule', params: '{"rosso":"red","nero":"black"}' })).toBeNull()
    expect(rule({ attribute: 'brand', rule_type: 'mapping_rule', params: '{"map_from":"manufacturer"}' })).toBeNull()
    expect(rule({ attribute: 'title', rule_type: 'regex_replace_rule', params: '{"regex":"[Cc]olou?r"}' })).toBeNull()
    expect(rule({ attribute: 'title', rule_type: 'regex_replace_rule', params: '{"regex":"("}' })).toMatch(/not a valid regular expression/)
    expect(rule({ attribute: 'title', rule_type: 'regex_replace_rule', params: '{"regex":"a","replace_with":"b"}' })).toMatch(/no other key/)
    expect(rule({ attribute: 'title', rule_type: 'letter_case_rule', params: '{"type":"to_title"}' })).toMatch(/to_upper \| to_lower/)
    expect(rule({ attribute: 'id', rule_type: 'fallback_rule', params: '{"user_default_value":"x"}' })).toMatch(/item field Nexus knows/)
    expect(rule({ attribute: 'title', rule_type: 'fallback_rule', params: '{ "user_default_value":"x"}' })).toMatch(/one spelling/)
    expect(verdict({ url: `${BASE}/${RULE}`, objectKind: 'feedrule', method: 'DELETE' })).toMatchObject({ write: { rule: 'catalog.feed.rule.delete', method: 'DELETE' } })
    expect(verdict({ url: `${BASE}/${UPLOAD}/error_report`, objectKind: 'feedupload' })).toMatchObject({ write: { rule: 'catalog.feed.errorReport', body: '' } })
    expect(problem({ url: `${BASE}/${UPLOAD}/error_report`, objectKind: 'feedupload', body: form({ format: 'csv' }) })).toMatch(/only Meta change Nexus sends for catalog items/)
  })
  it('through the gateway: a D7 rule on the Shopify feed (the rules check), any other rule only on a feed Nexus made; a rule\'s delete by its attribute', async () => {
    const go = (objectId: string, objectKind: 'catalogfeed' | 'feedrule', extra: Partial<MetaWriteRequest> & Pick<MetaWriteRequest, 'params'>) => send({ objectId, objectKind, parent: { kind: 'catalog', id: CATALOG }, ...extra })
    expect((await go(FEED, 'catalogfeed', { edge: 'rules', params: { attribute: 'custom_label_0', rule_type: 'fallback_rule', params: '{"user_default_value":"none"}' } })).ok).toBe(true)
    expect(h.checks).toEqual([['d7-rules', CATALOG, ['custom_label_0']]])
    expect(await go(FEED, 'catalogfeed', { edge: 'rules', params: { attribute: 'title', rule_type: 'letter_case_rule', params: '{"type":"to_upper"}' } })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not one Nexus made/) })
    // Review A-F1: a supplementary feed takes rules on the D7 columns only — even Nexus's own.
    h.own = [SUPP]
    expect(await go(SUPP, 'catalogfeed', { edge: 'rules', params: { attribute: 'price', rule_type: 'mapping_rule', params: '{"map_from":"custom_label_0"}' } })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/supplementary feed: its rules name the D7 columns only/) })
    h.own = []
    h.checks = []
    route(`${FEED}/rules`, { data: [{ id: RULE }] })
    route(`${SUPP}/rules`, { data: [] })
    route(RULE, { id: RULE, attribute: 'title' }, 'id,attribute')
    expect(await go(RULE, 'feedrule', { method: 'DELETE', params: {} })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not one Nexus made/) })
    route(RULE, { id: RULE, attribute: 'internal_label' }, 'id,attribute')
    h.checks = []
    expect((await go(RULE, 'feedrule', { method: 'DELETE', params: {} })).ok).toBe(true)
    expect(h.checks).toEqual([['d7-rules', CATALOG, ['internal_label']]])
    expect(await go('120000000000199', 'feedrule', { method: 'DELETE', params: {} })).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/not a rule of a feed of catalog/) })
  })
  it('through the gateway: an error report only of an upload of a feed of this catalog', async () => {
    route(`${FEED}/uploads`, { data: [{ id: UPLOAD }] })
    route(`${SUPP}/uploads`, { data: [] })
    expect((await send({ objectId: UPLOAD, objectKind: 'feedupload', edge: 'error_report', params: {}, parent: { kind: 'catalog', id: CATALOG } })).ok).toBe(true)
    expect(await send({ objectId: '120000000000137', objectKind: 'feedupload', edge: 'error_report', params: {}, parent: { kind: 'catalog', id: CATALOG } })).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    expect(sent()).toEqual([['POST', `${V}/${UPLOAD}/error_report`]])
  })
})

describe('Instagram product tags and appeals', () => {
  const tags = (v: unknown) => form({ updated_tags: JSON.stringify(v) })
  it('updated_tags: {product_id, x, y} on an image, {product_id} on a video; each product once; Meta\'s limits', () => {
    const url = `${BASE}/${MEDIA}/product_tags`
    expect(verdict({ url, objectKind: 'igmedia', body: tags([{ product_id: ITEM, x: 0.5, y: 0.8 }]) })).toMatchObject({ write: { rule: 'igmedia.productTags', ids: [{ id: ITEM, kind: 'productitem' }] } })
    expect(problem({ url, objectKind: 'igmedia', body: tags([{ product_id: ITEM }]) })).toBeNull()
    expect(problem({ url, objectKind: 'igmedia', body: tags([{ product_id: ITEM, x: 0.5, y: 0.8 }, { product_id: '120000000000121' }]) })).toMatch(/exactly/)
    expect(problem({ url, objectKind: 'igmedia', body: tags([{ product_id: ITEM, x: 1.5, y: 0.8 }]) })).toMatch(/from 0 to 1/)
    expect(problem({ url, objectKind: 'igmedia', body: tags([{ product_id: Number(ITEM), x: 0.5, y: 0.8 }]) })).toMatch(/string of digits/)
    expect(problem({ url, objectKind: 'igmedia', body: tags([{ product_id: ITEM, x: 0.5, y: 0.8 }, { product_id: ITEM, x: 0.1, y: 0.2 }]) })).toMatch(/each product once/)
    expect(problem({ url, objectKind: 'igmedia', body: tags(Array.from({ length: 21 }, (_, i) => ({ product_id: `12000000000${String(i).padStart(4, '0')}`, x: 0.5, y: 0.5 }))) })).toMatch(/1 to 20 tags/)
    expect(problem({ url, objectKind: 'igmedia', body: tags(Array.from({ length: 31 }, (_, i) => ({ product_id: `12000000000${String(i).padStart(4, '0')}` }))) })).toMatch(/1 to 30 tags/)
    expect(problem({ url, objectKind: 'igmedia', body: form({ updated_tags: '[{"product_id":"1","x":0.5,"y":0.8, "z":1}]' }) })).toMatch(/one spelling/)
    expect(problem({ url, objectKind: 'igmedia', method: 'DELETE' })).toMatch(/deletes on Meta only/)
    expect(problem({ url, objectKind: 'igmedia', body: form({ updated_tags: '[]', child_index: '1' }) })).toMatch(/only Meta change Nexus sends for catalog items/)
  })
  it('an appeal: the reason as typed text, the product as a catalog id checked inside the body', () => {
    const url = `${BASE}/${IG}/product_appeal`
    expect(verdict({ url, objectKind: 'iguser', body: form({ appeal_reason: 'It is a toy.', product_id: ITEM }) })).toMatchObject({ write: { rule: 'iguser.productAppeal', ids: [{ id: ITEM, kind: 'productitem' }] } })
    expect(problem({ url, objectKind: 'iguser', body: form({ appeal_reason: ' It is a toy.', product_id: ITEM }) })).toMatch(/no space at either end/)
    expect(problem({ url, objectKind: 'iguser', body: form({ appeal_reason: 'x'.repeat(1001), product_id: ITEM }) })).toMatch(/1 to 1000/)
    expect(problem({ url, objectKind: 'iguser', body: form({ appeal_reason: 'Toy', product_id: 'SKU-A' }) })).toMatch(/digits only/)
  })
  it('through the gateway: only a media of the chosen Instagram account, and products of a catalog this business may read', async () => {
    const params = { updated_tags: JSON.stringify([{ product_id: ITEM, x: 0.5, y: 0.8 }]) }
    expect(await send({ objectId: MEDIA, objectKind: 'igmedia', edge: 'product_tags', params })).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/no Instagram account chosen/) })
    gatewayMetaInstagram['m-1'] = IG
    route(MEDIA, { id: MEDIA, owner: { id: '170000000000099' } }, 'id,owner,username')
    expect(await send({ objectId: MEDIA, objectKind: 'igmedia', edge: 'product_tags', params })).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/not one Nexus can confirm as the chosen Instagram account's/) })
    route(MEDIA, { id: MEDIA, owner: { id: IG } }, 'id,owner,username')
    route(ITEM, { id: ITEM, product_catalog: { id: '120000000000109' }, retailer_id: 'SKU-A', availability: 'in stock' }, 'product_catalog{id},retailer_id,availability')
    route('120000000000109', { id: '120000000000109', business: { id: OTHER_BUSINESS } }, 'id,name,business{id},vertical,product_count,is_catalog_segment')
    route(`${BUSINESS}/client_product_catalogs`, { data: [] })
    expect(await send({ objectId: MEDIA, objectKind: 'igmedia', edge: 'product_tags', params })).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/inside this change/) })
    route(ITEM, { id: ITEM, product_catalog: { id: CATALOG }, retailer_id: 'SKU-A', availability: 'in stock' }, 'product_catalog{id},retailer_id,availability')
    route(CATALOG, { id: CATALOG, business: { id: BUSINESS } }, 'id,name,business{id},vertical,product_count,is_catalog_segment')
    expect((await send({ objectId: MEDIA, objectKind: 'igmedia', edge: 'product_tags', params })).ok).toBe(true)
    expect(await send({ objectId: '170000000000098', objectKind: 'iguser', edge: 'product_appeal', params: { appeal_reason: 'Toy', product_id: ITEM } })).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/not the one this business chose/) })
    expect((await send({ objectId: IG, objectKind: 'iguser', edge: 'product_appeal', params: { appeal_reason: 'Toy', product_id: ITEM } })).ok).toBe(true)
    expect(sent()).toEqual([['POST', `${V}/${MEDIA}/product_tags`], ['POST', `${V}/${IG}/product_appeal`]])
  })
})

describe('reads: an item\'s internal labels (tags) only on an items edge, with exactly Nexus\'s field lists', () => {
  const read = (path: string, fields: string) => metaCallVerdict({ method: 'GET', url: `${BASE}/${path}?fields=${encodeURIComponent(fields)}&filter=${encodeURIComponent('{"retailer_id":{"is_any":["SKU-A"]}}')}`, kind: 'read' }).problem
  it('allowed with the state and D7 lists on <catalog>/products; refused anywhere else and with any other list', () => {
    expect(read(`${CATALOG}/products`, META_ITEM_STATE_FIELDS)).toBeNull()
    expect(read(`${CATALOG}/products`, META_ITEM_D7_FIELDS)).toBeNull()
    expect(read(`${CATALOG}/products`, 'id,tags')).toMatch(/never expands "tags"/)
    expect(metaCallVerdict({ method: 'GET', url: `${BASE}/${MEDIA}?fields=${encodeURIComponent(META_ITEM_D7_FIELDS)}`, kind: 'read' }).problem).toMatch(/never expands "tags"/)
    expect(metaCallVerdict({ method: 'GET', url: `${BASE}/${MEDIA}/product_tags?fields=product_id,x,y`, kind: 'read' }).problem).toBeNull()
  })
  it('the gateway\'s D7 columns are step 12\'s', () => {
    expect([...META_D7_COLUMNS]).toEqual([...D7_NEXUS_COLUMNS])
  })
})
