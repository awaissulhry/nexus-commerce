/**
 * AD.1 — Daily True Profit roll-up per (productId, marketplace, date).
 *
 * Aggregates revenue, COGS, channel fees, FBA/storage fees, ad spend,
 * and refunds into one row per tuple. AD.3's AutomationRule trigger
 * context builders read this table — it's the pre-shaped timeseries
 * the conditions DSL queries with eq/lt/gte operators.
 *
 * Additive-only: re-running for the same date UPSERTs but never
 * deletes. Late-arriving Amazon Financial Events (fees can post 24-48h
 * after the order) update the row in place rather than spawning a new
 * snapshot. The `coverage` JSON marks which fields are real vs default
 * — the UI renders a "this row is 75% complete" badge from it.
 *
 * For AD.1 we focus on the cheap-to-compute fields (revenue, COGS,
 * referral fees). FBA + storage + advertising fees land in AD.2/AD.4
 * once the fees ingester + ads-metrics-ingest are wired.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

interface RollupSummary {
  datesProcessed: string[]
  marketplacesProcessed: string[]
  rowsUpserted: number
  errors: string[]
}

interface CoverageFlags {
  hasCostPrice: boolean
  hasReferralFee: boolean
  hasFbaFee: boolean
  hasAdSpend: boolean
}

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10)
}

interface AggregatedSale {
  productId: string
  marketplace: string
  date: Date
  unitsSold: number
  grossRevenueCents: number
}

async function aggregateSalesForDay(date: Date): Promise<AggregatedSale[]> {
  // Window: [date, date+1day) in UTC.
  const start = utcMidnight(date)
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)

  // Use Prisma's groupBy on OrderItem with an Order join. Filter to
  // marketplace-set orders (legacy rows without marketplace are skipped
  // — they couldn't be attributed to a Trading Desk marketplace anyway).
  const rows = await prisma.orderItem.findMany({
    where: {
      productId: { not: null },
      order: {
        marketplace: { not: null },
        purchaseDate: { gte: start, lt: end },
        status: { notIn: ['CANCELLED'] },
      },
    },
    select: {
      productId: true,
      quantity: true,
      price: true,
      order: { select: { marketplace: true } },
    },
  })

  const map = new Map<string, AggregatedSale>()
  for (const r of rows) {
    if (!r.productId || !r.order.marketplace) continue
    const key = `${r.productId}::${r.order.marketplace}`
    const priceCents = Math.round(Number(r.price) * 100)
    const lineCents = priceCents * r.quantity
    const existing = map.get(key)
    if (existing) {
      existing.unitsSold += r.quantity
      existing.grossRevenueCents += lineCents
    } else {
      map.set(key, {
        productId: r.productId,
        marketplace: r.order.marketplace,
        date: start,
        unitsSold: r.quantity,
        grossRevenueCents: lineCents,
      })
    }
  }
  return Array.from(map.values())
}

async function lookupCostPrice(productId: string): Promise<number | null> {
  const p = await prisma.product.findUnique({
    where: { id: productId },
    select: { costPrice: true, weightedAvgCostCents: true },
  })
  if (!p) return null
  if (p.costPrice != null) return Math.round(Number(p.costPrice) * 100)
  if (p.weightedAvgCostCents != null) return p.weightedAvgCostCents
  return null
}

async function lookupReferralFeePct(
  productId: string,
  marketplace: string,
): Promise<number | null> {
  // ChannelListing carries per-marketplace referralFeePercent at line 1440.
  const cl = await prisma.channelListing.findFirst({
    where: {
      productId,
      marketplace,
      referralFeePercent: { not: null },
    },
    select: { referralFeePercent: true },
  })
  if (!cl?.referralFeePercent) return null
  return Number(cl.referralFeePercent) / 100 // stored as 15.00 = 15%
}

async function upsertRow(args: {
  productId: string
  marketplace: string
  date: Date
  unitsSold: number
  grossRevenueCents: number
  cogsCents: number
  referralFeesCents: number
  coverage: CoverageFlags
}): Promise<void> {
  const trueProfit =
    args.grossRevenueCents -
    args.cogsCents -
    args.referralFeesCents
  const marginPct =
    args.grossRevenueCents > 0
      ? trueProfit / args.grossRevenueCents
      : null

  await prisma.productProfitDaily.upsert({
    where: {
      productId_marketplace_date: {
        productId: args.productId,
        marketplace: args.marketplace,
        date: args.date,
      },
    },
    create: {
      productId: args.productId,
      marketplace: args.marketplace,
      date: args.date,
      unitsSold: args.unitsSold,
      grossRevenueCents: args.grossRevenueCents,
      cogsCents: args.cogsCents,
      referralFeesCents: args.referralFeesCents,
      fbaFulfillmentFeesCents: 0,
      fbaStorageFeesCents: 0,
      advertisingSpendCents: 0,
      returnsRefundsCents: 0,
      otherFeesCents: 0,
      trueProfitCents: trueProfit,
      trueProfitMarginPct: marginPct,
      coverage: args.coverage as unknown as object,
    },
    update: {
      unitsSold: args.unitsSold,
      grossRevenueCents: args.grossRevenueCents,
      cogsCents: args.cogsCents,
      referralFeesCents: args.referralFeesCents,
      trueProfitCents: trueProfit,
      trueProfitMarginPct: marginPct,
      coverage: args.coverage as unknown as object,
    },
  })
}

export interface RollupOptions {
  /** Inclusive start of the date range to roll up (UTC midnight). */
  fromDate?: Date
  /** Inclusive end of the range. */
  toDate?: Date
}

