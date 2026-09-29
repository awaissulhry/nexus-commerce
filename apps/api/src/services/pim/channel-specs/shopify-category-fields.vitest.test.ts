import { describe, expect, it } from 'vitest'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { SHOPIFY_FIELD_NOT_SWITCHED_ON } from '@nexus/shared/shopify-information'
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

describe('a partial category list (Shopify lists thousands; Nexus reads one page)', () => {
  it('gives no count it cannot back', () => {
    const partial: ShopifyStoreSchema = { ...schema, definitions: [{ ...color, constraints: { key: 'category', values: ['aa-1-13'], complete: false, checked: ['aa-1-13', 'aa-1-1'] } }, copy] }
    const f = shopifyProductSpec(partial, 'store-a', undefined, ['gid://shopify/TaxonomyCategory/aa-1-13']).fields.find(x => x.shopifyField?.definition?.key === 'color-pattern')!
    expect(f.helpText).toMatch(/Applies only to some Shopify categories\.$/)
    expect(f.editable).toBe(true)
  })
})

describe('Shopify category fields the store has not switched on (bulk-editor parity)', () => {
  const ageGroup = { id: 'template-age', namespace: 'shopify', key: 'age-group', ownerType: 'PRODUCT', name: 'Age group', type: 'list.metaobject_reference', description: 'Age group',
    validations: [], access: { admin: null, storefront: null }, readOnlyReason: null, standardTemplateId: 'template-age',
    constraints: { key: 'category', values: ['aa-1'], complete: false, checked: ['aa-1', 'el-1'] } }
  const offered: ShopifyStoreSchema = { ...schema, templates: [ageGroup] }
  const template = (categoryIds?: string[], from: ShopifyStoreSchema = offered) =>
    shopifyProductSpec(from, 'store-a', undefined, categoryIds).fields.find(f => f.shopifyField?.definition?.key === 'age-group')

  it('show, read-only and saying why, on a family whose category offers them', () => {
    const f = template(['gid://shopify/TaxonomyCategory/aa-1'])!
    expect(f).toMatchObject({ editable: false, readOnlyReason: SHOPIFY_FIELD_NOT_SWITCHED_ON, label: 'Age group' })
    expect(f.group?.label).toBe('Category metafields')
    expect(f.helpText).toBe('Shopify category field · shopify.age-group. Age group Not switched on in this store yet.')
  })

  it('are no column where their category does not offer them, or when the family\'s categories are unknown', () => {
    expect(template(['gid://shopify/TaxonomyCategory/el-1'])).toBeUndefined()
    expect(template([])).toBeUndefined()
    expect(template(undefined)).toBeUndefined()
  })

  it('once switched on, the same column is an ordinary, editable category field', () => {
    const before = template(['gid://shopify/TaxonomyCategory/aa-1'])!
    const enabled = { ...ageGroup, id: 'definition-age', standardTemplateId: undefined, access: { admin: 'PUBLIC_READ_WRITE', storefront: 'PUBLIC_READ' },
      validations: [{ name: 'metaobject_definition_id', value: 'gid://shopify/MetaobjectDefinition/1' }] }
    const after = template(['gid://shopify/TaxonomyCategory/aa-1'], { ...offered, definitions: [...schema.definitions, enabled] })!
    expect(after.key).toBe(before.key)
    expect(after).toMatchObject({ editable: true, readOnlyReason: undefined })
    expect(after.shopifyField?.definition?.standardTemplateId).toBeUndefined()
  })
})
