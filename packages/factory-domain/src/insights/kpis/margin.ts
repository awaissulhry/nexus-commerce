import { Dec, type Decimal } from '../../tax/decimal'

/**
 * Margin per order, customer and style, quoted against actual (B-W2b-429; ANA-021 "quoted against actual margin per order,
 * rolled up by customer and style, only with the margin grain"; "margin per order, with standard versus actual cost"), pure.
 * On the garments that LEFT, each with its cost of goods sold posted at shipment (B-W2b-407: CostOfSalesEntry, the cost of
 * the garments from stock or at their frozen standard) and a cost at order on its sales order line:
 *
 *   value          the net value of the garments that left: the line's net × garments shipped ÷ garments ordered (half up
 *                  to the minor unit), in the company's currency at the day's rate
 *   quoted cost    the line's cost at order × the same share
 *   actual cost    the cost of goods sold posted for them (a reversed entry, and its reversal, left out)
 *   quoted margin  value − quoted cost; actual margin value − actual cost; their percent of the value
 *
 * A garment whose cost of goods sold waits (the accountant's switch is off, B-W2b-407) or whose line has no cost at order is
 * left out of both, so the two percents compare the same garments. KPI files sales.margin_quoted and sales.margin_actual
 * read the layer (margin.shipped_value, margin.quoted, margin.actual); the drill rolls the same rows up per order,
 * customer and style. Margin needs the margin grain; costs the cost grain (Owner answer S2).
 */

/** A share of a line's amount for some of its garments, in minor units, half up. */
export function shareOf(amount: number, garments: number, ordered: number): number {
  if (ordered <= 0) return 0
  return new Dec(amount).times(garments).div(ordered).toDecimalPlaces(0, Dec.ROUND_HALF_UP).toNumber()
}

export interface MarginFigures {
  readonly value: number
  readonly quotedCost: number
  readonly actualCost: number
}

export interface MarginView extends MarginFigures {
  readonly quotedMargin: number
  readonly actualMargin: number
  /** Percent of the value, one decimal; null on no value. */
  readonly quotedPct: string | null
  readonly actualPct: string | null
  /** Actual percent − quoted percent, percentage points. */
  readonly changePts: string | null
}

const pct = (part: number, whole: number) => (whole === 0 ? null : new Dec(part).div(whole).times(100))

/** Adds figures. */
export const addFigures = (rows: readonly MarginFigures[]): MarginFigures =>
  rows.reduce((sum, row) => ({ value: sum.value + row.value, quotedCost: sum.quotedCost + row.quotedCost, actualCost: sum.actualCost + row.actualCost }), { value: 0, quotedCost: 0, actualCost: 0 })

/** The margins of figures (percents of the sums). */
export function marginOf(figures: MarginFigures): MarginView {
  const quotedMargin = figures.value - figures.quotedCost
  const actualMargin = figures.value - figures.actualCost
  const quoted = pct(quotedMargin, figures.value)
  const actual = pct(actualMargin, figures.value)
  const text = (value: Decimal | null) => (value === null ? null : value.toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1))
  return { ...figures, quotedMargin, actualMargin, quotedPct: text(quoted), actualPct: text(actual), changePts: quoted === null || actual === null ? null : text(actual.minus(quoted)) }
}
