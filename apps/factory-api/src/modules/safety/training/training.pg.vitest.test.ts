import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seed as seedHealth } from '../../../../../../packages/factory-db/seed/health'
import { seed as seedPeople, type PeopleSeed } from '../../../../../../packages/factory-db/seed/people'
import { seed as seedSafety, type SafetySeed } from '../../../../../../packages/factory-db/seed/safety'
import { seed as seedSkills } from '../../../../../../packages/factory-db/seed/skills'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'

/**
 * The course catalogue and who needs which course (B-W2b-133; QHS-241, QHS-242) on the local stack: a throwaway PostgreSQL
 * 17 database from the migrations (the runtime login: row-level security and the safety guards are real: a course's code,
 * company and type never change, a requirement names an ACTIVE course when it is made), the real app. Tenant A from the
 * factory-db seeds: the six group-wide courses, A1's Cutter (E1) and Machinist (E2, E3), B1's Machinist (EB1), the clicking
 * press asking specific training (high risk), the training records (E1's specific-high expired), the skills seed's machine
 * authorisations (E1 post-bed, E2 walking-foot until a later day, EB1 lockstitch, E5 revoked). Every name is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/safety/training`.
 */

let h: Harness
let app: FastifyInstance
let safety: SafetySeed
let people: PeopleSeed

const NS = 'w2b133-training'
const idOf = (key: string): string => seedUuid(NS, key)
const T = { tenant: idOf('tenant'), companyA: idOf('company:A'), companyB: idOf('company:B'), siteA1: idOf('site:A1'), siteB1: idOf('site:B1') }
const CLASS = { postBed: idOf('plant:class:POST_BED'), press: idOf('plant:class:CLICKING_PRESS'), walkingFoot: idOf('plant:class:WALKING_FOOT') }
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const OFFICER: Permission[] = ['safety.view', 'safety.training.manage']
const SESSIONS: Record<string, SessionContext> = {
  officer: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(OFFICER)] },
  // Keeps the catalogue of company A only: no course of the group, no machine type's courses.
  officerA: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(OFFICER, [T.companyA])] },
  viewer: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['safety.view'])] },
  viewerB: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['safety.view'], [T.companyB])] },
  sales: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['quotes.view'])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
