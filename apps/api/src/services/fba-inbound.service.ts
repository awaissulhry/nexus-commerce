/**
 * H.8a (Inbound) — real Amazon SP-API createInboundShipmentPlan.
 *
 * Replaces the H.0c-honesty-banner stub at /fulfillment/fba/plan-shipment
 * with a real call to Amazon's FBA Inbound v0 endpoint.
 *
 * Why direct HTTP instead of the amazon-sp-api library:
 *   The library at v1.2.1 only exposes the GET operations under the
 *   v0 fulfillment_inbound resource (getPrepInstructions, getLabels,
 *   getBillOfLading, getShipments, getShipmentItemsByShipmentId,
 *   getShipmentItems). The POST createInboundShipmentPlan is missing
 *   from the resource map even though Amazon's endpoint still
 *   accepts it. Rather than monkey-patch the library, we call the
 *   endpoint directly with an LWA-fetched bearer token. Modern SP-API
 *   no longer requires AWS SigV4 (deprecated 2023), so a Bearer token
 *   in `x-amz-access-token` is sufficient.
 *
 * Why v0 not 2024-03-20:
 *   2024-03-20 is a multi-step flow: createInboundPlan → packing
 *   options → set packing → placement options → confirm placement,
 *   spread across H.8a..d. v0 is a single-call plan that returns
 *   shipment IDs directly. Pre-launch context — Xavia gets working
 *   FBA today; migration to 2024-03-20 happens before Amazon shuts
 *   off v0 (TECH_DEBT entry on this commit).
 *
 * LWA token lifecycle: cached in-memory with 5-minute safety margin
 * before Amazon's stated 1h expiry. Acquired on demand.
 */

import { logger } from '../utils/logger.js'
import prisma from '../db.js'

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token'
const REGION_ENDPOINTS: Record<string, string> = {
  na: 'https://sellingpartnerapi-na.amazon.com',
  eu: 'https://sellingpartnerapi-eu.amazon.com',
  fe: 'https://sellingpartnerapi-fe.amazon.com',
}
const SP_REGION = (process.env.AMAZON_SP_REGION ?? 'eu') as keyof typeof REGION_ENDPOINTS

let cachedToken: { value: string; expiresAt: number } | null = null

async function getLwaAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 5 * 60_000) {
    return cachedToken.value
  }
  const clientId = process.env.AMAZON_LWA_CLIENT_ID
  const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET
  const refreshToken = process.env.AMAZON_REFRESH_TOKEN
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('SP-API not configured (AMAZON_LWA_CLIENT_ID / AMAZON_LWA_CLIENT_SECRET / AMAZON_REFRESH_TOKEN)')
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  })
  const res = await fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`LWA token exchange failed: ${res.status} ${text.slice(0, 200)}`)
  }
  const json = (await res.json()) as { access_token: string; expires_in: number }
  cachedToken = {
    value: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  }
  return json.access_token
}

export function isFbaInboundConfigured(): boolean {
  return !!(
    process.env.AMAZON_LWA_CLIENT_ID &&
    process.env.AMAZON_LWA_CLIENT_SECRET &&
    process.env.AMAZON_REFRESH_TOKEN &&
    process.env.AMAZON_MARKETPLACE_ID
  )
}

// ─── Types mirror the v0 createInboundShipmentPlan request/response ─

export interface PlanItemInput {
  sellerSku: string
  quantity: number
  asin?: string
  condition?: 'NewItem' | 'NewWithWarranty' | 'NewOEM' | 'NewOpenBox' | 'UsedLikeNew' | 'UsedVeryGood' | 'UsedGood' | 'UsedAcceptable' | 'UsedPoor' | 'UsedRefurbished' | 'CollectibleLikeNew' | 'CollectibleVeryGood' | 'CollectibleGood' | 'CollectibleAcceptable' | 'CollectiblePoor' | 'RefurbishedWithWarranty' | 'Refurbished' | 'Club'
  quantityInCase?: number
}

export interface ShipFromAddress {
  Name: string
  AddressLine1: string
  AddressLine2?: string
  City: string
  StateOrProvinceCode: string
  CountryCode: string
  PostalCode: string
}

export interface InboundShipmentPlanResponse {
  ShipmentId: string
  DestinationFulfillmentCenterId: string
  ShipToAddress: ShipFromAddress
  LabelPrepType: 'NO_LABEL' | 'SELLER_LABEL' | 'AMAZON_LABEL'
  Items: Array<{
    SellerSKU: string
    FulfillmentNetworkSKU?: string
    Quantity: number
    PrepDetailsList?: Array<{ PrepInstruction: string; PrepOwner: string }>
  }>
}

