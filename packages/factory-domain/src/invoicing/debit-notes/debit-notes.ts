import type { BusinessDate } from '../../core/time'
import type { CreditReason } from '../credit-note/credit-note'
import { formatDateIt } from '../fatturapa/format'

/**
 * The debit note TD05 and the time limit on VAT decreases (B-W2b-401; FIN-071, FIN-073; design finance.invoices "New ▾ debit
 * note", the credit note pop-up's "VAT time-limit warning on decreases"). Pure.
 *
 * Debit note (art. 26 c.1 DPR 633/1972): charges added after an invoice (a later freight, a price raise agreed later) are a
 * TD05 of the same company and customer naming the invoice it adds to (Invoice.debitOfId), numbered from the INVOICE series;
 * the database holds it to an issued TD01 or TD24 dated on or before it.
 *
 * VAT decreases (art. 26 c.2-3): a credit note lowers VAT; when the decrease comes from a later agreement between the parties
 * (a price reduction agreed after the sale) or corrects a billing mistake, it may lower VAT only within one year of the
 * operation; past that the credit note is still issued, without lowering VAT. A return, a cancellation or a deposit paid back
 * has no one-year limit. Both behind the company's switch `selfInvoicesOn` (self-invoices/self-invoices.ts) and UNVERIFIED.
 */

/** The types a debit note may add to (the database's rule). */
export const DEBITABLE_TYPES = ['TD01', 'TD24'] as const

export const DEBIT_REFUSALS = ['NOT_DEBITABLE', 'NOT_ISSUED', 'REJECTED'] as const
export type DebitRefusal = (typeof DEBIT_REFUSALS)[number]

/** What stops a debit note on this invoice, in words (null: it may be made). */
export function debitProblem(invoice: { readonly docType: string; readonly status: string; readonly number: string | null }): { readonly code: DebitRefusal; readonly message: string } | null {
  if (!(DEBITABLE_TYPES as readonly string[]).includes(invoice.docType)) return { code: 'NOT_DEBITABLE', message: `A debit note adds to an invoice (TD01) or a deferred invoice (TD24); this is a ${invoice.docType}.` }
  if (invoice.status === 'DRAFT') return { code: 'NOT_ISSUED', message: 'The invoice is a draft: change its lines instead of making a debit note.' }
  if (invoice.status === 'REJECTED') return { code: 'REJECTED', message: `Invoice ${invoice.number ?? ''} was rejected by SDI and counts as never issued: correct it and send it again instead.`.replace('  ', ' ') }
  return null
}

/** The debit note's Causale (art. 26 c.1): what it adds to. */
export const debitNoteCausale = (debited: { readonly number: string; readonly issueDate: BusinessDate }, text?: string | null): string =>
  `Nota di debito${text && text.trim() !== '' ? `: ${text.trim()}` : ''} - integrazione della fattura n. ${debited.number} del ${formatDateIt(debited.issueDate)} (art. 26 c.1 DPR 633/1972)`.slice(0, 2000)

export const DEBIT_NOTE_RULE = Object.freeze({
  status: 'UNVERIFIED' as const,
  words: 'A debit note adds charges to an issued invoice of the same customer, at the VAT the rules decide for the customer, numbered from the invoice series; the accountant confirms when a debit note is right rather than a new invoice.',
})

// ---- the time limit on VAT decreases (FIN-073) -------------------------------------------------------------------------------

/** The credit reasons that rest on a later agreement or correct a billing mistake: one year (art. 26 c.3). */
const LIMITED_REASONS: ReadonlySet<CreditReason> = new Set(['PRICE_REDUCTION', 'BILLING_ERROR'])
/** The reasons with no one-year limit: a return or a defect (the sale undone in part), a deposit paid back on a cancellation. */
const FREE_REASONS: ReadonlySet<CreditReason> = new Set(['RETURN', 'DEFECT', 'DEPOSIT_REFUND'])

export const VAT_LIMIT_STATES = ['WITHIN', 'BEYOND', 'NO_LIMIT', 'ASK', 'WAITS'] as const
export type VatLimitState = (typeof VAT_LIMIT_STATES)[number]

export interface VatLimitVerdict {
  readonly state: VatLimitState
  /** The last day the decrease may lower VAT (WITHIN, BEYOND, ASK), else null. */
  readonly limitDate: BusinessDate | null
  readonly words: string
}

const plusOneYear = (day: BusinessDate): BusinessDate => {
  const year = Number.parseInt(day.slice(0, 4), 10) + 1
  const rest = day.slice(4)
  // 29 February plus one year: 28 February.
  return rest === '-02-29' ? `${year}-02-28` : `${year}${rest}`
}

/**
 * The time limit on a VAT decrease (UNVERIFIED): from the operation (the earliest DDT of the invoice, else its issue date) to
 * the credit note's date, by its reason. `switchOn` false: not judged (WAITS, in words).
 */
export function vatDecreaseVerdict(input: { readonly switchOn: boolean; readonly reason: CreditReason; readonly operationDate: BusinessDate; readonly creditDate: BusinessDate; readonly waits: string }): VatLimitVerdict {
  if (!input.switchOn) return { state: 'WAITS', limitDate: null, words: input.waits }
  const limitDate = plusOneYear(input.operationDate)
  if (FREE_REASONS.has(input.reason)) {
    return { state: 'NO_LIMIT', limitDate: null, words: 'No one-year limit for this reason: the credit note lowers VAT, within the deadline of the VAT return of the year it arises in (UNVERIFIED).' }
  }
  if (!LIMITED_REASONS.has(input.reason)) {
    return { state: 'ASK', limitDate, words: `Say why the amount is lowered: a decrease agreed later lowers VAT only until ${limitDate} (one year from the operation); a return or a cancellation has no such limit.` }
  }
  if (input.creditDate <= limitDate) return { state: 'WITHIN', limitDate, words: `Within the time limit: an agreed decrease may lower VAT until ${limitDate} (one year from the operation, art. 26 c.3 DPR 633/1972).` }
  return {
    state: 'BEYOND',
    limitDate,
    words: `Beyond the time limit: an agreed decrease lowers VAT only within one year of the operation (until ${limitDate}). The credit note may still be issued for the amount, but it does not lower VAT: ask your accountant before issuing it.`,
  }
}
