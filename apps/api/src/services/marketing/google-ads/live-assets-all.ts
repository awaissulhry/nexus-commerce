/**
 * Google Ads changes (2026-10-15, programme 2 group G6 "every asset type, at every level") — the live reads that
 * add-google-assets and set-google-asset-links stand on, and google-ads-live view asset-links: the asset links of the
 * account (customer_asset), of campaigns (campaign_asset) and of ad groups (ad_group_asset), with every field of every
 * asset type Nexus makes; ad groups by id; assets by id; whether the account accepted Google's lead form terms; the
 * location asset sets. One GAQL query each, on the account's change allowance (write-client.ts liveRows), or inside
 * asLiveRead on the live tools' own allowance.
 *
 * Checked 2026-10-15 in Google's v25 field reference (curl of developers.google.com/google-ads/api/fields/v25/<resource>):
 *   asset           every asset.* field selected below is selectable (and "selectable with" customer_asset,
 *                   campaign_asset and ad_group_asset): id, type, name, source, final_urls, text_asset.text,
 *                   image_asset.file_size / mime_type / full_size.width_pixels / height_pixels / url,
 *                   sitelink_asset.*, callout_asset.callout_text, structured_snippet_asset.header / values,
 *                   call_asset.country_code / phone_number / call_conversion_reporting_state / call_conversion_action,
 *                   price_asset.type / price_qualifier / language_code / price_offerings (MESSAGE, repeated: selectable,
 *                   NOT filterable), promotion_asset.* (promotion_target, percent_off, money_amount_off.*,
 *                   promotion_code, orders_over_amount.*, occasion, discount_modifier, start/end and redemption dates,
 *                   language_code), lead_form_asset.business_name / headline / call_to_action_type,
 *                   mobile_app_asset.app_id / app_store / link_text, location_asset.place_id,
 *                   policy_summary.approval_status / review_status. asset.id is filterable.
 *   customer_asset  field_type, status, source, primary_status (filterable); attributed resources asset, customer;
 *                   segmenting ad_group and campaign (no query here filters on them).
 *   campaign_asset  field_type, status, source, primary_status; attributed asset, customer; SEGMENTING campaign.
 *   ad_group_asset  ad_group, asset, field_type, status, source, primary_status; attributed asset, customer;
 *                   SEGMENTING ad_group and campaign.
 *   asset_set       id, name, type, status (AssetSetStatus ENABLED / REMOVED), location_group_parent_asset_set_id —
 *                   selectable and filterable. campaign_asset_set: campaign, asset_set, status; attributed asset_set,
 *                   campaign, customer.
 *   customer        customer.customer_agreement_setting.accepted_lead_form_terms (BOOLEAN, selectable).
 * TRAP (found 2026-10-15, live.ts liveAssetsQuery): a WHERE on a field of a segmenting resource (campaign.status in a
 * campaign_asset query, ad_group.status in an ad_group_asset query) must also be in the SELECT — every such field is.
 */
import { liveRows } from './write-client.js'
import { centsOfMicros, gaqlId, idOf } from './live.js'
import { byGoogleId } from './live-keywords.js'
import type { GoogleAdsTarget } from './types.js'

type Json = Record<string, any>
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null)
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String).filter((s) => s !== '') : [])
const num = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** At most this many ids are read at once (a change names at most 100 items). */
export const MAX_LINK_IDS = 100
function inList(ids: string[], what: string): string {
  const unique = [...new Set(ids.map((id) => gaqlId(id, what)))]
  if (!unique.length || unique.length > MAX_LINK_IDS) throw new Error(`Read 1 to ${MAX_LINK_IDS} ${what.toLowerCase()}s by id. Nothing was sent.`)
  return unique.join(', ')
}
/** A field type as GAQL takes it: upper-case letters and _ only (the enum's own names), or a refusal before sending. */
function fieldTypeList(fieldTypes: string[]): string {
  const bad = fieldTypes.filter((f) => !/^[A-Z_]{2,40}$/.test(f))
  if (bad.length || !fieldTypes.length) throw new Error(`Field types ${bad.join(', ') || '(none)'} are not Google's names. Nothing was sent.`)
  return [...new Set(fieldTypes)].map((f) => `'${f}'`).join(', ')
}

// ── an asset, every type ─────────────────────────────────────────────────────────────────────────────────────────

