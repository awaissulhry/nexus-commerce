import { NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate, parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { QUALITY_COMPLAINTS_LOG } from '@nexus/factory-domain/quality/complaints/permissions'
import { COMPLAINT_NUMBER_KIND, COMPLAINT_RECORD, factProblems, OPEN_STATUSES, type ComplaintChannel } from '@nexus/factory-domain/quality/complaints/rules'
import { command, type CommandCaller } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { followInCommand } from '../../../platform/threads/followers'
import { mayOn, officeOf } from './access'
import { complaintView, garmentOf, readComplaint, summaryOf, type ComplaintView, type GarmentFacts, type Reader } from './store'

/**
 * Logging a complaint as the customer made it (B-W2a-65; SAL-416 "Customer complaint record"; design cmp-log "Customer,
 * order or serial (scan), what happened in the customer's words, photos, channel, received on"). ONE command: the number
 * from the company's COMPLAINT series, the complaint NEW (quality triages it, QHS-113), its maker following it,
 * complaint.received. What it is about is kept as reported (a serial or batch is never refused: it may be wrong), but
 * what the office names must be the company's and the customer's: the order, the return, the shipment (the trigger checks
 * the shipment too). A serial of ours fills the style, size and batch left out, and its shipment and order when it left
 * for this customer. The photos are files of the record (POST /files, recordType Complaint) once it is logged.
 */

export interface LogBody {
  readonly companyId?: string | undefined
  readonly partyId?: string | undefined
  readonly contactId?: string | null | undefined
  readonly customerRef?: string | null | undefined
  readonly channel?: ComplaintChannel | undefined
  readonly receivedAt?: string | undefined
  readonly description?: string | undefined
  readonly salesOrderId?: string | null | undefined
  readonly shipmentId?: string | null | undefined
  readonly returnId?: string | null | undefined
  readonly styleId?: string | null | undefined
  readonly size?: string | null | undefined
  readonly serial?: string | null | undefined
  readonly batchNumber?: string | null | undefined
  readonly internalNote?: string | null | undefined
}

export const blank = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

export function refuse(problems: readonly Issue[], words: string): never {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems)
}

export interface AboutFacts {
  readonly companyId: string
  readonly partyId: string
  readonly contactId: string | null
  readonly salesOrderId: string | null
  readonly shipmentId: string | null
  readonly returnId: string | null
  readonly styleId: string | null
  readonly size: string | null
  readonly serial: string | null
  readonly batchNumber: string | null
}

/**
 * What a complaint is about, checked against the company and the customer (problems at body/<field>) and filled from our
 * garment when its serial is known (warnings say what was taken and what looks wrong).
 */
export async function planAbout(db: Reader, asked: AboutFacts, problems: Issue[], warnings: Issue[]): Promise<{ about: AboutFacts; garment: GarmentFacts | null }> {
  const { companyId, partyId } = asked
  if (asked.contactId) {
    const contact = isUuid(asked.contactId) ? await db.partyContact.findUnique({ where: { id: asked.contactId }, select: { partyId: true } }) : null
    if (!contact || contact.partyId !== partyId) problems.push({ path: 'body/contactId', message: "A contact of the customer's." })
  }
  if (asked.salesOrderId) {
    const order = isUuid(asked.salesOrderId) ? await db.salesOrder.findUnique({ where: { id: asked.salesOrderId }, select: { companyId: true, partyId: true } }) : null
    if (!order || order.companyId !== companyId || order.partyId !== partyId) problems.push({ path: 'body/salesOrderId', message: "An order of the customer's with this company." })
  }
  if (asked.shipmentId) {
    const shipment = isUuid(asked.shipmentId) ? await db.shipment.findUnique({ where: { id: asked.shipmentId }, select: { companyId: true, partyId: true } }) : null
    if (!shipment || shipment.companyId !== companyId || shipment.partyId !== partyId) problems.push({ path: 'body/shipmentId', message: "A shipment of this company to the customer." })
  }
  if (asked.returnId) {
    const rma = isUuid(asked.returnId) ? await db.returnAuthorisation.findUnique({ where: { id: asked.returnId }, select: { companyId: true, partyId: true } }) : null
    if (!rma || rma.companyId !== companyId || rma.partyId !== partyId) problems.push({ path: 'body/returnId', message: "A return of the customer's with this company." })
  }
  if (asked.styleId) {
    const style = isUuid(asked.styleId) ? await db.style.findUnique({ where: { id: asked.styleId }, select: { id: true } }) : null
    if (!style) problems.push({ path: 'body/styleId', message: 'Not a style of the tenant.' })
  }
  const garment = await garmentOf(db, asked.serial)
  if (asked.serial && !garment) warnings.push({ path: 'body/serial', message: `No garment of ours carries serial ${asked.serial}: it is kept as reported.` })
  let about: AboutFacts = asked
  if (garment) {
    const forThem = garment.partyId === null || garment.partyId === partyId
    if (!forThem) warnings.push({ path: 'body/serial', message: `Serial ${garment.serial} was made for another customer's order: check the label.` })
    if (garment.companyId !== companyId) warnings.push({ path: 'body/serial', message: `Serial ${garment.serial} was made by another company of the group.` })
    if (asked.styleId && asked.styleId !== garment.styleId) warnings.push({ path: 'body/styleId', message: `Serial ${garment.serial} is a garment of another style: check the serial or the style.` })
    const left = garment.shipment && garment.shipment.partyId === partyId && garment.shipment.companyId === companyId ? garment.shipment : null
    about = {
      ...asked,
      styleId: asked.styleId ?? garment.styleId,
      size: asked.size ?? garment.size,
      batchNumber: asked.batchNumber ?? garment.batchNumber,
      shipmentId: asked.shipmentId ?? left?.id ?? null,
      salesOrderId: asked.salesOrderId ?? (forThem && garment.companyId === companyId ? (left?.salesOrderId ?? garment.salesOrderId) : null),
    }
  }
  return { about, garment }
}

