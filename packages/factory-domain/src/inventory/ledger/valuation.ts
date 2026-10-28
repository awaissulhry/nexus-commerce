import { toMinorUnits, type CurrencyCode, type MinorUnits } from '../../core/money'
import { Dec, parseDecimal, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'
import { directionOf, quantityText } from './moves'

/**
 * The value of a stock move (plan A1 §2.6: costs are office only; factory-db StockValuation, `@grain cost`), pure. A move
 * that enters or leaves the site's stock is valued once: its base quantity signed (+ in, − out) × a unit cost per base
 * unit, the amount rounded half up to minor units (the one rounding point, A1 §2.1). A transfer inside the site moves
 * no value. The valuation's idempotency key is `move:<moveId>`, so a retried command or handler values a move once.
 *
 * Which unit cost (`costBasis`), first that applies:
 *   1. the caller's own: a receipt at its purchase order line's price (PURCHASE_PRICE), an office correction with a
 *      typed cost (MANUAL);
 *   2. a reversal: its original's unit cost and method, so the two cancel exactly;
 *   3. a lot whose stock came in valued: the lot's cost (LOT_COST), the quantity-weighted average of the unit costs it
 *      came in with;
 *   4. the item's standard cost (STANDARD_COST, GAP-006);
 *   5. none: the move stays unvalued (an item without a standard cost), and the stock overview says so.
 */

export const VALUATION_METHODS = ['PURCHASE_PRICE', 'LOT_COST', 'STANDARD_COST', 'MANUAL'] as const
export type ValuationMethod = (typeof VALUATION_METHODS)[number]

/** Unit costs are Decimal(18,6) (factory-db). */
export const COST_SCALE = 6

/** The valuation's idempotency key: one valuation per move. */
export const valuationKey = (moveId: string): string => `move:${moveId}`

export interface CostBasis {
  readonly method: ValuationMethod
  /** Per base unit, in the item's currency. */
  readonly unitCost: Decimal
}

export interface BasisFacts {
  /** The caller's own cost (a receipt's purchase price, a typed cost). */
  readonly explicit?: { readonly method: ValuationMethod; readonly unitCost: DecimalInput } | null
  /** The reversed move's valuation, when this move is a reversal. */
  readonly reversed?: { readonly method: ValuationMethod; readonly unitCost: DecimalInput } | null
  /** The cost the move's lot came in with (lotUnitCost), when it has a lot. */
  readonly lotCost?: DecimalInput | null
  /** The item's standard cost per base unit. */
  readonly standardCost?: DecimalInput | null
}

const cost = (value: DecimalInput | null | undefined): Decimal | null => {
  if (value === null || value === undefined) return null
  const parsed = parseDecimal(value)
  return parsed === null || parsed.isNegative() ? null : parsed.toDecimalPlaces(COST_SCALE, Dec.ROUND_HALF_UP)
}

/** The unit cost a move is valued at, or null when nothing gives one (see above). */
export function costBasis(facts: BasisFacts): CostBasis | null {
  const explicit = cost(facts.explicit?.unitCost)
  if (facts.explicit && explicit) return { method: facts.explicit.method, unitCost: explicit }
  const reversed = cost(facts.reversed?.unitCost)
  if (facts.reversed && reversed) return { method: facts.reversed.method, unitCost: reversed }
  const lot = cost(facts.lotCost)
  if (lot) return { method: 'LOT_COST', unitCost: lot }
  const standard = cost(facts.standardCost)
  if (standard) return { method: 'STANDARD_COST', unitCost: standard }
  return null
}

/** One valuation as it came in or went out: its signed base quantity and unit cost. */
export interface ValuedQuantity {
  readonly quantity: DecimalInput
  readonly unitCost: DecimalInput
}

/**
 * The cost of a lot's stock (LOT_COST), from its valuations at the site: while it holds valued stock, the moving
 * average Σ(quantity × unit cost) ÷ Σ quantity over every valuation (what left at this cost leaves it unchanged, a
 * reversal takes back exactly what its original brought); once it is empty, the average of what came in. Rounded to six
 * decimals; null when nothing valued ever came in.
 */
export function lotUnitCost(valuations: Iterable<ValuedQuantity>): Decimal | null {
  let net = ZERO
  let netValue = ZERO
  let inQuantity = ZERO
  let inValue = ZERO
  for (const valuation of valuations) {
    const q = new Dec(valuation.quantity)
    const value = q.times(valuation.unitCost)
    net = net.plus(q)
    netValue = netValue.plus(value)
    if (q.greaterThan(0)) {
      inQuantity = inQuantity.plus(q)
      inValue = inValue.plus(value)
    }
  }
  const round = (value: Decimal) => value.toDecimalPlaces(COST_SCALE, Dec.ROUND_HALF_UP)
  if (net.greaterThan(0) && !netValue.isNegative()) return round(netValue.dividedBy(net))
  return inQuantity.isZero() ? null : round(inValue.dividedBy(inQuantity))
}

/** The StockValuation columns of a move valued at a unit cost. */
export interface MoveValue {
  /** The base quantity, signed: + entered the site's stock, − left it. Four decimals. */
  readonly quantity: string
  /** Six decimals. */
  readonly unitCost: string
  /** quantity × unit cost in minor units, rounded half up, signed like the quantity. */
  readonly valueAmount: MinorUnits
}

/** The value of a move that enters or leaves the site's stock; null for a transfer inside it (no value moves). */
export function valueOfMove(
  move: { readonly fromLocationId: string | null; readonly toLocationId: string | null; readonly baseQuantity: DecimalInput },
  unitCost: DecimalInput,
  currency: CurrencyCode,
): MoveValue | null {
  const direction = directionOf(move)
  if (direction !== 'IN' && direction !== 'OUT') return null
  const base = new Dec(move.baseQuantity)
  const signed = direction === 'IN' ? base : base.negated()
  const perUnit = new Dec(unitCost).toDecimalPlaces(COST_SCALE, Dec.ROUND_HALF_UP)
  if (perUnit.isNegative()) throw new RangeError('a unit cost is never below 0')
  const amount = toMinorUnits(signed.times(perUnit), currency)
  return { quantity: quantityText(signed), unitCost: perUnit.toFixed(COST_SCALE), valueAmount: amount === 0 ? 0 : amount }
}

/** The value of stock on hand at a unit cost, in minor units (the overview's figure for the cost grain). */
export const stockValue = (onHand: DecimalInput, unitCost: DecimalInput, currency: CurrencyCode): MinorUnits => {
  const amount = toMinorUnits(new Dec(onHand).times(unitCost), currency)
  return amount === 0 ? 0 : amount
}
