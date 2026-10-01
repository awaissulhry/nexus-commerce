import { describe, expect, it } from 'vitest'
import { parseShape } from './shapeValue'
import { coerceTyped, commitValue } from './formulaEditing'
import { shapeColumnDef } from './shapeColumn'
import { parseScalarValue, scalarColumnDef } from './scalarValue'

describe('typed list values', () => {
  it.each([
    ['7 | 8', [7, 8]],
    [['7', '8'], [7, 8]],
    [[0, '-2.75', '1e-7'], [0, -2.75, 1e-7]],
    ['1,25 · 2,5', [1.25, 2.5]],
  ])('uses numbers for a numeric list from %j', (input, expected) => {
    const wire = parseShape('list', input, { kind: 'number' })
    expect(wire).toEqual(expected)
    expect(JSON.parse(JSON.stringify(wire))).toEqual(expected)
  })

  it('retains invalid numeric members for a named refusal, without turning them into zero or null', () => {
    expect(parseShape('list', ['7', 'wrong', 'Infinity', '3e'], { kind: 'number' })).toEqual([7, 'wrong', 'Infinity', '3e'])
    expect(parseShape('list', [' ', '', null, '0'], { kind: 'number' })).toEqual([0])
    expect(parseShape('list', [{ value: '7' }], { kind: 'number' })).toEqual([{ value: '7' }])
  })

  it('keeps numeric-looking text and option IDs as text', () => {
    expect(parseShape('list', ['007', '7'], { kind: 'text' })).toEqual(['007', '7'])
    expect(parseShape('list', 'Seven', { kind: 'select', options: ['007'], optionLabels: { '007': 'Seven' } })).toEqual(['007'])
    expect(parseShape('list', 'Seven', { kind: 'number', options: ['7'], optionLabels: { '7': 'Seven' } })).toEqual([7])
  })

  it('keeps a formula draft whole and leaves invalid formula text inside a list visible', () => {
    const formula = '=split($brand, " ")'
    expect(parseShape('list', formula, { kind: 'number' })).toBe(formula)
    expect(parseShape('list', ['7', '=draft'], { kind: 'number' })).toEqual([7, '=draft'])
  })
  it('passes the declared number kind through the actual paste and set-column parser', () => {
    const column = shapeColumnDef({ key: 'numberList', shape: 'list', kind: 'number' }, () => [])
    if (typeof column.valueParser !== 'function') throw new Error('the shaped column has no value parser')
    expect(column.valueParser({ newValue: '7 | 8' } as never)).toEqual([7, 8])
    expect(column.valueParser({ newValue: ['7', '8'] } as never)).toEqual([7, 8])
  })
})


describe('unsafe whole numbers retain their text until the API can refuse them', () => {
  it.each(['9007199254740993', '-9007199254740993', '9007199254740992', '-9007199254740992', '9.007199254740993e15'])(
    'preserves %s in scalar, list, paste and JSON transport', text => {
      const scalar = scalarColumnDef({ kind: 'number' })
      const list = shapeColumnDef({ key: 'partners', shape: 'list', kind: 'number' }, () => [])
      if (typeof scalar.valueParser !== 'function' || typeof list.valueParser !== 'function') throw new Error('missing column parser')
      expect(parseScalarValue({ kind: 'number' }, text)).toBe(text)
      expect(scalar.valueParser({ newValue: text } as never)).toBe(text)
      const typed = parseShape('list', ['7', text], { kind: 'number' })
      const pasted = list.valueParser({ newValue: `7 | ${text}` } as never)
      expect(typed).toEqual([7, text])
      expect(pasted).toEqual([7, text])
      expect(JSON.parse(JSON.stringify({ typed, pasted }))).toEqual({ typed: [7, text], pasted: [7, text] })
    })

  it.each([Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 0, -1, 1, -1.25, 0.125])('still sends supported number %s as a number', value => {
    expect(parseScalarValue({ kind: 'number' }, String(value))).toBe(value)
    expect(parseShape('list', [String(value)], { kind: 'number' })).toEqual([value])
  })

  it('leaves large text IDs and formulas unchanged', () => {
    expect(parseScalarValue({ kind: 'text' }, '9007199254740993')).toBe('9007199254740993')
    expect(parseShape('list', ['9007199254740993'], { kind: 'text' })).toEqual(['9007199254740993'])
    expect(parseShape('list', '=9007199254740993', { kind: 'number' })).toBe('=9007199254740993')
  })
})


it.each(['9007199254740993', '-9007199254740993', '9.007199254740993e15'])(
  'keeps scalar editor input %s intact before it reaches the column parser', text => {
    expect(coerceTyped(text, 'number')).toBe(text)
    expect(commitValue(text, '7', 'number')).toBe(text)
    expect(JSON.parse(JSON.stringify({ value: commitValue(text, '7', 'number') }))).toEqual({ value: text })
  })


it.each([Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 0, -1.25])('keeps supported scalar editor number %s typed', value => {
  expect(coerceTyped(String(value), 'number')).toBe(value)
  expect(commitValue(String(value), '7', 'number')).toBe(value)
})
