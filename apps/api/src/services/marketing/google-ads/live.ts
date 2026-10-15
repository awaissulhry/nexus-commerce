/**
 * Google Ads changes (2026-10-15) — what a Google Ads account holds NOW, read live from Google (not from the daily read):
 * the "from" side of every change Nexus asks for, and what the google-ads-live tool shows. One GAQL query per part, on
 * the account's change allowance (write-client.ts `liveRows`).
 *
 * Every field below was checked on 2026-10-15 against Google's v25 field reference (developers.google.com/google-ads/api/fields/v25):
 * selectable, and filterable where it is in a WHERE. An update mask is snake_case, as Google's REST example writes it.
 * Amounts are minor units (cents) of the account's currency: Google's micros / 10,000. Ids are Google's (digits).
 */
import { liveRows } from './write-client.js'
import type { GoogleAdsTarget } from './types.js'

// ── shared helpers ───────────────────────────────────────────────────────────────────────────────────────────────

type Json = Record<string, any>

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null)
const bool = (value: unknown): boolean => value === true
/** Google's micros (an int64 string) → cents; null when absent. */
export const centsOfMicros = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n / 10_000) : null
}
/** Cents → Google's micros, as Google's JSON takes an int64 (a string). */
export const microsOfCents = (cents: number): string => String(Math.round(cents) * 10_000)
/** The last part of a resource name (`customers/1/campaigns/22` → `22`; `…/sharedCriteria/5~6` → `5~6`). */
export const idOf = (resourceName: unknown): string | null => {
  const s = str(resourceName)
  return s ? s.slice(s.lastIndexOf('/') + 1) : null
}
/** A Google id as GAQL takes it: digits only, or a refusal before anything is sent. */
export function gaqlId(value: unknown, what: string): string {
  const s = String(value ?? '').trim()
  if (!/^\d{1,20}$/.test(s)) throw new Error(`${what} "${s}" is not a Google id (digits only). Nothing was sent.`)
  return s
}
const DAY = /^\d{4}-\d{2}-\d{2}$/

// ── campaigns ────────────────────────────────────────────────────────────────────────────────────────────────────

const CAMPAIGN_FIELDS = [
  'campaign.id', 'campaign.name', 'campaign.status', 'campaign.serving_status', 'campaign.primary_status',
  'campaign.advertising_channel_type', 'campaign.advertising_channel_sub_type', 'campaign.bidding_strategy_type',
  'campaign.start_date_time', 'campaign.end_date_time', 'campaign.shopping_setting.merchant_id',
  'campaign.shopping_setting.feed_label', 'campaign.shopping_setting.campaign_priority', 'campaign_budget.id',
  'campaign_budget.name', 'campaign_budget.amount_micros', 'campaign_budget.explicitly_shared',
]

/** Every campaign that is not removed, with its budget. */
export const LIVE_CAMPAIGNS_QUERY = `SELECT ${CAMPAIGN_FIELDS.join(', ')} FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.name`

export interface LiveCampaign {
  campaignId: string
  name: string
  status: string | null
  servingStatus: string | null
  primaryStatus: string | null
  type: string | null
  subType: string | null
  bidding: string | null
  start: string | null
  end: string | null
  shopping: { merchantId: string | null; feedLabel: string | null; priority: 'LOW' | 'MEDIUM' | 'HIGH' | null } | null
  budget: { budgetId: string | null; name: string | null; amountCents: number | null; shared: boolean } | null
}

const PRIORITY: Record<number, 'LOW' | 'MEDIUM' | 'HIGH'> = { 0: 'LOW', 1: 'MEDIUM', 2: 'HIGH' }
/** Shopping priority: Google stores 0 / 1 / 2 (Low / Medium / High). */
export const priorityName = (value: unknown): 'LOW' | 'MEDIUM' | 'HIGH' | null => (value === undefined || value === null ? null : PRIORITY[Number(value)] ?? null)

export function liveCampaignOf(row: Json): LiveCampaign {
  const c = row.campaign ?? {}
  const b = row.campaignBudget
  const shopping = c.shoppingSetting
  return {
    campaignId: str(c.id) ?? '',
    name: str(c.name) ?? '',
    status: str(c.status),
    servingStatus: str(c.servingStatus),
    primaryStatus: str(c.primaryStatus),
    type: str(c.advertisingChannelType),
    subType: str(c.advertisingChannelSubType),
    bidding: str(c.biddingStrategyType),
    start: str(c.startDateTime),
    end: str(c.endDateTime),
    shopping: shopping
      // Google leaves a field at its default out of the answer: a priority missing from a Shopping campaign is 0 (Low).
      ? { merchantId: str(shopping.merchantId), feedLabel: str(shopping.feedLabel), priority: priorityName(shopping.campaignPriority ?? 0) }
      : null,
    budget: b ? { budgetId: str(b.id), name: str(b.name), amountCents: centsOfMicros(b.amountMicros), shared: bool(b.explicitlyShared) } : null,
  }
}

