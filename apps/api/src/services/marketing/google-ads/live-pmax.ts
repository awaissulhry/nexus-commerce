/**
 * Google Ads Performance Max (programme 2, G10, 2026-10-16) — one Performance Max campaign as Google holds it NOW, read
 * live: its settings (budget, bidding, Merchant Center feed, brand guidelines, Google's automation switches), its campaign
 * criteria (locations, languages, schedule, brand exclusion lists, URL exclusions, negative keywords), its campaign-level
 * assets (the brand's business name and logos when brand guidelines are on), and every asset group with its assets,
 * its listing group filter tree (retail) and its signals (audiences, search themes). Also the account's audiences, brand
 * lists, the assets a request names, and the new-customer-acquisition goal and campaign configs. The "from" side of
 * build-google-pmax (a copy), set-google-pmax and set-google-customer-acquisition. One GAQL query per part, on the
 * account's change allowance (write-client.ts `liveRows`).
 *
 * Checked 2026-10-16 with curl in Google's v25 field reference (developers.google.com/google-ads/api/fields/v25/<resource>):
 *   asset_group           id, name, status, final_urls, final_mobile_urls, path1, path2, ad_strength, primary_status — all
 *                         selectable; status filterable. Attributed resources: campaign, customer.
 *   asset_group_asset     field_type, status, source (AssetSource) selectable and filterable; attributed: asset,
 *                         asset_group, campaign, customer (so asset.* and asset_group.status are selected with it).
 *   asset_group_listing_group_filter  id, type, listing_source, parent_listing_group_filter, case_value.product_brand.value,
 *                         product_category.category_id / level, product_channel.channel, product_condition.condition,
 *                         product_custom_attribute.index / value, product_item_id.value, product_type.level / value — all
 *                         selectable; attributed: asset_group, campaign, customer, shared_set. No status field: a removed
 *                         node is gone.
 *   asset_group_signal    resource_name, audience.audience, search_theme.text, approval_status — selectable; no status.
 *   audience              id, name, status, scope, asset_group — selectable and filterable.
 *   asset                 id, type, name, source, text_asset.text, image_asset.full_size.width_pixels / height_pixels,
 *                         image_asset.mime_type, youtube_video_asset.youtube_video_id, call_to_action_asset.call_to_action.
 *   campaign              brand_guidelines_enabled, brand_guidelines.main_color / accent_color / predefined_font_family,
 *                         asset_automation_settings (selectable, NOT filterable), shopping_setting.merchant_id / feed_label /
 *                         enable_local, maximize_conversions.target_cpa_micros, maximize_conversion_value.target_roas.
 *                         (v25 has no campaign.url_expansion_opt_out: final URL expansion is the asset automation type
 *                         FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION — performance-max/optimizations.)
 *   campaign_criterion    brand_list.shared_set, webpage.conditions (selectable, not filterable), webpage.criterion_name.
 *   goal                  goal_id, goal_type, new_customer_acquisition_goal_settings.value_settings.additional_value /
 *                         additional_high_lifetime_value. campaign_goal_config: campaign, goal, goal_type,
 *                         campaign_new_customer_acquisition_settings.target_option and value_settings_override.* — all
 *                         selectable and filterable (attributed: campaign, customer, goal).
 * Google's trap (found 2026-10-15): a field in a WHERE is also in the SELECT, every time.
 */
import { centsOfMicros, gaqlId, idOf } from './live.js'
import { liveExclusionSetsQuery } from './live-exclusions.js'
import type { GoogleAdsTarget } from './types.js'
import { liveRows } from './write-client.js'

type Json = Record<string, any>

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null)
const num = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : [])

// ── assets ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const PMAX_ASSET_FIELDS = [
  'asset.id', 'asset.type', 'asset.name', 'asset.source', 'asset.text_asset.text', 'asset.image_asset.full_size.width_pixels',
  'asset.image_asset.full_size.height_pixels', 'asset.image_asset.mime_type', 'asset.youtube_video_asset.youtube_video_id',
  'asset.call_to_action_asset.call_to_action',
].join(', ')

