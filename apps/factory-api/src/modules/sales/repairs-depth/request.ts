import { DomainError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { OPEN_REPAIR_STAGES, REPAIR_NUMBER_KIND, safetyRequiredFor, type RepairKind } from '@nexus/factory-domain/sales/repairs/rules'
import { problemOf, requestProblems, type OutsideChannel } from '@nexus/factory-domain/sales/repairs-depth/rules'
import type { CommandTools } from '../../../core/command'
import { allocateNumber } from '../../../platform/numbering/allocate'
import type { ClaimScope } from '../portal-returns/create'
import type { Place } from '../portal-returns/store'
import { garmentOf, type Reader } from '../repairs/store'

/**
 * A repair or alteration asked for from outside (B-W2b-342; SAL-384 repair request form, follow-up RR1:02 "The portal and
 * the claim link make a repair request"): the work INSIDE one command, shared by the portal (the person, in the tenant's
 * office scope: the partner role has no write on repairs nor on the number series) and the claim link (the tenant's
 * system, after the link was used in the link's own command), as B-W2b-192's returns and complaints.
 *
 *   the garment   an item of the party we delivered (an order line of the portal's company, a claim link's own order or
 *                 shipment) gives its style and colour; the serial on its label, when it is one of ours, is the repair's
 *                 garment of ours (garmentSerial: the history of the garment); its style, colour and size fill what the item
 *                 does not say only when it was made for this customer (or for stock): a garment made for another customer
 *                 never shows that customer's style. An unknown style counts as protective (W2a: safe by default).
 *   one at a time a serial with a repair open (also another customer's) is refused: one repair at a time per garment
 *                 (W2a's advisory lock on the serial, so two taps make one).
 *   the repair    AWAITING_GOODS, channel PORTAL or LINK (never changes), what is wrong and the work wanted, no owner yet
 *                 (the office takes it), numbered from the company's REPAIR series, its first stage event, repair.created
 *                 (W2a's, for every listener) and repair_request.sent.
 *   the site      the claim link's shipment's site, else the company's only active plant; else refused in words.
 */

export interface RepairRequestBody {
  readonly kind: RepairKind
  readonly salesOrderLineId?: string | null | undefined
  readonly size?: string | null | undefined
  readonly serial?: string | null | undefined
  readonly problem?: string | null | undefined
  readonly workWanted?: string | null | undefined
}

export interface RequestWho {
  readonly via: OutsideChannel
  /** The portal person (createdById), or null for a claim link. */
  readonly personId: string | null
  readonly linkId: string | null
}

const blank = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

export function refuse(problems: readonly Issue[], words: string): never {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems)
}

const tenantOf = (tools: Pick<CommandTools, 'context'>): string => {
  const context = tools.context
  if (!('tenantId' in context) || !context.tenantId) throw new Error('a repair request needs a tenant context')
  return context.tenantId
}

export interface RequestPlan {
  readonly siteId: string
  readonly styleId: string | null
  readonly colourwayId: string | null
  readonly size: string | null
  readonly serial: string | null
  readonly garmentSerial: string | null
  readonly safetyCheckRequired: boolean
  readonly salesOrderLineId: string | null
  readonly warnings: string[]
}

/** Checks the request against what we delivered and our serials (no write); refusals at body/<field>, a 409 in words. */
export async function planRequest(db: Reader, place: Place, scope: ClaimScope, body: RepairRequestBody): Promise<RequestPlan> {
  const problems: Issue[] = [...requestProblems(body)]
  if (problems.length > 0) refuse(problems, 'The repair request cannot be sent like this.')
  const warnings: string[] = []
  let styleId: string | null = null
  let colourwayId: string | null = null
  let siteId: string | null = null
  const lineId = blank(body.salesOrderLineId)
  if (lineId) {
    const line = isUuid(lineId) ? await db.salesOrderLine.findUnique({ where: { id: lineId }, select: { orderId: true, styleId: true, colourwayId: true } }) : null
    const order = line ? await db.salesOrder.findUnique({ where: { id: line.orderId }, select: { companyId: true, partyId: true } }) : null
    const inScope = !!line && !!order && order.companyId === place.companyId && order.partyId === place.partyId && (!scope.salesOrderId || line.orderId === scope.salesOrderId)
    const shipped = inScope && scope.shipmentId ? (await db.shipmentLine.count({ where: { shipmentId: scope.shipmentId, salesOrderLineId: lineId } })) > 0 : inScope
    if (!line || !shipped) refuse([{ path: 'body/salesOrderLineId', message: 'Pick the garment from what we delivered.' }], 'Pick the garment from what we delivered.')
    styleId = line!.styleId
    colourwayId = line!.colourwayId
  }
  const serial = blank(body.serial)
  const garment = await garmentOf(db, serial)
  const ours = garment !== null && (garment.partyId === null || garment.partyId === place.partyId)
  if (garment && !ours) warnings.push(`Serial ${garment.serial} was made for another customer's order: check the label when the garment arrives.`)
  if (garment && ours && styleId && garment.styleId !== styleId) warnings.push(`Serial ${garment.serial} is a garment of another style than the item picked: check the label when the garment arrives.`)
  if (garment && ours && !styleId) {
    styleId = garment.styleId
    colourwayId = garment.colourwayId
  }
  const size = blank(body.size) ?? (garment && ours ? garment.size : null)
  if (serial && !garment) warnings.push(`No garment of ours carries serial ${serial}: the style, colour and size are as the customer picked them.`)
  const style = styleId ? await db.style.findUnique({ where: { id: styleId }, select: { ppeCategory: true } }) : null
  // The site: the claim link's shipment's, else the company's only active plant.
  if (scope.shipmentId) siteId = (await db.shipment.findUnique({ where: { id: scope.shipmentId }, select: { siteId: true } }))?.siteId ?? null
  if (!siteId) {
    const plants = await db.site.findMany({ where: { companyId: place.companyId, status: 'ACTIVE', kind: 'PLANT' }, select: { id: true } })
    if (plants.length === 1) siteId = plants[0]!.id
  }
  if (!siteId) throw new DomainError('conflict', 'We could not tell which of our sites repairs the garment: write to us in the messages.')
  return { siteId, styleId, colourwayId, size, serial, garmentSerial: garment?.serial ?? null, safetyCheckRequired: safetyRequiredFor(style), salesOrderLineId: lineId, warnings }
}

