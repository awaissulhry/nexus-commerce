import { describe, expect, it } from 'vitest'
import { fillPresetDefaults, reusablePresetDefaults } from './preset-defaults.js'

describe('listing preset ownership', () => {
  it('never carries one product’s prices, content, identifiers or selected variants into another product', () => {
    const result = reusablePresetDefaults({ skuStrategy: { childSku: 'shared', parentSku: 'per-marketplace', fbaFbm: 'suffixed', sku: 'JACKET-1' },
      variations: { commonTheme: 'SizeColor', themeByChannel: { EBAY_IT: 'ColorSize' }, includedSkus: ['JACKET-1-M'], inheritByChildId: { childA: false } },
      pricing: { basePrice: 20 }, identifiers: { gtin: '1234567890123' }, content: { title: 'A jacket' } })
    expect(result.defaults).toEqual({ skuStrategy: { childSku: 'shared', parentSku: 'per-marketplace', fbaFbm: 'suffixed' }, variations: { commonTheme: 'SizeColor', themeByChannel: { EBAY_IT: 'ColorSize' } } })
    expect(result.excluded).toEqual(expect.arrayContaining(['pricing', 'identifiers', 'content', 'variations.includedSkus', 'variations.inheritByChildId', 'skuStrategy.sku']))
  })
  it('fills individual missing defaults without disconnecting customized siblings', () => {
    const existing = { skuStrategy: { childSku: 'shared' }, variations: { commonTheme: '', includedSkus: ['A'] }, pricing: { basePrice: 0 } }
    const result = fillPresetDefaults(existing, { skuStrategy: { childSku: 'per-marketplace', parentSku: 'shared' }, variations: { commonTheme: 'Size', themeByChannel: { EBAY_IT: 'Size' } }, pricing: { basePrice: 50 } })
    expect(result).toEqual({ skuStrategy: { childSku: 'shared', parentSku: 'shared' }, variations: { commonTheme: '', includedSkus: ['A'], themeByChannel: { EBAY_IT: 'Size' } }, pricing: { basePrice: 0 } })
    expect(existing.skuStrategy).toEqual({ childSku: 'shared' })
  })
  it('protects explicit null, false and empty arrays', () => {
    expect(fillPresetDefaults({ a: null, b: false, c: [] }, { a: 1, b: true, c: ['x'], d: 0 })).toEqual({ a: null, b: false, c: [], d: 0 })
  })
  it('refuses prototype keys at each level', () => {
    const bad = JSON.parse('{"__proto__":{"polluted":true},"variations":{"themeByChannel":{"constructor":"bad"}}}')
    expect(reusablePresetDefaults(bad).defaults).toEqual({})
    expect(fillPresetDefaults({}, bad)).not.toHaveProperty('polluted')
  })
})
