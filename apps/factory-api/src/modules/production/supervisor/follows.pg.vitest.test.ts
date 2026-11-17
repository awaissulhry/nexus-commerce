import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { MESSAGE_TEMPLATES } from '@nexus/factory-domain/notifications/rules'
import { SUPERVISED_ORDER_STATES } from '@nexus/factory-domain/production-brand/supervisor'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor, type CommandCaller } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { fanOut } from '../../../platform/notifications/fan-out'
import { systemContext } from '../../../platform/outbox/system'
import { KEEPER_ORDER_STATES } from '../brand/facts'
import { productionTwoBrands, supervisorPeople, supervisorPeopleIds, twoBrandIds, twoBrandSessions, type ProductionTwoBrands } from '../testing/two-brands'
import { chunksOf, FOLLOW_CHUNK, supervisorFollows, supervisorFollowsHandler, SUPERVISOR_FOLLOW_EVENTS } from './follows'

/**
 * B-PR-42b — the production supervisor follows and is told (production plan §1 "The supervisor follows every open order of that
 * brand, so every brand message reaches him at once (unless he muted that order — his band then says so)"; lead pick L22; review
 * fixes R-58, R-60; threads agreement T5), and its wall test PW-14: a follow and the ASSIGNMENT bell reach a person only while he
 * reads that order's customer, re-checked per record. The Owner rule 2026-11-16: "One brand must not be able to see anything
 * related to any other brand. But we, as the production unit, should be able to see it all. And manage it all as well."
 *
 * On a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the RecordFollower guard
 * are real), the core, files, production and numbering seeds, the production two-brand harness (brand A = the seeds' P1 with its
 * new order and SEED-SO-0002; brand B = the threads' second brand with SEED-SO-B001; a work order of no customer) and its
 * supervisor people (REAL users with live roles: supervisorA limited to A, backupA over every customer, officeB limited to B).
 * The worker's handler and the fan-out run in-process on the events B-PR-42a's routes wrote (the outbox rows), as the system.
 *
 *   - a customer's default: its supervisor follows every open order's thread and its work orders' (ASSIGNEE); a repeat changes
 *     nothing; one summary audit row naming only that customer's records;
 *   - an order's own: he follows the order and its work order of that one order; the one replaced stops — not where he muted his
 *     follow, not where he holds an open task (threads' unfollowInCommand); back to the default the other way round;
 *   - a new open order and a new work order follow at once; a later status move never follows again (a person's own unfollow
 *     lasts); an order waiting for its approval, a work order of no customer take none;
 *   - PW-14: never a follow where the person does not read the record (limited to the other customer, or his read taken away);
 *   - the bell: ONE ASSIGNMENT per change and person ("You are the production supervisor of 9 orders of <customer>"), never per
 *     order; the backup when newly named (R-60); a person who does not read the orders is not told; who made the change is never
 *     told about it.
 *
 * The tests run in order on one database (each builds on the state the one before left). Every name is made up. Run with
 * `env -u FACTORY_REDIS_URL node scripts/factory/run-pg-tests.mjs modules/production/supervisor/follows`.
 */

const ns = 'pr2l-follows'
const ids = twoBrandIds(ns)
const people = supervisorPeopleIds(ns)
const actorId = seedUuid(ns, 'actor')
const PERMISSIONS: Permission[] = ['workorders.view', 'workorders.manage', 'production.brand.manage', 'threads.read']
const grant = (permissions: Permission[], parties: 'all' | string[]) => ({ permissions, companies: 'all' as const, sites: 'all' as const, parties })
const SESSIONS: Record<string, SessionContext> = {
  ...twoBrandSessions(ids.tenantId, ids.a, ids.b, PERMISSIONS),
  // The supervisor of A himself at his screen (his session's id is his user's): mutes or drops his own follow.
  'supervisor.a': { audience: 'office', tenantId: ids.tenantId, actorId: people.supervisorA, grants: [grant(['workorders.view', 'threads.read'], [ids.a])] },
}

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let w: ProductionTwoBrands
let system: CommandCaller

type Json = Record<string, any>
type Method = 'GET' | 'PUT' | 'POST'
async function ok(session: string, method: Method, url: string, payload?: unknown): Promise<Json> {
  const headers: Record<string, string> = method === 'GET' ? { 'x-test-session': session } : { 'x-test-session': session, 'idempotency-key': newId() }
  const response = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) })
  expect(response.statusCode, `${method} ${url}: ${response.body.slice(0, 600)}`).toBe(200)
  return response.json() as Json
}
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T | undefined> => (await admin<T>(sql, values))[0]

