/**
 * 4d (review 4.4, Owner decision S11) — what one rule write is projected to ADD to a day's ad spend.
 *
 * A rule's daily spend ceiling (`AutomationRule.maxDailyAdSpendCentsEur`, €100/day by default) sums these figures over
 * the rule's live writes today. One definition for every action family, in one unit — euro cents of EXTRA spend per
 * day, at the clicks the rule measured — so a budget raise, a bid raise and a placement raise draw on the same ceiling.
 *
 *   budget     new − current daily budget: the most the campaign may additionally spend.
 *   bid        (new − old bid) × clicks per day in the rule's window. An UPPER bound: a click never costs more than the
 *              bid, so each measured click costs at most the raise more.
 *   placement  the lane's spend per day × ((100 + new %) / (100 + old %) − 1): the lane's measured spend, scaled by how
 *              much the new multiplier raises what each click in that lane may cost.
 *
 * A cut, or no change, is 0 — it never spends more. A raise with no measured clicks (or no lane spend) is also 0, and
 * says `unmeasured`: there is no measured traffic to price, which is not the same as "free". A measured raise rounds
 * UP, so it never counts as 0¢. Pure: the handlers read the clicks and spend, this only does the arithmetic.
 */

export type SpendEstimateBasis = 'raise' | 'cut' | 'no_change' | 'unmeasured'

export interface SpendEstimate {
  /** Projected extra spend per day, euro cents, never negative. */
  extraCentsPerDay: number
  basis: SpendEstimateBasis
}

const direction = (from: number, to: number): SpendEstimate | null =>
  to < from ? { extraCentsPerDay: 0, basis: 'cut' } : to === from ? { extraCentsPerDay: 0, basis: 'no_change' } : null

// Numerator and denominator stay integers until the one division, so an exact figure is not nudged up by float noise.
const ceilRatio = (numerator: number, denominator: number): number => Math.ceil(numerator / denominator)

export function budgetExtraSpend(currentCents: number, nextCents: number): SpendEstimate {
  return direction(currentCents, nextCents) ?? { extraCentsPerDay: Math.round(nextCents - currentCents), basis: 'raise' }
}

export function bidExtraSpend(input: { oldBidCents: number; newBidCents: number; clicks: number; windowDays: number }): SpendEstimate {
  const same = direction(input.oldBidCents, input.newBidCents)
  if (same) return same
  if (!(input.clicks > 0)) return { extraCentsPerDay: 0, basis: 'unmeasured' }
  const days = Math.max(1, Math.round(input.windowDays))
  return { extraCentsPerDay: ceilRatio((input.newBidCents - input.oldBidCents) * input.clicks, days), basis: 'raise' }
}

export function placementExtraSpend(input: { oldPct: number; newPct: number; laneSpendCents: number; windowDays: number }): SpendEstimate {
  const same = direction(input.oldPct, input.newPct)
  if (same) return same
  if (!(input.laneSpendCents > 0)) return { extraCentsPerDay: 0, basis: 'unmeasured' }
  const days = Math.max(1, Math.round(input.windowDays))
  // spend/day × ((100+new)/(100+old) − 1) = spend × (new − old) / ((100 + old) × days)
  return {
    extraCentsPerDay: ceilRatio(input.laneSpendCents * (input.newPct - input.oldPct), (100 + input.oldPct) * days),
    basis: 'raise',
  }
}
