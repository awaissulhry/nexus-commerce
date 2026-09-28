import { describe, expect, it } from 'vitest'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { baseReferenceType, chosenChoices, listMax, referenceChoice, referenceNoun, referenceUiFor, singleEntryType } from './referenceFieldModel'

/* Made-up store: two entry definitions. */
const schema = {
  metaobjectDefinitions: [
    { id: 'gid://shopify/MetaobjectDefinition/1', type: 'shopify--color-pattern', name: 'Color', fields: [] },
    { id: 'gid://shopify/MetaobjectDefinition/2', type: 'text_with_icon', name: 'Text with icon', fields: [] },
  ],
} as unknown as ShopifyStoreSchema

const colour = { type: 'list.metaobject_reference', validations: [{ name: 'metaobject_definition_id', value: 'gid://shopify/MetaobjectDefinition/1' }] }
const either = { type: 'list.metaobject_reference', validations: [{ name: 'metaobject_definition_ids', value: JSON.stringify(['gid://shopify/MetaobjectDefinition/1', 'gid://shopify/MetaobjectDefinition/2']) }] }

describe('which pop-up a reference field gets', () => {
  it('gives an entry field with ONE entry type the tick list', () => {
    expect(singleEntryType(colour, schema)).toBe('shopify--color-pattern')
    expect(referenceUiFor(colour, schema)).toBe('entries')
  })
  it('keeps the type-first picker for entry fields with several or no named types', () => {
    expect(referenceUiFor(either, schema)).toBe('legacy')
    expect(referenceUiFor({ type: 'metaobject_reference', validations: [] }, schema)).toBe('legacy')
  })
  it('gives product-like fields the ordered list and picker, and keeps fields with unknown kinds or no attribute on the old picker', () => {
    expect(referenceUiFor({ type: 'list.product_reference', validations: [] }, schema)).toBe('resources')
    expect(referenceUiFor({ type: 'file_reference', validations: [] }, schema)).toBe('resources')
    expect(referenceUiFor({ type: 'mixed_reference', validations: [] }, schema)).toBe('legacy')
    expect(referenceUiFor({ type: 'product_taxonomy_value_reference', validations: [] }, schema)).toBe('legacy')
  })
  it('gives a taxonomy value field Shopify’s list only when a category tells which list; else the older picker (B2 review)', () => {
    const colourKind = { id: 'gid://shopify/MetaobjectDefinition/1', type: 'shopify--color-pattern' }
    const baseColour = { type: 'list.product_taxonomy_value_reference', validations: [{ name: 'product_taxonomy_attribute_handle', value: 'color' }], ownerType: 'METAOBJECT', namespace: colourKind.type, constraints: null }
    const productField = (constraints: { key: string; values: string[] } | null) => ({ ...colour, ownerType: 'PRODUCT', namespace: 'shopify', constraints })
    const withProducts = (constraints: { key: string; values: string[] } | null) => ({ ...schema, definitions: [productField(constraints)] }) as unknown as ShopifyStoreSchema
    expect(referenceUiFor(baseColour, withProducts({ key: 'category', values: ['zz-1'] }))).toBe('entries')
    expect(referenceUiFor(baseColour, withProducts(null))).toBe('legacy')
    expect(referenceUiFor({ ...baseColour, ownerType: 'PRODUCT', namespace: 'lab', constraints: { key: 'category', values: ['zz-1'] } }, withProducts(null))).toBe('entries')
    expect(referenceUiFor({ ...baseColour, ownerType: 'PRODUCT', namespace: 'lab' }, withProducts(null))).toBe('legacy')
    /* On the older picker the field says why there is no list, in one sentence. */
    expect(olderPickerReason(baseColour, withProducts(null))).toEqual({ text: 'Shopify lists these values only through a product category, and this field has none. Paste a value’s Shopify ID to choose it.', blocked: false })
    expect(olderPickerReason({ ...baseColour, validations: [] }, withProducts(null))).toEqual({ text: 'This field does not name its list of values. Paste a value’s Shopify ID to choose it.', blocked: false })
    expect(olderPickerReason(baseColour, withProducts({ key: 'category', values: ['zz-1'] }))).toBeNull()
  })
  it('names the thing being picked', () => {
    expect(baseReferenceType('list.variant_reference')).toBe('variant_reference')
    expect(referenceNoun('list.product_reference')).toEqual({ one: 'product', other: 'products' })
    expect(referenceNoun('mixed_reference')).toEqual({ one: 'entry', other: 'entries' })
  })
  it('reads the list cap only when it is a positive whole number', () => {
    expect(listMax({ validations: [{ name: 'list.max', value: '5' }] })).toBe(5)
    expect(listMax({ validations: [{ name: 'list.max', value: 'x' }] })).toBeNull()
    expect(listMax({ validations: [] })).toBeNull()
  })
})

