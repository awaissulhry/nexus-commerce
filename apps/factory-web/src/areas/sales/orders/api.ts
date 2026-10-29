import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'

/**
 * Every call of the sales order screens (SCR-038 list and board, SCR-039 the order studio), with the answer's shape
 * checked (zod; unknown fields are dropped, so a new API field never breaks a page). The shapes mirror apps/factory-api
 * modules/sales/orders, payments (deposit received, the DEPOSIT_INFO page), invoicing (an invoice's SDI state, the send,
 * the order's settlement) and production (the work orders of an order). Money fields are optional: the API drops what
 * the person's grains do not reach (absent, never zero). The API's English words (held reasons, missing words, SDI
 * titles) are never drawn: the screens say their own words from the codes.
 */

export const ORDER_STATUSES = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED', 'CLOSED', 'CANCELLED'] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]
/** The board's lanes (closed and cancelled are counted beside them). */
export const BOARD_LANES = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED'] as const satisfies readonly OrderStatus[]
export type BoardLane = (typeof BOARD_LANES)[number]
export const DEPOSIT_STATES = ['NOT_NEEDED', 'MISSING', 'OPEN', 'PAID', 'WAIVED'] as const
export type DepositState = (typeof DEPOSIT_STATES)[number]
export const DEPOSIT_REQUEST_STATUSES = ['OPEN', 'PAID', 'WAIVED', 'CANCELLED'] as const
export type DepositRequestStatus = (typeof DEPOSIT_REQUEST_STATUSES)[number]
export const DEPOSIT_KINDS = ['ACCONTO', 'CAPARRA'] as const
export const LINK_STATES = ['LIVE', 'REVOKED', 'USED_UP', 'EXPIRED'] as const
export const ORDER_ACTIONS = ['changePromise', 'markReady', 'cancel', 'close'] as const
export type OrderAction = (typeof ORDER_ACTIONS)[number]
export const TILE_KEYS = ['late', 'waitingForDeposit', 'inProduction', 'readyToShip'] as const
export type TileKey = (typeof TILE_KEYS)[number]
export const SDI_STATE_CODES = ['DRAFT', 'NOT_SENT', 'SENDING', 'AT_SDI', 'DELIVERED', 'NOT_DELIVERED', 'REJECTED', 'ERROR'] as const
export type SdiStateCode = (typeof SDI_STATE_CODES)[number]
export const SDI_NEXT_ACTIONS = ['ISSUE', 'SEND', 'WAIT', 'FIX_AND_RESEND', 'SEND_AGAIN', 'CHECK_COPY', 'NONE'] as const
/** The settlement's missing codes (factory-domain invoicing/from-shipment/settlement SettlementGap). */
export const SETTLEMENT_GAPS = ['ORDER_CANCELLED', 'NOT_SHIPPED', 'NOT_INVOICED', 'OVER_INVOICED', 'NO_INVOICE', 'AT_SDI', 'DEPOSIT_NOT_DEDUCTED', 'DEPOSIT_NOT_INVOICED', 'BALANCE_DUE', 'REFUND_DUE'] as const
export const WORK_ORDER_STATUSES = ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CLOSED', 'CANCELLED'] as const
export const SHIPMENT_STATUSES = ['DRAFT', 'PACKED', 'SHIPPED', 'DELIVERED', 'RETURNED', 'CANCELLED'] as const
export const INVOICE_DOC_TYPES = ['TD01', 'TD02', 'TD04', 'TD24'] as const
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
  status,
  deposit: z.object({ state: z.enum(DEPOSIT_STATES), dueDate: z.string().nullable() }),
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
  q?: string
  cursor?: string | null
  limit?: number
}

