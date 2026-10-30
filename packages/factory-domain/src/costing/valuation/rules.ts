import { fromMinorUnits } from '../../core/money'
import type { ValuationMethod } from '../../inventory/ledger/valuation'
import { COST_SCALE, fixedRatio, dimensionOf, type Uom } from '../../product/units/units'
import { Dec, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'
import { categoryOf, type CostCategory } from '../inputs'
import type { CostingMethod } from '../ledger/entries'

/**
 * Stock valuation at any date and value by hide area (B-W2a-29; FIN-039, SCM-256; design finance.reports "Stock
 * valuation" and its pop-up "How this lot is valued", warehouse.hides "Leather dashboard" area value), pure.
 *
 * The figure is the ledger's, never a recomputation: the value of a stock key (a site's item, colour, lot and hide) on a
 * date is the sum of the StockValuation rows of its moves up to that date (inventory's own valuation: receipts at their
 * purchase order price, issues and returns at the lot's average cost, opening stock and untracked items at the item's
 * standard cost, typed corrections); its quantity the sum of those moves (+ into the site's stock, − out of it). Work in
 * progress is the work-order cost ledger's: Σ a work order's entries up to the date (what it took on less what moved out
 * to finished goods). Nothing here applies a costing method: the company's method (the accountant's, c.c. art. 2426) is
 * recorded beside each figure, and a figure that a chosen method could value differently says so (`dependsOnMethod`).
 *
 * Amounts are Int minor units of the item's currency, unit costs six-place decimal strings, quantities in the item's base
 * unit (four places). A row's unit cost is its value ÷ its quantity, what the ledger holds per unit.
 */

export const VALUATION_CATEGORIES = ['LEATHER', 'MATERIALS', 'TRIMS', 'PACKAGING', 'FINISHED_GOODS', 'WIP'] as const
export type ValuationCategory = (typeof VALUATION_CATEGORIES)[number]

/** How much of a row's quantity rests on valued moves. */
export const VALUED_STATES = ['FULL', 'PART', 'NONE'] as const
export type ValuedState = (typeof VALUED_STATES)[number]

/** The category of an item's stock: the cost sheet's (leather, materials, trims, packaging), finished garments apart. */
export function categoryOfKind(kind: string): Exclude<ValuationCategory, 'WIP'> {
  if (kind === 'FINISHED') return 'FINISHED_GOODS'
  return categoryOf(kind as Parameters<typeof categoryOf>[0]) satisfies CostCategory
}

/** One stock key's moves up to the date, summed (the database's GROUP BY over the moves and their valuations). */
export interface KeyBalance {
  readonly companyId: string
  readonly siteId: string
  readonly itemId: string
  readonly itemColourId: string | null
  readonly lotId: string | null
  readonly hideId: string | null
  /** Σ base quantity, signed (+ in, − out). */
  readonly quantity: DecimalInput
  /** Σ of its valuations' signed quantities. */
  readonly valuedQuantity: DecimalInput
  /** Σ of its valuations' amounts, minor units. */
  readonly value: number
  /** Its moves that change the site's stock and have no value. */
  readonly unvaluedMoves: number
  readonly methods: readonly ValuationMethod[]
  readonly currencies: readonly string[]
}

/** A row of the report: one site's item in one colour and lot (hides rolled into their lot). */
export interface ValuationRow {
  readonly companyId: string
  readonly siteId: string
  readonly itemId: string
  readonly itemColourId: string | null
  readonly lotId: string | null
  readonly quantity: Decimal
  readonly valuedQuantity: Decimal
  readonly value: number
  readonly unvaluedMoves: number
  /** Hides of the lot with stock on the date (0 for an item not tracked by hide). */
  readonly hides: number
  readonly methods: readonly ValuationMethod[]
  /** The valuations' currency; null when none, or more than one. */
  readonly currency: string | null
  readonly valued: ValuedState
}

/** A key whose stock is gone but whose valuations do not add up to 0 (the rounding of lot costs): kept apart. */
export interface Residue {
  readonly companyId: string
  readonly siteId: string
  readonly itemId: string
  readonly itemColourId: string | null
  readonly lotId: string | null
  readonly value: number
  readonly currency: string | null
}

const rowKey = (row: Pick<KeyBalance, 'siteId' | 'itemId' | 'itemColourId' | 'lotId'>): string => `${row.siteId}|${row.itemId}|${row.itemColourId ?? '-'}|${row.lotId ?? '-'}`

/**
 * The report's rows from the stock keys: hides rolled into their lot (and counted when they hold stock), a row for every
 * site item, colour and lot with stock on the date; a key set whose stock is gone but whose value is not 0 is a residue,
 * so Σ rows + Σ residues = Σ the ledger's values (nothing is lost on the way).
 */
export function valuationRows(balances: readonly KeyBalance[]): { rows: ValuationRow[]; residues: Residue[] } {
  interface Acc {
    companyId: string
    siteId: string
    itemId: string
    itemColourId: string | null
    lotId: string | null
    quantity: Decimal
    valuedQuantity: Decimal
    value: number
    unvaluedMoves: number
    hides: number
    methods: Set<ValuationMethod>
    currencies: Set<string>
  }
  const groups = new Map<string, Acc>()
  for (const balance of balances) {
    const key = rowKey(balance)
    const group =
      groups.get(key) ??
      ({ companyId: balance.companyId, siteId: balance.siteId, itemId: balance.itemId, itemColourId: balance.itemColourId, lotId: balance.lotId, quantity: ZERO, valuedQuantity: ZERO, value: 0, unvaluedMoves: 0, hides: 0, methods: new Set(), currencies: new Set() } satisfies Acc)
    const quantity = new Dec(balance.quantity)
    group.quantity = group.quantity.plus(quantity)
    group.valuedQuantity = group.valuedQuantity.plus(new Dec(balance.valuedQuantity))
    group.value += balance.value
    group.unvaluedMoves += balance.unvaluedMoves
    if (balance.hideId !== null && quantity.greaterThan(0)) group.hides += 1
    for (const method of balance.methods) group.methods.add(method)
    for (const currency of balance.currencies) group.currencies.add(currency)
    groups.set(key, group)
  }
  const rows: ValuationRow[] = []
  const residues: Residue[] = []
  for (const group of groups.values()) {
    const currency = group.currencies.size === 1 ? [...group.currencies][0]! : null
    if (!group.quantity.greaterThan(0)) {
      if (group.value !== 0) residues.push({ companyId: group.companyId, siteId: group.siteId, itemId: group.itemId, itemColourId: group.itemColourId, lotId: group.lotId, value: group.value, currency })
      continue
    }
    const valued: ValuedState = group.unvaluedMoves === 0 ? 'FULL' : group.methods.size === 0 ? 'NONE' : 'PART'
    rows.push({
      companyId: group.companyId,
      siteId: group.siteId,
      itemId: group.itemId,
      itemColourId: group.itemColourId,
      lotId: group.lotId,
      quantity: group.quantity,
      valuedQuantity: group.valuedQuantity,
      value: group.value,
      unvaluedMoves: group.unvaluedMoves,
      hides: group.hides,
      methods: [...group.methods].sort(),
      currency,
      valued,
    })
  }
  return { rows, residues }
}

/** What the ledger holds per base unit: value ÷ quantity, six places (null without stock). */
export function unitCostOf(value: number, quantity: DecimalInput, currency: string): string | null {
  const q = new Dec(quantity)
  if (!q.greaterThan(0)) return null
  return fromMinorUnits(value, currency).dividedBy(q).toDecimalPlaces(COST_SCALE, Dec.ROUND_HALF_UP).toFixed(COST_SCALE)
}

/**
 * Whether the company's costing method could value this figure differently from the ledger. Undecided: yes, always. A
 * standard-cost company: unless every valuation is at the item's standard cost. Moving average or FIFO: yes (the ledger
 * values a lot at its own average; the method is recorded on the cost ledger, not applied to stock: B-W2a-21).
 */
export function dependsOnMethod(method: CostingMethod, methods: readonly ValuationMethod[]): boolean {
  if (method === 'STANDARD') return methods.length === 0 || methods.some((one) => one !== 'STANDARD_COST')
  return true
}

const BASIS_WORDS: Readonly<Record<ValuationMethod, string>> = {
  PURCHASE_PRICE: "a receipt at its purchase order's price",
  LOT_COST: "stock leaving at its lot's average cost",
  STANDARD_COST: "the item's standard cost (opening stock, untracked items, finished garments)",
  MANUAL: 'a cost typed with a reason',
}

/** What a row's value rests on, in words. */
export function basisWords(methods: readonly ValuationMethod[], valued: ValuedState, unvaluedMoves: number): string {
  if (valued === 'NONE') return `No value: ${unvaluedMoves} move(s) of this stock have no cost yet (no purchase price, lot cost or standard cost).`
  const parts = methods.map((method) => BASIS_WORDS[method]).join('; ')
  const rest = valued === 'PART' ? ` ${unvaluedMoves} move(s) have no cost yet: the value covers only the valued quantity.` : ''
  return `As the stock ledger valued each move: ${parts}.${rest}`
}

/** The company's method beside the figures, and the accountant's open question. */
export function valuationMethodWords(method: CostingMethod): string {
  if (method === 'UNDECIDED') {
    return 'The costing method is not chosen yet (the accountant decides: standard, moving average or FIFO, c.c. art. 2426): these values are the stock ledger\'s and are provisional. A chosen method may value the same stock differently; whether to revalue what was posted before is the accountant\'s question.'
  }
  const name = { STANDARD: 'standard cost', MOVING_AVERAGE: 'moving average', FIFO: 'FIFO' }[method]
  return `The company's costing method is ${name}. These values are the stock ledger's (each move as it was valued); a figure marked "depends on the method" may differ under ${name}, and whether to revalue it is the accountant's question.`
}

// ---- work in progress ----------------------------------------------------------------------------------------------------

/** One work order's ledger up to the date. */
export interface WipFacts {
  readonly workOrderId: string
  readonly value: number
  readonly entries: number
}

/**
 * WIP rows: every work order whose ledger does not add up to 0 on the date. An open one's balance is its work in
 * progress; a done one's (completed, closed or cancelled by then) is the variance its close will write off (MES-012,
 * W2b): the API says which.
 */
export function wipRows(facts: readonly WipFacts[]): WipFacts[] {
  return facts.filter((row) => row.value !== 0)
}

// ---- value by area (SCM-256) ----------------------------------------------------------------------------------------------

/** The area in square metres of a quantity in an area unit; null for a unit of another dimension. */
export function areaM2(quantity: DecimalInput, uom: Uom): Decimal | null {
  if (dimensionOf(uom) !== 'AREA') return null
  const ratio = fixedRatio(uom, 'M2')
  return ratio === null ? null : new Dec(quantity).times(ratio)
}

/** Value per square metre (six places), null without an area. */
export function valuePerM2(value: number, area: Decimal | null, currency: string): string | null {
  if (area === null || !area.greaterThan(0)) return null
  return fromMinorUnits(value, currency).dividedBy(area).toDecimalPlaces(COST_SCALE, Dec.ROUND_HALF_UP).toFixed(COST_SCALE)
}

/** Totals per currency: Σ value; the one currency, or null with the words when the rows hold several. */
export function totalsOf(values: readonly { readonly value: number; readonly currency: string | null }[]): { value: number | null; currency: string | null; words: string | null } {
  const currencies = new Set(values.map((row) => row.currency).filter((currency): currency is string => currency !== null))
  if (currencies.size > 1) return { value: null, currency: null, words: 'The stock in view is valued in more than one currency: choose one company to see the total.' }
  return { value: values.reduce((sum, row) => sum + row.value, 0), currency: [...currencies][0] ?? null, words: null }
}
