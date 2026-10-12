import { describe, expect, it } from 'vitest'
import { businessPriceOf, businessPriceProblems, businessPriceWarnings, businessTierPrices, readBusinessTiers, type BusinessPriceSetting } from './business-price.js'

const pct = (percent: number, tiers: BusinessPriceSetting['tiers'] = null): BusinessPriceSetting => ({ rule: 'PERCENT_OFF', percent, price: null, tiers })
const fixed = (price: number, tiers: BusinessPriceSetting['tiers'] = null): BusinessPriceSetting => ({ rule: 'FIXED', percent: null, price, tiers })

describe('businessPriceOf — percent follows the normal price, fixed stays', () => {
  it('rounds to the cent; 0 % is the normal price; no normal price → unknown', () => {
    expect(businessPriceOf(pct(5), 105)).toBe(99.75)
    expect(businessPriceOf(pct(3.5), 39.95)).toBe(38.55)
    expect(businessPriceOf(pct(0), 105)).toBe(105)
    expect(businessPriceOf(pct(5), null)).toBeNull()
    expect(businessPriceOf(fixed(99), null)).toBe(99)
  })
  it('tier prices: percent off the business price, fixed as given', () => {
    expect(businessTierPrices(99.75, { type: 'percent', levels: [{ minQty: 2, value: 3 }, { minQty: 5, value: 5 }, { minQty: 10, value: 8 }] })).toEqual([96.76, 94.76, 91.77])
    expect(businessTierPrices(99, { type: 'fixed', levels: [{ minQty: 2, value: 95 }] })).toEqual([95])
  })
})

describe('businessPriceProblems — only what Amazon would refuse or hide', () => {
  it('a sound percent setting with three percent tiers passes', () => {
    expect(businessPriceProblems({ setting: pct(5, { type: 'percent', levels: [{ minQty: 2, value: 3 }, { minQty: 5, value: 5 }, { minQty: 10, value: 8 }] }), normalPrice: 105 })).toEqual([])
  })
  it('a fixed price above the normal price, or with no normal price, is refused', () => {
    expect(businessPriceProblems({ setting: fixed(110), normalPrice: 105, currency: 'EUR' })[0]).toContain('above the normal price EUR 105.00')
    expect(businessPriceProblems({ setting: fixed(99), normalPrice: null })[0]).toContain('no normal price')
    expect(businessPriceProblems({ setting: fixed(105), normalPrice: 105 })).toEqual([]) // equal is allowed
  })
  it('percent out of range or with three decimals is refused', () => {
    expect(businessPriceProblems({ setting: pct(100), normalPrice: 105 })).toHaveLength(1)
    expect(businessPriceProblems({ setting: pct(-1), normalPrice: 105 })).toHaveLength(1)
    expect(businessPriceProblems({ setting: pct(5.555), normalPrice: 105 })).toHaveLength(1)
  })
  it('tiers: 1–5, quantity ≥ 2 and rising, percent rising, fixed falling and below the business price', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ minQty: i + 2, value: i + 1 }))
    expect(businessPriceProblems({ setting: pct(5, { type: 'percent', levels: six }), normalPrice: 105 })[0]).toContain('1 to 5')
    expect(businessPriceProblems({ setting: pct(5, { type: 'percent', levels: [] }), normalPrice: 105 })[0]).toContain('1 to 5')
    expect(businessPriceProblems({ setting: pct(5, { type: 'percent', levels: [{ minQty: 1, value: 3 }] }), normalPrice: 105 })[0]).toContain('at least 2')
    expect(businessPriceProblems({ setting: pct(5, { type: 'percent', levels: [{ minQty: 5, value: 3 }, { minQty: 5, value: 5 }] }), normalPrice: 105 })[0]).toContain('higher than the one before')
    expect(businessPriceProblems({ setting: pct(5, { type: 'percent', levels: [{ minQty: 2, value: 5 }, { minQty: 5, value: 5 }] }), normalPrice: 105 })[0]).toContain('bigger than the one before')
    expect(businessPriceProblems({ setting: fixed(99, { type: 'fixed', levels: [{ minQty: 2, value: 95 }, { minQty: 5, value: 96 }] }), normalPrice: 105 })[0]).toContain('lower than the one before')
    expect(businessPriceProblems({ setting: fixed(99, { type: 'fixed', levels: [{ minQty: 2, value: 99 }] }), normalPrice: 105 })[0]).toContain('lower than the business price')
    expect(businessPriceProblems({ setting: fixed(99, { type: 'fixed', levels: [{ minQty: 2, value: 95 }, { minQty: 5, value: 90 }] }), normalPrice: 105 })).toEqual([])
  })
  it('the minimum and maximum seller prices bound the business price and every tier', () => {
    expect(businessPriceProblems({ setting: pct(20), normalPrice: 105, minPrice: 90 })[0]).toContain('below this listing\'s minimum price')
    expect(businessPriceProblems({ setting: pct(5, { type: 'percent', levels: [{ minQty: 2, value: 10 }] }), normalPrice: 105, minPrice: 90 })[0]).toContain('quantity discount reaches 89.78')
    expect(businessPriceProblems({ setting: fixed(99), normalPrice: 120, maxPrice: 95 })[0]).toContain('maximum price')
  })
})

describe('businessPriceWarnings — saves, but says', () => {
  it('a sale below the business price; a fixed price the normal price has fallen below', () => {
    expect(businessPriceWarnings({ setting: pct(5), normalPrice: 105, salePrice: 89 })[0]).toContain('sale price 89.00 is lower')
    expect(businessPriceWarnings({ setting: fixed(99), normalPrice: 95 })[0]).toMatch(/^Hidden by Amazon/)
    expect(businessPriceWarnings({ setting: pct(5), normalPrice: 105 })).toEqual([])
  })
})

it('readBusinessTiers reads the stored JSON tolerantly', () => {
  expect(readBusinessTiers({ type: 'percent', levels: [{ minQty: 2, value: 3 }, { minQty: 'x', value: 1 }] })).toEqual({ type: 'percent', levels: [{ minQty: 2, value: 3 }] })
  expect(readBusinessTiers({ type: 'other', levels: [] })).toBeNull()
  expect(readBusinessTiers(null)).toBeNull()
})

describe('review fixes (2026-10-12)', () => {
  it('an unknown tier type is refused, never read as fixed', () => {
    expect(businessPriceProblems({ setting: fixed(99, { type: 'weird' as never, levels: [{ minQty: 2, value: 95 }] }), normalPrice: 105 })[0]).toContain('a percent or a fixed price')
  })
  it('fixed tiers with a percent business price are refused (it moves with the normal price)', () => {
    expect(businessPriceProblems({ setting: pct(5, { type: 'fixed', levels: [{ minQty: 2, value: 90 }] }), normalPrice: 105 })[0]).toContain('go with an exact business price')
  })
  it('a percent tier that reaches 0.00 is refused', () => {
    expect(businessPriceProblems({ setting: fixed(0.01, { type: 'percent', levels: [{ minQty: 2, value: 60 }] }), normalPrice: 105 })[0]).toContain('above 0')
  })
})

it('rounds to the NEAREST cent, and a price equal to the minimum is allowed', () => {
  expect(businessPriceOf(pct(5), 29.9)).toBe(28.41) // 28.405 → 28.41, never 28.40
  expect(businessPriceProblems({ setting: fixed(90), normalPrice: 105, minPrice: 90 })).toEqual([])
  expect(businessPriceProblems({ setting: fixed(150), normalPrice: 200, maxPrice: 150 })).toEqual([])
})