const ASSET_FIELDS = [
  'asset.id', 'asset.type', 'asset.name', 'asset.source', 'asset.final_urls', 'asset.text_asset.text',
  'asset.image_asset.file_size', 'asset.image_asset.mime_type', 'asset.image_asset.full_size.width_pixels',
  'asset.image_asset.full_size.height_pixels', 'asset.image_asset.full_size.url',
  'asset.sitelink_asset.link_text', 'asset.sitelink_asset.description1', 'asset.sitelink_asset.description2',
  'asset.callout_asset.callout_text', 'asset.structured_snippet_asset.header', 'asset.structured_snippet_asset.values',
  'asset.call_asset.country_code', 'asset.call_asset.phone_number', 'asset.call_asset.call_conversion_reporting_state',
  'asset.call_asset.call_conversion_action',
  'asset.price_asset.type', 'asset.price_asset.price_qualifier', 'asset.price_asset.language_code', 'asset.price_asset.price_offerings',
  'asset.promotion_asset.promotion_target', 'asset.promotion_asset.percent_off', 'asset.promotion_asset.money_amount_off.amount_micros',
  'asset.promotion_asset.money_amount_off.currency_code', 'asset.promotion_asset.promotion_code',
  'asset.promotion_asset.orders_over_amount.amount_micros', 'asset.promotion_asset.orders_over_amount.currency_code',
  'asset.promotion_asset.occasion', 'asset.promotion_asset.discount_modifier', 'asset.promotion_asset.start_date',
  'asset.promotion_asset.end_date', 'asset.promotion_asset.redemption_start_date', 'asset.promotion_asset.redemption_end_date',
  'asset.promotion_asset.language_code',
  'asset.lead_form_asset.business_name', 'asset.lead_form_asset.headline', 'asset.lead_form_asset.call_to_action_type',
  'asset.mobile_app_asset.app_id', 'asset.mobile_app_asset.app_store', 'asset.mobile_app_asset.link_text',
  'asset.location_asset.place_id', 'asset.policy_summary.approval_status', 'asset.policy_summary.review_status',
].join(', ')

/** An asset of the account as a person reads it: what it is, what it says, and the fields of its type. */
export interface LiveAssetDetail {
  assetId: string
  type: string | null
  name: string | null
  /** ADVERTISER, or AUTOMATICALLY_CREATED (Google made it). */
  source: string | null
  /** What it reads as, in a line (a phone number, a callout's text, an image's size …). */
  label: string
  finalUrls: string[]
  approval: string | null
  review: string | null
  /** The fields of its type (an image's size and type, a call's number, a price's offerings, …). */
  details: Record<string, unknown>
}

/** A promotion's percent off as Google holds it (1,000,000 = 100%) → a percentage. */
const percentOf = (micros: unknown): number | null => {
  const n = num(micros)
  return n === null ? null : Math.round(n / 100) / 100
}
const moneyOf = (m: Json | undefined) => (m && (m.amountMicros !== undefined || m.currencyCode) ? { cents: centsOfMicros(m.amountMicros), currency: str(m.currencyCode) } : null)

