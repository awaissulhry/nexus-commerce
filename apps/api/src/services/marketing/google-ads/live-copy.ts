/**
 * Google Ads, programme 2 G13 (2026-10-16) — the live reads a copy of a Search or Standard Shopping campaign needs beyond
 * live.ts's liveCampaignDetail (whose ONE criteria read holds the campaign's devices, radius, audiences, demographics,
 * exclusions, brand lists and inventory filter), so copy-google-campaign carries everything the change tools set
 * (build-copy.ts): the asset links of its ad groups (G6's query), every product group tree of the campaign in one read,
 * the labels on it, its ad groups, keywords, ads and other criteria (G5), its conversion goals and goal setting (G8a),
 * and in one read the brand lists its ad groups keep to and the ad group criteria a copy does not carry (so the preview
 * can name them). One GAQL query each, on the account's change allowance (write-client.ts `liveRows`); a part Google
 * refuses fails the copy (never a silent gap).
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
import { PRODUCT_GROUP_NODE_FIELDS, productGroupNodeOf, type ProductGroupNode } from './live-product-groups.js'
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
    // Every kind of criterion (keywords, product groups, audiences …): ad_group_criterion.type says which.
    case 'keyword': return 'SELECT campaign.id, ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.type, ad_group_criterion.status, label.id FROM ad_group_criterion_label ' +
      `WHERE campaign.id = ${id} AND ad_group_criterion.status != 'REMOVED'`
  }
}

/**
 * A label on an item: the campaign (its id), an ad group (its id), an ad (`adGroupId~adId`), a criterion of an ad group
 * (`adGroupId~criterionId`, kind keyword, its `criterionType`: KEYWORD, LISTING_GROUP, USER_LIST …).
 */
export interface CopyLabel { kind: CopyLabelKind; id: string; labelId: string; criterionType?: string | null }

export function copyLabelOf(kind: CopyLabelKind, row: Json): CopyLabel {
  const labelId = str(row.label?.id) ?? ''
  switch (kind) {
    case 'campaign': return { kind, id: str(row.campaign?.id) ?? '', labelId }
    case 'ad-group': return { kind, id: str(row.adGroup?.id) ?? '', labelId }
    case 'ad': return { kind, id: `${str(row.adGroup?.id) ?? ''}~${str(row.adGroupAd?.ad?.id) ?? ''}`, labelId }
    case 'keyword': return { kind, id: `${str(row.adGroup?.id) ?? ''}~${str(row.adGroupCriterion?.criterionId) ?? ''}`, labelId, criterionType: str(row.adGroupCriterion?.type) }
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

/** Types the copy reads with the campaign's keywords, product groups and its ad groups' audiences and demographics. */
export const COPIED_AD_GROUP_CRITERIA = [
  'KEYWORD', 'LISTING_GROUP', 'USER_LIST', 'USER_INTEREST', 'CUSTOM_AUDIENCE', 'COMBINED_AUDIENCE', 'LIFE_EVENT',
  'AGE_RANGE', 'GENDER', 'PARENTAL_STATUS', 'INCOME_RANGE',
] as const

/**
 * Every other criterion of one campaign's ad groups, in ONE query: the brand lists they keep to (BRAND_LIST, an
 * inclusion — Google takes no ad group exclusion; a copy carries them) and what a copy does not carry (named in its preview).
 */
export const liveAdGroupOtherCriteriaQuery = (campaignId: string): string =>
  'SELECT campaign.id, ad_group.id, ad_group.status, ad_group_criterion.criterion_id, ad_group_criterion.type, ad_group_criterion.negative, ' +
  'ad_group_criterion.status, ad_group_criterion.display_name, ad_group_criterion.brand_list.shared_set FROM ad_group_criterion ' +
  `WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} AND ad_group_criterion.type NOT IN (${COPIED_AD_GROUP_CRITERIA.map((t) => `'${t}'`).join(', ')}) ` +
  "AND ad_group_criterion.status != 'REMOVED' AND ad_group.status != 'REMOVED'"

export interface CopyAdGroupCriterion { adGroupId: string; criterionId: string; type: string | null; negative: boolean; name: string | null; listId: string | null }

export function copyAdGroupCriterionOf(row: Json): CopyAdGroupCriterion {
  const c = row.adGroupCriterion ?? {}
  return {
    adGroupId: str(row.adGroup?.id) ?? '', criterionId: str(c.criterionId) ?? '', type: str(c.type), negative: c.negative === true,
    name: str(c.displayName), listId: idOf(c.brandList?.sharedSet),
  }
}

export async function liveAdGroupOtherCriteria(target: GoogleAdsTarget, campaignId: string): Promise<CopyAdGroupCriterion[]> {
  return (await liveRows<Json>(target, liveAdGroupOtherCriteriaQuery(campaignId), 'ads.search.live.copy-other-criteria')).map(copyAdGroupCriterionOf)
    .sort((a, b) => byGoogleId(a.adGroupId, b.adGroupId) || byGoogleId(a.criterionId, b.criterionId))
}

// ── the product group trees of one campaign, in one read ─────────────────────────────────────────────────────

/** Every product group node of one Shopping campaign's ad groups (every dimension: live-product-groups.ts's fields). */
export const liveCampaignProductGroupNodesQuery = (campaignId: string): string =>
  `SELECT campaign.id, ad_group.status, ${PRODUCT_GROUP_NODE_FIELDS} FROM ad_group_criterion ` +
  `WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} AND ad_group_criterion.type = 'LISTING_GROUP' ` +
  "AND ad_group_criterion.status != 'REMOVED' AND ad_group.status != 'REMOVED'"

/** Each ad group's tree nodes (one query for the whole campaign, not two per ad group). */
export async function liveCampaignProductGroupNodes(target: GoogleAdsTarget, campaignId: string): Promise<Map<string, ProductGroupNode[]>> {
  const out = new Map<string, ProductGroupNode[]>()
  for (const r of await liveRows<Json>(target, liveCampaignProductGroupNodesQuery(campaignId), 'ads.search.live.product-groups')) {
    const adGroupId = str(r.adGroup?.id) ?? ''
    out.set(adGroupId, [...(out.get(adGroupId) ?? []), productGroupNodeOf(r)])
  }
  return out
}

// ── the asset links of one campaign's ad groups ──────────────────────────────────────────────────────────────

/** Every asset link of one campaign's ad groups (G6's query, live-assets-all.ts), with its source and status. */
export async function liveCampaignAdGroupLinks(target: GoogleAdsTarget, campaignId: string): Promise<LivePlaceLink[]> {
  return (await liveRows<Json>(target, liveAdGroupLinksQuery({ campaignId }), 'ads.search.live.asset-links')).map((r) => livePlaceLinkOf('ad-group', r))
}
