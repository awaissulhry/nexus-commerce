/**
 * Meta step 35 — the item, feed and Instagram tag tools as the approval gate uses them (Meta, the account and the live reads
 * are stand-ins): the change contract; D7 in every draft (step 12's checks with the right purpose, at the preview AND at the
 * run); the rows answered in words; a price only for a person who may see revenue; Meta never asked to check; a run only as
 * a request a person approved; what each record keeps and what its undo asks for (each undo parses as its tool's arguments).
 * Made-up ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  account: { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' } as Record<string, unknown>,
  chosen: { connectionId: 'm-1', adAccountId: '1234567890', currency: 'EUR', businessId: '120000000000090', pageId: null, instagramId: '170000000000000', connection: { connectionId: 'm-1', appId: '1234567' } } as Record<string, unknown>,
  refuse: null as string | null,
  checks: [] as Array<[string, string, unknown]>,
  items: new Map<string, Record<string, unknown>>(),
  overrides: new Map<string, Record<string, unknown>>(),
  feeds: new Map<string, Record<string, unknown>>(),
  own: [] as string[],
  kinds: new Map<string, string>(),
  primaries: new Set<string>(['120000000000130']),
  rules: [] as Array<Record<string, unknown>>,
  group: null as Record<string, unknown> | null,
  records: new Map<string, Record<string, unknown>>(),
  users: [] as Array<Record<string, unknown>>,
  unseen: [] as string[],
  igPost: null as Record<string, unknown> | null,
  igMay: true as boolean | null,
  igCatalogs: new Set<string>(['120000000000100']),
  igProducts: new Map<string, Record<string, unknown>>(),
  igAppeal: { eligible: true, reviewStatus: 'rejected' } as Record<string, unknown>,
  check: vi.fn(),
  send: vi.fn(),
  batch: vi.fn(),
}))
vi.mock('../../../db.js', () => ({
  default: {
    agentChange: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; toolName: string } }) => { const r = h.records.get(where.id); return r && r.toolName === where.toolName ? r : null }),
      findMany: vi.fn(async () => []),
    },
  },
}))
vi.mock('../../marketing/meta-ads/change-account.js', () => ({ metaChangeAccount: vi.fn(async () => h.account) }))
vi.mock('../../marketing/meta-ads/live.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live.js')>()),
  metaChosenAccount: vi.fn(async () => h.chosen),
}))
const catalogRow = (id: string) => ({ catalogId: id, portfolioId: '120000000000090', relation: 'owned', ownerBusinessId: '120000000000090', name: 'Catalog A', vertical: 'commerce', productCount: 3, isSegment: false })
vi.mock('../../marketing/meta-ads/live-catalog-items.js', async (importActual) => {
  const actual = await importActual<typeof import('../../marketing/meta-ads/live-catalog-items.js')>()
  const { MetaLiveRefusal } = await import('../../marketing/meta-ads/live.js')
  const check = (kind: string) => vi.fn(async (_a: unknown, catalogId: string, use?: unknown) => {
    h.checks.push([kind, catalogId, use])
    if (h.refuse) throw new MetaLiveRefusal(h.refuse)
    return { catalog: catalogRow(catalogId), writer: {}, fields: Array.isArray(use) ? use : [] }
  })
  return {
    ...actual,
    ownCatalogFeedIds: vi.fn(async () => h.own),
    ownCatalogFeeds: vi.fn(async () => new Map(h.own.map((id) => [id, h.kinds.get(id) ?? (id === '120000000000131' ? 'supplementary' : 'products')]))),
    itemsWriteCheck: check('items'),
    feedWriteCheck: check('feed'),
    d7WriteCheck: check('d7-upload'),
    d7RulesCheck: check('d7-rules'),
    liveItemsNow: vi.fn(async (_a: unknown, _c: string, skus: string[]) => new Map(skus.filter((s) => h.items.has(s)).map((s) => [s, { itemId: `id-${s}`, sku: s, state: h.items.get(s)!, currency: 'EUR', name: `Item ${s}` }]))),
    liveLabelsNow: vi.fn(async (_a: unknown, _c: string, skus: string[]) => new Map(skus.filter((s) => h.items.has(s)).map((s) => [s, { itemId: `id-${s}`, sku: s, state: h.items.get(s)!, currency: 'EUR', name: `Item ${s}` }]))),
    liveItemOverrides: vi.fn(async (_a: unknown, itemId: string, type: string) => new Map(Object.entries((h.overrides.get(`${itemId}|${type}`) ?? {}) as Record<string, Record<string, unknown>>))),
    liveGroup: vi.fn(async () => { if (!h.group) throw new MetaLiveRefusal('That id is not an item group.'); return h.group }),
    liveFeedNow: vi.fn(async (_a: unknown, _c: string, feedId: string) => { const f = h.feeds.get(feedId); if (!f) throw new MetaLiveRefusal('That feed is not one of this catalog\'s feeds.'); return f }),
    livePrimarySources: vi.fn(async () => ({ ids: h.primaries, more: false })),
    liveFeedRules: vi.fn(async () => ({ rules: h.rules, more: false })),
    liveFeedUpload: vi.fn(async (_a: unknown, catalogId: string, _f: string, uploadId: string) => ({ uploadId, catalogId })),
  }
})
vi.mock('../../marketing/meta-ads/live-catalog-admin.js', async (importActual) => {
  const actual = await importActual<typeof import('../../marketing/meta-ads/live-catalog-admin.js')>()
  return {
    ...actual,
    writableFor: vi.fn(async (_a: unknown, id: string, purpose: unknown) => { h.checks.push([`writable-${String(purpose)}`, id, undefined]); return { catalog: catalogRow(id), writer: {} } }),
    liveCatalogSets: vi.fn(async () => ({ sets: [], more: false })),
    liveCatalogUsers: vi.fn(async () => ({ users: h.users, unseen: h.unseen })),
  }
})
vi.mock('../../marketing/meta-ads/live-instagram-tags.js', async (importActual) => {
  const actual = await importActual<typeof import('../../marketing/meta-ads/live-instagram-tags.js')>()
  const { MetaLiveRefusal } = await import('../../marketing/meta-ads/live.js')
  return {
    ...actual,
    liveIgMayTag: vi.fn(async () => h.igMay),
    liveIgTagPost: vi.fn(async () => { if (!h.igPost) throw new MetaLiveRefusal('That Instagram media is not the chosen Instagram account\'s, so it is not read.'); return h.igPost }),
    liveIgTagCatalogs: vi.fn(async () => h.igCatalogs),
    liveIgProduct: vi.fn(async (_a: unknown, id: string) => { const p = h.igProducts.get(id); if (!p) throw new MetaLiveRefusal('That id is not a catalog item.'); return p }),
    liveIgAppealState: vi.fn(async () => h.igAppeal),
    taggedPostsLastDay: vi.fn(async () => 2),
  }
})
vi.mock('../../marketing/meta-ads/live-catalog.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live-catalog.js')>()),
  liveCatalogItems: h.batch,
}))
vi.mock('../../marketing/meta-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/write-client.js')>()),
  metaCheckChange: h.check,
  metaSendChange: h.send,
}))

import { FEED_LINKS_NOT_BUILT, FEED_NOT_UPDATABLE, GROUP_CREATE_NOT_BUILT, META_ADS_CATALOG_ITEMS_TOOLS, NEW_POST_TAGS, QUANTITY_NOT_SENT, SINGLE_ITEM_CALLS, TAG_REMOVE_NOT_AVAILABLE, __catalogItemsTest } from './meta-ads-catalog-items.tools.js'
import { META_ADS_CATALOG_ADMIN_TOOLS } from './meta-ads-catalog-admin.tools.js'
import { META_CHANGE_RULES } from './meta-ads-kit.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { __metaObjectLimitsTest } from '../../gateway/meta-object-limits.js'
import type { AgentTool, ToolChange, ToolContext, ToolResult } from '../tool-types.js'
import { taggedPostsLastDay } from '../../marketing/meta-ads/live-instagram-tags.js'

const ALL: AgentTool[] = [...META_ADS_CATALOG_ITEMS_TOOLS, ...META_ADS_CATALOG_ADMIN_TOOLS]
const tool = (name: string) => ALL.find((t) => t.name === name)!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const noRevenue: ToolContext = { can: (p) => !String(p).startsWith('financials.'), via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })
const parse = (name: string, args: Record<string, unknown>) => tool(name).input.parse(args) as Record<string, unknown>
const preview = async (name: string, args: Record<string, unknown>, ctx = asker) => (await tool(name).handler(parse(name, args), ctx)) as ToolResult & { preview: Record<string, any>; error?: string }
const run = async (name: string, args: Record<string, unknown>) => {
  const p = await preview(name, args)
  expect(p.ok, p.error).toBe(true)
  return (await tool(name).execute!(parse(name, args), approved(p.preview))) as ToolResult & { data: Record<string, any>; change: { before: any; after: any } }
}
/** An undo's request parses as its tool's own arguments (the tool-contract test's rule, here for every record kind). */
const undoParses = (name: string, change: { before: unknown; after: unknown; id?: string }) => {
  const request = tool(name).undo!.request(change)
  if ('refusal' in request) return request
  expect(tool(request.tool).input.safeParse(request.args).success, JSON.stringify(request.args)).toBe(true)
  return request
}

