import { z } from 'zod'
import { EXPEDITE_REASONS } from '@nexus/factory-domain/purchasing/expediting/worklist'
import { PURCHASE_ORDER_STATUSES, SEND_CHECK_CODES } from '@nexus/factory-domain/purchasing/orders'
import { ORDER_APPROVAL_STATES } from '@nexus/factory-domain/purchasing/po-approvals/approvals'
import { DATE_SOURCES } from '@nexus/factory-domain/purchasing/po-depth/dates'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import type { ApiClient } from '../../../../lib/api/client'
import { newIdempotencyKey } from '../../../../lib/api/client'

/**
 * B-W2b-333 — the calls of purchase orders in depth on screen, each answer's shape checked (zod; unknown fields are
 * dropped): the delivery schedule, the supplier's dates and the rate at order (B-W2b-296, `…/depth`), the lines by kind
 * (B-W2b-328, `…/line-kinds`), the compliance gate and its override (B-W2b-315, `…/compliance`), the approval of the send,
 * the demand each line serves, the chase, duplicate and the expediting worklist (B-W2b-305), and a supplier's closures
 * (B-W2b-311, its profile). Money is the cost grain's (optional: absent for a reader without it). The API's English
 * (`words`, `why`, `message`, rate words, check messages) is dropped or never drawn: the screens say their own words from
 * codes and facts. The one exception is the chase mail itself (subject and body), drawn as the supplier will read it.
 */

const status = z.enum(PURCHASE_ORDER_STATUSES)
const uom = z.enum(UOMS)
const day = z.string()

/** The gate's lists (factory-domain purchasing/qualification/gate: not imported here, it reads node:crypto; a test holds them equal). */
export const REQUIREMENT_KINDS = ['CR_VI_TEST_REPORT', 'PPE_CERTIFICATE', 'RULE'] as const
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number]
export const REQUIREMENT_STATES = ['MET', 'EXPIRING', 'EXPIRES_BEFORE_NEED', 'EXPIRED', 'MISSING'] as const
export type RequirementState = (typeof REQUIREMENT_STATES)[number]
/** The override's reason, 3 to 2000 characters; a decision's words at most 2000 (factory-domain OVERRIDE_LIMITS). */
export const OVERRIDE_REASON = Object.freeze({ min: 3, max: 2000 })
/** A chase's own message (factory-domain purchasing/expediting MAX_CHASE_MESSAGE). */
export const MAX_CHASE_MESSAGE = 4000

export { EXPEDITE_REASONS }
export type ExpediteReason = (typeof EXPEDITE_REASONS)[number]
export type DateSource = (typeof DATE_SOURCES)[number]
export const SOURCES = DATE_SOURCES

const orderUrl = (id: string) => `/purchasing/orders/${encodeURIComponent(id)}`
const lineUrl = (id: string, lineId: string) => `${orderUrl(id)}/lines/${encodeURIComponent(lineId)}`

// ---- the order in depth: deliveries, the supplier's dates, the rate (B-W2b-296) ------------------------------------------

const toleranceSchema = z.object({
  overPct: z.string(),
  underPct: z.string(),
  whenBeyond: z.enum(['REASON', 'BLOCK', 'APPROVAL']),
  source: z.enum(['LINE', 'RULE', 'NONE']),
  toleranceId: z.string().nullable(),
})
export type LineTolerance = z.infer<typeof toleranceSchema>

const deliverySchema = z.object({
  id: z.string(),
  seq: z.number(),
  quantity: z.string(),
  baseQuantity: z.string(),
  needDate: day,
  confirmedDate: day.nullable(),
  confirmedLaterBy: z.number(),
  note: z.string().nullable(),
  version: z.number(),
})
export type Delivery = z.infer<typeof deliverySchema>

const dateChangeSchema = z.object({
  id: z.string(),
  lineId: z.string(),
  lineSeq: z.number(),
  deliveryId: z.string().nullable(),
  deliverySeq: z.number().nullable(),
  seq: z.number(),
  fromDate: day,
  toDate: day,
  source: z.enum(DATE_SOURCES),
  changedAt: z.string(),
  supplierContactName: z.string().nullable(),
  reason: z.string(),
  createdAt: z.string(),
})
export type DateChange = z.infer<typeof dateChangeSchema>

const depthLineSchema = z.object({
  id: z.string(),
  seq: z.number(),
  itemId: z.string(),
  itemCode: z.string(),
  quantity: z.string(),
  uom,
  baseQuantity: z.string(),
  needDate: day,
  confirmedDate: day.nullable(),
  confirmedLaterBy: z.number(),
  ended: z.boolean(),
  deliveries: z.array(deliverySchema),
  tolerance: toleranceSchema,
})
export type DepthLine = z.infer<typeof depthLineSchema>

