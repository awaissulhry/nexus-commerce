import { z } from 'zod'
import { COUNTER_STATES } from '@nexus/factory-domain/sales/change-requests/counter'
import { ORDER_REQUEST_KINDS, REQUEST_STATUSES } from '@nexus/factory-domain/sales/change-requests/rules'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/**
 * F-PR-08 — a customer's requests in Home › Approvals, every call (production plan §3 "Brand asks, we decide", §5 "Home › Approvals:
 * the one place brand requests are answered"; lead picks L4, L26; review fixes R-08, R-23, R-64). Each answer's shape is checked
 * (unknown fields dropped; a field the API adds never breaks the page). Money comes in minor units and only with the price grain:
 * the API leaves the key out for a reader without it, so every amount here is optional — and the web never sends a fee without it.
 *
 *   read      GET /production/brand-requests?status=WAITING (B-PR-26; orders.view or workorders.view over the request's company AND
 *             customer: the brand wall is the API's — a person limited to some customers gets only theirs, PW-H01); never a
 *             customer filter from here. GET …/:requestId (the request, our counter's approval, its batch's others), GET
 *             …/:requestId/impact (what the customer saw at Send and the same read now), GET ?batchId= (a batch's requests).
 *             Another customer's request answers 404 "not found" in words that name nobody (PW-H01b).
 *   answer    CHANGE, CANCEL, SPLIT_SHIPMENT: Sales' POST /sales/change-requests/:id/accept|refuse (orders.manage); RUSH, HOLD,
 *             RESUME, SAMPLE_ROUND: POST /production/brand-requests/:id/accept|refuse (B-PR-27a/b; RUSH {rushFloor}: "Accept as
 *             urgent" or "Accept and rush the floor"); every kind but a resume: POST …/:id/counter ("Suggest something else");
 *             a batch: POST /production/brand-requests/batches/:batchId/accept|refuse {items [{requestId, version}]} (B-PR-46a),
 *             each request at the version read, through its own kind's path.
 */

const words = z.object({ it: z.string(), en: z.string() })
export type Words = z.infer<typeof words>
const named = z.object({ code: z.string(), name: z.string() })
const price = z.number().optional()

export { ORDER_REQUEST_KINDS, REQUEST_STATUSES }
export type OrderRequestKind = (typeof ORDER_REQUEST_KINDS)[number]
export type RequestStatus = (typeof REQUEST_STATUSES)[number]

const cellSchema = z.object({
  lineId: z.string(),
  seq: z.number(),
  style: named.nullable(),
  colourway: named.nullable(),
  /** null: the line as a whole (a line cancelled). */
  size: z.string().nullable(),
  /** The pieces when it was asked, and the pieces asked (0: none). */
  before: z.number(),
  asked: z.number(),
  askedColourway: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable().optional(),
})
export type RequestCell = z.infer<typeof cellSchema>

/** The impact of an ask (what is frozen, priced or not — never an amount —, the earliest date), kept at Send or read now. */
export const impactSchema = z.object({
  kind: z.enum(ORDER_REQUEST_KINDS),
  frozen: z.array(z.object({ field: z.string(), lineId: z.string().nullable(), line: z.string().nullable(), size: z.string().nullable(), state: z.string(), words })),
  blocked: z.boolean(),
  priced: z.boolean(),
  pricedWords: words.nullable(),
  earliest: z.object({ date: z.string().nullable(), partial: z.boolean(), meetsWanted: z.boolean().nullable(), words }).nullable(),
  notes: z.array(words),
  words,
})
export type RequestImpact = z.infer<typeof impactSchema>

const cancelFeeSchema = z.object({ pct: z.string().nullable(), words, currency: z.string(), totalFee: price })

/** Our counter-offer on the request (the fee: a price, dropped without the grain; `priced` says one applies). */
const counterSchema = z.object({
  approvalRequestId: z.string(),
  at: z.string(),
  date: z.string().nullable(),
  fee: z.number().nullable().optional(),
  note: z.string().nullable(),
  priced: z.boolean(),
  offer: words,
  state: z.enum(COUNTER_STATES),
  words,
})

