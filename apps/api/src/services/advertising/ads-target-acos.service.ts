/**
 * Apex C.2 — profit-native per-SKU target ACOS.
 *
 * The bid optimizer (AX.8) hardcoded a flat 30% target ACOS. That's wrong: a
 * 30% ACOS is healthy on a 50%-margin SKU and loss-making on a 20%-margin one.
 * This derives each product's target ACOS from its REAL margin:
 *
 *   break-even ACOS = (revenue − COGS − referral − FBA − storage − returns −
 *                      other) / revenue
 *     = the share of revenue you can spend on ads before profit hits zero.
 *   target ACOS    = break-even × (1 − profitShare)
 *     = leave `profitShare` of the contribution margin as profit.
 *
 * Also surfaces TACOS (ad spend / total sales) and TACoP (ad spend / true
 * profit) — the organic-health + profit-efficiency metrics. All from
 * ProductProfitDaily, which we already roll up nightly. Pure helpers are
 * unit-tested; the DB aggregation degrades to a documented fallback (30%)
 * when a SKU has no profit data yet.
 */

import prisma from '../../db.js'

export interface ProfitComponents {
  grossRevenueCents: number
  cogsCents: number
  referralFeesCents: number
  fbaFulfillmentFeesCents: number
  fbaStorageFeesCents: number
  returnsRefundsCents: number
  otherFeesCents: number
}

export type AcosMode = 'profit' | 'balanced' | 'growth'
export const FALLBACK_TARGET_ACOS = 0.3

/**
 * Break-even ACOS as a fraction of revenue (0..1). null when there's no
 * revenue to reason about; 0 when the non-ad cost stack already exceeds
 * revenue (no room for ad spend → bid to the floor). Pure.
 */
export function breakevenAcos(c: ProfitComponents): number | null {
  if (c.grossRevenueCents <= 0) return null
  const contributionBeforeAds =
    c.grossRevenueCents -
    c.cogsCents -
    c.referralFeesCents -
    c.fbaFulfillmentFeesCents -
    c.fbaStorageFeesCents -
    c.returnsRefundsCents -
    c.otherFeesCents
  if (contributionBeforeAds <= 0) return 0
  return contributionBeforeAds / c.grossRevenueCents
}

/** Default profit share kept back, per lifecycle mode. */
export function profitShareFor(mode: AcosMode): number {
  return mode === 'profit' ? 0.35 : mode === 'balanced' ? 0.2 : 0.05 // growth spends almost the whole margin
}

/**
 * Target ACOS from break-even, keeping `profitShare` of the contribution as
 * profit. Clamped to [5%, 150%]. Pure.
 */
export function targetFromBreakeven(breakeven: number, opts: { mode?: AcosMode; profitShare?: number } = {}): number {
  const profitShare = opts.profitShare ?? profitShareFor(opts.mode ?? 'profit')
  const t = breakeven * (1 - Math.max(0, Math.min(1, profitShare)))
  return Math.max(0.05, Math.min(1.5, t))
}

export interface TargetAcosResult {
  productId: string
  marketplace: string | null
  windowDays: number
  dataPoints: number
  basis: 'profit-data' | 'fallback'
  // Fractions (0..1+). targetAcos is always set (fallback when no data).
  breakevenAcos: number | null
  targetAcos: number
  marginPct: number | null
  tacos: number | null // ad spend / gross revenue
  tacop: number | null // ad spend / true profit (null if profit ≤ 0)
  grossRevenueCents: number
  adSpendCents: number
  trueProfitCents: number
}

/**
 * Per-product target ACOS from trailing ProductProfitDaily. Filters by
 * marketplace when given (a SKU's economics differ per market). Falls back to
 * FALLBACK_TARGET_ACOS when the SKU has no profit rows in the window.
 */
