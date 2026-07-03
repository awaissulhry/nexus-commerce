/**
 * AME.2 / AME.3 — unit tests for the shared ad-metric math helpers.
 * Pure functions, no DB/network. Run via `npx vitest run`.
 * (Moved with the module from services/advertising in E1.)
 */
import { describe, it, expect } from 'vitest'
import { microsToCents, toEurCents, allocate } from './metrics-math.js'

describe('microsToCents', () => {
  it('rounds micros to cents once', () => {
    expect(microsToCents(1_234_000)).toBe(123) // €1.234 → 123c
    expect(microsToCents(0)).toBe(0)
    expect(microsToCents(null)).toBe(0)
    expect(microsToCents(undefined)).toBe(0)
    expect(microsToCents(9_999n)).toBe(1) // 0.9999c → 1c
  })
  it('sum-then-round beats round-then-sum on many rows', () => {
    const rows = Array.from({ length: 30 }, () => 1_234_000) // €1.234 each
    const roundThenSum = rows.reduce((s, m) => s + microsToCents(m), 0) // 123*30
    const sumThenRound = microsToCents(rows.reduce((s, m) => s + m, 0)) // round(37.02€)
    expect(roundThenSum).toBe(3690) // €36.90 — lost €0.12
    expect(sumThenRound).toBe(3702) // €37.02 — exact
  })
})

describe('toEurCents', () => {
  it('is a no-op at rate 1 (EUR base)', () => {
    expect(toEurCents(2500, 1)).toBe(2500)
    expect(toEurCents(0, 0.85)).toBe(0)
  })
  it('converts native cents to EUR cents', () => {
    expect(toEurCents(1000, 1.17)).toBe(1170) // £10.00 × 1.17 EUR/£ → €11.70
  })
})

describe('allocate', () => {
  it('parts sum exactly to total', () => {
    const out = allocate(32405, [100, 50, 25])
    expect(out.reduce((a, b) => a + b, 0)).toBe(32405)
  })
  it('no part exceeds the total and respects share order', () => {
    const out = allocate(1000, [9, 1])
    expect(out.reduce((a, b) => a + b, 0)).toBe(1000)
    expect(out[0]).toBeGreaterThan(out[1]!)
    expect(Math.max(...out)).toBeLessThanOrEqual(1000)
  })
  it('even-splits when all shares are zero', () => {
    const out = allocate(10, [0, 0, 0])
    expect(out.reduce((a, b) => a + b, 0)).toBe(10)
    expect(out).toEqual([4, 3, 3])
  })
  it('returns zeros for non-positive total', () => {
    expect(allocate(0, [5, 5])).toEqual([0, 0])
    expect(allocate(-5, [5, 5])).toEqual([0, 0])
  })
  it('handles a single row and empty input', () => {
    expect(allocate(777, [3])).toEqual([777])
    expect(allocate(100, [])).toEqual([])
  })
  it('distributes the remainder by largest fractional part', () => {
    // total 10 over [1,1,1] → 3.33 each → [4,3,3]
    expect(allocate(10, [1, 1, 1])).toEqual([4, 3, 3])
  })
})
