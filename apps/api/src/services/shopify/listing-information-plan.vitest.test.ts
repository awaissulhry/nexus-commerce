import { describe, expect, it, vi } from 'vitest'
import { shopifyProductSpec } from '../pim/channel-specs/store.js'
import { channelValuePatch } from '../pim/channel-value-mutation.js'
import { validateListingInformationOverrides } from './listing-information-plan.js'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
const schema: ShopifyStoreSchema = { definitions: [{ id: 'definition-1', namespace: 'custom', key: 'copy', ownerType: 'PRODUCT', name: 'Copy', type: 'single_line_text_field', description: null, access: { admin: 'PUBLIC_READ_WRITE', storefront: null }, validations: [] }], metaobjectDefinitions: [], types: [{ name: 'single_line_text_field', category: 'TEXT' }], locales: [{ locale: 'en', primary: true, published: true }, { locale: 'it', primary: false, published: true }], native: { scopes: ['write_products', 'write_translations'], enums: {}, inputs: { variant: ['price'] } }, revision: '1' }
const listing = { id: 'listing', channel: 'SHOPIFY', marketplace: 'GLOBAL', languages: ['en', 'it'], product: { id: 'family', translations: [] }, productId: 'family', channelConnectionId: 'store-a', platformAttributes: {} }
describe('Channel sheet schema, storage and publication validation', () => {
  it('requires a category before creation and defers inherited existing categories to the remote plan', () => {
    const constrained = { ...schema, native: { ...schema.native!, inputs: { ...schema.native!.inputs, product: ['category'] } }, definitions: [{ ...schema.definitions[0], constraints: { key: 'category', values: ['aa-8'] } }] }
    const field = shopifyProductSpec(constrained, 'store-a').fields.find(f => f.shopifyField?.definition)!
    const saved = { ...listing, ...channelValuePatch(listing, field.channelStore, [field.key], 'SET', 'Copy') }
    expect(() => validateListingInformationOverrides([saved], 'store-a', constrained)).toThrow('category')
    expect(() => validateListingInformationOverrides([saved], 'store-a', constrained, false)).not.toThrow()
    const categorized = { ...saved, platformAttributes: { ...saved.platformAttributes, category: 'gid://shopify/TaxonomyCategory/aa-8' } }
    expect(() => validateListingInformationOverrides([categorized], 'store-a', constrained)).not.toThrow()
  })
  it('isolates base and translated fields while keeping native shared fields read-only in another language', () => {
    const base = shopifyProductSpec(schema, 'store-a').fields.find(f => f.shopifyField?.definition)!
    const it = shopifyProductSpec(schema, 'store-a', 'it').fields.find(f => f.shopifyField?.definition)!
    const first = { ...listing, ...channelValuePatch(listing, base.channelStore, [base.key], 'SET', 'Source') }
    const next = { ...first, ...channelValuePatch(first, it.channelStore, [it.key], 'SET', 'Italiano') }
    expect(next.platformAttributes).toMatchObject({ metafields: { PRODUCT: { custom: { copy: { single_line_text_field: 'Source' } } } }, _shopifyInformationLocales: { it: { 'metafield:PRODUCT:custom.copy': 'Italiano' } } })
    const price = shopifyProductSpec(schema, 'store-a', 'it').fields.find(f => f.shopifyField?.id === 'price')!
    expect(price.editable).toBe(false); expect(price.readOnlyReason).toContain('shares this field')
    expect(() => validateListingInformationOverrides([next], 'store-a', schema)).not.toThrow()
  })
  it('rejects another store and unavailable languages before publication', () => {
    expect(() => validateListingInformationOverrides([listing], 'store-b', schema)).toThrow('another Shopify store')
    expect(() => shopifyProductSpec(schema, 'store-a', 'de')).toThrow('not enabled')
  })
  it.each(['url', 'list.url'])('offers %s translation drafts with an exact locale path', type => {
    const localized = shopifyProductSpec({ ...schema, definitions: [{ ...schema.definitions[0], type }] }, 'store-a', 'it').fields.find(f => f.shopifyField?.definition)!
    expect(localized.editable).toBe(true)
    expect(localized.channelStore).toEqual({ kind: 'platformAttributes', path: ['_shopifyInformationLocales', 'it', 'metafield:PRODUCT:custom.copy'] })
  })
  it('removes only the intended translated override on inheritance reset', () => {
    const it = shopifyProductSpec(schema, 'store-a', 'it').fields.find(f => f.shopifyField?.definition)!
    const initial = { ...listing, platformAttributes: { _shopifyInformationLocales: { it: { 'metafield:PRODUCT:custom.copy': 'Italiano' }, en: { keep: 'Source' } }, unrelated: false } }
    const patch = channelValuePatch(initial, it.channelStore, [it.key], 'INHERIT')
    expect(patch.platformAttributes).toEqual({ _shopifyInformationLocales: { it: {}, en: { keep: 'Source' } }, unrelated: false })
  })
  it('fails invalid saved values before any resource creation and respects translation permissions', () => {
    const field = shopifyProductSpec(schema, 'store-a').fields.find(f => f.shopifyField?.definition)!
    const changed = { ...listing, ...channelValuePatch(listing, field.channelStore, [field.key], 'SET', 'line one\nline two') }
    expect(() => validateListingInformationOverrides([changed], 'store-a', schema)).toThrow('one line')
    const denied = shopifyProductSpec({ ...schema, native: { ...schema.native!, scopes: ['write_products'] } }, 'store-a', 'it')
    expect(denied.fields.find(f => f.shopifyField?.definition)?.readOnlyReason).toContain('write_translations')
  })
})
