import { describe, expect, it } from 'vitest'
import { amountOf, cogsKeys, negated, perUnit, splitByStandard } from './rules'

/**
 * Cost of goods sold at shipment (B-W2b-407; FIN-043): the garments at their cost, split by the standard's parts to the
 * cent. Every figure is made up and worked out by hand.
 */

const STANDARD = { materialCost: '98.000000', labourCost: '43.000000', subcontractCost: '0', overheadCost: '7.000000' }

describe('the split', () => {
  it("follows the standard's parts and adds up to the amount exactly", () => {
    // One jacket at its 148.00 standard: 98.00 + 43.00 + 0 + 7.00.
    expect(splitByStandard(14_800, STANDARD)).toEqual({ materialAmount: 9_800, labourAmount: 4_300, subcontractAmount: 0, overheadAmount: 700, amount: 14_800 })
    // 100.01 by thirds: 33.34 + 33.34 + 33.33 (the largest remainders first, ties in order).
    const thirds = splitByStandard(10_001, { materialCost: '1', labourCost: '1', subcontractCost: '1', overheadCost: '0' })
    expect(thirds).toEqual({ materialAmount: 3_334, labourAmount: 3_334, subcontractAmount: 3_333, overheadAmount: 0, amount: 10_001 })
  })

  it('is all material without a standard (or one of zeros)', () => {
    expect(splitByStandard(500, null)).toEqual({ materialAmount: 500, labourAmount: 0, subcontractAmount: 0, overheadAmount: 0, amount: 500 })
    expect(splitByStandard(500, { materialCost: '0', labourCost: '0', subcontractCost: '0', overheadCost: '0' }).materialAmount).toBe(500)
  })

  it('refuses a negative amount (a reversal takes one back)', () => {
    expect(() => splitByStandard(-1, STANDARD)).toThrow(RangeError)
  })
})

describe('amounts, keys, reversal', () => {
  it('garments × unit cost in cents, once; the cost per garment', () => {
    expect(amountOf('3', '148.005', 'EUR')).toBe(44_402)
    expect(perUnit(44_402, '3', 'EUR')).toBe('148.006667')
    expect(perUnit(100, '0', 'EUR')).toBeNull()
  })

  it('one entry per line, :<n> after a reversal, the reversal the opposite', () => {
    expect(cogsKeys.shipmentLine('l1')).toBe('cogs:shipment-line:l1')
    expect(cogsKeys.shipmentLine('l1', 2)).toBe('cogs:shipment-line:l1:2')
    expect(cogsKeys.reversal('e1')).toBe('cogs:reversal:e1')
    expect(negated(splitByStandard(14_800, STANDARD))).toEqual({ materialAmount: -9_800, labourAmount: -4_300, subcontractAmount: -0, overheadAmount: -700, amount: -14_800 })
  })
})
