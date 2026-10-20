/**
 * SD reports below the campaign (2026-10-20) — the reads of AmazonAdsSdDailyPerformance and AmazonAdsSdPurchasedProduct
 * for Claude's ad reads: ad-targets (a Sponsored Display target's metrics), ad-groups (an SD ad group's and its product
 * ads' metrics) and ad-purchased-products (what shoppers bought after an SD ad).
 *
 * The figures keep the read tools' metric keys (impressions, clicks, orders, spendCents, salesCents, cpcCents, acos, roas)
 * and add what Display reports besides: viewable impressions, units, detail page views, new-to-brand, and the split of
 * every attributed figure into after a click and after a view. Display attributes 14 days, after a click or a view: a
 * headline figure (orders, salesCents, …) counts both, `afterClick` counts after a click, `afterView` is the rest. A
 * figure Amazon never sent stays null (never 0). ACoS and ROAS are on the headline sales, as Amazon's console shows SD.
 */
import prisma from '../../../db.js'
import { microsToCents } from '../../ads-core/metrics-math.js'
import type { SdEntityType } from './sd-reports.js'

/** Said once wherever SD figures are shown. */
export const SD_ATTRIBUTION_NOTE = 'Sponsored Display figures come from Amazon\'s SD reports: 14-day attribution, a purchase after a click or a view of the ad counts (afterClick / afterView split it). Amazon adds purchases to a day for 14 days, so the last 14 days may still grow.'

const SUM_FIELDS = [
  'impressions', 'viewableImpressions', 'clicks', 'costMicros',
  'sales14dCents', 'salesClicks14dCents', 'orders14d', 'ordersClicks14d', 'units14d', 'unitsClicks14d',
  'detailPageViews14d', 'detailPageViewsClicks14d',
  'ntbOrders14d', 'ntbOrdersClicks14d', 'ntbSalesCents14d', 'ntbSalesClicksCents14d', 'ntbUnits14d', 'ntbUnitsClicks14d',
] as const
type SumField = (typeof SUM_FIELDS)[number]
/** One entity's figures summed over a window (Prisma's `_sum`: null when no row of the window carried the figure). */
export type SdSums = { [K in SumField]?: (K extends 'costMicros' ? bigint : number) | null }

/** total − after a click, never below 0; null when either is unknown. */
const afterView = (total: number | null | undefined, clicks: number | null | undefined): number | null =>
  total == null || clicks == null ? null : Math.max(0, total - clicks)
const orNull = (v: number | null | undefined): number | null => (v == null ? null : v)

/** The read tools' metric block for one SD entity over a window; `null` sums mean no row in the window (unmeasured). */
export function sdMetricsOf(s: SdSums | null) {
  const spendCents = s ? microsToCents(s.costMicros) : 0
  const clicks = s?.clicks ?? 0
  const salesCents = s ? orNull(s.sales14dCents) : null
  return {
    measured: !!s,
    impressions: s?.impressions ?? 0,
    viewableImpressions: s ? orNull(s.viewableImpressions) : null,
    clicks,
    orders: s ? orNull(s.orders14d) : null,
    units: s ? orNull(s.units14d) : null,
    spendCents,
    salesCents,
    cpcCents: clicks > 0 ? Math.round(spendCents / clicks) : null,
    acos: salesCents != null && salesCents > 0 ? spendCents / salesCents : null,
    roas: salesCents != null && spendCents > 0 ? salesCents / spendCents : null,
    detailPageViews: s ? orNull(s.detailPageViews14d) : null,
    newToBrand: { orders: s ? orNull(s.ntbOrders14d) : null, units: s ? orNull(s.ntbUnits14d) : null, salesCents: s ? orNull(s.ntbSalesCents14d) : null },
    afterClick: {
      orders: s ? orNull(s.ordersClicks14d) : null,
      units: s ? orNull(s.unitsClicks14d) : null,
      salesCents: s ? orNull(s.salesClicks14dCents) : null,
      detailPageViews: s ? orNull(s.detailPageViewsClicks14d) : null,
      newToBrand: { orders: s ? orNull(s.ntbOrdersClicks14d) : null, units: s ? orNull(s.ntbUnitsClicks14d) : null, salesCents: s ? orNull(s.ntbSalesClicksCents14d) : null },
    },
    afterView: {
      orders: afterView(s?.orders14d, s?.ordersClicks14d),
      units: afterView(s?.units14d, s?.unitsClicks14d),
      salesCents: afterView(s?.sales14dCents, s?.salesClicks14dCents),
      detailPageViews: afterView(s?.detailPageViews14d, s?.detailPageViewsClicks14d),
      newToBrand: {
        orders: afterView(s?.ntbOrders14d, s?.ntbOrdersClicks14d),
        units: afterView(s?.ntbUnits14d, s?.ntbUnitsClicks14d),
        salesCents: afterView(s?.ntbSalesCents14d, s?.ntbSalesClicksCents14d),
      },
    },
  }
}

