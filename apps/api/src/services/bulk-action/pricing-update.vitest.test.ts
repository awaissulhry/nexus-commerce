/**
 * The one PRICING_UPDATE rule the run and its preview share (2026-10-01).
 *
 * 🔴 WHAT THIS GUARDS. The preview had its own copy of the math on a column a Product row does not have, and showed
 * "NaN". The rule is now one function on the product row; these arms pin each mode, the skips and the refusals.
 *
 * Two skips were added on purpose, in every mode, preview and run alike (the agent price tools' rule, #225):
 *   1. a price that would be stored as 0 or below (before: only a computed price below 0 was skipped, so 0.00 could be
 *      stored);
 *   2. a new price outside the product's OWN floor / ceiling (`Product.minPrice` / `maxPrice`, `masterPriceBoundsReason`)
 *      — the push refuses it after Nexus stored it, so Nexus and the channel would disagree.
 * The last arm compares the run with the run before this change over 30,000 inputs: identical, except exactly these two.
 */
import { Prisma } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import { currentBasePrice, pricingUpdateOutcome } from './pricing-update.js'

/** A product row as the job loads it: the master price and the product's own floor and ceiling. */
const ZERO = 'Not changed: the new price would be 0.00, and a price must be above 0.'
const ALREADY_99 = 'Not changed: the price already ends in .99.'

const product = (basePrice: number, minPrice: number | null = null, maxPrice: number | null = null) => ({
  basePrice: new Prisma.Decimal(basePrice.toFixed(2)),
  minPrice: minPrice == null ? null : new Prisma.Decimal(minPrice.toFixed(2)),
  maxPrice: maxPrice == null ? null : new Prisma.Decimal(maxPrice.toFixed(2)),
})

describe('currentBasePrice — the column the run prices from', () => {
  it('reads the product\'s Decimal master price as a number; none counts as 0', () => {
    expect(currentBasePrice({ basePrice: new Prisma.Decimal('25.40') })).toBe(25.4)
    expect(currentBasePrice({ basePrice: null })).toBe(0)
  })
})

