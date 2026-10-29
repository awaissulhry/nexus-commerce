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
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedShipping, type ShippingSeed } from '../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../adapters/local-files/local'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { createFilesRuntime, useFiles } from '../../platform/files/service'
import { createGateway } from '../../platform/gateway/gateway'
import { testRedis, type TestRedis } from '../../platform/outbox/testing'
import { createSecretsService } from '../../platform/secrets/envelope'
import { localKeyProvider } from '../../platform/secrets/local'
import { lockCells } from './cells'

/**
 * Shipping settings, shipments and packing from released goods only (B-W1-46; LOG-001, LOG-002, LOG-039, LOG-117,
 * GAP-002, PLT-097; Reg. (EU) 2016/425 art. 8) on the local stack, with the app's real routes: a throwaway PostgreSQL 17
 * database from the migrations (the runtime login, so row-level security, the column grants and the
 * …_quality_shipping_guards triggers are real), the factory-db seeds of two tenants (SH-0002 being packed, WO-0003's
 * serial-tracked garments, WO-0001's releases and reversal), the local file store for the packing list, and sessions
 * from the test authenticator. Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs shipping`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string
let seedA: ShippingSeed
let seedB: ShippingSeed

const ns = { a: 'shipping-a', b: 'shipping-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const A = {
  tenant: idOf(ns.a, 'tenant'),
  companyA: idOf(ns.a, 'company:A'),
  companyB: idOf(ns.a, 'company:B'),
  siteA1: idOf(ns.a, 'site:A1'),
  siteB1: idOf(ns.a, 'site:B1'),
  brand: idOf(ns.a, 'party:P1'),
  operator: idOf(ns.a, 'worker:A1:operator'),
  lead: idOf(ns.a, 'worker:A1:lead'),
}
const B = { tenant: idOf(ns.b, 'tenant'), companyA: idOf(ns.b, 'company:A'), siteA1: idOf(ns.b, 'site:A1') }

const ALL: Permission[] = ['shipping.view', 'shipping.manage', 'shipping.pack', 'shipping.settings.view', 'shipping.settings.manage']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants })
const floor = (siteId: string, companyId: string, permissions: Permission[], actorId = A.operator): SessionContext => ({
  audience: 'floor',
  tenantId: A.tenant,
  actorId,
  siteId,
  deviceId: newId(),
  grants: [grant(permissions, [companyId], [siteId])],
})
const SESSIONS: Record<string, SessionContext> = {
  warehouse: office(A.tenant, [grant([...ALL, 'files.read'])]),
  viewer: office(A.tenant, [grant(['shipping.view', 'shipping.settings.view'])]),
  companyB: office(A.tenant, [grant(ALL, [A.companyB])]),
  otherTenant: office(B.tenant, [grant(ALL)]),
  partner: { audience: 'partner', tenantId: A.tenant, actorId: newId(), partyId: A.brand, grants: [grant(ALL)] },
  packerA1: floor(A.siteA1, A.companyA, ['shipping.pack']),
  packerA1b: floor(A.siteA1, A.companyA, ['shipping.pack'], A.lead),
  packerB1: floor(A.siteB1, A.companyB, ['shipping.pack']),
  floorNoPack: floor(A.siteA1, A.companyA, ['floor.work']),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
let keys = 0
const run = randomBytes(4).toString('hex')
const key = () => `shipping-test-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown, idempotencyKey?: string) =>
  app.inject({
    method,
    url,
    headers: { 'x-test-session': session, ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
    ...(payload === undefined ? {} : { payload: payload as object }),
  })
/** A floor write always carries an Idempotency-Key (a resent tap packs once). */
const floorKey = (session: string) => (SESSIONS[session]!.audience === 'floor' ? key() : undefined)
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload, method === 'GET' ? undefined : floorKey(session))
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload, method === 'GET' ? undefined : floorKey(session))
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const serialCodes = async (ids: readonly string[]) => (await admin<{ id: string; serial: string }>('SELECT id, serial FROM "GarmentSerial" WHERE id = ANY($1::uuid[])', [ids])).reduce<Record<string, string>>((map, row) => ({ ...map, [row.id]: row.serial }), {})
const readyCell = async (session: string, cellId: string): Promise<Json | undefined> =>
  ((await ok(session, 'GET', '/shipping/ready')).orders as Json[]).flatMap((order) => order.cells as Json[]).find((cell) => cell.workOrderSizeId === cellId)
