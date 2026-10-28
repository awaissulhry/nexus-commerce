import { describe, expect, it } from 'vitest'
import { formatDate, formatDateTime, formatDecimal, formatMajorAmount, formatMoney, formatPercent, formatQuantity, formatUnitPrice, wallClockOf } from './format'

describe('document formatting', () => {
  it('groups digits and places decimals the Italian and the English way, from decimal strings', () => {
    expect(formatDecimal('1234567.891', 'it', 2, 2)).toBe('1.234.567,89')
    expect(formatDecimal('1234567.891', 'en', 2, 2)).toBe('1,234,567.89')
    expect(formatDecimal('-0.004', 'it', 2, 2)).toBe('0,00')
    expect(formatDecimal('0.005', 'en', 2, 2)).toBe('0.01')
    expect(() => formatDecimal('1e3', 'it')).toThrow(TypeError)
  })

  it('prints quantities with up to 4 decimals and unit prices with 2 to 6', () => {
    expect(formatQuantity('12.0000', 'it')).toBe('12')
    expect(formatQuantity('12.5000', 'it')).toBe('12,5')
    expect(formatQuantity('0.0929', 'en')).toBe('0.0929')
    expect(formatUnitPrice('18.125000', 'it')).toBe('18,125')
    expect(formatUnitPrice('18', 'en')).toBe('18.00')
    expect(formatUnitPrice('0.8125', 'it')).toBe('0,8125')
    expect(formatPercent('22', 'it')).toBe('22%')
    expect(formatPercent('12.50', 'en')).toBe('12.5%')
  })

  it('prints money from minor units with the currency sign', () => {
    expect(formatMoney(123450, 'EUR', 'it')).toBe('€ 1.234,50')
    expect(formatMoney(123450, 'EUR', 'en')).toBe('€1,234.50')
    expect(formatMoney(-15000, 'EUR', 'en')).toBe('-€150.00')
    expect(formatMoney(1000, 'CHF', 'en')).toBe('CHF 10.00')
    expect(formatMoney(1000, 'JPY', 'it')).toBe('JPY 1.000')
    expect(formatMajorAmount('10000', 'EUR', 'it')).toBe('€ 10.000,00')
  })

  it('prints dates and the wall-clock time in the company\'s zone, summer time included', () => {
    expect(formatDate('2026-10-28', 'it')).toBe('28/10/2026')
    expect(formatDate('2026-10-05', 'en')).toBe('5 Oct 2026')
    expect(() => formatDate('28/10/2026', 'it')).toThrow(RangeError)
    expect(wallClockOf(new Date('2026-03-29T00:30:00Z'), 'Europe/Rome')).toEqual({ date: '2026-03-29', time: '01:30' })
    expect(wallClockOf(new Date('2026-03-29T01:30:00Z'), 'Europe/Rome')).toEqual({ date: '2026-03-29', time: '03:30' })
    expect(formatDateTime(new Date('2026-12-31T23:15:00Z'), 'Europe/Rome', 'it')).toBe('01/01/2027 00:15')
    expect(formatDateTime(new Date('2026-12-31T23:15:00Z'), 'Europe/Rome', 'en')).toBe('1 Jan 2027, 00:15')
  })
})
