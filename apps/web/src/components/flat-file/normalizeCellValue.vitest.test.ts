import { describe, it, expect } from 'vitest'
import { normalizeCellValue } from './normalizeCellValue'
import type { FlatFileColumn } from './FlatFileGrid.types'

const col = (over: Partial<FlatFileColumn>): FlatFileColumn => ({
  id: 'c', label: 'C', kind: 'text', width: 100, ...over,
})

// Mirrors the eBay Follow column (strict, single-value enum).
const followCol = col({ id: 'it_follow', kind: 'enum', enumMode: 'strict', options: ['Follow', 'Pinned'] })
// Mirrors the eBay Buffer column (number, min 0).
const bufferCol = col({ id: 'it_buffer', kind: 'number', min: 0 })
// Open enum (suggestions / FREE_TEXT) — must keep accepting free text.
const openEnumCol = col({ id: 'vat_rate', kind: 'enum', enumMode: 'open', options: ['0', '4', '22'] })

describe('normalizeCellValue — strict enum (Follow)', () => {
  it('normalizes a case-insensitive match to canonical casing (paste "pinned" → "Pinned")', () => {
    expect(normalizeCellValue(followCol, 'pinned')).toBe('Pinned')
    expect(normalizeCellValue(followCol, 'FOLLOW')).toBe('Follow')
    expect(normalizeCellValue(followCol, '  Follow  ')).toBe('Follow')
  })

  it('rejects an unknown value (paste "garbage" → null → previous value kept)', () => {
    expect(normalizeCellValue(followCol, 'garbage')).toBeNull()
    expect(normalizeCellValue(followCol, 'Follows')).toBeNull()
  })

  it('lets a valid value fill down unchanged', () => {
    expect(normalizeCellValue(followCol, 'Follow')).toBe('Follow')
  })

  it('allows clearing to empty', () => {
    expect(normalizeCellValue(followCol, '')).toBe('')
    expect(normalizeCellValue(followCol, '   ')).toBe('')
  })
})

describe('normalizeCellValue — number (Buffer)', () => {
  it('rejects non-numeric junk (paste "abc" → null → previous value kept)', () => {
    expect(normalizeCellValue(bufferCol, 'abc')).toBeNull()
    expect(normalizeCellValue(bufferCol, '3 units')).toBeNull()
  })

  it('clamps below-min up to min (paste "-3" → "0")', () => {
    expect(normalizeCellValue(bufferCol, '-3')).toBe('0')
    expect(normalizeCellValue(bufferCol, '-0.5')).toBe('0')
  })

  it('keeps a valid number, preserving the operator’s exact text', () => {
    expect(normalizeCellValue(bufferCol, '5')).toBe('5')
    expect(normalizeCellValue(bufferCol, ' 12 ')).toBe('12')
    expect(normalizeCellValue(col({ kind: 'number' }), '29.90')).toBe('29.90')
  })

  it('allows clearing to empty', () => {
    expect(normalizeCellValue(bufferCol, '')).toBe('')
  })
})

describe('normalizeCellValue — comma decimals (Italian operator input)', () => {
  const priceCol = col({ id: 'it_price', kind: 'number' })

  it('accepts a single comma as decimal separator, normalized to a dot', () => {
    expect(normalizeCellValue(priceCol, '12,50')).toBe('12.50')
    expect(normalizeCellValue(priceCol, ' 12,50 ')).toBe('12.50')
    expect(normalizeCellValue(priceCol, '-3,25')).toBe('-3.25')
  })

  it('rejects ambiguous thousands formats (previous value kept)', () => {
    expect(normalizeCellValue(priceCol, '1.234,56')).toBeNull()
    expect(normalizeCellValue(priceCol, '1,234,56')).toBeNull()
  })

  it('comma-decimal into buffer still respects min 0', () => {
    expect(normalizeCellValue(bufferCol, '12,50')).toBe('12.50')
    expect(normalizeCellValue(bufferCol, '-3,5')).toBe('0')
  })
})

describe('normalizeCellValue — open enum + text stay free', () => {
  it('open-enum column still accepts free text', () => {
    expect(normalizeCellValue(openEnumCol, '17.5')).toBe('17.5')
    expect(normalizeCellValue(openEnumCol, 'anything')).toBe('anything')
  })

  it('text column clamps to maxLength', () => {
    expect(normalizeCellValue(col({ kind: 'text', maxLength: 3 }), 'abcdef')).toBe('abc')
  })

  it('multi-value strict enum is treated as free text (not rejected)', () => {
    const multi = col({ kind: 'enum', enumMode: 'strict', multiValue: true, options: ['Red', 'Blue'] })
    expect(normalizeCellValue(multi, 'Red,Blue')).toBe('Red,Blue')
  })
})

describe('normalizeCellValue — boolean coercion', () => {
  it('coerces truthy/falsy tokens and blanks the unrecognized', () => {
    const b = col({ kind: 'boolean' })
    expect(normalizeCellValue(b, 'yes')).toBe('true')
    expect(normalizeCellValue(b, 'N')).toBe('false')
    expect(normalizeCellValue(b, 'maybe')).toBe('')
  })
})