const waitingForAdvisoryLocks = async (count: number) => {
  for (let tries = 0; ; tries++) {
    const n = (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`))[0]!.n
    if (n >= count) return
    if (tries > 250) throw new Error(`only ${n} request(s) waited for the cell's shipping lock`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
/** Holds a cell's shipping lock in another session until `release` is called. */
function holdCellLock(tenantId: string, cellId: string) {
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  let locked!: () => void
  const holding = new Promise<void>((resolve) => (locked = resolve))
  const holder = database.withScope({ audience: 'office', tenantId, actorId: newId() }, (client) =>
    client.$transaction(
      async (tx) => {
        await lockCells(tx, tenantId, [cellId])
        locked()
        await released
      },
      { timeout: 20_000 },
    ),
  )
  return { holding, release: async () => (release(), await holder) }
}

beforeAll(async () => {
  db = await migratedDatabase('shipping')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 12 } })
  // As the seed CLI runs them: _core first; the shipping seed runs the seeds it builds on.
  for (const namespace of [ns.a, ns.b]) await seedCore({ db: database, namespace })
  seedA = await seedShipping({ db: database, namespace: ns.a })
  seedB = await seedShipping({ db: database, namespace: ns.b })
  for (const [tenantId, companyId] of [
    [A.tenant, A.companyA],
    [B.tenant, B.companyA],
  ] as const) {
    // Made-up legal data (c.c. art. 2250) for the packing list, a SHIPMENT number series, the tenant's FAKE file store.
    await admin(`UPDATE "Company" SET "vatNumber" = 'IT12345670009', "fiscalCode" = '12345670009', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyId])
    await admin(
      `INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'SHIPMENT', 'MAIN', 'ALL', 'NEVER', 'SH-{N:5}', false)`,
      [newId(), tenantId, companyId],
    )
    if ((await admin(`SELECT 1 FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2'`, [tenantId])).length === 0) {
      await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenantId])
    }
  }
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-shipping-test-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
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

// The seeded facts (packages/factory-db seed/quality.ts and seed/shipping.ts): WO-0001 (batch-tracked, SO-0002)
// released BLK 50 x1, BLK 52 x2 (one reversed), RED 52 x1, and SH-0001 shipped the BLK 50 and the RED 52; WO-0003
// (serial-tracked, SO-0003) released two garments of its one cell (serials 2 and 3; serial 1 is MADE), and the DRAFT
// SH-0002 holds one of them in an unweighed parcel, without its serial.
const cells = () => ({ blk52: seedA.quality.production.cellIds['BLK-52'], red52: seedA.quality.production.cellIds['RED-52'], jacket: seedA.quality.serialCellId })
const orders = () => ({ so2: seedA.quality.production.salesOrderId, so3: seedA.quality.serialSalesOrderId })
const shipmentIds: Record<string, string> = {}

describe('what is ready to ship (SCR-066; LOG-001, LOG-002)', () => {
  it('Reg. (EU) 2016/425 art. 8: lists per sales order the released garments shipments do not hold yet, less reversals', async () => {
    const ready = await ok('warehouse', 'GET', '/shipping/ready')
    const so2 = (ready.orders as Json[]).find((order) => order.salesOrderId === orders().so2)!
    expect(so2.cells.map((cell: Json) => [cell.colourwayCode, cell.size, cell.released, cell.reversed, cell.onShipments, cell.shippable])).toEqual([['BLK', '52', 2, 1, 0, 1]])
    const so3 = (ready.orders as Json[]).find((order) => order.salesOrderId === orders().so3)!
    expect(so3.cells).toEqual([expect.objectContaining({ workOrderSizeId: cells().jacket, released: 2, reversed: 0, onShipments: 1, shippable: 1, serialTracked: true, pieces: 4 })])
    expect(so3.party).toEqual({ code: expect.any(String), legalName: expect.any(String) })
  })

  it('shows nothing beyond the grants: another company, another tenant; a portal session is refused', async () => {
    expect((await ok('companyB', 'GET', '/shipping/ready')).orders).toEqual([])
    expect(JSON.stringify(await ok('otherTenant', 'GET', '/shipping/ready'))).not.toContain(orders().so2)
    expect((await refused('partner', 'GET', '/shipping/ready', undefined, 403)).code).toBe('forbidden')
    expect((await refused('packerA1', 'GET', '/shipping/ready', undefined, 403)).code).toBe('forbidden')
  })
})

