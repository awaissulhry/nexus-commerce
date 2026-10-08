/**
 * BID BRAIN BB-1 — the estimator: what one click of a keyword is worth, from evidence pooled upward.
 *
 * A keyword with 0–1 clicks says nothing on its own (design §7: a product with under 1 % conversion, its clicks spread
 * over dozens of keywords). So each estimate borrows from its parent, step by step:
 *
 *   target → the same keyword text in the product's other campaigns → ad group → product (family) → category → market
 *
 *   CR̂_node  = (o_node + K_node · CR̂_parent) / (c_node + K_node)
 *   K_node   = max(strength of the Beta prior fitted over the node's siblings, 2 / CR̂_parent)   // worth ≥ 2 orders
 *   AOV̂_node = (sales_node + 3 · AOV̂_parent) / (orders_node + 3)                                 // root: the listing price
 *
 * Evidence is settled days only, up to 90 of them, each weighted with a 30-day half-life (`weigh`). Zero orders is no
 * cliff: the estimate falls smoothly as K·m/(K+c) (at 0.87 %, K ≈ 230: −8 % after 20 clicks, −33 % after 115).
 * BB-15 — with the nowcast switched on (nowcast.ts), the window ends yesterday and each day also counts with its copy's
 * maturity (`matureSum`, lag-curve.ts); without it, exactly as above.
 *
 * Pure: no database, no clock. The loaders (BB-3) build the chain; `decide.ts` turns the estimate into a bid.
 */

/** Clicks, orders, sales and cost of one node over the window. Decayed sums may be fractional. */
export interface Evidence {
  clicks: number
  orders: number
  salesCents: number
  costCents: number
}

export const NO_EVIDENCE: Evidence = Object.freeze({ clicks: 0, orders: 0, salesCents: 0, costCents: 0 })

/** One settled day of one node; `daysAgo` counts back from the newest settled day (0). */
export interface DayEvidence extends Evidence {
  daysAgo: number
  /** BB-15 — the age its copy was pulled at (days after the day ended; lag-curve.ts). Absent: read as settled. */
  pullAge?: number | null
  /** BB-15 — newer than the settled window: one of the young days the young-day cap holds. */
  young?: boolean
}

/** BB-15 — a copy's maturity: the expected share of its final orders and of its final sales it already holds. */
export interface Maturity {
  orders: number
  sales: number
}
/** BB-15 — the maturity of a copy pulled at an age (lag-curve.ts maturityOf); null: too young to use. */
export type MaturityOf = (pullAge: number) => Maturity | null

/** BB-15 — young days may carry at most this share of a keyword's matured clicks (design U1 guardrails). */
export const YOUNG_SHARE_MAX = 0.3

export const HALF_LIFE_DAYS = 30
export const MAX_WINDOW_DAYS = 90
/** The window when the season index moves (demand changed by more than 15 %): recent days only. */
export const SEASON_WINDOW_DAYS = 14
/** A prior is worth at least this many orders of the parent's rate. */
export const MIN_PRIOR_ORDERS = 2
/** Pseudo-orders the order value borrows from its parent. */
export const AOV_PRIOR_ORDERS = 3
/** The paid CPC as a share of the bid is held inside this range (second-price auctions pay at most the bid). */
export const CPC_RATIO_MIN = 0.6
export const CPC_RATIO_MAX = 1
/** When neither the target nor its parent has enough clicks to measure the ratio. */
export const DEFAULT_CPC_RATIO = 0.85
/** Clicks a node needs before its own paid CPC ÷ bid is trusted. */
export const CPC_RATIO_MIN_CLICKS = 10
/** The conversion rate the chain starts from when the whole market has no data (worth MIN_PRIOR_ORDERS orders). */
export const DEFAULT_ROOT_CR = 0.01

/** The weight of a day `daysAgo` back: 1 today, ½ after one half-life. */
export function decayWeight(daysAgo: number, halfLifeDays = HALF_LIFE_DAYS): number {
  return Math.pow(0.5, Math.max(0, daysAgo) / halfLifeDays)
}

