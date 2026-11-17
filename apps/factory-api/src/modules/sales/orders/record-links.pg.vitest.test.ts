import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { PROPOSE_ACTION } from '@nexus/factory-domain/planning/promise-keep/repromise'
import { buildApp } from '../../../core/app'
import { callerFor, command } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'

/**
 * B-TH-077 (threads plan TH-6; X-G02, ORD-G04, ORD-G09; wall W27): GET /sales/orders/:orderId/links — what points at an order —
 * through the app's real routes on a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level
 * security and the guards are real), tenant A from EVERY seed: the production seed's order with its complaint (SEED-CMP-0001)
 * and its returns, its work orders and their gate refusals. All words are made up.
 *   - its complaints and returns, each by its own right (null without it); another customer's never (W27);
 *   - planning's re-promise still waiting for sales: accept and decline with orders.manage, never by who proposed it, read only
 *     for the production manager; declined, it is gone;
 *   - the gates' refusals that still block its work orders: words for every order reader, the event with the compliance right;
 *     a refusal of another customer's work order never.
 * Run with `node scripts/factory/run-pg-tests.mjs record-links`.
 */

type Json = Record<string, any>
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'record-links-a'
let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let serial = 0
const idem = () => `record-links-${Date.now()}-${++serial}`

const A = { tenant: seedUuid(NS, 'tenant') }
const grant = (permissions: readonly string[], scope: Partial<Grant> = {}): Grant => ({ permissions: permissions as Permission[], companies: 'all', sites: 'all', parties: 'all', ...scope })
const office = (grants: Grant[], actorId: string = newId()): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId, grants })
const SALES = ['orders.view', 'orders.manage', 'email.send', 'quality.complaints.view', 'sales.returns.view', 'compliance.certificates.view', 'planning.promise.view']
const SESSIONS: Record<string, SessionContext> = {}

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
type Method = 'GET' | 'POST'
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': idem() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(200)
  return response.json() as Json
}
const links = (session: string) => ok(session, 'GET', `/sales/orders/${order.id}/links`)

let order: { id: string; number: string; partyId: string; companyId: string }
let other: { id: string; partyId: string }
let plannerId: string

beforeAll(async () => {
  db = await migratedDatabase('record_links')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: database, namespace: NS })
  }
  order = await one(`SELECT o.id, o.number, o."partyId", o."companyId" FROM "SalesOrder" o JOIN "Complaint" c ON c."salesOrderId" = o.id WHERE c."tenantId" = $1 AND c.number = 'SEED-CMP-0001'`, [A.tenant])
  other = await one(`SELECT id, "partyId" FROM "SalesOrder" WHERE "tenantId" = $1 AND "partyId" <> $2 ORDER BY number LIMIT 1`, [A.tenant, order.partyId])
  plannerId = newId()
  SESSIONS.sales = office([grant(SALES)])
  // The planner who proposes (with orders.manage too: still never decides their own proposal).
  SESSIONS.planner = office([grant(['orders.view', 'orders.manage', 'planning.promise.view', 'planning.promise.manage'])], plannerId)
  // The production manager reads orders only.
  SESSIONS.manager = office([grant(['orders.view'])])
  // A sales rep of another customer.
  SESSIONS.otherRep = office([grant(SALES, { parties: [other.partyId] })])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 240_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('its complaints and returns', () => {
  it('the order’s own customer’s, each by its own right; W27: another customer’s never, and another customer’s rep finds no order', async () => {
    const answer = await links('sales')
    expect(answer.order).toEqual({ id: order.id, number: order.number })
    const complaints = await admin<{ number: string }>(`SELECT number FROM "Complaint" WHERE "salesOrderId" = $1 AND "partyId" = $2 ORDER BY number`, [order.id, order.partyId])
    expect(complaints.map((row) => row.number)).toContain('SEED-CMP-0001')
    expect(answer.complaints.map((row: Json) => row.number).sort()).toEqual(complaints.map((row) => row.number))
    expect(answer.complaints.find((row: Json) => row.number === 'SEED-CMP-0001')).toMatchObject({ status: 'TRIAGED', category: 'SAFETY', severity: 'MAJOR' })
    const returns = await admin<{ number: string }>(`SELECT number FROM "ReturnAuthorisation" WHERE "salesOrderId" = $1 AND "partyId" = $2 ORDER BY number`, [order.id, order.partyId])
    expect(returns.length).toBeGreaterThan(0)
    expect(answer.returns.map((row: Json) => row.number).sort()).toEqual(returns.map((row) => row.number))

    // A complaint of another customer: on its own order, and (if the database lets one name it at all) on this order.
    const foreign = await admin<{ number: string }>(`SELECT number FROM "Complaint" WHERE "tenantId" = $1 AND "partyId" <> $2`, [A.tenant, order.partyId])
    for (const row of foreign) expect(answer.complaints.map((entry: Json) => entry.number)).not.toContain(row.number)
    const template = await one(`SELECT * FROM "Complaint" WHERE number = 'SEED-CMP-0001' AND "tenantId" = $1`, [A.tenant])
    await admin(
      `INSERT INTO "Complaint" (id, "tenantId", "companyId", "partyId", number, channel, "receivedAt", description, "salesOrderId", status)
       VALUES ($1, $2, $3, $4, 'SEED-CMP-9901', 'EMAIL', now(), 'Made-up words of another customer.', $5, 'NEW')`,
      [newId(), A.tenant, template.companyId, other.partyId, order.id],
    ).catch(() => null)
    expect((await links('sales')).complaints.map((entry: Json) => entry.number)).not.toContain('SEED-CMP-9901')

    // Without the complaint and return rights the sections are not drawn; another customer's rep finds no order.
    const manager = await links('manager')
    expect(manager.complaints).toBeNull()
    expect(manager.returns).toBeNull()
    expect((await call('otherRep', 'GET', `/sales/orders/${order.id}/links`)).statusCode).toBe(404)
  })
})

