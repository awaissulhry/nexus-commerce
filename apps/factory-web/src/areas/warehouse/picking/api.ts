import { z } from 'zod'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * Every call of Warehouse › Picking & kits (SCR-237; B-W2a-58, apps/factory-api modules/inventory/issue/contract.ts),
 * with the answer's shape checked (zod; unknown fields are dropped). Paths start `/inventory/picking/pick-lists`.
 * Quantities only (no money); no person: a pick is said by its team or "the office". The API's English is never drawn:
 * the screens say their own words from codes, dates and figures.
 */

export const READINESS_WORDS = ['NOT_ENOUGH', 'DELAYED', 'REQUESTED', 'EXPECTED', 'NOT_BOOKED', 'RECEIVED', 'NOT_PLANNED'] as const
export type ReadinessWord = (typeof READINESS_WORDS)[number]
export const KIT_STATUSES = ['OPEN', 'PARTLY', 'COMPLETE'] as const
export type KitStatus = (typeof KIT_STATUSES)[number]
export const PICK_VIEWS = ['all', 'today', 'waiting', 'complete', 'toCreate'] as const
export type PickView = (typeof PICK_VIEWS)[number]
const WORK_ORDER_STATUSES = ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CLOSED', 'CANCELLED'] as const
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number]
const UNUSABLE_REASONS = ['CR_VI_PENDING', 'CR_VI_FAILED', 'QUALITY_HOLD', 'BLOCKED', 'REJECTED'] as const
export type UnusableReason = (typeof UNUSABLE_REASONS)[number]

const uom = z.enum(UOMS)
const decimal = z.string()

const readinessMaterial = z.object({
  itemId: z.string(),
  itemColourId: z.string().nullable(),
  label: z.string(),
  uom,
  word: z.enum(READINESS_WORDS),
  date: z.string().nullable(),
  needed: decimal,
  issued: decimal,
  reserved: decimal,
  inStock: decimal,
  onOrder: decimal,
  short: decimal,
  purchaseOrders: z.array(z.object({ id: z.string(), number: z.string(), status: z.string(), dueDate: z.string() })),
})
export type ReadinessMaterial = z.infer<typeof readinessMaterial>
const readiness = z.object({ word: z.enum(READINESS_WORDS), date: z.string().nullable(), materials: z.array(readinessMaterial) })
export type Readiness = z.infer<typeof readiness>

const workOrder = z.object({
  id: z.string(),
  number: z.string(),
  status: z.enum(WORK_ORDER_STATUSES),
  kind: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  dueDate: z.string().nullable(),
  priority: z.number(),
  pieces: z.number(),
  style: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  onHold: z.object({ reason: z.string().nullable(), from: z.enum(WORK_ORDER_STATUSES).nullable() }).nullable(),
})
export type KitWorkOrder = z.infer<typeof workOrder>
const pickedBy = z.array(z.object({ kind: z.enum(['OFFICE', 'TEAM']), name: z.string().nullable() }))
export type PickedBy = z.infer<typeof pickedBy>
const pickList = z.object({ created: z.boolean(), reservations: z.number(), createdAt: z.string().nullable() })
/** B-W2b-15: the kit record — where it waits, when it was checked complete (never who), its version (0: none yet). */
const kitPlace = z.object({ id: z.string(), code: z.string(), name: z.string() })
const kit = z.object({ status: z.enum(KIT_STATUSES), location: kitPlace.nullable(), checkedAt: z.string().nullable(), version: z.number() })
export type KitView = z.infer<typeof kit>

const rowSchema = z.object({
  workOrder,
  cutDate: z.string().nullable(),
  readiness,
  lines: z.object({ all: z.number(), picked: z.number(), short: z.number() }),
  kit,
  pickList,
  pickedBy,
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
})
export type PickRow = z.infer<typeof rowSchema>

const tilesSchema = z.object({ today: z.number(), waiting: z.number(), complete: z.number(), toCreate: z.number(), all: z.number() })
export type PickTiles = z.infer<typeof tilesSchema>
const listSchema = z.object({
  asOf: z.string(),
  sites: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })),
  tiles: tilesSchema,
  rows: z.array(rowSchema),
  total: z.number(),
  nextCursor: z.string().nullable(),
})
export type PickListPage = z.infer<typeof listSchema>

