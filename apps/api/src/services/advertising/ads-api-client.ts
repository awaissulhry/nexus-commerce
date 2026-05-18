/**
 * AD.1 — Amazon Advertising API HTTP client with sandbox short-circuit.
 *
 * Sandbox is the default per the plan in
 * /Users/awais/.claude/plans/here-is-the-blueprint-humming-beaver.md.
 * Flip to live by setting `NEXUS_AMAZON_ADS_MODE=live` AND providing
 * the LWA-for-Advertising credentials below. AD.4 adds a second key:
 * the per-connection `AmazonAdsConnection.writesEnabledAt` toggle.
 *
 * Region routing matches Amazon's published endpoints:
 *   EU  → https://advertising-api-eu.amazon.com
 *   NA  → https://advertising-api.amazon.com
 *   FE  → https://advertising-api-fe.amazon.com
 *
 * In sandbox mode every method returns fixture data and logs
 * `[ADS-SANDBOX]` with the payload that WOULD have been sent. The
 * fixtures live under ./__fixtures__/ and are picked up by sync /
 * metrics-ingest services to populate local tables identically to
 * the live path. This lets the full UI + automation pipeline exercise
 * end-to-end without Amazon credentials.
 *
 * Live-mode auth flow (when wired):
 *   1. Resolve AmazonAdsConnection.credentialsEncrypted → { clientId,
 *      clientSecret, refreshToken } via apps/api/src/lib/crypto.ts
 *   2. POST to https://api.amazon.com/auth/o2/token with the refresh
 *      token to get a 1-hour access_token
 *   3. Attach Authorization: Bearer + Amazon-Advertising-API-ClientId
 *      + Amazon-Advertising-API-Scope: <profileId> headers
 *   4. Call the appropriate region endpoint
 *
 * The live path is intentionally stubbed in this commit. AD.4 wires
 * the OAuth + write paths properly behind the ads-write-gate.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { logger } from '../../utils/logger.js'

export type AdsMode = 'sandbox' | 'live'

export function adsMode(): AdsMode {
  return process.env.NEXUS_AMAZON_ADS_MODE === 'live' ? 'live' : 'sandbox'
}

export type AdsRegion = 'EU' | 'NA' | 'FE'

const REGION_ENDPOINT: Record<AdsRegion, string> = {
  EU: 'https://advertising-api-eu.amazon.com',
  NA: 'https://advertising-api.amazon.com',
  FE: 'https://advertising-api-fe.amazon.com',
}

const FIXTURE_DIR =
  process.env.NEXUS_AMAZON_ADS_FIXTURE_DIR ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__')

// ── Amazon Ads API response shapes ─────────────────────────────────────
// Trimmed to the fields we actually persist. See the upstream docs for
// the full payload: developer.amazon.com/docs/advertising/index.html

export interface AdsProfileDTO {
  profileId: number | string
  countryCode: string // 'IT' | 'DE' | ...
  currencyCode: string
  timezone: string
  accountInfo: {
    marketplaceStringId: string
    id: string
    type: string
    name: string
  }
}

export interface AdsCampaignDTO {
  campaignId: string
  name: string
  campaignType: 'sponsoredProducts' | 'sponsoredBrands' | 'sponsoredDisplay'
  // 'enabled' | 'paused' | 'archived' | 'draft'
  state: string
  dailyBudget: number
  startDate: string // YYYYMMDD
  endDate?: string
  biddingStrategy?:
    | 'legacyForSales'
    | 'autoForSales'
    | 'manual'
  portfolioId?: string
}

export interface AdsAdGroupDTO {
  adGroupId: string
  campaignId: string
  name: string
  state: string
  defaultBid: number
}

export interface AdsTargetDTO {
  // For keywords: keywordId / keywordText / matchType
  // For product targets: targetId / expression[]
  targetId: string
  adGroupId: string
  campaignId: string
  state: string
  kind: 'KEYWORD' | 'PRODUCT' | 'CATEGORY' | 'AUDIENCE'
  expressionType: string
  expressionValue: string
  bid: number
}

export interface AdsProductAdDTO {
  adId: string
  adGroupId: string
  campaignId: string
  state: string
  asin?: string
  sku?: string
}

// ── Sandbox fixture loader ─────────────────────────────────────────────

async function loadFixture<T>(name: string, fallback: T): Promise<T> {
  try {
    const buf = await readFile(path.join(FIXTURE_DIR, `${name}.json`), 'utf8')
    return JSON.parse(buf) as T
  } catch (err) {
    // Missing fixture is non-fatal — return the caller's empty shape so
    // sandbox flows can ship before every fixture is curated.
    logger.warn('[ADS-SANDBOX] missing fixture', {
      name,
      reason: err instanceof Error ? err.message : String(err),
    })
    return fallback
  }
}

// ── Live-mode HTTP client (AD.4) ───────────────────────────────────────

interface LiveCallOptions {
  profileId: string
  region: AdsRegion
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  body?: unknown
  // Optional Content-Type override. Reports API v3 requires
  // 'application/vnd.createasyncreportrequest.v3+json'; per-resource v3
  // endpoints want their own vnd.* type. Defaults to application/json.
  contentType?: string
  // Optional Accept override. v3 endpoints require the versioned MIME
  // type as Accept header — same value as Content-Type for symmetric
  // negotiation. Defaults to '*/*' (let server pick).
  acceptHeader?: string
}

