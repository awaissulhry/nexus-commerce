/**
 * Amazon SP-API Fulfillment Inbound v2024-03-20 — the client Send to FBA (Step 4) runs on. Every call names its Amazon
 * account (`accountId` = ChannelConnection.id) and goes through ONE transport: the channel gateway
 * (`amazonSellerFetch` → `gatewayFetch`: account state, rate bucket, call ledger), or the fake Amazon in tests and on
 * the private stack. Answers are typed from Amazon's model (`fulfillmentInbound_2024-03-20.json`); the recorded answers
 * live in `services/fba-inbound/__fixtures__/amazon-inbound-2024-03-20.json` (scripts/fba-inbound-fixtures.mjs).
 *
 * Fixed against the model (2026-10-07; the old F.1 client could not complete a plan):
 *   A. createInboundPlan sends `prepOwner` / `labelOwner` PER ITEM (ItemInput requires msku, quantity, prepOwner,
 *      labelOwner) and no top-level msku / prepOwner / labelOwner.
 *   B. createInboundPlan returns the `inboundPlanId` of Amazon's 202 answer (with the operationId) — the old client
 *      dropped it, so every plan was orphaned at Amazon.
 *   C. The missing calls: generatePackingOptions, listPackingGroupItems, setPackingInformation, generatePlacementOptions,
 *      getShipment, listShipmentItems, listShipmentBoxes, generateTransportationOptions, generate / list / confirm
 *      DeliveryWindowOptions, updateShipmentTrackingDetails, cancelInboundPlan, listInboundPlans.
 *   D. Labels: v2024-03-20 has no labels call; v0 getLabels (still live) with the shipmentConfirmationId (FBA15…).
 *   E. listTransportationOptions is `GET /inboundPlans/{id}/transportationOptions?placementOptionId=&shipmentId=`
 *      (the old path under /shipments/{id} does not exist); shippingMode is GROUND_SMALL_PARCEL, FREIGHT_LTL, ….
 *   Also: Amazon's money is `{ code, amount }` (the old types said currencyCode).
 *
 * Amazon writes switch: every POST / PUT needs `NEXUS_ENABLE_FBA_INBOUND_SEND=1` (default OFF) — checked here, the one
 * place, before the transport; off → `InboundWritesOff`, nothing is sent (the runner then HOLDS the plan). Reads (GET)
 * are unaffected. The fake (`NEXUS_FBA_INBOUND_FAKE=1`) is honoured only off production on a loopback `*test*`
 * database (`fakeAmazonGuard`); anywhere else the flag REFUSES every call instead of falling back to Amazon.
 */
import { logger } from '../utils/logger.js'
import { FBA_FAKE_ENV, FBA_WRITES_ENV } from '../services/fba-inbound/contract.js'

export const INBOUND_V2_BASE = '/inbound/fba/2024-03-20'
const V0_BASE = '/fba/inbound/v0'

/* ── the transport seam ──────────────────────────────────────────────────────────────────────── */

export interface InboundRequest {
  accountId: string
  method: 'GET' | 'POST' | 'PUT'
  /** Path with its query string. */
  path: string
  /** Stable ledger name, e.g. 'fbaInbound.createInboundPlan'. */
  operation: string
  body?: unknown
}
export interface InboundAnswer {
  status: number
  text: string
}
export interface InboundTransport {
  /** 'fake' = the fake Amazon (nothing leaves the process). */
  readonly kind: 'amazon' | 'fake'
  send(request: InboundRequest): Promise<InboundAnswer>
}

/** The channel gateway (hard rule 4): account state, rate bucket, call ledger. */
export const gatewayInboundTransport: InboundTransport = {
  kind: 'amazon',
  async send(request) {
    const { amazonSellerFetch } = await import('../services/gateway/amazon-sdk.js')
    try {
      const res = await amazonSellerFetch({
        accountId: request.accountId,
        method: request.method,
        path: request.path,
        operation: request.operation,
        body: request.body === undefined ? undefined : request.body,
        // A PUT of the same tracking numbers / a cancel is safe to repeat; a POST never is (the gateway's rule).
      })
      return { status: res.status, text: await res.text() }
    } catch (error) {
      // No answer at all (network / timeout): status 0, so the caller treats it as "maybe sent, look again later".
      if (error instanceof Error && error.name === 'GatewayNoAnswer') return { status: 0, text: error.message }
      throw error
    }
  },
}

