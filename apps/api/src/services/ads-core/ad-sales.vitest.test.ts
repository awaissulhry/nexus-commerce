import { describe, it, expect } from 'vitest'
import { adSalesCents } from './ad-sales.js'

describe('adSalesCents — the headline column, and only it', () => {
  it('reads the headline', () => {
    expect(adSalesCents({ sales7dCents: 9482 })).toBe(9482)
  })

  /**
   * 🔴 The regression this function exists for. A contaminated row carries BOTH; the old
   * open-coded sum returned 18,964 for a campaign-day whose real sales were 9,482.
   */
  it('never adds the 14-day window to the headline', () => {
    expect(adSalesCents({ sales7dCents: 9482, sales14dCents: 9482 })).toBe(9482)
  })

  it('is unaffected by a populated window, which is now legal for any product', () => {
    expect(adSalesCents({ sales7dCents: 100, sales14dCents: 420 })).toBe(100)
  })

  /** A genuine zero is a reading; an absent aggregate is not, and both come back 0 here. */
  it('treats absence as zero, because a sum of no rows is zero', () => {
    expect(adSalesCents({})).toBe(0)
    expect(adSalesCents(null)).toBe(0)
    expect(adSalesCents(undefined)).toBe(0)
    expect(adSalesCents({ sales7dCents: null, sales14dCents: 500 })).toBe(0)
  })
})
