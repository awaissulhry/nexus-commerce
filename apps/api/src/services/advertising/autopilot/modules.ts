/**
 * AI Control / Autopilot — pure per-module decision functions. Each takes the campaign signals
 * + effective target + guardrails + goal preset and returns ONE proposed action (or null = no-op).
 * No I/O. The Conductor composes these, clamps to guardrails, resolves conflicts, and the cron
 * applies them (AUTO) or stores them as suggestions (SUGGEST). Harvest/Negate are NOT decided
 * here — they are delegated to the Rule-Setting session's engine (provisioned + read by the cron).
 */
import {
  type CampaignSignals, type Guardrails, type GoalPreset, type ModuleName,
  clamp, rampLimit, exceedsDeadband, smoothedCvr, inventoryThrottle, intradayCorrection,
} from './presets.js'

export interface ProposedAction {
  module: ModuleName
  campaignId: string
  action: 'BID_RAISE' | 'BID_LOWER' | 'BUDGET_UP' | 'BUDGET_DOWN' | 'PLACEMENT' | 'SUPPRESS' | 'NOOP'
  beforeCents?: number
  afterCents?: number
  before?: unknown
  after?: unknown
  reason: string
  priority: number   // higher wins conflicts: safety 100 > rank 80 > bid 60 > budget 50 > placement 40
}

const acosPct = (s: CampaignSignals): number | null => (s.salesCents > 0 ? (s.spendCents / s.salesCents) * 100 : null)
const PROVEN_LOSER_CLICKS = 15  // clicks with 0 orders before we call a target a non-converter

/**
 * BID — the core "max profitable CPC" controller:
 *   bid = AOV · CVR(smoothed) · targetACoS · θ_inv · θ_intra, ramp-limited, clamped, deadbanded.
 * Zero-order targets: keep exploring until PROVEN_LOSER_CLICKS, then cut to the floor.
 */
export function decideBid(s: CampaignSignals, targetAcosPct: number, g: Guardrails, preset: GoalPreset): ProposedAction | null {
  const cur = s.currentBidCents
  const ramp = Math.min(preset.rampPct, g.rampPct)
  if (s.orders === 0) {
    if (s.clicks >= PROVEN_LOSER_CLICKS) {
      const proposed = clamp(Math.round(rampLimit(g.bidMinCents, cur, ramp)), g.bidMinCents, g.bidMaxCents)
      if (!exceedsDeadband(proposed, cur)) return null
      return { module: 'bid', campaignId: s.campaignId, action: 'BID_LOWER', beforeCents: cur, afterCents: proposed, reason: `No orders in ${s.clicks} clicks → cut toward floor`, priority: 60 }
    }
    return null  // still exploring — leave the bid for harvest/exploration to learn from
  }
  const cvr = smoothedCvr(s.orders, s.clicks)
  const aovCents = s.salesCents / s.orders
  const base = aovCents * cvr * (targetAcosPct / 100)
  const raw = base * inventoryThrottle(s.daysOfSupply) * intradayCorrection(s.acos1hPct, targetAcosPct)
  const proposed = clamp(Math.round(rampLimit(raw, cur, ramp)), g.bidMinCents, g.bidMaxCents)
  if (!exceedsDeadband(proposed, cur)) return null
  return {
    module: 'bid', campaignId: s.campaignId, action: proposed > cur ? 'BID_RAISE' : 'BID_LOWER',
    beforeCents: cur, afterCents: proposed,
    reason: `tACoS ${targetAcosPct.toFixed(0)}% · CVR ${(cvr * 100).toFixed(1)}% · AOV €${(aovCents / 100).toFixed(2)}${s.daysOfSupply != null && s.daysOfSupply <= 14 ? ` · low stock ${s.daysOfSupply}d` : ''} → €${(proposed / 100).toFixed(2)}`,
    priority: 60,
  }
}

const RAISE_FACTOR: Record<GoalPreset['budgetPosture'], number> = { growFast: 1.30, balanced: 1.20, capTight: 1.10, highCeiling: 1.50, holdRank: 1.20 }

/** BUDGET — pacing: raise starved+profitable campaigns; cut high-ACoS spenders. */
export function decideBudget(s: CampaignSignals, targetAcosPct: number, g: Guardrails, preset: GoalPreset): ProposedAction | null {
  const cur = s.dailyBudgetCents
  const acos = acosPct(s)
  if (s.deliveryOutOfBudget && acos != null && acos <= targetAcosPct) {
    const proposed = clamp(Math.round(rampLimit(cur * RAISE_FACTOR[preset.budgetPosture], cur, g.rampPct)), g.budgetMinCents, g.budgetMaxCents)
    if (!exceedsDeadband(proposed, cur)) return null
    return { module: 'budget', campaignId: s.campaignId, action: 'BUDGET_UP', beforeCents: cur, afterCents: proposed, reason: `Out of budget & ACoS ${acos.toFixed(0)}% ≤ target → raise to €${(proposed / 100).toFixed(2)}`, priority: 50 }
  }
  if (acos != null && acos > targetAcosPct * 1.5 && s.spendCents > 5000) {
    const proposed = clamp(Math.round(rampLimit(cur * 0.8, cur, g.rampPct)), g.budgetMinCents, g.budgetMaxCents)
    if (!exceedsDeadband(proposed, cur)) return null
    return { module: 'budget', campaignId: s.campaignId, action: 'BUDGET_DOWN', beforeCents: cur, afterCents: proposed, reason: `ACoS ${acos.toFixed(0)}% ≫ target on €${(s.spendCents / 100).toFixed(0)} spend → trim to €${(proposed / 100).toFixed(2)}`, priority: 50 }
  }
  return null
}

const TARGET_IS: Record<GoalPreset['placement'], number> = { efficiency: 25, balanced: 25, pushTos: 40, volume: 35, tosMax: 60 }

/** PLACEMENT — push Top-of-Search modifier toward the goal's IS target while ACoS is in budget. */
export function decidePlacement(s: CampaignSignals, targetAcosPct: number, preset: GoalPreset): ProposedAction | null {
  if (s.tosImpressionSharePct == null) return null
  const acos = acosPct(s)
  const targetIS = TARGET_IS[preset.placement]
  if (s.tosImpressionSharePct < targetIS && (acos == null || acos <= targetAcosPct)) {
    return { module: 'placement', campaignId: s.campaignId, action: 'PLACEMENT', before: { tosISPct: s.tosImpressionSharePct }, after: { raiseTosPct: 10 }, reason: `ToS IS ${s.tosImpressionSharePct.toFixed(0)}% < target ${targetIS}% & ACoS ok → +10% Top-of-Search`, priority: 40 }
  }
  if (acos != null && acos > targetAcosPct * 1.3) {
    return { module: 'placement', campaignId: s.campaignId, action: 'PLACEMENT', before: { tosISPct: s.tosImpressionSharePct }, after: { lowerTosPct: 10 }, reason: `ACoS ${acos.toFixed(0)}% over target → −10% Top-of-Search`, priority: 40 }
  }
  return null
}
