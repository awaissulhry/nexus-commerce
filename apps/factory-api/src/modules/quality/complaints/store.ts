import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { can, holds } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { REGISTER_MANAGE, REGISTER_VIEW } from '@nexus/factory-domain/compliance/register/permissions'
import { isDocumentLanguage, type DocumentLanguage } from '@nexus/factory-domain/documents/model'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { QUALITY_CAPA_VIEW } from '@nexus/factory-domain/quality/capa/permissions'
import type { CapaStatus, CapaType } from '@nexus/factory-domain/quality/capa/rules'
import { isAnswerTemplate, type AnswerVia } from '@nexus/factory-domain/quality/complaints/answer'
import { QUALITY_NCR_RAISE, QUALITY_NCR_VIEW } from '@nexus/factory-domain/quality/ncr/permissions'
import {
  ANSWER_WORKING_DAYS,
  COMPLAINT_RECORD,
  complaintActions,
  evidenceOf,
  isFinal,
  safetyStateOf,
  statusWords,
  type ComplaintAction,
  type ComplaintStatus,
} from '@nexus/factory-domain/quality/complaints/rules'
import { QUALITY_COMPLAINTS_ACKNOWLEDGE, QUALITY_COMPLAINTS_LOG, QUALITY_COMPLAINTS_MANAGE } from '@nexus/factory-domain/quality/complaints/permissions'
import { SALES_REPAIRS_MANAGE, SALES_REPAIRS_VIEW } from '@nexus/factory-domain/sales/repairs/permissions'
import { StaleVersionError, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { addWorkingDaysFor } from '../../../platform/calendars/service'
import { readEntryBySource } from '../../compliance/register/store'
import { CAPA_COLUMNS } from '../capa/store'

/**
 * The reads and the one row write of a complaint (B-W2a-65): its row, the rows the list and the record show (the
 * customer, the order with its value by the price grain, the shipment, the return, the style, our garment the serial
 * names, the PPE register entry whose source it is, its NCRs and repairs; B-W2b-113: the CAPA it is escalated to — read with
 * the CAPA module's columns, shown to a reader of that CAPA — its investigation and its answer letter), and the version
 * bump every change takes.
 * Every read names its columns and runs one after another on the client it is given (a command's transaction or a
 * scoped client: row-level security decides what it finds). No worker's name: office people by id, names in `people`.
 */

export type Reader = FactoryClient | CommandTx

export const COMPLAINT_COLUMNS = {
  id: true,
  companyId: true,
  partyId: true,
  contactId: true,
  number: true,
  customerRef: true,
  channel: true,
  receivedAt: true,
  description: true,
  salesOrderId: true,
  shipmentId: true,
  returnId: true,
  styleId: true,
  size: true,
  serial: true,
  batchNumber: true,
  status: true,
  category: true,
  severity: true,
  ownerId: true,
  answerDueOn: true,
  triagedAt: true,
  triagedById: true,
  safetyRaisedAt: true,
  safetyAcknowledgedAt: true,
  safetyAcknowledgedById: true,
  answeredAt: true,
  closedAt: true,
  closeReason: true,
  internalNote: true,
  version: true,
  createdAt: true,
  createdById: true,
  // B-W2b-113 (QHS-116): the investigation and the answer letter.
  findings: true,
  rootCause: true,
  answerTemplate: true,
  answerLanguage: true,
  answerText: true,
  answerFileIds: true,
  answerDocumentId: true,
  answeredById: true,
  answeredVia: true,
} as const satisfies Prisma.ComplaintSelect

export type ComplaintRow = Prisma.ComplaintGetPayload<{ select: typeof COMPLAINT_COLUMNS }>

export const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
export const asDay = (value: BusinessDate): Date => new Date(`${value}T00:00:00.000Z`)
const iso = (value: Date | null): string | null => (value ? toUtcIso(value) : null)

export async function readComplaint(db: Reader, complaintId: string): Promise<ComplaintRow | null> {
  return db.complaint.findUnique({ where: { id: complaintId }, select: COMPLAINT_COLUMNS })
}

/** command()'s record guard by hand: the complaint's row FOR UPDATE, not closed, at the version the caller read. */
export async function lockComplaint(tools: Pick<CommandTools, 'tx'>, complaintId: string, expectedVersion: number | undefined): Promise<ComplaintRow> {
  const [locked] = await tools.tx.$queryRaw<{ version: number; status: ComplaintStatus; number: string }[]>`SELECT "version", "status"::text AS "status", "number" FROM "Complaint" WHERE "id" = ${complaintId}::uuid FOR UPDATE`
  if (!locked) throw new NotFoundError('Complaint not found.')
  if (isFinal(locked.status)) throw new InvalidStateError(`Complaint ${locked.number} is ${statusWords(locked.status)}: it changes no more.`)
  if (expectedVersion !== undefined && locked.version !== expectedVersion) throw new StaleVersionError(COMPLAINT_RECORD, complaintId, locked.version, expectedVersion)
  return (await readComplaint(tools.tx, complaintId))!
}

/** Writes the complaint with its version moved on (every change of it). */
export async function touchComplaint(tools: Pick<CommandTools, 'tx' | 'now'>, complaint: Pick<ComplaintRow, 'id'>, data: Prisma.ComplaintUncheckedUpdateInput = {}): Promise<ComplaintRow> {
  return tools.tx.complaint.update({ where: { id: complaint.id }, data: { ...data, updatedAt: tools.now, version: { increment: 1 } }, select: COMPLAINT_COLUMNS })
}

/** The first line of the customer's words, short (the list, the banner, a notification). */
export function summaryOf(description: string, max = 120): string {
  const first = description.trim().split(/\r?\n/)[0] ?? ''
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first
}

export async function peopleOf(db: Reader, ids: readonly (string | null | undefined)[]): Promise<{ id: string; name: string }[]> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string'))]
  if (wanted.length === 0) return []
  return (await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true }, orderBy: { id: 'asc' } })).map((row) => ({ id: row.id, name: row.displayName }))
}

