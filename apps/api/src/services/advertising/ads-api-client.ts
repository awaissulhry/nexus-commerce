import { WorkspaceCache } from '../../lib/workspace-cache.js'
import { workspaceKey } from '@nexus/database/workspace-context'
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
 *   1. Resolve { clientId, clientSecret, refreshToken } — since CX.3a the
 *      connection core answers first (ChannelApp + the AMAZON_ADS
 *      ChannelConnection envelope) and AmazonAdsConnection.credentialsEncrypted
 *      is the fallback, behind NEXUS_CX_ADS_CREDENTIALS. See resolveCredentials.
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
import { gunzipSync } from 'node:zlib'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { logger } from '../../utils/logger.js'
import { QuotaLedger, MemoryQuotaStore, RedisQuotaStore, type QuotaStore } from '../ads-core/quota-ledger.js'
import { ADS_REGION_HOSTS, type AdsRegion } from '../ads-core/ads-regions.js'
import { sbAdCreatePath, sbAdTypeSpec } from '../ads-core/sb-ad-types.js'
import { assertNegativeWriteAllowed } from './ads-negation-policy.js'
import type { SdExpression } from './sd-target-expression.js'
import { compactDayIn, isoDayIn } from './ads-local-day.js'

export type AdsMode = 'sandbox' | 'live'

export function adsMode(): AdsMode {
  return process.env.NEXUS_AMAZON_ADS_MODE === 'live' ? 'live' : 'sandbox'
}

// P4.5b — region → host is ONE fact with one accessor (services/ads-core/ads-regions.ts).
// It was written out five times; two of the five were EU-only, which is why NA and FE
// advertising profiles were invisible to everything on this path.
export type { AdsRegion }
const REGION_ENDPOINT = ADS_REGION_HOSTS

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
  /** W1-7 — a person's negative he confirmed past a product his ads strategy protects (CreateNegativeTargetInput). */
  personConfirmed?: boolean
  /**
   * CC-25 — do not send this request again on a 5xx. A create Amazon may have made before it answered 502 or 504 must
   * not go out blindly a second time (the second gets "duplicate" and the first stays live with no link to Nexus);
   * `liveCreate` reads Amazon back first and sends again only when the entity is not there. 429 and 423 are still
   * retried: Amazon refused those before doing anything.
   */
  noServerErrorRetry?: boolean
}

/**
 * Collapse ids out of an ads API path so `operation` stays low-cardinality:
 *   /reporting/reports/90a5aead-…  →  /reporting/reports/:id
 *   /sp/campaigns/123456789        →  /sp/campaigns/:id
 * Without this, every report id would become its own operation and the
 * per-operation failure counts the Control Room needs would be meaningless.
 */
export function adsOperationName(method: string, path: string): string {
  const normalized = path
    .split('?')[0]
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d{6,}(?=\/|$)/g, '/:id')
    // Export ids are base64-ish — neither a UUID nor a digit run — so the two rules above
    // missed them and prod produced six distinct operations in a single tick
    // ("ads GET /exports/MjM3ZjhmNzIt…"), the exact cardinality explosion this exists to stop.
    //
    // Scoped tightly, because the obvious version is wrong: `[A-Za-z0-9+/=_-]{16,}` includes
    // the slash, so it swallows whole paths — "/reporting/reports" (17 chars) collapsed to
    // "/:id". This matches ONE segment, and only one that contains a digit, which real path
    // words ("reporting", "campaigns", "profiles") never do.
    .replace(/\/(?=[^/]*\d)[A-Za-z0-9+=_-]{16,}(?=\/|$)/g, '/:id')
  return `ads ${method} ${normalized}`
}

interface AdsCredentials {
  clientId: string
  clientSecret: string
  refreshToken: string
}

// In-process token cache keyed by profileId. Avoids LWA round-trips on
// every API call; tokens are evicted 60 s before their stated expiry.
const _tokenCache = new WorkspaceCache<string, { token: string; expiresAt: number }>()

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
    // gateway-exempt: OAuth token exchange (LWA refresh) — the gateway's own token source
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

/**
 * Amazon's v3/v4 APIs READ through POST — `/sp/campaigns/list`, `/sb/v4/campaigns/list`
 * and eight more. Classifying by HTTP verb alone therefore counted every one of them as
 * a WRITE, which inverts the very asymmetry the two ledgers exist to express: the write
 * ledger fails CLOSED because an unmetered write can breach the regional quota and mutate
 * the live account. A `/list` call cannot mutate anything, so on a store outage it should
 * fail OPEN like every other read.
 *
 * Found during the ACR Stage 5 SB/SD audit: a degraded Redis blocked the SB read
 * (`POST /sb/v4/campaigns/list`) while the GET-based SD read beside it sailed through —
 * so the audit reported SB unverifiable for a reason that had nothing to do with SB.
 *
 * `POST /reporting/reports` is deliberately NOT included: it creates a report job, so it
 * stays fail-closed with the writes.
 */
