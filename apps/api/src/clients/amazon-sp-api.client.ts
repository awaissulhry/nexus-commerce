import { workspaceKey } from '@nexus/database/workspace-context'
/**
 * Phase 12f: Amazon SP-API Client
 * 
 * Production HTTP client for Amazon Selling Partner API
 * - Connection-scoped Login With Amazon (LWA) authentication
 * - Listings Items v2021-08-01 endpoint integration
 * - Rate limiting (5 requests/second)
 * - Error parsing for SP-API issues array
 */

import { logger } from '../utils/logger.js'
import { getAmazonPublishMode } from '../services/amazon-publish-gate.service.js'
import prisma from '../db.js'

interface LWATokenResponse {
  access_token: string
  expires_in: number
  token_type: string
}

/**
 * SP-API issue payload. Each issue has a severity:
 *   ERROR    — blocks the listing from going live; publish considered failed
 *   WARNING  — does not block but the listing may not surface optimally
 *   INFO     — recommendation only
 *
 * Pre-audit-fix #3 the parser collapsed every issue into a single
 * blocking error, which broke real-world submissions where Amazon
 * routinely returns WARNING-level recommendations (image dimensions,
 * attribute shape suggestions). Now severity drives the gate:
 * publish fails only when at least one ERROR is present.
 */
interface SPAPIIssue {
  code: string
  message: string
  details?: string
  severity?: 'ERROR' | 'WARNING' | 'INFO'
  /** Affected attribute paths, when SP-API can localise the issue. */
  attributeNames?: string[]
  /** Issue category (e.g. INVALID_ATTRIBUTE, MISSING_ATTRIBUTE). */
  categories?: string[]
}

interface SPAPIResponse {
  sku?: string
  status?: string
  issues?: SPAPIIssue[]
  [key: string]: any
}

interface SubmitListingPayloadOptions {
  sellerId: string
  sku: string
  payload: any
  /** The account the write goes to (the proxy resolves it when the profiles are on); omitted = the seller's. */
  accountId?: string
  /**
   * Amazon fulfilment conversion (2026-10-07): the `FulfilmentConversion` row an operator-confirmed FBA → FBM run created
   * for THIS patch. The FBA hard block lets its own patch (the merchant quantity + the delete of the Amazon record) through
   * only against it (`conversionLetsThrough`).
   */
  conversionId?: string
  /** P0b 2026-07-20 — REQUIRED query param for patchListingsItem. Omitting it
   *  made SP-API 400 every call while the old error handling (issues-only)
   *  reported success — the false-green zero-inventory incident. Defaults to
   *  the client's home marketplace when a caller doesn't pass one. */
  marketplaceId?: string
}

interface PutListingsItemOptions {
  sellerId: string
  sku: string
  marketplaceId: string
  productType: string
  attributes: Record<string, unknown>
  /** SP-API requirements set: 'LISTING' (full create) or 'LISTING_OFFER_ONLY'
   *  (existing catalog item, just attach offer). Default 'LISTING'. */
  requirements?: 'LISTING' | 'LISTING_OFFER_ONLY' | 'LISTING_PRODUCT_ONLY'
}

interface GetListingsItemOptions {
  sellerId: string
  sku: string
  marketplaceId: string
  /** SP-API includedData set: which sections to return. Default ['summaries']
   *  (parent ASIN + status). 'images' returns the per-marketplace image
   *  array which IE.4 stores in ChannelLiveImage for drift detection. */
  includedData?: Array<'summaries' | 'attributes' | 'issues' | 'offers' | 'images' | 'fulfillmentAvailability'>
}

export interface SpApiImageVariant {
  link: string
  width?: number
  height?: number
  variant?: string // 'MAIN' | 'PT01' .. 'PT08' | 'SWCH'
}

/** W5.49 — DELETE /listings/2021-08-01/items/{sellerId}/{sku}. */
interface DeleteListingsItemOptions {
  sellerId: string
  sku: string
  marketplaceId: string
}

/**
 * SP-API endpoint hostnames use regional slugs (na / eu / fe), not AWS
 * region names. Accept either form so AMAZON_REGION=us-east-1 (typical
 * Railway env) and AMAZON_REGION=na both work.
 */
export function mapAwsRegionToSpApiSlug(region: string): string {
  const r = region.toLowerCase()
  // Already a slug
  if (r === 'na' || r === 'eu' || r === 'fe') return r
  // North America: us-*, ca-*
  if (r.startsWith('us-') || r.startsWith('ca-')) return 'na'
  // Far East: ap-*
  if (r.startsWith('ap-')) return 'fe'
  // Europe: eu-*, me-*, af-*
  if (r.startsWith('eu-') || r.startsWith('me-') || r.startsWith('af-')) return 'eu'
  // Unknown — default to eu: Xavia operates on EU marketplaces (IT/DE/FR/ES/UK)
  // and the listings feed runs on eu, so the read-back client must match or
  // getListingsItem hits the wrong region and 404s on every EU listing.
  return 'eu'
}

export class AmazonSpApiClient {
  // Grantless token cache — keyed by scope string
  private grantlessTokens: Map<string, { token: string; expiresAt: number }> = new Map()

  readonly region: string

  // P6.1 — the app's client id and secret are NOT read from env here any more: the secret rotates
  // (ChannelApp), and a copy taken at construction would keep using the old one after a rotation.
  // getGrantlessToken reads ChannelApp on every exchange, like the seller-token path.
  constructor(private readonly boundAccount?: { id: string; region: string }) {
    // SP-API endpoint slugs are 'na' | 'eu' | 'fe' — not AWS region names.
    // Map AWS region names → SP-API slugs so AMAZON_REGION=us-east-1 works.
    // Default EU to match the listings-feed path (which uses `?? 'eu'`). Xavia
    // sells on EU marketplaces; defaulting NA here made every getListingsItem hit
    // the North America endpoint → 404 on all EU listings → blind read-back.
    this.region = boundAccount?.region ?? mapAwsRegionToSpApiSlug(process.env.AMAZON_REGION || 'eu')
  }

  /**
   * Get or refresh access token from Login With Amazon (LWA)
   * Caches token for 50 minutes to avoid spamming auth endpoint
   */
  async getAccessToken(): Promise<string> {
    // Seller grants are connection data, even in a single-profile deployment.
    // The shared resolver uses the encrypted DB grant when present and falls
    // back to AMAZON_REFRESH_TOKEN only during the explicit migration window.
    return (await import('../lib/amazon-sp-client.js')).getAmazonAccessToken(this.boundAccount?.id)
  }