export async function runTrueProfitRollupOnce(
  options: RollupOptions = {},
): Promise<RollupSummary> {
  // Default: yesterday in UTC (most ad-related operator queries care
  // about "yesterday's numbers"). Caller can pass a wider range for
  // backfill.
  const today = utcMidnight(new Date())
  const fromDate = options.fromDate ?? new Date(today.getTime() - 24 * 60 * 60 * 1000)
  const toDate = options.toDate ?? new Date(today.getTime() - 1)

  const summary: RollupSummary = {
    datesProcessed: [],
    marketplacesProcessed: [],
    rowsUpserted: 0,
    errors: [],
  }
  const markets = new Set<string>()

  let cursor = utcMidnight(fromDate)
  const stop = utcMidnight(toDate)

  while (cursor <= stop) {
    const day = new Date(cursor)
    summary.datesProcessed.push(dateStr(day))
    try {
      const sales = await aggregateSalesForDay(day)
      for (const sale of sales) {
        const cogsPerUnitCents = await lookupCostPrice(sale.productId)
        const referralPct = await lookupReferralFeePct(sale.productId, sale.marketplace)
        const cogsCents =
          cogsPerUnitCents != null ? cogsPerUnitCents * sale.unitsSold : 0
        const referralFeesCents =
          referralPct != null
            ? Math.round(sale.grossRevenueCents * referralPct)
            : 0
        markets.add(sale.marketplace)
        await upsertRow({
          productId: sale.productId,
          marketplace: sale.marketplace,
          date: day,
          unitsSold: sale.unitsSold,
          grossRevenueCents: sale.grossRevenueCents,
          cogsCents,
          referralFeesCents,
          coverage: {
            hasCostPrice: cogsPerUnitCents != null,
            hasReferralFee: referralPct != null,
            // AD.1 doesn't wire FBA fees or ad spend yet; those flags
            // flip true in AD.2's metrics-ingest + financial-events
            // joins.
            hasFbaFee: false,
            hasAdSpend: false,
          },
        })
        summary.rowsUpserted += 1
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      summary.errors.push(`${dateStr(day)}: ${msg}`)
      logger.error('[true-profit-rollup] day failed', {
        date: dateStr(day),
        error: msg,
      })
    }
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
  }

  summary.marketplacesProcessed = Array.from(markets).sort()
  return summary
}

export function summarizeTrueProfitRollup(s: RollupSummary): string {
  return [
    `dates=${s.datesProcessed.length}`,
    `markets=${s.marketplacesProcessed.join(',') || 'none'}`,
    `rows=${s.rowsUpserted}`,
    s.errors.length > 0 ? `errors=${s.errors.length}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}
