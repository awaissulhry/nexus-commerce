/**
 * Send to FBA (Step 4, Owner 2026-10-07) — ONE vocabulary, ONE set of wire shapes and ONE box rule for the API (send /
 * read / ship services, the runner, the routes, Claude's tools) and the web (the Matrix "Send to FBA…" dialog and the
 * FBA plans drawer), so a screen cannot promise a box, a count or a refusal the server would not keep.
 * Pure: no I/O, no clock — a `today` / `now` is passed in.
 *
 * Owner decisions (final, 2026-10-07):
 *  - Whole sealed cases go as identical case boxes, one kind per case size (a SKU may have several, Owner 2026-10-08);
 *    loose units go in MIXED boxes, first-fit within 23 kg (incl. the empty box) and 63.5 cm a side. A mixed box over
 *    those limits is never built; a case pack over them is a warning.
 *  - Units are HELD at the From warehouse at "Create plan" (StockReservation reason FBA_SEND) and released on cancel.
 *  - Confirming the placement (final at Amazon) is ONE person's click that shows Amazon's fees.
 *  - Prep / label owner is asked once in the dialog when "not set" and remembered for those SKUs.
 *
 * DRAFT (Owner 2026-10-08): the Matrix "Send to FBA" and Claude's tool fill ONE open draft per From + To; it lives only in
 * Nexus (no Amazon call, no hold) until a person clicks "Send to Amazon" on the FBA shipments page (Outbound). A draft
 * row always has a `source` (old wizard rows that default to 'DRAFT' have none, and every reader filters on it).
 *
 * The plan's states: DRAFT → QUEUED → CREATING → PACKING → BOXES → PLACING → QUOTING → WAITING_FOR_CHOICE (a person) →
 * CONFIRMING → LABELS → READY_TO_SHIP (a person packs, prints, marks each shipment Shipped) → SHIPPED → AT_AMAZON →
 * CLOSED. Side states: FAILED (a step failed; "Try again" re-runs it), HELD (writes switched off / sign-in / rate wait —
 * resumes by itself), CANCELLING → CANCELLED.
 */
import { AMAZON_EU_BOX, CASE_COPY, isCaseOwner, type CaseCount, type CaseOwner } from './stock-cases.js'

/* ── states and steps ─────────────────────────────────────────────────────────────────────────── */

export const FBA_PLAN_STATUSES = [
  'DRAFT', 'QUEUED', 'CREATING', 'PACKING', 'BOXES', 'PLACING', 'QUOTING', 'WAITING_FOR_CHOICE', 'CONFIRMING', 'LABELS',
  'READY_TO_SHIP', 'SHIPPED', 'AT_AMAZON', 'CLOSED', 'FAILED', 'HELD', 'CANCELLING', 'CANCELLED',
] as const
export type FbaPlanStatus = (typeof FBA_PLAN_STATUSES)[number]

/** The job moves these by itself (no person needed). */
export const FBA_JOB_STATUSES = [
  'QUEUED', 'CREATING', 'PACKING', 'BOXES', 'PLACING', 'QUOTING', 'CONFIRMING', 'LABELS', 'HELD', 'CANCELLING',
] as const satisfies readonly FbaPlanStatus[]
/** A person acts next: send the draft, pick the option, pack and mark Shipped, or "Try again" / "Cancel plan". */
export const FBA_PERSON_STATUSES = ['DRAFT', 'WAITING_FOR_CHOICE', 'READY_TO_SHIP', 'FAILED'] as const satisfies readonly FbaPlanStatus[]
/** Amazon moves these (the existing 15-min status poll, `jobs/fba-status-poll.job.ts`). */
export const FBA_AMAZON_STATUSES = ['SHIPPED', 'AT_AMAZON'] as const satisfies readonly FbaPlanStatus[]
/** Final: nothing moves any more and no hold remains. */
export const FBA_CLOSED_STATUSES = ['CLOSED', 'CANCELLED'] as const satisfies readonly FbaPlanStatus[]
/**
 * What the runner may claim (`updateMany where status in …`): the job's states, plus READY_TO_SHIP / SHIPPED for the
 * TRACKING step only (a shipment marked Shipped whose tracking has not reached Amazon yet; the plan's status does not
 * change while it runs).
 */
export const FBA_CLAIMABLE_STATUSES = [...FBA_JOB_STATUSES, 'READY_TO_SHIP', 'SHIPPED'] as const satisfies readonly FbaPlanStatus[]
/** A plan can be cancelled in these — and only while none of its shipments is marked Shipped (`fbaPlanCan`). */
export const FBA_CANCELLABLE_STATUSES = [
  'QUEUED', 'CREATING', 'PACKING', 'BOXES', 'PLACING', 'QUOTING', 'WAITING_FOR_CHOICE', 'CONFIRMING', 'LABELS',
  'READY_TO_SHIP', 'FAILED', 'HELD',
] as const satisfies readonly FbaPlanStatus[]

/**
 * The job's steps (`FbaInboundPlanV2.currentStep`). It names the step running, or the one the job runs next; in FAILED
 * / HELD the step that failed / waits ("Try again" re-runs it); in WAITING_FOR_CHOICE 'CONFIRM'; in READY_TO_SHIP
 * 'TRACKING'. TRACKING and CANCEL can follow any step.
 */
export const FBA_PLAN_STEPS = ['CREATE', 'PACK', 'BOXES', 'PLACE', 'QUOTE', 'CONFIRM', 'LABELS', 'TRACKING', 'CANCEL'] as const
export type FbaPlanStep = (typeof FBA_PLAN_STEPS)[number]
/** The status a plan shows while the job runs a step. TRACKING runs without changing the status. */
export const FBA_STEP_STATUS: Readonly<Record<Exclude<FbaPlanStep, 'TRACKING'>, FbaPlanStatus>> = {
  CREATE: 'CREATING', PACK: 'PACKING', BOXES: 'BOXES', PLACE: 'PLACING', QUOTE: 'QUOTING', CONFIRM: 'CONFIRMING',
  LABELS: 'LABELS', CANCEL: 'CANCELLING',
}

/** Amazon v2024-03-20 operations that answer with an `operationId` (the ones the step log records and resumes). */
export const FBA_AMAZON_OPERATIONS = [
  'createInboundPlan', 'generatePackingOptions', 'confirmPackingOption', 'setPackingInformation',
  'generatePlacementOptions', 'generateTransportationOptions', 'generateDeliveryWindowOptions',
  'confirmPlacementOption', 'confirmDeliveryWindowOptions', 'confirmTransportationOptions',
  'updateShipmentTrackingDetails', 'cancelInboundPlan',
] as const
export type FbaAmazonOperation = (typeof FBA_AMAZON_OPERATIONS)[number]

export function isFbaPlanStatus(value: unknown): value is FbaPlanStatus {
  return typeof value === 'string' && (FBA_PLAN_STATUSES as readonly string[]).includes(value)
}
export function isFbaPlanStep(value: unknown): value is FbaPlanStep {
  return typeof value === 'string' && (FBA_PLAN_STEPS as readonly string[]).includes(value)
}
/** Open = not CLOSED / CANCELLED: the drawer and the page's Drafts / In progress tabs show it. */
export function isFbaPlanOpen(status: string): boolean {
  return isFbaPlanStatus(status) && !(FBA_CLOSED_STATUSES as readonly string[]).includes(status)
}
/** Under way = open and sent (not a DRAFT): its unshipped units count as "planned", its holds stand. */
export function isFbaPlanUnderWay(status: string): boolean {
  return isFbaPlanOpen(status) && status !== 'DRAFT'
}

/**
 * The Matrix FBA cell's "+N" (Owner 2026-10-07): the bigger of Amazon's inbound count (`units`) and the units Nexus
 * marked Shipped in plans Amazon has not started receiving (`sent`, `MatrixFbaInbound.sent`); 0 when there is no row.
 * The bigger, never the sum: once Amazon's read includes a shipment, its units are already in `units`, and adding
 * `sent` would count them twice. So "+N" shows right after "Mark shipped" and never doubles when Amazon catches up.
 * (The shape is `Pick<MatrixFbaInbound, 'units' | 'sent'>`, written out so this file needs no import of the contract.)
 */
