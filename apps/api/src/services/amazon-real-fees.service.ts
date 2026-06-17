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
