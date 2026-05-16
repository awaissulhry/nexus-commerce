/**
 * AD.2 — Pulls Amazon Ads performance reports and hydrates per-entity
 * metrics on Campaign / AdGroup / AdTarget / AdProductAd.
 *
 * Amazon Reports API is async: POST request → poll status → download
 * compressed JSON. The ads-api-client wraps that in fetchReport() and
 * returns parsed rows in sandbox mode via __fixtures__/report-*.json.
 *
 * Aggregation strategy:
 *   - Pull last 30 days for each report type
 *   - SUM impressions/clicks/costMicros/attributedSales per entity
 *   - Recompute acos / roas on Campaign (sales > 0 only)
 *   - Idempotent: rerunnable; metrics are absolute counters (not deltas)
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import {
  fetchReport,
  adsMode,
  type ClientContext,
  type AdsRegion,
  type ReportRow,
} from './ads-api-client.js'

interface IngestSummary {
  profileCount: number
  reportRows: {
    campaigns: number
    adGroups: number
    keywords: number
    productAds: number
  }
  entitiesUpdated: {
    campaigns: number
    adGroups: number
    targets: number
    productAds: number
    profitRows: number
  }
  errors: string[]
  mode: 'sandbox' | 'live'
}

interface ProfileSyncContext {
  profileId: string
  region: AdsRegion
  marketplace: string
}

async function discoverActiveProfiles(): Promise<ProfileSyncContext[]> {
  if (adsMode() === 'sandbox') {
    return [
      { profileId: 'SANDBOX-PROFILE-IT-001', region: 'EU', marketplace: 'IT' },
      { profileId: 'SANDBOX-PROFILE-DE-002', region: 'EU', marketplace: 'DE' },
    ]
  }
  const conns = await prisma.amazonAdsConnection.findMany({
    where: { isActive: true },
    select: { profileId: true, region: true, marketplace: true },
  })
  return conns.map((c) => ({
    profileId: c.profileId,
    region: (c.region === 'NA' || c.region === 'FE' ? c.region : 'EU') as AdsRegion,
    marketplace: c.marketplace,
  }))
}

interface Aggregate {
  impressions: number
  clicks: number
  spendCents: number
  salesCents: number
  ordersCount: number
}

function emptyAgg(): Aggregate {
  return { impressions: 0, clicks: 0, spendCents: 0, salesCents: 0, ordersCount: 0 }
}

function addRowToAgg(agg: Aggregate, row: ReportRow): void {
  agg.impressions += row.impressions ?? 0
  agg.clicks += row.clicks ?? 0
  agg.spendCents += Math.round((row.costMicros ?? 0) / 10_000) // micros → cents
  // Use 7d-attribution as the default sales window. Amazon's 14d figure
  // is more generous but lags reality; 7d is the standard.
  agg.salesCents += Math.round((row.attributedSales7d ?? 0) * 100)
  agg.ordersCount += row.attributedOrders7d ?? 0
}

function aggregateByKey(
  rows: ReportRow[],
  keyOf: (r: ReportRow) => string | undefined,
): Map<string, Aggregate> {
  const out = new Map<string, Aggregate>()
  for (const row of rows) {
    const key = keyOf(row)
    if (!key) continue
    const agg = out.get(key) ?? emptyAgg()
    addRowToAgg(agg, row)
    out.set(key, agg)
  }
  return out
}

function dateStrDaysAgo(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10)
}

async function applyCampaignMetrics(
  agg: Map<string, Aggregate>,
  marketplace: string,
): Promise<number> {
  let updated = 0
  for (const [externalCampaignId, m] of agg) {
    const camp = await prisma.campaign.findFirst({
      where: { externalCampaignId, marketplace },
      select: { id: true },
    })
    if (!camp) continue
    const acos = m.salesCents > 0 ? m.spendCents / m.salesCents : null
    const roas = m.spendCents > 0 ? m.salesCents / m.spendCents : null
    await prisma.campaign.update({
      where: { id: camp.id },
      data: {
        impressions: m.impressions,
        clicks: m.clicks,
        spend: m.spendCents / 100,
        sales: m.salesCents / 100,
        acos,
        roas,
      },
    })
    updated += 1
  }
  return updated
}

async function applyAdGroupMetrics(agg: Map<string, Aggregate>): Promise<number> {
  let updated = 0
  for (const [externalAdGroupId, m] of agg) {
    const adGroup = await prisma.adGroup.findFirst({
      where: { externalAdGroupId },
      select: { id: true },
    })
    if (!adGroup) continue
    await prisma.adGroup.update({
      where: { id: adGroup.id },
      data: {
        impressions: m.impressions,
        clicks: m.clicks,
        spendCents: m.spendCents,
        salesCents: m.salesCents,
      },
    })
    updated += 1
  }
  return updated
}

async function applyTargetMetrics(agg: Map<string, Aggregate>): Promise<number> {
  let updated = 0
  for (const [externalTargetId, m] of agg) {
    const target = await prisma.adTarget.findFirst({
      where: { externalTargetId },
      select: { id: true },
    })
    if (!target) continue
    await prisma.adTarget.update({
      where: { id: target.id },
      data: {
        impressions: m.impressions,
        clicks: m.clicks,
        spendCents: m.spendCents,
        salesCents: m.salesCents,
        ordersCount: m.ordersCount,
      },
    })
    updated += 1
  }
  return updated
}

async function applyProductAdMetrics(agg: Map<string, Aggregate>): Promise<number> {
  let updated = 0
  for (const [externalAdId, m] of agg) {
    const pa = await prisma.adProductAd.findFirst({
      where: { externalAdId },
      select: { id: true },
    })
    if (!pa) continue
    await prisma.adProductAd.update({
      where: { id: pa.id },
      data: {
        impressions: m.impressions,
        clicks: m.clicks,
        spendCents: m.spendCents,
        salesCents: m.salesCents,
      },
    })
    updated += 1
  }
  return updated
}

// Backfill daily ad spend into ProductProfitDaily so True Profit is accurate.
// Uses the per-day rows from the DAILY Report to attribute spendCents per
// (productId, marketplace, date). Rows without a productId link are skipped.
async function backfillAdSpendToProfit(
  productAdRows: ReportRow[],
  marketplace: string,
): Promise<number> {
  // Group: Map<externalAdId, Map<date, spendCents>>
  const byAd = new Map<string, Map<string, number>>()
  for (const row of productAdRows) {
    if (!row.externalAdId || !row.date) continue
    const spendCents = Math.round((row.costMicros ?? 0) / 10_000)
    if (!byAd.has(row.externalAdId)) byAd.set(row.externalAdId, new Map())
    const dateMap = byAd.get(row.externalAdId)!
    dateMap.set(row.date, (dateMap.get(row.date) ?? 0) + spendCents)
  }

  let updated = 0
  for (const [externalAdId, dateMap] of byAd) {
    const pa = await prisma.adProductAd.findFirst({
      where: { externalAdId },
      select: { productId: true },
    })
    if (!pa?.productId) continue

    for (const [dateStr, spendCents] of dateMap) {
      if (spendCents === 0) continue
      const date = new Date(`${dateStr}T00:00:00.000Z`)
      // Pull existing row to recompute trueProfit with ad spend included.
      const existing = await prisma.productProfitDaily.findUnique({
        where: {
          productId_marketplace_date: {
            productId: pa.productId,
            marketplace,
            date,
          },
        },
        select: {
          grossRevenueCents: true,
          cogsCents: true,
          referralFeesCents: true,
          fbaFulfillmentFeesCents: true,
          fbaStorageFeesCents: true,
          returnsRefundsCents: true,
          otherFeesCents: true,
          coverage: true,
        },
      })
      if (!existing) continue

      const trueProfitCents =
        existing.grossRevenueCents -
        existing.cogsCents -
        existing.referralFeesCents -
        existing.fbaFulfillmentFeesCents -
        existing.fbaStorageFeesCents -
        spendCents -
        existing.returnsRefundsCents -
        existing.otherFeesCents

      const marginPct =
        existing.grossRevenueCents > 0
          ? trueProfitCents / existing.grossRevenueCents
          : null

      const prevCoverage =
        (existing.coverage as Record<string, boolean> | null) ?? {}

      await prisma.productProfitDaily.update({
        where: {
          productId_marketplace_date: {
            productId: pa.productId,
            marketplace,
            date,
          },
        },
        data: {
          advertisingSpendCents: spendCents,
          trueProfitCents,
          trueProfitMarginPct: marginPct,
          coverage: { ...prevCoverage, hasAdSpend: true },
        },
      })
      updated += 1
    }
  }
  return updated
}

export async function runAdsMetricsIngestOnce(): Promise<IngestSummary> {
  const mode = adsMode()
  const profiles = await discoverActiveProfiles()
  const summary: IngestSummary = {
    profileCount: profiles.length,
    reportRows: { campaigns: 0, adGroups: 0, keywords: 0, productAds: 0 },
    entitiesUpdated: { campaigns: 0, adGroups: 0, targets: 0, productAds: 0, profitRows: 0 },
    errors: [],
    mode,
  }

  const startDate = dateStrDaysAgo(30)
  const endDate = dateStrDaysAgo(1)

  for (const profile of profiles) {
    const ctx: ClientContext = { profileId: profile.profileId, region: profile.region }
    try {
      const [campaignRows, adGroupRows, keywordRows, productAdRows] = await Promise.all([
        fetchReport(ctx, { reportType: 'campaigns', startDate, endDate }),
        fetchReport(ctx, { reportType: 'adGroups', startDate, endDate }),
        fetchReport(ctx, { reportType: 'keywords', startDate, endDate }),
        fetchReport(ctx, { reportType: 'productAds', startDate, endDate }),
      ])
      summary.reportRows.campaigns += campaignRows.length
      summary.reportRows.adGroups += adGroupRows.length
      summary.reportRows.keywords += keywordRows.length
      summary.reportRows.productAds += productAdRows.length

      summary.entitiesUpdated.campaigns += await applyCampaignMetrics(
        aggregateByKey(campaignRows, (r) => r.externalCampaignId),
        profile.marketplace,
      )
      summary.entitiesUpdated.adGroups += await applyAdGroupMetrics(
        aggregateByKey(adGroupRows, (r) => r.externalAdGroupId),
      )
      summary.entitiesUpdated.targets += await applyTargetMetrics(
        aggregateByKey(keywordRows, (r) => r.externalTargetId),
      )
      summary.entitiesUpdated.productAds += await applyProductAdMetrics(
        aggregateByKey(productAdRows, (r) => r.externalAdId),
      )
      // Back-fill daily ad spend into ProductProfitDaily so True Profit
      // reflects real advertising costs per SKU per day.
      summary.entitiesUpdated.profitRows += await backfillAdSpendToProfit(
        productAdRows,
        profile.marketplace,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      summary.errors.push(`profile ${profile.profileId}: ${msg}`)
      logger.error('[ads-metrics-ingest] profile failed', {
        profileId: profile.profileId,
        error: msg,
      })
    }
  }

  return summary
}

export function summarizeAdsMetricsIngest(s: IngestSummary): string {
  return [
    `mode=${s.mode}`,
    `profiles=${s.profileCount}`,
    `rows=${s.reportRows.campaigns}c+${s.reportRows.adGroups}ag+${s.reportRows.keywords}k+${s.reportRows.productAds}pa`,
    `updated=${s.entitiesUpdated.campaigns}c+${s.entitiesUpdated.adGroups}ag+${s.entitiesUpdated.targets}t+${s.entitiesUpdated.productAds}pa+${s.entitiesUpdated.profitRows}profit`,
    s.errors.length > 0 ? `errors=${s.errors.length}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}
