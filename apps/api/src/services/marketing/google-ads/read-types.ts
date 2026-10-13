/**
 * Google Ads step 1b — the shapes of the reads R5–R15 and R1's `reads` (PLAN-1B.md "API contract", canonical). The web
 * (apps/web/src/lib/google-ads/contract.ts) and the MCP tool read these same shapes.
 *
 * Money is in minor units of the account's currency, never converted. Ratios are Nexus's, null over a zero. A day
 * outside a grain's read range is "not read" (metrics null, or counted in `coverage.missingDays`), never 0. No key
 * here is named `detail`, `note` or `why`: the MCP money filter strips those whole.
 */
import type { GoogleAdsCoverage, GoogleAdsMetrics, GoogleAdsWindow } from './read.service.js'
import type { GoogleAdsChangeSource } from './types.js'

export type GoogleMetrics = GoogleAdsMetrics
export type GoogleWindow = GoogleAdsWindow
export type GoogleCoverage = GoogleAdsCoverage
export type GoogleChangeSource = GoogleAdsChangeSource

/** A setting Google can switch on by itself. null = Nexus has not read it yet (never "off"). */
export type Flag = 'on' | 'off' | 'not_applicable' | null

export const GOOGLE_READ_RESOURCES = [
  'AD_GROUPS', 'KEYWORDS', 'CAMPAIGN_NEGATIVES', 'NEGATIVE_LISTS', 'ASSET_GROUPS', 'CAMPAIGN_SETTINGS', 'AD_POLICY',
  'PRODUCT_STATUS', 'AUTO_APPLY', 'RECOMMENDATIONS', 'AD_GROUP_DAYS', 'KEYWORD_DAYS', 'ASSET_GROUP_DAYS', 'PRODUCT_DAYS',
  'SEARCH_TERM_DAYS',
] as const
export type GoogleReadResource = (typeof GOOGLE_READ_RESOURCES)[number]

/** When Nexus last read one part of the account. */
export interface GoogleRead {
  resource: GoogleReadResource
  /** null = never read → "Not read yet". */
  readAt: string | null
  lastAttemptAt: string | null
  lastStatus: 'SUCCESS' | 'FAILED' | 'SKIPPED_BUDGET' | null
  lastError: string | null
}

/** null = Nexus has numbers for it but has not read its settings. */
export type EntityStatus = 'ENABLED' | 'PAUSED' | 'REMOVED' | null

export interface CampaignRef {
  /** Nexus's id (or the step-1a `<customerId>~<googleCampaignId>` id of a campaign seen only in the numbers); null = unknown. */
  campaignId: string | null
  externalCampaignId: string
  campaignName: string | null
  /** advertising_channel_type; UNKNOWN when Nexus never read the campaign's settings. */
  campaignType: string
}

export interface GoogleListBase {
  window: GoogleWindow
  currency: string | null
  dataAsOf: string | null
  /** The structure (names, statuses, settings). */
  read: GoogleRead
  /** The daily numbers at this grain. */
  numbersRead: GoogleRead
  /** Days read AT THIS GRAIN. */
  coverage: GoogleCoverage
  nextCursor: string | null
  total: number
}

// R5 GET /api/google-ads/ad-groups
export type GoogleAdGroupsPage = GoogleListBase & { items: GoogleAdGroup[] }
export interface GoogleAdGroup extends CampaignRef {
  adGroupId: string
  externalAdGroupId: string
  name: string
  status: EntityStatus
  primaryStatus: string | null
  primaryStatusReasons: string[]
  type: string | null
  cpcBidCents: number | null
  targetCpaCents: number | null
  targetRoas: number | null
  searchTermMatching: Flag
  settingsReadAt: string | null
  metrics: GoogleMetrics | null
}

// R6 GET /api/google-ads/keywords
export type GoogleMatchType = 'EXACT' | 'PHRASE' | 'BROAD'
export type GoogleKeywordsPage = GoogleListBase & { items: GoogleKeyword[] }
export interface GoogleKeyword extends CampaignRef {
  keywordId: string
  externalCriterionId: string
  adGroupId: string | null
  externalAdGroupId: string
  adGroupName: string | null
  text: string
  matchType: GoogleMatchType | null
  status: EntityStatus
  servingStatus: string | null
  approvalStatus: string | null
  primaryStatus: string | null
  qualityScore: number | null
  cpcBidCents: number | null
  effectiveCpcBidCents: number | null
  settingsReadAt: string | null
  metrics: GoogleMetrics | null
}

