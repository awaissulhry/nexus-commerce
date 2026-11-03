import type { BodyPart, BodySide, IncidentKind, InjuryNature, Involvement, PersonInput, Where } from '@nexus/factory-domain/safety/incidents/rules'
import { anonymousRefusal, INCIDENT_LIMITS, injuryProblems, personProblems, refusalOf, reportRefusal, whatOf } from '@nexus/factory-domain/safety/incidents/rules'
import { SAFETY_INCIDENTS_REPORT } from '@nexus/factory-domain/safety/incidents/permissions'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import type { FloorContext } from '../../../core/context'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { actorIdOf, anonymousCaller, anonymousKey, assertMayWrite, floorOf, officeOf, problemsError, refuse } from './access'

/**
 * Reporting an incident, a near miss or a hazard (B-W2b-125; QHS-265; design floor.incident "three taps", plant.incidents
 * pop-up "Report an incident"), ONE command each:
 *
 *   office  POST /safety/incidents         safety.incidents.report over the site: the report with its people (written, never
 *                                          read back: their values are protected), reportedVia OFFICE + reportedById
 *   floor   POST /safety/floor/incidents   floor.work at the tablet's site (anyone at the station, as a help call); kind,
 *                                          where ("here" = the tablet's station), optional words and people; reportedVia FLOOR
 *                                          + the worker and the tablet, or WITHOUT A NAME (a near miss or a hazard only, no
 *                                          people): then the command runs as the system actor in the floor scope
 *                                          (access.ts anonymousCaller): no worker, no tablet in any row it writes
 *   queue   floor-sync `safety.incident.report` (platform/floor-sync/kinds.ts): a named floor report kept offline, applied
 *                                          when the tablet is back; an anonymous one is refused there (the queue's own ledger
 *                                          names the tablet), the tablet sends it online
 *
 * The number comes from the company's INCIDENT series in the same command (a floor document kind: the tablet numbers it from
 * the same series). The floor writes with createMany (it may insert, never read back: no RETURNING) and only the columns it is
 * granted. Photos follow through ./files.ts.
 */

export interface PersonBody {
  readonly involvement: Involvement
  readonly employeeId?: string | undefined
  readonly outsideName?: string | undefined
  readonly bodyParts?: readonly BodyPart[] | undefined
  readonly bodySide?: BodySide | null | undefined
  readonly nature?: InjuryNature | null | undefined
  readonly firstAidGiven?: boolean | undefined
  readonly sentToHospital?: boolean | undefined
}

export interface OfficeReportBody {
  readonly companyId: string
  readonly siteId: string
  readonly kind: IncidentKind
  readonly occurredAt: string
  readonly what: string
  readonly areaId?: string | undefined
  readonly stationId?: string | undefined
  readonly machineId?: string | undefined
  readonly place?: string | undefined
  readonly immediateAction?: string | undefined
  readonly maintenanceRequestId?: string | undefined
  readonly people?: readonly PersonBody[] | undefined
}

export interface FloorPersonBody {
  /** ME: the worker signed in; WORKER: another worker of the site (a badge scanned); OUTSIDE: someone from outside by name. */
  readonly who: 'ME' | 'WORKER' | 'OUTSIDE'
  readonly workerId?: string | undefined
  readonly outsideName?: string | undefined
  readonly involvement: Involvement
  readonly bodyParts?: readonly BodyPart[] | undefined
  readonly bodySide?: BodySide | null | undefined
  readonly nature?: InjuryNature | null | undefined
  readonly firstAidGiven?: boolean | undefined
  readonly sentToHospital?: boolean | undefined
}