const depthSchema = z.object({
  orderId: z.string(),
  number: z.string(),
  status,
  version: z.number(),
  currency: z.object({
    order: z.string(),
    company: z.string(),
    takesRate: z.boolean(),
    rateAtOrder: z.string().nullable(),
    /** The cost grain: absent without it. */
    companyNetAmount: z.number().nullable().optional(),
  }),
  shipTo: z
    .object({
      party: z.object({ code: z.string(), name: z.string() }),
      location: z.object({ code: z.string(), name: z.string() }).nullable(),
      receiptLandsAt: z.enum(['WORKSHOP', 'OFFICE_PICKS']),
    })
    .nullable(),
  lines: z.array(depthLineSchema),
  dateChanges: z.array(dateChangeSchema),
})
export type OrderDepth = z.infer<typeof depthSchema>
const depthAnswer = z.object({ depth: depthSchema })

export async function getDepth(api: ApiClient, id: string, signal?: AbortSignal): Promise<OrderDepth> {
  return (await api.get(`${orderUrl(id)}/depth`, { schema: depthAnswer, signal })).depth
}

export interface DeliveryBody {
  quantity: string
  needDate: string
  note?: string | null
}

/** A draft line's schedule: the whole list each time (2 to 52 deliveries that add up to the line). */
export async function putSchedule(api: ApiClient, id: string, lineId: string, body: { version: number; deliveries: readonly DeliveryBody[] }, idempotencyKey: string): Promise<OrderDepth> {
  return (await api.request('PUT', `${lineUrl(id, lineId)}/deliveries`, { body: { ...body, deliveries: [...body.deliveries] }, schema: depthAnswer, idempotencyKey })).depth
}

/** A draft line back to one delivery (its own need date). */
export async function clearSchedule(api: ApiClient, id: string, lineId: string, version: number, idempotencyKey: string): Promise<OrderDepth> {
  return (await api.request('DELETE', `${lineUrl(id, lineId)}/deliveries`, { query: { version }, schema: depthAnswer, idempotencyKey })).depth
}

export interface SupplierDateBody {
  version: number
  deliveryId?: string | null
  date: string
  source: DateSource
  reason?: string | null
  supplierContactName?: string | null
}

/** The supplier's day for a delivery or a line: its first one (FIRST, no reason) or a move of a confirmed day (MOVED, a reason). */
export async function recordSupplierDate(api: ApiClient, id: string, lineId: string, body: SupplierDateBody, idempotencyKey: string): Promise<{ depth: OrderDepth; recorded: 'FIRST' | 'MOVED' }> {
  return api.post(`${lineUrl(id, lineId)}/supplier-date`, { body, schema: depthAnswer.extend({ recorded: z.enum(['FIRST', 'MOVED']) }), idempotencyKey })
}

/** A draft in another currency than the company's: the rate at order (null clears it). */
export async function putRate(api: ApiClient, id: string, version: number, rateAtOrder: string | null, idempotencyKey: string): Promise<OrderDepth> {
  return (await api.request('PUT', `${orderUrl(id)}/rate`, { body: { version, rateAtOrder }, schema: depthAnswer, idempotencyKey })).depth
}

// ---- lines by kind (B-W2b-328) ---------------------------------------------------------------------------------------------

const certificateSchema = z.object({ id: z.string(), number: z.string(), standard: z.string(), status: z.string(), validFrom: day, validTo: day })
const variantSchema = z.object({ code: z.string(), itemColourId: z.string().nullable(), colourCode: z.string().nullable(), size: z.string().nullable(), supplierCode: z.string().nullable(), status: z.enum(['ACTIVE', 'ARCHIVED']) })
export type LineVariant = z.infer<typeof variantSchema>

const kindLineSchema = z.object({
  id: z.string(),
  seq: z.number(),
  itemId: z.string(),
  itemCode: z.string(),
  itemKind: z.string(),
  itemColourId: z.string().nullable(),
  quantity: z.string(),
  uom,
  ended: z.boolean(),
  buysAs: z.enum(['FABRIC', 'TRIM', 'PROTECTOR', 'OTHER']),
  rolls: z.object({ count: z.number(), lengthM: z.string().nullable(), widthCm: z.string().nullable(), makes: z.string().nullable(), matches: z.boolean() }).nullable(),
  materialWidthCm: z.string().nullable(),
  /** The API's words; only whether there is one is read (the screen says the widths). */
  widthNote: z.string().nullable(),
  ppe: z.boolean(),
  certificate: certificateSchema.extend({ state: z.enum(['HOLDS', 'NOT_VALID', 'OTHER_SUPPLIER', 'NOT_COVERING']), endsBeforeNeed: z.boolean() }).nullable(),
  certificateChoices: z.array(certificateSchema.extend({ coverage: z.enum(['THIS_SUPPLIER', 'ANY_SUPPLIER']) })),
  variant: variantSchema.extend({ problem: z.string().nullable() }).nullable(),
  variantChoices: z.array(variantSchema),
  keepsVariantsApart: z.boolean(),
})
export type KindLine = z.infer<typeof kindLineSchema>

