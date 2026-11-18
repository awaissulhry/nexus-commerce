import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { callerFor, type CommandCaller } from '../../core/command'
import { testAuthenticator } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { findMarkers, markersOf, productionTwoBrands, supervisorPeople, supervisorPeopleIds, twoBrandIds, twoBrandSessions, type Marker, type ProductionTwoBrands } from '../../modules/production/testing/two-brands'
import { systemContext } from '../outbox/system'
import { fanOut, fanOutEvents } from './fan-out'
import { BRAND_PRODUCTION_RULES } from './rules/brand-production'
import { FAN_OUT_RULES } from './rules'

/**
 * B-PR-32 — the factory is told of every customer action on its production (production plan §1 "Full control", §3, §6 slice 3; lead
 * picks L15, L21; review fixes R-43, R-51, R-60; Appendix C "a TOP refusal tells the office") and its wall tests PW-04 (the office
 * bell: a person limited to brand B receives nothing of A's acts), PW-09 (alerts and the bell) and PW-14 (a notice reaches a
 * supervisor or backup only while he reads that order's customer, re-checked at the fan-out). The Owner rule 2026-11-16: "One brand
 * must not be able to see anything related to any other brand. But we, as the production unit, should be able to see it all. And
 * manage it all as well."
 *
 * On a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security is real), the core, files,
 * production and numbering seeds, the production two-brand harness (brand A = the seeds' P1 with SEED-SO-0002 and its new order, both
 * Urgent; brand B = the threads' second brand with SEED-SO-B001) and its supervisor people (REAL users with live roles: supervisorA
 * limited to A, backupA over every customer, officeB and plannerB limited to B, noThread without threads.read, inactive SUSPENDED).
 * A's supervisor and backup are set through B-PR-42a's real route. The customer's acts are the events their commands emit, written
 * here with the requests and approvals they name (made-up rows, the database's rules off for them as a partner's command would not
 * be in this harness); the fan-out runs in-process as the system, as the worker does.
 *
 *   - urgency: the customer's own mark (one event per command and customer: a bulk mark is ONE bell item per person, one group of
 *     the batch), back to Regular, a new order of its list, an undo; ours tell nobody here; each supervisor counts only his orders;
 *   - asks: one order (while it waits; one with a batchId skipped); a batch told ONCE on batch_asked; a batch's Undo told once;
 *   - our counter-offer answered; a production approval answered; a refused TOP; a refused new date, not to the person its follow-up
 *     task told; development samples, counter-offers' approvals and a new date accepted tell nothing;
 *   - PW-04 / PW-09 / PW-14: a customer with no supervisor → the holders of production.brand.manage who read it (never a person
 *     limited to the other customer); an event naming another customer's order tells nothing; a read taken away is re-checked at the
 *     fan-out; nothing B's people receive carries anything of A.
 *
 * The tests run in order on one database (each builds on the state the one before left). Every name is made up. Run with
 * `env -u FACTORY_REDIS_URL node scripts/factory/run-pg-tests.mjs platform/notifications/brand-notices`.
 */

const ns = 'pr3n-brand-notices'
const ids = twoBrandIds(ns)
const people = supervisorPeopleIds(ns)
const PERMISSIONS: Permission[] = ['workorders.view', 'workorders.manage', 'production.brand.manage', 'threads.read']
const SESSIONS = twoBrandSessions(ids.tenantId, ids.a, ids.b, PERMISSIONS)

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let w: ProductionTwoBrands
let system: CommandCaller
let names: { readonly a: string; readonly b: string }
let numbers: { readonly so2: string; readonly aNew: string; readonly b: string }
let aMarkers: Marker[]

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T | undefined> => (await admin<T>(sql, values))[0]

async function ok(session: string, method: 'PUT' | 'POST', url: string, payload: unknown): Promise<Json> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session, 'idempotency-key': newId() }, payload: payload as object })
  expect(response.statusCode, `${method} ${url}: ${response.body.slice(0, 600)}`).toBe(200)
  return response.json() as Json
}
const settingsVersion = async (partyId: string) => (await one<{ version: number }>(`SELECT version FROM "PortalSettings" WHERE "partyId" = $1`, [partyId]))?.version ?? 0

