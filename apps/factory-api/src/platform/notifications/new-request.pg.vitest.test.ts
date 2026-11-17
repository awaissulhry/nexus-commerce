import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { EVENT_CATALOGUE } from '@nexus/factory-domain/events/catalogue'
import { liveMessageFor, liveViewFor } from '@nexus/factory-domain/events/live'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedNotifyDepth } from '../../../../../packages/factory-db/seed/notify-depth'
import { seed as seedSalesIntake } from '../../../../../packages/factory-db/seed/sales-intake'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { callerFor } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { startHarness, type Harness } from '../auth/sessions/testing/harness'
import { systemContext } from '../outbox/system'
import { fanOut } from './fan-out'

/**
 * B-TH-015 (threads plan G14, PR-19): a new request tells the people who answer requests, on the local stack (a throwaway
 * PostgreSQL 17 from the migrations, the notification and inquiry seeds, people with live roles, the real routes, the worker's
 * fan-out run on the outbox as it would):
 *   - inquiry.received → ASSIGNMENT notifications.inquiries.newRequest to every active office person who keeps inquiries over
 *     its company and customer and sees Home, never to who made it, never to a role that only reads (the production manager);
 *   - W29 (the brand wall): a request of customer P1 never notifies, nor reaches live, an office person limited to customer P3;
 *     P3's request reaches that person; a prospect's request reaches no customer-limited person live (fails closed);
 *   - the live messages name their customer (partyId), so a customer-limited person's Incoming updates live.
 * Made-up data only. Run with `node scripts/factory/run-pg-tests.mjs platform/notifications/new-request`.
 */

vi.setConfig({ testTimeout: 180_000 })

type Json = Record<string, any>
const NS = 'th015-new-request'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')
const P3 = seedUuid(NS, 'party:P3')

const PEOPLE = { ada: newId(), bruno: newId(), carla: newId(), pia: newId() } as const
type Person = keyof typeof PEOPLE
/** ada and bruno: sales over every customer; carla: sales limited to P3 (a sales rep's accounts); pia: the production manager. */
const ROLE_OF: Record<Person, string> = { ada: 'sales', bruno: 'sales', carla: 'sales', pia: 'production_manager' }
const PARTIES_OF: Record<Person, string[]> = { ada: [], bruno: [], carla: [P3], pia: [] }

