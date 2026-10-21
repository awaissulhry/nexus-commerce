/**
 * Meta ads (steps 1–2) — the web's ONE copy of the API contract, and the typed calls that speak it. Settings › Channels
 * (the connection, its token and the asset picker) and Ads › Meta (the read-only screen) both import from here, so a
 * field renamed on the server breaks the typecheck in one place.
 *
 * Nothing here writes to Meta: connect stores the business's own app id, app secret and system-user token in Nexus
 * (checked with Meta first), the selection saves which assets Nexus reads, sync asks Nexus to read again. Every call
 * goes through `getBackendUrl()`; the patched browser `fetch` adds credentials, CSRF and the business header. The app
 * secret and the token are sent once, in the body of connect / replace, and never come back.
 *
 * Money is in MINOR units of the ad account's own currency (never converted), and missing for a person who may not see
 * ad spend. A day Nexus has not read is `read: false` with no numbers — never a zero.
 */
import { getBackendUrl } from '@/lib/backend-url'

/** The catalogue key (and connection `channelType`) of the Meta channel. */
export const META_KEY = 'META'

// ─── Connection ─────────────────────────────────────────────────────────

export type MetaConnectionState = 'sign_in_needed' | 'token_problem' | 'permission_missing' | 'choose_account' | 'first_read_pending' | 'read_failed' | 'ok'

export interface MetaPermissionGap {
  scope: string
  required: boolean
  /** What Nexus needs it for, in words. */
  neededFor: string
}

/** The token as Nexus last checked it (debug_token) — never the token itself. */
export interface MetaTokenView {
  checkedAt: string | null
  isValid: boolean | null
  /** Null with neverExpires = a token that does not expire by date. */
  expiresAt: string | null
  neverExpires: boolean
  /** When Nexus renews a 60-day token (30 days before it expires). */
  renewsFrom: string | null
  lastRenewedAt: string | null
  /** SYSTEM_USER, … — null when Meta did not report a type. */
  type: string | null
  typeText: string
  scopes: string[]
  missing: MetaPermissionGap[]
  problem: string | null
}

export interface MetaConnection {
  connectionId: string
  label: string
  state: MetaConnectionState
  stateText: string
  authStatus: string
  systemUser: { id: string; name: string | null } | null
  /** The business's Meta app id (not a secret). The app secret is never shown. */
  appId: string | null
  token: MetaTokenView
  adAccount: { adAccountId: string; name: string | null; currency: string | null; timeZone: string | null; statusText: string | null; businessId: string | null } | null
  page: { pageId: string; name: string | null } | null
  instagram: { instagramId: string; username: string | null } | null
  lastError: string | null
  read: { lastReadAt: string | null; lastDataDay: string | null; nextReadAt: string | null; lastStatus: string | null; lastError: string | null }
}

/** The answer of a token check (debug_token) as the server keeps it. */
export interface MetaTokenHealth {
  checkedAt: string
  isValid: boolean
  appId: string | null
  appMatches: boolean
  type: string | null
  userId: string | null
  expiresAt: string | null
  neverExpires: boolean
  dataAccessExpiresAt: string | null
  scopes: string[]
  missing: MetaPermissionGap[]
  problem: string | null
}

export interface MetaCredentialsBody {
  appId: string
  appSecret: string
  systemUserToken: string
}

export interface MetaConnectAnswer {
  connectionId: string
  placement: 'new' | 'reconsent' | 'adopt'
  systemUser: { id: string; name: string | null }
  token: MetaTokenHealth
  adAccountsSeen: number
}

export type MetaConnectCode =
  | 'invalid_app_id' | 'invalid_app_secret' | 'invalid_token' | 'token_refused' | 'wrong_app' | 'not_system_user'
  | 'missing_permission' | 'meta_unreachable' | 'already_connected' | 'not_found'

export type MetaConnectResult =
  | { ok: true; answer: MetaConnectAnswer }
  | { ok: false; status: number; code: MetaConnectCode | null; error: string }

export interface MetaAdAccountChoice {
  adAccountId: string
  name: string | null
  currency: string | null
  timeZone: string | null
  accountStatus: number | null
  statusText: string
  businessId: string | null
  businessName: string | null
  takenByAnotherBusiness: false
}

export interface MetaPageChoice {
  pageId: string
  name: string | null
  /** Its Instagram account; one another business uses is its id and the flag only. */
  instagram: { id: string; username: string | null } | { id: string; takenByAnotherBusiness: true } | null
  takenByAnotherBusiness: false
}

