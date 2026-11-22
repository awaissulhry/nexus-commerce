import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
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

/**
 * Consolidate and split from the order's Shipments tab (order shipments lane, PR S2; B-OS-010 … B-OS-013; X1) on the local stack
 * with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security, the
 * column grants and the shipping guards are real), the factory-db shipping seed (Brand Alpha's SEED-SO-0002 and SEED-SO-0003), four
 * more of WO-0001's garments released past the guards (made-up facts: copies of a seeded release, so SEED-SO-0002 has five garments
 * to plan), a copy of SEED-SO-0002 for Brand Alpha (SO-ALPHA-2, sent elsewhere) and one for Brand Beta (never named to anyone).
 * Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs consolidate`.
 *
 *   split    one DRAFT into three in one go (a line giving to two of them), each with the hold it was under
 *   take off SEED-SO-0003 off a shared DRAFT in one go; never its first order, never garments in a carton
 *   move     garments onto another DRAFT of the customer (the hold comes along); another address: JOIN_SHIP_TO
 *   merge    the emptied DRAFT CANCELLED "Merged into …", never deleted; the order read says so
 *   walls    the real Sales template is refused every act; a person limited to Brand Beta finds nothing of Alpha's
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string
let seedA: ShippingSeed

const ns = 'consolidate'
const idOf = (key: string) => seedUuid(ns, key)
const A = { tenant: idOf('tenant'), companyA: idOf('company:A'), siteA1: idOf('site:A1'), alpha: idOf('party:P1') }
const beta = newId()

const ALL: Permission[] = ['shipping.view', 'shipping.manage', 'shipping.pack', 'shipping.settings.view', 'shipping.settings.manage']
const grant = (permissions: Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants })
const sales = templateOf('sales')!
const SESSIONS: Record<string, SessionContext> = {
  warehouse: office([grant([...ALL, 'orders.view', 'orders.manage', 'shipping.holds.manage'])]),
  // The real Sales template (no grain): it reads, it never plans.
  sales: office([grant([...sales.permissions, ...sales.grains.map((grain) => grainPermission(grain) as Permission)])]),
  // A person limited to Brand Beta (B's view of A's records: as unknown ones).
  betaOnly: office([grant([...ALL, 'orders.view', 'shipping.holds.manage'], [beta])]),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
/** Past the guards (the world's made-up facts only: never what the test then proves). */
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
/** A 409 refusal: its issue path `refusal/<CODE>`. */
async function refusedFor(session: string, method: Method, url: string, payload: unknown, code: string): Promise<Json> {
  const error = await refused(session, method, url, payload, 409)
  expect(error.issues?.[0]?.path, JSON.stringify(error)).toBe(`refusal/${code}`)
  return error
}

/** A version-4 UUID derived from an id and a salt (the copies' ids are valid UUIDs, as the contracts ask). */
const v4 = (expression: string, salt: string): string => {
  const hash = `md5(${expression}::text || '${salt}')`
  return `(substr(${hash}, 1, 8) || '-' || substr(${hash}, 9, 4) || '-4' || substr(${hash}, 14, 3) || '-8' || substr(${hash}, 18, 3) || '-' || substr(${hash}, 21, 12))::uuid`
}
/** An order copied as `number` for `partyId` (its lines and sizes too). */
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
const cell = (key: 'BLK-52' | 'BLK-54' | 'RED-50' | 'RED-54') => seedA.quality.production.cellIds[key]
const orderId = async (number: string): Promise<string> => (await admin<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = $2`, [A.tenant, number]))[0]!.id
const shipmentOf = async (id: string): Promise<Json> => (await ok('warehouse', 'GET', `/shipping/shipments/${id}`)).shipment
const lineOf = (shipment: Json, cellId: string): Json => (shipment.lines as Json[]).find((line) => line.workOrderSizeId === cellId)!
const holdsOf = async (shipmentId: string) => (await admin<{ reason: string }>(`SELECT reason::text AS reason FROM "ShipmentHold" WHERE "shipmentId" = $1 AND "releasedAt" IS NULL ORDER BY reason`, [shipmentId])).map((row) => row.reason)
const ids: Record<string, string> = {}

beforeAll(async () => {
  db = await migratedDatabase('consolidate')
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
  // SO-ALPHA-2 goes to another address of Brand Alpha (a DRAFT made for it then goes there too: the join rules' SHIP_TO).
  await force(`UPDATE "SalesOrder" SET "shipTo" = jsonb_build_object('name', 'Brand Alpha store', 'line1', 'Via Altrove 9', 'postalCode', '00099', 'city', 'Altrove', 'country', 'IT') WHERE id = $1`, [ids.alpha2])
  // Four more of WO-0001's garments released (copies of the seeded BLK 52 release): BLK 52, BLK 54, RED 50, RED 54 — so SEED-SO-0002
  // has BLK 52 ×2, BLK 54, RED 50 and RED 54 to plan (its BLK 50 and RED 52 left on SEED-SH-0001).
  for (const [index, key] of (['BLK-52', 'BLK-54', 'RED-50', 'RED-54'] as const).entries()) {
    await force(
      `INSERT INTO "QualityRelease" SELECT * FROM jsonb_populate_record(NULL::"QualityRelease", (SELECT to_jsonb(r) || jsonb_build_object('id', $1::uuid, 'number', $2::text, 'workOrderSizeId', $3::uuid, 'quantity', 1) FROM "QualityRelease" r WHERE id = $4))`,
      [newId(), `SEED-REL-OS-${index + 1}`, cell(key), seedA.quality.releaseIds['BLK-52']],
    )
  }
  if ((await admin(`SELECT 1 FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2'`, [A.tenant])).length === 0) {
    await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), A.tenant])
  }
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-consolidate-test-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 180_000)