describe('a shipment from released goods only (LOG-001, LOG-002, GAP-002)', () => {
  it('Reg. (EU) 2016/425 art. 8: refuses more garments than are released (409, no number used), then plans a DRAFT', async () => {
    const tooMany = await refused('warehouse', 'POST', '/shipping/shipments', { salesOrderId: orders().so2, lines: [{ workOrderSizeId: cells().blk52, quantity: 2 }] }, 409)
    expect(tooMany.message).toBe('Only released garments ship: SEED-WO-0001 BLK 52 has 1 released (less reversals) and 0 on shipments, so 1 can still ship; 2 asked.')
    expect(await admin(`SELECT 1 FROM "Shipment" WHERE "salesOrderId" = $1 AND status = 'DRAFT'`, [orders().so2])).toEqual([])

    const { shipment } = await ok('warehouse', 'POST', '/shipping/shipments', { salesOrderId: orders().so2, lines: [{ workOrderSizeId: cells().blk52, quantity: 1 }] }, 201)
    shipmentIds.s1 = shipment.id
    expect(shipment).toMatchObject({ number: 'SH-00001', status: 'DRAFT', version: 1, siteId: A.siteA1, partyId: A.brand, transportBy: 'CARRIER', carrierCode: 'seed-express', serviceCode: 'seed-standard', garments: 1 })
    expect(shipment.shipTo).toEqual(expect.any(Object))
    expect(shipment.lines).toEqual([expect.objectContaining({ workOrderNumber: 'SEED-WO-0001', colourwayCode: 'BLK', size: '52', quantity: 1, parcelId: null, serialTracked: false })])
    expect(shipment.packingProblems).toEqual(['every garment in a parcel (1 not packed)', 'at least one parcel'])
    expect((await readyCell('warehouse', cells().blk52))).toBeUndefined()

    const types = await admin<{ type: string }>('SELECT type FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [shipment.id])
    expect(types.map((row) => row.type)).toEqual(['shipment.created', 'shipment.packing_changed'])
    const audits = await admin<{ action: string; recordType: string }>('SELECT action, "recordType" FROM "AuditLog" WHERE "recordId" = $1 OR ("recordType" = \'ShipmentLine\' AND after->>\'shipmentId\' = $1::text)', [shipment.id])
    expect(audits.map((row) => `${row.recordType} ${row.action}`).sort()).toEqual(['Shipment shipping.create', 'ShipmentLine shipping.addLine'])
  })

  it("keeps a shipment's lines to its order's released garments, and changes them only while a DRAFT", async () => {
    const s1 = shipmentIds.s1!
    expect((await refused('warehouse', 'POST', `/shipping/shipments/${s1}/lines`, { lines: [{ workOrderSizeId: cells().red52, quantity: 1 }] }, 409)).message).toBe(
      'Only released garments ship: SEED-WO-0001 RED 52 has 1 released (less reversals) and 1 on shipments, so 0 can still ship; 1 asked.',
    )
    const otherOrder = await refused('warehouse', 'POST', `/shipping/shipments/${s1}/lines`, { lines: [{ workOrderSizeId: cells().jacket, quantity: 1 }] }, 400)
    expect(otherOrder.issues).toEqual([{ path: 'body/lines/0/workOrderSizeId', message: "These garments are not of the shipment's sales order." }])
    const line = (await ok('warehouse', 'GET', `/shipping/shipments/${s1}`)).shipment.lines[0]
    expect((await refused('warehouse', 'PATCH', `/shipping/shipments/${s1}/lines/${line.id}`, { quantity: 2 }, 409)).code).toBe('conflict')
    expect((await refused('warehouse', 'PATCH', `/shipping/shipments/${s1}/lines/${line.id}`, { version: 99, quantity: 1 }, 409)).message).toMatch(/changed since it was read \(version 99\); it is now at version 1/)
    const removed = (await ok('warehouse', 'DELETE', `/shipping/shipments/${s1}/lines/${line.id}`)).shipment
    expect(removed.lines).toEqual([])
    expect((await readyCell('warehouse', cells().blk52))?.shippable).toBe(1)
    const back = (await ok('warehouse', 'POST', `/shipping/shipments/${s1}/lines`, { version: removed.version, lines: [{ workOrderSizeId: cells().blk52, quantity: 1 }] })).shipment
    expect(back.lines.map((entry: Json) => entry.quantity)).toEqual([1])
  })

  it('walls: a viewer cannot plan, another company and tenant do not find it, portal and floor sessions are refused', async () => {
    const s1 = shipmentIds.s1!
    expect((await refused('viewer', 'POST', '/shipping/shipments', { salesOrderId: orders().so2 }, 403)).code).toBe('forbidden')
    expect((await ok('viewer', 'GET', `/shipping/shipments/${s1}`)).shipment.number).toBe('SH-00001')
    expect((await refused('companyB', 'GET', `/shipping/shipments/${s1}`, undefined, 404)).code).toBe('not_found')
    expect((await refused('otherTenant', 'GET', `/shipping/shipments/${s1}`, undefined, 404)).code).toBe('not_found')
    expect((await refused('otherTenant', 'POST', '/shipping/shipments', { salesOrderId: orders().so2 }, 404)).message).toBe('Sales order not found.')
    expect((await refused('partner', 'GET', `/shipping/shipments/${s1}`, undefined, 403)).code).toBe('forbidden')
    expect((await refused('partner', 'GET', '/shipping/shipments', undefined, 403)).code).toBe('forbidden')
    expect((await refused('packerA1', 'GET', `/shipping/shipments/${s1}`, undefined, 403)).code).toBe('forbidden')
    expect((await ok('companyB', 'GET', '/shipping/shipments')).shipments).toEqual([])
    const listed = (await ok('warehouse', 'GET', `/shipping/shipments?salesOrderId=${orders().so2}`)).shipments
    expect(listed.map((row: Json) => [row.number, row.status, row.garments]).sort()).toEqual([['SEED-SH-0001', 'SHIPPED', 2], ['SH-00001', 'DRAFT', 1]])
  })
})

describe('packing on the floor (SCR-098; LOG-039, QHS-073)', () => {
  const sh2 = () => seedA.draftShipmentId
  const parcel = () => seedA.draftParcelId

  it('shows the site its packing queue and what SH-0002 still needs, and refuses to pack it until it has it (PLT-097)', async () => {
    const queue = (await ok('packerA1', 'GET', '/shipping/packing')).shipments as Json[]
    expect(queue.map((row) => [row.number, row.status])).toEqual(expect.arrayContaining([['SEED-SH-0002', 'DRAFT'], ['SH-00001', 'DRAFT']]))
    expect(queue.some((row) => row.status === 'SHIPPED')).toBe(false)
    const view = (await ok('packerA1', 'GET', `/shipping/packing/${sh2()}`)).shipment
    expect(view).not.toHaveProperty('shipTo')
    expect(view).not.toHaveProperty('party')
    expect(view.settings).toEqual({ cutOffTime: '16:00', defaultGoodsAppearance: 'Scatole di cartone', labelPrinterId: null, documentPrinterId: null })
    expect(view.lines).toEqual([expect.objectContaining({ parcelId: parcel(), quantity: 1, serialTracked: true, serials: [] })])
    const refusal = await refused('packerA1', 'POST', `/shipping/packing/${sh2()}/pack`, {}, 409)
    expect(refusal.code).toBe('invalid_state')
    expect(refusal.issues.map((issue: Json) => issue.message)).toEqual(['every parcel weighed (parcel 1 not weighed)', 'a serial for each garment of a serial-tracked style (1 missing)'])
  })

  it('QHS-073: packs only a released serial, weighs the parcel, then packs the shipment; a floor write needs an Idempotency-Key', async () => {
    const codes = await serialCodes(seedA.quality.serialIds)
    const [made, first] = seedA.quality.serialIds
    expect((await call('packerA1', 'POST', `/shipping/packing/${sh2()}/serials`, { serial: codes[first]! })).statusCode).toBe(400)
    expect((await refused('packerA1', 'POST', `/shipping/packing/${sh2()}/serials`, { serial: codes[made]! }, 409)).message).toBe(`Serial ${codes[made]} is MADE: only garments quality released are packed (QHS-073).`)
    const packed = (await ok('packerA1', 'POST', `/shipping/packing/${sh2()}/serials`, { serial: codes[first]! })).shipment
    expect(packed.lines[0].serials).toEqual([{ id: first, serial: codes[first] }])
    // A resent tap with the same key answers the first answer again and changes nothing.
    const tap = key()
    const weighed = await call('packerA1', 'PATCH', `/shipping/packing/${sh2()}/parcels/${parcel()}`, { grossWeightKg: '1.85', lengthCm: '60', widthCm: '40', heightCm: '12' }, tap)
    expect(weighed.statusCode, weighed.body).toBe(200)
    const again = await call('packerA1', 'PATCH', `/shipping/packing/${sh2()}/parcels/${parcel()}`, { grossWeightKg: '1.85', lengthCm: '60', widthCm: '40', heightCm: '12' }, tap)
    expect(again.json()).toEqual(weighed.json())
    expect(weighed.json().shipment.parcels).toEqual([expect.objectContaining({ seq: 1, grossWeightKg: '1.8500', lengthCm: '60.00', garments: 1 })])
    const done = (await ok('packerA1', 'POST', `/shipping/packing/${sh2()}/pack`, {})).shipment
    expect(done).toMatchObject({ status: 'PACKED', packingProblems: [] })
    expect(done.packedAt).toEqual(expect.any(String))
    const audit = await admin<{ audience: string; actorId: string; siteId: string }>(`SELECT audience, "actorId", "siteId" FROM "AuditLog" WHERE "recordId" = $1 AND action = 'shipping.packShipment'`, [sh2()])
    expect(audit).toEqual([{ audience: 'FLOOR', actorId: A.operator, siteId: A.siteA1 }])
  })

  it('floor walls: another site finds nothing, a worker without shipping.pack is refused, the floor never cancels or ships', async () => {
    expect((await refused('packerB1', 'GET', `/shipping/packing/${sh2()}`, undefined, 404)).code).toBe('not_found')
    expect((await refused('packerB1', 'POST', `/shipping/packing/${sh2()}/unpack`, {}, 404)).code).toBe('not_found')
    expect((await ok('packerB1', 'GET', '/shipping/packing')).shipments).toEqual([])
    expect((await refused('floorNoPack', 'GET', `/shipping/packing/${sh2()}`, undefined, 403)).code).toBe('forbidden')
    expect((await refused('packerA1', 'POST', `/shipping/shipments/${sh2()}/cancel`, { reason: 'no' }, 403)).code).toBe('forbidden')
    expect((await refused('packerA1', 'POST', `/shipping/shipments/${sh2()}/lines`, { lines: [{ workOrderSizeId: cells().jacket, quantity: 1 }] }, 403)).code).toBe('forbidden')
    // No route ships; the database refuses a floor session that tries (the …_quality_shipping_guards trigger).
    await expect(
      database.withScope({ audience: 'floor', tenantId: A.tenant, actorId: A.operator, siteId: A.siteA1 }, (client) =>
        client.shipment.update({ where: { id: sh2() }, data: { status: 'SHIPPED', shippedAt: new Date() }, select: { id: true } }),
      ),
    ).rejects.toThrow()
    expect((await ok('packerA1', 'GET', `/shipping/packing/${sh2()}`)).shipment.status).toBe('PACKED')
  })

  it('unpacks (PACKED → DRAFT) and packs again; a parcel of a PACKED shipment keeps its weight', async () => {
    expect((await refused('packerA1', 'PATCH', `/shipping/packing/${sh2()}/parcels/${parcel()}`, { grossWeightKg: null }, 409)).message).toBe('The shipment is PACKED: every parcel keeps a weight (unpack it first).')
    expect((await ok('packerA1', 'POST', `/shipping/packing/${sh2()}/unpack`, {})).shipment).toMatchObject({ status: 'DRAFT', packedAt: null })
    expect((await ok('packerA1', 'POST', `/shipping/packing/${sh2()}/pack`, {})).shipment.status).toBe('PACKED')
  })

  it('the office cancels the PACKED SH-0002: its serial is unpacked, its garment can ship again (LOG-002)', async () => {
    const before = (await ok('warehouse', 'GET', `/shipping/shipments/${sh2()}`)).shipment
    expect((await refused('viewer', 'POST', `/shipping/shipments/${sh2()}/cancel`, { reason: 'x' }, 403)).code).toBe('forbidden')
    const cancelled = (await ok('warehouse', 'POST', `/shipping/shipments/${sh2()}/cancel`, { version: before.version, reason: 'The customer asked to wait.' })).shipment
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'The customer asked to wait.' })
    expect(cancelled.lines[0].serials).toEqual([])
    expect(await admin(`SELECT "shipmentLineId", status::text FROM "GarmentSerial" WHERE id = $1`, [seedA.quality.serialIds[1]])).toEqual([{ shipmentLineId: null, status: 'RELEASED' }])
    expect((await readyCell('warehouse', cells().jacket))).toMatchObject({ released: 2, onShipments: 0, shippable: 2 })
    expect((await refused('warehouse', 'POST', `/shipping/shipments/${sh2()}/cancel`, { reason: 'again' }, 409)).code).toBe('invalid_state')
    const types = await admin<{ type: string; payload: Json }>(`SELECT type, payload FROM "OutboxEvent" WHERE subject = $1 AND type = 'shipment.status_changed' ORDER BY "occurredAt", id`, [sh2()])
    expect(types.map((row) => `${row.payload.from}>${row.payload.to}`)).toEqual(['DRAFT>PACKED', 'PACKED>DRAFT', 'DRAFT>PACKED', 'PACKED>CANCELLED'])
  })
})

