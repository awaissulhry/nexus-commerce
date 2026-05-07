/**
 * Phase 12f: Amazon SP-API Client
 * 
 * Production HTTP client for Amazon Selling Partner API
 * - Login With Amazon (LWA) authentication with token caching
 * - Listings Items v2021-08-01 endpoint integration
 * - Rate limiting (5 requests/second)
 * - Error parsing for SP-API issues array
 */

import { logger } from '../utils/logger.js'

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
   *  (parent ASIN + status). */
  includedData?: Array<'summaries' | 'attributes' | 'issues' | 'offers'>
}

export class AmazonSpApiClient {
  private accessToken: string | null = null
  private tokenExpiresAt: number = 0
  private lastRequestTime: number = 0
  private readonly REQUEST_DELAY_MS = 200 // 5 requests/second = 200ms between requests

  private readonly clientId: string
  private readonly clientSecret: string
  private readonly refreshToken: string
  private readonly region: string

  constructor() {
    this.clientId = process.env.AMAZON_CLIENT_ID || ''
    this.clientSecret = process.env.AMAZON_CLIENT_SECRET || ''
    this.refreshToken = process.env.AMAZON_REFRESH_TOKEN || ''
    this.region = process.env.AMAZON_REGION || 'us-east-1'

    if (!this.clientId || !this.clientSecret || !this.refreshToken) {
      logger.warn('Amazon SP-API credentials not fully configured', {
        hasClientId: !!this.clientId,
        hasClientSecret: !!this.clientSecret,
        hasRefreshToken: !!this.refreshToken,
      })
    }
  }

