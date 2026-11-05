import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, holds } from '@nexus/factory-domain/core/permissions'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { SAFETY_VIEW } from '@nexus/factory-domain/safety/organisation/permissions'
import { fingerprintOf } from '@nexus/factory-domain/safety/rolesheets/rules'
import { SAFETY_TRAINING_MANAGE } from '@nexus/factory-domain/safety/training/permissions'
import {
  AGREEMENT_LAW,
  cleanCourse,
  COURSE_CODE,
  COURSE_TYPE_LAW,
  courseChanges,
  courseCode,
  courseProblems,
  countNeeds,
  MACHINE_TRAINING_LAW,
  refresherImpact,
  STANDARD_COURSES,
  TRAINING_LAW,
  TRAINING_LIMITS,
  type CourseFields,
  type CourseType,
  type Holding,
  type RefresherImpact,
} from '@nexus/factory-domain/safety/training/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { actorIdOf, assertVersion, bodyIssue, dayOf, dayOrNull, officeOf, problemsError, refuse, siteScope, todayOf } from '../organisation/access'
import { countingAuthorisation, trainingNeedsOf, trainingPeopleOf } from './needs'
import { auditedCourse, CLASS_SELECT, classView, COURSE_SELECT, courseView, fieldsOf, i18nOf, mayReadCourse, mayWriteCourse, overEveryCompany, readCourse, RECORD_COURSE, requiredByOf, type CourseRow } from './store'

/**
 * The safety course catalogue (B-W2b-133; QHS-241; design people.skills "Course catalogue" with its empty state "Start from
 * the standard list", the pop-up "Course" whose save first says whose dates move; D.Lgs. 81/2008 art. 37 and the State-Regions
 * agreement), office only, each write one command with an Idempotency-Key:
 *
 *   GET   /safety/training/courses                  the catalogue (safety.view; ?companyId&status&type&q): type, hours,
 *                                                   refresher, in person, provider, the law, how many roles and machine
 *                                                   types ask each course
 *   GET   /safety/training/courses/standard         the standard list to review (types, names, the law; hours and periods
 *                                                   left for the person to type)
 *   POST  /safety/training/courses/standard         add the reviewed list in one command
 *   GET   /safety/training/courses/:id              one course: who asks it (roles, machine types) and the people (counts)
 *   POST  /safety/training/courses                  add a course (of a company, or of the group with a grant over every
 *                                                   company); its code and type never change
 *   POST  /safety/training/courses/:id/preview      what a draft changes: the fields, and for a new refresher period whose
 *                                                   dates it would put elsewhere (records keep theirs), with a fingerprint
 *   PATCH /safety/training/courses/:id              save it (version; the fingerprint read, else IMPACT_CHANGED)
 *   POST  /safety/training/courses/:id/archive      once no ACTIVE role sheet and no active machine type asks it; /restore
 *
 * The hours and refresher periods are the company's settings: nothing here holds a number of the law.
 */

type Client = FactoryClient | CommandTx

const L = TRAINING_LIMITS
const LAW = { training: TRAINING_LAW, agreement: AGREEMENT_LAW, machines: MACHINE_TRAINING_LAW }
const MANAGE_WORDS = 'The course catalogue is kept by a role that keeps it (safety.training.manage).'
const GROUP_WORDS = 'A course of the whole group is kept by a role over every company: add it to one company instead.'

/** The caller holds the permission at the screen's company (or anywhere, when the screen names none). */
const holdsHere = (context: OfficeContext, permission: typeof SAFETY_TRAINING_MANAGE): boolean => (context.companyId ? can(actorOf(context), permission, { companyId: context.companyId }) : holds(actorOf(context), permission))

export interface ListQuery {
  readonly companyId?: string | undefined
  readonly status?: 'ACTIVE' | 'ARCHIVED' | 'all' | undefined
  readonly type?: CourseType | undefined
  readonly q?: string | undefined
}

