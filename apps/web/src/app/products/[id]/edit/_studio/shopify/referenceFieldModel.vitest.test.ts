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
  it('gives product-like fields the ordered list and picker, and keeps the rest on the old picker', () => {
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
