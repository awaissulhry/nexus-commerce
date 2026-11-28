import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'
import { browserAddress } from '../../../lib/api/browser-address' // F-OP-317: a line picture's local-store path through /api
// B-W2b-374: a typed line's options.
import type { PickBody } from '../quotes/record/configurator/api'
// F-OP-107 (B2): the three outcomes of pieces already cut beyond the new figures.
import type { ExtraOutcome } from '@nexus/factory-domain/order-apply/rules'
// F-OP-106: how a work order follows an office change, and the change's kind (factory-domain order-apply: B-OP-012 / B-OP-013).
import { APPLY_ROUTES } from '@nexus/factory-domain/order-apply/plan'
import { WORK_ORDER_CHANGE_KINDS, type ApplyRoute } from '@nexus/factory-domain/order-apply/rules'
import type { PromiseReasonCode } from '@nexus/factory-domain/sales/portal-orders/promise' // F-OO-142
import { styleRowSchema } from '../quotes/api' // F-OL-01: the style search of one order (Add a style)
import type { AcceptShortWhy } from '@nexus/factory-domain/sales/orders/money-plan' // F-OM-201 (S2 #1855)

/**
 * Every call of the sales order screens (SCR-038 list and board, SCR-039 the order studio), with the answer's shape
 * checked (zod; unknown fields are dropped, so a new API field never breaks a page). The shapes mirror apps/factory-api
 * modules/sales/orders, payments (deposit received, the DEPOSIT_INFO page), invoicing (an invoice's SDI state, the send,
 * the order's settlement) and production (the work orders of an order). Money fields are optional: the API drops what
 * the person's grains do not reach (absent, never zero). The API's English words (held reasons, missing words, SDI
 * titles) are never drawn: the screens say their own words from the codes.
 */

// B-TH-244: the customer's own mark on an order (apps/factory-api modules/sales/orders/customer-urgency).
export const CUSTOMER_URGENCIES = ['URGENT', 'REGULAR'] as const
export type CustomerUrgency = (typeof CUSTOMER_URGENCIES)[number]
// F-SA-213: the office's priority levels (as depth/api PRIORITY_LEVELS, which reads this file: kept here so no import goes round).
export const ORDER_PRIORITY_LEVELS = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const
export type OrderPriorityLevel = (typeof ORDER_PRIORITY_LEVELS)[number] // F-CW-105
// F-SA-214: why a waiting order waits (factory-domain sales/orders-depth WAIT_WORDS' codes, the row's `waits`).
export const WAIT_REASONS = ['REQUEST_PENDING', 'NO_REQUEST', 'CREDIT_HOLD', 'MEASUREMENTS'] as const
export type WaitReason = (typeof WAIT_REASONS)[number]
// ---- F-SA-275 (the API's B-SA-070, `production=true`): the production part of a row — factory-domain production-brand's codes ----
export { BRAND_STAGES, type BrandStage } from '@nexus/factory-domain/production-brand/stages'
export { BRAND_HEALTHS, type BrandHealth } from '@nexus/factory-domain/production-brand/health'
export { WAITING_ON, type WaitingOn } from '@nexus/factory-domain/production-brand/waiting'
export { SUPERVISOR_MARKS, type SupervisorMark } from '@nexus/factory-domain/production-brand/supervisor'
import { BRAND_STAGES as STAGES } from '@nexus/factory-domain/production-brand/stages'
import { BRAND_HEALTHS as HEALTHS } from '@nexus/factory-domain/production-brand/health'
import { WAITING_ON as WAITS } from '@nexus/factory-domain/production-brand/waiting'
import { SUPERVISOR_MARKS as MARKS } from '@nexus/factory-domain/production-brand/supervisor'
/** The parts a reader without workorders.view over the order does not get (null, named in `withheld`): the API's PRODUCTION_WITHHELD. */
export const PRODUCTION_WITHHELD = ['supervisorMark', 'openIssues'] as const
// ---- end F-SA-275
// ---- F-CW-101 (customer Work tab; the API's B-CW-001…003): the ONE phase of an order — the domain's rule, never re-written here ----
export { ORDER_PHASES, type OrderPhase } from '@nexus/factory-domain/production-brand/stages'
import { ORDER_PHASES as PHASES, type OrderPhase as Phase } from '@nexus/factory-domain/production-brand/stages'
// ---- end F-CW-101
// F-CW-102 (the API's B-CW-010): the customer's urgency as its chip says it (the Work orders column's own four states).
import { CUSTOMER_URGENCY_STATES } from '@nexus/factory-domain/production-brand/urgency-state'

// W2b-5 (B-W2b-281): PENDING_APPROVAL, an order waiting for a yes before it goes on (the domain's list, in its order).
// W2b-6 (B-W2b-372): DELIVERED, every shipment that left was delivered.
export const ORDER_STATUSES = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED', 'CLOSED', 'CANCELLED', 'PENDING_APPROVAL', 'DELIVERED'] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]
/** The board's lanes (closed and cancelled are counted beside them). */
// B-SA-012: the first lane is Waiting for approval (the domain's BOARD_LANES, in its order).
export const BOARD_LANES = ['PENDING_APPROVAL', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED'] as const satisfies readonly OrderStatus[]
export type BoardLane = (typeof BOARD_LANES)[number]
export const DEPOSIT_STATES = ['NOT_NEEDED', 'MISSING', 'OPEN', 'PAID', 'WAIVED'] as const
export type DepositState = (typeof DEPOSIT_STATES)[number]
export const DEPOSIT_REQUEST_STATUSES = ['OPEN', 'PAID', 'WAIVED', 'CANCELLED'] as const
export type DepositRequestStatus = (typeof DEPOSIT_REQUEST_STATUSES)[number]
// F-OM-103 (M3-B9): + CAPARRA_PENITENZIALE, the kind the DB stores (db/sales.prisma DepositKind): an order that carries one parses.
export const DEPOSIT_KINDS = ['ACCONTO', 'CAPARRA', 'CAPARRA_PENITENZIALE'] as const
export const LINK_STATES = ['LIVE', 'REVOKED', 'USED_UP', 'EXPIRED'] as const
export const ORDER_ACTIONS = ['changePromise', 'markReady', 'cancel', 'close'] as const
export type OrderAction = (typeof ORDER_ACTIONS)[number]
/** B-W2a-30: the record's daily actions (factory-domain sales/orders/daily DAILY_ORDER_ACTIONS). */
export const DAILY_ORDER_ACTIONS = ['amend', 'closeLines', 'reopenLines', 'copyAsQuote'] as const
export type DailyOrderAction = (typeof DAILY_ORDER_ACTIONS)[number]
/** The cancel's impact check: what stops it, what it changes, what it leaves behind (factory-domain IMPACT_CODES). */
export const IMPACT_CODES = [
  'STATE',
  'DRAFT_WORK_ORDERS',
  'SHIPMENT_IN_PREPARATION',
  'SHIPPED',
  'INVOICE_DRAFT',
  'INVOICE_ISSUED',
  'DEPOSITS_CANCELLED',
  'PAYMENT_STEPS_CANCELLED',
  'WORK_ORDERS_OPEN',
  'LEATHER_CUT',
  'STOCK_RESERVED',
  'PURCHASE_ORDERS',
  'DEPOSIT_PAID',
  'PAYMENT_STEPS_PAID',
] as const
export type ImpactCode = (typeof IMPACT_CODES)[number]
/** The payment schedule's steps and states (factory-domain sales/orders/schedule). */
export const MILESTONE_KINDS = ['DEPOSIT', 'BEFORE_SHIPPING', 'ON_DELIVERY', 'ON_INVOICE'] as const
export type MilestoneKind = (typeof MILESTONE_KINDS)[number]
export const MILESTONE_STATUSES = ['OPEN', 'PAID', 'WAIVED', 'CANCELLED'] as const
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number]
/** An amendment's line changes (factory-domain sales/amendments LINE_CHANGES). */
export const LINE_CHANGES = ['ADDED', 'REMOVED', 'CHANGED'] as const
export type LineChange = (typeof LINE_CHANGES)[number]
// B-W2b-323: + waitingForCustomer (a change the customer must accept: the order's reapprovalNeededAt).
// B-SA-012: + waitingForApproval (the board answer names it; its tile is drawn with the lane's words, F-SA-214).
export const TILE_KEYS = ['late', 'waitingForApproval', 'waitingForDeposit', 'inProduction', 'readyToShip', 'waitingForCustomer'] as const
export type TileKey = (typeof TILE_KEYS)[number]
// B-TH-225: the Invoiced column (factory-domain sales/orders/invoiced.ts INVOICED_STATES).
export const INVOICED_STATES = ['NONE', 'PART', 'ALL'] as const
export type InvoicedState = (typeof INVOICED_STATES)[number]
// ── F-CP-140 (customer page plan C2d; the API's B-CP-018): the price check of an order (factory-domain sales/brand-prices/match
// PRICE_MATCHES) — Equal, Not equal, No customer price yet ("No customer price yet" is never Equal) ──
export const PRICE_MATCHES = ['EQUAL', 'NOT_EQUAL', 'NO_BRAND_PRICE'] as const
export type PriceMatch = (typeof PRICE_MATCHES)[number]
// ── end F-CP-140 ──
export const SDI_STATE_CODES = ['DRAFT', 'NOT_SENT', 'SENDING', 'AT_SDI', 'DELIVERED', 'NOT_DELIVERED', 'REJECTED', 'ERROR'] as const
export type SdiStateCode = (typeof SDI_STATE_CODES)[number]
export const SDI_NEXT_ACTIONS = ['ISSUE', 'SEND', 'WAIT', 'FIX_AND_RESEND', 'SEND_AGAIN', 'CHECK_COPY', 'NONE'] as const
/** The settlement's missing codes (factory-domain invoicing/from-shipment/settlement SettlementGap). */
export const SETTLEMENT_GAPS = ['ORDER_CANCELLED', 'NOT_SHIPPED', 'NOT_INVOICED', 'OVER_INVOICED', 'NO_INVOICE', 'AT_SDI', 'DEPOSIT_NOT_DEDUCTED', 'DEPOSIT_NOT_INVOICED', 'BALANCE_DUE', 'REFUND_DUE'] as const
export const WORK_ORDER_STATUSES = ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CLOSED', 'CANCELLED'] as const
export const SHIPMENT_STATUSES = ['DRAFT', 'PACKED', 'SHIPPED', 'DELIVERED', 'RETURNED', 'CANCELLED'] as const
// B-W2b-369 (factory-domain invoicing/invoices, wave 49/57): TD05 the debit note, TD16-TD19 the self-invoices.
export const INVOICE_DOC_TYPES = ['TD01', 'TD02', 'TD04', 'TD24', 'TD05', 'TD16', 'TD17', 'TD18', 'TD19'] as const
export const INVOICE_STATUSES = ['DRAFT', 'ISSUED', 'SENT', 'DELIVERED', 'NOT_DELIVERABLE', 'REJECTED', 'ERROR'] as const

const instant = z.string()
const status = z.enum(ORDER_STATUSES)
const quoteRef = z.object({ id: z.string(), number: z.string(), versionId: z.string(), revision: z.number() })

// ---- the list and the board ------------------------------------------------------------------------------------------------

