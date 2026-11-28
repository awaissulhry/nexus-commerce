import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPeople, type PeopleSeed } from '../../../../../../packages/factory-db/seed/people'
import { seed as seedPortalAuth } from '../../../../../../packages/factory-db/seed/portal-auth'
import { seed as seedProduction, type ProductionSeed } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * owb-ss5 step 5.1 — teams own the work, on the local stack with the app's real routes: a throwaway PostgreSQL 17 database from the
 * migrations (the runtime login: row-level security and the G4 trigger are real), the factory-db seeds of one tenant up to the
 * people and production (P1's SEED-SO-0002 at plant A1 with SEED-WO-0001 and its two baskets; team L1-A on A1's line L1 with three
 * people: E2 its lead, E1, E3; L1-B of company B), office sessions from the test authenticator. Every name and code is made up.
 * Written, not run in the build (Owner rule: checks at the end). Run with `node scripts/factory/run-pg-tests.mjs modules/production/order-teams`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let people: PeopleSeed
let production: ProductionSeed

const NS = 'owb-ss5-order-teams'
const idOf = (key: string): string => seedUuid(NS, key)
const T = { tenant: idOf('tenant'), companyA: idOf('company:A'), companyB: idOf('company:B'), siteA1: idOf('site:A1'), party: idOf('party:P1') }

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  manager: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['orders.view', 'workorders.view', 'production.teams.assign'])] },
  sales: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['orders.view', 'workorders.view', 'threads.read', 'threads.post', 'tasks.manage', 'home.view'])] },
  designer: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['orders.view.own', 'files.read'])] },
  companyB: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['orders.view', 'workorders.view', 'production.teams.assign'], [T.companyB])] },
  floor: { audience: 'floor', tenantId: T.tenant, actorId: newId(), siteId: T.siteA1, deviceId: newId(), grants: [] } as SessionContext,
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT'
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
const teamsOf = (orderId: string, session = 'manager') => ok(session, 'GET', `/production/orders/${orderId}/teams`)
const put = (orderId: string, version: number, rows: { teamId: string; inCharge: boolean; basketShare: number | null }[], session = 'manager') =>
  call(session, 'PUT', `/production/orders/${orderId}/teams`, { version, rows, why: 'Made-up reason' })

/** A new open team of plant A1 (company A) that takes orders, with `members` of the people seed; its id. */
async function newTeam(code: string, members: string[] = []): Promise<string> {
  const id = newId()
  await admin(`INSERT INTO "Team" (id, "tenantId", "companyId", "siteId", code, name) VALUES ($1, $2, $3, $4, $5, $6)`, [id, T.tenant, T.companyA, T.siteA1, code, `Made-up team ${code}`])
  for (const employeeId of members) {
    await admin(`UPDATE "TeamMember" SET until = CURRENT_DATE - 1 WHERE "employeeId" = $1 AND until IS NULL`, [employeeId])
    await admin(`INSERT INTO "TeamMember" (id, "tenantId", "siteId", "teamId", "employeeId", "isLead", since) VALUES ($1, $2, $3, $4, $5, false, CURRENT_DATE)`, [newId(), T.tenant, T.siteA1, id, employeeId])
  }
  return id
}