/** GET /safety/training/courses. */
export async function listCourses(caller: CommandCaller, query: ListQuery, now: Date = new Date()) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const status = query.status ?? 'ACTIVE'
    const q = query.q?.trim()
    const company = query.companyId ?? context.companyId
    const rows = (await client.safetyCourse.findMany({
      where: {
        AND: [
          ...(status === 'all' ? [] : [{ status }]),
          ...(query.type ? [{ type: query.type }] : []),
          ...(company ? [{ OR: [{ companyId: null }, { companyId: company }] }] : []),
          ...(q ? [{ OR: [{ code: { contains: q, mode: 'insensitive' as const } }, { name: { contains: q, mode: 'insensitive' as const } }, { provider: { contains: q, mode: 'insensitive' as const } }] }] : []),
        ],
      },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }, { id: 'asc' }],
      take: L.list + 1,
      select: COURSE_SELECT,
    })) as CourseRow[]
    const readable = rows.slice(0, L.list).filter((row) => mayReadCourse(context, row))
    const requiredBy = await requiredByOf(
      client,
      siteScope(context, SAFETY_VIEW),
      readable.map((row) => row.id),
    )
    return {
      courses: readable.map((row) => courseView(context, row, requiredBy.get(row.id))),
      complete: rows.length <= L.list,
      canAdd: overEveryCompany(context) || holdsHere(context, SAFETY_TRAINING_MANAGE),
      canAddGroupWide: overEveryCompany(context),
      law: LAW,
      today: todayOf(now),
    }
  })
}

async function readableCourse(client: Client, context: OfficeContext, courseId: string): Promise<CourseRow> {
  const row = isUuid(courseId) ? await readCourse(client, courseId) : null
  if (!row || !mayReadCourse(context, row)) throw new NotFoundError('Course not found.')
  return row
}

/** GET /safety/training/courses/:courseId. */
export async function courseRecord(caller: CommandCaller, courseId: string, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  return caller.withClient(async (client) => {
    const row = await readableCourse(client, context, courseId)
    const reach = siteScope(context, SAFETY_VIEW) as Prisma.RoleSheetWhereInput
    const asks = await client.trainingRequirement.findMany({
      where: {
        courseId: row.id,
        OR: [
          { source: 'ROLE_SHEET', roleSheet: { AND: [reach, { status: 'ACTIVE' }] } },
          { source: 'MACHINE_CLASS', machineClass: { active: true } },
        ],
      },
      select: {
        source: true,
        withinDays: true,
        roleSheetId: true,
        machineClassId: true,
        roleSheet: { select: { id: true, code: true, name: true, nameI18n: true, companyId: true, siteId: true, site: { select: { code: true, name: true } } } },
        machineClass: { select: CLASS_SELECT },
      },
    })
    const sheetIds = asks.flatMap((entry) => (entry.roleSheetId ? [entry.roleSheetId] : []))
    const classIds = asks.flatMap((entry) => (entry.machineClassId ? [entry.machineClassId] : []))
    // The people they ask it of: in those roles, or authorised on those machine types, as far as the caller reads people.
    const people =
      sheetIds.length + classIds.length > 0
        ? await trainingPeopleOf(client, {
            AND: [
              siteScope(context, SAFETY_VIEW) as Prisma.EmployeeWhereInput,
              { OR: [{ roleSheetId: { in: sheetIds } }, { machineAuthorisations: { some: { AND: [countingAuthorisation(today), { machineClassId: { in: classIds } }] } } }] },
            ],
          })
        : []
    const { needs } = await trainingNeedsOf(client, people, today)
    const requiredBy = { roleSheets: sheetIds.length, machineClasses: classIds.length }
    return {
      course: courseView(context, row, requiredBy),
      createdAt: toUtcIso(row.createdAt),
      askedBy: {
        roleSheets: asks
          .filter((entry) => entry.roleSheet)
          .map((entry) => ({
            id: entry.roleSheet!.id,
            code: entry.roleSheet!.code,
            name: entry.roleSheet!.name,
            nameI18n: i18nOf(entry.roleSheet!.nameI18n),
            companyId: entry.roleSheet!.companyId,
            siteId: entry.roleSheet!.siteId,
            site: entry.roleSheet!.site,
            withinDays: entry.withinDays,
          }))
          .sort((a, b) => a.site.code.localeCompare(b.site.code) || a.code.localeCompare(b.code)),
        machineClasses: asks
          .filter((entry) => entry.machineClass)
          .map((entry) => ({ ...classView(entry.machineClass!), withinDays: entry.withinDays }))
          .sort((a, b) => a.code.localeCompare(b.code)),
      },
      people: countNeeds(
        needs
          .filter((need) => need.courseId === row.id)
          .map((need) => ({ state: need.state })),
      ),
      law: LAW,
      today,
    }
  })
}

// ---- add ------------------------------------------------------------------------------------------------------------------