/** Every outbox event of a type, as the relay hands it to a handler. */
async function events(type: string): Promise<EventEnvelope[]> {
  const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [ids.tenantId, type])
  return rows.map((row) => ({ eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload }))
}
/** The supervisor_changed events a step wrote (since `before`). */
async function changedSince(before: readonly EventEnvelope[]): Promise<EventEnvelope[]> {
  const seen = new Set(before.map((event) => event.eventId))
  return (await events('brand_production.supervisor_changed')).filter((event) => !seen.has(event.eventId))
}
/** The worker on each new event, in order (as the relay would). */
async function work(changed: readonly EventEnvelope[]): Promise<{ followed: number; unfollowed: number }> {
  let followed = 0
  let unfollowed = 0
  for (const event of changed) {
    const done = await supervisorFollows(system, event)
    followed += done.followed
    unfollowed += done.unfollowed
  }
  return { followed, unfollowed }
}

/** A person's follow rows of a record: none, or [reason, muted]. */
const followOf = async (recordType: string, recordId: string, userId: string) =>
  one<{ reason: string; muted: boolean }>(`SELECT reason::text AS reason, muted FROM "RecordFollower" WHERE "tenantId" = $1 AND "recordType" = $2 AND "recordId" = $3 AND "userId" = $4`, [ids.tenantId, recordType, recordId, userId])
