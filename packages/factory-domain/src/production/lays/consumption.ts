import { lengthIn, lengthText, numberText, type Language, type LengthUom } from '../../inventory/rolls/rolls'
import { Dec, ZERO, type Decimal } from '../../tax/decimal'
import { rollUse } from './rules'

/**
 * Fabric used at cut finish (B-W2b-116; MES-046 "Actual consumption at cut finish"; design floor.fabriccut "Fabric used": "Estimate,
 * the cut-log figure, and a QuantityPad to confirm or correct; the difference in words"), pure. One per lay once it is CUT, in
 * metres:
 *
 *   estimated  the marker × the plies counted (what the plan says the lay takes)
 *   recorded   the lay report: each roll's plies × the ply on the table, and its end loss (what came off the rolls)
 *   confirmed  what the cutter confirms (the recorded figure) or corrects, until the cut order is reconciled
 *
 * The first confirmation issues the lay's fabric to the cut order's work orders, roll by roll (the lay report's figures, so each
 * roll's length left falls by what came off it), split by each work order's garments in a ply (its lines' ratios): that is what
 * feeds the work orders' cost (the cost ledger posts the ISSUE moves). A later correction changes the confirmed figure only.
 * No money here: lengths only.
 */

export const CONSUMPTION_UOM = 'M' as const satisfies LengthUom

export interface ReportRoll {
  readonly plies: number
  /** In `uom`. */
  readonly endLoss: Decimal
  readonly uom: LengthUom
}

/** The marker × the plies counted, in metres. */
export const estimateOf = (marker: { readonly length: string; readonly uom: LengthUom }, plies: number): Decimal => lengthIn(marker.length, marker.uom, CONSUMPTION_UOM).times(plies)

/** The lay report's figure in metres: Σ plies × the ply (in metres) + end loss. */
export function recordedOf(rolls: readonly ReportRoll[], plyMetres: Decimal): Decimal {
  return rolls.reduce((sum, roll) => sum.plus(rollUse(roll.plies, plyMetres, lengthIn(roll.endLoss, roll.uom, CONSUMPTION_UOM))), ZERO)
}

/**
 * A length split by weights (each work order's garments in a ply), at four decimals; the last share takes what rounding left, so
 * the shares add up to the length exactly. Zero weights get nothing.
 */
export function splitByWeight<K>(length: Decimal, weights: readonly { readonly key: K; readonly weight: number }[]): { key: K; length: Decimal }[] {
  const live = weights.filter((entry) => entry.weight > 0)
  const all = live.reduce((sum, entry) => sum + entry.weight, 0)
  if (all === 0) return []
  let left = length
  return live.map((entry, index) => {
    const share = index === live.length - 1 ? left : length.times(entry.weight).dividedBy(all).toDecimalPlaces(4, Dec.ROUND_HALF_UP)
    left = left.minus(share)
    return { key: entry.key, length: share }
  })
}

/** "0.6 m more than the estimate (+5%)" (it "0,6 m in più della stima (+5%)"); "As estimated." when equal. */
export function differenceWords(confirmed: Decimal, estimated: Decimal, language: Language): string {
  const it = language === 'it'
  const difference = confirmed.minus(estimated)
  if (difference.isZero()) return it ? 'Come stimato.' : 'As estimated.'
  const more = difference.greaterThan(0)
  const percent = estimated.isZero() ? null : difference.abs().times(100).dividedBy(estimated)
  const share = percent === null ? '' : ` (${more ? '+' : '−'}${numberText(percent.toDecimalPlaces(1, Dec.ROUND_HALF_UP), language)}%)`
  const length = lengthText(difference.abs(), CONSUMPTION_UOM, language)
  if (it) return `${length} ${more ? 'in più' : 'in meno'} della stima${share}.`
  return `${length} ${more ? 'more' : 'less'} than the estimate${share}.`
}
