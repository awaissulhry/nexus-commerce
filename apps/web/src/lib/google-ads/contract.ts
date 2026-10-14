/**
 * Google Ads step 1a — the web's ONE copy of the API contract (PLAN.md "API contract", plan-3 §4), and the typed
 * calls that speak it. Settings › Channels (the account picker) and Ads › Google (the read-only screen) both import
 * from here, so a field renamed on the server breaks the typecheck in one place.
 *
 * Nothing here writes to Google: C3 saves which accounts Nexus reads, S asks Nexus to read again. Every call goes
 * through `getBackendUrl()`; the patched browser `fetch` adds credentials, CSRF and the business header.
 *
 * Money is in MINOR units of the account's own currency (never converted). A day Nexus has not read is `read: false`
 * with no numbers — never a zero.
 */
import { getBackendUrl } from '@/lib/backend-url'

/** The catalogue key (and connection `channelType`) of the Google channel — PLAN.md L1. */
export const GOOGLE_KEY = 'GOOGLE'

// ─── Connection (C1–C3) ─────────────────────────────────────────────────

export type GoogleAccountState =
  | 'sign_in_needed'
  | 'permission_missing'
  | 'choose_account'
  | 'first_read_pending'
  | 'read_failed'
  | 'ok'

/**
 * The Google products one sign-in can grant (Ads, Merchant Center, Analytics). Named `GoogleSignInProduct` since step 1b:
 * `GoogleProduct` is a product Google Ads advertises (R11).
 */
export type GoogleSignInProduct = 'ads' | 'merchant_center' | 'analytics'

export interface GoogleAccount {
  connectionId: string
  /** A person's name for this sign-in. Never a customer id. */
  label: string
  state: GoogleAccountState
  stateText: string
  authStatus: string
  missingProducts: GoogleSignInProduct[]
  ads: { customerId: string; name: string | null; currency: string; timeZone: string; isTest: boolean } | null
  manager: { customerId: string; name: string | null } | null
  merchantCenter: { id: string; name: string | null } | null
  analytics: { propertyId: string; name: string | null } | null
  read: { lastReadAt: string | null; lastDataDay: string | null; nextReadAt: string | null; lastError: string | null }
}

export type GoogleChoiceErrorCode = 'permission_missing' | 'no_access' | 'account_not_active' | 'app_not_approved' | 'not_registered' | 'google_unavailable'

export interface GoogleChoiceError {
  code: GoogleChoiceErrorCode
  message: string
}

export interface GoogleAdsCustomerChoice {
  customerId: string
  name: string | null
  currency: string
  timeZone: string
  isTest: boolean
  /** True when this sign-in reaches the account directly (not only through a manager). */
  direct: boolean
  managers: { customerId: string; name: string | null }[]
  /**
   * True when another business in Nexus already picked this account (one business per account; Save refuses it). The
   * server never says which business. Absent from an older server = not known, and Save still guards it.
   */
  takenByAnotherBusiness?: boolean
}

export interface GoogleChoices {
  missingProducts: GoogleSignInProduct[]
  ads: { customers: GoogleAdsCustomerChoice[]; error: GoogleChoiceError | null }
  /** `takenByAnotherBusiness` as on a Google Ads account: another business in Nexus already picked it. */
  merchantCenter: { accounts: { id: string; name: string | null; takenByAnotherBusiness?: boolean }[]; error: GoogleChoiceError | null }
  analytics: {
    properties: { propertyId: string; name: string | null; accountName: string | null; takenByAnotherBusiness?: boolean }[]
    error: GoogleChoiceError | null
  }
}

export interface GoogleSelectionBody {
  adsCustomerId: string
  managerCustomerId: string | null
  merchantCenterId: string | null
  analyticsPropertyId: string | null
}

/** `taken_by_other_business`: another business in Nexus already picked this account (`product` says which). */
export type GoogleSelectionConflict = 'not_offered' | 'customer_taken' | 'taken_by_other_business'