/** One customer request as the office reads it (the customer's view of it + who answers its kind, where, what this reader may do). */
export const brandRequestSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  orderNumber: z.string(),
  customerRef: z.string().nullable(),
  kind: z.enum(ORDER_REQUEST_KINDS),
  status: z.enum(REQUEST_STATUSES),
  askedAt: z.string(),
  cells: z.array(cellSchema),
  wholeOrder: z.boolean(),
  requestedDate: z.string().nullable(),
  shipTo: z.object({ id: z.string(), label: z.string() }).nullable(),
  reasonCode: z.string().nullable(),
  reasonWords: words.nullable(),
  /** The customer's own words. */
  note: z.string().nullable(),
  /** Our words to the customer (never who answered, on their side). */
  answer: z.string().nullable(),
  answeredAt: z.string().nullable(),
  withdrawnAt: z.string().nullable(),
  cancelFee: cancelFeeSchema.nullable(),
  impact: impactSchema.nullable(),
  sampleKind: z.string().nullable(),
  batchId: z.string().nullable(),
  counter: counterSchema.nullable(),
  version: z.number(),
  companyId: z.string(),
  party: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  askedBy: z.string().nullable(),
  answeredBy: z.string().nullable(),
  /** The permission that answers this kind (orders.manage, production.brand.manage, sales.samples.manage). */
  answeredWith: z.string(),
  /** Where its accept goes: SALES (/sales/change-requests) or PRODUCTION (/production/brand-requests). */
  answeredIn: z.enum(['SALES', 'PRODUCTION']),
  acceptWords: words,
  waitingOn: z.enum(['US', 'CUSTOMER']).nullable(),
  standing: words,
  may: z.object({ accept: z.boolean(), refuse: z.boolean(), counter: z.boolean(), counterWithPrice: z.boolean() }),
  batch: z.object({ id: z.string(), count: z.number(), waiting: z.number() }).nullable(),
})
export type BrandRequest = z.infer<typeof brandRequestSchema>

const listSchema = z.object({
  asOf: z.string(),
  items: z.array(brandRequestSchema),
  count: z.number(),
  waitingByKind: z.array(z.object({ kind: z.enum(ORDER_REQUEST_KINDS), count: z.number() })),
})
export type BrandRequestList = z.infer<typeof listSchema>

/** At most what the API reads in one page (its READ_CAP). */
export const REQUEST_READ_LIMIT = 200

/**
 * What waits (OPEN and COUNTERED), oldest first, as far as this reader reaches: the inbox's 'Customer request' source. No customer,
 * company or kind filter is sent: the API's wall decides whose requests come back (PW-H01).
 */
export function listWaitingRequests(api: ApiClient, signal?: AbortSignal): Promise<BrandRequestList> {
  return api.get('/production/brand-requests', { query: { status: 'WAITING', limit: REQUEST_READ_LIMIT }, schema: listSchema, signal })
}

/** One batch's requests, every state (the batch window lists them all, the answered ones with their state). */
export async function listBatch(api: ApiClient, batchId: string, signal?: AbortSignal): Promise<BrandRequest[]> {
  return (await api.get('/production/brand-requests', { query: { batchId, status: 'ALL', limit: REQUEST_READ_LIMIT }, schema: listSchema, signal })).items
}

const recordSchema = z.object({
  asOf: z.string(),
  request: brandRequestSchema,
  /** Our counter-offer's approval request and the customer's answer (their words, the name they signed). */
  counterApproval: z.object({ id: z.string(), status: z.string(), dueAt: z.string(), answeredAt: z.string().nullable(), typedName: z.string().nullable(), answer: z.string().nullable() }).nullable(),
  /** The other requests of its batch the reader reaches. */
  batch: z.array(z.object({ id: z.string(), orderId: z.string(), orderNumber: z.string(), status: z.enum(REQUEST_STATUSES), version: z.number() })),
})
export type RequestRecord = z.infer<typeof recordSchema>

