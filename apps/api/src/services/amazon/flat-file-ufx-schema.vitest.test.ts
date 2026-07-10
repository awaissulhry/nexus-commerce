/**
 * UFX Phase 1 — server schema correctness.
 *
 * Locks the six defect fixes:
 *   P0-1a nested items.required → hard required / requiredWithParent columns
 *   P0-1b conditional (allOf/if/then, dependentRequired) → manifest `conditional` tag
 *   P0-2  sub-property coercion by DECLARED schema type (string "38" stays a string)
 *   P4    enumNames↔enum positional zip guarded (mismatch → codes-as-labels)
 *   P4    multi-instance emission gets the same typed coercion singletons get
 *   P2    Pattern-C sub-prop cells carry language_tag when the schema declares one
 */
import { describe, it, expect } from 'vitest'
import {
  AmazonFlatFileService,
  buildSchemaEnums,
  buildSchemaEnumCodeMap,
  buildSchemaFieldHints,
  coerceSubPropValue,
  type FlatFileColumn,
} from './flat-file.service.js'

// ── Shared schema fixture (shapes mirror real SP-API product-type schemas) ──

const wrappedString = (extra: Record<string, any> = {}) => ({
  type: 'array',
  items: { type: 'object', properties: { value: { type: 'string', ...extra }, language_tag: {}, marketplace_id: {} } },
})

const schemaDef: Record<string, any> = {
  required: ['item_name', 'item_package_weight', 'apparel_size'],
  allOf: [
    {
      if: { required: ['parentage_level'], properties: { parentage_level: { items: { required: ['value'] } } } },
      then: { required: ['variation_theme', 'child_parent_sku_relationship'] },
    },
  ],
  dependentRequired: { battery_type: ['num_batteries'] },
  properties: {
    item_name: wrappedString({ maxLength: 200 }),
    // REQUIRED dimension pair with nested items.required ['value','unit']
    item_package_weight: {
      type: 'array',
      items: {
        type: 'object',
        required: ['value', 'unit'],
        properties: { value: { type: 'number' }, unit: { type: 'string', enum: ['grams', 'kilograms'] }, marketplace_id: {} },
      },
    },
    // OPTIONAL dimension pair with the same nested required
    item_weight: {
      type: 'array',
      items: {
        type: 'object',
        required: ['value', 'unit'],
        properties: { value: { type: 'number' }, unit: { type: 'string', enum: ['grams'] }, marketplace_id: {} },
      },
    },
    // REQUIRED Pattern-C attribute: named sub-properties, nested items.required
    apparel_size: {
      type: 'array',
      items: {
        type: 'object',
        required: ['size', 'size_system'],
        properties: {
          size: { type: 'string' }, // string-typed — "38" must stay a string
          size_system: { type: 'string', enum: ['AS', 'EU'], enumNames: ['Alpha', 'Europe'] },
          size_class: { type: 'string' }, // NOT in items.required
          marketplace_id: {},
        },
      },
    },
    // OPTIONAL Pattern-C attribute with a required sub + a localized cell
    warranty_bundle: {
      type: 'array',
      items: {
        type: 'object',
        required: ['duration'],
        properties: {
          duration: { type: 'integer' },
          provider: { type: 'string' },
          language_tag: {},
          marketplace_id: {},
        },
      },
    },
    battery_type: wrappedString(),
    num_batteries: { type: 'array', items: { type: 'object', properties: { value: { type: 'integer' }, marketplace_id: {} } } },
    parentage_level: { type: 'array', items: { type: 'object', properties: { value: { type: 'string', enum: ['parent', 'child'] }, marketplace_id: {} } } },
    variation_theme: { type: 'array', items: { type: 'object', properties: { name: { type: 'string', enum: ['SIZE', 'COLOR'] }, marketplace_id: {} } } },
    child_parent_sku_relationship: { type: 'array', items: { type: 'object', properties: { parent_sku: { type: 'string' }, marketplace_id: {} } } },
  },
  __propertyGroups: {
    details: {
      title: 'Details',
      propertyNames: [
        'item_name', 'item_package_weight', 'item_weight', 'apparel_size',
        'warranty_bundle', 'battery_type', 'num_batteries',
        'parentage_level', 'variation_theme', 'child_parent_sku_relationship',
      ],
    },
  },
}