describe("one cell's shipping lock (the triggers' order: the shipment's row, then the cell)", () => {
  const create = async (lines: Json[] = []) => (await ok('warehouse', 'POST', '/shipping/shipments', { salesOrderId: orders().so3, siteId: A.siteA1, lines }, 201)).shipment

  it('two packers on one cell at once: both wait for the cell lock, then both pack, with no deadlock', async () => {
    const s2 = await create([{ workOrderSizeId: cells().jacket, quantity: 1 }])
    const s3 = await create([{ workOrderSizeId: cells().jacket, quantity: 1 }])
    Object.assign(shipmentIds, { s2: s2.id, s3: s3.id })
    const p2 = (await ok('packerA1', 'POST', `/shipping/packing/${s2.id}/parcels`, {}, 201)).parcelId
    const p3 = (await ok('packerA1b', 'POST', `/shipping/packing/${s3.id}/parcels`, {}, 201)).parcelId
    const lock = holdCellLock(A.tenant, cells().jacket)
    await lock.holding
    const results = Promise.all([
      call('packerA1', 'PUT', `/shipping/packing/${s2.id}/lines/${s2.lines[0].id}/parcel`, { parcelId: p2 }, key()),
      call('packerA1b', 'PUT', `/shipping/packing/${s3.id}/lines/${s3.lines[0].id}/parcel`, { parcelId: p3 }, key()),
    ])
    await waitingForAdvisoryLocks(2)
    await lock.release()
    const responses = await results
    expect(responses.map((response) => response.statusCode), responses.map((response) => response.body).join('\n')).toEqual([200, 200])
    expect(responses.map((response) => response.json().shipment.lines[0].parcelId)).toEqual([p2, p3])
  })

  it('two requests for the last released garment: they queue on the cell lock, one plans it, the other gets a clear 409 (never a 500)', async () => {
    // Without the API's own lock both would read "1 can still ship" before either inserted, and the second would meet
    // the trigger's refusal instead: a 500.
    await ok('warehouse', 'POST', `/shipping/shipments/${shipmentIds.s3}/cancel`, { reason: 'Merged into another shipment.' })
    const [s4, s5] = [await create(), await create()]
    Object.assign(shipmentIds, { s4: s4.id, s5: s5.id })
    const lock = holdCellLock(A.tenant, cells().jacket)
    await lock.holding
    const results = Promise.all([s4, s5].map((shipment) => call('warehouse', 'POST', `/shipping/shipments/${shipment.id}/lines`, { lines: [{ workOrderSizeId: cells().jacket, quantity: 1 }] })))
    await waitingForAdvisoryLocks(2)
    await lock.release()
    const responses = await results
    expect(responses.map((response) => response.statusCode).sort(), responses.map((response) => response.body).join('\n')).toEqual([200, 409])
    expect(responses.find((response) => response.statusCode === 409)!.json().error.message).toBe(
      'Only released garments ship: SEED-WO-0003 BLK 52 has 2 released (less reversals) and 2 on shipments, so 0 can still ship; 1 asked.',
    )
    const n = (
      await admin<{ n: number }>(
        `SELECT coalesce(sum(l.quantity), 0)::int AS n FROM "ShipmentLine" l JOIN "Shipment" s ON s.id = l."shipmentId" WHERE l."workOrderSizeId" = $1 AND s.status <> 'CANCELLED'`,
        [cells().jacket],
      )
    )[0]!.n
    expect(n).toBe(2)
  })
})

