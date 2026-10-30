import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'
import { HIDE_STATES, WORK_ORDER_STATUSES } from '../_shared/api'

/**
 * The cutting office (B-W2a-60; SCR-238): every call of its screens, each answer checked by its schema — the cuts across
 * work orders with the tiles (`GET /production/cutting/cuts`, production.cutting.view), the room's yield of a day
 * (`GET /production/yield`), a work order's yield (`GET /production/yield/work-orders/:id`), its recuts
 * (`/production/replacements`, production.scrap.view; done by a cut log entry with production.scrap), the hides
 * allocated to it (`GET /inventory/reservations`, inventory.stock.view) and the void of a bundle
 * (`POST /production/bundles/:id/void`). The cut log, the bundles and their reprint are the work order's own calls
 * (`_shared/api.ts`); the Find hides dialog's availability and reserve are the work order's too (`work-orders/daily/api.ts`).
 * No money is read here: areas, pieces and percentages only.
 */

export const CUT_STATES = ['WAITING', 'CUTTING', 'CUT', 'HELD'] as const
export type CutState = (typeof CUT_STATES)[number]
export const CUT_VIEWS = ['open', 'waiting', 'cutting', 'cut', 'held', 'all'] as const
export type CutView = (typeof CUT_VIEWS)[number]

const pct = z.string().nullable()
const named = z.object({ id: z.string(), code: z.string(), name: z.string() })

export const cutRowSchema = z.object({
  workOrder: z.object({
    id: z.string(),
    number: z.string(),
    batchNumber: z.string().nullable(),
    status: z.enum(WORK_ORDER_STATUSES),
    companyId: z.string(),
    siteId: z.string(),
    dueDate: z.string().nullable(),
    priority: z.number(),
    holdReason: z.string().nullable(),
  }),
  style: named,
  kind: z.literal('LEATHER'),
  state: z.enum(CUT_STATES),
  materials: z.array(z.object({ itemId: z.string(), itemColourId: z.string().nullable(), code: z.string(), name: z.string(), baseUom: z.string(), colourCode: z.string().nullable() })),
  lots: z.array(z.object({ id: z.string(), code: z.string(), dyeBatch: z.string().nullable() })),
  garments: z.object({ planned: z.number(), cut: z.number(), toCut: z.number() }),
  pieces: z.object({ planned: z.number(), cut: z.number() }),
  hides: z.object({ count: z.number(), used: z.array(z.object({ uom: z.string(), area: z.string() })) }),
  allocated: z.number(),
  yield: z.object({ yieldPct: pct, plannedPct: pct, variancePct: pct, plannedSource: z.enum(['STYLE', 'BOM']) }),
  stations: z.array(z.object({ id: z.string(), code: z.string() })),
  lastCutAt: z.string().nullable(),
  recutsOpen: z.number(),
})
export type CutRow = z.infer<typeof cutRowSchema>

export const cutTilesSchema = z.object({ waiting: z.number(), cutting: z.number(), held: z.number(), piecesToday: z.number(), hidesToday: z.number(), areaTodayM2: z.string() })
export type CutTiles = z.infer<typeof cutTilesSchema>

const cutsSchema = z.object({ cuts: z.array(cutRowSchema), more: z.boolean(), tiles: cutTilesSchema, asOf: z.string() })
export type CutsPage = z.infer<typeof cutsSchema>

export function listCuts(api: ApiClient, query: { view: CutView; q: string; limit: number }, signal?: AbortSignal): Promise<CutsPage> {
  return api.get('/production/cutting/cuts', { query: { view: query.view, q: query.q.trim() || undefined, limit: query.limit }, schema: cutsSchema, signal })
}

// ---- yield ------------------------------------------------------------------------------------------------------------------

const figures = {
  used: z.string(),
  unmatched: z.string(),
  pattern: z.string(),
  remnant: z.string(),
  waste: z.string(),
  wastePct: pct,
  yieldPct: pct,
  plannedPct: pct,
  variancePct: pct,
}
export const yieldFiguresSchema = z.object(figures)
export type YieldFigures = z.infer<typeof yieldFiguresSchema>

const yieldHideSchema = z.object({
  hide: z.object({ id: z.string(), code: z.string(), grade: z.string().nullable(), shade: z.string().nullable(), state: z.enum(HIDE_STATES) }),
  lot: z.object({ id: z.string(), code: z.string(), supplierLotRef: z.string().nullable() }),
  supplier: z.object({ id: z.string(), name: z.string() }).nullable(),
  item: z.object({ id: z.string(), code: z.string(), uom: z.string() }),
  areaIn: z.string(),
  ...figures,
})
export type YieldHide = z.infer<typeof yieldHideSchema>

