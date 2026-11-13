import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPacking, type PackingSeed } from '../../../../../../packages/factory-db/seed/packing'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { cartonCodeParts } from './floor-view'

/**
 * The floor's view of a carton (B-W2b-387; design floor.scan "Carton (W2b)", LOG-019) on the local stack, with the app's real
 * route: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the column grants
 * are real), the factory-db seeds up to packing (SEED-SH-0002's parcel is carton "1 of 1" of the seed carton with its marks
 * printed and the BLK 52 jacket in it), sessions from the test authenticator. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/shipping/packing/floor-view`.
 *
 *   found      the marks' code (any case) answers the carton: its shipment's number and state, "1 of 1", the packaging, the
 *              garments by style, colour and size with the batch and how many serials — no customer, address or money
 *   refused    a code of no carton, a carton number the shipment has not, another site's tablet (404), a tablet without
 *              shipping.pack (403)
 *   labels     the carton's marks printed on the label printer are no carrier label: the labels view still says none printed
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let packingA: PackingSeed

const ns = 'floor-view-a'
const idOf = (key: string) => seedUuid(ns, key)
const A = { tenant: idOf('tenant'), companyA: idOf('company:A'), companyB: idOf('company:B'), siteA1: idOf('site:A1'), siteB1: idOf('site:B1'), operator: idOf('worker:A1:operator') }

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const DEVICE_A = newId()
const DEVICE_B = newId()
const PRINTER = newId()
const floorAt = (siteId: string, companyId: string, deviceId: string, permissions: Permission[]): SessionContext => ({
  audience: 'floor',
  tenantId: A.tenant,
  actorId: A.operator,
  siteId,
  deviceId,
  grants: [grant(permissions, [companyId], [siteId])],
})
const SESSIONS: Record<string, SessionContext> = {
  warehouse: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(['shipping.view', 'shipping.pack', 'print.view', 'print.labels'])] },
  packer: floorAt(A.siteA1, A.companyA, DEVICE_A, ['floor.work', 'shipping.pack']),
  sewer: floorAt(A.siteA1, A.companyA, DEVICE_A, ['floor.work', 'production.scan']),
  packerB: floorAt(A.siteB1, A.companyB, DEVICE_B, ['floor.work', 'shipping.pack']),
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const get = (session: string, code: string) => app.inject({ method: 'GET', url: `/shipping/cartons/scan?code=${encodeURIComponent(code)}`, headers: { 'x-test-session': session } })

beforeAll(async () => {
  db = await migratedDatabase('floor_view')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  await seedCore({ db: database, namespace: ns })
  packingA = await seedPacking({ db: database, namespace: ns })
  // The packing tablets (made up): one at A1, one at B1.
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, 'Test packing tablet A1', 'TABLET', 'ACTIVE', now())`, [DEVICE_A, A.tenant, A.companyA, A.siteA1])
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, 'Test packing tablet B1', 'TABLET', 'ACTIVE', now())`, [DEVICE_B, A.tenant, A.companyB, A.siteB1])
  // A label printer of A1 with labels tall enough for the marks (made up).
  await admin(
    `INSERT INTO "Printer" (id, "tenantId", "companyId", "siteId", code, name, kind, relay, "relayTarget", dpi, "labelWidthMm", "labelHeightMm") VALUES ($1, $2, $3, $4, 'LBL-FV', 'Test marks printer', 'LABEL_ZPL', 'FAKE', 'test-fv:9100', 203, 100, 150)`,
    [PRINTER, A.tenant, A.companyA, A.siteA1],
  )
  redis = testRedis()
  connection = redis.connect()
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 180_000)

afterAll(async () => {
  await app?.close()
  connection?.disconnect()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
}, 60_000)

describe('a carton by the code its marks carry (floor.scan "Carton", LOG-019)', () => {
  it('reads the code as the shipment number and the carton number', () => {
    expect(cartonCodeParts('SEED-SH-0002-1')).toEqual({ number: 'SEED-SH-0002', seq: 1 })
    expect(cartonCodeParts(' SH-00012-12 ')).toEqual({ number: 'SH-00012', seq: 12 })
    expect(cartonCodeParts('SH-00012')).toBeNull()
    expect(cartonCodeParts('SH-00012-0')).toBeNull()
    expect(cartonCodeParts('NOCODE')).toBeNull()
  })

  it("answers the carton to the site's tablet and the office: shipment, n of N, packaging, garments by size with the batch", async () => {
    const response = await get('packer', 'seed-sh-0002-1')
    expect(response.statusCode, response.body).toBe(200)
    const carton = response.json().carton as Json
    expect(carton).toMatchObject({
      shipmentId: packingA.shipmentId,
      shipmentNumber: 'SEED-SH-0002',
      shipmentStatus: 'DRAFT',
      hold: null,
      id: packingA.parcelId,
      seq: 1,
      closed: true,
      cartonNumber: 1,
      cartonCount: 1,
      cartons: 1,
      marksCurrent: true,
      labelled: false,
      packagingType: { name: 'Seed carton 60x40x40', kind: 'CARTON' },
      garments: 1,
    })
    expect(carton.contents).toEqual([expect.objectContaining({ colourwayCode: 'BLK', size: '52', quantity: 1, serials: 0 })])
    // Nothing of the customer, the order, an address, a serial number or money reaches the floor.
    expect(Object.keys(carton).sort()).toEqual(['cartonCount', 'cartonNumber', 'cartons', 'closed', 'contents', 'garments', 'grossWeightKg', 'hold', 'id', 'labelled', 'marksCurrent', 'netWeightKg', 'packagingType', 'seq', 'shipmentId', 'shipmentNumber', 'shipmentStatus'])
    expect(Object.keys(carton.contents[0]).sort()).toEqual(['batchNumber', 'colourwayCode', 'colourwayName', 'quantity', 'serials', 'size', 'styleCode', 'styleName'])
    const office = await get('warehouse', 'SEED-SH-0002-1')
    expect(office.statusCode, office.body).toBe(200)
    expect(office.json().carton).toEqual(carton)
  })

  it('refuses a code of no carton, a carton the shipment has not, another site and a role without packing', async () => {
    for (const code of ['SEED-SH-0002-2', 'SEED-SH-9999-1', 'NOCODE', 'SEED-SH-0002-0']) {
      const response = await get('packer', code)
      expect(response.statusCode, `${code}: ${response.body}`).toBe(404)
    }
    // B1's tablet does not see A1's shipment (row-level security, and can() pins the site).
    expect((await get('packerB', 'SEED-SH-0002-1')).statusCode).toBe(404)
    // A sewing tablet's person has no shipping.pack: the route says so before anything is read.
    expect((await get('sewer', 'SEED-SH-0002-1')).statusCode).toBe(403)
  })

  it("the carton's marks on the label printer are no carrier label: the labels view says none printed (B-W2b-387)", async () => {
    const printed = await app.inject({ method: 'POST', url: `/shipping/packing/${packingA.shipmentId}/cartons/marks/print`, headers: { 'x-test-session': 'warehouse' }, payload: { parcelIds: [packingA.parcelId], printerId: PRINTER } })
    expect(printed.statusCode, printed.body).toBe(201)
    const labels = await app.inject({ method: 'GET', url: `/shipping/shipments/${packingA.shipmentId}/labels`, headers: { 'x-test-session': 'packer' } })
    expect(labels.statusCode, labels.body).toBe(200)
    expect(labels.json().parcels.map((parcel: Json) => [parcel.trackingNumber, parcel.print])).toEqual([[null, null]])
  })

  it('names the hold in force by its reason code (the floor words it)', async () => {
    await admin('SET session_replication_role = replica')
    try {
      await admin(
        `INSERT INTO "ShipmentHold" (id, "tenantId", "siteId", "partyId", "shipmentId", reason, words, "placedAt") SELECT $1, s."tenantId", s."siteId", s."partyId", s.id, 'CREDIT', 'Test: over the credit limit.', now() - interval '1 minute' FROM "Shipment" s WHERE s.id = $2`,
        [newId(), packingA.shipmentId],
      )
    } finally {
      await admin('SET session_replication_role = DEFAULT')
    }
    const response = await get('packer', 'SEED-SH-0002-1')
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().carton.hold).toEqual({ reason: 'CREDIT' })
  })
})
