import { describe, expect, it } from 'vitest'
import { informationGroups, informationRegistry, mediaMoves, mediaOrderEditSchema, moveMedia, nativeFieldError, nativeValuesEqual } from './shopify-information.js'
import { emptyShopifyLinkedDraft, linkedDraftSignature, shopifyLinkedDraftSchema, type ShopifyStoreSchema } from './shopify-linked-products.js'
const productId = 'gid://shopify/Product/1', variantId = 'gid://shopify/ProductVariant/11'
const schema: ShopifyStoreSchema = { definitions: [], metaobjectDefinitions: [], types: [], locales: [], revision: '1' }
describe('Shopify Information field identities', () => {
  it('uses Nexus labels for confirmed equivalents without equating distinct attributes', () => {
    const labels = Object.fromEntries(informationRegistry(schema).map(f => [f.id, f.label]))
    expect(labels).toMatchObject({ title: 'Name', descriptionHtml: 'Description', sku: 'SKU', cost: 'Cost',
      'seo.title': 'SEO title', 'seo.description': 'SEO description', handle: 'URL handle', templateSuffix: 'Theme template', vendor: 'Brand', harmonizedSystemCode: 'HS code' })
  })
  it('declares native attributes without inventing store metafields', () => {
    const fields = informationRegistry(schema)
    expect(fields).toHaveLength(30)
    expect(new Set(fields.map(f => f.id)).size).toBe(fields.length)
    expect(fields.every(f => f.discovery === 'adapter')).toBe(true)
    expect(fields.some(f => f.label === 'Size Chart')).toBe(false)
  })
  it('uses the live name and keeps product and variant definitions separate', () => {
    const def = { id: 'size', namespace: 'custom', key: 'size_chart', name: 'Our renamed chart', ownerType: 'PRODUCT', type: 'page_reference', description: null, validations: [], access: { admin: null, storefront: null } }
    const fields = informationRegistry({ ...schema, definitions: [def, { ...def, id: 'variant', ownerType: 'PRODUCTVARIANT', type: 'file_reference' }] })
    expect(fields.find(f => f.id === 'metafield:PRODUCT:custom.size_chart')).toMatchObject({ label: 'Our renamed chart', owner: 'PRODUCT', type: 'page_reference' })
    expect(fields.find(f => f.id === 'metafield:PRODUCTVARIANT:custom.size_chart')?.type).toBe('file_reference')
  })
  it('adds, renames, updates and removes columns solely from the selected store schema', () => {
    const def = { id: 'one', namespace: 'custom', key: 'material', name: 'Material', ownerType: 'PRODUCT', type: 'single_line_text_field', description: null, validations: [], access: { admin: null, storefront: null } }
    const first = informationRegistry({ ...schema, definitions: [def] }).filter(f => f.definition)
    const changed = informationRegistry({ ...schema, definitions: [{ ...def, id: 'recreated', name: 'Fabric', type: 'list.single_line_text_field' }] }).filter(f => f.definition)
    expect(changed[0]).toMatchObject({ id: first[0].id, label: 'Fabric', cardinality: 'list' })
    expect(informationRegistry(schema).filter(f => f.definition)).toEqual([])
    expect(informationRegistry({ ...schema, definitions: [{ ...def, key: 'store_b' }] }).some(f => f.id === first[0].id)).toBe(false)
  })
  it('keeps Shopify category metafields in their own group using store identifiers', () => {
    const def = { id: 'care', namespace: 'shopify', key: 'care', name: 'Care', ownerType: 'PRODUCT', type: 'single_line_text_field', description: null, validations: [], access: { admin: null, storefront: null } }
    expect(informationRegistry({ ...schema, definitions: [def] }).find(f => f.definition)?.group).toBe('Category Metafields')
  })
  it('enables pinned native writers and distinguishes computed or unreadable fields', () => {
    const fields = informationRegistry(schema)
    for (const id of ['barcode', 'inventory', 'salesChannels']) expect(fields.find(f => f.id === id)?.editor).not.toBe('unavailable')
    for (const id of ['publishDate', 'scheduled', 'package']) expect(fields.find(f => f.id === id)?.editor).toBe('unavailable')
  })
})
describe('Information values and draft ownership', () => {
  const edit = { ownerId: variantId, productId, field: 'price' as const, value: '10.00', nextValue: '0.00', ownerLabel: 'MOSS / S' }
  it('allows zero and preserves decimal strings without numeric conversion', () => {
    expect(nativeFieldError(edit)).toBeNull()
    const draft = { ...emptyShopifyLinkedDraft(), members: [{ id: productId, title: 'MOSS', handle: 'moss', image: null }], nativeEdits: [edit] }
    expect(shopifyLinkedDraftSchema.parse(draft).nativeEdits?.[0].nextValue).toBe('0.00')
  })
  it('rejects price on a product parent and prevents a hidden variant rewrite', () => expect(nativeFieldError({ ...edit, ownerId: productId })).toMatch(/belong/))
  it('preserves leading zero SKU and HS codes', () => {
    expect(nativeFieldError({ ...edit, field: 'sku', nextValue: '00012-A' })).toBeNull()
    expect(nativeFieldError({ ...edit, field: 'harmonizedSystemCode', nextValue: '001234' })).toBeNull()
  })
  it('distinguishes false from unset and nullable price from zero', () => {
    expect(nativeFieldError({ ...edit, field: 'taxable', nextValue: 'false' })).toBeNull()
    expect(nativeFieldError({ ...edit, field: 'taxable', nextValue: null })).toBeTruthy()
    expect(nativeFieldError({ ...edit, field: 'compareAtPrice', nextValue: null })).toBeNull()
  })
  it('rejects unreviewed product ownership and duplicate pending commands', () => {
    expect(shopifyLinkedDraftSchema.safeParse({ ...emptyShopifyLinkedDraft(), nativeEdits: [edit] }).success).toBe(false)
    expect(shopifyLinkedDraftSchema.safeParse({ ...emptyShopifyLinkedDraft(), members: [{ id: productId, title: 'MOSS', handle: 'moss', image: null }], nativeEdits: [edit, edit] }).success).toBe(false)
  })
  it('leaves legacy drafts valid without adding false dirty fields', () => expect(shopifyLinkedDraftSchema.parse(emptyShopifyLinkedDraft())).toEqual(emptyShopifyLinkedDraft()))
  it('does not report an untouched draft as dirty after reordered JSON keys or optional empty commands', () => {
    const base = emptyShopifyLinkedDraft()
    const received = { mediaEdits: [], ...Object.fromEntries(Object.entries(base).reverse()), nativeEdits: [] }
    expect(linkedDraftSignature(shopifyLinkedDraftSchema.parse(received))).toBe(linkedDraftSignature(base))
  })
  it('compares decimal formatting without losing precision or collapsing unset into zero', () => {
    expect(nativeValuesEqual('price', '00012.00', '12.0')).toBe(true)
    expect(nativeValuesEqual('price', '9007199254740993.01', '9007199254740993.02')).toBe(false)
    expect(nativeValuesEqual('compareAtPrice', null, '0')).toBe(false)
    expect(nativeValuesEqual('sku', '0012', '12')).toBe(false)
    expect(nativeValuesEqual('tags', '["Racing","Jacket"]', '["Jacket","Racing"]')).toBe(true)
    expect(nativeValuesEqual('other', '["Racing","Jacket"]', '["Jacket","Racing"]')).toBe(false)
  })
})
describe('Stable association ordering', () => {
  const ids = [1, 2, 3, 4].map(n => `gid://shopify/MediaImage/${n}`)
  it('moves third to first preserving the other relative positions', () => expect(moveMedia(ids, ids[2], 0)).toEqual([ids[2], ids[0], ids[1], ids[3]]))
  it('supports beginning, end, and no-op without changing the source list', () => {
    expect(moveMedia(ids, ids[0], 3)).toEqual([ids[1], ids[2], ids[3], ids[0]])
    expect(moveMedia(ids, ids[1], 1)).toEqual(ids)
    expect(ids[0]).toBe('gid://shopify/MediaImage/1')
  })
  it('creates sequential zero-based API moves, never URL swaps', () => {
    const after = [ids[2], ids[0], ids[3], ids[1]]
    expect(mediaMoves(ids, after)).toEqual([{ id: ids[2], newPosition: '0' }, { id: ids[3], newPosition: '2' }])
  })
  it('rejects duplicate, missing and added associations', () => {
    for (const nextValue of [[...ids, ids[0]], ids.slice(1), [ids[0], ids[0], ids[2], ids[3]]]) {
      expect(() => mediaMoves(ids, nextValue)).toThrow()
      expect(mediaOrderEditSchema.safeParse({ productId, ownerLabel: 'MOSS', value: ids, nextValue }).success).toBe(false)
    }
  })
})
