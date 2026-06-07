/** FFA.1 — locale number parser tests. */
import { describe, it, expect } from 'vitest'
import { parseLocaleNumber, parseLocaleInt } from './parse-locale-number.js'

describe('parseLocaleNumber', () => {
  it('plain + already-numeric', () => {
    expect(parseLocaleNumber(19.99)).toBe(19.99)
    expect(parseLocaleNumber('19.99')).toBe(19.99)
    expect(parseLocaleNumber('1234')).toBe(1234)
  })
  it('EU comma decimal (the bug: "19,99" must be 19.99 not 19)', () => {
    expect(parseLocaleNumber('19,99')).toBe(19.99)
    expect(parseLocaleNumber('1,5')).toBe(1.5)
    expect(parseLocaleNumber('0,99')).toBe(0.99)
  })
  it('thousands separators', () => {
    expect(parseLocaleNumber('1.234,56')).toBe(1234.56) // EU
    expect(parseLocaleNumber('1,234.56')).toBe(1234.56) // US
    expect(parseLocaleNumber('1,234')).toBe(1234)        // comma thousands, no decimal
    expect(parseLocaleNumber('1.234.567')).toBe(1234567) // EU multi-dot thousands
  })
  it('strips currency symbols + spaces', () => {
    expect(parseLocaleNumber('€19,99')).toBe(19.99)
    expect(parseLocaleNumber('19,99 €')).toBe(19.99)
    expect(parseLocaleNumber('  £ 12.50 ')).toBe(12.5)
  })
  it('negatives', () => {
    expect(parseLocaleNumber('-5,50')).toBe(-5.5)
  })
  it('empty / junk → null', () => {
    expect(parseLocaleNumber('')).toBeNull()
    expect(parseLocaleNumber(null)).toBeNull()
    expect(parseLocaleNumber(undefined)).toBeNull()
    expect(parseLocaleNumber('abc')).toBeNull()
    expect(parseLocaleNumber(NaN)).toBeNull()
  })
})

describe('parseLocaleInt', () => {
  it('truncates to integer', () => {
    expect(parseLocaleInt('10')).toBe(10)
    expect(parseLocaleInt('10,9')).toBe(10)
    expect(parseLocaleInt('1.000')).toBe(1000) // EU thousands
    expect(parseLocaleInt('')).toBeNull()
  })
})
