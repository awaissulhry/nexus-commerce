import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { orderSchema, type Order } from '../api'

/**
 * B-W2b-323 — the calls of the orders in depth (Sales › Orders, SCR-038 and SCR-039) on the merged APIs of B-W2b-303 (priority,
 * season, the yes an order waits for, the confirmation), B-W2b-309 (what is frozen, priced changes, the customer's own
 * materials, the deposit kinds), B-W2b-317 (the promises and the planned finish), B-W2b-263 (the milestones) and B-W2b-295 (the
 * brand tech pack in force). Every shape keeps what the screens read; the API's English (`words`, `why`, `message`) is dropped
 * or read only for WHETHER: the screens say their own words from codes and facts. Money is optional (the price grain).
 */

const seg = (value: string) => encodeURIComponent(value)
const orderPath = (id: string) => `/sales/orders/${seg(id)}`

export const PRIORITY_LEVELS = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number]
export const SEASON_STATUSES = ['OPEN', 'CLOSED'] as const
export const SEASON_STATES = ['OPEN', 'BOOK_CLOSED', 'ENDED', 'CLOSED'] as const
// B-W2b-368 (XF1:02): MEASUREMENTS, the factory review of a made-to-measure unit's measures (the order record's review banner).
export const WAIT_REASONS = ['REQUEST_PENDING', 'NO_REQUEST', 'CREDIT_HOLD', 'MEASUREMENTS'] as const
export type WaitReason = (typeof WAIT_REASONS)[number]
export const FREEZE_FIELDS = ['SIZE_QUANTITY', 'COLOURWAY', 'OPTION', 'DELIVERY_DATE', 'SHIP_TO', 'PRICE'] as const
export type FreezeField = (typeof FREEZE_FIELDS)[number]
export const FREEZE_STAGES = ['RELEASED', 'CUT', 'SEWING', 'FINISHED', 'SHIPPED'] as const
export type FreezeStage = (typeof FREEZE_STAGES)[number]
export const FREEZE_STATES = ['OPEN', 'CHANGE_REQUEST', 'BLOCKED'] as const
export type FreezeState = (typeof FREEZE_STATES)[number]
export const CHANGE_YES_STATES = ['NOT_ASKED', 'WAITING', 'APPROVED', 'TURNED_DOWN', 'STALE', 'WITHDRAWN'] as const
export type ChangeYesState = (typeof CHANGE_YES_STATES)[number]
export const CUSTOMER_DECISIONS = ['NOT_NEEDED', 'NOT_ASKED', 'WAITING', 'ACCEPTED', 'REFUSED', 'EXPIRED', 'WITHDRAWN'] as const
export type CustomerDecision = (typeof CUSTOMER_DECISIONS)[number]
/** The deposit kinds an extra deposit may take; the third stays off until the accountant confirms it (GATE-ACCOUNTANT). */
export const EXTRA_DEPOSIT_KINDS = ['ACCONTO', 'CAPARRA', 'CAPARRA_PENITENZIALE'] as const
export type ExtraDepositKind = (typeof EXTRA_DEPOSIT_KINDS)[number]
export const YES_PREVIEWS = ['WOULD_ASK', 'NO_RULE', 'NOBODY_TO_ASK'] as const
export const FINISH_SOURCES = ['STOCK', 'BOARD', 'WORK_ORDER_DUE', 'PLANNED_ORDER', 'CAPABLE', 'NONE'] as const
export type FinishSource = (typeof FINISH_SOURCES)[number]
export const RISK_STATES = ['LATE', 'AT_RISK', 'NOT_PROMISED', 'ON_TIME'] as const
export type RiskState = (typeof RISK_STATES)[number]

const instant = z.string()
const day = z.string()
const levelSchema = z.enum(PRIORITY_LEVELS)
const priority = z.object({ level: levelSchema, urgentReason: z.string().nullable(), number: z.number() })

// ---- B-W2b-303: depth, priority, season, the yes, the confirmation -------------------------------------------------------

const seasonRef = z.object({ id: z.string(), code: z.string(), name: z.string(), status: z.enum(SEASON_STATUSES) })

export const orderDepthSchema = z.object({
  orderId: z.string(),
  number: z.string(),
  status: z.string(),
  priority,
  season: seasonRef.nullable(),
  waiting: z.object({ requestTaskId: z.string().nullable(), creditHold: z.boolean() }).nullable(),
  confirmation: z.object({ versions: z.number(), sentAt: instant.nullable(), sentVersion: z.number().nullable() }),
  sameQuote: z.array(z.object({ id: z.string(), number: z.string(), status: z.string() })),
})
export type OrderDepth = z.infer<typeof orderDepthSchema>