export type SaveSelectionResult =
  | { ok: true; account: GoogleAccount }
  | { ok: false; status: number; code: GoogleSelectionConflict | null; product?: GoogleSignInProduct; error: string }

// ─── Read (R1–R4, S) ────────────────────────────────────────────────────

export interface GoogleMetrics {
  impressions: number
  clicks: number
  /** Minor units of the account currency. Absent when the viewer's role may not see ad spend. */
  spendCents?: number | null
  conversions: number
  conversionValueCents?: number | null
  ctr: number | null
  avgCpcCents?: number | null
  roas?: number | null
  costPerConversionCents?: number | null
}

export interface GoogleWindow {
  from: string
  to: string
  provisionalFrom: string | null
}

export interface GoogleCoverage {
  daysInWindow: number
  daysRead: number
  missingDays: string[]
}

/** One day. `read: false` means Nexus has no numbers for it — the metric fields are then null, never 0. */
export interface GoogleDay {
  date: string
  provisional: boolean
  read: boolean
  impressions: number | null
  clicks: number | null
  spendCents?: number | null
  conversions: number | null
  conversionValueCents?: number | null
  ctr?: number | null
  avgCpcCents?: number | null
  roas?: number | null
  costPerConversionCents?: number | null
}

export interface GoogleOverview {
  accounts: GoogleAccount[]
  account: GoogleAccount | null
  window: GoogleWindow
  currency: string | null
  timeZone: string | null
  dataAsOf: string | null
  coverage: GoogleCoverage
  totals: GoogleMetrics | null
  /** The window before, of the same length; null unless Nexus read every day of this window AND of that one. */
  previous: (GoogleMetrics & { from: string; to: string }) | null
  days: GoogleDay[]
  /** Step 1b (R1, additive): when Nexus last read each of the step-1b parts of the account. */
  reads: GoogleRead[]
}

export type GoogleCampaignStatus = 'ENABLED' | 'PAUSED' | 'REMOVED'

export interface GoogleCampaign {
  campaignId: string
  externalCampaignId: string
  name: string
  /** Null when Nexus has the campaign's numbers but has not read its settings yet (added since the last settings read). */
  status: GoogleCampaignStatus | null
  servingStatus: string | null
  primaryStatus?: string | null
  type: string
  biddingStrategy: string | null
  dailyBudgetCents?: number | null
  budgetShared: boolean
  startDate: string | null
  endDate: string | null
  /** When Nexus last read these settings; null when it never did (a campaign seen only in the numbers, removed or new). */
  settingsReadAt: string | null
  /** Null when Nexus read no day of this campaign in the window. */
  metrics: GoogleMetrics | null
}

export interface GoogleCampaignsPage {
  window: GoogleWindow
  currency: string | null
  dataAsOf: string | null
  coverage: GoogleCoverage
  items: GoogleCampaign[]
  nextCursor: string | null
  total: number
}

export interface GoogleCampaignDays {
  campaign: GoogleCampaign
  currency: string | null
  window: GoogleWindow
  coverage: GoogleCoverage
  days: GoogleDay[]
}

export type GoogleChangeSource = 'google_automatic' | 'google_ads_web' | 'google_ads_editor' | 'api' | 'other'

/** One row of Google's change history. Carries no person's e-mail, by contract. */
export interface GoogleChange {
  changedAt: string
  resourceType: string
  operation: string
  changedFields: string[]
  source: GoogleChangeSource
  sourceText: string
  summary: string
}

export interface GoogleCampaignChanges {
  items: GoogleChange[]
  /**
   * The span whose changes Nexus read in full: from `coveredFrom` (the oldest instant Google still answers for, about
   * 30 days back) to `coveredThrough` (where Nexus's reading stopped). `coveredFrom` is null when that span is empty;
   * `coveredThrough` is null when Nexus never read the change history.
   */
  coveredFrom: string | null
  coveredThrough: string | null
}

export interface GoogleSyncAnswer {
  queued: boolean
  reason: string | null
}

