import { z } from 'zod'
import { STOCK_MOVE_REASONS } from '@nexus/factory-domain/inventory/ledger/moves'
import { LOCATION_KINDS } from '@nexus/factory-domain/inventory/locations/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import type { ApiClient } from '../../../lib/api/client'

/**
 * Every call the warehouse stock screens share (Stock SCR-060, Movements SCR-064, Locations SCR-065, Hides SCR-200,
 * Lots & traceability SCR-201), with the answer's shape checked (zod; unknown fields are dropped). The shapes mirror
 * apps/factory-api modules/inventory/stock/{contract,reads-contract}.ts, ledger/contract.ts and locations/contract.ts;
 * the enum lists are factory-domain's. Values are the cost grain: absent (never null) without it. The API's English is
 * never drawn: the screens say their own words from codes and numbers.
 */

const uom = z.enum(UOMS)
export type Uom = z.infer<typeof uom>
export const MOVE_REASONS = STOCK_MOVE_REASONS
export type MoveReason = (typeof STOCK_MOVE_REASONS)[number]
export const QUALITY_STATUSES = ['QUARANTINE', 'RELEASED', 'BLOCKED', 'REJECTED'] as const
export type QualityStatus = (typeof QUALITY_STATUSES)[number]
export const CR_VI_STATUSES = ['NOT_REQUIRED', 'PENDING', 'PASS', 'FAIL'] as const
export type CrViStatus = (typeof CR_VI_STATUSES)[number]
// W2b (B-W2b-01): RETURNED, a hide sent back to the tannery.
export const HIDE_STATES = ['FULL', 'PARTLY_CUT', 'REMNANT', 'CONSUMED', 'SCRAPPED', 'RETURNED'] as const
export type HideState = (typeof HIDE_STATES)[number]
export const LOCATION_KIND_LIST = LOCATION_KINDS
export type LocationKind = (typeof LOCATION_KINDS)[number]
export type Tracking = 'NONE' | 'LOT' | 'HIDE' | 'SERIAL'

const named = z.object({ id: z.string(), code: z.string(), name: z.string() })
export type Named = z.infer<typeof named>
const item = z.object({ id: z.string(), code: z.string(), name: z.string(), baseUom: uom, tracking: z.enum(['NONE', 'LOT', 'HIDE', 'SERIAL']) })
export type ItemRef = z.infer<typeof item>
const quality = z.enum(QUALITY_STATUSES)
const crVi = z.enum(CR_VI_STATUSES)
const perUnit = z.object({ uom, quantity: z.string() })
export type PerUnit = z.infer<typeof perUnit>
const cost = z.string().nullable().optional()

type Query = Readonly<Record<string, string | number | boolean | null | undefined>>
const clean = (query: Query): Query => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ''))
const seg = (value: string) => encodeURIComponent(value)

// ---- the stock overview (GET /inventory/stock) ----------------------------------------------------------------------------

const stockRowSchema = z.object({
  siteId: z.string(),
  siteCode: z.string(),
  location: named,
  item,
  colour: named.nullable(),
  lot: z.object({ id: z.string(), code: z.string(), qualityStatus: quality }).nullable(),
  hide: z.object({ id: z.string(), code: z.string() }).nullable(),
  onHand: z.string(),
  held: z.string(),
  /** B-W2a-11: what a hide's own HIDE reservation holds of this row (other reservations hold a site's stock: `reservations`). */
  reserved: z.string().nullable().optional(),
  available: z.string(),
  unitCost: cost,
  value: z.number().nullable().optional(),
})
export type StockRow = z.infer<typeof stockRowSchema>
const stockItemSchema = z.object({
  itemId: z.string(),
  itemColourId: z.string().nullable(),
  item,
  colour: named.nullable(),
  onHand: z.string(),
  held: z.string(),
  available: z.string(),
  hides: z.number(),
  heldHides: z.number(),
  locations: z.number(),
  /** B-W2a-11: what open reservations hold at the sites shown, and whether they hold more than there is. */
  reserved: z.string().nullable().optional(),
  overReserved: z.boolean().nullable().optional(),
  value: z.number().nullable().optional(),
  currency: z.string().optional(),
})
export type StockItem = z.infer<typeof stockItemSchema>
/** B-W2a-11: what open reservations hold per site, material, colour and lot (null: any lot of it). */
const reservedKeySchema = z.object({ siteId: z.string(), itemId: z.string(), itemColourId: z.string().nullable(), lotId: z.string().nullable(), reserved: z.string(), reservations: z.number(), stale: z.number() })
export type ReservedKey = z.infer<typeof reservedKeySchema>
const overviewSchema = z.object({ rows: z.array(stockRowSchema), items: z.array(stockItemSchema), reservations: z.array(reservedKeySchema).optional(), truncated: z.boolean() })
export type StockOverview = z.infer<typeof overviewSchema>