describe('parcels, splits and serials, then the packing list (LOG-039)', () => {
  it('splits a line across two parcels, packs each serial into its parcel, joins them again, closes the gap, packs', async () => {
    for (const id of [shipmentIds.s2!, shipmentIds.s4!, shipmentIds.s5!]) {
      const { shipment } = await ok('warehouse', 'GET', `/shipping/shipments/${id}`)
      if (shipment.status !== 'CANCELLED') await ok('warehouse', 'POST', `/shipping/shipments/${id}/cancel`, { reason: 'Replaced by one shipment.' })
    }
    const s6 = (await ok('warehouse', 'POST', '/shipping/shipments', { salesOrderId: orders().so3, siteId: A.siteA1, lines: [{ workOrderSizeId: cells().jacket, quantity: 2 }] }, 201)).shipment
    shipmentIds.s6 = s6.id
    const url = `/shipping/packing/${s6.id}`
    expect((await refused('packerA1', 'POST', `${url}/parcels`, { grossWeightKg: '0' }, 400)).issues).toEqual([{ path: 'body/grossWeightKg', message: 'Expected a weight in kilograms above 0, with at most 4 decimals.' }])
    const p1 = (await ok('packerA1', 'POST', `${url}/parcels`, {}, 201)).parcelId
    const p2 = (await ok('packerA1', 'POST', `${url}/parcels`, { lengthCm: '50' }, 201)).parcelId
    const lineId = s6.lines[0].id
    const split = (await ok('packerA1', 'PUT', `${url}/lines/${lineId}/parcel`, { parcelId: p1, quantity: 1 })).shipment
    expect(split.lines.map((line: Json) => [line.parcelId, line.quantity]).sort()).toEqual([[null, 1], [p1, 1]].sort())
    const rest = split.lines.find((line: Json) => line.parcelId === null)
    const moved = (await ok('packerA1', 'PUT', `${url}/lines/${rest.id}/parcel`, { parcelId: p2 })).shipment
    expect(moved.parcels.map((parcel: Json) => [parcel.seq, parcel.garments])).toEqual([[1, 1], [2, 1]])

    const codes = await serialCodes(seedA.quality.serialIds)
    const [, second, third] = seedA.quality.serialIds
    await ok('packerA1', 'POST', `${url}/serials`, { serial: codes[second]!, parcelId: p1 })
    const both = (await ok('packerA1', 'POST', `${url}/serials`, { serial: codes[third]!, parcelId: p2 })).shipment
    expect(both.lines.map((line: Json) => [line.parcelId, line.serials.map((serial: Json) => serial.serial)])).toEqual(
      expect.arrayContaining([[p1, [codes[second]]], [p2, [codes[third]]]]),
    )
    expect((await refused('packerA1', 'POST', `${url}/serials`, { serial: codes[third]! }, 409)).message).toBe(`Serial ${codes[third]} is in this shipment already.`)
    const inP2 = both.lines.find((line: Json) => line.parcelId === p2)
    expect((await refused('packerA1', 'DELETE', `${url}/parcels/${p2}`, undefined, 409)).message).toBe('Parcel 2 holds garments: move them first.')
    // The whole line with its serial joins the line of its cell in parcel 1; parcel 2 is empty and goes; 1 stays 1.
    const joined = (await ok('packerA1', 'PUT', `${url}/lines/${inP2.id}/parcel`, { parcelId: p1 })).shipment
    expect(joined.lines).toEqual([expect.objectContaining({ parcelId: p1, quantity: 2, serials: expect.arrayContaining([{ id: second, serial: codes[second] }, { id: third, serial: codes[third] }]) })])
    expect((await refused('packerA1', 'POST', `${url}/pack`, {}, 409)).issues.map((issue: Json) => issue.message)).toEqual([
      'every parcel weighed (parcel 1, 2 not weighed)',
      'garments in every parcel (parcel 2 is empty: remove it)',
    ])
    const removed = (await ok('packerA1', 'DELETE', `${url}/parcels/${p2}`)).shipment
    expect(removed.parcels.map((parcel: Json) => [parcel.id, parcel.seq])).toEqual([[p1, 1]])
    await ok('packerA1', 'PATCH', `${url}/parcels/${p1}`, { grossWeightKg: '3.4' })
    expect((await ok('packerA1', 'POST', `${url}/pack`, {})).shipment).toMatchObject({ status: 'PACKED', garments: 2, packingProblems: [] })
    expect((await refused('packerA1', 'PUT', `${url}/lines/${lineId}/parcel`, { parcelId: null }, 409)).message).toMatch(/is PACKED/)
  })

  it('prints the packing list through the documents service: a PDF of the shipment, for the office and its site floor', async () => {
    expect((await refused('viewer', 'POST', `/shipping/shipments/${shipmentIds.s1}/packing-list`, {}, 403)).code).toBe('forbidden')
    expect((await refused('warehouse', 'POST', `/shipping/shipments/${shipmentIds.s1}/packing-list`, {}, 409)).message).toMatch(/1 garment\(s\) are not in a parcel yet/)
    const printed = await ok('warehouse', 'POST', `/shipping/shipments/${shipmentIds.s6}/packing-list`, { language: 'en' }, 201)
    expect(printed.layout).toBe('PACKING_LIST/1')
    expect(printed.file).toMatchObject({ recordType: 'Shipment', recordId: shipmentIds.s6, kind: 'DOCUMENT', contentType: 'application/pdf', status: 'AVAILABLE' })
    const [row] = await admin<{ visibility: string[]; floorSiteId: string }>('SELECT visibility::text[] AS visibility, "floorSiteId" FROM "StoredFile" WHERE id = $1', [printed.file.id])
    expect(row).toEqual({ visibility: ['OFFICE', 'FLOOR'], floorSiteId: A.siteA1 })
  })
})

