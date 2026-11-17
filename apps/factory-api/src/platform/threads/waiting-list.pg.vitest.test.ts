import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { CUSTOMER_SIDE_TYPES, EITHER_SIDE_TYPES, SUPPLIER_SIDE_TYPES, THREAD_VIEW_GATES } from '@nexus/factory-domain/threads/view-gates'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedSalesIntake } from '../../../../../packages/factory-db/seed/sales-intake'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { callerFor, command } from '../../core/command'
import { testAuthenticator, type RequestContext, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { startHarness, type Harness } from '../auth/sessions/testing/harness'
import { THREAD_RECORDS, useThreadRecords } from './records'
import { ensureThread, writeMessage } from './threads'

/**
 * B-TH-047 — conversations waiting on us across records (threads plan TH-3, N10, N25, X-G06; wall W27, W30) through the app's real
 * routes on a throwaway PostgreSQL 17 database from the migrations, on the seeds up to the sales intake (the brand P1 = SEED-C1, the
 * supplier P2 = SEED-S1, the customer P3 = SEED-C2 with its request SEED-INQ-0002). Quotes and orders are made-up records of P1 and
 * P3 (test resolvers: the list reads the thread's own scope, never the record's resolver); the purchase order is a real one of P2.
 * Every name and word is made up.
 *
 *   - GET /threads/waiting?side=CUSTOMER: the open conversations whose newest SHARED message is the customer's, oldest first, paged;
 *     our reply takes a row off, an office note does not; a request (Incoming's own row) and a supplier's record are never on it;
 *   - T27 / W27: a person limited to customer P1 lists none of P3's conversations; T30 / W30: Incoming's CUSTOMER_REPLIES counts the
 *     same; the production manager (threads.read, orders.view, no quotes.view) is never listed a quote's conversation;
 *   - side=SUPPLIER: a purchase order and a supplier's own thread, for the buyer; Purchasing › Orders lists and counts "Supplier
 *     replies" (supplierReplies) from the same read;
 *   - a portal person reaches none of it (office only); every record type of the sides has a view gate.
 * Run with `node scripts/factory/run-pg-tests.mjs platform/threads/waiting-list`.
 */

vi.setConfig({ testTimeout: 120_000 })

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT'

const NS = 'th3-waiting-list'
const idOf = (key: string): string => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const siteA1 = idOf('site:A1')
const P1 = idOf('party:P1')
const P2 = idOf('party:P2')
const P3 = idOf('party:P3')

const permissionsOf = (key: string): Permission[] => {
  const template = templateOf(key)!
  return [...template.permissions, ...template.grains.map((grain) => `money.${grain}`)] as Permission[]
}
const grant = (permissions: Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const PEOPLE = { ada: newId(), lina: newId(), pia: newId(), bob: newId(), anna: newId() } as const
const SESSIONS: Record<string, SessionContext> = {
  // Sales over every customer; Lina's sales grant is limited to P1; Pia is the production manager; Bob the buyer; Anna a portal person.
  ada: { audience: 'office', tenantId: T, actorId: PEOPLE.ada, grants: [grant(permissionsOf('sales'))] },
  lina: { audience: 'office', tenantId: T, actorId: PEOPLE.lina, grants: [grant(permissionsOf('sales'), [P1])] },
  pia: { audience: 'office', tenantId: T, actorId: PEOPLE.pia, grants: [grant(permissionsOf('production_manager'))] },
  bob: { audience: 'office', tenantId: T, actorId: PEOPLE.bob, grants: [grant(permissionsOf('buyer'))] },
  anna: { audience: 'partner', tenantId: T, actorId: PEOPLE.anna, partyId: P1, grants: [grant(['threads.read'] as Permission[], [P1])] },
}

// The made-up quotes and orders: each id names its customer.
const records = { quoteA: newId(), quoteB: newId(), orderA: newId(), orderB: newId() }
const partyOfRecord: Record<string, string> = { [records.quoteA]: P1, [records.orderA]: P1, [records.quoteB]: P3, [records.orderB]: P3 }

let h: Harness
let app: FastifyInstance
const run = randomBytes(4).toString('hex')
let serial = 0
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const one = async (sql: string, values: unknown[] = []): Promise<Json> => (await admin(sql, values))[0]!
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `wl-${run}-${++serial}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const listed = async (session: string, query: string) => ((await ok(session, 'GET', `/threads/waiting?${query}`)).rows as Json[]).map((row) => row.recordId)

const DAY = 86_400_000
/** One message written through the threads' seam, `at` back in time, as Ada. */
async function message(record: { type: string; id: string }, direction: 'INTERNAL_NOTE' | 'OUTBOUND' | 'INBOUND', daysAgo: number, words = `Made-up ${direction.toLowerCase()} message.`): Promise<void> {
  const context = { ...SESSIONS.ada, requestId: newId() } as RequestContext
  await command(callerFor(h.database, context), { name: 'threads.postNote', input: { record, direction, daysAgo } }, async (tools) => {
    const { thread } = await ensureThread(tools, record, PEOPLE.ada)
    await writeMessage(tools, thread, { direction, channel: direction === 'INTERNAL_NOTE' ? 'APP' : 'EMAIL', author: direction === 'INBOUND' ? { kind: 'PARTY', id: null, name: 'Made-up buyer' } : { kind: 'USER', id: PEOPLE.ada, name: 'Made-up Ada' }, bodyText: words, at: new Date(Date.now() - daysAgo * DAY) })
    return { done: true }
  })
}

let purchaseOrderId = ''
let requestId = ''

beforeAll(async () => {
  h = await startHarness('th3_waiting_list')
  await seedCore({ db: h.database, namespace: NS })
  await seedSalesIntake({ db: h.database, namespace: NS })
  const scope = (id: string) => (partyOfRecord[id] ? { companyId: companyA, siteId: null, partyId: partyOfRecord[id]! } : null)
  useThreadRecords({ Quote: async (_client, id) => scope(id), SalesOrder: async (_client, id) => scope(id) })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  for (const [person, userId] of Object.entries(PEOPLE)) {
    if (person === 'anna') continue
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [userId, T, `th3-${person}-${run}@example.test`, `Made-up ${person}`])
  }
  purchaseOrderId = (await ok('bob', 'POST', '/purchasing/orders', { companyId: companyA, siteId: siteA1, partyId: P2 }, 201)).order.id
  requestId = (await one(`SELECT id FROM "Inquiry" WHERE "tenantId" = $1 AND number = 'SEED-INQ-0002'`, [T])).id
  // The customers wrote last on these (oldest first: quote A 9 days ago … order A 2 days ago).
  await message({ type: 'Quote', id: records.quoteA }, 'INBOUND', 9, 'Made-up: can the red be a darker red?')
  await message({ type: 'Quote', id: records.quoteB }, 'INBOUND', 7)
  await message({ type: 'SalesOrder', id: records.orderB }, 'INBOUND', 5)
  await message({ type: 'SalesOrder', id: records.orderA }, 'OUTBOUND', 4)
  await message({ type: 'SalesOrder', id: records.orderA }, 'INBOUND', 2)
  // An office note after the customer's message flips nothing; our reply does.
  await message({ type: 'SalesOrder', id: records.orderA }, 'INTERNAL_NOTE', 1)
  await message({ type: 'SalesOrder', id: records.orderB }, 'OUTBOUND', 1)
  // A request is Incoming's own row; the supplier's records are the other side.
  await message({ type: 'Inquiry', id: requestId }, 'INBOUND', 3)
  await message({ type: 'PurchaseOrder', id: purchaseOrderId }, 'INBOUND', 6, 'Made-up: we can ship the lining on Friday.')
  await message({ type: 'Party', id: P2 }, 'INBOUND', 8)
}, 900_000)

afterAll(async () => {
  useThreadRecords(undefined)
  await app?.close()
  await h?.close()
}, 60_000)

describe('B-TH-047 conversations waiting on us across records', () => {
  it('Customer replies: the customer wrote last, oldest first; our reply takes a row off, a note does not; never a request', async () => {
    const answer = await ok('ada', 'GET', '/threads/waiting?side=CUSTOMER')
    expect(answer.rows.map((row: Json) => row.recordId)).toEqual([records.quoteA, records.quoteB, records.orderA])
    expect(answer).toMatchObject({ count: 3, complete: true, next: null })
    const first = answer.rows[0]
    expect(first).toMatchObject({ recordType: 'Quote', recordId: records.quoteA, companyId: companyA, party: { id: P1, code: 'SEED-C1' }, lastMessage: { channel: 'EMAIL', authorName: 'Made-up buyer', excerpt: 'Made-up: can the red be a darker red?' }, waiting: { amber: true, thresholdDays: 3 } })
    expect(first.waiting.workingMinutes).toBeGreaterThan(3 * 480)
    // Paged: one row at a time, the cursor carries on.
    const page1 = await ok('ada', 'GET', '/threads/waiting?side=CUSTOMER&limit=2')
    expect(page1.rows.map((row: Json) => row.recordId)).toEqual([records.quoteA, records.quoteB])
    const page2 = await ok('ada', 'GET', `/threads/waiting?side=CUSTOMER&limit=2&cursor=${page1.next}`)
    expect(page2.rows.map((row: Json) => row.recordId)).toEqual([records.orderA])
    expect(page2.next).toBeNull()
    // Filters: one customer, one record type.
    expect(await listed('ada', `side=CUSTOMER&partyId=${P3}`)).toEqual([records.quoteB])
    expect(await listed('ada', 'side=CUSTOMER&recordType=SalesOrder')).toEqual([records.orderA])
    expect((await call('ada', 'GET', '/threads/waiting?side=CUSTOMER&cursor=nonsense')).statusCode).toBe(400)
  })

  it('T27 / T30: a person limited to P1 lists and counts none of P3’s conversations; the production manager no quote', async () => {
    expect(await listed('lina', 'side=CUSTOMER')).toEqual([records.quoteA, records.orderA])
    expect(await listed('lina', `side=CUSTOMER&partyId=${P3}`)).toEqual([])
    // Pia reads threads and orders, never quotes: the order is hers to open, the quotes are not listed.
    expect(await listed('pia', 'side=CUSTOMER')).toEqual([records.orderA])
    // Incoming's "Customer replies" count: the same read for each reader.
    const counted = async (session: string) => (await ok(session, 'GET', '/sales/incoming')).counts.CUSTOMER_REPLIES
    expect(await counted('ada')).toBe(3)
    expect(await counted('lina')).toBe(2)
    expect(await counted('pia')).toBe(1)
    expect((await ok('ada', 'GET', `/sales/incoming?partyId=${P1}`)).counts.CUSTOMER_REPLIES).toBe(2)
  })

  it('Supplier replies: the buyer’s purchase order and the supplier’s own thread; Purchasing › Orders lists and counts them', async () => {
    expect(await listed('bob', 'side=SUPPLIER')).toEqual([P2, purchaseOrderId])
    // The buyer opens no customer record: nothing of the customer side.
    expect(await ok('bob', 'GET', '/threads/waiting?side=CUSTOMER')).toMatchObject({ rows: [], count: 0 })
    // Sales reads no purchase order: the order's row is not listed, the supplier's own thread (parties.view) is.
    expect(await listed('ada', 'side=SUPPLIER')).toEqual([P2])
    const orders = await ok('bob', 'GET', '/purchasing/orders?supplierReplies=true')
    expect(orders.orders.map((row: Json) => row.id)).toEqual([purchaseOrderId])
    expect(orders.summary.supplierReplies).toBe(1)
    // Answered: off the list and the count.
    await message({ type: 'PurchaseOrder', id: purchaseOrderId }, 'OUTBOUND', 0)
    expect(await listed('bob', 'side=SUPPLIER')).toEqual([P2])
    const after = await ok('bob', 'GET', '/purchasing/orders?supplierReplies=true')
    expect(after.orders).toEqual([])
    expect(after.summary.supplierReplies).toBe(0)
    expect((await ok('bob', 'GET', '/purchasing/orders')).orders.map((row: Json) => row.id)).toContain(purchaseOrderId)
  })

  it('office only; every record type of the sides has a view gate and a thread', async () => {
    expect((await call('anna', 'GET', '/threads/waiting?side=CUSTOMER')).statusCode).toBe(403)
    for (const type of [...CUSTOMER_SIDE_TYPES, ...SUPPLIER_SIDE_TYPES, ...EITHER_SIDE_TYPES]) {
      expect(Object.hasOwn(THREAD_RECORDS, type), type).toBe(true)
      expect(Object.hasOwn(THREAD_VIEW_GATES, type), type).toBe(true)
    }
    for (const type of Object.keys(THREAD_RECORDS)) expect(Object.hasOwn(THREAD_VIEW_GATES, type), `${type} has a view gate`).toBe(true)
  })
})
