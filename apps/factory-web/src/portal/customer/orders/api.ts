import { z } from 'zod'
import { CUSTOMER_SHIPMENT_STATUSES, SHIPMENT_MILESTONES } from '@nexus/factory-domain/sales/portal-orders/shipments'
import { CUSTOMER_ORDER_STATUSES, MILESTONE_STATES, MILESTONES, ORDER_CHIPS } from '@nexus/factory-domain/sales/portal-orders/status'
import { customerRefOf } from '@nexus/factory-domain/sales/customer-numbers' // F-OC fx4: the party's own order number
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { browserAddress } from '../../../lib/api/browser-address' // F-OP-317
// F-PR-13: the production asks (B-PR-25), the freeze states and the sample kinds, as the API names them.
import { ASK_SAMPLE_KINDS, ASK_VERDICT_CODES } from '@nexus/factory-domain/sales/change-requests/rules'
// B-SA-046b: which pieces a design change is for.
import { DESIGN_APPLIES_TO, type DesignAppliesTo } from '@nexus/factory-domain/sales/change-requests/rules'
// B-SA-046c: an accepted request we are carrying out, or done.
import { REQUEST_FOLLOW_UPS } from '@nexus/factory-domain/sales/change-requests/rules'
import { FREEZE_STATES } from '@nexus/factory-domain/sales/order-changes/freeze'
import { PRODUCTION_REQUEST_KINDS } from '@nexus/factory-domain/production-brand/kinds'
import { PRODUCTION_SHARE_LEVELS } from '@nexus/factory-domain/production-brand/levels' // B-PR-40

/**
 * Every call of the customer's Orders & tracking (B-W2b-191, SCR-184; design portal.customer.orders), each answer checked
 * against the API's contracts: the orders (apps/factory-api modules/sales/portal-orders, B-W2b-175; F14's ETA and carrier
 * page), the change and cancel requests (modules/sales/change-requests, B-W2b-183; F14's cancel fee), the revised order to
 * re-confirm (platform/approvals-out, B-W2b-184: a REVISED_ORDER request answered in the portal), the order's documents
 * (modules/sales/portal-documents, B-W2b-178) and its deposit paid online on the FAKE provider (modules/payments/online,
 * B-W2b-185). Money comes in minor units and only with the price grain: the API leaves the key out for a role without
 * it, so every amount here is optional. Days are calendar days (`YYYY-MM-DD`), times UTC instants. Every write carries an
 * Idempotency-Key. The web reads only what it uses: a field the API adds never breaks the page.
 */

export { CUSTOMER_ORDER_STATUSES, CUSTOMER_SHIPMENT_STATUSES, MILESTONES, ORDER_CHIPS }
export type CustomerOrderStatus = (typeof CUSTOMER_ORDER_STATUSES)[number]
export type OrderChip = (typeof ORDER_CHIPS)[number]
export type CustomerShipmentStatus = (typeof CUSTOMER_SHIPMENT_STATUSES)[number]
export const isOrderChip = (value: unknown): value is OrderChip => typeof value === 'string' && (ORDER_CHIPS as readonly string[]).includes(value)

const words = z.object({ it: z.string(), en: z.string() })
export type Words = z.infer<typeof words>
const live = z.object({ events: z.array(z.string()) })
const pieces = z.object({ ordered: z.number(), shipped: z.number(), open: z.number() })
const named = z.object({ code: z.string(), name: z.string() })
// B-TH-303: the customer's own number of an order ("Your order 12"; null: none yet). The API always sends it; an older answer
// without it reads as none.
const yourNumber = z.object({ seq: z.number(), words }).nullable().optional()
export type OrderYourNumber = z.infer<typeof yourNumber>
/** A price: absent for a reader without the price grain. */
const price = z.number().nullable().optional()

// ── B-TH-246 (threads plan TH-4, SHEET-G10; Owner decision 13; wall W10, W17, W39): the customer's own sheet ──
/** A column the office ticked for the portal: every customer's portal fields and this customer's own (never another's). */
export const portalColumnSchema = z.object({
  columnId: z.string(),
  code: z.string(),
  type: z.string(),
  labelIt: z.string(),
  labelEn: z.string(),
  unit: z.string().nullable(),
  grain: z.string().nullable(),
  /** A list's values the rows use (null: not a list field). */
  options: z.array(z.object({ code: z.string(), labelIt: z.string(), labelEn: z.string() })).nullable(),
})
export type PortalColumn = z.infer<typeof portalColumnSchema>
/** One cell: the value as stored (money marked with its grain) and its words when the API says them. */
export const portalCellSchema = z.object({ value: z.unknown(), wordsIt: z.string().nullable(), wordsEn: z.string().nullable() })
export type PortalCell = z.infer<typeof portalCellSchema>
// ── end B-TH-246 ──

// ── the list ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export const orderRowSchema = z.object({
  /** ORDER, or REQUEST: a portal order request sent and not decided yet. */
  kind: z.enum(['ORDER', 'REQUEST']),
  id: z.string(),
  customerRef: z.string().nullable(),
  number: z.string().nullable(),
  // B-TH-303
  yourNumber,
  orderedOn: z.string().nullable(),
  status: z.enum(CUSTOMER_ORDER_STATUSES),
  words,
  promiseDate: z.string().nullable(),
  originalPromiseDate: z.string().nullable(),
  promiseMoved: z.boolean(),
  movedLately: z.boolean(),
  requestedDate: z.string().nullable(),
  pieces,
  netAmount: price,
  currency: z.string(),
  nextShipment: z
    .object({ id: z.string(), number: z.string(), status: z.enum(CUSTOMER_SHIPMENT_STATUSES), words, date: z.string().nullable(), carrierName: z.string().nullable(), expectedDeliveryAt: z.string().nullable().optional() })
    .nullable(),
  progressPercent: z.number().nullable(),
  /** B-TH-246: the row's cells of the portal columns, by column id (the sheet's read only). */
  values: z.record(z.string(), portalCellSchema).optional(),
})
export type OrderRow = z.infer<typeof orderRowSchema>

