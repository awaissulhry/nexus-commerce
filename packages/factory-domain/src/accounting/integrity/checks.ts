import { totalsAddUp, type TotalsFacts } from '../checks'
import { fingerprint } from '../manifest'
import type { AccountingPackage } from '../packages'
import type { BusinessDate } from '../../core/time'
import { balanceOf, type JournalEntry } from '../journals/entries'

/**
 * The named integrity checks (B-W2b-408; FIN-157; design finance.accounting "2 · Checks": "totals equal row sums",
 * "placements never exceed payments"; plan §10: run nightly, the results kept, the export reads the last run), pure.
 * apps/factory-api modules/accounting/integrity runs them per company every night through the clustered scheduler (or
 * now, by a person) over the documents of a window of months, and keeps one IntegrityCheckRun per check and run (append-
 * only): PASSED, FAILED with the count and the first 100 records ({ recordType, recordId, code }), or ERROR with why.
 *
 *   INVOICE_TOTALS_EQUAL_LINES           every issued invoice's totals are its VAT summary's sums (SUMMARY) and its lines'
 *                                        net amounts plus the roundings make its net total (LINES)
 *   SUPPLIER_INVOICE_TOTALS_EQUAL_LINES  every supplier invoice's totals are its VAT summary's sums and gross = net + VAT
 *                                        (+ the stamp duty it charges) (SUMMARY); its lines add up to its net (LINES)
 *   ALLOCATIONS_WITHIN_PAYMENTS          no payment is placed, refunded and written off beyond its amount (PAYMENT); no
 *                                        invoice is paid beyond its gross less its credit notes (INVOICE)
 *   PAYMENTS_PLACED                      every payment received is wholly placed, refunded or written off (NOT_PLACED)
 *   LEDGER_BALANCES                      every journal entry's debits equal its credits (UNBALANCED): totals that are not
 *                                        the sums of their lines would hand the accountant an entry that does not balance
 *   EXPORTED_DOCUMENTS_UNCHANGED         no document handed over in an accounting export changed since (CHANGED_AFTER_EXPORT):
 *                                        the latest handing-over of each is flagged once, and a re-export carries it
 */

export const INTEGRITY_CHECK_CODES = [
  'INVOICE_TOTALS_EQUAL_LINES',
  'SUPPLIER_INVOICE_TOTALS_EQUAL_LINES',
  'ALLOCATIONS_WITHIN_PAYMENTS',
  'PAYMENTS_PLACED',
  'LEDGER_BALANCES',
  'EXPORTED_DOCUMENTS_UNCHANGED',
] as const
export type IntegrityCheckCode = (typeof INTEGRITY_CHECK_CODES)[number]

export const INTEGRITY_FAILURE_CODES = ['SUMMARY', 'LINES', 'PAYMENT', 'INVOICE', 'NOT_PLACED', 'UNBALANCED', 'CHANGED_AFTER_EXPORT'] as const
export type IntegrityFailureCode = (typeof INTEGRITY_FAILURE_CODES)[number]

export const INTEGRITY_RESULTS = ['PASSED', 'FAILED', 'ERROR'] as const
export type IntegrityResult = (typeof INTEGRITY_RESULTS)[number]

export const INTEGRITY_TITLES: Readonly<Record<IntegrityCheckCode, { readonly en: string; readonly it: string }>> = Object.freeze({
  INVOICE_TOTALS_EQUAL_LINES: { en: "Invoices' totals equal their lines", it: 'Totali delle fatture uguali alle righe' },
  SUPPLIER_INVOICE_TOTALS_EQUAL_LINES: { en: "Supplier invoices' totals equal their lines", it: 'Totali delle fatture fornitori uguali alle righe' },
  ALLOCATIONS_WITHIN_PAYMENTS: { en: 'Placements never exceed payments', it: 'Abbinamenti entro gli incassi' },
  PAYMENTS_PLACED: { en: 'Payments placed', it: 'Incassi abbinati' },
  LEDGER_BALANCES: { en: 'Journal entries balance', it: 'Le scritture quadrano' },
  EXPORTED_DOCUMENTS_UNCHANGED: { en: 'Exported documents unchanged', it: 'Documenti esportati non modificati' },
})

