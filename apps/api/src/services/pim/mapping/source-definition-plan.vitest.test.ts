import { describe, expect, it } from 'vitest'
import type { ChannelFieldSpec } from '../channel-specs/types.js'
import { adaptSourceShape, planProductSource, sourceOwner } from './source-definition-plan.js'
import { evaluateExpr } from './expr.js'

const field = (key: string, overrides: Partial<ChannelFieldSpec> = {}): ChannelFieldSpec => ({
  key, attribute: key, path: [], label: key, shape: 'scalar', kind: 'text', cardinality: { min: 0, max: 1 },
  requirement: 'optional', requiredInParent: false, editable: true, hidden: false, variantEligible: false,
  group: { key: 'product_details', label: 'Product details', channelLabel: null, order: 0 },
  channelStore: { kind: 'platformAttributes', path: [key] }, ...overrides,
})
const run = (formula: string) => evaluateExpr(formula, { lookup: () => null })

describe('complete product source planning', () => {
  it('connects product facts with exact semantic sources without making offer settings into Master facts', () => {
    expect(planProductSource(field('country_of_origin'), 'AMAZON', 'it')?.rule.source).toBe('countryOfOrigin')
    expect(planProductSource(field('fabric_type'), 'AMAZON', 'it')?.rule.source).toBe('fabric_type')
    expect(planProductSource(field('externally_assigned_product_identifier'), 'AMAZON', 'it')?.rule.source).toBe('gtin')
    expect(planProductSource(field('apparel_size__size'), 'AMAZON', 'it')?.rule.source).toBe('size')
    const offer = field('condition_type', { group: { key: 'offer', label: 'Offer', channelLabel: null, order: 1 } })
    expect(planProductSource(offer, 'AMAZON', 'it')).toBeNull()
    expect(sourceOwner(offer)).toMatchObject({ kind: 'listing', label: 'Listing settings' })
    expect(planProductSource(field('title', { ...offer, key: 'title', masterKey: 'name' }), 'EBAY', 'it')?.rule).toMatchObject({ source: 'title', fallback: 'name' })
  })
  it('keeps packaged measures separate from product measures and item quantities separate from stock', () => {
    const packaged = planProductSource(field('item_package_weight', { shape: 'measure', kind: 'number', unitOptions: ['kilograms'] }), 'AMAZON', 'it')!
    expect(packaged.rule.source).toBe('packageWeightValue')
    expect(packaged.definitions.map(d => d.code)).toEqual(['packageWeightValue', 'packageWeightUnit'])
    expect(planProductSource(field('item_weight', { shape: 'measure', kind: 'number' }), 'AMAZON', 'it')?.rule.source).toBe('weightValue')
    expect(planProductSource(field('quantita'), 'EBAY', 'it')?.rule.source).toBe('item_specific_quantity')
  })
  it('preserves complete lists when a text destination only accepts one value', () => {
    expect(adaptSourceShape({ source: 'special_feature' }, field('features'), new Set(['special_feature'])).transforms)
      .toEqual([{ type: 'expr', expr: 'join($special_feature, ", ")' }])
  })
})

describe('typed source transformations', () => {
  it('normalises unit spelling without changing amounts, including zero', () => {
    expect(run('measure(0, "kg", "grams|kilograms")')).toMatchObject({ value: { value: 0, unit: 'kilograms' }, warnings: [] })
    expect(run('measure(1.2, "cm", "centimeters")').value).toEqual({ value: 1.2, unit: 'centimeters' })
    expect(run('measure(null, null)').value).toBeNull()
    expect(run('measure(null, "kg")')).toMatchObject({ value: null, warnings: [] })
  })
  it('refuses incomplete measures, incompatible scales, booleans and malformed countries', () => {
    for (const formula of ['measure(1, null)', 'measure(1, "kg", "grams")', 'measure(false, "kg")', 'countryname("invalid", "it")']) {
      expect(run(formula).value, formula).toBeNull()
      expect(run(formula).error, formula).toBeTruthy()
    }
  })
  it('formats country codes in the marketplace language without filling missing values', () => {
    expect(run('countryname("IT", "it")').value).toBe('Italia')
    expect(run('countryname("DE", "en")').value).toBe('Germany')
    expect(run('countryname(null, "it")')).toMatchObject({ value: null, warnings: [] })
  })
})
