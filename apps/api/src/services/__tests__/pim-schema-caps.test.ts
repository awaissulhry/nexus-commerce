/**
 * MS.1 — reading per-attribute limits out of a cached Amazon product-type definition.
 *
 * The fixtures below are the REAL shape, copied from the cached COAT/IT schema on 2026-08-29
 * (`item_name` maxLength 200, `bullet_point` 700, `material` 500 chars / 2000 bytes,
 * root `required: ['brand','bullet_point','country_of_origin','fabric_type','item_name', …]`).
 */
import { describe, it, expect } from 'vitest'
import { extractSchemaCaps, mergeSchemaCaps } from '../pim/schema-caps.js'

/** The nested wrapper every Amazon attribute uses: array → items.object → properties.value. */
const attr = (value: Record<string, unknown>, itemsRequired: string[] = ['language_tag', 'value']) => ({
  type: 'array',
  items: { type: 'object', required: itemsRequired, properties: { value, language_tag: { type: 'string' }, marketplace_id: { type: 'string' } } },
})

const COAT = {
  required: ['brand', 'bullet_point', 'item_name'],
  __propertyGroups: {},
  properties: {
    item_name: attr({ type: 'string', maxLength: 200, editable: true }),
    bullet_point: attr({ type: 'string', maxLength: 700, editable: true }),
    material: attr({ type: 'string', maxLength: 500, maxUtf8ByteLength: 2000, editable: true }),
    brand: attr({ type: 'string', maxLength: 100, editable: false }),
    department: attr({ type: 'string', enum: ['mens', 'womens'], enumNames: ['Uomo', 'Donna'], editable: true }),
  },
}

describe('extractSchemaCaps', () => {
  const caps = extractSchemaCaps(COAT)

  it('reads the real caps off the nested value node', () => {
    // The defect: `schema-to-fields.ts` drops maxLength entirely, so a counter cell shows no cap and
    // an over-length title reaches Amazon and is refused.
    expect(caps.item_name.maxLength).toBe(200)
    expect(caps.bullet_point.maxLength).toBe(700)
    expect(caps.material.maxLength).toBe(500)
  })

  it('keeps the BYTE cap separate — Amazon enforces bytes, not characters', () => {
    expect(caps.material.maxBytes).toBe(2000)
    expect(caps.item_name.maxBytes).toBeUndefined()
  })

  it('marks a root-required attribute required, and leaves the others alone', () => {
    expect(caps.item_name.required).toBe(true)
    expect(caps.brand.required).toBe(true)
    expect(caps.material.required).toBe(false)
  })

  it('reads an enum as a closed list with its display labels', () => {
    expect(caps.department.options).toEqual(['mens', 'womens'])
    expect(caps.department.selectionOnly).toBe(true)
    expect(caps.department.optionLabels).toEqual({ mens: 'Uomo', womens: 'Donna' })
  })

  it('does not invent labels when enumNames does not line up', () => {
    const c = extractSchemaCaps({ properties: { x: attr({ type: 'string', enum: ['a', 'b'], enumNames: ['Only one'] }) } })
    expect(c.x.options).toEqual(['a', 'b'])
    expect(c.x.optionLabels).toBeUndefined()
  })

  it('carries Amazon’s non-editable marker', () => {
    expect(caps.brand.editable).toBe(false)
    expect(caps.item_name.editable).toBe(true)
  })

  it('skips an attribute that needs more than one authored value to round-trip', () => {
    // `item_weight` needs value AND unit — a cap attached to a single cell that cannot write the
    // attribute is worse than no column at all.
    const c = extractSchemaCaps({
      properties: {
        item_weight: {
          type: 'array',
          items: { type: 'object', required: ['value', 'unit'], properties: { value: { type: 'number' }, unit: { type: 'string', enum: ['grams'] } } },
        },
      },
    })
    expect(c.item_weight).toBeUndefined()
  })

  it('ignores the private __ keys the cache adds', () => {
    expect(Object.keys(caps)).not.toContain('__propertyGroups')
  })

  it('survives a definition that is missing, empty or the wrong shape', () => {
    expect(extractSchemaCaps(null)).toEqual({})
    expect(extractSchemaCaps({})).toEqual({})
    expect(extractSchemaCaps('nonsense')).toEqual({})
    expect(extractSchemaCaps({ properties: { x: { type: 'string' } } })).toEqual({})
  })

  it('treats a zero or negative cap as no cap rather than a cap of zero', () => {
    const c = extractSchemaCaps({ properties: { x: attr({ type: 'string', maxLength: 0 }) } })
    expect(c.x.maxLength).toBeUndefined()
  })
})

describe('mergeSchemaCaps', () => {
  const GLOVES = {
    required: ['item_name'],
    properties: {
      item_name: attr({ type: 'string', maxLength: 80, editable: true }),
      material: attr({ type: 'string', maxLength: 500, editable: true }),
      glove_size: attr({ type: 'string', enum: ['S', 'M'], editable: true }),
    },
  }

  const merged = mergeSchemaCaps([
    { productType: 'COAT', caps: extractSchemaCaps(COAT) },
    { productType: 'GLOVES', caps: extractSchemaCaps(GLOVES) },
  ])

  it('takes the tightest cap across the types on the sheet', () => {
    // A title of 150 fits a COAT and is refused for a GLOVE; the sheet mixes both, so the counter
    // must warn at the tighter number.
    expect(merged.caps.item_name.maxLength).toBe(80)
  })

  it('tracks which types define an attribute, so a cell can grey out for the others', () => {
    expect(merged.definedBy.item_name.sort()).toEqual(['COAT', 'GLOVES'])
    expect(merged.definedBy.glove_size).toEqual(['GLOVES'])
    expect(merged.definedBy.bullet_point).toEqual(['COAT'])
  })

  it('tracks required-ness PER TYPE rather than collapsing it to a boolean', () => {
    // The defect: demanding a COAT-only required field from every glove on the sheet.
    expect(merged.requiredBy.bullet_point).toEqual(['COAT'])
    expect(merged.requiredBy.item_name.sort()).toEqual(['COAT', 'GLOVES'])
    expect(merged.requiredBy.material).toBeUndefined()
  })

  it('only calls a list closed when EVERY defining type closes it', () => {
    const openThenClosed = mergeSchemaCaps([
      { productType: 'A', caps: extractSchemaCaps({ properties: { colour: attr({ type: 'string', enum: ['Black'] }) } }) },
      { productType: 'B', caps: extractSchemaCaps({ properties: { colour: attr({ type: 'string' }) } }) },
    ])
    // B accepts free text, so flagging an off-list value on a mixed sheet would be wrong.
    expect(openThenClosed.caps.colour.selectionOnly).toBeUndefined()
  })

  it('unions the option lists so a value legal for one type is not flagged', () => {
    const m = mergeSchemaCaps([
      { productType: 'A', caps: extractSchemaCaps({ properties: { size: attr({ type: 'string', enum: ['S', 'M'] }) } }) },
      { productType: 'B', caps: extractSchemaCaps({ properties: { size: attr({ type: 'string', enum: ['M', 'L'] }) } }) },
    ])
    expect(m.caps.size.options!.sort()).toEqual(['L', 'M', 'S'])
  })

  it('is required when any type requires it', () => {
    expect(merged.caps.item_name.required).toBe(true)
    expect(merged.caps.material.required).toBe(false)
  })

  it('returns empty structures for no input rather than throwing', () => {
    expect(mergeSchemaCaps([])).toEqual({ caps: {}, definedBy: {}, requiredBy: {} })
  })
})
