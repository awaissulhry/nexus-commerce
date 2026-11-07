import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { grantsFor } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PEOPLE_AUTHORISATIONS_MANAGE, PEOPLE_SKILLS_VIEW } from '@nexus/factory-domain/people/skills/permissions'
import { trainingRequirement, type TrainingRequirement } from '@nexus/factory-domain/people/skills/qualification'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { classCoursesOf, courseHoldingsOf } from '../../safety/records/holdings'
import { assertMay, assertVersion, dateOf, officeOf } from '../employees/access'
import { assertPersonDecides } from '../privacy/decide'

/**
 * What a type of machine asks before a person works on it (B-W2b-139; design people.skills "Authorise a machine":
 * "prerequisites: required training valid ✓ · fitness valid (yes / no only) · authorised by · date"; MES-246; D.Lgs. 81/2008
 * art. 71 c.7), office only:
 *
 *   GET /people/skills/authorisations/prerequisites?employeeId&machineClassId[&authorisedOn]
 *        the modal's prerequisites before "Authorise": whether the type asks an authorisation, each course it asks (held,
 *        due later within its days, expired, missing) against the day the authorisation would start, and whether it would
 *        be held from that day (the authorisation is still given: it stays held until the training is valid). Fitness is
 *        the health pages' (B-W2b-135): null here.
 *   PUT /people/skills/machine-classes/:machineClassId/authorisation-rule {version, required}
 *        the office says a type of machine asks an authorisation (MachineClass.authorisationRequired): from then on the
 *        qualification check holds anyone without one on its machines, at every site. A machine type is the group's:
 *        people.authorisations.manage over every company. Audited; nothing else moves.
 */

export interface TrainingLine {
  readonly courseId: string
  readonly code: string
  readonly name: string
  readonly withinDays: number | null
  readonly state: TrainingRequirement['state']
  readonly dueOn: BusinessDate
  readonly validUntil: BusinessDate | null
}

/** The courses a class asks of a person, against the day an authorisation starts; held = a course would hold it then. */
export async function trainingOfAuthorisation(db: Pick<CommandTx, 'trainingRequirement' | 'trainingRecord'>, employeeId: string, machineClass: { readonly id: string; readonly code: string }, authorisedOn: BusinessDate, today: BusinessDate) {
  const courses = (await classCoursesOf(db, [machineClass.id])).get(machineClass.id) ?? []
  const holdings = await courseHoldingsOf(
    db,
    employeeId,
    courses.map((course) => course.courseId),
    today,
  )
  // Judged on the later of today and the first day: a course due "before starting" is due on that day.
  const on = authorisedOn > today ? authorisedOn : today
  const training: TrainingLine[] = courses.map((course) => {
    const holding = holdings.get(course.courseId)
    const requirement = trainingRequirement(machineClass, { ...course, met: holding?.met ?? false, validUntil: holding?.validUntil ?? null, everPassed: holding?.everPassed ?? false }, authorisedOn, on)
    return { courseId: course.courseId, code: course.code, name: course.name, withinDays: course.withinDays, state: requirement.state, dueOn: requirement.dueOn, validUntil: requirement.validUntil }
  })
  return { training, holding: training.filter((line) => line.state === 'EXPIRED' || line.state === 'MISSING') }
}

/** The authorisation's effect in words (design "Effect in words: 'Can sign in on clicking presses from today'"). */
export function authorisationWords(label: string, authorisedOn: BusinessDate, today: BusinessDate, required: boolean, holding: readonly TrainingLine[]): string {
  const from = authorisedOn === today ? 'from today' : `from ${authorisedOn}`
  if (required && holding.length > 0) return `Authorised on ${label} machines ${from}, held until ${holding.map((line) => line.name).join(', ')} ${holding.length === 1 ? 'is' : 'are'} valid.`
  return `Can work on ${label} machines ${from}.`
}

