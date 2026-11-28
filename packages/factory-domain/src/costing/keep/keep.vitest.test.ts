import { describe, expect, it } from 'vitest'
import { earnedOf, flagOf, floorPriceOf, keepReasonOf, keepRefusalOf, KEEP_REASON_MAX, marginPctOf, sameCents, standardPartsOf, STANDARD_PART_OF } from './rules'

/**
 * owb-pd3 (S4; design plan § 5zh) — price against cost and Keep, pure: the margin is a share of the PRICE, the flags against the
 * target, the lowest price that keeps it, Keep's refusals, and a kept sheet's 9 categories in the 4 parts of a standard cost (they add
 * up to the size's cost). Written, not run (Owner rule). Made-up figures.
 */

describe('price against cost', () => {
  it('margin = (price − cost) ÷ price, one decimal; none without a cost or a price above 0', () => {
    expect(marginPctOf('320', '190')).toBe('40.6')
    expect(marginPctOf('250', '190')).toBe('24.0')
    expect(marginPctOf('180', '190')).toBe('-5.6')
    expect(marginPctOf('320', null)).toBeNull()
    expect(marginPctOf('0', '190')).toBeNull()
  })

  it('the flag: under the cost below 0, under the target below it, else keeps it', () => {
    expect(flagOf('40.6', '35')).toBe('OK')
    expect(flagOf('35.0', '35')).toBe('OK')
    expect(flagOf('24.0', '35')).toBe('UNDER_TARGET')
    expect(flagOf('-5.6', '35')).toBe('UNDER_COST')
    expect(flagOf(null, '35')).toBeNull()
  })

  it('what a price earns, and the lowest price that keeps the target (up to the cent, rounded up)', () => {
    expect(earnedOf('320', '190')).toBe('130.00')
    expect(earnedOf('180', '190.505')).toBe('-10.51')
    expect(earnedOf('180', null)).toBeNull()
    expect(floorPriceOf('190', '35')).toBe('292.31')
    expect(floorPriceOf('130', '35')).toBe('200.00')
    expect(floorPriceOf('190', '100')).toBeNull()
    expect(floorPriceOf(null, '35')).toBeNull()
  })
})

describe('Keep', () => {
  it('refused: parts missing, the cost moved since it was read, the same as kept (to the cent)', () => {
    expect(keepRefusalOf({ total: null, missing: 2, expectedTotal: '185.60', kept: null })).toBe('MISSING_PARTS')
    expect(keepRefusalOf({ total: '185.600000', missing: 0, expectedTotal: '185.70', kept: null })).toBe('TOTAL_MOVED')
    expect(keepRefusalOf({ total: '185.600000', missing: 0, expectedTotal: '185.6', kept: '185.6' })).toBe('SAME_AS_KEPT')
    expect(keepRefusalOf({ total: '185.600000', missing: 0, expectedTotal: '185.60', kept: '190' })).toBeNull()
    expect(sameCents('185.604', '185.60')).toBe(true)
  })

  it('the reason: trimmed, 1 to 500 characters', () => {
    expect(keepReasonOf('  leather went up ')).toBe('leather went up')
    expect(keepReasonOf('   ')).toBeNull()
    expect(keepReasonOf('x'.repeat(KEEP_REASON_MAX + 1))).toBeNull()
  })

  it('a kept sheet in the 4 parts of a standard cost: every category placed, the size\'s lines and the every-size ones, adding up', () => {
    expect(Object.keys(STANDARD_PART_OF).sort()).toEqual(['COMMISSION', 'DUTY', 'FREIGHT', 'LABOUR', 'LEATHER', 'MATERIAL', 'OVERHEAD', 'PACKAGING', 'SUBCONTRACT'])
    const lines = [
      { category: 'LEATHER' as const, size: '52', cost: '239.4' },
      { category: 'LEATHER' as const, size: '54', cost: '249.9' },
      { category: 'MATERIAL' as const, size: null, cost: '10.4' },
      { category: 'FREIGHT' as const, size: '52', cost: '7.182' },
      { category: 'PACKAGING' as const, size: null, cost: '1.35' },
      { category: 'LABOUR' as const, size: null, cost: '55.25' },
      { category: 'SUBCONTRACT' as const, size: null, cost: '4.5' },
      { category: 'OVERHEAD' as const, size: null, cost: '13.8125' },
      { category: 'COMMISSION' as const, size: null, cost: '2' },
    ]
    expect(standardPartsOf(lines, '52')).toEqual({ materialCost: '258.332000', labourCost: '55.250000', subcontractCost: '4.500000', overheadCost: '15.812500' })
    expect(standardPartsOf(lines, '54').materialCost).toBe('261.650000')
  })
})
