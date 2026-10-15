/**
 * Google Ads changes (2026-10-15, programme 2 group G11 "Demand Gen, Display, App, Video") — the live reads the
 * campaign-type tools stand on: one Demand Gen, Display, App (MULTI_CHANNEL) or Video campaign with its bidding, app and
 * feed settings and its budget; its ad groups with their bids, Demand Gen channel controls, optimized targeting and
 * audience setting; their targeting criteria (placements, topics, keywords, YouTube, apps, audience segments, Audience
 * resources, locations, languages, listing groups); ads by id with every field an edit can change; image and YouTube
 * video assets by id or by video id; Audience resources by id. One GAQL query each, on the account's change allowance
 * (write-client.ts liveRows).
 *
 * Checked 2026-10-15 with curl in Google's v25 field reference (developers.google.com/google-ads/api/fields/v25/<resource>):
 *   campaign            id, name, status, advertising_channel_type, advertising_channel_sub_type, bidding_strategy_type,
 *                       bidding_strategy, start_date_time, end_date_time, target_cpa.target_cpa_micros,
 *                       target_roas.target_roas, maximize_conversions.target_cpa_micros,
 *                       maximize_conversion_value.target_roas, target_spend.cpc_bid_ceiling_micros,
 *                       target_cpc.target_cpc_micros, app_campaign_setting.app_id / app_store / bidding_strategy_goal_type,
 *                       shopping_setting.merchant_id / feed_label, demand_gen_campaign_settings.upgraded_targeting,
 *                       selective_optimization.conversion_actions, optimization_goal_setting.optimization_goal_types —
 *                       selectable and filterable; campaign_budget (id, amount_micros, total_amount_micros, period,
 *                       explicitly_shared) is an attributed resource of campaign.
 *   ad_group            id, name, status, type, cpc_bid_micros, cpm_bid_micros, target_cpa_micros,
 *                       optimized_targeting_enabled, audience_setting.use_audience_grouped,
 *                       demand_gen_ad_group_settings.channel_controls.channel_strategy / channel_config /
 *                       selected_channels.{youtube_in_stream, youtube_in_feed, youtube_shorts, discover, gmail, display,
 *                       maps} — selectable and filterable; targeting_setting.target_restrictions selectable, NOT
 *                       filterable (never filtered); campaign is an attributed resource. TargetRestriction bid_only,
 *                       targeting_dimension (rpc/v25 TargetRestriction, TargetingDimensionEnum).
 *   ad_group_criterion  criterion_id, type, status, negative, display_name, placement.url, topic.topic_constant,
 *                       keyword.text, keyword.match_type, youtube_video.video_id, youtube_channel.channel_id,
 *                       mobile_application.app_id, mobile_app_category.mobile_app_category_constant, user_list.user_list,
 *                       user_interest.user_interest_category, custom_audience.custom_audience,
 *                       combined_audience.combined_audience, life_event.life_event_id, audience.audience,
 *                       location.geo_target_constant, language.language_constant, listing_group.type, age_range.type,
 *                       gender.type, parental_status.type, income_range.type — selectable and filterable; ad_group and
 *                       campaign are attributed resources. campaign_criterion location / language: live.ts's query (checked
 *                       there; criterion_id, type, negative, status selectable and filterable).
 *   ad_group_ad         status, policy_summary.approval_status, ad.id, ad.type, ad.final_urls, ad.name and the ad info
 *                       fields below — selectable; the
 *                       repeated/message ones (headlines, images, videos, …) are NOT filterable and never filtered here:
 *                       responsive_display_ad.{headlines, long_headline, descriptions, business_name, call_to_action_text,
 *                       marketing_images, square_marketing_images, logo_images, square_logo_images, youtube_videos},
 *                       demand_gen_multi_asset_ad.{headlines, descriptions, business_name, call_to_action_text,
 *                       marketing_images, square_marketing_images, portrait_marketing_images,
 *                       tall_portrait_marketing_images, logo_images}, demand_gen_carousel_ad.{headline, description,
 *                       business_name, call_to_action_text, logo_image, carousel_cards},
 *                       demand_gen_video_responsive_ad.{headlines, long_headlines, descriptions, business_name, videos,
 *                       logo_images, breadcrumb1, breadcrumb2}, demand_gen_product_ad.{headline, description,
 *                       business_name, logo_image, breadcrumb1, breadcrumb2}, app_ad.{headlines, descriptions, images,
 *                       youtube_videos}, app_engagement_ad.{headlines, descriptions, images, videos},
 *                       app_pre_registration_ad.{headlines, descriptions, images, youtube_videos},
 *                       video_responsive_ad.{headlines, long_headlines, descriptions, call_to_actions, business_name,
 *                       videos, logo_images, breadcrumb1, breadcrumb2}; ad_group and campaign are attributed resources.
 *   asset               id, type, name, source, image_asset.full_size.width_pixels / height_pixels, image_asset.mime_type,
 *                       youtube_video_asset.youtube_video_id / youtube_video_title — selectable and filterable.
 *   audience            id, name, status (AudienceStatus ENABLED / REMOVED) — selectable and filterable.
 * Every field a WHERE names is selected too, also a field of another resource (2026-10-15: Google refused a filter on a
 * segmenting resource's field that was not selected).
 */
