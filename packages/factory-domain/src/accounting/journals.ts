import { isEuMemberState } from '../tax/eu'
import type { ExportCell } from '../views/exports'
import { fingerprint, type ExportDocument, type ManifestEntry } from './manifest'
import type { AccountingPackage } from './packages'

/**
 * The journals of an accounting export, pure (B-W2a-39; design finance.accounting "3 · Contents": sales journal,
 * purchases journal, payments). The API reads the period's documents (`…Facts`); these functions make the file rows
 * (language-neutral cells: words, minor units with their currency, days) and the documents the manifest names, with the
 * fingerprint of exactly those rows. Layout DEFAULT (Q7: the accountant's software and its import layout are not known):
 * one row per document and VAT rate (or nature), the document's totals on each of its rows, a last column with the
 * change against the batches before (NEW, CHANGED, REMOVED).
 *
 *   sales journal      the invoices issued in the month (TD01, TD02 deposit, TD04 credit note, TD24 deferred), by their
 *                      issue date; a draft is not issued and an invoice SDI REJECTED counts as never issued (it is
 *                      corrected and sent again under its number: it comes back then).
 *   purchases journal  the supplier invoices received in the month (receivedOn: the date the period lock reads), not
 *                      voided.
 *   payments           the customers' payments received in the month (not voided), with what they paid (placed) and
 *                      what is left, and the refunds paid in the month.
 */

export type Row = readonly ExportCell[]

/** One document's rows, and its entry for the manifest. */
export interface DocumentRows {
  readonly document: ExportDocument
  readonly rows: readonly Row[]
}

const amount = (minor: number | null | undefined, currency: string): ExportCell => (minor === null || minor === undefined ? null : { minor, currency })
const dayCell = (day: string | null): ExportCell => (day ? { day } : null)

/** A document and its rows, fingerprinted. */
export function documentOf(pkg: AccountingPackage, record: { readonly recordType: string; readonly recordId: string; readonly number: string | null; readonly version: number | null }, rows: readonly Row[]): DocumentRows {
  return { document: { package: pkg, ...record, hash: fingerprint(rows) }, rows }
}

/** The rows of a file: each document's rows with its change, and a row per document that left the period. */
export function fileRows(documents: readonly DocumentRows[], entries: readonly ManifestEntry[] | null, width: number, numberColumn: number): Row[] {
  const changes = new Map((entries ?? []).map((entry) => [`${entry.recordType}|${entry.recordId}`, entry]))
  const out: Row[] = []
  for (const { document, rows } of documents) {
    const change = entries === null ? 'NEW' : changes.get(`${document.recordType}|${document.recordId}`)?.change
    if (!change || change === 'REMOVED') continue
    for (const row of rows) out.push([...row, change])
  }
  for (const entry of entries ?? []) {
    if (entry.change !== 'REMOVED') continue
    const row: ExportCell[] = Array.from({ length: width }, () => null)
    row[numberColumn] = entry.number
    out.push([...row, 'REMOVED'])
  }
  return out
}

// ---- the buyer as an invoice names it (its billTo snapshot) ------------------------------------------------------------

export interface BuyerAsInvoiced {
  readonly kind: 'IT_BUSINESS' | 'IT_CONSUMER' | 'FOREIGN' | null
  readonly name: string
  /** With its country prefix (`IT…`, `DE…`; Greece `EL…` as VIES writes it), or null. */
  readonly vatId: string | null
  readonly fiscalCode: string | null
  readonly country: string | null
}

/** The VIES prefix of a country (Greece is EL there). */
export const viesPrefix = (country: string): string => (country === 'GR' ? 'EL' : country)

/** The buyer of an invoice as its billTo snapshot names it (FatturaPA's buyer, B-W1-50 invoicing/document billToOf). */
export function buyerOfBillTo(billTo: unknown): BuyerAsInvoiced {
  const value = billTo !== null && typeof billTo === 'object' ? (billTo as Record<string, unknown>) : {}
  const text = (key: string): string | null => (typeof value[key] === 'string' && (value[key] as string).trim() !== '' ? (value[key] as string).trim() : null)
  const address = value.address !== null && typeof value.address === 'object' ? (value.address as Record<string, unknown>) : {}
  const addressCountry = typeof address.country === 'string' ? address.country : null
  const name = text('name') ?? [text('firstName'), text('lastName')].filter(Boolean).join(' ')
  switch (value.kind) {
    case 'IT_BUSINESS':
      return { kind: 'IT_BUSINESS', name, vatId: text('vatNumber') ? `IT${text('vatNumber')}` : null, fiscalCode: text('fiscalCode'), country: 'IT' }
    case 'IT_CONSUMER':
      return { kind: 'IT_CONSUMER', name, vatId: null, fiscalCode: text('fiscalCode'), country: 'IT' }
    case 'FOREIGN': {
      const country = text('country') ?? addressCountry
      const taxId = text('taxId')
      return { kind: 'FOREIGN', name, vatId: country && taxId && isEuMemberState(country) ? `${viesPrefix(country)}${taxId}` : taxId, fiscalCode: null, country }
    }
    default:
      return { kind: null, name, vatId: null, fiscalCode: null, country: addressCountry }
  }
}

