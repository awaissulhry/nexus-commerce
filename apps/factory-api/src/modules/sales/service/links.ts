import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, type Actor, type Permission } from '@nexus/factory-domain/core/permissions'
import { INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { QUALITY_COMPLAINTS_VIEW } from '@nexus/factory-domain/quality/complaints/permissions'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { SALES_REPAIRS_VIEW } from '@nexus/factory-domain/sales/repairs/permissions'
import { SALES_RETURNS_VIEW } from '@nexus/factory-domain/sales/returns/permissions'
import { SALES_SERVICE_MANAGE } from '@nexus/factory-domain/sales/service/permissions'
import { CASE_LIMITS, LINK_RECORD_TYPES, linkNoteProblems, SERVICE_CASE_LINK_RECORD, SERVICE_CASE_RECORD, type LinkRecordType, type LinkVia } from '@nexus/factory-domain/sales/service/rules'
import { SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { officeCase } from './access'
import { lockCase, touchCase, type CaseRow, type Reader } from './store'

/**
 * The records a case led to or is about (B-W2b-345; design case.linked "RecordChain of every linked record": order, garment
 * serial, dealer, RMA, repair, remake, credit note): ServiceCaseLink rows by record type + id, while the case is not
 * CLOSED (the …_service_safety_w2b_guards trigger holds that and the shapes; one link per record and case is the API's).
 *
 *   read     every link with its record's number and status for a reader of that record (its own view permission over its
 *            company, site and customer); a record the reader may not open shows as "a <type> you may not open"
 *   link     POST /sales/service/cases/:caseId/links {version, recordType, recordId, note?}: a record of the case's company
 *            (and of its customer, when both name one) the person may see; the types of LINK_RECORD_TYPES
 *   unlink   DELETE /sales/service/cases/:caseId/links/:linkId?version=
 *   actions  `linkInCommand` (the repair, return, remake or credit a case's action opens, ./actions.ts)
 * Each is ONE command with the case's row locked at the version the screen read, its version moved on, an audit row on the
 * link and on the case, and service_case.linked.
 */

export interface LinkedRecord {
  readonly id: string
  readonly companyId: string
  readonly siteId: string | null
  readonly partyId: string | null
  readonly label: string
  readonly status: string | null
}

interface LinkReader {
  readonly permission: Permission
  read(db: Reader, ids: readonly string[]): Promise<LinkedRecord[]>
}

const LINK_READERS: Readonly<Record<LinkRecordType, LinkReader>> = Object.freeze({
  SalesOrder: {
    permission: ORDERS_VIEW,
    read: async (db, ids) => (await db.salesOrder.findMany({ where: { id: { in: [...ids] } }, select: { id: true, companyId: true, partyId: true, number: true, status: true } })).map((row) => ({ id: row.id, companyId: row.companyId, siteId: null, partyId: row.partyId, label: row.number, status: row.status })),
  },
  Shipment: {
    permission: SHIPPING_VIEW,
    read: async (db, ids) => (await db.shipment.findMany({ where: { id: { in: [...ids] } }, select: { id: true, companyId: true, siteId: true, partyId: true, number: true, status: true } })).map((row) => ({ id: row.id, companyId: row.companyId, siteId: row.siteId, partyId: row.partyId, label: row.number, status: row.status })),
  },
  ReturnAuthorisation: {
    permission: SALES_RETURNS_VIEW,
    read: async (db, ids) => (await db.returnAuthorisation.findMany({ where: { id: { in: [...ids] } }, select: { id: true, companyId: true, siteId: true, partyId: true, number: true, status: true } })).map((row) => ({ id: row.id, companyId: row.companyId, siteId: row.siteId, partyId: row.partyId, label: row.number, status: row.status })),
  },
  RepairOrder: {
    permission: SALES_REPAIRS_VIEW,
    read: async (db, ids) => (await db.repairOrder.findMany({ where: { id: { in: [...ids] } }, select: { id: true, companyId: true, siteId: true, partyId: true, number: true, stage: true } })).map((row) => ({ id: row.id, companyId: row.companyId, siteId: row.siteId, partyId: row.partyId, label: row.number, status: row.stage })),
  },
  Invoice: {
    permission: INVOICES_VIEW,
    read: async (db, ids) => (await db.invoice.findMany({ where: { id: { in: [...ids] } }, select: { id: true, companyId: true, buyerPartyId: true, number: true, status: true } })).map((row) => ({ id: row.id, companyId: row.companyId, siteId: null, partyId: row.buyerPartyId, label: row.number ?? 'Draft invoice', status: row.status })),
  },
  Complaint: {
    permission: QUALITY_COMPLAINTS_VIEW,
    read: async (db, ids) => (await db.complaint.findMany({ where: { id: { in: [...ids] } }, select: { id: true, companyId: true, partyId: true, number: true, status: true } })).map((row) => ({ id: row.id, companyId: row.companyId, siteId: null, partyId: row.partyId, label: row.number, status: row.status })),
  },
  WorkOrder: {
    permission: WORKORDERS_VIEW,
    read: async (db, ids) => (await db.workOrder.findMany({ where: { id: { in: [...ids] } }, select: { id: true, companyId: true, siteId: true, number: true, status: true } })).map((row) => ({ id: row.id, companyId: row.companyId, siteId: row.siteId, partyId: null, label: row.number, status: row.status })),
  },
})

const scopeOfRecord = (record: LinkedRecord) => ({ companyId: record.companyId, ...(record.siteId ? { siteId: record.siteId } : {}), ...(record.partyId ? { partyId: record.partyId } : {}) })
export const maySeeRecord = (actor: Actor, type: LinkRecordType, record: LinkedRecord): boolean => can(actor, LINK_READERS[type].permission, scopeOfRecord(record))

/** One linked record as the reader may see it (contract linkView). */
export interface LinkView {
  readonly id: string
  readonly recordType: string
  readonly recordId: string
  readonly note: string | null
  readonly createdAt: string
  readonly createdById: string | null
  /** The record's number and status, for a reader of it; null: a record the reader may not open (or gone). */
  readonly record: { readonly label: string; readonly status: string | null } | null
}

/** Every link of a case, oldest first, each with what its reader may see of the record. */
export async function linksOf(db: Reader, caseId: string, actor: Actor): Promise<LinkView[]> {
  const links = await db.serviceCaseLink.findMany({ where: { caseId }, select: { id: true, recordType: true, recordId: true, note: true, createdAt: true, createdById: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const seen = new Map<string, LinkedRecord>()
  for (const type of LINK_RECORD_TYPES) {
    const ids = links.filter((link) => link.recordType === type).map((link) => link.recordId)
    if (ids.length === 0) continue
    for (const record of await LINK_READERS[type].read(db, ids)) if (maySeeRecord(actor, type, record)) seen.set(`${type}:${record.id}`, record)
  }
  return links.map((link) => {
    const record = seen.get(`${link.recordType}:${link.recordId}`)
    return { id: link.id, recordType: link.recordType, recordId: link.recordId, note: link.note, createdAt: toUtcIso(link.createdAt), createdById: link.createdById, record: record ? { label: record.label, status: record.status } : null }
  })
}

/** The record a link would name, checked against the case: of its company (and customer), seen by the person. */
export async function linkableRecord(db: Reader, actor: Actor, row: Pick<CaseRow, 'companyId' | 'partyId'>, type: LinkRecordType, recordId: string): Promise<LinkedRecord> {
  const [record] = isUuid(recordId) ? await LINK_READERS[type].read(db, [recordId]) : []
  if (!record || !maySeeRecord(actor, type, record)) throw new ValidationError('Not a record you can link.', [{ path: 'body/recordId', message: `Not a ${type} you may see.` }])
  if (record.companyId !== row.companyId) throw new ValidationError('A record of the case’s company.', [{ path: 'body/recordId', message: `${record.label} is of another company.` }])
  if (row.partyId && record.partyId && record.partyId !== row.partyId) throw new ValidationError('A record of the case’s customer.', [{ path: 'body/recordId', message: `${record.label} is of another customer.` }])
  return record
}

/** Writes one link inside the caller's command (the case's row locked and touched by the caller), with its audit row and event. */
export async function linkInCommand(tools: CommandTools, row: Pick<CaseRow, 'id' | 'number' | 'companyId'>, link: { readonly recordType: string; readonly recordId: string; readonly note: string | null; readonly via: LinkVia }): Promise<string> {
  const { tx, now, context } = tools
  const already = await tx.serviceCaseLink.findFirst({ where: { caseId: row.id, recordType: link.recordType, recordId: link.recordId }, select: { id: true } })
  if (already) throw new ConflictError(`This record is linked to case ${row.number} already.`)
  if ((await tx.serviceCaseLink.count({ where: { caseId: row.id } })) >= CASE_LIMITS.links) throw new ConflictError(`Case ${row.number} has ${CASE_LIMITS.links} links: unlink one first.`)
  const id = newId()
  const createdById = context.audience === 'office' ? context.actorId : null
  await tx.serviceCaseLink.create({ data: { id, caseId: row.id, recordType: link.recordType, recordId: link.recordId, note: link.note, createdAt: now, createdById }, select: { id: true } })
  tools.audit({ recordType: SERVICE_CASE_LINK_RECORD, recordId: id, companyId: row.companyId, after: { caseId: row.id, recordType: link.recordType, recordId: link.recordId, note: link.note, via: link.via } })
  tools.emit({ type: 'service_case.linked', subject: row.id, companyId: row.companyId, payload: { caseId: row.id, number: row.number, linkId: id, recordType: link.recordType, recordId: link.recordId, change: 'LINKED', via: link.via } })
  return id
}

/** POST /sales/service/cases/:caseId/links */
export async function linkToCase(caller: CommandCaller, caseId: string, body: { readonly version: number; readonly recordType: LinkRecordType; readonly recordId: string; readonly note?: string | null | undefined }, idempotencyKey?: string): Promise<{ caseId: string }> {
  const { context, row: seen } = await officeCase(caller, caseId, SALES_SERVICE_MANAGE)
  const problems = linkNoteProblems(body.note)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  await command(caller, { name: 'serviceCases.link', idempotencyKey, input: { caseId, ...body } }, async (tools) => {
    const row = await lockCase(tools, seen.id, body.version)
    await linkableRecord(tools.tx, actorOf(context), row, body.recordType, body.recordId)
    const note = body.note?.trim() ? body.note.trim() : null
    await linkInCommand(tools, row, { recordType: body.recordType, recordId: body.recordId, note, via: 'LINK' })
    const after = await touchCase(tools, row)
    tools.audit({ action: 'serviceCases.link', recordType: SERVICE_CASE_RECORD, recordId: row.id, companyId: row.companyId, before: { version: row.version }, after: { version: after.version, linked: { recordType: body.recordType, recordId: body.recordId } } })
    return null
  })
  return { caseId: seen.id }
}

/** DELETE /sales/service/cases/:caseId/links/:linkId?version= */
export async function unlinkFromCase(caller: CommandCaller, caseId: string, linkId: string, query: { readonly version: number }, idempotencyKey?: string): Promise<{ caseId: string }> {
  const { row: seen } = await officeCase(caller, caseId, SALES_SERVICE_MANAGE)
  await command(caller, { name: 'serviceCases.unlink', idempotencyKey, input: { caseId, linkId, ...query } }, async (tools) => {
    const { tx } = tools
    const row = await lockCase(tools, seen.id, query.version)
    const link = isUuid(linkId) ? await tx.serviceCaseLink.findFirst({ where: { id: linkId, caseId: row.id }, select: { id: true, recordType: true, recordId: true, note: true } }) : null
    if (!link) throw new NotFoundError('Link not found.')
    await tx.serviceCaseLink.delete({ where: { id: link.id } })
    tools.audit({ recordType: SERVICE_CASE_LINK_RECORD, recordId: link.id, companyId: row.companyId, before: { caseId: row.id, recordType: link.recordType, recordId: link.recordId, note: link.note } })
    const after = await touchCase(tools, row)
    tools.audit({ action: 'serviceCases.unlink', recordType: SERVICE_CASE_RECORD, recordId: row.id, companyId: row.companyId, before: { version: row.version }, after: { version: after.version, unlinked: { recordType: link.recordType, recordId: link.recordId } } })
    tools.emit({ type: 'service_case.linked', subject: row.id, companyId: row.companyId, payload: { caseId: row.id, number: row.number, linkId: link.id, recordType: link.recordType, recordId: link.recordId, change: 'UNLINKED', via: 'LINK' } })
    return null
  })
  return { caseId: seen.id }
}
