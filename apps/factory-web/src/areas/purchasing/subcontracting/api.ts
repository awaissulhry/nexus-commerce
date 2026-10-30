import { z } from 'zod'
import { KIT_LINE_STATUSES, KIT_STATES, SUBCONTRACT_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/subcontracting/rules'
import type { ApiClient } from '../../../lib/api/client'
import { presignedSchema, type Presigned } from '../../../record-panels/api'

/**
 * Every call of Purchasing › Subcontract orders (SCR-128 the list and the record, SCR-129 the stock at each
 * subcontractor), with the answer's shape checked (zod; unknown fields are dropped, so a new API field never breaks a
 * page). The shapes mirror apps/factory-api modules/purchasing/subcontracting/contract.ts (B-W2a-25, B-W2a-56): the list
 * and its tiles, the record (operations, kit, receipts, DDTs, the acts it allows), what a work order may send out, the
 * work orders to pick from, the stock at the workshops, and every write (each with the order's version and an
 * Idempotency-Key). Fees and values are costs: the API drops them for a role without the cost grain, so they are
 * optional here and a screen draws them only with `money.cost`. The kit's DDT (conto lavorazione) is read and printed
 * through `/shipping/ddts` (B-W2a-17); the bundles a kit or a receipt names through `/production/bundles` (workorders.view).
 */

export const ORDER_STATUSES = SUBCONTRACT_ORDER_STATUSES
export type OrderStatus = (typeof SUBCONTRACT_ORDER_STATUSES)[number]
export type KitState = (typeof KIT_STATES)[number]
export type KitLineStatus = (typeof KIT_LINE_STATUSES)[number]
/** factory-domain shipping/ddt/sources SOURCE_DDT_REASONS for a SubcontractOrder (default first). */
export const KIT_DDT_REASONS = ['WORK_ON_ACCOUNT', 'OTHER'] as const
export type KitDdtReason = (typeof KIT_DDT_REASONS)[number]
export const TRANSPORT_BY = ['SENDER', 'RECIPIENT', 'CARRIER'] as const
export type TransportBy = (typeof TRANSPORT_BY)[number]
export const DDT_FREIGHT = ['FREE', 'FORWARD'] as const

const enc = encodeURIComponent
const status = z.enum(SUBCONTRACT_ORDER_STATUSES)
const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })
export type Ref = z.infer<typeof ref>
const workOrderRef = z.object({ id: z.string(), number: z.string(), status: z.string(), style: ref })
const cost = z.string().nullable().optional()

type Query = Readonly<Record<string, string | number | boolean | null | undefined>>
const clean = (query: Query): Query => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== '' && value !== false))

// ---- the list ----------------------------------------------------------------------------------------------------------------

const countsSchema = z.object({ ordered: z.number(), sent: z.number(), backGood: z.number(), backDefective: z.number(), scrapped: z.number(), atWorkshop: z.number() })
export type PieceCounts = z.infer<typeof countsSchema>

