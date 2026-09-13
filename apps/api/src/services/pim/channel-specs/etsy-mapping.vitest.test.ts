import { describe, expect, it } from 'vitest'
import { etsyProductSpec, etsyTaxonomySpec, type EtsyTaxonomyProperty } from './etsy.js'
import { masterDefaultRule } from '../mapping/master-default-rule.js'
import { sourceOwner, planProductSource } from '../mapping/source-definition-plan.js'
import { resolveAttributes } from '../attribute-resolver.js'
import { resolveChannelField } from '../resolve-channel-field.js'
import { projectCellValue } from '../sheet-values.js'
import { storedChannelState, channelValuePatch } from '../channel-value-mutation.js'
import { validateChannelValue } from '../mapping/validate-channel-value.js'
import { buildSheetColumns } from '../sheet-columns.service.js'
import { ALLOWED_MASTER_FIELDS } from '../master-field-gate.js'
import type { CatalogueField } from '../mapping/field-catalogue.service.js'
import type { ChannelFieldSpec } from './types.js'

const spec = etsyProductSpec()
const keys = new Set([...ALLOWED_MASTER_FIELDS, 'material', 'style', 'color', 'size'])
const field = (key: string) => spec.fields.find(f => f.key === key)!
// LX.F2 R-LX-21 — the Italian text used to sit in `Product.localizedContent.it`, the store LX.6
// RETIRES (design Appendix C), so the resolver correctly ignored it and the arm read the source
// column `['leather']` instead of `['pelle','regalo']`. Italian IS the primary content language
// (`PRIMARY_CONTENT_LOCALE`), so under LX its text IS the source column — the fixture says that,
// and `localizedContent` stays EMPTY so a read-through to the retired bag cannot pass this test.
const parent = { id: 'p', parentId: null, name: 'Titolo', localizedContent: {},
  categoryAttributes: { material: ['Leather', 'Cotton'], style: 'Minimalist' }, variantAttributes: {}, keywords: ['pelle', 'regalo'],
  weightValue: 1.2, weightUnit: 'kg', dimLength: 35, dimWidth: 20, dimHeight: 5, dimUnit: 'cm', basePrice: 49.95, totalStock: 7 }
const child = { id: 'c', parentId: 'p', name: 'Child', localizedContent: {}, categoryAttributes: {}, variantAttributes: { Color: 'Nero' },
  weightValue: 750, weightUnit: 'g', dimLength: null, dimUnit: null, totalStock: 0 }
function mapped(f: ChannelFieldSpec, product = parent, ancestor?: typeof parent) {
  const rule = masterDefaultRule(f, keys)!
  const attrs = resolveAttributes({ product, parent: ancestor, locale: 'it' })
  return projectCellValue({ shape: f.shape }, resolveChannelField({ fieldKey: f.key, rule, resolvedAttrs: attrs, product, locale: 'it' }).value)
}
function validate(f: ChannelFieldSpec, value: unknown) {
  return validateChannelValue({ ...f, fieldKey: f.key, maxLength: f.maxLength ?? null, selectionOnly: f.mode === 'strict' } as CatalogueField, value)
}
const property = (changes: Partial<EtsyTaxonomyProperty> = {}): EtsyTaxonomyProperty => ({ property_id: 200, name: 'color', display_name: 'Primary color',
  supports_attributes: true, supports_variations: true, is_required: true, is_multivalued: false, max_values_allowed: 1,
  possible_values: [{ value_id: 1, name: 'Black' }], selected_values: [], scales: [], ...changes })

