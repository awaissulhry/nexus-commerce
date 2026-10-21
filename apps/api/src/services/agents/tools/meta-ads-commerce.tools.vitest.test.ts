/**
 * Meta ads step 13 — meta-product-sets, meta-commerce, meta-instagram-product-tags. Product sets are read only in a
 * catalog step 12's rule allows (a set is checked to be in one before it is read); a set filter is Nexus's own rule from
 * typed conditions; commerce accounts and shops only of the chosen Page and of a business portfolio no other Nexus
 * business uses; Instagram product tags only of the chosen Instagram account and its own posts; prices only under
 * restricted keys; every call is one the real gateway lets through. Meta and the database are stubbed; made-up ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Req = { operation: string; path: string; query?: Record<string, unknown> }
const h = vi.hoisted(() => ({
  connections: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ operation: string; path: string; query?: Record<string, unknown> }>,
  /** Answers by exact path: an array is a list's rows, anything else an object's body, an Error a refusal. */
  routes: {} as Record<string, unknown>,
  /** Called first: return undefined to fall back to routes. */
  override: null as null | ((req: { operation: string; path: string; query?: Record<string, unknown> }) => unknown),
  taken: [] as Array<{ product: string; id: string }>,
}))
vi.mock('../../meta/meta-accounts.service.js', () => ({ listMetaConnections: vi.fn(async () => h.connections) }))
vi.mock('../../marketing/meta-ads/read-client.js', async () => ({
  metaReadOne: vi.fn(async (_t: unknown, req: Req) => {
    h.calls.push(req)
    const over = h.override?.(req)
    const answer = over !== undefined ? over : h.routes[req.path]
    if (answer instanceof Error) throw answer
    if (Array.isArray(answer)) return { body: { data: answer, ...(req.query?.summary ? { summary: { total_count: answer.length } } : {}) }, calls: 1 }
    if (answer === undefined && req.query?.limit !== undefined) return { body: { data: [] }, calls: 1 }
    return { body: answer ?? {}, calls: 1 }
  }),
  metaReadAll: vi.fn(async () => { throw new Error('step 13 reads page by page with metaReadOne') }),
}))
vi.mock('../../../db.js', () => ({
  default: {
    metaAdsCampaign: { findFirst: vi.fn(async () => null) },
    metaAdsAdSet: { findFirst: vi.fn(async () => null) },
    metaAdsAd: { findFirst: vi.fn(async () => null) },
    // nexus_meta_links_taken(product, ids): the ids of that product another business picked.
    $queryRaw: vi.fn(async (_s: unknown, product: string, ids: string[]) => h.taken.filter((t) => t.product === product && ids.includes(t.id)).map((t) => ({ id: t.id }))),
  },
}))

import { FIELDS } from '@nexus/shared/permissions'
import { META_ADS_COMMERCE_TOOLS, META_PRODUCT_SET_MONEY } from './meta-ads-commerce.tools.js'
import { META_CATALOG_MONEY } from './meta-ads-catalog.tools.js'
import { CATALOG_NOT_READABLE, CATALOG_PORTFOLIO_SHARED } from '../../marketing/meta-ads/live-catalog.js'
import { COMMERCE_NOT_OWN, COMMERCE_PORTFOLIO_SHARED, EMPTY_SET, productSetFilter, setFilterOut, setFilterPriceAmount, setFilterWords } from '../../marketing/meta-ads/live-commerce.js'
import { MetaReadError, failureOfAnswer } from '../../marketing/meta-ads/errors.js'
import { metaUrl } from '../../gateway/meta.js'
import { metaReadOnlyProblem } from '../../gateway/meta-calls.js'

