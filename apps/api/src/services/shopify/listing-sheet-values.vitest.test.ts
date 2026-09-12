import { describe, expect, it } from 'vitest'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { listingSheetValues } from './listing-sheet-values.js'
import { nativeListingValue } from './native-listing-value.js'
const productId = 'gid://shopify/Product/10', variantId = 'gid://shopify/ProductVariant/11'
const schema = { locales: [{ locale: 'en', primary: true }], definitions: [], types: [] } as unknown as ShopifyStoreSchema
const pin = (fieldId: string, type: string, value: string | null, ownerId = productId) => ({ fieldId, type, value, ownerId, locale: '' })
describe('full publication retains common sheet overrides', () => {
  it('uses exact native owners and preserves false, zero, empty and inherited distinctions', () => {
    const listings = [{ productId: 'family', externalListingId: '10', followMasterTitle: true, platformAttributes: { untouched: true, _nexusContentPublish: { variantIds: { child: variantId } }, _nexusLinkedProducts: { sheetValues: [pin('title', 'single_line_text_field', 'Pinned title'), pin('vendor', 'single_line_text_field', ''), pin('taxable', 'boolean', 'false', variantId), pin('price', 'money', '0', variantId), { ...pin('handle', 'single_line_text_field', 'old'), inherited: true }] } } }, { productId: 'child', externalListingId: '10', platformAttributes: {} }]
    const before = JSON.stringify(listings), result = listingSheetValues(listings, 'family', 'store-a', schema)
    expect(JSON.stringify(listings)).toBe(before)
    expect(result[0]).toMatchObject({ followMasterTitle: false, titleOverride: 'Pinned title' })
    expect(nativeListingValue(result[0], 'vendor', 'Shared brand')).toBe('')
    expect(nativeListingValue(result[1], 'taxable')).toBe(false)
    expect(nativeListingValue(result[1], 'price')).toBe('0')
    expect(nativeListingValue(result[0], 'handle', 'inherited')).toBe('inherited')
    expect(result[0].platformAttributes).toMatchObject({ untouched: true })
  })
  it('blocks lost owner and changed type instead of dropping an override', () => {
    const listing = { productId: 'family', externalListingId: '10', platformAttributes: { _nexusLinkedProducts: { sheetValues: [pin('title', 'single_line_text_field', 'Pinned title', 'gid://shopify/Product/99')] } } }
    expect(() => listingSheetValues([listing], 'family', 'store-a', schema)).toThrow('another Shopify owner')
    listing.platformAttributes._nexusLinkedProducts.sheetValues = [pin('title', 'number_decimal', '0')]
    expect(() => listingSheetValues([listing], 'family', 'store-a', schema)).toThrow('changed definition')
  })
})
