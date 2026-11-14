import { Dec } from '../../tax/decimal'
import type { ExportCell } from '../../views/exports'
import { documentOf, type DocumentRows, type Row, type SalesInvoiceFacts, type SupplierInvoiceFacts, type VatEntry } from '../journals'
import { isSupplierCreditNote } from '../journals/entries'

/**
 * The VAT registers and the month's VAT totals (B-W2b-408; FIN-106; design finance.accounting "3 · Contents": "VAT
 * registers (W2b)"), pure: the data the accountant files VAT from (the accountant also takes the invoices from SDI).
 *
 *   sales register      the invoices issued in the month (as the sales journal: TD01, TD02, TD04, TD24; a draft is not
 *                       issued, one SDI rejected counts as never issued), by number, one row per VAT rate or Natura; a
 *                       credit note's figures below 0 (it reduces the VAT due)
 *   purchases register  the supplier invoices registered in the month (received, not voided), one row per VAT rate or
 *                       Natura; a supplier's credit note below 0
 *   totals              per currency: the taxable and the VAT of each rate or Natura, sales and purchases, and the month's
 *                       VAT (sales VAT less purchase VAT; below 0 a credit)
 * GATE-ACCOUNTANT: what is deductible, the pro-rata, reverse charge (the self-invoices TD16–TD19), split payment and the
 * quarterly or monthly settlement are the accountant's: the totals are the registers' sums, UNVERIFIED as a return. The
 * package is WHOLE: a re-export carries the month's registers whole again when anything behind them changed.
 */

export const VAT_SIDES = ['SALES', 'PURCHASES'] as const
export type VatSide = (typeof VAT_SIDES)[number]

const money = (minor: number | null | undefined, currency: string): ExportCell => (minor === null || minor === undefined ? null : { minor, currency })
const rateCell = (entry: Pick<VatEntry, 'rate'>): ExportCell => (entry.rate === null ? null : { decimal: entry.rate })
const entriesOf = (summary: readonly VatEntry[], netTotal: number, vatTotal: number): readonly VatEntry[] => (summary.length > 0 ? summary : [{ rate: null, nature: null, taxable: netTotal, vat: vatTotal }])

export const SALES_REGISTER_HEADINGS = {
  en: ['Number', 'Date', 'Type', 'Customer code', 'Customer', 'VAT ID', 'Fiscal code', 'VAT %', 'VAT nature', 'Taxable', 'VAT', 'Invoice total'],
  it: ['Numero', 'Data', 'Tipo', 'Codice cliente', 'Cliente', 'Partita IVA', 'Codice fiscale', 'Aliquota IVA', 'Natura IVA', 'Imponibile', 'Imposta', 'Totale documento'],
} as const

export const PURCHASES_REGISTER_HEADINGS = {
  en: ['Received on', 'Number', 'Date', 'Type', 'Supplier code', 'Supplier', 'VAT ID', 'VAT %', 'VAT nature', 'Taxable', 'VAT', 'Invoice total', 'SDI id'],
  it: ['Registrata il', 'Numero', 'Data', 'Tipo', 'Codice fornitore', 'Fornitore', 'Partita IVA', 'Aliquota IVA', 'Natura IVA', 'Imponibile', 'Imposta', 'Totale documento', 'Identificativo SDI'],
} as const

export const VAT_TOTALS_HEADINGS = {
  en: ['Register', 'VAT %', 'VAT nature', 'Currency', 'Taxable', 'VAT'],
  it: ['Registro', 'Aliquota IVA', 'Natura IVA', 'Valuta', 'Imponibile', 'Imposta'],
} as const

/** A sales invoice's sign in the register (a credit note reduces). */
const salesSign = (docType: string): number => (docType === 'TD04' ? -1 : 1)

export function salesRegisterDocument(invoice: SalesInvoiceFacts): DocumentRows {
  const sign = salesSign(invoice.docType)
  const rows = entriesOf(invoice.summary, invoice.netTotal, invoice.vatTotal).map((entry): Row => [
    invoice.number,
    { day: invoice.issueDate },
    invoice.docType,
    invoice.buyerCode,
    invoice.buyer.name,
    invoice.buyer.vatId,
    invoice.buyer.fiscalCode,
    rateCell(entry),
    entry.nature,
    money(sign * entry.taxable, invoice.currency),
    money(sign * entry.vat, invoice.currency),
    money(sign * invoice.grossTotal, invoice.currency),
  ])
  return documentOf('VAT_REGISTERS', { recordType: 'Invoice', recordId: invoice.id, number: invoice.number, version: invoice.version }, rows)
}

