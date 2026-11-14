import { Decimal } from 'decimal.js'
import { toMinorUnits } from '../../core/money'
import { decimalText } from '../../product/units/units'
import type { ItemKind } from '../../product/materials/rules'
import { MARGIN_PARTS, type MarginPart } from '../margins/rules'
import { SHEET_CATEGORIES, type LineSource, type SheetCategory } from './components'
import { six } from './rules'

/**
 * The cost split by category, kept from the sheet through the actuals to the margin (B-W2b-418; FIN-020), pure.
 *
 *   per size      a size's cost is every size's lines plus its own, by category; its total only when nothing it needs is
 *                 missing (`knownTotal` is the known part)
 *   to actuals    each category is posted on a work order's cost ledger under one kind (B-W2a-21): leather, materials,
 *                 freight and duty under MATERIAL (freight and duty land in the lots' cost, B-W2b-407, so the material
 *                 issued carries them), labour under LABOUR, outside operations under SUBCONTRACT, overhead under OVERHEAD;
 *                 the BOM's packaging under MATERIAL, the packaging master's packaging and commissions under none (nothing
 *                 issues them to a work order)
 *   to margin     each ledger kind is one part of the order margin (B-W2a-29: material, labour, subcontract, overhead,
 *                 adjustment); what no work order carries is in no margin part yet, and says so
 *
 * A work order's planned cost is Σ its garments × the sheet's cost per garment of their size, per category, rounded once to
 * minor units; its actual is Σ its ledger entries per kind (the value moved to finished goods, variances and the close are
 * not costs), the material split back into leather, materials and packaging by the article's kind.
 */

/** A line as the split reads it. */
export interface SplitLine {
  readonly category: SheetCategory
  readonly source: LineSource
  readonly size: string | null
  readonly cost: string
}

export interface SizeSplit {
  readonly size: string
  readonly categories: readonly { readonly category: SheetCategory; readonly amount: string }[]
  readonly knownTotal: string
  /** null unless every input the size needs is there. */
  readonly total: string | null
  readonly complete: boolean
}

/** Each size of the range: its lines by category (every size's and its own), its total. */
export function splitBySize(lines: readonly SplitLine[], sizes: readonly string[], missing: readonly { readonly size: string | null }[]): SizeSplit[] {
  return sizes.map((size) => {
    const mine = lines.filter((line) => line.size === null || line.size === size)
    const categories = SHEET_CATEGORIES.flatMap((category) => {
      const of = mine.filter((line) => line.category === category)
      return of.length === 0 ? [] : [{ category, amount: six(of.reduce((sum, line) => sum.plus(line.cost), new Decimal(0))) }]
    })
    const knownTotal = six(mine.reduce((sum, line) => sum.plus(line.cost), new Decimal(0)))
    const complete = mine.length > 0 && !missing.some((entry) => entry.size === null || entry.size === size)
    return { size, categories, knownTotal, total: complete ? knownTotal : null, complete }
  })
}

/** The kind of the work order's cost ledger a line's category is posted under; NONE: no work order carries it. */
export const LEDGER_GROUPS = ['MATERIAL', 'LABOUR', 'SUBCONTRACT', 'OVERHEAD', 'ADJUSTMENT', 'NONE'] as const
export type LedgerGroup = (typeof LEDGER_GROUPS)[number]

export function ledgerGroupOf(category: SheetCategory, source: LineSource): LedgerGroup {
  switch (category) {
    case 'LEATHER':
    case 'MATERIAL':
    case 'FREIGHT':
    case 'DUTY':
      return 'MATERIAL'
    case 'PACKAGING':
      return source === 'BOM_LINE' ? 'MATERIAL' : 'NONE'
    case 'LABOUR':
      return 'LABOUR'
    case 'SUBCONTRACT':
      return 'SUBCONTRACT'
    case 'OVERHEAD':
      return 'OVERHEAD'
    default:
      return 'NONE'
  }
}

/** The part of the order margin a ledger kind is (B-W2a-29); null: none yet. */
export const MARGIN_PART_OF: Readonly<Record<LedgerGroup, MarginPart | null>> = Object.freeze({
  MATERIAL: 'MATERIAL',
  LABOUR: 'LABOUR',
  SUBCONTRACT: 'SUBCONTRACT',
  OVERHEAD: 'OVERHEAD',
  ADJUSTMENT: 'ADJUSTMENT',
  NONE: null,
})
// Every margin part is reached by one ledger kind (checked at import: a margin part added later needs its kind here).
for (const part of MARGIN_PARTS) if (!Object.values(MARGIN_PART_OF).includes(part)) throw new Error(`margin part ${part} has no ledger kind`)