/** A customer's open orders, and the work orders made of their lines (open, of a customer). */
const openOrdersOf = async (partyId: string) => (await admin<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "partyId" = $1 AND status::text = ANY($2::text[]) ORDER BY id`, [partyId, [...SUPERVISED_ORDER_STATES]])).map((row) => row.id)
const workOrdersOf = async (orderIds: readonly string[]) =>
  (
    await admin<{ id: string }>(
      `SELECT DISTINCT wo.id FROM "WorkOrder" wo JOIN "WorkOrderSize" s ON s."workOrderId" = wo.id JOIN "SalesOrderLine" l ON l.id = s."salesOrderLineId"
        WHERE l."orderId" = ANY($1::uuid[]) AND wo."partyId" IS NOT NULL AND wo.status::text NOT IN ('CLOSED', 'CANCELLED') ORDER BY wo.id`,
      [orderIds],
    )
  ).map((row) => row.id)
const settingsVersion = async (partyId: string) => (await one<{ version: number }>(`SELECT version FROM "PortalSettings" WHERE "partyId" = $1`, [partyId]))?.version ?? 0

/** A made-up order of a customer in a status, written in the office scope. */
async function salesOrder(partyId: string, status: 'CONFIRMED' | 'PENDING_APPROVAL'): Promise<string> {
  const id = newId()
  await database.withScope({ audience: 'office', tenantId: ids.tenantId, actorId }, (client) =>
    client.salesOrder.create({
      data: { id, companyId: w.companyId, partyId, number: `T-PR42B-SO-${id.slice(-6)}`, customerRef: `T-PR42B-PO-${id.slice(-6)}`, status, orderDate: new Date('2026-11-06T00:00:00.000Z'), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer' }, shipTo: { name: 'Made-up workshop' }, promiseDate: new Date('2026-12-18T00:00:00.000Z') },
      select: { id: true },
    }),
  )
  return id
}
/** A made-up event of the sales or production module, as the relay hands it over. */
const eventOf = (type: string, payload: Json): EventEnvelope => ({ eventId: newId(), type, version: 1, context: type.split('.')[0]!, tenantId: ids.tenantId, companyId: w.companyId, siteId: null, subject: newId(), correlationId: newId(), causationId: null, source: 'factory-api', occurredAt: new Date().toISOString(), payload }) as unknown as EventEnvelope

beforeAll(async () => {
  db = await migratedDatabase('pr2l_follows')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  await seedFiles({ db: database, namespace: ns })
  await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  w = await productionTwoBrands({ db, database, app, namespace: ns })
  expect(await supervisorPeople({ database, namespace: ns }, w)).toEqual(people)
  system = callerFor(database, systemContext(ids.tenantId, newId()))
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('B-PR-42b the handler', () => {
  it('handles exactly the change, a new order, a confirmed order and a new work order; open orders are the keeper’s; chunks of 200', () => {
    expect(supervisorFollowsHandler().name).toBe('production.supervisorFollows')
    expect([...supervisorFollowsHandler().events].sort()).toEqual([...SUPERVISOR_FOLLOW_EVENTS].sort())
    expect([...SUPERVISED_ORDER_STATES]).toEqual([...KEEPER_ORDER_STATES])
    expect(FOLLOW_CHUNK).toBe(200)
    expect(chunksOf(Array.from({ length: 401 }, (_, index) => index), FOLLOW_CHUNK).map((chunk) => chunk.length)).toEqual([200, 200, 1])
    expect(chunksOf([], FOLLOW_CHUNK)).toEqual([])
  })
})

describe('B-PR-42b the supervisor follows (through threads’ followInCommand / unfollowInCommand only)', { timeout: 120_000 }, () => {
  it('a customer’s default: its supervisor follows every open order’s thread and its work orders’ (ASSIGNEE); a work order of no customer gets none; a repeat changes nothing', async () => {
    const before = await events('brand_production.supervisor_changed')
    await ok('office.all', 'PUT', `/production/brands/${ids.a}/supervisor`, { supervisorId: people.supervisorA, backupId: people.backupA, version: await settingsVersion(ids.a) })
    const changed = await changedSince(before)
    expect(changed).toHaveLength(1)
    const orders = await openOrdersOf(ids.a)
    expect(orders).toContain(w.a.salesOrderId)
    const workOrders = await workOrdersOf(orders)
    expect(workOrders).toContain(w.a.workOrderId)
    const done = await work(changed)
    expect(done.unfollowed).toBe(0)
    for (const orderId of orders) expect(await followOf('SalesOrder', orderId, people.supervisorA), orderId).toEqual({ reason: 'ASSIGNEE', muted: false })
    for (const workOrderId of workOrders) expect(await followOf('WorkOrder', workOrderId, people.supervisorA), workOrderId).toEqual({ reason: 'ASSIGNEE', muted: false })
    expect(done.followed).toBe(orders.length + workOrders.length)
    // The backup follows nothing (he is told, not following); nothing of B, nothing on the mixed work order.
    expect(await followOf('SalesOrder', w.a.salesOrderId, people.backupA)).toBeUndefined()
    expect(await followOf('SalesOrder', w.b.salesOrderId, people.supervisorA)).toBeUndefined()
    expect(await followOf('WorkOrder', w.mixed.workOrderId, people.supervisorA)).toBeUndefined()
    // One summary audit row per command, of A only; each follow audited by threads (threads.follow).
    const rows = await admin(`SELECT "recordType", "recordId", after FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'production.supervisorFollows' ORDER BY at, id`, [ids.tenantId])
    expect(rows.map((row) => [row.recordType, row.recordId])).toEqual([['Party', ids.a]])
    expect(JSON.stringify(rows)).not.toContain(w.b.salesOrderId)
    const follows = await one<{ n: number }>(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'threads.follow' AND after->>'userId' = $2`, [ids.tenantId, people.supervisorA])
    expect(follows!.n).toBe(done.followed)
    // A repeated job (the same event again) changes nothing and writes nothing.
    expect(await work(changed)).toEqual({ followed: 0, unfollowed: 0 })
    expect(await admin(`SELECT 1 FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'production.supervisorFollows'`, [ids.tenantId])).toHaveLength(1)
  })

  it('an order’s own: he follows the order and its work order of that one order; the default he replaces stops there — and the other way round when the order goes back to the default', async () => {
    const before = await events('brand_production.supervisor_changed')
    await ok('office.all', 'POST', '/production/orders/supervisor', { orderIds: [w.a.salesOrderId], supervisorId: people.backupA })
    const changed = await changedSince(before)
    expect(changed.map((event) => (event.payload as Json).previousIds)).toEqual([[people.supervisorA]])
    expect(await work(changed)).toEqual({ followed: 2, unfollowed: 2 })
    expect(await followOf('SalesOrder', w.a.salesOrderId, people.backupA)).toEqual({ reason: 'ASSIGNEE', muted: false })
    expect(await followOf('WorkOrder', w.a.workOrderId, people.backupA)).toEqual({ reason: 'ASSIGNEE', muted: false })
    expect(await followOf('SalesOrder', w.a.salesOrderId, people.supervisorA)).toBeUndefined()
    expect(await followOf('WorkOrder', w.a.workOrderId, people.supervisorA)).toBeUndefined()
    // A's other orders keep the default's follow.
    const others = (await openOrdersOf(ids.a)).filter((orderId) => orderId !== w.a.salesOrderId)
    for (const orderId of others) expect(await followOf('SalesOrder', orderId, people.supervisorA)).toEqual({ reason: 'ASSIGNEE', muted: false })
    // Threads' own audit of the unfollow names whose follow went.
    const unfollows = await admin(`SELECT after FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'threads.unfollow' AND after->>'userId' = $2`, [ids.tenantId, people.supervisorA])
    expect(unfollows).toHaveLength(2)

    const back = await events('brand_production.supervisor_changed')
    await ok('office.all', 'POST', '/production/orders/supervisor', { orderIds: [w.a.salesOrderId], supervisorId: null })
    expect(await work(await changedSince(back))).toEqual({ followed: 2, unfollowed: 2 })
    expect(await followOf('SalesOrder', w.a.salesOrderId, people.supervisorA)).toEqual({ reason: 'ASSIGNEE', muted: false })
    expect(await followOf('SalesOrder', w.a.salesOrderId, people.backupA)).toBeUndefined()
  })

  it('R-60: a muted follow stays muted and stays; a follow while he holds an open task on the record stays; a follow he chose himself stays', async () => {
    // He mutes his follow of the work order (threads' own route): "You muted this order" on his band.
    await ok('supervisor.a', 'PUT', `/threads/WorkOrder/${w.a.workOrderId}/followers/me`, { following: true, muted: true })
    expect(await followOf('WorkOrder', w.a.workOrderId, people.supervisorA)).toEqual({ reason: 'ASSIGNEE', muted: true })
    // An open task of his on the order (made up, written as platform/tasks writes one).
    const number = (await one<{ number: string }>(`SELECT number FROM "SalesOrder" WHERE id = $1`, [w.a.salesOrderId]))!.number
    await admin(
      `INSERT INTO "Task" (id, "tenantId", "companyId", "partyId", title, "recordType", "recordId", "recordLabel", "assigneeId", "assignedById", "assignedAt", checklist, status, "createdAt", "updatedAt", "createdById")
       VALUES ($1, $2, $3, $4, 'Made-up: check the trims', 'SalesOrder', $5, $6, $7, $8, now(), '[]'::jsonb, 'OPEN', now(), now(), $8)`,
      [newId(), ids.tenantId, w.companyId, ids.a, w.a.salesOrderId, number, people.supervisorA, actorId],
    )
    const before = await events('brand_production.supervisor_changed')
    await ok('office.all', 'POST', '/production/orders/supervisor', { orderIds: [w.a.salesOrderId], supervisorId: people.backupA })
    expect(await work(await changedSince(before))).toEqual({ followed: 2, unfollowed: 0 })
    expect(await followOf('WorkOrder', w.a.workOrderId, people.supervisorA)).toEqual({ reason: 'ASSIGNEE', muted: true })
    expect(await followOf('SalesOrder', w.a.salesOrderId, people.supervisorA)).toEqual({ reason: 'ASSIGNEE', muted: false })
    // Back to the default: he follows already (muted stays muted); the backup's ASSIGNEE follows go.
    const back = await events('brand_production.supervisor_changed')
    await ok('office.all', 'POST', '/production/orders/supervisor', { orderIds: [w.a.salesOrderId], supervisorId: null })
    expect(await work(await changedSince(back))).toEqual({ followed: 0, unfollowed: 2 })
    expect(await followOf('WorkOrder', w.a.workOrderId, people.supervisorA)).toEqual({ reason: 'ASSIGNEE', muted: true })
  })

  it('a new open order and a new work order follow at once; a later status move never follows again (his own unfollow lasts); an order waiting for its approval takes none', async () => {
    const fresh = await salesOrder(ids.a, 'CONFIRMED')
    expect(await supervisorFollows(system, eventOf('sales_order.created', { orderId: fresh, number: 'X', quoteId: null, versionId: null, partyId: ids.a, depositRequestIds: [] }))).toEqual({ followed: 1, unfollowed: 0 })
    expect(await followOf('SalesOrder', fresh, people.supervisorA)).toEqual({ reason: 'ASSIGNEE', muted: false })
    // He drops it himself (threads' own route): a later move of the order does not follow him again.
    await ok('supervisor.a', 'PUT', `/threads/SalesOrder/${fresh}/followers/me`, { following: false, muted: false })
    expect(await followOf('SalesOrder', fresh, people.supervisorA)).toBeUndefined()
    expect(await supervisorFollows(system, eventOf('sales_order.status_changed', { orderId: fresh, number: 'X', from: 'CONFIRMED', to: 'IN_PRODUCTION', by: 'person' }))).toEqual({ followed: 0, unfollowed: 0 })
    expect(await followOf('SalesOrder', fresh, people.supervisorA)).toBeUndefined()
    // An order waiting for its approval takes none; once confirmed (its status_changed → CONFIRMED) it follows.
    const waiting = await salesOrder(ids.a, 'PENDING_APPROVAL')
    expect(await supervisorFollows(system, eventOf('sales_order.created', { orderId: waiting, number: 'Y', quoteId: null, versionId: null, partyId: ids.a, depositRequestIds: [] }))).toEqual({ followed: 0, unfollowed: 0 })
    const approved = await salesOrder(ids.a, 'CONFIRMED')
    expect(await supervisorFollows(system, eventOf('sales_order.status_changed', { orderId: approved, number: 'Y', from: 'PENDING_APPROVAL', to: 'CONFIRMED', by: 'person' }))).toEqual({ followed: 1, unfollowed: 0 })
    expect(await followOf('SalesOrder', approved, people.supervisorA)).toEqual({ reason: 'ASSIGNEE', muted: false })
    // A work order of no customer takes none.
    expect(await supervisorFollows(system, eventOf('workorder.created', { workOrderId: w.mixed.workOrderId, number: w.mixed.number, partyId: null, siteId: w.siteId, styleId: w.styleId, salesOrderIds: [], cells: 1, pieces: 1 }))).toEqual({ followed: 0, unfollowed: 0 })
    // A new work order of B: B's supervisor (none yet) — nobody; with one, he follows at once.
    expect(await supervisorFollows(system, eventOf('workorder.created', { workOrderId: w.b.workOrderId, number: w.b.workOrderNumber, partyId: ids.b, siteId: w.siteId, styleId: w.styleId, salesOrderIds: [w.b.salesOrderId], cells: 1, pieces: 1 }))).toEqual({ followed: 0, unfollowed: 0 })
  })

  it('PW-14: B’s supervisor follows B’s records only, never A’s; a person whose read of the customer was taken away gets no follow', async () => {
    const before = await events('brand_production.supervisor_changed')
    await ok('office.all', 'PUT', `/production/brands/${ids.b}/supervisor`, { supervisorId: people.officeB, backupId: null, version: await settingsVersion(ids.b) })
    await work(await changedSince(before))
    expect(await followOf('SalesOrder', w.b.salesOrderId, people.officeB)).toEqual({ reason: 'ASSIGNEE', muted: false })
    expect(await followOf('WorkOrder', w.b.workOrderId, people.officeB)).toEqual({ reason: 'ASSIGNEE', muted: false })
    const ofB = await admin(`SELECT "recordType", "recordId" FROM "RecordFollower" WHERE "tenantId" = $1 AND "userId" = $2`, [ids.tenantId, people.officeB])
    const recordsOfA = new Set([...(await openOrdersOf(ids.a)), ...(await workOrdersOf(await openOrdersOf(ids.a))), w.mixed.workOrderId])
    for (const row of ofB) expect(recordsOfA.has(row.recordId), `${row.recordType} ${row.recordId}`).toBe(false)

    // The backup (every customer) is made A's order's own — but his read of A is taken away before the worker runs: no follow;
    // with his read back, the same event follows him (the worker re-checks per record when it runs).
    const assignment = `ffffffff${seedUuid(ns, 'two-brands:supervisor-people:assignment:backupA').slice(8)}`
    const mark = await events('brand_production.supervisor_changed')
    await ok('office.all', 'POST', '/production/orders/supervisor', { orderIds: [w.a.salesOrderId], supervisorId: people.backupA })
    const changed = await changedSince(mark)
    await admin(`UPDATE "RoleAssignment" SET "partyIds" = $2::uuid[] WHERE id = $1`, [assignment, [ids.b]])
    try {
      // supervisorA keeps his rows (an open task on the order, a muted follow on the work order): nothing at all moves.
      expect(await work(changed)).toEqual({ followed: 0, unfollowed: 0 })
      expect(await followOf('SalesOrder', w.a.salesOrderId, people.backupA)).toBeUndefined()
      expect(await followOf('WorkOrder', w.a.workOrderId, people.backupA)).toBeUndefined()
    } finally {
      await admin(`UPDATE "RoleAssignment" SET "partyIds" = '{}'::uuid[] WHERE id = $1`, [assignment])
    }
    expect(await work(changed)).toEqual({ followed: 2, unfollowed: 0 })
    // An event that names an order of another customer than its own moves nothing there.
    expect(await supervisorFollows(system, eventOf('brand_production.supervisor_changed', { partyId: ids.b, orderIds: [w.a.salesOrderId], supervisorId: people.officeB, previousIds: [], backupId: null, scope: 'ORDER', batchId: newId() }))).toEqual({ followed: 0, unfollowed: 0 })
    expect(await followOf('SalesOrder', w.a.salesOrderId, people.officeB)).toBeUndefined()
    // Back to the default for the tests after this one.
    const back = await events('brand_production.supervisor_changed')
    await ok('office.all', 'POST', '/production/orders/supervisor', { orderIds: [w.a.salesOrderId], supervisorId: null })
    expect(await work(await changedSince(back))).toEqual({ followed: 0, unfollowed: 2 })
  })
})

