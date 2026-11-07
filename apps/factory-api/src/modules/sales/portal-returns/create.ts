import { DomainError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { COMPLAINT_NUMBER_KIND, COMPLAINT_RECORD } from '@nexus/factory-domain/quality/complaints/rules'
import { ANSWER_WORKING_DAYS, complaintRequestProblems, returnRequestProblems, type OutcomeWanted, type RequestLine } from '@nexus/factory-domain/sales/portal-returns/rules'
import type { CommandTools } from '../../../core/command'
import { addWorkingDaysFor } from '../../../platform/calendars/service'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { planAbout } from '../../quality/complaints/log'
import { policyOf } from '../returns/policy'
import { lockSold, returnableRows, soldKeyOf, type ReturnableRow } from '../returns/returnable'
import { planLines, type PlannedLine } from '../returns/rma'
import { RETURN_RECORD, type Place, type Reader } from './store'

/**
 * Making a case from outside (B-W2b-192; SAL-334 "Return request from the portal", SAL-424; design portal.customer.returns
 * "Start a return or claim", links.claim "Report a problem"): the work INSIDE one command, shared by the portal (the person,
 * in the tenant's office scope: the partner role has no grant on returns, complaints or the number series) and the claim
 * link (the tenant's system, after the link was used in the link's own command).
 *
 *   a return    what may come back is W2a's (returnable.ts: invoiced lines and shipped order lines and sizes, never more
 *               than was sold less what other live returns take back, under the trigger's own advisory locks); a claim
 *               link keeps to its own shipment or order. The lines, reasons and the customer's words make an RMA REQUESTED
 *               (W2a's guard: authorised nothing, no deadline yet) numbered from the company's RETURN series; the office
 *               authorises or rejects it (./office.ts). What the customer would like and their note are kept on the
 *               request's audit row (no column on the RMA: a schema need, named in the notes).
 *   a complaint the customer's words and the item (an order line of theirs, its size, the serial or batch on the label) make
 *               a W2a Complaint NEW, channel PORTAL or LINK, numbered from the company's COMPLAINT series; a serial of ours
 *               fills the style, size and batch (W2a's planAbout); quality triages it as today.
 */

export interface Who {
  readonly via: 'PORTAL' | 'LINK'
  /** The portal person (createdById), or null for a claim link. */
  readonly personId: string | null
  readonly linkId: string | null
}

/** What a claim link keeps to: its own shipment or order (null: the portal, any of the party's). */
export interface ClaimScope {
  readonly salesOrderId: string | null
  readonly shipmentId: string | null
}

export const NO_SCOPE: ClaimScope = Object.freeze({ salesOrderId: null, shipmentId: null })

const blank = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

const tenantOf = (tools: Pick<CommandTools, 'context'>): string => {
  const context = tools.context
  if (!('tenantId' in context) || !context.tenantId) throw new Error('a case from outside needs a tenant context')
  return context.tenantId
}

/** The day the factory answers by: the company's calendar, ANSWER_WORKING_DAYS after today. */
export async function answerByFor(db: Reader, companyId: string, now: Date): Promise<BusinessDate | null> {
  return (await addWorkingDaysFor(db, { scope: 'COMPANY', id: companyId }, businessDate(now), ANSWER_WORKING_DAYS)).date
}

/** What of the party may come back, kept to a claim link's shipment or order (a shipment: its order lines and sizes). */
export async function returnableFor(db: Reader, place: Place, scope: ClaimScope, now: Date): Promise<ReturnableRow[]> {
  const policy = await policyOf(db, place.companyId)
  const rows = await returnableRows(db, { companyId: place.companyId, partyId: place.partyId, salesOrderId: scope.salesOrderId }, policy, now)
  if (!scope.shipmentId) return rows
  const shipped = await db.shipmentLine.findMany({ where: { shipmentId: scope.shipmentId, partyId: place.partyId }, select: { salesOrderLineId: true, size: true } })
  const keys = new Set(shipped.map((line) => `${line.salesOrderLineId}|${line.size ?? ''}`))
  return rows.filter((row) => row.salesOrderLineId !== null && keys.has(`${row.salesOrderLineId}|${row.size ?? ''}`))
}

export interface ReturnRequestBody {
  readonly lines: readonly RequestLine[]
  readonly outcomeWanted?: OutcomeWanted | null | undefined
  readonly customerRef?: string | null | undefined
  readonly note?: string | null | undefined
}

export function refuse(problems: readonly Issue[], words: string): never {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems)
}