export async function liveCampaigns(target: GoogleAdsTarget): Promise<LiveCampaign[]> {
  return (await liveRows<Json>(target, LIVE_CAMPAIGNS_QUERY, 'ads.search.live.campaigns')).map(liveCampaignOf)
}

// ── budgets ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const LIVE_BUDGETS_QUERY =
  'SELECT campaign_budget.id, campaign_budget.name, campaign_budget.amount_micros, campaign_budget.explicitly_shared, ' +
  'campaign_budget.status, campaign_budget.reference_count, campaign_budget.delivery_method, campaign_budget.period ' +
  "FROM campaign_budget WHERE campaign_budget.status = 'ENABLED'"

export interface LiveBudget {
  budgetId: string
  name: string | null
  amountCents: number | null
  shared: boolean
  deliveryMethod: string | null
  period: string | null
  /** How many campaigns (not removed) use it, as Google counts them. */
  usedBy: number
  campaigns: Array<{ campaignId: string; name: string; status: string | null }>
}

/** The account's budgets (shared and own), each with the campaigns that use it. Two queries. */
export async function liveBudgets(target: GoogleAdsTarget, campaigns?: LiveCampaign[]): Promise<LiveBudget[]> {
  const rows = await liveRows<Json>(target, LIVE_BUDGETS_QUERY, 'ads.search.live.budgets')
  const all = campaigns ?? await liveCampaigns(target)
  return rows.map((row) => {
    const b = row.campaignBudget ?? {}
    const budgetId = str(b.id) ?? ''
    const users = all.filter((c) => c.budget?.budgetId === budgetId)
    return {
      budgetId,
      name: str(b.name),
      amountCents: centsOfMicros(b.amountMicros),
      shared: bool(b.explicitlyShared),
      deliveryMethod: str(b.deliveryMethod),
      period: str(b.period),
      usedBy: Number(b.referenceCount ?? users.length) || 0,
      campaigns: users.map((c) => ({ campaignId: c.campaignId, name: c.name, status: c.status })),
    }
  })
}

// ── negative keyword lists ──────────────────────────────────────────────────────────────────────────────────────

export const LIVE_LISTS_QUERY =
  'SELECT shared_set.id, shared_set.name, shared_set.type, shared_set.status, shared_set.member_count, ' +
  "shared_set.reference_count FROM shared_set WHERE shared_set.type = 'NEGATIVE_KEYWORDS' AND shared_set.status = 'ENABLED'"

export const liveListKeywordsQuery = (listId: string): string =>
  'SELECT shared_criterion.criterion_id, shared_criterion.keyword.text, shared_criterion.keyword.match_type, shared_set.id ' +
  `FROM shared_criterion WHERE shared_set.id = ${gaqlId(listId, 'The list')} AND shared_criterion.type = 'KEYWORD'`

export const LIVE_LIST_ATTACHMENTS_QUERY =
  'SELECT campaign.id, campaign.name, campaign.status, shared_set.id, campaign_shared_set.status FROM campaign_shared_set ' +
  "WHERE shared_set.type = 'NEGATIVE_KEYWORDS' AND campaign_shared_set.status = 'ENABLED' AND campaign.status != 'REMOVED'"

export type MatchType = 'EXACT' | 'PHRASE' | 'BROAD'

export interface LiveListKeyword { criterionId: string; text: string; matchType: MatchType }
export interface LiveNegativeList {
  listId: string
  name: string | null
  keywordCount: number
  campaigns: Array<{ campaignId: string; name: string; status: string | null }>
  /** Only when asked for one list. */
  keywords?: LiveListKeyword[]
}

/** A keyword's identity in a list or a campaign: its text (as Google compares it, lower case) and match type. */
export const keywordKey = (text: string, matchType: string) => `${matchType}:${text.trim().toLowerCase().replace(/\s+/g, ' ')}`