import { liveRows } from './write-client.js'
import { centsOfMicros, gaqlId, idOf } from './live.js'
import { pairOf } from './live-campaigns.js'
import { restrictionsOf } from './live-targeting.js'
import type { GoogleAdsTarget } from './types.js'

type Json = Record<string, any>
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null)
const num = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String).filter((s) => s !== '') : [])
const inList = (ids: string[], what: string) => [...new Set(ids.map((id) => gaqlId(id, what)))].join(', ')

/** At most this many items are read by id at once. */
export const MAX_TYPED_IDS = 100
function bounded(ids: string[], what: string): string[] {
  const unique = [...new Set(ids)]
  if (!unique.length || unique.length > MAX_TYPED_IDS) throw new Error(`Read 1 to ${MAX_TYPED_IDS} ${what} by id. Nothing was sent.`)
  return unique
}

// ── the campaign ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface LiveTypedCampaign {
  campaignId: string
  name: string
  status: string | null
  /** advertising_channel_type: DEMAND_GEN, DISPLAY, MULTI_CHANNEL (App), VIDEO, … */
  type: string | null
  subType: string | null
  /** bidding_strategy_type (TARGET_CPA, MAXIMIZE_CONVERSIONS, MANUAL_CPC, …). */
  bidding: string | null
  /** A portfolio bid strategy's id, when the campaign uses one. */
  portfolioId: string | null
  start: string | null
  end: string | null
  targetCpaCents: number | null
  targetRoas: number | null
  maxCpcCents: number | null
  targetCpcCents: number | null
  app: { appId: string | null; appStore: string | null; goal: string | null } | null
  merchantId: string | null
  feedLabel: string | null
  /** Demand Gen: locations and languages at the ad groups (true) or at the campaign (false). */
  upgradedTargeting: boolean
  conversionActionIds: string[]
  optimizationGoals: string[]
  budget: { budgetId: string | null; amountCents: number | null; totalCents: number | null; period: string | null; shared: boolean } | null
}

const TYPED_CAMPAIGN_FIELDS = [
  'campaign.id', 'campaign.name', 'campaign.status', 'campaign.advertising_channel_type', 'campaign.advertising_channel_sub_type',
  'campaign.bidding_strategy_type', 'campaign.bidding_strategy', 'campaign.start_date_time', 'campaign.end_date_time',
  'campaign.target_cpa.target_cpa_micros', 'campaign.target_roas.target_roas', 'campaign.maximize_conversions.target_cpa_micros',
  'campaign.maximize_conversion_value.target_roas', 'campaign.target_spend.cpc_bid_ceiling_micros', 'campaign.target_cpc.target_cpc_micros',
  'campaign.app_campaign_setting.app_id', 'campaign.app_campaign_setting.app_store', 'campaign.app_campaign_setting.bidding_strategy_goal_type',
  'campaign.shopping_setting.merchant_id', 'campaign.shopping_setting.feed_label', 'campaign.demand_gen_campaign_settings.upgraded_targeting',
  'campaign.selective_optimization.conversion_actions', 'campaign.optimization_goal_setting.optimization_goal_types',
  'campaign_budget.id', 'campaign_budget.amount_micros', 'campaign_budget.total_amount_micros', 'campaign_budget.period',
  'campaign_budget.explicitly_shared',
]

