import { describe, expect, it } from 'vitest'
import { informationRegistry, type InformationRow } from '@nexus/shared/shopify-information'
import { emptyShopifyLinkedDraft } from '@nexus/shared/shopify-linked-products'
import { acceptsTextTransfer, applyInformationCells, editTags, informationRestriction } from './informationEditing'
const product: InformationRow = { id: 'gid://shopify/Product/1', productId: 'gid://shopify/Product/1', title: 'MOSS', handle: 'moss', kind: 'PRODUCT', image: null, media: [], fields: [], values: { title: 'MOSS', tags: '[]' } }
const variant: InformationRow = { ...product, id: 'gid://shopify/ProductVariant/11', title: 'S', kind: 'PRODUCTVARIANT', values: { price: '10.00', sku: '00001' } }
const fields = informationRegistry(null), price = fields.find(f => f.id === 'price')!, sku = fields.find(f => f.id === 'sku')!
describe('Information semantic commands', () => {
  it('applies category constraints to editing and fill without discarding existing values', () => {
    const definition = { id: '1', namespace: 'custom', key: 'material', name: 'Material', ownerType: 'PRODUCT', type: 'single_line_text_field', validations: [], description: null, access: { admin: null, storefront: null }, constraints: { key: 'category', values: ['aa-8-1'] } }
    const field = informationRegistry({ revision: '2', definitions: [definition], types: [], metaobjectDefinitions: [], locales: [] }).find(f => f.definition)!
    const row = { ...product, values: { ...product.values, category: 'gid://shopify/TaxonomyCategory/aa-8-10' } }
    const draft = emptyShopifyLinkedDraft()
    expect(informationRestriction(row, field, draft, false)).toContain('does not apply')
    expect(() => applyInformationCells(draft, [{ row, field, value: 'Cotton' }], [row], false)).toThrow('does not apply')
    row.values.category = 'gid://shopify/TaxonomyCategory/aa-8-1'
    expect(applyInformationCells(draft, [{ row, field, value: 'Cotton' }], [row], false).edits[0].nextValue).toBe('Cotton')
    expect(draft.edits).toEqual([])
  })
  it('preserves a pending value when the store changes its field type', () => {
    const definition = { id: '1', namespace: 'custom', key: 'material', name: 'Material', ownerType: 'PRODUCT', type: 'number_integer', validations: [], description: null, access: { admin: null, storefront: null } }
    const field = informationRegistry({ revision: '2', definitions: [definition], types: [], metaobjectDefinitions: [], locales: [] }).find(f => f.definition)!
    const draft = { ...emptyShopifyLinkedDraft(), edits: [{ ownerId: product.id, namespace: 'custom', key: 'material', type: 'single_line_text_field', value: null, compareDigest: null, nextValue: 'Cotton', ownerLabel: product.title }] }
    expect(informationRestriction(product, field, draft, false)).toMatch(/type changed/)
    expect(() => applyInformationCells(draft, [{ row: product, field, value: '2' }], [product], false)).toThrow(/type changed/)
    expect(draft.edits[0].nextValue).toBe('Cotton')
  })
  it('applies explicit tag add/remove/replace operations and supports an empty collection', () => {
    expect(editTags('["Jacket","Racing"]', 'New\nJacket\n', 'add')).toBe('["Jacket","Racing","New"]')
    expect(editTags('["Jacket","Racing"]', 'Jacket', 'remove')).toBe('["Racing"]')
    expect(editTags('["Jacket","Racing"]', '', 'replace')).toBe('[]')
    expect(() => editTags('{"unexpected":true}', 'new', 'add')).toThrow(/review/)
  })
  it('applies an entire paste without mutating its base, retaining identifiers', () => {
    const base = emptyShopifyLinkedDraft()
    const next = applyInformationCells(base, [{ row: variant, field: sku, value: '00002-A' }, { row: variant, field: price, value: '0.00' }], [product, variant], false)
    expect(base).toEqual(emptyShopifyLinkedDraft())
    expect(next.nativeEdits?.map(e => e.nextValue)).toEqual(['00002-A', '0.00'])
    expect(next.members[0].id).toBe(product.id)
  })
  it('preserves the original baseline across multiple commands and removes a reverted draft', () => {
    const first = applyInformationCells(emptyShopifyLinkedDraft(), [{ row: variant, field: price, value: '12.00' }], [product, variant], false)
    const second = applyInformationCells(first, [{ row: variant, field: price, value: '13.00' }], [product, variant], false)
    expect(second.nativeEdits?.[0].value).toBe('10.00')
    expect(applyInformationCells(second, [{ row: variant, field: price, value: '10' }], [product, variant], false).nativeEdits).toEqual([])
  })
  it('refuses the complete command when a target is inapplicable, preserving the input', () => {
    const base = emptyShopifyLinkedDraft()
    expect(() => applyInformationCells(base, [{ row: variant, field: price, value: '12' }, { row: product, field: price, value: '13' }], [product, variant], false)).toThrow(/variant/)
    expect(base.edits).toEqual([]); expect(base.nativeEdits).toBeUndefined()
  })
  it('blocks unauthorized edits and unknown adapter fields', () => {
    expect(() => applyInformationCells(emptyShopifyLinkedDraft(), [{ row: variant, field: sku, value: '00002' }], [product, variant], true)).toThrow(/permission/)
    expect(() => applyInformationCells(emptyShopifyLinkedDraft(), [{ row: variant, field: { ...sku, id: 'missing' }, value: '1' }], [product, variant], false)).toThrow(/unavailable/)
  })
  it('keeps text clipboard operations away from lists and typed identities', () => {
    expect(acceptsTextTransfer(price)).toBe(true)
    expect(acceptsTextTransfer({ ...sku, type: 'page_reference' })).toBe(false)
    expect(acceptsTextTransfer(fields.find(f => f.id === 'tags')!)).toBe(false)
  })
  it('retains unresolved reference IDs during unrelated changes', () => {
    const base = { ...emptyShopifyLinkedDraft(), edits: [{ ownerId: product.id, namespace: 'custom', key: 'features', type: 'list.metaobject_reference', value: '["gid://shopify/Metaobject/999"]', nextValue: '["gid://shopify/Metaobject/999","gid://shopify/Metaobject/12"]', compareDigest: 'base', ownerLabel: 'MOSS' }] }
    const next = applyInformationCells(base, [{ row: variant, field: price, value: '12' }], [product, variant], false)
    expect(next.edits).toEqual(base.edits)
  })
})