/** The account's negative keyword lists with the campaigns each is attached to; one list's keywords when `listId`. */
export async function liveNegativeLists(target: GoogleAdsTarget, listId?: string): Promise<LiveNegativeList[]> {
  const sets = await liveRows<Json>(target, LIVE_LISTS_QUERY, 'ads.search.live.lists')
  const links = await liveRows<Json>(target, LIVE_LIST_ATTACHMENTS_QUERY, 'ads.search.live.list-links')
  const keywords = listId ? await liveListKeywords(target, listId) : null
  return sets.map((row) => {
    const s = row.sharedSet ?? {}
    const id = str(s.id) ?? ''
    return {
      listId: id,
      name: str(s.name),
      keywordCount: Number(s.memberCount ?? 0) || 0,
      campaigns: links.filter((l) => str(l.sharedSet?.id) === id)
        .map((l) => ({ campaignId: str(l.campaign?.id) ?? '', name: str(l.campaign?.name) ?? '', status: str(l.campaign?.status) })),
      ...(listId === id && keywords ? { keywords } : {}),
    }
  })
}

export async function liveListKeywords(target: GoogleAdsTarget, listId: string): Promise<LiveListKeyword[]> {
  const rows = await liveRows<Json>(target, liveListKeywordsQuery(listId), 'ads.search.live.list-keywords')
  return rows.map((row) => ({
    criterionId: str(row.sharedCriterion?.criterionId) ?? '',
    text: str(row.sharedCriterion?.keyword?.text) ?? '',
    matchType: (str(row.sharedCriterion?.keyword?.matchType) ?? 'BROAD') as MatchType,
  }))
}

// ── one campaign, in full ───────────────────────────────────────────────────────────────────────────────────────

const SETTINGS_FIELDS = [
  ...CAMPAIGN_FIELDS,
  'campaign.manual_cpc.enhanced_cpc_enabled', 'campaign.target_spend.cpc_bid_ceiling_micros', 'campaign.bidding_strategy',
  'campaign.maximize_conversions.target_cpa_micros', 'campaign.maximize_conversion_value.target_roas',
  'campaign.network_settings.target_google_search', 'campaign.network_settings.target_search_network',
  'campaign.network_settings.target_content_network', 'campaign.network_settings.target_partner_search_network',
  'campaign.geo_target_type_setting.positive_geo_target_type', 'campaign.geo_target_type_setting.negative_geo_target_type',
  'campaign.targeting_setting.target_restrictions', 'campaign.contains_eu_political_advertising',
  'campaign.ai_max_setting.enable_ai_max', 'campaign.keyword_match_type', 'campaign.asset_automation_settings',
  'campaign.shopping_setting.enable_local', 'campaign.tracking_url_template', 'campaign.final_url_suffix',
  'campaign.primary_status_reasons', 'campaign_budget.delivery_method',
]

export const liveCampaignSettingsQuery = (campaignId: string): string =>
  `SELECT ${SETTINGS_FIELDS.join(', ')} FROM campaign WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')}`

export const liveCampaignCriteriaQuery = (campaignId: string): string =>
  'SELECT campaign_criterion.criterion_id, campaign_criterion.type, campaign_criterion.negative, campaign_criterion.status, ' +
  'campaign_criterion.bid_modifier, campaign_criterion.display_name, campaign_criterion.location.geo_target_constant, ' +
  'campaign_criterion.language.language_constant, campaign_criterion.ad_schedule.day_of_week, ' +
  'campaign_criterion.ad_schedule.start_hour, campaign_criterion.ad_schedule.start_minute, ' +
  'campaign_criterion.ad_schedule.end_hour, campaign_criterion.ad_schedule.end_minute, campaign_criterion.keyword.text, ' +
  'campaign_criterion.keyword.match_type, campaign_criterion.user_interest.user_interest_category, ' +
  `campaign_criterion.user_list.user_list FROM campaign_criterion WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} ` +
  "AND campaign_criterion.status != 'REMOVED'"

export const liveAdGroupsQuery = (campaignId: string): string =>
  'SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type, ad_group.cpc_bid_micros FROM ad_group ' +
  `WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} AND ad_group.status != 'REMOVED'`

export const liveKeywordsQuery = (campaignId: string): string =>
  'SELECT ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.negative, ad_group_criterion.status, ' +
  'ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.cpc_bid_micros, ' +
  'ad_group_criterion.effective_cpc_bid_micros, ad_group_criterion.approval_status, ad_group_criterion.primary_status ' +
  `FROM ad_group_criterion WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} AND ad_group_criterion.type = 'KEYWORD' ` +
  "AND ad_group_criterion.status != 'REMOVED' AND ad_group.status != 'REMOVED'"

