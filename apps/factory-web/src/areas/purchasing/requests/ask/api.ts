import { z } from 'zod'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { PURCHASE_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/orders'
import { PURCHASE_REQUEST_SOURCES, PURCHASE_REQUEST_STATUSES, type ShortageThen } from '@nexus/factory-domain/purchasing/ask-to-buy/ask-to-buy'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * Ask to buy (B-W2b-332; apps/factory-api modules/purchasing/ask-to-buy contract.ts): what the dialog offers, "Send request",
 * a shortage asked (or drafted at once by a buyer), one's own requests, one request with its request for a yes, take back,
 * refuse. Answers are checked with zod (unknown fields dropped). No money anywhere here.
 */

const uom = z.enum(UOMS)
export type Uom = (typeof UOMS)[number]
const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })

export const askedSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  site: z.object({ code: z.string(), name: z.string() }),
  source: z.enum(PURCHASE_REQUEST_SOURCES),
  status: z.enum(PURCHASE_REQUEST_STATUSES),
  version: z.number(),
  requestedBy: z.object({ id: z.string(), name: z.string() }),
  requestedAt: z.string(),
  mine: z.boolean(),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string() }).nullable(),
  colour: ref.nullable(),
  description: z.string().nullable(),
  quantity: z.string(),
  uom,
  needDate: z.string(),
  reason: z.string(),
  workOrder: z.object({ id: z.string(), number: z.string() }).nullable(),
  shortage: z.object({ word: z.enum(['NOT_ENOUGH', 'DELAYED']), short: z.string(), uom: z.string(), needDate: z.string(), runId: z.string().nullable(), workOrderNumber: z.string() }).nullable(),
  approvalTaskId: z.string().nullable(),
  rejected: z.object({ at: z.string(), by: z.string(), reason: z.string() }).nullable(),
  converted: z.object({ at: z.string(), by: z.string(), purchaseOrder: z.object({ id: z.string(), number: z.string(), status: z.enum(PURCHASE_ORDER_STATUSES) }).nullable() }).nullable(),
  cancelled: z.object({ at: z.string(), reason: z.string() }).nullable(),
  cancel: z.object({ allowed: z.boolean(), why: z.string().nullable() }),
})
export type AskedRequest = z.infer<typeof askedSchema>

const approvalSchema = z.object({ asked: z.boolean(), taskId: z.string().nullable(), approverRoleId: z.string().nullable(), approverUserId: z.string().nullable(), dueAt: z.string().nullable() })
export type AskApproval = z.infer<typeof approvalSchema>

const optionsSchema = z.object({
  sites: z.array(z.object({ id: z.string(), companyId: z.string(), code: z.string(), name: z.string() })),
  siteId: z.string().nullable(),
  today: z.string(),
  materials: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string(), baseUom: uom, purchaseUom: uom, units: z.array(uom), colours: z.array(ref) })),
  workOrders: z.array(z.object({ id: z.string(), number: z.string(), style: z.string().nullable(), dueDate: z.string().nullable() })),
  more: z.boolean(),
})
export type AskOptions = z.infer<typeof optionsSchema>
export type AskMaterial = AskOptions['materials'][number]

export function askOptions(api: ApiClient, query: { siteId?: string | null; q?: string | null }, signal?: AbortSignal): Promise<AskOptions> {
  return api.get('/purchasing/ask-to-buy/options', { query: { siteId: query.siteId ?? undefined, q: query.q?.trim() || undefined }, schema: optionsSchema, signal })
}

export interface AskBody {
  siteId: string
  itemId: string
  itemColourId: string | null
  description: string | null
  quantity: string
  uom: Uom
  needDate: string
  reason: string
  workOrderId: string | null
  note: string | null
}

const askedAnswer = z.object({ request: askedSchema, approval: approvalSchema })
export type AskAnswer = z.infer<typeof askedAnswer>

/** "Send request" (one Idempotency-Key per dialog: a resend answers the same). */
export function askToBuy(api: ApiClient, body: AskBody, idempotencyKey: string): Promise<AskAnswer> {
  return api.post('/purchasing/ask-to-buy', { body, schema: askedAnswer, idempotencyKey })
}

export interface ShortageBody {
  siteId: string
  workOrderId: string
  itemId: string
  itemColourId: string | null
  reason: string
  then: ShortageThen
  note: string | null
}

const shortageAnswer = z.object({
  request: askedSchema,
  approval: approvalSchema.nullable(),
  draft: z.object({ purchaseOrderId: z.string(), number: z.string(), created: z.boolean(), purchaseOrderLineId: z.string() }).nullable(),
})
export type ShortageAnswer = z.infer<typeof shortageAnswer>

/** A line of the shortage list asked, or drafted into a purchase order at once (a buyer). */
export function askFromShortage(api: ApiClient, body: ShortageBody, idempotencyKey: string): Promise<ShortageAnswer> {
  return api.post('/purchasing/ask-to-buy/from-shortage', { body, schema: shortageAnswer, idempotencyKey })
}

const listSchema = z.object({ asOf: z.string(), requests: z.array(askedSchema), nextCursor: z.string().nullable() })
export type AskedPage = z.infer<typeof listSchema>

export interface AskedQuery {
  status?: 'LIVE' | 'ALL' | AskedRequest['status']
  mine?: boolean
  siteId?: string | null
  source?: AskedRequest['source']
  workOrderId?: string | null
  cursor?: string | null
  limit?: number
}

export function listAsked(api: ApiClient, query: AskedQuery, signal?: AbortSignal): Promise<AskedPage> {
  return api.get('/purchasing/ask-to-buy', {
    query: {
      status: query.status ?? undefined,
      mine: query.mine === undefined ? undefined : query.mine ? 'true' : 'false',
      siteId: query.siteId ?? undefined,
      source: query.source ?? undefined,
      workOrderId: query.workOrderId ?? undefined,
      cursor: query.cursor ?? undefined,
      limit: query.limit ?? 100,
    },
    schema: listSchema,
    signal,
  })
}

const oneSchema = z.object({
  request: askedSchema,
  approval: z.object({ id: z.string(), status: z.string(), approver: z.string().nullable(), requestedAt: z.string(), dueAt: z.string().nullable(), decidedAt: z.string().nullable(), decidedBy: z.string().nullable() }).nullable(),
})
export type AskedDetail = z.infer<typeof oneSchema>

export function getAsked(api: ApiClient, requestId: string, signal?: AbortSignal): Promise<AskedDetail> {
  return api.get(`/purchasing/ask-to-buy/${encodeURIComponent(requestId)}`, { schema: oneSchema, signal })
}

const manySchema = z.object({ requests: z.array(askedSchema) })
export interface ManyBody {
  requests: { id: string; version: number }[]
  reason: string
}

/** Take requests back (one's own; any as a buyer), with the reason. */
export function cancelAsked(api: ApiClient, body: ManyBody, idempotencyKey: string) {
  return api.post('/purchasing/ask-to-buy/cancel', { body, schema: manySchema, idempotencyKey })
}

/** Refuse requests with the reason (a buyer). */
export function rejectAsked(api: ApiClient, body: ManyBody, idempotencyKey: string) {
  return api.post('/purchasing/ask-to-buy/reject', { body, schema: manySchema, idempotencyKey })
}