export function fbaInboundShown(i: { units: number; sent?: number } | null | undefined): number {
  if (!i) return 0
  return Math.max(i.units, i.sent ?? 0)
}

/* ── limits and defaults ──────────────────────────────────────────────────────────────────────── */

/** The most SKUs one plan takes (the Matrix's selection cap; Amazon allows more). */
export const FBA_SEND_MAX_SKUS = 200
/** The most units of one SKU in one plan. */
export const FBA_SEND_MAX_UNITS_PER_SKU = 10_000
/** The hold made at "Create plan" (StockReservation): reason, kind and lifetime. */
export const FBA_SEND_HOLD = { reason: 'FBA_SEND', kind: 'HARD', days: 45 } as const
/** One plan line's `productIds` in `fba.plan_changed` — the event caps the list at this. */
export const FBA_EVENT_MAX_PRODUCTS = 200

/** The box loose units go in. Sizes in cm, weights in kg; `maxKg` ≤ 23 (Amazon EU), every side ≤ 63.5 cm. */
export interface FbaMixedBox {
  lengthCm: number
  widthCm: number
  heightCm: number
  /** The empty box itself; it counts toward `maxKg`. */
  emptyKg: number
  /** The heaviest a full box may be (Amazon EU: 23 kg). */
  maxKg: number
}
/** Owner Q1: one box size per plan, 60 × 40 × 40 cm by default (a double-wall carton of that size weighs about 1.2 kg). */
export const MIXED_BOX_DEFAULT: Readonly<FbaMixedBox> = { lengthCm: 60, widthCm: 40, heightCm: 40, emptyKg: 1.2, maxKg: AMAZON_EU_BOX.maxKg }
/** Units fill at most this share of a mixed box's volume (the rest is the gaps between them). */
export const MIXED_BOX_FILL = 0.85

/* ── wire shapes: the dialog (GET /api/fba/inbound/send-draft, POST /api/fba/inbound/plans) ──────── */

/** Amazon's AddressInput (required: name, addressLine1, city, postalCode, countryCode, phoneNumber). */
export interface FbaSourceAddress {
  name: string
  companyName?: string | null
  addressLine1: string
  addressLine2?: string | null
  city: string
  stateOrProvinceCode?: string | null
  postalCode: string
  countryCode: string
  phoneNumber: string
  email?: string | null
}
export const FBA_ADDRESS_FIELDS = ['name', 'addressLine1', 'city', 'postalCode', 'countryCode', 'phoneNumber'] as const
export type FbaAddressField = (typeof FBA_ADDRESS_FIELDS)[number]
/** The ship-from check: `missing` empty = Amazon's required fields are all there. `summary` is one line to show. */
export interface FbaAddressCheck {
  missing: FbaAddressField[]
  summary: string | null
}

export interface FbaSendLocation {
  /** StockLocation.id */
  id: string
  /** StockLocation.code — what the wire names (`from`). */
  code: string
  name: string
  town: string | null
  country: string | null
  isDefault: boolean
}
export interface FbaSendMarket {
  /** 'IT', 'DE', … */
  code: string
  marketplaceId: string
  name: string
  /** The Amazon account (ChannelConnection.id) that sells there. */
  accountId: string
}

/** One case size of a SKU as the box rule needs it (`ProductCaseSize`). */
export interface FbaCaseSize {
  unitsPerCase: number
  /** The case's size and weight, when all four are set; null = not all set. */
  case: { lengthCm: number; widthCm: number; heightCm: number; weightKg: number } | null
}

/** What the box rule needs to know about one SKU. Sizes in cm, weights in kg; null = unknown. */
export interface FbaBoxSku {
  productId: string
  /** The Nexus SKU. */
  sku: string
  /** The Amazon seller SKU in the plan's market; null = no Amazon listing there. */
  msku: string | null
  /** The SKU's case sizes, biggest first; [] = no case size. */
  caseSizes: FbaCaseSize[]
  /** One unit's weight (`Product.weightValue` in kg, see `unitWeightKg`). */
  unitWeightKg: number | null
  /** One unit's size (`Product.dim*` in cm, see `lengthCm`). */
  unit: { lengthCm: number; widthCm: number; heightCm: number } | null
}

/** One SKU in the dialog (a parent is never sent: the draft expands it to its variations). */
export interface FbaSendSku extends FbaBoxSku {
  name: string
  /** Units on hand at From (StockLevel.quantity). */
  onHand: number
  /** Units free at From (StockLevel.available: on hand − holds). */
  free: number
  /** `caseSplit` at From: sealed cases free to send per case size (biggest first), and loose units free. */
  freeSealed: CaseCount[]
  freeLoose: number
  /** `ProductPackage` owners; null = "not set" (the dialog asks once, Nexus remembers). */
  prepOwner: CaseOwner | null
  labelOwner: CaseOwner | null
  /** Units of this SKU already in open Nexus plans, not shipped yet. */
  openPlanUnits: number
}

/** GET /api/fba/inbound/send-draft?productIds=a,b&from=IT-MAIN&market=IT → this. */
export interface FbaSendDraft {
  /** The From warehouse (default: the business's default warehouse); null = the asked `from` is not an active warehouse. */
  from: FbaSendLocation | null
  /** Active WAREHOUSE locations (the From Select). */
  locations: FbaSendLocation[]
  /** The market chosen (default: the From country's market, else IT). */
  market: string
  /** Amazon markets with an account (the To Select). */
  markets: FbaSendMarket[]
  /** Default ready day (YYYY-MM-DD): the next working day. */
  readyToShipOn: string
  /** The server's day (YYYY-MM-DD, Europe/Rome) the checks use. */
  today: string
  /** The From warehouse's address + the company's name and phone. */
  address: FbaAddressCheck
  /** MIXED_BOX_DEFAULT unless the business set another. */
  mixedBox: FbaMixedBox
  skus: FbaSendSku[]
  /** The open DRAFT for this From + To (`planId`), or null. With `?planId=` the draft's own From, To, day and box. */
  draftId: string | null
  /** That draft's lines for these SKUs (the dialog starts from them); [] when none. */
  lines: FbaSendLine[]
}

/** One SKU the person sends: sealed cases per case size (identical case boxes per size) and loose units (mixed boxes). */
export interface FbaSendLine {
  productId: string
  /** Whole sealed cases per case size; sizes with 0 may be left out. */
  cases: CaseCount[]
  looseUnits: number
}
/** Prep / label owner the dialog asked for the SKUs that had none ("Saved for these SKUs"). */
export interface FbaSendOwners {
  prepOwner: CaseOwner
  labelOwner: CaseOwner
}

/** POST /api/fba/inbound/plans (Idempotency-Key) → 202 FbaCreateAnswer. */
export interface FbaCreateRequest {
  /** StockLocation.code of an active WAREHOUSE. */
  from: string
  /** Market code ('IT'). */
  market: string
  /** YYYY-MM-DD, today or later. */
  readyToShipOn: string
  /** 1..FBA_SEND_MAX_SKUS lines with units; lines with 0 units are dropped. */
  lines: FbaSendLine[]
  /** null / absent = the draft's box (MIXED_BOX_DEFAULT). */
  mixedBox?: FbaMixedBox | null
  /** Required when a SKU with units has prep or labels "not set"; saved for those SKUs only. */
  owners?: FbaSendOwners | null
}
export interface FbaCreateAnswer {
  planId: string
}

/**
 * POST /api/fba/inbound/drafts — "Add to draft" (the Matrix dialog, Claude's tool): these lines go into the ONE open
 * draft for this From + To (made when none). A SKU already in it takes the new numbers; a line with 0 units takes the SKU
 * out. No Amazon call, no hold. → 200 FbaCreateAnswer (the draft's planId).
 */
