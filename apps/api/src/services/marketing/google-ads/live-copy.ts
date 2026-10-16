/**
 * Google Ads, programme 2 G13 (2026-10-16) — the live reads a copy of a Search or Standard Shopping campaign needs beyond
 * live.ts's liveCampaignDetail, so copy-google-campaign carries everything the change tools set (build-copy.ts):
 * the campaign's devices, radius targets, audiences and demographics, and its ad groups' (G2's own reads); its
 * exclusions and brand lists (G7); its inventory filter (G4); the asset links of its ad groups (G6); and here, the labels
 * on it, its ad groups, keywords and ads (G5), its conversion goals and goal setting (G8a), the brand lists its ad groups
 * keep to, and the ad group criteria a copy does not carry (so the preview can name them). One GAQL query each, on the
 * account's change allowance (write-client.ts `liveRows`); a part Google refuses fails the copy (never a silent gap).
 *
 * Checked 2026-10-16 with curl in Google's v25 field reference (developers.google.com/google-ads/api/fields/v25/<resource>):
 *   campaign_label             attributed resources campaign, customer, label (campaign.id, label.id selectable and filterable)
 *   ad_group_label             attributed ad_group, campaign, customer, label
 *   ad_group_ad_label          attributed ad_group, ad_group_ad, campaign, customer, label (ad_group_ad.ad.id, ad_group_ad.status)
 *   ad_group_criterion_label   attributed ad_group, ad_group_criterion, campaign, customer, label
 *   campaign_conversion_goal   category, origin, biddable selectable and filterable; attributed campaign, customer
 *   conversion_goal_campaign_config  goal_config_level, custom_conversion_goal selectable and filterable; attributed campaign,
 *                              custom_conversion_goal, customer
 *   ad_group_criterion         criterion_id, type, negative, status, display_name, brand_list.shared_set selectable and
 *                              filterable; attributed ad_group, campaign, … (ad_group.status, campaign.id)
 * Every field of another resource named in a WHERE is selected too (the segmenting-resource trap, #639). The GAQL
 * grammar (docs/query/grammar) takes `NOT IN`.
 */
import { gaqlId, idOf } from './live.js'
import { byGoogleId } from './live-keywords.js'
import { liveAdGroupLinksQuery, livePlaceLinkOf, type LivePlaceLink } from './live-assets-all.js'
import { inventoryFilterOf, liveInventoryFilterQuery, type InventoryFilterLive } from './live-shopping.js'
import type { GoogleAdsTarget } from './types.js'
import { liveRows } from './write-client.js'

type Json = Record<string, any>
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null)

// ── labels on a campaign and its parts ───────────────────────────────────────────────────────────────────────────

export type CopyLabelKind = 'campaign' | 'ad-group' | 'ad' | 'keyword'
export const COPY_LABEL_KINDS: readonly CopyLabelKind[] = ['campaign', 'ad-group', 'ad', 'keyword']

/** The labels on one campaign's items of one kind (items not removed). */
export function liveCampaignLabelsQuery(campaignId: string, kind: CopyLabelKind): string {
  const id = gaqlId(campaignId, 'The campaign')
  switch (kind) {
    case 'campaign': return `SELECT campaign.id, label.id FROM campaign_label WHERE campaign.id = ${id}`
    case 'ad-group': return `SELECT campaign.id, ad_group.id, ad_group.status, label.id FROM ad_group_label WHERE campaign.id = ${id} AND ad_group.status != 'REMOVED'`
    case 'ad': return `SELECT campaign.id, ad_group.id, ad_group_ad.ad.id, ad_group_ad.status, label.id FROM ad_group_ad_label WHERE campaign.id = ${id} AND ad_group_ad.status != 'REMOVED'`
    case 'keyword': return 'SELECT campaign.id, ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.status, label.id FROM ad_group_criterion_label ' +
      `WHERE campaign.id = ${id} AND ad_group_criterion.status != 'REMOVED'`
  }
}