export const ordersSchema = z.object({
  asOf: z.string(),
  seesPrices: z.boolean(),
  chip: z.enum(ORDER_CHIPS),
  chips: z.array(z.object({ chip: z.enum(ORDER_CHIPS), count: z.number(), words })),
  count: z.number(),
  items: z.array(orderRowSchema),
  live,
  /** B-TH-246: the portal columns (the sheet's read only; the list's plain read has none). */
  columns: z.array(portalColumnSchema).optional(),
})
export type OrdersRead = z.infer<typeof ordersSchema>

/** A page of 50 (Owner answer L3), the next page by `offset`. */
export const PAGE_SIZE = 50

export const fetchOrders = (api: ApiClient, query: { chip?: OrderChip | null; q?: string | null; offset?: number; limit?: number }, signal?: AbortSignal): Promise<OrdersRead> =>
  api.get('/portal/sales-orders', {
    query: { chip: query.chip ?? undefined, q: query.q?.trim() ? query.q.trim() : undefined, limit: query.limit ?? PAGE_SIZE, offset: query.offset ?? 0 },
    schema: ordersSchema,
    signal,
  })

// ── B-TH-246: the customer's own sheet (GET /portal/sales-orders/sheet: the list's rows with the portal columns) ──
export const fetchSheet = (api: ApiClient, query: { chip?: OrderChip | null; q?: string | null; offset?: number; limit?: number }, signal?: AbortSignal): Promise<OrdersRead> =>
  api.get('/portal/sales-orders/sheet', {
    query: { chip: query.chip ?? undefined, q: query.q?.trim() ? query.q.trim() : undefined, limit: query.limit ?? PAGE_SIZE, offset: query.offset ?? 0 },
    schema: ordersSchema,
    signal,
  })

/**
 * "Download all (Excel)": the server writes the file in the customer's own scope (its rows and its columns only; never the office's
 * export job, Owner decision 13) — the view's chip and search, every row.
 */
export async function downloadSheet(api: ApiClient, query: { chip: OrderChip | null; q: string | null; format: 'XLSX' | 'CSV'; locale: 'it' | 'en' }): Promise<{ bytes: Uint8Array; fileName: string | null; contentType: string }> {
  let disposition: string | null = null
  let contentType = query.format === 'XLSX' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv;charset=utf-8'
  const bytes = await api.bytes('/portal/sales-orders/sheet/download', {
    query: { chip: query.chip ?? undefined, q: query.q?.trim() ? query.q.trim() : undefined, format: query.format, locale: query.locale },
    onHeaders: (headers) => {
      disposition = headers.get('content-disposition')
      contentType = headers.get('content-type') ?? contentType
    },
  })
  return { bytes, fileName: fileNameOf(disposition), contentType }
}

/** The file name a Content-Disposition names (RFC 6266: `filename*=UTF-8''…` first, else `filename="…"`), or null. */
export function fileNameOf(disposition: string | null): string | null {
  if (!disposition) return null
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition)
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim())
    } catch {
      return null
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition)
  return plain ? plain[1]!.trim() : null
}
// ── end B-TH-246 ──

const trackingEvent = z.object({ at: z.string(), status: z.string(), words, description: z.string().nullable(), location: z.string().nullable(), parcelSeq: z.number().nullable() })
export type TrackingEvent = z.infer<typeof trackingEvent>
const trackingLink = z.object({ url: z.string(), words })

export const inTransitSchema = z.object({
  asOf: z.string(),
  items: z.array(
    z.object({
      shipmentId: z.string(),
      number: z.string(),
      // fix-portal-numbers-1 (B-TH-303): the order by its PO and the customer's own number, never the office's series.
      order: z.object({ id: z.string(), customerRef: z.string().nullable(), yourNumber }),
      status: z.enum(CUSTOMER_SHIPMENT_STATUSES),
      words,
      carrierName: z.string().nullable(),
      shippedAt: z.string().nullable(),
      expectedDeliveryAt: z.string().nullable().optional(),
      trackingNumbers: z.array(z.string()),
      trackingLinks: z.array(z.object({ trackingNumber: z.string(), url: z.string(), words })).optional(),
      lastEvent: trackingEvent.nullable(),
    }),
  ),
  live,
})
export type InTransitRead = z.infer<typeof inTransitSchema>
export type InTransitRow = InTransitRead['items'][number]

export const fetchInTransit = (api: ApiClient, signal?: AbortSignal): Promise<InTransitRead> => api.get('/portal/sales-orders/in-transit', { schema: inTransitSchema, signal })

// ── one order ────────────────────────────────────────────────────────────────────────────────────────────────────────
const sizeRow = z.object({ size: z.string().nullable(), ordered: z.number(), shipped: z.number(), open: z.number(), closedShort: z.number(), unitPrice: z.string().nullable().optional() })

