import { z } from 'zod'
import { CUSTOMER_SHIPMENT_STATUSES, SHIPMENT_MILESTONES } from '@nexus/factory-domain/sales/portal-orders/shipments'
import { CUSTOMER_ORDER_STATUSES, MILESTONE_STATES, MILESTONES, ORDER_CHIPS } from '@nexus/factory-domain/sales/portal-orders/status'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

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
/** A price: absent for a reader without the price grain. */
const price = z.number().nullable().optional()

// ── the list ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export const orderRowSchema = z.object({
  /** ORDER, or REQUEST: a portal order request sent and not decided yet. */
  kind: z.enum(['ORDER', 'REQUEST']),
  id: z.string(),
  customerRef: z.string().nullable(),
  number: z.string().nullable(),
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
})
export type OrderRow = z.infer<typeof orderRowSchema>

export const ordersSchema = z.object({
  asOf: z.string(),
  seesPrices: z.boolean(),
  progressShared: z.boolean(),
  chip: z.enum(ORDER_CHIPS),
  chips: z.array(z.object({ chip: z.enum(ORDER_CHIPS), count: z.number(), words })),
  count: z.number(),
  items: z.array(orderRowSchema),
  live,
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

const trackingEvent = z.object({ at: z.string(), status: z.string(), words, description: z.string().nullable(), location: z.string().nullable(), parcelSeq: z.number().nullable() })
export type TrackingEvent = z.infer<typeof trackingEvent>
const trackingLink = z.object({ url: z.string(), words })

export const inTransitSchema = z.object({
  asOf: z.string(),
  items: z.array(
    z.object({
      shipmentId: z.string(),
      number: z.string(),
      order: z.object({ id: z.string(), number: z.string(), customerRef: z.string().nullable() }),
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

export const promiseMoveSchema = z.object({ on: z.string(), from: z.string().nullable(), to: z.string(), lines: z.array(z.number()), reason: z.object({ code: z.string(), words }) })
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
  progressShared: z.boolean(),
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
  ddt: z.object({ number: z.string(), date: z.string() }).nullable(),
  milestones: z.array(z.object({ key: z.enum(SHIPMENT_MILESTONES), words, done: z.boolean(), at: z.string().nullable() })),
  parcels: z.array(z.object({ seq: z.number(), trackingNumber: z.string().nullable(), trackingLink: trackingLink.nullable().optional(), status: z.string().nullable(), words: words.nullable(), lastEvent: trackingEvent.nullable() })),
  events: z.array(trackingEvent),
  lines: z.array(z.object({ lineSeq: z.number(), style: named.nullable(), colourway: named.nullable(), size: z.string().nullable(), quantity: z.number() })),
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

// ── change and cancel requests (B-W2b-183; portal.salesOrders.ask to ask, .view to read) ─────────────────────────────
export const VERDICT_CODES = ['FREE', 'NOT_ASKABLE', 'OPEN_REQUEST', 'STATUS', 'DAYS', 'MADE_TO_MEASURE', 'CLOSED_SHORT', 'CUT', 'LEATHER_CUT', 'WHOLE_ORDER_ONLY'] as const
export type VerdictCode = (typeof VERDICT_CODES)[number]
const verdict = z.object({ possible: z.boolean(), code: z.enum(VERDICT_CODES), day: z.string().nullable(), words })
export type Verdict = z.infer<typeof verdict>
const address = z.object({ id: z.string(), label: z.string() })

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
    }),
  ),
  cancelFee: z.object({ pct: z.string().nullable(), words, currency: z.string(), wholeOrderFee: price }).optional(),
  reasons: z.array(z.object({ code: z.string(), words, needsNote: z.boolean() })),
  addresses: z.array(address),
  noWithdrawal: words.nullable(),
  openRequestId: z.string().nullable(),
  live,
})
export type ChangeRules = z.infer<typeof rulesSchema>
export type RuleLine = ChangeRules['lines'][number]

export const fetchRules = (api: ApiClient, orderId: string, signal?: AbortSignal): Promise<ChangeRules> =>
  api.get(`/portal/sales-orders/${encodeURIComponent(orderId)}/change-requests/rules`, { schema: rulesSchema, signal })

export const REQUEST_STATUSES = ['OPEN', 'ACCEPTED', 'REFUSED', 'WITHDRAWN'] as const
export type RequestStatus = (typeof REQUEST_STATUSES)[number]

export const changeRequestSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  orderNumber: z.string(),
  customerRef: z.string().nullable(),
  kind: z.enum(['CHANGE', 'CANCEL']),
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
  version: z.number(),
  mine: z.boolean(),
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
}
export interface CancelBody {
  readonly kind: 'CANCEL'
  /** None: the whole order. */
  readonly lineIds?: readonly string[]
  readonly reasonCode: string
  readonly note?: string | null
}

const oneRequest = z.object({ request: changeRequestSchema })
export const askRequest = (api: ApiClient, orderId: string, body: ChangeBody | CancelBody, idempotencyKey: string = newIdempotencyKey()) =>
  api.post(`/portal/sales-orders/${encodeURIComponent(orderId)}/change-requests`, { body, schema: oneRequest, idempotencyKey })

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
 * The OPEN REVISED_ORDER requests of the organisation, each read once: of this order's (by its number) the newest revision
 * that still takes an answer, else the newest (an older request the office left open is held by the API in words).
 */
export async function findRevision(api: ApiClient, orderNumber: string, signal?: AbortSignal): Promise<ApprovalPage | null> {
  const list = await api.get('/portal/approvals', { query: { state: 'OPEN' }, schema: approvalsListSchema, signal })
  const mine: ApprovalPage[] = []
  for (const item of list.items.filter((entry) => entry.kind === 'REVISED_ORDER').slice(0, 10)) {
    const page = await fetchApproval(api, item.id, signal)
    if (page.content.revisedOrder?.orderNumber === orderNumber) mine.push(page)
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
