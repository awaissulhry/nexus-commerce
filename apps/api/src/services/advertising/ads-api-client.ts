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
import { QuotaLedger, MemoryQuotaStore, RedisQuotaStore, type QuotaStore } from '../ads-core/quota-ledger.js'

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
  /**
   * ACR.0.6 — skip the OutboundApiCallLog row for this call.
   *
   * Reserved for genuine busy-waits: `fetchReport` polls a report's status every
   * 10s up to 60 times, so logging each poll would write ~60 rows per report to
   * say "still pending". The create, the download and every other ads call ARE
   * logged. Never set this to quieten a call that can fail meaningfully.
   */
  skipCallLog?: boolean
}

/**
 * Collapse ids out of an ads API path so `operation` stays low-cardinality:
 *   /reporting/reports/90a5aead-…  →  /reporting/reports/:id
 *   /sp/campaigns/123456789        →  /sp/campaigns/:id
 * Without this, every report id would become its own operation and the
 * per-operation failure counts the Control Room needs would be meaningless.
 */
function adsOperationName(method: string, path: string): string {
  const normalized = path
    .split('?')[0]
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d{6,}/g, '/:id')
  return `ads ${method} ${normalized}`
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

// ── Phase 2 — quota governance for Amazon ─────────────────────────────────
// ads-core/quota-ledger.ts existed and governed only eBay; nothing under
// services/advertising imported it. Amazon relied on bare 429/5xx retry.
//
// Amazon's rate limit is a REGIONAL queue shared across all tenants — adding
// connections does not raise throughput — so the bucket is keyed by region and
// is deliberately NOT per-profile. A per-connection bucket would let two
// profiles in the same region each believe they had the full allowance.
let _amzLedgers: { reads: QuotaLedger; writes: QuotaLedger } | null = null
async function amazonLedgers(): Promise<{ reads: QuotaLedger; writes: QuotaLedger }> {
  if (_amzLedgers) return _amzLedgers
  let store: QuotaStore
  try {
    const { redis } = await import('../../lib/queue.js')
    store = new RedisQuotaStore(() => redis.connection)
  } catch {
    store = new MemoryQuotaStore()
  }
  // Same asymmetry as eBay, for the same reason: a read that slips through on a
  // store outage costs one wasted call; an unmetered WRITE can breach the
  // shared regional quota and mutate the live account.
  _amzLedgers = {
    reads: new QuotaLedger(store, { failMode: 'open' }),
    writes: new QuotaLedger(store, { failMode: 'closed' }),
  }
  return _amzLedgers
}

const amazonBudget = (region: string) => ({
  key: `amz:ads:${region}`,
  limit: Number(process.env.NEXUS_AMAZON_ADS_REGION_BUDGET ?? 9000),
  windowSec: 3600,
})

const quotaBypassed = () => process.env.NEXUS_AMAZON_ADS_QUOTA_MODE === 'off'

export class AmazonAdsQuotaError extends Error {
  constructor(public readonly retryAfterSec: number, degraded = false) {
    super(degraded
      ? 'Amazon ads quota store unavailable (fail-closed for writes) — check Redis or set NEXUS_AMAZON_ADS_QUOTA_MODE=off for a supervised run'
      : `Amazon ads regional quota exhausted — retry in ${retryAfterSec}s`)
    this.name = 'AmazonAdsQuotaError'
  }
}

/** One unit per OUTBOUND REQUEST, including each retry — Amazon counts them all. */
async function reserveAmazon(region: string, isWrite: boolean): Promise<void> {
  if (quotaBypassed()) return
  const l = await amazonLedgers()
  const res = await (isWrite ? l.writes : l.reads).reserve(amazonBudget(region))
  if (!res.ok) throw new AmazonAdsQuotaError(res.retryAfterSec, res.degraded)
  if (res.degraded) logger.warn('[ADS-LIVE] quota ledger degraded', { region, isWrite })
}

/**
 * Retry for 429 (rate limit), 423 (ConcurrentModificationException) and 5xx.
 *
 * Four things were wrong before and are fixed here:
 *  1. `Retry-After` was never read — we guessed while Amazon was telling us.
 *  2. Backoff was deterministic, so concurrent callers retried in lockstep and
 *     re-collided. Now jittered.
 *  3. **423 was a hard failure** though Amazon documents it as retryable. It
 *     means another writer holds the entity; the correct response is to wait,
 *     not to surface an error to the operator. It gets its OWN budget because
 *     it is a contention signal, not a throughput signal — burning the 429
 *     allowance on lock contention would throttle unrelated traffic.
 *  4. A dead unreachable `fetch` sat after the loop, so an exhausted retry
 *     budget issued one final UNCOUNTED request.
 */
const RETRYABLE_STATUS = new Set([429, 423])

