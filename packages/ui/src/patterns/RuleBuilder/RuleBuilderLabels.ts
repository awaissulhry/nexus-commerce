import type { RuleOperator, RuleRowProblem } from './ruleBuilderModel'

/**
 * `RuleBuilder`'s words (B-W2b-207). English by default; a host passes the words it translates. Each way of comparing is a
 * sentence maker: `(field, value) => "margin is under 20 %"` — the field's words come from the app ("margin").
 */
export interface RuleBuilderLabels {
  /** Each way to compare, as a sentence and (for the list) as words. */
  operators: Record<RuleOperator, (field: string, value: string) => string>
  /** The ways to compare in the row's list ("is under"). */
  operatorNames: Record<RuleOperator, string>
  /** The AND / OR choice. */
  combinator: string
  all: string
  any: string
  /** In the preview, between two conditions. */
  and: string
  or: string
  /** Several values in words: "Perforation or Thermal liner", "Perforation nor Thermal liner". */
  list: (values: readonly string[], join: 'or' | 'nor') => string
  /** A number with its unit: "20 %". */
  withUnit: (value: string, unit: string) => string
  /** A row's name: "Condition 2". */
  row: (n: number) => string
  /** The row's controls, named for assistive technology. */
  fieldOf: (n: number) => string
  operatorOf: (n: number) => string
  valueOf: (n: number) => string
  /** The empty choice of each list. */
  pickField: string
  pickOperator: string
  pickValue: string
  addRow: string
  removeRow: (n: number) => string
  /** Why Remove is held on the only row. */
  lastRow: string
  /** Why Add is held at the most rows. */
  maxRows: (max: number) => string
  /** The preview's name. */
  preview: string
  /** A row not finished, in the preview. */
  unfinished: (n: number) => string
  /** No condition at all (held, and the preview). */
  noRows: string
  /** "Condition 2: enter a value". */
  rowProblem: (n: number, problem: string) => string
  problems: Record<Exclude<RuleRowProblem, 'range'>, string> & { range: (min: number | null, max: number | null) => string }
  apply: string
}

const join = (values: readonly string[], word: string) =>
  values.length <= 1 ? (values[0] ?? '') : `${values.slice(0, -1).join(', ')} ${word} ${values[values.length - 1]}`

export const RULE_BUILDER_LABELS: RuleBuilderLabels = {
  operators: {
    eq: (field, value) => `${field} is ${value}`,
    ne: (field, value) => `${field} is not ${value}`,
    lt: (field, value) => `${field} is under ${value}`,
    lte: (field, value) => `${field} is at most ${value}`,
    gt: (field, value) => `${field} is over ${value}`,
    gte: (field, value) => `${field} is at least ${value}`,
    in: (field, value) => `${field} is ${value}`,
    notIn: (field, value) => `${field} is neither ${value}`,
    contains: (field, value) => `${field} contains “${value}”`,
    isTrue: (field) => `${field} is yes`,
    isFalse: (field) => `${field} is no`,
  },
  operatorNames: {
    eq: 'is',
    ne: 'is not',
    lt: 'is under',
    lte: 'is at most',
    gt: 'is over',
    gte: 'is at least',
    in: 'is one of',
    notIn: 'is none of',
    contains: 'contains',
    isTrue: 'is yes',
    isFalse: 'is no',
  },
  combinator: 'Conditions that must hold',
  all: 'All of them (AND)',
  any: 'Any of them (OR)',
  and: 'and',
  or: 'or',
  list: (values, word) => join(values, word),
  withUnit: (value, unit) => `${value} ${unit}`,
  row: (n) => `Condition ${n}`,
  fieldOf: (n) => `Condition ${n}: what`,
  operatorOf: (n) => `Condition ${n}: how it compares`,
  valueOf: (n) => `Condition ${n}: value`,
  pickField: 'Pick what…',
  pickOperator: 'Pick how…',
  pickValue: 'Pick a value…',
  addRow: 'Add a condition',
  removeRow: (n) => `Remove condition ${n}`,
  lastRow: 'A rule needs at least one condition.',
  maxRows: (max) => `A rule has at most ${max} conditions.`,
  preview: 'The rule in words',
  unfinished: (n) => `(condition ${n} is not finished)`,
  noRows: 'Add a condition first.',
  rowProblem: (n, problem) => `Condition ${n}: ${problem}`,
  problems: {
    field: 'pick what it checks',
    fieldHeld: 'this field cannot be used',
    operator: 'pick how it compares',
    value: 'enter a value',
    number: 'enter a number',
    choice: 'pick at least one value',
    range: (min, max) => (min !== null && max !== null ? `enter a number from ${min} to ${max}` : min !== null ? `enter a number of at least ${min}` : `enter a number of at most ${max}`),
  },
  apply: 'Apply',
}
