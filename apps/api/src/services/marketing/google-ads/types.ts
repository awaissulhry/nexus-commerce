/**
 * Google Ads steps 1a and 1b — the shapes of the read: what Google's REST answer looks like (camelCase, int64 as
 * strings, zero / default fields left out) and what the mappers make of it for the GoogleAds* tables.
 *
 * Read-only. Nothing in this folder sends a change to Google; the gateway refuses one anyway (GOOGLE_READ_ONLY).
 */
import type { Prisma } from '@prisma/client'

/** One Google Ads account to read, through one Google connection. Ids are digits only (no hyphens). */
export interface GoogleAdsTarget {
  connectionId: string
  customerId: string
  /** The manager account the calls go through (`login-customer-id`); null = the login reaches the account directly. */
  loginCustomerId: string | null
}

// ── Google's REST answer (GoogleAdsService.Search) ───────────────────────────────────────────────────────────────
// proto3 JSON: int64 values arrive as strings, doubles as numbers, enums as their names; a field at its default
// (0, false, '', UNSPECIFIED) is left out of the answer. Every field is therefore optional here.

/** int64 in Google's JSON. */
export type Int64String = string

export interface GoogleAdsSearchPage<Row> {
  results?: Row[]
  /** Absent on the last page. Valid for about two hours. */
  nextPageToken?: string
  fieldMask?: string
  queryResourceConsumption?: Int64String
}

export interface GoogleAdsCustomerJson {
  resourceName?: string
  id?: Int64String
  descriptiveName?: string
  currencyCode?: string
  timeZone?: string
  manager?: boolean
  testAccount?: boolean
  status?: string
}
export interface GoogleAdsCustomerRow { customer?: GoogleAdsCustomerJson }

export interface GoogleAdsCustomerClientJson {
  resourceName?: string
  /** customers/{id} */
  clientCustomer?: string
  id?: Int64String
  level?: Int64String
  manager?: boolean
  descriptiveName?: string
  currencyCode?: string
  timeZone?: string
  status?: string
  testAccount?: boolean
}
export interface GoogleAdsCustomerClientRow { customerClient?: GoogleAdsCustomerClientJson }

export interface GoogleAdsCampaignJson {
  resourceName?: string
  id?: Int64String
  name?: string
  status?: string
  servingStatus?: string
  primaryStatus?: string
  primaryStatusReasons?: string[]
  advertisingChannelType?: string
  advertisingChannelSubType?: string
  biddingStrategyType?: string
  /** The portfolio strategy's resource name. */
  biddingStrategy?: string
  targetCpa?: { targetCpaMicros?: Int64String }
  targetRoas?: { targetRoas?: number }
  maximizeConversions?: { targetCpaMicros?: Int64String }
  maximizeConversionValue?: { targetRoas?: number }
  /** "yyyy-MM-dd HH:mm:ss" in the account's time zone. */
  startDateTime?: string
  endDateTime?: string
  shoppingSetting?: { merchantId?: Int64String; feedLabel?: string }
}
export interface GoogleAdsCampaignBudgetJson {
  resourceName?: string
  id?: Int64String
  amountMicros?: Int64String
  deliveryMethod?: string
  period?: string
  explicitlyShared?: boolean
}
export interface GoogleAdsCampaignRow { campaign?: GoogleAdsCampaignJson; campaignBudget?: GoogleAdsCampaignBudgetJson }

export interface GoogleAdsMetricsJson {
  impressions?: Int64String
  clicks?: Int64String
  costMicros?: Int64String
  /** double */
  conversions?: number
  /** double, in currency units (not micros) */
  conversionsValue?: number
  allConversions?: number
  allConversionsValue?: number
}
export interface GoogleAdsCampaignDayRow {
  campaign?: { resourceName?: string; id?: Int64String; name?: string }
  /** date: "yyyy-MM-dd", a day in the account's time zone. */
  segments?: { date?: string }
  metrics?: GoogleAdsMetricsJson
}

