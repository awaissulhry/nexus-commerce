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

// ─── H.8b — getLabels ──────────────────────────────────────────────

export type FbaPageType =
  | 'PackageLabel_Letter_2' | 'PackageLabel_Letter_4' | 'PackageLabel_Letter_6'
  | 'PackageLabel_Letter_6_CarrierLeft'
  | 'PackageLabel_A4_2' | 'PackageLabel_A4_4'
  | 'PackageLabel_Plain_Paper' | 'PackageLabel_Plain_Paper_CarrierBottom'
  | 'PackageLabel_Thermal' | 'PackageLabel_Thermal_Unified'
  | 'PackageLabel_Thermal_NonPCP' | 'PackageLabel_Thermal_No_Carrier_Rotation'

export type FbaLabelType = 'BARCODE_2D' | 'UNIQUE' | 'PALLET'

export interface GetLabelsArgs {
  shipmentId: string
  pageType?: FbaPageType
  labelType?: FbaLabelType
  numberOfPackages?: number
  packageLabelsToPrint?: string[]
  numberOfPallets?: number
}

export interface GetLabelsResult {
  /** Amazon-hosted temp URL to a multi-page PDF. Expires within minutes. */
  downloadUrl: string
}

/**
 * H.8b — Call SP-API v0 getLabels. Returns a short-lived Amazon CDN
 * URL for the FNSKU/carton labels PDF; the frontend renders it as a
 * download link.
 *
 * Defaults pick the EU-friendly A4_4 layout + BARCODE_2D for FNSKU
 * unit labels. Pass `labelType: 'UNIQUE'` for carton labels and
 * `labelType: 'PALLET'` for pallet labels.
 *
 * Direct HTTP for consistency with H.8a — same LWA token cache, same
 * region resolution. The amazon-sp-api library does have getLabels in
 * its v0 resource map, but routing through the same fetch flow keeps
 * error handling uniform across the FBA inbound surface.
 */
export async function getInboundShipmentLabels(args: GetLabelsArgs): Promise<GetLabelsResult> {
  if (!isFbaInboundConfigured()) {
    throw new Error('SP-API not configured (set AMAZON_LWA_* + AMAZON_MARKETPLACE_ID)')
  }
  if (!args.shipmentId) throw new Error('shipmentId required')

  const pageType = args.pageType ?? 'PackageLabel_A4_4'
  const labelType = args.labelType ?? 'BARCODE_2D'
  const token = await getLwaAccessToken()

  const qs = new URLSearchParams()
  qs.set('PageType', pageType)
  qs.set('LabelType', labelType)
  if (args.numberOfPackages != null) qs.set('NumberOfPackages', String(args.numberOfPackages))
  if (args.numberOfPallets != null) qs.set('NumberOfPallets', String(args.numberOfPallets))
  if (args.packageLabelsToPrint && args.packageLabelsToPrint.length > 0) {
    qs.set('PackageLabelsToPrint', args.packageLabelsToPrint.join(','))
  }

  const url = `${REGION_ENDPOINTS[SP_REGION]}/fba/inbound/v0/shipments/${encodeURIComponent(args.shipmentId)}/labels?${qs.toString()}`

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'x-amz-access-token': token,
      'Accept': 'application/json',
    },
  })

  const text = await res.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }

  if (!res.ok) {
    const errMsg = data?.errors?.[0]?.message ?? data?.message ?? text.slice(0, 300)
    logger.warn('fba-inbound: getLabels failed', { status: res.status, shipmentId: args.shipmentId, err: errMsg })
    throw new Error(`SP-API getLabels ${res.status}: ${errMsg}`)
  }

  const downloadUrl = data?.payload?.DownloadURL
  if (!downloadUrl) {
    throw new Error('SP-API getLabels: no DownloadURL in response')
  }
  return { downloadUrl }
}

// ─── H.8c — putTransportDetails ────────────────────────────────────

export type FbaShipmentType = 'SP' | 'LTL'

export interface NonPartneredSmallParcelInput {
  carrierName: string
  /** One trackingId per box. Length defines the carton count for SP-API. */
  trackingIds: string[]
}

export interface NonPartneredLtlInput {
  carrierName: string
  proNumber: string
}

