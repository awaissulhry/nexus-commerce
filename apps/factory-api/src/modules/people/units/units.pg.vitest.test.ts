import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPeople, type PeopleSeed } from '../../../../../../packages/factory-db/seed/people'
import { seed as seedSalesOrdersDepth, type SalesOrdersDepthSeed } from '../../../../../../packages/factory-db/seed/sales-orders-depth'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * The factory structure (owb-ss5 steps 5.2 + 5.3) on the local stack with the app's real routes: a throwaway PostgreSQL 17
 * database from the migrations (the runtime login: row-level security, Team_guard, Team_unit_check, TeamMember_guard and the
 * OrderTeam guard G4 are real), the factory-db seeds of one tenant up to the people (team L1-A on A1's line L1: E2 its lead, E1
 * and E3; L1-B on B1: EB1) and the orders (SEED-SO-W39-02 in production, SEED-SO-W39-01 waiting for a yes, both of customer P1),
 * office sessions from the test authenticator. Every name and code is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/people/units` (Owner rule 2026-11-27: written, not run during the build).
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let people: PeopleSeed
let orders: SalesOrdersDepthSeed

const NS = 'owb-ss5-units'
const idOf = (key: string): string => seedUuid(NS, key)
const T = {
  tenant: idOf('tenant'),
  companyA: idOf('company:A'),
  siteA1: idOf('site:A1'),
  lineA1: idOf('site:A1:line:L1'),
}
const lineA2 = newId()

const KEEPER: Permission[] = [
  'people.view',
  'people.structure.manage',
  'people.teams.manage',
  'people.loans.manage',
  'people.employees.manage',
  'orders.view',
  'parties.view',
  'sites.view',
  'fields.view',
  'fields.manage',
  'fields.personal.view',
]
const grant = (permissions: readonly Permission[]): Grant => ({ permissions: [...permissions], companies: 'all', sites: 'all', parties: 'all' })
// The sales template holds no people.view today (reported as a gap to the S3 lead): the sales caller here is the template plus
// people.view, so the test shows what R49 asks — sales reads the structure and changes nothing.
const SALES: Permission[] = [...templateOf('sales')!.permissions, 'people.view']
const SESSIONS: Record<string, SessionContext> = {
  keeper: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(KEEPER)] },
  viewer: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['people.view'])] },
  sales: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(SALES)] },
  designer: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(templateOf('designer')!.permissions)] },
  floor: { audience: 'floor', tenantId: T.tenant, actorId: newId(), siteId: T.siteA1, deviceId: newId(), grants: [grant(['people.view'])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await db.admin.query(sql, values)).rows as R[]
const run = randomBytes(4).toString('hex')
let keys = 0
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `u-${run}-${++keys}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString()
const unitOf = (id: string) => ok('keeper', 'GET', `/people/units/${id}`)

beforeAll(async () => {
  db = await migratedDatabase('owb_ss5_units')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: NS })
  people = await seedPeople({ db: database, namespace: NS })
  orders = await seedSalesOrdersDepth({ db: database, namespace: NS })
  // A second line of A1 (made up): the line a loan goes to.
  await admin(`INSERT INTO "Line" (id, "tenantId", "companyId", "siteId", code, name) VALUES ($1, $2, $3, $4, 'L2', 'Line 2 (made up)')`, [lineA2, T.tenant, T.companyA, T.siteA1])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

let floor: Json
let cell: Json
let night: Json

