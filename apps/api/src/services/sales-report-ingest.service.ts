/**
 * F.3.2 — Amazon Sales & Traffic report ingest.
 *
 * Pulls GET_SALES_AND_TRAFFIC_REPORT for a given marketplace + date range,
 * resolves ASINs back to local SKUs via ChannelListing.externalListingId
 * (parent ASIN) and VariantChannelListing.channelProductId (child ASIN),
 * upserts the per-day per-SKU rows into DailySalesAggregate with
 * source='AMAZON_REPORT'. The source field gives this canonical Amazon
 * data precedence over OrderItem-derived rows the refresh service writes.
 *
 * Report shape (per Amazon SP-API docs as of knowledge cutoff):
 *   {
 *     reportSpecification: {...},
 *     salesAndTrafficByDate: [
 *       { date: '2026-05-04', salesByDate: {...}, trafficByDate: {...} }
 *     ],
 *     salesAndTrafficByAsin: [
 *       { parentAsin, childAsin, sku, salesByAsin: {...}, trafficByAsin: {...} }
 *     ]
 *   }
 *
 * For per-SKU per-day granularity we run the report for a single day at
 * a time. The salesAndTrafficByAsin array carries ASIN-level totals for
 * that day, with parentAsin + childAsin + sku populated.
 *
 * NOT END-TO-END TESTED — no SP-API credentials available locally. The
 * code path is real; first credentialed run will reveal any field-name
 * differences between the docs and what Amazon actually emits per
 * marketplace. Falls back to logging warnings for any ASIN that doesn't
 * resolve to a local SKU.
 */

import prisma from '../db.js'
import { fetchSpApiJsonReport } from './sp-api-reports.service.js'
import { logger } from '../utils/logger.js'

interface IngestArgs {
  /** Marketplace code (IT, DE, FR, ...) — resolved to SP-API ID via the
   *  Marketplace lookup table. */
  marketplaceCode: string
  /** Day to ingest (UTC, day boundary). The Sales & Traffic report is
   *  pulled with dataStartTime = day, dataEndTime = day + 1. */
  day: Date
  /** When true, reuses an existing AMAZON_REPORT row even if a fresh
   *  fetch returned different numbers (skip-write). Default false: a
   *  re-ingest overwrites with the latest numbers. */
  skipIfReportExists?: boolean
}

interface IngestResult {
  marketplaceCode: string
  marketplaceId: string
  day: string
  asinsRead: number
  rowsUpserted: number
  asinsSkippedUnresolved: number
  durationMs: number
}

/**
 * SP-API Sales & Traffic report payload (subset we care about). Field
 * names match the documented JSON schema; extra fields are ignored.
 */
interface SalesTrafficReport {
  salesAndTrafficByAsin?: Array<{
    parentAsin?: string
    childAsin?: string
    sku?: string
    salesByAsin?: {
      unitsOrdered?: number
      unitsOrderedB2B?: number
      orderedProductSales?: { amount: number; currencyCode: string }
      totalOrderItems?: number
    }
    trafficByAsin?: {
      sessions?: number
      sessionsB2B?: number
      pageViews?: number
      buyBoxPercentage?: number
      unitSessionPercentage?: number
    }
  }>
}

