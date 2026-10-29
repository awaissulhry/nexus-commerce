import { describe, expect, it } from 'vitest'
import { formatNumber, MAX_FISCAL_NUMBER_LENGTH, parseNumber, parsePattern, PatternError, patternProblem } from './format'
import {
  defaultPattern,
  DOCUMENT_KINDS,
  FISCAL_KINDS,
  isFiscalKind,
  isScopeKey,
  isSeriesCode,
  MAX_NUMBER,
  NO_RESET_SCOPE,
  NUMBER_KINDS,
  scopeKeyFor,
  yearOfScope,
} from './kinds'

describe('number kinds and periods', () => {
  it('marks invoices, deposit invoices, credit notes and DDTs as fiscal, and nothing else', () => {
    expect(NUMBER_KINDS.filter(isFiscalKind)).toEqual(['DDT', 'INVOICE', 'DEPOSIT_INVOICE', 'CREDIT_NOTE'])
    expect(FISCAL_KINDS.every((kind) => NUMBER_KINDS.includes(kind))).toBe(true)
  })

  it('numbers a yearly series by the calendar year of the business date, a never-resetting one in ALL', () => {
    expect(scopeKeyFor('YEARLY', '2026-12-31')).toBe('2026')
    expect(scopeKeyFor('YEARLY', '2027-01-01')).toBe('2027')
    expect(scopeKeyFor('NEVER', '2027-01-01')).toBe(NO_RESET_SCOPE)
    expect(yearOfScope('2026')).toBe(2026)
    expect(yearOfScope('ALL')).toBeNull()
    expect(() => scopeKeyFor('YEARLY', '1999-12-31')).toThrow(RangeError)
    expect(() => yearOfScope('26')).toThrow(RangeError)
    expect(['ALL', '2026'].every(isScopeKey)).toBe(true)
    expect(['all', '1999', '3000', '2026a', ''].some(isScopeKey)).toBe(false)
  })

  it('takes series codes of capital letters, digits and hyphens', () => {
    expect(['MAIN', 'A', 'B-2', '2026'].every(isSeriesCode)).toBe(true)
    expect(['', 'main', '-A', 'A B', 'X'.repeat(17)].some(isSeriesCode)).toBe(false)
  })

  it('gives every document kind a default pattern that fits its reset (and FatturaPA for fiscal kinds)', () => {
    for (const kind of DOCUMENT_KINDS) {
      for (const reset of ['YEARLY', 'NEVER'] as const) expect(patternProblem(defaultPattern(kind, reset), reset, isFiscalKind(kind))).toBeNull()
    }
    expect(defaultPattern('INVOICE', 'YEARLY')).toBe('FT-{YYYY}-{N:5}')
    expect(defaultPattern('LOT', 'NEVER')).toBe('LOT-{N:6}')
  })
})

describe('formatNumber', () => {
  it.each([
    ['FT-{YYYY}-{N:5}', 42, 2026, 'FT-2026-00042'],
    ['{N}/{YYYY}', 42, 2026, '42/2026'],
    ['{N}/A', 7, null, '7/A'],
    ['DDT{YY}.{N:3}', 5, 2026, 'DDT26.005'],
    ['LOT-{N:6}', 1_234_567, null, 'LOT-1234567'],
    ['{N}', MAX_NUMBER, null, '2147483647'],
  ])('%s with %d (year %s) prints %s', (pattern, value, year, printed) => {
    expect(formatNumber(pattern, { value, year })).toBe(printed)
    expect(parseNumber(pattern, printed, year)).toBe(value)
  })

  it('refuses a number out of the Int range or a year out of range', () => {
    for (const value of [0, -1, 1.5, MAX_NUMBER + 1, Number.NaN]) expect(() => formatNumber('{N}', { value })).toThrow(RangeError)
    expect(() => formatNumber('{N}-{YYYY}', { value: 1, year: 1999 })).toThrow(RangeError)
    expect(() => formatNumber('{N}-{YYYY}', { value: 1 })).toThrow(PatternError)
  })

  it('prints different numbers for different values (so a unique printed number is a unique value)', () => {
    for (const pattern of ['{N}{YY}', '{N:3}{YYYY}', '1{N}0', 'A{N:2}B']) {
      const seen = new Map<string, number>()
      for (let value = 1; value <= 2_000; value++) {
        const printed = formatNumber(pattern, { value, year: 2026 })
        expect(seen.get(printed), `${pattern}: ${printed}`).toBeUndefined()
        seen.set(printed, value)
        expect(parseNumber(pattern, printed, 2026)).toBe(value)
      }
    }
  })
})

describe('parsePattern and patternProblem', () => {
  it.each([
    ['', /empty/],
    ['FT-{YYYY}', /needs \{N\}/],
    ['{N}-{N}', /only once/],
    ['{X}', /not a token/],
    ['{N:0}', /width is 1 to 12/],
    ['{N:13}', /width is 1 to 12/],
    ['FT {N}', /fixed text may hold/],
    ['FT-{N', /fixed text may hold/],
    ['F'.repeat(38) + '{N}', /longer than 40/],
  ])('refuses %j', (pattern, message) => {
    expect(() => parsePattern(pattern)).toThrow(PatternError)
    expect(patternProblem(pattern, 'YEARLY', false)).toMatch(message)
  })

  it('keeps the year tokens to yearly series', () => {
    expect(patternProblem('LOT-{YYYY}-{N}', 'NEVER', false)).toMatch(/year tokens fit only a series that starts again every year/)
    expect(patternProblem('LOT-{YYYY}-{N}', 'YEARLY', false)).toBeNull()
  })

  it('keeps a fiscal number within FatturaPA\'s 20 characters', () => {
    expect(patternProblem('FATTURA-{YYYY}-{N:8}', 'YEARLY', true)).toMatch(new RegExp(`at most ${MAX_FISCAL_NUMBER_LENGTH} characters`))
    expect(patternProblem('FATTURA-{YYYY}-{N:8}', 'YEARLY', false)).toBeNull()
  })
})

describe('parseNumber', () => {
  it('reads only what formatNumber prints for that series', () => {
    expect(parseNumber('FT-{YYYY}-{N:5}', 'FT-2026-00042', 2026)).toBe(42)
    expect(parseNumber('FT-{YYYY}-{N:5}', 'FT-2025-00042', 2026)).toBeNull()
    expect(parseNumber('FT-{YYYY}-{N:5}', 'FT-2026-042', 2026)).toBeNull()
    expect(parseNumber('FT-{YYYY}-{N:5}', 'FT-2026-000042', 2026)).toBeNull()
    expect(parseNumber('FT-{YYYY}-{N:5}', 'ft-2026-00042', 2026)).toBeNull()
    expect(parseNumber('{N}/A', '0/A')).toBeNull()
    expect(parseNumber('{N}', '99999999999')).toBeNull()
    expect(() => parseNumber('{N}/{YYYY}', '1/2026')).toThrow(PatternError)
  })
})
