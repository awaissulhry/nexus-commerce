import type { Issue } from '../../core/errors'
import { Dec, type Decimal, type DecimalInput } from '../../tax/decimal'
import { QUANTITY_SCALE, quantityOf, quantityText, stockKeyOf, type StockKey } from './moves'

/**
 * A stock count's differences as COUNT moves (PLAN §2.8 and Q33: the 31 Dec year-end count; SCM-224 and SCM-230 bring
 * the count sessions in W2a): for each stock key counted at one location, the system's balance there (read under the
 * stock locks) against what was counted. More counted than held → a COUNT move into the location; less → a COUNT move
 * out of it; the same → nothing. Every COUNT move says why (the count, its sheet). Pure.
 */

export interface CountedLine extends StockKey {
  /** What was counted, in the item's base unit; 0 when nothing was found. */
  readonly counted: DecimalInput
}

export interface CountDifference extends StockKey {
  readonly index: number
  readonly locationId: string
  readonly system: string
  readonly counted: string
  /** counted − system: + found more, − found less. */
  readonly difference: string
  /** The COUNT move that books it, or null when the count agrees. */
  readonly move: {
    readonly reason: 'COUNT'
    readonly fromLocationId: string | null
    readonly toLocationId: string | null
    readonly baseQuantity: string
  } | null
}

/** What is wrong with the counted lines (paths `lines/<i>/…`): a quantity that is not a decimal from 0, a key twice. */
export function countProblems(lines: readonly CountedLine[]): Issue[] {
  const problems: Issue[] = []
  const seen = new Map<string, number>()
  lines.forEach((line, index) => {
    const counted = quantityOf(line.counted)
    if (counted === null || counted.isNegative() || counted.decimalPlaces() > QUANTITY_SCALE) {
      problems.push({ path: `lines/${index}/counted`, message: `Expected a decimal from 0, with at most ${QUANTITY_SCALE} decimals.` })
    }
    const key = stockKeyOf(line)
    const first = seen.get(key)
    if (first !== undefined) problems.push({ path: `lines/${index}`, message: `The same stock as line ${first + 1}; count each stock once.` })
    else seen.set(key, index)
  })
  return problems
}

/** The differences of a count at one location against the balances there (`system`, read under the stock locks). */
export function countDifferences(locationId: string, lines: readonly CountedLine[], system: (line: CountedLine) => DecimalInput): CountDifference[] {
  return lines.map((line, index) => {
    const held: Decimal = new Dec(system(line))
    const counted = new Dec(line.counted)
    const difference = counted.minus(held)
    const key: StockKey = { siteId: line.siteId, itemId: line.itemId, itemColourId: line.itemColourId ?? null, lotId: line.lotId ?? null, hideId: line.hideId ?? null }
    return {
      ...key,
      index,
      locationId,
      system: quantityText(held),
      counted: quantityText(counted),
      difference: quantityText(difference),
      move: difference.isZero()
        ? null
        : {
            reason: 'COUNT' as const,
            fromLocationId: difference.isNegative() ? locationId : null,
            toLocationId: difference.isNegative() ? null : locationId,
            baseQuantity: quantityText(difference.abs()),
          },
    }
  })
}