describe('shipping settings per site (LOG-117; SCR-068)', () => {
  const sender = { name: 'Seed Factory A S.r.l.', line1: 'Via Seed 1', postalCode: '00000', city: 'Seedtown', province: 'MI', country: 'IT' }

  it('lists the sites the grants reach with their settings, and saves a site whole with its version', async () => {
    const listed = (await ok('warehouse', 'GET', '/shipping/settings')).sites as Json[]
    expect(listed.map((entry) => [entry.site.id, entry.settings?.cutOffTime ?? null])).toEqual(expect.arrayContaining([[A.siteA1, '16:00'], [A.siteB1, null]]))
    expect(((await ok('companyB', 'GET', '/shipping/settings')).sites as Json[]).map((entry) => entry.site.id)).toEqual([A.siteB1])
    const current = (await ok('warehouse', 'GET', `/shipping/settings/${A.siteA1}`)).settings
    const saved = await ok('warehouse', 'PUT', `/shipping/settings/${A.siteA1}`, { version: current.version, senderAddress: sender, defaultCarrierCode: 'brt', defaultServiceCode: 'brt:express', defaultTransportBy: 'CARRIER', cutOffTime: '17:30' })
    expect(saved.settings).toMatchObject({ defaultCarrierCode: 'brt', defaultServiceCode: 'brt:express', cutOffTime: '17:30', defaultGoodsAppearance: null, returnAddress: null, version: current.version + 1 })
    expect((await refused('warehouse', 'PUT', `/shipping/settings/${A.siteA1}`, { version: current.version, senderAddress: sender }, 409)).code).toBe('conflict')
    const audit = await admin<{ action: string }>(`SELECT action FROM "AuditLog" WHERE "recordType" = 'ShippingSettings' AND "recordId" = $1`, [A.siteA1])
    expect(audit.map((row) => row.action)).toEqual(['shipping.saveSettings'])
  })

  it('creates the settings of a site that has none, and refuses a bad address, cut-off or another site printer', async () => {
    const siteB2 = newId()
    await admin(`INSERT INTO "Site" (id, "tenantId", "companyId", code, name, kind) VALUES ($1, $2, $3, 'B2', 'Seed warehouse B2', 'PLANT')`, [siteB2, A.tenant, A.companyB])
    expect((await ok('warehouse', 'GET', `/shipping/settings/${siteB2}`)).settings).toBeNull()
    expect((await refused('warehouse', 'PUT', `/shipping/settings/${siteB2}`, { version: 1, senderAddress: sender }, 404)).message).toBe('This site has no shipping settings yet; save them without a version.')
    const created = await ok('warehouse', 'PUT', `/shipping/settings/${siteB2}`, { senderAddress: { ...sender, name: 'Seed Factory B S.r.l.' }, cutOffTime: '15:00' }, 201)
    expect(created.settings).toMatchObject({ siteId: siteB2, companyId: A.companyB, cutOffTime: '15:00', defaultTransportBy: 'CARRIER', version: 1 })
    const bad = await refused('warehouse', 'PUT', `/shipping/settings/${siteB2}`, { senderAddress: { ...sender, country: 'It' }, cutOffTime: '25:00' }, 400)
    expect(bad.issues.map((issue: Json) => issue.path)).toEqual(['body/senderAddress/country', 'body/cutOffTime'])
    const printer = newId()
    await admin(`INSERT INTO "Printer" (id, "tenantId", "companyId", "siteId", code, name, kind, relay, "relayTarget", dpi, "labelWidthMm", "labelHeightMm") VALUES ($1, $2, $3, $4, 'LBL-A1', 'Label A1', 'LABEL_ZPL', 'FAKE', 'fake://a1', 203, 100, 150)`, [printer, A.tenant, A.companyA, A.siteA1])
    const elsewhere = await refused('warehouse', 'PUT', `/shipping/settings/${siteB2}`, { senderAddress: sender, labelPrinterId: printer }, 400)
    expect(elsewhere.issues).toEqual([{ path: 'body/labelPrinterId', message: 'Not a printer of this site.' }])
    const types = await admin<{ type: string; payload: Json }>(`SELECT type, payload FROM "OutboxEvent" WHERE subject = $1`, [siteB2])
    expect(types).toEqual([{ type: 'shipping.settings_saved', payload: { siteId: siteB2, created: true } }])
  })

  it('walls: a viewer reads but never saves, another company does not find the site, portal and floor are refused', async () => {
    expect((await ok('viewer', 'GET', `/shipping/settings/${A.siteA1}`)).settings.cutOffTime).toBe('17:30')
    expect((await refused('viewer', 'PUT', `/shipping/settings/${A.siteA1}`, { senderAddress: sender }, 403)).code).toBe('forbidden')
    expect((await refused('companyB', 'GET', `/shipping/settings/${A.siteA1}`, undefined, 404)).code).toBe('not_found')
    expect((await refused('otherTenant', 'GET', `/shipping/settings/${A.siteA1}`, undefined, 404)).code).toBe('not_found')
    expect((await refused('partner', 'GET', '/shipping/settings', undefined, 403)).code).toBe('forbidden')
    expect((await refused('packerA1', 'GET', `/shipping/settings/${A.siteA1}`, undefined, 403)).code).toBe('forbidden')
  })
})