export function purchasesRegisterDocument(invoice: SupplierInvoiceFacts): DocumentRows {
  const sign = isSupplierCreditNote(invoice) ? -1 : 1
  const rows = entriesOf(invoice.summary, invoice.netTotal, invoice.vatTotal).map((entry): Row => [
    { day: invoice.receivedOn },
    invoice.number,
    { day: invoice.issueDate },
    invoice.docType ?? invoice.kind,
    invoice.supplierCode,
    invoice.supplierName,
    invoice.supplierVatId,
    rateCell(entry),
    entry.nature,
    money(sign * entry.taxable, invoice.currency),
    money(sign * entry.vat, invoice.currency),
    money(sign * invoice.grossTotal, invoice.currency),
    invoice.sdiIdentifier,
  ])
  return documentOf('VAT_REGISTERS', { recordType: 'SupplierInvoice', recordId: invoice.id, number: `${invoice.supplierCode} ${invoice.number}`, version: invoice.version }, rows)
}

export interface VatTotal {
  readonly side: VatSide | 'DUE'
  readonly rate: string | null
  readonly nature: string | null
  readonly currency: string
  readonly taxable: number
  readonly vat: number
}

/** The month's totals per currency: each rate or Natura of each register, then the VAT due (sales VAT less purchase VAT). */
export function vatTotals(sales: readonly SalesInvoiceFacts[], purchases: readonly SupplierInvoiceFacts[]): VatTotal[] {
  const sums = new Map<string, { side: VatSide; rate: string | null; nature: string | null; currency: string; taxable: number; vat: number }>()
  const add = (side: VatSide, currency: string, sign: number, entry: VatEntry) => {
    const rate = entry.rate === null ? null : new Dec(entry.rate).toFixed(2)
    const id = `${side}|${currency}|${rate ?? ''}|${entry.nature ?? ''}`
    const found = sums.get(id) ?? { side, rate, nature: entry.nature, currency, taxable: 0, vat: 0 }
    found.taxable += sign * entry.taxable
    found.vat += sign * entry.vat
    sums.set(id, found)
  }
  for (const invoice of sales) for (const entry of entriesOf(invoice.summary, invoice.netTotal, invoice.vatTotal)) add('SALES', invoice.currency, salesSign(invoice.docType), entry)
  for (const invoice of purchases) for (const entry of entriesOf(invoice.summary, invoice.netTotal, invoice.vatTotal)) add('PURCHASES', invoice.currency, isSupplierCreditNote(invoice) ? -1 : 1, entry)
  const rows = [...sums.values()].sort((a, b) => a.currency.localeCompare(b.currency) || VAT_SIDES.indexOf(a.side) - VAT_SIDES.indexOf(b.side) || (a.rate ?? '').localeCompare(b.rate ?? '') || (a.nature ?? '').localeCompare(b.nature ?? ''))
  const out: VatTotal[] = []
  for (const currency of [...new Set(rows.map((row) => row.currency))]) {
    const mine = rows.filter((row) => row.currency === currency)
    out.push(...mine)
    const vat = (side: VatSide) => mine.filter((row) => row.side === side).reduce((sum, row) => sum + row.vat, 0)
    out.push({ side: 'DUE', rate: null, nature: null, currency, taxable: 0, vat: vat('SALES') - vat('PURCHASES') })
  }
  return out
}

export const vatTotalCells = (total: VatTotal): Row => [total.side, total.rate === null ? null : { decimal: total.rate }, total.nature, total.currency, total.side === 'DUE' ? null : money(total.taxable, total.currency), money(total.vat, total.currency)]

export const VAT_REGISTERS_WORDS =
  "The sales and purchases VAT registers of the month (one row per VAT rate or Natura; credit notes below 0) and their totals with the month's VAT (sales VAT less purchase VAT). The accountant files the return: what is deductible, reverse charge and the settlement are theirs (GATE-ACCOUNTANT)."
