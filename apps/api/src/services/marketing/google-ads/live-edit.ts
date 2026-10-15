/**
 * Google Ads changes (2026-10-15, programme 2 group G3 "edit in place + URLs and tracking") — the live reads the edit
 * tools stand on that live.ts does not hold: responsive search ads by id with everything an edit can change, assets by id
 * with where each is linked (campaigns, ad groups, the account), the URL and tracking fields of campaigns, ad groups,
 * keywords and ads by id, one campaign's keywords with their URLs (a replaced or moved keyword keeps them), and the ad
 * rotation of a campaign's ad groups. One GAQL query each, on the account's change allowance (write-client.ts liveRows).
 *
 * Checked 2026-10-15 in Google's v25 field reference (curl of developers.google.com/google-ads/api/fields/v25/<resource>):
 * every field below is selectable, and filterable where it is in a WHERE (url_custom_parameters, rsa headlines and
 * descriptions are selectable, NOT filterable, and never filtered here).
 *   ad_group_ad         ad_group_ad.ad.id, .status, .ad.type, .ad.final_urls, .ad.final_mobile_urls, .ad.tracking_url_template,
 *                       .ad.final_url_suffix, .ad.url_custom_parameters, .ad.responsive_search_ad.headlines / descriptions /
 *                       path1 / path2; attributed resources ad_group, campaign.
 *   ad_group_criterion  criterion_id, status, negative, type, keyword.text, keyword.match_type, cpc_bid_micros,
 *                       effective_cpc_bid_micros, final_urls, final_mobile_urls, tracking_url_template, final_url_suffix,
 *                       url_custom_parameters; attributed resources ad_group, campaign.
 *   ad_group            id, name, status, type, tracking_url_template, final_url_suffix, url_custom_parameters,
 *                       ad_rotation_mode; attributed resource campaign.
 *   campaign            id, name, status, advertising_channel_type, tracking_url_template, final_url_suffix,
 *                       url_custom_parameters.
 *   asset               id, type, source (AssetSource ADVERTISER / AUTOMATICALLY_CREATED), name, final_urls,
 *                       final_mobile_urls, sitelink_asset.link_text / description1 / description2, callout_asset.callout_text,
 *                       structured_snippet_asset.header / values.
 *   campaign_asset, ad_group_asset, customer_asset  field_type, status; asset is an attributed resource of each;
 *                       campaign and ad_group are SEGMENTING resources of campaign_asset / ad_group_asset.
 * Every field a WHERE names is selected too, also a field of another resource (2026-10-15: Google refused a filter on a
 * segmenting resource's field that was not selected; live.ts liveAssetsQuery).
 */
import { liveRows } from './write-client.js'
import { centsOfMicros, gaqlId, type MatchType } from './live.js'
import { byGoogleId } from './live-keywords.js'
import { pairOf } from './live-campaigns.js'
import type { GoogleAdsTarget } from './types.js'

type Json = Record<string, any>
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null)
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String).filter((s) => s !== '') : [])
const inList = (ids: string[], what: string) => [...new Set(ids.map((id) => gaqlId(id, what)))].join(', ')
/** A max CPC of its own: absent or 0 = none (it uses its ad group's default). */
const ownBid = (micros: unknown): number | null => {
  const cents = centsOfMicros(micros)
  return cents && cents > 0 ? cents : null
}

/** At most this many items are read by id at once (a change names at most 100). */
export const MAX_EDIT_IDS = 100
function bounded(ids: string[], what: string): string[] {
  const unique = [...new Set(ids)]
  if (!unique.length || unique.length > MAX_EDIT_IDS) throw new Error(`Read 1 to ${MAX_EDIT_IDS} ${what} by id. Nothing was sent.`)
  return unique
}

// ── URL and tracking fields (campaign, ad group, keyword, ad, asset) ──────────────────────────────────────────────

