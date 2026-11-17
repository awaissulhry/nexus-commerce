import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { portalAccessProblem } from '@nexus/factory-domain/auth/portal/access'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Actor, Permission } from '@nexus/factory-domain/core/permissions'
import { EVENT_CATALOGUE } from '@nexus/factory-domain/events/catalogue'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { liveMessageFor } from '@nexus/factory-domain/events/live'
import { partnerLiveViewFor } from '@nexus/factory-domain/portal/notifications/live'
import { SUPERVISOR_REFUSAL_WORDS } from '@nexus/factory-domain/production-brand/words'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { portalOn } from '../../../platform/auth/portal/store'
import { markersOf, findMarkers, productionTwoBrands, supervisorPeople, supervisorPeopleIds, twoBrandIds, twoBrandSessions, type ProductionTwoBrands } from '../testing/two-brands'
import { ELIGIBILITY_WORDS } from './eligible'
import { supervisorOf } from './resolver'

/**
 * B-PR-42a — the production supervisor, set and read (production plan §3 "Supervisor"; lead picks L21, L22; review fixes R-41,
 * R-48, R-53, R-57, R-58; the Owner's point N3: "assign a certain person, a supervisor who's in charge of production for a suit
 * for a specific brand"), and its wall test PW-14 (+ office.p2 asking GET /production/supervisors?partyId=<A> → 404) and the R-53
 * upsert test. The Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the
 * production unit, should be able to see it all. And manage it all as well."
 *
 * On a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the PortalSettings /
 * BrandOrderProduction guards are real), the core, files, production and numbering seeds, the production two-brand harness (brand
 * A = the seeds' P1 with its new order and SEED-SO-0002; brand B = the threads' second brand with SEED-SO-B001; B-PR-15's
 * production states of those orders; neither brand has a PortalSettings row) and its supervisor people (`supervisorPeople`: REAL
 * users with live role assignments — supervisorA limited to A, backupA over every customer, officeB limited to B with the
 * measurements right, plannerB limited to B without it, noThread without threads.read, inactive SUSPENDED).
 *
 *   - the pick list: eligible ACTIVE office people by name; PW-14: a person limited to B is absent from A's list, and office.p2
 *     asking for A's list gets 404 in the words of an unknown customer;
 *   - the customer's default and backup (PUT): the row made with the portal OFF (R-53: no sign-in, no portal page answers for
 *     that customer, no portal person or code made); one audit row and one office-only supervisor_changed (scope BRAND);
 *     refusals in words (400 person, 409 nothing to change / stale / not a customer, 404 / 403); a changed default moves the
 *     orders without their own supervisor;
 *   - an order's own (POST, 1 to 100 orders of several customers): one event and one audit row per customer, each its own
 *     batch, naming only its own orders; a refused row named only to who sees it, the others counted; null = back to the default;
 *   - the work order list (Me / Someone else / Not set, never a name; `?supervisor=me`; the Mine count) and the record (the name,
 *     ORDER or BRAND, `youMuted` for the supervisor himself only);
 *   - the resolver `supervisorOf` (B-PR-32, B-PR-42b, B-PR-43a/b, B-PR-45).
 *
 * The tests run in order on one database (each builds on the state the one before left). Every name is made up. Run with
 * `env -u FACTORY_REDIS_URL node scripts/factory/run-pg-tests.mjs modules/production/supervisor/supervisor`.
 */

const ns = 'pr2j-supervisor'
const ids = twoBrandIds(ns)
const people = supervisorPeopleIds(ns)
const actorId = seedUuid(ns, 'actor')
const PERMISSIONS: Permission[] = ['workorders.view', 'workorders.manage', 'production.brand.manage', 'threads.read']
const grant = (permissions: Permission[], parties: 'all' | string[]) => ({ permissions, companies: 'all' as const, sites: 'all' as const, parties })
const SESSIONS: Record<string, SessionContext> = {
  ...twoBrandSessions(ids.tenantId, ids.a, ids.b, PERMISSIONS),
  // Sees every customer's production, manages none of it.
  'office.viewer': { audience: 'office', tenantId: ids.tenantId, actorId: newId(), grants: [grant(['workorders.view'], 'all')] },
  // The supervisor of A himself at his screen (his session's id is his user's).
  'supervisor.a': { audience: 'office', tenantId: ids.tenantId, actorId: people.supervisorA, grants: [grant(['workorders.view', 'threads.read'], [ids.a])] },
}

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let w: ProductionTwoBrands
let orderA = ''
let orderB = ''

