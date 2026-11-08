import { z } from 'zod'
import { LENGTH_UOMS, ROLL_STATES } from '@nexus/factory-domain/inventory/rolls/rolls'
import { ALLOCATION_REFUSALS, ALLOCATION_WARNINGS } from '@nexus/factory-domain/production/cutorders/allocation'
import { CUT_ORDER_KINDS, CUT_ORDER_STATUSES, CUT_TICKET_STATUSES, LAY_STATUSES, PLY_RUN_STATUSES } from '@nexus/factory-domain/production/cutorders/rules'
import { CUT_VARIANCE_REASONS, RECONCILE_REFUSALS } from '@nexus/factory-domain/production/lays/reconcile'
import type { ApiClient } from '../../../../lib/api/client'
import { newIdempotencyKey } from '../../../../lib/api/client'

/**
 * Cut orders (B-W2b-129; the screens of B-W2b-112 cut orders and tickets, B-W2b-116 lays and the reconciliation): every call of
 * the Cutting page's cut orders, their record, New cut order, Allocate rolls, the tickets, Reconcile cut and the lay sheet, each
 * answer checked by its schema. Reads are production.cutting.view; writes production.cutorders.manage (the API checks each). The
 * API's English sentences (`message`, `words.en`) are read but never shown: the screens say codes and numbers in their own words.
 * No money, no person.
 */

export const CUT_ORDER_VIEWS = ['open', 'planned', 'released', 'cutting', 'cut', 'cancelled', 'all'] as const
export type CutOrderView = (typeof CUT_ORDER_VIEWS)[number]
export type CutOrderKind = (typeof CUT_ORDER_KINDS)[number]
export type CutOrderStatus = (typeof CUT_ORDER_STATUSES)[number]
export type LayStatus = (typeof LAY_STATUSES)[number]
export type CutTicketStatus = (typeof CUT_TICKET_STATUSES)[number]

const words = z.object({ it: z.string(), en: z.string() })
const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })
const uom = z.enum(LENGTH_UOMS)

export const ticketSchema = z.object({
  id: z.string(),
  number: z.string(),
  code: z.string(),
  status: z.enum(CUT_TICKET_STATUSES),
  cutOrderId: z.string(),
  layId: z.string().nullable(),
  laySeq: z.number().nullable(),
  printedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  doneAt: z.string().nullable(),
  voidedAt: z.string().nullable(),
  voidReason: z.string().nullable(),
  version: z.number(),
})
export type CutTicket = z.infer<typeof ticketSchema>

const plyRunSchema = z.object({
  id: z.string(),
  layId: z.string(),
  seq: z.number(),
  firstPly: z.number(),
  lastPly: z.number(),
  parts: z.array(z.string()),
  labelCount: z.number(),
  status: z.enum(PLY_RUN_STATUSES),
  printedAt: z.string().nullable(),
  voidedAt: z.string().nullable(),
  voidReason: z.string().nullable(),
  version: z.number(),
})

export const layRollSchema = z.object({
  id: z.string(),
  seq: z.number(),
  rollId: z.string(),
  code: z.string(),
  lotCode: z.string(),
  plies: z.number(),
  splices: z.number(),
  endLoss: z.string(),
  endReturned: z.string(),
  state: z.enum(ROLL_STATES),
  lengthLeft: z.string(),
  uom,
  widthCm: z.string().nullable(),
  shade: z.string().nullable(),
  shadeGroupId: z.string().nullable(),
  shrinkageGroup: z.string().nullable(),
  version: z.number(),
})
export type LayRoll = z.infer<typeof layRollSchema>

export const cutOrderSummarySchema = z.object({
  id: z.string(),
  number: z.string(),
  kind: z.enum(CUT_ORDER_KINDS),
  status: z.enum(CUT_ORDER_STATUSES),
  companyId: z.string(),
  siteId: z.string(),
  material: z.object({ item: ref, colour: ref.nullable() }),
  workOrders: z.array(z.object({ id: z.string(), number: z.string() })),
  styles: z.array(ref),
  garments: z.number(),
  plies: z.number().nullable(),
  lays: z.object({ count: z.number(), cut: z.number(), open: z.number() }),
  tickets: z.object({ open: z.number(), started: z.number(), done: z.number() }),
  station: ref.nullable(),
  dueDate: z.string().nullable(),
  releasedAt: z.string().nullable(),
  cutAt: z.string().nullable(),
  createdAt: z.string(),
  version: z.number(),
  words,
})
export type CutOrderSummary = z.infer<typeof cutOrderSummarySchema>