export const GROUP_WORDS: Readonly<Record<LedgerGroup, string>> = Object.freeze({
  MATERIAL: 'Leather, materials, the BOM’s packaging, freight and duty: posted as the material issued (freight and duty are in the lots’ cost).',
  LABOUR: 'Labour: posted from the scans at the rate in force.',
  SUBCONTRACT: 'Outside operations and their transport: posted from the subcontract orders and the workshops’ invoices.',
  OVERHEAD: 'Overhead: posted at the costing settings’ percent (the overhead rules change no posted cost yet: GATE-ACCOUNTANT).',
  ADJUSTMENT: 'Corrections posted by hand with a reason: never planned.',
  NONE: 'The packaging master’s packaging and commissions: no work order is issued them, so they are planned here and in no margin part yet.',
})

/** The ledger kinds that are a cost of the work order (the value moved to finished goods, variances and the close are not). */
const COST_KINDS: Readonly<Record<string, LedgerGroup>> = Object.freeze({ MATERIAL: 'MATERIAL', SCRAP: 'MATERIAL', LABOUR: 'LABOUR', SUBCONTRACT: 'SUBCONTRACT', OVERHEAD: 'OVERHEAD', ADJUSTMENT: 'ADJUSTMENT' })

/** One garment cell of a work order with the sheet lines its garments are planned at. */
export interface PlannedCell {
  readonly size: string
  readonly quantity: number
  readonly lines: readonly SplitLine[]
}

/** One entry of the work order's cost ledger: its kind, amount (minor units) and the article's kind (material entries). */
export interface LedgerFact {
  readonly kind: string
  readonly amount: number
  readonly itemKind: ItemKind | null
}

export interface WorkOrderSplit {
  readonly rows: { readonly category: SheetCategory; readonly ledgerGroup: LedgerGroup; readonly marginPart: MarginPart | null; readonly planned: number }[]
  readonly groups: { readonly ledgerGroup: LedgerGroup; readonly marginPart: MarginPart | null; readonly planned: number; readonly actual: number; readonly difference: number; readonly words: string }[]
  /** The actual material (MATERIAL and SCRAP entries) split back by the article's kind. */
  readonly materialActual: { readonly leather: number; readonly material: number; readonly packaging: number }
  /** Σ planned and actual of what a work order carries (every kind but NONE), and their difference. */
  readonly planned: number
  readonly actual: number
  readonly difference: number
  /** Planned but on no work order's ledger (the packaging master's packaging, commissions). */
  readonly notOnLedger: number
}

export function workOrderSplit(cells: readonly PlannedCell[], entries: readonly LedgerFact[], currency: string): WorkOrderSplit {
  const exact = new Map<string, { category: SheetCategory; group: LedgerGroup; amount: Decimal }>()
  for (const cell of cells) {
    for (const line of cell.lines) {
      if (line.size !== null && line.size !== cell.size) continue
      const group = ledgerGroupOf(line.category, line.source)
      const key = `${line.category}|${group}`
      const entry = exact.get(key) ?? { category: line.category, group, amount: new Decimal(0) }
      entry.amount = entry.amount.plus(new Decimal(line.cost).times(cell.quantity))
      exact.set(key, entry)
    }
  }
  const rows = SHEET_CATEGORIES.flatMap((category) =>
    LEDGER_GROUPS.flatMap((group) => {
      const entry = exact.get(`${category}|${group}`)
      return entry ? [{ category, ledgerGroup: group, marginPart: MARGIN_PART_OF[group], planned: toMinorUnits(decimalText(entry.amount), currency) }] : []
    }),
  )
  const actualOf = new Map<LedgerGroup, number>()
  const materialActual = { leather: 0, material: 0, packaging: 0 }
  for (const entry of entries) {
    const group = COST_KINDS[entry.kind]
    if (!group) continue
    actualOf.set(group, (actualOf.get(group) ?? 0) + entry.amount)
    if (group === 'MATERIAL') {
      if (entry.itemKind === 'LEATHER') materialActual.leather += entry.amount
      else if (entry.itemKind === 'PACKAGING') materialActual.packaging += entry.amount
      else materialActual.material += entry.amount
    }
  }
  const groups = LEDGER_GROUPS.flatMap((group) => {
    const planned = rows.filter((row) => row.ledgerGroup === group).reduce((sum, row) => sum + row.planned, 0)
    const actual = actualOf.get(group) ?? 0
    const seen = rows.some((row) => row.ledgerGroup === group) || actualOf.has(group)
    return seen ? [{ ledgerGroup: group, marginPart: MARGIN_PART_OF[group], planned, actual, difference: actual - planned, words: GROUP_WORDS[group] }] : []
  })
  const carried = groups.filter((group) => group.ledgerGroup !== 'NONE')
  const planned = carried.reduce((sum, group) => sum + group.planned, 0)
  const actual = carried.reduce((sum, group) => sum + group.actual, 0)
  const notOnLedger = groups.find((group) => group.ledgerGroup === 'NONE')?.planned ?? 0
  return { rows, groups, materialActual, planned, actual, difference: actual - planned, notOnLedger }
}
