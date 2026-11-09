/**
 * RuleBuilder's rules (B-W2b-207, design part RuleBuilder), pure: a rule is condition rows (field, how it compares, value)
 * joined by AND or OR — a quote's approval rule ("margin is under 20 % or discount is over 15 %"), an option rule ("the
 * option is Perforation"), a chain. A row is complete when it has a field, a way to compare and (when that way needs one)
 * a value of the field's kind; the rule may be applied only when every row is complete. The same facts make the plain-words
 * preview of the whole rule.
 */
import type { RuleBuilderLabels } from './RuleBuilderLabels'

export type RuleCombinator = 'and' | 'or'
export type RuleOperator = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'in' | 'notIn' | 'contains' | 'isTrue' | 'isFalse'
export type RuleFieldKind = 'number' | 'text' | 'choice' | 'yesNo'

export interface RuleFieldOption {
  value: string
  label: string
}

export interface RuleField {
  id: string
  /** Its words as they read in a sentence: "margin", "discount", "the option". */
  label: string
  kind: RuleFieldKind
  /** The ways it may compare (default by kind). */
  operators?: readonly RuleOperator[]
  /** A choice field's options. */
  options?: readonly RuleFieldOption[]
  /** A number's unit, written after it: "%", "€", "pcs". */
  unit?: string | null
  /** A number's bounds (a percentage 0–100). */
  min?: number
  max?: number
  /** Why this field cannot be picked now ("Not in your role"); it is listed, held. */
  heldReason?: string | null
}

export interface RuleRow {
  id: string
  field: string | null
  operator: RuleOperator | null
  /** A number or text as typed; a choice's option value; the options of `in` / `notIn`; nothing for yes / no. */
  value: string | readonly string[] | null
}

export interface RuleDraft {
  combinator: RuleCombinator
  rows: readonly RuleRow[]
}

export const RULE_OPERATORS_BY_KIND: Readonly<Record<RuleFieldKind, readonly RuleOperator[]>> = {
  number: ['lt', 'lte', 'gt', 'gte', 'eq', 'ne'],
  text: ['eq', 'ne', 'contains'],
  choice: ['eq', 'ne', 'in', 'notIn'],
  yesNo: ['isTrue', 'isFalse'],
}

/** The ways a field may compare. */
export function operatorsOf(field: RuleField | null | undefined): readonly RuleOperator[] {
  if (!field) return []
  return field.operators?.length ? field.operators : RULE_OPERATORS_BY_KIND[field.kind]
}

/** Does this way of comparing need a value? */
export const operatorNeedsValue = (operator: RuleOperator | null): boolean => operator !== 'isTrue' && operator !== 'isFalse'

/** Does it take several values (one of, none of)? */
export const operatorTakesMany = (operator: RuleOperator | null): boolean => operator === 'in' || operator === 'notIn'

/** A number as typed ("20", "12,5", "-3"): the plain decimal, or undefined when it is not one. */
export function ruleNumber(text: string): string | undefined {
  const compact = text.trim().replace(/\s/g, '').replace(',', '.')
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(compact)) return undefined
  return compact.replace(/\.$/, '')
}

/** A new empty row. */
export const newRuleRow = (id: string): RuleRow => ({ id, field: null, operator: null, value: null })

/**
 * The row with another field: the way to compare stays when the new field allows it (else its first), the value stays
 * only when the kind (and a choice's options) stay the same.
 */
export function withRuleField(row: RuleRow, fieldId: string | null, fields: readonly RuleField[]): RuleRow {
  const was = fields.find((field) => field.id === row.field)
  const next = fields.find((field) => field.id === fieldId) ?? null
  if (!next) return { ...row, field: null, operator: null, value: null }
  const operators = operatorsOf(next)
  const operator = row.operator && operators.includes(row.operator) ? row.operator : (operators[0] ?? null)
  const sameKind = !!was && was.kind === next.kind && (next.kind !== 'choice' || was.options === next.options)
  const keep = sameKind && operatorTakesMany(operator) === operatorTakesMany(row.operator) && operatorNeedsValue(operator)
  return { ...row, field: next.id, operator, value: keep ? row.value : operatorTakesMany(operator) ? [] : null }
}

/** The row with another way to compare: a single value becomes a list (or back) when one of / none of starts or ends. */
export function withRuleOperator(row: RuleRow, operator: RuleOperator | null): RuleRow {
  if (!operatorNeedsValue(operator)) return { ...row, operator, value: null }
  const many = operatorTakesMany(operator)
  if (many === operatorTakesMany(row.operator) && operatorNeedsValue(row.operator)) return { ...row, operator }
  const list = Array.isArray(row.value) ? row.value : typeof row.value === 'string' && row.value ? [row.value] : []
  return { ...row, operator, value: many ? list : (list[0] ?? null) }
}

export type RuleRowProblem = 'field' | 'fieldHeld' | 'operator' | 'value' | 'number' | 'range' | 'choice'