export const orderRowSchema = z.object({
  id: z.string(),
  number: z.string(),
  companyId: z.string(),
  partyId: z.string(),
  partyName: z.string(),
  customerRef: z.string().nullable(),
  /** B-SA-070b: the customer's own number of the order ("Your order 12"; absent or null: none given yet). */
  customerSeq: z.number().nullable().optional(),
  status,
  // F-CW-102 (the API's B-CW-012): `extraOpenDue` — the due day of an EXTRA deposit still open on an order that needs none (the state
  // stays NOT_NEEDED); a day, never an amount. Absent from an older answer.
  deposit: z.object({ state: z.enum(DEPOSIT_STATES), dueDate: z.string().nullable(), extraOpenDue: z.string().nullable().optional() }),
  /** F-CW-102 (the API's B-CW-011): a change waits for the customer's new yes; absent from an older answer. */
  reaccept: z.boolean().optional(),
  lineCount: z.number(),
  units: z.number(),
  shippedUnits: z.number(),
  orderDate: z.string(),
  requestedDate: z.string().nullable(),
  promiseDate: z.string().nullable(),
  daysLate: z.number().nullable(),
  currency: z.string(),
  netAmount: z.number().optional(),
  grossAmount: z.number().optional(),
  quote: quoteRef.nullable(),
  version: z.number(),
  updatedAt: instant,
  // ── B-TH-225 (TH-1a, picture 23): the sheet's Picture, Brand and Invoiced, and the ids each cell opens (B-TH-017) ──
  /** The first line's style and its main picture (fileId null: the placeholder; `small`: its ~320 px preview exists). */
  picture: z.object({ styleId: z.string(), styleCode: z.string(), styleName: z.string(), fileId: z.string().nullable(), contentType: z.string().nullable(), small: z.boolean() }).nullable().default(null),
  styleCount: z.number().default(0),
  /** The label on the garment: `own` = our own collection; a label the reader may not see has neither id nor name. */
  brands: z.array(z.object({ partyId: z.string().nullable(), name: z.string().nullable(), own: z.boolean() })).default([]),
  /** None / Part / All by pieces on issued invoices less issued credit notes; the amount only with the price grain. */
  invoiced: z.object({ state: z.enum(INVOICED_STATES), pieces: z.string(), toInvoice: z.number(), amount: z.number().optional() }).nullable().default(null),
  /** Only the doors the reader may open (null: no right, or nothing to open). */
  doors: z
    .object({
      quote: z.object({ id: z.string(), versionId: z.string() }).nullable(),
      depositInvoice: z.object({ id: z.string(), number: z.string().nullable() }).nullable(),
      deliveryNotes: z.object({ count: z.number(), only: z.object({ id: z.string(), number: z.string() }).nullable(), shipmentId: z.string().nullable() }).nullable(),
      invoices: z.object({ count: z.number(), only: z.object({ id: z.string(), number: z.string().nullable(), docType: z.string() }).nullable() }).nullable(),
    })
    .default({ quote: null, depositInvoice: null, deliveryNotes: null, invoices: null }),
  // ── end B-TH-225 ──
  // ── B-TH-244 (threads plan TH-4; N23, ORD-G08; the API's B-TH-059): the later columns (each absent from an older answer) ──
  /** Pieces it still owes (0 once shipped, closed or cancelled). */
  openUnits: z.number().optional(),
  /** Only when asked (`progress=true`): cut, sewn and finished of the pieces in work orders; null: none past draft yet. */
  // F-CW-102 (the API's B-CW-015): `ordered` — the pieces ordered (fees left out), the order page's base: "Sewn 152 of 244".
  progress: z.object({ inWork: z.number(), cut: z.number().nullable(), sewn: z.number().nullable(), finished: z.number().nullable(), ordered: z.number().optional() }).nullable().optional(),
  /** Received and still to pay (price grain: absent without it). */
  paid: z.number().optional(),
  balance: z.number().optional(),
  /** The sites that make it. */
  sites: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })).optional(),
  /** The office's own note (the customer never sees it). */
  internalNote: z.string().nullable().optional(),
  /** The ORDER_LATE_RISK rule calls it at risk: days left and the rule's threshold; null: not at risk. */
  atRisk: z.object({ daysLeft: z.number(), daysBeforePromise: z.number() }).nullable().optional(),
  /** The customer's own mark (read-only); null: none known. */
  customerUrgency: z.enum(CUSTOMER_URGENCIES).nullable().optional(),
  // ── end B-TH-244 ──
  /**
   * F-CW-102 (the API's B-CW-010): the same mark as its chip says it — URGENT with `urgentRank` (its place in the customer's OWN
   * urgent list, 1 first: never a place in our plan), ASKED (an "Urgent – asked" waits: `requestId` is that request), REGULAR, SET_BACK
   * (set to Regular by us); `locked`: we locked it at Regular. null: none counts (the order left production, or the customer's
   * urgency switch is off). Absent from an older answer: the chip falls back on `customerUrgency`.
   */
  customerUrgencyState: z.object({ state: z.enum(CUSTOMER_URGENCY_STATES), urgentRank: z.number().nullable(), locked: z.boolean(), requestId: z.string().nullable() }).nullable().optional(),
  /** F-SA-213: the office's own priority (its level; the API's words are not drawn: the screen says its own). */
  priority: z.object({ level: z.enum(ORDER_PRIORITY_LEVELS), number: z.number(), urgentReason: z.string().nullable() }).optional(),
  /** F-SA-214 (the API's B-SA-012): why a PENDING_APPROVAL order waits; null for every other order (absent from an older answer). */
  waits: z.array(z.enum(WAIT_REASONS)).nullable().optional(),
  /**
   * F-SA-221 (the API's B-SA-020): its made-to-measure units (null: none) — owed, waiting for the factory review, and the riders (the
   * first names and how many in all) only in the answer of a reader of measurements (null otherwise). Never a measurement.
   */
  madeToMeasure: z.object({ units: z.number(), waitingReview: z.number(), riders: z.object({ names: z.array(z.string()), count: z.number() }).nullable() }).nullable().optional(),
  /**
   * F-SA-275 (the API's B-SA-070): only when asked (`production=true`) — the keeper's stored state: the plain stage and since when,
   * the shown health, who it waits on and since when, a live work order of it on hold, the supervisor mark (Me / Someone else / Not
   * set: never a name) and the open production issues only with workorders.view over the order (else null, named in `withheld`),
   * and the customer requests still OPEN. Absent from an answer that was not asked for it.
   */
  production: z
    .object({
      stage: z.enum(STAGES).nullable(),
      stageSince: z.string().nullable(),
      health: z.enum(HEALTHS).nullable(),
      waitingOn: z.enum(WAITS).nullable(),
      since: z.string().nullable(),
      held: z.boolean(),
      supervisorMark: z.enum(MARKS).nullable(),
      openRequests: z.number(),
      openIssues: z.number().nullable(),
      // F-CW-102 (the API's B-CW-013, B-CW-014): the garments ready to ship now (released, on no shipment yet; 0 unless the order's
      // stage is current), and when its oldest open production issue was raised (null: none, or withheld with `openIssues`).
      // Both absent from an older answer.
      readyNow: z.number().optional(),
      openIssuesSince: z.string().nullable().optional(),
      withheld: z.array(z.enum(PRODUCTION_WITHHELD)),
      // F-MS-104 (the API's B-MS-006, R17): the stage it reads was set by hand and still stands (since when it was set; the order
      // page says who and why), the same for the list, the customer's Work tab and the export; null: the floor's; absent from an
      // answer before it. Never in a customer's answer.
      stageByHand: z.object({ since: z.string() }).nullable().optional(),
    })
    .optional(),
  // ── F-CP-140 (customer page plan C2d; the API's B-CP-018): the price check of the row — only in a price holder's answer (the price
  // grain: absent for everyone else, never zero, never "Equal"); our price is the row's netAmount ──
  /** The customer's price of the order, without VAT (minor units): its total, else the sum of its line prices; null: none yet. */
  brandPrice: z.number().nullable().optional(),
  /** Equal / Not equal / No customer price yet. */
  priceMatch: z.enum(PRICE_MATCHES).optional(),
  /** Our price − the customer's (+ we ask more); null: the customer's is not known. */
  priceDiff: z.number().nullable().optional(),
  /** How many lines differ ("Not equal · 2 lines"). */
  priceNotEqualLines: z.number().optional(),
  // F-OM-305 (B-OM-020, S3 #1857): a "Not equal" accepted by hand (in force) — the server's "Not equal" filter and counts leave it out.
  priceAccepted: z.boolean().optional(),
  // ── end F-CP-140 ──
})
export type OrderRow = z.infer<typeof orderRowSchema>

const pageSchema = z.object({ orders: z.array(orderRowSchema), nextCursor: z.string().nullable() })
export type OrderPage = z.infer<typeof pageSchema>

/** The list's filters as the API reads them (the page's address holds the same names). */
export interface OrderQuery {
  status?: OrderStatus | null
  open?: boolean
  late?: boolean
  deposit?: 'OPEN' | null
  /** B-W2b-323: only orders whose change waits for the customer to accept it. */
  reaccept?: boolean
  /** B-TH-201: one customer's orders (`?party=` on the page). */
  partyId?: string | null
  /** B-TH-225: the label on the garment (a brand party's id, or `own`), and one company (`?brand=`, `?company=`). */
  brand?: string | null
  companyId?: string | null
  // ── B-TH-057 (TH-4): the server sort (`customer`, `brand`, `promise`, `daysLate`, `ordered`, `-` the other way round) and the
  // custom field filter (`cf`), both terms of the page's address, so a saved view and the file keep them ──
  sort?: OrderSort | null
  cf?: string | null
  // ── B-TH-244 (TH-4: every total of the overall view opens exactly its rows): the door terms, the built-in view, progress ──
  invoiced?: InvoicedState | null
  atRisk?: boolean
  currency?: string | null
  customerUrgency?: CustomerUrgency | null
  /** The built-in view "Shipped, not invoiced". */
  shippedNotInvoiced?: boolean
  /** Count each row's production progress (only while the Progress column is shown: it reads the floor's records). */
  progress?: boolean
  // ── end B-TH-244 ──
  /** F-SA-221: made-to-measure orders only (`?kind=mtm`: the list, the board, the totals, the switcher's counts, the file). */
  kind?: 'mtm' | null
  /** F-SA-222: a rider's orders (`?profile=`: any revision of the rider's garment profile; sales.measurements.view only). */
  profile?: string | null
  /** F-SA-275: read each row's production part (only while a production column is shown: Where it is, Waiting on, Supervisor). */
  production?: boolean
  /** F-SA-276: the orders waiting on us (`?waiting=us`, the customer's Work tab's "Waiting on us"). */
  waiting?: 'us' | null
  /** F-SA-276: only these rows (≤ 50: a live read again of the rows in view, values in place). */
  ids?: readonly string[] | null
  // ── F-CP-141 (customer page plan C2d; the API's B-CP-018): the price check term — the list, its totals and its file read it (never
  // the board); a price holder's only (403 in words otherwise: the sheet never sends it for anyone else) ──
  priceMatch?: PriceMatch | null
  // ── end F-CP-141 ──
  // F-CW-101 (the API's B-CW-002): the orders in one phase (`?phase=`) — the list, its totals and its file read it; the board counts
  // every phase itself (`byPhase`), so it takes none (as it takes no status).
  phase?: Phase | null
  // F-CW-105 (lead settle S40; the API's B-CL-005): the orders at ONE of our priority levels (`?priority=`) — the list, its totals
  // and its file read it (a wrong value is refused: the sheet only ever sends a known level). Never the board. Office only.
  priority?: OrderPriorityLevel | null
  q?: string
  cursor?: string | null
  limit?: number
}

// ── B-TH-057: what the sheet sorts by on the server (apps/factory-api modules/sales/orders/sort.ts) ──
// F-CW-201 (the API's B-CW-030): + `urgent` — "Most urgent first" (our priority, then the customer's urgent order, then the promise
// date; the orders that left production follow, newest first). Office only.
export const ORDER_SORT_KEYS = ['customer', 'brand', 'promise', 'daysLate', 'ordered', 'urgent'] as const
export type OrderSortKey = (typeof ORDER_SORT_KEYS)[number]
export type OrderSort = OrderSortKey | `-${OrderSortKey}`
// ── end B-TH-057 ──

export function listOrders(api: ApiClient, query: OrderQuery, signal?: AbortSignal): Promise<OrderPage> {
  return api.get('/sales/orders', {
    query: {
      status: query.status ?? undefined,
      open: query.open ? 'true' : undefined,
      late: query.late ? 'true' : undefined,
      deposit: query.deposit ?? undefined,
      reaccept: query.reaccept ? 'true' : undefined, // B-W2b-323
      partyId: query.partyId ?? undefined, // B-TH-201
      brand: query.brand ?? undefined, // B-TH-225
      companyId: query.companyId ?? undefined, // B-TH-225
      sort: query.sort ?? undefined, // B-TH-057
      cf: query.cf?.trim() || undefined, // B-TH-057
      ...doorQueryOf(query), // B-TH-244
      progress: query.progress ? 'true' : undefined, // B-TH-244
      kind: query.kind ?? undefined, // F-SA-221
      profile: query.profile ?? undefined, // F-SA-222
      production: query.production ? 'true' : undefined, // F-SA-275
      waiting: query.waiting ?? undefined, // F-SA-276
      ids: query.ids?.length ? query.ids.join(',') : undefined, // F-SA-276
      priceMatch: query.priceMatch ?? undefined, // F-CP-141
      phase: query.phase ?? undefined, // F-CW-101
      priority: query.priority ?? undefined, // F-CW-105
      q: query.q?.trim() || undefined,
      cursor: query.cursor ?? undefined,
      limit: query.limit ?? 50,
    },
    schema: pageSchema,
    signal,
  })
}