export function isMutatingCall(method: string, path: string): boolean {
  if (method === 'GET') return false
  const pathname = path.split('?')[0]
  return !(method === 'POST' && pathname.endsWith('/list'))
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
  ctx: { region: string; isWrite: boolean; connectionId: string | null; /** CC-25 — see LiveCallOptions.noServerErrorRetry. */ noServerErrorRetry?: boolean },
  maxAttempts = 3,
  maxLockAttempts = 5,
): Promise<Response> {
  let rateAttempts = 0
  let lockAttempts = 0
  // P1.2 — each attempt goes through the channel gateway (account state, call ledger); this loop keeps
  // the retry policy and the quota reservation, so the gateway does not retry again. No account (legacy
  // env credentials, profiles OFF) → an app-level call.
  const { adsTransport } = await import('../gateway/ads.js')
  const send = adsTransport(ctx.connectionId, { appLevel: !ctx.connectionId, maxTransientRetries: 0, max429Retries: 0 })

  for (;;) {
    await reserveAmazon(ctx.region, ctx.isWrite)
    const res = await send(url, opts)
    if (res.ok) return res

    const retryable = RETRYABLE_STATUS.has(res.status) || (res.status >= 500 && !ctx.noServerErrorRetry)
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

// ── CX.3a — where the Ads credential comes from ───────────────────────────────
// Measured on prod 2026-08-29: nine `AmazonAdsConnection` rows carried ONE
// identical `{clientId, clientSecret, refreshToken}` blob — the same client
// secret encrypted nine times, last verified 2026-05-18. The connection core
// holds it once instead: the client id/secret on `ChannelApp` (ours), the
// refresh token in the `AMAZON_ADS` `ChannelConnection` envelope (the
// operator's grant). Which store answered is logged once per process, never
// per call, and never with any credential material in it.
type AdsCredentialSource = 'core' | 'row'
const _credentialSourceLogged = new Set<AdsCredentialSource>()

/** Once per process per source — a per-call log would be 9k lines an hour. */
function logCredentialSource(source: AdsCredentialSource, detail: Record<string, unknown> = {}): void {
  if (_credentialSourceLogged.has(source)) return
  _credentialSourceLogged.add(source)
  logger.info('[ADS-LIVE] credential source', { source, ...detail })
}

/**
 * The connection core, or null when it cannot answer completely.
 *
 * Null — never a throw and never a half-answer: a missing ChannelApp secret, an
 * envelope without a refresh token or no connection row at all all mean "the
 * core is not ready", and the caller falls back to the legacy row.
 */
async function credentialsFromCore(): Promise<AdsCredentials | null> {
  // MAP.3 — DECLARED, not ambient. "The primary Amazon Ads account for this channel"
  // is a claim someone can audit; `findFirst({ channelType, isActive })` is whichever
  // row the database happened to return, which is correct only by accident while
  // exactly one Ads grant exists. `tryResolveConnection` is fail-closed: with two
  // grants and no primary it returns null and this falls back to the legacy row
  // rather than spending on a coin flip.
  const resolver = await import('../connection-resolver.service.js')
  let conn
  try {
    conn = await resolver.resolveConnection({ channel: 'AMAZON_ADS', primary: true })
  } catch (err) {
    // "No Ads grant on the core yet" and "the core is broken" are different operator
    // situations, so they are not collapsed into one silent null: the first is the
    // ordinary pre-adoption state, the second must be visible. `tryResolveConnection`
    // would swallow both.
    if (err instanceof resolver.NoConnectionError || err instanceof resolver.AmbiguousConnectionError) return null
    throw err
  }

  // The token service is the only module that decrypts a connection envelope — the
  // resolver deliberately does not return `credentialsEnc` at all — so "does this
  // connection have a usable grant?" is answered by asking for the token, not by
  // inspecting a column. `readRefreshToken` is its narrow accessor for exactly this
  // caller (CX.3b replaces it with the leased refresh).
  const { readRefreshToken } = await import('../cx/token.service.js')
  const refreshToken = await readRefreshToken(conn.id)
  if (!refreshToken) return null

  const { getChannelApp } = await import('../cx/apps.service.js')
  const app = await getChannelApp('AMAZON_ADS', 'production')
  if (!app.clientId || !app.clientSecret) return null

  return { clientId: app.clientId, clientSecret: app.clientSecret, refreshToken }
}

/**
 * CX.3a — the one function on the money path that changes.
 *
 * Nine `AmazonAdsConnection` rows carried one identical credential blob
 * (measured on prod, 2026-08-29). The connection core now holds it once, so
 * this asks the core first and falls back to the row it always read. The row
 * blobs are deliberately left in place: `NEXUS_CX_ADS_CREDENTIALS=0` is the
 * whole revert, and it restores byte-for-byte today's behaviour.
 *
 * Nothing else about the live path moves — `getLwaToken` keeps its own cache
 * and in-flight dedupe, and the deliberate bypass in `ads-debug-probe.service`
 * is left alone so a debug probe never shares production's token cache.
 */
async function resolveCredentials(profileId: string): Promise<AdsCredentials> {
  if (process.env.NEXUS_CX_ADS_CREDENTIALS !== '0') {
    try {
      const fromCore = await credentialsFromCore()
      if (fromCore) {
        logCredentialSource('core')
        return fromCore
      }
    } catch (err) {
      // A core lookup that fails must never take the bid engine down with it.
      logger.warn('[ADS-LIVE] connection-core credential lookup failed; using the legacy row', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const { default: prisma } = await import('../../db.js')
  const { decryptSecret } = await import('../../lib/crypto.js')
  // profileId='n/a' means profile-agnostic call (e.g. GET /v2/profiles).
  // Use the first active connection's credentials.
  const conn =
    profileId === 'n/a'
      ? await prisma.amazonAdsConnection.findFirst({ where: { isActive: true } })
      : await prisma.amazonAdsConnection.findUnique({ where: { workspace_profileId: workspaceKey({ profileId: profileId }) } })
  if (!conn?.credentialsEncrypted) {
    throw new Error(`[ADS-LIVE] no credentials for profileId=${profileId}`)
  }
  logCredentialSource('row', { flag: process.env.NEXUS_CX_ADS_CREDENTIALS ?? null })
  return JSON.parse(decryptSecret(conn.credentialsEncrypted)) as AdsCredentials
}

/** Narrow seam for ads-credentials-source.vitest.test.ts. Never exported to callers. */
export const __adsCredentialsTest = {
  resolveCredentials,
  resetSourceLog: () => _credentialSourceLogged.clear(),
}

/**
 * CX.3b step B — the access token, from the connection core's LEASED refresh.
 *
 * The Ads token is ACCOUNT-level, not per-profile: the profile travels in the
 * `Amazon-Advertising-API-Scope` header below, and the token request carries no
 * profile at all. So `getLwaToken`'s `profileId` cache key held up to fourteen
 * separately-minted but identical tokens, and two replicas hitting an expiry both
 * POSTed to LWA with nothing to stop them. The token service's DB lease fixes both,
 * and puts Ads failures into the same `authStatus` state machine every other channel
 * uses — a dead Ads grant becomes visible on the Channels page instead of only in a log.
 *
 * ── The cache in front of it is not an optimisation, it is required ───────────
 * `getAccessToken` reads the connection row and DECRYPTS the envelope on every call,
 * before it can even check expiry. `liveCall` is the chokepoint for the report-poll
 * and bid-drain loops, so that would be a DB round-trip plus a decrypt per Amazon
 * call. This keeps the same shape `getLwaToken` had — one entry, 60 s before expiry —
 * keyed by connection rather than by profile.
 *
 * `NEXUS_CX_ADS_LEASED_TOKEN=0` reverts to the in-process refresh. It is a SEPARATE
 * flag from `NEXUS_CX_ADS_CREDENTIALS`, because that one promises to restore the
 * credential SOURCE byte-for-byte and this changes who mints the token.
 */
const _leasedCache = new WorkspaceCache<string, { token: string; expiresAt: number }>()

async function adsAccessToken(profileId: string, creds: AdsCredentials): Promise<string> {
  if (process.env.NEXUS_CX_ADS_LEASED_TOKEN === '0') return getLwaToken(profileId, creds)
  try {
    // One grant covers every profile, so the connection — not the profile — is the key.
    const connectionId = await adsConnectionIdForToken()
    if (!connectionId) return getLwaToken(profileId, creds)

    const hit = _leasedCache.get(connectionId)
    if (hit && Date.now() < hit.expiresAt) return hit.token

    const { getAccessToken } = await import('../cx/token.service.js')
    const token = await getAccessToken(connectionId)
    // The token service owns the real expiry; this cache only has to be SHORTER than
    // it, so a conservative minute keeps the hot path off the database without ever
    // outliving the token it holds.
    _leasedCache.set(connectionId, { token, expiresAt: Date.now() + 60_000 })
    logLeasedSource()
    return token
  } catch (err) {
    // A leased failure must not take the engine down: the in-process path is exactly
    // today's behaviour, and it still has the credential.
    logger.warn('[ADS-LIVE] leased token unavailable; minting in-process', {
      error: err instanceof Error ? err.message : String(err),
    })
    return getLwaToken(profileId, creds)
  }
}

let _leasedLogged = false
function logLeasedSource(): void {
  if (_leasedLogged) return
  _leasedLogged = true
  logger.info('[ADS-LIVE] access token source', { source: 'leased' })
}

/** The one Ads grant's connection id. Declared (MAP.3), never `findFirst`. */
async function adsConnectionIdForToken(): Promise<string | null> {
  const resolver = await import('../connection-resolver.service.js')
  try {
    return (await resolver.resolveConnection({ channel: 'AMAZON_ADS', primary: true })).id
  } catch (err) {
    if (err instanceof resolver.NoConnectionError || err instanceof resolver.AmbiguousConnectionError) return null
    throw err
  }
}

export async function liveCall<T>(opts: LiveCallOptions): Promise<T> {
  // 5a — protected terms bind every negative HERE, at the one door every Amazon call passes: a negative create or a
  // negative put back to ENABLED that would block a protected term (or that Amazon's text limits refuse) is never
  // sent, whichever caller built it and whether or not it went through the write gate (ads-negation-policy.ts).
  await assertNegativeWriteAllowed(opts)
  let clientId: string
  let token: string
  let connectionId: string | null
  if (process.env.NEXUS_WORKSPACES_ENABLED === '1') {
    const { requireWorkspace, WorkspaceError } = await import('../../lib/workspace-context.js')
    const { resolveConnectionForProfile, NoConnectionError, AmbiguousConnectionError } = await import('../connection-resolver.service.js')
    requireWorkspace()
    const account = await resolveConnectionForProfile('AMAZON_ADS', opts.profileId !== 'n/a' ? opts.profileId : null, opts.region).catch(error => {
      if (error instanceof NoConnectionError || error instanceof AmbiguousConnectionError) throw new WorkspaceError('ads_account_ambiguous', 'Select one connected advertising account for this profile and region.', 409)
      throw error
    })
    const environment = (account.connectionMetadata as { environment?: string } | null)?.environment === 'sandbox' ? 'sandbox' : 'production'
    const { getChannelApp } = await import('../cx/apps.service.js')
    clientId = (await getChannelApp('AMAZON_ADS', environment)).clientId
    token = await (await import('../cx/token.service.js')).getAccessToken(account.id)
    connectionId = account.id
  } else {
    const creds = await resolveCredentials(opts.profileId)
    clientId = creds.clientId
    token = await adsAccessToken(opts.profileId, creds)
    connectionId = await adsConnectionIdForToken()
  }
  const base = REGION_ENDPOINT[opts.region]
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Amazon-Advertising-API-ClientId': clientId,
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
    }, { region: opts.region, isWrite: isMutatingCall(opts.method, opts.path), connectionId, noServerErrorRetry: opts.noServerErrorRetry })
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

// ── CC-25 — a create whose answer did not say whether it happened ────────────────────────────────────────────────────
//
// fetchWithRetry used to send a create again after any 5xx. When Amazon had made the campaign (ad group, keyword, …)
// and then answered 502 or 504, the second POST was refused as a duplicate, no id came back, and the real entity stayed
// live with no link to Nexus (for a product ad not even a local row). So a create is never sent again blindly: on a 5xx
// or no answer at all, Amazon is read back first (through the gateway, like every call here) and a match is linked;
// only when Amazon does not hold it is the create sent again. If the read itself fails, nothing is sent again — the
// caller reports the create as failed, which is safe to retry by hand, rather than risk a second live entity.

/** Where a create's id sits in Amazon's v3 answer, and how to find the entity on Amazon when the answer was lost. */
export interface CreateLookup {
  /** The v3 resource block of the answer (`campaigns`, `adGroups`, `keywords`, `productAds`, `targetingClauses`). */
  resourceKey: string
  /** The id field inside `success[]` (`campaignId`, `adGroupId`, …). */
  idField: string
  /** Amazon's id of the entity this create makes, read back from Amazon; null when Amazon does not hold it. */
  find: () => Promise<string | null>
}

/** Attempts of one create in all, as fetchWithRetry allowed before. */
const CREATE_ATTEMPTS = 3

let createRetrySleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
/** Test seam: the wait between two attempts of a create. */
export function setCreateRetrySleepForTests(sleep: ((ms: number) => Promise<void>) | null): void {
  createRetrySleep = sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
}

/** A 5xx from Amazon (or the gateway), or no answer at all: the create may or may not have happened. */
export function createOutcomeUnknown(error: unknown): boolean {
  if ((error as { name?: unknown } | null)?.name === 'GatewayNoAnswer') return true
  const status = (error as { statusCode?: unknown } | null)?.statusCode
  return typeof status === 'number' && status >= 500
}

function createdId(response: unknown, lookup: CreateLookup): string | null {
  const block = (response as Record<string, unknown> | null)?.[lookup.resourceKey] as { success?: Array<Record<string, unknown>> } | undefined
  const id = block?.success?.[0]?.[lookup.idField]
  return id == null || String(id) === '' ? null : String(id)
}

/** The create's own answer shape around an id that was found on Amazon, so every caller reads it unchanged. */
function foundAnswer(id: string, lookup: CreateLookup): Record<string, unknown> {
  return { [lookup.resourceKey]: { success: [{ index: 0, [lookup.idField]: id }], error: [] }, recoveredByReadBack: true }
}

/** One POST create through the gateway, never sent twice without first asking Amazon whether the first one landed. */
export async function liveCreate<T>(opts: LiveCallOptions, lookup: CreateLookup): Promise<T> {
  let unsure = false
  for (let attempt = 1; ; attempt++) {
    let response: T
    try {
      response = await liveCall<T>({ ...opts, noServerErrorRetry: true })
    } catch (error) {
      if (!createOutcomeUnknown(error)) throw error
      unsure = true
      let id: string | null
      try {
        id = await lookup.find()
      } catch (readError) {
        logger.warn('[CC-25] create outcome unknown and the read-back failed — not sent again', { path: opts.path, error: (error as Error).message.slice(0, 200), readError: (readError as Error).message.slice(0, 200) })
        throw new Error(`Amazon did not confirm this create (${(error as Error).message.slice(0, 160)}), and Nexus could not read back whether it was made (${(readError as Error).message.slice(0, 160)}). It was not sent again, so it cannot exist twice: check Amazon's console before trying again.`)
      }
      if (id) {
        logger.warn('[CC-25] create answered without confirmation, found on Amazon by read-back — linked, not sent again', { path: opts.path, attempt, externalId: id })
        return foundAnswer(id, lookup) as T
      }
      if (attempt >= CREATE_ATTEMPTS) throw error
      logger.warn('[CC-25] create answered without confirmation and not on Amazon — sending again', { path: opts.path, attempt })
      await createRetrySleep(Math.min(1000 * 2 ** (attempt - 1), 8000))
      continue
    }
    // A refusal right after an attempt whose outcome was unknown is most likely Amazon's "duplicate" for the entity that
    // attempt made (a list can lag a create): ask once more before reporting it as refused.
    if (unsure && !createdId(response, lookup)) {
      const id = await lookup.find().catch(() => null)
      if (id) {
        logger.warn('[CC-25] retry refused, earlier attempt found on Amazon by read-back — linked', { path: opts.path, externalId: id })
        return foundAnswer(id, lookup) as T
      }
    }
    return response
  }
}

const sameText = (a: unknown, b: unknown): boolean => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase()
const LIVE_STATES = ['ENABLED', 'PAUSED'] as const

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
/**
 * P4.5d — the Reports API v3 media type, for `POST /reporting/reports`.
 *
 * Exported because there are TWO builders on that endpoint — this client's
 * `fetchReport` and `services/advertising/ads-reports.service.ts:createReportJob` —
 * and a parity test asserts both send this exact value. Two column builders drifting
 * is how the missing media type survived in one of them for as long as it did.
 */
export const REPORT_V3_MIME = 'application/vnd.createasyncreportrequest.v3+json'

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
// Sandbox no-ops. 1a (CM-23) — Amazon answers a refused portfolio with HTTP 2xx and the reason in `portfolios.error[]`,
// like the SP batch PUTs; that answer is read now (v3BatchResult) instead of reporting every write as accepted.
export async function updatePortfolio(ctx: ClientContext, input: { portfolioId: string; name?: string; state?: 'enabled' | 'paused' | 'archived'; budget?: PortfolioBudgetInput }): Promise<{ ok: boolean; mode: AdsMode; rawResponse?: unknown; error?: string | null }> {
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
  const response = await liveCall<unknown>({
    ...ctx, method: 'PUT', path: '/portfolios', body: { portfolios: [pf] },
    contentType: PORTFOLIO_V3_MIME, acceptHeader: PORTFOLIO_V3_MIME,
  })
  const parsed = v3BatchResult(response, 'portfolios')
  return { ok: parsed.ok, mode: 'live', rawResponse: response, error: parsed.error }
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
export async function listNegativeKeywords(ctx: ClientContext, opts: { campaignIds?: string[]; /** W2-A — verification reads every state. */ states?: readonly string[] }): Promise<NegKwDTO[]> {
  if (adsMode() === 'sandbox') return []
  const out: NegKwDTO[] = []; let nextToken: string | undefined; let pages = 0
  do {
    const body: Record<string, unknown> = { maxResults: 500, ...(nextToken ? { nextToken } : {}) }
    if (opts.campaignIds?.length) body.campaignIdFilter = { include: opts.campaignIds }
    if (opts.states?.length) body.stateFilter = { include: [...opts.states] }
    const res = await liveCall<{ negativeKeywords?: NegKwDTO[]; nextToken?: string }>({
      profileId: ctx.profileId, region: ctx.region, method: 'POST', path: '/sp/negativeKeywords/list', body,
      contentType: 'application/vnd.spNegativeKeyword.v3+json', acceptHeader: 'application/vnd.spNegativeKeyword.v3+json',
    })
    for (const k of res.negativeKeywords ?? []) out.push(k)
    nextToken = res.nextToken; pages++
  } while (nextToken && pages < 50)
  return out
}

/**
 * W2-A (CC-17) — the ad-group negative product targets of some campaigns (`/sp/negativeTargets/list`), so a launch can
 * read back the negative ASINs it created. Same pagination and mime as the create (`createNegativeProductTarget`).
 */
export interface NegTargetDTO { targetId?: string; campaignId?: string; adGroupId?: string; state?: string; expression?: Array<{ type?: string; value?: string }> }
export async function listNegativeTargets(ctx: ClientContext, opts: { campaignIds?: string[]; states?: readonly string[] }): Promise<NegTargetDTO[]> {
  if (adsMode() === 'sandbox') return []
  const out: NegTargetDTO[] = []; let nextToken: string | undefined; let pages = 0
  do {
    const body: Record<string, unknown> = { maxResults: 500, ...(nextToken ? { nextToken } : {}) }
    if (opts.campaignIds?.length) body.campaignIdFilter = { include: opts.campaignIds }
    if (opts.states?.length) body.stateFilter = { include: [...opts.states] }
    const res = await liveCall<{ negativeTargetingClauses?: NegTargetDTO[]; nextToken?: string }>({
      profileId: ctx.profileId, region: ctx.region, method: 'POST', path: '/sp/negativeTargets/list', body,
      contentType: 'application/vnd.spNegativeTargetingClause.v3+json', acceptHeader: 'application/vnd.spNegativeTargetingClause.v3+json',
    })
    for (const t of res.negativeTargetingClauses ?? []) out.push(t)
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
/** W2-A (CC-1) — `adGroupIds` reads one ad group's clauses (`adGroupIdFilter`), e.g. the four auto groups Amazon made. */
export async function listTargets(ctx: ClientContext, opts: { campaignIds?: string[]; adGroupIds?: string[]; states?: readonly string[] }): Promise<TargetDTO[]> {
  if (adsMode() === 'sandbox') return []
  const out: TargetDTO[] = []; let nextToken: string | undefined; let pages = 0
  do {
    const body: Record<string, unknown> = { maxResults: 500, ...(nextToken ? { nextToken } : {}) }
    if (opts.campaignIds?.length) body.campaignIdFilter = { include: opts.campaignIds }
    if (opts.adGroupIds?.length) body.adGroupIdFilter = { include: opts.adGroupIds }
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

/** CM-8 — Amazon's own words from one v3 per-item error: every `message` it carries, else the item as JSON. */
export function amazonErrorText(item: unknown): string {
  const messages: string[] = []
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || v == null) return
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return }
    if (typeof v !== 'object') return
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'message' && typeof x === 'string' && x.trim() && !messages.includes(x.trim())) messages.push(x.trim())
      else walk(x, depth + 1)
    }
  }
  walk(item, 0)
  return (messages.length ? messages.join('; ') : JSON.stringify(item ?? null)).slice(0, 300)
}

/** CM-8 — Amazon's words from the first per-item error anywhere in a v3 answer (`{ <resource>: { error: [...] } }`), or null. */
export function v3ErrorText(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null
  for (const block of Object.values(response as Record<string, unknown>)) {
    const list = (block as { error?: unknown } | null)?.error
    if (Array.isArray(list) && list.length > 0) return amazonErrorText(list[0])
  }
  return null
}

/** CM-8 — the sentence when a create came back with neither an id nor an error. */
export const CREATE_NO_ID = 'Amazon answered without an id, so Nexus cannot confirm it exists on Amazon.'

/**
 * CM-8 — read a v3 create response (HTTP 207: `{ <resource>: { success: [...], error: [...] } }`). Only an id is a
 * create: a per-item error is Amazon's refusal, in its own words, and an answer with neither is not a create either.
 */
export function v3CreateResult(response: unknown, resourceKey: string, idField: string): { externalId: string | null; error: string | null } {
  const block = (response as Record<string, unknown> | null)?.[resourceKey] as { success?: Array<Record<string, unknown>>; error?: unknown[] } | undefined
  const id = block?.success?.[0]?.[idField]
  if (id != null && String(id) !== '') return { externalId: String(id), error: null }
  if (Array.isArray(block?.error) && block.error.length > 0) return { externalId: null, error: `Amazon refused it: ${amazonErrorText(block.error[0])}` }
  return { externalId: null, error: CREATE_NO_ID }
}

export interface AdGroupPatch {
  state?: 'enabled' | 'paused' | 'archived'
  defaultBid?: number
  /** CM-15 — SP v3 `PUT /sp/adGroups` takes the name like the state and the default bid. */
  name?: string
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
  if (patch.name) v3AdGroup.name = patch.name
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
 * ADS AUTONOMY AA-W2-13 — the archive of a campaign, an ad group, a keyword, a product target or a product ad is SP v3
 * `POST {path}/delete`, as 5f found for the negatives (below). Amazon's Sponsored Products 3.0 OpenAPI document (the same
 * file, read again 2026-10-06) gives every one of these PUTs `SponsoredProductsCreateOrUpdateEntityState` —
 * `["ENABLED","PAUSED","PROPOSED"]`, no ARCHIVED — and archives through a delete operation per entity, keyed by an id
 * filter, answered 207 with the PUT's own `{ <key>: { success, error } }` block. ARCHIVED is a state Amazon reports
 * afterwards (`SponsoredProductsEntityState`), and it is final: no PUT switches it on again.
 *
 *   campaign   DeleteSponsoredProductsCampaigns          POST /sp/campaigns/delete   { campaignIdFilter: { include } }
 *   adGroup    DeleteSponsoredProductsAdGroups           POST /sp/adGroups/delete    { adGroupIdFilter: { include } }
 *   keyword    DeleteSponsoredProductsKeywords           POST /sp/keywords/delete    { keywordIdFilter: { include } }
 *   target     DeleteSponsoredProductsTargetingClauses   POST /sp/targets/delete     { targetIdFilter: { include } }
 *   productAd  DeleteSponsoredProductsProductAds         POST /sp/productAds/delete  { adIdFilter: { include } }
 *
 * Sent this way: a deliberate archive (archive-ads marks its writes `letsGo`) and a person's own archive (the Archive
 * actions on the campaign screens, `manual` on the queue row), both in ads-sync.worker.ts. A person's archive used to go
 * out as a PUT with state ARCHIVED, which Amazon does not accept. The update functions above still PUT any state they
 * are handed.
 */
export const SP_V3_ARCHIVE = {
  campaign: { path: '/sp/campaigns/delete', mime: 'application/vnd.spCampaign.v3+json', idFilter: 'campaignIdFilter', key: 'campaigns' },
  adGroup: { path: '/sp/adGroups/delete', mime: 'application/vnd.spAdGroup.v3+json', idFilter: 'adGroupIdFilter', key: 'adGroups' },
  keyword: { path: '/sp/keywords/delete', mime: 'application/vnd.spKeyword.v3+json', idFilter: 'keywordIdFilter', key: 'keywords' },
  target: { path: '/sp/targets/delete', mime: 'application/vnd.spTargetingClause.v3+json', idFilter: 'targetIdFilter', key: 'targetingClauses' },
  productAd: { path: '/sp/productAds/delete', mime: 'application/vnd.spProductAd.v3+json', idFilter: 'adIdFilter', key: 'productAds' },
} as const
export type SpArchiveEntity = keyof typeof SP_V3_ARCHIVE

/** AA-W2-13 — archive one Sponsored Products entity at Amazon, for good (SP_V3_ARCHIVE). Through the gateway (liveCall). */
export async function archiveSpEntity(
  ctx: ClientContext,
  entity: SpArchiveEntity,
  externalId: string,
): Promise<{ ok: boolean; mode: AdsMode; rawResponse: unknown; error?: string | null }> {
  const spec = SP_V3_ARCHIVE[entity]
  if (adsMode() === 'sandbox') {
    logger.info('[ADS-SANDBOX] archiveSpEntity', { profileId: ctx.profileId, entity, externalId, route: spec.path })
    return { ok: true, mode: 'sandbox', rawResponse: { sandbox: true, operation: 'delete', route: spec.path } }
  }
  const response = await liveCall<unknown>({
    ...ctx,
    method: 'POST',
    path: spec.path,
    body: { [spec.idFilter]: { include: [externalId] } },
    contentType: spec.mime,
    acceptHeader: spec.mime,
  })
  const parsed = v3BatchResult(response, spec.key)
  return { ok: parsed.ok, mode: 'live', rawResponse: response, error: parsed.error }
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
 *
 * ── NEG.3 — the same bug, one entity class over, caught before it fired ──────────────────────
 *
 * DL.1 fixed the split between keywords and targeting clauses. It did not know about NEGATIVES,
 * because nothing had ever pushed a state to one: measured on prod 2026-08-12, **0 of the 23
 * `AD_ENTITY_STATE_UPDATE` logs are on a negative and 0 negatives have ever been enqueued for an
 * outbound write.** That is the only reason `orphanedAt` is still 0 across all 2,059 of them.
 *
 * A negative keyword has `kind = 'KEYWORD'`, so it took the `/sp/keywords` branch — but its id is
 * not a keywordId there. It lives under `/sp/negativeKeywords` (ad-group scope) or
 * `/sp/campaignNegativeKeywords` (campaign scope), which is exactly where
 * `ads-negative-kw.service.ts:61-65` creates it. The first archive would have gone to the wrong
 * endpoint, Amazon would have answered `entityNotFoundError` at `$.keywords[0].keywordId`, and
 * `isEntityGoneError` would have READ THAT AS PROOF THE NEGATIVE IS GONE — because the error is
 * keyword-shaped and the kind genuinely is KEYWORD, so DL.3's guard sees no contradiction. The
 * worker would set `orphanedAt`, which blocks every future non-forced write to the row, and
 * `isContradictoryOrphan` could not clear it for the same reason. Net effect: **live at Amazon,
 * dead in our database, permanently unwritable** — the WF.1 deadlock on a new entity class.
 *
 * So the route is decided by `(kind, isNegative, negativeLevel)`, not by `kind` alone:
 *
 *   KEYWORD · positive              → PUT /sp/keywords                 (unchanged)
 *   PRODUCT | AUTO · positive       → PUT /sp/targets                  (unchanged, DL.1)
 *   KEYWORD · negative · AD_GROUP   → PUT /sp/negativeKeywords
 *   KEYWORD · negative · CAMPAIGN   → PUT /sp/campaignNegativeKeywords
 *   PRODUCT · negative              → PUT /sp/negativeTargets
 *
 * The descriptor form is additive: a bare `kind` string still works and still means "positive",
 * so every existing caller is byte-identical.
 *
 * ── 5f — an ARCHIVE of a negative is `POST {path}/delete`, never a PUT ───────────────────────
 *
 * Amazon's SP 3.0 OpenAPI document (read 2026-10-04 from
 * `d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json`, the file the
 * reference page loads) gives the negative PUTs `SponsoredProductsCreateOrUpdateEntityState`,
 * whose enum is `["ENABLED","PAUSED","PROPOSED"]` — ARCHIVED is not accepted there. Removal is a
 * separate operation per entity, keyed by an id filter, answered 207 with the same
 * `{ <key>: { success, error } }` block the PUT returns:
 *
 *   negativeKeywords          POST /sp/negativeKeywords/delete          { negativeKeywordIdFilter: { include } }
 *   campaignNegativeKeywords  POST /sp/campaignNegativeKeywords/delete  { campaignNegativeKeywordIdFilter: { include } }
 *   negativeTargets           POST /sp/negativeTargets/delete           { negativeTargetIdFilter: { include } }
 *
 * Enable and pause stay PUT. Positive keywords and targets are not touched by this.
 */

/** NEG.3 — what decides the endpoint. A bare string is accepted and means a POSITIVE target. */
export interface TargetRoute {
  kind?: string | null
  isNegative?: boolean | null
  negativeLevel?: string | null
}

export async function updateTarget(
  ctx: ClientContext,
  externalTargetId: string,
  patch: TargetPatch,
  kindOrRoute?: string | null | TargetRoute,
): Promise<{ ok: boolean; mode: AdsMode; rawResponse: unknown; error?: string | null }> {
  const route: TargetRoute = typeof kindOrRoute === 'string'
    ? { kind: kindOrRoute }
    : (kindOrRoute ?? { kind: null })
  // PRODUCT (ASIN/category targeting) and AUTO (close/loose/complements/substitutes) are
  // targeting clauses. Anything else — including a null kind — keeps the keyword path.
  const k = (route.kind ?? '').toUpperCase()
  const isNegative = route.isNegative === true
  const level = (route.negativeLevel ?? '').toUpperCase()
  const isTargetingClause = !isNegative && (k === 'PRODUCT' || k === 'AUTO')

  // NEG.3 — the negative endpoints. Paths and mimes are the SAME constants the create path uses;
  // spelling them a second time is how two halves of one feature drift apart.
  const negRoute: { path: string; mime: string; key: string; label: string; idFilter: string } | null = !isNegative
    ? null
    : k === 'PRODUCT'
      ? { path: '/sp/negativeTargets', mime: 'application/vnd.spNegativeTargetingClause.v3+json', key: 'negativeTargetingClauses', label: 'negativeTargets', idFilter: 'negativeTargetIdFilter' }
      : level === 'CAMPAIGN'
        ? { path: '/sp/campaignNegativeKeywords', mime: 'application/vnd.spCampaignNegativeKeyword.v3+json', key: 'campaignNegativeKeywords', label: 'campaignNegativeKeywords', idFilter: 'campaignNegativeKeywordIdFilter' }
        : { path: '/sp/negativeKeywords', mime: 'application/vnd.spNegativeKeyword.v3+json', key: 'negativeKeywords', label: 'negativeKeywords', idFilter: 'negativeKeywordIdFilter' }
  // 5f — the PUT does not accept ARCHIVED for a negative; removal is its own /delete operation.
  const negDelete = negRoute != null && patch.state?.toUpperCase() === 'ARCHIVED'

  if (adsMode() === 'sandbox') {
    logger.info('[ADS-SANDBOX] updateTarget', {
      profileId: ctx.profileId,
      externalTargetId,
      patch,
      kind: k || null,
      isNegative,
      negativeLevel: level || null,
      route: negRoute ? (negDelete ? `${negRoute.path}/delete` : negRoute.path) : isTargetingClause ? '/sp/targets' : '/sp/keywords',
    })
    return { ok: true, mode: 'sandbox', rawResponse: { sandbox: true, patch, route: negRoute ? negRoute.label : isTargetingClause ? 'targets' : 'keywords', ...(negDelete ? { operation: 'delete' } : {}) } }
  }

  if (negRoute && negDelete) {
    const response = await liveCall<unknown>({
      ...ctx,
      method: 'POST',
      path: `${negRoute.path}/delete`,
      body: { [negRoute.idFilter]: { include: [externalTargetId] } },
      contentType: negRoute.mime,
      acceptHeader: negRoute.mime,
    })
    const parsed = v3BatchResult(response, negRoute.key)
    return { ok: parsed.ok, mode: 'live', rawResponse: response, error: parsed.error }
  }

  if (negRoute) {
    // A negative carries no bid, so only `state` travels. Sending a bid to these endpoints is a
    // 400 waiting to happen, and silently dropping one here is better than inventing a field
    // Amazon does not accept for the entity.
    const v3Negative: Record<string, unknown> = { keywordId: externalTargetId }
    if (k === 'PRODUCT') { delete v3Negative.keywordId; v3Negative.targetId = externalTargetId }
    if (patch.state) v3Negative.state = patch.state.toUpperCase()
    const response = await liveCall<unknown>({
      ...ctx,
      method: 'PUT',
      path: negRoute.path,
      body: { [negRoute.key]: [v3Negative] },
      contentType: negRoute.mime,
      acceptHeader: negRoute.mime,
    })
    const parsed = v3BatchResult(response, negRoute.key)
    return { ok: parsed.ok, mode: 'live', rawResponse: response, error: parsed.error }
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
  /**
   * ACR Stage 5 — return the exact payload without calling Amazon.
   *
   * Checked BEFORE the sandbox short-circuit, so a dry run answers the same way in every
   * mode. Without that ordering the SP dry run silently fell through to the sandbox branch
   * and reported "no active ads connection", which is both wrong and reassuring — the worst
   * combination for a preview whose entire job is showing the operator what will be sent.
   */
  dryRun?: boolean
}
export async function createCampaign(ctx: ClientContext, input: CreateCampaignInput): Promise<{ ok: boolean; mode: AdsMode | 'dry-run'; externalId: string | null; rawResponse: unknown; error?: string | null }> {
  const v3: Record<string, unknown> = {
    name: input.name, targetingType: input.targetingType, state: (input.state ?? 'enabled').toUpperCase(),
    budget: { budget: input.dailyBudget, budgetType: 'DAILY' },
    dynamicBidding: { strategy: { legacyForSales: 'LEGACY_FOR_SALES', autoForSales: 'AUTO_FOR_SALES', manual: 'MANUAL' }[input.biddingStrategy ?? 'legacyForSales'] },
    ...(input.startDate ? { startDate: input.startDate } : {}),
    ...(input.portfolioId ? { portfolioId: input.portfolioId } : {}),
  }
  if (input.dryRun) return { ok: true, mode: 'dry-run', externalId: null, rawResponse: { wouldSend: { method: 'POST', path: '/sp/campaigns', body: { campaigns: [v3] } } } }
  if (adsMode() === 'sandbox') {
    const externalId = `sb-camp-${randomUUID().slice(0, 8)}`
    logger.info('[ADS-SANDBOX] createCampaign', { profileId: ctx.profileId, input, externalId })
    return { ok: true, mode: 'sandbox', externalId, rawResponse: { sandbox: true } }
  }
  // CC-25 — read back by name (and targeting type) before a create is ever sent twice.
  const response = await liveCreate<{ campaigns?: { success?: Array<{ campaignId: string }> } }>(
    { ...ctx, method: 'POST', path: '/sp/campaigns', body: { campaigns: [v3] }, contentType: 'application/vnd.spCampaign.v3+json', acceptHeader: 'application/vnd.spCampaign.v3+json' },
    { resourceKey: 'campaigns', idField: 'campaignId', find: async () => {
      const live = await listCampaignsV3(ctx, { states: [...LIVE_STATES] })
      const found = live.find((c) => sameText(c.name, input.name) && (!c.targetingType || sameText(c.targetingType, input.targetingType)))
      return found?.campaignId ? String(found.campaignId) : null
    } },
  )
  // W2-A (CC-3) — ok only with Amazon's id; a 207 per-item error is Amazon's refusal, in its own words (it was `ok: true`
  // with no id and the reason thrown away, so a refused campaign was stored as a live one).
  const made = v3CreateResult(response, 'campaigns', 'campaignId')
  return { ok: made.externalId != null, mode: 'live', externalId: made.externalId, rawResponse: response, error: made.error }
}

export interface CreateAdGroupInput { externalCampaignId: string; name: string; defaultBid: number; state?: 'enabled' | 'paused' }
export async function createAdGroup(ctx: ClientContext, input: CreateAdGroupInput): Promise<{ ok: boolean; mode: AdsMode; externalId: string | null; rawResponse: unknown; error: string | null }> {
  if (adsMode() === 'sandbox') {
    const externalId = `sb-adg-${randomUUID().slice(0, 8)}`
    logger.info('[ADS-SANDBOX] createAdGroup', { input, externalId })
    return { ok: true, mode: 'sandbox', externalId, rawResponse: { sandbox: true }, error: null }
  }
  const v3 = { campaignId: input.externalCampaignId, name: input.name, defaultBid: input.defaultBid, state: (input.state ?? 'enabled').toUpperCase() }
  // CC-25 — read back by name in its campaign before a create is ever sent twice.
  const response = await liveCreate<{ adGroups?: { success?: Array<{ adGroupId: string }> } }>(
    { ...ctx, method: 'POST', path: '/sp/adGroups', body: { adGroups: [v3] }, contentType: 'application/vnd.spAdGroup.v3+json', acceptHeader: 'application/vnd.spAdGroup.v3+json' },
    { resourceKey: 'adGroups', idField: 'adGroupId', find: async () => {
      const live = await listAdGroupsV3(ctx, { campaignIds: [input.externalCampaignId], states: LIVE_STATES })
      const found = live.find((a) => sameText(a.name, input.name) && (!a.campaignId || String(a.campaignId) === input.externalCampaignId))
      return found?.adGroupId ? String(found.adGroupId) : null
    } },
  )
  // CM-8 — ok only with Amazon's id; a per-item error is returned in Amazon's words.
  const made = v3CreateResult(response, 'adGroups', 'adGroupId')
  return { ok: made.externalId != null, mode: 'live', externalId: made.externalId, rawResponse: response, error: made.error }
}

// ── ACR Stage 5 — SD and SB campaign creates ─────────────────────────────
//
// `createCampaign` above is Sponsored Products and ONLY Sponsored Products: it posts to
// `/sp/campaigns` with the `spCampaign.v3` mime and sends `targetingType` + `dynamicBidding`,
// neither of which SD accepts. `createCampaignLocal` has taken `type: 'SP' | 'SB' | 'SD'`
// since AX.4 and mapped it to the right local `adProduct` — while sending every one of them
// to the SP endpoint. Nobody noticed because no UI ever offered SB or SD.
//
// The three families disagree on nearly every convention, so these were written against the
// raw JSON of this account's own 15 SD + 4 SB campaigns (`scripts/_acr5-sbsd-shapes.mts`)
// rather than from documentation. The differences that actually bite:
//
//   field        SP (v3)              SD (legacy)            SB (v4)
//   ─────────────────────────────────────────────────────────────────────────
//   body         { campaigns: [...] } bare ARRAY             { campaigns: [...] }
//   campaignId   string               NUMBER                 string
//   startDate    YYYY-MM-DD           **YYYYMMDD**           YYYY-MM-DD
//   state        UPPERCASE            lowercase              UPPERCASE
//   budgetType   DAILY                "daily"                "DAILY"
//   extras       targetingType,       tactic, costType,      brandEntityId, goal,
//                dynamicBidding       deliveryProfile        kpi, bidding
//
// Every one of these creates a live entity that can spend money, so they all support
// `dryRun`, which returns the exact payload WITHOUT calling Amazon.

export type CreateDryRun = { ok: true; mode: 'dry-run'; externalId: null; rawResponse: { wouldSend: { method: string; path: string; body: unknown } } }

// CC-26 — the start date is the calendar day in the ACCOUNT's time zone (`timeZone`, from ads-market-time.ts). It was
// the UTC day (SB) and the server's local day (SD; the server runs in UTC), so from 00:00 to 02:00 Italian time Amazon
// was sent yesterday's date.
const sdDate = (d: Date, timeZone?: string | null): string => compactDayIn(d, timeZone)
const isoDate = (d: Date, timeZone?: string | null): string => isoDayIn(d, timeZone)

/** SD tactic: T00020 = contextual product/category targeting, T00030 = audiences (views/interests). */
export type SdTactic = 'T00020' | 'T00030'

export interface CreateSdCampaignInput {
  name: string
  dailyBudget: number
  /** Defaults to PAUSED — an SD campaign that starts enabled starts spending. */
  state?: 'enabled' | 'paused'
  tactic?: SdTactic
  costType?: 'cpc' | 'vcpm'
  startDate?: Date
  /** CC-26 — the account's IANA time zone: `startDate` (default now) is sent as the calendar day there. */
  timeZone?: string | null
  portfolioId?: string
  dryRun?: boolean
}
export async function createSdCampaign(ctx: ClientContext, input: CreateSdCampaignInput): Promise<{ ok: boolean; mode: AdsMode | 'dry-run'; externalId: string | null; rawResponse: unknown }> {
  const body = [{
    name: input.name,
    budgetType: 'daily',
    budget: input.dailyBudget,
    costType: input.costType ?? 'cpc',
    startDate: sdDate(input.startDate ?? new Date(), input.timeZone),
    state: input.state ?? 'paused',
    tactic: input.tactic ?? 'T00020',
    ...(input.portfolioId ? { portfolioId: Number(input.portfolioId) } : {}),
  }]
  if (input.dryRun) return { ok: true, mode: 'dry-run', externalId: null, rawResponse: { wouldSend: { method: 'POST', path: '/sd/campaigns', body } } }
  if (adsMode() === 'sandbox') {
    const externalId = `sb-sdcamp-${randomUUID().slice(0, 8)}`
    logger.info('[ADS-SANDBOX] createSdCampaign', { input, externalId })
    return { ok: true, mode: 'sandbox', externalId, rawResponse: { sandbox: true } }
  }
  // SD answers with a bare array of per-entity results; `code` is 'SUCCESS' on the happy path.
  const response = await liveCall<Array<{ code?: string; campaignId?: number | string; details?: string }>>({
    ...ctx, method: 'POST', path: '/sd/campaigns', body,
    contentType: 'application/json', acceptHeader: 'application/json',
  })
  const first = response?.[0]
  const id = first?.campaignId == null ? null : String(first.campaignId)
  if (!id) logger.warn('[ACR.5] createSdCampaign returned no campaignId', { response })
  return { ok: !!id, mode: 'live', externalId: id, rawResponse: response }
}

export interface CreateSdAdGroupInput {
  externalCampaignId: string
  name: string
  defaultBid: number
  state?: 'enabled' | 'paused'
  tactic?: SdTactic
  /** Amazon rejects an SD ad group whose tactic disagrees with its campaign's. */
  bidOptimization?: 'clicks' | 'conversions' | 'reach'
  creativeType?: 'IMAGE' | 'VIDEO'
  dryRun?: boolean
}
export async function createSdAdGroup(ctx: ClientContext, input: CreateSdAdGroupInput): Promise<{ ok: boolean; mode: AdsMode | 'dry-run'; externalId: string | null; rawResponse: unknown }> {
  const body = [{
    campaignId: Number(input.externalCampaignId),
    name: input.name,
    defaultBid: input.defaultBid,
    state: input.state ?? 'paused',
    tactic: input.tactic ?? 'T00020',
    bidOptimization: input.bidOptimization ?? 'conversions',
    creativeType: input.creativeType ?? 'IMAGE',
  }]
  if (input.dryRun) return { ok: true, mode: 'dry-run', externalId: null, rawResponse: { wouldSend: { method: 'POST', path: '/sd/adGroups', body } } }
  if (adsMode() === 'sandbox') {
    const externalId = `sb-sdadg-${randomUUID().slice(0, 8)}`
    logger.info('[ADS-SANDBOX] createSdAdGroup', { input, externalId })
    return { ok: true, mode: 'sandbox', externalId, rawResponse: { sandbox: true } }
  }
  const response = await liveCall<Array<{ code?: string; adGroupId?: number | string; details?: string }>>({
    ...ctx, method: 'POST', path: '/sd/adGroups', body,
    contentType: 'application/json', acceptHeader: 'application/json',
  })
  const first = response?.[0]
  const id = first?.adGroupId == null ? null : String(first.adGroupId)
  if (!id) logger.warn('[ACR.5] createSdAdGroup returned no adGroupId', { response })
  return { ok: !!id, mode: 'live', externalId: id, rawResponse: response }
}

/**
 * SB keywords — the LEGACY v3 API at `/sb/keywords`, not `/sb/v4/*`.
 *
 * Establishing this took a wrong turn worth recording. `/sb/v4/keywords/list` answers 403 with an
 * AWS-gateway error, and so does `/sb/v4/negativeKeywords/list`, which led to a premature
 * conclusion that the whole SB keyword mime family was unreachable. It was not: `GET /sb/keywords`
 * had answered **406 "No match for accept header"**, and 406 means the PATH EXISTS and only
 * content negotiation failed. Walking Accept headers against it found
 * `application/vnd.sbkeyword.v3+json`, which returns this account's real keywords.
 *
 * **406 is a lead, 404 is a dead end.** Do not read them as the same failure.
 *
 * Conventions are the SD legacy ones, not SB v4's: bare array, NUMERIC ids, lowercase
 * `matchType`/`state`, bid as a bare number.
 */
export interface SbKeywordDTO {
  keywordId?: number | string
  adGroupId?: number | string
  campaignId?: number | string
  keywordText?: string
  matchType?: string
  state?: string
  bid?: number
}
const SB_KEYWORD_MIME = 'application/vnd.sbkeyword.v3+json'

export async function listSbKeywords(ctx: ClientContext, opts: { externalCampaignIds?: string[] }): Promise<SbKeywordDTO[]> {
  if (adsMode() === 'sandbox') return []
  // The legacy endpoint takes no campaign filter in the body; filter what it returns.
  const all = await liveCall<SbKeywordDTO[]>({
    ...ctx, method: 'GET', path: '/sb/keywords', acceptHeader: SB_KEYWORD_MIME,
  })
  const want = new Set(opts.externalCampaignIds ?? [])
  return want.size ? (all ?? []).filter((k) => want.has(String(k.campaignId))) : (all ?? [])
}

/**
 * SB NEGATIVE keywords — `/sb/negativeKeywords`, `application/vnd.sbnegativekeyword.v3+json`.
 *
 * Its own mime, not the positive one: `/sb/negativeKeywords` answers 406 for
 * `vnd.sbkeyword.v3+json`. Same legacy family as `listSbKeywords`, and found the same way —
 * treating 406 as "the path exists, keep trying Accept headers".
 */
export async function listSbNegativeKeywords(ctx: ClientContext, opts: { externalCampaignIds?: string[] }): Promise<SbKeywordDTO[]> {
  if (adsMode() === 'sandbox') return []
  const all = await liveCall<SbKeywordDTO[]>({
    ...ctx, method: 'GET', path: '/sb/negativeKeywords',
    acceptHeader: 'application/vnd.sbnegativekeyword.v3+json',
  })
  const want = new Set(opts.externalCampaignIds ?? [])
  return want.size ? (all ?? []).filter((k) => want.has(String(k.campaignId))) : (all ?? [])
}

export interface CreateSbKeywordInput {
  externalCampaignId: string
  externalAdGroupId: string
  keywordText: string
  matchType: 'EXACT' | 'PHRASE' | 'BROAD'
  bid: number
  state?: 'enabled' | 'paused'
  dryRun?: boolean
}
export async function createSbKeyword(ctx: ClientContext, input: CreateSbKeywordInput): Promise<{ ok: boolean; mode: AdsMode | 'dry-run'; externalId: string | null; rawResponse: unknown }> {
  const body = [{
    campaignId: Number(input.externalCampaignId),
    adGroupId: Number(input.externalAdGroupId),
    keywordText: input.keywordText,
    matchType: input.matchType.toLowerCase(), // legacy API is lowercase, unlike SP v3
    state: input.state ?? 'enabled',
    bid: input.bid,
  }]
  if (input.dryRun) return { ok: true, mode: 'dry-run', externalId: null, rawResponse: { wouldSend: { method: 'POST', path: '/sb/keywords', body } } }
  if (adsMode() === 'sandbox') {
    const externalId = `sb-sbkw-${randomUUID().slice(0, 8)}`
    logger.info('[ADS-SANDBOX] createSbKeyword', { input, externalId })
    return { ok: true, mode: 'sandbox', externalId, rawResponse: { sandbox: true } }
  }
  const response = await liveCall<Array<{ code?: string; keywordId?: number | string; details?: string }>>({
    ...ctx, method: 'POST', path: '/sb/keywords', body,
    contentType: SB_KEYWORD_MIME, acceptHeader: SB_KEYWORD_MIME,
  })
  const first = response?.[0]
  const id = first?.keywordId == null ? null : String(first.keywordId)
  if (!id) logger.warn('[ACR.5] createSbKeyword returned no keywordId', { response })
  return { ok: !!id, mode: 'live', externalId: id, rawResponse: response }
}

/**
 * SB ad groups — `POST /sb/v4/adGroups/list`. Read-only.
 *
 * Added so `verifyLaunch` can actually check SB ad groups. Before this, SB coverage was
 * CAMPAIGN-only, so every SB ad group and ad came back `uncovered` — verification was weakest
 * at exactly the entities Stage 5 started creating.
 *
 * Returns no `defaultBid`, because the resource has none. `verifyEntity` skips any field Amazon
 * does not report, so the local ad group's bid is correctly not held against it.
 */
export interface SbAdGroupDTO { adGroupId?: string; campaignId?: string; name?: string; state?: string }
export async function listSbAdGroups(ctx: ClientContext, opts: { externalCampaignIds?: string[] }): Promise<SbAdGroupDTO[]> {
  if (adsMode() === 'sandbox') return []
  const ids = opts.externalCampaignIds ?? []
  if (!ids.length) return []
  const out: SbAdGroupDTO[] = []
  let nextToken: string | undefined
  let pages = 0
  do {
    const res = await liveCall<{ adGroups?: SbAdGroupDTO[]; nextToken?: string }>({
      profileId: ctx.profileId, region: ctx.region, method: 'POST', path: '/sb/v4/adGroups/list',
      body: { maxResults: 100, campaignIdFilter: { include: ids }, ...(nextToken ? { nextToken } : {}) },
      contentType: 'application/vnd.sbadgroupresource.v4+json',
      acceptHeader: 'application/vnd.sbadgroupresource.v4+json',
    })
    for (const g of res.adGroups ?? []) out.push(g)
    nextToken = res.nextToken
  } while (nextToken && ++pages < 20)
  return out
}

/**
 * SB ads (creatives) — `POST /sb/v4/ads/list`. Read-only.
 *
 * Exists so a new SB ad can be built from this account's OWN brand assets rather than from an
 * asset-upload flow that does not exist yet: an existing creative carries the brand logo's
 * asset-library id, the registered brand name and the store landing page, all of which are
 * required and none of which are derivable from our database.
 */
export interface SbAdDTO {
  adId?: string
  adGroupId?: string
  campaignId?: string | number
  name?: string
  state?: string
  creative?: {
    brandName?: string
    headline?: string
    brandLogoAssetID?: string
    creativeStatus?: string
    type?: string
    asins?: string[]
  }
  landingPage?: { pageType?: string; url?: string }
}
export async function listSbAds(ctx: ClientContext, opts: { externalCampaignIds?: string[] }): Promise<SbAdDTO[]> {
  if (adsMode() === 'sandbox') return []
  const ids = opts.externalCampaignIds ?? []
  if (!ids.length) return []
  const out: SbAdDTO[] = []
  let nextToken: string | undefined
  let pages = 0
  do {
    const res = await liveCall<{ ads?: SbAdDTO[]; nextToken?: string }>({
      profileId: ctx.profileId, region: ctx.region, method: 'POST', path: '/sb/v4/ads/list',
      body: { maxResults: 100, campaignIdFilter: { include: ids }, ...(nextToken ? { nextToken } : {}) },
      contentType: 'application/vnd.sbadresource.v4+json',
      acceptHeader: 'application/vnd.sbadresource.v4+json',
    })
    for (const a of res.ads ?? []) out.push(a)
    nextToken = res.nextToken
  } while (nextToken && ++pages < 20)
  return out
}

/**
 * SB ad groups — `POST /sb/v4/adGroups`, v4 mime, `{ adGroups: [...] }`.
 *
 * The fourth place `/sp/*` was hardcoded. `createAdGroupLocal` special-cased SD and let SB fall
 * through to `/sp/adGroups`, which attaches an ad group to nothing and answers 200.
 *
 * **SB ad groups carry NO defaultBid** — verified against this account's 5 live SB ad groups,
 * which return only `{adGroupId, campaignId, name, state}`. SB bids at the target level, so
 * sending a bid here is not merely redundant, it is a field the resource does not have.
 * Ids are STRINGS (SD's are numbers) and state is UPPERCASE (SD's is lowercase).
 */
export interface CreateSbAdGroupInput {
  externalCampaignId: string
  name: string
  state?: 'enabled' | 'paused'
  dryRun?: boolean
}
export async function createSbAdGroup(ctx: ClientContext, input: CreateSbAdGroupInput): Promise<{ ok: boolean; mode: AdsMode | 'dry-run'; externalId: string | null; rawResponse: unknown }> {
  const body = {
    adGroups: [{
      name: input.name,
      campaignId: input.externalCampaignId,
      state: (input.state ?? 'paused').toUpperCase(),
    }],
  }
  if (input.dryRun) return { ok: true, mode: 'dry-run', externalId: null, rawResponse: { wouldSend: { method: 'POST', path: '/sb/v4/adGroups', body } } }
  if (adsMode() === 'sandbox') {
    const externalId = `sb-sbadg-${randomUUID().slice(0, 8)}`
    logger.info('[ADS-SANDBOX] createSbAdGroup', { input, externalId })
    return { ok: true, mode: 'sandbox', externalId, rawResponse: { sandbox: true } }
  }
  const response = await liveCall<{ adGroups?: { success?: Array<{ adGroupId: string }>; error?: unknown[] } }>({
    ...ctx, method: 'POST', path: '/sb/v4/adGroups', body,
    contentType: 'application/vnd.sbadgroupresource.v4+json',
    acceptHeader: 'application/vnd.sbadgroupresource.v4+json',
  })
  const id = response?.adGroups?.success?.[0]?.adGroupId ?? null
  if (!id) logger.warn('[ACR.5] createSbAdGroup returned no adGroupId', { response })
  return { ok: !!id, mode: 'live', externalId: id, rawResponse: response }
}

export interface CreateSbCampaignInput {
  name: string
  dailyBudget: number
  /** Brand Registry binding. Read off an existing SB campaign; SB cannot be created without it. */
  brandEntityId: string
  state?: 'enabled' | 'paused'
  goal?: 'PAGE_VISIT' | 'BRAND_IMPRESSION_SHARE'
  kpi?: 'CLICKS' | 'IMPRESSIONS'
  startDate?: Date
  /** CC-26 — the account's IANA time zone: `startDate` (default now) is sent as the calendar day there. */
  timeZone?: string | null
  portfolioId?: string
  bidOptimization?: boolean
  dryRun?: boolean
}
export async function createSbCampaign(ctx: ClientContext, input: CreateSbCampaignInput): Promise<{ ok: boolean; mode: AdsMode | 'dry-run'; externalId: string | null; rawResponse: unknown }> {
  const body = {
    campaigns: [{
      name: input.name,
      budgetType: 'DAILY',
      budget: input.dailyBudget,
      costType: 'CPC',
      startDate: isoDate(input.startDate ?? new Date(), input.timeZone),
      state: (input.state ?? 'paused').toUpperCase(),
      brandEntityId: input.brandEntityId,
      goal: input.goal ?? 'PAGE_VISIT',
      kpi: input.kpi ?? 'CLICKS',
      isMultiAdGroupsEnabled: true,
      bidding: { bidOptimization: input.bidOptimization ?? false },
      ...(input.portfolioId ? { portfolioId: input.portfolioId } : {}),
    }],
  }
  if (input.dryRun) return { ok: true, mode: 'dry-run', externalId: null, rawResponse: { wouldSend: { method: 'POST', path: '/sb/v4/campaigns', body } } }
  if (adsMode() === 'sandbox') {
    const externalId = `sb-sbcamp-${randomUUID().slice(0, 8)}`
    logger.info('[ADS-SANDBOX] createSbCampaign', { input, externalId })
    return { ok: true, mode: 'sandbox', externalId, rawResponse: { sandbox: true } }
  }
  const response = await liveCall<{ campaigns?: { success?: Array<{ campaignId: string }>; error?: unknown[] } }>({
    ...ctx, method: 'POST', path: '/sb/v4/campaigns', body,
    contentType: 'application/vnd.sbcampaignresource.v4+json',
    acceptHeader: 'application/vnd.sbcampaignresource.v4+json',
  })
  const id = response?.campaigns?.success?.[0]?.campaignId ?? null
  if (!id) logger.warn('[ACR.5] createSbCampaign returned no campaignId', { response })
  return { ok: !!id, mode: 'live', externalId: id, rawResponse: response }
}

export interface CreateKeywordInput { externalCampaignId: string; externalAdGroupId: string; keywordText: string; matchType: 'EXACT' | 'PHRASE' | 'BROAD'; bid: number; state?: 'enabled' | 'paused' }
export async function createKeyword(ctx: ClientContext, input: CreateKeywordInput): Promise<{ ok: boolean; mode: AdsMode; externalId: string | null; rawResponse: unknown; error: string | null }> {
  if (adsMode() === 'sandbox') {
    const externalId = `sb-kw-${randomUUID().slice(0, 8)}`
    logger.info('[ADS-SANDBOX] createKeyword', { input, externalId })
    return { ok: true, mode: 'sandbox', externalId, rawResponse: { sandbox: true }, error: null }
  }
  const v3 = { campaignId: input.externalCampaignId, adGroupId: input.externalAdGroupId, keywordText: input.keywordText, matchType: input.matchType, bid: input.bid, state: (input.state ?? 'enabled').toUpperCase() }
  // CC-25 — read back by text and match type in its ad group before a create is ever sent twice.
  const response = await liveCreate<{ keywords?: { success?: Array<{ keywordId: string }> } }>(
    { ...ctx, method: 'POST', path: '/sp/keywords', body: { keywords: [v3] }, contentType: 'application/vnd.spKeyword.v3+json', acceptHeader: 'application/vnd.spKeyword.v3+json' },
    { resourceKey: 'keywords', idField: 'keywordId', find: async () => {
      const live = await listKeywords(ctx, { campaignIds: [input.externalCampaignId], states: LIVE_STATES })
      const found = live.find((k) => String(k.adGroupId ?? '') === input.externalAdGroupId && sameText(k.keywordText, input.keywordText) && sameText(k.matchType, input.matchType))
      return found?.keywordId ? String(found.keywordId) : null
    } },
  )
  // CM-8 — ok only with Amazon's id; a per-item error is returned in Amazon's words.
  const made = v3CreateResult(response, 'keywords', 'keywordId')
  return { ok: made.externalId != null, mode: 'live', externalId: made.externalId, rawResponse: response, error: made.error }
}

export interface CreateProductAdInput { externalCampaignId: string; externalAdGroupId: string; sku?: string; asin?: string; state?: 'enabled' | 'paused' }
export async function createProductAd(ctx: ClientContext, input: CreateProductAdInput): Promise<{ ok: boolean; mode: AdsMode; externalId: string | null; rawResponse: unknown; error: string | null }> {
  if (adsMode() === 'sandbox') {
    const externalId = `sb-ad-${randomUUID().slice(0, 8)}`
    logger.info('[ADS-SANDBOX] createProductAd', { input, externalId })
    return { ok: true, mode: 'sandbox', externalId, rawResponse: { sandbox: true }, error: null }
  }
  const v3: Record<string, unknown> = { campaignId: input.externalCampaignId, adGroupId: input.externalAdGroupId, state: (input.state ?? 'enabled').toUpperCase(), ...(input.sku ? { sku: input.sku } : {}), ...(input.asin ? { asin: input.asin } : {}) }
  // CC-25 — read back by SKU (or ASIN) in its ad group before a create is ever sent twice.
  const response = await liveCreate<{ productAds?: { success?: Array<{ adId: string }> } }>(
    { ...ctx, method: 'POST', path: '/sp/productAds', body: { productAds: [v3] }, contentType: 'application/vnd.spProductAd.v3+json', acceptHeader: 'application/vnd.spProductAd.v3+json' },
    { resourceKey: 'productAds', idField: 'adId', find: async () => {
      const live = await listProductAds(ctx, { campaignIds: [input.externalCampaignId], states: LIVE_STATES })
      const found = live.find((a) => String(a.adGroupId ?? '') === input.externalAdGroupId
        && (input.sku ? sameText(a.sku, input.sku) : !!input.asin && sameText(a.asin, input.asin)))
      return found?.adId ? String(found.adId) : null
    } },
  )
  // CM-8 — ok only with Amazon's id; a per-item error is returned in Amazon's words.
  const made = v3CreateResult(response, 'productAds', 'adId')
  return { ok: made.externalId != null, mode: 'live', externalId: made.externalId, rawResponse: response, error: made.error }
}

/**
 * ACR Stage 5 — SD product ads. `createProductAd` above is `/sp/productAds` and SP-only, so
 * routing an SD ad through it would attach the ad to nothing — the same silent failure the
 * campaign create had. Shape read off this account's 230 existing SD product ads: numeric ids,
 * lowercase state, and `sku`/`asin` side by side.
 *
 * SD accepts either identifier (unlike SP, which genuinely needs the seller SKU — see
 * `resolveSellerSku`), so prefer the SKU when we hold one and fall back to the ASIN.
 */
export interface CreateSdProductAdInput {
  externalCampaignId: string
  externalAdGroupId: string
  sku?: string
  asin?: string
  state?: 'enabled' | 'paused'
  dryRun?: boolean
}
export async function createSdProductAd(ctx: ClientContext, input: CreateSdProductAdInput): Promise<{ ok: boolean; mode: AdsMode | 'dry-run'; externalId: string | null; rawResponse: unknown }> {
  const body = [{
    campaignId: Number(input.externalCampaignId),
    adGroupId: Number(input.externalAdGroupId),
    ...(input.sku ? { sku: input.sku } : {}),
    ...(input.asin ? { asin: input.asin } : {}),
    state: input.state ?? 'paused',
  }]
  if (input.dryRun) return { ok: true, mode: 'dry-run', externalId: null, rawResponse: { wouldSend: { method: 'POST', path: '/sd/productAds', body } } }
  if (adsMode() === 'sandbox') {
    const externalId = `sb-sdad-${randomUUID().slice(0, 8)}`
    logger.info('[ADS-SANDBOX] createSdProductAd', { input, externalId })
    return { ok: true, mode: 'sandbox', externalId, rawResponse: { sandbox: true } }
  }
  const response = await liveCall<Array<{ code?: string; adId?: number | string; details?: string }>>({
    ...ctx, method: 'POST', path: '/sd/productAds', body,
    contentType: 'application/json', acceptHeader: 'application/json',
  })
  const first = response?.[0]
  const id = first?.adId == null ? null : String(first.adId)
  if (!id) logger.warn('[ACR.5] createSdProductAd returned no adId', { response })
  return { ok: !!id, mode: 'live', externalId: id, rawResponse: response }
}

// ── Product / category / auto targeting (AX2.1) — v3 SP /sp/targets POST.
// expression is the Amazon v3 targeting clause: ASIN → [{type:'ASIN_SAME_AS',
// value}], category → [{type:'ASIN_CATEGORY_SAME_AS', value}]. (The camelCase
// `asinSameAs` family is the v2 / Sponsored Display dialect — see
// sd-target-expression.ts.) ─────────────────────────────────────────────
export interface CreateTargetInput {
  externalCampaignId: string; externalAdGroupId: string
  expression: Array<{ type: string; value?: string }>
  expressionType: 'MANUAL' | 'AUTO'; bid: number; state?: 'enabled' | 'paused'
}
export async function createTarget(ctx: ClientContext, input: CreateTargetInput): Promise<{ ok: boolean; mode: AdsMode; externalId: string | null; rawResponse: unknown; error: string | null }> {
  if (adsMode() === 'sandbox') {
    const externalId = `sb-tgt-${randomUUID().slice(0, 8)}`
    logger.info('[ADS-SANDBOX] createTarget', { input, externalId })
    return { ok: true, mode: 'sandbox', externalId, rawResponse: { sandbox: true }, error: null }
  }
  const v3 = { campaignId: input.externalCampaignId, adGroupId: input.externalAdGroupId, expressionType: input.expressionType, expression: input.expression, bid: input.bid, state: (input.state ?? 'enabled').toUpperCase() }
  // CC-25 — read back by expression in its ad group before a create is ever sent twice.
  const wanted = input.expression.map((e) => `${String(e.type ?? '').toUpperCase()}=${String(e.value ?? '').trim().toLowerCase()}`).sort().join('|')
  const response = await liveCreate<{ targetingClauses?: { success?: Array<{ targetId: string }> } }>(
    { ...ctx, method: 'POST', path: '/sp/targets', body: { targetingClauses: [v3] }, contentType: 'application/vnd.spTargetingClause.v3+json', acceptHeader: 'application/vnd.spTargetingClause.v3+json' },
    { resourceKey: 'targetingClauses', idField: 'targetId', find: async () => {
      const live = await listTargets(ctx, { campaignIds: [input.externalCampaignId], states: LIVE_STATES })
      const found = live.find((t) => String(t.adGroupId ?? '') === input.externalAdGroupId
        && (t.expression ?? []).map((e) => `${String(e.type ?? '').toUpperCase()}=${String(e.value ?? '').trim().toLowerCase()}`).sort().join('|') === wanted)
      return found?.targetId ? String(found.targetId) : null
    } },
  )
  // CM-8 — ok only with Amazon's id; a per-item error is returned in Amazon's words.
  const made = v3CreateResult(response, 'targetingClauses', 'targetId')
  return { ok: made.externalId != null, mode: 'live', externalId: made.externalId, rawResponse: response, error: made.error }
}

export interface CreateNegativeTargetInput {
  externalCampaignId: string; externalAdGroupId: string; asin: string; state?: 'enabled' | 'paused'
  /**
   * W1-7 — a person confirmed this add past a product his ads strategy protects (the write gate asked him: 3A). Set only
   * by the negative write service after the gate let it through; the wire then lets that protection pass.
   */
  personConfirmed?: boolean
}
export async function createNegativeProductTarget(ctx: ClientContext, input: CreateNegativeTargetInput): Promise<{ ok: boolean; mode: AdsMode; externalId: string | null; rawResponse: unknown }> {
  // CC-18 — the v3 predicate type, as the positive /sp/targets path sends it. Amazon's SP 3.0 document
  // (`SponsoredProductsCreateOrUpdateNegativeTargetingExpressionPredicateType`) allows only `ASIN_SAME_AS` and
  // `ASIN_BRAND_SAME_AS`; the v2 `asinSameAs` sent here before is not in it. Needs one live confirmation.
  const v3 = { campaignId: input.externalCampaignId, adGroupId: input.externalAdGroupId, expression: [{ type: 'ASIN_SAME_AS', value: input.asin }], state: (input.state ?? 'enabled').toUpperCase() }
  if (adsMode() === 'sandbox') {
    // 5a — sandbox refuses what liveCall would refuse.
    await assertNegativeWriteAllowed({ method: 'POST', path: '/sp/negativeTargets', body: { negativeTargetingClauses: [v3] }, personConfirmed: input.personConfirmed === true })
    const externalId = `sb-ntgt-${randomUUID().slice(0, 8)}`
    logger.info('[ADS-SANDBOX] createNegativeProductTarget', { input, externalId })
    return { ok: true, mode: 'sandbox', externalId, rawResponse: { sandbox: true } }
  }
  const response = await liveCall<{ negativeTargetingClauses?: { success?: Array<{ targetId: string }> } }>({ ...ctx, method: 'POST', path: '/sp/negativeTargets', body: { negativeTargetingClauses: [v3] }, contentType: 'application/vnd.spNegativeTargetingClause.v3+json', acceptHeader: 'application/vnd.spNegativeTargetingClause.v3+json', personConfirmed: input.personConfirmed === true })
  return { ok: true, mode: 'live', externalId: response?.negativeTargetingClauses?.success?.[0]?.targetId ?? null, rawResponse: response }
}

// NT.4 — negative KEYWORDS at ad-group level (the funnel + Auto-isolation writes).
// Amazon SP only supports NEGATIVE_EXACT / NEGATIVE_PHRASE (there is no neg-broad).
export interface CreateNegativeKeywordInput { externalCampaignId: string; externalAdGroupId: string; keywordText: string; matchType: 'EXACT' | 'PHRASE'; state?: 'enabled' | 'paused' }
export async function createNegativeKeyword(ctx: ClientContext, input: CreateNegativeKeywordInput): Promise<{ ok: boolean; mode: AdsMode; externalId: string | null; rawResponse: unknown }> {
  const v3 = { campaignId: input.externalCampaignId, adGroupId: input.externalAdGroupId, keywordText: input.keywordText, matchType: `NEGATIVE_${input.matchType}`, state: (input.state ?? 'enabled').toUpperCase() }
  if (adsMode() === 'sandbox') {
    // 5a — sandbox refuses what liveCall would refuse.
    await assertNegativeWriteAllowed({ method: 'POST', path: '/sp/negativeKeywords', body: { negativeKeywords: [v3] } })
    const externalId = `sb-nkw-${randomUUID().slice(0, 8)}`
    logger.info('[ADS-SANDBOX] createNegativeKeyword', { input, externalId })
    return { ok: true, mode: 'sandbox', externalId, rawResponse: { sandbox: true } }
  }
  const response = await liveCall<{ negativeKeywords?: { success?: Array<{ keywordId?: string; negativeKeywordId?: string }> } }>({ ...ctx, method: 'POST', path: '/sp/negativeKeywords', body: { negativeKeywords: [v3] }, contentType: 'application/vnd.spNegativeKeyword.v3+json', acceptHeader: 'application/vnd.spNegativeKeyword.v3+json' })
  // v3 create returns negativeKeywordId; some shapes echo keywordId — accept either so the id is captured.
  const nk = response?.negativeKeywords?.success?.[0]
  return { ok: true, mode: 'live', externalId: nk?.negativeKeywordId ?? nk?.keywordId ?? null, rawResponse: response }
}

// ── Sponsored Display audience / contextual targeting (AX2.3) ───────────
// SD /sd/targets. CC-12 — SD's own dialect, from Amazon's SD 3.0 document (`CreateTargetingClause`): a bare array,
// a NUMERIC adGroupId, `expressionType: 'manual'`, lowercase state, and SD predicate types (`asinSameAs`, nested
// `views` / `purchases` with a lookback) built by `sdTargetExpression` (sd-target-expression.ts). It used to send the SP
// shape (UPPERCASE state, string ids, `ASIN_SAME_AS`, no expressionType) and read `.success`, which SD never answers —
// so even an accepted target came back without its id. Needs one live confirmation: no SD target create has run yet.
export interface CreateSdTargetInput {
  /** Not part of Amazon's create clause (a target belongs to its ad group); kept for the callers' logs. */
  externalCampaignId?: string
  externalAdGroupId: string
  /** The SD-native expression — see `sdTargetExpression`. */
  expression: SdExpression
  bid: number; state?: 'enabled' | 'paused'
  dryRun?: boolean
}
/** The `/sd/targets` create body for one target. Pure, so the shape is testable without a network. */
export function sdTargetCreateBody(input: CreateSdTargetInput): Array<Record<string, unknown>> {
  return [{
    adGroupId: Number(input.externalAdGroupId),
    expressionType: 'manual',
    expression: input.expression,
    bid: input.bid,
    state: input.state ?? 'enabled',
  }]
}
/**
 * Read an SD create answer: a bare array of `{ code, description, targetId }` (HTTP 207). Only an id is a create; any
 * other item is Amazon's refusal in its own words.
 */
export function sdCreateResult(response: unknown, idField: string): { externalId: string | null; error: string | null } {
  const first = Array.isArray(response) ? (response[0] as Record<string, unknown> | undefined) : undefined
  const id = first?.[idField]
  if (id != null && String(id) !== '') return { externalId: String(id), error: null }
  if (first && (first.code || first.description || first.details)) {
    return { externalId: null, error: `Amazon refused it: ${[first.code, first.description ?? first.details].filter(Boolean).join(' — ')}`.slice(0, 300) }
  }
  return { externalId: null, error: CREATE_NO_ID }
}
export async function createSdTarget(ctx: ClientContext, input: CreateSdTargetInput): Promise<{ ok: boolean; mode: AdsMode | 'dry-run'; externalId: string | null; rawResponse: unknown; error: string | null }> {
  const body = sdTargetCreateBody(input)
  if (input.dryRun) return { ok: true, mode: 'dry-run', externalId: null, rawResponse: { wouldSend: { method: 'POST', path: '/sd/targets', body } }, error: null }
  if (adsMode() === 'sandbox') {
    const externalId = `sb-sdtgt-${randomUUID().slice(0, 8)}`
    logger.info('[ADS-SANDBOX] createSdTarget', { input, externalId })
    return { ok: true, mode: 'sandbox', externalId, rawResponse: { sandbox: true }, error: null }
  }
  const response = await liveCall<Array<{ code?: string; description?: string; targetId?: number | string }>>({ ...ctx, method: 'POST', path: '/sd/targets', body, contentType: 'application/json', acceptHeader: 'application/json' })
  const made = sdCreateResult(response, 'targetId')
  if (!made.externalId) logger.warn('[CC-12] createSdTarget returned no targetId', { response })
  return { ok: made.externalId != null, mode: 'live', externalId: made.externalId, rawResponse: response, error: made.error }
}

// ── Sponsored Brands creative (AX2.9) — SB ads carry a brand creative
// (brandName + logo + headline) plus a landing destination (store page /
// product list / custom URL) and one of several creative layouts (product
// collection / store spotlight / video). Posted via the SB v4 ads endpoint. ─
export interface CreateSbAdInput {
  externalCampaignId: string; externalAdGroupId: string
  brandName: string; headline: string; logoAssetId?: string
  creativeType: 'productCollection' | 'manualCollection' | 'storeSpotlight' | 'video'
  landingType: 'store' | 'productList' | 'url'; landingUrl?: string
  asins: string[]; state?: 'enabled' | 'paused'
  /**
   * Amazon REQUIRES a name on every create endpoint (`CreateProductCollectionAd.required`
   * includes it, and so does every sibling). The old body did not send one at all. When the
   * caller does not supply a name the headline is used — a label the operator already typed,
   * not a wire value invented here.
   */
  name?: string
}
/**
 * P4.5f (2026-09-21) — the create request, built from Amazon's Sponsored Brands **4.0 OpenAPI
 * document** rather than from a guess. Pure, so every type's shape is testable without a network.
 *
 * 🔴 What this replaced, and why it could never have worked:
 *
 *   POST /sb/v4/ads  { ads: [{ campaignId, adGroupId, adType, creative, landingPage, state }] }
 *
 *   1. `/sb/v4/ads` accepts **PUT only** (`UpdateSponsoredBrandsAds`). There is no POST on it.
 *   2. `adType` does not exist — **0 occurrences** in the whole 4.0 document.
 *   3. `campaignId` is not a field of a create-ad item; an ad belongs to its ad group.
 *   4. `name` is **required** on every create endpoint, and was not sent.
 *
 * Creation is **one endpoint per creative type**, and their bodies genuinely differ, so the shape
 * comes from the type's own spec rather than one template with optional bits.
 */
export function sbAdCreateRequest(input: CreateSbAdInput): { path: string; body: { ads: Array<Record<string, unknown>> } } {
  const spec = sbAdTypeSpec(input.creativeType)

  if (spec.asinsRequired && input.asins.length === 0) {
    throw new Error(`[ads] a Sponsored Brands "${spec.label}" creative requires at least one ASIN — nothing was sent`)
  }

  const landingPage: Record<string, unknown> =
    input.landingType === 'url' && input.landingUrl
      ? { url: input.landingUrl }
      : { pageType: input.landingType === 'store' ? 'STORE' : 'PRODUCT_LIST' }

  const creative: Record<string, unknown> = {
    brandName: input.brandName,
    ...(spec.headlineField ? { [spec.headlineField]: input.headline } : {}),
    ...(input.logoAssetId ? { brandLogoAssetID: input.logoAssetId } : {}),
    ...(input.asins.length > 0 ? { asins: input.asins } : {}),
    // manualCollection carries its landing page INSIDE the creative; the others do not have one there.
    ...(spec.landingPageOn === 'creative' ? { landingPage } : {}),
  }

  const ad: Record<string, unknown> = {
    adGroupId: input.externalAdGroupId,
    name: input.name ?? input.headline,
    state: (input.state ?? 'enabled').toUpperCase(),
    creative,
    ...(spec.landingPageOn === 'ad' ? { landingPage } : {}),
  }

  return { path: sbAdCreatePath(input.creativeType), body: { ads: [ad] } }
}

export async function createSbAd(ctx: ClientContext, input: CreateSbAdInput): Promise<{ ok: boolean; mode: AdsMode; externalId: string | null; rawResponse: unknown }> {
  if (adsMode() === 'sandbox') {
    const externalId = `sb-sbad-${randomUUID().slice(0, 8)}`
    logger.info('[ADS-SANDBOX] createSbAd', { input, externalId })
    return { ok: true, mode: 'sandbox', externalId, rawResponse: { sandbox: true } }
  }
  const { path: createPath, body } = sbAdCreateRequest(input)
  const response = await liveCall<{ ads?: { success?: Array<{ adId: string }> } }>({
    ...ctx,
    method: 'POST',
    path: createPath,
    body,
    contentType: 'application/vnd.sbAdResource.v4+json',
    acceptHeader: 'application/vnd.sbAdResource.v4+json',
  })
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
      // P4.5d — the Reports v3 media type. `ads-reports.service.ts:createReportJob`
      // has always sent it on the SAME endpoint; this builder never did.
      //
      // 🟡 A drift, not a breakage. Measured on 1,197 real `POST /reporting/reports`
      // rows: **1,135 answered 200** without it, and the failures are all `400
      // invalid column` from deliberate probes plus one documented `425` dedupe —
      // which are answers Amazon can only give after PARSING the body. There is not a
      // single 415. Amazon accepts `application/json` today.
      //
      // It is corrected anyway because the drift is what is dangerous: two builders,
      // one endpoint, and a media type Amazon documents as required. The parity test
      // below now holds them equal, which is the part that outlives this line.
      contentType: REPORT_V3_MIME,
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
      /**
       * 🔴 Amazon returns the presigned download URL as `url`, NOT `location`.
       * Verified live 2026-08-05 on a COMPLETED report: keys are
       * {configuration, createdAt, endDate, failureReason, fileSize, generatedAt, name,
       *  reportId, startDate, status, updatedAt, url, urlExpiresAt} — no `location` at all.
       * Both are accepted below so this cannot break if Amazon ever sends the other.
       */
      url?: string
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
    // ── 🔴 ACR.0.2-bis, 2026-08-05 ─────────────────────────────────────────────────────────
    // This condition read `status.status === 'COMPLETED' && status.location`. Amazon sends the
    // URL as `url`, so `status.location` was ALWAYS undefined and a finished report fell
    // through to the "pending" branch and polled until the ceiling.
    //
    // That is the real cause of twelve consecutive nights of tos-is-ingest `errors=9`, and it
    // means the earlier fix — raising the ceiling 10 → 45 minutes — could not have worked: the
    // measured report took **26 seconds** to generate (createdAt 19:52:11 → generatedAt
    // 19:52:37, fileSize 9,944). A longer ceiling only fails more slowly.
    //
    // Another two-vocabularies defect, the same class as EXACT/_EXACT and isNegative.
    const downloadUrl = status.url ?? status.location
    if (status.status === 'COMPLETED' && downloadUrl) {
      logger.info('[ADS-LIVE] report ready, downloading', { reportId, fileSize: status.fileSize })
      // gateway-exempt: pre-signed report file on Amazon's storage (no auth header), not the API
      const dlRes = await fetch(downloadUrl) // presigned URL — no auth header
      if (!dlRes.ok) throw new Error(`[ADS-LIVE] report download failed ${dlRes.status}`)

      // ── 🔴 ACR.0.2-bis, second layer ────────────────────────────────────────────────────
      // The report is requested as `format: 'GZIP_JSON'` and S3 serves those bytes RAW — no
      // Content-Encoding header — so fetch does not transparently inflate them and `.json()`
      // chokes on the gzip magic number:
      //     Unexpected token '\u001f', "\u001f\u008b\b\u0000…" is not valid JSON
      //
      // This defect sat directly behind the wrong-URL-key one and could never fire while that
      // was live, because the download branch was unreachable. Fixing the key exposed it on
      // the very first successful download.
      //
      // Sniff the magic bytes rather than trusting the requested format: it costs two byte
      // comparisons and keeps working if a report type ever comes back uncompressed.
      const buf = Buffer.from(await dlRes.arrayBuffer())
      const isGzip = buf.length > 1 && buf[0] === 0x1f && buf[1] === 0x8b
      const text = (isGzip ? gunzipSync(buf) : buf).toString('utf8')
      logger.info('[ADS-LIVE] report decoded', { reportId, gzip: isGzip, bytes: buf.length, chars: text.length })
      return JSON.parse(text) as ReportRow[]
    }
    if (status.status === 'FAILURE') {
      throw new Error(`[ADS-LIVE] report ${reportId} failed on Amazon side`)
    }
    // A COMPLETED report we cannot download is a CONTRACT change, not a slow report. Logging it
    // as "pending" is exactly how the previous defect hid for months.
    if (status.status === 'COMPLETED') {
      throw new Error(
        `[ADS-LIVE] report ${reportId} is COMPLETED but carries no download URL — ` +
        `keys: ${Object.keys(status).join(', ')}. Amazon's response contract changed.`)
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
 *     "productDetails": { "asin": "B0FXF87810", "globalStoreSetting": null,
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
