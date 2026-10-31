import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { SHEET_TYPES } from '@nexus/factory-domain/imports/job'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPeople, type PeopleSeed } from '../../../../../../packages/factory-db/seed/people'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { applyPlan, planImport } from '../../../platform/imports/worker'
import { systemContext } from '../../../platform/outbox/system'

/**
 * The employee record (B-W2b-26; MES-208, MES-209, MES-211; design people.employees SCR-084 / SCR-085) on the local stack
 * with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level
 * security, the column grants and the …_people_w2b_guards triggers are real), the factory-db seeds of one tenant up to
 * the people (company A on plant A1: E1 with the operator's floor sign-in, E2 the lead with the seed member's account,
 * E3 an agency worker, E4 leaving, E5 left; company B: EB1, and the B1 team leader's sign-in without a record), office
 * sessions from the test authenticator, and a real floor supervisor signed in for Admin › Users (W0's worker edit). Every
 * name and code is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/people/employees`.
 *
 * Statuto dei Lavoratori art. 4 (Owner answers W1, F2): no figure about one person's work is read or shown here.
 */

let h: Harness
let app: FastifyInstance
let people: PeopleSeed

const NS = 'w2b26-employees'
const idOf = (key: string): string => seedUuid(NS, key)
const T = {
  tenant: idOf('tenant'),
  companyA: idOf('company:A'),
  companyB: idOf('company:B'),
  siteA1: idOf('site:A1'),
  siteB1: idOf('site:B1'),
  lineA1: idOf('site:A1:line:L1'),
  lineB1: idOf('site:B1:line:L1'),
  member: idOf('user:member'),
  agency: idOf('party:P2'),
  a1Operator: idOf('worker:A1:operator'),
  a1Lead: idOf('worker:A1:lead'),
  b1Lead: idOf('worker:B1:lead'),
}
const TENANT: TestTenant = { id: T.tenant, slug: NS, companies: [{ id: T.companyA, code: 'A' }, { id: T.companyB, code: 'B' }] }