export interface CustomParameter { key: string; value: string }
export interface LiveUrlFields {
  trackingTemplate: string | null
  finalUrlSuffix: string | null
  /** Sorted by key: Google's order is not kept, and two reads of the same parameters compare equal. */
  customParameters: CustomParameter[]
}

export function customParametersOf(value: unknown): CustomParameter[] {
  return (Array.isArray(value) ? value : [])
    .map((p: Json) => ({ key: str(p?.key) ?? '', value: typeof p?.value === 'string' ? p.value : '' }))
    .filter((p) => p.key !== '')
    .sort((a, b) => a.key.localeCompare(b.key))
}

export const urlFieldsOf = (x: Json | undefined): LiveUrlFields => ({
  trackingTemplate: str(x?.trackingUrlTemplate),
  finalUrlSuffix: str(x?.finalUrlSuffix),
  customParameters: customParametersOf(x?.urlCustomParameters),
})

// ── responsive search ads (and any ad) by id ───────────────────────────────────────────────────────────────────────

export interface LiveAdText { text: string; pin: string | null }
export interface LiveEditAd {
  /** `adGroupId~adId`, as set-google-status and remove-google-ads-items name an ad. */
  id: string
  adId: string
  adGroupId: string
  adGroupName: string
  adGroupStatus: string | null
  campaignId: string
  campaignName: string
  campaignStatus: string | null
  campaignType: string | null
  status: string | null
  type: string | null
  headlines: LiveAdText[]
  descriptions: LiveAdText[]
  path1: string | null
  path2: string | null
  finalUrls: string[]
  finalMobileUrls: string[]
  urls: LiveUrlFields
}

const AD_FIELDS = [
  'campaign.id', 'campaign.name', 'campaign.status', 'campaign.advertising_channel_type', 'ad_group.id', 'ad_group.name',
  'ad_group.status', 'ad_group_ad.status', 'ad_group_ad.ad.id', 'ad_group_ad.ad.type', 'ad_group_ad.ad.final_urls',
  'ad_group_ad.ad.final_mobile_urls', 'ad_group_ad.ad.tracking_url_template', 'ad_group_ad.ad.final_url_suffix',
  'ad_group_ad.ad.url_custom_parameters', 'ad_group_ad.ad.responsive_search_ad.headlines',
  'ad_group_ad.ad.responsive_search_ad.descriptions', 'ad_group_ad.ad.responsive_search_ad.path1',
  'ad_group_ad.ad.responsive_search_ad.path2',
]

/** Ads by `adGroupId~adId` (not removed); the query asks for every pair's ad group and ad, the rows are matched exactly. */
export function liveEditAdsQuery(ids: string[]): string {
  const pairs = bounded(ids, 'ads').map((id) => {
    const p = pairOf(id)
    if (!p) throw new Error(`The ad "${id}" is not adGroupId~adId. Nothing was sent.`)
    return p
  })
  return `SELECT ${AD_FIELDS.join(', ')} FROM ad_group_ad WHERE ad_group.id IN (${inList(pairs.map((p) => p[0]), 'The ad group')}) ` +
    `AND ad_group_ad.ad.id IN (${inList(pairs.map((p) => p[1]), 'The ad')}) AND ad_group_ad.status != 'REMOVED'`
}

/** The ads of ONE ad group (not removed): where moved ads land, and how many enabled ones it holds. */
export const liveAdGroupAdsQuery = (adGroupId: string): string =>
  `SELECT ${AD_FIELDS.join(', ')} FROM ad_group_ad WHERE ad_group.id = ${gaqlId(adGroupId, 'The ad group')} AND ad_group_ad.status != 'REMOVED'`

const adTexts = (value: unknown): LiveAdText[] => (Array.isArray(value) ? value : []).map((a: Json) => ({ text: str(a?.text) ?? '', pin: str(a?.pinnedField) }))

