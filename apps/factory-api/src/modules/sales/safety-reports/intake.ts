import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { ForbiddenError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { SALES_SAFETY_MANAGE } from '@nexus/factory-domain/sales/safety-reports/permissions'
import {
  ACCIDENT_LOG_RECORD,
  accidentNeeded,
  caseProblemOf,
  injuryKeyOf,
  intakeOutcomeOf,
  intakeProblems,
  SAFETY_INJURY_RECORD,
  SAFETY_NUMBER_KIND,
  SAFETY_REPORT_RECORD,
  type IntakeFacts,
  type SafetySource,
} from '@nexus/factory-domain/sales/safety-reports/rules'
import { SALES_SERVICE_MANAGE } from '@nexus/factory-domain/sales/service/permissions'
import { SERVICE_CASE_RECORD, SERVICE_NUMBER_KIND } from '@nexus/factory-domain/sales/service/rules'
import type { CommandTools } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { heldRoles } from '../../../platform/auth/roles/access'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { followInCommand } from '../../../platform/threads/followers'
import { blank, openInCommand, planGarment, planParty, refuse, type GarmentPlan } from '../service/open'
import { mayOn } from './access'
import { asDay, type Reader } from './store'

/**
 * The intake of a product-safety report (B-W2b-351; SAL-414, SAL-415, SAL-423), the same for every door — the public DoC page
 * (the batch from the QR; the tenant's system), a customer's portal (as the person) and the office (a call, a visit, a mail) —
 * in ONE command:
 *
 *   1. the number from the company's SAFETY_REPORT series (PSR-…), the day it reached us;
 *   2. its SAFETY service case (so it never waits in a mailbox): from the office through B-W2b-345's `openInCommand` (the
 *      person's own office context); from outside through the small path below (the tenant's system or the portal person;
 *      the case's channel LINK or PORTAL, no owner yet, priority HIGH). The case's words never repeat the reporter's: they
 *      name the report;
 *   3. the report NEW, the garment's serial and batch of ours named when they are ours (B-W2b-345's planGarment), the reporter
 *      as they gave themselves;
 *   4. whether someone was hurt, in its own table (one row per report, key injury:<report>), the words only when someone was
 *      hurt and with the consent (consentAt = the tick's time, this command's); audited without anything of the injury;
 *   5. an accident (or anyone hurt): the accident log's revision 1 (the day, the place, the product, nobody hurt or not known
 *      yet: quality grades it in a later revision);
 *   6. audit rows that never hold the reporter's words or personal data, and the events safety_report.received (+
 *      accident_log.revised, service_case.opened).
 */

export interface IntakeBody extends IntakeFacts {
  readonly styleId?: string | null | undefined
  readonly colourwayId?: string | null | undefined
  readonly wornAsIntended?: boolean | null | undefined
}

export type IntakeActor = { readonly kind: 'office'; readonly context: OfficeContext } | { readonly kind: 'portal'; readonly userId: string } | { readonly kind: 'system' }

export interface IntakeDoor {
  readonly source: SafetySource
  readonly companyId: string
  readonly partyId: string | null
  readonly contactId: string | null
  /** When it reached us (a mail: when the mail came; otherwise now). */
  readonly receivedAt: Date
  /** The quality person who follows it up (the office's choice; none from outside). */
  readonly ownerId: string | null
  readonly actor: IntakeActor
  /** What the QR gave on the public DoC page: the batch of ours, or the style. */
  readonly fixed?: { readonly batchNumber?: string | null; readonly styleId?: string | null }
}

export interface IntakePlan {
  readonly garment: GarmentPlan
  readonly partyId: string | null
  readonly contactId: string | null
  readonly accident: boolean
}

const OUTSIDE: readonly SafetySource[] = ['PUBLIC_LINK', 'PORTAL']
const clean = (value: string | null | undefined): string | null => blank(value)

/** An owner: an ACTIVE office person whose live roles may follow this report up (sales.safety.manage over it). */
export async function safetyOwnerProblems(db: Reader, context: OfficeContext, ownerId: string | null | undefined, scope: { readonly companyId: string; readonly partyId: string | null }, now: Date): Promise<Issue[]> {
  if (!ownerId) return []
  const user = isUuid(ownerId) ? await db.user.findUnique({ where: { id: ownerId }, select: { id: true, status: true, audience: true } }) : null
  if (!user || user.status !== 'ACTIVE' || user.audience !== 'OFFICE') return [{ path: 'body/ownerId', message: 'An active person of the office.' }]
  const grants = sessionGrants({ requireMfa: false }, await heldRoles(db, user.id, now), true)
  if (!can({ audience: 'office', tenantId: context.tenantId, grants }, SALES_SAFETY_MANAGE, { companyId: scope.companyId, ...(scope.partyId ? { partyId: scope.partyId } : {}) })) {
    return [{ path: 'body/ownerId', message: "This person's roles do not follow up product-safety reports of this company and customer." }]
  }
  return []
}

/** What the intake would write, or its problems (body/<field>) and warnings. Reads only. */
export async function planIntake(db: Reader, door: IntakeDoor, body: IntakeBody, now: Date): Promise<{ plan: IntakePlan | null; problems: Issue[]; warnings: Issue[] }> {
  const received: BusinessDate = businessDate(door.receivedAt)
  const outside = OUTSIDE.includes(door.source)
  // The batch the QR names counts as given (the public page of a released batch); a style's page asks the serial or the batch.
  const problems: Issue[] = [...intakeProblems({ ...body, batchNumber: clean(door.fixed?.batchNumber) ?? body.batchNumber }, received, outside)]
  const warnings: Issue[] = []
  const company = await db.company.findUnique({ where: { id: door.companyId }, select: { id: true } })
  if (!company) throw new NotFoundError('Company not found.')
  // The customer and its person: the office names them; the portal's are the session's; the public page names none.
  let partyId = door.partyId
  let contactId = door.contactId
  if (door.actor.kind === 'office' && (partyId || contactId)) {
    const { party, contact } = await planParty(db, company.id, partyId, contactId, problems)
    partyId = party?.id ?? null
    contactId = contact?.id ?? null
  }
  const asked = {
    serial: clean(body.serial),
    batchNumber: clean(door.fixed?.batchNumber) ?? clean(body.batchNumber),
    styleId: clean(door.fixed?.styleId) ?? clean(body.styleId),
    colourwayId: clean(body.colourwayId),
    size: clean(body.size),
  }
  const garment = await planGarment(db, asked, { companyId: company.id, partyId }, problems, warnings)
  if (door.actor.kind === 'office') problems.push(...(await safetyOwnerProblems(db, door.actor.context, door.ownerId, { companyId: company.id, partyId }, now)))
  return { plan: problems.length === 0 ? { garment, partyId, contactId, accident: accidentNeeded(body) } : null, problems, warnings }
}

export interface Received {
  readonly reportId: string
  readonly number: string
  readonly caseId: string
  readonly caseNumber: string
  readonly accidentLogged: boolean
  readonly warnings: Issue[]
}

const actorIdOf = (actor: IntakeActor): string | null => (actor.kind === 'office' ? actor.context.actorId : actor.kind === 'portal' ? actor.userId : null)

/** The report received inside the caller's command (every door). */
export async function intakeInCommand(tools: CommandTools, door: IntakeDoor, body: IntakeBody): Promise<Received> {
  const { tx, now } = tools
  const { plan, problems, warnings } = await planIntake(tx, door, body, now)
  if (problems.length > 0 || !plan) refuse(problems, 'The safety report cannot be sent like this.')
  const p = plan!
  const g = p.garment
  const createdById = actorIdOf(door.actor)
  const id = newId()
  const number = await allocateNumber(tools, { companyId: door.companyId, kind: SAFETY_NUMBER_KIND }, { type: SAFETY_REPORT_RECORD, id, date: businessDate(door.receivedAt) })

  // 2. Its SAFETY service case.
  const caseProblem = caseProblemOf(number.formatted, door.source)
  let caseId: string
  if (door.actor.kind === 'office') {
    const context = door.actor.context
    if (!mayOn(context, SALES_SERVICE_MANAGE, { companyId: door.companyId, partyId: p.partyId })) {
      throw new ForbiddenError('A safety report opens its SAFETY service case: your roles must also follow up service cases (sales.service.manage).')
    }
    const opened = await openInCommand(tools, context, {
      companyId: door.companyId,
      kind: 'SAFETY',
      channel: door.source === 'MAIL' ? 'MAIL' : 'OFFICE',
      partyId: p.partyId,
      contactId: p.contactId,
      serial: g.serial,
      batchNumber: g.batchNumber,
      styleId: g.styleId,
      colourwayId: g.colourwayId,
      size: g.size,
      problem: caseProblem,
      priority: 'HIGH',
      ownerId: door.ownerId,
      notifyCustomer: false,
    })
    caseId = opened.caseId
  } else {
    caseId = await openOutsideCaseInCommand(tools, door, p, caseProblem, createdById)
  }
  const caseNumber = (await tx.serviceCase.findUniqueOrThrow({ where: { id: caseId }, select: { number: true } })).number

  // 3. The report.
  const reporter = { name: clean(body.reporter?.name), email: clean(body.reporter?.email), phone: clean(body.reporter?.phone) }
  const occurredOn = body.occurredOn ?? null
  await tx.productSafetyReport.create({
    data: {
      id,
      companyId: door.companyId,
      number: number.formatted,
      source: door.source,
      receivedAt: door.receivedAt,
      partyId: p.partyId,
      contactId: p.contactId,
      reporterName: reporter.name,
      reporterEmail: reporter.email,
      reporterPhone: reporter.phone,
      styleId: g.styleId,
      colourwayId: g.colourwayId,
      size: g.size,
      serial: g.serial,
      garmentSerial: g.garmentSerial,
      batchNumber: g.batchNumber,
      garmentBatch: g.garmentBatch,
      occurredOn: occurredOn ? asDay(occurredOn) : null,
      whatHappened: body.whatHappened!.trim(),
      wornAsIntended: body.wornAsIntended ?? null,
      status: 'NEW',
      ownerId: door.ownerId,
      serviceCaseId: caseId,
      createdAt: now,
      updatedAt: now,
      createdById,
    },
    select: { id: true },
  })
  tools.audit({
    action: 'safetyReports.receive',
    recordType: SAFETY_REPORT_RECORD,
    recordId: id,
    companyId: door.companyId,
    // Never the reporter's words nor their personal data ("set"), nothing of an injury.
    after: {
      number: number.formatted,
      source: door.source,
      receivedAt: door.receivedAt.toISOString(),
      partyId: p.partyId,
      contactId: p.contactId,
      reporterName: reporter.name ? 'set' : null,
      reporterEmail: reporter.email ? 'set' : null,
      reporterPhone: reporter.phone ? 'set' : null,
      styleId: g.styleId,
      colourwayId: g.colourwayId,
      size: g.size,
      serial: g.serial,
      garmentSerial: g.garmentSerial,
      batchNumber: g.batchNumber,
      garmentBatch: g.garmentBatch,
      occurredOn,
      whatHappened: 'set',
      wornAsIntended: body.wornAsIntended ?? null,
      status: 'NEW',
      ownerId: door.ownerId,
      serviceCaseId: caseId,
    },
  })

  // 4. Whether someone was hurt, apart (when the report says).
  if (typeof body.injured === 'boolean') {
    const words = body.injured && body.injuryConsent === true ? clean(body.injuryWords) : null
    const injuryId = newId()
    await tx.productSafetyInjury.create({
      data: {
        id: injuryId,
        companyId: door.companyId,
        reportId: id,
        key: injuryKeyOf(id),
        injured: body.injured,
        consentAt: body.injured && body.injuryConsent === true ? now : null,
        injuryWords: words,
        createdAt: now,
        updatedAt: now,
        createdById,
      },
      select: { id: true },
    })
    // The audit row says that it was recorded, nothing of it.
    tools.audit({ action: 'safetyReports.injuryRecorded', recordType: SAFETY_INJURY_RECORD, recordId: injuryId, companyId: door.companyId, after: { reportId: id, recorded: true } })
  }

  // 5. An accident: the accident log's first revision.
  let accidentLogged = false
  if (p.accident && occurredOn && clean(body.place)) {
    const entryId = newId()
    const outcome = intakeOutcomeOf(body.injured)
    const entry = { serial: g.garmentSerial ?? g.serial, batchNumber: g.garmentBatch ?? g.batchNumber, place: clean(body.place)! }
    await tx.accidentLogEntry.create({
      data: { id: entryId, companyId: door.companyId, reportId: id, revision: 1, occurredOn: asDay(occurredOn), place: entry.place, styleId: g.styleId, serial: entry.serial, batchNumber: entry.batchNumber, outcome, createdAt: now, createdById },
      select: { id: true },
    })
    tools.audit({ action: 'safetyReports.logAccident', recordType: ACCIDENT_LOG_RECORD, recordId: entryId, companyId: door.companyId, after: { reportId: id, revision: 1, occurredOn, place: entry.place, styleId: g.styleId, serial: entry.serial, batchNumber: entry.batchNumber, outcome, authorityToldAt: null } })
    tools.emit({ type: 'accident_log.revised', subject: id, companyId: door.companyId, payload: { reportId: id, number: number.formatted, entryId, revision: 1, outcome, authorityTold: false } })
    accidentLogged = true
  }

  // Who recorded it in the office follows it, and its owner.
  if (door.actor.kind === 'office') {
    const context = door.actor.context
    const record = { type: SAFETY_REPORT_RECORD, id, companyId: door.companyId, siteId: null }
    if (await tx.user.findUnique({ where: { id: context.actorId }, select: { id: true } })) await followInCommand(tools, record, context.actorId, 'CREATOR', context.actorId)
    if (door.ownerId && door.ownerId !== context.actorId) await followInCommand(tools, record, door.ownerId, 'ASSIGNEE', context.actorId)
  }
  tools.emit({
    type: 'safety_report.received',
    subject: id,
    companyId: door.companyId,
    payload: { reportId: id, number: number.formatted, source: door.source, partyId: p.partyId, serviceCaseId: caseId, garmentSerial: g.garmentSerial, garmentBatch: g.garmentBatch, accidentLogged },
  })
  return { reportId: id, number: number.formatted, caseId, caseNumber, accidentLogged, warnings }
}

/**
 * The SAFETY case of a report from outside (the public DoC page as the tenant's system, the portal as the person): B-W2b-345's
 * openInCommand takes an office context and its owner rules; here the case is NEW with no owner (quality takes it from the
 * service list's New tile), priority HIGH, channel LINK or PORTAL, never telling the customer, its words naming the report.
 */
async function openOutsideCaseInCommand(tools: CommandTools, door: IntakeDoor, plan: IntakePlan, problem: string, createdById: string | null): Promise<string> {
  const { tx, now } = tools
  const g = plan.garment
  const id = newId()
  const channel: 'PORTAL' | 'LINK' = door.source === 'PORTAL' ? 'PORTAL' : 'LINK'
  const number = await allocateNumber(tools, { companyId: door.companyId, kind: SERVICE_NUMBER_KIND }, { type: SERVICE_CASE_RECORD, id, date: businessDate(now) })
  const facts = {
    companyId: door.companyId,
    number: number.formatted,
    kind: 'SAFETY' as const,
    channel,
    partyId: plan.partyId,
    contactId: plan.contactId,
    serial: g.serial,
    garmentSerial: g.garmentSerial,
    batchNumber: g.batchNumber,
    garmentBatch: g.garmentBatch,
    styleId: g.styleId,
    colourwayId: g.colourwayId,
    size: g.size,
    priority: 'HIGH' as const,
    status: 'NEW' as const,
    notifyCustomer: false,
    ownerId: null,
  }
  await tx.serviceCase.create({ data: { id, ...facts, problem, customerWants: null, createdAt: now, updatedAt: now, createdById }, select: { id: true } })
  tools.audit({ action: 'serviceCases.openFromSafetyReport', recordType: SERVICE_CASE_RECORD, recordId: id, companyId: door.companyId, after: facts })
  tools.emit({ type: 'service_case.opened', subject: id, companyId: door.companyId, payload: { caseId: id, number: number.formatted, partyId: plan.partyId, kind: 'SAFETY', channel, garmentSerial: g.garmentSerial, garmentBatch: g.garmentBatch } })
  return id
}
