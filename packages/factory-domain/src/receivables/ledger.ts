import type { MinorUnits } from '../core/money'
import { isBusinessDate, type BusinessDate } from '../core/time'

/**
 * The customer ledger, its statement and the ageing of what is open (B-W2a-55; FIN-109, FIN-110; design
 * finance.receivables "What customers owe", "By customer" and the pop-up "statement": "Opening balance + invoices −
 * payments − credits = running balance"), pure. Amounts are minor units of the document's currency (the price grain).
 *
 * The ledger of a customer in one company (partitario cliente) is its money movements in date order:
 *   INVOICE       an issued TD01, TD24 or TD02 (the deposit invoice), on its issue date: what the customer owes (debit)
 *   CREDIT_NOTE   an issued TD04, on its issue date: what it no longer owes (credit)
 *   PAYMENT       a payment received (RECEIVED; a VOIDED one was typed by mistake and is not money), on the day it
 *                 arrived: credit, whatever it was allocated to
 *   REFUND        money paid back to the customer (a PAID refund, on the day it left the bank): debit
 * The balance is debits − credits: above 0 the customer owes the company, below 0 the company holds the customer's money
 * (a credit on account). A draft invoice is no money yet.
 *
 * What is open is counted per invoice and per instalment of its payment terms (FatturaPA DatiPagamento): a TD01/TD24's
 * gross total less its issued credit notes and the payments allocated to it, spread over its instalments oldest first.
 * Each open instalment is aged by its due date (days late as of the day asked): not due yet, 1–30, 31–60, 61–90, over 90.
 * An invoice without a due date is due on its date (said so: `dueDateKnown` false).
 */

/** Calendar days from one business date to another (to − from). */
export function daysBetween(from: BusinessDate, to: BusinessDate): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number]
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number]
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000)
}

