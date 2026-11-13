import { z } from 'zod'
import { ACTION_RECORD_TYPES, ACTION_STATUSES, MRP_ACTIONS } from '@nexus/factory-domain/planning/actions/messages'
import { ALLOCATIONS } from '@nexus/factory-domain/planning/allocation-priority/rank'
import { DECISIONS as REQUIREMENT_DECISIONS } from '@nexus/factory-domain/planning/decisions'
import { REQUIREMENT_ACTIONS, WARNING_CODES } from '@nexus/factory-domain/planning/explode'
import { DELAY_SOURCES } from '@nexus/factory-domain/planning/item-profile/delays'
import { LOT_SIZINGS } from '@nexus/factory-domain/planning/lot-sizing/parameters'
import { PLANNED_ORDER_KINDS, PLANNED_ORDER_STATUSES, PROTECTABLE_FIELDS } from '@nexus/factory-domain/planning/planned-orders/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import type { ApiClient } from '../../../../lib/api/client'
import { newIdempotencyKey } from '../../../../lib/api/client'

/**
 * B-W2b-335 — the W2b calls of What to buy & make (SCR-055), with the answer's shape checked (zod; unknown fields are
 * dropped). Planned work and subcontract orders and their conversion (B-W2b-293), the protected fields, Reset to plan, the
 * bulk move, action messages and the run log (B-W2b-306), the projected stock of a material and the calculated delays
 * (B-W2b-318). The API's English (`held`, `problems`, `late.reason`, `message`, `label`, `reason`, `sentence`, `words`) is
 * dropped by these schemas: the screen says its own words from the codes, numbers and days. No money, no person.
 */

const uom = z.enum(UOMS)
export type DepthUom = z.infer<typeof uom>
const named = z.object({ id: z.string(), code: z.string(), name: z.string() })
const step = z.object({ seq: z.number(), code: z.string(), name: z.string() })
const record = z.object({ id: z.string(), number: z.string(), status: z.string() })
const revision = z.object({ id: z.string(), revision: z.number(), status: z.string() })

export const PROTECTABLE = PROTECTABLE_FIELDS
export type ProtectableField = (typeof PROTECTABLE_FIELDS)[number]
export type PlannedKind = (typeof PLANNED_ORDER_KINDS)[number]

const sizeRun = z.array(z.object({ size: z.string(), quantity: z.number() }))

export const plannedOrderSchema = z.object({
  id: z.string(),
  kind: z.enum(PLANNED_ORDER_KINDS),
  status: z.enum(PLANNED_ORDER_STATUSES),
  siteId: z.string(),
  runId: z.string(),
  style: named,
  colourway: z.object({ id: z.string(), code: z.string() }),
  revision: revision.nullable(),
  plannedRevision: revision.nullable(),
  sizes: sizeRun,
  quantity: z.number(),
  sizeGroup: z.string().nullable(),
  startDate: z.string(),
  dueDate: z.string(),
  demand: z.array(z.object({ orderId: z.string(), orderNumber: z.string(), orderLineId: z.string(), lineSeq: z.number(), size: z.string(), pieces: z.number() })),
  line: named.nullable(),
  workshop: named.nullable(),
  operations: z.array(step),
  outsideStepsInHouse: z.array(step),
  kitDueAt: z.string().nullable(),
  firm: z.boolean(),
  firmedAt: z.string().nullable(),
  protectedFields: z.array(z.enum(PROTECTABLE_FIELDS)),
  workOrder: record.nullable(),
  subcontractOrder: record.nullable(),
  convertedAt: z.string().nullable(),
  note: z.string().nullable(),
  version: z.number(),
  /** The API's held words are dropped: present = it cannot be made real now (the screen says why from the row). */
  held: z
    .string()
    .nullable()
    .transform((value) => value !== null),
  late: z.object({ needDate: z.string(), daysLate: z.number() }).nullable(),
  plan: z.object({
    sizes: sizeRun.optional(),
    startDate: z.string().optional(),
    dueDate: z.string().optional(),
    lineId: z.string().nullable().optional(),
    partyId: z.string().nullable().optional(),
    operationSeqs: z.array(z.number()).optional(),
    kitDueAt: z.string().nullable().optional(),
    styleRevisionId: z.string().nullable().optional(),
  }),
  may: z.object({ convert: z.boolean(), firm: z.boolean(), edit: z.boolean() }),
})
export type PlannedOrder = z.infer<typeof plannedOrderSchema>

