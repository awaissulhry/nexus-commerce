/**
 * ACP.4b — Pricing Watchdog detection logic.
 *
 * Pricing moves money, and the prod catalog currently has no cost/floor
 * data to exercise the detector end-to-end — so the math is pinned here
 * deterministically: only below-floor / below-cost is flagged, the fix is
 * always a RAISE, maxPrice caps it, and unpriced / healthy / cut-only
 * rows are left alone.
 */

import { describe, it, expect } from 'vitest'
import { detectAnomaly, type PriceRow } from './pricing-watchdog.js'

function row(p: Partial<PriceRow>): PriceRow {
  return {
    id: 'p1',
    sku: 'SKU-1',
    basePrice: null,
    costPrice: null,
    minMargin: null,
    minPrice: null,
    maxPrice: null,
    weightedAvgCostCents: null,
    ...p,
  }
}

describe('detectAnomaly', () => {
  it('flags below-floor and proposes the floor', () => {
    const a = detectAnomaly(row({ basePrice: 10, minPrice: 15, costPrice: 8 }))
    expect(a?.proposed).toBe(15)
    expect(a?.reason).toMatch(/below floor/)
  })

  it('flags below-cost and raises to cost × (1 + minMargin%)', () => {
    const a = detectAnomaly(row({ basePrice: 5, costPrice: 10, minMargin: 20 }))
    expect(a?.proposed).toBe(12) // 10 * 1.20
    expect(a?.reason).toMatch(/below cost/)
  })

  it('uses a default 10% markup when minMargin is unset', () => {
    const a = detectAnomaly(row({ basePrice: 5, costPrice: 10 }))
    expect(a?.proposed).toBe(11) // 10 * 1.10
  })

  it('falls back to weighted-average cost when costPrice is null', () => {
    const a = detectAnomaly(row({ basePrice: 5, weightedAvgCostCents: 1000 }))
    expect(a?.proposed).toBe(11) // WAC €10, default markup
  })

  it('caps the proposed price at maxPrice', () => {
    const a = detectAnomaly(
      row({ basePrice: 5, costPrice: 10, minMargin: 100, maxPrice: 15 }),
    )
    expect(a?.proposed).toBe(15) // 10*2 = 20, capped to 15
  })

  it('leaves a healthy price alone', () => {
    expect(
      detectAnomaly(row({ basePrice: 50, costPrice: 10, minPrice: 20 })),
    ).toBeNull()
  })

  it('skips unpriced (€0) products', () => {
    expect(detectAnomaly(row({ basePrice: 0, costPrice: 10 }))).toBeNull()
  })

  it('never proposes a cut (proposed must exceed current price)', () => {
    // base above cost and above floor → nothing to do.
    expect(
      detectAnomaly(row({ basePrice: 20, costPrice: 10, minPrice: 12 })),
    ).toBeNull()
  })

  it('does nothing when there is no cost or floor signal', () => {
    expect(detectAnomaly(row({ basePrice: 9 }))).toBeNull()
  })
})
