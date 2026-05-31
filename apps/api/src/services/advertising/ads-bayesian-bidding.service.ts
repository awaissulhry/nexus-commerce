/**
 * Apex C.3 — Bayesian sparse-data bidding.
 *
 * Raw conversion rate (orders / clicks) is garbage on sparse keywords: 0 orders
 * in 3 clicks reads as CR=0 (kill it) and 1 order in 2 clicks reads as CR=50%
 * (flood it) — both are noise. Two principled fixes the best PPC tools use:
 *
 *   1. Empirical-Bayes SHRINKAGE — pull each keyword's CR toward a pooled prior
 *      (the account/ad-group mean CR) with strength inversely proportional to
 *      how much data the keyword has. A 0/3 keyword stays near the pool mean;
 *      a 40/2000 keyword trusts its own data. Beta-Binomial conjugacy:
 *        CR_shrunk = (orders + α) / (clicks + α + β)
 *      with the Beta(α,β) prior fit from the pool by method-of-moments.
 *
 *   2. THOMPSON SAMPLING — for explore/exploit, draw a CR from each keyword's
 *      posterior Beta(orders+α, clicks−orders+β). Sparse keywords have wide
 *      posteriors → occasionally sampled high → earn exploration budget; proven
 *      keywords have tight posteriors → consistently exploited.
 *
 * All pure + deterministic (Thompson takes an injectable RNG) so it's unit-
 * tested. The DB helper builds the pool prior from AdTarget rows.
 */

import prisma from '../../db.js'

export interface BetaPrior { alpha: number; beta: number; poolMean: number; strength: number }

/**
 * Fit a Beta prior from a pool of arms (each with orders ≤ clicks) by
 * method-of-moments. poolMean m = Σorders/Σclicks; prior strength K (= α+β) from
 * the spread of per-arm rates: K = m(1−m)/Var − 1, clamped. Low spread → strong
 * prior (trust the pool); high spread → weak prior (trust the arm). Falls back to
 * `defaultStrength` pseudo-clicks when there isn't enough pool signal.
 */
export function fitBetaPrior(
  arms: Array<{ orders: number; clicks: number }>,
  opts: { defaultStrength?: number; minClicks?: number } = {},
): BetaPrior {
  const defaultStrength = opts.defaultStrength ?? 15
  const minClicks = opts.minClicks ?? 1
  const usable = arms.filter((a) => a.clicks >= minClicks && a.orders >= 0 && a.orders <= a.clicks)
  const totalClicks = usable.reduce((s, a) => s + a.clicks, 0)
  const totalOrders = usable.reduce((s, a) => s + a.orders, 0)
  // Pool mean. Guard against 0 (a tiny floor so the prior is well-defined).
  const m = totalClicks > 0 ? Math.min(0.95, Math.max(0.0001, totalOrders / totalClicks)) : 0.05
  // Per-arm rate variance (clicks-weighted), for method-of-moments strength.
  let strength = defaultStrength
  if (usable.length >= 5 && totalClicks > 0) {
    let varNum = 0
    for (const a of usable) {
      const p = a.orders / a.clicks
      varNum += a.clicks * (p - m) * (p - m)
    }
    const variance = varNum / totalClicks
    if (variance > 1e-9) {
      const k = (m * (1 - m)) / variance - 1
      if (Number.isFinite(k)) strength = Math.min(1000, Math.max(2, k))
    } else {
      strength = 1000 // arms agree tightly → strong prior
    }
  }
  return { alpha: m * strength, beta: (1 - m) * strength, poolMean: m, strength }
}

/** Posterior-mean CR after shrinking observed (orders, clicks) toward the prior. Pure. */
export function shrunkConversionRate(orders: number, clicks: number, prior: BetaPrior): number {
  const o = Math.max(0, Math.min(orders, clicks))
  return (o + prior.alpha) / (clicks + prior.alpha + prior.beta)
}

/**
 * A 0..1 confidence that the shrunk estimate reflects the arm's own data rather
 * than the pool — clicks / (clicks + strength). Useful to gate exploration vs
 * exploitation and to explain a bid ("60% data-driven, 40% pooled prior").
 */
export function dataConfidence(clicks: number, prior: BetaPrior): number {
  return clicks / (clicks + prior.strength)
}

// ── Thompson sampling ──────────────────────────────────────────────────────
// Sample Beta(a,b) via two Gamma draws: Beta = X/(X+Y), X~Gamma(a), Y~Gamma(b).
// Marsaglia–Tsang gamma sampler; RNG injectable for deterministic tests.

export type Rng = () => number

function sampleGamma(shape: number, rng: Rng): number {
  if (shape < 1) {
    // Boost: Gamma(shape) = Gamma(shape+1) * U^(1/shape).
    const u = Math.max(1e-12, rng())
    return sampleGamma(shape + 1, rng) * Math.pow(u, 1 / shape)
  }
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  // Box–Muller normal from two uniforms.
  for (let i = 0; i < 1000; i++) {
    const u1 = Math.max(1e-12, rng())
    const u2 = rng()
    const x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
    const v = Math.pow(1 + c * x, 3)
    if (v <= 0) continue
    const u3 = Math.max(1e-12, rng())
    if (Math.log(u3) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v
  }
  return d // fallback (vanishingly rare)
}

/** Draw a conversion-rate sample from the posterior Beta(orders+α, clicks−orders+β). Pure given rng. */
export function thompsonSampleCr(orders: number, clicks: number, prior: BetaPrior, rng: Rng = Math.random): number {
  const o = Math.max(0, Math.min(orders, clicks))
  const a = o + prior.alpha
  const b = clicks - o + prior.beta
  const x = sampleGamma(a, rng)
  const y = sampleGamma(b, rng)
  return x + y > 0 ? x / (x + y) : prior.poolMean
}

/** Build the account (or campaign/ad-group-scoped) pooled CR prior from AdTarget rows. */
export async function computePooledCrPrior(opts: { campaignId?: string; marketplace?: string } = {}): Promise<BetaPrior> {
  const where: Record<string, unknown> = { kind: 'KEYWORD', isNegative: false, clicks: { gt: 0 } }
  if (opts.campaignId) where.adGroup = { campaignId: opts.campaignId }
  else if (opts.marketplace) where.adGroup = { campaign: { marketplace: opts.marketplace } }
  const rows = await prisma.adTarget.findMany({ where, take: 5000, select: { clicks: true, ordersCount: true } })
  return fitBetaPrior(rows.map((r) => ({ orders: r.ordersCount ?? 0, clicks: r.clicks })))
}