export const liveTypedCampaignQuery = (campaignId: string): string =>
  `SELECT ${TYPED_CAMPAIGN_FIELDS.join(', ')} FROM campaign WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} AND campaign.status != 'REMOVED'`

export function liveTypedCampaignOf(row: Json): LiveTypedCampaign {
  const c = row.campaign ?? {}
  const b = row.campaignBudget
  const app = c.appCampaignSetting
  const strategy = str(c.biddingStrategyType)
  return {
    campaignId: str(c.id) ?? '',
    name: str(c.name) ?? '',
    status: str(c.status),
    type: str(c.advertisingChannelType),
    subType: str(c.advertisingChannelSubType),
    bidding: strategy,
    portfolioId: idOf(c.biddingStrategy),
    start: str(c.startDateTime),
    end: str(c.endDateTime),
    targetCpaCents: centsOfMicros(c.targetCpa?.targetCpaMicros ?? c.maximizeConversions?.targetCpaMicros),
    targetRoas: num(c.targetRoas?.targetRoas ?? c.maximizeConversionValue?.targetRoas),
    maxCpcCents: centsOfMicros(c.targetSpend?.cpcBidCeilingMicros),
    targetCpcCents: centsOfMicros(c.targetCpc?.targetCpcMicros),
    app: app ? { appId: str(app.appId), appStore: str(app.appStore), goal: str(app.biddingStrategyGoalType) } : null,
    merchantId: str(c.shoppingSetting?.merchantId),
    feedLabel: str(c.shoppingSetting?.feedLabel),
    // Google's JSON leaves a false bool out of its answer: no value is false (the campaign holds its own locations).
    upgradedTargeting: c.demandGenCampaignSettings?.upgradedTargeting === true,
    conversionActionIds: strings(c.selectiveOptimization?.conversionActions).map((r) => idOf(r) ?? r),
    optimizationGoals: strings(c.optimizationGoalSetting?.optimizationGoalTypes),
    budget: b ? {
      budgetId: str(b.id), amountCents: centsOfMicros(b.amountMicros), totalCents: centsOfMicros(b.totalAmountMicros),
      // Google leaves a field at its default out of the answer: a budget with no period is DAILY.
      period: str(b.period) ?? 'DAILY', shared: b.explicitlyShared === true,
    } : null,
  }
}

export async function liveTypedCampaign(target: GoogleAdsTarget, campaignId: string): Promise<LiveTypedCampaign | null> {
  const rows = await liveRows<Json>(target, liveTypedCampaignQuery(campaignId), 'ads.search.live.typed-campaign')
  return rows.length ? liveTypedCampaignOf(rows[0]) : null
}

// ── its ad groups ────────────────────────────────────────────────────────────────────────────────────────────────

/** Demand Gen channels, as Google's DemandGenSelectedChannels names them (camelCase in JSON). */
export const DG_CHANNELS = ['YOUTUBE_IN_STREAM', 'YOUTUBE_IN_FEED', 'YOUTUBE_SHORTS', 'DISCOVER', 'GMAIL', 'DISPLAY', 'MAPS'] as const
export type DgChannel = typeof DG_CHANNELS[number]
export const DG_CHANNEL_FIELD: Record<DgChannel, string> = {
  YOUTUBE_IN_STREAM: 'youtubeInStream', YOUTUBE_IN_FEED: 'youtubeInFeed', YOUTUBE_SHORTS: 'youtubeShorts', DISCOVER: 'discover',
  GMAIL: 'gmail', DISPLAY: 'display', MAPS: 'maps',
}
export const DG_STRATEGIES = ['ALL_CHANNELS', 'ALL_OWNED_AND_OPERATED_CHANNELS'] as const
export type DgStrategy = typeof DG_STRATEGIES[number]
/** A Demand Gen ad group's channel controls: a strategy, or the channels picked one by one. */
export type ChannelControls = { strategy: DgStrategy } | { selected: DgChannel[] }

