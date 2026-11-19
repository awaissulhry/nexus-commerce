import { isCurrencyCode, minorPlaces, type CurrencyCode, type DecimalString, type MinorUnits } from '../../core/money'
import { Dec, parseDecimal } from '../../tax/decimal'

/**
 * The price check (customer page lane B-CP-010; picks D4, D5; review G5, B4), pure: our price beside the customer's own
 * price for the same order (its PO, its portal draft, or typed by us), per line and for the whole order.
 *
 *   net of VAT     both sides are compared without VAT (VAT and the tax mode are ours, never the customer's).
 *   currency       the order's; a customer's price in another currency is never converted and never used: it is counted
 *                  (`priceOtherCurrency`) so the screen can say "in another currency".
 *   tolerance 0    exact to the minor unit: one cent off is NOT_EQUAL.
 *   line amount    the customer's line total (`netAmount`), else its unit price × the line's pieces, rounded half up to the
 *                  currency's minor unit. Comparing line amounts covers size surcharges and amended quantities.
 *   counted lines  the lines the order's net counts, less a line with no pieces (a split or a removal leaves it at 0; never a
 *                  false NOT_EQUAL) and a free line (our net 0) the customer gave no price for. A line not counted has
 *                  `priceMatch: null`.
 *   order price    the customer's total row (one per order), else the sum of the line amounts when every counted line has
 *                  one (and there is at least one), else none.
 *   order check    NOT_EQUAL when a line is NOT_EQUAL or the order price differs from ours (a known difference wins over a
 *                  missing price); else NO_BRAND_PRICE when there is no order price ("no customer price yet" is never
 *                  EQUAL); else EQUAL.
 *   difference     our price − the customer's: + we ask more, − we ask less; null when the customer's is not known.
 *
 * Computed on every read, never stored (D5): nothing closes a NOT_EQUAL but a change of one of the two prices. Every output
 * field has a money-looking name (`brandPrice`, `brandAmount`, `priceMatch`, `priceDiff`, `price…Lines`, `priceOtherCurrency`)
 * so the contracts that carry it mark it `money.price` and the grain filter keeps it from anyone without the price grain.
 */

export const PRICE_MATCHES = ['EQUAL', 'NOT_EQUAL', 'NO_BRAND_PRICE'] as const
export type PriceMatch = (typeof PRICE_MATCHES)[number]

/** One line of the order, as our side has it. */
export interface PriceCheckLine {
  readonly lineId: string
  /** The line's pieces (0: a line emptied by a split or a removal). */
  readonly pieces: number
  /** Our line net, without VAT, in the order's minor units (SalesOrderLine.netAmount). */
  readonly ourNet: MinorUnits
}

/** One row of the customer's price (OrderBrandPrice): a line row, or the order's total row (`lineId` null). */
export interface BrandPriceRow {
  /** The order line it prices; null: the customer's total for the whole order. */
  readonly lineId: string | null
  /** The customer's net unit price (a line row), a plain decimal string. */
  readonly unitPrice: DecimalString | null
  /** The customer's line total, or the total row's amount, in minor units. */
  readonly netAmount: MinorUnits | null
  readonly currency: CurrencyCode
}

export interface PriceCheckInput {
  /** The order's currency. */
  readonly currency: CurrencyCode
  /** Our order net without VAT (SalesOrder.netAmount). */
  readonly ourNet: MinorUnits
  readonly lines: readonly PriceCheckLine[]
  readonly brand: readonly BrandPriceRow[]
}

export interface PriceCheckLineResult {
  readonly lineId: string
  /** The customer's amount for the line in minor units; null: none (or the line is not counted). */
  readonly brandAmount: MinorUnits | null
  /** null: the line is not checked (no pieces, or free with no customer price). */
  readonly priceMatch: PriceMatch | null
  /** Our line net − the customer's; null when the customer's is not known. */
  readonly priceDiff: MinorUnits | null
}