describe('a reversal reduces what can ship (Reg. (EU) 2016/425 art. 8(8); tenant B)', () => {
  it('Reg. 2016/425 art. 8: once quality takes a released garment back, it is no longer ready and no shipment takes it', async () => {
    const blk52 = seedB.quality.production.cellIds['BLK-52']
    expect((await readyCell('otherTenant', blk52))).toMatchObject({ released: 2, reversed: 1, shippable: 1 })
    const release = seedB.quality.releaseIds['BLK-52']
    await admin(
      `INSERT INTO "QualityReleaseReversal" (id, "tenantId", "companyId", "siteId", "workOrderId", "workOrderSizeId", "releaseId", quantity, reason, "reversedById", "reversedAt")
       SELECT $1, r."tenantId", r."companyId", r."siteId", r."workOrderId", r."workOrderSizeId", r.id, 1, 'A seam opened after release.', $2, now() FROM "QualityRelease" r WHERE r.id = $3`,
      [newId(), newId(), release],
    )
    expect(await readyCell('otherTenant', blk52)).toBeUndefined()
    const refusal = await refused('otherTenant', 'POST', '/shipping/shipments', { salesOrderId: seedB.quality.production.salesOrderId, lines: [{ workOrderSizeId: blk52, quantity: 1 }] }, 409)
    expect(refusal.message).toBe('Only released garments ship: SEED-WO-0001 BLK 52 has 0 released (less reversals) and 0 on shipments, so 0 can still ship; 1 asked.')
  })
})
