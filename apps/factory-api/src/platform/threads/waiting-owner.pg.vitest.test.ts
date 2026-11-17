import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../packages/factory-db/seed/auth'
import { seed as seedRoles } from '../../../../../packages/factory-db/seed/roles'
import { seed as seedSalesIntake } from '../../../../../packages/factory-db/seed/sales-intake'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { callerFor, command } from '../../core/command'
import { testAuthenticator, type RequestContext, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { startHarness, type Harness } from '../auth/sessions/testing/harness'
import { ensureThread, writeMessage } from './threads'

/**
 * B-TH-028 — who answers a conversation and what waits (threads plan TH-2, N1, N2; production lane agreement T8; wall W08) through
 * the app's real routes on a throwaway PostgreSQL 17 database from the migrations, on the seeds up to the sales intake (the brand
 * P1 = SEED-C1 with its orders SEED-SO-…, the customer P3 = SEED-C2 and its request SEED-INQ-0002, ASSIGNED since 3 Nov). Every
 * name and word is made up.
 *
 *   - owner: the record's maker → a request's assignee → the thread's own (PUT …/owner by whoever may post; only an active office
 *     person who reads it) → back to the record's own; a sales order's production supervisor (T8: modules/production/supervisor
 *     registers its resolver when the routes load), skipped while the order has none;
 *   - waiting: a request by its state (on us, amber after 1 working day), any other record by its newest shared message (theirs:
 *     on us, amber after 3; ours: on the customer, never amber); an office note never flips it;
 *   - W08: a portal reader's thread answer has no owner and no waiting.
 * Run with `node scripts/factory/run-pg-tests.mjs platform/threads/waiting-owner`.
 */

vi.setConfig({ testTimeout: 120_000 })

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT'

const NS = 'th2-waiting-owner'
const idOf = (key: string): string => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const P1 = idOf('party:P1')

const sales = templateOf('sales')!
const SALES = [...sales.permissions, ...sales.grains.map((grain) => `money.${grain}`)] as Permission[]
const grant = (permissions: Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const PEOPLE = { ada: newId(), bruno: newId(), carla: newId(), nina: newId(), sara: newId(), anna: newId() } as const
const SESSIONS: Record<string, SessionContext> = {
  ada: { audience: 'office', tenantId: T, actorId: PEOPLE.ada, grants: [grant(SALES)] },
  anna: { audience: 'partner', tenantId: T, actorId: PEOPLE.anna, partyId: P1, grants: [grant(['threads.read'] as Permission[], [P1])] },
}

let h: Harness
let app: FastifyInstance
const run = randomBytes(4).toString('hex')
let serial = 0
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const one = async (sql: string, values: unknown[] = []): Promise<Json> => (await admin(sql, values))[0]!
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `wo-${run}-${++serial}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const head = async (type: string, id: string) => (await ok('ada', 'GET', `/threads/${type}/${id}`)).head

/** One message written through the threads' seam (`at` back in time when given), as Ada. */
async function message(record: { type: string; id: string }, direction: 'INTERNAL_NOTE' | 'OUTBOUND' | 'INBOUND', at?: Date): Promise<void> {
  const context = { ...SESSIONS.ada, requestId: newId() } as RequestContext
  await command(callerFor(h.database, context), { name: 'threads.postNote', input: { record, direction } }, async (tools) => {
    const { thread } = await ensureThread(tools, record, PEOPLE.ada)
    await writeMessage(tools, thread, { direction, channel: direction === 'INTERNAL_NOTE' ? 'APP' : 'EMAIL', author: direction === 'INBOUND' ? { kind: 'PARTY', id: null, name: 'Made-up buyer' } : { kind: 'USER', id: PEOPLE.ada, name: 'Made-up Ada' }, bodyText: `Made-up ${direction.toLowerCase()} message.`, ...(at ? { at } : {}) })
    return { done: true }
  })
}

beforeAll(async () => {
  h = await startHarness('th2_waiting_owner')
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedSalesIntake({ db: h.database, namespace: NS })
  const roleOf = async (key: string) => (await one(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = $2`, [T, key])).id
  for (const [person, userId] of Object.entries(PEOPLE)) {
    if (person === 'anna') {
      await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, audience, "partyId", "partnerKind") VALUES ($1, $2, $3, $4, 'ACTIVE', 'PARTNER', $5, 'CUSTOMER')`, [userId, T, `th2-${person}-${run}@example.test`, `Made-up ${person}`, P1])
      continue
    }
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, $5)`, [userId, T, `th2-${person}-${run}@example.test`, `Made-up ${person}`, person === 'sara' ? 'SUSPENDED' : 'ACTIVE'])
    // Nina holds no role yet (nothing of the tenant is hers to read); the others keep sales.
    if (person === 'nina') continue
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], now() - interval '30 days')`, [newId(), T, userId, await roleOf('sales')])
  }
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('B-TH-028 who answers a conversation', () => {
  it('a request: its maker, then its assignee, then the thread’s own owner, then back to the record’s own', async () => {
    const { inquiry } = await ok('ada', 'POST', '/sales/inquiries', { companyId: companyA, source: 'PHONE', partyId: P1, request: 'Made-up: ten team vests.', lines: [{ description: 'Made-up: team vest', quantity: 10 }] }, 201)
    // No message yet: the head still answers (a request by its state), its maker owns it.
    expect(await head('Inquiry', inquiry.id)).toMatchObject({ owner: { id: PEOPLE.ada, source: 'MAKER', active: true }, waiting: { on: 'US', amber: false, thresholdDays: 1 } })
    await ok('ada', 'POST', `/sales/inquiries/${inquiry.id}/assign`, { version: inquiry.version, assigneeId: PEOPLE.bruno })
    expect((await head('Inquiry', inquiry.id)).owner).toMatchObject({ id: PEOPLE.bruno, name: 'Made-up bruno', source: 'ASSIGNEE' })
    expect((await ok('ada', 'PUT', `/threads/Inquiry/${inquiry.id}/owner`, { ownerId: PEOPLE.carla })).owner).toMatchObject({ id: PEOPLE.carla, source: 'SET' })
    expect((await head('Inquiry', inquiry.id)).owner).toMatchObject({ id: PEOPLE.carla, source: 'SET' })
    // Only an active office person who reads the conversation: one with no role, a suspended person, a portal person, nobody.
    for (const ownerId of [PEOPLE.nina, PEOPLE.sara, PEOPLE.anna, newId()]) {
      const refused = await call('ada', 'PUT', `/threads/Inquiry/${inquiry.id}/owner`, { ownerId })
      expect(refused.statusCode, refused.body).toBe(400)
      expect(refused.json().error.message).toContain('active office person')
    }
    expect((await ok('ada', 'PUT', `/threads/Inquiry/${inquiry.id}/owner`, { ownerId: null })).owner).toMatchObject({ id: PEOPLE.bruno, source: 'ASSIGNEE' })
    expect(await one('SELECT "ownerId" FROM "Thread" WHERE "recordType" = $1 AND "recordId" = $2', ['Inquiry', inquiry.id])).toEqual({ ownerId: null })
  })

  it('a sales order: its production supervisor (T8, registered by modules/production/supervisor); skipped while it has none', async () => {
    const order = await one(`SELECT id, "partyId" FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SEED-SO-0001'`, [T])
    // These seeds name no production supervisor of P1: the chain skips the step.
    const before = (await head('SalesOrder', order.id)).owner
    expect(before?.source ?? null).not.toBe('SUPERVISOR')
    // ---- T8: P1's default production supervisor, as PUT /production/brands/:partyId/supervisor writes it (one PortalSettings row
    // per party, its id the party's; B-PR-42a): the order's conversation is now his.
    await admin(
      `INSERT INTO "PortalSettings" (id, "tenantId", "partyId", "portalOn", "productionSupervisorId", "productionSupervisorSetAt", "createdAt", "updatedAt")
       VALUES ($1, $2, $1, false, $3, now(), now(), now())
       ON CONFLICT (id) DO UPDATE SET "productionSupervisorId" = EXCLUDED."productionSupervisorId", "productionSupervisorSetAt" = EXCLUDED."productionSupervisorSetAt", version = "PortalSettings".version + 1, "updatedAt" = now()`,
      [order.partyId, T, PEOPLE.carla],
    )
    expect((await head('SalesOrder', order.id)).owner).toMatchObject({ id: PEOPLE.carla, name: 'Made-up carla', source: 'SUPERVISOR' })
    // ---- end T8
    // The thread's own owner still comes first.
    await ok('ada', 'PUT', `/threads/SalesOrder/${order.id}/owner`, { ownerId: PEOPLE.bruno })
    expect((await head('SalesOrder', order.id)).owner).toMatchObject({ id: PEOPLE.bruno, source: 'SET' })
  })
})