// R7 GET /api/google-ads/negatives
export interface GoogleNegativesPage {
  read: { adGroup: GoogleRead; campaign: GoogleRead; lists: GoogleRead }
  items: GoogleNegative[]
  lists: GoogleNegativeList[]
  nextCursor: string | null
  total: number
}
export interface GoogleNegative {
  negativeId: string
  level: 'ad_group' | 'campaign' | 'list'
  kind: 'keyword' | 'brand_list'
  text: string | null
  matchType: GoogleMatchType | null
  campaignId: string | null
  externalCampaignId: string | null
  campaignName: string | null
  adGroupId: string | null
  adGroupName: string | null
  listId: string | null
  listName: string | null
  status: 'ENABLED' | 'REMOVED' | null
  seenAt: string
}
export interface GoogleNegativeList {
  listId: string
  externalListId: string
  name: string
  status: string
  memberCount: number | null
  campaigns: { campaignId: string | null; externalCampaignId: string; name: string | null }[]
  seenAt: string
}

// R8 GET /api/google-ads/search-terms
/** The business's protected terms that apply to every market. `terms: []` → every `brand` is null. */
export interface GoogleBrandTerms {
  terms: string[]
  source: 'protected_terms'
  /** Where a person changes them (a bare Nexus path; the web adds the business prefix). */
  editHref: string
}
export interface GoogleSearchTermsPage {
  window: GoogleWindow
  currency: string | null
  dataAsOf: string | null
  read: GoogleRead
  coverage: GoogleCoverage
  /** Google lists only the searches that got at least one click. */
  scope: 'terms_with_clicks'
  brandTerms: GoogleBrandTerms
  items: GoogleSearchTerm[]
  nextCursor: string | null
  total: number
}
export interface GoogleSearchTerm extends CampaignRef {
  termId: string
  term: string
  brand: boolean | null
  metrics: GoogleMetrics
}

// R9 GET /api/google-ads/brand-split
export type GoogleBrandSplitType = 'ALL' | 'SEARCH' | 'SHOPPING' | 'PERFORMANCE_MAX'
export interface GoogleBrandSplit {
  window: GoogleWindow
  currency: string | null
  dataAsOf: string | null
  read: GoogleRead
  /** Days read by BOTH the campaign numbers and the search terms. */
  coverage: GoogleCoverage
  brandTerms: GoogleBrandTerms
  rows: GoogleBrandSplitRow[]
}
export interface GoogleBrandSplitRow {
  campaignType: GoogleBrandSplitType
  total: GoogleMetrics | null
  brand: GoogleMetrics | null
  nonBrand: GoogleMetrics | null
  /** The campaigns' total less what the search terms add up to. */
  notInSearchTerms: GoogleMetrics | null
}

// R10 GET /api/google-ads/asset-groups
export type GoogleAssetGroupsPage = GoogleListBase & { items: GoogleAssetGroup[] }
export interface GoogleAssetGroup extends CampaignRef {
  assetGroupId: string
  externalAssetGroupId: string
  name: string
  status: EntityStatus
  primaryStatus: string | null
  primaryStatusReasons: string[]
  adStrength: string | null
  finalUrls: string[]
  settingsReadAt: string | null
  metrics: GoogleMetrics | null
}

// R11 GET /api/google-ads/products
export interface GoogleProductsPage {
  window: GoogleWindow
  currency: string | null
  dataAsOf: string | null
  numbersRead: GoogleRead
  statusRead: GoogleRead
  coverage: GoogleCoverage
  items: GoogleProduct[]
  nextCursor: string | null
  total: number
}
export interface GoogleProductIssueText {
  code: string
  severity: string
  text: string
  explanation: string | null
  helpUrl: string | null
  regions: string[]
}
export type GoogleProductStatus = 'no_issue' | 'limited' | 'not_eligible'
export interface GoogleProduct {
  /**
   * The row's key. A product with numbers: `<googleCampaignId>~<itemId>` (Google's numbers name no feed). A product with
   * an open issue and no numbers: its feed entry, `<merchantId>~<channel>~<languageCode>~<feedLabel>~<itemId>` (as R15).
   */
  productKey: string
  itemId: string
  title: string | null
  campaignId: string | null
  externalCampaignId: string | null
  campaignName: string | null
  campaignType: string | null
  status: GoogleProductStatus | null
  issues: GoogleProductIssueText[]
  /** The Nexus product with exactly this SKU (case-insensitive), or null. */
  nexusProduct: { productId: string; sku: string; name: string } | null
  metrics: GoogleMetrics | null
}