export interface LiveTypedAdGroup {
  adGroupId: string
  name: string
  status: string | null
  type: string | null
  cpcBidCents: number | null
  cpmBidCents: number | null
  targetCpaCents: number | null
  optimizedTargeting: boolean
  audienceGrouped: boolean
  /** Demand Gen only; null elsewhere. */
  channels: ChannelControls | null
  /**
   * The targeting dimensions set to observation (TargetRestriction.bid_only true: "these criteria will only apply bid
   * modifiers, and not affect targeting"): AUDIENCE, TOPIC, PLACEMENT, KEYWORD, AGE_RANGE, GENDER, PARENTAL_STATUS,
   * INCOME_RANGE (TargetingDimension, v25).
   */
  observation: string[]
}

export const liveTypedAdGroupsQuery = (campaignId: string): string =>
  'SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type, ad_group.cpc_bid_micros, ad_group.cpm_bid_micros, ' +
  'ad_group.target_cpa_micros, ad_group.optimized_targeting_enabled, ad_group.audience_setting.use_audience_grouped, ' +
  'ad_group.targeting_setting.target_restrictions, ' +
  'ad_group.demand_gen_ad_group_settings.channel_controls.channel_config, ad_group.demand_gen_ad_group_settings.channel_controls.channel_strategy, ' +
  DG_CHANNELS.map((c) => `ad_group.demand_gen_ad_group_settings.channel_controls.selected_channels.${c.toLowerCase()}`).join(', ') +
  `, campaign.id, campaign.status FROM ad_group WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} AND ad_group.status != 'REMOVED' ORDER BY ad_group.id`

export function channelsOf(settings: Json | undefined): ChannelControls | null {
  const controls = settings?.channelControls
  if (!controls) return null
  const strategy = str(controls.channelStrategy)
  if (strategy && (DG_STRATEGIES as readonly string[]).includes(strategy)) return { strategy: strategy as DgStrategy }
  const picked = controls.selectedChannels
  if (picked && typeof picked === 'object') return { selected: DG_CHANNELS.filter((c) => picked[DG_CHANNEL_FIELD[c]] === true) }
  return null
}

export function liveTypedAdGroupOf(row: Json, campaignType: string | null): LiveTypedAdGroup {
  const g = row.adGroup ?? {}
  const positive = (v: unknown) => { const c = centsOfMicros(v); return c && c > 0 ? c : null }
  return {
    adGroupId: str(g.id) ?? '',
    name: str(g.name) ?? '',
    status: str(g.status),
    type: str(g.type),
    cpcBidCents: positive(g.cpcBidMicros),
    cpmBidCents: positive(g.cpmBidMicros),
    targetCpaCents: positive(g.targetCpaMicros),
    optimizedTargeting: g.optimizedTargetingEnabled === true,
    audienceGrouped: g.audienceSetting?.useAudienceGrouped === true,
    // Google leaves the default out of its answer: a Demand Gen ad group with no channel controls serves on all channels.
    channels: campaignType === 'DEMAND_GEN' ? channelsOf(g.demandGenAdGroupSettings) ?? { strategy: 'ALL_CHANNELS' } : null,
    observation: restrictionsOf(g.targetingSetting).filter((r) => r.observationOnly && r.dimension).map((r) => r.dimension!),
  }
}

export async function liveTypedAdGroups(target: GoogleAdsTarget, campaignId: string, campaignType: string | null): Promise<LiveTypedAdGroup[]> {
  return (await liveRows<Json>(target, liveTypedAdGroupsQuery(campaignId), 'ads.search.live.typed-ad-groups')).map((row) => liveTypedAdGroupOf(row, campaignType))
}