function mayStart(context: OfficeContext, body: LogBody): boolean {
  if (!body.companyId || !body.partyId) return true
  return mayOn(context, QUALITY_COMPLAINTS_LOG, { companyId: body.companyId, partyId: body.partyId })
}

async function checkParty(db: Reader, companyId: string, partyId: string, problems: Issue[]): Promise<void> {
  const company = isUuid(companyId) ? await db.company.findUnique({ where: { id: companyId }, select: { id: true } }) : null
  if (!company) throw new NotFoundError('Company not found.')
  const party = isUuid(partyId) ? await db.party.findUnique({ where: { id: partyId }, select: { companyId: true, roles: true, status: true, legalName: true } }) : null
  if (!party || (party.companyId !== null && party.companyId !== companyId)) throw new NotFoundError('Customer not found.')
  if (!party.roles.includes('CUSTOMER') && !party.roles.includes('BRAND')) problems.push({ path: 'body/partyId', message: 'Not a customer: a complaint is made by a customer.' })
  if (party.status === 'ARCHIVED') problems.push({ path: 'body/partyId', message: `${party.legalName} is archived.` })
}

const aboutOf = (body: LogBody, companyId: string, partyId: string): AboutFacts => ({
  companyId,
  partyId,
  contactId: body.contactId ?? null,
  salesOrderId: body.salesOrderId ?? null,
  shipmentId: body.shipmentId ?? null,
  returnId: body.returnId ?? null,
  styleId: body.styleId ?? null,
  size: blank(body.size),
  serial: blank(body.serial),
  batchNumber: blank(body.batchNumber),
})

/** POST /quality/complaints/preview: what the dialog has so far, filled from a scanned serial. Writes nothing. */
export async function previewComplaint(caller: CommandCaller, body: LogBody) {
  const context = officeOf(caller)
  if (!mayStart(context, body)) throw new NotFoundError('Customer not found.')
  const now = serverClock.now()
  return caller.withClient(async (client) => {
    const problems: Issue[] = []
    const warnings: Issue[] = []
    const receivedAt = body.receivedAt ? parseInstant(body.receivedAt) : null
    problems.push(...factProblems({ ...body, receivedAt }, now, false))
    // A serial alone: our garment names its company and its customer (when it left for one).
    const garment = await garmentOf(client, body.serial)
    const companyId = body.companyId ?? garment?.companyId ?? null
    const partyId = body.partyId ?? garment?.shipment?.partyId ?? garment?.partyId ?? null
    let draft = { companyId, partyId, styleId: body.styleId ?? garment?.styleId ?? null, size: blank(body.size) ?? garment?.size ?? null, batchNumber: blank(body.batchNumber) ?? garment?.batchNumber ?? null, shipmentId: body.shipmentId ?? null, salesOrderId: body.salesOrderId ?? null }
    if (companyId && partyId && mayOn(context, QUALITY_COMPLAINTS_LOG, { companyId, partyId })) {
      await checkParty(client, companyId, partyId, problems)
      const planned = await planAbout(client, aboutOf({ ...body, styleId: body.styleId ?? null }, companyId, partyId), problems, warnings)
      draft = { companyId, partyId, styleId: planned.about.styleId, size: planned.about.size, batchNumber: planned.about.batchNumber, shipmentId: planned.about.shipmentId, salesOrderId: planned.about.salesOrderId }
    } else {
      if (!companyId) problems.push({ path: 'body/companyId', message: 'Name the company the complaint is made to.' })
      if (!partyId) problems.push({ path: 'body/partyId', message: 'Name the customer who complained.' })
    }
    if (!blank(body.description)) problems.push({ path: 'body/description', message: "What happened, in the customer's words." })
    if (!body.channel) problems.push({ path: 'body/channel', message: 'How it came in.' })
    const others =
      draft.partyId && draft.companyId && mayOn(context, QUALITY_COMPLAINTS_LOG, { companyId: draft.companyId, partyId: draft.partyId })
        ? await client.complaint.findMany({ where: { partyId: draft.partyId, companyId: draft.companyId, status: { in: [...OPEN_STATUSES] } }, select: { id: true, number: true, status: true, receivedAt: true, description: true }, orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], take: 10 })
        : []
    return {
      ok: problems.length === 0,
      problems,
      warnings,
      draft,
      garment: garment
        ? { madeOn: garment.madeOn, workOrderNumber: garment.workOrderNumber, batchNumber: garment.batchNumber, shipment: garment.shipment ? { id: garment.shipment.id, number: garment.shipment.number } : null, forThisCustomer: partyId === null || garment.partyId === null || garment.partyId === partyId }
        : null,
      others: others.map((row) => ({ id: row.id, number: row.number, status: row.status, receivedAt: toUtcIso(row.receivedAt), summary: summaryOf(row.description) })),
    }
  })
}

