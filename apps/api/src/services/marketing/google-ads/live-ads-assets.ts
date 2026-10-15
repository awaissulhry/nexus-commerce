/**
 * Google Ads changes (2026-10-15) — PR 5, the live reads the ads and assets changes stand on that live.ts does not hold:
 * one ad group with its campaign (where a responsive search ad goes, and whether it can serve), and assets of the account
 * by id (an asset a change links to a campaign again). One GAQL query each, on the account's change allowance.
 *
 * Checked 2026-10-15 in Google's v25 field reference (developers.google.com/google-ads/api/fields/v25/ad_group and
 * …/fields/v25/asset): ad_group.id, ad_group.name, ad_group.status and ad_group.type are selectable and filterable;
 * campaign is an attributed resource of ad_group, so campaign.* fields are selected and filtered with FROM ad_group;
 * asset.id (filterable), asset.type, asset.name, asset.final_urls, asset.sitelink_asset.link_text / description1 /
 * description2, asset.callout_asset.callout_text, asset.structured_snippet_asset.header / values are selectable.
 */
import { liveRows } from './write-client.js'
import { gaqlId, liveAssetOf, type LiveAsset } from './live.js'
import type { GoogleAdsTarget } from './types.js'

type Json = Record<string, any>
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null)

// ── one ad group with its campaign ───────────────────────────────────────────────────────────────────────────────

export const liveAdGroupPlaceQuery = (campaignId: string, adGroupId: string): string =>
  'SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, ad_group.id, ad_group.name, ' +
  `ad_group.status, ad_group.type FROM ad_group WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} ` +
  `AND ad_group.id = ${gaqlId(adGroupId, 'The ad group')} AND ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED'`

export interface LiveAdGroupPlace {
  campaign: { campaignId: string; name: string; status: string | null; type: string | null }
  adGroup: { adGroupId: string; name: string; status: string | null; type: string | null }
}

export function liveAdGroupPlaceOf(row: Json): LiveAdGroupPlace {
  const c = row.campaign ?? {}
  const g = row.adGroup ?? {}
  return {
    campaign: { campaignId: str(c.id) ?? '', name: str(c.name) ?? '', status: str(c.status), type: str(c.advertisingChannelType) },
    adGroup: { adGroupId: str(g.id) ?? '', name: str(g.name) ?? '', status: str(g.status), type: str(g.type) },
  }
}

/** The ad group with its campaign, or null when it is not in that campaign (or either is removed). */
export async function liveAdGroupPlace(target: GoogleAdsTarget, campaignId: string, adGroupId: string): Promise<LiveAdGroupPlace | null> {
  const rows = await liveRows<Json>(target, liveAdGroupPlaceQuery(campaignId, adGroupId), 'ads.search.live.ad-group')
  return rows[0] ? liveAdGroupPlaceOf(rows[0]) : null
}

// ── assets of the account, by id ─────────────────────────────────────────────────────────────────────────────────

/** At most this many assets are read by id at once (a change links at most 50). */
export const MAX_ASSETS_BY_ID = 50

export const liveAssetsByIdQuery = (assetIds: string[]): string => {
  const ids = [...new Set(assetIds.map((id) => gaqlId(id, 'The asset')))]
  if (!ids.length || ids.length > MAX_ASSETS_BY_ID) throw new Error(`Read 1 to ${MAX_ASSETS_BY_ID} assets by id. Nothing was sent.`)
  return 'SELECT asset.id, asset.type, asset.name, asset.final_urls, asset.sitelink_asset.link_text, asset.sitelink_asset.description1, ' +
    'asset.sitelink_asset.description2, asset.callout_asset.callout_text, asset.structured_snippet_asset.header, ' +
    `asset.structured_snippet_asset.values FROM asset WHERE asset.id IN (${ids.join(', ')})`
}

/** An asset of the account, linked or not (no campaign: the `campaignId`, link status and review are empty). */
export type LiveAccountAsset = Pick<LiveAsset, 'assetId' | 'type' | 'text' | 'description1' | 'description2' | 'header' | 'values' | 'finalUrls'>

export function liveAccountAssetOf(row: Json): LiveAccountAsset {
  const { assetId, type, text, description1, description2, header, values, finalUrls } = liveAssetOf(row)
  return {
    assetId, type, text, finalUrls,
    ...(description1 !== undefined ? { description1, description2 } : {}),
    ...(header !== undefined ? { header, values } : {}),
  }
}

export async function liveAssetsById(target: GoogleAdsTarget, assetIds: string[]): Promise<LiveAccountAsset[]> {
  return (await liveRows<Json>(target, liveAssetsByIdQuery(assetIds), 'ads.search.live.assets-by-id')).map(liveAccountAssetOf)
}
