import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * P7 (docs/attributes/PLAN.md §4.6, §10.8) — the readiness index says WHO requires each required-and-empty field.
 *
 * `completenessFor` ORs three facts into "required": the channel resolver marked the cell required (category schema,
 * Amazon's conditional rules, a mapping rule), the family requires it, or a coordinate in `requiredBy` requires it on
 * this row. The index kept only the OR. `requirementSources` names each fact that is true, so a cell can say
 * "Required by Amazon · DE" or "Required by Family: Jackets", and a filter can ask for one source.
 *
 *  - pure: each source on its own, and the Master scope (no channel resolver);
 *  - the real writer on disposable PostgreSQL: EVERY flagged entry names at least one source (the sources are the
 *    same disjuncts the count uses, so an empty list would mean a required field nobody requires), with positive
 *    controls for a family source and a channel source.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => { const { formulaDatabase } = await import('../../test-support/formula-database.js'); state.db = await formulaDatabase(); return { default: state.db.client } })
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { readinessMissingEntries, requirementSources, type MissingReadinessField } from './readiness-model.js'
import { reconcileFamilyReadiness } from './readiness-index.service.js'
import type { SheetColumn } from './sheet-columns.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const column = (extra: Partial<SheetColumn>) => ({ key: 'fit', requiredBy: [], requiredForProductTypes: [], ...extra }) as unknown as SheetColumn
const families = (id: string) => ({ fam: 'Jackets' } as Record<string, string>)[id]

describe('requirementSources — pure', () => {
  it('names the channel scope when the channel resolver marked the cell required (schema, condition or rule)', () => {
    const row = { productType: 'OUTERWEAR', values: { fit: { mapped: { requiredByRule: true } } } }
    expect(requirementSources(column({}), row, 'Amazon · IT', families)).toEqual(['Amazon · IT'])
  })
  it('names nobody on the Master scope for a resolver flag: nothing is resolved through a channel there', () => {
    const row = { productType: 'OUTERWEAR', values: { fit: { mapped: { requiredByRule: true } } } }
    expect(requirementSources(column({}), row, null, families)).toEqual([])
  })
  it('names the family, by its label, for a family requirement', () => {
    const col = column({ requiredBy: ['Master'], familyRules: { fam: { required: true, sortOrder: 0 } } })
    expect(requirementSources(col, { productType: null, familyId: 'fam', values: {} }, null, families)).toEqual(['Family: Jackets'])
  })
  it('names the shared product for the shared record\'s own requirement (no family rules)', () => {
    expect(requirementSources(column({ requiredBy: ['Master'] }), { productType: null, values: {} }, null, families)).toEqual(['Shared product'])
  })
  it('names each coordinate that requires the field on this row, and only those', () => {
    const col = column({ requiredBy: ['Amazon · IT', 'eBay · IT'], requiredForProductTypes: ['OUTERWEAR'] })
    expect(requirementSources(col, { productType: 'OUTERWEAR', values: {} }, null, families)).toEqual(['Amazon · IT', 'eBay · IT'])
    expect(requirementSources(col, { productType: 'HELMET', values: {} }, null, families)).toEqual([])
  })
  it('lists a source once when two facts name the same coordinate', () => {
    const col = column({ requiredBy: ['Amazon · IT'] })
    const row = { productType: null, values: { fit: { mapped: { requiredByRule: true } } } }
    expect(requirementSources(col, row, 'Amazon · IT', families)).toEqual(['Amazon · IT'])
  })
  it('is empty for a column the sheet does not have', () => {
    expect(requirementSources(undefined, { productType: null, values: {} }, 'Amazon · IT', families)).toEqual([])
  })
  it('puts the sources on required-and-empty entries only; an issue on a filled field carries none', () => {
    const entries = readinessMissingEntries({
      id: 'p1',
      readiness: { state: 'errors', issues: [{ key: 'color', label: 'Colour', message: 'Colour is too long', severity: 'error' }] },
      completeness: { overall: { filled: 0, total: 0, pct: 0 }, required: { filled: 0, total: 1, missing: [{ key: 'gtin', label: 'GTIN' }] }, byGroup: [] },
    } as any, field => field === 'gtin' ? ['Amazon · IT'] : ['must not appear'])
    expect(entries).toEqual([
      { productId: 'p1', field: 'color', label: 'Colour', reason: 'Colour is too long' },
      expect.objectContaining({ field: 'gtin', requiredEmpty: true, requiredBy: ['Amazon · IT'] }),
    ])
  })
})

beforeAll(() => scoped(async () => {
  // A family that requires `fit` everywhere, and a product in it with no fit: the family source's positive control.
  // No product type: on Amazon·DE `productType` is required and empty — the channel source's positive control.
  const group = await prisma.attributeGroup.create({ data: { code: 'rb', label: 'Specifications' } })
  const fit = await prisma.customAttribute.create({ data: { code: 'fit', label: 'Fit', groupId: group.id, type: 'text' } })
  const family = await prisma.productFamily.create({ data: { code: 'rb-jackets', label: 'Jackets' } })
  await prisma.familyAttribute.create({ data: { familyId: family.id, attributeId: fit.id, required: true, channels: [] } })
  await prisma.product.create({ data: { id: 'rb-parent', sku: 'RB-PARENT', name: 'Giacca', basePrice: 10, isParent: true, familyId: family.id } })
  await prisma.product.create({ data: { id: 'rb-child', sku: 'RB-CHILD', name: 'Figlio', basePrice: 10, parentId: 'rb-parent', familyId: family.id } })
  await prisma.channelConnection.create({ data: { id: 'rb-amazon', channelType: 'AMAZON', isActive: true } as any })
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'DE', name: 'DE', currency: 'EUR', region: 'EU', language: 'de', languages: ['de'] } })
  for (const productId of ['rb-parent', 'rb-child']) await prisma.channelListing.create({ data: { productId, channel: 'AMAZON', channelMarket: 'AMAZON_DE', marketplace: 'DE', region: 'EU', channelConnectionId: 'rb-amazon' } as any })
}), 30_000)
afterAll(async () => { await state.db?.close() })

describe('the one writer, on disposable PostgreSQL', () => {
  it('every flagged entry names at least one source; the family and the channel sources both appear', () => scoped(async () => {
    expect(await reconcileFamilyReadiness('rb-parent')).toBeGreaterThan(0)
    const rows = await prisma.readinessIndex.findMany({ where: { productId: { in: ['rb-parent', 'rb-child'] } } })
    const flagged = rows.flatMap(r => (r.missing as unknown as MissingReadinessField[]).filter(e => e.requiredEmpty).map(e => ({ row: `${r.productId}·${r.channel ?? 'shared'}·${r.language}`, field: e.field, requiredBy: e.requiredBy })))
    expect(flagged.length).toBeGreaterThan(0)
    for (const entry of flagged) expect({ ...entry, named: (entry.requiredBy?.length ?? 0) > 0 }).toEqual({ ...entry, named: true })
    // Positive controls: the family's own requirement on the shared rows, and Amazon's on the Amazon·DE rows.
    expect(flagged.filter(e => e.row.includes('·shared·') && e.field === 'fit').map(e => e.requiredBy)).toContainEqual(['Family: Jackets'])
    expect(flagged.filter(e => e.row.includes('·AMAZON·') && e.field === 'productType').every(e => e.requiredBy?.includes('Amazon · DE'))).toBe(true)
    expect(flagged.some(e => e.row.includes('·AMAZON·') && e.field === 'productType')).toBe(true)
  }), 60_000)
})