/**
 * The days of a window as one decayed sum. Days at or beyond `windowDays` are left out.
 * BB-15 — with `maturity` each day is also weighted by its copy's maturity (`matureSum`); without it, exactly as before.
 */
export function weigh(days: readonly DayEvidence[], opts: { windowDays?: number; halfLifeDays?: number; maturity?: MaturityOf | null; youngShareMax?: number } = {}): Evidence {
  if (opts.maturity) {
    const decayed = days
      .filter((d) => d.daysAgo >= 0 && d.daysAgo < (opts.windowDays ?? MAX_WINDOW_DAYS))
      .map((d) => {
        const w = decayWeight(d.daysAgo, opts.halfLifeDays)
        return { clicks: d.clicks * w, orders: d.orders * w, salesCents: d.salesCents * w, costCents: d.costCents * w, pullAge: d.pullAge ?? null, young: !!d.young }
      })
    const { clicks, orders, salesCents, costCents } = matureSum(decayed, opts.maturity, { youngShareMax: opts.youngShareMax })
    return { clicks, orders, salesCents, costCents }
  }
  const windowDays = opts.windowDays ?? MAX_WINDOW_DAYS
  const out = { clicks: 0, orders: 0, salesCents: 0, costCents: 0 }
  for (const d of days) {
    if (d.daysAgo < 0 || d.daysAgo >= windowDays) continue
    const w = decayWeight(d.daysAgo, opts.halfLifeDays)
    out.clicks += d.clicks * w
    out.orders += d.orders * w
    out.salesCents += d.salesCents * w
    out.costCents += d.costCents * w
  }
  return out
}

/** BB-15 — a matured sum, with what the young days carry and what was left out. */
export interface MaturedEvidence extends Evidence {
  /** The young days' share of the matured clicks, after the cap (0 … YOUNG_SHARE_MAX). */
  youngShare: number
  /** Matured clicks the young-day cap took away. */
  youngCapped: number
  /** Clicks of copies too young to use (maturity below the floor), left out. */
  tooYoung: number
}

/**
 * BB-15 (design U1b) — maturity-weighted evidence. A copy holding the expected share m of its final orders (m_s of its
 * final sales) counts with weight m: its clicks and cost × m, its orders as observed (the nowcast o ÷ m, weighed by m),
 * its sales nowcast and weighed the same way (s ÷ m_s × m). So, per keyword,
 *
 *   CR̂ = Σ orders_observed ÷ Σ (clicks × m)        (E[orders_observed] = clicks × CR × m: unbiased)
 *   AOV and paid CPC per click keep their meaning (sales ÷ orders, cost ÷ clicks are both weighed alike)
 *
 * and the confidence penalty comes by itself: a young day is worth only m of its clicks, so the Beta posterior stays
 * wider and the step (confidence × maxChangePct) smaller. A zero-order day 1 day old barely moves the estimate.
 * Caps: a copy whose maturity is null (below lag-curve.ts MIN_MATURITY: its numbers would be multiplied by more than 2.5)
 * is left out; the young days (`young`, newer than the settled window) may carry at most `youngShareMax` of the
 * keyword's matured clicks — scaled down together when they would carry more, dropped when the keyword has no older
 * clicks at all (it then pools from its parents, as before BB-15). A copy without a pull age counts as settled (m = 1).
 */
export function matureSum(
  items: ReadonlyArray<Evidence & { pullAge?: number | null; young?: boolean }>,
  maturity: MaturityOf,
  opts: { youngShareMax?: number } = {},
): MaturedEvidence {
  const old = { clicks: 0, orders: 0, salesCents: 0, costCents: 0 }
  const young = { clicks: 0, orders: 0, salesCents: 0, costCents: 0 }
  let tooYoung = 0
  for (const d of items) {
    const m = d.pullAge == null ? { orders: 1, sales: 1 } : maturity(d.pullAge)
    if (!m) { tooYoung += d.clicks; continue }
    const into = d.young ? young : old
    into.clicks += d.clicks * m.orders
    into.costCents += d.costCents * m.orders
    into.orders += d.orders
    into.salesCents += (d.salesCents / m.sales) * m.orders
  }
  const max = Math.min(1, Math.max(0, opts.youngShareMax ?? YOUNG_SHARE_MAX))
  const room = max >= 1 ? Number.POSITIVE_INFINITY : (max / (1 - max)) * old.clicks
  const scale = old.clicks <= 0 ? 0 : young.clicks > room ? room / young.clicks : 1
  const total = old.clicks + young.clicks * scale
  return {
    clicks: total,
    orders: old.orders + young.orders * scale,
    salesCents: old.salesCents + young.salesCents * scale,
    costCents: old.costCents + young.costCents * scale,
    youngShare: total > 0 ? (young.clicks * scale) / total : 0,
    youngCapped: young.clicks * (1 - scale),
    tooYoung,
  }
}