export interface GoogleAdsChangeEventJson {
  resourceName?: string
  /** "yyyy-MM-dd HH:mm:ss[.ffffff]" in the account's time zone. */
  changeDateTime?: string
  changeResourceType?: string
  changeResourceName?: string
  resourceChangeOperation?: string
  /** A FieldMask: one string, paths separated by commas (camelCase in JSON). */
  changedFields?: string
  clientType?: string
  userEmail?: string
  campaign?: string
  adGroup?: string
  oldResource?: Record<string, unknown>
  newResource?: Record<string, unknown>
}
export interface GoogleAdsChangeEventRow { changeEvent?: GoogleAdsChangeEventJson }

/** customers:listAccessibleCustomers */
export interface GoogleAdsAccessibleCustomersJson { resourceNames?: string[] }

// ── What the mappers make (table data; the store adds the business, the run's times and ids) ─────────────────────

export type GoogleAdsCampaignStatus = 'ENABLED' | 'PAUSED' | 'REMOVED' | 'UNKNOWN'
export type GoogleAdsEntityType = 'CAMPAIGN' | 'AD_GROUP' | 'KEYWORD' | 'ASSET_GROUP' | 'PRODUCT' | 'SEARCH_TERM'

/** Where a change was made, in the five words the campaign modal shows (PLAN.md L16). */
export type GoogleAdsChangeSource = 'google_automatic' | 'google_ads_web' | 'google_ads_editor' | 'api' | 'other'

export interface GoogleAdsCustomerData {
  customerId: string
  descriptiveName: string | null
  currencyCode: string
  timeZone: string
  manager: boolean
  testAccount: boolean
  /** ENABLED | CANCELED | SUSPENDED | CLOSED | UNKNOWN */
  status: string
}

export interface GoogleAdsCustomerClientData extends GoogleAdsCustomerData {
  /** 0 = the manager itself, 1 = a direct client. */
  level: number
}

/** A GoogleAdsCampaign row without the business, its id, firstSeenAt / lastSeenAt / removedAt and timestamps. */
export interface GoogleAdsCampaignData {
  customerId: string
  campaignId: string
  name: string
  status: GoogleAdsCampaignStatus
  servingStatus: string | null
  primaryStatus: string | null
  primaryStatusReasons: string[]
  channelType: string
  channelSubType: string | null
  biddingStrategyType: string | null
  portfolioBiddingStrategy: string | null
  targetCpaMicros: bigint | null
  /** Decimal(10,4) as text, e.g. "4.5000". */
  targetRoas: string | null
  budgetId: string | null
  budgetAmountMicros: bigint | null
  budgetDeliveryMethod: string | null
  budgetPeriod: string | null
  budgetShared: boolean
  merchantId: string | null
  feedLabel: string | null
  /** UTC midnight of the account's day (a @db.Date column). */
  startDate: Date | null
  endDate: Date | null
  currencyCode: string
}

/** A GoogleAdsDailyMetric row without the business, its id, pulledAt and createdAt. */
export interface GoogleAdsDailyMetricData {
  customerId: string
  /** UTC midnight of the account's day (segments.date). */
  date: Date
  entityType: GoogleAdsEntityType
  entityId: string
  campaignId: string
  adGroupId: string | null
  label: string | null
  impressions: number
  clicks: number
  costMicros: bigint
  /** Decimal(14,4) as text. */
  conversions: string
  conversionsValueMicros: bigint
  allConversions: string | null
  allConversionsValueMicros: bigint | null
  currencyCode: string
}

/** A GoogleAdsChangeEvent row without the business, its id and createdAt. `userEmail` is stored, never returned or logged. */
export interface GoogleAdsChangeEventData {
  customerId: string
  resourceName: string
  changedAt: Date
  resourceType: string
  changeResourceName: string
  operation: string
  clientType: string | null
  userEmail: string | null
  /** snake_case field paths of the changed resource, e.g. ["status", "amount_micros"]. */
  changedFields: string[]
  campaignId: string | null
  adGroupId: string | null
  /** Left out (undefined) when Google sent none: a nullable Json column takes no plain null. */
  oldResource?: Prisma.InputJsonObject
  newResource?: Prisma.InputJsonObject
}