export const boardSchema = z.object({
  byStatus: z.array(z.object({ status, count: z.number() })),
  // F-CW-101 (the API's B-CW-003): the seven phases in order, each with its count (0 as 0: they add up to byStatus), and the two exact
  // whys inside "Not sent to the factory". Optional: an older answer has neither (the band then groups by state: work-band.ts).
  byPhase: z.array(z.object({ phase: z.enum(PHASES), count: z.number() })).optional(),
  notSent: z.object({ waitsForYes: z.number(), waitsForDeposit: z.number() }).optional(),
  lanes: z.array(status),
  tiles: z.array(z.object({ key: z.enum(TILE_KEYS), count: z.number(), filter: z.record(z.string(), z.string()) })),
  asOf: instant,
})
export type OrderBoard = z.infer<typeof boardSchema>

/** The counts by state and the tiles (each the list's total under its filter), under the search. */
export function getBoard(api: ApiClient, q: string, signal?: AbortSignal, partyId?: string | null, narrow: { brand?: string | null; companyId?: string | null; cf?: string | null /* B-TH-057 */ } & Pick<OrderQuery, 'invoiced' | 'atRisk' | 'currency' | 'customerUrgency' | 'shippedNotInvoiced' /* B-TH-244 */ | 'kind' /* F-SA-221 */ | 'profile' /* F-SA-222 */ | 'waiting' /* F-SA-276 */> = {}): Promise<OrderBoard> {
  return api.get('/sales/orders/board', {
    query: { q: q.trim() || undefined, partyId: partyId ?? undefined /* B-TH-201 */, brand: narrow.brand ?? undefined, companyId: narrow.companyId ?? undefined /* B-TH-225 */, cf: narrow.cf?.trim() || undefined /* B-TH-057 */, ...doorQueryOf(narrow) /* B-TH-244 */, kind: narrow.kind ?? undefined /* F-SA-221 */, profile: narrow.profile ?? undefined /* F-SA-222 */, waiting: narrow.waiting ?? undefined /* F-SA-276 */ },
    schema: boardSchema,
    signal,
  })
}

// ── B-TH-244 (threads plan TH-4, SHEET-G08; features SHEET.overall-F02, -F03, -F08, -F11): the overall view's honest totals ──
/** The door terms of a query, as the API names them (an absent one never reaches it). */
function doorQueryOf(query: Pick<OrderQuery, 'invoiced' | 'atRisk' | 'currency' | 'customerUrgency' | 'shippedNotInvoiced'>): Record<string, string | undefined> {
  return {
    invoiced: query.invoiced ?? undefined,
    atRisk: query.atRisk ? 'true' : undefined,
    currency: query.currency ?? undefined,
    customerUrgency: query.customerUrgency ?? undefined,
    shippedNotInvoiced: query.shippedNotInvoiced ? 'true' : undefined,
  }
}

/** A number that opens its rows: the list's terms (the API's names) that read exactly what it counts; null: it counts nothing. */
const doorSchema = z.object({ count: z.number(), filter: z.record(z.string(), z.string()).nullable() })
export type SummaryDoor = z.infer<typeof doorSchema>
const figuresSchema = z.object({
  orders: doorSchema,
  pieces: z.object({ ordered: doorSchema, shipped: doorSchema, open: doorSchema }),
  late: doorSchema,
  atRisk: doorSchema,
  invoiced: z.object({ NONE: doorSchema, PART: doorSchema, ALL: doorSchema }),
  /** Per currency, never summed across (price grain: absent without it). */
  net: z.array(z.object({ currency: z.string(), amount: z.number(), filter: z.record(z.string(), z.string()).nullable() })).optional(),
})
export type SummaryFigures = z.infer<typeof figuresSchema>
const summarySchema = z.object({
  all: figuresSchema,
  groups: z.array(z.object({ partyId: z.string(), code: z.string(), name: z.string(), invoiceTiming: z.enum(['PER_SHIPMENT', 'MONTHLY']), figures: figuresSchema })).nullable(),
  limited: z.boolean(),
  asOf: instant,
})
export type OrderSummary = z.infer<typeof summarySchema>
export type SummaryGroup = NonNullable<OrderSummary['groups']>[number]

/** GET /sales/orders/summary: the view's figures for every order its terms keep (never the loaded rows), per customer with group. */
export function getOrderSummary(api: ApiClient, query: OrderQuery, group: 'party' | null, signal?: AbortSignal): Promise<OrderSummary> {
  return api.get('/sales/orders/summary', {
    query: {
      status: query.status ?? undefined,
      open: query.open ? 'true' : undefined,
      late: query.late ? 'true' : undefined,
      deposit: query.deposit ?? undefined,
      reaccept: query.reaccept ? 'true' : undefined,
      partyId: query.partyId ?? undefined,
      brand: query.brand ?? undefined,
      companyId: query.companyId ?? undefined,
      cf: query.cf?.trim() || undefined,
      ...doorQueryOf(query),
      kind: query.kind ?? undefined, // F-SA-221
      profile: query.profile ?? undefined, // F-SA-222
      waiting: query.waiting ?? undefined, // F-SA-276: the totals keep the same rows
      priceMatch: query.priceMatch ?? undefined, // F-CP-141: the totals keep the same rows
      phase: query.phase ?? undefined, // F-CW-101: the totals keep the same rows
      priority: query.priority ?? undefined, // F-CW-105: the totals keep the same rows
      q: query.q?.trim() || undefined,
      group: group ?? undefined,
    },
    schema: summarySchema,
    signal,
  })
}

/** Finance's From-DDTs dialog for chosen orders: one draft per customer and company (and month and currency), and what waits. */
const candidatesSchema = z.object({
  asOf: z.string(),
  drafts: z.array(
    z.object({
      partyId: z.string(),
      companyId: z.string(),
      code: z.string(),
      legalName: z.string(),
      month: z.string(),
      currency: z.string(),
      orders: z.array(z.object({ id: z.string(), number: z.string() })),
      ddts: z.array(z.object({ ddtId: z.string(), number: z.string() })),
      garments: z.string(),
      valueAmount: z.number().optional(),
      body: z.object({ ddtIds: z.array(z.string()) }),
    }),
  ),
  held: z.array(z.object({ orderId: z.string(), number: z.string(), reason: z.string() })),
})
export type InvoiceCandidates = z.infer<typeof candidatesSchema>

/** GET /invoicing/from-ddts/candidates?orderIds= (finance only): nothing is made here. */
export function fromDdtsCandidates(api: ApiClient, orderIds: readonly string[], signal?: AbortSignal): Promise<InvoiceCandidates> {
  return api.get('/invoicing/from-ddts/candidates', { query: { orderIds: orderIds.join(',') }, schema: candidatesSchema, signal })
}
// ── end B-TH-244 ──

// ── B-TH-226 (TH-1a, picture 24): the Customer switcher's customers (GET /sales/orders/customers, B-TH-019) ──
export const orderCustomerSchema = z.object({ id: z.string(), code: z.string(), name: z.string(), archived: z.boolean(), orders: z.number(), open: z.number(), late: z.number(), lastOrderDate: z.string().nullable() })
export type OrderCustomer = z.infer<typeof orderCustomerSchema>
const customersSchema = z.object({ customers: z.array(orderCustomerSchema), total: z.number(), limited: z.boolean().default(false), asOf: instant })
export type OrderCustomers = z.infer<typeof customersSchema>

/** The customers with orders the reader may see, most recent order first, with their open and late orders. */
export function listOrderCustomers(api: ApiClient, query: { q?: string; companyId?: string | null; kind?: 'mtm' | null /* F-SA-221 */; limit?: number }, signal?: AbortSignal): Promise<OrderCustomers> {
  return api.get('/sales/orders/customers', { query: { q: query.q?.trim() || undefined, companyId: query.companyId ?? undefined, kind: query.kind ?? undefined /* F-SA-221 */, limit: query.limit ?? 50 }, schema: customersSchema, signal })
}
// ── end B-TH-226 ──

// F-SA-212: the Picture cell's small previews are the one picture part's batch read (lib/record-picture/api.ts).

// ---- the record ----------------------------------------------------------------------------------------------------------

const progressSchema = z.object({
  ordered: z.number(),
  inWorkOrders: z.number(),
  made: z.number().nullable(),
  released: z.number(),
  shipped: z.number(),
  invoiced: z.string(),
  toShip: z.number(),
  /** B-W2a-30: pieces closed short (they will not be made or shipped). */
  closedShort: z.number().default(0),
  // ---- F-OS-102 (B-OS-002, optional until the server's S1 lands): of the pieces still to ship, those on a shipment that has not left
  // (DRAFT, PACKED) and those released and on no shipment (they could go today) — the SAME rule as Warehouse's backorder. Absent in an
  // older answer: the Shipments tab shows today's figure line and Create shipment… opens by today's rule (never a made-up 0).
  planned: z.number().optional(),
  readyNow: z.number().optional(),
  // ---- end F-OS-102
})
export type Progress = z.infer<typeof progressSchema>

export const orderLineSchema = z.object({
  id: z.string(),
  seq: z.number(),
  kind: z.string(),
  styleId: z.string(),
  style: z.object({ code: z.string(), name: z.string() }).nullable(),
  styleRevisionId: z.string().nullable(),
  styleRevision: z.object({ revision: z.number(), status: z.string() }).nullable(),
  colourwayId: z.string(),
  colourway: z.object({ code: z.string(), name: z.string() }).nullable(),
  measurementProfileId: z.string().nullable(),
  baseSize: z.string().nullable(),
  description: z.string().nullable(),
  note: z.string().nullable(),
  quantity: z.number(),
  unitPrice: z.string().optional(),
  netAmount: z.number().optional(),
  vatRatePct: z.string(),
  vatNature: z.string().nullable(),
  vatAmount: z.number().optional(),
  unitCost: z.string().nullable().optional(),
  costAmount: z.number().nullable().optional(),
  requestedDate: z.string().nullable(),
  promiseDate: z.string().nullable(),
  priority: z.number().nullable(),
  siteId: z.string().nullable(),
  /** B-W2a-30 (SAL-210): closed short — the pieces that will not be made or shipped, when, by whom, why; null: open. */
  /** B-W2b-16: `reasonCode` = the CANCEL reason code chosen at the close (null for a line closed before W2b). */
  closedShort: z.object({ quantity: z.number(), at: instant.nullable(), byId: z.string().nullable(), reason: z.string().nullable(), reasonCode: z.string().nullable().default(null) }).nullable().default(null),
  version: z.number(),
  sizes: z.array(z.object({ size: z.string().nullable(), quantity: z.number(), unitPrice: z.string().nullable().optional(), progress: progressSchema })),
  progress: progressSchema,
  // ── B-SA-035 / F-SA-232: the colour line's picture (the colourway's, else the style's main picture; files.read) with its small
  // preview's address (60 s), and the artwork files the reader may open. Absent in an older answer or a design case: no picture.
  // F-OP-317 (order page walk #22): the local store answers a path on the API (`/local-files?token=…`): opened through this app's
  // `/api` (browserAddress, as the batch picture read and the thread's previews do); a store's absolute address is used as it is.
  picture: z.object({ fileId: z.string(), contentType: z.string(), small: z.object({ url: z.string().transform(browserAddress), expiresAt: instant }).nullable() }).nullable().optional(),
  artworkCount: z.number().optional(),
  // ── end B-SA-035 / F-SA-232
  // ── B-SA-035b / F-SA-231b: the artwork files themselves (files.read; Lines opens them in the thread's ONE viewer), and a made-to-measure
  // line's rider, only with sales.measurements.view (null otherwise): name, garment type, revision — never a measurement.
  artwork: z.array(z.object({ fileId: z.string(), name: z.string(), contentType: z.string(), sizeBytes: z.number() })).optional(),
  rider: z.object({ profileId: z.string(), name: z.string(), garmentType: z.string(), revision: z.number() }).nullable().optional(),
  // F-OL-01: a charge line's kind (DEVELOPMENT, SAMPLE, TOOLING; not money) for the Lines tab's Charges block; absent: not read.
  feeKind: z.string().nullable().optional(),
})
export type OrderLine = z.infer<typeof orderLineSchema>

