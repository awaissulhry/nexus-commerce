import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { SALES_SERVICE_MANAGE } from '@nexus/factory-domain/sales/service/permissions'
import {
  buyerOfParty,
  CASE_LIMITS,
  factProblems,
  legalGuaranteeEndOf,
  OPEN_CASE_STATUSES,
  SERVICE_CASE_RECORD,
  SERVICE_NUMBER_KIND,
  warrantyCheckOf,
  type CaseKind,
  type CasePriority,
  type CaseWish,
} from '@nexus/factory-domain/sales/service/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { heldRoles } from '../../../platform/auth/roles/access'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { followInCommand } from '../../../platform/threads/followers'
import { mayOn, officeOf } from './access'
import { asDay, batchOf, deliveredOnOf, garmentOf, garmentSummary, partyOf, type BatchFacts, type GarmentFacts, type Reader } from './store'
import { caseRecordOf, type CaseView } from './view'

/**
 * Opening a warranty or service case (B-W2b-345; design service.new "Customer or rider · Serial (scan or type) · Problem ·
 * Channel", from the band or an inbound mail). The office takes it from a call, a mail or a visit (OFFICE, MAIL, PHONE; the
 * portal's and a claim link's doors are Later, SAL-447):
 *
 *   preview  POST /sales/service/cases/preview (all optional): a scanned serial alone finds our garment (style, colourway,
 *            size, made on, its batch, the customer it was made for, the shipment it left on and its delivery day); a batch
 *            finds its work order and its deliveries to the customer; the warranty check of those facts (the legal guarantee
 *            against the factory's own, in words); the other open cases of the same garment (a duplicate?); problems and
 *            warnings. Writes nothing.
 *   open     POST /sales/service/cases: ONE command: the number from the company's SERVICE_CASE series (SVC-…), NEW, the
 *            garment's serial and batch of ours named (garmentSerial, garmentBatch) when they are ours, the facts left out
 *            filled from it (style, colourway, size, the batch), the delivery day and the legal guarantee's last day from the
 *            facts unless typed, the customer told at each status change only when asked (`notifyCustomer`, default off, and
 *            only with a contact that has an e-mail); its maker follows it, and its owner (default: the maker);
 *            service_case.opened.
 */

export interface OpenBody {
  readonly companyId?: string | undefined
  readonly kind?: CaseKind | undefined
  readonly channel?: 'OFFICE' | 'MAIL' | 'PHONE' | undefined
  readonly partyId?: string | null | undefined
  readonly contactId?: string | null | undefined
  readonly serial?: string | null | undefined
  readonly batchNumber?: string | null | undefined
  readonly styleId?: string | null | undefined
  readonly colourwayId?: string | null | undefined
  readonly size?: string | null | undefined
  readonly problem?: string | undefined
  readonly customerWants?: CaseWish | null | undefined
  readonly priority?: CasePriority | undefined
  readonly ownerId?: string | null | undefined
  readonly deliveredOn?: BusinessDate | null | undefined
  readonly legalGuaranteeEndsOn?: BusinessDate | null | undefined
  readonly factoryGuaranteeEndsOn?: BusinessDate | null | undefined
  readonly notifyCustomer?: boolean | undefined
  readonly internalNote?: string | null | undefined
}

export const blank = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

export function refuse(problems: readonly Issue[], words: string): never {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems)
}

/** The garment facts a case names, resolved against our serials and batches (problems and warnings at body/<field>). */
export interface GarmentPlan {
  readonly serial: string | null
  readonly garmentSerial: string | null
  readonly batchNumber: string | null
  readonly garmentBatch: string | null
  readonly styleId: string | null
  readonly colourwayId: string | null
  readonly size: string | null
  readonly garment: GarmentFacts | null
  readonly batch: BatchFacts | null
}

