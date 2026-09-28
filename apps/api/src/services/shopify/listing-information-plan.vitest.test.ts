import { describe, expect, it, vi } from 'vitest'
import { shopifyProductSpec } from '../pim/channel-specs/store.js'
import { channelValuePatch } from '../pim/channel-value-mutation.js'
import { listingInformationTranslations, validateListingInformationOverrides } from './listing-information-plan.js'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
const read = vi.hoisted(() => ({ rows: [] as unknown[] }))
vi.mock('./information-gateway.js', () => ({ readInformation: async () => ({ rows: read.rows }) }))
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
  /* Found on a real development store (D2, 2026-09-28): "Add child" gives each child its own name, so with a second language every
     child row resolved the Shopify PRODUCT title as stored and the step threw — after Shopify had created the product. */
  describe('translations of a new family', () => {
    const PRODUCT = 'gid://shopify/Product/1', family = { id: 'family', name: 'Giacca prova', translations: [] }
    const row = (productId: string, product: Record<string, unknown>, platformAttributes: Record<string, unknown> = {}) => ({ ...listing, id: `listing-${productId}`, languages: ['en'], productId, product, platformAttributes })
    const rows = [row('family', family), row('child', { id: 'child', parentId: 'family', name: 'Giacca prova', parent: family, translations: [] })]
    const input = (listings: ReturnType<typeof row>[]) => ({ accountId: 'store-a', familyId: 'family', productId: PRODUCT, variantIds: { child: 'gid://shopify/ProductVariant/2' }, listings })
    read.rows = [{ id: PRODUCT, productId: PRODUCT, kind: 'PRODUCT', title: 'Test jacket', handle: 'test-jacket', image: null, values: {}, fields: [], media: [], translations: { title: { key: 'title', digest: 'source', locale: 'it', value: null, sourceValue: 'Test jacket', outdated: false } } }]
    it('sends the family row\'s product title and skips the child rows\' own names', async () => {
      const draft = await listingInformationTranslations(async () => ({}) as never, input(rows), schema)
      expect(draft.nativeEdits).toEqual([expect.objectContaining({ ownerId: PRODUCT, field: 'translation', nextValue: 'Giacca prova' })])
    })
    it('still refuses a product translation pinned on a child\'s listing, which would be lost', async () => {
      const pinned = row('child', rows[1].product, { _shopifyInformationLocales: { it: { title: 'Solo figlio' } } })
      await expect(listingInformationTranslations(async () => ({}) as never, input([rows[0], pinned]), schema)).rejects.toThrow('A product translation is stored on another row.')
    })
  })
})
