import { z } from 'zod'
import { HOLD_SUBJECT_TYPES } from '@nexus/factory-domain/quality/holds/rules'
import { TRACE_DIRECTIONS, TRACE_GAP_CODES, TRACE_GAP_SEVERITIES, TRACE_LINKS, TRACE_NODE_KINDS, TRACE_REACHES, TRACE_SIDES, TRACE_START_KINDS } from '@nexus/factory-domain/inventory/trace/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { presignedSchema, type Presigned } from '../../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../../record-panels/store'
import { demandSchema, QUALITY_STATUSES } from '../../../_shared/stock/api'

/**
 * The warehouse's every-day calls (B-W2a-64 over the merged API of B-W2a-11 reservations and write-offs, B-W2a-26 quality
 * holds, B-W2a-27 the trace, B-W2a-47 an NCR raised from a lot or hide), with the answers' shape checked (zod; unknown
 * fields dropped). The shapes mirror apps/factory-api modules/inventory/{reservations,ledger,trace}/contract.ts,
 * modules/quality/{holds,ncr}/contract.ts and modules/production/work-orders/contract.ts. Every write carries ONE
 * Idempotency-Key per dialog (the caller makes it). The API's English is never drawn: the screens say their own words
 * from codes and numbers (refusals by their path, `refusal/<CODE>`).
 */

type Query = Readonly<Record<string, string | number | boolean | null | undefined>>
const clean = (query: Query): Query => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ''))
const seg = (value: string) => encodeURIComponent(value)
const uom = z.enum(UOMS)
const named = z.object({ id: z.string(), code: z.string(), name: z.string() })

// ---- reservations (modules/inventory/reservations) --------------------------------------------------------------------------

export const reservationSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  siteCode: z.string(),
  kind: z.enum(['HIDE', 'AREA', 'QUANTITY']),
  status: z.enum(['ACTIVE', 'ISSUED', 'RELEASED']),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), baseUom: uom, tracking: z.enum(['NONE', 'LOT', 'HIDE', 'SERIAL']) }),
  colour: named.nullable(),
  lot: z.object({ id: z.string(), code: z.string(), qualityStatus: z.enum(QUALITY_STATUSES) }).nullable(),
  hide: z.object({ id: z.string(), code: z.string() }).nullable(),
  quantity: z.string(),
  issuedQuantity: z.string(),
  open: z.string(),
  demand: demandSchema,
  stale: z.boolean(),
  needDate: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  version: z.number(),
})
export type Reservation = z.infer<typeof reservationSchema>

export interface ReservationQuery {
  siteId?: string | null
  itemId?: string | null
  itemColourId?: string | null
  lotId?: string | null
  hideId?: string | null
  workOrderId?: string | null
  status?: readonly Reservation['status'][]
  stale?: boolean
  limit?: number
}
/** inventory.stock.view: reservations newest first (the active ones of a lot, a hide, a work order). */
export const listReservations = (api: ApiClient, query: ReservationQuery, signal?: AbortSignal) =>
  api.get('/inventory/reservations', {
    query: clean({ ...query, status: query.status?.join(','), stale: query.stale ? 'true' : undefined }),
    schema: z.object({ reservations: z.array(reservationSchema), nextCursor: z.string().nullable() }),
    signal,
  })

const figuresSchema = z.object({ onHand: z.string(), held: z.string(), reserved: z.string(), available: z.string(), overReserved: z.boolean() })
export type Figures = z.infer<typeof figuresSchema>
const availabilitySchema = z.object({
  site: z.object({ id: z.string(), code: z.string() }),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), baseUom: uom }),
  colour: named.nullable(),
  figures: figuresSchema,
  lots: z.array(figuresSchema.extend({ lot: z.object({ id: z.string(), code: z.string(), qualityStatus: z.string() }) })),
  hides: z.array(z.object({ hide: z.object({ id: z.string(), code: z.string() }), lotId: z.string().nullable(), onHand: z.string(), held: z.boolean(), reservedFor: demandSchema.nullable() })),
  reservations: z.array(reservationSchema),
})
export type Availability = z.infer<typeof availabilitySchema>
/** A material at a site: on hand − held − reserved, per lot and every hide in stock with what holds it. */
export const availability = (api: ApiClient, query: { siteId: string; itemId: string; itemColourId?: string | null }, signal?: AbortSignal) =>
  api.get('/inventory/reservations/availability', { query: clean(query), schema: availabilitySchema, signal })