/** Another CONFIRMED order of P1, a copy of SEED-SO-0002 and its lines under a new number (planted by the owner with triggers off). */
async function anotherOrder(): Promise<string> {
  const id = newId()
  await db.admin.query('BEGIN')
  try {
    await db.admin.query("SET LOCAL session_replication_role = 'replica'")
    await db.admin.query(`INSERT INTO "SalesOrder" SELECT * FROM jsonb_populate_record(NULL::"SalesOrder", (SELECT to_jsonb(o) || $1::jsonb FROM "SalesOrder" o WHERE o.id = $2::uuid))`, [JSON.stringify({ id, number: `T-SO-${id.slice(0, 8)}`, customerSeq: null }), production.salesOrderId])
    // Its lines too (made at A1, the same pieces), each under a new id.
    await db.admin.query(
      `INSERT INTO "SalesOrderLine" SELECT (jsonb_populate_record(NULL::"SalesOrderLine", to_jsonb(l) || jsonb_build_object('id', gen_random_uuid(), 'orderId', $1::uuid))).* FROM "SalesOrderLine" l WHERE l."orderId" = $2::uuid`,
      [id, production.salesOrderId],
    )
    await db.admin.query('COMMIT')
  } catch (error) {
    await db.admin.query('ROLLBACK')
    throw error
  }
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('owb_ss5_order_teams')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: NS })
  await seedAuth({ db: database, namespace: NS })
  await seedPortalAuth({ db: database, namespace: NS })
  production = await seedProduction({ db: database, namespace: NS })
  people = await seedPeople({ db: database, namespace: NS })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('an order’s teams (GET, PUT)', () => {
  it('give the order to one team, then two together; the rows kept are kept, the version moves', async () => {
    const orderId = await anotherOrder()
    const empty = await teamsOf(orderId)
    expect(empty).toMatchObject({ orderId, version: 1, printed: false, mode: 'NONE', rows: [], may: { give: true, ask: true } })
    const one = await ok('manager', 'PUT', `/production/orders/${orderId}/teams`, { version: 1, rows: [{ teamId: people.teamIds.a, inCharge: true, basketShare: null }] })
    expect(one).toMatchObject({ mode: 'ONE', version: 2, rows: [{ team: { id: people.teamIds.a, people: 3 }, inCharge: true, basketShare: null, givenBy: 'USER' }] })
    expect(one.rows[0].team.leader).toMatchObject({ employeeId: people.employeeIds.e2 })
    const second = await newTeam(`T-${run}-B`)
    const together = await ok('manager', 'PUT', `/production/orders/${orderId}/teams`, { version: 2, rows: [{ teamId: people.teamIds.a, inCharge: true, basketShare: null }, { teamId: second, inCharge: false, basketShare: null }] })
    expect(together).toMatchObject({ mode: 'TOGETHER', version: 3 })
    // L1-A was kept (one open row, never ended and written again).
    expect(await admin(`SELECT count(*)::int AS n FROM "OrderTeam" WHERE "salesOrderId" = $1 AND "teamId" = $2`, [orderId, people.teamIds.a])).toEqual([{ n: 1 }])
    // The charge moves to the second team: the flag moves, no row ends.
    const moved = await ok('manager', 'PUT', `/production/orders/${orderId}/teams`, { version: 3, rows: [{ teamId: people.teamIds.a, inCharge: false, basketShare: null }, { teamId: second, inCharge: true, basketShare: null }] })
    expect(moved.rows.find((row: Json) => row.inCharge).team.id).toBe(second)
    // A stale version is a 409 in words.
    expect((await put(orderId, 1, [])).statusCode).toBe(409)
    // One audit row a PUT on the order, with the rows, the mode and why.
    const audit = await admin(`SELECT after FROM "AuditLog" WHERE "recordType" = 'SalesOrder' AND "recordId" = $1 AND action = 'production.setOrderTeams' ORDER BY "createdAt"`, [orderId])
    expect(audit).toHaveLength(3)
    expect(audit[2]!.after).toMatchObject({ mode: 'TOGETHER', why: null })
  })

  it('a split: every team its share, the shares add up to the order’s baskets; the refusals are 409s in words', async () => {
    const orderId = await anotherOrder()
    const second = await newTeam(`T-${run}-S`)
    const read = await teamsOf(orderId)
    const planned = read.plannedBaskets as number
    expect(planned).toBeGreaterThan(1)
    const twice = await no('manager', 'PUT', `/production/orders/${orderId}/teams`, { version: read.version, rows: [{ teamId: second, inCharge: true, basketShare: null }, { teamId: second, inCharge: false, basketShare: null }] }, 409)
    expect(pathsOf(twice)).toContain('refusal/TEAM_TWICE')
    const noCharge = await no('manager', 'PUT', `/production/orders/${orderId}/teams`, { version: read.version, rows: [{ teamId: second, inCharge: false, basketShare: null }] }, 409)
    expect(pathsOf(noCharge)).toContain('refusal/ONE_IN_CHARGE')
    const notAdding = await no('manager', 'PUT', `/production/orders/${orderId}/teams`, { version: read.version, rows: [{ teamId: people.teamIds.a, inCharge: true, basketShare: planned }, { teamId: second, inCharge: false, basketShare: 1 }] }, 409)
    expect(pathsOf(notAdding)).toContain('refusal/SHARES_DO_NOT_ADD_UP')
    const split = await ok('manager', 'PUT', `/production/orders/${orderId}/teams`, { version: read.version, rows: [{ teamId: people.teamIds.a, inCharge: true, basketShare: planned - 1 }, { teamId: second, inCharge: false, basketShare: 1 }] })
    expect(split.mode).toBe('SPLIT')
    // A team of another company, and an archived team, are never put on the order.
    const archived = await newTeam(`T-${run}-X`)
    await admin(`UPDATE "Team" SET status = 'ARCHIVED' WHERE id = $1`, [archived])
    for (const teamId of [people.teamIds.b, archived]) {
      const refused = await no('manager', 'PUT', `/production/orders/${orderId}/teams`, { version: split.version, rows: [{ teamId, inCharge: true, basketShare: null }] }, 409)
      expect(pathsOf(refused)).toContain('refusal/TEAM_NOT_OPEN')
    }
  })

  it('after the first print the shares stay: only together rows are added or taken off', async () => {
    const orderId = await anotherOrder()
    const second = await newTeam(`T-${run}-P`)
    const read = await teamsOf(orderId)
    const planned = read.plannedBaskets as number
    const split = await ok('manager', 'PUT', `/production/orders/${orderId}/teams`, { version: read.version, rows: [{ teamId: people.teamIds.a, inCharge: true, basketShare: planned - 1 }, { teamId: second, inCharge: false, basketShare: 1 }] })
    await admin(`INSERT INTO "OrderPrint" (id, "tenantId", "companyId", "partyId", "salesOrderId", kind, pages, cards) VALUES ($1, $2, $3, $4, $5, 'FIRST', '[]', '[]')`, [newId(), T.tenant, T.companyA, T.party, orderId])
    const printed = await teamsOf(orderId)
    expect(printed.printed).toBe(true)
    const fixed = await no('manager', 'PUT', `/production/orders/${orderId}/teams`, { version: printed.version, rows: [{ teamId: people.teamIds.a, inCharge: true, basketShare: null }] }, 409)
    expect(pathsOf(fixed)).toContain('refusal/SHARES_FIXED')
    expect(split.version).toBe(printed.version)
  })

  it('a team smaller than the smallest group shows no figure; the leader and the picture still show', async () => {
    const orderId = await anotherOrder()
    const small = await newTeam(`T-${run}-1`, [people.employeeIds.e4])
    const answer = await ok('manager', 'PUT', `/production/orders/${orderId}/teams`, { version: 1, rows: [{ teamId: small, inCharge: true, basketShare: null }] })
    expect(answer.rows[0]).toMatchObject({ team: { id: small, people: null, picture: { kind: 'LETTERS' } }, facts: { inWork: null, missingToday: null, late: null, overLimit: false } })
    const board = await ok('manager', 'GET', `/production/teams/board?siteId=${T.siteA1}`)
    const column = board.columns.find((entry: Json) => entry.team?.id === small)
    expect(column).toMatchObject({ load: { inWork: null }, orders: [expect.objectContaining({ orderId, baskets: null })] })
  })
})

