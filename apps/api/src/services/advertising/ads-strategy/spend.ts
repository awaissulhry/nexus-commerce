/**
 * ADS AUTONOMY W1-6b — category and product monthly caps (Owner decision D5 = A): how much each CATEGORY and PRODUCT
 * cap's own scope has spent this month, which caps are reached, and which ad groups the budget engine floors for them.
 *
 *   spend      Amazon's daily advertised-product report (AmazonAdsDailyPerformance, entityType PRODUCT_AD — Sponsored
 *              Products only): each ad's spend counted on its product (AdProductAd.productId), then on EVERY cap that
 *              product falls under — its own row, its parent's, its categories' (as the resolver gives them). Whole
 *              days, never today, like the market's spend; an ad Nexus cannot tie to a product is counted on no cap
 *              and reported as unattributed.
 *   no cap     a cap of 0 (or less) is no cap, as a market's is and as a €0 month is in the Budget Manager: it is
 *              never listed, never reached and floors nothing
 *   floors     an ad group holding ANY product under a reached cap is floored (the safer rule: it also stops the other
 *              products sharing that ad group; the Owner can split ad groups). It stays floored until no reached cap
 *              covers it: on the 1st, or when the cap is raised or removed, or the product leaves the ad group.
 *
 * The decisions are pure (adGroupFloorDecisions, spendByScope); the reads are batched per market.
 */
import prisma from '../../../db.js'
import type { StrategyView } from './effective.js'
import { capRows, type CapInForce } from './resolve.js'

/** A CATEGORY or PRODUCT cap with its scope's month-to-date spend. */
export interface ScopeCap {
  strategyId: string
  level: 'category' | 'product'
  scopeId: string
  label: string
  version: number
  capCents: number
  spendCents: number
  reached: boolean
}

const scoped = (cap: CapInForce) => cap.source.level !== 'market'
/** A category or product cap that is a cap: 0 (or less) is no cap. */
const scopedCap = (cap: CapInForce) => scoped(cap) && cap.monthlySpendCapCents > 0

/** Pure: each scope's spend — every product's spend added to every non-market cap it falls under. */
export function spendByScope(
  products: Iterable<{ productId: string; caps: readonly CapInForce[] }>,
  spendByProduct: ReadonlyMap<string, number>,
): Map<string, number> {
  const out = new Map<string, number>()
  for (const p of products) {
    const cents = spendByProduct.get(p.productId) ?? 0
    for (const cap of p.caps) if (scoped(cap)) out.set(cap.source.strategyId, (out.get(cap.source.strategyId) ?? 0) + cents)
  }
  return out
}

/** Pure: every category and product cap of the market with its scope's spend, and whether it is reached (a cap of 0: none). */
export function scopeCaps(caps: readonly CapInForce[], byScope: ReadonlyMap<string, number>): ScopeCap[] {
  return caps.filter(scopedCap).map((cap) => {
    const spendCents = byScope.get(cap.source.strategyId) ?? 0
    return {
      strategyId: cap.source.strategyId, level: cap.source.level as 'category' | 'product', scopeId: cap.source.scopeId,
      label: cap.source.label, version: cap.source.version, capCents: cap.monthlySpendCapCents, spendCents, reached: spendCents >= cap.monthlySpendCapCents,
    }
  })
}

export interface AdGroupFloorDecision {
  id: string
  /** Floor it now: a reached cap covers one of its products, and it is not floored on its own yet. */
  suppress: boolean
  /** Give its floor back: no reached cap covers it any more, and the floor is this engine's own. */
  restore: boolean
  /** The reached caps that cover it (the first names it in the reason). */
  reachedBy: ScopeCap[]
}

/**
 * Pure: which ad groups to floor and which to give back. `caps`: every cap in force for the ad group's products (the
 * resolver's `monthlyCaps`); `ownFloor`: the owner of its own floor, null when it is not floored on its own; `isMine`:
 * whether that owner is the engine deciding (another engine's or a person's floor is never lifted here).
 */
export function adGroupFloorDecisions(
  groups: ReadonlyArray<{ id: string; caps: readonly CapInForce[]; ownFloor: { by: string | null } | null }>,
  reached: ReadonlyMap<string, ScopeCap>,
  isMine: (by: string | null) => boolean,
): AdGroupFloorDecision[] {
  return groups.map((g) => {
    const reachedBy = g.caps.filter(scoped).map((c) => reached.get(c.source.strategyId)).filter((c): c is ScopeCap => !!c)
    return {
      id: g.id,
      suppress: reachedBy.length > 0 && !g.ownFloor,
      restore: reachedBy.length === 0 && !!g.ownFloor && isMine(g.ownFloor.by),
      reachedBy,
    }
  })
}

/**
 * This month's Sponsored Products spend per product in one market, from the daily advertised-product report: each
 * report row's ad (localEntityId = AdProductAd.id) counted on its product. `spendThrough`: the last day covered.
 */
export async function productSpendThisMonth(market: string, start: Date, end: Date): Promise<{ byProduct: Map<string, number>; unattributedCents: number; spendThrough: string | null }> {
  const rows = await prisma.amazonAdsDailyPerformance.groupBy({
    by: ['localEntityId'],
    where: { entityType: 'PRODUCT_AD', marketplace: market, date: { gte: start, lt: end } },
    _sum: { costMicros: true },
    _max: { date: true },
  })
  const cents = (micros: bigint | number | null | undefined) => Math.round(Number(micros ?? 0) / 10_000)
  const adIds = rows.map((r) => r.localEntityId).filter((id): id is string => !!id)
  const ads = adIds.length ? await prisma.adProductAd.findMany({ where: { id: { in: adIds } }, select: { id: true, productId: true } }) : []
  const productOf = new Map(ads.map((a) => [a.id, a.productId]))
  const byProduct = new Map<string, number>()
  let unattributedCents = 0
  let through: Date | null = null
  for (const r of rows) {
    const day = r._max.date ? new Date(r._max.date) : null
    if (day && (!through || day > through)) through = day
    const productId = r.localEntityId ? productOf.get(r.localEntityId) : null
    if (productId) byProduct.set(productId, (byProduct.get(productId) ?? 0) + cents(r._sum.costMicros))
    else unattributedCents += cents(r._sum.costMicros)
  }
  return { byProduct, unattributedCents, spendThrough: through ? through.toISOString().slice(0, 10) : null }
}

export interface ScopeCapsThisMonth {
  caps: ScopeCap[]
  /** The reached ones, by strategy row. */
  reached: Map<string, ScopeCap>
  unattributedCents: number
  spendThrough: string | null
}

/**
 * Every category and product cap of one opened market with this month's spend of its scope. Nothing is read when the
 * market holds no such cap.
 */
export async function scopeCapsThisMonth(view: StrategyView, start: Date, end: Date): Promise<ScopeCapsThisMonth> {
  const caps = view.empty ? [] : capRows(view.index).filter(scopedCap)
  if (!caps.length) return { caps: [], reached: new Map(), unattributedCents: 0, spendThrough: null }
  const spend = await productSpendThisMonth(view.market, start, end)
  const each = await view.forEachProduct([...spend.byProduct.keys()])
  const byScope = spendByScope([...each].map(([productId, e]) => ({ productId, caps: e.values.monthlyCaps })), spend.byProduct)
  const all = scopeCaps(caps, byScope)
  return { caps: all, reached: new Map(all.filter((c) => c.reached).map((c) => [c.strategyId, c])), unattributedCents: spend.unattributedCents, spendThrough: spend.spendThrough }
}
