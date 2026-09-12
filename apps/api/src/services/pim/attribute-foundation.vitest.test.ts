import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))

import { savedAttributeFields } from './family-sheet-schema.js'
import { validClassificationChange } from './product-classification.js'
import { buildSheetColumns, type SheetCoordinate } from './sheet-columns.service.js'
import { ebaySpecFromCache } from './channel-specs/ebay.js'
import { amazonClassificationSpec, amazonSpecFromDefinition } from './channel-specs/amazon.js'
import { columnApplies, columnForCategory, columnRequiredHere } from '@nexus/shared/master-sheet'
import { coerceForShape } from './sheet-values.js'
import { resolveAttributes } from './attribute-resolver.js'
import { buildAxes } from './studio-sheet.service.js'

const ebay: SheetCoordinate = { channel: 'EBAY', marketplace: 'IT', label: 'eBay · IT', inMarket: true }

describe('family-owned Master', () => {
  it('keeps shared bullet points in one uncapped list while channel slots remain category-specific', () => {
    const { columns } = buildSheetColumns({ familySchema: true, fields: [{ id: 'bulletPoints', label: 'Bullet points', type: 'text', category: 'content', editable: true }], coordinates: [], scopeKind: 'master' })
    expect(columns).toHaveLength(1)
    expect(columns[0]).toMatchObject({ key: 'bulletPoints', shape: 'list', cardinality: { min: 0, max: null } })
  })
  it('keeps localized family keys canonical and closed lists strict', () => {
    const { columns } = buildSheetColumns({ familySchema: true, fields: [{ id: 'attr_finish', label: 'Finish', category: 'category', type: 'select', options: ['matte', 'gloss'], localizable: true, editable: true }], coordinates: [], scopeKind: 'master' })
    expect(columns[0]).toMatchObject({ key: 'finish', storage: 'localizedContent', mode: 'strict' })
  })
  it('keeps shared definitions and historical values without importing Amazon requirements', () => {
    const amazon: SheetCoordinate = { ...ebay, channel: 'AMAZON', label: 'Amazon · IT' }
    const spec = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'COAT', schemaDefinition: { properties: { amazon_only: { type: 'string' } } } })
    const { columns } = buildSheetColumns({ familySchema: true, fields: [
      { id: 'name', label: 'Name', type: 'text', category: 'universal', editable: true, required: true },
      { id: 'attr_lining', label: 'Lining', type: 'text', category: 'category', group: { key: 'master:attributes', label: 'Specifications' }, scope: 'per_variant', editable: true },
      ...savedAttributeFields([{ discontinued_detail: 'retained', variations: { Size: 'L' } }]),
    ], specs: [{ coordinate: amazon, spec }], coordinates: [amazon], scopeKind: 'master' })
    expect(columns.map(c => c.key)).toEqual(['name', 'lining', 'discontinued_detail'])
    expect(columns[0].requiredBy).toEqual(['Master'])
    expect(columns[1].scope).toBe('per_variant')
    expect(columns[2].group).toBe('Additional saved attributes')
  })

  it('preserves structured historical values without offering a destructive scalar edit', () => {
    const fields = savedAttributeFields([{ complex: [{ zone: 'elbow', level: '2' }], tags: ['a', 'b'] }])
    expect(fields.find(f => f.id === 'attr_complex')?.editable).toBe(false)
    expect(fields.find(f => f.id === 'attr_tags')?.shape).toBe('list')
  })
})