// ── their targeting ──────────────────────────────────────────────────────────────────────────────────────────────

/** What one targeting criterion is, as these tools name it (a person's word for each kind). */
export const TARGET_KINDS = [
  'placement', 'topic', 'keyword', 'youtube-channel', 'youtube-video', 'mobile-app', 'app-category',
  'user-list', 'user-interest', 'custom-audience', 'combined-audience', 'life-event', 'audience', 'location', 'language',
  'age-range', 'gender', 'parental-status', 'income-range',
] as const
export type TargetKind = typeof TARGET_KINDS[number]

/** Google's criterion type of each kind (CriterionType, v25). */
export const TARGET_CRITERION_TYPE: Record<TargetKind, string> = {
  placement: 'PLACEMENT', topic: 'TOPIC', keyword: 'KEYWORD', 'youtube-channel': 'YOUTUBE_CHANNEL', 'youtube-video': 'YOUTUBE_VIDEO',
  'mobile-app': 'MOBILE_APPLICATION', 'app-category': 'MOBILE_APP_CATEGORY', 'user-list': 'USER_LIST', 'user-interest': 'USER_INTEREST',
  'custom-audience': 'CUSTOM_AUDIENCE', 'combined-audience': 'COMBINED_AUDIENCE', 'life-event': 'LIFE_EVENT', audience: 'AUDIENCE',
  location: 'LOCATION', language: 'LANGUAGE', 'age-range': 'AGE_RANGE', gender: 'GENDER', 'parental-status': 'PARENTAL_STATUS', 'income-range': 'INCOME_RANGE',
}

export interface LiveTypedCriterion {
  adGroupId: string
  criterionId: string
  kind: TargetKind | 'listing-group'
  /** The value as these tools take it: a URL, an id, a keyword's text … */
  value: string
  exclude: boolean
  status: string | null
  name: string | null
}

export const liveTypedCriteriaQuery = (campaignId: string): string =>
  'SELECT ad_group.id, campaign.id, ad_group_criterion.criterion_id, ad_group_criterion.type, ad_group_criterion.status, ' +
  'ad_group_criterion.negative, ad_group_criterion.display_name, ad_group_criterion.placement.url, ad_group_criterion.topic.topic_constant, ' +
  'ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.youtube_video.video_id, ' +
  'ad_group_criterion.youtube_channel.channel_id, ad_group_criterion.mobile_application.app_id, ' +
  'ad_group_criterion.mobile_app_category.mobile_app_category_constant, ad_group_criterion.user_list.user_list, ' +
  'ad_group_criterion.user_interest.user_interest_category, ad_group_criterion.custom_audience.custom_audience, ' +
  'ad_group_criterion.combined_audience.combined_audience, ad_group_criterion.life_event.life_event_id, ' +
  'ad_group_criterion.audience.audience, ad_group_criterion.location.geo_target_constant, ad_group_criterion.language.language_constant, ' +
  'ad_group_criterion.age_range.type, ad_group_criterion.gender.type, ad_group_criterion.parental_status.type, ad_group_criterion.income_range.type, ' +
  `ad_group_criterion.listing_group.type FROM ad_group_criterion WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} ` +
  `AND ad_group_criterion.status != 'REMOVED' AND ad_group_criterion.type IN (${[...Object.values(TARGET_CRITERION_TYPE), 'LISTING_GROUP'].map((t) => `'${t}'`).join(', ')})`