export const orderLineSchema = z.object({
  id: z.string(),
  seq: z.number(),
  kind: z.enum(['SIZE_GRID', 'MADE_TO_MEASURE']),
  style: named.nullable(),
  colourway: named.nullable(),
  description: z.string().nullable(),
  measurement: z.object({ riderName: z.string(), revision: z.number() }).nullable(),
  baseSize: z.string().nullable(),
  quantity: z.number(),
  unitPrice: z.string().nullable().optional(),
  netAmount: price,
  vatAmount: price,
  requestedDate: z.string().nullable(),
  promiseDate: z.string().nullable(),
  closedShort: z.object({ quantity: z.number(), on: z.string().nullable() }).nullable(),
  sizes: z.array(sizeRow),
  pieces,
})
export type OrderLine = z.infer<typeof orderLineSchema>

// B-OL-004: `reason` null — the office gave no reason (none is shown).
export const promiseMoveSchema = z.object({ on: z.string(), from: z.string().nullable(), to: z.string(), lines: z.array(z.number()), reason: z.object({ code: z.string(), words }).nullable() })
export type PromiseMoveRead = z.infer<typeof promiseMoveSchema>

export const depositSchema = z.object({ id: z.string(), kind: z.string(), status: z.string(), amount: price, currency: z.string(), dueDate: z.string(), paidAt: z.string().nullable() })
export type DepositRead = z.infer<typeof depositSchema>

export const milestoneSchema = z.object({ key: z.enum(MILESTONES), words, state: z.enum(MILESTONE_STATES), date: z.string().nullable(), expected: z.string().nullable(), current: z.boolean() })
export type OrderMilestone = z.infer<typeof milestoneSchema>

export const orderRecordSchema = z.object({
  asOf: z.string(),
  seesPrices: z.boolean(),
  order: z.object({
    id: z.string(),
    customerRef: z.string().nullable(),
    number: z.string(),
    // B-TH-303 (read for New order's "Reorder this line"; the order page shows it with B-TH-275)
    yourNumber,
    status: z.enum(CUSTOMER_ORDER_STATUSES),
    words,
    orderDate: z.string(),
    requestedDate: z.string().nullable(),
    promiseDate: z.string().nullable(),
    originalPromiseDate: z.string().nullable(),
    promiseMoved: z.boolean(),
    currency: z.string(),
    language: z.string(),
    shipTo: z.record(z.string(), z.unknown()),
    paymentTerms: z.string().nullable(),
    noWithdrawal: z.boolean(),
    depositRequired: z.boolean(),
    netAmount: price,
    vatAmount: price,
    grossAmount: price,
    reconfirmNeeded: z.boolean(),
    cancelledOn: z.string().nullable(),
    version: z.number(),
  }),
  milestones: z.array(milestoneSchema),
  promiseHistory: z.array(promiseMoveSchema),
  deposits: z.array(depositSchema),
  lines: z.array(orderLineSchema),
  pieces: pieces.extend({ closedShort: z.number() }),
  /** B-PR-40: the customer's own share level (C1); …/progress answers when shares(level, 'progress'). */
  productionLevel: z.enum(PRODUCTION_SHARE_LEVELS),
  shipments: z.object({ shown: z.number(), onTheWay: z.number() }),
  live,
})
export type OrderRecord = z.infer<typeof orderRecordSchema>

export const fetchOrder = (api: ApiClient, id: string, signal?: AbortSignal): Promise<OrderRecord> => api.get(`/portal/sales-orders/${encodeURIComponent(id)}`, { schema: orderRecordSchema, signal })

const stageFigures = { ordered: z.number(), cut: z.number().nullable(), sewn: z.number().nullable(), inspected: z.number().nullable(), packed: z.number().nullable() }
export const progressSchema = z.object({
  asOf: z.string(),
  refreshSeconds: z.number(),
  stages: z.array(z.object({ key: z.enum(['CUT', 'SEWN', 'INSPECTED', 'PACKED']), words })),
  lines: z.array(z.object({ lineId: z.string(), seq: z.number(), style: named.nullable(), colourway: named.nullable(), ...stageFigures, sizes: z.array(z.object({ size: z.string().nullable(), ...stageFigures })) })),
  whole: z.object(stageFigures),
  percent: z.number().nullable(),
})
export type ProgressRead = z.infer<typeof progressSchema>
export type ProgressStage = ProgressRead['stages'][number]['key']

/** Only while the customer shares progress (C1); otherwise 404 and the section is not drawn. */
export const fetchProgress = (api: ApiClient, id: string, signal?: AbortSignal): Promise<ProgressRead> => api.get(`/portal/sales-orders/${encodeURIComponent(id)}/progress`, { schema: progressSchema, signal })

export const shipmentSchema = z.object({
  id: z.string(),
  number: z.string(),
  status: z.enum(CUSTOMER_SHIPMENT_STATUSES),
  words,
  transportBy: z.string(),
  carrierName: z.string().nullable(),
  packedAt: z.string().nullable(),
  shippedAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  expectedDeliveryAt: z.string().nullable().optional(),
  // F-OP-124 (B-OP-031): the number typed for a carrier booked by hand (no carrier feeds it: "No live tracking").
  typedTrackingNumber: z.string().nullable().optional(),
  // F-OP-135 (B-OP-034): the tracking link typed beside it ("Track ›", https only).
  typedTrackingUrl: z.string().nullable().optional(),
  ddt: z.object({ number: z.string(), date: z.string() }).nullable(),
  milestones: z.array(z.object({ key: z.enum(SHIPMENT_MILESTONES), words, done: z.boolean(), at: z.string().nullable() })),
  parcels: z.array(z.object({ seq: z.number(), trackingNumber: z.string().nullable(), trackingLink: trackingLink.nullable().optional(), status: z.string().nullable(), words: words.nullable(), lastEvent: trackingEvent.nullable() })),
  events: z.array(trackingEvent),
  lines: z.array(z.object({ lineSeq: z.number(), style: named.nullable(), colourway: named.nullable(), size: z.string().nullable(), quantity: z.number() })),
  // F-OP-135 (B-OP-044): this customer's OWN other orders the shipment carries ("also N pieces of your order 12"); never another's.
  otherOrders: z.array(z.object({ yourNumber, customerRef: z.string().nullable(), pieces: z.number() })).optional(),
  papers: z.array(z.object({ fileId: z.string(), name: z.string(), contentType: z.string(), sizeBytes: z.number(), versionNo: z.number() })),
})
export type ShipmentRead = z.infer<typeof shipmentSchema>

