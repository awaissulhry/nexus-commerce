/**
 * Google Ads programme 2, G1 review (2026-10-15) — three more google-ads-live reads, read only:
 *   - a campaign's product groups with EVERY Shopping dimension (condition, category, channel, channel exclusivity as
 *     well as item id, brand, product type, custom label): the field list and the node mapper of live-product-groups.ts,
 *     for all ad groups of one campaign in one query (live.ts's own read knows four dimensions, so a node of another one
 *     read as "everything else");
 *   - portfolio bid strategies (bidding_strategy): type, targets, CPC ceilings and floors, how many campaigns use each;
 *   - Google's auto-apply settings (recommendation_subscription; the query is gaql.ts AUTO_APPLY_QUERY).
 *
 * Checked on 2026-10-15 against Google's v25 field reference (fields/v25/bidding_strategy, recommendation_subscription,
 * ad_group_criterion, curl): every field selected is Selectable, every WHERE field Filterable, and every field of another
 * resource filtered on is selected too (campaign.id and ad_group.status in the product groups read).
 * bidding_strategy.status is ENABLED | REMOVED; target_impression_share.location_fraction_micros is a fraction in
 * millionths (1,000,000 = 100%); every *_micros amount is micros of the strategy's currency (→ cents: / 10,000).
 */
import { liveRows } from './write-client.js'
import { gaqlId } from './live.js'
import { liveAdGroupProductGroupsQuery, productGroupNodeOf, type ProductGroupNode } from './live-product-groups.js'
import { AUTO_APPLY_QUERY } from './gaql.js'
import type { GoogleAdsTarget } from './types.js'

type Json = Record<string, any>

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null)
const opt = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
const centsOfMicros = (value: unknown): number | null => {
  const n = opt(value)
  return n === null ? null : Math.round(n / 10_000)
}

// ── product groups, every dimension ──────────────────────────────────────────────────────────────────────────────

/** live-product-groups.ts's field list (every Shopping dimension), for every ad group of one campaign. */
export function campaignProductGroupsQuery(campaignId: string): string {
  const id = gaqlId(campaignId, 'The campaign')
  const one = liveAdGroupProductGroupsQuery('0')
  return `${one.slice(0, one.indexOf(' FROM '))}, ad_group.name, ad_group.status, campaign.id FROM ad_group_criterion ` +
    `WHERE campaign.id = ${id} AND ad_group_criterion.type = 'LISTING_GROUP' AND ad_group_criterion.status != 'REMOVED' ` +
    "AND ad_group.status != 'REMOVED'"
}

export interface CampaignProductGroup extends ProductGroupNode {
  adGroupId: string
  adGroupName: string | null
  /** A node under a subdivision whose dimension has no value: every other product of that dimension. */
  everythingElse: boolean
}

export async function liveCampaignProductGroups(target: GoogleAdsTarget, campaignId: string): Promise<CampaignProductGroup[]> {
  const rows = await liveRows<Json>(target, campaignProductGroupsQuery(campaignId), 'ads.search.live.product-groups')
  return rows.map((row) => {
    const node = productGroupNodeOf(row)
    return { adGroupId: str(row.adGroup?.id) ?? '', adGroupName: str(row.adGroup?.name), ...node, everythingElse: node.caseValue !== null && node.value === null }
  })
}

// ── portfolio bid strategies ─────────────────────────────────────────────────────────────────────────────────────