/** The kind and value of a criterion's JSON (Google's REST names), or null for a criterion these tools do not name. */
export function targetOf(c: Json): { kind: TargetKind | 'listing-group'; value: string } | null {
  const tail = (resource: unknown) => idOf(resource) ?? ''
  if (c.placement) return { kind: 'placement', value: str(c.placement.url) ?? '' }
  if (c.topic) return { kind: 'topic', value: tail(c.topic.topicConstant) }
  if (c.keyword) return { kind: 'keyword', value: str(c.keyword.text) ?? '' }
  if (c.youtubeChannel) return { kind: 'youtube-channel', value: str(c.youtubeChannel.channelId) ?? '' }
  if (c.youtubeVideo) return { kind: 'youtube-video', value: str(c.youtubeVideo.videoId) ?? '' }
  if (c.mobileApplication) return { kind: 'mobile-app', value: str(c.mobileApplication.appId) ?? '' }
  if (c.mobileAppCategory) return { kind: 'app-category', value: tail(c.mobileAppCategory.mobileAppCategoryConstant) }
  if (c.userList) return { kind: 'user-list', value: tail(c.userList.userList) }
  if (c.userInterest) return { kind: 'user-interest', value: tail(c.userInterest.userInterestCategory) }
  if (c.customAudience) return { kind: 'custom-audience', value: tail(c.customAudience.customAudience) }
  if (c.combinedAudience) return { kind: 'combined-audience', value: tail(c.combinedAudience.combinedAudience) }
  if (c.lifeEvent) return { kind: 'life-event', value: str(c.lifeEvent.lifeEventId) ?? '' }
  if (c.audience) return { kind: 'audience', value: tail(c.audience.audience) }
  if (c.location) return { kind: 'location', value: tail(c.location.geoTargetConstant) }
  if (c.language) return { kind: 'language', value: tail(c.language.languageConstant) }
  if (c.ageRange) return { kind: 'age-range', value: str(c.ageRange.type) ?? '' }
  if (c.gender) return { kind: 'gender', value: str(c.gender.type) ?? '' }
  if (c.parentalStatus) return { kind: 'parental-status', value: str(c.parentalStatus.type) ?? '' }
  if (c.incomeRange) return { kind: 'income-range', value: str(c.incomeRange.type) ?? '' }
  if (c.listingGroup) return { kind: 'listing-group', value: str(c.listingGroup.type) ?? '' }
  return null
}

export function liveTypedCriterionOf(row: Json): LiveTypedCriterion | null {
  const c = row.adGroupCriterion ?? {}
  const what = targetOf(c)
  if (!what) return null
  return {
    adGroupId: str(row.adGroup?.id) ?? '',
    criterionId: str(c.criterionId) ?? '',
    kind: what.kind,
    value: what.value,
    exclude: c.negative === true,
    status: str(c.status),
    name: str(c.displayName),
  }
}

export async function liveTypedCriteria(target: GoogleAdsTarget, campaignId: string): Promise<LiveTypedCriterion[]> {
  const rows = await liveRows<Json>(target, liveTypedCriteriaQuery(campaignId), 'ads.search.live.typed-criteria')
  return rows.map(liveTypedCriterionOf).filter((c): c is LiveTypedCriterion => !!c)
}

// ── ads by id ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The ad info fields (Google's JSON name) each ad type keeps its parts in. */
export const AD_INFO_KEY: Record<string, string> = {
  RESPONSIVE_DISPLAY_AD: 'responsiveDisplayAd',
  DEMAND_GEN_MULTI_ASSET_AD: 'demandGenMultiAssetAd',
  DEMAND_GEN_CAROUSEL_AD: 'demandGenCarouselAd',
  DEMAND_GEN_VIDEO_RESPONSIVE_AD: 'demandGenVideoResponsiveAd',
  DEMAND_GEN_PRODUCT_AD: 'demandGenProductAd',
  APP_AD: 'appAd',
  APP_ENGAGEMENT_AD: 'appEngagementAd',
  APP_PRE_REGISTRATION_AD: 'appPreRegistrationAd',
  VIDEO_RESPONSIVE_AD: 'videoResponsiveAd',
}