/** An asset as the Performance Max tools compare it: what it is and what it holds. */
export interface PmaxAsset {
  assetId: string
  type: string | null
  name: string | null
  text: string | null
  width: number | null
  height: number | null
  /** image/jpeg, image/png or image/gif (Google's MimeType IMAGE_JPEG …); null for another file type or no image. */
  mimeType: string | null
  youtubeId: string | null
  callToAction: string | null
}

const MIME: Record<string, string> = { IMAGE_JPEG: 'image/jpeg', IMAGE_PNG: 'image/png', IMAGE_GIF: 'image/gif' }

export function pmaxAssetOf(asset: Json | undefined): PmaxAsset {
  const a = asset ?? {}
  const full = a.imageAsset?.fullSize ?? {}
  return {
    assetId: str(a.id) ?? '',
    type: str(a.type),
    name: str(a.name),
    text: str(a.textAsset?.text),
    width: num(full.widthPixels),
    height: num(full.heightPixels),
    mimeType: a.imageAsset ? MIME[str(a.imageAsset.mimeType) ?? ''] ?? null : null,
    youtubeId: str(a.youtubeVideoAsset?.youtubeVideoId),
    callToAction: str(a.callToActionAsset?.callToAction),
  }
}

/** An asset linked to the campaign or to an asset group: as what, its link status, and who made the link. */
export interface PmaxLink extends PmaxAsset {
  fieldType: string
  status: string | null
  /** ADVERTISER, or AUTOMATICALLY_CREATED (Google made it: never counted, copied or compared). */
  source: string | null
}

const linkOf = (link: Json | undefined, asset: Json | undefined): PmaxLink => ({
  ...pmaxAssetOf(asset),
  fieldType: str(link?.fieldType) ?? '',
  status: str(link?.status),
  source: str(link?.source),
})

// ── one Performance Max campaign ────────────────────────────────────────────────────────────────────────────────

export interface PmaxFilterNode {
  id: string
  /** null for the root. */
  parentId: string | null
  /** SUBDIVISION, UNIT_INCLUDED or UNIT_EXCLUDED. */
  type: string | null
  /** SHOPPING (a retail tree), WEBPAGE (a page feed filter) … */
  listingSource: string | null
  /** Google's case value as it reads (`{ productBrand: { value } }`); null for the root. */
  caseValue: Json | null
  /** productBrand, productType:LEVEL1, productCustomAttribute:INDEX0, productCategory:LEVEL1, productCondition, … */
  dimension: string | null
  /** null for the root and for "everything else". */
  value: string | null
}

export interface PmaxSignal {
  /** `{assetGroupId}~{signalId}` (the resource name's last part). */
  signalId: string
  audienceId: string | null
  searchTheme: string | null
  approval: string | null
}

export interface PmaxAssetGroup {
  assetGroupId: string
  name: string
  status: string | null
  finalUrls: string[]
  finalMobileUrls: string[]
  path1: string | null
  path2: string | null
  adStrength: string | null
  primaryStatus: string | null
  assets: PmaxLink[]
  tree: PmaxFilterNode[]
  signals: PmaxSignal[]
}

export interface PmaxCriterion {
  criterionId: string
  type: string | null
  negative: boolean
  bidModifier: number | null
  location?: string | null
  language?: string | null
  brandListId?: string | null
  webpage?: { name: string | null; conditions: Array<{ operand: string | null; operator: string | null; argument: string | null }> }
  keyword?: { text: string; matchType: string | null }
  schedule?: { day: string | null; startHour: number; startMinute: string | null; endHour: number; endMinute: string | null }
}

