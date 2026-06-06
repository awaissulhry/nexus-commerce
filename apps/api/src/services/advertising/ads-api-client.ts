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

import { randomUUID } from 'node:crypto'
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

// B — live v3 campaign-settings read. POST /sp/campaigns/list returns each campaign's
// CURRENT dynamicBidding (strategy + placementBidding %), budget and state — the
// settings the v1 export omits (placement bids) or only refreshes every 6h. Paginated
// via nextToken; defensive parse (Amazon v3 shapes vary). Sandbox returns a fixture.
export interface V3CampaignSettings {
  campaignId: string
  name?: string
  state?: string // enabled | paused | archived
  dynamicBidding?: { strategy?: string; placementBidding?: Array<{ placement: string; percentage: number }> }
  budget?: { budget?: number; budgetType?: string }
}
export async function listCampaignsV3(ctx: ClientContext, opts?: { campaignIds?: string[] }): Promise<V3CampaignSettings[]> {
  if (adsMode() === 'sandbox') return loadFixture<V3CampaignSettings[]>('campaigns-v3', [])
  const out: V3CampaignSettings[] = []
  let nextToken: string | undefined
  let pages = 0
  do {
    const body: Record<string, unknown> = { maxResults: 100, ...(nextToken ? { nextToken } : {}) }
    if (opts?.campaignIds?.length) body.campaignIdFilter = { include: opts.campaignIds }
    const res = await liveCall<{ campaigns?: V3CampaignSettings[]; nextToken?: string }>({
      profileId: ctx.profileId,
      region: ctx.region,
      method: 'POST',
      path: '/sp/campaigns/list',
      body,
      contentType: 'application/vnd.spCampaign.v3+json',
      acceptHeader: 'application/vnd.spCampaign.v3+json',
    })
    for (const c of res.campaigns ?? []) out.push(c)
    nextToken = res.nextToken
    pages++
  } while (nextToken && pages < 50)
  return out
}

// ── Apex C.1 — Amazon theme-based bid recommendations ──────────────────────
// POST /sp/targets/bid/recommendations returns themed bid candidates per
// targeting expression (theme = CONVERSION_OPPORTUNITIES | SPECIAL_DAYS …),
// each with a suggested bid + a low/high range. This is Amazon's OWN
// recommendation — we surface it alongside the operator's own-CPC suggestion
// (ads-bid-suggest) so they can compare. Read-only (no write-gate).
//
// The exact v5 response field names are not yet pinned to the live spec, so the
// live parse is defensive and the raw payload is logged for refinement; any
// error degrades to an empty result (caller falls back to own-CPC). Sandbox
// returns [] rather than a fabricated number — honest by construction.
export type AdsBidTheme = 'CONVERSION_OPPORTUNITIES' | 'SPECIAL_DAYS' | string

export interface ThemeBidRecommendation {
  expression: string  // keyword text or ASIN
  matchType: string   // caller's match type, echoed back for join
  theme: AdsBidTheme
  suggestedBidCents: number
  rangeLowCents: number | null
  rangeHighCents: number | null
}

function amazonExprType(matchType: string): string {
  const m = (matchType || '').toUpperCase()
  if (m.includes('EXACT')) return 'KEYWORD_EXACT_MATCH'
  if (m.includes('PHRASE')) return 'KEYWORD_PHRASE_MATCH'
  if (m.includes('BROAD')) return 'KEYWORD_BROAD_MATCH'
  if (m.includes('ASIN') || m.includes('PRODUCT')) return 'ASIN_SAME_AS'
  return 'KEYWORD_BROAD_MATCH'
}

