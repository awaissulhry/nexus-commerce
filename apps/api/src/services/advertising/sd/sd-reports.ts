/**
 * SD reports below the campaign (2026-10-20) — what Nexus asks Amazon about Sponsored Display under the campaign, and how
 * one report row becomes a stored row. Pure: no database, no Amazon call.
 *
 *   sdAdGroup            groupBy adGroup     → AmazonAdsSdDailyPerformance AD_GROUP   (entityId = adGroupId)
 *   sdTargeting          groupBy targeting   → AmazonAdsSdDailyPerformance AD_TARGET  (entityId = targetingId)
 *   sdAdvertisedProduct  groupBy advertiser  → AmazonAdsSdDailyPerformance PRODUCT_AD (entityId = adId)
 *   sdPurchasedProduct   groupBy asin        → AmazonAdsSdPurchasedProduct (the advertised ASIN → the other ASIN bought)
 *
 * Every column asked below is in Amazon's v3 reporting list for its report and group-by (the SD report-type pages,
 * read 2026-10-20). An unknown column makes Amazon refuse the whole report (ads-reports.service.ts, the Phase G notes),
 * and that refusal reaches the create cron's line. Display attributes 14 days, after a click OR a view: Amazon's
 * `sales`, `purchases`, `unitsSold`, `detailPageViews` and `newToBrand*` count both, and their `…Clicks` twins count
 * after a click only. Both are kept; after a view is the difference. Amazon keeps SD report data 65 days and answers up
 * to 31 days of DAILY rows in one report.
 */

export const SD_AD_GROUP_REPORT_TYPE_ID = 'sdAdGroup'
export const SD_TARGETING_REPORT_TYPE_ID = 'sdTargeting'
export const SD_ADVERTISED_PRODUCT_REPORT_TYPE_ID = 'sdAdvertisedProduct'
export const SD_PURCHASED_PRODUCT_REPORT_TYPE_ID = 'sdPurchasedProduct'

/** The figures every SD entity report carries: the 14-day totals (click or view) and their after-a-click twins. */
const SD_METRIC_COLUMNS = [
  'impressions', 'impressionsViews', 'clicks', 'cost',
  'sales', 'salesClicks', 'purchases', 'purchasesClicks', 'unitsSold', 'unitsSoldClicks',
  'detailPageViews', 'detailPageViewsClicks',
  'newToBrandPurchases', 'newToBrandPurchasesClicks', 'newToBrandSales', 'newToBrandSalesClicks',
  'newToBrandUnitsSold', 'newToBrandUnitsSoldClicks',
]

export interface SdReportSpec {
  reportTypeId: string
  /** How the report is named in a log line or a cron summary. */
  label: string
  groupBy: string[]
  columns: string[]
}

export const SD_REPORTS: readonly SdReportSpec[] = [
  {
    reportTypeId: SD_AD_GROUP_REPORT_TYPE_ID, label: 'ad group', groupBy: ['adGroup'],
    columns: ['date', 'campaignId', 'adGroupId', 'adGroupName', ...SD_METRIC_COLUMNS],
  },
  {
    reportTypeId: SD_TARGETING_REPORT_TYPE_ID, label: 'targeting', groupBy: ['targeting'],
    columns: ['date', 'campaignId', 'adGroupId', 'targetingId', 'targetingExpression', 'targetingText', 'adKeywordStatus', ...SD_METRIC_COLUMNS],
  },
  {
    reportTypeId: SD_ADVERTISED_PRODUCT_REPORT_TYPE_ID, label: 'advertised product', groupBy: ['advertiser'],
    columns: ['date', 'campaignId', 'adGroupId', 'adId', 'promotedAsin', 'promotedSku', ...SD_METRIC_COLUMNS],
  },
  {
    // "Brand halo": a product bought after the ad that is not the advertised one. The totals are Amazon's for vcpm
    // campaigns (a click or a view); the `…Clicks` figures count after a click.
    reportTypeId: SD_PURCHASED_PRODUCT_REPORT_TYPE_ID, label: 'purchased product', groupBy: ['asin'],
    columns: [
      'date', 'campaignId', 'adGroupId', 'promotedAsin', 'promotedSku', 'asinBrandHalo',
      'salesBrandHalo', 'salesBrandHaloClicks', 'conversionsBrandHalo', 'conversionsBrandHaloClicks',
      'unitsSoldBrandHalo', 'unitsSoldBrandHaloClicks',
    ],
  },
]

export type SdEntityType = 'AD_GROUP' | 'AD_TARGET' | 'PRODUCT_AD'

/** The SD reports stored per entity, and the entity each row is. */
export const SD_ENTITY_OF: Readonly<Record<string, SdEntityType>> = {
  [SD_AD_GROUP_REPORT_TYPE_ID]: 'AD_GROUP',
  [SD_TARGETING_REPORT_TYPE_ID]: 'AD_TARGET',
  [SD_ADVERTISED_PRODUCT_REPORT_TYPE_ID]: 'PRODUCT_AD',
}

export type SdReportRow = Record<string, unknown>

// ── Converters: null stays null (Amazon sent nothing), 0 stays 0 (Amazon said zero) ────────────────────────────────

