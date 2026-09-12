import { describe, expect, it } from 'vitest'
import { etsyProductSpec, etsyTaxonomySpec, type EtsyTaxonomyProperty } from './etsy.js'
import { etsyListingSchema } from './etsy-listing-schema.js'
import { buildSheetColumns } from '../sheet-columns.service.js'
import { coerceForShape } from '../sheet-values.js'
import { channelValuePatch, storedChannelState } from '../channel-value-mutation.js'
import { masterDefaultRule } from '../mapping/master-default-rule.js'

export const property = (changes: Partial<EtsyTaxonomyProperty> = {}): EtsyTaxonomyProperty => ({
  property_id: 200, name: 'color', display_name: 'Primary color', is_required: true,
  supports_attributes: true, supports_variations: true, is_multivalued: false, max_values_allowed: 1,
  possible_values: [{ value_id: 4, name: 'Green', scale_id: null }], selected_values: [], scales: [], ...changes,
})
const coordinate = { channel: 'ETSY' as const, marketplace: 'GLOBAL', label: 'ETSY:GLOBAL', inMarket: true }
const columns = (...specs: ReturnType<typeof etsyProductSpec>[]) => buildSheetColumns({ fields: [], coordinates: [coordinate], specs: specs.map(spec => ({ coordinate, spec })), scopeKind: 'channel' }).columns

describe('Etsy listing coverage on the shared sheet', () => {
  it('accounts for every official listing response, create and update attribute', () => {
    const spec = etsyProductSpec(), keys = new Set(spec.fields.map(f => f.key))
    for (const source of [etsyListingSchema.listing, etsyListingSchema.create, etsyListingSchema.update]) {
      for (const name of Object.keys(source.properties)) {
        expect(spec.coverage[name]?.length, name).toBeGreaterThan(0)
        for (const key of spec.coverage[name]) expect(keys.has(key), key).toBe(true)
      }
    }
    expect(keys.size).toBe(spec.fields.length)
    expect(spec.unrecognised).toEqual([])
    const sheet = columns(spec)
    for (const f of spec.fields) expect(sheet.some(c => c.key === (f.masterKey ?? f.key) || c.slot?.of === (f.masterKey ?? f.key)), f.key).toBe(true)
  })
  it('locks response fields and lifecycle actions against both manual edits and formula defaults', () => {
    const spec = etsyProductSpec(), sheet = columns(spec)
    for (const key of ['image_ids', 'listing_id', 'state', 'rich_description', 'num_favorers', 'is_personalizable', 'converted_price__amount']) {
      const f = spec.fields.find(f => f.key === key)!
      expect(f.readOnlyReason, key).toBeTruthy()
      expect(sheet.find(c => c.key === key), key).toMatchObject({ editable: false, formulaWritable: false })
      expect(masterDefaultRule(f, new Set([key]))).toBeNull()
    }
    expect(spec.fields.find(f => f.key === 'state')?.options).toContain('draft')
  })
  it('keeps wire aliases and collection limits without hiding their original API identities', () => {
    const spec = etsyProductSpec(), sheet = columns(spec)
    expect(spec.coverage.style).toEqual(['styles'])
    expect(spec.coverage.listing_type).toEqual(['type'])
    expect(coerceForShape(sheet.find(c => c.key === 'image_ids'), Array.from({ length: 21 }, (_, i) => i + 1)).ok).toBe(false)
    const styles = spec.fields.find(f => f.key === 'styles')!
    expect(styles.cardinality.max).toBe(2)
    expect(styles.maxLength).toBe(45)
    const listing = { platformAttributes: { style: ['Formal'], listing_type: 'physical', untouched: true }, overrideData: {} }
    expect(storedChannelState(listing, styles.channelStore, ['styles']).value).toEqual(['Formal'])
    const patch = channelValuePatch(listing, styles.channelStore, ['styles'], 'SET', ['Steampunk'])
    expect(patch.platformAttributes).toEqual({ styles: ['Steampunk'], listing_type: 'physical', untouched: true })
  })
  it('declares only semantic master defaults for shared title, description, price and stock', () => {
    const spec = etsyProductSpec(), master = new Set(['name', 'description', 'basePrice', 'totalStock', 'type'])
    expect(['title', 'description', 'price', 'quantity'].map(key => masterDefaultRule(spec.fields.find(f => f.key === key), master)?.source)).toEqual(['title', 'description', 'basePrice', 'totalStock'])
    for (const key of ['taxonomy_id', 'type', 'who_made', 'when_made']) expect(masterDefaultRule(spec.fields.find(f => f.key === key), master)).toBeNull()
  })
})

describe('Etsy category attribute contracts', () => {
  it('uses stable property IDs, exact category applicability and independent storage', () => {
    const a = etsyTaxonomySpec('1', [property()]), b = etsyTaxonomySpec('2', [property({ property_id: 201, is_required: false })])
    const sheet = columns(etsyProductSpec(), a, b)
    expect(sheet.find(c => c.key === 'property_200')).toMatchObject({ applicableProductTypes: ['1'], requiredForProductTypes: ['1'], variantEligible: true })
    const f = a.fields[0], listing = { platformAttributes: { untouched: true, etsyProperties: { '201': { value: 'Red' } } }, overrideData: {} }
    const changed = { ...listing, ...channelValuePatch(listing, f.channelStore, [f.key], 'SET', 'Green') }
    expect(storedChannelState(changed, f.channelStore, [f.key]).value).toBe('Green')
    expect(changed.platformAttributes).toMatchObject({ untouched: true, etsyProperties: { '201': { value: 'Red' } } })
  })
  it('preserves multivalued constraints, measurement scales, fixed and variation-only properties', () => {
    const spec = etsyTaxonomySpec('1', [property({ is_multivalued: true, max_values_allowed: 12, scales: [{ scale_id: 19, display_name: 'US / Canada' }] }),
      property({ property_id: 2, supports_attributes: false }), property({ property_id: 3, selected_values: [{ value_id: 4, name: 'Green' }] })])
    expect(spec.fields.find(f => f.key === 'property_200')).toMatchObject({ shape: 'list', cardinality: { max: 12 } })
    expect(spec.fields.find(f => f.key === 'property_200__scale_id')).toMatchObject({ options: ['19'], optionLabels: { '19': 'US / Canada' } })
    expect(spec.fields.find(f => f.key === 'property_2')).toMatchObject({ editable: false, requirement: 'optional' })
    expect(spec.fields.find(f => f.key === 'property_3')).toMatchObject({ editable: false, defaultRule: { transforms: [{ type: 'default', value: '4' }] } })
    expect(Object.values(spec.coverage).flat()).toHaveLength(spec.fields.length)
    expect(coerceForShape(columns(spec).find(c => c.key === 'property_200'), Array(13).fill('Green')).ok).toBe(false)
  })
  it('allows free text only when Etsy declares no choices', () => {
    const spec = etsyTaxonomySpec('1', [property({ possible_values: [] })])
    const col = columns(spec)[0]
    expect(coerceForShape(col, 'Leather').ok).toBe(true)
    expect(coerceForShape(col, 'Leather (soft)').ok).toBe(false)
  })
})