describe('references as choices', () => {
  it('carries the picture, the swatch and the handle', () => {
    expect(referenceChoice({ id: 'gid://shopify/Metaobject/1', label: 'Green', image: null, swatch: '#3c9a4b', handle: 'green' })).toMatchObject({ label: 'Green', swatch: '#3c9a4b', image: null, detail: undefined })
    expect(referenceChoice({ id: 'p1', label: 'Sample Jacket', image: 'https://x/p.png', handle: 'sample-jacket' })).toMatchObject({ detail: '/sample-jacket', image: 'https://x/p.png' })
  })
  it('holds a file Shopify is still processing, with the reason', () => {
    const c = referenceChoice({ id: 'f1', label: 'photo.png', image: null, media: { id: 'f1', alt: '', type: 'IMAGE', status: 'PROCESSING', preview: null, url: null } as never })
    expect(c.heldReason).toMatch(/processing/)
  })
  it('shows chosen values in order: loading words, never raw ids; unknown ones kept and marked', () => {
    const names = [{ id: 'a', label: 'Black', image: null, swatch: '#111111' }, { id: 'gone', label: 'x', image: null, available: false }]
    const chosen = chosenChoices(['b', 'a', 'gone'], names, { one: 'entry' }, false)
    expect(chosen.map(c => c.label)).toEqual(['Loading entry…', 'Black', 'Unavailable in this store'])
    expect(chosen[2].unknown).toBe(true)
    expect(chosenChoices(['b'], [], { one: 'entry' }, true)[0].label).toBe('Entry preview unavailable')
  })
})

/* ── Lane B slice B3c (docs/shopify-metafields/PLAN-2026-09-28.md §6.3, gap G18): mixed and disclosure fields on the new
   tick list with a kind switch; only a field whose kinds are not known keeps the older picker, and says why. ── */
import { SHOPIFY_TYPE_CATALOG } from '@nexus/shared/shopify-type-catalog'
import { LAB_SCHEMA, labKind, labTypeField } from '@nexus/shared/shopify-lab-store'
import { entryKinds, kindSwitchFor, olderPickerReason, pickerEntryKinds } from './referenceFieldModel'

const types = (defs: Array<{ type: string }> | null) => defs && defs.map(d => d.type)
const mixed = (validations: Array<{ name: string; value: string }>) => ({ type: 'list.mixed_reference', validations })
const noDisclosureKinds = { ...LAB_SCHEMA, metaobjectDefinitions: LAB_SCHEMA.metaobjectDefinitions.filter(d => !d.type.startsWith('shopify--disclosure-')) }

describe('B3c · which pop-up every reference type opens (made-up store)', () => {
  /* The two taxonomy-value types are pinned by slice B2's own tests: their rule (a category must be known) is B2's. */
  it('pins the picker of the other 25 reference types of Shopify’s list', () => {
    const refs = SHOPIFY_TYPE_CATALOG.map(t => t.name).filter(name => name.endsWith('_reference') && !name.includes('taxonomy_value'))
    expect(Object.fromEntries(refs.map(name => [name, referenceUiFor(labTypeField(name), LAB_SCHEMA)]))).toEqual({
      product_taxonomy_disclosure_reference: 'legacy',
      metaobject_reference: 'entries', 'list.metaobject_reference': 'entries', mixed_reference: 'entries', 'list.mixed_reference': 'entries',
      disclosure_reference: 'entries', 'list.disclosure_reference': 'entries',
      product_reference: 'resources', 'list.product_reference': 'resources', variant_reference: 'resources', 'list.variant_reference': 'resources',
      collection_reference: 'resources', 'list.collection_reference': 'resources', page_reference: 'resources', 'list.page_reference': 'resources',
      article_reference: 'resources', 'list.article_reference': 'resources', file_reference: 'resources', 'list.file_reference': 'resources',
      customer_reference: 'resources', 'list.customer_reference': 'resources', company_reference: 'resources', 'list.company_reference': 'resources',
      order_reference: 'resources', 'list.order_reference': 'resources',
    })
    expect(refs).toHaveLength(25)
  })
})

