/**
 * ONE BRAIN AB-18 — a daily placement report as Amazon's v3 API returns it for `spCampaigns` grouped by
 * `campaignPlacement` (the columns of ads-reports.service.ts PLACEMENT_COLUMNS), for the off-Amazon lane's tests.
 *
 * The three on-Amazon labels are the ones Nexus already maps (ads-placement-math.ts REPORT_LABEL_TO_PLACEMENT). The
 * off-Amazon label "Off Amazon" is an ASSUMPTION: no Amazon type, doc or fixture in Nexus names the label Amazon gives
 * off-Amazon (creator) placements (brain/off-amazon.ts OFF_AMAZON_CAPABILITY: could not verify). It is the form the
 * Marketing Stream grain already maps (ams-grain.ts normalizeStreamPlacement). "Amazon Business on-Amazon" is an
 * on-Amazon placement Nexus does not manage: it is kept under its own name and never counted as off Amazon.
 *
 * Every value is made up (public repo): one campaign, round numbers.
 */

export const OFF_AMAZON_LABEL = 'Off Amazon'
export const BUSINESS_LABEL = 'Amazon Business on-Amazon'

export interface AmazonPlacementRow {
  date: string
  campaignId: number
  placementClassification: string
  impressions: number
  clicks: number
  cost: number
  sales7d: number
  purchases7d: number
  unitsSoldClicks7d: number
}

/** One day of one campaign: the three on-Amazon placements, the off-Amazon one and an Amazon Business row. */
export function placementDay(date: string, campaignId: number, off: { cost: number; sales: number; orders: number }): AmazonPlacementRow[] {
  const row = (placementClassification: string, clicks: number, cost: number, sales7d: number, purchases7d: number): AmazonPlacementRow => ({
    date, campaignId, placementClassification, impressions: clicks * 40, clicks, cost, sales7d, purchases7d, unitsSoldClicks7d: purchases7d,
  })
  return [
    row('Top of Search on-Amazon', 10, 4, 16, 2),
    row('Other on-Amazon', 5, 2, 8, 1),
    row('Detail Page on-Amazon', 5, 2, 0, 0),
    row(OFF_AMAZON_LABEL, 4, off.cost, off.sales, off.orders),
    row(BUSINESS_LABEL, 1, 0.5, 0, 0),
  ]
}