const HR: Permission[] = ['people.view', 'people.employees.manage', 'people.teams.manage', 'people.loans.manage', 'people.leavers.manage', 'imports.view', 'imports.run', 'imports.apply', 'files.upload', 'files.read', 'threads.read', 'threads.post', 'audit.read']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const HR_ID = newId()
const SESSIONS: Record<string, SessionContext> = {
  hr: { audience: 'office', tenantId: T.tenant, actorId: HR_ID, grants: [grant(HR)] },
  viewer: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['people.view'])] },
  companyB: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(HR, [T.companyB])] },
  none: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['sites.view'])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `t-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown, key?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key ?? freshKey() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const pathsOf = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : []
const eventsOf = async (type: string) => admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [T.tenant, type])

beforeAll(async () => {
  h = await startHarness('w2b26_employees')
  await seedCore({ db: h.database, namespace: NS })
  people = await seedPeople({ db: h.database, namespace: NS })
  await h.database.withScope({ audience: 'office', tenantId: T.tenant, actorId: newId() }, async (client) =>
    applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }),
  )
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000) ON CONFLICT DO NOTHING`, [newId(), T.tenant])
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, 'made-up-hr@example.test', 'Made-up HR', 'ACTIVE')`, [HR_ID, T.tenant])
  // The import engine reads the person's roles again (the dry run and the apply): HR's grant as a stored role too.
  const hrRole = newId()
  await admin(`INSERT INTO "Role" (id, "tenantId", key, name, permissions, grains) VALUES ($1, $2, 'custom.hr', 'Made-up HR', $3, '{}')`, [hrRole, T.tenant, HR])
  await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "siteIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}', '{}', now() - interval '1 day')`, [newId(), T.tenant, HR_ID, hrRole])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('the HR register (SCR-084)', () => {
  it('lists the people at work by last name, with team, lead, floor sign-in and leaving; never a figure about their work', async () => {
    const list = await ok('hr', 'GET', '/people/employees')
    expect(list.employees.map((row: Json) => row.lastName)).toEqual(['Agency Worker', 'Employee B One', 'Employee One', 'Employee Two', 'Office Clerk'])
    const byCode = new Map(list.employees.map((row: Json) => [row.employeeCode, row]))
    expect(byCode.get('SEED-A1-2')).toMatchObject({ isLead: true, team: { code: 'L1-A' }, lead: { name: 'Seed Employee Two' }, officeAccount: true, floor: { signIns: 1, badge: 'ACTIVE', notice: 'MISSING' } })
    expect(byCode.get('SEED-A1-1')).toMatchObject({ isLead: false, team: { code: 'L1-A' }, homeLine: { code: 'L1' }, floor: { signIns: 1, notice: 'ACKNOWLEDGED' }, lifecycle: 'ACTIVE' })
    expect(byCode.get('SEED-A-4')).toMatchObject({ lifecycle: 'LEAVING', leaving: { lastWorkingDay: '2026-11-30', openSteps: 5 }, floor: { signIns: 0, notice: null } })
    expect(list.employees.find((row: Json) => row.kind === 'AGENCY')).toMatchObject({ agency: { id: T.agency }, endDate: '2026-12-31', employeeCode: null })
    // No pay, attendance, efficiency or health column exists on this list (design: "No pay, health or efficiency column").
    expect(keysOf(list).filter((key) => /wage|pay|earn|efficien|attendance|health|minutesWorked|pieces/i.test(key))).toEqual([])
  })

  it('filters by tile, rows, type, team and words; a role over company B sees company B only', async () => {
    expect((await ok('hr', 'GET', '/people/employees?tile=LEAVING')).employees.map((row: Json) => row.employeeCode)).toEqual(['SEED-A-4'])
    expect((await ok('hr', 'GET', '/people/employees?rows=LEFT')).employees.map((row: Json) => row.employeeCode)).toEqual(['SEED-A1-5'])
    expect((await ok('hr', 'GET', '/people/employees?kind=AGENCY')).employees).toHaveLength(1)
    expect((await ok('hr', 'GET', `/people/employees?teamId=${people.teamIds.a}`)).employees.map((row: Json) => row.lastName)).toEqual(['Agency Worker', 'Employee One', 'Employee Two'])
    expect((await ok('hr', 'GET', '/people/employees?q=clerk')).employees.map((row: Json) => row.employeeCode)).toEqual(['SEED-A-4'])
    expect((await ok('companyB', 'GET', '/people/employees')).employees.map((row: Json) => row.employeeCode)).toEqual(['SEED-B1-1'])
    const page = await ok('hr', 'GET', '/people/employees?limit=2')
    expect(page.employees).toHaveLength(2)
    expect((await ok('hr', 'GET', `/people/employees?limit=2&cursor=${page.nextCursor}`)).employees.map((row: Json) => row.lastName)).toEqual(['Employee One', 'Employee Two'])
    expect((await call('none', 'GET', '/people/employees')).statusCode).toBe(403)
  })

  it('counts the tiles and the data problems for the notice banner', async () => {
    const counts = await ok('hr', 'GET', '/people/employees/counts')
    expect(counts.tiles).toEqual({ ACTIVE: 5, STARTING: 0, LEAVING: 1, AGENCY_ENDING: 0, UNLINKED_WORKERS: 1 })
    expect(counts.problems.map((problem: Json) => problem.code)).toEqual(['NOTICE_NOT_ACKNOWLEDGED', 'UNLINKED_WORKERS'])
    expect((await ok('hr', 'GET', '/people/employees/unlinked-workers')).workers.map((row: Json) => [row.id, row.site.code, row.displayName])).toEqual([[T.b1Lead, 'B1', 'Seed Worker B1-2']])
  })

  it('opens the record: floor sign-in read only, team history, loans, the leaver steps, what we do not keep', async () => {
    const e1 = await ok('hr', 'GET', `/people/employees/${people.employeeIds.e1}`)
    expect(e1.floorSignIns).toEqual([expect.objectContaining({ workerId: T.a1Operator, status: 'ACTIVE', badge: expect.objectContaining({ state: 'ACTIVE' }), notice: expect.objectContaining({ state: 'ACKNOWLEDGED' }), floorRoles: [{ key: 'operator', name: expect.any(String) }] })])
    expect(e1.notKept).toEqual(['ADDRESS', 'TAX_CODE', 'IBAN', 'DATE_OF_BIRTH', 'PHOTO', 'HEALTH_DATA', 'BIOMETRICS'])
    expect(e1).toMatchObject({ canManage: true, canLeave: true, leaving: null, officeAccount: null })
    const e4 = await ok('viewer', 'GET', `/people/employees/${people.employeeIds.e4}`)
    expect(e4).toMatchObject({ canManage: false, canLeave: false, leaving: { status: 'OPEN', lastWorkingDay: '2026-11-30' }, loans: [expect.objectContaining({ toLine: expect.objectContaining({ code: 'L1' }), state: 'PLANNED' })] })
    expect(e4.leaving.steps.map((step: Json) => [step.kind, step.status, step.place])).toEqual([
      ['ACCESS_ENDED', 'OPEN', 'OFFICE_ACCOUNT'],
      ['WORK_HANDED_OVER', 'OPEN', 'OPEN_WORK'],
      ['SESSIONS_ENDED', 'SKIPPED', 'FLOOR_SIGN_IN'],
      ['BADGE_RETURNED', 'SKIPPED', 'FLOOR_SIGN_IN'],
      ['SHIFTS_CLEARED', 'OPEN', 'SHIFTS'],
      ['PAYROLL_FLAGGED', 'OPEN', 'PAYROLL'],
      ['EXIT_VISIT', 'OPEN', 'HEALTH'],
    ])
    expect(e4.nextSteps.map((step: Json) => step.code)).toEqual(['LEAVING'])
    const e5 = await ok('hr', 'GET', `/people/employees/${people.employeeIds.e5}`)
    expect(e5.teamHistory).toEqual([expect.objectContaining({ team: expect.objectContaining({ code: 'L1-A' }), until: '2026-06-30' })])
    expect(e5.employee).toMatchObject({ status: 'LEFT', lifecycle: 'LEFT' })
    // A record of another company is not found for a role over company B.
    expect((await call('companyB', 'GET', `/people/employees/${people.employeeIds.e1}`)).statusCode).toBe(404)
  })
})