interface AdsCredentials {
  clientId: string
  clientSecret: string
  refreshToken: string
}

// In-process token cache keyed by profileId. Avoids LWA round-trips on
// every API call; tokens are evicted 60 s before their stated expiry.
const _tokenCache = new Map<string, { token: string; expiresAt: number }>()

// Per-profileId in-flight refresh promise. Deduplicate concurrent callers
// that all see an expired/missing cache entry at the same instant —
// without this, N concurrent callers would each fire a separate LWA
// token exchange, burning rate-limit quota and creating a thundering herd.
const _tokenInflight = new Map<string, Promise<string>>()

async function getLwaToken(
  profileId: string,
  creds: AdsCredentials,
): Promise<string> {
  const now = Date.now()
  const cached = _tokenCache.get(profileId)
  if (cached && now < cached.expiresAt) return cached.token

  // Deduplicate: if a refresh is already in flight for this profileId,
  // join it rather than launching a second token exchange.
  const inflight = _tokenInflight.get(profileId)
  if (inflight) return inflight

  logger.debug('[ADS-LIVE] refreshing LWA token', { profileId })

  const refreshPromise = (async (): Promise<string> => {
    const res = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      }).toString(),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`[ADS-LWA] token exchange failed ${res.status}: ${text}`)
    }
    const data = (await res.json()) as { access_token: string; expires_in: number }
    _tokenCache.set(profileId, {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    })
    return data.access_token
  })().finally(() => _tokenInflight.delete(profileId))

  _tokenInflight.set(profileId, refreshPromise)
  return refreshPromise
}

// Retry fetch for rate-limit (429) and transient server errors (5xx).
// Exponential backoff: 1 s → 2 s → 4 s (capped at 8 s). 4xx errors
// other than 429 are not retried — they indicate a logic problem.
async function fetchWithRetry(
  url: string,
  opts: RequestInit,
  maxAttempts = 3,
): Promise<Response> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(url, opts)
    if (res.ok) return res
    const retryable = res.status === 429 || res.status >= 500
    if (!retryable || attempt === maxAttempts - 1) return res
    const delayMs = Math.min(1000 * Math.pow(2, attempt), 8000)
    logger.warn('[ADS-LIVE] retrying after transient error', {
      status: res.status, attempt: attempt + 1, delayMs, url,
    })
    await new Promise((r) => setTimeout(r, delayMs))
  }
  // Should be unreachable but TypeScript needs a return
  return fetch(url, opts)
}

