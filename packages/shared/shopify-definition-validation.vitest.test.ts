import { describe, expect, it } from 'vitest'
import { validateShopifyField, shopifyReferenceError, type ShopifyStoreSchema } from './shopify-linked-products.js'
const validate = (type: string, name: string, bound: string, value: string) => validateShopifyField({ type, validations: [{ name, value: bound }] }, value)
describe('Shopify definition constraints', () => {
  it('compares measurement bounds in compatible units, including documented legacy constraint units', () => {
    expect(validate('weight', 'max', '{"value":500,"unit":"g"}', '{"value":1,"unit":"kilograms"}')).toContain('max')
    expect(validate('weight', 'max', '{"value":500,"unit":"g"}', '{"value":0.25,"unit":"kilograms"}')).toBeNull()
    expect(validate('dimension', 'min', '{"value":10,"unit":"centimeters"}', '{"value":1,"unit":"meters"}')).toBeNull()
    expect(validate('volume', 'max', '{"value":1,"unit":"liters"}', '{"value":1,"unit":"us_gallons"}')).toContain('max')
  })
  it('enforces precision, date bounds and allowed domains', () => {
    expect(validate('number_decimal', 'max_precision', '2', '0.001')).toContain('decimal places')
    expect(validate('date', 'min', '2026-09-10', '2026-09-09')).toContain('min')
    expect(validate('url', 'allowed_domains', '["shopify.com"]', 'https://shopify.com.evil.test')).toContain('allowed domains')
    expect(validate('url', 'allowed_domains', '["shopify.com"]', 'https://shopify.com/path')).toBeNull()
  })
  it('validates JSON schemas without stripping fields or replacing the original wire value', () => {
    const schema = JSON.stringify({ type: 'object', required: ['amount'], properties: { amount: { type: 'number', minimum: 0 } }, additionalProperties: false })
    expect(validate('json', 'schema', schema, '{"amount":0}')).toBeNull()
    expect(validate('json', 'schema', schema, '{"amount":-1}')).toContain('JSON schema')
    expect(validate('json', 'schema', schema, '{"amount":0,"extra":true}')).toContain('JSON schema')
  })
  it('rejects references outside store definition constraints, even when the ID resolves', () => {
    const schema = { metaobjectDefinitions: [{ id: 'allowed', type: 'feature' }] } as ShopifyStoreSchema
    expect(shopifyReferenceError({ type: 'metaobject_reference', validations: [{ name: 'metaobject_definition_id', value: 'allowed' }] }, [{ available: true, type: 'other' }], schema)).toContain('allowed')
    expect(shopifyReferenceError({ type: 'file_reference', validations: [{ name: 'file_type_options', value: '["Image"]' }] }, [{ available: true, type: 'Video' }], schema)).toContain('allowed')
  })
})
