import { DomainError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate, parseInstant, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { SALES_REPAIRS_MANAGE } from '@nexus/factory-domain/sales/repairs/permissions'
import {
  NO_INBOUND_DDT_WORDS,
  OPEN_REPAIR_STAGES,
  REPAIR_LIMITS,
  REPAIR_NUMBER_KIND,
  safetyRequiredFor,
  stageWords,
  UNKNOWN_STYLE_WORDS,
  type RepairKind,
  type RepairStage,
} from '@nexus/factory-domain/sales/repairs/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { mayOn, officeOf } from './access'
import { asDay, garmentOf, readRepair, repairView, type GarmentFacts, type Reader, type RepairView } from './store'

/**
 * Making a repair or an alteration (B-W2a-57; SAL-383 "Repair order from a case"; design returns.newRepair "Garment serial
 * (scan) · Customer · Problem", the RMA's "Make repair order" and the service case's). ONE command:
 *
 *   from an RMA line   the line decided Repair (its garment never entered stock, B-W2a-43), received: the RMA's company,
 *                      site and customer, the line's garment (its order line's style and colourway, its size and
 *                      serial), the customer's DDT of the receipt that brought it; RECEIVED at once. One repair per
 *                      garment that came back on the line (the line's row locked first).
 *   from a complaint   a complaint (a service case) of the company and customer, not closed: its garment and words;
 *                      AWAITING_GOODS until the garment arrives (or RECEIVED when it came with the customer).
 *   by hand            the company and customer named; the serial read from the label finds our garment (style,
 *                      colourway, size, made on), else the style, colourway and size typed.
 * The repairing site: named, else the RMA's, else the company's only active plant. A protective garment (its style is
 * PPE; an unknown style counts as one) goes back only after its safety check. One open repair per serial (an advisory
 * lock on the serial, so two taps or two desks make one). The number from the company's REPAIR series; the repair's first
 * stage event (from nothing) in the same command; repair.created.
 */

export interface CreateBody {
  readonly returnLineId?: string | undefined
  readonly complaintId?: string | undefined
  readonly companyId?: string | undefined
  readonly partyId?: string | undefined
  readonly siteId?: string | undefined
  readonly kind?: RepairKind | undefined
  readonly serial?: string | null | undefined
  readonly styleId?: string | null | undefined
  readonly colourwayId?: string | null | undefined
  readonly size?: string | null | undefined
  readonly problem?: string | undefined
  readonly ownerId?: string | null | undefined
  readonly internalNote?: string | null | undefined
  readonly received?: { readonly at?: string | undefined; readonly inboundDdtNumber?: string | null | undefined; readonly inboundDdtDate?: BusinessDate | null | undefined } | null | undefined
}

export const blank = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const tooLong = (value: string | null | undefined, max: number): boolean => (value ?? '').trim().length > max

export function refuse(problems: readonly Issue[], words: string): never {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems)
}

const conflict = (words: readonly string[]): DomainError => new DomainError('conflict', words.join(' '))

/** A few minutes for the clocks of the screen and the server. */
const GRACE_MS = 5 * 60_000

export interface RepairPlan {
  readonly companyId: string
  readonly siteId: string
  readonly siteCode: string
  readonly partyId: string
  readonly kind: RepairKind
  readonly stage: RepairStage
  readonly serial: string | null
  readonly styleId: string | null
  readonly colourwayId: string | null
  readonly size: string | null
  readonly problem: string
  readonly safetyCheckRequired: boolean
  readonly receivedAt: Date | null
  readonly inboundDdtNumber: string | null
  readonly inboundDdtDate: BusinessDate | null
  readonly returnLineId: string | null
  readonly returnLabel: string | null
  readonly complaintId: string | null
  readonly complaintNumber: string | null
  readonly ownerId: string
  readonly internalNote: string | null
  readonly garment: GarmentFacts | null
  readonly warnings: Issue[]
}

const sameOrMissing = (asked: string | undefined, known: string): boolean => asked === undefined || asked === known

