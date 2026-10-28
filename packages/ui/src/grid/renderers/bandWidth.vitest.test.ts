/**
 * #731 — the identity band's derived width. Each test names what an operator loses if it is wrong.
 */
import { describe, expect, it } from 'vitest'

import { BAND_WIDTH_CEILING, BAND_WIDTH_FLOOR, bandTruncatesSku, deriveBandWidth, skuBudget, type BandSlots } from './bandWidth'

/** Master's slots as MEASURED on screen 2026-09-02, not as declared anywhere. */
const MASTER: BandSlots = { expand: 20, role: 24, thumb: 32, trailing: 70, menu: 28, gap: 8, padding: 20 }
/** A channel band row: no thumbnail. */
const NO_THUMB: BandSlots = { ...MASTER, thumb: 0 }

describe('deriveBandWidth', () => {
  it('is the slots plus the SKU plus a gap between each', () => {
    // 20+24+32+150+70+28 = 324, five gaps = 40, padding 20 → 384.
    expect(deriveBandWidth(150, MASTER)).toBe(384)
  })

  it('🔴 counts gaps from the slots that are PRESENT, not a fixed number', () => {
    // Without a thumbnail there is one fewer box AND one fewer gap. A fixed gap count would
    // over-reserve here and the two scopes would derive different widths for the same row —
    // which is the whole thing #710 exists to prevent.
    expect(deriveBandWidth(150, NO_THUMB)).toBe(384 - 32 - 8)
  })

  it('never goes below the floor — a short SKU does not collapse the band', () => {
    /* With MASTER's slots the floor never binds: even a 10px SKU derives 244. Asserting `=== 240`
       here was my own wrong assumption and this test caught it — so the clamp is exercised with a
       genuinely small band (a scope with no thumbnail, no menu, a tiny key), which is the only
       shape that can reach it. */
    expect(deriveBandWidth(10, MASTER)).toBe(244)
    expect(deriveBandWidth(10, MASTER)).toBeGreaterThanOrEqual(BAND_WIDTH_FLOOR)
    const tiny: BandSlots = { expand: 20, role: 0, thumb: 0, trailing: 0, menu: 0, gap: 8, padding: 20 }
    expect(deriveBandWidth(10, tiny)).toBe(BAND_WIDTH_FLOOR)
  })

  it('🔴 never exceeds the ceiling — one long key does not spend the width §9.1 is fighting for', () => {
    expect(deriveBandWidth(9999, MASTER)).toBe(BAND_WIDTH_CEILING)
  })

  it('rounds UP, so a fractional text measurement never truncates by a sub-pixel', () => {
    expect(deriveBandWidth(150.2, MASTER)).toBe(385)
  })
})

describe('skuBudget — what is left for the key', () => {
  it('is the width minus every fixed slot, its gaps and the padding', () => {
    // 376 − (20+24+32+70+28 = 174) − 5 gaps (40) − 20 = 142.
    expect(skuBudget(376, MASTER)).toBe(142)
  })

  it('🔴 the OLD 376 constant could not show a 150px SKU — which is why they truncated', () => {
    // The measured regression: with the ⋯ added, `GALE-JACKET-BLACK-MEN-3XL` ellipsized at 376.
    expect(skuBudget(376, MASTER)).toBeLessThan(150)
    // And the derivation gives it room.
    expect(skuBudget(deriveBandWidth(150, MASTER), MASTER)).toBeGreaterThanOrEqual(150)
  })
})

describe('bandTruncatesSku — only at the ceiling, and only when it really does not fit', () => {
  it('false when the derived width fits the key', () => {
    expect(bandTruncatesSku(150, MASTER)).toBe(false)
  })
  it('true when even the ceiling cannot show it', () => {
    expect(bandTruncatesSku(9999, MASTER)).toBe(true)
  })
  it('🔴 false at exactly the ceiling when the key still fits — the hover affordance is not offered for nothing', () => {
    const fits = skuBudget(BAND_WIDTH_CEILING, MASTER)
    expect(bandTruncatesSku(fits, MASTER)).toBe(false)
  })
})
