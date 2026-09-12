import { describe, it, expect } from 'vitest'
import { optionVerdict } from './cell-formula.service.js'

// Option validation is shared with previews; saving a non-price formula is separately refused.
const column = { label: 'Are batteries included?', options: ['false', 'true'] }
const catalogueField = { label: 'Le batterie sono incluse?', options: ['false', 'true'],
  optionLabels: { false: 'No', true: 'Sì' }, selectionOnly: true }
const validate = (value: unknown) => optionVerdict({ column, catalogueField: catalogueField as never, value })

describe('option refusal labels and normalization', () => {
  it('names the sheet header while using the catalogue option labels', () => {
    const result = validate('maybe')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('invalid value accepted')
    expect(result.error).toContain(column.label)
    expect(result.error).not.toContain(catalogueField.label)
    expect(result.error).toContain('No, Sì')
    expect(result.allowedOptions).toEqual(['false', 'true'])
    expect(result.actualValue).toBe('maybe')
  })
  it('normalizes valid option codes before storage', () => {
    expect(validate(' TRUE ')).toEqual({ ok: true, value: 'true' })
    expect(optionVerdict({ column, catalogueField: null, value: ' TRUE ' })).toEqual({ ok: true, value: 'true' })
  })
  it('bounds the explanation without losing the complete allowed set', () => {
    const result = optionVerdict({ catalogueField: null, column: { label: 'Codes', options: Array.from({ length: 100 }, (_, i) => `H${200 + i}`) }, value: 'NOPE' })
    if (result.ok) throw new Error('invalid value accepted')
    expect(result.error).toContain('(100 in all)')
    expect(result.error.length).toBeLessThan(220)
    expect(result.allowedOptions).toHaveLength(100)
  })
})