let testTransport: InboundTransport | null = null
let fakeDecision: { allowed: boolean; reason: string } | null = null

/** Tests only: answer every call with this transport (null = back to the normal choice). */
export function setInboundTransportForTests(transport: InboundTransport | null): void {
  testTransport = transport
  fakeDecision = null
}

/** The flag asked for the fake but this process may not use it (production, or not a loopback `*test*` database). */
export class FakeAmazonRefused extends Error {
  readonly code = 'FAKE_AMAZON_REFUSED'
  constructor(reason: string) {
    super(`${FBA_FAKE_ENV}=1 is refused here, nothing was sent: ${reason}`)
    this.name = 'FakeAmazonRefused'
  }
}

/** The transport this process uses now: the test one, else the fake when asked and allowed, else the gateway. */
export async function inboundTransport(env: NodeJS.ProcessEnv = process.env): Promise<InboundTransport> {
  if (testTransport) return testTransport
  if (env[FBA_FAKE_ENV] !== '1') return gatewayInboundTransport
  const { fakeAmazonGuard, sharedFakeAmazon } = await import('../services/fba-inbound/fake-amazon.js')
  const verdict = fakeAmazonGuard(env)
  if (!fakeDecision) {
    fakeDecision = verdict
    if (verdict.allowed) logger.info(`[fba-inbound] ${FBA_FAKE_ENV}=1: the fake Amazon answers every FBA inbound call (${verdict.reason})`)
    else logger.error(`[fba-inbound] ${FBA_FAKE_ENV}=1 refused: ${verdict.reason}`)
  }
  if (!verdict.allowed) throw new FakeAmazonRefused(verdict.reason)
  return sharedFakeAmazon().transport
}

/** True when the fake Amazon answers this process's calls (the runner then skips reads of the real FBA inventory). */
export async function inboundFakeActive(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    return (await inboundTransport(env)).kind === 'fake'
  } catch {
    return false
  }
}

/* ── the writes switch ───────────────────────────────────────────────────────────────────────── */

export class InboundWritesOff extends Error {
  readonly code = 'WRITES_OFF'
  constructor(readonly operation: string) {
    super(`Amazon writes for FBA shipments are off on this server (${FBA_WRITES_ENV} is not 1): ${operation} was not sent`)
    this.name = 'InboundWritesOff'
  }
}
export function inboundWritesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[FBA_WRITES_ENV] === '1'
}
/** Throws `InboundWritesOff` when Amazon writes are off. The runner calls it before it records a write it will send. */
export function assertInboundWrites(operation: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!inboundWritesEnabled(env)) throw new InboundWritesOff(operation)
}

/* ── errors ──────────────────────────────────────────────────────────────────────────────────── */

export interface AmazonError {
  code: string
  message: string
  details: string | null
}
/** Amazon answered, but not with success. `status` 0 = no answer (network / timeout). */
export class AmazonInboundError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly errors: AmazonError[],
    readonly bodyPreview: string,
  ) {
    super(errors[0]?.message ? `${operation}: Amazon answered ${status} — ${errors[0].message}` : `${operation}: Amazon answered ${status}`)
    this.name = 'AmazonInboundError'
  }
  /** No answer, a 5xx: the same request may succeed later. */
  get transient(): boolean {
    return this.status === 0 || this.status >= 500
  }
  get throttled(): boolean {
    return this.status === 429
  }
}

function errorsOf(json: any): AmazonError[] {
  const list = Array.isArray(json?.errors) ? json.errors : []
  return list.map((e: any) => ({
    code: typeof e?.code === 'string' ? e.code : 'Unknown',
    message: typeof e?.message === 'string' ? e.message : String(e?.message ?? ''),
    details: typeof e?.details === 'string' && e.details ? e.details : null,
  }))
}

