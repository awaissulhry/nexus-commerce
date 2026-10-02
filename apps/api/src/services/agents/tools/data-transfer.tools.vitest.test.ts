/**
 * MCP full control (09 §4, P-3) — export-rows, through the one door, on PGlite with the production schema and the
 * business policies: catalog rows only, at most 500 a page, deleted products never, money columns gone for a person
 * who may not see them (and there for one who may), pages by cursor, another business's rows never.
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
  return { default: new Proxy({}, { get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property) }) }
})
vi.mock('../../../lib/queue.js', () => ({ outboundSyncQueue: null, bulkJobQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))

import { callTool, ToolAccessError, type UserPrincipal } from '../call-tool.js'

const A = LEGACY_WORKSPACE_ID
const B = 'export_rows_bravo'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const person = (permissions: string[], workspaceId = A): UserPrincipal => ({
  kind: 'user', userId: 'u-export', label: 'Export test', permissions: { isOwner: false, permissions: new Set([F.aiRun, ...permissions]) }, workspace: business(workspaceId), via: 'claude',
})
const EXPORTER = (workspaceId = A) => person([F.productsExport], workspaceId)
const CLEARED = (workspaceId = A) => person([F.productsExport, ...Object.values(FIELDS)], workspaceId)

async function run(who: UserPrincipal, args: Record<string, unknown>) {
  try {
    return (await callTool(who, 'export-rows', args)).visible
  } catch (error) {
    if (error instanceof ToolAccessError) return { ok: false, refused: error.code }
    throw error
  }
}
const rows = async (who: UserPrincipal, args: Record<string, unknown>) => {
  const out = await run(who, args) as { ok: boolean; data?: { rows: Array<Record<string, unknown>>; nextCursor: string | null } }
  expect(out.ok, JSON.stringify(out)).toBe(true)
  return out.data!
}

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  const owner = await database.client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active' } })
  await database.client.workspace.create({ data: { id: B, name: 'Bravo export business', createdByUserId: owner.id, creationKey: randomUUID() } })
  await inside(async () => {
    const db = database.client
    const parent = await db.product.create({ data: { sku: 'TEST-EXP-JACKET', name: 'Jacket', brand: 'Alpine', productType: 'JACKET', basePrice: '100.00', costPrice: '42.42', isParent: true, totalStock: 0 } })
    for (const size of ['L', 'M', 'S']) {
      await db.product.create({ data: { sku: `TEST-EXP-JACKET-${size}`, name: `Jacket ${size}`, brand: 'Alpine', productType: 'JACKET', basePrice: '100.00', costPrice: '42.42', parentId: parent.id, totalStock: 3 } })
    }
    const gloves = await db.product.create({ data: { sku: 'TEST-EXP-GLOVES', name: 'Gloves', brand: 'Other', basePrice: '20.00', minPrice: '15.00', costPrice: '7.77', totalStock: 9, status: 'DRAFT' } })
    await db.product.create({ data: { sku: 'TEST-EXP-GONE', name: 'Deleted', basePrice: '9.00', deletedAt: new Date() } })
    await db.channelListing.create({
      data: { productId: gloves.id, channel: 'EBAY', channelMarket: 'EBAY_IT', region: 'IT', marketplace: 'IT', title: 'Gloves IT', price: '21.00', quantity: 9, listingStatus: 'ACTIVE', externalListingId: 'TEST-ITEM-1' },
    })
  })
  await inside(async () => {
    await database.client.product.create({ data: { sku: 'TEST-EXP-BRAVO', name: 'BRAVO coat', basePrice: '50.00', costPrice: '11.11' } })
  }, B)
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('export-rows', () => {
  it('needs products.export; catalog entities only; at most 500 rows', async () => {
    expect(await run(person([F.productsView]), { entity: 'products' })).toMatchObject({ refused: 'forbidden' })
    expect(await run(EXPORTER(), { entity: 'orders' })).toMatchObject({ refused: 'invalid_arguments' })
    expect(await run(EXPORTER(), { entity: 'products', limit: 501 })).toMatchObject({ refused: 'invalid_arguments' })
    expect(await run(EXPORTER(), { entity: 'products', cursor: 'not-a-cursor' })).toMatchObject({ ok: false, error: expect.stringContaining('called wrongly') })
  })

  it('products in SKU order, deleted ones never; the cost price only for a person who may see costs', async () => {
    const plain = await rows(EXPORTER(), { entity: 'products' })
    expect(plain.rows.map((row) => row.sku)).toEqual(['TEST-EXP-GLOVES', 'TEST-EXP-JACKET', 'TEST-EXP-JACKET-L', 'TEST-EXP-JACKET-M', 'TEST-EXP-JACKET-S'])
    expect(plain.rows[2]).toMatchObject({ parentSku: 'TEST-EXP-JACKET', basePrice: 100, totalStock: 3, brand: 'Alpine' })
    expect(JSON.stringify(plain)).not.toContain('costPrice')
    expect(JSON.stringify(plain)).not.toContain('42.42')
    const cleared = await rows(CLEARED(), { entity: 'products', sku: 'TEST-EXP-GLOVES' })
    expect(cleared.rows).toEqual([expect.objectContaining({ sku: 'TEST-EXP-GLOVES', costPrice: 7.77, status: 'DRAFT' })])
  })

  it('filters and pages: a SKU prefix takes the variants; nextCursor goes on; a cursor of other filters is refused', async () => {
    const first = await rows(EXPORTER(), { entity: 'products', sku: 'TEST-EXP-JACKET', limit: 2 })
    expect(first.rows.map((row) => row.sku)).toEqual(['TEST-EXP-JACKET', 'TEST-EXP-JACKET-L'])
    const second = await rows(EXPORTER(), { entity: 'products', sku: 'TEST-EXP-JACKET', limit: 2, cursor: first.nextCursor })
    expect(second.rows.map((row) => row.sku)).toEqual(['TEST-EXP-JACKET-M', 'TEST-EXP-JACKET-S'])
    expect(second.nextCursor).toBeNull()
    expect(await run(EXPORTER(), { entity: 'products', brand: 'Other', cursor: first.nextCursor })).toMatchObject({ ok: false, error: expect.stringContaining('called wrongly') })
    expect((await rows(EXPORTER(), { entity: 'products', brand: 'alpine', status: 'ACTIVE' })).rows).toHaveLength(4)
  })

  it('listings, prices and stock', async () => {
    expect((await rows(EXPORTER(), { entity: 'listings', channel: 'ebay', market: 'it' })).rows).toEqual([
      expect.objectContaining({ sku: 'TEST-EXP-GLOVES', channel: 'EBAY', market: 'IT', title: 'Gloves IT', price: 21, quantity: 9, status: 'ACTIVE', channelItemId: 'TEST-ITEM-1' }),
    ])
    const prices = await rows(EXPORTER(), { entity: 'prices', sku: 'TEST-EXP-GLOVES' })
    expect(prices.rows).toEqual([{ productId: expect.any(String), sku: 'TEST-EXP-GLOVES', name: 'Gloves', basePrice: 20, minPrice: 15, maxPrice: null, listingPrices: [{ channel: 'EBAY', market: 'IT', price: 21, salePrice: null }] }])
    expect((await rows(CLEARED(), { entity: 'prices', sku: 'TEST-EXP-GLOVES' })).rows[0]).toMatchObject({ costPrice: 7.77 })
    expect((await rows(EXPORTER(), { entity: 'stock', sku: 'TEST-EXP-JACKET-' })).rows.map((row) => [row.sku, row.totalStock])).toEqual([
      ['TEST-EXP-JACKET-L', 3], ['TEST-EXP-JACKET-M', 3], ['TEST-EXP-JACKET-S', 3],
    ])
  })

  it('one business at a time', async () => {
    const inA = await rows(CLEARED(A), { entity: 'products' })
    expect(JSON.stringify(inA)).not.toContain('BRAVO')
    expect((await rows(CLEARED(A), { entity: 'products', sku: 'TEST-EXP-BRAVO' })).rows).toEqual([])
    expect((await rows(CLEARED(B), { entity: 'products' })).rows.map((row) => row.sku)).toEqual(['TEST-EXP-BRAVO'])
  })
})
