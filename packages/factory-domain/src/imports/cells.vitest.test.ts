import { describe, expect, it } from 'vitest'
import { cell, cellMetaOf, foldWord, isBlank, plainDecimal, readDate, readNumberText, sameValue, type NumberFormat, type RawCell } from './cells'
import { Dec } from '../tax/decimal'

const it_ = { numberFormat: 'it' as NumberFormat }
const en = { numberFormat: 'en' as NumberFormat }
const parse = (schema: ReturnType<(typeof cell)[keyof typeof cell]>, raw: RawCell, context = it_) => schema.safeParse({ raw, context })
const value = (schema: ReturnType<(typeof cell)[keyof typeof cell]>, raw: RawCell, context = it_) => {
  const result = parse(schema, raw, context)
  if (!result.success) throw new Error(result.error.issues[0]?.message)
  return result.data
}
const message = (schema: ReturnType<(typeof cell)[keyof typeof cell]>, raw: RawCell, context = it_) => {
  const result = parse(schema, raw, context)
  return result.success ? null : result.error.issues[0]?.message
}

describe('numbers written by people', () => {
  it.each([
    ['1.234,56', '1234.56'],
    ['1234,56', '1234.56'],
    ['-1.234.567,5', '-1234567.5'],
    ['1.234', '1234'],
    ['12.5', '12.5'],
    ['0,75', '0.75'],
    [' 1 234,50 € ', '1234.50'],
    ['€12', '12'],
    ['+3', '3'],
    ['-0', '0'],
  ])('Italian %s → %s', (text, expected) => {
    expect(readNumberText(text, 'it')).toBe(expected)
  })

  it.each([
    ['1,234.56', '1234.56'],
    ['1,234', '1234'],
    ['12,5', '12.5'],
    ['1234.5', '1234.5'],
  ])('English %s → %s', (text, expected) => {
    expect(readNumberText(text, 'en')).toBe(expected)
  })

  it.each(['abc', '1,2,3', '1.234,5,6', ',5', '5,', '1.23.4', '12a', '1e5', '', '-', '1,234.56'])('refuses %j in the Italian format', (text) => {
    expect(readNumberText(text, 'it')).toBeNull()
  })

  it('reads an Excel number as its shortest decimal text, never through a float sum', () => {
    expect(value(cell.decimal({ scale: 6 }), 0.1)).toBe('0.1')
    expect(value(cell.decimal({ scale: 2 }), 1234.56)).toBe('1234.56')
    expect(value(cell.minorUnits(), 19.99)).toBe(1999)
  })
})