function numberOf(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const intOf = (v: unknown): number | null => {
  const n = numberOf(v)
  return n == null ? null : Math.round(n)
}
const centsOf = (v: unknown): number | null => {
  const n = numberOf(v)
  return n == null ? null : Math.round(n * 100)
}
const textOf = (v: unknown): string | null => (v == null || v === '' ? null : String(v))
/** A report date (YYYY-MM-DD) as the UTC day the daily tables key on; null when it is not one. */
function dayOf(v: unknown): Date | null {
  if (v == null || v === '') return null
  const d = new Date(`${String(v).slice(0, 10)}T00:00:00.000Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

/** The figures of one SD entity row, as AmazonAdsSdDailyPerformance stores them. */
export interface SdDailyFigures {
  impressions: number
  viewableImpressions: number | null
  clicks: number
  costMicros: bigint
  sales14dCents: number | null
  salesClicks14dCents: number | null
  orders14d: number | null
  ordersClicks14d: number | null
  units14d: number | null
  unitsClicks14d: number | null
  detailPageViews14d: number | null
  detailPageViewsClicks14d: number | null
  ntbOrders14d: number | null
  ntbOrdersClicks14d: number | null
  ntbSalesCents14d: number | null
  ntbSalesClicksCents14d: number | null
  ntbUnits14d: number | null
  ntbUnitsClicks14d: number | null
}

export interface SdDailyRow extends SdDailyFigures {
  date: Date
  entityType: SdEntityType
  entityId: string
  campaignId: string
  adGroupId: string | null
  entityName: string | null
  targetingExpression: string | null
  entityStatus: string | null
  promotedAsin: string | null
  promotedSku: string | null
}

/** The figures of one row of sdAdGroup / sdTargeting / sdAdvertisedProduct. */
export function sdDailyFiguresOf(r: SdReportRow): SdDailyFigures {
  return {
    impressions: intOf(r.impressions) ?? 0,
    viewableImpressions: intOf(r.impressionsViews),
    clicks: intOf(r.clicks) ?? 0,
    costMicros: BigInt(Math.round((numberOf(r.cost) ?? 0) * 1_000_000)),
    sales14dCents: centsOf(r.sales),
    salesClicks14dCents: centsOf(r.salesClicks),
    orders14d: intOf(r.purchases),
    ordersClicks14d: intOf(r.purchasesClicks),
    units14d: intOf(r.unitsSold),
    unitsClicks14d: intOf(r.unitsSoldClicks),
    detailPageViews14d: intOf(r.detailPageViews),
    detailPageViewsClicks14d: intOf(r.detailPageViewsClicks),
    ntbOrders14d: intOf(r.newToBrandPurchases),
    ntbOrdersClicks14d: intOf(r.newToBrandPurchasesClicks),
    ntbSalesCents14d: centsOf(r.newToBrandSales),
    ntbSalesClicksCents14d: centsOf(r.newToBrandSalesClicks),
    ntbUnits14d: intOf(r.newToBrandUnitsSold),
    ntbUnitsClicks14d: intOf(r.newToBrandUnitsSoldClicks),
  }
}

/** The entity id of a row of each SD entity report: Amazon's ad group id, targeting id or ad id. */
const ENTITY_ID: Record<SdEntityType, (r: SdReportRow) => unknown> = {
  AD_GROUP: (r) => r.adGroupId,
  AD_TARGET: (r) => r.targetingId,
  PRODUCT_AD: (r) => r.adId,
}

/**
 * One row of an SD entity report as AmazonAdsSdDailyPerformance stores it; null when the row names no day, campaign or
 * entity (it cannot be keyed, so it is not stored) or the report is not an SD entity report.
 */
export function sdDailyRowOf(reportTypeId: string, r: SdReportRow): SdDailyRow | null {
  const entityType = SD_ENTITY_OF[reportTypeId]
  if (!entityType) return null
  const date = dayOf(r.date)
  const entityId = textOf(ENTITY_ID[entityType](r))
  const campaignId = textOf(r.campaignId)
  if (!date || !entityId || !campaignId) return null
  return {
    date, entityType, entityId, campaignId,
    adGroupId: textOf(r.adGroupId),
    entityName: entityType === 'AD_GROUP' ? textOf(r.adGroupName) : entityType === 'AD_TARGET' ? textOf(r.targetingText) : null,
    targetingExpression: entityType === 'AD_TARGET' ? textOf(r.targetingExpression) : null,
    entityStatus: entityType === 'AD_TARGET' ? textOf(r.adKeywordStatus) : null,
    promotedAsin: entityType === 'PRODUCT_AD' ? textOf(r.promotedAsin) : null,
    promotedSku: entityType === 'PRODUCT_AD' ? textOf(r.promotedSku) : null,
    ...sdDailyFiguresOf(r),
  }
}

/** One row of sdPurchasedProduct as AmazonAdsSdPurchasedProduct stores it. */
export interface SdPurchasedRow {
  date: Date
  campaignId: string
  adGroupId: string
  promotedAsin: string
  promotedSku: string | null
  purchasedAsin: string
  sales14dCents: number | null
  salesClicks14dCents: number | null
  orders14d: number | null
  ordersClicks14d: number | null
  units14d: number | null
  unitsClicks14d: number | null
}

/** Null when the row names no day, campaign, ad group, advertised ASIN or bought ASIN (it says nothing to keep). */
export function sdPurchasedRowOf(r: SdReportRow): SdPurchasedRow | null {
  const date = dayOf(r.date)
  const campaignId = textOf(r.campaignId)
  const adGroupId = textOf(r.adGroupId)
  const promotedAsin = textOf(r.promotedAsin)
  const purchasedAsin = textOf(r.asinBrandHalo)
  if (!date || !campaignId || !adGroupId || !promotedAsin || !purchasedAsin) return null
  return {
    date, campaignId, adGroupId, promotedAsin, purchasedAsin,
    promotedSku: textOf(r.promotedSku),
    sales14dCents: centsOf(r.salesBrandHalo),
    salesClicks14dCents: centsOf(r.salesBrandHaloClicks),
    orders14d: intOf(r.conversionsBrandHalo),
    ordersClicks14d: intOf(r.conversionsBrandHaloClicks),
    units14d: intOf(r.unitsSoldBrandHalo),
    unitsClicks14d: intOf(r.unitsSoldBrandHaloClicks),
  }
}
