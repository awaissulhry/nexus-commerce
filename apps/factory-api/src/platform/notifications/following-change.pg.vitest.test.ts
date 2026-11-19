import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { EVENT_CATALOGUE } from '@nexus/factory-domain/events/catalogue'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { liveMessageFor } from '@nexus/factory-domain/events/live'
import { batchGroupKey, orderChangeBatch } from '@nexus/factory-domain/notifications/rules'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../packages/factory-db/seed/production'
import { buildApp } from '../../core/app'
import { callerFor, command } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { productionTwoBrands, twoBrandIds, twoBrandSessions, type ProductionTwoBrands } from '../../modules/production/testing/two-brands'
import { systemContext } from '../outbox/system'
import { ensureThread, writeMessage, type MessageInput } from '../threads/threads'
import { fanOut } from './fan-out'

/**
 * B-SA-051 (Sales page plan R9 "ONE bell mechanism per change", P8; 13-backend B7; 14-change-flow §5; review C-7) on the local stack:
 * a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the guards are real), the
 * core, files, production and numbering seeds, and the production two-brand harness (brand Alpha = the seeds' P1, brand Beta = the
 * threads' second brand; an order and a work order each, and a work order mixed before the one-customer rule). The system line of
 * a change (B-SA-052's writer) and its floor note (B-SA-053's) are written here as those writers will — one system command per
 * change, `writeMessage` with `change` — and fanned out as the worker does, with the order's promise move of the same command:
 *
 *   ONE ITEM   every note of one change of one order and the order's own move are ONE bell group per reader (the change's batch);
 *   ACTOR      the person who made the change is never told; a change nobody of the office made (a withdrawal) tells everyone on it;
 *   WHO        the order's followers (the supervisor follows by himself; the customer's backup only once he follows), the work
 *              order's followers through its floor note ("WO-…: its order SO-… changed — …"); never a muted follow;
 *   THE WALL   a person limited to Brand Beta who follows Alpha's order or work order is told nothing; a mixed work order's note only
 *              people of every customer; a work order's face never names another customer's order;
 *   SAME AS    a person's own note and any other system note keep their words and batch.
 *
 * Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs platform/notifications/following-change`.
 */

const ns = 'sa051-bell'
const ids = twoBrandIds(ns)
const PERMISSIONS: Permission[] = ['home.view', 'threads.read', 'threads.post', 'orders.view', 'workorders.view', 'workorders.manage']
const SESSIONS: Record<string, SessionContext> = twoBrandSessions(ids.tenantId, ids.a, ids.b, PERMISSIONS)

/** The office people (one made-up role): who made the change, the supervisor, the customer's backup, a muted follower, people
 * limited to Alpha and to Beta, and the factory (every customer). */
const PEOPLE = { actor: newId(), supervisor: newId(), backup: newId(), muted: newId(), alphaRep: newId(), betaRep: newId(), factory: newId() } as const
type Person = keyof typeof PEOPLE
const REACH: Record<Person, 'all' | 'a' | 'b'> = { actor: 'all', supervisor: 'all', backup: 'all', muted: 'all', alphaRep: 'a', betaRep: 'b', factory: 'all' }

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let w: ProductionTwoBrands
let alphaOrderNumber = ''

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]

async function follow(person: Person, recordType: string, recordId: string, options: { readonly muted?: boolean; readonly reason?: string } = {}): Promise<void> {
  await admin(`INSERT INTO "RecordFollower" (id, "tenantId", "recordType", "recordId", "userId", reason, muted) VALUES ($1, $2, $3, $4, $5, $6::"FollowReason", $7)`, [newId(), w.tenantId, recordType, recordId, PEOPLE[person], options.reason ?? 'CHOSE', options.muted ?? false])
}

interface Note {
  readonly type: 'SalesOrder' | 'WorkOrder'
  readonly id: string
  readonly body: string
  readonly change?: MessageInput['change']
  readonly forFloor?: boolean
}

