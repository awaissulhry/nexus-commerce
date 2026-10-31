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
  /** B-W2a-30: pieces closed short (they will not be made or shipped). */
  closedShort: z.number().default(0),
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
  /** B-W2a-F2: the schedule step the request pays — DEPOSIT, or BEFORE_SHIPPING (the balance before shipping, not the deposit). */
  stepKind: z.enum(['DEPOSIT', 'BEFORE_SHIPPING']).nullable().default(null),
  /** B-W2b-16: the owner's waive of a request no schedule step names is sent at it. */
  version: z.number().default(1),
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

/** An existing line as an amendment keeps it (its whole size grid; none: unchanged), or a new line. */
export type AmendLineInput = { id: string; sizes?: SizeInput[]; unitPrice?: string | null } | NewLineInput

export interface AmendBody {
  reason?: string
  customerRef?: string | null
  requestedDate?: string | null
  /** Every line the order keeps (a line left out is removed). */
  lines: AmendLineInput[]
}

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

export const amendPreviewSchema = z.object({ ok: z.boolean(), revision: z.number(), version: z.number(), problems: z.array(issueSchema), diff: diffSchema.nullable() })
export type AmendPreview = z.infer<typeof amendPreviewSchema>

/** What the amendment would change (the review dialog): lines old → new by size, the money change, re-acceptance. */
export function previewAmendment(api: ApiClient, orderId: string, body: AmendBody & { version?: number }, signal?: AbortSignal): Promise<AmendPreview> {
  return api.post(`${orderPath(orderId)}/amendments/preview`, { body, schema: amendPreviewSchema, signal })
}

/** "Apply amendment" with the order's version as read (a stale one: 409). */
export function applyAmendment(api: ApiClient, orderId: string, body: AmendBody & { version: number; reason: string }, idempotencyKey: string): Promise<{ order: Order; amendment: Amendment }> {
  return api.post(`${orderPath(orderId)}/amendments`, { body, schema: z.object({ order: orderSchema, amendment: amendmentSchema }), idempotencyKey })
}

const closeLinesSchema = z.object({
  order: orderSchema,
  closed: z.array(z.object({ lineId: z.string(), seq: z.number(), closedShortQuantity: z.number() })),
  reducesDone: z.array(z.string()),
  stillInWorkOrders: z.array(z.object({ lineId: z.string(), pieces: z.number() })),
})
export type CloseLinesAnswer = z.infer<typeof closeLinesSchema>

/** "Close remaining lines": what is left of the lines named (none: every open line) will not be made or shipped. */
export function closeLines(api: ApiClient, orderId: string, body: { version: number; reason: string; reasonCode?: string; lineIds?: string[] }): Promise<CloseLinesAnswer> {
  return api.post(`${orderPath(orderId)}/close-lines`, { body, schema: closeLinesSchema, idempotencyKey: newIdempotencyKey() })
}

/** "Reopen lines" (the close's reversal). */
export function reopenLines(api: ApiClient, orderId: string, body: { version: number; reason: string; lineIds?: string[] }): Promise<{ order: Order; reopened: string[] }> {
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
})
export type CancelCheck = z.infer<typeof cancelCheckSchema>

/** The cancel's impact check: what stops it, what it changes, what it leaves behind. */
export function getCancelCheck(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<CancelCheck> {
  return api.get(`${orderPath(orderId)}/cancel-check`, { schema: cancelCheckSchema, signal })
}

/** "Cancel order" with the reason and the number typed to confirm it. */
export function cancelOrder(api: ApiClient, id: string, body: { version: number; reason: string; confirmNumber: string }): Promise<{ order: Order; paidDepositRequestIds: string[]; impact: Impact | null }> {
  return api.post(`${orderPath(id)}/cancel`, { body, schema: z.object({ order: orderSchema, paidDepositRequestIds: z.array(z.string()), impact: impactSchema.nullable().default(null) }), idempotencyKey: newIdempotencyKey() })
}

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
})
export type Schedule = z.infer<typeof scheduleSchema>

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
