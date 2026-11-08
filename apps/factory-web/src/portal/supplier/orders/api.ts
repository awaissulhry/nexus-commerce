import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { PORTAL_LINE_ANSWERS, type PortalLineBody } from '../../../lib/po-answer/lines'

/**
 * The supplier's purchase orders in the portal (apps/factory-api modules/purchasing/portal-orders, B-W2b-174; design
 * portal.supplier.orders, SCR-189): the list with its chips, one order in the supplier's terms, what changed in each version,
 * the answer (confirm all as asked, line by line, or decline), the price-free copy, and the ship notices of one order
 * (modules/purchasing/ship-notices, B-W2b-182). NOTHING here is money (Owner answer C2): the schemas hold no price, cost or
 * amount, and a key the API might add is dropped by zod. Every write carries an Idempotency-Key; quantities are decimal
 * strings in the line's unit, dates calendar days, times UTC instants.
 */

const words = z.object({ it: z.string(), en: z.string() })
const live = z.object({ events: z.array(z.string()) })

export const ORDER_CHIPS = ['TO_CONFIRM', 'CONFIRMED', 'CHANGE_PROPOSED', 'PARTLY_DELIVERED', 'DELIVERED', 'CLOSED', 'ALL'] as const
export type OrderChip = (typeof ORDER_CHIPS)[number]
export const isOrderChip = (value: unknown): value is OrderChip => typeof value === 'string' && (ORDER_CHIPS as readonly string[]).includes(value)

export const SUPPLIER_STATES = ['TO_CONFIRM', 'CONFIRMED', 'CHANGE_PROPOSED', 'DECLINED', 'BEING_CHANGED', 'PARTLY_DELIVERED', 'DELIVERED', 'CLOSED', 'CANCELLED'] as const
export type SupplierState = (typeof SUPPLIER_STATES)[number]

export { PORTAL_LINE_ANSWERS, type PortalLineAnswer, type PortalLineBody } from '../../../lib/po-answer/lines'
export const PORTAL_DECLINE_REASONS = ['NO_CAPACITY', 'MATERIAL_NOT_AVAILABLE', 'PRICE', 'OTHER'] as const
export type PortalDeclineReason = (typeof PORTAL_DECLINE_REASONS)[number]

// ── the list ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export const orderRowSchema = z.object({
  id: z.string(),
  number: z.string(),
  documentNumber: z.string(),
  revision: z.number(),
  status: z.string(),
  state: z.enum(SUPPLIER_STATES),
  words,
  supplierRef: z.string().nullable(),
  sentAt: z.string().nullable(),
  orderDate: z.string(),
  lines: z.number(),
  earliestNeedDate: z.string().nullable(),
  nextExpected: z.string().nullable(),
  late: z.boolean(),
  confirmBy: z.string().nullable(),
  canAnswer: z.boolean(),
  version: z.number(),
})
export type OrderRow = z.infer<typeof orderRowSchema>

export const ordersSchema = z.object({
  asOf: z.string(),
  chip: z.enum(ORDER_CHIPS),
  chips: z.array(z.object({ chip: z.enum(ORDER_CHIPS), count: z.number(), words })),
  counts: z.object({ toConfirm: z.number(), late: z.number() }),
  items: z.array(orderRowSchema),
  complete: z.boolean(),
  live,
})
export type OrdersRead = z.infer<typeof ordersSchema>

export const fetchOrders = (api: ApiClient, query: { chip?: OrderChip | null; q?: string | null }, signal?: AbortSignal): Promise<OrdersRead> =>
  api.get('/portal/purchase-orders', { query: { chip: query.chip ?? undefined, q: query.q?.trim() ? query.q.trim() : undefined }, schema: ordersSchema, signal })

// ── one order ────────────────────────────────────────────────────────────────────────────────────────────────────────
const delivery = z.object({ quantity: z.string(), date: z.string().nullable() })
const fieldChange = z.object({ field: z.string(), before: z.unknown(), after: z.unknown() })

export const changesSchema = z.object({
  revision: z.number(),
  documentNumber: z.string(),
  sentAt: z.string(),
  changeNote: z.string().nullable(),
  /** In the supplier's words (the person's language). */
  words: z.array(z.string()),
  lines: z.array(z.object({ lineId: z.string(), seq: z.number(), kind: z.enum(['ADDED', 'REMOVED', 'CANCELLED', 'CHANGED']), changes: z.array(fieldChange) })),
  header: z.array(fieldChange),
})
export type OrderChanges = z.infer<typeof changesSchema>

