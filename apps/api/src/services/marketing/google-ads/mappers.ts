/**
 * Google Ads step 1a — Google's REST answer → GoogleAds* table data. Pure.
 *
 *   int64        arrives as a string → BigInt (or a number for counts); a field Google left out is 0
 *   money        cost and budgets are micros already; conversions_value is a DOUBLE in currency units → micros
 *   conversions  fractional (data-driven attribution) → Decimal(14,4) as text
 *   dates        segments.date / start_date_time / end_date_time are the account's days → UTC midnight
 *   changes      change_date_time is the account's wall clock → an instant; client_type → one of five sources
 *                with a plain sentence (PLAN.md L16). The person's e-mail is kept for the table only.
 */
import { dayToDate, zonedToUtc } from './dates.js'
import type {
  GoogleAdsCampaignData, GoogleAdsCampaignDayRow, GoogleAdsCampaignRow, GoogleAdsCampaignStatus, GoogleAdsChangeEventData,
  GoogleAdsChangeEventRow, GoogleAdsChangeSource, GoogleAdsCustomerClientData, GoogleAdsCustomerClientRow,
  GoogleAdsCustomerData, GoogleAdsCustomerJson, GoogleAdsCustomerRow, GoogleAdsDailyMetricData,
} from './types.js'
import type { Prisma } from '@prisma/client'

// ── numbers ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** An int64 from Google's JSON (a string, sometimes a number); missing or unreadable = 0. */
export function int64(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return Number.isFinite(value) ? BigInt(Math.trunc(value)) : 0n
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return BigInt(value.trim())
  return 0n
}

/** An int64 that may be absent, kept absent (a target CPA nobody set is not a zero target). */
export const int64OrNull = (value: unknown): bigint | null => (value === undefined || value === null || value === '' ? null : int64(value))

/** A count (impressions, clicks): an int64 that fits a number. */
export const count = (value: unknown): number => Number(int64(value))

/** A double; missing or unreadable = 0. */
export function double(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0
  return Number.isFinite(n) ? n : 0
}

/** Currency units (a double) → micros of the same currency: 12.34 → 12,340,000. */
export const unitsToMicros = (units: unknown): bigint => BigInt(Math.round(double(units) * 1_000_000))

/** A fractional count as Decimal(14,4) text: 2.5 → "2.5000". */
export const decimal4 = (value: unknown): string => double(value).toFixed(4)

/** An id from a resource name: "customers/1/campaigns/22" → "22"; null when there is none. */
export function idFromResourceName(resourceName: unknown): string | null {
  if (typeof resourceName !== 'string' || !resourceName) return null
  const last = resourceName.split('/').pop() ?? ''
  return /^\d+$/.test(last) ? last : null
}

/** A customer id as Google expects it in a URL and a header: digits only ("123-456-7890" → "1234567890"). */
export function customerIdDigits(value: unknown): string | null {
  const digits = String(value ?? '').replace(/-/g, '').trim()
  return /^\d{1,20}$/.test(digits) ? digits : null
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null)

/** "yyyy-MM-dd[ HH:mm:ss]" (an account day) → UTC midnight of that day. */
function accountDay(value: unknown): Date | null {
  const day = typeof value === 'string' ? value.trim().slice(0, 10) : ''
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? dayToDate(day) : null
}

// ── statuses and types ───────────────────────────────────────────────────────────────────────────────────────────

const CAMPAIGN_STATUSES = new Set(['ENABLED', 'PAUSED', 'REMOVED'])
/** Google's campaign.status; anything else Google may send (UNKNOWN, a new value) is UNKNOWN, never ENABLED. */
export const campaignStatus = (value: unknown): GoogleAdsCampaignStatus =>
  typeof value === 'string' && CAMPAIGN_STATUSES.has(value) ? value as GoogleAdsCampaignStatus : 'UNKNOWN'

const CUSTOMER_STATUSES = new Set(['ENABLED', 'CANCELED', 'SUSPENDED', 'CLOSED'])
export const customerStatus = (value: unknown): string => (typeof value === 'string' && CUSTOMER_STATUSES.has(value) ? value : 'UNKNOWN')

/** advertising_channel_type in words. */
export const CAMPAIGN_TYPE_TEXT: Readonly<Record<string, string>> = {
  SEARCH: 'Search',
  PERFORMANCE_MAX: 'Performance Max',
  SHOPPING: 'Shopping',
  DISPLAY: 'Display',
  VIDEO: 'Video',
  DEMAND_GEN: 'Demand Gen',
  MULTI_CHANNEL: 'App',
  SMART: 'Smart',
  HOTEL: 'Hotel',
  LOCAL: 'Local',
  LOCAL_SERVICES: 'Local Services',
  TRAVEL: 'Travel',
}
export const campaignTypeText = (channelType: unknown): string =>
  (typeof channelType === 'string' && CAMPAIGN_TYPE_TEXT[channelType]) || 'Other'