export function liveEditAdOf(row: Json): LiveEditAd {
  const c = row.campaign ?? {}
  const g = row.adGroup ?? {}
  const aga = row.adGroupAd ?? {}
  const ad = aga.ad ?? {}
  const rsa = ad.responsiveSearchAd ?? {}
  const adGroupId = str(g.id) ?? ''
  const adId = str(ad.id) ?? ''
  return {
    id: `${adGroupId}~${adId}`,
    adId,
    adGroupId,
    adGroupName: str(g.name) ?? '',
    adGroupStatus: str(g.status),
    campaignId: str(c.id) ?? '',
    campaignName: str(c.name) ?? '',
    campaignStatus: str(c.status),
    campaignType: str(c.advertisingChannelType),
    status: str(aga.status),
    type: str(ad.type),
    headlines: adTexts(rsa.headlines),
    descriptions: adTexts(rsa.descriptions),
    path1: str(rsa.path1),
    path2: str(rsa.path2),
    finalUrls: strings(ad.finalUrls),
    finalMobileUrls: strings(ad.finalMobileUrls),
    urls: urlFieldsOf(ad),
  }
}

export async function liveEditAds(target: GoogleAdsTarget, ids: string[]): Promise<LiveEditAd[]> {
  const wanted = new Set(ids)
  return (await liveRows<Json>(target, liveEditAdsQuery(ids), 'ads.search.live.edit-ads')).map(liveEditAdOf)
    .filter((a) => wanted.has(a.id)).sort((a, b) => byGoogleId(a.id, b.id))
}

export async function liveAdGroupAds(target: GoogleAdsTarget, adGroupId: string): Promise<LiveEditAd[]> {
  return (await liveRows<Json>(target, liveAdGroupAdsQuery(adGroupId), 'ads.search.live.edit-ads')).map(liveEditAdOf).sort((a, b) => byGoogleId(a.id, b.id))
}

// ── campaigns, ad groups, keywords by id: their URL and tracking fields ─────────────────────────────────────────────

export interface LiveCampaignUrls { campaignId: string; name: string; status: string | null; urls: LiveUrlFields }
export interface LiveAdGroupUrls { adGroupId: string; name: string; status: string | null; campaignId: string; campaignName: string; urls: LiveUrlFields }
export interface LiveKeywordUrls {
  /** `adGroupId~criterionId`. */
  id: string
  adGroupId: string
  criterionId: string
  adGroupName: string
  adGroupStatus: string | null
  campaignId: string
  campaignName: string
  campaignStatus: string | null
  text: string
  matchType: MatchType
  negative: boolean
  status: string | null
  cpcBidCents: number | null
  effectiveCpcBidCents: number | null
  finalUrls: string[]
  finalMobileUrls: string[]
  urls: LiveUrlFields
}

export const liveCampaignUrlsQuery = (campaignIds: string[]): string =>
  'SELECT campaign.id, campaign.name, campaign.status, campaign.tracking_url_template, campaign.final_url_suffix, ' +
  `campaign.url_custom_parameters FROM campaign WHERE campaign.id IN (${inList(bounded(campaignIds, 'campaigns'), 'The campaign')}) ` +
  "AND campaign.status != 'REMOVED'"

export const liveAdGroupUrlsQuery = (adGroupIds: string[]): string =>
  'SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group.status, ad_group.tracking_url_template, ' +
  `ad_group.final_url_suffix, ad_group.url_custom_parameters FROM ad_group WHERE ad_group.id IN (${inList(bounded(adGroupIds, 'ad groups'), 'The ad group')}) ` +
  "AND ad_group.status != 'REMOVED'"

