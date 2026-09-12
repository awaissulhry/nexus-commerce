import { describe, expect, it } from 'vitest'

import { asList, asMeasure, formatList, formatMeasure, isEmptyShape, listLabelOf, listSummary, shapeTooltipLine, shapeValidation, unitSymbol } from './shapeFormat'

describe('asList / listSummary / formatList', () => {
  it('reads arrays, trims and drops empties, and reads a legacy scalar as one item', () => {
    expect(asList(['a', ' b ', '', null])).toEqual(['a', 'b'])
    expect(asList('x')).toEqual(['x'])
    expect(asList('  ')).toEqual([])
    expect(asList(null)).toEqual([])
  })
  it('summarises as count + first values', () => {
    expect(listSummary(['a', 'b', 'c', 'd'])).toEqual({ shown: ['a', 'b'], more: 2, total: 4 })
    expect(formatList(['a', 'b'])).toBe('a · b')
  })
})

describe('asMeasure / formatMeasure / unitSymbol', () => {
  it('reads {value, unit}, a bare number, and "1.2 kg" (read-compat)', () => {
    expect(asMeasure({ value: 1.2, unit: 'kilograms' })).toEqual({ value: 1.2, unit: 'kilograms' })
    expect(asMeasure({ value: '1,5', unit: 'GRAM' })).toEqual({ value: 1.5, unit: 'GRAM' })
    expect(asMeasure(3)).toEqual({ value: 3, unit: null })
    expect(asMeasure('1.2 kg')).toEqual({ value: 1.2, unit: 'kg' })
    expect(asMeasure('')).toEqual({ value: null, unit: null })
  })
  it('the cell reads a symbol, the word stays for the tooltip; unknown units are never invented', () => {
    expect(unitSymbol('kilograms')).toBe('kg')
    expect(unitSymbol('KILOGRAM')).toBe('kg')
    expect(unitSymbol('furlongs')).toBe('furlongs')
    expect(formatMeasure({ value: 1.2, unit: 'kilograms' })).toBe('1.2 kg')
    expect(formatMeasure({ value: 1200, unit: null })).toBe('1200')
    expect(formatMeasure({ value: null, unit: null })).toBe('')
  })
  it('isEmptyShape per shape', () => {
    expect(isEmptyShape('list', [])).toBe(true)
    expect(isEmptyShape('list', ['a'])).toBe(false)
    expect(isEmptyShape('measure', { value: null, unit: null })).toBe(true)
    expect(isEmptyShape('measure', { value: 0, unit: 'g' })).toBe(false)
    expect(isEmptyShape(undefined, '')).toBe(true)
  })
})

describe('shapeTooltipLine', () => {
  it('names the whole list, the cap and whose cap it is', () => {
    expect(shapeTooltipLine({ shape: 'list', cardinality: { min: 0, max: 15 }, capFrom: 'Amazon · IT', requiredBy: [] }, ['a', 'b'])).toBe('2 values of up to 15 (Amazon · IT): a · b')
    expect(shapeTooltipLine({ shape: 'list', requiredBy: [] }, [])).toBeUndefined()
  })
  it('spells the unit out and lists the channel units', () => {
    expect(shapeTooltipLine({ shape: 'measure', unitOptions: ['grams', 'kilograms'], requiredBy: [] }, { value: 1.2, unit: 'kilograms' })).toBe('1.2 kilograms · units: grams, kilograms')
  })
})

describe('shapeValidation', () => {
  const list = { shape: 'list' as const, cardinality: { min: 0, max: 3 }, maxLength: 5, capFrom: 'Amazon · IT', requiredBy: ['Amazon · IT'] }
  it('list: required, cardinality max and per-item cap, each naming whose cap', () => {
    const v = shapeValidation<unknown>(list, true)
    expect(v.validate([], {}, 'k')).toEqual({ level: 'error', message: 'Required' })
    expect(v.validate(['a', 'b', 'c', 'd'], {}, 'k')).toEqual({ level: 'error', message: '4 of 3 values — Amazon · IT' })
    expect(v.validate(['toolong'], {}, 'k')).toEqual({ level: 'error', message: '7 of 5 characters in one value — Amazon · IT' })
    expect(v.validate(['ok', 'yes'], {}, 'k')).toEqual({ level: null })
    expect(shapeValidation<unknown>(list, false).validate([], {}, 'k')).toEqual({ level: null })
  })
  it('measure: complete only with value AND unit; a foreign unit warns', () => {
    const v = shapeValidation<unknown>({ shape: 'measure', unitOptions: ['grams', 'kilograms'], requiredBy: ['Amazon · IT'] }, true)
    expect(v.validate({ value: null, unit: null }, {}, 'k')).toEqual({ level: 'error', message: 'Required' })
    expect(v.validate({ value: 1.2, unit: null }, {}, 'k')).toEqual({ level: 'error', message: '1.2 without a unit' })
    expect(v.validate({ value: null, unit: 'grams' }, {}, 'k')).toEqual({ level: 'error', message: 'A unit without a value' })
    expect(v.validate({ value: 1.2, unit: 'stone' }, {}, 'k').level).toBe('warn')
    expect(v.validate({ value: 1.2, unit: 'Kilograms' }, {}, 'k')).toEqual({ level: null })
  })
})

describe('closed-list labels (#669 for lists)', () => {
  it('a code shows as its channel label; a code without one shows as itself', () => {
    const labelOf = listLabelOf({ optionLabels: { not_applicable: 'Nicht zutreffend' } })
    expect(labelOf('not_applicable')).toBe('Nicht zutreffend')
    expect(labelOf('ghs')).toBe('ghs')
    expect(shapeTooltipLine({ shape: 'list', requiredBy: [], optionLabels: { a: 'Alpha' } }, ['a', 'b'])).toBe('2 values: Alpha · b')
  })
})