export const depositRequestSchema = z.object({
  id: z.string(),
  quoteVersionId: z.string().nullable(),
  orderId: z.string().nullable(),
  kind: z.enum(DEPOSIT_KINDS),
  depositPct: z.string().nullable(),
  currency: z.string(),
  amount: z.number().optional(),
  dueDate: z.string(),
  fiscalDocument: z.enum(['TD02', 'NONE']),
  fiscalRule: z.string(),
  status: z.enum(DEPOSIT_REQUEST_STATUSES),
  paidAt: instant.nullable(),
  createdAt: instant,
  paidAmount: z.number().optional(),
  // F-OM-202 (B-OM-022, S3 #1857): + the page's own id (Stop the page: POST /links/:linkId/revoke, links.manage); absent: no Stop door.
  link: z.object({ id: z.string().optional(), sentAt: instant, to: z.string().nullable(), expiresAt: instant, state: z.enum(LINK_STATES) }).nullable().default(null),
  /** B-W2a-F2: the schedule step the request pays — DEPOSIT, or BEFORE_SHIPPING (the balance before shipping, not the deposit). */
  stepKind: z.enum(['DEPOSIT', 'BEFORE_SHIPPING']).nullable().default(null),
  /** B-W2b-16: the owner's waive of a request no schedule step names is sent at it. */
  version: z.number().default(1),
})
export type DepositRequest = z.infer<typeof depositRequestSchema>

// ---- F-OP-101 (B-OP-020): one open request for a yes of the order, as the approval engine's list builds its row — who asked and
// who decides (by name; "me"), its version, whether the yes asks a fresh step-up, and the yes, the no and taking it back for this
// reader, each with the engine's why (never one's own yes, rule 42). No money facts.
const yesDecisionSchema = z.object({ allowed: z.boolean(), why: z.string().nullable() })
export const openApprovalSchema = z.object({
  taskId: z.string(),
  kind: z.string(),
  kindLabel: z.object({ en: z.string(), it: z.string() }),
  requestedAt: instant,
  requester: z.object({ name: z.string(), me: z.boolean() }),
  approver: z.object({ kind: z.enum(['ROLE', 'PERSON']), name: z.string(), me: z.boolean() }),
  version: z.number(),
  requireStepUp: z.boolean(),
  approve: yesDecisionSchema,
  reject: yesDecisionSchema,
  withdraw: yesDecisionSchema,
})
export type OpenApproval = z.infer<typeof openApprovalSchema>
// ---- end F-OP-101

// F-SA-239: who changed a part last — an office person or the order's own customer by name, "the floor", "Nexus" (it + en).
const lastChangeSchema = z.object({ by: z.object({ kind: z.enum(['OFFICE', 'CUSTOMER', 'FLOOR', 'SYSTEM']), name: z.string().nullable(), words: z.object({ it: z.string(), en: z.string() }) }), at: instant })

// ---- F-OM-102 (B-OM-002, optional until the server's S1 lands): the order's money by the ONE still-to-pay rule (the price grain;
// null without it) — the same figures the settlement's `thisOrder` reads, so a price holder without invoices.view reads the server's
// figure, never gross − deposits. Absent in an older answer: the tab shows what the settlement says, else the order total only.
const orderMoneySchema = z.object({
  stillToPay: z.number().optional(),
  paid: z.number().optional(),
  neverBilled: z.number().optional(),
  credited: z.number().optional(),
  /** This order's share of the small differences written off on its invoices (no longer owed). */
  writtenOff: z.number().optional(),
  depositsPaid: z.number().optional(),
})
export type OrderMoney = z.infer<typeof orderMoneySchema>
// ---- end F-OM-102

export const orderSchema = z.object({
  id: z.string(),
  number: z.string(),
  companyId: z.string(),
  partyId: z.string(),
  party: z.object({ code: z.string(), legalName: z.string() }).nullable(),
  customerRef: z.string().nullable(),
  /** B-SA-070b: the customer's own number of the order ("Your order 12"; absent or null: none given yet). */
  customerSeq: z.number().nullable().optional(),
  status,
  orderDate: z.string(),
  currency: z.string(),
  language: z.string(),
  taxMode: z.string(),
  priceBasis: z.enum(['NET', 'GROSS']),
  paymentTerms: z.string().nullable(),
  requestedDate: z.string().nullable(),
  promiseDate: z.string().nullable(),
  originalPromiseDate: z.string().nullable(),
  daysLate: z.number().nullable(),
  priority: z.number(),
  noWithdrawal: z.boolean(),
  depositRequired: z.boolean(),
  netAmount: z.number().optional(),
  vatAmount: z.number().optional(),
  grossAmount: z.number().optional(),
  costAmount: z.number().nullable().optional(),
  marginPct: z.string().nullable().optional(),
  cancelReason: z.string().nullable(),
  closedAt: instant.nullable(),
  version: z.number(),
  createdAt: instant,
  updatedAt: instant,
  createdById: z.string().nullable(),
  lines: z.array(orderLineSchema),
  progress: progressSchema,
  chain: z.object({
    quote: quoteRef.nullable(),
    // F-OC-203 (B-OC-016): the portal order this order was made from (its customer's own person who sent it); absent: not sent yet.
    portalOrder: z.object({ id: z.string(), number: z.string().nullable(), sentAt: z.string().nullable(), sentBy: z.string().nullable() }).nullable().optional(),
    depositRequests: z.array(depositRequestSchema),
    workOrders: z.array(z.object({ id: z.string(), number: z.string(), status: z.string(), siteId: z.string(), releasedAt: instant.nullable() })),
    shipments: z.array(
      z.object({
        id: z.string(),
        number: z.string(),
        status: z.string(),
        shippedAt: instant.nullable(),
        deliveredAt: instant.nullable(),
        // ---- F-OP-119 (B-OP-023): each shipment's detail for this reader — how it travels, the carrier and its tracking (shipping.view
        // over its site, else withheld), its live DDT, whether its tracking number may be typed here and why not ----
        version: z.number().optional(),
        transportBy: z.enum(['CARRIER', 'SENDER', 'RECIPIENT']).optional(),
        carrier: z.object({ code: z.string().nullable(), name: z.string().nullable() }).nullable().optional(),
        tracking: z
          .object({
            number: z.string().nullable(),
            source: z.enum(['TYPED', 'PARCELS']),
            parcels: z.array(z.object({ number: z.string(), url: z.string().nullable() })),
            live: z.boolean(),
            /** F-OP-135 (B-OP-034): the link typed beside the number ("Track ›", https only). */
            url: z.string().nullable().optional(),
          })
          .nullable()
          .optional(),
        expectedDeliveryAt: instant.nullable().optional(),
        ddt: z.object({ number: z.string(), date: z.string() }).nullable().optional(),
        mayTypeTracking: z.object({ allowed: z.boolean(), code: z.string().nullable(), why: z.string().nullable() }).optional(),
        withheld: z.array(z.string()).optional(),
        // ---- end F-OP-119
        // ---- F-OP-122 (B-OP-043, lines-derived): every order the shipment carries, the first first (all of this order's customer) ----
        orders: z.array(z.object({ id: z.string(), number: z.string(), customerRef: z.string().nullable() })).optional(),
        // ---- end F-OP-122
        // ---- F-OP-123 (B-OP-043 / B-OP-032): made elsewhere (recorded with its paper DDT; Nexus issued none) ----
        origin: z.enum(['NEXUS', 'ELSEWHERE']).optional(),
        externalDdt: z.object({ number: z.string(), date: z.string() }).nullable().optional(),
        // ---- end F-OP-123
        // ---- F-OS-103 (B-OS-001, optional until the server's S1 lands; codes are plain strings so a new code never breaks the read):
        // what it carries of THIS order (line × size, every state), the pieces of the other orders it carries, its holds in force, why
        // it was cancelled, the shipment it was split from / merged into, whether it needs a DDT, when it was packed, its parcels (with
        // shipping.view; a TEST label has no number), and what this reader may do on it. Absent: the tab hides what it would show.
        contents: z.array(z.object({ lineId: z.string(), size: z.string().nullable(), pieces: z.number() })).optional(),
        otherPieces: z.number().optional(),
        holds: z.array(z.object({ id: z.string().optional(), reason: z.string(), words: z.string().nullable(), bySystem: z.boolean(), placedAt: instant })).optional(),
        cancelReason: z.string().nullable().optional(),
        cancelledAt: instant.nullable().optional(),
        splitFrom: z.object({ id: z.string(), number: z.string(), reason: z.string().nullable() }).nullable().optional(),
        mergedInto: z.object({ id: z.string(), number: z.string() }).nullable().optional(),
        ddtRequired: z.boolean().optional(),
        packedAt: instant.nullable().optional(),
        // Each parcel: its number (a label's, or typed by hand after S3), and what it holds of THIS order (+ the other orders' pieces).
        parcels: z.array(z.object({ id: z.string(), seq: z.number(), number: z.string().nullable(), url: z.string().nullable(), source: z.string().nullable(), live: z.boolean(), contents: z.array(z.object({ lineId: z.string(), size: z.string().nullable(), pieces: z.number() })).optional(), otherPieces: z.number().optional(), /* F-OS-305 (os-fx3): "27.5000"; absent: not read */ grossWeightKg: z.string().nullable().optional() })).optional(),
        may: z.object({ manage: z.boolean(), pack: z.boolean(), ddt: z.boolean(), holdsManage: z.boolean().optional(), holdsRelease: z.boolean() }).optional(),
        // ---- end F-OS-103
        // ---- F-OS-305 (os-fx3, B-OS-001 / B-OS-022; optional — absent or null: hidden): the shipment's own delivery address (with
        // shipping.view; Split leaves it out of "another delivery address") and when the shipping notice last went to the customer.
        shipToAddressId: z.string().nullable().optional(),
        noticeSentAt: instant.nullable().optional(),
        // ---- end F-OS-305
      }),
    ),
    invoices: z.array(z.object({ id: z.string(), number: z.string().nullable(), docType: z.string(), status: z.string(), issueDate: z.string().nullable(), depositRequestId: z.string().nullable().default(null) })),
  }),
  // F-PT-204 (B-PT-011, optional): + SET (the first promise: never a move) or MOVED, and each line's own day before a lines' move.
  promiseHistory: z.array(z.object({ at: instant, actorId: z.string(), from: z.string().nullable(), to: z.string(), lineIds: z.array(z.string()), reason: z.string().nullable(), kind: z.enum(['SET', 'MOVED']).optional(), fromByLine: z.array(z.object({ lineId: z.string(), from: z.string().nullable() })).nullable().optional() })),
  people: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
  // B-OP-020 (B3): the words may name amounts, so they come only with the price grain; the page shows its own words per code.
  settlement: z.object({ settled: z.boolean(), missing: z.array(z.object({ code: z.string(), message: z.string().optional() })), source: z.string() }),
  actions: z.array(z.object({ action: z.enum(ORDER_ACTIONS), allowed: z.boolean(), needsReason: z.boolean(), held: z.string().nullable() })),
  // ---- B-W2a-30 (orders every day) --------------------------------------------------------------------------------------
  /** The library terms its payment schedule comes from. */
  paymentTermsId: z.string().nullable().default(null),
  /** An amendment changed the net total: the customer must accept the order again (the link is W2b, SAL-190). */
  reapprovalNeededAt: instant.nullable().default(null),
  /** Amend, close and reopen lines, copy as a new quote — each held by the API's rule (this app says its own words). */
  dailyActions: z.array(z.object({ action: z.enum(DAILY_ORDER_ACTIONS), allowed: z.boolean(), held: z.string().nullable() })).default([]),
  amendments: z.object({ count: z.number(), latestRevision: z.number().nullable(), latestAt: instant.nullable() }).default({ count: 0, latestRevision: null, latestAt: null }),
  /** SAL-209: a confirmed order's lines change only through an amendment. */
  locked: z.boolean().default(true),
  // ── F-SA-239 (B-SA-034): the page's live watch list (the server's) and who changed each part last; absent in an older answer ──
  live: z.object({ events: z.array(z.object({ type: z.string(), parts: z.array(z.string()) })), ids: z.record(z.string(), z.array(z.string())) }).optional(),
  lastChange: z
    .object({
      order: lastChangeSchema.nullable(),
      changes: lastChangeSchema.nullable(),
      work: lastChangeSchema.nullable(),
      shipments: lastChangeSchema.nullable(),
      money: lastChangeSchema.nullable(),
    })
    .optional(),
  // ── end F-SA-239
  // ---- F-OP-110: where the order ships now (the address as written on the order: name, street, town …); absent in an older answer.
  shipTo: z.record(z.string(), z.unknown()).nullable().optional(),
  // ---- F-OP-101 (B-OP-020): the order's open requests for a yes this reader may see (oldest first), and how many it may not see
  // (counted, never named); absent in an older answer.
  openApprovals: z.array(openApprovalSchema).optional(),
  openApprovalsHidden: z.number().optional(),
  // ---- end F-OP-101
  // ---- F-OO-208 (B-OO-013): the office's own note (the customer never reads it; the Orders sheet writes it) and the delivery terms
  // carried from the quote — the Incoterm, its place, ship complete. Read only; absent in an older answer.
  internalNote: z.string().nullable().optional(),
  incoterm: z.string().nullable().optional(),
  incotermPlace: z.string().nullable().optional(),
  shipComplete: z.boolean().optional(),
  // ---- end F-OO-208
  // F-OM-102 (B-OM-002): the order's money (price grain; null without it); absent in an older answer.
  money: orderMoneySchema.nullable().optional(),
  // ---- owb-of5 (owb-of1 step 4; PL-schema § 3): the order's picture (null: the first line's design) and Restrict on the floor (who,
  // when; null: open to the department). Optional: absent in an answer before of1.
  pictureFileId: z.string().nullable().optional(),
  restricted: z.object({ by: z.string(), at: z.string() }).nullable().optional(),
  // ---- end owb-of5
})
export type Order = z.infer<typeof orderSchema>
export type ChainInvoice = Order['chain']['invoices'][number]
export type ChainShipment = Order['chain']['shipments'][number]

