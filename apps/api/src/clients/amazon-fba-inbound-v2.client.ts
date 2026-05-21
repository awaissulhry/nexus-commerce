/**
 * F.1 (TECH_DEBT #50) — SP-API FBA Inbound v2024-03-20 client wrappers.
 *
 * Amazon deprecated the v0 `putTransportDetails` endpoint (returns
 * HTTP 400 in production with "migrate to v2024-03-20"). The full
 * migration is multi-commit (state machine + DB schema + UI redesign);
 * this file is the additive first slice — wrapper functions for the
 * 9 v2024-03-20 endpoints, callable from a Node script or future
 * service. NO behaviour change to any existing code path.
 *
 * The v2024-03-20 flow is asynchronous — most state-changing endpoints
 * return an `operationId` that the caller polls until the operation
 * completes. F.3 will introduce the polling service that orchestrates
 * the multi-step flow; this file provides the raw HTTP wrappers.
 *
 * Reference: https://developer-docs.amazon.com/sp-api/docs/fulfillment-inbound-api-v2024-03-20-reference
 */

import { logger } from '../utils/logger.js'

// ── Region + auth (mirrors fba-inbound.service.ts) ───────────────────

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
    throw new Error(
      'SP-API not configured (AMAZON_LWA_CLIENT_ID / AMAZON_LWA_CLIENT_SECRET / AMAZON_REFRESH_TOKEN)',
    )
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

const V2_BASE = '/inbound/fba/2024-03-20'

