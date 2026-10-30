import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { pickerReasons, type PickerReason } from '../../../_shared/reasons/api'
import { READINESS_WORDS, WORK_ORDER_STATUSES } from '../../_shared/api'

/**
 * The work order every day (B-W2a-46): every call of the W2a parts of the work order screens, each answer checked by its
 * schema — the readiness word of the list's rows (`GET /production/work-orders/readiness`), holds (`/quality/holds…`,
 * B-W2a-26: place, read, release with the office's step-up), report finished to stock (`…/finished`, B-W2a-12), the
 * yield (`/production/yield/work-orders/:id`, B-W2a-13), scrap and rework (`GET /production/scrap`), leather availability
 * and reserve (`/inventory/reservations…`, B-W2a-11), split a bundle (`POST /production/bundles/:id/split`) and the HOLD
 * reasons (`GET /reasons?list=HOLD`, B-W2a-18). Whole garments and quantities only: no money is read here.
 */

// ---- readiness of many work orders ---------------------------------------------------------------------------------------------

const readinessRowSchema = z.object({
  workOrderId: z.string(),
  word: z.enum(READINESS_WORDS),
  date: z.string().nullable(),
  open: z.number(),
  materials: z.array(z.object({ itemId: z.string(), itemColourId: z.string().nullable(), word: z.enum(READINESS_WORDS), date: z.string().nullable() })),
  asOf: z.string(),
})
export type ReadinessRow = z.infer<typeof readinessRowSchema>

export async function getReadiness(api: ApiClient, ids: readonly string[], signal?: AbortSignal): Promise<ReadinessRow[]> {
  if (ids.length === 0) return []
  return (await api.get('/production/work-orders/readiness', { query: { ids: ids.slice(0, 100).join(',') }, schema: z.object({ workOrders: z.array(readinessRowSchema) }), signal })).workOrders
}

// ---- holds -------------------------------------------------------------------------------------------------------------------------

export const HOLD_STATUSES = ['ACTIVE', 'RELEASED', 'CLOSED'] as const
const holdSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  status: z.enum(HOLD_STATUSES),
  subjectType: z.string(),
  subjects: z.array(z.object({ id: z.string(), label: z.string().nullable(), state: z.string().nullable() })),
  reasonCode: z.string(),
  reasonNote: z.string().nullable(),
  placedAt: z.string(),
  placedBy: z.object({ kind: z.enum(['USER', 'WORKER', 'SYSTEM']), userId: z.string().nullable() }),
  expectedReleaseOn: z.string().nullable(),
  overdue: z.boolean(),
  ageDays: z.number(),
  ncrId: z.string().nullable(),
  releasedAt: z.string().nullable(),
  version: z.number(),
})
export type Hold = z.infer<typeof holdSchema>

export async function listHolds(api: ApiClient, query: { subjectType: 'WorkOrder' | 'Bundle'; subjectId?: string; siteId?: string; status?: 'ACTIVE' | 'ALL' }, signal?: AbortSignal): Promise<Hold[]> {
  return (await api.get('/quality/holds', { query: { status: query.status ?? 'ACTIVE', subjectType: query.subjectType, subjectId: query.subjectId, siteId: query.siteId }, schema: z.object({ holds: z.array(holdSchema), truncated: z.boolean() }), signal })).holds
}

const releaseCheckLine = z.object({ key: z.string(), ok: z.boolean(), words: z.string() })
const holdRecordSchema = z.object({ hold: holdSchema, release: z.object({ checks: z.array(releaseCheckLine), releasable: z.boolean(), mayRelease: z.boolean() }) })
export type HoldRecord = z.infer<typeof holdRecordSchema>

export function getHold(api: ApiClient, holdId: string, signal?: AbortSignal): Promise<HoldRecord> {
  return api.get(`/quality/holds/${encodeURIComponent(holdId)}`, { schema: holdRecordSchema, signal })
}

const woStatus = z.enum(WORK_ORDER_STATUSES)