export interface StockQuery {
  siteId?: string | null
  itemId?: string | null
  itemColourId?: string | null
  lotId?: string | null
  hideId?: string | null
  locationId?: string | null
  held?: boolean
  /** B-W2a-11: only the stock of a material and colour that open reservations hold (the Reserved tile). */
  reserved?: boolean
}
export const stockOverview = (api: ApiClient, query: StockQuery, signal?: AbortSignal) =>
  api.get('/inventory/stock', { query: clean({ ...query, held: query.held ? 'true' : undefined, reserved: query.reserved ? 'true' : undefined }), schema: overviewSchema, signal })

/**
 * The stock as it was at an instant (B-W2a-11, SCM-197; design st-asof): the moves up to it. There is no history of
 * quality status or reservations, so held, reserved and available are null then (the screen says so, never 0).
 */
const pastRowSchema = stockRowSchema.extend({ held: z.string().nullable(), available: z.string().nullable() })
export type PastStockRow = z.infer<typeof pastRowSchema>
const pastSchema = z.object({ asOf: z.string().nullable(), rows: z.array(pastRowSchema), items: z.array(stockItemSchema.extend({ held: z.string().nullable(), available: z.string().nullable(), heldHides: z.number().nullable() })), truncated: z.boolean() })
export type PastStock = z.infer<typeof pastSchema>
export const stockAsOf = (api: ApiClient, query: Omit<StockQuery, 'held' | 'reserved'>, asOf: string, signal?: AbortSignal) =>
  api.get('/inventory/stock', { query: clean({ ...query, asOf }), schema: pastSchema, signal })

// ---- why is it this number (GET /inventory/stock/explain) -----------------------------------------------------------------

const explainSchema = z.object({
  siteId: z.string(),
  item,
  colour: named.nullable(),
  lot: z.object({ id: z.string(), code: z.string() }).nullable(),
  hide: z.object({ id: z.string(), code: z.string() }).nullable(),
  location: named.nullable(),
  onHand: z.string(),
  byReason: z.array(z.object({ reason: z.enum(STOCK_MOVE_REASONS), in: z.string(), out: z.string(), net: z.string(), moves: z.number() })),
  sum: z.string(),
  addsUp: z.boolean(),
  gap: z.string(),
  moves: z.number(),
})
export type Explain = z.infer<typeof explainSchema>
/** One stock key: the site and the item, narrowed by colour, lot, hide or one location. */
export interface StockKey {
  siteId: string
  itemId: string
  itemColourId?: string | null
  lotId?: string | null
  hideId?: string | null
  locationId?: string | null
}
export const explainFigure = (api: ApiClient, key: StockKey, signal?: AbortSignal) => api.get('/inventory/stock/explain', { query: clean({ ...key }), schema: explainSchema, signal })

// ---- the ledger (GET /inventory/ledger…) -----------------------------------------------------------------------------------

const side = z.object({ kind: z.enum(['LOCATION', 'SUPPLIER', 'WORK_ORDER', 'OPENING', 'COUNT', 'ADJUSTMENT', 'SCRAP', 'OUTSIDE']), location: named.nullable() })
export type MoveSide = z.infer<typeof side>
const valuation = z.object({ method: z.string(), quantity: z.string(), unitCost: z.string().optional(), valueAmount: z.number().optional(), currency: z.string() })
const ledgerRowSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  siteCode: z.string(),
  reason: z.enum(STOCK_MOVE_REASONS),
  occurredAt: z.string(),
  createdAt: z.string(),
  item,
  colour: named.nullable(),
  lot: z.object({ id: z.string(), code: z.string() }).nullable(),
  hide: z.object({ id: z.string(), code: z.string() }).nullable(),
  from: side,
  to: side,
  quantity: z.string(),
  uom,
  baseQuantity: z.string(),
  delta: z.string(),
  document: z.object({ type: z.enum(['GoodsReceipt', 'WorkOrder']), id: z.string(), number: z.string() }).nullable(),
  reference: z.string().nullable(),
  note: z.string().nullable(),
  reversalOfId: z.string().nullable(),
  reversedById: z.string().nullable(),
  postedBy: z.object({ audience: z.enum(['OFFICE', 'FLOOR', 'SYSTEM']), name: z.string().nullable(), device: z.object({ id: z.string(), name: z.string() }).nullable() }),
  valuation: valuation.nullable().optional(),
  /** B-W2a-11: a SCRAP that is a write-off: its record (the first move's id), its WRITE_OFF reason code and note. */
  writeOff: z.object({ id: z.string(), reasonCode: z.string(), note: z.string().nullable() }).nullable().optional(),
})
export type LedgerRow = z.infer<typeof ledgerRowSchema>
/** `rowCount` (B-W2a-11): every move of the filter, on the first page only (null with a cursor). */
const ledgerSchema = z.object({ moves: z.array(ledgerRowSchema), nextCursor: z.string().nullable(), closing: z.string().nullable(), rowCount: z.number().nullable().optional() })
export type LedgerPage = z.infer<typeof ledgerSchema>

