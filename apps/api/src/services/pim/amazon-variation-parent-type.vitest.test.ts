/**
 * P0 item 7 (2026-09-30) — an Amazon variation with no product type of its own uses its parent's.
 *
 * Before, the category resolver's last step read only the variation's own `Product.productType`, so a variation
 * without one resolved to "No category" and every column of the family's type was locked "Not applicable to this
 * category." (REGAL-JACKET Amazon DE: 16 rows, 171 of 172 columns each). Amazon keeps one product type per family,
 * and the resolver's earlier steps (sibling-market listings, category memberships) already fall back to the parent.
 *
 * The same answer must reach every path that acts on those rows: the sheet (applicability, lock reason, validators,
 * the row's type and where it came from), the bulk save's row contract, and the batch resolver the publication feed
 * takes its product type from. On an in-process PostgreSQL (PGlite) with the production row policies; ids invented.
 * Run: npx vitest run src/services/pim/amazon-variation-parent-type.vitest.test.ts (and with NEXUS_WORKSPACES_ENABLED=1).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60_000 })
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(async () => []), refreshInTransaction: vi.fn() },
  FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
vi.mock('./readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))
// The type's rules are the cached row below; any provider read is a fixture failure, never a network call.
vi.stubGlobal('fetch', vi.fn(async (url: unknown) => { throw new Error(`network refused in a test: ${String(url)}`) }))

/** A controlled OUTERWEAR: content (item_name), a platform path (brand), a bag attribute (color). */
const AMAZON_DEFINITION = vi.hoisted(() => {
  const attribute = () => ({ type: 'array', minUniqueItems: 1, maxUniqueItems: 1, items: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } })
  return { type: 'object', properties: { item_name: attribute(), brand: attribute(), color: attribute() } }
})
vi.mock('../categories/seller-schema.service.js', async () => {
  const { amazonSpecFromDefinition } = await import('./channel-specs/amazon.js')
  return { amazonSellerSpec: async (_account: string, marketplace: string, productType: string) => amazonSpecFromDefinition({ marketplace, productType, fetchedAt: new Date(), schemaVersion: 'fixture', schemaDefinition: AMAZON_DEFINITION }) }
})

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { categorySourceLabel, resolveCategoriesForProducts } from './mapping/category-mapping.service.js'
import { resolveBatch } from './mapping/resolve-batch.service.js'
import { getStudioSheet } from './studio-sheet.service.js'
import { applyProductBulkEdits, ProductBulkError } from '../products/bulk-edit.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const NOT_APPLICABLE = 'Not applicable to this category.'
const ids = { parent: '', typeless: '', typed: '' }
let account = ''

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'APJ6JRA9NG5V4' } as never })
  account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'parent-type', isActive: true, isPrimary: true, externalAccountId: 'FAKE-SELLER',
    authStatus: 'connected', managedBy: 'oauth', region: 'EU' } as never })).id
  await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: 'IT', productType: 'OUTERWEAR', schemaVersion: 'fixture', schemaDefinition: AMAZON_DEFINITION as never, expiresAt: new Date('2099-01-01') } })
  ids.parent = (await prisma.product.create({ data: { sku: 'PT-JACKET', name: 'Jacket', basePrice: 10, isParent: true, productType: 'OUTERWEAR', variationAxes: ['size'] } as never })).id
  // The REGAL shape: one variation with no type of its own, one with the family's type (the control).
  ids.typeless = (await prisma.product.create({ data: { sku: 'PT-JACKET-WOMEN-XL', name: 'Jacket XL', basePrice: 10, parentId: ids.parent, productType: null, variantAttributes: { size: 'XL' } } as never })).id
  ids.typed = (await prisma.product.create({ data: { sku: 'PT-JACKET-MEN-XL', name: 'Jacket XL men', basePrice: 10, parentId: ids.parent, productType: 'OUTERWEAR', variantAttributes: { size: 'XL' } } as never })).id
  for (const productId of Object.values(ids)) {
    await prisma.channelListing.create({ data: { productId, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU', channelConnectionId: account } })
  }
}), 120_000)
afterAll(async () => { await state.db?.close() }, 30_000)

