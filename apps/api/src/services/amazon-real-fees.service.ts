/**
 * R1.1a — Real Amazon fee rates (docs/AMAZON_DATA_STRATEGY.md).
 *
 * Computes the ACTUAL blended fee rate from the financial events we already
 * pull (FinancialTransaction — real per-order Amazon fees, Finance role),
 * per marketplace + overall. This is the real number that replaces the
 * hard-coded 15% / manual referralFeePercent estimate in the profit calc
 * (the wire-in is a separate, gated step — this service only READS).
 *
 * Read-only, no migration. Surfaces "your real Amazon take rate is X%"
 * straight from Amazon's own fee data.
 */

import prisma from '../db.js'

const DAY = 86_400_000
const num = (v: unknown): number => (v == null ? 0 : Number(v as never))
const round2 = (n: number) => Math.round(n * 100) / 100

/** The hard-coded Amazon fee estimate the profit calc uses today. */
export const ASSUMED_AMAZON_FEE_PCT = 15

export interface FeeRateBreakdown {
  referralAndOther: number
  fba: number
  payment: number
}

export interface MarketplaceFeeRate {
  marketplace: string
  orders: number
  grossRevenue: number
  totalFees: number
  feeRatePct: number | null
  breakdown: FeeRateBreakdown
}

export interface RealFeeRates {
  periodDays: number
  assumedPct: number
  blended: {
    orders: number
    grossRevenue: number
    totalFees: number
    feeRatePct: number | null
  }
  byMarketplace: MarketplaceFeeRate[]
}

export async function getRealAmazonFeeRates(days = 90): Promise<RealFeeRates> {
  const since = new Date(Date.now() - days * DAY)
  const rows = await prisma.financialTransaction.findMany({
    where: {
      transactionType: 'Order',
      order: { channel: 'AMAZON', purchaseDate: { gte: since } },
    },
    select: {
      amazonFee: true,
      fbaFee: true,
      paymentServicesFee: true,
      otherFees: true,
      grossRevenue: true,
      order: { select: { marketplace: true } },
    },
  })

  interface Acc {
    orders: number
    grossRevenue: number
    referralAndOther: number
    fba: number
    payment: number
  }
  const mk = (): Acc => ({
    orders: 0,
    grossRevenue: 0,
    referralAndOther: 0,
    fba: 0,
    payment: 0,
  })
  const byMkt = new Map<string, Acc>()
  const blend = mk()

  for (const r of rows) {
    const mkt = r.order?.marketplace ?? 'UNKNOWN'
    if (!byMkt.has(mkt)) byMkt.set(mkt, mk())
    const a = byMkt.get(mkt)!
    // Fees are stored as magnitudes; abs() guards either sign convention.
    const referral = Math.abs(num(r.amazonFee)) + Math.abs(num(r.otherFees))
    const fba = Math.abs(num(r.fbaFee))
    const pay = Math.abs(num(r.paymentServicesFee))
    const rev = num(r.grossRevenue)
    for (const acc of [a, blend]) {
      acc.orders += 1
      acc.grossRevenue += rev
      acc.referralAndOther += referral
      acc.fba += fba
      acc.payment += pay
    }
  }

  const toRate = (acc: Acc, marketplace: string): MarketplaceFeeRate => {
    const totalFees = acc.referralAndOther + acc.fba + acc.payment
    return {
      marketplace,
      orders: acc.orders,
      grossRevenue: round2(acc.grossRevenue),
      totalFees: round2(totalFees),
      feeRatePct:
        acc.grossRevenue > 0 ? round2((totalFees / acc.grossRevenue) * 100) : null,
      breakdown: {
        referralAndOther: round2(acc.referralAndOther),
        fba: round2(acc.fba),
        payment: round2(acc.payment),
      },
    }
  }

  const byMarketplace = [...byMkt.entries()]
    .map(([m, acc]) => toRate(acc, m))
    .sort((x, y) => y.grossRevenue - x.grossRevenue)

  const blendedTotal = blend.referralAndOther + blend.fba + blend.payment
  return {
    periodDays: days,
    assumedPct: ASSUMED_AMAZON_FEE_PCT,
    blended: {
      orders: blend.orders,
      grossRevenue: round2(blend.grossRevenue),
      totalFees: round2(blendedTotal),
      feeRatePct:
        blend.grossRevenue > 0
          ? round2((blendedTotal / blend.grossRevenue) * 100)
          : null,
    },
    byMarketplace,
  }
}