export interface PmaxCampaignLive {
  campaignId: string
  name: string
  status: string | null
  type: string | null
  biddingType: string | null
  targetCpaCents: number | null
  targetRoas: number | null
  budget: { budgetId: string | null; amountCents: number | null; shared: boolean } | null
  start: string | null
  end: string | null
  /** The Merchant Center feed of a retail campaign; null for a campaign without one. */
  retail: { merchantId: string; feedLabel: string | null; localInventory: boolean } | null
  brandGuidelines: boolean
  brandStyle: { mainColor: string | null; accentColor: string | null; font: string | null } | null
  euPoliticalAds: string | null
  locationOption: string | null
  trackingTemplate: string | null
  finalUrlSuffix: string | null
  /** Google's automation switches as Google answered them (a type left out is at Google's default). */
  automation: Record<string, string>
  campaignAssets: PmaxLink[]
  criteria: PmaxCriterion[]
  assetGroups: PmaxAssetGroup[]
  /** Parts Google refused to read: a copy or a change would miss them. */
  notRead: Array<{ part: string; why: string }>
}

const SETTINGS = [
  'campaign.id', 'campaign.name', 'campaign.status', 'campaign.advertising_channel_type', 'campaign.bidding_strategy_type',
  'campaign.maximize_conversions.target_cpa_micros', 'campaign.maximize_conversion_value.target_roas',
  'campaign.start_date_time', 'campaign.end_date_time', 'campaign.shopping_setting.merchant_id',
  'campaign.shopping_setting.feed_label', 'campaign.shopping_setting.enable_local', 'campaign.brand_guidelines_enabled',
  'campaign.brand_guidelines.main_color', 'campaign.brand_guidelines.accent_color', 'campaign.brand_guidelines.predefined_font_family',
  'campaign.contains_eu_political_advertising', 'campaign.geo_target_type_setting.positive_geo_target_type',
  'campaign.tracking_url_template', 'campaign.final_url_suffix', 'campaign.asset_automation_settings',
  'campaign_budget.id', 'campaign_budget.amount_micros', 'campaign_budget.explicitly_shared',
]

export const pmaxSettingsQuery = (campaignId: string): string =>
  `SELECT ${SETTINGS.join(', ')} FROM campaign WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')}`

export const pmaxCriteriaQuery = (campaignId: string): string =>
  'SELECT campaign.id, campaign_criterion.criterion_id, campaign_criterion.type, campaign_criterion.negative, ' +
  'campaign_criterion.status, campaign_criterion.bid_modifier, campaign_criterion.location.geo_target_constant, ' +
  'campaign_criterion.language.language_constant, campaign_criterion.brand_list.shared_set, campaign_criterion.webpage.conditions, ' +
  'campaign_criterion.webpage.criterion_name, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type, ' +
  'campaign_criterion.ad_schedule.day_of_week, campaign_criterion.ad_schedule.start_hour, campaign_criterion.ad_schedule.start_minute, ' +
  'campaign_criterion.ad_schedule.end_hour, campaign_criterion.ad_schedule.end_minute FROM campaign_criterion ' +
  `WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} AND campaign_criterion.status != 'REMOVED'`

export const pmaxCampaignAssetsQuery = (campaignId: string): string =>
  'SELECT campaign.id, campaign_asset.field_type, campaign_asset.status, campaign_asset.source, ' + PMAX_ASSET_FIELDS + ' ' +
  `FROM campaign_asset WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} AND campaign_asset.status != 'REMOVED'`

export const pmaxAssetGroupsQuery = (campaignId: string): string =>
  'SELECT campaign.id, asset_group.id, asset_group.name, asset_group.status, asset_group.final_urls, asset_group.final_mobile_urls, ' +
  'asset_group.path1, asset_group.path2, asset_group.ad_strength, asset_group.primary_status FROM asset_group ' +
  `WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} AND asset_group.status != 'REMOVED'`