export function listOrders(api: ApiClient, query: OrderQuery, signal?: AbortSignal): Promise<OrderPage> {
  return api.get('/sales/orders', {
    query: {
      status: query.status ?? undefined,
      open: query.open ? 'true' : undefined,
      late: query.late ? 'true' : undefined,
      deposit: query.deposit ?? undefined,
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
  lanes: z.array(status),
  tiles: z.array(z.object({ key: z.enum(TILE_KEYS), count: z.number(), filter: z.record(z.string(), z.string()) })),
  asOf: instant,
})
export type OrderBoard = z.infer<typeof boardSchema>

/** The counts by state and the tiles (each the list's total under its filter), under the search. */
export function getBoard(api: ApiClient, q: string, signal?: AbortSignal): Promise<OrderBoard> {
  return api.get('/sales/orders/board', { query: { q: q.trim() || undefined }, schema: boardSchema, signal })
}

// ---- the record ----------------------------------------------------------------------------------------------------------

const progressSchema = z.object({
  ordered: z.number(),
  inWorkOrders: z.number(),
  made: z.number().nullable(),
  released: z.number(),
  shipped: z.number(),
  invoiced: z.string(),
  toShip: z.number(),
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
  version: z.number(),
  sizes: z.array(z.object({ size: z.string().nullable(), quantity: z.number(), unitPrice: z.string().nullable().optional(), progress: progressSchema })),
  progress: progressSchema,
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
  link: z.object({ sentAt: instant, to: z.string().nullable(), expiresAt: instant, state: z.enum(LINK_STATES) }).nullable().default(null),
})
export type DepositRequest = z.infer<typeof depositRequestSchema>

export const orderSchema = z.object({
  id: z.string(),
  number: z.string(),
  companyId: z.string(),
  partyId: z.string(),
  party: z.object({ code: z.string(), legalName: z.string() }).nullable(),
  customerRef: z.string().nullable(),
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
    depositRequests: z.array(depositRequestSchema),
    workOrders: z.array(z.object({ id: z.string(), number: z.string(), status: z.string(), siteId: z.string(), releasedAt: instant.nullable() })),
    shipments: z.array(z.object({ id: z.string(), number: z.string(), status: z.string(), shippedAt: instant.nullable(), deliveredAt: instant.nullable() })),
    invoices: z.array(z.object({ id: z.string(), number: z.string().nullable(), docType: z.string(), status: z.string(), issueDate: z.string().nullable(), depositRequestId: z.string().nullable().default(null) })),
  }),
  promiseHistory: z.array(z.object({ at: instant, actorId: z.string(), from: z.string().nullable(), to: z.string(), lineIds: z.array(z.string()), reason: z.string().nullable() })),
  people: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
  settlement: z.object({ settled: z.boolean(), missing: z.array(z.object({ code: z.string(), message: z.string() })), source: z.string() }),
  actions: z.array(z.object({ action: z.enum(ORDER_ACTIONS), allowed: z.boolean(), needsReason: z.boolean(), held: z.string().nullable() })),
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
export async function changePromise(api: ApiClient, id: string, body: { version: number; promiseDate: string; reason: string; lineIds?: string[] }): Promise<Order> {
  return (await api.request('PUT', `${orderPath(id)}/promise`, { body, schema: one, idempotencyKey: newIdempotencyKey() })).order
}

export async function markReady(api: ApiClient, id: string, body: { version: number; reason: string }): Promise<Order> {
  return (await api.post(`${orderPath(id)}/ready`, { body, schema: one, idempotencyKey: newIdempotencyKey() })).order
}

export async function cancelOrder(api: ApiClient, id: string, body: { version: number; reason: string }): Promise<{ order: Order; paidDepositRequestIds: string[] }> {
  return api.post(`${orderPath(id)}/cancel`, { body, schema: z.object({ order: orderSchema, paidDepositRequestIds: z.array(z.string()) }), idempotencyKey: newIdempotencyKey() })
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
export function sendDepositLink(api: ApiClient, depositRequestId: string, message: string | null): Promise<DepositLinkAnswer> {
  return api.post(`/payments/deposit-requests/${encodeURIComponent(depositRequestId)}/link`, { body: message?.trim() ? { message: message.trim() } : {}, schema: linkAnswerSchema, idempotencyKey: newIdempotencyKey() })
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
  body: { depositRequestId: string; amount: number; receivedOn: string; externalRef: string; internalNote?: string | null; issueDepositInvoice: boolean },
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

export const settlementSchema = z.object({
  settled: z.boolean(),
  gaps: z.array(z.string()),
  invoices: z.array(z.object({ id: z.string(), docType: z.string(), number: z.string().nullable(), status: z.string(), grossTotal: z.number().optional(), paidAmount: z.number().optional(), openAmount: z.number().optional() })),
  invoicedAmount: z.number().optional(),
  creditedAmount: z.number().optional(),
  paidAmount: z.number().optional(),
  balanceDueAmount: z.number().optional(),
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
