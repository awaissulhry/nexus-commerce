import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { CASE_LIMITS } from '@nexus/factory-domain/sales/portal-returns/rules'
import type { CommandTx } from '../../../core/command'

/**
 * The reads of returns and complaints for the people outside (B-W2b-192). Every read here runs in the tenant's office-role
 * scope — as the portal person (officeAuth.inTenant) or as the tenant's system for a claim link — and EVERY query names the
 * party and the company the session is bound to. (Since wave 23 the partner role may read its own party's RMAs, lines and
 * complaints without their hidden columns, B-W2b-F12; these views stay in the office scope because they also read what the
 * partner role reads none of: sites, receipts, credit notes, reasons, calendars, CAPAs.) Each select names its columns and never one the
 * customer must not read: no internal note, no owner, no triage (category, severity), no findings or root cause, no price,
 * credit value, cause or office person. One query at a time (one connection runs one query at a time).
 */

export type Reader = FactoryClient | CommandTx

export const RETURN_RECORD = 'ReturnAuthorisation'
export const LINE_RECORD = 'ReturnLine'
export const COMPLAINT_RECORD = 'Complaint'

export const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
export const dayOrNull = (value: Date | null): BusinessDate | null => (value ? dayOf(value) : null)
export const isoOrNull = (value: Date | null): string | null => (value ? toUtcIso(value) : null)

/** Where a session reads: the portal's company (or the link's) and the party it is bound to. */
export interface Place {
  readonly companyId: string
  readonly partyId: string
}

export const CASE_RMA = {
  id: true,
  companyId: true,
  siteId: true,
  partyId: true,
  number: true,
  customerRef: true,
  salesOrderId: true,
  status: true,
  requestedAt: true,
  authorisedAt: true,
  goodsDueBy: true,
  receivedAt: true,
  inspectedAt: true,
  replacementOrderId: true,
  closedAt: true,
  statusReason: true,
  // B-W2b-F13b (wave 23): how the request came, what the customer would like and their words (partner-visible columns).
  channel: true,
  outcomeWanted: true,
  customerNote: true,
  version: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.ReturnAuthorisationSelect
export type CaseRma = Prisma.ReturnAuthorisationGetPayload<{ select: typeof CASE_RMA }>

export const CASE_LINE = {
  id: true,
  returnId: true,
  seq: true,
  salesOrderLineId: true,
  size: true,
  invoiceLineId: true,
  description: true,
  serial: true,
  quantity: true,
  reasonCode: true,
  reasonNote: true,
  receivedQuantity: true,
  grade: true,
  disposition: true,
  decidedAt: true,
} as const satisfies Prisma.ReturnLineSelect
export type CaseLine = Prisma.ReturnLineGetPayload<{ select: typeof CASE_LINE }>

export const CASE_COMPLAINT = {
  id: true,
  companyId: true,
  partyId: true,
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
  answerDueOn: true,
  answeredAt: true,
  answeredVia: true,
  answerDocumentId: true,
  closedAt: true,
  version: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.ComplaintSelect
export type CaseComplaint = Prisma.ComplaintGetPayload<{ select: typeof CASE_COMPLAINT }>

export const readReturns = (db: Reader, place: Place): Promise<CaseRma[]> =>
  db.returnAuthorisation.findMany({ where: { companyId: place.companyId, partyId: place.partyId }, select: CASE_RMA, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], take: CASE_LIMITS.list })

export const readComplaints = (db: Reader, place: Place): Promise<CaseComplaint[]> =>
  db.complaint.findMany({ where: { companyId: place.companyId, partyId: place.partyId }, select: CASE_COMPLAINT, orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], take: CASE_LIMITS.list })

/** One return of the party in the company, or null (another party's is as unknown as a wrong id). */
export async function readReturn(db: Reader, place: Place, returnId: string): Promise<CaseRma | null> {
  if (!isUuid(returnId)) return null
  const row = await db.returnAuthorisation.findUnique({ where: { id: returnId }, select: CASE_RMA })
  return row && row.companyId === place.companyId && row.partyId === place.partyId ? row : null
}

export async function readComplaint(db: Reader, place: Place, complaintId: string): Promise<CaseComplaint | null> {
  if (!isUuid(complaintId)) return null
  const row = await db.complaint.findUnique({ where: { id: complaintId }, select: CASE_COMPLAINT })
  return row && row.companyId === place.companyId && row.partyId === place.partyId ? row : null
}

export const readLines = (db: Reader, returnIds: readonly string[]): Promise<CaseLine[]> =>
  returnIds.length === 0 ? Promise.resolve([]) : db.returnLine.findMany({ where: { returnId: { in: [...returnIds] } }, select: CASE_LINE, orderBy: [{ returnId: 'asc' }, { seq: 'asc' }] })