const warningSchema = z.object({ code: z.enum(ALLOCATION_WARNINGS), message: z.string() })

export const layViewSchema = z.object({
  id: z.string(),
  seq: z.number(),
  plies: z.number(),
  status: z.enum(LAY_STATUSES),
  layLength: z.string().nullable(),
  lengthUom: z.string().nullable(),
  counted: z.number().nullable(),
  checkedAt: z.string().nullable(),
  cutAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  note: z.string().nullable(),
  version: z.number(),
  allocated: z.number(),
  shade: z.string().nullable(),
  shrinkageGroup: z.string().nullable(),
  rolls: z.array(layRollSchema),
  ticket: ticketSchema.nullable(),
  plyRuns: z.array(plyRunSchema),
})
export type LayView = z.infer<typeof layViewSchema>

export const lineViewSchema = z.object({
  id: z.string(),
  seq: z.number(),
  workOrder: z.object({ id: z.string(), number: z.string(), batchNumber: z.string().nullable(), status: z.string(), holdReason: z.string().nullable(), dueDate: z.string().nullable() }),
  style: ref,
  colourway: ref,
  workOrderSizeId: z.string(),
  size: z.string(),
  cellQuantity: z.number(),
  quantity: z.number(),
  ratio: z.number().nullable(),
  plies: z.number().nullable(),
  version: z.number(),
})
export type LineView = z.infer<typeof lineViewSchema>

export const cutOrderRecordSchema = z.object({
  cutOrder: cutOrderSummarySchema.extend({
    marker: z.object({ name: z.string(), length: z.string().nullable(), uom: uom.nullable(), widthCm: z.string().nullable(), fileId: z.string().nullable(), ratio: z.string(), garmentsPerPly: z.number() }).nullable(),
    markerName: z.string().nullable(),
    note: z.string().nullable(),
    cancelReason: z.string().nullable(),
    cancelledAt: z.string().nullable(),
    reconciledAt: z.string().nullable(),
  }),
  lines: z.array(lineViewSchema),
  lays: z.array(layViewSchema),
  tickets: z.array(ticketSchema),
  warnings: z.array(warningSchema),
  can: z.object({ edit: z.boolean(), release: z.boolean(), backToPlanning: z.boolean(), cancel: z.boolean(), allocate: z.boolean() }),
})
export type CutOrderRecord = z.infer<typeof cutOrderRecordSchema>

// ---- the list ---------------------------------------------------------------------------------------------------------------

export const cutOrderTilesSchema = z.object({ planned: z.number(), released: z.number(), cutting: z.number(), cut: z.number(), cancelled: z.number() })
export type CutOrderTiles = z.infer<typeof cutOrderTilesSchema>
const listSchema = z.object({ rows: z.array(cutOrderSummarySchema), nextCursor: z.string().nullable(), tiles: cutOrderTilesSchema })
export type CutOrderPage = z.infer<typeof listSchema>

/** production.cutting.view: the cut orders of the caller's scope, newest first, with the counts per status. */
export function listCutOrders(api: ApiClient, query: { view: CutOrderView; q?: string; limit: number; kind?: CutOrderKind }, signal?: AbortSignal): Promise<CutOrderPage> {
  return api.get('/production/cut-orders', { query: { view: query.view, q: query.q?.trim() || undefined, limit: query.limit, kind: query.kind }, schema: listSchema, signal })
}

// ---- New cut order ----------------------------------------------------------------------------------------------------------

export const waitingCellSchema = z.object({
  workOrderSizeId: z.string(),
  workOrder: z.object({ id: z.string(), number: z.string(), status: z.string(), dueDate: z.string().nullable() }),
  style: ref,
  colourway: ref,
  size: z.string(),
  quantity: z.number(),
  onCutOrders: z.number(),
  left: z.number(),
})
export type WaitingCell = z.infer<typeof waitingCellSchema>

