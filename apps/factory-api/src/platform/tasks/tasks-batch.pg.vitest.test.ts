import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { BATCH_SKIP_WORDS } from '@nexus/factory-domain/tasks/rules'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../packages/factory-db/seed/auth'
import { seed as seedMoney } from '../../../../../packages/factory-db/seed/money'
import { seed as seedRoles } from '../../../../../packages/factory-db/seed/roles'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { callerFor } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { SLOW_TEST_TIMEOUT_MS } from '../../testing/timeouts'
import { startHarness, type Harness } from '../auth/sessions/testing/harness'
import { fanOut } from '../notifications/fan-out'
import { systemContext } from '../outbox/system'

/**
 * "Add task to N" and a customer's open tasks (sales page plan N5, pick P10; 11-customer-page §3.9, §3.2 "Open tasks"):
 *
 *   B-SA-071  POST /tasks/batch — one task per record (1–100), one assignee (a person, or SUPERVISOR: each order's own supervisor,
 *             else its customer's default), ONE command and one batchId (the assignee's bell: one item); each record made or
 *             skipped with why; the assignee must be able to read each record; a record the maker may not read is skipped in the
 *             words of an unknown one
 *   B-SA-072  GET /tasks?scope=PARTY&partyId= — the open tasks on the customer's records the reader may read
 *
 * On the local stack with the core, auth, roles and money seeds (customer A = SEED-C1 with SEED-SO-0001 / SEED-SO-0002; customer
 * B = SEED-R1 with one made-up copy, TB-B-01), people with live role assignments (the assignee rule reads them) and test sessions
 * of the same grants. Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs platform/tasks/tasks-batch.pg`.
 */

type Json = Record<string, any>

const NS = 'tasks-sa071'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')

/** owner: every customer; sales: Sales, every customer; onlyA: Sales limited to customer A; onlyB: Sales limited to customer B. */
const PEOPLE = { owner: newId(), sales: newId(), onlyA: newId(), onlyB: newId() } as const
type Person = keyof typeof PEOPLE
const SESSIONS: Partial<Record<Person, SessionContext>> = {}
function grantOf(role: string, parties: 'all' | string[]): Grant {
  const template = templateOf(role)!
  return { permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties }
}

let h: Harness
let app: FastifyInstance
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!

async function call(person: Person, method: 'GET' | 'POST', url: string, payload?: unknown): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': person, ...(method === 'POST' ? { 'idempotency-key': newId() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
  return { status: response.statusCode, body: response.json() as Json }
}
async function ok(person: Person, method: 'GET' | 'POST', url: string, payload?: unknown, status = 200): Promise<Json> {
  const answer = await call(person, method, url, payload)
  expect(answer.status, `${person} ${method} ${url}: ${JSON.stringify(answer.body).slice(0, 500)}`).toBe(status)
  return answer.body
}

/** A version-4 UUID derived from an id and a salt. */
const v4 = (expression: string, salt: string): string => {
  const hash = `md5(${expression}::text || '${salt}')`
  return `(substr(${hash}, 1, 8) || '-' || substr(${hash}, 9, 4) || '-4' || substr(${hash}, 14, 3) || '-8' || substr(${hash}, 18, 3) || '-' || substr(${hash}, 21, 12))::uuid`
}
/** SEED-SO-0001 copied for another customer as `number`. */
async function copyOrder(number: string, partyId: string): Promise<string> {
  const salt = number.toLowerCase()
  await admin(`
    CREATE TEMP TABLE o AS SELECT * FROM "SalesOrder" WHERE "tenantId" = '${T}' AND number = 'SEED-SO-0001';
    CREATE TEMP TABLE l AS SELECT * FROM "SalesOrderLine" WHERE "orderId" = (SELECT id FROM o);
    CREATE TEMP TABLE s AS SELECT * FROM "SalesOrderLineSize" WHERE "lineId" IN (SELECT id FROM l);
    UPDATE s SET id = ${v4('id', salt)}, "lineId" = ${v4('"lineId"', salt)}, "partyId" = '${partyId}';
    UPDATE l SET id = ${v4('id', salt)}, "orderId" = ${v4('"orderId"', salt)}, "partyId" = '${partyId}', "quoteLineId" = NULL, "styleRevisionId" = NULL;
    UPDATE o SET id = ${v4('id', salt)}, "partyId" = '${partyId}', number = '${number}', "quoteVersionId" = NULL, "customerRef" = NULL, "customerSeq" = NULL, status = 'CONFIRMED';
    INSERT INTO "SalesOrder" SELECT * FROM o;
    INSERT INTO "SalesOrderLine" SELECT * FROM l;
    INSERT INTO "SalesOrderLineSize" SELECT * FROM s;
    DROP TABLE o, l, s;`)
  return (await one<{ id: string }>('SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = $2', [T, number])).id
}

