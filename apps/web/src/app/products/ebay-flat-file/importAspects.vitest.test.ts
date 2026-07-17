/**
 * EI.5 — aspect unification + category intelligence tests.
 * Run: npx vitest run apps/web/src/app/products/ebay-flat-file/importAspects.vitest.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  deriveAspectMapping,
  auditCategoryIds,
  findMissingRequiredAspectsForImport,
} from './importAspects.pure'

describe('deriveAspectMapping', () => {
  it('pairs map to canonical aspect_{primary}; EN twins fold into the SAME target', () => {
    const m = deriveAspectMapping(
      ['Taglia (Size)', 'Colore (Color)', 'Size ⚠', 'Color ⚠'],
      new Set(['aspect_Taglia']),
    )
    expect(m.get('Taglia (Size)')).toMatchObject({ target: 'aspect_Taglia', synth: false })
    expect(m.get('Colore (Color)')).toMatchObject({ target: 'aspect_Colore', synth: true })
    expect(m.get('Size ⚠')).toMatchObject({ target: 'aspect_Taglia', foldedFrom: 'Size' })
    expect(m.get('Color ⚠')).toMatchObject({ target: 'aspect_Colore', foldedFrom: 'Color' })
  })

  it('variantAttributes junk is skipped (null); lone ⚠ headers become their own aspect', () => {
    const m = deriveAspectMapping(['variantAttributes ⚠', 'Materiale ⚠'], new Set())
    expect(m.get('variantAttributes ⚠')).toBeNull()
    expect(m.get('Materiale ⚠')).toMatchObject({ target: 'aspect_Materiale', synth: true })
  })

  it('multi-word names keep underscores; unrelated headers untouched', () => {
    const m = deriveAspectMapping(['Tipo Misura (Size Type)', 'Titolo'], new Set())
    expect(m.get('Tipo Misura (Size Type)')).toMatchObject({ target: 'aspect_Tipo_Misura' })
    expect(m.has('Titolo')).toBe(false)
  })
})

describe('auditCategoryIds', () => {
  it('flags text categories, accepts numeric and blank', () => {
    const issues = auditCategoryIds([
      { category_id: '177104' },
      { category_id: 'Giacche moto' },
      { category_id: '' },
    ])
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ rowIndex: 1, value: 'Giacche moto' })
  })
})

describe('findMissingRequiredAspectsForImport', () => {
  const columns = [
    { id: 'aspect_Marca', label: 'Marca', requiredForCategories: ['177104'] },
    { id: 'aspect_Taglia', label: 'Taglia', requiredForCategories: ['177104'] },
    { id: 'aspect_Genere', label: 'Genere', requiredForCategories: ['999'] },
  ]
  it('reports required aspects neither mapped nor present with values', () => {
    const rows = [{ category_id: '177104', aspect_Taglia: 'M' }]
    const out = findMissingRequiredAspectsForImport(rows, columns, new Set(['sku']))
    expect(out).toEqual([{ categoryId: '177104', missing: ['Marca'] }])
  })
  it('a mapped target or an on-row value satisfies the requirement', () => {
    const rows = [{ category_id: '177104', aspect_Taglia: 'M' }]
    const out = findMissingRequiredAspectsForImport(rows, columns, new Set(['aspect_Marca']))
    expect(out).toEqual([])
  })
  it('no numeric categories → no report', () => {
    expect(findMissingRequiredAspectsForImport([{ category_id: 'text' }], columns, new Set())).toEqual([])
  })
})