export interface SkuFeeRate {
  sku: string
  productId: string | null
  units: number
  revenue: number
  fees: number
  feeRatePct: number | null
}

export interface RealFeeRatesBySku {
  periodDays: number
  skuCount: number
  attributedFees: number
  skus: SkuFeeRate[]
}

/**
 * R1.2 — per-SKU real fee rate. Each Amazon order's ACTUAL total fees are
 * allocated across its line items by revenue share, then aggregated per
 * SKU. Single-SKU orders are exact; multi-SKU orders split proportionally.
 * This is the product-level precision the blended rate (R1.1a) can't give —
 * a €200 helmet and a €20 glove carry very different FBA-fee %.
 */
export async function getRealFeeRatesBySku(
  days = 90,
  opts: { productId?: string; limit?: number } = {},
): Promise<RealFeeRatesBySku> {
  const since = new Date(Date.now() - days * DAY)

  const fts = await prisma.financialTransaction.findMany({
    where: {
      transactionType: 'Order',
      order: { channel: 'AMAZON', purchaseDate: { gte: since } },
    },
    select: {
      orderId: true,
      amazonFee: true,
      fbaFee: true,
      paymentServicesFee: true,
      otherFees: true,
    },
  })
  const feesByOrder = new Map<string, number>()
  for (const ft of fts) {
    const fees =
      Math.abs(num(ft.amazonFee)) +
      Math.abs(num(ft.fbaFee)) +
      Math.abs(num(ft.paymentServicesFee)) +
      Math.abs(num(ft.otherFees))
    feesByOrder.set(ft.orderId, (feesByOrder.get(ft.orderId) ?? 0) + fees)
  }
  const orderIds = [...feesByOrder.keys()]
  if (orderIds.length === 0)
    return { periodDays: days, skuCount: 0, attributedFees: 0, skus: [] }

  // ALL items for those orders (needed for the per-order revenue base, even
  // when filtering output to one product).
  const items = await prisma.orderItem.findMany({
    where: { orderId: { in: orderIds } },
    select: { orderId: true, sku: true, productId: true, price: true, quantity: true },
  })
  const orderRev = new Map<string, number>()
  for (const it of items)
    orderRev.set(
      it.orderId,
      (orderRev.get(it.orderId) ?? 0) + num(it.price) * it.quantity,
    )

  interface Acc {
    sku: string
    productId: string | null
    units: number
    revenue: number
    fees: number
  }
  const bySku = new Map<string, Acc>()
  let attributedFees = 0
  for (const it of items) {
    const itemRev = num(it.price) * it.quantity
    const base = orderRev.get(it.orderId) ?? 0
    const orderFees = feesByOrder.get(it.orderId) ?? 0
    const attributed = base > 0 ? orderFees * (itemRev / base) : 0
    attributedFees += attributed
    const acc =
      bySku.get(it.sku) ??
      { sku: it.sku, productId: it.productId, units: 0, revenue: 0, fees: 0 }
    acc.units += it.quantity
    acc.revenue += itemRev
    acc.fees += attributed
    bySku.set(it.sku, acc)
  }

  let skus: SkuFeeRate[] = [...bySku.values()].map((a) => ({
    sku: a.sku,
    productId: a.productId,
    units: a.units,
    revenue: round2(a.revenue),
    fees: round2(a.fees),
    feeRatePct: a.revenue > 0 ? round2((a.fees / a.revenue) * 100) : null,
  }))
  if (opts.productId) skus = skus.filter((s) => s.productId === opts.productId)
  skus.sort((x, y) => y.revenue - x.revenue)
  const skuCount = skus.length
  if (opts.limit) skus = skus.slice(0, opts.limit)

  return {
    periodDays: days,
    skuCount,
    attributedFees: round2(attributedFees),
    skus,
  }
}