export const pmaxGroupAssetsQuery = (campaignId: string): string =>
  'SELECT campaign.id, asset_group.id, asset_group.status, asset_group_asset.field_type, asset_group_asset.status, ' +
  `asset_group_asset.source, ${PMAX_ASSET_FIELDS} FROM asset_group_asset WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} ` +
  "AND asset_group.status != 'REMOVED' AND asset_group_asset.status != 'REMOVED'"

const CASE = 'asset_group_listing_group_filter.case_value'
export const pmaxFiltersQuery = (campaignId: string): string =>
  'SELECT campaign.id, asset_group.id, asset_group.status, asset_group_listing_group_filter.id, asset_group_listing_group_filter.type, ' +
  'asset_group_listing_group_filter.listing_source, asset_group_listing_group_filter.parent_listing_group_filter, ' +
  `${CASE}.product_brand.value, ${CASE}.product_category.category_id, ${CASE}.product_category.level, ${CASE}.product_channel.channel, ` +
  `${CASE}.product_condition.condition, ${CASE}.product_custom_attribute.index, ${CASE}.product_custom_attribute.value, ` +
  `${CASE}.product_item_id.value, ${CASE}.product_type.level, ${CASE}.product_type.value FROM asset_group_listing_group_filter ` +
  `WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} AND asset_group.status != 'REMOVED'`

export const pmaxSignalsQuery = (campaignId: string): string =>
  'SELECT campaign.id, asset_group.id, asset_group.status, asset_group_signal.resource_name, asset_group_signal.audience.audience, ' +
  'asset_group_signal.search_theme.text, asset_group_signal.approval_status FROM asset_group_signal ' +
  `WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} AND asset_group.status != 'REMOVED'`

/** Where each listing dimension keeps its value (ListingGroupFilterDimension v25), and its level or index. */
const VALUE_FIELD: Record<string, string> = {
  productItemId: 'value', productBrand: 'value', productType: 'value', productCustomAttribute: 'value',
  productCondition: 'condition', productCategory: 'categoryId', productChannel: 'channel',
}
const UNSET = new Set(['UNSPECIFIED', 'UNKNOWN'])

export function pmaxFilterNodeOf(row: Json): PmaxFilterNode {
  const f = row.assetGroupListingGroupFilter ?? {}
  const cv: Json | null = f.caseValue && typeof f.caseValue === 'object' && Object.keys(f.caseValue).length ? f.caseValue : null
  let dimension: string | null = null
  let value: string | null = null
  if (cv) {
    const [key, inner] = Object.entries(cv)[0] as [string, Json | undefined]
    const field = VALUE_FIELD[key]
    const raw = inner && typeof inner === 'object' && field ? str(inner[field]) : null
    value = raw && !UNSET.has(raw) ? raw : null
    const part = inner && typeof inner === 'object' ? str(inner.level) ?? str(inner.index) : null
    dimension = part ? `${key}:${part}` : key
  }
  return {
    id: str(f.id) ?? '',
    parentId: idOf(f.parentListingGroupFilter)?.split('~')[1] ?? null,
    type: str(f.type),
    listingSource: str(f.listingSource),
    caseValue: cv,
    dimension,
    value,
  }
}

export function pmaxCriterionOf(row: Json): PmaxCriterion {
  const c = row.campaignCriterion ?? {}
  const out: PmaxCriterion = {
    criterionId: str(c.criterionId) ?? '',
    type: str(c.type),
    negative: c.negative === true,
    bidModifier: typeof c.bidModifier === 'number' ? c.bidModifier : null,
  }
  if (c.location) out.location = idOf(c.location.geoTargetConstant)
  if (c.language) out.language = idOf(c.language.languageConstant)
  if (c.brandList) out.brandListId = idOf(c.brandList.sharedSet)
  if (c.webpage) {
    out.webpage = {
      name: str(c.webpage.criterionName),
      conditions: (Array.isArray(c.webpage.conditions) ? c.webpage.conditions : []).map((w: Json) => ({ operand: str(w.operand), operator: str(w.operator), argument: str(w.argument) })),
    }
  }
  if (c.keyword) out.keyword = { text: str(c.keyword.text) ?? '', matchType: str(c.keyword.matchType) }
  if (c.adSchedule) {
    out.schedule = {
      day: str(c.adSchedule.dayOfWeek), startHour: Number(c.adSchedule.startHour ?? 0), startMinute: str(c.adSchedule.startMinute),
      endHour: Number(c.adSchedule.endHour ?? 0), endMinute: str(c.adSchedule.endMinute),
    }
  }
  return out
}