const summary = {
  id: z.string(),
  number: z.string(),
  status,
  companyId: z.string(),
  site: z.object({ id: z.string(), code: z.string() }),
  workshop: ref,
  location: ref,
  workOrder: workOrderRef,
  orderDate: z.string(),
  expectedBackDate: z.string().nullable(),
  late: z.boolean(),
  services: z.array(z.object({ seq: z.number(), code: z.string(), name: z.string() })),
  pieces: countsSchema,
  kit: z.object({ state: z.enum(KIT_STATES), planned: z.number(), sent: z.number(), cancelled: z.number() }),
  currency: z.string(),
  /** Minor units; a cost (absent without the cost grain). */
  netAmount: z.number().optional(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
}
export const orderRowSchema = z.object(summary)
export type OrderRow = z.infer<typeof orderRowSchema>

/** The list's filters: one status, or the open ones (default), and the tiles' own filters (the same rules as the tiles). */
export interface OrderQuery {
  status?: OrderStatus
  /** false: every status (the default reads the open ones). */
  open?: boolean
  partyId?: string
  workOrderId?: string
  siteId?: string
  late?: boolean
  kitToSend?: boolean
  atWorkshop?: boolean
  dueThisWeek?: boolean
  q?: string
  cursor?: string | null
  limit?: number
}

const pageSchema = z.object({ items: z.array(orderRowSchema), nextCursor: z.string().nullable() })
export type OrderPage = z.infer<typeof pageSchema>

export function listOrders(api: ApiClient, query: OrderQuery, signal?: AbortSignal): Promise<OrderPage> {
  const { open, late, kitToSend, atWorkshop, dueThisWeek, ...rest } = query
  return api.get('/purchasing/subcontracting/orders', {
    query: clean({ ...rest, q: query.q?.trim(), open: open === false ? 'false' : undefined, late: late ? 'true' : undefined, kitToSend: kitToSend ? 'true' : undefined, atWorkshop: atWorkshop ? 'true' : undefined, dueThisWeek: dueThisWeek ? 'true' : undefined, limit: query.limit ?? 50 }),
    schema: pageSchema,
    signal,
  })
}

const tileCountsSchema = z.object({ kitToSend: z.number(), atWorkshops: z.number(), dueBackThisWeek: z.number(), late: z.number() })
export type TileCounts = z.infer<typeof tileCountsSchema>

export function orderCounts(api: ApiClient, query: { siteId?: string | null; partyId?: string | null } = {}, signal?: AbortSignal): Promise<TileCounts> {
  return api.get('/purchasing/subcontracting/orders/counts', { query: clean(query), schema: tileCountsSchema, signal })
}

// ---- the record ---------------------------------------------------------------------------------------------------------------

const sizeSchema = z.object({ workOrderSizeId: z.string(), colourway: z.string(), size: z.string(), pieces: z.number() })
export type OperationSize = z.infer<typeof sizeSchema>

const operationSchema = z.object({
  id: z.string(),
  seq: z.number(),
  workOrderOperation: z.object({ id: z.string(), seq: z.number(), code: z.string(), name: z.string() }),
  pieces: z.number(),
  sizes: z.array(sizeSchema),
  /** A cost (absent without the cost grain). */
  pricePerPiece: z.string().optional(),
  netAmount: z.number().optional(),
  expectedBackDate: z.string().nullable(),
  piecesSent: z.number(),
  piecesBackGood: z.number(),
  piecesBackDefective: z.number(),
  piecesScrapped: z.number(),
  atWorkshop: z.number(),
  note: z.string().nullable(),
  version: z.number(),
})
export type Operation = z.infer<typeof operationSchema>

const uom = z.string()
const kitLineSchema = z.object({
  id: z.string(),
  seq: z.number(),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), baseUom: uom, tracking: z.enum(['NONE', 'LOT', 'HIDE', 'SERIAL']) }),
  colour: ref.nullable(),
  lot: z.object({ id: z.string(), code: z.string(), qualityStatus: z.string() }).nullable(),
  hide: z.object({ id: z.string(), code: z.string() }).nullable(),
  quantity: z.string(),
  uom,
  baseQuantity: z.string(),
  status: z.enum(KIT_LINE_STATUSES),
  sentAt: z.string().nullable(),
  moveId: z.string().nullable(),
  ddt: z.object({ id: z.string(), number: z.string(), cancelled: z.boolean() }).nullable(),
  note: z.string().nullable(),
  version: z.number(),
})
export type KitLine = z.infer<typeof kitLineSchema>