describe('an Amazon variation with no product type of its own', () => {
  it('resolves to its parent\'s type, says so, and only on Amazon', () => scoped(async () => {
    // Asked for the variation ALONE, as a bulk save of that row asks: the parent is not in the set.
    const [category] = Object.values(await resolveCategoriesForProducts({ productIds: [ids.typeless], channel: 'AMAZON', marketplace: 'IT' }))
    expect(category).toMatchObject({ channelCategoryId: 'OUTERWEAR', source: 'productType', fromParent: true })
    expect(categorySourceLabel(category)).toMatch(/^The parent product's product type/)
    // Its own type still wins, and no other channel borrows an Amazon type.
    const own = await resolveCategoriesForProducts({ productIds: [ids.typed], channel: 'AMAZON', marketplace: 'IT' })
    expect(own[ids.typed]).toMatchObject({ channelCategoryId: 'OUTERWEAR', source: 'productType' })
    expect(own[ids.typed].fromParent).toBeUndefined()
    const ebay = await resolveCategoriesForProducts({ productIds: [ids.typeless], channel: 'EBAY', marketplace: 'IT' })
    expect(ebay[ids.typeless]).toMatchObject({ channelCategoryId: null, source: 'none' })
  }))

  it('gets the parent\'s columns on the sheet: editable, never "Not applicable", and the row says where its type came from', () => scoped(async () => {
    const sheet = await getStudioSheet({ productId: ids.parent, scope: 'channel', channel: 'AMAZON', market: 'IT', locale: 'it', accountId: account } as never)
    const row = (sheet.rows as any[]).find(r => r.id === ids.typeless)
    const control = (sheet.rows as any[]).find(r => r.id === ids.typed)
    expect(row.productType).toBe('OUTERWEAR')
    expect(row.categorySource).toMatchObject({ source: 'productType', fromParent: true, label: expect.stringMatching(/^The parent product's product type/) })
    expect(Object.entries(row.values).filter(([, cell]: [string, any]) => cell.writeBlockedReason === NOT_APPLICABLE).map(([key]) => key)).toEqual([])
    // The same columns are editable as on the variation that carries the type itself.
    const editable = (r: any) => Object.entries(r.values).filter(([, cell]: [string, any]) => cell.editable).map(([key]) => key).sort()
    expect(editable(row)).toEqual(editable(control))
    for (const key of ['color', 'brand']) expect(row.values[key], key).toMatchObject({ editable: true, writeBlockedReason: null })
    // The product-type cell shows the parent's type as inherited, and is not reported missing.
    expect(row.values.productType).toMatchObject({ value: 'OUTERWEAR', inherited: true, inheritedFrom: ids.parent })
    expect(sheet.meta.schemaMissing).toEqual([])
  }))

  it('takes a bulk-save of one of those cells (the row contract resolves the same type)', () => scoped(async () => {
    let result: any
    try {
      result = await applyProductBulkEdits({ changes: [{ id: ids.typeless, field: 'attr_color', value: 'Nero', target: 'channel', intent: 'set' }] as never,
        marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'IT', locale: 'it', aliasKey: '' }] } as never,
      { formulaCascade: false, contentPerRow: true, logger: { warn: vi.fn(), error: vi.fn() } } as never)
    } catch (error) {
      result = error instanceof ProductBulkError ? { status: error.statusCode, ...error.details } : error
    }
    expect(result, JSON.stringify(result)).toMatchObject({ success: true, updated: 1 })
    const listing = await prisma.channelListing.findFirstOrThrow({ where: { productId: ids.typeless, channel: 'AMAZON', marketplace: 'IT' } })
    expect((listing.overrideData as Record<string, unknown>).color).toBe('Nero')
  }))

  it('publishes as the parent\'s type (the feed takes it from the batch resolver)', () => scoped(async () => {
    const resolved = await resolveBatch({ channel: 'AMAZON', marketplace: 'IT', channelConnectionId: account, aliasKey: '', productIds: [ids.typeless], includeCatalogue: false })
    expect(resolved.products[0].category).toMatchObject({ channelCategoryId: 'OUTERWEAR', fromParent: true })
  }))
})