describe('planning’s re-promise waiting for sales', () => {
  let proposalId: string

  it('accept and decline with orders.manage, never by who proposed it; the production manager reads it only', async () => {
    const line = await one<{ id: string; seq: number; siteId: string | null }>(`SELECT id, seq, "siteId" FROM "SalesOrderLine" WHERE "orderId" = $1 AND kind <> 'FEE' ORDER BY seq LIMIT 1`, [order.id])
    const site = line.siteId ?? (await one<{ id: string }>(`SELECT id FROM "Site" WHERE "companyId" = $1 AND kind = 'PLANT' AND status = 'ACTIVE' ORDER BY code LIMIT 1`, [order.companyId])).id
    proposalId = newId()
    // The proposal as planning writes it (B-W2b-317): its task on the order for sales and its audit row on the order.
    await command(callerFor(database, { ...(SESSIONS.planner as Extract<SessionContext, { audience: 'office' }>), requestId: newId() }), { name: PROPOSE_ACTION, input: { test: 'record-links' } }, async (tools) => {
      await tools.tx.task.create({
        data: { id: proposalId, companyId: order.companyId, siteId: null, partyId: order.partyId, title: `Accept the new date: ${order.number} line ${line.seq}`, description: 'Made up.', recordType: 'SalesOrder', recordId: order.id, recordLabel: order.number, checklist: [], createdAt: tools.now, updatedAt: tools.now, createdById: plannerId },
        select: { id: true },
      })
      tools.audit({
        action: PROPOSE_ACTION,
        recordType: 'SalesOrder',
        recordId: order.id,
        companyId: order.companyId,
        siteId: site,
        after: { proposalId, orderLineId: line.id, siteId: site, planVersionId: null, sizes: [{ size: '52', from: null, to: '2027-01-15' }], reasonCode: 'CAPACITY', reason: 'Made-up capacity note', message: { language: 'it', subject: 'Nuova data', body: 'Parole inventate.' }, recipients: [], assigneeId: null },
      })
      return null
    })
    const sales = (await links('sales')).rePromises as Json[]
    expect(sales).toHaveLength(1)
    expect(sales[0]).toMatchObject({ id: proposalId, state: 'WAITING', line: { id: line.id, seq: line.seq }, sizes: [{ size: '52', from: null, to: '2027-01-15' }], reasonCode: 'CAPACITY', reason: 'Made-up capacity note', may: { accept: true, decline: true, tell: true } })
    expect(sales[0]!.words).toContain('52')
    expect((await links('planner')).rePromises[0].may).toEqual({ accept: false, decline: false, tell: false })
    expect((await links('manager')).rePromises[0].may).toEqual({ accept: false, decline: false, tell: false })
  })

  it('declined through planning’s own route, it no longer waits on the order', async () => {
    const declined = await call('sales', 'POST', `/planning/promises/re-promises/${proposalId}/decline`, { reason: 'Made-up: the customer needs the old date.' })
    expect(declined.statusCode, declined.body).toBe(200)
    expect((await links('sales')).rePromises).toEqual([])
  })
})

