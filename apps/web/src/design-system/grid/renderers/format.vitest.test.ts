import { describe, expect, it } from 'vitest'

import { formatGridValue, type GridValueKind } from './format'

const KINDS: GridValueKind[] = ['integer', 'money', 'money2', 'eur', 'percent', 'delta', 'date', 'text']

describe('formatGridValue — a null is never a zero', () => {
  it.each(KINDS)('%s: null / undefined / NaN are EMPTY (dash, no title), never "0"', (kind) => {
    for (const v of [null, undefined, Number.NaN, '']) {
      const f = formatGridValue(kind, v)
      expect(f.empty).toBe(true)
      expect(f.measuredZero).toBe(false)
      expect(f.text).toBe('')
    }
  })

  it.each(['integer', 'money', 'money2', 'eur', 'percent', 'delta'] as const)('%s: a measured zero is NOT empty', (kind) => {
    const f = formatGridValue(kind, 0)
    expect(f.empty).toBe(false)
    expect(f.measuredZero).toBe(false)
    expect(f.text).not.toBe('')
  })

  it('zero:"dash" keeps the distinction — measuredZero, not empty', () => {
    const f = formatGridValue('money', 0, { zero: 'dash' })
    expect(f).toEqual({ text: '', empty: false, measuredZero: true })
    // and a null under the same option is still just empty
    expect(formatGridValue('money', null, { zero: 'dash' })).toEqual({ text: '', empty: true, measuredZero: false })
  })

  it('formats through design-system/lib only', () => {
    expect(formatGridValue('integer', 12345).text).toBe('12,345')
    expect(formatGridValue('money', 123456).text).toBe('€1,235')
    expect(formatGridValue('money2', 123456).text).toBe('€1,234.56')
    expect(formatGridValue('eur', 74.95).text).toBe('€74.95')
    expect(formatGridValue('eur', 1234.5).text).toBe('€1,234.50')
    expect(formatGridValue('percent', 0.1534).text).toBe('15.3%')
    expect(formatGridValue('percent', 0.1534, { dp: 2 }).text).toBe('15.34%')
    expect(formatGridValue('delta', 12).text).toBe('+12')
    expect(formatGridValue('delta', -4).text).toBe('−4')
    expect(formatGridValue('delta', 0).text).toBe('0')
    expect(formatGridValue('text', 'abc').text).toBe('abc')
  })

  it('a numeric string is a number; a non-numeric string in a number column is EMPTY, not 0', () => {
    expect(formatGridValue('integer', '42').text).toBe('42')
    expect(formatGridValue('integer', 'n/a').empty).toBe(true)
  })

  it('date: an unparseable value is EMPTY', () => {
    expect(formatGridValue('date', 'not a date').empty).toBe(true)
    expect(formatGridValue('date', '2026-08-28T10:00:00Z').empty).toBe(false)
  })
})
