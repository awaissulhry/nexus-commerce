import { describe, it, expect } from 'vitest'
import { validateVolumeTiers, computeTiers, findMarginViolations } from './ebay-volume-pricing.service.js'

describe('VP.1 — validateVolumeTiers (eBay rules)', () => {
  it('accepts a valid 3-tier ladder (buy 2/3/4)', () => {
    const r = validateVolumeTiers([
      { minQty: 2, percentOff: 5 },
      { minQty: 3, percentOff: 10 },
      { minQty: 4, percentOff: 15 },
    ])
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
  })
  it('accepts a single buy-2 tier', () => {
    const r = validateVolumeTiers([{ minQty: 2, percentOff: 10 }])
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
  })
  it('rejects an empty tier list', () => {
    expect(validateVolumeTiers([]).ok).toBe(false)
  })
  it('rejects more than 3 tiers', () => {
    const t = [2, 3, 4, 5].map((q, i) => ({ minQty: q, percentOff: (i + 1) * 5 }))
    expect(validateVolumeTiers(t).ok).toBe(false)
  })
  it('rejects non-sequential quantities (2 then 5)', () => {
    const r = validateVolumeTiers([{ minQty: 2, percentOff: 5 }, { minQty: 5, percentOff: 10 }])
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => /quantity must be 3/.test(e))).toBe(true)
  })
  it('rejects a non-increasing discount', () => {
    const r = validateVolumeTiers([{ minQty: 2, percentOff: 10 }, { minQty: 3, percentOff: 10 }])
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => /discount must increase/.test(e))).toBe(true)
  })
  it('rejects a tier that does not start at buy-2', () => {
    expect(validateVolumeTiers([{ minQty: 1, percentOff: 5 }, { minQty: 2, percentOff: 10 }]).ok).toBe(false)
  })
  it('warns when the buy-2 tier is below 5%', () => {
    const r = validateVolumeTiers([{ minQty: 2, percentOff: 3 }, { minQty: 3, percentOff: 8 }])
    expect(r.ok).toBe(true)
    expect(r.warnings.some((w) => /5%/.test(w))).toBe(true)
  })
  it('sorts unordered tiers before validating', () => {
    const r = validateVolumeTiers([
      { minQty: 4, percentOff: 15 },
      { minQty: 2, percentOff: 5 },
      { minQty: 3, percentOff: 10 },
    ])
    expect(r.ok).toBe(true)
  })
})

describe('VP.1 — computeTiers', () => {
  it('computes the effective unit price per tier', () => {
    const c = computeTiers([{ minQty: 2, percentOff: 10 }, { minQty: 3, percentOff: 20 }], 100)
    expect(c[0].unitPrice).toBe(90)
    expect(c[1].unitPrice).toBe(80)
    expect(c[0].marginPercent).toBeNull()
  })
  it('computes margin when cost is known', () => {
    const c = computeTiers([{ minQty: 2, percentOff: 20 }], 100, 60) // 100→80, (80-60)/80 = 25%
    expect(c[0].unitPrice).toBe(80)
    expect(c[0].marginPercent).toBe(25)
  })
})

describe('VP.1 — findMarginViolations', () => {
  it('flags tiers below the floor margin', () => {
    // base 100, cost 70 → tier 10%=90 (22.2% margin, ok), tier 30%=70 (0% margin, violates 15% floor)
    const v = findMarginViolations([{ minQty: 2, percentOff: 10 }, { minQty: 3, percentOff: 30 }], 100, 70, 15)
    expect(v).toHaveLength(1)
    expect(v[0].minQty).toBe(3)
  })
  it('no violations when every tier holds the floor', () => {
    expect(findMarginViolations([{ minQty: 2, percentOff: 5 }], 100, 50, 20)).toEqual([])
  })
})