describe('B-TH-028 what waits (one rule)', () => {
  it('a request by its state: ASSIGNED since 3 Nov waits on us and is amber (over 1 working day)', async () => {
    const assigned = await one(`SELECT id FROM "Inquiry" WHERE "tenantId" = $1 AND number = 'SEED-INQ-0002'`, [T])
    expect((await head('Inquiry', assigned.id)).waiting).toMatchObject({ on: 'US', amber: true, thresholdDays: 1, since: '2026-11-03T09:15:00.000Z' })
  })

  it('any other record by its newest shared message: theirs waits on us (amber after 3 working days), ours on the customer; a note never flips it', async () => {
    const order = await one(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SEED-SO-0002'`, [T])
    const record = { type: 'SalesOrder', id: order.id }
    expect((await head('SalesOrder', order.id)).waiting).toBeNull()
    const longAgo = new Date(Date.now() - 10 * 86_400_000)
    await message(record, 'INBOUND', longAgo)
    expect((await head('SalesOrder', order.id)).waiting).toMatchObject({ on: 'US', amber: true, thresholdDays: 3, since: longAgo.toISOString() })
    await message(record, 'INTERNAL_NOTE')
    expect((await head('SalesOrder', order.id)).waiting).toMatchObject({ on: 'US', since: longAgo.toISOString() })
    await message(record, 'OUTBOUND')
    expect((await head('SalesOrder', order.id)).waiting).toMatchObject({ on: 'CUSTOMER', amber: false, thresholdDays: 3 })
  })

  it('W08: the portal reader’s thread answer carries no owner and no waiting', async () => {
    const order = await one(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SEED-SO-0002'`, [T])
    const read = await ok('anna', 'GET', `/threads/SalesOrder/${order.id}`)
    expect(read.thread).not.toBeNull()
    expect(read.head).toBeUndefined()
    expect(JSON.stringify(read)).not.toContain('Made-up bruno')
    expect(JSON.stringify(read)).not.toContain('ownerId')
  })
})