/** The records (type:id) of the party that hold an OPEN request of ours (a partner task): "Waiting for you". */
export async function openTasksOn(db: Reader, partyId: string, records: readonly { readonly type: string; readonly id: string }[]): Promise<Set<string>> {
  if (records.length === 0) return new Set()
  const rows = await db.partnerTask.findMany({
    where: { partyId, status: 'OPEN', recordId: { in: [...new Set(records.map((record) => record.id))] }, recordType: { in: [...new Set(records.map((record) => record.type))] } },
    select: { recordType: true, recordId: true },
  })
  return new Set(rows.map((row) => `${row.recordType}:${row.recordId}`))
}

export const SHARED_FILE = { id: true, recordType: true, recordId: true, kind: true, originalName: true, contentType: true, sizeBytes: true, sourceFileId: true, createdAt: true, visibility: true } as const satisfies Prisma.StoredFileSelect
export type SharedFile = Prisma.StoredFileGetPayload<{ select: typeof SHARED_FILE }>

/** The files of these records the party is shown (AVAILABLE, shared with its portal or its links), newest first. */
export async function sharedFilesOf(db: Reader, partyId: string, records: readonly { readonly type: string; readonly id: string }[]): Promise<SharedFile[]> {
  if (records.length === 0) return []
  const rows = await db.storedFile.findMany({
    where: {
      partyId,
      status: 'AVAILABLE',
      supersededAt: null,
      recordId: { in: [...new Set(records.map((record) => record.id))] },
      recordType: { in: [...new Set(records.map((record) => record.type))] },
      OR: [{ visibility: { has: 'PARTNER' } }, { visibility: { has: 'LINK' } }],
    },
    select: SHARED_FILE,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 500,
  })
  const wanted = new Set(records.map((record) => `${record.type}:${record.id}`))
  return rows.filter((row) => wanted.has(`${row.recordType}:${row.recordId}`))
}

/** A credit note that credits lines of a return (issued: not a draft, not one SDI rejected): its number, day and PDF. */
export interface CreditNoteRef {
  readonly id: string
  readonly number: string | null
  readonly issueDate: BusinessDate | null
  readonly pdfFileId: string | null
}

export async function creditNotesOf(db: Reader, lineIds: readonly string[]): Promise<CreditNoteRef[]> {
  if (lineIds.length === 0) return []
  const lines = await db.invoiceLine.findMany({ where: { returnLineId: { in: [...lineIds] } }, select: { invoiceId: true } })
  if (lines.length === 0) return []
  const rows = await db.invoice.findMany({
    where: { id: { in: [...new Set(lines.map((line) => line.invoiceId))] }, docType: 'TD04', status: { notIn: ['DRAFT', 'REJECTED'] } },
    select: { id: true, number: true, issueDate: true, pdfFileId: true },
    orderBy: [{ issueDate: 'asc' }, { id: 'asc' }],
  })
  return rows.map((row) => ({ id: row.id, number: row.number, issueDate: dayOrNull(row.issueDate), pdfFileId: row.pdfFileId }))
}

/** The CAPA (or 8D) a complaint was escalated to, the newest not cancelled; null when none. */
export interface ComplaintCapa {
  readonly id: string
  readonly number: string
  readonly type: 'CAPA' | 'EIGHT_D'
  readonly status: string
  readonly createdAt: Date
  readonly closedAt: Date | null
}

export async function capasOf(db: Reader, complaintIds: readonly string[]): Promise<Map<string, ComplaintCapa>> {
  if (complaintIds.length === 0) return new Map()
  const sources = await db.capaSource.findMany({ where: { recordType: COMPLAINT_RECORD, recordId: { in: [...complaintIds] } }, select: { capaId: true, recordId: true } })
  if (sources.length === 0) return new Map()
  const capas = await db.capa.findMany({ where: { id: { in: [...new Set(sources.map((row) => row.capaId))] }, status: { not: 'CANCELLED' } }, select: { id: true, number: true, type: true, status: true, createdAt: true, closedAt: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  const byId = new Map(capas.map((row) => [row.id, row]))
  const found = new Map<string, ComplaintCapa>()
  for (const capa of capas) {
    for (const source of sources) if (source.capaId === capa.id && !found.has(source.recordId) && byId.has(capa.id)) found.set(source.recordId, { ...capa, type: capa.type as ComplaintCapa['type'] })
  }
  return found
}

/** The day each stage of a CAPA was first reached (its audit rows; the first stage on its opening day). */
export async function stagesReachedOf(db: Reader, capa: ComplaintCapa): Promise<Map<string, BusinessDate>> {
  const rows = await db.auditLog.findMany({ where: { recordType: 'Capa', recordId: capa.id }, select: { at: true, after: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }] })
  const reached = new Map<string, BusinessDate>()
  for (const row of rows) {
    const status = (row.after as Record<string, unknown> | null)?.status
    if (typeof status === 'string' && !reached.has(status)) reached.set(status, dayOf(row.at))
  }
  if (capa.closedAt && !reached.has('CLOSED')) reached.set('CLOSED', dayOf(capa.closedAt))
  return reached
}

/** The customer's portal is on (PortalSettings.portalOn, the Owner's per-partner switch). */
export async function portalOnFor(db: Reader, partyId: string): Promise<boolean> {
  const row = await db.portalSettings.findFirst({ where: { partyId }, select: { portalOn: true } })
  return row?.portalOn === true
}