async function resolveCredentials(profileId: string): Promise<AdsCredentials> {
  const { default: prisma } = await import('../../db.js')
  const { decryptSecret } = await import('../../lib/crypto.js')
  // profileId='n/a' means profile-agnostic call (e.g. GET /v2/profiles).
  // Use the first active connection's credentials.
  const conn =
    profileId === 'n/a'
      ? await prisma.amazonAdsConnection.findFirst({ where: { isActive: true } })
      : await prisma.amazonAdsConnection.findUnique({ where: { profileId } })
  if (!conn?.credentialsEncrypted) {
    throw new Error(`[ADS-LIVE] no credentials for profileId=${profileId}`)
  }
  return JSON.parse(decryptSecret(conn.credentialsEncrypted)) as AdsCredentials
}

export async function liveCall<T>(opts: LiveCallOptions): Promise<T> {
  const creds = await resolveCredentials(opts.profileId)
  const token = await getLwaToken(opts.profileId, creds)
  const base = REGION_ENDPOINT[opts.region]
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Amazon-Advertising-API-ClientId': creds.clientId,
  }
  // Only send Content-Type when there is a body (GET/DELETE have none).
  if (opts.body != null) {
    headers['Content-Type'] = opts.contentType ?? 'application/json'
  }
  // Accept header — v3 endpoints require versioned vnd.* MIME types.
  if (opts.acceptHeader) {
    headers['Accept'] = opts.acceptHeader
  }
  // Scope header is only required for profile-scoped endpoints.
  if (opts.profileId !== 'n/a') {
    headers['Amazon-Advertising-API-Scope'] = opts.profileId
  }
  const res = await fetchWithRetry(`${base}${opts.path}`, {
    method: opts.method,
    headers,
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`[ADS-LIVE] ${opts.method} ${opts.path} → ${res.status}: ${text}`)
  }
  return res.json() as T
}

// ── Public methods ─────────────────────────────────────────────────────

export interface ClientContext {
  profileId: string
  region: AdsRegion
}

export async function listProfiles(): Promise<AdsProfileDTO[]> {
  if (adsMode() === 'sandbox') {
    logger.debug('[ADS-SANDBOX] listProfiles')
    return loadFixture<AdsProfileDTO[]>('profiles', [])
  }
  return liveCall<AdsProfileDTO[]>({
    profileId: 'n/a', // profiles endpoint is profile-agnostic
    region: 'EU',
    method: 'GET',
    path: '/v2/profiles',
  })
}

export interface CampaignPatch {
  state?: 'enabled' | 'paused' | 'archived'
  dailyBudget?: number
  biddingStrategy?: AdsCampaignDTO['biddingStrategy']
  endDate?: string | null
}

export async function updateCampaign(
  ctx: ClientContext,
  externalCampaignId: string,
  patch: CampaignPatch,
): Promise<{ ok: boolean; mode: AdsMode; rawResponse: unknown }> {
  if (adsMode() === 'sandbox') {
    logger.info('[ADS-SANDBOX] updateCampaign', {
      profileId: ctx.profileId,
      externalCampaignId,
      patch,
    })
    return { ok: true, mode: 'sandbox', rawResponse: { sandbox: true, patch } }
  }
  // v3: PUT /sp/campaigns with batch body. Single update is wrapped
  // in a campaigns array. v3 state values are uppercase; budget is
  // nested under {budget: {budget, budgetType}}.
  const v3Campaign: Record<string, unknown> = { campaignId: externalCampaignId }
  if (patch.state) v3Campaign.state = patch.state.toUpperCase()
  if (patch.dailyBudget != null) v3Campaign.budget = { budget: patch.dailyBudget, budgetType: 'DAILY' }
  if (patch.biddingStrategy) {
    const map: Record<string, string> = {
      legacyForSales: 'LEGACY_FOR_SALES',
      autoForSales: 'AUTO_FOR_SALES',
      manual: 'MANUAL',
    }
    v3Campaign.dynamicBidding = { strategy: map[patch.biddingStrategy] }
  }
  if (patch.endDate !== undefined) v3Campaign.endDate = patch.endDate
  const response = await liveCall<unknown>({
    ...ctx,
    method: 'PUT',
    path: '/sp/campaigns',
    body: { campaigns: [v3Campaign] },
    contentType: 'application/vnd.spCampaign.v3+json',
    acceptHeader: 'application/vnd.spCampaign.v3+json',
  })
  return { ok: true, mode: 'live', rawResponse: response }
}

