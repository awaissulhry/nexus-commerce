import { describe, expect, it } from 'vitest'
import { booleanLabel, BOOLEAN_OPTIONS, parseScalarValue, scalarColumnDef, SHEET_NUMBER_EDITOR_PARAMS } from './scalarValue'
import { cellValueOf, panelValueOf } from './selectPanelModel'
import { sheetValidationFor } from './sheetColumn'
import { parseShape } from './shapeValue'
import { formatMeasure } from '../renderers/shapeFormat'

describe('attribute edit values', () => {
  it.each(BOOLEAN_OPTIONS)('picking $label survives the custom editor, grid, JSON save, reload and reopening', ({ value, label }) => {
    const def = scalarColumnDef({ kind: 'boolean' })
    const parsed = (def.valueParser as Function)({ newValue: cellValueOf(value) })
    expect(parsed).toBe(value === 'true')
    const reloaded = JSON.parse(JSON.stringify(parsed))
    expect((def.valueFormatter as Function)({ value: reloaded })).toBe(label)
    expect(panelValueOf(reloaded)).toBe(value)
  })
  it.each([false, 'false', 'No', ' FALSE ', '0'])('never displays %j as Yes', value => {
    expect(booleanLabel(value)).toBe('No')
  })
  it('keeps blank, false and invalid distinct', () => {
    for (const empty of [null, undefined, '', ' ']) expect(booleanLabel(empty)).toBe('')
    expect(booleanLabel('sometimes')).toBe('sometimes')
    const validate = sheetValidationFor({ kind: 'boolean', requiredBy: ['Amazon'] }, () => true).validate
    expect(validate(false, {}, 'flag').level).toBe(null)
    expect(validate(null, {}, 'flag').level).toBe('error')
    expect(validate('sometimes', {}, 'flag').level).toBe('error')
  })
  it('converts select labels to codes without changing text, dates or numeric-looking identifiers', () => {
    const select = { kind: 'select', options: ['001', 'PK'], optionLabels: { '001': 'First', PK: 'Pakistan' } }
    expect(parseScalarValue(select, 'First')).toBe('001')
    expect(parseScalarValue(select, 'Pakistan')).toBe('PK')
    expect(parseScalarValue(select, '001')).toBe('001')
    expect(parseScalarValue({ kind: 'text' }, 'false')).toBe('false')
    expect(parseScalarValue({ kind: 'text' }, '001')).toBe('001')
    expect(parseScalarValue({ kind: 'longtext' }, 'Line 1\nLine 2')).toBe('Line 1\nLine 2')
    expect(parseScalarValue({ kind: 'date' }, '2026-09-05')).toBe('2026-09-05')
  })
  it('does not guess between duplicate option labels', () => {
    expect(parseScalarValue({ kind: 'select', options: ['a', 'b'], optionLabels: { a: 'Same', b: 'Same' } }, 'Same')).toBe('Same')
  })
  it.each([0, -12.34567, 0.000012345, 98765.4321])('preserves the full numeric value %s', value => {
    expect(parseScalarValue({ kind: 'number' }, String(value))).toBe(value)
    expect(SHEET_NUMBER_EDITOR_PARAMS.precision).toBeUndefined()
    expect(SHEET_NUMBER_EDITOR_PARAMS.min).toBeUndefined()
  })
  it('parses decimal comma but leaves invalid numeric input visible', () => {
    expect(parseScalarValue({ kind: 'number' }, '1,2345')).toBe(1.2345)
    expect(parseScalarValue({ kind: 'number' }, 'invalid')).toBe('invalid')
  })
  it('does not apply scalar conversions to lists or measures', () => {
    const list = ['false', '001']
    expect(parseScalarValue({ kind: 'boolean', shape: 'list' }, list)).toBe(list)
    expect(scalarColumnDef({ kind: 'select', shape: 'list' })).toEqual({})
  })
  it('pastes displayed list labels as the original codes and preserves invalid structures', () => {
    expect(parseShape('list', 'Pakistan · Italy', { options: ['PK', 'IT'], optionLabels: { PK: 'Pakistan', IT: 'Italy' } })).toEqual(['PK', 'IT'])
    expect(parseShape('list', [{ value: 'retain me' }])).toEqual([{ value: 'retain me' }])
  })
  it('pastes a measure with its full precision and declared unit, without converting invalid input to a clear', () => {
    const value = { value: 0.1234567, unit: 'kilograms' }
    expect(formatMeasure(value)).toBe('0.1234567 kg')
    expect(parseShape('measure', formatMeasure(value), { unitOptions: ['kilograms', 'grams'] })).toEqual(value)
    expect(parseShape('measure', 'not a measurement')).toBe('not a measurement')
    expect(parseShape('measure', '0.0000001 kilowatt_hours', { unitOptions: ['kilowatt_hours'] })).toEqual({ value: 0.0000001, unit: 'kilowatt_hours' })
    expect(parseShape('measure', '1e-7 kg', { unitOptions: ['kilograms'] })).toEqual({ value: 0.0000001, unit: 'kilograms' })
  })
})


it('preserves pasted formulas in typed and structured columns', () => {
  for (const kind of ['text', 'number', 'boolean', 'select']) expect(parseScalarValue({ kind }, '=$brand')).toBe('=$brand')
  for (const shape of ['list', 'measure'] as const) expect(parseShape(shape, '=split($brand, " ")')).toBe('=split($brand, " ")')
})