export async function getThemeBidRecommendations(
  ctx: ClientContext,
  input: {
    externalCampaignId: string
    externalAdGroupId: string
    targets: Array<{ expression: string; matchType: string }>
    biddingStrategy?: string
  },
): Promise<ThemeBidRecommendation[]> {
  if (input.targets.length === 0) return []
  if (adsMode() === 'sandbox') {
    logger.debug('[ADS-SANDBOX] getThemeBidRecommendations', { adGroupId: input.externalAdGroupId, n: input.targets.length })
    return [] // honest: no synthetic Amazon number in sandbox
  }
  const body = {
    campaignId: input.externalCampaignId,
    adGroupId: input.externalAdGroupId,
    recommendationType: 'BIDS_FOR_EXISTING_AD_GROUP',
    targetingExpressions: input.targets.map((t) => ({ type: amazonExprType(t.matchType), value: t.expression })),
    ...(input.biddingStrategy ? { bidding: { strategy: input.biddingStrategy } } : {}),
  }
  try {
    const res = await liveCall<unknown>({
      ...ctx,
      method: 'POST',
      path: '/sp/targets/bid/recommendations',
      body,
      contentType: 'application/vnd.spthemebasedbidrecommendation.v4+json',
      acceptHeader: 'application/vnd.spthemebasedbidrecommendation.v4+json',
    })
    return parseThemeBidRecommendations(res, input.targets)
  } catch (err) {
    logger.warn('[ads-api] getThemeBidRecommendations failed — degrading to own-CPC', {
      adGroupId: input.externalAdGroupId,
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}

// Defensive parser — tolerates shape drift. Amazon returns bid amounts in the
// marketplace currency (decimal units); we convert to integer cents. Joins each
// recommendation back to the requested target by expression value (order-
// preserving fallback when values are absent). Logs the raw payload once so the
// exact live shape can be confirmed and this tightened.
function parseThemeBidRecommendations(
  res: unknown,
  requested: Array<{ expression: string; matchType: string }>,
): ThemeBidRecommendation[] {
  const eurToCents = (n: unknown): number | null => {
    const v = Number(n)
    return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : null
  }
  const out: ThemeBidRecommendation[] = []
  const root = res as { bidRecommendations?: unknown[] } | undefined
  const rows = Array.isArray(root?.bidRecommendations) ? root!.bidRecommendations! : Array.isArray(res) ? (res as unknown[]) : []
  if (rows.length === 0) {
    logger.info('[ads-api] theme bid rec: empty/unrecognised payload', { sample: JSON.stringify(res)?.slice(0, 500) })
    return []
  }
  rows.forEach((raw, i) => {
    const r = raw as Record<string, unknown>
    const expr = (r.value as string) ?? (r.expressionValue as string) ?? requested[i]?.expression
    if (!expr) return
    // Amazon nests themed suggestions a few ways across versions — try the common ones.
    const suggestions = (r.bidRecommendationsForTargetingExpressions ?? r.suggestedBids ?? r.bidValues ?? [r]) as unknown[]
    for (const s of Array.isArray(suggestions) ? suggestions : [suggestions]) {
      const sv = s as Record<string, unknown>
      const mid = eurToCents(sv.suggestedBid ?? sv.recommendedBid ?? (sv.bidValue as Record<string, unknown>)?.suggested ?? sv.value)
      if (mid == null) continue
      out.push({
        expression: expr,
        matchType: requested[i]?.matchType ?? '',
        theme: (sv.theme as string) ?? (r.theme as string) ?? 'CONVERSION_OPPORTUNITIES',
        suggestedBidCents: mid,
        rangeLowCents: eurToCents(sv.rangeStart ?? sv.lowerBound ?? (sv.bidValue as Record<string, unknown>)?.rangeStart),
        rangeHighCents: eurToCents(sv.rangeEnd ?? sv.upperBound ?? (sv.bidValue as Record<string, unknown>)?.rangeEnd),
      })
      break // one (preferred-theme) suggestion per expression is enough for the UI
    }
  })
  return out
}

export interface CampaignPatch {
  state?: 'enabled' | 'paused' | 'archived'
  dailyBudget?: number
  biddingStrategy?: AdsCampaignDTO['biddingStrategy']
  endDate?: string | null
  // AX2.2 — per-placement bid adjustments (0–900%). Amazon placements:
  // PLACEMENT_TOP (top of search), PLACEMENT_PRODUCT_PAGE, PLACEMENT_REST_OF_SEARCH.
  placementBidding?: Array<{ placement: string; percentage: number }>
}

// ── Write operations — v3 SP batch PUT (intentionally not v1) ────────
//
// Phase K.1 probes confirmed v1 unified writes (PUT /campaigns,
// /adGroups, /targets, /ads — with both SP v3 and v1 unified MIME
// types, plus POST/DELETE shapes) all return 403 with the AWS SigV4
// "Invalid key=value pair (missing equal-sign) in Authorization
// header" error. Amazon's v1 write gateway requires SigV4 signed
// requests; LWA Bearer tokens (what we have) only authenticate v1
// reads/exports.
//
// SigV4 migration would need AWS IAM credentials provisioned for the
// Ads account (a DSP-tier requirement, not provided to LWA-only
// operators) plus a v4 signing implementation. Until either of those
// changes, v3 SP batch PUTs are the canonical write path for our
// auth setup. They work, they're stable, they're gated by Phase 9.
//
// If Amazon ever shifts our gateway to accept LWA Bearer for v1
// writes, this is where the migration lives — swap the path to
// /campaigns, the MIME to vnd.campaign.v1+json, and the body
// wrapping from {campaigns:[]} to a single object batch.

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
  if (patch.biddingStrategy || patch.placementBidding) {
    const map: Record<string, string> = {
      legacyForSales: 'LEGACY_FOR_SALES',
      autoForSales: 'AUTO_FOR_SALES',
      manual: 'MANUAL',
    }
    const db: Record<string, unknown> = {}
    if (patch.biddingStrategy) db.strategy = map[patch.biddingStrategy]
    if (patch.placementBidding) db.placementBidding = patch.placementBidding.map((p) => ({ placement: p.placement, percentage: p.percentage }))
    v3Campaign.dynamicBidding = db
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

export interface ProductAdPatch {
  state?: 'enabled' | 'paused' | 'archived'
}

// AF.5 — toggle a product ad's state (enable/pause). v3: PUT /sp/productAds.
export async function updateProductAd(
  ctx: ClientContext,
  externalAdId: string,
  patch: ProductAdPatch,
): Promise<{ ok: boolean; mode: AdsMode; rawResponse: unknown }> {
  if (adsMode() === 'sandbox') {
    logger.info('[ADS-SANDBOX] updateProductAd', { profileId: ctx.profileId, externalAdId, patch })
    return { ok: true, mode: 'sandbox', rawResponse: { sandbox: true, patch } }
  }
  const v3: Record<string, unknown> = { adId: externalAdId }
  if (patch.state) v3.state = patch.state.toUpperCase()
  const response = await liveCall<unknown>({
    ...ctx,
    method: 'PUT',
    path: '/sp/productAds',
    body: { productAds: [v3] },
    contentType: 'application/vnd.spProductAd.v3+json',
    acceptHeader: 'application/vnd.spProductAd.v3+json',
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

// ── CREATE (AX.4) — v3 SP POST. Same LWA-Bearer v3 path as the updates;
// sandbox short-circuits returning a generated external id so the full
// create → local-row → (later) live-sync flow exercises end-to-end. ─────

export interface CreateCampaignInput {
  name: string
  targetingType: 'MANUAL' | 'AUTO'
  dailyBudget: number // EUR units
  state?: 'enabled' | 'paused'
  startDate?: string // YYYY-MM-DD
  biddingStrategy?: 'legacyForSales' | 'autoForSales' | 'manual'
}
export async function createCampaign(ctx: ClientContext, input: CreateCampaignInput): Promise<{ ok: boolean; mode: AdsMode; externalId: string | null; rawResponse: unknown }> {
  if (adsMode() === 'sandbox') {
    const externalId = `sb-camp-${randomUUID().slice(0, 8)}`
    logger.info('[ADS-SANDBOX] createCampaign', { profileId: ctx.profileId, input, externalId })
    return { ok: true, mode: 'sandbox', externalId, rawResponse: { sandbox: true } }
  }
  const v3: Record<string, unknown> = {
    name: input.name, targetingType: input.targetingType, state: (input.state ?? 'enabled').toUpperCase(),
    budget: { budget: input.dailyBudget, budgetType: 'DAILY' },
    dynamicBidding: { strategy: { legacyForSales: 'LEGACY_FOR_SALES', autoForSales: 'AUTO_FOR_SALES', manual: 'MANUAL' }[input.biddingStrategy ?? 'legacyForSales'] },
    ...(input.startDate ? { startDate: input.startDate } : {}),
  }
  const response = await liveCall<{ campaigns?: { success?: Array<{ campaignId: string }> } }>({ ...ctx, method: 'POST', path: '/sp/campaigns', body: { campaigns: [v3] }, contentType: 'application/vnd.spCampaign.v3+json', acceptHeader: 'application/vnd.spCampaign.v3+json' })
  return { ok: true, mode: 'live', externalId: response?.campaigns?.success?.[0]?.campaignId ?? null, rawResponse: response }
}

export interface CreateAdGroupInput { externalCampaignId: string; name: string; defaultBid: number; state?: 'enabled' | 'paused' }
export async function createAdGroup(ctx: ClientContext, input: CreateAdGroupInput): Promise<{ ok: boolean; mode: AdsMode; externalId: string | null; rawResponse: unknown }> {
  if (adsMode() === 'sandbox') {
    const externalId = `sb-adg-${randomUUID().slice(0, 8)}`
    logger.info('[ADS-SANDBOX] createAdGroup', { input, externalId })
    return { ok: true, mode: 'sandbox', externalId, rawResponse: { sandbox: true } }
  }
  const v3 = { campaignId: input.externalCampaignId, name: input.name, defaultBid: input.defaultBid, state: (input.state ?? 'enabled').toUpperCase() }
  const response = await liveCall<{ adGroups?: { success?: Array<{ adGroupId: string }> } }>({ ...ctx, method: 'POST', path: '/sp/adGroups', body: { adGroups: [v3] }, contentType: 'application/vnd.spAdGroup.v3+json', acceptHeader: 'application/vnd.spAdGroup.v3+json' })
  return { ok: true, mode: 'live', externalId: response?.adGroups?.success?.[0]?.adGroupId ?? null, rawResponse: response }
}

export interface CreateKeywordInput { externalCampaignId: string; externalAdGroupId: string; keywordText: string; matchType: 'EXACT' | 'PHRASE' | 'BROAD'; bid: number; state?: 'enabled' | 'paused' }
export async function createKeyword(ctx: ClientContext, input: CreateKeywordInput): Promise<{ ok: boolean; mode: AdsMode; externalId: string | null; rawResponse: unknown }> {
  if (adsMode() === 'sandbox') {
    const externalId = `sb-kw-${randomUUID().slice(0, 8)}`
    logger.info('[ADS-SANDBOX] createKeyword', { input, externalId })
    return { ok: true, mode: 'sandbox', externalId, rawResponse: { sandbox: true } }
  }
  const v3 = { campaignId: input.externalCampaignId, adGroupId: input.externalAdGroupId, keywordText: input.keywordText, matchType: input.matchType, bid: input.bid, state: (input.state ?? 'enabled').toUpperCase() }
  const response = await liveCall<{ keywords?: { success?: Array<{ keywordId: string }> } }>({ ...ctx, method: 'POST', path: '/sp/keywords', body: { keywords: [v3] }, contentType: 'application/vnd.spKeyword.v3+json', acceptHeader: 'application/vnd.spKeyword.v3+json' })
  return { ok: true, mode: 'live', externalId: response?.keywords?.success?.[0]?.keywordId ?? null, rawResponse: response }
}

export interface CreateProductAdInput { externalCampaignId: string; externalAdGroupId: string; sku?: string; asin?: string; state?: 'enabled' | 'paused' }
export async function createProductAd(ctx: ClientContext, input: CreateProductAdInput): Promise<{ ok: boolean; mode: AdsMode; externalId: string | null; rawResponse: unknown }> {
  if (adsMode() === 'sandbox') {
    const externalId = `sb-ad-${randomUUID().slice(0, 8)}`
    logger.info('[ADS-SANDBOX] createProductAd', { input, externalId })
    return { ok: true, mode: 'sandbox', externalId, rawResponse: { sandbox: true } }
  }
  const v3: Record<string, unknown> = { campaignId: input.externalCampaignId, adGroupId: input.externalAdGroupId, state: (input.state ?? 'enabled').toUpperCase(), ...(input.sku ? { sku: input.sku } : {}), ...(input.asin ? { asin: input.asin } : {}) }
  const response = await liveCall<{ productAds?: { success?: Array<{ adId: string }> } }>({ ...ctx, method: 'POST', path: '/sp/productAds', body: { productAds: [v3] }, contentType: 'application/vnd.spProductAd.v3+json', acceptHeader: 'application/vnd.spProductAd.v3+json' })
  return { ok: true, mode: 'live', externalId: response?.productAds?.success?.[0]?.adId ?? null, rawResponse: response }
}

// ── Product / category / auto targeting (AX2.1) — v3 SP /sp/targets POST.
// expression is the Amazon targeting clause: ASIN → [{type:'asinSameAs',
// value}], category → [{type:'asinCategorySameAs', value}], auto →
// [{type:'queryHighRelMatches'|'queryBroadRelMatches'|'asinSubstituteRelated'
// |'asinAccessoryRelated'}]. ────────────────────────────────────────────
export interface CreateTargetInput {
  externalCampaignId: string; externalAdGroupId: string
  expression: Array<{ type: string; value?: string }>
  expressionType: 'MANUAL' | 'AUTO'; bid: number; state?: 'enabled' | 'paused'
}
export async function createTarget(ctx: ClientContext, input: CreateTargetInput): Promise<{ ok: boolean; mode: AdsMode; externalId: string | null; rawResponse: unknown }> {
  if (adsMode() === 'sandbox') {
    const externalId = `sb-tgt-${randomUUID().slice(0, 8)}`
    logger.info('[ADS-SANDBOX] createTarget', { input, externalId })
    return { ok: true, mode: 'sandbox', externalId, rawResponse: { sandbox: true } }
  }
  const v3 = { campaignId: input.externalCampaignId, adGroupId: input.externalAdGroupId, expressionType: input.expressionType, expression: input.expression, bid: input.bid, state: (input.state ?? 'enabled').toUpperCase() }
  const response = await liveCall<{ targetingClauses?: { success?: Array<{ targetId: string }> } }>({ ...ctx, method: 'POST', path: '/sp/targets', body: { targetingClauses: [v3] }, contentType: 'application/vnd.spTargetingClause.v3+json', acceptHeader: 'application/vnd.spTargetingClause.v3+json' })
  return { ok: true, mode: 'live', externalId: response?.targetingClauses?.success?.[0]?.targetId ?? null, rawResponse: response }
}

export interface CreateNegativeTargetInput { externalCampaignId: string; externalAdGroupId: string; asin: string; state?: 'enabled' | 'paused' }
export async function createNegativeProductTarget(ctx: ClientContext, input: CreateNegativeTargetInput): Promise<{ ok: boolean; mode: AdsMode; externalId: string | null; rawResponse: unknown }> {
  if (adsMode() === 'sandbox') {
    const externalId = `sb-ntgt-${randomUUID().slice(0, 8)}`
    logger.info('[ADS-SANDBOX] createNegativeProductTarget', { input, externalId })
    return { ok: true, mode: 'sandbox', externalId, rawResponse: { sandbox: true } }
  }
  const v3 = { campaignId: input.externalCampaignId, adGroupId: input.externalAdGroupId, expression: [{ type: 'asinSameAs', value: input.asin }], state: (input.state ?? 'enabled').toUpperCase() }
  const response = await liveCall<{ negativeTargetingClauses?: { success?: Array<{ targetId: string }> } }>({ ...ctx, method: 'POST', path: '/sp/negativeTargets', body: { negativeTargetingClauses: [v3] }, contentType: 'application/vnd.spNegativeTargetingClause.v3+json', acceptHeader: 'application/vnd.spNegativeTargetingClause.v3+json' })
  return { ok: true, mode: 'live', externalId: response?.negativeTargetingClauses?.success?.[0]?.targetId ?? null, rawResponse: response }
}

// ── Sponsored Display audience / contextual targeting (AX2.3) ───────────
// SD /sd/targets. Audience targeting expressions: remarketing on
// views/purchases, plus Amazon-built audiences (in-market / lifestyle /
// interests) by audienceId. Contextual product/category reuse the same
// asinSameAs / asinCategorySameAs clause shape as SP.
export interface CreateSdTargetInput {
  externalCampaignId: string; externalAdGroupId: string
  expression: Array<{ type: string; value?: string }>
  bid: number; state?: 'enabled' | 'paused'
}
export async function createSdTarget(ctx: ClientContext, input: CreateSdTargetInput): Promise<{ ok: boolean; mode: AdsMode; externalId: string | null; rawResponse: unknown }> {
  if (adsMode() === 'sandbox') {
    const externalId = `sb-sdtgt-${randomUUID().slice(0, 8)}`
    logger.info('[ADS-SANDBOX] createSdTarget', { input, externalId })
    return { ok: true, mode: 'sandbox', externalId, rawResponse: { sandbox: true } }
  }
  const body = [{ campaignId: input.externalCampaignId, adGroupId: input.externalAdGroupId, expression: input.expression, bid: input.bid, state: (input.state ?? 'enabled').toUpperCase() }]
  const response = await liveCall<{ success?: Array<{ targetId: string }> }>({ ...ctx, method: 'POST', path: '/sd/targets', body, contentType: 'application/json', acceptHeader: 'application/json' })
  return { ok: true, mode: 'live', externalId: response?.success?.[0]?.targetId ?? null, rawResponse: response }
}

// ── Sponsored Brands creative (AX2.9) — SB ads carry a brand creative
// (brandName + logo + headline) plus a landing destination (store page /
// product list / custom URL) and one of several creative layouts (product
// collection / store spotlight / video). Posted via the SB v4 ads endpoint. ─
export interface CreateSbAdInput {
  externalCampaignId: string; externalAdGroupId: string
  brandName: string; headline: string; logoAssetId?: string
  creativeType: 'productCollection' | 'storeSpotlight' | 'video'
  landingType: 'store' | 'productList' | 'url'; landingUrl?: string
  asins: string[]; state?: 'enabled' | 'paused'
}
export async function createSbAd(ctx: ClientContext, input: CreateSbAdInput): Promise<{ ok: boolean; mode: AdsMode; externalId: string | null; rawResponse: unknown }> {
  if (adsMode() === 'sandbox') {
    const externalId = `sb-sbad-${randomUUID().slice(0, 8)}`
    logger.info('[ADS-SANDBOX] createSbAd', { input, externalId })
    return { ok: true, mode: 'sandbox', externalId, rawResponse: { sandbox: true } }
  }
  const creative: Record<string, unknown> = {
    brandName: input.brandName, headline: input.headline,
    ...(input.logoAssetId ? { brandLogoAssetID: input.logoAssetId } : {}),
    asins: input.asins,
  }
  const landingPage: Record<string, unknown> = input.landingType === 'url' && input.landingUrl
    ? { url: input.landingUrl }
    : { pageType: input.landingType === 'store' ? 'STORE' : 'PRODUCT_LIST' }
  const body = { ads: [{ campaignId: input.externalCampaignId, adGroupId: input.externalAdGroupId, adType: input.creativeType, creative, landingPage, state: (input.state ?? 'enabled').toUpperCase() }] }
  const response = await liveCall<{ ads?: { success?: Array<{ adId: string }> } }>({ ...ctx, method: 'POST', path: '/sb/v4/ads', body, contentType: 'application/vnd.sbAdResource.v4+json', acceptHeader: 'application/vnd.sbAdResource.v4+json' })
  return { ok: true, mode: 'live', externalId: response?.ads?.success?.[0]?.adId ?? null, rawResponse: response }
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
  /** Opt-in extra report columns appended to the base set. Default behaviour is
   *  unchanged — callers that omit this get exactly the original columns. */
  extraColumns?: string[]
  /** Opt-in FULL column override (replaces the base set entirely). Needed for
   *  campaign-only reports whose allowed columns differ from the base set (e.g.
   *  the campaign group-by rejects adGroupId/keywordId/adId/orders*). The main
   *  ingestion omits this, so it is unaffected. */
  columnsOverride?: string[]
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
  let reportId: string
  try {
    const created = await liveCall<{ reportId: string }>({
      ...ctx,
      method: 'POST',
      path: '/reporting/reports',
      body: {
        name: `nexus-${req.reportType}-${req.startDate}-${req.endDate}${req.columnsOverride ? '-c' : ''}`,
        startDate: req.startDate,
        endDate: req.endDate,
        configuration: {
          adProduct: 'SPONSORED_PRODUCTS',
          groupBy: [req.reportType === 'campaigns' ? 'campaign' : req.reportType.replace(/s$/, '')],
          columns: req.columnsOverride ?? [
            'date', 'campaignId', 'adGroupId', 'keywordId', 'adId',
            'impressions', 'clicks', 'cost', 'sales1d', 'sales7d', 'sales14d',
            'orders1d', 'orders7d', 'unitsSoldClicks7d',
            ...(req.extraColumns ?? []),
          ],
          reportTypeId: `spCampaigns`,
          timeUnit: 'DAILY',
          format: 'GZIP_JSON',
        },
      },
    })
    reportId = created.reportId
  } catch (e) {
    // Amazon dedups an identical in-flight/recent report config with HTTP 425,
    // pointing to the existing reportId — reuse it instead of failing.
    const m = (e as Error).message.match(/duplicate of\s*:?\s*([0-9a-f-]{36})/i)
    if (!m) throw e
    reportId = m[1]
    logger.info('[ADS-LIVE] report dedup (425) — reusing existing report', { reportId })
  }

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