export async function planGarment(
  db: Reader,
  asked: { readonly serial: string | null; readonly batchNumber: string | null; readonly styleId: string | null; readonly colourwayId: string | null; readonly size: string | null },
  scope: { readonly companyId: string; readonly partyId: string | null },
  problems: Issue[],
  warnings: Issue[],
): Promise<GarmentPlan> {
  const garment = await garmentOf(db, asked.serial)
  if (asked.serial && !garment) warnings.push({ path: 'body/serial', message: `No garment of ours carries serial ${asked.serial}: the style, colour and size are as typed.` })
  if (garment && scope.companyId && garment.companyId !== scope.companyId) warnings.push({ path: 'body/serial', message: `Serial ${garment.serial} was made by another company of the group.` })
  if (garment && scope.partyId && garment.partyId !== null && garment.partyId !== scope.partyId && garment.shipment?.partyId !== scope.partyId) warnings.push({ path: 'body/serial', message: `Serial ${garment.serial} was made for another customer's order: check the label.` })
  if (garment && asked.styleId && asked.styleId !== garment.styleId) problems.push({ path: 'body/styleId', message: `Serial ${garment.serial} is a garment of another style: leave the style out, or check the serial.` })
  // The batch: as typed, else the serial's; it must be the serial's when both are ours (the guard's garment agreement).
  const batchNumber = asked.batchNumber ?? garment?.batchNumber ?? null
  const batch = await batchOf(db, batchNumber, scope.partyId)
  if (asked.batchNumber && !batch) warnings.push({ path: 'body/batchNumber', message: `No work order of ours has batch ${asked.batchNumber}: the batch is as typed.` })
  if (garment && batch && garment.batchNumber !== batch.batchNumber) problems.push({ path: 'body/batchNumber', message: `Serial ${garment.serial} is of batch ${garment.batchNumber ?? '(none)'}, not ${batch.batchNumber}.` })
  if (!garment && batch && asked.styleId && asked.styleId !== batch.styleId) problems.push({ path: 'body/styleId', message: `Batch ${batch.batchNumber} is of another style: leave the style out, or check the batch.` })
  const styleId = asked.styleId ?? garment?.styleId ?? batch?.styleId ?? null
  const colourwayId = asked.colourwayId ?? (garment && (!asked.styleId || asked.styleId === garment.styleId) ? garment.colourwayId : null)
  const size = asked.size ?? garment?.size ?? null
  if (asked.styleId && !(isUuid(asked.styleId) && (await db.style.findUnique({ where: { id: asked.styleId }, select: { id: true } })))) problems.push({ path: 'body/styleId', message: 'Not a style of the tenant.' })
  if (colourwayId) {
    if (!styleId) problems.push({ path: 'body/colourwayId', message: 'A colourway is named with its style.' })
    else if (!(isUuid(colourwayId) && (await db.colourway.findFirst({ where: { id: colourwayId, styleId }, select: { id: true } })))) problems.push({ path: 'body/colourwayId', message: 'Not a colourway of the style.' })
  }
  return { serial: asked.serial, garmentSerial: garment?.serial ?? null, batchNumber, garmentBatch: batch?.batchNumber ?? null, styleId, colourwayId, size, garment, batch }
}

/** The customer and its contact a case names (problems at body/partyId, body/contactId). */
export async function planParty(db: Reader, companyId: string, partyId: string | null, contactId: string | null, problems: Issue[]) {
  const party = partyId && isUuid(partyId) ? await partyOf(db, partyId) : null
  if (partyId && (!party || (party.companyId !== null && party.companyId !== companyId))) throw new NotFoundError('Customer not found.')
  if (party && !party.roles.includes('CUSTOMER') && !party.roles.includes('BRAND')) problems.push({ path: 'body/partyId', message: 'Not a customer: a service case is about a garment we sold.' })
  if (party && party.status === 'ARCHIVED') problems.push({ path: 'body/partyId', message: `${party.legalName} is archived.` })
  let contact: { id: string; name: string; email: string | null; language: string | null } | null = null
  if (contactId) {
    if (!party) problems.push({ path: 'body/contactId', message: 'A contact is named with their customer.' })
    else {
      const row = isUuid(contactId) ? await db.partyContact.findUnique({ where: { id: contactId }, select: { id: true, partyId: true, status: true, name: true, email: true, language: true, erasedAt: true } }) : null
      if (!row || row.partyId !== party.id || row.status !== 'ACTIVE' || row.erasedAt !== null) problems.push({ path: 'body/contactId', message: 'An active contact of this customer.' })
      else contact = { id: row.id, name: row.name, email: row.email, language: row.language }
    }
  }
  return { party, contact }
}

