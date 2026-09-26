/**
 * P4 (docs/attributes/PLAN.md §4.2) — Shopify and Etsy conformance, and Shopify's own option lists.
 *
 * The audit found both adapters hard-code `unrecognised: []`, so nothing proved that every definition / property the
 * channel declares becomes a field. These tests do, with the channel's declarations as the reference set, and a planted
 * extra declaration as the positive control (a set-equality test that cannot fail proves nothing).
 */
import { expect, it } from 'vitest'
import { informationMetafieldId } from '@nexus/shared/shopify-information'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { informationShopifySchema } from '../../../test-support/information-shopify-fixture.js'
import { shopifyDefinitionRules, shopifyProductSpec } from './store.js'
import { etsyTaxonomySpec, type EtsyTaxonomyProperty } from './etsy.js'

const schemaWith = (extra: ShopifyStoreSchema['definitions']): ShopifyStoreSchema => ({ ...informationShopifySchema, definitions: [...informationShopifySchema.definitions, ...extra] })
const definition = (key: string, type: string, validations: Array<{ name: string; value: string }> = [], ownerType = 'PRODUCT') =>
  ({ id: key, ownerType, namespace: 'custom', key, name: key, type, validations, access: { admin: 'MERCHANT_READ_WRITE', storefront: null }, description: null })

it('Shopify: every product and variant metafield definition becomes exactly one field', () => {
  const schema = schemaWith([definition('fit', 'single_line_text_field', [], 'PRODUCTVARIANT')])
  const spec = shopifyProductSpec(schema, 'shop-1')
  const declared = schema.definitions.map(d => informationMetafieldId(d.ownerType, d.namespace, d.key)).sort()
  const covered = spec.fields.filter(f => f.shopifyField?.definition).map(f => f.attribute).sort()
  expect(covered).toEqual(declared)
  // Positive control: one more declaration, one more field.
  const more = shopifyProductSpec(schemaWith([definition('fit', 'single_line_text_field', [], 'PRODUCTVARIANT'), definition('lining', 'single_line_text_field')]), 'shop-1')
  expect(more.fields.filter(f => f.shopifyField?.definition)).toHaveLength(declared.length + 1)
})

it('Shopify: a definition’s choices become a strict option list, and list.min/list.max bound the list', () => {
  const spec = shopifyProductSpec(schemaWith([
    definition('protection', 'single_line_text_field', [{ name: 'choices', value: JSON.stringify(['Level 1', 'Level 2']) }]),
    definition('certifications', 'list.single_line_text_field', [{ name: 'choices', value: JSON.stringify(['EN 17092', 'EN 13594']) }, { name: 'list.min', value: '1' }, { name: 'list.max', value: '2' }]),
    definition('notes', 'single_line_text_field'),
  ]), 'shop-1')
  const byKey = (key: string) => spec.fields.find(f => f.attribute === informationMetafieldId('PRODUCT', 'custom', key))!
  expect(byKey('protection')).toMatchObject({ kind: 'select', mode: 'strict', options: ['Level 1', 'Level 2'], cardinality: { min: 0, max: 1 } })
  expect(byKey('certifications')).toMatchObject({ kind: 'select', mode: 'strict', options: ['EN 17092', 'EN 13594'], shape: 'list', cardinality: { min: 1, max: 2 } })
  expect(byKey('notes').options).toBeUndefined()
  expect(byKey('notes').mode).toBeUndefined()
})

it('Shopify rules: an unreadable or empty choices list offers nothing rather than guessing', () => {
  expect(shopifyDefinitionRules([{ name: 'choices', value: 'not json' }])).toEqual({})
  expect(shopifyDefinitionRules([{ name: 'choices', value: '[]' }])).toEqual({})
  expect(shopifyDefinitionRules([{ name: 'list.max', value: '0' }, { name: 'list.min', value: '-1' }])).toEqual({})
  expect(shopifyDefinitionRules(undefined)).toEqual({})
})

it('Etsy: every taxonomy property is covered, a scaled one twice (value and scale)', () => {
  const property = (id: number, name: string, extra: Partial<EtsyTaxonomyProperty> = {}): EtsyTaxonomyProperty => ({
    property_id: id, name, display_name: name, is_required: false, supports_attributes: true, supports_variations: false,
    is_multivalued: false, max_values_allowed: null, scales: [], possible_values: [], selected_values: [], ...extra })
  const properties = [
    property(200, 'primary_color', { possible_values: [{ value_id: 1, name: 'Black', scale_id: null } as never] }),
    property(100, 'size', { scales: [{ scale_id: 5, display_name: 'EU' }] }),
    property(300, 'occasion', { is_multivalued: true }),
  ]
  const spec = etsyTaxonomySpec('1429', properties)
  expect(Object.keys(spec.coverage).sort()).toEqual(properties.map(p => String(p.property_id)).sort())
  expect(spec.coverage['100']).toEqual(['property_100', 'property_100__scale_id'])
  expect(Object.values(spec.coverage).every(keys => keys.length > 0)).toBe(true)
  expect(spec.fields.map(f => f.key).sort()).toEqual(Object.values(spec.coverage).flat().sort())
})