const KEYWORD_FIELDS = [
  'campaign.id', 'campaign.name', 'campaign.status', 'ad_group.id', 'ad_group.name', 'ad_group.status',
  'ad_group_criterion.criterion_id', 'ad_group_criterion.type', 'ad_group_criterion.negative', 'ad_group_criterion.status',
  'ad_group_criterion.keyword.text', 'ad_group_criterion.keyword.match_type', 'ad_group_criterion.cpc_bid_micros',
  'ad_group_criterion.effective_cpc_bid_micros', 'ad_group_criterion.final_urls', 'ad_group_criterion.final_mobile_urls',
  'ad_group_criterion.tracking_url_template', 'ad_group_criterion.final_url_suffix', 'ad_group_criterion.url_custom_parameters',
]

/** Keywords by `adGroupId~criterionId` (not removed); the rows are matched to the pairs exactly. */
export function liveKeywordUrlsQuery(ids: string[]): string {
  const pairs = bounded(ids, 'keywords').map((id) => {
    const p = pairOf(id)
    if (!p) throw new Error(`The keyword "${id}" is not adGroupId~criterionId. Nothing was sent.`)
    return p
  })
  return `SELECT ${KEYWORD_FIELDS.join(', ')} FROM ad_group_criterion WHERE ad_group.id IN (${inList(pairs.map((p) => p[0]), 'The ad group')}) ` +
    `AND ad_group_criterion.criterion_id IN (${inList(pairs.map((p) => p[1]), 'The keyword')}) AND ad_group_criterion.type = 'KEYWORD' ` +
    "AND ad_group_criterion.status != 'REMOVED'"
}

/** One campaign's keywords and ad group negatives (not removed, in ad groups not removed), with their URLs. */
export const liveCampaignKeywordUrlsQuery = (campaignId: string): string =>
  `SELECT ${KEYWORD_FIELDS.join(', ')} FROM ad_group_criterion WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} ` +
  "AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED' AND ad_group.status != 'REMOVED'"

export function liveKeywordUrlsOf(row: Json): LiveKeywordUrls {
  const c = row.campaign ?? {}
  const g = row.adGroup ?? {}
  const a = row.adGroupCriterion ?? {}
  const adGroupId = str(g.id) ?? ''
  const criterionId = str(a.criterionId) ?? ''
  return {
    id: `${adGroupId}~${criterionId}`,
    adGroupId,
    criterionId,
    adGroupName: str(g.name) ?? '',
    adGroupStatus: str(g.status),
    campaignId: str(c.id) ?? '',
    campaignName: str(c.name) ?? '',
    campaignStatus: str(c.status),
    text: str(a.keyword?.text) ?? '',
    matchType: (str(a.keyword?.matchType) ?? 'BROAD') as MatchType,
    negative: a.negative === true,
    status: str(a.status),
    cpcBidCents: ownBid(a.cpcBidMicros),
    effectiveCpcBidCents: ownBid(a.effectiveCpcBidMicros),
    finalUrls: strings(a.finalUrls),
    finalMobileUrls: strings(a.finalMobileUrls),
    urls: urlFieldsOf(a),
  }
}

export async function liveCampaignUrls(target: GoogleAdsTarget, campaignIds: string[]): Promise<LiveCampaignUrls[]> {
  return (await liveRows<Json>(target, liveCampaignUrlsQuery(campaignIds), 'ads.search.live.urls')).map((r) => ({
    campaignId: str(r.campaign?.id) ?? '', name: str(r.campaign?.name) ?? '', status: str(r.campaign?.status), urls: urlFieldsOf(r.campaign),
  })).sort((a, b) => byGoogleId(a.campaignId, b.campaignId))
}

export async function liveAdGroupUrls(target: GoogleAdsTarget, adGroupIds: string[]): Promise<LiveAdGroupUrls[]> {
  return (await liveRows<Json>(target, liveAdGroupUrlsQuery(adGroupIds), 'ads.search.live.urls')).map((r) => ({
    adGroupId: str(r.adGroup?.id) ?? '', name: str(r.adGroup?.name) ?? '', status: str(r.adGroup?.status),
    campaignId: str(r.campaign?.id) ?? '', campaignName: str(r.campaign?.name) ?? '', urls: urlFieldsOf(r.adGroup),
  })).sort((a, b) => byGoogleId(a.adGroupId, b.adGroupId))
}