  /**
   * Grantless LWA token — uses client_credentials grant with the given scope.
   * Required for SP-API operations that act on behalf of the application itself
   * rather than a specific seller, e.g. Notifications destination management.
   * Cached per-scope for 50 minutes (same as the seller token).
   */
  async getGrantlessToken(scope: string): Promise<string> {
    const now = Date.now()
    const cached = this.grantlessTokens.get(scope)
    if (cached && now < cached.expiresAt) return cached.token

    logger.info('Requesting grantless LWA token', { scope })
    const { getChannelApp } = await import('../services/cx/apps.service.js')
    const app = await getChannelApp('AMAZON_SP')
    // gateway-exempt: OAuth token exchange (LWA client_credentials) — the gateway's own token source
    const response = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: app.clientId,
        client_secret: app.clientSecret,
        scope,
      }).toString(),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Grantless LWA auth failed (${scope}): ${response.status} — ${text}`)
    }

    const data = (await response.json()) as LWATokenResponse
    this.grantlessTokens.set(scope, {
      token: data.access_token,
      expiresAt: now + 50 * 60 * 1000,
    })
    return data.access_token
  }

  /**
   * FU.6 — generic SP-API request helper.
   *
   * Routes any caller (orders-reviews/Solicitations, future Buy
   * Shipping wire, future MFN cancel) through the same auth +
   * rate-limit + retry shell that the rest of this client's
   * methods use. Avoids the previous "inline fetch with
   * getAccessToken()" pattern in routes/services that duplicated
   * the rate-limit + 429 backoff logic.
   *
   * Path is relative to the SP-API host (e.g. '/solicitations/v1
   * /orders/{id}/...'). The host is computed from
   * process.env.AMAZON_REGION + the sandbox flag.
   *
   * Returns the parsed JSON body on 2xx; throws Error(`HTTP {n}
   * — {body}`) on non-2xx after retry. Caller handles known
   * 4xx semantics (e.g. 400 "already solicited") by inspecting
   * the thrown message.
   *
   * Examples:
   *   await client.request('POST',
   *     `/solicitations/v1/orders/${id}/solicitations/productReviewAndSellerFeedback`,
   *     { query: { marketplaceIds: mp } })
   *
   *   await client.request('POST',
   *     '/mfn/v0/eligibleShippingServices',
   *     { body: shipmentRequestDetails })
   */
  async request<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    path: string,
    opts: {
      query?: Record<string, string | number | undefined>
      body?: unknown
      sandbox?: boolean
      label?: string
    } = {},
  ): Promise<T> {
    const token = await this.getAccessToken()
    const host = opts.sandbox
      ? `sandbox.sellingpartnerapi-${await (await import('../lib/amazon-sp-client.js')).getAmazonRegion()}.amazon.com`
      : `sellingpartnerapi-${await (await import('../lib/amazon-sp-client.js')).getAmazonRegion()}.amazon.com`
    const qs = opts.query
      ? '?' +
        new URLSearchParams(
          Object.fromEntries(
            Object.entries(opts.query)
              .filter(([, v]) => v != null)
              .map(([k, v]) => [k, String(v)]),
          ),
        ).toString()
      : ''
    const url = `https://${host}${path}${qs}`
    const init: RequestInit = {
      method,
      headers: {
        'x-amz-access-token': token,
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(opts.body !== undefined
        ? { body: typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body) }
        : {}),
    }
    const res = await this.fetchWithRetry(url, init, opts.label ?? `${method} ${path}`)
    if (res.status === 204) return undefined as T
    const text = await res.text().catch(() => '')
    if (res.status >= 200 && res.status < 300) {
      if (!text) return undefined as T
      try {
        return JSON.parse(text) as T
      } catch {
        return text as unknown as T
      }
    }
    throw new Error(`HTTP ${res.status} — ${text.slice(0, 500)}`)
  }

  /**
   * P1.2 — every call of this client goes through the channel gateway (services/gateway/gateway.ts):
   * the account status check, the publish mode for writes (a listings VALIDATION_PREVIEW is a read),
   * the rate bucket per account and operation (it replaces this client's old fixed 200 ms gap), the
   * error class and one ledger row per call. The token the method already fetched is the one sent.
   *
   * Retries: a 429 up to 3 times (the gateway waits for the bucket); a network error, timeout or 5xx
   * up to 3 times with a 1 s / 2 s / 4 s wait — only for a read or a write that is safe to repeat
   * (the listings API's PUT / PATCH / DELETE). A POST that could apply twice (a label purchase, a
   * solicitation) is not retried any more.
   *
   * Returns the channel's answer as a Response (callers read status and body as before). No answer at
   * all throws, as before. Nothing sent (held, gated, dry run, refused) throws the GatewayRefusal.
   */
  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    label: string,
  ): Promise<Response> {
    const { gatewayFetch } = await import('../services/gateway/gateway.js')
    const { amazonSdkKind } = await import('../services/gateway/amazon-sdk.js')
    const { operationOfPath } = await import('../services/gateway/channels.js')
    const connectionId = this.boundAccount?.id ?? (await (await import('../lib/amazon-sp-client.js')).amazonAccount({})).id
    const headers: Record<string, string> = {}
    let token: string | null = null
    for (const [name, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      if (/^x-amz-access-token$/i.test(name)) token = value
      else headers[name] = value
    }
    const method = String(init.method ?? 'GET').toUpperCase() as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    const parsed = new URL(url)
    const operation = /^[a-z][A-Za-z]+/.exec(label)?.[0] ?? operationOfPath(method, url)
    return gatewayFetch({
      channel: 'AMAZON_SP',
      operation,
      kind: amazonSdkKind(method, operation, Object.fromEntries(parsed.searchParams), parsed.pathname),
      connectionId,
      url,
      method,
      headers,
      body: typeof init.body === 'string' ? init.body : null,
      auth: token ? { token } : 'account',
      marketplace: parsed.searchParams.get('marketplaceIds')?.split(',')[0] ?? null,
      idempotent: /^\/listings\//.test(parsed.pathname),
      max429Retries: 3,
      maxTransientRetries: 3,
      retryBackoffMs: 1000,
      timeoutMs: 60_000,
    })
  }

  /**
   * Parse SP-API errors. Returns a joined message of *blocking* (ERROR-
   * severity) issues only; WARNING and INFO issues do not fail the
   * publish — they're surfaced separately via parseWarnings(). Issues
   * without a severity field are treated as ERROR for safety (older
   * SP-API responses elide the field).
   *
   * SP-API returns 200/207 even when issues exist; severity is the
   * only reliable signal for "this listing won't go live".
   */
  private parseErrors(response: SPAPIResponse): string | null {
    if (!response.issues || response.issues.length === 0) return null

    const errors = response.issues.filter((issue) => {
      const sev = (issue.severity ?? 'ERROR').toUpperCase()
      return sev === 'ERROR'
    })
    if (errors.length === 0) return null

    return errors
      .map((issue) => {
        const code = issue.code || 'UNKNOWN'
        const message = issue.message || 'Unknown error'
        const details = issue.details ? ` (${issue.details})` : ''
        const attrs =
          issue.attributeNames && issue.attributeNames.length > 0
            ? ` [${issue.attributeNames.join(', ')}]`
            : ''
        return `${code}: ${message}${details}${attrs}`
      })
      .join(' | ')
  }

  /**
   * Parse non-blocking issues (WARNING + INFO) into a structured array
   * the wizard UI can render. Includes the severity so the UI can
   * tier them visually.
   */
  private parseWarnings(response: SPAPIResponse): Array<{
    code: string
    message: string
    severity: 'WARNING' | 'INFO'
    attributeNames?: string[]
  }> {
    if (!response.issues || response.issues.length === 0) return []
    return response.issues
      .filter((issue) => {
        const sev = (issue.severity ?? '').toUpperCase()
        return sev === 'WARNING' || sev === 'INFO'
      })
      .map((issue) => ({
        code: issue.code || 'UNKNOWN',
        message: issue.message || '',
        severity: ((issue.severity ?? 'WARNING').toUpperCase() === 'INFO'
          ? 'INFO'
          : 'WARNING') as 'WARNING' | 'INFO',
        attributeNames: issue.attributeNames,
      }))
  }

  /**
   * FBA-flip hard block — last line of defense, independent of every upstream
   * guard. Scans a Listings PATCH body for the three dangerous shapes on
   * `/attributes/fulfillment_availability`:
   *   - a merchant record (`DEFAULT`) WITH a quantity — for an FBA SKU (FBA stock
   *     on hand or Product.fulfillmentMethod==='FBA'; a lookup error counts as
   *     FBA) that is exactly what flips the offer to FBM (the June 2026 incident);
   *   - a `delete` of an Amazon record (`AMAZON_EU` …) — what takes the offer off
   *     FBA; refused for every SKU;
   *   - a quantity under an Amazon code — the FBA quantity, which Nexus never
   *     writes; refused always, no exception.
   * It strips those patches so they never reach Amazon and keeps every other one;
   * a genuinely-FBM SKU's merchant quantity still syncs. Returns the (possibly
   * filtered) payload.
   *
   * The ONE exception (Amazon fulfilment conversion, 2026-10-07; add + delete since
   * 2026-10-08): a call carrying a `conversionId` whose row is an operator-confirmed
   * FBA → FBM conversion of this SKU and marketplace with this quantity and EXACTLY
   * these fulfilment patches (its recorded `payload`), SENDING, under 10 minutes
   * old, while no FBA units are mirrored now (`conversionLetsThrough`). A conversion
   * call the check refuses loses ALL its fulfilment patches — never a lone
   * `delete AMAZON_EU`, never a lone merchant quantity. A failed lookup strips.
   */
  private async guardFbaQtyFlip(
    sku: string,
    payload: any,
    conversion?: { conversionId?: string; marketplaceId: string },
  ): Promise<{ payload: any; blocked: boolean }> {
    const patches = payload?.patches
    if (!Array.isArray(patches)) return { payload, blocked: false }
    const FULFILMENT = '/attributes/fulfillment_availability'
    const entries = (p: any): any[] => (Array.isArray(p?.value) ? p.value : [])
    const codeOf = (v: any): string => String(v?.fulfillment_channel_code ?? '').trim().toUpperCase()
    const isDelete = (p: any): boolean => String(p?.op ?? '').toLowerCase() === 'delete'
    const isFulfilment = (p: any): boolean => p?.path === FULFILMENT
    const isFlip = (p: any): boolean =>
      isFulfilment(p) && entries(p).some((v: any) => codeOf(v) === 'DEFAULT' && v?.quantity != null)
    const dropsFba = (p: any): boolean => isFulfilment(p) && isDelete(p) && entries(p).some((v: any) => codeOf(v).startsWith('AMAZON'))
    const writesFbaQty = (p: any): boolean =>
      isFulfilment(p) && !isDelete(p) && entries(p).some((v: any) => codeOf(v).startsWith('AMAZON') && v?.quantity != null)
    if (!patches.some((p: any) => isFlip(p) || dropsFba(p) || writesFbaQty(p))) return { payload, blocked: false }

    // 1 — the FBA quantity is Amazon's: never sent, whatever the call.
    let kept: any[] = patches
    if (kept.some(writesFbaQty)) {
      kept = kept.filter((p: any) => !writesFbaQty(p))
      logger.error('🔴 FBA HARD BLOCK — refused a quantity under an Amazon fulfilment code (the FBA quantity is Amazon-managed)', { critical: true, sku })
    }
    const done = (list: any[], blocked: boolean) => ({ payload: list === patches ? payload : { ...payload, patches: list }, blocked })
    const flips = kept.some(isFlip)
    const drops = kept.some(dropsFba)
    if (!flips && !drops) return done(kept, kept !== patches)

    // 2 — a merchant quantity is dangerous only for an FBA SKU: is this one?
    let isFba = false
    if (flips) {
      try {
        const product = await prisma.product.findUnique({
          where: { workspace_sku: workspaceKey({ sku: sku }) },
          select: { id: true, fulfillmentMethod: true },
        })
        // An unknown SKU: upstream guards own its merchant quantity (as before).
        if (product && String(product.fulfillmentMethod ?? '').toUpperCase() === 'FBA') {
          isFba = true
        } else if (product) {
          const agg = await prisma.stockLevel.aggregate({
            where: { productId: product.id, location: { code: 'AMAZON-EU-FBA' } },
            _sum: { quantity: true },
          })
          if ((agg._sum.quantity ?? 0) > 0) isFba = true
        }
      } catch (err) {
        // Can't determine → fail closed: a missed merchant-qty sync is benign; a
        // flip to FBM is catastrophic.
        isFba = true
        logger.warn('guardFbaQtyFlip: FBA lookup failed — failing closed (blocking)', {
          sku,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    // A genuine FBM SKU's merchant quantity, with no Amazon record removed: allowed.
    if (!drops && !isFba) return done(kept, kept !== patches)

    // 3 — the one exception: an operator-confirmed conversion's own patch.
    if (conversion?.conversionId) {
      const quantities = kept.filter(isFlip).flatMap((p: any) => entries(p)
        .filter((v: any) => codeOf(v) === 'DEFAULT' && v?.quantity != null)
        .map((v: any) => Number(v.quantity)))
      let verdict: { pass: boolean; reason: string }
      try {
        const { conversionLetsThrough } = await import('../services/pim/fulfilment-conversion-guard.js')
        verdict = await conversionLetsThrough(conversion.conversionId, { sku, marketplaceId: conversion.marketplaceId, quantities, patches: kept.filter(isFulfilment) })
      } catch (err) {
        verdict = { pass: false, reason: `the conversion check failed (${err instanceof Error ? err.message : String(err)})` }
      }
      if (verdict.pass) {
        logger.warn('FBA guard: an operator-confirmed FBA → FBM conversion sends its own patch (merchant quantity + delete of the Amazon record)', { sku, marketplaceId: conversion.marketplaceId, conversionId: conversion.conversionId, quantities })
        return done(kept, kept !== patches)
      }
      logger.error('FBA guard: a conversion patch was NOT let through — every fulfilment patch of the call is stripped', { sku, conversionId: conversion.conversionId, reason: verdict.reason })
    }

    // 4 — strip. A conversion call loses every fulfilment patch (never half a conversion); any other call loses the
    // Amazon-record deletes, and the merchant quantity when the SKU is FBA.
    const strip = conversion?.conversionId
      ? isFulfilment
      : (p: any) => dropsFba(p) || (isFba && isFlip(p))
    const safePatches = kept.filter((p: any) => !strip(p))
    logger.error(
      '🔴 FBA HARD BLOCK — refused a merchant DEFAULT+quantity or a delete of the Amazon fulfilment record outside an operator-confirmed conversion (would flip the offer between FBA and FBM)',
      { critical: true, sku, strippedPatches: patches.length - safePatches.length },
    )
    return { payload: { ...payload, patches: safePatches }, blocked: true }
  }

  /**
   * Submit listing payload to Amazon SP-API
   * Listings Items v2021-08-01 endpoint
   */
  /** P0b — home marketplace fallback (IT for this seller) when a caller
   *  doesn't thread one through. */
  private defaultMarketplaceId(): string {
    return process.env.AMAZON_MARKETPLACE_ID || 'APJ6JRA9NG5V4'
  }

  async submitListingPayload(options: SubmitListingPayloadOptions): Promise<{
    success: boolean
    sku: string
    status?: string
    error?: string
    rawResponse?: SPAPIResponse
    dryRun?: boolean
  }> {
    const { sellerId, sku } = options
    let payload = options.payload

    // A1.1 — gate at the client layer so no caller can write when publishing is
    // disabled/dry-run (previously only the caller gated this method).
    // AS.5 — 'sandbox' included: this PATCH path has no sandbox-host swap
    // (unlike the create path), so sandbox mode used to fire a REAL
    // production PATCH while callers labeled the row dry-run/SKIPPED — a
    // live write masquerading as a no-op. Until a sandbox host exists here,
    // sandbox behaves as dry-run and says so.
    const mode = getAmazonPublishMode()
    if (mode === 'gated' || mode === 'dry-run' || mode === 'sandbox') {
      if (mode === 'sandbox') {
        logger.warn('SP-API submitListingPayload: sandbox mode has no sandbox host on this path — treating as dry-run (no HTTP)', { sku, sellerId })
      } else {
        logger.info(`SP-API submitListingPayload (mode=${mode}, no HTTP)`, { sku, sellerId })
      }
      return { success: true, sku, status: 'ACCEPTED', dryRun: true }
    }

    // FBA-flip HARD BLOCK — strip a merchant DEFAULT+quantity fulfillment for an
    // FBA SKU before it can reach Amazon. If nothing else remains, skip the call.
    const guarded = await this.guardFbaQtyFlip(sku, payload, { conversionId: options.conversionId, marketplaceId: options.marketplaceId ?? this.defaultMarketplaceId() })
    payload = guarded.payload
    if (guarded.blocked && (!Array.isArray(payload?.patches) || payload.patches.length === 0)) {
      return { success: true, sku, status: 'SKIPPED_FBA_HARD_BLOCK', dryRun: false }
    }

    try {
      // Get access token (rate limit applied per attempt by fetchWithRetry)
      const accessToken = await this.getAccessToken()

      logger.info('Submitting listing to Amazon SP-API', {
        sku,
        sellerId,
        payloadSize: JSON.stringify(payload).length,
      })

      // Submit to SP-API (with retry/backoff on 429/5xx + network errors)
      const marketplaceId = options.marketplaceId ?? this.defaultMarketplaceId()
      const response = await this.fetchWithRetry(
        `https://sellingpartnerapi-${await (await import('../lib/amazon-sp-client.js')).getAmazonRegion()}.amazon.com/listings/2021-08-01/items/${sellerId}/${sku}?marketplaceIds=${encodeURIComponent(marketplaceId)}&issueLocale=en_US`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'x-amzn-requestid': `nexus-${Date.now()}`,
            // AS.0 ROOT CAUSE (2026-07-20): SP-API takes the LWA token in
            // x-amz-access-token — Authorization:Bearer means "no token" to
            // Amazon ("Access token is missing…" → 403 denied). The read
            // methods were fixed earlier (see getListingsItem); these write
            // methods kept the wrong header, which was the ENTIRE
            // zero-inventory 403 saga. Roles/tokens were never the problem.
            'x-amz-access-token': accessToken,
          },
          body: JSON.stringify(payload),
        },
        `submitListingPayload(${sku})`,
      )

      const data = (await response.json()) as SPAPIResponse

      logger.debug('SP-API response received', {
        sku,
        status: response.status,
        hasIssues: !!data.issues,
        issueCount: data.issues?.length || 0,
      })

      // P0b — an HTTP failure is a FAILURE. SP-API error bodies carry a
      // top-level `errors[]` (not `issues[]`); the old flow only read issues,
      // so 400s (e.g. the missing-marketplaceIds era) fell through to
      // success:true while Amazon applied nothing.
      if (!response.ok) {
        const topErrors = Array.isArray((data as { errors?: Array<{ code?: string; message?: string }> }).errors)
          ? (data as { errors: Array<{ code?: string; message?: string }> }).errors
              .map((e) => `${e.code ?? 'ERROR'}: ${e.message ?? ''}`)
              .join(' | ')
          : `HTTP ${response.status}`
        logger.warn('SP-API PATCH failed', { sku, httpStatus: response.status, errors: topErrors.slice(0, 400) })
        return { success: false, sku, error: `HTTP ${response.status} — ${topErrors.slice(0, 400)}`, rawResponse: data }
      }

      // Check for errors in issues array (SP-API returns 200/207 even on errors)
      const errorMessage = this.parseErrors(data)
      if (errorMessage) {
        logger.warn('SP-API returned errors in issues array', {
          sku,
          errors: errorMessage,
        })

        // P4.1b — onto the listing, in Amazon's own words.
        await this.fileListingIssues(sku, marketplaceId, data.issues)
        return {
          success: false,
          sku,
          error: errorMessage,
          rawResponse: data,
        }
      }

      // P4.1b — accepted, so the open `listings-api` issues for this item are no
      // longer true. A REPLACE source closes them by saying what is true now.
      await this.fileListingIssues(sku, marketplaceId, data.issues)

      // Success
      logger.info('Listing submitted successfully to Amazon SP-API', {
        sku,
        status: data.status,
      })

      return {
        success: true,
        sku,
        status: data.status,
        rawResponse: data,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      logger.error('Failed to submit listing to Amazon SP-API', {
        sku,
        error: errorMessage,
      })

      return {
        success: false,
        sku,
        error: errorMessage,
      }
    }
  }

  /**
   * G.5.1 — Price-only PATCH to an existing listing.
   *
   * Faster + lighter than the full `submitListingPayload`: only sends the
   * purchasable_offer.our_price slot, leaves every other attribute alone.
   * Use for repricing on an already-listed SKU.
   *
   * marketplaceId is the SP-API ID (APJ6JRA9NG5V4 for IT, etc.).
   * priceWithTax distinguishes EU tax-inclusive markets from US-style
   * tax-exclusive — caller resolves via Marketplace.taxInclusive.
   */
  async patchListingPrice(options: {
    sellerId: string
    sku: string
    marketplaceId: string
    productType: string
    price: number
    currencyCode: string
    /** When true, the price is tax-inclusive (EU); when false, net (US). */
    taxInclusive: boolean
  }): Promise<{
    success: boolean
    sku: string
    status?: string
    submissionId?: string
    error?: string
    issues?: SPAPIResponse['issues']
    dryRun?: boolean
  }> {
    const { sellerId, sku, marketplaceId, productType, price, currencyCode, taxInclusive } = options

    // A1.1 — gate at the client layer. This is the path repricing reached
    // ungated; it now obeys NEXUS_ENABLE_AMAZON_PUBLISH + AMAZON_PUBLISH_MODE.
    // P0.1 — 'sandbox' included for the AS.5 reason: this path has no sandbox
    // host, so sandbox used to send a real production PATCH.
    const mode = getAmazonPublishMode()
    if (mode === 'gated' || mode === 'dry-run' || mode === 'sandbox') {
      if (mode === 'sandbox') {
        logger.warn('SP-API patchListingPrice: sandbox mode has no sandbox host on this path — treating as dry-run (no HTTP)', { sku, sellerId, marketplaceId })
      } else {
        logger.info(`SP-API patchListingPrice (mode=${mode}, no HTTP)`, { sku, sellerId, marketplaceId })
      }
      return { success: true, sku, status: 'ACCEPTED', submissionId: `dry-run-${Date.now()}`, dryRun: true }
    }

    try {
      const accessToken = await this.getAccessToken()

      // SP-API JSON Patch shape — replace purchasable_offer.our_price.schedule
      // with a single fresh price entry. The whole purchasable_offer slot
      // is overwritten because Amazon doesn't support deeper-than-attribute
      // patches; the productType + marketplaceId in the wrap make the patch
      // marketplace-specific.
      const ourPrice = taxInclusive
        ? [{ schedule: [{ value_with_tax: price }] }]
        : [{ schedule: [{ value: price, currency: currencyCode }] }]

      const patches = [
        {
          op: 'replace',
          path: '/attributes/purchasable_offer',
          value: [
            {
              marketplace_id: marketplaceId,
              currency: currencyCode,
              our_price: ourPrice,
            },
          ],
        },
      ]

      const url = new URL(
        `https://sellingpartnerapi-${await (await import('../lib/amazon-sp-client.js')).getAmazonRegion()}.amazon.com/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(
          sku,
        )}`,
      )
      url.searchParams.set('marketplaceIds', marketplaceId)

      logger.info('SP-API: patchListingPrice', {
        sku,
        marketplaceId,
        currencyCode,
        price,
        taxInclusive,
      })

      const response = await this.fetchWithRetry(
        url.toString(),
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'x-amzn-requestid': `nexus-${Date.now()}`,
            // AS.0 ROOT CAUSE (2026-07-20): SP-API takes the LWA token in
            // x-amz-access-token — Authorization:Bearer means "no token" to
            // Amazon ("Access token is missing…" → 403 denied). The read
            // methods were fixed earlier (see getListingsItem); these write
            // methods kept the wrong header, which was the ENTIRE
            // zero-inventory 403 saga. Roles/tokens were never the problem.
            'x-amz-access-token': accessToken,
          },
          body: JSON.stringify({ productType, patches }),
        },
        `patchListingPrice(${sku})`,
      )
      const data = (await response.json()) as SPAPIResponse
      const errorMessage = this.parseErrors(data)
      if (errorMessage) {
        return {
          success: false,
          sku,
          error: errorMessage,
          issues: data.issues,
          submissionId: data.submissionId,
        }
      }
      return {
        success: true,
        sku,
        status: data.status,
        submissionId: data.submissionId,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error('SP-API patchListingPrice failed', { sku, error: errorMessage })
      return { success: false, sku, error: errorMessage }
    }
  }

  /**
   * SCT.6 — close/reopen ONE marketplace's offer for a SKU.
   *
   * Amazon's documented "close a listing": delete the purchasable_offer
   * attribute INSTANCE for that marketplace (selector = marketplace_id +
   * currency), scoped again by the marketplaceIds query param. The listing
   * goes Inactive (no offer) in that marketplace only — SKU record, content,
   * ASIN, reviews, sibling markets and the shared EU quantity are untouched.
   * Sub-attribute deletes are NOT supported by SP-API (whole-instance only).
   *
   * Reopen replays the verbatim purchasable_offer value array captured at
   * close time (op:replace — also correct when the attribute is absent).
   *
   * 'merge' — the pricing-engine push with NEXUS_AMAZON_OFFER_MERGE on
   * (services/amazon/purchasable-offer.ts): one instance's selectors plus the
   * sub-attributes it changes; Amazon keeps everything the value leaves out.
   */
  async patchPurchasableOffer(options: {
    sellerId: string
    sku: string
    marketplaceId: string
    productType: string
    /** 'delete' closes the market's offer; 'replace' reopens it; 'merge' changes named sub-attributes of one instance. */
    op: 'delete' | 'replace' | 'merge'
    /** Verbatim purchasable_offer value array (required for every op:
     *  delete uses it as the instance SELECTOR, replace as the new value,
     *  merge as the selectors + the sub-attributes to change). */
    value: Array<Record<string, unknown>>
  }): Promise<{
    success: boolean
    sku: string
    status?: string
    submissionId?: string
    error?: string
    issues?: SPAPIResponse['issues']
    dryRun?: boolean
  }> {
    const { sellerId, sku, marketplaceId, productType, op, value } = options
    // P0.1 — no sandbox host on this path (AS.5 reason): sandbox = no HTTP.
    const mode = getAmazonPublishMode()
    if (mode === 'gated' || mode === 'dry-run' || mode === 'sandbox') {
      if (mode === 'sandbox') {
        logger.warn('SP-API patchPurchasableOffer: sandbox mode has no sandbox host on this path — treating as dry-run (no HTTP)', { sku, marketplaceId, op })
      } else {
        logger.info(`SP-API patchPurchasableOffer (mode=${mode}, no HTTP)`, { sku, marketplaceId, op })
      }
      return { success: true, sku, status: 'ACCEPTED', submissionId: `dry-run-${Date.now()}`, dryRun: true }
    }
    try {
      const accessToken = await this.getAccessToken()
      const patches = [{ op, path: '/attributes/purchasable_offer', value }]
      const url = new URL(
        `https://sellingpartnerapi-${await (await import('../lib/amazon-sp-client.js')).getAmazonRegion()}.amazon.com/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}`,
      )
      url.searchParams.set('marketplaceIds', marketplaceId)
      logger.info('SP-API: patchPurchasableOffer', { sku, marketplaceId, op })
      const response = await this.fetchWithRetry(
        url.toString(),
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'x-amz-access-token': accessToken,
          },
          body: JSON.stringify({ productType, patches }),
        },
        `patchPurchasableOffer(${sku}:${marketplaceId}:${op})`,
      )
      const data = (await response.json()) as SPAPIResponse
      const errorMessage = this.parseErrors(data)
      if (errorMessage) {
        return { success: false, sku, error: errorMessage, issues: data.issues }
      }
      return { success: true, sku, status: data.status, submissionId: data.submissionId }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error('SP-API patchPurchasableOffer failed', { sku, marketplaceId, op, error: errorMessage })
      return { success: false, sku, error: errorMessage }
    }
  }

  /**
   * P4.1b — Amazon's verdict on an item goes onto that item's listing.
   *
   * `issues` was parsed, logged and handed back to the caller, and nothing ever
   * wrote it to `ListingIssue`: `routes/marketplaces.routes.ts` maps it straight
   * into its HTTP response, so the operator sees a rejection once, in the answer
   * to the request that caused it, and never again on the listing.
   *
   * This is called from the two methods whose `issues` array is Amazon's verdict
   * on the WHOLE item — `putListingsItem` and `submitListingPayload`. It is
   * deliberately NOT called from `patchListingPrice` / `patchPurchasableOffer`:
   * `listings-api` is a REPLACE source, so recording an offer patch's answer
   * would resolve open CONTENT rejections the offer call never spoke about.
   *
   * On success it records an EMPTY set on purpose. That is what closes a
   * rejection once the listing is fixed; without it a stale issue would sit on a
   * healthy listing for ever.
   *
   * Never throws and never blocks the write: an issue row is a report about a
   * call, not part of one.
   */
  private async fileListingIssues(
    sku: string,
    marketplaceId: string | null | undefined,
    issues: SPAPIIssue[] | undefined,
  ): Promise<void> {
    try {
      const { recordAmazonListingIssues } = await import('../services/listing-issue-recorder.service.js')
      await recordAmazonListingIssues({
        sku,
        marketplaceId: marketplaceId ?? null,
        issues: (issues ?? []).map((i) => ({
          code: String(i.code ?? 'UNKNOWN'),
          message: String(i.message ?? ''),
          severity: String(i.severity ?? 'ERROR'),
          attributeNames: Array.isArray(i.attributeNames) ? i.attributeNames.map(String) : [],
          categories: Array.isArray(i.categories) ? i.categories.map(String) : [],
        })),
      })
    } catch (error) {
      logger.warn('SP-API: could not file the listing issues', {
        sku, error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * E.8 — putListingsItem (full create-or-replace).
   *
   * Listings Items v2021-08-01 PUT endpoint. Use for first-time publish; the
   * existing PATCH-based `submitListingPayload` is right for partial updates
   * to already-listed SKUs.
   *
   * SP-API rejects payloads where `marketplace_id` in the wrapped attributes
   * is a country code; the SP-API ID (e.g. APJ6JRA9NG5V4) must be passed in
   * BOTH the query string `marketplaceIds` and inside each attribute envelope.
   * The composer (submission.service.ts) already wraps attributes with the
   * SP-API ID; here we just pass the same value through to the URL params.
   */
  async putListingsItem(options: PutListingsItemOptions): Promise<{
    success: boolean
    sku: string
    submissionId?: string
    status?: string
    issues?: SPAPIResponse['issues']
    /** Non-blocking issues from SP-API (WARNING / INFO). Always
     *  populated when the response contained any issues, even on
     *  success — Amazon routinely returns recommendations alongside
     *  a successful publish. */
    warnings?: Array<{
      code: string
      message: string
      severity: 'WARNING' | 'INFO'
      attributeNames?: string[]
    }>
    error?: string
    rawResponse?: SPAPIResponse
    /** C.6 — set when AMAZON_PUBLISH_MODE=dry-run short-circuited this
     *  call. Lets the adapter and audit log distinguish "would have
     *  succeeded" from a live publish without inventing a fake state. */
    dryRun?: boolean
  }> {
    const {
      sellerId,
      sku,
      marketplaceId,
      productType,
      attributes,
      requirements = 'LISTING',
    } = options

    // C.6 — dry-run short-circuit. The adapter has already written a
    // ChannelPublishAttempt row (mode='dry-run', outcome='success'),
    // so callers see a normal success path and the wizard's downstream
    // bookkeeping (status transitions, listing.created emit) runs end-
    // to-end without any side effect on Amazon. We mint a synthetic
    // submissionId so logs can still grep for it.
    // A1.1 — single gate model. getAmazonPublishMode() folds in the master flag
    // (NEXUS_ENABLE_AMAZON_PUBLISH → 'gated') AND the mode, so the client never
    // writes when disabled — not only when AMAZON_PUBLISH_MODE=dry-run.
    const mode = getAmazonPublishMode()
    if (mode === 'gated' || mode === 'dry-run') {
      logger.info(`SP-API putListingsItem (mode=${mode}, no HTTP)`, {
        sku,
        sellerId,
        marketplaceId,
        productType,
        attributeCount: Object.keys(attributes).length,
      })
      return {
        success: true,
        sku,
        submissionId: `dry-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        status: 'ACCEPTED',
        dryRun: true,
      }
    }

    try {
      const accessToken = await this.getAccessToken()

      const body = {
        productType,
        requirements,
        attributes,
      }

      logger.info('PUT listings item to SP-API', {
        sku,
        sellerId,
        marketplaceId,
        productType,
        attributeCount: Object.keys(attributes).length,
        mode,
      })

      // C.6 — sandbox host swap. Amazon publishes a separate sandbox
      // base URL (sandbox.sellingpartnerapi-<region>.amazon.com) that
      // accepts the same auth + payload shape but never produces a
      // real listing. LWA tokens are normally re-usable across the
      // pair; if they're not, the auth call fails fast with a clear
      // 401 and the audit log captures the outcome.
      const host =
        mode === 'sandbox'
          ? `sandbox.sellingpartnerapi-${await (await import('../lib/amazon-sp-client.js')).getAmazonRegion()}.amazon.com`
          : `sellingpartnerapi-${await (await import('../lib/amazon-sp-client.js')).getAmazonRegion()}.amazon.com`
      const url = new URL(
        `https://${host}/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(
          sku,
        )}`,
      )
      url.searchParams.set('marketplaceIds', marketplaceId)

      const response = await this.fetchWithRetry(
        url.toString(),
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'x-amzn-requestid': `nexus-${Date.now()}`,
            // AS.0 ROOT CAUSE (2026-07-20): SP-API takes the LWA token in
            // x-amz-access-token — Authorization:Bearer means "no token" to
            // Amazon ("Access token is missing…" → 403 denied). The read
            // methods were fixed earlier (see getListingsItem); these write
            // methods kept the wrong header, which was the ENTIRE
            // zero-inventory 403 saga. Roles/tokens were never the problem.
            'x-amz-access-token': accessToken,
          },
          body: JSON.stringify(body),
        },
        `putListingsItem(${sku})`,
      )

      const data = (await response.json()) as SPAPIResponse

      const errorMessage = this.parseErrors(data)
      const warnings = this.parseWarnings(data)
      if (errorMessage) {
        logger.warn('SP-API putListingsItem returned blocking issues', {
          sku,
          errors: errorMessage,
          warningCount: warnings.length,
        })
        await this.fileListingIssues(sku, options.marketplaceId, data.issues)
        return {
          success: false,
          sku,
          submissionId: data.submissionId,
          issues: data.issues,
          warnings: warnings.length > 0 ? warnings : undefined,
          error: errorMessage,
          rawResponse: data,
        }
      }

      // Successful publish; warnings are non-blocking but worth surfacing.
      if (warnings.length > 0) {
        logger.info('SP-API putListingsItem succeeded with warnings', {
          sku,
          warningCount: warnings.length,
          firstWarning: warnings[0]?.message,
        })
      }
      // Amazon accepted the item, so its open `listings-api` issues are no longer
      // true. `listings-api` is a REPLACE source: recording what Amazon says now
      // (the warnings, or nothing) closes the rest.
      await this.fileListingIssues(sku, options.marketplaceId, data.issues)
      return {
        success: true,
        sku,
        submissionId: data.submissionId,
        status: data.status,
        warnings: warnings.length > 0 ? warnings : undefined,
        rawResponse: data,
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      logger.error('Failed putListingsItem', { sku, error: errorMessage })
      return { success: false, sku, error: errorMessage }
    }
  }

  /**
   * ALA Phase 3 — VALIDATION_PREVIEW pre-check.
   *
   * Runs Amazon's OWN validation against a listing payload WITHOUT committing it
   * to the catalog (Listings Items mode=VALIDATION_PREVIEW). This is the
   * authoritative "what's wrong with the feed" gate — it returns the issues array
   * (errors + warnings, each with attributeNames), so we catch problems BEFORE
   * the feed round-trip rather than after a rejection.
   *
   * Mirrors the real operation so it never raises a FALSE-POSITIVE "missing
   * required" on a partial edit:
   *   - patches  → PATCH (PARTIAL_UPDATE; only the changed attributes are
   *     validated — an unchanged required attr we aren't touching is not flagged).
   *   - attributes → PUT (full UPDATE; validates the whole required set, correct
   *     for a brand-new listing).
   *
   * NON-MUTATING: VALIDATION_PREVIEW never creates or changes a listing, so —
   * unlike the write paths (putListingsItem/submitListingPayload) — it is NOT
   * short-circuited by the publish gate. A pre-check is useful precisely when
   * publishing is gated/dry-run. When SP-API credentials are unavailable it
   * returns { available:false } so the caller surfaces "couldn't validate"
   * instead of a false pass/fail. A transport error is also reported as
   * unavailable — our inability to reach Amazon must not hard-block a publish.
   */
  async validateListing(options: {
    sellerId: string
    sku: string
    marketplaceId: string
    productType: string
    /** Full attribute set — triggers a PUT (full-update) validation. */
    attributes?: Record<string, unknown>
    /** JSON Patch (RFC 6902) ops — triggers a PATCH (partial-update) validation. */
    patches?: Array<{ op: string; path: string; value?: unknown }>
    requirements?: string
  }): Promise<{
    /** true when Amazon returned no ERROR-severity issues. */
    ok: boolean
    /** false when we couldn't run the preview (no creds / transport error). */
    available: boolean
    status?: string
    errors: string | null
    warnings: Array<{ code: string; message: string; severity: 'WARNING' | 'INFO'; attributeNames?: string[] }>
    issues?: SPAPIResponse['issues']
    rawResponse?: SPAPIResponse
  }> {
    const { sellerId, sku, marketplaceId, productType, attributes, patches, requirements = 'LISTING' } = options
    const usePatch = Array.isArray(patches) && patches.length > 0

    let accessToken: string
    try {
      accessToken = await this.getAccessToken()
    } catch (err) {
      logger.warn('validateListing: SP-API credentials unavailable, skipping preview', {
        sku, error: err instanceof Error ? err.message : String(err),
      })
      return { ok: false, available: false, errors: null, warnings: [] }
    }

    try {
      // VALIDATION_PREVIEW must hit the PRODUCTION host — the sandbox returns
      // canned responses, not a real validation of our payload.
      const url = new URL(
        `https://sellingpartnerapi-${await (await import('../lib/amazon-sp-client.js')).getAmazonRegion(this.boundAccount?.id)}.amazon.com/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`,
      )
      url.searchParams.set('marketplaceIds', marketplaceId)
      url.searchParams.set('mode', 'VALIDATION_PREVIEW')

      const body = usePatch
        ? { productType, patches }
        : { productType, requirements, attributes: attributes ?? {} }

      const response = await this.fetchWithRetry(
        url.toString(),
        {
          method: usePatch ? 'PATCH' : 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'x-amzn-requestid': `nexus-vp-${Date.now()}`,
            // AS.0 ROOT CAUSE (2026-07-20): SP-API takes the LWA token in
            // x-amz-access-token — Authorization:Bearer means "no token" to
            // Amazon ("Access token is missing…" → 403 denied). The read
            // methods were fixed earlier (see getListingsItem); these write
            // methods kept the wrong header, which was the ENTIRE
            // zero-inventory 403 saga. Roles/tokens were never the problem.
            'x-amz-access-token': accessToken,
          },
          body: JSON.stringify(body),
        },
        `validateListing(${sku})`,
      )

      const data = (await response.json()) as SPAPIResponse
      if (!response.ok) return { ok: false, available: false,
        errors: `Amazon validation preview returned HTTP ${response.status}: ${this.parseErrors(data) || JSON.stringify(data).slice(0, 1000) || response.statusText}`,
        warnings: this.parseWarnings(data), issues: data.issues, rawResponse: data }
      // An empty/error response is not affirmative channel validation. Only the
      // preview statuses for this exact SKU can authorize a subsequent submit.
      if (!data || data.sku !== sku || !['VALID', 'INVALID'].includes(data.status ?? '') ||
          (data.issues !== undefined && !Array.isArray(data.issues))) {
        throw new Error('Amazon validation preview returned an unrecognized result')
      }
      const errors = this.parseErrors(data) ?? (data.status === 'INVALID' ? 'Amazon marked the listing invalid without issue details.' : null)
      const warnings = this.parseWarnings(data)
      logger.info('validateListing (VALIDATION_PREVIEW) complete', {
        sku, mode: usePatch ? 'PATCH' : 'PUT', ok: errors == null, warningCount: warnings.length,
      })
      return { ok: errors == null, available: true, status: data.status, errors, warnings, issues: data.issues, rawResponse: data }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('validateListing failed', { sku, error: message })
      return { ok: false, available: false, errors: message, warnings: [] }
    }
  }

  /**
   * W5.49 — deleteListingsItem.
   *
   * Listings Items v2021-08-01 DELETE endpoint. Removes the seller's offer
   * for the SKU on the named marketplace. Amazon side effects:
   *
   *   - The seller's offer is removed; the catalog item (ASIN) survives.
   *   - The SKU enters a ~30-day cooldown — re-creating with the SAME SKU
   *     during that window may fail or be silently held. Recovery flows
   *     that need same-SKU should pre-warn the operator.
   *   - Reviews stay on the ASIN. Recreating under the same ASIN with a
   *     new SKU preserves them; new-ASIN paths lose them.
   *
   * The recovery service (listing-recovery.service.ts) is the only
   * caller in the W5.49 MVP — wizard / bulk publish paths never delete.
   *
   * Dry-run respects AMAZON_PUBLISH_MODE for parity with putListingsItem;
   * a synthetic submissionId is minted so audit logs cross-reference.
   */
  async deleteListingsItem(options: DeleteListingsItemOptions): Promise<{
    success: boolean
    sku: string
    submissionId?: string
    error?: string
    dryRun?: boolean
    rawResponse?: SPAPIResponse
  }> {
    const { sellerId, sku, marketplaceId } = options

    // P0.1 — 'sandbox' included: `request` below targets the production host,
    // so sandbox used to send a real DELETE.
    const mode = getAmazonPublishMode()
    if (mode === 'gated' || mode === 'dry-run' || mode === 'sandbox') {
      logger.info(`SP-API deleteListingsItem (mode=${mode}, no HTTP)`, {
        sku,
        marketplaceId,
      })
      return {
        success: true,
        sku,
        submissionId: `dryrun-${Date.now()}`,
        dryRun: true,
      }
    }

    try {
      const response = await this.request<SPAPIResponse>(
        'DELETE',
        `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`,
        {
          query: { marketplaceIds: marketplaceId },
          label: `deleteListingsItem(${sku})`,
        },
      )

      // SP-API returns the same envelope as putListingsItem — submissionId +
      // status. Status of ACCEPTED means Amazon queued the delete; the SKU
      // is gone from operator's perspective immediately, but the catalog
      // entry may take minutes to propagate.
      const submissionId =
        (response as { submissionId?: string })?.submissionId ?? undefined
      const status = (response as { status?: string })?.status

      if (status && status !== 'ACCEPTED' && status !== 'VALID') {
        logger.warn('SP-API deleteListingsItem returned unexpected status', {
          sku,
          status,
          submissionId,
        })
        return {
          success: false,
          sku,
          submissionId,
          error: `Unexpected status: ${status}`,
          rawResponse: response,
        }
      }

      logger.info('SP-API deleteListingsItem succeeded', {
        sku,
        marketplaceId,
        submissionId,
      })
      return { success: true, sku, submissionId, rawResponse: response }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      logger.error('Failed deleteListingsItem', { sku, error: errorMessage })
      return { success: false, sku, error: errorMessage }
    }
  }

  /**
   * E.8 — getListingsItem.
   *
   * Reads a published listing's current state. Used after putListingsItem to
   * pull back the parent/child ASIN that Amazon assigned, surface BUYABLE
   * status, and detect post-submit issues. The wizard publish path polls
   * this until status === 'BUYABLE' (or until issues are non-empty).
   */
  async getListingsItem(options: GetListingsItemOptions): Promise<{
    success: boolean
    sku: string
    asin: string | null
    status: string | null
    issues?: SPAPIResponse['issues']
    error?: string
    rawResponse?: SPAPIResponse
    /** IE.4 — populated when includedData includes 'images'. SP-API
     *  returns images as `[{ marketplaceId, images: [{ link, width,
     *  height, variant }] }]` (one outer entry per requested
     *  marketplaceId). We flatten to a single array for callers since
     *  every call sends exactly one marketplaceId. */
    images?: SpApiImageVariant[]
  }> {
    const {
      sellerId,
      sku,
      marketplaceId,
      includedData = ['summaries'],
    } = options

    try {
      const accessToken = await this.getAccessToken()

      const url = new URL(
        `https://sellingpartnerapi-${await (await import('../lib/amazon-sp-client.js')).getAmazonRegion(this.boundAccount?.id)}.amazon.com/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(
          sku,
        )}`,
      )
      url.searchParams.set('marketplaceIds', marketplaceId)
      // SP-API uses one comma-delimited array parameter. Repeated keys returned
      // only summaries, silently omitting attributes needed by reconciliation.
      url.searchParams.set('includedData', includedData.join(','))

      const response = await this.fetchWithRetry(
        url.toString(),
        {
          method: 'GET',
          headers: {
            'x-amzn-requestid': `nexus-${Date.now()}`,
            // SP-API auth is the LWA token in x-amz-access-token — NOT
            // Authorization:Bearer. The wrong header made every getListingsItem
            // 404 (bad-auth), which we misread as "listing not found".
            'x-amz-access-token': accessToken,
          },
        },
        `getListingsItem(${sku})`,
      )

      if (response.status === 404) {
        // Listing doesn't exist yet — typical right after a PUT, before
        // Amazon has indexed it. Caller treats this as "still propagating".
        return {
          success: true,
          sku,
          asin: null,
          status: null,
        }
      }

      const data = (await response.json()) as SPAPIResponse
      // Listing issues describe the successfully read product, not a failed GET.
      const errorMessage = this.parseErrors({ ...data, issues: undefined }) || (!response.ok ? `Amazon listing read failed (${response.status})` : null)
      if (errorMessage) {
        return {
          success: false,
          sku,
          asin: null,
          status: null,
          issues: data.issues,
          error: errorMessage,
          rawResponse: data,
        }
      }

      // Per SP-API docs: summaries is an array (one per marketplace included
      // in the request); since we send one marketplaceId, it's a 1-element
      // array with the parent or buyable ASIN.
      const summary = Array.isArray(data.summaries) ? data.summaries[0] : null
      const asin: string | null = summary?.asin ?? data.asin ?? null
      const status: string | null = summary?.status ?? data.status ?? null

      // IE.4 — Image array, when requested via includedData=['images'].
      // Same per-marketplace shape: one outer entry per request. Empty
      // when no 'images' in includedData.
      const rawImagesAny = (data as unknown as { images?: Array<{ images?: SpApiImageVariant[] }> }).images
      const images: SpApiImageVariant[] | undefined =
        Array.isArray(rawImagesAny) && rawImagesAny[0]?.images
          ? rawImagesAny[0].images
          : undefined

      return {
        success: true,
        sku,
        asin,
        status,
        // ALA Phase 4 — surface the issues array on success too (Amazon returns
        // WARNING/INFO issues on a healthy read; previously dropped). Lets callers
        // mirror live listing health, not just post-submit errors.
        issues: data.issues,
        rawResponse: data,
        images,
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      logger.error('Failed getListingsItem', { sku, error: errorMessage })
      return {
        success: false,
        sku,
        asin: null,
        status: null,
        error: errorMessage,
      }
    }
  }

  /**
   * Search the seller's listings items for a marketplace (optionally filtered by
   * ASIN) to discover the REAL seller SKUs. Read-only — used to diagnose why
   * getListingsItem 404s and to find the live listing SKU.
   */
  async searchListingsItems(opts: {
    sellerId: string
    marketplaceId: string
    asin?: string
    pageSize?: number
  }): Promise<{
    success: boolean
    httpStatus: number
    numberOfResults?: number
    items?: Array<{ sku: string; asin: string | null; status: unknown }>
    error?: string
  }> {
    try {
      const accessToken = await this.getAccessToken()
      const url = new URL(
        `https://sellingpartnerapi-${await (await import('../lib/amazon-sp-client.js')).getAmazonRegion()}.amazon.com/listings/2021-08-01/items/${opts.sellerId}`,
      )
      url.searchParams.set('marketplaceIds', opts.marketplaceId)
      url.searchParams.set('includedData', 'summaries')
      url.searchParams.set('pageSize', String(opts.pageSize ?? 10))
      if (opts.asin) {
        url.searchParams.set('identifiers', opts.asin)
        url.searchParams.set('identifiersType', 'ASIN')
      }
      const response = await this.fetchWithRetry(
        url.toString(),
        { method: 'GET', headers: { 'x-amzn-requestid': `nexus-${Date.now()}`, 'x-amz-access-token': accessToken } },
        'searchListingsItems',
      )
      const data = (await response.json().catch(() => ({}))) as {
        numberOfResults?: number
        items?: Array<{ sku: string; summaries?: Array<{ asin?: string; status?: unknown }> }>
      }
      if (response.status >= 400) {
        return { success: false, httpStatus: response.status, error: this.parseErrors(data as never) ?? JSON.stringify(data).slice(0, 300) }
      }
      const items = Array.isArray(data.items)
        ? data.items.map((it) => ({ sku: it.sku, asin: it.summaries?.[0]?.asin ?? null, status: it.summaries?.[0]?.status ?? null }))
        : []
      return { success: true, httpStatus: response.status, numberOfResults: data.numberOfResults, items }
    } catch (error) {
      return { success: false, httpStatus: 0, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Catalog Items API — the images Amazon actually DISPLAYS for an ASIN (global
   * catalog level), with their source m.media-amazon links. Read-only diagnosis:
   * shows whether our feed reached the catalog vs what's currently shown.
   */
  async getCatalogItemImages(asin: string, marketplaceId: string): Promise<{
    success: boolean
    httpStatus: number
    images?: Array<{ variant: string; link: string; w?: number; h?: number }>
    error?: string
  }> {
    try {
      const accessToken = await this.getAccessToken()
      const url = new URL(`https://sellingpartnerapi-${await (await import('../lib/amazon-sp-client.js')).getAmazonRegion()}.amazon.com/catalog/2022-04-01/items/${asin}`)
      url.searchParams.set('marketplaceIds', marketplaceId)
      url.searchParams.set('includedData', 'images,summaries')
      const response = await this.fetchWithRetry(
        url.toString(),
        { method: 'GET', headers: { 'x-amzn-requestid': `nexus-${Date.now()}`, 'x-amz-access-token': accessToken } },
        `getCatalogItem(${asin})`,
      )
      const data = (await response.json().catch(() => ({}))) as {
        images?: Array<{ images?: Array<{ variant: string; link: string; width?: number; height?: number }> }>
      }
      if (response.status >= 400) {
        return { success: false, httpStatus: response.status, error: this.parseErrors(data as never) ?? JSON.stringify(data).slice(0, 300) }
      }
      const group = Array.isArray(data.images) ? data.images[0]?.images ?? [] : []
      return { success: true, httpStatus: response.status, images: group.map((i) => ({ variant: i.variant, link: i.link, w: i.width, h: i.height })) }
    } catch (error) {
      return { success: false, httpStatus: 0, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Catalog Items API — whether an ASIN exists in one marketplace, with its title and brand (summaries). Read-only; the
   * product sheet's ASIN control proves a typed ASIN with it before a draft row lists on it (Item ID control, step I4).
   * Amazon answers 404 for an ASIN it does not have in that marketplace.
   */
  async getCatalogItemSummary(asin: string, marketplaceId: string): Promise<{
    success: boolean
    httpStatus: number
    title?: string | null
    brand?: string | null
    error?: string
  }> {
    try {
      const accessToken = await this.getAccessToken()
      const url = new URL(`https://sellingpartnerapi-${await (await import('../lib/amazon-sp-client.js')).getAmazonRegion(this.boundAccount?.id)}.amazon.com/catalog/2022-04-01/items/${encodeURIComponent(asin)}`)
      url.searchParams.set('marketplaceIds', marketplaceId)
      url.searchParams.set('includedData', 'summaries')
      const response = await this.fetchWithRetry(
        url.toString(),
        { method: 'GET', headers: { 'x-amzn-requestid': `nexus-${Date.now()}`, 'x-amz-access-token': accessToken } },
        `getCatalogItem(${asin})`,
      )
      const data = (await response.json().catch(() => ({}))) as { summaries?: Array<{ itemName?: string; brand?: string }> }
      if (response.status >= 400) {
        return { success: false, httpStatus: response.status, error: this.parseErrors(data as never) ?? JSON.stringify(data).slice(0, 300) }
      }
      const summary = Array.isArray(data.summaries) ? data.summaries[0] : undefined
      return { success: true, httpStatus: response.status, title: summary?.itemName ?? null, brand: summary?.brand ?? null }
    } catch (error) {
      return { success: false, httpStatus: 0, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Batch submit multiple listings
   * Respects rate limiting for each request
   */
  async submitListingPayloadBatch(
    options: SubmitListingPayloadOptions[]
  ): Promise<
    Array<{
      success: boolean
      sku: string
      status?: string
      error?: string
    }>
  > {
    const results = []

    for (const option of options) {
      const result = await this.submitListingPayload(option)
      results.push({
        success: result.success,
        sku: result.sku,
        status: result.status,
        error: result.error,
      })
    }

    logger.info('Batch submission complete', {
      total: options.length,
      successful: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
    })

    return results
  }
}

/**
 * P0.7 (docs/channel-connections/FINAL-PLAN.md) — the listing writes. Before one is sent, the
 * account it will use must be one that owns the SKU(s) it touches (write-account-guard.ts); a SKU
 * that belongs only to another Amazon account is refused, nothing sent. Reads are not checked.
 */
const GUARDED_WRITES = new Set(['submitListingPayload', 'submitListingPayloadBatch', 'putListingsItem', 'patchListingPrice', 'patchPurchasableOffer', 'deleteListingsItem'])

async function guardAmazonWrite(method: string, args: unknown[], accountId: string | undefined): Promise<void> {
  const { assertWriteAccount, assertWriteAccountPerSku } = await import('../services/write-account-guard.js')
  const first = args[0] as { sellerId?: string; accountId?: string; sku?: string; marketplaceId?: string } | Array<{ sku?: string }> | undefined
  let id = accountId
  if (!id) {
    // Profiles OFF (legacy single profile): the account is whatever the seller id resolves to. When
    // nothing resolves there is no second account to confuse it with, so there is nothing to check.
    try {
      const single = Array.isArray(first) ? undefined : first
      id = (await (await import('../lib/amazon-sp-client.js')).amazonAccount({ accountId: single?.accountId, sellerId: single?.sellerId })).id
    } catch {
      return
    }
  }
  if (Array.isArray(first)) {
    await assertWriteAccountPerSku('AMAZON', id, first.map((o) => o?.sku))
    return
  }
  await assertWriteAccount('AMAZON', id, { skus: [first?.sku], marketplace: first?.marketplaceId })
}

// Singleton instance
const legacyAmazonClient = new AmazonSpApiClient()
export const amazonSpApiClient = new Proxy(legacyAmazonClient, {
  get(target, property) {
    const value = Reflect.get(target, property, target)
    if (typeof value !== 'function') return value
    if (property === 'getGrantlessToken') return value.bind(target)
    return async (...args: unknown[]) => {
      const guarded = GUARDED_WRITES.has(String(property))
      if (process.env.NEXUS_WORKSPACES_ENABLED !== '1') {
        if (guarded) await guardAmazonWrite(String(property), args, undefined)
        return value.apply(target, args)
      }
      const { amazonAccount, getAmazonRegion } = await import('../lib/amazon-sp-client.js')
      const options = args[0] as { accountId?: string; sellerId?: string } | undefined
      const account = await amazonAccount({ accountId: options?.accountId, sellerId: options?.sellerId })
      if (!account) throw new Error('Select an Amazon seller account.')
      if (guarded) await guardAmazonWrite(String(property), args, account.id)
      const client = new AmazonSpApiClient({ id: account.id, region: await getAmazonRegion(account.id) })
      return Reflect.get(client, property).apply(client, args)
    }
  },
})
