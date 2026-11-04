import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { SAFETY_VIEW } from '@nexus/factory-domain/safety/organisation/permissions'
import { fingerprintOf, sheetChanges, sheetImpact, type RequirementDraft, type SheetChanges } from '@nexus/factory-domain/safety/rolesheets/rules'
import {
  AGREEMENT_LAW,
  classAsks,
  classRequirementProblems,
  cleanRequirements,
  countNeeds,
  MACHINE_TRAINING_LAW,
  TRAINING_LAW,
  TRAINING_LIMITS,
  type NeedSourceKind,
  type PersonNeed,
} from '@nexus/factory-domain/safety/training/rules'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { actorIdOf, asked, assertMayAt, officeOf, problemsError, refuse, siteScope, todayOf } from '../organisation/access'
import { holdingsOf, roleNeedsOf } from '../rolesheets/needs'
import { classRequirementsOf, countingAuthorisation, trainingNeedsOf, trainingPeopleOf, type TrainingPerson } from './needs'
import { CLASS_SELECT, classView, courseRefs, i18nOf, overEveryCompany, type ClassRow } from './store'

/**
 * Who needs what (B-W2b-133; QHS-242; design people.skills "Who needs what": role or machine type → required courses ·
 * people affected · met / not met; "read here; edited in the role sheet — one owner"), office only:
 *
 *   GET  /safety/training/requirements                          every ACTIVE role sheet the caller reads and every active
 *                                                               machine type: its courses (days allowed), the people it
 *                                                               asks them of (counts) and per course met / due / overdue
 *   GET  /safety/training/requirements/role-sheets/:id          one role: its courses and its people, each course's due day
 *                                                               and state per person (a register names people)
 *   GET  /safety/training/requirements/machine-classes/:id      one machine type: the same for the people authorised on it
 *   POST /safety/training/requirements/machine-classes/:id/preview   "What this changes" for the courses a machine type
 *                                                               asks (who now needs which course, whose day moves; names)
 *   PUT  /safety/training/requirements/machine-classes/:id      the same in one command, with the fingerprint read
 *
 * A ROLE's courses are typed on its role sheet (modules/safety/rolesheets: Apply); a MACHINE TYPE's courses here (machine
 * types are the group's, so a grant over every company changes them; a new course of a machine type is ACTIVE and of the
 * whole group: the people authorised on it work for any company). Due = the day they took the role or the authorisation
 * starts + the days allowed (none: before starting).
 */

type Client = FactoryClient | CommandTx

const L = TRAINING_LIMITS
const LAW = { training: TRAINING_LAW, agreement: AGREEMENT_LAW, machines: MACHINE_TRAINING_LAW }
const CLASS_WORDS = 'The courses of a type of machine are kept by a role over every company that keeps the catalogue (safety.training.manage): machine types are the group’s.'

/** The rows of one source and course: each person once, with the source's own due day and state. */
function sourceRows(needs: readonly PersonNeed[], kind: NeedSourceKind, id: string, courseId: string) {
  return needs.flatMap((need) => (need.courseId === courseId ? need.sources.filter((source) => source.kind === kind && source.id === id).map((source) => ({ employeeId: need.employeeId, dueOn: source.dueOn, state: source.state })) : []))
}

const requirementRow = (needs: readonly PersonNeed[], kind: NeedSourceKind, id: string, requirement: RequirementDraft) => ({
  courseId: requirement.courseId,
  withinDays: requirement.withinDays,
  note: requirement.note ?? null,
  ...countNeeds(sourceRows(needs, kind, id, requirement.courseId)),
})

/** The courses of a person from one source: each course's due day and state. */
function personRow(person: TrainingPerson, since: BusinessDate, needs: readonly PersonNeed[], kind: NeedSourceKind, id: string, requirements: readonly RequirementDraft[]) {
  return {
    employeeId: person.employeeId,
    name: person.name,
    siteId: person.siteId,
    since,
    courses: requirements.flatMap((requirement) =>
      sourceRows(
        needs.filter((need) => need.employeeId === person.employeeId),
        kind,
        id,
        requirement.courseId,
      ).map((row) => ({ courseId: requirement.courseId, dueOn: row.dueOn, state: row.state })),
    ),
  }
}