export function pmaxSettingsOf(row: Json): Omit<PmaxCampaignLive, 'campaignAssets' | 'criteria' | 'assetGroups' | 'notRead'> {
  const c = row.campaign ?? {}
  const b = row.campaignBudget
  const shopping = c.shoppingSetting
  const automation: Record<string, string> = {}
  for (const a of Array.isArray(c.assetAutomationSettings) ? c.assetAutomationSettings : []) {
    const type = str(a.assetAutomationType)
    const status = str(a.assetAutomationStatus)
    if (type && status) automation[type] = status
  }
  const style = c.brandGuidelines
  return {
    campaignId: str(c.id) ?? '',
    name: str(c.name) ?? '',
    status: str(c.status),
    type: str(c.advertisingChannelType),
    biddingType: str(c.biddingStrategyType),
    targetCpaCents: centsOfMicros(c.maximizeConversions?.targetCpaMicros),
    targetRoas: typeof c.maximizeConversionValue?.targetRoas === 'number' ? c.maximizeConversionValue.targetRoas : null,
    budget: b ? { budgetId: str(b.id), amountCents: centsOfMicros(b.amountMicros), shared: b.explicitlyShared === true } : null,
    start: str(c.startDateTime),
    end: str(c.endDateTime),
    retail: shopping && str(shopping.merchantId) ? { merchantId: str(shopping.merchantId)!, feedLabel: str(shopping.feedLabel), localInventory: shopping.enableLocal === true } : null,
    brandGuidelines: c.brandGuidelinesEnabled === true,
    brandStyle: style ? { mainColor: str(style.mainColor), accentColor: str(style.accentColor), font: str(style.predefinedFontFamily) } : null,
    euPoliticalAds: str(c.containsEuPoliticalAdvertising),
    locationOption: str(c.geoTargetTypeSetting?.positiveGeoTargetType),
    trackingTemplate: str(c.trackingUrlTemplate),
    finalUrlSuffix: str(c.finalUrlSuffix),
    automation,
  }
}

/**
 * One campaign with everything a Performance Max change, or a copy, stands on: seven queries. Null when the campaign is
 * not in the account (or it is removed). A part Google refuses to read is listed in `notRead` (the rest is answered).
 */
