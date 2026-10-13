/**
 * Google Ads steps 1a and 1b — Google's REST answer → GoogleAds* table data. Pure.
 *
 *   int64        arrives as a string → BigInt (or a number for counts); a field Google left out is 0
 *   money        cost and budgets are micros already; conversions_value is a DOUBLE in currency units → micros
 *   conversions  fractional (data-driven attribution) → Decimal(14,4) as text
 *   dates        segments.date / start_date_time / end_date_time are the account's days → UTC midnight
 *   changes      change_date_time is the account's wall clock → an instant; client_type → one of five sources
 *                with a plain sentence (PLAN.md L16). The person's e-mail is kept for the table only.
 */
import { createHash } from 'node:crypto'
import { dayToDate, zonedToUtc } from './dates.js'
import type {
  GoogleAdsAdGroupCriterionRow, GoogleAdsAdGroupData, GoogleAdsAdGroupRow, GoogleAdsAdPolicyRow, GoogleAdsAssetGroupData, GoogleAdsAssetGroupRow,
  GoogleAdsAutoApplyData, GoogleAdsCampaignCriterionRow, GoogleAdsCampaignData, GoogleAdsCampaignDayRow, GoogleAdsCampaignFlagsData,
  GoogleAdsCampaignFlagsRow, GoogleAdsCampaignRow, GoogleAdsCampaignSharedSetRow, GoogleAdsCampaignStatus, GoogleAdsChangeEventData,
  GoogleAdsChangeEventRow, GoogleAdsChangeSource, GoogleAdsCustomerClientData, GoogleAdsCustomerClientRow, GoogleAdsCustomerData,
  GoogleAdsCustomerJson, GoogleAdsCustomerNegativeCriterionRow, GoogleAdsCustomerRow, GoogleAdsDailyMetricData, GoogleAdsDetailEntityType, GoogleAdsGrainDayRow, GoogleAdsKeywordData,
  GoogleAdsMetricsJson, GoogleAdsPolicyIssueData, GoogleAdsRecommendationData, GoogleAdsRecommendationMetricsJson, GoogleAdsRecommendationRow,
  GoogleAdsRecommendationSubscriptionRow, GoogleAdsRefJson, GoogleAdsSharedCriterionRow, GoogleAdsSharedSetData, GoogleAdsSharedSetJson,
  GoogleAdsShoppingProductRow,
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

// ── step 1b: helpers ─────────────────────────────────────────────────────────────────────────────────────────────

/** The id of a resource seen through another row (`campaign.id`, else the id at the end of its resource name). */
export const idOf = (ref: GoogleAdsRefJson | undefined | null): string | null =>
  ref ? (int64OrNull(ref.id)?.toString() ?? idFromResourceName(ref.resourceName)) : null

/** "customers/1/adGroupCriteria/22~333" → "333": the part after the last "~" of a composite resource name. */
function lastCompositePart(resourceName: unknown): string | null {
  if (typeof resourceName !== 'string') return null
  const last = (resourceName.split('/').pop() ?? '').split('~').pop() ?? ''
  return /^\d+$/.test(last) ? last : null
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : []

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** An enum Google may send as UNSPECIFIED / UNKNOWN: those are "nothing said" (null). */
const enumText = (value: unknown): string | null => {
  const t = text(value)
  return t && t !== 'UNSPECIFIED' && t !== 'UNKNOWN' ? t : null
}

const MATCH_TYPES = new Set(['EXACT', 'PHRASE', 'BROAD'])
const matchTypeOf = (value: unknown): string | null => (typeof value === 'string' && MATCH_TYPES.has(value) ? value : null)

/** Google's wall clock in the account's time zone → an instant; null when absent or unreadable. */
function accountInstant(value: unknown, timeZone: string): Date | null {
  const t = text(value)
  if (!t) return null
  try {
    return zonedToUtc(t, timeZone)
  } catch {
    return null
  }
}

/** A Decimal(14,4) text in ten-thousandths, exactly (no float). */
function decimal4Units(value: string | null | undefined): bigint {
  const match = typeof value === 'string' ? /^(-?)(\d+)(?:\.(\d*))?$/.exec(value.trim()) : null
  if (!match) return 0n
  const units = BigInt(match[2]) * 10_000n + BigInt((match[3] ?? '').slice(0, 4).padEnd(4, '0'))
  return match[1] ? -units : units
}
function unitsToDecimal4(units: bigint): string {
  const negative = units < 0n
  const abs = negative ? -units : units
  return `${negative ? '-' : ''}${abs / 10_000n}.${(abs % 10_000n).toString().padStart(4, '0')}`
}
/** "2.5000" + "1.2500" = "3.7500", exactly. */
export const addDecimal4 = (a: string, b: string): string => unitsToDecimal4(decimal4Units(a) + decimal4Units(b))

/**
 * Two rows of numbers on the same entity and day, summed (a search term read under two spellings, a product under two
 * titles). The first row's label stays unless it has none.
 */
export function addDailyRows(a: GoogleAdsDailyMetricData, b: GoogleAdsDailyMetricData): GoogleAdsDailyMetricData {
  const bothNull = a.allConversions === null && b.allConversions === null
  const valueNull = a.allConversionsValueMicros === null && b.allConversionsValueMicros === null
  return {
    ...a,
    label: a.label ?? b.label,
    impressions: a.impressions + b.impressions,
    clicks: a.clicks + b.clicks,
    costMicros: a.costMicros + b.costMicros,
    conversions: addDecimal4(a.conversions, b.conversions),
    conversionsValueMicros: a.conversionsValueMicros + b.conversionsValueMicros,
    allConversions: bothNull ? null : addDecimal4(a.allConversions ?? '0', b.allConversions ?? '0'),
    allConversionsValueMicros: valueNull ? null : (a.allConversionsValueMicros ?? 0n) + (b.allConversionsValueMicros ?? 0n),
  }
}

// ── step 1b: daily numbers below the campaign ────────────────────────────────────────────────────────────────────

/** How long the hash of a search term in its daily key is (hex characters of its SHA-256). */
export const SEARCH_TERM_HASH_LENGTH = 24

/** A search term as Nexus keys it: Unicode-normalised, lower case, single spaces, trimmed. Null when nothing is left. */
export function normalizeSearchTerm(term: unknown): string | null {
  if (typeof term !== 'string') return null
  const normalized = term.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
  return normalized || null
}

/** SEARCH_TERM daily key: `<campaignId>~<first 24 hex of sha256(normalized term)>`. The term itself is the row's label. */
export function searchTermKey(campaignId: string, term: string): string {
  const normalized = normalizeSearchTerm(term) ?? ''
  return `${campaignId}~${createHash('sha256').update(normalized).digest('hex').slice(0, SEARCH_TERM_HASH_LENGTH)}`
}

/** KEYWORD daily key: a criterion id is unique only within its ad group. */
export const keywordDayKey = (adGroupId: string, criterionId: string): string => `${adGroupId}~${criterionId}`

/**
 * A Merchant Center item id as Nexus keys it: lower case. Google does not document the case of
 * segments.product_item_id or shopping_product.item_id, so both are lower-cased and a match never depends on it.
 */
export const productItemKey = (itemId: string): string => itemId.trim().toLowerCase()

/** PRODUCT daily key: `<campaignId>~<item id, lower case>`. */
export const productDayKey = (campaignId: string, itemId: string): string => `${campaignId}~${productItemKey(itemId)}`

function metricsOf(m: GoogleAdsMetricsJson | undefined) {
  const metrics = m ?? {}
  return {
    impressions: count(metrics.impressions),
    clicks: count(metrics.clicks),
    costMicros: int64(metrics.costMicros),
    conversions: decimal4(metrics.conversions),
    conversionsValueMicros: unitsToMicros(metrics.conversionsValue),
    allConversions: decimal4(metrics.allConversions),
    allConversionsValueMicros: unitsToMicros(metrics.allConversionsValue),
  }
}

/**
 * One day of numbers at a grain below the campaign. Every number Google left out is 0. A row without its campaign, its
 * day or its own id is not a row (null); a search term without a click is not kept (Nexus reads terms with clicks).
 */
export function mapGrainDay(
  entityType: GoogleAdsDetailEntityType,
  row: GoogleAdsGrainDayRow,
  context: { customerId: string; currencyCode: string },
): GoogleAdsDailyMetricData | null {
  const campaignId = idOf(row.campaign)
  const date = accountDay(row.segments?.date)
  if (!campaignId || !date) return null
  let entityId: string | null = null
  let adGroupId: string | null = null
  let label: string | null = null
  switch (entityType) {
    case 'AD_GROUP':
      adGroupId = idOf(row.adGroup)
      entityId = adGroupId
      label = text(row.adGroup?.name)
      break
    case 'KEYWORD': {
      adGroupId = idOf(row.adGroup)
      const criterionId = int64OrNull(row.adGroupCriterion?.criterionId)?.toString() ?? null
      entityId = adGroupId && criterionId ? keywordDayKey(adGroupId, criterionId) : null
      label = text(row.adGroupCriterion?.keyword?.text)
      break
    }
    case 'ASSET_GROUP':
      entityId = idOf(row.assetGroup)
      label = text(row.assetGroup?.name)
      break
    case 'PRODUCT': {
      const itemId = text(row.segments?.productItemId)
      entityId = itemId ? productDayKey(campaignId, itemId) : null
      label = text(row.segments?.productTitle)
      break
    }
    case 'SEARCH_TERM': {
      const term = normalizeSearchTerm(row.campaignSearchTermView?.searchTerm)
      if (!term || count(row.metrics?.clicks) <= 0) return null
      entityId = searchTermKey(campaignId, term)
      label = term
      break
    }
  }
  if (!entityId) return null
  return { customerId: context.customerId, date, entityType, entityId, campaignId, adGroupId, label, ...metricsOf(row.metrics), currencyCode: context.currencyCode }
}

// ── step 1b: safety (tier 2) ─────────────────────────────────────────────────────────────────────────────────────

/**
 * One campaign's settings by which Google acts on its own. A flag Google left out is false (proto3 leaves out a false);
 * `assetAutomation` is null when it was not read (the query without it), [] when Google listed no entry.
 */
export function mapCampaignFlags(row: GoogleAdsCampaignFlagsRow, context: { timeZone: string; assetAutomationRead: boolean }): GoogleAdsCampaignFlagsData | null {
  const campaign = row.campaign
  const campaignId = idOf(campaign)
  if (!campaign || !campaignId) return null
  const settings = Array.isArray(campaign.assetAutomationSettings) ? campaign.assetAutomationSettings.filter(isObject) : []
  const network = campaign.networkSettings ?? {}
  return {
    campaignId,
    aiMaxEnabled: campaign.aiMaxSetting?.enableAiMax === true,
    keywordMatchType: enumText(campaign.keywordMatchType),
    broadMatchMigratedAt: accountInstant(campaign.broadMatchMigrationDateTime, context.timeZone),
    targetGoogleSearch: network.targetGoogleSearch === true,
    targetSearchNetwork: network.targetSearchNetwork === true,
    targetContentNetwork: network.targetContentNetwork === true,
    targetPartnerSearchNetwork: network.targetPartnerSearchNetwork === true,
    assetAutomation: context.assetAutomationRead
      ? settings
        .map((s) => ({ assetAutomationType: enumText(s.assetAutomationType), assetAutomationStatus: enumText(s.assetAutomationStatus) }))
        .filter((s): s is { assetAutomationType: string; assetAutomationStatus: string | null } => s.assetAutomationType !== null)
      : null,
    dsaDomain: text(campaign.dynamicSearchAdsSetting?.domainName),
  }
}

/** The approvals Nexus keeps as an ad issue; an approved ad (or one under review) is none. */
export const AD_ISSUE_STATUSES: ReadonlySet<string> = new Set(['DISAPPROVED', 'APPROVED_LIMITED', 'AREA_OF_INTEREST_ONLY'])

/** One ad's approval: an issue when Google disapproved or limited it, else null. */
export function mapAdPolicyIssue(row: GoogleAdsAdPolicyRow, context: { customerId: string }): GoogleAdsPolicyIssueData | null {
  const ad = row.adGroupAd
  const status = text(ad?.policySummary?.approvalStatus)
  if (!ad || !status || !AD_ISSUE_STATUSES.has(status)) return null
  const adGroupId = idOf(row.adGroup)
  const adId = int64OrNull(ad.ad?.id)?.toString() ?? lastCompositePart(ad.resourceName)
  if (!adGroupId || !adId) return null
  const topics = (ad.policySummary?.policyTopicEntries ?? []).map((entry) => text(entry?.topic)).filter((t): t is string => !!t)
  return {
    customerId: context.customerId,
    kind: 'AD',
    entityKey: `${adGroupId}~${adId}`,
    campaignId: idOf(row.campaign),
    adGroupId,
    adId,
    adType: enumText(ad.ad?.type),
    itemId: null,
    label: null,
    status,
    reviewStatus: enumText(ad.policySummary?.reviewStatus),
    reasons: [...new Set(topics)],
  }
}

/** The product statuses Nexus keeps as a product issue. */
export const PRODUCT_ISSUE_STATUSES: ReadonlySet<string> = new Set(['NOT_ELIGIBLE', 'ELIGIBLE_LIMITED'])

const PRODUCT_ISSUE_KEYS = ['errorCode', 'adsSeverity', 'attributeName', 'description', 'detail', 'documentation'] as const

/** One product's status: an issue when it is not eligible or limited, else null. Its item id is kept in lower case. */
export function mapShoppingProductIssue(row: GoogleAdsShoppingProductRow, context: { customerId: string }): GoogleAdsPolicyIssueData | null {
  const product = row.shoppingProduct
  const status = text(product?.status)
  const rawItemId = text(product?.itemId)
  if (!product || !status || !PRODUCT_ISSUE_STATUSES.has(status) || !rawItemId) return null
  const itemId = productItemKey(rawItemId)
  const merchant = int64OrNull(product.merchantCenterId)?.toString() ?? ''
  const issues = (Array.isArray(product.issues) ? product.issues.filter(isObject) : []).map((issue) => {
    const out: Record<string, string | string[]> = {}
    for (const key of PRODUCT_ISSUE_KEYS) {
      const value = text(issue[key])
      if (value) out[key] = value
    }
    out.affectedRegions = strings(issue.affectedRegions)
    return out
  })
  return {
    customerId: context.customerId,
    kind: 'PRODUCT',
    entityKey: [merchant, text(product.channel) ?? '', text(product.languageCode) ?? '', text(product.feedLabel) ?? '', itemId].join('~'),
    campaignId: null,
    adGroupId: null,
    adId: null,
    adType: null,
    itemId,
    label: text(product.title),
    status,
    reviewStatus: null,
    reasons: [],
    issues,
  }
}

/** One auto-apply setting (a recommendation type Google applies by itself while ENABLED). */
export function mapAutoApply(row: GoogleAdsRecommendationSubscriptionRow, context: { customerId: string; timeZone: string }): GoogleAdsAutoApplyData | null {
  const subscription = row.recommendationSubscription
  const type = enumText(subscription?.type)
  if (!subscription || !type) return null
  return {
    customerId: context.customerId,
    type,
    status: enumText(subscription.status) ?? 'UNKNOWN',
    createdAtGoogle: accountInstant(subscription.createDateTime, context.timeZone),
    modifiedAtGoogle: accountInstant(subscription.modifyDateTime, context.timeZone),
  }
}

// ── step 1b: structure (tier 4) ──────────────────────────────────────────────────────────────────────────────────

export function mapAdGroup(row: GoogleAdsAdGroupRow, context: { customerId: string }): GoogleAdsAdGroupData | null {
  const group = row.adGroup
  const campaignId = idOf(row.campaign)
  const adGroupId = idOf(group)
  if (!group || !campaignId || !adGroupId) return null
  return {
    customerId: context.customerId,
    campaignId,
    adGroupId,
    name: text(group.name) ?? '',
    status: campaignStatus(group.status),
    type: enumText(group.type),
    primaryStatus: enumText(group.primaryStatus),
    primaryStatusReasons: strings(group.primaryStatusReasons),
    cpcBidMicros: int64OrNull(group.cpcBidMicros),
    targetCpaMicros: int64OrNull(group.targetCpaMicros),
    targetRoas: group.targetRoas === undefined || group.targetRoas === null ? null : decimal4(group.targetRoas),
    // Read with the query: left out = false (an ad group of a campaign without AI Max has the default too).
    searchTermMatchingDisabled: group.aiMaxAdGroupSetting?.disableSearchTermMatching === true,
  }
}

const NO_BIDS = { cpcBidMicros: null, effectiveCpcBidMicros: null, qualityScore: null, systemServingStatus: null, approvalStatus: null, primaryStatus: null }

/** One ad group keyword or ad-group negative keyword. */
export function mapAdGroupKeyword(row: GoogleAdsAdGroupCriterionRow, context: { customerId: string }): GoogleAdsKeywordData | null {
  const criterion = row.adGroupCriterion
  const adGroupId = idOf(row.adGroup)
  const criterionId = int64OrNull(criterion?.criterionId)?.toString() ?? lastCompositePart(criterion?.resourceName)
  if (!criterion || !adGroupId || !criterionId) return null
  if (criterion.type !== undefined && criterion.type !== 'KEYWORD') return null
  const negative = criterion.negative === true
  const score = criterion.qualityInfo?.qualityScore
  return {
    customerId: context.customerId,
    level: 'AD_GROUP',
    parentKey: `ag:${adGroupId}`,
    criterionId,
    campaignId: idOf(row.campaign),
    adGroupId,
    sharedSetId: null,
    negative,
    criterionType: 'KEYWORD',
    text: text(criterion.keyword?.text),
    matchType: matchTypeOf(criterion.keyword?.matchType),
    status: campaignStatus(criterion.status),
    ...(negative ? NO_BIDS : {
      cpcBidMicros: int64OrNull(criterion.cpcBidMicros),
      effectiveCpcBidMicros: int64OrNull(criterion.effectiveCpcBidMicros),
      qualityScore: typeof score === 'number' && Number.isInteger(score) && score >= 1 && score <= 10 ? score : null,
      systemServingStatus: enumText(criterion.systemServingStatus),
      approvalStatus: enumText(criterion.approvalStatus),
      primaryStatus: enumText(criterion.primaryStatus),
    }),
  }
}

/** One campaign negative keyword or brand exclusion list. */
export function mapCampaignNegative(row: GoogleAdsCampaignCriterionRow, context: { customerId: string }): GoogleAdsKeywordData | null {
  const criterion = row.campaignCriterion
  const campaignId = idOf(row.campaign)
  const criterionId = int64OrNull(criterion?.criterionId)?.toString() ?? lastCompositePart(criterion?.resourceName)
  if (!criterion || !campaignId || !criterionId) return null
  const type = criterion.type === 'BRAND_LIST' ? 'BRAND_LIST'
    : criterion.type === 'KEYWORD' || (criterion.type === undefined && text(criterion.keyword?.text)) ? 'KEYWORD' : null
  if (!type) return null
  return {
    customerId: context.customerId,
    level: 'CAMPAIGN',
    parentKey: `c:${campaignId}`,
    criterionId,
    campaignId,
    adGroupId: null,
    sharedSetId: null,
    negative: criterion.negative === true,
    criterionType: type,
    text: type === 'KEYWORD' ? text(criterion.keyword?.text) : null,
    matchType: type === 'KEYWORD' ? matchTypeOf(criterion.keyword?.matchType) : null,
    status: campaignStatus(criterion.status),
    ...NO_BIDS,
  }
}

export function mapAssetGroup(row: GoogleAdsAssetGroupRow, context: { customerId: string }): GoogleAdsAssetGroupData | null {
  const group = row.assetGroup
  const campaignId = idOf(row.campaign)
  const assetGroupId = idOf(group)
  if (!group || !campaignId || !assetGroupId) return null
  return {
    customerId: context.customerId,
    campaignId,
    assetGroupId,
    name: text(group.name) ?? '',
    status: campaignStatus(group.status),
    primaryStatus: enumText(group.primaryStatus),
    primaryStatusReasons: strings(group.primaryStatusReasons),
    adStrength: enumText(group.adStrength),
    finalUrls: strings(group.finalUrls),
  }
}

// ── step 1b: negative keyword lists and recommendations (tier 5) ─────────────────────────────────────────────────

/** A shared set's details when the query carried them (null otherwise). */
export function mapSharedSet(json: GoogleAdsSharedSetJson | undefined): GoogleAdsSharedSetData | null {
  const sharedSetId = json ? (int64OrNull(json.id)?.toString() ?? idFromResourceName(json.resourceName)) : null
  if (!json || !sharedSetId) return null
  // The query carried the set's details: a member count Google left out is 0.
  return { sharedSetId, name: text(json.name), type: enumText(json.type), status: enumText(json.status), memberCount: count(json.memberCount) }
}

/**
 * The shared set types that hold negative keywords (https://developers.google.com/google-ads/api/fields/v25/shared_set,
 * shared_set.type): NEGATIVE_KEYWORDS, a list attached to campaigns (campaign_shared_set), and
 * ACCOUNT_LEVEL_NEGATIVE_KEYWORDS, a list meant for the whole account. Google attaches an account-level list to the
 * account with a customer_negative_criterion (negative_keyword_list.shared_set; at most one per account), never to a
 * campaign (https://developers.google.com/google-ads/api/docs/targeting/shared-sets). Nexus reads that link
 * (`mapAccountListLink`): the list is in force only while one points at it.
 */
export const NEGATIVE_LIST_TYPES = ['NEGATIVE_KEYWORDS', 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS'] as const
export const ACCOUNT_LEVEL_LIST_TYPE = 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS'

/** A shared set Nexus keeps as a negative keyword list: its type, when known, is one of NEGATIVE_LIST_TYPES, and it is not removed. */
const isNegativeList = (set: GoogleAdsSharedSetData | null): boolean =>
  !set || ((set.type === null || (NEGATIVE_LIST_TYPES as readonly string[]).includes(set.type)) && set.status !== 'REMOVED')

/** One keyword of a negative keyword list, with the list when the query carried it. */
export function mapListKeyword(row: GoogleAdsSharedCriterionRow, context: { customerId: string }): { keyword: GoogleAdsKeywordData; set: GoogleAdsSharedSetData | null } | null {
  const criterion = row.sharedCriterion
  const set = mapSharedSet(row.sharedSet)
  const sharedSetId = idFromResourceName(criterion?.sharedSet) ?? set?.sharedSetId ?? null
  const criterionId = int64OrNull(criterion?.criterionId)?.toString() ?? lastCompositePart(criterion?.resourceName)
  if (!criterion || !sharedSetId || !criterionId) return null
  if ((criterion.type !== undefined && criterion.type !== 'KEYWORD') || !isNegativeList(set)) return null
  return {
    keyword: {
      customerId: context.customerId,
      level: 'LIST',
      parentKey: `l:${sharedSetId}`,
      criterionId,
      campaignId: null,
      adGroupId: null,
      sharedSetId,
      negative: true,
      criterionType: 'KEYWORD',
      text: text(criterion.keyword?.text),
      matchType: matchTypeOf(criterion.keyword?.matchType),
      status: null,
      ...NO_BIDS,
    },
    set,
  }
}

/**
 * The negative keyword list a customer_negative_criterion points at — the list Google applies to the whole account — and
 * the account that owns it ("customers/<customerId>/sharedSets/<sharedSetId>"). A manager account's list attached to a
 * client account names the manager: its keywords live there and cannot be read from the client account.
 */
export function mapAccountListLink(row: GoogleAdsCustomerNegativeCriterionRow): { customerId: string; sharedSetId: string } | null {
  const criterion = row.customerNegativeCriterion
  if (!criterion || (criterion.type !== undefined && criterion.type !== 'NEGATIVE_KEYWORD_LIST')) return null
  const match = /^customers\/(\d+)\/sharedSets\/(\d+)$/.exec(text(criterion.negativeKeywordList?.sharedSet) ?? '')
  return match ? { customerId: match[1]!, sharedSetId: match[2]! } : null
}

/** One list attached to one campaign, with the list when the query carried it. */
export function mapListAttachment(row: GoogleAdsCampaignSharedSetRow): { campaignId: string; sharedSetId: string; set: GoogleAdsSharedSetData | null } | null {
  const attachment = row.campaignSharedSet
  const set = mapSharedSet(row.sharedSet)
  const campaignId = idFromResourceName(attachment?.campaign) ?? idOf(row.campaign)
  const sharedSetId = idFromResourceName(attachment?.sharedSet) ?? set?.sharedSetId ?? null
  if (!attachment || !campaignId || !sharedSetId || attachment.status === 'REMOVED' || !isNegativeList(set)) return null
  return { campaignId, sharedSetId, set }
}

/** The RecommendationMetrics Nexus keeps (v25 also has videoViews, not kept); each is optional, sent only when estimated. */
const IMPACT_KEYS = ['impressions', 'clicks', 'costMicros', 'conversions', 'conversionsValue'] as const

function impactMetrics(metrics: GoogleAdsRecommendationMetricsJson | undefined): Prisma.InputJsonObject {
  const out: Record<string, string | number> = {}
  if (!isObject(metrics)) return out
  for (const key of IMPACT_KEYS) {
    const value = metrics[key]
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    else if (typeof value === 'string' && value.trim()) out[key] = value.trim()
  }
  return out
}

/** One recommendation. `dismissed` is always set; the impact only when it was read and Google sent one. */
export function mapRecommendation(row: GoogleAdsRecommendationRow, context: { customerId: string; impactRead: boolean }): GoogleAdsRecommendationData | null {
  const recommendation = row.recommendation
  const resourceName = text(recommendation?.resourceName)
  if (!recommendation || !resourceName) return null
  const data: GoogleAdsRecommendationData = {
    customerId: context.customerId,
    resourceName,
    type: enumText(recommendation.type) ?? 'UNKNOWN',
    campaignId: idFromResourceName(recommendation.campaign),
    adGroupId: idFromResourceName(recommendation.adGroup),
    dismissed: recommendation.dismissed === true,
  }
  if (context.impactRead && isObject(recommendation.impact)) {
    data.impact = { base: impactMetrics(recommendation.impact.baseMetrics), potential: impactMetrics(recommendation.impact.potentialMetrics) }
  }
  return data
}