/** The window to read: 14 days while the season index moves (demand ±15 %), else 90. */
export function windowDaysFor(demandIndex: number | null | undefined): number {
  return demandIndex != null && Math.abs(demandIndex - 1) > 0.15 ? SEASON_WINDOW_DAYS : MAX_WINDOW_DAYS
}

/**
 * The strength (pseudo-clicks) of a Beta prior fitted over sibling arms by the method of moments — the same arithmetic
 * as `fitBetaPrior` in ads-bayesian-bidding.service.ts (kept here so the core loads no database module; a test pins the
 * two together): fewer than 5 arms, or no clicks, give the default 15; agreeing arms a strong prior (up to 1,000).
 */
export function siblingStrength(arms: readonly Evidence[], defaultStrength = 15): number {
  const usable = arms.filter((a) => a.clicks >= 1 && a.orders >= 0 && a.orders <= a.clicks)
  const clicks = usable.reduce((s, a) => s + a.clicks, 0)
  const orders = usable.reduce((s, a) => s + a.orders, 0)
  if (usable.length < 5 || clicks <= 0) return defaultStrength
  const m = Math.min(0.95, Math.max(0.0001, orders / clicks))
  let varNum = 0
  for (const a of usable) {
    const p = a.orders / a.clicks
    varNum += a.clicks * (p - m) * (p - m)
  }
  const variance = varNum / clicks
  if (variance <= 1e-9) return 1000
  const k = (m * (1 - m)) / variance - 1
  return Number.isFinite(k) ? Math.min(1000, Math.max(2, k)) : defaultStrength
}

export type PoolLevel = 'target' | 'keyword' | 'adGroup' | 'product' | 'category' | 'market'

/** One step of the chain: its own evidence (children included) and, optionally, its siblings for the prior's strength. */
export interface PoolNode {
  level: PoolLevel
  evidence: Evidence
  siblings?: readonly Evidence[]
}

export interface NodeEstimate {
  level: PoolLevel
  clicks: number
  orders: number
  /** The pooled conversion rate. */
  cr: number
  /** The prior's strength in pseudo-clicks. */
  k: number
  /** The pooled order value in cents; null while no order value is known anywhere up the chain. */
  aovCents: number | null
}

export interface Estimate {
  /** The node decided for (the first of the chain). */
  node: NodeEstimate
  /** Its parent's estimate (the bid a new keyword starts from); null for a chain of one. */
  parent: NodeEstimate | null
  /** Every node, most specific first. */
  chain: NodeEstimate[]
  /** 0..1 — the share of the estimate that rests on data rather than the default root rate. */
  confidence: number
  /** The deepest node with data of its own, for the "why": "product, 2,300 clicks". */
  basis: NodeEstimate
}

/**
 * Pool a chain, most specific first (target … market). The root borrows from `rootCr` (default 1 %) and from the
 * listing price for the order value. An empty chain is refused by the caller (it has nothing to pool).
 */