export interface NewCourse {
  readonly code: string
  readonly type: CourseType
  readonly name: string
  readonly nameI18n?: Record<string, string> | null | undefined
  readonly hours: string
  readonly refresherMonths?: number | null | undefined
  readonly refresherHours?: string | null | undefined
  readonly inPersonRequired?: boolean | undefined
  readonly provider?: string | null | undefined
  readonly legalBasis?: string | undefined
  readonly sortOrder?: number | undefined
}

/** A new course's fields (the type's law when none is typed), and its own problems (400 under `prefix`). */
function newFields(body: NewCourse, prefix: string): CourseFields {
  const fields: CourseFields = {
    name: body.name,
    nameI18n: body.nameI18n ?? null,
    hours: body.hours,
    refresherMonths: body.refresherMonths ?? null,
    refresherHours: body.refresherHours ?? null,
    inPersonRequired: body.inPersonRequired ?? false,
    provider: body.provider ?? null,
    legalBasis: body.legalBasis ?? COURSE_TYPE_LAW[body.type],
    sortOrder: body.sortOrder ?? 0,
  }
  const problems = [...(COURSE_CODE.test(courseCode(body.code)) ? [] : [{ path: `${prefix}code`, message: 'A code is letters, digits and . _ / - (no spaces).' }]), ...courseProblems(fields, prefix)]
  if (problems.length > 0) throw problemsError(problems, 'The course is not complete.')
  return cleanCourse(fields)
}

/** Writes one new course inside a command (the code free in the group, checked here). */
async function createCourse(tools: CommandTools, companyId: string | null, body: NewCourse, fields: CourseFields, sortOrder: number, field: string, from: 'ONE' | 'STANDARD'): Promise<CourseRow> {
  const { tx, now } = tools
  const code = courseCode(body.code)
  const taken = await tx.safetyCourse.findFirst({ where: { code: { equals: code, mode: 'insensitive' } }, select: { id: true } })
  if (taken) refuse('CODE_TAKEN', `A course with code ${code} is in the catalogue already (codes are unique in the group).`, field)
  const id = newId()
  await tx.safetyCourse.create({
    data: {
      id,
      companyId,
      code,
      name: fields.name,
      ...(fields.nameI18n ? { nameI18n: fields.nameI18n } : {}),
      type: body.type,
      hours: fields.hours,
      refresherMonths: fields.refresherMonths,
      refresherHours: fields.refresherHours,
      inPersonRequired: fields.inPersonRequired,
      provider: fields.provider,
      legalBasis: fields.legalBasis,
      sortOrder,
      createdAt: now,
      updatedAt: now,
      createdById: actorIdOf(tools.context),
    },
    select: { id: true },
  })
  const row = (await readCourse(tx, id))!
  tools.audit({ action: 'safety.addCourse', recordType: RECORD_COURSE, recordId: id, companyId, after: { ...auditedCourse(row), from } })
  tools.emit({ type: 'safety_course.changed', subject: id, companyId, payload: { courseId: id, change: 'ADDED', fields: [], datesThatWouldMove: 0 } })
  return row
}

/** The company of a new course: one the caller keeps, or the group (a grant over every company). */
async function assertCompany(tx: CommandTx, companyId: string | null): Promise<void> {
  if (companyId === null) return
  const company = await tx.company.findUnique({ where: { id: companyId }, select: { id: true } })
  if (!company) throw new NotFoundError('Company not found.')
}

const nextSortOrder = async (tx: CommandTx): Promise<number> => Math.min(L.sortOrder, ((await tx.safetyCourse.aggregate({ _max: { sortOrder: true } }))._max.sortOrder ?? 0) + 1)

export interface CreateBody extends NewCourse {
  readonly companyId?: string | null | undefined
}

/** POST /safety/training/courses. */
export async function addCourse(caller: CommandCaller, body: CreateBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const companyId = body.companyId ?? null
  if (!mayWriteCourse(context, companyId)) throw new ForbiddenError(companyId ? MANAGE_WORDS : GROUP_WORDS)
  const fields = newFields(body, '')
  const { result, replayed } = await command(caller, { name: 'safety.addCourse', idempotencyKey, input: body }, async (tools) => {
    await assertCompany(tools.tx, companyId)
    const row = await createCourse(tools, companyId, body, fields, body.sortOrder ?? (await nextSortOrder(tools.tx)), 'code', 'ONE')
    return { course: courseView(context, row, undefined) }
  })
  return { ...result, replayed }
}

