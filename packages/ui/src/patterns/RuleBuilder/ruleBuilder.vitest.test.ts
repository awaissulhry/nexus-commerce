import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RuleBuilder } from './RuleBuilder'
import { RULE_BUILDER_LABELS as W } from './RuleBuilderLabels'
import {
  operatorsOf,
  ruleHeldReason,
  ruleNumber,
  rulePreview,
  ruleProblems,
  ruleRowProblem,
  withRuleField,
  withRuleOperator,
  type RuleDraft,
  type RuleField,
} from './ruleBuilderModel'

/** B-W2b-207 — RuleBuilder. A made-up approval rule and option rule. */
const FIELDS: RuleField[] = [
  { id: 'margin', label: 'margin', kind: 'number', unit: '%', min: 0, max: 100 },
  { id: 'discount', label: 'discount', kind: 'number', unit: '%' },
  { id: 'option', label: 'the option', kind: 'choice', options: [{ value: 'PERF', label: 'Perforation' }, { value: 'LINER', label: 'Thermal liner' }, { value: 'HUMP', label: 'Aero hump' }] },
  { id: 'mtm', label: 'made to measure', kind: 'yesNo' },
  { id: 'note', label: 'the note', kind: 'text' },
  { id: 'cost', label: 'cost', kind: 'number', heldReason: 'Not in your role' },
]
const DRAFT: RuleDraft = {
  combinator: 'or',
  rows: [
    { id: 'a', field: 'margin', operator: 'lt', value: '20' },
    { id: 'b', field: 'discount', operator: 'gt', value: '15,5' },
  ],
}

describe('the rule', () => {
  it('reads in plain words with the lead and the outcome; numbers in the page’s language', () => {
    const italian = new Intl.NumberFormat('it-IT')
    expect(rulePreview(DRAFT, FIELDS, W, { lead: 'A quote needs approval when' })).toBe('A quote needs approval when margin is under 20 % or discount is over 15.5 %')
    expect(rulePreview({ ...DRAFT, combinator: 'and' }, FIELDS, W, { formatNumber: (n) => italian.format(Number(n)) })).toBe('margin is under 20 % and discount is over 15,5 %')
    const options: RuleDraft = { combinator: 'and', rows: [{ id: 'o', field: 'option', operator: 'in', value: ['PERF', 'HUMP'] }, { id: 'p', field: 'option', operator: 'notIn', value: ['LINER'] }, { id: 'm', field: 'mtm', operator: 'isTrue', value: null }] }
    expect(rulePreview(options, FIELDS, W, { lead: 'When', outcome: '— Thermal liner is excluded (block)' })).toBe(
      'When the option is Perforation or Aero hump and the option is not Thermal liner and made to measure is yes — Thermal liner is excluded (block)',
    )
    expect(rulePreview({ combinator: 'and', rows: [] }, FIELDS, W)).toBe('Add a condition first.')
  })

  it('a row is complete with a field, a way to compare and a value of its kind; the first problem holds Apply', () => {
    expect(ruleRowProblem({ id: 'x', field: null, operator: null, value: null }, FIELDS)).toBe('field')
    expect(ruleRowProblem({ id: 'x', field: 'cost', operator: 'lt', value: '1' }, FIELDS)).toBe('fieldHeld')
    expect(ruleRowProblem({ id: 'x', field: 'margin', operator: null, value: null }, FIELDS)).toBe('operator')
    expect(ruleRowProblem({ id: 'x', field: 'margin', operator: 'lt', value: ' ' }, FIELDS)).toBe('value')
    expect(ruleRowProblem({ id: 'x', field: 'margin', operator: 'lt', value: '2x' }, FIELDS)).toBe('number')
    expect(ruleRowProblem({ id: 'x', field: 'margin', operator: 'lt', value: '120' }, FIELDS)).toBe('range')
    expect(ruleRowProblem({ id: 'x', field: 'option', operator: 'in', value: [] }, FIELDS)).toBe('choice')
    expect(ruleRowProblem({ id: 'x', field: 'option', operator: 'eq', value: 'NOPE' }, FIELDS)).toBe('choice')
    expect(ruleRowProblem({ id: 'x', field: 'mtm', operator: 'isFalse', value: null }, FIELDS)).toBeNull()
    const draft: RuleDraft = { combinator: 'and', rows: [DRAFT.rows[0]!, { id: 'c', field: 'discount', operator: 'gt', value: '' }, { id: 'd', field: null, operator: null, value: null }] }
    expect(ruleHeldReason(draft, FIELDS, W)).toBe('Condition 2: enter a value')
    expect(ruleProblems(draft, FIELDS, W).map((p) => p.text)).toEqual(['Condition 2: enter a value', 'Condition 3: pick what it checks'])
    expect(ruleHeldReason({ combinator: 'and', rows: [{ id: 'e', field: 'margin', operator: 'lt', value: '120' }] }, FIELDS, W)).toBe('Condition 1: enter a number from 0 to 100')
    expect(ruleHeldReason({ combinator: 'and', rows: [{ id: 'e', field: 'cost', operator: 'lt', value: '1' }] }, FIELDS, W)).toBe('Condition 1: Not in your role')
    expect(ruleHeldReason(DRAFT, FIELDS, W)).toBeNull()
    expect(ruleHeldReason({ combinator: 'and', rows: [] }, FIELDS, W)).toBe('Add a condition first.')
    expect(rulePreview(draft, FIELDS, W)).toBe('margin is under 20 % and (condition 2 is not finished) and (condition 3 is not finished)')
  })

  it('changing the field keeps what still fits; changing the way to compare moves between one value and several', () => {
    const row = { id: 'r', field: 'margin', operator: 'gte' as const, value: '20' }
    expect(withRuleField(row, 'discount', FIELDS)).toEqual({ id: 'r', field: 'discount', operator: 'gte', value: '20' })
    expect(withRuleField(row, 'option', FIELDS)).toEqual({ id: 'r', field: 'option', operator: 'eq', value: null })
    expect(withRuleField(row, 'mtm', FIELDS)).toEqual({ id: 'r', field: 'mtm', operator: 'isTrue', value: null })
    expect(withRuleField(row, null, FIELDS)).toEqual({ id: 'r', field: null, operator: null, value: null })
    const one = { id: 'o', field: 'option', operator: 'eq' as const, value: 'PERF' }
    expect(withRuleOperator(one, 'in')).toEqual({ ...one, operator: 'in', value: ['PERF'] })
    expect(withRuleOperator({ ...one, operator: 'in', value: ['LINER', 'PERF'] }, 'ne')).toEqual({ ...one, operator: 'ne', value: 'LINER' })
    expect(withRuleOperator(one, 'isTrue')).toEqual({ ...one, operator: 'isTrue', value: null })
    expect(operatorsOf(FIELDS[3])).toEqual(['isTrue', 'isFalse'])
    expect([ruleNumber('12,5'), ruleNumber(' 3 '), ruleNumber('1.234,5'), ruleNumber('x')]).toEqual(['12.5', '3', undefined, undefined])
  })
})

