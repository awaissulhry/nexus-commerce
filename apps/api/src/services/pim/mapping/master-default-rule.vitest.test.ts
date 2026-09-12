import { describe, expect, it } from 'vitest'
import { masterDefaultRule } from './master-default-rule.js'
import { ebaySpecFromCache } from '../channel-specs/ebay.js'
import { amazonSpecFromDefinition } from '../channel-specs/amazon.js'
import { resolveAttributes } from '../attribute-resolver.js'
import { resolveChannelField } from '../resolve-channel-field.js'

const keys = new Set(['name', 'brand', 'material', 'basePrice', 'totalStock', 'keywords', 'countryOfOrigin'])
const ebay = ebaySpecFromCache({ marketplace: 'IT', categoryId: '177104', aspects: [{ id: 'Material', label: 'Materiale (Material)' }] })
describe('Master defaults for channel mappings', () => {
  it('maps shared facts and offer defaults, without inventing policy or package mappings', () => {
    const rule = (key: string) => masterDefaultRule(ebay.fields.find(f => f.key === key), keys)
    expect(rule('title')).toMatchObject({ source: 'title', fallback: 'name' })
    expect(rule('material')).toMatchObject({ source: 'material' })
    expect(rule('price')).toMatchObject({ source: 'basePrice' })
    expect(rule('quantity')).toMatchObject({ source: 'totalStock' })
    expect(rule('packageWeight')).toBeNull()
    expect(rule('fulfillmentPolicyId')).toBeNull()
    expect(rule('categoryId')).toBeNull()
  })
  it('derives Italian listing content from Master with the native title fallback', () => {
    const product = { id: 'p', parentId: null, name: 'Shared name', brand: 'Shared brand', localizedContent: {}, categoryAttributes: {}, variantAttributes: {} }
    const rule = masterDefaultRule(ebay.fields.find(f => f.key === 'title'), keys)!
    const resolvedAttrs = resolveAttributes({ product, parent: null, locale: 'it' })
    expect(resolveChannelField({ fieldKey: 'title', rule, resolvedAttrs, product, locale: 'it' }).value).toBe('Shared name')
  })
  it('joins shared keyword entries through a visible mapping transform', () => {
    const spec = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'T', schemaDefinition: { properties: { generic_keyword: { type: 'string' } } } })
    const rule = masterDefaultRule(spec.fields[0], keys)!
    const product = { id: 'p', parentId: null, keywords: ['motorcycle', 'jacket'], localizedContent: {}, categoryAttributes: {}, variantAttributes: {} }
    const resolvedAttrs = resolveAttributes({ product, parent: null, locale: 'it' })
    expect(resolveChannelField({ fieldKey: 'generic_keyword', rule, resolvedAttrs, product, locale: 'it' }).value).toBe('motorcycle jacket')
  })
})