/** Rows a partner's command would write, the database's rules off for the statements (the harness has no portal session here). */
async function replica(statements: readonly { readonly sql: string; readonly values?: unknown[] }[]): Promise<void> {
  await db.admin.query('BEGIN')
  try {
    await db.admin.query('SET LOCAL session_replication_role = replica')
    for (const statement of statements) await db.admin.query(statement.sql, statement.values ?? [])
    await db.admin.query('COMMIT')
  } catch (error) {
    await db.admin.query('ROLLBACK')
    throw error
  }
}

/** A made-up event as the relay hands it over (its id new: the fan-out keys its command by it). */
const eventOf = (type: string, payload: Json): EventEnvelope => ({ eventId: newId(), type, version: 1, context: type.split('.')[0]!, tenantId: ids.tenantId, companyId: w.companyId, siteId: null, subject: newId(), correlationId: newId(), causationId: null, source: 'factory-api', occurredAt: new Date().toISOString(), payload }) as unknown as EventEnvelope

const urgencyEvent = (partyId: string, orderIds: readonly string[], over: Json = {}) =>
  eventOf('brand_production.urgency_changed', { partyId, orderIds: [...orderIds], urgency: 'URGENT', by: 'BRAND', change: 'MARK', locked: false, undo: false, asked: false, batchId: newId(), ...over })

interface Told {
  readonly userId: string
  readonly category: string
  readonly messageKey: string
  readonly params: Json
  readonly recordType: string
  readonly recordId: string
  readonly recordLabel: string
  readonly companyId: string | null
  readonly actorId: string | null
  readonly groupKey: string | null
}
/** The notifications one event made, by person. */
const told = (eventId: string) =>
  admin<Told>(
    `SELECT "userId", category::text AS category, "messageKey", params, "recordType", "recordId", "recordLabel", "companyId", "actorId", "groupKey" FROM "Notification" WHERE "tenantId" = $1 AND "eventId" = $2 ORDER BY "userId"`,
    [ids.tenantId, eventId],
  )
/** Fans one event out and answers who was told. */
async function tell(event: EventEnvelope): Promise<Told[]> {
  await fanOut(system, event)
  return told(event.eventId)
}
const whoOf = (rows: readonly Told[]) => rows.map((row) => row.userId).sort()

/** Who of the test's people a step must never reach (PW-04, PW-14). */
const outsideA = () => [people.officeB, people.plannerB, people.noThread, people.inactive]

/** A made-up request of a customer's order (OPEN unless said), written as the partner's command would. */
async function request(input: { readonly orderId: string; readonly partyId: string; readonly kind: string; readonly batchId?: string | null; readonly status?: string }): Promise<string> {
  const id = newId()
  await replica([
    {
      sql: `INSERT INTO "OrderChangeRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, status, reason, "batchId") VALUES ($1, $2, $3, $4, $5, $6::"OrderChangeRequestKind", $7::"OrderChangeRequestStatus", 'Made-up: as the customer wrote it', $8)`,
      values: [id, ids.tenantId, w.companyId, input.partyId, input.orderId, input.kind, input.status ?? 'OPEN', input.batchId ?? null],
    },
  ])
  return id
}

/** A made-up answered approval request of a customer (the answer as its link or portal wrote it). */
async function answered(input: { readonly recordType: string; readonly recordId: string; readonly partyId: string; readonly kind: string; readonly status: string }): Promise<string> {
  const id = newId()
  await replica([
    {
      sql: `INSERT INTO "ApprovalRequest" (id, "tenantId", "companyId", "recordType", "recordId", "partyId", kind, question, "dueAt", status, answer, "typedName", "answeredAt", "createdAt", "updatedAt")
            VALUES ($1, $2, $3, $4, $5, $6, $7::"ApprovalKind", 'Made-up: is it right?', now() + interval '5 days', $8::"ApprovalStatus", 'Made-up: our words', 'Made-up Signer', now(), now(), now())`,
      values: [id, ids.tenantId, w.companyId, input.recordType, input.recordId, input.partyId, input.kind, input.status],
    },
  ])
  return id
}
const answeredEvent = (requestId: string, input: { readonly recordType: string; readonly recordId: string; readonly partyId: string; readonly kind: string; readonly status: string }) =>
  eventOf('approval_request.answered', { requestId, kind: input.kind, recordType: input.recordType, recordId: input.recordId, partyId: input.partyId, status: input.status, via: 'PORTAL', markedUp: false })