const schemasStub = {
  getSchema: async () => ({ schemaDefinition: schemaDef }),
  refreshSchema: async () => ({ schemaDefinition: schemaDef }),
} as any
const svc = new AmazonFlatFileService({} as any, schemasStub)

const manifestCols = async (): Promise<Map<string, FlatFileColumn>> => {
  const m = await svc.generateManifest('IT', 'SHIRT')
  return new Map(m.groups.flatMap((g) => g.columns).map((c) => [c.id, c]))
}

// ── P0-1a — nested items.required propagation ───────────────────────────────

describe('UFX P0-1a — nested items.required → required / requiredWithParent', () => {
  it('REQUIRED dim pair: required `unit` becomes hard-required (was hardcoded optional)', async () => {
    const cols = await manifestCols()
    expect(cols.get('item_package_weight__value')!.required).toBe(true)
    expect(cols.get('item_package_weight__unit')!.required).toBe(true)
    expect(cols.get('item_package_weight__unit')!.requiredWithParent).toBeUndefined()
  })
  it('OPTIONAL dim pair: required subs become requiredWithParent, never hard required', async () => {
    const cols = await manifestCols()
    const unit = cols.get('item_weight__unit')!
    expect(unit.required).toBe(false)
    expect(unit.requiredWithParent).toBe(true)
    const value = cols.get('item_weight__value')!
    expect(value.required).toBe(false)
    expect(value.requiredWithParent).toBe(true)
  })
  it('REQUIRED Pattern-C: subs in items.required are hard-required; others are not', async () => {
    const cols = await manifestCols()
    expect(cols.get('apparel_size__size')!.required).toBe(true)
    expect(cols.get('apparel_size__size_system')!.required).toBe(true)
    expect(cols.get('apparel_size__size_class')!.required).toBe(false)
    expect(cols.get('apparel_size__size_class')!.requiredWithParent).toBeUndefined()
  })
  it('OPTIONAL Pattern-C: required sub flagged requiredWithParent only', async () => {
    const cols = await manifestCols()
    const duration = cols.get('warranty_bundle__duration')!
    expect(duration.required).toBe(false)
    expect(duration.requiredWithParent).toBe(true)
    expect(cols.get('warranty_bundle__provider')!.requiredWithParent).toBeUndefined()
  })
})

// ── P0-1b — conditional tagging on the manifest ─────────────────────────────

describe('UFX P0-1b — manifest tags conditionally-required columns', () => {
  it('allOf then-required fields → conditional: true (variation_theme, parent_sku alias)', async () => {
    const cols = await manifestCols()
    expect(cols.get('variation_theme')!.conditional).toBe(true)
    // child_parent_sku_relationship surfaces in the grid as parent_sku
    expect(cols.get('parent_sku')!.conditional).toBe(true)
  })
  it('dependentRequired dependencies → conditional: true', async () => {
    const cols = await manifestCols()
    expect(cols.get('num_batteries')!.conditional).toBe(true)
  })
  it('unconditional columns stay untagged', async () => {
    const cols = await manifestCols()
    expect(cols.get('item_name')!.conditional).toBeUndefined()
    expect(cols.get('battery_type')!.conditional).toBeUndefined()
  })
})

// ── P0-2 — sub-property typing ───────────────────────────────────────────────

describe('UFX P0-2 — buildSchemaFieldHints.subPropTypes', () => {
  const hints = buildSchemaFieldHints(schemaDef.properties)
  it('classifies sub-property paths by declared type', () => {
    expect(hints.subPropTypes['apparel_size.size']).toBe('string')
    expect(hints.subPropTypes['warranty_bundle.duration']).toBe('number')
    expect(hints.subPropTypes['item_package_weight.value']).toBe('number')
    expect(hints.subPropTypes['item_package_weight.unit']).toBe('string')
  })
  it('classifies named dimension-pair paths (field.sub.value / field.sub.unit)', () => {
    const dims = {
      item_package_dimensions: {
        type: 'array',
        items: {
          type: 'object',
          required: ['length', 'width'],
          properties: {
            length: { type: 'object', properties: { value: { type: 'number' }, unit: { type: 'string' } } },
            width: { type: 'object', properties: { value: { type: 'number' }, unit: { type: 'string' } } },
            marketplace_id: {},
          },
        },
      },
    }
    const h = buildSchemaFieldHints(dims)
    expect(h.subPropTypes['item_package_dimensions.length.value']).toBe('number')
    expect(h.subPropTypes['item_package_dimensions.length.unit']).toBe('string')
  })
})