export interface FbaDraftAddRequest {
  from: string
  market: string
  lines: FbaSendLine[]
  readyToShipOn?: string | null
  mixedBox?: FbaMixedBox | null
  owners?: FbaSendOwners | null
}
/**
 * PATCH /api/fba/inbound/plans/:id — edit a DRAFT on the page. Each field absent = keep. `lines` replaces every line
 * (0-unit lines dropped). A From + To that already has another open draft → 409 DRAFT_EXISTS. → 200 FbaPlanView.
 */
export interface FbaDraftUpdateRequest {
  from?: string
  market?: string
  readyToShipOn?: string
  mixedBox?: FbaMixedBox | null
  lines?: FbaSendLine[]
  owners?: FbaSendOwners | null
}
/**
 * POST /api/fba/inbound/plans/:id/send (Idempotency-Key) — "Send to Amazon": today's Create plan on the draft's lines
 * (the checks, the holds, the Amazon SKU and owners read again, QUEUED, the job). A second send of the same draft
 * answers the same planId. DELETE /api/fba/inbound/plans/:id deletes a DRAFT (nothing at Amazon, no hold).
 */
export interface FbaDraftSendRequest {
  readyToShipOn?: string
  mixedBox?: FbaMixedBox | null
  owners?: FbaSendOwners | null
}
/** The FBA shipments page's tabs: DRAFT · open and sent · CLOSED / CANCELLED. */
export const FBA_PLAN_VIEWS = ['drafts', 'active', 'done'] as const
export type FbaPlanListView = (typeof FBA_PLAN_VIEWS)[number]
/** Which tab a status belongs to. */
export function fbaPlanViewOf(status: string): FbaPlanListView {
  if (status === 'DRAFT') return 'drafts'
  return isFbaPlanOpen(status) ? 'active' : 'done'
}
/**
 * GET /api/fba/inbound/plans?view=drafts|active|done&productId=&cursor=&limit= (newest first; `open=1` = drafts + active,
 * the Matrix drawer) → this. `next` = the cursor of the next page, null at the end. `counts` = every tab's count.
 */
export interface FbaPlanListAnswer {
  plans: FbaPlanView[]
  next: string | null
  counts: Record<FbaPlanListView, number>
}

/** POST /api/fba/inbound/plans/:id/choice — the Owner's pick (stored as `plan.choice`). */
export interface FbaChoiceRequest {
  placementOptionId: string
  /** One per shipment of that placement option. */
  shipments: Array<{
    shipmentId: string
    transportationOptionId: string
    /** Own carrier: the delivery window; null for an Amazon-partnered carrier. */
    deliveryWindowOptionId: string | null
  }>
}

/** POST /api/fba/inbound/shipments/:id/shipped (`:id` = FBAShipment.id) — one tracking number per box. */
export interface FbaShippedRequest {
  tracking: Array<{ boxId: string; trackingId: string }>
}
/** GET /api/fba/inbound/shipments/:id/labels → a fresh link (never stored: it expires in minutes). */
export interface FbaLabelsAnswer {
  downloadUrl: string
}

/* ── problems ─────────────────────────────────────────────────────────────────────────────────── */

export type FbaSendProblemCode =
  | 'NOT_A_WAREHOUSE' | 'NO_ACCOUNT' | 'NO_ADDRESS' | 'READY_DATE' | 'BOX_OVER_LIMIT'
  | 'UNKNOWN_SKU' | 'INVALID_QUANTITY' | 'OVER_FREE' | 'OVER_FREE_CASES' | 'NO_LISTING' | 'NO_OWNERS'
  | 'NO_CASE_SIZE' | 'NO_CASE_DIMENSIONS' | 'CASE_OVER_LIMIT' | 'NO_UNIT_WEIGHT' | 'NO_UNIT_SIZE' | 'UNIT_TOO_BIG'
  | 'IN_OPEN_PLAN' | 'NOT_IN_GROUP' | 'NO_UNITS' | 'TOO_MANY_SKUS'
export interface FbaSendProblem {
  code: FbaSendProblemCode
  /** The operator's sentence (starts with the SKU when it is about one). */
  message: string
  /** The SKU it is about; null = the whole plan. */
  productId: string | null
  /** true = holds the Create button (and the server refuses); false = a warning. */
  blocking: boolean
}

/** Amazon's OperationProblem, shown verbatim. */
export interface FbaAmazonProblem {
  code: string
  message: string
  severity: string | null
  details: string | null
}

/* ── boxes ────────────────────────────────────────────────────────────────────────────────────── */

/** `quantity` identical boxes (Amazon's box `quantity`, 1..10,000) with this content each. */
export interface FbaBoxPlan {
  kind: 'case' | 'mixed'
  /** Amazon's packing group (the runner passes `groups`); null in the dialog. */
  packingGroupId: string | null
  quantity: number
  lengthCm: number
  widthCm: number
  heightCm: number
  /** One box: the case's weight, or the empty mixed box + its units. Never over 23 kg for a mixed box. */
  weightKg: number
  /** One box's content. */
  items: Array<{ productId: string; msku: string; quantity: number }>
}
export interface FbaBoxResult {
  boxes: FbaBoxPlan[]
  /** Box refusals (blocking) and warnings. */
  problems: FbaSendProblem[]
  /** Σ quantity. */
  boxCount: number
  caseBoxes: number
  mixedBoxes: number
  /** Σ quantity × weightKg, 2 decimals. */
  weightKg: number
  /** Units boxed. */
  units: number
}
/** Amazon's packing groups (from listPackingGroupItems): units of different groups never share a box. */
export interface FbaPackingGroupInput {
  packingGroupId: string
  mskus: readonly string[]
}

/* ── the plan as stored (Json columns) and as read ────────────────────────────────────────────── */

export interface FbaMoney {
  amount: number
  currency: string
}
/** Amazon's Incentive (a fee or a discount). */
export interface FbaFee {
  type: string | null
  target: string | null
  description: string | null
  value: FbaMoney | null
}

/** `plan.packing`. */
export interface FbaPackingSnapshot {
  packingOptionId: string
  fees: FbaFee[]
  groups: Array<{ packingGroupId: string; items: Array<{ msku: string; quantity: number }>; boxes: FbaBoxPlan[] }>
  /** When setPackingInformation was accepted; null = not yet. */
  sentAt: string | null
}

export interface FbaTransportOption {
  transportationOptionId: string
  shipmentId: string
  carrierName: string | null
  /** Amazon's carrier alphaCode. */
  carrierCode: string | null
  /** 'GROUND_SMALL_PARCEL' | 'FREIGHT_LTL' | … */
  shippingMode: string
  /** 'AMAZON_PARTNERED_CARRIER' | 'USE_YOUR_OWN_CARRIER' */
  shippingSolution: string
  quote: { cost: FbaMoney; expiresAt: string | null; voidableUntil: string | null } | null
  preconditions: string[]
}
export interface FbaDeliveryWindowOption {
  deliveryWindowOptionId: string
  start: string
  end: string
  availabilityType: string | null
  validUntil: string | null
}
export interface FbaPlacementShipment {
  /** Amazon's shipment id (sh…). */
  shipmentId: string
  /** The fulfilment centre (warehouseId), e.g. MXP5. */
  destinationFc: string | null
  destinationTown: string | null
  transport: FbaTransportOption[]
  deliveryWindows: FbaDeliveryWindowOption[]
}
export interface FbaPlacementOption {
  placementOptionId: string
  /** Amazon's status: OFFERED | ACCEPTED | EXPIRED. */
  status: string
  expiresAt: string | null
  fees: FbaFee[]
  discounts: FbaFee[]
  shipments: FbaPlacementShipment[]
}
/** `plan.options` — what the Owner chooses from. */
export interface FbaPlanOptions {
  readAt: string
  /** The earliest expiry of the offered options; after it the drawer offers "Get new options". */
  expiresAt: string | null
  placements: FbaPlacementOption[]
}

