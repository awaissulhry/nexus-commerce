import { Dec, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'
import type { AbcClass } from './schedules'

/**
 * The ABC class of a site's materials (B-W2b-299; SCM-227 "a schedule per ABC class"): materials ranked by the value they
 * used over the last year (their issues to work orders, at the cost the ledger valued them; the cost grain), largest first.
 * A: the few that make the first 80 % of the value; B: the next 15 %; C: the rest, and every material that used nothing.
 * Computed, never stored (no Item column: B-W2b-277's note): a class follows the use. Pure.
 */

export interface AbcRules {
  /** The share of the value (percent, cumulative) the A materials make. */
  readonly aPercent: number
  /** The share A and B make together. */
  readonly bPercent: number
  /** The days of use read back from today. */
  readonly days: number
}

export const ABC_RULES: AbcRules = Object.freeze({ aPercent: 80, bPercent: 95, days: 365 })

export interface Usage {
  readonly itemId: string
  /** What it used in the period, as a cost (any unit, the same for every material); 0 or more. */
  readonly value: DecimalInput
  /** Its code (the order of equal values). */
  readonly code: string
}

export interface Classified {
  readonly itemId: string
  readonly abcClass: AbcClass
  /** Its place in the ranking, 1 = the largest use. */
  readonly rank: number
  /** Its share of the whole value, percent, one decimal (null when nothing was used at all). */
  readonly sharePercent: string | null
}

/**
 * Classes from the use: a material is A while the value ranked before it is under the A share (so the material that
 * crosses 80 % is still A), B while under the B share, C after; nothing used: C.
 */
export function abcClassesOf(usages: readonly Usage[], rules: AbcRules = ABC_RULES): Classified[] {
  const ranked = [...usages].sort((a, b) => {
    const order = new Dec(b.value).comparedTo(new Dec(a.value))
    return order !== 0 ? order : a.code < b.code ? -1 : a.code > b.code ? 1 : a.itemId < b.itemId ? -1 : 1
  })
  const total = ranked.reduce<Decimal>((sum, usage) => sum.plus(Dec.max(new Dec(usage.value), ZERO)), ZERO)
  let before = ZERO
  return ranked.map((usage, index) => {
    const value = Dec.max(new Dec(usage.value), ZERO)
    const percentBefore = total.isZero() ? null : before.dividedBy(total).times(100)
    before = before.plus(value)
    const abcClass: AbcClass = value.isZero() || percentBefore === null ? 'C' : percentBefore.lessThan(rules.aPercent) ? 'A' : percentBefore.lessThan(rules.bPercent) ? 'B' : 'C'
    return { itemId: usage.itemId, abcClass, rank: index + 1, sharePercent: total.isZero() ? null : value.dividedBy(total).times(100).toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1) }
  })
}

/** The materials of one class. */
export const itemsOfClass = (classified: readonly Classified[], abcClass: AbcClass): Set<string> => new Set(classified.filter((entry) => entry.abcClass === abcClass).map((entry) => entry.itemId))
