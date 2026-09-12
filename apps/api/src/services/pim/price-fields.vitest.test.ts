import { describe, expect, it } from 'vitest'
import { isPriceFieldKey } from './price-fields.js'

describe('isPriceFieldKey — formulas are a PRICING tool (Owner, 2026-09-05)', () => {
  it('admits the master prices and the channel price attributes, with or without the attr_ prefix', () => {
    for (const k of ['basePrice', 'costPrice', 'attr_list_price', 'uvp_list_price', 'list_price.value_with_tax', 'purchasable_offer', 'purchasable_offer__our_price', 'attr_purchasable_offer[1]', 'sale_price']) {
      expect(isPriceFieldKey(k), k).toBe(true)
    }
  })
  it('refuses everything else — including the Offer group’s NON-price attributes, which is why group is not consulted', () => {
    for (const k of ['brand', 'manufacturer', 'sku', 'item_name', 'supplemental_condition_information__accessories', 'condition_type', 'weave_type', 'attr_bullet_point[1]', '', null, undefined]) {
      expect(isPriceFieldKey(k as string), String(k)).toBe(false)
    }
  })
  it('refuses scheduling and rule identifiers nested inside Amazon offers and prices', () => {
    for (const key of ['purchasable_offer__start_at', 'purchasable_offer__end_at',
      'purchasable_offer__discounted_price__start_at', 'purchasable_offer__discounted_price__end_at',
      'purchasable_offer__automated_pricing_merchandising_rule_plan', 'list_price.currency']) {
      expect(isPriceFieldKey(key), key).toBe(false)
    }
    expect(isPriceFieldKey('purchasable_offer__discounted_price__value_with_tax')).toBe(true)
  })
})
