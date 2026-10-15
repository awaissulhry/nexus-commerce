/**
 * Google Ads changes (2026-10-15) — the product groups (listing groups) of ONE Standard Shopping ad group, read live from
 * Google: the ad group with its campaign, and every node of its tree with the case value as Google holds it (the same JSON
 * a create takes, so a unit can be made again exactly). The "from" side of set-google-product-groups.
 *
 * Why not live.ts's product-group read: it reads the item id, brand, product type and custom attribute only, so a node of
 * another dimension (condition, category, channel, …) reads as having no value — as "everything else". This read selects
 * every Shopping dimension, so "everything else" is exactly a node under a subdivision whose dimension has no value.
 *
 * Checked 2026-10-15 in Google's v25 field reference (developers.google.com/google-ads/api/fields/v25/ad_group_criterion,
 * curl): every ad_group_criterion.listing_group.* field below is selectable (case_value.product_condition.condition,
 * product_category.category_id / level, product_channel.channel, product_channel_exclusivity.channel_exclusivity,
 * product_item_id.value, product_brand.value, product_type.value / level, product_custom_attribute.value / index,
 * parent_ad_group_criterion, type), as are ad_group_criterion.negative and cpc_bid_micros. Shopping dimensions per
 * developers.google.com/google-ads/api/docs/shopping-ads/create-listing-groups ("Available dimensions").
 */
import { centsOfMicros, gaqlId, idOf } from './live.js'
import type { GoogleAdsTarget } from './types.js'
import { liveRows } from './write-client.js'

type Json = Record<string, any>

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null)

export interface ShoppingAdGroupLive {
  adGroupId: string
  name: string
  status: string | null
  /** SHOPPING_PRODUCT_ADS for a Standard Shopping ad group. */
  type: string | null
  campaign: { campaignId: string; name: string; status: string | null; type: string | null; bidding: string | null }
}

export interface ProductGroupNode {
  criterionId: string
  /** null for the root ("All products"). */
  parentId: string | null
  /** SUBDIVISION (split further) or UNIT (a leaf: a bid, or excluded). */
  kind: string | null
  /** Google's case value as it reads (`{ productItemId: { value } }`); null for the root, or when Google sent none. */
  caseValue: Json | null
  /** productItemId, productBrand, productType:LEVEL1, productCustomAttribute:INDEX0, productCondition, productCategory:LEVEL1, … */
  dimension: string | null
  /** The node's value; null for the root and for "everything else" (its dimension without a value). */
  value: string | null
  excluded: boolean
  bidCents: number | null
}

export interface ProductGroupLiveState {
  /** null when the ad group is not in the account (or it is removed). */
  adGroup: ShoppingAdGroupLive | null
  nodes: ProductGroupNode[]
}

export const liveShoppingAdGroupQuery = (adGroupId: string): string =>
  'SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type, campaign.id, campaign.name, campaign.status, ' +
  'campaign.advertising_channel_type, campaign.bidding_strategy_type FROM ad_group ' +
  `WHERE ad_group.id = ${gaqlId(adGroupId, 'The ad group')} AND ad_group.status != 'REMOVED'`

const CASE = 'ad_group_criterion.listing_group.case_value'
export const liveAdGroupProductGroupsQuery = (adGroupId: string): string =>
  'SELECT ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.negative, ad_group_criterion.cpc_bid_micros, ' +
  'ad_group_criterion.listing_group.type, ad_group_criterion.listing_group.parent_ad_group_criterion, ' +
  `${CASE}.product_item_id.value, ${CASE}.product_brand.value, ${CASE}.product_type.value, ${CASE}.product_type.level, ` +
  `${CASE}.product_custom_attribute.value, ${CASE}.product_custom_attribute.index, ${CASE}.product_condition.condition, ` +
  `${CASE}.product_category.category_id, ${CASE}.product_category.level, ${CASE}.product_channel.channel, ` +
  `${CASE}.product_channel_exclusivity.channel_exclusivity FROM ad_group_criterion ` +
  `WHERE ad_group.id = ${gaqlId(adGroupId, 'The ad group')} AND ad_group_criterion.type = 'LISTING_GROUP' ` +
  "AND ad_group_criterion.status != 'REMOVED'"

export function shoppingAdGroupOf(row: Json): ShoppingAdGroupLive {
  const g = row.adGroup ?? {}
  const c = row.campaign ?? {}
  return {
    adGroupId: str(g.id) ?? '',
    name: str(g.name) ?? '',
    status: str(g.status),
    type: str(g.type),
    campaign: { campaignId: str(c.id) ?? '', name: str(c.name) ?? '', status: str(c.status), type: str(c.advertisingChannelType), bidding: str(c.biddingStrategyType) },
  }
}

/** Where each Shopping dimension keeps its value, and its level or index (part of the dimension, not the value). */
const VALUE_FIELD: Record<string, string> = {
  productItemId: 'value', productBrand: 'value', productType: 'value', productCustomAttribute: 'value',
  productCondition: 'condition', productCategory: 'categoryId', productChannel: 'channel', productChannelExclusivity: 'channelExclusivity',
}
const UNSET = new Set(['UNSPECIFIED', 'UNKNOWN'])

export function productGroupNodeOf(row: Json): ProductGroupNode {
  const a = row.adGroupCriterion ?? {}
  const lg = a.listingGroup ?? {}
  const cv: Json | null = lg.caseValue && typeof lg.caseValue === 'object' && Object.keys(lg.caseValue).length ? lg.caseValue : null
  let dimension: string | null = null
  let value: string | null = null
  if (cv) {
    const [key, inner] = Object.entries(cv)[0] as [string, Json | undefined]
    const field = VALUE_FIELD[key]
    const raw = inner && typeof inner === 'object' ? str(field ? inner[field] : Object.values(inner).find((v) => typeof v === 'string')) : null
    value = raw && !UNSET.has(raw) ? raw : null
    const part = inner && typeof inner === 'object' ? str(inner.level) ?? str(inner.index) : null
    dimension = part ? `${key}:${part}` : key
  }
  return {
    criterionId: str(a.criterionId) ?? '',
    parentId: idOf(lg.parentAdGroupCriterion)?.split('~')[1] ?? null,
    kind: str(lg.type),
    caseValue: cv,
    dimension,
    value,
    excluded: a.negative === true,
    bidCents: centsOfMicros(a.cpcBidMicros),
  }
}

/** The ad group (with its campaign) and its product group tree: two queries on the account's change allowance. */
export async function liveProductGroupTree(target: GoogleAdsTarget, adGroupId: string): Promise<ProductGroupLiveState> {
  const groups = await liveRows<Json>(target, liveShoppingAdGroupQuery(adGroupId), 'ads.search.live.ad-group')
  if (!groups[0]) return { adGroup: null, nodes: [] }
  const rows = await liveRows<Json>(target, liveAdGroupProductGroupsQuery(adGroupId), 'ads.search.live.product-groups')
  return { adGroup: shoppingAdGroupOf(groups[0]), nodes: rows.map(productGroupNodeOf) }
}