const plannedListSchema = z.object({
  siteId: z.string(),
  run: z.object({ id: z.string(), startedAt: z.string(), finishedAt: z.string().nullable() }).nullable(),
  counts: z.object({ make: z.number(), subcontract: z.number(), firm: z.number() }),
  plannedOrders: z.array(plannedOrderSchema),
})
export type PlannedList = z.infer<typeof plannedListSchema>

/** The site's planned orders still PLANNED ("To make"), soonest start first. */
export function listPlannedOrders(api: ApiClient, siteId: string, signal?: AbortSignal): Promise<PlannedList> {
  return api.get('/planning/planned-orders', { query: { siteId }, schema: plannedListSchema, signal })
}

const convertResultSchema = z.object({
  id: z.string(),
  kind: z.enum(PLANNED_ORDER_KINDS).nullable(),
  ok: z.boolean(),
  workOrder: z.object({ id: z.string().nullable(), number: z.string().nullable(), status: z.string().nullable(), revision: z.number().nullable(), dueDate: z.string(), cells: z.number(), pieces: z.number() }).nullable(),
  subcontractOrder: z.object({ id: z.string().nullable(), number: z.string().nullable(), workshop: named.nullable(), operations: z.array(step), kitDueAt: z.string().nullable() }).nullable(),
  /** The API's words are dropped: how many problems stop it. */
  problems: z.array(z.string()).transform((list) => list.length),
  error: z.string().nullable(),
})
export type ConvertResult = z.infer<typeof convertResultSchema>
const convertSchema = z.object({ preview: z.boolean(), made: z.number(), held: z.number(), results: z.array(convertResultSchema) })
export type ConvertAnswer = z.infer<typeof convertSchema>

/** "Create n work orders" / "Create n subcontract orders": `preview` says what each becomes, nothing written; else each is made real. */
export function convertPlanned(api: ApiClient, rows: readonly { id: string; version: number }[], preview: boolean, idempotencyKey?: string): Promise<ConvertAnswer> {
  return api.post('/planning/planned-orders/convert', { body: { rows, ...(preview ? { preview: true } : {}) }, schema: convertSchema, ...(preview ? {} : { idempotencyKey: idempotencyKey ?? newIdempotencyKey() }) })
}

const oneSchema = z.object({ plannedOrder: plannedOrderSchema })

/** Firm (the runs keep it as it is) or plan again. */
export async function firmPlanned(api: ApiClient, id: string, version: number, firm: boolean): Promise<PlannedOrder> {
  return (await api.post(`/planning/planned-orders/${encodeURIComponent(id)}/${firm ? 'firm' : 'unfirm'}`, { body: { version }, schema: oneSchema, idempotencyKey: newIdempotencyKey() })).plannedOrder
}

export interface PlannedEdit {
  startDate?: string
  dueDate?: string
}

/** The planner's edit: each field that changes is protected from the next run (`protectedNow`). */
export async function editPlanned(api: ApiClient, id: string, version: number, edit: PlannedEdit): Promise<PlannedOrder> {
  return (await api.request('PATCH', `/planning/planned-orders/${encodeURIComponent(id)}`, { body: { version, ...edit }, schema: oneSchema, idempotencyKey: newIdempotencyKey() })).plannedOrder
}

const resetSchema = z.object({ plannedOrder: plannedOrderSchema, reset: z.array(z.enum(PROTECTABLE_FIELDS)), restored: z.boolean() })
export type ResetAnswer = z.infer<typeof resetSchema>

