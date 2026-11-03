import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { SAFETY_INCIDENTS_PEOPLE, SAFETY_INCIDENTS_VIEW } from '@nexus/factory-domain/safety/incidents/permissions'
import { INCIDENT_LIMITS, personProblems, refusalOf, type BodyPart, type BodySide, type InjuryNature, type Involvement } from '@nexus/factory-domain/safety/incidents/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { assertVersion } from '../../people/employees/access'
import { actorIdOf, assertMay, assertMayWrite, officeOf, problemsError, refuse } from './access'

/**
 * The people involved, corrected in the office (B-W2b-125; QHS-270; design plant.incidents record "People involved": "Injured
 * person · body part · nature of injury · first aid given · sent to hospital"; GDPR art. 9), safety.incidents.people over
 * the incident, while it is OPEN, each one command:
 *
 *   POST /safety/incidents/:id/people                       add a person (of the company, or from outside by name)
 *   PATCH /safety/incidents/:id/people/:personId             correct them (at the version read)
 *   POST /safety/incidents/:id/people/:personId/remove       remove them (never while an INAIL filing names them)
 *
 * The answers carry ids and versions only, never a value (a command's answer is kept in its receipt); the audit rows name the
 * fields that changed, never their values. Reading them is ./protected.ts (each view recorded).
 */

const PEOPLE_WORDS = 'The people involved in an incident are kept by the safety roles and HR (safety.incidents.people).'

export interface PersonFields {
  readonly involvement: Involvement
  readonly employeeId?: string | null | undefined
  readonly outsideName?: string | null | undefined
  readonly bodyParts?: readonly BodyPart[] | undefined
  readonly bodySide?: BodySide | null | undefined
  readonly nature?: InjuryNature | null | undefined
  readonly firstAidGiven?: boolean | undefined
  readonly sentToHospital?: boolean | undefined
}

async function placeOf(caller: CommandCaller, incidentId: string) {
  if (!isUuid(incidentId)) throw new NotFoundError('Incident not found.')
  const row = await caller.withClient((db) => db.incident.findUnique({ where: { id: incidentId }, select: { companyId: true, siteId: true } }))
  if (!row) throw new NotFoundError('Incident not found.')
  return row
}

async function lockedOpen(tx: CommandTx, incidentId: string) {
  await tx.$queryRaw`SELECT id FROM "Incident" WHERE id = ${incidentId}::uuid FOR UPDATE`
  const row = await tx.incident.findUnique({ where: { id: incidentId }, select: { id: true, number: true, companyId: true, siteId: true, kind: true, status: true } })
  if (!row) throw new NotFoundError('Incident not found.')
  if (row.status !== 'OPEN') refuse(refusalOf('NOT_OPEN'))
  return row
}

type Incident = Awaited<ReturnType<typeof lockedOpen>>

/** The person's rules against the incident (the guard's, in words, first). */
async function checkPerson(tx: CommandTx, incident: Incident, fields: PersonFields, exceptId: string | null): Promise<void> {
  if (fields.involvement === 'INJURED' && incident.kind !== 'INJURY') refuse(refusalOf('INJURED_NOT_INJURY', 'involvement'))
  if (fields.employeeId) {
    const person = isUuid(fields.employeeId) ? await tx.employee.findFirst({ where: { id: fields.employeeId, companyId: incident.companyId }, select: { id: true } }) : null
    if (!person) refuse(refusalOf('PERSON_OTHER_COMPANY', 'employeeId'))
    const twice = await tx.incidentPerson.findFirst({ where: { incidentId: incident.id, employeeId: fields.employeeId, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } })
    if (twice) refuse(refusalOf('PERSON_TWICE', 'employeeId'))
  }
}

const rowData = (fields: PersonFields) => ({
  involvement: fields.involvement,
  employeeId: fields.employeeId ?? null,
  outsideName: fields.outsideName?.trim().slice(0, INCIDENT_LIMITS.outsideName) || null,
  bodyParts: fields.involvement === 'INJURED' ? [...(fields.bodyParts ?? [])] : [],
  bodySide: fields.involvement === 'INJURED' ? (fields.bodySide ?? null) : null,
  nature: fields.involvement === 'INJURED' ? (fields.nature ?? null) : null,
  firstAidGiven: fields.involvement === 'INJURED' ? (fields.firstAidGiven ?? false) : false,
  sentToHospital: fields.involvement === 'INJURED' ? (fields.sentToHospital ?? false) : false,
})

function peopleChanged(tools: CommandTools, incident: Incident): void {
  tools.emit({ type: 'incident.changed', subject: incident.id, companyId: incident.companyId, siteId: incident.siteId, payload: { incidentId: incident.id, number: incident.number, change: 'PEOPLE_CHANGED', status: 'OPEN' } })
}

async function guard(caller: CommandCaller, incidentId: string) {
  const context = officeOf(caller)
  const place = await placeOf(caller, incidentId)
  assertMay(context, SAFETY_INCIDENTS_VIEW, place)
  assertMayWrite(context, SAFETY_INCIDENTS_PEOPLE, place, PEOPLE_WORDS)
}

