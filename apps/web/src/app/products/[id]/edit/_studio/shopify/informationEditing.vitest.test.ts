import { describe, expect, it } from 'vitest'
import { informationRegistry, type InformationRow } from '@nexus/shared/shopify-information'
import { emptyShopifyLinkedDraft, validateShopifyField } from '@nexus/shared/shopify-linked-products'
import { acceptsTextTransfer, applyInformationCells, editTags, informationRestriction, informationDraftCellError, informationValueLabel } from './informationEditing'
const product: InformationRow = { id: 'gid://shopify/Product/1', productId: 'gid://shopify/Product/1', title: 'MOSS', handle: 'moss', kind: 'PRODUCT', image: null, media: [], fields: [], values: { title: 'MOSS', tags: '[]' } }
const variant: InformationRow = { ...product, id: 'gid://shopify/ProductVariant/11', title: 'S', kind: 'PRODUCTVARIANT', values: { price: '10.00', sku: '00001' } }
const fields = informationRegistry(null), price = fields.find(f => f.id === 'price')!, sku = fields.find(f => f.id === 'sku')!
describe('Information semantic commands', () => {
  it.each(['', '   ', null])('stores blank title %j only with the common content-write capability', value => {
    const title = fields.find(f => f.id === 'title')!
    expect(informationDraftCellError(title, value, 'Old title', true)).toBeNull()
    expect(informationDraftCellError(title, value, 'Old title', false)).toBeTruthy()
  })
  it('keeps native storage size, line shape, price, boolean and identity checks', () => {
    for (const [key, value] of [['title', ' '.repeat(60001)], ['title', '\n'], ['price', '-1'], ['taxable', 'yes'], ['handle', 'BAD HANDLE']]) {
      const field = fields.find(f => f.id === key)!
      expect(informationDraftCellError(field, value, null, true), key).toBeTruthy()
    }
  })
  it.each(['four', '', null])('stores the draft %j while retaining the store length/required verdict', value => {
    const definition = { id: '1', namespace: 'custom', key: 'label', name: 'Label', ownerType: 'PRODUCT', type: 'single_line_text_field', required: true, validations: [{ name: 'max', value: '3' }], description: null, access: { admin: null, storefront: null } }
    const field = informationRegistry({ revision: '1', definitions: [definition], types: [], metaobjectDefinitions: [], locales: [] }).find(f => f.definition)!
    const row = { ...product, fields: [{ ownerId: product.id, namespace: 'custom', key: 'label', type: definition.type, value: 'old', compareDigest: 'baseline' }] }
    const draft = emptyShopifyLinkedDraft()
    const next = applyInformationCells(draft, [{ row, field, value }], [row], false)
    expect(next.edits).toEqual([expect.objectContaining({ value: 'old', nextValue: value, compareDigest: 'baseline' })])
    expect(validateShopifyField(definition, value)).toBe(value === null ? 'Enter a value. Shopify needs this field.' : value === '' ? 'Enter one line of text, or clear the field.' : 'Use 3 characters or fewer. Now: 4.')
    expect(draft).toEqual(emptyShopifyLinkedDraft())
  })
  it.each([
    ['number_integer', '1.5'], ['number_integer', '9007199254740993'], ['number_decimal', 'four'],
    ['boolean', 'yes'], ['list.number_integer', '[1,"bad"]'], ['list.single_line_text_field', '{"not":"a list"}'],
  ])('still refuses malformed %s storage', (type, value) => {
    const definition = { id: '1', namespace: 'custom', key: 'value', name: 'Value', ownerType: 'PRODUCT', type, validations: [], description: null, access: { admin: null, storefront: null } }
    const field = informationRegistry({ revision: '1', definitions: [definition], types: [], metaobjectDefinitions: [], locales: [] }).find(f => f.definition)!
    const draft = emptyShopifyLinkedDraft()
    expect(() => applyInformationCells(draft, [{ row: product, field, value }], [product], false)).toThrow()
    expect(draft).toEqual(emptyShopifyLinkedDraft())
  })
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
/* S1 item 6 (product sheet consistency) — Shopify stores KILOGRAMS; a person reads "1.2 kg". The stored code is unchanged. */
describe('a Shopify weight reads as its symbol', () => {
  it.each([['GRAMS', '250 g'], ['KILOGRAMS', '1.2 kg'], ['OUNCES', '3 oz'], ['POUNDS', '2 lb']])('%s', (unit, words) => {
    const value = Number(words.split(' ')[0])
    expect(informationValueLabel('weight', JSON.stringify({ value, unit }))).toBe(words)
  })
  it('other measurements keep Shopify\'s unit name; an unknown weight unit is shown as it is', () => {
    expect(informationValueLabel('volume', '{"value":2,"unit":"MILLILITERS"}')).toBe('2 MILLILITERS')
    expect(informationValueLabel('weight', '{"value":2,"unit":"stone"}')).toBe('2 stone')
  })
  it('the weight check takes Shopify\'s codes and refuses a capital handle with Shopify\'s reason', () => {
    const weight = fields.find(f => f.id === 'weight')!, handle = fields.find(f => f.id === 'handle')!
    expect(informationDraftCellError(weight, '{"value":1.2,"unit":"KILOGRAMS"}', null, false)).toBeNull()
    expect(informationDraftCellError(handle, 'Moss-Jacket', 'moss-jacket', false)).toBe('Use lowercase letters, numbers and separating hyphens.')
  })
})
/* Wave 2 D4 — "Shopify status" reads in Title Case; the stored value stays Shopify's code. */
describe('a Shopify status reads in Title Case', () => {
  it.each([['ACTIVE', 'Active'], ['DRAFT', 'Draft'], ['ARCHIVED', 'Archived'], ['UNLISTED', 'Unlisted']])('%s', (code, words) => {
    expect(informationValueLabel('status', code)).toBe(words)
  })
  it('an unknown code is shown as Shopify wrote it; no value keeps its words; the field is "Shopify status"', () => {
    expect(informationValueLabel('status', 'SCHEDULED')).toBe('SCHEDULED')
    expect(informationValueLabel('status', null)).toBe('Not set')
    const status = fields.find(f => f.id === 'status')!
    expect(status.label).toBe('Shopify status')
    expect(informationDraftCellError(status, 'ACTIVE', 'DRAFT', false)).toBeNull()
  })
})