describe('the gates’ refusals', () => {
  it('a refusal that still blocks one of its work orders: words for every order reader, the event with the compliance right; never another customer’s', async () => {
    const cells = await admin<{ workOrderId: string }>(
      `SELECT DISTINCT s."workOrderId" FROM "WorkOrderSize" s JOIN "SalesOrderLine" l ON l.id = s."salesOrderLineId" WHERE l."orderId" = $1
         AND NOT EXISTS (SELECT 1 FROM "WorkOrderSize" x WHERE x."workOrderId" = s."workOrderId" AND (x."partyId" IS NULL OR x."partyId" <> $2))`,
      [order.id, order.partyId],
    )
    expect(cells.length).toBeGreaterThan(0)
    const workOrder = cells[0]!.workOrderId
    const seeded = await one(`SELECT id FROM "GateEvent" WHERE "tenantId" = $1 AND outcome = 'REFUSED' AND gate = 'WORK_ORDER_RELEASE' ORDER BY "createdAt" LIMIT 1`, [A.tenant])
    const copy = (eventId: string, subjectId: string, reason: string) =>
      admin(
        `INSERT INTO "GateEvent" (id, "tenantId", "companyId", "siteId", gate, "subjectType", "subjectId", outcome, "requirementId", "styleId", "marketCode", reason, explanation, "createdAt")
         SELECT $1, "tenantId", "companyId", "siteId", gate, 'WorkOrder', $2, 'REFUSED', "requirementId", "styleId", "marketCode", $3, explanation,
                -- the newest of its kind and after the work order's release (the seeds write days to come): it still blocks
                GREATEST(now(), (SELECT max("createdAt") FROM "GateEvent"), coalesce((SELECT "releasedAt" FROM "WorkOrder" WHERE id = $2), now())) + interval '1 minute'
           FROM "GateEvent" WHERE id = $4`,
        [eventId, subjectId, reason, seeded.id],
      )
    const mine = newId()
    await copy(mine, workOrder, 'Made-up refusal: the release waits for the certificate of the jacket.')
    // Another customer's work order (none of its cells is this order's customer's).
    const foreignOrder = await admin<{ workOrderId: string }>(`SELECT DISTINCT "workOrderId" FROM "WorkOrderSize" WHERE "tenantId" = $1 AND "partyId" IS NOT NULL AND "partyId" <> $2 LIMIT 1`, [A.tenant, order.partyId])
    const theirs = newId()
    if (foreignOrder[0]) await copy(theirs, foreignOrder[0].workOrderId, 'Made-up refusal of another customer’s work order.')

    const sales = (await links('sales')).gates as Json[]
    expect(sales.find((gate) => gate.eventId === mine)).toMatchObject({ gate: 'WORK_ORDER_RELEASE', subject: { type: 'WorkOrder', id: workOrder }, reason: 'Made-up refusal: the release waits for the certificate of the jacket.' })
    expect(sales.map((gate) => gate.eventId)).not.toContain(theirs)
    expect(JSON.stringify(sales)).not.toContain('another customer')
    // Without the compliance right: the same words, no event to open.
    const manager = (await links('manager')).gates as Json[]
    const words = manager.find((gate) => gate.subject.id === workOrder && gate.reason.startsWith('Made-up refusal: the release'))
    expect(words).toMatchObject({ eventId: null, place: expect.any(String) })
  })
})