export const shipmentsSchema = z.object({
  asOf: z.string(),
  shipments: z.array(shipmentSchema),
  stillToShip: z.array(z.object({ lineId: z.string(), seq: z.number(), style: named.nullable(), colourway: named.nullable(), size: z.string().nullable(), ordered: z.number(), shipped: z.number(), open: z.number(), expected: z.string().nullable() })),
  firstExpected: z.string().nullable(),
  live,
})
export type ShipmentsRead = z.infer<typeof shipmentsSchema>

export const fetchShipments = (api: ApiClient, id: string, signal?: AbortSignal): Promise<ShipmentsRead> => api.get(`/portal/sales-orders/${encodeURIComponent(id)}/shipments`, { schema: shipmentsSchema, signal })

// B-W2b-170: "Copy tracking link" — a link to our branded tracking page of one shipment, its address in this answer only.
const trackingLinkSchema = z.object({ link: z.object({ id: z.string(), expiresAt: z.string() }), url: z.string().nullable() })
export const makeTrackingLink = (api: ApiClient, orderId: string, shipmentId: string, idempotencyKey: string): Promise<z.infer<typeof trackingLinkSchema>> =>
  api.post(`/portal/sales-orders/${encodeURIComponent(orderId)}/shipments/${encodeURIComponent(shipmentId)}/tracking-link`, { body: {}, schema: trackingLinkSchema, idempotencyKey })

// ── change and cancel requests (B-W2b-183; portal.salesOrders.ask to ask, .view to read) ─────────────────────────────
export const VERDICT_CODES = ['FREE', 'NOT_ASKABLE', 'OPEN_REQUEST', 'STATUS', 'DAYS', 'MADE_TO_MEASURE', 'CLOSED_SHORT', 'CUT', 'LEATHER_CUT', 'WHOLE_ORDER_ONLY'] as const
export type VerdictCode = (typeof VERDICT_CODES)[number]
const verdict = z.object({ possible: z.boolean(), code: z.enum(VERDICT_CODES), day: z.string().nullable(), words })
export type Verdict = z.infer<typeof verdict>
const address = z.object({ id: z.string(), label: z.string() })

// ---- F-PR-13: what the rules say of a production ask now, and a freeze rule's verdict (never the rule) ----
const askVerdict = z.object({ possible: z.boolean(), code: z.enum(ASK_VERDICT_CODES).catch('NOT_ASKABLE'), day: z.string().nullable(), words })
export type AskVerdict = z.infer<typeof askVerdict>
const freeze = z.object({ state: z.enum(FREEZE_STATES).catch('OPEN'), words })
// ---- end F-PR-13

export const rulesSchema = z.object({
  asOf: z.string(),
  order: z.object({ id: z.string(), number: z.string(), customerRef: z.string().nullable(), status: z.string(), requestedDate: z.string().nullable(), promiseDate: z.string().nullable(), currency: z.string(), version: z.number() }),
  change: verdict,
  cancel: verdict,
  lines: z.array(
    z.object({
      lineId: z.string(),
      seq: z.number(),
      kind: z.enum(['SIZE_GRID', 'MADE_TO_MEASURE']),
      style: named.nullable(),
      colourway: named.nullable(),
      sizes: z.array(z.object({ size: z.string(), quantity: z.number(), offered: z.boolean() })),
      change: verdict,
      cancel: verdict,
      cancelFee: price,
      // F-PR-13 (B-PR-25): per size what the freeze rules hold now; whether the line may ship first and take each kind of sample.
      frozen: z.array(z.object({ size: z.string(), freeze })).optional(),
      split: askVerdict.optional(),
      samples: z.array(z.object({ sampleKind: z.enum(ASK_SAMPLE_KINDS), verdict: askVerdict })).optional(),
      // F-PR-23b (B-PR-27a #1626): the other colourways of the line's style a change may ask it in, each with the sizes it is made in.
      colourways: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), sizes: z.array(z.string()) })).optional(),
      // B-SA-046d: the line's small picture (the portal's own walled read: only the small preview's address; null: none to show).
      // F-OP-317 (order page walk #22): the local store's path through this app's `/api` (browserAddress), as the office reads do.
      picture: z.object({ small: z.object({ url: z.string().transform(browserAddress), expiresAt: z.string() }).nullable() }).nullable().optional(),
    }),
  ),
  cancelFee: z.object({ pct: z.string().nullable(), words, currency: z.string(), wholeOrderFee: price }).optional(),
  reasons: z.array(z.object({ code: z.string(), words, needsNote: z.boolean() })),
  addresses: z.array(address),
  noWithdrawal: words.nullable(),
  openRequestId: z.string().nullable(),
  // F-PR-13 (B-PR-25): the production asks — each open or not by the customer's limits (RUSH only while its urgency switch is on),
  // what the rules say of it now and the one that waits; what the freeze rules hold of the order's date and delivery address.
  asks: z.array(z.object({ kind: z.enum(PRODUCTION_REQUEST_KINDS), words, open: z.boolean(), verdict: askVerdict, waitingRequestId: z.string().nullable() })).optional(),
  frozen: z.object({ deliveryDate: freeze, shipTo: freeze }).optional(),
  // F-SA-246 (B-SA-046): the design change — open while the customer's ask-kinds switch lists it; the one that waits (one per order).
  design: z.object({ words, open: z.boolean(), verdict: askVerdict, waitingRequestId: z.string().nullable() }).optional(),
  live,
})
export type ChangeRules = z.infer<typeof rulesSchema>
export type RuleLine = ChangeRules['lines'][number]

