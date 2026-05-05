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

interface SPAPIResponse {
  sku?: string
  status?: string
  issues?: Array<{
    code: string
    message: string
    details?: string
  }>
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
   * Parse SP-API error response
   * SP-API returns 200/207 even on errors, with issues array
   */
  private parseErrors(response: SPAPIResponse): string | null {
    if (!response.issues || response.issues.length === 0) {
      return null
    }

    const errorMessages = response.issues.map((issue) => {
      const code = issue.code || 'UNKNOWN'
      const message = issue.message || 'Unknown error'
      const details = issue.details ? ` (${issue.details})` : ''
      return `${code}: ${message}${details}`
    })

    return errorMessages.join(' | ')
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
      // Apply rate limiting
      await this.applyRateLimit()

      // Get access token
      const accessToken = await this.getAccessToken()

      logger.info('Submitting listing to Amazon SP-API', {
        sku,
        sellerId,
        payloadSize: JSON.stringify(payload).length,
      })

      // Submit to SP-API
      const response = await fetch(
        `https://sellingpartnerapi-${this.region}.amazon.com/listings/2021-08-01/items/${sellerId}/${sku}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'x-amzn-requestid': `nexus-${Date.now()}`,
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify(payload),
        }
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
      await this.applyRateLimit()
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

      const response = await fetch(url.toString(), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-amzn-requestid': `nexus-${Date.now()}`,
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body),
      })

      const data = (await response.json()) as SPAPIResponse

      const errorMessage = this.parseErrors(data)
      if (errorMessage) {
        logger.warn('SP-API putListingsItem returned issues', {
          sku,
          errors: errorMessage,
        })
        return {
          success: false,
          sku,
          submissionId: data.submissionId,
          issues: data.issues,
          error: errorMessage,
          rawResponse: data,
        }
      }

      return {
        success: true,
        sku,
        submissionId: data.submissionId,
        status: data.status,
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
      await this.applyRateLimit()
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

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'x-amzn-requestid': `nexus-${Date.now()}`,
          Authorization: `Bearer ${accessToken}`,
        },
      })

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