describe('the factory structure (design § 5zb)', () => {
  it('reads the units with their leader, picture and people, the people with their unit today, and who keeps it', async () => {
    const view = await ok('keeper', 'GET', '/people/structure')
    const a = view.units.find((unit: Json) => unit.id === people.teamIds.a)
    expect(a).toMatchObject({ parentId: null, leader: { employeeId: people.employeeIds.e2, name: 'Seed Employee Two' }, takesOrders: true, closed: false, siteId: T.siteA1, people: 3 })
    expect(a.picture).toMatchObject({ kind: 'LETTERS', icon: null })
    expect(view.people.find((person: Json) => person.employeeId === people.employeeIds.e2)).toMatchObject({ unitId: people.teamIds.a, isLeader: true, picture: { kind: 'LETTERS' } })
    expect(view.people.find((person: Json) => person.employeeId === people.employeeIds.e1)).toMatchObject({ unitId: people.teamIds.a, isLeader: false, name: 'Seed Employee One' })
    expect(view.may).toEqual({ manage: true })
    expect((await ok('viewer', 'GET', '/people/structure')).may).toEqual({ manage: false })
  })

  it('makes units (a code from the name), moves one, refuses a cycle in words, changes a profile and shows its own facts', async () => {
    floor = (await ok('keeper', 'POST', '/people/units', { siteId: T.siteA1, name: 'Floor A', kindWord: 'Group', takesOrders: false, pictureKind: 'ICON', pictureIcon: 'layers', pictureColour: 'blue' }, 201)).unit
    expect(floor).toMatchObject({ name: 'Floor A', kindWord: 'Group', takesOrders: false, parentId: null, people: 0, picture: { kind: 'ICON', icon: 'layers', colour: 'blue', letters: 'FA' }, members: [], work: [], version: 1 })
    expect(await admin('SELECT code FROM "Team" WHERE id = $1', [floor.id])).toEqual([{ code: 'FLOOR-A' }])
    cell = (await ok('keeper', 'POST', '/people/units', { parentId: floor.id, name: 'Cell One' }, 201)).unit
    expect(cell).toMatchObject({ parentId: floor.id, siteId: T.siteA1 })
    expect(pathsOf(await no('keeper', 'POST', '/people/units', { siteId: T.siteA1, name: 'Bad', pictureIcon: 'rocket', about: ' '.repeat(3) + 'x'.repeat(501) }, 409))).toEqual(['refusal/PICTURE_ICON_UNKNOWN', 'body/pictureIcon', 'refusal/ABOUT_LENGTH', 'body/about'])

    // A unit never sits under a unit that sits under it.
    const cycle = await no('keeper', 'POST', `/people/units/${floor.id}/move`, { version: floor.version, parentId: cell.id }, 409)
    expect(pathsOf(cycle)).toEqual(['refusal/UNIT_CYCLE', 'body/parentId'])
    expect(cycle.message).toBe('A unit cannot sit under a unit that sits under it: move that unit first.')
    const a = await unitOf(people.teamIds.a)
    const moved = (await ok('keeper', 'POST', `/people/units/${people.teamIds.a}/move`, { version: a.version, parentId: floor.id })).unit
    expect(moved).toMatchObject({ parentId: floor.id, version: a.version + 1 })

    const changed = (
      await ok('keeper', 'PATCH', `/people/units/${people.teamIds.a}`, { version: moved.version, kindWord: '  Line  ', about: 'Sews the jackets (made up).', maxBaskets: 12, takesNewOrders: false, standInEmployeeId: people.employeeIds.e1, standInUntil: null })
    ).unit
    expect(changed).toMatchObject({ kindWord: 'Line', about: 'Sews the jackets (made up).', maxBaskets: 12, takesNewOrders: false, standIn: { employeeId: people.employeeIds.e1, name: 'Seed Employee One', until: null }, version: moved.version + 1 })
    expect(pathsOf(await no('keeper', 'PATCH', `/people/units/${people.teamIds.a}`, { version: changed.version, kindWord: 'x'.repeat(41), maxBaskets: 0 }, 409))).toEqual(['refusal/KIND_WORD_LENGTH', 'body/kindWord', 'refusal/MAX_BASKETS_RANGE', 'body/maxBaskets'])

    // "Your own facts": a custom field of the Team record, written with the unit's own right, read on its profile.
    await ok('keeper', 'POST', '/fields', { recordType: 'TEAM', code: 'room', type: 'TEXT', labelIt: 'Stanza', labelEn: 'Room' }, 201)
    await ok('keeper', 'PUT', `/fields/values/TEAM/${people.teamIds.a}`, { values: [{ code: 'room', value: 'Hall 2 (made up)', version: null }] })
    expect((await unitOf(people.teamIds.a)).ownFacts).toEqual([{ label: 'Room', value: 'Hall 2 (made up)' }])

    const history = (await ok('viewer', 'GET', `/people/units/${people.teamIds.a}/history`)).rows as Json[]
    expect(history.map((row) => row.words)).toEqual(expect.arrayContaining(['Moved under Floor A (was at the top)', 'Profile changed: the kind, what it does, who stands in (Seed Employee One), baskets at one time, takes new orders']))
    expect(history[0]).toMatchObject({ icon: expect.any(String), who: expect.any(String), at: expect.any(String) })
  })

  it('a sales user reads the structure and a unit but changes nothing (403); the designer and the floor have no route', async () => {
    expect((await ok('sales', 'GET', '/people/structure')).may).toEqual({ manage: false })
    await ok('sales', 'GET', `/people/units/${people.teamIds.a}`)
    const a = await unitOf(people.teamIds.a)
    expect((await call('sales', 'POST', '/people/units', { siteId: T.siteA1, name: 'Not mine' })).statusCode).toBe(403)
    expect((await call('sales', 'PATCH', `/people/units/${people.teamIds.a}`, { version: a.version, about: 'x' })).statusCode).toBe(403)
    expect((await call('sales', 'POST', `/people/units/${people.teamIds.a}/move`, { version: a.version, parentId: null })).statusCode).toBe(403)
    expect((await call('sales', 'POST', '/people/units/merge', { keepId: people.teamIds.a, mergeIds: [cell.id], name: 'x' })).statusCode).toBe(403)
    expect((await call('sales', 'POST', `/people/units/${cell.id}/close`, { version: cell.version })).statusCode).toBe(403)
    expect((await call('sales', 'POST', '/people/units/ready-made/preview', { kind: 'OWNER_TEAMS', siteId: T.siteA1 })).statusCode).toBe(403)
    expect((await call('designer', 'GET', '/people/structure')).statusCode).toBe(403)
    expect((await call('designer', 'GET', `/people/units/${people.teamIds.a}`)).statusCode).toBe(403)
    expect((await call('floor', 'GET', '/people/structure')).statusCode).toBe(403)
    expect((await call('floor', 'GET', `/people/units/${people.teamIds.a}/history`)).statusCode).toBe(403)
  })

  it('merges: the people and the open order rows move into the kept unit (never twice on an order), the others are closed', async () => {
    const two = (await ok('keeper', 'POST', '/people/units', { siteId: T.siteA1, name: 'Team Two' }, 201)).unit
    await ok('keeper', 'POST', '/people/teams/moves', { moves: [{ employeeId: people.employeeIds.e3, teamId: two.id }] })
    const twoTeam = (await ok('keeper', 'GET', `/people/teams/${two.id}`)).team
    await ok('keeper', 'PUT', `/people/teams/${two.id}/lead`, { version: twoTeam.version, employeeId: people.employeeIds.e3 })
    // SEED-SO-W39-02: L1-A and Team Two, Team Two in charge. SEED-SO-W39-01: Team Two alone, in charge.
    const insert = `INSERT INTO "OrderTeam" (id, "tenantId", "companyId", "partyId", "siteId", "salesOrderId", "teamId", "inCharge", "givenBy") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'USER')`
    await admin(insert, [newId(), T.tenant, orders.companyA, orders.partyId, T.siteA1, orders.orderId, people.teamIds.a, false])
    await admin(insert, [newId(), T.tenant, orders.companyA, orders.partyId, T.siteA1, orders.orderId, two.id, true])
    await admin(insert, [newId(), T.tenant, orders.companyA, orders.partyId, T.siteA1, orders.waitingOrderId, two.id, true])

    expect(pathsOf(await no('keeper', 'POST', '/people/units/merge', { keepId: people.teamIds.a, mergeIds: [people.teamIds.a], name: 'x' }, 409))).toEqual(['refusal/MERGE_KEEP_TICKED', 'body/mergeIds'])
    expect(pathsOf(await no('keeper', 'POST', '/people/units/merge', { keepId: people.teamIds.a, mergeIds: [people.teamIds.b], name: 'x' }, 409))).toEqual(['refusal/MERGE_OTHER_SITE', 'body/mergeIds'])

    const merged = await ok('keeper', 'POST', '/people/units/merge', { keepId: people.teamIds.a, mergeIds: [two.id], name: 'Line 1 team (made up)', leaderEmployeeId: people.employeeIds.e3 })
    expect(merged).toMatchObject({ moved: { people: 1, orders: 2, units: 0 }, closed: [two.id] })
    expect(merged.unit).toMatchObject({ name: 'Line 1 team (made up)', leader: { employeeId: people.employeeIds.e3 } })
    expect(merged.unit.members.map((member: Json) => member.employeeId)).toContain(people.employeeIds.e3)
    expect(await admin('SELECT status::text AS status, "mergedIntoId" AS merged FROM "Team" WHERE id = $1', [two.id])).toEqual([{ status: 'ARCHIVED', merged: people.teamIds.a }])
    expect(await admin('SELECT count(*)::int AS n FROM "TeamMember" WHERE "teamId" = $1 AND until IS NULL', [two.id])).toEqual([{ n: 0 }])

    const open = await admin<{ so: string; team: string; charge: boolean }>(`SELECT "salesOrderId" AS so, "teamId" AS team, "inCharge" AS charge FROM "OrderTeam" WHERE "salesOrderId" = ANY($1::uuid[]) AND "endedAt" IS NULL ORDER BY "salesOrderId"`, [[orders.orderId, orders.waitingOrderId]])
    expect(open).toEqual(
      [
        { so: orders.orderId, team: people.teamIds.a, charge: true },
        { so: orders.waitingOrderId, team: people.teamIds.a, charge: true },
      ].sort((x, y) => (x.so < y.so ? -1 : 1)),
    )
    expect(await admin(`SELECT count(*)::int AS n FROM "OrderTeam" WHERE "teamId" = $1 AND "endedAt" IS NOT NULL AND "endedById" IS NOT NULL`, [two.id])).toEqual([{ n: 2 }])

    // The unit's work: the order and the customer's CODE, never its name.
    const party = (await admin<{ code: string; legalName: string }>('SELECT code, "legalName" FROM "Party" WHERE id = $1', [orders.partyId]))[0]!
    const unit = await unitOf(people.teamIds.a)
    expect(unit.work.map((row: Json) => row.orderId).sort()).toEqual([orders.orderId, orders.waitingOrderId].sort())
    expect(unit.work.every((row: Json) => row.customerCode === party.code)).toBe(true)
    expect(JSON.stringify(unit.work)).not.toContain(party.legalName)

    const e3 = (await ok('viewer', 'GET', `/people/employees/${people.employeeIds.e3}/history`)).rows as Json[]
    expect(e3.map((row) => row.words)).toEqual(expect.arrayContaining(['Moved to Line 1 team (made up) (the units were merged; was in Team Two, its leader)', 'Moved from team L1-A to team TEAM-TWO', 'Leads Team Two']))
    expect(JSON.stringify(e3)).not.toContain(party.legalName)
  })

  it('closes a unit only with nothing on it: the words say what to move first', async () => {
    const f = await unitOf(floor.id)
    const units = await no('keeper', 'POST', `/people/units/${floor.id}/close`, { version: f.version }, 409)
    expect(pathsOf(units)).toEqual(['refusal/CLOSE_HAS_UNITS'])
    expect(units.message).toBe('Move the 2 units under it to another unit first.')
    const a = await unitOf(people.teamIds.a)
    expect(pathsOf(await no('keeper', 'POST', `/people/units/${people.teamIds.a}/close`, { version: a.version }, 409))).toEqual(['refusal/CLOSE_HAS_PEOPLE', 'refusal/CLOSE_HAS_ORDERS'])
    const c = await unitOf(cell.id)
    expect((await ok('keeper', 'POST', `/people/units/${cell.id}/close`, { version: c.version })).unit).toMatchObject({ closed: true })
    expect(pathsOf(await no('keeper', 'PATCH', `/people/units/${cell.id}`, { version: c.version + 1, about: 'x' }, 409))).toEqual(['refusal/UNIT_CLOSED'])
  })

  it('refuses a loan to a team with no line, in words (L9)', async () => {
    night = (await ok('keeper', 'POST', '/people/units', { siteId: T.siteA1, name: 'Night crew' }, 201)).unit
    const refused = await no('keeper', 'POST', '/people/loans', { employeeId: people.employeeIds.e1, toLineId: lineA2, toTeamId: night.id, startsAt: hours(1), endsAt: hours(5), reason: 'Peak at night (made up)' }, 409)
    expect(pathsOf(refused)).toEqual(['refusal/TEAM_NO_LINE', 'body/toTeamId'])
    expect(refused.message).toBe('This team has no line: a loan needs a line for now.')
  })

  it('a ready-made structure: the preview writes nothing; apply makes the top unit and places the units at the top; again: nothing', async () => {
    const before = await admin<{ n: number }>('SELECT count(*)::int AS n FROM "Team" WHERE "siteId" = $1', [T.siteA1])
    const site = (await admin<{ name: string }>('SELECT name FROM "Site" WHERE id = $1', [T.siteA1]))[0]!
    const preview = await ok('keeper', 'POST', '/people/units/ready-made/preview', { kind: 'OWNER_TEAMS', siteId: T.siteA1 })
    expect(Object.keys(preview)).toEqual(['rows'])
    expect(preview.rows[0]).toEqual({ name: site.name, words: 'Is made, at the top' })
    expect(preview.rows).toEqual(expect.arrayContaining([{ name: 'Floor A', words: `Moves under ${site.name} (was at the top)` }, { name: 'Night crew', words: `Moves under ${site.name} (was at the top)` }]))
    expect(preview.rows.map((row: Json) => row.name)).not.toContain('Line 1 team (made up)')
    expect(await admin('SELECT count(*)::int AS n FROM "Team" WHERE "siteId" = $1', [T.siteA1])).toEqual(before)

    const applied = await ok('keeper', 'POST', '/people/units/ready-made/apply', { kind: 'OWNER_TEAMS', siteId: T.siteA1 })
    expect(applied).toMatchObject({ applied: true, rows: preview.rows })
    const [top] = await admin<{ id: string }>(`SELECT id FROM "Team" WHERE "siteId" = $1 AND code = 'RM-TOP'`, [T.siteA1])
    const view = await ok('keeper', 'GET', `/people/structure?siteId=${T.siteA1}`)
    expect(view.units.find((unit: Json) => unit.id === floor.id).parentId).toBe(top!.id)
    expect(view.units.find((unit: Json) => unit.id === night.id).parentId).toBe(top!.id)
    expect(view.units.find((unit: Json) => unit.id === people.teamIds.a).parentId).toBe(floor.id)
    expect((await ok('keeper', 'POST', '/people/units/ready-made/apply', { kind: 'OWNER_TEAMS', siteId: T.siteA1 })).rows).toEqual([])
  })

  it('a person’s phone (a personal own fact of the Employee record) is hidden without the personal right', async () => {
    await ok('keeper', 'POST', '/fields', { recordType: 'EMPLOYEE', code: 'phone', type: 'TEXT', audience: 'PERSONAL', labelIt: 'Telefono', labelEn: 'Phone' }, 201)
    await ok('keeper', 'PUT', `/fields/values/EMPLOYEE/${people.employeeIds.e1}`, { values: [{ code: 'phone', value: '000 000 0000', version: null }] })
    expect((await ok('keeper', 'GET', `/fields/values/EMPLOYEE/${people.employeeIds.e1}`)).values.map((value: Json) => value.code)).toContain('phone')
    const viewer = await ok('viewer', 'GET', `/fields/values/EMPLOYEE/${people.employeeIds.e1}`)
    expect(viewer.fields.map((field: Json) => field.code)).not.toContain('phone')
    expect(viewer.values.map((value: Json) => value.code)).not.toContain('phone')
  })
})