export interface FeeImpactRow {
  sku: string
  productId: string | null
  revenue: number
  assumedFees: number
  realFees: number
  /** realFees − assumedFees = profit the 15% assumption was hiding. */
  overstatement: number
  realRatePct: number | null
}

export interface FeeImpact {
  periodDays: number
  assumedPct: number
  overall: {
    revenue: number
    assumedFees: number
    realFees: number
    overstatement: number
    realRatePct: number | null
    overstatementPctOfRevenue: number | null
  }
  topAffected: FeeImpactRow[]
}

/**
 * R1.4a — read-only before/after. For each SKU + overall, compares the
 * fees the profit calc ASSUMES today (revenue × 15%) against the REAL
 * fees (R1.2). The gap is exactly the profit the 15% assumption has been
 * hiding. Shows the impact BEFORE we flip the live calc (R1.4b).
 */
export async function getFeeImpact(days = 90, limit = 15): Promise<FeeImpact> {
  const bySku = await getRealFeeRatesBySku(days, {})
  const pct = ASSUMED_AMAZON_FEE_PCT / 100

  let revenue = 0
  let assumedFees = 0
  let realFees = 0
  const rows: FeeImpactRow[] = bySku.skus.map((s) => {
    const assumed = round2(s.revenue * pct)
    revenue += s.revenue
    assumedFees += assumed
    realFees += s.fees
    return {
      sku: s.sku,
      productId: s.productId,
      revenue: s.revenue,
      assumedFees: assumed,
      realFees: s.fees,
      overstatement: round2(s.fees - assumed),
      realRatePct: s.feeRatePct,
    }
  })
  rows.sort((a, b) => b.overstatement - a.overstatement)

  const overstatement = round2(realFees - assumedFees)
  return {
    periodDays: days,
    assumedPct: ASSUMED_AMAZON_FEE_PCT,
    overall: {
      revenue: round2(revenue),
      assumedFees: round2(assumedFees),
      realFees: round2(realFees),
      overstatement,
      realRatePct: revenue > 0 ? round2((realFees / revenue) * 100) : null,
      overstatementPctOfRevenue:
        revenue > 0 ? round2((overstatement / revenue) * 100) : null,
    },
    topAffected: rows.slice(0, limit),
  }
}

// ── R1.4b — real referral-rate resolver (feeds the profit calc) ─────────
// Referral-only (amazonFee + otherFees, NOT fba — the rollup tracks FBA
// separately, so this avoids double-counting). Per-SKU where coverage is
// sufficient, else marketplace, else overall.

export interface ReferralResolver {
  byMarketplace: { marketplace: string; pct: number | null; revenue: number }[]
  overallPct: number | null
  sampleSkus: { productId: string | null; pct: number | null; revenue: number }[]
  /** Returns the referral fraction (0.19 = 19%) + which tier it came from. */
  resolve(
    productId: string | null,
    marketplace: string,
  ): { pct: number | null; source: 'sku' | 'marketplace' | 'overall' | 'none' }
}

const MIN_COVERAGE_REVENUE = 50 // €50 of attributed revenue → trust the per-SKU rate

