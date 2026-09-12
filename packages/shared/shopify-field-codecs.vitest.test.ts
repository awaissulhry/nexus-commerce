import { describe, expect, it } from 'vitest'
import { shopifyMeasurementUnits, shopifyTypeSupported } from './shopify-field-codecs.js'
import { shopifyJson } from './shopify-json.js'
import { validateShopifyField } from './shopify-linked-products.js'
const definition = (type: string, validations: { name: string; value: string }[] = []) => ({ type, validations })
describe('Schema-selected Shopify value codecs', () => {
  it('supports every measurement and list measurement with authoritative units', () => {
    for (const [type, units] of Object.entries(shopifyMeasurementUnits)) {
      expect(shopifyTypeSupported(type)).toBe(true)
      for (const unit of units) expect(validateShopifyField(definition(type), JSON.stringify({ value: 0, unit }))).toBeNull()
      expect(validateShopifyField(definition(`list.${type}`), JSON.stringify([{ value: 0, unit: units[0] }]))).toBeNull()
      expect(validateShopifyField(definition(type), '{"value":0,"unit":"invented"}')).toBeTruthy()
    }
  })
  it('preserves large numeric metadata and decimals while replacing one structured member', () => {
    const value = shopifyJson.parse('{"value":0,"unit":"centimeters","metadata":{"serial":12345678901234567}}')
    value.value = shopifyJson.parse('12.50'); expect(shopifyJson.stringify(value)).toBe('{"value":12.5,"unit":"centimeters","metadata":{"serial":12345678901234567}}')
    expect(shopifyJson.stringify(shopifyJson.parse('[1.234567890123456789,9007199254740993]'))).toBe('[1.234567890123456789,9007199254740993]')
  })
  it('keeps false, zero, clearing and empty lists distinct, and never silently clears invalid blank text', () => {
    for (const [type, value] of [['boolean','false'],['number_integer','0'],['list.single_line_text_field','[]']] as const) expect(validateShopifyField(definition(type), value)).toBeNull()
    expect(validateShopifyField(definition('single_line_text_field'), '')).toBeTruthy()
    expect(validateShopifyField(definition('single_line_text_field'), null)).toBeNull()
    expect(validateShopifyField(definition('boolean'), null)).toBeNull(); expect(validateShopifyField(definition('boolean'), '')).toBeTruthy()
  })
  it('enforces declared rating scales and resource kinds', () => {
    const d = definition('rating', [{ name: 'scale_min', value: '1' }, { name: 'scale_max', value: '5' }])
    expect(validateShopifyField(d, '{"value":"4","scale_min":"1","scale_max":"5"}')).toBeNull()
    expect(validateShopifyField(d, '{"value":"4","scale_min":"0","scale_max":"5"}')).toBeTruthy()
    expect(validateShopifyField(definition('product_reference'), 'gid://shopify/ProductVariant/1')).toBeTruthy()
  })
  it('rejects unknown adapters without coercing their source data', () => {
    expect(shopifyTypeSupported('future_structured_type')).toBe(false)
    expect(validateShopifyField(definition('future_structured_type'), '{"keep":1}')).toMatch(/adapter/)
  })
})

describe('Shopify conditional definition applicability', () => {
  it('uses exact category constraints and preserves unrelated or future-rule values', async () => {
    const { shopifyDefinitionApplicability } = await import('./shopify-linked-products.js')
    const d: any = { constraints: { key: 'category', values: ['aa-8', 'aa-8-1'] } }
    expect(shopifyDefinitionApplicability(d, 'gid://shopify/TaxonomyCategory/aa-8')).toBeNull()
    expect(shopifyDefinitionApplicability(d, 'aa-8-1')).toBeNull()
    expect(shopifyDefinitionApplicability(d, 'aa-8-10')).toContain('does not apply')
    expect(shopifyDefinitionApplicability(d, null)).toContain('category')
    expect(shopifyDefinitionApplicability({ constraints: { key: 'future', values: [] } } as any, 'aa-8')).toContain('adapter')
    expect(shopifyDefinitionApplicability({} as any, null)).toBeNull()
  })
})
