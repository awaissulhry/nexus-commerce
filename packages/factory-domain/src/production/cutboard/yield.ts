import { plusDays } from '../../calendars/dates'
import { Dec } from '../../tax/decimal'
import { addTotals, yieldFigures, type YieldFigures, type YieldTotals } from '../yield/rules'
import { sharePct } from './board'

/**
 * The cutting and yield report (B-W2b-130; MES-302 "Cutting and yield report"; design production.reports "Cutting and yield": "Cut
 * vs ordered, material used, yield per hide lot and supplier"), pure. One site and a period of whole days ending on a day:
 *
 *   cut vs ordered   the cut orders cut in the period: a reconciled line's frozen figures (MES-045), else a fabric line's ratio ×
 *                    the plies counted on its cut lays; a leather line not yet reconciled has no figure of its own (the cut log
 *                    names no cut order): its cut order is counted as waiting, never guessed
 *   material used    fabric in metres per material (the lays' estimate against the fabric confirmed), leather in its area unit
 *                    per material (the cut log)
 *   yield            per hide lot and per supplier, from the cut log (factory-domain production/yield): areas added first, the
 *                    percentages of the sums; the plan is what the BOM's wastage expects (a lot serves several styles)
 *
 * Counts, lengths, areas and percentages only: no money, and nothing per cutter (SCM-255; Statuto dei Lavoratori art. 4).
 */

/** The periods the report offers, in days ending on the chosen day; 30 by default. */
export const YIELD_PERIODS = [7, 30, 90] as const
export type YieldPeriod = (typeof YIELD_PERIODS)[number]
export const DEFAULT_YIELD_PERIOD: YieldPeriod = 30
/** The longest period the API reads (a year), whatever the dates asked. */
export const MAX_YIELD_DAYS = 366
/** How many cut orders the report lists (newest cut first); the sums count them all. */
export const YIELD_ORDER_LIMIT = 50

export const isYieldPeriod = (value: number): value is YieldPeriod => (YIELD_PERIODS as readonly number[]).includes(value)

/** The first day of a period of `days` days ending on `to` (both included). */
export const periodFrom = (to: string, days: number): string => plusDays(to, -(Math.max(1, days) - 1))

/** A cut order line's figures: cut null while it waits for its reconciliation (a leather line). */
export interface CutLineFigures {
  readonly ordered: number
  readonly cut: number | null
  /** Reconciled with a variance reason. */
  readonly variance: boolean
}

export interface CutSums {
  /** Cut orders with every line known. */
  readonly orders: number
  readonly ordered: number
  readonly cut: number
  /** cut − ordered. */
  readonly difference: number
  /** cut ÷ ordered, whole percent; null when nothing was ordered. */
  readonly pct: number | null
  /** Cut orders with a line whose cut waits for its reconciliation (left out of the sums). */
  readonly waiting: number
  /** Lines reconciled with a variance reason. */
  readonly variances: number
}

/** The sums of cut vs ordered over cut orders (each its lines); an order with an unknown line counts as waiting only. */
export function cutSums(orders: readonly (readonly CutLineFigures[])[]): CutSums {
  let known = 0
  let ordered = 0
  let cut = 0
  let waiting = 0
  let variances = 0
  for (const lines of orders) {
    variances += lines.filter((line) => line.variance).length
    if (lines.some((line) => line.cut === null)) {
      waiting += 1
      continue
    }
    known += 1
    ordered += lines.reduce((sum, line) => sum + line.ordered, 0)
    cut += lines.reduce((sum, line) => sum + (line.cut ?? 0), 0)
  }
  return { orders: known, ordered, cut, difference: cut - ordered, pct: sharePct(cut, ordered), waiting, variances }
}

/** Groups yield sums by a key (a lot, a supplier and unit, a material), in the order keys are first met. */
export function groupTotals<Fact>(rows: readonly Fact[], keyOf: (row: Fact) => string, totalsOf: (row: Fact) => YieldTotals): { key: string; first: Fact; rows: Fact[]; totals: YieldTotals }[] {
  const groups = new Map<string, { key: string; first: Fact; rows: Fact[]; parts: YieldTotals[] }>()
  for (const row of rows) {
    const key = keyOf(row)
    const group = groups.get(key) ?? { key, first: row, rows: [], parts: [] }
    group.rows.push(row)
    group.parts.push(totalsOf(row))
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => ({ key: group.key, first: group.first, rows: group.rows, totals: addTotals(group.parts) }))
}

/** A group's figures, the plan from the BOM's wastage (several styles: no one style's planned yield applies). */
export const groupFigures = (totals: YieldTotals): YieldFigures => yieldFigures(totals)

/** Yield rows worst first (the lowest yield; unknown last), then by name: the lot to talk to the supplier about comes first. */
export function worstFirst<Row extends { readonly yieldPct: string | null; readonly name: string }>(rows: readonly Row[]): Row[] {
  return [...rows].sort((a, b) => {
    if (a.yieldPct === null || b.yieldPct === null) return a.yieldPct === b.yieldPct ? a.name.localeCompare(b.name) : a.yieldPct === null ? 1 : -1
    const diff = new Dec(a.yieldPct).comparedTo(new Dec(b.yieldPct))
    return diff !== 0 ? diff : a.name.localeCompare(b.name)
  })
}
