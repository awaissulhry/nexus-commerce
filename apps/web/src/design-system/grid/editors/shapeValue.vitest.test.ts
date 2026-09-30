import { describe, expect, it } from 'vitest'
import { parseShape } from './shapeValue'
import { shapeColumnDef } from './shapeColumn'

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