export async function computeProductTargetAcos(opts: {
  productId: string
  marketplace?: string | null
  windowDays?: number
  mode?: AcosMode
  profitShare?: number
}): Promise<TargetAcosResult> {
  const windowDays = Math.max(1, Math.min(180, opts.windowDays ?? 30))
  const since = new Date()
  since.setUTCDate(since.getUTCDate() - windowDays)
  since.setUTCHours(0, 0, 0, 0)
  const rows = await prisma.productProfitDaily.aggregate({
    where: {
      productId: opts.productId,
      ...(opts.marketplace ? { marketplace: opts.marketplace } : {}),
      date: { gte: since },
    },
    _sum: {
      grossRevenueCents: true, cogsCents: true, referralFeesCents: true,
      fbaFulfillmentFeesCents: true, fbaStorageFeesCents: true,
      returnsRefundsCents: true, otherFeesCents: true,
      advertisingSpendCents: true, trueProfitCents: true,
    },
    _count: true,
  })
  const s = rows._sum
  const gross = s.grossRevenueCents ?? 0
  const adSpend = s.advertisingSpendCents ?? 0
  const trueProfit = s.trueProfitCents ?? 0
  const dataPoints = rows._count ?? 0
  if (dataPoints === 0 || gross <= 0) {
    return {
      productId: opts.productId, marketplace: opts.marketplace ?? null, windowDays, dataPoints,
      basis: 'fallback', breakevenAcos: null, targetAcos: FALLBACK_TARGET_ACOS,
      marginPct: null, tacos: null, tacop: null,
      grossRevenueCents: gross, adSpendCents: adSpend, trueProfitCents: trueProfit,
    }
  }
  const components: ProfitComponents = {
    grossRevenueCents: gross,
    cogsCents: s.cogsCents ?? 0,
    referralFeesCents: s.referralFeesCents ?? 0,
    fbaFulfillmentFeesCents: s.fbaFulfillmentFeesCents ?? 0,
    fbaStorageFeesCents: s.fbaStorageFeesCents ?? 0,
    returnsRefundsCents: s.returnsRefundsCents ?? 0,
    otherFeesCents: s.otherFeesCents ?? 0,
  }
  const be = breakevenAcos(components)
  return {
    productId: opts.productId, marketplace: opts.marketplace ?? null, windowDays, dataPoints,
    basis: 'profit-data',
    breakevenAcos: be,
    targetAcos: be == null ? FALLBACK_TARGET_ACOS : targetFromBreakeven(be, { mode: opts.mode, profitShare: opts.profitShare }),
    marginPct: gross > 0 ? trueProfit / gross : null,
    tacos: gross > 0 ? adSpend / gross : null,
    tacop: trueProfit > 0 ? adSpend / trueProfit : null,
    grossRevenueCents: gross, adSpendCents: adSpend, trueProfitCents: trueProfit,
  }
}

/**
 * Revenue-weighted target ACOS for an ad group — the blend of its advertised
 * products' targets. Used to feed a per-ad-group target into the bid optimizer.
 * Returns null when no advertised product has profit data (caller keeps flat).
 */
export async function computeAdGroupTargetAcos(
  adGroupId: string,
  opts: { marketplace?: string | null; windowDays?: number; mode?: AcosMode } = {},
): Promise<{ targetAcos: number | null; products: number }> {
  const ads = await prisma.adProductAd.findMany({
    where: { adGroupId, productId: { not: null } },
    select: { productId: true },
  })
  const productIds = [...new Set(ads.map((a) => a.productId).filter((id): id is string => !!id))]
  if (productIds.length === 0) return { targetAcos: null, products: 0 }
  let wSum = 0
  let weightedAcos = 0
  let withData = 0
  for (const pid of productIds) {
    const r = await computeProductTargetAcos({ productId: pid, marketplace: opts.marketplace, windowDays: opts.windowDays, mode: opts.mode })
    if (r.basis !== 'profit-data') continue
    const w = Math.max(1, r.grossRevenueCents) // revenue weight (floor 1 so zero-rev profit rows still count a little)
    weightedAcos += r.targetAcos * w
    wSum += w
    withData += 1
  }
  if (withData === 0 || wSum === 0) return { targetAcos: null, products: productIds.length }
  return { targetAcos: weightedAcos / wSum, products: productIds.length }
}

/** Fleet view — per advertised product, for the intel endpoint + dashboards. */
export async function computeFleetTargetAcos(opts: { marketplace?: string | null; windowDays?: number; mode?: AcosMode } = {}): Promise<TargetAcosResult[]> {
  const windowDays = Math.max(1, Math.min(180, opts.windowDays ?? 30))
  const since = new Date()
  since.setUTCDate(since.getUTCDate() - windowDays)
  since.setUTCHours(0, 0, 0, 0)
  const groups = await prisma.productProfitDaily.groupBy({
    by: ['productId'],
    where: { ...(opts.marketplace ? { marketplace: opts.marketplace } : {}), date: { gte: since }, grossRevenueCents: { gt: 0 } },
    _sum: { grossRevenueCents: true },
    orderBy: { _sum: { grossRevenueCents: 'desc' } },
    take: 1000,
  })
  const out: TargetAcosResult[] = []
  for (const g of groups) {
    out.push(await computeProductTargetAcos({ productId: g.productId, marketplace: opts.marketplace, windowDays, mode: opts.mode }))
  }
  return out
}