// ---- sales journal -------------------------------------------------------------------------------------------------------

export interface VatEntry {
  readonly rate: string | null
  readonly nature: string | null
  readonly taxable: number
  readonly vat: number
}

/** A stored VAT summary (Invoice.vatSummary, SupplierInvoice.vatSummary) read back. */
export function vatEntriesOf(value: unknown): VatEntry[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw): VatEntry[] => {
    if (raw === null || typeof raw !== 'object') return []
    const entry = raw as Record<string, unknown>
    if (typeof entry.taxable !== 'number' || typeof entry.vat !== 'number') return []
    return [{ rate: typeof entry.rate === 'string' ? entry.rate : null, nature: typeof entry.nature === 'string' ? entry.nature : null, taxable: entry.taxable, vat: entry.vat }]
  })
}

export interface SalesInvoiceFacts {
  readonly id: string
  readonly number: string
  readonly version: number
  readonly docType: string
  readonly issueDate: string
  readonly currency: string
  readonly netTotal: number
  readonly vatTotal: number
  readonly grossTotal: number
  readonly stampDutyAmount: number | null
  readonly summary: readonly VatEntry[]
  readonly buyerCode: string
  readonly buyer: BuyerAsInvoiced
  /** A credit note: the number of the invoice it credits. */
  readonly creditOfNumber: string | null
}

export const SALES_JOURNAL_HEADINGS = {
  en: ['Number', 'Date', 'Type', 'Customer code', 'Customer', 'VAT ID', 'Fiscal code', 'Country', 'VAT %', 'VAT nature', 'Taxable', 'VAT', 'Invoice total', 'Stamp duty', 'Credits invoice', 'Change'],
  it: ['Numero', 'Data', 'Tipo', 'Codice cliente', 'Cliente', 'Partita IVA', 'Codice fiscale', 'Paese', 'Aliquota IVA', 'Natura IVA', 'Imponibile', 'IVA', 'Totale documento', 'Bollo', 'Nota di credito su', 'Variazione'],
} as const

export function salesJournalDocument(invoice: SalesInvoiceFacts): DocumentRows {
  const entries = invoice.summary.length > 0 ? invoice.summary : [{ rate: null, nature: null, taxable: invoice.netTotal, vat: invoice.vatTotal }]
  const rows = entries.map((entry): Row => [
    invoice.number,
    dayCell(invoice.issueDate),
    invoice.docType,
    invoice.buyerCode,
    invoice.buyer.name,
    invoice.buyer.vatId,
    invoice.buyer.fiscalCode,
    invoice.buyer.country,
    entry.rate === null ? null : { decimal: entry.rate },
    entry.nature,
    amount(entry.taxable, invoice.currency),
    amount(entry.vat, invoice.currency),
    amount(invoice.grossTotal, invoice.currency),
    amount(invoice.stampDutyAmount, invoice.currency),
    invoice.creditOfNumber,
  ])
  return documentOf('SALES_JOURNAL', { recordType: 'Invoice', recordId: invoice.id, number: invoice.number, version: invoice.version }, rows)
}

// ---- purchases journal ---------------------------------------------------------------------------------------------------

export interface SupplierInvoiceFacts {
  readonly id: string
  readonly number: string
  readonly version: number
  readonly kind: string
  readonly docType: string | null
  readonly source: string
  readonly issueDate: string
  readonly receivedOn: string
  readonly currency: string
  readonly netTotal: number
  readonly vatTotal: number
  readonly grossTotal: number
  readonly withholdingAmount: number | null
  readonly stampDutyAmount: number | null
  readonly summary: readonly VatEntry[]
  readonly supplierCode: string
  readonly supplierName: string
  readonly supplierVatId: string | null
  readonly sdiIdentifier: string | null
}

export const PURCHASES_JOURNAL_HEADINGS = {
  en: ['Number', 'Date', 'Received on', 'Kind', 'Type', 'Source', 'Supplier code', 'Supplier', 'VAT ID', 'VAT %', 'VAT nature', 'Taxable', 'VAT', 'Invoice total', 'Withholding', 'Stamp duty', 'SDI id', 'Change'],
  it: ['Numero', 'Data', 'Ricevuta il', 'Genere', 'Tipo', 'Origine', 'Codice fornitore', 'Fornitore', 'Partita IVA', 'Aliquota IVA', 'Natura IVA', 'Imponibile', 'IVA', 'Totale documento', 'Ritenuta', 'Bollo', 'Identificativo SDI', 'Variazione'],
} as const