export const workOrderYieldSchema = z.object({
  workOrder: z.object({ id: z.string(), number: z.string(), status: z.enum(WORK_ORDER_STATUSES) }),
  plannedSource: z.enum(['STYLE', 'BOM']),
  overall: yieldFiguresSchema,
  hides: z.array(yieldHideSchema),
})
export type WorkOrderYield = z.infer<typeof workOrderYieldSchema>

/** workorders.view: a work order's hides, its yield against its style's plan (never by cutter). */
export function getWorkOrderYield(api: ApiClient, workOrderId: string, signal?: AbortSignal): Promise<WorkOrderYield> {
  return api.get(`/production/yield/work-orders/${encodeURIComponent(workOrderId)}`, { schema: workOrderYieldSchema, signal })
}

/** production.cutting.view: the room's yield between two instants (the tile "Yield today vs plan"). */
export async function roomYield(api: ApiClient, range: { from: string; to: string }, signal?: AbortSignal): Promise<YieldFigures> {
  return (await api.get('/production/yield', { query: { from: range.from, to: range.to }, schema: z.object({ overall: yieldFiguresSchema }), signal })).overall
}

// ---- recuts (replacements of scrapped pieces, B-W2a-13) ------------------------------------------------------------------------

export const REPLACEMENT_STATUSES = ['OPEN', 'APPROVED', 'REFUSED', 'DONE', 'CANCELLED'] as const
export const replacementSchema = z.object({
  id: z.string(),
  workOrder: z.object({ id: z.string(), number: z.string(), status: z.enum(WORK_ORDER_STATUSES) }),
  cell: z.object({ id: z.string(), colourwayCode: z.string(), size: z.string(), quantity: z.number() }),
  kind: z.enum(['RECUT', 'REDUCE']),
  quantity: z.number(),
  part: z.string().nullable(),
  sourceScanId: z.string().nullable(),
  reworkOrderId: z.string().nullable(),
  reason: z.string(),
  status: z.enum(REPLACEMENT_STATUSES),
  decidedAt: z.string().nullable(),
  decidedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  decisionNote: z.string().nullable(),
  cutLogId: z.string().nullable(),
  doneAt: z.string().nullable(),
  note: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
  createdBy: z.object({ id: z.string(), name: z.string() }).nullable(),
})
export type Replacement = z.infer<typeof replacementSchema>

/** production.scrap.view: the work order's recuts, open and done (its Pieces tab). */
export async function getRecuts(api: ApiClient, workOrderId: string, signal?: AbortSignal): Promise<Replacement[]> {
  return (await api.get('/production/replacements', { query: { workOrderId, kind: 'RECUT', status: 'OPEN,DONE', limit: 200 }, schema: z.object({ replacements: z.array(replacementSchema) }), signal })).replacements
}

/** production.scrap: a recut cut by this cut log entry (an entry of its cell, with pieces of its part). */
export function recutDone(api: ApiClient, replacementId: string, body: { version: number; cutLogId: string }, idempotencyKey = newIdempotencyKey()) {
  return api.post(`/production/replacements/${encodeURIComponent(replacementId)}/done`, { body, schema: z.object({ replacement: replacementSchema }), idempotencyKey })
}

// ---- hides allocated (reservations, B-W2a-11) --------------------------------------------------------------------------------

export const allocationSchema = z.object({
  id: z.string(),
  status: z.enum(['ACTIVE', 'ISSUED', 'RELEASED']),
  hide: z.object({ id: z.string(), code: z.string() }).nullable(),
  lot: z.object({ id: z.string(), code: z.string(), qualityStatus: z.string() }).nullable(),
  item: z.object({ id: z.string(), code: z.string(), baseUom: z.string() }).passthrough(),
  quantity: z.string(),
  createdAt: z.string(),
})
export type Allocation = z.infer<typeof allocationSchema>

/** inventory.stock.view: the hides reserved whole for the work order and not issued yet. */
export async function getAllocated(api: ApiClient, workOrderId: string, signal?: AbortSignal): Promise<Allocation[]> {
  const page = await api.get('/inventory/reservations', { query: { workOrderId, status: 'ACTIVE', limit: 200 }, schema: z.object({ reservations: z.array(allocationSchema.passthrough()) }), signal })
  return page.reservations.filter((row) => row.hide !== null)
}

// ---- tickets --------------------------------------------------------------------------------------------------------------------

/** production.bundles: a bundle made by mistake, voided before any scan (its ticket no longer scans). */
export function voidBundle(api: ApiClient, bundleId: string, reason: string, idempotencyKey = newIdempotencyKey()) {
  return api.post(`/production/bundles/${encodeURIComponent(bundleId)}/void`, { body: { reason }, schema: z.object({ bundle: z.object({ id: z.string() }).passthrough() }), idempotencyKey })
}