async function call<T>(accountId: string, method: InboundRequest['method'], path: string, name: string, okStatus: number, body?: unknown): Promise<T> {
  if (!accountId) throw new Error(`fba-inbound: ${name} needs the Amazon account it is for`)
  if (method !== 'GET') assertInboundWrites(name)
  const transport = await inboundTransport()
  const answer = await transport.send({ accountId, method, path, operation: `fbaInbound.${name}`, body })
  let json: any = null
  try {
    json = answer.text ? JSON.parse(answer.text) : null
  } catch {
    // non-JSON answer: kept as text in the error
  }
  if (answer.status !== okStatus) {
    logger.warn('fba-inbound: Amazon did not accept the call', { operation: name, method, status: answer.status, bodyPreview: answer.text.slice(0, 300) })
    throw new AmazonInboundError(name, answer.status, errorsOf(json), answer.text.slice(0, 500))
  }
  return json as T
}

const plan = (inboundPlanId: string) => `${INBOUND_V2_BASE}/inboundPlans/${encodeURIComponent(inboundPlanId)}`
const shipmentPath = (inboundPlanId: string, shipmentId: string) => `${plan(inboundPlanId)}/shipments/${encodeURIComponent(shipmentId)}`
function withQuery(path: string, query: Record<string, string | number | null | undefined>): string {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) if (value !== null && value !== undefined && value !== '') qs.set(key, String(value))
  const text = qs.toString()
  return text ? `${path}?${text}` : path
}

/* ── shared shapes (Amazon's model) ──────────────────────────────────────────────────────────── */

export type PrepOwner = 'AMAZON' | 'SELLER' | 'NONE'
export type LabelOwner = 'AMAZON' | 'SELLER' | 'NONE'
/** Amazon's Currency. */
export interface AmazonMoney { code: string; amount: number }
/** Amazon's Incentive (a fee or a discount). */
export interface AmazonIncentive { type?: string; target?: string; description?: string; value?: AmazonMoney }
export interface OperationResult { operationId: string }
export interface Page { nextToken: string | null }
const nextTokenOf = (json: any): string | null => (typeof json?.pagination?.nextToken === 'string' && json.pagination.nextToken ? json.pagination.nextToken : null)
function operationOf(json: any, name: string): OperationResult {
  if (typeof json?.operationId !== 'string' || !json.operationId) throw new AmazonInboundError(name, 202, [{ code: 'NoOperationId', message: 'Amazon answered without an operationId', details: null }], JSON.stringify(json ?? null).slice(0, 300))
  return { operationId: json.operationId }
}

/** Every page of a paged list (Amazon's `pagination.nextToken`), up to `maxPages`. */
export async function allPages<T>(page: (token: string | null) => Promise<{ items: T[]; nextToken: string | null }>, maxPages = 20): Promise<T[]> {
  const out: T[] = []
  let token: string | null = null
  for (let n = 0; n < maxPages; n++) {
    const result = await page(token)
    out.push(...result.items)
    if (!result.nextToken) break
    token = result.nextToken
  }
  return out
}

/* ── inbound plans ───────────────────────────────────────────────────────────────────────────── */

/** Amazon's AddressInput (required: name, addressLine1, city, postalCode, countryCode, phoneNumber). */
export interface AddressInput {
  name: string
  companyName?: string
  addressLine1: string
  addressLine2?: string
  city: string
  districtOrCounty?: string
  stateOrProvinceCode?: string
  postalCode: string
  countryCode: string
  phoneNumber: string
  email?: string
}
/** Amazon's ItemInput — prep and label owner are PER ITEM (bug A). */
export interface ItemInput {
  msku: string
  quantity: number
  prepOwner: PrepOwner
  labelOwner: LabelOwner
  expiration?: string
  manufacturingLotCode?: string
}
export interface CreateInboundPlanInput {
  /** ONE marketplace per plan, e.g. ['APJ6JRA9NG5V4'] (amazon.it). */
  destinationMarketplaces: string[]
  sourceAddress: AddressInput
  items: ItemInput[]
  name?: string
}

/** Drops empty optional strings: Amazon refuses an empty `addressLine2` (minLength 1). */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null && v !== '')) as T
}

