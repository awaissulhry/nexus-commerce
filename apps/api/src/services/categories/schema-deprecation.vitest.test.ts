/**
 * ALA Phase 5 — deprecation extraction from Amazon Product Type Definition
 * properties (custom-vocab replacedBy + enumDeprecated). The schema-change diff
 * (newly-deprecated only) is a plain set-difference on these maps.
 */
import { describe, it, expect } from 'vitest'
import { extractDeprecations } from './schema-sync.service.js'

describe('extractDeprecations', () => {
  it('detects a field replacement (replacedBy nested in the subtree)', () => {
    const props = {
      old_field: { items: { properties: { value: { $lifecycle: { replacedBy: 'new_field' } } } } },
      fine_field: { type: 'string' },
    }
    const { replacedBy } = extractDeprecations(props)
    expect(replacedBy.get('old_field')).toBe('new_field')
    expect(replacedBy.has('fine_field')).toBe(false)
  })

  it('detects deprecated enum values', () => {
    const props = {
      color: { items: { properties: { value: { enum: ['red', 'crimson'], enumDeprecated: ['crimson'] } } } },
    }
    const { deprecatedEnums } = extractDeprecations(props)
    expect([...(deprecatedEnums.get('color') ?? [])]).toEqual(['crimson'])
  })

  it('returns empty maps for a clean schema', () => {
    const { replacedBy, deprecatedEnums } = extractDeprecations({
      a: { type: 'string' }, b: { items: { properties: { value: { enum: ['x'] } } } },
    })
    expect(replacedBy.size).toBe(0)
    expect(deprecatedEnums.size).toBe(0)
  })

  it('is robust to null/empty input', () => {
    expect(extractDeprecations({} as any).replacedBy.size).toBe(0)
    expect(extractDeprecations(undefined as any).deprecatedEnums.size).toBe(0)
  })
})