/** campaign.status in words. */
export const CAMPAIGN_STATUS_TEXT: Readonly<Record<GoogleAdsCampaignStatus, string>> = {
  ENABLED: 'Enabled', PAUSED: 'Paused', REMOVED: 'Removed', UNKNOWN: 'Unknown',
}

// ── rows ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function customerData(json: GoogleAdsCustomerJson | undefined): GoogleAdsCustomerData | null {
  const customerId = customerIdDigits(json?.id)
  if (!json || !customerId) return null
  return {
    customerId,
    descriptiveName: text(json.descriptiveName),
    currencyCode: text(json.currencyCode) ?? '',
    timeZone: text(json.timeZone) ?? '',
    manager: json.manager === true,
    testAccount: json.testAccount === true,
    status: customerStatus(json.status),
  }
}

/** The `customer` query's single row. Null when Google sent no usable row. */
export const mapCustomer = (row: GoogleAdsCustomerRow | undefined): GoogleAdsCustomerData | null => customerData(row?.customer)

/** One `customer_client` row (a manager's own row is level 0). */
export function mapCustomerClient(row: GoogleAdsCustomerClientRow): GoogleAdsCustomerClientData | null {
  const json = row.customerClient
  const base = customerData(json ? { ...json, id: json.id ?? idFromResourceName(json.clientCustomer) ?? undefined } : undefined)
  return base ? { ...base, level: count(json?.level) } : null
}

/** One campaign row with its budget. Null when the row has no campaign id. */
export function mapCampaign(row: GoogleAdsCampaignRow, context: { customerId: string; currencyCode: string }): GoogleAdsCampaignData | null {
  const campaign = row.campaign
  const campaignId = campaign ? (int64OrNull(campaign.id)?.toString() ?? idFromResourceName(campaign.resourceName)) : null
  if (!campaign || !campaignId) return null
  const budget = row.campaignBudget
  const roas = campaign.targetRoas?.targetRoas ?? campaign.maximizeConversionValue?.targetRoas
  const budgetId = budget ? (int64OrNull(budget.id)?.toString() ?? idFromResourceName(budget.resourceName)) : null
  const merchantId = int64OrNull(campaign.shoppingSetting?.merchantId)
  return {
    customerId: context.customerId,
    campaignId,
    name: text(campaign.name) ?? '',
    status: campaignStatus(campaign.status),
    servingStatus: text(campaign.servingStatus),
    primaryStatus: text(campaign.primaryStatus),
    primaryStatusReasons: Array.isArray(campaign.primaryStatusReasons) ? campaign.primaryStatusReasons.filter((r) => typeof r === 'string') : [],
    channelType: text(campaign.advertisingChannelType) ?? 'UNKNOWN',
    channelSubType: text(campaign.advertisingChannelSubType),
    biddingStrategyType: text(campaign.biddingStrategyType),
    portfolioBiddingStrategy: text(campaign.biddingStrategy),
    targetCpaMicros: int64OrNull(campaign.targetCpa?.targetCpaMicros ?? campaign.maximizeConversions?.targetCpaMicros),
    targetRoas: roas === undefined || roas === null ? null : decimal4(roas),
    budgetId,
    budgetAmountMicros: budget ? int64OrNull(budget.amountMicros) : null,
    budgetDeliveryMethod: text(budget?.deliveryMethod),
    budgetPeriod: text(budget?.period),
    budgetShared: budget?.explicitlyShared === true,
    merchantId: merchantId === null ? null : merchantId.toString(),
    feedLabel: text(campaign.shoppingSetting?.feedLabel),
    startDate: accountDay(campaign.startDateTime),
    endDate: accountDay(campaign.endDateTime),
    currencyCode: context.currencyCode,
  }
}

/**
 * One campaign-day of numbers. Every number Google left out is 0 (Google omits zeros); a row without a campaign id
 * or a day is not a row (null).
 */
export function mapCampaignDay(row: GoogleAdsCampaignDayRow, context: { customerId: string; currencyCode: string }): GoogleAdsDailyMetricData | null {
  const campaignId = row.campaign ? (int64OrNull(row.campaign.id)?.toString() ?? idFromResourceName(row.campaign.resourceName)) : null
  const date = accountDay(row.segments?.date)
  if (!campaignId || !date) return null
  const m = row.metrics ?? {}
  return {
    customerId: context.customerId,
    date,
    entityType: 'CAMPAIGN',
    entityId: campaignId,
    campaignId,
    adGroupId: null,
    label: text(row.campaign?.name),
    impressions: count(m.impressions),
    clicks: count(m.clicks),
    costMicros: int64(m.costMicros),
    conversions: decimal4(m.conversions),
    conversionsValueMicros: unitsToMicros(m.conversionsValue),
    allConversions: decimal4(m.allConversions),
    allConversionsValueMicros: unitsToMicros(m.allConversionsValue),
    currencyCode: context.currencyCode,
  }
}

