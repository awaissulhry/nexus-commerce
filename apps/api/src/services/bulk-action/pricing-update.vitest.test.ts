/**
 * The one PRICING_UPDATE rule the run and its preview share (2026-10-01).
 *
 * 🔴 WHAT THIS GUARDS. The preview had its own copy of the math on a column a Product row does not have, and showed
 * "NaN". The rule is now one function on `Product.basePrice`; these arms pin each mode, the skips, the refusals, and
 * that the run writes exactly what it wrote before this change (same status, same stored cents).
 */
import { Prisma } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import { currentBasePrice, pricingUpdateOutcome } from './pricing-update.js'

describe('currentBasePrice — the column the run prices from', () => {
  it('reads the product\'s Decimal master price as a number; none counts as 0', () => {
    expect(currentBasePrice({ basePrice: new Prisma.Decimal('25.40') })).toBe(25.4)
    expect(currentBasePrice({ basePrice: null as never })).toBe(0)
  })
})

describe('pricingUpdateOutcome — each mode', () => {
  it('ABSOLUTE, PERCENT, DELTA: the computed price in the cents the master price write stores', () => {
    expect(pricingUpdateOutcome(25.4, { adjustmentType: 'ABSOLUTE', value: 19.99 })).toEqual({ newPrice: 19.99, status: 'processed' })
    expect(pricingUpdateOutcome(25.4, { adjustmentType: 'ABSOLUTE', value: '1.045' })).toEqual({ newPrice: 1.05, status: 'processed' })
    // 1.30 × 1.15 is 1.4949999… in floating point; the write stores 1.50, so that is the new price.
    expect(pricingUpdateOutcome(1.3, { adjustmentType: 'PERCENT', value: 15 })).toEqual({ newPrice: 1.5, status: 'processed' })
    expect(pricingUpdateOutcome(25.4, { adjustmentType: 'PERCENT', value: -10 })).toEqual({ newPrice: 22.86, status: 'processed' })
    expect(pricingUpdateOutcome(3.04, { adjustmentType: 'DELTA', value: -1.995 })).toEqual({ newPrice: 1.05, status: 'processed' })
  })

  it('ROUND_DOWN_TO_99 needs no value, and keeps its own skips', () => {
    expect(pricingUpdateOutcome(25.4, { adjustmentType: 'ROUND_DOWN_TO_99' })).toEqual({ newPrice: 24.99, status: 'processed' })
    expect(pricingUpdateOutcome(25.99, { adjustmentType: 'ROUND_DOWN_TO_99' })).toEqual({ newPrice: 25.99, status: 'skipped' })
    expect(pricingUpdateOutcome(0.5, { adjustmentType: 'ROUND_DOWN_TO_99' })).toEqual({ newPrice: 0.5, status: 'skipped' })
  })

  it('skips below zero and outside minPrice / maxPrice, testing the computed price as before', () => {
    expect(pricingUpdateOutcome(1, { adjustmentType: 'DELTA', value: -1.995 })).toEqual({ newPrice: -1, status: 'skipped' })
    expect(pricingUpdateOutcome(90, { adjustmentType: 'PERCENT', value: 15, maxPrice: 100 })).toEqual({ newPrice: 103.5, status: 'skipped' })
    // 9.996 is below the floor of 10 even though its stored cents would be 10.00: skipped, as the run always did.
    expect(pricingUpdateOutcome(10, { adjustmentType: 'DELTA', value: -0.004, minPrice: 10 })).toEqual({ newPrice: 10, status: 'skipped' })
    expect(pricingUpdateOutcome(10, { adjustmentType: 'DELTA', value: 1, minPrice: '20' })).toEqual({ newPrice: 11, status: 'processed' })
  })

  it('refuses a payload no row can run', () => {
    expect(() => pricingUpdateOutcome(10, { value: 5 })).toThrow('Invalid PRICING_UPDATE payload: adjustmentType + numeric value required')
    expect(() => pricingUpdateOutcome(10, { adjustmentType: 'PERCENT' })).toThrow('Invalid PRICING_UPDATE payload: adjustmentType + numeric value required')
    expect(() => pricingUpdateOutcome(10, { adjustmentType: 'PERCENT', value: 'abc' })).toThrow('Invalid PRICING_UPDATE payload: adjustmentType + numeric value required')
    expect(() => pricingUpdateOutcome(10, { adjustmentType: 'MULTIPLY', value: 2 })).toThrow('Invalid PRICING_UPDATE adjustmentType: MULTIPLY')
  })
})

describe('🔴 the run writes what it wrote before this change', () => {
  /** The run before 2026-10-01 (`processPricingUpdate`), and the cents MasterPriceService then stored. */
  function before(current: number, payload: Record<string, any>): { status: 'processed' | 'skipped'; stored?: number } {
    const value = typeof payload.value === 'number' ? payload.value : Number(payload.value)
    let newPrice!: number
    switch (payload.adjustmentType) {
      case 'ABSOLUTE': newPrice = value; break
      case 'PERCENT': newPrice = current * (1 + value / 100); break
      case 'DELTA': newPrice = current + value; break
    }
    if (newPrice < 0) return { status: 'skipped' }
    if (typeof payload.minPrice === 'number' && newPrice < payload.minPrice) return { status: 'skipped' }
    if (typeof payload.maxPrice === 'number' && newPrice > payload.maxPrice) return { status: 'skipped' }
    return { status: 'processed', stored: Math.round(newPrice * 100) / 100 }
  }
  /** The run now: the shared rule, then the same write, whose rounding meets an already-rounded price. */
  function now(current: number, payload: Record<string, any>): { status: 'processed' | 'skipped'; stored?: number } {
    const outcome = pricingUpdateOutcome(current, payload)
    if (outcome.status === 'skipped') return { status: 'skipped' }
    return { status: 'processed', stored: Math.round(outcome.newPrice * 100) / 100 }
  }

  it('same status and same stored price for every mode, over 30,000 prices and adjustments', () => {
    let seed = 7
    const next = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
    for (let i = 0; i < 10_000; i++) {
      const current = Math.round(next() * 100_000) / 100
      const value = Math.round((next() - 0.5) * 20_000) / 1000
      const bounds = next() < 0.3 ? { minPrice: Math.round(next() * 5_000) / 100, maxPrice: Math.round(next() * 100_000) / 100 } : {}
      for (const adjustmentType of ['ABSOLUTE', 'PERCENT', 'DELTA']) {
        const payload = { adjustmentType, value, ...bounds }
        expect(now(current, payload), JSON.stringify({ current, payload })).toEqual(before(current, payload))
      }
    }
  })
})