export interface ReserveInput {
  siteId: string
  workOrderId?: string
  salesOrderLineId?: string
  needDate?: string | null
  note?: string | null
  lines: readonly ({ hideId: string } | { lotId: string; quantity: string } | { itemId: string; itemColourId: string | null; quantity: string })[]
}
/** inventory.reserve: hides whole (or a lot's quantity) for one work order, all or nothing. */
export const reserve = (api: ApiClient, body: ReserveInput, idempotencyKey: string) =>
  api.post('/inventory/reservations', {
    body: {
      siteId: body.siteId,
      ...(body.workOrderId ? { workOrderId: body.workOrderId } : {}),
      ...(body.salesOrderLineId ? { salesOrderLineId: body.salesOrderLineId } : {}),
      ...(body.needDate ? { needDate: body.needDate } : {}),
      note: body.note?.trim() || null,
      lines: body.lines,
    },
    schema: z.object({ reservations: z.array(reservationSchema) }),
    idempotencyKey,
  })

/** inventory.reserve: release reservations at the versions read, with the reason. */
export const releaseReservations = (api: ApiClient, reservations: readonly { id: string; version: number }[], reason: string, idempotencyKey: string) =>
  api.post('/inventory/reservations/release', { body: { reservations, reason }, schema: z.object({ reservations: z.array(reservationSchema) }), idempotencyKey })

// ---- work orders a reservation may be for (modules/production/work-orders) ------------------------------------------------

const workOrderOption = z.object({ id: z.string(), number: z.string(), status: z.string(), siteId: z.string(), styleCode: z.string(), styleName: z.string(), dueDate: z.string().nullable(), pieces: z.number() })
export type WorkOrderOption = z.infer<typeof workOrderOption>
/** workorders.view: the open work orders of a site (DRAFT, RELEASED, IN_PROGRESS), found by number, batch or style. */
export const openWorkOrders = (api: ApiClient, query: { siteId: string | null; q?: string | null }, signal?: AbortSignal) =>
  api.get('/production/work-orders', { query: clean({ siteId: query.siteId, q: query.q?.trim(), open: 'true', limit: 50 }), schema: z.object({ workOrders: z.array(workOrderOption) }), signal })

// ---- write-offs (modules/inventory/ledger write-off.ts) --------------------------------------------------------------------

export type WriteOffLine = { hideId: string } | { itemId: string; itemColourId?: string | null; lotId?: string | null; fromLocationId: string; quantity: string }
export interface WriteOffInput {
  siteId: string
  reasonCode: string
  note?: string | null
  reference?: string | null
  lines: readonly WriteOffLine[]
}
const writeOffValues = z.object({ valued: z.number(), moves: z.number(), byCurrency: z.array(z.object({ currency: z.string(), amount: z.number() })) })
export type WriteOffValues = z.infer<typeof writeOffValues>
const writeOffAnswer = z.object({
  writeOff: z.object({ id: z.string(), siteId: z.string(), reasonCode: z.string(), note: z.string().nullable(), moves: z.array(z.object({ id: z.string() }).loose()), hideIds: z.array(z.string()), values: writeOffValues.optional() }),
  overReserved: z.array(z.object({ itemId: z.string(), itemColourId: z.string().nullable(), available: z.string(), reserved: z.string() })),
})
export type WriteOffAnswer = z.infer<typeof writeOffAnswer>
/** inventory.scrap: stock leaves the site with a WRITE_OFF reason (one SCRAP move per place; a hide whole, then SCRAPPED). */
export const postWriteOff = (api: ApiClient, body: WriteOffInput, idempotencyKey: string) =>
  api.post('/inventory/write-offs', { body: { ...body, note: body.note?.trim() || null, reference: body.reference?.trim() || null }, schema: writeOffAnswer, idempotencyKey })

const announced = z.object({ file: z.object({ id: z.string() }).loose(), upload: presignedSchema })
/** inventory.scrap + files.upload: a photo of the write-off — announced, sent straight to the store, then confirmed. */
export async function addWriteOffPhoto(api: ApiClient, writeOffId: string, file: { name: string; type: string; size: number; bytes: ArrayBuffer }): Promise<string> {
  const sha256 = await sha256Hex(file.bytes)
  const answer = await api.post(`/inventory/write-offs/${seg(writeOffId)}/photos`, {
    body: { originalName: file.name, contentType: file.type || 'image/jpeg', sizeBytes: file.size, sha256 },
    schema: announced,
    idempotencyKey: newIdempotencyKey(),
  })
  await putToStore(answer.upload as Presigned, file.bytes)
  await api.post(`/inventory/write-offs/${seg(writeOffId)}/photos/${seg(answer.file.id)}/complete`, { body: {}, schema: z.object({ file: z.object({ id: z.string() }).loose() }), idempotencyKey: newIdempotencyKey() })
  return answer.file.id
}