describe('pricingUpdateOutcome — each mode', () => {
  it('ABSOLUTE, PERCENT, DELTA: the computed price in the cents the master price write stores', () => {
    expect(pricingUpdateOutcome(product(25.4), { adjustmentType: 'ABSOLUTE', value: 19.99 })).toEqual({ newPrice: 19.99, status: 'processed' })
    expect(pricingUpdateOutcome(product(25.4), { adjustmentType: 'ABSOLUTE', value: '1.045' })).toEqual({ newPrice: 1.05, status: 'processed' })
    // 1.30 × 1.15 is 1.4949… in floating point; the write stores 1.50, so that is the new price.
    expect(pricingUpdateOutcome(product(1.3), { adjustmentType: 'PERCENT', value: 15 })).toEqual({ newPrice: 1.5, status: 'processed' })
    expect(pricingUpdateOutcome(product(25.4), { adjustmentType: 'PERCENT', value: -10 })).toEqual({ newPrice: 22.86, status: 'processed' })
    expect(pricingUpdateOutcome(product(3.04), { adjustmentType: 'DELTA', value: -1.995 })).toEqual({ newPrice: 1.05, status: 'processed' })
  })

  it('ROUND_DOWN_TO_99 needs no value, and keeps its own skips', () => {
    expect(pricingUpdateOutcome(product(25.4), { adjustmentType: 'ROUND_DOWN_TO_99' })).toEqual({ newPrice: 24.99, status: 'processed' })
    expect(pricingUpdateOutcome(product(25.99), { adjustmentType: 'ROUND_DOWN_TO_99' })).toEqual({ newPrice: 25.99, status: 'skipped', reason: ALREADY_99 })
    expect(pricingUpdateOutcome(product(0.5), { adjustmentType: 'ROUND_DOWN_TO_99' })).toEqual({ newPrice: 0.5, status: 'skipped', reason: 'Not changed: 0.50 is below 0.99, so there is no lower price ending in .99.' })
    // The job's bounds apply to the rounded price, as to every mode's.
    expect(pricingUpdateOutcome(product(25.4), { adjustmentType: 'ROUND_DOWN_TO_99', minPrice: 25 })).toEqual({ newPrice: 24.99, status: 'skipped', reason: "Not changed: 24.99 is below this job's minimum price of 25.00." })
    expect(pricingUpdateOutcome(product(25.4), { adjustmentType: 'ROUND_DOWN_TO_99', minPrice: 24.99 })).toEqual({ newPrice: 24.99, status: 'processed' })
    expect(pricingUpdateOutcome(product(25.4), { adjustmentType: 'ROUND_DOWN_TO_99', maxPrice: 20 })).toEqual({ newPrice: 24.99, status: 'skipped', reason: "Not changed: 24.99 is above this job's maximum price of 20.00." })
    expect(pricingUpdateOutcome(product(25.4), { adjustmentType: 'ROUND_DOWN_TO_99', minPrice: '30' })).toEqual({ newPrice: 24.99, status: 'processed' })
  })

  it('skips below zero and outside the job\'s minPrice / maxPrice, testing the computed price as before', () => {
    expect(pricingUpdateOutcome(product(1), { adjustmentType: 'DELTA', value: -1.995 })).toEqual({ newPrice: -1, status: 'skipped', reason: 'Not changed: the new price would be -1.00, and a price must be above 0.' })
    expect(pricingUpdateOutcome(product(90), { adjustmentType: 'PERCENT', value: 15, maxPrice: 100 })).toEqual({ newPrice: 103.5, status: 'skipped', reason: "Not changed: 103.50 is above this job's maximum price of 100.00." })
    // 9.996 is below the job's floor of 10 even though its stored cents would be 10.00: skipped, as the run always did,
    // and the reason shows the price the bound tested.
    expect(pricingUpdateOutcome(product(10), { adjustmentType: 'DELTA', value: -0.004, minPrice: 10 })).toEqual({ newPrice: 10, status: 'skipped', reason: "Not changed: 9.996 is below this job's minimum price of 10.00." })
    expect(pricingUpdateOutcome(product(10), { adjustmentType: 'DELTA', value: 1, minPrice: '20' })).toEqual({ newPrice: 11, status: 'processed' })
  })

  it('🔴 1. a price that would be stored as 0 or below is skipped, in every mode', () => {
    expect(pricingUpdateOutcome(product(5), { adjustmentType: 'ABSOLUTE', value: 0 })).toEqual({ newPrice: 0, status: 'skipped', reason: ZERO })
    expect(pricingUpdateOutcome(product(5), { adjustmentType: 'DELTA', value: -5 })).toEqual({ newPrice: 0, status: 'skipped', reason: ZERO })
    expect(pricingUpdateOutcome(product(5), { adjustmentType: 'PERCENT', value: -100 })).toEqual({ newPrice: 0, status: 'skipped', reason: ZERO })
    // A positive computed price that the write would store as 0.00.
    expect(pricingUpdateOutcome(product(5), { adjustmentType: 'ABSOLUTE', value: 0.004 })).toEqual({ newPrice: 0, status: 'skipped', reason: ZERO })
    // The smallest storable price is fine.
    expect(pricingUpdateOutcome(product(5), { adjustmentType: 'ABSOLUTE', value: 0.01 })).toEqual({ newPrice: 0.01, status: 'processed' })
  })

  it('🔴 2. a new price outside the product\'s own floor or ceiling is skipped, in every mode; on the bound is fine', () => {
    expect(pricingUpdateOutcome(product(50, 46), { adjustmentType: 'PERCENT', value: -10 })).toEqual({ newPrice: 45, status: 'skipped', reason: 'Not changed: 45.00 is below its pricing floor of 46.00.' })
    expect(pricingUpdateOutcome(product(50, 45), { adjustmentType: 'PERCENT', value: -10 })).toEqual({ newPrice: 45, status: 'processed' })
    expect(pricingUpdateOutcome(product(20, null, 24), { adjustmentType: 'DELTA', value: 5 })).toEqual({ newPrice: 25, status: 'skipped', reason: 'Not changed: 25.00 is above its pricing ceiling of 24.00.' })
    expect(pricingUpdateOutcome(product(20, null, 25), { adjustmentType: 'DELTA', value: 5 })).toEqual({ newPrice: 25, status: 'processed' })
    expect(pricingUpdateOutcome(product(20, null, 10), { adjustmentType: 'ABSOLUTE', value: 12 })).toEqual({ newPrice: 12, status: 'skipped', reason: 'Not changed: 12.00 is above its pricing ceiling of 10.00.' })
    expect(pricingUpdateOutcome(product(25.4, 25), { adjustmentType: 'ROUND_DOWN_TO_99' })).toEqual({ newPrice: 24.99, status: 'skipped', reason: 'Not changed: 24.99 is below its pricing floor of 25.00.' })
    // A floor above the ceiling is a contradiction the operator resolves: nothing is written.
    expect(pricingUpdateOutcome(product(50, 60, 40), { adjustmentType: 'PERCENT', value: -10 })).toEqual({ newPrice: 45, status: 'skipped', reason: 'Not changed: its pricing floor (60.00) is above its pricing ceiling (40.00).' })
    // Bounds as numbers or strings read the same (`priceBoundsOf`).
    expect(pricingUpdateOutcome({ basePrice: 50, minPrice: '46', maxPrice: null }, { adjustmentType: 'PERCENT', value: -10 })).toEqual({ newPrice: 45, status: 'skipped', reason: 'Not changed: 45.00 is below its pricing floor of 46.00.' })
  })

  it('refuses a payload no row can run', () => {
    expect(() => pricingUpdateOutcome(product(10), { value: 5 })).toThrow('Invalid PRICING_UPDATE payload: adjustmentType + numeric value required')
    expect(() => pricingUpdateOutcome(product(10), { adjustmentType: 'PERCENT' })).toThrow('Invalid PRICING_UPDATE payload: adjustmentType + numeric value required')
    expect(() => pricingUpdateOutcome(product(10), { adjustmentType: 'PERCENT', value: 'abc' })).toThrow('Invalid PRICING_UPDATE payload: adjustmentType + numeric value required')
    expect(() => pricingUpdateOutcome(product(10), { adjustmentType: 'MULTIPLY', value: 2 })).toThrow('Invalid PRICING_UPDATE adjustmentType: MULTIPLY')
  })
})

