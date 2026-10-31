import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedHolds } from '../../../../../../packages/factory-db/seed/holds'
import { seed as seedReturns, type ReturnsSeed } from '../../../../../../packages/factory-db/seed/returns'
import { seed as seedSchedule, type ScheduleSeed } from '../../../../../../packages/factory-db/seed/schedule'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../../adapters/local-files/local'
import { FakeSendcloud } from '../../../adapters/sendcloud/fake'
import { sendcloudAdapter } from '../../../adapters/sendcloud/sendcloud'
import { buildApp } from '../../../core/app'
import { callerFor, command } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { createFilesRuntime, useFiles } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService, type SecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'
import { SECRET_PURPOSES, storeSecret } from '../../../platform/secrets/store'
import { fileTravelDocuments, TRAVEL_DOCUMENT_PERMISSIONS } from '../documents/testing/compliance'
import { createCarrierRuntime, useCarrier } from '../labels/carrier'

/**
 * Shipping every day (B-W2a-48; LOG-004, LOG-012, LOG-028, LOG-105, LOG-090; SCOPE W2a rules 1 and 3) on the local stack,
 * with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level
 * security, the grants, the shipping, production and money triggers are real), the factory-db seeds of two tenants up to
 * the holds (plant A1's freight rule) and the schedule (A1-FG and SEED-JKT-02-BLK-52's finished-goods item), company A's
 * FAKE Sendcloud account, the gateway, the local file store. Every name and number is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs shipments/daily`.
 *
 *   partial    SO-0002's last released BLK 52 into finished goods, then on SB, a shipment of part of the order: the
 *              backorder per line and size, the list of orders with a backorder, the ready list a page at a time
 *   packing    the packing list per version (the same packing prints the same file; a new weight makes version 2)
 *   leaving    an order line closed short after packing stops it; reopened, SB leaves: the garment out of finished
 *              goods (one ADJUSTMENT out of A1-FG with the work order), the freight by the site's rule, counted once by
 *              "Report finished to stock"
 *   freight    the site's rule (the price grain to read and write it), the office's charge and back to the rule
 *   labels     SH-0002 (two parcels, labels bought): the carrier has parcel 2 already, so "void all" voids parcel 1
 *              only, and the single void of parcel 2 says why
 *   evidence   SH-0002 sold zero-rated to a business in Germany: AWAITED when it leaves, PARTIAL with the proof of
 *              delivery, COMPLETE refused with one paper, complete with the CMR, reopened
 *   caps       (tenant B) an order line never ships more than ordered, a closed-short line nothing more, a repair cell
 *              never
 *
 * W2b (B-W2b-19, the W2a follow-ups): the garment leaves as a SHIPMENT move naming its line; the packing list versions are
 * GeneratedDocument rows (contents back to version 1 make version 3 with version 1's file); the freight basis column and
 * the carrier's freight cost (the cost grain); the paper's kind as the file's category; the voided labels in the labels
 * read; the mode of transport and the DDT's language; a repair cell's line never grows; a carrier-returned shipment's
 * garment back into finished goods.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string
let secrets: SecretsService
let fake: FakeSendcloud
let returnsA: ReturnsSeed
let returnsB: ReturnsSeed
let scheduleA: ScheduleSeed
let accountId: string

const ns = { a: 'daily-ship-a', b: 'daily-ship-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const A = { tenant: idOf(ns.a, 'tenant'), companyA: idOf(ns.a, 'company:A'), companyB: idOf(ns.a, 'company:B'), siteA1: idOf(ns.a, 'site:A1') }
const B = { tenant: idOf(ns.b, 'tenant'), companyA: idOf(ns.b, 'company:A') }
const YEAR = businessDate(new Date()).slice(0, 4)

const SHIPPING: Permission[] = ['shipping.view', 'shipping.manage', 'shipping.pack', 'shipping.settings.view', 'shipping.ddt.issue', 'shipping.ddt.cancel', 'shipping.labels.buy', 'shipping.labels.void']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  warehouse: office(A.tenant, [grant([...SHIPPING, 'shipping.evidence.manage', 'files.read', 'files.upload'])]),
  finance: office(A.tenant, [grant(['shipping.view', 'shipping.settings.view', 'shipping.freight.manage', 'shipping.evidence.manage', 'files.read', 'files.upload', 'money.price'])]),
  // The price grain, but not the freight permission.
  pricedViewer: office(A.tenant, [grant(['shipping.view', 'shipping.settings.view', 'money.price'])]),
  viewer: office(A.tenant, [grant(['shipping.view', 'shipping.settings.view'])]),
  companyB: office(A.tenant, [grant([...SHIPPING, 'shipping.freight.manage', 'money.price'], [A.companyB])]),
  production: office(A.tenant, [grant(['workorders.view', 'workorders.manage', 'production.finish', 'inventory.stock.view'])]),
  sales: office(A.tenant, [grant(['orders.view', 'orders.manage'])]),
  quality: office(A.tenant, [grant(TRAVEL_DOCUMENT_PERMISSIONS)]),
  warehouseB: office(B.tenant, [grant([...SHIPPING, 'files.read'])]),
  /** B-W2b-19: a SHIPMENT move is never reversed on its own. */
  reverser: office(A.tenant, [grant(['inventory.reverse', 'inventory.stock.view'])]),
  /** B-W2b-19: the carrier's freight cost needs the cost grain too. */
  freightCost: office(A.tenant, [grant(['shipping.view', 'shipping.freight.manage', 'money.cost'])]),
  /** Finance's standards (B-W2a-21): the shipped garment's frozen standard (B-W2a-F7). */
  costing: office(A.tenant, [grant(['costing.view', 'costing.standards.manage', 'money.cost'])]),
  plannerB: office(B.tenant, [grant(['workorders.view', 'workorders.manage'])]),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const call = (session: string, method: Method, url: string, payload?: unknown, idempotencyKey?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, idempotencyKey?: string): Promise<Json> {
  const response = await call(session, method, url, payload, idempotencyKey)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const key = () => `daily-ship-${run}-${++keys}`
/** A write past the database's guards (the seed's facts only: never what the test then proves). */
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
/** The value the stock ledger gave a move (none: not valued). */
const valuationOf = async (moveId: string) => (await admin<{ method: string; unitCost: string; valueAmount: number }>(`SELECT method::text, "unitCost"::text AS "unitCost", "valueAmount" FROM "StockValuation" WHERE "moveId" = $1`, [moveId]))[0] ?? null
const fromStockMove = async (shipmentId: string) => (await admin<{ id: string }>(`SELECT id FROM "StockMove" WHERE "idempotencyKey" = $1`, [`shipping.fromStock:${shipmentId}:1`]))[0]!.id

async function addAccount(tenantId: string, companyId: string): Promise<string> {
  const id = newId()
  await command(callerFor(database, { audience: 'office', tenantId, actorId: newId(), grants: [], requestId: newId() }), { name: 'integration.createAccount', input: { id } }, async (tools) => {
    const webhook = await storeSecret(tools, secrets, { purpose: SECRET_PURPOSES.webhook, plaintext: 'made-up-webhook-secret' })
    await tools.tx.integrationAccount.create({
      data: { id, provider: 'SENDCLOUD', code: `sc-${id.slice(-12)}`, label: 'Sendcloud (test)', mode: 'FAKE', companyId, webhookSecretId: webhook.id, rateLimitPerMinute: 6000, rateLimitBurst: 1000 },
      select: { id: true },
    })
    tools.audit({ recordType: 'IntegrationAccount', recordId: id })
    return { id }
  })
  return id
}

/** Announces a paper, PUTs its bytes to the store, and confirms it. */
async function filePaper(session: string, shipmentId: string, kind: string, name: string) {
  const body = Buffer.from(`%PDF-1.4 made-up ${kind} ${name}`)
  const announced = await ok(session, 'POST', `/shipping/shipments/${shipmentId}/evidence/papers`, { kind, originalName: name, contentType: 'application/pdf', sizeBytes: body.length, sha256: createHash('sha256').update(body).digest('hex') }, 201, key())
  const put = await app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: body })
  expect(put.statusCode, put.body).toBe(200)
  return ok(session, 'POST', `/shipping/shipments/${shipmentId}/evidence/papers/${announced.file.id}/complete`, {})
}