export interface PutTransportArgs {
  shipmentId: string
  shipmentType: FbaShipmentType
  /** Exactly one of these matching shipmentType. */
  smallParcel?: NonPartneredSmallParcelInput
  ltl?: NonPartneredLtlInput
}

export interface PutTransportResult {
  transportStatus: string
}

/**
 * H.8c — Call SP-API v0 putTransportDetails for a non-partnered
 * carrier. Partnered (UPS etc.) is US/UK-centric and not on Xavia's
 * happy path, so we ship non-partnered first and add partnered later
 * if needed.
 *
 * Endpoint: PUT /fba/inbound/v0/shipments/{shipmentId}/transport
 *
 * Body shape mirrors Amazon's spec exactly. After putTransport, the
 * shipment's TransportStatus moves to WORKING; operator confirms
 * (or it auto-confirms for non-partnered) and the shipment is
 * cleared to ship.
 */
export async function putInboundShipmentTransport(args: PutTransportArgs): Promise<PutTransportResult> {
  if (!isFbaInboundConfigured()) {
    throw new Error('SP-API not configured (set AMAZON_LWA_* + AMAZON_MARKETPLACE_ID)')
  }
  if (!args.shipmentId) throw new Error('shipmentId required')
  if (args.shipmentType === 'SP') {
    if (!args.smallParcel) throw new Error('smallParcel required for shipmentType=SP')
    if (!args.smallParcel.carrierName) throw new Error('smallParcel.carrierName required')
    if (!args.smallParcel.trackingIds || args.smallParcel.trackingIds.length === 0) {
      throw new Error('smallParcel.trackingIds[] required (one per box)')
    }
  } else if (args.shipmentType === 'LTL') {
    if (!args.ltl) throw new Error('ltl required for shipmentType=LTL')
    if (!args.ltl.carrierName) throw new Error('ltl.carrierName required')
    if (!args.ltl.proNumber) throw new Error('ltl.proNumber required')
  } else {
    throw new Error(`Unsupported shipmentType: ${args.shipmentType}`)
  }

  const token = await getLwaAccessToken()

  const transportDetails: Record<string, unknown> =
    args.shipmentType === 'SP'
      ? {
          NonPartneredSmallParcelData: {
            CarrierName: args.smallParcel!.carrierName,
            PackageList: args.smallParcel!.trackingIds.map((t) => ({ TrackingId: t })),
          },
        }
      : {
          NonPartneredLtlData: {
            CarrierName: args.ltl!.carrierName,
            ProNumber: args.ltl!.proNumber,
          },
        }

  const body = {
    IsPartnered: false,
    ShipmentType: args.shipmentType,
    TransportDetails: transportDetails,
  }

  const url = `${REGION_ENDPOINTS[SP_REGION]}/fba/inbound/v0/shipments/${encodeURIComponent(args.shipmentId)}/transport`

  const res = await fetch(url, {
    method: 'PUT',
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
    logger.warn('fba-inbound: putTransportDetails failed', {
      status: res.status,
      shipmentId: args.shipmentId,
      err: errMsg,
    })
    throw new Error(`SP-API putTransportDetails ${res.status}: ${errMsg}`)
  }

  const transportStatus = data?.payload?.TransportResult?.TransportStatus ?? 'WORKING'
  return { transportStatus }
}

// ─── H.8d — getShipments (status polling) ──────────────────────────

/** Amazon's full ShipmentStatus enum, plus null for safety. */
export type AmazonShipmentStatus =
  | 'WORKING' | 'READY_TO_SHIP' | 'SHIPPED' | 'IN_TRANSIT'
  | 'DELIVERED' | 'CHECKED_IN' | 'RECEIVING' | 'CLOSED'
  | 'CANCELLED' | 'DELETED' | 'ERROR'

export interface AmazonShipmentRow {
  ShipmentId: string
  ShipmentName?: string
  ShipmentStatus: AmazonShipmentStatus
  DestinationFulfillmentCenterId?: string
  LabelPrepType?: string
  AreCasesRequired?: boolean
  ConfirmedNeedByDate?: string
  BoxContentsSource?: string
}

export interface GetShipmentsResult {
  shipments: AmazonShipmentRow[]
  nextToken?: string
}

/**
 * H.8d — Call SP-API v0 getShipments. Returns the current state of
 * shipments matching the requested status filter. Used by the
 * polling cron to reconcile local FBAShipment.status from Amazon's
 * authoritative state.
 *
 * Amazon supports two query types: SHIPMENT (filter by status list)
 * and DATE_RANGE (filter by lastUpdated window). We use SHIPMENT
 * because it's exactly what the polling cron needs ("give me every
 * non-terminal shipment").
 *
 * Pagination: getShipments returns NextToken when results overflow
 * one page. Caller passes the token back in to fetch the next page.
 * For polling tens of shipments at a time, single-page is usually
 * enough; the cron iterates if needed.
 */
export async function getInboundShipmentsBatch(args: {
  shipmentStatusList?: AmazonShipmentStatus[]
  shipmentIdList?: string[]
  lastUpdatedAfter?: string
  lastUpdatedBefore?: string
  nextToken?: string
}): Promise<GetShipmentsResult> {
  if (!isFbaInboundConfigured()) {
    throw new Error('SP-API not configured (set AMAZON_LWA_* + AMAZON_MARKETPLACE_ID)')
  }
  const marketplaceId = process.env.AMAZON_MARKETPLACE_ID!
  const token = await getLwaAccessToken()

  const qs = new URLSearchParams()
  qs.set('MarketplaceId', marketplaceId)

  if (args.nextToken) {
    qs.set('QueryType', 'NEXT_TOKEN')
    qs.set('NextToken', args.nextToken)
  } else if (args.shipmentIdList && args.shipmentIdList.length > 0) {
    qs.set('QueryType', 'SHIPMENT')
    qs.set('ShipmentIdList', args.shipmentIdList.join(','))
  } else {
    // HB.4 — discovery mode. SP-API requires ShipmentStatusList OR
    // ShipmentIdList for every query, including DATE_RANGE. When a
    // lastUpdatedAfter window is supplied, we pass BOTH so the filter
    // is "all status × this date window". Without ShipmentStatusList
    // the call returns 400 "At least one of ShipmentStatusList and
    // ShipmentIdList must be provided".
    const statuses = args.shipmentStatusList ?? [
      'WORKING', 'READY_TO_SHIP', 'SHIPPED', 'IN_TRANSIT',
      'DELIVERED', 'CHECKED_IN', 'RECEIVING', 'CLOSED',
      'CANCELLED', 'DELETED', 'ERROR',
    ]
    qs.set('ShipmentStatusList', statuses.join(','))
    if (args.lastUpdatedAfter) {
      qs.set('QueryType', 'DATE_RANGE')
      qs.set('LastUpdatedAfter', args.lastUpdatedAfter)
      if (args.lastUpdatedBefore) qs.set('LastUpdatedBefore', args.lastUpdatedBefore)
    } else {
      qs.set('QueryType', 'SHIPMENT')
    }
  }

  const url = `${REGION_ENDPOINTS[SP_REGION]}/fba/inbound/v0/shipments?${qs.toString()}`

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'x-amz-access-token': token,
      'Accept': 'application/json',
    },
  })

  const text = await res.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }

  if (!res.ok) {
    const errMsg = data?.errors?.[0]?.message ?? data?.message ?? text.slice(0, 300)
    logger.warn('fba-inbound: getShipments failed', { status: res.status, err: errMsg })
    throw new Error(`SP-API getShipments ${res.status}: ${errMsg}`)
  }

  const shipments = (data?.payload?.ShipmentData ?? []) as AmazonShipmentRow[]
  const nextToken: string | undefined = data?.payload?.NextToken
  return { shipments, nextToken }
}