  /**
   * Get or refresh access token from Login With Amazon (LWA)
   * Caches token for 50 minutes to avoid spamming auth endpoint
   */
  async getAccessToken(): Promise<string> {
    const now = Date.now()

    // Return cached token if still valid (50 minute cache)
    if (this.accessToken && now < this.tokenExpiresAt) {
      logger.debug('Using cached LWA token', {
        expiresIn: Math.round((this.tokenExpiresAt - now) / 1000),
      })
      return this.accessToken
    }

    logger.info('Requesting new LWA token')

    try {
      const response = await fetch('https://api.amazon.com/auth/o2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.refreshToken,
          client_id: this.clientId,
          client_secret: this.clientSecret,
        }).toString(),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`LWA auth failed: ${response.status} - ${errorText}`)
      }

      const data = (await response.json()) as LWATokenResponse

      // Cache token for 50 minutes (3000 seconds)
      this.accessToken = data.access_token
      this.tokenExpiresAt = now + 50 * 60 * 1000

      logger.info('LWA token obtained successfully', {
        expiresIn: data.expires_in,
        cacheUntil: new Date(this.tokenExpiresAt).toISOString(),
      })

      return this.accessToken
    } catch (error) {
      logger.error('Failed to get LWA token', {
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  /**
   * Apply rate limiting (200ms delay between requests)
   * Ensures we respect Amazon's 5 requests/second limit
   */
  private async applyRateLimit(): Promise<void> {
    const now = Date.now()
    const timeSinceLastRequest = now - this.lastRequestTime

    if (timeSinceLastRequest < this.REQUEST_DELAY_MS) {
      const delayNeeded = this.REQUEST_DELAY_MS - timeSinceLastRequest
      logger.debug('Rate limiting', { delayMs: delayNeeded })
      await new Promise((resolve) => setTimeout(resolve, delayNeeded))
    }

    this.lastRequestTime = Date.now()
  }

  /**
   * C.1 — fetch wrapper with exponential backoff on transient errors.
   *
   * Retries on:
   *   - Network errors (fetch throws — DNS / TCP / TLS / connection reset)
   *   - HTTP 429 (Too Many Requests — SP-API rate limit + LWA throttling)
   *   - HTTP 500, 502, 503, 504 (transient server / gateway issues)
   *
   * Does NOT retry on:
   *   - 4xx (other than 429) — caller error, fail fast so wizard surfaces
   *     it as actionable
   *   - HTTP 401/403 — credentials wrong, retrying won't help
   *
   * Backoff schedule: 1s, 2s, 4s (3 retries on top of the initial attempt).
   * Rate-limiter applies before EACH attempt so the per-request 200ms gap
   * is preserved across retries.
   *
   * Failed-after-retries returns the last Response (so callers see the
   * upstream status / body) or throws the last network error.
   */
  private static readonly RETRY_DELAYS_MS = [1000, 2000, 4000] as const
  private static readonly RETRYABLE_STATUSES = new Set([
    429, 500, 502, 503, 504,
  ])

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    label: string,
  ): Promise<Response> {
    let lastErr: unknown = null
    const maxAttempts = AmazonSpApiClient.RETRY_DELAYS_MS.length + 1
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await this.applyRateLimit()
      try {
        const response = await fetch(url, init)
        if (!AmazonSpApiClient.RETRY_DELAYS_MS[attempt]) {
          // Final attempt — return whatever we got, retryable or not.
          return response
        }
        if (!AmazonSpApiClient.RETRYABLE_STATUSES.has(response.status)) {
          return response
        }
        // Response says "try again" — read body to free the connection,
        // then sleep + loop. We don't reuse the response after this.
        try {
          await response.text()
        } catch {
          // Ignore body-read failures — we're discarding it anyway.
        }
        const delay = AmazonSpApiClient.RETRY_DELAYS_MS[attempt]!
        logger.warn('SP-API retryable status — backing off', {
          label,
          attempt: attempt + 1,
          status: response.status,
          delayMs: delay,
        })
        await new Promise((r) => setTimeout(r, delay))
        continue
      } catch (err) {
        lastErr = err
        if (!AmazonSpApiClient.RETRY_DELAYS_MS[attempt]) {
          throw err
        }
        const delay = AmazonSpApiClient.RETRY_DELAYS_MS[attempt]!
        logger.warn('SP-API network error — backing off', {
          label,
          attempt: attempt + 1,
          error: err instanceof Error ? err.message : String(err),
          delayMs: delay,
        })
        await new Promise((r) => setTimeout(r, delay))
      }
    }
    // Defensive fallthrough — the loop always returns or throws.
    throw lastErr instanceof Error
      ? lastErr
      : new Error('SP-API fetchWithRetry exhausted')
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
   * Submit listing payload to Amazon SP-API
   * Listings Items v2021-08-01 endpoint
   */
  async submitListingPayload(options: SubmitListingPayloadOptions): Promise<{
    success: boolean
    sku: string
    status?: string
    error?: string
    rawResponse?: SPAPIResponse
  }> {
    const { sellerId, sku, payload } = options

    try {
      // Get access token (rate limit applied per attempt by fetchWithRetry)
      const accessToken = await this.getAccessToken()

      logger.info('Submitting listing to Amazon SP-API', {
        sku,
        sellerId,
        payloadSize: JSON.stringify(payload).length,
      })

      // Submit to SP-API (with retry/backoff on 429/5xx + network errors)
      const response = await this.fetchWithRetry(
        `https://sellingpartnerapi-${this.region}.amazon.com/listings/2021-08-01/items/${sellerId}/${sku}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'x-amzn-requestid': `nexus-${Date.now()}`,
            Authorization: `Bearer ${accessToken}`,
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

      // Check for errors in issues array (SP-API returns 200/207 even on errors)
      const errorMessage = this.parseErrors(data)
      if (errorMessage) {
        logger.warn('SP-API returned errors in issues array', {
          sku,
          errors: errorMessage,
        })

        return {
          success: false,
          sku,
          error: errorMessage,
          rawResponse: data,
        }
      }

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
  }> {
    const { sellerId, sku, marketplaceId, productType, price, currencyCode, taxInclusive } = options

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
        `https://sellingpartnerapi-${this.region}.amazon.com/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(
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
            Authorization: `Bearer ${accessToken}`,
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
  }> {
    const {
      sellerId,
      sku,
      marketplaceId,
      productType,
      attributes,
      requirements = 'LISTING',
    } = options

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
      })

      const url = new URL(
        `https://sellingpartnerapi-${this.region}.amazon.com/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(
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
            Authorization: `Bearer ${accessToken}`,
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
        `https://sellingpartnerapi-${this.region}.amazon.com/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(
          sku,
        )}`,
      )
      url.searchParams.set('marketplaceIds', marketplaceId)
      for (const d of includedData) {
        url.searchParams.append('includedData', d)
      }

      const response = await this.fetchWithRetry(
        url.toString(),
        {
          method: 'GET',
          headers: {
            'x-amzn-requestid': `nexus-${Date.now()}`,
            Authorization: `Bearer ${accessToken}`,
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
      const errorMessage = this.parseErrors(data)
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

      return {
        success: true,
        sku,
        asin,
        status,
        rawResponse: data,
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

// Singleton instance
export const amazonSpApiClient = new AmazonSpApiClient()