// ─── Step 1b: read more (R5–R15) — PLAN-1B.md "API contract", canonical ──
//
// Money in minor units of the account currency, never converted (stripped whole without the ad-spend permission).
// Ratios by Nexus, null over 0. A day outside a grain's read range is "not read", never 0. "Not read yet" =
// `read.readAt === null` (structure) or `numbersRead.readAt === null` (numbers); day gaps come from `coverage`.

/** A setting Google can switch on by itself. `null` = Nexus has not read it yet (never "off"). */
export type Flag = 'on' | 'off' | 'not_applicable' | null

export type GoogleReadResource =
  | 'AD_GROUPS'
  | 'KEYWORDS'
  | 'CAMPAIGN_NEGATIVES'
  | 'NEGATIVE_LISTS'
  | 'ASSET_GROUPS'
  | 'CAMPAIGN_SETTINGS'
  | 'AD_POLICY'
  | 'PRODUCT_STATUS'
  | 'AUTO_APPLY'
  | 'RECOMMENDATIONS'
  | 'AD_GROUP_DAYS'
  | 'KEYWORD_DAYS'
  | 'ASSET_GROUP_DAYS'
  | 'PRODUCT_DAYS'
  | 'SEARCH_TERM_DAYS'

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
  campaignId: string | null
  externalCampaignId: string
  campaignName: string | null
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
  cpcBidCents?: number | null
  targetCpaCents?: number | null
  targetRoas?: number | null
  searchTermMatching: Flag
  settingsReadAt: string | null
  metrics: GoogleMetrics | null
}

// R6 GET /api/google-ads/keywords
export type GoogleKeywordsPage = GoogleListBase & { items: GoogleKeyword[] }
export type GoogleMatchType = 'EXACT' | 'PHRASE' | 'BROAD'
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
  cpcBidCents?: number | null
  effectiveCpcBidCents?: number | null
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
  /** The kind: true = the account-level list (never attached to a campaign; `campaigns` is empty), false = a list for campaigns, null = not read. */
  accountLevel: boolean | null
  /** true = Google applies the list to the whole account (in force); false = read, not in use; null = not read yet. */
  appliesToAccount: boolean | null
  campaigns: { campaignId: string | null; externalCampaignId: string; name: string | null }[]
  seenAt: string
}

// R8 GET /api/google-ads/search-terms
/** The business's protected terms. `terms: []` → every `brand` is null (never "all not brand"). */
export interface GoogleBrandTerms {
  terms: string[]
  source: 'protected_terms'
  /** Where a person changes them (a Nexus page; the web adds the business prefix). */
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
  campaignType: 'ALL' | 'SEARCH' | 'SHOPPING' | 'PERFORMANCE_MAX'
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
/** A product Google Ads advertises (Shopping, Performance Max). */
export interface GoogleProduct {
  productKey: string
  itemId: string
  title: string | null
  campaignId: string | null
  externalCampaignId: string | null
  campaignName: string | null
  campaignType: string | null
  status: 'no_issue' | 'limited' | 'not_eligible' | null
  issues: GoogleProductIssueText[]
  /** The Nexus product with exactly this SKU (case-insensitive), or null. */
  nexusProduct: { productId: string; sku: string; name: string } | null
  metrics: GoogleMetrics | null
}

// R12 GET /api/google-ads/acts-on-its-own
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
  who: 'google_auto_apply' | 'google_recommendation' | 'your_google_rules_or_scripts' | 'person' | 'api' | 'other'
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
  spendCents?: number | null
  conversions: number | null
  conversionValueCents?: number | null
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
  /** Google's estimate; absent without the ad-spend permission (money key `impact`). */
  impact?: { base: GoogleImpact; potential: GoogleImpact } | null
}

// R14 GET /api/google-ads/alerts
export type GoogleAlertKind =
  | 'spend_pace'
  | 'month_pace'
  | 'zero_conversions'
  | 'tracking_stopped'
  | 'ads_disapproved'
  | 'products_not_eligible'
  | 'ads_limited'
  | 'auto_apply_on'
  | 'changed_by_google'
  | 'settings_changed'
  | 'moved_to_ai_max'