const CATALOG = '120000000000100'
const FEED = '120000000000130'
const SUPP = '120000000000131'
const feedRow = (id: string, more: Record<string, unknown> = {}) => ({ feedId: id, name: 'Feed A', supplementary: false, overrideType: null, deletionEnabled: false, defaultCurrency: 'EUR', delimiter: 'COMMA', encoding: 'UTF8', quotedFieldsMode: 'autodetect', productCount: 3, schedule: null, updateSchedule: null, ...more })
const batchNode = (refused: string[] = []) => ({ node: { handles: ['AcxH1'], validation_status: refused.map((sku) => ({ retailer_id: sku, errors: [{ message: 'Invalid price' }] })) }, readBack: 'none', waitedMs: 0 })
const fullItem = (retailerId: string) => ({ retailerId, title: 'Jacket A', description: 'A jacket.', availability: 'in stock', condition: 'new', price: { amountMinor: 4990, currency: 'EUR' }, link: 'https://shop.example.com/a', images: [{ url: 'https://shop.example.com/a.jpg' }], brand: 'Shop A' })

beforeEach(() => {
  __metaObjectLimitsTest.useMemory()
  vi.unstubAllEnvs()
  vi.stubEnv('NEXUS_META_ADS_WRITES', 'on')
  h.check.mockReset(); h.send.mockReset(); h.batch.mockReset()
  h.send.mockImplementation(async () => ({ node: { success: true }, readBack: 'none', waitedMs: 0 }))
  h.batch.mockResolvedValue({ items: [{ status: 'finished', errorsTotal: 0 }] })
  h.refuse = null; h.checks = []
  h.items = new Map([['SKU-A', { availability: 'out of stock', price: '49.90 EUR', title: 'Jacket A', internal_label: ['summer'], custom_label_0: null, custom_number_0: null }]])
  h.overrides = new Map(); h.feeds = new Map([[FEED, feedRow(FEED)], [SUPP, feedRow(SUPP, { name: 'Nexus labels', supplementary: true })]])
  h.own = []; h.kinds = new Map(); h.primaries = new Set([FEED]); h.rules = []; h.group = null; h.records = new Map(); h.users = []; h.unseen = []
  h.igPost = { mediaId: '170000000000001', targetId: '170000000000001', target: 'image', tagsNow: new Map([['120000000000120', { x: 0.2, y: 0.3 }]]), otherSlidesTagged: 0, slidesNotRead: [] }
  h.igMay = true; h.igCatalogs = new Set([CATALOG]); h.igAppeal = { eligible: true, reviewStatus: 'rejected' }
  h.igProducts = new Map([['120000000000120', { productId: '120000000000120', catalogId: CATALOG, sku: 'SKU-A', name: 'Jacket A', reviewStatus: 'approved' }], ['120000000000121', { productId: '120000000000121', catalogId: CATALOG, sku: 'SKU-B', name: 'Jacket B', reviewStatus: 'approved' }]])
})

describe('the change contract', () => {
  it('every tool: alwaysAsk at ask, high risk, open world, ads.campaigns.manage, the Meta rules line, material fields, an undo', () => {
    expect(META_ADS_CATALOG_ITEMS_TOOLS.map((t) => t.name)).toEqual(['set-meta-catalog-items', 'set-meta-catalog-feed', 'set-meta-instagram-product-tags'])
    for (const t of META_ADS_CATALOG_ITEMS_TOOLS) {
      expect(t, t.name).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', riskTier: 'high', requiresApprovalDefault: true, openWorld: true, readOnly: false, category: 'advertising', requires: ['ads.campaigns.manage'], reversibility: 'partial' })
      expect(t.description.endsWith(META_CHANGE_RULES), t.name).toBe(true)
      expect(MATERIAL_PREVIEW_FIELDS[t.name], t.name).toEqual(['basis', 'plan', 'reach'])
      expect(t.title.length, t.name).toBeLessThanOrEqual(40)
      expect(t.undo, t.name).toBeDefined()
    }
    expect(tool('set-meta-catalog-items').consequencesFor!({ action: 'group-default' })).toEqual({ reversibility: 'none' })
    expect(tool('set-meta-catalog-items').consequencesFor!({ action: 'remove-made' })).toEqual({ reversibility: 'none' })
    expect(tool('set-meta-catalog-items').consequencesFor!({ action: 'update' })).toBeNull()
    for (const action of ['upload', 'upload-schedule', 'error-report', 'remove-made']) expect(tool('set-meta-catalog-feed').consequencesFor!({ action }), action).toEqual({ reversibility: 'none' })
    expect(tool('set-meta-catalog-feed').consequencesFor!({ action: 'change', deletionEnabledOn: true })).toEqual({ reversibility: 'none' })
    expect(tool('set-meta-instagram-product-tags').consequencesFor!({ action: 'appeal' })).toEqual({ reversibility: 'none' })
  })
  it('the rows Nexus does not send are answered in words, before any read or call', async () => {
    expect(await preview('set-meta-catalog-items', { action: 'update', catalogId: CATALOG, quantityToSellOnFacebook: 5 })).toEqual({ ok: false, error: QUANTITY_NOT_SENT })
    expect(await preview('set-meta-catalog-items', { action: 'update', catalogId: CATALOG, singleItem: true })).toEqual({ ok: false, error: SINGLE_ITEM_CALLS })
    expect(await preview('set-meta-catalog-items', { action: 'update', catalogId: CATALOG, createGroup: true })).toEqual({ ok: false, error: GROUP_CREATE_NOT_BUILT })
    expect(await preview('set-meta-catalog-feed', { action: 'create', catalogId: CATALOG, linkPrimaryFeeds: [FEED] })).toEqual({ ok: false, error: FEED_LINKS_NOT_BUILT })
    expect(await preview('set-meta-catalog-feed', { action: 'change', catalogId: CATALOG, feedId: FEED, country: 'IT' })).toEqual({ ok: false, error: FEED_NOT_UPDATABLE })
    expect(await preview('set-meta-instagram-product-tags', { action: 'new-post' })).toEqual({ ok: false, error: NEW_POST_TAGS })
    expect(await preview('set-meta-instagram-product-tags', { action: 'remove' })).toEqual({ ok: false, error: TAG_REMOVE_NOT_AVAILABLE })
    expect(TAG_REMOVE_NOT_AVAILABLE).toMatch(/Tagging media is additive/)
    expect(h.checks).toEqual([])
    expect(h.send).not.toHaveBeenCalled()
  })
  it('arrays are bounded; a photo tag takes x / y from 0 to 1; a label never takes a quote or a comma', () => {
    expect(() => parse('set-meta-catalog-items', { action: 'update', catalogId: CATALOG, items: Array.from({ length: 251 }, (_, i) => ({ retailerId: `S${i}`, size: 'M' })) })).toThrow()
    expect(() => parse('set-meta-instagram-product-tags', { action: 'tag', mediaId: '170000000000001', tags: [{ productId: '120000000000120', x: 1.5, y: 0.5 }] })).toThrow()
    expect(() => parse('set-meta-catalog-feed', { action: 'labels', catalogId: CATALOG, feedId: FEED, labelItems: [{ retailerId: 'SKU-A', internalLabels: ['a,b'] }] })).toThrow()
    expect(() => parse('set-meta-catalog-feed', { action: 'create', catalogId: CATALOG, kind: 'products', name: 'F', schedule: { interval: 'DAILY', url: 'https://feeds.example.com/a.csv?key=1' } })).toThrow()
  })
})

