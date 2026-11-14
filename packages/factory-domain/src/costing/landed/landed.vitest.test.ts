import { describe, expect, it } from 'vitest'
import { lotUnitCost } from '../../inventory/ledger/valuation'
import { COST_ACTUALS_ADDS, COST_ACTUALS_DEFINITIONS } from './permissions'
import { allocateShares, kilogramsOf, landedShareKey, lotUnitCostWithLanded, majorOf } from './rules'

/**
 * Landed cost over the received lots (B-W2b-407; FIN-044): the shares add up to the charge to the cent, a lot's weight
 * from a mass unit, and the lot's cost with its posted landed cost in it. Every figure is made up and worked out by hand.
 */

describe('the shares', () => {
  it('follow the basis and add up to the charge exactly', () => {
    // 15.00 of freight by value over 441.00 and 220.50: 10.00 and 5.00.
    expect(allocateShares(1_500, [{ lotId: 'a', basisAmount: '44100' }, { lotId: 'b', basisAmount: '22050' }])).toEqual([{ lotId: 'a', amount: 1_000 }, { lotId: 'b', amount: 500 }])
    // 1.00 over three equal lots: 0.34, 0.33, 0.33 (the remainder to the lot listed first).
    expect(allocateShares(100, [{ lotId: 'a', basisAmount: '1' }, { lotId: 'b', basisAmount: '1' }, { lotId: 'c', basisAmount: '1' }]).map((row) => row.amount)).toEqual([34, 33, 33])
  })

  it('refuse no lot, a figure of 0 and an amount of 0', () => {
    expect(() => allocateShares(100, [])).toThrow(RangeError)
    expect(() => allocateShares(100, [{ lotId: 'a', basisAmount: '0' }])).toThrow(RangeError)
    expect(() => allocateShares(0, [{ lotId: 'a', basisAmount: '1' }])).toThrow(RangeError)
  })

  it('one share per allocation and lot', () => {
    expect(landedShareKey('al', 'lot')).toBe('share:al:lot')
  })
})

describe('weight', () => {
  it('is the quantity of a mass unit, else typed', () => {
    expect(kilogramsOf('12.5', 'KG')).toBe('12.5000')
    expect(kilogramsOf('2500', 'G')).toBe('2.5000')
    expect(kilogramsOf('105', 'FT2')).toBeNull()
  })
})

describe("the lot's cost", () => {
  // Hides of 53.2 and 51.8 ft² in at 4.20 (223.44 + 217.56), the first issued at 4.20 (−223.44).
  const valuations = [
    { quantity: '53.2', unitCost: '4.2' },
    { quantity: '51.8', unitCost: '4.2' },
    { quantity: '-53.2', unitCost: '4.2' },
  ]

  it('carries the posted landed cost on what is left (moving average)', () => {
    // (217.56 + 15.00) ÷ 51.8 = 4.489575…
    expect(lotUnitCostWithLanded(valuations, '15.00')!.toFixed(6)).toBe('4.489575')
  })

  it('is the plain lot cost without one', () => {
    expect(lotUnitCostWithLanded(valuations, null)!.toFixed(6)).toBe(lotUnitCost(valuations)!.toFixed(6))
  })

  it('spreads it over what came in when nothing is left', () => {
    // (441.00 + 15.00) ÷ 105 = 4.342857…
    expect(lotUnitCostWithLanded([{ quantity: '105', unitCost: '4.2' }, { quantity: '-105', unitCost: '4.2' }], '15')!.toFixed(6)).toBe('4.342857')
    expect(lotUnitCostWithLanded([], '15')).toBeNull()
  })

  it('reads minor units as major units', () => {
    expect(majorOf(1_500, 'EUR')).toBe('15.00')
  })
})

describe('the permissions', () => {
  it('finance lands charges and keeps the switch (a step-up)', () => {
    expect(COST_ACTUALS_DEFINITIONS.map((row) => [row.name, row.risk])).toEqual([
      ['costing.landed.manage', 'write'],
      ['costing.actuals.manage', 'stepUp'],
    ])
    expect(COST_ACTUALS_ADDS.finance).toEqual(['costing.landed.manage', 'costing.actuals.manage'])
  })
})
