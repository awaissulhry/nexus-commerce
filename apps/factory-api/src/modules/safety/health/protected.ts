import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { FILES_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { SAFETY_HEALTH_VIEW } from '@nexus/factory-domain/safety/health/permissions'
import {
  currentJudgement,
  HEALTH_LAW,
  HEALTH_LIMITS,
  judgementStateOf,
  PROTECTED_HEALTH_LAW,
  TASK_LIMITS_HINT,
  visitStateOf,
  type FitnessOutcome,
  type JudgementState,
  type VisitCancelReason,
  type VisitStatus,
  type VisitType,
  type VoidReason,
} from '@nexus/factory-domain/safety/health/rules'
import { command, type CommandCaller } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { downloadFile, systemCallerOf } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { roleNeedsOf } from '../rolesheets/needs'
import { askedPeople, assertMay, dateOf, dayOf, may, officeOf, peopleScope, placeCaller, todayOf } from './access'
import { judgementFactsOf } from './facts'
import { copiesOf, doctorNames, PERSON_SELECT, personOut, userNames, type Client } from './store'

/**
 * The protected reads of the health page (B-W2b-135; QHS-256 "Strict access to health-related records", GDPR arts. 5(2), 9, 32;
 * design plant.health "Every view is recorded and visible to the DPO", "Every open of a row is recorded"; B-W2b-91's view log):
 * the ONLY routes that answer a person's name beside a health fact or a judgement's values. safety.health.view over the
 * person's company and site; each read is a command that writes the view first (ProtectedView: who looked, at whose record,
 * what, when) and the values are read AFTER it commits and answered as they stand: a command's answer is kept in its receipt,
 * so no value ever enters one (B-W2b-77's rule, as B-W2b-125's incidents).
 *
 *   POST /safety/health/visits/list                     the due list with names (HEALTH_VISIT_LIST, LIST, one per company)
 *   POST /safety/health/visits/print                    the visit list for the doctor: names, roles, types, risks, no judgement
 *                                                       (HEALTH_VISIT_LIST, PRINT, one per company)
 *   POST /safety/health/visits/:visitId/open            one visit (HEALTH_VISIT, OPEN)
 *   POST /safety/health/judgements/show                 the judgements' people and outcomes on the page's rows (FITNESS_JUDGEMENT,
 *                                                       OPEN, one per row: each row's values were shown)
 *   POST /safety/health/judgements/:judgementId/open    one judgement (FITNESS_JUDGEMENT, OPEN)
 *   POST /safety/health/judgements/:id/copy/:fileId/open   the doctor's copy (FITNESS_JUDGEMENT, COPY), a presigned GET
 *
 * A view is recorded for an office user only (ProtectedView.viewerId); nothing here is open to the floor, a partner or a link.
 * The anonymised judgement list (./judgements.ts) and the tiles (./frame.ts) carry no person and record nothing.
 */

interface ViewRow {
  readonly recordType: 'HEALTH_VISIT' | 'FITNESS_JUDGEMENT' | 'HEALTH_VISIT_LIST'
  readonly recordId: string | null
  readonly employeeId: string | null
  readonly companyId: string
  readonly what: 'OPEN' | 'LIST' | 'COPY' | 'PRINT'
}

type ViewCommand = 'safety.listHealthVisits' | 'safety.printHealthVisits' | 'safety.proposeHealthVisits' | 'safety.openHealthVisit' | 'safety.showFitnessJudgements' | 'safety.openFitnessJudgement' | 'safety.openJudgementCopy' | 'safety.openExitVisit'

/**
 * Writes the views (one command: the view log and an audit row per company: what and how many, never a person, a type or an
 * outcome; the view log keeps whose data it was).
 */
export async function recordViews(caller: CommandCaller, context: OfficeContext, name: ViewCommand, views: readonly ViewRow[]): Promise<void> {
  if (views.length === 0) return
  await command(caller, { name, input: { views: views.length } }, async (tools) => {
    await tools.tx.protectedView.createMany({ data: views.map((view) => ({ id: newId(), companyId: view.companyId, recordType: view.recordType, recordId: view.recordId, employeeId: view.employeeId, what: view.what, viewerId: context.actorId, viewedAt: tools.now })) })
    for (const companyId of [...new Set(views.map((view) => view.companyId))]) {
      const own = views.filter((view) => view.companyId === companyId)
      tools.audit({ action: name, recordType: 'Company', recordId: companyId, companyId, after: { what: own[0]!.what, records: own[0]!.recordType, views: own.length } })
    }
    return { recorded: views.length }
  })
}

// ---- visits ---------------------------------------------------------------------------------------------------------------------

export const VISIT_READ = {
  id: true,
  companyId: true,
  employeeId: true,
  type: true,
  dueOn: true,
  planId: true,
  roleSheetId: true,
  absenceDays: true,
  status: true,
  bookedOn: true,
  bookedPlace: true,
  bookedAt: true,
  bookedById: true,
  doneOn: true,
  cancelledAt: true,
  cancelledById: true,
  cancelReason: true,
  version: true,
  employee: { select: PERSON_SELECT },
  roleSheet: { select: { id: true, code: true, name: true } },
} as const satisfies Prisma.HealthVisitSelect
type VisitRead = Prisma.HealthVisitGetPayload<{ select: typeof VISIT_READ }>

function visitRow(row: VisitRead, today: BusinessDate) {
  return {
    id: row.id,
    companyId: row.companyId,
    employee: personOut(row.employee),
    role: row.roleSheet,
    type: row.type as VisitType,
    dueOn: dayOf(row.dueOn),
    status: row.status as VisitStatus,
    state: visitStateOf({ status: row.status as VisitStatus, dueOn: dayOf(row.dueOn), bookedOn: row.bookedOn ? dayOf(row.bookedOn) : null }, today),
    booked: row.bookedOn ? { on: dayOf(row.bookedOn), place: row.bookedPlace } : null,
    doneOn: row.doneOn ? dayOf(row.doneOn) : null,
    version: row.version,
  }
}

const STATUS_OF = { open: ['DUE', 'BOOKED'], done: ['DONE'], cancelled: ['CANCELLED'], all: ['DUE', 'BOOKED', 'DONE', 'CANCELLED'] } as const

export interface VisitListBody {
  readonly companyId?: string | undefined
  readonly siteId?: string | undefined
  readonly employeeId?: string | undefined
  readonly status?: keyof typeof STATUS_OF | undefined
  readonly type?: VisitType | undefined
  readonly from?: BusinessDate | undefined
  readonly to?: BusinessDate | undefined
  readonly offset?: number | undefined
  readonly limit?: number | undefined
}

/** POST /safety/health/visits/list: the due list (open visits by due day, by default). */
export async function listVisits(caller: CommandCaller, body: VisitListBody, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  const limit = body.limit ?? HEALTH_LIMITS.list
  const where: Prisma.HealthVisitWhereInput = {
    employee: { AND: [peopleScope(context, SAFETY_HEALTH_VIEW), askedPeople(body)] },
    status: { in: [...STATUS_OF[body.status ?? 'open']] },
    ...(body.type ? { type: body.type } : {}),
    ...(body.from || body.to ? { dueOn: { ...(body.from ? { gte: dateOf(body.from) } : {}), ...(body.to ? { lte: dateOf(body.to) } : {}) } } : {}),
  }
  // The rows' ids and companies first (nothing of them shown), then the views, then the values of exactly those rows.
  const found = await caller.withClient((client) => client.healthVisit.findMany({ where, orderBy: [{ dueOn: 'asc' }, { id: 'asc' }], skip: body.offset ?? 0, take: limit + 1, select: { id: true, companyId: true } }))
  const page = found.slice(0, limit)
  await recordViews(caller, context, 'safety.listHealthVisits', [...new Set(page.map((row) => row.companyId))].map((companyId) => ({ recordType: 'HEALTH_VISIT_LIST', recordId: null, employeeId: null, companyId, what: 'LIST' })))
  const rows = page.length === 0 ? [] : await caller.withClient((client) => client.healthVisit.findMany({ where: { id: { in: page.map((row) => row.id) } }, orderBy: [{ dueOn: 'asc' }, { id: 'asc' }], select: VISIT_READ }))
  return { today, visits: rows.map((row) => visitRow(row, today)), more: found.length > limit, recorded: page.length > 0 }
}

/** POST /safety/health/visits/print: the visit list for the doctor (names, roles, visit types, risks; never a judgement). */
export async function printVisits(caller: CommandCaller, body: { readonly companyId?: string | undefined; readonly siteId?: string | undefined; readonly visitIds?: readonly string[] | undefined }, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  const where: Prisma.HealthVisitWhereInput = {
    employee: { AND: [peopleScope(context, SAFETY_HEALTH_VIEW), askedPeople(body)] },
    status: { in: ['DUE', 'BOOKED'] },
    ...(body.visitIds ? { id: { in: [...body.visitIds] } } : {}),
  }
  const found = await caller.withClient((client) => client.healthVisit.findMany({ where, orderBy: [{ dueOn: 'asc' }, { id: 'asc' }], take: HEALTH_LIMITS.list, select: { id: true, companyId: true } }))
  await recordViews(caller, context, 'safety.printHealthVisits', [...new Set(found.map((row) => row.companyId))].map((companyId) => ({ recordType: 'HEALTH_VISIT_LIST', recordId: null, employeeId: null, companyId, what: 'PRINT' })))
  const rows = found.length === 0 ? [] : await caller.withClient((client) => client.healthVisit.findMany({ where: { id: { in: found.map((row) => row.id) } }, orderBy: [{ employee: { lastName: 'asc' } }, { dueOn: 'asc' }, { id: 'asc' }], select: VISIT_READ }))
  const needs = await caller.withClient((client) => roleNeedsOf(client, rows.map((row) => row.roleSheetId ?? row.employee.roleSheetId).filter((value): value is string => value !== null)))
  return {
    today,
    visits: rows.map((row) => {
      const role = needs.get(row.roleSheetId ?? row.employee.roleSheetId ?? '')
      return { ...visitRow(row, today), risks: role ? [...role.surveillanceNeeds, ...role.risks] : [] }
    }),
    recorded: found.length > 0,
    law: HEALTH_LAW,
  }
}

/** POST /safety/health/visits/:visitId/open. */
export async function openVisit(caller: CommandCaller, visitId: string, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  const known = isUuid(visitId) ? await caller.withClient((client) => client.healthVisit.findUnique({ where: { id: visitId }, select: { id: true, companyId: true, employeeId: true, employee: { select: { companyId: true, siteId: true } } } })) : null
  if (!known) throw new NotFoundError('Visit not found.')
  assertMay(context, SAFETY_HEALTH_VIEW, known.employee, 'Visit')
  await recordViews(caller, context, 'safety.openHealthVisit', [{ recordType: 'HEALTH_VISIT', recordId: known.id, employeeId: known.employeeId, companyId: known.companyId, what: 'OPEN' }])
  return caller.withClient(async (client) => {
    const row = (await client.healthVisit.findUnique({ where: { id: visitId }, select: VISIT_READ }))!
    const users = await userNames(client, [row.bookedById, row.cancelledById])
    const judgement = await client.fitnessJudgement.findFirst({ where: { visitId: row.id, voidedAt: null }, select: { id: true } })
    const needs = await roleNeedsOf(client, [row.roleSheetId ?? row.employee.roleSheetId].filter((value): value is string => value !== null))
    const role = needs.get(row.roleSheetId ?? row.employee.roleSheetId ?? '')
    return {
      today,
      visit: {
        ...visitRow(row, today),
        planId: row.planId,
        absenceDays: row.absenceDays,
        booked: row.bookedOn && row.bookedAt ? { on: dayOf(row.bookedOn), place: row.bookedPlace, at: row.bookedAt.toISOString(), by: row.bookedById ? { id: row.bookedById, name: users.get(row.bookedById) ?? '' } : null } : null,
        cancelled: row.cancelledAt && row.cancelReason ? { at: row.cancelledAt.toISOString(), by: row.cancelledById ? { id: row.cancelledById, name: users.get(row.cancelledById) ?? '' } : null, reason: row.cancelReason as VisitCancelReason } : null,
        judgementId: judgement?.id ?? null,
        risks: role ? [...role.surveillanceNeeds] : [],
      },
      recorded: true,
      law: PROTECTED_HEALTH_LAW,
    }
  })
}

// ---- judgements -----------------------------------------------------------------------------------------------------------------

const JUDGEMENT_READ = {
  id: true,
  companyId: true,
  employeeId: true,
  visitId: true,
  outcome: true,
  taskLimits: true,
  unfitUntil: true,
  judgedOn: true,
  expiresOn: true,
  doctorAppointmentId: true,
  voidedAt: true,
  voidedById: true,
  voidReason: true,
  version: true,
  createdAt: true,
  employee: { select: PERSON_SELECT },
  visit: { select: { id: true, type: true, doneOn: true } },
} as const satisfies Prisma.FitnessJudgementSelect
type JudgementRead = Prisma.FitnessJudgementGetPayload<{ select: typeof JUDGEMENT_READ }>

/** Each person's current judgement id (the newest not voided), for the judgements' states. */
export async function currentIdsOf(client: Client, employeeIds: readonly string[]): Promise<Map<string, string | null>> {
  const people = [...new Set(employeeIds)]
  if (people.length === 0) return new Map()
  const rows = await client.fitnessJudgement.findMany({ where: { employeeId: { in: people } }, select: { id: true, employeeId: true, outcome: true, judgedOn: true, expiresOn: true, unfitUntil: true, voidedAt: true, createdAt: true } })
  const facts = rows.map(judgementFactsOf)
  return new Map(people.map((employeeId) => [employeeId, currentJudgement(facts.filter((row) => row.employeeId === employeeId))?.id ?? null]))
}

export function judgementRow(row: { id: string; companyId: string; employeeId: string; visitId: string | null; judgedOn: Date; expiresOn: Date | null; voidedAt: Date | null; version: number }, currentIds: ReadonlyMap<string, string | null>, copies: ReadonlySet<string>, today: BusinessDate) {
  return {
    id: row.id,
    companyId: row.companyId,
    judgedOn: dayOf(row.judgedOn),
    expiresOn: row.expiresOn ? dayOf(row.expiresOn) : null,
    state: judgementStateOf({ id: row.id, expiresOn: row.expiresOn ? dayOf(row.expiresOn) : null, voided: row.voidedAt !== null }, currentIds.get(row.employeeId) ?? null, today) as JudgementState,
    fromVisit: row.visitId !== null,
    hasCopy: copies.has(row.id),
    version: row.version,
  }
}

const valuesOf = (row: JudgementRead) => ({ employee: personOut(row.employee), outcome: row.outcome as FitnessOutcome, taskLimits: row.taskLimits, unfitUntil: row.unfitUntil ? dayOf(row.unfitUntil) : null })

/** POST /safety/health/judgements/show: the people and values of the page's rows (those the caller may see). */
export async function showJudgements(caller: CommandCaller, body: { readonly judgementIds: readonly string[] }, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  const asked = [...new Set(body.judgementIds.filter(isUuid))]
  const known = (await caller.withClient((client) => client.fitnessJudgement.findMany({ where: { id: { in: asked } }, select: { id: true, companyId: true, employeeId: true, employee: { select: { companyId: true, siteId: true } } } }))).filter((row) => may(context, SAFETY_HEALTH_VIEW, row.employee))
  if (known.length === 0) return { judgements: [], recorded: false }
  await recordViews(caller, context, 'safety.showFitnessJudgements', known.map((row) => ({ recordType: 'FITNESS_JUDGEMENT', recordId: row.id, employeeId: row.employeeId, companyId: row.companyId, what: 'OPEN' })))
  return caller.withClient(async (client) => {
    const rows = await client.fitnessJudgement.findMany({ where: { id: { in: known.map((row) => row.id) } }, orderBy: [{ judgedOn: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }], select: JUDGEMENT_READ })
    const currentIds = await currentIdsOf(client, rows.map((row) => row.employeeId))
    const copies = new Set((await copiesOf(client, rows.map((row) => row.id))).map((file) => file.recordId))
    return { judgements: rows.map((row) => ({ ...judgementRow(row, currentIds, copies, today), ...valuesOf(row) })), recorded: true }
  })
}

/** POST /safety/health/judgements/:judgementId/open. */
export async function openJudgement(caller: CommandCaller, judgementId: string, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  const known = isUuid(judgementId) ? await caller.withClient((client) => client.fitnessJudgement.findUnique({ where: { id: judgementId }, select: { id: true, companyId: true, employeeId: true, employee: { select: { companyId: true, siteId: true } } } })) : null
  if (!known) throw new NotFoundError('Judgement not found.')
  assertMay(context, SAFETY_HEALTH_VIEW, known.employee, 'Judgement')
  await recordViews(caller, context, 'safety.openFitnessJudgement', [{ recordType: 'FITNESS_JUDGEMENT', recordId: known.id, employeeId: known.employeeId, companyId: known.companyId, what: 'OPEN' }])
  return caller.withClient(async (client) => {
    const row = (await client.fitnessJudgement.findUnique({ where: { id: judgementId }, select: JUDGEMENT_READ }))!
    const currentIds = await currentIdsOf(client, [row.employeeId])
    const files = await copiesOf(client, [row.id])
    const users = await userNames(client, [row.voidedById])
    const doctors = await doctorNames(client, [row.doctorAppointmentId])
    return {
      today,
      judgement: {
        ...judgementRow(row, currentIds, new Set(files.map((file) => file.recordId)), today),
        ...valuesOf(row),
        visit: row.visit ? { id: row.visit.id, type: row.visit.type as VisitType, doneOn: row.visit.doneOn ? dayOf(row.visit.doneOn) : null } : null,
        doctor: row.doctorAppointmentId ? { id: row.doctorAppointmentId, name: doctors.get(row.doctorAppointmentId) ?? '' } : null,
        voided: row.voidedAt && row.voidReason ? { at: row.voidedAt.toISOString(), by: row.voidedById ? { id: row.voidedById, name: users.get(row.voidedById) ?? '' } : null, reason: row.voidReason as VoidReason } : null,
        copies: files.map((file) => ({ fileId: file.id, name: file.originalName, availableAt: file.availableAt?.toISOString() ?? null })),
        recordedAt: row.createdAt.toISOString(),
      },
      recorded: true,
      law: PROTECTED_HEALTH_LAW,
      hint: TASK_LIMITS_HINT,
    }
  })
}

/** POST /safety/health/judgements/:judgementId/copy/:fileId/open: the doctor's copy (a COPY view recorded), a presigned GET. */
export async function openCopy(request: FastifyRequest, judgementId: string, fileId: string) {
  const context = officeOf(request)
  const known = isUuid(judgementId) ? await request.withClient((client) => client.fitnessJudgement.findUnique({ where: { id: judgementId }, select: { id: true, companyId: true, employeeId: true, employee: { select: { companyId: true, siteId: true } } } })) : null
  if (!known) throw new NotFoundError('Judgement not found.')
  assertMay(context, SAFETY_HEALTH_VIEW, known.employee, 'Judgement')
  const file = isUuid(fileId) ? await request.withClient((client) => client.storedFile.findFirst({ where: { id: fileId, recordType: 'FitnessJudgement', recordId: known.id, status: 'AVAILABLE' }, select: { id: true } })) : null
  if (!file) throw new NotFoundError('File not found.')
  await recordViews(request, context, 'safety.openJudgementCopy', [{ recordType: 'FITNESS_JUDGEMENT', recordId: known.id, employeeId: known.employeeId, companyId: known.companyId, what: 'COPY' }])
  const reader = placeCaller(request, context.tenantId, { companyId: known.employee.companyId, siteId: known.employee.siteId }, [FILES_READ])
  return { download: await downloadFile(processFiles(), { caller: reader, system: systemCallerOf(request) }, file.id, { viaModule: true }) }
}