describe('set-meta-catalog-items', () => {
  it('D7: on a catalog Shopify writes, an item change is refused in step 12\'s words before any write; the check runs at preview and run', async () => {
    h.refuse = 'Shopify owns these items: remove them in Shopify. Shopify writes its items; Nexus must not write items here (D7).'
    expect(await preview('set-meta-catalog-items', { action: 'update', catalogId: CATALOG, items: [{ retailerId: 'SKU-A', availability: 'in stock' }] })).toEqual({ ok: false, error: expect.stringMatching(/^Shopify owns these items/) })
    h.refuse = null
    h.send.mockResolvedValueOnce(batchNode())
    const ran = await run('set-meta-catalog-items', { action: 'update', catalogId: CATALOG, items: [{ retailerId: 'SKU-A', availability: 'in stock' }] })
    expect(ran.ok).toBe(true)
    expect(h.checks.filter((c) => c[0] === 'items')).toHaveLength(3)
    expect(h.check).not.toHaveBeenCalled()
  })
  it('update: one items_batch with allow_upsert false; the record keeps old values; undo sends them back through the same tool', async () => {
    h.send.mockResolvedValueOnce(batchNode())
    const ran = await run('set-meta-catalog-items', { action: 'update', catalogId: CATALOG, items: [{ retailerId: 'SKU-A', availability: 'in stock', price: { amountMinor: 4490, currency: 'EUR' } }] })
    const sent = h.send.mock.calls[0][1]
    expect(sent).toMatchObject({ objectId: CATALOG, kind: 'catalogitems', edge: 'items_batch', operation: 'catalog.items.write', params: { item_type: 'PRODUCT_ITEM', allow_upsert: 'false' } })
    expect(JSON.parse(sent.params.requests)).toEqual([{ method: 'UPDATE', data: { id: 'SKU-A', availability: 'in stock', price: '44.90 EUR' } }])
    expect(ran.change.before).toMatchObject({ op: 'update', items: [{ sku: 'SKU-A', fields: { availability: 'out of stock', price: '49.90 EUR' } }], accountId: 'm-1', adAccountId: '1234567890' })
    expect(ran.data).toMatchObject({ batch: { handle: 'AcxH1', refusedByMeta: [] }, nexusRead: expect.stringMatching(/batch AcxH1: finished/) })
    const undo = undoParses('set-meta-catalog-items', ran.change)
    expect(undo).toEqual({ tool: 'set-meta-catalog-items', args: { connectionId: 'm-1', why: expect.any(String), action: 'update', catalogId: CATALOG, items: [{ retailerId: 'SKU-A', availability: 'out of stock', price: { amountMinor: 4990, currency: 'EUR' } }] } })
  })
  it('an item Meta refused in the batch is no change: neither recorded nor undone', async () => {
    h.items.set('SKU-B', { availability: 'out of stock' })
    h.send.mockResolvedValueOnce(batchNode(['SKU-B']))
    const ran = await run('set-meta-catalog-items', { action: 'update', catalogId: CATALOG, items: [{ retailerId: 'SKU-A', availability: 'in stock' }, { retailerId: 'SKU-B', availability: 'in stock' }] })
    expect(ran.change.after.items.map((i: { sku: string }) => i.sku)).toEqual(['SKU-A'])
    expect(ran.data.batch.refusedByMeta).toEqual([{ sku: 'SKU-B', errors: ['Invalid price'] }])
  })
  it('a price is shown with today\'s prices: only for a person who may see revenue', async () => {
    expect(await preview('set-meta-catalog-items', { action: 'update', catalogId: CATALOG, items: [{ retailerId: 'SKU-A', price: { amountMinor: 4490, currency: 'EUR' } }] }, noRevenue)).toEqual({ ok: false, error: expect.stringMatching(/only a person who may see revenue/) })
    expect((await preview('set-meta-catalog-items', { action: 'update', catalogId: CATALOG, items: [{ retailerId: 'SKU-A', availability: 'in stock' }] }, noRevenue)).ok).toBe(true)
  })
  it('back in stock while a catalog ad delivers is SPENDS MONEY; the spend premise is in what the run stands on', async () => {
    h.users = [{ kind: 'adset', id: '120000000000210', name: 'Ad set A', effectiveStatus: 'ACTIVE', uses: 'catalog 120000000000100' }]
    const p = await preview('set-meta-catalog-items', { action: 'update', catalogId: CATALOG, items: [{ retailerId: 'SKU-A', availability: 'in stock' }] })
    expect(p.preview).toMatchObject({ spendsMoney: true, spendsMoneyBecause: [expect.stringMatching(/SKU-A \(availability\) can show in its catalog ads again/)] })
    // Approved while that ad set delivered; it stopped before the run: the premise moved, nothing is sent.
    h.users = []
    const ran = await tool('set-meta-catalog-items').execute!(parse('set-meta-catalog-items', { action: 'update', catalogId: CATALOG, items: [{ retailerId: 'SKU-A', availability: 'in stock' }] }), approved(p.preview)) as ToolResult & { error?: string }
    expect(ran).toMatchObject({ ok: false, error: expect.stringMatching(/changed since this was approved/) })
    expect(h.send).not.toHaveBeenCalled()
  })
  it('create: Meta\'s required fields; never an item that exists; the undo (remove-made) deletes only the items the record names', async () => {
    expect(await preview('set-meta-catalog-items', { action: 'create', catalogId: CATALOG, items: [{ retailerId: 'SKU-N', title: 'A' }] })).toEqual({ ok: false, error: expect.stringMatching(/needs description, availability, condition, price, link, image, brand/) })
    h.send.mockResolvedValueOnce(batchNode())
    const ran = await run('set-meta-catalog-items', { action: 'create', catalogId: CATALOG, items: [fullItem('SKU-N'), fullItem('SKU-A')], itemSubType: 'CLOTHING' })
    expect(JSON.parse(h.send.mock.calls[0][1].params.requests)).toEqual([{ method: 'CREATE', data: expect.objectContaining({ id: 'SKU-N', price: '49.90 EUR', image: [{ url: 'https://shop.example.com/a.jpg' }] }) }])
    expect(h.send.mock.calls[0][1].params).toMatchObject({ item_sub_type: 'CLOTHING', allow_upsert: 'false' })
    expect(ran.change.after).toMatchObject({ op: 'create', skus: ['SKU-N'] })
    expect(undoParses('set-meta-catalog-items', { ...ran.change, id: 'chg-1' })).toEqual({ tool: 'set-meta-catalog-items', args: { connectionId: 'm-1', why: expect.any(String), action: 'remove-made', undoOf: 'chg-1' } })
    h.records.set('chg-1', { toolName: 'set-meta-catalog-items', before: {}, after: { op: 'create', catalogId: CATALOG, skus: ['SKU-N'], adAccountId: '1234567890' }, undoneAt: null })
    h.items.set('SKU-N', { availability: 'in stock' })
    const p = await preview('set-meta-catalog-items', { action: 'remove-made', undoOf: 'chg-1' })
    expect(p.preview.requests).toEqual([{ step: 1, label: expect.stringMatching(/Delete 1 item from catalog/), metaCheck: 'no-check' }])
    expect(await preview('set-meta-catalog-items', { action: 'remove-made', undoOf: 'chg-1', catalogId: CATALOG })).toEqual({ ok: false, error: expect.stringMatching(/takes undoOf/) })
  })
  it('overrides: a country price, a language title; undo puts the old override back or removes a new one', async () => {
    h.overrides.set('id-SKU-A|COUNTRY', { IT: { price: '49.90 EUR' } })
    h.send.mockResolvedValueOnce(batchNode())
    const ran = await run('set-meta-catalog-items', { action: 'overrides', catalogId: CATALOG, overrides: [{ retailerId: 'SKU-A', type: 'COUNTRY', value: 'IT', price: { amountMinor: 4490, currency: 'EUR' } }] })
    expect(JSON.parse(h.send.mock.calls[0][1].params.requests)).toEqual([{ method: 'UPDATE', data: { id: 'SKU-A', price: '44.90 EUR' }, localization: { type: 'COUNTRY', value: 'IT' } }])
    expect(undoParses('set-meta-catalog-items', ran.change)).toMatchObject({ tool: 'set-meta-catalog-items', args: { action: 'overrides', overrides: [{ retailerId: 'SKU-A', type: 'COUNTRY', value: 'IT', price: { amountMinor: 4990, currency: 'EUR' } }] } })
    expect(await preview('set-meta-catalog-items', { action: 'overrides', catalogId: CATALOG, overrides: [{ retailerId: 'SKU-A', type: 'LANGUAGE', value: 'it_IT', price: { amountMinor: 1, currency: 'EUR' } }] })).toEqual({ ok: false, error: expect.stringMatching(/price, sale price and availability only by country/) })
    h.send.mockResolvedValueOnce(batchNode())
    const fresh = await run('set-meta-catalog-items', { action: 'overrides', catalogId: CATALOG, overrides: [{ retailerId: 'SKU-A', type: 'LANGUAGE', value: 'it_IT', title: 'Giacca A' }] })
    expect(undoParses('set-meta-catalog-items', fresh.change)).toMatchObject({ args: { action: 'remove-overrides', remove: [{ retailerId: 'SKU-A', type: 'LANGUAGE', value: 'it_IT' }] } })
  })
  it('group-default: only one of the group\'s own items; no undo (Meta lets no one read the old default)', async () => {
    h.group = { groupId: '120000000000115', catalogId: CATALOG, groupSku: 'GROUP-A', itemIds: new Set(['120000000000120']), more: false }
    expect(await preview('set-meta-catalog-items', { action: 'group-default', groupId: '120000000000115', defaultItemId: '120000000000199' })).toEqual({ ok: false, error: expect.stringMatching(/not an item of group/) })
    const ran = await run('set-meta-catalog-items', { action: 'group-default', groupId: '120000000000115', defaultItemId: '120000000000120' })
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: '120000000000115', kind: 'productgroup', params: { default_product_id: '120000000000120' } })
    expect(tool('set-meta-catalog-items').undo!.request(ran.change)).toEqual({ refusal: expect.stringMatching(/read no group's default item/) })
    // The refused preview, then the run's preview and its build again: the items check each time.
    expect(h.checks.filter((c) => c[0] === 'items')).toHaveLength(3)
  })
})

describe('set-meta-catalog-feed', () => {
  it('labels via the Shopify feed: D7\'s upload check with exactly the file\'s columns; an update-only CSV; undo puts the old labels back', async () => {
    const ran = await run('set-meta-catalog-feed', { action: 'labels', catalogId: CATALOG, feedId: FEED, via: 'shopify-feed', labelItems: [{ retailerId: 'SKU-A', internalLabels: ['summer', 'sale'], customLabel0: 'Sale' }] })
    // At the preview and again when the approved change runs.
    expect(h.checks.filter((c) => c[0] === 'd7-upload')).toEqual([['d7-upload', CATALOG, ['id', 'internal_label', 'custom_label_0']], ['d7-upload', CATALOG, ['id', 'internal_label', 'custom_label_0']]])
    const sent = h.send.mock.calls[0][1]
    expect(sent).toMatchObject({ objectId: FEED, kind: 'catalogfeed', edge: 'uploads', parent: { kind: 'catalog', id: CATALOG }, params: { file_part_name: 'nexus-labels.csv', update_only: 'true' } })
    expect(sent.params.file).toBe('"id","internal_label","custom_label_0"\n"SKU-A","[\'summer\',\'sale\']","Sale"')
    expect(ran.change.after).toMatchObject({ op: 'labels', via: 'shopify-feed' })
    expect(undoParses('set-meta-catalog-feed', ran.change)).toEqual({ tool: 'set-meta-catalog-feed', args: { connectionId: 'm-1', why: expect.any(String), catalogId: CATALOG, action: 'labels', feedId: FEED, via: 'shopify-feed', labelItems: [{ retailerId: 'SKU-A', internalLabels: ['summer'], customLabel0: '' }] } })
  })
  it('labels: never into a supplementary feed Nexus did not make; own-feed needs Nexus\'s own supplementary feed', async () => {
    expect(await preview('set-meta-catalog-feed', { action: 'labels', catalogId: CATALOG, feedId: SUPP, via: 'shopify-feed', labelItems: [{ retailerId: 'SKU-A', customLabel0: 'Sale' }] })).toEqual({ ok: false, error: expect.stringMatching(/not a primary feed/) })
    expect(await preview('set-meta-catalog-feed', { action: 'labels', catalogId: CATALOG, feedId: SUPP, via: 'own-feed', labelItems: [{ retailerId: 'SKU-A', customLabel0: 'Sale' }] })).toEqual({ ok: false, error: expect.stringMatching(/not Nexus's own supplementary feed/) })
    h.own = [SUPP]
    expect((await preview('set-meta-catalog-feed', { action: 'labels', catalogId: CATALOG, feedId: SUPP, via: 'own-feed', labelItems: [{ retailerId: 'SKU-A', customLabel0: 'Sale' }] })).ok).toBe(true)
  })
  it('create: a supplementary feed under D7 on this catalog\'s primary sources; a feed of items under the feed check, deletion always said', async () => {
    expect(await preview('set-meta-catalog-feed', { action: 'create', catalogId: CATALOG, kind: 'supplementary', name: 'Nexus labels', primaryFeedIds: ['120000000000139'] })).toEqual({ ok: false, error: expect.stringMatching(/not a primary data source of this catalog/) })
    h.send.mockResolvedValueOnce({ node: { id: SUPP, name: 'Nexus labels', ingestion_source_type: 'supplementary_feed' }, readBack: 'same-request', waitedMs: 0 })
    const ran = await run('set-meta-catalog-feed', { action: 'create', catalogId: CATALOG, kind: 'supplementary', name: 'Nexus labels', primaryFeedIds: [FEED] })
    expect(h.checks.filter((c) => c[0] === 'd7-upload')[0]).toEqual(['d7-upload', CATALOG, ['id', 'internal_label']])
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: CATALOG, kind: 'catalogfeeds', edge: 'product_feeds', params: { name: 'Nexus labels', ingestion_source_type: 'SUPPLEMENTARY_FEED', primary_feed_ids: `["${FEED}"]` } })
    expect(ran.change.after).toMatchObject({ op: 'create', catalogId: CATALOG, feedId: SUPP, kind: 'supplementary', adAccountId: '1234567890' })
    expect(undoParses('set-meta-catalog-feed', { ...ran.change, id: 'chg-2' })).toMatchObject({ args: { action: 'remove-made', catalogId: CATALOG, undoOf: 'chg-2' } })
    expect(await preview('set-meta-catalog-feed', { action: 'create', catalogId: CATALOG, kind: 'supplementary', name: 'L', primaryFeedIds: [FEED], schedule: { interval: 'DAILY', url: 'https://feeds.example.com/a.csv' } })).toEqual({ ok: false, error: expect.stringMatching(/fetches nothing on a schedule/) })
    expect(await preview('set-meta-catalog-feed', { action: 'create', catalogId: CATALOG, kind: 'products', name: 'Feed B' })).toEqual({ ok: false, error: expect.stringMatching(/Say whether the feed deletes items/) })
    expect((await preview('set-meta-catalog-feed', { action: 'create', catalogId: CATALOG, kind: 'products', name: 'Feed B', deletionEnabled: false })).ok).toBe(true)
    expect(h.checks.filter((c) => c[0] === 'feed')).toHaveLength(1)
  })
  it('change, uploads, schedules: only a feed Nexus made; a full upload only when asked; the D7 limits of Nexus\'s own supplementary feed', async () => {
    expect(await preview('set-meta-catalog-feed', { action: 'change', catalogId: CATALOG, feedId: FEED, name: 'Feed B' })).toEqual({ ok: false, error: expect.stringMatching(/not one Nexus made/) })
    h.own = [FEED, SUPP]
    expect(await preview('set-meta-catalog-feed', { action: 'upload', catalogId: CATALOG, feedId: FEED, updateOnly: false, rows: [fullItem('SKU-A')] })).toEqual({ ok: false, error: expect.stringMatching(/send replaceAll true only when the person asked/) })
    const full = await preview('set-meta-catalog-feed', { action: 'upload', catalogId: CATALOG, feedId: FEED, updateOnly: false, replaceAll: true, rows: [fullItem('SKU-A')] })
    expect(full.preview.warnings.join(' ')).toMatch(/FULL REPLACE/)
    expect(await preview('set-meta-catalog-feed', { action: 'change', catalogId: CATALOG, feedId: SUPP, updateSchedule: { interval: 'HOURLY', url: 'https://feeds.example.com/a.csv' } })).toEqual({ ok: false, error: expect.stringMatching(/takes a new name only/) })
    const ran = await run('set-meta-catalog-feed', { action: 'change', catalogId: CATALOG, feedId: FEED, name: 'Feed B', deletionEnabledOn: true })
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: FEED, kind: 'catalogfeed', parent: { kind: 'catalog', id: CATALOG }, params: { name: 'Feed B', deletion_enabled: 'true' } })
    expect(undoParses('set-meta-catalog-feed', ran.change)).toMatchObject({ args: { action: 'change', feedId: FEED, name: 'Feed A' } })
    const schedule = await preview('set-meta-catalog-feed', { action: 'upload-schedule', catalogId: CATALOG, feedId: FEED, schedule: { interval: 'HOURLY', url: 'https://feeds.example.com/p.csv' } })
    expect(schedule.preview.warnings.join(' ')).toMatch(/NO UNDO/)
  })
  it('rules: a D7 rule on the Shopify feed under the rules check; another field only on a feed Nexus made; a change is remove + add; undo reverses', async () => {
    expect(await preview('set-meta-catalog-feed', { action: 'rules', catalogId: CATALOG, feedId: FEED, addRules: [{ attribute: 'title', ruleType: 'letter_case_rule', letterCase: 'to_upper' }] })).toEqual({ ok: false, error: expect.stringMatching(/not one Nexus made.*changes a field Shopify/) })
    h.rules = [{ ruleId: '120000000000135', attribute: 'custom_label_0', ruleType: 'fallback_rule', params: { user_default_value: 'none' } }]
    h.send.mockImplementation(async (_t: unknown, change: { operation: string }) => (change.operation === 'catalog.feed.rule.create' ? { node: { id: '120000000000136', attribute: 'custom_label_0' }, readBack: 'same-request', waitedMs: 0 } : { node: { success: true }, readBack: 'none', waitedMs: 0 }))
    const ran = await run('set-meta-catalog-feed', { action: 'rules', catalogId: CATALOG, feedId: FEED, changeRules: [{ ruleId: '120000000000135', rule: { attribute: 'custom_label_0', ruleType: 'fallback_rule', defaultValue: 'all' } }] })
    expect(h.checks.filter((c) => c[0] === 'd7-rules')[0]).toEqual(['d7-rules', CATALOG, ['custom_label_0']])
    expect(h.send.mock.calls.map((c) => [c[1].operation, c[1].objectId])).toEqual([['catalog.feed.rule.delete', '120000000000135'], ['catalog.feed.rule.create', FEED]])
    expect(ran.change.after.rules).toEqual([{ ruleId: '120000000000136', attribute: 'custom_label_0', ruleType: 'fallback_rule', params: { user_default_value: 'all' } }])
    expect(undoParses('set-meta-catalog-feed', ran.change)).toMatchObject({ args: { action: 'rules', removeRules: ['120000000000136'], addRules: [{ attribute: 'custom_label_0', ruleType: 'fallback_rule', defaultValue: 'none' }] } })
  })
  it('error-report: an upload of a feed of the catalog; it changes nothing', async () => {
    const ran = await run('set-meta-catalog-feed', { action: 'error-report', catalogId: CATALOG, feedId: FEED, uploadId: '120000000000140' })
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: '120000000000140', kind: 'feedupload', edge: 'error_report', params: {} })
    expect(tool('set-meta-catalog-feed').undo!.request(ran.change)).toEqual({ refusal: expect.stringMatching(/changes nothing in the catalog/) })
  })
})