// ── change history ───────────────────────────────────────────────────────────────────────────────────────────────

interface SourceOfClient { source: GoogleAdsChangeSource; sentence: string }

/** change_event.client_type → where the change was made (v25 ChangeClientType values). */
const CLIENT_SOURCES: Readonly<Record<string, SourceOfClient>> = {
  GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION: { source: 'google_automatic', sentence: 'Google applied one of its recommendations automatically (auto-apply is on).' },
  GOOGLE_ADS_RECOMMENDATIONS: { source: 'google_automatic', sentence: 'A Google recommendation was applied.' },
  GOOGLE_ADS_AUTOMATED_RULE: { source: 'google_automatic', sentence: 'An automated rule in Google Ads made this change.' },
  GOOGLE_ADS_SCRIPTS: { source: 'google_automatic', sentence: 'A Google Ads script made this change.' },
  INTERNAL_TOOL: { source: 'google_automatic', sentence: 'Google made this change with its own tools.' },
  GOOGLE_ADS_WEB_CLIENT: { source: 'google_ads_web', sentence: 'Someone made this change on the Google Ads website.' },
  GOOGLE_ADS_BULK_UPLOAD: { source: 'google_ads_web', sentence: 'Someone made this change with a bulk upload on the Google Ads website.' },
  GOOGLE_ADS_EDITOR: { source: 'google_ads_editor', sentence: 'Someone made this change in Google Ads Editor.' },
  GOOGLE_ADS_API: { source: 'api', sentence: 'A program made this change through the Google Ads API.' },
  GOOGLE_ADS_MOBILE_APP: { source: 'other', sentence: 'Someone made this change in the Google Ads mobile app.' },
  SEARCH_ADS_360_SYNC: { source: 'other', sentence: 'Search Ads 360 made this change.' },
  SEARCH_ADS_360_POST: { source: 'other', sentence: 'Search Ads 360 made this change.' },
}

/** The words the campaign modal shows for each source. */
export const CHANGE_SOURCE_TEXT: Readonly<Record<GoogleAdsChangeSource, string>> = {
  google_automatic: 'Google, automatically',
  google_ads_web: 'Google Ads website',
  google_ads_editor: 'Google Ads Editor',
  api: 'Google Ads API',
  other: 'Other',
}

/** Where a change was made: the source, its words and a sentence. OTHER / UNKNOWN / a new value → "Other". */
export function changeSourceOf(clientType: unknown): { source: GoogleAdsChangeSource; sourceText: string; sentence: string } {
  const known = typeof clientType === 'string' ? CLIENT_SOURCES[clientType] : undefined
  const { source, sentence } = known ?? { source: 'other' as const, sentence: 'Google did not say where this change was made.' }
  return { source, sourceText: CHANGE_SOURCE_TEXT[source], sentence }
}

/** "campaignBudget.amountMicros" → "campaign_budget.amount_micros". */
const snake = (path: string): string => path.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

/** A FieldMask (one comma-separated string in JSON, or a { paths } object) → snake_case paths. */
export function fieldMaskPaths(mask: unknown): string[] {
  const raw = typeof mask === 'string'
    ? mask.split(',')
    : mask && typeof mask === 'object' && Array.isArray((mask as { paths?: unknown }).paths) ? (mask as { paths: unknown[] }).paths : []
  return raw.filter((p): p is string => typeof p === 'string').map((p) => snake(p.trim())).filter(Boolean)
}

const jsonObject = (value: unknown): Prisma.InputJsonObject | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Prisma.InputJsonObject : undefined

/**
 * One change_event row. `changedAt` is the account's wall clock turned into an instant (the account's time zone is
 * needed for that). Null when Google sent no resource name or no time.
 */
export function mapChangeEvent(row: GoogleAdsChangeEventRow, context: { customerId: string; timeZone: string }): GoogleAdsChangeEventData | null {
  const event = row.changeEvent
  const resourceName = text(event?.resourceName)
  const at = text(event?.changeDateTime)
  if (!event || !resourceName || !at) return null
  const data: GoogleAdsChangeEventData = {
    customerId: context.customerId,
    resourceName,
    changedAt: zonedToUtc(at, context.timeZone),
    resourceType: text(event.changeResourceType) ?? 'UNKNOWN',
    changeResourceName: text(event.changeResourceName) ?? '',
    operation: text(event.resourceChangeOperation) ?? 'UNKNOWN',
    clientType: text(event.clientType),
    userEmail: text(event.userEmail),
    changedFields: fieldMaskPaths(event.changedFields),
    campaignId: idFromResourceName(event.campaign),
    adGroupId: idFromResourceName(event.adGroup),
  }
  const oldResource = jsonObject(event.oldResource)
  const newResource = jsonObject(event.newResource)
  if (oldResource) data.oldResource = oldResource
  if (newResource) data.newResource = newResource
  return data
}