/** GET /people/skills/authorisations/prerequisites. */
export async function authorisationPrerequisites(caller: CommandCaller, query: { readonly employeeId: string; readonly machineClassId: string; readonly authorisedOn?: BusinessDate | undefined }) {
  const context = officeOf(caller)
  const today = businessDate(serverClock.now())
  return caller.withClient(async (client) => {
    const employee = isUuid(query.employeeId) ? await client.employee.findUnique({ where: { id: query.employeeId }, select: { id: true, companyId: true, siteId: true, status: true } }) : null
    if (!employee) throw new NotFoundError('Employee not found.')
    assertMay(context, PEOPLE_SKILLS_VIEW, employee, 'Employee')
    const machineClass = isUuid(query.machineClassId) ? await client.machineClass.findUnique({ where: { id: query.machineClassId }, select: { id: true, code: true, labelEn: true, labelIt: true, active: true, authorisationRequired: true } }) : null
    if (!machineClass) throw new NotFoundError('Machine class not found.')
    const authorisedOn = query.authorisedOn ?? today
    const { training, holding } = await trainingOfAuthorisation(client, employee.id, machineClass, authorisedOn, today)
    return {
      machineClass: { id: machineClass.id, code: machineClass.code, labelEn: machineClass.labelEn, labelIt: machineClass.labelIt, active: machineClass.active, authorisationRequired: machineClass.authorisationRequired },
      authorisedOn,
      training,
      trainingValid: holding.length === 0,
      held: machineClass.authorisationRequired && holding.length > 0,
      /** Fitness (yes / no only) comes with the health pages (B-W2b-135). */
      fitness: null,
      words: authorisationWords(machineClass.labelEn, authorisedOn, today, machineClass.authorisationRequired, holding),
      employeeActive: employee.status === 'ACTIVE',
      today,
    }
  })
}

const overEveryCompany = (context: OfficeContext): boolean => grantsFor(actorOf(context), PEOPLE_AUTHORISATIONS_MANAGE).some((grant) => grant.companies === 'all')

/** PUT /people/skills/machine-classes/:machineClassId/authorisation-rule. */
export async function setAuthorisationRule(caller: CommandCaller, machineClassId: string, body: { readonly version: number; readonly required: boolean }, idempotencyKey?: string) {
  const context = officeOf(caller)
  if (!overEveryCompany(context)) throw new ForbiddenError('A type of machine is the group’s: whether it asks an authorisation is set by a role that authorises people over every company.')
  const { result } = await command(caller, { name: 'people.setAuthorisationRule', idempotencyKey, input: { machineClassId, ...body } }, async (tools) => {
    const { tx, now } = tools
    assertPersonDecides(tools.context, 'MACHINE_AUTHORISATION')
    const [locked] = isUuid(machineClassId) ? await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "MachineClass" WHERE "id" = ${machineClassId}::uuid FOR UPDATE` : []
    if (!locked) throw new NotFoundError('Machine class not found.')
    const before = (await tx.machineClass.findUnique({ where: { id: machineClassId }, select: { id: true, code: true, labelEn: true, labelIt: true, active: true, authorisationRequired: true, version: true } }))!
    assertVersion('machine class', before.version, body.version)
    const today = businessDate(now)
    const authorised = await tx.machineAuthorisation.count({ where: { machineClassId, revokedAt: null, authorisedOn: { lte: dateOf(today) }, OR: [{ validUntil: null }, { validUntil: { gte: dateOf(today) } }] } })
    const changed = before.authorisationRequired !== body.required
    const row = changed
      ? await tx.machineClass.update({ where: { id: machineClassId }, data: { authorisationRequired: body.required, version: { increment: 1 }, updatedAt: now }, select: { id: true, code: true, labelEn: true, labelIt: true, active: true, authorisationRequired: true, version: true } })
      : before
    tools.audit({
      action: 'people.setAuthorisationRule',
      recordType: 'MachineClass',
      recordId: machineClassId,
      companyId: null,
      before: { authorisationRequired: before.authorisationRequired },
      after: { authorisationRequired: row.authorisationRequired, ...(changed ? {} : { unchanged: true }), authorisedPeople: authorised },
    })
    const words = row.authorisationRequired
      ? `From now on only people authorised on ${row.labelEn} machines work on them, at every site (${authorised === 1 ? '1 person is' : `${authorised} people are`} authorised today).`
      : `${row.labelEn} machines no longer ask an authorisation: the check holds nobody on them for one.`
    return { machineClass: { ...row, updatedAt: toUtcIso(now) }, changed, authorisedPeople: authorised, words }
  })
  return result
}