export async function ingestSalesTrafficForDay(
  args: IngestArgs,
): Promise<IngestResult> {
  const startedAt = Date.now()
  const marketplaceCode = args.marketplaceCode.toUpperCase()
  const day = startOfDay(args.day)

  // Resolve country code → SP-API marketplace ID via the Marketplace table.
  // Fail fast if the row is missing — better than calling SP-API with the
  // wrong ID and getting a confusing error back.
  const marketplaceRow = await prisma.marketplace.findUnique({
    where: { channel_code: { channel: 'AMAZON', code: marketplaceCode } },
  })
  if (!marketplaceRow?.marketplaceId) {
    throw new Error(
      `ingestSalesTrafficForDay: no Marketplace row for AMAZON:${marketplaceCode} or marketplaceId is null`,
    )
  }
  const marketplaceId = marketplaceRow.marketplaceId

  // ── Fetch the report ────────────────────────────────────────────
  // Single-day window: dataStartTime = day, dataEndTime = next-day. SP-API
  // expects ISO-8601 timestamps with timezone; UTC throughout.
  const dayEnd = new Date(day)
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1)

  const { payload } = await fetchSpApiJsonReport<SalesTrafficReport>({
    reportType: 'GET_SALES_AND_TRAFFIC_REPORT',
    marketplaceId,
    dataStartTime: day,
    dataEndTime: dayEnd,
    reportOptions: {
      // Granularity: ASIN level (default), and date-range single-day.
      // 'aggregateByDate' / 'aggregateByAsin' selectors are the docs'
      // canonical names; they vary by report version. Caller can pass
      // overrides via reportOptions if Amazon updates the spec.
    },
  })

  const asinRows = payload.salesAndTrafficByAsin ?? []

  // ── Resolve ASINs → local SKUs ──────────────────────────────────
  // Strategy:
  //   1. Prefer the report's `sku` field if Amazon includes it (many
  //      reports do — saves us the lookup).
  //   2. Else lookup childAsin via VariantChannelListing.channelProductId
  //      (variants on this marketplace).
  //   3. Else lookup parentAsin via ChannelListing.externalParentId or
  //      .externalListingId for that marketplace.
  // Anything still unresolved is logged + skipped (counted in the result).
  const childAsins = [
    ...new Set(
      asinRows
        .map((r) => r.childAsin)
        .filter((a): a is string => typeof a === 'string' && a.length > 0),
    ),
  ]
  const parentAsins = [
    ...new Set(
      asinRows
        .map((r) => r.parentAsin)
        .filter((a): a is string => typeof a === 'string' && a.length > 0),
    ),
  ]

  const [vcls, parentListings] = await Promise.all([
    childAsins.length > 0
      ? prisma.variantChannelListing.findMany({
          where: {
            channel: 'AMAZON',
            marketplace: marketplaceCode,
            channelProductId: { in: childAsins },
          },
          select: {
            channelProductId: true,
            channelSku: true,
            variant: { select: { sku: true } },
          },
        })
      : [],
    parentAsins.length > 0
      ? prisma.channelListing.findMany({
          where: {
            channel: 'AMAZON',
            marketplace: marketplaceCode,
            OR: [
              { externalParentId: { in: parentAsins } },
              { externalListingId: { in: parentAsins } },
            ],
          },
          select: {
            externalParentId: true,
            externalListingId: true,
            product: { select: { sku: true } },
          },
        })
      : [],
  ])

  const skuByChildAsin = new Map<string, string>()
  for (const v of vcls) {
    if (v.channelProductId) {
      skuByChildAsin.set(v.channelProductId, v.channelSku ?? v.variant.sku)
    }
  }
  const skuByParentAsin = new Map<string, string>()
  for (const cl of parentListings) {
    if (cl.externalParentId) skuByParentAsin.set(cl.externalParentId, cl.product.sku)
    if (cl.externalListingId) skuByParentAsin.set(cl.externalListingId, cl.product.sku)
  }

  // ── Upsert each row into DailySalesAggregate ───────────────────
  let rowsUpserted = 0
  let asinsSkippedUnresolved = 0
  for (const row of asinRows) {
    let sku: string | null = null
    if (typeof row.sku === 'string' && row.sku.length > 0) {
      sku = row.sku
    } else if (row.childAsin && skuByChildAsin.has(row.childAsin)) {
      sku = skuByChildAsin.get(row.childAsin) ?? null
    } else if (row.parentAsin && skuByParentAsin.has(row.parentAsin)) {
      sku = skuByParentAsin.get(row.parentAsin) ?? null
    }
    if (!sku) {
      asinsSkippedUnresolved++
      continue
    }

    const sales = row.salesByAsin ?? {}
    const traffic = row.trafficByAsin ?? {}
    const unitsSold =
      (sales.unitsOrdered ?? 0) + (sales.unitsOrderedB2B ?? 0)
    const ordersCount = sales.totalOrderItems ?? 0
    const grossRevenue =
      typeof sales.orderedProductSales?.amount === 'number'
        ? sales.orderedProductSales.amount
        : 0
    const sessions =
      typeof traffic.sessions === 'number'
        ? traffic.sessions + (traffic.sessionsB2B ?? 0)
        : null
    const buyBoxPct =
      typeof traffic.buyBoxPercentage === 'number'
        ? traffic.buyBoxPercentage
        : null
    const conversionRate =
      typeof traffic.unitSessionPercentage === 'number'
        ? traffic.unitSessionPercentage / 100 // SP-API returns percentage; we store fraction
        : null
    const averageSellingPrice =
      unitsSold > 0 ? Number((grossRevenue / unitsSold).toFixed(2)) : null

    if (args.skipIfReportExists) {
      const existing = await prisma.dailySalesAggregate.findUnique({
        where: {
          sku_channel_marketplace_day: {
            sku,
            channel: 'AMAZON',
            marketplace: marketplaceCode,
            day,
          },
        },
        select: { source: true },
      })
      if (existing?.source === 'AMAZON_REPORT') continue
    }

    await prisma.dailySalesAggregate.upsert({
      where: {
        sku_channel_marketplace_day: {
          sku,
          channel: 'AMAZON',
          marketplace: marketplaceCode,
          day,
        },
      },
      create: {
        sku,
        channel: 'AMAZON',
        marketplace: marketplaceCode,
        day,
        unitsSold,
        grossRevenue: grossRevenue.toFixed(2),
        ordersCount,
        sessions,
        buyBoxPct: buyBoxPct == null ? null : buyBoxPct.toFixed(2),
        conversionRate: conversionRate == null ? null : conversionRate.toFixed(4),
        averageSellingPrice:
          averageSellingPrice == null ? null : averageSellingPrice.toFixed(2),
        source: 'AMAZON_REPORT',
      },
      update: {
        unitsSold,
        grossRevenue: grossRevenue.toFixed(2),
        ordersCount,
        sessions,
        buyBoxPct: buyBoxPct == null ? null : buyBoxPct.toFixed(2),
        conversionRate: conversionRate == null ? null : conversionRate.toFixed(4),
        averageSellingPrice:
          averageSellingPrice == null ? null : averageSellingPrice.toFixed(2),
        source: 'AMAZON_REPORT',
      },
    })
    rowsUpserted++
  }

  const durationMs = Date.now() - startedAt
  logger.info('sales-report-ingest: complete', {
    marketplaceCode,
    marketplaceId,
    day: day.toISOString().slice(0, 10),
    asinsRead: asinRows.length,
    rowsUpserted,
    asinsSkippedUnresolved,
    durationMs,
  })

  if (asinsSkippedUnresolved > 0) {
    logger.warn('sales-report-ingest: some ASINs did not resolve to local SKUs', {
      count: asinsSkippedUnresolved,
      marketplaceCode,
      day: day.toISOString().slice(0, 10),
    })
  }

  return {
    marketplaceCode,
    marketplaceId,
    day: day.toISOString().slice(0, 10),
    asinsRead: asinRows.length,
    rowsUpserted,
    asinsSkippedUnresolved,
    durationMs,
  }
}

