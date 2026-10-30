import { describe, expect, it } from 'vitest'
import { averageMarginPct, estimateNowOf, leatherInMix, marginPctOf, mixOfSnapshot, partsInMix, shareOf, shareParts, totalOf, valueNowOf, waterfallOf, type Parts } from './rules'

/**
 * Order margin from estimate to actual (B-W2a-29; FIN-047): shares add up exactly, a quote's cost keeps its mix, an open
 * work order never reads below what it cost, and the waterfall adds up from the quoted margin to the one estimated now.
 * Every figure is made up and worked out by hand (cents).
 */

const parts = (material: number, labour: number, overhead = 0, subcontract = 0, adjustment = 0): Parts => ({ material, labour, subcontract, overhead, adjustment })

describe('shares', () => {
  it('add up exactly, the remainder by the largest remainders (the first on a tie)', () => {
    expect(shareOf(100, [1, 1, 1])).toEqual([34, 33, 33])
    expect(shareOf(203_778, [4, 3])).toEqual([116_445, 87_333])
    expect(shareOf(-7, [1, 1])).toEqual([-3, -4])
    expect(shareOf(10, [0, 0])).toEqual([10, 0])
    expect(shareOf(10, [])).toEqual([])
    const shared = shareParts(parts(161_848, 41_930), [4, 3])
    expect(shared).toEqual([parts(92_485, 23_960), parts(69_363, 17_970)])
    expect(totalOf(shared[0]!) + totalOf(shared[1]!)).toBe(203_778)
  })
})

describe("a quote's cost mix", () => {
  it('reads the cost sheet cells of the snapshot, leather apart, and splits the line cost in that mix', () => {
    // Two cells: 2 × (material 230.00 of which leather 200.00, labour 60.00, overhead 10.00) and 1 × (220.00 / 190.00, 60.00, 10.00).
    const snapshot = {
      complete: true,
      cells: [
        { quantity: 2, material: { amount: '230.00', byCategory: [{ category: 'LEATHER', amount: '200.00' }, { category: 'MATERIALS', amount: '30.00' }] }, labour: { amount: '60.00' }, overhead: { amount: '10.00' } },
        { quantity: 1, material: { amount: '220.00', byCategory: [{ category: 'LEATHER', amount: '190.00' }, { category: 'MATERIALS', amount: '30.00' }] }, labour: { amount: '60.00' }, overhead: { amount: '10.00' } },
      ],
    }
    const mix = mixOfSnapshot(snapshot)!
    expect([mix.material.toFixed(), mix.labour.toFixed(), mix.overhead.toFixed(), mix.leather!.toFixed()]).toEqual(['680', '180', '30', '590'])
    // The line's cost at quote 890.00 = 680 + 180 + 30: the parts are exactly the cells'.
    expect(partsInMix(89_000, mix)).toEqual(parts(68_000, 18_000, 3_000))
    expect(leatherInMix(89_000, mix)).toBe(59_000)
  })

  it('reads one figure per piece (material, labour) and, without a snapshot, puts it all in material', () => {
    // 12 pieces at 300.50: 231.50 material and 69.00 labour each.
    const mix = mixOfSnapshot({ material: '231.500000', labour: '69.000000', per: 'piece' })
    expect(partsInMix(360_600, mix)).toEqual(parts(277_800, 82_800))
    expect(leatherInMix(360_600, mix)).toBeNull()
    expect(mixOfSnapshot(null)).toBeNull()
    expect(mixOfSnapshot({ cells: [{ quantity: 1, material: { amount: 'x' } }] })).toBeNull()
    expect(partsInMix(1_000, null)).toEqual(parts(1_000, 0))
  })
})

describe('the estimate now', () => {
  it('is the actual for a done work order, and part by part the larger of plan and actual for an open one', () => {
    const plan = parts(161_848, 41_930)
    expect(estimateNowOf(plan, parts(22_344, 9_650), false)).toEqual(plan)
    expect(estimateNowOf(plan, parts(170_000, 9_650), false)).toEqual(parts(170_000, 41_930))
    expect(estimateNowOf(plan, parts(150_000, 40_000, 500), true)).toEqual(parts(150_000, 40_000, 500))
  })

  it('takes the pieces closed short off the value pro rata', () => {
    // 4 pieces for 1,680.00, one closed short: 1,260.00 still to deliver.
    expect(valueNowOf(168_000, 4, 1)).toBe(126_000)
    expect(valueNowOf(100_000, 3, 1)).toBe(66_667)
    expect(valueNowOf(168_000, 4, 0)).toBe(168_000)
    expect(valueNowOf(168_000, 4, 4)).toBe(0)
  })
})

describe('the margin', () => {
  it('is value − cost over the value, four places, as the order writes it', () => {
    expect(marginPctOf(504_000, 360_600)).toBe('28.4524')
    expect(marginPctOf(504_000, null)).toBeNull()
    expect(marginPctOf(0, 100)).toBeNull()
    expect(marginPctOf(100, 150)).toBe('-50')
    // Σ margin ÷ Σ value over the orders with a cost: (5,040.00 − 3,606.00 + 2,800.00 − 2,037.78) ÷ 7,840.00.
    expect(averageMarginPct([{ value: 504_000, cost: 360_600 }, { value: 280_000, cost: 203_778 }, { value: 168_000, cost: null }])).toBe('28.013')
    expect(averageMarginPct([{ value: 1, cost: null }])).toBeNull()
  })

  it('where it went: the value, then each part, adding up from the quoted margin to the one now', () => {
    // Quoted 5,040.00 − (2,778.00 + 828.00) = 1,434.00. One RED piece closed short: value 4,620.00; cost now 2,546.50 + 759.00.
    const quoted = { value: 504_000, parts: parts(277_800, 82_800) }
    const now = { value: 462_000, parts: parts(254_650, 75_900) }
    const steps = waterfallOf(quoted, now)
    expect(steps).toEqual([
      { reason: 'PRICE', amount: -42_000 },
      { reason: 'MATERIAL', amount: 23_150 },
      { reason: 'LABOUR', amount: 6_900 },
      { reason: 'SUBCONTRACT', amount: 0 },
      { reason: 'OVERHEAD', amount: 0 },
      { reason: 'ADJUSTMENT', amount: 0 },
    ])
    const quotedMargin = quoted.value - totalOf(quoted.parts)
    const nowMargin = now.value - totalOf(now.parts)
    expect(quotedMargin + steps.reduce((sum, step) => sum + step.amount, 0)).toBe(nowMargin)
  })
})