describe('B3c · the entry kinds a mixed or disclosure field takes', () => {
  it('a mixed field: the kinds it names, in its order; a disclosure field: the store’s disclosure kinds', () => {
    expect(types(entryKinds(labTypeField('mixed_reference'), LAB_SCHEMA))).toEqual(['lab_faq', 'lab_press'])
    expect(types(entryKinds(labTypeField('list.mixed_reference'), LAB_SCHEMA))).toEqual(['lab_faq', 'lab_press'])
    expect(types(entryKinds(mixed([{ name: 'metaobject_definition_types', value: '["lab_press","lab_faq"]' }]), LAB_SCHEMA))).toEqual(['lab_press', 'lab_faq'])
    expect(types(entryKinds(labTypeField('disclosure_reference'), LAB_SCHEMA))).toEqual(['shopify--disclosure-lab'])
    expect(types(entryKinds(labTypeField('list.disclosure_reference'), LAB_SCHEMA))).toEqual(['shopify--disclosure-lab'])
  })
  it('only kinds the store has; null when no kind is named or the rule cannot be read — nothing is guessed', () => {
    expect(types(entryKinds(mixed([{ name: 'metaobject_definition_ids', value: JSON.stringify([labKind('lab_faq').id, 'gid://shopify/MetaobjectDefinition/77']) }]), LAB_SCHEMA))).toEqual(['lab_faq'])
    expect(types(entryKinds(mixed([{ name: 'metaobject_definition_types', value: '["gone_kind"]' }]), LAB_SCHEMA))).toEqual([])
    expect(entryKinds(mixed([]), LAB_SCHEMA)).toBeNull()
    expect(entryKinds(mixed([{ name: 'metaobject_definition_ids', value: 'not a list' }]), LAB_SCHEMA)).toBeNull()
    expect(types(entryKinds(labTypeField('disclosure_reference'), noDisclosureKinds))).toEqual([])
  })
  it('the new picker’s kinds: every allowed kind of a mixed field, the one kind of an entry field, none for other types', () => {
    expect(types(pickerEntryKinds(labTypeField('list.mixed_reference'), LAB_SCHEMA))).toEqual(['lab_faq', 'lab_press'])
    expect(types(pickerEntryKinds(labTypeField('metaobject_reference'), LAB_SCHEMA))).toEqual(['lab_summary'])
    expect(pickerEntryKinds(labTypeField('list.product_reference'), LAB_SCHEMA)).toEqual([])
    expect(pickerEntryKinds(labTypeField('product_taxonomy_value_reference'), LAB_SCHEMA)).toEqual([])
    expect(pickerEntryKinds(mixed([]), LAB_SCHEMA)).toEqual([])
  })
  it('a mixed field with one known kind gets the tick list with no switch; with none known, the older picker', () => {
    const one = mixed([{ name: 'metaobject_definition_ids', value: JSON.stringify([labKind('lab_faq').id, 'gid://shopify/MetaobjectDefinition/77']) }])
    expect(referenceUiFor(one, LAB_SCHEMA)).toBe('entries')
    expect(kindSwitchFor(pickerEntryKinds(one, LAB_SCHEMA).length)).toBe('none')
    expect(referenceUiFor(mixed([]), LAB_SCHEMA)).toBe('legacy')
    expect(referenceUiFor(mixed([{ name: 'metaobject_definition_types', value: '["gone_kind"]' }]), LAB_SCHEMA)).toBe('legacy')
    expect(referenceUiFor(labTypeField('disclosure_reference'), noDisclosureKinds)).toBe('legacy')
  })
  it('the switch: none for one kind, segments for 2 to 4, a select for more', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(kindSwitchFor)).toEqual(['none', 'none', 'segments', 'segments', 'segments', 'select', 'select'])
  })
})

describe('B3c · the older picker says why it is used', () => {
  it.each([
    ['a mixed field with no kind named', mixed([]), { text: 'This field does not name its entry kinds. Choose a kind first, then an entry.', blocked: false }],
    ['a mixed field whose rule cannot be read', mixed([{ name: 'metaobject_definition_ids', value: 'not a list' }]), { text: 'This field’s entry kinds cannot be read. Refresh the store schema.', blocked: true }],
    ['a mixed field whose kinds are gone', mixed([{ name: 'metaobject_definition_types', value: '["gone_kind"]' }]), { text: 'This field’s entry kinds are no longer in the store. Refresh the store schema.', blocked: true }],
    ['an entry field whose kind is gone', { type: 'metaobject_reference', validations: [{ name: 'metaobject_definition_id', value: 'gid://shopify/MetaobjectDefinition/77' }] }, { text: 'This field’s entry kinds are no longer in the store. Refresh the store schema.', blocked: true }],
    ['an entry field with two kinds', { type: 'list.metaobject_reference', validations: [{ name: 'metaobject_definition_ids', value: JSON.stringify([labKind('lab_faq').id, labKind('lab_press').id]) }] }, { text: 'This field takes more than one entry kind. Choose a kind first, then an entry.', blocked: false }],
  ])('%s', (_name, def, reason) => {
    expect(olderPickerReason(def, LAB_SCHEMA)).toEqual(reason)
  })
  it('a disclosure field in a store with no disclosure kinds', () => {
    expect(olderPickerReason(labTypeField('list.disclosure_reference'), noDisclosureKinds)).toEqual({ text: 'This store has no disclosure entry kinds. Add one in Shopify admin, then refresh the store schema.', blocked: true })
  })
  it('no reason for a field the new pickers serve, or for a type that is not an entry', () => {
    for (const type of ['mixed_reference', 'list.mixed_reference', 'disclosure_reference', 'list.disclosure_reference', 'metaobject_reference', 'list.variant_reference']) {
      expect(olderPickerReason(labTypeField(type), LAB_SCHEMA), type).toBeNull()
    }
    /* A taxonomy field on the older picker is there for its raw id, not for entry kinds: it says so, never a kind
       sentence (the B2 review; the made-up type field has an attribute but no category). */
    expect(olderPickerReason(labTypeField('product_taxonomy_value_reference'), LAB_SCHEMA)?.text).toMatch(/^Shopify lists these values only through a product category/)
    expect(olderPickerReason({ type: 'product_taxonomy_value_reference', validations: [] }, LAB_SCHEMA)?.text).toBe('This field does not name its list of values. Paste a value’s Shopify ID to choose it.')
  })
})
