import { describe, expect, it, vi } from 'vitest'
import { shopifyProductSpec } from '../pim/channel-specs/store.js'
import { channelValuePatch } from '../pim/channel-value-mutation.js'
import { listingInformationDraft, listingInformationOverrideReview, listingInformationTranslations, validateListingInformationOverrides } from './listing-information-plan.js'
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
  /* Wave 2 D3 (Owner decision 11, A) — a cleared theme template (stored as '', or an older stored clear) is the store's
     default template: it no longer holds Publish with "Enter a value", and an equal Shopify value needs no edit. */
  it('a cleared theme template passes the check and is no edit where Shopify already uses the default template', async () => {
    const store = { ...schema, native: { ...schema.native!, inputs: { ...schema.native!.inputs, product: [...(schema.native!.inputs.product ?? []), 'templateSuffix'] } } }
    const template = shopifyProductSpec(store, 'store-a').fields.find(f => f.shopifyField?.id === 'templateSuffix')!
    for (const value of ['', null]) {
      const cleared = { ...listing, languages: ['en'], ...channelValuePatch(listing, template.channelStore, [template.key], value === null ? 'CLEAR' : 'SET', value) }
      expect(() => validateListingInformationOverrides([cleared], 'store-a', store)).not.toThrow()
    }
    const PRODUCT = 'gid://shopify/Product/9', before = read.rows
    read.rows = [{ id: PRODUCT, productId: PRODUCT, kind: 'PRODUCT', title: 'Jacket', handle: 'jacket', image: null, values: { templateSuffix: '' }, fields: [], media: [] }]
    try {
      const cleared = { ...listing, languages: ['en'], ...channelValuePatch(listing, template.channelStore, [template.key], 'SET', '') }
      const draft = await listingInformationDraft(null as never, { accountId: 'store-a', familyId: 'family', productId: PRODUCT, variantIds: {}, listings: [cleared] }, store)
      expect(draft.nativeEdits ?? []).toEqual([])
    } finally { read.rows = before }
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
  /* S1 (product sheet consistency) — item 5 (e): after Shopify created a variant with its Shared values, each value it did
     not keep becomes one checked edit; item 6: a weight saved in an older spelling is read in Shopify's code everywhere. */
  describe('values a new variant took from Shared, checked after the create', () => {
    const base = schema
    const PRODUCT = 'gid://shopify/Product/1', VARIANT = 'gid://shopify/ProductVariant/2'
    const variantRow = (values: Record<string, string | null>) => ({ id: VARIANT, productId: PRODUCT, kind: 'PRODUCTVARIANT', title: 'Red / S', handle: 'p', image: null, fields: [], media: [], values })
    const productRow = { id: PRODUCT, productId: PRODUCT, kind: 'PRODUCT', title: 'P', handle: 'p', image: null, fields: [], media: [], values: {} }
    const draftInput = (inherited: Record<string, Record<string, string>>, variantIds: Record<string, string> = { child: VARIANT }) =>
      ({ accountId: 'store-a', familyId: 'family', productId: PRODUCT, variantIds, listings: [], inherited })
    it('adds nothing for a value Shopify kept (a weight in another key order, a cost with trailing zeros)', async () => {
      read.rows = [productRow, variantRow({ barcode: '0001', cost: '9.00', weight: '{"unit":"KILOGRAMS","value":1.2}' })]
      const draft = await listingInformationDraft(async () => ({}) as never, draftInput({ child: { barcode: '0001', cost: '9', weight: '{"value":1.2,"unit":"KILOGRAMS"}' } }), schema)
      expect(draft.nativeEdits ?? []).toEqual([])
    })
    it('one checked edit per value Shopify did not keep, from what Shopify holds now', async () => {
      read.rows = [productRow, variantRow({ barcode: '', countryCodeOfOrigin: null, weight: '{"value":0,"unit":"GRAMS"}' })]
      const draft = await listingInformationDraft(async () => ({}) as never, draftInput({ child: { barcode: '0001', countryCodeOfOrigin: 'IT', weight: '{"value":1.2,"unit":"KILOGRAMS"}' } }), schema)
      expect(draft.nativeEdits).toEqual([
        { ownerId: VARIANT, productId: PRODUCT, ownerLabel: 'Red / S', field: 'barcode', value: '', nextValue: '0001' },
        { ownerId: VARIANT, productId: PRODUCT, ownerLabel: 'Red / S', field: 'countryCodeOfOrigin', value: null, nextValue: 'IT' },
        { ownerId: VARIANT, productId: PRODUCT, ownerLabel: 'Red / S', field: 'weight', value: '{"value":0,"unit":"GRAMS"}', nextValue: '{"value":1.2,"unit":"KILOGRAMS"}' },
      ])
    })
    it('refuses a variant Shopify did not return, never skips it', async () => {
      read.rows = [productRow, variantRow({})]
      await expect(listingInformationDraft(async () => ({}) as never, draftInput({ other: { barcode: '1' } }), schema)).rejects.toThrow('variant mapping changed')
    })
    it('reads a weight saved as kg in Shopify\'s code for the review and for Publish', async () => {
      const schema = { ...base, native: { ...base.native!, inputs: { ...base.native!.inputs, measurement: ['weight'] } } }
      const weight = shopifyProductSpec(schema, 'store-a').fields.find(f => f.shopifyField?.id === 'weight')!
      const child = { ...listing, ...channelValuePatch(listing, weight.channelStore, [weight.key], 'SET', { value: 1.2, unit: 'kg' }) }
      expect(() => validateListingInformationOverrides([child], 'store-a', schema)).not.toThrow()
      expect(listingInformationOverrideReview([child], 'store-a', schema)).toEqual([expect.objectContaining({ label: 'Weight', value: '{"value":1.2,"unit":"KILOGRAMS"}' })])
      read.rows = [productRow, variantRow({ weight: null })]
      const draft = await listingInformationDraft(async () => ({}) as never, { ...draftInput({}, { family: VARIANT }), listings: [child] }, schema)
      expect(draft.nativeEdits).toEqual([expect.objectContaining({ field: 'weight', nextValue: '{"value":1.2,"unit":"KILOGRAMS"}' })])
    })
  })
})