export const liveProductGroupsQuery = (campaignId: string): string =>
  'SELECT ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.status, ad_group_criterion.negative, ' +
  'ad_group_criterion.cpc_bid_micros, ad_group_criterion.listing_group.type, ' +
  'ad_group_criterion.listing_group.parent_ad_group_criterion, ad_group_criterion.listing_group.case_value.product_item_id.value, ' +
  'ad_group_criterion.listing_group.case_value.product_brand.value, ad_group_criterion.listing_group.case_value.product_type.value, ' +
  'ad_group_criterion.listing_group.case_value.product_type.level, ' +
  'ad_group_criterion.listing_group.case_value.product_custom_attribute.value, ' +
  'ad_group_criterion.listing_group.case_value.product_custom_attribute.index ' +
  `FROM ad_group_criterion WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} AND ad_group_criterion.type = 'LISTING_GROUP' ` +
  "AND ad_group_criterion.status != 'REMOVED' AND ad_group.status != 'REMOVED'"

export const liveAdsQuery = (campaignId: string): string =>
  'SELECT ad_group.id, ad_group_ad.ad.id, ad_group_ad.status, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ' +
  'ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ' +
  'ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2, ad_group_ad.ad_strength, ' +
  'ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.review_status, ' +
  'ad_group_ad.policy_summary.policy_topic_entries FROM ad_group_ad ' +
  `WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} AND ad_group_ad.status != 'REMOVED' AND ad_group.status != 'REMOVED'`

export const liveCampaignListsQuery = (campaignId: string): string =>
  'SELECT shared_set.id, shared_set.name, shared_set.type, campaign_shared_set.status FROM campaign_shared_set ' +
  `WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} AND campaign_shared_set.status = 'ENABLED'`

export const liveAssetsQuery = (campaignId?: string): string =>
  // Google refuses a filter on campaign.status here unless campaign.status is selected too (read 2026-10-15).
  'SELECT campaign.id, campaign.status, campaign_asset.field_type, campaign_asset.status, campaign_asset.primary_status, ' +
  'campaign_asset.primary_status_reasons, asset.id, asset.type, asset.name, asset.final_urls, ' +
  'asset.sitelink_asset.link_text, asset.sitelink_asset.description1, asset.sitelink_asset.description2, ' +
  'asset.callout_asset.callout_text, asset.structured_snippet_asset.header, asset.structured_snippet_asset.values, ' +
  'asset.policy_summary.approval_status, asset.policy_summary.review_status, asset.policy_summary.policy_topic_entries ' +
  "FROM campaign_asset WHERE campaign_asset.status != 'REMOVED' AND campaign.status != 'REMOVED'" +
  (campaignId ? ` AND campaign.id = ${gaqlId(campaignId, 'The campaign')}` : '')

export interface LiveCriterion {
  criterionId: string
  type: string | null
  negative: boolean
  name: string | null
  bidModifier: number | null
  location?: string | null
  language?: string | null
  schedule?: { day: string | null; from: string; to: string }
  keyword?: { text: string; matchType: string | null }
  audience?: string | null
}

const hhmm = (hour: unknown, minute: unknown): string => {
  const m: Record<string, string> = { ZERO: '00', FIFTEEN: '15', THIRTY: '30', FORTY_FIVE: '45' }
  return `${String(Number(hour ?? 0)).padStart(2, '0')}:${m[String(minute ?? 'ZERO')] ?? '00'}`
}

export function liveCriterionOf(row: Json): LiveCriterion {
  const c = row.campaignCriterion ?? {}
  const out: LiveCriterion = {
    criterionId: str(c.criterionId) ?? '',
    type: str(c.type),
    negative: bool(c.negative),
    name: str(c.displayName),
    bidModifier: typeof c.bidModifier === 'number' ? c.bidModifier : null,
  }
  if (c.location) out.location = str(c.location.geoTargetConstant)
  if (c.language) out.language = str(c.language.languageConstant)
  if (c.adSchedule) out.schedule = { day: str(c.adSchedule.dayOfWeek), from: hhmm(c.adSchedule.startHour, c.adSchedule.startMinute), to: hhmm(c.adSchedule.endHour, c.adSchedule.endMinute) }
  if (c.keyword) out.keyword = { text: str(c.keyword.text) ?? '', matchType: str(c.keyword.matchType) }
  if (c.userInterest || c.userList) out.audience = str(c.userInterest?.userInterestCategory) ?? str(c.userList?.userList)
  return out
}