/** quality.holds.place: one hold over the work orders asked (their status goes ON_HOLD; the floor refuses their work). */
export function placeHold(api: ApiClient, body: { workOrderIds: readonly string[]; reasonCode: string; reasonNote: string | null }, idempotencyKey = newIdempotencyKey()) {
  return api.post('/quality/holds', {
    body: { subjectType: 'WorkOrder', subjectIds: [...body.workOrderIds], reasonCode: body.reasonCode, reasonNote: body.reasonNote },
    schema: z.object({ hold: holdSchema, workOrdersHeld: z.array(z.object({ id: z.string(), number: z.string(), from: woStatus })) }),
    idempotencyKey,
  })
}

/** quality.holds.release (+ the office's step-up): the hold released; its work orders go back where they were. */
export function releaseHold(api: ApiClient, holdId: string, body: { version: number; note: string | null; notMakerStatement: boolean }, idempotencyKey: string) {
  return api.post(`/quality/holds/${encodeURIComponent(holdId)}/release`, {
    body,
    schema: z.object({ hold: holdSchema, workOrdersLifted: z.array(z.object({ id: z.string(), number: z.string(), to: woStatus })) }),
    idempotencyKey,
  })
}

export function holdReasons(api: ApiClient, signal?: AbortSignal): Promise<PickerReason[]> {
  return pickerReasons(api, ['HOLD'], signal)
}

// ---- report finished to stock ----------------------------------------------------------------------------------------------------

export const finishedSchema = z.object({
  workOrderId: z.string(),
  number: z.string(),
  status: woStatus,
  kind: z.string(),
  version: z.number(),
  siteCode: z.string(),
  blockers: z.array(z.string()),
  reportable: z.boolean(),
  places: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string(), parentId: z.string().nullable(), status: z.string() })),
  defaultLocationId: z.string().nullable(),
  cells: z.array(
    z.object({
      cellId: z.string(),
      colourwayCode: z.string(),
      size: z.string(),
      sku: z.string().nullable(),
      quantity: z.number(),
      netReleased: z.number(),
      onShipments: z.number(),
      heldSerials: z.number(),
      inStock: z.number(),
      canReport: z.number(),
    }),
  ),
  garments: z.object({ pieces: z.number(), netReleased: z.number(), inStock: z.number(), canReport: z.number() }),
  allInStock: z.boolean(),
  tracking: z.enum(['BATCH', 'SERIAL']),
  reports: z.array(z.object({ id: z.string(), at: z.string(), locationCode: z.string().nullable(), pieces: z.number(), open: z.number(), note: z.string().nullable(), reversed: z.object({ at: z.string(), reason: z.string().nullable() }).nullable() })),
})
export type Finished = z.infer<typeof finishedSchema>

export async function getFinished(api: ApiClient, workOrderId: string, signal?: AbortSignal): Promise<Finished> {
  return (await api.get(`/production/work-orders/${encodeURIComponent(workOrderId)}/finished`, { schema: z.object({ finished: finishedSchema }), signal })).finished
}

/** production.finish: the garments asked per cell (all a cell can when none is asked) into a finished-goods place. */
export async function reportFinished(api: ApiClient, workOrderId: string, body: { cells: Array<{ cellId: string; quantity: number }>; toLocationId: string | null; note: string | null }, idempotencyKey = newIdempotencyKey()) {
  return api.post(`/production/work-orders/${encodeURIComponent(workOrderId)}/finished`, {
    body: { cells: body.cells, ...(body.toLocationId ? { toLocationId: body.toLocationId } : {}), ...(body.note ? { note: body.note } : {}) },
    schema: z.object({ report: z.object({ id: z.string(), pieces: z.number(), locationCode: z.string() }), finished: finishedSchema }),
    idempotencyKey,
  })
}

// ---- yield -----------------------------------------------------------------------------------------------------------------------

const figures = { used: z.string(), unmatched: z.string(), pattern: z.string(), remnant: z.string(), waste: z.string(), wastePct: z.string().nullable(), yieldPct: z.string().nullable(), plannedPct: z.string().nullable(), variancePct: z.string().nullable() }
export const yieldSchema = z.object({
  plannedSource: z.enum(['STYLE', 'BOM']),
  overall: z.object(figures),
  hides: z.array(z.object({ hide: z.object({ id: z.string(), code: z.string(), grade: z.string().nullable(), shade: z.string().nullable(), state: z.string() }), lot: z.object({ id: z.string(), code: z.string(), supplierLotRef: z.string().nullable() }), supplier: z.object({ id: z.string(), name: z.string() }).nullable(), item: z.object({ id: z.string(), code: z.string(), uom: z.string() }), areaIn: z.string(), ...figures })),
})
export type Yield = z.infer<typeof yieldSchema>