const tool = (name: string) => META_ADS_COMMERCE_TOOLS.find((t) => t.name === name)!
const ctx = { can: () => true, via: 'claude' as const }
const run = async (name: string, args: Record<string, unknown>) => tool(name).handler(tool(name).input.parse(args), ctx as never) as Promise<{ ok: boolean; data?: any; error?: string }>
const PORTFOLIO = '9876543210'
const OTHER_PORTFOLIO = '9876543299'
const CATALOG = '120000000000700'
const CLIENT_CATALOG = '120000000000701'
const FOREIGN_CATALOG = '120000000000799'
const ITEM = '120000000000740'
const SET = '120000000000800'
const PRICED_SET = '120000000000801'
const FOREIGN_SET = '120000000000899'
const PAGE = '120000000000010'
const OTHER_PAGE = '120000000000011'
const IG = '170000000000001'
const OTHER_IG = '170000000000002'
const CMS = '130000000000001'
const CMS_PORTFOLIO = '130000000000002'
const CMS_TAKEN = '130000000000003'
const SHOP = '135000000000001'
const MEDIA = '178000000000001'
const SLIDE = '178000000000002'
const CHOSEN = {
  connectionId: 'conn-1', state: 'ok', stateText: 'ok', appId: '310000000000001', systemUser: { id: '100000000000001', name: null },
  adAccount: { adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR', timeZone: 'Europe/Rome', businessId: PORTFOLIO },
  page: { pageId: PAGE, name: 'Shop A' }, instagram: { instagramId: IG, username: 'shop_a' }, read: {},
}
const metaError = (code: string, words: string, errorClass = 'validation') => new MetaReadError(failureOfAnswer({ status: 400, verdict: { errorClass, channelCode: code, channelMessage: words } as never }), 'x', 1)
const gatewayProblems = () => h.calls.map((c) => [c.operation, metaReadOnlyProblem({ method: 'GET', url: metaUrl(c.path, (c.query ?? {}) as never), kind: 'read' })]).filter(([, problem]) => problem)
const catalogNode = (id: string, owner: string) => ({ id, name: `Catalog ${id.slice(-3)}`, business: { id: owner, name: 'Shop A' }, vertical: 'commerce', product_count: 3, is_catalog_segment: false })
const ITEM_BODY = { id: ITEM, retailer_id: 'SKU-1', name: 'Jacket', availability: 'in stock', price: '€49.90', sale_price: '€39.90', currency: 'EUR', product_catalog: { id: CATALOG } }
const SET_BODY = { id: SET, name: 'Jackets', retailer_id: 'SET-1', product_count: 3, filter: '{"product_type":{"i_contains":"jacket"}}', product_catalog: { id: CATALOG } }
const PRICED_SET_BODY = { id: PRICED_SET, name: 'Cheap', product_count: 0, filter: '{"and":[{"price_amount":{"lt":5000}},{"brand":{"eq":"Shop A"}}]}', product_catalog: { id: CATALOG } }
const SHOP_ROW = {
  id: SHOP, shop_status: 'ENABLED', fb_sales_channel: { status: 'ENABLED', fb_page: { id: PAGE, name: 'Shop A' } },
  ig_sales_channel: { status: 'STAGING', ig_user: { id: OTHER_IG, username: 'shop_b' } }, commerce_merchant_settings: { id: CMS },
}

function defaultRoutes(): Record<string, unknown> {
  return {
    [CATALOG]: catalogNode(CATALOG, PORTFOLIO),
    [CLIENT_CATALOG]: catalogNode(CLIENT_CATALOG, OTHER_PORTFOLIO),
    [FOREIGN_CATALOG]: catalogNode(FOREIGN_CATALOG, OTHER_PORTFOLIO),
    [`${PORTFOLIO}/client_product_catalogs`]: [{ id: CLIENT_CATALOG }],
    [SET]: SET_BODY,
    [PRICED_SET]: PRICED_SET_BODY,
    [FOREIGN_SET]: { ...SET_BODY, id: FOREIGN_SET, product_catalog: { id: FOREIGN_CATALOG } },
    [`${CATALOG}/product_sets`]: [SET_BODY, PRICED_SET_BODY],
    [`${SET}/products`]: [ITEM_BODY],
    [`${CATALOG}/products`]: [ITEM_BODY],
    [`${CATALOG}/facets`]: [{ item_count: 3, facets: [{ brand: [{ value: 'Shop A', count: 3 }] }, { price_amount: [{ value: 4990, count: 1 }] }] }],
    [ITEM]: ITEM_BODY,
    [`${PAGE}/commerce_merchant_settings`]: [{ id: CMS, display_name: 'Shop A shop', merchant_status: 'ENABLED' }],
    [`${PORTFOLIO}/commerce_merchant_settings`]: [
      { id: CMS, display_name: 'Shop A shop', merchant_status: 'ENABLED', merchant_page: { id: PAGE } },
      { id: CMS_PORTFOLIO, display_name: 'Shop A outlet', merchant_status: 'EXTERNALLY_DISABLED' },
      { id: CMS_TAKEN, display_name: 'Shop B shop', merchant_status: 'ENABLED', merchant_page: { id: OTHER_PAGE } },
    ],
    [CMS]: {
      id: CMS, display_name: 'Shop A shop', merchant_status: 'ENABLED', contact_email: 'shop@example.com', terms: 'https://shop-a.example/terms',
      offsite_iab_checkout_enabled_countries: ['IT', 'DE'], merchant_page: { id: PAGE, name: 'Shop A' }, payment_provider: 'external',
      facebook_channel: { pages: [{ id: OTHER_PAGE, name: 'Shop B' }, { id: PAGE, name: 'Shop A' }] }, instagram_channel: { instagram_users: [{ id: IG, username: 'shop_a' }] },
    },
    [CMS_TAKEN]: { id: CMS_TAKEN, display_name: 'Shop B shop' },
    [`${CMS}/shops`]: [SHOP_ROW],
    [SHOP]: SHOP_ROW,
    [`${PAGE}/shop_setup_status`]: [{ shop_setup: 'SETUP', payment_setup: 'SETUP', review_status: { status: 'APPROVED' } }],
    [`${CMS}/setup_status`]: [{ shop_setup: 'SETUP', payment_setup: 'NOT_SETUP' }],
    [IG]: { id: IG, username: 'shop_a', shopping_product_tag_eligibility: true, shopping_review_status: 'approved' },
    [`${IG}/available_catalogs`]: [{ catalog_id: CATALOG, catalog_name: 'Catalog 700', shop_name: 'Shop A', product_count: 3 }],
    [`${IG}/catalog_product_search`]: [{ product_id: ITEM, product_name: 'Jacket', retailer_id: 'SKU-1', review_status: 'approved', is_checkout_flow: false, merchant_id: '130000000000001', product_variants: [{ product_id: '120000000000741', variant_name: 'Red' }] }],
    [MEDIA]: { id: MEDIA, owner: { id: IG }, media_product_type: 'FEED' },
    [`${MEDIA}/product_tags`]: [{ product_id: ITEM, name: 'Jacket', price_string: '49.90 EUR', stripped_price_string: '€49.90', stripped_sale_price_string: '39.90', review_status: 'approved', is_checkout: false, x: 0.5, y: 0.8 }],
    [`${MEDIA}/children`]: [{ id: SLIDE, media_type: 'IMAGE' }],
    [`${SLIDE}/product_tags`]: [{ product_id: ITEM, name: 'Jacket', price_string: '€49.90', review_status: 'pending', x: 0.1, y: 0.2 }],
    [`${IG}/product_appeal`]: [{ product_id: ITEM, review_status: 'rejected', eligible_for_appeal: true, product_appeal_status: 'none', rejection_reasons: ['POLICY'] }],
  }
}

beforeEach(() => { h.connections = [CHOSEN]; h.calls.length = 0; h.routes = defaultRoutes(); h.override = null; h.taken = [] })

describe('the three tools are reads', () => {
  it('none changes anything; each reaches Meta with ads.view; prices are restricted to revenue view, commerce holds none', () => {
    expect(META_ADS_COMMERCE_TOOLS.map((t) => t.name)).toEqual(['meta-product-sets', 'meta-commerce', 'meta-instagram-product-tags'])
    for (const t of META_ADS_COMMERCE_TOOLS) {
      expect({ readOnly: t.readOnly, execute: t.execute, openWorld: t.openWorld, requires: t.requires, riskTier: t.riskTier, category: t.category })
        .toEqual({ readOnly: true, execute: undefined, openWorld: true, requires: ['ads.view'], riskTier: 'low', category: 'insights' })
    }
    expect(tool('meta-product-sets').restrictedFields).toEqual(META_PRODUCT_SET_MONEY)
    expect(META_PRODUCT_SET_MONEY).toEqual({ ...META_CATALOG_MONEY, filterWithPricesShown: FIELDS.financialsRevenueView })
    expect(tool('meta-instagram-product-tags').restrictedFields).toEqual(META_CATALOG_MONEY)
    expect(new Set(Object.values(META_PRODUCT_SET_MONEY))).toEqual(new Set([FIELDS.financialsRevenueView]))
    expect(tool('meta-commerce').restrictedFields).toBeUndefined()
  })
})

describe('product sets: only of a readable catalog, a set checked before it is read', () => {
  it('a portfolio another Nexus business uses: every set view (and the Instagram catalog views) refused before any call', async () => {
    h.taken = [{ product: 'PORTFOLIO', id: PORTFOLIO }]
    for (const [name, args] of [
      ['meta-product-sets', { view: 'list', catalogId: CATALOG }], ['meta-product-sets', { view: 'set', productSetId: SET }],
      ['meta-product-sets', { view: 'items', productSetId: SET }], ['meta-product-sets', { view: 'preview', catalogId: CATALOG }],
      ['meta-product-sets', { view: 'facets', catalogId: CATALOG }], ['meta-instagram-product-tags', { view: 'catalogs' }],
      ['meta-instagram-product-tags', { view: 'search', catalogId: CATALOG }], ['meta-instagram-product-tags', { view: 'appeal', itemId: ITEM }],
    ] as Array<[string, Record<string, unknown>]>) expect((await run(name, args)).error, `${name} ${args.view}`).toBe(CATALOG_PORTFOLIO_SHARED)
    expect(h.calls).toHaveLength(0)
  })
  it('a catalog the portfolio neither owns nor is a client of: refused before its sets are read', async () => {
    expect((await run('meta-product-sets', { view: 'list', catalogId: FOREIGN_CATALOG })).error).toBe(CATALOG_NOT_READABLE)
    expect(h.calls.map((c) => c.operation)).toEqual(['catalog.ownerCheck', 'catalog.clientCheck'])
  })
  it('a set of another catalog is refused after its owner-only read; one named with another catalog too; an id that is no set too', async () => {
    expect((await run('meta-product-sets', { view: 'items', productSetId: FOREIGN_SET })).error).toBe(CATALOG_NOT_READABLE)
    expect(h.calls[0]).toMatchObject({ operation: 'catalog.product_set.ownerCheck', path: FOREIGN_SET, query: { fields: 'product_catalog{id},filter' } })
    expect(h.calls.some((c) => c.path === `${FOREIGN_SET}/products`)).toBe(false)
    expect((await run('meta-product-sets', { view: 'set', productSetId: SET, catalogId: CLIENT_CATALOG })).error).toMatch(/not in the catalog named/)
    h.routes[SET] = metaError('100', 'Tried accessing nonexisting field (filter) on node type (ProductItem)')
    expect((await run('meta-product-sets', { view: 'set', productSetId: SET })).error).toMatch(/is not a product set/)
  })
  it('list: the set tree filters on their own keys, the filter in plain words, an empty set warned, a price filter only restricted', async () => {
    const res = await run('meta-product-sets', { view: 'list', catalogId: CATALOG, parentId: '0', hasChildren: false, retailerId: 'SET-1' })
    expect(h.calls.at(-1)?.query).toMatchObject({ parent_id: '0', has_children: false, retailer_id: 'SET-1', summary: 'total_count' })
    const [plain, priced] = res.data.items
    expect(plain).toMatchObject({ productSetId: SET, productCount: 3, filter: { product_type: { i_contains: 'jacket' } }, filterWords: 'product_type contains (any case) "jacket"', filterHasPrices: false })
    expect(priced).toMatchObject({ productSetId: PRICED_SET, filter: null, filterHasPrices: true, warning: EMPTY_SET })
    expect(priced.filterWithPricesShown.rule).toEqual({ and: [{ price_amount: { lt: 5000 } }, { brand: { eq: 'Shop A' } }] })
    expect(Object.keys(META_PRODUCT_SET_MONEY)).toContain('filterWithPricesShown')
  })
  it('set: one set with its metadata; ordering_info (SDK only) dropped and named when Meta refuses it', async () => {
    h.override = (req) => (req.operation === 'productSets.one' && String(req.query?.fields).includes('ordering_info') ? metaError('100', 'Tried accessing nonexisting field (ordering_info)') : undefined)
    const res = await run('meta-product-sets', { view: 'set', productSetId: SET })
    expect(res.data).toMatchObject({ catalogId: CATALOG, relation: 'owned', productSetId: SET, name: 'Jackets', orderingInfo: null })
    expect(res.data.fieldsNote).toMatch(/ordering_info/)
  })
  it('items: the set\'s items with prices in minor units under restricted keys, narrowed by Nexus\'s own rule', async () => {
    const res = await run('meta-product-sets', { view: 'items', productSetId: SET, conditions: [{ field: 'availability', op: 'eq', value: 'In Stock' }], errorPriority: 'high' })
    expect(h.calls.at(-1)).toMatchObject({ path: `${SET}/products`, query: { filter: { availability: { eq: 'in stock' } }, error_priority: 'HIGH' } })
    expect(res.data.items[0]).toMatchObject({ itemId: ITEM, sku: 'SKU-1', currency: 'EUR', priceCents: 4990, salePriceCents: 3990 })
    for (const key of ['priceCents', 'salePriceCents', 'priceShown', 'salePriceShown']) expect(META_PRODUCT_SET_MONEY).toHaveProperty(key)
  })
  it('preview: Nexus builds the rule, counts the matches, shows a sample, and compares with the set\'s count now (before → after)', async () => {
    h.override = (req) => (req.operation === 'productSets.preview' ? [ITEM_BODY, { ...ITEM_BODY, id: '120000000000742' }] : undefined)
    const res = await run('meta-product-sets', {
      view: 'preview', productSetId: SET, match: 'any',
      conditions: [{ field: 'brand', op: 'is_any', values: ['Shop A', 'Shop A'] }, { field: 'price_amount', op: 'lte', amountMinor: 4990 }],
    })
    const sent = h.calls.find((c) => c.operation === 'productSets.preview')!
    expect(sent.path).toBe(`${CATALOG}/products`)
    expect(sent.query?.filter).toEqual({ or: [{ brand: { is_any: ['Shop A'] } }, { price_amount: { lte: 4990 } }] })
    expect(res.data).toMatchObject({ matchingItems: 2, willDeliver: true, priceCurrency: 'EUR', filter: null, filterHasPrices: true, current: { productSetId: SET, itemsNow: 3, itemsWithThisFilter: 2, change: -1 } })
    expect(res.data.note).toMatch(/no check/)
    h.override = (req) => (req.operation === 'productSets.preview' ? [] : undefined)
    const empty = await run('meta-product-sets', { view: 'preview', catalogId: CATALOG, conditions: [{ field: 'brand', op: 'eq', value: 'Nobody' }] })
    expect(empty.data).toMatchObject({ matchingItems: 0, willDeliver: false, filter: { brand: { eq: 'Nobody' } }, filterWords: 'brand is "Nobody"' })
    expect(empty.data.warning).toMatch(/will not deliver/)
  })
  it('facets: the fields Nexus names are sent as a list; a facet of prices is never answered', async () => {
    const res = await run('meta-product-sets', { view: 'facets', catalogId: CATALOG, facetFields: ['brand', 'color'] })
    expect(h.calls.at(-1)).toMatchObject({ path: `${CATALOG}/facets`, query: { facets: ['brand', 'color'] } })
    expect(JSON.stringify(res.data.items)).not.toMatch(/price/i)
    expect(res.data.items[0].facets).toEqual([{ brand: [{ value: 'Shop A', count: 3 }] }, {}])
    expect(() => tool('meta-product-sets').input.parse({ view: 'facets', catalogId: CATALOG, facetFields: ['price_amount'] })).toThrow()
  })
})

describe('the product-set filter: Nexus\'s own rule from typed conditions (lane C4 reuses it)', () => {
  const f = (conditions: unknown[], extra: Record<string, unknown> = {}) => productSetFilter({ conditions: conditions as never, ...extra }, 'EUR')
  it('one condition alone, several joined by and (all) or or (any), lists de-duplicated, fixed values lower-cased', () => {
    expect(f([])).toEqual({ rule: null, priceCurrency: null })
    expect(f([{ field: 'retailer_product_group_id', op: 'eq', value: ' GROUP-1 ' }]).rule).toEqual({ retailer_product_group_id: { eq: 'GROUP-1' } })
    expect(f([{ field: 'availability', op: 'is_any', values: ['In Stock', 'preorder'] }, { field: 'category', op: 'starts_with', value: 'Apparel' }]).rule)
      .toEqual({ and: [{ availability: { is_any: ['in stock', 'preorder'] } }, { category: { starts_with: 'Apparel' } }] })
    expect(f([{ field: 'brand', op: 'eq', value: 'A' }, { field: 'brand', op: 'eq', value: 'B' }], { match: 'any' }).rule).toEqual({ or: [{ brand: { eq: 'A' } }, { brand: { eq: 'B' } }] })
  })
  it('Meta\'s rules are refused in words: contains on a fixed-value field, starts_with off category, a value Meta does not know, non-English labels', () => {
    expect(() => f([{ field: 'availability', op: 'contains', value: 'stock' }])).toThrow(/fixed values/)
    expect(() => f([{ field: 'brand', op: 'starts_with', value: 'Sh' }])).toThrow(/category only/)
    expect(() => f([{ field: 'condition', op: 'eq', value: 'broken' }])).toThrow(/not one of Meta's values/)
    expect(() => f([{ field: 'custom_label_0', op: 'eq', value: 'giacca è' }])).toThrow(/non-English characters/)
    expect(() => f([{ field: 'brand', op: 'eq', values: ['A'] }])).toThrow(/takes one value/)
    expect(() => f([{ field: 'brand', op: 'is_any', value: 'A' }])).toThrow(/takes a list/)
    expect(() => f([{ field: 'brand', op: 'lt', value: 'A' }])).toThrow(/text field takes/)
    expect(() => f([{ field: 'brand', op: 'eq', value: 'A', amountMinor: 5 }])).toThrow(/price_amount or sale_price_amount only/)
    expect(() => f(Array.from({ length: 21 }, () => ({ field: 'brand', op: 'eq', value: 'A' })))).toThrow(/At most 20/)
  })
  it('a price is minor units of its currency, sent as Meta\'s price × 100 in every currency (one helper)', () => {
    expect(setFilterPriceAmount(4990, 'EUR')).toBe(4990)
    expect(setFilterPriceAmount(490, 'JPY')).toBe(49000)
    expect(setFilterPriceAmount(4900, 'BHD')).toBe(490)
    expect(setFilterPriceAmount(4905, 'BHD')).toBeNull()
    expect(setFilterPriceAmount(-1, 'EUR')).toBeNull()
    expect(f([{ field: 'sale_price_amount', op: 'gt', amountMinor: 100 }], { currency: 'jpy' })).toEqual({ rule: { sale_price_amount: { gt: 10000 } }, priceCurrency: 'JPY' })
    expect(() => f([{ field: 'price_amount', op: 'contains', amountMinor: 1 }])).toThrow(/a price takes/)
    expect(() => f([{ field: 'price_amount', op: 'gt', value: '49.90' }])).toThrow(/amountMinor only/)
    expect(() => productSetFilter({ conditions: [{ field: 'price_amount', op: 'gt', amountMinor: 1 }] }, null)).toThrow(/name the currency/)
  })
  it('a set filter read back: parsed, in words, and any price only under the restricted key (also an unparsable text naming a price)', () => {
    expect(setFilterOut('')).toEqual({ filter: {}, filterWords: 'every item of the catalog', filterHasPrices: false })
    expect(setFilterOut('{"or":[{"brand":{"eq":"A"}},{"tags":{"is_any":["x","y"]}}]}')).toMatchObject({ filterWords: 'brand is "A" or tags is one of "x", "y"' })
    expect(setFilterOut("{'price': {'lt': 5}}")).toEqual({ filter: null, filterHasPrices: true, filterWithPricesShown: { rule: "{'price': {'lt': 5}}", words: null } })
    expect(setFilterOut({ sale_price_amount: { gt: 1 } })).toMatchObject({ filter: null, filterHasPrices: true })
    expect(setFilterWords({ and: [{ brand: { eq: 'A' } }, { or: [{ color: { eq: 'red' } }, { color: { eq: 'blue' } }] }] })).toBe('brand is "A" and (color is "red" or color is "blue")')
  })
})

describe('commerce accounts: only the chosen Page\'s and an unshared portfolio\'s', () => {
  it('accounts: both lists, one row per account; a portfolio account whose Page another business uses is its id only', async () => {
    h.taken = [{ product: 'PAGE', id: OTHER_PAGE }]
    const res = await run('meta-commerce', { view: 'accounts' })
    expect(res.data.items).toEqual([
      expect.objectContaining({ commerceAccountId: CMS, foundOn: 'the chosen Facebook Page', statusWords: 'on' }),
      expect.objectContaining({ commerceAccountId: CMS_PORTFOLIO, foundOn: 'the business portfolio', statusWords: expect.stringMatching(/outside Meta/) }),
      { commerceAccountId: CMS_TAKEN, takenByAnotherBusiness: true },
    ])
    expect(JSON.stringify(res.data)).not.toContain('Shop B')
  })
  it('a portfolio another Nexus business uses: only the Page\'s accounts, said why; no Page as well: refused before any Meta call', async () => {
    h.taken = [{ product: 'PORTFOLIO', id: PORTFOLIO }]
    const res = await run('meta-commerce', { view: 'accounts' })
    expect(res.data.portfolioNote).toBe(COMMERCE_PORTFOLIO_SHARED)
    expect(res.data.items.map((i: { commerceAccountId: string }) => i.commerceAccountId)).toEqual([CMS])
    expect(h.calls.some((c) => c.path === `${PORTFOLIO}/commerce_merchant_settings`)).toBe(false)
    h.calls.length = 0
    h.connections = [{ ...CHOSEN, page: null }]
    expect((await run('meta-commerce', { view: 'accounts' })).error).toMatch(/shared with another business in Nexus.*No Facebook Page/)
    h.connections = [{ ...CHOSEN, page: null, adAccount: { ...CHOSEN.adAccount, businessId: null } }]
    expect((await run('meta-commerce', { view: 'shops' })).error).toMatch(/No Facebook Page is chosen/)
    expect(h.calls).toHaveLength(0)
  })
  it('a commerce account that is not the Page\'s nor the portfolio\'s, or is another business\'s, is refused before it is read', async () => {
    expect((await run('meta-commerce', { view: 'account', commerceAccountId: '130000000000009' })).error).toMatch(new RegExp(COMMERCE_NOT_OWN.slice(0, 40)))
    h.taken = [{ product: 'PAGE', id: OTHER_PAGE }]
    expect((await run('meta-commerce', { view: 'shops', commerceAccountId: CMS_TAKEN })).error).toMatch(/Page another business in Nexus uses/)
    expect(h.calls.some((c) => c.path === '130000000000009' || c.path === CMS_TAKEN || c.path === `${CMS_TAKEN}/shops`)).toBe(false)
    expect((await run('meta-commerce', { view: 'account' })).error).toMatch(/several commerce accounts/)
  })
  it('account: settings, the Page, channels with another business\'s Page as its id only, checkout per country, policy per language', async () => {
    h.taken = [{ product: 'PAGE', id: OTHER_PAGE }]
    h.override = (req) => {
      const fields = String(req.query?.fields ?? '')
      if (req.path !== CMS) return undefined
      if (fields.includes('checkout_config.country_code(IT)')) return { id: CMS, checkout_config: { checkout_url: 'https://shop-a.example/checkout', country_code: 'IT' } }
      if (fields.includes('cta.country_code(IT)')) return metaError('100', 'Tried accessing nonexisting field (cta)')
      if (fields.includes('shops_ads_setup.country_code(IT)')) return { id: CMS, shops_ads_setup: { status: 'ok' } }
      if (fields.includes('privacy_policy_localized.locale(it)')) return { id: CMS, privacy_policy_localized: { url: 'https://shop-a.example/privacy' } }
      return undefined
    }
    const res = await run('meta-commerce', { view: 'account', commerceAccountId: CMS, country: 'it', locale: 'it' })
    expect(res.data).toMatchObject({
      commerceAccountId: CMS, name: 'Shop A shop', status: 'ENABLED', offsiteCheckoutCountries: ['IT', 'DE'], page: { pageId: PAGE, chosenHere: true }, paymentProvider: 'external',
      country: 'IT', perCountry: { checkoutConfig: { checkoutUrl: 'https://shop-a.example/checkout', countryCode: 'IT' }, shopsAdsSetup: { status: 'ok' } }, privacyPolicy: { url: 'https://shop-a.example/privacy' },
    })
    expect(res.data.perCountry.callToAction.notRead).toMatch(/nonexisting field/)
    expect(res.data.facebookChannel.pages).toEqual([{ id: OTHER_PAGE, takenByAnotherBusiness: true }, { id: PAGE, name: 'Shop A' }])
    expect(JSON.stringify(res.data)).not.toContain('Shop B')
  })
  it('account: one SDK-only field Meta refuses is named in missing; the others still answer', async () => {
    // Meta answers only the fields asked: each group read alone gets its own fields.
    const asked = (fields: unknown) => String(fields).split(',').map((f) => f.replace(/[{.(].*$/, ''))
    h.override = (req) => {
      if (req.path !== CMS) return undefined
      if (String(req.query?.fields).includes('offsite_iab_checkout_enabled_countries')) return metaError('100', 'Tried accessing nonexisting field (offsite_iab_checkout_enabled_countries)')
      const body = h.routes[CMS] as Record<string, unknown>
      return Object.fromEntries(asked(req.query?.fields).map((f) => [f, body[f]]))
    }
    const res = await run('meta-commerce', { view: 'account', commerceAccountId: CMS })
    expect(res.data).toMatchObject({ name: 'Shop A shop', offsiteCheckoutCountries: null, paymentProvider: 'external' })
    expect(res.data.missing).toEqual([{ part: 'offsite checkout countries', sentence: expect.stringMatching(/nonexisting field/) }])
  })
  it('shops and shop: sales channels with status; another business\'s Instagram account is its id only; a shop not in the business\'s accounts is refused', async () => {
    h.taken = [{ product: 'INSTAGRAM', id: OTHER_IG }]
    const shops = await run('meta-commerce', { view: 'shops', commerceAccountId: CMS })
    expect(shops.data.items[0]).toMatchObject({ shopId: SHOP, status: 'ENABLED', facebook: { status: 'ENABLED', page: { id: PAGE, name: 'Shop A', chosenHere: true } }, instagram: { status: 'STAGING', statusWords: expect.stringMatching(/set up/), instagramAccount: { id: OTHER_IG, takenByAnotherBusiness: true } } })
    expect(JSON.stringify(shops.data)).not.toContain('shop_b')
    const one = await run('meta-commerce', { view: 'shop', shopId: SHOP, commerceAccountId: CMS })
    expect(one.data).toMatchObject({ commerceAccountId: CMS, shop: { shopId: SHOP } })
    h.calls.length = 0
    expect((await run('meta-commerce', { view: 'shop', shopId: '135000000000009', commerceAccountId: CMS })).error).toMatch(/not one of the shops/)
    expect(h.calls.some((c) => c.path === '135000000000009')).toBe(false)
  })
  it('setup-status: the chosen Page\'s shop by default, a commerce account\'s when named; checkout-countries: the list and per country', async () => {
    expect((await run('meta-commerce', { view: 'setup-status' })).data).toMatchObject({ pageId: PAGE, items: [{ shopSetup: 'SETUP', reviewStatus: { status: 'APPROVED' } }] })
    expect((await run('meta-commerce', { view: 'setup-status', commerceAccountId: CMS })).data).toMatchObject({ commerceAccountId: CMS, items: [{ paymentSetup: 'NOT_SETUP' }] })
    h.override = (req) => (req.path === CMS && String(req.query?.fields).includes('checkout_config.country_code(DE)') ? { id: CMS, checkout_config: { country_code: 'DE' } } : undefined)
    const res = await run('meta-commerce', { view: 'checkout-countries', commerceAccountId: CMS, countries: ['de'] })
    expect(res.data).toMatchObject({ offsiteCheckoutCountries: ['IT', 'DE'], perCountry: [{ country: 'DE', checkoutConfig: { countryCode: 'DE' }, notRead: null }] })
  })
})

describe('Instagram product tags: only the chosen Instagram account and its own posts', () => {
  it('no Instagram account chosen: every view refused before any call', async () => {
    h.connections = [{ ...CHOSEN, instagram: null }]
    for (const view of ['eligibility', 'catalogs', 'search', 'tags', 'appeal']) expect((await run('meta-instagram-product-tags', { view, mediaId: MEDIA, itemId: ITEM })).error, view).toMatch(/No Instagram account is chosen/)
    expect(h.calls).toHaveLength(0)
  })
  it('eligibility: Meta\'s answer in words; shopping_review_status (SDK only) dropped and named when refused', async () => {
    expect((await run('meta-instagram-product-tags', { view: 'eligibility' })).data).toMatchObject({ instagramId: IG, eligible: true, shoppingReviewStatus: 'approved', sentence: expect.stringMatching(/may tag/) })
    h.override = (req) => (req.path === IG && String(req.query?.fields).includes('shopping_review_status') ? metaError('100', 'Tried accessing nonexisting field (shopping_review_status)') : req.path === IG ? { id: IG, shopping_product_tag_eligibility: false } : undefined)
    const res = await run('meta-instagram-product-tags', { view: 'eligibility' })
    expect(res.data).toMatchObject({ eligible: false, sentence: expect.stringMatching(/may not tag/) })
    expect(res.data.fieldsNote).toMatch(/shopping_review_status/)
  })
  it('catalogs: each checked against the catalog rule (readable, another business\'s by id only, or not readable)', async () => {
    h.taken = [{ product: 'PORTFOLIO', id: OTHER_PORTFOLIO }]
    h.routes[`${IG}/available_catalogs`] = [{ catalog_id: CATALOG, catalog_name: 'Catalog 700' }, { catalog_id: CLIENT_CATALOG, catalog_name: 'Shop B catalog' }, { catalog_id: FOREIGN_CATALOG, catalog_name: 'Other' }]
    h.routes[`${PORTFOLIO}/client_product_catalogs`] = [{ id: CLIENT_CATALOG }]
    const res = await run('meta-instagram-product-tags', { view: 'catalogs' })
    expect(res.data.items).toEqual([
      expect.objectContaining({ catalogId: CATALOG, readable: true, relation: 'owned' }),
      { catalogId: CLIENT_CATALOG, takenByAnotherBusiness: true },
      { catalogId: FOREIGN_CATALOG, readable: false, why: CATALOG_NOT_READABLE },
    ])
    expect(JSON.stringify(res.data)).not.toContain('Shop B catalog')
  })
  it('search: in the one catalog the account tags from by default, or a named readable one; a foreign catalog is refused before the search', async () => {
    const res = await run('meta-instagram-product-tags', { view: 'search', search: 'SKU-1' })
    expect(h.calls.at(-1)).toMatchObject({ path: `${IG}/catalog_product_search`, query: { catalog_id: CATALOG, q: 'SKU-1' } })
    expect(res.data.items[0]).toEqual({ productId: ITEM, name: 'Jacket', sku: 'SKU-1', reviewStatus: 'approved', taggable: true, checkoutInInstagram: false, merchantId: CMS, imageUrl: null, variants: [{ productId: '120000000000741', name: 'Red' }] })
    h.calls.length = 0
    expect((await run('meta-instagram-product-tags', { view: 'search', catalogId: FOREIGN_CATALOG })).error).toBe(CATALOG_NOT_READABLE)
    expect(h.calls.some((c) => c.path.endsWith('/catalog_product_search'))).toBe(false)
  })
  it('tags: only on the chosen account\'s own post; prices only under restricted keys; slides on request; a Story needs no call', async () => {
    const res = await run('meta-instagram-product-tags', { view: 'tags', mediaId: MEDIA, slides: true })
    expect(res.data.items[0]).toMatchObject({ productId: ITEM, showsOnPost: true, x: 0.5, y: 0.8, currency: 'EUR', priceCents: 4990, priceShown: '49.90 EUR', salePriceCents: 3990, otherPriceShown: '€49.90' })
    expect(res.data.slides).toEqual([{ slideId: SLIDE, mediaType: 'IMAGE', items: [expect.objectContaining({ productId: ITEM, showsOnPost: false, priceCents: null, priceShown: '€49.90' })], notRead: null }])
    for (const key of ['priceCents', 'salePriceCents', 'priceShown', 'salePriceShown', 'otherPriceShown']) expect(META_CATALOG_MONEY).toHaveProperty(key)
    h.routes['178000000000009'] = { id: '178000000000009', owner: { id: OTHER_IG }, username: 'shop_b' }
    h.calls.length = 0
    expect((await run('meta-instagram-product-tags', { view: 'tags', mediaId: '178000000000009' })).error).toMatch(/not the chosen Instagram account's/)
    expect(h.calls.some((c) => c.path.endsWith('/product_tags'))).toBe(false)
    h.routes[MEDIA] = { id: MEDIA, owner: { id: IG }, media_product_type: 'STORY' }
    h.calls.length = 0
    expect((await run('meta-instagram-product-tags', { view: 'tags', mediaId: MEDIA })).data.note).toMatch(/no product tags on Stories/)
    expect(h.calls.map((c) => c.operation)).toEqual(['instagram.mediaOwnerCheck'])
  })
  it('appeal: only for an item of a readable catalog (checked first)', async () => {
    expect((await run('meta-instagram-product-tags', { view: 'appeal', itemId: ITEM })).data).toMatchObject({ productId: ITEM, items: [{ reviewStatus: 'rejected', eligibleForAppeal: true, rejectionReasons: ['POLICY'] }] })
    expect(h.calls.at(-1)).toMatchObject({ path: `${IG}/product_appeal`, query: { product_id: ITEM } })
    h.routes[ITEM] = { ...ITEM_BODY, product_catalog: { id: FOREIGN_CATALOG } }
    h.calls.length = 0
    expect((await run('meta-instagram-product-tags', { view: 'appeal', itemId: ITEM })).error).toBe(CATALOG_NOT_READABLE)
    expect(h.calls.some((c) => c.path.endsWith('/product_appeal'))).toBe(false)
  })
  it('a permission Meta refuses is said with what a person can do', async () => {
    h.routes[`${IG}/catalog_product_search`] = metaError('10', 'Application does not have permission for this action', 'forbidden')
    expect((await run('meta-instagram-product-tags', { view: 'search', catalogId: CATALOG })).error).toMatch(/instagram_shopping_tag_products/)
  })
})

describe('every view asks only what the real gateway lets through', () => {
  it('all views of the three tools, with made-up answers', async () => {
    const views: Array<[string, Record<string, unknown>]> = [
      ['meta-product-sets', { view: 'list', catalogId: CATALOG, parentId: '0', ancestorId: SET, hasChildren: true, retailerId: 'SET-1' }],
      ['meta-product-sets', { view: 'set', productSetId: SET }], ['meta-product-sets', { view: 'set', productSetId: SET, catalogId: CATALOG }],
      ['meta-product-sets', { view: 'items', productSetId: SET, conditions: [{ field: 'name', op: 'i_contains', value: 'jacket' }], errorType: 'IMAGE_RESOLUTION_LOW', errorPriority: 'low' }],
      ['meta-product-sets', { view: 'preview', catalogId: CATALOG, conditions: [{ field: 'custom_label_0', op: 'eq', value: 'summer' }, { field: 'price_amount', op: 'gte', amountMinor: 1000 }] }],
      ['meta-product-sets', { view: 'preview', productSetId: SET }],
      ['meta-product-sets', { view: 'facets', catalogId: CATALOG, conditions: [{ field: 'availability', op: 'eq', value: 'in stock' }] }],
      ['meta-commerce', { view: 'accounts' }], ['meta-commerce', { view: 'account', commerceAccountId: CMS, country: 'IT', locale: 'en_US' }],
      ['meta-commerce', { view: 'shops', commerceAccountId: CMS }], ['meta-commerce', { view: 'shop', shopId: SHOP, commerceAccountId: CMS }],
      ['meta-commerce', { view: 'setup-status' }], ['meta-commerce', { view: 'setup-status', commerceAccountId: CMS }],
      ['meta-commerce', { view: 'checkout-countries', commerceAccountId: CMS, countries: ['IT', 'DE'] }],
      ['meta-instagram-product-tags', { view: 'eligibility' }], ['meta-instagram-product-tags', { view: 'catalogs' }],
      ['meta-instagram-product-tags', { view: 'search', search: 'Jacket' }], ['meta-instagram-product-tags', { view: 'tags', mediaId: MEDIA, slides: true }],
      ['meta-instagram-product-tags', { view: 'appeal', itemId: ITEM, catalogId: CATALOG }],
    ]
    const failed: unknown[] = []
    for (const [name, args] of views) {
      const res = await run(name, args)
      if (!res.ok) failed.push([name, args.view, res.error])
    }
    expect(failed).toEqual([])
    expect(gatewayProblems()).toEqual([])
    // Nexus's own rule went to Meta, never a caller's JSON; a price as Meta's price × 100.
    expect(h.calls.find((c) => c.operation === 'productSets.preview' && c.query?.filter)?.query?.filter).toEqual({ and: [{ custom_label_0: { eq: 'summer' } }, { price_amount: { gte: 1000 } }] })
    expect(h.calls.find((c) => c.path === CMS && String(c.query?.fields).includes('privacy_policy_localized'))?.query?.fields).toBe('id,privacy_policy_localized.locale(en_US)')
  })
  it('a condition is typed: raw JSON, an unknown field or operator never reaches Meta', () => {
    const parse = (args: Record<string, unknown>) => tool('meta-product-sets').input.safeParse({ view: 'preview', catalogId: CATALOG, ...args }).success
    expect(parse({ conditions: [{ field: 'brand', op: 'eq', value: 'A' }] })).toBe(true)
    expect(parse({ filter: '{"brand":{"eq":"A"}}' })).toBe(true) // an unknown key is dropped by the schema, never sent
    expect(parse({ conditions: [{ field: 'review_status', op: 'eq', value: 'x' }] })).toBe(false)
    expect(parse({ conditions: [{ field: 'brand', op: 'regex', value: 'x' }] })).toBe(false)
    expect(parse({ conditions: Array.from({ length: 21 }, () => ({ field: 'brand', op: 'eq', value: 'A' })) })).toBe(false)
  })
})