export interface LedgerQuery extends Partial<StockKey> {
  reasons?: readonly MoveReason[]
  createdById?: string | null
  deviceId?: string | null
  documentId?: string | null
  hasNote?: boolean | null
  reversed?: boolean | null
  from?: string | null
  to?: string | null
  cursor?: string | null
  limit?: number
  /** B-W2a-11: text across the ledger (item, lot, hide, places, receipt, work order, reference, note). */
  q?: string | null
  /** B-W2a-11: only write-offs (true) or everything but them (false). */
  writeOffs?: boolean | null
}
export const readLedger = (api: ApiClient, query: LedgerQuery, signal?: AbortSignal) =>
  api.get('/inventory/ledger', {
    query: clean({
      siteId: query.siteId,
      itemId: query.itemId,
      itemColourId: query.itemColourId,
      lotId: query.lotId,
      hideId: query.hideId,
      locationId: query.locationId,
      reasons: query.reasons && query.reasons.length > 0 ? query.reasons.join(',') : undefined,
      createdById: query.createdById,
      deviceId: query.deviceId,
      documentId: query.documentId,
      hasNote: query.hasNote === null || query.hasNote === undefined ? undefined : String(query.hasNote),
      reversed: query.reversed === null || query.reversed === undefined ? undefined : String(query.reversed),
      from: query.from,
      to: query.to,
      cursor: query.cursor,
      limit: query.limit,
      q: query.q?.trim() || undefined,
      writeOffs: query.writeOffs === null || query.writeOffs === undefined ? undefined : String(query.writeOffs),
    }),
    schema: ledgerSchema,
    signal,
  })

const ledgerCountsSchema = z.object({ adjustments7d: z.number(), scraps30d: z.number(), counts30d: z.number(), reversals30d: z.number(), writeOffs30d: z.number().optional(), unvalued: z.number().optional() })
export type LedgerCounts = z.infer<typeof ledgerCountsSchema>
export const ledgerCounts = (api: ApiClient, siteId: string | null, signal?: AbortSignal) => api.get('/inventory/ledger/counts', { query: clean({ siteId }), schema: ledgerCountsSchema, signal })

const moveDetailSchema = z.object({
  move: ledgerRowSchema.extend({ idempotencyKey: z.string(), receiptLineId: z.string().nullable(), workOrderId: z.string().nullable(), worker: z.string().nullable(), stationOnly: z.boolean() }),
  original: ledgerRowSchema.nullable(),
  reversal: ledgerRowSchema.nullable(),
})
export type MoveDetail = z.infer<typeof moveDetailSchema>
export const ledgerMove = (api: ApiClient, moveId: string, signal?: AbortSignal) => api.get(`/inventory/ledger/${seg(moveId)}`, { schema: moveDetailSchema, signal })

// ---- the ledger's writes (modules/inventory/ledger) --------------------------------------------------------------------------

const postedMoveSchema = z.object({ move: z.object({ id: z.string(), reason: z.enum(STOCK_MOVE_REASONS), baseQuantity: z.string() }).loose() })

export interface AdjustInput {
  siteId: string
  itemId: string
  itemColourId?: string | null
  lotId?: string | null
  hideId?: string | null
  locationId: string
  direction: 'IN' | 'OUT'
  quantity: string
  uom?: Uom
  baseQuantity?: string
  note: string
  reference?: string | null
  /** Cost grain only. */
  unitCost?: string
}
/** inventory.adjust: one correction, up or down, at one place, with its reason (one Idempotency-Key per dialog). */
export const postAdjustment = (api: ApiClient, body: AdjustInput, idempotencyKey: string) =>
  api.post('/inventory/adjustments', { body: Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined && value !== null && value !== '')), schema: postedMoveSchema, idempotencyKey })

