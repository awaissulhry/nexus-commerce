/**
 * MCP full control I11 — fix-parent and merge-duplicate-products through the gate a person and Claude use (queued,
 * approved, run, recorded, undo asked through the same gate), on PGlite with the production schema and policies and
 * the real family writers (pim/product-relationship.service.ts). Nothing reaches a channel.
 *
 * Broken families (#9): a variation under a deleted parent, a variation under a variation, a product that is its own
 * parent, variations under a product not marked as parent. Duplicates (#10): an old eBay listing shell adopted as an
 * extra listing; a duplicate holding nothing merged; duplicates holding stock, orders, a listing or variations refused.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return {
    default: new Proxy({}, {
      get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property),
    }),
  }
})
vi.mock('../../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))
vi.mock('../../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn(async () => []) } }))
vi.mock('../../pim/readiness-index.service.js', async () => (await import('../../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))

import { runOrQueueTool } from '../approval-gate.service.js'
import { callTool, type UserPrincipal } from '../call-tool.js'
import { commitScheduledApproval, scheduleApproval } from '../../agent-fleet/approval-inbox.service.js'
import { resolveRows } from '../../stock-import.service.js'

const A = LEGACY_WORKSPACE_ID
const B = 'i11_identity_merge_bravo'
const TIMEOUT = 30_000
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const EVERYTHING = new Set<string>([...Object.values(F), ...Object.values(FIELDS)])
const ids: Record<string, string> = {}
const ALL = (): UserPrincipal => ({ kind: 'user', userId: ids.approver, label: 'Mia Merge', permissions: { isOwner: false, permissions: EVERYTHING }, workspace: business(A), via: 'app' })
const db = () => database.client
type Data = Record<string, any>

async function ask(tool: string, args: Record<string, unknown>) {
  const run = await inside(() => db().agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'running', userId: ids.approver, via: 'app' } }))
  return inside(() => runOrQueueTool(tool, args, ALL(), run.id, { forceAsk: true })) as Promise<Data>
}
async function approveAndRun(approvalId: string) {
  const parked = await inside(() => scheduleApproval({ id: approvalId, actor: ALL() }))
  expect(parked, parked.error).toMatchObject({ ok: true, status: 'scheduled' })
  await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inside(() => commitScheduledApproval(approvalId)) as Promise<Data>
}
async function askAndRun(tool: string, args: Record<string, unknown>) {
  const queued = await ask(tool, args)
  expect(queued, queued.error).toMatchObject({ ok: true, mode: 'queued' })
  const ran = await approveAndRun(queued.approvalId)
  expect(ran, ran.error).toMatchObject({ ok: true, status: 'executed' })
  return queued.approvalId as string
}
const askUndo = async (approvalId: string) => {
  const change = await inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId } }))
  return ask('undo-change', { changeId: change.id })
}
const preview = async (tool: string, args: Record<string, unknown>) => (await callTool(ALL(), tool, args)).visible as Data
const row = (id: string) => inside(() => db().product.findUniqueOrThrow({ where: { id } }))

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  const client = database.client
  const role = await client.role.create({ data: { key: `I11_${randomUUID().slice(0, 8)}`, name: 'Merge tester', description: 'test', isSystem: false, permissions: [...EVERYTHING] } })
  const approver = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Mia Merge' } })
  ids.approver = approver.id
  await client.userRole.create({ data: { userId: approver.id, roleId: role.id } })
  await client.workspace.create({ data: { id: B, name: 'Bravo merge business', createdByUserId: approver.id, creationKey: randomUUID() } })
  for (const workspaceId of [A, B]) {
    const membership = await client.workspaceMembership.create({ data: { workspaceId, userId: approver.id, status: 'active' } })
    await client.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  }
  await inside(async () => {
    const make = async (key: string, extra: Data = {}) => { ids[key] = (await client.product.create({ data: { sku: key, name: `${key} jacket`, basePrice: '10.00', ...extra } })).id }
    await make('FP-TOP', { isParent: true })
    await make('FP-MID', { isParent: true, parentId: ids['FP-TOP'] })
    await make('FP-LEAF', { parentId: ids['FP-MID'] })
    await make('FP-DEADP', { isParent: true })
    await make('FP-ORPH', { parentId: ids['FP-DEADP'] })
    await client.product.update({ where: { id: ids['FP-DEADP'] }, data: { deletedAt: new Date() } })
    await make('FP-HOME', { isParent: true })
    await make('FP-CHILD', { parentId: ids['FP-HOME'] })
    await make('FP-NP')
    await make('FP-NPC', { parentId: ids['FP-NP'] })
    await make('FP-SELF')
    await client.product.update({ where: { id: ids['FP-SELF'] }, data: { parentId: ids['FP-SELF'] } })
    await make('FP-ALIASED', { parentId: ids['FP-HOME'] })
    await client.productListingAlias.create({ data: { productId: ids['FP-ALIASED'], channel: 'EBAY', marketplace: 'IT', label: 'on a variation', position: 2 } })

    await make('MG-KEEP', { isParent: true })
    await make('MG-DUP', { amazonAsin: 'B0MGDUP001', ean: '4006381333931', fnsku: 'X00MGDUP01' })
    await client.skuAlias.create({ data: { productId: ids['MG-DUP'], alias: 'mg-dup-old', raw: 'MG-DUP-OLD' } })
    await make('MG-STOCK')
    const location = await client.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'MG-MAIN', name: 'Main' } })
    await client.stockLevel.create({ data: { locationId: location.id, productId: ids['MG-STOCK'], quantity: 3, reserved: 0, available: 3 } })
    await make('MG-ORDER')
    await client.order.create({ data: { channel: 'EBAY', channelOrderId: 'MG-ORDER-1', marketplace: 'IT', currencyCode: 'EUR', totalPrice: '10.00', customerName: 'Test Buyer', customerEmail: 'buyer@example.test', shippingAddress: {}, purchaseDate: new Date(), items: { create: [{ sku: 'MG-ORDER', productId: ids['MG-ORDER'], quantity: 1, price: '10.00' }] } } })
    await make('MG-LISTED')
    await client.channelListing.create({ data: { productId: ids['MG-LISTED'], channel: 'EBAY', marketplace: 'IT', region: 'IT', channelMarket: 'EBAY_IT', listingStatus: 'DRAFT' } })
    await make('MG-SHELL', { productType: 'EBAY_LISTING_SHELL', basePrice: '0.00' })
    const account = await client.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, externalAccountId: 'TEST-EBAY-MG' } })
    ids.shellListing = (await client.channelListing.create({
      data: { productId: ids['MG-SHELL'], channel: 'EBAY', marketplace: 'IT', region: 'IT', channelMarket: 'EBAY_IT', listingStatus: 'ACTIVE', externalListingId: '550000000099', channelConnectionId: account.id },
    })).id
    ids.account = account.id
  })
  await inside(async () => { ids.bravo = (await client.product.create({ data: { sku: 'MG-DUP', name: 'Bravo jacket', basePrice: '10.00' } })).id }, B)
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('I11 — fix-parent', () => {
  it('a preview runs the family writer and keeps nothing', async () => {
    const before = await row(ids['FP-ORPH'])
    const out = await preview('fix-parent', { action: 'move', productId: ids['FP-ORPH'], parentId: ids['FP-HOME'] })
    expect(out.preview).toMatchObject({ fix: 'move', changes: { parent: { from: '(a deleted product)', to: 'FP-HOME' } } })
    const after = await row(ids['FP-ORPH'])
    expect([after.parentId, after.version]).toEqual([before.parentId, before.version])
  }, TIMEOUT)

  it('#9a: a variation under a deleted parent moves to a live one; undo cannot put it back under the deleted one', async () => {
    const approvalId = await askAndRun('fix-parent', { action: 'move', productId: ids['FP-ORPH'], parentId: ids['FP-HOME'] })
    expect((await row(ids['FP-ORPH'])).parentId).toBe(ids['FP-HOME'])
    const undo = await askUndo(approvalId)
    expect(undo.ok).toBe(false)
    expect(undo.error).toMatch(/parent product was not found/)
  }, TIMEOUT)

  it('#9b: a variation under a variation moves to the top parent', async () => {
    await askAndRun('fix-parent', { action: 'move', productId: ids['FP-LEAF'], parentId: ids['FP-TOP'] })
    expect((await row(ids['FP-LEAF'])).parentId).toBe(ids['FP-TOP'])
  }, TIMEOUT)

  it('#9b: a product that is its own parent is detached', async () => {
    await askAndRun('fix-parent', { action: 'detach', productId: ids['FP-SELF'] })
    expect((await row(ids['FP-SELF'])).parentId).toBeNull()
  }, TIMEOUT)

  it('#9c: variations under a product not marked as parent — it is promoted; undo says it is done in Nexus', async () => {
    const approvalId = await askAndRun('fix-parent', { action: 'promote', productId: ids['FP-NP'] })
    expect((await row(ids['FP-NP'])).isParent).toBe(true)
    const undo = await askUndo(approvalId)
    expect(undo.ok).toBe(false)
    expect(JSON.stringify(undo)).toMatch(/demote it/)
  }, TIMEOUT)

  it('detach, then undo attaches it back to the same parent', async () => {
    const approvalId = await askAndRun('fix-parent', { action: 'detach', productId: ids['FP-CHILD'] })
    expect((await row(ids['FP-CHILD'])).parentId).toBeNull()
    const undo = await askUndo(approvalId)
    expect(undo, undo.error).toMatchObject({ ok: true, mode: 'queued' })
    expect(await approveAndRun(undo.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect((await row(ids['FP-CHILD'])).parentId).toBe(ids['FP-HOME'])
  }, TIMEOUT)

  it('the writers\' rules hold: no own parent, no move of a product with extra listings, a parent that is a variation; another business is not found', async () => {
    expect(await preview('fix-parent', { action: 'attach', productId: ids['FP-SELF'], parentId: ids['FP-SELF'] })).toMatchObject({ ok: false, error: expect.stringContaining('cannot be its own parent') })
    expect(await preview('fix-parent', { action: 'move', productId: ids['FP-ALIASED'], parentId: ids['FP-TOP'] })).toMatchObject({ ok: false, error: expect.stringContaining('FP-ALIASED: This action affects products with listing aliases') })
    expect(await preview('fix-parent', { action: 'move', productId: ids['FP-CHILD'], parentId: ids['FP-MID'] })).toMatchObject({ ok: false, error: expect.stringContaining('is not a top-level parent') })
    expect(await preview('fix-parent', { action: 'promote', productId: ids.bravo })).toEqual({ ok: false, error: 'Product not found' })
    expect(await preview('fix-parent', { action: 'move', productId: ids['FP-CHILD'] })).toMatchObject({ ok: false, error: expect.stringContaining('name the parent') })
  }, TIMEOUT)
})

describe('0(b) — fix-parent lifts extra listings off a variation (#9d)', () => {
  it('the variation\'s extra listing moves to its family parent; its listing rows stay the variation\'s; the audit finding goes away', async () => {
    const out = await preview('fix-parent', { action: 'lift-extra-listings', productId: ids['FP-ALIASED'] })
    expect(out.preview).toMatchObject({ fix: 'lift-extra-listings', changes: { 'extra listings': { from: 'FP-ALIASED', to: 'FP-HOME' } }, effect: expect.stringContaining('"on a variation"') })
    const approvalId = await askAndRun('fix-parent', { action: 'lift-extra-listings', productId: ids['FP-ALIASED'] })
    const alias = await inside(() => db().productListingAlias.findFirstOrThrow({ where: { label: 'on a variation' } }))
    expect(alias.productId).toBe(ids['FP-HOME'])
    const audit = (await callTool(ALL(), 'identity-audit', { checks: ['listing-alias-on-a-variation'] })).visible as Data
    expect(audit.data.findings).toEqual([])
    const undo = await askUndo(approvalId)
    expect(undo.ok).toBe(false)
    expect(await preview('fix-parent', { action: 'lift-extra-listings', productId: ids['FP-ALIASED'] })).toMatchObject({ ok: false, error: expect.stringContaining('has no extra listings') })
    expect(await preview('fix-parent', { action: 'lift-extra-listings', productId: ids['FP-HOME'] })).toMatchObject({ ok: false, error: expect.stringContaining('is not a variation') })
  }, TIMEOUT)
})

describe('I11 — merge-duplicate-products', () => {
  it('a duplicate holding nothing: merged, its SKU and SKU aliases now name the product kept; it is put back in Nexus, not by undo', async () => {
    const out = await preview('merge-duplicate-products', { duplicateId: ids['MG-DUP'], keeperId: ids['MG-KEEP'] })
    expect(out.preview).toMatchObject({ mode: 'merge', duplicate: 'MG-DUP', sku: 'MG-KEEP', plan: { newSkuAlias: 'MG-DUP', skuAliases: ['MG-DUP-OLD'] } })
    expect((await row(ids['MG-DUP'])).deletedAt).toBeNull()
    const approvalId = await askAndRun('merge-duplicate-products', { duplicateId: ids['MG-DUP'], keeperId: ids['MG-KEEP'] })
    expect((await row(ids['MG-DUP'])).deletedAt).toBeInstanceOf(Date)
    const aliases = await inside(() => db().skuAlias.findMany({ where: { productId: ids['MG-KEEP'] }, orderBy: { alias: 'asc' } }))
    expect(aliases.map((a) => [a.alias, a.raw])).toEqual([['mg-dup', 'MG-DUP'], ['mg-dup-old', 'MG-DUP-OLD']])
    // 0(a) — nothing finds the trashed duplicate any more: not an order ingest by SKU (eBay, Amazon) or by ASIN, and a
    // stock import by its SKU or barcode lands on the product kept.
    const trashed = await row(ids['MG-DUP'])
    expect(trashed.sku).toMatch(/^MG-DUP~merged-/)
    expect([trashed.amazonAsin, trashed.ean, trashed.fnsku]).toEqual([null, null, null])
    expect(await inside(() => db().product.findFirst({ where: { sku: 'MG-DUP' } }))).toBeNull()
    expect(await inside(() => db().product.findFirst({ where: { amazonAsin: 'B0MGDUP001' } }))).toBeNull()
    const resolved = await inside(() => resolveRows([{ raw: 'MG-DUP', quantity: 1 }, { raw: 'mg-dup-old', quantity: 1 }, { raw: '4006381333931', quantity: 1 }] as never))
    expect(resolved.map((r) => r.productId ?? null)).toEqual([ids['MG-KEEP'], ids['MG-KEEP'], null])
    // Put back by a person in Nexus (restore from the trash): undo-change has nothing to ask for.
    const undo = await askUndo(approvalId)
    expect(undo.ok).toBe(false)
  }, TIMEOUT)

  it('refuses a duplicate holding stock, an order line, a listing, or variations — naming what blocks it — and changes nothing', async () => {
    const refusal = async (duplicate: string) => (await preview('merge-duplicate-products', { duplicateId: ids[duplicate], keeperId: ids['MG-KEEP'] })).error as string
    expect(await refusal('MG-STOCK')).toMatch(/MG-STOCK is not a safe duplicate to merge: it has stock/)
    expect(await refusal('MG-ORDER')).toMatch(/1 order line name it/)
    expect(await refusal('MG-LISTED')).toMatch(/it has 1 channel listing/)
    expect(await refusal('FP-TOP')).toMatch(/it is the parent of/)
    expect((await row(ids['MG-STOCK'])).deletedAt).toBeNull()
    expect(await preview('merge-duplicate-products', { duplicateId: ids.bravo, keeperId: ids['MG-KEEP'] })).toEqual({ ok: false, error: 'Product not found' })
    expect(await preview('merge-duplicate-products', { duplicateId: ids['MG-KEEP'], keeperId: ids['MG-KEEP'] })).toMatchObject({ ok: false, error: expect.stringContaining('cannot be merged into itself') })
  }, TIMEOUT)

  it('an old eBay shell: its listing becomes an extra listing of the product kept (aliasId and aliasKey), the shell goes to the trash', async () => {
    expect(await preview('merge-duplicate-products', { duplicateId: ids['MG-SHELL'], keeperId: ids['FP-LEAF'] })).toMatchObject({ ok: false, error: expect.stringContaining('is a variation') })
    const out = await preview('merge-duplicate-products', { duplicateId: ids['MG-SHELL'], keeperId: ids['MG-KEEP'] })
    expect(out.preview).toMatchObject({ mode: 'adopt-shell', effect: expect.stringContaining('item 550000000099') })
    await askAndRun('merge-duplicate-products', { duplicateId: ids['MG-SHELL'], keeperId: ids['MG-KEEP'] })
    const alias = await inside(() => db().productListingAlias.findFirstOrThrow({ where: { adoptedFromProductId: ids['MG-SHELL'] } }))
    expect(alias).toMatchObject({ productId: ids['MG-KEEP'], channel: 'EBAY', marketplace: 'IT', channelConnectionId: ids.account, label: 'MG-SHELL' })
    const listing = await inside(() => db().channelListing.findUniqueOrThrow({ where: { id: ids.shellListing } }))
    expect(listing).toMatchObject({ productId: ids['MG-KEEP'], aliasId: alias.id, aliasKey: alias.id, externalListingId: '550000000099' })
    expect((await row(ids['MG-SHELL'])).deletedAt).toBeInstanceOf(Date)
    // 0(a) — an eBay order or a stock file naming the shell's SKU no longer reaches the trashed shell.
    expect(await inside(() => db().product.findFirst({ where: { sku: 'MG-SHELL' } }))).toBeNull()
    const [shellRow] = await inside(() => resolveRows([{ raw: 'MG-SHELL', quantity: 1 }] as never))
    expect(shellRow.productId).toBe(ids['MG-KEEP'])
    // The audit no longer finds an unadopted shell.
    const audit = (await callTool(ALL(), 'identity-audit', { checks: ['unadopted-ebay-shell'] })).visible as Data
    expect(audit.data.findings).toEqual([])
    expect(await preview('merge-duplicate-products', { duplicateId: ids['MG-SHELL'], keeperId: ids['MG-KEEP'] })).toEqual({ ok: false, error: 'Product not found' })
  }, TIMEOUT)
})
