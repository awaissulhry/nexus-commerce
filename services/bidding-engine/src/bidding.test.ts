import { describe, it, expect } from 'vitest'
import { computeBid, inventoryTheta, intradayTheta, isMaterialChange } from './bidding.js'
import type { BidContext } from './types.js'

const base: BidContext = {
  bridgeId: 'b', externalId: 'kw1', accountRef: 'p1',
  currentBidMinor: 50, aovMinor: 5000, cr7d: 0.1, cr30d: 0.08,
  acosTargetBps: 3000, acos1hBps: null, daysOfSupply: 60,
  bidMinMinor: 5, bidMaxMinor: 300,
}

describe('inventoryTheta', () => {
  it('is ~1 with deep supply and 0 at/below the floor', () => {
    expect(inventoryTheta(120)).toBeGreaterThan(0.99)
    expect(inventoryTheta(7)).toBe(0)
    expect(inventoryTheta(3)).toBe(0)
    expect(inventoryTheta(null)).toBe(1)
  })
  it('is monotonic in days of supply', () => {
    expect(inventoryTheta(10)).toBeLessThan(inventoryTheta(20))
  })
})

describe('intradayTheta', () => {
  it('raises when live ACoS beats target and clamps at ±25%', () => {
    expect(intradayTheta(3000, 1500)).toBeGreaterThan(1)      // efficient hour → push up
    expect(intradayTheta(3000, 0)).toBeCloseTo(1.25, 5)       // clamp ceiling
    expect(intradayTheta(3000, 9000)).toBeCloseTo(0.75, 5)    // clamp floor
    expect(intradayTheta(3000, null)).toBe(1)                 // no traffic → neutral
  })
})

describe('computeBid', () => {
  it('clamps to the strategy band', () => {
    expect(computeBid({ ...base, aovMinor: 1_000_000 })).toBe(300)  // hits cap
    expect(computeBid({ ...base, cr7d: 0, cr30d: 0 })).toBe(5)      // hits floor
  })
  it('throttles a near-stockout product toward the floor', () => {
    const deep = computeBid({ ...base, daysOfSupply: 90 })
    const thin = computeBid({ ...base, daysOfSupply: 8 })
    expect(thin).toBeLessThan(deep)
  })
})

describe('isMaterialChange', () => {
  it('applies a 2% deadband', () => {
    expect(isMaterialChange(101, 100)).toBe(false) // 1% → skip
    expect(isMaterialChange(103, 100)).toBe(true)  // 3% → apply
    expect(isMaterialChange(10, 0)).toBe(true)
  })
})