/** inventory.reverse: the mirror of one move, with the reason (an issue or a return is reversed from its pick list). */
export const reverseMove = (api: ApiClient, moveId: string, note: string, idempotencyKey: string) =>
  api.post(`/inventory/moves/${seg(moveId)}/reverse`, { body: { note }, schema: z.object({ move: z.object({ id: z.string() }).loose(), reversed: z.string() }), idempotencyKey })

// ---- hides (GET /inventory/hides…) --------------------------------------------------------------------------------------------

const lotBrief = z.object({ id: z.string(), code: z.string(), qualityStatus: quality, crViStatus: crVi, dyeBatch: z.string().nullable(), shade: z.string().nullable() })
/** What a reservation holds stock for (B-W2a-11): a work order, or a line of a sales order. */
export const demandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('WorkOrder'), id: z.string(), number: z.string(), status: z.string() }),
  z.object({ type: z.literal('SalesOrderLine'), id: z.string(), orderId: z.string(), orderNumber: z.string(), seq: z.number(), status: z.string() }),
])
export type Demand = z.infer<typeof demandSchema>
const hideRowSchema = z.object({
  id: z.string(),
  code: z.string(),
  supplierCode: z.string().nullable(),
  siteId: z.string(),
  companyId: z.string(),
  item,
  colour: named.nullable(),
  lot: lotBrief,
  grade: z.string().nullable(),
  shade: z.string().nullable(),
  thicknessMm: z.string().nullable(),
  defects: z.string().nullable(),
  area: z.string(),
  areaUom: uom,
  baseArea: z.string(),
  onHand: z.string(),
  /** What is left of the leather: its stock, or at the cutting table its measured area less its cuts (the API's rule). */
  left: z.string(),
  state: z.enum(HIDE_STATES),
  location: named.nullable(),
  receivedAt: z.string().nullable(),
  createdAt: z.string(),
  /** B-W2a-64: the ACTIVE reservation that holds the hide whole (its demand; `stale` once that demand is done), or null. */
  reservedFor: z.object({ reservationId: z.string(), version: z.number(), demand: demandSchema, stale: z.boolean() }).nullable().optional(),
})
export type HideRow = z.infer<typeof hideRowSchema>
const stateCount = z.object({ hides: z.number(), area: z.array(perUnit) })
export type StateCount = z.infer<typeof stateCount>
const hidesSchema = z.object({
  hides: z.array(hideRowSchema),
  nextCursor: z.string().nullable(),
  counts: z.object({ full: stateCount, partlyCut: stateCount, remnant: stateCount, quarantine: stateCount, consumed: stateCount, reserved: stateCount.optional() }),
  matching: stateCount,
})
export type HidesPage = z.infer<typeof hidesSchema>

export interface HideQuery {
  siteId?: string | null
  lotId?: string | null
  itemId?: string | null
  itemColourId?: string | null
  state?: HideState | null
  inStock?: boolean
  /** B-W2a-64: only hides an ACTIVE reservation holds whole. */
  reserved?: boolean
  quality?: QualityStatus | null
  locationId?: string | null
  grade?: string | null
  shade?: string | null
  q?: string | null
  cursor?: string | null
  limit?: number
}
export const listHides = (api: ApiClient, query: HideQuery, signal?: AbortSignal) =>
  api.get('/inventory/hides', { query: clean({ ...query, inStock: query.inStock ? 'true' : undefined, reserved: query.reserved ? 'true' : undefined, q: query.q?.trim() }), schema: hidesSchema, signal })