/** A made-up sample round of a customer, of our own style (its revision 1). */
async function sampleRound(partyId: string, kind: string): Promise<{ readonly id: string; readonly number: string }> {
  const id = newId()
  const number = `T-PR32-SMP-${id.slice(-6)}`
  const revision = (await one<{ id: string }>(`SELECT id FROM "StyleRevision" WHERE "styleId" = $1 ORDER BY id LIMIT 1`, [w.styleId]))!.id
  await replica([
    {
      sql: `INSERT INTO "SampleRound" (id, "tenantId", "companyId", number, "styleId", "revisionId", kind, "partyId", cells, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7::"SampleKind", $8, '[]'::jsonb, now(), now())`,
      values: [id, ids.tenantId, w.companyId, number, w.styleId, revision, kind, partyId],
    },
  ])
  return { id, number }
}

/** A person's live read of every customer narrowed to one (his role assignment's parties), and back. */
const assignmentOf = (key: 'supervisorA' | 'backupA') => `ffffffff${seedUuid(ns, `two-brands:supervisor-people:assignment:${key}`).slice(8)}`
async function limitedTo<T>(keys: readonly ('supervisorA' | 'backupA')[], partyId: string, run: () => Promise<T>): Promise<T> {
  const before = new Map<string, string[]>()
  for (const key of keys) before.set(key, (await one<{ parties: string[] }>(`SELECT "partyIds"::text[] AS parties FROM "RoleAssignment" WHERE id = $1`, [assignmentOf(key)]))!.parties)
  for (const key of keys) await admin(`UPDATE "RoleAssignment" SET "partyIds" = $2::uuid[] WHERE id = $1`, [assignmentOf(key), [partyId]])
  try {
    return await run()
  } finally {
    for (const key of keys) await admin(`UPDATE "RoleAssignment" SET "partyIds" = $2::uuid[] WHERE id = $1`, [assignmentOf(key), before.get(key) ?? []])
  }
}