export interface PriceCheckTotal {
  /** Our order net (the input, echoed so the answer carries both sides). */
  readonly ourPrice: MinorUnits
  /** The customer's price for the whole order; null: not known yet. */
  readonly brandPrice: MinorUnits | null
  readonly priceMatch: PriceMatch
  /** Our price − the customer's; null when the customer's is not known. */
  readonly priceDiff: MinorUnits | null
  /** Counted lines whose customer's amount differs from ours. */
  readonly priceNotEqualLines: number
  /** Counted lines without a customer's price (in the order's currency). */
  readonly priceMissingLines: number
  /** The customer's rows left out because they are in another currency. */
  readonly priceOtherCurrency: number
}

export interface PriceCheck {
  readonly lines: readonly PriceCheckLineResult[]
  readonly total: PriceCheckTotal
}

/** The customer's amount of a row for a line of `pieces`, in minor units: its line total, else unit price × pieces (half up). */
export function brandAmountOf(row: Pick<BrandPriceRow, 'unitPrice' | 'netAmount'>, pieces: number, currency: CurrencyCode): MinorUnits | null {
  if (row.netAmount !== null) return row.netAmount
  if (row.unitPrice === null) return null
  const unit = parseDecimal(row.unitPrice)
  if (unit === null) return null
  const minor = unit.times(pieces).times(new Dec(10).pow(minorPlaces(currency))).toDecimalPlaces(0, Dec.ROUND_HALF_UP)
  return Number(minor.toFixed(0))
}

const sameCurrency = (a: CurrencyCode, b: CurrencyCode): boolean => isCurrencyCode(a) && a === b

/** The price check of one order (see the header). */
export function priceCheckOf(input: PriceCheckInput): PriceCheck {
  const { currency } = input
  let priceOtherCurrency = 0
  let totalRow: BrandPriceRow | null = null
  const byLine = new Map<string, BrandPriceRow>()
  for (const row of input.brand) {
    if (!sameCurrency(row.currency, currency)) {
      priceOtherCurrency += 1
      continue
    }
    // One row per line and one total row per order (the store's unique keys): a second one is not read.
    if (row.lineId === null) totalRow ??= row
    else if (!byLine.has(row.lineId)) byLine.set(row.lineId, row)
  }

  let priceNotEqualLines = 0
  let priceMissingLines = 0
  let counted = 0
  let lineSum = 0
  const lines = input.lines.map((line): PriceCheckLineResult => {
    const row = byLine.get(line.lineId) ?? null
    if (line.pieces <= 0 || (line.ourNet === 0 && row === null)) return { lineId: line.lineId, brandAmount: null, priceMatch: null, priceDiff: null }
    counted += 1
    const brandAmount = row === null ? null : brandAmountOf(row, line.pieces, currency)
    if (brandAmount === null) {
      priceMissingLines += 1
      return { lineId: line.lineId, brandAmount: null, priceMatch: 'NO_BRAND_PRICE', priceDiff: null }
    }
    lineSum += brandAmount
    const priceMatch: PriceMatch = brandAmount === line.ourNet ? 'EQUAL' : 'NOT_EQUAL'
    if (priceMatch === 'NOT_EQUAL') priceNotEqualLines += 1
    return { lineId: line.lineId, brandAmount, priceMatch, priceDiff: line.ourNet - brandAmount }
  })

  const fromTotal = totalRow === null ? null : totalRow.netAmount
  const brandPrice = fromTotal ?? (counted > 0 && priceMissingLines === 0 ? lineSum : null)
  const priceMatch: PriceMatch = priceNotEqualLines > 0 || (brandPrice !== null && brandPrice !== input.ourNet) ? 'NOT_EQUAL' : brandPrice === null ? 'NO_BRAND_PRICE' : 'EQUAL'
  return {
    lines,
    total: {
      ourPrice: input.ourNet,
      brandPrice,
      priceMatch,
      priceDiff: brandPrice === null ? null : input.ourNet - brandPrice,
      priceNotEqualLines,
      priceMissingLines,
      priceOtherCurrency,
    },
  }
}