/** A label on an item: the campaign (its id), an ad group (its id), an ad (`adGroupId~adId`), a keyword (`adGroupId~criterionId`). */
export interface CopyLabel { kind: CopyLabelKind; id: string; labelId: string }

export function copyLabelOf(kind: CopyLabelKind, row: Json): CopyLabel {
  const labelId = str(row.label?.id) ?? ''
  switch (kind) {
    case 'campaign': return { kind, id: str(row.campaign?.id) ?? '', labelId }
    case 'ad-group': return { kind, id: str(row.adGroup?.id) ?? '', labelId }
    case 'ad': return { kind, id: `${str(row.adGroup?.id) ?? ''}~${str(row.adGroupAd?.ad?.id) ?? ''}`, labelId }
    case 'keyword': return { kind, id: `${str(row.adGroup?.id) ?? ''}~${str(row.adGroupCriterion?.criterionId) ?? ''}`, labelId }
  }
}

/** The labels on a campaign and its ad groups, ads and keywords (one query per kind asked), in a stable order. */
export async function liveCampaignLabels(target: GoogleAdsTarget, campaignId: string, kinds: readonly CopyLabelKind[] = COPY_LABEL_KINDS): Promise<CopyLabel[]> {
  const out: CopyLabel[] = []
  for (const kind of kinds) {
    out.push(...(await liveRows<Json>(target, liveCampaignLabelsQuery(campaignId, kind), 'ads.search.live.copy-labels')).map((r) => copyLabelOf(kind, r)))
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || byGoogleId(a.id, b.id) || byGoogleId(a.labelId, b.labelId))
}

// ── conversion goals of one campaign ───────────────────────────────────────────────────────────────────────────

export const liveCampaignGoalsQuery = (campaignId: string): string =>
  'SELECT campaign.id, campaign_conversion_goal.category, campaign_conversion_goal.origin, campaign_conversion_goal.biddable ' +
  `FROM campaign_conversion_goal WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')}`

export const liveCampaignGoalConfigQuery = (campaignId: string): string =>
  'SELECT campaign.id, conversion_goal_campaign_config.goal_config_level, conversion_goal_campaign_config.custom_conversion_goal ' +
  `FROM conversion_goal_campaign_config WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')}`

export interface CopyGoals {
  /** CAMPAIGN: the campaign has goals of its own; CUSTOMER (or null): it follows the account's goals. */
  level: string | null
  customGoalId: string | null
  /** Its goals, one per category and origin (read only when it has goals of its own). */
  goals: Array<{ category: string; origin: string; biddable: boolean }>
}

/** The campaign's goal setting and, when it has goals of its own, each goal (one or two queries). */
export async function liveCampaignGoals(target: GoogleAdsTarget, campaignId: string): Promise<CopyGoals> {
  const config = (await liveRows<Json>(target, liveCampaignGoalConfigQuery(campaignId), 'ads.search.live.copy-goal-setting'))[0]?.conversionGoalCampaignConfig ?? {}
  const level = str(config.goalConfigLevel)
  const goals = level === 'CAMPAIGN'
    ? (await liveRows<Json>(target, liveCampaignGoalsQuery(campaignId), 'ads.search.live.copy-goals')).map((r) => ({
      category: str(r.campaignConversionGoal?.category) ?? '', origin: str(r.campaignConversionGoal?.origin) ?? '', biddable: r.campaignConversionGoal?.biddable === true,
    })).filter((g) => g.category && g.origin).sort((a, b) => `${a.category}~${a.origin}`.localeCompare(`${b.category}~${b.origin}`))
    : []
  return { level, customGoalId: idOf(config.customConversionGoal), goals }
}

// ── ad group criteria a copy reads apart ───────────────────────────────────────────────────────────────────────

/** Types the copy carries at an ad group (keywords and negatives, product groups, audiences, demographics, brand lists). */
export const COPIED_AD_GROUP_CRITERIA = [
  'KEYWORD', 'LISTING_GROUP', 'USER_LIST', 'USER_INTEREST', 'CUSTOM_AUDIENCE', 'COMBINED_AUDIENCE', 'LIFE_EVENT',
  'AGE_RANGE', 'GENDER', 'PARENTAL_STATUS', 'INCOME_RANGE', 'BRAND_LIST',
] as const