/** The months a nightly run reads: this month and the twelve before (older months are the accountant's, mostly closed). */
export const INTEGRITY_WINDOW_MONTHS = 13
/** The failures a run keeps (the database's limit). */
export const FAILURES_KEPT = 100

/** The first day of the window that ends with `today`'s month. */
export function windowStart(today: BusinessDate, months: number = INTEGRITY_WINDOW_MONTHS): BusinessDate {
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7)) - (months - 1)
  const back = new Date(Date.UTC(year, month - 1, 1))
  return back.toISOString().slice(0, 10)
}

export interface IntegrityFailure {
  readonly recordType: string
  readonly recordId: string
  readonly code: IntegrityFailureCode
}

export interface IntegrityOutcome {
  readonly code: IntegrityCheckCode
  readonly result: IntegrityResult
  readonly failureCount: number
  /** At most FAILURES_KEPT. */
  readonly failures: readonly IntegrityFailure[]
  readonly errorWords: string | null
}

export function outcomeOf(code: IntegrityCheckCode, failures: readonly IntegrityFailure[]): IntegrityOutcome {
  return failures.length === 0
    ? { code, result: 'PASSED', failureCount: 0, failures: [], errorWords: null }
    : { code, result: 'FAILED', failureCount: failures.length, failures: failures.slice(0, FAILURES_KEPT), errorWords: null }
}

export const errorOutcome = (code: IntegrityCheckCode, words: string): IntegrityOutcome => ({ code, result: 'ERROR', failureCount: 0, failures: [], errorWords: words.slice(0, 2000) || 'The check could not run.' })

// ---- the checks ---------------------------------------------------------------------------------------------------------

export interface InvoiceTotalsFacts extends TotalsFacts {
  /** Σ its lines' net amounts. */
  readonly linesNet: number
  /** Σ its VAT summary's roundings. */
  readonly rounding: number
}

export function invoiceTotalsCheck(invoices: readonly InvoiceTotalsFacts[]): IntegrityOutcome {
  const failures: IntegrityFailure[] = []
  for (const invoice of invoices) {
    if (!totalsAddUp(invoice)) failures.push({ recordType: 'Invoice', recordId: invoice.id, code: 'SUMMARY' })
    else if (invoice.linesNet + invoice.rounding !== invoice.netTotal) failures.push({ recordType: 'Invoice', recordId: invoice.id, code: 'LINES' })
  }
  return outcomeOf('INVOICE_TOTALS_EQUAL_LINES', failures)
}

export interface SupplierTotalsFacts {
  readonly id: string
  readonly netTotal: number
  readonly vatTotal: number
  readonly grossTotal: number
  readonly stampDutyAmount: number | null
  readonly vatSummary: unknown
  /** Σ its lines' net amounts, or null: it has no lines (typed with its totals only). */
  readonly linesNet: number | null
}

export function supplierTotalsCheck(invoices: readonly SupplierTotalsFacts[]): IntegrityOutcome {
  const failures: IntegrityFailure[] = []
  for (const invoice of invoices) {
    const summaryOk = totalsAddUp({ id: invoice.id, number: '', netTotal: invoice.netTotal, vatTotal: invoice.vatTotal, grossTotal: invoice.grossTotal, stampDutyAmount: invoice.stampDutyAmount, vatSummary: invoice.vatSummary })
    // A supplier invoice with no VAT summary (typed by hand) is checked by its gross alone.
    const typed = Array.isArray(invoice.vatSummary) && invoice.vatSummary.length === 0
    const grossOk = invoice.grossTotal === invoice.netTotal + invoice.vatTotal || invoice.grossTotal === invoice.netTotal + invoice.vatTotal + (invoice.stampDutyAmount ?? 0)
    if (!(typed ? grossOk : summaryOk)) failures.push({ recordType: 'SupplierInvoice', recordId: invoice.id, code: 'SUMMARY' })
    else if (invoice.linesNet !== null && invoice.linesNet !== invoice.netTotal) failures.push({ recordType: 'SupplierInvoice', recordId: invoice.id, code: 'LINES' })
  }
  return outcomeOf('SUPPLIER_INVOICE_TOTALS_EQUAL_LINES', failures)
}

