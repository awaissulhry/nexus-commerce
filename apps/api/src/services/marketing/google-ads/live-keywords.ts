/**
 * Google Ads changes (2026-10-15) — one campaign's ad groups, keywords and negative keywords, read live from Google: the
 * "from" side of set-google-ad-groups, set-google-keywords and set-google-negatives. One GAQL query per part, on the
 * account's change allowance (write-client.ts `liveRows`). The queries are live.ts's own (their fields were checked
 * against Google's v25 field reference with live.ts); this file only reads their rows.
 *
 * Rows come back in Google's order; every list here is sorted by id, so a change built from them (its operations, the
 * `plan` an approval stands on) does not depend on that order.
 *
 * A keyword without a max CPC of its own uses its ad group's default: Google leaves `cpc_bid_micros` out of the row (an
 * absent or zero bid reads as "none of its own" here) and `effective_cpc_bid_micros` holds the bid it uses.
 */
import { centsOfMicros, gaqlId, liveAdGroupsQuery, liveCampaignCriteriaQuery, liveCriterionOf, liveKeywordsQuery, type MatchType, INCLUDE_DRAFTS, noteCampaignRow } from './live.js'
import { liveRows } from './write-client.js'
import type { GoogleAdsTarget } from './types.js'

type Json = Record<string, any>

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null)
/** Google ids (digits, or `adGroupId~criterionId`) in number order. */
export function byGoogleId(a: string, b: string): number {
  const x = a.split('~')
  const y = b.split('~')
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? ''
    const q = y[i] ?? ''
    if (p.length !== q.length) return p.length - q.length
    if (p !== q) return p < q ? -1 : 1
  }
  return 0
}

/** A max CPC of its own: absent or 0 = none (it uses its ad group's default). */
const ownBid = (micros: unknown): number | null => {
  const cents = centsOfMicros(micros)
  return cents && cents > 0 ? cents : null
}

export interface LiveAdGroup {
  adGroupId: string
  name: string
  status: string | null
  /** SEARCH_STANDARD, SHOPPING_PRODUCT_ADS, … */
  type: string | null
  /** The ad group's default max CPC. */
  cpcBidCents: number | null
}

export interface LiveKeyword {
  adGroupId: string
  criterionId: string
  /** `adGroupId~criterionId`: how the change tools name a keyword (the end of its resource name). */
  keywordId: string
  text: string
  matchType: MatchType
  /** true = an ad group negative keyword. */
  negative: boolean
  status: string | null
  /** Its own max CPC; null = it uses its ad group's default. */
  cpcBidCents: number | null
  /** The max CPC Google uses for it (its own, or its ad group's). */
  effectiveCpcBidCents: number | null
}

export interface LiveCampaignNegative { criterionId: string; text: string; matchType: MatchType }

export function liveAdGroupOf(row: Json): LiveAdGroup {
  const g = row.adGroup ?? {}
  return { adGroupId: str(g.id) ?? '', name: str(g.name) ?? '', status: str(g.status), type: str(g.type), cpcBidCents: ownBid(g.cpcBidMicros) }
}

export function liveKeywordOf(row: Json): LiveKeyword {
  const a = row.adGroupCriterion ?? {}
  const adGroupId = str(row.adGroup?.id) ?? ''
  const criterionId = str(a.criterionId) ?? ''
  return {
    adGroupId,
    criterionId,
    keywordId: `${adGroupId}~${criterionId}`,
    text: str(a.keyword?.text) ?? '',
    matchType: (str(a.keyword?.matchType) ?? 'BROAD') as MatchType,
    negative: a.negative === true,
    status: str(a.status),
    cpcBidCents: ownBid(a.cpcBidMicros),
    effectiveCpcBidCents: ownBid(a.effectiveCpcBidMicros),
  }
}

/** The campaign's ad groups that are not removed. One query. */
export async function liveAdGroups(target: GoogleAdsTarget, campaignId: string): Promise<LiveAdGroup[]> {
  return (await liveRows<Json>(target, liveAdGroupsQuery(campaignId), 'ads.search.live.ad-groups')).map((r) => (noteCampaignRow(r), liveAdGroupOf(r))).sort((a, b) => byGoogleId(a.adGroupId, b.adGroupId))
}

/** The campaign's keywords and ad group negative keywords (not removed, in ad groups not removed). One query. */
export async function liveKeywords(target: GoogleAdsTarget, campaignId: string): Promise<LiveKeyword[]> {
  return (await liveRows<Json>(target, liveKeywordsQuery(campaignId), 'ads.search.live.keywords')).map((r) => (noteCampaignRow(r), liveKeywordOf(r))).sort((a, b) => byGoogleId(a.keywordId, b.keywordId))
}

/** The campaign's own negative keywords (campaign criteria; not its shared lists). One query. */
export async function liveCampaignNegatives(target: GoogleAdsTarget, campaignId: string): Promise<LiveCampaignNegative[]> {
  const rows = await liveRows<Json>(target, liveCampaignCriteriaQuery(campaignId), 'ads.search.live.criteria')
  return rows.map(liveCriterionOf)
    .filter((c) => c.type === 'KEYWORD' && c.negative && c.keyword)
    .map((c) => ({ criterionId: c.criterionId, text: c.keyword!.text, matchType: (c.keyword!.matchType ?? 'BROAD') as MatchType }))
    .sort((a, b) => byGoogleId(a.criterionId, b.criterionId))
}

/**
 * The campaign's keyword match type: BROAD makes every keyword of the campaign act as broad match, whatever its own match
 * type. Checked 2026-10-15 in Google's v25 field reference (fields/v25/campaign): `campaign.keyword_match_type`,
 * selectable, enum CampaignKeywordMatchType BROAD / UNKNOWN / UNSPECIFIED; v25 can no longer set it
 * (CampaignError.CANNOT_SET_CAMPAIGN_KEYWORD_MATCH_TYPE), but an older campaign may hold BROAD. One query.
 */
export const liveKeywordMatchTypeQuery = (campaignId: string): string =>
  `SELECT campaign.id, campaign.keyword_match_type FROM campaign WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')}${INCLUDE_DRAFTS}`

export async function liveCampaignKeywordMatchType(target: GoogleAdsTarget, campaignId: string): Promise<string | null> {
  const rows = await liveRows<Json>(target, liveKeywordMatchTypeQuery(campaignId), 'ads.search.live.match-type')
  return str(rows[0]?.campaign?.keywordMatchType)
}