describe('🔴 the run writes what it wrote before this change, except the two intended skips', () => {
  type Run = { status: 'processed' | 'skipped'; stored?: number }
  /** The run before 2026-10-01 (`processPricingUpdate`), and the cents MasterPriceService then stored. */
  function before(current: number, payload: Record<string, any>): Run {
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
  function now(row: ReturnType<typeof product>, payload: Record<string, any>): Run {
    const outcome = pricingUpdateOutcome(row, payload)
    if (outcome.status === 'skipped') return { status: 'skipped' }
    return { status: 'processed', stored: Math.round(outcome.newPrice * 100) / 100 }
  }

  it('same status and same stored price for every mode over 30,000 inputs, except exactly differences 1 and 2', () => {
    let seed = 7
    const next = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
    const differences = { storedZeroOrBelow: 0, outsideProductBounds: 0 }
    for (let i = 0; i < 10_000; i++) {
      const current = Math.round(next() * 100_000) / 100
      const roll = next()
      // Every so often an adjustment that lands on exactly 0 (difference 1 must be exercised, not just allowed).
      const value = roll < 0.05 ? 0 : Math.round((next() - 0.5) * 20_000) / 1000
      const bounds = next() < 0.3 ? { minPrice: Math.round(next() * 5_000) / 100, maxPrice: Math.round(next() * 100_000) / 100 } : {}
      // The product's own floor / ceiling: none on most rows, as in production.
      const own = next() < 0.4 ? [next() < 0.5 ? Math.round(next() * 50_000) / 100 : null, next() < 0.5 ? Math.round(next() * 100_000) / 100 : null] as const : [null, null] as const
      const row = product(current, own[0], own[1])
      for (const adjustmentType of ['ABSOLUTE', 'PERCENT', 'DELTA']) {
        const payload = { adjustmentType, value: roll < 0.05 && adjustmentType === 'DELTA' ? -current : roll < 0.05 && adjustmentType === 'PERCENT' ? -100 : value, ...bounds }
        const was = before(current, payload)
        let expected = was
        if (was.status === 'processed' && was.stored! <= 0) {
          // Difference 1: a stored price of 0 or below is now skipped.
          expected = { status: 'skipped' }
          differences.storedZeroOrBelow++
        } else if (was.status === 'processed') {
          const [min, max] = own
          if ((min !== null && max !== null && min > max) || (min !== null && was.stored! < min) || (max !== null && was.stored! > max)) {
            // Difference 2: a new price outside the product's own floor / ceiling is now skipped.
            expected = { status: 'skipped' }
            differences.outsideProductBounds++
          }
        }
        expect(now(row, payload), JSON.stringify({ current, own, payload })).toEqual(expected)
        // Every skipped row says why; a processed row carries no reason.
        const outcome = pricingUpdateOutcome(row, payload)
        if (outcome.status === 'skipped') expect(outcome.reason, JSON.stringify(payload)).toMatch(/^Not changed: .+\.$/)
        else expect('reason' in outcome).toBe(false)
      }
    }
    // Both differences actually occurred in the sample.
    expect(differences.storedZeroOrBelow).toBeGreaterThan(100)
    expect(differences.outsideProductBounds).toBeGreaterThan(100)
  })
})