describe('who may read, give and ask', () => {
  it('sales reads and asks (a task on the order), never gives (403); the designer, another company and the floor do not reach it', async () => {
    const orderId = await anotherOrder()
    const read = await teamsOf(orderId, 'sales')
    expect(read.may).toEqual({ give: false, ask: true })
    expect((await put(orderId, read.version, [{ teamId: people.teamIds.a, inCharge: true, basketShare: null }], 'sales')).statusCode).toBe(403)
    const asked = await ok('sales', 'POST', `/production/orders/${orderId}/team-asks`, { why: 'The customer wants line 1 again (made up).' }, 201)
    expect(await admin(`SELECT "recordType", "recordId"::text AS record, description FROM "Task" WHERE id = $1`, [asked.taskId])).toEqual([{ recordType: 'SalesOrder', record: orderId, description: 'The customer wants line 1 again (made up).' }])
    expect((await call('designer', 'GET', `/production/orders/${orderId}/teams`)).statusCode).toBe(404)
    expect((await call('designer', 'POST', `/production/orders/${orderId}/team-asks`, { why: 'Made-up ask' })).statusCode).toBe(403)
    expect((await call('companyB', 'GET', `/production/orders/${orderId}/teams`)).statusCode).toBe(404)
    expect((await call('floor', 'GET', `/production/orders/${orderId}/teams`)).statusCode).toBe(403)
    expect((await call('floor', 'GET', `/production/teams/board?siteId=${T.siteA1}`)).statusCode).toBe(403)
  })
})

describe('the teams board of a site', () => {
  it('“No team yet” first, then one column a team that takes orders; customer codes only', async () => {
    const waiting = await anotherOrder()
    const board = await ok('manager', 'GET', `/production/teams/board?siteId=${T.siteA1}`)
    expect(board.columns[0].team).toBeNull()
    expect(board.columns[0].orders.map((order: Json) => order.orderId)).toContain(waiting)
    const code = (await admin(`SELECT code FROM "Party" WHERE id = $1`, [T.party]))[0]!.code
    expect(board.columns[0].orders.find((order: Json) => order.orderId === waiting)).toMatchObject({ customerCode: code })
    const name = (await admin(`SELECT "legalName" AS name FROM "Party" WHERE id = $1`, [T.party]))[0]!.name
    expect(JSON.stringify(board)).not.toContain(name)
    // A team that takes no orders has no column.
    const quiet = await newTeam(`T-${run}-N`)
    await admin(`UPDATE "Team" SET "takesOrders" = false WHERE id = $1`, [quiet])
    const again = await ok('manager', 'GET', `/production/teams/board?siteId=${T.siteA1}`)
    expect(again.columns.some((column: Json) => column.team?.id === quiet)).toBe(false)
    expect(again.teams.some((team: Json) => team.id === people.teamIds.a)).toBe(true)
  })
})