/** Reset to plan: the fields leave the protected list and take the latest plan's values (else the next run writes them). */
export function resetPlanned(api: ApiClient, id: string, version: number, fields: readonly ProtectableField[]): Promise<ResetAnswer> {
  return api.post(`/planning/planned-orders/${encodeURIComponent(id)}/reset`, { body: { version, fields }, schema: resetSchema, idempotencyKey: newIdempotencyKey() })
}

const bulkSchema = z.object({
  preview: z.boolean(),
  changed: z.number(),
  rows: z.array(
    z.object({
      id: z.string(),
      plannedOrder: plannedOrderSchema.nullable(),
      changes: z.array(z.object({ field: z.enum(PROTECTABLE_FIELDS), from: z.unknown(), to: z.unknown() })),
      /** The API's words are dropped: the fields a problem names. */
      problems: z.array(z.object({ field: z.string(), message: z.string() })).transform((list) => list.map((entry) => entry.field)),
    }),
  ),
})
export type BulkAnswer = z.infer<typeof bulkSchema>

/** Move n planned orders by whole days (start, due and the kit): `preview` for the review, then ONE command (all or none). */
export function shiftPlanned(api: ApiClient, siteId: string, rows: readonly { id: string; version: number }[], shiftDays: number, preview: boolean, idempotencyKey?: string): Promise<BulkAnswer> {
  return api.post('/planning/planned-orders/bulk', { body: { siteId, shiftDays, rows, ...(preview ? { preview: true } : {}) }, schema: bulkSchema, ...(preview ? {} : { idempotencyKey: idempotencyKey ?? newIdempotencyKey() }) })
}

// ---- action messages on existing orders (PLN-073) ---------------------------------------------------------------------------

const fact = z.union([z.string(), z.number(), z.boolean(), z.null()])
export const MESSAGE_ACTIONS = MRP_ACTIONS
export type MessageAction = (typeof MRP_ACTIONS)[number]
export type MessageRecordType = (typeof ACTION_RECORD_TYPES)[number]

export const actionMessageSchema = z.object({
  id: z.string(),
  runId: z.string(),
  seq: z.number(),
  /** `label` is read only for a work or subcontract order (its number); the other records are named from `facts`. */
  record: z.object({ type: z.enum(ACTION_RECORD_TYPES), id: z.string(), label: z.string(), open: z.object({ type: z.string(), id: z.string() }) }),
  action: z.enum(MRP_ACTIONS),
  fromDate: z.string().nullable(),
  toDate: z.string().nullable(),
  fromQuantity: z.string().nullable(),
  toQuantity: z.string().nullable(),
  uom: uom.nullable(),
  facts: z.record(z.string(), fact),
  status: z.enum(ACTION_STATUSES),
  decidedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
  version: z.number(),
  may: z.object({ decide: z.boolean() }),
})
export type ActionMessage = z.infer<typeof actionMessageSchema>
const messagesSchema = z.object({
  siteId: z.string(),
  run: z.object({ id: z.string(), startedAt: z.string(), finishedAt: z.string().nullable() }).nullable(),
  counts: z.object({ open: z.number(), done: z.number(), ignored: z.number() }),
  byAction: z.array(z.object({ action: z.enum(MRP_ACTIONS), open: z.number() })),
  messages: z.array(actionMessageSchema),
})
export type ActionMessages = z.infer<typeof messagesSchema>

/** The latest DONE run's messages (open ones by default; `all` adds the decided ones). */
export function listActionMessages(api: ApiClient, siteId: string, all: boolean, signal?: AbortSignal): Promise<ActionMessages> {
  return api.get('/planning/action-messages', { query: { siteId, ...(all ? { status: 'OPEN,DONE,IGNORED' } : {}) }, schema: messagesSchema, signal })
}

/** Done or Ignored (with a note), ONE command for every message named (all or nothing). */
export function decideActionMessages(api: ApiClient, messages: readonly { id: string; version: number }[], status: 'DONE' | 'IGNORED', note: string): Promise<{ decided: number }> {
  return api.post('/planning/action-messages/decide', {
    body: { messages, status, ...(note.trim() ? { note: note.trim() } : {}) },
    schema: z.object({ decided: z.number() }),
    idempotencyKey: newIdempotencyKey(),
  })
}