// ── Step 1b: Google's REST answer ────────────────────────────────────────────────────────────────────────────────

/** A resource seen through another (campaign.id, ad_group.id, …): the id, its resource name, sometimes the name. */
export interface GoogleAdsRefJson { resourceName?: string; id?: Int64String; name?: string }

export interface GoogleAdsKeywordInfoJson { text?: string; matchType?: string }

export interface GoogleAdsAssetAutomationSettingJson { assetAutomationType?: string; assetAutomationStatus?: string }

/** The campaign settings by which Google acts on its own (CAMPAIGN_SETTINGS). */
export interface GoogleAdsCampaignFlagsRow {
  campaign?: GoogleAdsRefJson & {
    aiMaxSetting?: { enableAiMax?: boolean }
    keywordMatchType?: string
    /** "yyyy-MM-dd HH:mm:ss" in the account's time zone. */
    broadMatchMigrationDateTime?: string
    assetAutomationSettings?: GoogleAdsAssetAutomationSettingJson[]
    networkSettings?: { targetGoogleSearch?: boolean; targetSearchNetwork?: boolean; targetContentNetwork?: boolean; targetPartnerSearchNetwork?: boolean }
    dynamicSearchAdsSetting?: { domainName?: string }
  }
}

export interface GoogleAdsPolicyTopicEntryJson { topic?: string; type?: string }
export interface GoogleAdsAdPolicyRow {
  campaign?: GoogleAdsRefJson
  adGroup?: GoogleAdsRefJson
  adGroupAd?: {
    resourceName?: string
    status?: string
    ad?: { id?: Int64String; type?: string; resourceName?: string }
    policySummary?: { approvalStatus?: string; reviewStatus?: string; policyTopicEntries?: GoogleAdsPolicyTopicEntryJson[] }
  }
}

export interface GoogleAdsProductIssueJson {
  errorCode?: string
  adsSeverity?: string
  attributeName?: string
  description?: string
  detail?: string
  documentation?: string
  affectedRegions?: string[]
}
export interface GoogleAdsShoppingProductRow {
  shoppingProduct?: {
    resourceName?: string
    merchantCenterId?: Int64String
    channel?: string
    languageCode?: string
    feedLabel?: string
    itemId?: string
    title?: string
    /** NOT_ELIGIBLE | ELIGIBLE_LIMITED | ELIGIBLE */
    status?: string
    issues?: GoogleAdsProductIssueJson[]
  }
}

export interface GoogleAdsRecommendationSubscriptionRow {
  recommendationSubscription?: { resourceName?: string; type?: string; status?: string; createDateTime?: string; modifyDateTime?: string }
}

/** One day of numbers at a grain below the campaign (ad group, keyword, asset group, product, search term). */
export interface GoogleAdsGrainDayRow {
  campaign?: GoogleAdsRefJson
  adGroup?: GoogleAdsRefJson
  adGroupCriterion?: { criterionId?: Int64String; keyword?: GoogleAdsKeywordInfoJson }
  assetGroup?: GoogleAdsRefJson
  campaignSearchTermView?: { resourceName?: string; searchTerm?: string }
  segments?: { date?: string; productItemId?: string; productTitle?: string }
  metrics?: GoogleAdsMetricsJson
}

export interface GoogleAdsAdGroupRow {
  campaign?: GoogleAdsRefJson
  adGroup?: GoogleAdsRefJson & {
    status?: string
    type?: string
    cpcBidMicros?: Int64String
    targetCpaMicros?: Int64String
    targetRoas?: number
    primaryStatus?: string
    primaryStatusReasons?: string[]
    aiMaxAdGroupSetting?: { disableSearchTermMatching?: boolean }
  }
}

export interface GoogleAdsAdGroupCriterionRow {
  campaign?: GoogleAdsRefJson
  adGroup?: GoogleAdsRefJson
  adGroupCriterion?: {
    resourceName?: string
    criterionId?: Int64String
    negative?: boolean
    status?: string
    type?: string
    keyword?: GoogleAdsKeywordInfoJson
    qualityInfo?: { qualityScore?: number }
    systemServingStatus?: string
    approvalStatus?: string
    primaryStatus?: string
    cpcBidMicros?: Int64String
    effectiveCpcBidMicros?: Int64String
  }
}

