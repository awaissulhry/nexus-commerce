import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PEOPLE_AUTHORISATIONS_MANAGE, PEOPLE_SKILLS_VIEW } from '@nexus/factory-domain/people/skills/permissions'
import { authorisationProblems, authorisationStateOf } from '@nexus/factory-domain/people/skills/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { assertMay, assertMayWrite, assertVersion, dateOf, dayOf, dayOrNull, officeOf, problemsError, refuse } from '../employees/access'
import { assertPersonDecides } from '../privacy/decide'
import { authorisationViews, lockPerson, readAuthorisation, type AuthorisationRow } from './store'
import { authorisationWords, trainingOfAuthorisation } from './training'

/**
 * Machine authorisations (B-W2b-39; MES-246 "dangerous machines accept sign-in only from trained, authorised people";
 * design people.skills "Authorise a machine": "Can sign in on clicking presses from today"). Office only,
 * people.authorisations.manage, checked with can() against the person's company and site. Who authorised it is the person
 * recording it (a person decides: assertPersonDecides first); nobody authorises themselves.
 *
 *   POST /people/skills/authorisations                              authorise a person on a class of machine, from a day
 *                                                                   (default today), until a day or open; one in force
 *                                                                   per person and class: an ENDED one is closed by the
 *                                                                   new one (revoked with "Ended on …" words), one in
 *                                                                   force or starting later is refused (change its days)
 *   POST /people/skills/authorisations/:authorisationId/valid-until change until when (or open) while it is not revoked
 *   POST /people/skills/authorisations/:authorisationId/revoke     revoke it with the reason (final; a new one is a new
 *                                                                   record)
 *
 * Whether a class asks an authorisation is MachineClass.authorisationRequired (B-W2b-139, ./training.ts): the qualification
 * check holds anyone without one on its machines. The courses the class asks are listed in the answer (B-W2b-139): one not
 * held when due holds the authorisation (it is still given, "held until … is valid"); the modal reads them first with GET
 * /people/skills/authorisations/prerequisites. Fitness (yes / no only) comes with the health pages (B-W2b-135).
 */

const MANAGE_WORDS = 'Machine authorisations are given by a role that authorises people on machines (people.authorisations.manage).'
const placedOf = (row: { companyId: string; siteId: string }) => ({ companyId: row.companyId, siteId: row.siteId })
const audited = (row: AuthorisationRow | null) => (row ? { machineClassId: row.machineClassId, authorisedOn: dayOf(row.authorisedOn), validUntil: dayOrNull(row.validUntil), revoked: row.revokedAt !== null } : null)

function refuseSelf(person: { userId: string | null }, actorId: string): void {
  if (person.userId !== null && person.userId === actorId) refuse('SELF_DECISION', 'Your own machine authorisation is given by another person.')
}

function emitAuthorisation(tools: CommandTools, row: AuthorisationRow, change: 'AUTHORISED' | 'VALIDITY_CHANGED' | 'REVOKED' | 'ENDED') {
  tools.emit({ type: 'machine_authorisation.changed', subject: row.id, companyId: row.employee.companyId, siteId: row.siteId, payload: { authorisationId: row.id, employeeId: row.employeeId, machineClassId: row.machineClassId, change } })
}

export interface AuthoriseBody {
  readonly employeeId: string
  readonly machineClassId: string
  /** Default today. */
  readonly authorisedOn?: BusinessDate | undefined
  readonly validUntil?: BusinessDate | null | undefined
}

