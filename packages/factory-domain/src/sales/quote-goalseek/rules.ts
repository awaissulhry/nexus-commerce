import type { Issue } from '../../core/errors'
import { fitsDecimal, minorPlaces, UNIT_PRICE, type CurrencyCode } from '../../core/money'
import { decimalText } from '../../product/units/units'
import { Dec, HUNDRED, parseDecimal, type Decimal } from '../../tax/decimal'
import type { StartKind, WaterfallStep } from '../price-waterfall/rules'

/**
 * Target price goal-seek (B-W2b-302; SAL-150 "Brands give target prices"; design sales.quotes quote.price.goalseek "Target
 * price": the target unit price for a line or a target quote total, the discount needed, the resulting margin, the lines that
 * would fall under the floor; Apply writes the line prices with reason 'Target price'; held when the target is under cost),
 * pure. The API plans each line's waterfall with B-W2b-330's PUT …/price rules, shows them, and writes them the same way.
 *
 * A target is one of:
 *   UNIT_PRICE  each chosen line sells at this unit price (on the quote's basis: net for a business, VAT included for a
 *               consumer) — "Set price for 12 lines"
 *   DISCOUNT    each chosen line takes this discount off its start (the list price, or the price its waterfall starts from)
 *               — "Set discount"
 *   MARGIN      each chosen line earns this margin, percent of its net (the cost grain is needed: a price from a margin
 *               shows the cost); the price is rounded UP to the cent, so the margin is never under the one asked
 *   TOTAL       the chosen lines together make the quote's total this amount (on the quote's basis): one factor on their
 *               prices, rounded to the cent; what rounding leaves is said (`gap`)
 * The waterfall each line gets keeps its start (LIST, SUGGESTED, or a typed start with its reason) and its discount step, and
 * ends with a MANUAL step to the target net with the reason TARGET_PRICE (or the reason typed); DISCOUNT writes a discount
 * step instead. A price under the line's cost is held: goal-seek never writes it (an approver must allow a price under cost:
 * the person prices the line by hand, and the quote's margin rule asks for the yes).
 */

export const GOAL_KINDS = ['UNIT_PRICE', 'DISCOUNT', 'MARGIN', 'TOTAL'] as const
export type GoalKind = (typeof GOAL_KINDS)[number]

/** Each kind in words, without a figure (the answer's `words`). */
export const GOAL_KIND_WORDS: Readonly<Record<GoalKind, string>> = Object.freeze({ UNIT_PRICE: 'Target unit price', DISCOUNT: 'Target discount', MARGIN: 'Target margin', TOTAL: 'Target total' })

/** The reason a goal-seek writes (PRICE_ADJUSTMENT, B-W2b-280's standard reasons). */
export const TARGET_PRICE_REASON = 'TARGET_PRICE'

export interface GoalTarget {
  readonly kind: GoalKind
  readonly unitPrice?: string | null | undefined
  readonly pct?: string | null | undefined
  readonly marginPct?: string | null | undefined
  readonly amount?: string | null | undefined
}

const PCT = (value: string | null | undefined) => (value === undefined || value === null ? null : parseDecimal(value))

/** The target typed: the figure its kind needs, in range (money of the price grain; a margin of the margin grain). */
export function goalProblems(target: GoalTarget, at = 'body/target'): Issue[] {
  const price = (value: string | null | undefined) => {
    const parsed = PCT(value)
    return parsed !== null && parsed.gt(0) && fitsDecimal(value, UNIT_PRICE.precision, UNIT_PRICE.scale)
  }
  if (target.kind === 'UNIT_PRICE' && !price(target.unitPrice)) return [{ path: `${at}/unitPrice`, message: 'A target unit price above 0, at most 6 decimals.' }]
  if (target.kind === 'TOTAL' && !price(target.amount)) return [{ path: `${at}/amount`, message: 'A target total above 0, at most 6 decimals.' }]
  if (target.kind === 'DISCOUNT') {
    const pct = PCT(target.pct)
    if (pct === null || pct.lte(0) || pct.gte(100) || !fitsDecimal(target.pct, 7, 4)) return [{ path: `${at}/pct`, message: 'A discount above 0 and below 100 percent, at most 4 decimals.' }]
  }
  if (target.kind === 'MARGIN') {
    const pct = PCT(target.marginPct)
    if (pct === null || pct.lt(0) || pct.gte(100) || !fitsDecimal(target.marginPct, 7, 4)) return [{ path: `${at}/marginPct`, message: 'A margin from 0 to below 100 percent of the net, at most 4 decimals.' }]
  }
  return []
}