/** One system command of one correlation (a request, or the worker's handler of its events) writing these notes. */
async function writeNotes(correlationId: string, notes: readonly Note[]): Promise<void> {
  await command(callerFor(database, systemContext(w.tenantId, correlationId)), { name: 'test.changeNotes', input: { notes: notes.length } }, async (tools) => {
    for (const note of notes) {
      const { thread } = await ensureThread(tools, { type: note.type, id: note.id }, null)
      await writeMessage(tools, thread, { direction: 'INTERNAL_NOTE', channel: 'APP', author: { kind: 'SYSTEM', id: null, name: null }, bodyText: note.body, ...(note.forFloor ? { forFloor: true } : {}), ...(note.change ? { change: note.change } : {}) })
    }
    return null
  })
}

/** The order's promise move of a command, as its emitter writes it, with the audit row that names the office person who asked. */
async function promiseMoved(correlationId: string, orderId: string, partyId: string, by: Person | null): Promise<EventEnvelope> {
  if (by) await admin(`INSERT INTO "AuditLog" (id, "tenantId", "companyId", audience, "actorId", action, "recordType", "recordId", "requestId") VALUES ($1, $2, $3, 'OFFICE', $4, 'sales.promise', 'SalesOrder', $5, $6)`, [newId(), w.tenantId, w.companyId, PEOPLE[by], orderId, correlationId])
  return { eventId: newId(), type: 'sales_order.promise_changed', version: 1, context: 'sales', tenantId: w.tenantId, companyId: w.companyId, siteId: null, subject: orderId, correlationId, causationId: null, source: 'test', occurredAt: new Date().toISOString(), payload: { orderId, partyId } }
}