export interface FloorReportBody {
  readonly kind: IncidentKind
  /** The tablet's time of the tap (a queued report keeps it); later than now is taken as now (the tablet's clock). */
  readonly occurredAt?: string | undefined
  readonly what?: string | undefined
  /** The words a three-tap report stores when nothing was typed (the tablet's language). */
  readonly language?: 'en' | 'it' | undefined
  /** "Here: this station" (the tablet's own station). */
  readonly here?: boolean | undefined
  readonly areaId?: string | undefined
  readonly stationId?: string | undefined
  readonly machineId?: string | undefined
  readonly place?: string | undefined
  readonly immediateAction?: string | undefined
  readonly anonymous?: boolean | undefined
  readonly people?: readonly FloorPersonBody[] | undefined
}

export interface ReportAnswer {
  readonly incident: { readonly id: string; readonly number: string; readonly kind: IncidentKind; readonly status: 'OPEN'; readonly anonymous: boolean; readonly version: number }
}

interface PersonRow {
  readonly id: string
  readonly involvement: Involvement
  readonly employeeId: string | null
  readonly outsideName: string | null
  readonly bodyParts: BodyPart[]
  readonly bodySide: BodySide | null
  readonly nature: InjuryNature | null
  readonly firstAidGiven: boolean
  readonly sentToHospital: boolean
}

interface Draft {
  readonly id: string
  readonly companyId: string
  readonly siteId: string
  readonly kind: IncidentKind
  readonly occurredAt: Date
  readonly what: string
  readonly where: Where
  readonly immediateAction: string | null
  readonly maintenanceRequestId: string | null
  readonly via: 'FLOOR' | 'OFFICE'
  readonly anonymous: boolean
  readonly reportedByWorkerId: string | null
  readonly reportedById: string | null
  readonly deviceId: string | null
  readonly createdById: string | null
  readonly people: readonly PersonRow[]
}

const text = (value: string | null | undefined, longest: number): string | null => {
  const words = (value ?? '').trim()
  return words === '' ? null : words.slice(0, longest)
}

/** The where's references are the site's (the references refuse another site's; this answers first, in words). */
async function checkWhere(tools: CommandTools, siteId: string, where: Where, maintenanceRequestId: string | null): Promise<void> {
  const { tx } = tools
  const wrong =
    (where.areaId && !(await tx.orgArea.findFirst({ where: { id: where.areaId, siteId }, select: { id: true } }))) ||
    (where.stationId && !(await tx.station.findFirst({ where: { id: where.stationId, siteId }, select: { id: true } }))) ||
    (where.machineId && !(await tx.machine.findFirst({ where: { id: where.machineId, siteId }, select: { id: true } })))
  if (wrong) refuse(refusalOf('WHERE_OTHER_SITE', 'where'))
  if (maintenanceRequestId && !(await tx.maintenanceRequest.findFirst({ where: { id: maintenanceRequestId, siteId }, select: { id: true } }))) refuse(refusalOf('REQUEST_OTHER_SITE', 'maintenanceRequestId'))
}