export const aboveSoldError = (issues: readonly Issue[]): DomainError => new DomainError('conflict', issues.length === 1 ? issues[0]!.message : 'Some items take back more than you received.', issues)

/** Checks a return request against what may come back today (no write): the planned lines, the site and the order. */
export async function planRequest(db: Reader, place: Place, scope: ClaimScope, body: ReturnRequestBody, now: Date) {
  const shape = returnRequestProblems(body)
  if (shape.length > 0) return { plan: null, problems: shape, aboveSold: [] as Issue[] }
  const rows = await returnableFor(db, place, scope, now)
  const { planned, problems, aboveSold } = await planLines(db, rows, body.lines.map((line) => ({ ...line, description: null, batchNumber: null })), 'body/lines')
  const sites = [...new Set(planned.flatMap((line) => (line.row.siteId ? [line.row.siteId] : [])))]
  let siteId = sites[0] ?? null
  if (!siteId && planned.length > 0) {
    const active = await db.site.findMany({ where: { companyId: place.companyId, status: 'ACTIVE' }, select: { id: true } })
    if (active.length === 1) siteId = active[0]!.id
    else problems.push({ path: 'body/lines', message: 'We could not tell where these goods go back: write to us in the messages.' })
  }
  const orders = new Set(planned.map((line) => line.row.order?.id ?? null))
  const salesOrderId = scope.salesOrderId ?? (orders.size === 1 ? [...orders][0]! : null)
  if (problems.length > 0 || !siteId) return { plan: null, problems, aboveSold }
  return { plan: { siteId, salesOrderId, lines: planned }, problems, aboveSold }
}

/** The RMA REQUESTED with its lines (inside the caller's command). */
export async function createRequestInCommand(tools: CommandTools, place: Place, scope: ClaimScope, body: ReturnRequestBody, who: Who): Promise<{ returnId: string; number: string; lineIds: string[] }> {
  const { tx, now } = tools
  const tenantId = tenantOf(tools)
  // The trigger's advisory locks of what the lines name, first: the sums read below hold until the commit.
  await lockSold(tx, tenantId, body.lines.map((line) => ({ invoiceLineId: line.invoiceLineId ?? null, salesOrderLineId: line.salesOrderLineId ?? null, size: blank(line.size) })))
  const { plan, problems, aboveSold } = await planRequest(tx, place, scope, body, now)
  if (problems.length > 0 || !plan) refuse(problems, 'The return request cannot be sent like this.')
  if (aboveSold.length > 0) throw aboveSoldError(aboveSold)
  await lockSold(tx, tenantId, plan!.lines.map((line) => line.key))
  const id = newId()
  const number = await allocateNumber(tools, { companyId: place.companyId, kind: 'RETURN' }, { type: RETURN_RECORD, id, date: businessDate(now) })
  const stamp = { createdAt: now, updatedAt: now, createdById: who.personId }
  await tx.returnAuthorisation.create({
    data: {
      id,
      companyId: place.companyId,
      siteId: plan!.siteId,
      partyId: place.partyId,
      number: number.formatted,
      customerRef: blank(body.customerRef),
      salesOrderId: plan!.salesOrderId,
      status: 'REQUESTED',
      requestedAt: now,
      ...stamp,
    },
    select: { id: true },
  })
  const lineIds: string[] = []
  for (const [index, line] of plan!.lines.entries()) {
    const lineId = newId()
    await tx.returnLine.create({ data: lineData(line, { id, siteId: plan!.siteId, partyId: place.partyId }, lineId, (index + 1) * 10, stamp), select: { id: true } })
    lineIds.push(lineId)
    tools.audit({
      action: 'returns.addLine',
      recordType: 'ReturnLine',
      recordId: lineId,
      companyId: place.companyId,
      siteId: plan!.siteId,
      after: { seq: (index + 1) * 10, ...line.key, quantity: line.quantity, reasonCode: line.reasonCode, reasonNote: line.reasonNote, serial: line.serial, description: line.description, unitPrice: markMoney('price', line.row.unitPrice), byPartner: true },
    })
  }
  const pieces = plan!.lines.reduce((sum, line) => sum + line.quantity, 0)
  tools.audit({
    action: who.via === 'LINK' ? 'portalReturns.claim' : 'portalReturns.request',
    recordType: RETURN_RECORD,
    recordId: id,
    companyId: place.companyId,
    siteId: plan!.siteId,
    after: {
      number: number.formatted,
      partyId: place.partyId,
      siteId: plan!.siteId,
      salesOrderId: plan!.salesOrderId,
      status: 'REQUESTED',
      via: who.via,
      linkId: who.linkId,
      lines: lineIds.length,
      pieces,
      outcomeWanted: body.outcomeWanted ?? null,
      note: blank(body.note),
      customerRef: blank(body.customerRef),
      byPartner: true,
    },
  })
  tools.emit({ type: 'return_request.sent', subject: id, companyId: place.companyId, siteId: plan!.siteId, payload: { returnId: id, number: number.formatted, partyId: place.partyId, salesOrderId: plan!.salesOrderId, via: who.via, lineIds, pieces } })
  return { returnId: id, number: number.formatted, lineIds }
}