export interface AdGroupPatch {
  state?: 'enabled' | 'paused' | 'archived'
  defaultBid?: number
}

export async function updateAdGroup(
  ctx: ClientContext,
  externalAdGroupId: string,
  patch: AdGroupPatch,
): Promise<{ ok: boolean; mode: AdsMode; rawResponse: unknown }> {
  if (adsMode() === 'sandbox') {
    logger.info('[ADS-SANDBOX] updateAdGroup', {
      profileId: ctx.profileId,
      externalAdGroupId,
      patch,
    })
    return { ok: true, mode: 'sandbox', rawResponse: { sandbox: true, patch } }
  }
  // v3: PUT /sp/adGroups with batch body.
  const v3AdGroup: Record<string, unknown> = { adGroupId: externalAdGroupId }
  if (patch.state) v3AdGroup.state = patch.state.toUpperCase()
  if (patch.defaultBid != null) v3AdGroup.defaultBid = patch.defaultBid
  const response = await liveCall<unknown>({
    ...ctx,
    method: 'PUT',
    path: '/sp/adGroups',
    body: { adGroups: [v3AdGroup] },
    contentType: 'application/vnd.spAdGroup.v3+json',
    acceptHeader: 'application/vnd.spAdGroup.v3+json',
  })
  return { ok: true, mode: 'live', rawResponse: response }
}

export interface TargetPatch {
  state?: 'enabled' | 'paused' | 'archived'
  bid?: number
}

export async function updateTarget(
  ctx: ClientContext,
  externalTargetId: string,
  patch: TargetPatch,
): Promise<{ ok: boolean; mode: AdsMode; rawResponse: unknown }> {
  if (adsMode() === 'sandbox') {
    logger.info('[ADS-SANDBOX] updateTarget', {
      profileId: ctx.profileId,
      externalTargetId,
      patch,
    })
    return { ok: true, mode: 'sandbox', rawResponse: { sandbox: true, patch } }
  }
  // v3: PUT /sp/keywords with batch body.
  const v3Keyword: Record<string, unknown> = { keywordId: externalTargetId }
  if (patch.state) v3Keyword.state = patch.state.toUpperCase()
  if (patch.bid != null) v3Keyword.bid = patch.bid
  const response = await liveCall<unknown>({
    ...ctx,
    method: 'PUT',
    path: '/sp/keywords',
    body: { keywords: [v3Keyword] },
    contentType: 'application/vnd.spKeyword.v3+json',
    acceptHeader: 'application/vnd.spKeyword.v3+json',
  })
  return { ok: true, mode: 'live', rawResponse: response }
}

// ── Reports (Amazon's async request → poll → download pattern) ─────────

export type ReportType =
  | 'campaigns'
  | 'adGroups'
  | 'keywords'
  | 'productAds'
  | 'searchTerms'

export interface ReportRow {
  date: string
  externalCampaignId?: string
  externalAdGroupId?: string
  externalTargetId?: string
  externalAdId?: string
  impressions: number
  clicks: number
  costMicros: number // 1 EUR = 1_000_000 micros
  attributedSales1d?: number
  attributedSales7d?: number
  attributedSales14d?: number
  attributedOrders1d?: number
  attributedOrders7d?: number
  attributedUnits7d?: number
}