export const receiptSchema = z.object({
  id: z.string(),
  receivedAt: z.string(),
  recordedAt: z.string(),
  byId: z.string().nullable(),
  lines: z.array(
    z.object({
      operationId: z.string(),
      seq: z.number(),
      code: z.string(),
      bundle: z.object({ id: z.string(), code: z.string(), workOrderSizeId: z.string(), colourway: z.string(), size: z.string() }).nullable(),
      good: z.number(),
      defective: z.number(),
      scrapped: z.number(),
      reason: z.string().nullable(),
    }),
  ),
  returns: z.array(z.object({ moveId: z.string(), item: ref, colour: ref.nullable(), lot: ref.nullable(), hide: ref.nullable(), quantity: z.string(), uom, toLocation: ref })),
  supplierDdt: z.object({ number: z.string(), date: z.string().nullable() }).nullable(),
  note: z.string().nullable(),
})
export type Receipt = z.infer<typeof receiptSchema>

const held = z.string().nullable()
export const orderSchema = z.object({
  ...summary,
  note: z.string().nullable(),
  internalNote: z.string().nullable(),
  issuedAt: z.string().nullable(),
  issuedById: z.string().nullable(),
  closedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  operations: z.array(operationSchema),
  kitLines: z.array(kitLineSchema),
  receipts: z.array(receiptSchema),
  ddts: z.array(z.object({ id: z.string(), number: z.string(), documentDate: z.string(), cancelled: z.boolean(), kitLineIds: z.array(z.string()) })),
  /** null: the act may be done (the person's permission aside); else why not, in the API's English (never drawn). */
  actions: z.object({ issue: held, reopen: held, cancel: held, close: held, send: held, receive: held }),
})
export type SubcontractOrder = z.infer<typeof orderSchema>
export type OrderAction = keyof SubcontractOrder['actions']
const one = z.object({ order: orderSchema })

export function getOrder(api: ApiClient, id: string, signal?: AbortSignal): Promise<SubcontractOrder> {
  return api.get(`/purchasing/subcontracting/orders/${enc(id)}`, { schema: one, signal }).then((answer) => answer.order)
}

// ---- a new order ----------------------------------------------------------------------------------------------------------------

const choiceSchema = workOrderRef.extend({ companyId: z.string(), site: z.object({ id: z.string(), code: z.string() }), garments: z.number(), outsideSteps: z.number(), liveOrders: z.number() })
export type WorkOrderChoice = z.infer<typeof choiceSchema>

/** The released and running work orders a new order may be made for (purchasing.view), by number or style. */
export function findWorkOrders(api: ApiClient, q: string, signal?: AbortSignal): Promise<WorkOrderChoice[]> {
  return api.get('/purchasing/subcontracting/work-orders', { query: clean({ q: q.trim(), limit: 20 }), schema: z.object({ items: z.array(choiceSchema) }), signal }).then((answer) => answer.items)
}

const outsideSchema = z.object({
  workOrder: workOrderRef.extend({ companyId: z.string(), siteId: z.string() }),
  cells: z.array(z.object({ workOrderSizeId: z.string(), colourway: z.string(), size: z.string(), quantity: z.number() })),
  operations: z.array(
    z.object({
      id: z.string(),
      seq: z.number(),
      code: z.string(),
      name: z.string(),
      outside: z.object({ workshop: ref.nullable(), pricePerPiece: cost, transitDays: z.number().nullable() }).nullable(),
      ordered: z.number(),
    }),
  ),
  workshops: z.array(ref.extend({ locations: z.array(ref) })),
  orders: z.array(z.object({ id: z.string(), number: z.string(), status })),
})
export type OutsideOperations = z.infer<typeof outsideSchema>

export function outsideOperations(api: ApiClient, workOrderId: string, signal?: AbortSignal): Promise<OutsideOperations> {
  return api.get(`/purchasing/subcontracting/work-orders/${enc(workOrderId)}/outside-operations`, { schema: outsideSchema, signal })
}

const workshopSchema = z.object({ id: z.string(), code: z.string(), legalName: z.string(), tradeName: z.string().nullable(), roles: z.array(z.string()), status: z.string(), companyId: z.string().nullable() })
export type WorkshopOption = z.infer<typeof workshopSchema>

