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

export type GoogleProduct = 'ads' | 'merchant_center' | 'analytics'

export interface GoogleAccount {
  connectionId: string
  /** A person's name for this sign-in. Never a customer id. */
  label: string
  state: GoogleAccountState
  stateText: string
  authStatus: string
  missingProducts: GoogleProduct[]
  ads: { customerId: string; name: string | null; currency: string; timeZone: string; isTest: boolean } | null
  manager: { customerId: string; name: string | null } | null
  merchantCenter: { id: string; name: string | null } | null
  analytics: { propertyId: string; name: string | null } | null
  read: { lastReadAt: string | null; lastDataDay: string | null; nextReadAt: string | null; lastError: string | null }
}

export type GoogleChoiceErrorCode = 'permission_missing' | 'no_access' | 'app_not_approved' | 'not_registered' | 'google_unavailable'

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
}

export interface GoogleChoices {
  missingProducts: GoogleProduct[]
  ads: { customers: GoogleAdsCustomerChoice[]; error: GoogleChoiceError | null }
  merchantCenter: { accounts: { id: string; name: string | null }[]; error: GoogleChoiceError | null }
  analytics: { properties: { propertyId: string; name: string | null; accountName: string | null }[]; error: GoogleChoiceError | null }
}

export interface GoogleSelectionBody {
  adsCustomerId: string
  managerCustomerId: string | null
  merchantCenterId: string | null
  analyticsPropertyId: string | null
}

export type GoogleSelectionConflict = 'not_offered' | 'customer_taken'

export type SaveSelectionResult =
  | { ok: true; account: GoogleAccount }
  | { ok: false; status: number; code: GoogleSelectionConflict | null; error: string }

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
  const data = (await res.json().catch(() => null)) as { account?: GoogleAccount; code?: string; error?: string } | null
  if (res.ok && data?.account) return { ok: true, account: data.account }
  const code = res.status === 409 && (data?.code === 'not_offered' || data?.code === 'customer_taken') ? data.code : null
  return { ok: false, status: res.status, code, error: res.ok ? 'Nexus saved nothing it could confirm. Reload and check the choice.' : errorText(data, res.status) }
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
