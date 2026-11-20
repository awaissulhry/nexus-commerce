import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryClient, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedShipping, type ShippingSeed } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../../adapters/local-files/local'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { createFilesRuntime, useFiles } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'
import { orderIdsOfShipments, orderRefsOfShipments } from './orders-of'
// B-OP-042: the DDT of a shared shipment (its facts as the API reads them, drafted by the domain).
import { draftDdt } from '@nexus/factory-domain/shipping/ddt'
import type { CompanyLegal } from '@nexus/factory-domain/documents/model'
import { readDdtFacts } from '../ddt/store'
import { readShipment } from '../store'
// B-OP-043: the office's ship-to check (SHIPMENT_PREPARED through the lines).
import { shipToProblem } from '../../sales/change-requests/office'
import { orderLinkCountsOf } from '@nexus/factory-domain/sales/orders/linked-counts' // F-OO-206: the one count rule

/**
 * B-OP-040 / B-OP-070 (order page N6, lines-derived; R-6): several orders of ONE customer on one shipment, held off by
 * MULTI_ORDER_OFF until the switch.
 * B-OP-047 turned it on (MULTI_ORDER_OFF deleted): every other join rule stays (same customer, site, ship-to, currency, tax mode,
 * bill-to, an open order, a DRAFT, the brand wall). On the local stack
 * with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security,
 * the column grants and the shipping guards are real), the factory-db shipping seed (Brand Alpha's SEED-SO-0002 and
 * SEED-SO-0003 with released garments), a copy of SEED-SO-0002 for Brand Alpha (the same address, currency and terms: only
 * no join rule refuses it) and one for another customer, Brand Beta (never named to anyone). Every name and number is made
 * up. Run with `node scripts/factory/run-pg-tests.mjs shipment-orders`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string
let seedA: ShippingSeed

const ns = 'shipment-orders'
const idOf = (key: string) => seedUuid(ns, key)
const A = { tenant: idOf('tenant'), companyA: idOf('company:A'), siteA1: idOf('site:A1'), alpha: idOf('party:P1') }
const beta = newId()

const ALL: Permission[] = ['shipping.view', 'shipping.manage', 'shipping.pack', 'shipping.settings.view', 'shipping.settings.manage']
const grant = (permissions: Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  warehouse: office([grant([...ALL, 'orders.view', 'orders.manage'])]),
  viewer: office([grant(['shipping.view'])]),
  // A person limited to Brand Alpha, and one limited to Brand Beta (B's view of A's records: as unknown ones).
  alphaOnly: office([grant(ALL, [A.alpha])]),
  betaOnly: office([grant([...ALL, 'orders.view'], [beta])]),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
/** Past the guards (a shared shipment made by a raw line before the switch lets the API make one). */
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const scoped = <T>(work: (client: FactoryClient) => Promise<T>): Promise<T> => database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, work)

/** A version-4 UUID derived from an id and a salt (the copies' ids are valid UUIDs, as the contracts ask). */
const v4 = (expression: string, salt: string): string => {
  const hash = `md5(${expression}::text || '${salt}')`
  return `(substr(${hash}, 1, 8) || '-' || substr(${hash}, 9, 4) || '-4' || substr(${hash}, 14, 3) || '-8' || substr(${hash}, 18, 3) || '-' || substr(${hash}, 21, 12))::uuid`
}
/** An order copied as `number` for `partyId` (its lines and sizes too): the same address, currency and terms. */
const copyOrderSql = (sourceId: string, number: string, partyId: string): string => {
  const salt = number.toLowerCase()
  return `
    CREATE TEMP TABLE o AS SELECT * FROM "SalesOrder" WHERE id = '${sourceId}';
    CREATE TEMP TABLE l AS SELECT * FROM "SalesOrderLine" WHERE "orderId" = (SELECT id FROM o);
    CREATE TEMP TABLE s AS SELECT * FROM "SalesOrderLineSize" WHERE "lineId" IN (SELECT id FROM l);
    UPDATE s SET id = ${v4('id', salt)}, "lineId" = ${v4('"lineId"', salt)}, "partyId" = '${partyId}';
    UPDATE l SET id = ${v4('id', salt)}, "orderId" = ${v4('"orderId"', salt)}, "partyId" = '${partyId}', "quoteLineId" = NULL, "styleRevisionId" = NULL;
    UPDATE o SET id = ${v4('id', salt)}, "partyId" = '${partyId}', number = '${number}', "quoteVersionId" = NULL, "customerRef" = '${number}-PO', "customerSeq" = NULL, status = 'CONFIRMED';
    INSERT INTO "SalesOrder" SELECT * FROM o;
    INSERT INTO "SalesOrderLine" SELECT * FROM l;
    INSERT INTO "SalesOrderLineSize" SELECT * FROM s;
    DROP TABLE o, l, s;`
}