/** One entry of `plan.steps`: one Amazon operation of a step (or the step itself when it has none). */
export interface FbaPlanStepEntry {
  step: FbaPlanStep
  /** The Amazon operation; null = a step with no asynchronous operation (e.g. LABELS reads the boxes). */
  call: FbaAmazonOperation | null
  /** Written BEFORE polling. An entry with an operationId and no `result` → poll it, never send again. */
  operationId: string | null
  /** The shipment a per-shipment call is for (delivery windows, transport, tracking). */
  shipmentId: string | null
  startedAt: string
  finishedAt: string | null
  result: 'IN_PROGRESS' | 'SUCCESS' | 'FAILED' | null
  problems: FbaAmazonProblem[]
  /** e.g. "adopted plan wf… found by name". */
  note: string | null
}

/** `FBAShipment.boxes` — one entry per physical box (Amazon's listShipmentBoxes). */
export interface FbaShipmentBox {
  boxId: string
  kind: 'case' | 'mixed' | null
  lengthCm: number | null
  widthCm: number | null
  heightCm: number | null
  weightKg: number | null
  items: Array<{ msku: string; quantity: number }>
}
/** `FBAShipment.transport` — what was confirmed. */
export interface FbaShipmentTransport {
  transportationOptionId: string
  carrierName: string | null
  carrierCode: string | null
  shippingMode: string
  shippingSolution: string
  deliveryWindow: { deliveryWindowOptionId: string; start: string; end: string } | null
  quote: FbaMoney | null
}
/** `FBAShipment.tracking` — the numbers the person typed at "Mark shipped" and when they reached Amazon. */
export interface FbaShipmentTracking {
  boxes: Array<{ boxId: string; trackingId: string }>
  /** null = not sent to Amazon yet (the TRACKING step sends it). */
  sentAt: string | null
}

export interface FbaPlanLineView {
  productId: string
  sku: string
  /** null in a DRAFT until it is sent (read again at "Send to Amazon"). */
  msku: string | null
  quantity: number
  /** Sealed cases sent per case size (`FbaInboundPlanLine.caseCounts`). */
  cases: CaseCount[]
  looseUnits: number
  /** null in a DRAFT until it is sent. */
  prepOwner: string | null
  labelOwner: string | null
  shippedQuantity: number
  /** A hold stands for the units not shipped yet. */
  held: boolean
}
export interface FbaShipmentView {
  /** FBAShipment.id — `:id` of the labels and shipped routes. */
  id: string
  /** Amazon's sh… id. */
  amazonShipmentId: string | null
  /** FBA15… (`FBAShipment.shipmentId`) — the id on the labels and in Seller Central. */
  shipmentConfirmationId: string
  destinationFc: string
  /** FBAShipment.status (Amazon's: WORKING, SHIPPED, IN_TRANSIT, RECEIVING, CLOSED, …). */
  status: string
  units: number
  boxes: FbaShipmentBox[]
  transport: FbaShipmentTransport | null
  tracking: FbaShipmentTracking | null
  shippedAt: string | null
  shippedBy: string | null
}
/** What a person may do on the plan now (`fbaPlanCan`). */
export interface FbaPlanCan {
  /** DRAFT: change its SKUs, From, To, ready day, box; "Send to Amazon"; "Delete draft". */
  edit: boolean
  send: boolean
  discard: boolean
  choose: boolean
  newOptions: boolean
  retry: boolean
  cancel: boolean
}
/** GET /api/fba/inbound/plans/:id, and each item of GET /api/fba/inbound/plans?productId=&open=1. */
export interface FbaPlanView {
  /** FbaInboundPlanV2.id — "planId" everywhere on the wire. */
  id: string
  name: string
  status: FbaPlanStatus
  step: FbaPlanStep | null
  source: 'matrix' | 'claude' | null
  /** Amazon's inboundPlanId (wf…); null until created. */
  amazonPlanId: string | null
  market: string | null
  marketplaceId: string | null
  from: { locationId: string; code: string; name: string } | null
  readyToShipOn: string | null
  mixedBox: FbaMixedBox | null
  skus: number
  units: number
  shippedUnits: number
  lines: FbaPlanLineView[]
  steps: FbaPlanStepEntry[]
  options: FbaPlanOptions | null
  choice: FbaChoiceRequest | null
  shipments: FbaShipmentView[]
  /** FAILED: Amazon's problems verbatim (the failed step's). */
  problems: FbaAmazonProblem[]
  /** HELD / FAILED: the one sentence to show (`lastError`). */
  message: string | null
  nextCheckAt: string | null
  createdAt: string
  createdBy: string | null
  confirmedAt: string | null
  confirmedBy: string | null
  cancelledAt: string | null
  can: FbaPlanCan
}

/** What a person may do on a plan. `now` (ISO) decides whether the options expired. */
export function fbaPlanCan(i: { status: string; shippedShipments: number; optionsExpireAt?: string | null; now: string }): FbaPlanCan {
  const expired = !!i.optionsExpireAt && Date.parse(i.optionsExpireAt) <= Date.parse(i.now)
  const waiting = i.status === 'WAITING_FOR_CHOICE'
  const draft = i.status === 'DRAFT'
  return {
    edit: draft,
    send: draft,
    discard: draft,
    choose: waiting && !expired,
    newOptions: waiting && expired,
    retry: i.status === 'FAILED',
    cancel: i.shippedShipments === 0 && (FBA_CANCELLABLE_STATUSES as readonly string[]).includes(i.status),
  }
}

/* ── the operator's words ─────────────────────────────────────────────────────────────────────── */

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const ADDRESS_LABEL: Record<FbaAddressField, string> = {
  name: 'company name', addressLine1: 'street', city: 'town', postalCode: 'postal code', countryCode: 'country', phoneNumber: 'phone',
}
/** Company fields live in Settings › Company; the rest is the warehouse's address (Locations). */
const COMPANY_FIELDS: readonly FbaAddressField[] = ['name', 'phoneNumber']
const sizeText = (b: { lengthCm: number; widthCm: number; heightCm: number }) => `${b.lengthCm} × ${b.widthCm} × ${b.heightCm} cm`

