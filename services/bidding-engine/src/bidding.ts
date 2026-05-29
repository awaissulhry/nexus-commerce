/**
 * Pure, side-effect-free bidding math — the inventory-elasticity model from the
 * v2 blueprint (Module 2). Kept dependency-free so it is trivially unit-tested.
 *
 *   CR_blend = α·CR_7d + (1-α)·CR_30d
 *   Bid_base = AOV · CR_blend · ACoS_target
 *   θ_inv    = 1 - e^(-k·max(0, DoS - d0))          # 0 at stockout → 1 deep supply
 *   θ_intra  = clamp(1 + γ·(ACoS_target - ACoS_1h)/ACoS_target, 1-δ, 1+δ)
 *   Bid_new  = clamp(Bid_base · θ_inv · θ_intra, Bid_min, Bid_max)
 */
import type { BidContext } from './types.js'

export const PARAMS = {
  alpha: 0.65, // weight on the recent (7d) conversion rate
  k: 0.18, // inventory-elasticity steepness
  d0: 7, // days-of-supply below which the throttle bites
  gamma: 0.5, // intraday correction strength
  delta: 0.25, // max intraday swing (±25%)
} as const

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

/** Inventory-elasticity multiplier ∈ (0, 1]. 1 when supply is deep; → 0 as DoS → 0. */
export function inventoryTheta(daysOfSupply: number | null): number {
  if (daysOfSupply == null) return 1
  return 1 - Math.exp(-PARAMS.k * Math.max(0, daysOfSupply - PARAMS.d0))
}

/** Bounded intraday correction from the live hour vs. the ACoS target. */
export function intradayTheta(acosTargetBps: number, acos1hBps: number | null): number {
  if (acos1hBps == null || acosTargetBps <= 0) return 1
  const target = acosTargetBps / 10_000
  const live = acos1hBps / 10_000
  return clamp(1 + PARAMS.gamma * (target - live) / target, 1 - PARAMS.delta, 1 + PARAMS.delta)
}

/** Compute the optimal bid in integer minor units, clamped to the strategy band. */
export function computeBid(c: BidContext): number {
  const crBlend = PARAMS.alpha * c.cr7d + (1 - PARAMS.alpha) * c.cr30d
  const acosTarget = c.acosTargetBps / 10_000
  const bidBase = c.aovMinor * crBlend * acosTarget
  const raw = Math.round(bidBase * inventoryTheta(c.daysOfSupply) * intradayTheta(c.acosTargetBps, c.acos1hBps))
  return clamp(raw, c.bidMinMinor, c.bidMaxMinor)
}

/** 2% deadband: skip churn-y micro-moves to protect the API rate budget. */
export function isMaterialChange(nextMinor: number, currentMinor: number): boolean {
  if (currentMinor <= 0) return nextMinor > 0
  return Math.abs(nextMinor - currentMinor) * 100 >= currentMinor * 2
}