export async function getRealReferralRateResolver(
  days = 90,
): Promise<ReferralResolver> {
  const since = new Date(Date.now() - days * DAY)
  const fts = await prisma.financialTransaction.findMany({
    where: {
      transactionType: 'Order',
      order: { channel: 'AMAZON', purchaseDate: { gte: since } },
    },
    select: {
      orderId: true,
      amazonFee: true,
      otherFees: true,
      order: { select: { marketplace: true } },
    },
  })
  const refByOrder = new Map<string, number>()
  const mktByOrder = new Map<string, string>()
  for (const ft of fts) {
    const ref = Math.abs(num(ft.amazonFee)) + Math.abs(num(ft.otherFees))
    refByOrder.set(ft.orderId, (refByOrder.get(ft.orderId) ?? 0) + ref)
    if (ft.order?.marketplace) mktByOrder.set(ft.orderId, ft.order.marketplace)
  }
  const orderIds = [...refByOrder.keys()]
  const items = orderIds.length
    ? await prisma.orderItem.findMany({
        where: { orderId: { in: orderIds } },
        select: { orderId: true, productId: true, price: true, quantity: true },
      })
    : []
  const orderRev = new Map<string, number>()
  for (const it of items)
    orderRev.set(
      it.orderId,
      (orderRev.get(it.orderId) ?? 0) + num(it.price) * it.quantity,
    )

  type RR = { rev: number; ref: number }
  const perProduct = new Map<string, RR>()
  const perMarket = new Map<string, RR>()
  const overall: RR = { rev: 0, ref: 0 }
  for (const it of items) {
    const itemRev = num(it.price) * it.quantity
    const base = orderRev.get(it.orderId) ?? 0
    const orderRef = refByOrder.get(it.orderId) ?? 0
    const attributed = base > 0 ? orderRef * (itemRev / base) : 0
    if (it.productId) {
      const a = perProduct.get(it.productId) ?? { rev: 0, ref: 0 }
      a.rev += itemRev
      a.ref += attributed
      perProduct.set(it.productId, a)
    }
    const mkt = mktByOrder.get(it.orderId) ?? 'UNKNOWN'
    const m = perMarket.get(mkt) ?? { rev: 0, ref: 0 }
    m.rev += itemRev
    m.ref += attributed
    perMarket.set(mkt, m)
    overall.rev += itemRev
    overall.ref += attributed
  }
  const rate = (a: RR): number | null => (a.rev > 0 ? a.ref / a.rev : null)
  const overallPct = rate(overall)

  const resolve = (productId: string | null, marketplace: string) => {
    if (productId) {
      const p = perProduct.get(productId)
      if (p && p.rev >= MIN_COVERAGE_REVENUE) {
        const r = rate(p)
        if (r != null) return { pct: r, source: 'sku' as const }
      }
    }
    const m = perMarket.get(marketplace)
    if (m && m.rev >= MIN_COVERAGE_REVENUE) {
      const r = rate(m)
      if (r != null) return { pct: r, source: 'marketplace' as const }
    }
    if (overallPct != null) return { pct: overallPct, source: 'overall' as const }
    return { pct: null, source: 'none' as const }
  }

  return {
    byMarketplace: [...perMarket.entries()]
      .map(([marketplace, a]) => ({
        marketplace,
        pct: rate(a) != null ? round2(rate(a)! * 100) : null,
        revenue: round2(a.rev),
      }))
      .sort((x, y) => y.revenue - x.revenue),
    overallPct: overallPct != null ? round2(overallPct * 100) : null,
    sampleSkus: [...perProduct.entries()]
      .map(([productId, a]) => ({
        productId,
        pct: rate(a) != null ? round2(rate(a)! * 100) : null,
        revenue: round2(a.rev),
      }))
      .sort((x, y) => y.revenue - x.revenue)
      .slice(0, 8),
    resolve,
  }
}

// Cached ~1h so the daily rollup builds it once per run, not per product.
let _refResolver: { at: number; r: ReferralResolver } | null = null
export async function getCachedReferralResolver(
  days = 90,
): Promise<ReferralResolver> {
  if (_refResolver && Date.now() - _refResolver.at < 3_600_000)
    return _refResolver.r
  const r = await getRealReferralRateResolver(days)
  _refResolver = { at: Date.now(), r }
  return r
}

