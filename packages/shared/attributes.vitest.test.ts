import { describe, expect, it } from 'vitest'
import { attributeShapeOf, issueBlocksSave, optionModeFrom, parseAttributeRules } from './attributes'

describe('optionModeFrom — every spelling of closed/open becomes one word', () => {
  it.each([
    ['strict', 'strict'], ['open', 'open'],
    ['SELECTION_ONLY', 'strict'], ['FREE_TEXT', 'open'], [' selection_only ', 'strict'],
    [true, 'strict'], [false, 'open'],
  ] as const)('%s → %s', (input, expected) => {
    expect(optionModeFrom(input)).toBe(expected)
  })

  it.each([undefined, null, '', 'MAYBE', 1, {}])('says nothing for %s, so the caller keeps its default', (input) => {
    expect(optionModeFrom(input)).toBeUndefined()
  })
})

describe('parseAttributeRules', () => {
  it('treats no rules as an empty rule set', () => {
    expect(parseAttributeRules(null)).toEqual({ ok: true, rules: {} })
    expect(parseAttributeRules(undefined)).toEqual({ ok: true, rules: {} })
  })

  it('keeps keys it does not know — a saved definition must never lose data by being parsed', () => {
    const result = parseAttributeRules({ maxLength: 40, futureKey: { a: 1 }, requiredWhen: 'x' })
    expect(result).toEqual({ ok: true, rules: { maxLength: 40, futureKey: { a: 1 }, requiredWhen: 'x' } })
  })

  it('reads the real shapes saved today (information dictionary: list of records, measure units)', () => {
    const composition = {
      shape: 'list', minItems: 0, maxItems: 30, uniqueBy: 'material', sum: { field: 'percentage', total: 100 },
      recordFields: [
        { key: 'material', label: 'Material code', kind: 'text', required: true },
        { key: 'percentage', label: 'Percentage', kind: 'number', required: true, min: 0, max: 100 },
      ],
    }
    expect(parseAttributeRules(composition).ok).toBe(true)
    expect(parseAttributeRules({ shape: 'measure', unitOptions: ['cm', 'in'], minimum: 0 }).ok).toBe(true)
  })

  it('refuses rules that cannot be satisfied, and says which', () => {
    const result = parseAttributeRules({ minimum: 10, maximum: 1, minLength: 5, maxLength: 2, pattern: '(' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toEqual([
      'minimum is greater than maximum',
      'minLength is greater than maxLength',
      'pattern is not a valid regular expression',
    ])
  })

  it('refuses a wrong type with the key named', () => {
    const result = parseAttributeRules({ maxLength: 'forty' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toMatch(/^maxLength:/)
  })

  it('refuses an unknown optionMode rather than guessing', () => {
    expect(parseAttributeRules({ optionMode: 'closed' }).ok).toBe(false)
  })
})

describe('attributeShapeOf — the same rule family-sheet-schema.ts applies', () => {
  it.each([
    ['text', undefined, 'scalar'],
    ['select', {}, 'scalar'],
    ['multiselect', {}, 'list'],
    ['text', { shape: 'list' }, 'list'],
    ['number', { shape: 'measure' }, 'measure'],
    ['multiselect', { shape: 'measure' }, 'measure'],
  ] as const)('%s + %j → %s', (type, rules, expected) => {
    expect(attributeShapeOf(type, rules)).toBe(expected)
  })
})

describe('issueBlocksSave — the save rule of PLAN §4.4', () => {
  it('stores off-list, missing-map and required values as flags; refuses only what cannot or may not be stored', () => {
    expect(issueBlocksSave('shape')).toBe(true)
    expect(issueBlocksSave('rule')).toBe(true)
    expect(issueBlocksSave('channel-limit')).toBe(true)
    expect(issueBlocksSave('off-list')).toBe(false)
    expect(issueBlocksSave('value-map-miss')).toBe(false)
    expect(issueBlocksSave('required')).toBe(false)
  })
})
