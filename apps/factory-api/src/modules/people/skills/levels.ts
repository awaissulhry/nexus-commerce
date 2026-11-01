import { ConflictError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PEOPLE_SKILLS_MANAGE, PEOPLE_SKILLS_VIEW } from '@nexus/factory-domain/people/skills/permissions'
import { isTrainee, levelPlan, signOffRefusal, trainerRefusal, type LevelFacts, type SkillLevel } from '@nexus/factory-domain/people/skills/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { assertMay, assertMayWrite, assertVersion, dateOf, dayOf, dayOrNull, officeOf, refuse } from '../employees/access'
import { assertPersonDecides } from '../privacy/decide'
import { levelViews, lockPerson, readLevel, type LevelRow } from './store'

/**
 * The level a person holds in a skill, trainees and their sign-off (B-W2b-39; MES-241, MES-244; design people.skills "1–4
 * set a level on a skill cell (leads)", "Sign off a trainee"; people.employees › Skills & training). Office only,
 * people.skills.manage, checked with can() against the person's company and site. A level is a person's judgement, never
 * computed (MES-281: assertPersonDecides first in each command); nobody decides about themselves (SELF_DECISION).
 *
 *   POST /people/skills/levels                         set a person's level in a skill (a new one, a changed one: who
 *                                                      assessed it and when are kept), give or move a trainee period
 *   POST /people/skills/levels/:levelId/sign-off       sign a trainee off (a signing act: the office's fresh code), with
 *                                                      the trainer (a Trainer of the skill) and, if a person decides so,
 *                                                      a new level
 *   POST /people/skills/levels/:levelId/remove         the skill is no longer held (when, who, why); never deleted
 *
 * Each command locks the person's record row first (two decisions about one person queue).
 */

const MANAGE_WORDS = 'Levels are set by a role that keeps the skills matrix (people.skills.manage).'
const placedOf = (row: { companyId: string; siteId: string }) => ({ companyId: row.companyId, siteId: row.siteId })
const factsOf = (row: LevelRow): LevelFacts => ({ level: row.level as SkillLevel, since: dayOf(row.since), traineeUntil: dayOrNull(row.traineeUntil), signedOffOn: dayOrNull(row.signedOffOn) })
const audited = (row: LevelRow | null) => (row ? { level: row.level, since: dayOf(row.since), traineeUntil: dayOrNull(row.traineeUntil), signedOffOn: dayOrNull(row.signedOffOn), trainerEmployeeId: row.trainerEmployeeId, removed: row.removedAt !== null } : null)

/** Nobody decides about themselves: the caller's own record (Employee.userId) is refused. */
function refuseSelf(person: { userId: string | null }, actorId: string): void {
  if (person.userId !== null && person.userId === actorId) refuse('SELF_DECISION', 'A decision about your own skills is made by another person.')
}

function emitLevel(tools: CommandTools, row: LevelRow, change: 'SET' | 'CHANGED' | 'TRAINEE_SET' | 'SIGNED_OFF' | 'REMOVED') {
  tools.emit({
    type: 'employee_skill.changed',
    subject: row.id,
    companyId: row.employee.companyId,
    siteId: row.siteId,
    payload: { levelId: row.id, employeeId: row.employeeId, skillId: row.skillId, level: row.level as SkillLevel, trainee: isTrainee({ traineeUntil: dayOrNull(row.traineeUntil), signedOffOn: dayOrNull(row.signedOffOn) }), change },
  })
}

export interface SetLevelBody {
  readonly employeeId: string
  readonly skillId: string
  readonly level: SkillLevel
  readonly since?: BusinessDate | undefined
  readonly traineeUntil?: BusinessDate | null | undefined
  /** The level in force's version, when there is one (the cell as it was read). */
  readonly version?: number | undefined
}