/** POST /quality/complaints: the complaint, numbered, NEW. */
export async function logComplaint(caller: CommandCaller, body: LogBody & { companyId: string; partyId: string; channel: ComplaintChannel; description: string }, idempotencyKey?: string): Promise<{ complaint: ComplaintView; warnings: Issue[] }> {
  const context = officeOf(caller)
  if (!mayStart(context, body)) throw new NotFoundError('Customer not found.')
  const { result } = await command(caller, { name: 'complaints.log', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const problems: Issue[] = []
    const warnings: Issue[] = []
    const receivedAt = body.receivedAt ? parseInstant(body.receivedAt)! : now
    problems.push(...factProblems({ ...body, receivedAt }, now, true))
    await checkParty(tx, body.companyId, body.partyId, problems)
    const { about } = await planAbout(tx, aboutOf(body, body.companyId, body.partyId), problems, warnings)
    if (problems.length > 0) refuse(problems, 'The complaint cannot be logged like this.')
    const id = newId()
    const number = await allocateNumber(tools, { companyId: about.companyId, kind: COMPLAINT_NUMBER_KIND }, { type: COMPLAINT_RECORD, id, date: businessDate(receivedAt) })
    const description = body.description.trim()
    await tx.complaint.create({
      data: {
        id,
        companyId: about.companyId,
        partyId: about.partyId,
        contactId: about.contactId,
        number: number.formatted,
        customerRef: blank(body.customerRef),
        channel: body.channel,
        receivedAt,
        description,
        salesOrderId: about.salesOrderId,
        shipmentId: about.shipmentId,
        returnId: about.returnId,
        styleId: about.styleId,
        size: about.size,
        serial: about.serial,
        batchNumber: about.batchNumber,
        status: 'NEW',
        internalNote: blank(body.internalNote),
        createdAt: now,
        updatedAt: now,
        createdById: context.actorId,
      },
      select: { id: true },
    })
    tools.audit({
      recordType: COMPLAINT_RECORD,
      recordId: id,
      companyId: about.companyId,
      after: {
        number: number.formatted,
        partyId: about.partyId,
        contactId: about.contactId,
        channel: body.channel,
        receivedAt: toUtcIso(receivedAt),
        salesOrderId: about.salesOrderId,
        shipmentId: about.shipmentId,
        returnId: about.returnId,
        styleId: about.styleId,
        size: about.size,
        serial: about.serial,
        batchNumber: about.batchNumber,
        status: 'NEW',
      },
    })
    // Its maker follows it (an office person; a system or test caller without a person row follows nothing).
    if (await tx.user.findUnique({ where: { id: context.actorId }, select: { id: true } })) {
      await followInCommand(tools, { type: COMPLAINT_RECORD, id, companyId: about.companyId, siteId: null }, context.actorId, 'CREATOR', context.actorId)
    }
    tools.emit({
      type: 'complaint.received',
      subject: id,
      companyId: about.companyId,
      payload: { complaintId: id, number: number.formatted, partyId: about.partyId, channel: body.channel, salesOrderId: about.salesOrderId, shipmentId: about.shipmentId, returnId: about.returnId, styleId: about.styleId },
    })
    return { complaintId: id, warnings }
  })
  return { complaint: await recordOf(caller, result.complaintId), warnings: result.warnings }
}

export async function recordOf(caller: CommandCaller, complaintId: string): Promise<ComplaintView> {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const complaint = await readComplaint(client, complaintId)
    if (!complaint) throw new NotFoundError('Complaint not found.')
    return complaintView(client, complaint, context)
  })
}
