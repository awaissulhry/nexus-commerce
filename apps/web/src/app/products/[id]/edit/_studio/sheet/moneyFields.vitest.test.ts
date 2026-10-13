import { describe, expect, it } from 'vitest'
import { isMoneyColumn, moneyText } from './moneyFields'

describe('money in a sheet number cell', () => {
  it('takes the price keys of the master and the channels, and nothing else', () => {
    for (const key of ['basePrice', 'costPrice', 'minPrice', 'maxPrice', 'list_price', 'purchasable_offer__our_price', 'purchasable_offer__map_price',
      'purchasable_offer__minimum_seller_allowed_price', 'purchasable_offer__discounted_price__value_with_tax', 'price', 'compare_at_price']) {
      expect(isMoneyColumn({ key, kind: 'number' }), key).toBe(true)
    }
    for (const key of ['minMargin', 'totalStock', 'lowStockThreshold', 'weightValue', 'max_order_quantity', 'purchasable_offer__automated_pricing_merchandising_rule_plan']) {
      expect(isMoneyColumn({ key, kind: 'number' }), key).toBe(false)
    }
    expect(isMoneyColumn({ key: 'basePrice', kind: 'text' })).toBe(false)
  })

  it('draws two decimals, groups thousands the same in every browser, and never hides stored precision', () => {
    expect(moneyText(105)).toBe('105.00')
    expect(moneyText(99.75)).toBe('99.75')
    expect(moneyText(0)).toBe('0.00')
    expect(moneyText(1234.5)).toBe('1,234.50')
    expect(moneyText('89.9')).toBe('89.90')
    expect(moneyText(99.999)).toBe('99.999')
    expect(moneyText(-12)).toBe('-12.00')
  })

  it('leaves what is not a number to the caller', () => {
    for (const v of [null, undefined, '', 'abc', Number.NaN, {}]) expect(moneyText(v)).toBeNull()
  })
})
