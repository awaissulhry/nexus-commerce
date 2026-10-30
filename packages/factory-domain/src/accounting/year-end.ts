import type { ExportCell } from '../views/exports'
import { fingerprint, type ExportDocument } from './manifest'

/**
 * The year-end stock pack (B-W2a-39; FIN-046; c.c. art. 2217: the inventory, with its values, closes the year; art.
 * 2220: kept ten years). Pure: the API reads the facts. The pack holds
 *
 *   - the valued list of every year-end physical inventory of the company signed off for the year-end day (B-W2a-15:
 *     the count's frozen PDF, FISCAL_ARCHIVE, and its sheet): copied into the export as they were signed, never redone;
 *   - the stock valuation at the end of the year-end day (B-W2a-29's valueStockAsOf: the stock ledger's values of every
 *     move up to then, and the work in progress of the work orders' cost ledger), one row per site, item, colour and
 *     lot, as a CSV in the DEFAULT layout.
 *
 * TO CONFIRM WITH THE ACCOUNTANT (GATE-ACCOUNTANT): the pack's content and layout, and the costing method (c.c. art.
 * 2426): while it is UNDECIDED every value is the stock ledger's and says it depends on the method (whether stock and
 * cost entries valued meanwhile are revalued once a method is chosen is the accountant's question; nothing here revalues).
 */

export interface YearEndCountFacts {
  readonly id: string
  readonly number: string
  readonly version: number
  readonly siteId: string
  readonly siteCode: string
  readonly status: string
  readonly signedOffAt: string | null
  /** The frozen valued list (PDF) and sheet (XLSX), once signed off. */
  readonly pdfFileId: string | null
  readonly sheetFileId: string | null
}

export interface ValuationRowFacts {
  readonly category: string
  readonly siteCode: string
  readonly itemCode: string | null
  readonly itemName: string | null
  readonly colourCode: string | null
  readonly lotCode: string | null
  readonly workOrderNumber: string | null
  readonly quantity: string | null
  readonly uom: string | null
  readonly hides: number
  readonly value: number
  readonly currency: string | null
  readonly valued: string
  readonly dependsOnMethod: boolean
}

export const VALUATION_HEADINGS = {
  en: ['Category', 'Site', 'Item code', 'Item', 'Colour', 'Lot', 'Work order', 'Quantity', 'Unit', 'Hides', 'Value', 'Valued', 'Depends on the costing method'],
  it: ['Categoria', 'Sito', 'Codice articolo', 'Articolo', 'Colore', 'Lotto', 'Ordine di lavoro', 'Quantità', 'Unità', 'Pelli', 'Valore', 'Valorizzato', 'Dipende dal metodo di valutazione'],
} as const

export function valuationCells(row: ValuationRowFacts): ExportCell[] {
  return [
    row.category,
    row.siteCode,
    row.itemCode,
    row.itemName,
    row.colourCode,
    row.lotCode,
    row.workOrderNumber,
    row.quantity === null ? null : { decimal: row.quantity },
    row.uom,
    row.hides,
    { minor: row.value, currency: row.currency },
    row.valued,
    row.dependsOnMethod ? 'YES' : 'NO',
  ]
}

/** The documents the pack rests on: each signed-off inventory (its frozen files) and the valuation at the year end. */
export function yearEndDocuments(input: { readonly companyId: string; readonly yearEndDay: string; readonly counts: readonly YearEndCountFacts[]; readonly valuation: readonly ValuationRowFacts[] }): ExportDocument[] {
  const counts = input.counts
    .filter((count) => count.status === 'SIGNED_OFF')
    .map((count) => ({ package: 'YEAR_END_STOCK' as const, recordType: 'StockCount', recordId: count.id, number: count.number, version: count.version, hash: fingerprint([count.pdfFileId, count.sheetFileId]) }))
  return [...counts, { package: 'YEAR_END_STOCK', recordType: 'StockValuation', recordId: input.companyId, number: input.yearEndDay, version: null, hash: fingerprint(input.valuation.map(valuationCells)) }]
}

export const YEAR_END_WORDS =
  'The year-end stock pack: the valued list of each year-end inventory as it was signed off, and the stock valuation at the end of the year-end day (stock ledger values; work in progress from the cost ledger). TO CONFIRM WITH THE ACCOUNTANT: its content and layout, and the costing method (c.c. art. 2426; UNDECIDED: every value depends on it, nothing is revalued).'
