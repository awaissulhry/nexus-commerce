/**
 * FX.4 — value coercion for external-file import into the Amazon flat-file grid.
 *
 * After FX.3 maps an external header onto a flat-file column, the VALUE still
 * has to fit that column's type/enum/limits. This engine coerces a raw external
 * value to the column's shape and reports one of three states so the FX.5
 * preview can colour it:
 *   • ok      — already valid, used as-is
 *   • coerced — changed to become valid (enum option matched, EU number parsed,
 *               boolean canonicalized, whitespace trimmed)
 *   • flagged — could NOT be made valid (unknown enum, unparseable number,
 *               over-length text) — original kept, never silently dropped
 *
 * Deterministic + pure (no DB, no AI). The AI semantic-match for flagged enum
 * cells (e.g. "rosso" → "Red") is a separate async layer in flat-file-coerce-ai.
 */

import type { FlatFileColumn } from './flat-file.service.js'
import { parseLocaleNumber } from '../../lib/parse-locale-number.js'

export type CoerceStatus = 'ok' | 'coerced' | 'flagged'

export interface CoercedCell {
  value: string
  status: CoerceStatus
  changed: boolean
  note?: string
}

export type CoercibleColumn = Pick<FlatFileColumn, 'kind' | 'options' | 'maxLength'>
export type CoercibleColumnWithId = Pick<FlatFileColumn, 'id' | 'kind' | 'options' | 'maxLength'>

// Boolean tokens kept as lowercase (NOT normalized) so accented forms like "sì"
// survive. Covers EN + the EU market languages (IT/DE/FR/ES).
const TRUE_TOKENS = new Set(['true', 't', 'yes', 'y', '1', 'x', 'si', 'sì', 'vero', 'ja', 'wahr', 'oui', 'sí'])
const FALSE_TOKENS = new Set(['false', 'f', 'no', 'n', '0', 'falso', 'nein', 'falsch', 'non'])

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export function coerceValue(raw: unknown, column: CoercibleColumn): CoercedCell {
  const original = raw == null ? '' : String(raw)
  const trimmed = original.trim()
  // Empty cells: nothing to coerce. Required-ness is a pre-flight concern (A5/MT.2).
  if (trimmed === '') return { value: '', status: 'ok', changed: original !== '' }

  const done = (value: string, status: CoerceStatus, note?: string): CoercedCell => ({
    value, status, changed: value !== original, note,
  })

  switch (column.kind) {
    case 'enum': {
      const opts = column.options ?? []
      if (!opts.length) return done(trimmed, 'ok') // free-typed enum (no constrained list)
      const exact = opts.find((o) => o === trimmed)
      if (exact) return done(exact, exact === original ? 'ok' : 'coerced')
      const ci = opts.find((o) => o.toLowerCase() === trimmed.toLowerCase())
      if (ci) return done(ci, 'coerced', `Matched option "${ci}"`)
      const n = norm(trimmed)
      const nm = n ? opts.find((o) => norm(o) === n) : undefined
      if (nm) return done(nm, 'coerced', `Matched option "${nm}"`)
      return done(trimmed, 'flagged', `"${trimmed}" is not a valid option`)
    }
    case 'number': {
      const n = parseLocaleNumber(trimmed)
      if (n == null) return done(trimmed, 'flagged', `"${trimmed}" is not a number`)
      const s = String(n)
      return done(s, s === original ? 'ok' : 'coerced')
    }
    case 'boolean': {
      const t = trimmed.toLowerCase()
      if (TRUE_TOKENS.has(t)) return done('true', original === 'true' ? 'ok' : 'coerced')
      if (FALSE_TOKENS.has(t)) return done('false', original === 'false' ? 'ok' : 'coerced')
      const ci = (column.options ?? []).find((o) => o.toLowerCase() === t)
      if (ci) return done(ci, ci === original ? 'ok' : 'coerced')
      return done(trimmed, 'flagged', `"${trimmed}" is not true/false`)
    }
    default: {
      // 'text' | 'longtext'
      if (column.maxLength && trimmed.length > column.maxLength) {
        return done(trimmed, 'flagged', `Exceeds max length ${column.maxLength} (is ${trimmed.length})`)
      }
      return done(trimmed, trimmed === original ? 'ok' : 'coerced')
    }
  }
}

export interface CellIssue {
  rowIndex: number
  columnId: string
  status: Exclude<CoerceStatus, 'ok'>
  from: string
  to: string
  note?: string
}

export interface CoerceRowsResult {
  rows: Record<string, unknown>[]
  issues: CellIssue[]
  counts: { ok: number; coerced: number; flagged: number }
}

/**
 * Coerce every cell of every row whose key matches a known column. Structural
 * keys (_rowId, product_type, …) and any header that isn't a flat-file column
 * pass through untouched. Non-'ok' cells are reported as issues for the preview.
 */
export function coerceRows(
  rows: Record<string, unknown>[],
  columns: CoercibleColumnWithId[],
): CoerceRowsResult {
  const byId = new Map(columns.map((c) => [c.id, c]))
  const out: Record<string, unknown>[] = []
  const issues: CellIssue[] = []
  let ok = 0, coerced = 0, flagged = 0

  rows.forEach((row, rowIndex) => {
    const next: Record<string, unknown> = { ...row }
    for (const [key, val] of Object.entries(row)) {
      const col = byId.get(key)
      if (!col) continue
      const r = coerceValue(val, col)
      next[key] = r.value
      if (r.status === 'ok') {
        ok++
      } else {
        if (r.status === 'coerced') coerced++
        else flagged++
        issues.push({ rowIndex, columnId: key, status: r.status, from: val == null ? '' : String(val), to: r.value, note: r.note })
      }
    }
    out.push(next)
  })

  return { rows: out, issues, counts: { ok, coerced, flagged } }
}