// ── R1.4c — real COMBINED Amazon fee rate per marketplace ──────────────
// referral + fba + payment + other, attributed to ORDER-ITEM revenue (the
// base insights-profit applies fees to — so the rate is correct against
// that base, not over-counted vs Amazon's gross-revenue figure).

export interface CombinedRateByMarketplace {
  byMarketplace: { marketplace: string; pct: number | null; revenue: number }[]
  blendedPct: number | null
  /** marketplace → fraction (0.224 = 22.4%); for the profit calc. */
  map: Map<string, number>
  blended: number | null
}

// ── R1.4d — real FBA fee PER UNIT (FBA is charged per unit, not per €) ──
// fbaFee from financial events, allocated to items by UNITS, → per-SKU /
// marketplace / overall per-unit cents. Replaces the weekly estimate in
// fba-fees-ingest (estimate kept as fallback).

export interface FbaPerUnitResolver {
  byMarketplace: { marketplace: string; perUnitCents: number | null; units: number }[]
  overallPerUnitCents: number | null
  resolve(
    productId: string | null,
    marketplace: string,
  ): { perUnitCents: number | null; source: 'sku' | 'marketplace' | 'overall' | 'none' }
}

const MIN_FBA_UNITS = 3 // trust the per-SKU per-unit fee once ≥3 units seen

export async function getRealFbaPerUnitResolver(
  days = 90,
): Promise<FbaPerUnitResolver> {
  const since = new Date(Date.now() - days * DAY)
  const fts = await prisma.financialTransaction.findMany({
    where: {
      transactionType: 'Order',
      order: { channel: 'AMAZON', purchaseDate: { gte: since } },
    },
    select: { orderId: true, fbaFee: true, order: { select: { marketplace: true } } },
  })
  const fbaByOrder = new Map<string, number>()
  const mktByOrder = new Map<string, string>()
  for (const ft of fts) {
    fbaByOrder.set(ft.orderId, (fbaByOrder.get(ft.orderId) ?? 0) + Math.abs(num(ft.fbaFee)))
    if (ft.order?.marketplace) mktByOrder.set(ft.orderId, ft.order.marketplace)
  }
  const orderIds = [...fbaByOrder.keys()]
  const items = orderIds.length
    ? await prisma.orderItem.findMany({
        where: { orderId: { in: orderIds } },
        select: { orderId: true, productId: true, quantity: true },
      })
    : []
  const orderUnits = new Map<string, number>()
  for (const it of items)
    orderUnits.set(it.orderId, (orderUnits.get(it.orderId) ?? 0) + it.quantity)

  type FU = { units: number; fba: number } // fba in EUR
  const perProduct = new Map<string, FU>()
  const perMarket = new Map<string, FU>()
  const overall: FU = { units: 0, fba: 0 }
  for (const it of items) {
    const base = orderUnits.get(it.orderId) ?? 0
    const orderFba = fbaByOrder.get(it.orderId) ?? 0
    const attributed = base > 0 ? orderFba * (it.quantity / base) : 0
    if (it.productId) {
      const a = perProduct.get(it.productId) ?? { units: 0, fba: 0 }
      a.units += it.quantity
      a.fba += attributed
      perProduct.set(it.productId, a)
    }
    const mkt = mktByOrder.get(it.orderId) ?? 'UNKNOWN'
    const m = perMarket.get(mkt) ?? { units: 0, fba: 0 }
    m.units += it.quantity
    m.fba += attributed
    perMarket.set(mkt, m)
    overall.units += it.quantity
    overall.fba += attributed
  }
  const perUnitCents = (a: FU): number | null =>
    a.units > 0 ? Math.round((a.fba / a.units) * 100) : null
  const overallC = perUnitCents(overall)

  return {
    byMarketplace: [...perMarket.entries()]
      .map(([marketplace, a]) => ({
        marketplace,
        perUnitCents: perUnitCents(a),
        units: a.units,
      }))
      .sort((x, y) => y.units - x.units),
    overallPerUnitCents: overallC,
    resolve: (productId, marketplace) => {
      if (productId) {
        const p = perProduct.get(productId)
        if (p && p.units >= MIN_FBA_UNITS) {
          const c = perUnitCents(p)
          if (c != null) return { perUnitCents: c, source: 'sku' as const }
        }
      }
      const m = perMarket.get(marketplace)
      if (m && m.units >= MIN_FBA_UNITS) {
        const c = perUnitCents(m)
        if (c != null) return { perUnitCents: c, source: 'marketplace' as const }
      }
      if (overallC != null) return { perUnitCents: overallC, source: 'overall' as const }
      return { perUnitCents: null, source: 'none' as const }
    },
  }
}