/** Writes the report in the caller's command: its number, the incident, its people, the audit row, incident.reported. */
export async function insertReportInCommand(tools: CommandTools, draft: Draft, fromRequestId: string | null = null): Promise<{ readonly id: string; readonly number: string }> {
  const { tx, now } = tools
  const issued = await allocateNumber(tools, { companyId: draft.companyId, kind: 'INCIDENT' }, { type: 'Incident', id: draft.id })
  await tx.incident.createMany({
    data: [
      {
        id: draft.id,
        companyId: draft.companyId,
        siteId: draft.siteId,
        number: issued.formatted,
        kind: draft.kind,
        occurredAt: draft.occurredAt,
        reportedAt: now,
        what: draft.what,
        areaId: draft.where.areaId ?? null,
        stationId: draft.where.stationId ?? null,
        machineId: draft.where.machineId ?? null,
        place: text(draft.where.place, INCIDENT_LIMITS.place),
        immediateAction: draft.immediateAction,
        maintenanceRequestId: draft.maintenanceRequestId,
        reportedVia: draft.via,
        reporterAnonymous: draft.anonymous,
        reportedByWorkerId: draft.reportedByWorkerId,
        deviceId: draft.deviceId,
        status: 'OPEN',
        createdAt: now,
        updatedAt: now,
        // Office-only columns: the floor is not granted them (a floor insert names none).
        ...(draft.via === 'OFFICE' ? { reportedById: draft.reportedById, createdById: draft.createdById } : {}),
      },
    ],
  })
  if (draft.people.length > 0) {
    await tx.incidentPerson.createMany({
      data: draft.people.map((person) => ({
        id: person.id,
        siteId: draft.siteId,
        incidentId: draft.id,
        involvement: person.involvement,
        employeeId: person.employeeId,
        outsideName: person.outsideName,
        bodyParts: person.bodyParts,
        bodySide: person.bodySide,
        nature: person.nature,
        firstAidGiven: person.firstAidGiven,
        sentToHospital: person.sentToHospital,
        createdAt: now,
        updatedAt: now,
        ...(draft.via === 'OFFICE' ? { createdById: draft.createdById } : {}),
      })),
    })
  }
  // The audit row names no person and no injury (protected): the people as counts.
  tools.audit({
    action: 'safety.reportIncident',
    recordType: 'Incident',
    recordId: draft.id,
    companyId: draft.companyId,
    siteId: draft.siteId,
    after: {
      number: issued.formatted,
      kind: draft.kind,
      reportedVia: draft.via,
      anonymous: draft.anonymous,
      occurredAt: draft.occurredAt.toISOString(),
      areaId: draft.where.areaId ?? null,
      stationId: draft.where.stationId ?? null,
      machineId: draft.where.machineId ?? null,
      maintenanceRequestId: draft.maintenanceRequestId,
      people: draft.people.length,
      injured: draft.people.filter((person) => person.involvement === 'INJURED').length,
    },
  })
  tools.emit({
    type: 'incident.reported',
    subject: draft.id,
    companyId: draft.companyId,
    siteId: draft.siteId,
    payload: { incidentId: draft.id, number: issued.formatted, kind: draft.kind, reportedVia: draft.via, anonymous: draft.anonymous, fromRequestId },
  })
  return { id: draft.id, number: issued.formatted }
}

const personRow = (person: PersonInput): PersonRow => ({
  id: newId(),
  involvement: person.involvement,
  employeeId: person.employeeId ?? null,
  outsideName: text(person.outsideName, INCIDENT_LIMITS.outsideName),
  bodyParts: [...(person.bodyParts ?? [])],
  bodySide: person.bodySide ?? null,
  nature: person.nature ?? null,
  firstAidGiven: person.firstAidGiven ?? false,
  sentToHospital: person.sentToHospital ?? false,
})

function shapeProblems(people: readonly PersonInput[]): void {
  if (people.length > INCIDENT_LIMITS.people) throw new ValidationError(`At most ${INCIDENT_LIMITS.people} people in one report.`, [{ path: 'body/people', message: `At most ${INCIDENT_LIMITS.people}.` }])
  const problems = people.flatMap((person, index) => personProblems(person, `people/${index}`))
  if (problems.length > 0) throw problemsError(problems, 'The people involved are not valid.')
}

const toDate = (value: string, path: string): Date => {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new ValidationError('The time is not valid.', [{ path: `body/${path}`, message: 'Expected a time.' }])
  return date
}