describe('Etsy mappings reuse Nexus data without changing its meaning', () => {
  it('uses localized keywords and complete material/style lists without comma splitting or truncation', () => {
    expect(mapped(field('tags'))).toEqual(['pelle', 'regalo'])
    expect(mapped(field('materials'))).toEqual(['Leather', 'Cotton'])
    expect(mapped(field('styles'))).toEqual(['Minimalist'])
    const tooMany = Array.from({ length: 14 }, (_, i) => `tag ${i}`)
    expect(validate(field('tags'), tooMany)).toMatchObject({ value: tooMany, errors: [expect.stringContaining('at most 13')] })
    expect(validate(field('tags'), ['a'.repeat(21)]).errors).not.toEqual([])
    expect(validate(field('materials'), ['Leather, Cotton']).errors).not.toEqual([])
  })
  it('inherits physical dimensions and preserves each variant’s weight/unit and zero stock', () => {
    expect(['item_weight', 'item_weight_unit', 'item_length', 'item_width', 'item_height', 'item_dimensions_unit']
      .map(key => mapped(field(key), child as typeof parent, parent))).toEqual([750, 'g', 35, 20, 5, 'cm'])
    expect(mapped(field('quantity'), child as typeof parent, parent)).toBe(0)
    expect(validate(field('item_weight'), 0).errors).not.toEqual([])
    expect(validate(field('item_weight_unit'), 'tonnes').errors).not.toEqual([])
  })
  it('uses channel storage for overrides even when a sheet column shares a Master key', () => {
    const coordinate = { channel: 'ETSY' as const, marketplace: 'GLOBAL', label: 'ETSY:GLOBAL', inMarket: true }
    const sheet = buildSheetColumns({ fields: [], coordinates: [coordinate], specs: [{ coordinate, spec }], scopeKind: 'channel' }).columns
    for (const key of ['tags', 'materials', 'styles', 'item_weight', 'item_length']) {
      const f = field(key), column = sheet.find(c => c.key === f.masterKey || c.slot?.of === f.masterKey)!
      expect(column.channels?.['ETSY:GLOBAL'].store, key).toEqual(f.channelStore)
      const original = { platformAttributes: { unrelated: true }, overrideData: {} }
      const value = f.shape === 'list' ? ['Own value'] : 2
      const patch = channelValuePatch(original, f.channelStore, [f.key, f.masterKey!], 'SET', value)
      expect(patch).not.toHaveProperty(f.masterKey!)
      expect(storedChannelState({ ...original, ...patch }, f.channelStore, [f.key, f.masterKey!]).value).toEqual(value)
      expect(patch.platformAttributes).toMatchObject({ unrelated: true })
    }
  })
  it('routes image authoring to Product media without treating Nexus asset IDs as Etsy IDs', () => {
    const media = field('image_ids')
    expect(media).toMatchObject({ managedBy: 'productMedia', editable: false })
    expect(masterDefaultRule(media, new Set(['image_ids', 'productMedia']))).toBeNull()
    expect(sourceOwner(media)).toMatchObject({ label: 'Product media', path: 'listing.platformAttributes._productMediaLocales' })
    expect(planProductSource(media, 'ETSY', 'it')).toBeNull()
    expect(validate(media, ['nexus-asset-id']).errors).not.toEqual([])
  })
  it('consolidates duplicate remote timestamps and preserves legacy values', () => {
    for (const [alias, key] of [['creation_timestamp', 'created_timestamp'], ['last_modified_timestamp', 'updated_timestamp']]) {
      expect(spec.coverage[alias]).toEqual([key])
      expect(spec.fields.some(f => f.key === alias)).toBe(false)
      expect(storedChannelState({ platformAttributes: { [alias]: 1789000000 } }, field(key).channelStore, [key]).value).toBe(1789000000)
      expect(masterDefaultRule(field(key), keys)).toBeNull()
      expect(sourceOwner(field(key))?.kind).toBe('system')
    }
  })
  it('maps exact category concepts, keeps constrained choices visible and preserves scale-specific distinctions', () => {
    const props = etsyTaxonomySpec('1', [property(), property({ property_id: 201, name: 'secondary_color' }),
      property({ property_id: 202, name: 'size', scales: [{ scale_id: 9, display_name: 'US' }] }),
      property({ property_id: 203, name: 'size', supports_attributes: false }),
      property({ property_id: 204, selected_values: [{ value_id: 1, name: 'Black' }] })]).fields
    expect(masterDefaultRule(props[0], keys)?.source).toBe('color')
    expect(planProductSource(props[0], 'ETSY', 'it')).toMatchObject({ rule: { source: 'color' }, definitions: [] })
    expect(validate(props[0], 'Nero')).toMatchObject({ value: 'Nero', errors: [expect.stringContaining('unaccepted')] })
    for (const id of [201, 202, 203]) expect(masterDefaultRule(props.find(f => f.key === `property_${id}`), keys)).toBeNull()
    expect(masterDefaultRule(props.find(f => f.key === 'property_204'), keys)?.transforms).toEqual([{ type: 'default', value: '1' }])
    for (const key of ['taxonomy_id', 'who_made', 'when_made', 'is_supply', 'type', 'shipping_profile_id', 'return_policy_id'])
      expect(masterDefaultRule(field(key), keys), key).toBeNull()
  })
})
