import { describe, expect, it } from 'vitest'

import { composeSheetCellClassRules, sheetValidationFor, SHEET_SHORTCUT_HINT } from './sheetColumn'

type Row = { id: string; isParent: boolean }

describe('sheetValidationFor', () => {
  const col = { kind: 'longtext', requiredBy: ['amazon:IT'], maxLength: 5 }

  /* The gate the channel never had: a column that does not apply to a row has nothing to be wrong
     about, and validating it anyway paints "required" on a cell the operator cannot fill. */
  it('validates when the column applies and stays silent when it does not', () => {
    const v = sheetValidationFor<Row>(col, (r) => !r.isParent)
    expect(v.validate('toolong', { id: 'c', isParent: false }, 'k').level).not.toBeNull()
    expect(v.validate('toolong', { id: 'p', isParent: true }, 'k').level).toBeNull()
  })

  it('uses the select validator for selects and the length validator otherwise', () => {
    const sel = sheetValidationFor<Row>({ kind: 'select', options: ['A'], mode: 'strict', requiredBy: [] }, () => true)
    expect(sel.validate('Z', { id: 'r', isParent: false }, 'k').level).not.toBeNull()
    expect(sel.validate('A', { id: 'r', isParent: false }, 'k').level).toBeNull()
  })
})

describe('composeSheetCellClassRules', () => {
  /* The ORDER, asserted, since it was the thing that differed between scopes. Object key order
     follows insertion, so the composed rules must list validation first, then provenance, then
     round-trip, then the sheet's own extras. */
  it('composes in the fixed order: validation → provenance → round-trip → extra', () => {
    const rules = composeSheetCellClassRules<Row>({
      validation: { validate: () => ({ level: null }) },
      provenance: { 'p-a': () => true },
      roundTrip: { 'r-a': () => true },
      extra: { 'x-a': () => true },
    })
    const keys = Object.keys(rules)
    expect(keys.indexOf('nds-cell-is-invalid')).toBeLessThan(keys.indexOf('p-a'))
    expect(keys.indexOf('p-a')).toBeLessThan(keys.indexOf('r-a'))
    expect(keys.indexOf('r-a')).toBeLessThan(keys.indexOf('x-a'))
  })
})

describe('SHEET_SHORTCUT_HINT', () => {
  it('names every part of the editing model the contract measured', () => {
    for (const part of ['Enter to edit', 'Enter again to save', 'Tab', 'drag the corner', '⌘Z']) expect(SHEET_SHORTCUT_HINT).toContain(part)
  })
})

describe('sheetValidationFor — shaped columns (AM.1)', () => {
  it('a list column validates the ARRAY, gated on applies', () => {
    const v = sheetValidationFor<Row>({ kind: 'select', shape: 'list', cardinality: { min: 0, max: 2 }, requiredBy: ['x'] }, (r) => !r.isParent)
    expect(v.validate(['a', 'b', 'c'], { id: 'c', isParent: false }, 'k').level).toBe('error')
    expect(v.validate(['a'], { id: 'c', isParent: false }, 'k').level).toBeNull()
    expect(v.validate([], { id: 'p', isParent: true }, 'k').level).toBeNull()
  })
  it('a measure column validates value + unit, not a string length', () => {
    const v = sheetValidationFor<Row>({ kind: 'number', shape: 'measure', unitOptions: ['grams'], requiredBy: ['x'] }, () => true)
    expect(v.validate({ value: 2, unit: null }, { id: 'c', isParent: false }, 'k').level).toBe('error')
    expect(v.validate({ value: 2, unit: 'grams' }, { id: 'c', isParent: false }, 'k').level).toBeNull()
  })
})
