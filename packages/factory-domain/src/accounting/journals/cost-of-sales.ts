import type { ExportCell } from '../../views/exports'
import { documentOf, type DocumentRows, type Row } from '../journals'
import type { VarianceCategory } from '../mapping/keys'
import type { CostFigureFacts } from './entries'

/**
 * The cost of goods sold and variances package (B-W2b-408; FIN-151; design finance.accounting "3 · Contents": "cost of
 * goods sold and variances (W2b)"), pure. Its register lists what the cost bridge posted in the month, one row each:
 *
 *   COST_OF_SALES  a shipment line's cost of goods sold (B-W2b-407: CostOfSalesEntry, posted when the goods left), by
 *                  part: material, labour, subcontract, overhead; a reversal (a carrier's return) below 0
 *   VARIANCE       a line of a work order's cost close (B-W2b-411: WorkOrderVariance), dated by its close; a close
 *                  undone leaves the month (a re-export marks it REMOVED)
 *   PPV            a purchase price variance (B-W2b-407: PurchasePriceVariance) at the receipt or at the supplier's
 *                  invoice; a reversal below 0
 * Each is posted only while the company's switch for the accountant's figures is on (GATE-ACCOUNTANT): while it is off
 * the register is empty and says so. Its documents are these rows (never changed, append-only in the database); a
 * re-export carries the new ones. Amounts are costs (the package's grain).
 */

export const COST_FIGURE_KINDS = ['COST_OF_SALES', 'VARIANCE', 'PPV'] as const
export type CostFigureKind = (typeof COST_FIGURE_KINDS)[number]

export interface CostRegisterFacts extends CostFigureFacts {
  /** A work order's number (a variance), else null. */
  readonly workOrderNumber: string | null
  /** The material's code (a variance about one, a purchase price variance), else null. */
  readonly itemCode: string | null
  /** A purchase price variance: RECEIPT or INVOICE. */
  readonly at: string | null
  /** Garments or units (cost of goods sold), the actual quantity (a variance), the base quantity (a purchase price variance). */
  readonly quantity: string | null
  /** Cost of goods sold by part (signed as the amount), else null. */
  readonly parts: { readonly material: number; readonly labour: number; readonly subcontract: number; readonly overhead: number } | null
  /** A reversal: the reference of what it takes back. */
  readonly reverses: string | null
}

export const kindOfFigure = (recordType: CostFigureFacts['recordType']): CostFigureKind => (recordType === 'CostOfSalesEntry' ? 'COST_OF_SALES' : recordType === 'WorkOrderVariance' ? 'VARIANCE' : 'PPV')

export const COST_REGISTER_HEADINGS = {
  en: ['Kind', 'Date', 'Reference', 'Work order', 'Party code', 'Party', 'Item', 'Category', 'Quantity', 'Material', 'Labour', 'Subcontract', 'Overhead', 'Amount', 'Reverses', 'Change'],
  it: ['Genere', 'Data', 'Riferimento', 'Ordine di produzione', 'Codice soggetto', 'Soggetto', 'Articolo', 'Categoria', 'Quantità', 'Materiale', 'Manodopera', 'Terzisti', 'Spese generali', 'Importo', 'Storna', 'Variazione'],
} as const
export const COST_REGISTER_NUMBER_COLUMN = 2

export function costRegisterDocument(figure: CostRegisterFacts): DocumentRows {
  const money = (amount: number | null | undefined): ExportCell => (amount === null || amount === undefined ? null : { minor: amount, currency: figure.currency })
  const category: string | null = figure.recordType === 'WorkOrderVariance' ? (figure.category as VarianceCategory | null) : figure.at
  const row: Row = [
    kindOfFigure(figure.recordType),
    { day: figure.day },
    figure.reference,
    figure.workOrderNumber,
    figure.partyCode,
    figure.partyName,
    figure.itemCode,
    category,
    figure.quantity === null ? null : { decimal: figure.quantity },
    money(figure.parts?.material),
    money(figure.parts?.labour),
    money(figure.parts?.subcontract),
    money(figure.parts?.overhead),
    money(figure.amount),
    figure.reverses,
  ]
  return documentOf('COST_OF_SALES', { recordType: figure.recordType, recordId: figure.id, number: figure.reference, version: null }, [row])
}

/** Σ per currency and kind (the review step's totals). */
export function costTotals(figures: readonly Pick<CostRegisterFacts, 'recordType' | 'currency' | 'amount'>[]): { kind: CostFigureKind; currency: string; amount: number }[] {
  const sums = new Map<string, { kind: CostFigureKind; currency: string; amount: number }>()
  for (const figure of figures) {
    const kind = kindOfFigure(figure.recordType)
    const id = `${kind}|${figure.currency}`
    const found = sums.get(id) ?? { kind, currency: figure.currency, amount: 0 }
    found.amount += figure.amount
    sums.set(id, found)
  }
  return [...sums.values()].sort((a, b) => COST_FIGURE_KINDS.indexOf(a.kind) - COST_FIGURE_KINDS.indexOf(b.kind) || a.currency.localeCompare(b.currency))
}

/** The register's words (and why it is empty while the switch is off). */
export const COST_REGISTER_WORDS =
  "The cost of goods sold of the goods that left in the month (by part), the variances of the work orders closed in it and the purchase price variances taken in it; with the journals switched on, their entries with the mapped accounts. Nexus's reading of how the accountant posts them (GATE-ACCOUNTANT)."