export const fetchRules = (api: ApiClient, orderId: string, signal?: AbortSignal): Promise<ChangeRules> =>
  api.get(`/portal/sales-orders/${encodeURIComponent(orderId)}/change-requests/rules`, { schema: rulesSchema, signal })

// B-PR-23 (production plan, schema wave 4/5): COUNTERED (our counter-offer waits for the customer), and every kind of request on
// the order (the production asks beside CHANGE and CANCEL; the domain's ORDER_REQUEST_KINDS, kept equal by orders.vitest).
export const REQUEST_STATUSES = ['OPEN', 'ACCEPTED', 'REFUSED', 'WITHDRAWN', 'COUNTERED'] as const
export type RequestStatus = (typeof REQUEST_STATUSES)[number]
// B-SA-046: + DESIGN (a design change of some lines), in the domain's order.
export const REQUEST_KINDS = ['CHANGE', 'CANCEL', 'DESIGN', 'RUSH', 'HOLD', 'RESUME', 'SPLIT_SHIPMENT', 'SAMPLE_ROUND'] as const

export const changeRequestSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  orderNumber: z.string(),
  customerRef: z.string().nullable(),
  kind: z.enum(REQUEST_KINDS),
  kindWords: words,
  status: z.enum(REQUEST_STATUSES),
  words,
  askedAt: z.string(),
  cells: z.array(z.object({ lineId: z.string(), seq: z.number(), style: named.nullable(), colourway: named.nullable(), size: z.string().nullable(), before: z.number(), asked: z.number() })),
  wholeOrder: z.boolean(),
  requestedDate: z.string().nullable(),
  shipTo: address.nullable(),
  reasonCode: z.string().nullable(),
  reasonWords: words.nullable(),
  note: z.string().nullable(),
  answer: z.string().nullable(),
  answeredAt: z.string().nullable(),
  withdrawnAt: z.string().nullable(),
  cancelFee: z.object({ pct: z.string().nullable(), words, currency: z.string(), totalFee: price }).nullable().optional(),
  // F-PR-13 (B-PR-26): our counter-offer on it (answered in Waiting for you; never the amount without the price grain).
  counter: z.object({ approvalRequestId: z.string(), state: z.enum(['WAITING', 'AGREED', 'REFUSED', 'LAPSED']).catch('WAITING'), priced: z.boolean(), date: z.string().nullable(), words }).nullable().optional(),
  // F-SA-246 (B-SA-046): the files a design change sent (none on any other kind).
  fileIds: z.array(z.string()).optional(),
  // B-SA-046b: of the impact kept at Send, only which pieces a design change is for (the rest is not read here).
  impact: z.object({ appliesTo: z.enum(DESIGN_APPLIES_TO).nullable().optional() }).nullable().optional(),
  version: z.number(),
  mine: z.boolean(),
  // B-SA-046c: an accepted request: CARRYING_OUT while a step of it is still to do on our side, DONE once none (null or left out:
  // not accepted, or an older answer). A code only: never a step, a work order or a name.
  followUp: z.enum(REQUEST_FOLLOW_UPS).nullable().optional(),
})
export type ChangeRequest = z.infer<typeof changeRequestSchema>

export const requestsSchema = z.object({ asOf: z.string(), items: z.array(changeRequestSchema), live })
export const fetchRequests = (api: ApiClient, orderId: string, signal?: AbortSignal) =>
  api.get(`/portal/sales-orders/${encodeURIComponent(orderId)}/change-requests`, { schema: requestsSchema, signal })

export interface ChangeBody {
  readonly kind: 'CHANGE'
  readonly cells: readonly { lineId: string; size: string; quantity: number }[]
  readonly requestedDate?: string | null
  readonly shipToAddressId?: string | null
  readonly note?: string | null
  /** F-PR-23b (B-PR-27a): a line in another colourway of its style (its sizes as the cells ask, else as they are). */
  readonly colourways?: readonly { lineId: string; colourwayId: string }[]
}
export interface CancelBody {
  readonly kind: 'CANCEL'
  /** None: the whole order. */
  readonly lineIds?: readonly string[]
  readonly reasonCode: string
  readonly note?: string | null
}