export function getOrderDepth(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<OrderDepth> {
  return api.get(`${orderPath(orderId)}/depth`, { schema: orderDepthSchema, signal })
}

export const rowDepthSchema = z.object({
  orderId: z.string(),
  number: z.string(),
  priority,
  season: z.object({ id: z.string(), code: z.string() }).nullable(),
  waitingForYes: z.boolean(),
  requestPending: z.boolean(),
  confirmationSentAt: instant.nullable(),
})
export type RowDepth = z.infer<typeof rowDepthSchema>

/** The list rows' W2b columns (at most 200 ids a read). */
export async function getRowsDepth(api: ApiClient, orderIds: readonly string[], signal?: AbortSignal): Promise<RowDepth[]> {
  if (orderIds.length === 0) return []
  return (await api.get('/sales/orders/depth', { query: { orderIds: orderIds.slice(0, 200).join(',') }, schema: z.object({ orders: z.array(rowDepthSchema) }), signal })).orders
}

const setPrioritySchema = z.object({ priority: z.object({ orderId: z.string(), number: z.string(), changed: z.boolean(), priorityLevel: levelSchema, urgentReason: z.string().nullable(), priority: z.number(), version: z.number() }) })
export type PriorityAnswer = z.infer<typeof setPrioritySchema>['priority']

export async function setPriority(api: ApiClient, orderId: string, body: { version: number; priorityLevel: PriorityLevel; urgentReason?: string | null }, idempotencyKey = newIdempotencyKey()): Promise<PriorityAnswer> {
  return (await api.request('PUT', `${orderPath(orderId)}/priority`, { body, schema: setPrioritySchema, idempotencyKey })).priority
}

export const prioritiesAnswerSchema = z.object({
  priorityLevel: levelSchema,
  changed: z.array(z.string()),
  unchanged: z.array(z.string()),
  /** `why` is the API's English: the screen says its own words. */
  skipped: z.array(z.object({ orderId: z.string(), number: z.string() })),
  unknown: z.number(),
})
export type PrioritiesAnswer = z.infer<typeof prioritiesAnswerSchema>

/** "Set priority" on a selection: one command; what changed, stayed, was left out. */
export function setPriorities(api: ApiClient, body: { orderIds: readonly string[]; priorityLevel: PriorityLevel; urgentReason?: string | null }, idempotencyKey: string): Promise<PrioritiesAnswer> {
  return api.post('/sales/orders/priority', { body: { ...body, orderIds: [...body.orderIds] }, schema: prioritiesAnswerSchema, idempotencyKey })
}

export const seasonSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  code: z.string(),
  name: z.string(),
  startsOn: day,
  endsOn: day,
  orderBookClosesOn: day.nullable(),
  status: z.enum(SEASON_STATUSES),
  state: z.enum(SEASON_STATES),
  version: z.number(),
})
export type Season = z.infer<typeof seasonSchema>

export async function listSeasons(api: ApiClient, companyId: string, signal?: AbortSignal): Promise<Season[]> {
  return (await api.get('/sales/seasons', { query: { companyId, status: 'OPEN' }, schema: z.object({ seasons: z.array(seasonSchema) }), signal })).seasons
}

export async function setOrderSeason(api: ApiClient, orderId: string, body: { version: number; seasonId: string | null }, idempotencyKey = newIdempotencyKey()): Promise<{ version: number }> {
  return (await api.request('PUT', `${orderPath(orderId)}/season`, { body, schema: z.object({ season: z.object({ orderId: z.string(), version: z.number() }) }), idempotencyKey })).season
}

export const approvalSchema = z.object({
  orderId: z.string(),
  number: z.string(),
  status: z.string(),
  waiting: z.boolean(),
  reasons: z.array(z.object({ reason: z.enum(WAIT_REASONS) })),
  creditHold: z.object({ checkId: z.string(), requestTaskId: z.string().nullable() }).nullable(),
  requests: z.array(z.object({ id: z.string(), status: z.string(), requestedAt: instant, requestedBy: z.string().nullable(), approver: z.string().nullable(), dueAt: instant.nullable(), decidedAt: instant.nullable(), decidedBy: z.string().nullable(), reason: z.string().nullable(), mine: z.boolean() })),
  may: z.object({ ask: z.boolean(), withdraw: z.boolean() }),
})
export type Approval = z.infer<typeof approvalSchema>

