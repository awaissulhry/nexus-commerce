import { z } from 'zod'
import type { FactoryClient } from '@nexus/factory-db'
import { FILES_READ, THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { businessDate as businessDay, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { notMoney } from '@nexus/factory-domain/money/marked'
import { can, type Actor, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import type { Words } from '@nexus/factory-domain/portal/tasks/kinds'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { QUALITY_COMPLAINTS_VIEW } from '@nexus/factory-domain/quality/complaints/permissions'
import { QUALITY_INSPECTIONS_VIEW } from '@nexus/factory-domain/quality/final/permissions'
import { INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import { SALES_MEASUREMENTS_VIEW } from '@nexus/factory-domain/sales/measure-link/permissions'
import { WORKSHEET_KIND } from '@nexus/factory-domain/sales/mtm/worksheet'
import { SALES_RETURNS_VIEW } from '@nexus/factory-domain/sales/returns/permissions'
import { SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { MAX_COPY_HOPS } from '../../../platform/files/content-wall'
import { fileRecordParty, fileRecordScope, reachesFileRecord, type FileRecordScope } from '../../../platform/files/record-scope'
import { recordLabelOf } from '../../../platform/threads/labels'
import { mayOnThread } from '../../../platform/threads/records'
import { BODY_DATA_CATEGORIES } from '../../production/order-files/read'
import { seesEveryCustomer } from '../../quality/wall'
import { reachesWorkOrder } from '../../production/work-orders/scope'
import { artworkOf } from '../configurator/artwork'
import { PROFILE_RECORD } from '../mtm/store'
import { officeContextOf } from './access'
import { officeOrder } from './moves'
import type { OrderRow } from './store'
// B-OP-043 (order page N6, lines-derived): an order's shipments through their lines.
import { shipmentsOfOrderWhere } from '../../shipping/shipments/orders-of'
// B-CP-023 (customer page plan, the money wall D6, L1; review B1, D1): a priced file only for someone who sees prices.
import { seesPrices } from '@nexus/factory-domain/files/priced'
// B-PT-013 (order production tab R13): the customer's tech pack — the inquiry the order came from (the inquiries' own finder) and
// its files at their version in force.
import { SALES_INQUIRIES_VIEW } from '@nexus/factory-domain/sales/inquiries/permissions'
import { inquiryOfOrder } from '../inquiries/quote'
import { techPackOf } from '../inquiries/views'
// B-OF-033 (order files tab): the order's asks for files, sent with its files (modules/sales/file-asks/read.ts).
import { serverClock } from '../../../core/time'
import { askView, customerAskView, orderAsksOf } from '../file-asks/read'
// B-OF-001 (order files tab, S3): each file's facts and what the reader may do over the order; the papers Nexus made.
import { FILES_DELETE, FILES_MANAGE, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { MADE_PAPERS, madePapersOf } from '../../../platform/files/made'
import { mayKeepAsks } from '../file-asks/file-asks'

/**
 * B-SA-036 (Sales page plan N9, P14, R7; 13-backend B11; review BW-1): EVERY file of one sales order for the office, by where it
 * comes from, modelled on B-PR-44 (production/order-files: the order's own files, nobody re-types them):
 *
 *   GET  /sales/orders/:orderId/files                   the groups below, each file with who can see it (CUSTOMER_CAN_SEE when
 *                                                       shared with this order's customer, else OFFICE_ONLY), where it hangs
 *                                                       (its record), and a copy listed ONCE with "also on …"
 *   POST /sales/orders/:orderId/files/:fileId/open      ONE of them, found again in this very read (./order-files-open.ts)
 *
 *   ORDER      Order & thread         the order's own files (its thread's attachments, its confirmations)
 *   LINES      Lines & artwork        its lines' files, the artwork of the quote line each was made from (configurator artworkOf,
 *                                     never a copy), the newest MTM worksheet of each made-to-measure line (measurements right)
 *   REQUESTS   Requests               the files of the customer's change requests on it
 *   PRODUCTION Production             the files of its live work orders and their holds                         workorders.view
 *   QUALITY    Quality                the final inspections of those work orders, their defects and check results
 *                                                                                                    quality.inspections.view
 *   SHIPMENTS  Shipments & invoices   its shipments (POD), DDTs                         shipping.view; its invoices invoices.view
 *   RETURNS    Returns & complaints   its returns                               sales.returns.view; its complaints quality.complaints.view
 *   TECH_PACK  Customer's tech pack   B-PT-013: the files of the inquiry the order came from (sales/inquiries quote inquiryOfOrder: its
 *                                     quote's inquiry, else the one naming the order), each at its version in force (inquiries
 *                                     techPackOf) with `techPack` {named, inForce, newer}       sales.inquiries.view (else counted)
 *                                     Fail closed: an inquiry of another customer or company linked by mistake gives no group; a file
 *                                     whose record cannot be placed (unknown scope) or names another customer is counted, never listed;
 *                                     a file of a record that names no party (a mail's) passes on the company — the reader reached THIS
 *                                     order and its inquiry first
 *
 * The brand wall (Owner rule 2026-11-16): the order is found with orders.view over its company and customer (else "Sales order not
 * found.", the words of an unknown id); each file again through the office's own file rule — its RECORD's scope
 * (platform/files/record-scope fileRecordScope + reachesFileRecord, files.read; a work order of several customers, made before
 * the one-customer rule, only for people who reach every customer) — and its group's right; a file left out is counted
 * (`leftOut`), never named. Body data (a measurement sheet, a body photo) only with sales.measurements.view over the customer
 * (else `measurementsLeftOut`); opening it is recorded on the order. A copy (Use on, B-TH-024) is listed once: "also on …" names
 * ONLY records of this order's customer the reader reaches; any other record a copy sits on is counted ("also on 1 other record").
 * At most 500 files are read (`truncated`); nothing is presigned until a file is opened. A read: no command, no event.
 *
 * B-OP-050 (order page plan N7): each file says who added it (`addedBy`) — an office person by name; "the floor" (a floor device's
 * upload: never a worker's name); this order's customer by its name (a portal or link upload of its own); null for the system's own
 * files and anything not known. The small previews and PDF links of the cards are POST …/files/previews (./order-files-previews.ts).
 */

// B-PT-013: + TECH_PACK (after the lines: what the order is made to). The web reads the key as a string.
export const ORDER_FILE_GROUPS = ['ORDER', 'LINES', 'TECH_PACK', 'REQUESTS', 'PRODUCTION', 'QUALITY', 'SHIPMENTS', 'RETURNS'] as const
export type OrderFileGroup = (typeof ORDER_FILE_GROUPS)[number]

/** The groups' words (the catalogue's: "conversazione" for the thread, R9). */
export const ORDER_FILE_GROUP_WORDS: Readonly<Record<OrderFileGroup, Words>> = Object.freeze({
  ORDER: { it: 'Ordine e conversazione', en: 'Order & thread' },
  LINES: { it: 'Righe e grafiche', en: 'Lines & artwork' },
  REQUESTS: { it: 'Richieste', en: 'Requests' },
  PRODUCTION: { it: 'Produzione', en: 'Production' },
  QUALITY: { it: 'Qualità', en: 'Quality' },
  SHIPMENTS: { it: 'Spedizioni e fatture', en: 'Shipments & invoices' },
  RETURNS: { it: 'Resi e reclami', en: 'Returns & complaints' },
  TECH_PACK: { it: 'Scheda tecnica del cliente', en: "Customer's tech pack" }, // B-PT-013
})

export const FILE_AUDIENCES = ['CUSTOMER_CAN_SEE', 'OFFICE_ONLY'] as const
export type FileAudience = (typeof FILE_AUDIENCES)[number]

/** At most this many files of one order are read (an order has far fewer). */
export const ORDER_FILES_CAP = 500

const FILE_SELECT = {
  id: true,
  companyId: true,
  recordType: true,
  recordId: true,
  kind: true,
  category: true,
  originalName: true,
  contentType: true,
  sizeBytes: true,
  versionNo: true,
  availableAt: true,
  createdAt: true,
  visibility: true,
  partyId: true,
  sourceFileId: true,
  createdById: true, // B-OP-050
  priced: true, // B-CP-023
  // B-OF-001: the lock every act sends, its series, what keeps it.
  version: true,
  seriesId: true,
  legalHold: true,
  retainUntil: true,
} as const

type Db = FactoryClient
type FileRow = { readonly id: string; readonly companyId: string | null; readonly recordType: string; readonly recordId: string; readonly kind: string; readonly category: string | null; readonly originalName: string; readonly contentType: string; readonly sizeBytes: number; readonly versionNo: number; readonly availableAt: Date | null; readonly createdAt: Date; readonly visibility: readonly string[]; readonly partyId: string | null; readonly sourceFileId: string | null; /* B-OP-050 */ readonly createdById: string | null; /* B-CP-023 */ readonly priced: boolean; /* B-OF-001 */ readonly version: number; readonly seriesId: string | null; readonly legalHold: boolean; readonly retainUntil: Date | null }

/** B-OP-050: who added a file, as the office's cards say it (never a worker: the floor is "the floor"). */
export const ADDED_BY_KINDS = ['PERSON', 'FLOOR', 'CUSTOMER'] as const
export interface AddedBy {
  readonly kind: (typeof ADDED_BY_KINDS)[number]
  /** An office person's name, or this order's customer's; null for the floor (the screen says "the floor"). */
  readonly name: string | null
}

export interface RecordRef {
  readonly type: string
  readonly id: string
  readonly label: string
}

// ── B-OF-003 (order files tab, S3): the record a file hangs on, with its paper's state and a DDT's shipment ──
/** ANNULLED: a file of an annulled DDT; REPLACED: a file of an invoice that is no longer its XML or PDF (the rejected pair). */
export const FILE_STATES = ['ANNULLED', 'REPLACED'] as const
/**
 * A DDT's paper: the shipment it travels with (the web draws it inside that shipment's block). of-fx5s (W-12): + the day it was
 * shipped (Europe/Rome; null: not shipped yet) and its DDT's own number (the shipment's live DDT, not an annulled one; null: none,
 * or the reader does not see shipping), for "SEED-SH-0011 · Shipped 12 Nov · DDT 144/2026".
 */
export interface FromShipment {
  readonly id: string
  readonly label: string
  readonly shippedOn: string | null
  readonly ddtNumber: string | null
}
export interface FileFrom extends RecordRef {
  readonly state: (typeof FILE_STATES)[number] | null
  /** A DDT's paper: its shipment (FromShipment); null: any other file. */
  readonly shipment: FromShipment | null
}
/** B-OF-001: who can TRULY see a file: CUSTOMER only when shared with this order's customer and its whole content is that customer's. */
export const TRUE_AUDIENCES = ['CUSTOMER', 'LINK', 'FLOOR'] as const
// ── end B-OF-003 ──

export interface OrderFile {
  readonly id: string
  readonly group: OrderFileGroup
  readonly companyId: string | null
  readonly name: string
  readonly kind: string
  readonly category: string | null
  readonly contentType: string
  readonly sizeBytes: number
  readonly versionNo: number
  readonly at: Date
  readonly from: FileFrom
  readonly line: { readonly id: string; readonly seq: number } | null
  readonly audience: FileAudience
  readonly bodyData: boolean
  readonly alsoOn: RecordRef[]
  readonly alsoOnOther: number
  /** A thread attachment: the message of the order's thread it came with (for a reader of the thread). */
  readonly inThread: { readonly messageId: string } | null
  /** B-OP-050: who added it (null: the system, or not known). */
  readonly addedBy: AddedBy | null
  /** B-PT-013: a file of the customer's tech pack — the version the request named, shown at its version in force; null: any other file. */
  readonly techPack: TechPackMark | null
  // ---- B-OF-001 (S3): its lock, its series, what keeps it, fiscal, priced, its true audiences ----
  readonly version: number
  readonly seriesId: string | null
  readonly kept: { readonly legalHold: boolean; readonly retainUntil: Date | null }
  readonly fiscal: boolean
  readonly priced: boolean
  // of-fx3s: a plain array (the answer's schema is a mutable array; the view builds a fresh one per file).
  readonly audiences: (typeof TRUE_AUDIENCES)[number][]
}

// ── B-OF-002 (S3): an upload the virus scan holds (or one left pending), the reader's own: a card, never opened, never previewed ──
export const HELD_REASONS = ['SCAN_PENDING', 'INFECTED', 'SCAN_FAILED', 'OTHER'] as const
export interface HeldFile {
  readonly id: string
  readonly name: string
  readonly group: OrderFileGroup
  readonly at: Date
  readonly reason: (typeof HELD_REASONS)[number]
}
/** An upload still PENDING_UPLOAD after this long is held too (it was never confirmed). */
export const HELD_PENDING_MS = 15 * 60 * 1000
// ── end B-OF-002 ──

/** B-PT-013: a tech pack file — the version number the request named, at its version in force (`newer`: a later one than named). */
export interface TechPackMark {
  readonly named: number
  readonly inForce: true
  readonly newer: boolean
}

export interface OrderWorksheet {
  readonly documentId: string
  readonly profileId: string
  readonly line: { readonly id: string; readonly seq: number }
  readonly version: number
  readonly number: string | null
  readonly language: string
  readonly createdAt: Date
}

export interface OfficeOrderFiles {
  readonly order: Pick<OrderRow, 'id' | 'number' | 'companyId' | 'partyId'>
  readonly groups: readonly { readonly key: OrderFileGroup; readonly files: OrderFile[]; readonly worksheets: OrderWorksheet[]; leftOut: number; measurementsLeftOut: number; /* B-CP-023 */ pricedLeftOut: number; /* B-OF-002 */ heldCount: number }[]
  /** B-OF-002: the reader's own held uploads on the order or its lines. */
  readonly held: readonly HeldFile[]
  /** Every file of the order this reader may open (a copy folded under another one too): the open route finds a file here. */
  readonly openable: ReadonlyMap<string, OrderFile>
  readonly truncated: boolean
}

const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)]
const keyOf = (type: string, recordId: string) => `${type}:${recordId}`

/** A file as a copy chain reads it. */
type Node = { id: string; recordType: string; recordId: string; companyId: string | null; sourceFileId: string | null; status: string }
const NODE = { id: true, recordType: true, recordId: true, companyId: true, sourceFileId: true, status: true } as const

/** The files and, up their copy chains, every source (at most MAX_COPY_HOPS up, as the content wall follows a chain). */
async function chainsOf(db: Db, files: readonly FileRow[]): Promise<Map<string, Node>> {
  const nodes = new Map<string, Node>(files.map((file) => [file.id, { id: file.id, recordType: file.recordType, recordId: file.recordId, companyId: file.companyId, sourceFileId: file.sourceFileId, status: 'AVAILABLE' }]))
  let frontier = unique(files.flatMap((file) => (file.sourceFileId && !nodes.has(file.sourceFileId) ? [file.sourceFileId] : [])))
  for (let hop = 0; hop < MAX_COPY_HOPS && frontier.length > 0; hop++) {
    const rows = (await db.storedFile.findMany({ where: { id: { in: frontier } }, select: NODE })) as Node[]
    for (const row of rows) nodes.set(row.id, row)
    frontier = unique(rows.flatMap((row) => (row.sourceFileId && !nodes.has(row.sourceFileId) ? [row.sourceFileId] : [])))
  }
  return nodes
}

/** The records of a file's content: its own, then each source's up its chain (null: a source is missing or the chain is too long). */
function contentRecordsOf(nodes: ReadonlyMap<string, Node>, fileId: string): { type: string; id: string; companyId: string | null }[] | null {
  const out: { type: string; id: string; companyId: string | null }[] = []
  const seen = new Set<string>()
  let at: string | null = fileId
  while (at !== null) {
    const node = nodes.get(at)
    if (!node || seen.has(at) || seen.size > MAX_COPY_HOPS) return null
    seen.add(at)
    out.push({ type: node.recordType, id: node.recordId, companyId: node.companyId })
    at = node.sourceFileId
  }
  return out
}

/** The office's read of one order's files (the order reached with orders.view by `officeOrder`). */
export async function readOfficeOrderFiles(caller: CommandCaller, orderId: string): Promise<OfficeOrderFiles> {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const order = await officeOrder(caller, orderId)
  return caller.withClient((db) => readFiles(db, context.tenantId, actor, order, context.actorId))
}

async function readFiles(db: Db, tenantId: string, actor: Actor, order: OrderRow, /* B-OF-002 */ actorId: string): Promise<OfficeOrderFiles> {
  const scope = { companyId: order.companyId, partyId: order.partyId }
  const may = (permission: Permission) => can(actor, permission, scope)

  // ---- the records the order's files hang on (one query per kind; one after another: a scoped client is one transaction)
  const lines = await db.salesOrderLine.findMany({ where: { orderId: order.id }, select: { id: true, seq: true, quoteLineId: true, measurementProfileId: true }, orderBy: { seq: 'asc' } })
  const lineIds = lines.map((line) => line.id)
  const lineOf = new Map(lines.map((line) => [line.id, line]))
  const upstream = new Map<string, string>() // quote-line artwork file → the order line it travels with
  for (const line of lines) {
    if (!line.quoteLineId) continue
    for (const entry of await artworkOf(db, { kind: 'ORDER', line: { id: line.id, quoteLineId: line.quoteLineId } })) if (entry.from === 'QUOTE_LINE') upstream.set(entry.fileId, line.id)
  }
  const requests = await db.orderChangeRequest.findMany({ where: { orderId: order.id }, select: { id: true, kind: true } })
  const requestLines = requests.length === 0 ? [] : await db.orderChangeRequestLine.findMany({ where: { requestId: { in: requests.map((row) => row.id) } }, select: { id: true, requestId: true } })
  const cells = lineIds.length === 0 ? [] : await db.workOrderSize.findMany({ where: { salesOrderLineId: { in: lineIds }, workOrder: { kind: { not: 'REPAIR' }, status: { not: 'CANCELLED' } } }, select: { workOrderId: true, measurementProfileId: true, salesOrderLineId: true } })
  const workOrderIds = unique(cells.map((cell) => cell.workOrderId))
  const workOrders = workOrderIds.length === 0 ? [] : await db.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, number: true, companyId: true, siteId: true, partyId: true } })
  const workOrderOf = new Map(workOrders.map((row) => [row.id, row]))
  const holds = workOrderIds.length === 0 ? [] : await db.workOrderHold.findMany({ where: { workOrderId: { in: workOrderIds } }, select: { id: true, workOrderId: true } })
  const inspections = workOrderIds.length === 0 ? [] : await db.inspection.findMany({ where: { workOrderId: { in: workOrderIds } }, select: { id: true, workOrderId: true, number: true } })
  const inspectionOf = new Map(inspections.map((row) => [row.id, row]))
  const defects = workOrderIds.length === 0 ? [] : await db.inspectionDefect.findMany({ where: { workOrderId: { in: workOrderIds } }, select: { id: true, workOrderId: true, inspectionId: true } })
  const checks = inspections.length === 0 ? [] : await db.inspectionCheckResult.findMany({ where: { inspectionId: { in: inspections.map((row) => row.id) } }, select: { id: true, inspectionId: true } })
  // B-OP-043 (order page N6): a shared shipment's files show on every order it carries (made for it or carrying its garments).
  const shipments = await db.shipment.findMany({ where: shipmentsOfOrderWhere(order.id), select: { id: true, number: true, shippedAt: true /* of-fx5s (W-12) */ } })
  // B-OF-003: + a DDT's shipment and whether it was annulled (a DdtCancellation row).
  const ddts = shipments.length === 0 ? [] : await db.ddt.findMany({ where: { shipmentId: { in: shipments.map((row) => row.id) } }, select: { id: true, number: true, shipmentId: true, documentDate: true /* of-fx5s (W-12) */, cancellations: { select: { id: true }, take: 1 } } })
  // B-OF-003: + each invoice's XML and PDF (a file of it that is neither was replaced), and the credit notes of its invoices.
  const ownInvoices = await db.invoice.findMany({ where: { salesOrderId: order.id }, select: { id: true, number: true, xmlFileId: true, pdfFileId: true } })
  const creditNotes = ownInvoices.length === 0 ? [] : await db.invoice.findMany({ where: { docType: 'TD04', creditOfId: { in: ownInvoices.map((row) => row.id) } }, select: { id: true, number: true, xmlFileId: true, pdfFileId: true } })
  const invoices = [...ownInvoices, ...creditNotes.filter((note) => !ownInvoices.some((row) => row.id === note.id))]
  const invoiceFiles = new Map(invoices.map((row) => [row.id, new Set([row.xmlFileId, row.pdfFileId].filter((fileId): fileId is string => fileId !== null))]))
  const returns = await db.returnAuthorisation.findMany({ where: { salesOrderId: order.id }, select: { id: true, number: true } })
  const complaints = await db.complaint.findMany({ where: { salesOrderId: order.id }, select: { id: true, number: true } })
  // B-PT-013: the customer's tech pack (null: no inquiry, or one of another customer or company: no group).
  const pack = await techPackOfOrder(db, actor, order)

  // Each record: its group, its label, the work order it belongs to (the production and quality rights ask it), its line.
  // B-OF-003: + a paper's state (an annulled DDT) and a DDT's shipment.
  type RecordEntry = { group: OrderFileGroup; label: string; workOrderId: string | null; lineId: string | null; right: Permission | null; state: 'ANNULLED' | null; shipment: FromShipment | null }
  const records = new Map<string, RecordEntry>()
  const put = (type: string, recordId: string, entry: { group: OrderFileGroup; label: string; workOrderId?: string | null; lineId?: string | null; right?: Permission | null; state?: 'ANNULLED' | null; shipment?: FromShipment | null }) =>
    records.set(keyOf(type, recordId), { workOrderId: null, lineId: null, right: null, state: null, shipment: null, ...entry })
  put('SalesOrder', order.id, { group: 'ORDER', label: order.number })
  for (const line of lines) put('SalesOrderLine', line.id, { group: 'LINES', label: `${order.number} · ${line.seq}`, lineId: line.id })
  for (const request of requests) put('OrderChangeRequest', request.id, { group: 'REQUESTS', label: `${order.number} · ${request.kind}` })
  const kindOfRequest = new Map(requests.map((row) => [row.id, row.kind]))
  for (const line of requestLines) put('OrderChangeRequestLine', line.id, { group: 'REQUESTS', label: `${order.number} · ${kindOfRequest.get(line.requestId) ?? ''}` })
  for (const workOrder of workOrders) put('WorkOrder', workOrder.id, { group: 'PRODUCTION', label: workOrder.number, workOrderId: workOrder.id, right: WORKORDERS_VIEW })
  for (const hold of holds) put('WorkOrderHold', hold.id, { group: 'PRODUCTION', label: workOrderOf.get(hold.workOrderId)?.number ?? '', workOrderId: hold.workOrderId, right: WORKORDERS_VIEW })
  for (const inspection of inspections) put('Inspection', inspection.id, { group: 'QUALITY', label: inspection.number ?? workOrderOf.get(inspection.workOrderId)?.number ?? '', workOrderId: inspection.workOrderId, right: QUALITY_INSPECTIONS_VIEW })
  for (const defect of defects) put('InspectionDefect', defect.id, { group: 'QUALITY', label: inspectionOf.get(defect.inspectionId)?.number ?? workOrderOf.get(defect.workOrderId)?.number ?? '', workOrderId: defect.workOrderId, right: QUALITY_INSPECTIONS_VIEW })
  for (const check of checks) {
    const inspection = check.inspectionId ? inspectionOf.get(check.inspectionId) : undefined
    if (inspection) put('InspectionCheckResult', check.id, { group: 'QUALITY', label: inspection.number ?? workOrderOf.get(inspection.workOrderId)?.number ?? '', workOrderId: inspection.workOrderId, right: QUALITY_INSPECTIONS_VIEW })
  }
  for (const shipment of shipments) put('Shipment', shipment.id, { group: 'SHIPMENTS', label: shipment.number, right: SHIPPING_VIEW })
  // ---- of-fx5s (W-12): each shipment's live DDT (not annulled; the latest by its date, then its number), from the DDTs read above.
  const liveDdtOf = new Map<string, { number: string; documentDate: Date }>()
  for (const ddt of ddts) {
    if (!ddt.shipmentId || ddt.cancellations.length > 0) continue
    const known = liveDdtOf.get(ddt.shipmentId)
    const later = !known || ddt.documentDate.getTime() > known.documentDate.getTime() || (ddt.documentDate.getTime() === known.documentDate.getTime() && ddt.number > known.number)
    if (later) liveDdtOf.set(ddt.shipmentId, { number: ddt.number, documentDate: ddt.documentDate })
  }
  const seesShipping = may(SHIPPING_VIEW)
  const shipmentOf = new Map(shipments.map((row) => [row.id, row]))
  const fromShipment = (shipmentId: string | null): FromShipment | null => {
    const row = shipmentId ? shipmentOf.get(shipmentId) : undefined
    if (!row) return null
    return { id: row.id, label: row.number, shippedOn: row.shippedAt ? businessDate(row.shippedAt) : null, ddtNumber: seesShipping ? (liveDdtOf.get(row.id)?.number ?? null) : null }
  }
  // ---- end of-fx5s
  for (const ddt of ddts) {
    const shipment = fromShipment(ddt.shipmentId)
    put('Ddt', ddt.id, { group: 'SHIPMENTS', label: ddt.number, right: SHIPPING_VIEW, state: ddt.cancellations.length > 0 ? 'ANNULLED' : null, shipment }) // B-OF-003
  }
  for (const invoice of invoices) put('Invoice', invoice.id, { group: 'SHIPMENTS', label: invoice.number ?? '', right: INVOICES_VIEW })
  for (const row of returns) put('ReturnAuthorisation', row.id, { group: 'RETURNS', label: row.number, right: SALES_RETURNS_VIEW })
  for (const row of complaints) put('Complaint', row.id, { group: 'RETURNS', label: row.number, right: QUALITY_COMPLAINTS_VIEW })

  const byType = new Map<string, string[]>()
  for (const key of records.keys()) {
    const [type, recordId] = key.split(':') as [string, string]
    byType.set(type, [...(byType.get(type) ?? []), recordId])
  }
  const fetched = (await db.storedFile.findMany({
    where: {
      status: 'AVAILABLE',
      supersededAt: null,
      OR: [
        ...[...byType].map(([recordType, ids]) => ({ recordType, recordId: { in: ids } })),
        ...(upstream.size > 0 ? [{ id: { in: [...upstream.keys()] } }] : []),
        ...(pack && pack.mayRead && pack.files.size > 0 ? [{ id: { in: [...pack.files.keys()] } }] : []), // B-PT-013
      ],
    },
    select: FILE_SELECT,
    orderBy: [{ availableAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    take: ORDER_FILES_CAP + 1,
  })) as FileRow[]
  const truncated = fetched.length > ORDER_FILES_CAP
  const files = fetched.slice(0, ORDER_FILES_CAP)

  // ---- the wall, per record (its scope read once) and per file ------------------------------------------------------------
  const scopes = new Map<string, FileRecordScope>()
  const scopeOf = async (type: string, recordId: string): Promise<FileRecordScope> => {
    const key = keyOf(type, recordId)
    const known = scopes.get(key)
    if (known) return known
    const found = await fileRecordScope(db, tenantId, { recordType: type, recordId })
    scopes.set(key, found)
    return found
  }
  // A copy is judged by its whole content (13-backend W5): its own record and every source's record up its chain.
  const nodes = await chainsOf(db, files)
  const everyCustomer = seesEveryCustomer(actor, FILES_READ)
  const sourcesReached = async (file: FileRow): Promise<boolean> => {
    if (!file.sourceFileId) return true
    const chain = contentRecordsOf(nodes, file.id)
    if (chain === null) return everyCustomer
    for (const record of chain.slice(1)) if (!reachesFileRecord(actor, FILES_READ, await scopeOf(record.type, record.id), record.companyId)) return false
    return true
  }
  // B-OF-001: the content of a file is this order's customer's (or no customer's): its own record and, for a copy, each source's.
  const contentIsTheCustomers = async (file: FileRow): Promise<boolean> => {
    const chain = file.sourceFileId ? contentRecordsOf(nodes, file.id) : [{ type: file.recordType, id: file.recordId, companyId: file.companyId }]
    if (chain === null) return false
    for (const record of chain) {
      const party = fileRecordParty(await scopeOf(record.type, record.id))
      if (party !== null && party !== order.partyId) return false
    }
    return true
  }
  const groups = new Map(ORDER_FILE_GROUPS.map((key) => [key, { key, files: [] as OrderFile[], worksheets: [] as OrderWorksheet[], leftOut: 0, measurementsLeftOut: 0, pricedLeftOut: 0 /* B-CP-023 */, heldCount: 0 /* B-OF-002 */ }]))
  // B-PT-013: without sales.inquiries.view the tech pack's files are counted, never named.
  if (pack && !pack.mayRead) groups.get('TECH_PACK')!.leftOut += pack.files.size
  // B-CP-023: a reader who does not see prices gets the order's priced files counted, never named (the Files tab, its open route,
  // the previews and the dock's files line all read this answer).
  const sees = seesPrices(actor)
  const shown: { file: FileRow; view: OrderFile }[] = []
  for (const file of files) {
    // B-PT-013: a file of the customer's tech pack (its version in force), first.
    const packed = pack && pack.mayRead ? (pack.files.get(file.id) ?? null) : null
    const lineId = packed ? null : file.recordType === 'SalesOrderLine' ? file.recordId : (upstream.get(file.id) ?? null)
    const record = packed
      ? { group: 'TECH_PACK' as const, label: pack!.label, workOrderId: null, lineId: null, right: null, state: null, shipment: null /* B-OF-003 */ }
      : upstream.has(file.id)
        ? { group: 'LINES' as const, label: `${order.number} · ${lineOf.get(lineId!)?.seq ?? ''}`, workOrderId: null, lineId, right: null, state: null, shipment: null /* B-OF-003 */ }
        : records.get(keyOf(file.recordType, file.recordId))
    if (!record) continue
    const group = groups.get(record.group)!
    const workOrder = record.workOrderId ? workOrderOf.get(record.workOrderId) : undefined
    const rightHeld = record.right === null || (may(record.right) && (!workOrder || reachesWorkOrder(actor, record.right, workOrder)))
    const found = await scopeOf(!packed && upstream.has(file.id) ? 'SalesOrderLine' : file.recordType, !packed && upstream.has(file.id) ? lineId! : file.recordId)
    // B-PT-013, fail closed: a tech pack file whose record cannot be placed, or names another customer, is counted only.
    const packWalled = packed !== null && (found.kind === 'unknown' || (fileRecordParty(found) !== null && fileRecordParty(found) !== order.partyId))
    const reached = rightHeld && !packWalled && reachesFileRecord(actor, FILES_READ, found, file.companyId) && (await sourcesReached(file))
    if (!reached) {
      group.leftOut += 1
      continue
    }
    // ---- B-CP-023: a priced document without the price grain: counted, never named, never openable.
    if (file.priced && !sees) {
      group.pricedLeftOut += 1
      continue
    }
    // ---- end B-CP-023
    const bodyData = file.category !== null && BODY_DATA_CATEGORIES.has(file.category)
    if (bodyData && !can(actor, SALES_MEASUREMENTS_VIEW, { companyId: file.companyId, partyId: order.partyId })) {
      group.measurementsLeftOut += 1
      continue
    }
    const line = lineId ? lineOf.get(lineId) : undefined
    // ---- B-OF-001: the TRUE audiences — CUSTOMER only when shared with THIS order's customer and every record of its content (a copy's
    // chain) is that customer's or no customer's; LINK the same party; FLOOR as shared.
    const sharedHere = file.partyId === order.partyId && (await contentIsTheCustomers(file))
    const audiences = [
      ...(file.visibility.includes('PARTNER') && sharedHere ? (['CUSTOMER'] as const) : []),
      ...(file.visibility.includes('LINK') && sharedHere ? (['LINK'] as const) : []),
      ...(file.visibility.includes('FLOOR') ? (['FLOOR'] as const) : []),
    ]
    // ---- B-OF-003: an annulled DDT's paper; an invoice's file that is no longer its XML or PDF.
    const ownFiles = file.recordType === 'Invoice' ? invoiceFiles.get(file.recordId) : undefined
    const state = record.state ?? (ownFiles && ownFiles.size > 0 && !ownFiles.has(file.id) ? 'REPLACED' : null)
    shown.push({
      file,
      view: {
        id: file.id,
        group: record.group,
        companyId: file.companyId,
        name: file.originalName,
        kind: file.kind,
        category: file.category,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        versionNo: file.versionNo,
        at: file.availableAt ?? file.createdAt,
        from: { type: !packed && upstream.has(file.id) ? 'SalesOrderLine' : file.recordType, id: !packed && upstream.has(file.id) ? lineId! : file.recordId, label: record.label, state, shipment: record.shipment /* B-OF-003 */ },
        line: line ? { id: line.id, seq: line.seq } : null,
        audience: file.visibility.includes('PARTNER') && file.partyId === order.partyId ? 'CUSTOMER_CAN_SEE' : 'OFFICE_ONLY',
        bodyData,
        alsoOn: [],
        alsoOnOther: 0,
        inThread: null,
        addedBy: null,
        techPack: packed, // B-PT-013
        // B-OF-001
        version: file.version,
        seriesId: file.seriesId,
        kept: { legalHold: file.legalHold, retainUntil: file.retainUntil },
        fiscal: file.kind === 'FISCAL_ARCHIVE',
        priced: file.priced,
        audiences,
      },
    })
  }

  // ---- B-OF-002: what the virus scan holds (or an upload left pending) on the same records — counted per group where the reader would
  // read it; the reader's OWN uploads on the order or its lines also as cards (never opened, never previewed: the open route finds
  // AVAILABLE files only). The scan's retry stays at the file's home.
  const heldRows = byType.size === 0 ? [] : await db.storedFile.findMany({
    where: {
      supersededAt: null,
      AND: [
        { OR: [{ status: 'QUARANTINED' }, { status: 'PENDING_UPLOAD', createdAt: { lt: new Date(serverClock.now().getTime() - HELD_PENDING_MS) } }] },
        { OR: [...byType].map(([recordType, ids]) => ({ recordType, recordId: { in: ids } })) },
      ],
    },
    select: { id: true, companyId: true, recordType: true, recordId: true, originalName: true, createdAt: true, createdById: true, scanStatus: true, quarantineReason: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: ORDER_FILES_CAP,
  })
  const held: HeldFile[] = []
  for (const row of heldRows) {
    const record = records.get(keyOf(row.recordType, row.recordId))
    if (!record) continue
    const workOrder = record.workOrderId ? workOrderOf.get(record.workOrderId) : undefined
    const rightHeld = record.right === null || (may(record.right) && (!workOrder || reachesWorkOrder(actor, record.right, workOrder)))
    if (!rightHeld || !reachesFileRecord(actor, FILES_READ, await scopeOf(row.recordType, row.recordId), row.companyId)) continue
    groups.get(record.group)!.heldCount += 1
    if (row.createdById === actorId && (row.recordType === 'SalesOrder' || row.recordType === 'SalesOrderLine')) {
      const reason = row.scanStatus === 'INFECTED' ? 'INFECTED' : row.scanStatus === 'FAILED' ? 'SCAN_FAILED' : row.scanStatus === 'PENDING' || row.quarantineReason === 'scan_pending' ? 'SCAN_PENDING' : 'OTHER'
      held.push({ id: row.id, name: row.originalName, group: record.group, at: row.createdAt, reason })
    }
  }
  // ---- end B-OF-002

  // ---- B-OP-050: who added each file shown (an office person, the floor, this order's customer) ---------------------------
  const adders = await addersOf(db, order, shown.map((entry) => entry.file))
  for (const entry of shown) entry.view = { ...entry.view, addedBy: adders.get(entry.file.id) ?? null }

  // ---- a thread attachment: the message of the order's thread it came with ----------------------------------------------
  const orderFiles = shown.filter((entry) => entry.file.recordType === 'SalesOrder').map((entry) => entry.file.id)
  if (orderFiles.length > 0 && mayOnThread(actor, THREADS_READ, 'SalesOrder', { companyId: order.companyId, siteId: null, partyId: order.partyId })) {
    const thread = await db.thread.findFirst({ where: { recordType: 'SalesOrder', recordId: order.id }, select: { id: true } })
    const messages = thread ? await db.message.findMany({ where: { threadId: thread.id, attachmentFileIds: { hasSome: orderFiles } }, select: { id: true, attachmentFileIds: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }] }) : []
    const messageOf = new Map<string, string>()
    for (const message of messages) for (const fileId of message.attachmentFileIds) if (!messageOf.has(fileId)) messageOf.set(fileId, message.id)
    for (const entry of shown) {
      const messageId = messageOf.get(entry.file.id)
      if (messageId) entry.view = { ...entry.view, inThread: { messageId } } as OrderFile
    }
  }

  // ---- copies: one file per content, "also on …" walled (review BW-1) -----------------------------------------------------
  const folded = await foldCopies(db, actor, order, shown, files, nodes, scopeOf)
  for (const entry of folded) groups.get(entry.group)!.files.push(entry)

  // ---- the newest worksheet of each made-to-measure line's profile revision (the measurements right only) ----------------
  const profileOfLine = new Map<string, string>()
  for (const cell of cells) if (cell.salesOrderLineId && cell.measurementProfileId) profileOfLine.set(cell.salesOrderLineId, cell.measurementProfileId)
  for (const line of lines) if (line.measurementProfileId && !profileOfLine.has(line.id)) profileOfLine.set(line.id, line.measurementProfileId)
  const profileIds = unique(profileOfLine.values())
  if (profileIds.length > 0) {
    const sheets = await db.generatedDocument.findMany({ where: { recordType: PROFILE_RECORD, recordId: { in: profileIds }, kind: WORKSHEET_KIND }, select: { id: true, recordId: true, version: true, number: true, language: true, createdAt: true }, orderBy: [{ version: 'desc' }, { id: 'asc' }] })
    const newest = new Map<string, (typeof sheets)[number]>()
    for (const sheet of sheets) if (!newest.has(sheet.recordId)) newest.set(sheet.recordId, sheet)
    const linesGroup = groups.get('LINES')!
    for (const line of lines) {
      const profileId = profileOfLine.get(line.id)
      const sheet = profileId ? newest.get(profileId) : undefined
      if (!profileId || !sheet) continue
      if (!can(actor, SALES_MEASUREMENTS_VIEW, scope)) {
        linesGroup.measurementsLeftOut += 1
        continue
      }
      linesGroup.worksheets.push({ documentId: sheet.id, profileId, line: { id: line.id, seq: line.seq }, version: sheet.version, number: sheet.number, language: sheet.language, createdAt: sheet.createdAt })
    }
  }

  return {
    order: { id: order.id, number: order.number, companyId: order.companyId, partyId: order.partyId },
    groups: ORDER_FILE_GROUPS.map((key) => groups.get(key)!),
    openable: new Map(shown.map((entry) => [entry.file.id, entry.view])),
    truncated,
    held, // B-OF-002
  }
}

// ── B-PT-013 (order production tab R13): the customer's tech pack ──
/**
 * The tech pack of the inquiry this order came from (null: none, or — fail closed — an inquiry of another customer or company
 * linked by mistake): each file named at its version in force (`files`: that version's id → the mark), the inquiry's number for
 * the cards ("From INQ-0042"), and whether the reader reads inquiries of this order's customer (else its files are only counted).
 */
async function techPackOfOrder(db: Db, actor: Actor, order: OrderRow): Promise<{ label: string; mayRead: boolean; files: Map<string, TechPackMark> } | null> {
  const inquiry = await inquiryOfOrder(db, order)
  if (!inquiry || inquiry.partyId !== order.partyId || inquiry.companyId !== order.companyId) return null
  const files = new Map<string, TechPackMark>()
  for (const entry of (await techPackOf(db, inquiry)).files) if (entry.current) files.set(entry.current.id, { named: entry.named.versionNo, inForce: true, newer: entry.newer })
  return { label: inquiry.number, mayRead: can(actor, SALES_INQUIRIES_VIEW, { companyId: order.companyId, partyId: order.partyId }), files }
}
// ── end B-PT-013 ──

// ── B-OP-050 (order page plan N7): who added a file ──
/**
 * Who added each file: its `createdById` (an office upload names its person; a user of a partner is this order's customer, by its
 * name, or nobody named); with none, the file's own audit rows (a portal or link upload records the party's session on the file:
 * this order's customer, by its name) and its sharing (a floor device's upload is shared with the office and that floor: "the
 * floor", never the worker); else null (a document the system made). Nothing names another customer.
 */
async function addersOf(db: Db, order: Pick<OrderRow, 'partyId'>, files: readonly FileRow[]): Promise<Map<string, AddedBy | null>> {
  const out = new Map<string, AddedBy | null>()
  if (files.length === 0) return out
  const userIds = unique(files.flatMap((file) => (file.createdById ? [file.createdById] : [])))
  const users = new Map((userIds.length > 0 ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true, partyId: true } }) : []).map((user) => [user.id, user]))
  const nobody = files.filter((file) => file.createdById === null).map((file) => file.id)
  const outside = nobody.length > 0 ? await db.auditLog.findMany({ where: { recordType: 'StoredFile', recordId: { in: nobody }, audience: { in: ['PARTNER', 'LINK', 'FLOOR'] } }, select: { recordId: true, audience: true, partyId: true } }) : []
  let customer: string | null | undefined
  const customerOf = async (): Promise<AddedBy | null> => {
    if (customer === undefined) {
      const party = await db.party.findUnique({ where: { id: order.partyId }, select: { legalName: true, tradeName: true } })
      customer = party ? (party.tradeName ?? party.legalName) : null
    }
    return customer ? { kind: 'CUSTOMER', name: customer } : null
  }
  for (const file of files) {
    if (file.createdById) {
      const user = users.get(file.createdById)
      out.set(file.id, !user ? null : user.partyId === null ? { kind: 'PERSON', name: user.displayName } : user.partyId === order.partyId ? await customerOf() : null)
      continue
    }
    const rows = outside.filter((row) => row.recordId === file.id)
    const shared = new Set(file.visibility)
    if (rows.some((row) => (row.audience === 'PARTNER' || row.audience === 'LINK') && row.partyId === order.partyId)) out.set(file.id, await customerOf())
    else if (rows.some((row) => row.audience === 'FLOOR') || (shared.has('OFFICE') && shared.has('FLOOR') && !shared.has('PARTNER') && !shared.has('LINK'))) out.set(file.id, { kind: 'FLOOR', name: null })
    else out.set(file.id, null)
  }
  return out
}
// ── end B-OP-050 ──