/**
 * Multi-marketplace nightly ingest. Reads every active Amazon
 * ChannelConnection and runs ingestSalesTrafficForDay for each.
 *
 * Failures on one marketplace don't stop the others — each is wrapped in
 * its own try/catch and the result array carries per-marketplace errors.
 *
 * For Xavia today this is single-tenant (one Amazon account) but the
 * loop pattern is right for the multi-tenant future. Until per-tenant
 * credentials land in ChannelConnection, the env vars are the credential
 * source so all "active connections" share them.
 */
export async function ingestAllAmazonMarketplaces(
  day: Date,
): Promise<Array<IngestResult | { marketplaceCode: string; error: string }>> {
  // For now we ingest every marketplace that has at least one
  // ChannelListing on AMAZON. As the Marketplace table is reference data,
  // not per-seller config, we infer "which marketplaces should we ingest
  // for" from existing listings.
  const distinct = await prisma.channelListing.groupBy({
    by: ['marketplace'],
    where: { channel: 'AMAZON' },
  })
  const codes = distinct.map((r) => r.marketplace).filter((c) => c !== 'GLOBAL')

  const results: Array<IngestResult | { marketplaceCode: string; error: string }> = []
  for (const code of codes) {
    try {
      results.push(await ingestSalesTrafficForDay({ marketplaceCode: code, day }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('sales-report-ingest: marketplace failed', {
        marketplaceCode: code,
        error: message,
      })
      results.push({ marketplaceCode: code, error: message })
    }
  }
  return results
}

function startOfDay(d: Date): Date {
  const out = new Date(d)
  out.setUTCHours(0, 0, 0, 0)
  return out
}