// ---- the run log (PLN-095) ----------------------------------------------------------------------------------------------------

const count = z.number()
export const INPUT_COUNTS = [
  'orderLines',
  'orderLinesPlanned',
  'orders',
  'lateOrderLines',
  'undatedOrderLines',
  'madeToMeasure',
  'notPlaced',
  'revisions',
  'materials',
  'workOrders',
  'workOrderCells',
  'scheduledWorkOrders',
  'stockLines',
  'lots',
  'purchaseLines',
  'purchaseOrders',
  'purchaseLinesForOneOrder',
  'reservations',
  'firmPlannedOrders',
  'orderSpecificPegs',
  'itemParameters',
  'approvedSources',
  'plannedWorkOrdersFirm',
  'plannedWorkOrdersProtected',
  'plannedWorkOrdersPlain',
] as const
export type InputCount = (typeof INPUT_COUNTS)[number]

const runLogSchema = z.object({
  run: z.object({ id: z.string(), siteId: z.string(), trigger: z.string(), status: z.string(), startedAt: z.string(), finishedAt: z.string().nullable(), orderLines: z.number() }),
  inputs: z
    .object({
      version: z.literal(1),
      runDate: z.string(),
      timezone: z.string(),
      previousRunId: z.string().nullable(),
      explosion: z.enum(['MULTI_LEVEL', 'ONE_LEVEL']),
      passes: count,
      sizeRunRule: z.string(),
      sizeGroups: count,
      counts: z.object(Object.fromEntries(INPUT_COUNTS.map((key) => [key, count])) as Record<InputCount, typeof count>),
    })
    .nullable(),
  warningCounts: z.array(z.object({ code: z.enum(WARNING_CODES), count })),
  proposals: z.object({
    requirements: z.array(
      z.object({
        id: z.string(),
        seq: count,
        action: z.enum(REQUIREMENT_ACTIONS),
        item: z.object({ id: z.string(), code: z.string() }),
        colour: z.object({ id: z.string(), code: z.string() }).nullable(),
        netQuantity: z.string(),
        uom,
        needDate: z.string(),
        decision: z.enum(REQUIREMENT_DECISIONS),
        firm: z.boolean(),
        orderSpecific: z.object({ orderLineId: z.string(), orderNumber: z.string(), lineSeq: count }).nullable(),
      }),
    ),
    plannedOrders: z.array(
      z.object({
        id: z.string(),
        kind: z.enum(PLANNED_ORDER_KINDS),
        status: z.enum(PLANNED_ORDER_STATUSES),
        /** The style and colourway codes ("SEED-JKT-01 BLK"). */
        label: z.string(),
        quantity: count,
        startDate: z.string(),
        dueDate: z.string(),
        needDate: z.string(),
        firm: z.boolean(),
        protectedFields: z.array(z.enum(PROTECTABLE_FIELDS)),
      }),
    ),
  }),
  actionMessages: z.object({ open: count, done: count, ignored: count }),
})
export type RunLog = z.infer<typeof runLogSchema>

/** What a run read, its warnings by code and its proposals (an older run: `inputs` null — not recorded). */
export function getRunLog(api: ApiClient, runId: string, signal?: AbortSignal): Promise<RunLog> {
  return api.get(`/planning/runs/${encodeURIComponent(runId)}/log`, { schema: runLogSchema, signal })
}

// ---- the projected stock of a material (PLN-084) and the calculated delays (PLN-082) -----------------------------------------

const order = z.object({ id: z.string(), number: z.string(), rank: z.number().nullable() })
const delayDemand = z.object({
  order,
  orderLine: z.object({ id: z.string(), seq: z.number() }),
  size: z.string().nullable(),
  workOrder: z.object({ id: z.string(), number: z.string() }).nullable(),
  needDate: z.string(),
  earliest: z.string(),
  daysLate: z.number(),
  source: z.enum(DELAY_SOURCES),
  arrival: z.string(),
})
const material = { item: z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string(), baseUom: uom }), colour: named.nullable() }