export const waitingGroupSchema = z.object({ kind: z.enum(CUT_ORDER_KINDS), siteId: z.string(), item: ref, colour: ref.nullable(), garmentsLeft: z.number(), cells: z.array(waitingCellSchema) })
export type WaitingGroup = z.infer<typeof waitingGroupSchema>

/** production.cutting.view: the cells of released and running work orders still to go on a cut order, per material and colour. */
export async function waitingGroups(api: ApiClient, signal?: AbortSignal): Promise<WaitingGroup[]> {
  return (await api.get('/production/cut-orders/waiting', { schema: z.object({ groups: z.array(waitingGroupSchema) }), signal })).groups
}

export const stationSchema = z.object({ id: z.string(), siteId: z.string(), code: z.string(), name: z.string(), status: z.enum(['ACTIVE', 'ARCHIVED']) })
export type Station = z.infer<typeof stationSchema>

/** print.view: the stations of a site (the cutting table a cut order is cut at; optional). */
export async function siteStations(api: ApiClient, siteId: string, signal?: AbortSignal): Promise<Station[]> {
  const page = await api.get('/print/stations', { query: { siteId }, schema: z.object({ stations: z.array(stationSchema.passthrough()) }), signal })
  return page.stations.filter((station) => station.status === 'ACTIVE' && station.siteId === siteId)
}

export interface CreateBody {
  readonly siteId: string
  readonly kind: CutOrderKind
  readonly itemId: string
  readonly itemColourId: string | null
  readonly stationId?: string | null
  readonly dueDate?: string | null
  readonly marker?: { readonly name: string; readonly length: string; readonly uom: 'M' | 'CM' | 'MM'; readonly widthCm?: string | null } | null
  readonly plies?: number
  readonly lays?: readonly number[]
  readonly lines: readonly { readonly workOrderSizeId: string; readonly quantity?: number; readonly ratio?: number }[]
}

/** production.cutorders.manage: a PLANNED cut order (its number, its lays). */
export function createCutOrder(api: ApiClient, body: CreateBody, idempotencyKey = newIdempotencyKey()): Promise<CutOrderRecord> {
  return api.post('/production/cut-orders', { body, schema: cutOrderRecordSchema, idempotencyKey })
}

// ---- the record ------------------------------------------------------------------------------------------------------------

const path = (cutOrderId: string) => `/production/cut-orders/${encodeURIComponent(cutOrderId)}`

/** production.cutting.view: one cut order with its lines, lays (rolls, ticket, ply runs), tickets, warnings and `can`. */
export function getCutOrder(api: ApiClient, cutOrderId: string, signal?: AbortSignal): Promise<CutOrderRecord> {
  return api.get(path(cutOrderId), { schema: cutOrderRecordSchema, signal })
}

export function releaseCutOrder(api: ApiClient, cutOrderId: string, version: number, idempotencyKey = newIdempotencyKey()): Promise<CutOrderRecord> {
  return api.post(`${path(cutOrderId)}/release`, { body: { version }, schema: cutOrderRecordSchema, idempotencyKey })
}

export function unreleaseCutOrder(api: ApiClient, cutOrderId: string, body: { version: number; reason: string }, idempotencyKey = newIdempotencyKey()): Promise<CutOrderRecord> {
  return api.post(`${path(cutOrderId)}/unrelease`, { body, schema: cutOrderRecordSchema, idempotencyKey })
}

export function cancelCutOrder(api: ApiClient, cutOrderId: string, body: { version: number; reason: string }, idempotencyKey = newIdempotencyKey()): Promise<CutOrderRecord> {
  return api.post(`${path(cutOrderId)}/cancel`, { body, schema: cutOrderRecordSchema, idempotencyKey })
}

// ---- rolls ---------------------------------------------------------------------------------------------------------------------