/** POST /people/skills/levels. */
export async function setLevel(caller: CommandCaller, body: SetLevelBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const today = businessDate(serverClock.now())
  const read = await caller.withClient(async (client) => {
    const employee = isUuid(body.employeeId) ? await client.employee.findUnique({ where: { id: body.employeeId }, select: { id: true, companyId: true, siteId: true } }) : null
    const skill = isUuid(body.skillId) ? await client.skill.findUnique({ where: { id: body.skillId }, select: { id: true, companyId: true } }) : null
    const current = employee && skill ? await client.employeeSkill.findFirst({ where: { employeeId: employee.id, skillId: skill.id, removedAt: null }, select: { id: true } }) : null
    return { employee, skill, current: current ? await readLevel(client, current.id) : null }
  })
  if (!read.employee) throw new NotFoundError('Employee not found.')
  assertMay(context, PEOPLE_SKILLS_VIEW, placedOf(read.employee), 'Employee')
  if (!read.skill || (read.skill.companyId !== null && !can(actorOf(context), PEOPLE_SKILLS_VIEW, { companyId: read.skill.companyId }))) throw new NotFoundError('Skill not found.')
  assertMayWrite(context, PEOPLE_SKILLS_MANAGE, placedOf(read.employee), MANAGE_WORDS)
  // Nothing to change: nothing is written (the cell as it is).
  if (read.current && body.version === read.current.version && levelPlan(factsOf(read.current), body, today).kind === 'NONE') {
    const [view] = await caller.withClient((client) => levelViews(client, [read.current!], today))
    return { level: view!, changed: false, replayed: false }
  }
  const { result, replayed } = await command(caller, { name: 'people.setSkillLevel', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const actorId = assertPersonDecides(tools.context, 'SKILL_LEVEL')
    const person = await lockPerson(tx, body.employeeId)
    refuseSelf(person, actorId)
    if (person.status !== 'ACTIVE') refuse('EMPLOYEE_LEFT', 'This person has left: their levels no longer change (a level may still be removed).', 'employeeId')
    const skill = (await tx.skill.findUnique({ where: { id: body.skillId }, select: { id: true, code: true, companyId: true, status: true } }))!
    if (skill.companyId !== null && skill.companyId !== person.companyId) refuse('SKILL_OTHER_COMPANY', `Skill ${skill.code} belongs to another company than the person.`, 'skillId')
    const found = await tx.employeeSkill.findFirst({ where: { employeeId: person.id, skillId: skill.id, removedAt: null }, select: { id: true } })
    const current = found ? await readLevel(tx, found.id) : null
    if (current && body.version === undefined) throw new ConflictError(`This person holds this skill already (version ${current.version}): send the version you read.`)
    if (current) assertVersion('level', current.version, body.version!)
    if (!current && body.version !== undefined) throw new ConflictError('This level was removed since you read it: read the matrix again.')
    if (!current && skill.status !== 'ACTIVE') refuse('SKILL_ARCHIVED', `Skill ${skill.code} is archived: it takes no new level.`, 'skillId')
    const plan = levelPlan(current ? factsOf(current) : null, body, businessDate(now))
    if (plan.kind === 'REFUSED') refuse(plan.refusal, plan.message, plan.field)
    if (plan.kind === 'NONE') throw new ConflictError('The level is as you sent it already: read the matrix again.')
    let id: string
    if (plan.kind === 'INSERT') {
      id = newId()
      await tx.employeeSkill.create({
        data: { id, siteId: person.siteId, employeeId: person.id, skillId: skill.id, level: plan.level, since: dateOf(plan.since), assessedAt: now, assessedById: actorId, traineeUntil: plan.traineeUntil ? dateOf(plan.traineeUntil) : null, createdAt: now, updatedAt: now, createdById: actorId },
        select: { id: true },
      })
    } else if (plan.kind === 'UPDATE') {
      id = current!.id
      const { level, since, traineeUntil } = plan.changes
      await tx.employeeSkill.update({
        where: { id },
        data: {
          ...(level !== undefined ? { level } : {}),
          ...(since !== undefined ? { since: dateOf(since) } : {}),
          ...(traineeUntil !== undefined ? { traineeUntil: traineeUntil === null ? null : dateOf(traineeUntil) } : {}),
          ...(plan.assessed ? { assessedAt: now, assessedById: actorId } : {}),
          version: { increment: 1 },
          updatedAt: now,
        },
        select: { id: true },
      })
    } else {
      throw new ConflictError('The level is as you sent it already.')
    }
    const row = (await readLevel(tx, id))!
    tools.audit({ action: 'people.setSkillLevel', recordType: 'EmployeeSkill', recordId: id, companyId: person.companyId, siteId: person.siteId, before: audited(current), after: { ...audited(row), skillId: skill.id, employeeId: person.id } })
    emitLevel(tools, row, plan.kind === 'INSERT' ? 'SET' : plan.assessed ? 'CHANGED' : 'TRAINEE_SET')
    const [view] = await levelViews(tx, [row], businessDate(now))
    return { level: view!, changed: true }
  })
  return { ...result, replayed }
}


async function writableLevel(caller: CommandCaller, levelId: string): Promise<LevelRow> {
  const context = officeOf(caller)
  const row = isUuid(levelId) ? await caller.withClient((client) => readLevel(client, levelId)) : null
  if (!row) throw new NotFoundError('Level not found.')
  assertMay(context, PEOPLE_SKILLS_VIEW, placedOf(row.employee), 'Level')
  assertMayWrite(context, PEOPLE_SKILLS_MANAGE, placedOf(row.employee), MANAGE_WORDS)
  return row
}

