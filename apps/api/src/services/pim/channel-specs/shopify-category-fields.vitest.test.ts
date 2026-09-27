import { describe, expect, it } from 'vitest'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { shopifyProductSpec } from './store.js'

const color = { id: 'definition-color', namespace: 'shopify', key: 'color-pattern', ownerType: 'PRODUCT', name: 'Color', type: 'single_line_text_field', description: 'Pattern and colour', access: { admin: 'PUBLIC_READ_WRITE', storefront: null }, validations: [], constraints: { key: 'category', values: ['aa-1-10', 'aa-1-13'] } }
const copy = { ...color, id: 'definition-copy', namespace: 'custom', key: 'copy', name: 'Copy', description: null, constraints: null }
const schema: ShopifyStoreSchema = { definitions: [color, copy], metaobjectDefinitions: [], types: [{ name: 'single_line_text_field', category: 'TEXT' }], locales: [{ locale: 'en', primary: true, published: true }, { locale: 'it', primary: false, published: true }], native: { scopes: ['write_products', 'write_translations'], enums: {}, inputs: { variant: ['price'] } }, revision: '1' }

const field = (key: string, categoryIds?: string[], locale?: string) =>
  shopifyProductSpec(schema, 'store-a', locale, categoryIds).fields.find(f => f.shopifyField?.definition?.key === key)!

describe('Shopify category metafields on the sheet', () => {
  it('say how many categories they apply to', () => {
    expect(field('color-pattern').helpText).toMatch(/^Product · .+\. Pattern and colour Applies only to 2 Shopify categories\.$/)
    expect(field('copy').helpText).not.toContain('Applies only')
  })

  it('are editable when the family is in one of their categories', () => {
    const f = field('color-pattern', ['gid://shopify/TaxonomyCategory/aa-1-13'])
    expect(f.editable).toBe(true)
    expect(f.readOnlyReason).toBeUndefined()
  })

  it('are read-only, with the Shopify Information editor’s reason, when the category does not match', () => {
    const f = field('color-pattern', ['gid://shopify/TaxonomyCategory/aa-1-1'])
    expect(f.editable).toBe(false)
    expect(f.readOnlyReason).toBe('This field does not apply to the selected Shopify product category. Its existing value is preserved.')
  })

  it('are read-only until the family has a Shopify category', () => {
    const f = field('color-pattern', [])
    expect(f.editable).toBe(false)
    expect(f.readOnlyReason).toBe('Choose and synchronize a Shopify product category before editing this category-specific field.')
  })

  it('apply when any category of the family matches', () => {
    expect(field('color-pattern', ['gid://shopify/TaxonomyCategory/aa-1-1', 'gid://shopify/TaxonomyCategory/aa-1-10']).editable).toBe(true)
  })

  it('keep the reason in another language too', () => {
    expect(field('color-pattern', [], 'it').readOnlyReason).toBe('Choose and synchronize a Shopify product category before editing this category-specific field.')
  })

  it('are not judged when the caller does not know the category, and unconstrained fields never are', () => {
    expect(field('color-pattern').editable).toBe(true)
    expect(field('copy', []).editable).toBe(true)
  })
})
