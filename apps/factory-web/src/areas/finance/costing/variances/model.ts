import type { Locale } from '../../../../lib/i18n/locales'
import { VARIANCE_CATEGORIES, type VarianceCategory, type VarianceRow, type Variances } from './api'

/**
 * B-W2b-GB02 (G053; B-W2b-424's gap 5) — Finance › Costing › Variances by work order, the pure rules: the amount's tone
 * (above its standard: warning; below: success), a line's unit (its material's base unit, standard minutes for labour, else
 * garments), the totals in the order of the categories and per currency, the CSV of the chosen lines (the amount columns
 * only with the cost grain) and the live events that read the section again. No fetching, no React. Never per person.
 */

export interface VariancesSectionModel {
  /** Unit costs and amounts: the cost grain (money.cost). */
  readonly cost: boolean
  readonly period: { readonly month: string; readonly from: string; readonly to: string }
  readonly rows: readonly VarianceRow[] | null
  readonly more: boolean
  readonly problem: string | null
  readonly slow: boolean
  /** Over every page of the period, per currency and category. */
  readonly totals: Variances['totals'] | null
  /** The company's figures wait for the accountant: a close is a status meanwhile, nothing is split. */
  readonly waits: boolean
  /** Design cases: the chosen rows, the focused row, the keys panel open. */
  readonly selected?: readonly string[]
  readonly focusRow?: number
  readonly keysOpen?: boolean
}

export interface VariancesSectionActions {
  onRetry?: () => void
  onMore?: () => void
  onExport?: (rows: readonly VarianceRow[], words: VariancesCsvWords, fileName: string) => void
  /** Enter on a row: the work order's Labour & cost tab. */
  onOpen?: (row: VarianceRow) => void
}

/** Above 0 the work order cost more than its standard (unfavourable). */
export function amountTone(row: Pick<VarianceRow, 'amount'>): 'warning' | 'success' | 'neutral' {
  if (typeof row.amount !== 'number' || row.amount === 0) return 'neutral'
  return row.amount > 0 ? 'warning' : 'success'
}

/** A line's quantities are base units of its material, standard minutes (labour) or garments. */
export function varianceUnit(row: Pick<VarianceRow, 'category' | 'item'>): string {
  if (row.item) return row.item.baseUom
  if (row.category === 'LABOUR_EFFICIENCY' || row.category === 'LABOUR_RATE') return 'MIN'
  return 'PCS'
}

/** The totals per currency (Σ of every category; null without the cost grain) and the categories in their order. */
export function totalsOf(totals: Variances['totals']): Array<{ currency: string; amount: number | null; lines: number; categories: Array<{ category: VarianceCategory; amount: number | null; lines: number }> }> {
  const byCurrency = new Map<string, Variances['totals']>()
  for (const total of totals) byCurrency.set(total.currency, [...(byCurrency.get(total.currency) ?? []), total])
  return [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, list]) => {
      const amounts = list.map((entry) => entry.amount)
      const known = amounts.every((amount) => typeof amount === 'number')
      return {
        currency,
        amount: known ? (amounts as number[]).reduce((sum, amount) => sum + amount, 0) : null,
        lines: list.reduce((sum, entry) => sum + entry.lines, 0),
        categories: [...list]
          .sort((a, b) => VARIANCE_CATEGORIES.indexOf(a.category) - VARIANCE_CATEGORIES.indexOf(b.category))
          .map((entry) => ({ category: entry.category, amount: typeof entry.amount === 'number' ? entry.amount : null, lines: entry.lines })),
      }
    })
}

export interface VariancesCsvWords {
  readonly header: (column: string) => string
  readonly category: (row: VarianceRow) => string
}

const plainMinor = (value: number | undefined, locale: Locale): string => (value === undefined ? '' : (value / 100).toFixed(2).replace('.', locale === 'it' ? ',' : '.'))
const plainDecimal = (value: string | null | undefined, locale: Locale): string => (value === undefined || value === null ? '' : locale === 'it' ? value.replace('.', ',') : value)

/** The chosen lines as CSV: `;` and the decimal comma in Italian, `,` and the dot in English; amounts only with the cost grain. */
export function variancesCsv(rows: readonly VarianceRow[], cost: boolean, words: VariancesCsvWords, locale: Locale): string {
  const separator = locale === 'it' ? ';' : ','
  const cell = (value: string | number): string => {
    const text = String(value)
    return new RegExp(`["\\n${separator}]`).test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const columns = ['workOrder', 'category', 'material', 'closed', 'standard', 'actual', 'unit', ...(cost ? ['standardCost', 'actualCost', 'amount', 'currency'] : [])]
  const lines = [columns.map((column) => cell(words.header(column))).join(separator)]
  for (const row of rows) {
    lines.push(
      [
        row.workOrder.number,
        words.category(row),
        row.item ? `${row.item.code} · ${row.item.name}` : '',
        row.closedAt.slice(0, 10),
        plainDecimal(row.standardQuantity, locale),
        plainDecimal(row.actualQuantity, locale),
        varianceUnit(row),
        ...(cost ? [plainDecimal(row.standardUnitCost, locale), plainDecimal(row.actualUnitCost, locale), plainMinor(row.amount, locale), row.currency] : []),
      ]
        .map(cell)
        .join(separator),
    )
  }
  return `${lines.join('\n')}\n`
}

/** A close, an undo or a reopen (its lines stand, or no longer), or the company's switch: the section reads again. */
export const variancesTouches = (change: { type: string }): boolean => change.type === 'work_order_close.changed' || change.type === 'actual_cost_settings.changed'