beforeAll(async () => {
  db = await migratedDatabase('pr3n_brand_notices')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  await seedFiles({ db: database, namespace: ns })
  await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session']) as keyof typeof SESSIONS] ?? null) },
  )
  w = await productionTwoBrands({ db, database, app, namespace: ns })
  expect(await supervisorPeople({ database, namespace: ns }, w)).toEqual(people)
  system = callerFor(database, systemContext(ids.tenantId, newId()))
  const nameOf = async (partyId: string) => (await one<{ name: string }>(`SELECT coalesce("tradeName", "legalName") AS name FROM "Party" WHERE id = $1`, [partyId]))!.name
  const numberOf = async (orderId: string) => (await one<{ number: string }>(`SELECT number FROM "SalesOrder" WHERE id = $1`, [orderId]))!.number
  names = { a: await nameOf(ids.a), b: await nameOf(ids.b) }
  numbers = { so2: await numberOf(w.production.urgent[0]), aNew: await numberOf(w.production.urgent[1]), b: await numberOf(w.b.salesOrderId) }
  expect(numbers.so2 < numbers.aNew).toBe(true)
  aMarkers = await markersOf(db, ids.a)
  // A's supervisor and backup, through B-PR-42a's real route.
  await ok('office.all', 'PUT', `/production/brands/${ids.a}/supervisor`, { supervisorId: people.supervisorA, backupId: people.backupA, version: await settingsVersion(ids.a) })
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('B-PR-32 the rule', () => {
  it('is registered once, on the customer’s acts', () => {
    expect(FAN_OUT_RULES.filter((rule) => BRAND_PRODUCTION_RULES.includes(rule))).toHaveLength(BRAND_PRODUCTION_RULES.length)
    for (const type of ['brand_production.urgency_changed', 'order_change_request.asked', 'order_change_request.batch_asked', 'order_change_request.withdrawn', 'order_change_request.counter_answered', 'approval_request.answered']) expect(fanOutEvents(), type).toContain(type)
  })
})

describe('B-PR-32 the customer’s urgency (one event per command and customer)', { timeout: 120_000 }, () => {
  it('a bulk mark: ONE item per person — the supervisor and the backup — over the orders, one bell group of the batch; FOLLOWING; nobody of B', async () => {
    const [so2, aNew] = w.production.urgent
    const event = urgencyEvent(ids.a, [aNew, so2])
    const rows = await tell(event)
    expect(whoOf(rows)).toEqual([people.supervisorA, people.backupA].sort())
    const batchId = (event.payload as Json).batchId as string
    for (const row of rows) {
      expect(row).toMatchObject({ category: 'FOLLOWING', messageKey: 'notifications.production.customerUrgentMany', recordType: 'SalesOrder', recordId: so2, recordLabel: numbers.so2, companyId: w.companyId, actorId: null, groupKey: `batch:${batchId}:FOLLOWING` })
      expect(row.params).toEqual({ customer: names.a, count: 2 })
    }
    // One order: its own words; back to Regular, a new order of its list, an undo — each its own.
    expect((await tell(urgencyEvent(ids.a, [aNew])))[0]).toMatchObject({ messageKey: 'notifications.production.customerUrgent', recordId: aNew, params: { customer: names.a, count: 1 } })
    expect((await tell(urgencyEvent(ids.a, [so2], { urgency: 'REGULAR' })))[0]?.messageKey).toBe('notifications.production.customerRegular')
    expect((await tell(urgencyEvent(ids.a, [so2, aNew], { change: 'ORDER' })))[0]?.messageKey).toBe('notifications.production.customerReordered')
    expect((await tell(urgencyEvent(ids.a, [so2, aNew], { undo: true, urgency: 'REGULAR' })))[0]?.messageKey).toBe('notifications.production.customerUndidMany')
  })

  it('ours tell nobody here: set back, locked, unlocked, our mark, our yes to its "Urgent – asked"', async () => {
    const [so2] = w.production.urgent
    for (const over of [{ by: 'FACTORY', change: 'SET_BACK', urgency: 'REGULAR' }, { by: 'FACTORY', change: 'LOCK', urgency: 'REGULAR', locked: true }, { by: 'FACTORY', change: 'UNLOCK', urgency: 'REGULAR' }, { by: 'FACTORY', change: 'MARK' }, { by: 'FACTORY', change: 'MARK', asked: true }]) {
      expect(await tell(urgencyEvent(ids.a, [so2], over)), JSON.stringify(over)).toEqual([])
    }
  })

  it('each supervisor counts only the orders he supervises: an order’s own supervisor beside the customer’s default', async () => {
    const [so2, aNew] = w.production.urgent
    await ok('office.all', 'POST', '/production/orders/supervisor', { orderIds: [aNew], supervisorId: people.backupA })
    try {
      const rows = await tell(urgencyEvent(ids.a, [so2, aNew]))
      // supervisorA (the default) supervises SEED-SO-0002 only; backupA is aNew's own supervisor and the customer's backup: both.
      expect(rows.find((row) => row.userId === people.supervisorA)).toMatchObject({ messageKey: 'notifications.production.customerUrgent', recordId: so2, params: { count: 1 } })
      expect(rows.find((row) => row.userId === people.backupA)).toMatchObject({ messageKey: 'notifications.production.customerUrgentMany', recordId: so2, params: { count: 2 } })
      expect(rows).toHaveLength(2)
    } finally {
      await ok('office.all', 'POST', '/production/orders/supervisor', { orderIds: [aNew], supervisorId: null })
    }
  })
})

describe('B-PR-32 the customer’s asks: one order, one batch, an Undo, our counter-offer', { timeout: 120_000 }, () => {
  let hold: string
  let batchId: string
  let resumes: string[]

  it('an ask of one order: told while it waits (APPROVAL, "answer in Approvals"); one that carries a batchId is skipped; a forged one tells nothing', async () => {
    const [, aNew] = w.production.urgent
    hold = await request({ orderId: aNew, partyId: ids.a, kind: 'HOLD' })
    const payload = { requestId: hold, orderId: aNew, partyId: ids.a, kind: 'HOLD', lines: 0, wholeOrder: true }
    const rows = await tell(eventOf('order_change_request.asked', payload))
    expect(whoOf(rows)).toEqual([people.supervisorA, people.backupA].sort())
    for (const row of rows) expect(row).toMatchObject({ category: 'APPROVAL', messageKey: 'notifications.production.customerAskedHold', recordType: 'SalesOrder', recordId: aNew, params: { customer: names.a, count: 1 } })
    // R-51: a request of a batch is told by its batch_asked, never on its own.
    expect(await tell(eventOf('order_change_request.asked', { ...payload, batchId: newId() }))).toEqual([])
    // Named with the other customer, or no such request: nothing.
    expect(await tell(eventOf('order_change_request.asked', { ...payload, partyId: ids.b }))).toEqual([])
    expect(await tell(eventOf('order_change_request.asked', { ...payload, requestId: newId() }))).toEqual([])
  })

  it('a bulk ask: ONE notice per batch on batch_asked ("asks to resume 2 orders"), one bell group; its requests’ own asked tell nothing', async () => {
    const [so2, aNew] = w.production.urgent
    batchId = newId()
    resumes = [await request({ orderId: so2, partyId: ids.a, kind: 'RESUME', batchId }), await request({ orderId: aNew, partyId: ids.a, kind: 'RESUME', batchId })].sort()
    const rows = await tell(eventOf('order_change_request.batch_asked', { batchId, partyId: ids.a, kind: 'RESUME', count: 2 }))
    expect(whoOf(rows)).toEqual([people.supervisorA, people.backupA].sort())
    for (const row of rows) expect(row).toMatchObject({ category: 'APPROVAL', messageKey: 'notifications.production.customerAskedResumeMany', recordId: so2, params: { customer: names.a, count: 2 }, groupKey: `batch:${batchId}:APPROVAL` })
    for (const requestId of resumes) {
      const row = (await one<{ orderId: string }>(`SELECT "orderId" FROM "OrderChangeRequest" WHERE id = $1`, [requestId]))!
      expect(await tell(eventOf('order_change_request.asked', { requestId, orderId: row.orderId, partyId: ids.a, kind: 'RESUME', lines: 0, wholeOrder: true, batchId }))).toEqual([])
    }
    // Another customer's batch id, or another kind: nothing of A's batch.
    expect(await tell(eventOf('order_change_request.batch_asked', { batchId, partyId: ids.b, kind: 'RESUME', count: 2 }))).toEqual([])
    expect(await tell(eventOf('order_change_request.batch_asked', { batchId, partyId: ids.a, kind: 'HOLD', count: 2 }))).toEqual([])
  })

  it('a batch’s Undo (one withdrawn per request, no batchId) is told ONCE, by the first request; a withdrawal alone its own', async () => {
    const at = new Date('2026-11-18T09:00:00.000Z')
    await replica([{ sql: `UPDATE "OrderChangeRequest" SET status = 'WITHDRAWN', "withdrawnAt" = $2 WHERE id = ANY($1::uuid[])`, values: [resumes, at] }])
    const events: EventEnvelope[] = []
    for (const requestId of resumes) {
      const row = (await one<{ orderId: string }>(`SELECT "orderId" FROM "OrderChangeRequest" WHERE id = $1`, [requestId]))!
      events.push(eventOf('order_change_request.withdrawn', { requestId, orderId: row.orderId, partyId: ids.a, kind: 'RESUME' }))
    }
    const first = await tell(events[0]!)
    expect(whoOf(first)).toEqual([people.supervisorA, people.backupA].sort())
    for (const row of first) expect(row).toMatchObject({ category: 'APPROVAL', messageKey: 'notifications.production.customerWithdrewMany', params: { customer: names.a, count: 2 }, groupKey: `batch:${batchId}:APPROVAL` })
    expect(await tell(events[1]!)).toEqual([])

    const [, aNew] = w.production.urgent
    await replica([{ sql: `UPDATE "OrderChangeRequest" SET status = 'WITHDRAWN', "withdrawnAt" = now() WHERE id = $1`, values: [hold] }])
    const alone = await tell(eventOf('order_change_request.withdrawn', { requestId: hold, orderId: aNew, partyId: ids.a, kind: 'HOLD' }))
    expect(alone.map((row) => row.messageKey)).toEqual(['notifications.production.customerWithdrew', 'notifications.production.customerWithdrew'])
    for (const row of alone) expect(row.groupKey).not.toMatch(/^batch:/)
  })

  it('our counter-offer answered: its no is a decision, its yes waits for our accept', async () => {
    const [, aNew] = w.production.urgent
    const change = await request({ orderId: aNew, partyId: ids.a, kind: 'CHANGE', status: 'COUNTERED' })
    const payload = { requestId: change, orderId: aNew, partyId: ids.a, kind: 'CHANGE', answer: 'ACCEPTED' }
    const yes = await tell(eventOf('order_change_request.counter_answered', payload))
    expect(yes.map((row) => row.messageKey)).toEqual(['notifications.production.customerCounterAccepted', 'notifications.production.customerCounterAccepted'])
    const no = await tell(eventOf('order_change_request.counter_answered', { ...payload, answer: 'REFUSED' }))
    expect(no.map((row) => row.messageKey)).toEqual(['notifications.production.customerCounterRefused', 'notifications.production.customerCounterRefused'])
    for (const row of [...yes, ...no]) expect(row).toMatchObject({ category: 'APPROVAL', recordId: aNew, params: { customer: names.a, count: 1 } })
    expect(await tell(eventOf('order_change_request.counter_answered', { ...payload, partyId: ids.b }))).toEqual([])
  })
})

describe('B-PR-32 the customer’s production approvals answered', { timeout: 120_000 }, () => {
  it('a refused top of production tells the office (it gates nothing: quality decides) — the customer’s default and backup, on the round', async () => {
    const round = await sampleRound(ids.a, 'TOP_OF_PRODUCTION')
    const input = { recordType: 'SampleRound', recordId: round.id, partyId: ids.a, kind: 'SAMPLE', status: 'REFUSED' }
    const rows = await tell(answeredEvent(await answered(input), input))
    expect(whoOf(rows)).toEqual([people.supervisorA, people.backupA].sort())
    for (const row of rows) expect(row).toMatchObject({ category: 'APPROVAL', messageKey: 'notifications.production.customerRefusedTop', recordType: 'SampleRound', recordId: round.id, recordLabel: round.number, params: { customer: names.a }, actorId: null })
    // A PP sample approved, a size set approved with changes: their own words.
    const pp = await sampleRound(ids.a, 'PRE_PRODUCTION')
    const ppInput = { ...input, recordId: pp.id, status: 'APPROVED' }
    expect((await tell(answeredEvent(await answered(ppInput), ppInput)))[0]?.messageKey).toBe('notifications.production.customerApprovedSample')
    const sizeSet = await sampleRound(ids.a, 'SIZE_SET')
    const sizeInput = { ...input, recordId: sizeSet.id, status: 'APPROVED_WITH_CHANGES' }
    expect((await tell(answeredEvent(await answered(sizeInput), sizeInput)))[0]?.messageKey).toBe('notifications.production.customerApprovedSampleChanges')
  })

  it('a development sample, a new date accepted, a counter-offer’s approval, an answer named with the other customer: nothing', async () => {
    const proto = await sampleRound(ids.a, 'PROTO')
    const protoInput = { recordType: 'SampleRound', recordId: proto.id, partyId: ids.a, kind: 'SAMPLE', status: 'REFUSED' }
    expect(await tell(answeredEvent(await answered(protoInput), protoInput))).toEqual([])
    const [so2] = w.production.urgent
    const dateInput = { recordType: 'SalesOrder', recordId: so2, partyId: ids.a, kind: 'REPROMISE', status: 'APPROVED' }
    expect(await tell(answeredEvent(await answered(dateInput), dateInput))).toEqual([])
    const top = await sampleRound(ids.a, 'TOP_OF_PRODUCTION')
    const topInput = { recordType: 'SampleRound', recordId: top.id, partyId: ids.a, kind: 'SAMPLE', status: 'REFUSED' }
    const requestId = await answered(topInput)
    expect(await tell(answeredEvent(requestId, { ...topInput, partyId: ids.b }))).toEqual([])
    expect(await tell(answeredEvent(requestId, { ...topInput, status: 'APPROVED' }))).toEqual([])
  })

  it('a refused new date: not to the person its follow-up task told (B-PR-28: the task’s id is the request’s), to the backup', async () => {
    const [so2] = w.production.urgent
    const input = { recordType: 'SalesOrder', recordId: so2, partyId: ids.a, kind: 'REPROMISE', status: 'REFUSED' }
    const requestId = await answered(input)
    await replica([
      {
        sql: `INSERT INTO "Task" (id, "tenantId", "companyId", "partyId", title, "recordType", "recordId", "recordLabel", "assigneeId", "assignedById", "assignedAt", checklist, status, "createdAt", "updatedAt")
              VALUES ($1, $2, $3, $4, 'Made-up: the customer refused the new date', 'SalesOrder', $5, $6, $7, $7, now(), '[]'::jsonb, 'OPEN', now(), now())`,
        values: [requestId, ids.tenantId, w.companyId, ids.a, so2, numbers.so2, people.supervisorA],
      },
    ])
    const rows = await tell(answeredEvent(requestId, input))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ userId: people.backupA, category: 'APPROVAL', messageKey: 'notifications.production.customerRefusedNewDate', recordType: 'SalesOrder', recordId: so2, params: { customer: names.a } })
  })
})