export function estimate(chain: readonly PoolNode[], opts: { rootCr?: number; listPriceCents?: number | null } = {}): Estimate {
  if (!chain.length) throw new Error('bid-brain estimate: an empty chain')
  const rootCr = opts.rootCr ?? DEFAULT_ROOT_CR
  let parentCr = rootCr
  let parentAov: number | null = opts.listPriceCents != null && opts.listPriceCents > 0 ? opts.listPriceCents : null
  // The share of the running estimate that still comes from the default root rate.
  let rootShare = 1
  const fromRoot: NodeEstimate[] = []
  for (let i = chain.length - 1; i >= 0; i--) {
    const n = chain[i]
    const c = Math.max(0, n.evidence.clicks)
    const o = Math.max(0, Math.min(n.evidence.orders, c))
    const k = Math.max(siblingStrength(n.siblings ?? []), MIN_PRIOR_ORDERS / parentCr)
    const cr = (o + k * parentCr) / (c + k)
    rootShare *= k / (c + k)
    const sales = Math.max(0, n.evidence.salesCents)
    const aov = parentAov != null ? (sales + AOV_PRIOR_ORDERS * parentAov) / (o + AOV_PRIOR_ORDERS) : o > 0 ? sales / o : null
    fromRoot.push({ level: n.level, clicks: c, orders: o, cr, k, aovCents: aov })
    parentCr = cr
    parentAov = aov
  }
  const ordered = fromRoot.reverse()
  const basis = ordered.find((e) => e.clicks > 0 && e.clicks / (e.clicks + e.k) >= 0.5) ?? ordered.find((e) => e.clicks > 0) ?? ordered[ordered.length - 1]
  return { node: ordered[0], parent: ordered[1] ?? null, chain: ordered, confidence: 1 - rootShare, basis }
}

/**
 * The paid CPC as a share of the bid, held to 0.6–1.0: the target's own when it has CPC_RATIO_MIN_CLICKS clicks, else
 * its parent's (the loader measures it over the ad group), else 0.85.
 */
export function cpcRatio(own: Pick<Evidence, 'clicks' | 'costCents'>, bidCents: number, parentRatio?: number | null): number {
  const raw = own.clicks >= CPC_RATIO_MIN_CLICKS && bidCents > 0 ? own.costCents / own.clicks / bidCents : parentRatio ?? DEFAULT_CPC_RATIO
  return Math.min(CPC_RATIO_MAX, Math.max(CPC_RATIO_MIN, Number.isFinite(raw) ? raw : DEFAULT_CPC_RATIO))
}

/**
 * BB-18 — paid CPC ÷ bid when placements can lift the price above the bid. A placement uplift (an hourly plan up to
 * +300 %) and Amazon's dynamic bidding make the paid CPC larger than the base bid: IT_BMM_Gale paid 28¢ and 36¢ on base
 * bids of 26¢ and 22¢. So the ratio is held between CPC_RATIO_MIN and `ceiling` — the stack's highest multiple
 * (recipe.ts stackCeiling) — rather than 1. `servingCents` is the bid that served the window's clicks (ads-bid-window.ts
 * windowBidCents), so the ratio does not follow the bid's own later moves. With `ceiling` 1 it is `cpcRatio`.
 */
export function laneCpcRatio(own: Pick<Evidence, 'clicks' | 'costCents'>, servingCents: number, parentRatio?: number | null, ceiling = CPC_RATIO_MAX): number {
  const top = Math.max(CPC_RATIO_MAX, Number.isFinite(ceiling) ? ceiling : CPC_RATIO_MAX)
  const raw = own.clicks >= CPC_RATIO_MIN_CLICKS && servingCents > 0 ? own.costCents / own.clicks / servingCents : parentRatio ?? DEFAULT_CPC_RATIO
  return Math.min(top, Math.max(CPC_RATIO_MIN, Number.isFinite(raw) ? raw : DEFAULT_CPC_RATIO))
}

/** z for a one-sided 80 % bound. */
const Z80 = 0.8416

/**
 * The 80 % lower bound of a node's conversion rate (normal approximation of its Beta posterior). A raise above the
 * parent's bid is held where the ACoS at this pessimistic rate reaches the band top (decide.ts).
 */
export function crLowerBound80(n: Pick<NodeEstimate, 'cr' | 'k' | 'clicks'>): number {
  const a = n.cr * (n.clicks + n.k)
  const b = (1 - n.cr) * (n.clicks + n.k)
  const sd = Math.sqrt((a * b) / ((a + b) * (a + b) * (a + b + 1)))
  return Math.max(0, n.cr - Z80 * sd)
}