type Json = Record<string, any>
type Method = 'GET' | 'PUT' | 'POST'
async function call(session: string, method: Method, url: string, payload?: unknown): Promise<{ status: number; body: Json; raw: string }> {
  const headers: Record<string, string> = method === 'GET' ? { 'x-test-session': session } : { 'x-test-session': session, 'idempotency-key': newId() }
  const response = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) })
  const body = response.headers['content-type']?.toString().startsWith('application/json') ? (response.json() as Json) : {}
  return { status: response.statusCode, body, raw: response.body }
}
async function ok(session: string, method: Method, url: string, payload?: unknown): Promise<Json> {
  const answer = await call(session, method, url, payload)
  expect(answer.status, `${method} ${url}: ${answer.raw.slice(0, 600)}`).toBe(200)
  return answer.body
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const answer = await call(session, method, url, payload)
  expect(answer.status, `${method} ${url}: ${answer.raw.slice(0, 600)}`).toBe(status)
  return answer.body
}
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T | undefined> => (await admin<T>(sql, values))[0]

const pickUrl = (partyId: string, companyId?: string) => `/production/supervisors?partyId=${partyId}${companyId ? `&companyId=${companyId}` : ''}`
const customerUrl = (partyId: string) => `/production/brands/${partyId}/supervisor`
const ORDERS_URL = '/production/orders/supervisor'
const settingsOf = (partyId: string) =>
  one<Json>(`SELECT "portalOn", "productionSupervisorId" AS supervisor, "productionSupervisorSetAt" AS "setAt", "productionBackupId" AS backup, version FROM "PortalSettings" WHERE "partyId" = $1`, [partyId])
const ownOf = async (orderId: string) => (await one<Json>(`SELECT "supervisorId" AS supervisor, "supervisorAssignedAt" AS "assignedAt", version FROM "BrandOrderProduction" WHERE key = $1`, [`brand-production:${orderId}`]))!
const audits = (action: string) => admin<Json>(`SELECT "recordType", "recordId", "companyId", before, after FROM "AuditLog" WHERE "tenantId" = $1 AND action = $2 ORDER BY at, id`, [ids.tenantId, action])