/** Our garment with this serial (as read from its label): its style, size, batch, the shipment it left on, its customer. */
export interface GarmentFacts {
  readonly serial: string
  readonly styleId: string
  readonly size: string
  readonly partyId: string | null
  readonly companyId: string
  readonly salesOrderId: string | null
  readonly madeOn: BusinessDate
  readonly workOrderNumber: string
  readonly batchNumber: string | null
  readonly shipment: { readonly id: string; readonly number: string; readonly partyId: string; readonly companyId: string; readonly salesOrderId: string | null } | null
}

export async function garmentOf(db: Reader, serial: string | null | undefined): Promise<GarmentFacts | null> {
  const wanted = (serial ?? '').trim()
  if (wanted === '') return null
  const row = await db.garmentSerial.findFirst({
    where: { serial: wanted },
    select: {
      serial: true,
      createdAt: true,
      workOrderSize: { select: { styleId: true, size: true, partyId: true, salesOrderLine: { select: { orderId: true } }, workOrder: { select: { number: true, batchNumber: true, companyId: true } } } },
      shipmentLine: { select: { shipment: { select: { id: true, number: true, partyId: true, companyId: true, status: true, salesOrderId: true } } } },
    },
  })
  if (!row) return null
  const cell = row.workOrderSize
  const shipment = row.shipmentLine?.shipment ?? null
  return {
    serial: row.serial,
    styleId: cell.styleId,
    size: cell.size,
    partyId: cell.partyId,
    companyId: cell.workOrder.companyId,
    // B-W2b-275: a SAMPLE cell may name no order line.
    salesOrderId: cell.salesOrderLine?.orderId ?? null,
    madeOn: businessDate(row.createdAt),
    workOrderNumber: cell.workOrder.number,
    batchNumber: cell.workOrder.batchNumber,
    // Only a shipment that left with it (a DRAFT or PACKED one may still change).
    shipment: shipment && (shipment.status === 'SHIPPED' || shipment.status === 'DELIVERED' || shipment.status === 'RETURNED') ? { id: shipment.id, number: shipment.number, partyId: shipment.partyId, companyId: shipment.companyId, salesOrderId: shipment.salesOrderId } : null,
  }
}