// ---- F-PR-13 (B-PR-25): a production ask — the kinds the customer's limits open — and the impact of any ask before Send ----
export type ProductionAskKind = (typeof PRODUCTION_REQUEST_KINDS)[number]
export type AskSampleKind = (typeof ASK_SAMPLE_KINDS)[number]
export interface ProductionAskBody {
  readonly kind: ProductionAskKind
  /** SPLIT_SHIPMENT: the first part, the pieces of each size that should ship first. */
  readonly cells?: readonly { lineId: string; size: string; quantity: number }[]
  /** RUSH: the date it is needed by; SPLIT_SHIPMENT: the first part's date. */
  readonly requestedDate?: string | null
  /** SAMPLE_ROUND: the line and the kind of round. */
  readonly lineId?: string | null
  readonly sampleKind?: AskSampleKind | null
  /** Their words (HOLD: why — required). */
  readonly note?: string | null
}
// ---- F-SA-246 (B-SA-046): a design change — their words (required), the lines it is for, up to 10 files of the order shared with
// them (each the order's own, AVAILABLE: a file still held for the virus scan is refused "File not found."). No date, no address.
export interface DesignAskBody {
  readonly kind: 'DESIGN'
  readonly lineIds: readonly string[]
  readonly note: string
  readonly fileIds?: readonly string[]
  /** B-SA-046b: the pieces not started yet (left out: the default) or also the pieces already made (rework may cost). */
  readonly appliesTo?: DesignAppliesTo
}
// ---- end F-SA-246
export type AskBody = ChangeBody | CancelBody | ProductionAskBody | DesignAskBody /* F-SA-246 */

/** The impact of an ask (B-PR-24/25): what is frozen, priced or not (never an amount), the earliest date (a date only), notes. */
export const askImpactSchema = z.object({
  kind: z.enum(REQUEST_KINDS),
  frozen: z.array(z.object({ field: z.string(), lineId: z.string().nullable(), line: z.string().nullable(), size: z.string().nullable(), state: z.enum(['CHANGE_REQUEST', 'BLOCKED']).catch('CHANGE_REQUEST'), words })),
  blocked: z.boolean(),
  priced: z.boolean(),
  earliest: z.object({ date: z.string().nullable(), partial: z.boolean(), meetsWanted: z.boolean().nullable() }).nullable(),
  notes: z.array(words),
  // B-SA-046b: a design change: which pieces it is for, as chosen before Send (null or left out: another kind, or kept before it).
  appliesTo: z.enum(DESIGN_APPLIES_TO).nullable().optional(),
})
export type AskImpact = z.infer<typeof askImpactSchema>
/** The impact read: a cancel's fee only for a reader with the price grain (else left out). */
export const impactReadSchema = z.object({ asOf: z.string(), impact: askImpactSchema, cancelFee: z.object({ currency: z.string(), totalFee: price }).optional() })
export type ImpactRead = z.infer<typeof impactReadSchema>

/** POST …/change-requests/impact — the same checks as Send, nothing written. */
export const fetchImpact = (api: ApiClient, orderId: string, body: AskBody, signal?: AbortSignal): Promise<ImpactRead> =>
  api.post(`/portal/sales-orders/${encodeURIComponent(orderId)}/change-requests/impact`, { body, schema: impactReadSchema, ...(signal ? { signal } : {}) })
// ---- end F-PR-13

const oneRequest = z.object({ request: changeRequestSchema })
// F-PR-13: every kind (the production asks beside change and cancel).
export const askRequest = (api: ApiClient, orderId: string, body: AskBody, idempotencyKey: string = newIdempotencyKey()) =>
  api.post(`/portal/sales-orders/${encodeURIComponent(orderId)}/change-requests`, { body, schema: oneRequest, idempotencyKey })

// ---- F-SA-246 (R6; 14-change-flow §2.4): a design change's files from the device go through the order's conversation's own
// upload route (the portal composer's: `/portal/threads/SalesOrder/:orderId/files`, portal.comment) — announced, PUT to the store,
// completed; the file is the order's own, shared with the customer, and stays closed until the virus scan says it is clean (the
// API answers its sentence while uploads from outside are closed). The ask then names the sent ones.
const presigned = z.object({ method: z.enum(['PUT', 'GET']), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.string() })
const orderUpload = z.object({ id: z.string(), originalName: z.string(), kind: z.string(), sizeBytes: z.number(), status: z.string() })
export type OrderUpload = z.infer<typeof orderUpload>
const orderFilesPath = (orderId: string) => `/portal/threads/SalesOrder/${encodeURIComponent(orderId)}/files`

/** What a file announces: its name, type, size and SHA-256. */
export interface OrderFileAnnounce {
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
}

export const announceOrderFile = (api: ApiClient, orderId: string, body: OrderFileAnnounce, idempotencyKey: string = newIdempotencyKey()) =>
  api.post(orderFilesPath(orderId), { body: { ...body }, schema: z.object({ file: orderUpload, upload: presigned }), idempotencyKey })

export const completeOrderFile = (api: ApiClient, orderId: string, fileId: string, idempotencyKey: string = newIdempotencyKey()): Promise<OrderUpload> =>
  api.post(`${orderFilesPath(orderId)}/${encodeURIComponent(fileId)}/complete`, { body: {}, schema: z.object({ file: orderUpload }), idempotencyKey }).then((answer) => answer.file)
// ---- end F-SA-246

export const withdrawRequest = (api: ApiClient, orderId: string, requestId: string, version: number) =>
  api.post(`/portal/sales-orders/${encodeURIComponent(orderId)}/change-requests/${encodeURIComponent(requestId)}/withdraw`, { body: { version }, schema: oneRequest, idempotencyKey: newIdempotencyKey() })