/** Checks the garment fields (style, colourway, size, serial) against each other and our serials; problems at body/<field>. */
export async function planGarment(
  db: Reader,
  asked: { readonly serial: string | null; readonly styleId: string | null; readonly colourwayId: string | null; readonly size: string | null },
  partyId: string,
  problems: Issue[],
  warnings: Issue[],
): Promise<{ serial: string | null; styleId: string | null; colourwayId: string | null; size: string | null; safetyCheckRequired: boolean; garment: GarmentFacts | null }> {
  if (tooLong(asked.serial, REPAIR_LIMITS.serial)) problems.push({ path: 'body/serial', message: `At most ${REPAIR_LIMITS.serial} characters.` })
  if (tooLong(asked.size, REPAIR_LIMITS.size)) problems.push({ path: 'body/size', message: `At most ${REPAIR_LIMITS.size} characters.` })
  const garment = await garmentOf(db, asked.serial)
  if (asked.serial && !garment) warnings.push({ path: 'body/serial', message: `No garment of ours carries serial ${asked.serial}: the style, colour and size are as typed.` })
  if (garment && garment.partyId !== null && garment.partyId !== partyId) warnings.push({ path: 'body/serial', message: `Serial ${garment.serial} was made for another customer's order: check the label.` })
  if (garment && asked.styleId && asked.styleId !== garment.styleId) problems.push({ path: 'body/styleId', message: `Serial ${garment.serial} is a garment of another style: leave the style out, or check the serial.` })
  const styleId = asked.styleId ?? garment?.styleId ?? null
  const colourwayId = asked.colourwayId ?? (garment && (!asked.styleId || asked.styleId === garment.styleId) ? garment.colourwayId : null)
  const size = asked.size ?? garment?.size ?? null
  const style = styleId && isUuid(styleId) ? await db.style.findUnique({ where: { id: styleId }, select: { id: true, ppeCategory: true } }) : null
  if (styleId && !style) problems.push({ path: 'body/styleId', message: 'Not a style of the tenant.' })
  if (colourwayId) {
    if (!styleId) problems.push({ path: 'body/colourwayId', message: 'A colourway is named with its style.' })
    else {
      const colourway = isUuid(colourwayId) ? await db.colourway.findUnique({ where: { id: colourwayId }, select: { styleId: true } }) : null
      if (!colourway || colourway.styleId !== styleId) problems.push({ path: 'body/colourwayId', message: 'A colourway of the style.' })
    }
  }
  if (!style) warnings.push({ path: 'body/styleId', message: UNKNOWN_STYLE_WORDS })
  return { serial: asked.serial, styleId: style ? styleId : null, colourwayId: style ? colourwayId : null, size, safetyCheckRequired: safetyRequiredFor(style), garment }
}

/** The inbound DDT and arrival time as typed: problems at body/<at>/…. */
function arrivalProblems(at: Date | null, number: string | null, date: BusinessDate | null, now: Date, path: string, problems: Issue[]): void {
  if (at && at.getTime() > now.getTime() + GRACE_MS) problems.push({ path: `${path}/at`, message: 'The garment arrived now or earlier.' })
  if (tooLong(number, REPAIR_LIMITS.ddtNumber)) problems.push({ path: `${path}/inboundDdtNumber`, message: `At most ${REPAIR_LIMITS.ddtNumber} characters.` })
  if (date && !number) problems.push({ path: `${path}/inboundDdtNumber`, message: "The customer's DDT number, with its date." })
  if (date && at && date > businessDate(at)) problems.push({ path: `${path}/inboundDdtDate`, message: "The customer's DDT is dated on or before the day the garment arrived." })
}