/** POST /inboundPlans → 202 { inboundPlanId, operationId } (bug B: the plan id comes from THIS answer). */
export async function createInboundPlan(accountId: string, input: CreateInboundPlanInput): Promise<{ inboundPlanId: string; operationId: string }> {
  const body = compact({
    destinationMarketplaces: input.destinationMarketplaces,
    sourceAddress: compact(input.sourceAddress),
    items: input.items.map(item => compact({
      msku: item.msku, quantity: item.quantity, prepOwner: item.prepOwner, labelOwner: item.labelOwner,
      expiration: item.expiration, manufacturingLotCode: item.manufacturingLotCode,
    })),
    name: input.name,
  })
  const json = await call<any>(accountId, 'POST', `${INBOUND_V2_BASE}/inboundPlans`, 'createInboundPlan', 202, body)
  const { operationId } = operationOf(json, 'createInboundPlan')
  if (typeof json?.inboundPlanId !== 'string' || !json.inboundPlanId) {
    throw new AmazonInboundError('createInboundPlan', 202, [{ code: 'NoInboundPlanId', message: 'Amazon answered without an inboundPlanId', details: null }], JSON.stringify(json).slice(0, 300))
  }
  return { inboundPlanId: json.inboundPlanId, operationId }
}

export interface InboundPlanSummary {
  inboundPlanId: string
  name: string
  status: string
  createdAt: string
  lastUpdatedAt: string
  marketplaceIds: string[]
}
/** GET /inboundPlans — one page (Amazon allows pageSize ≤ 30). */
export async function listInboundPlans(accountId: string, query: {
  status?: 'ACTIVE' | 'VOIDED' | 'SHIPPED'; sortBy?: 'LAST_UPDATED_TIME' | 'CREATION_TIME'; sortOrder?: 'ASC' | 'DESC'
  pageSize?: number; paginationToken?: string | null
} = {}): Promise<{ inboundPlans: InboundPlanSummary[] } & Page> {
  const json = await call<any>(accountId, 'GET', withQuery(`${INBOUND_V2_BASE}/inboundPlans`, {
    status: query.status, sortBy: query.sortBy, sortOrder: query.sortOrder, pageSize: query.pageSize ?? 30, paginationToken: query.paginationToken,
  }), 'listInboundPlans', 200)
  return { inboundPlans: Array.isArray(json?.inboundPlans) ? json.inboundPlans : [], nextToken: nextTokenOf(json) }
}

/** PUT /inboundPlans/{id}/cancellation → operation (free unless a partnered carrier's void window passed). */
export async function cancelInboundPlan(accountId: string, inboundPlanId: string): Promise<OperationResult> {
  return operationOf(await call<any>(accountId, 'PUT', `${plan(inboundPlanId)}/cancellation`, 'cancelInboundPlan', 202), 'cancelInboundPlan')
}

/* ── operations ──────────────────────────────────────────────────────────────────────────────── */

export interface OperationProblem { code: string; message: string; severity: string; details?: string }
export interface InboundOperationStatus {
  operationId: string
  operation: string
  operationStatus: 'IN_PROGRESS' | 'SUCCESS' | 'FAILED'
  operationProblems: OperationProblem[]
}
/** GET /operations/{operationId}. */
export async function getInboundOperationStatus(accountId: string, operationId: string): Promise<InboundOperationStatus> {
  const json = await call<any>(accountId, 'GET', `${INBOUND_V2_BASE}/operations/${encodeURIComponent(operationId)}`, 'getInboundOperationStatus', 200)
  return {
    operationId: json?.operationId ?? operationId,
    operation: json?.operation ?? '',
    operationStatus: json?.operationStatus,
    operationProblems: Array.isArray(json?.operationProblems) ? json.operationProblems : [],
  }
}

/* ── packing ─────────────────────────────────────────────────────────────────────────────────── */