async function fetchWithRetry(
  url: string,
  opts: RequestInit,
  ctx: { region: string; isWrite: boolean },
  maxAttempts = 3,
  maxLockAttempts = 5,
): Promise<Response> {
  let rateAttempts = 0
  let lockAttempts = 0

  for (;;) {
    await reserveAmazon(ctx.region, ctx.isWrite)
    const res = await fetch(url, opts)
    if (res.ok) return res

    const retryable = RETRYABLE_STATUS.has(res.status) || res.status >= 500
    if (!retryable) return res

    // 423 gets its own budget — see (3) above.
    if (res.status === 423) {
      lockAttempts++
      if (lockAttempts >= maxLockAttempts) return res
    } else {
      rateAttempts++
      if (rateAttempts >= maxAttempts) return res
    }

    const attempt = res.status === 423 ? lockAttempts : rateAttempts
    const header = res.headers.get('retry-after')
    const advised = header && Number.isFinite(Number(header)) ? Number(header) * 1000 : null
    const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 8000)
    // Jitter: full-jitter over the chosen delay. Deterministic backoff makes
    // concurrent callers collide again at exactly the same moment.
    const base = advised ?? backoff
    const delayMs = Math.round(base / 2 + Math.random() * (base / 2))

    logger.warn('[ADS-LIVE] retrying', {
      status: res.status, attempt, delayMs, retryAfterHeader: header ?? null, url,
    })
    await new Promise((r) => setTimeout(r, delayMs))
  }
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
  const doCall = async (): Promise<T> => {
    const res = await fetchWithRetry(`${base}${opts.path}`, {
      method: opts.method,
      headers,
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
    }, { region: opts.region, isWrite: opts.method !== 'GET' })
    if (!res.ok) {
      const text = await res.text()
      // ACR.0.6 — carry the status and body ON the error, not only inside the
      // message. parseError() in the call-log service reads `err.statusCode` /
      // `err.body`; without them every ads failure classified as NETWORK/null,
      // which is exactly how nine nightly timeouts stayed indistinguishable
      // from an auth failure or a throttle.
      const err = new Error(`[ADS-LIVE] ${opts.method} ${opts.path} → ${res.status}: ${text}`) as Error & {
        statusCode: number; body: string
      }
      err.statusCode = res.status
      err.body = text
      throw err
    }
    return res.json() as T
  }

  if (opts.skipCallLog) return doCall()

  // ACR.0.6 — the ads client was the ONLY channel integration writing no
  // OutboundApiCallLog row. SP-API, all six eBay services, settlements, pricing
  // and refunds all record here. That gap is why a job failing on all 9 profiles
  // every night for months left no trace to query, and needed a live probe to
  // diagnose. liveCall is the single chokepoint, so one wrap covers everything.
  const { recordApiCall } = await import('../outbound-api-call-log.service.js')
  return recordApiCall<T>(
    {
      channel: 'AMAZON',
      operation: adsOperationName(opts.method, opts.path),
      endpoint: opts.path,
      method: opts.method,
      // Only retained on failure by the recorder. No credentials: headers and
      // tokens are deliberately not passed.
      requestPayload: { profileId: opts.profileId, region: opts.region, body: opts.body },
    },
    doCall,
  )
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

// Portfolios — budget-grouping containers. Amazon RETIRED the v2 endpoints (GET /v2/portfolios
// now 404s "Method Not Found"), so we use the v3 API: POST /portfolios/list + POST /portfolios
// with the vnd.spPortfolio.v3+json media type. v3 also returns the budget object, which v2 dropped.
const PORTFOLIO_V3_MIME = 'application/vnd.spPortfolio.v3+json'
export interface AdsPortfolioDTO {
  portfolioId: string; name: string; state?: string
  budgetAmount?: number | null; budgetCurrencyCode?: string | null; budgetPolicy?: string | null
  startDate?: string | null; endDate?: string | null; inBudget?: boolean | null
}
export async function listPortfolios(ctx: ClientContext): Promise<AdsPortfolioDTO[]> {
  if (adsMode() === 'sandbox') {
    return loadFixture<AdsPortfolioDTO[]>('portfolios', [
      { portfolioId: 'SB-PF-1', name: 'Brand — Core', state: 'enabled' },
      { portfolioId: 'SB-PF-2', name: 'Seasonal', state: 'enabled' },
      { portfolioId: 'SB-PF-3', name: 'Clearance', state: 'enabled' },
    ])
  }
  const resp = await liveCall<{ portfolios?: Array<Record<string, unknown>> }>({
    ...ctx, method: 'POST', path: '/portfolios/list', body: { maxResults: 100 },
    contentType: PORTFOLIO_V3_MIME, acceptHeader: PORTFOLIO_V3_MIME,
  })
  const list = Array.isArray(resp?.portfolios) ? resp.portfolios : []
  return list.map((p) => {
    const budget = (p.budget ?? {}) as Record<string, unknown>
    return {
      portfolioId: String(p.portfolioId),
      name: String(p.name ?? ''),
      state: typeof p.state === 'string' ? p.state : undefined,
      budgetAmount: typeof budget.amount === 'number' ? budget.amount : null,
      budgetCurrencyCode: typeof budget.currencyCode === 'string' ? budget.currencyCode : null,
      budgetPolicy: typeof budget.policy === 'string' ? budget.policy : null,
      startDate: typeof budget.startDate === 'string' ? budget.startDate : null,
      endDate: typeof budget.endDate === 'string' ? budget.endDate : null,
      inBudget: typeof p.inBudget === 'boolean' ? p.inBudget : null,
    }
  })
}
// PA.2 — create a portfolio (v3 POST /portfolios). Sandbox returns a generated id. The v3
// response mirrors campaign create: { portfolios: { success: [{ portfolioId }] } }.
export async function createPortfolio(ctx: ClientContext, input: { name: string; state?: 'enabled' | 'paused' }): Promise<{ ok: boolean; mode: AdsMode; externalId: string | null }> {
  if (adsMode() === 'sandbox') {
    const externalId = `sb-pf-${randomUUID().slice(0, 8)}`
    logger.info('[ADS-SANDBOX] createPortfolio', { input, externalId })
    return { ok: true, mode: 'sandbox', externalId }
  }
  const resp = await liveCall<{ portfolios?: { success?: Array<{ portfolioId?: string | number }> } | Array<{ portfolioId?: string | number }> }>({
    ...ctx, method: 'POST', path: '/portfolios',
    body: { portfolios: [{ name: input.name, state: (input.state ?? 'enabled').toUpperCase() }] }, // v3 requires UPPERCASE enum
    contentType: PORTFOLIO_V3_MIME, acceptHeader: PORTFOLIO_V3_MIME,
  })
  const bag = resp?.portfolios
  const row = Array.isArray(bag) ? bag[0] : bag?.success?.[0]
  const id = row?.portfolioId
  return { ok: true, mode: 'live', externalId: id != null ? String(id) : null }
}
// P3 — portfolio budget cap. v3 policy is 'monthlyRecurring' | 'dateRange' (dateRange needs
// start+end). currencyCode must match the connection's marketplace (EUR for IT/DE/FR/ES).
export interface PortfolioBudgetInput { amount: number; currencyCode: string; policy: 'monthlyRecurring' | 'dateRange'; startDate?: string; endDate?: string }
// P2/P3 — update a portfolio (v3 PUT /portfolios): rename + state (enabled/paused/archived) + budget.
// Sandbox no-ops.
export async function updatePortfolio(ctx: ClientContext, input: { portfolioId: string; name?: string; state?: 'enabled' | 'paused' | 'archived'; budget?: PortfolioBudgetInput }): Promise<{ ok: boolean; mode: AdsMode }> {
  if (adsMode() === 'sandbox') {
    logger.info('[ADS-SANDBOX] updatePortfolio', { input })
    return { ok: true, mode: 'sandbox' }
  }
  const pf: Record<string, unknown> = { portfolioId: input.portfolioId }
  if (input.name != null) pf.name = input.name
  if (input.state != null) pf.state = input.state.toUpperCase() // v3 requires UPPERCASE enum
  if (input.budget) {
    const b = input.budget
    pf.budget = {
      amount: b.amount, currencyCode: b.currencyCode, policy: b.policy,
      ...(b.startDate ? { startDate: b.startDate } : {}),
      ...(b.endDate ? { endDate: b.endDate } : {}),
    }
  }
  await liveCall<unknown>({
    ...ctx, method: 'PUT', path: '/portfolios', body: { portfolios: [pf] },
    contentType: PORTFOLIO_V3_MIME, acceptHeader: PORTFOLIO_V3_MIME,
  })
  return { ok: true, mode: 'live' }
}

