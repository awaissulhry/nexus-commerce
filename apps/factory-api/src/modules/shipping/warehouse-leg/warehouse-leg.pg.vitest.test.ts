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
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedShipping, type ShippingSeed } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../../adapters/local-files/local'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { createFilesRuntime, useFiles } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { systemContext } from '../../../platform/outbox/system'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'
import { fileTravelDocuments, TRAVEL_DOCUMENT_PERMISSIONS } from '../documents/testing/compliance'
import { syncSystemHolds } from '../holds/system'

/**
 * Our warehouse first, the rights split and the payment warning (owb- order workflow, S3 ss1; settles L2–L5) on the local stack with
 * the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security, the column
 * grants, the shipping guards, the leg's guard and its DELIVERED trigger G9 are real), the factory-db shipping seed (SEED-SO-0002 of
 * Seed Customer One), four more of WO-0001's garments released past the guards (made-up facts, as consolidate.pg: copies of a seeded
 * release), ONE made-up warehouse site of company A ("Seed warehouse North"), company A's DDT series for this year, the local file
 * store, the shipped style's DoC and leaflet. Every name, number and address is made up. WRITTEN, NOT RUN (Owner rule: tests at the
 * end). Run with `node scripts/factory/run-pg-tests.mjs warehouse-leg`.
 *
 *   1.1 rights   Sales (shipping.plan, no shipping.manage) creates, splits, moves and cancels a DRAFT, may not pack or ship; the
 *                warehouse (shipping.manage) still does everything; a role with neither right is refused (403)
 *   1.2 the leg  planned to our warehouse (its address, its leg in the same command) → packed → the TRANSFER DDT, shipped (no payment
 *                warning: the goods stay ours) → It arrived → the customer's label (by the office) → the sale DDT → Send on (the
 *                payment warning, passed on) → delivered; DELIVERED before Send on refused (G9); without a label: logged
 *   1.3 DDTs     TRANSFER only with a leg; a second live DDT only the sale DDT after arrival; invoicing never bills the transfer, and
 *                nothing still at our warehouse
 *   1.4 payment  straight to the customer with an open before-shipping step: 409 with the list, then SHIPPED with overrides and the
 *                ship's own audit row keeps passedWarnings; the system places no BALANCE_UNPAID hold
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string
let seedA: ShippingSeed

const ns = 'warehouse-leg'
const idOf = (key: string) => seedUuid(ns, key)
const A = { tenant: idOf('tenant'), companyA: idOf('company:A'), siteA1: idOf('site:A1'), customer: idOf('party:P1') }
const WAREHOUSE = newId()
const YEAR = businessDate(new Date()).slice(0, 4)

const SHIPPING: Permission[] = ['shipping.view', 'shipping.manage', 'shipping.pack', 'shipping.ddt.issue', 'shipping.ddt.cancel', 'shipping.settings.view']
const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (grants: Grant[], actorId = newId()): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId, grants })
const fromTemplate = (key: string): Permission[] => {
  const template = templateOf(key)!
  return [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)]
}
const WAREHOUSE_PERSON = newId()
const SESSIONS: Record<string, SessionContext> = {
  warehouse: office([grant([...SHIPPING, 'orders.view', 'files.read', 'shipping.holds.manage'])], WAREHOUSE_PERSON),
  // The real Sales template: shipping.view and (owb-) shipping.plan, never shipping.manage nor shipping.pack.
  sales: office([grant(fromTemplate('sales'))]),
  // A person who reads shipments and plans none.
  neither: office([grant(['shipping.view', 'orders.view'])]),
  // The real Finance template (the invoicing reads).
  finance: office([grant(fromTemplate('finance'))]),
  quality: office([grant(TRAVEL_DOCUMENT_PERMISSIONS)]),
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
/** A 409 of the leg: its issue path `refusal/<CODE>`. */
async function refusedFor(session: string, method: Method, url: string, payload: unknown, code: string): Promise<Json> {
  const error = await refused(session, method, url, payload, 409)
  expect(error.issues?.[0]?.path, JSON.stringify(error)).toBe(`refusal/${code}`)
  return error
}