const unique = <T>(values: readonly (T | null | undefined)[]): T[] => [...new Set(values.filter((value): value is T => value !== null && value !== undefined))]
const byId = <T extends { id: string }>(list: readonly T[]) => new Map(list.map((row) => [row.id, row]))

/** What every row of a page names, read once per page (the list, the record). */
export async function rowFacts(db: Reader, rows: readonly ComplaintRow[], context: OfficeContext) {
  const actor = actorOf(context)
  const parties = rows.length ? await db.party.findMany({ where: { id: { in: unique(rows.map((row) => row.partyId)) } }, select: { id: true, code: true, legalName: true } }) : []
  const orderIds = unique(rows.map((row) => row.salesOrderId))
  const orders = orderIds.length ? await db.salesOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, number: true, status: true, currency: true, netAmount: true } }) : []
  const shipmentIds = unique(rows.map((row) => row.shipmentId))
  const shipments = shipmentIds.length ? await db.shipment.findMany({ where: { id: { in: shipmentIds } }, select: { id: true, number: true, status: true } }) : []
  const returnIds = unique(rows.map((row) => row.returnId))
  const returns = returnIds.length ? await db.returnAuthorisation.findMany({ where: { id: { in: returnIds } }, select: { id: true, number: true, status: true } }) : []
  const styleIds = unique(rows.map((row) => row.styleId))
  const styles = styleIds.length ? await db.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, name: true, ppeCategory: true } }) : []
  const ids = rows.map((row) => row.id)
  // The register entries whose source is one of them (the register's own link), for a reader of the register.
  const entries =
    ids.length && holds(actor, REGISTER_VIEW)
      ? await db.ppeRegisterEntry.findMany({ where: { sourceType: COMPLAINT_RECORD, sourceId: { in: ids } }, select: { id: true, reference: true, status: true, risk: true, sourceId: true, companyId: true } })
      : []
  // The NCRs raised from them or linked to them, for a reader of NCRs.
  const ncrsOf = new Map<string, { id: string; number: string; stage: string }[]>()
  if (ids.length && holds(actor, QUALITY_NCR_VIEW)) {
    const raised = await db.nonconformance.findMany({ where: { sourceType: COMPLAINT_RECORD, sourceId: { in: ids } }, select: { id: true, number: true, stage: true, sourceId: true, companyId: true, siteId: true } })
    const links = await db.ncrLink.findMany({ where: { recordType: COMPLAINT_RECORD, recordId: { in: ids } }, select: { recordId: true, ncr: { select: { id: true, number: true, stage: true, companyId: true, siteId: true } } } })
    const add = (complaintId: string, ncr: { id: string; number: string; stage: string; companyId: string; siteId: string }) => {
      if (!can(actor, QUALITY_NCR_VIEW, { companyId: ncr.companyId, siteId: ncr.siteId })) return
      const list = ncrsOf.get(complaintId) ?? []
      if (!list.some((seen) => seen.id === ncr.id)) list.push({ id: ncr.id, number: ncr.number, stage: ncr.stage })
      ncrsOf.set(complaintId, list)
    }
    for (const ncr of raised) if (ncr.sourceId) add(ncr.sourceId, ncr)
    for (const link of links) add(link.recordId, link.ncr)
    for (const list of ncrsOf.values()) list.sort((a, b) => a.number.localeCompare(b.number))
  }
  const [partyOf, orderOf, shipmentOf, returnOf, styleOf] = [byId(parties), byId(orders), byId(shipments), byId(returns), byId(styles)]
  const entryOf = new Map(entries.filter((entry) => can(actor, REGISTER_VIEW, { companyId: entry.companyId })).map((entry) => [entry.sourceId!, entry]))
  // B-W2b-113: the CAPA each one is escalated to (one CAPA not cancelled per record: B-W2b-108's rule), with the CAPA module's
  // columns; `capaSeen` keeps those the reader may see, `capaOf` every one (the record says "escalated elsewhere").
  const sources = ids.length ? await db.capaSource.findMany({ where: { recordType: COMPLAINT_RECORD, recordId: { in: ids } }, select: { capaId: true, recordId: true } }) : []
  const capas = sources.length ? await db.capa.findMany({ where: { id: { in: unique(sources.map((source) => source.capaId)) }, status: { not: 'CANCELLED' } }, select: CAPA_COLUMNS }) : []
  const capaById = byId(capas)
  const capaOf = new Map<string, (typeof capas)[number]>()
  for (const source of sources) {
    const capa = capaById.get(source.capaId)
    if (capa && !capaOf.has(source.recordId)) capaOf.set(source.recordId, capa)
  }
  const capaSeen = new Set([...capaOf.values()].filter((capa) => can(actor, QUALITY_CAPA_VIEW, { companyId: capa.companyId, ...(capa.customerId ? { partyId: capa.customerId } : {}) })).map((capa) => capa.id))
  return { partyOf, orderOf, shipmentOf, returnOf, styleOf, entryOf, ncrsOf, capaOf, capaSeen }
}

