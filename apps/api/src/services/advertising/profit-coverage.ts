/**
 * ACR.0.5 — the one definition of "do we actually know this product's cost".
 *
 * Four separate code paths write ProductProfitDaily.trueProfitCents — the nightly roll-up,
 * its ad-spend patch, the FBA fee ingester, and the ads metrics ingester — and each of them
 * subtracts a different subset of components. What they must NOT do is disagree about when
 * the answer is knowable at all, so the predicate lives here and they all import it.
 *
 * The rule: a cost of zero against real revenue is a missing cost, not a free product.
 * Measured on prod 2026-08-05 that describes every row we have — costPrice null on 362/362
 * products, weightedAvgCostCents 240 null / 122 literally 0 / 0 real — and it is why
 * `coverage.hasCostPrice` could not be trusted on its own: it was written `true` for the 122
 * products whose stored cost was a zero, so 714 rows claimed a profit derived from €0 COGS.
 *
 * Rows with no revenue are exempt: zero units sold genuinely costs zero, and their profit
 * (the fees and ad spend they burned) is a fact worth keeping.
 */

export interface CostCoverageInput {
  grossRevenueCents: number
  cogsCents: number
  /** ProductProfitDaily.coverage — advisory only; the row's own numbers win. */
  coverage?: unknown
}

/** True when this row's cogsCents came from the interim estimate rather than from data. */
export function costIsEstimated(coverage: unknown): boolean {
  return (coverage as Record<string, unknown> | null)?.costEstimated === true
}

/** True when the row's profit can be computed honestly. */
export function costIsKnown(row: CostCoverageInput): boolean {
  if (row.grossRevenueCents <= 0) return true // nothing sold — no cost to miss
  return row.cogsCents > 0
}

/**
 * The profit to store: the computed figure when cost is known, null when it isn't.
 * `computed` is passed in because each caller nets a different set of components.
 */
export function profitOrUnknown(row: CostCoverageInput, computed: number): number | null {
  return costIsKnown(row) ? computed : null
}

/** Margin as a fraction, null whenever profit or revenue can't support one. */
export function marginOrUnknown(trueProfitCents: number | null, grossRevenueCents: number): number | null {
  if (trueProfitCents == null || grossRevenueCents <= 0) return null
  return trueProfitCents / grossRevenueCents
}

/**
 * The coverage flags to persist alongside. Rewritten from the row rather than carried
 * forward, so a flag that was set true under the old rule self-corrects on next write.
 */
export function coverageWithCost(
  prev: unknown,
  row: CostCoverageInput,
  extra: Record<string, boolean> = {},
): Record<string, boolean> {
  const base = (prev as Record<string, unknown> | null) ?? {}
  const out: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(base)) out[k] = v === true
  /**
   * ACR.4 — an ESTIMATED cost is a positive cogsCents, so recomputing `hasCostPrice` from the
   * row's numbers alone would flip it back to true on every subsequent write and quietly promote
   * the operator's guess to a measurement. `costEstimated` is carried forward and vetoes it.
   */
  const estimated = costIsEstimated(prev) || extra.costEstimated === true
  out.hasCostPrice = !estimated && costIsKnown(row) && row.cogsCents > 0
  out.costEstimated = estimated
  return { ...out, ...extra, hasCostPrice: out.hasCostPrice, costEstimated: estimated }
}

/** What the UI says in place of a number. Kept here so every surface says the same thing. */
export const PROFIT_UNKNOWN_REASON = 'No cost price loaded for this product yet'

/**
 * ACR.4 — the operator's interim cost estimate, so profit surfaces show something.
 *
 * Operator decision 2026-08-05: "use EUR 50 as a base cost of goods... at least have an estimate
 * of data, if not 100% accurate." Two adjustments were made before shipping it, both because a
 * FLAT 50 was measured to be actively harmful:
 *
 *  1. **It is capped to a share of the selling price.** The advertised catalogue runs from
 *     EUR 21.98 to EUR 399.95 (median 105). A flat 50 against a EUR 25.96 XS jacket or a
 *     EUR 21.99 knee slider says every sale loses money, and at EUR 59.99 the break-even ACOS
 *     computes to MINUS 3.3% — which clamps to the 5% floor and would drive those bids to
 *     nothing. The cap makes the estimate scale with the product instead of inverting on the
 *     cheap end.
 *  2. **It never counts as a known cost.** `coverage.hasCostPrice` stays false and
 *     `coverage.costEstimated` is set, so every surface can label the number as an estimate and
 *     the bid path can refuse to act on it. See `ads-target-acos.service.ts`: with the account
 *     running a 38% actual ACOS, letting a guessed cost set targets of 11-29% would cut bids
 *     across the board — the opposite of the coverage the estimate exists to support.
 *
 * Both numbers are env-tunable so replacing the guess never needs a deploy.
 */
export const DEFAULT_COGS_CENTS = Number(process.env.NEXUS_DEFAULT_COGS_CENTS ?? 5_000)
export const DEFAULT_COGS_MAX_PRICE_SHARE = Number(process.env.NEXUS_DEFAULT_COGS_MAX_PRICE_SHARE ?? 0.7)

/**
 * The estimated unit cost for a product with no real one, given what it actually sells for.
 * Returns null when there is no price to scale against — an estimate with no anchor is a guess
 * about a guess, and this file exists to stop those being presented as measurements.
 */
export function estimateCogsCents(unitPriceCents: number | null | undefined): number | null {
  if (unitPriceCents == null || !Number.isFinite(unitPriceCents) || unitPriceCents <= 0) return null
  return Math.min(DEFAULT_COGS_CENTS, Math.round(unitPriceCents * DEFAULT_COGS_MAX_PRICE_SHARE))
}
