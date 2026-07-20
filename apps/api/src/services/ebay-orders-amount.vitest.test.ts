/**
 * AS.3b — eBay Amount parsing.
 *
 * The live Fulfillment API sends money as { value, currency }; the old code
 * Number()'d the object → NaN → every real order threw at pricingSummary and
 * every real line item silently skipped (no OrderItem, NO stock deduction).
 * First live proof: order 16-14902-17212, 2026-07-20, fetched=4 created=0.
 */
import { describe, it, expect } from 'vitest'
import { parseEbayAmount, ebayAmountCurrency } from './ebay-orders.service.js'

describe('AS.3b — parseEbayAmount', () => {
  it('parses the real Fulfillment API Amount object', () => {
    expect(parseEbayAmount({ value: '89.99', currency: 'EUR' })).toBe(89.99)
    expect(parseEbayAmount({ value: 120, currency: 'EUR' })).toBe(120)
  })

  it('parses legacy scalar shapes', () => {
    expect(parseEbayAmount('42.50')).toBe(42.5)
    expect(parseEbayAmount(7)).toBe(7)
  })

  it('zero is a valid amount (free shipping lines)', () => {
    expect(parseEbayAmount({ value: '0.0' })).toBe(0)
    expect(parseEbayAmount(0)).toBe(0)
  })

  it('returns null (never NaN) for malformed input', () => {
    expect(parseEbayAmount(undefined)).toBeNull()
    expect(parseEbayAmount(null)).toBeNull()
    expect(parseEbayAmount('')).toBeNull()
    expect(parseEbayAmount('abc')).toBeNull()
    expect(parseEbayAmount({})).toBeNull()
    expect(parseEbayAmount({ value: 'x' })).toBeNull()
  })

  it('currency comes from the Amount when present', () => {
    expect(ebayAmountCurrency({ value: '1', currency: 'EUR' })).toBe('EUR')
    expect(ebayAmountCurrency('1')).toBeNull()
    expect(ebayAmountCurrency(undefined)).toBeNull()
  })
})
