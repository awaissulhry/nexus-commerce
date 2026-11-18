import { z } from 'zod'
import { EXTRA_OUTCOMES, WORK_ORDER_CHANGE_KINDS, WORK_ORDER_CHANGE_STATUSES } from '@nexus/factory-domain/order-apply/rules'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/**
 * F-SA-245 (sales page plan R1; lead picks P6', Round 5 D1–D6; review C-11) — the work-order changes an accepted change of a sales
 * order (or an office's own) proposes, every call (B-SA-041, apps/factory-api modules/production/work-order-changes). Office only.
 * Each answer's shape is checked (unknown fields dropped). Ids, numbers, sizes and pieces; the proposer and the decider by name
 * inside the record; never a price, never a person of the customer, never another customer (the API's wall: a change is read with
 * orders.view over the order's customer or workorders.view over the work order — a mixed one only by every-customer people —, and
 * decided with workorders.manage over its work order; anything else answers 404 in the words of an unknown id).
 *
 *   GET  /production/work-order-changes?workOrderId&salesOrderId&status&limit    newest first (the work order's band notice)
 *   GET  /production/work-order-changes/:changeId                               one (the decide window)
 *   POST /production/work-order-changes/:changeId/apply {version}               carried out on the work order as it is now
 *   POST /production/work-order-changes/:changeId/decline {version, words}      "Left as is", with why (1 to 300)
 */

const words = z.object({ it: z.string(), en: z.string() })
const person = z.object({ id: z.string(), name: z.string() }).nullable()

const cellSchema = z.object({ salesOrderLineId: z.string(), lineSeq: z.number().nullable(), size: z.string(), from: z.number(), to: z.number(), workOrderSizeId: z.string().nullable() })
export type ChangeCellView = z.infer<typeof cellSchema>

export const workOrderChangeSchema = z.object({
  id: z.string(),
  status: z.enum(WORK_ORDER_CHANGE_STATUSES),
  kind: z.enum(WORK_ORDER_CHANGE_KINDS),
  partyId: z.string(),
  salesOrder: z.object({ id: z.string(), number: z.string() }),
  /** The work order it changes (null: a MAKE_MORE that makes a new DRAFT). */
  workOrder: z.object({ id: z.string(), number: z.string(), status: z.string() }).nullable(),
  requestId: z.string().nullable(),
  amendmentId: z.string().nullable(),
  cells: z.array(cellSchema),
  /** LOWER_TO_ORDER only: the pieces already cut beyond the new figure, each in words. */
  extra: z.array(z.object({ workOrderSizeId: z.string(), salesOrderLineId: z.string(), size: z.string(), count: z.number(), words })),
  extraOutcome: z.enum(EXTRA_OUTCOMES).nullable(),
  reason: z.string(),
  /** A refused apply's words, as the API said them (it stays PROPOSED). */
  lastError: z.string().nullable(),
  proposedBy: person,
  proposedAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: person,
  decisionNote: z.string().nullable(),
  madeWorkOrder: z.object({ id: z.string(), number: z.string() }).nullable(),
  version: z.number(),
  /** workorders.manage over its work order, while PROPOSED. */
  mayDecide: z.boolean(),
  words: z.object({ title: words, status: words, cells: z.string() }),
})
export type WorkOrderChange = z.infer<typeof workOrderChangeSchema>

const oneChange = z.object({ change: workOrderChangeSchema })
const listSchema = z.object({ items: z.array(workOrderChangeSchema), live: z.object({ events: z.array(z.string()) }) })
export type WorkOrderChangeList = z.infer<typeof listSchema>

const path = (changeId: string) => `/production/work-order-changes/${encodeURIComponent(changeId)}`

export function listWorkOrderChanges(api: ApiClient, query: { readonly workOrderId?: string; readonly salesOrderId?: string; readonly status?: WorkOrderChange['status'] | 'ALL'; readonly limit?: number }, signal?: AbortSignal): Promise<WorkOrderChangeList> {
  return api.get('/production/work-order-changes', { query: { workOrderId: query.workOrderId, salesOrderId: query.salesOrderId, status: query.status ?? 'PROPOSED', limit: query.limit ?? 50 }, schema: listSchema, signal })
}

export async function getWorkOrderChange(api: ApiClient, changeId: string, signal?: AbortSignal): Promise<WorkOrderChange> {
  return (await api.get(path(changeId), { schema: oneChange, signal })).change
}

const applySchema = z.object({
  change: workOrderChangeSchema,
  workOrder: z.object({ id: z.string(), number: z.string(), status: z.string(), version: z.number() }),
  reprint: z.object({ traveller: z.boolean(), words: words.nullable() }),
})
export type ChangeApplied = z.infer<typeof applySchema>

/** workorders.manage: carry the change out at the version read (one command on the change; its cells read again there). */
export function applyWorkOrderChange(api: ApiClient, changeId: string, body: { readonly version: number }, idempotencyKey: string = newIdempotencyKey()): Promise<ChangeApplied> {
  return api.post(`${path(changeId)}/apply`, { body: { version: body.version }, schema: applySchema, idempotencyKey })
}

/** workorders.manage: "Left as is", with why (the order's "Still to do" shows it). */
export async function declineWorkOrderChange(api: ApiClient, changeId: string, body: { readonly version: number; readonly words: string }, idempotencyKey: string = newIdempotencyKey()): Promise<WorkOrderChange> {
  return (await api.post(`${path(changeId)}/decline`, { body: { version: body.version, words: body.words.trim() }, schema: oneChange, idempotencyKey })).change
}
