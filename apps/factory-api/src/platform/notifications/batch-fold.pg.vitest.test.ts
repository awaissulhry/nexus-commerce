import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { batchGroupKey } from '@nexus/factory-domain/notifications/rules'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedSalesIntake } from '../../../../../packages/factory-db/seed/sales-intake'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { callerFor } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { askApprovalContract } from '../../modules/sales/quotes/contract'
import { systemContext } from '../outbox/system'
import { fanOut } from './fan-out'

/**
 * B-CQ-040 (customer page › Quotes & incoming, settle C10; 13-backend §6): ONE act on N quotes or requests is ONE bell item per
 * reader — through the app's real routes on a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level
 * security and the guards are real), the core and sales-intake seeds (customer P1 = Seed Customer One, its number series), and the
 * worker's fan-out run in-process on the events the commands wrote:
 *
 *   Assign N      one command, ≥ 2 items: one `batchId` on every inquiry.changed → the assignee has ONE item (it was N)
 *   Decline N     one command: one `batchId` on every inquiry.closed → each follower ONE item; who declined is never told
 *   Mark N lost   N commands sending one `batchId` → each follower ONE item
 *   Cancel N      N commands sending one `batchId` → each follower ONE item; the same N without it → N items (today's)
 *   Ask about N   N asks on portal requests sending one `batchId` → the portal message rides with it → each follower ONE item
 *   Approval asks are NOT folded (C10: each is a decision of its own): their body takes no batch at all.
 *
 * People (made up): the actor (who acts), the assignee, a watcher who follows every record. Requests are made through the real route
 * (TEST requests of P1); two are set to have come from the portal (test data past the guards). Every name and number is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs platform/notifications/batch-fold`.
 */

const ns = 'cq-batch-fold'
const T = seedUuid(ns, 'tenant')
const companyA = seedUuid(ns, 'company:A')
const P1 = seedUuid(ns, 'party:P1')
const PERMISSIONS: Permission[] = ['home.view', 'threads.read', 'threads.post', 'sales.inquiries.view', 'sales.inquiries.manage', 'quotes.view', 'quotes.manage', 'parties.view']
const PEOPLE = { actor: newId(), assignee: newId(), watcher: newId() } as const
type Person = keyof typeof PEOPLE
const SESSIONS: Record<string, SessionContext> = {
  actor: { audience: 'office', tenantId: T, actorId: PEOPLE.actor, grants: [{ permissions: PERMISSIONS, companies: 'all', sites: 'all', parties: 'all' }] },
}

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
const run = randomBytes(4).toString('hex')
let serial = 0
/** The events already fanned out (each once). */
const fanned = new Set<string>()

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await db.admin.query(sql, values)).rows as R[]
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
async function ok(method: 'GET' | 'POST', url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': 'actor', ...(method === 'GET' ? {} : { 'idempotency-key': `cq-bf-${run}-${++serial}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
  expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(status)
  return response.json() as Json
}
async function follow(person: Person, recordType: string, recordId: string): Promise<void> {
  await admin(`INSERT INTO "RecordFollower" (id, "tenantId", "recordType", "recordId", "userId", reason, muted) VALUES ($1, $2, $3, $4, $5, 'CHOSE'::"FollowReason", false) ON CONFLICT DO NOTHING`, [newId(), T, recordType, recordId, PEOPLE[person]])
}
/** A request of P1 typed by the actor (the real route). */
async function newRequest(words: string): Promise<Json> {
  return (await ok('POST', '/sales/inquiries', { companyId: companyA, source: 'PHONE', partyId: P1, request: `Made-up: ${words}`, lines: [{ description: `Made-up: ${words}`, quantity: 10 }] }, 201)).inquiry
}
/** The worker's fan-out of every not yet fanned event of these types about these records (oldest first); their ids. */
async function fanOutOf(types: readonly string[], subjects: readonly string[]): Promise<string[]> {
  const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = ANY($2::text[]) AND (subject = ANY($3::text[]) OR payload->>'recordId' = ANY($3::text[])) ORDER BY "occurredAt", id`, [T, types, subjects])
  const fresh = rows.filter((row) => !fanned.has(row.id))
  for (const row of fresh) {
    fanned.add(row.id)
    const event: EventEnvelope = { eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload }
    await fanOut(callerFor(database, systemContext(T, `cq-bf-fan-${row.id}`)), event)
  }
  return fresh.map((row) => row.id)
}
/** A person's bell rows of these events. */
const bellOf = (person: Person, eventIds: readonly string[]) =>
  admin<{ messageKey: string; recordId: string; groupKey: string; category: string }>(`SELECT "messageKey", "recordId", "groupKey", category FROM "Notification" WHERE "userId" = $1 AND "eventId" = ANY($2::uuid[]) ORDER BY "createdAt", id`, [PEOPLE[person], eventIds])
/** The bell items (groups) a person's rows make. */
const itemsOf = (rows: readonly { groupKey: string }[]): number => new Set(rows.map((row) => row.groupKey)).size
const payloadsOf = async (type: string, subjects: readonly string[]): Promise<Json[]> => (await admin(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 AND subject = ANY($3::text[]) ORDER BY "occurredAt", id`, [T, type, subjects])).map((row) => row.payload)