/** An owner: an ACTIVE office person whose live roles may follow this case up (sales.service.manage over it). */
export async function ownerProblems(db: Reader, context: OfficeContext, ownerId: string | null | undefined, scope: { readonly companyId: string; readonly partyId: string | null }, now: Date): Promise<Issue[]> {
  if (!ownerId) return []
  const user = isUuid(ownerId) ? await db.user.findUnique({ where: { id: ownerId }, select: { id: true, status: true } }) : null
  if (!user || user.status !== 'ACTIVE') return [{ path: 'body/ownerId', message: 'An active person of the office.' }]
  const grants = sessionGrants({ requireMfa: false }, await heldRoles(db, user.id, now), true)
  const actor = { audience: 'office' as const, tenantId: context.tenantId, grants }
  if (!can(actor, SALES_SERVICE_MANAGE, { companyId: scope.companyId, ...(scope.partyId ? { partyId: scope.partyId } : {}) })) return [{ path: 'body/ownerId', message: "This person's roles do not follow up service cases of this company and customer." }]
  return []
}

/** The other open cases of the same garment (or batch, when no serial of ours is named): a duplicate? */
export async function othersOf(db: Reader, plan: Pick<GarmentPlan, 'garmentSerial' | 'garmentBatch'>, exceptId: string | null) {
  const where = plan.garmentSerial ? { garmentSerial: plan.garmentSerial } : plan.garmentBatch ? { garmentBatch: plan.garmentBatch } : null
  if (!where) return []
  return db.serviceCase.findMany({
    where: { ...where, status: { in: [...OPEN_CASE_STATUSES] }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true, number: true, status: true, kind: true, createdAt: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: CASE_LIMITS.others,
  })
}

interface OpenPlan {
  readonly companyId: string
  readonly kind: CaseKind
  readonly channel: 'OFFICE' | 'MAIL' | 'PHONE'
  readonly partyId: string | null
  readonly contactId: string | null
  readonly garment: GarmentPlan
  readonly problem: string
  readonly deliveredOn: BusinessDate | null
  readonly legalGuaranteeEndsOn: BusinessDate | null
  readonly factoryGuaranteeEndsOn: BusinessDate | null
  readonly ownerId: string
}

async function planOpen(db: Reader, context: OfficeContext, body: OpenBody, now: Date) {
  const today = businessDate(now)
  const problems: Issue[] = []
  const warnings: Issue[] = []
  if (!body.companyId) problems.push({ path: 'body/companyId', message: 'Name the company the case is for.' })
  if (!body.kind) problems.push({ path: 'body/kind', message: 'Say what kind of case it is.' })
  if (!body.channel) problems.push({ path: 'body/channel', message: 'Say how it reached us.' })
  problems.push(...factProblems(body, today, true))
  const companyId = body.companyId ?? null
  const company = companyId && isUuid(companyId) ? await db.company.findUnique({ where: { id: companyId }, select: { id: true } }) : null
  if (companyId && !company) throw new NotFoundError('Company not found.')
  const partyId = blank(body.partyId)
  const scope = { companyId: companyId ?? '', partyId }
  const { party, contact } = company ? await planParty(db, company.id, partyId, blank(body.contactId), problems) : { party: null, contact: null }
  const garment = await planGarment(db, { serial: blank(body.serial), batchNumber: blank(body.batchNumber), styleId: blank(body.styleId), colourwayId: blank(body.colourwayId), size: blank(body.size) }, scope, problems, warnings)
  if ((body.kind === 'WARRANTY' || body.kind === 'REPAIR') && !garment.serial && !garment.batchNumber) warnings.push({ path: 'body/serial', message: "The warranty check needs the garment's serial or batch: scan its label when you have it." })
  // The warranty days: typed, else from the facts (the serial's shipment, the batch's only delivery; a consumer's 2 years).
  const delivery = deliveredOnOf(garment.garment, garment.batch)
  // A day our records give after today (a shipment dated ahead) is no delivery yet: said, never used.
  const derived = delivery.day && delivery.day <= today ? delivery.day : null
  const deliveredOn = body.deliveredOn === undefined ? derived : body.deliveredOn
  if (body.deliveredOn === undefined && delivery.day && !derived) warnings.push({ path: 'body/deliveredOn', message: `Our records date its shipment ${delivery.day}, after today: type the delivery day.` })
  if (body.deliveredOn === undefined && derived && !delivery.delivered) warnings.push({ path: 'body/deliveredOn', message: `The delivery day is not recorded: the day it left (${derived}) is used; type the delivery day when you know it.` })
  if (body.deliveredOn === undefined && !delivery.day && delivery.days.length > 1) warnings.push({ path: 'body/deliveredOn', message: `Batch ${garment.batchNumber} was delivered to the customer on ${delivery.days.length} days (${delivery.days.join(', ')}): type the day of the garments claimed.` })
  const buyer = buyerOfParty(party)
  const legalGuaranteeEndsOn = body.legalGuaranteeEndsOn === undefined ? legalGuaranteeEndOf(buyer, deliveredOn ?? null) : body.legalGuaranteeEndsOn
  const factoryGuaranteeEndsOn = body.factoryGuaranteeEndsOn ?? null
  problems.push(...factProblems({ deliveredOn, legalGuaranteeEndsOn, factoryGuaranteeEndsOn }, today, false).filter((issue) => !problems.some((seen) => seen.path === issue.path)))
  if (body.notifyCustomer && !contact?.email) problems.push({ path: 'body/notifyCustomer', message: "The customer is told at each status change by e-mail to the case's contact: name a contact with an e-mail first." })
  if (company) problems.push(...(await ownerProblems(db, context, blank(body.ownerId), scope, now)))
  const others = await othersOf(db, garment, null)
  for (const other of others) warnings.push({ path: 'body/serial', message: `Case ${other.number} is open for this ${garment.garmentSerial ? 'garment' : 'batch'} (${other.status.toLowerCase().replace('_', ' ')}).` })
  const check = warrantyCheckOf({ today, buyer, deliveredOn: deliveredOn ?? null, legalGuaranteeEndsOn: legalGuaranteeEndsOn ?? null, factoryGuaranteeEndsOn })
  const plan: OpenPlan | null =
    problems.length === 0 && company && body.kind && body.channel
      ? {
          companyId: company.id,
          kind: body.kind,
          channel: body.channel,
          partyId: party?.id ?? null,
          contactId: contact?.id ?? null,
          garment,
          problem: body.problem!.trim(),
          deliveredOn: deliveredOn ?? null,
          legalGuaranteeEndsOn: legalGuaranteeEndsOn ?? null,
          factoryGuaranteeEndsOn,
          ownerId: blank(body.ownerId) ?? context.actorId,
        }
      : null
  return { plan, problems, warnings, garment, delivery, check, others, party }
}

const mayStart = (context: OfficeContext, body: OpenBody): boolean => !body.companyId || mayOn(context, SALES_SERVICE_MANAGE, { companyId: body.companyId, partyId: blank(body.partyId) })

/** POST /sales/service/cases/preview */
export async function previewCase(caller: CommandCaller, body: OpenBody) {
  const context = officeOf(caller)
  if (!mayStart(context, body)) throw new NotFoundError('Customer not found.')
  return caller.withClient(async (client) => {
    const now = serverClock.now()
    const { plan, problems, warnings, garment, delivery, check, others } = await planOpen(client, context, body, now)
    const numbering = body.companyId && isUuid(body.companyId) ? await client.numberSeries.findFirst({ where: { companyId: body.companyId, kind: SERVICE_NUMBER_KIND, status: 'ACTIVE' }, select: { id: true } }) : null
    const all = [...problems, ...(body.companyId && !numbering ? [{ path: 'company/numbering', message: 'The company has no active SERVICE_CASE number series: an administrator adds one under Numbering.' }] : [])]
    // The customer the garment left for, offered when the case names none (the screen fills it on a yes).
    const shippedTo = !body.partyId && garment.garment?.shipment && mayOn(context, SALES_SERVICE_MANAGE, { companyId: garment.garment.shipment.companyId, partyId: garment.garment.shipment.partyId }) ? garment.garment.shipment.partyId : null
    return {
      ok: plan !== null && all.length === 0,
      problems: all,
      warnings,
      draft: {
        styleId: garment.styleId,
        colourwayId: garment.colourwayId,
        size: garment.size,
        batchNumber: garment.batchNumber,
        garmentSerial: garment.garmentSerial,
        garmentBatch: garment.garmentBatch,
        partyId: blank(body.partyId) ?? shippedTo,
        deliveredOn: plan?.deliveredOn ?? (body.deliveredOn === undefined ? (delivery.day && delivery.day <= businessDate(now) ? delivery.day : null) : (body.deliveredOn ?? null)),
        legalGuaranteeEndsOn: check.legal.endsOn,
        factoryGuaranteeEndsOn: check.factory.endsOn,
      },
      garment: garmentSummary(garment),
      warranty: check,
      others: others.map((other) => ({ id: other.id, number: other.number, status: other.status, kind: other.kind, openedAt: toUtcIso(other.createdAt) })),
    }
  })
}

/** POST /sales/service/cases */
export async function openCase(caller: CommandCaller, body: OpenBody, idempotencyKey?: string): Promise<{ case: CaseView; warnings: Issue[] }> {
  const context = officeOf(caller)
  if (!mayStart(context, body)) throw new NotFoundError('Customer not found.')
  const { result } = await command(caller, { name: 'serviceCases.open', idempotencyKey, input: body }, async (tools) => openInCommand(tools, context, body))
  return { case: await caseRecordOf(caller, result.caseId), warnings: result.warnings }
}

/** The case opened inside the caller's command (POST /sales/service/cases; B-W2b-351 may open a report's SAFETY case with it). */
export async function openInCommand(tools: CommandTools, context: OfficeContext, body: OpenBody): Promise<{ caseId: string; warnings: Issue[] }> {
  const { tx, now } = tools
  const { plan, problems, warnings } = await planOpen(tx, context, body, now)
  if (problems.length > 0 || !plan) refuse(problems, 'The case cannot be opened like this.')
  const p = plan!
  if (!mayOn(context, SALES_SERVICE_MANAGE, p)) throw new NotFoundError('Customer not found.')
  const id = newId()
  const number = await allocateNumber(tools, { companyId: p.companyId, kind: SERVICE_NUMBER_KIND }, { type: SERVICE_CASE_RECORD, id, date: businessDate(now) })
  const g = p.garment
  await tx.serviceCase.create({
    data: {
      id,
      companyId: p.companyId,
      number: number.formatted,
      kind: p.kind,
      channel: p.channel,
      partyId: p.partyId,
      contactId: p.contactId,
      serial: g.serial,
      garmentSerial: g.garmentSerial,
      batchNumber: g.batchNumber,
      garmentBatch: g.garmentBatch,
      styleId: g.styleId,
      colourwayId: g.colourwayId,
      size: g.size,
      problem: p.problem,
      customerWants: body.customerWants ?? null,
      priority: body.priority ?? 'NORMAL',
      status: 'NEW',
      deliveredOn: p.deliveredOn ? asDay(p.deliveredOn) : null,
      legalGuaranteeEndsOn: p.legalGuaranteeEndsOn ? asDay(p.legalGuaranteeEndsOn) : null,
      factoryGuaranteeEndsOn: p.factoryGuaranteeEndsOn ? asDay(p.factoryGuaranteeEndsOn) : null,
      notifyCustomer: body.notifyCustomer ?? false,
      ownerId: p.ownerId,
      internalNote: blank(body.internalNote),
      createdAt: now,
      updatedAt: now,
      createdById: context.actorId,
    },
    select: { id: true },
  })
  tools.audit({
    recordType: SERVICE_CASE_RECORD,
    recordId: id,
    companyId: p.companyId,
    // Never the customer's words nor the internal note: the fields and the facts.
    after: {
      number: number.formatted,
      kind: p.kind,
      channel: p.channel,
      partyId: p.partyId,
      contactId: p.contactId,
      serial: g.serial,
      garmentSerial: g.garmentSerial,
      batchNumber: g.batchNumber,
      garmentBatch: g.garmentBatch,
      styleId: g.styleId,
      colourwayId: g.colourwayId,
      size: g.size,
      customerWants: body.customerWants ?? null,
      priority: body.priority ?? 'NORMAL',
      status: 'NEW',
      deliveredOn: p.deliveredOn,
      legalGuaranteeEndsOn: p.legalGuaranteeEndsOn,
      factoryGuaranteeEndsOn: p.factoryGuaranteeEndsOn,
      notifyCustomer: body.notifyCustomer ?? false,
      ownerId: p.ownerId,
    },
  })
  // Its maker follows it, and its owner (an office person; a test caller without a person row follows nothing).
  const record = { type: SERVICE_CASE_RECORD, id, companyId: p.companyId, siteId: null }
  if (await tx.user.findUnique({ where: { id: context.actorId }, select: { id: true } })) await followInCommand(tools, record, context.actorId, 'CREATOR', context.actorId)
  if (p.ownerId !== context.actorId) await followInCommand(tools, record, p.ownerId, 'ASSIGNEE', context.actorId)
  tools.emit({ type: 'service_case.opened', subject: id, companyId: p.companyId, payload: { caseId: id, number: number.formatted, partyId: p.partyId, kind: p.kind, channel: p.channel, garmentSerial: g.garmentSerial, garmentBatch: g.garmentBatch } })
  return { caseId: id, warnings }
}
