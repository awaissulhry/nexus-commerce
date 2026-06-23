/**
 * ALA Phase 2 — conditional-requirement evaluator. Cases use the REAL allOf
 * shapes pulled from our cached HELMET schema (parentage_level rules) plus
 * variation-theme / else / not / unknown-rule edge cases. Advisory: the contract
 * is "only emit a hint when confidently true; never block".
 */
import { describe, it, expect } from 'vitest'
import { evaluateConditionalRequirements, conditionalRequirementIssues } from './conditional-requirements.js'

const ids = (hints: { field: string }[]) => hints.map((h) => h.field).sort()

describe('evaluateConditionalRequirements — real HELMET shapes', () => {
  // Rule A (verbatim shape): parentage_level present → child_parent_sku_relationship + variation_theme required.
  const ruleA = {
    if: { required: ['parentage_level'], properties: { parentage_level: { items: { required: ['value'] } } } },
    then: { required: ['child_parent_sku_relationship', 'variation_theme'] },
  }
  // Rule B (verbatim shape): parentage_level value=child → parent_sku required (nested).
  const ruleB = {
    if: {
      required: ['parentage_level'],
      properties: { parentage_level: { contains: { required: ['value'], properties: { value: { enum: ['child'] } } } } },
    },
    then: { properties: { child_parent_sku_relationship: { items: { required: ['parent_sku'] } } } },
  }
  const schema = { required: ['item_name', 'brand'], allOf: [ruleA, ruleB] }

  it('child row → both rules fire (top-level + nested required surface)', () => {
    const hints = evaluateConditionalRequirements(schema, { parentage_level: 'child' })
    expect(ids(hints)).toEqual(['child_parent_sku_relationship', 'variation_theme'])
  })

  it('parent row (value≠child) → only the presence rule fires, not the value rule', () => {
    const hints = evaluateConditionalRequirements(schema, { parentage_level: 'parent' })
    // ruleA fires (present), ruleB does not (value!=child).
    expect(ids(hints)).toEqual(['child_parent_sku_relationship', 'variation_theme'])
    // and parent_sku is NOT demanded for a parent row
    expect(hints.find((h) => h.field === 'parent_sku')).toBeUndefined()
  })

  it('standalone row (no parentage) → no conditional hints', () => {
    expect(evaluateConditionalRequirements(schema, {})).toEqual([])
  })

  it('excludes attributes already in the static required array', () => {
    const s = { required: ['variation_theme'], allOf: [ruleA] }
    const hints = evaluateConditionalRequirements(s, { parentage_level: 'child' })
    expect(ids(hints)).toEqual(['child_parent_sku_relationship']) // variation_theme excluded (static)
  })

  it('records a "because" trigger for the message', () => {
    const hints = evaluateConditionalRequirements({ allOf: [ruleB] }, { parentage_level: 'child' })
    expect(hints[0].because.field).toBe('parentage_level')
    expect(hints[0].because.value).toBe('child')
  })
})

describe('evaluateConditionalRequirements — variation_theme / else / not / unknown', () => {
  it('variation_theme = SIZE → size attribute required', () => {
    const rule = {
      if: { required: ['variation_theme'], properties: { variation_theme: { contains: { required: ['value'], properties: { value: { enum: ['SIZE'] } } } } } },
      then: { properties: { shirt_size: { items: { required: ['value'] } } } },
    }
    expect(ids(evaluateConditionalRequirements({ allOf: [rule] }, { variation_theme: 'SIZE' }))).toEqual(['shirt_size'])
    expect(evaluateConditionalRequirements({ allOf: [rule] }, { variation_theme: 'COLOR' })).toEqual([])
  })

  it('else branch fires when the if is false', () => {
    const rule = {
      if: { required: ['x'], properties: { x: { items: { required: ['value'] } } } },
      then: { required: ['a'] },
      else: { required: ['b'] },
    }
    expect(ids(evaluateConditionalRequirements({ allOf: [rule] }, {}))).toEqual(['b'])
    expect(ids(evaluateConditionalRequirements({ allOf: [rule] }, { x: '1' }))).toEqual(['a'])
  })

  it('negated condition (if.not)', () => {
    const rule = {
      if: { not: { required: ['x'], properties: { x: { items: { required: ['value'] } } } } },
      then: { required: ['c'] },
    }
    expect(ids(evaluateConditionalRequirements({ allOf: [rule] }, {}))).toEqual(['c'])
    expect(evaluateConditionalRequirements({ allOf: [rule] }, { x: '1' })).toEqual([])
  })

  it('unknown constraint in the if → rule skipped (conservative, no hint)', () => {
    const rule = {
      if: { properties: { x: { minItems: 2 } } }, // we can't evaluate minItems on flat values
      then: { required: ['d'] },
    }
    expect(evaluateConditionalRequirements({ allOf: [rule] }, { x: 'whatever' })).toEqual([])
  })

  it('no allOf → no hints', () => {
    expect(evaluateConditionalRequirements({ required: ['item_name'] }, { item_name: '' })).toEqual([])
  })
})

describe('conditionalRequirementIssues — advisory warnings for empty conditional fields', () => {
  const rule = {
    if: { required: ['parentage_level'], properties: { parentage_level: { items: { required: ['value'] } } } },
    then: { required: ['variation_theme'] },
  }
  it('empty conditional field → a warning (never an error)', () => {
    const issues = conditionalRequirementIssues({ allOf: [rule] }, { parentage_level: 'child' })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ field: 'variation_theme', severity: 'warning' })
    expect(issues[0].message).toMatch(/likely required/)
  })
  it('filled conditional field → no warning', () => {
    const issues = conditionalRequirementIssues({ allOf: [rule] }, { parentage_level: 'child', variation_theme: 'SIZE' })
    expect(issues).toEqual([])
  })
})
