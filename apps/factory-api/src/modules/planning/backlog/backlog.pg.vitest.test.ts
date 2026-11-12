import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCalendar } from '../../../../../../packages/factory-db/seed/calendar'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPlanningDepth } from '../../../../../../packages/factory-db/seed/planning-depth'
import { seed as seedQuality } from '../../../../../../packages/factory-db/seed/quality'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * The backlog ranked (B-W2b-317; PLN-177) on the local stack with the app's real routes: a throwaway PostgreSQL 17 database
 * from the migrations (the runtime login; the SalesOrder triggers, B-W2b-286's backlogRank rule), the factory-db seeds up to
 * the planning depth (SEED-SO-0002 ranked first, SEED-SO-0001 second) and the quality seed's SEED-SO-0003. Made-up data.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/planning/backlog`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = 'backlog-a'
const tenant = seedUuid(ns, 'tenant')
const A: Record<string, string> = {}
const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (permissions: Permission[]): SessionContext => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(permissions)] })
const SESSIONS: Record<string, SessionContext> = {
  planner: office(['planning.view', 'planning.backlog.manage', 'orders.view']),
  reader: office(['planning.view', 'orders.view']),
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const key = () => `backlog-test-${run}-${++keys}`
const call = (session: string, method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown, idempotencyKey?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown, idempotencyKey?: string): Promise<Json> {
  const response = await call(session, method, url, payload, idempotencyKey)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
async function refused(session: string, method: 'GET' | 'PUT' | 'POST', url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const one = async (sql: string, values: unknown[] = []): Promise<string> => (await admin<{ id: string }>(sql, values))[0]!.id
const numbers = (backlog: Json): string[] => (backlog.orders as Json[]).map((order) => order.number)

beforeAll(async () => {
  db = await migratedDatabase('planning_backlog')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  await seedCalendar({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  await seedPlanningDepth({ db: database, namespace: ns })
  await seedQuality({ db: database, namespace: ns })
  A.company = await one(`SELECT "companyId" AS id FROM "Site" WHERE code = 'A1'`)
  A.so1 = await one(`SELECT id FROM "SalesOrder" WHERE number = 'SEED-SO-0001'`)
  A.so2 = await one(`SELECT id FROM "SalesOrder" WHERE number = 'SEED-SO-0002'`)
  A.so3 = await one(`SELECT id FROM "SalesOrder" WHERE number = 'SEED-SO-0003'`)
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 480_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('the backlog ranked (PLN-177)', { timeout: 120_000 }, () => {
  it('ranked by hand first, then by the rule (priority, promise, customer)', async () => {
    const backlog = await ok('reader', 'GET', `/planning/backlog?companyId=${A.company}`)
    expect(backlog).toMatchObject({ company: { id: A.company }, may: { rank: false }, rule: expect.stringMatching(/^Ranked by hand first/) })
    expect(numbers(backlog).slice(0, 2)).toEqual(['SEED-SO-0002', 'SEED-SO-0001'])
    const so2 = (backlog.orders as Json[])[0]!
    expect(so2).toMatchObject({ rank: 1, position: 1, why: 'Ranked by hand: 1.' })
    const so3 = (backlog.orders as Json[]).find((order) => order.number === 'SEED-SO-0003')!
    expect(so3.rank).toBeNull()
    expect(so3.why).toMatch(/^By the rule: normal priority, promised \d{1,2} [A-Z][a-z]{2}/)
    expect(backlog.counts).toMatchObject({ ranked: 2 })
  })

  it('a planner ranks by hand with the rank read; a rank changed since is refused in words', async () => {
    const answer = await ok('planner', 'PUT', '/planning/backlog/ranks', { companyId: A.company, ranks: [{ orderId: A.so3, from: null, to: 1 }] }, key())
    expect(answer.changed).toBe(1)
    // A tie at 1: the rule decides between them.
    expect(numbers(answer.backlog).slice(0, 3)).toEqual(expect.arrayContaining(['SEED-SO-0002', 'SEED-SO-0003', 'SEED-SO-0001']))
    expect((answer.backlog.orders as Json[]).find((order) => order.number === 'SEED-SO-0001')!.position).toBe(3)
    const rank = (await admin<{ backlogRank: number; version: number }>(`SELECT "backlogRank", version FROM "SalesOrder" WHERE id = $1`, [A.so3]))[0]!
    expect(rank.backlogRank).toBe(1)
    const stale = await refused('planner', 'PUT', '/planning/backlog/ranks', { companyId: A.company, ranks: [{ orderId: A.so3, from: null, to: 3 }] }, 409)
    expect(stale.issues[0]).toMatchObject({ path: 'body/ranks/0/from' })
    expect(stale.message).toMatch(/^SEED-SO-0003 was ranked 1 since you read the backlog/)
    const audit = await admin(`SELECT after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'planning.backlog.rank'`, [A.so3])
    expect(audit).toHaveLength(1)
    // Back to the rule.
    const back = await ok('planner', 'PUT', '/planning/backlog/ranks', { companyId: A.company, ranks: [{ orderId: A.so3, from: 1, to: null }] }, key())
    expect((back.backlog.orders as Json[]).find((order) => order.number === 'SEED-SO-0003')!.rank).toBeNull()
  })

  it('refuses a reader without the right, a rank out of range, an order named twice', async () => {
    await refused('reader', 'PUT', '/planning/backlog/ranks', { companyId: A.company, ranks: [{ orderId: A.so3, from: null, to: 1 }] }, 403)
    await refused('planner', 'PUT', '/planning/backlog/ranks', { companyId: A.company, ranks: [{ orderId: A.so3, from: null, to: 0 }] }, 400)
    const twice = await refused('planner', 'PUT', '/planning/backlog/ranks', { companyId: A.company, ranks: [{ orderId: A.so3, from: null, to: 1 }, { orderId: A.so3, from: null, to: 2 }] }, 400)
    expect(twice.issues.map((issue: Json) => issue.path)).toContain('body/ranks/1/orderId')
    await refused('planner', 'PUT', '/planning/backlog/ranks', { companyId: A.company, ranks: [{ orderId: newId(), from: null, to: 1 }] }, 409)
    await refused('reader', 'GET', `/planning/backlog?companyId=${newId()}`, undefined, 404)
  })

  it("writes the rule's order as the ranks (a preview first)", async () => {
    const preview = await ok('reader', 'POST', '/planning/backlog/rank-by-rule', { companyId: A.company, apply: false })
    expect(preview.applied).toBe(false)
    expect((preview.ranks as Json[]).map((entry) => entry.to)).toEqual((preview.ranks as Json[]).map((_, index) => index + 1))
    await refused('reader', 'POST', '/planning/backlog/rank-by-rule', { companyId: A.company, apply: true }, 403)
    const applied = await ok('planner', 'POST', '/planning/backlog/rank-by-rule', { companyId: A.company, apply: true }, key())
    expect(applied).toMatchObject({ applied: true, changed: expect.any(Number) })
    expect((applied.backlog.orders as Json[]).every((order) => order.rank === order.position)).toBe(true)
    // The second time the rule changes nothing.
    await refused('planner', 'POST', '/planning/backlog/rank-by-rule', { companyId: A.company, apply: true }, 409)
    // The outbox has the event.
    const events = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'backlog.ranked'`)
    expect(events.length).toBeGreaterThanOrEqual(3)
  })
})
