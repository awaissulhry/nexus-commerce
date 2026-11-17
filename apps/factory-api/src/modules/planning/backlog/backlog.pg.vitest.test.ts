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
// B-PR-22b: a second customer made in the brand-slot test, and an office person limited to it.
const BETA = newId()
const SESSIONS: Record<string, SessionContext> = {
  planner: office(['planning.view', 'planning.backlog.manage', 'orders.view']),
  reader: office(['planning.view', 'orders.view']),
  betaReader: { audience: 'office', tenantId: tenant, actorId: newId(), grants: [{ permissions: ['planning.view', 'orders.view'], companies: 'all', sites: 'all', parties: [BETA] }] },
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
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
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

// ── B-PR-22b ──
/**
 * B-PR-22b (production plan §3 "Brand-slot rule"; review fixes R-40, R-46, R-69; wall test PW-18): the customer's urgency in the
 * backlog. Made here, after the tests above (their "rank by rule" hand-ranks every order open then): customer A (the seeds' P1)
 * gets three new orders and a made-up customer Beta two, all normal priority, their promises interleaved A, B, A, B, A; each with
 * its production state, Regular. Then A marks its three Urgent (3rd, 2nd, 1st in its own list): A's orders take A's own places in
 * its own order, Beta's places are identical before and after; with A's switch off the marks order nothing; a person limited to
 * Beta reads only Beta's orders and no urgency of A. The marks are written as the customer's command leaves them (the command
 * itself: modules/production/brand-portal/urgency.pg.vitest.test.ts).
 */
describe("B-PR-22b the customer's urgency in the backlog: the brand-slot pass (PW-18)", { timeout: 120_000 }, () => {
  const made: Record<'a1' | 'a2' | 'a3' | 'b1' | 'b2', string> = { a1: newId(), a2: newId(), a3: newId(), b1: newId(), b2: newId() }
  const P1 = seedUuid(ns, 'party:P1')
  const placesOf = (backlog: Json, ids: readonly string[]) => ids.map((orderId) => (backlog.orders as Json[]).find((order) => order.id === orderId)?.position ?? null)
  const orderOf = (backlog: Json, ids: readonly string[]) => (backlog.orders as Json[]).filter((order) => ids.includes(order.id)).map((order) => order.id)

  it("A's three urgent orders take A's own places in A's order; Beta's places never change; switched off, no effect", async () => {
    const actorId = newId()
    await database.withScope({ audience: 'office', tenantId: tenant, actorId }, (client) =>
      client.$transaction(async (tx) => {
        await tx.party.create({ data: { id: BETA, code: 'T-BKL-BETA', kind: 'ORGANISATION', legalName: 'Made-up customer Beta', roles: ['CUSTOMER'] }, select: { id: true } })
        const plan: [keyof typeof made, string, string][] = [
          ['a1', P1, '2026-12-01'],
          ['b1', BETA, '2026-12-02'],
          ['a2', P1, '2026-12-03'],
          ['b2', BETA, '2026-12-04'],
          ['a3', P1, '2026-12-05'],
        ]
        for (const [key, partyId, promise] of plan) {
          await tx.salesOrder.create({
            data: { id: made[key], companyId: A.company!, partyId, number: `T-BKL-${key.toUpperCase()}-${made[key].slice(-4)}`, status: 'CONFIRMED', orderDate: new Date('2026-11-01T00:00:00.000Z'), promiseDate: new Date(`${promise}T00:00:00.000Z`), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up' }, shipTo: { name: 'Made-up' } },
            select: { id: true },
          })
          await tx.brandOrderProduction.create({ data: { id: newId(), companyId: A.company!, partyId, salesOrderId: made[key], key: `brand-production:${made[key]}`, createdById: actorId }, select: { id: true } })
        }
        for (const partyId of [P1, BETA]) {
          const settings = await tx.portalSettings.findUnique({ where: { id: partyId }, select: { id: true } })
          if (settings) await tx.portalSettings.update({ where: { id: partyId }, data: { productionUrgencyOn: true, productionUrgentMax: 3 }, select: { id: true } })
          else await tx.portalSettings.create({ data: { id: partyId, partyId, productionUrgencyOn: true, productionUrgentMax: 3 }, select: { id: true } })
        }
      }),
    )
    const alpha = [made.a1, made.a2, made.a3]
    const beta = [made.b1, made.b2]
    const before = await ok('reader', 'GET', `/planning/backlog?companyId=${A.company}`)
    expect(orderOf(before, [...alpha, ...beta])).toEqual([made.a1, made.b1, made.a2, made.b2, made.a3])
    const alphaPlaces = placesOf(before, alpha)
    const betaPlaces = placesOf(before, beta)
    expect((before.orders as Json[]).filter((order) => [...alpha, ...beta].includes(order.id)).every((order) => order.customerUrgency === null)).toBe(true)

    // A marks a3 1st, a2 2nd, a1 3rd (as its portal command writes them: Urgent, its own place, by the customer).
    for (const [orderId, rank] of [[made.a3, 1], [made.a2, 2], [made.a1, 3]] as const) {
      await admin(`UPDATE "BrandOrderProduction" SET urgency = 'URGENT', "urgentRank" = $2, "urgencySetAt" = now(), "urgencySetBy" = 'BRAND', "urgencyBatchId" = $3, version = version + 1 WHERE key = $1`, [`brand-production:${orderId}`, rank, newId()])
    }
    const marked = await ok('reader', 'GET', `/planning/backlog?companyId=${A.company}`)
    // A's orders hold exactly A's places, now in A's own order; Beta's places are identical (PW-18).
    expect(placesOf(marked, beta)).toEqual(betaPlaces)
    expect(placesOf(marked, [made.a3, made.a2, made.a1])).toEqual(alphaPlaces)
    expect(orderOf(marked, [...alpha, ...beta])).toEqual([made.a3, made.b1, made.a2, made.b2, made.a1])
    const a3 = (marked.orders as Json[]).find((order) => order.id === made.a3)!
    expect(a3.why).toMatch(/customer urgency: own places \(urgent 1\)/)
    expect(a3.customerUrgency).toEqual({ urgentRank: 1, words: { it: 'Urgenza cliente: Urgente 1', en: 'Customer urgency: Urgent 1' } })
    // Its place by the rule alone is unchanged (the pass is never a key of the rule); no lever of ours was written.
    expect((marked.orders as Json[]).find((order) => order.id === made.a3)!.rulePosition).toBe((before.orders as Json[]).find((order) => order.id === made.a3)!.rulePosition)
    expect(await admin(`SELECT id FROM "SalesOrder" WHERE id = ANY($1::uuid[]) AND ("backlogRank" IS NOT NULL OR priority <> 0 OR "priorityLevel" <> 'NORMAL')`, [[...alpha, ...beta]])).toEqual([])

    // A person limited to Beta reads only Beta's orders, in the same places among themselves, and no urgency of A.
    const limited = await ok('betaReader', 'GET', `/planning/backlog?companyId=${A.company}`)
    expect((limited.orders as Json[]).every((order) => order.customer.id === BETA)).toBe(true)
    expect(orderOf(limited, beta)).toEqual(beta)
    expect(JSON.stringify(limited)).not.toContain(made.a1)
    expect((limited.orders as Json[]).every((order) => order.customerUrgency === null)).toBe(true)

    // A's urgency switch off: the marks are kept but order nothing (R-46).
    await admin(`UPDATE "PortalSettings" SET "productionUrgencyOn" = false, version = version + 1 WHERE id = $1`, [P1])
    const off = await ok('reader', 'GET', `/planning/backlog?companyId=${A.company}`)
    expect(orderOf(off, [...alpha, ...beta])).toEqual([made.a1, made.b1, made.a2, made.b2, made.a3])
    expect(placesOf(off, beta)).toEqual(betaPlaces)
    expect((off.orders as Json[]).filter((order) => alpha.includes(order.id)).every((order) => order.customerUrgency === null)).toBe(true)
    expect((await admin<{ urgency: string }>(`SELECT urgency::text FROM "BrandOrderProduction" WHERE key = $1`, [`brand-production:${made.a3}`]))[0]!.urgency).toBe('URGENT')
  })

  it('a hand-ranked order keeps its place: an urgent mark on it orders nothing', async () => {
    await admin(`UPDATE "PortalSettings" SET "productionUrgencyOn" = true, version = version + 1 WHERE id = $1`, [P1])
    await ok('planner', 'PUT', '/planning/backlog/ranks', { companyId: A.company, ranks: [{ orderId: made.a1, from: null, to: 1 }] }, key())
    const backlog = await ok('reader', 'GET', `/planning/backlog?companyId=${A.company}`)
    const a1 = (backlog.orders as Json[]).find((order) => order.id === made.a1)!
    expect(a1).toMatchObject({ rank: 1, why: 'Ranked by hand: 1.', customerUrgency: null })
    // The other two urgent orders of A take A's remaining own places (the rule's b1, a2, b2, a3: A holds the 2nd and 4th), a3 first.
    expect(orderOf(backlog, [made.a2, made.a3, made.b1, made.b2])).toEqual([made.b1, made.a3, made.b2, made.a2])
  })
})
// ── end B-PR-22b ──