export interface GoogleAlerts {
  checkedAt: string
  items: GoogleAlert[]
  notChecked: { kind: GoogleAlertKind; reason: string }[]
}
export interface GoogleAlert {
  alertId: string
  kind: GoogleAlertKind
  severity: 'info' | 'warn' | 'danger'
  title: string
  /** Never an amount. */
  body: string
  campaignId: string | null
  externalCampaignId: string | null
  campaignName: string | null
  since: string | null
  /** Money among them; stripped whole (absent or null) without the ad-spend permission. */
  numbers?: Record<string, number | null> | null
  /** For the bell and MCP only; the page builds its own target (M4). */
  href: string
}

// R15 GET /api/google-ads/disapprovals
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
  status: 'DISAPPROVED' | 'APPROVED_LIMITED' | 'AREA_OF_INTEREST_ONLY'
  reviewStatus: string | null
  reasons: string[]
  since: string
}
export interface GoogleProductIssue {
  /** One feed entry: merchant~channel~language~feed label~item id (one item id can be in several feeds or countries). */
  productKey: string
  itemId: string
  title: string | null
  status: 'not_eligible' | 'limited'
  issues: GoogleProductIssueText[]
  since: string
}

// ─── Calls ──────────────────────────────────────────────────────────────

/** A refused or failed call: the HTTP status and the server's own sentence, so the screen can say what happened. */
export class GoogleAdsHttpError extends Error {
  readonly status: number
  readonly code: string | null
  constructor(status: number, message: string, code: string | null = null) {
    super(message)
    this.name = 'GoogleAdsHttpError'
    this.status = status
    this.code = code
  }
}

type FetchImpl = typeof fetch

/** The server's sentence for a failed call, or a plain one when it sent none. */
export function errorText(body: unknown, status: number): string {
  const b = (body && typeof body === 'object' ? body : {}) as { error?: unknown; message?: unknown }
  const pick = (v: unknown) => (typeof v === 'string' && v.trim() && !/^(internal server error|bad request|not found|forbidden|unauthorized|conflict)$/i.test(v.trim()) ? v.trim() : null)
  return pick(b.error) ?? pick(b.message) ?? (status === 403
    ? 'Your role cannot see this. Ask the business owner for access.'
    : status === 404
      ? 'Nexus could not find this.'
      : `Nexus could not load this (HTTP ${status}).`)
}

async function readJson<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as unknown
  if (!res.ok) {
    const code = body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string' ? (body as { code: string }).code : null
    throw new GoogleAdsHttpError(res.status, errorText(body, res.status), code)
  }
  if (body == null) throw new GoogleAdsHttpError(res.status, 'Nexus answered with nothing it could read.')
  return body as T
}

function query(params: Record<string, string | number | null | undefined>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, String(v))
  const s = q.toString()
  return s ? `?${s}` : ''
}

const get = <T>(path: string, fetchImpl: FetchImpl) =>
  fetchImpl(`${getBackendUrl()}${path}`, { credentials: 'include', cache: 'no-store' }).then((res) => readJson<T>(res))

/** C1 — the Google sign-ins of this business (0 or 1 in step 1). */
export function fetchGoogleConnections(fetchImpl: FetchImpl = fetch): Promise<{ items: GoogleAccount[] }> {
  return get('/api/google-ads/connections', fetchImpl)
}

/** C2 — what this sign-in can see, each product on its own (one failing never hides the others). */
export function fetchGoogleChoices(connectionId: string, fetchImpl: FetchImpl = fetch): Promise<GoogleChoices> {
  return get(`/api/google-ads/connections/${encodeURIComponent(connectionId)}/choices`, fetchImpl)
}

