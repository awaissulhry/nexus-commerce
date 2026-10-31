import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, fixedClock } from '@nexus/factory-domain/core/time'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPeople, type PeopleSeed } from '../../../../../../packages/factory-db/seed/people'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { runLeaverSteps } from './automatic'

/**
 * Leaver steps (B-W2b-26; MES-214; design people.employees "Leavers in progress", "Start leaver steps") on the local stack
 * with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level
 * security and the …_people_w2b_guards triggers are real: one open case per person, steps only while it is open, DONE
 * only with no step open, LEFT only once the end date has come), the factory-db seeds of one tenant up to the people (E1
 * with the A1 operator's floor sign-in and badge, E2 the lead with an account and the A1 lead's sign-in, E4 leaving on
 * 2026-11-30 with no account, E5 left), office sessions from the test authenticator, and the hourly cron's pass with a
 * clock of its own. Every name is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/people/leavers`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let people: PeopleSeed

const NS = 'w2b26-leavers'
const idOf = (key: string): string => seedUuid(NS, key)
const T = { tenant: idOf('tenant'), companyB: idOf('company:B'), a1Operator: idOf('worker:A1:operator'), a1Lead: idOf('worker:A1:lead') }
const HR_ID = newId()
const HR: Permission[] = ['people.view', 'people.leavers.manage', 'people.employees.manage']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  hr: { audience: 'office', tenantId: T.tenant, actorId: HR_ID, grants: [grant(HR)] },
  viewer: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['people.view'])] },
  companyB: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(HR, [T.companyB])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await db.admin.query(sql, values)).rows as R[]
const run = randomBytes(4).toString('hex')
let keys = 0
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `t-${run}-${++keys}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const pathsOf = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const day = (offset: number) => businessDate(new Date(Date.now() + offset * 86_400_000))
const stepOf = (leaver: Json, kind: string): Json => leaver.steps.find((step: Json) => step.kind === kind)
const eventsOf = async (type: string) => admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [T.tenant, type])
const silent = { info() {}, warn() {}, error() {} } as never

beforeAll(async () => {
  db = await migratedDatabase('w2b26_leavers')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: NS })
  people = await seedPeople({ db: database, namespace: NS })
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, 'made-up-hr@example.test', 'Made-up HR', 'ACTIVE')`, [HR_ID, T.tenant])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('leaver steps (MES-214)', () => {
  it('lists who is leaving and previews what leaving would mean for a person', async () => {
    const open = await ok('viewer', 'GET', '/people/leavers')
    expect(open.leavers.map((row: Json) => [row.employee.name, row.lastWorkingDay, row.openSteps])).toEqual([['Seed Office Clerk', '2026-11-30', 5]])
    expect((await ok('viewer', 'GET', '/people/leavers?view=done')).leavers.map((row: Json) => row.employee.name)).toEqual(['Seed Former Employee'])
    const preview = await ok('viewer', 'GET', `/people/employees/${people.employeeIds.e1}/leaving/preview?lastWorkingDay=${day(10)}&exitVisit=true`)
    expect(preview.steps.map((step: Json) => step.kind)).toEqual(['BADGE_OFF', 'SESSIONS_ENDED', 'BADGE_RETURNED', 'WORK_HANDED_OVER', 'SHIFTS_CLEARED', 'PAYROLL_FLAGGED', 'EXIT_VISIT'])
    expect(preview).toMatchObject({ consequences: { floorSignIns: 1, activeBadges: 1, officeAccount: false, openTasks: 0, openMaintenanceJobs: 0, shiftsAfter: 0, loansAfter: 0 }, refusal: null })
    expect((await ok('viewer', 'GET', `/people/employees/${people.employeeIds.e4}/leaving/preview?lastWorkingDay=${day(10)}`)).refusal).toMatchObject({ code: 'ALREADY_LEAVING' })
  })

  it('starts the steps (one open leaving per person), ticks, skips with the reason, reopens, and cancels until the last day', async () => {
    const started = (await ok('hr', 'POST', `/people/employees/${people.employeeIds.e2}/leaving`, { lastWorkingDay: day(10) }, 201)).leaver
    expect(started.steps.map((step: Json) => [step.kind, step.automatic, step.status])).toEqual([
      ['BADGE_OFF', true, 'OPEN'],
      ['SESSIONS_ENDED', true, 'OPEN'],
      ['BADGE_RETURNED', false, 'OPEN'],
      ['ACCESS_ENDED', true, 'OPEN'],
      ['WORK_HANDED_OVER', false, 'OPEN'],
      ['SHIFTS_CLEARED', true, 'OPEN'],
      ['PAYROLL_FLAGGED', true, 'OPEN'],
    ])
    expect(started).toMatchObject({ status: 'OPEN', startedBy: 'Made-up HR', employee: { name: 'Seed Employee Two' }, openSteps: 7 })
    expect(pathsOf(await no('hr', 'POST', `/people/employees/${people.employeeIds.e2}/leaving`, { lastWorkingDay: day(12) }, 409))).toEqual(['refusal/ALREADY_LEAVING'])
    expect(pathsOf(await no('hr', 'POST', `/people/employees/${people.employeeIds.e1}/leaving`, { lastWorkingDay: '2020-01-01' }, 409))).toEqual(['refusal/BEFORE_START', 'body/lastWorkingDay'])
    expect((await call('viewer', 'POST', `/people/employees/${people.employeeIds.e1}/leaving`, { lastWorkingDay: day(10) })).statusCode).toBe(403)
    expect((await call('companyB', 'POST', `/people/employees/${people.employeeIds.e1}/leaving`, { lastWorkingDay: day(10) })).statusCode).toBe(404)
    expect((await ok('viewer', 'GET', `/people/employees/${people.employeeIds.e2}`)).employee.lifecycle).toBe('LEAVING')

    const work = stepOf(started, 'WORK_HANDED_OVER')
    const ticked = (await ok('hr', 'POST', `/people/leavers/${started.id}/steps/${work.id}/done`, { version: work.version })).leaver
    expect(stepOf(ticked, 'WORK_HANDED_OVER')).toMatchObject({ status: 'DONE', doneBy: { kind: 'USER', name: 'Made-up HR' } })
    expect(pathsOf(await no('hr', 'POST', `/people/leavers/${started.id}/steps/${work.id}/done`, { version: work.version + 1 }, 409))).toEqual(['refusal/STEP_NOT_OPEN'])
    const badge = stepOf(ticked, 'BADGE_RETURNED')
    expect((await call('hr', 'POST', `/people/leavers/${started.id}/steps/${badge.id}/skip`, { version: badge.version, reason: ' ' })).statusCode).toBe(400)
    const skipped = (await ok('hr', 'POST', `/people/leavers/${started.id}/steps/${badge.id}/skip`, { version: badge.version, reason: 'The badge was lost (made up)' })).leaver
    expect(stepOf(skipped, 'BADGE_RETURNED')).toMatchObject({ status: 'SKIPPED', skipReason: 'The badge was lost (made up)' })
    const reopened = (await ok('hr', 'POST', `/people/leavers/${started.id}/steps/${badge.id}/reopen`, { version: badge.version + 1 })).leaver
    expect(stepOf(reopened, 'BADGE_RETURNED')).toMatchObject({ status: 'OPEN', doneBy: null, skipReason: null })
    // Nothing automatic is due before the last day; the account is live, the floor sign-in stays on.
    expect(await admin('SELECT status::text FROM "Worker" WHERE id = $1', [T.a1Lead])).toEqual([{ status: 'ACTIVE' }])

    const cancelled = (await ok('hr', 'POST', `/people/leavers/${started.id}/cancel`, { version: reopened.version, reason: 'Stays after all (made up)' })).leaver
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'Stays after all (made up)' })
    expect(pathsOf(await no('hr', 'POST', `/people/leavers/${started.id}/steps/${badge.id}/done`, { version: badge.version + 2 }, 409))).toEqual(['refusal/NOT_OPEN'])
    expect((await ok('viewer', 'GET', `/people/employees/${people.employeeIds.e2}`)).employee.lifecycle).toBe('ACTIVE')
    expect((await eventsOf('leaver.ended')).map((event) => event.payload)).toContainEqual({ caseId: started.id, employeeId: people.employeeIds.e2, outcome: 'CANCELLED', by: 'OFFICE' })
  })

  it('a leaver recorded after the last day: the floor sign-in goes at once, the rest by hand; then the person has LEFT', async () => {
    const started = (await ok('hr', 'POST', `/people/employees/${people.employeeIds.e1}/leaving`, { lastWorkingDay: day(-1) }, 201)).leaver
    expect(started.steps.map((step: Json) => [step.kind, step.status, step.doneBy?.kind ?? null])).toEqual([
      ['BADGE_OFF', 'DONE', 'SYSTEM'],
      ['SESSIONS_ENDED', 'DONE', 'SYSTEM'],
      ['BADGE_RETURNED', 'OPEN', null],
      ['WORK_HANDED_OVER', 'OPEN', null],
      ['SHIFTS_CLEARED', 'DONE', 'SYSTEM'],
      ['PAYROLL_FLAGGED', 'OPEN', null],
    ])
    expect(await admin('SELECT status::text FROM "Worker" WHERE id = $1', [T.a1Operator])).toEqual([{ status: 'INACTIVE' }])
    expect(await admin(`SELECT count(*)::int AS n FROM "Badge" WHERE "workerId" = $1 AND status = 'ACTIVE'`, [T.a1Operator])).toEqual([{ n: 0 }])
    expect(pathsOf(await no('hr', 'POST', `/people/leavers/${started.id}/cancel`, { version: started.version, reason: 'Too late' }, 409))).toEqual(['refusal/PAST_LAST_DAY'])
    let leaver = started
    for (const kind of ['BADGE_RETURNED', 'WORK_HANDED_OVER', 'PAYROLL_FLAGGED']) {
      const step = stepOf(leaver, kind)
      leaver = (await ok('hr', 'POST', `/people/leavers/${started.id}/steps/${step.id}/done`, { version: step.version })).leaver
    }
    expect(leaver).toMatchObject({ status: 'DONE', openSteps: 0 })
    const e1 = (await ok('viewer', 'GET', `/people/employees/${people.employeeIds.e1}`)).employee
    expect(e1).toMatchObject({ status: 'LEFT', lifecycle: 'LEFT', endDate: day(-1), team: null })
    expect(await admin(`SELECT until::text FROM "TeamMember" WHERE "employeeId" = $1 AND "teamId" = $2`, [people.employeeIds.e1, people.teamIds.a])).toEqual([{ until: day(-1) }])
    expect((await eventsOf('leaver.ended')).map((event) => event.payload)).toContainEqual({ caseId: started.id, employeeId: people.employeeIds.e1, outcome: 'DONE', by: 'OFFICE' })
    expect((await eventsOf('employee.updated')).map((event) => event.payload)).toContainEqual({ employeeId: people.employeeIds.e1, change: 'LEFT', fields: ['status', 'endDate'], workerId: null, by: 'OFFICE' })
    // Closed: nothing changes any more; the record is frozen.
    expect(pathsOf(await no('hr', 'POST', `/people/leavers/${started.id}/steps/${stepOf(leaver, 'PAYROLL_FLAGGED').id}/reopen`, { version: stepOf(leaver, 'PAYROLL_FLAGGED').version }, 409))).toEqual(['refusal/NOT_OPEN'])
    expect(pathsOf(await no('hr', 'PATCH', `/people/employees/${people.employeeIds.e1}`, { version: e1.version, jobRole: 'x' }, 409))).toEqual(['refusal/LEFT'])
    expect(pathsOf(await no('hr', 'POST', `/people/employees/${people.employeeIds.e1}/leaving`, { lastWorkingDay: day(1) }, 409))).toEqual(['refusal/LEFT'])
  })

  it('the automatic steps tick themselves: on a check, and in the hourly pass after the last day', async () => {
    // E4 has no office account: access ended is true at once.
    const checked = await ok('hr', 'POST', `/people/leavers/${people.caseIds.open}/check`)
    expect(checked).toMatchObject({ ticked: ['ACCESS_ENDED'], floorSwitchedOff: 0, closed: false })
    expect(stepOf(checked.leaver, 'ACCESS_ENDED')).toMatchObject({ status: 'DONE', doneBy: { kind: 'SYSTEM', name: null } })
    // Nothing more is due before the last day (2026-11-30): a check writes only its audit row.
    expect(await ok('hr', 'POST', `/people/leavers/${people.caseIds.open}/check`)).toMatchObject({ ticked: [], closed: false })
    // The hourly pass on the day after the last day: shifts cleared (none planned after it).
    const pass = await runLeaverSteps({ database, log: silent, clock: fixedClock('2026-12-01T09:00:00.000Z') })
    expect(pass).toMatchObject({ settled: 1, failed: 0 })
    const after = (await ok('viewer', 'GET', `/people/leavers/${people.caseIds.open}`)).leaver
    expect(stepOf(after, 'SHIFTS_CLEARED')).toMatchObject({ status: 'DONE', doneBy: { kind: 'SYSTEM' } })
    expect((await eventsOf('leaver.step_done')).filter((event) => event.payload.by === 'SYSTEM' && event.payload.caseId === people.caseIds.open).map((event) => event.payload.kind)).toEqual(['ACCESS_ENDED', 'SHIFTS_CLEARED'])
    // The same hour again finds nothing due and writes nothing.
    expect(await runLeaverSteps({ database, log: silent, clock: fixedClock('2026-12-01T09:30:00.000Z') })).toMatchObject({ settled: 0, failed: 0 })
    // Every step done before the last day: the case waits (visible) until the day has come.
    let leaver = after
    for (const kind of ['WORK_HANDED_OVER', 'PAYROLL_FLAGGED', 'EXIT_VISIT']) {
      const step = stepOf(leaver, kind)
      leaver = (await ok('hr', 'POST', `/people/leavers/${people.caseIds.open}/steps/${step.id}/done`, { version: step.version })).leaver
    }
    expect(leaver).toMatchObject({ status: 'OPEN', openSteps: 0 })
  })
})