export function getApproval(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<Approval> {
  return api.get(`${orderPath(orderId)}/approval`, { schema: approvalSchema, signal })
}

export function askApproval(api: ApiClient, orderId: string, note: string | null, idempotencyKey: string): Promise<{ taskId: string }> {
  return api.post(`${orderPath(orderId)}/approval`, { body: { note }, schema: z.object({ taskId: z.string() }), idempotencyKey })
}

export function withdrawApproval(api: ApiClient, orderId: string, idempotencyKey: string): Promise<{ withdrawn: number }> {
  return api.post(`${orderPath(orderId)}/approval/withdraw`, { body: {}, schema: z.object({ withdrawn: z.number() }), idempotencyKey })
}

export const confirmationSchema = z.object({
  orderId: z.string(),
  number: z.string(),
  status: z.string(),
  orderVersion: z.number(),
  sentAt: instant.nullable(),
  sentVersion: z.number().nullable(),
  upToDate: z.boolean().nullable(),
  mayMake: z.boolean(),
  versions: z.array(z.object({ id: z.string(), version: z.number(), number: z.string().nullable(), language: z.string(), fileId: z.string(), createdAt: instant, createdBy: z.string().nullable(), sent: z.boolean() })),
})
export type Confirmation = z.infer<typeof confirmationSchema>

export async function getConfirmation(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<Confirmation> {
  return (await api.get(`${orderPath(orderId)}/confirmation`, { schema: z.object({ confirmation: confirmationSchema }), signal })).confirmation
}

export function makeConfirmation(api: ApiClient, orderId: string, language: 'it' | 'en' | undefined, idempotencyKey: string): Promise<{ made: boolean; version: number; fileId: string; confirmation: Confirmation }> {
  return api.post(`${orderPath(orderId)}/confirmation`, { body: language ? { language } : {}, schema: z.object({ made: z.boolean(), version: z.number(), fileId: z.string(), confirmation: confirmationSchema }), idempotencyKey })
}

export interface SendConfirmationBody {
  to?: string[]
  cc?: string[]
  subject?: string | null
  message?: string | null
  language?: 'it' | 'en'
}

export function sendConfirmation(api: ApiClient, orderId: string, body: SendConfirmationBody, idempotencyKey: string): Promise<{ version: number; made: boolean; confirmation: Confirmation }> {
  return api.post(`${orderPath(orderId)}/confirmation/send`, { body, schema: z.object({ version: z.number(), made: z.boolean(), confirmation: confirmationSchema }), idempotencyKey })
}

// ---- B-W2b-309: what is frozen, the changes, priced changes, the put-back, the deposit kinds, the customer's materials ------

const stageOf = { stage: z.enum(FREEZE_STAGES).nullable(), on: day.nullable() }
const verdictSchema = z.object({ field: z.enum(FREEZE_FIELDS), state: z.enum(FREEZE_STATES), frozenFrom: z.enum(FREEZE_STAGES).nullable() })

export const freezeSchema = z.object({
  orderId: z.string(),
  number: z.string(),
  rules: z.number(),
  order: z.object({ ...stageOf, fields: z.array(verdictSchema) }),
  lines: z.array(z.object({ lineId: z.string(), seq: z.number(), ...stageOf, fields: z.array(verdictSchema), sizes: z.array(z.object({ size: z.string(), ...stageOf, locked: z.boolean(), state: z.enum(FREEZE_STATES) })) })),
})
export type Freeze = z.infer<typeof freezeSchema>

export function getFreeze(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<Freeze> {
  return api.get(`${orderPath(orderId)}/freeze`, { schema: freezeSchema, signal })
}

const diffSchema = z.object({
  lines: z.array(z.object({ change: z.enum(['ADDED', 'REMOVED', 'CHANGED']), lineId: z.string(), seq: z.number(), styleId: z.string(), colourwayId: z.string(), piecesBefore: z.number(), piecesAfter: z.number(), sizes: z.array(z.object({ size: z.string(), before: z.number(), after: z.number() })), priceChanged: z.boolean() })),
  netAmountBefore: z.number().optional(),
  netAmountAfter: z.number().optional(),
})
const partSchema = z.object({ label: z.string(), orderLineId: z.string().nullable(), amount: z.number().optional() })

export const changeSchema = z.object({
  id: z.string(),
  revision: z.number(),
  reason: z.string(),
  createdAt: instant,
  createdBy: z.string().nullable(),
  priced: z.boolean(),
  diff: diffSchema,
  parts: z.array(partSchema).optional(),
  feeAmount: z.number().nullable().optional(),
  changeAmount: z.number().optional(),
  deposit: z.object({ id: z.string(), kind: z.string(), amount: z.number().optional(), pct: z.string().nullable(), status: z.string(), dueDate: day }).nullable(),
  yes: z.object({ state: z.enum(CHANGE_YES_STATES), taskId: z.string().nullable(), reason: z.string().nullable() }),
  customer: z.object({ decision: z.enum(CUSTOMER_DECISIONS), requestId: z.string().nullable(), answeredAt: instant.nullable() }),
  putBack: z.object({ may: z.boolean() }),
})
export type Change = z.infer<typeof changeSchema>

export const changesSchema = z.object({
  orderId: z.string(),
  number: z.string(),
  waitingForYes: z.object({ taskId: z.string(), since: instant }).nullable(),
  reapprovalNeededAt: instant.nullable(),
  changes: z.array(changeSchema),
})
export type Changes = z.infer<typeof changesSchema>

export function getChanges(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<Changes> {
  return api.get(`${orderPath(orderId)}/changes`, { schema: changesSchema, signal })
}

export function putBack(api: ApiClient, orderId: string, amendmentId: string, body: { version: number; reason?: string }, idempotencyKey: string): Promise<{ order: Order; change: Change; depositCancelled: boolean }> {
  return api.post(`${orderPath(orderId)}/changes/${seg(amendmentId)}/put-back`, { body, schema: z.object({ order: orderSchema, change: changeSchema, depositCancelled: z.boolean() }), idempotencyKey })
}

/** The amendment's lines as W2a's amendment sends them (the priced route takes the same). */
export type AmendLines = readonly unknown[]

export interface PricedBody {
  version?: number
  reason?: string
  customerRef?: string | null
  requestedDate?: string | null
  lines: AmendLines
  labels?: Record<string, string>
  fee?: string | null
  deposit?: { pct?: string; amount?: string; dueDate?: string; kind?: ExtraDepositKind } | null
}

export const pricedPreviewSchema = z.object({
  ok: z.boolean(),
  problems: z.array(z.object({ path: z.string() })),
  revision: z.number(),
  version: z.number(),
  diff: diffSchema.nullable(),
  parts: z.array(partSchema).optional(),
  feeAmount: z.number().nullable().optional(),
  changeAmount: z.number().nullable().optional(),
  deposit: z.object({ amount: z.number().optional(), pct: z.string(), kind: z.string(), growthAmount: z.number().optional() }).nullable().optional(),
  yes: z.enum(YES_PREVIEWS).nullable(),
  stage: z.object({ stage: z.enum(FREEZE_STAGES) }).nullable(),
})
export type PricedPreview = z.infer<typeof pricedPreviewSchema>

export function previewPricedChange(api: ApiClient, orderId: string, body: PricedBody, signal?: AbortSignal): Promise<PricedPreview> {
  return api.post(`${orderPath(orderId)}/priced-changes/preview`, { body, schema: pricedPreviewSchema, signal })
}

export function applyPricedChange(api: ApiClient, orderId: string, body: PricedBody & { version: number; reason: string }, idempotencyKey: string): Promise<{ order: Order; change: Change }> {
  return api.post(`${orderPath(orderId)}/priced-changes`, { body, schema: z.object({ order: orderSchema, change: changeSchema }), idempotencyKey })
}

export const depositKindsSchema = z.object({
  companyId: z.string(),
  kinds: z.array(z.object({ kind: z.enum(EXTRA_DEPOSIT_KINDS), available: z.boolean() })),
  caparraPenitenziale: z.object({ on: z.boolean(), source: z.enum(['COMPANY', 'TENANT', 'NONE']) }),
})
export type DepositKinds = z.infer<typeof depositKindsSchema>

export function getDepositKinds(api: ApiClient, companyId: string, signal?: AbortSignal): Promise<DepositKinds> {
  return api.get('/sales/deposit-kinds', { query: { companyId }, schema: depositKindsSchema, signal })
}

const named = z.object({ id: z.string(), code: z.string(), name: z.string() })
const colourRef = z.object({ id: z.string(), code: z.string(), name: z.string().nullable() }).nullable()

export const materialsSchema = z.object({
  orderId: z.string(),
  number: z.string(),
  partyId: z.string(),
  rows: z.array(z.object({ id: z.string(), orderLineId: z.string(), seq: z.number(), item: named, colour: colourRef, uom: z.string(), expected: z.string(), expectedBySize: z.record(z.string(), z.string()), received: z.string(), used: z.string(), returned: z.string(), left: z.string(), note: z.string().nullable(), version: z.number() })),
  notPlanned: z.array(z.object({ orderLineId: z.string(), bomLineId: z.string(), item: named, colour: colourRef, uom: z.string(), expected: z.string() })),
  lots: z.array(z.object({ id: z.string(), code: z.string(), itemId: z.string(), itemColourId: z.string().nullable(), siteId: z.string(), onHand: z.string(), receiptId: z.string().nullable(), receiptNumber: z.string().nullable(), receivedAt: instant.nullable() })),
  /** The API's English sentences: only whether there are any. */
  problems: z.array(z.string()),
  empty: z.unknown().nullable(),
})
export type Materials = z.infer<typeof materialsSchema>

export function getMaterials(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<Materials> {
  return api.get(`${orderPath(orderId)}/customer-materials`, { schema: materialsSchema, signal })
}

export function planMaterials(api: ApiClient, orderId: string, idempotencyKey: string): Promise<Materials & { planned: { made: number; changed: number; removed: number; kept: number } }> {
  return api.post(`${orderPath(orderId)}/customer-materials/plan`, { body: {}, schema: materialsSchema.extend({ planned: z.object({ made: z.number(), changed: z.number(), removed: z.number(), kept: z.number() }) }), idempotencyKey })
}

// ---- B-W2b-295: the brand tech pack in force ---------------------------------------------------------------------------------

const packFile = z.object({ id: z.string(), originalName: z.string(), contentType: z.string(), sizeBytes: z.number(), status: z.string(), versionNo: z.number() })
export const techPackSchema = z.object({
  inquiry: z
    .object({
      id: z.string(),
      number: z.string(),
      techPack: z.object({ version: z.string().nullable(), files: z.array(z.object({ named: packFile, current: packFile.nullable(), newer: z.boolean() })) }),
    })
    .nullable(),
})
export type TechPack = z.infer<typeof techPackSchema>

export function getTechPack(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<TechPack> {
  return api.get('/sales/inquiries/source', { query: { salesOrderId: orderId }, schema: techPackSchema, signal })
}

// ---- B-W2b-263: the order's milestones ---------------------------------------------------------------------------------------

export const MILESTONE_KINDS = ['GATE', 'START', 'SHIP'] as const
export const MILESTONE_STATES = ['DONE', 'WAITING', 'STARTED_BEFORE', 'TO_COME'] as const
const milestoneSchema = z.object({
  id: z.string(),
  kind: z.enum(MILESTONE_KINDS),
  gateKind: z.string().nullable(),
  label: z.string().nullable(),
  target: day.nullable(),
  actual: day.nullable(),
  state: z.enum(MILESTONE_STATES),
  late: z.number().nullable(),
})
export type OrderMilestone = z.infer<typeof milestoneSchema>
export const milestonesSchema = z.object({ orders: z.array(z.object({ id: z.string(), number: z.string(), milestones: z.array(milestoneSchema), next: z.string().nullable(), late: z.number() })) })

export async function getMilestones(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<{ milestones: OrderMilestone[]; next: string | null; late: number } | null> {
  const answer = await api.get('/planning/milestones', { query: { orderId }, schema: milestonesSchema, signal })
  const order = answer.orders.find((entry) => entry.id === orderId)
  return order ? { milestones: order.milestones, next: order.next, late: order.late } : null
}

// ---- B-W2b-317: the promises (open lines with their promise now and the planned finish) ---------------------------------------

const promiseSize = z.object({ size: z.string().nullable(), ordered: z.number(), shipped: z.number(), open: z.number(), current: day.nullable(), finish: day.nullable(), finishSource: z.enum(FINISH_SOURCES), slackDays: z.number().nullable(), risk: z.enum(RISK_STATES).nullable() })
export const promiseLineSchema = z.object({
  id: z.string(),
  seq: z.number(),
  order: z.object({ id: z.string(), number: z.string(), status: z.string(), priorityLevel: z.string(), backlogPosition: z.number().nullable() }),
  customer: named,
  style: named,
  colourway: named,
  sizes: z.array(promiseSize),
  current: day.nullable(),
  finish: day.nullable(),
  finishSource: z.enum(FINISH_SOURCES),
  slackDays: z.number().nullable(),
  risk: z.enum(RISK_STATES).nullable(),
})
export type PromiseLine = z.infer<typeof promiseLineSchema>
export const promisesSchema = z.object({ site: z.object({ id: z.string(), code: z.string(), name: z.string() }), today: day, asOf: instant, complete: z.boolean(), lines: z.array(promiseLineSchema) })
export type Promises = z.infer<typeof promisesSchema>

export function listPromiseLines(api: ApiClient, siteId: string, query: { q?: string; limit?: number } = {}, signal?: AbortSignal): Promise<Promises> {
  return api.get('/planning/promises', { query: { siteId, q: query.q?.trim() || undefined, limit: query.limit ?? 300 }, schema: promisesSchema, signal })
}