export function liveAssetDetailOf(asset: Json | undefined): LiveAssetDetail {
  const a = asset ?? {}
  const type = str(a.type)
  let details: Record<string, unknown> = {}
  let label = str(a.name) ?? ''
  if (a.textAsset) { details = { text: str(a.textAsset.text) }; label = str(a.textAsset.text) ?? label }
  if (a.imageAsset) {
    const full = a.imageAsset.fullSize ?? {}
    details = { width: num(full.widthPixels), height: num(full.heightPixels), fileSize: num(a.imageAsset.fileSize), mimeType: str(a.imageAsset.mimeType), url: str(full.url) }
    label = `${str(a.name) ?? 'image'} (${num(full.widthPixels) ?? '?'}×${num(full.heightPixels) ?? '?'})`
  }
  if (a.sitelinkAsset) { details = { linkText: str(a.sitelinkAsset.linkText), description1: str(a.sitelinkAsset.description1), description2: str(a.sitelinkAsset.description2) }; label = str(a.sitelinkAsset.linkText) ?? label }
  if (a.calloutAsset) { details = { calloutText: str(a.calloutAsset.calloutText) }; label = str(a.calloutAsset.calloutText) ?? label }
  if (a.structuredSnippetAsset) {
    const values = strings(a.structuredSnippetAsset.values)
    details = { header: str(a.structuredSnippetAsset.header), values }
    label = `${str(a.structuredSnippetAsset.header) ?? ''}: ${values.join(', ')}`
  }
  if (a.callAsset) {
    details = {
      countryCode: str(a.callAsset.countryCode), phoneNumber: str(a.callAsset.phoneNumber),
      callConversion: str(a.callAsset.callConversionReportingState), conversionActionId: idOf(a.callAsset.callConversionAction),
    }
    label = `${str(a.callAsset.phoneNumber) ?? ''} (${str(a.callAsset.countryCode) ?? '?'})`
  }
  if (a.priceAsset) {
    const offerings = (Array.isArray(a.priceAsset.priceOfferings) ? a.priceAsset.priceOfferings : []).map((o: Json) => ({
      header: str(o.header), description: str(o.description), price: moneyOf(o.price), unit: str(o.unit), finalUrl: str(o.finalUrl),
    }))
    details = { priceType: str(a.priceAsset.type), qualifier: str(a.priceAsset.priceQualifier), languageCode: str(a.priceAsset.languageCode), offerings }
    label = `${str(a.priceAsset.type) ?? 'price'}: ${offerings.map((o: { header: string | null }) => o.header ?? '').join(', ')}`
  }
  if (a.promotionAsset) {
    const p = a.promotionAsset
    details = {
      target: str(p.promotionTarget), percentOff: percentOf(p.percentOff), amountOff: moneyOf(p.moneyAmountOff),
      promotionCode: str(p.promotionCode), ordersOver: moneyOf(p.ordersOverAmount), occasion: str(p.occasion),
      discountModifier: str(p.discountModifier), startDate: str(p.startDate), endDate: str(p.endDate),
      redemptionStartDate: str(p.redemptionStartDate), redemptionEndDate: str(p.redemptionEndDate), languageCode: str(p.languageCode),
    }
    const off = percentOf(p.percentOff)
    const amount = moneyOf(p.moneyAmountOff)
    label = `${str(p.promotionTarget) ?? ''}: ${off !== null ? `${off}% off` : amount ? `${amount.currency ?? ''} ${((amount.cents ?? 0) / 100).toFixed(2)} off` : ''}`
  }
  if (a.leadFormAsset) {
    details = { businessName: str(a.leadFormAsset.businessName), headline: str(a.leadFormAsset.headline), callToActionType: str(a.leadFormAsset.callToActionType) }
    label = str(a.leadFormAsset.headline) ?? label
  }
  if (a.mobileAppAsset) {
    details = { appId: str(a.mobileAppAsset.appId), appStore: str(a.mobileAppAsset.appStore), linkText: str(a.mobileAppAsset.linkText) }
    label = `${str(a.mobileAppAsset.linkText) ?? ''} (${str(a.mobileAppAsset.appStore) ?? '?'} ${str(a.mobileAppAsset.appId) ?? ''})`
  }
  if (a.locationAsset) { details = { placeId: str(a.locationAsset.placeId) }; label = str(a.name) ?? `location ${str(a.locationAsset.placeId) ?? ''}` }
  return {
    assetId: str(a.id) ?? '',
    type,
    name: str(a.name),
    source: str(a.source),
    label,
    finalUrls: strings(a.finalUrls),
    approval: str(a.policySummary?.approvalStatus),
    review: str(a.policySummary?.reviewStatus),
    details,
  }
}

// ── asset links at the three levels ──────────────────────────────────────────────────────────────────────────────

export type LinkLevel = 'account' | 'campaign' | 'ad-group'

/** One asset link: where (the account, a campaign or an ad group), as what (field type), its status, the asset. */
export interface LivePlaceLink {
  level: LinkLevel
  campaignId: string | null
  campaignName: string | null
  campaignStatus: string | null
  adGroupId: string | null
  adGroupName: string | null
  adGroupStatus: string | null
  assetId: string
  fieldType: string | null
  status: string | null
  /** ADVERTISER, or AUTOMATICALLY_CREATED (Google linked it). */
  source: string | null
  primaryStatus: string | null
  asset: LiveAssetDetail
}

export interface LinkFilter {
  /** Only links of these field types. */
  fieldTypes?: string[]
  /** Only links of these assets. */
  assetIds?: string[]
}

const filters = (filter: LinkFilter, link: string): string =>
  (filter.fieldTypes?.length ? ` AND ${link}.field_type IN (${fieldTypeList(filter.fieldTypes)})` : '')
  + (filter.assetIds?.length ? ` AND asset.id IN (${inList(filter.assetIds, 'The asset')})` : '')