export function purchasesJournalDocument(invoice: SupplierInvoiceFacts): DocumentRows {
  const entries = invoice.summary.length > 0 ? invoice.summary : [{ rate: null, nature: null, taxable: invoice.netTotal, vat: invoice.vatTotal }]
  const rows = entries.map((entry): Row => [
    invoice.number,
    dayCell(invoice.issueDate),
    dayCell(invoice.receivedOn),
    invoice.kind,
    invoice.docType,
    invoice.source,
    invoice.supplierCode,
    invoice.supplierName,
    invoice.supplierVatId,
    entry.rate === null ? null : { decimal: entry.rate },
    entry.nature,
    amount(entry.taxable, invoice.currency),
    amount(entry.vat, invoice.currency),
    amount(invoice.grossTotal, invoice.currency),
    amount(invoice.withholdingAmount, invoice.currency),
    amount(invoice.stampDutyAmount, invoice.currency),
    invoice.sdiIdentifier,
  ])
  return documentOf('PURCHASES_JOURNAL', { recordType: 'SupplierInvoice', recordId: invoice.id, number: `${invoice.supplierCode} ${invoice.number}`, version: invoice.version }, rows)
}

// ---- payments ------------------------------------------------------------------------------------------------------------

export interface PaymentFacts {
  readonly id: string
  readonly version: number
  readonly receivedOn: string
  readonly reference: string
  readonly method: string
  readonly currency: string
  readonly amount: number
  /** Σ its allocations, reversals taken off. */
  readonly placed: number
  /** Σ its live refunds (DUE or PAID). */
  readonly refunded: number
  /** The invoices it pays (numbers), and the deposit requests (without a number). */
  readonly paysInvoices: readonly string[]
  readonly paysDeposits: number
  readonly customerCode: string
  readonly customerName: string
}

export interface RefundFacts {
  readonly id: string
  readonly version: number
  readonly paidOn: string
  readonly reference: string | null
  readonly method: string
  readonly currency: string
  readonly amount: number
  /** What it gives back: a credit note's number, or the payment's reference. */
  readonly of: string | null
  readonly customerCode: string
  readonly customerName: string
}

export const PAYMENTS_HEADINGS = {
  en: ['Kind', 'Date', 'Reference', 'Customer code', 'Customer', 'Method', 'Amount', 'Placed', 'Refunded', 'Not placed', 'Pays', 'Change'],
  it: ['Genere', 'Data', 'Riferimento', 'Codice cliente', 'Cliente', 'Metodo', 'Importo', 'Abbinato', 'Rimborsato', 'Da abbinare', 'Paga', 'Variazione'],
} as const

/** What is not placed of a payment: received less placed less refunded (never below 0). */
export const unplacedOf = (payment: Pick<PaymentFacts, 'amount' | 'placed' | 'refunded'>): number => Math.max(0, payment.amount - payment.placed - payment.refunded)

export function paymentDocument(payment: PaymentFacts): DocumentRows {
  const pays = [...payment.paysInvoices, ...(payment.paysDeposits > 0 ? [`${payment.paysDeposits} deposit request(s)`] : [])].join(' ')
  const row: Row = [
    'PAYMENT',
    dayCell(payment.receivedOn),
    payment.reference,
    payment.customerCode,
    payment.customerName,
    payment.method,
    amount(payment.amount, payment.currency),
    amount(payment.placed, payment.currency),
    amount(payment.refunded, payment.currency),
    amount(unplacedOf(payment), payment.currency),
    pays || null,
  ]
  return documentOf('PAYMENTS', { recordType: 'Payment', recordId: payment.id, number: payment.reference, version: payment.version }, [row])
}

export function refundDocument(refund: RefundFacts): DocumentRows {
  const row: Row = ['REFUND', dayCell(refund.paidOn), refund.reference, refund.customerCode, refund.customerName, refund.method, amount(-refund.amount, refund.currency), null, null, null, refund.of]
  return documentOf('PAYMENTS', { recordType: 'Refund', recordId: refund.id, number: refund.reference, version: refund.version }, [row])
}

// ---- totals per currency (the review step) -------------------------------------------------------------------------------

export interface CurrencyTotals {
  readonly currency: string
  readonly taxable: number
  readonly vat: number
  readonly gross: number
}

/** Σ of the invoices (each once) by currency. */
export function invoiceTotals(invoices: readonly { readonly currency: string; readonly netTotal: number; readonly vatTotal: number; readonly grossTotal: number }[]): CurrencyTotals[] {
  const by = new Map<string, { taxable: number; vat: number; gross: number }>()
  for (const invoice of invoices) {
    const sum = by.get(invoice.currency) ?? { taxable: 0, vat: 0, gross: 0 }
    sum.taxable += invoice.netTotal
    sum.vat += invoice.vatTotal
    sum.gross += invoice.grossTotal
    by.set(invoice.currency, sum)
  }
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, sum]) => ({ currency, ...sum }))
}