export interface LiveProductGroup {
  adGroupId: string
  criterionId: string
  /** null for the root ("All products"). */
  parentId: string | null
  /** SUBDIVISION (split further) or UNIT (a leaf with a bid, or excluded). */
  kind: string | null
  /** What this group holds: its dimension and value; "everything else" when its dimension has no value. */
  dimension: string | null
  value: string | null
  everythingElse: boolean
  excluded: boolean
  bidCents: number | null
  status: string | null
}

export function liveProductGroupOf(row: Json): LiveProductGroup {
  const a = row.adGroupCriterion ?? {}
  const lg = a.listingGroup ?? {}
  const cv = lg.caseValue ?? null
  let dimension: string | null = null
  let value: string | null = null
  if (cv) {
    const [key, inner] = Object.entries(cv)[0] ?? []
    dimension = key ?? null
    value = inner && typeof inner === 'object' ? str((inner as Json).value) : null
    if (dimension === 'productType' || dimension === 'productCustomAttribute') {
      const level = str((inner as Json)?.level) ?? str((inner as Json)?.index)
      if (level) dimension = `${dimension}:${level}`
    }
  }
  const kind = str(lg.type)
  return {
    adGroupId: str(row.adGroup?.id) ?? '',
    criterionId: str(a.criterionId) ?? '',
    parentId: idOf(lg.parentAdGroupCriterion)?.split('~')[1] ?? null,
    kind,
    dimension,
    value,
    everythingElse: cv !== null && value === null,
    excluded: bool(a.negative),
    bidCents: centsOfMicros(a.cpcBidMicros),
    status: str(a.status),
  }
}

export interface LiveAd {
  adGroupId: string
  adId: string
  status: string | null
  type: string | null
  finalUrls: string[]
  headlines: Array<{ text: string; pinned: string | null }>
  descriptions: Array<{ text: string; pinned: string | null }>
  path1: string | null
  path2: string | null
  strength: string | null
  approval: string | null
  review: string | null
  policy: Array<{ topic: string | null; type: string | null }>
}

const adText = (assets: unknown) => (Array.isArray(assets) ? assets : []).map((a: Json) => ({ text: str(a.text) ?? '', pinned: str(a.pinnedField) }))
const topics = (entries: unknown) => (Array.isArray(entries) ? entries : []).map((e: Json) => ({ topic: str(e.topic), type: str(e.type) }))

export function liveAdOf(row: Json): LiveAd {
  const g = row.adGroupAd ?? {}
  const ad = g.ad ?? {}
  const rsa = ad.responsiveSearchAd ?? {}
  return {
    adGroupId: str(row.adGroup?.id) ?? '',
    adId: str(ad.id) ?? '',
    status: str(g.status),
    type: str(ad.type),
    finalUrls: Array.isArray(ad.finalUrls) ? ad.finalUrls.map(String) : [],
    headlines: adText(rsa.headlines),
    descriptions: adText(rsa.descriptions),
    path1: str(rsa.path1),
    path2: str(rsa.path2),
    strength: str(g.adStrength),
    approval: str(g.policySummary?.approvalStatus),
    review: str(g.policySummary?.reviewStatus),
    policy: topics(g.policySummary?.policyTopicEntries),
  }
}

export interface LiveAsset {
  campaignId: string
  assetId: string
  fieldType: string | null
  type: string | null
  status: string | null
  primaryStatus: string | null
  primaryStatusReasons: string[]
  text: string | null
  description1?: string | null
  description2?: string | null
  header?: string | null
  values?: string[]
  finalUrls: string[]
  approval: string | null
  review: string | null
  policy: Array<{ topic: string | null; type: string | null }>
}

export function liveAssetOf(row: Json): LiveAsset {
  const link = row.campaignAsset ?? {}
  const a = row.asset ?? {}
  const out: LiveAsset = {
    campaignId: str(row.campaign?.id) ?? '',
    assetId: str(a.id) ?? '',
    fieldType: str(link.fieldType),
    type: str(a.type),
    status: str(link.status),
    primaryStatus: str(link.primaryStatus),
    primaryStatusReasons: Array.isArray(link.primaryStatusReasons) ? link.primaryStatusReasons.map(String) : [],
    text: str(a.sitelinkAsset?.linkText) ?? str(a.calloutAsset?.calloutText) ?? str(a.name),
    finalUrls: Array.isArray(a.finalUrls) ? a.finalUrls.map(String) : [],
    approval: str(a.policySummary?.approvalStatus),
    review: str(a.policySummary?.reviewStatus),
    policy: topics(a.policySummary?.policyTopicEntries),
  }
  if (a.sitelinkAsset) { out.description1 = str(a.sitelinkAsset.description1); out.description2 = str(a.sitelinkAsset.description2) }
  if (a.structuredSnippetAsset) { out.header = str(a.structuredSnippetAsset.header); out.values = Array.isArray(a.structuredSnippetAsset.values) ? a.structuredSnippetAsset.values.map(String) : [] }
  return out
}