export const BID_STRATEGIES_QUERY =
  'SELECT bidding_strategy.id, bidding_strategy.name, bidding_strategy.type, bidding_strategy.status, bidding_strategy.campaign_count, ' +
  'bidding_strategy.non_removed_campaign_count, bidding_strategy.currency_code, bidding_strategy.target_cpa.target_cpa_micros, ' +
  'bidding_strategy.target_cpa.cpc_bid_ceiling_micros, bidding_strategy.target_cpa.cpc_bid_floor_micros, ' +
  'bidding_strategy.target_roas.target_roas, bidding_strategy.target_roas.cpc_bid_ceiling_micros, ' +
  'bidding_strategy.target_roas.cpc_bid_floor_micros, bidding_strategy.target_spend.cpc_bid_ceiling_micros, ' +
  'bidding_strategy.maximize_conversions.target_cpa_micros, bidding_strategy.maximize_conversions.cpc_bid_ceiling_micros, ' +
  'bidding_strategy.maximize_conversions.cpc_bid_floor_micros, bidding_strategy.maximize_conversion_value.target_roas, ' +
  'bidding_strategy.maximize_conversion_value.cpc_bid_ceiling_micros, bidding_strategy.maximize_conversion_value.cpc_bid_floor_micros, ' +
  'bidding_strategy.target_impression_share.location, bidding_strategy.target_impression_share.location_fraction_micros, ' +
  "bidding_strategy.target_impression_share.cpc_bid_ceiling_micros FROM bidding_strategy WHERE bidding_strategy.status != 'REMOVED'"

export interface LiveBidStrategy {
  strategyId: string | null
  name: string | null
  /** TARGET_CPA, TARGET_ROAS, TARGET_SPEND (maximize clicks), MAXIMIZE_CONVERSIONS, MAXIMIZE_CONVERSION_VALUE, TARGET_IMPRESSION_SHARE, … */
  type: string | null
  status: string | null
  /** Campaigns that are not removed and use it. */
  campaigns: number | null
  currency: string | null
  targetCpaCents: number | null
  /** Conversion value / cost the strategy aims for (4 = 400%). */
  targetRoas: number | null
  maxCpcCeilingCents: number | null
  cpcFloorCents: number | null
  impressionShare: { location: string | null; targetPct: number | null } | null
}

export function bidStrategyOf(row: Json): LiveBidStrategy {
  const b = row.biddingStrategy ?? {}
  // Only the scheme of the strategy's type is set; the first one Google sent carries its targets.
  const scheme: Json = b.targetCpa ?? b.targetRoas ?? b.targetSpend ?? b.maximizeConversions ?? b.maximizeConversionValue ?? b.targetImpressionShare ?? {}
  const share = b.targetImpressionShare
  const fraction = opt(share?.locationFractionMicros)
  return {
    strategyId: str(b.id),
    name: str(b.name),
    type: str(b.type),
    status: str(b.status),
    campaigns: opt(b.nonRemovedCampaignCount ?? b.campaignCount),
    currency: str(b.currencyCode),
    targetCpaCents: centsOfMicros(scheme.targetCpaMicros),
    targetRoas: opt(scheme.targetRoas),
    maxCpcCeilingCents: centsOfMicros(scheme.cpcBidCeilingMicros),
    cpcFloorCents: centsOfMicros(scheme.cpcBidFloorMicros),
    impressionShare: share ? { location: str(share.location), targetPct: fraction === null ? null : Math.round(fraction / 100) / 100 } : null,
  }
}

export async function liveBidStrategies(target: GoogleAdsTarget): Promise<LiveBidStrategy[]> {
  return (await liveRows<Json>(target, BID_STRATEGIES_QUERY, 'ads.search.live.bid-strategies')).map(bidStrategyOf)
}

// ── auto-apply ───────────────────────────────────────────────────────────────────────────────────────────────────

export { AUTO_APPLY_QUERY }

export interface LiveAutoApply { type: string | null; status: string | null; createdAt: string | null; changedAt: string | null }

/** Which kinds of recommendation Google applies by itself (ENABLED), or no longer (PAUSED). */
export async function liveAutoApply(target: GoogleAdsTarget): Promise<LiveAutoApply[]> {
  const rows = await liveRows<Json>(target, AUTO_APPLY_QUERY, 'ads.search.live.auto-apply')
  return rows.map((row) => {
    const r = row.recommendationSubscription ?? {}
    return { type: str(r.type), status: str(r.status), createdAt: str(r.createDateTime), changedAt: str(r.modifyDateTime) }
  })
}