export const liveAccountLinksQuery = (filter: LinkFilter = {}): string =>
  `SELECT customer_asset.field_type, customer_asset.status, customer_asset.source, customer_asset.primary_status, ${ASSET_FIELDS} ` +
  `FROM customer_asset WHERE customer_asset.status != 'REMOVED'${filters(filter, 'customer_asset')}`

/** Campaign links of the given campaigns (none given: every campaign that is not removed). */
export const liveCampaignLinksQuery = (campaignIds: string[] | null, filter: LinkFilter = {}): string =>
  'SELECT campaign.id, campaign.name, campaign.status, campaign_asset.field_type, campaign_asset.status, campaign_asset.source, ' +
  `campaign_asset.primary_status, ${ASSET_FIELDS} FROM campaign_asset WHERE campaign_asset.status != 'REMOVED' AND campaign.status != 'REMOVED'` +
  (campaignIds ? ` AND campaign.id IN (${inList(campaignIds, 'The campaign')})` : '') + filters(filter, 'campaign_asset')

/** Ad group links of the given ad groups, or of one campaign's ad groups, or (neither) of every ad group. */
export const liveAdGroupLinksQuery = (scope: { adGroupIds?: string[]; campaignId?: string }, filter: LinkFilter = {}): string =>
  'SELECT campaign.id, campaign.name, campaign.status, ad_group.id, ad_group.name, ad_group.status, ad_group_asset.field_type, ' +
  `ad_group_asset.status, ad_group_asset.source, ad_group_asset.primary_status, ${ASSET_FIELDS} FROM ad_group_asset ` +
  "WHERE ad_group_asset.status != 'REMOVED' AND ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED'" +
  (scope.adGroupIds?.length ? ` AND ad_group.id IN (${inList(scope.adGroupIds, 'The ad group')})` : '') +
  (scope.campaignId ? ` AND campaign.id = ${gaqlId(scope.campaignId, 'The campaign')}` : '') + filters(filter, 'ad_group_asset')

export function livePlaceLinkOf(level: LinkLevel, row: Json): LivePlaceLink {
  const link = (level === 'account' ? row.customerAsset : level === 'campaign' ? row.campaignAsset : row.adGroupAsset) ?? {}
  const asset = liveAssetDetailOf(row.asset)
  return {
    level,
    campaignId: level === 'account' ? null : str(row.campaign?.id),
    campaignName: level === 'account' ? null : str(row.campaign?.name),
    campaignStatus: level === 'account' ? null : str(row.campaign?.status),
    adGroupId: level === 'ad-group' ? str(row.adGroup?.id) : null,
    adGroupName: level === 'ad-group' ? str(row.adGroup?.name) : null,
    adGroupStatus: level === 'ad-group' ? str(row.adGroup?.status) : null,
    assetId: asset.assetId,
    fieldType: str(link.fieldType),
    status: str(link.status),
    source: str(link.source),
    primaryStatus: str(link.primaryStatus),
    asset,
  }
}

/** The key of a link: where it is and as what (`account~~~123~CALL`). */
export const placeLinkKey = (l: { level: LinkLevel; campaignId?: string | null; adGroupId?: string | null; assetId: string; fieldType: string | null }) =>
  `${l.level}~${l.level === 'campaign' ? l.campaignId ?? '' : ''}~${l.level === 'ad-group' ? l.adGroupId ?? '' : ''}~${l.assetId}~${l.fieldType ?? ''}`

const linkOrder = (a: LivePlaceLink, b: LivePlaceLink) =>
  a.level.localeCompare(b.level) || byGoogleId(a.campaignId ?? '', b.campaignId ?? '') || byGoogleId(a.adGroupId ?? '', b.adGroupId ?? '')
  || byGoogleId(a.assetId, b.assetId) || (a.fieldType ?? '').localeCompare(b.fieldType ?? '')

/** The places a change names, and the links there (of the field types or assets asked): one query per level asked. */
export async function livePlaceLinks(
  target: GoogleAdsTarget,
  places: { account: boolean; campaignIds: string[]; adGroupIds: string[] },
  filter: LinkFilter,
): Promise<LivePlaceLink[]> {
  const out: LivePlaceLink[] = []
  if (places.account) out.push(...(await liveRows<Json>(target, liveAccountLinksQuery(filter), 'ads.search.live.asset-links')).map((r) => livePlaceLinkOf('account', r)))
  if (places.campaignIds.length) out.push(...(await liveRows<Json>(target, liveCampaignLinksQuery(places.campaignIds, filter), 'ads.search.live.asset-links')).map((r) => livePlaceLinkOf('campaign', r)))
  if (places.adGroupIds.length) out.push(...(await liveRows<Json>(target, liveAdGroupLinksQuery({ adGroupIds: places.adGroupIds }, filter), 'ads.search.live.asset-links')).map((r) => livePlaceLinkOf('ad-group', r)))
  return out.sort(linkOrder)
}