export interface ReportRequest {
  reportType: ReportType
  startDate: string // YYYY-MM-DD
  endDate: string // YYYY-MM-DD
}

export async function fetchReport(
  ctx: ClientContext,
  req: ReportRequest,
): Promise<ReportRow[]> {
  if (adsMode() === 'sandbox') {
    logger.debug('[ADS-SANDBOX] fetchReport', { profileId: ctx.profileId, req })
    return loadFixture<ReportRow[]>(`report-${req.reportType}`, [])
  }

  // Amazon Advertising Reports API v3 is async:
  //   POST /reporting/reports  → { reportId }
  //   GET  /reporting/reports/:reportId  → poll until status=COMPLETED
  //   GET  location (S3 presigned URL)   → download + parse JSON/gzip
  const created = await liveCall<{ reportId: string }>({
    ...ctx,
    method: 'POST',
    path: '/reporting/reports',
    body: {
      name: `nexus-${req.reportType}-${req.startDate}`,
      startDate: req.startDate,
      endDate: req.endDate,
      configuration: {
        adProduct: 'SPONSORED_PRODUCTS',
        groupBy: [req.reportType === 'campaigns' ? 'campaign' : req.reportType.replace(/s$/, '')],
        columns: [
          'date', 'campaignId', 'adGroupId', 'keywordId', 'adId',
          'impressions', 'clicks', 'cost', 'sales1d', 'sales7d', 'sales14d',
          'orders1d', 'orders7d', 'unitsSoldClicks7d',
        ],
        reportTypeId: `spCampaigns`,
        timeUnit: 'DAILY',
        format: 'GZIP_JSON',
      },
    },
  })

  const { reportId } = created
  logger.info('[ADS-LIVE] report created, polling', { reportId })

  // Poll for up to 10 minutes (60 × 10 s)
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((r) => setTimeout(r, 10_000))
    const status = await liveCall<{
      status: string
      location?: string
      fileSize?: number
    }>({
      ...ctx,
      method: 'GET',
      path: `/reporting/reports/${reportId}`,
    })
    if (status.status === 'COMPLETED' && status.location) {
      logger.info('[ADS-LIVE] report ready, downloading', { reportId, fileSize: status.fileSize })
      const dlRes = await fetch(status.location) // presigned URL — no auth header
      if (!dlRes.ok) throw new Error(`[ADS-LIVE] report download failed ${dlRes.status}`)
      const json = await dlRes.json()
      return json as ReportRow[]
    }
    if (status.status === 'FAILURE') {
      throw new Error(`[ADS-LIVE] report ${reportId} failed on Amazon side`)
    }
    logger.debug('[ADS-LIVE] report pending', { reportId, attempt, status: status.status })
  }

  throw new Error(`[ADS-LIVE] report ${reportId} timed out after 10 minutes`)
}

// ── Convenience helpers ────────────────────────────────────────────────

export function regionEndpoint(region: AdsRegion): string {
  return REGION_ENDPOINT[region]
}

// AD.1 — Test endpoint shim. Connection-test routes (admin-only) call
// this to confirm credentials work. Sandbox always returns OK; live
// mode would issue listProfiles + check the response.
export async function testConnection(
  ctx: ClientContext,
): Promise<{ ok: boolean; mode: AdsMode; profileCount: number; error: string | null }> {
  const mode = adsMode()
  if (mode === 'sandbox') {
    const profiles = await listProfiles()
    return { ok: true, mode, profileCount: profiles.length, error: null }
  }
  try {
    const profiles = await liveCall<AdsProfileDTO[]>({
      ...ctx,
      method: 'GET',
      path: '/v2/profiles',
    })
    return { ok: true, mode, profileCount: profiles.length, error: null }
  } catch (err) {
    return {
      ok: false,
      mode,
      profileCount: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