const profileRowSchema = z.object({
  key: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  demand: z.string(),
  receipts: z.string(),
  planned: z.string(),
  projected: z.string(),
  projectedWithPlan: z.string(),
  atp: z.string(),
  short: z.boolean(),
  belowSafety: z.boolean(),
  demandRefs: z.array(z.object({ order, orderLine: z.object({ id: z.string(), seq: z.number() }), size: z.string().nullable(), workOrder: z.object({ id: z.string(), number: z.string() }).nullable(), day: z.string(), quantity: z.string() })),
  receiptRefs: z.array(
    z.object({ kind: z.enum(['PURCHASE_ORDER', 'FIRM']), day: z.string(), quantity: z.string(), purchaseOrder: z.object({ id: z.string(), number: z.string(), lineId: z.string(), lineSeq: z.number() }).nullable(), requirementId: z.string().nullable() }),
  ),
  plannedRefs: z.array(z.object({ seq: z.number(), day: z.string(), quantity: z.string() })),
})
export type ProfileRow = z.infer<typeof profileRowSchema>

const profileSchema = z.object({
  site: z.object({ id: z.string(), code: z.string(), name: z.string(), timeZone: z.string() }),
  asOf: z.string(),
  today: z.string(),
  ...material,
  uom,
  parameters: z.object({ itemPlanningId: z.string(), method: z.string(), lotSizing: z.enum(LOT_SIZINGS), safetyStock: z.string().nullable(), delayDays: z.number().nullable() }).nullable(),
  requirements: z.array(z.object({ runId: z.string(), id: z.string(), seq: z.number() })),
  horizon: z.object({ from: z.string(), to: z.string(), weeks: z.number() }),
  onHand: z.string(),
  safetyStock: z.string().nullable(),
  totals: z.object({ demand: z.string(), receipts: z.string(), planned: z.string() }),
  rows: z.array(profileRowSchema),
  firstShort: z.string().nullable(),
  firstBelowSafety: z.string().nullable(),
  net: z.string(),
  uncovered: z.string(),
  allocation: z.enum(ALLOCATIONS),
  lots: z.object({ list: z.array(z.object({ seq: z.number(), date: z.string(), quantity: z.string(), covers: z.object({ from: z.string(), to: z.string() }) })) }),
  earliest: z.object({ leadTimeDays: z.number().nullable(), delayDays: z.number().nullable(), arrival: z.string(), usable: z.string() }),
  delays: z.array(delayDemand),
})
export type ItemProfile = z.infer<typeof profileSchema>

/** The material's projected stock per week at the site, from the plan computed now (13 weeks unless asked). */
export function getItemProfile(api: ApiClient, query: { siteId: string; itemId: string; itemColourId: string | null; weeks?: number }, signal?: AbortSignal): Promise<ItemProfile> {
  return api.get('/planning/item-profile', { query: { siteId: query.siteId, itemId: query.itemId, itemColourId: query.itemColourId ?? 'none', weeks: query.weeks ?? 13 }, schema: profileSchema, signal })
}

const delaysSchema = z.object({
  today: z.string(),
  tiles: z.object({ delayedDemands: z.number(), delayedOrders: z.number(), materials: z.number(), mostDaysLate: z.number().nullable() }),
  demands: z.array(delayDemand.extend({ setBy: z.object(material), materials: z.array(z.object({ ...material, earliest: z.string(), daysLate: z.number(), source: z.enum(DELAY_SOURCES) })) })),
})
export type Delays = z.infer<typeof delaysSchema>
export type DelayDemand = Delays['demands'][number]

/** The order lines whose material cannot be there in time: the earliest day, the days late and the material that sets it. */
export function getDelays(api: ApiClient, siteId: string, signal?: AbortSignal): Promise<Delays> {
  return api.get('/planning/delays', { query: { siteId }, schema: delaysSchema, signal })
}