/** POST /safety/incidents (office). */
export async function reportFromOffice(caller: CommandCaller, body: OfficeReportBody, idempotencyKey?: string): Promise<ReportAnswer & { readonly replayed: boolean }> {
  const context = officeOf(caller)
  const place = { companyId: body.companyId, siteId: body.siteId }
  assertMayWrite(context, SAFETY_INCIDENTS_REPORT, place, 'Incidents are reported from the office by a role that reports them (safety.incidents.report); anyone reports from a tablet.')
  const people = body.people ?? []
  shapeProblems(people)
  const occurredAt = toDate(body.occurredAt, 'occurredAt')
  const id = newId()
  const { result, replayed } = await command(caller, { name: 'safety.reportIncident', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const where: Where = { areaId: body.areaId, stationId: body.stationId, machineId: body.machineId, place: body.place }
    refuse(reportRefusal({ kind: body.kind, anonymous: false, via: 'OFFICE', people, where, occurredAt, now: new Date(now.getTime() + 60_000) }))
    const site = await tx.site.findUnique({ where: { id: body.siteId }, select: { companyId: true } })
    if (!site || site.companyId !== body.companyId) throw new ValidationError('The site is one of the company’s.', [{ path: 'body/siteId', message: 'A site of the company.' }])
    await checkWhere(tools, body.siteId, where, body.maintenanceRequestId ?? null)
    const employees = people.map((person) => person.employeeId).filter((value): value is string => Boolean(value))
    if (employees.length > 0) {
      const found = await tx.employee.findMany({ where: { id: { in: employees.filter(isUuid) }, companyId: body.companyId }, select: { id: true } })
      if (found.length !== new Set(employees).size) refuse(refusalOf('PERSON_OTHER_COMPANY', 'people'))
    }
    const actorId = actorIdOf(tools.context)
    const made = await insertReportInCommand(tools, {
      id,
      companyId: body.companyId,
      siteId: body.siteId,
      kind: body.kind,
      // A minute of the office clock's slack: never later than the report itself (the guard's rule).
      occurredAt: occurredAt.getTime() > now.getTime() ? now : occurredAt,
      what: body.what.trim().slice(0, INCIDENT_LIMITS.what),
      where,
      immediateAction: text(body.immediateAction, INCIDENT_LIMITS.immediateAction),
      maintenanceRequestId: body.maintenanceRequestId ?? null,
      via: 'OFFICE',
      anonymous: false,
      reportedByWorkerId: null,
      reportedById: actorId,
      deviceId: null,
      createdById: actorId,
      people: people.map(personRow),
    })
    return { incident: { id: made.id, number: made.number, kind: body.kind, status: 'OPEN' as const, anonymous: false, version: 1 } }
  })
  return { ...result, replayed }
}

/** The tablet's people as rows: ME and WORKER become the worker's employee (or their name while they have no employee record). */
async function floorPeople(tools: CommandTools, context: FloorContext, people: readonly FloorPersonBody[]): Promise<PersonRow[]> {
  const rows: PersonRow[] = []
  for (const [index, person] of people.entries()) {
    const injury = { involvement: person.involvement, bodyParts: person.bodyParts, bodySide: person.bodySide, nature: person.nature, firstAidGiven: person.firstAidGiven, sentToHospital: person.sentToHospital }
    if (person.who === 'OUTSIDE') {
      rows.push(personRow({ ...injury, outsideName: person.outsideName }))
      continue
    }
    const workerId = person.who === 'ME' ? context.actorId : person.workerId
    const worker = workerId && isUuid(workerId) ? await tools.tx.worker.findFirst({ where: { id: workerId, siteId: context.siteId, status: 'ACTIVE' }, select: { employeeId: true, displayName: true } }) : null
    if (!worker) throw new ValidationError('Name a worker of this site.', [{ path: `body/people/${index}/workerId`, message: 'A worker of this site.' }])
    rows.push(personRow(worker.employeeId ? { ...injury, employeeId: worker.employeeId } : { ...injury, outsideName: worker.displayName }))
  }
  return rows
}