export interface CreatePlanResult {
  shipmentPlans: InboundShipmentPlanResponse[]
}

/**
 * Resolve the ship-from address from the default Warehouse row,
 * with env-var overrides for fields the legacy schema doesn't
 * carry (Name, StateOrProvinceCode — Italy uses an empty string
 * but Amazon requires the field present).
 */
async function resolveShipFromAddress(): Promise<ShipFromAddress> {
  const w = await prisma.warehouse.findFirst({
    where: { isDefault: true, isActive: true },
    select: { code: true, name: true, addressLine1: true, addressLine2: true, city: true, postalCode: true, country: true },
  })
  const fallbackName = process.env.NEXUS_FBA_SHIP_FROM_NAME ?? w?.name ?? 'Nexus Warehouse'
  const fallbackLine1 = process.env.NEXUS_FBA_SHIP_FROM_LINE1 ?? w?.addressLine1 ?? ''
  const fallbackCity = process.env.NEXUS_FBA_SHIP_FROM_CITY ?? w?.city ?? ''
  const fallbackPostal = process.env.NEXUS_FBA_SHIP_FROM_POSTAL ?? w?.postalCode ?? ''
  const fallbackCountry = process.env.NEXUS_FBA_SHIP_FROM_COUNTRY ?? w?.country ?? 'IT'
  const fallbackState = process.env.NEXUS_FBA_SHIP_FROM_STATE ?? '' // Italy doesn't use state codes
  if (!fallbackLine1 || !fallbackCity || !fallbackPostal) {
    throw new Error(
      'FBA ship-from address incomplete. Set Warehouse.addressLine1/city/postalCode on the default warehouse, ' +
        'or override with NEXUS_FBA_SHIP_FROM_LINE1 / _CITY / _POSTAL env vars.',
    )
  }
  const addr: ShipFromAddress = {
    Name: fallbackName,
    AddressLine1: fallbackLine1,
    City: fallbackCity,
    StateOrProvinceCode: fallbackState,
    CountryCode: fallbackCountry,
    PostalCode: fallbackPostal,
  }
  if (w?.addressLine2) addr.AddressLine2 = w.addressLine2
  return addr
}

/**
 * Call SP-API v0 createInboundShipmentPlan. Returns the plan(s) Amazon
 * generated — usually 1 per destination FC. Persists nothing here;
 * caller decides whether to commit (handled in a future commit creating
 * shipments from these plans).
 */
export async function createInboundShipmentPlan(args: {
  items: PlanItemInput[]
  shipFrom?: ShipFromAddress
  labelPrepPreference?: 'SELLER_LABEL' | 'AMAZON_LABEL_ONLY' | 'AMAZON_LABEL_PREFERRED'
}): Promise<CreatePlanResult> {
  if (!isFbaInboundConfigured()) {
    throw new Error('SP-API not configured (set AMAZON_LWA_* + AMAZON_MARKETPLACE_ID)')
  }
  if (!args.items || args.items.length === 0) {
    throw new Error('items[] required')
  }

  const shipFrom = args.shipFrom ?? (await resolveShipFromAddress())
  const labelPrepPreference = args.labelPrepPreference ?? 'SELLER_LABEL'
  const marketplaceId = process.env.AMAZON_MARKETPLACE_ID!
  const token = await getLwaAccessToken()

  // SP-API v0 createInboundShipmentPlan body shape per Amazon docs.
  const body = {
    ShipFromAddress: shipFrom,
    LabelPrepPreference: labelPrepPreference,
    InboundShipmentPlanRequestItems: args.items.map((it) => ({
      SellerSKU: it.sellerSku,
      Quantity: it.quantity,
      ASIN: it.asin ?? '',
      Condition: it.condition ?? 'NewItem',
      ...(it.quantityInCase != null ? { QuantityInCase: it.quantityInCase } : {}),
    })),
  }

  const url = `${REGION_ENDPOINTS[SP_REGION]}/fba/inbound/v0/plans?MarketplaceId=${encodeURIComponent(marketplaceId)}`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-amz-access-token': token,
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
  })

  const text = await res.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }

  if (!res.ok) {
    const errMsg = data?.errors?.[0]?.message ?? data?.message ?? text.slice(0, 300)
    logger.warn('fba-inbound: createInboundShipmentPlan failed', {
      status: res.status,
      err: errMsg,
    })
    throw new Error(`SP-API createInboundShipmentPlan ${res.status}: ${errMsg}`)
  }

  const plans = data?.payload?.InboundShipmentPlans ?? []
  return {
    shipmentPlans: plans as InboundShipmentPlanResponse[],
  }
}