async function spFetch(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any; text: string }> {
  const token = await getLwaAccessToken()
  const url = `${REGION_ENDPOINTS[SP_REGION]}${path}`
  const res = await fetch(url, {
    method,
    headers: {
      'x-amz-access-token': token,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body == null ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // non-JSON response (rare); keep raw text in the result
  }
  if (!res.ok) {
    logger.warn('fba-inbound-v2: request failed', {
      method,
      path,
      status: res.status,
      bodyPreview: text.slice(0, 300),
    })
  }
  return { status: res.status, json, text }
}

// ── 1. createInboundPlan ─────────────────────────────────────────────

export interface CreateInboundPlanInput {
  destinationMarketplaces: string[] // e.g. ['A1F83G8C2ARO7P'] for UK
  msku: string // merchant SKU
  prepOwner?: 'AMAZON' | 'SELLER'
  labelOwner?: 'AMAZON' | 'SELLER' | 'NONE'
  items: Array<{
    msku: string
    quantity: number
    expiration?: string
    prepInstructions?: Array<{ prepOwner?: string; prepType?: string }>
  }>
  sourceAddress: {
    name: string
    addressLine1: string
    addressLine2?: string
    city: string
    stateOrProvinceCode: string
    countryCode: string
    postalCode: string
    phoneNumber?: string
    email?: string
    companyName?: string
  }
  name?: string
}

export interface OperationResult {
  operationId: string
}

export async function createInboundPlan(
  input: CreateInboundPlanInput,
): Promise<OperationResult> {
  const r = await spFetch('POST', `${V2_BASE}/inboundPlans`, {
    destinationMarketplaces: input.destinationMarketplaces,
    msku: input.msku,
    prepOwner: input.prepOwner,
    labelOwner: input.labelOwner,
    items: input.items,
    sourceAddress: input.sourceAddress,
    name: input.name,
  })
  if (r.status !== 202) {
    throw new Error(`createInboundPlan ${r.status}: ${r.text.slice(0, 300)}`)
  }
  return { operationId: r.json.operationId }
}

// ── 2. getInboundOperation (status polling) ──────────────────────────

export interface GetOperationResult {
  operationId: string
  operationStatus: 'IN_PROGRESS' | 'SUCCESS' | 'FAILED'
  operationProblems: Array<{ code?: string; message?: string; severity?: string }>
}

export async function getInboundOperation(
  operationId: string,
): Promise<GetOperationResult> {
  const r = await spFetch('GET', `${V2_BASE}/operations/${encodeURIComponent(operationId)}`)
  if (r.status !== 200) {
    throw new Error(`getInboundOperation ${r.status}: ${r.text.slice(0, 300)}`)
  }
  return r.json
}

// ── 3. listPackingOptions ────────────────────────────────────────────

/** SP-API packing-option fee. Type is a coarse category; description is
 *  optional human-readable text Amazon may supply (often empty). */
export interface PackingOptionFee {
  /** e.g. 'FBA_INBOUND_TRANSPORT', 'FBA_PREP' */
  type?: string
  value?: { amount: number; currencyCode: string }
  description?: string
  target?: string
}

export interface PackingOption {
  packingOptionId: string
  /** 'OFFERED' | 'EXPIRED' | 'ACCEPTED' (string for forward-compat). */
  status: string
  expiration?: string
  /** F.6.2 — packing-group ids included in this option (SP-API supplies
   *  them as a flat string[]). Each id can be drilled into via
   *  GET /inboundPlans/{planId}/packingGroups/{packingGroupId}/items
   *  for per-item composition; we surface the count + ids here. */
  packingGroups?: string[]
  /** F.6.2 — feature flags like 'INDIVIDUAL_BARCODE_REQUIRED',
   *  'SHIP_FROM_ONE_LOCATION'. Forward-compat string[]. */
  packingFeatures?: string[]
  /** F.6.2 — array of fees (typically prep + inbound transport). The
   *  operator picks based on the sum here vs the placement/transport
   *  fees that come later. */
  fees?: PackingOptionFee[]
}

export async function listPackingOptions(
  planId: string,
): Promise<{ packingOptions: PackingOption[]; nextToken?: string }> {
  const r = await spFetch('GET', `${V2_BASE}/inboundPlans/${encodeURIComponent(planId)}/packingOptions`)
  if (r.status !== 200) {
    throw new Error(`listPackingOptions ${r.status}: ${r.text.slice(0, 300)}`)
  }
  return r.json
}

// ── 4. confirmPackingOption ──────────────────────────────────────────

export async function confirmPackingOption(
  planId: string,
  packingOptionId: string,
): Promise<OperationResult> {
  const r = await spFetch(
    'POST',
    `${V2_BASE}/inboundPlans/${encodeURIComponent(planId)}/packingOptions/${encodeURIComponent(packingOptionId)}/confirmation`,
  )
  if (r.status !== 202) {
    throw new Error(`confirmPackingOption ${r.status}: ${r.text.slice(0, 300)}`)
  }
  return { operationId: r.json.operationId }
}

// ── 5. listPlacementOptions ──────────────────────────────────────────

export interface PlacementOption {
  placementOptionId: string
  status: string
  shipmentIds?: string[]
  fees?: Array<{ value?: { amount: number; currencyCode: string }; type?: string }>
}

export async function listPlacementOptions(
  planId: string,
): Promise<{ placementOptions: PlacementOption[]; nextToken?: string }> {
  const r = await spFetch('GET', `${V2_BASE}/inboundPlans/${encodeURIComponent(planId)}/placementOptions`)
  if (r.status !== 200) {
    throw new Error(`listPlacementOptions ${r.status}: ${r.text.slice(0, 300)}`)
  }
  return r.json
}

// ── 6. confirmPlacementOption ────────────────────────────────────────

export async function confirmPlacementOption(
  planId: string,
  placementOptionId: string,
): Promise<OperationResult> {
  const r = await spFetch(
    'POST',
    `${V2_BASE}/inboundPlans/${encodeURIComponent(planId)}/placementOptions/${encodeURIComponent(placementOptionId)}/confirmation`,
  )
  if (r.status !== 202) {
    throw new Error(`confirmPlacementOption ${r.status}: ${r.text.slice(0, 300)}`)
  }
  return { operationId: r.json.operationId }
}

// ── 7. listTransportationOptions ─────────────────────────────────────

export interface TransportationOption {
  transportationOptionId: string
  carrier: { alphaCode?: string; name?: string }
  shippingMode?: 'SMALL_PARCEL' | 'LTL' | 'PARTNERED_LTL' | 'PARTNERED_SMALL_PARCEL'
  shippingSolution?: string
  preconditions?: string[]
  quote?: { cost: { amount: number; currencyCode: string }; expiration?: string }
}

export async function listTransportationOptions(
  planId: string,
  shipmentId: string,
): Promise<{ transportationOptions: TransportationOption[]; nextToken?: string }> {
  const r = await spFetch(
    'GET',
    `${V2_BASE}/inboundPlans/${encodeURIComponent(planId)}/shipments/${encodeURIComponent(shipmentId)}/transportationOptions`,
  )
  if (r.status !== 200) {
    throw new Error(`listTransportationOptions ${r.status}: ${r.text.slice(0, 300)}`)
  }
  return r.json
}

// ── 8. confirmTransportationOptions ──────────────────────────────────

export interface TransportationConfirmation {
  shipmentId: string
  transportationOptionId: string
  contactInformation?: { name: string; email: string; phoneNumber: string }
}

export async function confirmTransportationOptions(
  planId: string,
  confirmations: TransportationConfirmation[],
): Promise<OperationResult> {
  const r = await spFetch(
    'POST',
    `${V2_BASE}/inboundPlans/${encodeURIComponent(planId)}/transportationOptions/confirmation`,
    { transportationSelections: confirmations },
  )
  if (r.status !== 202) {
    throw new Error(`confirmTransportationOptions ${r.status}: ${r.text.slice(0, 300)}`)
  }
  return { operationId: r.json.operationId }
}

// ── 9. getShipmentLabels ─────────────────────────────────────────────

export interface ShipmentLabelsInput {
  pageType?: 'PackageLabel_Letter_2' | 'PackageLabel_Letter_4' | 'PackageLabel_Letter_6' | 'PackageLabel_Letter_6_CarrierLeft' | 'PackageLabel_A4_2' | 'PackageLabel_A4_4'
  pageSize?: 'Letter' | 'A4'
  format?: 'PDF' | 'PNG' | 'ZPL'
  labelType?: 'BARCODE_2D' | 'UNIQUE' | 'PALLET'
}

export async function getShipmentLabels(
  planId: string,
  shipmentId: string,
  args?: ShipmentLabelsInput,
): Promise<{ documentDownloads: Array<{ source: string; downloadType: string; expiration?: string }> }> {
  const qs = new URLSearchParams()
  if (args?.pageType) qs.set('PageType', args.pageType)
  if (args?.pageSize) qs.set('PageSize', args.pageSize)
  if (args?.format) qs.set('Format', args.format)
  if (args?.labelType) qs.set('LabelType', args.labelType)
  const path = `${V2_BASE}/inboundPlans/${encodeURIComponent(planId)}/shipments/${encodeURIComponent(shipmentId)}/labels${
    qs.toString() ? `?${qs.toString()}` : ''
  }`
  const r = await spFetch('GET', path)
  if (r.status !== 200) {
    throw new Error(`getShipmentLabels ${r.status}: ${r.text.slice(0, 300)}`)
  }
  return r.json
}