/** POST /safety/incidents/:id/people. */
export async function addPerson(caller: CommandCaller, incidentId: string, body: PersonFields, idempotencyKey?: string) {
  await guard(caller, incidentId)
  const problems = personProblems(body, 'person')
  if (problems.length > 0) throw problemsError(problems.map((problem) => ({ ...problem, path: problem.path.replace(/^person\//, '') })), 'The person is not valid.')
  const id = newId()
  const { result, replayed } = await command(caller, { name: 'safety.addIncidentPerson', idempotencyKey, input: { incidentId, ...body } }, async (tools) => {
    const incident = await lockedOpen(tools.tx, incidentId)
    await checkPerson(tools.tx, incident, body, null)
    await tools.tx.incidentPerson.create({ data: { id, siteId: incident.siteId, incidentId, ...rowData(body), createdAt: tools.now, updatedAt: tools.now, createdById: actorIdOf(tools.context) }, select: { id: true } })
    tools.audit({ action: 'safety.addIncidentPerson', recordType: 'IncidentPerson', recordId: id, companyId: incident.companyId, siteId: incident.siteId, after: { incidentId, involvement: body.involvement, of: body.employeeId ? 'EMPLOYEE' : 'OUTSIDE' } })
    peopleChanged(tools, incident)
    return { person: { id, version: 1 } }
  })
  return { ...result, replayed }
}

/** PATCH /safety/incidents/:id/people/:personId: the whole person as it should be now (at the version read). */
export async function editPerson(caller: CommandCaller, incidentId: string, personId: string, body: PersonFields & { readonly version: number }, idempotencyKey?: string) {
  await guard(caller, incidentId)
  if (!isUuid(personId)) throw new NotFoundError('Person not found.')
  const problems = personProblems(body, 'person')
  if (problems.length > 0) throw problemsError(problems.map((problem) => ({ ...problem, path: problem.path.replace(/^person\//, '') })), 'The person is not valid.')
  const { result, replayed } = await command(caller, { name: 'safety.editIncidentPerson', idempotencyKey, input: { incidentId, personId, ...body } }, async (tools) => {
    const incident = await lockedOpen(tools.tx, incidentId)
    const before = await tools.tx.incidentPerson.findFirst({ where: { id: personId, incidentId }, select: { version: true, involvement: true, employeeId: true, outsideName: true, bodyParts: true, bodySide: true, nature: true, firstAidGiven: true, sentToHospital: true, _count: { select: { inailFilings: true } } } })
    if (!before) throw new NotFoundError('Person not found.')
    assertVersion('person', before.version, body.version)
    await checkPerson(tools.tx, incident, body, personId)
    const data = rowData(body)
    // A filing names an injured person of the company: they stay that while it does (the filing's own guard reads them at insert only).
    if (before._count.inailFilings > 0 && (data.involvement !== 'INJURED' || data.employeeId !== before.employeeId)) refuse(refusalOf('PERSON_HAS_FILING', 'involvement'))
    const changedFields = (Object.keys(data) as (keyof typeof data)[]).filter((field) => JSON.stringify(data[field]) !== JSON.stringify((before as Record<string, unknown>)[field]))
    await tools.tx.incidentPerson.update({ where: { id: personId }, data: { ...data, version: before.version + 1, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'safety.editIncidentPerson', recordType: 'IncidentPerson', recordId: personId, companyId: incident.companyId, siteId: incident.siteId, after: { changed: changedFields } })
    peopleChanged(tools, incident)
    return { person: { id: personId, version: before.version + 1 } }
  })
  return { ...result, replayed }
}

/** POST /safety/incidents/:id/people/:personId/remove. */
export async function removePerson(caller: CommandCaller, incidentId: string, personId: string, body: { readonly version: number }, idempotencyKey?: string) {
  await guard(caller, incidentId)
  if (!isUuid(personId)) throw new NotFoundError('Person not found.')
  const { result, replayed } = await command(caller, { name: 'safety.removeIncidentPerson', idempotencyKey, input: { incidentId, personId, ...body } }, async (tools) => {
    const incident = await lockedOpen(tools.tx, incidentId)
    const before = await tools.tx.incidentPerson.findFirst({ where: { id: personId, incidentId }, select: { version: true, involvement: true, _count: { select: { inailFilings: true } } } })
    if (!before) throw new NotFoundError('Person not found.')
    assertVersion('person', before.version, body.version)
    if (before._count.inailFilings > 0) refuse(refusalOf('PERSON_HAS_FILING'))
    await tools.tx.incidentPerson.delete({ where: { id: personId }, select: { id: true } })
    tools.audit({ action: 'safety.removeIncidentPerson', recordType: 'IncidentPerson', recordId: personId, companyId: incident.companyId, siteId: incident.siteId, before: { incidentId, involvement: before.involvement } })
    peopleChanged(tools, incident)
    return { person: { id: personId, removed: true } }
  })
  return { ...result, replayed }
}