export type RowFacts = Awaited<ReturnType<typeof rowFacts>>

/** One list row (contract complaintRow). */
export function rowView(row: ComplaintRow, facts: RowFacts) {
  const order = row.salesOrderId ? facts.orderOf.get(row.salesOrderId) : undefined
  const shipment = row.shipmentId ? facts.shipmentOf.get(row.shipmentId) : undefined
  const rma = row.returnId ? facts.returnOf.get(row.returnId) : undefined
  const style = row.styleId ? facts.styleOf.get(row.styleId) : undefined
  const entry = facts.entryOf.get(row.id)
  const capa = facts.capaOf.get(row.id)
  return {
    id: row.id,
    number: row.number,
    companyId: row.companyId,
    status: row.status,
    channel: row.channel,
    receivedAt: toUtcIso(row.receivedAt),
    party: facts.partyOf.get(row.partyId)!,
    customerRef: row.customerRef,
    order: order ? { id: order.id, number: order.number, status: order.status, currency: order.currency, netAmount: asMoney('price', order.netAmount) } : null,
    shipment: shipment ? { id: shipment.id, number: shipment.number, status: shipment.status } : null,
    return: rma ? { id: rma.id, number: rma.number, status: rma.status } : null,
    style: style ? { id: style.id, code: style.code, name: style.name } : null,
    size: row.size,
    serial: row.serial,
    batchNumber: row.batchNumber,
    category: row.category,
    severity: row.severity,
    ownerId: row.ownerId,
    answerDueOn: row.answerDueOn ? dayOf(row.answerDueOn) : null,
    answeredAt: iso(row.answeredAt),
    safety: { state: safetyStateOf(row), raisedAt: iso(row.safetyRaisedAt), acknowledgedAt: iso(row.safetyAcknowledgedAt), acknowledgedById: row.safetyAcknowledgedById },
    register: entry ? { id: entry.id, reference: entry.reference, status: entry.status, risk: entry.risk } : null,
    ncrs: facts.ncrsOf.get(row.id) ?? [],
    capa: capa && facts.capaSeen.has(capa.id) ? { id: capa.id, number: capa.number, status: capa.status as CapaStatus } : null,
    summary: summaryOf(row.description),
  }
}