describe('the cell builders', () => {
  it('decimal: canonical text, scale and size checked', () => {
    const price = cell.decimal({ precision: 18, scale: 6 })
    expect(value(price, '12,500000')).toBe('12.5')
    expect(value(price, '1.234,5678')).toBe('1234.5678')
    expect(message(price, '1,1234567')).toBe('At most 6 decimals.')
    expect(message(price, 'dodici')).toBe('Expected a number like 1.234,56 or 1234,56.')
    expect(message(price, 'dodici', en)).toBe('Expected a number like 1,234.56 or 1234.56.')
    expect(message(cell.decimal({ precision: 4, scale: 2 }), '100')).toBe('At most 2 digits before the decimals.')
    expect(message(cell.decimal({ min: '0' }), '-1')).toBe('At least 0.')
  })

  it('minorUnits: an amount in euros to cents, half-cents refused', () => {
    expect(value(cell.minorUnits(), '1.234,56')).toBe(123456)
    expect(value(cell.minorUnits(), '7')).toBe(700)
    expect(message(cell.minorUnits(), '1,005')).toBe('At most 2 decimals.')
    expect(message(cell.minorUnits(), '99.999.999,00')).toBe('The amount is too large.')
  })

  it('integer: whole numbers in range', () => {
    expect(value(cell.integer(), '1.234')).toBe(1234)
    expect(value(cell.integer(), 42)).toBe(42)
    expect(message(cell.integer(), '1,5')).toBe('Expected a whole number, without decimals.')
    expect(message(cell.integer({ min: 0, max: 10 }), '11')).toBe('Expected a whole number from 0 to 10.')
  })

  it('date: Italian day-first, ISO, two-digit years, Excel dates and serials', () => {
    const date = cell.date()
    expect(value(date, '31/12/2026')).toBe('2026-12-31')
    expect(value(date, '1.2.2026')).toBe('2026-02-01')
    expect(value(date, '31-12-26')).toBe('2026-12-31')
    expect(value(date, '2026-12-31')).toBe('2026-12-31')
    expect(value(date, new Date(Date.UTC(2026, 11, 31)))).toBe('2026-12-31')
    expect(value(date, 46387)).toBe('2026-12-31')
    expect(message(date, '31/02/2026')).toBe('Expected a date like 31/12/2026 or 2026-12-31.')
    expect(message(date, '12/31/2026')).toBe('Expected a date like 31/12/2026 or 2026-12-31.')
    expect(readDate(true)).toBeNull()
  })

  it('boolean: Italian and English words', () => {
    for (const yes of ['Sì', 'si', 'YES', 'vero', 'x', '1', true]) expect(value(cell.boolean(), yes)).toBe(true)
    for (const no of ['No', 'falso', 'false', '0', false]) expect(value(cell.boolean(), no)).toBe(false)
    expect(message(cell.boolean(), 'forse')).toBe('Expected sì or no (yes or no).')
  })

  it('oneOf: without case or accents, and by alias', () => {
    const kind = cell.oneOf(['CUSTOMER', 'SUPPLIER'], { cliente: 'CUSTOMER', fornitore: 'SUPPLIER' })
    expect(value(kind, 'customer')).toBe('CUSTOMER')
    expect(value(kind, 'Fornitore')).toBe('SUPPLIER')
    expect(message(kind, 'mago')).toBe('Expected one of CUSTOMER, SUPPLIER.')
    expect(cellMetaOf(kind)).toMatchObject({ kind: 'oneOf', values: ['CUSTOMER', 'SUPPLIER'] })
  })

  it('text, code and email', () => {
    expect(value(cell.text(), '  Giacca  da moto ')).toBe('Giacca  da moto')
    expect(message(cell.text({ max: 3 }), 'abcd')).toBe('At most 3 characters.')
    expect(value(cell.text(), 12.5)).toBe('12.5')
    expect(value(cell.code({ upper: true }), ' ab-12 ')).toBe('AB-12')
    expect(message(cell.code(), 'AB 12')).toBe('A code has no spaces.')
    expect(value(cell.email(), ' Mario.Rossi@Example.com ')).toBe('mario.rossi@example.com')
    expect(message(cell.email(), 'not-an-email')).toBe('Expected an email address.')
  })

  it('never repeats the cell in a message', () => {
    const secret = '98.765,43'
    for (const schema of [cell.integer(), cell.minorUnits({ places: 0 }), cell.date(), cell.boolean(), cell.oneOf(['A']), cell.email(), cell.code({ max: 2 })]) {
      const text = message(schema, secret)
      expect(text).not.toBeNull()
      expect(text).not.toContain('98')
    }
  })
})

describe('helpers', () => {
  it('blank cells', () => {
    expect([null, undefined, '', '   '].every((raw) => isBlank(raw))).toBe(true)
    expect([0, false, 'x'].some((raw) => isBlank(raw))).toBe(false)
  })

  it('compares decimals by value, other kinds exactly', () => {
    const meta = cellMetaOf(cell.decimal())
    expect(sameValue(meta, '12.50', '12.5')).toBe(true)
    expect(sameValue(meta, '12.5', '12.51')).toBe(false)
    expect(sameValue(cellMetaOf(cell.text()), 'A', 'a')).toBe(false)
    expect(sameValue(meta, null, '0')).toBe(false)
    expect(plainDecimal(new Dec('12.500'))).toBe('12.5')
    expect(foldWord('  Perché  Sì ')).toBe('perche si')
  })
})