describe('UFX P0-2 — coerceSubPropValue', () => {
  const types = { 'apparel_size.size': 'string', 'warranty_bundle.duration': 'number', 'flag.on': 'boolean' } as const
  it('string-typed all-digits value stays a string (size "38", leading zeros)', () => {
    expect(coerceSubPropValue('apparel_size.size', '38', types)).toBe('38')
    expect(coerceSubPropValue('apparel_size.size', '007', types)).toBe('007')
  })
  it('number-typed value is coerced', () => {
    expect(coerceSubPropValue('warranty_bundle.duration', '24', types)).toBe(24)
  })
  it('boolean-typed value is coerced', () => {
    expect(coerceSubPropValue('flag.on', 'true', types)).toBe(true)
    expect(coerceSubPropValue('flag.on', '0', types)).toBe(false)
  })
  it('unknown path under a KNOWN schema stays a string (fail-safe)', () => {
    expect(coerceSubPropValue('mystery.sub', '38', types)).toBe('38')
  })
  it('no schema at all → legacy Number() sniff (backward compatible)', () => {
    expect(coerceSubPropValue('mystery.sub', '38', undefined)).toBe(38)
    expect(coerceSubPropValue('mystery.sub', 'M', undefined)).toBe('M')
  })
})

describe('UFX P0-2 — buildJsonFeedBody sub-prop typing end-to-end', () => {
  const feedSvc = new AmazonFlatFileService({} as any, {} as any)
  const expanded = {
    apparel_size__size: 'apparel_size.size',
    apparel_size__size_system: 'apparel_size.size_system',
    warranty_bundle__duration: 'warranty_bundle.duration',
    item_package_dimensions__length: 'item_package_dimensions.length.value',
    item_package_dimensions__length_unit: 'item_package_dimensions.length.unit',
  }
  const build = (row: any, feedSchema: any = {}) =>
    JSON.parse(feedSvc.buildJsonFeedBody([row], 'IT', 'SELLER', expanded, feedSchema)).messages[0]

  it('string-typed sub-prop "38" is emitted as a STRING when hints are present', () => {
    const m = build(
      { item_sku: 'S1', apparel_size__size: '38', apparel_size__size_system: 'EU' },
      { subPropTypes: { 'apparel_size.size': 'string', 'apparel_size.size_system': 'string' } },
    )
    expect(m.attributes.apparel_size[0].size).toBe('38')
  })
  it('number-typed sub-props still coerce (dim value number, unit string)', () => {
    const m = build(
      { item_sku: 'S2', item_package_dimensions__length: '15', item_package_dimensions__length_unit: 'centimeters', warranty_bundle__duration: '24' },
      { subPropTypes: { 'item_package_dimensions.length.value': 'number', 'item_package_dimensions.length.unit': 'string', 'warranty_bundle.duration': 'number' } },
    )
    expect(m.attributes.item_package_dimensions[0].length).toEqual({ value: 15, unit: 'centimeters' })
    expect(m.attributes.warranty_bundle[0].duration).toBe(24)
  })
  it('no hints → legacy sniff preserved (numeric-looking value becomes a number)', () => {
    const m = build({ item_sku: 'S3', apparel_size__size: '38' }, {})
    expect(m.attributes.apparel_size[0].size).toBe(38)
  })
})

// ── P4 — enumNames alignment guard ───────────────────────────────────────────