/** C3 — save which accounts Nexus reads; the server checks the choice against a fresh read and queues the first read. */
export async function saveGoogleSelection(connectionId: string, body: GoogleSelectionBody, fetchImpl: FetchImpl = fetch): Promise<SaveSelectionResult> {
  const res = await fetchImpl(`${getBackendUrl()}/api/google-ads/connections/${encodeURIComponent(connectionId)}/selection`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => null)) as { account?: GoogleAccount; code?: string; product?: string; error?: string } | null
  if (res.ok && data?.account) return { ok: true, account: data.account }
  const code = res.status === 409 && (data?.code === 'not_offered' || data?.code === 'customer_taken' || data?.code === 'taken_by_other_business') ? data.code : null
  const product = code === 'taken_by_other_business' && (data?.product === 'ads' || data?.product === 'merchant_center' || data?.product === 'analytics') ? data.product : null
  return { ok: false, status: res.status, code, ...(product ? { product } : {}), error: res.ok ? 'Nexus saved nothing it could confirm. Reload and check the choice.' : errorText(data, res.status) }
}

export interface GoogleWindowQuery {
  /** The connection to read; omitted = the business's one Google Ads account. */
  account?: string | null
  from: string
  to: string
}

/** R1 — the account's totals, the comparison window and one row per day. */
export function fetchGoogleOverview(q: GoogleWindowQuery, fetchImpl: FetchImpl = fetch): Promise<GoogleOverview> {
  return get(`/api/google-ads/overview${query({ account: q.account, from: q.from, to: q.to })}`, fetchImpl)
}

export interface GoogleCampaignsQuery extends GoogleWindowQuery {
  status?: string | null
  type?: string | null
  search?: string | null
  limit?: number
  cursor?: string | null
}

/** R2 — one page of campaigns. */
export function fetchGoogleCampaignsPage(q: GoogleCampaignsQuery, fetchImpl: FetchImpl = fetch): Promise<GoogleCampaignsPage> {
  return get(`/api/google-ads/campaigns${query({ account: q.account, from: q.from, to: q.to, status: q.status, type: q.type, search: q.search, limit: q.limit, cursor: q.cursor })}`, fetchImpl)
}

/** The most pages one screen asks for (500 campaigns each); an account past that says so instead of hanging. */
export const MAX_CAMPAIGN_PAGES = 20

/** R2, every page — the grid filters, sorts and totals in the browser over the whole list. */
export async function fetchAllGoogleCampaigns(q: GoogleWindowQuery, fetchImpl: FetchImpl = fetch): Promise<GoogleCampaignsPage & { truncated: boolean }> {
  let page = await fetchGoogleCampaignsPage({ ...q, limit: 500 }, fetchImpl)
  const items = [...page.items]
  let pages = 1
  while (page.nextCursor && pages < MAX_CAMPAIGN_PAGES) {
    page = await fetchGoogleCampaignsPage({ ...q, limit: 500, cursor: page.nextCursor }, fetchImpl)
    items.push(...page.items)
    pages++
  }
  return { ...page, items, nextCursor: null, truncated: !!page.nextCursor }
}

/** R3 — one campaign's days in the window. */
export function fetchGoogleCampaignDays(campaignId: string, q: { from: string; to: string }, fetchImpl: FetchImpl = fetch): Promise<GoogleCampaignDays> {
  return get(`/api/google-ads/campaigns/${encodeURIComponent(campaignId)}/days${query({ from: q.from, to: q.to })}`, fetchImpl)
}

/** R4 — Google's change history for one campaign (the last 30 days Google keeps, plus what Nexus kept). */
export function fetchGoogleCampaignChanges(campaignId: string, fetchImpl: FetchImpl = fetch): Promise<GoogleCampaignChanges> {
  return get(`/api/google-ads/campaigns/${encodeURIComponent(campaignId)}/changes`, fetchImpl)
}

