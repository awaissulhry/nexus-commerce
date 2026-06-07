import { describe, it, expect } from 'vitest'
import { buildBlendedAdjustments, deltaBidCents } from './ads-placement-math.js'

// BL — the blended writer must let Top + Rest of Search + Product pages coexist in ONE
// placement profile, drop a lane the target no longer declares, preserve foreign
// placements, and clamp — so a blended window drives all three at once without churn.
const pmap = (arr: Array<{ placement: string; percentage: number }>) =>
  Object.fromEntries(arr.map((x) => [x.placement, x.percentage]))

describe('buildBlendedAdjustments (BL — multi-placement coexistence)', () => {
  it('drives all three placements simultaneously', () => {
    const out = buildBlendedAdjustments([], [
      { placement: 'PLACEMENT_TOP', percentage: 150 },
      { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 50 },
      { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 30 },
    ])
    expect(pmap(out)).toEqual({ PLACEMENT_TOP: 150, PLACEMENT_REST_OF_SEARCH: 50, PLACEMENT_PRODUCT_PAGE: 30 })
  })

  it('Top + Rest coexist (the headline fix — no more either/or)', () => {
    const out = buildBlendedAdjustments([{ placement: 'PLACEMENT_TOP', percentage: 100 }], [
      { placement: 'PLACEMENT_TOP', percentage: 200 },
      { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 80 },
    ])
    expect(pmap(out).PLACEMENT_TOP).toBe(200)
    expect(pmap(out).PLACEMENT_REST_OF_SEARCH).toBe(80)
  })

  it('drops a managed placement the target no longer declares (was boosted → 0)', () => {
    const out = buildBlendedAdjustments(
      [{ placement: 'PLACEMENT_TOP', percentage: 150 }, { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 30 }],
      [{ placement: 'PLACEMENT_TOP', percentage: 150 }, { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 50 }],
    )
    expect(pmap(out).PLACEMENT_PRODUCT_PAGE).toBe(0) // explicitly dropped
    expect(pmap(out).PLACEMENT_TOP).toBe(150)
    expect(pmap(out).PLACEMENT_REST_OF_SEARCH).toBe(50)
  })

  it('does not add a spurious 0 for an undeclared placement that was never set', () => {
    const out = buildBlendedAdjustments([], [{ placement: 'PLACEMENT_TOP', percentage: 120 }])
    expect(out.find((x) => x.placement === 'PLACEMENT_PRODUCT_PAGE')).toBeUndefined()
    expect(out.find((x) => x.placement === 'PLACEMENT_REST_OF_SEARCH')).toBeUndefined()
    expect(pmap(out)).toEqual({ PLACEMENT_TOP: 120 })
  })

  it('clamps each lane to 0–900', () => {
    const out = buildBlendedAdjustments([], [
      { placement: 'PLACEMENT_TOP', percentage: 1200 },
      { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: -50 },
    ])
    expect(pmap(out).PLACEMENT_TOP).toBe(900)
    expect(pmap(out).PLACEMENT_REST_OF_SEARCH).toBe(0)
  })

  it('preserves a foreign (non-managed) placement untouched', () => {
    const out = buildBlendedAdjustments(
      [{ placement: 'PLACEMENT_HOME', percentage: 40 }],
      [{ placement: 'PLACEMENT_TOP', percentage: 100 }],
    )
    expect(pmap(out).PLACEMENT_HOME).toBe(40)
    expect(pmap(out).PLACEMENT_TOP).toBe(100)
  })

  it('empty lanes drops every previously-boosted managed placement to 0', () => {
    const out = buildBlendedAdjustments(
      [{ placement: 'PLACEMENT_TOP', percentage: 100 }, { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 50 }],
      [],
    )
    expect(pmap(out).PLACEMENT_TOP).toBe(0)
    expect(pmap(out).PLACEMENT_REST_OF_SEARCH).toBe(0)
  })
})

// BL.7 — deltaBidCents must compute from the STABLE baseline (the caller always passes the
// remembered baseline, never the current bid) so repeated application can't compound; it
// clamps the delta to a sane range and floors at 2¢.
describe('deltaBidCents (BL.7 — base-bid delta, no compounding)', () => {
  it('scales the baseline by ±%', () => {
    expect(deltaBidCents(50, 20)).toBe(60)   // +20%
    expect(deltaBidCents(50, -40)).toBe(30)  // −40%
    expect(deltaBidCents(50, 0)).toBe(50)    // no-op
  })
  it('is idempotent from the baseline (no compounding) — same input → same output', () => {
    const once = deltaBidCents(50, 15)
    expect(deltaBidCents(50, 15)).toBe(once) // re-applying from baseline never drifts
    expect(once).toBe(57) // 50 * 1.15 = 57.4999… (float) → round → 57
  })
  it('floors at 2¢ and clamps the delta to [-95, +300]', () => {
    expect(deltaBidCents(50, -100)).toBe(3)   // clamped to -95% → round(2.5) = 3
    expect(deltaBidCents(4, -90)).toBe(2)     // round(0.4) = 0 → floored to 2
    expect(deltaBidCents(50, 9999)).toBe(deltaBidCents(50, 300)) // clamped to +300%
    expect(deltaBidCents(50, 300)).toBe(200)  // round(50 * 4)
  })
})