export async function getRealCombinedRateByMarketplace(
  days = 90,
): Promise<CombinedRateByMarketplace> {
  const since = new Date(Date.now() - days * DAY)
  const fts = await prisma.financialTransaction.findMany({
    where: {
      transactionType: 'Order',
      order: { channel: 'AMAZON', purchaseDate: { gte: since } },
    },
    select: {
      orderId: true,
      amazonFee: true,
      fbaFee: true,
      paymentServicesFee: true,
      otherFees: true,
      order: { select: { marketplace: true } },
    },
  })
  const feeByOrder = new Map<string, number>()
  const mktByOrder = new Map<string, string>()
  for (const ft of fts) {
    const f =
      Math.abs(num(ft.amazonFee)) +
      Math.abs(num(ft.fbaFee)) +
      Math.abs(num(ft.paymentServicesFee)) +
      Math.abs(num(ft.otherFees))
    feeByOrder.set(ft.orderId, (feeByOrder.get(ft.orderId) ?? 0) + f)
    if (ft.order?.marketplace) mktByOrder.set(ft.orderId, ft.order.marketplace)
  }
  const orderIds = [...feeByOrder.keys()]
  const items = orderIds.length
    ? await prisma.orderItem.findMany({
        where: { orderId: { in: orderIds } },
        select: { orderId: true, price: true, quantity: true },
      })
    : []
  const orderRev = new Map<string, number>()
  for (const it of items)
    orderRev.set(
      it.orderId,
      (orderRev.get(it.orderId) ?? 0) + num(it.price) * it.quantity,
    )
  const perMkt = new Map<string, { rev: number; fee: number }>()
  const overall = { rev: 0, fee: 0 }
  for (const it of items) {
    const itemRev = num(it.price) * it.quantity
    const base = orderRev.get(it.orderId) ?? 0
    const orderFee = feeByOrder.get(it.orderId) ?? 0
    const attributed = base > 0 ? orderFee * (itemRev / base) : 0
    const mkt = mktByOrder.get(it.orderId) ?? 'UNKNOWN'
    const m = perMkt.get(mkt) ?? { rev: 0, fee: 0 }
    m.rev += itemRev
    m.fee += attributed
    perMkt.set(mkt, m)
    overall.rev += itemRev
    overall.fee += attributed
  }
  const frac = (a: { rev: number; fee: number }) =>
    a.rev > 0 ? a.fee / a.rev : null
  const map = new Map<string, number>()
  for (const [m, a] of perMkt) {
    const r = frac(a)
    if (r != null) map.set(m, r)
  }
  const blended = frac(overall)
  return {
    byMarketplace: [...perMkt.entries()]
      .map(([marketplace, a]) => ({
        marketplace,
        pct: frac(a) != null ? round2(frac(a)! * 100) : null,
        revenue: round2(a.rev),
      }))
      .sort((x, y) => y.revenue - x.revenue),
    blendedPct: blended != null ? round2(blended * 100) : null,
    map,
    blended,
  }
}