export type SdMetrics = ReturnType<typeof sdMetricsOf>

const SUM_SELECT = Object.fromEntries(SUM_FIELDS.map((f) => [f, true])) as Record<SumField, true>

/**
 * The SD figures of Nexus's own ad groups, targets or product ads (by their Nexus ids) over [since, until] (UTC days,
 * inclusive), and the newest day of data among them. An id with no row in the window is absent from the map.
 */
export async function sdMetricsByLocalId(entityType: SdEntityType, localIds: readonly string[], since: Date, until: Date): Promise<{ byId: Map<string, SdMetrics>; dataAsOf: string | null }> {
  const ids = [...new Set(localIds)]
  if (!ids.length) return { byId: new Map(), dataAsOf: null }
  const rows = await prisma.amazonAdsSdDailyPerformance.groupBy({
    by: ['localEntityId'],
    where: { entityType, localEntityId: { in: ids }, date: { gte: since, lte: until } },
    _sum: SUM_SELECT,
    _max: { date: true },
  })
  let newest: Date | null = null
  const byId = new Map<string, SdMetrics>()
  for (const r of rows) {
    if (!r.localEntityId) continue
    byId.set(r.localEntityId, sdMetricsOf(r._sum as SdSums))
    if (r._max.date && (!newest || r._max.date > newest)) newest = r._max.date
  }
  return { byId, dataAsOf: newest ? newest.toISOString().slice(0, 10) : null }
}

/** One advertised product → one other product bought, summed over the window. */
export interface SdPurchasedLine {
  /** Amazon's campaign and ad group ids. */
  campaignId: string
  adGroupId: string
  promotedAsin: string
  promotedSku: string | null
  purchasedAsin: string
  currencyCode: string
  /** After a click or a view (Amazon sends it for vcpm campaigns); null when Amazon sent none. */
  clickOrView: { orders: number | null; units: number | null; salesCents: number | null }
  afterClick: { orders: number | null; units: number | null; salesCents: number | null }
  afterView: { orders: number | null; units: number | null; salesCents: number | null }
}

/**
 * What shoppers bought after an SD ad over [since, until]: one line per campaign, ad group, advertised product and the
 * other product bought, narrowed to Amazon campaign ids (`campaignIds`), one Amazon ad group, or an ASIN (advertised or
 * bought). With the newest day of data among them.
 */
export async function sdPurchasedProducts(filter: {
  since: Date
  until: Date
  campaignIds?: readonly string[]
  adGroupId?: string
  asin?: string
}): Promise<{ lines: SdPurchasedLine[]; dataAsOf: string | null }> {
  const rows = await prisma.amazonAdsSdPurchasedProduct.groupBy({
    by: ['campaignId', 'adGroupId', 'promotedAsin', 'promotedSku', 'purchasedAsin', 'currencyCode'],
    where: {
      date: { gte: filter.since, lte: filter.until },
      ...(filter.campaignIds ? { campaignId: { in: [...filter.campaignIds] } } : {}),
      ...(filter.adGroupId ? { adGroupId: filter.adGroupId } : {}),
      ...(filter.asin ? { OR: [{ promotedAsin: filter.asin }, { purchasedAsin: filter.asin }] } : {}),
    },
    _sum: { sales14dCents: true, salesClicks14dCents: true, orders14d: true, ordersClicks14d: true, units14d: true, unitsClicks14d: true },
    _max: { date: true },
  })
  let newest: Date | null = null
  const lines = rows.map((r) => {
    const s = r._sum
    if (r._max.date && (!newest || r._max.date > newest)) newest = r._max.date
    return {
      campaignId: r.campaignId, adGroupId: r.adGroupId, promotedAsin: r.promotedAsin, promotedSku: r.promotedSku,
      purchasedAsin: r.purchasedAsin, currencyCode: r.currencyCode,
      clickOrView: { orders: orNull(s.orders14d), units: orNull(s.units14d), salesCents: orNull(s.sales14dCents) },
      afterClick: { orders: orNull(s.ordersClicks14d), units: orNull(s.unitsClicks14d), salesCents: orNull(s.salesClicks14dCents) },
      afterView: { orders: afterView(s.orders14d, s.ordersClicks14d), units: afterView(s.units14d, s.unitsClicks14d), salesCents: afterView(s.sales14dCents, s.salesClicks14dCents) },
    }
  })
  return { lines, dataAsOf: newest ? (newest as Date).toISOString().slice(0, 10) : null }
}