const AD_INFO_FIELDS: Record<string, string[]> = {
  responsive_display_ad: ['headlines', 'long_headline', 'descriptions', 'business_name', 'call_to_action_text', 'marketing_images', 'square_marketing_images', 'logo_images', 'square_logo_images', 'youtube_videos'],
  demand_gen_multi_asset_ad: ['headlines', 'descriptions', 'business_name', 'call_to_action_text', 'marketing_images', 'square_marketing_images', 'portrait_marketing_images', 'tall_portrait_marketing_images', 'logo_images'],
  demand_gen_carousel_ad: ['headline', 'description', 'business_name', 'call_to_action_text', 'logo_image', 'carousel_cards'],
  demand_gen_video_responsive_ad: ['headlines', 'long_headlines', 'descriptions', 'business_name', 'videos', 'logo_images', 'breadcrumb1', 'breadcrumb2'],
  demand_gen_product_ad: ['headline', 'description', 'business_name', 'logo_image', 'breadcrumb1', 'breadcrumb2'],
  app_ad: ['headlines', 'descriptions', 'images', 'youtube_videos'],
  app_engagement_ad: ['headlines', 'descriptions', 'images', 'videos'],
  app_pre_registration_ad: ['headlines', 'descriptions', 'images', 'youtube_videos'],
  video_responsive_ad: ['headlines', 'long_headlines', 'descriptions', 'call_to_actions', 'business_name', 'videos', 'logo_images', 'breadcrumb1', 'breadcrumb2'],
}

export interface LiveTypedAd {
  /** `adGroupId~adId` (the AdGroupAd's own key). */
  id: string
  adGroupId: string
  adId: string
  type: string | null
  status: string | null
  adGroupStatus: string | null
  campaignId: string
  campaignStatus: string | null
  campaignType: string | null
  finalUrls: string[]
  /** Google's review of the ad (PolicyApprovalStatus: APPROVED, APPROVED_LIMITED, AREA_OF_INTEREST_ONLY, DISAPPROVED …). */
  approval: string | null
  /** The ad's info message as Google sent it (camelCase JSON), or null for an ad type these tools do not edit. */
  info: Json | null
}

export const liveTypedAdsQuery = (pairs: Array<[string, string]>): string =>
  'SELECT ad_group.id, ad_group.status, campaign.id, campaign.status, campaign.advertising_channel_type, ad_group_ad.status, ' +
  'ad_group_ad.policy_summary.approval_status, ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ' +
  Object.entries(AD_INFO_FIELDS).flatMap(([info, fields]) => fields.map((f) => `ad_group_ad.ad.${info}.${f}`)).join(', ') +
  ` FROM ad_group_ad WHERE ad_group.id IN (${inList(pairs.map((p) => p[0]), 'The ad group')}) AND ad_group_ad.ad.id IN (${inList(pairs.map((p) => p[1]), 'The ad')})`

export function liveTypedAdOf(row: Json): LiveTypedAd {
  const a = row.adGroupAd?.ad ?? {}
  const type = str(a.type)
  const adGroupId = str(row.adGroup?.id) ?? ''
  const adId = str(a.id) ?? ''
  const key = type ? AD_INFO_KEY[type] : undefined
  return {
    id: `${adGroupId}~${adId}`,
    adGroupId,
    adId,
    type,
    status: str(row.adGroupAd?.status),
    adGroupStatus: str(row.adGroup?.status),
    campaignId: str(row.campaign?.id) ?? '',
    campaignStatus: str(row.campaign?.status),
    campaignType: str(row.campaign?.advertisingChannelType),
    finalUrls: strings(a.finalUrls),
    approval: str(row.adGroupAd?.policySummary?.approvalStatus),
    info: key ? (a[key] ?? {}) : null,
  }
}

/** Ads by `adGroupId~adId`; an id Google does not return is missing from the answer. */
export async function liveTypedAds(target: GoogleAdsTarget, ids: string[]): Promise<LiveTypedAd[]> {
  const pairs = bounded(ids, 'ads').map((id) => pairOf(id)).filter((p): p is [string, string] => !!p)
  if (!pairs.length) return []
  const wanted = new Set(pairs.map((p) => `${p[0]}~${p[1]}`))
  // The query crosses the ad group ids with the ad ids: only the pairs asked are kept.
  return (await liveRows<Json>(target, liveTypedAdsQuery(pairs), 'ads.search.live.typed-ads')).map(liveTypedAdOf).filter((ad) => wanted.has(ad.id))
}

