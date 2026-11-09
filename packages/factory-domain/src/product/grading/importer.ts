import { cell, type CellValue } from '../../imports/cells'
import { defineImporter, type ExistingRecord, type RecordValues, type RowIssue, type RowPlan, type RowValues } from '../../imports/importer'
import { measureText, sameMeasure } from '../measures/rules'
import { GRADE_FORMATS, RULE_CODE, RULE_CODE_RULE, RULE_LIMITS } from './rules'

/**
 * The grade rules' import (B-W2b-224; PRD-051; design products.sizes "Import (W2b)"): a sheet of grade steps, one per
 * row, keyed by the rule's code, the point's code and the step. A known step changes its increment; a new one is added
 * to its rule; a rule code the library does not have makes the rule, from the row's scale, base size, name and format
 * (the first row of a new rule gives them; the others may repeat them).
 *
 *   rule, point, step     the rule's code, the point's code, and the step: "50-52" from size 50 to 52 (a size code never
 *                         holds a dash), or "*" for the point's standard increment of every step
 *   increment             in the point's unit, negative too
 *   rule name, scale, base size, format    for a new rule only (a known rule keeps its own; change it on its page)
 *
 * The adapter (apps/factory-api modules/product/grading/importer.ts) finds the rule, the point and the step, and checks
 * what needs the database (the rule's scale and sizes, a garment point, an absolute rule's steps from its base) in the
 * dry run and again in each batch.
 */

export const GRADE_RULES_IMPORTER_KEY = 'product.gradeRules'

const STANDARD = new Set(['*', 'std', 'standard', 'standard increment', 'tutte', 'tutti', 'all', 'ogni taglia', 'ogni'])

/** A step as the sheet writes it: "50-52", "50>52", "50→52", or "*" (the standard increment). */
export function parseStep(text: string): { readonly fromSize: string | null; readonly toSize: string | null } | null {
  const value = text.trim()
  if (STANDARD.has(value.toLowerCase())) return { fromSize: null, toSize: null }
  const match = /^([A-Za-z0-9._]+)\s*(?:-|>|→|->)\s*([A-Za-z0-9._]+)$/.exec(value)
  if (!match) return null
  return { fromSize: match[1]!.toUpperCase(), toSize: match[2]!.toUpperCase() }
}

/** A step as the sheet writes it back. */
export const stepText = (step: { readonly fromSize: string | null; readonly toSize: string | null }): string => (step.fromSize === null ? '*' : `${step.fromSize}-${step.toSize}`)

export const gradeRulesImporter = defineImporter({
  key: GRADE_RULES_IMPORTER_KEY,
  label: 'Grade rules',
  description: 'Grade rule steps: the increment of a point of measure from one size to another, or its standard increment.',
  columns: {
    rule: { label: 'Rule', aliases: ['regola', 'codice regola', 'grade rule', 'regola di sviluppo'], required: true, type: cell.code({ max: 60, upper: true }) },
    point: { label: 'Point', aliases: ['punto', 'punto di misura', 'pom', 'point of measure'], required: true, type: cell.code({ max: 40 }) },
    step: { label: 'Step', aliases: ['passo', 'da-a', 'from-to', 'taglie'], required: true, type: cell.text({ max: 30 }), description: '"50-52" from size 50 to size 52, or "*" for the standard increment of every step.' },
    increment: { label: 'Increment', aliases: ['incremento', 'scatto', 'delta'], type: cell.decimal({ precision: 8, scale: 2 }), description: 'In the point\'s unit, negative too; needed for a new step.' },
    ruleName: { label: 'Rule name', aliases: ['nome regola', 'nome'], type: cell.text({ max: RULE_LIMITS.name }), description: 'For a new rule.' },
    scale: { label: 'Size scale', aliases: ['scala', 'scala taglie', 'scale'], type: cell.code({ max: 40, upper: true }), description: 'For a new rule: its size scale by code.' },
    baseSize: { label: 'Base size', aliases: ['taglia base', 'base'], type: cell.code({ max: 10, upper: true }), description: 'For a new rule.' },
    format: { label: 'Format', aliases: ['formato', 'tipo incremento'], type: cell.oneOf(GRADE_FORMATS, { relativo: 'RELATIVE', relative: 'RELATIVE', assoluto: 'ABSOLUTE', absolute: 'ABSOLUTE' }), description: 'For a new rule: RELATIVE (default) or ABSOLUTE.' },
  },
  keyColumns: ['rule', 'point', 'step'],
  batchSize: 200,
  validateRow: (values) => {
    const issues: RowIssue[] = []
    if (!RULE_CODE.test(String(values.rule))) issues.push({ column: 'rule', message: `A rule code is ${RULE_CODE_RULE}.` })
    if (parseStep(String(values.step)) === null) issues.push({ column: 'step', message: 'Write the step as "50-52" (from size 50 to size 52) or "*" (the standard increment).' })
    return issues
  },
  plan: (values, existing) => planStepRow(values, existing),
})

const RECORD = '$record'

/** A step as the import sees it. */
export interface ImportedStep {
  readonly increment: string
}

export function importRecordValues(step: { readonly ruleCode: string; readonly pointCode: string; readonly fromSize: string | null; readonly toSize: string | null; readonly increment: string }): RecordValues {
  const columns: Record<string, CellValue | null> = { rule: step.ruleCode, point: step.pointCode, step: stepText(step), increment: measureText(step.increment) }
  return { ...columns, [RECORD]: JSON.stringify({ increment: measureText(step.increment) } satisfies ImportedStep) }
}

/** What one row does: a new step needs its increment; a known one changes its increment (the rule's own fields stay). */
export function planStepRow(values: RowValues, existing: ExistingRecord | null): RowPlan {
  if (existing === null) {
    if (values.increment === undefined) return { action: 'ERROR', errors: [{ column: 'increment', message: 'The increment is needed for a new step.' }] }
    return { action: 'CREATE', after: values }
  }
  const raw = existing.values[RECORD]
  const record = typeof raw === 'string' ? (JSON.parse(raw) as ImportedStep) : null
  if (values.increment === undefined || (record && sameMeasure(record.increment, String(values.increment)))) return { action: 'UNCHANGED' }
  return { action: 'UPDATE', before: { increment: record?.increment ?? null }, after: { increment: measureText(String(values.increment)) } }
}