export const FBA_SEND_COPY = {
  open: 'Send to FBA…',
  title: (skus: number) => `Send to FBA · ${plural(skus, 'SKU', 'SKUs')}`,
  from: 'From',
  to: 'To',
  ready: 'Ready',
  prepBy: 'Prep by',
  labelsBy: 'Labels by',
  owner: { AMAZON: 'Amazon', SELLER: 'Seller' } as Record<CaseOwner, string>,
  ownersHint: 'Saved for these SKUs',
  columns: { sku: 'SKU', free: 'Free', cases: 'Cases', units: 'Units', boxes: 'Boxes', check: 'Check' },
  /** `48`, `48 · 4 cases` (one size), `48 · 2×12 + 1×6` (several sizes). */
  free: (free: number, freeSealed: readonly CaseCount[]) =>
    (freeSealed.some(c => c.cases > 0) ? `${free} · ${CASE_COPY.cases(freeSealed)}` : `${free}`),
  mixedLine: (boxes: number, box: FbaMixedBox) => `Loose units go in ${plural(boxes, 'mixed box', 'mixed boxes')} · ${sizeText(box)}`,
  changeBox: 'Change box size',
  metrics: { skus: 'SKUs', units: 'Units', boxes: 'Boxes', weight: 'Weight' },
  weight: (kg: number) => `${kg.toFixed(1)} kg`,
  primary: (units: number) => `Create plan · ${plural(units, 'unit', 'units')}`,
  /** The Matrix dialog's button (Owner 2026-10-08): the SKUs go into the open draft. */
  addToDraft: (units: number) => `Add to draft · ${plural(units, 'unit', 'units')}`,
  addedToDraft: 'Added to draft',
  /** The page's draft button: today's Create plan. */
  sendToAmazon: (units: number) => `Send to Amazon · ${plural(units, 'unit', 'units')}`,
  deleteDraft: 'Delete draft',
  newDraft: 'New draft',
  addSkus: 'Add SKUs',
  removeSku: (sku: string) => `Remove ${sku}`,
  draftExists: (from: string, market: string) => `There is already a draft from ${from} to Amazon ${market}`,
  /** The FBA shipments page (Fulfillment › Outbound). */
  pageTitle: 'FBA shipments',
  views: { drafts: 'Drafts', active: 'In progress', done: 'Done' } as Record<FbaPlanListView, string>,
  openPage: 'Open in FBA shipments',
  /** The Matrix footer link: a draft holds this family's SKUs / shipments under way. */
  draftLink: (units: number) => `FBA draft · ${plural(units, 'unit', 'units')}`,
  shipmentLink: (count: number, status: string) => (count === 1 ? `FBA shipment · ${status}` : `FBA shipments · ${count}`),
  done: 'Plan sent to Amazon. Next: pick where it goes — about 2–5 minutes.',
  follow: 'Follow it',
  undo: 'Undo',
  doneButton: 'Done',
  undoHint: 'Free until you confirm with Amazon',
  plansButton: (open: number) => `FBA plans · ${open}`,
  drawerTitle: 'FBA plans',
  status: {
    DRAFT: 'Draft', QUEUED: 'Queued', CREATING: 'Creating at Amazon', PACKING: 'Packing', BOXES: 'Sending boxes', PLACING: 'Getting placement',
    QUOTING: 'Getting carriers', WAITING_FOR_CHOICE: 'Pick where it goes', CONFIRMING: 'Confirming', LABELS: 'Getting labels',
    READY_TO_SHIP: 'Ready to ship', SHIPPED: 'Shipped', AT_AMAZON: 'At Amazon', CLOSED: 'Closed', FAILED: 'Failed',
    HELD: 'On hold', CANCELLING: 'Cancelling', CANCELLED: 'Cancelled',
  } as Record<FbaPlanStatus, string>,
  /** The drawer's Timeline, in order. PLACE and QUOTE together are "Options ready". */
  timeline: [
    { key: 'CREATE', label: 'Created' },
    { key: 'PACK', label: 'Packed' },
    { key: 'BOXES', label: 'Boxes sent' },
    { key: 'QUOTE', label: 'Options ready' },
    { key: 'CONFIRM', label: 'Confirmed' },
    { key: 'LABELS', label: 'Labels' },
    { key: 'SHIPPED', label: 'Shipped' },
    { key: 'AT_AMAZON', label: 'At Amazon' },
  ] as ReadonlyArray<{ key: FbaPlanStep | 'SHIPPED' | 'AT_AMAZON'; label: string }>,
  option: (shipments: number, fcs: readonly string[], fees: string) =>
    `${plural(shipments, 'shipment', 'shipments')} · ${fcs.join(', ')} · Amazon fees ${fees}`,
  ownCarrier: 'Own carrier',
  arrive: (start: string, end: string) => `arrive ${start}–${end}`,
  confirm: 'Confirm with Amazon',
  confirmFinal: 'Final at Amazon: the shipments and fulfilment centres cannot change after this.',
  newOptions: 'Get new options',
  optionsExpired: 'Amazon\'s options expired. Get new options to choose again.',
  tryAgain: 'Try again',
  cancelPlan: 'Cancel plan',
  cancelConfirmed: 'Amazon may charge for a cancel outside the void window (partnered carrier only).',
  labels: 'Labels (PDF)',
  tracking: 'Tracking',
  markShipped: 'Mark shipped',
  shippedConfirm: (units: number, from: string) => `${plural(units, 'unit leaves', 'units leave')} ${from}`,
  shippedLine: (time: string) => `Shipped ${time} · tracking sent`,
  held: {
    writesOff: 'Amazon writes for FBA plans are off on this server',
    signIn: 'The Amazon account needs a new sign-in (Settings › Channels)',
    rate: 'Amazon asked Nexus to slow down; it tries again by itself',
  },
  /** The 410 answer of the retired wizard / v0 routes. */
  movedToMatrix: 'Send to FBA runs from the Matrix now',
  /** Claude's tool when a SKU's owners are not set. */
  ownersForClaude: 'Set Prep by / Labels by in the Matrix Case column first',
  inbound: (units: number) => `+${units}`,
  inboundDetail: (units: number, working: number, shipped: number, receiving: number) =>
    `inbound ${units} (working ${working}, shipped ${shipped}, receiving ${receiving})`,
  inPlan: (units: number, plan: string) => `${units} in Nexus plan ${plan}`,
  /** The FBA cell's tooltip when Nexus's shipped units are more than Amazon's inbound count (`fbaInboundShown`). */
  sentNotCounted: (units: number) => `${units} shipped by Nexus — Amazon has not counted them yet`,
  /** One Banner title per kind of problem. */
  problemTitle: {
    NOT_A_WAREHOUSE: 'From is not an active warehouse',
    NO_ACCOUNT: 'No Amazon account in this market',
    NO_ADDRESS: 'Ship-from address incomplete',
    READY_DATE: 'Ready day in the past',
    BOX_OVER_LIMIT: 'Mixed box over Amazon\'s limit',
    UNKNOWN_SKU: 'SKU not in this send',
    INVALID_QUANTITY: 'Cases or units not valid',
    OVER_FREE: 'More units than free',
    OVER_FREE_CASES: 'More cases than free',
    NO_LISTING: 'No Amazon listing in this market',
    NO_OWNERS: 'Prep by / Labels by not set',
    NO_CASE_SIZE: 'No case size',
    NO_CASE_DIMENSIONS: 'Case size or weight missing',
    CASE_OVER_LIMIT: 'Case over Amazon\'s box limit',
    NO_UNIT_WEIGHT: 'No unit weight for loose units',
    NO_UNIT_SIZE: 'No unit size',
    UNIT_TOO_BIG: 'Unit does not fit the mixed box',
    IN_OPEN_PLAN: 'Already in an open plan',
    NOT_IN_GROUP: 'Not in an Amazon packing group',
    NO_UNITS: 'Nothing to send',
    TOO_MANY_SKUS: 'Too many SKUs',
  } as Record<FbaSendProblemCode, string>,
  problem: {
    notWarehouse: 'Choose one of your active warehouses as From',
    noAccount: (market: string) => `No Amazon account sells in ${market}`,
    noAddress: (missing: readonly FbaAddressField[], fromCode: string | null) => {
      const where: string[] = []
      if (missing.some(f => !COMPANY_FIELDS.includes(f))) where.push(fromCode ? `Locations › ${fromCode}` : 'Locations')
      if (missing.some(f => COMPANY_FIELDS.includes(f))) where.push('Settings › Company')
      return `The ship-from address needs: ${missing.map(f => ADDRESS_LABEL[f]).join(', ')}. Fill ${where.join(' and ')}.`
    },
    readyDate: 'The ready day must be today or later',
    boxOverLimit: `The mixed box must be more than 0 and at most ${AMAZON_EU_BOX.maxSideCm} cm a side, and hold at most ${AMAZON_EU_BOX.maxKg} kg with the box`,
    unknownSku: (id: string) => `${id}: not one of the SKUs of this send`,
    invalidQuantity: (sku: string) => `${sku}: cases and units must be whole numbers, 0 or more`,
    tooManyUnits: (sku: string) => `${sku}: at most ${FBA_SEND_MAX_UNITS_PER_SKU} units per SKU in one plan`,
    listedTwice: (sku: string) => `${sku}: listed twice`,
    overFree: (sku: string, asked: number, free: number, from: string) => `${sku}: ${asked} units asked; ${free} free at ${from}`,
    overFreeCases: (sku: string, unitsPerCase: number, asked: number, free: number, from: string) =>
      `${sku}: ${plural(asked, 'sealed case', 'sealed cases')} of ${unitsPerCase} asked; ${free} free at ${from}`,
    noListing: (sku: string, market: string) => `${sku}: no Amazon listing in ${market}`,
    noOwners: (sku: string) => `${sku}: choose who preps and labels (Prep by / Labels by)`,
    noCaseSize: (sku: string, unitsPerCase: number) => `${sku}: ${CASE_COPY.noSizeOf(unitsPerCase)}`,
    noCaseDimensions: (sku: string, unitsPerCase: number) =>
      `${sku}: the ${unitsPerCase} / case size needs its case size and weight — set them in the Matrix (Case column)`,
    caseOverLimit: (sku: string) => `${sku}: ${CASE_COPY.boxLimit} Amazon may refuse this case.`,
    noUnitWeight: (sku: string) => `${sku}: no unit weight — loose units need it to fill mixed boxes. Send whole cases, or set the weight.`,
    noUnitSize: (sku: string) => `${sku}: no unit size — the mixed boxes are counted by weight only`,
    unitTooBig: (sku: string, box: FbaMixedBox) => `${sku}: one unit does not fit the mixed box (${sizeText(box)}, ${box.maxKg} kg)`,
    inOpenPlan: (sku: string, units: number) => `${sku}: ${plural(units, 'unit is', 'units are')} already in an open FBA plan`,
    notInGroup: (sku: string) => `${sku}: Amazon put it in no packing group`,
    noUnits: 'Add units to send',
    tooManySkus: `One plan takes up to ${FBA_SEND_MAX_SKUS} SKUs`,
  },
} as const