const kindsSchema = z.object({
  orderId: z.string(),
  status,
  version: z.number(),
  kind: z.enum(['STANDARD', 'SAMPLE']),
  mayChange: z.boolean(),
  lines: z.array(kindLineSchema),
})
export type LineKinds = z.infer<typeof kindsSchema>
const kindsAnswer = z.object({ kinds: kindsSchema })

export async function getLineKinds(api: ApiClient, id: string, signal?: AbortSignal): Promise<LineKinds> {
  return (await api.get(`${orderUrl(id)}/line-kinds`, { schema: kindsAnswer, signal })).kinds
}

export interface LineKindBody {
  version: number
  rolls?: { count: number; lengthM?: string | null; widthCm?: string | null } | null
  certificateId?: string | null
  variantCode?: string | null
}

/** A draft line's rolls, certificate or variant (each sent replaces; null clears). */
export async function putLineKind(api: ApiClient, id: string, lineId: string, body: LineKindBody, idempotencyKey: string): Promise<LineKinds> {
  return (await api.request('PUT', `${lineUrl(id, lineId)}/kind`, { body, schema: kindsAnswer, idempotencyKey })).kinds
}

// ---- the compliance gate and its override (B-W2b-315) ------------------------------------------------------------------------

const requirementSchema = z.object({
  kind: z.enum(REQUIREMENT_KINDS),
  state: z.enum(REQUIREMENT_STATES),
  severity: z.enum(['BLOCKS', 'WARNING']).nullable(),
  lineIds: z.array(z.string()),
  seqs: z.array(z.number()),
  itemCodes: z.array(z.string()),
  expiresOn: day.nullable(),
  law: z.string().nullable(),
})
export type Requirement = z.infer<typeof requirementSchema>

const overrideRequestSchema = z.object({
  state: z.enum(['WAITING', 'APPROVED', 'REJECTED', 'WITHDRAWN']),
  /** The asker's own words (a person's text: drawn). */
  reason: z.string(),
  askedBy: z.object({ id: z.string(), name: z.string().nullable(), me: z.boolean() }),
  askedAt: z.string(),
  decidedBy: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  decidedAt: z.string().nullable(),
  /** The decider's own words (a person's text: drawn). */
  words: z.string().nullable(),
  current: z.boolean(),
})
export type OverrideRequest = z.infer<typeof overrideRequestSchema>

const complianceSchema = z.object({
  order: z.object({ id: z.string(), number: z.string(), status: z.string(), version: z.number() }),
  requirements: z.array(requirementSchema),
  lines: z.array(z.object({ lineId: z.string(), seq: z.number(), held: z.boolean(), kinds: z.array(z.enum(REQUIREMENT_KINDS)) })),
  checks: z.array(z.object({ code: z.enum(SEND_CHECK_CODES), severity: z.enum(['BLOCKS', 'WARNING']), path: z.string() })),
  ready: z.boolean(),
  overridden: z.boolean(),
  /** The API's words for the lines it could not check: only how many is read. */
  notChecked: z.array(z.string()),
  request: overrideRequestSchema.nullable(),
  may: z.object({ ask: z.boolean(), decide: z.boolean(), withdraw: z.boolean() }),
})
export type Compliance = z.infer<typeof complianceSchema>

export function getCompliance(api: ApiClient, id: string, signal?: AbortSignal): Promise<Compliance> {
  return api.get(`${orderUrl(id)}/compliance`, { schema: complianceSchema, signal })
}

/** "Send without a valid document?": the request (a second person decides; the order's version does not move). */
export function askOverride(api: ApiClient, id: string, body: { version: number; reason: string }, idempotencyKey: string): Promise<Compliance> {
  return api.post(`${orderUrl(id)}/compliance-override`, { body, schema: complianceSchema, idempotencyKey })
}