const SHEET_SELECT = { id: true, code: true, name: true, nameI18n: true, status: true, companyId: true, siteId: true, site: { select: { code: true, name: true } } } as const satisfies Prisma.RoleSheetSelect

export interface ListQuery {
  readonly companyId?: string | undefined
  readonly siteId?: string | undefined
}

/** GET /safety/training/requirements. */
export async function listRequirements(caller: CommandCaller, query: ListQuery, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  return caller.withClient(async (client) => {
    const sheets = await client.roleSheet.findMany({
      where: { AND: [siteScope(context, SAFETY_VIEW) as Prisma.RoleSheetWhereInput, asked(query, 'strict') as Prisma.RoleSheetWhereInput, { status: 'ACTIVE' }] },
      orderBy: [{ site: { code: 'asc' } }, { code: 'asc' }, { id: 'asc' }],
      take: L.list + 1,
      select: SHEET_SELECT,
    })
    const shownSheets = sheets.slice(0, L.list)
    const classes = await client.machineClass.findMany({ where: { active: true }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }], take: L.list, select: CLASS_SELECT })
    const sheetIds = shownSheets.map((sheet) => sheet.id)
    const classIds = classes.map((row) => row.id)
    const people = await trainingPeopleOf(client, {
      AND: [
        siteScope(context, SAFETY_VIEW) as Prisma.EmployeeWhereInput,
        asked(query, 'strict') as Prisma.EmployeeWhereInput,
        { OR: [{ roleSheetId: { in: sheetIds } }, { machineAuthorisations: { some: { AND: [countingAuthorisation(today), { machineClassId: { in: classIds } }] } } }] },
      ],
    })
    const { needs, authorisations } = await trainingNeedsOf(client, people, today)
    const roles = await roleNeedsOf(client, sheetIds)
    const classCourses = await classRequirementsOf(client, classIds)
    const authorised = (classId: string) => new Set(authorisations.filter((entry) => entry.machineClassId === classId).map((entry) => entry.employeeId)).size
    const courseIds = [...[...roles.values()].flatMap((role) => role.content.requirements), ...[...classCourses.values()].flat()].map((requirement) => requirement.courseId)
    const overall = countNeeds(needs)
    return {
      roleSheets: shownSheets.map((sheet) => ({
        id: sheet.id,
        code: sheet.code,
        name: sheet.name,
        nameI18n: i18nOf(sheet.nameI18n),
        companyId: sheet.companyId,
        siteId: sheet.siteId,
        site: sheet.site,
        people: people.filter((person) => person.roleSheetId === sheet.id).length,
        courses: (roles.get(sheet.id)?.content.requirements ?? []).map((requirement) => requirementRow(needs, 'ROLE_SHEET', sheet.id, requirement)),
      })),
      machineClasses: classes.map((row) => ({
        ...classView(row),
        people: authorised(row.id),
        courses: (classCourses.get(row.id) ?? []).map((requirement) => requirementRow(needs, 'MACHINE_CLASS', row.id, requirement)),
      })),
      overall: { ...overall, people: new Set(needs.map((need) => need.employeeId)).size, needs: needs.length },
      courses: await courseRefs(client, courseIds),
      complete: sheets.length <= L.list,
      canManageClasses: overEveryCompany(context),
      law: LAW,
      today,
    }
  })
}