async function planRepair(db: Reader, context: OfficeContext, body: CreateBody, now: Date): Promise<{ plan: RepairPlan | null; problems: Issue[]; conflicts: string[] }> {
  const problems: Issue[] = []
  const warnings: Issue[] = []
  const conflicts: string[] = []
  let companyId = body.companyId ?? null
  let partyId = body.partyId ?? null
  let siteId: string | null = null

  // From an RMA line decided Repair: the garment is here.
  const line = body.returnLineId
    ? await db.returnLine.findUnique({
        where: { id: body.returnLineId },
        select: {
          id: true,
          seq: true,
          size: true,
          serial: true,
          description: true,
          reasonNote: true,
          conditionNote: true,
          receivedQuantity: true,
          receivedAt: true,
          disposition: true,
          goodsOutcome: true,
          rma: { select: { id: true, number: true, companyId: true, siteId: true, partyId: true, receivedAt: true } },
          receipt: { select: { customerDdtNumber: true, customerDdtDate: true } },
          salesOrderLine: { select: { styleId: true, colourwayId: true } },
          invoiceLine: { select: { salesOrderLine: { select: { styleId: true, colourwayId: true } } } },
        },
      })
    : null
  if (body.returnLineId && (!line || !mayOn(context, SALES_REPAIRS_MANAGE, line.rma))) throw new NotFoundError('Return line not found.')
  const lineLabel = line ? `line ${line.seq} of ${line.rma.number}` : null
  if (line) {
    if (!sameOrMissing(body.companyId, line.rma.companyId)) problems.push({ path: 'body/companyId', message: `${lineLabel} is of another company.` })
    if (!sameOrMissing(body.partyId, line.rma.partyId)) problems.push({ path: 'body/partyId', message: `${lineLabel} is of another customer.` })
    companyId = line.rma.companyId
    partyId = line.rma.partyId
    siteId = line.rma.siteId
    if (line.disposition === null) problems.push({ path: 'body/returnLineId', message: `Decide ${lineLabel} first: a repair order is made for a line decided Repair.` })
    else if (line.disposition !== 'REPAIR' || line.goodsOutcome !== 'REPAIR') problems.push({ path: 'body/returnLineId', message: `${lineLabel} is decided ${line.disposition.toLowerCase().replace('_', ' ')}: a repair order is made for a line decided Repair.` })
    if (line.receivedQuantity < 1) problems.push({ path: 'body/returnLineId', message: `Nothing of ${lineLabel} arrived yet.` })
    else {
      const live = await db.repairOrder.findMany({ where: { returnLineId: line.id, stage: { not: 'CANCELLED' } }, select: { number: true }, orderBy: { number: 'asc' } })
      if (live.length >= line.receivedQuantity) {
        conflicts.push(`${lineLabel} brought back ${line.receivedQuantity} garment${line.receivedQuantity === 1 ? '' : 's'}: ${live.map((row) => row.number).join(', ')} ${live.length === 1 ? 'is' : 'are'} made for ${line.receivedQuantity === 1 ? 'it' : 'them'} already.`)
      }
    }
  }

  // From a complaint (a service case) of the same company and customer.
  const complaint = body.complaintId
    ? await db.complaint.findUnique({ where: { id: body.complaintId }, select: { id: true, number: true, companyId: true, partyId: true, status: true, description: true, styleId: true, size: true, serial: true } })
    : null
  if (body.complaintId && (!complaint || !mayOn(context, SALES_REPAIRS_MANAGE, complaint))) throw new NotFoundError('Complaint not found.')
  if (complaint) {
    if ((companyId && complaint.companyId !== companyId) || (partyId && complaint.partyId !== partyId)) problems.push({ path: 'body/complaintId', message: `Complaint ${complaint.number} is of another ${companyId && complaint.companyId !== companyId ? 'company' : 'customer'}.` })
    if (complaint.status === 'CLOSED') problems.push({ path: 'body/complaintId', message: `Complaint ${complaint.number} is closed.` })
    companyId = companyId ?? complaint.companyId
    partyId = partyId ?? complaint.partyId
  }

  if (!companyId) problems.push({ path: 'body/companyId', message: 'Name the company the garment is repaired for (or make it from a return line or a complaint).' })
  if (!partyId) problems.push({ path: 'body/partyId', message: 'Name the customer whose garment it is.' })
  if (!companyId || !partyId) return { plan: null, problems, conflicts }
  const company = isUuid(companyId) ? await db.company.findUnique({ where: { id: companyId }, select: { id: true } }) : null
  if (!company) throw new NotFoundError('Company not found.')
  const party = isUuid(partyId) ? await db.party.findUnique({ where: { id: partyId }, select: { id: true, companyId: true, roles: true, status: true, legalName: true } }) : null
  if (!party || (party.companyId !== null && party.companyId !== companyId)) throw new NotFoundError('Customer not found.')
  if (!line && !party.roles.includes('CUSTOMER') && !party.roles.includes('BRAND')) problems.push({ path: 'body/partyId', message: 'Not a customer: a repair is made for a customer’s garment.' })
  if (!line && party.status === 'ARCHIVED') problems.push({ path: 'body/partyId', message: `${party.legalName} is archived.` })

  // The repairing site: named, else the RMA's, else the company's only active plant.
  let siteCode = ''
  if (body.siteId) {
    const site = isUuid(body.siteId) ? await db.site.findUnique({ where: { id: body.siteId }, select: { id: true, code: true, companyId: true, status: true } }) : null
    if (!site || site.companyId !== companyId || site.status !== 'ACTIVE') problems.push({ path: 'body/siteId', message: 'An active site of the company.' })
    else if (line && site.id !== line.rma.siteId) problems.push({ path: 'body/siteId', message: `The garment of ${lineLabel} came back to another site: the repair is made there.` })
    else {
      siteId = site.id
      siteCode = site.code
    }
  } else if (siteId) {
    siteCode = (await db.site.findUniqueOrThrow({ where: { id: siteId }, select: { code: true } })).code
  } else {
    const plants = await db.site.findMany({ where: { companyId, status: 'ACTIVE', kind: 'PLANT' }, select: { id: true, code: true } })
    if (plants.length === 1) {
      siteId = plants[0]!.id
      siteCode = plants[0]!.code
    } else problems.push({ path: 'body/siteId', message: 'Name the site that repairs it.' })
  }
  if (siteId && !mayOn(context, SALES_REPAIRS_MANAGE, { companyId, siteId, partyId })) problems.push({ path: 'body/siteId', message: 'Your role does not reach this site.' })

  // The garment: what the body names, else the line's or the complaint's, checked against our serials.
  const lineStyle = line?.salesOrderLine ?? line?.invoiceLine?.salesOrderLine ?? null
  const garment = await planGarment(
    db,
    {
      serial: blank(body.serial) ?? blank(line?.serial) ?? blank(complaint?.serial),
      styleId: body.styleId ?? lineStyle?.styleId ?? complaint?.styleId ?? null,
      colourwayId: body.colourwayId ?? lineStyle?.colourwayId ?? null,
      size: blank(body.size) ?? blank(line?.size) ?? blank(complaint?.size),
    },
    partyId,
    problems,
    warnings,
  )
  if (garment.serial) {
    const open = await db.repairOrder.findFirst({ where: { serial: garment.serial, stage: { in: [...OPEN_REPAIR_STAGES] } }, select: { number: true, stage: true } })
    if (open) conflicts.push(`Repair ${open.number} is open for serial ${garment.serial} (${stageWords(open.stage as RepairStage)}): one repair at a time per garment.`)
  }

  const problem = blank(body.problem) ?? blank(line?.conditionNote) ?? blank(line?.reasonNote) ?? blank(complaint?.description) ?? null
  if (!problem) problems.push({ path: 'body/problem', message: "Say what is wrong, in the customer's words." })
  else if (problem.length > REPAIR_LIMITS.problem) problems.push({ path: 'body/problem', message: `At most ${REPAIR_LIMITS.problem} characters.` })
  if (tooLong(body.internalNote, REPAIR_LIMITS.internalNote)) problems.push({ path: 'body/internalNote', message: `At most ${REPAIR_LIMITS.internalNote} characters.` })
  const ownerId = body.ownerId ?? context.actorId
  if (body.ownerId) {
    const owner = isUuid(body.ownerId) ? await db.user.findUnique({ where: { id: body.ownerId }, select: { status: true } }) : null
    if (!owner || owner.status !== 'ACTIVE') problems.push({ path: 'body/ownerId', message: 'An active person of the office.' })
  }

  // The arrival: the RMA line's (its receipt's DDT), or with the customer now, or later (AWAITING_GOODS).
  let stage: RepairStage = 'AWAITING_GOODS'
  let receivedAt: Date | null = null
  let inboundDdtNumber: string | null = null
  let inboundDdtDate: BusinessDate | null = null
  if (line) {
    stage = 'RECEIVED'
    receivedAt = line.receivedAt ?? line.rma.receivedAt ?? now
    inboundDdtNumber = blank(body.received?.inboundDdtNumber) ?? line.receipt?.customerDdtNumber ?? null
    inboundDdtDate = body.received?.inboundDdtDate ?? (line.receipt?.customerDdtDate ? line.receipt.customerDdtDate.toISOString().slice(0, 10) : null)
  } else if (body.received) {
    stage = 'RECEIVED'
    receivedAt = body.received.at ? parseInstant(body.received.at) : now
    inboundDdtNumber = blank(body.received.inboundDdtNumber)
    inboundDdtDate = body.received.inboundDdtDate ?? null
  }
  // The line's arrival is the dock's record; only what the body types is checked.
  if (!line && receivedAt) arrivalProblems(receivedAt, inboundDdtNumber, inboundDdtDate, now, 'body/received', problems)
  if (stage === 'RECEIVED' && !inboundDdtNumber) warnings.push({ path: 'body/received/inboundDdtNumber', message: NO_INBOUND_DDT_WORDS })

  if (problems.length > 0 || !siteId || !problem) return { plan: null, problems, conflicts }
  return {
    plan: {
      companyId,
      siteId,
      siteCode,
      partyId,
      kind: body.kind ?? 'REPAIR',
      stage,
      serial: garment.serial,
      styleId: garment.styleId,
      colourwayId: garment.colourwayId,
      size: garment.size,
      problem,
      safetyCheckRequired: garment.safetyCheckRequired,
      receivedAt,
      inboundDdtNumber,
      inboundDdtDate,
      returnLineId: line?.id ?? null,
      returnLabel: lineLabel,
      complaintId: complaint?.id ?? null,
      complaintNumber: complaint?.number ?? null,
      ownerId,
      internalNote: blank(body.internalNote),
      garment: garment.garment,
      warnings,
    },
    problems,
    conflicts,
  }
}