/** What is missing in a row, or null when it is complete. */
export function ruleRowProblem(row: RuleRow, fields: readonly RuleField[]): RuleRowProblem | null {
  const field = fields.find((entry) => entry.id === row.field)
  if (!field) return 'field'
  if (field.heldReason) return 'fieldHeld'
  if (!row.operator || !operatorsOf(field).includes(row.operator)) return 'operator'
  if (!operatorNeedsValue(row.operator)) return null
  if (operatorTakesMany(row.operator)) {
    const list = Array.isArray(row.value) ? row.value : []
    if (list.length === 0) return 'choice'
    return list.every((value) => field.options?.some((option) => option.value === value)) ? null : 'choice'
  }
  const value = typeof row.value === 'string' ? row.value.trim() : ''
  if (value === '') return field.kind === 'choice' ? 'choice' : 'value'
  if (field.kind === 'number') {
    const number = ruleNumber(value)
    if (number === undefined) return 'number'
    const n = Number(number)
    if ((field.min !== undefined && n < field.min) || (field.max !== undefined && n > field.max)) return 'range'
  }
  if (field.kind === 'choice' && !field.options?.some((option) => option.value === value)) return 'choice'
  return null
}

/** One problem said in words (the row's place, what is missing). */
export function ruleProblemText(index: number, problem: RuleRowProblem, field: RuleField | undefined, labels: RuleBuilderLabels): string {
  const what =
    problem === 'range'
      ? labels.problems.range(field?.min ?? null, field?.max ?? null)
      : problem === 'fieldHeld'
        ? (field?.heldReason ?? labels.problems.field)
        : labels.problems[problem]
  return labels.rowProblem(index + 1, what)
}

/** Every incomplete row, in order. */
export function ruleProblems(draft: RuleDraft, fields: readonly RuleField[], labels: RuleBuilderLabels): Array<{ rowId: string; index: number; text: string }> {
  return draft.rows.flatMap((row, index) => {
    const problem = ruleRowProblem(row, fields)
    if (!problem) return []
    return [{ rowId: row.id, index, text: ruleProblemText(index, problem, fields.find((field) => field.id === row.field), labels) }]
  })
}

/** Why Apply is held: no condition, or the first incomplete row ("Condition 2: enter a value"); null when it may apply. */
export function ruleHeldReason(draft: RuleDraft, fields: readonly RuleField[], labels: RuleBuilderLabels): string | null {
  if (draft.rows.length === 0) return labels.noRows
  return ruleProblems(draft, fields, labels)[0]?.text ?? null
}

/** A row's value in words: a number with its unit, a choice's words, several joined ("Perforation or Thermal liner"). */
export function ruleValueText(row: RuleRow, field: RuleField, labels: RuleBuilderLabels, formatNumber: (value: string) => string = String): string {
  const optionWords = (value: string) => field.options?.find((option) => option.value === value)?.label ?? value
  if (Array.isArray(row.value)) return labels.list(row.value.map(optionWords), row.operator === 'notIn' ? 'nor' : 'or')
  const value = typeof row.value === 'string' ? row.value.trim() : ''
  if (field.kind === 'number') {
    const number = ruleNumber(value)
    const text = number === undefined ? value : formatNumber(number)
    return field.unit ? labels.withUnit(text, field.unit) : text
  }
  if (field.kind === 'choice') return optionWords(value)
  return value
}

/** One complete row in words ("margin is under 20 %"); an incomplete one says so ("condition 2 is not finished"). */
export function ruleRowText(row: RuleRow, index: number, fields: readonly RuleField[], labels: RuleBuilderLabels, formatNumber?: (value: string) => string): string {
  const field = fields.find((entry) => entry.id === row.field)
  if (!field || !row.operator || ruleRowProblem(row, fields)) return labels.unfinished(index + 1)
  // One of a single value reads as "is"; none of a single value as "is not".
  const single = Array.isArray(row.value) && row.value.length === 1
  const operator: RuleOperator = single && row.operator === 'in' ? 'eq' : single && row.operator === 'notIn' ? 'ne' : row.operator
  return labels.operators[operator](field.label, operatorNeedsValue(operator) ? ruleValueText(row, field, labels, formatNumber) : '')
}

export interface RulePreviewWords {
  /** What comes before the conditions: "A quote needs approval when". */
  lead?: string | null
  /** What comes after them: "— block, with the message …". */
  outcome?: string | null
  formatNumber?: (value: string) => string
}

/** The whole rule in plain words: the lead, every row joined by "and" / "or", the outcome. */
export function rulePreview(draft: RuleDraft, fields: readonly RuleField[], labels: RuleBuilderLabels, words: RulePreviewWords = {}): string {
  if (draft.rows.length === 0) return labels.noRows
  const joiner = ` ${draft.combinator === 'and' ? labels.and : labels.or} `
  const conditions = draft.rows.map((row, index) => ruleRowText(row, index, fields, labels, words.formatNumber)).join(joiner)
  return [words.lead, conditions, words.outcome].filter((part) => part && part.trim()).join(' ')
}