// ── media assets ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface LiveMediaAsset {
  assetId: string
  type: string | null
  name: string | null
  source: string | null
  width: number | null
  height: number | null
  mimeType: string | null
  youtubeVideoId: string | null
  youtubeTitle: string | null
}

const MEDIA_FIELDS = 'asset.id, asset.type, asset.name, asset.source, asset.image_asset.full_size.width_pixels, ' +
  'asset.image_asset.full_size.height_pixels, asset.image_asset.mime_type, asset.youtube_video_asset.youtube_video_id, ' +
  'asset.youtube_video_asset.youtube_video_title'

export const liveMediaAssetsQuery = (assetIds: string[]): string =>
  `SELECT ${MEDIA_FIELDS} FROM asset WHERE asset.id IN (${inList(assetIds, 'The asset')})`

/** A YouTube id as Google writes it (11 characters of A–Z, a–z, 0–9, - and _): safe inside a GAQL string. */
export const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/

export function liveYoutubeAssetsQuery(videoIds: string[]): string {
  const ids = [...new Set(videoIds)]
  for (const id of ids) if (!YOUTUBE_ID.test(id)) throw new Error(`"${id}" is not a YouTube video id. Nothing was sent.`)
  return `SELECT ${MEDIA_FIELDS} FROM asset WHERE asset.type = 'YOUTUBE_VIDEO' AND asset.youtube_video_asset.youtube_video_id IN (${ids.map((id) => `'${id}'`).join(', ')})`
}

export function liveMediaAssetOf(row: Json): LiveMediaAsset {
  const a = row.asset ?? {}
  const full = a.imageAsset?.fullSize ?? {}
  return {
    assetId: str(a.id) ?? '',
    type: str(a.type),
    name: str(a.name),
    source: str(a.source),
    width: num(full.widthPixels),
    height: num(full.heightPixels),
    mimeType: str(a.imageAsset?.mimeType),
    youtubeVideoId: str(a.youtubeVideoAsset?.youtubeVideoId),
    youtubeTitle: str(a.youtubeVideoAsset?.youtubeVideoTitle),
  }
}

/** Image and video assets by id (an id Google does not return is missing). */
export async function liveMediaAssets(target: GoogleAdsTarget, assetIds: string[]): Promise<LiveMediaAsset[]> {
  if (!assetIds.length) return []
  return (await liveRows<Json>(target, liveMediaAssetsQuery(bounded(assetIds, 'assets')), 'ads.search.live.media-assets')).map(liveMediaAssetOf)
}

/** The account's YOUTUBE_VIDEO assets of these videos: a video it has already is used again, not made twice. */
export async function liveYoutubeAssets(target: GoogleAdsTarget, videoIds: string[]): Promise<LiveMediaAsset[]> {
  if (!videoIds.length) return []
  return (await liveRows<Json>(target, liveYoutubeAssetsQuery(bounded(videoIds, 'YouTube videos')), 'ads.search.live.youtube-assets')).map(liveMediaAssetOf)
}

// ── Audience resources ──────────────────────────────────────────────────────────────────────────────────────────

export interface LiveAudience { audienceId: string; name: string | null; status: string | null }

export const liveAudiencesQuery = (ids: string[]): string =>
  `SELECT audience.id, audience.name, audience.status FROM audience WHERE audience.id IN (${inList(ids, 'The audience')})`

export async function liveAudiences(target: GoogleAdsTarget, ids: string[]): Promise<LiveAudience[]> {
  if (!ids.length) return []
  return (await liveRows<Json>(target, liveAudiencesQuery(bounded(ids, 'audiences')), 'ads.search.live.audiences')).map((row) => ({
    audienceId: str(row.audience?.id) ?? '', name: str(row.audience?.name), status: str(row.audience?.status),
  }))
}