export interface MetaInstagramChoice {
  instagramId: string
  username: string | null
  pageId: string
  /** Set when another business uses its Page (the Page is then its id only in `pages`). */
  pageTakenByAnotherBusiness?: true
  takenByAnotherBusiness: false
}

/** An asset another business in Nexus uses: its id only — its name and details are that business's (never shown). */
export type MetaTakenAdAccount = { adAccountId: string; takenByAnotherBusiness: true }
export type MetaTakenPage = { pageId: string; takenByAnotherBusiness: true }
export type MetaTakenInstagram = { instagramId: string; takenByAnotherBusiness: true }

export interface MetaChoices {
  systemUser: { id: string; name: string | null } | null
  adAccounts: { items: Array<MetaAdAccountChoice | MetaTakenAdAccount>; error: string | null }
  pages: { items: Array<MetaPageChoice | MetaTakenPage>; error: string | null }
  instagram: { items: Array<MetaInstagramChoice | MetaTakenInstagram>; error: string | null }
}

export interface MetaSelectionBody {
  adAccountId: string
  pageId: string | null
  instagramId: string | null
}

export type MetaSelectionConflict = 'not_offered' | 'account_taken' | 'taken_by_other_business'
export type MetaProduct = 'AD_ACCOUNT' | 'PAGE' | 'INSTAGRAM'

export type SaveMetaSelectionResult =
  | { ok: true; connection: MetaConnection }
  | { ok: false; status: number; code: MetaSelectionConflict | null; product: MetaProduct | null; error: string }

// ─── Read ───────────────────────────────────────────────────────────────

export interface MetaAdsMetrics {
  impressions: number
  clicks: number
  linkClicks: number
  /** Minor units of the account currency. Absent when the viewer's role may not see ad spend. */
  spendCents?: number | null
  purchases: number
  purchaseValueCents?: number | null
  ctr: number | null
  cpcCents?: number | null
  cpmCents?: number | null
  roas?: number | null
  costPerPurchaseCents?: number | null
}

export interface MetaAdsWindow { from: string; to: string; provisionalFrom: string | null }
export interface MetaAdsCoverage { daysInWindow: number; daysRead: number; missingDays: string[] }

/** One day. `read: false` means Nexus has no numbers for it — the metric fields are then null, never 0. */
export interface MetaAdsDay {
  date: string
  provisional: boolean
  read: boolean
  /**
   * Meta's own reach for this one day (people reached that day, deduplicated by Meta at the account level). Per day
   * only: never summed over days — a person reached on two days is one person.
   */
  reach: number | null
  impressions: number | null
  clicks: number | null
  linkClicks: number | null
  spendCents?: number | null
  purchases: number | null
  purchaseValueCents?: number | null
  ctr?: number | null
  cpcCents?: number | null
  cpmCents?: number | null
  roas?: number | null
  costPerPurchaseCents?: number | null
}

export interface MetaAdsAccountSummary {
  adAccountId: string
  name: string | null
  statusText: string | null
  accountStatus: number | null
  disableReason: number | null
  amountSpentCents?: number | null
  /** Null = no account spending limit. */
  spendCapCents?: number | null
  balanceCents?: number | null
  settingsReadAt: string | null
  lastReadAt: string | null
  lastSyncStatus: string | null
  lastSyncError: string | null
}

export interface MetaAdsOverview {
  connections: MetaConnection[]
  connection: MetaConnection | null
  account: MetaAdsAccountSummary | null
  window: MetaAdsWindow
  currency: string | null
  timeZone: string | null
  dataAsOf: string | null
  coverage: MetaAdsCoverage
  totals: MetaAdsMetrics | null
  previous: (MetaAdsMetrics & { from: string; to: string }) | null
  days: MetaAdsDay[]
}

export interface MetaAdsCampaignRow {
  campaignId: string
  metaCampaignId: string
  name: string
  /** ACTIVE | PAUSED | ARCHIVED | DELETED (no longer returned by Meta) | null (numbers, settings never read). */
  status: string | null
  effectiveStatus: string | null
  objective: string | null
  bidStrategy: string | null
  dailyBudgetCents?: number | null
  lifetimeBudgetCents?: number | null
  startTime: string | null
  stopTime: string | null
  settingsReadAt: string | null
  metrics: MetaAdsMetrics | null
}

export interface MetaAdsAdSetRow {
  adSetId: string
  metaAdSetId: string
  metaCampaignId: string
  name: string
  status: string
  effectiveStatus: string | null
  optimizationGoal: string | null
  billingEvent: string | null
  bidStrategy: string | null
  bidAmountCents?: number | null
  dailyBudgetCents?: number | null
  lifetimeBudgetCents?: number | null
  startTime: string | null
  endTime: string | null
  metrics: MetaAdsMetrics | null
}