// ── the revised order to re-confirm (B-W2b-184: a REVISED_ORDER approval request, answered in the portal) ───────────────
export const APPROVAL_STATUSES = ['OPEN', 'APPROVED', 'APPROVED_WITH_CHANGES', 'REFUSED', 'WITHDRAWN', 'EXPIRED'] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

export const approvalsListSchema = z.object({
  state: z.enum(['OPEN', 'DONE']),
  items: z.array(z.object({ id: z.string(), kind: z.string(), dueAt: z.string(), status: z.string() })),
})

const revisedLine = z.object({
  change: z.enum(['ADDED', 'REMOVED', 'CHANGED']).catch('CHANGED'),
  lineId: z.string(),
  seq: z.number(),
  style: named,
  colour: named,
  piecesBefore: z.number(),
  piecesAfter: z.number(),
  sizes: z.array(z.object({ size: z.string(), before: z.number(), after: z.number() })),
  priceChanged: z.boolean(),
})
export type RevisedLine = z.infer<typeof revisedLine>

export const revisedOrderSchema = z.object({
  orderNumber: z.string(),
  revision: z.number(),
  reason: z.string(),
  currency: z.string(),
  lines: z.array(revisedLine),
  header: z.array(z.object({ field: z.enum(['customerRef', 'requestedDate']), before: z.string().nullable(), after: z.string().nullable() })),
  prices: z.array(z.object({ lineId: z.string(), unitPrice: z.object({ before: z.string().nullable(), after: z.string().nullable() }).nullable(), netBefore: z.number(), netAfter: z.number() })).optional(),
  netAmountBefore: z.number().optional(),
  netAmountAfter: z.number().optional(),
  grossAmountBefore: z.number().optional(),
  grossAmountAfter: z.number().optional(),
})
export type RevisedOrder = z.infer<typeof revisedOrderSchema>

export const approvalPageSchema = z.object({
  request: z.object({
    id: z.string(),
    kind: z.string(),
    question: z.string(),
    dueAt: z.string(),
    status: z.enum(APPROVAL_STATUSES),
    answer: z.object({ at: z.string(), typedName: z.string(), words: z.string().nullable() }).nullable(),
    version: z.number(),
  }),
  content: z.object({ revisedOrder: revisedOrderSchema.nullable() }),
  may: z.object({ answer: z.boolean(), withChanges: z.boolean(), held: z.string().nullable() }),
})
export type ApprovalPage = z.infer<typeof approvalPageSchema>

/**
 * F-OC fx4 (end check 1, th9 step 13): the numbers a revised order may name THIS order by. The approval page says the party's own
 * number ("#12", F-PR-16: never the office's SO-… series) — an older answer the office's; matching the office's number alone never
 * found it, and the order page said "We will ask you to confirm" for ever while the ask waited.
 */
export function orderNumbersOf(number: string, ownSeq: number | null | undefined): string[] {
  const own = customerRefOf('ORDER', ownSeq)
  return own ? [number, own] : [number]
}

/**
 * The OPEN REVISED_ORDER requests of the organisation, each read once: of this order's (by one of its numbers, orderNumbersOf) the
 * newest revision that still takes an answer, else the newest (an older request the office left open is held by the API in words).
 */
export async function findRevision(api: ApiClient, orderNumbers: readonly string[], signal?: AbortSignal): Promise<ApprovalPage | null> {
  const list = await api.get('/portal/approvals', { query: { state: 'OPEN' }, schema: approvalsListSchema, signal })
  const mine: ApprovalPage[] = []
  for (const item of list.items.filter((entry) => entry.kind === 'REVISED_ORDER').slice(0, 10)) {
    const page = await fetchApproval(api, item.id, signal)
    const named = page.content.revisedOrder?.orderNumber
    if (named !== undefined && orderNumbers.includes(named)) mine.push(page)
  }
  return pickRevision(mine)
}

export function pickRevision(pages: readonly ApprovalPage[]): ApprovalPage | null {
  const newest = [...pages].sort((a, b) => (b.content.revisedOrder?.revision ?? 0) - (a.content.revisedOrder?.revision ?? 0))
  return newest.find((page) => page.may.answer) ?? newest[0] ?? null
}

export const fetchApproval = (api: ApiClient, requestId: string, signal?: AbortSignal): Promise<ApprovalPage> =>
  api.get(`/portal/approvals/${encodeURIComponent(requestId)}`, { schema: approvalPageSchema, signal })

export interface ReconfirmBody {
  readonly decision: 'APPROVED' | 'REFUSED'
  readonly answer: string | null
  readonly typedName: string
  readonly version: number
}
export const answerApproval = (api: ApiClient, requestId: string, body: ReconfirmBody, idempotencyKey: string = newIdempotencyKey()): Promise<ApprovalPage> =>
  api.post(`/portal/approvals/${encodeURIComponent(requestId)}/answer`, { body: { ...body, markup: null }, schema: approvalPageSchema, idempotencyKey })

// ── the order's documents (B-W2b-178; portal.customerDocuments.view) ───────────────────────────────────────────────────
export const documentSchema = z.object({
  id: z.string(),
  kind: z.string(),
  kindWords: words,
  group: z.string(),
  title: words,
  date: z.string(),
  version: z.number(),
  fingerprint: z.string(),
  language: z.string().nullable(),
  current: z.boolean(),
  replacedBy: z.object({ id: z.string().nullable(), title: words, version: z.number() }).nullable(),
  new: z.boolean(),
  files: z.array(z.object({ fileId: z.string(), format: z.enum(['PDF', 'XML', 'FILE']), name: z.string(), contentType: z.string(), sizeBytes: z.number() })),
  grossTotal: price,
  currency: z.string().nullable(),
})
export type OrderDocument = z.infer<typeof documentSchema>