beforeAll(async () => {
  db = await migratedDatabase('daily_ship')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 12 } })
  for (const namespace of [ns.a, ns.b]) await seedCore({ db: database, namespace })
  returnsA = await seedReturns({ db: database, namespace: ns.a })
  await seedHolds({ db: database, namespace: ns.a })
  scheduleA = await seedSchedule({ db: database, namespace: ns.a })
  returnsB = await seedReturns({ db: database, namespace: ns.b })
  await seedSchedule({ db: database, namespace: ns.b })
  for (const [tenantId, companyId] of [
    [A.tenant, A.companyA],
    [B.tenant, B.companyA],
  ] as const) {
    await admin(`UPDATE "Company" SET "vatNumber" = 'IT12345670009', "fiscalCode" = '12345670009', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyId])
    await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'SHIPMENT', 'MAIN', 'ALL', 'NEVER', 'SH-{N:5}', false) ON CONFLICT DO NOTHING`, [newId(), tenantId, companyId])
    await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'DDT', 'MAIN', $4, 'YEARLY', '{N}/{YYYY}', true) ON CONFLICT DO NOTHING`, [newId(), tenantId, companyId, YEAR])
    await admin(`UPDATE "NumberSeries" SET "lastIssuedDate" = NULL WHERE "tenantId" = $1 AND kind = 'DDT'`, [tenantId])
    if ((await admin(`SELECT 1 FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2'`, [tenantId])).length === 0) {
      await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenantId])
    }
    await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [tenantId])
  }
  secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  accountId = await addAccount(A.tenant, A.companyA)
  await admin(`UPDATE "ShippingSettings" SET "integrationAccountId" = $1 WHERE id = $2`, [accountId, A.siteA1])
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-daily-ship-test-'))
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  fake = new FakeSendcloud()
  const noNetwork = (async () => {
    throw new Error('a test never reaches the network')
  }) as typeof fetch
  useCarrier(createCarrierRuntime({ gateway, environment: 'test', fake, remote: sendcloudAdapter({ fetch: noNetwork }) }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
      logger: false,
    },
  )
  const quality = returnsA.money.shipping.quality
  await fileTravelDocuments(app, 'quality', quality.serialStyleId, quality.serialRevisionId)
  await fileTravelDocuments(app, 'quality', quality.production.styleId, quality.production.revisionId)
}, 240_000)

