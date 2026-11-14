import { Decimal } from 'decimal.js'
import { minorPlaces, type CurrencyCode } from '../../core/money'
import { decimalText } from '../../product/units/units'
import type { SheetCategory } from '../sheet-components/components'
import { six } from '../sheet-components/rules'

/**
 * Target price and goal-seek (B-W2b-420; FIN-013; design products.styles › Cost "Target price": "Type a target price or margin
 * and see the allowed cost and which lines must change" — Target, Allowed cost, Gap, Biggest lines), pure.
 *
 *   the cost        of the version at the basis asked: the weighted cost of the size mix, the base size's, or one size's
 *   price + margin  the allowed cost = price × (1 − margin ÷ 100); the gap = the cost − the allowed cost (above 0: the cost
 *                   must come down by it)
 *   price alone     the margin the price earns on the cost
 *   margin alone    the price that earns it: cost ÷ (1 − margin ÷ 100), rounded up to the currency's minor unit
 *   biggest lines   the version's plain lines (not the percent lines) by their cost at the basis, biggest first: each one's
 *                   share of the cost, the cut it alone would need to close the gap (null when even all of it is not
 *                   enough) and its part of the gap shared over the lines shown in proportion to their cost. The percent
 *                   lines on them (overhead on labour, freight and duty on materials) come down with them, so the cuts shown
 *                   are a little more than enough.
 */

export const GOAL_BASES = ['WEIGHTED', 'BASE_SIZE', 'SIZE'] as const
export type GoalBasis = (typeof GOAL_BASES)[number]

/** How many of the biggest lines are shown. */
export const GOAL_LINES = 5

export interface GoalLine {
  readonly id: string
  readonly seq: number
  readonly category: SheetCategory
  readonly label: string | null
  /** The line's cost at the basis (a line of another size counts 0 there). */
  readonly cost: string
  readonly percent: boolean
}

export interface GoalInput {
  /** The version's cost at the basis; null while it misses an input. */
  readonly cost: string | null
  readonly targetPrice: string | null
  readonly targetMarginPct: string | null
  readonly lines: readonly GoalLine[]
  readonly currency: CurrencyCode
}

export interface GoalLineView {
  readonly id: string
  readonly seq: number
  readonly category: SheetCategory
  readonly label: string | null
  readonly cost: string
  /** Percent of the cost, 1 place. */
  readonly sharePct: string
  /** The cut this line alone needs, percent of its cost, 1 place rounded up; null: not enough alone (or no gap). */
  readonly cutAlonePct: string | null
  /** Its part of the gap shared over the lines shown, in proportion to their cost; null without a gap. */
  readonly cutShared: string | null
}

export const GOAL_STATES = ['NO_COST', 'NO_TARGET', 'WITHIN', 'ABOVE', 'PRICE_ONLY', 'MARGIN_ONLY'] as const
export type GoalState = (typeof GOAL_STATES)[number]

export interface GoalResult {
  readonly state: GoalState
  readonly allowedCost: string | null
  /** The cost − the allowed cost: above 0 the cost must come down by it. */
  readonly gap: string | null
  /** The margin the target price earns on the cost (price alone or both). */
  readonly marginAtCost: string | null
  /** The price that earns the target margin on the cost (margin alone or both). */
  readonly priceForMargin: string | null
  readonly lines: readonly GoalLineView[]
}

export const GOAL_WORDS: Readonly<Record<GoalState, string>> = Object.freeze({
  NO_COST: 'The version misses an input at this basis: its cost is not complete, so nothing is worked out from it.',
  NO_TARGET: 'Type a target price, a target margin or both.',
  WITHIN: 'The cost is within the allowed cost: no line has to change.',
  ABOVE: 'The cost is above the allowed cost: the lines below must come down by the gap.',
  PRICE_ONLY: 'With a target price alone, this is the margin it earns on the cost; add a target margin to see the allowed cost.',
  MARGIN_ONLY: 'With a target margin alone, this is the price that earns it on the cost; add a target price to see the allowed cost.',
})

const HUNDRED = new Decimal(100)