const so2 = () => seedA.quality.production.salesOrderId
const cell = (key: 'BLK-52' | 'BLK-54' | 'RED-50' | 'RED-54') => seedA.quality.production.cellIds[key]
const shipmentOf = async (id: string): Promise<Json> => (await ok('warehouse', 'GET', `/shipping/shipments/${id}`)).shipment
const versionOf = async (id: string): Promise<number> => (await shipmentOf(id)).version as number
const legsOf = async (session = 'warehouse'): Promise<Json[]> => (await ok(session, 'GET', `/shipping/warehouse-legs?salesOrderId=${so2()}`)).legs
const legRow = async (shipmentId: string) => (await admin<Json>(`SELECT "arrivedAt", "arrivedById", "forwardedAt", "forwardedById", "forwardedWithoutLabel", "customerLabelFileId", version FROM "ShipmentWarehouseLeg" WHERE "shipmentId" = $1`, [shipmentId]))[0]
const liveDdts = async (shipmentId: string) => admin<{ id: string; number: string; reason: string }>(`SELECT d.id, d.number, d.reason::text AS reason FROM "Ddt" d WHERE d."shipmentId" = $1 AND NOT EXISTS (SELECT 1 FROM "DdtCancellation" x WHERE x."ddtId" = d.id) ORDER BY d."issuedAt", d.id`, [shipmentId])
const auditOf = async (shipmentId: string, action: string) => admin<{ actorId: string; before: Json; after: Json }>(`SELECT "actorId", before, after FROM "AuditLog" WHERE "recordType" = 'Shipment' AND "recordId" = $1 AND action = $2 ORDER BY "createdAt"`, [shipmentId, action])
const eventsOf = async (shipmentId: string, type: string) => admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = $1 AND subject = $2 ORDER BY "occurredAt", id`, [type, shipmentId])

/** A DRAFT made, one parcel weighed and the lines in it, packed. */
async function packed(shipment: Json): Promise<void> {
  const parcel = (await ok('warehouse', 'POST', `/shipping/packing/${shipment.id}/parcels`, { grossWeightKg: '2.5' }, 201)).parcelId
  for (const line of shipment.lines as Json[]) await ok('warehouse', 'PUT', `/shipping/packing/${shipment.id}/lines/${line.id}/parcel`, { parcelId: parcel })
  expect((await ok('warehouse', 'POST', `/shipping/packing/${shipment.id}/pack`, {})).shipment.status).toBe('PACKED')
}

/** A file put on the shipment (made-up bytes: only the row matters): by the office (createdById), shared with the office only. */
async function officeFile(shipmentId: string, name: string, contentType = 'application/pdf'): Promise<string> {
  const fileId = newId()
  const store = (await admin<{ id: string }>(`SELECT id FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2' ORDER BY id LIMIT 1`, [A.tenant]))[0]!.id
  await admin(
    `INSERT INTO "StoredFile" (id, "tenantId", "companyId", "recordType", "recordId", kind, "originalName", "contentType", "sizeBytes", sha256, "storeAccountId", "storageKey", status, visibility, "availableAt", "createdAt", "updatedAt", "createdById")
     VALUES ($1, $2, $3, 'Shipment', $4, 'DOCUMENT', $5, $6, 1200, repeat('b', 64), $7, $8, 'AVAILABLE', '{OFFICE}'::"FileAudience"[], now(), now(), now(), $9)`,
    [fileId, A.tenant, A.companyA, shipmentId, name, contentType, store, `t/${A.tenant}/c/${A.companyA}/2026/${fileId}`, WAREHOUSE_PERSON],
  )
  return fileId
}

/** An OPEN before-shipping payment step on SEED-SO-0002 (made-up amount), and the way to settle it again. */
async function openBalance(): Promise<string> {
  const id = newId()
  await force(
    `INSERT INTO "SalesOrderMilestone" (id, "tenantId", "companyId", "orderId", "partyId", seq, kind, amount, status) SELECT $1, o."tenantId", o."companyId", o.id, o."partyId", 980, 'BEFORE_SHIPPING', 10000, 'OPEN' FROM "SalesOrder" o WHERE o.id = $2`,
    [id, so2()],
  )
  return id
}
const settle = (id: string) => force(`UPDATE "SalesOrderMilestone" SET status = 'PAID', "paidAt" = now() WHERE id = $1`, [id])

// Filled in order by the cases below (each case reads only the ids an earlier case set).
const ids = {} as { balance: string; label: string; leg: string; saleDdt: string; straight: string; transferDdt: string }