const requestPath = (requestId: string) => `/production/brand-requests/${encodeURIComponent(requestId)}`

export function getRequest(api: ApiClient, requestId: string, signal?: AbortSignal): Promise<RequestRecord> {
  return api.get(requestPath(requestId), { schema: recordSchema, signal })
}

const workOrderSeen = z.object({ id: z.string(), number: z.string(), status: z.string(), held: z.boolean(), mixed: z.boolean() })

const impactReadSchema = z.object({
  asOf: z.string(),
  request: z.object({ id: z.string(), kind: z.enum(ORDER_REQUEST_KINDS), status: z.enum(REQUEST_STATUSES), version: z.number() }),
  /** What the customer saw before Send (null: asked before the impact was kept). */
  kept: impactSchema.nullable(),
  /** The same impact read now. */
  now: impactSchema,
  /** The order's work orders this reader reaches; the others only counted (never named). */
  workOrders: z.array(workOrderSeen),
  workOrdersNotShown: z.number(),
  cancelFee: cancelFeeSchema.nullable(),
})
export type RequestImpactRead = z.infer<typeof impactReadSchema>

export function getImpact(api: ApiClient, requestId: string, signal?: AbortSignal): Promise<RequestImpactRead> {
  return api.get(`${requestPath(requestId)}/impact`, { schema: impactReadSchema, signal })
}

// ---- answers --------------------------------------------------------------------------------------------------------------------

const acceptedWorkOrder = z.object({ id: z.string(), number: z.string(), status: z.string(), changed: z.boolean() })
export type AcceptedWorkOrder = z.infer<typeof acceptedWorkOrder>

/** What a production accept did (B-PR-27a/b): the work orders paused or resumed, the urgency, the rush, the re-promise, the round. */
const doneSchema = z.object({
  kind: z.enum(ORDER_REQUEST_KINDS),
  paused: z.array(acceptedWorkOrder),
  resumed: z.array(acceptedWorkOrder),
  urgency: z.object({ urgency: z.enum(['URGENT', 'REGULAR']), already: z.boolean(), use: z.object({ words }) }).nullable(),
  rushed: z.array(acceptedWorkOrder),
  rushSkipped: words.nullable(),
  repromise: z.object({ proposals: z.array(z.object({ id: z.string() })), skipped: z.array(z.object({ orderLineId: z.string(), seq: z.number(), words })) }).nullable(),
  sampleRound: z.object({ id: z.string(), number: z.string(), kind: z.string() }).nullable(),
  words,
})
export type AcceptDone = z.infer<typeof doneSchema>

/** Sales' accept (a change, a cancel, ship what is ready): the order cancelled or not, the split's re-promise in words. */
const salesAcceptSchema = z.object({
  orderCancelled: z.boolean(),
  split: z.object({ shipComplete: z.boolean(), proposals: z.array(z.object({ id: z.string() })), skipped: z.array(z.object({ orderLineId: z.string(), seq: z.number(), words })), words }).nullable(),
})
export type SalesAccept = z.infer<typeof salesAcceptSchema>

export interface AcceptBody {
  readonly version: number
  /** Our words to the customer (optional on an accept). */
  readonly answer: string | null
  /** RUSH only: "Accept and rush the floor" (true) or "Accept as urgent" (false). */
  readonly rushFloor?: boolean
}

const answerOrNull = (answer: string | null): string | null => (answer && answer.trim() ? answer.trim() : null)

/** A production kind's accept (RUSH, HOLD, RESUME, SAMPLE_ROUND) — it carries the ask out in one command. */
export async function acceptProduction(api: ApiClient, requestId: string, body: AcceptBody, idempotencyKey: string = newIdempotencyKey()): Promise<AcceptDone> {
  const sent = { version: body.version, answer: answerOrNull(body.answer), ...(body.rushFloor !== undefined ? { rushFloor: body.rushFloor } : {}) }
  return (await api.post(`${requestPath(requestId)}/accept`, { body: sent, schema: z.object({ done: doneSchema }), idempotencyKey })).done
}

