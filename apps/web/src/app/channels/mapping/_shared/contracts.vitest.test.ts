import { describe, expect, it } from 'vitest'
import { isCategoryField, emptyReason, fieldWithPreviewRule, mappingOriginLabel, type CatalogueField, type ResolvedCell } from './contracts'

describe('mapping display provenance', () => {
  const field = { fieldKey: 'pattern', rule: null, status: 'unmapped', ruleKind: 'unmapped' } as CatalogueField
  it('shows automatic inheritance returned by the resolver without treating an override as a shared rule', () => {
    const cell = { rule: { source: 'pattern' }, ruleOrigin: 'master', provenance: 'source' } as ResolvedCell
    expect(fieldWithPreviewRule(field, cell)).toMatchObject({ status: 'mapped', ruleSummary: 'pattern', ruleOrigin: 'master' })
    expect(mappingOriginLabel(fieldWithPreviewRule(field, cell))).toBe('Follows Master')
    expect(fieldWithPreviewRule(field, { rule: null, provenance: 'override', value: 'Striped' } as ResolvedCell)).toBe(field)
  })
  it('keeps the authored rule when a preview has an explicit override', () => {
    const authored = { ...field, rule: { source: 'otherPattern' }, ruleOrigin: 'category' as const, status: 'mapped' as const }
    expect(fieldWithPreviewRule(authored, { rule: null, provenance: 'override' } as ResolvedCell)).toBe(authored)
    expect(mappingOriginLabel(authored)).toBe('Category rule')
  })
  it('explains deliberately empty overrides', () => {
    expect(emptyReason({ provenance: 'override' } as ResolvedCell)).toContain('explicit blank override')
  })
})

it('routes Shopify custom product type to its data mapping editor', () => {
  expect(isCategoryField('productType', 'SHOPIFY')).toBe(false)
  expect(isCategoryField('productType', 'AMAZON')).toBe(true)
  expect(isCategoryField('categoryId', 'EBAY')).toBe(true)
})
