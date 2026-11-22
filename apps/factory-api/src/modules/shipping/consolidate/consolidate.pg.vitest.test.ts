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