describe('RuleBuilder', () => {
  it('editable: rows with their named controls, AND / OR, the preview, Apply ready', () => {
    const html = render(h(RuleBuilder, { label: 'Approval rule', fields: FIELDS, value: DRAFT, onChange: () => undefined, onApply: () => undefined, lead: 'A quote needs approval when' }))
    expect(html).toContain('<legend class="nds-rb-legend">Approval rule</legend>')
    expect(html).toContain('aria-label="Condition 2: how it compares"')
    expect(html).toContain('Any of them (OR)')
    expect(html).toContain('A quote needs approval when margin is under 20 % or discount is over 15.5 %')
    expect(html).toContain('cost — Not in your role')
    expect(html).not.toContain('aria-disabled')
  })

  it('Apply held with the first incomplete row, said on screen; the only row cannot be removed', () => {
    const html = render(h(RuleBuilder, { label: 'Rule', fields: FIELDS, value: { combinator: 'and', rows: [{ id: 'a', field: 'margin', operator: 'lt', value: '' }] }, onChange: () => undefined, onApply: () => undefined }))
    expect(html).toContain('<p class="nds-rb-held">Condition 1: enter a value</p>')
    expect(html).toContain('aria-description="Condition 1: enter a value"')
    expect(html).toContain('aria-description="A rule needs at least one condition."')
    expect(html).not.toContain('Any of them (OR)')
    const offline = render(h(RuleBuilder, { label: 'Rule', fields: FIELDS, value: DRAFT, onChange: () => undefined, onApply: () => undefined, applyHeldReason: 'Offline — your changes are kept on this page' }))
    expect(offline).toContain('aria-description="Offline — your changes are kept on this page"')
  })

  it('several choices are ticks; read only draws words, not greyed inputs', () => {
    const many = render(h(RuleBuilder, { label: 'Rule', fields: FIELDS, value: { combinator: 'and', rows: [{ id: 'o', field: 'option', operator: 'in', value: ['PERF'] }] }, onChange: () => undefined }))
    expect(many).toContain('type="checkbox"')
    expect(many).toContain('role="group" aria-label="Condition 1: value"')
    const read = render(h(RuleBuilder, { label: 'Rule', fields: FIELDS, value: DRAFT, readOnly: true, readOnlyReason: 'Read-only: the rule is in use.' }))
    expect(read).not.toContain('<select')
    expect(read).not.toContain('<input')
    expect(read).toContain('Read-only: the rule is in use.')
    expect(read).toContain('margin is under 20 %')
    expect(read).toContain('discount is over 15.5 %')
  })
})