beforeAll(async () => {
  db = await migratedDatabase('warehouse_leg')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  seedA = await seedShipping({ db: database, namespace: ns })
  // Made-up legal data (c.c. art. 2250), a SHIPMENT series, this year's DDT series with no last date, the tenant's FAKE file store.
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT12345670009', "fiscalCode" = '12345670009', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [A.companyA])
  await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'SHIPMENT', 'MAIN', 'ALL', 'NEVER', 'SH-{N:5}', false) ON CONFLICT DO NOTHING`, [newId(), A.tenant, A.companyA])
  await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'DDT', 'MAIN', $4, 'YEARLY', '{N}/{YYYY}', true) ON CONFLICT DO NOTHING`, [newId(), A.tenant, A.companyA, YEAR])
  await admin(`UPDATE "NumberSeries" SET "lastIssuedDate" = NULL WHERE "tenantId" = $1 AND kind = 'DDT'`, [A.tenant])
  if ((await admin(`SELECT 1 FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2'`, [A.tenant])).length === 0) {
    await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), A.tenant])
  }
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [A.tenant])
  // Four more of WO-0001's garments released (copies of the seeded BLK 52 release): BLK 52, BLK 54, RED 50, RED 54.
  for (const [index, key] of (['BLK-52', 'BLK-54', 'RED-50', 'RED-54'] as const).entries()) {
    await force(
      `INSERT INTO "QualityRelease" SELECT * FROM jsonb_populate_record(NULL::"QualityRelease", (SELECT to_jsonb(r) || jsonb_build_object('id', $1::uuid, 'number', $2::text, 'workOrderSizeId', $3::uuid, 'quantity', 1) FROM "QualityRelease" r WHERE id = $4))`,
      [newId(), `SEED-REL-WL-${index + 1}`, cell(key), seedA.quality.releaseIds['BLK-52']],
    )
  }
  // Our warehouse: a WAREHOUSE site of company A with a complete (made-up) address.
  await admin(
    `INSERT INTO "Site" (id, "tenantId", "companyId", code, name, kind, address) VALUES ($1, $2, $3, 'SEED-WH1', 'Seed warehouse North', 'WAREHOUSE', jsonb_build_object('line1', 'Via Magazzino 3', 'postalCode', '00000', 'city', 'Seedport', 'province', 'MI', 'country', 'IT'))`,
    [WAREHOUSE, A.tenant, A.companyA],
  )
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-warehouse-leg-test-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
  // The shipped style's DoC and leaflet for the work order's frozen revision (B-W1-49: PPE leaves only with them).
  await fileTravelDocuments(app, 'quality', seedA.quality.production.styleId, seedA.quality.production.revisionId)
}, 180_000)