/** Active subcontractors (parties.view): "qualified only" is W2b (no qualification yet), so ACTIVE stands for it. */
export function findWorkshops(api: ApiClient, q: string, signal?: AbortSignal): Promise<WorkshopOption[]> {
  return api.get('/parties', { query: clean({ q: q.trim(), role: 'SUBCONTRACTOR', status: 'ACTIVE', limit: 20 }), schema: z.object({ parties: z.array(workshopSchema) }), signal }).then((answer) => answer.parties)
}

export interface NewOperation {
  workOrderOperationId: string
  pieces?: number
  sizes?: { workOrderSizeId: string; pieces: number }[]
  pricePerPiece?: string
  expectedBackDate?: string | null
}

export interface NewOrderBody {
  workOrderId: string
  partyId?: string
  orderDate?: string
  expectedBackDate?: string | null
  note?: string | null
  operations: NewOperation[]
  planKit?: boolean
}

export function createOrder(api: ApiClient, body: NewOrderBody, idempotencyKey: string): Promise<SubcontractOrder> {
  return api.post('/purchasing/subcontracting/orders', { body, schema: one, idempotencyKey }).then((answer) => answer.order)
}

// ---- changes (each with the order's version) -------------------------------------------------------------------------------------

export interface HeaderPatch {
  expectedBackDate?: string | null
  orderDate?: string
  partyId?: string
  note?: string | null
  internalNote?: string | null
}

export function updateOrder(api: ApiClient, id: string, version: number, patch: HeaderPatch, idempotencyKey: string): Promise<SubcontractOrder> {
  return api.request('PATCH', `/purchasing/subcontracting/orders/${enc(id)}`, { body: { version, ...patch }, schema: one, idempotencyKey }).then((answer) => answer.order)
}

export interface OperationPatch {
  pieces?: number
  sizes?: { workOrderSizeId: string; pieces: number }[]
  pricePerPiece?: string
  expectedBackDate?: string | null
  note?: string | null
}

export function addOperation(api: ApiClient, id: string, version: number, body: NewOperation, idempotencyKey: string): Promise<SubcontractOrder> {
  return api.post(`/purchasing/subcontracting/orders/${enc(id)}/operations`, { body: { version, ...body }, schema: one, idempotencyKey }).then((answer) => answer.order)
}

export function editOperation(api: ApiClient, id: string, operationId: string, version: number, patch: OperationPatch, idempotencyKey: string): Promise<SubcontractOrder> {
  return api.request('PATCH', `/purchasing/subcontracting/orders/${enc(id)}/operations/${enc(operationId)}`, { body: { version, ...patch }, schema: one, idempotencyKey }).then((answer) => answer.order)
}

export function removeOperation(api: ApiClient, id: string, operationId: string, version: number, idempotencyKey: string): Promise<SubcontractOrder> {
  return api.request('DELETE', `/purchasing/subcontracting/orders/${enc(id)}/operations/${enc(operationId)}`, { query: { version }, schema: one, idempotencyKey }).then((answer) => answer.order)
}

export interface KitLineInput {
  itemId: string
  itemColourId?: string | null
  lotId?: string | null
  hideId?: string | null
  quantity: string
  uom?: string
  note?: string | null
}

export function addKitLines(api: ApiClient, id: string, version: number, lines: KitLineInput[], idempotencyKey: string): Promise<SubcontractOrder> {
  return api.post(`/purchasing/subcontracting/orders/${enc(id)}/kit`, { body: { version, lines }, schema: one, idempotencyKey }).then((answer) => answer.order)
}

export function planKit(api: ApiClient, id: string, version: number, idempotencyKey: string): Promise<SubcontractOrder> {
  return api.post(`/purchasing/subcontracting/orders/${enc(id)}/kit/from-work-order`, { body: { version }, schema: one, idempotencyKey }).then((answer) => answer.order)
}

