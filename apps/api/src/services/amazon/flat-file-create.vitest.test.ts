/**
 * FFC — flat-file product-creation mapping. Pure, so the row → Product.create
 * mapping (incl. variants, identifiers, localized content, fallbacks) is fully
 * unit-testable without the DB.
 */
import { describe, it, expect } from 'vitest'
import {
  buildProductCreateInput,
  ffcCollectBullets,
  ffcExtractVariantAxes,
  ffcParseThemeAxes,
} from './flat-file.service.js'

describe('ffcParseThemeAxes', () => {
  it('parses Amazon variation themes into axis names', () => {
    expect(ffcParseThemeAxes('SIZE_COLOR')).toEqual(['Size', 'Color'])
    expect(ffcParseThemeAxes('Color/Size')).toEqual(['Color', 'Size'])
    expect(ffcParseThemeAxes('COLOR')).toEqual(['Color'])
    expect(ffcParseThemeAxes(null)).toEqual([])
  })
})

describe('ffcExtractVariantAxes', () => {
  it('pulls Color + Size from the common columns', () => {
    expect(ffcExtractVariantAxes({ color: 'Black', apparel_size: 'XL' })).toEqual({ Color: 'Black', Size: 'XL' })
    expect(ffcExtractVariantAxes({ color: 'Red' })).toEqual({ Color: 'Red' })
    expect(ffcExtractVariantAxes({})).toEqual({})
  })
})

describe('ffcCollectBullets', () => {
  it('collects bullet_point_1..5 + bare bullet_point', () => {
    expect(ffcCollectBullets({ bullet_point_1: 'A', bullet_point_2: 'B' })).toEqual(['A', 'B'])
  })
})

describe('buildProductCreateInput', () => {
  it('standalone product → full master record', () => {
    const d = buildProductCreateInput(
      { item_sku: 'GALE-XL', item_name: 'Giubbotto Moto', brand: 'Xavia', product_type: 'OUTERWEAR', purchasable_offer__our_price: '129,90', fulfillment_availability__quantity: '5', gtin: '4006381333931' },
      { languageTag: 'it_IT' },
    )
    expect(d).toMatchObject({
      sku: 'GALE-XL', name: 'Giubbotto Moto', basePrice: 129.9, totalStock: 5,
      status: 'ACTIVE', productType: 'OUTERWEAR', brand: 'Xavia', gtin: '4006381333931',
      syncChannels: ['AMAZON'], importSource: 'FLAT_FILE',
    })
    // localizedContent seeded from the market language
    expect(d.localizedContent.it.name).toBe('Giubbotto Moto')
    expect(d.parentId).toBeUndefined()
    expect(d.isParent).toBeUndefined()
  })

  it('falls back: blank name → sku, no/negative price → 0', () => {
    const d = buildProductCreateInput({ item_sku: 'SKU1', purchasable_offer__our_price: '-5' })
    expect(d.name).toBe('SKU1')
    expect(d.basePrice).toBe(0)
    expect(d.totalStock).toBe(0)
  })

  it('parent row → isParent + variationAxes from theme', () => {
    const d = buildProductCreateInput({ item_sku: 'P1', item_name: 'Parent', parentage_level: 'parent', variation_theme: 'SIZE_COLOR' })
    expect(d.isParent).toBe(true)
    expect(d.variationAxes).toEqual(['Size', 'Color'])
    expect(d.variantAttributes).toBeUndefined()
  })

  it('child row → parentId + variantAttributes mirrored into categoryAttributes.variations', () => {
    const d = buildProductCreateInput(
      { item_sku: 'C1', item_name: 'Child', parentage_level: 'child', parent_sku: 'P1', color: 'Black', apparel_size: 'XL' },
      { parentId: 'parent-id-123' },
    )
    expect(d.isParent).toBe(false)
    expect(d.isMasterProduct).toBe(false)
    expect(d.parentId).toBe('parent-id-123')
    expect(d.variantAttributes).toEqual({ Color: 'Black', Size: 'XL' })
    expect(d.categoryAttributes).toEqual({ variations: { Color: 'Black', Size: 'XL' } })
  })
})