/**
 * One file per content: a copy (B-TH-024 Use on, a module's prepareFileCopy) and its source are one document. Of the order's
 * shown files of one content, the first by group (then newest) is listed; the records of the others, and of every copy of the
 * same content outside this order, are its "also on …" — named only when the record names THIS order's customer and the reader
 * reaches it (the office's file rule), else counted (`alsoOnOther`). A copy chain is followed as the content wall follows it
 * (at most MAX_COPY_HOPS up; copies two levels down).
 */
async function foldCopies(
  db: Db,
  actor: Actor,
  order: Pick<OrderRow, 'partyId'>,
  shown: readonly { readonly file: FileRow; view: OrderFile }[],
  orderFiles: readonly FileRow[],
  chains: ReadonlyMap<string, Node>,
  scopeOf: (type: string, recordId: string) => Promise<FileRecordScope>,
): Promise<OrderFile[]> {
  const nodes = new Map<string, Node>(chains)
  let parents = [...nodes.keys()]
  for (let level = 0; level < 2 && parents.length > 0; level++) {
    const rows = (await db.storedFile.findMany({ where: { sourceFileId: { in: parents }, status: 'AVAILABLE' }, select: NODE })) as Node[]
    parents = rows.filter((row) => !nodes.has(row.id)).map((row) => row.id)
    for (const row of rows) nodes.set(row.id, row)
  }
  const rootOf = (fileId: string): string => {
    let at = fileId
    const seen = new Set<string>()
    for (;;) {
      const next = nodes.get(at)?.sourceFileId
      if (!next || !nodes.has(next) || seen.has(next)) return at
      seen.add(at)
      at = next
    }
  }
  const families = new Map<string, Node[]>()
  for (const node of nodes.values()) families.set(rootOf(node.id), [...(families.get(rootOf(node.id)) ?? []), node])

  const shownIds = new Set(shown.map((entry) => entry.file.id))
  const groupRank = (group: OrderFileGroup) => ORDER_FILE_GROUPS.indexOf(group)
  const listed: OrderFile[] = []
  const done = new Set<string>()
  for (const entry of shown) {
    if (done.has(entry.file.id)) continue
    const family = families.get(rootOf(entry.file.id)) ?? []
    const mine = shown.filter((other) => family.some((node) => node.id === other.file.id)).sort((a, b) => groupRank(a.view.group) - groupRank(b.view.group) || b.view.at.getTime() - a.view.at.getTime())
    for (const member of mine) done.add(member.file.id)
    const primary = mine[0] ?? entry
    const named = new Map<string, RecordRef>()
    let other = 0
    const ownRecord = keyOf(primary.view.from.type, primary.view.from.id)
    for (const member of mine.slice(1)) {
      const key = keyOf(member.view.from.type, member.view.from.id)
      if (key !== ownRecord) named.set(key, member.view.from)
    }
    const counted = new Set<string>()
    for (const node of family) {
      if (shownIds.has(node.id) || node.status !== 'AVAILABLE') continue
      const key = keyOf(node.recordType, node.recordId)
      if (key === ownRecord || named.has(key) || counted.has(key)) continue
      // Not one of the order's files shown to this reader: named only for a record of this order's customer it reaches.
      const found = await scopeOf(node.recordType, node.recordId)
      if (reachesFileRecord(actor, FILES_READ, found, node.companyId) && fileRecordParty(found) === order.partyId && !orderFiles.some((file) => file.id === node.id && !shownIds.has(file.id))) {
        named.set(key, { type: node.recordType, id: node.recordId, label: (await recordLabelOf(db, node.recordType, node.recordId)) ?? '' })
      } else {
        counted.add(key)
        other += 1
      }
    }
    listed.push({ ...primary.view, alsoOn: [...named.values()], alsoOnOther: other })
  }
  return listed
}