/** S — ask Nexus to read Google again now (at most once an hour per account; the answer says whether it queued). */
export async function requestGoogleRead(account: string | null = null, fetchImpl: FetchImpl = fetch): Promise<GoogleSyncAnswer> {
  const res = await fetchImpl(`${getBackendUrl()}/api/google-ads/sync${query({ account })}`, { method: 'POST', credentials: 'include' })
  const data = await readJson<Partial<GoogleSyncAnswer>>(res)
  return { queued: data.queued === true, reason: typeof data.reason === 'string' && data.reason.trim() ? data.reason.trim() : null }
}

// ─── Step 1b calls (R5–R15): GET only, `ads.view` ──────────────────────

/** One page of a list (R5–R8, R10, R11). */
export interface GooglePaged<T> {
  items: T[]
  nextCursor: string | null
  total: number
}

/** The most rows one call asks for, and the most pages a screen follows; past that it says `truncated`. */
export const GOOGLE_PAGE_LIMIT = 500
export const MAX_GOOGLE_PAGES = 20

/**
 * Follows `nextCursor` from the first page, at most `maxPages` pages, and returns every item with the FIRST page's
 * other fields (window, read, coverage, lists… are the same on every page). `truncated` says the list stopped at the
 * cap with more to read — the screen says so, and its totals cover the rows loaded only.
 */
export async function fetchAllGooglePages<P extends GooglePaged<unknown>>(
  fetchPage: (cursor: string | null) => Promise<P>,
  maxPages: number = MAX_GOOGLE_PAGES,
): Promise<P & { truncated: boolean }> {
  const first = await fetchPage(null)
  const items: unknown[] = [...first.items]
  let page: P = first
  let pages = 1
  while (page.nextCursor && pages < maxPages) {
    page = await fetchPage(page.nextCursor)
    items.push(...page.items)
    pages++
  }
  return { ...first, items, nextCursor: null, truncated: !!page.nextCursor } as P & { truncated: boolean }
}

/** The filters every step-1b list takes. `account` omitted = the business's one Google Ads account. */
export interface GoogleListQuery {
  account?: string | null
  /** The Nexus id or the step-1a `<customerId>~<googleCampaignId>` id. */
  campaignId?: string | null
  limit?: number
  cursor?: string | null
}

export interface GoogleAdGroupsQuery extends GoogleListQuery, GoogleWindowQuery {
  status?: string | null
  search?: string | null
}

/** R5 — one page of ad groups (by name). */
export function fetchGoogleAdGroups(q: GoogleAdGroupsQuery, fetchImpl: FetchImpl = fetch): Promise<GoogleAdGroupsPage> {
  return get(`/api/google-ads/ad-groups${query({ account: q.account, from: q.from, to: q.to, campaignId: q.campaignId, status: q.status, search: q.search, limit: q.limit, cursor: q.cursor })}`, fetchImpl)
}

export interface GoogleKeywordsQuery extends GoogleListQuery, GoogleWindowQuery {
  adGroupId?: string | null
  status?: string | null
  matchType?: GoogleMatchType | null
  search?: string | null
  sort?: 'spend' | 'text' | null
}

/** R6 — one page of keywords. */
export function fetchGoogleKeywords(q: GoogleKeywordsQuery, fetchImpl: FetchImpl = fetch): Promise<GoogleKeywordsPage> {
  return get(`/api/google-ads/keywords${query({ account: q.account, from: q.from, to: q.to, campaignId: q.campaignId, adGroupId: q.adGroupId, status: q.status, matchType: q.matchType, search: q.search, sort: q.sort, limit: q.limit, cursor: q.cursor })}`, fetchImpl)
}

export interface GoogleNegativesQuery extends GoogleListQuery {
  level?: 'ad_group' | 'campaign' | 'list' | null
  search?: string | null
}

/** R7 — one page of negative keywords; with `campaignId`, its own, its ad groups' and the lists attached to it. */
export function fetchGoogleNegatives(q: GoogleNegativesQuery, fetchImpl: FetchImpl = fetch): Promise<GoogleNegativesPage> {
  return get(`/api/google-ads/negatives${query({ account: q.account, campaignId: q.campaignId, level: q.level, search: q.search, limit: q.limit, cursor: q.cursor })}`, fetchImpl)
}

