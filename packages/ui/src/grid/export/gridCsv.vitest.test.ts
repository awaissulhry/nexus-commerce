import { describe, expect, it } from 'vitest'

import { csvField, csvFileName, toCsv } from './gridCsv'

describe('csvField', () => {
  it('leaves a plain value alone', () => {
    expect(csvField('AIREON')).toBe('AIREON')
    expect(csvField(74.95)).toBe('74.95')
    expect(csvField(0)).toBe('0')
    expect(csvField(false)).toBe('false')
  })

  it('renders null and undefined as EMPTY, never as the words', () => {
    // A cell that reads "null" is worse than a blank: it looks like data.
    expect(csvField(null)).toBe('')
    expect(csvField(undefined)).toBe('')
  })

  it('quotes a field containing a comma, a quote or a newline', () => {
    expect(csvField('Giacca, Uomo')).toBe('"Giacca, Uomo"')
    expect(csvField('a\nb')).toBe('"a\nb"')
    expect(csvField('a\r\nb')).toBe('"a\r\nb"')
  })

  it('doubles inner quotes', () => {
    expect(csvField('Giubbotto "Slim"')).toBe('"Giubbotto ""Slim"""')
  })

  it('does not invent a value for an object', () => {
    // String({}) is "[object Object]", which reads as data. Empty is honest.
    expect(csvField({ a: 1 })).toBe('')
    expect(csvField([1, 2])).toBe('')
  })

  it('renders a Date as ISO', () => {
    expect(csvField(new Date('2026-07-01T00:00:00.000Z'))).toBe('2026-07-01T00:00:00.000Z')
  })
})

describe('toCsv', () => {
  const columns = [
    { header: 'SKU', value: (r: { sku: string; price: number | null }) => r.sku },
    { header: 'Price', value: (r: { sku: string; price: number | null }) => r.price },
  ]

  it('writes a header row even with no data', () => {
    expect(toCsv([], columns)).toBe('SKU,Price')
  })

  it('writes CRLF between rows', () => {
    const csv = toCsv([{ sku: 'A', price: 1 }, { sku: 'B', price: null }], columns)
    expect(csv).toBe('SKU,Price\r\nA,1\r\nB,')
  })

  it('escapes a header the same way it escapes a cell', () => {
    const csv = toCsv([], [{ header: 'Price, net', value: () => null }])
    expect(csv).toBe('"Price, net"')
  })

  it('keeps column order and calls each value once per row', () => {
    const seen: string[] = []
    const csv = toCsv([{ sku: 'A', price: 1 }], [
      { header: 'B', value: (r: { sku: string }) => { seen.push('B'); return r.sku } },
      { header: 'A', value: () => { seen.push('A'); return 'x' } },
    ])
    expect(csv).toBe('B,A\r\nA,x')
    expect(seen).toEqual(['B', 'A'])
  })
})

describe('csvFileName', () => {
  const date = new Date(2026, 7, 31) // local time, month is 0-based: 31 Aug 2026

  it('stamps the local date', () => {
    expect(csvFileName('products', { date })).toBe('products-2026-08-31.csv')
  })

  it('marks a narrowed export so two files are distinguishable', () => {
    expect(csvFileName('products', { date, filtered: true })).toBe('products-2026-08-31-filtered.csv')
  })
})