describe('category-specific channel rules', () => {
  it('keeps localized declared axes per-variant across category schemas and dictionary defaults', () => {
    const coordinate: SheetCoordinate = { ...ebay, channel: 'AMAZON', label: 'Amazon · DE', marketplace: 'DE' }
    const spec = amazonSpecFromDefinition({ marketplace: 'DE', productType: 'COAT', schemaDefinition: {
      properties: { color: { type: 'string', title: 'Farbe' }, size: { type: 'string', title: 'Größe' } },
    } })
    const { columns } = buildSheetColumns({ fields: [
      { id: 'attr_color', label: 'Color', type: 'text', category: 'category', scope: 'global', editable: true },
      { id: 'attr_size', label: 'Size', type: 'text', category: 'category', scope: 'global', editable: true },
    ], coordinates: [coordinate], scopeKind: 'channel', variationAxes: ['Colore', 'Taglia'], specs: [{ coordinate, spec }] })
    expect(columns.find(column => column.key === 'color')?.scope).toBe('per_variant')
    expect(columns.find(column => column.key === 'size')?.scope).toBe('per_variant')
  })

  it('exposes one shared dimension unit instead of three controls for the same stored value', () => {
    const fields = ebaySpecFromCache({ marketplace: 'IT', categoryId: '100', aspects: [] }).fields
    expect(fields.filter(f => f.key === 'dimensionUnit')).toHaveLength(1)
    for (const key of ['packageLength', 'packageWidth', 'packageHeight']) expect(fields.find(f => f.key === key)).toMatchObject({ shape: 'scalar', channelStore: { kind: 'platformAttributes', path: [key] } })
  })
  const spec = (categoryId: string, required: boolean, maxLength: number, options: string[]) => ebaySpecFromCache({
    marketplace: 'IT', categoryId, aspects: [{ id: 'aspect_Size', localizedName: 'Taglia', englishName: 'Size', required, maxLength, kind: 'enum', enumMode: 'strict', options }],
  })
  it('uses the selected leaf requirement, options and cap, with one visible aspect column', () => {
    const { columns } = buildSheetColumns({ fields: [], coordinates: [ebay], scopeKind: 'channel', specs: [
      { coordinate: ebay, spec: spec('100', true, 10, ['S', 'M']) },
      { coordinate: ebay, spec: spec('200', false, 30, ['Long']) },
    ] })
    const size = columns.find(c => c.key === 'size')!
    expect(columns.filter(c => c.key === 'size')).toHaveLength(1)
    expect(columnRequiredHere(size, ebay.label, '100')).toBe(true)
    expect(columnRequiredHere(size, ebay.label, '200')).toBe(false)
    const second = columnForCategory(size, ebay.label, '200')
    expect(second.options).toEqual(['Long'])
    expect(second.maxLength).toBe(30)
    expect(columnApplies(second, { isParent: false, productType: '300' })).toBe(false)
    expect(second.channels?.[ebay.label]?.store).toEqual({ kind: 'platformAttributes', path: ['itemSpecifics', 'Taglia'] })
  })

  it('keeps category selection available before any Amazon definition is loaded', () => {
    const coordinate: SheetCoordinate = { ...ebay, channel: 'AMAZON', label: 'Amazon · IT' }
    const { columns } = buildSheetColumns({ fields: [], coordinates: [coordinate], scopeKind: 'channel', specs: [{ coordinate, spec: amazonClassificationSpec('IT') }] })
    expect(columns[0].key).toBe('productType')
    expect(columns[0].writeField).toBe('attr_productType')
    expect(columns[0].storage).toBe('listing')
  })

  it('retains scalar number and boolean types, including zero and false', () => {
    expect(coerceForShape({ kind: 'number' }, '0')).toEqual({ ok: true, value: 0 })
    expect(coerceForShape({ kind: 'boolean' }, 'false')).toEqual({ ok: true, value: false })
    expect(coerceForShape({ kind: 'number' }, 'several').ok).toBe(false)
    expect(coerceForShape({ kind: 'boolean' }, 'sometimes').ok).toBe(false)
  })
})

describe('classification and canonical facts', () => {
  it('requires an explicit version and valid primary membership', () => {
    const change = { version: 2, familyId: 'family', categoryIds: ['category'], primaryId: 'category' }
    expect(validClassificationChange(change)).toBe(true)
    expect(validClassificationChange({ ...change, version: undefined })).toBe(false)
    expect(validClassificationChange({ ...change, primaryId: 'elsewhere' })).toBe(false)
    expect(validClassificationChange({ ...change, categoryIds: ['category', 'category'] })).toBe(false)
    expect(validClassificationChange({ ...change, categoryIds: [], primaryId: null, familyId: null })).toBe(true)
  })

  it('uses the canonical origin for channel inheritance in every locale', () => {
    const resolved = resolveAttributes({ locale: 'it', product: { id: 'p', parentId: null, countryOfOrigin: 'IT', categoryAttributes: { country_of_origin: 'DE' }, localizedContent: null, variantAttributes: null } })
    expect(resolved.country_of_origin.value).toBe('IT')
    expect(resolved.countryOfOrigin.value).toBe('IT')
  })

  it('pairs localized axis labels with stored identifiers without creating extra axes', () => {
    expect(buildAxes(['Colore', 'Taglia'], [{ Color: 'Nero', Size: 'L' }])).toEqual([
      { key: 'Color', label: 'Colore', rowsWithValue: 1, rowsTotal: 1, source: 'stored' },
      { key: 'Size', label: 'Taglia', rowsWithValue: 1, rowsTotal: 1, source: 'stored' },
    ])
  })
})