const cutSchema = z.object({
  id: z.string(),
  at: z.string(),
  deviceTime: z.string().nullable(),
  workOrder: z.object({ id: z.string(), number: z.string() }).nullable(),
  areaUsed: z.string(),
  remnantArea: z.string(),
  uom,
  baseAreaUsed: z.string(),
  baseRemnantArea: z.string(),
  pieces: z.number(),
  station: named.nullable(),
  device: z.object({ id: z.string(), name: z.string() }).nullable(),
  cutBy: z.string().nullable(),
  note: z.string().nullable(),
  reversalOfId: z.string().nullable(),
  reversedById: z.string().nullable(),
})
export type CutRow = z.infer<typeof cutSchema>
const hideRecordSchema = z.object({
  hide: hideRowSchema,
  lot: z.object({
    id: z.string(),
    code: z.string(),
    qualityStatus: quality,
    qualityNote: z.string().nullable(),
    crVi: z.object({ status: crVi, valueMgKg: z.string().nullable(), limitMgKg: z.string().nullable(), testedOn: z.string().nullable() }),
    supplier: named.nullable(),
    supplierLotRef: z.string().nullable(),
    receipt: z.object({ id: z.string(), number: z.string() }).nullable(),
  }),
  area: z.object({ measured: z.string(), cut: z.string(), remnant: z.string(), onHand: z.string(), uom }),
  cuts: z.array(cutSchema),
  stationOnly: z.boolean(),
})
export type HideRecord = z.infer<typeof hideRecordSchema>
export const hideRecord = (api: ApiClient, hideId: string, signal?: AbortSignal) => api.get(`/inventory/hides/${seg(hideId)}`, { schema: hideRecordSchema, signal })

// ---- lots (GET /inventory/lots…) ------------------------------------------------------------------------------------------------

const lotRowSchema = z.object({
  id: z.string(),
  code: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  siteCode: z.string(),
  item,
  colour: named.nullable(),
  supplier: named.nullable(),
  supplierLotRef: z.string().nullable(),
  dyeBatch: z.string().nullable(),
  shade: z.string().nullable(),
  receivedAt: z.string().nullable(),
  receipt: z.object({ id: z.string(), number: z.string() }).nullable(),
  opening: z.boolean(),
  qualityStatus: quality,
  qualityNote: z.string().nullable(),
  qualityDecidedAt: z.string().nullable(),
  crVi: z.object({ required: z.boolean(), status: crVi, valueMgKg: z.string().nullable(), limitMgKg: z.string().nullable(), evidence: z.enum(['LOT_REPORT', 'SUPPLIER_REPORT']).nullable(), testedOn: z.string().nullable() }),
  documents: z.number(),
  onHand: z.string(),
  hides: z.number(),
  issuedTo: z.number(),
})
export type LotRow = z.infer<typeof lotRowSchema>
const lotCountsSchema = z.object({ quarantine: z.number(), waitingCrVi: z.number(), crViFailed: z.number(), blocked: z.number(), rejected: z.number(), released: z.number() })
export type LotCounts = z.infer<typeof lotCountsSchema>
const lotsSchema = z.object({ lots: z.array(lotRowSchema), nextCursor: z.string().nullable(), counts: lotCountsSchema })
export type LotsPage = z.infer<typeof lotsSchema>

export interface LotQuery {
  siteId?: string | null
  itemId?: string | null
  supplierId?: string | null
  quality?: QualityStatus | null
  onHold?: boolean
  crVi?: CrViStatus | null
  inStock?: boolean
  receivedFrom?: string | null
  receivedTo?: string | null
  q?: string | null
  cursor?: string | null
  limit?: number
}
export const listLots = (api: ApiClient, query: LotQuery, signal?: AbortSignal) =>
  api.get('/inventory/lots', { query: clean({ ...query, onHold: query.onHold ? 'true' : undefined, inStock: query.inStock ? 'true' : undefined, q: query.q?.trim() }), schema: lotsSchema, signal })

const lotRecordSchema = z.object({
  lot: lotRowSchema,
  stock: z.array(z.object({ location: named, onHand: z.string(), held: z.string(), hides: z.number() })),
  hides: z.object({ inStock: z.number(), consumed: z.number(), scrapped: z.number() }),
  trace: z.object({
    backward: z.object({
      supplier: named.nullable(),
      receipt: z.object({ id: z.string(), number: z.string(), status: z.string(), receivedAt: z.string(), supplierDdtNumber: z.string().nullable(), supplierDdtDate: z.string().nullable() }).nullable(),
      purchaseOrder: z.object({ id: z.string(), number: z.string(), lineSeq: z.number().nullable() }).nullable(),
    }),
    forward: z.object({
      workOrders: z.array(z.object({ id: z.string(), number: z.string().nullable(), batchNumber: z.string().nullable(), status: z.string().nullable(), issued: z.string(), returned: z.string(), atWorkOrder: z.string(), hides: z.number() })),
      shipments: z.array(z.object({ id: z.string(), number: z.string(), status: z.string(), customer: named.nullable(), garments: z.number() })),
      customers: z.number(),
    }),
  }),
  moves: z.number(),
})
export type LotRecord = z.infer<typeof lotRecordSchema>
export const lotRecord = (api: ApiClient, lotId: string, signal?: AbortSignal) => api.get(`/inventory/lots/${seg(lotId)}`, { schema: lotRecordSchema, signal })