describe('one person, one record (MES-208, MES-211)', () => {
  let made: Json
  it('makes a record at a site; a repeat answers from its receipt; the code and the floor name are checked', async () => {
    const body = { siteId: T.siteA1, firstName: ' Made ', lastName: 'Up  Person', employeeCode: 'T-100', startDate: '2027-01-11', homeLineId: T.lineA1, jobRole: 'Sample maker', contract: 'PART_TIME', weeklyMinutes: 1200 }
    const key = freshKey()
    made = (await ok('hr', 'POST', '/people/employees', body, 201, key)).employee
    expect(made).toMatchObject({ firstName: 'Made', lastName: 'Up Person', displayName: 'Made U.', employeeCode: 'T-100', companyId: T.companyA, homeLine: { id: T.lineA1 }, lifecycle: 'STARTING', kind: 'EMPLOYEE', version: 1 })
    expect((await ok('hr', 'POST', '/people/employees', body, 200, key)).employee.id).toBe(made.id)
    expect((await eventsOf('employee.created')).map((event) => event.payload)).toContainEqual({ employeeId: made.id, kind: 'EMPLOYEE', source: 'NEW', workerId: null, linkedUser: false })
    expect(await admin('SELECT action FROM "AuditLog" WHERE "recordType" = $1 AND "recordId" = $2', ['Employee', made.id])).toEqual([{ action: 'people.createEmployee' }])

    const taken = await no('hr', 'POST', '/people/employees', { ...body, employeeCode: 'SEED-A1-1' }, 409)
    expect(pathsOf(taken)).toEqual(['refusal/CODE_TAKEN', 'body/employeeCode'])
    // "Employee code already used by Worker …": the B1 team leader's floor sign-in carries SEED-B1-2 and has no record.
    const onWorker = await no('hr', 'POST', '/people/employees', { ...body, employeeCode: 'SEED-B1-2' }, 409)
    expect(pathsOf(onWorker)).toEqual(['refusal/CODE_ON_WORKER', 'body/employeeCode'])
    expect(onWorker.message).toContain('Seed Worker B1-2')
    expect(pathsOf(await no('hr', 'POST', '/people/employees', { ...body, employeeCode: 'T-101', kind: 'AGENCY' }, 400))).toEqual(['body/agencyPartyId', 'body/endDate'])
    expect(pathsOf(await no('hr', 'POST', '/people/employees', { ...body, employeeCode: 'T-101', homeLineId: T.lineB1 }, 409))).toEqual(['refusal/LINE_NOT_OF_SITE', 'body/homeLineId'])
    expect(pathsOf(await no('hr', 'POST', '/people/employees', { ...body, employeeCode: 'T 101' }, 400))).toEqual(['body/employeeCode'])
    expect((await call('viewer', 'POST', '/people/employees', { ...body, employeeCode: 'T-102' })).statusCode).toBe(403)
    expect((await call('companyB', 'POST', '/people/employees', { ...body, employeeCode: 'T-102' })).statusCode).toBe(403)
  })

  it('keeps an agency worker with the agency (an organisation) and the contract end', async () => {
    const agency = (await ok('hr', 'POST', '/people/employees', { siteId: T.siteA1, firstName: 'Made', lastName: 'Temp', kind: 'AGENCY', agencyPartyId: T.agency, startDate: '2026-11-02', endDate: '2026-11-20' }, 201)).employee
    expect(agency).toMatchObject({ kind: 'AGENCY', agency: { id: T.agency }, endDate: '2026-11-20', lifecycle: 'STARTING' })
    // It starts within 14 days (T-100 in January does not).
    expect((await ok('hr', 'GET', '/people/employees/counts')).tiles.STARTING).toBe(1)
    // Away from AGENCY the agency goes with it.
    const external = (await ok('hr', 'PATCH', `/people/employees/${agency.id}`, { version: 1, kind: 'EXTERNAL' })).employee
    expect(external).toMatchObject({ kind: 'EXTERNAL', agency: null, version: 2 })
  })

  it("makes the record of a floor worker: the worker's names, code, language and site, linked; never twice", async () => {
    const fromWorker = (await ok('companyB', 'POST', '/people/employees/from-worker', { workerId: T.b1Lead }, 201)).employee
    expect(fromWorker).toMatchObject({ firstName: 'Seed', lastName: 'Worker B1-2', displayName: 'Seed Worker B1-2', employeeCode: 'SEED-B1-2', locale: 'en', site: { id: T.siteB1 }, floor: { signIns: 1 } })
    expect(await admin('SELECT "employeeId"::text AS e FROM "Worker" WHERE id = $1', [T.b1Lead])).toEqual([{ e: fromWorker.id }])
    expect(pathsOf(await no('hr', 'POST', '/people/employees/from-worker', { workerId: T.b1Lead }, 409))).toEqual(['refusal/WORKER_LINKED', 'body/workerId'])
    expect((await ok('hr', 'GET', '/people/employees/counts')).tiles.UNLINKED_WORKERS).toBe(0)
    expect((await eventsOf('employee.created')).map((event) => event.payload)).toContainEqual({ employeeId: fromWorker.id, kind: 'EMPLOYEE', source: 'WORKER', workerId: T.b1Lead, linkedUser: false })
  })

  let clerk: Json
  it('makes the record of an office user, linked to the account; one record per account; never your own', async () => {
    const userId = newId()
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, 'made-up-clerk@example.test', 'Madeup Clerk', 'ACTIVE')`, [userId, T.tenant])
    clerk = (await ok('hr', 'POST', '/people/employees/from-user', { userId, siteId: T.siteA1, startDate: '2026-02-02', employeeCode: 'T-200' }, 201)).employee
    expect(clerk).toMatchObject({ firstName: 'Madeup', lastName: 'Clerk', officeAccount: true, floor: { signIns: 0 } })
    expect(pathsOf(await no('hr', 'POST', '/people/employees/from-user', { userId, siteId: T.siteA1, startDate: '2026-02-02' }, 409))).toEqual(['refusal/ACCOUNT_TAKEN', 'body/userId'])
    expect(pathsOf(await no('hr', 'POST', '/people/employees/from-user', { userId: HR_ID, siteId: T.siteA1, startDate: '2026-02-02', firstName: 'Made', lastName: 'Hr' }, 409))).toEqual(['refusal/SELF_LINK', 'body/userId'])
  })

  it('changes the record with the version read; a stale version, a left person and another company are refused', async () => {
    const e1 = (await ok('hr', 'GET', `/people/employees/${people.employeeIds.e1}`)).employee
    const changed = (await ok('hr', 'PATCH', `/people/employees/${e1.id}`, { version: e1.version, jobRole: 'Sample maker', weeklyMinutes: 1800, reason: 'New role (made up)' })).employee
    expect(changed).toMatchObject({ jobRole: 'Sample maker', weeklyMinutes: 1800, version: e1.version + 1 })
    expect((await no('hr', 'PATCH', `/people/employees/${e1.id}`, { version: e1.version, jobRole: 'Cutter' }, 409)).message).toContain('changed since you read it')
    expect(pathsOf(await no('hr', 'PATCH', `/people/employees/${people.employeeIds.e5}`, { version: 99, jobRole: 'x' }, 409))).toEqual(['refusal/LEFT'])
    expect(pathsOf(await no('hr', 'PATCH', `/people/employees/${e1.id}`, { version: changed.version, siteId: T.siteB1 }, 400))).toEqual(['body/siteId'])
    const updated = (await eventsOf('employee.updated')).map((event) => event.payload)
    expect(updated).toContainEqual({ employeeId: e1.id, change: 'EDITED', fields: ['jobRole', 'weeklyMinutes'], workerId: null, by: 'OFFICE' })
  })

  it('moves a person to another site of the company: the home line clears and the team membership ends', async () => {
    const siteA2 = newId()
    await admin(`INSERT INTO "Site" (id, "tenantId", "companyId", code, name, kind) VALUES ($1, $2, $3, 'A2', 'Made-up plant A2', 'PLANT')`, [siteA2, T.tenant, T.companyA])
    await ok('hr', 'POST', '/people/teams/moves', { moves: [{ employeeId: made.id, teamId: people.teamIds.a }] })
    expect((await ok('hr', 'GET', `/people/employees/${made.id}`)).employee.team).toMatchObject({ code: 'L1-A' })
    const moved = (await ok('hr', 'PATCH', `/people/employees/${made.id}`, { version: 1, siteId: siteA2 })).employee
    expect(moved).toMatchObject({ site: { id: siteA2 }, homeLine: null, team: null })
    // The membership began today: removed, so the history holds nothing for a team the person never worked in.
    expect(await admin('SELECT count(*)::int AS n FROM "TeamMember" WHERE "employeeId" = $1', [made.id])).toEqual([{ n: 0 }])
    expect((await eventsOf('employee.updated')).map((event) => event.payload)).toContainEqual({ employeeId: made.id, change: 'MOVED_SITE', fields: ['siteId', 'homeLineId'], workerId: null, by: 'OFFICE' })
  })

  it("links a floor sign-in of the same company (one per site); its office account must agree with the record's", async () => {
    // A made-up floor sign-in at A1 naming another office account than the clerk's record.
    const otherUser = newId()
    const worker = newId()
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, 'made-up-other@example.test', 'Made Other', 'ACTIVE')`, [otherUser, T.tenant])
    await admin(`INSERT INTO "Worker" (id, "tenantId", "companyId", "siteId", "displayName", "userId") VALUES ($1, $2, $3, $4, 'Made-up Sign-in', $5)`, [worker, T.tenant, T.companyA, T.siteA1, otherUser])
    expect(pathsOf(await no('hr', 'POST', `/people/employees/${clerk.id}/workers`, { version: clerk.version, workerId: worker }, 409))).toEqual(['refusal/ACCOUNT_DISAGREES', 'body/workerId'])
    // E1 has a sign-in at A1 already.
    const e1 = (await ok('hr', 'GET', `/people/employees/${people.employeeIds.e1}`)).employee
    expect(pathsOf(await no('hr', 'POST', `/people/employees/${e1.id}/workers`, { version: e1.version, workerId: worker }, 409))).toEqual(['refusal/WORKER_SITE_TAKEN', 'body/workerId'])
    // Company B's sign-in never joins a company A record.
    expect(pathsOf(await no('hr', 'POST', `/people/employees/${clerk.id}/workers`, { version: clerk.version, workerId: idOf('worker:B1:operator') }, 409))).toEqual(['refusal/WORKER_LINKED', 'body/workerId'])
    // The clerk's account moved to the made-up user: now the sign-in agrees, and links.
    const relinked = (await ok('hr', 'PUT', `/people/employees/${clerk.id}/user`, { version: clerk.version, userId: otherUser })).employee
    const linked = (await ok('hr', 'POST', `/people/employees/${clerk.id}/workers`, { version: relinked.version, workerId: worker })).employee
    expect(linked.floor.signIns).toBe(1)
    // A worker linked to a record that names an account: Admin › Users may not point it at another account (a 409 in
    // words, never the commit's 500).
    const supervisorUser = await addUser(h, TENANT, { email: `supervisor-${run}@example.test`, role: 'floor_supervisor' })
    const supervisor = new Browser(h.app)
    expect((await supervisor.signIn(TENANT.slug, supervisorUser.email, supervisorUser.password)).body.status).toBe('signed_in')
    const workerRow = (await admin<{ version: number }>('SELECT version FROM "Worker" WHERE id = $1', [worker]))[0]!
    const refused = await supervisor.send('PATCH' as 'POST', `/auth/floor/workers/${worker}`, { version: workerRow.version, userId: HR_ID })
    expect(refused.status, JSON.stringify(refused.body)).toBe(409)
    expect(JSON.stringify(refused.body)).toContain('one person has one account')
    expect(await admin('SELECT "userId"::text AS u FROM "Worker" WHERE id = $1', [worker])).toEqual([{ u: otherUser }])
    // Unlinked with the reason, then the record has no sign-in.
    const unlinked = (await ok('hr', 'POST', `/people/employees/${clerk.id}/workers/${worker}/unlink`, { version: linked.version, reason: 'Linked by mistake (made up)' })).employee
    expect(unlinked.floor.signIns).toBe(0)
    expect(pathsOf(await no('hr', 'PUT', `/people/employees/${clerk.id}/user`, { version: unlinked.version, userId: T.member }, 409))).toEqual(['refusal/ACCOUNT_TAKEN', 'body/userId'])
  })

  it("keeps notes on a team (a group), never on a person's record (a thread is read by every threads.read role there)", async () => {
    expect((await call('hr', 'POST', `/threads/Team/${people.teamIds.a}/notes`, { body: 'Line 1 team moves to the morning shift (made up).' })).statusCode).toBe(201)
    expect(JSON.stringify(await ok('hr', 'GET', `/threads/Team/${people.teamIds.a}`))).toContain('morning shift')
    expect((await call('companyB', 'GET', `/threads/Team/${people.teamIds.a}`)).statusCode).toBe(404)
    expect((await call('hr', 'POST', `/threads/Employee/${people.employeeIds.e1}/notes`, { body: 'x' })).statusCode).toBe(404)
  })
})

