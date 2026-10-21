/**
 * MCP full control T11 (docs/mcp-full-control/sections/03-content.md §6 step 11, phase 2) — content on the channel
 * itself, through the doors a person and Claude use (callTool, runOrQueueTool, the Approvals commit), on PostgreSQL with
 * the production schema (PGlite). The Shopify sheet's live read and writer, and the channel live read, are stood in for
 * at the module boundary: channel logins are sealed with the production key, so no local test can reach a store.
 *
 *   shopify-content      the store's text and attribute fields per row (price and other offer fields left out), the
 *                        Nexus draft values, never a write token; a cold store field list is said ("missing, not empty")
 *   set-shopify-content  preview from → to with the English meaning; approved, the Shopify sheet's writer receives the
 *                        cell's own owner, token and baseline (looked up again on the server) and the approver; refused
 *                        when the store field list is cold, for the title (shared text), a field that cannot be edited,
 *                        a value the store's definition refuses, a listing setting; a partial save says what saved; undo
 *   listing-live-content the listing's account found from Nexus, the read without the provider's raw documents
 *   Etsy                 (E5b) listing-live-content reads the Etsy listing with the Etsy account Nexus holds;
 *                        product-content reads the Etsy sheet; set-listing-content is not refused for Etsy (its own
 *                        suite runs it on the real sheet); Shopify: its own title and description only (its suite
 *                        runs them), the store fields answered in words
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
// As db.ts wraps it: inside a transaction, `prisma.x` is that transaction's client.
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property) }) }
})
vi.mock('../../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))
vi.mock('../../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
// The Shopify scope of the product sheet reads the store live, and its writer checks against the store: both are
// stood in for here (channel logins are sealed with the production key), at the module boundary the tools call.
const shop = vi.hoisted(() => ({
  schemaMissing: [] as string[],
  // stored: what Shopify itself holds (the writer's baseline, and what a reset gives back); default 'Store value'.
  cells: {} as Record<string, { value: unknown; nexusDraft: boolean; stored?: string }>,
  token: 1,
  saves: [] as Array<{ productId: string; scope: Record<string, unknown>; body: any; actor: string | null }>,
  refuse: null as null | string,
  sheetCalls: [] as Array<Record<string, unknown>>,
  sheet: null as null | ((input: any) => any),
  // Meta ads step 44 — the store's sales channels, as Nexus's copy of its field list names them.
  publications: undefined as undefined | Array<{ id: string; name: string; supportsFuturePublishing: boolean }>,
}))
vi.mock('../../pim/information-sheet.js', () => ({ getInformationSheet: async (input: any) => { shop.sheetCalls.push(input); return shop.sheet!(input) } }))
vi.mock('../../pim/channel-specs/shopify.js', async (importActual) => ({
  ...(await importActual<typeof import('../../pim/channel-specs/shopify.js')>()),
  readShopifyDisplaySchema: async () => ({ definitions: [], metaobjectDefinitions: [], locales: [], types: [], revision: 'r1', ...(shop.publications ? { publications: shop.publications } : {}) }),
}))
vi.mock('../../shopify/channel-sheet.service.js', () => ({
  saveShopifySheetCells: async (productId: string, scope: Record<string, unknown>, body: any, actor: string | null) => {
    shop.saves.push({ productId, scope, body, actor })
    const cells: Record<string, { ok: boolean; reason?: string }> = {}
    for (const cell of body.cells) {
      const key = cell.receiptKey ?? cell.colId
      if (shop.refuse && cell.fieldId === shop.refuse) { cells[key] = { ok: false, reason: 'Shopify changed this value since it was read.' }; continue }
      const was = shop.cells[cell.fieldId]
      shop.cells[cell.fieldId] = cell.intent === 'reset' ? { ...was, value: was?.stored ?? 'Store value', nexusDraft: false } : { ...was, value: cell.value, nexusDraft: true }
      shop.token++
      cells[key] = { ok: true }
    }
    return { ok: Object.values(cells).every((c) => c.ok), cells, listing: { id: 'listing', version: 2 } }
  },
}))
const live = vi.hoisted(() => ({ reads: [] as Array<{ productId: string; scope: Record<string, unknown> }> }))
vi.mock('../../live-read/index.js', () => ({
  readLiveListing: async (productId: string, scope: Record<string, unknown>) => {
    live.reads.push({ productId, scope })
    return { readAt: '2026-10-01T12:00:00.000Z', source: 'ebay-trading-item', destination: { productId, ...scope }, revision: 'rev-1',
      content: { title: { value: 'Giacca sul canale' } }, variations: null, errors: [], raw: { secretProviderDocument: true }, cached: false }
  },
  publicLiveRead: (read: Record<string, unknown>) => { const { raw: _raw, ...rest } = read; return rest },
}))
vi.mock('../../pim/readiness-index.service.js', async () => (await import('../../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))

import { callTool, ToolAccessError, type UserPrincipal } from '../call-tool.js'
import { runOrQueueTool } from '../approval-gate.service.js'
import { checkStaleness, commitScheduledApproval, MATERIAL_PREVIEW_FIELDS, scheduleApproval } from '../../agent-fleet/approval-inbox.service.js'
import { getTool } from '../tool-registry.js'

const A = LEGACY_WORKSPACE_ID
const business = { workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const EVERYTHING = new Set<string>([...Object.values(F), ...Object.values(FIELDS)])
let approverId = ''
const person = (permissions: Set<string>): UserPrincipal => ({
  kind: 'user', userId: approverId, label: 'Content approver', permissions: { isOwner: false, permissions }, workspace: business, via: 'claude',
})
const ALL = () => person(EVERYTHING)

type Data = Record<string, any>
const db = () => database.client
const accounts = { amazon: '', ebay: '' }

async function ask(tool: string, args: Record<string, unknown>, who = ALL()) {
  const run = await inside(() => db().agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'running', userId: approverId, via: 'claude' } }))
  return inside(() => runOrQueueTool(tool, args, who, run.id, { forceAsk: true })) as Promise<{ ok: boolean; mode?: string; approvalId?: string; preview?: Data; error?: string }>
}
async function queued(args: Record<string, unknown>) {
  const out = await ask('set-shopify-content', args)
  expect(out, out.error).toMatchObject({ ok: true, mode: 'queued' })
  return out as { approvalId: string; preview: Data }
}
async function approveAndRun(approvalId: string) {
  const parked = await inside(() => scheduleApproval({ id: approvalId, actor: { ...ALL(), via: 'app' } }))
  expect(parked, parked.error).toMatchObject({ ok: true, status: 'scheduled' })
  await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inside(() => commitScheduledApproval(approvalId))
}
async function preview(args: Record<string, unknown>, tool = 'set-shopify-content', who = ALL()) {
  return (await inside(() => callTool(who, tool, args))).visible as { ok: boolean; error?: string; preview?: Data }
}
const productOf = (id: string) => inside(() => db().product.findUniqueOrThrow({ where: { id }, include: { translations: true } }))
const german = async (id: string) => (await productOf(id)).translations.find((row) => row.language === 'de')
const queueRows = (ids: string[]) => inside(() => db().outboundSyncQueue.count({ where: { productId: { in: ids } } }))
const getToolInput = () => getTool('set-shopify-content')!.input


const STORE_PRODUCT = 'gid://shopify/Product/9001'
const column = (key: string, label: string, info: Record<string, unknown>) => ({
  key, label, writeField: `attr_${key}`, group: 'General', groupKey: 'SHOPIFY:general', kind: 'text', storage: 'listing', scope: 'global',
  requiredBy: [], editable: true, defaultVisible: true, shopifyField: { id: key, label, owner: 'PRODUCT', source: null, width: 160, editor: 'scalar',
    cardinality: 'scalar', sortable: true, filterable: true, permission: 'products.edit', discovery: 'adapter', type: 'single_line_text_field', ...info },
})
const COLUMNS = [
  column('title', 'Title', {}),
  column('vendor', 'Vendor', {}),
  column('tags', 'Tags', { type: 'list.single_line_text_field' }),
  column('price', 'Price', { type: 'money', currency: 'EUR' }),
  column('metafield:PRODUCT:custom.pockets', 'Pockets', { discovery: 'definition', type: 'number_integer', definition: { id: 'def-1', ownerType: 'PRODUCT', namespace: 'custom', key: 'pockets', name: 'Pockets', type: 'number_integer', validations: [], access: {} } }),
  // Meta ads step 44 — the store's Sales channels (made-up publication ids).
  column('salesChannels', 'Sales channels', { type: 'publication', group: 'Publishing' }),
  // Step 44 review — the product's own Shopify status (only an active product reaches the Meta catalog).
  column('status', 'Status', { type: 'status' }),
]
const ONLINE = 'gid://shopify/Publication/1001'
const FB_IG = 'gid://shopify/Publication/1002'
const POS = 'gid://shopify/Publication/1003'
const STORE_CHANNELS = [
  { id: ONLINE, name: 'Online Store', supportsFuturePublishing: true },
  { id: FB_IG, name: 'Facebook & Instagram', supportsFuturePublishing: false },
  { id: POS, name: 'Point of Sale', supportsFuturePublishing: false },
]
let family = { id: '', sku: '' }
function shopifySheet(input: { productId: string }) {
  const values: Record<string, unknown> = {}
  for (const c of COLUMNS) {
    const state = shop.cells[c.key] ?? { value: null, nexusDraft: false }
    if (c.key === 'title') {
      values.title = { value: 'Giacca', layer: 'master', editable: true, writable: true, writeBlockedReason: null, tier: 'source', language: 'en',
        contentAcknowledgement: { shared: { label: 'shared', address: { tier: 'source' } }, pin: { label: 'pin', address: { tier: 'source' } }, reach: [] }, writeField: 'name' }
      continue
    }
    if (c.key === 'tags') { values.tags = { value: ['moto'], layer: 'channel', editable: false, writable: false, writeBlockedReason: 'Tags are set by the store\'s automation.' }; continue }
    values[c.key] = { value: state.value, nexusDraft: state.nexusDraft, layer: state.nexusDraft ? 'channel' : 'master', editable: true, writable: true, writeBlockedReason: null,
      writeField: c.writeField, writeTarget: 'channelListing', shopifyWrite: { ownerId: STORE_PRODUCT, fieldId: c.key, token: `token-${shop.token}`, baseline: state.stored ?? 'Store value' } }
  }
  return {
    scope: { kind: 'channel', channel: 'SHOPIFY', marketplace: 'GLOBAL', label: 'Shopify · GLOBAL', connectionId: 'store-account', locale: 'en' },
    family: { id: family.id, sku: family.sku, name: 'Giacca', productType: null, variationAxes: [], axes: [] },
    columns: COLUMNS, groups: [], aliases: [],
    rows: [{ id: family.id, sku: family.sku, name: 'Giacca', parentId: null, isParent: false, productRole: 'standalone', rowKind: 'parent', status: 'ACTIVE', productType: null,
      aliasId: null, values, listing: { id: 'listing', version: 1, listingStatus: 'ACTIVE', isPublished: true },
      readiness: { state: 'ready', issues: [] }, completeness: { overall: { filled: 0, total: 0, pct: 0 }, required: { filled: 0, total: 0, missing: [] }, optional: { filled: 0, total: 0, missing: [] }, byGroup: [] } }],
    meta: { schemaMissing: shop.schemaMissing, schemaAge: [], droppedKeys: [], availableMarkets: [], coverage: [], tookMs: 0, mapping: null },
    counts: {}, schema: { marketplace: 'GLOBAL', locale: 'en' }, _for: input.productId,
  }
}

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  const role = await db().role.create({ data: { key: `T11_EDITOR_${randomUUID().slice(0, 8)}`, name: 'Editor', description: 'test', isSystem: false, permissions: [...EVERYTHING] } })
  const user = await db().userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Content approver' } })
  approverId = user.id
  await db().userRole.create({ data: { userId: user.id, roleId: role.id } })
  const membership = await db().workspaceMembership.create({ data: { workspaceId: A, userId: user.id, status: 'active' } })
  await db().workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  await inside(async () => {
    accounts.ebay = (await db().channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 't11-ebay', isActive: true, isPrimary: true, externalAccountId: 'EBAY-TEST-T11' } as never })).id
    const p = await db().product.create({ data: { sku: 'TEST-SKU-T11', name: 'Giacca', basePrice: '10.00' } })
    family = { id: p.id, sku: p.sku }
    await db().channelListing.create({ data: { productId: p.id, channel: 'EBAY', marketplace: 'IT', region: 'EU', channelMarket: 'EBAY_IT', channelConnectionId: accounts.ebay, aliasKey: '',
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'FIXTURE-T11', syncPaused: false } as never })
    // Its Shopify listing, in the store account the sheet stand-in reports.
    const store = await db().channelConnection.create({ data: { id: 'store-account', channelType: 'SHOPIFY', accountLabel: 't11-shop', isActive: true, isPrimary: true, externalAccountId: 'SHOP-TEST-T11' } as never })
    await db().channelListing.create({ data: { productId: p.id, channel: 'SHOPIFY', marketplace: 'GLOBAL', region: 'GLOBAL', channelMarket: 'SHOPIFY_GLOBAL', channelConnectionId: store.id, aliasKey: '',
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: STORE_PRODUCT, syncPaused: false } as never })
    // A second product, not on Shopify: answered in words, with no read of the store.
    await db().product.create({ data: { sku: 'TEST-SKU-T11-NOSHOP', name: 'Guanti', basePrice: '10.00' } })
  })
  shop.sheet = shopifySheet
}, 120_000)

beforeEach(() => {
  shop.schemaMissing = []
  const storeChannels = JSON.stringify([{ publicationId: ONLINE, publishDate: null }, { publicationId: POS, publishDate: null }])
  shop.cells = { vendor: { value: 'Store value', nexusDraft: false }, 'metafield:PRODUCT:custom.pockets': { value: '2', nexusDraft: false },
    salesChannels: { value: storeChannels, nexusDraft: false, stored: storeChannels }, status: { value: 'ACTIVE', nexusDraft: false } }
  shop.publications = STORE_CHANNELS
  shop.saves = []
  shop.refuse = null
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

const read = async (tool: string, args: Record<string, unknown>) => {
  const out = await preview(args, tool)
  expect(out.ok, out.error).toBe(true)
  return (out as { data?: Data }).data!
}

describe('shopify-content', { timeout: 30_000 }, () => {
  it("the store's text and attribute fields, the Nexus drafts; no offer field, no write token", async () => {
    shop.cells.vendor = { value: 'Draft vendor', nexusDraft: true }
    const data = await read('shopify-content', { product: family.sku })
    expect(data).toMatchObject({ store: 'Shopify · GLOBAL', accountId: 'store-account', storeFieldsLoaded: true })
    expect(data.fields.map((f: Data) => f.field)).toEqual(['title', 'vendor', 'tags', 'metafield:PRODUCT:custom.pockets'])
    expect(data.rows[0].cells).toMatchObject({
      vendor: { value: 'Draft vendor', nexusDraft: true },
      tags: { editable: false, blockedReason: "Tags are set by the store's automation." },
      'metafield:PRODUCT:custom.pockets': { value: '2' },
    })
    const text = JSON.stringify(data)
    expect(text).not.toMatch(/token-|shopifyWrite|writeField|contentAddress|"price"/)
  })

  // W3-6 — the real sheet keys Shopify's vendor column by the Shared field it links to (`brand`) and heads it "Vendor"
  // (was "Brand"); "Brand" and "Vendor" both still name it.
  it('"Brand" and "Vendor" both name the vendor, keyed as the sheet keys it', async () => {
    const asTheSheetKeysIt = (input: { productId: string }) => {
      const sheet = shopifySheet(input)
      const rekey = (key: string) => key === 'vendor' ? 'brand' : key
      return { ...sheet, columns: sheet.columns.map(c => c.key === 'vendor' ? { ...c, key: 'brand', writeField: 'attr_brand' } : c),
        rows: sheet.rows.map(row => ({ ...row, values: Object.fromEntries(Object.entries(row.values).map(([key, value]) => [rekey(key), value])) })) }
    }
    shop.sheet = asTheSheetKeysIt
    try {
      for (const name of ['Brand', 'Vendor']) {
        const data = await read('shopify-content', { product: family.sku, fields: [name] })
        expect(data.fields.map((f: Data) => f.field), name).toEqual(['vendor'])
      }
    } finally { shop.sheet = shopifySheet }
  })

  it('a product with no Shopify listing is answered without reading the store', async () => {
    const calls = shop.sheetCalls.length
    expect(await preview({ product: 'TEST-SKU-T11-NOSHOP' }, 'shopify-content')).toEqual({ ok: false, error: 'TEST-SKU-T11-NOSHOP has no Shopify listing yet: create the listing first.' })
    expect(await preview({ product: 'TEST-SKU-T11-NOSHOP', fields: { vendor: 'x' } })).toMatchObject({ ok: false, error: expect.stringMatching(/has no Shopify listing yet/) })
    expect(shop.sheetCalls.length).toBe(calls)
  })

  it('a cold store field list is said: the metafields are missing, not empty', async () => {
    shop.schemaMissing = ['SHOPIFY:*']
    const data = await read('shopify-content', { product: family.id })
    expect(data).toMatchObject({ storeFieldsLoaded: false, storeFieldsNote: expect.stringMatching(/missing here, not empty/) })
  })
})

describe('set-shopify-content', { timeout: 30_000 }, () => {
  it('approved: the Shopify writer gets the cell\'s own owner, token and baseline, and the approver; nothing else is written', async () => {
    const { approvalId, preview: p } = await queued({ product: family.sku, fields: { vendor: 'Xavia', 'Pockets': '4' }, englishMeaning: { vendor: 'Xavia (a brand name)' } })
    expect(p).toMatchObject({
      action: 'set-shopify-content', listing: 'Shopify · TEST-SKU-T11', language: 'en',
      changes: { vendor: { from: 'Store value', to: 'Xavia', englishMeaning: 'Xavia (a brand name)' }, 'metafield:PRODUCT:custom.pockets': { from: '2', to: '4' } },
      reach: { listing: 'Shopify · TEST-SKU-T11', status: 'ACTIVE', otherListingsChange: false }, basis: expect.any(String),
    })
    expect(shop.saves).toHaveLength(0)
    expect(await inside(() => checkStaleness(approvalId))).toEqual({ stale: false, why: null })
    expect(await approveAndRun(approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect(shop.saves).toHaveLength(1)
    expect(shop.saves[0]).toMatchObject({
      productId: family.id, actor: approverId, scope: { accountId: 'store-account', market: 'GLOBAL', locale: 'en' },
      body: { cells: [
        { colId: 'metafield:PRODUCT:custom.pockets', receiptKey: 'metafield:PRODUCT:custom.pockets', ownerId: STORE_PRODUCT, fieldId: 'metafield:PRODUCT:custom.pockets', token: 'token-1', baseline: 'Store value', value: '4', intent: 'set' },
        { colId: 'vendor', receiptKey: 'vendor', ownerId: STORE_PRODUCT, fieldId: 'vendor', token: 'token-1', baseline: 'Store value', value: 'Xavia', intent: 'set' },
      ] },
    })
    expect(await inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId } }))).toMatchObject({
      toolName: 'set-shopify-content', before: { fields: { vendor: { value: 'Store value', nexusDraft: false } } }, after: { fields: { vendor: { value: 'Xavia', nexusDraft: true } } },
    })
  })

  it('stale when the store or the draft moved after the preview', async () => {
    const { approvalId } = await queued({ product: family.id, fields: { vendor: 'Xavia' }, englishMeaning: { vendor: 'Xavia' } })
    shop.token++
    expect((await inside(() => checkStaleness(approvalId))).stale).toBe(true)
  })

  it('refused: a cold store field list, the title (shared text), a field that cannot be edited, a value the store refuses, a listing setting', async () => {
    shop.schemaMissing = ['SHOPIFY:*']
    expect(await preview({ product: family.id, fields: { vendor: 'Xavia' } })).toMatchObject({ ok: false, error: expect.stringMatching(/A write is refused until it is loaded/) })
    shop.schemaMissing = []
    expect(await preview({ product: family.id, fields: { title: 'Jacket' } })).toMatchObject({ ok: false, error: expect.stringMatching(/title: the listing's title and description are text — this listing's own with set-listing-content \(SHOPIFY, GLOBAL\), the shared text with set-content/) })
    expect(await preview({ product: family.id, fields: { tags: '["a"]' } })).toMatchObject({ ok: false, error: expect.stringMatching(/tags: Tags are set by the store's automation/) })
    expect(await preview({ product: family.id, fields: { Pockets: 'many' } })).toMatchObject({ ok: false, error: expect.stringMatching(/metafield:PRODUCT:custom.pockets|Pockets/) })
    expect(await preview({ product: family.id, fields: { price: '10' } })).toMatchObject({ ok: false, error: expect.stringMatching(/price: a listing setting/) })
    expect(shop.saves).toHaveLength(0)
  })

  it('a partial save says what saved; undo drops the draft it added', async () => {
    shop.refuse = 'metafield:PRODUCT:custom.pockets'
    const { approvalId } = await queued({ product: family.id, fields: { vendor: 'Xavia', Pockets: '5' }, englishMeaning: { vendor: 'Xavia' } })
    const ran = await approveAndRun(approvalId)
    expect(ran).toMatchObject({ ok: true, status: 'executed' })
    expect(await inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId } }))).toMatchObject({ before: { fields: { vendor: { nexusDraft: false } } } })
    const change = await inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId } }))
    expect(Object.keys((change.before as Data).fields)).toEqual(['vendor'])
    shop.refuse = null
    const undo = await ask('undo-change', { approvalId })
    expect(undo, undo.error).toMatchObject({ ok: true, mode: 'queued' })
    expect(await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: undo.approvalId! } }))).toMatchObject({ toolName: 'set-shopify-content', args: { product: family.id, reset: ['vendor'] } })
    expect(await approveAndRun(undo.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect(shop.cells.vendor).toEqual({ value: 'Store value', nexusDraft: false })
  })
})

describe('Meta ads step 44 — set-shopify-content facebookInstagram: the Shopify-fed Meta catalog (master CT-193)', { timeout: 30_000 }, () => {
  it('publish: only the Facebook & Instagram publication is added to the draft\'s Sales channels, by name in the preview; approved, the writer gets the cell; undo takes it out again', async () => {
    const { approvalId, preview: p } = await queued({ product: family.sku, facebookInstagram: 'publish' })
    expect(p).toMatchObject({
      action: 'set-shopify-content', listing: 'Shopify · TEST-SKU-T11',
      changes: { salesChannels: { from: ['Online Store', 'Point of Sale'], to: ['Online Store', 'Facebook & Instagram', 'Point of Sale'] } },
      facebookInstagram: { op: 'publish', channel: 'Facebook & Instagram', publicationId: FB_IG },
      note: expect.stringMatching(/Review and synchronize.*Only the "Facebook & Instagram" sales channel is added; every other channel stays as it is.*Meta catalog/),
    })
    // An active product: no word about its status.
    expect(p.note).not.toMatch(/until it is active|Only an active/)
    expect(shop.saves).toHaveLength(0)
    expect(await inside(() => checkStaleness(approvalId))).toEqual({ stale: false, why: null })
    expect(await approveAndRun(approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect(shop.saves).toHaveLength(1)
    expect(shop.saves[0].body.cells).toEqual([{
      colId: 'salesChannels', receiptKey: 'salesChannels', ownerId: STORE_PRODUCT, fieldId: 'salesChannels', token: expect.stringMatching(/^token-\d+$/), baseline: shop.cells.salesChannels.stored,
      value: JSON.stringify([{ publicationId: ONLINE, publishDate: null }, { publicationId: FB_IG, publishDate: null }, { publicationId: POS, publishDate: null }]), intent: 'set',
    }])
    const change = await inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId } }))
    expect(change).toMatchObject({ toolName: 'set-shopify-content', before: { facebookInstagram: 'publish', fields: { salesChannels: { nexusDraft: false } } }, after: { facebookInstagram: 'publish', fields: { salesChannels: { nexusDraft: true } } } })
    // Undo: the other way, that publication only. Review fix — there was no draft before, so the draft is dropped again
    // (the sheet's reset), never written as a draft equal to Shopify's own list.
    const undo = await ask('undo-change', { approvalId })
    expect(undo, undo.error).toMatchObject({ ok: true, mode: 'queued' })
    expect(await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: undo.approvalId! } }))).toMatchObject({ toolName: 'set-shopify-content', args: { product: family.id, facebookInstagram: 'unpublish', reset: ['salesChannels'] } })
    expect(await approveAndRun(undo.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect(shop.saves.at(-1)!.body.cells).toEqual([expect.objectContaining({ fieldId: 'salesChannels', intent: 'reset', value: null })])
    expect(shop.cells.salesChannels).toMatchObject({ nexusDraft: false })
    expect(JSON.parse(String(shop.cells.salesChannels.value))).toEqual([{ publicationId: ONLINE, publishDate: null }, { publicationId: POS, publishDate: null }])
  })

  it('review fix — undo where the Sales channels already held a draft: that draft again, the channel taken back out', async () => {
    // A person's own draft took the Point of Sale channel away; Claude adds Facebook & Instagram on top of it.
    shop.cells.salesChannels = { ...shop.cells.salesChannels, value: JSON.stringify([{ publicationId: ONLINE, publishDate: null }]), nexusDraft: true }
    const { approvalId } = await queued({ product: family.id, facebookInstagram: 'publish' })
    expect(await approveAndRun(approvalId)).toMatchObject({ ok: true, status: 'executed' })
    const undo = await ask('undo-change', { approvalId })
    expect(undo, undo.error).toMatchObject({ ok: true, mode: 'queued' })
    const asked = await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: undo.approvalId! } }))
    expect(asked.args).not.toHaveProperty('reset')
    expect(await approveAndRun(undo.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect(shop.saves.at(-1)!.body.cells).toEqual([expect.objectContaining({ intent: 'set', value: JSON.stringify([{ publicationId: ONLINE, publishDate: null }]) })])
    expect(shop.cells.salesChannels).toMatchObject({ nexusDraft: true })
  })

  it('review fix — a product that is not active: published to the channel, but not in the Meta catalog until it is active', async () => {
    shop.cells.status = { value: 'DRAFT', nexusDraft: false }
    const draft = await preview({ product: family.id, facebookInstagram: 'publish' })
    expect(draft.preview!.note).toMatch(/The product's own Shopify status is DRAFT: it is published to the channel, but does not reach the Meta catalog until it is active\.$/)
    shop.cells.status = { value: null, nexusDraft: false }
    expect((await preview({ product: family.id, facebookInstagram: 'publish' })).preview!.note).toMatch(/Only an active Shopify product reaches the Meta catalog\.$/)
    // Taking it out says nothing about the status.
    shop.cells.salesChannels = { ...shop.cells.salesChannels, value: JSON.stringify([{ publicationId: FB_IG, publishDate: null }]) }
    expect((await preview({ product: family.id, facebookInstagram: 'unpublish' })).preview!.note).not.toMatch(/active/)
  })

  it('unpublish keeps every other channel and its schedule', async () => {
    shop.cells.salesChannels = { value: JSON.stringify([{ publicationId: ONLINE, publishDate: '2026-11-01T08:00:00Z' }, { publicationId: FB_IG, publishDate: null }]), nexusDraft: false }
    const out = await preview({ product: family.id, facebookInstagram: 'unpublish' })
    expect(out, out.error).toMatchObject({ ok: true, preview: { changes: { salesChannels: { from: ['Online Store', 'Facebook & Instagram'], to: ['Online Store'] } } } })
    const { approvalId } = await queued({ product: family.id, facebookInstagram: 'unpublish' })
    expect(await approveAndRun(approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect(shop.saves.at(-1)!.body.cells[0].value).toBe(JSON.stringify([{ publicationId: ONLINE, publishDate: '2026-11-01T08:00:00Z' }]))
  })

  it('refused in words: already so, no such channel, two of them, channels not visible, asked with fields, the Sales channels field through fields', async () => {
    shop.cells.salesChannels = { value: JSON.stringify([{ publicationId: FB_IG, publishDate: null }]), nexusDraft: true }
    expect(await preview({ product: family.id, facebookInstagram: 'publish' })).toMatchObject({ ok: false, error: expect.stringMatching(/^Nothing to change: TEST-SKU-T11 is already in the store's Facebook & Instagram sales channel \(in the Nexus draft\)/) })
    shop.cells.salesChannels = { value: JSON.stringify([]), nexusDraft: false }
    expect(await preview({ product: family.id, facebookInstagram: 'unpublish' })).toMatchObject({ ok: false, error: expect.stringMatching(/^Nothing to change: TEST-SKU-T11 is not in/) })
    shop.publications = STORE_CHANNELS.filter((c) => c.id !== FB_IG)
    expect(await preview({ product: family.id, facebookInstagram: 'publish' })).toMatchObject({ ok: false, error: expect.stringMatching(/has no Facebook & Instagram sales channel.*Nexus does not/) })
    shop.publications = [...STORE_CHANNELS, { id: 'gid://shopify/Publication/1004', name: 'Facebook and Instagram', supportsFuturePublishing: false }]
    expect(await preview({ product: family.id, facebookInstagram: 'publish' })).toMatchObject({ ok: false, error: expect.stringMatching(/2 sales channels named like Facebook & Instagram.*does not guess/) })
    // Review fix — a name that only holds both words (a merchant's catalog, say) is never the channel.
    shop.publications = [...STORE_CHANNELS.filter((c) => c.id !== FB_IG), { id: 'gid://shopify/Publication/1005', name: 'Facebook Instagram spring catalog', supportsFuturePublishing: false }]
    expect(await preview({ product: family.id, facebookInstagram: 'publish' })).toMatchObject({ ok: false, error: expect.stringMatching(/no sales channel named "Facebook & Instagram", only "Facebook Instagram spring catalog".*does not guess/) })
    shop.publications = [...STORE_CHANNELS, { id: 'gid://shopify/Publication/1005', name: 'Facebook Instagram spring catalog', supportsFuturePublishing: false }]
    shop.cells.salesChannels = { value: JSON.stringify([]), nexusDraft: false }
    expect(await preview({ product: family.id, facebookInstagram: 'publish' })).toMatchObject({ ok: true, preview: { facebookInstagram: { publicationId: FB_IG } } })
    shop.publications = undefined
    expect(await preview({ product: family.id, facebookInstagram: 'publish' })).toMatchObject({ ok: false, error: expect.stringMatching(/lacks read_publications/) })
    shop.publications = STORE_CHANNELS
    expect(await preview({ product: family.id, facebookInstagram: 'publish', fields: { vendor: 'X' } })).toMatchObject({ ok: false, error: expect.stringMatching(/facebookInstagram is asked alone/) })
    // Review fix — undo's reset of the Sales channels draft goes only when that draft differs from Shopify by the channel alone.
    shop.cells.salesChannels = { value: JSON.stringify([{ publicationId: FB_IG, publishDate: null }]), nexusDraft: true, stored: JSON.stringify([{ publicationId: ONLINE, publishDate: null }]) }
    expect(await preview({ product: family.id, facebookInstagram: 'unpublish', reset: ['salesChannels'] })).toMatchObject({ ok: false, error: expect.stringMatching(/would change more than the Facebook & Instagram channel/) })
    expect(await preview({ product: family.id, facebookInstagram: 'unpublish', reset: ['salesChannels', 'vendor'] })).toMatchObject({ ok: false, error: expect.stringMatching(/facebookInstagram is asked alone/) })
    expect(await preview({ product: family.id, reset: ['salesChannels'] })).toMatchObject({ ok: false, error: expect.stringMatching(/salesChannels: a listing setting/) })
    // The Sales channels field itself is never set through fields: only facebookInstagram changes it, one publication.
    expect(await preview({ product: family.id, fields: { salesChannels: '[]' } })).toMatchObject({ ok: false, error: expect.stringMatching(/salesChannels: a listing setting .*\(the Facebook & Instagram channel: facebookInstagram\)/) })
    expect(() => getToolInput().parse({ product: family.id, facebookInstagram: 'remove' })).toThrow()
    expect(shop.saves).toHaveLength(0)
  })
})

describe('listing-live-content, and Etsy', { timeout: 30_000 }, () => {
  it("reads the listing on its channel with the account Nexus holds, without the provider's raw documents", async () => {
    live.reads.length = 0
    const data = await read('listing-live-content', { product: family.sku, channel: 'ebay', market: 'it' })
    expect(live.reads).toEqual([{ productId: family.id, scope: { channel: 'EBAY', marketplace: 'IT', accountId: accounts.ebay } }])
    expect(data).toMatchObject({ readAt: '2026-10-01T12:00:00.000Z', revision: 'rev-1', content: { title: { value: 'Giacca sul canale' } }, cached: false })
    expect(data).not.toHaveProperty('raw')
    expect(await preview({ product: family.id, channel: 'AMAZON', market: 'DE' }, 'listing-live-content')).toMatchObject({ ok: false, error: 'TEST-SKU-T11 has no Amazon · DE listing to read.' })
  })

  it('Etsy: the live read goes to the Etsy reader with the Etsy account, product-content reads the Etsy sheet; Shopify store fields are still answered in words', async () => {
    // A fake Etsy shop and listing (the repo is public).
    const etsyAccount = await inside(async () => {
      const account = await db().channelConnection.create({ data: { channelType: 'ETSY', accountLabel: 't11-etsy', isActive: true, isPrimary: true, externalAccountId: '90000001' } as never })
      await db().channelListing.create({ data: { productId: family.id, channel: 'ETSY', marketplace: 'GLOBAL', region: 'GLOBAL', channelMarket: 'ETSY_GLOBAL', channelConnectionId: account.id,
        aliasKey: '', listingStatus: 'ACTIVE', isPublished: true, externalListingId: '9000000001', syncPaused: false } as never })
      return account.id
    })
    live.reads.length = 0
    const data = await read('listing-live-content', { product: family.sku, channel: 'etsy', market: 'global' })
    expect(live.reads).toEqual([{ productId: family.id, scope: { channel: 'ETSY', marketplace: 'GLOBAL', accountId: etsyAccount } }])
    expect(data).not.toHaveProperty('raw')
    // product-content asks the product sheet for the Etsy scope (the stand-in answers with its one sheet).
    shop.sheetCalls.length = 0
    const content = await preview({ product: family.id, coordinate: { channel: 'ETSY', market: 'GLOBAL' } }, 'product-content')
    expect(content, content.error).toMatchObject({ ok: true })
    expect(shop.sheetCalls).toEqual([expect.objectContaining({ productId: family.id, scope: 'channel', channel: 'ETSY', market: 'GLOBAL' })])
    // set-listing-content is no longer refused for Etsy in words (its own suite runs it on the real Etsy sheet).
    const pin = await preview({ product: family.id, coordinate: { channel: 'etsy', market: 'GLOBAL' }, language: 'en', pin: { title: 'x' } }, 'set-listing-content')
    expect(pin.error ?? '').not.toMatch(/Etsy publishing is not available/)
    expect(await preview({ product: family.id, coordinate: { channel: 'SHOPIFY', market: 'GLOBAL' } }, 'product-content')).toMatchObject({ ok: false, error: expect.stringMatching(/shopify-content/) })
    // A Shopify listing's own title is set-listing-content's now (its suite runs it); its other fields are not.
    const title = await preview({ product: family.id, coordinate: { channel: 'SHOPIFY', market: 'GLOBAL' }, language: 'en', pin: { title: 'x' } }, 'set-listing-content')
    expect(title.error ?? '').not.toMatch(/not available to Claude/)
    expect(await preview({ product: family.id, coordinate: { channel: 'SHOPIFY', market: 'GLOBAL' }, language: 'en', pin: { keywords: ['x'] } }, 'set-listing-content'))
      .toMatchObject({ ok: false, error: expect.stringMatching(/keywords: a Shopify listing's store fields .* set-shopify-content/) })
  })
})