beforeAll(async () => {
  db = await migratedDatabase('cq_batch_fold')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: ns })
  await seedSalesIntake({ db: database, namespace: ns })
  // The office people: one made-up role holding the requests' and quotes' rights, every company and customer.
  const roleId = newId()
  await admin(`INSERT INTO "Role" (id, "tenantId", key, name, audience, permissions) VALUES ($1, $2, 'custom.cq_batch_fold', 'Made-up sales office', 'OFFICE', $3)`, [roleId, T, PERMISSIONS])
  for (const person of Object.keys(PEOPLE) as Person[]) {
    await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, $5)', [PEOPLE[person], T, `cq-bf-${person.toLowerCase()}-${run}@example.com`, `Made-up ${person}`, 'ACTIVE'])
    await admin('INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "partyIds", "validFrom") VALUES ($1, $2, $3, $4, true, $5, $6)', [newId(), T, PEOPLE[person], roleId, [], new Date('2026-01-01T00:00:00.000Z')])
  }
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('B-CQ-040: one act on N records = one bell item per reader', { timeout: 120_000 }, () => {
  const assigned: Json[] = []

  it('Assign 3 (one command): one batch on the three inquiry.changed — the assignee has ONE item, not three', async () => {
    for (const words of ['three team vests', 'two rain jackets', 'one race suit']) assigned.push(await newRequest(words))
    const ids = assigned.map((row) => row.id as string)
    const answer = await ok('POST', '/sales/inquiries/assign', { items: assigned.map((row) => ({ inquiryId: row.id, version: row.version })), assigneeId: PEOPLE.assignee })
    expect(answer.inquiries).toHaveLength(3)
    const payloads = (await payloadsOf('inquiry.changed', ids)).filter((payload) => payload.change === 'ASSIGNED')
    expect(payloads).toHaveLength(3)
    const batchId = payloads[0]!.batchId as string
    expect(batchId).toMatch(/^[0-9a-f-]{36}$/)
    expect(payloads.every((payload) => payload.batchId === batchId)).toBe(true)
    const eventIds = await fanOutOf(['inquiry.changed'], ids)
    const bell = await bellOf('assignee', eventIds)
    expect(bell.map((row) => row.recordId).sort()).toEqual([...ids].sort())
    expect(bell.every((row) => row.messageKey === 'notifications.inquiries.assigned' && row.category === 'ASSIGNMENT')).toBe(true)
    expect(itemsOf(bell)).toBe(1)
    expect(bell[0]!.groupKey).toBe(batchGroupKey(batchId, 'ASSIGNMENT'))
    // One item assigned alone carries no batch (one record, one item as today).
    const single = await newRequest('a single glove order')
    await ok('POST', '/sales/inquiries/assign', { items: [{ inquiryId: single.id, version: single.version }], assigneeId: PEOPLE.assignee })
    expect((await payloadsOf('inquiry.changed', [single.id])).find((payload) => payload.change === 'ASSIGNED')).not.toHaveProperty('batchId')
  })

  it('Decline 3 (one command): each follower ONE item; who declined is never told', async () => {
    const ids = assigned.map((row) => row.id as string)
    for (const id of ids) await follow('watcher', 'Inquiry', id)
    const fresh = (await ok('GET', '/sales/incoming?tile=ALL&limit=200')).rows as Json[]
    const items = ids.map((id) => ({ inquiryId: id, version: fresh.find((row) => row.id === id)!.version as number }))
    await ok('POST', '/sales/inquiries/decline', { items, reason: 'CAPACITY' })
    const payloads = await payloadsOf('inquiry.closed', ids)
    expect(payloads).toHaveLength(3)
    expect(new Set(payloads.map((payload) => payload.batchId)).size).toBe(1)
    const eventIds = await fanOutOf(['inquiry.closed'], ids)
    for (const person of ['watcher', 'assignee'] as const) {
      const bell = await bellOf(person, eventIds)
      expect(bell.map((row) => row.recordId).sort(), person).toEqual([...ids].sort())
      expect(itemsOf(bell), person).toBe(1)
      expect(bell[0]!.groupKey, person).toBe(batchGroupKey(payloads[0]!.batchId, 'FOLLOWING'))
    }
    expect(await bellOf('actor', eventIds)).toEqual([])
  })

  it('Mark 2 lost (two commands, one batchId): the follower has ONE item', async () => {
    const lost = [await newRequest('a cap order'), await newRequest('a scarf order')]
    for (const row of lost) await follow('watcher', 'Inquiry', row.id)
    const batchId = newId()
    for (const row of lost) await ok('POST', `/sales/inquiries/${row.id}/lost`, { version: row.version, note: 'Made-up: the customer went elsewhere.', batchId })
    const ids = lost.map((row) => row.id as string)
    expect((await payloadsOf('inquiry.closed', ids)).map((payload) => payload.batchId)).toEqual([batchId, batchId])
    const bell = await bellOf('watcher', await fanOutOf(['inquiry.closed'], ids))
    expect(bell).toHaveLength(2)
    expect(itemsOf(bell)).toBe(1)
    expect(bell[0]!.groupKey).toBe(batchGroupKey(batchId, 'FOLLOWING'))
  })

  it('Cancel 3 quotes with one batchId: ONE item per follower; the same 3 without it: 3 items (today’s)', async () => {
    const made: Json[] = []
    for (let index = 0; index < 6; index++) made.push((await ok('POST', '/sales/quotes', { companyId: companyA, partyId: P1, customerRef: `TEST-RFQ-${index + 1}` }, 201)).quote)
    for (const quote of made) await follow('watcher', 'Quote', quote.id)
    const batchId = newId()
    for (const quote of made.slice(0, 3)) await ok('POST', `/sales/quotes/${quote.id}/cancel`, { version: quote.version, batchId })
    for (const quote of made.slice(3)) await ok('POST', `/sales/quotes/${quote.id}/cancel`, { version: quote.version })
    const batched = made.slice(0, 3).map((quote) => quote.id as string)
    const alone = made.slice(3).map((quote) => quote.id as string)
    expect((await payloadsOf('quote.cancelled', batched)).map((payload) => payload.batchId)).toEqual([batchId, batchId, batchId])
    for (const payload of await payloadsOf('quote.cancelled', alone)) expect(payload).not.toHaveProperty('batchId')
    const together = await bellOf('watcher', await fanOutOf(['quote.cancelled'], batched))
    expect(together).toHaveLength(3)
    expect(itemsOf(together)).toBe(1)
    expect(together[0]!.groupKey).toBe(batchGroupKey(batchId, 'FOLLOWING'))
    const apart = await bellOf('watcher', await fanOutOf(['quote.cancelled'], alone))
    expect(apart).toHaveLength(3)
    expect(itemsOf(apart)).toBe(3)
    // The actor (who cancelled, and made them) is never told.
    expect(await bellOf('actor', [...fanned])).toEqual([])
    // A bad batch id is refused by the body.
    expect((await app.inject({ method: 'POST', url: `/sales/quotes/${made[0]!.id}/cancel`, headers: { 'x-test-session': 'actor', 'idempotency-key': `cq-bf-${run}-${++serial}` }, payload: { version: 1, batchId: 'nope' } })).statusCode).toBe(400)
  })

  it('Ask about 2 portal requests with one batchId: the portal messages carry it — the follower has ONE item', async () => {
    const asked = [await newRequest('a portal glove request'), await newRequest('a portal boot request')]
    const ids = asked.map((row) => row.id as string)
    // They came from the customer's portal (test data past the guards): the question goes as a portal message of their threads.
    await force(`UPDATE "Inquiry" SET source = 'PORTAL' WHERE id = ANY($1::uuid[])`, [ids])
    for (const id of ids) await follow('watcher', 'Inquiry', id)
    const batchId = newId()
    for (const row of asked) await ok('POST', `/sales/inquiries/${row.id}/ask-info`, { version: row.version, message: { body: 'Made-up: which sizes do you need?' }, batchId })
    const posted = (await admin(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'thread.message_posted' AND payload->>'recordId' = ANY($2::text[]) ORDER BY "occurredAt", id`, [T, ids])).map((row) => row.payload as Json)
    expect(posted).toHaveLength(2)
    expect(posted.map((payload) => payload.batchId)).toEqual([batchId, batchId])
    expect((await payloadsOf('inquiry.changed', ids)).filter((payload) => payload.change === 'NEED_INFO').map((payload) => payload.batchId)).toEqual([batchId, batchId])
    const bell = (await bellOf('watcher', await fanOutOf(['thread.message_posted'], ids))).filter((row) => ids.includes(row.recordId))
    expect(bell).toHaveLength(2)
    expect(itemsOf(bell)).toBe(1)
    expect(bell[0]!.groupKey).toBe(batchGroupKey(batchId, 'FOLLOWING'))
  })

  it('approval asks are NOT folded (C10): the ask-for-approval body takes no batch', () => {
    const body = askApprovalContract.body
    expect(body.safeParse({ version: 1, note: null }).success).toBe(true)
    expect(body.safeParse({ version: 1, note: null, batchId: newId() }).success).toBe(false)
  })
})