export async function liveKeywordUrls(target: GoogleAdsTarget, ids: string[]): Promise<LiveKeywordUrls[]> {
  const wanted = new Set(ids)
  return (await liveRows<Json>(target, liveKeywordUrlsQuery(ids), 'ads.search.live.urls')).map(liveKeywordUrlsOf)
    .filter((k) => wanted.has(k.id)).sort((a, b) => byGoogleId(a.id, b.id))
}

export async function liveCampaignKeywordUrls(target: GoogleAdsTarget, campaignId: string): Promise<LiveKeywordUrls[]> {
  return (await liveRows<Json>(target, liveCampaignKeywordUrlsQuery(campaignId), 'ads.search.live.keywords')).map(liveKeywordUrlsOf)
    .sort((a, b) => byGoogleId(a.id, b.id))
}

// ── assets by id, and where each is linked ──────────────────────────────────────────────────────────────────────

export interface LiveEditAsset {
  assetId: string
  type: string | null
  /** ADVERTISER, or AUTOMATICALLY_CREATED (Google made it: it cannot be changed). */
  source: string | null
  name: string | null
  finalUrls: string[]
  finalMobileUrls: string[]
  linkText?: string | null
  description1?: string | null
  description2?: string | null
  calloutText?: string | null
  header?: string | null
  values?: string[]
}

export const liveEditAssetsQuery = (assetIds: string[]): string =>
  'SELECT asset.id, asset.type, asset.source, asset.name, asset.final_urls, asset.final_mobile_urls, ' +
  'asset.sitelink_asset.link_text, asset.sitelink_asset.description1, asset.sitelink_asset.description2, ' +
  'asset.callout_asset.callout_text, asset.structured_snippet_asset.header, asset.structured_snippet_asset.values ' +
  `FROM asset WHERE asset.id IN (${inList(bounded(assetIds, 'assets'), 'The asset')})`

export function liveEditAssetOf(row: Json): LiveEditAsset {
  const a = row.asset ?? {}
  const out: LiveEditAsset = {
    assetId: str(a.id) ?? '',
    type: str(a.type),
    source: str(a.source),
    name: str(a.name),
    finalUrls: strings(a.finalUrls),
    finalMobileUrls: strings(a.finalMobileUrls),
  }
  if (a.sitelinkAsset) Object.assign(out, { linkText: str(a.sitelinkAsset.linkText), description1: str(a.sitelinkAsset.description1), description2: str(a.sitelinkAsset.description2) })
  if (a.calloutAsset) out.calloutText = str(a.calloutAsset.calloutText)
  if (a.structuredSnippetAsset) Object.assign(out, { header: str(a.structuredSnippetAsset.header), values: strings(a.structuredSnippetAsset.values) })
  return out
}

export interface LiveAssetLink {
  assetId: string
  level: 'campaign' | 'ad-group' | 'account'
  fieldType: string | null
  status: string | null
  campaignId?: string
  campaignName?: string
  campaignStatus?: string | null
  adGroupId?: string
  adGroupName?: string
}

export const liveAssetCampaignLinksQuery = (assetIds: string[]): string =>
  'SELECT asset.id, campaign.id, campaign.name, campaign.status, campaign_asset.field_type, campaign_asset.status FROM campaign_asset ' +
  `WHERE asset.id IN (${inList(bounded(assetIds, 'assets'), 'The asset')}) AND campaign_asset.status != 'REMOVED' AND campaign.status != 'REMOVED'`

export const liveAssetAdGroupLinksQuery = (assetIds: string[]): string =>
  'SELECT asset.id, campaign.id, campaign.name, campaign.status, ad_group.id, ad_group.name, ad_group.status, ad_group_asset.field_type, ' +
  `ad_group_asset.status FROM ad_group_asset WHERE asset.id IN (${inList(bounded(assetIds, 'assets'), 'The asset')}) ` +
  "AND ad_group_asset.status != 'REMOVED' AND ad_group.status != 'REMOVED'"