export interface PackingOption {
  packingOptionId: string
  /** OFFERED | ACCEPTED | EXPIRED */
  status: string
  packingGroups: string[]
  fees: AmazonIncentive[]
  discounts: AmazonIncentive[]
  expiration?: string
  supportedShippingConfigurations?: Array<{ shippingMode?: string; shippingSolution?: string }>
}
/** POST /inboundPlans/{id}/packingOptions → operation (no body). */
export async function generatePackingOptions(accountId: string, inboundPlanId: string): Promise<OperationResult> {
  return operationOf(await call<any>(accountId, 'POST', `${plan(inboundPlanId)}/packingOptions`, 'generatePackingOptions', 202), 'generatePackingOptions')
}
export async function listPackingOptions(accountId: string, inboundPlanId: string, paginationToken?: string | null): Promise<{ packingOptions: PackingOption[] } & Page> {
  const json = await call<any>(accountId, 'GET', withQuery(`${plan(inboundPlanId)}/packingOptions`, { pageSize: 20, paginationToken }), 'listPackingOptions', 200)
  return { packingOptions: Array.isArray(json?.packingOptions) ? json.packingOptions : [], nextToken: nextTokenOf(json) }
}
export interface PackingGroupItem { msku: string; quantity: number; asin?: string; fnsku?: string; labelOwner?: string; prepInstructions?: unknown[] }
export async function listPackingGroupItems(accountId: string, inboundPlanId: string, packingGroupId: string, paginationToken?: string | null): Promise<{ items: PackingGroupItem[] } & Page> {
  const json = await call<any>(accountId, 'GET', withQuery(`${plan(inboundPlanId)}/packingGroups/${encodeURIComponent(packingGroupId)}/items`, { pageSize: 100, paginationToken }), 'listPackingGroupItems', 200)
  return { items: Array.isArray(json?.items) ? json.items : [], nextToken: nextTokenOf(json) }
}
/** POST /inboundPlans/{id}/packingOptions/{packingOptionId}/confirmation → operation (not final: the plan can still be cancelled free). */
export async function confirmPackingOption(accountId: string, inboundPlanId: string, packingOptionId: string): Promise<OperationResult> {
  return operationOf(await call<any>(accountId, 'POST', `${plan(inboundPlanId)}/packingOptions/${encodeURIComponent(packingOptionId)}/confirmation`, 'confirmPackingOption', 202), 'confirmPackingOption')
}

export interface BoxInput {
  contentInformationSource: 'BOX_CONTENT_PROVIDED' | 'MANUAL_PROCESS' | 'BARCODE_2D'
  dimensions: { unitOfMeasurement: 'CM' | 'IN'; length: number; width: number; height: number }
  weight: { unit: 'KG' | 'LB'; value: number }
  /** Identical boxes (1..10,000). */
  quantity: number
  items?: ItemInput[]
}
export interface PackageGroupingInput { packingGroupId?: string; shipmentId?: string; boxes: BoxInput[] }
/** POST /inboundPlans/{id}/packingInformation { packageGroupings } → operation. Safe to send again. */
export async function setPackingInformation(accountId: string, inboundPlanId: string, input: { packageGroupings: PackageGroupingInput[] }): Promise<OperationResult> {
  return operationOf(await call<any>(accountId, 'POST', `${plan(inboundPlanId)}/packingInformation`, 'setPackingInformation', 202, { packageGroupings: input.packageGroupings }), 'setPackingInformation')
}

/* ── placement ───────────────────────────────────────────────────────────────────────────────── */

export interface PlacementOption {
  placementOptionId: string
  /** OFFERED | ACCEPTED | EXPIRED */
  status: string
  shipmentIds: string[]
  fees: AmazonIncentive[]
  discounts: AmazonIncentive[]
  expiration?: string
}
/** POST /inboundPlans/{id}/placementOptions {} → operation (no custom placement). */
export async function generatePlacementOptions(accountId: string, inboundPlanId: string): Promise<OperationResult> {
  return operationOf(await call<any>(accountId, 'POST', `${plan(inboundPlanId)}/placementOptions`, 'generatePlacementOptions', 202, {}), 'generatePlacementOptions')
}
export async function listPlacementOptions(accountId: string, inboundPlanId: string, paginationToken?: string | null): Promise<{ placementOptions: PlacementOption[] } & Page> {
  const json = await call<any>(accountId, 'GET', withQuery(`${plan(inboundPlanId)}/placementOptions`, { pageSize: 20, paginationToken }), 'listPlacementOptions', 200)
  return { placementOptions: Array.isArray(json?.placementOptions) ? json.placementOptions : [], nextToken: nextTokenOf(json) }
}
/** POST /inboundPlans/{id}/placementOptions/{placementOptionId}/confirmation → operation. FINAL at Amazon. */
export async function confirmPlacementOption(accountId: string, inboundPlanId: string, placementOptionId: string): Promise<OperationResult> {
  return operationOf(await call<any>(accountId, 'POST', `${plan(inboundPlanId)}/placementOptions/${encodeURIComponent(placementOptionId)}/confirmation`, 'confirmPlacementOption', 202), 'confirmPlacementOption')
}