/* ── small pure helpers ───────────────────────────────────────────────────────────────────────── */

const KG_PER: Record<string, number> = {
  kg: 1, kgs: 1, kilogram: 1, kilograms: 1,
  g: 0.001, gr: 0.001, gram: 0.001, grams: 0.001,
  lb: 0.45359237, lbs: 0.45359237, pound: 0.45359237, pounds: 0.45359237,
  oz: 0.028349523125, ounce: 0.028349523125, ounces: 0.028349523125,
}
const CM_PER: Record<string, number> = {
  cm: 1, centimeter: 1, centimeters: 1, centimetre: 1, centimetres: 1,
  mm: 0.1, millimeter: 0.1, millimeters: 0.1, millimetre: 0.1, millimetres: 0.1,
  m: 100, meter: 100, meters: 100, metre: 100, metres: 100,
  in: 2.54, inch: 2.54, inches: 2.54,
}
function convert(table: Record<string, number>, value: unknown, unit: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  if (!Number.isFinite(n) || n <= 0 || typeof unit !== 'string') return null
  const factor = table[unit.trim().toLowerCase()]
  return factor === undefined ? null : n * factor
}
/** `Product.weightValue` + `weightUnit` in kg (kg, g, lb, oz in any spelling or case). Unknown unit or ≤ 0 → null, never a guess. */
export function unitWeightKg(value: unknown, unit: unknown): number | null {
  return convert(KG_PER, value, unit)
}
/** `Product.dim*` + `dimUnit` in cm (cm, mm, m, in in any spelling or case). Unknown unit or ≤ 0 → null, never a guess. */
export function lengthCm(value: unknown, unit: unknown): number | null {
  return convert(CM_PER, value, unit)
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/
function isDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}
/** The next Monday–Friday after `today` (YYYY-MM-DD). */
export function nextWorkingDay(today: string): string {
  const d = new Date(`${today}T00:00:00Z`)
  do {
    d.setUTCDate(d.getUTCDate() + 1)
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6)
  return d.toISOString().slice(0, 10)
}
/**
 * The plan's name at Amazon: `Nexus IT 2026-10-08 #a1b2c3` (the last 6 of the plan row id). The runner finds a plan
 * Amazon created before a crash by this name (listInboundPlans), so it is FROZEN.
 */
export function fbaAmazonPlanName(market: string, day: string, planRowId: string): string {
  return `Nexus ${market} ${day} #${planRowId.slice(-6)}`
}
/** Which of Amazon's required ship-from fields are empty. */
export function addressMissing(address: Partial<FbaSourceAddress> | null | undefined): FbaAddressField[] {
  return FBA_ADDRESS_FIELDS.filter(field => {
    const value = address?.[field]
    return typeof value !== 'string' || value.trim() === ''
  })
}
/** Sealed cases of a line, all sizes together. */
export function lineCases(line: Pick<FbaSendLine, 'cases'>): number {
  return (line.cases ?? []).reduce((n, c) => n + (Number.isFinite(c.cases) ? c.cases : 0), 0)
}
/** Units of one line: Σ cases × unitsPerCase + looseUnits. */
export function lineUnits(line: Pick<FbaSendLine, 'cases' | 'looseUnits'>): number {
  const sealed = (line.cases ?? []).reduce((n, c) => {
    const size = Number.isInteger(c.unitsPerCase) && c.unitsPerCase >= 1 ? c.unitsPerCase : 0
    return n + (Number.isFinite(c.cases) ? c.cases : 0) * size
  }, 0)
  return sealed + (Number.isFinite(line.looseUnits) ? line.looseUnits : 0)
}
/** A line's case counts are valid: whole numbers ≥ 0, each size named once. */
function validCases(cases: unknown): cases is CaseCount[] {
  if (!Array.isArray(cases)) return false
  const seen = new Set<number>()
  for (const c of cases) {
    if (!c || typeof c !== 'object') return false
    const { unitsPerCase, cases: n } = c as CaseCount
    if (!Number.isInteger(unitsPerCase) || unitsPerCase < 1 || seen.has(unitsPerCase)) return false
    if (!Number.isInteger(n) || n < 0) return false
    seen.add(unitsPerCase)
  }
  return true
}
/** The SKU's owners for the plan: its own, else the dialog's answer; null when still not set. */
export function effectiveOwners(sku: Pick<FbaSendSku, 'prepOwner' | 'labelOwner'>, owners: FbaSendOwners | null | undefined):
  { prepOwner: CaseOwner; labelOwner: CaseOwner } | null {
  const prepOwner = sku.prepOwner ?? (owners && isCaseOwner(owners.prepOwner) ? owners.prepOwner : null)
  const labelOwner = sku.labelOwner ?? (owners && isCaseOwner(owners.labelOwner) ? owners.labelOwner : null)
  return prepOwner && labelOwner ? { prepOwner, labelOwner } : null
}
/** Why this mixed box cannot be used, or null: 0 < side ≤ 63.5 cm; 0 ≤ empty < max ≤ 23 kg. */
export function mixedBoxProblem(box: FbaMixedBox): string | null {
  const sides = [box.lengthCm, box.widthCm, box.heightCm]
  const sidesOk = sides.every(side => Number.isFinite(side) && side > 0 && side <= AMAZON_EU_BOX.maxSideCm)
  const weightOk = Number.isFinite(box.emptyKg) && Number.isFinite(box.maxKg) && box.emptyKg >= 0
    && box.maxKg > box.emptyKg && box.maxKg <= AMAZON_EU_BOX.maxKg
  return sidesOk && weightOk ? null : FBA_SEND_COPY.problem.boxOverLimit
}

/* ── planBoxes ────────────────────────────────────────────────────────────────────────────────── */

const grams = (kg: number) => Math.round(kg * 1000)
const kgOf = (g: number) => Math.round(g / 10) / 100
const sorted3 = (a: number, b: number, c: number) => [a, b, c].sort((x, y) => x - y)

interface OpenBox { groupId: string | null; usedG: number; usedV: number; items: Map<string, { productId: string; msku: string; quantity: number }> }