export const candidateSchema = z.object({
  id: z.string(),
  code: z.string(),
  supplierRollRef: z.string().nullable(),
  state: z.enum(ROLL_STATES),
  uom,
  length: z.string(),
  lengthLeft: z.string(),
  planned: z.string(),
  widthCm: z.string().nullable(),
  shade: z.string().nullable(),
  shadeGroup: z.object({ id: z.string(), label: z.string(), outOfShade: z.boolean() }).nullable(),
  shrinkageGroup: z.string().nullable(),
  shrinkageLengthPercent: z.string().nullable(),
  shrinkageWidthPercent: z.string().nullable(),
  lot: z.object({ id: z.string(), code: z.string(), dyeBatch: z.string().nullable(), qualityStatus: z.string() }),
  location: z.object({ id: z.string(), code: z.string() }).nullable(),
  plies: z.number(),
  allocatedTo: z.array(z.object({ cutOrderNumber: z.string(), laySeq: z.number(), plies: z.number() })),
  refusal: z.object({ code: z.enum(ALLOCATION_REFUSALS), message: z.string() }).nullable(),
  warnings: z.array(warningSchema),
})
export type RollCandidate = z.infer<typeof candidateSchema>

export const candidatesSchema = z.object({
  marker: z.object({ name: z.string(), length: z.string(), uom, widthCm: z.string().nullable() }),
  allowanceCm: z.number(),
  perPlyMetres: z.string(),
  rolls: z.array(candidateSchema),
  groups: z.array(z.object({ shade: z.string().nullable(), shadeGroupId: z.string().nullable(), shrinkageGroup: z.string().nullable(), rolls: z.number(), plies: z.number() })),
  lays: z.array(z.object({ id: z.string(), seq: z.number(), plies: z.number(), allocated: z.number(), proposable: z.boolean() })),
  proposal: z.array(z.object({ layId: z.string(), seq: z.number(), need: z.number(), rolls: z.array(z.object({ rollId: z.string(), code: z.string(), plies: z.number() })), short: z.number() })),
  words,
  warnings: z.array(warningSchema),
})
export type RollCandidates = z.infer<typeof candidatesSchema>

/** production.cutting.view: the rolls of the cut order's fabric and colour at its site, each with the plies it gives and why not. */
export function rollCandidates(api: ApiClient, cutOrderId: string, signal?: AbortSignal): Promise<RollCandidates> {
  return api.get(`${path(cutOrderId)}/rolls`, { schema: candidatesSchema, signal })
}

/** production.cutorders.manage: rolls on a PLANNED lay (one shade and shrinkage group; the plies each gives). */
export function allocateRolls(api: ApiClient, cutOrderId: string, layId: string, body: { version: number; rolls: readonly { rollId: string; plies: number }[] }, idempotencyKey = newIdempotencyKey()): Promise<CutOrderRecord> {
  return api.post(`${path(cutOrderId)}/lays/${encodeURIComponent(layId)}/rolls`, { body, schema: cutOrderRecordSchema, idempotencyKey })
}

/** production.cutorders.manage: one roll taken off a PLANNED lay. */
export function removeLayRoll(api: ApiClient, cutOrderId: string, layId: string, layRollId: string, version: number, idempotencyKey = newIdempotencyKey()): Promise<CutOrderRecord> {
  return api.post(`${path(cutOrderId)}/lays/${encodeURIComponent(layId)}/rolls/${encodeURIComponent(layRollId)}/remove`, { body: { version }, schema: cutOrderRecordSchema, idempotencyKey })
}

// ---- tickets -------------------------------------------------------------------------------------------------------------------

export const printerSchema = z.object({ id: z.string(), siteId: z.string(), code: z.string(), name: z.string(), kind: z.string(), status: z.string() })
export type Printer = z.infer<typeof printerSchema>

/** print.view: the site's active label printers (a ticket prints on one; none named: the table's, else the site's only one). */
export async function labelPrinters(api: ApiClient, siteId: string, signal?: AbortSignal): Promise<Printer[]> {
  const page = await api.get('/print/printers', { query: { siteId }, schema: z.object({ printers: z.array(printerSchema.passthrough()) }), signal })
  return page.printers.filter((printer) => printer.kind === 'LABEL_ZPL' && printer.status === 'ACTIVE' && printer.siteId === siteId)
}