const scopeOf = (row: Pick<ComplaintRow, 'companyId' | 'partyId'>) => ({ companyId: row.companyId, partyId: row.partyId })

/** The answer due a triage suggests: ANSWER_WORKING_DAYS of the company's calendar after the day it came in. */
export async function suggestedAnswerDue(db: Reader, row: Pick<ComplaintRow, 'companyId' | 'receivedAt'>): Promise<BusinessDate | null> {
  try {
    return (await addWorkingDaysFor(db as never, { scope: 'COMPANY', id: row.companyId }, businessDate(row.receivedAt), ANSWER_WORKING_DAYS)).date
  } catch {
    return null
  }
}

/** GET /quality/complaints/:complaintId: everything the record's tabs show, read now. */
export async function complaintView(db: Reader, row: ComplaintRow, context: OfficeContext) {
  const actor = actorOf(context)
  const facts = await rowFacts(db, [row], context)
  const base = rowView(row, facts)
  const style = row.styleId ? facts.styleOf.get(row.styleId) : undefined
  const contact = row.contactId ? await db.partyContact.findUnique({ where: { id: row.contactId }, select: { id: true, name: true, email: true } }) : null
  const garment = await garmentOf(db, row.serial)
  const repairs =
    holds(actor, SALES_REPAIRS_VIEW)
      ? (await db.repairOrder.findMany({ where: { complaintId: row.id }, select: { id: true, number: true, stage: true, companyId: true, siteId: true, partyId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }))
          .filter((repair) => can(actor, SALES_REPAIRS_VIEW, { companyId: repair.companyId, siteId: repair.siteId, partyId: repair.partyId }))
          .map((repair) => ({ id: repair.id, number: repair.number, stage: repair.stage }))
      : []
  // Is it in the register (for the close and the register step), also for a reader who may not read the register?
  const inRegister = base.register !== null || (await readEntryBySource(db as never, COMPLAINT_RECORD, row.id)) !== null
  const scope = scopeOf(row)
  const status = row.status as ComplaintStatus
  const may: Record<ComplaintAction, boolean> = {
    edit: can(actor, status === 'NEW' ? QUALITY_COMPLAINTS_LOG : QUALITY_COMPLAINTS_MANAGE, scope),
    triage: can(actor, QUALITY_COMPLAINTS_MANAGE, scope),
    startInvestigation: can(actor, QUALITY_COMPLAINTS_MANAGE, scope),
    markAnswered: can(actor, QUALITY_COMPLAINTS_MANAGE, scope),
    reopenInvestigation: can(actor, QUALITY_COMPLAINTS_MANAGE, scope),
    close: can(actor, QUALITY_COMPLAINTS_MANAGE, scope),
    acknowledge: can(actor, QUALITY_COMPLAINTS_ACKNOWLEDGE, scope),
    register: can(actor, QUALITY_COMPLAINTS_MANAGE, scope) && can(actor, REGISTER_MANAGE, { companyId: row.companyId }),
    createNcr: holds(actor, QUALITY_NCR_RAISE),
    makeRepair: can(actor, SALES_REPAIRS_MANAGE, scope),
    investigate: can(actor, QUALITY_COMPLAINTS_MANAGE, scope),
    writeAnswer: can(actor, QUALITY_COMPLAINTS_MANAGE, scope),
    sendAnswer: can(actor, QUALITY_COMPLAINTS_MANAGE, scope),
  }
  const capa = facts.capaOf.get(row.id)
  const capaVisible = capa !== undefined && facts.capaSeen.has(capa.id)
  return {
    ...base,
    description: row.description,
    contact: contact ? { id: contact.id, name: contact.name, email: contact.email } : null,
    style: style ? { id: style.id, code: style.code, name: style.name, ppeCategory: style.ppeCategory } : null,
    garment: garment
      ? { madeOn: garment.madeOn, workOrderNumber: garment.workOrderNumber, batchNumber: garment.batchNumber, shipment: garment.shipment ? { id: garment.shipment.id, number: garment.shipment.number } : null, forThisCustomer: garment.partyId === null || garment.partyId === row.partyId }
      : null,
    triagedAt: iso(row.triagedAt),
    triagedById: row.triagedById,
    closedAt: iso(row.closedAt),
    closeReason: row.closeReason,
    internalNote: row.internalNote,
    createdAt: toUtcIso(row.createdAt),
    createdById: row.createdById,
    version: row.version,
    repairs,
    evidence: evidenceOf(row),
    suggestedAnswerDueOn: status === 'NEW' || row.answerDueOn === null ? await suggestedAnswerDue(db, row) : null,
    actions: complaintActions({ status, styleId: row.styleId, inRegister, safetyRaisedAt: row.safetyRaisedAt, safetyAcknowledgedAt: row.safetyAcknowledgedAt, may, answerText: row.answerText, answerLanguage: row.answerLanguage }),
    people: await peopleOf(db, [row.ownerId, row.triagedById, row.safetyAcknowledgedById, row.createdById, row.answeredById]),
    findings: row.findings,
    rootCause: row.rootCause,
    capaRecord: capa && capaVisible ? { id: capa.id, number: capa.number, title: capa.title, type: capa.type as CapaType, status: capa.status as CapaStatus } : null,
    capaElsewhere: capa !== undefined && !capaVisible,
    answer: await answerViewOf(db, row),
  }
}

/** B-W2b-113: the customer's language for the letter (theirs when Italian or English, else Italian). */
export async function customerLanguage(db: Reader, partyId: string): Promise<DocumentLanguage> {
  const party = await db.party.findUnique({ where: { id: partyId }, select: { language: true } })
  return party && isDocumentLanguage(party.language) ? party.language : 'it'
}

/** B-W2b-113 (contract answerView): the letter as written, its files (shared with the customer or not), the version sent. */
export async function answerViewOf(db: Reader, row: ComplaintRow) {
  const files = row.answerFileIds.length === 0 ? [] : await db.storedFile.findMany({ where: { id: { in: row.answerFileIds } }, select: { id: true, originalName: true, kind: true, status: true, visibility: true, partyId: true } })
  const fileOf = new Map(files.map((file) => [file.id, file]))
  const versions = await db.generatedDocument.findMany({ where: { recordType: COMPLAINT_RECORD, recordId: row.id, kind: 'COMPLAINT_ANSWER' }, select: { id: true, version: true, language: true, fileId: true, createdAt: true, createdById: true }, orderBy: { version: 'desc' } })
  const sent = row.answerDocumentId ? versions.find((version) => version.id === row.answerDocumentId) : undefined
  return {
    template: isAnswerTemplate(row.answerTemplate) ? row.answerTemplate : null,
    language: isDocumentLanguage(row.answerLanguage) ? row.answerLanguage : null,
    text: row.answerText,
    files: row.answerFileIds.map((id) => {
      const file = fileOf.get(id)
      return { id, originalName: file?.originalName ?? '', kind: file?.kind ?? 'DOCUMENT', status: file?.status ?? 'DELETED', shared: file !== undefined && file.visibility.includes('PARTNER') && file.partyId === row.partyId }
    }),
    sent: sent && row.answeredAt && row.answeredVia ? { documentId: sent.id, version: sent.version, language: sent.language, fileId: sent.fileId, at: toUtcIso(row.answeredAt), byId: row.answeredById, via: row.answeredVia as AnswerVia } : null,
    versions: versions.map((version) => ({ id: version.id, version: version.version, language: version.language, fileId: version.fileId, createdAt: toUtcIso(version.createdAt), createdById: version.createdById })),
    suggestedLanguage: await customerLanguage(db, row.partyId),
  }
}

export type ComplaintView = Awaited<ReturnType<typeof complaintView>>