/** The discount a price is off a start, percent (4 places; below 0: a raise); null without a start above 0. */
export function discountNeeded(start: string | null, price: string): string | null {
  if (start === null) return null
  const from = new Dec(start)
  if (from.lte(0)) return null
  return decimalText(from.minus(new Dec(price)).times(HUNDRED).dividedBy(from).toDecimalPlaces(4, Dec.ROUND_HALF_UP))
}

/** A price × factor, rounded to the currency's minor unit (half up). */
export const scaledPrice = (price: string, factor: Decimal, currency: CurrencyCode): string => decimalText(new Dec(price).times(factor).toDecimalPlaces(minorPlaces(currency), Dec.ROUND_HALF_UP))

/**
 * The factor the chosen lines' prices take so that the total reaches `target`: (target − the other lines) ÷ the chosen
 * lines now. Null with words when the chosen lines make nothing now, or the others alone pass the target.
 */
export function totalFactor(target: string, chosenNow: Decimal, othersNow: Decimal): Decimal | { readonly problem: string } {
  if (chosenNow.lte(0)) return { problem: 'The chosen lines make nothing now: price them first.' }
  const left = new Dec(target).minus(othersNow)
  if (left.lte(0)) return { problem: 'The other lines alone make more than the target: choose more lines, or a higher target.' }
  return left.dividedBy(chosenNow)
}

/** What PUT …/price is sent to keep a line's start (B-W2b-330): its stored waterfall's, else its list price, else typed. */
export interface Restart {
  readonly start: StartKind
  readonly startPrice?: string
  readonly startReasonCode?: string
  readonly startNote?: string
  readonly discount?: { readonly pct: string; readonly reasonCode: string | null; readonly note: string | null }
  /** The start's price on the quote's basis (what a discount is taken off), or null (SUGGESTED: the API computes it). */
  readonly startUnitPrice: string | null
}

/**
 * The start a line's new waterfall keeps: the stored waterfall's first step (LIST, SUGGESTED, or MANUAL with its price and
 * reason) and its discount; without one, LIST when the list prices the line, else a typed start at the line's price now with
 * the reason TARGET_PRICE ("the price before the target").
 */
export function restartOf(stored: readonly WaterfallStep[] | null, listPrice: string | null, unitPrice: string): Restart {
  const first = stored?.[0]
  const discount = stored?.find((step) => step.kind === 'DISCOUNT')
  const kept = discount?.pct ? { discount: { pct: discount.pct, reasonCode: discount.reasonCode ?? null, note: discount.note ?? null } } : {}
  if (first?.kind === 'LIST' && listPrice !== null) return { start: 'LIST', startUnitPrice: listPrice, ...kept }
  if (first?.kind === 'SUGGESTED') return { start: 'SUGGESTED', startUnitPrice: first.unitPrice ?? null, ...kept }
  if (first?.kind === 'MANUAL' && first.unitPrice && first.reasonCode) return { start: 'MANUAL', startPrice: first.unitPrice, startReasonCode: first.reasonCode, ...(first.note ? { startNote: first.note } : {}), startUnitPrice: first.unitPrice, ...kept }
  if (listPrice !== null) return { start: 'LIST', startUnitPrice: listPrice }
  return { start: 'MANUAL', startPrice: unitPrice, startReasonCode: TARGET_PRICE_REASON, startNote: 'The price before the target.', startUnitPrice: unitPrice }
}

/** The goal in words ("Unit price 395.00 on 2 lines"). */
export function goalWords(target: GoalTarget, lines: number, currency: CurrencyCode): string {
  const money = (value: string | null | undefined) => (value ? `${new Dec(value).toFixed(minorPlaces(currency))} ${currency}` : '—')
  const on = `${lines} line${lines === 1 ? '' : 's'}`
  if (target.kind === 'UNIT_PRICE') return `Unit price ${money(target.unitPrice)} on ${on}`
  if (target.kind === 'DISCOUNT') return `${decimalText(target.pct ?? '0')} % off the start on ${on}`
  if (target.kind === 'MARGIN') return `A margin of ${decimalText(target.marginPct ?? '0')} % on ${on}`
  return `A total of ${money(target.amount)} from ${on}`
}