/** GET /safety/training/courses/standard?companyId: the standard list, with what the catalogue has of each type. */
export async function standardList(caller: CommandCaller, query: { readonly companyId?: string | undefined }) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const company = query.companyId ?? context.companyId
    const rows = (await client.safetyCourse.findMany({
      where: company ? { OR: [{ companyId: null }, { companyId: company }] } : {},
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      take: L.list,
      select: COURSE_SELECT,
    })) as CourseRow[]
    const readable = rows.filter((row) => mayReadCourse(context, row))
    const codes = new Set((await client.safetyCourse.findMany({ where: { code: { in: STANDARD_COURSES.map((course) => course.code) } }, select: { code: true } })).map((row) => row.code))
    return {
      courses: STANDARD_COURSES.map((course) => ({
        code: course.code,
        type: course.type,
        name: course.name,
        nameI18n: { ...course.nameI18n },
        legalBasis: course.legalBasis,
        hours: null,
        refresherMonths: null,
        refresherHours: null,
        codeTaken: codes.has(course.code),
        existing: readable.filter((row) => row.type === course.type).map((row) => ({ id: row.id, code: row.code, name: row.name, status: row.status as 'ACTIVE' | 'ARCHIVED' })),
      })),
      canAddGroupWide: overEveryCompany(context),
      law: LAW,
    }
  })
}

/** POST /safety/training/courses/standard: the reviewed list in one command (every code free, every hours typed). */
export async function addStandardCourses(caller: CommandCaller, body: { readonly companyId?: string | null | undefined; readonly courses: readonly NewCourse[] }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const companyId = body.companyId ?? null
  if (!mayWriteCourse(context, companyId)) throw new ForbiddenError(companyId ? MANAGE_WORDS : GROUP_WORDS)
  const seen = new Map<string, number>()
  body.courses.forEach((course, index) => {
    const code = courseCode(course.code)
    if (seen.has(code)) throw bodyIssue(`courses/${index}/code`, `Code ${code} is on the list twice.`)
    seen.set(code, index)
  })
  const fields = body.courses.map((course, index) => newFields(course, `courses/${index}/`))
  const { result, replayed } = await command(caller, { name: 'safety.addStandardCourses', idempotencyKey, input: body }, async (tools) => {
    await assertCompany(tools.tx, companyId)
    const start = await nextSortOrder(tools.tx)
    const rows: CourseRow[] = []
    for (const [index, course] of body.courses.entries()) rows.push(await createCourse(tools, companyId, course, fields[index]!, course.sortOrder ?? Math.min(L.sortOrder, start + index), `courses/${index}/code`, 'STANDARD'))
    return { courses: rows.map((row) => courseView(context, row, undefined)) }
  })
  return { ...result, replayed }
}

// ---- change: preview and save ---------------------------------------------------------------------------------------------

export interface DraftBody {
  readonly name?: string | undefined
  readonly nameI18n?: Record<string, string> | null | undefined
  readonly hours?: string | undefined
  readonly refresherMonths?: number | null | undefined
  readonly refresherHours?: string | null | undefined
  readonly inPersonRequired?: boolean | undefined
  readonly provider?: string | null | undefined
  readonly legalBasis?: string | undefined
  readonly sortOrder?: number | undefined
}

/** The course as the draft would make it (fields left out stay; no refresher period takes its hours away). */
function draftOf(row: CourseRow, body: DraftBody): CourseFields {
  const current = fieldsOf(row)
  const refresherMonths = body.refresherMonths !== undefined ? body.refresherMonths : current.refresherMonths
  return {
    name: body.name ?? current.name,
    nameI18n: body.nameI18n !== undefined ? body.nameI18n : current.nameI18n,
    hours: body.hours ?? current.hours,
    refresherMonths,
    refresherHours: refresherMonths === null ? null : body.refresherHours !== undefined ? body.refresherHours : current.refresherHours,
    inPersonRequired: body.inPersonRequired ?? current.inPersonRequired,
    provider: body.provider !== undefined ? body.provider : current.provider,
    legalBasis: body.legalBasis ?? current.legalBasis,
    sortOrder: body.sortOrder ?? current.sortOrder,
  }
}

function checkedDraft(row: CourseRow, body: DraftBody): CourseFields {
  const draft = draftOf(row, body)
  const problems = courseProblems(draft)
  if (problems.length > 0) throw problemsError(problems, 'The course is not complete.')
  return cleanCourse(draft)
}