const place = z.object({ locationId: z.string(), locationCode: z.string(), onHand: decimal })
const hold = z.object({ id: z.string(), subjectType: z.enum(['Lot', 'Hide']), reasonCode: z.string(), reasonIt: z.string(), reasonEn: z.string(), placedAt: z.string() })
const sheetLine = z.object({
  itemId: z.string(),
  itemCode: z.string(),
  itemName: z.string(),
  tracking: z.enum(['NONE', 'LOT', 'HIDE', 'SERIAL']),
  baseUom: uom,
  itemColourId: z.string().nullable(),
  colourCode: z.string().nullable(),
  colourName: z.string().nullable(),
  planned: decimal,
  issued: decimal,
  toIssue: decimal,
  over: decimal,
  covered: z.boolean(),
  held: z.array(
    z.object({
      reason: z.enum(UNUSABLE_REASONS),
      lotId: z.string(),
      lotCode: z.string(),
      onHand: decimal,
      hides: z.number(),
      hideId: z.string().nullable().optional(),
      hideCode: z.string().nullable().optional(),
      hold: hold.optional(),
    }),
  ),
  atWorkOrder: z.array(z.object({ lotId: z.string().nullable(), lotCode: z.string().nullable(), hideId: z.string().nullable(), hideCode: z.string().nullable(), quantity: decimal })),
  pick: z.object({
    reserved: decimal,
    short: decimal,
    proposed: z.array(z.object({ kind: z.enum(['HIDE', 'LOT', 'ANY']), lotId: z.string().nullable(), lotCode: z.string().nullable(), hideId: z.string().nullable(), hideCode: z.string().nullable(), quantity: decimal, locations: z.array(place) })),
    reservations: z.array(
      z.object({ id: z.string(), status: z.enum(['ACTIVE', 'ISSUED', 'RELEASED']), lotId: z.string().nullable(), lotCode: z.string().nullable(), hideId: z.string().nullable(), hideCode: z.string().nullable(), quantity: decimal, issued: decimal, locations: z.array(place) }),
    ),
  }),
})
export type SheetLine = z.infer<typeof sheetLine>
export type HeldEntry = SheetLine['held'][number]
const sheetSchema = z.object({
  workOrder: workOrder.extend({ batchNumber: z.string().nullable(), version: z.number(), issuable: z.boolean() }),
  cutDate: z.string().nullable(),
  readiness,
  kit: kit.extend({ all: z.number(), picked: z.number(), short: z.number() }),
  pickList,
  pickedBy,
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  lines: z.array(sheetLine),
})
export type PickSheet = z.infer<typeof sheetSchema>

const resultSchema = z.object({
  workOrderId: z.string(),
  number: z.string().nullable(),
  outcome: z.enum(['CREATED', 'NOTHING_TO_RESERVE', 'REFUSED']),
  reserved: z.array(z.object({ itemCode: z.string(), colourCode: z.string().nullable(), kind: z.enum(['HIDE', 'LOT', 'ANY']), lotCode: z.string().nullable(), hideCode: z.string().nullable(), quantity: decimal, baseUom: uom })),
  short: z.array(z.object({ itemCode: z.string(), colourCode: z.string().nullable(), quantity: decimal, baseUom: uom })),
  refusal: z.object({ code: z.string(), message: z.string() }).nullable(),
})
export type CreateResult = z.infer<typeof resultSchema>

type Query = Readonly<Record<string, string | number | boolean | null | undefined>>
const clean = (query: Query): Query => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ''))

export interface PickListsQuery {
  siteId?: string | null
  view?: PickView
  q?: string | null
  cursor?: string | null
  limit?: number
}

export const listPickLists = (api: ApiClient, query: PickListsQuery, signal?: AbortSignal) =>
  api.get('/inventory/picking/pick-lists', { query: clean({ siteId: query.siteId, view: query.view, q: query.q?.trim(), cursor: query.cursor, limit: query.limit }), schema: listSchema, signal })

export const pickListSheets = (api: ApiClient, workOrderIds: readonly string[], signal?: AbortSignal) =>
  api.get('/inventory/picking/pick-lists/sheet', { query: { workOrderIds: workOrderIds.join(',') }, schema: z.object({ asOf: z.string(), sheets: z.array(sheetSchema) }), signal })

export const createPickLists = (api: ApiClient, siteId: string, workOrderIds: readonly string[]) =>
  api.post('/inventory/picking/pick-lists', { body: { siteId, workOrderIds }, schema: z.object({ created: z.number(), results: z.array(resultSchema) }), idempotencyKey: newIdempotencyKey() })

// ---- B-W2b-15: the kit of one work order (modules/inventory/kits) -------------------------------------------------------------

export const KIT_HELD_CODES = ['WORK_ORDER_NOT_OPEN', 'LINES_SHORT', 'NOTHING_PLANNED', 'ALREADY_CHECKED', 'NOT_CHECKED'] as const
const kitAction = z.object({ allowed: z.boolean(), held: z.enum(KIT_HELD_CODES).nullable(), count: z.number().optional() })
const kitRecord = z.object({
  workOrderId: z.string(),
  number: z.string(),
  workOrderStatus: z.string(),
  siteId: z.string(),
  status: z.enum(KIT_STATUSES),
  lines: z.object({ all: z.number(), picked: z.number(), short: z.number() }),
  location: kitPlace.nullable(),
  checkedAt: z.string().nullable(),
  note: z.string().nullable(),
  version: z.number(),
  actions: z.object({ stage: kitAction, complete: kitAction, reopen: kitAction }),
})
export type KitRecord = z.infer<typeof kitRecord>
const kitAnswer = z.object({ kit: kitRecord })
const kitPath = (workOrderId: string) => `/inventory/kits/${encodeURIComponent(workOrderId)}`

/** The kit staged at a place of the work order's site (null: taken off its place); the version read (0: no record yet). */
export const stageKit = (api: ApiClient, workOrderId: string, version: number, locationId: string | null) =>
  api.post(`${kitPath(workOrderId)}/stage`, { body: { version, locationId }, schema: kitAnswer, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.kit)

/** "Mark kit complete": every line is picked; the API holds it while a line is short (409 kit/LINES_SHORT). */
export const completeKit = (api: ApiClient, workOrderId: string, version: number) =>
  api.post(`${kitPath(workOrderId)}/complete`, { body: { version }, schema: kitAnswer, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.kit)

/** A kit checked complete is open again, with the reason (kept in the work order's history). */
export const reopenKit = (api: ApiClient, workOrderId: string, version: number, reason: string) =>
  api.post(`${kitPath(workOrderId)}/reopen`, { body: { version, reason }, schema: kitAnswer, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.kit)