/** The repair AWAITING_GOODS, channel PORTAL or LINK, with its first stage event (inside the caller's command). */
export async function createRequestInCommand(tools: CommandTools, place: Place, scope: ClaimScope, body: RepairRequestBody, who: RequestWho): Promise<{ repairId: string; number: string }> {
  const { tx, now } = tools
  const tenantId = tenantOf(tools)
  const typed = blank(body.serial)
  // The serial's lock first (W2a's, the same key): one open repair per garment holds until the commit.
  if (typed) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.repair-serial', ${tenantId}::text, ${typed}::text), 0))`
  const plan = await planRequest(tx, place, scope, body)
  if (plan.serial) {
    const open = await tx.repairOrder.findFirst({
      where: { stage: { in: [...OPEN_REPAIR_STAGES] }, OR: [{ serial: plan.serial }, ...(plan.garmentSerial ? [{ garmentSerial: plan.garmentSerial }] : [])] },
      select: { number: true, partyId: true },
    })
    if (open) {
      const words = open.partyId === place.partyId ? `Repair ${open.number} is open for this garment already: follow it there.` : 'This garment is with us for a repair already: write to us in the messages.'
      throw new DomainError('conflict', words, [{ path: 'body/serial', message: words }])
    }
  }
  const id = newId()
  const number = await allocateNumber(tools, { companyId: place.companyId, kind: REPAIR_NUMBER_KIND }, { type: 'RepairOrder', id, date: businessDate(now) })
  const workWanted = blank(body.workWanted)
  const problem = problemOf(body)
  await tx.repairOrder.create({
    data: {
      id,
      companyId: place.companyId,
      siteId: plan.siteId,
      partyId: place.partyId,
      number: number.formatted,
      kind: body.kind,
      serial: plan.serial,
      garmentSerial: plan.garmentSerial,
      styleId: plan.styleId,
      colourwayId: plan.colourwayId,
      size: plan.size,
      problem,
      workWanted,
      channel: who.via,
      stage: 'AWAITING_GOODS',
      safetyCheckRequired: plan.safetyCheckRequired,
      ownerId: null,
      createdAt: now,
      updatedAt: now,
      createdById: who.personId,
    },
    select: { id: true },
  })
  await tx.repairStageEvent.create({
    data: { id: newId(), siteId: plan.siteId, repairId: id, fromStage: null, stage: 'AWAITING_GOODS', repairVersion: 1, at: now, note: who.via === 'PORTAL' ? 'Asked by the customer in the portal.' : 'Asked by the customer by a claim link.', requestId: tools.context.requestId, createdAt: now, createdById: who.personId },
    select: { id: true },
  })
  tools.audit({
    action: 'repairsDepth.request',
    recordType: 'RepairOrder',
    recordId: id,
    companyId: place.companyId,
    siteId: plan.siteId,
    after: {
      number: number.formatted,
      partyId: place.partyId,
      kind: body.kind,
      channel: who.via,
      stage: 'AWAITING_GOODS',
      salesOrderLineId: plan.salesOrderLineId,
      serial: plan.serial,
      garmentSerial: plan.garmentSerial,
      styleId: plan.styleId,
      colourwayId: plan.colourwayId,
      size: plan.size,
      problem,
      workWanted,
      safetyCheckRequired: plan.safetyCheckRequired,
      receivedAt: toUtcIso(now),
      linkId: who.linkId,
      byPartner: true,
      warnings: plan.warnings,
    },
  })
  tools.emit({
    type: 'repair.created',
    subject: id,
    companyId: place.companyId,
    siteId: plan.siteId,
    payload: { repairId: id, number: number.formatted, partyId: place.partyId, kind: body.kind, stage: 'AWAITING_GOODS', returnLineId: null, complaintId: null, safetyCheckRequired: plan.safetyCheckRequired },
  })
  tools.emit({ type: 'repair_request.sent', subject: id, companyId: place.companyId, siteId: plan.siteId, payload: { repairId: id, number: number.formatted, partyId: place.partyId, kind: body.kind, via: who.via, garmentSerial: plan.garmentSerial } })
  return { repairId: id, number: number.formatted }
}
