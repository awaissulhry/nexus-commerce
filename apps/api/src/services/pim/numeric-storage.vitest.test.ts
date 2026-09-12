import { describe, expect, it } from 'vitest'
import { numericStorageError } from './numeric-storage.js'
import { coerceForShape } from './sheet-values.js'

describe('numeric edits cannot silently round or truncate in storage', () => {
  it.each(['basePrice', 'costPrice', 'minPrice', 'maxPrice', 'minMargin', 'dimLength', 'dimWidth', 'dimHeight', 'price'])('%s refuses extra decimal places', field => {
    expect(numericStorageError(field, 12.34)).toBeNull()
    expect(numericStorageError(field, 12.345)).toContain('not been rounded or saved')
  })
  it('preserves three decimal places of weight', () => {
    expect(numericStorageError('weightValue', 0.123)).toBeNull()
    expect(numericStorageError('weightValue', 0.1234)).not.toBeNull()
  })
  it.each(['totalStock', 'lowStockThreshold', 'quantity'])('%s refuses fractions and integer overflow', field => {
    expect(numericStorageError(field, 0)).toBeNull()
    expect(numericStorageError(field, 1.9)).not.toBeNull()
    expect(numericStorageError(field, 2147483648)).not.toBeNull()
  })
  it('rejects nonfinite numbers and decimal overflow', () => {
    for (const value of [NaN, Infinity, -1, 100000000]) expect(numericStorageError('basePrice', value)).not.toBeNull()
    expect(numericStorageError('basePrice', 99999999.99)).toBeNull()
  })
  it('never converts invalid measure members to zero or drops a malformed unit', () => {
    const facts = { shape: 'measure' as const, unitOptions: ['kg'] }
    for (const value of [{ value: [], unit: 'kg' }, { value: [1], unit: 'kg' }, { value: true, unit: 'kg' }, { value: 1, unit: { code: 'kg' } }]) {
      expect(coerceForShape(facts, value).ok).toBe(false)
    }
    expect(coerceForShape(facts, { value: ' ', unit: null })).toEqual({ ok: true, value: null })
  })
})