/** The brand lists one campaign's ad groups keep to (BRAND_LIST, an inclusion: Google takes no ad group exclusion). */
export const liveAdGroupBrandListsQuery = (campaignId: string): string =>
  'SELECT campaign.id, ad_group.id, ad_group.status, ad_group_criterion.criterion_id, ad_group_criterion.type, ad_group_criterion.negative, ' +
  'ad_group_criterion.status, ad_group_criterion.brand_list.shared_set FROM ad_group_criterion ' +
  `WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} AND ad_group_criterion.type = 'BRAND_LIST' ` +
  "AND ad_group_criterion.status != 'REMOVED' AND ad_group.status != 'REMOVED'"

/** Every other criterion of one campaign's ad groups: what a copy does not carry, named in its preview. */
export const liveAdGroupOtherCriteriaQuery = (campaignId: string): string =>
  'SELECT campaign.id, ad_group.id, ad_group.status, ad_group_criterion.criterion_id, ad_group_criterion.type, ad_group_criterion.negative, ' +
  `ad_group_criterion.status, ad_group_criterion.display_name FROM ad_group_criterion WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} ` +
  `AND ad_group_criterion.type NOT IN (${COPIED_AD_GROUP_CRITERIA.map((t) => `'${t}'`).join(', ')}) ` +
  "AND ad_group_criterion.status != 'REMOVED' AND ad_group.status != 'REMOVED'"

export interface CopyAdGroupCriterion { adGroupId: string; criterionId: string; type: string | null; negative: boolean; name: string | null; listId: string | null }

export function copyAdGroupCriterionOf(row: Json): CopyAdGroupCriterion {
  const c = row.adGroupCriterion ?? {}
  return {
    adGroupId: str(row.adGroup?.id) ?? '', criterionId: str(c.criterionId) ?? '', type: str(c.type), negative: c.negative === true,
    name: str(c.displayName), listId: idOf(c.brandList?.sharedSet),
  }
}

const byCriterion = (a: CopyAdGroupCriterion, b: CopyAdGroupCriterion) => byGoogleId(a.adGroupId, b.adGroupId) || byGoogleId(a.criterionId, b.criterionId)

export async function liveAdGroupBrandLists(target: GoogleAdsTarget, campaignId: string): Promise<CopyAdGroupCriterion[]> {
  return (await liveRows<Json>(target, liveAdGroupBrandListsQuery(campaignId), 'ads.search.live.copy-brand-lists')).map(copyAdGroupCriterionOf).sort(byCriterion)
}

export async function liveAdGroupOtherCriteria(target: GoogleAdsTarget, campaignId: string): Promise<CopyAdGroupCriterion[]> {
  return (await liveRows<Json>(target, liveAdGroupOtherCriteriaQuery(campaignId), 'ads.search.live.copy-other-criteria')).map(copyAdGroupCriterionOf).sort(byCriterion)
}

// ── the asset links of one campaign's ad groups, its inventory filter ─────────────────────────────────────────────

/** Every asset link of one campaign's ad groups (G6's query, live-assets-all.ts), with its source and status. */
export async function liveCampaignAdGroupLinks(target: GoogleAdsTarget, campaignId: string): Promise<LivePlaceLink[]> {
  return (await liveRows<Json>(target, liveAdGroupLinksQuery({ campaignId }), 'ads.search.live.asset-links')).map((r) => livePlaceLinkOf('ad-group', r))
}

/** A Shopping campaign's inventory filter (G4's query, live-shopping.ts): its LISTING_SCOPE criteria. */
export async function liveInventoryFilters(target: GoogleAdsTarget, campaignId: string): Promise<InventoryFilterLive[]> {
  return (await liveRows<Json>(target, liveInventoryFilterQuery(campaignId), 'ads.search.live.inventory-filter')).map(inventoryFilterOf)
}