describe('set-meta-instagram-product-tags', () => {
  it('tags: a new tag is added, a tag there moves; Meta never asked to check; undo moves the moved tag back (the added one stays)', async () => {
    h.send.mockResolvedValueOnce({ node: { data: [{ product_id: '120000000000120', x: 0.5, y: 0.5 }, { product_id: '120000000000121', x: 0.7, y: 0.1 }] }, readBack: 'second-read', waitedMs: 0 })
    const ran = await run('set-meta-instagram-product-tags', { action: 'tag', mediaId: '170000000000001', tags: [{ productId: '120000000000120', x: 0.5, y: 0.5 }, { productId: '120000000000121', x: 0.7, y: 0.1 }] })
    expect(h.check).not.toHaveBeenCalled()
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: '170000000000001', kind: 'igmedia', edge: 'product_tags', params: { updated_tags: '[{"product_id":"120000000000120","x":0.5,"y":0.5},{"product_id":"120000000000121","x":0.7,"y":0.1}]' }, readBackOf: '170000000000001/product_tags' })
    expect(ran.change.after).toMatchObject({ op: 'tag', added: ['120000000000121'], moved: [{ productId: '120000000000120', x: 0.5, y: 0.5 }] })
    expect(undoParses('set-meta-instagram-product-tags', ran.change)).toEqual({ tool: 'set-meta-instagram-product-tags', args: { connectionId: 'm-1', why: expect.stringMatching(/the added ones stay/), action: 'tag', mediaId: '170000000000001', tags: [{ productId: '120000000000120', x: 0.2, y: 0.3 }] } })
  })
  it('only an account that may tag, products of a catalog it tags from, places on a photo', async () => {
    h.igMay = false
    expect(await preview('set-meta-instagram-product-tags', { action: 'tag', mediaId: '170000000000001', tags: [{ productId: '120000000000121', x: 0.5, y: 0.5 }] })).toEqual({ ok: false, error: expect.stringMatching(/may not tag products/) })
    h.igMay = true
    h.igCatalogs = new Set()
    expect(await preview('set-meta-instagram-product-tags', { action: 'tag', mediaId: '170000000000001', tags: [{ productId: '120000000000121', x: 0.5, y: 0.5 }] })).toEqual({ ok: false, error: expect.stringMatching(/not in a catalog the chosen Instagram account tags from/) })
    h.igCatalogs = new Set([CATALOG])
    expect(await preview('set-meta-instagram-product-tags', { action: 'tag', mediaId: '170000000000001', tags: [{ productId: '120000000000121' }] })).toEqual({ ok: false, error: expect.stringMatching(/every tag has its place/) })
    h.igPost = { ...h.igPost!, target: 'reel', tagsNow: null }
    expect(await preview('set-meta-instagram-product-tags', { action: 'tag', mediaId: '170000000000001', tags: [{ productId: '120000000000121', x: 0.5, y: 0.5 }] })).toEqual({ ok: false, error: expect.stringMatching(/without a place/) })
    h.igPost = null
    expect(await preview('set-meta-instagram-product-tags', { action: 'tag', mediaId: '170000000000099', tags: [{ productId: '120000000000121', x: 0.5, y: 0.5 }] })).toEqual({ ok: false, error: expect.stringMatching(/not the chosen Instagram account's/) })
  })
  it('appeal: a rejected product of a catalog the account tags from; no undo', async () => {
    const ran = await run('set-meta-instagram-product-tags', { action: 'appeal', productId: '120000000000120', reason: 'It is a toy, not a real item.' })
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: '170000000000000', kind: 'iguser', edge: 'product_appeal', params: { appeal_reason: 'It is a toy, not a real item.', product_id: '120000000000120' } })
    expect(tool('set-meta-instagram-product-tags').undo!.request(ran.change)).toEqual({ refusal: expect.stringMatching(/cannot be withdrawn/) })
    h.igAppeal = { eligible: false, reviewStatus: 'rejected' }
    expect(await preview('set-meta-instagram-product-tags', { action: 'appeal', productId: '120000000000120', reason: 'Toy.' })).toEqual({ ok: false, error: expect.stringMatching(/cannot be appealed now/) })
  })
  it('a run only as a request a person approved', async () => {
    const p = await preview('set-meta-instagram-product-tags', { action: 'tag', mediaId: '170000000000001', tags: [{ productId: '120000000000121', x: 0.5, y: 0.5 }] })
    const byRule = await tool('set-meta-instagram-product-tags').execute!(parse('set-meta-instagram-product-tags', { action: 'tag', mediaId: '170000000000001', tags: [{ productId: '120000000000121', x: 0.5, y: 0.5 }] }), { ...approved(p.preview), decidedVia: 'auto' })
    expect(byRule).toMatchObject({ ok: false })
    expect(h.send).not.toHaveBeenCalled()
  })
})

