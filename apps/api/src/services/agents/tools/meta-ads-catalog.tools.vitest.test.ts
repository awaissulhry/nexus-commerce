/**
 * Meta ads step 12 — meta-catalogs, meta-catalog-items, meta-catalog-feeds, meta-catalog-health. A catalog is read only
 * when the chosen ad account's business portfolio owns it (or it is a client catalog of that portfolio) and no other
 * business in Nexus uses that portfolio — a shared portfolio is refused before any call; every id below a catalog is
 * checked to be in a readable catalog before it is read; who writes a catalog (D7) is answered from Meta's data sources,
 * feeds, items and smart pixel; item prices are minor units under restricted keys; every call is one the real gateway lets
 * through. Meta and the database are stubbed; made-up ids only.
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
  metaReadAll: vi.fn(async () => { throw new Error('step 12 reads page by page with metaReadOne') }),
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
import { META_ADS_CATALOG_TOOLS, META_CATALOG_MONEY } from './meta-ads-catalog.tools.js'
import { META_ADS_OBJECTS_TOOLS } from './meta-ads-objects.tools.js'
import { catalogPriceMinor, itemFilter, moneySafe } from '../../marketing/meta-ads/live-catalog.js'
import {
  CATALOG_NO_OWNER, CATALOG_NOT_OWNED_FOR_WRITE, CATALOG_NOT_READABLE, CATALOG_PORTFOLIO_SHARED, CATALOG_SEGMENT_ITEMS, CATALOG_SHARED_OUT, D7_NEXUS_COLUMNS, D7_SHOPIFY,
  NAME_HIDDEN, nameOrHost, writableCatalog,
} from '../../marketing/meta-ads/catalog-rule.js'
import { metaChosenAccount } from '../../marketing/meta-ads/live.js'
import { MetaReadError, failureOfAnswer } from '../../marketing/meta-ads/errors.js'
import { metaUrl } from '../../gateway/meta.js'
import { metaReadOnlyProblem } from '../../gateway/meta-calls.js'

const tool = (name: string) => [...META_ADS_CATALOG_TOOLS, ...META_ADS_OBJECTS_TOOLS].find((t) => t.name === name)!
const ctx = { can: () => true, via: 'claude' as const }
const run = async (name: string, args: Record<string, unknown>) => tool(name).handler(tool(name).input.parse(args), ctx as never) as Promise<{ ok: boolean; data?: any; error?: string }>
const PORTFOLIO = '9876543210'
const OTHER_PORTFOLIO = '9876543299'
const CATALOG = '120000000000700'
const CLIENT_CATALOG = '120000000000701'
const FOREIGN_CATALOG = '120000000000799'
const FEED = '120000000000710'
const UPLOAD = '120000000000720'
const ERROR_ID = '120000000000730'
const ITEM = '120000000000740'
const GROUP = '120000000000750'
const PIXEL = '120000000000760'
const ADSET = '120000000000201'
const NEXUS_APP = '310000000000001'
const CHOSEN = {
  connectionId: 'conn-1', state: 'ok', stateText: 'ok', appId: NEXUS_APP, systemUser: { id: '100000000000001', name: null },
  adAccount: { adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR', timeZone: 'Europe/Rome', businessId: PORTFOLIO },
  page: { pageId: '120000000000010', name: 'Shop A' }, instagram: null, read: {},
}
const metaError = (code: string, words: string, errorClass = 'validation') => new MetaReadError(failureOfAnswer({ status: 400, verdict: { errorClass, channelCode: code, channelMessage: words } as never }), 'x', 1)
const gatewayProblems = () => h.calls.map((c) => [c.operation, metaReadOnlyProblem({ method: 'GET', url: metaUrl(c.path, (c.query ?? {}) as never), kind: 'read' })]).filter(([, problem]) => problem)
const catalogNode = (id: string, owner: string, extra: Record<string, unknown> = {}) => ({ id, name: `Catalog ${id.slice(-3)}`, business: { id: owner, name: 'Shop A' }, vertical: 'commerce', product_count: 3, feed_count: 1, is_catalog_segment: false, ...extra })
const ITEM_BODY = { id: ITEM, retailer_id: 'SKU-1', retailer_product_group_id: 'GROUP-1', name: 'Jacket', availability: 'in stock', price: '€49.90', sale_price: '€39.90', currency: 'EUR', product_catalog: { id: CATALOG }, review_status: 'rejected', review_rejection_reasons: ['POLICY'] }

function defaultRoutes(): Record<string, unknown> {
  return {
    [CATALOG]: catalogNode(CATALOG, PORTFOLIO),
    [CLIENT_CATALOG]: catalogNode(CLIENT_CATALOG, OTHER_PORTFOLIO),
    [FOREIGN_CATALOG]: catalogNode(FOREIGN_CATALOG, OTHER_PORTFOLIO),
    [`${PORTFOLIO}/owned_product_catalogs`]: [catalogNode(CATALOG, PORTFOLIO)],
    [`${PORTFOLIO}/client_product_catalogs`]: [{ ...catalogNode(CLIENT_CATALOG, OTHER_PORTFOLIO), permitted_roles: ['ADVERTISER'] }],
    [`${CATALOG}/product_feeds`]: [{ id: FEED, name: 'Main feed', deletion_enabled: true, ingestion_source_type: 'primary_feed', schedule: { interval: 'DAILY', hour: 3, url: 'https://user:secret@feeds.example.com/main.csv?key=abc' }, latest_upload: { id: UPLOAD, num_deleted_items: 2, error_count: 1, url: 'https://feeds.example.com/main.csv?key=abc' } }],
    [`${FEED}/uploads`]: [{ id: UPLOAD }],
    [`${FEED}/rules`]: [{ id: '120000000000770', attribute: 'title', rule_type: 'fallback_rule' }],
    [`${UPLOAD}/errors`]: [{ id: ERROR_ID, summary: 'Missing price', severity: 'fatal' }],
    [UPLOAD]: { id: UPLOAD, input_method: 'Server Fetch', url: 'https://feeds.example.com/main.csv?key=abc', num_deleted_items: 0 },
    [`${CATALOG}/external_event_sources`]: [{ id: PIXEL, name: 'Shop A pixel', source_type: 'PIXEL' }],
    [ITEM]: ITEM_BODY,
    [GROUP]: { id: GROUP, product_catalog: { id: CATALOG }, retailer_id: 'GROUP-1', variants: [{ label: 'Size' }] },
    [`${CATALOG}/products`]: [ITEM_BODY],
    [`${CATALOG}/check_batch_request_status`]: { data: [{ handle: 'AbC', status: 'finished', errors_total_count: 1, ids_of_invalid_requests: ['SKU-9'] }] },
    [`${CATALOG}/event_stats`]: [
      { event: 'ViewContent', event_source: { id: PIXEL, name: 'Shop A pixel', source_type: 'PIXEL' }, total_matched_content_ids: 80, total_unmatched_content_ids: 20 },
      { event: 'Purchase', event_source: { id: '120000000000761' }, total_matched_content_ids: 10, total_unmatched_content_ids: 0 },
    ],
    [`${CATALOG}/dpa_eligible_ad_accounts`]: [{ id: 'act_1234567890', account_id: '1234567890', name: 'Shop A ads' }, { id: 'act_5550001112', account_id: '5550001112', name: 'Shop B ads' }],
    [`${CATALOG}/agencies`]: [{ id: '777000000000001', name: 'Agency A' }, { id: OTHER_PORTFOLIO, name: 'Shop B' }],
  }
}

beforeEach(() => { h.connections = [CHOSEN]; h.calls.length = 0; h.routes = defaultRoutes(); h.override = null; h.taken = [] })

describe('the four tools are reads', () => {
  it('none changes anything; each reaches Meta (open world) with ads.view; only the items tool holds money, restricted to revenue view', () => {
    expect(META_ADS_CATALOG_TOOLS.map((t) => t.name)).toEqual(['meta-catalogs', 'meta-catalog-items', 'meta-catalog-feeds', 'meta-catalog-health'])
    for (const t of META_ADS_CATALOG_TOOLS) {
      expect({ readOnly: t.readOnly, execute: t.execute, openWorld: t.openWorld, requires: t.requires, riskTier: t.riskTier, category: t.category })
        .toEqual({ readOnly: true, execute: undefined, openWorld: true, requires: ['ads.view'], riskTier: 'low', category: 'insights' })
    }
    expect(tool('meta-catalog-items').restrictedFields).toEqual(META_CATALOG_MONEY)
    expect(new Set(Object.values(META_CATALOG_MONEY))).toEqual(new Set([FIELDS.financialsRevenueView]))
    for (const name of ['meta-catalogs', 'meta-catalog-feeds', 'meta-catalog-health']) expect(tool(name).restrictedFields).toBeUndefined()
  })
})

describe('which catalogs a business may read (the one rule)', () => {
  const everyView: Array<[string, Record<string, unknown>]> = [
    ['meta-catalogs', { view: 'list' }], ['meta-catalogs', { view: 'catalog', catalogId: CATALOG }], ['meta-catalogs', { view: 'page-catalogs' }],
    ['meta-catalogs', { view: 'collaborative' }], ['meta-catalog-items', { view: 'item', itemId: ITEM }], ['meta-catalog-items', { view: 'list', catalogId: CATALOG }],
    ['meta-catalog-feeds', { view: 'list', catalogId: CATALOG }], ['meta-catalog-health', { view: 'readiness', catalogId: CATALOG }],
    ['meta-ad-details', { view: 'catalog-categories', adSetId: ADSET, criteria: 'BRAND' }],
  ]
  it('a portfolio another business in Nexus uses too: every catalog read is refused in one plain sentence, before any call', async () => {
    h.taken = [{ product: 'PORTFOLIO', id: PORTFOLIO }]
    for (const [name, args] of everyView) {
      const res = await run(name, args)
      expect(res.error, name).toBe(CATALOG_PORTFOLIO_SHARED)
    }
    expect(h.calls).toHaveLength(0)
  })
  it('no Meta, or an ad account without a portfolio: refused in words before any call', async () => {
    h.connections = []
    expect((await run('meta-catalogs', { view: 'list' })).error).toMatch(/Settings › Channels › Meta/)
    h.connections = [{ ...CHOSEN, adAccount: { ...CHOSEN.adAccount, businessId: null } }]
    expect((await run('meta-catalog-health', { view: 'diagnostics', catalogId: CATALOG })).error).toMatch(/names no business portfolio/)
    expect(h.calls).toHaveLength(0)
  })
  it('a catalog neither owned by the portfolio nor a client catalog of it is refused before any of its edges is read', async () => {
    for (const [name, args] of [
      ['meta-catalogs', { view: 'catalog', catalogId: FOREIGN_CATALOG }], ['meta-catalog-items', { view: 'list', catalogId: FOREIGN_CATALOG }],
      ['meta-catalog-feeds', { view: 'list', catalogId: FOREIGN_CATALOG }], ['meta-catalog-health', { view: 'rejected', catalogId: FOREIGN_CATALOG }],
    ] as Array<[string, Record<string, unknown>]>) {
      h.calls.length = 0
      expect((await run(name, args)).error, name).toBe(CATALOG_NOT_READABLE)
      expect(h.calls.map((c) => c.operation), name).toEqual(['catalog.ownerCheck', 'catalog.clientCheck'])
    }
  })
  it('a client catalog is read; one whose owner is another Nexus business\'s portfolio is not (and is its id only in a list)', async () => {
    expect((await run('meta-catalogs', { view: 'catalog', catalogId: CLIENT_CATALOG })).data).toMatchObject({ catalogId: CLIENT_CATALOG, relation: 'client' })
    h.taken = [{ product: 'PORTFOLIO', id: OTHER_PORTFOLIO }]
    expect((await run('meta-catalogs', { view: 'catalog', catalogId: CLIENT_CATALOG })).error).toMatch(/business portfolio another business in Nexus uses/)
    const list = (await run('meta-catalogs', { view: 'list' })).data
    expect(list.items).toContainEqual({ catalogId: CLIENT_CATALOG, takenByAnotherBusiness: true })
    expect(JSON.stringify(list)).not.toContain('Catalog 701')
  })
  it('an id that is not a catalog (Meta does not know a catalog\'s fields on it) is refused', async () => {
    h.routes[CATALOG] = metaError('100', 'Tried accessing nonexisting field (vertical) on node type (AdAccount)')
    expect((await run('meta-catalog-feeds', { view: 'list', catalogId: CATALOG })).error).toMatch(/is not a Meta catalog/)
  })
  it('step 6 catalog categories use the same rule (a client catalog passes; another portfolio\'s catalog is refused)', async () => {
    h.override = (req) => (req.path === ADSET && req.operation === 'graph.ownerCheck' ? { account_id: '1234567890', optimization_goal: 'x', billing_event: 'x' } : req.path === ADSET ? { promoted_object: { product_catalog_id: FOREIGN_CATALOG } } : undefined)
    expect((await run('meta-ad-details', { view: 'catalog-categories', adSetId: ADSET, criteria: 'BRAND' })).error).toBe(CATALOG_NOT_READABLE)
    expect(h.calls.some((c) => c.path.endsWith('/categories'))).toBe(false)
    h.override = (req) => (req.path === ADSET && req.operation === 'graph.ownerCheck' ? { account_id: '1234567890', optimization_goal: 'x', billing_event: 'x' } : req.path === ADSET ? { promoted_object: { product_catalog_id: CLIENT_CATALOG } } : undefined)
    expect((await run('meta-ad-details', { view: 'catalog-categories', adSetId: ADSET, criteria: 'BRAND' })).ok).toBe(true)
  })
})

describe('every id below a catalog is checked before it is read', () => {
  it('an item of a catalog the business may not read: refused after its owner-only read', async () => {
    h.routes[ITEM] = { ...ITEM_BODY, product_catalog: { id: FOREIGN_CATALOG } }
    expect((await run('meta-catalog-items', { view: 'item', itemId: ITEM })).error).toBe(CATALOG_NOT_READABLE)
    expect(h.calls.map((c) => c.operation)).toEqual(['catalog.item.ownerCheck', 'catalog.ownerCheck', 'catalog.clientCheck'])
    expect(h.calls[0].query?.fields).toBe('product_catalog{id},retailer_id,availability')
  })
  it('an item named with another catalog, or an id that is not an item, is refused', async () => {
    expect((await run('meta-catalog-items', { view: 'item', itemId: ITEM, catalogId: CLIENT_CATALOG })).error).toMatch(/not in the catalog named/)
    h.routes[ITEM] = metaError('100', 'Tried accessing nonexisting field (availability) on node type (ProductSet)')
    expect((await run('meta-catalog-items', { view: 'channels', itemId: ITEM })).error).toMatch(/is not a catalog item/)
    h.routes[GROUP] = metaError('100', 'Tried accessing nonexisting field (variants) on node type (ProductItem)')
    expect((await run('meta-catalog-items', { view: 'group', groupId: GROUP })).error).toMatch(/is not an item group/)
  })
  it('a feed, upload, error or pixel not in its parent\'s own list is refused before it is read', async () => {
    const before = (n: number) => h.calls.slice(n).map((c) => c.path)
    expect((await run('meta-catalog-feeds', { view: 'feed', catalogId: CATALOG, feedId: '120000000000711' })).error).toMatch(/not one of this catalog's feeds/)
    expect(before(0)).not.toContain('120000000000711')
    h.calls.length = 0
    expect((await run('meta-catalog-feeds', { view: 'upload', catalogId: CATALOG, feedId: FEED, uploadId: '120000000000721' })).error).toMatch(/not among this feed's newest/)
    expect(before(0)).not.toContain('120000000000721')
    expect((await run('meta-catalog-feeds', { view: 'suggested-rules', catalogId: CATALOG, feedId: FEED, uploadId: UPLOAD, errorId: '120000000000731' })).error).toMatch(/not one of this upload's errors/)
    expect((await run('meta-catalog-health', { view: 'pixel-checks', catalogId: CATALOG, sourceId: '120000000000769' })).error).toMatch(/not connected to this catalog/)
    expect((await run('meta-catalog-feeds', { view: 'uploads', feedId: FEED })).error).toMatch(/Name the catalog/)
  })
})

describe('every view asks only what the real gateway lets through', () => {
  it('all views of the four tools, with made-up answers', async () => {
    const views: Array<[string, Record<string, unknown>]> = [
      ...(['list', 'categories', 'page-catalogs', 'shop-catalogs', 'collaborative'] as const).map((view) => ['meta-catalogs', { view }] as [string, Record<string, unknown>]),
      ...(['catalog', 'writer', 'data-sources', 'segments', 'event-sources', 'people', 'partners', 'collaborative', 'bundle-folders', 'smart-pixel'] as const).map((view) => ['meta-catalogs', { view, catalogId: CATALOG }] as [string, Record<string, unknown>]),
      ['meta-catalogs', { view: 'event-sources' }], ['meta-catalogs', { view: 'data-sources', catalogId: CATALOG, sourceType: 'supplementary' }],
      ['meta-catalog-items', { view: 'list', catalogId: CATALOG, skus: ['SKU-1', 'SKU-2'], groupSku: 'GROUP-1', nameContains: 'jacket', availability: 'In Stock', reviewStatus: 'rejected', errorType: 'IMAGE_RESOLUTION_LOW', errorPriority: 'high' }],
      ['meta-catalog-items', { view: 'feed-items', catalogId: CATALOG, feedId: FEED, skus: ['SKU-1'] }],
      ['meta-catalog-items', { view: 'item', itemId: ITEM }], ['meta-catalog-items', { view: 'item', itemId: ITEM, country: 'it' }], ['meta-catalog-items', { view: 'item', itemId: ITEM, language: 'it_IT' }],
      ['meta-catalog-items', { view: 'overrides', itemId: ITEM, overrideType: 'country', overrideKeys: ['IT'] }], ['meta-catalog-items', { view: 'channels', itemId: ITEM }],
      ['meta-catalog-items', { view: 'item-sets', itemId: ITEM }], ['meta-catalog-items', { view: 'item-videos', itemId: ITEM }],
      ['meta-catalog-items', { view: 'groups', catalogId: CATALOG }], ['meta-catalog-items', { view: 'group', groupId: GROUP }],
      ['meta-catalog-items', { view: 'batch-status', catalogId: CATALOG, handle: 'AbC-1_2:x=' }], ['meta-catalog-items', { view: 'sets-batch-status', catalogId: CATALOG, handle: 'AbC' }],
      ...(['list'] as const).map((view) => ['meta-catalog-feeds', { view, catalogId: CATALOG }] as [string, Record<string, unknown>]),
      ...(['feed', 'schedules', 'uploads', 'rules'] as const).map((view) => ['meta-catalog-feeds', { view, catalogId: CATALOG, feedId: FEED }] as [string, Record<string, unknown>]),
      ['meta-catalog-feeds', { view: 'upload', catalogId: CATALOG, feedId: FEED, uploadId: UPLOAD }], ['meta-catalog-feeds', { view: 'upload-errors', catalogId: CATALOG, feedId: FEED, uploadId: UPLOAD, errorPriority: 'medium' }],
      ['meta-catalog-feeds', { view: 'suggested-rules', catalogId: CATALOG, feedId: FEED, uploadId: UPLOAD, errorId: ERROR_ID }],
      ['meta-catalog-health', { view: 'diagnostics', catalogId: CATALOG, types: ['IMAGE_QUALITY'], severities: ['MUST_FIX'], channels: ['da'], entities: ['product_item'] }],
      ['meta-catalog-health', { view: 'problem-items', catalogId: CATALOG, errorType: 'IMAGE_RESOLUTION_LOW' }], ['meta-catalog-health', { view: 'rejected', catalogId: CATALOG }],
      ['meta-catalog-health', { view: 'match-rate', catalogId: CATALOG, byDevice: true }], ['meta-catalog-health', { view: 'pixel-checks', catalogId: CATALOG, sourceId: PIXEL, checks: ['pixel_decline'], connectionMethod: 'all' }],
      ['meta-catalog-health', { view: 'eligible-accounts', catalogId: CATALOG }], ['meta-catalog-health', { view: 'readiness', catalogId: CATALOG }],
    ]
    h.routes[`${CHOSEN.page.pageId}/commerce_merchant_settings`] = [{ id: '130000000000001', display_name: 'Shop A shop' }]
    h.routes['130000000000001/product_catalogs'] = [catalogNode(CATALOG, PORTFOLIO)]
    h.routes[`${CHOSEN.page.pageId}/product_catalogs`] = [catalogNode(CATALOG, PORTFOLIO), catalogNode(FOREIGN_CATALOG, OTHER_PORTFOLIO)]
    const failed: unknown[] = []
    for (const [name, args] of views) {
      const res = await run(name, args)
      if (!res.ok) failed.push([name, args.view, res.error])
    }
    expect(failed).toEqual([])
    expect(gatewayProblems()).toEqual([])
    // The filter is Nexus's own rule from typed args; the override keys go only on the item's own read.
    const list = h.calls.find((c) => c.operation === 'items.list')!
    expect(list.query?.filter).toEqual({ and: [{ retailer_id: { is_any: ['SKU-1', 'SKU-2'] } }, { retailer_product_group_id: { eq: 'GROUP-1' } }, { name: { i_contains: 'jacket' } }, { availability: { eq: 'in stock' } }, { review_status: { eq: 'rejected' } }] })
    expect(h.calls.filter((c) => c.query?.override_country).map((c) => [c.operation, c.query?.override_country])).toEqual([['items.one', 'IT']])
    expect(h.calls.find((c) => c.operation === 'catalog.people')?.query?.business).toBe(PORTFOLIO)
    expect(h.calls.find((c) => c.operation === 'catalog.dataSources' && !c.query?.ingestion_source_type)).toBeUndefined()
  })
})

describe('who writes a catalog (D7)', () => {
  beforeEach(() => { h.routes[`${CATALOG}/products`] = [] })
  const writer = async () => (await run('meta-catalogs', { view: 'writer', catalogId: CATALOG })).data
  it('Shopify named by a data source: shopify, and Nexus must not write items', async () => {
    h.routes[`${CATALOG}/product_feeds`] = []
    h.routes[`${CATALOG}/data_sources`] = [{ id: '140000000000001', name: 'Shopify', app_id: '320000000000001', upload_type: 'PARTNER' }]
    const w = await writer()
    expect(w).toMatchObject({ writer: 'shopify', shopifyWrites: true, nexusMayWriteItems: false })
    expect(w.sentence.startsWith(D7_SHOPIFY)).toBe(true)
    expect(h.calls.find((c) => c.operation === 'catalog.writer.dataSources')?.query?.ingestion_source_type).toBe('ALL')
  })
  it('a feed fetched from a Shopify host, items Meta flags with a Shopify error: shopify', async () => {
    h.routes[`${CATALOG}/product_feeds`] = [{ id: FEED, name: 'Products', schedule: { url: 'https://shop-a.myshopify.com/feed.xml' } }]
    expect(await writer()).toMatchObject({ writer: 'shopify', shopifyWrites: true })
    h.routes[`${CATALOG}/product_feeds`] = []
    h.routes[`${CATALOG}/data_sources`] = [{ id: '140000000000002', upload_type: 'API', app_id: '320000000000001' }]
    h.override = (req) => (req.operation === 'catalog.writer.shopifyItems' && req.query?.error_type === 'INACTIVE_SHOPIFY_PRODUCT' ? [{ id: ITEM }] : undefined)
    const w = await writer()
    expect(w).toMatchObject({ writer: 'mixed', shopifyWrites: true, nexusMayWriteItems: false })
    expect(w.sentence.startsWith(D7_SHOPIFY)).toBe(true)
  })
  it('a plain feed: feed; only Nexus\'s own app: api and Nexus may write; another app: not', async () => {
    expect(await writer()).toMatchObject({ writer: 'feed', shopifyWrites: false, nexusMayWriteItems: false })
    h.routes[`${CATALOG}/product_feeds`] = []
    h.routes[`${CATALOG}/data_sources`] = [{ id: '140000000000003', upload_type: 'API', app_id: NEXUS_APP }]
    expect(await writer()).toMatchObject({ writer: 'api', nexusMayWriteItems: true })
    h.routes[`${CATALOG}/data_sources`] = [{ id: '140000000000003', upload_type: 'API', app_id: '320000000000009' }]
    expect(await writer()).toMatchObject({ writer: 'api', nexusMayWriteItems: false })
  })
  it('the smart pixel making items is a writer; no source with no items is none; items with no source, or a refused read, is unknown', async () => {
    h.routes[`${CATALOG}/product_feeds`] = []
    h.routes[`${CATALOG}/smart_pixel_settings`] = [{ id: '150000000000001', is_create_enabled: true }]
    expect(await writer()).toMatchObject({ writer: 'pixel', nexusMayWriteItems: false })
    h.routes[`${CATALOG}/smart_pixel_settings`] = []
    h.routes[CATALOG] = catalogNode(CATALOG, PORTFOLIO, { product_count: 0 })
    expect(await writer()).toMatchObject({ writer: 'none', nexusMayWriteItems: true })
    h.routes[CATALOG] = catalogNode(CATALOG, PORTFOLIO, { product_count: 12 })
    expect(await writer()).toMatchObject({ writer: 'unknown', nexusMayWriteItems: false })
    h.routes[CATALOG] = catalogNode(CATALOG, PORTFOLIO, { product_count: 0 })
    h.routes[`${CATALOG}/data_sources`] = metaError('200', 'Permissions error', 'forbidden')
    const w = await writer()
    expect(w).toMatchObject({ writer: 'unknown', nexusMayWriteItems: false })
    expect(w.notRead[0]).toMatch(/^data sources: /)
  })
  it('a supplementary feed changes fields only: it is not a writer of items', async () => {
    h.routes[`${CATALOG}/product_feeds`] = [{ id: FEED, name: 'Labels', ingestion_source_type: 'supplementary_feed' }]
    h.routes[`${CATALOG}/data_sources`] = [{ id: '140000000000001', name: 'Shopify' }]
    expect(await writer()).toMatchObject({ writer: 'shopify' })
  })
})

describe('fix round 1 — the writer gate lane C4 relies on (A2) and the write rule (A3)', () => {
  beforeEach(() => {
    h.routes[`${CATALOG}/products`] = []
    h.routes[`${CATALOG}/product_feeds`] = []
    h.routes[CATALOG] = catalogNode(CATALOG, PORTFOLIO, { product_count: 0 })
  })
  const writer = async () => (await run('meta-catalogs', { view: 'writer', catalogId: CATALOG })).data
  it('(a) Meta gives no item count: unknown, never none', async () => {
    h.routes[CATALOG] = catalogNode(CATALOG, PORTFOLIO, { product_count: undefined })
    expect(await writer()).toMatchObject({ writer: 'unknown', nexusMayWriteItems: false })
  })
  it('(b) a supplementary Shopify source counts: never none or api with shopifyWrites', async () => {
    h.routes[`${CATALOG}/data_sources`] = [{ id: '140000000000003', upload_type: 'API', app_id: NEXUS_APP }, { id: '140000000000004', name: 'Shopify', ingestion_source_type: 'SUPPLEMENTARY' }]
    const w = await writer()
    expect(w).toMatchObject({ writer: 'mixed', shopifyWrites: true, nexusMayWriteItems: false })
    h.routes[`${CATALOG}/data_sources`] = [{ id: '140000000000004', name: 'Shopify', ingestion_source_type: 'SUPPLEMENTARY' }]
    expect(await writer()).toMatchObject({ writer: 'shopify', nexusMayWriteItems: false })
  })
  it('(c) the quick check (views list, catalog, readiness) never decides: nexusMayWriteItems null', async () => {
    const list = (await run('meta-catalogs', { view: 'list' })).data
    expect(list.items[0].writer).toMatchObject({ nexusMayWriteItems: null, deep: false })
    expect(list.items[0].writer.sentence).toMatch(/view writer decides/)
    expect((await run('meta-catalogs', { view: 'catalog', catalogId: CATALOG })).data.writer.nexusMayWriteItems).toBeNull()
    expect((await run('meta-catalog-health', { view: 'readiness', catalogId: CATALOG })).data.writer.nexusMayWriteItems).toBeNull()
    expect(await writer()).toMatchObject({ writer: 'none', nexusMayWriteItems: true, deep: true })
  })
  it('(d) a source list with more pages than read is not read', async () => {
    h.override = (req) => (req.operation === 'catalog.writer.dataSources' ? { data: [{ id: '140000000000003', upload_type: 'API', app_id: NEXUS_APP }], paging: { cursors: { after: 'x' }, next: 'https://graph.facebook.com/next' } } : undefined)
    const w = await writer()
    expect(w).toMatchObject({ nexusMayWriteItems: false })
    expect(w.notRead.join(' ')).toMatch(/more than 100/)
  })
  it('(e) a shop selling from the catalog counts; the shop read refused is not read', async () => {
    h.override = (req) => (req.operation === 'catalog.writer.shop' ? { id: CATALOG, commerce_merchant_settings: { id: '130000000000001' } } : undefined)
    expect(await writer()).toMatchObject({ writer: 'none', commerceAccountId: '130000000000001', nexusMayWriteItems: false })
    h.override = (req) => (req.operation === 'catalog.writer.shop' ? metaError('100', 'Tried accessing nonexisting field (commerce_merchant_settings)') : undefined)
    expect(await writer()).toMatchObject({ nexusMayWriteItems: false })
  })
  it('writableCatalog: never a client catalog, never one shared with another Nexus business, items only when the writer allows', async () => {
    const account = await metaChosenAccount()
    await expect(writableCatalog(account, CLIENT_CATALOG, 'settings')).rejects.toThrow(CATALOG_NOT_OWNED_FOR_WRITE)
    h.routes[`${CATALOG}/agencies`] = [{ id: OTHER_PORTFOLIO }]
    h.taken = [{ product: 'PORTFOLIO', id: OTHER_PORTFOLIO }]
    await expect(writableCatalog(account, CATALOG, 'settings')).rejects.toThrow(CATALOG_SHARED_OUT)
    h.taken = []
    h.routes[`${CATALOG}/connected_businesses`] = metaError('200', 'Permissions error', 'forbidden')
    await expect(writableCatalog(account, CATALOG, 'settings')).rejects.toThrow(/could not read who else has this catalog/)
    h.routes[`${CATALOG}/connected_businesses`] = [{ id: PORTFOLIO }]
    expect((await writableCatalog(account, CATALOG, 'items')).writer.nexusMayWriteItems).toBe(true)
    h.routes[`${CATALOG}/data_sources`] = [{ id: '140000000000001', name: 'Shopify' }]
    await expect(writableCatalog(account, CATALOG, 'items')).rejects.toThrow(D7_SHOPIFY)
    // A product set or label on a Shopify catalog (what D7 lets Nexus add): allowed, with the writer for the preview.
    expect((await writableCatalog(account, CATALOG, 'settings')).writer).toMatchObject({ writer: 'shopify', nexusMayWriteItems: false })
  })
})

describe('fix round 2', () => {
  beforeEach(() => {
    h.routes[`${CATALOG}/products`] = []
    h.routes[`${CATALOG}/product_feeds`] = []
    h.routes[CATALOG] = catalogNode(CATALOG, PORTFOLIO, { product_count: 0 })
    h.routes[CLIENT_CATALOG] = catalogNode(CLIENT_CATALOG, OTHER_PORTFOLIO, { product_count: 0 })
  })
  const writer = async (catalogId: string) => (await run('meta-catalogs', { view: 'writer', catalogId })).data
  it('1: the deep writer never lets Nexus write items in a client catalog, or an owned one shared with another Nexus business', async () => {
    const client = await writer(CLIENT_CATALOG)
    expect(client).toMatchObject({ writer: 'none', ownership: 'client', nexusMayWriteItems: false })
    expect(client.sentence).toMatch(/client catalog/)
    expect(await writer(CATALOG)).toMatchObject({ ownership: 'owned', nexusMayWriteItems: true })
    h.routes[`${CATALOG}/connected_businesses`] = [{ id: PORTFOLIO }, { id: OTHER_PORTFOLIO }]
    h.taken = [{ product: 'PORTFOLIO', id: OTHER_PORTFOLIO }]
    const shared = await writer(CATALOG)
    expect(shared).toMatchObject({ ownership: 'shared', nexusMayWriteItems: false })
    expect(shared.sentence).toMatch(/shared with a business portfolio another business in Nexus uses/)
  })
  it('3: a feed or source name that is an address is its host only — data sources, writtenBy, the item\'s feed, readiness', async () => {
    const address = 'https://user:pw@feeds.example.com/export/SECRETTOKEN.xml?key=abc'
    h.routes[`${CATALOG}/data_sources`] = [{ id: '140000000000005', name: address }]
    h.routes[ITEM] = { ...ITEM_BODY, product_feed: { id: FEED, name: address } }
    h.routes[`${CATALOG}/product_feeds`] = [{ id: FEED, name: address, latest_upload: { error_count: 2 } }]
    const answers = [
      (await run('meta-catalogs', { view: 'data-sources', catalogId: CATALOG })).data,
      (await run('meta-catalog-items', { view: 'item', itemId: ITEM })).data,
      (await run('meta-catalog-health', { view: 'readiness', catalogId: CATALOG })).data,
      (await run('meta-catalogs', { view: 'writer', catalogId: CATALOG })).data,
    ]
    for (const answer of answers) expect(JSON.stringify(answer)).not.toMatch(/SECRETTOKEN|key=abc|pw@|export/)
    expect(answers[0].items[0].name).toBe('feeds.example.com')
    expect(answers[1].writtenBy.name).toBe('feeds.example.com')
    expect(answers[1].item.productFeed.name).toBe('feeds.example.com')
    // Round 5 item 4 — each masked name says why.
    expect(answers[1].writtenBy.nameHidden).toBe(NAME_HIDDEN)
    expect(answers[1].item.productFeed.nameHidden).toBe(NAME_HIDDEN)
    expect(answers[0].items[0].nameHidden).toBe(NAME_HIDDEN)
    expect(answers[2].warnings.join(' ')).toMatch(/Feed feeds\.example\.com: its latest upload had 2 error/)
  })
  it('4: Shopify is found in a source\'s RAW name or its host, though only the host is shown', async () => {
    h.routes[`${CATALOG}/data_sources`] = [{ id: '140000000000006', name: 'https://shop-a.myshopify.com/feeds/abc123' }]
    const w = await writer(CATALOG)
    expect(w).toMatchObject({ writer: 'shopify', shopifyWrites: true, nexusMayWriteItems: false })
    expect(JSON.stringify(w)).not.toMatch(/abc123/)
  })
  it('5 (rounds 3–4): a closed purpose — D7 columns only beside Shopify / no writer / Nexus alone with nothing unread; items never on a segment', async () => {
    const account = await metaChosenAccount()
    const d7 = { upload: ['id', 'internal_label', 'custom_label_0', 'custom_number_4'] }
    // Beside Shopify: D7 fields and settings yes; anything carrying other item data ('items': URL / schedule uploads, a
    // primary feed, offer / ratings / local-inventory feeds, item writes) no.
    h.routes[`${CATALOG}/data_sources`] = [{ id: '140000000000001', name: 'Shopify' }]
    expect((await writableCatalog(account, CATALOG, d7)).writer.shopifyWrites).toBe(true)
    expect((await writableCatalog(account, CATALOG, 'settings')).writer.writer).toBe('shopify')
    await expect(writableCatalog(account, CATALOG, 'items')).rejects.toThrow(D7_SHOPIFY)
    // A rule attribute or column outside the list, or none named: refused before any call.
    h.calls.length = 0
    await expect(writableCatalog(account, CATALOG, { upload: ['id', 'price', 'title'] })).rejects.toThrow(/Shopify writes price, title; change them in Shopify/)
    await expect(writableCatalog(account, CATALOG, { upload: [] })).rejects.toThrow(/Name every column of the upload file/)
    await expect(writableCatalog(account, CATALOG, 'catalog' as never)).rejects.toThrow(/does not know this kind of catalog change/)
    expect(h.calls).toHaveLength(0)
    expect(D7_NEXUS_COLUMNS).toEqual(['internal_label', 'custom_label_0', 'custom_label_1', 'custom_label_2', 'custom_label_3', 'custom_label_4', 'custom_number_0', 'custom_number_1', 'custom_number_2', 'custom_number_3', 'custom_number_4'])
    // A feed tool (it writes custom labels itself), a plain data feed, or anything unread: no D7 fields.
    h.routes[`${CATALOG}/data_sources`] = [{ id: '140000000000001', name: 'Shopify' }, { id: '140000000000007', name: 'Channable' }]
    await expect(writableCatalog(account, CATALOG, d7)).rejects.toThrow(/Nexus adds D7 fields only beside Shopify/)
    h.routes[`${CATALOG}/data_sources`] = [{ id: '140000000000007', name: 'Feedonomics export' }]
    await expect(writableCatalog(account, CATALOG, d7)).rejects.toThrow(/Nexus adds D7 fields only beside Shopify/)
    h.routes[`${CATALOG}/data_sources`] = []
    h.routes[`${CATALOG}/product_feeds`] = [{ id: FEED, name: 'Main feed' }]
    await expect(writableCatalog(account, CATALOG, d7)).rejects.toThrow(/Nexus adds D7 fields only beside Shopify/)
    h.routes[`${CATALOG}/product_feeds`] = []
    h.routes[`${CATALOG}/data_sources`] = [{ id: '140000000000001', name: 'Shopify' }]
    h.routes[`${CATALOG}/smart_pixel_settings`] = metaError('200', 'Permissions error', 'forbidden')
    await expect(writableCatalog(account, CATALOG, d7)).rejects.toThrow(/could not read everything that writes this catalog/)
    h.routes[`${CATALOG}/smart_pixel_settings`] = []
    // Nexus's own app alone: D7 fields and items yes — but never items in a segment, or where Meta does not say.
    h.routes[`${CATALOG}/data_sources`] = [{ id: '140000000000003', upload_type: 'API', app_id: NEXUS_APP }]
    expect((await writableCatalog(account, CATALOG, d7)).writer.writer).toBe('api')
    expect((await writableCatalog(account, CATALOG, 'items')).writer.nexusMayWriteItems).toBe(true)
    h.routes[CATALOG] = catalogNode(CATALOG, PORTFOLIO, { product_count: 0, is_catalog_segment: true })
    await expect(writableCatalog(account, CATALOG, 'items')).rejects.toThrow(CATALOG_SEGMENT_ITEMS)
    h.routes[CATALOG] = catalogNode(CATALOG, PORTFOLIO, { product_count: 0, is_catalog_segment: undefined })
    await expect(writableCatalog(account, CATALOG, 'items')).rejects.toThrow(CATALOG_SEGMENT_ITEMS)
    expect((await writableCatalog(account, CATALOG, 'settings')).catalog.isSegment).toBeNull()
  })
  it('6: a smart-pixel list with more pages than read is not read', async () => {
    h.override = (req) => (req.operation === 'catalog.writer.smartPixel' ? { data: [{ id: '150000000000001', is_create_enabled: false }], paging: { cursors: { after: 'x' }, next: 'https://graph.facebook.com/next' } } : undefined)
    const w = await writer(CATALOG)
    expect(w.nexusMayWriteItems).toBe(false)
    expect(w.notRead.join(' ')).toMatch(/smart pixel settings: more than Nexus read/)
  })
})

describe('fix rounds 3–4 — the closed write purpose lane C4 uses', () => {
  beforeEach(() => {
    h.routes[`${CATALOG}/products`] = []
    h.routes[`${CATALOG}/product_feeds`] = []
    h.routes[CATALOG] = catalogNode(CATALOG, PORTFOLIO, { product_count: 0 })
  })
  const d7 = { upload: ['id', 'custom_label_1'] }
  it('1 / 4: no purpose, a list, the round-3 { fields }, both kinds, an unknown key, holes, non-texts, only the key column, bad own ids: refused before any call', async () => {
    const account = await metaChosenAccount()
    for (const purpose of [null, undefined, ['custom_label_0'], {}, { fields: ['custom_label_0'] }, { upload: ['custom_label_0'], rules: ['custom_label_1'] }, { upload: ['custom_label_0'], columns: ['price'] }]) {
      await expect(writableCatalog(account, CATALOG, purpose as never), JSON.stringify(purpose)).rejects.toThrow(/does not know this kind of catalog change/)
    }
    await expect(writableCatalog(account, CATALOG, { upload: 'custom_label_0' } as never)).rejects.toThrow(/Name every column of the upload file/)
    await expect(writableCatalog(account, CATALOG, { rules: [] })).rejects.toThrow(/Name every rule attribute/)
    await expect(writableCatalog(account, CATALOG, { upload: [, 'custom_label_0'] as never })).rejects.toThrow(/Every column is a name \(text\); entry 1 is not/)
    await expect(writableCatalog(account, CATALOG, { rules: ['custom_label_0', 7] as never })).rejects.toThrow(/Every rule attribute is a name \(text\); entry 2 is not/)
    await expect(writableCatalog(account, CATALOG, { upload: ['id'] })).rejects.toThrow(/names no field Nexus may add/)
    await expect(writableCatalog(account, CATALOG, { ...d7, ownFeedIds: FEED } as never)).rejects.toThrow(/ownFeedIds is the list/)
    await expect(writableCatalog(account, CATALOG, { ...d7, ownFeedIds: [, FEED] } as never)).rejects.toThrow(/Every own feed id is a name \(text\); entry 1 is not/)
    await expect(writableCatalog(account, CATALOG, { ...d7, ownFeedIds: ['feed-1'] })).rejects.toThrow(/Meta ids \(digits\)/)
    expect(h.calls).toHaveLength(0)
  })
  it('1: each kind on an empty catalog no one writes yet: settings, upload, rules and items pass', async () => {
    const account = await metaChosenAccount()
    expect((await writableCatalog(account, CATALOG, 'settings')).writer.writer).toBe('none')
    expect((await writableCatalog(account, CATALOG, d7)).writer.writer).toBe('none')
    expect((await writableCatalog(account, CATALOG, { rules: ['custom_label_1'], ownFeedIds: [] })).writer.writer).toBe('none')
    expect((await writableCatalog(account, CATALOG, 'items')).writer.nexusMayWriteItems).toBe(true)
  })
  it('3 (round 4): an upload may name the key column id; a feed rule never (it would re-key items)', async () => {
    const account = await metaChosenAccount()
    expect((await writableCatalog(account, CATALOG, { upload: ['id', 'custom_label_0'] })).fields).toEqual(['id', 'custom_label_0'])
    h.calls.length = 0
    await expect(writableCatalog(account, CATALOG, { rules: ['id', 'custom_label_0'] })).rejects.toThrow(/A feed rule on id would re-key the items/)
    await expect(writableCatalog(account, CATALOG, { rules: ['title'] })).rejects.toThrow(/Shopify writes title; change it in Shopify/)
    expect(h.calls).toHaveLength(0)
    expect((await writableCatalog(account, CATALOG, { rules: ['custom_label_0'] })).fields).toEqual(['custom_label_0'])
  })
  it('4 (round 4): the checked fields come back frozen, each once, a copy; items and settings return none', async () => {
    const account = await metaChosenAccount()
    const upload = ['id', 'custom_label_1', 'custom_label_1', 'internal_label', 'id']
    const res = await writableCatalog(account, CATALOG, { upload })
    expect(res.fields).toEqual(['id', 'custom_label_1', 'internal_label'])
    expect(Object.isFrozen(res.fields)).toBe(true)
    upload.push('price')
    expect(res.fields).toEqual(['id', 'custom_label_1', 'internal_label'])
    expect((await writableCatalog(account, CATALOG, { rules: ['custom_number_0', 'custom_number_0'] })).fields).toEqual(['custom_number_0'])
    expect((await writableCatalog(account, CATALOG, 'settings')).fields).toBeNull()
    expect((await writableCatalog(account, CATALOG, 'items')).fields).toBeNull()
  })
  it('1 (round 4): every supplementary feed or source Nexus did not make refuses D7 fields; one in ownFeedIds is allowed', async () => {
    const account = await metaChosenAccount()
    h.routes[`${CATALOG}/data_sources`] = [{ id: '140000000000001', name: 'Shopify' }]
    // An unnamed supplementary feed (a person's sheet, a hand-made feed): never assumed to be Nexus's.
    h.routes[`${CATALOG}/product_feeds`] = [{ id: FEED, name: 'Labels', ingestion_source_type: 'supplementary_feed' }]
    for (const kind of [{ upload: ['id', 'custom_label_1'] }, { rules: ['custom_label_1'] }]) {
      await expect(writableCatalog(account, CATALOG, kind), JSON.stringify(kind)).rejects.toThrow(`A supplementary feed or source that is not a plain feed Nexus made (${FEED})`)
      await expect(writableCatalog(account, CATALOG, { ...kind, ownFeedIds: ['120000000000799'] })).rejects.toThrow(/not a plain feed Nexus made/)
      expect((await writableCatalog(account, CATALOG, { ...kind, ownFeedIds: [FEED] })).writer.writer).toBe('shopify')
    }
    // A supplementary data source that is no feed (a sheet upload) too; settings never look at it.
    h.routes[`${CATALOG}/product_feeds`] = []
    h.routes[`${CATALOG}/data_sources`] = [{ id: '140000000000001', name: 'Shopify' }, { id: '140000000000009', name: 'Sheet', upload_type: 'MANUAL', ingestion_source_type: 'SUPPLEMENTARY_FEED' }]
    await expect(writableCatalog(account, CATALOG, d7)).rejects.toThrow('A supplementary feed or source that is not a plain feed Nexus made (140000000000009)')
    expect((await writableCatalog(account, CATALOG, { ...d7, ownFeedIds: ['140000000000009'] })).fields).toEqual(['id', 'custom_label_1'])
    expect((await writableCatalog(account, CATALOG, 'settings')).writer.writer).toBe('shopify')
  })
  it('2: a feed tool\'s feed (name, file or host) refuses D7 fields even when listed as own; a source Meta does not describe too', async () => {
    const account = await metaChosenAccount()
    h.routes[`${CATALOG}/data_sources`] = [{ id: '140000000000001', name: 'Shopify' }]
    for (const feed of [{ name: 'Channable labels' }, { name: 'Labels', file_name: 'productsup_export.csv' }, { name: 'Labels', schedule: { url: 'https://feedonomics.example.com/x/labels.csv' } }]) {
      h.routes[`${CATALOG}/product_feeds`] = [{ id: FEED, ingestion_source_type: 'supplementary_feed', ...feed }]
      await expect(writableCatalog(account, CATALOG, { ...d7, ownFeedIds: [FEED] }), JSON.stringify(feed)).rejects.toThrow(/Nexus adds D7 fields only beside Shopify/)
    }
    const w = (await run('meta-catalogs', { view: 'writer', catalogId: CATALOG })).data
    expect(w).toMatchObject({ writer: 'mixed', shopifyWrites: true, nexusMayWriteItems: false })
    expect(w.evidence.find((e: { from: string }) => e.from === 'feed')).toMatchObject({ kind: 'partner', supplementary: true })
    expect(JSON.stringify(w)).not.toMatch(/\/x\/labels/)
    h.routes[`${CATALOG}/product_feeds`] = []
    h.routes[`${CATALOG}/data_sources`] = [{ id: '140000000000001', name: 'Shopify' }, { id: '140000000000008' }]
    await expect(writableCatalog(account, CATALOG, d7)).rejects.toThrow(/Meta does not say how one source of this catalog writes/)
    expect((await writableCatalog(account, CATALOG, 'settings')).writer.writer).toBe('shopify')
  })
  it('5: items and item fields never on a segment, or where Meta does not say — before any writer read; settings still pass', async () => {
    const account = await metaChosenAccount()
    h.routes[`${CATALOG}/data_sources`] = [{ id: '140000000000001', name: 'Shopify' }]
    for (const isSegment of [true, undefined]) {
      h.routes[CATALOG] = catalogNode(CATALOG, PORTFOLIO, { product_count: 0, is_catalog_segment: isSegment })
      h.calls.length = 0
      await expect(writableCatalog(account, CATALOG, d7)).rejects.toThrow(CATALOG_SEGMENT_ITEMS)
      await expect(writableCatalog(account, CATALOG, { rules: ['custom_label_1'] })).rejects.toThrow(CATALOG_SEGMENT_ITEMS)
      await expect(writableCatalog(account, CATALOG, 'items')).rejects.toThrow(CATALOG_SEGMENT_ITEMS)
      expect(h.calls.some((c) => c.operation.startsWith('catalog.writer'))).toBe(false)
      expect((await writableCatalog(account, CATALOG, 'settings')).writer.writer).toBe('shopify')
    }
  })
  it('3: an error report whose address holds a key in its path, a port or no scheme is its host only (or nothing), and says why', async () => {
    h.routes[`${CATALOG}/product_feeds`] = [{ id: FEED, name: 'Main feed' }]
    for (const [handle, file] of [
      ['https://files.example.com/KEY123/r.csv', 'files.example.com'], ['files.example.com:8443/KEY123/r.csv', 'files.example.com'],
      ['/reports/KEY123/r.csv', null], ['reports\\KEY123\\r.csv', null], ['r.csv', 'r.csv'],
    ] as Array<[string, string | null]>) {
      h.routes[UPLOAD] = { id: UPLOAD, error_report: { report_status: 'WRITE_FINISHED', file_handle: handle } }
      const report = (await run('meta-catalog-feeds', { view: 'upload', catalogId: CATALOG, feedId: FEED, uploadId: UPLOAD })).data.errorReport
      expect(report, handle).toEqual({ status: 'WRITE_FINISHED', file, ...(handle === 'r.csv' ? {} : { fileHidden: NAME_HIDDEN }) })
    }
  })
  it('5 (round 4): a masked name says why; a hidden name never prints as (null) or ""', async () => {
    h.routes[`${CATALOG}/product_feeds`] = [{ id: FEED, name: 'IT/DE', file_name: 'Feed: IT' }, { id: '120000000000711', name: 'Main feed', file_name: 'main.csv' }]
    const feeds = (await run('meta-catalog-feeds', { view: 'list', catalogId: CATALOG })).data
    expect(feeds.items[0]).toMatchObject({ name: null, nameHidden: NAME_HIDDEN, fileName: null, fileNameHidden: NAME_HIDDEN })
    expect(feeds.items[1]).toMatchObject({ name: 'Main feed', fileName: 'main.csv' })
    expect(Object.keys(feeds.items[1])).not.toContain('nameHidden')
    expect(Object.keys(feeds.items[1])).not.toContain('fileNameHidden')
    h.routes[`${CATALOG}/data_sources`] = [{ id: '140000000000001', name: 'Shopify: IT' }]
    expect((await run('meta-catalogs', { view: 'data-sources', catalogId: CATALOG })).data.items[0]).toMatchObject({ name: null, nameHidden: NAME_HIDDEN })
    h.routes[`${CATALOG}/product_feeds`] = [{ id: FEED, name: 'Shopify: IT' }]
    const w = (await run('meta-catalogs', { view: 'writer', catalogId: CATALOG })).data
    expect(w.evidence).toContainEqual(expect.objectContaining({ from: 'feed', kind: 'shopify', name: null, nameHidden: NAME_HIDDEN, detail: 'A feed fetched from Shopify.' }))
    expect(w.evidence).toContainEqual(expect.objectContaining({ from: 'data source', kind: 'shopify', name: null, nameHidden: NAME_HIDDEN, detail: 'Meta names this source with a name that looks like an address (not shown; Shopify).' }))
    expect(JSON.stringify(w)).not.toMatch(/\(null\)|""/)
  })
  it('2 (round 5): an own feed counts only as a plain feed — a Shopify-named one listed in ownFeedIds gets no exemption', async () => {
    const account = await metaChosenAccount()
    h.routes[`${CATALOG}/data_sources`] = [{ id: '140000000000001', name: 'Shopify' }]
    h.routes[`${CATALOG}/product_feeds`] = [{ id: FEED, name: 'Shopify labels', ingestion_source_type: 'supplementary_feed' }]
    await expect(writableCatalog(account, CATALOG, { ...d7, ownFeedIds: [FEED] })).rejects.toThrow(`A supplementary feed or source that is not a plain feed Nexus made (${FEED})`)
    h.routes[`${CATALOG}/product_feeds`] = [{ id: FEED, name: 'Labels', ingestion_source_type: 'supplementary_feed' }]
    expect((await writableCatalog(account, CATALOG, { ...d7, ownFeedIds: [FEED] })).fields).toEqual(['id', 'custom_label_1'])
  })
})

describe('fix round 5 — names shown, names hidden', () => {
  it('3b / 4: a token-like host is hidden as a fetch host, Shopify is still found by it; an upload\'s file name says why it is hidden', async () => {
    const token = 'a1b2c3d4e5f6a7b8c9d0e1f2'
    h.routes[`${CATALOG}/product_feeds`] = [
      { id: FEED, name: 'Main feed', schedule: { interval: 'DAILY', url: `https://${token}.feeds.example.com/x.csv` } },
      { id: '120000000000711', name: 'Second feed', schedule: { interval: 'DAILY', url: 'https://feeds.example.com/x.csv' } },
    ]
    const feeds = (await run('meta-catalog-feeds', { view: 'list', catalogId: CATALOG })).data
    expect(feeds.items.map((f: { schedule: { fetchHost: string | null } }) => f.schedule.fetchHost)).toEqual([null, 'feeds.example.com'])
    expect(JSON.stringify(feeds)).not.toContain(token)
    h.routes[`${CATALOG}/products`] = []
    h.routes[`${CATALOG}/product_feeds`] = [{ id: FEED, name: 'Products', schedule: { url: `https://${token}.myshopify.com/feed.xml` } }]
    const w = (await run('meta-catalogs', { view: 'writer', catalogId: CATALOG })).data
    expect(w).toMatchObject({ writer: 'shopify', shopifyWrites: true })
    expect(JSON.stringify(w)).not.toContain(token)
    // A data source named by such an address (its host spelled encoded): Shopify by its raw decoded host, shown as
    // nothing, with the reason.
    h.routes[`${CATALOG}/product_feeds`] = []
    h.routes[`${CATALOG}/data_sources`] = [{ id: '140000000000006', name: `https://${token}.myshop%69fy.com/feeds/x` }]
    const w2 = (await run('meta-catalogs', { view: 'writer', catalogId: CATALOG })).data
    expect(w2).toMatchObject({ writer: 'shopify', shopifyWrites: true })
    expect(w2.evidence[0]).toMatchObject({ from: 'data source', kind: 'shopify', name: null, nameHidden: NAME_HIDDEN })
    expect(JSON.stringify(w2)).not.toContain(token)
    // A name hidden only for its token-like part says why too.
    h.routes[`${CATALOG}/data_sources`] = [{ id: '140000000000007', name: 'api_key_51HxAbCdEfGhIjKlMnOpQrSt' }]
    expect((await run('meta-catalogs', { view: 'data-sources', catalogId: CATALOG })).data.items[0]).toMatchObject({ name: null, nameHidden: NAME_HIDDEN })
    h.routes[`${CATALOG}/product_feeds`] = [{ id: FEED, name: 'Main feed' }]
    h.routes[UPLOAD] = { id: UPLOAD, filename: 'https://feeds.example.com/KEY123/x.csv' }
    const upload = (await run('meta-catalog-feeds', { view: 'upload', catalogId: CATALOG, feedId: FEED, uploadId: UPLOAD })).data.upload
    expect(upload).toMatchObject({ fileName: 'feeds.example.com', fileNameHidden: NAME_HIDDEN })
    h.routes[UPLOAD] = { id: UPLOAD, filename: 'main.csv' }
    const plain = (await run('meta-catalog-feeds', { view: 'upload', catalogId: CATALOG, feedId: FEED, uploadId: UPLOAD })).data.upload
    expect(plain.fileName).toBe('main.csv')
    expect(Object.keys(plain)).not.toContain('fileNameHidden')
  })
  it('5: a feed with no name shown and no id is "A feed" in readiness, never "Feed null"', async () => {
    h.routes[`${CATALOG}/product_feeds`] = [{ name: 'IT/DE', latest_upload: { error_count: 2, num_deleted_items: 3 } }, { id: FEED, name: 'Main feed', latest_upload: { error_count: 1 } }]
    const warnings: string[] = (await run('meta-catalog-health', { view: 'readiness', catalogId: CATALOG })).data.warnings
    expect(warnings).toContain('A feed: its latest upload had 2 error(s).')
    expect(warnings).toContain('A feed: its latest upload deleted 3 item(s).')
    expect(warnings).toContain('Feed Main feed: its latest upload had 1 error(s).')
    expect(warnings.join(' ')).not.toMatch(/null/)
  })
})

describe('fix round 1 — reads', () => {
  it('A1: a client catalog whose owner Meta does not name is refused, and is its id only in a list', async () => {
    const noOwner = { ...catalogNode(CLIENT_CATALOG, OTHER_PORTFOLIO), business: undefined }
    h.routes[CLIENT_CATALOG] = noOwner
    h.routes[`${PORTFOLIO}/client_product_catalogs`] = [noOwner]
    expect((await run('meta-catalogs', { view: 'catalog', catalogId: CLIENT_CATALOG })).error).toBe(CATALOG_NO_OWNER)
    const list = (await run('meta-catalogs', { view: 'list' })).data
    expect(list.items).toContainEqual({ catalogId: CLIENT_CATALOG, readable: false, why: CATALOG_NO_OWNER })
  })
  it('A5, B1, B4, B5: file names without their address, no create-only feed fields, no guessed time zone, Meta\'s error types, counts, a safe error report', async () => {
    h.routes[`${CATALOG}/product_feeds`] = [{ id: FEED, name: 'Main', file_name: 'https://user:secret@feeds.example.com/x/main.csv?key=abc', schedule: { interval: 'DAILY' } }]
    const feeds = (await run('meta-catalog-feeds', { view: 'list', catalogId: CATALOG })).data
    expect(feeds.items[0]).toMatchObject({ fileName: 'feeds.example.com', schedule: { timeZone: null } })
    expect(JSON.stringify(feeds)).not.toMatch(/secret|key=abc/)
    await run('meta-catalog-feeds', { view: 'feed', catalogId: CATALOG, feedId: FEED })
    expect(h.calls.filter((c) => c.operation === 'feeds.one').map((c) => String(c.query?.fields))).not.toContainEqual(expect.stringMatching(/feed_type|override_value|use_case/))
    expect(() => tool('meta-catalog-items').input.parse({ view: 'list', catalogId: CATALOG, errorType: 'NOT_A_META_ERROR' })).toThrow()
    h.routes[UPLOAD] = { id: UPLOAD, error_report: { report_status: 'WRITE_FINISHED', file_handle: 'https://files.example.com/r.csv?sig=abc' } }
    expect((await run('meta-catalog-feeds', { view: 'upload', catalogId: CATALOG, feedId: FEED, uploadId: UPLOAD })).data.errorReport).toEqual({ status: 'WRITE_FINISHED', file: 'files.example.com', fileHidden: NAME_HIDDEN })
    // Round 3 item 3 — a key in the PATH of the report's address: host only too.
    h.routes[UPLOAD] = { id: UPLOAD, error_report: { report_status: 'WRITE_FINISHED', file_handle: 'https://files.example.com/KEY123/r.csv' } }
    expect((await run('meta-catalog-feeds', { view: 'upload', catalogId: CATALOG, feedId: FEED, uploadId: UPLOAD })).data.errorReport).toEqual({ status: 'WRITE_FINISHED', file: 'files.example.com', fileHidden: NAME_HIDDEN })
    h.routes[`${UPLOAD}/errors`] = [{ id: ERROR_ID, summary: 'Missing price', severity: 'fatal', total_count: 42 }]
    expect((await run('meta-catalog-feeds', { view: 'upload-errors', catalogId: CATALOG, feedId: FEED, uploadId: UPLOAD })).data.items[0].rows).toBe(42)
    h.routes[`${CATALOG}/product_groups`] = [{ id: GROUP, retailer_id: 'GROUP-1' }]
    expect((await run('meta-catalog-items', { view: 'groups', catalogId: CATALOG })).data.total).toBe(1)
    h.calls.length = 0
    await run('meta-catalog-health', { view: 'eligible-accounts', catalogId: CATALOG })
    expect(h.calls.find((c) => c.operation === 'health.eligibleChosen')?.query?.search).toBe('1234567890')
    expect(gatewayProblems()).toEqual([])
  })
})

describe('answers', () => {
  it('item prices are minor units of the item\'s currency under restricted keys; raw price keys never leave', async () => {
    const list = (await run('meta-catalog-items', { view: 'list', catalogId: CATALOG })).data
    expect(list.items[0]).toMatchObject({ sku: 'SKU-1', currency: 'EUR', priceCents: 4990, priceShown: '€49.90', salePriceCents: 3990, salePriceShown: '€39.90' })
    const one = (await run('meta-catalog-items', { view: 'item', itemId: ITEM })).data
    expect(one).toMatchObject({ priceCents: 4990, salePriceCents: 3990, writtenBy: { feedId: null } })
    expect(one.item.price).toBeUndefined()
    expect(one.item.salePrice).toBeUndefined()
    expect(one.review.note).toMatch(/Rejected items do not serve/)
    h.routes[`${ITEM}/override_details`] = [{ key: 'IT', type: 'COUNTRY', values: [{ key: 'price', value: '45.00 EUR' }, { key: 'availability', value: 'in stock' }] }]
    const overrides = (await run('meta-catalog-items', { view: 'overrides', itemId: ITEM })).data
    expect(JSON.stringify(overrides)).not.toMatch(/"value":"45\.00 EUR"/)
    expect(overrides.items[0].values[0]).toEqual({ key: 'price', priceShown: '45.00 EUR' })
  })
  it('feeds: a fetch address is its host only; deletion_enabled and deleted items are said plainly', async () => {
    const feeds = (await run('meta-catalog-feeds', { view: 'list', catalogId: CATALOG })).data
    expect(JSON.stringify(feeds)).not.toMatch(/secret|key=abc|main\.csv\?/)
    expect(feeds.items[0].schedule.fetchHost).toBe('feeds.example.com')
    expect(feeds.items[0].notes[0]).toMatch(/never lets it be turned off/)
    expect(feeds.items[0].latestUpload.note).toMatch(/Items were deleted/)
  })
  it('partners and eligible accounts: another Nexus business\'s portfolio or ad account is its id only', async () => {
    h.taken = [{ product: 'PORTFOLIO', id: OTHER_PORTFOLIO }, { product: 'AD_ACCOUNT', id: '5550001112' }]
    const partners = (await run('meta-catalogs', { view: 'partners', catalogId: CATALOG })).data
    expect(partners.agencies).toEqual([{ businessId: '777000000000001', name: 'Agency A', takenByAnotherBusiness: false }, { businessId: OTHER_PORTFOLIO, takenByAnotherBusiness: true }])
    const eligible = (await run('meta-catalog-health', { view: 'eligible-accounts', catalogId: CATALOG })).data
    expect(eligible.chosenAccountEligible).toBe(true)
    expect(eligible.items).toContainEqual({ adAccountId: '5550001112', takenByAnotherBusiness: true })
    expect(JSON.stringify(eligible)).not.toContain('Shop B ads')
  })
  it('match rate ranks the sources; Meta\'s error 270 says what access is needed; readiness names what blocks and warns', async () => {
    const rate = (await run('meta-catalog-health', { view: 'match-rate', catalogId: CATALOG })).data
    expect(rate.sourcesRanked.map((s: { sourceId: string; matchedShare: number }) => [s.sourceId, s.matchedShare])).toEqual([['120000000000761', 1], [PIXEL, 0.8]])
    const ready = (await run('meta-catalog-health', { view: 'readiness', catalogId: CATALOG })).data
    expect(ready.ready).toBe(true)
    expect(ready.warnings.join(' ')).toMatch(/only 80% of its product ids match/)
    expect(ready.warnings.join(' ')).toMatch(/deleted 2 item/)
    h.routes[`${CATALOG}/event_stats`] = metaError('270', 'This Ads API request is not allowed for apps with development access level')
    expect((await run('meta-catalog-health', { view: 'match-rate', catalogId: CATALOG })).error).toMatch(/full \(Advanced\) Marketing API access/)
    h.routes[`${CATALOG}/external_event_sources`] = []
    h.routes[`${CATALOG}/dpa_eligible_ad_accounts`] = []
    const blocked = (await run('meta-catalog-health', { view: 'readiness', catalogId: CATALOG })).data
    expect(blocked.ready).toBe(false)
    expect(blocked.blockers.join(' ')).toMatch(/No pixel or app is connected/)
    // Round 2 item 6 — Meta's search not finding the chosen account is not known to be a no (until probe CT-900a): a warning.
    expect(blocked.blockers.join(' ')).not.toMatch(/chosen ad account/)
    expect(blocked.chosenAccountEligible).toBeNull()
    expect(blocked.warnings.join(' ')).toMatch(/did not find the chosen one/)
    expect(blocked.notRead.map((p: { part: string }) => p.part)).toEqual(['eventStats'])
  })
  it('categories: Meta\'s list is a file, not an API — no Meta call', async () => {
    expect((await run('meta-catalogs', { view: 'categories' })).data.note).toMatch(/file on facebook\.com/)
    expect(h.calls).toHaveLength(0)
  })
})

describe('pure helpers', () => {
  it('catalogPriceMinor reads Meta\'s price text in the currency\'s minor units, or null', () => {
    const cases: Array<[string, string, number | null]> = [
      ['€49.90', 'EUR', 4990], ['49,90 €', 'EUR', 4990], ['49.90 EUR', 'EUR', 4990], ['$1,234.56', 'USD', 123456], ['1.234,56 €', 'EUR', 123456],
      ['1 234,56 €', 'EUR', 123456], ['¥1,234', 'JPY', 1234], ['1,234 USD', 'USD', 123400], ['49.9 EUR', 'EUR', 4990], ['BHD 1.234', 'BHD', 1234],
      ['€0.995', 'EUR', 100], ['12.345.678 EUR', 'EUR', 1234567800], ['free', 'EUR', null], ['1.2.3,4', 'EUR', null],
    ]
    for (const [shown, currency, minor] of cases) expect(catalogPriceMinor(shown, currency), shown).toBe(minor)
    expect(catalogPriceMinor('€49.90', null)).toBeNull()
  })
  it('itemFilter builds Meta\'s rule from typed args only', () => {
    expect(itemFilter({})).toBeNull()
    expect(itemFilter({ skus: ['A', 'A', 'B'] })).toEqual({ retailer_id: { is_any: ['A', 'B'] } })
  })
  it('moneySafe moves every price key (not a date) under a restricted key', () => {
    expect(moneySafe({ price: '1 EUR', nested: [{ sale_price: '2 EUR', unit_price: { value: 3 }, live_special_price: '4 EUR', sale_price_start_date: '2026-11-01' }], title: 'x' }))
      .toEqual({ priceShown: '1 EUR', nested: [{ salePriceShown: '2 EUR', otherPriceShown: { unit_price: { value: 3 }, live_special_price: '4 EUR' }, sale_price_start_date: '2026-11-01' }], title: 'x' })
    expect(moneySafe([{ key: 'base_price', value: '5 EUR' }])).toEqual([{ key: 'base_price', otherPriceShown: { base_price: '5 EUR' } }])
  })
  it('nameOrHost keeps a plain name, and of anything address-like only its host (round 2 item 3)', () => {
    expect(nameOrHost('Main feed')).toBe('Main feed')
    expect(nameOrHost('main.csv')).toBe('main.csv')
    for (const [address, host] of [
      ['https://user:pw@feeds.example.com/a/b/main.csv?key=1#x', 'feeds.example.com'], ['ftp://user@host.example.com/feed.tsv', 'host.example.com'],
      ['https://host.example.com/export/9f2c4e1a7b3d5f60', 'host.example.com'], ['https://host.example.com/a1b2c3d4e5f6.xml', 'host.example.com'],
      ['feeds.x.com/k/SECRET/p.csv', 'feeds.x.com'], ['https://feeds.x.com/p.csv;key=X', 'feeds.x.com'], ['https://feeds.x.com/p?a=1&token=X', 'feeds.x.com'],
      ['main.csv;key=X', 'main.csv'], ['feed&token=X', null], ['user@feeds.x.com', 'feeds.x.com'],
      // Round 3 item 3 — a port, an IP, a single-label host, a relative or absolute path, IPv6, backslash paths.
      ['feeds.example.com:8080/KEY/x.csv', 'feeds.example.com'], ['10.0.0.1:8080/KEY/x.csv', '10.0.0.1'], ['localhost/feeds/KEY/x.csv', null],
      ['feeds/KEY/x.csv', null], ['/feeds/KEY/x.csv', null], ['[::1]/KEY/x.csv', null], ['C:\\feeds\\KEY\\x.csv', null], ['\\\\server\\share\\KEY.csv', null],
    ] as Array<[string, string | null]>) expect(nameOrHost(address), address).toBe(host)
  })
  it('nameOrHost (round 4 item 2): percent-encoded, fullwidth and look-alike separators are address-like; plain names stay', () => {
    for (const name of ['Main feed', 'Feed (IT) - summer', "Rider's jackets", 'Giacche più calde', 'main.csv', 'Shop A + B!']) expect(nameOrHost(name), name).toBe(name)
    expect(nameOrHost('Ｍａｉｎ ｆｅｅｄ')).toBe('Main feed')
    for (const [address, host] of [
      ['export%3Ftoken%3DSECRET', null], ['https%3A%2F%2Ffeeds.example.com%2FKEY%2Fx.csv', 'feeds.example.com'], ['feeds.example.com%5CKEY%5Cx.csv', 'feeds.example.com'],
      ['https%253A%252F%252Ffeeds.example.com%252FKEY', 'feeds.example.com'], ['feeds.example.com%E0%A4%A', null], ['KEY%2Fx.csv', null],
      ['feeds.example.com／KEY／x.csv', 'feeds.example.com'], ['feeds.example.com：8080／KEY', 'feeds.example.com'], ['C：＼feeds＼KEY', null], ['export／SECRET', null],
      ['feeds.example.com∕KEY∕x.csv', 'feeds.example.com'], ['feeds.example.com⁄KEY', 'feeds.example.com'], ['feeds.example.com⧸KEY', 'feeds.example.com'],
      ['export∕SECRET', null], ['export⁄SECRET', null], ['export⧸SECRET', null], ['IT/DE', null], ['Feed: IT', null], ['Shopify: IT', null],
    ] as Array<[string, string | null]>) expect(nameOrHost(address), address).toBe(host)
  })
  it('nameOrHost (round 5 item 3): typographic names show; a name or host holding a token-like part is hidden', () => {
    for (const name of [
      'Rider’s jackets', 'Main feed – IT', 'Feed #2', 'Shop & Co', 'Feed [IT]', 'Feed | DE', 'Giacche · Inverno', '“Best” sellers — EU', '• Labels ‘A’',
      'Supercalifragilisticexpialidocious feed', 'Feed 2026 summer', 'SKU-12345-ABCDE', 'Main feed', 'main.csv', 'feeds.example.com',
    ]) expect(nameOrHost(name), name).toBe(name)
    for (const [value, shown] of [
      ['api_key_51HxAbCdEfGhIjKlMnOpQrSt', null], ['eyJ0ZXN0IjoidGVzdDEyMyJ9.eyJleGFtcGxlIjoxMjN9.c2lnbmF0dXJlMTIz', null],
      ['1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789aBcDeFg', null], ['a3f9c2e17b4d5f6081a2b3c4d5e6f708.csv', null], ['Labels a3f9c2e17b4d5f6081a2b3c4d5e6f708', null],
      ['https://a1b2c3d4e5f6a7b8c9d0e1f2.feeds.example.com/x.csv', null], ['a1b2c3d4e5f6a7b8c9d0e1f2.feeds.example.com/x.csv', null],
      ['https://feeds.example.com/a1b2c3d4e5f6a7b8c9d0e1f2/x.csv', 'feeds.example.com'],
    ] as Array<[string, string | null]>) expect(nameOrHost(value), value).toBe(shown)
  })
})
