import { describe, it, expect } from 'vitest'
import { amazonSpecFromDefinition } from '../pim/channel-specs/amazon.js'
import { applyResolvedMappingToAmazonFeed } from './mapping-payload.js'
import type { ResolveBatchResult } from '../pim/mapping/resolve-batch.service.js'
const attr = (type = 'string') => ({ type: 'array', items: { type: 'object', properties: { value: { type } } } })
const spec = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'COAT', schemaDefinition: { properties: { item_name: attr(), bullet_point: attr(), weight: { type: 'array', items: { type: 'object', properties: { value: { type: 'number' }, unit: { enum: ['kg'] } } } } } } })
const values = { item_name: 'Mapped title', bullet_point: ['One', 'Two', 'Three', 'Four', 'Five', 'Six'], weight: { value: 0, unit: 'kg' } }
function resolution(extra: Record<string, unknown> = {}) {
  return { catalogue: { schema: { present: true }, fields: spec.fields.map(f => ({ fieldKey: f.key, label: f.label, schemaKnown: true })) },
    products: [{ category: { channelCategoryId: 'COAT' }, cells: Object.fromEntries(Object.entries({ ...values, ...extra }).map(([key, value]) => [key, { value, errors: [], provenance: value === null ? 'override' : 'catalogRule' }])) }] } as unknown as ResolveBatchResult
}
const original = { header: { sellerId: 'test' }, messages: [{ messageId: 1, operationType: 'PARTIAL_UPDATE', productType: 'OLD', attributes: {
  item_name: [{ value: 'Stale legacy title' }], purchasable_offer: [{ currency: 'EUR', our_price: [{ schedule: [{ value_with_tax: 49 }] }] }], main_product_image_locator: [{ media_location: 'https://example.com/photo.jpg' }],
} }] }
describe('actual Amazon feed envelope uses canonical mapping values', () => {
  it('replaces stale authored attributes and preserves pricing and media owned values', () => {
    const output = JSON.parse(applyResolvedMappingToAmazonFeed(JSON.stringify(original), resolution(), spec))
    expect(output.messages[0].productType).toBe('COAT')
    expect(output.messages[0].attributes).toEqual({ ...original.messages[0].attributes,
      item_name: [{ value: 'Mapped title' }], bullet_point: values.bullet_point.map(value => ({ value })), weight: [{ value: 0, unit: 'kg' }] })
  })
  it('serializes intentional clears as deletes instead of resurrecting legacy values', () => {
    const output = JSON.parse(applyResolvedMappingToAmazonFeed(JSON.stringify(original), resolution({ item_name: null }), spec))
    expect(output.messages[0].operationType).toBe('PATCH')
    expect(output.messages[0].attributes).toBeUndefined()
    expect(output.messages[0].patches).toContainEqual({ op: 'delete', path: '/attributes/item_name' })
    expect(output.messages[0].patches.filter((p: any) => p.path === '/attributes/item_name')).toHaveLength(1)
  })
  it('blocks pending translations and missing schemas before transport', () => {
    const result = resolution(); result.products[0].cells.item_name.needsTranslation = true
    expect(() => applyResolvedMappingToAmazonFeed(JSON.stringify(original), result, spec)).toThrow('translation is pending')
    expect(() => applyResolvedMappingToAmazonFeed(JSON.stringify(original), resolution(), { ...spec, absent: true })).toThrow('schema')
  })
  it('validates the completed full payload, including listing-owned required attributes', () => {
    const full = { ...original, messages: [{ ...original.messages[0], operationType: 'UPDATE' }] }
    const required = { ...spec, validationSchema: { ...spec.validationSchema, required: ['condition_type'] } }
    expect(() => applyResolvedMappingToAmazonFeed(JSON.stringify(full), resolution(), required)).toThrow('condition_type')
  })
  it('blocks unavailable validation even for an otherwise empty partial update', () => {
    const result = resolution()
    result.products[0].readiness = { schemaValidation: 'unavailable' } as any
    expect(() => applyResolvedMappingToAmazonFeed(JSON.stringify(original), result, spec)).toThrow('validation is unavailable')
  })
})
