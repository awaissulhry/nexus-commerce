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
  out.hasCostPrice = costIsKnown(row) && row.cogsCents > 0
  return { ...out, ...extra }
}

/** What the UI says in place of a number. Kept here so every surface says the same thing. */
export const PROFIT_UNKNOWN_REASON = 'No cost price loaded for this product yet'