describe('the employees import (MES-209)', () => {
  const sha256 = (body: Buffer): string => createHash('sha256').update(body).digest('hex')
  const csv = (lines: string[]): Buffer => Buffer.from(lines.join('\r\n'), 'utf8')
  const system = () => callerFor(h.database, systemContext(T.tenant, newId()))
  async function upload(body: Buffer): Promise<Json> {
    const started = await call('hr', 'POST', '/imports', { importerKey: 'people.employees', companyId: T.companyA, file: { originalName: 'dipendenti.csv', contentType: SHEET_TYPES.csv, sizeBytes: body.length, sha256: sha256(body) } })
    expect(started.statusCode, started.body).toBe(201)
    const { job, upload: presigned } = started.json() as { job: Json; upload: { url: string; headers: Record<string, string> } }
    const sent = await app.inject({ method: 'PUT', url: presigned.url, headers: presigned.headers, payload: body })
    expect(sent.statusCode, sent.body).toBe(200)
    expect((await call('hr', 'POST', `/files/${job.fileId}/complete`)).statusCode).toBe(200)
    await planImport(system(), job.id, { lastAttempt: true })
    return (await call('hr', 'GET', `/imports/${job.id}`)).json().job
  }
  const HEADER = 'Matricola;Nome;Cognome;Tipo;Agenzia;Sito;Linea;Mansione;Ore settimanali;Data assunzione;Data cessazione;Lingua'

  it('plans new people and changes, says each problem in words, applies exactly the plan, and lists who is not in the file', async () => {
    const job = await upload(
      csv([
        HEADER,
        // A new person at A1 on line L1, 37.5 hours a week.
        'IMP-1;Made;Importato;dipendente;;A1;L1;Cucitrice;37,5;01/12/2026;;ro',
        // E1's weekly hours from the payroll file.
        'SEED-A1-1;;;;;;;;40;;;',
        // A new agency worker without the contract end.
        'IMP-2;Made;Interinale;interinale;SEED-S1;A1;;;;01/12/2026;;',
        // The B1 code belongs to company B's record.
        'SEED-B1-1;;;;;;;Cutter;;;;',
        // A new person without the site and the start.
        'IMP-3;Made;Senza;;;;;;;;;',
        // E5 left: the record no longer changes.
        'SEED-A1-5;;;;;;;Cutter;;;;',
      ]),
    )
    const rows: Json[] = (await (await call('hr', 'GET', `/imports/${job.id}/rows`)).json()).rows
    expect(job).toMatchObject({ status: 'PLANNED', rowCount: 6, createCount: 1, updateCount: 1, errorCount: 4 })
    expect(rows.map((row) => [row.rowNumber, row.action])).toEqual([[2, 'CREATE'], [3, 'UPDATE'], [4, 'ERROR'], [5, 'ERROR'], [6, 'ERROR'], [7, 'ERROR']])
    // E1's 30 hours (changed above) become the payroll file's 40.
    expect(rows[1]).toMatchObject({ before: { weeklyHours: '30' }, after: { weeklyHours: '40' } })
    expect(rows[2]!.errors).toEqual([{ column: 'endDate', message: "An agency worker's contract ends: give the end date." }])
    expect(rows[3]!.errors).toEqual([{ column: 'employeeCode', message: "Employee code SEED-B1-1 belongs to another company's record: import it with that company." }])
    expect(rows[4]!.errors).toEqual([{ column: 'site', message: 'A new employee needs it.' }, { column: 'startDate', message: 'A new employee needs it.' }])
    expect(rows[5]!.errors).toEqual([{ column: 'employeeCode', message: 'Employee SEED-A1-5 has left: the record no longer changes by import.' }])
    const applied = await call('hr', 'POST', `/imports/${job.id}/apply`, { version: job.version })
    expect(applied.statusCode, applied.body).toBe(200)
    await applyPlan(system(), job.id, { lastAttempt: true })
    expect((await (await call('hr', 'GET', `/imports/${job.id}`)).json()).job).toMatchObject({ status: 'APPLIED', appliedCount: 2, skippedCount: 0 })
    const created = await admin<Json>(`SELECT "firstName", "lastName", "displayName", locale, "weeklyMinutes", "homeLineId"::text AS line, "startDate"::text AS start FROM "Employee" WHERE "employeeCode" = 'IMP-1'`)
    expect(created).toEqual([{ firstName: 'Made', lastName: 'Importato', displayName: 'Made I.', locale: 'ro', weeklyMinutes: 2250, line: T.lineA1, start: '2026-12-01' }])
    expect((await eventsOf('employee.created')).map((event) => event.payload.source)).toContain('IMPORT')
    // In Nexus but not in the file: the active records of company A with a code the file does not have.
    const missing = await ok('hr', 'GET', `/people/employees/import/${job.id}/missing`)
    expect(missing.missing.map((row: Json) => row.employeeCode).sort()).toEqual(['SEED-A-4', 'SEED-A1-2', 'T-100', 'T-200'])
    expect(missing.missing.find((row: Json) => row.employeeCode === 'SEED-A-4').leaving).toBe(true)
    // The same rows again: nothing left to do.
    const again = await upload(csv([HEADER, 'IMP-1;Made;Importato;;;A1;L1;Cucitrice;37,50;01/12/2026;;ro']))
    expect(again).toMatchObject({ status: 'PLANNED', unchangedCount: 1, createCount: 0, updateCount: 0, errorCount: 0 })
  })

  it('refuses a person without people.employees.manage and a job for every company', async () => {
    const sheet = csv([HEADER, 'IMP-9;Made;Nove;;;A1;;;;01/12/2026;;'])
    const started = await call('viewer', 'POST', '/imports', { importerKey: 'people.employees', companyId: T.companyA, file: { originalName: 'x.csv', contentType: SHEET_TYPES.csv, sizeBytes: sheet.length, sha256: sha256(sheet) } })
    expect(started.statusCode).toBe(403)
    const everyCompany = await call('hr', 'POST', '/imports', { importerKey: 'people.employees', file: { originalName: 'x.csv', contentType: SHEET_TYPES.csv, sizeBytes: sheet.length, sha256: sha256(sheet) } })
    expect(everyCompany.statusCode).toBeGreaterThanOrEqual(400)
    expect(everyCompany.body).toContain('Employees belong to a company: import them for one company.')
  })
})