export interface PaymentUseFacts {
  readonly id: string
  readonly amount: number
  /** Σ its allocations, reversals taken off. */
  readonly placed: number
  /** Σ its live refunds. */
  readonly refunded: number
  /** Σ its OVERPAYMENT write-offs still standing. */
  readonly writtenOff: number
}

export interface InvoicePaidFacts {
  readonly id: string
  /** Its gross total less its issued credit notes. */
  readonly payable: number
  readonly allocated: number
  /** Σ the UNDERPAYMENT write-offs on its allocations. */
  readonly writtenOff: number
}

export function allocationsCheck(payments: readonly PaymentUseFacts[], invoices: readonly InvoicePaidFacts[]): IntegrityOutcome {
  const failures: IntegrityFailure[] = [
    ...payments.filter((payment) => payment.placed < 0 || payment.placed + payment.refunded + payment.writtenOff > payment.amount).map((payment) => ({ recordType: 'Payment', recordId: payment.id, code: 'PAYMENT' as const })),
    ...invoices.filter((invoice) => invoice.allocated < 0 || invoice.allocated + invoice.writtenOff > invoice.payable).map((invoice) => ({ recordType: 'Invoice', recordId: invoice.id, code: 'INVOICE' as const })),
  ]
  return outcomeOf('ALLOCATIONS_WITHIN_PAYMENTS', failures)
}

export function paymentsPlacedCheck(payments: readonly PaymentUseFacts[]): IntegrityOutcome {
  return outcomeOf(
    'PAYMENTS_PLACED',
    payments.filter((payment) => payment.amount - payment.placed - payment.refunded - payment.writtenOff > 0).map((payment) => ({ recordType: 'Payment', recordId: payment.id, code: 'NOT_PLACED' as const })),
  )
}

export function ledgerCheck(entries: readonly JournalEntry[]): IntegrityOutcome {
  return outcomeOf(
    'LEDGER_BALANCES',
    entries
      .filter((entry) => {
        const { debit, credit } = balanceOf(entry)
        return debit !== credit
      })
      .map((entry) => ({ recordType: entry.recordType, recordId: entry.recordId, code: 'UNBALANCED' as const })),
  )
}

// ---- exported documents (FIN-154) ---------------------------------------------------------------------------------------

/**
 * A document's fingerprint as an export hands it over (ExportedDocument.fingerprint): the packages it was carried in with
 * each package's fingerprint of its rows, so a document carried by two packages (an invoice in the sales journal and the
 * VAT registers) is ONE handed-over document, and a change in either is a change of it.
 */
export function handedOverFingerprint(parts: readonly { readonly package: AccountingPackage; readonly hash: string }[]): string {
  return fingerprint([...parts].sort((a, b) => a.package.localeCompare(b.package)).map((part) => [part.package, part.hash]))
}

/** The fingerprint a document has when it left every package it was carried in (no rows any more). */
export const GONE_FINGERPRINT = 'gone'

export function exportedDocumentsCheck(changed: readonly { readonly recordType: string; readonly recordId: string }[]): IntegrityOutcome {
  return outcomeOf(
    'EXPORTED_DOCUMENTS_UNCHANGED',
    changed.map((document) => ({ recordType: document.recordType, recordId: document.recordId, code: 'CHANGED_AFTER_EXPORT' as const })),
  )
}

/** A check's words for the screens' tooltip and the logs (the screens say them in their own words by the codes). */
export function integrityWords(outcome: Pick<IntegrityOutcome, 'code' | 'result' | 'failureCount' | 'errorWords'>): string {
  const title = INTEGRITY_TITLES[outcome.code].en
  if (outcome.result === 'PASSED') return `${title}: passed.`
  if (outcome.result === 'ERROR') return `${title}: could not run (${outcome.errorWords ?? 'no reason given'}).`
  return `${title}: ${outcome.failureCount} record(s) fail it.`
}