/**
 * The boxes for these lines.
 * - Whole cases → ONE `FbaBoxPlan` per SKU and case size with `quantity` = cases (identical boxes): that case's size
 *   and weight, content = its unitsPerCase. A size the SKU does not have → NO_CASE_SIZE; no case size/weight →
 *   NO_CASE_DIMENSIONS (both blocking).
 *   A case over 63.5 cm / 23 kg → CASE_OVER_LIMIT, a WARNING (Amazon may refuse it; the case box is still planned).
 * - Loose units → MIXED boxes of `mixedBox`, first-fit decreasing (heaviest units first): a unit goes in the first open
 *   box (of its packing group) whose weight stays ≤ maxKg including the empty box and whose units' volume stays
 *   ≤ MIXED_BOX_FILL × the box volume; else a new box. A unit with no weight → NO_UNIT_WEIGHT (blocking, not boxed);
 *   no size → NO_UNIT_SIZE (warning, counted by weight only); a unit that cannot go in an empty box → UNIT_TOO_BIG
 *   (blocking). A mixed box over Amazon's limits → BOX_OVER_LIMIT (blocking) and no mixed box is built: NEVER a mixed
 *   box over the limits.
 * - `groups` (the runner, after Amazon's packing): units of different groups never share a box; a SKU in no group →
 *   NOT_IN_GROUP (blocking). Without `groups` every box has `packingGroupId: null`.
 * Identical mixed boxes are folded into one entry with `quantity` > 1. Lines with unknown SKUs or invalid counts are
 * skipped here (`sendProblems` names them). A SKU with no Amazon listing (`msku` null) is boxed under its Nexus SKU;
 * `sendProblems` refuses it (NO_LISTING) before anything is sent.
 */
export function planBoxes(
  lines: ReadonlyArray<FbaSendLine>,
  skus: ReadonlyArray<FbaBoxSku>,
  mixedBox: FbaMixedBox,
  groups?: ReadonlyArray<FbaPackingGroupInput>,
): FbaBoxResult {
  const bySku = new Map(skus.map(s => [s.productId, s]))
  const problems: FbaSendProblem[] = []
  const caseBoxes: FbaBoxPlan[] = []
  const add = (code: FbaSendProblemCode, message: string, productId: string | null, blocking: boolean) =>
    problems.push({ code, message, productId, blocking })
  const groupOf = (msku: string): string | null | undefined => {
    if (!groups) return null
    return groups.find(g => g.mskus.includes(msku))?.packingGroupId
  }

  const boxProblem = mixedBoxProblem(mixedBox)
  const capG = grams(mixedBox.maxKg) - grams(mixedBox.emptyKg)
  const capV = mixedBox.lengthCm * mixedBox.widthCm * mixedBox.heightCm * MIXED_BOX_FILL
  const boxSides = sorted3(mixedBox.lengthCm, mixedBox.widthCm, mixedBox.heightCm)
  const loose: Array<{ sku: FbaBoxSku; msku: string; groupId: string | null; units: number; g: number; v: number; order: number }> = []

  lines.forEach((line, order) => {
    const sku = bySku.get(line.productId)
    if (!sku) return
    const whole = (n: number) => Number.isInteger(n) && n >= 0
    if (!validCases(line.cases) || !whole(line.looseUnits)) return
    if (lineCases(line) === 0 && line.looseUnits === 0) return
    const msku = sku.msku ?? sku.sku
    const groupId = groupOf(msku)
    if (groupId === undefined) {
      add('NOT_IN_GROUP', FBA_SEND_COPY.problem.notInGroup(sku.sku), sku.productId, true)
      return
    }

    // Biggest case first, so the boxes read in the same order everywhere.
    for (const count of [...line.cases].sort((a, b) => b.unitsPerCase - a.unitsPerCase)) {
      if (count.cases === 0) continue
      const size = (sku.caseSizes ?? []).find(s => s.unitsPerCase === count.unitsPerCase)
      if (!size) {
        add('NO_CASE_SIZE', FBA_SEND_COPY.problem.noCaseSize(sku.sku, count.unitsPerCase), sku.productId, true)
      } else if (!size.case) {
        add('NO_CASE_DIMENSIONS', FBA_SEND_COPY.problem.noCaseDimensions(sku.sku, count.unitsPerCase), sku.productId, true)
      } else {
        const c = size.case
        if ([c.lengthCm, c.widthCm, c.heightCm].some(side => side > AMAZON_EU_BOX.maxSideCm) || c.weightKg > AMAZON_EU_BOX.maxKg) {
          add('CASE_OVER_LIMIT', FBA_SEND_COPY.problem.caseOverLimit(sku.sku), sku.productId, false)
        }
        caseBoxes.push({
          kind: 'case', packingGroupId: groupId, quantity: count.cases,
          lengthCm: c.lengthCm, widthCm: c.widthCm, heightCm: c.heightCm, weightKg: c.weightKg,
          items: [{ productId: sku.productId, msku, quantity: size.unitsPerCase }],
        })
      }
    }

    if (line.looseUnits > 0) {
      if (sku.unitWeightKg === null || !(sku.unitWeightKg > 0)) {
        add('NO_UNIT_WEIGHT', FBA_SEND_COPY.problem.noUnitWeight(sku.sku), sku.productId, true)
        return
      }
      if (boxProblem) return // reported once below; no mixed box is ever built over the limits
      const g = Math.max(1, grams(sku.unitWeightKg))
      let v = 0
      if (sku.unit) {
        const unitSides = sorted3(sku.unit.lengthCm, sku.unit.widthCm, sku.unit.heightCm)
        if (unitSides.some((side, i) => side > boxSides[i])) {
          add('UNIT_TOO_BIG', FBA_SEND_COPY.problem.unitTooBig(sku.sku, mixedBox), sku.productId, true)
          return
        }
        v = sku.unit.lengthCm * sku.unit.widthCm * sku.unit.heightCm
      } else {
        add('NO_UNIT_SIZE', FBA_SEND_COPY.problem.noUnitSize(sku.sku), sku.productId, false)
      }
      if (g > capG || v > capV) {
        add('UNIT_TOO_BIG', FBA_SEND_COPY.problem.unitTooBig(sku.sku, mixedBox), sku.productId, true)
        return
      }
      loose.push({ sku, msku, groupId, units: line.looseUnits, g, v, order })
    }
  })

  if (boxProblem && lines.some(l => bySku.has(l.productId) && Number.isInteger(l.looseUnits) && l.looseUnits > 0)) {
    add('BOX_OVER_LIMIT', boxProblem, null, true)
  }

  // First-fit decreasing: heaviest units first, then the biggest, then line order (deterministic).
  loose.sort((a, b) => b.g - a.g || b.v - a.v || a.order - b.order)
  const open: OpenBox[] = []
  const EPS = 1e-9
  for (const entry of loose) {
    let left = entry.units
    const room = (box: OpenBox) => {
      const byWeight = Math.floor((capG - box.usedG) / entry.g)
      const byVolume = entry.v > 0 ? Math.floor((capV - box.usedV) / entry.v + EPS) : Number.POSITIVE_INFINITY
      return Math.max(0, Math.min(byWeight, byVolume))
    }
    const put = (box: OpenBox, n: number) => {
      box.usedG += n * entry.g
      box.usedV += n * entry.v
      const item = box.items.get(entry.sku.productId)
      if (item) item.quantity += n
      else box.items.set(entry.sku.productId, { productId: entry.sku.productId, msku: entry.msku, quantity: n })
      left -= n
    }
    for (const box of open) {
      if (left === 0) break
      if (box.groupId !== entry.groupId) continue
      const n = Math.min(left, room(box))
      if (n > 0) put(box, n)
    }
    while (left > 0) {
      const box: OpenBox = { groupId: entry.groupId, usedG: 0, usedV: 0, items: new Map() }
      open.push(box)
      put(box, Math.min(left, room(box)))
    }
  }

  // Fold identical mixed boxes (same group, same content, same weight) into one entry with a quantity.
  const mixed: FbaBoxPlan[] = []
  const byKey = new Map<string, FbaBoxPlan>()
  for (const box of open) {
    const items = [...box.items.values()].sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0))
    const weightKg = kgOf(grams(mixedBox.emptyKg) + box.usedG)
    const key = JSON.stringify([box.groupId, weightKg, items.map(i => [i.productId, i.quantity])])
    const same = byKey.get(key)
    if (same) { same.quantity += 1; continue }
    const plan: FbaBoxPlan = {
      kind: 'mixed', packingGroupId: box.groupId, quantity: 1,
      lengthCm: mixedBox.lengthCm, widthCm: mixedBox.widthCm, heightCm: mixedBox.heightCm, weightKg, items,
    }
    byKey.set(key, plan)
    mixed.push(plan)
  }

  const boxes = [...caseBoxes, ...mixed]
  const count = (list: FbaBoxPlan[]) => list.reduce((n, b) => n + b.quantity, 0)
  return {
    boxes,
    problems,
    boxCount: count(boxes),
    caseBoxes: count(caseBoxes),
    mixedBoxes: count(mixed),
    weightKg: Math.round(boxes.reduce((kg, b) => kg + b.quantity * b.weightKg, 0) * 100) / 100,
    units: boxes.reduce((n, b) => n + b.quantity * b.items.reduce((u, i) => u + i.quantity, 0), 0),
  }
}

