/**
 * MCP full control L7 — create-product, create-variations and discard-new-products, run through the one door (call-tool.ts)
 * against a real PostgreSQL with the production schema and business-isolation policies (PGlite), on the create wizard's
 * service and the family generator.
 *
 * Proven here: a dry run writes nothing; a product (or a family) is created as approved, as the approver, with no stock;
 * a SKU already taken refuses; new variations are exactly the previewed plan, and a family that changed since the preview
 * gets none (the generator's token); only unused products are binned, a family together, and restore puts them back;
 * each undo asks for the inverse request.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'

const state = vi.hoisted(() => ({ database: null as any, refreshMany: null as any }))
vi.mock('@nexus/database', async (original) => {
  const { formulaDatabase } = await import('../../../test-support/formula-database.js')
  state.database = await formulaDatabase()
  return { ...(await original<object>()), default: state.database.client }
})
vi.mock('../../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../../product-read-cache.service.js', () => {
  state.refreshMany = vi.fn(async () => [])
  return { productReadCacheService: { refresh: vi.fn(), refreshMany: state.refreshMany, refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }
})

import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'
import { callTool, executeTool, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const person = (userId: string): UserPrincipal => ({
  kind: 'user', userId, label: userId,
  permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
  workspace: business, via: 'claude',
})
const claude = person('u-l7-asker')
const approver = person('u-l7-approver')
type Json = Record<string, any>
const db = () => state.database.client

const dryRun = async (tool: string, args: Json) => (await inside(() => callTool(claude, tool, args))).raw as Json
async function approveAndRun(tool: string, args: Json) {
  const preview = await dryRun(tool, args)
  expect(preview.ok, preview.error).toBe(true)
  const ran = (await inside(() => executeTool(approver, tool, args, { approvedPreview: JSON.parse(JSON.stringify(preview.preview)), via: 'claude' }))).raw as Json
  return { preview: preview.preview as Json, ran }
}
const productsBySku = (prefix: string) => inside(() => db().product.findMany({ where: { sku: { startsWith: prefix } }, orderBy: { sku: 'asc' } }))

beforeAll(async () => {
  await inside(async () => {
    await db().product.create({ data: { sku: 'TEST-L7-TAKEN', name: 'Taken', basePrice: 1 } })
    // The dictionary attribute a family varies by (setFamilyAxes takes dictionary codes).
    const group = await db().attributeGroup.create({ data: { code: 'sizing', label: 'Sizing' } })
    await db().customAttribute.create({ data: { code: 'size', label: 'Size', groupId: group.id, type: 'select', scope: 'per_variant' } })
  })
}, 120_000)
afterAll(async () => { await state.database?.close() }, 30_000)
beforeEach(() => { state.refreshMany.mockClear() })

const family = { sku: 'TEST-L7-FAM', name: 'Test jacket', basePrice: 50, brand: 'Test brand', productType: 'OUTERWEAR',
  variations: [{ sku: 'TEST-L7-FAM-M', attributes: { Size: 'M' } }, { sku: 'TEST-L7-FAM-L', attributes: { Size: 'L' }, price: 55 }] }

describe('create-product', () => {
  it('previews without writing, creates the family as approved and as the approver, with no stock', async () => {
    const preview = await dryRun('create-product', family)
    expect(preview.preview).toMatchObject({ product: { sku: 'TEST-L7-FAM', name: 'Test jacket', basePrice: 50 }, axes: [{ name: 'Size', attribute: 'size' }],
      variations: [{ sku: 'TEST-L7-FAM-M', name: 'Test jacket — TEST-L7-FAM-M', attributes: { Size: 'M' }, price: 50 }, { sku: 'TEST-L7-FAM-L', price: 55 }] })
    expect(await productsBySku('TEST-L7-FAM')).toEqual([])
    const { ran } = await approveAndRun('create-product', family)
    expect(ran.ok, ran.error).toBe(true)
    const rows = await productsBySku('TEST-L7-FAM')
    expect(rows.map((r: Json) => [r.sku, r.isParent, r.totalStock, Number(r.basePrice), r.parentId === ran.data.product.id])).toEqual([
      ['TEST-L7-FAM', true, 0, 50, false], ['TEST-L7-FAM-L', false, 0, 55, true], ['TEST-L7-FAM-M', false, 0, 50, true],
    ])
    expect(rows.find((r: Json) => r.sku === 'TEST-L7-FAM-M').categoryAttributes).toEqual({ variations: { Size: 'M' } })
    // The family's axes, through the one writer of them (setFamilyAxes): the dictionary code and the name it was given.
    expect(rows[0]).toMatchObject({ variationAxisCodes: ['size'], variationAxes: ['Size'] })
    await vi.waitFor(async () => expect(await inside(() => db().auditLog.findFirst({ where: { entityId: ran.data.product.id, action: 'create' } })))
      .toMatchObject({ userId: 'u-l7-approver', metadata: { source: 'claude', variationCount: 2 } }))
    const tool = getTool('create-product')!
    expect(await inside(() => tool.undo!.current(ran.change))).toEqual({ restore: false, products: ran.change.after.products })
    expect(tool.undo!.request(ran.change)).toEqual({ tool: 'discard-new-products', args: { productIds: rows.map((r: Json) => r.id).sort((a: string, b: string) => ran.change.after.products.findIndex((p: Json) => p.id === a) - ran.change.after.products.findIndex((p: Json) => p.id === b)) } })
  })

  it('refuses a variation name that is no attribute of the dictionary: a family varies by dictionary attributes', async () => {
    const out = await dryRun('create-product', { sku: 'TEST-L7-NOAXIS', name: 'No axis', basePrice: 5, variations: [{ sku: 'TEST-L7-NOAXIS-1', attributes: { Wingspan: 'Wide' } }] })
    expect(out).toEqual({ ok: false, error: 'TEST-L7-NOAXIS: "Wingspan" is not an attribute of the Nexus attribute dictionary: add it there (or use an existing attribute\'s name) first. Nothing was queued.' })
  })

  it('refuses a SKU already in the catalogue, and asks nothing about stock or identifiers', async () => {
    expect(await dryRun('create-product', { sku: 'TEST-L7-TAKEN', name: 'Again', basePrice: 1 })).toEqual({ ok: false, error: 'SKU "TEST-L7-TAKEN" already exists. Nothing was queued.' })
    const props = Object.keys((getTool('create-product')!.input as any).shape)
    for (const key of ['totalStock', 'ean', 'gtin', 'upc', 'costPrice']) expect(props).not.toContain(key)
  })
})

describe('create-variations', () => {
  it('creates exactly the previewed new combinations, as DRAFT products', async () => {
    const parent = (await productsBySku('TEST-L7-FAM'))[0]
    const args = { productId: parent.id, axisValues: { Size: ['M', 'L', 'XL'] }, skuPattern: '{parent}-{Size.code}' }
    const { preview, ran } = await approveAndRun('create-variations', args)
    expect(preview).toMatchObject({ family: { sku: 'TEST-L7-FAM' }, counts: { combinations: 3, existing: 2, willCreate: 1 }, create: [{ sku: 'TEST-L7-FAM-XL', values: { Size: 'XL' } }] })
    expect(ran.ok, ran.error).toBe(true)
    expect(ran.data.created.map((c: Json) => c.sku)).toEqual(['TEST-L7-FAM-XL'])
    expect((await productsBySku('TEST-L7-FAM-XL'))[0]).toMatchObject({ status: 'DRAFT', parentId: parent.id })
    expect(getTool('create-variations')!.undo!.request(ran.change)).toEqual({ tool: 'discard-new-products', args: { productIds: [ran.data.created[0].id] } })
  })

  it('a family that changed since the preview gets nothing (the generator\'s token)', async () => {
    const parent = (await productsBySku('TEST-L7-FAM'))[0]
    const args = { productId: parent.id, axisValues: { Size: ['S'] }, skuPattern: '{parent}-{Size.code}' }
    const preview = await dryRun('create-variations', args)
    await inside(() => db().product.create({ data: { sku: 'TEST-L7-FAM-XXL', name: 'XXL', basePrice: 50, parentId: parent.id, categoryAttributes: { variations: { Size: 'XXL' } } } as never }))
    const ran = (await inside(() => executeTool(approver, 'create-variations', args, { approvedPreview: preview.preview }))).raw as Json
    expect(ran).toMatchObject({ ok: false, error: expect.stringContaining('changed after preview') })
    expect(await productsBySku('TEST-L7-FAM-S')).toEqual([])
  })
})

describe('discard-new-products', () => {
  it('bins unused products, a family together; restore puts them back; a product in use is refused', async () => {
    const rows = await productsBySku('TEST-L7-FAM')
    const parent = rows[0]
    expect((await dryRun('discard-new-products', { productIds: [parent.id] })).error).toContain('live variations not named here')
    // A variation with a listing is in use.
    await inside(() => db().channelListing.create({ data: { productId: rows[1].id, channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT', region: 'IT' } as never }))
    expect((await dryRun('discard-new-products', { productIds: rows.map((r: Json) => r.id) })).error).toContain('has listings')
    await inside(() => db().channelListing.deleteMany({ where: { productId: rows[1].id } }))
    const ids = rows.map((r: Json) => r.id)
    const { ran } = await approveAndRun('discard-new-products', { productIds: ids })
    expect(ran.ok, ran.error).toBe(true)
    expect((await productsBySku('TEST-L7-FAM')).every((r: Json) => r.deletedAt !== null)).toBe(true)
    const tool = getTool('discard-new-products')!
    expect(await inside(() => tool.undo!.current(ran.change))).toEqual(ran.change.after)
    const undo = tool.undo!.request(ran.change) as Json
    expect(undo).toEqual({ tool: 'discard-new-products', args: { productIds: ids, restore: true } })
    expect((await approveAndRun('discard-new-products', undo.args)).ran.ok).toBe(true)
    expect((await productsBySku('TEST-L7-FAM')).every((r: Json) => r.deletedAt === null)).toBe(true)
  })
})