// ── ad groups by id, assets by id, the lead form terms ──────────────────────────────────────────────────────────────

export interface LiveAdGroupRef {
  adGroupId: string
  name: string
  status: string | null
  campaignId: string
  campaignName: string
  campaignStatus: string | null
  campaignType: string | null
}

export const liveAdGroupsByIdQuery = (adGroupIds: string[]): string =>
  'SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, ad_group.id, ad_group.name, ad_group.status ' +
  `FROM ad_group WHERE ad_group.id IN (${inList(adGroupIds, 'The ad group')}) AND ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED'`

export async function liveAdGroupsById(target: GoogleAdsTarget, adGroupIds: string[]): Promise<LiveAdGroupRef[]> {
  if (!adGroupIds.length) return []
  return (await liveRows<Json>(target, liveAdGroupsByIdQuery(adGroupIds), 'ads.search.live.ad-groups')).map((r) => ({
    adGroupId: str(r.adGroup?.id) ?? '', name: str(r.adGroup?.name) ?? '', status: str(r.adGroup?.status),
    campaignId: str(r.campaign?.id) ?? '', campaignName: str(r.campaign?.name) ?? '', campaignStatus: str(r.campaign?.status),
    campaignType: str(r.campaign?.advertisingChannelType),
  })).sort((a, b) => byGoogleId(a.adGroupId, b.adGroupId))
}

export const liveAssetDetailsQuery = (assetIds: string[]): string =>
  `SELECT ${ASSET_FIELDS} FROM asset WHERE asset.id IN (${inList(assetIds, 'The asset')})`

export async function liveAssetDetails(target: GoogleAdsTarget, assetIds: string[]): Promise<LiveAssetDetail[]> {
  if (!assetIds.length) return []
  return (await liveRows<Json>(target, liveAssetDetailsQuery(assetIds), 'ads.search.live.assets-by-id')).map((r) => liveAssetDetailOf(r.asset))
    .sort((a, b) => byGoogleId(a.assetId, b.assetId))
}

/**
 * The account's own assets (source ADVERTISER; AssetSource v25: ADVERTISER / AUTOMATICALLY_CREATED; asset.type and
 * asset.source filterable, checked 2026-10-15) of these asset types (AssetType names: TEXT, CALL, PRICE, …).
 */
export const liveAccountAssetsQuery = (types: string[]): string =>
  `SELECT ${ASSET_FIELDS} FROM asset WHERE asset.type IN (${fieldTypeList(types)}) AND asset.source = 'ADVERTISER'`

/** add-google-assets: an asset linked nowhere whose content the account already has is not made again. */
export async function liveAccountAssets(target: GoogleAdsTarget, types: string[]): Promise<LiveAssetDetail[]> {
  if (!types.length) return []
  return (await liveRows<Json>(target, liveAccountAssetsQuery(types), 'ads.search.live.assets-by-type')).map((r) => liveAssetDetailOf(r.asset))
    .sort((a, b) => byGoogleId(a.assetId, b.assetId))
}

export const LIVE_LEAD_FORM_TERMS_QUERY = 'SELECT customer.customer_agreement_setting.accepted_lead_form_terms FROM customer'

/** Whether the account accepted Google's lead form terms (Google refuses a lead form until it has: LEAD_FORM_MISSING_AGREEMENT). */
export async function liveLeadFormTerms(target: GoogleAdsTarget): Promise<boolean> {
  const rows = await liveRows<Json>(target, LIVE_LEAD_FORM_TERMS_QUERY, 'ads.search.live.customer')
  return rows[0]?.customer?.customerAgreementSetting?.acceptedLeadFormTerms === true
}

// ── location asset sets (read only: see change-assets-all.ts for why Nexus does not make them) ─────────────────────

export const LOCATION_SET_TYPES = ['LOCATION_SYNC', 'BUSINESS_PROFILE_DYNAMIC_LOCATION_GROUP', 'CHAIN_DYNAMIC_LOCATION_GROUP', 'STATIC_LOCATION_GROUP'] as const