export interface GoogleSearchTermsQuery extends GoogleListQuery, GoogleWindowQuery {
  brand?: 'all' | 'brand' | 'non_brand' | null
  search?: string | null
  sort?: 'spend' | 'clicks' | 'conversions' | 'term' | null
}

/** R8 — one page of search terms (only terms with at least one click). */
export function fetchGoogleSearchTerms(q: GoogleSearchTermsQuery, fetchImpl: FetchImpl = fetch): Promise<GoogleSearchTermsPage> {
  return get(`/api/google-ads/search-terms${query({ account: q.account, from: q.from, to: q.to, campaignId: q.campaignId, brand: q.brand, search: q.search, sort: q.sort, limit: q.limit, cursor: q.cursor })}`, fetchImpl)
}

/** R9 — brand, not brand and not in the search-term list, per campaign type. */
export function fetchGoogleBrandSplit(q: GoogleWindowQuery, fetchImpl: FetchImpl = fetch): Promise<GoogleBrandSplit> {
  return get(`/api/google-ads/brand-split${query({ account: q.account, from: q.from, to: q.to })}`, fetchImpl)
}

export interface GoogleAssetGroupsQuery extends GoogleListQuery, GoogleWindowQuery {
  status?: string | null
}

/** R10 — one page of asset groups (Performance Max). */
export function fetchGoogleAssetGroups(q: GoogleAssetGroupsQuery, fetchImpl: FetchImpl = fetch): Promise<GoogleAssetGroupsPage> {
  return get(`/api/google-ads/asset-groups${query({ account: q.account, from: q.from, to: q.to, campaignId: q.campaignId, status: q.status, limit: q.limit, cursor: q.cursor })}`, fetchImpl)
}

export interface GoogleProductsQuery extends GoogleListQuery, GoogleWindowQuery {
  issue?: 'any' | 'not_eligible' | 'limited' | null
  search?: string | null
  sort?: 'spend' | 'title' | null
}

/** R11 — one page of advertised products. */
export function fetchGoogleProducts(q: GoogleProductsQuery, fetchImpl: FetchImpl = fetch): Promise<GoogleProductsPage> {
  return get(`/api/google-ads/products${query({ account: q.account, from: q.from, to: q.to, campaignId: q.campaignId, issue: q.issue, search: q.search, sort: q.sort, limit: q.limit, cursor: q.cursor })}`, fetchImpl)
}

/** R12 — where Google can change the account by itself, and what it changed. */
export function fetchGoogleActsOnItsOwn(q: { account?: string | null } = {}, fetchImpl: FetchImpl = fetch): Promise<GoogleActsOnItsOwn> {
  return get(`/api/google-ads/acts-on-its-own${query({ account: q.account })}`, fetchImpl)
}

/** R13 — Google's recommendations, as Google last gave them. Nexus applies none. */
export function fetchGoogleRecommendations(q: { account?: string | null; campaignId?: string | null; type?: string | null } = {}, fetchImpl: FetchImpl = fetch): Promise<GoogleRecommendations> {
  return get(`/api/google-ads/recommendations${query({ account: q.account, campaignId: q.campaignId, type: q.type })}`, fetchImpl)
}

/** R14 — what needs a look, checked over what Nexus has read. */
export function fetchGoogleAlerts(q: { account?: string | null } = {}, fetchImpl: FetchImpl = fetch): Promise<GoogleAlerts> {
  return get(`/api/google-ads/alerts${query({ account: q.account })}`, fetchImpl)
}

/** R15 — disapproved and limited ads, and products Google will not show (each list at most 500). */
export function fetchGoogleDisapprovals(q: { account?: string | null; campaignId?: string | null; kind?: 'ad' | 'product' | null } = {}, fetchImpl: FetchImpl = fetch): Promise<GoogleDisapprovals> {
  return get(`/api/google-ads/disapprovals${query({ account: q.account, campaignId: q.campaignId, kind: q.kind })}`, fetchImpl)
}