export const orderLineSchema = z.object({
  id: z.string(),
  seq: z.number(),
  code: z.string().nullable(),
  name: z.string().nullable(),
  colour: z.object({ name: z.string().nullable(), supplierCode: z.string().nullable() }).nullable(),
  description: z.string().nullable(),
  quantity: z.string(),
  uom: z.string(),
  baseQuantity: z.string().nullable(),
  baseUom: z.string().nullable(),
  needDate: z.string(),
  grade: z.string().nullable(),
  thicknessMinMm: z.string().nullable(),
  thicknessMaxMm: z.string().nullable(),
  oneDyeBatch: z.boolean(),
  areaTolerancePct: z.string().nullable(),
  estimatedHides: z.number().nullable(),
  requiresCrViTest: z.boolean(),
  note: z.string().nullable(),
  confirmedQuantity: z.string().nullable(),
  confirmedDate: z.string().nullable(),
  receivedBase: z.string(),
  ended: z.enum(['CANCELLED', 'CLOSED_SHORT']).nullable(),
  locked: z.boolean(),
  proposal: z
    .object({
      kind: z.enum(PORTAL_LINE_ANSWERS),
      quantity: z.string(),
      date: z.string().nullable(),
      deliveries: z.array(delivery),
      reason: z.string().nullable(),
      changes: z.array(z.string()),
      substitute: z.object({ itemId: z.string().nullable(), code: z.string().nullable(), name: z.string().nullable(), note: z.string().nullable() }).nullable(),
      needsBuyer: z.boolean(),
    })
    .nullable(),
  version: z.number(),
})
export type OrderLine = z.infer<typeof orderLineSchema>

const historySchema = z.object({
  revision: z.number(),
  documentNumber: z.string(),
  sentAt: z.string(),
  answer: z.enum(['NOT_SENT', 'WAITING', 'CONFIRMED', 'DECLINED', 'CHANGES_PROPOSED', 'RECEIVED', 'CANCELLED']),
  confirmation: z.object({ at: z.string(), byName: z.string().nullable(), supplierRef: z.string().nullable() }).nullable(),
  decline: z.object({ at: z.string(), reason: z.string().nullable() }).nullable(),
  proposal: z.object({ at: z.string(), byName: z.string().nullable(), supplierRef: z.string().nullable(), note: z.string().nullable(), decision: z.string().nullable() }).nullable(),
})
export type HistoryEntry = z.infer<typeof historySchema>

export const orderPageSchema = z.object({
  order: z.object({
    id: z.string(),
    number: z.string(),
    documentNumber: z.string(),
    revision: z.number(),
    status: z.string(),
    state: z.enum(SUPPLIER_STATES),
    words,
    orderDate: z.string(),
    requestedDate: z.string().nullable(),
    incoterms: z.string().nullable(),
    paymentTerms: z.string().nullable(),
    note: z.string().nullable(),
    sentAt: z.string().nullable(),
    confirmBy: z.string().nullable(),
    confirmedAt: z.string().nullable(),
    confirmedByName: z.string().nullable(),
    supplierRef: z.string().nullable(),
    confirmNote: z.string().nullable(),
    declinedAt: z.string().nullable(),
    declineReason: z.string().nullable(),
    cancelledAt: z.string().nullable(),
    version: z.number(),
  }),
  from: z.object({ legalName: z.string(), tradeName: z.string().nullable(), buyerName: z.string().nullable() }),
  deliverTo: z.object({ name: z.string(), line1: z.string(), line2: z.string().nullable(), postalCode: z.string(), city: z.string(), province: z.string().nullable(), country: z.string() }).nullable(),
  lines: z.array(orderLineSchema),
  proposal: z
    .object({ at: z.string(), byName: z.string().nullable(), supplierRef: z.string().nullable(), note: z.string().nullable(), summary: z.string(), decision: z.enum(['ACCEPTED', 'REFUSED']).nullable(), decidedAt: z.string().nullable() })
    .nullable(),
  answer: z.object({
    canAnswer: z.boolean(),
    message: z.string().nullable(),
    mayAnswer: z.boolean(),
    lineAnswers: z.array(z.enum(PORTAL_LINE_ANSWERS)),
    declineReasons: z.array(z.enum(PORTAL_DECLINE_REASONS)),
    substitutes: z.record(z.string(), z.array(z.object({ itemId: z.string(), code: z.string(), name: z.string() }))),
  }),
  changes: changesSchema.nullable(),
  history: z.array(historySchema),
  copy: z.object({ href: z.string() }),
  live,
})
export type OrderPage = z.infer<typeof orderPageSchema>

