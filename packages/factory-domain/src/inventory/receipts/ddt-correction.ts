import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { RECEIPT_LIMITS } from './rules'

/**
 * Correcting the supplier's DDT number and date on a posted goods receipt (B-W2b-14; B-W2a-31's follow-up; SCM-115),
 * pure. The receipt's goods, lots and moves never change once POSTED; the supplier's transport document reference does
 * when it was typed wrong (a digit swapped, the date of the order instead of the DDT's), because the supplier invoice is
 * matched on it (B-W2a-62) and the discrepancy report and claims name it. apps/factory-api's
 * modules/inventory/receipts/ddt-correction.ts writes it in ONE command; the W2b factory_goods_receipt_guard holds the
 * same rule for every login: on a POSTED receipt the number or date changes only with a new, later correction (when, by
 * whom, why), and a correction comes only with such a change. Every correction keeps its audit row (the before and the
 * after); the receipt keeps the latest one.
 */

export const DDT_CORRECTION_LIMITS = Object.freeze({ reason: 500, number: RECEIPT_LIMITS.code })

export interface DdtCorrectionFacts {
  readonly number: string
  readonly status: 'OPEN' | 'POSTED' | 'REVERSED' | 'CANCELLED'
  readonly supplierDdtNumber: string | null
  readonly supplierDdtDate: BusinessDate | null
}

export interface DdtCorrectionInput {
  readonly supplierDdtNumber: string | null
  readonly supplierDdtDate: BusinessDate | null
  readonly reason: string
}

/** Why the receipt's DDT cannot be corrected now (409 words), or null. */
export function ddtCorrectionStateProblem(facts: Pick<DdtCorrectionFacts, 'number' | 'status'>): string | null {
  if (facts.status === 'POSTED') return null
  if (facts.status === 'OPEN') return `Receipt ${facts.number} is still open: its supplier DDT is set when it is posted, not corrected.`
  return `Receipt ${facts.number} is ${facts.status.toLowerCase()}: its supplier DDT no longer changes.`
}

const blank = (value: string | null | undefined): string | null => (value === null || value === undefined || value.trim() === '' ? null : value.trim())

/**
 * What is wrong with a correction (400 paths under `body`): a reason of a few words, a number or a date that differs from
 * what the receipt holds now, a number within the limit, a date not after `today` (a DDT is never dated in the future).
 */
export function ddtCorrectionProblems(facts: DdtCorrectionFacts, input: DdtCorrectionInput, today: BusinessDate): Issue[] {
  const problems: Issue[] = []
  const number = blank(input.supplierDdtNumber)
  const reason = blank(input.reason)
  if (reason === null || reason.length < 3) problems.push({ path: 'body/reason', message: 'Say why the DDT number or date is corrected (a few words).' })
  else if (reason.length > DDT_CORRECTION_LIMITS.reason) problems.push({ path: 'body/reason', message: `At most ${DDT_CORRECTION_LIMITS.reason} characters.` })
  if (number !== null && number.length > DDT_CORRECTION_LIMITS.number) problems.push({ path: 'body/supplierDdtNumber', message: `At most ${DDT_CORRECTION_LIMITS.number} characters.` })
  if (input.supplierDdtDate !== null && input.supplierDdtDate > today) problems.push({ path: 'body/supplierDdtDate', message: 'A DDT is never dated after today.' })
  if (input.supplierDdtDate !== null && number === null) problems.push({ path: 'body/supplierDdtNumber', message: 'A DDT date goes with its number.' })
  if (number === facts.supplierDdtNumber && input.supplierDdtDate === facts.supplierDdtDate) problems.push({ path: 'body/supplierDdtNumber', message: `Receipt ${facts.number} names this DDT already: change the number or the date.` })
  return problems
}

/** The correction as written: the number trimmed (null: none), the date, the reason trimmed. */
export function ddtCorrectionValues(input: DdtCorrectionInput): { readonly supplierDdtNumber: string | null; readonly supplierDdtDate: BusinessDate | null; readonly reason: string } {
  return { supplierDdtNumber: blank(input.supplierDdtNumber), supplierDdtDate: input.supplierDdtDate, reason: (blank(input.reason) ?? '').slice(0, DDT_CORRECTION_LIMITS.reason) }
}