let h: Harness
let app: FastifyInstance
const sessions = new Map<string, SessionContext>()
let serial = 0
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async (sql: string, values: unknown[] = []): Promise<Json> => (await admin(sql, values))[0]!
function grantOf(person: Person): Grant {
  const template = templateOf(ROLE_OF[person])!
  return { permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties: PARTIES_OF[person].length === 0 ? 'all' : PARTIES_OF[person] }
}
async function ok(who: Person, method: 'GET' | 'POST', url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': who, ...(method === 'GET' ? {} : { 'idempotency-key': `th015-key-${++serial}-${Date.now()}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
const system = () => callerFor(h.database, systemContext(T, `test-${newId()}`))
const outboxOf = (subject: string) => admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'inquiry.received' AND subject = $2`, [T, subject])
const envelopeOf = (row: Json) => ({ eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload })
async function noticed(inquiryId: string): Promise<Record<Person, Json[]>> {
  const found = Object.fromEntries(Object.keys(PEOPLE).map((person) => [person, []])) as unknown as Record<Person, Json[]>
  const rows = await admin(`SELECT "userId", category, "messageKey", "recordLabel", "actorId" FROM "Notification" WHERE "recordId" = $1 AND "eventType" = 'inquiry.received'`, [inquiryId])
  for (const row of rows) {
    const person = (Object.keys(PEOPLE) as Person[]).find((key) => PEOPLE[key] === row.userId)
    if (person) found[person].push(row)
  }
  return found
}
/** What each person's live screen receives of the request's inquiry.received (null: nothing). */
async function liveOf(inquiryId: string): Promise<Record<Person, Json | null>> {
  const [row] = await outboxOf(inquiryId)
  const message = liveMessageFor(envelopeOf(row!) as never, EVENT_CATALOGUE.get('inquiry.received', 1)!)!
  return Object.fromEntries((Object.keys(PEOPLE) as Person[]).map((person) => [person, liveViewFor(message, { audience: 'office', tenantId: T, grants: [grantOf(person)] } as never, EVENT_CATALOGUE) as Json | null])) as Record<Person, Json | null>
}
async function newRequest(who: Person, body: Json): Promise<Json> {
  const { inquiry } = await ok(who, 'POST', '/sales/inquiries', { companyId: companyA, source: 'PHONE', request: 'Made-up: twenty jackets for the spring.', ...body }, 201)
  const [row] = await outboxOf(inquiry.id)
  expect(row).toBeDefined()
  await fanOut(system(), envelopeOf(row!))
  return inquiry
}

beforeAll(async () => {
  h = await startHarness('th015_new_request')
  await seedCore({ db: h.database, namespace: NS })
  await seedNotifyDepth({ db: h.database, namespace: NS })
  await seedSalesIntake({ db: h.database, namespace: NS })
  for (const [key, id] of Object.entries(PEOPLE) as [Person, string][]) {
    const roleId = (await one(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = $2`, [T, ROLE_OF[key]])).id
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, locale) VALUES ($1, $2, $3, $4, 'ACTIVE', 'en')`, [id, T, `${key}@th015.example.com`, `Made-up ${key}`])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "partyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], $5::uuid[], now() - interval '1 day')`, [newId(), T, id, roleId, PARTIES_OF[key]])
    sessions.set(key, { audience: 'office', tenantId: T, actorId: id, grants: [grantOf(key)] })
  }
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => sessions.get(String(request.headers['x-test-session'])) ?? null) },
  )
}, 300_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
})

describe('a new request tells the people who answer requests (B-TH-015)', () => {
  it("P1's request: sales over every customer hears it (not its maker); the P3-limited person and the production manager do not (W29)", async () => {
    const inquiry = await newRequest('ada', { partyId: P1 })
    const notes = await noticed(inquiry.id)
    expect(notes.bruno).toEqual([expect.objectContaining({ category: 'ASSIGNMENT', messageKey: 'notifications.inquiries.newRequest', recordLabel: inquiry.number, actorId: PEOPLE.ada })])
    expect(notes.ada).toEqual([])
    expect(notes.carla).toEqual([])
    expect(notes.pia).toEqual([])
    // Live: the message names its customer; the P3-limited person receives nothing of P1's request.
    const live = await liveOf(inquiry.id)
    expect(live.bruno).toMatchObject({ type: 'inquiry.received', fields: { inquiryId: inquiry.id, partyId: P1 } })
    expect(live.carla).toBeNull()
    expect(live.pia).toMatchObject({ fields: { partyId: P1 } })
  })

  it("P3's request reaches the person limited to P3, live too; a request made already assigned tells its assignee once", async () => {
    const inquiry = await newRequest('ada', { partyId: P3, assigneeId: PEOPLE.bruno })
    const notes = await noticed(inquiry.id)
    expect(notes.carla).toEqual([expect.objectContaining({ messageKey: 'notifications.inquiries.newRequest', recordLabel: inquiry.number })])
    expect(notes.bruno).toHaveLength(1)
    expect(notes.pia).toEqual([])
    expect((await liveOf(inquiry.id)).carla).toMatchObject({ fields: { inquiryId: inquiry.id, partyId: P3 } })
  })

  it("a prospect's request tells every keeper (a prospect reaches every role of the company) but goes live to no customer-limited person", async () => {
    const inquiry = await newRequest('bruno', { prospect: { name: 'Made-up Visitor', company: 'Made-up Club' } })
    const notes = await noticed(inquiry.id)
    expect(notes.ada).toHaveLength(1)
    expect(notes.carla).toHaveLength(1)
    expect(notes.bruno).toEqual([])
    const live = await liveOf(inquiry.id)
    expect(live.ada).toMatchObject({ fields: { partyId: null } })
    expect(live.carla).toBeNull()
  })
})