/** POST /safety/floor/incidents, and the queue's `safety.incident.report` (queued: true). */
export async function reportFromFloor(request: CommandCaller, body: FloorReportBody, idempotencyKey: string | undefined, options: { readonly queued?: boolean } = {}): Promise<ReportAnswer & { readonly replayed: boolean }> {
  const context = floorOf(request)
  const anonymous = body.anonymous === true
  const floorPeopleBodies = body.people ?? []
  for (const [index, person] of floorPeopleBodies.entries()) {
    if (person.who === 'WORKER' && !person.workerId) throw new ValidationError('Name the worker.', [{ path: `body/people/${index}/workerId`, message: 'Required for a worker.' }])
    if (person.who !== 'OUTSIDE' && person.outsideName) throw new ValidationError('Someone from outside is named by name only.', [{ path: `body/people/${index}/outsideName`, message: 'Only for someone from outside.' }])
    if (person.who === 'OUTSIDE' && !(person.outsideName ?? '').trim()) throw new ValidationError('Name someone from outside.', [{ path: `body/people/${index}/outsideName`, message: 'Required for someone from outside.' }])
    if ((person.outsideName ?? '').trim().length > INCIDENT_LIMITS.outsideName) throw new ValidationError(`At most ${INCIDENT_LIMITS.outsideName} characters.`, [{ path: `body/people/${index}/outsideName`, message: `At most ${INCIDENT_LIMITS.outsideName} characters.` }])
  }
  if (floorPeopleBodies.length > INCIDENT_LIMITS.people) throw new ValidationError(`At most ${INCIDENT_LIMITS.people} people in one report.`, [{ path: 'body/people', message: `At most ${INCIDENT_LIMITS.people}.` }])
  const injuries = floorPeopleBodies.flatMap((person, index) => injuryProblems(person, `people/${index}`))
  if (injuries.length > 0) throw problemsError(injuries, 'The people involved are not valid.')
  const tapped = body.occurredAt ? toDate(body.occurredAt, 'occurredAt') : null
  if (idempotencyKey === undefined) throw new ValidationError('An Idempotency-Key is required for floor writes.', [{ path: 'headers/idempotency-key', message: 'Required.' }])
  // Checked before anything is written: an anonymous report from the queue, an injury without a name, people in one.
  refuse(anonymousRefusal({ kind: body.kind, anonymous, via: 'FLOOR', queued: options.queued === true, people: floorPeopleBodies }))
  const id = newId()
  const caller: CommandCaller = anonymous ? anonymousCaller(request, context, newId()) : request
  const key = anonymous ? anonymousKey(context, idempotencyKey) : idempotencyKey
  // An anonymous report keeps no tablet clock either (its skew would point at the tablet).
  const spec = { name: 'safety.reportIncident' as const, idempotencyKey: key, input: body, ...(tapped && !anonymous ? { deviceTime: tapped } : {}) }
  const { result, replayed } = await command(caller, spec, async (tools) => {
    const { tx, now } = tools
    const site = await tx.site.findUnique({ where: { id: context.siteId }, select: { companyId: true } })
    if (!site) throw new ValidationError('The tablet’s site is not found.', [{ path: 'site', message: 'Not found.' }])
    let stationId = body.stationId
    if (body.here) {
      const device = await tx.device.findUnique({ where: { id: context.deviceId }, select: { stationId: true } })
      stationId = device?.stationId ?? stationId
    }
    const where: Where = { areaId: body.areaId, stationId, machineId: body.machineId, place: body.place }
    const occurredAt = tapped && tapped.getTime() <= now.getTime() ? tapped : now
    refuse(reportRefusal({ kind: body.kind, anonymous, via: 'FLOOR', people: floorPeopleBodies, where, occurredAt, now }))
    await checkWhere(tools, context.siteId, where, null)
    const people = await floorPeople(tools, context, floorPeopleBodies)
    const made = await insertReportInCommand(tools, {
      id,
      companyId: site.companyId,
      siteId: context.siteId,
      kind: body.kind,
      occurredAt,
      what: whatOf(body.kind, body.what, body.language ?? 'it').slice(0, INCIDENT_LIMITS.what),
      where,
      immediateAction: text(body.immediateAction, INCIDENT_LIMITS.immediateAction),
      maintenanceRequestId: null,
      via: 'FLOOR',
      anonymous,
      reportedByWorkerId: anonymous ? null : context.actorId,
      reportedById: null,
      deviceId: anonymous ? null : context.deviceId,
      createdById: null,
      people,
    })
    return { incident: { id: made.id, number: made.number, kind: body.kind, status: 'OPEN' as const, anonymous, version: 1 } }
  })
  return { ...result, replayed }
}
