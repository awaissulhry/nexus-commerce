import type { Locale } from '../../../../lib/i18n/locales'
import type { PpvAnswer, PpvRow } from './api'

/**
 * B-W2b-424 — Finance › Costing › Purchase price variance (design finance.costing sec:ppv; FIN-031), the pure rules: the
 * difference's tone (paid above the standard: warning; below: success), a row's state (a reversal, reversed on a day, or
 * standing), the CSV of the chosen rows (the amount columns only with the cost grain: never more than the screen shows)
 * and the live events that read the section again. No fetching, no React. No person is named.
 */

/** The section's view model (PpvSection draws it and fetches nothing). */
export interface PpvSectionModel {
  /** Unit costs and differences: the cost grain (money.cost). */
  readonly cost: boolean
  /** The page's period (the API's from/to are its days). */
  readonly period: { readonly month: string; readonly from: string; readonly to: string }
  readonly rows: readonly PpvRow[] | null
  readonly more: boolean
  readonly problem: string | null
  /** "Still loading…" after about a second (design: GridSheetNote slow). */
  readonly slow: boolean
  /** Over every page of the period, per currency. */
  readonly totals: PpvAnswer['totals'] | null
  /** The company's figures wait for the accountant (its switch is off): nothing is posted here meanwhile. */
  readonly waits: boolean
  /** Design cases: the chosen rows, the focused row, the keys panel open. */
  readonly selected?: readonly string[]
  readonly focusRow?: number
  readonly keysOpen?: boolean
}

export interface PpvSectionActions {
  onRetry?: () => void
  onMore?: () => void
  onExport?: (rows: readonly PpvRow[], words: PpvCsvWords, fileName: string) => void
  /** Enter on a row: the document it comes from. */
  onOpen?: (row: PpvRow) => void
}

/** Above 0 the material was paid above its standard (unfavourable). */
export function differenceTone(row: Pick<PpvRow, 'differenceAmount'>): 'warning' | 'success' | 'neutral' {
  if (typeof row.differenceAmount !== 'number' || row.differenceAmount === 0) return 'neutral'
  return row.differenceAmount > 0 ? 'warning' : 'success'
}

export type PpvState = 'reversal' | 'reversed' | 'standing'
export const ppvStateOf = (row: Pick<PpvRow, 'reversalOfId' | 'reversedBy'>): PpvState => (row.reversalOfId ? 'reversal' : row.reversedBy ? 'reversed' : 'standing')

/** The document a row comes from, as a record reference (a goods receipt or a supplier invoice). */
export const documentRef = (row: Pick<PpvRow, 'source'>): { type: 'GoodsReceipt' | 'SupplierInvoice'; id: string; label: string } => ({
  type: row.source.at === 'RECEIPT' ? 'GoodsReceipt' : 'SupplierInvoice',
  id: row.source.documentId,
  label: row.source.number,
})

export interface PpvCsvWords {
  readonly header: (column: string) => string
  readonly at: (row: PpvRow) => string
  readonly state: (row: PpvRow) => string
}

const plainMinor = (value: number | undefined, locale: Locale): string => (value === undefined ? '' : (value / 100).toFixed(2).replace('.', locale === 'it' ? ',' : '.'))
const plainDecimal = (value: string | undefined, locale: Locale): string => (value === undefined ? '' : locale === 'it' ? value.replace('.', ',') : value)

/** The chosen rows as CSV: `;` and the decimal comma in Italian, `,` and the dot in English; amounts only with the cost grain. */
export function ppvCsv(rows: readonly PpvRow[], cost: boolean, words: PpvCsvWords, locale: Locale): string {
  const separator = locale === 'it' ? ';' : ','
  const cell = (value: string | number): string => {
    const text = String(value)
    return new RegExp(`["\\n${separator}]`).test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const columns = ['material', 'supplier', 'document', 'at', 'day', 'quantity', 'unit', ...(cost ? ['standard', 'paid', 'difference', 'currency'] : []), 'state']
  const lines = [columns.map((column) => cell(words.header(column))).join(separator)]
  for (const row of rows) {
    lines.push(
      [
        `${row.item.code} · ${row.item.name}`,
        row.supplier.name,
        `${row.source.number} / ${row.source.seq}`,
        words.at(row),
        row.day,
        plainDecimal(row.quantity, locale),
        row.item.baseUom,
        ...(cost ? [plainDecimal(row.standardUnitCost, locale), plainDecimal(row.paidUnitCost, locale), plainMinor(row.differenceAmount, locale), row.currency] : []),
        words.state(row),
      ]
        .map(cell)
        .join(separator),
    )
  }
  return `${lines.join('\n')}\n`
}

/** A variance posted or taken back, or the company's switch changed: the section reads again. */
export const ppvTouches = (change: { type: string }): boolean => change.type === 'purchase_price_variance.posted' || change.type === 'actual_cost_settings.changed'