/** POST /people/skills/authorisations. */
export async function authorise(caller: CommandCaller, body: AuthoriseBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const employee = isUuid(body.employeeId) ? await caller.withClient((client) => client.employee.findUnique({ where: { id: body.employeeId }, select: { companyId: true, siteId: true } })) : null
  if (!employee) throw new NotFoundError('Employee not found.')
  assertMay(context, PEOPLE_SKILLS_VIEW, placedOf(employee), 'Employee')
  assertMayWrite(context, PEOPLE_AUTHORISATIONS_MANAGE, placedOf(employee), MANAGE_WORDS)
  const id = newId()
  const { result, replayed } = await command(caller, { name: 'people.authoriseMachine', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const actorId = assertPersonDecides(tools.context, 'MACHINE_AUTHORISATION')
    const person = await lockPerson(tx, body.employeeId)
    refuseSelf(person, actorId)
    if (person.status !== 'ACTIVE') refuse('EMPLOYEE_LEFT', 'This person has left: they are authorised on no machine.', 'employeeId')
    const machineClass = isUuid(body.machineClassId) ? await tx.machineClass.findUnique({ where: { id: body.machineClassId }, select: { id: true, code: true, labelEn: true, active: true, authorisationRequired: true } }) : null
    if (!machineClass) throw new NotFoundError('Machine class not found.')
    if (!machineClass.active) refuse('CLASS_INACTIVE', `The class ${machineClass.labelEn} is archived.`, 'machineClassId')
    const today = businessDate(now)
    const authorisedOn = body.authorisedOn ?? today
    const validUntil = body.validUntil ?? null
    const problems = authorisationProblems({ authorisedOn, validUntil })
    if (problems.length > 0) throw problemsError(problems, 'The authorisation is not valid.')
    const live = await tx.machineAuthorisation.findFirst({ where: { employeeId: person.id, machineClassId: machineClass.id, revokedAt: null }, select: { id: true } })
    if (live) {
      const before = (await readAuthorisation(tx, live.id))!
      const state = authorisationStateOf({ authorisedOn: dayOf(before.authorisedOn), validUntil: dayOrNull(before.validUntil), revoked: false }, today)
      if (state === 'AUTHORISED') refuse('AUTHORISATION_OPEN', `This person is authorised on ${machineClass.labelEn} machines already${before.validUntil ? ` until ${dayOf(before.validUntil)}` : ''}: change until when instead.`, 'machineClassId')
      if (state === 'NOT_YET') refuse('AUTHORISATION_OPEN', `This person's authorisation on ${machineClass.labelEn} machines starts on ${dayOf(before.authorisedOn)}: change its days or revoke it.`, 'machineClassId')
      // Ended: closed by the new one, its period kept on record.
      const words = `Ended on ${dayOrNull(before.validUntil)}: authorised again from ${authorisedOn}.`
      await tx.machineAuthorisation.update({ where: { id: before.id }, data: { revokedAt: now, revokedById: actorId, revokeReason: words, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      const closed = (await readAuthorisation(tx, before.id))!
      tools.audit({ action: 'people.endMachineAuthorisation', recordType: 'MachineAuthorisation', recordId: before.id, companyId: person.companyId, siteId: person.siteId, before: audited(before), after: audited(closed), reason: words })
      emitAuthorisation(tools, closed, 'ENDED')
    }
    await tx.machineAuthorisation.create({
      data: { id, siteId: person.siteId, employeeId: person.id, machineClassId: machineClass.id, authorisedOn: dateOf(authorisedOn), validUntil: validUntil ? dateOf(validUntil) : null, authorisedById: actorId, createdAt: now, updatedAt: now, createdById: actorId },
      select: { id: true },
    })
    const row = (await readAuthorisation(tx, id))!
    tools.audit({ action: 'people.authoriseMachine', recordType: 'MachineAuthorisation', recordId: id, companyId: person.companyId, siteId: person.siteId, after: { ...audited(row), employeeId: person.id } })
    emitAuthorisation(tools, row, 'AUTHORISED')
    const [view] = await authorisationViews(tx, [row], today)
    // B-W2b-139: the courses the class asks; one not held when due holds the authorisation from its first day.
    const { training, holding } = await trainingOfAuthorisation(tx, person.id, machineClass, authorisedOn, today)
    return { authorisation: view!, words: authorisationWords(machineClass.labelEn, authorisedOn, today, machineClass.authorisationRequired, holding), training, held: machineClass.authorisationRequired && holding.length > 0 }
  })
  return { ...result, replayed }
}

async function writableAuthorisation(caller: CommandCaller, authorisationId: string): Promise<AuthorisationRow> {
  const context = officeOf(caller)
  const row = isUuid(authorisationId) ? await caller.withClient((client) => readAuthorisation(client, authorisationId)) : null
  if (!row) throw new NotFoundError('Authorisation not found.')
  assertMay(context, PEOPLE_SKILLS_VIEW, placedOf(row.employee), 'Authorisation')
  assertMayWrite(context, PEOPLE_AUTHORISATIONS_MANAGE, placedOf(row.employee), MANAGE_WORDS)
  return row
}

async function lockAuthorisation(tools: CommandTools, authorisationId: string, version: number) {
  const found = (await tools.tx.machineAuthorisation.findUnique({ where: { id: authorisationId }, select: { employeeId: true } }))!
  const person = await lockPerson(tools.tx, found.employeeId)
  await tools.tx.$queryRaw`SELECT "id" FROM "MachineAuthorisation" WHERE "id" = ${authorisationId}::uuid FOR UPDATE`
  const row = (await readAuthorisation(tools.tx, authorisationId))!
  assertVersion('authorisation', row.version, version)
  if (row.revokedAt !== null) refuse('AUTHORISATION_REVOKED', 'This authorisation was revoked: it never changes again (a new authorisation is a new record).')
  return { row, person }
}

/** POST /people/skills/authorisations/:authorisationId/valid-until: extend or shorten it (null: open). */
export async function changeValidUntil(caller: CommandCaller, authorisationId: string, body: { readonly version: number; readonly validUntil: BusinessDate | null }, idempotencyKey?: string) {
  await writableAuthorisation(caller, authorisationId)
  const { result } = await command(caller, { name: 'people.changeMachineAuthorisation', idempotencyKey, input: { authorisationId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const actorId = assertPersonDecides(tools.context, 'MACHINE_AUTHORISATION')
    const { row, person } = await lockAuthorisation(tools, authorisationId, body.version)
    refuseSelf(person, actorId)
    if (person.status !== 'ACTIVE') refuse('EMPLOYEE_LEFT', 'This person has left: revoke the authorisation instead.')
    const problems = authorisationProblems({ authorisedOn: dayOf(row.authorisedOn), validUntil: body.validUntil })
    if (problems.length > 0) throw problemsError(problems, 'The authorisation is not valid.')
    await tx.machineAuthorisation.update({ where: { id: row.id }, data: { validUntil: body.validUntil ? dateOf(body.validUntil) : null, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    const after = (await readAuthorisation(tx, row.id))!
    tools.audit({ action: 'people.changeMachineAuthorisation', recordType: 'MachineAuthorisation', recordId: row.id, companyId: person.companyId, siteId: person.siteId, before: audited(row), after: audited(after) })
    emitAuthorisation(tools, after, 'VALIDITY_CHANGED')
    const [view] = await authorisationViews(tx, [after], businessDate(now))
    return { authorisation: view! }
  })
  return result
}

/** POST /people/skills/authorisations/:authorisationId/revoke: final, with the reason. */
export async function revokeAuthorisation(caller: CommandCaller, authorisationId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  await writableAuthorisation(caller, authorisationId)
  const { result } = await command(caller, { name: 'people.revokeMachineAuthorisation', idempotencyKey, input: { authorisationId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const actorId = assertPersonDecides(tools.context, 'MACHINE_AUTHORISATION')
    const { row, person } = await lockAuthorisation(tools, authorisationId, body.version)
    refuseSelf(person, actorId)
    const reason = body.reason.trim()
    await tx.machineAuthorisation.update({ where: { id: row.id }, data: { revokedAt: now, revokedById: actorId, revokeReason: reason, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    const after = (await readAuthorisation(tx, row.id))!
    tools.audit({ action: 'people.revokeMachineAuthorisation', recordType: 'MachineAuthorisation', recordId: row.id, companyId: person.companyId, siteId: person.siteId, before: audited(row), after: audited(after), reason })
    emitAuthorisation(tools, after, 'REVOKED')
    const [view] = await authorisationViews(tx, [after], businessDate(now))
    return { authorisation: view! }
  })
  return result
}
