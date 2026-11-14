import type { Issue } from '../../core/errors'
import type { MinorUnits } from '../../core/money'
import { isBusinessDate, type BusinessDate } from '../../core/time'
import { daysBetween } from '../ledger'

/**
 * Ri.Ba. collections (B-W2b-402; FIN-126; design finance.payments ⋯ "Ri.Ba. batch": "Invoices due in the window; total; CBI
 * file", the tile "Ri.Ba. unpaid"; factory-db bank.prisma RibaBatch / RibaItem), pure. Ri.Ba. (ricevuta bancaria) is how
 * most Italian business customers pay: the company presents the instalments due to its bank, the bank collects them from
 * the customers' banks on their due days, and reports the ones that came back unpaid (insoluti).
 *
 *   batch     a DRAFT per company, collecting bank account and due window; its items are the MP12 instalments (FatturaPA
 *             ModalitaPagamento Ri.Ba.) of issued TD01/TD24 invoices due in the window, each instalment once and in no
 *             other live batch (a draft's, or an issued one's where it is not settled UNPAID)
 *   issue     the CBI file is made (../cbi/riba.ts) and kept on the batch (a file a person downloads and uploads to the bank's
 *             site): only while the company's Ri.Ba. switch is on (ReceivablesSettings.ribaOn, OFF: GATE-ACCOUNTANT)
 *   settle    each item once, on or after its due day and not after today: PAID (the customer's bank paid: a payment of the
 *             item's amount is recorded for the customer and placed on the invoice) or UNPAID (it came back, with the bank's
 *             fee): the invoice was never closed by the batch, so it is open again for reminders and a later batch, and the
 *             fee is the company's to charge (a debit note a person makes: its VAT is the accountant's)
 * While an item waits for its bank (ISSUED in an issued batch) its invoice's reminders are held: the payment is being
 * processed (FIN-112).
 */

export const RIBA_METHOD = 'MP12'
export const RIBA_BATCH_STATUSES = ['DRAFT', 'ISSUED', 'CANCELLED'] as const
export type RibaBatchStatus = (typeof RIBA_BATCH_STATUSES)[number]
export const RIBA_ITEM_STATUSES = ['ISSUED', 'PAID', 'UNPAID'] as const
export type RibaItemStatus = (typeof RIBA_ITEM_STATUSES)[number]
export const RIBA_SETTLEMENTS = ['PAID', 'UNPAID'] as const
export type RibaSettlement = (typeof RIBA_SETTLEMENTS)[number]

/** The longest due window (the database's 366 days). */
export const MAX_RIBA_WINDOW_DAYS = 366
/** The most instalments one batch or one settlement call takes. */
export const MAX_RIBA_ITEMS = 500
export const MAX_RIBA_TEXT = { note: 2000, reason: 500 } as const

/** One instalment of an invoice's stored payment terms, with its place (1, 2 …), its method and what is still open on it. */
export interface TermInstalment {
  /** Its place in Invoice.paymentTerms.installments, from 1 (the database checks the item against installments[n − 1]). */
  readonly instalment: number
  readonly dueDate: BusinessDate
  readonly amount: MinorUnits
  readonly method: string | null
  /** What is still open on it once the settled part paid the oldest instalments first (as the ledger counts it). */
  readonly open: MinorUnits
}

/**
 * The instalments of an invoice's stored terms as they are (each with a due day and an amount; none when one lacks either),
 * with what is open on each: `settled` (credited + allocated + written off) pays the oldest due days first.
 */
export function termInstalmentsOf(paymentTerms: unknown, settled: MinorUnits): TermInstalment[] {
  const raw = paymentTerms && typeof paymentTerms === 'object' ? (paymentTerms as { installments?: unknown }).installments : null
  if (!Array.isArray(raw)) return []
  const read = raw.map((entry, index) => {
    const value = entry && typeof entry === 'object' ? (entry as { amount?: unknown; dueDate?: unknown; method?: unknown }) : {}
    return {
      instalment: index + 1,
      amount: Number.isSafeInteger(value.amount) && (value.amount as number) > 0 ? (value.amount as number) : null,
      dueDate: typeof value.dueDate === 'string' && isBusinessDate(value.dueDate) ? value.dueDate : null,
      method: typeof value.method === 'string' ? value.method : null,
    }
  })
  if (read.some((entry) => entry.amount === null || entry.dueDate === null)) return []
  let left = Math.max(0, settled)
  const open = new Map<number, number>()
  for (const entry of [...read].sort((a, b) => a.dueDate!.localeCompare(b.dueDate!) || a.instalment - b.instalment)) {
    const paid = Math.min(entry.amount!, left)
    left -= paid
    open.set(entry.instalment, entry.amount! - paid)
  }
  return read.map((entry) => ({ instalment: entry.instalment, dueDate: entry.dueDate!, amount: entry.amount!, method: entry.method, open: open.get(entry.instalment)! }))
}