// R12 GET /api/google-ads/acts-on-its-own
export type GoogleChangeWho = 'google_auto_apply' | 'google_recommendation' | 'your_google_rules_or_scripts' | 'person' | 'api' | 'other'
export interface GoogleActsOnItsOwn {
  read: { autoApply: GoogleRead; settings: GoogleRead; adGroups: GoogleRead; campaignNegatives: GoogleRead }
  /** null = auto-apply not read yet. */
  autoApply: { enabled: GoogleAutoApply[]; paused: GoogleAutoApply[] } | null
  campaigns: GoogleCampaignAutomation[]
  outsideChanges: {
    nexusWrites: 0
    coveredFrom: string | null
    coveredThrough: string | null
    bySource: { source: GoogleChangeSource; sourceText: string; count: number }[]
    /** At most 200, newest first. */
    items: GoogleOutsideChange[]
  }
}
export interface GoogleAutoApply {
  type: string
  typeText: string
  since: string | null
  changedAt: string | null
}
export interface GoogleCampaignAutomation {
  campaignId: string
  externalCampaignId: string
  name: string
  type: string
  status: EntityStatus
  aiMax: Flag
  campaignBroadMatch: Flag
  searchPartners: Flag
  displayExpansion: Flag
  finalUrlExpansion: Flag
  finalUrlExpansionByDefault: boolean
  textCustomization: Flag
  dynamicSearchAds: Flag
  brandExclusions: number | null
  adGroupsWithoutSearchTermMatching: number | null
  movedToAiMaxAt: string | null
  flagsReadAt: string | null
}
export interface GoogleOutsideChange {
  changedAt: string
  campaignId: string | null
  externalCampaignId: string | null
  campaignName: string | null
  resourceType: string
  operation: string
  changedFields: string[]
  source: GoogleChangeSource
  sourceText: string
  who: GoogleChangeWho
  watched: boolean
  summary: string
}

// R13 GET /api/google-ads/recommendations
export interface GoogleRecommendations {
  read: GoogleRead
  currency: string | null
  writes: { mode: 'none' }
  items: GoogleRecommendation[]
  byType: { type: string; typeText: string; count: number }[]
}
export interface GoogleImpact {
  impressions: number | null
  clicks: number | null
  spendCents: number | null
  conversions: number | null
  conversionValueCents: number | null
}
export interface GoogleRecommendation {
  recommendationId: string
  type: string
  typeText: string
  explanation: string
  campaignId: string | null
  externalCampaignId: string | null
  campaignName: string | null
  adGroupName: string | null
  autoApplied: boolean
  impact: { base: GoogleImpact; potential: GoogleImpact } | null
}

// R14 GET /api/google-ads/alerts
export const GOOGLE_ALERT_KINDS = [
  'spend_pace', 'month_pace', 'zero_conversions', 'tracking_stopped', 'ads_disapproved', 'products_not_eligible',
  'ads_limited', 'auto_apply_on', 'changed_by_google', 'settings_changed', 'moved_to_ai_max',
] as const
export type GoogleAlertKind = (typeof GOOGLE_ALERT_KINDS)[number]
export type GoogleAlertSeverity = 'info' | 'warn' | 'danger'
export interface GoogleAlerts {
  checkedAt: string
  items: GoogleAlert[]
  notChecked: { kind: GoogleAlertKind; reason: string }[]
}
export interface GoogleAlert {
  alertId: string
  kind: GoogleAlertKind
  severity: GoogleAlertSeverity
  title: string
  /** Never an amount. */
  body: string
  campaignId: string | null
  externalCampaignId: string | null
  campaignName: string | null
  since: string | null
  /** Money among them; stripped whole without the ad-spend permission. */
  numbers: Record<string, number | null> | null
  /** For the bell and MCP only; the page builds its own target (PLAN-1B M4). */
  href: string
}

// R15 GET /api/google-ads/disapprovals
export type GoogleAdIssueStatus = 'DISAPPROVED' | 'APPROVED_LIMITED' | 'AREA_OF_INTEREST_ONLY'
export interface GoogleDisapprovals {
  read: { ads: GoogleRead; products: GoogleRead }
  ads: GoogleAdIssue[]
  products: GoogleProductIssue[]
  /** True when a list stopped at its cap (500). */
  truncated: boolean
}
export interface GoogleAdIssue {
  adId: string
  externalAdId: string
  adType: string | null
  campaignId: string | null
  campaignName: string | null
  adGroupId: string | null
  adGroupName: string | null
  status: GoogleAdIssueStatus
  reviewStatus: string | null
  reasons: string[]
  since: string
}
export interface GoogleProductIssue {
  /** One product in one feed: `<merchantId>~<channel>~<languageCode>~<feedLabel>~<itemId>` (one item id can be in several). */
  productKey: string
  itemId: string
  title: string | null
  status: 'not_eligible' | 'limited'
  issues: GoogleProductIssueText[]
  since: string
}
