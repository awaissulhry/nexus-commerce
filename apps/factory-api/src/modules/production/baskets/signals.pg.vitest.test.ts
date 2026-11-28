import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedAndon } from '../../../../../../packages/factory-db/seed/andon'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { SYSTEM_ACTOR_ID, testAuthenticator, type RequestContext, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { applyBasketSignal } from './queued'

/**
 * owb-fl3 (S5 server B) — the team leader's Do this first and Will be late, Tell the office and the Me page, on the local stack
 * with the app's real routes (a throwaway PostgreSQL 17 database from the migrations: the runtime logins, row-level security and
 * the …_floor_baskets_2 / …_order_workflow guards are real) and the factory-db seeds up to the line's signals (plant A1 names
 * workers; its operator acknowledged the notice; WO-0001 with its bundles). Written, not run (Owner rule: checks at the end).
 * Every name is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/production/baskets/signals`.
 *
 * Walls: a worker (not a leader) cannot set FIRST or late; another site's basket is not found; a suggestion without the name
 * keeps no worker, employee or device (row, audit actor) and never goes through the queue; the Me page's done count waits for
 * the PIN step-up.
 */

let h: Harness
let app: FastifyInstance

const ns = 'basket-signals'
const idOf = (key: string) => seedUuid(ns, key)
const A = {
  tenant: idOf('tenant'),
  companyA: idOf('company:A'),
  siteA1: idOf('site:A1'),
  operator: idOf('worker:A1:operator'),
  lead: idOf('worker:A1:lead'),
  wo1: idOf('production:work-order:WO-0001'),
  bundle1: idOf('production:bundle:WO-0001:1'),
  bundle2: idOf('production:bundle:WO-0001:2'),
  phone: newId(),
  phoneSession: newId(),
  leadTablet: newId(),
}

const floorAt = (deviceId: string, actorId: string, permissions: Permission[]): SessionContext => ({
  audience: 'floor',
  tenantId: A.tenant,
  actorId,
  siteId: A.siteA1,
  deviceId,
  grants: [{ permissions, companies: [A.companyA], sites: [A.siteA1], parties: 'all' }],
})
const SESSIONS: Record<string, SessionContext> = {
  worker: floorAt(A.phone, A.operator, ['floor.work', 'production.scan']),
  lead: floorAt(A.leadTablet, A.lead, ['floor.work', 'floor.lead', 'production.scan']),
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `sig-${run}-${++keys}`
let cid = 0
const clientId = () => `evt-${run}-${String(++cid).padStart(4, '0')}`
const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': freshKey() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: 'GET' | 'POST', url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}

beforeAll(async () => {
  h = await startHarness('basket-signals')
  await seedCore({ db: h.database, namespace: ns })
  await seedReasons({ db: h.database, namespace: ns })
  await seedAndon({ db: h.database, namespace: ns })
  await seedNumbering({ db: h.database, namespace: ns })
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) =>
    applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }),
  )
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", mode, "personalWorkerId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, 'PHONE', $5, 'Operator phone', 'HANDHELD', 'ACTIVE', now())`, [A.phone, A.tenant, A.companyA, A.siteA1, A.operator])
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", mode, name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, 'STATION', 'Leader tablet', 'TABLET', 'ACTIVE', now())`, [A.leadTablet, A.tenant, A.companyA, A.siteA1])
  await admin(
    `INSERT INTO "FloorSession" (id, "tenantId", "siteId", "deviceId", "workerId", "tokenHash", "startedAt", "lastSeenAt", "idleExpiresAt", "endsAt") VALUES ($1, $2, $3, $4, $5, $6, now(), now(), now() + interval '1 hour', now() + interval '8 hours')`,
    [A.phoneSession, A.tenant, A.siteA1, A.phone, A.operator, randomBytes(32).toString('hex')],
  )
  await admin('UPDATE "Device" SET "currentSessionId" = $2, "inUseSince" = now() WHERE id = $1', [A.phone, A.phoneSession])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('Do this first (floor.lead)', () => {
  it('REFUSED for a worker who is not a team leader (403)', async () => {
    expect((await call('worker', 'POST', '/production/baskets/flags', { bundleIds: [A.bundle1], kind: 'FIRST', on: true, clientEventId: clientId() })).statusCode).toBe(403)
    expect((await call('worker', 'POST', '/production/baskets/late', { bundleIds: [A.bundle1], days: 2, reason: 'MATERIAL', clientEventId: clientId() })).statusCode).toBe(403)
  })

  it('sets one open FIRST per basket under one event, keeps the one that has it, clears once', async () => {
    const first = await ok('lead', 'POST', '/production/baskets/flags', { bundleIds: [A.bundle1, A.bundle2], kind: 'FIRST', on: true, clientEventId: clientId() })
    expect(first).toMatchObject({ changed: 2, stay: 0 })
    const again = await ok('lead', 'POST', '/production/baskets/flags', { bundleIds: [A.bundle1], kind: 'FIRST', on: true, clientEventId: clientId() })
    expect(again).toMatchObject({ changed: 0, stay: 1 })
    const open = await admin('SELECT "bundleId", "setByWorkerId", "deviceId" FROM "BasketFlag" WHERE "bundleId" = ANY($1::uuid[]) AND "clearedAt" IS NULL ORDER BY "bundleId"', [[A.bundle1, A.bundle2]])
    expect(open).toHaveLength(2)
    const cleared = await ok('lead', 'POST', '/production/baskets/flags', { bundleIds: [A.bundle1], kind: 'FIRST', on: false, clientEventId: clientId() })
    expect(cleared).toMatchObject({ changed: 1, flags: [{ bundleId: A.bundle1, first: false }] })
    expect((await ok('lead', 'POST', '/production/baskets/flags', { bundleIds: [A.bundle1], kind: 'FIRST', on: false, clientEventId: clientId() })).changed).toBe(0)
  })

  it('REFUSED: more than 50 baskets (400), a basket that does not exist here (404)', async () => {
    const many = Array.from({ length: 51 }, () => newId())
    expect((await call('lead', 'POST', '/production/baskets/flags', { bundleIds: many, kind: 'FIRST', on: true, clientEventId: clientId() })).statusCode).toBe(400)
    expect((await call('lead', 'POST', '/production/baskets/flags', { bundleIds: [newId()], kind: 'FIRST', on: true, clientEventId: clientId() })).statusCode).toBe(404)
  })
})