afterAll(async () => {
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

// ---- 1.1 the rights split (settle L3) ---------------------------------------------------------------------------------------------
describe('1.1 planning is shipping.plan OR shipping.manage; packing and sending keep their rights', () => {
  it('Sales (plan only) creates, splits, moves and cancels a DRAFT; it may not pack or ship', async () => {
    const draft = (await ok('sales', 'POST', '/shipping/shipments', { salesOrderId: so2(), siteId: A.siteA1, lines: [{ workOrderSizeId: cell('BLK-54'), quantity: 1 }, { workOrderSizeId: cell('RED-50'), quantity: 1 }, { workOrderSizeId: cell('RED-54'), quantity: 1 }] }, 201)).shipment
    expect(draft).toMatchObject({ status: 'DRAFT', garments: 3 })
    const preview = await ok('sales', 'GET', `/shipping/shipments/${draft.id}/split`)
    expect(preview.mayManage).toBe(true)
    const red50 = (preview.lines as Json[]).find((line) => line.size === '50')!
    const split = await ok('sales', 'POST', `/shipping/shipments/${draft.id}/split`, { version: preview.version, reason: 'CUSTOMER_REQUEST', lines: [{ lineId: red50.id, quantity: 1 }] }, 201)
    const child = split.shipment
    // A second DRAFT of the same customer and address; the RED 54 moves onto it (the BLK 54 stays on the first).
    const target = (await ok('sales', 'POST', '/shipping/shipments', { salesOrderId: so2(), siteId: A.siteA1 }, 201)).shipment
    const from = await shipmentOf(draft.id)
    const red54 = (from.lines as Json[]).find((line) => line.workOrderSizeId === cell('RED-54'))!
    await ok('sales', 'POST', `/shipping/shipments/${draft.id}/move`, { version: from.version, toShipmentId: target.id, toVersion: target.version, reason: 'OTHER', lines: [{ lineId: red54.id, quantity: 1 }] })
    expect((await shipmentOf(target.id)).garments).toBe(1)
    expect((await shipmentOf(draft.id)).garments).toBe(1)
    // Never packing, never shipping (shipping.pack, shipping.manage).
    expect((await call('sales', 'POST', `/shipping/packing/${child.id}/parcels`, { grossWeightKg: '1.0' })).statusCode).toBe(403)
    expect((await refused('sales', 'POST', `/shipping/shipments/${child.id}/ship`, {}, 403)).code).toBe('forbidden')
    // Cancelled by Sales, with its reason.
    for (const id of [draft.id, child.id, target.id]) {
      const current = await shipmentOf(id)
      if (current.status === 'CANCELLED') continue
      expect((await ok('sales', 'POST', `/shipping/shipments/${id}/cancel`, { version: current.version, reason: 'Test: planned again' })).shipment.status).toBe('CANCELLED')
    }
  })

  it('the warehouse (shipping.manage) still plans; a role with neither right is refused every plan act (403) and nothing changes', async () => {
    const draft = (await ok('warehouse', 'POST', '/shipping/shipments', { salesOrderId: so2(), siteId: A.siteA1, lines: [{ workOrderSizeId: cell('BLK-54'), quantity: 1 }] }, 201)).shipment
    expect((await refused('neither', 'POST', '/shipping/shipments', { salesOrderId: so2(), siteId: A.siteA1 }, 403)).code).toBe('forbidden')
    expect((await call('neither', 'PATCH', `/shipping/shipments/${draft.id}`, { version: draft.version, internalNote: 'x' })).statusCode).toBe(403)
    expect((await call('neither', 'POST', `/shipping/shipments/${draft.id}/split`, { version: draft.version, reason: 'OTHER', lines: [{ lineId: draft.lines[0].id, quantity: 1 }] })).statusCode).toBe(403)
    expect((await call('neither', 'POST', `/shipping/shipments/${draft.id}/cancel`, { version: draft.version, reason: 'No' })).statusCode).toBe(403)
    expect(await versionOf(draft.id)).toBe(draft.version)
    expect((await ok('warehouse', 'POST', `/shipping/shipments/${draft.id}/cancel`, { version: draft.version, reason: 'Test: done' })).shipment.status).toBe('CANCELLED')
  })
})

// ---- 1.2 + 1.3 our warehouse first (settles L4, L5) --------------------------------------------------------------------------------
describe('1.2 our warehouse first: planned, the transfer, arrived, the label, the sale DDT, Send on, delivered', () => {
  it('plans the DRAFT to our warehouse: its ship-to is the warehouse’s address and its leg is made in the same command', async () => {
    // Refusals first: a delivery address with our warehouse; a site that is not a warehouse.
    const both = await refused('warehouse', 'POST', '/shipping/shipments', { salesOrderId: so2(), siteId: A.siteA1, shipToAddressId: newId(), destination: { kind: 'OUR_WAREHOUSE', siteId: WAREHOUSE } }, 400)
    expect(both.issues[0].path).toBe('body/shipToAddressId')
    const plant = await refused('warehouse', 'POST', '/shipping/shipments', { salesOrderId: so2(), siteId: A.siteA1, destination: { kind: 'OUR_WAREHOUSE', siteId: A.siteA1 } }, 400)
    expect(plant.issues[0].path).toBe('body/destination/siteId')

    const made = await ok('warehouse', 'POST', '/shipping/shipments', { salesOrderId: so2(), siteId: A.siteA1, destination: { kind: 'OUR_WAREHOUSE', siteId: WAREHOUSE }, lines: [{ workOrderSizeId: cell('BLK-52'), quantity: 1 }] }, 201)
    ids.leg = made.shipment.id
    expect(made.leg).toEqual({ warehouseSiteId: WAREHOUSE })
    expect(made.shipment).toMatchObject({ status: 'DRAFT', shipToAddressId: null, shipTo: { name: 'Seed warehouse North', line1: 'Via Magazzino 3', city: 'Seedport', country: 'IT' } })
    expect(await legRow(ids.leg)).toMatchObject({ arrivedAt: null, forwardedAt: null, forwardedWithoutLabel: false, customerLabelFileId: null, version: 1 })
    const [audit] = await auditOf(ids.leg, 'shipping.create')
    expect(audit!.after.destination).toEqual({ kind: 'OUR_WAREHOUSE', siteId: WAREHOUSE })
    // The legs read: on its way (not left yet), may not say it arrived, may send the label.
    expect(await legsOf()).toEqual([expect.objectContaining({ shipmentId: ids.leg, state: 'ON_THE_WAY', warehouse: { siteId: WAREHOUSE, name: 'Seed warehouse North', city: 'Seedport' }, label: null, may: { arrived: false, sendOn: false, label: true } })])
    // Sales may send the label but never say it arrived nor send it on.
    expect((await legsOf('sales'))[0]!.may).toEqual({ arrived: false, sendOn: false, label: true })
  })

  it('never says it arrived before it left; leaves with the TRANSFER DDT (the company the recipient) and no payment warning', async () => {
    ids.balance = await openBalance()
    await refusedFor('warehouse', 'POST', `/shipping/shipments/${ids.leg}/arrived`, { version: await versionOf(ids.leg) }, 'NOT_LEFT')
    await packed(await shipmentOf(ids.leg))
    const preview = await ok('warehouse', 'POST', `/shipping/shipments/${ids.leg}/ddt/preview`, {})
    expect(preview.problems).toEqual([])
    expect(preview.draft).toMatchObject({ reason: 'TRANSFER', recipient: { vatNumber: 'IT12345670009', address: expect.objectContaining({ line1: 'Via Magazzino 3' }) }, destination: null })
    // A sale DDT is refused while the goods go to our warehouse.
    expect((await ok('warehouse', 'POST', `/shipping/shipments/${ids.leg}/ddt/preview`, { reason: 'SALE' })).problems.map((problem: Json) => problem.path)).toEqual(['body/reason'])
    // Issued and shipped at once, with the balance still open: no warning (the goods stay ours).
    const issued = await ok('warehouse', 'POST', `/shipping/shipments/${ids.leg}/ddt`, { ship: true, carrier: { name: 'Seed Express' } }, 201)
    ids.transferDdt = issued.ddt.id
    expect(issued.ddt).toMatchObject({ reason: 'TRANSFER', status: 'LIVE' })
    expect(issued.shipment.status).toBe('SHIPPED')
    expect((await auditOf(ids.leg, 'shipping.issueDdt')).at(-1)!.after.passedWarnings).toBeUndefined()
  })

  it('G9: DELIVERED before Send on is refused (the database, and a status typed by hand); our warehouses lists it on its way', async () => {
    const asOffice = (work: (client: any) => Promise<unknown>) => database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, work)
    await expect(asOffice((client) => client.shipment.update({ where: { id: ids.leg }, data: { status: 'DELIVERED', deliveredAt: new Date() }, select: { id: true } }))).rejects.toThrow(/only after the warehouse sent it on/)
    const typed = await call('warehouse', 'POST', `/shipping/shipments/${ids.leg}/own-transport/events`, { status: 'DELIVERED', reason: 'Test: signed by hand.' })
    expect(typed.statusCode, typed.body).toBe(409)
    expect((await shipmentOf(ids.leg)).status).toBe('SHIPPED')
    const page = await ok('warehouse', 'GET', '/shipping/our-warehouses')
    const north = (page.warehouses as Json[]).find((row) => row.siteId === WAREHOUSE)!
    expect(north).toMatchObject({ code: 'SEED-WH1', name: 'Seed warehouse North', city: 'Seedport', country: 'IT', atWarehouse: [] })
    expect(north.onTheWay).toEqual([expect.objectContaining({ shipmentId: ids.leg, pieces: 1, customer: expect.objectContaining({ partyId: A.customer }) })])
  })

  it('invoicing never bills the transfer DDT (the queue, the deferred invoices, the candidates; by its id: 409 in words)', async () => {
    for (const url of [`/invoicing/shipped-not-invoiced?companyId=${A.companyA}`, `/invoicing/deferred?companyId=${A.companyA}`, `/invoicing/from-ddts/candidates?orderIds=${so2()}`]) {
      expect(JSON.stringify(await ok('finance', 'GET', url)), url).not.toContain(ids.transferDdt)
    }
    // S3 lead yes 09:05: a draft from the transfer DDT named by its id is refused in words, and no invoice row is written.
    const byId = await refused('finance', 'POST', '/invoicing/invoices/from-ddts', { ddtIds: [ids.transferDdt] }, 409)
    expect(byId.message).toMatch(/took the goods to our own warehouse \(a transfer\): nothing is sold with it/)
    expect(await admin(`SELECT 1 FROM "InvoiceLine" WHERE "ddtId" = $1`, [ids.transferDdt])).toEqual([])
  })

  it('It arrived at the warehouse: once, by the warehouse (Sales may not); its audit row, its event; our warehouses lists it there', async () => {
    expect((await refused('sales', 'POST', `/shipping/shipments/${ids.leg}/arrived`, { version: await versionOf(ids.leg) }, 403)).code).toBe('forbidden')
    const version = await versionOf(ids.leg)
    const arrived = await ok('warehouse', 'POST', `/shipping/shipments/${ids.leg}/arrived`, { version })
    expect(arrived).toMatchObject({ shipmentId: ids.leg, arrivedAt: expect.any(String), version: version + 1 })
    expect(await legRow(ids.leg)).toMatchObject({ arrivedById: WAREHOUSE_PERSON, version: 2 })
    await refusedFor('warehouse', 'POST', `/shipping/shipments/${ids.leg}/arrived`, { version: arrived.version }, 'ARRIVED_ALREADY')
    expect((await auditOf(ids.leg, 'shipping.warehouseLeg.arrived')).map((row) => row.after.warehouseSiteId)).toEqual([WAREHOUSE])
    const events = await eventsOf(ids.leg, 'shipment.arrived_at_warehouse')
    expect(events.map((event) => event.payload)).toEqual([{ shipmentId: ids.leg, number: expect.any(String), warehouseSiteId: WAREHOUSE, salesOrderIds: [so2()], partyId: A.customer }])
    expect((await legsOf())[0]).toMatchObject({ state: 'AT_OUR_WAREHOUSE', may: { arrived: false, sendOn: true, label: true } })
    const north = ((await ok('warehouse', 'GET', '/shipping/our-warehouses')).warehouses as Json[]).find((row) => row.siteId === WAREHOUSE)!
    expect(north.atWarehouse).toEqual([expect.objectContaining({ shipmentId: ids.leg, pieces: 1, salesOrders: [expect.objectContaining({ id: so2() })], labelSentAt: null })])
    expect(north.onTheWay).toEqual([])
  })

  it('Send on waits for the sale DDT; the customer’s label sent by the office (Sales) is filed as CUSTOMER_LABEL; another shipment’s file is refused', async () => {
    await refusedFor('warehouse', 'POST', `/shipping/shipments/${ids.leg}/forward`, { version: await versionOf(ids.leg), carrier: null, trackingNumber: null }, 'NO_SALE_DDT')
    const elsewhere = await officeFile(seedA.draftShipmentId, 'not-this-one.pdf')
    await refusedFor('sales', 'POST', `/shipping/shipments/${ids.leg}/customer-label`, { version: await versionOf(ids.leg), fileId: elsewhere }, 'LABEL_FILE')
    const zip = await officeFile(ids.leg, 'label.zip', 'application/zip')
    await refusedFor('sales', 'POST', `/shipping/shipments/${ids.leg}/customer-label`, { version: await versionOf(ids.leg), fileId: zip }, 'LABEL_FILE')
    ids.label = await officeFile(ids.leg, 'label.pdf')
    const sent = await ok('sales', 'POST', `/shipping/shipments/${ids.leg}/customer-label`, { version: await versionOf(ids.leg), fileId: ids.label })
    expect(sent).toMatchObject({ shipmentId: ids.leg, labelSentAt: expect.any(String) })
    expect(await admin(`SELECT category::text AS category FROM "StoredFile" WHERE id = $1`, [ids.label])).toEqual([{ category: 'CUSTOMER_LABEL' }])
    expect((await legsOf())[0]!.label).toEqual({ sentAt: sent.labelSentAt, byCustomer: false, fileId: ids.label })
    expect((await auditOf(ids.leg, 'shipping.warehouseLeg.label')).map((row) => row.after)).toEqual([expect.objectContaining({ customerLabelFileId: ids.label, byCustomer: false, door: 'office' })])
    expect((await eventsOf(ids.leg, 'shipment.label_received')).map((event) => event.payload.byCustomer)).toEqual([false])
  })

  it('1.3 the sale DDT of Send on: a SECOND live DDT (the customer’s address), only after arrival and only once; not billed before Send on', async () => {
    const issued = await ok('warehouse', 'POST', `/shipping/shipments/${ids.leg}/ddt`, { carrier: { name: 'Seed Van' } }, 201)
    ids.saleDdt = issued.ddt.id
    expect(issued.ddt).toMatchObject({ reason: 'SALE', status: 'LIVE', recipient: { name: expect.any(String) } })
    expect(issued.ddt.recipient.vatNumber).not.toBe('IT12345670009')
    expect((await liveDdts(ids.leg)).map((row) => row.reason)).toEqual(['TRANSFER', 'SALE'])
    // A third one: the live one (the newest) is the sale DDT.
    expect((await refused('warehouse', 'POST', `/shipping/shipments/${ids.leg}/ddt`, { carrier: { name: 'Seed Van' } }, 409)).message).toMatch(/is live for this shipment/)
    // Still at our warehouse: the sale DDT is not billed yet — not listed, and refused by its id (409 in words).
    expect(JSON.stringify(await ok('finance', 'GET', `/invoicing/shipped-not-invoiced?companyId=${A.companyA}`))).not.toContain(ids.saleDdt)
    expect(JSON.stringify(await ok('finance', 'GET', `/invoicing/from-ddts/candidates?orderIds=${so2()}`))).not.toContain(ids.saleDdt)
    expect((await refused('finance', 'POST', '/invoicing/invoices/from-ddts', { ddtIds: [ids.saleDdt] }, 409)).message).toMatch(/are still at our warehouse .*: invoice them once they are sent on to the customer/)
  })

  it('Send on: the payment due is a warning (409 with the list), passed on it goes; once; billed then, the transfer never; delivered after', async () => {
    const version = await versionOf(ids.leg)
    const warned = await refused('warehouse', 'POST', `/shipping/shipments/${ids.leg}/forward`, { version, carrier: 'Seed Van', trackingNumber: 'SEED-TRK-1' }, 409)
    expect(warned.issues.map((issue: Json) => issue.path)).toEqual(['warning/PAYMENT_DUE_AT_SHIP'])
    expect((await legRow(ids.leg))!.forwardedAt).toBeNull()
    const sentOn = await ok('warehouse', 'POST', `/shipping/shipments/${ids.leg}/forward`, { version, carrier: 'Seed Van', trackingNumber: 'SEED-TRK-1', overrides: ['PAYMENT_DUE_AT_SHIP'] })
    expect(sentOn).toMatchObject({ shipmentId: ids.leg, forwardedAt: expect.any(String), forwardedWithoutLabel: false, version: version + 1 })
    const [audit] = await auditOf(ids.leg, 'shipping.warehouseLeg.forwarded')
    expect(audit!.after).toMatchObject({ forwardedWithoutLabel: false, customerLabelFileId: ids.label, carrier: 'Seed Van', trackingNumber: 'SEED-TRK-1', passedWarnings: ['PAYMENT_DUE_AT_SHIP'] })
    expect(audit!.after.warning).toBeUndefined()
    expect((await eventsOf(ids.leg, 'shipment.forwarded')).map((event) => event.payload)).toEqual([expect.objectContaining({ warehouseSiteId: WAREHOUSE, withoutLabel: false, partyId: A.customer })])
    await refusedFor('warehouse', 'POST', `/shipping/shipments/${ids.leg}/forward`, { version: sentOn.version, carrier: null, trackingNumber: null, overrides: ['PAYMENT_DUE_AT_SHIP'] }, 'SENT_ON_ALREADY')
    // The label no longer changes once sent on.
    const late = await officeFile(ids.leg, 'late-label.pdf')
    await refusedFor('warehouse', 'POST', `/shipping/shipments/${ids.leg}/customer-label`, { version: sentOn.version, fileId: late }, 'LABEL_AFTER_SEND_ON')
    expect((await legsOf())[0]).toMatchObject({ state: 'SENT_ON', may: { arrived: false, sendOn: false, label: false } })
    // Billed now: the sale DDT, never the transfer.
    const queue = JSON.stringify(await ok('finance', 'GET', `/invoicing/shipped-not-invoiced?companyId=${A.companyA}`))
    expect(queue).toContain(ids.saleDdt)
    expect(queue).not.toContain(ids.transferDdt)
    // Delivered now (G9 passes once sent on).
    await database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, (client) => client.shipment.update({ where: { id: ids.leg }, data: { status: 'DELIVERED', deliveredAt: new Date() }, select: { id: true } }))
    expect((await shipmentOf(ids.leg)).status).toBe('DELIVERED')
    await settle(ids.balance)
  })

  it('sent on without the customer’s label (a shipment that travels without a DDT): allowed, with the warning in its audit row', async () => {
    const made = await ok('warehouse', 'POST', '/shipping/shipments', { salesOrderId: so2(), siteId: A.siteA1, destination: { kind: 'OUR_WAREHOUSE', siteId: WAREHOUSE }, lines: [{ workOrderSizeId: cell('RED-54'), quantity: 1 }] }, 201)
    const id = made.shipment.id as string
    await ok('warehouse', 'PUT', `/shipping/shipments/${id}/ddt-required`, { version: made.shipment.version, required: false, reason: 'Test: an immediate invoice travels.' })
    await packed(await shipmentOf(id))
    expect((await ok('warehouse', 'POST', `/shipping/shipments/${id}/ship`, { version: await versionOf(id) })).shipment.status).toBe('SHIPPED')
    await ok('warehouse', 'POST', `/shipping/shipments/${id}/arrived`, { version: await versionOf(id) })
    // S3 lead yes 09:05: left without a DDT but still at our warehouse — not in the "shipped without a DDT" list (immediate invoice) yet.
    const before = await ok('finance', 'GET', `/invoicing/shipped-not-invoiced?companyId=${A.companyA}`)
    expect(JSON.stringify((before.customers as Json[]).flatMap((customer) => customer.shipments ?? []))).not.toContain(id)
    const sentOn = await ok('warehouse', 'POST', `/shipping/shipments/${id}/forward`, { version: await versionOf(id), carrier: null, trackingNumber: null })
    expect(sentOn.forwardedWithoutLabel).toBe(true)
    // Sent on: listed now.
    const after = await ok('finance', 'GET', `/invoicing/shipped-not-invoiced?companyId=${A.companyA}`)
    expect(JSON.stringify((after.customers as Json[]).flatMap((customer) => customer.shipments ?? []))).toContain(id)
    expect(await legRow(id)).toMatchObject({ forwardedWithoutLabel: true, customerLabelFileId: null, forwardedById: WAREHOUSE_PERSON })
    expect((await auditOf(id, 'shipping.warehouseLeg.forwarded'))[0]!.after).toMatchObject({ forwardedWithoutLabel: true, warning: 'No label from the customer yet' })
  })
})