// B — live v3 campaign-settings read. POST /sp/campaigns/list returns each campaign's
// CURRENT dynamicBidding (strategy + placementBidding %), budget and state — the
// settings the v1 export omits (placement bids) or only refreshes every 6h. Paginated
// via nextToken; defensive parse (Amazon v3 shapes vary). Sandbox returns a fixture.
export interface V3CampaignSettings {
  campaignId: string
  name?: string
  state?: string // enabled | paused | archived
  portfolioId?: string | null // Amazon's authoritative campaign→portfolio membership
  // AX-IE.0 (E4) — Amazon's authoritative AUTO|MANUAL. The v1 unified export record
  // carries no targeting type at all, so this v3 list is the only source we have.
  // Declared optional and never defaulted: if Amazon omits it we store null and the
  // bulksheet exporter emits a blank cell, because a wrong targeting type in a
  // bulksheet corrupts on re-upload while a blank one is inert.
  targetingType?: string
  dynamicBidding?: { strategy?: string; placementBidding?: Array<{ placement: string; percentage: number }> }
  budget?: { budget?: number; budgetType?: string }
}
export async function listCampaignsV3(ctx: ClientContext, opts?: { campaignIds?: string[]; states?: string[] }): Promise<V3CampaignSettings[]> {
  if (adsMode() === 'sandbox') return loadFixture<V3CampaignSettings[]>('campaigns-v3', [])
  const out: V3CampaignSettings[] = []
  let nextToken: string | undefined
  let pages = 0
  do {
    const body: Record<string, unknown> = { maxResults: 100, ...(nextToken ? { nextToken } : {}) }
    if (opts?.campaignIds?.length) body.campaignIdFilter = { include: opts.campaignIds }
    // H.12 — explicit state filter so the deletion-reconcile snapshot is deterministic + bounded.
    if (opts?.states?.length) body.stateFilter = { include: opts.states }
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

// LAUNCH-REPAIR reconcile reads — list negatives (backfill ids + audit dupes), and serving status
// (real Amazon delivery state) for campaigns and ad groups. All read-only (no write-gate).
export interface NegKwDTO { keywordId?: string; negativeKeywordId?: string; campaignId?: string; adGroupId?: string; keywordText?: string; matchType?: string; state?: string }
export async function listNegativeKeywords(ctx: ClientContext, opts: { campaignIds?: string[] }): Promise<NegKwDTO[]> {
  if (adsMode() === 'sandbox') return []
  const out: NegKwDTO[] = []; let nextToken: string | undefined; let pages = 0
  do {
    const body: Record<string, unknown> = { maxResults: 500, ...(nextToken ? { nextToken } : {}) }
    if (opts.campaignIds?.length) body.campaignIdFilter = { include: opts.campaignIds }
    const res = await liveCall<{ negativeKeywords?: NegKwDTO[]; nextToken?: string }>({
      profileId: ctx.profileId, region: ctx.region, method: 'POST', path: '/sp/negativeKeywords/list', body,
      contentType: 'application/vnd.spNegativeKeyword.v3+json', acceptHeader: 'application/vnd.spNegativeKeyword.v3+json',
    })
    for (const k of res.negativeKeywords ?? []) out.push(k)
    nextToken = res.nextToken; pages++
  } while (nextToken && pages < 50)
  return out
}

// AX-VT.4 — defaultBid was always in Amazon's response; the DTO simply never declared it, so
// nothing could verify that an ad group's bid landed as intended.
export interface AdGroupServingDTO { adGroupId?: string; campaignId?: string; name?: string; state?: string; defaultBid?: number; extendedData?: { servingStatus?: string; statusReasons?: string[] } }
export async function listAdGroupsV3(ctx: ClientContext, opts: { campaignIds?: string[]; states?: readonly string[] }): Promise<AdGroupServingDTO[]> {
  if (adsMode() === 'sandbox') return []
  const out: AdGroupServingDTO[] = []; let nextToken: string | undefined; let pages = 0
  do {
    const body: Record<string, unknown> = { maxResults: 500, includeExtendedDataFields: true, ...(nextToken ? { nextToken } : {}) }
    if (opts.campaignIds?.length) body.campaignIdFilter = { include: opts.campaignIds }
    if (opts.states?.length) body.stateFilter = { include: [...opts.states] }
    const res = await liveCall<{ adGroups?: AdGroupServingDTO[]; nextToken?: string }>({
      profileId: ctx.profileId, region: ctx.region, method: 'POST', path: '/sp/adGroups/list', body,
      contentType: 'application/vnd.spAdGroup.v3+json', acceptHeader: 'application/vnd.spAdGroup.v3+json',
    })
    for (const a of res.adGroups ?? []) out.push(a)
    nextToken = res.nextToken; pages++
  } while (nextToken && pages < 50)
  return out
}

/**
 * AX-VT.4 — the three reads a launch needs to prove fidelity, not just existence.
 *
 * Creates for these entities returned an id and nothing else, and there was no list call to
 * check them against, so "11 campaigns created" could never be upgraded to "11 campaigns
 * created AS SPECIFIED". Same pagination shape as the other v3 list calls.
 */
/**
 * AX-VT.4 — every v3 list here accepts `states`, and verification MUST pass all three.
 *
 * Amazon's v3 lists exclude ARCHIVED by default. Measured on prod: verifying three archived
 * Sponsored Display campaigns reported 50 entities as MISSING_ON_AMAZON when every one of them
 * exists and is archived exactly as our records say. That is a verifier alarming an operator
 * about campaigns they deliberately archived — indistinguishable, to them, from a real fault.
 *
 * State is one of the fields being COMPARED, so the read has to find the entity whatever state
 * it is in. `ALL_STATES` is the right default for verification specifically; callers that want
 * only live entities (the deletion-reconcile snapshot, for one) still pass their own filter.
 */
export const ALL_STATES = ['ENABLED', 'PAUSED', 'ARCHIVED'] as const

export interface KeywordDTO { keywordId?: string; campaignId?: string; adGroupId?: string; keywordText?: string; matchType?: string; state?: string; bid?: number }
export async function listKeywords(ctx: ClientContext, opts: { campaignIds?: string[]; states?: readonly string[] }): Promise<KeywordDTO[]> {
  if (adsMode() === 'sandbox') return []
  const out: KeywordDTO[] = []; let nextToken: string | undefined; let pages = 0
  do {
    const body: Record<string, unknown> = { maxResults: 500, ...(nextToken ? { nextToken } : {}) }
    if (opts.campaignIds?.length) body.campaignIdFilter = { include: opts.campaignIds }
    if (opts.states?.length) body.stateFilter = { include: [...opts.states] }
    const res = await liveCall<{ keywords?: KeywordDTO[]; nextToken?: string }>({
      profileId: ctx.profileId, region: ctx.region, method: 'POST', path: '/sp/keywords/list', body,
      contentType: 'application/vnd.spKeyword.v3+json', acceptHeader: 'application/vnd.spKeyword.v3+json',
    })
    for (const k of res.keywords ?? []) out.push(k)
    nextToken = res.nextToken; pages++
  } while (nextToken && pages < 50)
  return out
}

export interface TargetDTO { targetId?: string; campaignId?: string; adGroupId?: string; expressionType?: string; state?: string; bid?: number; expression?: Array<{ type?: string; value?: string }> }
export async function listTargets(ctx: ClientContext, opts: { campaignIds?: string[]; states?: readonly string[] }): Promise<TargetDTO[]> {
  if (adsMode() === 'sandbox') return []
  const out: TargetDTO[] = []; let nextToken: string | undefined; let pages = 0
  do {
    const body: Record<string, unknown> = { maxResults: 500, ...(nextToken ? { nextToken } : {}) }
    if (opts.campaignIds?.length) body.campaignIdFilter = { include: opts.campaignIds }
    if (opts.states?.length) body.stateFilter = { include: [...opts.states] }
    const res = await liveCall<{ targetingClauses?: TargetDTO[]; nextToken?: string }>({
      profileId: ctx.profileId, region: ctx.region, method: 'POST', path: '/sp/targets/list', body,
      contentType: 'application/vnd.spTargetingClause.v3+json', acceptHeader: 'application/vnd.spTargetingClause.v3+json',
    })
    for (const t of res.targetingClauses ?? []) out.push(t)
    nextToken = res.nextToken; pages++
  } while (nextToken && pages < 50)
  return out
}

/**
 * Sponsored Display targets live at a DIFFERENT endpoint with a different shape — `/sd/targets`,
 * plain JSON, and a GET with query params rather than a POST /list. Verifying an SD campaign's
 * targets against `/sp/targets/list` finds nothing and would report every one as missing, which
 * is the sort of false positive that makes an operator stop believing a verifier. Measured: 761
 * of the account's non-negative product targets belong to an SD campaign.
 */
export async function listSdTargets(ctx: ClientContext, opts: { externalCampaignIds?: string[] }): Promise<TargetDTO[]> {
  if (adsMode() === 'sandbox') return []
  const out: TargetDTO[] = []
  const ids = opts.externalCampaignIds ?? []
  // No campaigns asked for means nothing to verify. Returning early rather than falling through
  // to an unfiltered GET: /sd/targets with no filter pulls EVERY SD target in the account, which
  // is never what a caller wants and is an expensive way to find that out.
  if (!ids.length) return out
  // /sd/targets takes campaignIdFilter as a comma-separated query param; chunk to keep the URL sane.
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50)
    const qs = `?campaignIdFilter=${encodeURIComponent(chunk.join(','))}`
    // Errors propagate with Amazon's own message. The caller records them in `errors[]`, which
    // already forces ok:false — replacing the real reason with a generic string is how a
    // diagnosable failure becomes an afternoon of guessing.
    const res = await liveCall<Array<{ targetId?: number | string; campaignId?: number | string; adGroupId?: number | string; expression?: Array<{ type?: string; value?: string }>; state?: string; bid?: number }>>({
      profileId: ctx.profileId, region: ctx.region, method: 'GET', path: `/sd/targets${qs}`,
      contentType: 'application/json', acceptHeader: 'application/json',
    })
    for (const t of res ?? []) {
      out.push({
        targetId: t.targetId == null ? undefined : String(t.targetId),
        campaignId: t.campaignId == null ? undefined : String(t.campaignId),
        adGroupId: t.adGroupId == null ? undefined : String(t.adGroupId),
        expression: t.expression, state: t.state, bid: t.bid,
      })
    }
  }
  return out
}