/** The second person's yes (a fresh authenticator code) or no (with words). */
export function decideOverride(api: ApiClient, id: string, body: { decision: 'APPROVED' | 'REJECTED'; words?: string | null }, idempotencyKey: string): Promise<Compliance> {
  return api.post(`${orderUrl(id)}/compliance-override/decide`, { body, schema: complianceSchema, idempotencyKey })
}

/** The asker takes the request back. */
export function withdrawOverride(api: ApiClient, id: string, idempotencyKey: string): Promise<Compliance> {
  return api.post(`${orderUrl(id)}/compliance-override/withdraw`, { schema: complianceSchema, idempotencyKey })
}

// ---- the send's approval (B-W2b-305) ---------------------------------------------------------------------------------------

const approverSchema = z.object({ kind: z.enum(['ROLE', 'PERSON']), id: z.string(), name: z.string() }).nullable()
export const waitingSchema = z.object({ taskId: z.string(), approver: approverSchema, dueAt: z.string().nullable() })
export type Waiting = z.infer<typeof waitingSchema>

const approvalSchema = z.object({
  orderId: z.string(),
  status,
  version: z.number(),
  state: z.enum(ORDER_APPROVAL_STATES),
  task: z
    .object({
      id: z.string(),
      status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'STALE']),
      requestedAt: z.string(),
      requestedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
      approver: approverSchema,
      dueAt: z.string().nullable(),
      decidedAt: z.string().nullable(),
      decidedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
      /** The approver's own words (a person's text). */
      comment: z.string().nullable(),
      rejectReason: z.string().nullable(),
    })
    .nullable(),
  approvedAsItIs: z.boolean(),
  wouldAsk: z.object({ rule: z.object({ id: z.string(), name: z.string() }).nullable(), approver: approverSchema, namesYou: z.boolean() }).nullable(),
})
export type OrderApproval = z.infer<typeof approvalSchema>

export async function getApproval(api: ApiClient, id: string, signal?: AbortSignal): Promise<OrderApproval> {
  return (await api.get(`${orderUrl(id)}/approval`, { schema: z.object({ approval: approvalSchema }), signal })).approval
}

/** Take the request for a yes back: the order is a draft again (purchasing.send). */
export async function withdrawApproval(api: ApiClient, id: string, body: { version: number; note?: string | null }, idempotencyKey: string): Promise<void> {
  await api.post(`${orderUrl(id)}/approval/withdraw`, { body, schema: z.object({ order: z.object({ id: z.string() }) }), idempotencyKey })
}

// ---- the demand each line serves (B-W2b-305) -------------------------------------------------------------------------------

const blockedSchema = z.object({
  kind: z.string(),
  workOrder: z.object({ id: z.string(), number: z.string(), status: z.string(), dueDate: day.nullable() }).nullable(),
  salesOrder: z.object({ id: z.string(), number: z.string(), promiseDate: day.nullable() }).nullable(),
  size: z.string().nullable(),
  demandDate: day,
  quantity: z.string(),
  lateBy: z.number(),
})
export type Blocked = z.infer<typeof blockedSchema>

const demandSchema = z.object({
  orderId: z.string(),
  plan: z.object({ runId: z.string().nullable(), finishedAt: z.string().nullable() }),
  lines: z.array(
    z.object({
      lineId: z.string(),
      seq: z.number(),
      ended: z.enum(['CANCELLED', 'CLOSED_SHORT']).nullable(),
      expectedDate: day,
      outstandingBase: z.string(),
      demands: z.array(blockedSchema),
      salesOrdersAtRisk: z.number(),
      workOrdersAtRisk: z.number(),
    }),
  ),
})
export type OrderDemand = z.infer<typeof demandSchema>

export async function getDemand(api: ApiClient, id: string, signal?: AbortSignal): Promise<OrderDemand> {
  return (await api.get(`${orderUrl(id)}/demand`, { schema: z.object({ demand: demandSchema }), signal })).demand
}

// ---- the chase (B-W2b-305) -------------------------------------------------------------------------------------------------

const chaseSchema = z.object({
  orderId: z.string(),
  version: z.number(),
  allowed: z.boolean(),
  lines: z.array(
    z.object({
      lineId: z.string(),
      seq: z.number(),
      /** The line in the supplier's words (its code, its colour), as the mail names it. */
      label: z.string(),
      needDate: day,
      confirmedDate: day.nullable(),
      expectedDate: day,
      daysLate: z.number(),
      confirmedLaterBy: z.number(),
      reasons: z.array(z.enum(EXPEDITE_REASONS)),
    }),
  ),
  recipient: z.object({ contactId: z.string(), name: z.string(), email: z.string().nullable() }).nullable(),
  language: z.enum(['it', 'en']),
  subject: z.string(),
  body: z.string(),
})
export type ChasePreview = z.infer<typeof chaseSchema>

