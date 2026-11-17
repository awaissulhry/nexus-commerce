import type { FastifyRequest } from 'fastify'
import type { FactoryClient } from '@nexus/factory-db'
import { THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import type { PartnerKind } from '@nexus/factory-domain/auth/partners/kinds'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { recordTypeWordsOf, stateWordsOf, type Words } from '@nexus/factory-domain/threads/summary'
import type { CommandCaller, CommandTx } from '../../core/command'
import { actorOf } from '../../core/context'
import { kindsOfSession, partnerCallerOf, partnerReaderOf, type PartnerCaller } from '../search/partner/session'
import type { PartnerReader, PartnerRecord } from '../search/partner/view'
import { partnerViewOf, viewFits } from '../search/partner/views'
import { recordLabelOf } from './labels'
import { mayOnThread, resolveRecord, THREAD_RECORDS } from './records'
import { contextOf, officeRecord, type RecordRef } from './threads'

/**
 * B-TH-076 (threads plan TH-6, X-G01; design PL5 "the summary row", O-REC-ANY.summary-F01, P-ANY.summary; walls W09, W34): one
 * summary row for ANY record that has a thread, for the record frame of every record page —
 *
 *   GET /records/<type>/<id>/summary   its type in words ("Delivery note"), its label (labels.ts: "DDT-2026-0042"), its state code and
 *                                      the state in words, and its parent record as a link (a delivery's order, a receipt's PO)
 *
 * Read in the reader's own scope, as the record's thread is:
 *   office   the record must be one whose thread the person may read (threads.read and its type's gate over the record's company,
 *            site and party: officeRecord + mayOnThread): else 404, the same words as a record that does not exist. The parent is
 *            named only when the person may open IT too (the same check over the parent's scope); else the summary has no link
 *            (an unknown parent is never guessed: X-G01).
 *   portal   through the record type's PARTNER VIEW only (search/partner/views: the party's own record of a kind the person's portal
 *            shows, in the state the partner knows it in, threads.read over it): another customer's record, a type no portal shows,
 *            a record not yet sent — 404 in neutral words, never "it belongs to someone else". The state is the one the partner
 *            view gives; the parent is read in the tenant scope for a record ALREADY opened and then named only when its own partner
 *            view opens it for this person (a delivery's order of the same customer), else none.
 *
 * Each record type names its summary reader here, beside its thread resolver (records.ts THREAD_RECORDS): its state column and its
 * parent. A type without a reader (a test's made-up type) still has its type words and label, and no state or parent.
 */

type Reader = FactoryClient | CommandTx

/** What a record's summary reader answers: its state code (null: it has none) and its parent (null: none). */
export interface SummaryFacts {
  readonly state: string | null
  readonly parent: RecordRef | null
}
export type SummaryReader = (client: Reader, recordId: string) => Promise<SummaryFacts | null>

const ref = (type: string, id: string | null | undefined): RecordRef | null => (id ? { type, id } : null)
const facts = (state: string | null | undefined, parent: RecordRef | null = null): SummaryFacts => ({ state: state ?? null, parent })

/** The summary reader of each record type that has a thread (records.ts THREAD_RECORDS): its state and its parent. */
export const SUMMARY_READERS: Readonly<Record<string, SummaryReader>> = Object.freeze({
  Company: async (client, id) => {
    const row = await client.company.findUnique({ where: { id }, select: { status: true } })
    return row ? facts(row.status) : null
  },
  Site: async (client, id) => {
    const row = await client.site.findUnique({ where: { id }, select: { status: true, companyId: true } })
    return row ? facts(row.status, ref('Company', row.companyId)) : null
  },
  Party: async (client, id) => {
    const row = await client.party.findUnique({ where: { id }, select: { status: true } })
    return row ? facts(row.status) : null
  },
  User: async (client, id) => {
    const row = await client.user.findUnique({ where: { id }, select: { status: true } })
    return row ? facts(row.status) : null
  },
  Role: async (client, id) => {
    const row = await client.role.findUnique({ where: { id }, select: { archivedAt: true } })
    return row ? facts(row.archivedAt ? 'ARCHIVED' : 'ACTIVE') : null
  },
  Device: async (client, id) => {
    const row = await client.device.findUnique({ where: { id }, select: { status: true, siteId: true } })
    return row ? facts(row.status, ref('Site', row.siteId)) : null
  },
  Worker: async (client, id) => {
    const row = await client.worker.findUnique({ where: { id }, select: { status: true, siteId: true } })
    return row ? facts(row.status, ref('Site', row.siteId)) : null
  },
  IntegrationAccount: async (client, id) => {
    const row = await client.integrationAccount.findUnique({ where: { id }, select: { status: true } })
    return row ? facts(row.status) : null
  },
  Certificate: async (client, id) => {
    const row = await client.certificate.findUnique({ where: { id }, select: { status: true } })
    return row ? facts(row.status) : null
  },
  Style: async (client, id) => {
    const row = await client.style.findUnique({ where: { id }, select: { status: true } })
    return row ? facts(row.status) : null
  },
  Invoice: async (client, id) => {
    const row = await client.invoice.findUnique({ where: { id }, select: { status: true, salesOrderId: true } })
    return row ? facts(row.status, ref('SalesOrder', row.salesOrderId)) : null
  },
  PaymentReminder: async (client, id) => {
    const row = await client.paymentReminder.findUnique({ where: { id }, select: { status: true } })
    return row ? facts(row.status) : null
  },
  // A quote's parent is the request it was made from (Inquiry.quoteId names it once).
  Quote: async (client, id) => {
    const row = await client.quote.findUnique({ where: { id }, select: { status: true } })
    if (!row) return null
    const request = await client.inquiry.findFirst({ where: { quoteId: id }, select: { id: true } })
    return facts(row.status, ref('Inquiry', request?.id))
  },
  PriceList: async (client, id) => {
    const row = await client.priceList.findUnique({ where: { id }, select: { status: true } })
    return row ? facts(row.status) : null
  },
  PurchaseOrder: async (client, id) => {
    const row = await client.purchaseOrder.findUnique({ where: { id }, select: { status: true } })
    return row ? facts(row.status) : null
  },
  SubcontractOrder: async (client, id) => {
    const row = await client.subcontractOrder.findUnique({ where: { id }, select: { status: true, workOrderId: true } })
    return row ? facts(row.status, ref('WorkOrder', row.workOrderId)) : null
  },
  SupplierClaim: async (client, id) => {
    const row = await client.supplierClaim.findUnique({ where: { id }, select: { status: true, purchaseOrderId: true, goodsReceiptId: true } })
    return row ? facts(row.status, ref('PurchaseOrder', row.purchaseOrderId) ?? ref('GoodsReceipt', row.goodsReceiptId)) : null
  },
  SupplierInvoice: async (client, id) => {
    const row = await client.supplierInvoice.findUnique({ where: { id }, select: { status: true } })
    return row ? facts(row.status) : null
  },
  // An order's parent: the quote it was accepted from, else the request or the catalogue order it was made from.
  SalesOrder: async (client, id) => {
    const row = await client.salesOrder.findUnique({ where: { id }, select: { status: true, quoteVersionId: true } })
    if (!row) return null
    const version = row.quoteVersionId ? await client.quoteVersion.findUnique({ where: { id: row.quoteVersionId }, select: { quoteId: true } }) : null
    if (version) return facts(row.status, ref('Quote', version.quoteId))
    const request = await client.inquiry.findFirst({ where: { salesOrderId: id }, select: { id: true } })
    if (request) return facts(row.status, ref('Inquiry', request.id))
    const catalogue = await client.portalOrderRequest.findFirst({ where: { salesOrderId: id }, select: { id: true } })
    return facts(row.status, ref('PortalOrderRequest', catalogue?.id))
  },
  OrderChangeRequest: async (client, id) => {
    const row = await client.orderChangeRequest.findUnique({ where: { id }, select: { status: true, orderId: true } })
    return row ? facts(row.status, ref('SalesOrder', row.orderId)) : null
  },
  WorkOrder: async (client, id) => {
    const row = await client.workOrder.findUnique({ where: { id }, select: { status: true } })
    return row ? facts(row.status) : null
  },
  Shipment: async (client, id) => {
    const row = await client.shipment.findUnique({ where: { id }, select: { status: true, salesOrderId: true } })
    return row ? facts(row.status, ref('SalesOrder', row.salesOrderId)) : null
  },
  PpeRegisterEntry: async (client, id) => {
    const row = await client.ppeRegisterEntry.findUnique({ where: { id }, select: { status: true, styleId: true } })
    return row ? facts(row.status, ref('Style', row.styleId)) : null
  },
  DistributorNotice: async (client, id) => {
    const row = await client.distributorNotice.findUnique({ where: { id }, select: { status: true, registerEntryId: true } })
    return row ? facts(row.status, ref('PpeRegisterEntry', row.registerEntryId)) : null
  },
  Lot: async (client, id) => {
    const row = await client.lot.findUnique({ where: { id }, select: { qualityStatus: true } })
    return row ? facts(row.qualityStatus) : null
  },
  GoodsReceipt: async (client, id) => {
    const row = await client.goodsReceipt.findUnique({ where: { id }, select: { status: true, purchaseOrderId: true } })
    return row ? facts(row.status, ref('PurchaseOrder', row.purchaseOrderId)) : null
  },
  QualityHold: async (client, id) => {
    const row = await client.qualityHold.findUnique({ where: { id }, select: { status: true } })
    return row ? facts(row.status) : null
  },
  Nonconformance: async (client, id) => {
    const row = await client.nonconformance.findUnique({ where: { id }, select: { stage: true } })
    return row ? facts(row.stage) : null
  },
  Machine: async (client, id) => {
    const row = await client.machine.findUnique({ where: { id }, select: { status: true } })
    return row ? facts(row.status) : null
  },
  MaintenanceRequest: async (client, id) => {
    const row = await client.maintenanceRequest.findUnique({ where: { id }, select: { status: true, machineId: true } })
    return row ? facts(row.status, ref('Machine', row.machineId)) : null
  },
  MaintenanceJob: async (client, id) => {
    const row = await client.maintenanceJob.findUnique({ where: { id }, select: { status: true, machineId: true } })
    return row ? facts(row.status, ref('Machine', row.machineId)) : null
  },
  ReturnAuthorisation: async (client, id) => {
    const row = await client.returnAuthorisation.findUnique({ where: { id }, select: { status: true, salesOrderId: true } })
    return row ? facts(row.status, ref('SalesOrder', row.salesOrderId)) : null
  },
  // A repair's parent: the complaint it came from, else the return whose line it came from.
  RepairOrder: async (client, id) => {
    const row = await client.repairOrder.findUnique({ where: { id }, select: { stage: true, complaintId: true, returnLineId: true } })
    if (!row) return null
    if (row.complaintId) return facts(row.stage, ref('Complaint', row.complaintId))
    const line = row.returnLineId ? await client.returnLine.findUnique({ where: { id: row.returnLineId }, select: { returnId: true } }) : null
    return facts(row.stage, ref('ReturnAuthorisation', line?.returnId))
  },
  Complaint: async (client, id) => {
    const row = await client.complaint.findUnique({ where: { id }, select: { status: true, salesOrderId: true } })
    return row ? facts(row.status, ref('SalesOrder', row.salesOrderId)) : null
  },
  StockCount: async (client, id) => {
    const row = await client.stockCount.findUnique({ where: { id }, select: { status: true } })
    return row ? facts(row.status) : null
  },
  // A delivery note has no status column: ISSUED, or CANCELLED once a cancellation names it. Its parent: its shipment, else the
  // record it was issued for (a subcontract, a supplier claim, a repair, a return).
  Ddt: async (client, id) => {
    const row = await client.ddt.findUnique({ where: { id }, select: { shipmentId: true, sourceType: true, sourceId: true, _count: { select: { cancellations: true } } } })
    if (!row) return null
    const parent = ref('Shipment', row.shipmentId) ?? (row.sourceType && Object.hasOwn(THREAD_RECORDS, row.sourceType) ? ref(row.sourceType, row.sourceId) : null)
    return facts(row._count.cancellations > 0 ? 'CANCELLED' : 'ISSUED', parent)
  },
  Team: async (client, id) => {
    const row = await client.team.findUnique({ where: { id }, select: { status: true } })
    return row ? facts(row.status) : null
  },
  Capa: async (client, id) => {
    const row = await client.capa.findUnique({ where: { id }, select: { status: true } })
    return row ? facts(row.status) : null
  },
  // A request to approve (outside) and a request for a yes (inside): the record they are about.
  ApprovalRequest: async (client, id) => {
    const row = await client.approvalRequest.findUnique({ where: { id }, select: { status: true, recordType: true, recordId: true } })
    return row ? facts(row.status, row.recordType !== 'ApprovalRequest' && Object.hasOwn(THREAD_RECORDS, row.recordType) ? ref(row.recordType, row.recordId) : null) : null
  },
  ChangeRequest: async (client, id) => {
    const row = await client.changeRequest.findUnique({ where: { id }, select: { status: true, styleId: true } })
    return row ? facts(row.status, ref('Style', row.styleId)) : null
  },
  ChangeOrder: async (client, id) => {
    const row = await client.changeOrder.findUnique({ where: { id }, select: { status: true, styleId: true } })
    return row ? facts(row.status, ref('Style', row.styleId)) : null
  },
  SampleRound: async (client, id) => {
    const row = await client.sampleRound.findUnique({ where: { id }, select: { stage: true, styleId: true } })
    return row ? facts(row.stage, ref('Style', row.styleId)) : null
  },
  ApprovalTask: async (client, id) => {
    const row = await client.approvalTask.findUnique({ where: { id }, select: { status: true, recordType: true, recordId: true } })
    return row ? facts(row.status, row.recordType !== 'ApprovalTask' && Object.hasOwn(THREAD_RECORDS, row.recordType) ? ref(row.recordType, row.recordId) : null) : null
  },
  Inquiry: async (client, id) => {
    const row = await client.inquiry.findUnique({ where: { id }, select: { status: true } })
    return row ? facts(row.status) : null
  },
  ServiceCase: async (client, id) => {
    const row = await client.serviceCase.findUnique({ where: { id }, select: { status: true } })
    return row ? facts(row.status) : null
  },
  ProductSafetyReport: async (client, id) => {
    const row = await client.productSafetyReport.findUnique({ where: { id }, select: { status: true } })
    return row ? facts(row.status) : null
  },
  // A rider's measurements: no state; its customer (body data: the label names the garment type only, labels.ts).
  MeasurementProfile: async (client, id) => {
    const row = await client.measurementProfile.findUnique({ where: { id }, select: { partyId: true } })
    return row ? facts(null, ref('Party', row.partyId)) : null
  },
  PortalOrderRequest: async (client, id) => {
    const row = await client.portalOrderRequest.findUnique({ where: { id }, select: { status: true } })
    return row ? facts(row.status) : null
  },
  TechnicalFile: async (client, id) => {
    const row = await client.technicalFile.findUnique({ where: { id }, select: { status: true, styleId: true } })
    return row ? facts(row.status, ref('Style', row.styleId)) : null
  },
  Project: async (client, id) => {
    const row = await client.project.findUnique({ where: { id }, select: { status: true } })
    return row ? facts(row.status) : null
  },
})

/** The record types with a summary reader (every thread type: record-summary.pg.vitest.test.ts holds it). */
export const SUMMARIZED_TYPES: ReadonlySet<string> = new Set(Object.keys(SUMMARY_READERS))

const readerOf = (recordType: string): SummaryReader | undefined => (Object.hasOwn(SUMMARY_READERS, recordType) ? SUMMARY_READERS[recordType] : undefined)

export interface SummaryLink {
  readonly recordType: string
  readonly recordId: string
  readonly type: Words
  readonly label: string | null
}

export interface RecordSummary extends SummaryLink {
  /** The partner's own reference (their PO number), for a portal reader; null in the office answer and when they gave none. */
  readonly theirRef: string | null
  readonly state: { readonly code: string; readonly words: Words } | null
  readonly parent: SummaryLink | null
  // ---- follow-up (th9-web-b): the record's party — the customer or supplier its shared messages reach — for an OFFICE reader only, so
  // the docked thread offers "Reply to <party>" before the first message (the thread, and so its party, exists only after one). The
  // portal answer never carries it (absent): a portal reader is told nothing it does not already own (brand wall).
  readonly party?: { readonly id: string; readonly name: string } | null
  // ---- end follow-up
}

const stateOf = (code: string | null): RecordSummary['state'] => (code ? { code, words: stateWordsOf(code) } : null)

/** GET /records/<type>/<id>/summary: the office's or the portal's summary row (see the module's head). */
export async function readRecordSummary(caller: CommandCaller, record: RecordRef): Promise<{ summary: RecordSummary }> {
  const context = contextOf(caller)
  if (context.audience === 'partner') return { summary: await partnerSummary(caller as unknown as FastifyRequest, record) }
  if (context.audience !== 'office') throw new ForbiddenError()
  const actor = actorOf(context)
  return caller.withClient(async (client) => {
    const { scope, thread } = await officeRecord(client, record)
    if (!mayOnThread(actor, THREADS_READ, record.type, scope)) throw new NotFoundError('Record not found.')
    // ---- follow-up (th9-web-b): the party a reply reaches — the thread's when it exists, else the one it will be made with (the record's
    // own party; none for a record never shared: officeRecord already leaves a work order's, hold's or NCR's wall party out).
    const partyId = thread ? thread.partyId : scope.partyId
    const partyRow = partyId ? await client.party.findUnique({ where: { id: partyId }, select: { id: true, legalName: true, tradeName: true } }) : null
    // ---- end follow-up
    const reader = readerOf(record.type)
    const read = reader ? await reader(client, record.id) : null
    let parent: SummaryLink | null = null
    if (read?.parent && isUuid(read.parent.id)) {
      // The parent only when the person may open it too (its own scope; a work order's, hold's or NCR's through its wall party).
      const parentScope = await resolveRecord(client, read.parent.type, read.parent.id)
      if (parentScope && mayOnThread(actor, THREADS_READ, read.parent.type, parentScope)) {
        parent = { recordType: read.parent.type, recordId: read.parent.id, type: recordTypeWordsOf(read.parent.type), label: await recordLabelOf(client, read.parent.type, read.parent.id) }
      }
    }
    return {
      summary: {
        recordType: record.type,
        recordId: record.id,
        type: recordTypeWordsOf(record.type),
        label: await recordLabelOf(client, record.type, record.id),
        theirRef: null,
        state: stateOf(read?.state ?? null),
        parent,
        party: partyRow ? { id: partyRow.id, name: partyRow.tradeName ?? partyRow.legalName } : null, // follow-up (th9-web-b): office only
      },
    }
  })
}

/** The record through its partner view, as the portal's thread opens it (its view, the person's kinds, threads.read), or null. */
async function openForPartner(client: FactoryClient, caller: PartnerCaller, kinds: readonly PartnerKind[], reader: PartnerReader, record: RecordRef): Promise<PartnerRecord | null> {
  const view = partnerViewOf(record.type)
  if (!view || !viewFits(view, kinds) || !isUuid(record.id)) return null
  const [found] = await view.read(client, [record.id], reader)
  if (!found || !can(caller.actor, THREADS_READ, { companyId: found.companyId, partyId: caller.context.partyId })) return null
  return found
}

const partnerLabel = (record: PartnerRecord): string | null => record.ourRef ?? record.theirRef

/** The portal's summary row: through the partner views only (see the module's head). */
async function partnerSummary(request: FastifyRequest, record: RecordRef): Promise<RecordSummary> {
  const caller = partnerCallerOf(request)
  const reader = partnerReaderOf(request, caller)
  return request.withClient(async (client) => {
    const kinds = await kindsOfSession(client, caller)
    const opened = await openForPartner(client, caller, kinds, reader, record)
    if (!opened) throw new NotFoundError('Record not found.')
    // The parent's id of a record this person has opened (the tenant scope: the partner role may not read the column), then the
    // parent itself only through ITS partner view for this person.
    const summarize = readerOf(record.type)
    const read = summarize ? await reader.inTenant((db) => summarize(db, record.id)) : null
    const parentRecord = read?.parent ? await openForPartner(client, caller, kinds, reader, read.parent) : null
    return {
      recordType: record.type,
      recordId: record.id,
      type: recordTypeWordsOf(record.type),
      label: partnerLabel(opened),
      theirRef: opened.theirRef,
      state: stateOf(opened.status),
      parent: parentRecord && read?.parent ? { recordType: read.parent.type, recordId: parentRecord.id, type: recordTypeWordsOf(read.parent.type), label: partnerLabel(parentRecord) } : null,
    }
  })
}