export function editKitLine(api: ApiClient, id: string, lineId: string, version: number, patch: { quantity?: string; uom?: string; lotId?: string | null; hideId?: string | null; note?: string | null }, idempotencyKey: string): Promise<SubcontractOrder> {
  return api.request('PATCH', `/purchasing/subcontracting/orders/${enc(id)}/kit/${enc(lineId)}`, { body: { version, ...patch }, schema: one, idempotencyKey }).then((answer) => answer.order)
}

export function removeKitLine(api: ApiClient, id: string, lineId: string, version: number, idempotencyKey: string): Promise<SubcontractOrder> {
  return api.request('DELETE', `/purchasing/subcontracting/orders/${enc(id)}/kit/${enc(lineId)}`, { query: { version }, schema: one, idempotencyKey }).then((answer) => answer.order)
}

export type OrderAct = 'issue' | 'reopen' | 'cancel' | 'close'

export function actOn(api: ApiClient, id: string, act: OrderAct, version: number, extra: { reason?: string; note?: string | null }, idempotencyKey: string): Promise<SubcontractOrder> {
  return api.post(`/purchasing/subcontracting/orders/${enc(id)}/${act}`, { body: { version, ...extra }, schema: one, idempotencyKey }).then((answer) => answer.order)
}

// ---- kit out and goods back --------------------------------------------------------------------------------------------------------

/** The DDT for work on our behalf (B-W2a-17's source request without the version: the kit send carries the order's). */
export interface KitDdtRequest {
  reason?: KitDdtReason
  reasonText?: string | null
  transportBy: TransportBy
  carrier?: { name: string; vatNumber?: string | null } | null
  startAt?: string | null
  appearance?: string | null
  packages: number
  grossWeightKg: string
  netWeightKg?: string | null
  freight?: 'FREE' | 'FORWARD' | null
  remarks?: string | null
  otherGoods?: { code?: string | null; description: string; quantity: string; uom: string }[]
}

export interface SendKitBody {
  version: number
  lines: { lineId: string; fromLocationId: string; lotId?: string | null; hideId?: string | null; quantity?: string; uom?: string }[]
  pieces: { operationId: string; pieces: number }[]
  bundles: { bundleId: string }[]
  ddt: KitDdtRequest | null
}

const sendAnswerSchema = z.object({
  order: orderSchema,
  moveIds: z.array(z.string()),
  ddt: z.object({ id: z.string(), number: z.string(), file: z.object({ id: z.string() }).nullable(), pdfProblem: z.string().nullable() }).nullable(),
})
export type SendKitAnswer = z.infer<typeof sendAnswerSchema>

export function sendKit(api: ApiClient, id: string, body: SendKitBody, idempotencyKey: string): Promise<SendKitAnswer> {
  return api.post(`/purchasing/subcontracting/orders/${enc(id)}/kit/send`, { body, schema: sendAnswerSchema, idempotencyKey })
}

export function returnKitLine(api: ApiClient, id: string, lineId: string, version: number, reason: string, idempotencyKey: string): Promise<SubcontractOrder> {
  return api.post(`/purchasing/subcontracting/orders/${enc(id)}/kit/${enc(lineId)}/return`, { body: { version, reason }, schema: one, idempotencyKey }).then((answer) => answer.order)
}

export interface ReceiveBody {
  version: number
  receivedAt?: string
  lines: { operationId: string; bundleId?: string; good: number; defective: number; scrapped: number; reason?: string | null }[]
  returns: { itemId: string; itemColourId?: string | null; lotId?: string | null; hideId?: string | null; quantity: string; uom?: string; toLocationId: string }[]
  supplierDdt?: { number: string; date?: string | null } | null
  note?: string | null
}

const receiveAnswerSchema = z.object({ order: orderSchema, receipt: receiptSchema, ledger: z.object({ posted: z.number(), waiting: z.array(z.string()) }) })
export type ReceiveAnswer = z.infer<typeof receiveAnswerSchema>