export async function getChase(api: ApiClient, id: string, language?: 'it' | 'en', signal?: AbortSignal): Promise<ChasePreview> {
  return (await api.get(`${orderUrl(id)}/chase`, { query: { language }, schema: z.object({ chase: chaseSchema }), signal })).chase
}

export async function sendChase(api: ApiClient, id: string, body: { version: number; lineIds?: string[]; message?: string | null }, idempotencyKey: string): Promise<{ to: string; sentAt: string }> {
  return (await api.post(`${orderUrl(id)}/chase`, { body, schema: z.object({ chase: z.object({ to: z.string(), sentAt: z.string() }) }), idempotencyKey })).chase
}

// ---- duplicate or reorder (B-W2b-305) ----------------------------------------------------------------------------------------

const copySchema = z.object({
  order: z.object({ id: z.string(), number: z.string() }),
  copiedFrom: z.object({ id: z.string(), number: z.string() }),
  lines: z.array(z.object({ fromLineId: z.string(), lineId: z.string(), seq: z.number(), needDate: day, priceFrom: z.enum(['SOURCE', 'COPIED']) })),
})
export type OrderCopy = z.infer<typeof copySchema>

/** A new draft to the same supplier from the lines chosen (default every line not cancelled); a need date for all, or each its own. */
export function duplicateOrder(api: ApiClient, id: string, body: { lineIds?: string[]; needDate?: string | null }, idempotencyKey: string = newIdempotencyKey()): Promise<OrderCopy> {
  return api.post(`${orderUrl(id)}/duplicate`, { body, schema: copySchema, idempotencyKey })
}

// ---- the expediting worklist (B-W2b-305): late, unconfirmed and confirmed-later lines, and what they block -------------------

export const worklistRowSchema = z.object({
  lineId: z.string(),
  seq: z.number(),
  purchaseOrderId: z.string(),
  number: z.string(),
  status,
  version: z.number(),
  siteId: z.string(),
  partyId: z.string(),
  supplierName: z.string(),
  item: z.object({ code: z.string(), name: z.string() }),
  colour: z.object({ code: z.string(), name: z.string() }).nullable(),
  baseUom: z.string().nullable(),
  outstandingBase: z.string(),
  needDate: day,
  confirmedDate: day.nullable(),
  expectedDate: day,
  nextDelivery: z.object({ seq: z.number(), needDate: day, confirmedDate: day.nullable() }).nullable(),
  daysLate: z.number(),
  confirmedLaterBy: z.number(),
  reasons: z.array(z.enum(EXPEDITE_REASONS)),
  blocks: z.object({ entries: z.array(blockedSchema), salesOrdersAtRisk: z.number(), workOrdersAtRisk: z.number(), earliestPromise: day.nullable() }),
})
export type WorklistRow = z.infer<typeof worklistRowSchema>

const worklistSchema = z.object({
  today: day,
  complete: z.boolean(),
  tiles: z.object({ late: z.number(), notConfirmed: z.number(), confirmedLate: z.number(), atRisk: z.number(), salesOrdersAtRisk: z.number() }),
  rows: z.array(worklistRowSchema),
  nextCursor: z.string().nullable(),
})
export type Worklist = z.infer<typeof worklistSchema>

export function getWorklist(api: ApiClient, query: { reason?: ExpediteReason; atRisk?: boolean; siteId?: string; cursor?: string | null; limit?: number }, signal?: AbortSignal): Promise<Worklist> {
  return api.get('/purchasing/expediting', {
    query: { reason: query.reason, atRisk: query.atRisk === undefined ? undefined : String(query.atRisk), siteId: query.siteId, cursor: query.cursor ?? undefined, limit: query.limit ?? 200 },
    schema: worklistSchema,
    signal,
  })
}

// ---- a supplier's closures (B-W2b-311, its profile; parties.view) --------------------------------------------------------

const closuresSchema = z.object({
  /** ISO weekdays (1 Monday … 7 Sunday) the supplier is always closed. */
  weeklyDaysOff: z.array(z.number()),
  ahead: z.array(z.object({ from: day, to: day, kind: z.string(), name: z.string(), days: z.number() })),
})
export type SupplierClosures = z.infer<typeof closuresSchema>

export async function getClosures(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<SupplierClosures> {
  return (await api.get(`/purchasing/suppliers/${encodeURIComponent(partyId)}/profile`, { schema: z.object({ supplier: z.object({ closures: closuresSchema }) }), signal })).supplier.closures
}