// ---- the answer ---------------------------------------------------------------------------------------------------------------

const words = output({ it: z.string(), en: z.string() })
const recordRef = output({ type: z.string(), id: id(), label: z.string() })
// B-OF-003: the record a file hangs on, + its paper's state and a DDT's shipment.
// of-fx5s (W-12): + the shipment's day shipped and its live DDT's number.
const fromRef = recordRef.extend({ state: z.enum(FILE_STATES).nullable(), shipment: output({ id: id(), label: z.string(), shippedOn: businessDay().nullable(), ddtNumber: z.string().nullable() }).nullable() })

export const orderFileView = output({
  id: id(),
  name: z.string(),
  kind: z.string(),
  category: z.string().nullable(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  versionNo: z.number().int(),
  at: instant(),
  /** The record it hangs on (an order line for a quote line's artwork: it travels with the line); B-OF-003: its state, a DDT's shipment. */
  from: fromRef,
  line: output({ id: id(), seq: z.number().int() }).nullable(),
  /** "Shared with the customer" (this order's customer) or "Office only". */
  audience: z.enum(FILE_AUDIENCES),
  /** A measurement sheet or a body photo (listed only with the measurements right; each opening recorded). */
  bodyData: z.boolean(),
  /** The other records the same content sits on that are this order's customer's and the reader reaches. */
  alsoOn: z.array(recordRef),
  /** Any other record it sits on: counted, never named ("also on 1 other record"). */
  alsoOnOther: z.number().int(),
  /** It came with a message of the order's thread ("Open in thread"). */
  inThread: output({ messageId: id() }).nullable(),
  /**
   * B-OP-050: who added it — PERSON: an office person (`name`); FLOOR: a floor device (no name: never a worker); CUSTOMER: this order's
   * customer (`name`). Null: the system's own document, or not known.
   */
  addedBy: output({ kind: z.enum(ADDED_BY_KINDS), name: z.string().nullable() }).nullable(),
  /**
   * B-PT-013: a file of the customer's tech pack (the TECH_PACK group) — the version the request named, shown at its version in force,
   * and whether that one is newer than the request ("Newer than the request"); null: any other file.
   */
  techPack: output({ named: z.number().int(), inForce: z.literal(true), newer: z.boolean() }).nullable(),
  // B-OF-033: the ask this file was sent for (arrived or accepted; null: none).
  askId: id().nullable(),
  // ---- B-OF-001 (S3): the version every act sends; the series and how many versions it keeps; what keeps it (a legal hold, a
  // retention date); a fiscal paper (never a version, never deleted); a paper Nexus made (never deleted) and whether it shows our
  // prices by its kind (its mark stays); priced; who TRULY sees it (CUSTOMER only for this order's customer and content).
  version: z.number().int(),
  seriesId: id().nullable(),
  versions: z.number().int(),
  kept: output({ legalHold: z.boolean(), retainUntil: instant().nullable() }),
  fiscal: z.boolean(),
  made: z.enum(MADE_PAPERS).nullable(),
  bornPriced: notMoney(z.boolean()),
  priced: notMoney(z.boolean()),
  audiences: z.array(z.enum(TRUE_AUDIENCES)),
  // ---- end B-OF-001
})

export const orderFilesContract = defineContract({
  params: input({ orderId: id() }),
  response: {
    200: output({
      order: output({ id: id(), number: z.string() }),
      groups: z.array(
        output({
          key: z.enum(ORDER_FILE_GROUPS),
          words,
          files: z.array(orderFileView),
          /** The newest MTM worksheet of each made-to-measure line (opened by the made-to-measure route). */
          worksheets: z.array(output({ documentId: id(), profileId: id(), line: output({ id: id(), seq: z.number().int() }), version: z.number().int(), number: z.string().nullable(), language: z.string(), createdAt: instant() })),
          /** Files the reader may not open (its rights, a work order of several customers): counted, never named. */
          leftOut: z.number().int(),
          /** Body data and worksheets without the measurements right: counted, never named. */
          measurementsLeftOut: z.number().int(),
          /** B-CP-023: documents that show prices, for a reader who does not see prices: counted, never named ("N priced documents"). */
          pricedLeftOut: notMoney(z.number().int()),
          /** B-OF-002: files of this group the virus scan holds (or an upload left pending): counted. */
          heldCount: z.number().int(),
        }),
      ),
      /** B-OF-002: the reader's own held uploads on the order or its lines (a card each; never opened, never previewed). */
      held: z.array(output({ id: id(), name: z.string(), group: z.enum(ORDER_FILE_GROUPS), at: instant(), reason: z.enum(HELD_REASONS) })),
      /** B-OF-001: what the reader may do over THIS order's scope (its company and customer). */
      may: output({ upload: z.boolean(), delete: z.boolean(), share: z.boolean(), ask: z.boolean(), askCustomer: z.boolean() }),
      /** How many files are listed (a count, not money). */
      total: notMoney(z.number().int()),
      /** More than `cap` files: the newest `cap` are read. */
      truncated: z.boolean(),
      cap: z.number().int(),
      // ---- B-OF-033 (order files tab; 13-backend §2): the asks for files ("Waiting for files"), those the reader does not reach
      // (counted), and the order's open requests to its customer for a document.
      asks: z.array(askView),
      asksLeftOut: z.number().int(),
      customerAsks: z.array(customerAskView),
      // ---- end B-OF-033
    }),
  },
})

/** GET /sales/orders/:orderId/files (no party id, no address: a file opens through its own route). */
export async function orderFiles(caller: CommandCaller, orderId: string) {
  const read = await readOfficeOrderFiles(caller, orderId)
  // ---- B-OF-033: the order's asks for this reader (one query per kind), and the ask each file was sent for.
  const context = officeContextOf(caller)
  const asked = await caller.withClient((db) => orderAsksOf(db, actorOf(context), context.actorId, read.order, serverClock.now()))
  // ---- end B-OF-033
  // ---- B-OF-001: per shown file, how many versions its series keeps and whether Nexus made it (one query each for the shown ids).
  const shownFiles = read.groups.flatMap((group) => group.files)
  const facts = await caller.withClient(async (db) => {
    const roots = [...new Set(shownFiles.map((file) => file.seriesId ?? file.id))]
    const kept = roots.length === 0 ? [] : await db.storedFile.findMany({ where: { status: { not: 'DELETED' }, OR: [{ id: { in: roots } }, { seriesId: { in: roots } }] }, select: { id: true, seriesId: true } })
    const versions = new Map<string, number>()
    for (const row of kept) versions.set(row.seriesId ?? row.id, (versions.get(row.seriesId ?? row.id) ?? 0) + 1)
    return { versions, made: await madePapersOf(db, shownFiles.map((file) => file.id)) }
  })
  const actor = actorOf(context)
  const orderScope = { companyId: read.order.companyId, partyId: read.order.partyId }
  const may = {
    upload: can(actor, FILES_UPLOAD, orderScope),
    delete: can(actor, FILES_DELETE, orderScope),
    share: can(actor, FILES_MANAGE, orderScope),
    ask: mayKeepAsks(actor, read.order, true),
    askCustomer: can(actor, 'partners.tasks.manage' as Permission, orderScope),
  }
  // ---- end B-OF-001
  const groups = read.groups.map((group) => ({
    key: group.key,
    words: ORDER_FILE_GROUP_WORDS[group.key],
    files: group.files.map(({ companyId: _companyId, group: _group, at, kept, ...file }) => ({
      ...file,
      at: toUtcIso(at),
      askId: asked.askOfFile.get(file.id) ?? null /* B-OF-033 */,
      // B-OF-001
      kept: { legalHold: kept.legalHold, retainUntil: kept.retainUntil ? toUtcIso(kept.retainUntil) : null },
      versions: facts.versions.get(file.seriesId ?? file.id) ?? 1,
      made: facts.made.get(file.id)?.made ?? null,
      bornPriced: facts.made.get(file.id)?.bornPriced ?? false,
    })),
    worksheets: group.worksheets.map(({ createdAt, ...sheet }) => ({ ...sheet, createdAt: toUtcIso(createdAt) })),
    leftOut: group.leftOut,
    measurementsLeftOut: group.measurementsLeftOut,
    pricedLeftOut: group.pricedLeftOut, // B-CP-023
    heldCount: group.heldCount, // B-OF-002
  }))
  return {
    order: { id: read.order.id, number: read.order.number },
    groups,
    total: groups.reduce((sum, group) => sum + group.files.length, 0),
    truncated: read.truncated,
    cap: ORDER_FILES_CAP,
    held: read.held.map((file) => ({ ...file, at: toUtcIso(file.at) })), // B-OF-002
    may, // B-OF-001
    asks: asked.asks, // B-OF-033
    asksLeftOut: asked.asksLeftOut, // B-OF-033
    customerAsks: asked.customerAsks, // B-OF-033
  }
}