export interface MetaAdsAdRow {
  adId: string
  metaAdId: string
  metaAdSetId: string
  metaCampaignId: string
  name: string
  status: string
  effectiveStatus: string | null
  creative: { name: string | null; title: string | null; body: string | null; objectType: string | null; thumbnailUrl: string | null } | null
  issues: unknown
  metrics: MetaAdsMetrics | null
}

export interface MetaAdsPage<T> {
  window: MetaAdsWindow
  currency: string | null
  dataAsOf: string | null
  coverage: MetaAdsCoverage
  items: T[]
  nextCursor: string | null
  total: number
}

export interface MetaAdsCampaignDays {
  campaign: MetaAdsCampaignRow
  currency: string | null
  window: MetaAdsWindow
  coverage: MetaAdsCoverage
  days: MetaAdsDay[]
}

export interface MetaSyncAnswer { queued: boolean; reason: string | null }

// ─── Calls ──────────────────────────────────────────────────────────────

export class MetaAdsHttpError extends Error {
  readonly status: number
  readonly code: string | null
  constructor(status: number, message: string, code: string | null = null) {
    super(message)
    this.name = 'MetaAdsHttpError'
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
    throw new MetaAdsHttpError(res.status, errorText(body, res.status), code)
  }
  if (body == null) throw new MetaAdsHttpError(res.status, 'Nexus answered with nothing it could read.')
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

const CONNECT_CODES: readonly MetaConnectCode[] = [
  'invalid_app_id', 'invalid_app_secret', 'invalid_token', 'token_refused', 'wrong_app', 'not_system_user',
  'missing_permission', 'meta_unreachable', 'already_connected', 'not_found',
]

/** This business's Meta connection(s) (0 or 1 normally). */
export function fetchMetaConnections(fetchImpl: FetchImpl = fetch): Promise<{ items: MetaConnection[] }> {
  return get('/api/meta-ads/connections', fetchImpl)
}

/**
 * Connect Meta (no `connectionId`) or replace this connection's credentials. The secret and the token travel once, in
 * this body; the answer never carries them.
 */
export async function saveMetaCredentials(body: MetaCredentialsBody, connectionId: string | null = null, fetchImpl: FetchImpl = fetch): Promise<MetaConnectResult> {
  const path = connectionId ? `/api/meta-ads/connections/${encodeURIComponent(connectionId)}/credentials` : '/api/meta-ads/connect'
  const res = await fetchImpl(`${getBackendUrl()}${path}`, {
    method: connectionId ? 'PUT' : 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: body.appId.trim(), appSecret: body.appSecret.trim(), systemUserToken: body.systemUserToken.trim() }),
  })
  const data = (await res.json().catch(() => null)) as (Partial<MetaConnectAnswer> & { code?: string; error?: string }) | null
  if (res.ok && data?.connectionId) return { ok: true, answer: data as MetaConnectAnswer }
  const code = data?.code && (CONNECT_CODES as readonly string[]).includes(data.code) ? data.code as MetaConnectCode : null
  return { ok: false, status: res.status, code, error: res.ok ? 'Nexus saved nothing it could confirm. Reload and check the connection.' : errorText(data, res.status) }
}

/** Ask Meta about the token now (debug_token); the answer is kept by the server and shown on the card. */
export async function checkMetaToken(connectionId: string, fetchImpl: FetchImpl = fetch): Promise<MetaTokenHealth> {
  const res = await fetchImpl(`${getBackendUrl()}/api/meta-ads/connections/${encodeURIComponent(connectionId)}/token-check`, { method: 'POST', credentials: 'include' })
  return (await readJson<{ token: MetaTokenHealth }>(res)).token
}

/** What the system user can see, each list on its own (`refresh` asks Meta again now). */
export function fetchMetaChoices(connectionId: string, refresh = false, fetchImpl: FetchImpl = fetch): Promise<MetaChoices> {
  return get(`/api/meta-ads/connections/${encodeURIComponent(connectionId)}/choices${query({ refresh: refresh ? 1 : null })}`, fetchImpl)
}

/**
 * Meta step 33 (D2) — the business's "Send sales to Meta (Conversions API)" switch: off by default; a person with
 * settings.security.manage turns it on (`canChange`: this person may). On, Claude may ASK to send purchases
 * (upload-meta-events); each send is a change a person approves — or, with "Claude's changes need no approval" on, it runs
 * 20 s after Claude asks, in the asker's name.
 */
export interface MetaEventsSwitch { on: boolean; since: string | null; by: string | null }