// ---- quality holds (modules/quality/holds) ---------------------------------------------------------------------------------

export const HOLD_SUBJECTS = HOLD_SUBJECT_TYPES
export type HoldSubject = (typeof HOLD_SUBJECT_TYPES)[number]
const holdRow = z.object({
  id: z.string(),
  siteId: z.string(),
  status: z.enum(['ACTIVE', 'RELEASED', 'CLOSED']),
  subjectType: z.enum(HOLD_SUBJECT_TYPES),
  subjects: z.array(z.object({ id: z.string(), label: z.string().nullable(), state: z.string().nullable() })),
  quantity: z.string().nullable(),
  reasonCode: z.string(),
  reasonNote: z.string().nullable(),
  sourceType: z.string().nullable(),
  placedAt: z.string(),
  overdue: z.boolean(),
  ageDays: z.number(),
  ncrId: z.string().nullable(),
  releasedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  version: z.number(),
})
export type HoldRow = z.infer<typeof holdRow>
/** quality.holds.view: the holds of one record (Q3: any record's holds), or a site's ACTIVE ones (≤ 200 newest). */
export const listHolds = (api: ApiClient, query: { status?: 'ACTIVE' | 'RELEASED' | 'CLOSED' | 'ALL'; subjectType?: HoldSubject; subjectId?: string | null; siteId?: string | null }, signal?: AbortSignal) =>
  api.get('/quality/holds', { query: clean(query), schema: z.object({ holds: z.array(holdRow), truncated: z.boolean() }), signal })

const previewSchema = z.object({
  siteId: z.string().nullable(),
  subjects: z.array(z.object({ id: z.string().nullable(), code: z.string().nullable(), label: z.string().nullable(), state: z.string().nullable(), quantity: z.string().nullable(), problem: z.string().nullable() })),
  quantity: z.string().nullable(),
  workOrders: z.array(z.object({ id: z.string(), number: z.string(), status: z.string(), move: z.enum(['HOLD', 'ALREADY', 'KEEP', 'REFUSED']) })),
  quarantinePlaces: z.array(named),
})
export type HoldPreview = z.infer<typeof previewSchema>
/** quality.holds.place: what holding these records would block (each record's state, the work orders it moves). */
export const previewHold = (api: ApiClient, subjectType: HoldSubject, subjectIds: readonly string[], signal?: AbortSignal) =>
  api.post('/quality/holds/preview', { body: { subjectType, subjectIds }, schema: previewSchema, signal })

export interface PlaceHoldInput {
  subjectType: HoldSubject
  subjectIds: readonly string[]
  reasonCode: string
  reasonNote?: string | null
  askQuarantine?: boolean
  quarantineLocationId?: string | null
}
/** quality.holds.place: the hold (ACTIVE), placed by hand (no source). */
export const placeHold = (api: ApiClient, body: PlaceHoldInput, idempotencyKey: string) =>
  api.post('/quality/holds', {
    body: { ...body, reasonNote: body.reasonNote?.trim() || null, ...(body.askQuarantine ? {} : { askQuarantine: false, quarantineLocationId: null }) },
    schema: z.object({ hold: holdRow, workOrdersHeld: z.array(z.object({ id: z.string(), number: z.string(), from: z.string() })) }),
    idempotencyKey,
  })

// ---- an NCR from a lot or a hide (modules/quality/ncr) ---------------------------------------------------------------------

/** quality.ncr.raise: a nonconformance about the stock just written off (prefilled from the lot or hide by the API). */
export const raiseNcr = (api: ApiClient, from: { recordType: 'Lot' | 'Hide'; recordId: string }, severity: 'CRITICAL' | 'MAJOR' | 'MINOR', description: string | null, idempotencyKey: string) =>
  api.post('/quality/ncr', {
    body: { from, severity, ...(description ? { description } : {}) },
    schema: z.object({ record: z.object({ ncr: z.object({ id: z.string(), number: z.string().nullable().optional() }).loose() }).loose() }),
    idempotencyKey,
  })

// ---- the trace (modules/inventory/trace) -----------------------------------------------------------------------------------

