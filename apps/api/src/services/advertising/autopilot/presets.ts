/**
 * AI Control / Autopilot — goal presets, guardrails, and the pure math primitives the
 * Conductor uses. Everything here is PURE + deterministic (no I/O, no Date.now in the math)
 * so the controllers can be unit-tested and back-tested. See docs/ai-control-autopilot-spec.md.
 */

export type Goal = 'LAUNCH' | 'PROFIT' | 'BALANCED' | 'LIQUIDATE' | 'DEFEND_RANK'
export type Autonomy = 'OFF' | 'SUGGEST' | 'AUTO'
export type ModuleName = 'bid' | 'budget' | 'placement' | 'rank' | 'dayparting' | 'harvest' | 'negate' | 'safety'

/** Per-campaign signal bundle assembled by the cron from existing data sources. cents = integer minor units. */
export interface CampaignSignals {
  campaignId: string
  spendCents: number
  salesCents: number
  clicks: number
  orders: number
  impressions: number
  dailyBudgetCents: number
  currentBidCents: number          // representative ad-group default / target bid
  daysOfSupply: number | null      // inventory throttle (null = unknown → no throttle)
  marginPct: number | null         // product margin %, drives break-even ACoS (null = unknown)
  tosImpressionSharePct: number | null  // Top-of-Search IS for the rank module
  deliveryOutOfBudget: boolean     // pacing signal (Amazon deliveryReasons includes OUT_OF_BUDGET)
  acos1hPct: number | null         // intraday correction (null = none)
}

export interface Guardrails {
  targetAcosPct: number
  bidMinCents: number
  bidMaxCents: number
  budgetMinCents: number
  budgetMaxCents: number
  maxDailySpendCents: number       // hard cap across the whole plan's campaign set (0 = no cap)
  rampPct: number                  // max % change to any bid/budget per cycle
  neverPause: boolean              // breach → suppress to floor, never PAUSE
}

export const DEFAULT_GUARDRAILS: Guardrails = {
  targetAcosPct: 30,
  bidMinCents: 5,
  bidMaxCents: 300,
  budgetMinCents: 100,             // Amazon €1/day floor
  budgetMaxCents: 50_000,
  maxDailySpendCents: 0,
  rampPct: 25,
  neverPause: true,
}

export interface GoalPreset {
  bidStrategy: 'maxImpr' | 'targetAcos' | 'maxOrders' | 'rank'
  acosFactor: number               // multiply the effective target ACoS
  rampPct: number
  budgetPosture: 'growFast' | 'capTight' | 'balanced' | 'highCeiling' | 'holdRank'
  rankDefend: 'off' | 'light' | 'defend' | 'core'
  harvest: 'conservative' | 'medium' | 'aggressive'
  placement: 'efficiency' | 'balanced' | 'pushTos' | 'volume' | 'tosMax'
}

export const GOAL_PRESETS: Record<Goal, GoalPreset> = {
  LAUNCH:      { bidStrategy: 'maxImpr',    acosFactor: 1.6, rampPct: 40, budgetPosture: 'growFast',    rankDefend: 'light',  harvest: 'aggressive',   placement: 'pushTos' },
  PROFIT:      { bidStrategy: 'targetAcos', acosFactor: 1.0, rampPct: 15, budgetPosture: 'capTight',    rankDefend: 'off',    harvest: 'conservative', placement: 'efficiency' },
  BALANCED:    { bidStrategy: 'targetAcos', acosFactor: 1.0, rampPct: 25, budgetPosture: 'balanced',    rankDefend: 'defend', harvest: 'medium',       placement: 'balanced' },
  LIQUIDATE:   { bidStrategy: 'maxOrders',  acosFactor: 2.5, rampPct: 40, budgetPosture: 'highCeiling', rankDefend: 'off',    harvest: 'aggressive',   placement: 'volume' },
  DEFEND_RANK: { bidStrategy: 'rank',       acosFactor: 1.0, rampPct: 25, budgetPosture: 'holdRank',    rankDefend: 'core',   harvest: 'medium',       placement: 'tosMax' },
}

// ── pure math primitives ─────────────────────────────────────────────────────
export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

/** Break-even ACoS % = the product margin % (ad cost equal to margin → zero profit). */
export function breakevenAcosPct(marginPct: number | null): number | null {
  if (marginPct == null || marginPct <= 0) return null
  return marginPct
}

/** Effective target ACoS % for a campaign, from goal + profit data, clamped to a sane band. */
export function effectiveTargetAcosPct(goal: Goal, g: Guardrails, signals: Pick<CampaignSignals, 'marginPct'>): number {
  const preset = GOAL_PRESETS[goal]
  const be = breakevenAcosPct(signals.marginPct)
  let target = g.targetAcosPct * preset.acosFactor
  // PROFIT: keep ~35% of margin as profit → cap target at 65% of break-even when we know margin.
  if (goal === 'PROFIT' && be != null) target = Math.min(target, be * 0.65)
  // never let the target exceed break-even by much unless we're deliberately liquidating/launching
  if (be != null && goal !== 'LIQUIDATE' && goal !== 'LAUNCH') target = Math.min(target, be)
  return clamp(target, 5, 300)
}

/** Inventory throttle θ_inv ∈ [0,1]: 1 - e^(-k·(DoS - d0)); 0 at/below d0, →1 with ample supply. */
export function inventoryThrottle(daysOfSupply: number | null, d0 = 3, k = 0.2): number {
  if (daysOfSupply == null) return 1
  if (daysOfSupply <= d0) return 0
  return clamp(1 - Math.exp(-k * (daysOfSupply - d0)), 0, 1)
}

/** Intraday correction θ_intra: nudge toward target using the current-hour ACoS, bounded ±δ. */
export function intradayCorrection(acos1hPct: number | null, targetAcosPct: number, gamma = 0.5, delta = 0.2): number {
  if (acos1hPct == null || targetAcosPct <= 0) return 1
  return clamp(1 + gamma * (targetAcosPct - acos1hPct) / targetAcosPct, 1 - delta, 1 + delta)
}

/** Bayesian-smoothed CVR: shrink observed orders/clicks toward a prior (p0 with m pseudo-clicks). */
export function smoothedCvr(orders: number, clicks: number, p0 = 0.10, m = 10): number {
  return (orders + p0 * m) / (clicks + m)
}

/** Limit a proposed value to ±rampPct of the current (anti-shock). cur=0 → no ramp limit. */
export function rampLimit(proposed: number, current: number, rampPct: number): number {
  if (current <= 0) return proposed
  const r = rampPct / 100
  return clamp(proposed, current * (1 - r), current * (1 + r))
}

/** True if the change is large enough to be worth a write (default 2% deadband). */
export function exceedsDeadband(proposed: number, current: number, band = 0.02): boolean {
  if (current <= 0) return proposed > 0
  return Math.abs(proposed - current) / current >= band
}
