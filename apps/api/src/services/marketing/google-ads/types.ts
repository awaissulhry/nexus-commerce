/**
 * Google Ads step 1a — the shapes of the read: what Google's REST answer looks like (camelCase, int64 as strings,
 * zero / default fields left out) and what the mappers make of it for the GoogleAds* tables.
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