export const documentsSchema = z.object({ asOf: z.string(), seesPrices: z.boolean(), count: z.number(), items: z.array(documentSchema), live })
export type DocumentsRead = z.infer<typeof documentsSchema>

export const fetchDocuments = (api: ApiClient, orderId: string, signal?: AbortSignal): Promise<DocumentsRead> =>
  api.get('/portal/customer-documents', { query: { orderId, versions: 'all', limit: 200 }, schema: documentsSchema, signal })

// ---- F-SA-238 (sales page plan N9, P14, R6): the order's shared files grouped like the office's Files tab (B-SA-037's portal read) ----
const portalWords = z.object({ it: z.string(), en: z.string() })
export const orderFilesSchema = z.object({
  asOf: z.string(),
  order: z.object({ id: z.string(), customerRef: z.string().nullable(), yourNumber: z.object({ seq: z.number(), words: portalWords }).nullable() }),
  groups: z.array(
    z.object({
      key: z.string(),
      words: portalWords,
      files: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          kind: z.string(),
          category: z.string().nullable(),
          documentKind: z.string().nullable(),
          documentWords: portalWords.nullable(),
          contentType: z.string(),
          sizeBytes: z.number(),
          versionNo: z.number(),
          at: z.string(),
          from: z.object({ type: z.string(), id: z.string(), label: z.string().nullable() }),
          line: z.object({ id: z.string(), seq: z.number() }).nullable(),
        }),
      ),
    }),
  ),
  total: z.number(),
})
export type PortalOrderFiles = z.infer<typeof orderFilesSchema>

/** GET /portal/sales-orders/:orderId/files — the customer's own shared files of the order (another customer's: "not found"). */
export const fetchOrderFiles = (api: ApiClient, orderId: string, signal?: AbortSignal): Promise<PortalOrderFiles> => api.get(`/portal/sales-orders/${encodeURIComponent(orderId)}/files`, { schema: orderFilesSchema, signal })
// ---- end F-SA-238

export const downloadSchema = z.object({
  download: z.object({ mode: z.enum(['inline', 'download']), method: z.literal('GET'), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.string() }),
})
export type DocumentDownload = z.infer<typeof downloadSchema>['download']

/** One logged open (preview) or download: a presigned GET that lives 60 seconds. */
export const openDocument = (api: ApiClient, fileId: string, mode: 'download' | 'preview'): Promise<DocumentDownload> =>
  api.post(`/portal/customer-documents/${encodeURIComponent(fileId)}/download`, { body: { mode }, schema: downloadSchema, idempotencyKey: newIdempotencyKey() }).then((read) => read.download)

// ── the deposit paid online (B-W2b-185; FAKE provider only) ───────────────────────────────────────────────────────────
export const INTENT_STATUSES = ['CREATED', 'WAITING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const
export const intentSchema = z.object({
  id: z.string(),
  method: z.enum(['CARD', 'SEPA_DEBIT']),
  amount: price,
  currency: z.string(),
  status: z.enum(INTENT_STATUSES),
  failureCode: z.string().nullable(),
  finishedAt: z.string().nullable(),
})
export type PaymentIntent = z.infer<typeof intentSchema>

export const openItemsSchema = z.object({
  deposits: z.array(z.object({ depositRequestId: z.string(), orderNumber: z.string().nullable(), dueDate: z.string(), open: price, total: price, currency: z.string(), payment: intentSchema.nullable(), canPay: z.boolean() })),
  card: z.object({ available: z.boolean(), methods: z.array(z.enum(['CARD', 'SEPA_DEBIT'])), provider: z.string().nullable(), mode: z.string().nullable() }),
  mayPay: z.boolean(),
})
export type OpenItems = z.infer<typeof openItemsSchema>

export const fetchOpenItems = (api: ApiClient, signal?: AbortSignal): Promise<OpenItems> => api.get('/portal/payments/open-items', { schema: openItemsSchema, signal })

export const startedSchema = z.object({
  intent: intentSchema,
  provider: z.object({ name: z.string(), mode: z.string(), clientSecret: z.string(), publishableKey: z.string().nullable() }).nullable(),
  resumed: z.boolean(),
})
export type StartedPayment = z.infer<typeof startedSchema>

export const startDepositPayment = (api: ApiClient, depositRequestId: string, method: 'CARD' | 'SEPA_DEBIT', idempotencyKey: string = newIdempotencyKey()): Promise<StartedPayment> =>
  api.post('/portal/payments/intents', { body: { depositRequestId, method }, schema: startedSchema, idempotencyKey })

export const fetchIntent = (api: ApiClient, intentId: string, signal?: AbortSignal): Promise<PaymentIntent> =>
  api.get(`/portal/payments/intents/${encodeURIComponent(intentId)}`, { schema: z.object({ intent: intentSchema }), signal }).then((read) => read.intent)

/** The FAKE provider's own fields (local and test only; 404 anywhere else): what a card or a bank would do. */
export const FAKE_SCENARIOS = ['succeed', 'decline', 'authenticate', 'fail_authentication', 'settle'] as const
export type FakeScenario = (typeof FAKE_SCENARIOS)[number]
export const confirmFake = (api: ApiClient, clientSecret: string, scenario: FakeScenario) =>
  api.post('/payment-fake/confirm', { body: { clientSecret, scenario }, schema: z.object({ state: z.string() }), idempotencyKey: newIdempotencyKey() })
