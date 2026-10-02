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
 *   Etsy                 refused in words by every coordinate tool
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
  cells: {} as Record<string, { value: unknown; nexusDraft: boolean }>,
  token: 1,
  saves: [] as Array<{ productId: string; scope: Record<string, unknown>; body: any; actor: string | null }>,
  refuse: null as null | string,
  sheetCalls: [] as Array<Record<string, unknown>>,
  sheet: null as null | ((input: any) => any),
}))
vi.mock('../../pim/information-sheet.js', () => ({ getInformationSheet: async (input: any) => { shop.sheetCalls.push(input); return shop.sheet!(input) } }))
vi.mock('../../shopify/channel-sheet.service.js', () => ({
  saveShopifySheetCells: async (productId: string, scope: Record<string, unknown>, body: any, actor: string | null) => {
    shop.saves.push({ productId, scope, body, actor })
    const cells: Record<string, { ok: boolean; reason?: string }> = {}
    for (const cell of body.cells) {
      const key = cell.receiptKey ?? cell.colId
      if (shop.refuse && cell.fieldId === shop.refuse) { cells[key] = { ok: false, reason: 'Shopify changed this value since it was read.' }; continue }
      shop.cells[cell.fieldId] = cell.intent === 'reset' ? { value: 'Store value', nexusDraft: false } : { value: cell.value, nexusDraft: true }
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
      writeField: c.writeField, writeTarget: 'channelListing', shopifyWrite: { ownerId: STORE_PRODUCT, fieldId: c.key, token: `token-${shop.token}`, baseline: 'Store value' } }
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
  shop.cells = { vendor: { value: 'Store value', nexusDraft: false }, 'metafield:PRODUCT:custom.pockets': { value: '2', nexusDraft: false } }
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
    expect(await preview({ product: family.id, fields: { title: 'Jacket' } })).toMatchObject({ ok: false, error: expect.stringMatching(/title: the listing's text follows the shared text — change it with set-content/) })
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

describe('listing-live-content, and Etsy', { timeout: 30_000 }, () => {
  it("reads the listing on its channel with the account Nexus holds, without the provider's raw documents", async () => {
    live.reads.length = 0
    const data = await read('listing-live-content', { product: family.sku, channel: 'ebay', market: 'it' })
    expect(live.reads).toEqual([{ productId: family.id, scope: { channel: 'EBAY', marketplace: 'IT', accountId: accounts.ebay } }])
    expect(data).toMatchObject({ readAt: '2026-10-01T12:00:00.000Z', revision: 'rev-1', content: { title: { value: 'Giacca sul canale' } }, cached: false })
    expect(data).not.toHaveProperty('raw')
    expect(await preview({ product: family.id, channel: 'AMAZON', market: 'DE' }, 'listing-live-content')).toMatchObject({ ok: false, error: 'TEST-SKU-T11 has no Amazon · DE listing to read.' })
  })

  it('Etsy is refused in words by every coordinate tool', async () => {
    const etsy = expect.stringMatching(/^Etsy publishing is not available yet/)
    expect(await preview({ product: family.id, channel: 'ETSY', market: 'GLOBAL' }, 'listing-live-content')).toMatchObject({ ok: false, error: etsy })
    expect(await preview({ product: family.id, coordinate: { channel: 'ETSY', market: 'GLOBAL' } }, 'product-content')).toMatchObject({ ok: false, error: etsy })
    expect(await preview({ product: family.id, coordinate: { channel: 'etsy', market: 'GLOBAL' }, language: 'en', pin: { title: 'x' } }, 'set-listing-content')).toMatchObject({ ok: false, error: etsy })
    expect(await preview({ product: family.id, coordinate: { channel: 'SHOPIFY', market: 'GLOBAL' } }, 'product-content')).toMatchObject({ ok: false, error: expect.stringMatching(/shopify-content/) })
    expect(await preview({ product: family.id, coordinate: { channel: 'SHOPIFY', market: 'GLOBAL' }, language: 'en', pin: { title: 'x' } }, 'set-listing-content'))
      .toMatchObject({ ok: false, error: expect.stringMatching(/set-shopify-content/) })
  })
})