const one = z.object({ order: orderSchema })
const orderPath = (id: string) => `/sales/orders/${encodeURIComponent(id)}`

export async function getOrder(api: ApiClient, id: string, signal?: AbortSignal): Promise<Order> {
  return (await api.get(orderPath(id), { schema: one, signal })).order
}

/** A new promise date with its reason, for the order or some of its lines (the first promise never changes). */
// F-OO-142 (B-OO-009): why = `reasonCode`, the curated reason the customer reads; `reason` = the office's own note (may be empty).
// F-OL-01: the reason is optional (ol-s1, B-OL-004: empty → the server writes its automatic words); so is the code.
export async function changePromise(api: ApiClient, id: string, body: { version: number; promiseDate: string; reasonCode?: PromiseReasonCode; reason?: string; lineIds?: string[] }): Promise<Order> {
  return (await api.request('PUT', `${orderPath(id)}/promise`, { body, schema: one, idempotencyKey: newIdempotencyKey() })).order
}

export async function markReady(api: ApiClient, id: string, body: { version: number; reason: string }): Promise<Order> {
  return (await api.post(`${orderPath(id)}/ready`, { body, schema: one, idempotencyKey: newIdempotencyKey() })).order
}


export async function closeOrder(api: ApiClient, id: string, body: { version: number; reason?: string | null }): Promise<Order> {
  return (await api.post(`${orderPath(id)}/close`, { body, schema: one, idempotencyKey: newIdempotencyKey() })).order
}

// ---- the deposit (payments) -------------------------------------------------------------------------------------------------

const linkAnswerSchema = z.object({
  link: z.object({ id: z.string(), expiresAt: instant, to: z.string(), revokedLinkIds: z.array(z.string()) }),
  emailId: z.string(),
  delivery: z.enum(['sent', 'failed', 'retry', 'settled', 'replayed']),
})
export type DepositLinkAnswer = z.infer<typeof linkAnswerSchema>

/** Mails the bank-details page (DEPOSIT_INFO link) to the quote's contact; older live pages of the address are revoked. */
// F-OM-202 (M3-B10): `contactId` — the customer's contact the page goes to (absent: the quote's contact, a typed order's invoices
// contact, as before).
export function sendDepositLink(api: ApiClient, depositRequestId: string, message: string | null, contactId?: string | null): Promise<DepositLinkAnswer> {
  return api.post(`/payments/deposit-requests/${encodeURIComponent(depositRequestId)}/link`, { body: { ...(message?.trim() ? { message: message.trim() } : {}), ...(contactId ? { contactId } : {}) }, schema: linkAnswerSchema, idempotencyKey: newIdempotencyKey() })
}

const invoiceRefSchema = z.object({ id: z.string(), number: z.string().nullable(), docType: z.string(), status: z.string(), issueDate: z.string().nullable() })

const depositReceivedSchema = z.object({
  payment: z.object({ id: z.string(), amount: z.number().optional(), receivedOn: z.string(), externalRef: z.string() }),
  depositRequest: z.object({ id: z.string(), status: z.string() }),
  depositInvoice: z.object({ required: z.boolean(), invoice: invoiceRefSchema.nullable(), filesPending: z.boolean() }),
})
export type DepositReceived = z.infer<typeof depositReceivedSchema>

/**
 * "Deposit received": records the bank transfer, places it on the request (never more than it still asks), marks it
 * PAID when covered, and issues the TD02 when the rule asks one and `issueDepositInvoice` is on (invoices.issue and a
 * fresh step-up: the API answers 403 `stepUp` first).
 */
export function recordDepositPayment(
  api: ApiClient,
  // F-OM-202 (P1-B1): + the reason the payment goes into a SOFT-locked month (asked when the API answers period/SOFT_LOCKED).
  body: { depositRequestId: string; amount: number; receivedOn: string; externalRef: string; internalNote?: string | null; issueDepositInvoice: boolean; periodLockOverride?: { reason: string } },
  idempotencyKey: string,
): Promise<DepositReceived> {
  return api.post('/payments/deposit-received', { body, schema: depositReceivedSchema, idempotencyKey })
}

// ---- invoices: the SDI state, the send, the settlement ---------------------------------------------------------------------

export const sdiSchema = z.object({
  invoiceId: z.string(),
  number: z.string().nullable(),
  issueDate: z.string().nullable(),
  invoiceStatus: z.string(),
  version: z.number(),
  state: z.object({ code: z.enum(SDI_STATE_CODES), next: z.object({ action: z.enum(SDI_NEXT_ACTIONS) }) }),
  canSend: z.boolean(),
  sends: z.array(z.object({ id: z.string(), attempt: z.number(), status: z.string(), sentAt: instant.nullable(), outcomeAt: instant.nullable() })),
})
export type SdiStatus = z.infer<typeof sdiSchema>

export async function getSdi(api: ApiClient, invoiceId: string, signal?: AbortSignal): Promise<SdiStatus> {
  return (await api.get(`/invoicing/invoices/${encodeURIComponent(invoiceId)}/sdi`, { schema: z.object({ sdi: sdiSchema }), signal })).sdi
}

/** Sends an issued invoice to SDI (invoices.issue and a fresh step-up). */
export async function sendToSdi(api: ApiClient, invoiceId: string, version: number, idempotencyKey: string): Promise<SdiStatus> {
  return (await api.post(`/invoicing/invoices/${encodeURIComponent(invoiceId)}/sdi/send`, { body: { version }, schema: z.object({ sdi: sdiSchema }), idempotencyKey })).sdi
}

/** F-OM-203 (B-OM-023): an invoice's payment in a word-code (factory-domain invoicing/from-shipment/settlement INVOICE_PAYMENT_STATES). */
export const INVOICE_PAYMENT_STATES = ['OPEN', 'PART_PAID', 'PAID', 'CREDITED', 'REFUND_DUE'] as const
export type InvoicePaymentState = (typeof INVOICE_PAYMENT_STATES)[number]

// ---- F-OM-fx3 (Money fix wave 3; the server's om-fx3s, B-OM-024 … 028): the new fields of the settlement and the plan read, each
// OPTIONAL — an older answer hides what it lacks (never a made-up 0, never a bare "—"). Amounts are the price grain's (absent without
// it); the words and states come to every reader of the part. Each schema is used once below, at its field (marked F-OM-fx3).
/** B-OM-024: an OPEN request with money on it and less than its amount: the missing part (price) and whether the company's write-off tolerance covers it. */
const fx3ShortSchema = z.object({ amount: z.number().optional(), withinTolerance: z.boolean() }).nullable().optional().catch(undefined)
/** B-OM-026: a deposit invoice's (TD02) or credit note's (TD04) payment as a word-code, no amount — every invoices.view reader. */
const fx3PaymentStateSchema = z.enum(INVOICE_PAYMENT_STATES).optional().catch(undefined)
/** B-OM-027: the deposit invoice (TD02) issued for one payment. */
const fx3Td02Schema = z.object({ id: z.string(), number: z.string().nullable() }).nullable().optional().catch(undefined)
/** B-OM-028: the TD02s a goods invoice deducts (the amount with the price grain) and the shipments it bills. */
const fx3DeductsSchema = z.array(z.object({ id: z.string(), number: z.string().nullable(), amount: z.number().optional() })).optional().catch(undefined)
const fx3ForShipmentsSchema = z.array(z.object({ id: z.string(), number: z.string() })).optional().catch(undefined)
/** B-OM-028: the goods' invoice that deducted a TD02, and the payment the TD02 was issued for. */
const fx3DeductedOnSchema = z.object({ id: z.string(), number: z.string().nullable() }).nullable().optional().catch(undefined)
const fx3ForPaymentSchema = z.object({ paymentId: z.string(), receivedOn: z.string() }).nullable().optional().catch(undefined)
/** B-OM-024: the company's write-off tolerance on the plan read (price grain; null: none set). */
const fx3ToleranceSchema = z.number().nullable().optional().catch(undefined)
// ---- end F-OM-fx3 (the schemas)

export const settlementSchema = z.object({
  settled: z.boolean(),
  gaps: z.array(z.string()),
  invoices: z.array(
    z.object({
      id: z.string(),
      docType: z.string(),
      number: z.string().nullable(),
      status: z.string(),
      grossTotal: z.number().optional(),
      paidAmount: z.number().optional(),
      openAmount: z.number().optional(),
      // ---- F-OP-118 (B-OP-022): this order's part of the invoice (price grain), the freight in no order, the other orders it bills
      // (the invoice's own buyer only: named when the reader reaches them, else counted) ----
      share: z.number().optional(),
      openShare: z.number().optional(),
      freight: z.number().optional(),
      otherOrders: z.array(z.object({ id: z.string(), number: z.string() })).optional(),
      otherOrdersHidden: z.number().optional(),
      // ---- end F-OP-118
      // F-OM-102 (B-OM-001): the small differences written off on it that still stand (price grain); its open amount is less them.
      writtenOffAmount: z.number().optional(),
      // F-OM-203: what its credit notes leave to give back to the customer (price grain; the settlement's own figure).
      refundDueAmount: z.number().optional(),
      // F-OM-203 (B-OM-023, S3 #1857): where its payment stands, in a word-code with no amount — for every invoices.view reader.
      paymentState: z.enum(INVOICE_PAYMENT_STATES).optional().catch(undefined),
      // F-OM-fx3 (B-OM-028): the TD02s it deducts and the shipments it bills.
      deducts: fx3DeductsSchema,
      forShipments: fx3ForShipmentsSchema,
    }),
  ),
  invoicedAmount: z.number().optional(),
  creditedAmount: z.number().optional(),
  paidAmount: z.number().optional(),
  balanceDueAmount: z.number().optional(),
  // F-OP-118 (B-OP-022): Money = this order's share, by the orders list's own rule (each figure with the price grain only).
  // F-OM-102 (B-OM-001): + this order's share of the small differences written off on its invoices.
  thisOrder: z.object({ paid: z.number().optional(), stillToPay: z.number().optional(), invoicedShare: z.number().optional(), depositsPaid: z.number().optional(), writtenOff: z.number().optional() }).optional(),
  // ---- F-OM-102 (optional, the server's S1): everything shipped / invoiced (the settlement's own facts), and B-OM-003 the
  // deposit invoices (TD02) and credit notes (TD04) of the order with their amounts (price grain) — absent: not named here.
  fullyShipped: z.boolean().optional(),
  fullyInvoiced: z.boolean().optional(),
  // F-OM-fx3 (B-OM-026, B-OM-028): + each one's payment word-code; a TD02's goods invoice that deducted it and the payment it was issued for.
  depositInvoices: z.array(z.object({ id: z.string(), number: z.string().nullable(), status: z.string(), issueDate: z.string().nullable(), gross: z.number().optional(), credited: z.number().optional(), deductedNet: z.number().optional(), depositRequestId: z.string().nullable(), paymentState: fx3PaymentStateSchema, deductedOn: fx3DeductedOnSchema, forPayment: fx3ForPaymentSchema })).optional(),
  creditNotes: z.array(z.object({ id: z.string(), number: z.string().nullable(), status: z.string(), issueDate: z.string().nullable(), gross: z.number().optional(), creditOfId: z.string().nullable(), paymentState: fx3PaymentStateSchema })).optional(),
  writtenOffAmount: z.number().optional(),
  // ---- end F-OM-102
})
export type Settlement = z.infer<typeof settlementSchema>

