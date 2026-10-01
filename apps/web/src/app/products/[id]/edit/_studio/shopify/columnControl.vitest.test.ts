import { describe, expect, it } from 'vitest'
import { informationRegistry } from '@nexus/shared/shopify-information'
import { controlColumnFacts } from '../sheet/sheetReset'

function field(type: string) {
  const definition = { id: 'synthetic', namespace: 'custom', key: 'value', name: 'Value', ownerType: 'PRODUCT', type,
    validations: [], description: null, access: { admin: null, storefront: null } }
  return informationRegistry({ revision: 'synthetic', definitions: [definition], types: [], metaobjectDefinitions: [], locales: [] }).find(field => field.definition)!
}
describe('Shopify scalar Set column controls', () => {
  it.each(['single_line_text_field', 'multi_line_text_field', 'number_integer', 'number_decimal', 'boolean'])('offers a typed %s scalar column', type => {
    expect(controlColumnFacts({ key: 'value', label: 'Value', shopifyField: field(type) })?.settable).toBe(true)
  })
  it('offers exact boolean wire values with readable choices', () => {
    expect(controlColumnFacts({ key: 'flag', label: 'Flag', shopifyField: field('boolean') })).toMatchObject({
      kind: 'boolean', options: ['true', 'false'], optionLabels: { true: 'Yes', false: 'No' },
    })
  })
  it.each(['list.single_line_text_field', 'json', 'product_reference', 'money', 'rating'])('keeps %s on its own editor path', type => {
    expect(controlColumnFacts({ key: 'value', label: 'Value', shopifyField: field(type) })?.settable).toBe(false)
  })
  it.each(['media', 'inventory', 'salesChannels', 'category', 'sku', 'handle', 'tracked'])('keeps native %s on its own editor path', id => {
    const native = informationRegistry(null).find(field => field.id === id)!
    expect(controlColumnFacts({ key: id, label: native.label, shopifyField: native })?.settable).toBe(false)
  })
  it('does not offer a read-only store field or incomplete field metadata', () => {
    expect(controlColumnFacts({ key: 'value', label: 'Value', shopifyField: { ...field('boolean'), reason: 'Managed by the store' } })?.settable).toBe(false)
    expect(controlColumnFacts({ key: 'value', label: 'Value', shopifyField: { id: 'title' } })?.settable).toBe(false)
  })
})
