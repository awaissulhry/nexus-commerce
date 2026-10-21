/**
 * Meta step 34 — the catalog change tools as the approval gate uses them (Meta, the account and the live reads are
 * stand-ins): the change contract of every Meta change tool; the D7 write check (writableCatalog) in every draft, so at the
 * preview and again at the run; explicit ask for every delete; Meta never asked to check a catalog change; a run only as a
 * request a person approved; what each record keeps and what its undo asks for. Made-up ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  account: { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' } as Record<string, unknown>,
  chosen: {
    connectionId: 'm-1', adAccountId: '1234567890', currency: 'EUR', businessId: '120000000000090', pageId: null, instagramId: null,
    connection: { connectionId: 'm-1', appId: '1234567', systemUser: { id: '100000000000009', name: 'Nexus' } },
  } as Record<string, unknown>,
  catalogs: new Map<string, Record<string, unknown>>(),
  writer: { evidence: [] as Array<Record<string, unknown>> },
  refuseItems: null as string | null,
  writable: vi.fn(),
  settings: null as Record<string, unknown> | null,
  sets: [] as Array<Record<string, unknown>>,
  users: [] as Array<Record<string, unknown>>,
  unseen: [] as string[],
  usersCalls: [] as unknown[],
  me: '100000000000009' as string | null,
  set: null as Record<string, unknown> | null,
  people: new Map<string, Record<string, unknown>>(),
  portfolioPeople: new Map<string, Record<string, unknown>>(),
  agencies: new Map<string, Record<string, unknown>>(),
  sources: new Map<string, Record<string, unknown>>(),
  pixels: new Map<string, string | null>(),
  skus: new Map<string, Record<string, unknown>>(),
  feed: { feedId: '120000000000130', name: 'Labels', supplementary: true, productCount: null } as Record<string, unknown>,
  count: { matchingItems: 7, current: { itemsNow: 12 } } as Record<string, unknown>,
  records: new Map<string, Record<string, unknown>>(),
  taken: new Set<string>(),
  check: vi.fn(),
  send: vi.fn(),
  batch: vi.fn(),
}))
vi.mock('../../../db.js', () => ({ default: { agentChange: { findFirst: vi.fn(async ({ where }: { where: { id: string; toolName: string } }) => { const r = h.records.get(where.id); return r && r.toolName === where.toolName ? r : null }) } } }))
vi.mock('../../marketing/meta-ads/change-account.js', () => ({ metaChangeAccount: vi.fn(async () => h.account) }))
vi.mock('../../marketing/meta-ads/live.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live.js')>()),
  metaChosenAccount: vi.fn(async () => h.chosen),
}))
vi.mock('../../marketing/meta-ads/taken.js', () => ({
  takenIds: vi.fn(async (_p: string, ids: string[]) => new Set(ids.filter((id) => h.taken.has(id)))),
  portfolioTaken: vi.fn(async () => null),
}))
vi.mock('../../marketing/meta-ads/catalog-rule.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/catalog-rule.js')>()),
  catalogPortfolio: vi.fn(async () => '120000000000090'),
}))
vi.mock('../../marketing/meta-ads/live-catalog-admin.js', async (importActual) => {
  const actual = await importActual<typeof import('../../marketing/meta-ads/live-catalog-admin.js')>()
  const { MetaLiveRefusal } = await import('../../marketing/meta-ads/live.js')
  return {
    ...actual,
    writableFor: h.writable.mockImplementation(async (_a: unknown, id: string, purpose: unknown) => {
      if (purpose === 'items' && h.refuseItems) throw new MetaLiveRefusal(h.refuseItems)
      const catalog = h.catalogs.get(id)
      if (!catalog) throw new MetaLiveRefusal('That catalog is not owned by the chosen ad account\'s business portfolio.')
      return { catalog, writer: h.writer }
    }),
    liveCatalogSettings: vi.fn(async () => h.settings),
    liveCatalogCategories: vi.fn(async () => ({ byValue: new Map(), more: false })),
    liveEventSources: vi.fn(async () => ({ sources: h.sources, more: false })),
    liveAccountPixels: vi.fn(async () => ({ pixels: h.pixels, more: false })),
    liveCatalogPeople: vi.fn(async () => ({ people: h.people, more: false })),
    livePortfolioPeople: vi.fn(async () => ({ people: h.portfolioPeople, more: false })),
    liveCatalogAgencies: vi.fn(async () => ({ agencies: h.agencies, more: false })),
    liveCatalogSets: vi.fn(async () => ({ sets: h.sets, more: false })),
    liveCatalogUsers: vi.fn(async (_a: unknown, input: unknown) => { h.usersCalls.push(input); return { users: h.users, unseen: h.unseen } }),
    liveNexusSystemUser: vi.fn(async () => h.me),
    liveSet: vi.fn(async () => { if (!h.set) throw new MetaLiveRefusal('That id is not a product set.'); return h.set }),
    liveItemsBySku: vi.fn(async (_a: unknown, _c: string, skus: string[]) => new Map(skus.filter((s) => h.skus.has(s)).map((s) => [s, h.skus.get(s)]))),
    liveItem: vi.fn(async () => ({ itemId: '120000000000120', catalogId: '120000000000100', sku: 'SKU-A', name: 'Jacket A' })),
    liveFeed: vi.fn(async () => h.feed),
  }
})
vi.mock('../../marketing/meta-ads/live-commerce.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live-commerce.js')>()),
  liveProductSets: vi.fn(async () => h.count),
}))
vi.mock('../../marketing/meta-ads/live-catalog.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live-catalog.js')>()),
  liveCatalogItems: h.batch,
}))
vi.mock('../../marketing/meta-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/write-client.js')>()),
  metaCheckChange: h.check,
  metaSendChange: h.send,
}))

import { AI_BACKGROUNDS_NOT_BUILT, ITEM_ORDER_NOT_OFFERED, META_ADS_CATALOG_ADMIN_TOOLS } from './meta-ads-catalog-admin.tools.js'
import { AUDIENCES_UNSEEN } from '../../marketing/meta-ads/live-catalog-admin.js'
import { META_CHANGE_RULES } from './meta-ads-kit.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { __metaObjectLimitsTest } from '../../gateway/meta-object-limits.js'
import type { AgentTool, ToolContext, ToolResult } from '../tool-types.js'

const tool = (name: string) => META_ADS_CATALOG_ADMIN_TOOLS.find((t) => t.name === name)!
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

const CATALOG = '120000000000100'
const SEGMENT = '120000000000101'
const SET = '120000000000110'
const PIXEL = '120000000000050'
const catalogRow = (id: string, more: Record<string, unknown> = {}) => ({ catalogId: id, portfolioId: '120000000000090', relation: 'owned', ownerBusinessId: '120000000000090', name: 'Catalog A', vertical: 'commerce', productCount: 40, isSegment: false, ...more })

beforeEach(() => {
  __metaObjectLimitsTest.useMemory()
  vi.unstubAllEnvs()
  vi.stubEnv('NEXUS_META_ADS_WRITES', 'on')
  h.check.mockReset(); h.send.mockReset(); h.batch.mockReset(); h.writable.mockClear()
  h.send.mockImplementation(async () => ({ node: { success: true }, readBack: 'none', waitedMs: 0 }))
  h.catalogs = new Map([[CATALOG, catalogRow(CATALOG)], [SEGMENT, catalogRow(SEGMENT, { isSegment: true, name: 'Seg A' })]])
  h.writer = { evidence: [] }
  h.refuseItems = null
  h.settings = { catalogId: CATALOG, name: 'Catalog A', defaultImageUrl: null, fallbackImageUrls: [], displaySettings: null, productCount: 40 }
  h.sets = [{ id: SET, name: 'Set A', productCount: 12 }]
  h.users = []; h.unseen = []; h.usersCalls = []; h.me = '100000000000009'
  h.set = { productSetId: SET, catalogId: CATALOG, name: 'Set A', filter: '{"brand":{"eq":"Shop A"}}', retailerId: null, productCount: 12, metadata: null }
  h.people = new Map(); h.portfolioPeople = new Map([['100000000000001', { name: 'Person A', kind: 'person' }]]); h.agencies = new Map()
  h.sources = new Map(); h.pixels = new Map([[PIXEL, 'Pixel A']]); h.skus = new Map([['SKU-A', { itemId: '120000000000120', name: 'Jacket A' }]])
  h.feed = { feedId: '120000000000130', name: 'Labels', supplementary: true, productCount: null }
  h.count = { matchingItems: 7, current: { itemsNow: 12 } }
  h.records = new Map(); h.taken = new Set()
})

describe('the change contract', () => {
  it('every tool: alwaysAsk at ask, high risk, open world, ads.campaigns.manage, the Meta rules line, material fields', () => {
    expect(META_ADS_CATALOG_ADMIN_TOOLS.map((t) => t.name)).toEqual(['create-meta-catalog', 'set-meta-catalog', 'set-meta-catalog-access', 'set-meta-product-set', 'remove-meta-catalog-items'])
    for (const t of META_ADS_CATALOG_ADMIN_TOOLS) {
      expect(t, t.name).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', riskTier: 'high', requiresApprovalDefault: true, openWorld: true, readOnly: false, category: 'advertising', requires: ['ads.campaigns.manage'] })
      expect(t.description.endsWith(META_CHANGE_RULES), t.name).toBe(true)
      expect(MATERIAL_PREVIEW_FIELDS[t.name], t.name).toEqual(['basis', 'plan', 'reach'])
      expect(t.title.length, t.name).toBeLessThanOrEqual(40)
    }
    expect(tool('remove-meta-catalog-items')).toMatchObject({ reversibility: 'none' })
    expect(tool('remove-meta-catalog-items').undo).toBeUndefined()
    for (const name of ['create-meta-catalog', 'set-meta-catalog', 'set-meta-catalog-access', 'set-meta-product-set']) expect(tool(name).undo, name).toBeDefined()
    expect(tool('create-meta-catalog').consequencesFor!({ removeMade: true })).toEqual({ reversibility: 'none' })
    expect(tool('set-meta-catalog-access').consequencesFor!({ action: 'unshare' })).toEqual({ reversibility: 'none' })
  })
  it('the delete tool: confirmDelete must be literally true; the description points a stop to a pause', () => {
    expect(() => parse('remove-meta-catalog-items', { kind: 'catalog', catalogId: CATALOG })).toThrow()
    expect(() => parse('remove-meta-catalog-items', { kind: 'catalog', catalogId: CATALOG, confirmDelete: 'yes' })).toThrow()
    expect(tool('remove-meta-catalog-items').description).toMatch(/only when the person explicitly asked to DELETE \(confirmDelete true\).*FINAL, no undo.*pause them \(set-meta-status\)/)
    expect(() => parse('remove-meta-catalog-items', { kind: 'items', catalogId: CATALOG, retailerIds: Array.from({ length: 251 }, (_, i) => `S${i}`), confirmDelete: true })).toThrow()
  })
  it('CT-177 and CT-067 are answered in words, not sent', async () => {
    expect(await preview('set-meta-catalog', { action: 'settings', catalogId: CATALOG, aiBackgrounds: true })).toEqual({ ok: false, error: AI_BACKGROUNDS_NOT_BUILT })
    expect(AI_BACKGROUNDS_NOT_BUILT).toMatch(/creative_features_spec\.image_background_gen.*Mobile Feed/)
    expect(await preview('set-meta-product-set', { action: 'change', productSetId: SET, itemOrder: [1, 2] })).toEqual({ ok: false, error: ITEM_ORDER_NOT_OFFERED })
    expect(h.send).not.toHaveBeenCalled()
  })
})

describe('create-meta-catalog', () => {
  it('previews a catalog on the chosen portfolio (Meta never asked to check it); the run records the new id; undo deletes only it', async () => {
    const p = await preview('create-meta-catalog', { name: 'Catalog B' })
    expect(p.ok).toBe(true)
    expect(h.check).not.toHaveBeenCalled()
    expect(p.preview).toMatchObject({ spendsMoney: false, metaCheck: { checked: 'none' }, requests: [{ step: 1, label: 'Make catalog "Catalog B" in business portfolio 120000000000090', metaCheck: 'no-check' }] })
    h.send.mockResolvedValueOnce({ node: { id: '120000000000102', name: 'Catalog B', vertical: 'commerce' }, readBack: 'second-read', waitedMs: 0 })
    const ran = await run('create-meta-catalog', { name: 'Catalog B' })
    expect(ran.ok).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: '120000000000090', kind: 'catalogbusiness', edge: 'owned_product_catalogs', params: { name: 'Catalog B', vertical: 'commerce' } })
    expect(ran.change.after).toMatchObject({ op: 'create', made: { id: '120000000000102', name: 'Catalog B', segment: false }, accountId: 'm-1', adAccountId: '1234567890' })
    expect(tool('create-meta-catalog').undo!.request({ ...ran.change, id: 'chg-1' })).toEqual({ tool: 'create-meta-catalog', args: { connectionId: 'm-1', why: expect.any(String), removeMade: true, undoOf: 'chg-1' } })
  })
  it('the undo (removeMade): only from the change\'s own record; a catalog Shopify now writes is refused in D7\'s words', async () => {
    h.records.set('chg-1', { toolName: 'create-meta-catalog', before: {}, after: { op: 'create', made: { id: CATALOG, name: 'Catalog A', segment: false, parentId: null }, adAccountId: '1234567890' }, undoneAt: null })
    expect(await preview('create-meta-catalog', { removeMade: true })).toEqual({ ok: false, error: expect.stringMatching(/undo-change asks for it with undoOf/) })
    expect(await preview('create-meta-catalog', { removeMade: true, undoOf: 'chg-9' })).toEqual({ ok: false, error: expect.stringMatching(/not a create-meta-catalog change/) })
    const ok = await preview('create-meta-catalog', { removeMade: true, undoOf: 'chg-1' })
    expect(ok.preview.requests).toEqual([{ step: 1, label: 'Delete catalog "Catalog A" (120000000000100)', metaCheck: 'no-check' }])
    expect(h.writable.mock.calls.map((c) => c[2])).toEqual(['settings', 'items'])
    h.refuseItems = 'Shopify owns these items: remove them in Shopify. Shopify writes its items; Nexus must not write items here (D7).'
    expect(await preview('create-meta-catalog', { removeMade: true, undoOf: 'chg-1' })).toEqual({ ok: false, error: expect.stringMatching(/^Shopify owns these items: remove them in Shopify/) })
    expect(await preview('create-meta-catalog', { removeMade: true, undoOf: 'chg-1', name: 'X' })).toEqual({ ok: false, error: expect.stringMatching(/takes removeMade, undoOf/) })
  })
  it('a segment: of a catalog of this business, never of a segment; its filter needs conditions or everyItem', async () => {
    expect(await preview('create-meta-catalog', { name: 'Seg', segmentOf: { parentCatalogId: SEGMENT, everyItem: true } })).toEqual({ ok: false, error: expect.stringMatching(/is a segment itself/) })
    expect(await preview('create-meta-catalog', { name: 'Seg', segmentOf: { parentCatalogId: CATALOG } })).toEqual({ ok: false, error: expect.stringMatching(/say so explicitly/) })
    const p = await preview('create-meta-catalog', { name: 'Seg', segmentOf: { parentCatalogId: CATALOG, conditions: [{ field: 'brand', op: 'eq', value: 'Shop A' }] } })
    expect(p.preview.warnings.join(' ')).toMatch(/2310019.*holds 7 items of the parent catalog now \(of 40\)/)
    expect(await preview('create-meta-catalog', { name: 'Seg', segmentOf: { parentCatalogId: CATALOG, conditions: [{ field: 'price_amount', op: 'gte', amountMinor: 4990 }] } }, noRevenue)).toEqual({ ok: false, error: expect.stringMatching(/only for a person who may see revenue/) })
  })
})

describe('set-meta-catalog', () => {
  it('settings: the D7 write check every time (preview and run); the record keeps what Meta read back; undo sends the earlier name', async () => {
    h.send.mockResolvedValueOnce({ node: { id: CATALOG, name: 'Catalog B', default_image_url: null }, readBack: 'second-read', waitedMs: 0 })
    const ran = await run('set-meta-catalog', { action: 'settings', catalogId: CATALOG, name: 'Catalog B' })
    expect(ran.ok).toBe(true)
    expect(h.writable.mock.calls.filter((c) => c[1] === CATALOG && c[2] === 'settings')).toHaveLength(2)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: CATALOG, kind: 'catalog', params: { name: 'Catalog B' }, expect: { name: 'Catalog B' } })
    expect(ran.change).toMatchObject({ before: { op: 'settings', fields: { name: 'Catalog A' } }, after: { op: 'settings', fields: { name: 'Catalog B' } } })
    expect(tool('set-meta-catalog').undo!.request(ran.change)).toEqual({ tool: 'set-meta-catalog', args: { connectionId: 'm-1', why: expect.any(String), action: 'settings', catalogId: CATALOG, name: 'Catalog A' } })
    // An image that was not there before cannot be taken off: said, nothing sent.
    expect(tool('set-meta-catalog').undo!.request({ before: { op: 'settings', catalogId: CATALOG, fields: { defaultImageUrl: null }, noUndo: ['There was no default image before.'] }, after: { op: 'settings', catalogId: CATALOG, fields: { defaultImageUrl: 'https://example.com/a.jpg' } } })).toEqual({ refusal: expect.stringMatching(/no default image before/) })
  })
  it('each action takes only its own arguments; a catalog that is not the business\'s is refused before anything', async () => {
    expect(await preview('set-meta-catalog', { action: 'settings', catalogId: CATALOG, pixelIds: [PIXEL] })).toEqual({ ok: false, error: expect.stringMatching(/settings takes catalogId, name/) })
    expect(await preview('set-meta-catalog', { action: 'settings', catalogId: '120000000000199', name: 'X' })).toEqual({ ok: false, error: expect.stringMatching(/not owned by the chosen ad account's business portfolio/) })
    expect(() => parse('set-meta-catalog', { action: 'settings', catalogId: CATALOG, defaultImageUrl: 'http://example.com/a.jpg' })).toThrow()
  })
  it('pixels: connect only the chosen account\'s; undo of a connect disconnects them; undo of an app\'s disconnect is said', async () => {
    expect(await preview('set-meta-catalog', { action: 'connect-pixels', catalogId: CATALOG, pixelIds: ['120000000000059'] })).toEqual({ ok: false, error: expect.stringMatching(/only pixels of the chosen ad account/) })
    const ran = await run('set-meta-catalog', { action: 'connect-pixels', catalogId: CATALOG, pixelIds: [PIXEL] })
    expect(h.send.mock.calls[0][1]).toMatchObject({ edge: 'external_event_sources', params: { external_event_sources: `["${PIXEL}"]` } })
    expect(tool('set-meta-catalog').undo!.request(ran.change)).toEqual({ tool: 'set-meta-catalog', args: { connectionId: 'm-1', why: expect.any(String), action: 'disconnect-sources', catalogId: CATALOG, sourceIds: [PIXEL] } })
    expect(tool('set-meta-catalog').undo!.request({ before: {}, after: { op: 'disconnect', catalogId: CATALOG, sources: [{ id: '120000000000059', connected: false, pixel: false }] } })).toEqual({ refusal: expect.stringMatching(/Commerce Manager/) })
  })
})

describe('set-meta-catalog-access', () => {
  it('never takes Nexus\'s own system user off; gives a person of the portfolio tasks; undo takes them off again', async () => {
    h.people = new Map([['100000000000009', { id: '100000000000009', name: 'Nexus', userType: 'system_user', tasks: ['MANAGE'] }]])
    expect(await preview('set-meta-catalog-access', { action: 'remove-person', catalogId: CATALOG, userId: '100000000000009' })).toEqual({ ok: false, error: expect.stringMatching(/Nexus's own system user/) })
    const ran = await run('set-meta-catalog-access', { action: 'assign-person', catalogId: CATALOG, userId: '100000000000001', tasks: ['ADVERTISE'] })
    expect(h.send.mock.calls[0][1]).toMatchObject({ edge: 'assigned_users', params: { user: '100000000000001', tasks: '["ADVERTISE"]' } })
    expect(tool('set-meta-catalog-access').undo!.request(ran.change)).toEqual({ tool: 'set-meta-catalog-access', args: { connectionId: 'm-1', why: expect.any(String), catalogId: CATALOG, action: 'remove-person', userId: '100000000000001' } })
  })
  it('a partner: never another Nexus business\'s portfolio; a segment only with MANAGE / ADVERTISE; an unshare has no undo (said)', async () => {
    h.taken.add('120000000000091')
    expect(await preview('set-meta-catalog-access', { action: 'share', catalogId: CATALOG, partnerBusinessId: '120000000000091', permittedTasks: ['ADVERTISE'] })).toEqual({ ok: false, error: expect.stringMatching(/used by another business in Nexus/) })
    h.taken.clear()
    expect(await preview('set-meta-catalog-access', { action: 'share', catalogId: SEGMENT, partnerBusinessId: '120000000000091', permittedTasks: ['AA_ANALYZE'] })).toEqual({ ok: false, error: expect.stringMatching(/MANAGE and \/ or ADVERTISE only/) })
    expect(await preview('set-meta-catalog-access', { action: 'share', catalogId: CATALOG, partnerBusinessId: '120000000000091' })).toEqual({ ok: false, error: expect.stringMatching(/permittedTasks lists/) })
    const ran = await run('set-meta-catalog-access', { action: 'share', catalogId: SEGMENT, partnerBusinessId: '120000000000091', permittedTasks: ['ADVERTISE'], utm: { campaignSource: 'fb' } })
    expect(h.send.mock.calls[0][1]).toMatchObject({ edge: 'agencies', params: { business: '120000000000091', permitted_tasks: '["ADVERTISE"]', utm_settings: '{"campaign_source":"fb"}' } })
    expect(tool('set-meta-catalog-access').undo!.request(ran.change)).toMatchObject({ tool: 'set-meta-catalog-access', args: { action: 'unshare', partnerBusinessId: '120000000000091' } })
    expect(tool('set-meta-catalog-access').undo!.request({ before: {}, after: { op: 'unshare', catalogId: CATALOG, businessId: '120000000000091', shared: false } })).toEqual({ refusal: expect.stringMatching(/cannot read which tasks/) })
  })
})

describe('set-meta-product-set', () => {
  it('create: never an all-items set by accident; the count and the empty-set warning; a price only with revenue view', async () => {
    expect(await preview('set-meta-product-set', { action: 'create', catalogId: CATALOG, name: 'Set B' })).toEqual({ ok: false, error: expect.stringMatching(/say so explicitly/) })
    expect(await preview('set-meta-product-set', { action: 'create', catalogId: CATALOG, name: 'Set B', conditions: [{ field: 'price_amount', op: 'gte', amountMinor: 4990 }] }, noRevenue)).toEqual({ ok: false, error: expect.stringMatching(/only for a person who may see revenue/) })
    h.count = { matchingItems: 0 }
    const p = await preview('set-meta-product-set', { action: 'create', catalogId: CATALOG, name: 'Set B', conditions: [{ field: 'brand', op: 'eq', value: 'Shop B' }] })
    expect(p.preview.warnings.join(' ')).toMatch(/EMPTY.*stop delivering/)
    h.count = { matchingItems: 40 }
    const every = await preview('set-meta-product-set', { action: 'create', catalogId: CATALOG, name: 'All', everyItem: true })
    expect(every.preview.warnings.join(' ')).toMatch(/matches every item of the catalog \(40\)/)
  })
  it('create runs and records the new set; its undo (action undo) deletes only that set', async () => {
    h.send.mockResolvedValueOnce({ node: { id: '120000000000111', name: 'Set B', filter: '{"brand":{"eq":"Shop B"}}', product_count: 3 }, readBack: 'second-read', waitedMs: 0 })
    const ran = await run('set-meta-product-set', { action: 'create', catalogId: CATALOG, name: 'Set B', conditions: [{ field: 'brand', op: 'eq', value: 'Shop B' }] })
    expect(h.send.mock.calls[0][1]).toMatchObject({ edge: 'product_sets', objectId: CATALOG, params: { name: 'Set B', filter: '{"brand":{"eq":"Shop B"}}' } })
    expect(ran.change.after).toMatchObject({ op: 'create', productSetId: '120000000000111', set: { name: 'Set B', filter: '{"brand":{"eq":"Shop B"}}' } })
    expect(tool('set-meta-product-set').undo!.request({ ...ran.change, id: 'chg-2' })).toEqual({ tool: 'set-meta-product-set', args: { connectionId: 'm-1', why: expect.any(String), action: 'undo', undoOf: 'chg-2' } })
    h.records.set('chg-2', { toolName: 'set-meta-product-set', before: ran.change.before, after: { ...ran.change.after }, undoneAt: null })
    h.set = { productSetId: '120000000000111', catalogId: CATALOG, name: 'Set B', filter: '{"brand":{"eq":"Shop B"}}', retailerId: null, productCount: 3, metadata: null }
    const undo = await preview('set-meta-product-set', { action: 'undo', undoOf: 'chg-2' })
    expect(undo.preview.requests).toEqual([{ step: 1, label: 'Delete product set "Set B" (120000000000111)', metaCheck: 'no-check' }])
  })
  it('change: before → after counts and the ad sets it changes; its undo puts the recorded name and filter back', async () => {
    h.users = [{ kind: 'adset', id: '120000000000002', name: 'Ad set B', effectiveStatus: 'ACTIVE', uses: `product set ${SET}` }]
    const p = await preview('set-meta-product-set', { action: 'change', productSetId: SET, name: 'Set C', conditions: [{ field: 'brand', op: 'eq', value: 'Shop C' }] })
    expect(p.preview.changes).toMatchObject({ Name: { from: 'Set A', to: 'Set C' }, 'Items in the set': { from: 12, to: 7 } })
    expect(p.preview.warnings.join(' ')).toMatch(/changes what every live catalog ad on this set shows.*1 delivering now/)
    h.records.set('chg-3', { toolName: 'set-meta-product-set', before: { op: 'change', catalogId: CATALOG, productSetId: SET, set: { name: 'Set Old', filter: '{"product_type":{"i_contains":"jacket"}}', retailerId: null } }, after: { op: 'change', catalogId: CATALOG, productSetId: SET, set: { name: 'Set A', filter: '{"brand":{"eq":"Shop A"}}', retailerId: null } }, undoneAt: null })
    const undo = await preview('set-meta-product-set', { action: 'undo', undoOf: 'chg-3' })
    expect(undo.ok).toBe(true)
    const ran = await tool('set-meta-product-set').execute!(parse('set-meta-product-set', { action: 'undo', undoOf: 'chg-3' }), approved(undo.preview))
    expect(ran.ok).toBe(true)
    expect(h.send.mock.calls.at(-1)![1]).toMatchObject({ objectId: SET, params: { name: 'Set Old', filter: '{"product_type":{"i_contains":"jacket"}}' } })
    expect(JSON.stringify((ran as { data: { steps: unknown[] } }).data.steps)).not.toMatch(/undefined/)
    // A filter-only change: its step says Meta made it (never "reads undefined").
    h.send.mockResolvedValueOnce({ node: { id: SET, name: 'Set A', filter: '{"brand":{"eq":"Shop D"}}', product_count: 2 }, readBack: 'second-read', waitedMs: 0 })
    const filterOnly = await run('set-meta-product-set', { action: 'change', productSetId: SET, conditions: [{ field: 'brand', op: 'eq', value: 'Shop D' }] })
    expect(filterOnly.data.steps[0].sentence).toMatch(/Meta made it/)
    expect(JSON.stringify(filterOnly.data.steps)).not.toMatch(/undefined/)
    // An earlier filter Nexus does not send (another field): refused in words, nothing sent.
    h.records.set('chg-4', { toolName: 'set-meta-product-set', before: { op: 'change', catalogId: CATALOG, productSetId: SET, set: { name: 'Set A', filter: '{"visibility":{"eq":"published"}}', retailerId: null } }, after: { op: 'change', catalogId: CATALOG, productSetId: SET, set: { name: 'Set A', filter: '{"brand":{"eq":"Shop A"}}', retailerId: null } }, undoneAt: null })
    expect(await preview('set-meta-product-set', { action: 'undo', undoOf: 'chg-4' })).toEqual({ ok: false, error: expect.stringMatching(/put it back in Commerce Manager/) })
  })
})

describe('remove-meta-catalog-items', () => {
  it('items on a catalog Shopify feeds: "Shopify owns these items: remove them in Shopify"; nothing sent', async () => {
    h.refuseItems = 'Shopify owns these items: remove them in Shopify. Shopify writes its items; Nexus must not write items here (D7).'
    expect(await preview('remove-meta-catalog-items', { kind: 'items', catalogId: CATALOG, retailerIds: ['SKU-A'], confirmDelete: true })).toEqual({ ok: false, error: expect.stringMatching(/^Shopify owns these items: remove them in Shopify/) })
    expect(await preview('remove-meta-catalog-items', { kind: 'catalog', catalogId: CATALOG, confirmDelete: true })).toEqual({ ok: false, error: expect.stringMatching(/^Shopify owns these items/) })
    expect(h.send).not.toHaveBeenCalled()
  })
  it('items: the run sends one items_batch of DELETEs of the SKUs found, reads Meta\'s batch status, and records no undo', async () => {
    h.send.mockResolvedValueOnce({ node: { handles: ['h-1'], validation_status: [] }, readBack: 'none', waitedMs: 0 })
    h.batch.mockResolvedValueOnce({ items: [{ status: 'finished', errorsTotal: 0 }] })
    const ran = await run('remove-meta-catalog-items', { kind: 'items', catalogId: CATALOG, retailerIds: ['SKU-A', 'SKU-B'], confirmDelete: true })
    expect(h.writable.mock.calls.filter((c) => c[2] === 'items')).toHaveLength(2)
    expect(h.send.mock.calls[0][1]).toMatchObject({ edge: 'items_batch', params: { item_type: 'PRODUCT_ITEM', requests: '[{"method":"DELETE","data":{"id":"SKU-A"}}]', allow_upsert: 'false' } })
    expect(ran.data).toMatchObject({ batch: { handle: 'h-1' }, nexusRead: expect.stringMatching(/Meta's batch h-1: finished/) })
    expect(h.batch).toHaveBeenCalledWith(expect.objectContaining({ view: 'batch-status', catalogId: CATALOG, handle: 'h-1' }))
  })
  it('a set: the live flag only when asked; a catalog\'s own sets and ad sets are in the preview', async () => {
    h.users = [{ kind: 'adset', id: '120000000000002', name: 'Ad set B', effectiveStatus: 'ACTIVE', uses: `product set ${SET}` }]
    const plain = await preview('remove-meta-catalog-items', { kind: 'product-set', productSetId: SET, confirmDelete: true })
    expect(plain.preview.warnings.join(' ')).toMatch(/Meta refuses this delete while an active ad or a shop collection uses the set/)
    await run('remove-meta-catalog-items', { kind: 'product-set', productSetId: SET, alsoLive: true, confirmDelete: true })
    expect(h.send.mock.calls[0][1]).toMatchObject({ method: 'DELETE', objectId: SET, kind: 'productset', params: { allow_live_product_set_deletion: 'true' } })
    expect(await preview('remove-meta-catalog-items', { kind: 'items', catalogId: CATALOG, retailerIds: ['SKU-A'], alsoLive: true, confirmDelete: true })).toEqual({ ok: false, error: expect.stringMatching(/items takes catalogId, retailerIds/) })
  })
  it('a feed: a Shopify, partner or primary feed is never deleted; a supplementary plain one goes with its catalog named', async () => {
    h.writer = { evidence: [{ from: 'feed', id: '120000000000130', kind: 'shopify', supplementary: false, detail: 'A feed fetched from Shopify.' }] }
    expect(await preview('remove-meta-catalog-items', { kind: 'feed', catalogId: CATALOG, feedId: '120000000000130', confirmDelete: true })).toEqual({ ok: false, error: 'Shopify owns this feed: remove it in Shopify.' })
    h.writer = { evidence: [] }
    h.feed = { ...h.feed, supplementary: false }
    expect(await preview('remove-meta-catalog-items', { kind: 'feed', catalogId: CATALOG, feedId: '120000000000130', confirmDelete: true })).toEqual({ ok: false, error: expect.stringMatching(/primary feed.*D7/) })
    h.feed = { ...h.feed, supplementary: true }
    await run('remove-meta-catalog-items', { kind: 'feed', catalogId: CATALOG, feedId: '120000000000130', confirmDelete: true })
    expect(h.send.mock.calls[0][1]).toMatchObject({ method: 'DELETE', kind: 'productfeed', objectId: '120000000000130', parent: { kind: 'catalog', id: CATALOG } })
  })
})

describe('review fixes, round 1', () => {
  it('A1 — a set change approved while nothing delivered does not run once something delivers (the spend premise is in stands)', async () => {
    h.users = [{ kind: 'ad', id: '120000000000020', name: 'Ad A', effectiveStatus: 'PAUSED', uses: `product set ${SET}` }]
    h.count = { matchingItems: 30, current: { itemsNow: 12 } }
    const args = { action: 'change', productSetId: SET, conditions: [{ field: 'brand', op: 'eq', value: 'Shop B' }] }
    const p = await preview('set-meta-product-set', args)
    expect(p.preview.spendsMoney).toBe(false)
    h.users = [{ kind: 'ad', id: '120000000000020', name: 'Ad A', effectiveStatus: 'ACTIVE', uses: `product set ${SET}` }]
    const ran = await tool('set-meta-product-set').execute!(parse('set-meta-product-set', args), approved(p.preview))
    expect(ran).toMatchObject({ ok: false, error: expect.stringMatching(/changed since this was approved/) })
    expect(h.send).not.toHaveBeenCalled()
    // And now it says SPENDS MONEY: an ad (its creative names the set) delivers.
    expect((await preview('set-meta-product-set', args)).preview).toMatchObject({ spendsMoney: true, spendsMoneyBecause: [expect.stringMatching(/ad 120000000000020/)] })
  })
  it('B1 / A5 — what Nexus could not see counts as spending, in words (a default image on a catalog)', async () => {
    h.unseen = ['more than 500 ads of the ad account (Nexus read the first 500)']
    const p = await preview('set-meta-catalog', { action: 'settings', catalogId: CATALOG, defaultImageUrl: 'https://example.com/d.jpg' })
    expect(p.preview).toMatchObject({ spendsMoney: true, spendsMoneyBecause: [expect.stringMatching(/Not seen by Nexus, so counted as spending: more than 500 ads/)] })
  })
  it('A2 — any change of Nexus\'s own system user is refused, an assign too; unknown own id = refused', async () => {
    h.portfolioPeople = new Map([['100000000000009', { name: 'Nexus', kind: 'system user' }]])
    expect(await preview('set-meta-catalog-access', { action: 'assign-person', catalogId: CATALOG, userId: '100000000000009', tasks: ['ADVERTISE'] })).toEqual({ ok: false, error: expect.stringMatching(/never changes its own access/) })
    h.me = null
    expect(await preview('set-meta-catalog-access', { action: 'assign-person', catalogId: CATALOG, userId: '100000000000001', tasks: ['ADVERTISE'] })).toEqual({ ok: false, error: expect.stringMatching(/could not read which system user it is/) })
    expect(h.send).not.toHaveBeenCalled()
  })
  it('A4 — the access record keeps the tasks Meta reads right after; the undo\'s current() compares tasks too', async () => {
    h.send.mockImplementationOnce(async () => {
      h.people = new Map([['100000000000001', { id: '100000000000001', name: 'Person A', userType: 'person', tasks: ['AA_ANALYZE', 'ADVERTISE'] }]])
      return { node: { success: true }, readBack: 'none', waitedMs: 0 }
    })
    const ran = await run('set-meta-catalog-access', { action: 'assign-person', catalogId: CATALOG, userId: '100000000000001', tasks: ['ADVERTISE'] })
    expect(ran.change.after).toMatchObject({ op: 'assign', assigned: true, tasks: ['AA_ANALYZE', 'ADVERTISE'] })
    expect(await tool('set-meta-catalog-access').undo!.current(ran.change)).toEqual(ran.change.after)
    h.people = new Map([['100000000000001', { id: '100000000000001', name: 'Person A', userType: 'person', tasks: ['MANAGE'] }]])
    expect(await tool('set-meta-catalog-access').undo!.current(ran.change)).toMatchObject({ tasks: ['MANAGE'] })
  })
  it('N3 — when Meta\'s list has not caught up right after the change, the record keeps what was sent and says so', async () => {
    const ran = await run('set-meta-catalog-access', { action: 'assign-person', catalogId: CATALOG, userId: '100000000000001', tasks: ['ADVERTISE'] })
    expect(ran.change.after).toMatchObject({ op: 'assign', assigned: true, tasks: ['ADVERTISE'] })
    expect(ran.data.nexusRead).toMatch(/had not caught up.*did not list 100000000000001.*keeps what it sent/)
    h.people = new Map([['100000000000001', { id: '100000000000001', name: 'Person A', userType: 'person', tasks: ['ADVERTISE'] }]])
    const removed = await run('set-meta-catalog-access', { action: 'remove-person', catalogId: CATALOG, userId: '100000000000001' })
    expect(removed.change.after).toMatchObject({ op: 'remove', assigned: false, tasks: null })
    expect(removed.data.nexusRead).toMatch(/still listed 100000000000001/)
  })
  it('(a) — an ad set with custom audiences that switches on after approval moves the spend premise: the run is refused', async () => {
    h.count = { matchingItems: 30, current: { itemsNow: 12 } }
    const args = { action: 'change', productSetId: SET, conditions: [{ field: 'brand', op: 'eq', value: 'Shop B' }] }
    // Paused with audiences: liveCatalogUsers adds no line (live-catalog-admin test), so nothing is unseen here.
    const p = await preview('set-meta-product-set', args)
    expect(p.preview.spendsMoney).toBe(false)
    // Switched on: liveCatalogUsers now adds AUDIENCES_UNSEEN.
    h.unseen = [AUDIENCES_UNSEEN]
    const ran = await tool('set-meta-product-set').execute!(parse('set-meta-product-set', args), approved(p.preview))
    expect(ran).toMatchObject({ ok: false, error: expect.stringMatching(/changed since this was approved/) })
    expect(h.send).not.toHaveBeenCalled()
  })
  it('(b) — a catalog\'s delete asks what uses it with the SDK-only places of its sets said', async () => {
    await preview('remove-meta-catalog-items', { kind: 'catalog', catalogId: CATALOG, confirmDelete: true })
    expect(h.usersCalls.at(-1)).toEqual({ catalogId: CATALOG, setIds: [SET], setsMore: false, forSetDelete: true })
    await preview('set-meta-catalog', { action: 'settings', catalogId: CATALOG, name: 'Catalog Z' })
    expect(h.usersCalls.at(-1)).toMatchObject({ catalogId: CATALOG, forSetDelete: false })
  })
  it('N1 — a set\'s delete asks what uses the set with the SDK-only places said', async () => {
    await preview('remove-meta-catalog-items', { kind: 'product-set', productSetId: SET, confirmDelete: true })
    expect(h.usersCalls.at(-1)).toEqual({ setIds: [SET], forSetDelete: true })
    await preview('set-meta-product-set', { action: 'change', productSetId: SET, name: 'Set Z' })
    expect(h.usersCalls.at(-1)).toEqual({ setIds: [SET], forSetDelete: false })
  })
  it('A3 — a catalog\'s delete takes the writer check with the items purpose (a segment holds no items of its own)', async () => {
    await preview('remove-meta-catalog-items', { kind: 'catalog', catalogId: CATALOG, confirmDelete: true })
    expect(h.writable.mock.calls.map((c) => c[2])).toEqual(['settings', 'items'])
    h.writable.mockClear()
    await preview('remove-meta-catalog-items', { kind: 'catalog', catalogId: SEGMENT, confirmDelete: true })
    expect(h.writable.mock.calls.map((c) => c[2])).toEqual(['settings'])
  })
  it('B2 — taking a set out of every shop is not offered (undocumented): refused in words', async () => {
    expect(await preview('set-meta-product-set', { action: 'change', productSetId: SET, unpublishFromShops: true })).toEqual({ ok: false, error: 'Meta documents no way to take a set out of every shop; do it in Commerce Manager.' })
  })
  it('B4 — the CT-177 answer names what Meta documents', () => {
    expect(AI_BACKGROUNDS_NOT_BUILT).toBe('Meta documents no body for it: no page says what `data` holds; the SDK only types it list<Object>. AI backgrounds are a per-creative opt-in (`degrees_of_freedom_spec.creative_features_spec.image_background_gen.enroll_status=OPT_IN`, step 25), only for catalog ads on Mobile Feed.')
  })
})

describe('registration', () => {
  it('every tool is registered once in the tool registry', async () => {
    const { listTools } = await import('../tool-registry.js')
    const names = listTools().map((t: AgentTool) => t.name)
    for (const t of META_ADS_CATALOG_ADMIN_TOOLS) expect(names.filter((n: string) => n === t.name), t.name).toHaveLength(1)
  })
})
