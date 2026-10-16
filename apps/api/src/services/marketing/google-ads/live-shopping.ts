/**
 * Google Ads Shopping (2026-10-15, G4) — one Standard Shopping campaign's Shopping settings and its inventory filter, read
 * live from Google: the "from" side of set-google-shopping-settings and set-google-inventory-filter.
 *
 * Checked 2026-10-15 in Google's v25 field reference (curl of developers.google.com/google-ads/api/fields/v25/campaign and
 * …/campaign_criterion): campaign.shopping_setting.merchant_id, feed_label, campaign_priority, enable_local and
 * ignore_brand_exclusion_in_shopping_ads are selectable; campaign_criterion.listing_scope.dimensions is selectable
 * (repeated ListingDimensionInfo; its sub-fields are not), campaign_criterion.type (LISTING_SCOPE is one of its values) and
 * campaign_criterion.status are filterable. The inventory filter of the Google Ads UI is the campaign's LISTING_SCOPE
 * criterion; "Only one listing scope is allowed per campaign" (developers.google.com/google-ads/api/samples/add-listing-scope).
 */
import { gaqlId, INCLUDE_DRAFTS, noteCampaignRow } from './live.js'
import { dimensionOfCase, type Dimension } from './product-tree.js'
import type { GoogleAdsTarget } from './types.js'
import { liveRows } from './write-client.js'

type Json = Record<string, any>

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null)

export interface ShoppingCampaignLive {
  campaignId: string
  name: string
  status: string | null
  type: string | null
  merchantId: string | null
  /** null = no feed label: the campaign uses every feed of the Merchant Center account. */
  feedLabel: string | null
  localInventory: boolean
  ignoreBrandExclusions: boolean
}

/** One condition of an inventory filter: a dimension and its value (dimension null: one Nexus does not know). */
export interface ScopeCondition { dimension: Dimension | null; raw: string | null; value: string | null }
export interface InventoryFilterLive { criterionId: string; conditions: ScopeCondition[] }

export interface ShoppingLiveState {
  /** null when the campaign is not in the account (or it is removed). */
  campaign: ShoppingCampaignLive | null
  /** The campaign's LISTING_SCOPE criteria (Google allows one). */
  filters: InventoryFilterLive[]
}

export const liveShoppingCampaignQuery = (campaignId: string): string =>
  'SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.shopping_setting.merchant_id, ' +
  'campaign.shopping_setting.feed_label, campaign.shopping_setting.campaign_priority, campaign.shopping_setting.enable_local, ' +
  'campaign.shopping_setting.ignore_brand_exclusion_in_shopping_ads, campaign.experiment_type FROM campaign ' +
  `WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')}${INCLUDE_DRAFTS}`

export const liveInventoryFilterQuery = (campaignId: string): string =>
  'SELECT campaign.id, campaign_criterion.criterion_id, campaign_criterion.listing_scope.dimensions FROM campaign_criterion ' +
  `WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} AND campaign_criterion.type = 'LISTING_SCOPE' ` +
  `AND campaign_criterion.status != 'REMOVED'${INCLUDE_DRAFTS}`

export function shoppingCampaignOf(row: Json): ShoppingCampaignLive {
  const c = row.campaign ?? {}
  const s = c.shoppingSetting ?? {}
  return {
    campaignId: str(c.id) ?? '',
    name: str(c.name) ?? '',
    status: str(c.status),
    type: str(c.advertisingChannelType),
    merchantId: str(s.merchantId),
    feedLabel: str(s.feedLabel),
    localInventory: s.enableLocal === true,
    ignoreBrandExclusions: s.ignoreBrandExclusionInShoppingAds === true,
  }
}

export function inventoryFilterOf(row: Json): InventoryFilterLive {
  const k = row.campaignCriterion ?? {}
  const dims = Array.isArray(k.listingScope?.dimensions) ? k.listingScope.dimensions : []
  return {
    criterionId: str(k.criterionId) ?? '',
    conditions: dims.map((d: unknown) => { const c = dimensionOfCase(d); return { dimension: c.dim, raw: c.raw, value: c.value } }),
  }
}

/** The campaign's Shopping settings and inventory filter: two queries on the account's change allowance. */
export async function liveShoppingState(target: GoogleAdsTarget, campaignId: string): Promise<ShoppingLiveState> {
  const rows = await liveRows<Json>(target, liveShoppingCampaignQuery(campaignId), 'ads.search.live.campaign')
  if (rows[0]) noteCampaignRow(rows[0])
  const campaign = rows[0] ? shoppingCampaignOf(rows[0]) : null
  if (!campaign || campaign.status === 'REMOVED') return { campaign: null, filters: [] }
  const scopes = await liveRows<Json>(target, liveInventoryFilterQuery(campaignId), 'ads.search.live.inventory-filter')
  return { campaign, filters: scopes.map(inventoryFilterOf) }
}
