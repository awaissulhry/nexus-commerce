import { describe, expect, it } from 'vitest'
import {
  amountMinor,
  businessDate,
  currency,
  errorBody,
  id,
  input,
  instant,
  output,
  quantity,
  unitPrice,
} from './contracts'
import { ERROR_CODES, ForbiddenError, isDomainError, NotFoundError, ValidationError } from './errors'
import { fitsDecimal, fromMinorUnits, minorPlaces, toMinorUnits } from './money'

describe('contract building blocks', () => {
  it('ids, days and instants', () => {
    expect(id().safeParse('0190f5c2-0000-7000-8000-000000000001').success).toBe(true)
    expect(id().safeParse('42').success).toBe(false)
    expect(businessDate().safeParse('2026-10-28').success).toBe(true)
    expect(businessDate().safeParse('2026-02-30').success).toBe(false)
    expect(instant().safeParse('2026-10-28T09:15:00.000Z').success).toBe(true)
    expect(instant().safeParse('2026-10-28T09:15:00').success).toBe(false)
  })

  it('money travels as integers in minor units and decimal strings, never floats', () => {
    expect(currency().safeParse('EUR').success).toBe(true)
    expect(currency().safeParse('eur').success).toBe(false)
    expect(amountMinor().safeParse(1250).success).toBe(true)
    expect(amountMinor().safeParse(12.5).success).toBe(false)
    expect(amountMinor().safeParse(2_147_483_648).success).toBe(false)
    expect(unitPrice().safeParse('12.123456').success).toBe(true)
    expect(unitPrice().safeParse('12.1234567').success).toBe(false)
    expect(unitPrice().safeParse(12.5).success).toBe(false)
    expect(unitPrice().safeParse('1e3').success).toBe(false)
    expect(quantity().safeParse('99999999999999.9999').success).toBe(true)
    expect(quantity().safeParse('999999999999999').success).toBe(false)
  })

  it('input refuses unknown keys; output strips them', () => {
    expect(input({ name: id() }).safeParse({ name: '0190f5c2-0000-7000-8000-000000000001', extra: 1 }).success).toBe(false)
    expect(output({ code: currency() }).parse({ code: 'EUR', secret: 'x' })).toEqual({ code: 'EUR' })
  })

  it('the error body names one of the stable codes', () => {
    expect(errorBody.safeParse({ error: { code: 'not_found', message: 'Not found.', requestId: 'r' } }).success).toBe(true)
    expect(errorBody.safeParse({ error: { code: 'teapot', message: 'x', requestId: 'r' } }).success).toBe(false)
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length)
  })
})

describe('domain errors', () => {
  it('carry a stable code', () => {
    expect(new NotFoundError().code).toBe('not_found')
    expect(new ForbiddenError().code).toBe('forbidden')
    const error = new ValidationError('Bad line.', [{ path: 'body/lines/0', message: 'Quantity must be above zero.' }])
    expect(error.code).toBe('validation_failed')
    expect(error.issues).toHaveLength(1)
    expect(isDomainError(error)).toBe(true)
    expect(isDomainError(new Error('x'))).toBe(false)
  })
})

describe('money', () => {
  it('rounds to minor units half up, once', () => {
    expect(toMinorUnits('12.505', 'EUR')).toBe(1251)
    expect(toMinorUnits('12.504', 'EUR')).toBe(1250)
    expect(toMinorUnits('-12.505', 'EUR')).toBe(-1251)
    expect(toMinorUnits('1250', 'JPY')).toBe(1250)
    expect(toMinorUnits('1.2345', 'KWD')).toBe(1235)
    expect(fromMinorUnits(1250, 'EUR').toFixed(2)).toBe('12.50')
    expect(minorPlaces('EUR')).toBe(2)
  })

  it('refuses floats, bad currencies and amounts outside PostgreSQL Int', () => {
    expect(() => toMinorUnits('21474836.48', 'EUR')).toThrow(/Int range/)
    expect(() => toMinorUnits('1e3', 'EUR')).toThrow(/plain decimal/)
    expect(() => toMinorUnits('1', 'euro')).toThrow(/currency/)
    expect(() => fromMinorUnits(12.5, 'EUR')).toThrow(/minor units/)
  })

  it('checks Decimal(precision, scale) on strings', () => {
    expect(fitsDecimal('000012.5', 18, 6)).toBe(true)
    expect(fitsDecimal('123456789012.123456', 18, 6)).toBe(true)
    expect(fitsDecimal('1234567890123.1', 18, 6)).toBe(false)
    expect(fitsDecimal('-0.0001', 18, 4)).toBe(true)
    expect(fitsDecimal('.5', 18, 4)).toBe(false)
  })
})