/** The goal-seek of a version's cost (see the module comment). */
export function goalSeek(input: GoalInput): GoalResult {
  const none = { allowedCost: null, gap: null, marginAtCost: null, priceForMargin: null, lines: [] }
  if (input.cost === null) return { state: 'NO_COST', ...none }
  if (input.targetPrice === null && input.targetMarginPct === null) return { state: 'NO_TARGET', ...none }
  const cost = new Decimal(input.cost)
  const price = input.targetPrice === null ? null : new Decimal(input.targetPrice)
  const margin = input.targetMarginPct === null ? null : new Decimal(input.targetMarginPct)
  const marginAtCost = price !== null && price.gt(0) ? decimalText(price.minus(cost).dividedBy(price).times(HUNDRED).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)) : null
  const priceForMargin = margin !== null && margin.lt(100) ? decimalText(cost.times(HUNDRED).dividedBy(HUNDRED.minus(margin)).toDecimalPlaces(minorPlaces(input.currency), Decimal.ROUND_UP)) : null
  const plain = input.lines.filter((line) => !line.percent && new Decimal(line.cost).gt(0)).sort((a, b) => new Decimal(b.cost).comparedTo(a.cost) || a.seq - b.seq)
  const shown = plain.slice(0, GOAL_LINES)
  const share = (value: Decimal) => (cost.isZero() ? '0' : decimalText(value.dividedBy(cost).times(HUNDRED).toDecimalPlaces(1, Decimal.ROUND_HALF_UP)))
  if (price === null || margin === null) {
    return { state: price === null ? 'MARGIN_ONLY' : 'PRICE_ONLY', allowedCost: null, gap: null, marginAtCost, priceForMargin, lines: shown.map((line) => ({ id: line.id, seq: line.seq, category: line.category, label: line.label, cost: line.cost, sharePct: share(new Decimal(line.cost)), cutAlonePct: null, cutShared: null })) }
  }
  const allowed = price.times(HUNDRED.minus(margin)).dividedBy(HUNDRED)
  const gap = cost.minus(allowed)
  const shownTotal = shown.reduce((sum, line) => sum.plus(line.cost), new Decimal(0))
  const lines = shown.map((line) => {
    const value = new Decimal(line.cost)
    const above = gap.gt(0)
    const alone = above && gap.lte(value) ? decimalText(gap.dividedBy(value).times(HUNDRED).toDecimalPlaces(1, Decimal.ROUND_UP)) : null
    const shared = above && shownTotal.gt(0) ? six(gap.times(value).dividedBy(shownTotal)) : null
    return { id: line.id, seq: line.seq, category: line.category, label: line.label, cost: line.cost, sharePct: share(value), cutAlonePct: alone, cutShared: shared }
  })
  return { state: gap.gt(0) ? 'ABOVE' : 'WITHIN', allowedCost: six(allowed), gap: six(gap), marginAtCost, priceForMargin, lines }
}

/**
 * The version's lines as the goal-seek weighs them: one per line of every size, or per line written once per size (the same
 * category, source, record, material and words), at its cost at the basis.
 */
export function goalLinesOf(lines: readonly { readonly id: string; readonly seq: number; readonly category: SheetCategory; readonly source: string; readonly sourceRecordId: string | null; readonly itemId: string | null; readonly label: string | null; readonly size: string | null; readonly cost: string; readonly pct: string | null }[], at: { readonly size: string } | { readonly weights: Readonly<Record<string, string>> }): GoalLine[] {
  const groups = new Map<string, { line: GoalLine; total: Decimal }>()
  for (const line of lines) {
    const key = [line.category, line.source, line.sourceRecordId ?? '', line.itemId ?? '', line.label ?? '', line.pct === null ? 'plain' : 'pct'].join('|')
    const cost = lineCostAt(line, at)
    const group = groups.get(key)
    if (group) group.total = group.total.plus(cost)
    else groups.set(key, { line: { id: line.id, seq: line.seq, category: line.category, label: line.label, cost, percent: line.pct !== null }, total: new Decimal(cost) })
  }
  return [...groups.values()].map(({ line, total }) => ({ ...line, cost: six(total) }))
}

/** A line's cost at a basis: its cost in one size, or its weighted cost over the mix (a line of another size counts 0 there). */
export function lineCostAt(line: { readonly size: string | null; readonly cost: string }, at: { readonly size: string } | { readonly weights: Readonly<Record<string, string>> }): string {
  if ('size' in at) return line.size === null || line.size === at.size ? line.cost : '0'
  const entries = Object.entries(at.weights)
  const sum = entries.reduce((total, [, weight]) => total.plus(weight), new Decimal(0))
  if (sum.isZero()) return '0'
  const part = entries.reduce((total, [size, weight]) => (line.size === null || line.size === size ? total.plus(new Decimal(line.cost).times(weight)) : total), new Decimal(0))
  return six(part.dividedBy(sum))
}