/**
 * Sponsored Display campaigns / ad groups / product ads — the rest of the `/sd/*` family.
 *
 * Learned the hard and embarrassing way: `/sp/campaigns/list` does not return Sponsored Display
 * campaigns AT ALL, no matter what state filter you pass, because it is the Sponsored PRODUCTS
 * endpoint. Verifying an SD campaign against it reports the campaign, its ad groups and every one
 * of its ads as MISSING_ON_AMAZON — measured: 50 entities across three SD campaigns. I first
 * blamed archived-state filtering, "fixed" that, and got the identical result, which is what
 * finally pointed at the endpoint family rather than the filter.
 *
 * `listCampaignsServing` is also an SP call, so it is NOT an independent check for SD — it
 * returns null for an SD campaign that is perfectly healthy. Do not use it to conclude an SD
 * campaign is gone.
 *
 * All of `/sd/*` uses GET with comma-separated query filters (the older style), unlike the v3
 * POST `/list` endpoints. Same shape as listSdTargets, which is proven live.
 */
async function sdGet<T>(ctx: ClientContext, resource: string, externalCampaignIds: string[]): Promise<T[]> {
  if (adsMode() === 'sandbox') return []
  if (!externalCampaignIds.length) return []
  const out: T[] = []
  for (let i = 0; i < externalCampaignIds.length; i += 50) {
    const chunk = externalCampaignIds.slice(i, i + 50)
    const res = await liveCall<T[]>({
      profileId: ctx.profileId, region: ctx.region, method: 'GET',
      path: `/sd/${resource}?campaignIdFilter=${encodeURIComponent(chunk.join(','))}`,
      contentType: 'application/json', acceptHeader: 'application/json',
    })
    for (const r of res ?? []) out.push(r)
  }
  return out
}

