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
import { getCachedReferralResolver } from '../amazon-real-fees.service.js'
import { logger } from '../../utils/logger.js'

interface RollupSummary {
  datesProcessed: string[]
  marketplacesProcessed: string[]
  rowsUpserted: number
  adSpendProductsUpdated: number
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
  // R1.4b — use the REAL referral rate derived from Amazon financial events
  // (per-SKU where coverage is sufficient, else marketplace, else overall).
  // The resolver is cached ~1h so this is one aggregate per rollup run.
  const resolver = await getCachedReferralResolver()
  const { pct } = resolver.resolve(productId, marketplace)
  if (pct != null) return pct
  // Last resort: the operator-set manual rate, if any (pre-R1.4b behaviour).
  const cl = await prisma.channelListing.findFirst({
    where: { productId, marketplace, referralFeePercent: { not: null } },
    select: { referralFeePercent: true },
  })
  if (!cl?.referralFeePercent) return null
  return Number(cl.referralFeePercent) / 100
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
    adSpendProductsUpdated: 0,
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

  // Fill advertisingSpendCents for every date we processed — runs after
  // the main loop so ProductProfitDaily rows already exist to patch.
  for (const dateStr_ of summary.datesProcessed) {
    try {
      const result = await fillAdSpend(new Date(dateStr_))
      summary.adSpendProductsUpdated += result.productsUpdated
      summary.errors.push(...result.errors)
    } catch (err) {
      summary.errors.push(`adSpend-${dateStr_}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return summary
}

// ── Ad-spend backfill (AD.4 / Phase 11 close-out) ────────────────────────
//
// Walks the join chain:
//   AmazonAdsDailyPerformance (CAMPAIGN, date=X)
//   → entityId = Campaign.externalCampaignId
//   → Campaign → AdGroup → AdProductAd → Product
//
// Distributes each campaign's daily spend proportionally across its
// products (1/N share per product), then patches the existing
// ProductProfitDaily row with real advertisingSpendCents + recalculated
// trueProfitCents. Sets coverage.hasAdSpend = true so the UI badge
// shows 100% coverage instead of 75%.
//
// Called at the end of runTrueProfitRollupOnce so ad spend always
// reflects the same day's reporting data.

export async function fillAdSpend(
  date: Date,
): Promise<{ productsUpdated: number; errors: string[] }> {
  const start = utcMidnight(date)
  const end   = new Date(start.getTime() + 86_400_000)

  // 1. Campaign-level spend aggregated by (entityId, marketplace) for this day
  const perfRows = await prisma.amazonAdsDailyPerformance.groupBy({
    by: ['entityId', 'marketplace'],
    where: { date: { gte: start, lt: end }, entityType: 'CAMPAIGN' },
    _sum: { costMicros: true },
  })
  if (perfRows.length === 0) return { productsUpdated: 0, errors: [] }

  const extCampaignIds = [...new Set(perfRows.map((r) => r.entityId))]

  // 2. Resolve join chain: Campaign → AdGroup → AdProductAd
  const campaigns = await prisma.campaign.findMany({
    where: { externalCampaignId: { in: extCampaignIds } },
    select: {
      id: true,
      externalCampaignId: true,
      marketplace: true,
      adGroups: {
        select: {
          productAds: { select: { productId: true, asin: true, sku: true } },
        },
      },
    },
  })

  // Batch-resolve asin/sku → productId in a single query
  const unresolvedAsins = new Set<string>()
  const unresolvedSkus  = new Set<string>()
  for (const camp of campaigns) {
    for (const ag of camp.adGroups) {
      for (const pa of ag.productAds) {
        if (!pa.productId) {
          if (pa.asin) unresolvedAsins.add(pa.asin)
          if (pa.sku)  unresolvedSkus.add(pa.sku)
        }
      }
    }
  }
  const resolvedProducts =
    unresolvedAsins.size > 0 || unresolvedSkus.size > 0
      ? await prisma.product.findMany({
          where: {
            OR: [
              ...(unresolvedAsins.size > 0 ? [{ amazonAsin: { in: [...unresolvedAsins] } }] : []),
              ...(unresolvedSkus.size  > 0 ? [{ sku:        { in: [...unresolvedSkus]  } }] : []),
            ],
          },
          select: { id: true, amazonAsin: true, sku: true },
        })
      : []
  const asinToId = new Map(resolvedProducts.filter((p) => p.amazonAsin).map((p) => [p.amazonAsin!, p.id]))
  const skuToId  = new Map(resolvedProducts.map((p) => [p.sku, p.id]))

  // Build externalCampaignId → { marketplace, productIds[] }
  const campMap = new Map<string, { marketplace: string; productIds: string[] }>()
  for (const camp of campaigns) {
    if (!camp.externalCampaignId) continue
    const ids = new Set<string>()
    for (const ag of camp.adGroups) {
      for (const pa of ag.productAds) {
        if (pa.productId) {
          ids.add(pa.productId)
        } else {
          const resolved = (pa.asin ? asinToId.get(pa.asin) : undefined)
            ?? (pa.sku  ? skuToId.get(pa.sku)   : undefined)
          if (resolved) ids.add(resolved)
        }
      }
    }
    campMap.set(camp.externalCampaignId, {
      marketplace: camp.marketplace ?? '',
      productIds: [...ids],
    })
  }

  // 3. Aggregate spend per (productId, marketplace) — equal share per product
  const spendMap = new Map<string, number>() // key: `${productId}::${marketplace}`
  for (const perf of perfRows) {
    const camp = campMap.get(perf.entityId)
    if (!camp || camp.productIds.length === 0) continue
    const spendCents   = Math.round(Number(perf._sum.costMicros ?? 0n) / 10_000)
    const perProduct   = Math.round(spendCents / camp.productIds.length)
    const marketplace  = perf.marketplace || camp.marketplace
    for (const productId of camp.productIds) {
      const key = `${productId}::${marketplace}`
      spendMap.set(key, (spendMap.get(key) ?? 0) + perProduct)
    }
  }

  // 4. Patch ProductProfitDaily rows
  let productsUpdated = 0
  const errors: string[] = []
  for (const [key, advertisingSpendCents] of spendMap) {
    const [productId, marketplace] = key.split('::')
    try {
      const row = await prisma.productProfitDaily.findUnique({
        where: { productId_marketplace_date: { productId, marketplace, date: start } },
        select: {
          grossRevenueCents: true,
          cogsCents: true,
          referralFeesCents: true,
          fbaFulfillmentFeesCents: true,
          returnsRefundsCents: true,
          coverage: true,
        },
      })
      if (!row) continue // rollup hasn't written this product yet — skip

      const trueProfit =
        row.grossRevenueCents
        - row.cogsCents
        - row.referralFeesCents
        - row.fbaFulfillmentFeesCents
        - advertisingSpendCents
        - row.returnsRefundsCents
      const marginPct =
        row.grossRevenueCents > 0 ? trueProfit / row.grossRevenueCents : null
      const coverage = { ...((row.coverage as object) ?? {}), hasAdSpend: true }

      await prisma.productProfitDaily.update({
        where: { productId_marketplace_date: { productId, marketplace, date: start } },
        data: { advertisingSpendCents, trueProfitCents: trueProfit, trueProfitMarginPct: marginPct, coverage },
      })
      productsUpdated++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`${key}: ${msg}`)
      logger.warn('[true-profit-rollup] ad-spend patch failed', { key, error: msg })
    }
  }

  logger.info('[true-profit-rollup] ad-spend fill complete', {
    date: dateStr(date), campaignsResolved: campMap.size,
    productsInSpendMap: spendMap.size, productsUpdated,
  })
  return { productsUpdated, errors }
}

export function summarizeTrueProfitRollup(s: RollupSummary): string {
  return [
    `dates=${s.datesProcessed.length}`,
    `markets=${s.marketplacesProcessed.join(',') || 'none'}`,
    `rows=${s.rowsUpserted}`,
    s.adSpendProductsUpdated > 0 ? `adSpend=${s.adSpendProductsUpdated}` : null,
    s.errors.length > 0 ? `errors=${s.errors.length}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}