export const fetchOrder = (api: ApiClient, id: string, signal?: AbortSignal): Promise<OrderPage> => api.get(`/portal/purchase-orders/${encodeURIComponent(id)}`, { schema: orderPageSchema, signal })

export const revisionsSchema = z.object({ purchaseOrderId: z.string(), number: z.string(), revisions: z.array(changesSchema) })
export type OrderRevisions = z.infer<typeof revisionsSchema>
export const fetchRevisions = (api: ApiClient, id: string, language: 'it' | 'en', signal?: AbortSignal): Promise<OrderRevisions> =>
  api.get(`/portal/purchase-orders/${encodeURIComponent(id)}/revisions`, { query: { language }, schema: revisionsSchema, signal })

/** The price-free copy of the version the supplier holds (a PDF painted on request): opened in a new tab through the web's `/api`. */
export const copyHref = (id: string, language: 'it' | 'en'): string => `/api/portal/purchase-orders/${encodeURIComponent(id)}/copy?language=${language}`

// ── the answer ───────────────────────────────────────────────────────────────────────────────────────────────────────
export interface PortalConfirmBody {
  readonly version: number
  readonly mode: 'ALL_AS_ASKED' | 'BY_LINE'
  readonly lines?: readonly PortalLineBody[] | null
  readonly supplierRef?: string | null
  readonly note?: string | null
}

export const answerEndSchema = orderPageSchema.extend({ outcome: z.enum(['CONFIRMED', 'PROPOSED', 'DECLINED']), summary: z.string().nullable(), done: z.string() })
export type AnswerEnd = z.infer<typeof answerEndSchema>

export const confirmOrder = (api: ApiClient, id: string, body: PortalConfirmBody, idempotencyKey: string = newIdempotencyKey()): Promise<AnswerEnd> =>
  api.post(`/portal/purchase-orders/${encodeURIComponent(id)}/confirm`, { body, schema: answerEndSchema, idempotencyKey })

export const declineOrder = (api: ApiClient, id: string, body: { version: number; reason: PortalDeclineReason; note?: string | null }, idempotencyKey: string = newIdempotencyKey()): Promise<AnswerEnd> =>
  api.post(`/portal/purchase-orders/${encodeURIComponent(id)}/decline`, { body, schema: answerEndSchema, idempotencyKey })

// ── the ship notices of one order (B-W2b-182; portal.shipNotices.view) ─────────────────────────────────────────────────
export const NOTICE_STATES = ['DRAFT', 'ANNOUNCED', 'IN_TRANSIT', 'RECEIVED', 'RECEIVED_WITH_DIFFERENCES', 'CANCELLED'] as const
export type NoticeState = (typeof NOTICE_STATES)[number]

export const noticeRowSchema = z.object({
  id: z.string(),
  number: z.string().nullable(),
  status: z.string(),
  state: z.enum(NOTICE_STATES),
  words,
  purchaseOrder: z.object({ id: z.string(), number: z.string() }),
  shipDate: z.string().nullable(),
  expectedDate: z.string().nullable(),
  carrier: z.string().nullable(),
  trackingNumber: z.string().nullable(),
  ddtNumber: z.string().nullable(),
  supplierRef: z.string().nullable(),
  parcels: z.number().nullable(),
  sentAt: z.string().nullable(),
  lines: z.number(),
  hides: z.number(),
  differing: z.number(),
  version: z.number(),
})
export type NoticeRow = z.infer<typeof noticeRowSchema>

export const noticesSchema = z.object({ asOf: z.string(), mayWrite: z.boolean(), counts: z.record(z.string(), z.number()), items: z.array(noticeRowSchema), more: z.boolean(), live })
export type NoticesRead = z.infer<typeof noticesSchema>

export const fetchNotices = (api: ApiClient, purchaseOrderId: string, signal?: AbortSignal): Promise<NoticesRead> =>
  api.get('/portal/ship-notices', { query: { purchaseOrderId }, schema: noticesSchema, signal })