/** GET /safety/training/requirements/role-sheets/:roleSheetId. */
export async function roleSheetNeeds(caller: CommandCaller, roleSheetId: string, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  return caller.withClient(async (client) => {
    const sheet = isUuid(roleSheetId) ? await client.roleSheet.findUnique({ where: { id: roleSheetId }, select: SHEET_SELECT }) : null
    if (!sheet) throw new NotFoundError('Role sheet not found.')
    assertMayAt(context, SAFETY_VIEW, sheet, 'Role sheet')
    const requirements = (await roleNeedsOf(client, [sheet.id])).get(sheet.id)?.content.requirements ?? []
    const people = await trainingPeopleOf(client, { roleSheetId: sheet.id })
    const { needs, roleSince } = await trainingNeedsOf(client, people, today)
    const requirementIds = await client.trainingRequirement.findMany({ where: { source: 'ROLE_SHEET', roleSheetId: sheet.id }, select: { id: true, courseId: true } })
    return {
      roleSheet: { id: sheet.id, code: sheet.code, name: sheet.name, nameI18n: i18nOf(sheet.nameI18n), status: sheet.status as 'ACTIVE' | 'ARCHIVED', companyId: sheet.companyId, siteId: sheet.siteId, site: sheet.site },
      courses: requirements.map((requirement) => ({ id: requirementIds.find((row) => row.courseId === requirement.courseId)!.id, ...requirementRow(needs, 'ROLE_SHEET', sheet.id, requirement) })),
      people: people.map((person) => personRow(person, roleSince.get(person.employeeId) ?? person.startDate, needs, 'ROLE_SHEET', sheet.id, requirements)),
      refs: await courseRefs(
        client,
        requirements.map((requirement) => requirement.courseId),
      ),
      law: LAW,
      today,
    }
  })
}

async function readClass(client: Client, machineClassId: string): Promise<ClassRow> {
  const row = isUuid(machineClassId) ? await client.machineClass.findUnique({ where: { id: machineClassId }, select: CLASS_SELECT }) : null
  if (!row) throw new NotFoundError('Machine type not found.')
  return row
}

/** The people authorised on a machine type (counting today) the caller reads people of. */
const authorisedPeople = (client: Client, context: OfficeContext, machineClassId: string, today: BusinessDate) =>
  trainingPeopleOf(client, { AND: [siteScope(context, SAFETY_VIEW) as Prisma.EmployeeWhereInput, { machineAuthorisations: { some: { AND: [countingAuthorisation(today), { machineClassId }] } } }] })

/** The courses a machine type asks, with each line's id and version (what a change is checked against). */
const classLines = (client: Client, machineClassId: string) =>
  client.trainingRequirement.findMany({
    where: { source: 'MACHINE_CLASS', machineClassId },
    orderBy: [{ course: { sortOrder: 'asc' } }, { course: { code: 'asc' } }, { id: 'asc' }],
    select: { id: true, courseId: true, withinDays: true, note: true, version: true },
  })

/** GET /safety/training/requirements/machine-classes/:machineClassId. */
export async function classNeeds(caller: CommandCaller, machineClassId: string, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  return caller.withClient(async (client) => {
    const row = await readClass(client, machineClassId)
    const lines = await classLines(client, row.id)
    const people = await authorisedPeople(client, context, row.id, today)
    const { needs, authorisations } = await trainingNeedsOf(client, people, today)
    const requirements = lines.map((line) => ({ courseId: line.courseId, withinDays: line.withinDays, note: line.note }))
    const siteIds = [...new Set(people.map((person) => person.siteId))]
    const sites = siteIds.length > 0 ? await client.site.findMany({ where: { id: { in: siteIds } }, orderBy: [{ code: 'asc' }], select: { id: true, code: true, name: true } }) : []
    return {
      machineClass: classView(row),
      courses: lines.map((line) => ({ id: line.id, version: line.version, ...requirementRow(needs, 'MACHINE_CLASS', row.id, { courseId: line.courseId, withinDays: line.withinDays, note: line.note }) })),
      people: people.map((person) => {
        const since = authorisations.filter((entry) => entry.employeeId === person.employeeId && entry.machineClassId === row.id).map((entry) => entry.authorisedOn).sort()[0]!
        return personRow(person, since, needs, 'MACHINE_CLASS', row.id, requirements)
      }),
      sites,
      refs: await courseRefs(
        client,
        lines.map((line) => line.courseId),
      ),
      canManage: overEveryCompany(context),
      law: LAW,
      today,
    }
  })
}

// ---- the courses a machine type asks: preview and apply -------------------------------------------------------------------

/** The machine type's courses as a draft: cleaned, its own problems (400 at body/requirements/...). */
function checkedRequirements(requirements: readonly RequirementDraft[]): RequirementDraft[] {
  const cleaned = cleanRequirements(requirements)
  const problems = classRequirementProblems(cleaned)
  if (problems.length > 0) throw problemsError(problems, 'The courses of this type of machine are not right.')
  return cleaned
}