/* ── sendProblems / sendSummary ───────────────────────────────────────────────────────────────── */

/** What the person chose in the dialog (the create request minus where it goes, which the draft already carries). */
export type FbaSendChoice = Pick<FbaCreateRequest, 'lines' | 'readyToShipOn' | 'mixedBox' | 'owners'>

export interface FbaSendSummary {
  /** SKUs with units. */
  skus: number
  units: number
  cases: number
  looseUnits: number
  boxes: number
  caseBoxes: number
  mixedBoxes: number
  weightKg: number
  /** The boxes (the dialog's estimate; Amazon's packing groups may split them — the drawer shows the final ones). */
  plan: FbaBoxResult
  problems: FbaSendProblem[]
  blocking: FbaSendProblem[]
  warnings: FbaSendProblem[]
  /** "Create plan · 120 units". */
  primary: string
  /** Why the primary button is held (the first blocking problem); null = ready. */
  held: string | null
  /** "Loose units go in 2 mixed boxes · 60 × 40 × 40 cm"; null = no loose units. */
  mixedLine: string | null
}

function evaluate(draft: FbaSendDraft, choice: FbaSendChoice): FbaSendSummary {
  const problems: FbaSendProblem[] = []
  const add = (code: FbaSendProblemCode, message: string, productId: string | null, blocking: boolean) =>
    problems.push({ code, message, productId, blocking })
  const bySku = new Map(draft.skus.map(s => [s.productId, s]))
  const fromCode = draft.from?.code ?? null
  const mixedBox = choice.mixedBox ?? draft.mixedBox

  // The whole plan.
  if (!draft.from) add('NOT_A_WAREHOUSE', FBA_SEND_COPY.problem.notWarehouse, null, true)
  if (!draft.markets.some(m => m.code === draft.market)) add('NO_ACCOUNT', FBA_SEND_COPY.problem.noAccount(draft.market), null, true)
  if (draft.address.missing.length) add('NO_ADDRESS', FBA_SEND_COPY.problem.noAddress(draft.address.missing, fromCode), null, true)
  if (!isDay(choice.readyToShipOn) || choice.readyToShipOn < draft.today) add('READY_DATE', FBA_SEND_COPY.problem.readyDate, null, true)
  const boxProblem = mixedBoxProblem(mixedBox)
  if (boxProblem && choice.lines.some(l => Number.isInteger(l.looseUnits) && l.looseUnits > 0)) add('BOX_OVER_LIMIT', boxProblem, null, true)

  // Each line.
  const seen = new Set<string>()
  const counted: FbaSendLine[] = []
  let units = 0
  let cases = 0
  let looseUnits = 0
  let withUnits = 0
  for (const line of choice.lines) {
    const sku = bySku.get(line.productId)
    if (!sku) { add('UNKNOWN_SKU', FBA_SEND_COPY.problem.unknownSku(line.productId), line.productId, true); continue }
    if (seen.has(line.productId)) { add('INVALID_QUANTITY', FBA_SEND_COPY.problem.listedTwice(sku.sku), sku.productId, true); continue }
    seen.add(line.productId)
    const whole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0
    if (!validCases(line.cases) || !whole(line.looseUnits)) { add('INVALID_QUANTITY', FBA_SEND_COPY.problem.invalidQuantity(sku.sku), sku.productId, true); continue }
    // Cases of a size the SKU does not have still count their units here; planBoxes refuses them (NO_CASE_SIZE).
    const lineTotal = lineUnits(line)
    const lineCaseCount = lineCases(line)
    if (lineCaseCount === 0 && line.looseUnits === 0) continue
    withUnits += 1
    counted.push(line)
    units += lineTotal
    cases += lineCaseCount
    looseUnits += line.looseUnits
    if (lineTotal > FBA_SEND_MAX_UNITS_PER_SKU) add('INVALID_QUANTITY', FBA_SEND_COPY.problem.tooManyUnits(sku.sku), sku.productId, true)
    if (sku.msku === null) add('NO_LISTING', FBA_SEND_COPY.problem.noListing(sku.sku, draft.market), sku.productId, true)
    if (!effectiveOwners(sku, choice.owners)) add('NO_OWNERS', FBA_SEND_COPY.problem.noOwners(sku.sku), sku.productId, true)
    for (const count of line.cases) {
      if (count.cases === 0 || !(sku.caseSizes ?? []).some(s => s.unitsPerCase === count.unitsPerCase)) continue
      const free = (sku.freeSealed ?? []).find(f => f.unitsPerCase === count.unitsPerCase)?.cases ?? 0
      if (count.cases > free) {
        add('OVER_FREE_CASES', FBA_SEND_COPY.problem.overFreeCases(sku.sku, count.unitsPerCase, count.cases, free, fromCode ?? '—'), sku.productId, true)
      }
    }
    if (lineTotal > sku.free) add('OVER_FREE', FBA_SEND_COPY.problem.overFree(sku.sku, lineTotal, sku.free, fromCode ?? '—'), sku.productId, true)
    if (sku.openPlanUnits > 0) add('IN_OPEN_PLAN', FBA_SEND_COPY.problem.inOpenPlan(sku.sku, sku.openPlanUnits), sku.productId, false)
  }

  // The boxes (only for the lines that passed the count checks).
  const plan = planBoxes(counted, draft.skus, mixedBox)
  problems.push(...plan.problems)
  if (withUnits === 0) add('NO_UNITS', FBA_SEND_COPY.problem.noUnits, null, true)
  if (withUnits > FBA_SEND_MAX_SKUS) add('TOO_MANY_SKUS', FBA_SEND_COPY.problem.tooManySkus, null, true)

  // One entry per code and SKU, in the order found.
  const unique: FbaSendProblem[] = []
  const keys = new Set<string>()
  for (const p of problems) {
    const key = `${p.code}|${p.productId ?? ''}`
    if (keys.has(key)) continue
    keys.add(key)
    unique.push(p)
  }
  const blocking = unique.filter(p => p.blocking)
  return {
    skus: withUnits, units, cases, looseUnits,
    boxes: plan.boxCount, caseBoxes: plan.caseBoxes, mixedBoxes: plan.mixedBoxes, weightKg: plan.weightKg,
    plan,
    problems: unique,
    blocking,
    warnings: unique.filter(p => !p.blocking),
    primary: FBA_SEND_COPY.primary(units),
    held: blocking[0]?.message ?? null,
    mixedLine: plan.mixedBoxes > 0 ? FBA_SEND_COPY.mixedLine(plan.mixedBoxes, mixedBox) : null,
  }
}

/**
 * Every problem of this send, blocking ones and warnings, in the order a screen shows them: the whole plan first
 * (From, account, address, ready day, mixed box), then each SKU in line order, then "nothing to send" / "too many
 * SKUs". The dialog shows one Banner per `code`; the server refuses the create while any is `blocking`.
 */
export function sendProblems(draft: FbaSendDraft, choice: FbaSendChoice): FbaSendProblem[] {
  return evaluate(draft, choice).problems
}

/** The dialog's MetricStrip, primary button and mixed-box line — and the same verdict the server re-checks. */
export function sendSummary(draft: FbaSendDraft, choice: FbaSendChoice): FbaSendSummary {
  return evaluate(draft, choice)
}