export const LIVE_LOCATION_SETS_QUERY =
  'SELECT asset_set.id, asset_set.name, asset_set.type, asset_set.status, asset_set.location_group_parent_asset_set_id, ' +
  `asset_set.location_set.location_ownership_type FROM asset_set WHERE asset_set.type IN (${LOCATION_SET_TYPES.map((t) => `'${t}'`).join(', ')}) ` +
  "AND asset_set.status = 'ENABLED'"

export const LIVE_LOCATION_SET_LINKS_QUERY =
  'SELECT campaign.id, campaign.name, asset_set.id, campaign_asset_set.status FROM campaign_asset_set ' +
  `WHERE asset_set.type IN (${LOCATION_SET_TYPES.map((t) => `'${t}'`).join(', ')}) AND campaign_asset_set.status = 'ENABLED'`

export interface LiveLocationSet {
  assetSetId: string
  name: string | null
  type: string | null
  parentAssetSetId: string | null
  ownership: string | null
  campaigns: Array<{ campaignId: string; name: string | null }>
}

export async function liveLocationSets(target: GoogleAdsTarget): Promise<LiveLocationSet[]> {
  const sets = await liveRows<Json>(target, LIVE_LOCATION_SETS_QUERY, 'ads.search.live.asset-sets')
  if (!sets.length) return []
  const links = await liveRows<Json>(target, LIVE_LOCATION_SET_LINKS_QUERY, 'ads.search.live.asset-sets')
  return sets.map((r) => {
    const s = r.assetSet ?? {}
    const id = str(s.id) ?? ''
    return {
      assetSetId: id,
      name: str(s.name),
      type: str(s.type),
      parentAssetSetId: str(s.locationGroupParentAssetSetId),
      ownership: str(s.locationSet?.locationOwnershipType),
      campaigns: links.filter((l) => str(l.assetSet?.id) === id).map((l) => ({ campaignId: str(l.campaign?.id) ?? '', name: str(l.campaign?.name) })),
    }
  }).sort((a, b) => byGoogleId(a.assetSetId, b.assetSetId))
}

// ── google-ads-live view asset-links ──────────────────────────────────────────────────────────────────────────────

/** At most this many links are shown per level (the rest are counted). */
export const MAX_VIEW_LINKS = 300

export interface LiveAssetLinksView {
  /** The account-level links (not `account`: every google-ads-live answer's `account` is the account it read). */
  accountLinks: LivePlaceLink[]
  campaigns: LivePlaceLink[]
  adGroups: LivePlaceLink[]
  locationSets: LiveLocationSet[]
  totals: { accountLinks: number; campaigns: number; adGroups: number }
  notRead: Array<{ part: string; why: string }>
}

/**
 * Every asset link of the account (account, campaigns, ad groups — of one campaign when campaignId), every type, with
 * its review; and the location asset sets. Four or five queries; a part Google refuses is listed in notRead.
 */
export async function liveAssetLinksView(target: GoogleAdsTarget, campaignId?: string): Promise<LiveAssetLinksView> {
  const notRead: LiveAssetLinksView['notRead'] = []
  const part = async <T>(name: string, read: () => Promise<T[]>): Promise<T[]> => {
    try { return await read() } catch (err) {
      notRead.push({ part: name, why: err instanceof Error ? err.message : String(err) })
      return []
    }
  }
  const account = await part('account', async () => (await liveRows<Json>(target, liveAccountLinksQuery(), 'ads.search.live.asset-links')).map((r) => livePlaceLinkOf('account', r)))
  const campaigns = await part('campaigns', async () => (await liveRows<Json>(target, liveCampaignLinksQuery(campaignId ? [campaignId] : null), 'ads.search.live.asset-links')).map((r) => livePlaceLinkOf('campaign', r)))
  const adGroups = await part('ad-groups', async () => (await liveRows<Json>(target, liveAdGroupLinksQuery({ campaignId }), 'ads.search.live.asset-links')).map((r) => livePlaceLinkOf('ad-group', r)))
  const locationSets = await part('location-sets', () => liveLocationSets(target))
  const cap = (links: LivePlaceLink[]) => links.sort(linkOrder).slice(0, MAX_VIEW_LINKS)
  return {
    accountLinks: cap(account), campaigns: cap(campaigns), adGroups: cap(adGroups), locationSets,
    totals: { accountLinks: account.length, campaigns: campaigns.length, adGroups: adGroups.length },
    notRead,
  }
}