/** Sales' accept (CHANGE, CANCEL, SPLIT_SHIPMENT): the amendment, the cancel or close-short, ship what is ready. */
export function acceptSales(api: ApiClient, requestId: string, body: AcceptBody, idempotencyKey: string = newIdempotencyKey()): Promise<SalesAccept> {
  return api.post(`/sales/change-requests/${encodeURIComponent(requestId)}/accept`, { body: { version: body.version, answer: answerOrNull(body.answer) }, schema: salesAcceptSchema, idempotencyKey })
}

/** A refusal with the words the customer reads (required): Sales' route for its kinds, production's for the others. */
export async function refuseRequest(api: ApiClient, request: Pick<BrandRequest, 'id' | 'answeredIn'>, body: { readonly version: number; readonly answer: string }, idempotencyKey: string = newIdempotencyKey()): Promise<void> {
  const path = request.answeredIn === 'SALES' ? `/sales/change-requests/${encodeURIComponent(request.id)}/refuse` : `${requestPath(request.id)}/refuse`
  await api.post(path, { body: { version: body.version, answer: body.answer.trim() }, schema: z.object({ request: z.object({ id: z.string() }) }), idempotencyKey })
}

export interface CounterBody {
  readonly version: number
  /** The date we offer (from today on), or null. */
  readonly date: string | null
  /** A price in minor units of the order's currency (0: explicitly free) — only from a reader with the price grain; else left out. */
  readonly fee?: number
  /** Our words to the customer. */
  readonly note: string | null
}

/** "Suggest something else": a counter-offer the customer answers in Waiting for you (B-PR-26). */
export function counterRequest(api: ApiClient, requestId: string, body: CounterBody, idempotencyKey: string = newIdempotencyKey()): Promise<{ approvalRequestId: string }> {
  const sent = { version: body.version, date: body.date, note: body.note, ...(body.fee !== undefined ? { fee: body.fee } : {}) }
  return api.post(`${requestPath(requestId)}/counter`, { body: sent, schema: z.object({ approvalRequestId: z.string() }), idempotencyKey })
}

// ---- a customer's batch (B-PR-46a) -----------------------------------------------------------------------------------------------

const batchAnswerSchema = z.object({
  batchId: z.string(),
  results: z.array(z.object({ requestId: z.string(), orderId: z.string(), orderNumber: z.string(), done: z.boolean(), words: words.nullable(), problem: z.object({ code: z.string(), message: z.string() }).nullable() })),
  notFound: z.number(),
})
export type BatchAnswer = z.infer<typeof batchAnswerSchema>

export interface BatchItem {
  readonly requestId: string
  readonly version: number
}

/** Accept all the named requests of one batch, each at the version read and through its own kind's accept (RUSH: rushFloor). */
export function acceptBatch(api: ApiClient, batchId: string, body: { readonly items: readonly BatchItem[]; readonly answer: string | null; readonly rushFloor?: boolean }, idempotencyKey: string = newIdempotencyKey()): Promise<BatchAnswer> {
  const sent = { items: body.items.map((item) => ({ requestId: item.requestId, version: item.version })), answer: answerOrNull(body.answer), ...(body.rushFloor !== undefined ? { rushFloor: body.rushFloor } : {}) }
  return api.post(`/production/brand-requests/batches/${encodeURIComponent(batchId)}/accept`, { body: sent, schema: batchAnswerSchema, idempotencyKey })
}

/** Refuse all the named requests of one batch with the same words the customer reads. */
export function refuseBatch(api: ApiClient, batchId: string, body: { readonly items: readonly BatchItem[]; readonly answer: string }, idempotencyKey: string = newIdempotencyKey()): Promise<BatchAnswer> {
  return api.post(`/production/brand-requests/batches/${encodeURIComponent(batchId)}/refuse`, { body: { items: body.items.map((item) => ({ requestId: item.requestId, version: item.version })), answer: body.answer.trim() }, schema: batchAnswerSchema, idempotencyKey })
}
