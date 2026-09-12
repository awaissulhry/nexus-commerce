import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ database: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  fixture.database = await formulaDatabase()
  return { default: fixture.database.client }
})
vi.mock('../../lib/queue.js', () => ({ addJobSafely: vi.fn(), outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: null }))
vi.mock('./sheet-columns.service.js', () => ({ getSheetColumns: async () => ({ columns: [
  { key: 'color', label: 'Color', scope: 'per_variant', editable: true, storage: 'categoryAttributes' },
  { key: 'size', label: 'Size', scope: 'per_variant', editable: true, storage: 'categoryAttributes' },
  { key: 'custom_finish', label: 'Finish', scope: 'per_variant', editable: true, storage: 'categoryAttributes' },
  { key: 'sku', label: 'SKU', scope: 'per_variant', editable: false, storage: 'column' },
] }) }))
import prisma from '../../db.js'
import { getFamilyVariationAxes, updateFamilyVariationAxes, validAxisChange } from './family-variation-axes.js'

beforeEach(async () => {
  await prisma.productReadCache.deleteMany()
  await prisma.channelListing.deleteMany()
  await prisma.productListingAlias.deleteMany()
  await prisma.product.deleteMany()
  await prisma.channelConnection.deleteMany()
  await prisma.channelConnection.create({ data: { id: 'account', channelType: 'AMAZON', isActive: true } })
  await prisma.product.create({ data: { id: 'parent', sku: 'P', name: 'Family', basePrice: 1, isParent: true, version: 3, variationAxes: ['Colore', 'size'] } })
  await prisma.product.create({ data: { id: 'child', sku: 'C', name: 'Child', basePrice: 1, parentId: 'parent', variantAttributes: { Color: 'Black' }, categoryAttributes: { size: 'L' } } })
  await prisma.productListingAlias.create({ data: { id: 'alias', productId: 'parent', channel: 'AMAZON', marketplace: 'DE', channelConnectionId: 'account', label: 'Alternate', status: 'ACTIVE' } })
})
afterAll(async () => { await fixture.database?.close() })
const change = () => ({ version: 3, axes: ['custom_finish', 'Colore'], childIds: ['child'], market: 'DE' })

describe('shared family axes', () => {
  it('reads the parent from a child and preserves localized saved names alongside dictionary identities', async () => {
    const data = await getFamilyVariationAxes('child', 'DE')
    expect(data.product).toMatchObject({ id: 'parent', version: 3 })
    expect(data.childIds).toEqual(['child'])
    expect(data.options).toContainEqual({ key: 'Colore', label: 'Color (Colore)', identity: 'color' })
    expect(data.options.some(option => option.key === 'sku')).toBe(false)
  })
  it('updates the reviewed root once while preserving child values and all listing aliases', async () => {
    expect(await updateFamilyVariationAxes('parent', change())).toEqual({ version: 4 })
    expect(await prisma.product.findUniqueOrThrow({ where: { id: 'parent' } })).toMatchObject({ version: 4, variationAxes: ['custom_finish', 'Colore'] })
    expect(await prisma.product.findUniqueOrThrow({ where: { id: 'child' } })).toMatchObject({ parentId: 'parent', variantAttributes: { Color: 'Black' }, categoryAttributes: { size: 'L' } })
    expect(await prisma.productListingAlias.findUniqueOrThrow({ where: { id: 'alias' } })).toMatchObject({ productId: 'parent', channelConnectionId: 'account', status: 'ACTIVE' })
  })
  it('rejects a stale version without overwriting another edit', async () => {
    await prisma.product.update({ where: { id: 'parent' }, data: { version: 4 } })
    await expect(updateFamilyVariationAxes('parent', change())).rejects.toThrow('family changed')
    expect((await prisma.product.findUniqueOrThrow({ where: { id: 'parent' } })).variationAxes).toEqual(['Colore', 'size'])
  })
  it('rejects changed membership even when the parent version has not advanced', async () => {
    await prisma.product.update({ where: { id: 'child' }, data: { parentId: null } })
    await expect(updateFamilyVariationAxes('parent', change())).rejects.toThrow('family changed')
  })
  it('refuses child-targeted and unknown-attribute writes', async () => {
    await expect(updateFamilyVariationAxes('child', change())).rejects.toThrow('shared parent')
    await expect(updateFamilyVariationAxes('parent', { ...change(), axes: ['unknown'] })).rejects.toThrow('dictionary')
  })
  it('treats unchanged saves as a no-op and ignores soft-deleted children', async () => {
    await prisma.product.update({ where: { id: 'child' }, data: { deletedAt: new Date() } })
    const setup = await getFamilyVariationAxes('parent', 'DE')
    expect(setup.childIds).toEqual([])
    expect(await updateFamilyVariationAxes('parent', { ...change(), axes: setup.axes, childIds: [] })).toEqual({ version: 3 })
  })
  it('rejects malformed or semantically duplicated axes at the route boundary', () => {
    expect(validAxisChange(change())).toBe(true)
    for (const invalid of [null, { ...change(), version: -1 }, { ...change(), axes: ['Color', 'Colore'] },
      { ...change(), axes: ['size', 'Taglia'] }, { ...change(), axes: [''] }, { ...change(), childIds: ['child', 'child'] }]) {
      expect(validAxisChange(invalid)).toBe(false)
    }
  })
})