export async function listSdCampaigns(ctx: ClientContext, opts: { externalCampaignIds?: string[] }): Promise<V3CampaignSettings[]> {
  const raw = await sdGet<{ campaignId?: number | string; name?: string; state?: string; portfolioId?: number | string | null; tactic?: string; budget?: number; costType?: string }>(ctx, 'campaigns', opts.externalCampaignIds ?? [])
  // Normalised onto the same DTO the SP path produces so the comparison layer stays one shape.
  // SD reports `budget` as a bare number and has no targetingType or dynamicBidding.
  return raw.map((c) => ({
    campaignId: String(c.campaignId ?? ''),
    name: c.name,
    state: c.state,
    portfolioId: c.portfolioId == null ? null : String(c.portfolioId),
    budget: c.budget == null ? undefined : { budget: c.budget, budgetType: 'DAILY' },
  }))
}

/**
 * Sponsored Brands campaigns — a THIRD family, v4, with its own mime type.
 *
 * SB was silently being read through the SP endpoints, which would have produced exactly the
 * false MISSING_ON_AMAZON storm that SD did (4 campaigns, all of them). Caught before it shipped
 * only because the SD investigation made the pattern obvious.
 */
export async function listSbCampaigns(ctx: ClientContext, opts: { externalCampaignIds?: string[] }): Promise<V3CampaignSettings[]> {
  if (adsMode() === 'sandbox') return []
  const ids = opts.externalCampaignIds ?? []
  if (!ids.length) return []
  const out: V3CampaignSettings[] = []
  let nextToken: string | undefined
  let pages = 0
  do {
    const body: Record<string, unknown> = {
      maxResults: 100,
      campaignIdFilter: { include: ids },
      ...(nextToken ? { nextToken } : {}),
    }
    const res = await liveCall<{ campaigns?: Array<{ campaignId?: number | string; name?: string; state?: string; portfolioId?: number | string | null; budget?: number; budgetType?: string }>; nextToken?: string }>({
      profileId: ctx.profileId, region: ctx.region, method: 'POST', path: '/sb/v4/campaigns/list', body,
      contentType: 'application/vnd.sbcampaignresource.v4+json',
      acceptHeader: 'application/vnd.sbcampaignresource.v4+json',
    })
    for (const c of res.campaigns ?? []) {
      out.push({
        campaignId: String(c.campaignId ?? ''),
        name: c.name,
        state: c.state,
        portfolioId: c.portfolioId == null ? null : String(c.portfolioId),
        budget: c.budget == null ? undefined : { budget: c.budget, budgetType: c.budgetType ?? 'DAILY' },
      })
    }
    nextToken = res.nextToken
    pages++
  } while (nextToken && pages < 50)
  return out
}

export async function listSdAdGroups(ctx: ClientContext, opts: { externalCampaignIds?: string[] }): Promise<AdGroupServingDTO[]> {
  const raw = await sdGet<{ adGroupId?: number | string; campaignId?: number | string; name?: string; state?: string; defaultBid?: number }>(ctx, 'adGroups', opts.externalCampaignIds ?? [])
  return raw.map((a) => ({
    adGroupId: String(a.adGroupId ?? ''),
    campaignId: a.campaignId == null ? undefined : String(a.campaignId),
    name: a.name, state: a.state, defaultBid: a.defaultBid,
  }))
}

export interface ProductAdDTO { adId?: string; campaignId?: string; adGroupId?: string; sku?: string; asin?: string; state?: string }

export async function listSdProductAds(ctx: ClientContext, opts: { externalCampaignIds?: string[] }): Promise<ProductAdDTO[]> {
  const raw = await sdGet<{ adId?: number | string; campaignId?: number | string; adGroupId?: number | string; sku?: string; asin?: string; state?: string }>(ctx, 'productAds', opts.externalCampaignIds ?? [])
  return raw.map((a) => ({
    adId: String(a.adId ?? ''),
    campaignId: a.campaignId == null ? undefined : String(a.campaignId),
    adGroupId: a.adGroupId == null ? undefined : String(a.adGroupId),
    sku: a.sku, asin: a.asin, state: a.state,
  }))
}
export async function listProductAds(ctx: ClientContext, opts: { campaignIds?: string[]; states?: readonly string[] }): Promise<ProductAdDTO[]> {
  if (adsMode() === 'sandbox') return []
  const out: ProductAdDTO[] = []; let nextToken: string | undefined; let pages = 0
  do {
    const body: Record<string, unknown> = { maxResults: 500, ...(nextToken ? { nextToken } : {}) }
    if (opts.campaignIds?.length) body.campaignIdFilter = { include: opts.campaignIds }
    if (opts.states?.length) body.stateFilter = { include: [...opts.states] }
    const res = await liveCall<{ productAds?: ProductAdDTO[]; nextToken?: string }>({
      profileId: ctx.profileId, region: ctx.region, method: 'POST', path: '/sp/productAds/list', body,
      contentType: 'application/vnd.spProductAd.v3+json', acceptHeader: 'application/vnd.spProductAd.v3+json',
    })
    for (const a of res.productAds ?? []) out.push(a)
    nextToken = res.nextToken; pages++
  } while (nextToken && pages < 50)
  return out
}