const labelLinesSchema = z.object({ heading: z.string(), title: z.string(), fields: z.array(z.object({ label: z.string(), value: z.string() })) })
export const printAnswerSchema = z.object({
  ticket: ticketSchema,
  label: labelLinesSchema,
  job: z.object({ id: z.string(), status: z.enum(['QUEUED', 'SENT', 'PRINTED', 'FAILED']) }).passthrough().nullable(),
  problem: z.string().nullable(),
})
export type PrintAnswer = z.infer<typeof printAnswerSchema>

/**
 * production.cutorders.manage: a ticket printed on a label printer of the site (none named: the table's, else the site's only one);
 * `printerId: null` prints nothing and answers the label's lines.
 */
export function printTicket(api: ApiClient, ticketId: string, body: { printerId?: string | null; language: 'it' | 'en' }, idempotencyKey = newIdempotencyKey()): Promise<PrintAnswer> {
  return api.post(`/production/cut-tickets/${encodeURIComponent(ticketId)}/print`, { body, schema: printAnswerSchema, idempotencyKey })
}

/** production.cutorders.manage: a lost or wrong ticket voided (`replace`: a new OPEN ticket for the same lay). */
export function voidTicket(api: ApiClient, ticketId: string, body: { version: number; reason: string; replace: boolean }, idempotencyKey = newIdempotencyKey()) {
  return api.post(`/production/cut-tickets/${encodeURIComponent(ticketId)}/void`, { body, schema: z.object({ voided: ticketSchema, replacement: ticketSchema.nullable() }), idempotencyKey })
}

// ---- Reconcile cut ---------------------------------------------------------------------------------------------------------

const figures = { ordered: z.number(), cut: z.number(), recut: z.number(), difference: z.number() }
const materialSums = { estimated: z.string(), recorded: z.string(), used: z.string().nullable(), issued: z.string(), endLoss: z.string(), endsReturned: z.string() }

export const reconciliationSchema = z.object({
  cutOrder: z.object({ id: z.string(), number: z.string(), kind: z.enum(CUT_ORDER_KINDS), status: z.enum(CUT_ORDER_STATUSES), version: z.number(), reconciledAt: z.string().nullable() }),
  lines: z.array(
    z.object({
      id: z.string(),
      seq: z.number(),
      workOrder: z.object({ id: z.string(), number: z.string() }),
      style: ref,
      colourway: ref,
      size: z.string(),
      ratio: z.number().nullable(),
      ...figures,
      needsReason: z.boolean(),
      reconciled: z.object({ varianceReasonCode: z.string().nullable(), note: z.string().nullable(), reconciledAt: z.string() }).nullable(),
    }),
  ),
  sizes: z.array(z.object({ size: z.string(), ...figures })),
  material: z
    .object({
      uom,
      lays: z.array(z.object({ layId: z.string(), seq: z.number(), plies: z.number(), ...materialSums, confirmed: z.boolean() })),
      sum: z.object({ ...materialSums, used: z.string() }),
      words,
    })
    .nullable(),
  reasons: z.array(z.object({ code: z.enum(CUT_VARIANCE_REASONS), words })),
  refusal: z.object({ code: z.enum(RECONCILE_REFUSALS), message: z.string() }).nullable(),
  garments: z.object({ ordered: z.number(), cut: z.number() }),
  words,
  can: z.object({ reconcile: z.boolean() }),
})
export type Reconciliation = z.infer<typeof reconciliationSchema>
export type ReconcileLine = Reconciliation['lines'][number]
export type MaterialSums = NonNullable<Reconciliation['material']>

/** production.cutting.view: ordered, cut and recut per line and size, the fabric per lay, what still stops it. */
export function getReconciliation(api: ApiClient, cutOrderId: string, signal?: AbortSignal): Promise<Reconciliation> {
  return api.get(`${path(cutOrderId)}/reconciliation`, { schema: reconciliationSchema, signal })
}

/** production.cutorders.manage: every open line reconciled (a reason where cut differs from ordered), the cut order RECONCILED. */
export function reconcileCutOrder(api: ApiClient, cutOrderId: string, body: { version: number; lines: readonly { lineId: string; reasonCode?: string; note?: string | null }[] }, idempotencyKey = newIdempotencyKey()): Promise<Reconciliation> {
  return api.post(`${path(cutOrderId)}/reconcile`, { body, schema: reconciliationSchema, idempotencyKey })
}
