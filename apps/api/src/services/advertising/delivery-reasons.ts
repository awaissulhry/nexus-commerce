/**
 * Amazon's own answer to "why is this campaign not serving": the v1 export's `deliveryReasons`, stored as Amazon sends
 * them on `Campaign.deliveryReasons` by the structure sync (ads-v1-sync.service.ts). One reading of them for every engine.
 *
 * 2b (review N2) — rank-defend, the `pace_budget` rule and autopilot matched `OUT_OF_BUDGET`, a code Amazon does not
 * send. It sends `CAMPAIGN_OUT_OF_BUDGET` (9 of 70 enabled campaigns carried it on 2026-08-21) and
 * `PORTFOLIO_OUT_OF_BUDGET`, so none of the three ever saw a campaign out of budget. The bare `OUT_OF_BUDGET` is still
 * matched, for any older row or other source that carries it.
 */

type Reasons = readonly string[] | null | undefined

/** The campaign's OWN daily budget ran out. */
const CAMPAIGN_BUDGET_CODES = new Set(['CAMPAIGN_OUT_OF_BUDGET', 'OUT_OF_BUDGET'])
const isBudgetCode = (r: string): boolean => r === 'OUT_OF_BUDGET' || r.endsWith('_OUT_OF_BUDGET')
const list = (reasons: Reasons): string[] => (Array.isArray(reasons) ? reasons.map(String) : [])

/** A budget stopped this campaign: its own, its portfolio's, or any other `…_OUT_OF_BUDGET` Amazon names. */
export function isOutOfBudget(reasons: Reasons): boolean {
  return list(reasons).some(isBudgetCode)
}

/**
 * The campaign's own daily budget ran out, so raising that budget can help. A portfolio that ran out is not: the
 * campaign stays capped by the portfolio whatever its own budget says.
 */
export function isCampaignOutOfBudget(reasons: Reasons): boolean {
  return list(reasons).some((r) => CAMPAIGN_BUDGET_CODES.has(r))
}

/** Which budget ran out, in plain words for a reason line; null when no budget stopped the campaign. */
export function outOfBudgetWords(reasons: Reasons): string | null {
  const hit = list(reasons).filter(isBudgetCode)
  if (!hit.length) return null
  if (hit.some((r) => CAMPAIGN_BUDGET_CODES.has(r))) return 'Amazon says this campaign is out of budget'
  if (hit.includes('PORTFOLIO_OUT_OF_BUDGET')) return 'Amazon says this campaign’s portfolio is out of budget'
  return `Amazon says a budget ran out (${hit[0]})`
}