const discountOf = (value: string | null): string | null => (value === null || /^0(\.0+)?$/.test(value) ? null : value)

function lineData(line: PlannedLine, rma: { readonly id: string; readonly siteId: string; readonly partyId: string }, id: string, seq: number, stamp: { readonly createdAt: Date; readonly updatedAt: Date; readonly createdById: string | null }) {
  return {
    id,
    siteId: rma.siteId,
    partyId: rma.partyId,
    returnId: rma.id,
    seq,
    salesOrderLineId: line.key.salesOrderLineId,
    size: line.key.salesOrderLineId ? line.key.size : null,
    invoiceLineId: line.key.invoiceLineId,
    description: line.description,
    serial: line.serial,
    batchNumber: line.batchNumber,
    quantity: line.quantity,
    reasonCode: line.reasonCode,
    reasonNote: line.reasonNote,
    unitPrice: line.row.unitPrice,
    discountPct: discountOf(line.row.discountPct),
    ...stamp,
  }
}

export interface ComplaintBody {
  readonly description: string
  /** The item: an order line of theirs (from the order's items) and its size. */
  readonly salesOrderLineId?: string | null | undefined
  readonly size?: string | null | undefined
  readonly serial?: string | null | undefined
  readonly batchNumber?: string | null | undefined
  readonly shipmentId?: string | null | undefined
  readonly returnId?: string | null | undefined
  readonly customerRef?: string | null | undefined
}