export interface LiveCampaignDetail {
  campaign: LiveCampaign & {
    networks: { googleSearch: boolean; searchPartners: boolean; display: boolean; partnerSearch: boolean }
    locationOption: { include: string | null; exclude: string | null }
    audienceMode: Array<{ dimension: string | null; observationOnly: boolean }>
    euPoliticalAds: string | null
    aiMax: boolean
    keywordMatchType: string | null
    assetAutomation: Array<{ type: string | null; status: string | null }>
    manualCpcEnhanced: boolean
    maxCpcCeilingCents: number | null
    targetCpaCents: number | null
    targetRoas: number | null
    biddingStrategyId: string | null
    localInventory: boolean
    trackingTemplate: string | null
    finalUrlSuffix: string | null
    primaryStatusReasons: string[]
  }
  criteria: { locations: LiveCriterion[]; languages: LiveCriterion[]; schedule: LiveCriterion[]; audiences: LiveCriterion[]; negativeKeywords: LiveCriterion[]; other: LiveCriterion[] }
  negativeLists: Array<{ listId: string; name: string | null }>
  /** Shared sets of other types linked to the campaign (brand lists, …): read, so a copy can name what it leaves behind. */
  otherSharedSets: Array<{ listId: string; name: string | null; type: string | null }>
  adGroups: Array<{ adGroupId: string; name: string; status: string | null; type: string | null; cpcBidCents: number | null }>
  keywords: Array<{ adGroupId: string; criterionId: string; text: string; matchType: string | null; negative: boolean; status: string | null; cpcBidCents: number | null; effectiveCpcBidCents: number | null; approval: string | null }>
  productGroups: LiveProductGroup[]
  ads: LiveAd[]
  assets: LiveAsset[]
  /** What Google answered for each part, and the parts it refused (a field it no longer knows, …). */
  notRead: Array<{ part: string; why: string }>
}

/** One campaign's settings, as the settings query reads them (liveCampaignSettingsQuery). */
export function liveCampaignSettingsOf(row: Json): LiveCampaignDetail['campaign'] {
  const c = row.campaign ?? {}
  const base = liveCampaignOf(row)
  const restrictions = Array.isArray(c.targetingSetting?.targetRestrictions) ? c.targetingSetting.targetRestrictions : []
  const automation = Array.isArray(c.assetAutomationSettings) ? c.assetAutomationSettings : []
  return {
    ...base,
    networks: {
      googleSearch: bool(c.networkSettings?.targetGoogleSearch),
      searchPartners: bool(c.networkSettings?.targetSearchNetwork),
      display: bool(c.networkSettings?.targetContentNetwork),
      partnerSearch: bool(c.networkSettings?.targetPartnerSearchNetwork),
    },
    locationOption: { include: str(c.geoTargetTypeSetting?.positiveGeoTargetType), exclude: str(c.geoTargetTypeSetting?.negativeGeoTargetType) },
    audienceMode: restrictions.map((t: Json) => ({ dimension: str(t.targetingDimension), observationOnly: bool(t.bidOnly) })),
    euPoliticalAds: str(c.containsEuPoliticalAdvertising),
    aiMax: bool(c.aiMaxSetting?.enableAiMax),
    keywordMatchType: str(c.keywordMatchType),
    assetAutomation: automation.map((a: Json) => ({ type: str(a.assetAutomationType), status: str(a.assetAutomationStatus) })),
    manualCpcEnhanced: bool(c.manualCpc?.enhancedCpcEnabled),
    maxCpcCeilingCents: centsOfMicros(c.targetSpend?.cpcBidCeilingMicros),
    targetCpaCents: centsOfMicros(c.maximizeConversions?.targetCpaMicros),
    targetRoas: typeof c.maximizeConversionValue?.targetRoas === 'number' ? c.maximizeConversionValue.targetRoas : null,
    biddingStrategyId: idOf(c.biddingStrategy),
    localInventory: bool(c.shoppingSetting?.enableLocal),
    trackingTemplate: str(c.trackingUrlTemplate),
    finalUrlSuffix: str(c.finalUrlSuffix),
    primaryStatusReasons: Array.isArray(c.primaryStatusReasons) ? c.primaryStatusReasons.map(String) : [],
  }
}