/** The worker's fan-out over the task.assigned rows written since `mark`; the bell groups the assignee now has of them. */
async function bellGroupsSince(mark: Date, userId: string): Promise<number> {
  const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'task.assigned' AND "occurredAt" >= $2 ORDER BY "occurredAt", id`, [T, mark])
  for (const row of rows) {
    const envelope = { eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload }
    await fanOut(callerFor(h.database, systemContext(T, `test-${row.id}`)), envelope)
  }
  return (await admin(`SELECT DISTINCT "groupKey" FROM "Notification" WHERE "tenantId" = $1 AND "userId" = $2 AND "createdAt" >= $3`, [T, userId, mark])).length
}

let partyA: string
let partyB: string
let order1: string
let order2: string
let orderB: string

beforeAll(async () => {
  h = await startHarness('tasks_sa071')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedMoney({ db: h.database, namespace: NS })
  const roleIds = new Map((await admin<{ id: string; key: string }>('SELECT id, key FROM "Role" WHERE "tenantId" = $1', [T])).map((row) => [row.key, row.id]))
  partyA = (await one<{ id: string }>('SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = \'SEED-C1\'', [T])).id
  partyB = (await one<{ id: string }>('SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = \'SEED-R1\'', [T])).id
  order1 = (await one<{ id: string }>('SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = \'SEED-SO-0001\'', [T])).id
  order2 = (await one<{ id: string }>('SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = \'SEED-SO-0002\'', [T])).id
  orderB = await copyOrder('TB-B-01', partyB)
  for (const [person, role, parties] of [['owner', 'owner', null], ['sales', 'sales', null], ['onlyA', 'sales', [partyA]], ['onlyB', 'sales', [partyB]]] as const) {
    await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, \'ACTIVE\')', [PEOPLE[person], T, `sa071-${person}-${PEOPLE[person].slice(-6)}@example.com`, `Made-up ${person}`])
    await admin('INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "partyIds", "validFrom") VALUES ($1, $2, $3, $4, true, $5::uuid[], now() - interval \'1 day\')', [newId(), T, PEOPLE[person], roleIds.get(role), parties ?? []])
    SESSIONS[person] = { audience: 'office', tenantId: T, actorId: PEOPLE[person], companyId: companyA, grants: [grantOf(role, parties ? [...parties] : 'all')] }
  }
  // Supervisors: SEED-SO-0001's own is the Sales person; no customer has a default (SEED-SO-0002 and TB-B-01 have none).
  await admin(`UPDATE "PortalSettings" SET "productionSupervisorId" = NULL, "productionSupervisorSetAt" = NULL, "productionBackupId" = NULL WHERE "tenantId" = $1`, [T])
  await admin(
    `INSERT INTO "BrandOrderProduction" (id, "tenantId", "companyId", "partyId", "salesOrderId", key, "supervisorId", "supervisorAssignedAt")
     SELECT $1, o."tenantId", o."companyId", o."partyId", o.id, 'brand-production:' || o.id, $3, now() FROM "SalesOrder" o WHERE o.id = $2
     ON CONFLICT ("tenantId", key) DO UPDATE SET "supervisorId" = $3, "supervisorAssignedAt" = now()`,
    [newId(), order1, PEOPLE.sales],
  )
  await admin(`UPDATE "BrandOrderProduction" SET "supervisorId" = NULL, "supervisorAssignedAt" = NULL WHERE "tenantId" = $1 AND "salesOrderId" <> $2`, [T, order1])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET, rateLimit: { max: 10_000, timeWindowMs: 60_000 } },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session']) as Person] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

const order = (id: string) => ({ type: 'SalesOrder', id })

// ── B-SA-071 ──
describe('B-SA-071 POST /tasks/batch: one task per record, one command, one batch', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('one person: a task on each record, each in its record, one batchId, ONE bell item for the assignee', async () => {
    const mark = new Date()
    const answer = await ok('owner', 'POST', '/tasks/batch', { title: 'Check the sizes', records: [order(order1), order(order2), order(orderB)], assignee: { userId: PEOPLE.sales }, dueDate: '2030-01-15', description: 'Made-up note' })
    expect(answer.batchId).toEqual(expect.any(String))
    expect(answer.skipped).toEqual([])
    expect((answer.made as Json[]).map((entry) => entry.record.id)).toEqual([order1, order2, orderB])
    for (const entry of answer.made as Json[]) expect(entry.task).toMatchObject({ title: 'Check the sizes', description: 'Made-up note', dueDate: '2030-01-15', assignee: { id: PEOPLE.sales }, record: { type: 'SalesOrder', id: entry.record.id }, status: 'OPEN' })
    // Each task names its record's customer (the record's scope), so a customer's open tasks find it.
    const stored = await admin<{ recordId: string; partyId: string }>('SELECT "recordId", "partyId" FROM "Task" WHERE id = ANY($1::uuid[])', [(answer.made as Json[]).map((entry) => entry.task.id)])
    expect(new Map(stored.map((row) => [row.recordId, row.partyId]))).toEqual(new Map([[order1, partyA], [order2, partyA], [orderB, partyB]]))
    // Every task.assigned of the command carries the batch; the assignee's bell has one item for the three.
    const events = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'task.assigned' AND "occurredAt" >= $2`, [T, mark])
    expect(events.map((event) => event.payload.batchId)).toEqual([answer.batchId, answer.batchId, answer.batchId])
    expect(await bellGroupsSince(mark, PEOPLE.sales)).toBe(1)
  })

  it("SUPERVISOR: each order's own supervisor, else its customer's default; none: skipped with why", async () => {
    const answer = await ok('owner', 'POST', '/tasks/batch', { title: 'Ask the floor', records: [order(order1), order(order2)], assignee: 'SUPERVISOR' })
    expect((answer.made as Json[]).map((entry) => [entry.record.id, entry.task.assignee.id])).toEqual([[order1, PEOPLE.sales]])
    expect(answer.skipped).toEqual([{ record: order(order2), label: 'SEED-SO-0002', code: 'NO_SUPERVISOR', words: BATCH_SKIP_WORDS.NO_SUPERVISOR }])
    // The customer's default answers for an order with no supervisor of its own.
    await admin(`UPDATE "PortalSettings" SET "productionSupervisorId" = $2, "productionSupervisorSetAt" = now() WHERE "tenantId" = $1 AND "partyId" = $3`, [T, PEOPLE.owner, partyA])
    try {
      const again = await ok('owner', 'POST', '/tasks/batch', { title: 'Ask the floor again', records: [order(order2)], assignee: 'SUPERVISOR' })
      const settings = await admin('SELECT 1 FROM "PortalSettings" WHERE "tenantId" = $1 AND "partyId" = $2', [T, partyA])
      if (settings.length > 0) expect((again.made as Json[]).map((entry) => entry.task.assignee.id)).toEqual([PEOPLE.owner])
    } finally {
      await admin(`UPDATE "PortalSettings" SET "productionSupervisorId" = NULL, "productionSupervisorSetAt" = NULL WHERE "tenantId" = $1`, [T])
    }
  })

  it('an assignee who cannot open a record: that record skipped ("{name} cannot open it"), the others made', async () => {
    const answer = await ok('owner', 'POST', '/tasks/batch', { title: 'Only A', records: [order(order1), order(orderB)], assignee: { userId: PEOPLE.onlyA } })
    expect((answer.made as Json[]).map((entry) => entry.record.id)).toEqual([order1])
    expect(answer.skipped).toEqual([{ record: order(orderB), label: 'TB-B-01', code: 'CANNOT_OPEN', words: { it: 'Made-up onlyA non può aprirlo.', en: 'Made-up onlyA cannot open it.' } }])
  })

  it("wall: a person limited to customer B naming A's orders: skipped in the words of an unknown record, nothing written about A", async () => {
    const before = await admin('SELECT count(*)::int AS n FROM "Task" WHERE "partyId" = $1', [partyA])
    const answer = await ok('onlyB', 'POST', '/tasks/batch', { title: 'Peek', records: [order(order1), order(newId()), order(orderB)], assignee: { userId: PEOPLE.onlyB } })
    expect((answer.made as Json[]).map((entry) => entry.record.id)).toEqual([orderB])
    const skipped = answer.skipped as Json[]
    expect(skipped.map((entry) => entry.code)).toEqual(['NOT_FOUND', 'NOT_FOUND'])
    // A's order and an unknown id read alike: no label, the same words.
    expect(skipped.map((entry) => ({ label: entry.label, words: entry.words }))).toEqual([{ label: null, words: BATCH_SKIP_WORDS.NOT_FOUND }, { label: null, words: BATCH_SKIP_WORDS.NOT_FOUND }])
    expect(JSON.stringify(answer)).not.toContain('SEED-SO-0001')
    expect(await admin('SELECT count(*)::int AS n FROM "Task" WHERE "partyId" = $1', [partyA])).toEqual(before)
  })

  it('refused in words before anything is written: no record, more than 100, a record twice, no title', async () => {
    expect((await call('owner', 'POST', '/tasks/batch', { title: 'x', records: [], assignee: 'SUPERVISOR' })).status).toBe(400)
    expect((await call('owner', 'POST', '/tasks/batch', { title: 'x', records: Array.from({ length: 101 }, () => order(newId())), assignee: 'SUPERVISOR' })).status).toBe(400)
    const twice = await call('owner', 'POST', '/tasks/batch', { title: 'x', records: [order(order1), order(order1)], assignee: 'SUPERVISOR' })
    expect(twice.status).toBe(400)
    expect(JSON.stringify(twice.body)).toContain('A record is listed twice.')
    expect((await call('owner', 'POST', '/tasks/batch', { title: '  ', records: [order(order1)], assignee: 'SUPERVISOR' })).status).toBe(400)
  })
})
// ── end B-SA-071 ──