export interface GoogleAdsCampaignCriterionRow {
  campaign?: GoogleAdsRefJson
  campaignCriterion?: {
    resourceName?: string
    criterionId?: Int64String
    negative?: boolean
    type?: string
    status?: string
    keyword?: GoogleAdsKeywordInfoJson
    brandList?: { sharedSet?: string }
  }
}

export interface GoogleAdsAssetGroupRow {
  campaign?: GoogleAdsRefJson
  assetGroup?: GoogleAdsRefJson & { status?: string; primaryStatus?: string; primaryStatusReasons?: string[]; adStrength?: string; finalUrls?: string[] }
}

export interface GoogleAdsSharedSetJson { resourceName?: string; id?: Int64String; name?: string; type?: string; status?: string; memberCount?: Int64String }
export interface GoogleAdsSharedCriterionRow {
  sharedCriterion?: { resourceName?: string; sharedSet?: string; criterionId?: Int64String; type?: string; keyword?: GoogleAdsKeywordInfoJson }
  sharedSet?: GoogleAdsSharedSetJson
}
export interface GoogleAdsCampaignSharedSetRow {
  campaign?: GoogleAdsRefJson
  campaignSharedSet?: { resourceName?: string; campaign?: string; sharedSet?: string; status?: string }
  sharedSet?: GoogleAdsSharedSetJson
}

export interface GoogleAdsRecommendationMetricsJson {
  impressions?: number
  clicks?: number
  costMicros?: Int64String
  conversions?: number
  conversionsValue?: number
}
export interface GoogleAdsRecommendationRow {
  recommendation?: {
    resourceName?: string
    type?: string
    campaign?: string
    adGroup?: string
    dismissed?: boolean
    impact?: { baseMetrics?: GoogleAdsRecommendationMetricsJson; potentialMetrics?: GoogleAdsRecommendationMetricsJson }
  }
}

// ── Step 1b: what the mappers make ───────────────────────────────────────────────────────────────────────────────

/** One GoogleAdsReadState row per account and resource: what a 1b step read, and how its last attempt ended. */
export type GoogleAdsReadResource =
  | 'AD_GROUPS' | 'KEYWORDS' | 'CAMPAIGN_NEGATIVES' | 'NEGATIVE_LISTS' | 'ASSET_GROUPS'
  | 'CAMPAIGN_SETTINGS' | 'AD_POLICY' | 'PRODUCT_STATUS' | 'AUTO_APPLY' | 'RECOMMENDATIONS'
  | 'AD_GROUP_DAYS' | 'KEYWORD_DAYS' | 'ASSET_GROUP_DAYS' | 'PRODUCT_DAYS' | 'SEARCH_TERM_DAYS'

export type GoogleAdsDayResource = 'AD_GROUP_DAYS' | 'KEYWORD_DAYS' | 'ASSET_GROUP_DAYS' | 'PRODUCT_DAYS' | 'SEARCH_TERM_DAYS'

/** The grains below the campaign; each keeps its own range of days read in GoogleAdsReadState (the campaign's is on GoogleAdsCustomer). */
export type GoogleAdsDetailEntityType = Exclude<GoogleAdsEntityType, 'CAMPAIGN'>

/** Which read state holds a grain's range of days read. */
export const DAY_RESOURCE_OF: Readonly<Record<GoogleAdsDetailEntityType, GoogleAdsDayResource>> = {
  AD_GROUP: 'AD_GROUP_DAYS',
  KEYWORD: 'KEYWORD_DAYS',
  ASSET_GROUP: 'ASSET_GROUP_DAYS',
  PRODUCT: 'PRODUCT_DAYS',
  SEARCH_TERM: 'SEARCH_TERM_DAYS',
}

export type GoogleAdsReadStatus = 'SUCCESS' | 'FAILED' | 'SKIPPED_BUDGET'