describe('remove-meta-catalog-items kind item-group (CT-055)', () => {
  it('ONLY_IF_EMPTY unless the person asked for the items too; the items check (D7) first', async () => {
    h.group = { groupId: '120000000000115', catalogId: CATALOG, groupSku: 'GROUP-A', itemIds: new Set(['120000000000120']), more: false }
    const p = await preview('remove-meta-catalog-items', { kind: 'item-group', groupId: '120000000000115', confirmDelete: true })
    expect(p.preview.requests).toEqual([{ step: 1, label: 'Delete item group "GROUP-A" (120000000000115)', metaCheck: 'no-check' }])
    expect(p.preview.warnings.join(' ')).toMatch(/ONLY_IF_EMPTY/)
    expect(h.checks).toEqual([['writable-items', CATALOG, undefined]])
    await run('remove-meta-catalog-items', { kind: 'item-group', groupId: '120000000000115', alsoItems: true, confirmDelete: true })
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: '120000000000115', kind: 'productgroup', method: 'DELETE', params: { deletion_method: 'DELETE_ITEMS' } })
  })
})

describe('fix round 1 (reviews A and B)', () => {
  /** As change-record.service compares: keys sorted, the record as stored (JSON). */
  const canonical = (v: unknown): string => {
    const sorted = (x: unknown): unknown => (Array.isArray(x) ? x.map(sorted) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sorted((x as Record<string, unknown>)[k])])) : x)
    return JSON.stringify(sorted(JSON.parse(JSON.stringify(v ?? null))))
  }
  const stored = (change: { before: unknown; after: unknown }): ToolChange => JSON.parse(JSON.stringify(change))
  const unchanged = async (name: string, change: ToolChange) => canonical(await tool(name).undo!.current(change)) === canonical(change.after)

  it('A-F2: a price, by any path, only for a person who may see revenue', async () => {
    h.own = [FEED]
    const refused = { ok: false, error: expect.stringMatching(/may see revenue/) }
    const schedule = { interval: 'HOURLY', url: 'https://feeds.example.com/p.csv' }
    for (const args of [
      { action: 'upload', catalogId: CATALOG, feedId: FEED, updateOnly: true, rows: [{ retailerId: 'SKU-A', price: { amountMinor: 4490, currency: 'EUR' } }] },
      { action: 'upload', catalogId: CATALOG, feedId: FEED, updateOnly: true, rows: [{ retailerId: 'SKU-A', shipping: [{ country: 'IT', service: 'Home', price: { amountMinor: 490, currency: 'EUR' } }] }] },
      { action: 'upload', catalogId: CATALOG, feedId: FEED, updateOnly: true, url: 'https://feeds.example.com/a.csv' },
      { action: 'upload-schedule', catalogId: CATALOG, feedId: FEED, schedule },
      { action: 'create', catalogId: CATALOG, kind: 'offers', name: 'Offers', deletionEnabled: false },
      { action: 'create', catalogId: CATALOG, kind: 'products', name: 'F', deletionEnabled: false, defaultCurrency: 'EUR' },
      { action: 'create', catalogId: CATALOG, kind: 'products', name: 'F', deletionEnabled: false, updateSchedule: schedule },
      { action: 'create', catalogId: CATALOG, kind: 'products', name: 'F', deletionEnabled: false, rules: [{ attribute: 'price', ruleType: 'mapping_rule', mapFrom: 'cost' }] },
      { action: 'change', catalogId: CATALOG, feedId: FEED, defaultCurrency: 'USD' },
      { action: 'change', catalogId: CATALOG, feedId: FEED, schedule },
      { action: 'rules', catalogId: CATALOG, feedId: FEED, addRules: [{ attribute: 'sale_price', ruleType: 'mapping_rule', mapFrom: 'promo' }] },
    ]) expect(await preview('set-meta-catalog-feed', args, noRevenue), JSON.stringify(args)).toEqual(refused)
    h.rules = [{ ruleId: '120000000000135', attribute: 'price', ruleType: 'mapping_rule', params: { map_from: 'cost' } }]
    expect(await preview('set-meta-catalog-feed', { action: 'rules', catalogId: CATALOG, feedId: FEED, removeRules: ['120000000000135'] }, noRevenue)).toEqual(refused)
    expect((await preview('set-meta-catalog-feed', { action: 'upload', catalogId: CATALOG, feedId: FEED, updateOnly: true, rows: [{ retailerId: 'SKU-A', availability: 'in stock' }] }, noRevenue)).ok).toBe(true)
    // Taking a country price off is a price change; an override with no money field is not.
    h.overrides.set('id-SKU-A|COUNTRY', { IT: { price: '44.90 EUR' }, DE: { availability: 'in stock' } })
    expect(await preview('set-meta-catalog-items', { action: 'remove-overrides', catalogId: CATALOG, remove: [{ retailerId: 'SKU-A', type: 'COUNTRY', value: 'IT' }] }, noRevenue)).toEqual({ ok: false, error: expect.stringMatching(/only a person who may see revenue/) })
    expect((await preview('set-meta-catalog-items', { action: 'remove-overrides', catalogId: CATALOG, remove: [{ retailerId: 'SKU-A', type: 'COUNTRY', value: 'DE' }] }, noRevenue)).ok).toBe(true)
  })
  it('A-F1 / M18: a supplementary feed\'s rules name the D7 columns only — at its create and on Nexus\'s own', async () => {
    expect(await preview('set-meta-catalog-feed', { action: 'create', catalogId: CATALOG, kind: 'supplementary', name: 'L', primaryFeedIds: [FEED], rules: [{ attribute: 'title', ruleType: 'letter_case_rule', letterCase: 'to_upper' }] })).toEqual({ ok: false, error: expect.stringMatching(/adds only the D7 columns/) })
    h.own = [SUPP]
    expect(await preview('set-meta-catalog-feed', { action: 'rules', catalogId: CATALOG, feedId: SUPP, addRules: [{ attribute: 'title', ruleType: 'letter_case_rule', letterCase: 'to_upper' }] })).toEqual({ ok: false, error: expect.stringMatching(/supplementary feed: its rules name the D7 columns only/) })
    expect(h.checks).toEqual([])
    expect((await preview('set-meta-catalog-feed', { action: 'rules', catalogId: CATALOG, feedId: SUPP, addRules: [{ attribute: 'custom_label_1', ruleType: 'fallback_rule', defaultValue: 'x' }] })).ok).toBe(true)
  })
  it('A-F3: a rule change while a catalog ad delivers is SPENDS MONEY (every item of the feed changes)', async () => {
    h.users = [{ kind: 'adset', id: '120000000000210', name: 'Ad set A', effectiveStatus: 'ACTIVE', uses: 'catalog 120000000000100' }]
    const p = await preview('set-meta-catalog-feed', { action: 'rules', catalogId: CATALOG, feedId: FEED, addRules: [{ attribute: 'custom_label_0', ruleType: 'fallback_rule', defaultValue: 'x' }] })
    expect(p.preview).toMatchObject({ spendsMoney: true, spendsMoneyBecause: [expect.stringMatching(/rules change a field of every item of the feed/)] })
  })
  it('A-F6: a rule Nexus could not make again is not removed, and an undo never drops one silently', async () => {
    h.rules = [{ ruleId: '120000000000137', attribute: 'custom_label_0', ruleType: 'value_mapping_rule', params: { a: 1 } }]
    expect(await preview('set-meta-catalog-feed', { action: 'rules', catalogId: CATALOG, feedId: FEED, removeRules: ['120000000000137'] })).toEqual({ ok: false, error: expect.stringMatching(/params Nexus does not send.*removes nothing/) })
    expect(tool('set-meta-catalog-feed').undo!.request({ before: { op: 'rules', catalogId: CATALOG, feedId: FEED, rules: [{ ruleId: '120000000000137', attribute: 'custom_label_0', ruleType: 'value_mapping_rule', params: { a: 1 } }] }, after: { op: 'rules', catalogId: CATALOG, feedId: FEED, rules: [], accountId: 'm-1' } })).toEqual({ refusal: expect.stringMatching(/whose params Nexus does not send: undo cannot put it back/) })
  })
  it('re-review NF2: deleting a money feed Nexus made (offers, local inventory, country prices) needs revenue view and says MONEY', async () => {
    h.own = [FEED]
    h.records.set('chg-9', { toolName: 'set-meta-catalog-feed', before: {}, after: { op: 'create', catalogId: CATALOG, feedId: FEED, kind: 'offers', adAccountId: '1234567890' }, undoneAt: null })
    expect(await preview('set-meta-catalog-feed', { action: 'remove-made', catalogId: CATALOG, undoOf: 'chg-9' }, noRevenue)).toEqual({ ok: false, error: expect.stringMatching(/offers feed \(its discounts go\).*may see revenue/) })
    const p = await preview('set-meta-catalog-feed', { action: 'remove-made', catalogId: CATALOG, undoOf: 'chg-9' })
    expect(p.preview.warnings.join(' ')).toMatch(/^MONEY: the discounts, store prices or country prices|MONEY: the discounts, store prices or country prices/)
    h.records.set('chg-10', { toolName: 'set-meta-catalog-feed', before: {}, after: { op: 'create', catalogId: CATALOG, feedId: FEED, kind: 'products', adAccountId: '1234567890' }, undoneAt: null })
    const plain = await preview('set-meta-catalog-feed', { action: 'remove-made', catalogId: CATALOG, undoOf: 'chg-10' }, noRevenue)
    expect(plain.ok).toBe(true)
    expect(plain.preview.warnings.join(' ')).not.toMatch(/MONEY:/)
  })
  it('re-review nit b: a supplementary feed made with D7 rules runs step 12\'s { rules } check at the preview, as the gateway does', async () => {
    expect((await preview('set-meta-catalog-feed', { action: 'create', catalogId: CATALOG, kind: 'supplementary', name: 'L', primaryFeedIds: [FEED], rules: [{ attribute: 'custom_label_1', ruleType: 'fallback_rule', defaultValue: 'x' }] })).ok).toBe(true)
    expect(h.checks.filter((c) => c[0].startsWith('d7-'))).toEqual([['d7-upload', CATALOG, ['id', 'internal_label']], ['d7-rules', CATALOG, ['custom_label_1']]])
  })
  it('B-F5: rows only to a primary feed of items Nexus made; labels never to an override feed', async () => {
    h.own = [FEED]; h.kinds.set(FEED, 'offers')
    expect(await preview('set-meta-catalog-feed', { action: 'upload', catalogId: CATALOG, feedId: FEED, updateOnly: true, rows: [{ retailerId: 'SKU-A', availability: 'in stock' }] })).toEqual({ ok: false, error: expect.stringMatching(/not a primary feed of items Nexus made \(it was made as offers\)/) })
    expect((await preview('set-meta-catalog-feed', { action: 'upload', catalogId: CATALOG, feedId: FEED, updateOnly: true, url: 'https://feeds.example.com/offers.csv' })).ok).toBe(true)
    h.feeds.set(FEED, feedRow(FEED, { overrideType: 'COUNTRY' }))
    expect(await preview('set-meta-catalog-feed', { action: 'labels', catalogId: CATALOG, feedId: FEED, via: 'shopify-feed', labelItems: [{ retailerId: 'SKU-A', customLabel0: 'Sale' }] })).toEqual({ ok: false, error: expect.stringMatching(/country override feed/) })
  })
  it('B-F1, B-N3, B-F7, B-N4: ratings together with Meta\'s ranges; labels lower case; the CT-154 and 2023-08-10 words', () => {
    expect(__catalogItemsTest.itemFieldsOf({ userRating: 4.5 })).toEqual({ refusal: expect.stringMatching(/give both or neither/) })
    expect(__catalogItemsTest.itemFieldsOf({ userRating: 4.46, ratingCount: 3 })).toEqual({ user_rating: 4.5, rating_count: 3 })
    expect(() => parse('set-meta-catalog-items', { action: 'update', catalogId: CATALOG, items: [{ retailerId: 'A', userRating: 0.5, ratingCount: 1 }] })).toThrow()
    expect(() => parse('set-meta-catalog-items', { action: 'update', catalogId: CATALOG, items: [{ retailerId: 'A', userRating: 4, ratingCount: 0 }] })).toThrow()
    expect(__catalogItemsTest.itemFieldsOf({ internalLabels: ['Summer'] })).toEqual({ internal_label: ['summer'] })
    expect(__catalogItemsTest.labelsOf([{ retailerId: 'SKU-A', internalLabels: ['Sale'] }])).toEqual([{ sku: 'SKU-A', fields: { internal_label: ['sale'] } }])
    expect(NEW_POST_TAGS).toMatch(/go with create-meta-instagram-post: productTags/)
    expect(tool('set-meta-instagram-product-tags').description).toMatch(/since 2023-08-10 some businesses without checkout-enabled Shops can no longer tag/)
  })
  it('A-F4: undo compares like with like — an item update (labels\' case and order, a sale window in UTC, an unread field, image tags)', async () => {
    h.send.mockResolvedValueOnce(batchNode())
    const ran = await run('set-meta-catalog-items', { action: 'update', catalogId: CATALOG, items: [{ retailerId: 'SKU-A', internalLabels: ['Summer', 'Sale'], saleStart: '2026-11-01T00:00+0100', saleEnd: '2026-11-30T23:59+0100', googleProductCategory: 'Apparel', images: [{ url: 'https://shop.example.com/a.jpg', tags: ['front'] }], price: { amountMinor: 4490, currency: 'EUR' } }] })
    const change = stored(ran.change)
    h.items.set('SKU-A', { ...h.items.get('SKU-A')!, internal_label: ['sale', 'summer'], sale_price_effective_date: '2026-10-31T23:00+0000/2026-11-30T22:59+0000', google_product_category: undefined, image: [{ url: 'https://shop.example.com/a.jpg' }], price: '44.90 EUR' })
    expect(await unchanged('set-meta-catalog-items', change)).toBe(true)
    h.items.set('SKU-A', { ...h.items.get('SKU-A')!, internal_label: ['winter'] })
    expect(await unchanged('set-meta-catalog-items', change)).toBe(false)
    h.items.delete('SKU-A')
    expect(await unchanged('set-meta-catalog-items', change)).toBe(false)
  })
  it('A-F4: undo compares like with like — overrides (a price Meta writes without its trailing zero)', async () => {
    h.overrides.set('id-SKU-A|COUNTRY', { IT: { price: '49.90 EUR' } })
    h.send.mockResolvedValueOnce(batchNode())
    const ran = await run('set-meta-catalog-items', { action: 'overrides', catalogId: CATALOG, overrides: [{ retailerId: 'SKU-A', type: 'COUNTRY', value: 'IT', price: { amountMinor: 4490, currency: 'EUR' } }] })
    const change = stored(ran.change)
    h.overrides.set('id-SKU-A|COUNTRY', { IT: { price: '44.9 EUR' } })
    expect(await unchanged('set-meta-catalog-items', change)).toBe(true)
    h.overrides.set('id-SKU-A|COUNTRY', { IT: { price: '45.00 EUR' } })
    expect(await unchanged('set-meta-catalog-items', change)).toBe(false)
  })
  it('A-F4: undo compares like with like — a feed change (a schedule by the keys sent, enums in any case)', async () => {
    h.own = [FEED]
    const ran = await run('set-meta-catalog-feed', { action: 'change', catalogId: CATALOG, feedId: FEED, name: 'Feed B', delimiter: 'TAB', updateSchedule: { interval: 'HOURLY', url: 'https://feeds.example.com/p.csv' } })
    const change = stored(ran.change)
    h.feeds.set(FEED, feedRow(FEED, { name: 'Feed B', delimiter: 'tab', updateSchedule: { interval: 'HOURLY', url: 'https://feeds.example.com/p.csv', interval_count: 1, timezone: 'America/Los_Angeles' } }))
    expect(await unchanged('set-meta-catalog-feed', change)).toBe(true)
    h.feeds.set(FEED, feedRow(FEED, { name: 'Feed B', delimiter: 'tab', updateSchedule: { interval: 'DAILY', url: 'https://feeds.example.com/p.csv' } }))
    expect(await unchanged('set-meta-catalog-feed', change)).toBe(false)
  })
  it('A-F4: undo compares like with like — labels (Meta\'s lower case) and rules', async () => {
    const ran = await run('set-meta-catalog-feed', { action: 'labels', catalogId: CATALOG, feedId: FEED, via: 'shopify-feed', labelItems: [{ retailerId: 'SKU-A', internalLabels: ['Sale', 'Summer'] }] })
    const change = stored(ran.change)
    h.items.set('SKU-A', { ...h.items.get('SKU-A')!, internal_label: ['summer', 'sale'] })
    expect(await unchanged('set-meta-catalog-feed', change)).toBe(true)
    h.items.set('SKU-A', { ...h.items.get('SKU-A')!, internal_label: ['summer'] })
    expect(await unchanged('set-meta-catalog-feed', change)).toBe(false)
    h.rules = [{ ruleId: '120000000000135', attribute: 'custom_label_0', ruleType: 'fallback_rule', params: { user_default_value: 'none' } }]
    h.send.mockImplementation(async (_t: unknown, c: { operation: string }) => (c.operation === 'catalog.feed.rule.create' ? { node: { id: '120000000000136', attribute: 'custom_label_0' }, readBack: 'same-request', waitedMs: 0 } : { node: { success: true }, readBack: 'none', waitedMs: 0 }))
    const rules = stored((await run('set-meta-catalog-feed', { action: 'rules', catalogId: CATALOG, feedId: FEED, changeRules: [{ ruleId: '120000000000135', rule: { attribute: 'custom_label_0', ruleType: 'fallback_rule', defaultValue: 'all' } }] })).change)
    h.rules = [{ ruleId: '120000000000136', attribute: 'custom_label_0', ruleType: 'fallback_rule', params: { user_default_value: 'all' } }]
    expect(await unchanged('set-meta-catalog-feed', rules)).toBe(true)
    h.rules = []
    expect(await unchanged('set-meta-catalog-feed', rules)).toBe(false)
  })
  it('A-F4 / A-N1: tag places compare at Nexus\'s 4 decimals; the 25-a-day count is the Instagram account\'s', async () => {
    h.send.mockResolvedValueOnce({ node: { data: [{ product_id: '120000000000120', x: 0.7, y: 0.1 }] }, readBack: 'second-read', waitedMs: 0 })
    const ran = await run('set-meta-instagram-product-tags', { action: 'tag', mediaId: '170000000000001', tags: [{ productId: '120000000000120', x: 0.7, y: 0.1 }] })
    expect(vi.mocked(taggedPostsLastDay)).toHaveBeenCalledWith('170000000000000')
    expect(ran.change.after).toMatchObject({ instagramId: '170000000000000' })
    const change = stored(ran.change)
    h.igPost = { ...h.igPost!, tagsNow: new Map([['120000000000120', { x: Math.fround(0.7), y: Math.fround(0.1) }]]) }
    expect(await unchanged('set-meta-instagram-product-tags', change)).toBe(true)
    h.igPost = { ...h.igPost!, tagsNow: new Map([['120000000000120', { x: 0.3, y: 0.1 }]]) }
    expect(await unchanged('set-meta-instagram-product-tags', change)).toBe(false)
  })
})

