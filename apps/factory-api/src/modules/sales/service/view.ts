import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { SALES_REPAIRS_MANAGE } from '@nexus/factory-domain/sales/repairs/permissions'
import { SALES_RETURNS_MANAGE } from '@nexus/factory-domain/sales/returns/permissions'
import { SALES_SERVICE_DECIDE, SALES_SERVICE_MANAGE } from '@nexus/factory-domain/sales/service/permissions'
import { buyerOfParty, caseActions, remediesOf, SERVICE_CASE_RECORD, type CaseAction, type CaseKind, type CaseStatus, type Cover } from '@nexus/factory-domain/sales/service/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officeOf, scopeOfCase } from './access'
import { linksOf } from './links'
import { batchOf, checkOfRow, dayOrNull, deliveredOnOf, garmentOf, garmentSummary, iso, peopleOf, readCase, rowFacts, rowView, type CaseRow, type Reader } from './store'

/**
 * GET /sales/service/cases/:caseId: everything the record's tabs show (design "Service case": Case, Warranty check, Linked
 * records, Actions, Activity), read now. The Activity tab is the record's thread and timeline (platform/threads, record type
 * ServiceCase); the status mails sent to the customer are listed here too (SAL-436) as email out keeps them. No amount.
 */

/** The status mails (and any other mail) sent on the case's thread, newest first: what the customer was told and where each is. */
async function mailsOf(db: Reader, caseId: string) {
  const rows = await db.emailOutbound.findMany({
    where: { recordType: SERVICE_CASE_RECORD, recordId: caseId },
    select: { id: true, subject: true, status: true, to: true, queuedAt: true, sentAt: true, deliveredAt: true, failedAt: true, createdById: true },
    orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }],
    take: 50,
  })
  return rows.map((row) => ({ id: row.id, subject: row.subject, status: row.status, to: row.to, queuedAt: toUtcIso(row.queuedAt), sentAt: iso(row.sentAt), deliveredAt: iso(row.deliveredAt), failedAt: iso(row.failedAt), sentById: row.createdById }))
}

export async function caseView(db: Reader, row: CaseRow, context: OfficeContext, now: Date) {
  const actor = actorOf(context)
  const today = businessDate(now)
  const facts = await rowFacts(db, [row])
  const base = rowView(row, facts, today)
  const party = row.partyId ? await db.party.findUnique({ where: { id: row.partyId }, select: { id: true, code: true, legalName: true, kind: true, language: true } }) : null
  const contact = row.contactId ? await db.partyContact.findUnique({ where: { id: row.contactId }, select: { id: true, name: true, email: true, language: true, status: true, erasedAt: true } }) : null
  const style = row.styleId ? await db.style.findUnique({ where: { id: row.styleId }, select: { id: true, code: true, name: true, ppeCategory: true } }) : null
  const colourway = row.colourwayId ? await db.colourway.findUnique({ where: { id: row.colourwayId }, select: { id: true, code: true, name: true } }) : null
  const garment = await garmentOf(db, row.garmentSerial ?? row.serial)
  const batch = await batchOf(db, row.garmentBatch, row.partyId)
  const delivery = deliveredOnOf(garment, batch)
  const buyer = buyerOfParty(party)
  const check = checkOfRow(row, buyer, today)
  const scope = scopeOfCase(row)
  const contactEmail = contact && contact.status === 'ACTIVE' && contact.erasedAt === null ? contact.email : null
  const may: Record<CaseAction, boolean> = {
    edit: can(actor, SALES_SERVICE_MANAGE, scope),
    decideCover: can(actor, SALES_SERVICE_DECIDE, scope),
    open: can(actor, SALES_SERVICE_MANAGE, scope),
    waitCustomer: can(actor, SALES_SERVICE_MANAGE, scope),
    waitPart: can(actor, SALES_SERVICE_MANAGE, scope),
    resume: can(actor, SALES_SERVICE_MANAGE, scope),
    resolve: can(actor, SALES_SERVICE_MANAGE, scope),
    reopen: can(actor, SALES_SERVICE_MANAGE, scope),
    close: can(actor, SALES_SERVICE_MANAGE, scope),
    link: can(actor, SALES_SERVICE_MANAGE, scope),
    makeRepair: can(actor, SALES_SERVICE_MANAGE, scope) && can(actor, SALES_REPAIRS_MANAGE, scope),
    makeReturn: can(actor, SALES_SERVICE_MANAGE, scope) && can(actor, SALES_RETURNS_MANAGE, scope),
    notify: can(actor, SALES_SERVICE_MANAGE, scope),
  }
  const decided = row.cover && row.coverDecision && row.coverNote && row.coverDecidedAt
    ? { cover: row.cover as Cover, decision: row.coverDecision, note: row.coverNote, at: toUtcIso(row.coverDecidedAt), byId: row.coverDecidedById, remedies: remediesOf(row.cover as Cover) }
    : null
  return {
    ...base,
    party: party ? { id: party.id, code: party.code, legalName: party.legalName, kind: party.kind } : null,
    contact: contact ? { id: contact.id, name: contact.name, email: contactEmail, language: contact.language } : null,
    style: style ? { id: style.id, code: style.code, name: style.name, ppeCategory: style.ppeCategory } : null,
    colourway: colourway ? { id: colourway.id, code: colourway.code, name: colourway.name } : null,
    problem: row.problem,
    garment: garmentSummary({ garment, batch }),
    warranty: {
      deliveredOn: dayOrNull(row.deliveredOn),
      legalGuaranteeEndsOn: dayOrNull(row.legalGuaranteeEndsOn),
      factoryGuaranteeEndsOn: dayOrNull(row.factoryGuaranteeEndsOn),
      /** The delivery day our records give (the serial's shipment, the batch's only delivery), for a case without one typed. */
      suggestedDeliveredOn: row.deliveredOn === null && delivery.day && delivery.day <= today ? delivery.day : null,
      check,
      decided,
    },
    resolution: row.resolvedAt && row.resolution ? { at: toUtcIso(row.resolvedAt), words: row.resolution } : null,
    closed: row.closedAt ? { at: toUtcIso(row.closedAt), byId: row.closedById, reason: row.closeReason } : null,
    internalNote: row.internalNote,
    createdAt: toUtcIso(row.createdAt),
    createdById: row.createdById,
    links: await linksOf(db, row.id, actor),
    mails: await mailsOf(db, row.id),
    actions: caseActions({
      status: row.status as CaseStatus,
      kind: row.kind as CaseKind,
      coverDecided: row.coverDecision !== null,
      hasParty: row.partyId !== null,
      hasContactEmail: contactEmail !== null,
      notifyCustomer: row.notifyCustomer,
      may,
    }),
    people: await peopleOf(db, [row.ownerId, row.createdById, row.coverDecidedById, row.closedById]),
  }
}

export type CaseView = Awaited<ReturnType<typeof caseView>>

export async function caseRecordOf(caller: CommandCaller, caseId: string): Promise<CaseView> {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const row = await readCase(client, caseId)
    if (!row) throw new NotFoundError('Service case not found.')
    return caseView(client, row, context, serverClock.now())
  })
}
