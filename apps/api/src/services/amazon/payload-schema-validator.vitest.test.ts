/**
 * ALA Phase 6 — local schema-aware payload validation (type + enum).
 */
import { describe, it, expect } from 'vitest'
import { validatePayloadValues, type SchemaPayloadHints } from './payload-schema-validator.js'

const hints: SchemaPayloadHints = {
  enumCodeMap: { country_of_origin: { Italy: 'IT', Germany: 'DE' } },
  numericFields: new Set(['item_weight']),
  booleanFields: new Set(['is_assembly_required']),
  expandedFields: { bullet_point_1: 'bullet_point' },
}
const ids = (xs: { field: string }[]) => xs.map((x) => x.field).sort()

describe('validatePayloadValues', () => {
  it('flags a non-numeric value in a numeric field', () => {
    expect(ids(validatePayloadValues({ item_weight: 'heavy' }, hints))).toEqual(['item_weight'])
    expect(validatePayloadValues({ item_weight: '1.5' }, hints)).toEqual([])
  })

  it('flags a non-boolean value in a boolean field', () => {
    expect(ids(validatePayloadValues({ is_assembly_required: 'maybe' }, hints))).toEqual(['is_assembly_required'])
    expect(validatePayloadValues({ is_assembly_required: 'true' }, hints)).toEqual([])
  })

  it('flags an out-of-enum value; accepts label OR wire code', () => {
    expect(ids(validatePayloadValues({ country_of_origin: 'France' }, hints))).toEqual(['country_of_origin'])
    expect(validatePayloadValues({ country_of_origin: 'Italy' }, hints)).toEqual([]) // label
    expect(validatePayloadValues({ country_of_origin: 'DE' }, hints)).toEqual([]) // wire code
  })

  it('skips blank values (required-ness checked elsewhere)', () => {
    expect(validatePayloadValues({ item_weight: '', country_of_origin: '   ' }, hints)).toEqual([])
  })

  it('resolves an expanded column id back to its base field', () => {
    // bullet_point has no enum/type constraint here → no error even if filled
    expect(validatePayloadValues({ bullet_point_1: 'Waterproof' }, hints)).toEqual([])
  })

  it('ignores fields with no schema constraint', () => {
    expect(validatePayloadValues({ free_text: 'anything goes' }, hints)).toEqual([])
  })
})
