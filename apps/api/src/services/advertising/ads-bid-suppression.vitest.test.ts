import { describe, it, expect } from 'vitest'
import { normaliseFloorCents, refloorBidCents, SUPPRESSION_FLOOR_CENTS } from './ads-bid-suppression.service.js'

/**
 * MB.1 — the two pure rules the configurable Min-bid floor rests on.
 *
 * Everything else in ads-bid-suppression.service.ts is a database loop, but these two
 * decide how much money a Min-bid window spends, and both have a failure mode that is
 * invisible in review: a floor that silently becomes 0, and a re-floor that RAISES a
 * suppressed bid above what the campaign was bidding before it was ever suppressed.
 */

describe('MB.1 normaliseFloorCents — the floor a Min-bid target holds', () => {
  it('null/undefined keeps the engine’s legacy 2¢, so every pre-MB.1 window is unchanged', () => {
    expect(normaliseFloorCents(null)).toBe(SUPPRESSION_FLOOR_CENTS)
    expect(normaliseFloorCents(undefined)).toBe(SUPPRESSION_FLOOR_CENTS)
    expect(SUPPRESSION_FLOOR_CENTS).toBe(2)
  })
  it('passes an ordinary operator value straight through', () => {
    expect(normaliseFloorCents(10)).toBe(10)
    expect(normaliseFloorCents(45)).toBe(45)
  })
  it('clamps UP to Amazon’s 2¢ minimum rather than sending a bid Amazon rejects', () => {
    expect(normaliseFloorCents(0)).toBe(2)
    expect(normaliseFloorCents(1)).toBe(2)
    expect(normaliseFloorCents(-50)).toBe(2)
  })
  it('clamps an absurd value instead of quietly disabling suppression', () => {
    expect(normaliseFloorCents(999_999)).toBe(10_000)
  })
  it('rounds fractional cents — a bid is an integer number of cents', () => {
    expect(normaliseFloorCents(7.4)).toBe(7)
    expect(normaliseFloorCents(7.6)).toBe(8)
  })
  it('survives NaN rather than propagating it into a bid write', () => {
    expect(normaliseFloorCents(Number.NaN)).toBe(SUPPRESSION_FLOOR_CENTS)
  })
})

describe('MB.1 refloorBidCents — moving an already-suppressed campaign to a new floor', () => {
  it('lowers a floored bid to the new, lower floor', () => {
    expect(refloorBidCents(2, 45)).toBe(2)
  })
  it('raises toward a higher floor, but only as far as the pre-suppression bid', () => {
    expect(refloorBidCents(10, 45)).toBe(10)
  })
  it('NEVER exceeds the remembered original — the invariant that bounds Min-bid spend', () => {
    // Original bid 5¢, operator sets a 10¢ floor: Min bid must not outspend serving.
    expect(refloorBidCents(10, 5)).toBe(5)
    expect(refloorBidCents(10_000, 45)).toBe(45)
  })
  it('an entity added after suppression has no original, so it just takes the floor', () => {
    expect(refloorBidCents(10, null)).toBe(10)
  })
  it('is idempotent — re-running against the same floor asks for the same bid', () => {
    const once = refloorBidCents(10, 45)
    expect(refloorBidCents(10, 45)).toBe(once)
  })
})
