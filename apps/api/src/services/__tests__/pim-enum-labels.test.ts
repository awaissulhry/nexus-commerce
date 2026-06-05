/**
 * VL.1/VL.4 — enum-label extraction verifier (pure).
 */

import { describe, it, expect } from 'vitest'
import { extractEnumLabels } from '../categories/enum-labels.js'

describe('extractEnumLabels', () => {
  it('pairs wire enum values with enumNames by index', () => {
    const schema = {
      properties: {
        water_resistance_level: {
          items: { properties: { value: { enum: ['waterproof', 'water_resistant'], enumNames: ['Impermeabile', "Resistente all'acqua"] } } },
        },
      },
    }
    expect(extractEnumLabels(schema)).toEqual({
      water_resistance_level: { waterproof: 'Impermeabile', water_resistant: "Resistente all'acqua" },
    })
  })

  it('skips fields without paired enum/enumNames or with length mismatch', () => {
    const schema = {
      properties: {
        no_names: { items: { properties: { value: { enum: ['a', 'b'] } } } },
        mismatch: { items: { properties: { value: { enum: ['a', 'b'], enumNames: ['A'] } } } },
        free_text: { items: { properties: { value: { type: 'string' } } } },
      },
    }
    expect(extractEnumLabels(schema)).toEqual({})
  })

  it('coerces non-string wire values to string keys (e.g. booleans)', () => {
    const schema = {
      properties: {
        batteries_included: { items: { properties: { value: { enum: [false, true], enumNames: ['No', 'Sì'] } } } },
      },
    }
    expect(extractEnumLabels(schema)).toEqual({ batteries_included: { false: 'No', true: 'Sì' } })
  })

  it('returns {} for an empty / malformed schema', () => {
    expect(extractEnumLabels({} as any)).toEqual({})
    expect(extractEnumLabels({ properties: {} } as any)).toEqual({})
  })
})