/** The worker's fan-out of the messages one correlation wrote (oldest first), and of the given events; their event ids. */
async function fanOutChange(correlationId: string, extra: readonly EventEnvelope[] = []): Promise<string[]> {
  const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'thread.message_posted' AND "correlationId" = $2 ORDER BY "occurredAt", id`, [w.tenantId, correlationId])
  const events: EventEnvelope[] = rows.map((row) => ({ eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload }))
  for (const event of [...events, ...extra]) await fanOut(callerFor(database, systemContext(w.tenantId, `sa051-fan-${event.eventId}`)), event)
  return [...events, ...extra].map((event) => event.eventId)
}

/** A person's bell rows of these events. */
const bellOf = (person: Person, eventIds: readonly string[]) =>
  admin<{ messageKey: string; recordType: string; recordId: string; recordLabel: string; params: Json; actorId: string | null; groupKey: string; category: string }>(
    `SELECT "messageKey", "recordType", "recordId", "recordLabel", params, "actorId", "groupKey", category FROM "Notification" WHERE "userId" = $1 AND "eventId" = ANY($2::uuid[]) ORDER BY "createdAt", id`,
    [PEOPLE[person], eventIds],
  )
/** The bell items (groups) a person's rows make. */
const itemsOf = (rows: readonly { groupKey: string }[]) => new Set(rows.map((row) => row.groupKey)).size

beforeAll(async () => {
  db = await migratedDatabase('sa051_following')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  await seedFiles({ db: database, namespace: ns })
  await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  w = await productionTwoBrands({ db, database, app, namespace: ns })
  expect([w.a.partyId, w.b.partyId]).toEqual([ids.a, ids.b])
  alphaOrderNumber = (await admin<{ number: string }>(`SELECT number FROM "SalesOrder" WHERE id = $1`, [w.a.salesOrderId]))[0]!.number

  // The office people: one made-up role, each person's reach in their assignment (every customer, Alpha only, Beta only).
  const roleId = newId()
  await admin(`INSERT INTO "Role" (id, "tenantId", key, name, audience, permissions) VALUES ($1, $2, 'custom.sa051_bell', 'Made-up sales and production office', 'OFFICE', $3)`, [roleId, w.tenantId, PERMISSIONS])
  for (const person of Object.keys(PEOPLE) as Person[]) {
    const parties = REACH[person] === 'all' ? [] : [REACH[person] === 'a' ? w.a.partyId : w.b.partyId]
    await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, $5)', [PEOPLE[person], w.tenantId, `sa051-${person.toLowerCase()}@example.com`, `Made-up ${person}`, 'ACTIVE'])
    await admin('INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "partyIds", "validFrom") VALUES ($1, $2, $3, $4, true, $5, $6)', [newId(), w.tenantId, PEOPLE[person], roleId, parties, new Date('2026-01-01T00:00:00.000Z')])
  }

  // Who follows what: Alpha's order — who will make the change, its supervisor (ASSIGNEE: he follows by himself), a muted follower,
  // the person limited to Alpha, and one limited to Beta (a follow kept from before the limit); Alpha's work order — its supervisor and
  // the Beta-limited person; the mixed work order — the factory and the Alpha-limited person; Beta's work order — the factory. The
  // customer's backup follows nothing (he does not follow by himself).
  for (const person of ['actor', 'alphaRep', 'betaRep'] as const) await follow(person, 'SalesOrder', w.a.salesOrderId)
  await follow('supervisor', 'SalesOrder', w.a.salesOrderId, { reason: 'ASSIGNEE' })
  await follow('muted', 'SalesOrder', w.a.salesOrderId, { muted: true })
  await follow('supervisor', 'WorkOrder', w.a.workOrderId, { reason: 'ASSIGNEE' })
  await follow('betaRep', 'WorkOrder', w.a.workOrderId)
  await follow('factory', 'WorkOrder', w.mixed.workOrderId)
  await follow('alphaRep', 'WorkOrder', w.mixed.workOrderId)
  await follow('factory', 'WorkOrder', w.b.workOrderId)
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('B-SA-051: ONE bell item per change of an order, never to who made it', { timeout: 60_000 }, () => {
  const accepted = `sa051-accept-${newId()}`
  let eventIds: string[] = []

  it('an accepted change — its system line, its floor note and the order’s promise move — is ONE item for each reader', async () => {
    await writeNotes(accepted, [
      { type: 'SalesOrder', id: w.a.salesOrderId, body: 'Change accepted · Made-up actor · 10:42\nBrand Alpha asked (portal, 10:05): line 1 · 50 2 → 1.', change: { causedById: PEOPLE.actor, orderId: w.a.salesOrderId, stillToDo: 2 } },
      { type: 'WorkOrder', id: w.a.workOrderId, body: `Order change on ${w.a.workOrderNumber}: size 50 now 1 (was 2).\nAsk your lead.`, forFloor: true, change: { causedById: PEOPLE.actor, orderId: w.a.salesOrderId } },
    ])
    eventIds = await fanOutChange(accepted, [await promiseMoved(accepted, w.a.salesOrderId, w.a.partyId, 'actor')])
    const group = batchGroupKey(orderChangeBatch(accepted, w.a.salesOrderId), 'FOLLOWING')

    // The supervisor follows the order and its work order: three rows, one item — the order's face, the work order's, the move.
    const supervisor = await bellOf('supervisor', eventIds)
    expect(supervisor.map((row) => row.messageKey).sort()).toEqual(['notifications.following.changeSteps', 'notifications.following.changed', 'notifications.following.orderChange'])
    expect(itemsOf(supervisor)).toBe(1)
    expect(supervisor.every((row) => row.groupKey === group && row.category === 'FOLLOWING' && row.actorId === PEOPLE.actor)).toBe(true)
    expect(supervisor.find((row) => row.messageKey === 'notifications.following.changeSteps')).toMatchObject({ recordType: 'SalesOrder', recordId: w.a.salesOrderId, recordLabel: alphaOrderNumber, params: { what: 'Change accepted · Made-up actor · 10:42', count: 2, actorId: PEOPLE.actor } })
    expect(supervisor.find((row) => row.messageKey === 'notifications.following.orderChange')).toMatchObject({ recordType: 'WorkOrder', recordId: w.a.workOrderId, recordLabel: w.a.workOrderNumber, params: { what: `Order change on ${w.a.workOrderNumber}: size 50 now 1 (was 2)`, number: alphaOrderNumber } })

    // The person limited to Alpha follows the order only: its line and its move, one item.
    const alpha = await bellOf('alphaRep', eventIds)
    expect(alpha.map((row) => row.recordType)).toEqual(['SalesOrder', 'SalesOrder'])
    expect(itemsOf(alpha)).toBe(1)
    expect(alpha[0]!.groupKey).toBe(group)
  })

  it('tells nobody who made it, nor a muted follower, nor a person limited to Beta, nor the backup who follows nothing', async () => {
    for (const person of ['actor', 'muted', 'betaRep', 'backup', 'factory'] as const) expect(await bellOf(person, eventIds), person).toEqual([])
  })

  it('the event names who made it, the order and the steps still to do — none of them on a screen', async () => {
    const rows = await admin(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'thread.message_posted' AND "correlationId" = $2 ORDER BY "occurredAt", id`, [w.tenantId, accepted])
    expect(rows.map((row) => row.payload)).toEqual([
      expect.objectContaining({ recordType: 'SalesOrder', recordId: w.a.salesOrderId, causedById: PEOPLE.actor, orderId: w.a.salesOrderId, stillToDo: 2, partyId: w.a.partyId }),
      expect.objectContaining({ recordType: 'WorkOrder', recordId: w.a.workOrderId, causedById: PEOPLE.actor, orderId: w.a.salesOrderId, partyId: w.a.partyId }),
    ])
    expect(rows[1]!.payload).not.toHaveProperty('stillToDo')
    const definition = EVENT_CATALOGUE.get('thread.message_posted', 1)
    for (const row of rows) {
      const envelope = { eventId: newId(), type: definition.type, version: 1, context: 'threads', tenantId: w.tenantId, companyId: w.companyId, siteId: null, subject: 'x', correlationId: accepted, causationId: null, source: 'test', occurredAt: new Date().toISOString(), payload: row.payload }
      const fields = liveMessageFor(envelope, definition)!.fields
      for (const key of ['causedById', 'orderId', 'stillToDo', 'partyId']) expect(fields).not.toHaveProperty(key)
    }
  })

  it('a refusal tells the order’s followers but who refused; a withdrawal (nobody of the office) tells them all; the backup once he follows', async () => {
    await follow('backup', 'SalesOrder', w.a.salesOrderId)
    const refused = `sa051-refuse-${newId()}`
    await writeNotes(refused, [{ type: 'SalesOrder', id: w.a.salesOrderId, body: "Refused · Made-up supervisor · 11:05 — 'We cannot change sizes after cutting.'", change: { causedById: PEOPLE.supervisor, orderId: w.a.salesOrderId } }])
    const refusedIds = await fanOutChange(refused)
    expect(await bellOf('supervisor', refusedIds)).toEqual([])
    for (const person of ['actor', 'backup', 'alphaRep'] as const) {
      expect(await bellOf(person, refusedIds), person).toEqual([expect.objectContaining({ messageKey: 'notifications.following.change', actorId: PEOPLE.supervisor, groupKey: batchGroupKey(orderChangeBatch(refused, w.a.salesOrderId), 'FOLLOWING'), params: expect.objectContaining({ what: "Refused · Made-up supervisor · 11:05 — 'We cannot change sizes after cutting.'" }) })])
    }

    const withdrawn = `sa051-withdraw-${newId()}`
    await writeNotes(withdrawn, [{ type: 'SalesOrder', id: w.a.salesOrderId, body: 'Withdrawn by Brand Alpha · 11:20', change: { causedById: null, orderId: w.a.salesOrderId, stillToDo: 1 } }])
    const withdrawnIds = await fanOutChange(withdrawn)
    for (const person of ['actor', 'supervisor', 'backup', 'alphaRep'] as const) {
      expect(await bellOf(person, withdrawnIds), person).toEqual([expect.objectContaining({ messageKey: 'notifications.following.changeStep', actorId: null, params: expect.objectContaining({ what: 'Withdrawn by Brand Alpha · 11:20', actorId: null }) })])
    }
    for (const person of ['muted', 'betaRep', 'factory'] as const) expect(await bellOf(person, withdrawnIds), person).toEqual([])
  })

  it('a mixed work order’s floor note reaches only people of every customer, and names the order to them', async () => {
    const mixed = `sa051-mixed-${newId()}`
    await writeNotes(mixed, [{ type: 'WorkOrder', id: w.mixed.workOrderId, body: 'Order change on a work order: size 50 now 1 (was 2).', forFloor: true, change: { causedById: PEOPLE.actor, orderId: w.a.salesOrderId } }])
    const mixedIds = await fanOutChange(mixed)
    expect(await bellOf('factory', mixedIds)).toEqual([expect.objectContaining({ messageKey: 'notifications.following.orderChange', recordId: w.mixed.workOrderId, params: expect.objectContaining({ number: alphaOrderNumber }), groupKey: batchGroupKey(orderChangeBatch(mixed, w.a.salesOrderId), 'FOLLOWING') })])
    expect(await bellOf('alphaRep', mixedIds)).toEqual([])
  })

  it('a work order’s face never names another customer’s order: a note naming one by mistake reads as the work order’s own change', async () => {
    const wrong = `sa051-wrong-${newId()}`
    await writeNotes(wrong, [{ type: 'WorkOrder', id: w.b.workOrderId, body: 'Order change: size 50 now 1 (was 2).', forFloor: true, change: { causedById: PEOPLE.actor, orderId: w.a.salesOrderId } }])
    const wrongIds = await fanOutChange(wrong)
    const [row, ...more] = await bellOf('factory', wrongIds)
    expect(more).toEqual([])
    expect(row).toMatchObject({ messageKey: 'notifications.following.change', recordType: 'WorkOrder', recordId: w.b.workOrderId, params: { what: 'Order change: size 50 now 1 (was 2)' } })
    expect(row!.params).not.toHaveProperty('number')
    // Neither Alpha's order number nor its id reaches the row (its group either).
    expect(JSON.stringify(row)).not.toContain(alphaOrderNumber)
    expect(JSON.stringify(row)).not.toContain(w.a.salesOrderId)
  })

  it('a person’s own note and any other system note keep their words and their batch', async () => {
    const plain = `sa051-plain-${newId()}`
    await writeNotes(plain, [{ type: 'SalesOrder', id: w.a.salesOrderId, body: 'Made-up system note of another kind.' }])
    const plainIds = await fanOutChange(plain)
    const [row] = await bellOf('supervisor', plainIds)
    expect(row).toMatchObject({ messageKey: 'notifications.following.note', actorId: null })
    expect(row!.params).not.toHaveProperty('what')
    const [event] = await admin(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'thread.message_posted' AND "correlationId" = $2`, [w.tenantId, plain])
    for (const key of ['causedById', 'orderId', 'stillToDo']) expect(event!.payload).not.toHaveProperty(key)
  })

  it('writes a change note only as the system’s internal note, on its own order’s thread or a work order’s', async () => {
    const refusedWith = async (note: Note, author: MessageInput['author'] = { kind: 'SYSTEM', id: null, name: null }) => {
      let refused: unknown = null
      try {
        await command(callerFor(database, systemContext(w.tenantId, `sa051-bad-${newId()}`)), { name: 'test.changeNotes', input: { bad: true } }, async (tools) => {
          const { thread } = await ensureThread(tools, { type: note.type, id: note.id }, null)
          await writeMessage(tools, thread, { direction: 'INTERNAL_NOTE', channel: 'APP', author, bodyText: note.body, ...(note.change ? { change: note.change } : {}) })
          return null
        })
      } catch (error) {
        refused = error
      }
      return refused
    }
    const change = { causedById: PEOPLE.actor, orderId: w.a.salesOrderId }
    // A person's note is no change note; another order's id on an order's thread; a count that is no count.
    expect(await refusedWith({ type: 'SalesOrder', id: w.a.salesOrderId, body: 'x', change }, { kind: 'USER', id: PEOPLE.actor, name: 'Made-up actor' })).toMatchObject({ message: expect.stringMatching(/change note/) })
    expect(await refusedWith({ type: 'SalesOrder', id: w.b.salesOrderId, body: 'x', change })).toMatchObject({ message: expect.stringMatching(/change note/) })
    expect(await refusedWith({ type: 'SalesOrder', id: w.a.salesOrderId, body: 'x', change: { ...change, stillToDo: -1 } })).toMatchObject({ message: expect.stringMatching(/change note/) })
    expect(await admin(`SELECT 1 FROM "Message" WHERE "bodyText" = 'x'`)).toEqual([])
  })
})
