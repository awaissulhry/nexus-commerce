/**
 * Google Ads changes, G5 (2026-10-15) — the account's portfolio bid strategies and the campaigns that use them, read live
 * from Google: the "from" side of set-google-bid-strategy and remove-google-bid-strategy. One GAQL query per part, on the
 * account's change allowance (write-client.ts `liveRows`).
 *
 * Fields checked on 2026-10-15 in https://developers.google.com/google-ads/api/fields/v25/bidding_strategy (all selectable
 * and filterable): bidding_strategy.id, name, type, status, non_removed_campaign_count, effective_currency_code;
 * target_cpa.{target_cpa_micros, cpc_bid_ceiling_micros, cpc_bid_floor_micros}; target_roas.{target_roas,
 * cpc_bid_ceiling_micros, cpc_bid_floor_micros}; target_spend.cpc_bid_ceiling_micros; target_impression_share.{location,
 * location_fraction_micros, cpc_bid_ceiling_micros}; maximize_conversions.{target_cpa_micros, cpc_bid_ceiling_micros,
 * cpc_bid_floor_micros}; maximize_conversion_value.{target_roas, cpc_bid_ceiling_micros, cpc_bid_floor_micros}.
 * In https://developers.google.com/google-ads/api/fields/v25/campaign: campaign.bidding_strategy (RESOURCE_NAME,
 * filterable), campaign.status. A strategy's resource name: customers/{c}/biddingStrategies/{id}.
 */
import { centsOfMicros, gaqlId, idOf } from './live.js'
import { byGoogleId } from './live-keywords.js'
import { liveRows } from './write-client.js'
import type { GoogleAdsTarget } from './types.js'

type Json = Record<string, any>
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null)
const num = (value: unknown): number | null => (value === undefined || value === null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value))

/** The kinds of portfolio strategy Nexus makes and changes (Google's bidding scheme of each, in its REST name). */
export type StrategyScheme = 'TARGET_CPA' | 'TARGET_ROAS' | 'MAXIMIZE_CLICKS' | 'TARGET_IMPRESSION_SHARE' | 'MAXIMIZE_CONVERSIONS' | 'MAXIMIZE_CONVERSION_VALUE'
export const STRATEGY_SCHEMES: readonly StrategyScheme[] = ['TARGET_CPA', 'TARGET_ROAS', 'MAXIMIZE_CLICKS', 'TARGET_IMPRESSION_SHARE', 'MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE']
/** Google's BiddingStrategyType of each scheme (MAXIMIZE_CLICKS is TARGET_SPEND in Google's words). */
const SCHEME_TYPE: Record<StrategyScheme, string> = {
  TARGET_CPA: 'TARGET_CPA', TARGET_ROAS: 'TARGET_ROAS', MAXIMIZE_CLICKS: 'TARGET_SPEND', TARGET_IMPRESSION_SHARE: 'TARGET_IMPRESSION_SHARE',
  MAXIMIZE_CONVERSIONS: 'MAXIMIZE_CONVERSIONS', MAXIMIZE_CONVERSION_VALUE: 'MAXIMIZE_CONVERSION_VALUE',
}
/** The scheme's field on BiddingStrategy, in REST's camelCase and in an update mask's snake_case. */
export const SCHEME_FIELD: Record<StrategyScheme, { json: string; mask: string }> = {
  TARGET_CPA: { json: 'targetCpa', mask: 'target_cpa' },
  TARGET_ROAS: { json: 'targetRoas', mask: 'target_roas' },
  MAXIMIZE_CLICKS: { json: 'targetSpend', mask: 'target_spend' },
  TARGET_IMPRESSION_SHARE: { json: 'targetImpressionShare', mask: 'target_impression_share' },
  MAXIMIZE_CONVERSIONS: { json: 'maximizeConversions', mask: 'maximize_conversions' },
  MAXIMIZE_CONVERSION_VALUE: { json: 'maximizeConversionValue', mask: 'maximize_conversion_value' },
}

export type ImpressionShareLocation = 'ANYWHERE_ON_PAGE' | 'TOP_OF_PAGE' | 'ABSOLUTE_TOP_OF_PAGE'

/** A portfolio strategy's settings Nexus reads and writes (amounts in cents; impression share in percent). */
export interface StrategySettings {
  targetCpaCents: number | null
  targetRoas: number | null
  maxCpcCents: number | null
  minCpcCents: number | null
  location: ImpressionShareLocation | null
  impressionSharePercent: number | null
}

export interface LiveStrategy extends StrategySettings {
  strategyId: string
  name: string
  /** Google's BiddingStrategyType. */
  type: string | null
  /** The scheme Nexus knows it as, or null for a kind Nexus does not change (Enhanced CPC, …). */
  scheme: StrategyScheme | null
  campaignCount: number
  currency: string | null
}