let keys = 0
const key = () => `training-${++keys}-${newId()}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<string[]> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json().error.issues ?? []).map((issue: Json) => String(issue.path))
}
const today = businessDate(new Date())
const eventsOf = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [T.tenant, type])).map((row) => row.payload)
const MONEY = /unitCost|cost|price|amount/i

beforeAll(async () => {
  h = await startHarness('w2b133_training')
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedHealth({ db: h.database, namespace: NS })
  safety = await seedSafety({ db: h.database, namespace: NS })
  people = await seedPeople({ db: h.database, namespace: NS })
  await seedSkills({ db: h.database, namespace: NS })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 1_500_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('the course catalogue (QHS-241; design people.skills "Course catalogue")', () => {
  it('lists the courses with their hours and refresher as settings, the law, and how many roles and machine types ask each', async () => {
    const answer = await call('viewer', 'GET', '/safety/training/courses')
    expect(answer.statusCode, answer.body).toBe(200)
    expect(answer.body).not.toMatch(MONEY)
    const list = answer.json()
    expect(list).toMatchObject({ canAdd: false, canAddGroupWide: false, complete: true, law: { training: 'D.Lgs. 81/2008 art. 37' }, today })
    const byCode = Object.fromEntries(list.courses.map((row: Json) => [row.code, row]))
    expect(Object.keys(byCode)).toEqual(['SEED-SC-GEN', 'SEED-SC-SPEC-MED', 'SEED-SC-SPEC-HIGH', 'SEED-SC-FIRST-AID', 'SEED-SC-SUPERVISOR', 'SEED-SC-FORKLIFT'])
    expect(byCode['SEED-SC-GEN']).toMatchObject({ companyId: null, type: 'GENERAL', hours: '4', refresherMonths: null, requiredBy: { roleSheets: 3, machineClasses: 0 }, canManage: false })
    expect(byCode['SEED-SC-SPEC-HIGH']).toMatchObject({ hours: '12', refresherMonths: 60, refresherHours: '6', requiredBy: { roleSheets: 1, machineClasses: 1 } })
    expect(byCode['SEED-SC-FIRST-AID']).toMatchObject({ inPersonRequired: true, provider: 'Seed Safety Consultancy (made-up)' })
    // Company B's reader sees the group's courses, and only B1's role sheet asking them.
    expect((await ok('viewerB', 'GET', '/safety/training/courses')).courses.find((row: Json) => row.code === 'SEED-SC-GEN').requiredBy).toEqual({ roleSheets: 1, machineClasses: 0 })
    expect(await ok('officer', 'GET', '/safety/training/courses')).toMatchObject({ canAdd: true, canAddGroupWide: true })
    expect(await ok('officerA', 'GET', `/safety/training/courses?companyId=${T.companyA}`)).toMatchObject({ canAdd: true, canAddGroupWide: false })
    expect((await call('sales', 'GET', '/safety/training/courses')).statusCode).toBe(403)
  })

  it('opens a course: the roles and machine types that ask it and the people they ask it of (counts)', async () => {
    const record = await ok('viewer', 'GET', `/safety/training/courses/${safety.courseIds.specificHigh}`)
    expect(record.askedBy.roleSheets.map((row: Json) => [row.site.code, row.code, row.withinDays])).toEqual([['A1', 'CUT', 60]])
    expect(record.askedBy.machineClasses.map((row: Json) => [row.code, row.label.en, row.withinDays])).toEqual([['CLICKING_PRESS', 'Clicking press', null]])
    // E1 is the Cutter; their record expired years ago.
    expect(record.people).toEqual({ people: 1, met: 0, due: 0, overdue: 1 })
    expect((await call('viewer', 'GET', `/safety/training/courses/${newId()}`)).statusCode).toBe(404)
  })

  it('starts from the standard list: types, names and the law, the hours and periods left for the person to type', async () => {
    const standard = await ok('officer', 'GET', `/safety/training/courses/standard?companyId=${T.companyA}`)
    expect(standard.courses.map((row: Json) => row.type)).toEqual(['GENERAL', 'SPECIFIC_LOW', 'SPECIFIC_MEDIUM', 'SPECIFIC_HIGH', 'SUPERVISOR', 'MANAGER', 'RLS', 'FIRST_AID', 'FIRE', 'FORKLIFT'])
    for (const row of standard.courses) expect([row.hours, row.refresherMonths, row.refresherHours]).toEqual([null, null, null])
    expect(standard.courses[0]).toMatchObject({ code: 'GENERAL', legalBasis: 'D.Lgs. 81/2008 art. 37 c.1 a; Accordo Stato-Regioni', codeTaken: false, existing: [{ code: 'SEED-SC-GEN', status: 'ACTIVE' }] })
    expect((await call('viewer', 'GET', '/safety/training/courses/standard')).statusCode).toBe(403)

    // The person typed the hours of their programme (made-up numbers).
    const fire = { code: 'fire', type: 'FIRE', name: 'Fire and emergency team', nameI18n: { it: 'Addetti antincendio' }, hours: '5', refresherMonths: 30, refresherHours: '2', inPersonRequired: true, legalBasis: standard.courses[8].legalBasis }
    const manager = { code: 'MANAGER', type: 'MANAGER', name: 'Manager (dirigente)', hours: '9.5' }
    expect(await no('officer', 'POST', '/safety/training/courses/standard', { companyId: T.companyA, courses: [fire, { ...manager, code: 'FIRE' }] }, 400)).toEqual(['body/courses/1/code'])
    expect(await no('officer', 'POST', '/safety/training/courses/standard', { companyId: T.companyA, courses: [fire, { ...manager, refresherHours: '2' }] }, 400)).toEqual(['body/courses/1/refresherHours'])
    expect(await no('officer', 'POST', '/safety/training/courses/standard', { companyId: T.companyA, courses: [{ ...fire, code: 'seed-sc-gen' }] }, 409)).toEqual(['refusal/CODE_TAKEN', 'body/courses/0/code'])
    expect((await call('officerA', 'POST', '/safety/training/courses/standard', { courses: [fire] })).statusCode).toBe(403)
    const made = (await ok('officerA', 'POST', '/safety/training/courses/standard', { companyId: T.companyA, courses: [fire, manager] }, 201)).courses
    expect(made.map((row: Json) => [row.code, row.companyId, row.hours, row.refresherMonths, row.refresherHours, row.inPersonRequired, row.status])).toEqual([
      ['FIRE', T.companyA, '5', 30, '2', true, 'ACTIVE'],
      ['MANAGER', T.companyA, '9.5', null, null, false, 'ACTIVE'],
    ])
    // A course typed without a legal basis takes its type's.
    expect(made[1].legalBasis).toBe('D.Lgs. 81/2008 art. 37 c.7; Accordo Stato-Regioni')
    expect(made[0].sortOrder).toBeGreaterThan(6)
    // Company B does not see company A's courses.
    expect((await ok('viewerB', 'GET', '/safety/training/courses')).courses.map((row: Json) => row.code)).not.toContain('FIRE')
    expect((await call('viewerB', 'GET', `/safety/training/courses/${made[0].id}`)).statusCode).toBe(404)
    const events = await eventsOf('safety_course.changed')
    expect(events).toContainEqual({ courseId: made[0].id, change: 'ADDED', fields: [], datesThatWouldMove: 0 })
    expect(JSON.stringify(events)).not.toMatch(/Seed |Employee/)
  })

  it('adds one course; a course of the whole group asks a grant over every company', async () => {
    const body = { code: 'ASPP-REFRESH', type: 'OTHER', name: 'Made-up refresher', hours: '4' }
    expect((await call('officerA', 'POST', '/safety/training/courses', body)).statusCode).toBe(403)
    expect((await call('viewer', 'POST', '/safety/training/courses', body)).statusCode).toBe(403)
    expect(await no('officer', 'POST', '/safety/training/courses', { ...body, code: 'has space' }, 400)).toEqual(['body/code'])
    expect(await no('officer', 'POST', '/safety/training/courses', { ...body, hours: '0' }, 400)).toEqual(['body/hours'])
    const course = (await ok('officer', 'POST', '/safety/training/courses', body, 201)).course
    expect(course).toMatchObject({ companyId: null, code: 'ASPP-REFRESH', type: 'OTHER', legalBasis: 'D.Lgs. 81/2008 art. 37', canManage: true })
    expect(await admin(`SELECT action FROM "AuditLog" WHERE "recordId" = $1`, [course.id])).toEqual([{ action: 'safety.addCourse' }])
  })
})

describe('the pop-up "Course": a change says whose dates it would move (records keep theirs)', () => {
  it('previews a new refresher period, saves it in one command, and moves no date on record', async () => {
    const course = (await ok('officer', 'GET', `/safety/training/courses/${safety.courseIds.specificHigh}`)).course
    const hoursOnly = await ok('officer', 'POST', `/safety/training/courses/${course.id}/preview`, { hours: '12.00', provider: '' })
    expect(hoursOnly.changes).toEqual([])
    const preview = await ok('officer', 'POST', `/safety/training/courses/${course.id}/preview`, { refresherMonths: 36, inPersonRequired: true })
    expect(preview.changes).toEqual([
      { field: 'refresherMonths', from: 60, to: 36 },
      { field: 'inPersonRequired', from: false, to: true },
    ])
    // E1's record followed the 60 months: with 36 it would lapse on another day.
    expect(preview.refresher).toMatchObject({ from: 60, to: 36, holders: 1, followPeriod: 1, wouldMove: 1, ownDate: 0 })
    expect(preview.refresher.people).toEqual([expect.objectContaining({ employeeId: people.employeeIds.e1, name: 'Seed Employee One' })])
    const before = await admin(`SELECT "validUntil"::text AS until FROM "TrainingRecord" WHERE id = $1`, [safety.recordIds.e1Expired])

    expect((await call('viewer', 'POST', `/safety/training/courses/${course.id}/preview`, { refresherMonths: 36 })).statusCode).toBe(403)
    expect((await call('officerA', 'POST', `/safety/training/courses/${course.id}/preview`, { refresherMonths: 36 })).statusCode).toBe(403)
    expect((await call('officer', 'PATCH', `/safety/training/courses/${course.id}`, { version: course.version + 1, refresherMonths: 36 })).statusCode).toBe(409)
    // A fingerprint of another draft is not what would be saved.
    expect(await no('officer', 'PATCH', `/safety/training/courses/${course.id}`, { version: course.version, refresherMonths: 24, impactFingerprint: preview.fingerprint }, 409)).toEqual(['refusal/IMPACT_CHANGED'])
    const saved = await ok('officer', 'PATCH', `/safety/training/courses/${course.id}`, { version: course.version, refresherMonths: 36, inPersonRequired: true, impactFingerprint: preview.fingerprint })
    expect(saved).toMatchObject({ changed: true, fingerprint: preview.fingerprint, course: { version: course.version + 1, refresherMonths: 36, refresherHours: '6', inPersonRequired: true } })
    expect(await admin(`SELECT "validUntil"::text AS until FROM "TrainingRecord" WHERE id = $1`, [safety.recordIds.e1Expired])).toEqual(before)
    expect(await eventsOf('safety_course.changed')).toContainEqual({ courseId: course.id, change: 'EDITED', fields: ['refresherMonths', 'inPersonRequired'], datesThatWouldMove: 1 })
    const audit = await admin(`SELECT before, after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'safety.changeCourse'`, [course.id])
    expect(audit).toHaveLength(1)
    expect(audit[0]!.after).toMatchObject({ refresherMonths: 36, datesThatWouldMove: 1 })
    // The same again changes nothing.
    expect(await ok('officer', 'PATCH', `/safety/training/courses/${course.id}`, { version: course.version + 1, refresherMonths: 36 })).toMatchObject({ changed: false, course: { version: course.version + 1 } })
    // Code and type never change (not even accepted by the route).
    expect((await call('officer', 'PATCH', `/safety/training/courses/${course.id}`, { version: course.version + 1, type: 'GENERAL' })).statusCode).toBe(400)
  })

  it('archives a course nobody asks any more and restores it; a course a role or a machine type asks stays', async () => {
    const asked = (await ok('officer', 'GET', `/safety/training/courses/${safety.courseIds.specificHigh}`)).course
    expect(await no('officer', 'POST', `/safety/training/courses/${asked.id}/archive`, { version: asked.version }, 409)).toEqual(['refusal/COURSE_REQUIRED'])
    const free = (await ok('officer', 'GET', `/safety/training/courses/${safety.courseIds.supervisor}`)).course
    const archived = (await ok('officer', 'POST', `/safety/training/courses/${free.id}/archive`, { version: free.version })).course
    expect(archived).toMatchObject({ status: 'ARCHIVED', version: free.version + 1 })
    expect((await ok('viewer', 'GET', '/safety/training/courses')).courses.map((row: Json) => row.code)).not.toContain('SEED-SC-SUPERVISOR')
    expect((await ok('viewer', 'GET', '/safety/training/courses?status=ARCHIVED')).courses.map((row: Json) => row.code)).toEqual(['SEED-SC-SUPERVISOR'])
    expect(await no('officer', 'POST', `/safety/training/courses/${free.id}/preview`, { hours: '8' }, 409)).toEqual(['refusal/ARCHIVED'])
    expect(await no('officer', 'POST', `/safety/training/courses/${free.id}/archive`, { version: archived.version }, 409)).toEqual(['refusal/ARCHIVED'])
    expect((await ok('officer', 'POST', `/safety/training/courses/${free.id}/restore`, { version: archived.version })).course).toMatchObject({ status: 'ACTIVE' })
  })
})

describe('who needs what (QHS-242; design people.skills "Who needs what": read here, edited in the role sheet)', () => {
  it('lists each role and machine type with its courses, the people it asks them of and met / due / overdue (counts)', async () => {
    const answer = await call('viewer', 'GET', '/safety/training/requirements')
    expect(answer.statusCode, answer.body).toBe(200)
    expect(answer.body).not.toMatch(/Seed Employee|Agency Worker/)
    const list = answer.json()
    const roles = Object.fromEntries(list.roleSheets.map((row: Json) => [`${row.site.code}:${row.code}`, row]))
    expect(Object.keys(roles)).toEqual(['A1:CUT', 'A1:SEW', 'B1:SEW-B'])
    const course = (row: Json, courseId: string) => row.courses.find((entry: Json) => entry.courseId === courseId)
    expect(roles['A1:CUT'].people).toBe(1)
    expect(course(roles['A1:CUT'], safety.courseIds.general)).toMatchObject({ withinDays: null, people: 1, met: 1, due: 0, overdue: 0 })
    expect(course(roles['A1:CUT'], safety.courseIds.specificHigh)).toMatchObject({ withinDays: 60, people: 1, met: 0, overdue: 1 })
    // The Machinists hold the general course; nobody holds the medium-risk one (E3's FAILED).
    expect(roles['A1:SEW'].people).toBe(2)
    expect(course(roles['A1:SEW'], safety.courseIds.general)).toMatchObject({ people: 2, met: 2 })
    expect(course(roles['A1:SEW'], safety.courseIds.specificMedium)).toMatchObject({ people: 2, met: 0 })
    const classes = Object.fromEntries(list.machineClasses.map((row: Json) => [row.code, row]))
    expect(classes.CLICKING_PRESS).toMatchObject({ people: 0, courses: [{ courseId: safety.courseIds.specificHigh, withinDays: null, people: 0 }] })
    // E1 on the post-bed, E2 on the walking-foot (until a later day), not E5 (revoked, and gone).
    expect([classes.POST_BED.people, classes.WALKING_FOOT.people, classes.POST_BED.courses]).toEqual([1, 1, []])
    expect(list.overall.needs).toBeGreaterThanOrEqual(6)
    expect(list.courses.map((row: Json) => row.code)).toEqual(expect.arrayContaining(['SEED-SC-GEN', 'SEED-SC-SPEC-MED', 'SEED-SC-SPEC-HIGH']))
    expect(list.canManageClasses).toBe(false)
    // Company B's reader: B1's role only, and only B1's people on the machine types.
    const b = await ok('viewerB', 'GET', '/safety/training/requirements')
    expect(b.roleSheets.map((row: Json) => row.code)).toEqual(['SEW-B'])
    expect(b.machineClasses.find((row: Json) => row.code === 'POST_BED').people).toBe(0)
    expect(b.machineClasses.find((row: Json) => row.code === 'LOCKSTITCH').people).toBe(1)
    expect((await ok('viewer', 'GET', `/safety/training/requirements?siteId=${T.siteB1}`)).roleSheets.map((row: Json) => row.code)).toEqual(['SEW-B'])
  })

  it('opens one role: its people by name, each course’s due day and state (the day they took the role + its days)', async () => {
    const role = await ok('viewer', 'GET', `/safety/training/requirements/role-sheets/${safety.roleSheetIds.cutter}`)
    expect(role.roleSheet).toMatchObject({ code: 'CUT', status: 'ACTIVE', site: { code: 'A1' } })
    expect(role.people).toHaveLength(1)
    const e1 = role.people[0]
    expect(e1).toMatchObject({ employeeId: people.employeeIds.e1, name: 'Seed Employee One', since: '2024-03-04' })
    expect(e1.courses).toEqual([
      { courseId: safety.courseIds.general, dueOn: '2024-03-04', state: 'MET' },
      { courseId: safety.courseIds.specificHigh, dueOn: '2024-05-03', state: 'OVERDUE' },
    ])
    expect((await call('viewerB', 'GET', `/safety/training/requirements/role-sheets/${safety.roleSheetIds.cutter}`)).statusCode).toBe(404)
  })
})

describe('the courses a type of machine asks (edited here; machine types are the group’s)', () => {
  it('says who now needs a course, applies it in one command with the fingerprint read, and refuses what does not fit', async () => {
    const before = await ok('officer', 'GET', `/safety/training/requirements/machine-classes/${CLASS.postBed}`)
    expect(before).toMatchObject({ machineClass: { code: 'POST_BED' }, courses: [], canManage: true })
    expect(before.people.map((person: Json) => [person.name, person.since])).toEqual([['Seed Employee One', '2025-02-03']])
    const draft = { requirements: [{ courseId: safety.courseIds.specificHigh, withinDays: 30, note: 'Before working alone at the post-bed (made-up).' }] }
    const preview = await ok('officer', 'POST', `/safety/training/requirements/machine-classes/${CLASS.postBed}/preview`, draft)
    expect(preview).toMatchObject({ people: 1, changes: { added: [safety.courseIds.specificHigh], removed: [], changed: [], nothing: false } })
    expect(preview.impact).toEqual([{ kind: 'COURSE_NEEDED', courseId: safety.courseIds.specificHigh, people: 1, already: 0, names: [{ employeeId: people.employeeIds.e1, name: 'Seed Employee One' }], withinDays: { from: null, to: 30 } }])
    expect(preview.refs.map((row: Json) => row.code)).toEqual(['SEED-SC-SPEC-HIGH'])

    const fireA = (await ok('officer', 'GET', `/safety/training/courses?companyId=${T.companyA}&q=FIRE`)).courses[0]
    expect(await no('officer', 'POST', `/safety/training/requirements/machine-classes/${CLASS.postBed}/preview`, { requirements: [{ courseId: fireA.id, withinDays: null }] }, 409)).toEqual([
      'refusal/COURSE_NOT_GROUP_WIDE',
      'body/requirements/0/courseId',
    ])
    expect(await no('officer', 'POST', `/safety/training/requirements/machine-classes/${CLASS.postBed}/preview`, { requirements: [draft.requirements[0], draft.requirements[0]] }, 400)).toEqual(['body/requirements/1/courseId'])
    expect((await call('officerA', 'POST', `/safety/training/requirements/machine-classes/${CLASS.postBed}/preview`, draft)).statusCode).toBe(403)
    expect((await call('viewer', 'PUT', `/safety/training/requirements/machine-classes/${CLASS.postBed}`, { ...draft, fingerprint: preview.fingerprint })).statusCode).toBe(403)
    expect(await no('officer', 'PUT', `/safety/training/requirements/machine-classes/${CLASS.postBed}`, { requirements: [{ ...draft.requirements[0], withinDays: 10 }], fingerprint: preview.fingerprint }, 409)).toEqual(['refusal/IMPACT_CHANGED'])

    const applied = await ok('officer', 'PUT', `/safety/training/requirements/machine-classes/${CLASS.postBed}`, { ...draft, fingerprint: preview.fingerprint })
    expect(applied).toMatchObject({ applied: true, people: 1, changes: { added: [safety.courseIds.specificHigh] } })
    expect(await eventsOf('training_requirement.changed')).toEqual([{ machineClassId: CLASS.postBed, coursesAdded: [safety.courseIds.specificHigh], coursesRemoved: [], coursesChanged: [], people: 1 }])
    expect(await admin(`SELECT action, "companyId" FROM "AuditLog" WHERE "recordId" = $1 AND action = 'safety.setMachineClassCourses'`, [CLASS.postBed])).toEqual([{ action: 'safety.setMachineClassCourses', companyId: null }])
    // E1 needs it from the post-bed too: authorised 2025-02-03 + 30 days, long past.
    const after = await ok('viewer', 'GET', `/safety/training/requirements/machine-classes/${CLASS.postBed}`)
    expect(after.courses).toMatchObject([{ courseId: safety.courseIds.specificHigh, withinDays: 30, people: 1, met: 0, overdue: 1, version: 1 }])
    expect(after.people[0].courses).toEqual([{ courseId: safety.courseIds.specificHigh, dueOn: '2025-03-05', state: 'OVERDUE' }])
    expect((await ok('viewer', 'GET', `/safety/training/courses/${safety.courseIds.specificHigh}`)).askedBy.machineClasses.map((row: Json) => row.code).sort()).toEqual(['CLICKING_PRESS', 'POST_BED'])

    // The same again: nothing applied, no event.
    const again = await ok('officer', 'POST', `/safety/training/requirements/machine-classes/${CLASS.postBed}/preview`, draft)
    expect(again.changes.nothing).toBe(true)
    expect(await ok('officer', 'PUT', `/safety/training/requirements/machine-classes/${CLASS.postBed}`, { ...draft, fingerprint: again.fingerprint })).toMatchObject({ applied: false })
    expect(await eventsOf('training_requirement.changed')).toHaveLength(1)

    // Taken off again: a count, no names (nobody is asked it any more by this machine type).
    const off = await ok('officer', 'POST', `/safety/training/requirements/machine-classes/${CLASS.postBed}/preview`, { requirements: [] })
    expect(off.impact).toEqual([{ kind: 'COURSE_NOT_NEEDED', courseId: safety.courseIds.specificHigh, people: 1, already: 0, names: null, withinDays: null }])
    expect(await ok('officer', 'PUT', `/safety/training/requirements/machine-classes/${CLASS.postBed}`, { requirements: [], fingerprint: off.fingerprint })).toMatchObject({ applied: true, changes: { removed: [safety.courseIds.specificHigh] } })
    expect(await admin(`SELECT count(*)::int AS n FROM "TrainingRequirement" WHERE "machineClassId" = $1`, [CLASS.postBed])).toEqual([{ n: 0 }])
    expect((await call('viewer', 'GET', `/safety/training/requirements/machine-classes/${newId()}`)).statusCode).toBe(404)
  })
})