/** One campaign's settings, live (one query); null when it does not exist or is removed. */
export async function liveCampaignSettings(target: GoogleAdsTarget, campaignId: string): Promise<LiveCampaignDetail['campaign'] | null> {
  const rows = await liveRows<Json>(target, liveCampaignSettingsQuery(gaqlId(campaignId, 'The campaign')), 'ads.search.live.campaign')
  const row = rows[0]
  return row && str(row.campaign?.status) !== 'REMOVED' ? liveCampaignSettingsOf(row) : null
}

/**
 * One campaign as its settings pages show it: settings, budget, bidding, networks, locations and the location option,
 * languages, schedule, audiences, negatives (campaign, ad group, lists), ad groups with bids, keywords with bids, product
 * groups, ads with their review, campaign assets with their review. Eight queries; a part Google refuses is listed in
 * `notRead` and the rest is still answered. Null when the campaign does not exist (or is removed).
 */
export async function liveCampaignDetail(target: GoogleAdsTarget, campaignId: string): Promise<LiveCampaignDetail | null> {
  const id = gaqlId(campaignId, 'The campaign')
  const settings = await liveRows<Json>(target, liveCampaignSettingsQuery(id), 'ads.search.live.campaign')
  const row = settings[0]
  if (!row || str(row.campaign?.status) === 'REMOVED') return null
  const notRead: LiveCampaignDetail['notRead'] = []
  const part = async <T>(name: string, query: string, map: (r: Json) => T): Promise<T[]> => {
    try {
      return (await liveRows<Json>(target, query, `ads.search.live.${name}`)).map(map)
    } catch (err) {
      notRead.push({ part: name, why: err instanceof Error ? err.message : String(err) })
      return []
    }
  }
  const base = liveCampaignOf(row)
  const criteria = await part('criteria', liveCampaignCriteriaQuery(id), liveCriterionOf)
  const lists = await part('negative-lists', liveCampaignListsQuery(id), (r) => ({ listId: str(r.sharedSet?.id) ?? '', name: str(r.sharedSet?.name), type: str(r.sharedSet?.type) }))
  const adGroups = await part('ad-groups', liveAdGroupsQuery(id), (r) => ({
    adGroupId: str(r.adGroup?.id) ?? '', name: str(r.adGroup?.name) ?? '', status: str(r.adGroup?.status), type: str(r.adGroup?.type), cpcBidCents: centsOfMicros(r.adGroup?.cpcBidMicros),
  }))
  const isShopping = base.type === 'SHOPPING'
  // Keywords and ad-group negative keywords (a Shopping campaign has only the negatives).
  const keywords = await part('keywords', liveKeywordsQuery(id), (r) => ({
    adGroupId: str(r.adGroup?.id) ?? '',
    criterionId: str(r.adGroupCriterion?.criterionId) ?? '',
    text: str(r.adGroupCriterion?.keyword?.text) ?? '',
    matchType: str(r.adGroupCriterion?.keyword?.matchType),
    negative: bool(r.adGroupCriterion?.negative),
    status: str(r.adGroupCriterion?.status),
    cpcBidCents: centsOfMicros(r.adGroupCriterion?.cpcBidMicros),
    effectiveCpcBidCents: centsOfMicros(r.adGroupCriterion?.effectiveCpcBidMicros),
    approval: str(r.adGroupCriterion?.approvalStatus),
  }))
  const productGroups = isShopping ? await part('product-groups', liveProductGroupsQuery(id), liveProductGroupOf) : []
  const ads = isShopping ? [] : await part('ads', liveAdsQuery(id), liveAdOf)
  const assets = await part('assets', liveAssetsQuery(id), liveAssetOf)
  const by = (type: string) => criteria.filter((k) => k.type === type)
  const known = new Set(['LOCATION', 'LANGUAGE', 'AD_SCHEDULE', 'USER_INTEREST', 'USER_LIST', 'KEYWORD'])
  return {
    campaign: liveCampaignSettingsOf(row),
    criteria: {
      locations: by('LOCATION'),
      languages: by('LANGUAGE'),
      schedule: by('AD_SCHEDULE'),
      audiences: [...by('USER_INTEREST'), ...by('USER_LIST')],
      negativeKeywords: criteria.filter((k) => k.type === 'KEYWORD' && k.negative),
      other: criteria.filter((k) => !known.has(k.type ?? '')),
    },
    negativeLists: lists.filter((l) => l.type === 'NEGATIVE_KEYWORDS' || l.type === null).map(({ listId, name }) => ({ listId, name })),
    otherSharedSets: lists.filter((l) => l.type !== null && l.type !== 'NEGATIVE_KEYWORDS'),
    adGroups,
    keywords,
    productGroups,
    ads,
    assets,
    notRead,
  }
}

