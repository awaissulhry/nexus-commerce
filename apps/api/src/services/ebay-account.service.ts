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
      ),
      fetchPolicy(
        `${apiBase}/sell/account/v1/payment_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`,
        headers,
        'paymentPolicies',
      ),
      fetchPolicy(
        `${apiBase}/sell/account/v1/return_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`,
        headers,
        'returnPolicies',
      ),
      fetchLocations(`${apiBase}/sell/inventory/v1/location`, headers),
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
): Promise<EbayPolicySummary[]> {
  let res: Response
  try {
    res = await fetch(url, { headers })
  } catch (err) {
    console.warn(
      `[EbayAccountService] ${arrayKey} network error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return []
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.warn(
      `[EbayAccountService] ${arrayKey} ${res.status}: ${body.slice(0, 300)}`,
    )
    return []
  }
  const json = (await res.json().catch(() => null)) as Record<
    string,
    unknown
  > | null
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
): Promise<EbayMerchantLocation[]> {
  let res: Response
  try {
    res = await fetch(url, { headers })
  } catch (err) {
    console.warn(
      `[EbayAccountService] locations network error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return []
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.warn(
      `[EbayAccountService] locations ${res.status}: ${body.slice(0, 300)}`,
    )
    return []
  }
  const json = (await res.json().catch(() => null)) as {
    locations?: Array<{
      merchantLocationKey?: string
      name?: string
      location?: { address?: { country?: string } }
    }>
  } | null
  return (json?.locations ?? [])
    .map((l) => ({
      key: l.merchantLocationKey ?? '',
      name: l.name ?? l.merchantLocationKey ?? '',
      country: l.location?.address?.country ?? null,
    }))
    .filter((l) => l.key.length > 0)
}

export const ebayAccountService = new EbayAccountService()