/* ── shipments ───────────────────────────────────────────────────────────────────────────────── */

export interface AmazonShipment {
  shipmentId: string
  placementOptionId: string
  /** FBA15… — after the placement is confirmed. The id v0 getLabels / getShipments take. */
  shipmentConfirmationId?: string
  name?: string
  status?: string
  selectedTransportationOptionId?: string
  selectedDeliveryWindow?: { deliveryWindowOptionId?: string; startDate?: string; endDate?: string; availabilityType?: string; editableUntil?: string }
  destination?: { destinationType?: string; warehouseId?: string; address?: { city?: string; countryCode?: string } }
  source?: unknown
  trackingDetails?: unknown
}
/** GET /inboundPlans/{id}/shipments/{shipmentId}. */
export async function getShipment(accountId: string, inboundPlanId: string, shipmentId: string): Promise<AmazonShipment> {
  return call<AmazonShipment>(accountId, 'GET', shipmentPath(inboundPlanId, shipmentId), 'getShipment', 200)
}
export interface ShipmentItem { msku: string; quantity: number; fnsku?: string; asin?: string; labelOwner?: string }
export async function listShipmentItems(accountId: string, inboundPlanId: string, shipmentId: string, paginationToken?: string | null): Promise<{ items: ShipmentItem[] } & Page> {
  const json = await call<any>(accountId, 'GET', withQuery(`${shipmentPath(inboundPlanId, shipmentId)}/items`, { pageSize: 1000, paginationToken }), 'listShipmentItems', 200)
  return { items: Array.isArray(json?.items) ? json.items : [], nextToken: nextTokenOf(json) }
}
export interface ShipmentBox {
  packageId: string
  /** Amazon's box id (shipmentConfirmationId + U + index) — after the transport is confirmed. */
  boxId?: string
  quantity?: number
  dimensions?: { unitOfMeasurement?: string; length?: number; width?: number; height?: number }
  weight?: { unit?: string; value?: number }
  items?: Array<{ msku: string; quantity: number }>
  contentInformationSource?: string
}
export async function listShipmentBoxes(accountId: string, inboundPlanId: string, shipmentId: string, paginationToken?: string | null): Promise<{ boxes: ShipmentBox[] } & Page> {
  const json = await call<any>(accountId, 'GET', withQuery(`${shipmentPath(inboundPlanId, shipmentId)}/boxes`, { pageSize: 1000, paginationToken }), 'listShipmentBoxes', 200)
  return { boxes: Array.isArray(json?.boxes) ? json.boxes : [], nextToken: nextTokenOf(json) }
}

/* ── transportation ──────────────────────────────────────────────────────────────────────────── */