export function getYield(api: ApiClient, workOrderId: string, signal?: AbortSignal): Promise<Yield> {
  return api.get(`/production/yield/work-orders/${encodeURIComponent(workOrderId)}`, { schema: yieldSchema, signal })
}

// ---- scrap and rework -----------------------------------------------------------------------------------------------------------

export const REWORK_STATUSES = ['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED'] as const
const scrapRowSchema = z.object({
  id: z.string(),
  kind: z.enum(['SCRAP', 'REWORK']),
  at: z.string(),
  bundle: z.object({ id: z.string(), code: z.string() }).nullable(),
  operation: z.object({ id: z.string(), seq: z.number(), code: z.string(), name: z.string() }).nullable(),
  cell: z.object({ id: z.string(), colourwayCode: z.string(), size: z.string() }),
  pieces: z.number(),
  reasonCode: z.string(),
  reasonLabel: z.object({ it: z.string(), en: z.string() }).nullable(),
  status: z.string().nullable(),
})
export type ScrapRow = z.infer<typeof scrapRowSchema>

/** production.scrap.view: the work order's scrap and rework (per scan line and rework order; no value is drawn here). */
export async function getScrap(api: ApiClient, workOrderId: string, signal?: AbortSignal): Promise<ScrapRow[]> {
  return (await api.get('/production/scrap', { query: { workOrderId, limit: 500 }, schema: z.object({ rows: z.array(scrapRowSchema) }), signal })).rows
}

// ---- reserve leather (the Find hides dialog) --------------------------------------------------------------------------------------

export const availabilitySchema = z.object({
  site: z.object({ id: z.string(), code: z.string() }),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), baseUom: z.string() }),
  colour: z.object({ id: z.string(), code: z.string() }).passthrough().nullable(),
  hides: z.array(
    z.object({
      hide: z.object({ id: z.string(), code: z.string() }),
      lotId: z.string().nullable(),
      onHand: z.string(),
      held: z.boolean(),
      reservedFor: z.object({ type: z.string(), id: z.string() }).passthrough().nullable(),
    }),
  ),
})
export type Availability = z.infer<typeof availabilitySchema>

export function getAvailability(api: ApiClient, query: { siteId: string; itemId: string; itemColourId: string | null }, signal?: AbortSignal): Promise<Availability> {
  return api.get('/inventory/reservations/availability', { query: { siteId: query.siteId, itemId: query.itemId, itemColourId: query.itemColourId ?? undefined }, schema: availabilitySchema, signal })
}

/** inventory.reserve: the hides asked, each reserved whole for this work order. */
export function reserveHides(api: ApiClient, body: { siteId: string; workOrderId: string; hideIds: readonly string[] }, idempotencyKey = newIdempotencyKey()) {
  return api.post('/inventory/reservations', {
    body: { siteId: body.siteId, workOrderId: body.workOrderId, lines: body.hideIds.map((hideId) => ({ hideId })) },
    schema: z.object({ reservations: z.array(z.object({ id: z.string() }).passthrough()) }),
    idempotencyKey,
  })
}

// ---- split a bundle --------------------------------------------------------------------------------------------------------------

export const SPLIT_REASONS = ['REWORK', 'RECUT', 'HOLD'] as const
export type SplitReason = (typeof SPLIT_REASONS)[number]

/** production.bundles: part of a bundle into a child bundle with its own ticket (genealogy kept). */
export function splitBundle(api: ApiClient, bundleId: string, body: { quantity: number; reason: SplitReason; note: string | null; printerId: string | null }, idempotencyKey = newIdempotencyKey()) {
  return api.post(`/production/bundles/${encodeURIComponent(bundleId)}/split`, {
    body: { quantity: body.quantity, reason: body.reason, ...(body.note ? { note: body.note } : {}), ...(body.printerId ? { printerId: body.printerId } : {}) },
    schema: z.object({ bundle: z.object({ id: z.string(), code: z.string(), quantity: z.number() }).passthrough(), parent: z.object({ id: z.string(), code: z.string() }).passthrough() }),
    idempotencyKey,
  })
}