/** The repair scope the caller must reach before anything is read: the body's company and customer (or its source's). */
function mayStart(context: OfficeContext, body: CreateBody): boolean {
  // A source is checked when it is read; without the company or the customer the plan only says what is missing.
  if (body.returnLineId || body.complaintId || !body.companyId || !body.partyId) return true
  return mayOn(context, SALES_REPAIRS_MANAGE, { companyId: body.companyId, partyId: body.partyId })
}

/** POST /sales/repairs/preview: the repair the body would make (its garment, problems, warnings). Writes nothing. */
export async function previewRepair(caller: CommandCaller, body: CreateBody) {
  const context = officeOf(caller)
  if (!mayStart(context, body)) throw new NotFoundError('Customer not found.')
  return caller.withClient(async (client) => {
    const now = serverClock.now()
    const { plan, problems, conflicts } = await planRepair(client, context, body, now)
    if (plan && !mayOn(context, SALES_REPAIRS_MANAGE, plan)) throw new NotFoundError('Customer not found.')
    const numbering = plan ? await client.numberSeries.findFirst({ where: { companyId: plan.companyId, kind: REPAIR_NUMBER_KIND, status: 'ACTIVE' }, select: { id: true } }) : null
    const all = [...problems, ...conflicts.map((message) => ({ path: 'conflict', message })), ...(plan && !numbering ? [{ path: 'company/numbering', message: 'The company has no active REPAIR number series: an administrator adds one under Numbering.' }] : [])]
    const history = plan?.serial ? await client.repairOrder.findMany({ where: { serial: plan.serial }, select: { id: true, number: true, stage: true, createdAt: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: REPAIR_LIMITS.history }) : []
    return {
      ok: plan !== null && all.length === 0,
      problems: all,
      warnings: plan?.warnings ?? [],
      draft: plan
        ? {
            companyId: plan.companyId,
            siteId: plan.siteId,
            partyId: plan.partyId,
            kind: plan.kind,
            stage: plan.stage,
            serial: plan.serial,
            styleId: plan.styleId,
            colourwayId: plan.colourwayId,
            size: plan.size,
            problem: plan.problem,
            safetyCheckRequired: plan.safetyCheckRequired,
            receivedAt: plan.receivedAt ? toUtcIso(plan.receivedAt) : null,
            inboundDdt: plan.inboundDdtNumber ? { number: plan.inboundDdtNumber, date: plan.inboundDdtDate } : null,
            returnLineId: plan.returnLineId,
            complaintId: plan.complaintId,
          }
        : null,
      garment: plan?.garment ? { madeOn: plan.garment.madeOn, workOrderNumber: plan.garment.workOrderNumber, batchNumber: plan.garment.batchNumber, forThisCustomer: plan.garment.partyId === null || plan.garment.partyId === plan.partyId } : null,
      history: history.map((row) => ({ id: row.id, number: row.number, stage: row.stage, createdAt: toUtcIso(row.createdAt) })),
    }
  })
}

const tenantOf = (tools: Pick<CommandTools, 'context'>): string => {
  const context = tools.context
  if (!('tenantId' in context) || !context.tenantId) throw new Error('a repair command needs a tenant context')
  return context.tenantId
}

/** The audit's picture of a repair's garment and arrival. */
export const garmentAudit = (row: { readonly serial: string | null; readonly styleId: string | null; readonly colourwayId: string | null; readonly size: string | null }) => ({ serial: row.serial, styleId: row.styleId, colourwayId: row.colourwayId, size: row.size })

/** POST /sales/repairs: the repair, numbered, in its first stage with its first stage event. */
export async function createRepair(caller: CommandCaller, body: CreateBody, idempotencyKey?: string): Promise<{ repair: RepairView; warnings: Issue[] }> {
  const context = officeOf(caller)
  if (!mayStart(context, body)) throw new NotFoundError('Customer not found.')
  const { result } = await command(caller, { name: 'repairs.create', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const tenantId = tenantOf(tools)
    // The line's row and the serial first: what the checks below count holds until the commit.
    if (body.returnLineId && isUuid(body.returnLineId)) await tx.$queryRaw`SELECT "id" FROM "ReturnLine" WHERE "id" = ${body.returnLineId}::uuid FOR UPDATE`
    const serial = blank(body.serial)
    if (serial) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.repair-serial', ${tenantId}::text, ${serial}::text), 0))`
    const { plan, problems, conflicts } = await planRepair(tx, context, body, now)
    if (problems.length > 0 || !plan) refuse(problems, 'The repair cannot be made like this.')
    if (!mayOn(context, SALES_REPAIRS_MANAGE, plan!)) throw new NotFoundError('Customer not found.')
    if (conflicts.length > 0) throw conflict(conflicts)
    // A serial found from the line or the complaint (not typed): its lock too, before the row is written.
    if (plan!.serial && plan!.serial !== serial) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.repair-serial', ${tenantId}::text, ${plan!.serial}::text), 0))`
      const open = await tx.repairOrder.findFirst({ where: { serial: plan!.serial, stage: { in: [...OPEN_REPAIR_STAGES] } }, select: { number: true, stage: true } })
      if (open) throw conflict([`Repair ${open.number} is open for serial ${plan!.serial} (${stageWords(open.stage as RepairStage)}): one repair at a time per garment.`])
    }
    const p = plan!
    const id = newId()
    const number = await allocateNumber(tools, { companyId: p.companyId, kind: REPAIR_NUMBER_KIND }, { type: 'RepairOrder', id, date: businessDate(now) })
    await tx.repairOrder.create({
      data: {
        id,
        companyId: p.companyId,
        siteId: p.siteId,
        partyId: p.partyId,
        number: number.formatted,
        kind: p.kind,
        returnLineId: p.returnLineId,
        complaintId: p.complaintId,
        serial: p.serial,
        styleId: p.styleId,
        colourwayId: p.colourwayId,
        size: p.size,
        problem: p.problem,
        stage: p.stage,
        receivedAt: p.receivedAt,
        inboundDdtNumber: p.inboundDdtNumber,
        inboundDdtDate: p.inboundDdtDate ? asDay(p.inboundDdtDate) : null,
        safetyCheckRequired: p.safetyCheckRequired,
        ownerId: p.ownerId,
        internalNote: p.internalNote,
        createdAt: now,
        updatedAt: now,
        createdById: context.actorId,
      },
      select: { id: true },
    })
    const note = p.returnLabel ? `Made from ${p.returnLabel}.` : p.complaintNumber ? `Made from complaint ${p.complaintNumber}.` : null
    await tx.repairStageEvent.create({
      data: { id: newId(), siteId: p.siteId, repairId: id, fromStage: null, stage: p.stage, repairVersion: 1, at: now, note, requestId: context.requestId, createdAt: now, createdById: context.actorId },
      select: { id: true },
    })
    tools.audit({
      recordType: 'RepairOrder',
      recordId: id,
      companyId: p.companyId,
      siteId: p.siteId,
      after: {
        number: number.formatted,
        partyId: p.partyId,
        kind: p.kind,
        stage: p.stage,
        returnLineId: p.returnLineId,
        complaintId: p.complaintId,
        ...garmentAudit(p),
        safetyCheckRequired: p.safetyCheckRequired,
        receivedAt: p.receivedAt ? toUtcIso(p.receivedAt) : null,
        inboundDdtNumber: p.inboundDdtNumber,
        inboundDdtDate: p.inboundDdtDate,
        ownerId: p.ownerId,
      },
    })
    tools.emit({
      type: 'repair.created',
      subject: id,
      companyId: p.companyId,
      siteId: p.siteId,
      payload: { repairId: id, number: number.formatted, partyId: p.partyId, kind: p.kind, stage: p.stage, returnLineId: p.returnLineId, complaintId: p.complaintId, safetyCheckRequired: p.safetyCheckRequired },
    })
    return { repairId: id, warnings: p.warnings }
  })
  return { repair: await recordOf(caller, result.repairId), warnings: result.warnings }
}

export async function recordOf(caller: CommandCaller, repairId: string): Promise<RepairView> {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const repair = await readRepair(client, repairId)
    if (!repair) throw new NotFoundError('Repair not found.')
    return repairView(client, repair, context)
  })
}
