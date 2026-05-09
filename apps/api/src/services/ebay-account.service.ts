/**
 * GG.2 — eBay Account API wrapper.
 *
 * Surfaces the seller's configured business policies (fulfillment,
 * payment, return) and inventory locations so the publish adapter
 * can pick a policy id at submit time instead of relying on a
 * pre-configured ChannelConnection.connectionMetadata.ebayPolicies
 * blob. Cache is per-(connection, marketplace) for 5 minutes since
 * sellers do edit policies and we want recent edits to surface
 * without a manual refresh.
 *
 * Endpoints:
 *   GET /sell/account/v1/fulfillment_policy?marketplace_id={id}
 *   GET /sell/account/v1/payment_policy?marketplace_id={id}
 *   GET /sell/account/v1/return_policy?marketplace_id={id}
 *   GET /sell/inventory/v1/location
 */

import { ebayAuthService } from './ebay-auth.service.js'
import { recordApiCall } from './outbound-api-call-log.service.js'

export interface EbayPolicySummary {
  /** eBay-assigned id, used as fulfillmentPolicyId / paymentPolicyId
   *  / returnPolicyId on createOffer. */
  id: string
  /** Seller-supplied name (shown in Seller Hub). */
  name: string
  /** First marketplace this policy applies to. eBay returns an
   *  array; we surface only the first since policies almost always
   *  scope to a single market. */
  marketplaceId: string | null
}

export interface EbayMerchantLocation {
  /** Seller-defined merchantLocationKey, used as the offer's
   *  merchantLocationKey on createOffer. */
  key: string
  name: string
  country: string | null
}

export interface EbayAccountSnapshot {
  fulfillmentPolicies: EbayPolicySummary[]
  paymentPolicies: EbayPolicySummary[]
  returnPolicies: EbayPolicySummary[]
  locations: EbayMerchantLocation[]
}

interface CachedSnapshot {
  data: EbayAccountSnapshot
  expiresAt: number
}

const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

export class EbayAccountService {
  private cache = new Map<string, CachedSnapshot>()

  /**
   * Fetch every policy + location for this connection scoped to
   * marketplaceId. Returns lists; the publish adapter / settings UI
   * picks one per kind.
   */
  async getSnapshot(
    connectionId: string,
    marketplaceId: string,
    options?: { forceRefresh?: boolean },
  ): Promise<EbayAccountSnapshot> {
    const key = `${connectionId}:${marketplaceId}`
    if (!options?.forceRefresh) {
      const cached = this.cache.get(key)
      if (cached && cached.expiresAt > Date.now()) return cached.data
    }
    const token = await ebayAuthService.getValidToken(connectionId)
    const apiBase = process.env.EBAY_API_BASE ?? 'https://api.ebay.com'
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    }
    const [fulfillment, payment, returnRes, locations] = await Promise.all([
      fetchPolicy(
        `${apiBase}/sell/account/v1/fulfillment_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`,
        headers,
        'fulfillmentPolicies',
        '/sell/account/v1/fulfillment_policy',
        'getFulfillmentPolicies',
        marketplaceId,
        connectionId,
      ),
      fetchPolicy(
        `${apiBase}/sell/account/v1/payment_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`,
        headers,
        'paymentPolicies',
        '/sell/account/v1/payment_policy',
        'getPaymentPolicies',
        marketplaceId,
        connectionId,
      ),
      fetchPolicy(
        `${apiBase}/sell/account/v1/return_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`,
        headers,
        'returnPolicies',
        '/sell/account/v1/return_policy',
        'getReturnPolicies',
        marketplaceId,
        connectionId,
      ),
      fetchLocations(
        `${apiBase}/sell/inventory/v1/location`,
        headers,
        connectionId,
      ),
    ])
    const snapshot: EbayAccountSnapshot = {
      fulfillmentPolicies: fulfillment,
      paymentPolicies: payment,
      returnPolicies: returnRes,
      locations,
    }
    this.cache.set(key, {
      data: snapshot,
      expiresAt: Date.now() + CACHE_TTL,
    })
    return snapshot
  }

  clearCache(): void {
    this.cache.clear()
  }
}

async function fetchPolicy(
  url: string,
  headers: Record<string, string>,
  arrayKey: 'fulfillmentPolicies' | 'paymentPolicies' | 'returnPolicies',
  endpoint: string,
  operation: string,
  marketplaceId: string,
  connectionId: string,
): Promise<EbayPolicySummary[]> {
  let json:
    | (Record<string, unknown> | null)
  try {
    json = await recordApiCall<Record<string, unknown> | null>(
      {
        channel: 'EBAY',
        operation,
        endpoint,
        method: 'GET',
        marketplace: marketplaceId,
        connectionId,
        triggeredBy: 'api',
      },
      async () => {
        const res = await fetch(url, { headers })
        if (!res.ok) {
          const errorBody = await res.text().catch(() => '')
          const err = new Error(
            `eBay API error ${res.status}: ${errorBody.slice(0, 500)}`,
          ) as Error & { statusCode: number; body: string }
          err.statusCode = res.status
          err.body = errorBody
          throw err
        }
        return (await res.json().catch(() => null)) as Record<
          string,
          unknown
        > | null
      },
    )
  } catch (err) {
    console.warn(
      `[EbayAccountService] ${arrayKey} error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return []
  }
  const list = json && Array.isArray(json[arrayKey]) ? (json[arrayKey] as Array<{
    fulfillmentPolicyId?: string
    paymentPolicyId?: string
    returnPolicyId?: string
    name?: string
    marketplaceId?: string
  }>) : []
  return list.map((p) => ({
    id:
      p.fulfillmentPolicyId ??
      p.paymentPolicyId ??
      p.returnPolicyId ??
      '',
    name: p.name ?? '',
    marketplaceId: p.marketplaceId ?? null,
  })).filter((p) => p.id.length > 0)
}

async function fetchLocations(
  url: string,
  headers: Record<string, string>,
  connectionId: string,
): Promise<EbayMerchantLocation[]> {
  let json:
    | {
        locations?: Array<{
          merchantLocationKey?: string
          name?: string
          location?: { address?: { country?: string } }
        }>
      }
    | null
  try {
    json = await recordApiCall<{
      locations?: Array<{
        merchantLocationKey?: string
        name?: string
        location?: { address?: { country?: string } }
      }>
    } | null>(
      {
        channel: 'EBAY',
        operation: 'getInventoryLocations',
        endpoint: '/sell/inventory/v1/location',
        method: 'GET',
        connectionId,
        triggeredBy: 'api',
      },
      async () => {
        const res = await fetch(url, { headers })
        if (!res.ok) {
          const errorBody = await res.text().catch(() => '')
          const err = new Error(
            `eBay API error ${res.status}: ${errorBody.slice(0, 500)}`,
          ) as Error & { statusCode: number; body: string }
          err.statusCode = res.status
          err.body = errorBody
          throw err
        }
        return (await res.json().catch(() => null)) as {
          locations?: Array<{
            merchantLocationKey?: string
            name?: string
            location?: { address?: { country?: string } }
          }>
        } | null
      },
    )
  } catch (err) {
    console.warn(
      `[EbayAccountService] locations error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return []
  }
  return (json?.locations ?? [])
    .map((l) => ({
      key: l.merchantLocationKey ?? '',
      name: l.name ?? l.merchantLocationKey ?? '',
      country: l.location?.address?.country ?? null,
    }))
    .filter((l) => l.key.length > 0)
}

export const ebayAccountService = new EbayAccountService()