/** GoogleAdsCampaign's settings columns (step 1b). Every value is as Google sent it; a flag Google left out is false. */
export interface GoogleAdsCampaignFlagsData {
  campaignId: string
  aiMaxEnabled: boolean
  keywordMatchType: string | null
  broadMatchMigratedAt: Date | null
  targetGoogleSearch: boolean
  targetSearchNetwork: boolean
  targetContentNetwork: boolean
  targetPartnerSearchNetwork: boolean
  /** [{ assetAutomationType, assetAutomationStatus }] as sent ([] = Google listed none: every type has its default); null = not read. */
  assetAutomation: Array<{ assetAutomationType: string; assetAutomationStatus: string | null }> | null
  dsaDomain: string | null
}

/** A GoogleAdsAdGroup row without the business, its id, firstSeenAt / lastSeenAt / removedAt and timestamps. */
export interface GoogleAdsAdGroupData {
  customerId: string
  campaignId: string
  adGroupId: string
  name: string
  status: string
  type: string | null
  primaryStatus: string | null
  primaryStatusReasons: string[]
  cpcBidMicros: bigint | null
  targetCpaMicros: bigint | null
  /** Decimal(10,4) as text. */
  targetRoas: string | null
  searchTermMatchingDisabled: boolean | null
}

export interface GoogleAdsAssetGroupData {
  customerId: string
  campaignId: string
  assetGroupId: string
  name: string
  status: string
  primaryStatus: string | null
  primaryStatusReasons: string[]
  adStrength: string | null
  finalUrls: string[]
}

export type GoogleAdsKeywordLevel = 'AD_GROUP' | 'CAMPAIGN' | 'LIST'

/** A GoogleAdsKeyword row: an ad group's keyword or negative, a campaign's negative or brand list, a list's keyword. */
export interface GoogleAdsKeywordData {
  customerId: string
  level: GoogleAdsKeywordLevel
  /** ag:<adGroupId> | c:<campaignId> | l:<sharedSetId> */
  parentKey: string
  criterionId: string
  campaignId: string | null
  adGroupId: string | null
  sharedSetId: string | null
  negative: boolean
  criterionType: 'KEYWORD' | 'BRAND_LIST'
  text: string | null
  matchType: string | null
  status: string | null
  cpcBidMicros: bigint | null
  effectiveCpcBidMicros: bigint | null
  qualityScore: number | null
  systemServingStatus: string | null
  approvalStatus: string | null
  primaryStatus: string | null
}

export interface GoogleAdsNegativeListData {
  customerId: string
  sharedSetId: string
  /** Null when this read did not get the list's details (the store keeps what it had). */
  name: string | null
  status: string | null
  memberCount: number | null
  campaignIds: string[]
}

export interface GoogleAdsSharedSetData {
  sharedSetId: string
  name: string | null
  type: string | null
  status: string | null
  memberCount: number | null
}

export type GoogleAdsPolicyKind = 'AD' | 'PRODUCT'

/** A GoogleAdsPolicyIssue row without the business, its id, firstSeenAt / lastSeenAt / resolvedAt and timestamps. */
export interface GoogleAdsPolicyIssueData {
  customerId: string
  kind: GoogleAdsPolicyKind
  entityKey: string
  campaignId: string | null
  adGroupId: string | null
  adId: string | null
  adType: string | null
  itemId: string | null
  label: string | null
  status: string
  reviewStatus: string | null
  reasons: string[]
  /** PRODUCT: Google's issues as sent; left out for an ad (a nullable Json column takes no plain null). */
  issues?: Prisma.InputJsonArray
}

export interface GoogleAdsRecommendationData {
  customerId: string
  resourceName: string
  type: string
  campaignId: string | null
  adGroupId: string | null
  dismissed: boolean
  /** { base, potential } as Google sent them (micros as strings); left out when not read or not sent. */
  impact?: Prisma.InputJsonObject
}

export interface GoogleAdsAutoApplyData {
  customerId: string
  type: string
  status: string
  createdAtGoogle: Date | null
  modifiedAtGoogle: Date | null
}