const so2 = () => seedA.quality.production.salesOrderId
const so3 = () => seedA.quality.serialSalesOrderId
const cells = () => ({ blk52: seedA.quality.production.cellIds['BLK-52'], jacket: seedA.quality.serialCellId })
const orderId = async (number: string): Promise<string> => (await admin<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = $2`, [A.tenant, number]))[0]!.id
const ids: Record<string, string> = {}

beforeAll(async () => {
  db = await migratedDatabase('shipment_orders')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  seedA = await seedShipping({ db: database, namespace: ns })
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT12345670009', "fiscalCode" = '12345670009', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [A.companyA])
  await admin(
    `INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'SHIPMENT', 'MAIN', 'ALL', 'NEVER', 'SH-{N:5}', false) ON CONFLICT DO NOTHING`,
    [newId(), A.tenant, A.companyA],
  )
  await admin(`INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", roles) VALUES ($1, $2, $3, 'BRAND-BETA', 'ORGANISATION', 'Brand Beta GmbH', '{CUSTOMER}')`, [beta, A.tenant, A.companyA])
  await admin(copyOrderSql(so2(), 'SO-ALPHA-2', A.alpha))
  await admin(copyOrderSql(so2(), 'SO-BETA-1', beta))
  ids.alpha2 = await orderId('SO-ALPHA-2')
  ids.beta1 = await orderId('SO-BETA-1')
  if ((await admin(`SELECT 1 FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2'`, [A.tenant])).length === 0) {
    await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), A.tenant])
  }
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-shipment-orders-test-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  // A DRAFT of SEED-SO-0002 with no line yet: the shipment the other orders would join.
  ids.draft = (await ok('warehouse', 'POST', '/shipping/shipments', { salesOrderId: so2(), siteId: A.siteA1 }, 201)).shipment.id
}, 180_000)

