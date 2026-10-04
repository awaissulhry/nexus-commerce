import { describe, expect, it } from 'vitest'
import { conceptListMatcher, masterDefaultRule } from './master-default-rule.js'
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

// Item 1 (product sheet consistency, 2026-10-05) — the Shared gender (men / women / unisex, linked to the target_gender
// concept) reaches Amazon's strict target gender as its code and Amazon's open department list as the market word.
describe('Shared gender to Amazon target gender and department, by the concept\'s synonyms', () => {
  const attr = (value: object) => ({ type: 'array', maxItems: 1, items: { type: 'object', properties: { value } } })
  const spec = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'COAT', schemaDefinition: { properties: {
    target_gender: attr({ type: 'string', enum: ['female', 'male', 'unisex'], enumNames: ['Femmina', 'Maschio', 'Unisex'] }),
    department: attr({ anyOf: [{ type: 'string' }, { type: 'string', enum: ['Donna', 'Uomo', 'Unisex - Adulto', 'Bambini e ragazzi'] }] }),
    pattern: attr({ anyOf: [{ type: 'string' }, { type: 'string', enum: ['Tinta unita', 'A righe'] }] }),
  } } })
  const concepts = { channel: 'AMAZON' as const, sourceFor: new Map([['target_gender', 'gender'], ['pattern', 'motif']]) }
  const masterKeys = new Set(['gender', 'motif'])
  const specField = (key: string) => spec.fields.find(f => f.key === key)!
  const catalogueField = (key: string) => ({ fieldKey: key, label: specField(key).label, options: specField(key).options, optionLabels: specField(key).optionLabels, selectionOnly: specField(key).mode === 'strict' })
  const resolve = (key: string, gender: string, row: string | null = null) => {
    const rule = masterDefaultRule(specField(key), masterKeys, concepts)!
    const product = { id: 'p', parentId: null, localizedContent: {}, categoryAttributes: { gender, motif: gender }, variantAttributes: {} }
    const matcher = conceptListMatcher('AMAZON', catalogueField(key))
    return resolveChannelField({ fieldKey: key, rule, resolvedAttrs: resolveAttributes({ product, parent: null, locale: 'it' }), product, locale: 'it',
      transformCtx: { lookupValueMap: () => row, ...(matcher ? { matchListValue: matcher } : {}) } }).value
  }

  it('gives the strict target gender and the open department a value-map step; other open concept lists get none', () => {
    expect(masterDefaultRule(specField('target_gender'), masterKeys, concepts)?.transforms).toEqual([{ type: 'valueMap', attribute: 'gender' }])
    expect(masterDefaultRule(specField('department'), masterKeys, concepts)?.transforms).toEqual([{ type: 'valueMap', attribute: 'gender' }])
    expect(masterDefaultRule(specField('pattern'), masterKeys, concepts)?.transforms).toBeUndefined()
    expect(conceptListMatcher('AMAZON', catalogueField('pattern'))).toBeNull()
    // eBay: only a strict list is matched.
    expect(conceptListMatcher('EBAY', { fieldKey: 'department', label: 'Reparto', options: ['Uomo'], selectionOnly: false })).toBeNull()
    expect(conceptListMatcher('EBAY', { fieldKey: 'department', label: 'Reparto', options: ['Uomo'], selectionOnly: true })).not.toBeNull()
  })
  it('sends men as male to target gender and as Uomo to department', () => {
    expect(resolve('target_gender', 'men')).toBe('male')
    expect(resolve('department', 'men')).toBe('Uomo')
    expect(resolve('target_gender', 'Donna')).toBe('female')
    expect(resolve('department', 'unisex')).toBe('Unisex - Adulto')
  })
  it('the code sent to Amazon is unchanged for a value already on the list, and a value-map row still wins', () => {
    expect(resolve('target_gender', 'male')).toBe('male')
    expect(resolve('department', 'Uomo')).toBe('Uomo')
    expect(resolve('target_gender', 'men', 'unisex')).toBe('unisex')
    // Unknown to the concept: kept as it is (the strict list's validator flags it).
    expect(resolve('target_gender', 'kids')).toBe('kids')
  })
})