afterAll(async () => {
  useFiles(undefined)
  useCarrier(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

const qa = () => returnsA.money.shipping.quality
const so2 = () => qa().production.salesOrderId
const wo1 = () => qa().production.workOrderId
const blk52 = () => qa().production.cellIds['BLK-52']
const sh2 = () => returnsA.money.shipping.draftShipmentId
const S: Record<string, string> = {}
const sizeOf = (backorder: Json, colourway: string, size: string) => (backorder.lines as Json[]).find((line) => line.colourwayCode === colourway)!.sizes.find((entry: Json) => entry.size === size)

describe('the freight rule of a site (LOG-105): a price, set with its grain', () => {
  it('reads the seeded rule; a reader without the price grain sees the rule, not its amounts', async () => {
    const seeded = await ok('finance', 'GET', `/shipping/sites/${A.siteA1}/freight-rule`)
    expect(seeded.freight).toMatchObject({ rule: 'PER_SHIPMENT', amount: 1200, freeFrom: 50_000, currency: 'EUR' })
    const blind = await ok('viewer', 'GET', `/shipping/sites/${A.siteA1}/freight-rule`)
    expect(blind.freight.rule).toBe('PER_SHIPMENT')
    expect(blind.freight).not.toHaveProperty('amount')
    expect(blind.freight).not.toHaveProperty('freeFrom')
  })

  it('refuses a rule from someone without the permission, a body with amounts without the grain, a bad rule; saves 7.00 per parcel', async () => {
    expect((await refused('pricedViewer', 'PUT', `/shipping/sites/${A.siteA1}/freight-rule`, { rule: 'PER_PARCEL', amount: 700 }, 403)).code).toBe('forbidden')
    expect((await refused('warehouse', 'PUT', `/shipping/sites/${A.siteA1}/freight-rule`, { rule: 'PER_PARCEL', amount: 700 }, 403)).code).toBe('forbidden')
    const bad = await refused('finance', 'PUT', `/shipping/sites/${A.siteA1}/freight-rule`, { rule: 'NONE', amount: 700 }, 400)
    expect(bad.issues).toEqual([{ path: 'body/amount', message: 'A site that charges no freight has no amount: leave it out, or choose a rule.' }])
    const saved = await ok('finance', 'PUT', `/shipping/sites/${A.siteA1}/freight-rule`, { rule: 'PER_PARCEL', amount: 700, freeFrom: null })
    expect(saved.freight).toMatchObject({ rule: 'PER_PARCEL', amount: 700, freeFrom: null })
    const audit = await admin(`SELECT after FROM "AuditLog" WHERE action = 'shipping.saveFreightRule' AND "recordId" = $1`, [A.siteA1])
    expect(audit[0]!.after).toMatchObject({ freightRule: 'PER_PARCEL', freightAmount: { $money: 'price', value: 700 } })
    expect((await refused('companyB', 'GET', `/shipping/sites/${A.siteA1}/freight-rule`, undefined, 404)).code).toBe('not_found')
  })
})

describe('a partial shipment from finished-goods stock and its backorder (LOG-004)', () => {
  it("puts WO-0001's last released BLK 52 into finished goods; the ready list says it is in stock, a page at a time", async () => {
    const report = await ok('production', 'POST', `/production/work-orders/${wo1()}/finished`, { cells: [{ cellId: blk52(), quantity: 1 }] }, 201)
    expect(report.report.pieces).toBe(1)
    const ready = await ok('warehouse', 'GET', `/shipping/ready?salesOrderId=${so2()}`)
    expect(ready.orders).toHaveLength(1)
    expect(ready.orders[0].cells.find((cell: Json) => cell.workOrderSizeId === blk52())).toMatchObject({ shippable: 1, inStock: 1 })
    const first = await ok('warehouse', 'GET', '/shipping/ready?limit=1')
    expect(first.orders).toHaveLength(1)
    expect(first.nextCursor).toBe(first.orders[0].salesOrderId)
    const second = await ok('warehouse', 'GET', `/shipping/ready?limit=1&cursor=${first.nextCursor}`)
    expect(second.orders.map((order: Json) => order.salesOrderId)).not.toContain(first.orders[0].salesOrderId)
    expect((await ok('companyB', 'GET', '/shipping/ready')).orders).toEqual([])
  })

  it('plans SB with part of SO-0002: the backorder per line and size, and the list of orders with a backorder', async () => {
    const sb = (await ok('warehouse', 'POST', '/shipping/shipments', { salesOrderId: so2(), lines: [{ workOrderSizeId: blk52(), quantity: 1 }] }, 201)).shipment
    S.sb = sb.id
    // The freight is not decided while it is planned: the rule's figure is shown (with the grain), the charge is null.
    const priced = (await ok('finance', 'GET', `/shipping/shipments/${sb.id}`)).shipment
    expect(priced.freight).toMatchObject({ charge: null, byHand: false, byRule: { basis: expect.any(String) } })
    // B-W2b-19: no charge decided, so no basis; nothing recorded of the transport yet.
    expect(await admin(`SELECT "freightBasis"::text AS basis, "transportMode"::text AS mode FROM "Shipment" WHERE id = $1`, [sb.id])).toEqual([{ basis: null, mode: null }])
    expect(priced).toMatchObject({ transportMode: null, freight: { cost: { currency: null } } })
    const blind = (await ok('warehouse', 'GET', `/shipping/shipments/${sb.id}`)).shipment
    expect(blind.freight).not.toHaveProperty('charge')
    expect(blind.freight.byRule).not.toHaveProperty('charge')

    const backorder = await ok('warehouse', 'GET', `/shipping/orders/${so2()}/backorder?shipmentId=${sb.id}`)
    expect(sizeOf(backorder, 'BLK', '52')).toMatchObject({ ordered: 2, thisShipment: 1, backorder: 1, readyNow: 0, inProduction: 1 })
    expect(sizeOf(backorder, 'BLK', '54')).toMatchObject({ ordered: 1, shipped: 0, thisShipment: 0, backorder: 1 })
    expect(backorder.totals.backorder).toBeGreaterThan(0)
    expect(backorder.words).toMatch(/stay(s)? on backorder/)
    expect(backorder.shipments.map((shipment: Json) => shipment.id)).toContain(sb.id)
    const listed = await ok('warehouse', 'GET', '/shipping/backorders')
    expect(listed.orders.map((order: Json) => order.salesOrderId)).toContain(so2())
    expect((await ok('warehouse', 'GET', '/shipping/backorders?limit=1')).orders).toHaveLength(1)
    expect((await ok('companyB', 'GET', '/shipping/backorders')).orders).toEqual([])
    expect((await refused('companyB', 'GET', `/shipping/orders/${so2()}/backorder`, undefined, 404)).code).toBe('not_found')
  })

  it('packs SB; the packing list prints once per packing (the same file again), a new weight makes version 2', async () => {
    S.sbParcel = (await ok('warehouse', 'POST', `/shipping/packing/${S.sb}/parcels`, { grossWeightKg: '2.5' }, 201)).parcelId
    const line = (await ok('warehouse', 'GET', `/shipping/shipments/${S.sb}`)).shipment.lines[0]
    S.sbLine = line.id
    await ok('warehouse', 'PUT', `/shipping/packing/${S.sb}/lines/${line.id}/parcel`, { parcelId: S.sbParcel })
    expect((await ok('warehouse', 'POST', `/shipping/packing/${S.sb}/pack`, {})).shipment.status).toBe('PACKED')
    const first = await ok('warehouse', 'POST', `/shipping/shipments/${S.sb}/packing-list`, {}, 201)
    expect(first).toMatchObject({ version: 1, reused: false })
    const again = await ok('warehouse', 'POST', `/shipping/shipments/${S.sb}/packing-list`, {}, 201)
    expect(again).toMatchObject({ version: 1, reused: true, file: { id: first.file.id } })
    await ok('warehouse', 'PATCH', `/shipping/packing/${S.sb}/parcels/${S.sbParcel}`, { grossWeightKg: '2.7' })
    const second = await ok('warehouse', 'POST', `/shipping/shipments/${S.sb}/packing-list`, {}, 201)
    expect(second).toMatchObject({ version: 2, reused: false })
    expect(second.number).toMatch(/\/2$/)
    expect(second.file.id).not.toBe(first.file.id)
    // B-W2b-19: back to version 1's weight: version 3, printed with version 1's file and number (the newest is current).
    await ok('warehouse', 'PATCH', `/shipping/packing/${S.sb}/parcels/${S.sbParcel}`, { grossWeightKg: '2.5' })
    const third = await ok('warehouse', 'POST', `/shipping/shipments/${S.sb}/packing-list`, {}, 201)
    expect(third).toMatchObject({ version: 3, reused: true, number: first.number, file: { id: first.file.id } })
    const lists = await ok('viewer', 'GET', `/shipping/shipments/${S.sb}/packing-lists`)
    expect(lists.packingLists.map((entry: Json) => [entry.version, entry.current, entry.parcels, entry.garments])).toEqual([
      [3, true, 1, 1],
      [2, false, 1, 1],
      [1, false, 1, 1],
    ])
    const rows = await admin(`SELECT version, "fileId", number, language, kind::text AS kind, "recordType" FROM "GeneratedDocument" WHERE "recordId" = $1 ORDER BY version`, [S.sb])
    expect(rows).toEqual([
      { version: 1, fileId: first.file.id, number: first.number, language: 'it', kind: 'PACKING_LIST', recordType: 'Shipment' },
      { version: 2, fileId: second.file.id, number: second.number, language: 'it', kind: 'PACKING_LIST', recordType: 'Shipment' },
      { version: 3, fileId: first.file.id, number: first.number, language: 'it', kind: 'PACKING_LIST', recordType: 'Shipment' },
    ])
    // The packers print the newest version's file (here version 1's again).
    const packing = await ok('warehouse', 'GET', `/shipping/packing/${S.sb}`)
    expect(packing.shipment.documents.packingList.fileId).toBe(first.file.id)
  })

  it('SAL-210: a line closed short after packing stops the shipment in words; reopened, SB leaves from finished goods', async () => {
    await ok('sales', 'POST', `/sales/orders/${so2()}/close-lines`, { version: await orderVersion(), reason: 'The customer takes no more black', lineIds: [await blkLine()] })
    const stopped = await refused('warehouse', 'POST', `/shipping/shipments/${S.sb}/ddt`, { ship: true }, 409)
    expect(stopped.message).toMatch(/the order line was closed short after these were planned/)
    expect(await admin(`SELECT 1 FROM "Ddt" WHERE "shipmentId" = $1`, [S.sb])).toEqual([])
    await ok('sales', 'POST', `/sales/orders/${so2()}/reopen-lines`, { version: await orderVersion(), reason: 'Back on', lineIds: [await blkLine()] })

    const left = await ok('warehouse', 'POST', `/shipping/shipments/${S.sb}/ddt`, { ship: true }, 201)
    expect(left.shipment.status).toBe('SHIPPED')
    const moves = await admin(
      `SELECT reason::text AS reason, "shipmentLineId", "fromLocationId", "toLocationId", "workOrderId", reference, note, "baseQuantity"::text AS quantity, "idempotencyKey" FROM "StockMove" WHERE "idempotencyKey" LIKE $1`,
      [`shipping.fromStock:${S.sb}:%`],
    )
    // B-W2b-19: a SHIPMENT move naming the shipment line (W2a posted an ADJUSTMENT).
    expect(moves).toEqual([
      { reason: 'SHIPMENT', shipmentLineId: S.sbLine, fromLocationId: scheduleA.finishedLocationId, toLocationId: null, workOrderId: wo1(), reference: left.shipment.number, note: expect.stringMatching(/^Shipped on .+ out of finished goods to the customer\.$/), quantity: '1.0000', idempotencyKey: `shipping.fromStock:${S.sb}:1` },
    ])
    // Never reversed on its own: the garment left with the shipment (a carrier return brings it back).
    const reverse = await refused('reverser', 'POST', `/inventory/moves/${await fromStockMove(S.sb!)}/reverse`, { note: 'Mistake' }, 409)
    expect(reverse.message).toBe("A shipment's move out of finished goods is not reversed: the garments left with the shipment (a carrier return brings them back into finished goods).")
    const leftAudit = await admin(`SELECT after FROM "AuditLog" WHERE action = 'shipping.left' AND "recordId" = $1`, [S.sb])
    expect(leftAudit[0]!.after.cells).toEqual([expect.objectContaining({ cellId: blk52(), garments: 1, fromStock: 1, fromRelease: 0 })])

    // "Report finished to stock" counts the garment once: received 1, on shipments from the release 0.
    const finished = await ok('production', 'GET', `/production/work-orders/${wo1()}/finished`)
    expect(finished.finished.cells.find((cell: Json) => cell.cellId === blk52())).toMatchObject({ inStock: 1, onShipments: 0, canReport: 0 })
    const stock = await ok('production', 'GET', `/inventory/finished?workOrderId=${wo1()}`)
    const item = (stock.items as Json[]).find((entry) => entry.id === scheduleA.finishedItemId || entry.itemId === scheduleA.finishedItemId)
    expect(item?.onHand ?? 0).toBe(0)
  })
})

async function orderVersion(): Promise<number> {
  return (await admin<{ version: number }>(`SELECT version FROM "SalesOrder" WHERE id = $1`, [so2()]))[0]!.version
}

async function blkLine(): Promise<string> {
  const [row] = await admin<{ id: string }>(`SELECT l.id FROM "SalesOrderLine" l JOIN "Colourway" c ON c.id = l."colourwayId" WHERE l."orderId" = $1 AND c.code = 'BLK'`, [so2()])
  return row!.id
}

describe('the freight charged (LOG-105): the rule when the goods leave, the office after', () => {
  it('SB left with the rule of its one parcel; the office types another, then puts it back to the rule', async () => {
    const shipped = (await ok('finance', 'GET', `/shipping/shipments/${S.sb}`)).shipment
    expect(shipped.freight).toMatchObject({ byHand: false, currency: 'EUR' })
    expect(shipped.freight.charge).toBe(shipped.freight.byRule.charge)
    const list = await ok('finance', 'GET', `/shipping/shipments?salesOrderId=${so2()}`)
    expect(list.shipments.find((row: Json) => row.id === S.sb)).toMatchObject({ freightCharge: shipped.freight.charge, currency: 'EUR', transportEvidence: 'NOT_NEEDED' })
    expect((await ok('warehouse', 'GET', `/shipping/shipments?salesOrderId=${so2()}`)).shipments.find((row: Json) => row.id === S.sb)).not.toHaveProperty('freightCharge')

    expect((await refused('warehouse', 'PUT', `/shipping/shipments/${S.sb}/freight`, { freightCharge: 900 }, 403)).code).toBe('forbidden')
    const basis = async () => (await admin<{ basis: string | null }>(`SELECT "freightBasis"::text AS basis FROM "Shipment" WHERE id = $1`, [S.sb]))[0]!.basis
    expect(await basis()).toBe('RULE')
    const typed = await ok('finance', 'PUT', `/shipping/shipments/${S.sb}/freight`, { freightCharge: 900 })
    expect(typed.freight).toMatchObject({ charge: 900, byHand: true })
    // B-W2b-19: the basis is a column now (MANUAL typed, RULE the rule's), not the last audit row.
    expect(await basis()).toBe('MANUAL')
    const back = await ok('finance', 'PUT', `/shipping/shipments/${S.sb}/freight`, { freightCharge: null })
    expect(back.freight).toMatchObject({ charge: shipped.freight.charge, byHand: false })
    expect(await basis()).toBe('RULE')
    const events = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'shipment.freight_changed' AND subject = $1 ORDER BY "occurredAt", id`, [S.sb])
    expect(events.map((row) => row.payload.byHand)).toEqual([false, true, false])
    expect(JSON.stringify(events)).not.toMatch(/900/)
  })

  it('B-W2b-19: the carrier\'s freight cost, a cost: the permission and the cost grain to set it, the grain to read it', async () => {
    expect((await refused('warehouse', 'PUT', `/shipping/shipments/${S.sb}/freight-cost`, { freightCost: 1850 }, 403)).code).toBe('forbidden')
    // Finance holds the freight permission but not the cost grain: the grain wall refuses the body.
    expect((await refused('finance', 'PUT', `/shipping/shipments/${S.sb}/freight-cost`, { freightCost: 1850 }, 403)).code).toBe('forbidden')
    const recorded = await ok('freightCost', 'PUT', `/shipping/shipments/${S.sb}/freight-cost`, { freightCost: 1850 })
    expect(recorded.freight.cost).toEqual({ amount: 1850, currency: 'EUR' })
    expect(await admin(`SELECT "freightCost", "freightCostCurrency" FROM "Shipment" WHERE id = $1`, [S.sb])).toEqual([{ freightCost: 1850, freightCostCurrency: 'EUR' }])
    // A reader without the cost grain sees that one is recorded (its currency), never the amount.
    const blind = (await ok('finance', 'GET', `/shipping/shipments/${S.sb}`)).shipment
    expect(blind.freight.cost).toEqual({ currency: 'EUR' })
    const audit = await admin(`SELECT after FROM "AuditLog" WHERE action = 'shipping.setFreightCost' AND "recordId" = $1`, [S.sb])
    expect(audit[0]!.after).toMatchObject({ freightCost: { $money: 'cost', value: 1850 }, currency: 'EUR' })
    const cleared = await ok('freightCost', 'PUT', `/shipping/shipments/${S.sb}/freight-cost`, { freightCost: null })
    expect(cleared.freight.cost).toEqual({ amount: null, currency: null })
    const events = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'shipment.freight_cost_changed' AND subject = $1 ORDER BY "occurredAt", id`, [S.sb])
    expect(events.map((row) => row.payload.recorded)).toEqual([true, false])
    expect(JSON.stringify(events)).not.toMatch(/1850/)
  })

  it('B-W2b-19: the mode of transport (Intrastat) is recorded after the goods left too', async () => {
    const shipment = (await ok('warehouse', 'PATCH', `/shipping/shipments/${S.sb}`, { transportMode: 'ROAD' })).shipment
    expect(shipment.transportMode).toBe('ROAD')
    expect((await refused('warehouse', 'PATCH', `/shipping/shipments/${S.sb}`, { transportMode: 'TRUCK' }, 400)).code).toBe('validation_failed')
    expect((await ok('viewer', 'GET', `/shipping/shipments/${S.sb}`)).shipment.transportMode).toBe('ROAD')
  })
})

describe('labels voided every day (LOG-028)', () => {
  it('SH-0002 with two parcels and their labels; the carrier has parcel 2: "void all" voids parcel 1 only', async () => {
    // SO-0003 sold zero-rated to a business in Germany (the evidence below): its order and SH-0002's ship-to.
    await admin(`UPDATE "SalesOrder" SET "taxMode" = 'EU_B2B' WHERE id = $1`, [qa().serialSalesOrderId])
    await admin(`UPDATE "Shipment" SET "shipTo" = jsonb_set("shipTo", '{country}', '"DE"') WHERE id = $1`, [sh2()])
    const [, second, third] = qa().serialIds
    const codes = Object.fromEntries((await admin<{ id: string; serial: string }>('SELECT id, serial FROM "GarmentSerial" WHERE id = ANY($1::uuid[])', [[second, third]])).map((row) => [row.id, row.serial])) as Record<string, string>
    const added = (await ok('warehouse', 'POST', `/shipping/shipments/${sh2()}/lines`, { lines: [{ workOrderSizeId: qa().serialCellId, quantity: 1 }] })).shipment
    S.p1 = returnsA.money.shipping.draftParcelId
    S.p2 = (await ok('warehouse', 'POST', `/shipping/packing/${sh2()}/parcels`, {}, 201)).parcelId
    const loose = added.lines.find((line: Json) => line.parcelId === null)
    await ok('warehouse', 'PUT', `/shipping/packing/${sh2()}/lines/${loose.id}/parcel`, { parcelId: S.p2 })
    await ok('warehouse', 'POST', `/shipping/packing/${sh2()}/serials`, { serial: codes[second!], parcelId: S.p1 })
    await ok('warehouse', 'POST', `/shipping/packing/${sh2()}/serials`, { serial: codes[third!], parcelId: S.p2 })
    await ok('warehouse', 'PATCH', `/shipping/packing/${sh2()}/parcels/${S.p1}`, { grossWeightKg: '1.85' })
    await ok('warehouse', 'PATCH', `/shipping/packing/${sh2()}/parcels/${S.p2}`, { grossWeightKg: '2.1' })
    await ok('warehouse', 'POST', `/shipping/packing/${sh2()}/pack`, {})
    // B-W2b-19: the shipment's mode of transport goes onto its DDT, with the language the DDT is printed in.
    await ok('warehouse', 'PATCH', `/shipping/shipments/${sh2()}`, { transportMode: 'ROAD' })
    const issued = await ok('warehouse', 'POST', `/shipping/shipments/${sh2()}/ddt`, {}, 201)
    expect(issued.ddt).toMatchObject({ transportMode: 'ROAD', language: expect.stringMatching(/^(it|en)$/) })
    expect(await admin(`SELECT "transportMode"::text AS mode, language FROM "Ddt" WHERE id = $1`, [issued.ddt.id])).toEqual([{ mode: 'ROAD', language: issued.ddt.language }])
    const bought = await ok('warehouse', 'POST', `/shipping/shipments/${sh2()}/labels`, {}, 201)
    expect(bought.outcomes.every((outcome: Json) => outcome.ok)).toBe(true)
    expect(bought.voided).toEqual([])
    S.p1Tracking = bought.parcels.find((parcel: Json) => parcel.seq === 1).trackingNumber
    // The carrier collected parcel 2 (a tracking event, as a webhook records it).
    await admin(
      `INSERT INTO "TrackingEvent" (id, "tenantId", "siteId", "partyId", "shipmentId", "parcelId", status, "occurredAt", source, "externalEventId") SELECT $1, s."tenantId", s."siteId", s."partyId", s.id, $2, 'IN_TRANSIT', now(), 'WEBHOOK', $3 FROM "Shipment" s WHERE s.id = $4`,
      [newId(), S.p2, `made-up-${run}`, sh2()],
    )
    const single = await refused('warehouse', 'POST', `/shipping/shipments/${sh2()}/parcels/${S.p2}/label/void`, { reason: 'Wrong box' }, 409)
    expect(single.message).toMatch(/^The carrier has parcel 2 already \(tracking says in transit\)/)
    expect((await refused('viewer', 'POST', `/shipping/shipments/${sh2()}/labels/void`, { reason: 'Wrong service' }, 403)).code).toBe('forbidden')

    const all = await ok('warehouse', 'POST', `/shipping/shipments/${sh2()}/labels/void`, { reason: 'Wrong service' })
    expect(all.outcomes.map((outcome: Json) => [outcome.seq, outcome.ok, outcome.carrier])).toEqual([
      [1, true, 'CANCELLED'],
      [2, false, null],
    ])
    expect(all.outcomes[1].problem).toMatch(/The carrier has parcel 2 already/)
    expect(all.problem).toBe('1 of 2 labels were voided; see each parcel.')
    expect(all.parcels.map((parcel: Json) => parcel.trackingNumber === null)).toEqual([true, false])
    expect(await admin(`SELECT reason FROM "AuditLog" WHERE action = 'shipping.voidLabels' AND "recordId" = $1`, [sh2()])).toEqual([{ reason: 'Wrong service' }])
    // Nothing left to void that the carrier would take back: a 409 with its words.
    expect((await refused('warehouse', 'POST', `/shipping/shipments/${sh2()}/labels/void`, { reason: 'Again' }, 409)).message).toMatch(/The carrier has parcel 2 already/)
    // Parcel 1 takes a new label, and the goods leave.
    expect((await ok('warehouse', 'POST', `/shipping/shipments/${sh2()}/labels`, {}, 201)).outcomes).toEqual([expect.objectContaining({ seq: 1, ok: true })])
    // B-W2b-19: the labels read lists the voided label (its tracking number, the carrier's answer, the reason, its files).
    const labels = await ok('warehouse', 'GET', `/shipping/shipments/${sh2()}/labels`)
    expect(labels.voided).toEqual([
      expect.objectContaining({ parcelId: S.p1, seq: 1, trackingNumber: S.p1Tracking, carrier: 'CANCELLED', reason: 'Wrong service', voidedById: (SESSIONS.warehouse as { actorId: string }).actorId, files: [expect.objectContaining({ format: 'PDF' })] }),
    ])
    expect(labels.parcels.find((parcel: Json) => parcel.seq === 1).trackingNumber).not.toBe(S.p1Tracking)
  })
})

describe('intra-EU transport evidence (LOG-090; art. 41 DL 331/1993)', () => {
  it('AWAITED when the zero-rated sale to Germany leaves; papers only through the module, with their kind', async () => {
    expect((await ok('warehouse', 'GET', `/shipping/shipments/${sh2()}/evidence`)).evidence).toMatchObject({ status: 'NOT_NEEDED', neededBySale: true })
    expect((await refused('warehouse', 'POST', `/shipping/shipments/${sh2()}/evidence/papers`, { kind: 'POD', originalName: 'pod.pdf', contentType: 'application/pdf', sizeBytes: 10, sha256: '0'.repeat(64) }, 409)).message).toMatch(/once the goods left/)
    expect((await ok('warehouse', 'POST', `/shipping/shipments/${sh2()}/ship`, {})).shipment.status).toBe('SHIPPED')
    const awaited = (await ok('viewer', 'GET', `/shipping/shipments/${sh2()}/evidence`)).evidence
    expect(awaited).toMatchObject({ status: 'AWAITED', papers: [], missing: expect.stringMatching(/On file: nothing\.$/) })
    expect((await ok('viewer', 'GET', '/shipping/shipments?evidence=open')).shipments.map((row: Json) => row.id)).toContain(sh2())
    expect((await refused('viewer', 'POST', `/shipping/shipments/${sh2()}/evidence/complete`, {}, 403)).code).toBe('forbidden')
  })

  it('PARTIAL with the proof of delivery; COMPLETE refused with one paper, given with the CMR; reopened with its reason', async () => {
    const pod = await filePaper('warehouse', sh2(), 'POD', 'pod-sh0002.pdf')
    expect(pod.evidence).toMatchObject({ status: 'PARTIAL', onFile: '1 proof of delivery', papers: [expect.objectContaining({ kind: 'POD', status: 'AVAILABLE' })] })
    // B-W2b-19: the paper's kind is the file's category (W2a: an audit row).
    expect(await admin(`SELECT category::text AS category FROM "StoredFile" WHERE id = $1`, [pod.file.id])).toEqual([{ category: 'POD' }])
    const one = await refused('finance', 'POST', `/shipping/shipments/${sh2()}/evidence/complete`, {}, 409)
    expect(one.message).toMatch(/On file: 1 proof of delivery\.$/)
    await filePaper('warehouse', sh2(), 'CMR', 'cmr-sh0002.pdf')
    const done = await ok('finance', 'POST', `/shipping/shipments/${sh2()}/evidence/complete`, { note: 'CMR signed by the consignee in Munich' })
    expect(done.evidence).toMatchObject({ status: 'COMPLETE', completedAt: expect.any(String), completedById: (SESSIONS.finance as { actorId: string }).actorId, note: 'CMR signed by the consignee in Munich' })
    expect((await refused('finance', 'POST', `/shipping/shipments/${sh2()}/evidence/needed`, { needed: false, reason: 'not EU after all' }, 409)).message).toMatch(/reopen it first/)
    const reopened = await ok('finance', 'POST', `/shipping/shipments/${sh2()}/evidence/reopen`, { reason: 'The CMR names another consignee' })
    expect(reopened.evidence).toMatchObject({ status: 'PARTIAL', completedAt: null, completedById: null })
    const events = await admin(`SELECT payload->>'from' AS "from", payload->>'to' AS "to" FROM "OutboxEvent" WHERE type = 'shipment.evidence_changed' AND subject = $1 ORDER BY "occurredAt", id`, [sh2()])
    expect(events.map((row) => `${row.from}>${row.to}`)).toEqual(['NOT_NEEDED>AWAITED', 'AWAITED>PARTIAL', 'PARTIAL>COMPLETE', 'COMPLETE>PARTIAL'])
    const [files] = await admin(`SELECT count(*)::int AS n, min("retainUntil") AS keep FROM "StoredFile" WHERE "recordType" = 'Shipment' AND "recordId" = $1 AND kind = 'ATTACHMENT'`, [sh2()])
    expect(files!.n).toBe(2)
    expect(new Date(files!.keep).getUTCFullYear()).toBeGreaterThanOrEqual(new Date().getUTCFullYear() + 9)
  })
})

describe('what a shipment may take of its order (tenant B: LOG-004 with SAL-210)', () => {
  const qb = () => returnsB.money.shipping.quality
  it('never more than the order line ordered of a size, nothing of a line closed short, never a repair cell', async () => {
    // SO-0003 ordered 4 of BLK 52; make it 1 (SH-0002 holds one garment already).
    const [line] = await admin<{ id: string }>(`SELECT id FROM "SalesOrderLine" WHERE "orderId" = $1`, [qb().serialSalesOrderId])
    await admin(`UPDATE "SalesOrderLineSize" SET quantity = 1 WHERE "lineId" = $1`, [line!.id])
    await admin(`UPDATE "SalesOrderLine" SET quantity = 1 WHERE id = $1`, [line!.id])
    const over = await refused('warehouseB', 'POST', `/shipping/shipments/${returnsB.money.shipping.draftShipmentId}/lines`, { lines: [{ workOrderSizeId: qb().serialCellId, quantity: 1 }] }, 409)
    expect(over.message).toBe('Order line 10 (SEED-JKT-03 BLK), size 52: 1 ordered and 1 on shipments already, so 0 more can ship; 1 asked.')
    await admin(`UPDATE "SalesOrderLineSize" SET quantity = 4 WHERE "lineId" = $1`, [line!.id])
    await admin(`UPDATE "SalesOrderLine" SET quantity = 4, "closedShortQuantity" = 3, "closedShortAt" = now(), "closedShortById" = $2, "closeShortReason" = 'Season over' WHERE id = $1`, [line!.id, newId()])
    const closed = await refused('warehouseB', 'POST', `/shipping/shipments/${returnsB.money.shipping.draftShipmentId}/lines`, { lines: [{ workOrderSizeId: qb().serialCellId, quantity: 1 }] }, 409)
    expect(closed.message).toMatch(/was closed short \(Season over\): what is left of it will not ship/)

    const { workOrder } = await ok('plannerB', 'POST', '/production/work-orders/repairs', { repairOrderId: returnsB.repairId, routingSeqs: [20] }, 201)
    const repair = await refused('warehouseB', 'POST', '/shipping/shipments', { salesOrderId: qb().production.salesOrderId, lines: [{ workOrderSizeId: workOrder.cells[0].id, quantity: 1 }] }, 400)
    expect(repair.issues).toEqual([{ path: 'body/lines/0/workOrderSizeId', message: `${workOrder.number} is a repair work order: its garment goes back with the repair's DDT, never on a shipment of the order.` }])

    // B-W2b-19: a repair cell's line made before the rule (forced here, past the guards) never grows.
    const draft = returnsB.money.shipping.draftShipmentId
    const lineId = newId()
    await force(
      `INSERT INTO "ShipmentLine" (id, "tenantId", "siteId", "partyId", "shipmentId", "workOrderId", "workOrderSizeId", "salesOrderLineId", size, quantity)
       SELECT $1, c."tenantId", c."siteId", s."partyId", s.id, c."workOrderId", c.id, c."salesOrderLineId", c.size, 1 FROM "WorkOrderSize" c, "Shipment" s WHERE c.id = $2 AND s.id = $3`,
      [lineId, workOrder.cells[0].id, draft],
    )
    const grown = await refused('warehouseB', 'PATCH', `/shipping/shipments/${draft}/lines/${lineId}`, { quantity: 2 }, 409)
    expect(grown.message).toBe(`${workOrder.number} is a repair work order: its garment goes back with the repair's DDT, never on a shipment of the order.`)
    await force(`DELETE FROM "ShipmentLine" WHERE id = $1`, [lineId])
  })
})

describe('a garment shipped from finished goods leaves at its frozen standard (B-W2a-F7)', () => {
  let standard: Json

  it('a standard frozen after SB left values its move out of finished goods, with the receipt before it', async () => {
    const out = await fromStockMove(S.sb!)
    // SB left before any standard of the garment existed: no value yet.
    expect(await valuationOf(out)).toBeNull()
    const made = await ok('costing', 'POST', '/costing/standards', { companyId: A.companyA, itemId: scheduleA.finishedItemId, validFrom: `${businessDate(new Date()).slice(0, 7)}-01`, materialCost: '210.000000', labourCost: '80.000000', note: 'Season standard of the black 52 (made up).' }, 201)
    const frozen = await ok('costing', 'POST', `/costing/standards/${made.standard.id}/freeze`, { version: made.standard.version })
    // The receipt into finished goods (its work order's completion posted) and SB's move out of it.
    expect(frozen.valued).toMatchObject({ moves: 2, workOrders: [{ id: wo1() }], skipped: [] })
    // Out of stock: the value is signed (290.00 a garment leaves).
    expect(await valuationOf(out)).toMatchObject({ method: 'STANDARD_COST', valueAmount: -29_000 })
    expect(Number((await valuationOf(out))!.unitCost)).toBe(290)
    standard = frozen.standard
  })

  it('a garment shipped after the freeze carries the standard at once', async () => {
    // One more BLK 52 released (made up: the seeded reversal of WO-0001's second release taken back), into finished goods.
    await force(`DELETE FROM "QualityReleaseReversal" WHERE "workOrderSizeId" = $1`, [blk52()])
    const report = await ok('production', 'POST', `/production/work-orders/${wo1()}/finished`, { cells: [{ cellId: blk52(), quantity: 1 }] }, 201)
    expect(await valuationOf(report.report.moveIds[0])).toMatchObject({ method: 'STANDARD_COST', valueAmount: 29_000 })
    const sc = (await ok('warehouse', 'POST', '/shipping/shipments', { salesOrderId: so2(), lines: [{ workOrderSizeId: blk52(), quantity: 1 }] }, 201)).shipment
    S.sc = sc.id
    const parcelId = (await ok('warehouse', 'POST', `/shipping/packing/${sc.id}/parcels`, { grossWeightKg: '2.4' }, 201)).parcelId
    const line = (await ok('warehouse', 'GET', `/shipping/shipments/${sc.id}`)).shipment.lines[0]
    await ok('warehouse', 'PUT', `/shipping/packing/${sc.id}/lines/${line.id}/parcel`, { parcelId })
    expect((await ok('warehouse', 'POST', `/shipping/packing/${sc.id}/pack`, {})).shipment.status).toBe('PACKED')
    expect((await ok('warehouse', 'POST', `/shipping/shipments/${sc.id}/ddt`, { ship: true }, 201)).shipment.status).toBe('SHIPPED')
    // Out of finished goods at the standard in force today (inventory/finished/post.ts standardCostFor).
    const out = await fromStockMove(sc.id)
    expect(await valuationOf(out)).toMatchObject({ method: 'STANDARD_COST', valueAmount: -29_000 })
    expect(Number((await valuationOf(out))!.unitCost)).toBe(Number(standard.unitCost))
  })
})

describe('B-W2b-19: a carrier-returned shipment back into finished goods (the B-W2a-48 gap)', () => {
  it('only once the carrier brought it back; then its garment goes back into finished goods at its standard, once', async () => {
    expect((await ok('viewer', 'GET', `/shipping/shipments/${S.sc}/carrier-return`)).carrierReturn).toMatchObject({ state: 'NOT_RETURNED', garments: 1, moveIds: [] })
    const early = await refused('warehouse', 'POST', `/shipping/shipments/${S.sc}/carrier-return`, {}, 409)
    expect(early.message).toMatch(/is SHIPPED: its garments go back into finished goods once the carrier brought it back/)
    // The carrier's tracking says it went back to the sender (as a webhook records it: SHIPPED → RETURNED).
    await admin(`UPDATE "Shipment" SET status = 'RETURNED', "returnedAt" = now() WHERE id = $1`, [S.sc])
    const awaited = (await ok('viewer', 'GET', `/shipping/shipments/${S.sc}/carrier-return`)).carrierReturn
    expect(awaited).toMatchObject({ state: 'AWAITED', garments: 1, defaultLocationId: scheduleA.finishedLocationId, cells: [{ cellId: blk52(), garments: 1 }] })
    expect((await refused('viewer', 'POST', `/shipping/shipments/${S.sc}/carrier-return`, {}, 403)).code).toBe('forbidden')
    expect((await refused('warehouse', 'POST', `/shipping/shipments/${S.sc}/carrier-return`, { locationId: newId() }, 400)).issues).toEqual([
      { path: 'body/locationId', message: 'Expected a FINISHED_GOODS location of the site, or a place inside one, not archived.' },
    ])

    const back = await ok('warehouse', 'POST', `/shipping/shipments/${S.sc}/carrier-return`, { note: 'Refused by the customer.' }, 201)
    expect(back.carrierReturn).toMatchObject({ state: 'RECEIVED', locationId: scheduleA.finishedLocationId, receivedById: (SESSIONS.warehouse as { actorId: string }).actorId })
    expect(back.valued).toBe(true)
    const moves = await admin(`SELECT id, reason::text AS reason, "fromLocationId", "toLocationId", "workOrderId", "shipmentLineId", reference, "baseQuantity"::text AS quantity, "idempotencyKey" FROM "StockMove" WHERE "idempotencyKey" LIKE $1`, [`shipping.carrierReturn:${S.sc}:%`])
    expect(moves).toEqual([
      { id: back.carrierReturn.moveIds[0], reason: 'ADJUSTMENT', fromLocationId: null, toLocationId: scheduleA.finishedLocationId, workOrderId: wo1(), shipmentLineId: null, reference: expect.stringMatching(/^SH-/), quantity: '1.0000', idempotencyKey: `shipping.carrierReturn:${S.sc}:1` },
    ])
    // At the garment's frozen standard, as it left (B-W2a-F7).
    expect(await valuationOf(moves[0]!.id)).toMatchObject({ method: 'STANDARD_COST', valueAmount: 29_000 })
    expect((await refused('warehouse', 'POST', `/shipping/shipments/${S.sc}/carrier-return`, {}, 409)).message).toMatch(/back in finished goods already/)

    // On hand in finished goods again; "Report finished to stock" counts nothing twice (the returned shipment keeps its line).
    const stock = await ok('production', 'GET', `/inventory/finished?workOrderId=${wo1()}`)
    const item = (stock.items as Json[]).find((entry) => entry.id === scheduleA.finishedItemId || entry.itemId === scheduleA.finishedItemId)
    expect(item?.onHand).toBe(1)
    const finished = await ok('production', 'GET', `/production/work-orders/${wo1()}/finished`)
    expect(finished.finished.cells.find((entry: Json) => entry.cellId === blk52())).toMatchObject({ canReport: 0 })
    const events = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'shipment.carrier_return_received' AND subject = $1`, [S.sc])
    expect(events.map((row) => row.payload)).toEqual([{ shipmentId: S.sc, number: expect.stringMatching(/^SH-/), garments: 1, locationId: scheduleA.finishedLocationId }])
  })

  it('B-W2b-F1: received back, the shipment no longer holds its garment: the same cell ships it again, from finished goods', async () => {
    expect(await admin(`SELECT "carrierReturnReceivedAt" IS NOT NULL AS received FROM "Shipment" WHERE id = $1`, [S.sc])).toEqual([{ received: true }])
    // A batch-tracked jacket: no serial went back to RELEASED.
    expect((await admin(`SELECT after FROM "AuditLog" WHERE action = 'shipping.carrierReturnReceived' AND "recordId" = $1`, [S.sc]))[0]!.after.serialIds).toEqual([])
    const ready = await ok('warehouse', 'GET', `/shipping/ready?salesOrderId=${so2()}`)
    expect(ready.orders[0].cells.find((cell: Json) => cell.workOrderSizeId === blk52())).toMatchObject({ shippable: 1, inStock: 1 })
    const sd = (await ok('warehouse', 'POST', '/shipping/shipments', { salesOrderId: so2(), lines: [{ workOrderSizeId: blk52(), quantity: 1 }] }, 201)).shipment
    const parcelId = (await ok('warehouse', 'POST', `/shipping/packing/${sd.id}/parcels`, { grossWeightKg: '2.4' }, 201)).parcelId
    const line = (await ok('warehouse', 'GET', `/shipping/shipments/${sd.id}`)).shipment.lines[0]
    await ok('warehouse', 'PUT', `/shipping/packing/${sd.id}/lines/${line.id}/parcel`, { parcelId })
    expect((await ok('warehouse', 'POST', `/shipping/packing/${sd.id}/pack`, {})).shipment.status).toBe('PACKED')
    expect((await ok('warehouse', 'POST', `/shipping/shipments/${sd.id}/ddt`, { ship: true }, 201)).shipment.status).toBe('SHIPPED')
    // It left out of finished goods (the garment the carrier brought back), and nothing counts twice.
    expect(await admin(`SELECT reason::text AS reason, "shipmentLineId", "baseQuantity"::text AS quantity FROM "StockMove" WHERE "idempotencyKey" LIKE $1`, [`shipping.fromStock:${sd.id}:%`])).toEqual([
      { reason: 'SHIPMENT', shipmentLineId: line.id, quantity: '1.0000' },
    ])
    const stock = await ok('production', 'GET', `/inventory/finished?workOrderId=${wo1()}`)
    expect((stock.items as Json[]).find((entry) => entry.id === scheduleA.finishedItemId || entry.itemId === scheduleA.finishedItemId)?.onHand ?? 0).toBe(0)
    const finished = await ok('production', 'GET', `/production/work-orders/${wo1()}/finished`)
    expect(finished.finished.cells.find((entry: Json) => entry.cellId === blk52())).toMatchObject({ canReport: 0 })
  })

  it('B-W2b-F1: a serial-tracked shipment received back puts its serials back to RELEASED, unpacked, to be packed again', async () => {
    const serials = await admin<{ id: string; status: string }>(`SELECT g.id, g.status::text AS status FROM "GarmentSerial" g JOIN "ShipmentLine" l ON l.id = g."shipmentLineId" WHERE l."shipmentId" = $1 ORDER BY g.id`, [sh2()])
    expect(serials.length).toBeGreaterThan(0)
    expect(serials.every((serial) => serial.status === 'SHIPPED')).toBe(true)
    const ids = serials.map((serial) => serial.id)
    // SH-0002 came back with the carrier (its tracking, as a webhook records it); the jacket's SKU (made up: the seed gives
    // the serial-tracked style no SKU matrix).
    await admin(`UPDATE "Shipment" SET status = 'RETURNED', "returnedAt" = now() WHERE id = $1`, [sh2()])
    await admin(
      `INSERT INTO "Variant" (id, "tenantId", "styleId", "colourwayId", size, sku) SELECT $1, w."tenantId", w."styleId", c."colourwayId", c.size, 'SEED-JKT-03-F1-' || c.size FROM "WorkOrderSize" c JOIN "WorkOrder" w ON w.id = c."workOrderId" WHERE c.id = $2`,
      [newId(), qa().serialCellId],
    )
    expect((await ok('warehouse', 'POST', `/shipping/shipments/${sh2()}/carrier-return`, {}, 201)).carrierReturn.state).toBe('RECEIVED')
    expect(await admin(`SELECT status::text AS status, "shipmentLineId" FROM "GarmentSerial" WHERE id = ANY($1::uuid[])`, [ids])).toEqual(ids.map(() => ({ status: 'RELEASED', shipmentLineId: null })))
    expect((await admin(`SELECT after FROM "AuditLog" WHERE action = 'shipping.carrierReturnReceived' AND "recordId" = $1`, [sh2()]))[0]!.after.serialIds).toEqual(ids)
  })
})