/** The courses whose note alone changes (the days unchanged). */
function notedOf(before: readonly RequirementDraft[], after: readonly RequirementDraft[]): string[] {
  return after.filter((requirement) => {
    const was = before.find((entry) => entry.courseId === requirement.courseId)
    return was !== undefined && was.withinDays === requirement.withinDays && (was.note ?? null) !== (requirement.note ?? null)
  }).map((requirement) => requirement.courseId)
}

/** A new course of a machine type: ACTIVE, of the whole group; a retired machine type takes no new course. */
async function checkAvailable(client: Client, row: ClassRow, requirements: readonly RequirementDraft[], changes: SheetChanges): Promise<void> {
  if (changes.courses.added.length === 0) return
  const at = (courseId: string) => `requirements/${requirements.findIndex((requirement) => requirement.courseId === courseId)}/courseId`
  if (!row.active) refuse('CLASS_RETIRED', `The type of machine ${row.code} is retired: it asks no new course.`, at(changes.courses.added[0]!))
  const found = await client.safetyCourse.findMany({ where: { id: { in: [...changes.courses.added] } }, select: { id: true, status: true, companyId: true, code: true } })
  for (const courseId of changes.courses.added) {
    const course = found.find((entry) => entry.id === courseId)
    if (!course || course.status !== 'ACTIVE') refuse('COURSE_NOT_AVAILABLE', 'A type of machine asks ACTIVE courses of the catalogue.', at(courseId))
    if (course!.companyId !== null) refuse('COURSE_NOT_GROUP_WIDE', `Course ${course!.code} is one company’s: a type of machine is the group’s, so it asks courses of the whole group.`, at(courseId))
  }
}

/** "What this changes" for the people authorised on the machine type (the role sheets' own diff and impact), and its fingerprint. */
async function previewOf(client: Client, context: OfficeContext, row: ClassRow, requirements: readonly RequirementDraft[], today: BusinessDate) {
  const lines = await classLines(client, row.id)
  const before = classAsks(lines.map((line) => ({ courseId: line.courseId, withinDays: line.withinDays, note: line.note })))
  const after = classAsks(requirements)
  const changes = sheetChanges(before, after.content)
  await checkAvailable(client, row, requirements, changes)
  const people = await authorisedPeople(client, context, row.id, today)
  const holdings = await holdingsOf(
    client,
    people.map((person) => person.employeeId),
    [...changes.courses.added, ...changes.courses.changed.map((change) => change.courseId)],
    [],
    today,
  )
  const impact = sheetImpact(
    people.map((person) => ({ employeeId: person.employeeId, name: person.name })),
    before,
    after.content,
    changes,
    holdings,
  ).map((line) => ({ kind: line.kind, courseId: line.courseId, people: line.people, already: line.already, names: line.names ? line.names.map((person) => ({ ...person })) : null, withinDays: line.withinDays ? { ...line.withinDays } : null }))
  const noted = notedOf(before.content.requirements, after.content.requirements)
  const shown = {
    changes: { added: [...changes.courses.added], removed: [...changes.courses.removed], changed: changes.courses.changed.map((change) => ({ courseId: change.courseId, withinDays: { ...change.withinDays } })), noted, nothing: !changes.requirementsChanged },
    impact,
    people: people.length,
  }
  // The lines read (id, version) are part of what the caller saw: a change made meanwhile is caught even when the diff reads the same.
  const basis = lines.map((line) => [line.id, line.version])
  const refs = await courseRefs(client, [...lines.map((line) => line.courseId), ...requirements.map((requirement) => requirement.courseId)])
  return { preview: { ...shown, refs, fingerprint: fingerprintOf({ ...shown, basis }) }, lines, changes }
}

/** The machine type the caller may change the courses of (403 without a grant over every company). */
async function writableClass(caller: CommandCaller, machineClassId: string): Promise<{ context: OfficeContext; row: ClassRow }> {
  const context = officeOf(caller)
  const row = await caller.withClient((client) => readClass(client, machineClassId))
  if (!overEveryCompany(context)) throw new ForbiddenError(CLASS_WORDS)
  return { context, row }
}