export const liveAssetAccountLinksQuery = (assetIds: string[]): string =>
  'SELECT asset.id, customer_asset.field_type, customer_asset.status FROM customer_asset ' +
  `WHERE asset.id IN (${inList(bounded(assetIds, 'assets'), 'The asset')}) AND customer_asset.status != 'REMOVED'`

/** The assets by id (one query). */
export async function liveAssetsForEdit(target: GoogleAdsTarget, assetIds: string[]): Promise<LiveEditAsset[]> {
  return (await liveRows<Json>(target, liveEditAssetsQuery(assetIds), 'ads.search.live.edit-assets')).map(liveEditAssetOf).sort((a, b) => byGoogleId(a.assetId, b.assetId))
}

/** The assets by id, and every place each is linked (campaigns, ad groups, the account). Four queries. */
export async function liveEditAssets(target: GoogleAdsTarget, assetIds: string[]): Promise<{ assets: LiveEditAsset[]; links: LiveAssetLink[] }> {
  const assets = await liveAssetsForEdit(target, assetIds)
  if (!assets.length) return { assets: [], links: [] }
  const ids = assets.map((a) => a.assetId)
  const links: LiveAssetLink[] = []
  for (const r of await liveRows<Json>(target, liveAssetCampaignLinksQuery(ids), 'ads.search.live.asset-links')) {
    links.push({ assetId: str(r.asset?.id) ?? '', level: 'campaign', fieldType: str(r.campaignAsset?.fieldType), status: str(r.campaignAsset?.status), campaignId: str(r.campaign?.id) ?? '', campaignName: str(r.campaign?.name) ?? '', campaignStatus: str(r.campaign?.status) })
  }
  for (const r of await liveRows<Json>(target, liveAssetAdGroupLinksQuery(ids), 'ads.search.live.asset-links')) {
    links.push({ assetId: str(r.asset?.id) ?? '', level: 'ad-group', fieldType: str(r.adGroupAsset?.fieldType), status: str(r.adGroupAsset?.status), campaignId: str(r.campaign?.id) ?? '', campaignName: str(r.campaign?.name) ?? '', campaignStatus: str(r.campaign?.status), adGroupId: str(r.adGroup?.id) ?? '', adGroupName: str(r.adGroup?.name) ?? '' })
  }
  for (const r of await liveRows<Json>(target, liveAssetAccountLinksQuery(ids), 'ads.search.live.asset-links')) {
    links.push({ assetId: str(r.asset?.id) ?? '', level: 'account', fieldType: str(r.customerAsset?.fieldType), status: str(r.customerAsset?.status) })
  }
  const order = (l: LiveAssetLink) => `${l.assetId}|${l.level}|${l.campaignId ?? ''}|${l.adGroupId ?? ''}|${l.fieldType ?? ''}`
  return { assets, links: links.sort((a, b) => order(a).localeCompare(order(b))) }
}

// ── ad rotation of one campaign's ad groups ───────────────────────────────────────────────────────────────────────

export const liveAdGroupRotationsQuery = (campaignId: string): string =>
  'SELECT campaign.id, ad_group.id, ad_group.status, ad_group.ad_rotation_mode FROM ad_group ' +
  `WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} AND ad_group.status != 'REMOVED'`

/** Each ad group's ad rotation (OPTIMIZE / ROTATE_FOREVER; null when Google leaves it out). */
export async function liveAdGroupRotations(target: GoogleAdsTarget, campaignId: string): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {}
  for (const r of await liveRows<Json>(target, liveAdGroupRotationsQuery(campaignId), 'ads.search.live.rotation')) {
    const id = str(r.adGroup?.id)
    if (id) out[id] = str(r.adGroup?.adRotationMode)
  }
  return out
}