/** The complaint NEW, channel PORTAL or LINK (inside the caller's command). */
export async function createComplaintInCommand(tools: CommandTools, place: Place, scope: ClaimScope, body: ComplaintBody, who: Who): Promise<{ complaintId: string; number: string }> {
  const { tx, now } = tools
  const problems: Issue[] = [...complaintRequestProblems(body)]
  // The item: an order line of the party's with this company (a claim link: of its own order or shipment).
  let salesOrderId = scope.salesOrderId
  let styleId: string | null = null
  if (body.salesOrderLineId) {
    const line = isUuid(body.salesOrderLineId) ? await tx.salesOrderLine.findUnique({ where: { id: body.salesOrderLineId }, select: { orderId: true, styleId: true } }) : null
    const order = line ? await tx.salesOrder.findUnique({ where: { id: line.orderId }, select: { companyId: true, partyId: true } }) : null
    const inScope = !!line && !!order && order.companyId === place.companyId && order.partyId === place.partyId && (!scope.salesOrderId || line.orderId === scope.salesOrderId)
    const shipped = inScope && scope.shipmentId ? (await tx.shipmentLine.count({ where: { shipmentId: scope.shipmentId, salesOrderLineId: body.salesOrderLineId } })) > 0 : inScope
    if (!line || !shipped) problems.push({ path: 'body/salesOrderLineId', message: 'Pick the item from what you received.' })
    else {
      salesOrderId = line.orderId
      styleId = line.styleId
    }
  }
  const shipmentId = scope.shipmentId ?? body.shipmentId ?? null
  const warnings: Issue[] = []
  const { about } = await planAbout(
    tx,
    { companyId: place.companyId, partyId: place.partyId, contactId: null, salesOrderId, shipmentId, returnId: body.returnId ?? null, styleId, size: blank(body.size), serial: blank(body.serial), batchNumber: blank(body.batchNumber) },
    problems,
    warnings,
  )
  if (problems.length > 0) refuse(problems, 'The complaint cannot be sent like this.')
  const id = newId()
  const number = await allocateNumber(tools, { companyId: place.companyId, kind: COMPLAINT_NUMBER_KIND }, { type: COMPLAINT_RECORD, id, date: businessDate(now) })
  const channel = who.via === 'LINK' ? 'LINK' : 'PORTAL'
  await tx.complaint.create({
    data: {
      id,
      companyId: place.companyId,
      partyId: place.partyId,
      number: number.formatted,
      customerRef: blank(body.customerRef),
      channel,
      receivedAt: now,
      description: body.description.trim(),
      salesOrderId: about.salesOrderId,
      shipmentId: about.shipmentId,
      returnId: about.returnId,
      styleId: about.styleId,
      size: about.size,
      serial: about.serial,
      batchNumber: about.batchNumber,
      status: 'NEW',
      createdAt: now,
      updatedAt: now,
      createdById: who.personId,
    },
    select: { id: true },
  })
  tools.audit({
    action: who.via === 'LINK' ? 'portalReturns.claimComplaint' : 'portalReturns.complaint',
    recordType: COMPLAINT_RECORD,
    recordId: id,
    companyId: place.companyId,
    after: {
      number: number.formatted,
      partyId: place.partyId,
      channel,
      receivedAt: toUtcIso(now),
      salesOrderId: about.salesOrderId,
      shipmentId: about.shipmentId,
      returnId: about.returnId,
      styleId: about.styleId,
      size: about.size,
      serial: about.serial,
      batchNumber: about.batchNumber,
      status: 'NEW',
      linkId: who.linkId,
      byPartner: true,
      warnings: warnings.map((warning) => warning.message),
    },
  })
  tools.emit({
    type: 'complaint.received',
    subject: id,
    companyId: place.companyId,
    payload: { complaintId: id, number: number.formatted, partyId: place.partyId, channel, salesOrderId: about.salesOrderId, shipmentId: about.shipmentId, returnId: about.returnId, styleId: about.styleId },
  })
  return { complaintId: id, number: number.formatted }
}

/** The items a page offers: what may come back, without a price unless the person sees prices. */
export function itemsOf(rows: readonly ReturnableRow[], seesPrices: boolean) {
  return rows.map((row) => ({
    key: soldKeyOf(row),
    invoiceLineId: row.invoiceLineId,
    salesOrderLineId: row.salesOrderLineId,
    size: row.size,
    description: row.description,
    order: row.order ? { id: row.order.id, number: row.order.number, lineSeq: row.order.lineSeq } : null,
    invoice: row.invoice ? { id: row.invoice.id, number: row.invoice.number, issueDate: row.invoice.issueDate } : null,
    style: row.style ? { code: row.style.code, name: row.style.name } : null,
    colourway: row.colourway ? { code: row.colourway.code, name: row.colourway.name } : null,
    ppe: row.ppe,
    received: row.sold,
    canReturn: row.left,
    deliveredOn: row.deliveredOn,
    windowWarning: row.warning,
    ...(seesPrices && row.unitPrice !== null ? { unitPrice: asMoney('price', Number(row.unitPrice)), currency: row.currency } : {}),
  }))
}