interface Told {
  readonly id: string
  readonly companyId: string | null
  readonly payload: Json
  readonly envelope: EventEnvelope
}
async function told(): Promise<Told[]> {
  const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'brand_production.supervisor_changed' ORDER BY "occurredAt", id`, [ids.tenantId])
  return rows.map((row) => ({
    id: row.id,
    companyId: row.companyId,
    payload: row.payload as Json,
    envelope: { eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload },
  }))
}
const toldSince = async (before: readonly Told[]): Promise<Told[]> => {
  const seen = new Set(before.map((event) => event.id))
  return (await told()).filter((event) => !seen.has(event.id))
}
/** A partner viewer of a customer with the production read (as the portal's live channel checks it). */
const partnerOf = (partyId: string): Actor => ({ audience: 'partner', tenantId: ids.tenantId, partyId, grants: [{ permissions: ['portal.production.view'], companies: 'all', sites: 'all', parties: [partyId] }] })

/** A made-up sales order of a customer, written in the office scope (no production state unless the keeper keeps it). */
async function salesOrder(partyId: string, status: 'PENDING_APPROVAL' | 'CONFIRMED'): Promise<string> {
  const id = newId()
  await database.withScope({ audience: 'office', tenantId: ids.tenantId, actorId }, (client) =>
    client.salesOrder.create({
      data: { id, companyId: w.companyId, partyId, number: `T-PR42-SO-${id.slice(-6)}`, customerRef: `T-PR42-PO-${id.slice(-6)}`, status, orderDate: new Date('2026-11-06T00:00:00.000Z'), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer' }, shipTo: { name: 'Made-up workshop' }, promiseDate: new Date('2026-12-18T00:00:00.000Z') },
      select: { id: true },
    }),
  )
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('pr2j_supervisor')
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
  expect(w.a.partyId).toBe(ids.a)
  expect(w.b.partyId).toBe(ids.b)
  expect(await supervisorPeople({ database, namespace: ns }, w)).toEqual(people)
  orderA = w.a.salesOrderId
  orderB = w.b.salesOrderId
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('B-PR-42a the pick list: who may supervise a customer’s production, by name only', { timeout: 60_000 }, () => {
  it('A’s list: the active office people allowed on A with the measurements right who read its order threads — never one limited to B, without the right, without the threads or inactive', async () => {
    const list = await ok('office.all', 'GET', pickUrl(ids.a))
    const named = list.people.map((person: Json) => person.id)
    expect(named).toEqual(expect.arrayContaining([people.supervisorA, people.backupA]))
    for (const outside of [people.officeB, people.plannerB, people.noThread, people.inactive]) expect(named).not.toContain(outside)
    expect(list.people.find((person: Json) => person.id === people.supervisorA)).toEqual({ id: people.supervisorA, name: 'T Supervisor Alpha', me: false })
    // Names only: nobody is counted, no role, no other customer.
    for (const person of list.people) expect(Object.keys(person).sort()).toEqual(['id', 'me', 'name'])
    expect(list.complete).toBe(true)
    const onDefault = await one<{ n: number }>(`SELECT count(*)::int AS n FROM "BrandOrderProduction" bop JOIN "SalesOrder" so ON so.id = bop."salesOrderId" WHERE bop."partyId" = $1 AND bop."supervisorId" IS NULL AND so.status IN ('CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED')`, [ids.a])
    expect(list.ordersOnDefault).toBe(onDefault!.n)
    // One company of the customer: the same people there.
    expect((await ok('office.all', 'GET', pickUrl(ids.a, w.companyId))).people.map((person: Json) => person.id)).toEqual(named)
  })

  it('B’s list: its own office person and the backup over every customer — never A’s supervisor (limited to A), never the planner without the measurements right', async () => {
    const named = (await ok('office.all', 'GET', pickUrl(ids.b))).people.map((person: Json) => person.id)
    expect(named).toEqual(expect.arrayContaining([people.officeB, people.backupA]))
    for (const outside of [people.supervisorA, people.plannerB, people.noThread, people.inactive]) expect(named).not.toContain(outside)
  })

  it('PW-14: office.p2 asking for A’s list gets 404 in the words of an unknown customer, and office.p1 for B’s; a viewer who manages nothing is forbidden', async () => {
    for (const url of [pickUrl(ids.a), pickUrl(ids.a, w.companyId), pickUrl(newId())]) {
      const body = await refused('office.p2', 'GET', url, undefined, 404)
      expect(body.error.message).toBe('Customer not found.')
      expect(JSON.stringify(body)).not.toContain(ids.a)
      expect(JSON.stringify(body)).not.toContain('T Supervisor Alpha')
    }
    expect((await refused('office.p1', 'GET', pickUrl(ids.b), undefined, 404)).error.message).toBe('Customer not found.')
    await refused('office.viewer', 'GET', pickUrl(ids.a), undefined, 403)
    // An unknown company reads as an unknown customer.
    expect((await refused('office.all', 'GET', pickUrl(ids.a, newId()), undefined, 404)).error.message).toBe('Customer not found.')
    // office.p2 reads B's own list.
    expect((await ok('office.p2', 'GET', pickUrl(ids.b))).people.map((person: Json) => person.id)).toContain(people.officeB)
  })
})

describe('B-PR-42a the customer’s default supervisor and backup (PUT /production/brands/:partyId/supervisor)', { timeout: 60_000 }, () => {
  it('R-53: B has no portal row — setting its supervisor makes one with the portal OFF; no portal person or code is made; the sign-in and every portal page stay closed to B', async () => {
    expect(await settingsOf(ids.b)).toBeUndefined()
    const partnerUsers = async () => (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "User" WHERE "partyId" = $1 AND audience = 'PARTNER'`, [ids.b]))!.n
    const codes = async () => (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "PortalSignInCode" c JOIN "User" u ON u.id = c."userId" WHERE u."partyId" = $1`, [ids.b]))!.n
    const [usersBefore, codesBefore] = [await partnerUsers(), await codes()]
    const before = await told()
    const { customer } = await ok('office.all', 'PUT', customerUrl(ids.b), { supervisorId: people.officeB, backupId: null, version: 0 })
    expect(customer).toEqual({ partyId: ids.b, supervisor: { id: people.officeB, name: 'T Office Beta', active: true }, backup: null, version: 1, ordersOnDefault: expect.any(Number) })
    expect(await settingsOf(ids.b)).toMatchObject({ portalOn: false, supervisor: people.officeB, backup: null, version: 1 })
    expect((await settingsOf(ids.b))!.setAt).not.toBeNull()
    expect(await partnerUsers()).toBe(usersBefore)
    expect(await codes()).toBe(codesBefore)
    // The portal's own two reads (sign-in.ts and authenticator.ts ask exactly these): B's portal is off, so its buyer can neither
    // sign in nor open any portal page — even with the portal terms in force.
    const buyer = (await one<{ status: string; accessUntil: Date | null }>(`SELECT status::text AS status, "accessUntil" FROM "User" WHERE id = $1`, [w.second.userId]))!
    const on = await database.withScope({ audience: 'office', tenantId: ids.tenantId, actorId }, (client) => portalOn(client, ids.b))
    expect(on).toBe(false)
    expect(portalAccessProblem({ user: buyer, party: { status: 'ACTIVE' }, portalOn: on, termsInForce: true }, new Date())).toBe('PORTAL_OFF')
    // One audit row on the row it made, one office-only event of B (scope BRAND, no order named).
    expect((await audits('production.setCustomerSupervisor')).filter((row) => row.recordId === ids.b)).toEqual([
      { recordType: 'PortalSettings', recordId: ids.b, companyId: null, before: null, after: expect.objectContaining({ productionSupervisorId: people.officeB, productionBackupId: null, portalOn: false }) },
    ])
    const events = await toldSince(before)
    expect(events.map((event) => event.payload)).toEqual([{ partyId: ids.b, orderIds: [], supervisorId: people.officeB, previousIds: [], backupId: null, scope: 'BRAND', batchId: expect.any(String) }])
    expect(events[0]!.companyId).toBeNull()
  })

  it('A’s supervisor and backup: set together; the event names the backup, never reaches a portal (R-41); the customer never reads the columns', async () => {
    const before = await told()
    const { customer } = await ok('office.all', 'PUT', customerUrl(ids.a), { supervisorId: people.supervisorA, backupId: people.backupA, version: 0 })
    expect(customer).toMatchObject({ partyId: ids.a, supervisor: { id: people.supervisorA, name: 'T Supervisor Alpha', active: true }, backup: { id: people.backupA, name: 'T Backup Alpha', active: true }, version: 1 })
    const events = await toldSince(before)
    expect(events).toHaveLength(1)
    expect(events[0]!.payload).toEqual({ partyId: ids.a, orderIds: [], supervisorId: people.supervisorA, previousIds: [], backupId: people.backupA, scope: 'BRAND', batchId: expect.any(String) })
    const message = liveMessageFor(events[0]!.envelope, EVENT_CATALOGUE.get(events[0]!.envelope.type, events[0]!.envelope.version))!
    for (const partyId of [ids.a, ids.b]) expect(partnerLiveViewFor(message, partnerOf(partyId), EVENT_CATALOGUE)).toBeNull()
    // The partner role has no grant on PortalSettings, and BrandOrderProduction.supervisorId is hidden from it.
    const portalA = { audience: 'partner' as const, tenantId: ids.tenantId, actorId: newId(), partyId: ids.a }
    await expect(database.withScope(portalA, (client) => client.$queryRawUnsafe('SELECT "productionSupervisorId" FROM "PortalSettings" LIMIT 1'))).rejects.toThrow(/permission denied/)
    await expect(database.withScope(portalA, (client) => client.$queryRawUnsafe('SELECT "supervisorId" FROM "BrandOrderProduction" LIMIT 1'))).rejects.toThrow(/permission denied/)
  })

  it('refused in words, nothing written or told: a person limited to B (PW-14), without the measurements right, without the order threads, inactive, a portal person; a backup alone or the same person; a stale version; nothing to change; not a customer', async () => {
    const before = await told()
    const settingsA = await settingsOf(ids.a)
    const settingsB = await settingsOf(ids.b)
    const issues = async (partyId: string, body: Json) => (await refused('office.all', 'PUT', customerUrl(partyId), body, 400)).error.issues as Json[]
    const version = settingsA!.version as number
    // A person limited to B reaches none of A: not its production, not its measurement sheets, not its order threads.
    const outside = (path: string) => [
      { path, message: SUPERVISOR_REFUSAL_WORDS.NO_REACH.en },
      { path, message: SUPERVISOR_REFUSAL_WORDS.NO_MEASUREMENTS.en },
      { path, message: ELIGIBILITY_WORDS.NO_THREAD.en },
    ]
    expect(await issues(ids.a, { supervisorId: people.officeB, backupId: null, version })).toEqual(outside('body/supervisorId'))
    expect(await issues(ids.a, { supervisorId: people.supervisorA, backupId: people.officeB, version })).toEqual(outside('body/backupId'))
    expect(await issues(ids.b, { supervisorId: people.plannerB, backupId: null, version: settingsB!.version })).toEqual([{ path: 'body/supervisorId', message: SUPERVISOR_REFUSAL_WORDS.NO_MEASUREMENTS.en }])
    expect(await issues(ids.a, { supervisorId: people.noThread, backupId: null, version })).toEqual([{ path: 'body/supervisorId', message: ELIGIBILITY_WORDS.NO_THREAD.en }])
    expect(await issues(ids.a, { supervisorId: people.inactive, backupId: null, version })).toEqual([{ path: 'body/supervisorId', message: SUPERVISOR_REFUSAL_WORDS.NOT_ACTIVE.en }])
    expect(await issues(ids.b, { supervisorId: w.second.userId, backupId: null, version: settingsB!.version })).toEqual([{ path: 'body/supervisorId', message: SUPERVISOR_REFUSAL_WORDS.NOT_OFFICE.en }])
    expect(await issues(ids.a, { supervisorId: newId(), backupId: null, version })).toEqual([{ path: 'body/supervisorId', message: SUPERVISOR_REFUSAL_WORDS.NOT_OFFICE.en }])
    expect((await issues(ids.a, { supervisorId: null, backupId: people.backupA, version }))[0]!.message).toBe('A backup is named only beside a supervisor.')
    expect((await issues(ids.a, { supervisorId: people.supervisorA, backupId: people.supervisorA, version }))[0]!.message).toBe('The backup is another person than the supervisor.')
    expect((await refused('office.all', 'PUT', customerUrl(ids.a), { supervisorId: people.backupA, backupId: null, version: version - 1 }, 409)).error.message).toMatch(/changed since it was read/)
    expect((await refused('office.all', 'PUT', customerUrl(ids.a), { supervisorId: people.supervisorA, backupId: people.backupA, version }, 409)).error.message).toMatch(/Nothing changes/)
    // A supplier has no production supervisor.
    const supplier = newId()
    await database.withScope({ audience: 'office', tenantId: ids.tenantId, actorId }, (client) =>
      client.party.create({ data: { id: supplier, code: `T42S${supplier.slice(-6)}`, kind: 'ORGANISATION', legalName: 'Made-up Supplier S.r.l.', roles: ['SUPPLIER'] }, select: { id: true } }),
    )
    expect((await refused('office.all', 'PUT', customerUrl(supplier), { supervisorId: people.backupA, backupId: null, version: 0 }, 409)).error.message).toBe('A production supervisor is set only for a customer or a brand.')
    expect(await settingsOf(supplier)).toBeUndefined()
    expect(await settingsOf(ids.a)).toEqual(settingsA)
    expect(await settingsOf(ids.b)).toEqual(settingsB)
    expect(await toldSince(before)).toEqual([])
  })

  it('PW-14: office.p2 cannot set A’s supervisor (404, the words of an unknown customer), nor office.p1 B’s; a viewer is forbidden; nothing written or told', async () => {
    const before = await told()
    const settingsA = await settingsOf(ids.a)
    for (const partyId of [ids.a, newId()]) {
      const body = await refused('office.p2', 'PUT', customerUrl(partyId), { supervisorId: people.officeB, backupId: null, version: settingsA!.version }, 404)
      expect(body.error.message).toBe('Customer not found.')
      expect(JSON.stringify(body)).not.toContain('T Supervisor Alpha')
    }
    expect((await refused('office.p1', 'PUT', customerUrl(ids.b), { supervisorId: people.backupA, backupId: null, version: 1 }, 404)).error.message).toBe('Customer not found.')
    await refused('office.viewer', 'PUT', customerUrl(ids.a), { supervisorId: people.backupA, backupId: null, version: settingsA!.version }, 403)
    expect(await settingsOf(ids.a)).toEqual(settingsA)
    expect(await toldSince(before)).toEqual([])
  })

  it('a changed default moves the orders without their own supervisor: A’s work order reads the new default (BRAND); the event names who it replaces', async () => {
    expect((await ok('office.all', 'GET', `/production/work-orders/${w.a.workOrderId}`)).workOrder.supervisor).toEqual({ id: people.supervisorA, name: 'T Supervisor Alpha', active: true, from: 'BRAND', me: false })
    const before = await told()
    const version = (await settingsOf(ids.a))!.version as number
    await ok('office.all', 'PUT', customerUrl(ids.a), { supervisorId: people.backupA, backupId: null, version })
    expect((await ok('office.all', 'GET', `/production/work-orders/${w.a.workOrderId}`)).workOrder.supervisor).toMatchObject({ id: people.backupA, from: 'BRAND' })
    expect((await toldSince(before)).map((event) => event.payload)).toEqual([{ partyId: ids.a, orderIds: [], supervisorId: people.backupA, previousIds: [people.supervisorA, people.backupA], backupId: null, scope: 'BRAND', batchId: expect.any(String) }])
    // Back as it was, for the tests after this one.
    await ok('office.all', 'PUT', customerUrl(ids.a), { supervisorId: people.supervisorA, backupId: people.backupA, version: version + 1 })
  })
})

describe('B-PR-42a an order’s own supervisor, one or many (POST /production/orders/supervisor)', { timeout: 60_000 }, () => {
  it('two customers in one command: one event and one audit row per customer, each its own batch and only its own orders; the work order reads its order’s own (ORDER)', async () => {
    const before = await told()
    const result = await ok('office.all', 'POST', ORDERS_URL, { orderIds: [orderA, orderB], supervisorId: people.backupA })
    expect(result).toMatchObject({ supervisor: { id: people.backupA, name: 'T Backup Alpha', active: true }, unchanged: [], skipped: [], unknown: 0 })
    expect(result.changed.map((row: Json) => row.orderId).sort()).toEqual([orderA, orderB].sort())
    expect(await ownOf(orderA)).toMatchObject({ supervisor: people.backupA })
    expect((await ownOf(orderA)).assignedAt).not.toBeNull()
    expect(await ownOf(orderB)).toMatchObject({ supervisor: people.backupA })
    const events = await toldSince(before)
    expect(events).toHaveLength(2)
    const ofA = events.find((event) => event.payload.partyId === ids.a)!
    const ofB = events.find((event) => event.payload.partyId === ids.b)!
    // Each names only its own customer's order; the previous person is the order's supervisor before (the customer's default).
    expect(ofA.payload).toEqual({ partyId: ids.a, orderIds: [orderA], supervisorId: people.backupA, previousIds: [people.supervisorA], backupId: null, scope: 'ORDER', batchId: expect.any(String) })
    expect(ofB.payload).toEqual({ partyId: ids.b, orderIds: [orderB], supervisorId: people.backupA, previousIds: [people.officeB], backupId: null, scope: 'ORDER', batchId: expect.any(String) })
    expect(ofA.payload.batchId).not.toBe(ofB.payload.batchId)
    expect(ofA.companyId).toBe(w.companyId)
    expect(JSON.stringify(ofA.envelope)).not.toContain(orderB)
    expect(JSON.stringify(ofB.envelope)).not.toContain(orderA)
    const rows = (await audits('production.setOrderSupervisors')).filter((row) => row.after?.batchId === ofA.payload.batchId || row.after?.batchId === ofB.payload.batchId)
    expect(rows.map((row) => [row.recordType, row.recordId]).sort()).toEqual([['Party', ids.a], ['Party', ids.b]].sort())
    expect(JSON.stringify(rows.find((row) => row.recordId === ids.a))).not.toContain(orderB)
    expect(JSON.stringify(rows.find((row) => row.recordId === ids.b))).not.toContain(orderA)
    expect((await ok('office.all', 'GET', `/production/work-orders/${w.a.workOrderId}`)).workOrder.supervisor).toMatchObject({ id: people.backupA, name: 'T Backup Alpha', from: 'ORDER' })
  })

  it('a person allowed on one customer only: that customer’s order changes, the other’s is skipped in words — named to the production unit, who sees both', async () => {
    const before = await told()
    const result = await ok('office.all', 'POST', ORDERS_URL, { orderIds: [orderA, orderB], supervisorId: people.supervisorA })
    expect(result.changed).toEqual([{ orderId: orderA, number: expect.any(String) }])
    expect(result.skipped).toEqual([{ orderId: orderB, number: 'SEED-SO-B001', why: SUPERVISOR_REFUSAL_WORDS.NO_REACH.en }])
    expect(await ownOf(orderB)).toMatchObject({ supervisor: people.backupA })
    expect((await toldSince(before)).map((event) => event.payload.partyId)).toEqual([ids.a])
  })

  it('PW-14: office.p2 — A’s order alone is not found; with B’s, B’s changes and A’s is only counted, never named; A’s order stays as it was', async () => {
    const before = await told()
    const ownA = await ownOf(orderA)
    const alone = await refused('office.p2', 'POST', ORDERS_URL, { orderIds: [orderA], supervisorId: people.officeB }, 404)
    expect(alone.error.message).toBe('Sales order not found.')
    const result = await ok('office.p2', 'POST', ORDERS_URL, { orderIds: [orderA, orderB], supervisorId: people.officeB })
    expect(result).toMatchObject({ changed: [{ orderId: orderB, number: 'SEED-SO-B001' }], unchanged: [], skipped: [], unknown: 1 })
    const text = JSON.stringify(result)
    expect(text).not.toContain(orderA)
    expect(findMarkers(text, await markersOf(db, ids.a))).toEqual([])
    expect(await ownOf(orderA)).toEqual(ownA)
    expect((await toldSince(before)).map((event) => event.payload)).toEqual([{ partyId: ids.b, orderIds: [orderB], supervisorId: people.officeB, previousIds: [people.backupA], backupId: null, scope: 'ORDER', batchId: expect.any(String) }])
    // office.p1 the other way round.
    expect((await refused('office.p1', 'POST', ORDERS_URL, { orderIds: [orderB], supervisorId: people.supervisorA }, 404)).error.message).toBe('Sales order not found.')
  })

  it('null: back to the customer’s default (the work order reads BRAND again); the same again is unchanged; the person refused as a whole when inactive or no office person', async () => {
    const back = await ok('office.all', 'POST', ORDERS_URL, { orderIds: [orderA], supervisorId: null })
    expect(back).toMatchObject({ supervisor: null, changed: [{ orderId: orderA }], unknown: 0 })
    expect(await ownOf(orderA)).toMatchObject({ supervisor: null, assignedAt: null })
    expect((await ok('office.all', 'GET', `/production/work-orders/${w.a.workOrderId}`)).workOrder.supervisor).toMatchObject({ id: people.supervisorA, from: 'BRAND' })
    const again = await ok('office.all', 'POST', ORDERS_URL, { orderIds: [orderA], supervisorId: null })
    expect(again).toMatchObject({ changed: [], unchanged: [{ orderId: orderA }], skipped: [] })
    const before = await told()
    for (const [who, words] of [[people.inactive, SUPERVISOR_REFUSAL_WORDS.NOT_ACTIVE.en], [w.second.userId, SUPERVISOR_REFUSAL_WORDS.NOT_OFFICE.en], [newId(), SUPERVISOR_REFUSAL_WORDS.NOT_OFFICE.en]] as const) {
      expect((await refused('office.all', 'POST', ORDERS_URL, { orderIds: [orderA, orderB], supervisorId: who }, 400)).error.issues).toEqual([{ path: 'body/supervisorId', message: words }])
    }
    expect(await toldSince(before)).toEqual([])
  })

  it('an order not in production, one not kept yet, and a person without the measurements right are skipped in words; a viewer is forbidden; 101 orders are refused', async () => {
    const draft = await salesOrder(ids.a, 'PENDING_APPROVAL')
    const fresh = await salesOrder(ids.a, 'CONFIRMED')
    const result = await ok('office.all', 'POST', ORDERS_URL, { orderIds: [draft, fresh], supervisorId: people.backupA })
    expect(result.changed).toEqual([])
    expect(result.skipped.find((row: Json) => row.orderId === draft).why).toBe('This order is no longer in production.')
    expect(result.skipped.find((row: Json) => row.orderId === fresh).why).toMatch(/no production state yet/)
    const planner = await ok('office.all', 'POST', ORDERS_URL, { orderIds: [orderB], supervisorId: people.plannerB })
    expect(planner.skipped).toEqual([{ orderId: orderB, number: 'SEED-SO-B001', why: SUPERVISOR_REFUSAL_WORDS.NO_MEASUREMENTS.en }])
    await refused('office.viewer', 'POST', ORDERS_URL, { orderIds: [orderA], supervisorId: people.backupA }, 403)
    await refused('office.all', 'POST', ORDERS_URL, { orderIds: Array.from({ length: 101 }, () => newId()), supervisorId: people.backupA }, 400)
  })
})

describe('B-PR-42a the work order list (Me / Someone else / Not set, Mine) and the record (the name, the supervisor’s own muted follow)', { timeout: 60_000 }, () => {
  it('each row says Me, Someone else or Not set for its viewer — never a name; a work order of no customer shows none', async () => {
    // B back to no supervisor at all: its order's own away, its default cleared.
    await ok('office.all', 'POST', ORDERS_URL, { orderIds: [orderB], supervisorId: null })
    await ok('office.all', 'PUT', customerUrl(ids.b), { supervisorId: null, backupId: null, version: (await settingsOf(ids.b))!.version })
    const all = (await ok('office.all', 'GET', '/production/work-orders?limit=200')).workOrders as Json[]
    const row = (id: string) => all.find((entry) => entry.id === id)!
    expect(row(w.a.workOrderId).supervisor).toBe('SOMEONE_ELSE')
    expect(row(w.b.workOrderId).supervisor).toBe('NOT_SET')
    expect(row(w.mixed.workOrderId).supervisor).toBeNull()
    const text = JSON.stringify(all)
    for (const name of ['T Supervisor Alpha', 'T Backup Alpha', 'T Office Beta']) expect(text).not.toContain(name)
    for (const person of Object.values(people)) expect(text).not.toContain(person)
    // The supervisor himself reads Me on A's.
    const his = (await ok('supervisor.a', 'GET', '/production/work-orders?limit=200')).workOrders as Json[]
    expect(his.find((entry) => entry.id === w.a.workOrderId)?.supervisor).toBe('ME')
    expect(his.some((entry) => entry.id === w.b.workOrderId)).toBe(false)
  })

  it('?supervisor=me: only the work orders the caller supervises (Mine), with the counts’ Mine tile; nobody else’s view exists', async () => {
    const mine = (await ok('supervisor.a', 'GET', '/production/work-orders?supervisor=me&limit=200')).workOrders as Json[]
    expect(mine.map((entry) => entry.id)).toContain(w.a.workOrderId)
    expect(mine.every((entry) => entry.supervisor === 'ME')).toBe(true)
    expect((await ok('office.all', 'GET', '/production/work-orders?supervisor=me&limit=200')).workOrders).toEqual([])
    const open = ((await ok('supervisor.a', 'GET', '/production/work-orders?open=true&supervisor=me&limit=200')).workOrders as Json[]).length
    expect((await ok('supervisor.a', 'GET', '/production/work-orders/counts')).counts.mine).toBe(open)
    expect((await ok('office.all', 'GET', '/production/work-orders/counts')).counts.mine).toBe(0)
    await refused('office.all', 'GET', `/production/work-orders?supervisor=${people.supervisorA}`, undefined, 400)
    // With the risk sort too (the same computed path).
    expect(((await ok('supervisor.a', 'GET', '/production/work-orders?supervisor=me&sort=risk&limit=200')).workOrders as Json[]).map((entry) => entry.id).sort()).toEqual(mine.map((entry) => entry.id).sort())
  })

  it('the record names the supervisor and where it comes from; to the supervisor himself it says whether he muted the order (youMuted), to anyone else nothing', async () => {
    const own = (await ok('supervisor.a', 'GET', `/production/work-orders/${w.a.workOrderId}`)).workOrder
    expect(own.supervisor).toEqual({ id: people.supervisorA, name: 'T Supervisor Alpha', active: true, from: 'BRAND', me: true })
    expect(own.youMuted).toBe(false)
    // He mutes his follow of the work order's thread through threads' own route (read only here).
    expect((await call('supervisor.a', 'PUT', `/threads/WorkOrder/${w.a.workOrderId}/followers/me`, { following: true, muted: true })).status).toBe(200)
    expect((await ok('supervisor.a', 'GET', `/production/work-orders/${w.a.workOrderId}`)).workOrder.youMuted).toBe(true)
    const theirs = (await ok('office.all', 'GET', `/production/work-orders/${w.a.workOrderId}`)).workOrder
    expect(theirs.supervisor).toMatchObject({ id: people.supervisorA, me: false })
    expect(theirs.youMuted).toBeNull()
    // No supervisor: none; a work order of no customer: none.
    expect((await ok('office.all', 'GET', `/production/work-orders/${w.b.workOrderId}`)).workOrder).toMatchObject({ supervisor: null, youMuted: null })
    expect((await ok('office.all', 'GET', `/production/work-orders/${w.mixed.workOrderId}`)).workOrder).toMatchObject({ supervisor: null, youMuted: null })
    // An inactive supervisor stays named, "no longer active".
    await db.admin.query(`UPDATE "User" SET status = 'SUSPENDED' WHERE id = $1`, [people.supervisorA])
    expect((await ok('office.all', 'GET', `/production/work-orders/${w.a.workOrderId}`)).workOrder.supervisor).toMatchObject({ id: people.supervisorA, active: false })
    await db.admin.query(`UPDATE "User" SET status = 'ACTIVE' WHERE id = $1`, [people.supervisorA])
  })

  it('PW-14 on the list and the record: office.p2 meets none of A’s work orders, and reads no person of A', async () => {
    await refused('office.p2', 'GET', `/production/work-orders/${w.a.workOrderId}`, undefined, 404)
    const list = await ok('office.p2', 'GET', '/production/work-orders?limit=200')
    expect((list.workOrders as Json[]).some((entry) => entry.id === w.a.workOrderId)).toBe(false)
    expect(JSON.stringify(list)).not.toContain(people.supervisorA)
    expect(findMarkers(JSON.stringify(list), await markersOf(db, ids.a))).toEqual([])
  })
})

describe('B-PR-42a the resolver supervisorOf (B-PR-32, B-PR-42b, B-PR-43a/b, B-PR-45)', { timeout: 60_000 }, () => {
  it('a sales order: its own, else the customer’s default, with the backup; a work order: its single order’s; none for a work order of no customer or another record type', async () => {
    await database.withScope({ audience: 'office', tenantId: ids.tenantId, actorId }, async (client) => {
      expect(await supervisorOf(client, { type: 'SalesOrder', id: orderA })).toEqual({ userId: people.supervisorA, from: 'BRAND', backupId: people.backupA, partyId: ids.a })
      expect(await supervisorOf(client, { type: 'WorkOrder', id: w.a.workOrderId })).toEqual({ userId: people.supervisorA, from: 'BRAND', backupId: people.backupA, partyId: ids.a })
      expect(await supervisorOf(client, { type: 'SalesOrder', id: orderB })).toEqual({ userId: null, from: null, backupId: null, partyId: ids.b })
      expect(await supervisorOf(client, { type: 'WorkOrder', id: w.mixed.workOrderId })).toBeNull()
      expect(await supervisorOf(client, { type: 'Inquiry', id: newId() })).toBeNull()
      expect(await supervisorOf(client, { type: 'SalesOrder', id: newId() })).toBeNull()
    })
    await ok('office.all', 'POST', ORDERS_URL, { orderIds: [orderA], supervisorId: people.backupA })
    await database.withScope({ audience: 'office', tenantId: ids.tenantId, actorId }, async (client) => {
      expect(await supervisorOf(client, { type: 'SalesOrder', id: orderA })).toEqual({ userId: people.backupA, from: 'ORDER', backupId: people.backupA, partyId: ids.a })
      expect(await supervisorOf(client, { type: 'WorkOrder', id: w.a.workOrderId })).toMatchObject({ userId: people.backupA, from: 'ORDER' })
    })
  })
})