export interface LiveStrategyCampaign { strategyId: string; campaignId: string; name: string; status: string | null }

const SCHEME_FIELDS = (field: string, parts: string[]) => parts.map((p) => `bidding_strategy.${field}.${p}`)
export const LIVE_STRATEGIES_QUERY = `SELECT ${[
  'bidding_strategy.id', 'bidding_strategy.name', 'bidding_strategy.type', 'bidding_strategy.status',
  'bidding_strategy.non_removed_campaign_count', 'bidding_strategy.effective_currency_code',
  ...SCHEME_FIELDS('target_cpa', ['target_cpa_micros', 'cpc_bid_ceiling_micros', 'cpc_bid_floor_micros']),
  ...SCHEME_FIELDS('target_roas', ['target_roas', 'cpc_bid_ceiling_micros', 'cpc_bid_floor_micros']),
  ...SCHEME_FIELDS('target_spend', ['cpc_bid_ceiling_micros']),
  ...SCHEME_FIELDS('target_impression_share', ['location', 'location_fraction_micros', 'cpc_bid_ceiling_micros']),
  ...SCHEME_FIELDS('maximize_conversions', ['target_cpa_micros', 'cpc_bid_ceiling_micros', 'cpc_bid_floor_micros']),
  ...SCHEME_FIELDS('maximize_conversion_value', ['target_roas', 'cpc_bid_ceiling_micros', 'cpc_bid_floor_micros']),
].join(', ')} FROM bidding_strategy WHERE bidding_strategy.status = 'ENABLED'`

/** The campaigns (not removed) that use the given strategies. */
export const liveStrategyCampaignsQuery = (customer: string, strategyIds: string[]): string =>
  'SELECT campaign.id, campaign.name, campaign.status, campaign.bidding_strategy FROM campaign ' +
  `WHERE campaign.bidding_strategy IN (${strategyIds.map((id) => `'${customer}/biddingStrategies/${gaqlId(id, 'The bid strategy')}'`).join(', ')}) ` +
  "AND campaign.status != 'REMOVED'"

const schemeOfType = (type: string | null): StrategyScheme | null =>
  (Object.entries(SCHEME_TYPE).find(([, t]) => t === type)?.[0] as StrategyScheme | undefined) ?? null

export function liveStrategyOf(row: Json): LiveStrategy {
  const s = row.biddingStrategy ?? {}
  const type = str(s.type)
  const scheme = schemeOfType(type)
  const part: Json = scheme ? s[SCHEME_FIELD[scheme].json] ?? {} : {}
  const location = str(part.location)
  const fraction = num(part.locationFractionMicros)
  return {
    strategyId: str(s.id) ?? '',
    name: str(s.name) ?? '',
    type,
    scheme,
    campaignCount: num(s.nonRemovedCampaignCount) ?? 0,
    currency: str(s.effectiveCurrencyCode),
    targetCpaCents: centsOfMicros(part.targetCpaMicros),
    targetRoas: num(part.targetRoas),
    maxCpcCents: centsOfMicros(part.cpcBidCeilingMicros),
    minCpcCents: centsOfMicros(part.cpcBidFloorMicros),
    location: location === 'ANYWHERE_ON_PAGE' || location === 'TOP_OF_PAGE' || location === 'ABSOLUTE_TOP_OF_PAGE' ? location : null,
    impressionSharePercent: fraction === null ? null : fraction / 10_000,
  }
}

/** The account's portfolio bid strategies that are not removed. */
export async function liveStrategies(target: GoogleAdsTarget): Promise<LiveStrategy[]> {
  const rows = await liveRows<Json>(target, LIVE_STRATEGIES_QUERY, 'ads.search.live.bid-strategies')
  return rows.map(liveStrategyOf).sort((a, b) => byGoogleId(a.strategyId, b.strategyId))
}

/** The campaigns (not removed) that use the given strategies. */
export async function liveStrategyCampaigns(target: GoogleAdsTarget, customer: string, strategyIds: string[]): Promise<LiveStrategyCampaign[]> {
  if (!strategyIds.length) return []
  const rows = await liveRows<Json>(target, liveStrategyCampaignsQuery(customer, [...new Set(strategyIds)]), 'ads.search.live.bid-strategy-campaigns')
  return rows
    .map((r) => ({ strategyId: idOf(r.campaign?.biddingStrategy) ?? '', campaignId: str(r.campaign?.id) ?? '', name: str(r.campaign?.name) ?? '', status: str(r.campaign?.status) }))
    .sort((a, b) => byGoogleId(a.strategyId, b.strategyId) || byGoogleId(a.campaignId, b.campaignId))
}