export async function livePmaxCampaign(target: GoogleAdsTarget, campaignId: string): Promise<PmaxCampaignLive | null> {
  const id = gaqlId(campaignId, 'The campaign')
  const settings = await liveRows<Json>(target, pmaxSettingsQuery(id), 'ads.search.live.pmax-campaign')
  const row = settings[0]
  if (!row || str(row.campaign?.status) === 'REMOVED') return null
  const base = pmaxSettingsOf(row)
  const notRead: PmaxCampaignLive['notRead'] = []
  if (base.type !== 'PERFORMANCE_MAX') return { ...base, campaignAssets: [], criteria: [], assetGroups: [], notRead }
  const part = async <T>(name: string, query: string, map: (r: Json) => T): Promise<T[]> => {
    try {
      return (await liveRows<Json>(target, query, `ads.search.live.pmax-${name}`)).map(map)
    } catch (err) {
      notRead.push({ part: name, why: err instanceof Error ? err.message : String(err) })
      return []
    }
  }
  const criteria = await part('criteria', pmaxCriteriaQuery(id), pmaxCriterionOf)
  const campaignAssets = await part('campaign-assets', pmaxCampaignAssetsQuery(id), (r) => linkOf(r.campaignAsset, r.asset))
  const groups = await part('asset-groups', pmaxAssetGroupsQuery(id), (r) => r.assetGroup ?? {})
  const groupAssets = await part('asset-group-assets', pmaxGroupAssetsQuery(id), (r) => ({ assetGroupId: str(r.assetGroup?.id) ?? '', link: linkOf(r.assetGroupAsset, r.asset) }))
  const filters = await part('listing-groups', pmaxFiltersQuery(id), (r) => ({ assetGroupId: str(r.assetGroup?.id) ?? '', node: pmaxFilterNodeOf(r) }))
  const signals = await part('signals', pmaxSignalsQuery(id), (r) => ({
    assetGroupId: str(r.assetGroup?.id) ?? '',
    signal: {
      signalId: idOf(r.assetGroupSignal?.resourceName) ?? '',
      audienceId: idOf(r.assetGroupSignal?.audience?.audience),
      searchTheme: str(r.assetGroupSignal?.searchTheme?.text),
      approval: str(r.assetGroupSignal?.approvalStatus),
    } satisfies PmaxSignal,
  }))
  const assetGroups: PmaxAssetGroup[] = groups.map((g) => {
    const groupId = str(g.id) ?? ''
    return {
      assetGroupId: groupId,
      name: str(g.name) ?? '',
      status: str(g.status),
      finalUrls: strings(g.finalUrls),
      finalMobileUrls: strings(g.finalMobileUrls),
      path1: str(g.path1),
      path2: str(g.path2),
      adStrength: str(g.adStrength),
      primaryStatus: str(g.primaryStatus),
      assets: groupAssets.filter((a) => a.assetGroupId === groupId).map((a) => a.link),
      tree: filters.filter((f) => f.assetGroupId === groupId).map((f) => f.node),
      signals: signals.filter((s) => s.assetGroupId === groupId).map((s) => s.signal),
    }
  })
  return { ...base, campaignAssets, criteria, assetGroups, notRead }
}

// ── the account's parts a request names ─────────────────────────────────────────────────────────────────────────

export const pmaxAssetsQuery = (assetIds: string[]): string =>
  `SELECT ${PMAX_ASSET_FIELDS} FROM asset WHERE asset.id IN (${assetIds.map((a) => gaqlId(a, 'The asset')).join(', ')})`

/** The assets of the account a request names by id (to check their type and shape before Google does). */
export async function livePmaxAssets(target: GoogleAdsTarget, assetIds: string[]): Promise<PmaxAsset[]> {
  const ids = [...new Set(assetIds)]
  if (!ids.length) return []
  return (await liveRows<Json>(target, pmaxAssetsQuery(ids), 'ads.search.live.pmax-assets')).map((r) => pmaxAssetOf(r.asset))
}

export const LIVE_AUDIENCES_QUERY = "SELECT audience.id, audience.name, audience.status, audience.scope, audience.asset_group FROM audience WHERE audience.status = 'ENABLED'"

export interface PmaxAudience { audienceId: string; name: string | null; scope: string | null; assetGroupId: string | null }

/** The account's audiences (Audience: the ones an audience signal of an asset group points at). */
export async function livePmaxAudiences(target: GoogleAdsTarget): Promise<PmaxAudience[]> {
  return (await liveRows<Json>(target, LIVE_AUDIENCES_QUERY, 'ads.search.live.audiences')).map((r) => ({
    audienceId: str(r.audience?.id) ?? '',
    name: str(r.audience?.name),
    scope: str(r.audience?.scope),
    assetGroupId: idOf(r.audience?.assetGroup),
  }))
}