export interface ContactInformation { name: string; phoneNumber: string; email?: string }
export interface ShipmentTransportationConfiguration {
  shipmentId: string
  /** Amazon's WindowInput: the day the boxes are ready, e.g. '2026-10-08T00:00Z'. */
  readyToShipWindow: { start: string }
  contactInformation?: ContactInformation
}
/** POST /inboundPlans/{id}/transportationOptions { placementOptionId, shipmentTransportationConfigurations } → operation. */
export async function generateTransportationOptions(accountId: string, inboundPlanId: string, input: {
  placementOptionId: string; shipmentTransportationConfigurations: ShipmentTransportationConfiguration[]
}): Promise<OperationResult> {
  const body = {
    placementOptionId: input.placementOptionId,
    shipmentTransportationConfigurations: input.shipmentTransportationConfigurations.map(c => compact({
      shipmentId: c.shipmentId, readyToShipWindow: c.readyToShipWindow, contactInformation: c.contactInformation ? compact(c.contactInformation) : undefined,
    })),
  }
  return operationOf(await call<any>(accountId, 'POST', `${plan(inboundPlanId)}/transportationOptions`, 'generateTransportationOptions', 202, body), 'generateTransportationOptions')
}
export interface TransportationOption {
  transportationOptionId: string
  shipmentId: string
  carrier: { name?: string; alphaCode?: string }
  /** GROUND_SMALL_PARCEL | FREIGHT_LTL | FREIGHT_FTL_PALLET | FREIGHT_FTL_NONPALLET | OCEAN_LCL | OCEAN_FCL | AIR_SMALL_PARCEL | AIR_SMALL_PARCEL_EXPRESS (bug E) */
  shippingMode: string
  /** AMAZON_PARTNERED_CARRIER | USE_YOUR_OWN_CARRIER */
  shippingSolution: string
  preconditions: string[]
  quote?: { cost: AmazonMoney; expiration?: string; voidableUntil?: string }
}
/** GET /inboundPlans/{id}/transportationOptions?placementOptionId=&shipmentId= (bug E: the old path did not exist). */
export async function listTransportationOptions(accountId: string, inboundPlanId: string, query: {
  placementOptionId?: string | null; shipmentId?: string | null; paginationToken?: string | null
}): Promise<{ transportationOptions: TransportationOption[] } & Page> {
  const json = await call<any>(accountId, 'GET', withQuery(`${plan(inboundPlanId)}/transportationOptions`, {
    pageSize: 20, paginationToken: query.paginationToken, placementOptionId: query.placementOptionId, shipmentId: query.shipmentId,
  }), 'listTransportationOptions', 200)
  return { transportationOptions: Array.isArray(json?.transportationOptions) ? json.transportationOptions : [], nextToken: nextTokenOf(json) }
}
export interface TransportationSelection { shipmentId: string; transportationOptionId: string; contactInformation?: ContactInformation }
/** POST /inboundPlans/{id}/transportationOptions/confirmation { transportationSelections } → operation. */
export async function confirmTransportationOptions(accountId: string, inboundPlanId: string, selections: TransportationSelection[]): Promise<OperationResult> {
  const body = { transportationSelections: selections.map(s => compact({ ...s, contactInformation: s.contactInformation ? compact(s.contactInformation) : undefined })) }
  return operationOf(await call<any>(accountId, 'POST', `${plan(inboundPlanId)}/transportationOptions/confirmation`, 'confirmTransportationOptions', 202, body), 'confirmTransportationOptions')
}

/* ── delivery windows (own carrier) ──────────────────────────────────────────────────────────── */

export interface DeliveryWindowOption { deliveryWindowOptionId: string; startDate: string; endDate: string; availabilityType?: string; validUntil?: string }
/** POST /inboundPlans/{id}/shipments/{shipmentId}/deliveryWindowOptions → operation (no body). */
export async function generateDeliveryWindowOptions(accountId: string, inboundPlanId: string, shipmentId: string): Promise<OperationResult> {
  return operationOf(await call<any>(accountId, 'POST', `${shipmentPath(inboundPlanId, shipmentId)}/deliveryWindowOptions`, 'generateDeliveryWindowOptions', 202), 'generateDeliveryWindowOptions')
}
export async function listDeliveryWindowOptions(accountId: string, inboundPlanId: string, shipmentId: string, paginationToken?: string | null): Promise<{ deliveryWindowOptions: DeliveryWindowOption[] } & Page> {
  const json = await call<any>(accountId, 'GET', withQuery(`${shipmentPath(inboundPlanId, shipmentId)}/deliveryWindowOptions`, { pageSize: 100, paginationToken }), 'listDeliveryWindowOptions', 200)
  return { deliveryWindowOptions: Array.isArray(json?.deliveryWindowOptions) ? json.deliveryWindowOptions : [], nextToken: nextTokenOf(json) }
}
/** POST /inboundPlans/{id}/shipments/{shipmentId}/deliveryWindowOptions/{deliveryWindowOptionId}/confirmation → operation. */
export async function confirmDeliveryWindowOptions(accountId: string, inboundPlanId: string, shipmentId: string, deliveryWindowOptionId: string): Promise<OperationResult> {
  return operationOf(await call<any>(accountId, 'POST', `${shipmentPath(inboundPlanId, shipmentId)}/deliveryWindowOptions/${encodeURIComponent(deliveryWindowOptionId)}/confirmation`, 'confirmDeliveryWindowOptions', 202), 'confirmDeliveryWindowOptions')
}