// ---- locations (modules/inventory/locations) -------------------------------------------------------------------------------------

const locationSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  parentId: z.string().nullable(),
  code: z.string(),
  name: z.string(),
  kind: z.enum(LOCATION_KINDS),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  depth: z.number(),
  path: z.array(z.string()),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type LocationView = z.infer<typeof locationSchema>
const siteLocationsSchema = z.object({ id: z.string(), companyId: z.string(), code: z.string(), name: z.string(), locations: z.array(locationSchema) })
export type SiteLocations = z.infer<typeof siteLocationsSchema>
const oneLocation = z.object({ location: locationSchema })

/** The location trees (tree order: depth first, children by code) of the sites the person may see. */
export const listLocations = (api: ApiClient, query: { siteId?: string | null; includeArchived?: boolean }, signal?: AbortSignal) =>
  api.get('/inventory/locations', { query: clean({ siteId: query.siteId, includeArchived: query.includeArchived ? 'true' : undefined }), schema: z.object({ sites: z.array(siteLocationsSchema) }), signal })
export const createLocation = (api: ApiClient, body: { siteId: string; parentId: string | null; code: string; name: string; kind: LocationKind }) =>
  api.post('/inventory/locations', { body, schema: oneLocation })
export const updateLocation = (api: ApiClient, id: string, body: { version: number; name?: string; kind?: LocationKind }) =>
  api.request('PATCH', `/inventory/locations/${seg(id)}`, { body, schema: oneLocation })
export const moveLocation = (api: ApiClient, id: string, body: { version: number; parentId: string | null }) => api.post(`/inventory/locations/${seg(id)}/move`, { body, schema: oneLocation })
export const archiveLocation = (api: ApiClient, id: string, version: number) => api.post(`/inventory/locations/${seg(id)}/archive`, { body: { version }, schema: oneLocation })

// ---- labels (platform/print) --------------------------------------------------------------------------------------------------

const printerSchema = z.object({ id: z.string(), siteId: z.string(), code: z.string(), name: z.string(), kind: z.enum(['LABEL_ZPL', 'A4_PDF']), status: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']) })
export type PrinterOption = z.infer<typeof printerSchema>
/** The site's label printers (print.view). */
export const listLabelPrinters = async (api: ApiClient, siteId: string, signal?: AbortSignal) =>
  (await api.get('/print/printers', { query: { siteId }, schema: z.object({ printers: z.array(printerSchema) }), signal })).printers.filter((printer) => printer.kind === 'LABEL_ZPL' && printer.status === 'ACTIVE')

const jobSchema = z.object({ id: z.string(), status: z.enum(['QUEUED', 'SENT', 'PRINTED', 'FAILED']), version: z.number(), lastError: z.string().nullable() }).loose()
export type PrintJob = z.infer<typeof jobSchema>
export interface LabelRequest {
  kind: 'HIDE' | 'LOT'
  language: 'it' | 'en'
  scanId: string
  title: string
  fields: Partial<Record<'article' | 'colour' | 'grade' | 'area' | 'thickness' | 'lot' | 'supplier' | 'supplierLot' | 'quantity' | 'received', string | null>>
}
/** print.labels: one label job on a label printer (the record it is for: a Hide or a Lot). */
export const queueLabel = (api: ApiClient, body: { printerId: string; recordType: 'Hide' | 'Lot'; recordId: string; copies: number; label: LabelRequest }, idempotencyKey: string) =>
  api.post('/print/jobs/label', { body, schema: z.object({ job: jobSchema }), idempotencyKey })
export const printJob = (api: ApiClient, jobId: string, signal?: AbortSignal) => api.get(`/print/jobs/${seg(jobId)}`, { schema: z.object({ job: jobSchema }), signal })
export const retryPrintJob = (api: ApiClient, jobId: string, version: number) => api.post(`/print/jobs/${seg(jobId)}/retry`, { body: { version }, schema: z.object({ job: jobSchema }) })
/** The browser's fallback when no label printer is set up: the label as a PDF (stored nowhere). */
export const labelPdf = (api: ApiClient, label: LabelRequest, copies: number) => api.bytes('/print/labels/pdf', { method: 'POST', body: { label, copies } })