/** The business date N calendar days from a date (negative: before). */
export function addDays(date: BusinessDate, days: number): BusinessDate {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

// ---- instalments and what is open on them --------------------------------------------------------------------------------

export interface Instalment {
  readonly dueDate: BusinessDate
  readonly amount: MinorUnits
}

export interface InvoiceInstalments {
  readonly instalments: readonly Instalment[]
  /** False when the invoice names no due date: it is due on its own date. */
  readonly dueDateKnown: boolean
}

/**
 * An invoice's instalments from its stored payment terms (Invoice.paymentTerms: `{ condition, installments: [{ amount,
 * dueDate }] }`): used as they are when each has a due date and they add up to the gross total; else one instalment of
 * the whole gross on the latest due date named, or on the invoice's own date when none is.
 */
export function instalmentsOf(paymentTerms: unknown, gross: MinorUnits, issueDate: BusinessDate): InvoiceInstalments {
  const raw = paymentTerms && typeof paymentTerms === 'object' ? (paymentTerms as { installments?: unknown }).installments : null
  const entries = Array.isArray(raw) ? raw : []
  const read = entries.map((entry) => {
    const value = entry && typeof entry === 'object' ? (entry as { amount?: unknown; dueDate?: unknown }) : {}
    return {
      amount: Number.isSafeInteger(value.amount) && (value.amount as number) >= 0 ? (value.amount as number) : null,
      dueDate: typeof value.dueDate === 'string' && isBusinessDate(value.dueDate) ? value.dueDate : null,
    }
  })
  const dated = read.filter((entry) => entry.dueDate !== null)
  if (read.length > 0 && dated.length === read.length && read.every((entry) => entry.amount !== null) && read.reduce((sum, entry) => sum + entry.amount!, 0) === gross) {
    return { instalments: [...read].sort((a, b) => a.dueDate!.localeCompare(b.dueDate!)).map((entry) => ({ dueDate: entry.dueDate!, amount: entry.amount! })), dueDateKnown: true }
  }
  const latest = dated.map((entry) => entry.dueDate!).sort().at(-1) ?? null
  return { instalments: [{ dueDate: latest ?? issueDate, amount: gross }], dueDateKnown: latest !== null }
}

export interface OpenInstalment extends Instalment {
  /** What is still open on it (the settled part paid the oldest instalments first). */
  readonly open: MinorUnits
}

/** What is open on each instalment once `settled` (credited + allocated) has paid the oldest ones first. */
export function openInstalments(instalments: readonly Instalment[], settled: MinorUnits): OpenInstalment[] {
  let left = Math.max(0, settled)
  return instalments.map((instalment) => {
    const paid = Math.min(instalment.amount, left)
    left -= paid
    return { ...instalment, open: instalment.amount - paid }
  })
}

/** The due date the ladder follows: the oldest instalment still open (null: nothing is open). */
export const firstOpenDueDate = (instalments: readonly OpenInstalment[]): BusinessDate | null => instalments.find((instalment) => instalment.open > 0)?.dueDate ?? null

// ---- ageing ----------------------------------------------------------------------------------------------------------------

/** The ageing buckets by days late (design "What customers owe": Open · Overdue · 0–30 · 31–60 · 61–90 · Over 90 days). */
export const AGEING_BUCKETS = ['NOT_DUE', 'D1_30', 'D31_60', 'D61_90', 'OVER_90'] as const
export type AgeingBucket = (typeof AGEING_BUCKETS)[number]
export const OVERDUE_BUCKETS: readonly AgeingBucket[] = ['D1_30', 'D31_60', 'D61_90', 'OVER_90']

export const BUCKET_WORDS: Readonly<Record<AgeingBucket, { readonly en: string; readonly it: string }>> = Object.freeze({
  NOT_DUE: { en: 'Not due yet', it: 'Non ancora scaduto' },
  D1_30: { en: '1–30 days late', it: 'Scaduto da 1–30 giorni' },
  D31_60: { en: '31–60 days late', it: 'Scaduto da 31–60 giorni' },
  D61_90: { en: '61–90 days late', it: 'Scaduto da 61–90 giorni' },
  OVER_90: { en: 'Over 90 days late', it: 'Scaduto da oltre 90 giorni' },
})

/** The bucket of an amount due on `dueDate`, as of `asOf` (due today is not late yet). */
export function bucketOf(dueDate: BusinessDate, asOf: BusinessDate): AgeingBucket {
  const late = daysBetween(dueDate, asOf)
  if (late <= 0) return 'NOT_DUE'
  if (late <= 30) return 'D1_30'
  if (late <= 60) return 'D31_60'
  if (late <= 90) return 'D61_90'
  return 'OVER_90'
}

export interface AgeingTotals {
  open: MinorUnits
  overdue: MinorUnits
  buckets: Record<AgeingBucket, MinorUnits>
}

export const emptyAgeing = (): AgeingTotals => ({ open: 0, overdue: 0, buckets: { NOT_DUE: 0, D1_30: 0, D31_60: 0, D61_90: 0, OVER_90: 0 } })

/** Adds the open instalments of one invoice to the totals, as of a day. */
export function addToAgeing(totals: AgeingTotals, instalments: readonly OpenInstalment[], asOf: BusinessDate): AgeingTotals {
  for (const instalment of instalments) {
    if (instalment.open <= 0) continue
    const bucket = bucketOf(instalment.dueDate, asOf)
    totals.open += instalment.open
    totals.buckets[bucket] += instalment.open
    if (bucket !== 'NOT_DUE') totals.overdue += instalment.open
  }
  return totals
}

/** Adds one ageing into another (the tiles over the customers). */
export function mergeAgeing(into: AgeingTotals, from: AgeingTotals): AgeingTotals {
  into.open += from.open
  into.overdue += from.overdue
  for (const bucket of AGEING_BUCKETS) into.buckets[bucket] += from.buckets[bucket]
  return into
}

// ---- the ledger and the statement -------------------------------------------------------------------------------------------

export const MOVEMENT_KINDS = ['INVOICE', 'CREDIT_NOTE', 'PAYMENT', 'REFUND'] as const
export type MovementKind = (typeof MOVEMENT_KINDS)[number]
const DEBIT_KINDS: ReadonlySet<MovementKind> = new Set(['INVOICE', 'REFUND'])

export interface Movement {
  readonly kind: MovementKind
  readonly date: BusinessDate
  readonly recordType: 'Invoice' | 'Payment' | 'Refund'
  readonly recordId: string
  /** The document's number as printed (an invoice or credit note), or the bank reference of a payment or refund. */
  readonly reference: string | null
  /** TD01 | TD02 | TD04 | TD24 for an invoice or credit note. */
  readonly docType: string | null
  readonly dueDate: BusinessDate | null
  /** Above 0: debit or credit by its kind. */
  readonly amount: MinorUnits
}

export interface StatementLine extends Movement {
  readonly debit: MinorUnits
  readonly credit: MinorUnits
  /** The running balance after this line. */
  readonly balance: MinorUnits
}

export interface Statement {
  readonly from: BusinessDate
  readonly to: BusinessDate
  /** The balance before `from` (every movement dated earlier). */
  readonly opening: MinorUnits
  readonly lines: readonly StatementLine[]
  readonly closing: MinorUnits
  readonly totals: { readonly invoiced: MinorUnits; readonly credited: MinorUnits; readonly paid: MinorUnits; readonly refunded: MinorUnits }
}

const KIND_ORDER: Readonly<Record<MovementKind, number>> = { INVOICE: 0, CREDIT_NOTE: 1, PAYMENT: 2, REFUND: 3 }

/** The movements in ledger order: by date, then invoices before credit notes, payments and refunds, then by reference. */
export const ledgerOrder = (a: Movement, b: Movement): number =>
  a.date.localeCompare(b.date) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.reference ?? '').localeCompare(b.reference ?? '') || a.recordId.localeCompare(b.recordId)

/** The statement of a period: the opening balance, each movement with the running balance, the closing balance. */
export function statementOf(movements: readonly Movement[], from: BusinessDate, to: BusinessDate): Statement {
  const sorted = [...movements].sort(ledgerOrder)
  let balance = 0
  const totals = { invoiced: 0, credited: 0, paid: 0, refunded: 0 }
  const signed = (movement: Movement): number => (DEBIT_KINDS.has(movement.kind) ? movement.amount : -movement.amount)
  for (const movement of sorted) if (movement.date < from) balance += signed(movement)
  const opening = balance
  const lines: StatementLine[] = []
  for (const movement of sorted) {
    if (movement.date < from || movement.date > to) continue
    balance += signed(movement)
    if (movement.kind === 'INVOICE') totals.invoiced += movement.amount
    else if (movement.kind === 'CREDIT_NOTE') totals.credited += movement.amount
    else if (movement.kind === 'PAYMENT') totals.paid += movement.amount
    else totals.refunded += movement.amount
    lines.push({ ...movement, debit: DEBIT_KINDS.has(movement.kind) ? movement.amount : 0, credit: DEBIT_KINDS.has(movement.kind) ? 0 : movement.amount, balance })
  }
  return { from, to, opening, lines, closing: balance, totals }
}

/** The default period of a statement: from the first day of the year of `to` up to `to`. */
export const defaultStatementFrom = (to: BusinessDate): BusinessDate => `${to.slice(0, 4)}-01-01`

/** At most this many days in one statement (a longer one is asked in parts). */
export const MAX_STATEMENT_DAYS = 3 * 366
