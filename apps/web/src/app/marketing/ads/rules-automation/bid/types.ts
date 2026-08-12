/**
 * BID.S0 — the shape `GET /advertising/bid-grid` returns.
 *
 * Mirrors `apps/api/src/services/advertising/bid-grid.service.ts`. Kept as its own file rather than
 * inlined in the client so the slot contract can import it without importing the client, and so a
 * later section can widen a row type in one place.
 */

export type BidView = 'targets' | 'campaigns'
export type BidBand = '0-5' | '6-20' | '21-50' | '51-100' | '100+'

export const BID_BANDS: readonly BidBand[] = ['0-5', '6-20', '21-50', '51-100', '100+'] as const

/** Labels for the band chips. The bottom band is 0-5 because 5¢ is the floor three separate
 *  constants in the engine already assume — see the service header. */
export const BAND_LABEL: Record<BidBand, string> = {
  '0-5': '≤ €0.05',
  '6-20': '€0.06–0.20',
  '21-50': '€0.21–0.50',
  '51-100': '€0.51–1.00',
  '100+': '> €1.00',
}

export interface BidTargetRow {
  id: string
  text: string
  kind: string
  match: string
  bidCents: number
  band: BidBand
  status: string
  adGroupId: string
  adGroupName: string
  campaignId: string
  campaignName: string
  campaignStatus: string
  market: string
  /** target ENABLED **and** campaign ENABLED — an intersection, not a status */
  liveNow: boolean
  /** has at least one AmazonAdsDailyPerformance row in the window */
  measured: boolean
  impressions: number
  clicks: number
  spendCents: number
  salesCents: number
  orders: number
  /** null, never 0, when there were no clicks */
  cpcCents: number | null
  /** null, never 0, when there were no sales */
  acos: number | null
}

export interface BidCampaignRow {
  id: string
  name: string
  market: string
  status: string
  targets: number
  measured: number
  bidMinCents: number | null
  bidMaxCents: number | null
  impressions: number
  clicks: number
  spendCents: number
  salesCents: number
  orders: number
  cpcCents: number | null
  acos: number | null
}

export interface BidFacet { value: string; count: number }

export interface BidCursor {
  targetsAt: string | null
  loggedAt: string | null
  n: number
}

export interface BidGridPayload {
  scope: {
    market: string
    campaigns: number | null
    total: number
    applied: string[]
    notes: string[]
    contradiction: string | null
  }
  view: BidView
  window: { days: number; since: string }
  census: {
    targets: number
    campaigns: number
    liveNow: number
    liveCampaigns: number
    measured: number
    spendCents: number
  }
  facets: {
    kind: BidFacet[]
    match: BidFacet[]
    band: BidFacet[]
    measured: BidFacet[]
  }
  rows: BidTargetRow[] | BidCampaignRow[]
  total: number
  truncated: boolean
  cursor: BidCursor
  freshness: { newestTargetAt: string | null; newestBidLogAt: string | null; newestPerfDate: string | null }
}