/* ── tracking ────────────────────────────────────────────────────────────────────────────────── */

/** PUT /inboundPlans/{id}/shipments/{shipmentId}/trackingDetails — small parcel: one tracking id per box. Safe to send again. */
export async function updateShipmentTrackingDetails(accountId: string, inboundPlanId: string, shipmentId: string, boxes: Array<{ boxId: string; trackingId: string }>): Promise<OperationResult> {
  const body = { trackingDetails: { spdTrackingDetail: { spdTrackingItems: boxes.map(b => ({ boxId: b.boxId, trackingId: b.trackingId })) } } }
  return operationOf(await call<any>(accountId, 'PUT', `${shipmentPath(inboundPlanId, shipmentId)}/trackingDetails`, 'updateShipmentTrackingDetails', 202, body), 'updateShipmentTrackingDetails')
}

/* ── labels (v0 getLabels — bug D) ───────────────────────────────────────────────────────────── */

export type LabelPageType = 'PackageLabel_A4_2' | 'PackageLabel_A4_4' | 'PackageLabel_Letter_2' | 'PackageLabel_Letter_4' | 'PackageLabel_Letter_6'
  | 'PackageLabel_Letter_6_CarrierLeft' | 'PackageLabel_Plain_Paper' | 'PackageLabel_Plain_Paper_CarrierBottom' | 'PackageLabel_Thermal'
  | 'PackageLabel_Thermal_Unified' | 'PackageLabel_Thermal_NonPCP' | 'PackageLabel_Thermal_No_Carrier_Rotation'
export interface ShipmentLabelsInput {
  /** FBA15… — getShipment's shipmentConfirmationId, NOT the v2024 sh… id. */
  shipmentConfirmationId: string
  /** The boxes to print (listShipmentBoxes box ids); required with UNIQUE labels. */
  packageLabelsToPrint: string[]
  pageType?: LabelPageType
  labelType?: 'UNIQUE' | 'BARCODE_2D' | 'PALLET'
}
/** The account the fake answers for when a caller names none (it never reaches the gateway: see `shipmentLabelsFromFake`). */
const FAKE_LABELS_ACCOUNT = 'fake-amazon-account'

/**
 * Labels for a caller that names no account (v0 `getInboundShipmentLabels`: the Matrix drawer's "Labels" via
 * `labelsFor`, and the older labels route) while `NEXUS_FBA_INBOUND_FAKE=1`: the fake Amazon answers where the fake is
 * allowed (off production, loopback `*test*` database), and anywhere else the call is REFUSED (`FakeAmazonRefused`) —
 * never a fallback to Amazon. null when the flag is off: the caller sends its own gateway call as before.
 */
export async function shipmentLabelsFromFake(input: ShipmentLabelsInput): Promise<{ downloadUrl: string } | null> {
  if (process.env[FBA_FAKE_ENV] !== '1') return null
  // With the flag on, the transport is the fake or a refusal (`inboundTransport`), never the gateway.
  return getShipmentLabels(FAKE_LABELS_ACCOUNT, input)
}

/** GET /fba/inbound/v0/shipments/{shipmentConfirmationId}/labels → a fresh DownloadURL (it expires in minutes: never store it). */
export async function getShipmentLabels(accountId: string, input: ShipmentLabelsInput): Promise<{ downloadUrl: string }> {
  if (!input.shipmentConfirmationId) throw new Error('fba-inbound: getLabels needs the shipmentConfirmationId (FBA15…)')
  const path = withQuery(`${V0_BASE}/shipments/${encodeURIComponent(input.shipmentConfirmationId)}/labels`, {
    PageType: input.pageType ?? 'PackageLabel_A4_4',
    LabelType: input.labelType ?? 'UNIQUE',
    PackageLabelsToPrint: input.packageLabelsToPrint.join(','),
  })
  const json = await call<any>(accountId, 'GET', path, 'getLabels', 200)
  const downloadUrl = json?.payload?.DownloadURL
  if (typeof downloadUrl !== 'string' || !downloadUrl) {
    throw new AmazonInboundError('getLabels', 200, [{ code: 'NoDownloadURL', message: 'Amazon gave no label link', details: null }], JSON.stringify(json ?? null).slice(0, 300))
  }
  return { downloadUrl }
}