export function receiveBack(api: ApiClient, id: string, body: ReceiveBody, idempotencyKey: string): Promise<ReceiveAnswer> {
  return api.post(`/purchasing/subcontracting/orders/${enc(id)}/receive`, { body, schema: receiveAnswerSchema, idempotencyKey })
}

// ---- stock at the subcontractors (SCR-129) -----------------------------------------------------------------------------------------

const stockRowSchema = z.object({
  site: z.object({ id: z.string(), code: z.string() }),
  workshop: ref,
  location: ref,
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), baseUom: uom }),
  colour: ref.nullable(),
  lot: z.object({ id: z.string(), code: z.string(), qualityStatus: z.string() }).nullable(),
  hide: ref.nullable(),
  onHand: z.string(),
  lastSentAt: z.string().nullable(),
  unitCost: cost,
  value: z.number().nullable().optional(),
  currency: z.string(),
})
export type WorkshopStockRow = z.infer<typeof stockRowSchema>
const stockSchema = z.object({
  rows: z.array(stockRowSchema),
  workshops: z.array(z.object({ workshop: ref, location: ref, site: z.object({ id: z.string(), code: z.string() }), lines: z.number(), value: z.number().nullable().optional() })),
  truncated: z.boolean(),
})
export type WorkshopStock = z.infer<typeof stockSchema>

export function workshopStock(api: ApiClient, query: { siteId?: string | null; partyId?: string | null; locationId?: string | null; itemId?: string | null } = {}, signal?: AbortSignal): Promise<WorkshopStock> {
  return api.get('/purchasing/subcontracting/stock', { query: clean(query), schema: stockSchema, signal })
}

// ---- the kit's DDTs (B-W2a-17's /shipping/ddts: source DDTs) -----------------------------------------------------------------------

/** The issued DDT's PDF: a presigned GET (files.read too). */
export function ddtPdfLink(api: ApiClient, ddtId: string): Promise<Presigned> {
  return api.get(`/shipping/ddts/${enc(ddtId)}/pdf`, { schema: z.object({ download: presignedSchema }) }).then((answer) => answer.download)
}

/** Prints a missing PDF of an issued DDT again (the DDT itself never changes). */
export function printDdtAgain(api: ApiClient, ddtId: string): Promise<unknown> {
  return api.post(`/shipping/ddts/${enc(ddtId)}/pdf`, { body: {}, schema: z.object({ file: z.object({ id: z.string() }) }) })
}

/** Annuls a kit DDT (its number stays, "annulled"): the version is the ORDER's, checked under its lock. */
export function annulDdt(api: ApiClient, ddtId: string, version: number, reason: string, idempotencyKey: string): Promise<unknown> {
  return api.post(`/shipping/ddts/${enc(ddtId)}/cancel`, { body: { version, reason }, schema: z.object({ ddt: z.object({ id: z.string() }) }), idempotencyKey })
}

// ---- reads for the dialogs -----------------------------------------------------------------------------------------------------------

const bundleSchema = z.object({ id: z.string(), code: z.string(), workOrderSizeId: z.string(), colourwayCode: z.string(), size: z.string(), part: z.string().nullable(), quantity: z.number(), status: z.enum(['ACTIVE', 'VOID']) })
export type BundleOption = z.infer<typeof bundleSchema>

/** The work order's bundles (workorders.view): the cut pieces that travel to the workshop and come back from it. */
export function workOrderBundles(api: ApiClient, workOrderId: string, signal?: AbortSignal): Promise<BundleOption[]> {
  return api
    .get(`/production/bundles/work-orders/${enc(workOrderId)}/bundles`, { schema: z.object({ bundles: z.array(bundleSchema) }), signal })
    .then((answer) => answer.bundles.filter((bundle) => bundle.status === 'ACTIVE'))
}
