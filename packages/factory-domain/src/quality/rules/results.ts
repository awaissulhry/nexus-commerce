import type { Issue } from '../../core/errors'
import type { SettingSource } from '../release/rules'

/**
 * Result rules (B-W2b-118; design quality.settings qs-results "How results are computed and counted"), pure:
 *
 *   stopAtRejectNumber   stop the sample at the reject number, or finish the whole sample (QHS-023). A plan version's
 *                        own rule wins (B-W2b-97 stopRuleOf); then the company's row, the tenant-wide row, else finish.
 *   benchUndoSeconds     how long a bench scan may be undone, 0 to 300 seconds (0: never); no row: 10.
 *   override reason      always (locked): an overridden result says why (W1's rule; the database refuses one without).
 *
 * Neither setting loosens a protection (a stopped sample has already rejected the lot; an undo is the scan's own author's,
 * within seconds), so neither asks for a fresh code.
 */

export const RESULT_LIMITS = Object.freeze({ benchUndoMin: 0, benchUndoMax: 300, benchUndoDefault: 10 })

export interface ResultsRow {
  readonly stopAtRejectNumber: boolean | null
  readonly benchUndoSeconds: number | null
}

export interface ResultsInForce {
  readonly stopAtRejectNumber: { readonly value: boolean; readonly source: SettingSource }
  readonly benchUndoSeconds: { readonly value: number; readonly source: SettingSource }
}

function inForce<T>(company: T | null | undefined, tenant: T | null | undefined, fallback: T): { value: T; source: SettingSource } {
  if (company !== null && company !== undefined) return { value: company, source: 'COMPANY' }
  if (tenant !== null && tenant !== undefined) return { value: tenant, source: 'TENANT' }
  return { value: fallback, source: 'DEFAULT' }
}

/** What is in force for a company (its row or null) or tenant-wide (`company` undefined: the tenant row alone). */
export function resultsInForce(company: ResultsRow | null | undefined, tenant: ResultsRow | null): ResultsInForce {
  return {
    stopAtRejectNumber: inForce(company?.stopAtRejectNumber, tenant?.stopAtRejectNumber, false),
    benchUndoSeconds: inForce(company?.benchUndoSeconds, tenant?.benchUndoSeconds, RESULT_LIMITS.benchUndoDefault),
  }
}

/** A typed undo window: a whole number of seconds from 0 to 300, or null (follow the wider rule). */
export function benchUndoProblem(value: number | null): Issue | null {
  if (value === null) return null
  if (!Number.isInteger(value) || value < RESULT_LIMITS.benchUndoMin || value > RESULT_LIMITS.benchUndoMax) {
    return { path: 'benchUndoSeconds', message: `The undo window is a whole number of seconds from ${RESULT_LIMITS.benchUndoMin} to ${RESULT_LIMITS.benchUndoMax}.` }
  }
  return null
}

export const RESULTS_FIELDS = ['stopAtRejectNumber', 'benchUndoSeconds'] as const
export type ResultsField = (typeof RESULTS_FIELDS)[number]

export function resultsChanged(before: ResultsRow, after: ResultsRow): ResultsField[] {
  const out: ResultsField[] = []
  if ((before.stopAtRejectNumber ?? null) !== (after.stopAtRejectNumber ?? null)) out.push('stopAtRejectNumber')
  if ((before.benchUndoSeconds ?? null) !== (after.benchUndoSeconds ?? null)) out.push('benchUndoSeconds')
  return out
}