describe('Will be late (floor.lead)', () => {
  it('writes ONE OPEN warning per work order (the whole work order for two of its baskets); days 1·2·3·5 only', async () => {
    const answer = await ok('lead', 'POST', '/production/baskets/late', { bundleIds: [A.bundle1, A.bundle2], days: 3, reason: 'MACHINE', clientEventId: clientId() }, 201)
    expect(answer.warnings).toHaveLength(1)
    expect(answer.warnings[0]).toMatchObject({ workOrderId: A.wo1, bundleId: null, days: 3, reason: 'MACHINE', state: 'OPEN' })
    const one = await ok('lead', 'POST', '/production/baskets/late', { bundleIds: [A.bundle1], days: 1, reason: 'PEOPLE', clientEventId: clientId() }, 201)
    expect(one.warnings[0]).toMatchObject({ bundleId: A.bundle1 })
    const row = (await admin('SELECT state::text AS state, "answeredAt", "deviceId" FROM "FloorLateWarning" WHERE id = $1', [answer.warnings[0].id]))[0]!
    expect(row).toMatchObject({ state: 'OPEN', answeredAt: null, deviceId: A.leadTablet })
    expect((await call('lead', 'POST', '/production/baskets/late', { bundleIds: [A.bundle1], days: 4, reason: 'PEOPLE', clientEventId: clientId() })).statusCode).toBe(400)
  })
})

describe('Tell the office', () => {
  it('WITHOUT the name: no worker, no employee, no device on the row; the audit actor is the system', async () => {
    const answer = await ok('worker', 'POST', '/floor/suggestions', { kind: 'IDEA', words: 'A second glue pot at stitching.', withName: false, clientEventId: clientId() }, 201)
    expect(answer.suggestion).toMatchObject({ kind: 'IDEA', withName: false })
    const row = (await admin('SELECT "workerId", "employeeId", "deviceId", words FROM "FloorSuggestion" WHERE id = $1', [answer.suggestion.id]))[0]!
    expect(row).toMatchObject({ workerId: null, employeeId: null, deviceId: null, words: 'A second glue pot at stitching.' })
    const audit = await admin('SELECT "actorId" FROM "AuditLog" WHERE "recordId" = $1', [answer.suggestion.id])
    expect(audit.map((entry) => entry.actorId)).toEqual([SYSTEM_ACTOR_ID])
  })

  it('WITH the name: the worker (the site names workers) and the device; the kind alone is enough', async () => {
    const answer = await ok('worker', 'POST', '/floor/suggestions', { kind: 'THANKS', withName: true, clientEventId: clientId() }, 201)
    expect(answer.suggestion.withName).toBe(true)
    expect((await admin('SELECT "workerId", "deviceId" FROM "FloorSuggestion" WHERE id = $1', [answer.suggestion.id]))[0]).toMatchObject({ workerId: A.operator, deviceId: A.phone })
  })

  it('the offline queue takes a named one and REFUSES one without the name (its ledger names the worker)', async () => {
    const caller = callerFor(h.database, { ...(SESSIONS.worker as SessionContext), requestId: `sig-${run}` } as RequestContext)
    const anonymous = clientId()
    const refused = await applyBasketSignal(caller, { kind: 'floor.suggestion', clientEventId: anonymous, payload: { kind: 'WRONG', words: 'The light at table 3 flickers.', withName: false } }, `${A.phone}.${anonymous}`)
    expect(refused).toMatchObject({ status: 'refused', refusal: { code: 'ANON_ONLINE' } })
    const named = clientId()
    expect((await applyBasketSignal(caller, { kind: 'floor.suggestion', clientEventId: named, payload: { kind: 'IDEA', withName: true } }, `${A.phone}.${named}`)).status).toBe('accepted')
  })
})

describe('the Me page (GET /floor/me/profile)', () => {
  it('my team, the languages, the departments; the done count only after the PIN step-up', async () => {
    const before = await ok('worker', 'GET', '/floor/me/profile')
    expect(before).toMatchObject({ subject: 'WORKER', doneToday: null })
    expect(Array.isArray(before.departments) && before.departments.length > 0).toBe(true)
    expect(['SKILLS', 'ALL']).toContain(before.departmentsFrom)
    expect(before.floorLocales).toEqual(expect.arrayContaining(['it']))
    await admin('UPDATE "FloorSession" SET "pinVerifiedAt" = now() WHERE id = $1', [A.phoneSession])
    const after = await ok('worker', 'GET', '/floor/me/profile')
    expect(typeof after.doneToday).toBe('number')
  })
})