describe('conversions', () => {
  it('typed args → Meta\'s write fields and back (the undo\'s exact values)', () => {
    const fields = __catalogItemsTest.itemFieldsOf({ price: { amountMinor: 4990, currency: 'EUR' }, saleStart: '2026-11-01T00:00+0100', saleEnd: '2026-11-30T23:59+0100', shipping: [{ country: 'IT', service: 'Home', price: { amountMinor: 490, currency: 'EUR' } }], variantAttributes: [{ name: 'Scent', value: 'Fruity' }], customLabel2: 'Sale', hideFrom: ['da'] })
    expect(fields).toEqual({ price: '49.90 EUR', sale_price_effective_date: '2026-11-01T00:00+0100/2026-11-30T23:59+0100', shipping: [{ shipping_country: 'IT', shipping_service: 'Home', shipping_price_value: '4.90', shipping_price_currency: 'EUR' }], additional_variant_attribute: 'Scent:Fruity', custom_label_2: 'Sale', disabled_capabilities: ['da'] })
    expect(__catalogItemsTest.itemFieldsOf({ saleStart: '2026-11-01T00:00+0100' })).toEqual({ refusal: expect.stringMatching(/both saleStart and saleEnd/) })
    expect(__catalogItemsTest.argsOfFields({ price: '490 JPY', custom_label_2: 'Sale', disabled_capabilities: ['da'], additional_variant_attribute: 'Scent:Fruity' })).toEqual({ price: { amountMinor: 490, currency: 'JPY' }, customLabel2: 'Sale', hideFrom: ['da'], variantAttributes: [{ name: 'Scent', value: 'Fruity' }] })
    expect(__catalogItemsTest.ruleArgOf({ attribute: 'color', ruleType: 'value_mapping_rule', params: { rosso: 'red' } })).toEqual({ attribute: 'color', ruleType: 'value_mapping_rule', values: [{ from: 'rosso', to: 'red' }] })
    expect(__catalogItemsTest.ruleArgOf({ attribute: 'color', ruleType: 'value_mapping_rule', params: { rosso: 1 } })).toBeNull()
  })
})