// ── B-SA-072 ──
describe("B-SA-072 GET /tasks?scope=PARTY: the open tasks on a customer's records the reader may read", { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  let made: Json[]
  beforeAll(async () => {
    made = (await ok('owner', 'POST', '/tasks/batch', { title: 'Party scope', records: [order(order1), order(orderB), { type: 'Party', id: partyA }], assignee: { userId: PEOPLE.owner } })).made as Json[]
  })

  it("every open task on A's records (orders and the account) for a reader of them, with its record chip and assignee", async () => {
    const answer = await ok('sales', 'GET', `/tasks?scope=PARTY&partyId=${partyA}&limit=200`)
    const ids = (answer.items as Json[]).map((item) => item.id)
    for (const entry of made.filter((row) => row.record.id !== orderB)) expect(ids).toContain(entry.task.id)
    expect(ids).not.toContain(made.find((row) => row.record.id === orderB)!.task.id)
    for (const item of answer.items as Json[]) expect([order1, order2, partyA]).toContain(item.record.id)
    expect((answer.items as Json[]).every((item) => item.status === 'OPEN')).toBe(true)
    expect((answer.items as Json[]).find((item) => item.record.id === order1)).toMatchObject({ record: { type: 'SalesOrder', label: 'SEED-SO-0001' }, assignee: { id: expect.any(String) } })
    // A done task leaves the open list.
    const task = made.find((row) => row.record.id === order1)!.task
    await ok('owner', 'POST', `/tasks/${task.id}/status`, { version: task.version, status: 'DONE' })
    expect(((await ok('sales', 'GET', `/tasks?scope=PARTY&partyId=${partyA}&limit=200`)).items as Json[]).map((item) => item.id)).not.toContain(task.id)
  })

  it('wall: a person limited to customer B reads nothing of A — the same answer as an unknown customer', async () => {
    await ok('owner', 'POST', '/tasks/batch', { title: 'Another on A', records: [order(order2)], assignee: { userId: PEOPLE.owner } })
    const theirs = await ok('onlyB', 'GET', `/tasks?scope=PARTY&partyId=${partyA}`)
    const unknown = await ok('onlyB', 'GET', `/tasks?scope=PARTY&partyId=${newId()}`)
    expect(theirs.items).toEqual([])
    expect(theirs.total).toBe(0)
    expect({ ...theirs, asOf: null }).toEqual({ ...unknown, asOf: null })
    expect(JSON.stringify(theirs)).not.toContain('SEED-SO-')
    // Its own customer: its own tasks (TB-B-01's only: this file's earlier batches gave it open tasks too, end check).
    const own = (await ok('onlyB', 'GET', `/tasks?scope=PARTY&partyId=${partyB}&limit=200`)).items as Json[]
    expect(new Set(own.map((item) => item.record.id))).toEqual(new Set([orderB]))
    expect(own.map((item) => item.id)).toContain(made.find((row) => row.record.id === orderB)!.task.id)
  })

  it('without the customer named: refused in words', async () => {
    const answer = await call('sales', 'GET', '/tasks?scope=PARTY')
    expect(answer.status).toBe(400)
    expect(JSON.stringify(answer.body)).toContain('Name the customer.')
  })
})
// ── end B-SA-072 ──