/** The people holding a standing record of the course (the newest PASSED one no correction names), as the caller reads people. */
async function holdingsOfCourse(client: Client, context: OfficeContext, courseId: string): Promise<Holding[]> {
  const records = await client.trainingRecord.findMany({
    where: { courseId, result: 'PASSED', corrections: { none: {} }, employee: { AND: [siteScope(context, SAFETY_VIEW) as Prisma.EmployeeWhereInput, { status: 'ACTIVE' }] } },
    orderBy: [{ completedOn: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    select: { employeeId: true, completedOn: true, validUntil: true, employee: { select: { firstName: true, lastName: true } } },
  })
  const newest = new Map<string, Holding>()
  for (const record of records)
    if (!newest.has(record.employeeId))
      newest.set(record.employeeId, { employeeId: record.employeeId, name: `${record.employee.firstName} ${record.employee.lastName}`, completedOn: dayOf(record.completedOn), validUntil: dayOrNull(record.validUntil) })
  return [...newest.values()]
}

/** What a draft changes, and what a new refresher period would do to the holders' dates; the fingerprint of what is shown. */
async function previewOf(client: Client, context: OfficeContext, row: CourseRow, draft: CourseFields) {
  const changes = courseChanges(fieldsOf(row), draft)
  const impact: RefresherImpact | null = changes.some((change) => change.field === 'refresherMonths') ? refresherImpact(await holdingsOfCourse(client, context, row.id), row.refresherMonths, draft.refresherMonths) : null
  const refresher = impact ? { ...impact, people: impact.people.map((person) => ({ ...person })) } : null
  const shown = { changes, refresher }
  return { ...shown, fingerprint: fingerprintOf(shown) }
}

/** The course the caller may change (404 when it may not read it, 403 when it may not change it). */
async function writableCourse(caller: CommandCaller, courseId: string): Promise<{ context: OfficeContext; row: CourseRow }> {
  const context = officeOf(caller)
  const row = await caller.withClient((client) => readableCourse(client, context, courseId))
  if (!mayWriteCourse(context, row.companyId)) throw new ForbiddenError(row.companyId ? MANAGE_WORDS : 'A course of the whole group is changed by a role over every company.')
  return { context, row }
}

/** POST /safety/training/courses/:courseId/preview. */
export async function previewCourse(caller: CommandCaller, courseId: string, body: DraftBody, now: Date = new Date()) {
  const { context, row } = await writableCourse(caller, courseId)
  if (row.status !== 'ACTIVE') refuse('ARCHIVED', 'This course is archived: restore it to change it.')
  const draft = checkedDraft(row, body)
  return caller.withClient(async (client) => ({ course: courseView(context, row, undefined), ...(await previewOf(client, context, row, draft)), today: todayOf(now) as BusinessDate }))
}

export interface SaveBody extends DraftBody {
  readonly version: number
  /** The fingerprint of the preview read: a change made meanwhile is refused instead of saved unseen. */
  readonly impactFingerprint?: string | undefined
}

/** PATCH /safety/training/courses/:courseId: its company, code and type never change. */
export async function saveCourse(caller: CommandCaller, courseId: string, body: SaveBody, idempotencyKey?: string) {
  const { context, row: read } = await writableCourse(caller, courseId)
  assertVersion('course', read.version, body.version)
  if (read.status !== 'ACTIVE') refuse('ARCHIVED', 'This course is archived: restore it to change it.')
  checkedDraft(read, body)
  const { result } = await command(caller, { name: 'safety.changeCourse', idempotencyKey, input: { courseId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await tx.$queryRaw`SELECT "id" FROM "SafetyCourse" WHERE "id" = ${courseId}::uuid FOR UPDATE`
    const row = (await readCourse(tx, courseId))!
    assertVersion('course', row.version, body.version)
    if (row.status !== 'ACTIVE') refuse('ARCHIVED', 'This course is archived: restore it to change it.')
    const draft = checkedDraft(row, body)
    const preview = await previewOf(tx, context, row, draft)
    if (preview.changes.length === 0) {
      tools.audit({ action: 'safety.changeCourse', recordType: RECORD_COURSE, recordId: row.id, companyId: row.companyId, after: { unchanged: true } })
      return { course: courseView(context, row, undefined), ...preview, changed: false }
    }
    if (body.impactFingerprint && body.impactFingerprint !== preview.fingerprint)
      refuse('IMPACT_CHANGED', 'What this changes is not what you read any more (someone changed the course or recorded a training meanwhile): read it again.')
    const fields = new Set(preview.changes.map((change) => change.field))
    await tx.safetyCourse.update({
      where: { id: row.id },
      data: {
        ...(fields.has('name') ? { name: draft.name } : {}),
        ...(fields.has('nameI18n') && draft.nameI18n ? { nameI18n: draft.nameI18n } : {}),
        ...(fields.has('hours') ? { hours: draft.hours } : {}),
        ...(fields.has('refresherMonths') ? { refresherMonths: draft.refresherMonths } : {}),
        ...(fields.has('refresherHours') || fields.has('refresherMonths') ? { refresherHours: draft.refresherHours } : {}),
        ...(fields.has('inPersonRequired') ? { inPersonRequired: draft.inPersonRequired } : {}),
        ...(fields.has('provider') ? { provider: draft.provider } : {}),
        ...(fields.has('legalBasis') ? { legalBasis: draft.legalBasis } : {}),
        ...(fields.has('sortOrder') ? { sortOrder: draft.sortOrder } : {}),
        version: { increment: 1 },
        updatedAt: now,
      },
      select: { id: true },
    })
    // factory-db exports Prisma's types, not its runtime DbNull: a JSON column is cleared in SQL.
    if (fields.has('nameI18n') && draft.nameI18n === null) await tx.$executeRaw`UPDATE "SafetyCourse" SET "nameI18n" = NULL WHERE "id" = ${row.id}::uuid`
    const after = (await readCourse(tx, row.id))!
    tools.audit({ action: 'safety.changeCourse', recordType: RECORD_COURSE, recordId: row.id, companyId: row.companyId, before: auditedCourse(row), after: { ...auditedCourse(after), datesThatWouldMove: preview.refresher?.wouldMove ?? 0 } })
    tools.emit({ type: 'safety_course.changed', subject: row.id, companyId: row.companyId, payload: { courseId: row.id, change: 'EDITED', fields: [...fields], datesThatWouldMove: preview.refresher?.wouldMove ?? 0 } })
    return { course: courseView(context, after, undefined), ...preview, changed: true }
  })
  return result
}

// ---- archive and restore --------------------------------------------------------------------------------------------------

/** POST /safety/training/courses/:courseId/archive | restore. */
export async function setCourseStatus(caller: CommandCaller, courseId: string, to: 'ARCHIVED' | 'ACTIVE', body: { readonly version: number }, idempotencyKey?: string) {
  const { context } = await writableCourse(caller, courseId)
  const name = to === 'ARCHIVED' ? 'safety.archiveCourse' : 'safety.restoreCourse'
  const { result } = await command(caller, { name, idempotencyKey, input: { courseId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await tx.$queryRaw`SELECT "id" FROM "SafetyCourse" WHERE "id" = ${courseId}::uuid FOR UPDATE`
    const row = (await readCourse(tx, courseId))!
    assertVersion('course', row.version, body.version)
    if (to === 'ARCHIVED' && row.status !== 'ACTIVE') refuse('ARCHIVED', 'This course is archived already.')
    if (to === 'ACTIVE' && row.status !== 'ARCHIVED') refuse('NOT_ARCHIVED', 'This course is not archived.')
    if (to === 'ARCHIVED') {
      // Every role sheet and machine type of the group counts (the requirement rows are tenant-wide), not only those the caller reads.
      const roles = await tx.trainingRequirement.count({ where: { courseId: row.id, source: 'ROLE_SHEET', roleSheet: { status: 'ACTIVE' } } })
      const classes = await tx.trainingRequirement.count({ where: { courseId: row.id, source: 'MACHINE_CLASS', machineClass: { active: true } } })
      if (roles + classes > 0) {
        const parts = [...(roles > 0 ? [roles === 1 ? 'one role sheet' : `${roles} role sheets`] : []), ...(classes > 0 ? [classes === 1 ? 'one type of machine' : `${classes} types of machine`] : [])]
        refuse('COURSE_REQUIRED', `${parts.join(' and ')} ${roles + classes === 1 ? 'asks' : 'ask'} this course: take it off them first (the role sheet, or the machine type's courses).`)
      }
    }
    await tx.safetyCourse.update({ where: { id: row.id }, data: { status: to, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ action: name, recordType: RECORD_COURSE, recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status: to } })
    tools.emit({ type: 'safety_course.changed', subject: row.id, companyId: row.companyId, payload: { courseId: row.id, change: to === 'ARCHIVED' ? 'ARCHIVED' : 'RESTORED', fields: [], datesThatWouldMove: 0 } })
    return { course: courseView(context, (await readCourse(tx, row.id))!, undefined) }
  })
  return result
}
