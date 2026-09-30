import { describe, it, expect } from 'vitest'
import { optionVerdict } from './cell-formula.service.js'

// Option validation is shared with previews; saving a non-price formula is separately refused.
// P1 (`pim/value-verdict.ts`, the Owner's full-control rule) — an off-list formula result is STORED like a typed value
// and named in a warning; the channel refuses it at publish when it must.
const column = { label: 'Are batteries included?', options: ['false', 'true'] }
const catalogueField = { label: 'Le batterie sono incluse?', options: ['false', 'true'],
  optionLabels: { false: 'No', true: 'Sì' }, selectionOnly: true }
const validate = (value: unknown) => optionVerdict({ column, catalogueField: catalogueField as never, value })

describe('option verdict labels and normalization', () => {
  it('keeps an off-list value and names the sheet header, using the catalogue option labels', () => {
    const result = validate('maybe')
    if (!result.ok) throw new Error('an off-list value was refused')
    expect(result.value).toBe('maybe')
    expect(result.warning).toContain(column.label)
    expect(result.warning).not.toContain(catalogueField.label)
    expect(result.warning).toContain('No, Sì')
    expect(result.warning).toContain('the channel may refuse it at publish')
    expect(result.allowedOptions).toEqual(['false', 'true'])
    expect(result.actualValue).toBe('maybe')
  })
  it('normalizes valid option codes before storage', () => {
    expect(validate(' TRUE ')).toEqual({ ok: true, value: 'true' })
    expect(optionVerdict({ column, catalogueField: null, value: ' TRUE ' })).toEqual({ ok: true, value: 'true' })
  })
  it('bounds the explanation without losing the complete allowed set', () => {
    const result = optionVerdict({ catalogueField: null, column: { label: 'Codes', options: Array.from({ length: 100 }, (_, i) => `H${200 + i}`) }, value: 'NOPE' })
    if (!result.ok) throw new Error('an off-list value was refused')
    expect(result.warning).toContain('(100 in all)')
    expect(result.warning!.length).toBeLessThan(220)
    expect(result.allowedOptions).toHaveLength(100)
  })
  it('report 6 I-12 — an OPEN list takes a value that is not on it (="Xavia Racing" on Brand), without the publish caution', () => {
    const brand = { label: 'Brand', options: ['- Senza marca/Generico -', 'Alpinestars'] }
    const result = optionVerdict({ column: brand, catalogueField: { ...brand, selectionOnly: false }, value: 'Xavia Racing' })
    if (!result.ok) throw new Error('an open-list value was refused')
    expect(result.value).toBe('Xavia Racing')
    expect(result.warning).toContain('"Xavia Racing" is not in the list for Brand')
    expect(result.warning).not.toContain('refuse')
  })
  it('report 6 I-12 — a LIST result is checked member by member (=split("Uomo,Donna",",")), each normalised', () => {
    const fits = { label: 'Suitable for', options: ['Uomo', 'Donna', 'Unisex'] }
    expect(optionVerdict({ column: fits, catalogueField: null, value: ['uomo', 'Donna'] })).toEqual({ ok: true, value: ['Uomo', 'Donna'] })
    const mixed = optionVerdict({ column: fits, catalogueField: null, value: ['Uomo', 'Bambino'] })
    if (!mixed.ok) throw new Error('a list result was refused')
    expect(mixed.value).toEqual(['Uomo', 'Bambino'])
    expect(mixed.warning).toContain('"Bambino" is not in the list for Suitable for')
    expect(mixed.warning).not.toContain('"Uomo"')
  })
})
