/**
 * VTR step 1a — THE writer of a family's variation values (docs/variation-theme/STEP1-PLAN.md §2, Owner D3 a), on a real
 * in-memory PostgreSQL built from the schema.
 *
 *  · the value is saved under the attribute CODE, spelled as the dictionary spells the matched name; old spellings and the
 *    legacy bag leave; a flat copy of the axis is kept in step;
 *  · an unknown value is refused unless the caller asks to add it as a new option;
 *  · two COMPLETE variants with the same values are refused; an incomplete variant is not a duplicate (it is a missing value);
 *  · one compare-and-set on the family root; every changed variant's version is bumped.
 */
import { afterAll, aroundAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '@nexus/database/workspace-context'

const fixture = vi.hoisted(() => ({ database: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  fixture.database = await formulaDatabase()
  return { default: fixture.database.client }
})
vi.mock('../../lib/queue.js', () => ({ addJobSafely: vi.fn(), outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: null }))
vi.mock('./readiness-index.service.js', () => ({ produceReadinessForProducts: vi.fn(async () => ({ inline: 0, pending: 0 })) }))
// Business profiles may be ON (CI runs both): every statement runs as the legacy business.
aroundAll(run => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, run))
import prisma from '../../db.js'
import { FamilyVariationError, setFamilyAxes, setFamilyValueOrder, setFamilyVariationValues } from './family-variations.service.js'

beforeEach(async () => {
  await prisma.productReadCache.deleteMany()
  await prisma.product.deleteMany()
  await prisma.attributeOption.deleteMany()
  await prisma.customAttribute.deleteMany()
  await prisma.attributeGroup.deleteMany()
  await prisma.attributeGroup.create({ data: { id: 'g', code: 'variation', label: 'Variation' } })
  await prisma.customAttribute.create({ data: { id: 'a-color', code: 'color', label: 'Color', semanticKey: 'color', groupId: 'g', type: 'select' } })
  await prisma.customAttribute.create({ data: { id: 'a-size', code: 'size', label: 'Size', semanticKey: 'size', groupId: 'g', type: 'select' } })
  for (const [id, attributeId, code, label, metadata, sortOrder] of [
    ['o1', 'a-color', 'black', 'Black', { labels: { it: 'Nero' } }, 1], ['o2', 'a-color', 'red', 'Red', { labels: { it: 'Rosso' } }, 2],
    ['o3', 'a-size', 'm', 'M', null, 1], ['o4', 'a-size', 'l', 'L', null, 2],
  ] as const) await prisma.attributeOption.create({ data: { id, attributeId, code, label, metadata: metadata ?? undefined, sortOrder } })
  await prisma.product.create({ data: { id: 'fam', sku: 'FAM', name: 'Family', basePrice: 1, isParent: true, version: 7, variationAxes: ['Colore', 'Taglia'] } })
  await prisma.product.create({ data: { id: 'v1', sku: 'FAM-1', name: 'V1', basePrice: 1, parentId: 'fam', version: 2,
    categoryAttributes: { color: 'Nero', variations: { Colore: 'Nero', Taglia: 'M' } }, variantAttributes: { Colore: 'Nero' } } })
  await prisma.product.create({ data: { id: 'v2', sku: 'FAM-2', name: 'V2', basePrice: 1, parentId: 'fam', version: 5,
    categoryAttributes: { variations: { Colore: 'Rosso', Taglia: 'M' } } } })
  await prisma.product.create({ data: { id: 'v3', sku: 'FAM-3', name: 'V3', basePrice: 1, parentId: 'fam', version: 1,
    categoryAttributes: { variations: { Colore: 'Rosso' } } } })
})
afterAll(async () => { await fixture.database?.close() })

const read = (id: string) => prisma.product.findUniqueOrThrow({ where: { id }, select: { version: true, categoryAttributes: true, variantAttributes: true } })

describe('setFamilyVariationValues', () => {
  it('saves under the attribute code as the dictionary spells it; old spellings and the legacy copy leave; the flat copy follows', async () => {
    const result = await setFamilyVariationValues('fam', { expectedVersion: 7, changes: [{ productId: 'v1', axis: 'size', value: ' l ' }] })
    expect(result).toEqual({ version: 8, changed: ['v1'], createdOptions: [] })
    const v1 = await read('v1')
    expect(v1.version).toBe(3)
    expect((v1.categoryAttributes as any).variations).toEqual({ Colore: 'Nero', size: 'L' })
    expect((v1.categoryAttributes as any).color).toBe('Nero')
    expect(v1.variantAttributes).toEqual({ Colore: 'Nero' })
    expect((await read('fam')).version).toBe(8)
  })

  it('keeps the language: "nero" is saved as the Italian label "Nero", never the English default', async () => {
    await setFamilyVariationValues('fam', { expectedVersion: 7, changes: [{ productId: 'v3', axis: 'color', value: 'nero' }, { productId: 'v3', axis: 'size', value: 'L' }] })
    expect(((await read('v3')).categoryAttributes as any).variations).toEqual({ color: 'Nero', size: 'L' })
  })

  it('moves the legacy copy of the SAME axis out, and keeps a flat copy in step', async () => {
    // (Rosso + M alone would copy FAM-2 — that refusal has its own test.)
    await setFamilyVariationValues('fam', { expectedVersion: 7, changes: [{ productId: 'v1', axis: 'color', value: 'Rosso' }, { productId: 'v1', axis: 'size', value: 'L' }] })
    const v1 = await read('v1')
    expect((v1.categoryAttributes as any).variations).toEqual({ color: 'Rosso', size: 'L' })
    expect((v1.categoryAttributes as any).color).toBe('Rosso')
    expect(v1.variantAttributes).toEqual({})
  })

  it('refuses an unknown value, and adds it as a new option only when asked', async () => {
    await expect(setFamilyVariationValues('fam', { expectedVersion: 7, changes: [{ productId: 'v3', axis: 'color', value: 'Verde' }] }))
      .rejects.toThrow('"Verde" is not a Color value yet')
    expect((await read('fam')).version).toBe(7)
    const added = await setFamilyVariationValues('fam', { expectedVersion: 7, changes: [{ productId: 'v3', axis: 'color', value: 'Verde', addOption: true }] })
    expect(added.createdOptions).toEqual([{ axis: 'color', code: 'green', label: 'Verde' }])
    expect(await prisma.attributeOption.findFirst({ where: { attributeId: 'a-color', code: 'green' }, select: { label: true, sortOrder: true } })).toEqual({ label: 'Verde', sortOrder: 3 })
  })

  it('refuses two COMPLETE variants with the same values, and writes nothing', async () => {
    await expect(setFamilyVariationValues('fam', { expectedVersion: 7, changes: [{ productId: 'v2', axis: 'color', value: 'Nero' }] }))
      .rejects.toThrow('FAM-1 and FAM-2 would have the same values')
    expect(((await read('v2')).categoryAttributes as any).variations).toEqual({ Colore: 'Rosso', Taglia: 'M' })
  })

  it('an incomplete variant is not a duplicate (v3 has no size): the change is allowed', async () => {
    await setFamilyVariationValues('fam', { expectedVersion: 7, changes: [{ productId: 'v2', axis: 'size', value: null }] })
    expect(((await read('v2')).categoryAttributes as any).variations).toEqual({ Colore: 'Rosso' })
  })

  it('refuses a stale family version, a non-variant, an axis the family does not have, and a child id instead of the root', async () => {
    await expect(setFamilyVariationValues('fam', { expectedVersion: 6, changes: [{ productId: 'v1', axis: 'size', value: 'L' }] })).rejects.toThrow('This family changed')
    await expect(setFamilyVariationValues('fam', { expectedVersion: 7, changes: [{ productId: 'other', axis: 'size', value: 'L' }] })).rejects.toThrow('not a variant of FAM')
    await expect(setFamilyVariationValues('fam', { expectedVersion: 7, changes: [{ productId: 'v1', axis: 'material', value: 'Pelle' }] })).rejects.toThrow('FAM has no material axis')
    await expect(setFamilyVariationValues('v1', { expectedVersion: 2, changes: [{ productId: 'v1', axis: 'size', value: 'L' }] })).rejects.toBeInstanceOf(FamilyVariationError)
    expect((await read('fam')).version).toBe(7)
  })
})

describe('setFamilyAxes', () => {
  it('stores the axes as attribute codes in order; the label mirror keeps each existing spelling, a new axis takes the attribute label', async () => {
    await prisma.product.update({ where: { id: 'fam' }, data: { variationAxes: ['Taglia'] } })
    const result = await setFamilyAxes('fam', { expectedVersion: 7, codes: ['color', 'size'] })
    expect(result).toEqual({ version: 8 })
    expect(await prisma.product.findUniqueOrThrow({ where: { id: 'fam' }, select: { variationAxisCodes: true, variationAxes: true, version: true } }))
      .toEqual({ variationAxisCodes: ['color', 'size'], variationAxes: ['Color', 'Taglia'], version: 8 })
  })

  it('refuses an unknown or archived attribute, a repeated axis, a stale version, and a child', async () => {
    await expect(setFamilyAxes('fam', { expectedVersion: 7, codes: ['material'] })).rejects.toThrow('material is not an attribute of the dictionary')
    await expect(setFamilyAxes('fam', { expectedVersion: 7, codes: ['color', 'color'] })).rejects.toThrow('color twice')
    await expect(setFamilyAxes('fam', { expectedVersion: 6, codes: ['color'] })).rejects.toThrow('This family changed')
    await expect(setFamilyAxes('v1', { expectedVersion: 2, codes: ['color'] })).rejects.toThrow('family parent')
    expect((await prisma.product.findUniqueOrThrow({ where: { id: 'fam' } })).version).toBe(7)
  })

  it('the same codes again change nothing and keep the version', async () => {
    await setFamilyAxes('fam', { expectedVersion: 7, codes: ['color', 'size'] })
    expect(await setFamilyAxes('fam', { expectedVersion: 8, codes: ['color', 'size'] })).toEqual({ version: 8 })
  })
})

/* Sheet pop-up rebuild P2: the value order dragged in the variation-theme pop-up. */
describe('setFamilyValueOrder', () => {
  const coded = () => prisma.product.update({ where: { id: 'fam' }, data: { variationAxisCodes: ['color', 'size'] } })
  const order = async () => (await prisma.product.findUniqueOrThrow({ where: { id: 'fam' }, select: { version: true, variationValueOrder: true } }))

  it('saves the order of the axes it names, keeps the others, and moves the family version once', async () => {
    await coded()
    await prisma.product.update({ where: { id: 'fam' }, data: { variationValueOrder: { size: ['l', 'm'] } } })
    expect(await setFamilyValueOrder('fam', { expectedVersion: 7, order: { color: ['red', 'black'] } })).toEqual({ version: 8 })
    expect(await order()).toEqual({ version: 8, variationValueOrder: { size: ['l', 'm'], color: ['red', 'black'] } })
  })
  it('writes nothing for the order it already has', async () => {
    await coded()
    await prisma.product.update({ where: { id: 'fam' }, data: { variationValueOrder: { color: ['red', 'black'] } } })
    expect(await setFamilyValueOrder('fam', { expectedVersion: 7, order: { color: ['red', 'black'] } })).toEqual({ version: 7 })
    expect((await order()).version).toBe(7)
  })
  it('refuses an axis the family does not vary by, an option its attribute does not have, and a repeated value', async () => {
    await coded()
    await expect(setFamilyValueOrder('fam', { expectedVersion: 7, order: { material: ['wool'] } })).rejects.toThrow('does not vary by material')
    await expect(setFamilyValueOrder('fam', { expectedVersion: 7, order: { color: ['black', 'purple'] } })).rejects.toThrow('purple is not a value of Color')
    await expect(setFamilyValueOrder('fam', { expectedVersion: 7, order: { color: ['black', 'black'] } })).rejects.toThrow('black twice')
    expect((await order()).version).toBe(7)
  })
  it('refuses a stale family version with 409 and a child with 400', async () => {
    await coded()
    const stale = await setFamilyValueOrder('fam', { expectedVersion: 6, order: { color: ['red'] } }).catch(e => e)
    expect(stale).toBeInstanceOf(FamilyVariationError)
    expect(stale.status).toBe(409)
    const child = await setFamilyValueOrder('v1', { expectedVersion: 2, order: { color: ['red'] } }).catch(e => e)
    expect(child.status).toBe(400)
  })
})