async function lockLevel(tools: CommandTools, levelId: string, version: number): Promise<{ row: LevelRow; person: Awaited<ReturnType<typeof lockPerson>> }> {
  const found = (await tools.tx.employeeSkill.findUnique({ where: { id: levelId }, select: { employeeId: true } }))!
  const person = await lockPerson(tools.tx, found.employeeId)
  await tools.tx.$queryRaw`SELECT "id" FROM "EmployeeSkill" WHERE "id" = ${levelId}::uuid FOR UPDATE`
  const row = (await readLevel(tools.tx, levelId))!
  assertVersion('level', row.version, version)
  if (row.removedAt !== null) refuse('LEVEL_REMOVED', 'This level was removed: it never changes again.')
  return { row, person }
}

export interface SignOffBody {
  readonly version: number
  /** Default today. */
  readonly signedOffOn?: BusinessDate | undefined
  readonly trainerEmployeeId?: string | null | undefined
  /** A new level decided with the sign-off (the signer assesses it). */
  readonly level?: SkillLevel | undefined
}

/** POST /people/skills/levels/:levelId/sign-off (a signing act: the route asks the office's fresh code first). */
export async function signOffTrainee(caller: CommandCaller, levelId: string, body: SignOffBody, options: { readonly stepUp: () => void; readonly idempotencyKey?: string | undefined }) {
  await writableLevel(caller, levelId)
  options.stepUp()
  const { result } = await command(caller, { name: 'people.signOffTrainee', idempotencyKey: options.idempotencyKey, input: { levelId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const actorId = assertPersonDecides(tools.context, 'TRAINEE_SIGN_OFF')
    const { row, person } = await lockLevel(tools, levelId, body.version)
    refuseSelf(person, actorId)
    if (person.status !== 'ACTIVE') refuse('EMPLOYEE_LEFT', 'This person has left: a trainee who left is not signed off.')
    const today = businessDate(now)
    const signedOffOn = body.signedOffOn ?? today
    const refusal = signOffRefusal(factsOf(row), signedOffOn, today)
    if (refusal) refuse(refusal.refusal, refusal.message, refusal.field === 'levelId' ? undefined : refusal.field)
    const trainerId = body.trainerEmployeeId ?? null
    if (trainerId) {
      const trainer = isUuid(trainerId) ? await tx.employee.findUnique({ where: { id: trainerId }, select: { id: true, companyId: true, status: true } }) : null
      if (!trainer) refuse('TRAINER_NOT_TRAINER', 'The trainer has no employee record.', 'trainerEmployeeId')
      const held = await tx.employeeSkill.findFirst({ where: { employeeId: trainerId, skillId: row.skillId, removedAt: null }, select: { level: true, traineeUntil: true, signedOffOn: true } })
      const no = trainerRefusal(
        { employeeId: trainer!.id, companyId: trainer!.companyId, active: trainer!.status === 'ACTIVE', level: (held?.level as SkillLevel | undefined) ?? null, trainee: held ? isTrainee({ traineeUntil: dayOrNull(held.traineeUntil), signedOffOn: dayOrNull(held.signedOffOn) }) : false },
        { employeeId: row.employeeId, companyId: person.companyId },
      )
      if (no) refuse(no.refusal, no.message, 'trainerEmployeeId')
    }
    const newLevel = body.level !== undefined && body.level !== row.level ? body.level : null
    await tx.employeeSkill.update({
      where: { id: row.id },
      data: { signedOffOn: dateOf(signedOffOn), signedOffById: actorId, trainerEmployeeId: trainerId, ...(newLevel ? { level: newLevel, assessedAt: now, assessedById: actorId } : {}), version: { increment: 1 }, updatedAt: now },
      select: { id: true },
    })
    const after = (await readLevel(tx, row.id))!
    tools.audit({ action: 'people.signOffTrainee', recordType: 'EmployeeSkill', recordId: row.id, companyId: person.companyId, siteId: person.siteId, before: audited(row), after: audited(after) })
    emitLevel(tools, after, 'SIGNED_OFF')
    const [view] = await levelViews(tx, [after], today)
    return { level: view! }
  })
  return result
}

/** POST /people/skills/levels/:levelId/remove: the skill is no longer held (when, who, why); the row stays on record. */
export async function removeLevel(caller: CommandCaller, levelId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  await writableLevel(caller, levelId)
  const { result } = await command(caller, { name: 'people.removeSkillLevel', idempotencyKey, input: { levelId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const actorId = assertPersonDecides(tools.context, 'SKILL_LEVEL')
    const { row, person } = await lockLevel(tools, levelId, body.version)
    refuseSelf(person, actorId)
    const reason = body.reason.trim()
    await tx.employeeSkill.update({ where: { id: row.id }, data: { removedAt: now, removedById: actorId, removeReason: reason, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    const after = (await readLevel(tx, row.id))!
    tools.audit({ action: 'people.removeSkillLevel', recordType: 'EmployeeSkill', recordId: row.id, companyId: person.companyId, siteId: person.siteId, before: audited(row), after: audited(after), reason })
    emitLevel(tools, after, 'REMOVED')
    const [view] = await levelViews(tx, [after], businessDate(now))
    return { level: view! }
  })
  return result
}