describe('UFX P4 — mismatched enumNames falls back to codes (never mis-maps)', () => {
  const mismatched = {
    country_of_origin: { items: { properties: { value: { type: 'string', enum: ['PK', 'IT', 'DE'], enumNames: ['Pakistan', 'Italy'] }, marketplace_id: {} } } },
  }
  it('options fall back to the codes themselves', () => {
    expect(buildSchemaEnums(mismatched).country_of_origin).toEqual(['PK', 'IT', 'DE'])
  })
  it('no label→code map is built (labels === codes → nothing to convert)', () => {
    expect(buildSchemaEnumCodeMap(mismatched).country_of_origin).toBeUndefined()
  })
  it('aligned enumNames keep working exactly as before', () => {
    const aligned = {
      country_of_origin: { items: { properties: { value: { type: 'string', enum: ['PK', 'IT'], enumNames: ['Pakistan', 'Italy'] }, marketplace_id: {} } } },
    }
    expect(buildSchemaEnums(aligned).country_of_origin).toEqual(['Pakistan', 'Italy'])
    expect(buildSchemaEnumCodeMap(aligned).country_of_origin).toEqual({ Pakistan: 'PK', Italy: 'IT' })
  })
})

describe('UFX P4 — manifest optionCodes for enum columns (codes behind labels)', () => {
  it('sub-prop enum column carries optionCodes when codes differ from labels', async () => {
    const cols = await manifestCols()
    const sys = cols.get('apparel_size__size_system')!
    expect(sys.options).toEqual(['', 'Alpha', 'Europe'])
    expect(sys.optionCodes).toEqual(['AS', 'EU'])
  })
})

// ── P4 — multi-instance typed emission ───────────────────────────────────────

describe('UFX P4 — multi-instance values get the singleton typed coercion', () => {
  const feedSvc = new AmazonFlatFileService({} as any, {} as any)
  const expanded = { thread_count_1: 'thread_count', thread_count_2: 'thread_count', flag_1: 'flag' }
  const build = (row: any, feedSchema: any = {}) =>
    JSON.parse(feedSvc.buildJsonFeedBody([row], 'IT', 'SELLER', expanded, feedSchema)).messages[0]

  it('numeric multi-instance values are numbers, not strings', () => {
    const m = build({ item_sku: 'M1', thread_count_1: '5', thread_count_2: '7' }, { numericFields: new Set(['thread_count']) })
    expect((m.attributes.thread_count as any[]).map((c) => c.value)).toEqual([5, 7])
  })
  it('boolean multi-instance values are real booleans', () => {
    const m = build({ item_sku: 'M2', flag_1: 'true' }, { booleanFields: new Set(['flag']) })
    expect(m.attributes.flag[0].value).toBe(true)
  })
  it('multi-instance enum labels still convert to codes (regression: toCode path)', () => {
    const m = build(
      { item_sku: 'M3', thread_count_1: 'Fine' },
      { enumCodeMap: { thread_count: { Fine: 'fine_code' } } },
    )
    expect(m.attributes.thread_count[0].value).toBe('fine_code')
  })
})

// ── P2 — Pattern-C localized sub-props ───────────────────────────────────────

describe('UFX P2 — Pattern-C sub-prop cells carry language_tag when declared', () => {
  const feedSvc = new AmazonFlatFileService({} as any, {} as any)
  const expanded = { warranty_bundle__duration: 'warranty_bundle.duration', warranty_bundle__provider: 'warranty_bundle.provider' }
  const build = (row: any, feedSchema: any = {}) =>
    JSON.parse(feedSvc.buildJsonFeedBody([row], 'IT', 'SELLER', expanded, feedSchema)).messages[0]
  const row = { item_sku: 'L1', warranty_bundle__duration: '24', warranty_bundle__provider: 'Xavia' }

  it('schema declares language_tag on the attribute → cell carries it', () => {
    const m = build(row, { localizedFields: new Set(['warranty_bundle']) })
    expect(m.attributes.warranty_bundle[0].language_tag).toBe('it_IT')
    expect(m.attributes.warranty_bundle[0].provider).toBe('Xavia')
  })
  it('schema known but attribute NOT localized → no tag', () => {
    const m = build(row, { localizedFields: new Set(['item_name']) })
    expect(m.attributes.warranty_bundle[0].language_tag).toBeUndefined()
  })
  it('no schema hints → legacy untagged shape preserved', () => {
    const m = build(row, {})
    expect(m.attributes.warranty_bundle[0].language_tag).toBeUndefined()
  })
  it('the schema fixture actually classifies warranty_bundle as localized', () => {
    expect(buildSchemaFieldHints(schemaDef.properties).localizedFields.has('warranty_bundle')).toBe(true)
  })
})