/** Where the order's money stands (invoices.view): invoiced, paid, the balance; each invoice's open amount. */
export async function getSettlement(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<Settlement> {
  return (await api.get(`/invoicing/orders/${encodeURIComponent(orderId)}/settlement`, { schema: z.object({ settlement: settlementSchema }), signal })).settlement
}

// ---- the order's work orders (production) -----------------------------------------------------------------------------------

export const orderWorkOrderSchema = z.object({
  id: z.string(),
  number: z.string(),
  status: z.enum(WORK_ORDER_STATUSES),
  styleCode: z.string(),
  styleName: z.string(),
  colourways: z.array(z.string()),
  siteCode: z.string(),
  pieces: z.number(),
  progress: z.object({ cut: z.number().nullable(), bundled: z.number().nullable(), sewn: z.number().nullable(), finished: z.number().nullable() }).nullable(),
  dueDate: z.string().nullable(),
  daysLate: z.number().nullable(),
})
export type OrderWorkOrder = z.infer<typeof orderWorkOrderSchema>

/** The work orders that make this order's lines (workorders.view), with their floor progress. */
export async function listOrderWorkOrders(api: ApiClient, salesOrderId: string, signal?: AbortSignal): Promise<OrderWorkOrder[]> {
  return (await api.get('/production/work-orders', { query: { salesOrderId, limit: 200 }, schema: z.object({ workOrders: z.array(orderWorkOrderSchema) }), signal })).workOrders
}

// ---- B-W2a-30: an order every day (manual entry, amendments, close lines, cancel with its impact, the schedule) ----------

const issueSchema = z.object({ path: z.string(), message: z.string() })
/** A refusal's place (`body/lines/2/sizes`): the screens say their own words by it, never the API's English. */
export type PathIssue = z.infer<typeof issueSchema>

/** A size as a manual order or an amendment sends it (a size at 0 leaves it out). */
export interface SizeInput {
  size: string
  quantity: number
}

/** A new line of a typed order: its style, colourway, size grid and (else the customer's list price) its unit price. */
export interface NewLineInput {
  styleId: string
  colourwayId: string
  sizes: SizeInput[]
  unitPrice?: string | null
  /** B-W2b-374 (XF3:02): the options chosen with the line (their surcharges join its price). */
  options?: PickBody[]
}

export interface ManualOrderBody {
  companyId: string
  partyId: string
  contactId?: string | null
  customerRef?: string | null
  requestedDate?: string | null
  promiseDate?: string | null
  internalNote?: string | null
  lines: NewLineInput[]
}

/** The number a new order will get (the company's SALES_ORDER series; nothing is allocated). */
export async function nextOrderNumber(api: ApiClient, companyId: string, signal?: AbortSignal): Promise<string | null> {
  return (await api.get('/sales/order-numbers/next', { query: { companyId }, schema: z.object({ number: z.string().nullable() }), signal })).number
}

const previewLineSchema = z.object({
  seq: z.number(),
  styleId: z.string(),
  colourwayId: z.string(),
  styleRevisionId: z.string().nullable(),
  description: z.string().nullable(),
  quantity: z.number(),
  sizes: z.array(z.object({ size: z.string(), quantity: z.number(), unitPrice: z.string().nullable().optional() })),
  unitPrice: z.string().optional(),
  netAmount: z.number().optional(),
  vatAmount: z.number().optional(),
  vatRatePct: z.string(),
  vatNature: z.string().nullable(),
  costAmount: z.number().nullable().optional(),
  /** B-W2b-374: what the line's options add a piece (net; already in its unit price); null: none. */
  optionsAdd: z.string().nullable().optional(),
})
export type PreviewLine = z.infer<typeof previewLineSchema>

export const scheduleStepPreviewSchema = z.object({ seq: z.number(), kind: z.enum(MILESTONE_KINDS), sharePct: z.string().nullable(), amount: z.number().optional(), dueDate: z.string().nullable() })

export const manualPreviewSchema = z.object({
  ok: z.boolean(),
  number: z.string().nullable(),
  problems: z.array(issueSchema),
  order: z
    .object({
      currency: z.string(),
      taxMode: z.string(),
      priceBasis: z.enum(['NET', 'GROSS']),
      language: z.string(),
      contactId: z.string().nullable(),
      paymentTermsId: z.string().nullable(),
      paymentTerms: z.string().nullable(),
      depositPct: z.string().nullable(),
      depositAmount: z.number().nullable().optional(),
      netAmount: z.number().optional(),
      vatAmount: z.number().optional(),
      grossAmount: z.number().optional(),
      costAmount: z.number().nullable().optional(),
      lines: z.array(previewLineSchema),
      schedule: z.array(scheduleStepPreviewSchema),
    })
    .nullable(),
})
export type ManualPreview = z.infer<typeof manualPreviewSchema>

/** Prices a typed order as it stands (nothing written): totals, the deposit, the schedule, the problems by place. */
export function previewManualOrder(api: ApiClient, body: ManualOrderBody, signal?: AbortSignal): Promise<ManualPreview> {
  return api.post('/sales/orders/manual/preview', { body, schema: manualPreviewSchema, signal })
}

/** "Confirm order": the typed order is made CONFIRMED in one command (its deposit request and schedule with it). */
export async function createManualOrder(api: ApiClient, body: ManualOrderBody, idempotencyKey: string): Promise<Order> {
  return (await api.post('/sales/orders/manual', { body, schema: one, idempotencyKey })).order
}

/**
 * An existing line as an amendment keeps it (its whole size grid; none: unchanged), or a new line. F-OP-109: its description and note
 * for production (none: unchanged; empty: cleared).
 */
export type AmendLineInput = ({ id: string; sizes?: SizeInput[]; unitPrice?: string | null } | NewLineInput) & { description?: string | null; note?: string | null }

export interface AmendBody {
  reason?: string
  customerRef?: string | null
  requestedDate?: string | null
  /**
   * Every line the order keeps (a line left out is removed). F-OL-01: optional (ol-s1, B-OL-020) — absent: every goods line as it is
   * (the Overview windows Customer PO and Ship to send `{ version, customerRef }` / `{ version, shipToAddressId }`).
   */
  lines?: AmendLineInput[]
  /** F-OL-01 (ol-s1, B-OL-005): ask the customer to accept the new order (the Review window's ONE tick); absent: the server's default. */
  askCustomer?: boolean
  /** F-OP-107 (B2): what happens to pieces already cut beyond the new figures (sent only when the preview names some). */
  extraOutcome?: ExtraOutcome | null
  /** F-OP-110 (B-OP-015): another delivery address of the order's customer (sent only when one is picked; it may move alone). */
  shipToAddressId?: string
}

// ---- F-OP-106 (order page N2; 13-backend §1.2–1.3, B-OP-012 / B-OP-013): what an office change does to the work orders ----
const saidWords = z.object({ it: z.string(), en: z.string() })
/** B-SA-042: pieces already cut beyond the new figures, by work-order cell (`needsOutcome`: an outcome is picked before Apply). */
export const extraPiecesSchema = z.object({
  extra: z.array(z.object({ workOrderSizeId: z.string(), salesOrderLineId: z.string(), size: z.string(), count: z.number(), words: saidWords })),
  needsOutcome: z.boolean(),
  words: saidWords.nullable(),
})
export type ExtraPiecesView = z.infer<typeof extraPiecesSchema>
/** How a work order follows an office change (B-OP-012's routes, factory-domain APPLY_ROUTES). */
export type FollowRoute = ApplyRoute
/**
 * B-OP-013 (daily-contract workOrderPlanView): one work order the change touches (or a new DRAFT), as the preview says it — its cells
 * from → to with what is cut, the pieces cut beyond the new figures, whether it follows in the same click (factory-domain
 * followDecisionOf, D1: a DRAFT for whoever may change the order, a released one with workorders.manage, a mixed one never) or waits
 * with why, and whether its traveller is reprinted. No id, number or status: a new DRAFT, or a work order this reader does not reach.
 * No route: it cannot be carried out now (`held` says why).
 */
export const workOrderPlanSchema = z.object({
  kind: z.enum(WORK_ORDER_CHANGE_KINDS),
  workOrderId: z.string().nullable(),
  number: z.string().nullable(),
  status: z.string().nullable(),
  route: z.enum(APPLY_ROUTES).nullable(),
  cells: z.array(z.object({ lineId: z.string(), size: z.string(), from: z.number(), to: z.number(), cut: z.number() })),
  extra: z.number(),
  appliesNow: z.boolean(),
  held: saidWords.nullable(),
  reprint: z.boolean(),
})
export type WorkOrderPlan = z.infer<typeof workOrderPlanSchema>
/** B-OP-013 (workOrderPreviewView): a preview's work orders — the extra pieces (B-SA-042) and the plan of each work order. */
export const workOrderPreviewSchema = extraPiecesSchema.extend({ plan: z.array(workOrderPlanSchema).default([]) })
export type WorkOrderPreview = z.infer<typeof workOrderPreviewSchema>
/** B-OP-012: the work-order changes an office change carried out in its own command, and those that wait (with why). */
export const followedSchema = z.object({
  applied: z.array(z.object({ changeId: z.string(), workOrderId: z.string().nullable(), number: z.string().nullable(), route: z.enum(APPLY_ROUTES), reprint: z.boolean() })),
  waiting: z.array(z.object({ changeId: z.string(), workOrderId: z.string().nullable(), number: z.string().nullable(), words: saidWords })),
})
export type Followed = z.infer<typeof followedSchema>
export const NOTHING_FOLLOWED: Followed = Object.freeze({ applied: [], waiting: [] }) as unknown as Followed
// ---- end F-OP-106

const diffSchema = z.object({
  lines: z.array(
    z.object({
      change: z.enum(LINE_CHANGES),
      lineId: z.string(),
      seq: z.number(),
      styleId: z.string(),
      colourwayId: z.string(),
      piecesBefore: z.number(),
      piecesAfter: z.number(),
      sizes: z.array(z.object({ size: z.string(), before: z.number(), after: z.number() })),
      priceChanged: z.boolean(),
      textChanged: z.boolean(),
      /** F-OP-109 (B-OP-014): a line left out while work orders make it — closed short (it stays on the order). */
      closedShort: z.boolean().optional(),
    }),
  ),
  header: z.array(z.object({ field: z.enum(['customerRef', 'requestedDate']), before: z.string().nullable(), after: z.string().nullable() })),
  prices: z.array(z.object({ lineId: z.string(), unitPrice: z.object({ before: z.string().nullable(), after: z.string().nullable() }).nullable().optional(), netBefore: z.number(), netAfter: z.number() })).optional(),
  netAmountBefore: z.number().optional(),
  netAmountAfter: z.number().optional(),
  grossAmountBefore: z.number().optional(),
  grossAmountAfter: z.number().optional(),
  reacceptanceNeeded: z.boolean(),
})
export type AmendmentDiff = z.infer<typeof diffSchema>

const snapshotSchema = z.object({
  header: z.object({ customerRef: z.string().nullable().optional(), requestedDate: z.string().nullable().optional(), netAmount: z.number().optional(), grossAmount: z.number().optional() }).passthrough(),
  lines: z.array(
    z.object({
      id: z.string(),
      seq: z.number(),
      styleId: z.string(),
      colourwayId: z.string(),
      quantity: z.number(),
      unitPrice: z.string().optional(),
      netAmount: z.number().optional(),
      closedShortQuantity: z.number().nullable().optional(),
      sizes: z.array(z.object({ size: z.string(), quantity: z.number(), unitPrice: z.string().nullable().optional() })),
    }),
  ),
})
export type OrderSnapshot = z.infer<typeof snapshotSchema>

export const amendmentSchema = z.object({
  id: z.string(),
  revision: z.number(),
  reason: z.string(),
  createdAt: instant,
  createdById: z.string().nullable(),
  createdBy: z.string().nullable(),
  reacceptance: z.enum(['NEEDED', 'NOT_NEEDED']),
  diff: diffSchema,
  /** The order before and after, frozen (price grain: absent without it). */
  before: snapshotSchema.optional(),
  after: snapshotSchema.optional(),
})
export type Amendment = z.infer<typeof amendmentSchema>

export const amendmentsSchema = z.object({ orderId: z.string(), number: z.string(), reapprovalNeededAt: instant.nullable(), amendments: z.array(amendmentSchema) })
export type AmendmentsAnswer = z.infer<typeof amendmentsSchema>

/** The Changes tab: every amendment, newest last as numbered, with its difference and snapshots (prices, never cost). */
export function listAmendments(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<AmendmentsAnswer> {
  return api.get(`${orderPath(orderId)}/amendments`, { schema: amendmentsSchema, signal })
}

export const amendPreviewSchema = z.object({
  ok: z.boolean(),
  revision: z.number(),
  version: z.number(),
  problems: z.array(issueSchema),
  diff: diffSchema.nullable(),
  // F-OP-106: the extra pieces it would leave (B-SA-042) and what each work order would do (B-OP-013, `workOrders.plan`).
  workOrders: workOrderPreviewSchema.nullable().default(null),
  // F-OL-01 (ol-s1, B-OL-005): the amount changes (every reader, not money) and it goes up (the price grain only; absent without it).
  amountChanges: z.boolean().optional(),
  totalUp: z.boolean().optional(),
})
export type AmendPreview = z.infer<typeof amendPreviewSchema>

/** What the amendment would change (F-OP-106: the "What changes" strip): lines old → new by size, the money change, re-acceptance, the work orders. */
export function previewAmendment(api: ApiClient, orderId: string, body: AmendBody & { version?: number }, signal?: AbortSignal): Promise<AmendPreview> {
  return api.post(`${orderPath(orderId)}/amendments/preview`, { body, schema: amendPreviewSchema, signal })
}

/**
 * "Apply amendment" with the order's version as read (a stale one: 409). F-OP-106: it applies at once (no yes is asked) and answers
 * the work orders that followed in the same command and those that wait (B-OP-012).
 */
// F-OL-01: `reason` optional (ol-s1, B-OL-004).
export function applyAmendment(api: ApiClient, orderId: string, body: AmendBody & { version: number; reason?: string }, idempotencyKey: string): Promise<{ order: Order; amendment: Amendment | null; workOrders: Followed }> {
  // B-OP-015: `amendment` is null when only the delivery address changed (it moved alone; no amendment is written).
  return api.post(`${orderPath(orderId)}/amendments`, { body, schema: z.object({ order: orderSchema, amendment: amendmentSchema.nullable(), workOrders: followedSchema.default(NOTHING_FOLLOWED) }), idempotencyKey })
}

const closeLinesSchema = z.object({
  order: orderSchema,
  closed: z.array(z.object({ lineId: z.string(), seq: z.number(), closedShortQuantity: z.number() })),
  reducesDone: z.array(z.string()),
  stillInWorkOrders: z.array(z.object({ lineId: z.string(), pieces: z.number() })),
  /** F-OP-107: the work orders that followed in the close's command, and those that wait (B-OP-012). */
  workOrders: followedSchema.default(NOTHING_FOLLOWED),
})
export type CloseLinesAnswer = z.infer<typeof closeLinesSchema>

/** "Close remaining lines": what is left of the lines named (none: every open line) will not be made or shipped. */
// F-OL-01: `reason` optional (ol-s1, B-OL-004).
export function closeLines(api: ApiClient, orderId: string, body: { version: number; reason?: string; reasonCode?: string; lineIds?: string[]; /* F-OP-107 */ extraOutcome?: ExtraOutcome }): Promise<CloseLinesAnswer> {
  return api.post(`${orderPath(orderId)}/close-lines`, { body, schema: closeLinesSchema, idempotencyKey: newIdempotencyKey() })
}

// ---- F-OP-107 (B2; 13-backend §1.3, B-OP-013): what closing these lines would do to the work orders, before the click ----
export const closePreviewSchema = z.object({
  /** The pieces already cut of them beyond what stays (their outcome is picked in the dialog) and each work order's plan. */
  workOrders: workOrderPreviewSchema.nullable().default(null),
})
export type ClosePreview = z.infer<typeof closePreviewSchema>

/** POST …/close-lines/preview (orders.manage; nothing written): each work order's plan and the extra pieces of the lines named. */
export function previewCloseLines(api: ApiClient, orderId: string, lineIds: readonly string[], signal?: AbortSignal): Promise<ClosePreview> {
  return api.post(`${orderPath(orderId)}/close-lines/preview`, { body: { lineIds: [...lineIds] }, schema: closePreviewSchema, signal })
}
// ---- end F-OP-107

/** "Reopen lines" (the close's reversal). */
// F-OL-01: `reason` optional (ol-s1, B-OL-004).
export function reopenLines(api: ApiClient, orderId: string, body: { version: number; reason?: string; lineIds?: string[] }): Promise<{ order: Order; reopened: string[] }> {
  return api.post(`${orderPath(orderId)}/reopen-lines`, { body, schema: z.object({ order: orderSchema, reopened: z.array(z.string()) }), idempotencyKey: newIdempotencyKey() })
}

const impactItemSchema = z.object({
  code: z.enum(IMPACT_CODES),
  message: z.string(),
  refs: z.array(z.object({ type: z.string(), id: z.string(), number: z.string().nullable() })),
  amount: z.number().nullable().optional(),
})
export type ImpactItem = z.infer<typeof impactItemSchema>
export const impactSchema = z.object({ cancellable: z.boolean(), blocks: z.array(impactItemSchema), touches: z.array(impactItemSchema), leavesBehind: z.array(impactItemSchema) })
export type Impact = z.infer<typeof impactSchema>

export const cancelCheckSchema = z.object({
  orderId: z.string(),
  number: z.string(),
  status,
  version: z.number(),
  impact: impactSchema,
  /** The leather cut for its work orders: hides and area in the hide's base unit (no money, no worker). */
  leatherCut: z.array(z.object({ workOrderId: z.string(), number: z.string(), hides: z.number(), area: z.string().nullable() })),
  // F-OP-107 (B-OP-013): the pieces already cut (their outcome picked before the cancel) and what each work order would do.
  workOrders: workOrderPreviewSchema.nullable().default(null),
})
export type CancelCheck = z.infer<typeof cancelCheckSchema>

/** The cancel's impact check: what stops it, what it changes, what it leaves behind. */
export function getCancelCheck(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<CancelCheck> {
  return api.get(`${orderPath(orderId)}/cancel-check`, { schema: cancelCheckSchema, signal })
}

/** "Cancel order" with the reason and the number typed to confirm it. */
export function cancelOrder(api: ApiClient, id: string, body: { version: number; reason: string; confirmNumber: string; /* F-OP-107 */ extraOutcome?: ExtraOutcome }): Promise<{ order: Order; paidDepositRequestIds: string[]; impact: Impact | null; workOrders: Followed }> {
  return api.post(`${orderPath(id)}/cancel`, { body, schema: z.object({ order: orderSchema, paidDepositRequestIds: z.array(z.string()), impact: impactSchema.nullable().default(null), /* F-OP-107 */ workOrders: followedSchema.default(NOTHING_FOLLOWED) }), idempotencyKey: newIdempotencyKey() })
}

// ---- F-OM-103 (B-OM-004, the server's S1 #1853; every field optional: an older answer hides what is not there, 15-steps "The web
// never waits"): the plan read — per step what was paid on its request so far, what settled it, what the goods' invoices covered of an
// on-delivery / on-invoice step, and the newest hand change that names it (the audit: who and when; the reason with the price grain);
// every request of the order (live and earlier) with its payments (payments.view; amounts with the price grain), the priced change it
// came from, the request that replaced it, an accepted short, and whether each payment may be undone (the server's words); the plan's
// still open and overdue (price grain). Amounts are minor units; `at` an instant, `dueDate` / `receivedOn` a day.
const byHandSchema = z.object({ act: z.string(), at: instant, by: z.string().nullable(), reason: z.string().nullable().optional() })
export type ByHand = z.infer<typeof byHandSchema>
const planPaymentSchema = z.object({
  paymentId: z.string(),
  allocationId: z.string(),
  receivedOn: z.string(),
  externalRef: z.string(),
  method: z.string(),
  amount: z.number().optional(),
  undo: z.object({ may: z.boolean(), why: z.object({ en: z.string(), it: z.string() }).nullable(), code: z.string().nullable().optional() }).optional(),
  td02: fx3Td02Schema, // F-OM-fx3 (B-OM-027): the deposit invoice issued for this payment
})
export type PlanPayment = z.infer<typeof planPaymentSchema>
const planRequestSchema = z.object({
  id: z.string(),
  milestoneId: z.string().nullable(),
  kind: z.string(),
  stepKind: z.string().nullable(),
  status: z.string(),
  amount: z.number().optional(),
  paid: z.number().optional(),
  dueDate: z.string().nullable(),
  paidAt: instant.nullable().optional(),
  fiscalDocument: z.string(),
  version: z.number().optional(),
  fromChange: z.object({ amendmentId: z.string(), revision: z.number() }).nullable().optional(),
  replacedBy: z.string().nullable().optional(),
  acceptedShort: z.object({ short: z.number().optional(), reason: z.string().nullable().optional(), why: z.string().nullable().optional(), at: instant.nullable().optional(), by: z.string().nullable() }).nullable().optional(),
  byHand: byHandSchema.nullable().optional(),
  payments: z.array(planPaymentSchema).optional(),
  short: fx3ShortSchema, // F-OM-fx3 (B-OM-024): short within the company's tolerance, or not
})
export type PlanRequest = z.infer<typeof planRequestSchema>
// ---- end F-OM-103 (the schemas; the fields below)

export const milestoneSchema = z.object({
  id: z.string(),
  seq: z.number(),
  kind: z.enum(MILESTONE_KINDS),
  label: z.string(),
  sharePct: z.string().nullable(),
  amount: z.number().optional(),
  dueDate: z.string().nullable(),
  depositRequestId: z.string().nullable(),
  status: z.enum(MILESTONE_STATUSES),
  paidAt: instant.nullable(),
  statusNote: z.string().nullable(),
  version: z.number(),
  // F-OM-103 (B-OM-004, optional): paid on its request so far · what settled it · what the goods' invoices covered · the hand change.
  paidSoFar: z.number().nullable().optional(),
  settledBy: z.enum(['PAYMENT', 'INVOICES']).nullable().optional(),
  coveredByInvoices: z.number().optional(),
  byHand: byHandSchema.nullable().optional(),
})
export type Milestone = z.infer<typeof milestoneSchema>

export const scheduleSchema = z.object({
  orderId: z.string(),
  number: z.string(),
  currency: z.string(),
  grossAmount: z.number().optional(),
  /** Empty: paid on invoice terms; no milestones. */
  steps: z.array(milestoneSchema),
  cancelled: z.array(milestoneSchema),
  openAmount: z.number().optional(),
  paidAmount: z.number().optional(),
  // F-OM-103 (B-OM-004, optional): every request of the order, the plan's still open and overdue (price grain).
  requests: z.array(planRequestSchema).optional(),
  stillOpen: z.number().optional(),
  overdue: z.number().optional(),
  tolerance: fx3ToleranceSchema, // F-OM-fx3 (B-OM-024): the company's write-off tolerance
})
export type Schedule = z.infer<typeof scheduleSchema>

// ---- F-OM-201 / 202 (B-OM-010 … 017, the server's S2; 13-backend §3): the plan's hand commands, ONE route and its preview, and the undo
// of a payment. Every answer is read leniently (an older server: the dialog says its words without the before → after).
//   POST /sales/orders/:orderId/money-plan            { act, reason, … }   (orders.moneyPlan; amount acts: + the price grain)
//   POST /sales/orders/:orderId/money-plan/preview    the same body, nothing written: the plan before → after
//   POST /payments/:paymentId/undo                    { depositRequestId, reason, periodLockOverride? }   (payments.record + void)
/** Why a deposit came in short (ACCEPT_SHORT): the domain's list (S2 #1855), bank charges first in the window. */
export const SHORT_WHYS = ['BANK_CHARGES', 'ROUNDING', 'OTHER'] as const satisfies readonly AcceptShortWhy[]
export type ShortWhy = AcceptShortWhy
/** A share (a percent string, "25") or an amount (minor units) — never both. */
export type ShareOrAmount = { readonly pct: string; readonly amount?: undefined } | { readonly amount: number; readonly pct?: undefined }
export type MoneyPlanBody = { readonly reason: string } & (
  | ({ readonly act: 'REPLACE_DEPOSIT'; readonly requestId: string; readonly version: number } & ShareOrAmount)
  | { readonly act: 'MOVE_DUE'; readonly milestoneId?: string; readonly requestId?: string; readonly version: number; readonly dueDate: string }
  // The version is the target's: the step's or the request's (ASK_AGAIN), the step it takes from (ADD_STEP), the order's (CHANGE_TERMS).
  | { readonly act: 'ASK_AGAIN'; readonly milestoneId?: string; readonly requestId?: string; readonly version: number; readonly dueDate: string }
  | ({ readonly act: 'ADD_STEP'; readonly kind: MilestoneKind; readonly from: string; readonly version: number; readonly dueDate?: string; readonly label?: string } & ShareOrAmount)
  | ({ readonly act: 'CHANGE_STEP'; readonly milestoneId: string; readonly version: number; readonly restTo: string } & ShareOrAmount)
  | { readonly act: 'REMOVE_STEP'; readonly milestoneId: string; readonly version: number; readonly restTo: string }
  | { readonly act: 'RENAME_STEP'; readonly milestoneId: string; readonly version: number; readonly label: string }
  | { readonly act: 'UNDO_OPEN'; readonly milestoneId: string; readonly version: number }
  | { readonly act: 'CHANGE_TERMS'; readonly paymentTermsId: string; readonly version: number }
  | { readonly act: 'ACCEPT_SHORT'; readonly requestId: string; readonly version: number; readonly why: ShortWhy }
)
export type MoneyPlanAct = MoneyPlanBody['act']
/** A step's or request's figures before or after the act (the amount with the price grain). */
const planFiguresSchema = z.object({ amount: z.number().optional(), dueDate: z.string().nullable(), status: z.string(), label: z.string().nullable() })
export type PlanFigures = z.infer<typeof planFiguresSchema>
const previewStepSchema = z.object({ id: z.string().nullable(), kind: z.enum(MILESTONE_KINDS), words: z.string(), before: planFiguresSchema.nullable(), after: planFiguresSchema })
/**
 * The act planned on the plan as it is now, nothing written: its refusal in words (EN / IT: the window says why before the click), or
 * the steps and requests before → after, what a remake cancels and adds, the short part (ACCEPT_SHORT), whether a fresh code follows.
 */
export const moneyPlanPreviewSchema = z.object({
  act: z.string(),
  refusal: z.object({ code: z.string(), words: z.object({ en: z.string(), it: z.string() }) }).nullable(),
  preview: z
    .object({
      steps: z.array(previewStepSchema),
      requests: z.array(z.object({ id: z.string().nullable(), before: planFiguresSchema.nullable(), after: planFiguresSchema })),
      remade: z.object({ cancelled: z.array(z.string()), added: z.array(z.object({ kind: z.enum(MILESTONE_KINDS), amount: z.number().optional(), dueDate: z.string().nullable() })) }),
      short: z.number().nullable().optional(),
      needsFreshCode: z.boolean(),
    })
    .nullable(),
})
export type MoneyPlanPreview = z.infer<typeof moneyPlanPreviewSchema>

/** The preview: the same body as the act (its reason too: the server's rule, 3–500), nothing written. */
export function previewMoneyPlan(api: ApiClient, orderId: string, body: MoneyPlanBody, signal?: AbortSignal): Promise<MoneyPlanPreview> {
  return api.post(`${orderPath(orderId)}/money-plan/preview`, { body, schema: moneyPlanPreviewSchema, signal })
}

/** The act, written once (its Idempotency-Key); it answers the plan read: the page reads the order and its parts again (null). */
export async function applyMoneyPlan(api: ApiClient, orderId: string, body: MoneyPlanBody, idempotencyKey: string): Promise<Order | null> {
  await api.post(`${orderPath(orderId)}/money-plan`, { body, schema: z.object({ changed: z.object({ act: z.string() }).passthrough().optional() }).passthrough(), idempotencyKey })
  return null
}

/** Undo one payment on a deposit request: its allocation reversed, the payment voided when it then pays nothing (B-OM-017). */
export async function undoDepositPayment(api: ApiClient, paymentId: string, body: { depositRequestId: string; reason: string; periodLockOverride?: { reason: string } }, idempotencyKey: string): Promise<void> {
  await api.post(`/payments/${encodeURIComponent(paymentId)}/undo`, { body, schema: z.object({}).passthrough(), idempotencyKey })
}
// ---- end F-OM-201 / 202

/**
 * F-OM-202 (B-OM-022, S3 #1857): Stop the page — the bank-details page sent to the customer stops working at once (links.manage: the
 * Owner only); the payment request stays open. The reason goes into the history.
 */
export async function stopDepositPage(api: ApiClient, linkId: string, body: { readonly reason: string }, idempotencyKey: string): Promise<void> {
  await api.post(`/links/${encodeURIComponent(linkId)}/revoke`, { body, idempotencyKey })
}

/** The order's payment schedule (the deposit and the balance steps with their state). */
export function getSchedule(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<Schedule> {
  return api.get(`${orderPath(orderId)}/schedule`, { schema: scheduleSchema, signal })
}

const copyAnswerSchema = z.object({
  quote: z.object({ id: z.string(), number: z.string().nullable().optional() }).passthrough(),
  /** What the copy left out (archived styles or colourways, sizes no longer offered): counted, never the API's words. */
  dropped: z.array(z.object({ seq: z.number(), size: z.string().nullable() })),
  warnings: z.array(z.string()),
})
export type CopyAnswer = z.infer<typeof copyAnswerSchema>

/** "Copy as new quote": a draft quote for the same customer with the order's lines (what is left out is counted). */
export function copyAsQuote(api: ApiClient, orderId: string): Promise<CopyAnswer> {
  return api.post(`${orderPath(orderId)}/copy-as-quote`, { body: {}, schema: copyAnswerSchema, idempotencyKey: newIdempotencyKey() })
}

// ---- B-W2b-16: the CANCEL reason list (the close's reason code) -----------------------------------------------------------

const reasonOption = z.object({ code: z.string(), labelIt: z.string(), labelEn: z.string(), needsDetail: z.boolean() })
export type CancelReason = z.infer<typeof reasonOption>

/** The active reasons of the CANCEL list, in order (signed in, no permission): why lines are closed short. */
export async function listCancelReasons(api: ApiClient, signal?: AbortSignal): Promise<CancelReason[]> {
  return (await api.get('/reasons', { query: { list: 'CANCEL' }, schema: z.object({ reasons: z.array(reasonOption) }), signal })).reasons
}

// ---- F-OP-111: Split into new orders… (POST /sales/orders/:id/split, orders.manage; the order's customer only) -----------------

/** One part as the split sends it: its lines (some sizes, or every piece), and where it differs from the order (else as the order). */
export interface SplitPartBody {
  lines: { lineId: string; sizes: SizeInput[] }[]
  shipToAddressId?: string
  customerRef?: string | null
  requestedDate?: string | null
  promiseDate?: string | null
}

export interface SplitBody {
  version: number
  reason?: string
  parts: SplitPartBody[]
}

const splitAnswerSchema = z.object({ order: orderSchema, amendment: z.object({ id: z.string(), revision: z.number() }), orders: z.array(z.object({ id: z.string(), number: z.string() })) })
export type SplitAnswer = z.infer<typeof splitAnswerSchema>

/** The parts become orders of their own (same customer, prices, terms and season; no deposit); the order keeps the rest. */
export function splitOrder(api: ApiClient, orderId: string, body: SplitBody, idempotencyKey: string): Promise<SplitAnswer> {
  return api.post(`${orderPath(orderId)}/split`, { body, schema: splitAnswerSchema, idempotencyKey })
}

const shipToAddressSchema = z.object({
  id: z.string(),
  kinds: z.array(z.string()),
  name: z.string().nullable(),
  line1: z.string(),
  postalCode: z.string(),
  city: z.string(),
  country: z.string(),
  status: z.string(),
  isDefaultShipTo: z.boolean(),
  approval: z.object({ status: z.string() }).nullable().optional(),
})
export type ShipToAddress = z.infer<typeof shipToAddressSchema>

/**
 * The order's customer's delivery addresses a part may ship to (GET /parties/:id, parties.view: the API's wall): active, SHIP_TO,
 * and ours or approved by us (one the customer added that waits for our check, or was refused, is never offered).
 */
export async function listShipToAddresses(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<ShipToAddress[]> {
  const { party } = await api.get(`/parties/${encodeURIComponent(partyId)}`, { schema: z.object({ party: z.object({ addresses: z.array(shipToAddressSchema) }) }), signal })
  return party.addresses.filter((address) => address.status === 'ACTIVE' && address.kinds.includes('SHIP_TO') && (!address.approval || address.approval.status === 'APPROVED'))
}
// ---- end F-OP-111

// ---- F-OP-116 (B-OP-025, R-12): Done on one of the order's own production tasks (Still to do), by the task's own right ----
/** POST /sales/orders/:orderId/still-to-do/tasks/:taskId/done {version}: its assignee or tasks.manage over its work order; else 403. */
export async function doneStillToDoTask(api: ApiClient, orderId: string, taskId: string, version: number, idempotencyKey: string = newIdempotencyKey()): Promise<{ id: string; status: string; version: number }> {
  return (await api.post(`${orderPath(orderId)}/still-to-do/tasks/${encodeURIComponent(taskId)}/done`, { body: { version }, schema: z.object({ task: z.object({ id: z.string(), status: z.string(), version: z.number() }) }), idempotencyKey })).task
}
// ---- end F-OP-116

// ---- F-OL-01 (Order LINES lane; ol-s1, B-OL-033): the style search of ONE order — our collection and this customer's own styles only
// (another customer's style answers as an unknown one: the brand wall), each active colourway saying whether the customer's price
// list prices it (`listPriced`; absent in an older answer: not known — never claimed either way). Add a style reads only this.
export const orderStyleRowSchema = styleRowSchema.extend({
  colourways: z.array(z.object({ id: z.string(), listPriced: z.boolean().optional() })).optional(),
})
export type OrderStyleRow = z.infer<typeof orderStyleRowSchema>

/** GET /product/styles?forOrder=<orderId>&q= (the order's company and customer are the API's; ≤ 20 rows). */
export async function findStylesForOrder(api: ApiClient, orderId: string, query: string, signal?: AbortSignal): Promise<OrderStyleRow[]> {
  const answer = await api.get('/product/styles', { query: { forOrder: orderId, q: query.trim() || undefined, limit: 20 }, schema: z.object({ styles: z.array(orderStyleRowSchema) }), signal })
  return answer.styles
}
// ---- end F-OL-01