// Campaign serving status + portfolio membership (Amazon's authoritative view).
export interface CampaignServingDTO { campaignId?: string; name?: string; state?: string; portfolioId?: string | null; extendedData?: { servingStatus?: string; statusReasons?: string[] } }
export async function listCampaignsServing(ctx: ClientContext, opts: { campaignIds?: string[] }): Promise<CampaignServingDTO[]> {
  if (adsMode() === 'sandbox') return []
  const out: CampaignServingDTO[] = []; let nextToken: string | undefined; let pages = 0
  do {
    const body: Record<string, unknown> = { maxResults: 100, includeExtendedDataFields: true, ...(nextToken ? { nextToken } : {}) }
    if (opts.campaignIds?.length) body.campaignIdFilter = { include: opts.campaignIds }
    const res = await liveCall<{ campaigns?: CampaignServingDTO[]; nextToken?: string }>({
      profileId: ctx.profileId, region: ctx.region, method: 'POST', path: '/sp/campaigns/list', body,
      contentType: 'application/vnd.spCampaign.v3+json', acceptHeader: 'application/vnd.spCampaign.v3+json',
    })
    for (const c of res.campaigns ?? []) out.push(c)
    nextToken = res.nextToken; pages++
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
  name?: string
  portfolioId?: string | null
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
): Promise<{ ok: boolean; mode: AdsMode; rawResponse: unknown; error?: string | null }> {
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
  if (patch.name) v3Campaign.name = patch.name
  if (patch.portfolioId !== undefined) v3Campaign.portfolioId = patch.portfolioId
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
  const parsed = v3BatchResult(response, 'campaigns')
  return { ok: parsed.ok, mode: 'live', rawResponse: response, error: parsed.error }
}

// A3 — parse a v3 batch-mutation response. Amazon returns HTTP 200 even when an entity is
// REJECTED; the failures live in `<resource>.error[]`. liveCall already throws on non-2xx, so
// this is purely for the 2xx-with-error-body case that was previously logged as success.
// CONSERVATIVE: report failure ONLY when a recognized non-empty error array is present — any
// unknown response shape returns ok, so a shape surprise can never flip a real success to a
// false failure (no regression risk).
export function v3BatchResult(response: unknown, resourceKey: string): { ok: boolean; error: string | null } {
  const block = (response as Record<string, unknown> | null)?.[resourceKey] as { error?: unknown[] } | undefined
  if (block && typeof block === 'object' && Array.isArray(block.error) && block.error.length > 0) {
    const first = block.error[0] as Record<string, unknown>
    const detail = JSON.stringify((first?.errors as unknown) ?? first).slice(0, 240)
    return { ok: false, error: `amazon_rejected: ${detail}` }
  }
  return { ok: true, error: null }
}

export interface AdGroupPatch {
  state?: 'enabled' | 'paused' | 'archived'
  defaultBid?: number
}

export async function updateAdGroup(
  ctx: ClientContext,
  externalAdGroupId: string,
  patch: AdGroupPatch,
): Promise<{ ok: boolean; mode: AdsMode; rawResponse: unknown; error?: string | null }> {
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
  const parsed = v3BatchResult(response, 'adGroups')
  return { ok: parsed.ok, mode: 'live', rawResponse: response, error: parsed.error }
}

export interface ProductAdPatch {
  state?: 'enabled' | 'paused' | 'archived'
}

// AF.5 — toggle a product ad's state (enable/pause). v3: PUT /sp/productAds.
export async function updateProductAd(
  ctx: ClientContext,
  externalAdId: string,
  patch: ProductAdPatch,
): Promise<{ ok: boolean; mode: AdsMode; rawResponse: unknown; error?: string | null }> {
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
  const parsed = v3BatchResult(response, 'productAds')
  return { ok: parsed.ok, mode: 'live', rawResponse: response, error: parsed.error }
}

export interface TargetPatch {
  state?: 'enabled' | 'paused' | 'archived'
  bid?: number
}

/**
 * DL.1 — a target's bid/state update must go to the endpoint that owns its id.
 *
 * This function used to PUT /sp/keywords for EVERY AdTarget. That is correct only for keyword
 * targets: a product or auto target's external id is a `targetId` living under /sp/targets, so
 * Amazon answered `entityNotFoundError` at `$.keywords[0].keywordId` and rejected the write.
 *
 * Measured on live data before the fix, the split was total — 413 keyword writes APPLIED, and
 * every one of the 27 product/auto targets FAILED, forever, with zero successes ever recorded.
 * That silently disabled rank control on an entire product-targeting campaign (GALE | IT | PAT)
 * and the three auto campaigns, while the engine reported "applied" and retried every 15 minutes.
 *
 * `kind` comes from AdTarget.kind. It is optional and falls back to the keyword path, which is the
 * previous behaviour — an unknown kind therefore cannot become a NEW failure mode, and keyword
 * targets (the overwhelming majority, and the ones that already worked) are untouched.
 */
export async function updateTarget(
  ctx: ClientContext,
  externalTargetId: string,
  patch: TargetPatch,
  kind?: string | null,
): Promise<{ ok: boolean; mode: AdsMode; rawResponse: unknown; error?: string | null }> {
  // PRODUCT (ASIN/category targeting) and AUTO (close/loose/complements/substitutes) are
  // targeting clauses. Anything else — including a null kind — keeps the keyword path.
  const k = (kind ?? '').toUpperCase()
  const isTargetingClause = k === 'PRODUCT' || k === 'AUTO'

  if (adsMode() === 'sandbox') {
    logger.info('[ADS-SANDBOX] updateTarget', {
      profileId: ctx.profileId,
      externalTargetId,
      patch,
      kind: k || null,
      route: isTargetingClause ? '/sp/targets' : '/sp/keywords',
    })
    return { ok: true, mode: 'sandbox', rawResponse: { sandbox: true, patch, route: isTargetingClause ? 'targets' : 'keywords' } }
  }

  if (isTargetingClause) {
    // v3: PUT /sp/targets — same batch shape as the CREATE path already uses (POST /sp/targets
    // with `targetingClauses`), keyed by targetId rather than keywordId.
    const v3Target: Record<string, unknown> = { targetId: externalTargetId }
    if (patch.state) v3Target.state = patch.state.toUpperCase()
    if (patch.bid != null) v3Target.bid = patch.bid
    const response = await liveCall<unknown>({
      ...ctx,
      method: 'PUT',
      path: '/sp/targets',
      body: { targetingClauses: [v3Target] },
      contentType: 'application/vnd.spTargetingClause.v3+json',
      acceptHeader: 'application/vnd.spTargetingClause.v3+json',
    })
    const parsed = v3BatchResult(response, 'targetingClauses')
    return { ok: parsed.ok, mode: 'live', rawResponse: response, error: parsed.error }
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
  const parsed = v3BatchResult(response, 'keywords')
  return { ok: parsed.ok, mode: 'live', rawResponse: response, error: parsed.error }
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
  /**
   * AX-VT.1 — the portfolio the campaign is born into.
   *
   * This field's absence was the whole bug: every builder collected a portfolio
   * from the operator, `createCampaignLocal` stored it on the local row, and it
   * was silently dropped here because the interface had nowhere to put it. The
   * campaign was created on Amazon in no portfolio at all, while our UI showed
   * it inside one — 62 campaigns across 9 portfolios, none of it visible to
   * portfolio budgets or rollups on Amazon's side.
   *
   * Omitted from the request body when absent rather than sent as null: an
   * explicit null is a request to un-portfolio, which is not what "the operator
   * didn't pick one" means.
   */
  portfolioId?: string
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
    ...(input.portfolioId ? { portfolioId: input.portfolioId } : {}),
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

// NT.4 — negative KEYWORDS at ad-group level (the funnel + Auto-isolation writes).
// Amazon SP only supports NEGATIVE_EXACT / NEGATIVE_PHRASE (there is no neg-broad).
export interface CreateNegativeKeywordInput { externalCampaignId: string; externalAdGroupId: string; keywordText: string; matchType: 'EXACT' | 'PHRASE'; state?: 'enabled' | 'paused' }
export async function createNegativeKeyword(ctx: ClientContext, input: CreateNegativeKeywordInput): Promise<{ ok: boolean; mode: AdsMode; externalId: string | null; rawResponse: unknown }> {
  if (adsMode() === 'sandbox') {
    const externalId = `sb-nkw-${randomUUID().slice(0, 8)}`
    logger.info('[ADS-SANDBOX] createNegativeKeyword', { input, externalId })
    return { ok: true, mode: 'sandbox', externalId, rawResponse: { sandbox: true } }
  }
  const v3 = { campaignId: input.externalCampaignId, adGroupId: input.externalAdGroupId, keywordText: input.keywordText, matchType: `NEGATIVE_${input.matchType}`, state: (input.state ?? 'enabled').toUpperCase() }
  const response = await liveCall<{ negativeKeywords?: { success?: Array<{ keywordId?: string; negativeKeywordId?: string }> } }>({ ...ctx, method: 'POST', path: '/sp/negativeKeywords', body: { negativeKeywords: [v3] }, contentType: 'application/vnd.spNegativeKeyword.v3+json', acceptHeader: 'application/vnd.spNegativeKeyword.v3+json' })
  // v3 create returns negativeKeywordId; some shapes echo keywordId — accept either so the id is captured.
  const nk = response?.negativeKeywords?.success?.[0]
  return { ok: true, mode: 'live', externalId: nk?.negativeKeywordId ?? nk?.keywordId ?? null, rawResponse: response }
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
  /**
   * ACR.0.2 — how long to wait for Amazon to generate this report, in minutes.
   *
   * Defaults to 10, which is what every caller got before and is right for an
   * interactive path. It is NOT right for a nightly batch job: ToS-IS asked for a
   * campaigns report every night for months and every profile hit this ceiling
   * while the report was still PENDING — a 100% failure that looked like SUCCESS.
   *
   * Raise it only for background jobs, and only as far as the job's own cadence
   * tolerates: profiles are fetched in parallel, so the ceiling is roughly the
   * job's wall-clock, not a multiple of it.
   */
  pollMinutes?: number
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

  // Poll every 10s up to the caller's ceiling (default 10 minutes = 60 attempts).
  const pollMinutes = Math.max(1, Math.min(60, req.pollMinutes ?? 10))
  const maxAttempts = pollMinutes * 6
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, 10_000))
    const status = await liveCall<{
      status: string
      location?: string
      fileSize?: number
    }>({
      ...ctx,
      method: 'GET',
      path: `/reporting/reports/${reportId}`,
      // A status poll repeated every 10s; logging each one would write ~60 rows
      // per report saying "still pending". The create above and the timeout
      // below are both logged, which is what makes a stuck report visible.
      skipCallLog: true,
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

  // ACR.0.6 — record the timeout as a real failed call.
  //
  // The polls above are deliberately unlogged, and this throw happens outside
  // liveCall, so without this the single most important ads failure mode would
  // leave no row at all: create succeeds, polls are silent, then an exception
  // the caller may swallow. That is exactly how ToS-IS failed on all 9 profiles
  // nightly for months while every surface reported SUCCESS.
  const { recordApiCall } = await import('../outbound-api-call-log.service.js')
  return recordApiCall<ReportRow[]>(
    {
      channel: 'AMAZON',
      operation: 'ads report timeout GET /reporting/reports/:id',
      endpoint: `/reporting/reports/${reportId}`,
      method: 'GET',
      requestPayload: { reportId, profileId: ctx.profileId, region: ctx.region, reportType: req.reportType, waitedMinutes: pollMinutes },
    },
    async () => {
      const err = new Error(`[ADS-LIVE] report ${reportId} timed out after ${pollMinutes} minutes`) as Error & { statusCode: number }
      err.statusCode = 504 // gateway-timeout shape: we gave up waiting, Amazon did not refuse
      throw err
    },
  )
}

// ── Convenience helpers ────────────────────────────────────────────────

export function regionEndpoint(region: AdsRegion): string {
  return REGION_ENDPOINT[region]
}

// ── APS.3: product advertising eligibility ────────────────────────────
//
// POST /eligibility/product/list — Amazon's own answer to "will this actually
// serve?", which is a different question from "is it listed here". Scoping the
// picker by marketplace (APS.2b) removes products with no listing; it cannot
// see an out-of-stock ASIN, a lost buy box, or a suppressed listing. Those are
// the reasons a launched campaign quietly delivers nothing.
//
// Amazon considers this important enough to have added ASIN eligibility to
// bulksheets for parity with this API.
//
// Note VARIATION_PARENT among the reasons: a variation parent is never
// advertisable, which is why the picker asks about CHILDREN and standalones and
// never about family rows.
export type AdsEligibilityAdType = 'sp' | 'sb' | 'sd' | 'dsp'
export type AdsEligibilityOverall = 'ELIGIBLE' | 'ELIGIBLE_WITH_WARNING' | 'INELIGIBLE'
export interface AdsEligibilityStatus {
  /** e.g. NOT_IN_BUYBOX, OUT_OF_STOCK, VARIATION_PARENT, LISTING_SUPRESSED. */
  name: string
  severity: 'ELIGIBLE_WITH_WARNING' | 'INELIGIBLE' | string
  message?: string | null
  helpUrl?: string | null
}
/**
 * VERIFIED against the live IT profile 2026-07-30. The identifiers are NESTED
 * under `productDetails`, not flat on the record — the doc mirror this was
 * first written from implied otherwise, and reading the wrong level made every
 * ASIN look unanswered while Amazon was in fact replying correctly:
 *
 *   { "eligibilityStatusList": [],
 *     "overallStatus": "ELIGIBLE",
 *     "productDetails": { "asin": "B0CFB7GTV7", "globalStoreSetting": null,
 *                         "sku": "AIR-MESH-JACKET-MEN-L-BLACK" } }
 *
 * `asin`/`sku` are kept as optional top-level fields so a future flat shape
 * still parses, but `productDetails` is the observed truth.
 */
export interface AdsProductEligibility {
  asin?: string | null
  sku?: string | null
  productDetails?: { asin?: string | null; sku?: string | null; globalStoreSetting?: unknown } | null
  overallStatus: AdsEligibilityOverall
  eligibilityStatusList?: AdsEligibilityStatus[] | null
}

/** The ASIN for a record, from wherever Amazon actually put it. */
export function eligibilityAsin(r: AdsProductEligibility): string | null {
  const a = r.productDetails?.asin ?? r.asin
  return a ? String(a).toUpperCase() : null
}
/** The SKU for a record, from wherever Amazon actually put it. */
export function eligibilitySku(r: AdsProductEligibility): string | null {
  const s = r.productDetails?.sku ?? r.sku
  return s ? String(s) : null
}

/**
 * Amazon does not document a maximum list length for this endpoint. 20 is a
 * deliberately conservative chunk: small enough to be safe, large enough that a
 * 40-variation family is three calls rather than forty. Revisit with evidence,
 * not optimism.
 */
export const ELIGIBILITY_CHUNK = 20

export async function listProductEligibility(
  ctx: ClientContext,
  input: { products: Array<{ asin?: string; sku?: string }>; adType?: AdsEligibilityAdType; locale?: string },
): Promise<AdsProductEligibility[]> {
  const products = input.products.filter((p) => p.asin || p.sku)
  if (products.length === 0) return []

  if (adsMode() === 'sandbox') {
    // No fixture: report ELIGIBLE rather than inventing ineligibility, so a
    // sandbox environment never greys out a product for a reason Amazon did
    // not actually give.
    const fallback: AdsProductEligibility[] = products.map((p) => ({
      asin: p.asin ?? null, sku: p.sku ?? null, overallStatus: 'ELIGIBLE' as const, eligibilityStatusList: [],
    }))
    return loadFixture<AdsProductEligibility[]>('eligibility', fallback)
  }

  const out: AdsProductEligibility[] = []
  for (let i = 0; i < products.length; i += ELIGIBILITY_CHUNK) {
    const chunk = products.slice(i, i + ELIGIBILITY_CHUNK)
    const res = await liveCall<Record<string, unknown>>({
      profileId: ctx.profileId,
      region: ctx.region,
      method: 'POST',
      path: '/eligibility/product/list',
      body: {
        adType: input.adType ?? 'sp',
        ...(input.locale ? { locale: input.locale } : {}),
        productDetailsList: chunk.map((p) => ({ ...(p.asin ? { asin: p.asin } : {}), ...(p.sku ? { sku: p.sku } : {}) })),
      },
    })

    // The root field name came from a third-party doc mirror, so accept the
    // documented name and the obvious alternatives rather than silently
    // returning nothing if Amazon spells it differently.
    const list =
      (res.productResponseList as AdsProductEligibility[] | undefined) ??
      (res.productResponses as AdsProductEligibility[] | undefined) ??
      (Array.isArray(res) ? (res as unknown as AdsProductEligibility[]) : undefined)

    if (!list || list.length === 0) {
      // A 2xx that yields no rows is the dangerous case: it looks like success
      // and renders as "unknown" forever. Log the actual shape ONCE per call so
      // the mismatch is diagnosable instead of invisible.
      logger.warn('[ads-eligibility] 2xx with no parsable rows', {
        rootKeys: Object.keys(res ?? {}).slice(0, 12),
        sample: JSON.stringify(res ?? {}).slice(0, 900),
        requested: chunk.length,
        adType: input.adType ?? 'sp',
      })
    }
    out.push(...(list ?? []))
  }
  return out
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