export const START_KINDS = TRACE_START_KINDS
export type StartKind = (typeof TRACE_START_KINDS)[number]
export type NodeKind = (typeof TRACE_NODE_KINDS)[number]
export type Direction = (typeof TRACE_DIRECTIONS)[number]
export type GapCode = (typeof TRACE_GAP_CODES)[number]

const findSchema = z.object({
  code: z.string(),
  matches: z.array(z.object({ kind: z.enum(TRACE_START_KINDS), id: z.string(), code: z.string(), matchedBy: z.string(), label: z.string() })),
  problem: z.string().nullable(),
})
export type TraceFind = z.infer<typeof findSchema>
/** inventory.stock.view: the records a scanned or typed code names (best first; empty: nothing). */
export const findTrace = (api: ApiClient, code: string, signal?: AbortSignal) => api.get('/inventory/trace/find', { query: { code: code.trim() }, schema: findSchema, signal })

const party = named
const traceNodeSchema = z.object({
  key: z.string(),
  kind: z.enum(TRACE_NODE_KINDS),
  id: z.string(),
  code: z.string().nullable(),
  reach: z.enum(TRACE_REACHES),
  sides: z.array(z.enum(TRACE_SIDES)),
  restricted: z.array(z.string()),
  holds: z.array(z.object({ id: z.string(), reasonCode: z.string(), placedAt: z.string() })),
  party: party.nullable().optional(),
  received: z.boolean().optional(),
  receipt: z.object({ status: z.string(), receivedAt: z.string(), supplierDdtNumber: z.string().nullable() }).loose().optional(),
  lot: z.object({ item: z.object({ code: z.string(), name: z.string(), baseUom: z.string() }).loose(), colourCode: z.string().nullable(), qualityStatus: z.string(), onHand: z.string(), scrapped: z.string() }).loose().optional(),
  hide: z.object({ lotId: z.string(), state: z.string(), baseArea: z.string(), onHand: z.string() }).optional(),
  subcontract: z.object({ status: z.string(), workOrderId: z.string(), workshop: party.nullable() }).optional(),
  workOrder: z.object({ batchNumber: z.string().nullable(), status: z.string(), kind: z.string(), styleCode: z.string(), tracking: z.enum(['BATCH', 'SERIAL']), finishedReceived: z.number() }).loose().optional(),
  cell: z.object({ workOrderId: z.string(), colourwayCode: z.string(), size: z.string(), quantity: z.number(), released: z.number(), packed: z.number(), shipped: z.number(), returned: z.number() }).loose().optional(),
  bundle: z.object({ workOrderId: z.string(), quantity: z.number(), part: z.string().nullable(), status: z.string(), parentBundleId: z.string().nullable(), cuts: z.number(), serials: z.number() }).loose().optional(),
  serial: z.object({ workOrderId: z.string(), status: z.string() }).loose().optional(),
  shipment: z.object({ status: z.string(), shippedAt: z.string().nullable(), ddtNumbers: z.array(z.string()), left: z.boolean() }).loose().optional(),
})
export type TraceNode = z.infer<typeof traceNodeSchema>
const traceSchema = z.object({
  start: z.object({ key: z.string(), kind: z.enum(TRACE_START_KINDS), id: z.string(), code: z.string() }),
  direction: z.enum(TRACE_DIRECTIONS),
  asOf: z.string(),
  nodes: z.array(traceNodeSchema),
  edges: z.array(z.object({ from: z.string(), to: z.string(), link: z.enum(TRACE_LINKS), exact: z.boolean(), quantity: z.string().nullable(), uom: z.string().nullable() })),
  levels: z.array(z.object({ kind: z.enum(TRACE_NODE_KINDS), exact: z.number(), possible: z.number() })),
  gaps: z.array(z.object({ code: z.enum(TRACE_GAP_CODES), severity: z.enum(TRACE_GAP_SEVERITIES), at: z.string(), count: z.number() })),
  customersReceived: z.object({ exact: z.number(), possible: z.number() }),
  restricted: z.array(z.object({ permission: z.string(), nodes: z.number() })),
})
export type Trace = z.infer<typeof traceSchema>
/** inventory.stock.view: the trace from one record, backward, forward or both (read only, computed now). */
export const readTrace = (api: ApiClient, start: { kind: StartKind; id: string }, direction: Direction = 'BOTH', signal?: AbortSignal) =>
  api.get('/inventory/trace', { query: { kind: start.kind, id: start.id, direction }, schema: traceSchema, signal })