/** The Ri.Ba. instalments due in a window that are still open (candidates before the live-batch check). */
export function ribaInstalmentsDue(instalments: readonly TermInstalment[], window: { readonly dueFrom: BusinessDate; readonly dueTo: BusinessDate }): TermInstalment[] {
  return instalments.filter((entry) => entry.method === RIBA_METHOD && entry.open > 0 && entry.dueDate >= window.dueFrom && entry.dueDate <= window.dueTo)
}

/** The window's problems (empty when it may be a batch's). */
export function windowProblems(dueFrom: BusinessDate, dueTo: BusinessDate, path = 'body'): Issue[] {
  if (dueFrom > dueTo) return [{ path: `${path}/dueTo`, message: 'The window ends on or after the day it starts.' }]
  if (daysBetween(dueFrom, dueTo) > MAX_RIBA_WINDOW_DAYS) return [{ path: `${path}/dueTo`, message: `A batch's due window is at most ${MAX_RIBA_WINDOW_DAYS} days.` }]
  return []
}

/** Why an item may not be settled so (null: it may). */
export function settleProblem(item: { readonly status: RibaItemStatus; readonly dueDate: BusinessDate }, settlement: { readonly status: RibaSettlement; readonly settledOn: BusinessDate; readonly unpaidFee?: MinorUnits | null | undefined }, today: BusinessDate): RibaRefusal | null {
  if (item.status !== 'ISSUED') return 'SETTLED'
  if (settlement.settledOn < item.dueDate) return 'BEFORE_DUE'
  if (settlement.settledOn > today) return 'FUTURE_DAY'
  if (settlement.status === 'PAID' && settlement.unpaidFee !== undefined && settlement.unpaidFee !== null) return 'FEE_ON_PAID'
  if (settlement.status === 'UNPAID' && (settlement.unpaidFee === undefined || settlement.unpaidFee === null || !Number.isSafeInteger(settlement.unpaidFee) || settlement.unpaidFee < 0)) return 'FEE_NEEDED'
  return null
}

/** The bank reference of the payment a PAID item records (unique per company: a receipt is counted once). */
export const ribaPaymentReference = (itemId: string): string => `RIBA-${itemId.toUpperCase()}`

export const RIBA_REFUSALS = {
  SWITCHED_OFF:
    "Ri.Ba. is switched off for this company: the batch can be prepared, its file is made only once the Owner switches Ri.Ba. on (after the bank and the accountant confirm the CBI file).",
  NOT_DRAFT: 'Only a draft batch changes: an issued batch is with the bank, a cancelled one is final.',
  NOT_ISSUED: 'Its items are settled once the batch is issued (its file made for the bank).',
  NO_ITEMS: 'A batch is issued with at least one instalment.',
  NOT_RIBA: 'Ri.Ba. collects the instalments whose payment method is Ri.Ba. (MP12) on an issued invoice (TD01 or TD24).',
  NOT_OPEN: 'Nothing is open on this instalment any more (paid or credited).',
  OUTSIDE_WINDOW: "The instalment is not due in the batch's window.",
  IN_ANOTHER_BATCH: 'This instalment is already collected by another batch (a draft, or an issued one where it did not come back unpaid).',
  NO_ACCOUNT: 'Choose the bank account that collects: the company has no live one, or more than one.',
  ACCOUNT_OFF: 'This bank account is switched off: choose a live one.',
  ACCOUNT_NOT_ITALIAN: 'Ri.Ba. collects through an Italian bank account (an IT IBAN).',
  CURRENCY: 'Ri.Ba. collects in euro.',
  DEBTOR_NOT_ITALIAN: 'Ri.Ba. collects from customers in Italy (an Italian address on the invoice).',
  NO_DEBTOR_BANK: "The customer's bank is not known: give its ABI and CAB (or its IBAN) for this customer.",
  FILE_DATA: 'The CBI file cannot be written: something it needs is missing (see the problems).',
  SETTLED: 'This instalment is settled already: it never changes.',
  BEFORE_DUE: 'An instalment is settled on or after its due day.',
  FUTURE_DAY: 'The day it was paid or came back has not come yet.',
  FEE_ON_PAID: 'Only an instalment that came back unpaid carries the bank’s fee.',
  FEE_NEEDED: 'An unpaid return carries the bank’s fee (0 when there was none).',
  NOT_IN_BATCH: 'This item is not one of the batch’s.',
} as const
export type RibaRefusal = keyof typeof RIBA_REFUSALS