/**
 * Map Amazon's ShipmentStatus to local enum values. Lossy by
 * design — local enum is intentionally smaller (5 values vs
 * Amazon's 11). Kept centralized so the cron + any future caller
 * agree on the mapping.
 */
export function mapAmazonShipmentStatusToLocal(
  amazon: AmazonShipmentStatus,
): 'WORKING' | 'SHIPPED' | 'IN_TRANSIT' | 'RECEIVING' | 'CLOSED' {
  switch (amazon) {
    case 'WORKING':
    case 'READY_TO_SHIP':
      return 'WORKING'
    case 'SHIPPED':
      return 'SHIPPED'
    case 'IN_TRANSIT':
    case 'DELIVERED':
      return 'IN_TRANSIT'
    case 'CHECKED_IN':
    case 'RECEIVING':
      return 'RECEIVING'
    case 'CLOSED':
    case 'CANCELLED':
    case 'DELETED':
    case 'ERROR':
      return 'CLOSED'
    default:
      return 'WORKING'
  }
}

// In-memory cache: full sellerSku→fnSku map, refreshed every 30 minutes.
let fnskuInventoryCache: { map: Record<string, string>; fetchedAt: number } | null = null
const FNSKU_CACHE_TTL_MS = 30 * 60_000

/**
 * Return the full FBA inventory sellerSku→fnSku map, fetching from Amazon
 * if the cache is stale. We fetch the entire inventory (no SKU filter) and
 * cache it — this is one API call that covers all enrolled SKUs.
 *
 * SKUs not enrolled in FBA simply won't appear in the map (caller treats
 * absent as null — user enters FNSKU manually).
 */
