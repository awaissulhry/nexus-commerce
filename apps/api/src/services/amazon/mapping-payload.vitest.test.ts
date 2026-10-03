import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { amazonSpecFromDefinition } from '../pim/channel-specs/amazon.js'
import { applyResolvedMappingToAmazonFeed, amazonRootPatch, mappedAmazonRoots } from './mapping-payload.js'
import type { ResolveBatchResult } from '../pim/mapping/resolve-batch.service.js'
import { sourceOwner } from '../pim/mapping/source-definition-plan.js'
const attr = (type = 'string') => ({ type: 'array', selectors: ['marketplace_id'], items: { type: 'object', properties: { value: { type }, marketplace_id: { const: 'IT' } } } })
const spec = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'COAT', schemaDefinition: { properties: { item_name: attr(), bullet_point: attr(), weight: { type: 'array', items: { type: 'object', properties: { value: { type: 'number' }, unit: { enum: ['kg'] } } } } } } })
const values = { item_name: 'Mapped title', bullet_point: ['One', 'Two', 'Three', 'Four', 'Five', 'Six'], weight: { value: 0, unit: 'kg' } }
function resolution(extra: Record<string, unknown> = {}) {
  return { catalogue: { schema: { present: true }, fields: spec.fields.map(f => ({ fieldKey: f.key, label: f.label, schemaKnown: true })) },
    products: [{ category: { channelCategoryId: 'COAT' }, cells: Object.fromEntries(Object.entries({ ...values, ...extra }).map(([key, value]) => [key, { value, errors: [], provenance: value === null ? 'override' : 'catalogRule' }])) }] } as unknown as ResolveBatchResult
}
const original = { header: { sellerId: 'test' }, messages: [{ messageId: 1, operationType: 'PARTIAL_UPDATE', productType: 'OLD', attributes: {
  item_name: [{ value: 'Stale legacy title' }], purchasable_offer: [{ currency: 'EUR', our_price: [{ schedule: [{ value_with_tax: 49 }] }] }], main_product_image_locator: [{ media_location: 'https://example.com/photo.jpg' }],
} }] }
it('clears only the explicitly observed selector instances instead of a schema default language', () => {
  const localized = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'COAT', schemaDefinition: { properties: { item_name: {
    ...attr(), selectors: ['marketplace_id', 'language_tag'], items: { properties: { marketplace_id: { const: 'IT' }, language_tag: { enum: ['it_IT', 'en_GB'], default: 'it_IT' }, value: { type: 'string' } } },
  } } } })
  expect(amazonRootPatch(localized, 'item_name', undefined, [{ marketplace_id: 'IT', language_tag: 'en_GB', value: 'Earlier English' }]))
    .toEqual({ op: 'delete', path: '/attributes/item_name', value: [{ marketplace_id: 'IT', language_tag: 'en_GB' }] })
})
describe('actual Amazon feed envelope uses canonical mapping values', () => {
  it('replaces stale authored attributes and preserves pricing and media owned values', () => {
    const output = JSON.parse(applyResolvedMappingToAmazonFeed(JSON.stringify(original), resolution(), spec))
    expect(output.messages[0].productType).toBe('COAT')
    expect(output.messages[0].attributes).toEqual({ ...original.messages[0].attributes,
      item_name: [{ value: 'Mapped title', marketplace_id: 'IT' }], bullet_point: values.bullet_point.map(value => ({ value, marketplace_id: 'IT' })), weight: [{ value: 0, unit: 'kg' }] })
  })
  it('serializes intentional clears as deletes instead of resurrecting legacy values', () => {
    const output = JSON.parse(applyResolvedMappingToAmazonFeed(JSON.stringify(original), resolution({ item_name: null }), spec))
    expect(output.messages[0].operationType).toBe('PATCH')
    expect(output.messages[0].attributes).toBeUndefined()
    expect(output.messages[0].patches).toContainEqual({ op: 'delete', path: '/attributes/item_name', value: [{ marketplace_id: 'IT' }] })
    expect(output.messages[0].patches.filter((p: any) => p.path === '/attributes/item_name')).toHaveLength(1)
  })
  it('blocks pending translations and missing schemas before transport', () => {
    const result = resolution(); result.products[0].cells.item_name.needsTranslation = true
    expect(() => applyResolvedMappingToAmazonFeed(JSON.stringify(original), result, spec)).toThrow('translation is pending')
    expect(() => applyResolvedMappingToAmazonFeed(JSON.stringify(original), resolution(), { ...spec, absent: true })).toThrow('schema')
  })
  it('an empty field waiting for a translation sends nothing and does not block', () => {
    const result = resolution({ bullet_point: [] }); result.products[0].cells.bullet_point.needsTranslation = true
    result.products[0].cells.bullet_point.provenance = 'catalogRule'
    const output = JSON.parse(applyResolvedMappingToAmazonFeed(JSON.stringify(original), result, spec))
    expect(output.messages[0].attributes.bullet_point).toBeUndefined()
    expect(output.messages[0].attributes.item_name).toEqual([{ value: 'Mapped title', marketplace_id: 'IT' }])
  })
  it('refuses a clear whose selector cannot be determined from the category schema', () => {
    const ambiguous = structuredClone(spec)
    ;(ambiguous.validationSchema as any).properties.item_name.items.properties.marketplace_id = { enum: ['IT', 'DE'] }
    expect(() => applyResolvedMappingToAmazonFeed(JSON.stringify(original), resolution({ item_name: null }), ambiguous)).toThrow('selector needs an explicit existing attribute value')
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
describe('compliance_media with its selector columns (the 2026-09-27 walk) stays one listing-owned root', () => {
  // The real IT OUTERWEAR definition: compliance_media's selectors are [marketplace_id, content_type, content_language],
  // and its source_location is the leaf the walk keys `compliance_media`. The catalogue owners come from the real `sourceOwner`.
  const definition = JSON.parse(readFileSync(new URL('../pim/__fixtures__/amazon-it-outerwear-family.json', import.meta.url), 'utf8'))
  const outerwear = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'OUTERWEAR', schemaDefinition: definition })
  const catalogue = outerwear.fields.map(f => ({ fieldKey: f.key, label: f.label, schemaKnown: true, sourceOwner: sourceOwner(f) }))
  const cells = Object.fromEntries(outerwear.fields.map(f => [f.key, { value: f.key === 'item_name' ? 'Giacca test' : null, errors: [], provenance: 'catalogRule' }]))
  const MP = 'APJ6JRA9NG5V4' // Amazon.it's public marketplace id, the schema's own default
  const media = [{ content_type: 'user_manual', content_language: 'it_IT', source_location: 'https://example.com/manual.pdf', marketplace_id: MP }]
  const feed = { header: { sellerId: 'test' }, messages: [{ messageId: 1, sku: 'TEST-SKU-1', operationType: 'UPDATE', productType: 'OUTERWEAR', requirements: 'LISTING',
    attributes: { compliance_media: media, fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }], item_name: [{ value: 'Stale title' }] } }] }
  it('has the real selector columns, and no root is split between a listing owner and a mapping', () => {
    expect(outerwear.fields.filter(f => f.attribute === 'compliance_media').map(f => f.key).sort())
      .toEqual(['compliance_media', 'compliance_media__content_language', 'compliance_media__content_type'])
    const mixed = [...new Set(outerwear.fields.map(f => f.attribute))].filter(root => {
      const owners = outerwear.fields.filter(f => f.attribute === root).map(f => !!sourceOwner(f))
      return owners.includes(true) && owners.includes(false)
    })
    expect(mixed).toEqual([])
    const roots = new Set(outerwear.fields.filter(f => !sourceOwner(f)).map(f => f.attribute))
    expect(() => mappedAmazonRoots(outerwear, catalogue, cells, roots)).not.toThrow()
  })
  it('publishes the mapped roots and leaves the owned compliance_media envelope untouched', () => {
    const result = { catalogue: { schema: { present: true }, fields: catalogue }, products: [{ category: { channelCategoryId: 'OUTERWEAR' }, cells }] } as unknown as ResolveBatchResult
    const output = JSON.parse(applyResolvedMappingToAmazonFeed(JSON.stringify(feed), result, outerwear))
    expect(output.messages[0].attributes.compliance_media).toEqual(media)
    expect(output.messages[0].attributes.item_name).toEqual([{ value: 'Giacca test', language_tag: 'it_IT', marketplace_id: MP }])
  })
})