afterAll(async () => {
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

// ---- B-OS-010 (X1 S1, D1): one DRAFT into three new shipments in one go ----------------------------------------------------
describe('B-OS-010: split into several shipments in ONE command', () => {
  it('a held DRAFT of SEED-SO-0002 into three (a line giving to two of them): each with its garments and the hold; one shipment.split each', async () => {
    const parent = (
      await ok('warehouse', 'POST', '/shipping/shipments', { salesOrderId: so2(), siteId: A.siteA1, lines: [{ workOrderSizeId: cell('BLK-52'), quantity: 2 }, { workOrderSizeId: cell('BLK-54'), quantity: 1 }, { workOrderSizeId: cell('RED-50'), quantity: 1 }, { workOrderSizeId: cell('RED-54'), quantity: 1 }] }, 201)
    ).shipment
    ids.parent = parent.id
    await ok('warehouse', 'POST', `/shipping/shipments/${parent.id}/holds`, { reason: 'CUSTOMER_REQUEST', words: 'Seed: the customer asked us to wait for the rest.' }, 201)
    const current = await shipmentOf(parent.id)
    const [blk52, blk54, red50, red54] = [lineOf(current, cell('BLK-52')).id, lineOf(current, cell('BLK-54')).id, lineOf(current, cell('RED-50')).id, lineOf(current, cell('RED-54')).id]
    const url = `/shipping/shipments/${parent.id}/split`

    // Never more than may move of a line over every new shipment; never lines and groups both.
    const over = await refused('warehouse', 'POST', url, { version: current.version, groups: [{ reason: 'PART_READY', lines: [{ lineId: blk52, quantity: 2 }] }, { reason: 'OTHER', lines: [{ lineId: blk52, quantity: 1 }] }] }, 400)
    expect(over.issues.map((issue: Json) => issue.path)).toEqual(['body/groups/0/lines/0/quantity', 'body/groups/1/lines/0/quantity'])
    expect((await refused('warehouse', 'POST', url, { version: current.version, reason: 'OTHER', lines: [{ lineId: blk54, quantity: 1 }], groups: [{ reason: 'OTHER', lines: [{ lineId: red50, quantity: 1 }] }] }, 400)).issues[0].path).toBe('body/groups')

    const split = await ok(
      'warehouse',
      'POST',
      url,
      {
        version: current.version,
        groups: [
          { reason: 'PART_READY', lines: [{ lineId: blk52, quantity: 1 }] },
          { reason: 'CUSTOMER_REQUEST', lines: [{ lineId: red50, quantity: 1 }, { lineId: red54, quantity: 1 }] },
          { reason: 'OTHER', lines: [{ lineId: blk52, quantity: 1 }] },
        ],
      },
      201,
    )
    const children = split.shipments as Json[]
    expect(children).toHaveLength(3)
    expect(split.shipment.id).toBe(children[0]!.id)
    ;[ids.child1, ids.child2, ids.child3] = children.map((child) => child.id as string)
    expect(children.map((child) => (child.lines as Json[]).map((line) => [line.workOrderSizeId, line.quantity]).sort())).toEqual([
      [[cell('BLK-52'), 1]],
      [[cell('RED-50'), 1], [cell('RED-54'), 1]].sort(),
      [[cell('BLK-52'), 1]],
    ])
    // The parent keeps its BLK 54 (something stays); the BLK 52 line gave to two new shipments.
    expect((split.from.lines as Json[]).map((line) => [line.workOrderSizeId, line.quantity])).toEqual([[cell('BLK-54'), 1]])
    expect(await admin(`SELECT "splitFromId"::text AS "from", "splitReason" AS reason FROM "Shipment" WHERE id = ANY($1::uuid[]) ORDER BY number`, [children.map((child) => child.id)])).toEqual([
      { from: parent.id, reason: 'PART_READY' },
      { from: parent.id, reason: 'CUSTOMER_REQUEST' },
      { from: parent.id, reason: 'OTHER' },
    ])
    // Each new shipment carries the hold it was under; one shipment.split per new shipment.
    for (const child of children) expect(await holdsOf(child.id), child.number).toEqual(['CUSTOMER_REQUEST'])
    expect(await admin(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'shipment.split' AND (payload->>'splitFromId') = $1`, [parent.id])).toEqual([{ n: 3 }])
  })
})
// ---- end B-OS-010

// ---- B-OS-013 (X1 S4): take SEED-SO-0003 off a shared DRAFT in one command ------------------------------------------------
describe('B-OS-013: take an order off a shared DRAFT in ONE command', () => {
  it('never its first order, never garments in a carton; then every line of the order comes off at once (orders_changed REMOVED)', async () => {
    const shared = (await ok('warehouse', 'POST', '/shipping/shipments', { salesOrderId: so2(), siteId: A.siteA1 }, 201)).shipment
    ids.shared = shared.id
    // SEED-SO-0003's free jacket joins it (the customer's other order, the same address and terms).
    const joined = (await ok('warehouse', 'POST', `/shipping/shipments/${shared.id}/lines`, { version: shared.version, lines: [{ workOrderSizeId: seedA.quality.serialCellId, quantity: 1 }] })).shipment
    const jacketLine = lineOf(joined, seedA.quality.serialCellId)
    const takeOff = (orderId: string) => `/shipping/shipments/${shared.id}/orders/${orderId}/take-off`
    const reason = 'Seed: the customer wants SEED-SO-0003 later.'

    await refusedFor('warehouse', 'POST', takeOff(so2()), { version: joined.version, reason }, 'FIRST_ORDER')
    // An unknown order and another customer's: the same not-found (the brand wall).
    const unknown = await refused('warehouse', 'POST', takeOff(newId()), { version: joined.version, reason }, 404)
    expect((await refused('warehouse', 'POST', takeOff(ids.beta1!), { version: joined.version, reason }, 404)).message).toBe(unknown.message)
    // The jacket in a carton (made up past the guards): it comes out of the carton first.
    const parcelId = (await ok('warehouse', 'POST', `/shipping/packing/${shared.id}/parcels`, {}, 201)).parcelId as string
    const contents = newId()
    await force(`INSERT INTO "ParcelLine" (id, "tenantId", "siteId", "partyId", "shipmentId", "parcelId", "shipmentLineId", size, quantity) SELECT $1, "tenantId", "siteId", "partyId", "shipmentId", $2, id, size, 1 FROM "ShipmentLine" WHERE id = $3`, [contents, parcelId, jacketLine.id])
    await refusedFor('warehouse', 'POST', takeOff(so3()), { version: (await shipmentOf(shared.id)).version, reason }, 'IN_CARTON')
    await force(`DELETE FROM "ParcelLine" WHERE id = $1`, [contents])

    const off = await ok('warehouse', 'POST', takeOff(so3()), { version: (await shipmentOf(shared.id)).version, reason })
    expect(off.takenOff).toEqual({ salesOrderId: so3(), lines: 1, garments: 1 })
    expect(off.shipment.lines).toEqual([])
    expect(off.shipment.salesOrders.map((order: Json) => order.id)).toEqual([so2()])
    expect(await admin(`SELECT reason, after->>'garments' AS garments FROM "AuditLog" WHERE "recordType" = 'Shipment' AND "recordId" = $1 AND action = 'shipping.takeOff'`, [shared.id])).toEqual([{ reason, garments: '1' }])
    const changes = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'shipment.orders_changed' AND subject = $1 ORDER BY "occurredAt", id`, [shared.id])
    expect(changes.map((row) => row.payload.change)).toEqual(['ADDED', 'REMOVED'])
    // Nothing of it is left on it.
    await refusedFor('warehouse', 'POST', takeOff(so3()), { version: off.shipment.version, reason }, 'NOT_ON_IT')
  })
})
// ---- end B-OS-013

// ---- B-OS-011 (X1 S2): garments onto another DRAFT of the same customer ----------------------------------------------------
describe('B-OS-011: move garments to another DRAFT, by the join rules of the target', () => {
  it('the targets: the other DRAFTs of the customer and site, each with its verdict for every order; never another customer’s', async () => {
    ids.elsewhere = (await ok('warehouse', 'POST', '/shipping/shipments', { salesOrderId: ids.alpha2, siteId: A.siteA1 }, 201)).shipment.id
    ids.betaDraft = (await ok('warehouse', 'POST', '/shipping/shipments', { salesOrderId: ids.beta1, siteId: A.siteA1 }, 201)).shipment.id
    const read = await ok('warehouse', 'GET', `/shipping/shipments/${ids.child2}/move-targets`)
    const target = (id: string) => (read.targets as Json[]).find((row) => row.id === id)
    expect(target(ids.shared!)).toMatchObject({ orders: [{ id: so2() }], garments: 0, verdicts: [{ orderId: so2(), allowed: true, code: null, why: null }] })
    expect(target(ids.child1!)).toMatchObject({ garments: 1, verdicts: [{ orderId: so2(), allowed: true }] })
    // SO-ALPHA-2's draft goes to another address: SEED-SO-0002's garments may not join it.
    expect(target(ids.elsewhere!)).toMatchObject({ orders: [{ id: ids.alpha2 }], verdicts: [{ orderId: so2(), allowed: false, code: 'SHIP_TO' }] })
    expect(target(ids.child2!)).toBeUndefined()
    expect(JSON.stringify(read)).not.toContain(ids.betaDraft)
    expect(JSON.stringify(read)).not.toContain('SO-BETA-1')
  })

  it('refused in words: another address (JOIN_SHIP_TO), everything (use Merge), itself, a stale target, another customer’s target', async () => {
    const source = await shipmentOf(ids.child2!)
    const [red50, red54] = [lineOf(source, cell('RED-50')).id, lineOf(source, cell('RED-54')).id]
    const url = `/shipping/shipments/${ids.child2}/move`
    const shared = await shipmentOf(ids.shared!)
    const elsewhere = await shipmentOf(ids.elsewhere!)
    await refusedFor('warehouse', 'POST', url, { version: source.version, toShipmentId: ids.elsewhere, toVersion: elsewhere.version, lines: [{ lineId: red50, quantity: 1 }], reason: 'SHIP_TO' }, 'JOIN_SHIP_TO')
    await refusedFor('warehouse', 'POST', url, { version: source.version, toShipmentId: ids.shared, toVersion: shared.version, lines: [{ lineId: red50, quantity: 1 }, { lineId: red54, quantity: 1 }], reason: 'OTHER' }, 'NOTHING_STAYS')
    await refusedFor('warehouse', 'POST', url, { version: source.version, toShipmentId: ids.child2, lines: [{ lineId: red50, quantity: 1 }], reason: 'OTHER' }, 'SAME')
    expect((await refused('warehouse', 'POST', url, { version: source.version, toShipmentId: ids.shared, toVersion: shared.version + 5, lines: [{ lineId: red50, quantity: 1 }], reason: 'OTHER' }, 409)).code).toBe('conflict')
    const unknown = await refused('warehouse', 'POST', url, { version: source.version, toShipmentId: newId(), lines: [{ lineId: red50, quantity: 1 }], reason: 'OTHER' }, 404)
    expect((await refused('warehouse', 'POST', url, { version: source.version, toShipmentId: ids.betaDraft, lines: [{ lineId: red50, quantity: 1 }], reason: 'OTHER' }, 404)).message).toBe(unknown.message)
    // Nothing moved.
    expect(((await shipmentOf(ids.child2!)).lines as Json[]).map((line) => line.quantity)).toEqual([1, 1])
  })

  it('RED 50 moves onto the shared draft in one command: both versions move, the hold comes along, garments_moved once', async () => {
    const source = await shipmentOf(ids.child2!)
    const target = await shipmentOf(ids.shared!)
    const moved = await ok('warehouse', 'POST', `/shipping/shipments/${ids.child2}/move`, {
      version: source.version,
      toShipmentId: ids.shared,
      toVersion: target.version,
      lines: [{ lineId: lineOf(source, cell('RED-50')).id, quantity: 1 }],
      reason: 'CUSTOMER_REQUEST',
      words: 'Seed: the red ones travel together.',
    })
    expect(moved.moved).toEqual({ lines: 1, garments: 1, merged: false })
    expect((moved.shipment.lines as Json[]).map((line) => [line.workOrderSizeId, line.quantity])).toEqual([[cell('RED-50'), 1]])
    expect((moved.from.lines as Json[]).map((line) => [line.workOrderSizeId, line.quantity])).toEqual([[cell('RED-54'), 1]])
    expect(moved.shipment.version).toBeGreaterThan(target.version)
    expect(moved.from.version).toBeGreaterThan(source.version)
    // The source's hold in force is carried (the shared draft had none).
    expect(await holdsOf(ids.shared!)).toEqual(['CUSTOMER_REQUEST'])
    const events = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'shipment.garments_moved' AND subject = $1`, [ids.child2])
    expect(events.map((row) => row.payload)).toEqual([{ shipmentId: ids.child2, number: source.number, toShipmentId: ids.shared, toNumber: target.number, merged: false, lines: 1, garments: 1, partyId: A.alpha }])
    expect(await admin(`SELECT "recordId"::text AS id, reason FROM "AuditLog" WHERE action = 'shipping.moveLines' AND "recordId"::text = ANY($1::text[]) ORDER BY "recordId"::text`, [[ids.child2, ids.shared]])).toEqual(
      [ids.child2, ids.shared].sort().map((id) => ({ id, reason: 'Seed: the red ones travel together.' })),
    )
  })
})
// ---- end B-OS-011

// ---- B-OS-012 (X1 S3): merge a DRAFT into another ---------------------------------------------------------------------------
describe('B-OS-012: merge a DRAFT into another', () => {
  it('every garment moves (a line of the same cell grows); the emptied DRAFT is CANCELLED "Merged into …", never deleted; the order read says so', async () => {
    const source = await shipmentOf(ids.child3!)
    const target = await shipmentOf(ids.child1!)
    const merged = await ok('warehouse', 'POST', `/shipping/shipments/${ids.child3}/merge`, { version: source.version, intoShipmentId: ids.child1, intoVersion: target.version })
    expect(merged.moved).toEqual({ lines: 1, garments: 1, merged: true })
    expect((merged.shipment.lines as Json[]).map((line) => [line.workOrderSizeId, line.quantity])).toEqual([[cell('BLK-52'), 2]])
    expect(merged.from).toMatchObject({ id: ids.child3, status: 'CANCELLED', cancelReason: `Merged into ${target.number}` })
    expect(merged.from.lines).toEqual([])
    expect(await admin(`SELECT status::text AS status FROM "Shipment" WHERE id = $1`, [ids.child3])).toEqual([{ status: 'CANCELLED' }])
    // Its hold was carried (the target held it already: one in force) and released on the cancelled one.
    expect(await holdsOf(ids.child3!)).toEqual([])
    expect(await holdsOf(ids.child1!)).toEqual(['CUSTOMER_REQUEST'])
    expect((await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'shipment.garments_moved' AND subject = $1`, [ids.child3])).map((row) => row.payload.merged)).toEqual([true])
    expect((await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'shipment.status_changed' AND subject = $1`, [ids.child3])).map((row) => row.payload.to)).toEqual(['CANCELLED'])
    // B-OS-001: the order read's row names the shipment it was merged into.
    const { order } = await ok('warehouse', 'GET', `/sales/orders/${so2()}`)
    expect((order.chain.shipments as Json[]).find((row) => row.id === ids.child3)).toMatchObject({ status: 'CANCELLED', cancelReason: `Merged into ${target.number}`, mergedInto: { id: ids.child1, number: target.number } })
    // A cancelled draft gives nothing more.
    await refusedFor('warehouse', 'POST', `/shipping/shipments/${ids.child3}/merge`, { intoShipmentId: ids.child1 }, 'NOT_DRAFT')
  })
})
// ---- end B-OS-012

// ---- S2.5 walls (13-backend §4): the real Sales template is refused every act (no shipping.manage) and reads no amount; a person
// limited to Brand Beta gets, on every act of S2 over Alpha's shipments, the same not-found as for an unknown id ------------------
describe('S2 walls: the real Sales template, and a person limited to another customer', () => {
  const acts = (shipmentId: string, other: string) => [
    { method: 'POST' as const, url: `/shipping/shipments/${shipmentId}/split`, body: { reason: 'OTHER', lines: [{ lineId: newId(), quantity: 1 }] } },
    { method: 'POST' as const, url: `/shipping/shipments/${shipmentId}/move`, body: { toShipmentId: other, lines: [{ lineId: newId(), quantity: 1 }], reason: 'OTHER' } },
    { method: 'POST' as const, url: `/shipping/shipments/${shipmentId}/merge`, body: { intoShipmentId: other } },
    { method: 'POST' as const, url: `/shipping/shipments/${shipmentId}/orders/${so3()}/take-off`, body: { reason: 'Seed: not now.' } },
    { method: 'POST' as const, url: `/shipping/shipments/${shipmentId}/ship`, body: { shippedAt: new Date().toISOString() } },
    { method: 'PUT' as const, url: `/shipping/shipments/${shipmentId}/ddt-required`, body: { required: false, reason: 'Seed: an immediate invoice travels.' } },
    { method: 'PUT' as const, url: `/shipping/shipments/${shipmentId}/eta`, body: { expectedDeliveryAt: new Date(Date.now() + 86_400_000).toISOString() } },
    { method: 'POST' as const, url: `/shipping/shipments/${shipmentId}/own-transport/events`, body: { status: 'DELIVERED', reason: 'Seed: signed by hand.' } },
  ]

  it('the real Sales template: every S2 act 403 (it reads the targets, with no amount); nothing changed', async () => {
    const before = await shipmentOf(ids.child1!)
    for (const act of acts(ids.child1!, ids.shared!)) expect((await call('sales', act.method, act.url, act.body)).statusCode, `${act.method} ${act.url}`).toBe(403)
    const targets = await ok('sales', 'GET', `/shipping/shipments/${ids.child2}/move-targets`)
    expect(JSON.stringify(targets)).not.toMatch(/freight|declaredValue|insuredValue|price|amount/i)
    expect((await shipmentOf(ids.child1!)).version).toBe(before.version)
  })

  it('a person limited to Brand Beta: the targets and every act on Alpha’s shipments answer as an unknown shipment', async () => {
    const unknownId = newId()
    const unknown = (await call('betaOnly', 'GET', `/shipping/shipments/${unknownId}/move-targets`)).json().error
    expect((await call('betaOnly', 'GET', `/shipping/shipments/${ids.child2}/move-targets`)).json().error).toMatchObject({ code: 'not_found', message: unknown.message })
    for (const act of acts(ids.child1!, ids.shared!)) {
      const response = await call('betaOnly', act.method, act.url, act.body)
      expect(response.statusCode, `${act.method} ${act.url}`).toBe(404)
      expect(response.json().error.message, `${act.method} ${act.url}`).toBe(unknown.message)
    }
    // From Brand Beta's own draft, Alpha's shipment is no target either (its id answers as unknown).
    const betaDraft = await ok('warehouse', 'GET', `/shipping/shipments/${ids.betaDraft}`)
    expect((await refused('betaOnly', 'POST', `/shipping/shipments/${ids.betaDraft}/merge`, { version: betaDraft.shipment.version, intoShipmentId: ids.child1 }, 404)).message).toBe(unknown.message)
    expect(JSON.stringify(await ok('betaOnly', 'GET', `/shipping/shipments/${ids.betaDraft}/move-targets`))).not.toContain(ids.child1)
  })
})
// ---- end S2.5 walls