/** The account's brand lists (shared sets of type BRANDS), for brand exclusions. */
export async function liveBrandLists(target: GoogleAdsTarget): Promise<Array<{ listId: string; name: string | null }>> {
  return (await liveRows<Json>(target, liveExclusionSetsQuery(['BRANDS']), 'ads.search.live.brand-lists'))
    .map((r) => ({ listId: str(r.sharedSet?.id) ?? '', name: str(r.sharedSet?.name) }))
}

// ── customer acquisition (Goal, CampaignGoalConfig) ─────────────────────────────────────────────────────────────

const VS = 'new_customer_acquisition_goal_settings.value_settings'
export const LIVE_ACQUISITION_GOAL_QUERY =
  `SELECT goal.resource_name, goal.goal_id, goal.goal_type, goal.optimization_eligibility, goal.${VS}.additional_value, ` +
  `goal.${VS}.additional_high_lifetime_value FROM goal WHERE goal.goal_type = 'NEW_CUSTOMER_ACQUISITION'`

const CNCA = 'campaign_goal_config.campaign_new_customer_acquisition_settings'
export const liveAcquisitionConfigQuery = (campaignId: string): string =>
  `SELECT campaign.id, campaign_goal_config.resource_name, campaign_goal_config.goal, campaign_goal_config.goal_type, ${CNCA}.target_option, ` +
  `${CNCA}.value_settings_override.additional_value, ${CNCA}.value_settings_override.additional_high_lifetime_value ` +
  `FROM campaign_goal_config WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} AND campaign_goal_config.goal_type = 'NEW_CUSTOMER_ACQUISITION'`

/** A value Google holds as a double of the account's currency, in cents (whole). */
const centsOfValue = (value: unknown): number | null => {
  const n = num(value)
  return n === null ? null : Math.round(n * 100)
}

export interface AcquisitionGoal { goalId: string; resourceName: string; eligibility: string | null; valueCents: number | null; highValueCents: number | null }
export interface AcquisitionConfig { resourceName: string; goalId: string | null; mode: string | null; valueCents: number | null; highValueCents: number | null }

/** The account's new-customer-acquisition goal (at most one per account: GoalService), and one campaign's config of it. */
export async function liveAcquisition(target: GoogleAdsTarget, campaignId?: string): Promise<{ goal: AcquisitionGoal | null; config: AcquisitionConfig | null }> {
  const goals = await liveRows<Json>(target, LIVE_ACQUISITION_GOAL_QUERY, 'ads.search.live.acquisition-goal')
  const g = goals[0]?.goal
  const goal: AcquisitionGoal | null = g ? {
    goalId: str(g.goalId) ?? idOf(g.resourceName) ?? '',
    resourceName: str(g.resourceName) ?? '',
    eligibility: str(g.optimizationEligibility),
    valueCents: centsOfValue(g.newCustomerAcquisitionGoalSettings?.valueSettings?.additionalValue),
    highValueCents: centsOfValue(g.newCustomerAcquisitionGoalSettings?.valueSettings?.additionalHighLifetimeValue),
  } : null
  if (!campaignId) return { goal, config: null }
  const rows = await liveRows<Json>(target, liveAcquisitionConfigQuery(campaignId), 'ads.search.live.acquisition-config')
  const c = rows[0]?.campaignGoalConfig
  const settings = c?.campaignNewCustomerAcquisitionSettings ?? {}
  const config: AcquisitionConfig | null = c ? {
    resourceName: str(c.resourceName) ?? '',
    goalId: idOf(c.goal),
    // Google leaves a field at its default out of the answer: no target option is TARGET_ALL (its documented default).
    mode: str(settings.targetOption) ?? 'TARGET_ALL',
    valueCents: centsOfValue(settings.valueSettingsOverride?.additionalValue),
    highValueCents: centsOfValue(settings.valueSettingsOverride?.additionalHighLifetimeValue),
  } : null
  return { goal, config }
}