afterAll(async () => {
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

describe('B-OP-040 / B-OP-047: a second order of the customer joins (N6 on), every other rule kept', () => {
  it('POST /shipping/shipments with a second order of the same customer (its address, currency and terms): made, the first its order', async () => {
    const before = await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "Shipment" WHERE "tenantId" = $1`, [A.tenant])
    const second = (await ok('warehouse', 'POST', '/shipping/shipments', { salesOrderId: so2(), salesOrderIds: [so2(), ids.alpha2], siteId: A.siteA1 }, 201)).shipment
    expect(second.salesOrderId).toBe(so2())
    expect(await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "Shipment" WHERE "tenantId" = $1`, [A.tenant])).toEqual([{ n: before[0]!.n + 1 }])
    await ok('warehouse', 'POST', `/shipping/shipments/${second.id}/cancel`, { version: second.version, reason: 'Test: two orders made' })
    // The first order is the shipment's salesOrderId.
    expect((await refused('warehouse', 'POST', '/shipping/shipments', { salesOrderId: so2(), salesOrderIds: [ids.alpha2, so2()], siteId: A.siteA1 }, 400)).issues).toEqual([{ path: 'body/salesOrderIds/0', message: 'Expected the salesOrderId first.' }])
    // One order alone, as today.
    const one = (await ok('warehouse', 'POST', '/shipping/shipments', { salesOrderId: so2(), salesOrderIds: [so2()], siteId: A.siteA1 }, 201)).shipment
    expect(one.salesOrderId).toBe(so2())
    await ok('warehouse', 'POST', `/shipping/shipments/${one.id}/cancel`, { version: one.version, reason: 'Test: one order alone' })
  })

  it("another customer's order is answered as an unknown one, for every login", async () => {
    const unknown = await refused('warehouse', 'POST', '/shipping/shipments', { salesOrderId: so2(), salesOrderIds: [so2(), newId()], siteId: A.siteA1 }, 404)
    expect(unknown.message).toBe('Sales order not found.')
    const other = await refused('warehouse', 'POST', '/shipping/shipments', { salesOrderId: so2(), salesOrderIds: [so2(), ids.beta1], siteId: A.siteA1 }, 404)
    expect(other.message).toBe(unknown.message)
    // A person limited to Brand Beta finds neither Alpha's order nor its shipment.
    expect((await refused('betaOnly', 'POST', '/shipping/shipments', { salesOrderId: so2(), siteId: A.siteA1 }, 404)).message).toBe('Sales order not found.')
  })

  it('the lines route: a cell of another order of the customer joins the DRAFT (orders_changed ADDED); taken off, it leaves (REMOVED)', async () => {
    const draft = (await ok('warehouse', 'GET', `/shipping/shipments/${ids.draft}`)).shipment
    const joined = (await ok('warehouse', 'POST', `/shipping/shipments/${ids.draft}/lines`, { version: draft.version, lines: [{ workOrderSizeId: cells().jacket, quantity: 1 }] })).shipment
    const line = (joined.lines as Json[]).find((entry) => entry.workOrderSizeId === cells().jacket)!
    expect(line).toBeDefined()
    // Taken off again: the jacket's one free garment stays free for the shared shipment below.
    const after = (await ok('warehouse', 'DELETE', `/shipping/shipments/${ids.draft}/lines/${line.id}?version=${joined.version}`)).shipment
    expect(after.lines).toEqual([])
    const changes = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'shipment.orders_changed' AND subject = $1 ORDER BY "occurredAt", id`, [ids.draft])
    expect(changes.map((row) => [row.payload.change, row.payload.salesOrderIds])).toEqual([
      ['ADDED', [so2(), so3()]],
      ['REMOVED', [so2()]],
    ])
  })

  it('an order of another customer is never a line of it: the database refuses it (the FK carries the party)', async () => {
    const line = await admin<{ id: string }>(`SELECT id FROM "SalesOrderLine" WHERE "orderId" = $1 LIMIT 1`, [ids.beta1])
    await expect(
      admin(
        `INSERT INTO "ShipmentLine" (id, "tenantId", "siteId", "partyId", "shipmentId", "workOrderId", "workOrderSizeId", "salesOrderLineId", size, quantity)
         SELECT $1, c."tenantId", c."siteId", s."partyId", s.id, c."workOrderId", c.id, $4, c.size, 1 FROM "WorkOrderSize" c, "Shipment" s WHERE c.id = $2 AND s.id = $3`,
        [newId(), cells().blk52, ids.draft, line[0]!.id],
      ),
    ).rejects.toThrow()
  })
})

describe('B-OP-040: candidates and joinable answer the same customer only, each with its verdict', () => {
  it("GET …/orders/candidates: the customer's other open orders with {allowed, why}; never another customer's, never its own", async () => {
    const { orders, number } = await ok('warehouse', 'GET', `/shipping/shipments/${ids.draft}/orders/candidates`)
    expect(number).toMatch(/^SH-/)
    const alpha2 = (orders as Json[]).find((row) => row.salesOrderId === ids.alpha2)
    expect(alpha2).toEqual({ salesOrderId: ids.alpha2, number: 'SO-ALPHA-2', customerRef: 'SO-ALPHA-2-PO', status: 'CONFIRMED', joinable: { allowed: true, code: null, why: null } })
    expect((orders as Json[]).map((row) => row.salesOrderId)).not.toContain(so2())
    // B-OP-047: no order is held by the old hold; each verdict is its real reasons (or none).
    expect(JSON.stringify(orders)).not.toContain('MULTI_ORDER_OFF')
    // Never Brand Beta's order, also for a person who sees every customer.
    expect(JSON.stringify(orders)).not.toContain(ids.beta1)
    expect(JSON.stringify(orders)).not.toContain('SO-BETA-1')
    // Out of scope: as an unknown shipment.
    const unknown = await refused('betaOnly', 'GET', `/shipping/shipments/${newId()}/orders/candidates`, undefined, 404)
    expect((await refused('betaOnly', 'GET', `/shipping/shipments/${ids.draft}/orders/candidates`, undefined, 404)).message).toBe(unknown.message)
    expect((await ok('viewer', 'GET', `/shipping/shipments/${ids.draft}/orders/candidates`)).orders).toEqual(orders)
  })

  it('GET /shipping/shipments/joinable?salesOrderId=: the DRAFT shipments of its customer it is not on, each with its verdict', async () => {
    const joinable = await ok('warehouse', 'GET', `/shipping/shipments/joinable?salesOrderId=${ids.alpha2}`)
    expect(joinable).toMatchObject({ salesOrderId: ids.alpha2, number: 'SO-ALPHA-2' })
    expect((joinable.shipments as Json[]).find((row) => row.shipmentId === ids.draft)).toMatchObject({ status: 'DRAFT', siteId: A.siteA1, joinable: { allowed: true, code: null, why: null } })
    // The order's own shipments are not offered.
    expect(((await ok('warehouse', 'GET', `/shipping/shipments/joinable?salesOrderId=${so2()}`)).shipments as Json[]).map((row) => row.shipmentId)).not.toContain(ids.draft)
    // Brand Beta's order: no shipment of Alpha's is ever offered to it.
    expect((await ok('warehouse', 'GET', `/shipping/shipments/joinable?salesOrderId=${ids.beta1}`)).shipments).toEqual([])
    // A person limited to Brand Beta: Alpha's order is an unknown one.
    const unknown = await refused('betaOnly', 'GET', `/shipping/shipments/joinable?salesOrderId=${newId()}`, undefined, 404)
    expect(unknown.message).toBe('Sales order not found.')
    expect((await refused('betaOnly', 'GET', `/shipping/shipments/joinable?salesOrderId=${ids.alpha2}`, undefined, 404)).message).toBe(unknown.message)
  })
})

// B-OP-070 (order page N6, "ship together"; F-OP-121 reads it).
describe('B-OP-070: ship together — the ready read lists the same customer\'s other orders with their verdict', () => {
  it('GET /shipping/ready?salesOrderId=&together=1: the asked order first (shipsWith null), then the customer\'s other orders with released garments', async () => {
    const ready = await ok('warehouse', 'GET', `/shipping/ready?salesOrderId=${so2()}&together=1`)
    const rows = ready.orders as Json[]
    expect(rows[0]).toMatchObject({ salesOrderId: so2(), shipsWith: null })
    const other = rows.find((row) => row.salesOrderId === so3())
    // B-OP-047: SEED-SO-0003 (the same address, currency and terms) ships with it; every other order says its own reason, if any.
    expect(other).toMatchObject({ partyId: A.alpha, shipsWith: { allowed: true, code: null, why: null } })
    expect(rows.slice(1).every((row) => row.shipsWith.allowed === true || (typeof row.shipsWith.code === 'string' && row.shipsWith.code !== 'MULTI_ORDER_OFF'))).toBe(true)
    expect(rows.every((row) => row.partyId === A.alpha)).toBe(true)
    // Never another customer's order, also for a person who sees every customer.
    expect(JSON.stringify(ready)).not.toContain(ids.beta1)
    // Without together: the asked order alone, as before, and no verdict.
    const alone = await ok('warehouse', 'GET', `/shipping/ready?salesOrderId=${so2()}`)
    expect((alone.orders as Json[]).map((row) => [row.salesOrderId, row.shipsWith])).toEqual([[so2(), null]])
  })

  it('a site filter keeps to that site; an order the caller may not see gives nothing more than without together', async () => {
    const elsewhere = await ok('warehouse', 'GET', `/shipping/ready?salesOrderId=${so2()}&together=1&siteId=${newId()}`)
    expect(elsewhere.orders).toEqual([])
    // A person limited to Brand Beta: Alpha's order is out of reach, with together as without.
    expect((await ok('betaOnly', 'GET', `/shipping/ready?salesOrderId=${so2()}&together=1`)).orders).toEqual([])
    expect((await ok('betaOnly', 'GET', `/shipping/ready?salesOrderId=${so2()}`)).orders).toEqual([])
    // Brand Beta's own order (no released garments) lists nothing of Alpha's.
    expect(JSON.stringify(await ok('warehouse', 'GET', `/shipping/ready?salesOrderId=${ids.beta1}&together=1`))).not.toContain(so2())
  })
})

describe('B-OP-040: ordersOfShipment — the orders of its lines, the first order first', () => {
  it('one order per shipment: its first order; a shared shipment made by a raw line: both, the first first; one query for many', async () => {
    const draft = (await ok('warehouse', 'GET', `/shipping/shipments/${ids.draft}`)).shipment
    expect(await scoped((client) => orderIdsOfShipments(client, [{ id: ids.draft!, salesOrderId: so2() }]))).toEqual(new Map([[ids.draft, [so2()]]]))
    // A shared shipment of Brand Alpha's two orders (SEED-SO-0002 first, then SEED-SO-0003's jacket), made past the API.
    const shared = (await ok('warehouse', 'POST', '/shipping/shipments', { salesOrderId: so2(), lines: [{ workOrderSizeId: cells().blk52, quantity: 1 }] }, 201)).shipment
    ids.shared = shared.id
    await force(
      `INSERT INTO "ShipmentLine" (id, "tenantId", "siteId", "partyId", "shipmentId", "workOrderId", "workOrderSizeId", "salesOrderLineId", size, quantity)
       SELECT $1, c."tenantId", c."siteId", s."partyId", s.id, c."workOrderId", c.id, c."salesOrderLineId", c.size, 1 FROM "WorkOrderSize" c, "Shipment" s WHERE c.id = $2 AND s.id = $3`,
      [newId(), cells().jacket, shared.id],
    )
    const both = await scoped((client) => orderIdsOfShipments(client, [{ id: shared.id, salesOrderId: so2() }, { id: draft.id, salesOrderId: so2() }]))
    expect(both.get(shared.id)).toEqual([so2(), so3()])
    expect(both.get(draft.id)).toEqual([so2()])
    const refs = await scoped((client) => orderRefsOfShipments(client, [{ id: shared.id, salesOrderId: so2() }]))
    expect(refs.get(shared.id)!.map((ref) => ref.id)).toEqual([so2(), so3()])
    // The orders are always the shipment's own customer's.
    expect(new Set((await admin<{ partyId: string }>(`SELECT "partyId" FROM "SalesOrder" WHERE id = ANY($1::uuid[])`, [both.get(shared.id)])).map((row) => row.partyId))).toEqual(new Set([A.alpha]))
  })

  // B-OP-042 (order page N6): the DDT names every order (refs per order) and groups its lines by order.
  it('B-OP-042: a DDT of the shared shipment: one SALES_ORDER (+ CUSTOMER_ORDER) reference per order, its lines grouped by order', async () => {
    const company: CompanyLegal = { legalName: 'Fabbrica Esempio S.r.l.', address: { line1: 'Via Esempio 1', postalCode: '20121', city: 'Milano', province: 'MI', country: 'IT' }, vatNumber: 'IT12345670009', fiscalCode: '12345670009', reaOffice: 'MI', reaNumber: '0000001', shareCapital: null, currency: 'EUR' }
    const numbers = await admin<{ id: string; number: string }>(`SELECT id, number FROM "SalesOrder" WHERE id = ANY($1::uuid[])`, [[so2(), so3()]])
    const numberOf = (id: string) => numbers.find((row) => row.id === id)!.number
    const facts = await scoped(async (client) => readDdtFacts(client, (await readShipment(client, ids.shared!))!, company))
    expect((facts.orders ?? []).map((order) => order.number)).toEqual([numberOf(so2()), numberOf(so3())])
    const { draft } = draftDdt(facts, {}, new Date())
    expect(draft.documentRefs.filter((ref) => ref.kind === 'SALES_ORDER').map((ref) => ref.number)).toEqual([numberOf(so2()), numberOf(so3())])
    // The first order's goods first; each line names its order (several orders).
    expect(draft.lines.map((line) => line.description.includes(numberOf(so2())) ? 'first' : line.description.includes(numberOf(so3())) ? 'second' : 'none')).toEqual(['first', 'second'])
  })

  // B-OP-041 (order page N6), against B-OP-005's real line guard (merged, #1704): a line of SEED-SO-0003 (an open order of
  // the same customer, company, currency and tax mode) goes on the DRAFT child; this world stays within the jacket's
  // releases (2 released: SH-0002 holds 1, the shared shipment 1), which the guard checks again when the line moves.
  it('a split keeps a subset: the child carries the orders of its own lines, the parent loses an order with its last line', async () => {
    const parent = (await ok('warehouse', 'GET', `/shipping/shipments/${ids.shared}`)).shipment
    const jacketLine = (parent.lines as Json[]).find((line) => line.workOrderSizeId === cells().jacket)!
    const { shipment: child, from } = await ok('warehouse', 'POST', `/shipping/shipments/${ids.shared}/split`, { version: parent.version, reason: 'CUSTOMER_REQUEST', lines: [{ lineId: jacketLine.id, quantity: 1 }] }, 201)
    ids.child = child.id
    // The child keeps the parent's first order (the database's split rule) and carries its own lines' orders.
    expect(child.salesOrderId).toBe(so2())
    expect(child.salesOrders.map((order: Json) => order.id)).toEqual([so2(), so3()])
    expect(from.salesOrders.map((order: Json) => order.id)).toEqual([so2()])
    const changes = await admin<{ subject: string; payload: Json }>(`SELECT subject::text AS subject, payload FROM "OutboxEvent" WHERE type = 'shipment.orders_changed' AND subject = ANY($1::text[]) ORDER BY "occurredAt", id`, [[ids.shared, child.id]]) // op-fx2: subject is a text column
    expect(changes.map((row) => [row.subject, row.payload.change, row.payload.salesOrderIds])).toEqual([
      [child.id, 'ADDED', [so2(), so3()]],
      [ids.shared, 'REMOVED', [so2()]],
    ])
    // partyId rides in the payload for the office's live wall only (never a live field).
    expect(changes.every((row) => row.payload.partyId === A.alpha)).toBe(true)
  })

  // B-OP-043 (order page N6): the order read's shipments are those made for it or carrying its garments, each with its orders.
  it('B-OP-043: the shared shipment is on both orders\' reads with every order it carries, the first first', async () => {
    for (const orderId of [so2(), so3()]) {
      const { order } = await ok('warehouse', 'GET', `/sales/orders/${orderId}`)
      const child = (order.chain.shipments as Json[]).find((row) => row.id === ids.child)
      expect(child, orderId).toMatchObject({ origin: 'NEXUS', externalDdt: null })
      expect(child!.orders.map((ref: Json) => ref.id)).toEqual([so2(), so3()])
      // F-OO-206 (order overview §6; Owner D8): the read sends no badges; the tab and the Linked records card count the chain by
      // the one rule, which counts the shared shipment on both orders (every shipment not cancelled).
      expect(order).not.toHaveProperty('badges')
      expect(orderLinkCountsOf(order.chain).shipments.live).toBe((order.chain.shipments as Json[]).filter((row) => row.status !== 'CANCELLED').length)
      expect(orderLinkCountsOf(order.chain).shipments.live).toBeGreaterThan(0)
    }
    // The orders are always of the order's own customer.
    const { order } = await ok('warehouse', 'GET', `/sales/orders/${so3()}`)
    const refs = (order.chain.shipments as Json[]).flatMap((row) => row.orders as Json[])
    expect(JSON.stringify(refs)).not.toContain(ids.beta1)
    // A person limited to Brand Beta reads none of it.
    expect((await call('betaOnly', 'GET', `/sales/orders/${so3()}`)).statusCode).toBe(404)
  })

  it('an order with garments on a DRAFT shipment of another order refuses its own cancel, in words', async () => {
    const number = (await admin<{ number: string }>(`SELECT number FROM "SalesOrder" WHERE id = $1`, [so3()]))[0]!.number
    // Its garments are on the split's child now (a shipment made for SEED-SO-0002).
    const shipmentNumber = (await admin<{ number: string }>(`SELECT number FROM "Shipment" WHERE id = $1`, [ids.child ?? ids.shared]))[0]!.number
    const order = await ok('warehouse', 'GET', `/sales/orders/${so3()}`)
    const refusal = await refused('warehouse', 'POST', `/sales/orders/${so3()}/cancel`, { version: order.order?.version ?? order.version, reason: 'Test: garments on a shared shipment', confirmNumber: number }, 409)
    expect(refusal.message).toContain(`Take ${number}'s garments off ${shipmentNumber} first`)
  })

  // B-OP-043 (B-OP-015's refusal moved): the order's ship-to waits while a shipment being prepared carries its garments, also
  // one made for another of its customer's orders. A line of SO-ALPHA-2 is put on the DRAFT of SEED-SO-0002 past the guards.
  it('B-OP-043: SHIPMENT_PREPARED through the lines — a DRAFT carrying the order\'s garments holds its ship-to change', async () => {
    const address = newId()
    await admin(
      `INSERT INTO "PartyAddress" (id, "tenantId", "partyId", kinds, status, name, line1, "postalCode", city, country) VALUES ($1, $2, $3, '{SHIP_TO}', 'ACTIVE', 'Brand Alpha store', 'Via Esempio 30', '00000', 'Seedville', 'IT')`,
      [address, A.tenant, A.alpha],
    )
    const office = { id: ids.alpha2!, partyId: A.alpha }
    expect(await scoped((client) => shipToProblem(client, office, address, 'OFFICE'))).toBeNull()
    const alphaLine = (await admin<{ id: string }>(`SELECT id FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq LIMIT 1`, [ids.alpha2]))[0]!.id
    const lineId = newId()
    await force(
      `INSERT INTO "ShipmentLine" (id, "tenantId", "siteId", "partyId", "shipmentId", "workOrderId", "workOrderSizeId", "salesOrderLineId", size, quantity)
       SELECT $1, c."tenantId", c."siteId", s."partyId", s.id, c."workOrderId", c.id, $4, c.size, 1 FROM "WorkOrderSize" c, "Shipment" s WHERE c.id = $2 AND s.id = $3`,
      [lineId, cells().blk52, ids.draft, alphaLine],
    )
    const draftNumber = (await admin<{ number: string }>(`SELECT number FROM "Shipment" WHERE id = $1`, [ids.draft]))[0]!.number
    expect(await scoped((client) => shipToProblem(client, office, address, 'OFFICE'))).toEqual({
      path: 'body/shipToAddressId/SHIPMENT_PREPARED',
      message: `Shipment ${draftNumber} is being prepared for the order's address: change it on the shipment first.`,
    })
    await force(`DELETE FROM "ShipmentLine" WHERE id = $1`, [lineId])
  })
})
