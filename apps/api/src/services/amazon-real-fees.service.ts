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
