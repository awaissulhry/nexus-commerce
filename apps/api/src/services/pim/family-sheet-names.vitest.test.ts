/**
 * W3-3 (product sheet consistency wave 3, E5, Owner decision 5, 2026-10-05) — the Shared product's dictionary names in
 * English, whatever the content language: an option by its own English label, else the concept's English name for the
 * value, else its label; a field the same way. The content-language names stay accepted (options: `optionAliases`;
 * the field: `formerNames`, for a header paste), and the option CODE stored is unchanged.
 * Run: npx vitest run src/services/pim/family-sheet-names.vitest.test.ts
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))
vi.mock('../family-hierarchy.service.js', () => ({ familyHierarchyService: {} }))

import { toFieldDefinition } from './family-sheet-schema.js'
import { buildSheetColumns } from './sheet-columns.service.js'
import { optionCodeFor } from './import-diff.service.js'
import { buildCoordinateValidators, evaluateRow } from './readiness.service.js'

const group = { id: 'g', code: 'variation', label: 'Variation' }
const option = (code: string, label: string, labels?: Record<string, string>) => ({ id: code, code, label, sortOrder: 0, archivedAt: null, synonyms: [], metadata: labels ? { labels } : null })
const attribute = (over: Record<string, unknown>) => ({
  id: 'a', code: 'color', label: 'Colore', type: 'select', scope: 'per_variant', localizable: false, description: null, semanticKey: null,
  validation: null, group, options: [], ...over,
}) as never

// A business's colour attribute as it was adopted: Italian names, linked to the colour concept.
const color = attribute({
  code: 'color', label: 'Colore', semanticKey: 'color', validation: { labels: { it: 'Colore' } },
  options: [
    option('black', 'Nero', { en: 'Black', it: 'Nero', de: 'Schwarz' }),
    option('rosso', 'Rosso'),                 // no labels of its own: the concept knows Rosso is Red
    option('verde_acido', 'Verde acido'),     // the concept does not know it: its own label, nothing else
  ],
})
const size = attribute({
  id: 's', code: 'size', label: 'Size', semanticKey: 'size', validation: { labels: { it: 'Taglia', en: 'Size' } },
  options: [option('one_size', 'Taglia unica', { en: 'One Size', it: 'Taglia unica' }), option('xs', 'XS')],
})

describe('toFieldDefinition — Shared names in English (W3-3)', () => {
  it('names the field and its options in English; the Italian names become accepted spellings', () => {
    const field = toFieldDefinition(color, 'it')
    expect(field).toMatchObject({ id: 'attr_color', label: 'Color', formerNames: ['Colore'], options: ['black', 'rosso', 'verde_acido'] })
    expect(field.optionLabels).toEqual({ black: 'Black', rosso: 'Red', verde_acido: 'Verde acido' })
    expect(field.optionAliases).toEqual({ black: ['Nero'], rosso: ['Rosso'] })
  })

  it('takes a field\'s own English label first, and a value without separate words keeps one name', () => {
    const field = toFieldDefinition(size, 'it')
    expect(field).toMatchObject({ label: 'Size', formerNames: ['Taglia'], optionLabels: { one_size: 'One Size', xs: 'XS' }, optionAliases: { one_size: ['Taglia unica'] } })
    const lining = toFieldDefinition(attribute({ code: 'lining', label: 'Fodera', type: 'text', validation: { labels: { en: 'Lining', it: 'Fodera' } } }), 'it')
    expect(lining).toMatchObject({ label: 'Lining', formerNames: ['Fodera'] })
    expect(lining.optionAliases).toBeUndefined()
  })

  it('the content language decides the accepted spellings, never the name shown', () => {
    const field = toFieldDefinition(color, 'de')
    expect(field.label).toBe('Color')
    expect(field.optionLabels?.black).toBe('Black')
    expect(field.optionAliases?.black).toEqual(['Schwarz', 'Nero'])
  })

  it('an attribute with only an English name carries no other spelling', () => {
    const plain = toFieldDefinition(attribute({ code: 'fit', label: 'Fit', type: 'text' }), 'it')
    expect(plain.label).toBe('Fit')
    expect(plain.formerNames).toBeUndefined()
  })

  it('on the Shared sheet: English names shown, the Italian word still resolves on paste, import and readiness', () => {
    const { columns } = buildSheetColumns({ fields: [toFieldDefinition(color, 'it')], coordinates: [], scopeKind: 'master' })
    const column = columns.find(c => c.key === 'color')!
    expect(column).toMatchObject({ label: 'Color', formerNames: ['Colore'], optionLabels: { black: 'Black', rosso: 'Red' }, optionAliases: { black: ['Nero'], rosso: ['Rosso'] } })
    for (const typed of ['Nero', 'Black', 'black']) expect(optionCodeFor(column, typed)).toBe('black')
  })

  it('readiness gives a stored Italian word, English name or code the same answer as when the names were Italian', () => {
    const now = toFieldDefinition(color, 'it')
    // The field as it was built before W3-3: Italian names, no other spellings.
    const before = { ...now, label: 'Colore', optionLabels: { black: 'Nero', rosso: 'Rosso', verde_acido: 'Verde acido' }, optionAliases: undefined, formerNames: undefined }
    const master = { channel: 'MASTER' as never, marketplace: 'GLOBAL', label: 'Master', inMarket: true }
    const issues = (field: typeof now, value: string) => evaluateRow({ color: value }, buildCoordinateValidators(
      buildSheetColumns({ fields: [field], coordinates: [], scopeKind: 'master' }).columns, master, { isParent: false, productType: null }))
      .filter(i => i.field === 'color').map(i => i.severity)
    for (const value of ['black', 'Nero', 'Rosso', 'Plutonio']) expect(issues(now, value), value).toEqual(issues(before, value))
  })
})