export async function fetchMetaEventsSwitch(fetchImpl: FetchImpl = fetch): Promise<{ switch: MetaEventsSwitch; canChange: boolean }> {
  const body = await get<{ switch: MetaEventsSwitch; canChange?: boolean }>('/api/meta-ads/conversions-api', fetchImpl)
  return { switch: body.switch, canChange: body.canChange === true }
}

export async function setMetaEventsSwitch(on: boolean, fetchImpl: FetchImpl = fetch): Promise<MetaEventsSwitch> {
  const res = await fetchImpl(`${getBackendUrl()}/api/meta-ads/conversions-api`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on }),
  })
  return (await readJson<{ switch: MetaEventsSwitch }>(res)).switch
}

/** Save which assets Nexus reads; the server checks them against what Meta offers and queues the first read. */
export async function saveMetaSelection(connectionId: string, body: MetaSelectionBody, fetchImpl: FetchImpl = fetch): Promise<SaveMetaSelectionResult> {
  const res = await fetchImpl(`${getBackendUrl()}/api/meta-ads/connections/${encodeURIComponent(connectionId)}/selection`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => null)) as { connection?: MetaConnection; code?: string; error?: string; product?: string } | null
  if (res.ok && data?.connection) return { ok: true, connection: data.connection }
  const code = res.status === 409 && (data?.code === 'not_offered' || data?.code === 'account_taken' || data?.code === 'taken_by_other_business') ? data.code : null
  const product = data?.product === 'AD_ACCOUNT' || data?.product === 'PAGE' || data?.product === 'INSTAGRAM' ? data.product : null
  return { ok: false, status: res.status, code, product, error: res.ok ? 'Nexus saved nothing it could confirm. Reload and check the choice.' : errorText(data, res.status) }
}

export interface MetaWindowQuery {
  account?: string | null
  from: string
  to: string
}

export function fetchMetaOverview(q: MetaWindowQuery, fetchImpl: FetchImpl = fetch): Promise<MetaAdsOverview> {
  return get(`/api/meta-ads/overview${query({ account: q.account, from: q.from, to: q.to })}`, fetchImpl)
}

/** The most pages one screen asks for (500 rows each); a list past that says so instead of hanging. */
export const MAX_PAGES = 20

async function allPages<T>(first: (cursor: string | null) => Promise<MetaAdsPage<T>>): Promise<MetaAdsPage<T> & { truncated: boolean }> {
  let page = await first(null)
  const items = [...page.items]
  let pages = 1
  while (page.nextCursor && pages < MAX_PAGES) {
    page = await first(page.nextCursor)
    items.push(...page.items)
    pages++
  }
  return { ...page, items, nextCursor: null, truncated: !!page.nextCursor }
}

export function fetchAllMetaCampaigns(q: MetaWindowQuery, fetchImpl: FetchImpl = fetch) {
  return allPages<MetaAdsCampaignRow>((cursor) => get(`/api/meta-ads/campaigns${query({ account: q.account, from: q.from, to: q.to, limit: 500, cursor })}`, fetchImpl))
}

export function fetchAllMetaAdSets(q: MetaWindowQuery & { campaign?: string | null }, fetchImpl: FetchImpl = fetch) {
  return allPages<MetaAdsAdSetRow>((cursor) => get(`/api/meta-ads/adsets${query({ account: q.account, campaign: q.campaign, from: q.from, to: q.to, limit: 500, cursor })}`, fetchImpl))
}

export function fetchAllMetaAds(q: MetaWindowQuery & { adset?: string | null }, fetchImpl: FetchImpl = fetch) {
  return allPages<MetaAdsAdRow>((cursor) => get(`/api/meta-ads/ads${query({ account: q.account, adset: q.adset, from: q.from, to: q.to, limit: 500, cursor })}`, fetchImpl))
}

export function fetchMetaCampaignDays(campaignId: string, q: { from: string; to: string }, fetchImpl: FetchImpl = fetch): Promise<MetaAdsCampaignDays> {
  return get(`/api/meta-ads/campaigns/${encodeURIComponent(campaignId)}/days${query({ from: q.from, to: q.to })}`, fetchImpl)
}

/** Ask Nexus to read Meta again now (at most once an hour per account). */
export async function requestMetaRead(account: string | null = null, fetchImpl: FetchImpl = fetch): Promise<MetaSyncAnswer> {
  const res = await fetchImpl(`${getBackendUrl()}/api/meta-ads/sync${query({ account })}`, { method: 'POST', credentials: 'include' })
  const data = await readJson<Partial<MetaSyncAnswer>>(res)
  return { queued: data.queued === true, reason: typeof data.reason === 'string' && data.reason.trim() ? data.reason.trim() : null }
}