/** POST /safety/training/requirements/machine-classes/:machineClassId/preview. */
export async function previewClassCourses(caller: CommandCaller, machineClassId: string, body: { readonly requirements: readonly RequirementDraft[] }, now: Date = new Date()) {
  const { context, row } = await writableClass(caller, machineClassId)
  const requirements = checkedRequirements(body.requirements)
  const today = todayOf(now)
  return caller.withClient(async (client) => {
    const { preview } = await previewOf(client, context, row, requirements, today)
    return { machineClass: classView(row), ...preview, today }
  })
}

/** PUT /safety/training/requirements/machine-classes/:machineClassId: ONE command, with the fingerprint read. */
export async function applyClassCourses(caller: CommandCaller, machineClassId: string, body: { readonly requirements: readonly RequirementDraft[]; readonly fingerprint: string }, idempotencyKey?: string) {
  const { context } = await writableClass(caller, machineClassId)
  const requirements = checkedRequirements(body.requirements)
  const { result } = await command(caller, { name: 'safety.setMachineClassCourses', idempotencyKey, input: { machineClassId, ...body } }, async (tools) => {
    const { tx, now } = tools
    // One change of a machine type's courses at a time (machine types are not this module's rows: no version of theirs moves).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.training.machine-class', current_setting('factory.tenant_id', true), ${machineClassId}::text), 0))`
    const row = await readClass(tx, machineClassId)
    const { preview, lines, changes } = await previewOf(tx, context, row, requirements, todayOf(now))
    if (preview.fingerprint !== body.fingerprint)
      refuse('IMPACT_CHANGED', 'What this changes is not what you read any more (someone changed these courses, authorised a person or recorded a training meanwhile): read it again.')
    if (preview.changes.nothing) {
      tools.audit({ action: 'safety.setMachineClassCourses', recordType: 'MachineClass', recordId: row.id, companyId: null, after: { unchanged: true } })
      return { machineClass: classView(row), ...preview, applied: false }
    }
    const by = actorIdOf(tools.context)
    if (changes.courses.removed.length > 0) await tx.trainingRequirement.deleteMany({ where: { source: 'MACHINE_CLASS', machineClassId: row.id, courseId: { in: [...changes.courses.removed] } } })
    for (const requirement of requirements) {
      const was = lines.find((line) => line.courseId === requirement.courseId)
      if (!was || (was.withinDays === requirement.withinDays && (was.note ?? null) === (requirement.note ?? null))) continue
      await tx.trainingRequirement.update({ where: { id: was.id }, data: { withinDays: requirement.withinDays, note: requirement.note ?? null, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    }
    const added = requirements.filter((requirement) => changes.courses.added.includes(requirement.courseId))
    if (added.length > 0)
      await tx.trainingRequirement.createMany({
        data: added.map((requirement) => ({ id: newId(), source: 'MACHINE_CLASS' as const, machineClassId: row.id, courseId: requirement.courseId, withinDays: requirement.withinDays, note: requirement.note ?? null, createdAt: now, updatedAt: now, createdById: by })),
      })
    tools.audit({
      action: 'safety.setMachineClassCourses',
      recordType: 'MachineClass',
      recordId: row.id,
      companyId: null,
      before: { requirements: lines.map((line) => ({ courseId: line.courseId, withinDays: line.withinDays, note: line.note })) },
      after: { requirements: requirements.map((requirement) => ({ courseId: requirement.courseId, withinDays: requirement.withinDays, note: requirement.note ?? null })), people: preview.people },
    })
    tools.emit({
      type: 'training_requirement.changed',
      subject: row.id,
      companyId: null,
      payload: { machineClassId: row.id, coursesAdded: [...changes.courses.added], coursesRemoved: [...changes.courses.removed], coursesChanged: [...preview.changes.changed.map((change) => change.courseId), ...preview.changes.noted], people: preview.people },
    })
    return { machineClass: classView(row), ...preview, applied: true }
  })
  return result
}
