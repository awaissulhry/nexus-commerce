/**
 * PES.8 — hold a generated value to the channel's own rules, server-side.
 *
 * Pure, so it is testable and so the same function runs at generation time (to
 * decide whether a draft is offerable) and at approve time (to decide whether
 * it is still offerable, minutes or days later, against caps that may have been
 * re-read from Amazon since).
 *
 * 🔴 A violation is never repaired. Truncating an over-length title to fit
 * would put a value in front of the operator that the model did not write and
 * nobody reviewed — a confident lie with a fresh look. The draft is stored
 * `failed`, the reason travels with it, and the review view shows it as
 * something the model got wrong rather than hiding it.
 */
import type { CellConstraint } from './constraints.js'

export type ViolationKind =
  | 'over_max_length'
  | 'over_max_bytes'
  | 'off_list'
  | 'deprecated_option'
  | 'empty'
  | 'wrong_type'

export interface Violation {
  kind: ViolationKind
  /** `error` = we refuse to offer it; `warn` = offerable, flagged in review. */
  severity: 'error' | 'warn'
  message: string
  limit?: number
  actual?: number
}

/** UTF-8 byte length — what Amazon actually counts. */
export function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/**
 * Validate one generated value against one column's constraints.
 *
 * Severity follows the sheet's own convention (`selectValidation` in the DS):
 * an off-list value WARNS rather than blocks, because the channel's published
 * enum is routinely behind what it will accept — the eBay flat file taught that
 * one. A cap, by contrast, is arithmetic: over is over.
 */
export function validateDraftValue(value: unknown, c: CellConstraint): Violation[] {
  const out: Violation[] = []

  if (Array.isArray(value)) {
    // bulletPoints / keywords arrive as a list; every member faces the cap.
    if (value.length === 0) {
      out.push({ kind: 'empty', severity: 'error', message: 'Model returned an empty list' })
      return out
    }
    value.forEach((v, i) => {
      for (const violation of validateDraftValue(v, c)) {
        out.push({ ...violation, message: `item ${i + 1}: ${violation.message}` })
      }
    })
    return out
  }

  if (value == null) {
    out.push({ kind: 'empty', severity: 'error', message: 'Model returned no value' })
    return out
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    out.push({
      kind: 'wrong_type',
      severity: 'error',
      message: `Model returned ${typeof value}, expected a text value`,
    })
    return out
  }

  const s = String(value)
  if (s.trim() === '') {
    out.push({ kind: 'empty', severity: 'error', message: 'Model returned an empty value' })
    return out
  }

  if (c.maxLength != null && s.length > c.maxLength) {
    out.push({
      kind: 'over_max_length',
      severity: 'error',
      message: `${s.length} of ${c.maxLength} characters${c.capFrom ? ` — the ${c.capFrom} cap` : ''}`,
      limit: c.maxLength,
      actual: s.length,
    })
  }
  if (c.maxBytes != null) {
    const n = byteLength(s)
    if (n > c.maxBytes) {
      out.push({
        kind: 'over_max_bytes',
        severity: 'error',
        message: `${n} of ${c.maxBytes} UTF-8 bytes${c.capFrom ? ` — the ${c.capFrom} cap` : ''}`,
        limit: c.maxBytes,
        actual: n,
      })
    }
  }

  if (c.options && c.options.length > 0) {
    const hit = c.options.find((o) => o.toLowerCase() === s.trim().toLowerCase())
    if (!hit) {
      if (c.mode !== 'open') {
        out.push({
          kind: 'off_list',
          severity: 'warn',
          message: `"${s}" is not in the channel's list — it may be rejected at publish`,
        })
      }
    } else if (c.deprecatedOptions?.includes(hit)) {
      out.push({
        kind: 'deprecated_option',
        severity: 'warn',
        message: `"${hit}" is deprecated on this channel`,
      })
    }
  }

  return out
}

/** True when nothing here stops us offering the value for review. */
export function isOfferable(violations: Violation[]): boolean {
  return !violations.some((v) => v.severity === 'error')
}