// ---- 1.3 the DDT reasons -------------------------------------------------------------------------------------------------------
describe('1.3 TRANSFER is a shipment’s reason only with a leg', () => {
  it('a shipment straight to the customer is refused a TRANSFER DDT, as before', async () => {
    const made = (await ok('warehouse', 'POST', '/shipping/shipments', { salesOrderId: so2(), siteId: A.siteA1, lines: [{ workOrderSizeId: cell('BLK-52'), quantity: 1 }] }, 201)).shipment
    ids.straight = made.id
    await packed(made)
    const preview = await ok('warehouse', 'POST', `/shipping/shipments/${ids.straight}/ddt/preview`, { reason: 'TRANSFER' })
    expect(preview.problems).toEqual([expect.objectContaining({ path: 'body/reason', message: "A transfer between sites travels with the transfer's own DDT, not a shipment to a customer." })])
    expect((await refused('warehouse', 'POST', `/shipping/shipments/${ids.straight}/ddt`, { reason: 'TRANSFER', carrier: { name: 'Seed Express' } }, 400)).issues[0].path).toBe('body/reason')
  })
})

// ---- 1.4 a payment due is a warning (settle L2) ----------------------------------------------------------------------------------
describe('1.4 a payment due before shipping is a warning when the goods leave to the customer, never a hold', () => {
  it('ship with an open before-shipping step: 409 with the list; with overrides SHIPPED and its own audit row keeps passedWarnings', async () => {
    const balance = await openBalance()
    await ok('warehouse', 'POST', `/shipping/shipments/${ids.straight}/ddt`, { carrier: { name: 'Seed Express' } }, 201)
    const version = await versionOf(ids.straight)
    const warned = await refused('warehouse', 'POST', `/shipping/shipments/${ids.straight}/ship`, { version }, 409)
    expect(warned).toMatchObject({ code: 'conflict' })
    expect(warned.issues).toEqual([{ path: 'warning/PAYMENT_DUE_AT_SHIP', message: 'A payment due before shipping is still open.' }])
    expect((await shipmentOf(ids.straight)).status).toBe('PACKED')
    const shipped = await ok('warehouse', 'POST', `/shipping/shipments/${ids.straight}/ship`, { version, overrides: ['PAYMENT_DUE_AT_SHIP'] })
    expect(shipped.shipment.status).toBe('SHIPPED')
    expect((await auditOf(ids.straight, 'shipping.ship'))[0]!.after).toMatchObject({ status: 'SHIPPED', passedWarnings: ['PAYMENT_DUE_AT_SHIP'] })
    await settle(balance)
  })

  it('the system places no BALANCE_UNPAID hold on an open shipment while the step is open', async () => {
    const balance = await openBalance()
    const draft = (await ok('warehouse', 'POST', '/shipping/shipments', { salesOrderId: so2(), siteId: A.siteA1, lines: [{ workOrderSizeId: cell('BLK-54'), quantity: 1 }] }, 201)).shipment
    expect(await syncSystemHolds(callerFor(database, systemContext(A.tenant, `owb-ss1-${newId()}`)), [draft.id])).toEqual({ placed: 0, lifted: 0 })
    expect(await admin(`SELECT 1 FROM "ShipmentHold" WHERE "shipmentId" = $1 AND reason = 'BALANCE_UNPAID'`, [draft.id])).toEqual([])
    expect((await ok('warehouse', 'GET', `/shipping/shipments/${draft.id}/holds`)).holds.held).toBe(false)
    await ok('warehouse', 'POST', `/shipping/shipments/${draft.id}/cancel`, { version: draft.version, reason: 'Test: done' })
    await settle(balance)
  })
})