describe('B-PR-42b the bell: one ASSIGNMENT per change and person, never per order (PW-14: only over what he reads)', { timeout: 120_000 }, () => {
  /** The notifications one event made. */
  const told = (eventId: string) => admin<{ userId: string; category: string; messageKey: string; params: Json; recordType: string; recordId: string; recordLabel: string }>(
    `SELECT "userId", category::text AS category, "messageKey", params, "recordType", "recordId", "recordLabel" FROM "Notification" WHERE "tenantId" = $1 AND "eventId" = $2 ORDER BY "userId"`,
    [ids.tenantId, eventId],
  )

  it('a customer’s new default: ONE item for him over the open orders on the default he reads, and one for the newly named backup — never one per order', async () => {
    // A's default from nobody: cleared first (the backup goes with it), then set again.
    await ok('office.all', 'PUT', `/production/brands/${ids.a}/supervisor`, { supervisorId: null, backupId: null, version: await settingsVersion(ids.a) })
    const before = await events('brand_production.supervisor_changed')
    await ok('office.all', 'PUT', `/production/brands/${ids.a}/supervisor`, { supervisorId: people.supervisorA, backupId: people.backupA, version: await settingsVersion(ids.a) })
    const [event] = await changedSince(before)
    expect(await fanOut(system, event!)).toBe(2)
    const rows = await told(event!.eventId)
    const onDefault = (await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM "SalesOrder" so LEFT JOIN "BrandOrderProduction" bop ON bop."salesOrderId" = so.id WHERE so."partyId" = $1 AND so.status::text = ANY($2::text[]) AND bop."supervisorId" IS NULL`,
      [ids.a, [...SUPERVISED_ORDER_STATES]],
    ))!.n
    expect(onDefault).toBeGreaterThan(1)
    const party = (await one<{ name: string }>(`SELECT coalesce("tradeName", "legalName") AS name FROM "Party" WHERE id = $1`, [ids.a]))!.name
    expect(rows.find((row) => row.userId === people.supervisorA)).toMatchObject({ category: 'ASSIGNMENT', messageKey: 'notifications.production.supervisorOfOrders', recordType: 'Party', recordId: ids.a, recordLabel: party, params: { count: onDefault } })
    expect(rows.find((row) => row.userId === people.backupA)).toMatchObject({ category: 'ASSIGNMENT', messageKey: 'notifications.production.backupOfCustomer', recordType: 'Party', recordId: ids.a })
    expect(rows).toHaveLength(2)
    // Only the backup changes: the supervisor is not told again.
    const swap = await events('brand_production.supervisor_changed')
    await ok('office.all', 'PUT', `/production/brands/${ids.a}/supervisor`, { supervisorId: people.supervisorA, backupId: null, version: await settingsVersion(ids.a) })
    const [quiet] = await changedSince(swap)
    expect(await fanOut(system, quiet!)).toBe(0)
  })

  it('an order’s own, one order: "You are the production supervisor of order …"; two orders: one item "… of 2 orders of <customer>"; a person who does not read them is not told', async () => {
    // Two orders with a production state of their own (A's new order and SEED-SO-0002: B-PR-15's rows).
    const so2 = (await one<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "partyId" = $1 AND number = 'SEED-SO-0002'`, [ids.a]))!.id
    const before = await events('brand_production.supervisor_changed')
    await ok('office.all', 'POST', '/production/orders/supervisor', { orderIds: [w.a.salesOrderId], supervisorId: people.backupA })
    const [oneOrder] = await changedSince(before)
    expect(await fanOut(system, oneOrder!)).toBe(1)
    const number = (await one<{ number: string }>(`SELECT number FROM "SalesOrder" WHERE id = $1`, [w.a.salesOrderId]))!.number
    expect(await told(oneOrder!.eventId)).toEqual([{ userId: people.backupA, category: 'ASSIGNMENT', messageKey: 'notifications.production.supervisorOfOrder', params: expect.any(Object), recordType: 'SalesOrder', recordId: w.a.salesOrderId, recordLabel: number }])
    await ok('office.all', 'POST', '/production/orders/supervisor', { orderIds: [so2], supervisorId: people.backupA })

    // Both back to the default in one command: ONE item for the default (supervisorA) naming the count 2 — never two items.
    const both = await events('brand_production.supervisor_changed')
    await ok('office.all', 'POST', '/production/orders/supervisor', { orderIds: [w.a.salesOrderId, so2], supervisorId: null })
    const [twoOrders] = await changedSince(both)
    expect((twoOrders!.payload as Json).orderIds).toHaveLength(2)
    expect(await fanOut(system, twoOrders!)).toBe(1)
    const rows = await told(twoOrders!.eventId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ userId: people.supervisorA, messageKey: 'notifications.production.supervisorOfOrders', recordType: 'Party', recordId: ids.a, params: { count: 2 } })

    // PW-14: the person his read of A was taken from is not told (re-checked at the fan-out).
    const assignment = `ffffffff${seedUuid(ns, 'two-brands:supervisor-people:assignment:backupA').slice(8)}`
    const later = await events('brand_production.supervisor_changed')
    await ok('office.all', 'POST', '/production/orders/supervisor', { orderIds: [w.a.salesOrderId], supervisorId: people.backupA })
    const [walled] = await changedSince(later)
    await admin(`UPDATE "RoleAssignment" SET "partyIds" = $2::uuid[] WHERE id = $1`, [assignment, [ids.b]])
    try {
      expect(await fanOut(system, walled!)).toBe(0)
    } finally {
      await admin(`UPDATE "RoleAssignment" SET "partyIds" = '{}'::uuid[] WHERE id = $1`, [assignment])
    }
  })

  it('a command over two customers: one item per customer’s event, each naming only its own customer; B’s people are never told of A', async () => {
    const before = await events('brand_production.supervisor_changed')
    await ok('office.all', 'POST', '/production/orders/supervisor', { orderIds: [w.a.salesOrderId, w.b.salesOrderId], supervisorId: people.supervisorA })
    // supervisorA is limited to A: B's order is skipped by the route; only A's event is written.
    const changed = await changedSince(before)
    expect(changed.map((event) => (event.payload as Json).partyId)).toEqual([ids.a])
    await fanOut(system, changed[0]!)
    const rows = await told(changed[0]!.eventId)
    expect(rows.map((row) => row.userId)).toEqual([people.supervisorA])
    expect(JSON.stringify(rows)).not.toContain(w.b.salesOrderId)
    for (const event of await events('brand_production.supervisor_changed')) {
      for (const row of await told(event.eventId)) {
        if (row.userId === people.officeB) expect(row.recordId === ids.b || row.recordId === w.b.salesOrderId, JSON.stringify(row)).toBe(true)
      }
    }
  })

  it('every sentence it may send has its words in English and Italian, with the same placeholders', () => {
    for (const key of ['notifications.production.supervisorOfOrder', 'notifications.production.supervisorOfOrders', 'notifications.production.supervisorOfCustomer', 'notifications.production.backupOfCustomer'] as const) {
      expect(MESSAGE_TEMPLATES[key].en).toBeTruthy()
      expect(MESSAGE_TEMPLATES[key].it).not.toMatch(/Responsabile di produzione/)
      expect(MESSAGE_TEMPLATES[key].en.match(/\{\w+\}/g)?.sort()).toEqual(MESSAGE_TEMPLATES[key].it.match(/\{\w+\}/g)?.sort())
    }
  })
})