describe('B-PR-32 the wall: PW-04, PW-09, PW-14', { timeout: 120_000 }, () => {
  it('a customer with no supervisor or backup: the holders of production.brand.manage who read it — never a person limited to the other customer', async () => {
    const rows = await tell(urgencyEvent(ids.b, [w.b.salesOrderId]))
    const who = whoOf(rows)
    expect(who).toEqual(expect.arrayContaining([people.officeB, people.plannerB, people.backupA]))
    for (const userId of [people.supervisorA, people.noThread, people.inactive]) expect(who, userId).not.toContain(userId)
    for (const row of rows) expect(row).toMatchObject({ messageKey: 'notifications.production.customerUrgent', recordId: w.b.salesOrderId, recordLabel: numbers.b, params: { customer: names.b, count: 1 } })
    expect(findMarkers(rows, aMarkers)).toEqual([])
    // B's supervisor named: only he is told (the managers are the fallback only).
    await ok('office.all', 'PUT', `/production/brands/${ids.b}/supervisor`, { supervisorId: people.officeB, backupId: null, version: await settingsVersion(ids.b) })
    expect(whoOf(await tell(urgencyEvent(ids.b, [w.b.salesOrderId])))).toEqual([people.officeB])
  })

  it('an event that names another customer’s order tells nothing of it, to anybody', async () => {
    const [so2, aNew] = w.production.urgent
    expect(await tell(urgencyEvent(ids.b, [so2, aNew]))).toEqual([])
    expect(await tell(urgencyEvent(ids.a, [w.b.salesOrderId]))).toEqual([])
    // Mixed: only the event's customer's own order is told.
    const mixed = await tell(urgencyEvent(ids.a, [w.b.salesOrderId, so2]))
    expect(whoOf(mixed)).toEqual([people.supervisorA, people.backupA].sort())
    for (const row of mixed) expect(row).toMatchObject({ recordId: so2, params: { count: 1 } })
  })

  it('PW-14: re-checked at the fan-out — the supervisor whose read of A was taken away is not told (the backup is); neither reading A: no test person is', async () => {
    const [so2] = w.production.urgent
    const withoutHim = await limitedTo(['supervisorA'], ids.b, () => tell(urgencyEvent(ids.a, [so2])))
    expect(whoOf(withoutHim)).toEqual([people.backupA])
    const neither = await limitedTo(['supervisorA', 'backupA'], ids.b, () => tell(urgencyEvent(ids.a, [so2])))
    for (const userId of [people.supervisorA, people.backupA, ...outsideA()]) expect(whoOf(neither), userId).not.toContain(userId)
    // His read back: he is told again.
    expect(whoOf(await tell(urgencyEvent(ids.a, [so2])))).toEqual([people.supervisorA, people.backupA].sort())
  })

  it('PW-04 / PW-09: everything a person limited to B was ever told of this suite names only B — none of A’s orders, rounds, names or ids', async () => {
    const rows = await admin<Told>(
      `SELECT "userId", category::text AS category, "messageKey", params, "recordType", "recordId", "recordLabel", "companyId", "actorId", "groupKey" FROM "Notification" WHERE "tenantId" = $1 AND "userId" = ANY($2::uuid[]) AND "messageKey" LIKE 'notifications.production.customer%'`,
      [ids.tenantId, [people.officeB, people.plannerB]],
    )
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row, JSON.stringify(row)).toMatchObject({ recordId: w.b.salesOrderId, params: { customer: names.b } })
    expect(findMarkers(rows, aMarkers)).toEqual([])
  })
})
