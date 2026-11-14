import type { FinanceAbilities, Phrase, Tone } from '../../_shared/model'
import type { InvoiceTax, Quarter, QuarterState } from './api'

/**
 * Stamp duty in words, pure (B-W2b-417; design finance.invoices rec:Invoice lines/precheck "stamp duty decided" and page.h
 * "Stamp duty this quarter"): the pre-check's line from the decision's reason and amount, whether the draft's stamp line
 * must be decided again, the quarter's state with its due day and F24 code, and what holds recounting and recording a
 * payment (`finance-invoices-depth`).
 */

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

export interface TaxAbilities {
  /** Codes, declarations, the quarters' recount and payment. */
  manage: boolean
  /** The accountant's switches and a code's confirmation (each with a fresh code). */
  switch: boolean
}

export const taxAbilitiesOf = (permissions: readonly string[]): TaxAbilities => {
  const held = new Set(permissions)
  return { manage: held.has('invoices.tax.manage'), switch: held.has('invoices.tax.switch') }
}

/** The pre-check's line: decided (due and charged, not due, not on this type, not euro) or waiting for the accountant. */
export interface StampLine {
  ok: boolean
  words: Phrase
  /** The draft's stamp line differs from the decision: "Decide again" saves the draft unchanged. */
  again: boolean
}

export function stampLineOf(tax: Pick<InvoiceTax, 'stampDuty' | 'problems'>, amountText: string | null): StampLine {
  const mismatch = tax.problems.some((problem) => problem.code === 'STAMP_DUTY')
  if (mismatch) return { ok: false, words: phrase('stamp.check.mismatch'), again: true }
  const reason = tax.stampDuty.reason
  if (reason === 'DUE') return { ok: true, words: amountText ? phrase('stamp.check.DUE', { amount: amountText }) : phrase('stamp.check.DUE_NO_PRICE'), again: false }
  return { ok: true, words: phrase(`stamp.check.${reason}`), again: false }
}

/** Why "Decide again" is held. */
export const againHeld = (can: FinanceAbilities, busy: boolean): Phrase | null => (!can.manageInvoices ? phrase('held.noManage') : busy ? phrase('held.busy') : null)

export const QUARTER_TONE: Record<QuarterState, Tone> = { OPEN: 'info', TO_PAY: 'warning', LATE: 'danger', PAID: 'success' }

/** The quarter that holds today (the dialog's head), else the year's last. */
export const currentQuarter = (quarters: readonly Quarter[], today: string): Quarter | null => quarters.find((quarter) => quarter.quarterStart <= today && today <= quarter.quarterEnd) ?? quarters.at(-1) ?? null

/** "Q4 2026" in either language (the quarter's number and year). */
export const quarterName = (quarter: Pick<Quarter, 'quarterStart'>): { n: number; year: string } => ({ n: Math.floor((Number(quarter.quarterStart.slice(5, 7)) - 1) / 3) + 1, year: quarter.quarterStart.slice(0, 4) })

/** Why recounting a quarter is held: the right, the switch, paid, busy. */
export function recountHeld(quarter: Pick<Quarter, 'state'>, can: TaxAbilities, stampDutyOn: boolean, busy: boolean): Phrase | null {
  if (!can.manage) return phrase('held.noTaxManage')
  if (!stampDutyOn) return phrase('stamp.held.switchOff')
  if (quarter.state === 'PAID') return phrase('stamp.held.paid')
  if (busy) return phrase('held.busy')
  return null
}

/** Why recording a quarter's payment is held: the right, a quarter still running, never counted, paid, busy. */
export function payHeld(quarter: Pick<Quarter, 'state' | 'id'>, can: TaxAbilities, busy: boolean): Phrase | null {
  if (!can.manage) return phrase('held.noTaxManage')
  if (quarter.state === 'PAID') return phrase('stamp.held.paid')
  if (quarter.state === 'OPEN') return phrase('stamp.held.running')
  if (!quarter.id) return phrase('stamp.held.neverCounted')
  if (busy) return phrase('held.busy')
  return null
}

/** The day typed for a payment: after the quarter ended, not in the future (the API checks again). */
export function paidOnProblem(paidOn: string, quarter: Pick<Quarter, 'quarterEnd'>, today: string): Phrase | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) return phrase('stamp.payProblem.day')
  if (paidOn <= quarter.quarterEnd) return phrase('stamp.payProblem.beforeEnd')
  if (paidOn > today) return phrase('stamp.payProblem.future')
  return null
}

/** The refusal codes of the quarters this step words. */
export const QUARTER_REFUSALS = ['SWITCH_OFF', 'QUARTER_OPEN', 'QUARTER_PAID', 'DATABASE'] as const
