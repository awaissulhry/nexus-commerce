'use client'

/**
 * W4.2 — Conditional formatting rules.
 *
 * Per-column rules of the form "when value <op> threshold, paint
 * the cell tint X". Excel / Sheets ship a sprawling rule editor;
 * the bulk-ops grid starts with the rules operators actually need
 * for catalog work:
 *
 *   stock < 5         → red    (low stock alert)
 *   price > €100      → blue   (premium tier)
 *   status = 'DRAFT'  → amber  (pending)
 *
 * Pure functions: rule evaluation has no DOM / React deps. The
 * client owns the rule list (state) + paint mapping; the helpers
 * here just return tone tokens for the cell renderer to apply.
 */

import { readRowValue } from './multi-sort'

export type RuleOp =
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'eq'
  | 'neq'
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'empty'
  | 'notEmpty'

export type RuleTone = 'red' | 'amber' | 'green' | 'blue' | 'slate'

export interface ConditionalRule {
  /** Stable id for React key + persistence. cuid / uuid works fine. */
  id: string
  /** The column the rule operates on. Read via multi-sort.readRowValue
   *  so dot-paths into categoryAttributes / variantAttributes work. */
  columnId: string
  op: RuleOp
  /** Operand for ops that need one. `null` for empty / notEmpty. */
  value: unknown
  tone: RuleTone
  enabled: boolean
}

/**
 * Tailwind classes per tone — the cell renderer composes these onto
 * the existing dirty / cascade / read-only / find-match overlay
 * order. Keep the list short + obviously themable so dark-mode
 * adoption doesn't have to revisit every rule.
 */
export const TONE_CLASSES: Record<RuleTone, string> = {
  red: 'bg-red-50 ring-1 ring-inset ring-red-300',
  amber: 'bg-amber-50 ring-1 ring-inset ring-amber-300',
  green: 'bg-emerald-50 ring-1 ring-inset ring-emerald-300',
  blue: 'bg-blue-50 ring-1 ring-inset ring-blue-300',
  slate: 'bg-slate-100 ring-1 ring-inset ring-slate-300',
}

export const TONE_LABELS: Record<RuleTone, string> = {
  red: 'Red',
  amber: 'Amber',
  green: 'Green',
  blue: 'Blue',
  slate: 'Slate',
}

export const OP_LABELS: Record<RuleOp, string> = {
  lt: '<',
  lte: '≤',
  gt: '>',
  gte: '≥',
  eq: '=',
  neq: '≠',
  contains: 'contains',
  startsWith: 'starts with',
  endsWith: 'ends with',
  empty: 'is empty',
  notEmpty: 'is not empty',
}

/**
 * Single-rule evaluator. Returns true when the rule fires for the
 * cell's value. Numeric comparisons coerce both sides via parseFloat
 * so an operator can write "stock < 5" against a string-typed jsonb
 * column.
 */
export function evaluateRule(
  rule: ConditionalRule,
  cellValue: unknown,
): boolean {
  if (!rule.enabled) return false
  const isEmpty = cellValue === null || cellValue === undefined || cellValue === ''
  if (rule.op === 'empty') return isEmpty
  if (rule.op === 'notEmpty') return !isEmpty
  if (isEmpty) return false
  // Numeric ops
  if (
    rule.op === 'lt' ||
    rule.op === 'lte' ||
    rule.op === 'gt' ||
    rule.op === 'gte'
  ) {
    const a =
      typeof cellValue === 'number' ? cellValue : parseFloat(String(cellValue))
    const b =
      typeof rule.value === 'number'
        ? rule.value
        : parseFloat(String(rule.value))
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false
    if (rule.op === 'lt') return a < b
    if (rule.op === 'lte') return a <= b
    if (rule.op === 'gt') return a > b
    return a >= b
  }
  // Equality + string ops are case-insensitive — operators paste
  // values from various sources and don't expect 'DRAFT' vs 'draft'
  // to silently miss.
  const a = String(cellValue).toLowerCase()
  const b = rule.value === null || rule.value === undefined
    ? ''
    : String(rule.value).toLowerCase()
  if (rule.op === 'eq') return a === b
  if (rule.op === 'neq') return a !== b
  if (rule.op === 'contains') return a.includes(b)
  if (rule.op === 'startsWith') return a.startsWith(b)
  if (rule.op === 'endsWith') return a.endsWith(b)
  return false
}

/**
 * Walk the rule list against a row + return the FIRST matching tone
 * for the named column. First-match-wins (rule order is meaningful)
 * so operators can stack a low-stock red rule above a generic green
 * rule without one drowning the other.
 */
export function tonefor(
  rules: ConditionalRule[],
  row: Record<string, unknown>,
  columnId: string,
): RuleTone | null {
  for (const rule of rules) {
    if (rule.columnId !== columnId) continue
    if (evaluateRule(rule, readRowValue(row, columnId))) {
      return rule.tone
    }
  }
  return null
}

/**
 * Precompute a per-row, per-column tone map for the visible viewport.
 * The cell renderer looks up via this map in O(1) instead of walking
 * the rule list per cell.
 */
export function buildToneMap(
  rules: ConditionalRule[],
  rows: Array<Record<string, unknown>>,
): Map<string, RuleTone> {
  const out = new Map<string, RuleTone>()
  if (rules.length === 0) return out
  // Group enabled rules by columnId to avoid scanning every rule
  // against every row × column.
  const byCol = new Map<string, ConditionalRule[]>()
  for (const rule of rules) {
    if (!rule.enabled) continue
    let arr = byCol.get(rule.columnId)
    if (!arr) {
      arr = []
      byCol.set(rule.columnId, arr)
    }
    arr.push(rule)
  }
  if (byCol.size === 0) return out
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]
    for (const [columnId, colRules] of byCol) {
      const v = readRowValue(row, columnId)
      for (const rule of colRules) {
        if (evaluateRule(rule, v)) {
          out.set(`${r}:${columnId}`, rule.tone)
          break
        }
      }
    }
  }
  return out
}