export async function getInventoryFnskus(sellerSkus: string[]): Promise<Record<string, string>> {
  if (!isFbaInboundConfigured()) {
    throw new Error('SP-API not configured (set AMAZON_LWA_* + AMAZON_MARKETPLACE_ID)')
  }
  if (sellerSkus.length === 0) return {}

  // Refresh cache if stale
  if (!fnskuInventoryCache || Date.now() - fnskuInventoryCache.fetchedAt > FNSKU_CACHE_TTL_MS) {
    const token = await getLwaAccessToken()
    const base = REGION_ENDPOINTS[SP_REGION] ?? REGION_ENDPOINTS.eu
    const marketplaceId = process.env.AMAZON_MARKETPLACE_ID!
    const allMap: Record<string, string> = {}

    let nextToken: string | undefined
    do {
      const url = new URL(`${base}/fba/inventory/v1/summaries`)
      url.searchParams.set('details', 'true')
      url.searchParams.set('granularityType', 'Marketplace')
      url.searchParams.set('granularityId', marketplaceId)
      url.searchParams.set('marketplaceIds', marketplaceId)
      if (nextToken) url.searchParams.set('nextToken', nextToken)

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}`, 'x-amz-access-token': token },
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`FBA Inventory API ${res.status}: ${text.slice(0, 300)}`)
      }
      const json = (await res.json()) as {
        payload?: {
          inventorySummaries: Array<{ sellerSku?: string; fnSku?: string }>
          nextToken?: string
        }
      }
      for (const item of json.payload?.inventorySummaries ?? []) {
        if (item.sellerSku && item.fnSku) allMap[item.sellerSku] = item.fnSku
      }
      nextToken = json.payload?.nextToken
    } while (nextToken)

    fnskuInventoryCache = { map: allMap, fetchedAt: Date.now() }
  }

  // Return only the entries matching the requested SKUs
  const result: Record<string, string> = {}
  for (const sku of sellerSkus) {
    if (fnskuInventoryCache.map[sku]) result[sku] = fnskuInventoryCache.map[sku]
  }
  return result
}

// ─── HB.4 — Historical FBA inbound shipment backfill ──────────────────

export interface FbaInboundBackfillResult {
  ranAt: string
  durationMs: number
  daysBack: number
  pages: number
  shipmentsFetched: number
  shipmentsUpserted: number
  shipmentsSkipped: number
  shipmentsFailed: number
  errors: string[]
}

/**
 * HB.4 — walk every historical FBA inbound shipment for the operator's
 * marketplace and upsert into FBAShipment. Uses SP-API getShipments
 * with QueryType=DATE_RANGE + LastUpdatedAfter so we get ALL shipments
 * (any status) updated in the window.
 *
 * Idempotent: upserts on FBAShipment.shipmentId (Amazon's id). Re-running
 * refreshes status + name + destinationFC.
 *
 * Status is mapped via mapAmazonShipmentStatusToLocal — lossy
 * (Amazon's 11 → local 5). Operationally fine for historical view.
 *
 * Note on items: getShipments returns shipment headers only. Per-item
 * detail (FBAShipmentItem) would require getShipmentItemsByShipmentId
 * per shipment, which is rate-limited (2 req/s). Items are NOT
 * populated here; can be a follow-up if needed.
 */
export async function backfillFbaInboundShipments(args: {
  daysBack?: number
} = {}): Promise<FbaInboundBackfillResult> {
  const t0 = Date.now()
  const daysBack = args.daysBack ?? 730
  const errors: string[] = []

  if (!isFbaInboundConfigured()) {
    throw new Error('SP-API FBA inbound not configured (set AMAZON_LWA_* + AMAZON_MARKETPLACE_ID)')
  }

  // Amazon getShipments DATE_RANGE has a hard 30-day max window per
  // request. Walk daysBack in 30-day chunks. Within each chunk,
  // paginate via NextToken until exhausted.
  const CHUNK_DAYS = 30
  let pages = 0
  let shipmentsFetched = 0
  let shipmentsUpserted = 0
  let shipmentsSkipped = 0
  let shipmentsFailed = 0

  const nowMs = Date.now()
  let chunkEndMs = nowMs
  let remaining = daysBack

  while (remaining > 0) {
    const span = Math.min(CHUNK_DAYS, remaining)
    const chunkStartMs = chunkEndMs - span * 24 * 60 * 60 * 1000
    const lastUpdatedAfter = new Date(chunkStartMs).toISOString()
    const lastUpdatedBefore = new Date(chunkEndMs).toISOString()

    let nextToken: string | undefined
    let chunkPages = 0
    const CHUNK_MAX_PAGES = 50

    while (chunkPages < CHUNK_MAX_PAGES) {
      let batch: AmazonShipmentRow[] = []
      try {
        const result = await getInboundShipmentsBatch(
          nextToken
            ? { nextToken }
            : { lastUpdatedAfter, lastUpdatedBefore },
        )
        batch = result.shipments
        nextToken = result.nextToken
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`[${lastUpdatedAfter.slice(0, 10)}..${lastUpdatedBefore.slice(0, 10)}] page ${chunkPages + 1}: ${msg.slice(0, 200)}`)
        logger.warn('fba-inbound: backfill chunk page failed', {
          chunk: `${lastUpdatedAfter}..${lastUpdatedBefore}`,
          page: chunkPages + 1,
          error: msg,
        })
        break
      }

      chunkPages++
      pages++
      shipmentsFetched += batch.length

      for (const row of batch) {
        try {
          const mappedStatus = mapAmazonShipmentStatusToLocal(row.ShipmentStatus)
          const existing = await prisma.fBAShipment.findUnique({
            where: { shipmentId: row.ShipmentId },
            select: { id: true },
          })
          if (existing) {
            await prisma.fBAShipment.update({
              where: { id: existing.id },
              data: {
                name: row.ShipmentName ?? null,
                status: mappedStatus,
                destinationFC: row.DestinationFulfillmentCenterId ?? 'UNKNOWN',
              },
            })
            shipmentsSkipped++
          } else {
            await prisma.fBAShipment.create({
              data: {
                shipmentId: row.ShipmentId,
                name: row.ShipmentName ?? null,
                status: mappedStatus,
                destinationFC: row.DestinationFulfillmentCenterId ?? 'UNKNOWN',
              },
            })
            shipmentsUpserted++
          }
        } catch (err) {
          shipmentsFailed++
          const msg = err instanceof Error ? err.message : String(err)
          errors.push(`${row.ShipmentId}: ${msg.slice(0, 200)}`)
        }
      }

      if (!nextToken) break
      // SP-API throttle: getShipments is 2 req/s sustained, burst 30.
      await new Promise((r) => setTimeout(r, 250))
    }

    // Move to next 30-day chunk back in time. Subtract 1ms to avoid
    // overlap on the chunk boundary.
    chunkEndMs = chunkStartMs - 1
    remaining -= span
  }

  const durationMs = Date.now() - t0
  logger.info('[fba-inbound] backfill complete', {
    daysBack, pages, shipmentsFetched, shipmentsUpserted, shipmentsSkipped, shipmentsFailed,
    errorCount: errors.length, durationMs,
  })

  return {
    ranAt: new Date().toISOString(),
    durationMs,
    daysBack,
    pages,
    shipmentsFetched,
    shipmentsUpserted,
    shipmentsSkipped,
    shipmentsFailed,
    errors: errors.slice(0, 20),
  }
}