// ── one ad group's parts (product groups, keywords, ads), for the change tools ─────────────────────────────────

export async function liveProductGroups(target: GoogleAdsTarget, campaignId: string): Promise<LiveProductGroup[]> {
  return (await liveRows<Json>(target, liveProductGroupsQuery(campaignId), 'ads.search.live.product-groups')).map(liveProductGroupOf)
}

export async function liveAds(target: GoogleAdsTarget, campaignId: string): Promise<LiveAd[]> {
  return (await liveRows<Json>(target, liveAdsQuery(campaignId), 'ads.search.live.ads')).map(liveAdOf)
}

export async function liveAssets(target: GoogleAdsTarget, campaignId?: string): Promise<LiveAsset[]> {
  return (await liveRows<Json>(target, liveAssetsQuery(campaignId), 'ads.search.live.assets')).map(liveAssetOf)
}

// ── change history, drafts ──────────────────────────────────────────────────────────────────────────────────────

/** Google keeps 30 days of change history; one day per answer, newest first, at most 1,000 rows. */
export function liveChangeHistoryQuery(day: string, limit = 1000): string {
  if (!DAY.test(day)) throw new Error(`"${day}" is not a day (YYYY-MM-DD). Nothing was sent.`)
  const rows = Math.max(1, Math.min(1000, Math.floor(limit)))
  return 'SELECT change_event.change_date_time, change_event.change_resource_type, change_event.change_resource_name, ' +
    'change_event.resource_change_operation, change_event.changed_fields, change_event.client_type, change_event.user_email, ' +
    'change_event.campaign, change_event.ad_group FROM change_event ' +
    `WHERE change_event.change_date_time >= '${day} 00:00:00' AND change_event.change_date_time <= '${day} 23:59:59' ` +
    `ORDER BY change_event.change_date_time DESC LIMIT ${rows}`
}

export interface LiveChange {
  at: string | null
  resourceType: string | null
  resource: string | null
  operation: string | null
  fields: string | null
  by: string | null
  client: string | null
  campaignId: string | null
  adGroupId: string | null
}

export async function liveChangeHistory(target: GoogleAdsTarget, day: string): Promise<LiveChange[]> {
  const rows = await liveRows<Json>(target, liveChangeHistoryQuery(day), 'ads.search.live.changes')
  return rows.map((row) => {
    const e = row.changeEvent ?? {}
    return {
      at: str(e.changeDateTime),
      resourceType: str(e.changeResourceType),
      resource: idOf(e.changeResourceName),
      operation: str(e.resourceChangeOperation),
      fields: str(e.changedFields),
      by: str(e.userEmail),
      client: str(e.clientType),
      campaignId: idOf(e.campaign),
      adGroupId: idOf(e.adGroup),
    }
  })
}

export const LIVE_DRAFTS_QUERY =
  'SELECT campaign_draft.draft_id, campaign_draft.name, campaign_draft.status, campaign_draft.base_campaign, ' +
  'campaign_draft.draft_campaign, campaign_draft.has_experiment_running FROM campaign_draft'

export interface LiveDraft { draftId: string; name: string | null; status: string | null; baseCampaignId: string | null; draftCampaignId: string | null; experimentRunning: boolean }

/**
 * Campaign drafts (Google Ads "Drafts & experiments"). The "Drafts in progress" of Google's campaign creation pages are
 * not in the API: they are not listed here.
 */
export async function liveDrafts(target: GoogleAdsTarget): Promise<LiveDraft[]> {
  const rows = await liveRows<Json>(target, LIVE_DRAFTS_QUERY, 'ads.search.live.drafts')
  return rows.map((row) => {
    const d = row.campaignDraft ?? {}
    return {
      draftId: str(d.draftId) ?? '',
      name: str(d.name),
      status: str(d.status),
      baseCampaignId: idOf(d.baseCampaign),
      draftCampaignId: idOf(d.draftCampaign),
      experimentRunning: bool(d.hasExperimentRunning),
    }
  })
}
