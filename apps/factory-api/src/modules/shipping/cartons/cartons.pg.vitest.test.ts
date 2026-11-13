import { randomBytes } from 'node:crypto'
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
import { seed as seedShipping, type ShippingSeed } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'

/**
 * Packing in depth (B-W2b-384; LOG-003, LOG-007, LOG-008, LOG-010, LOG-013; Rule 1: packers scan every garment) on the local
 * stack, with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level
 * security, the column grants, W1's shipping triggers and B-W2b-364's …_packing_w2b_guards are real), the factory-db seeds up
 * to packing (company A's cartons, defaults and mark templates; SH-0002 being packed with its carton contents), sessions from
 * the test authenticator. Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/shipping/cartons`.
 *
 *   packaging   types (the cost a cost: dropped without the grain, refused from a writer without it), defaults per style or
 *               size run, the customer's mark template; one live per scope, a switched-off type refused in words
 *   scan        a shipment of WO-0001's BLK 52 × 3 and BLK 54 × 2: SKU, barcode and batch scans into the bench's carton,
 *               counted per size; a wrong style, colour or size, an unknown code, an extra piece refused with their codes
 *   close       contents, the default packaging, the weight, "1 of 1", the marks on a 100 × 150 label printer (the customer's
 *               English template); a second carton makes it "1 of 2" and its marks due; a garment taken out reopens a carton
 *   hold        a shipment on hold takes nothing into its cartons (its reason in words), then packs once released
 *   serial      SH-0002 (W1's serial route leaves the serial out of its carton): W1's pack is a 409 in words, never a 500;
 *               the serial's scan puts it into its carton with when and who, and the shipment packs
 *   offline     a queued scan applied through floor-sync: a wrong one refused with its code, the tablet told it is final
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let shippingA: ShippingSeed
let packingA: PackingSeed

const ns = 'cartons-a'
const idOf = (key: string) => seedUuid(ns, key)
const A = { tenant: idOf('tenant'), companyA: idOf('company:A'), companyB: idOf('company:B'), siteA1: idOf('site:A1'), brand: idOf('party:P1'), operator: idOf('worker:A1:operator') }

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants })
const DEVICE = newId()
const floor = (permissions: Permission[]): SessionContext => ({ audience: 'floor', tenantId: A.tenant, actorId: A.operator, siteId: A.siteA1, deviceId: DEVICE, grants: [grant(permissions, [A.companyA], [A.siteA1])] })
const SHIPPING: Permission[] = ['shipping.view', 'shipping.manage', 'shipping.pack', 'shipping.settings.view', 'print.view', 'print.labels']
const SESSIONS: Record<string, SessionContext> = {
  warehouse: office([grant([...SHIPPING, 'shipping.packaging.manage'])]),
  // The cost grain too (FIN-011: what one carton costs us).
  costs: office([grant(['shipping.view', 'shipping.packaging.manage', 'money.cost'])]),
  viewer: office([grant(['shipping.view'])]),
  companyB: office([grant(['shipping.view', 'shipping.packaging.manage'], [A.companyB])]),
  packer: floor(['floor.work', 'shipping.pack', 'print.view', 'print.labels']),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
let keys = 0
const run = randomBytes(4).toString('hex')
const key = () => `cartons-test-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    // A floor write always carries an Idempotency-Key (a resent tap packs once).
    headers: { 'x-test-session': session, ...(method !== 'GET' && SESSIONS[session]!.audience === 'floor' ? { 'idempotency-key': key() } : {}) },
    ...(payload === undefined ? {} : { payload: payload as object }),
  })
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
/** A refusal of the bench: a 409 whose issue path names its code. */
const refusedFor = async (session: string, url: string, payload: unknown, code: string) => {
  const error = await refused(session, 'POST', url, payload, 409)
  expect(error.issues?.[0]?.path, error.message).toBe(`refusal/${code}`)
  return error
}

const ids: Record<string, string> = {}
/** WO-0001's cells by colour and size (SEED-SO-0002 orders BLK 50 1, 52 2, 54 1 and RED 50, 52, 54 one each). */
const cells: Record<string, string> = {}
const cell = (key: string) => cells[key]!
const skuOf = async (style: string, colour: string, size: string) =>
  (await admin<{ sku: string; gtin: string | null }>(`SELECT v.sku, v.gtin FROM "Variant" v JOIN "Style" s ON s.id = v."styleId" JOIN "Colourway" c ON c.id = v."colourwayId" WHERE s.code = $1 AND c.code = $2 AND v.size = $3 AND v."tenantId" = $4`, [style, colour, size, A.tenant]))[0]!

beforeAll(async () => {
  db = await migratedDatabase('cartons')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  shippingA = await seedShipping({ db: database, namespace: ns })
  packingA = await seedPacking({ db: database, namespace: ns })
  await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'SHIPMENT', 'MAIN', 'ALL', 'NEVER', 'SH-{N:5}', false) ON CONFLICT DO NOTHING`, [newId(), A.tenant, A.companyA])
  // Made-up releases (the seed's facts, past the guards): what SEED-SO-0002 still orders of WO-0001 (SH-0001 took BLK 50 and
  // RED 52; one of BLK 52's two releases was reversed) is released: BLK 52 one more, BLK 54, RED 50 and RED 54 one each.
  const passed = (await admin<{ inspectionId: string; workOrderId: string }>(`SELECT "inspectionId", "workOrderId" FROM "QualityRelease" WHERE "workOrderSizeId" = $1 LIMIT 1`, [shippingA.quality.production.cellIds['BLK-52']]))[0]!
  for (const row of await admin<{ id: string; colour: string; size: string }>(`SELECT ws.id, c.code AS colour, ws.size FROM "WorkOrderSize" ws JOIN "Colourway" c ON c.id = ws."colourwayId" WHERE ws."workOrderId" = $1`, [passed.workOrderId])) {
    cells[`${row.colour}-${row.size}`] = row.id
  }
  await admin('SET session_replication_role = replica')
  try {
    for (const [n, key] of ['BLK-52', 'BLK-54', 'RED-50', 'RED-54'].entries()) {
      await admin(
        `INSERT INTO "QualityRelease" (id, "tenantId", "companyId", "siteId", "workOrderId", "workOrderSizeId", number, "inspectionId", quantity, "releasedAt", "signatureSha256") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, now() - interval '1 hour', $9)`,
        [newId(), A.tenant, A.companyA, A.siteA1, passed.workOrderId, cell(key), `TEST-REL-${n + 1}`, passed.inspectionId, 'a'.repeat(64)],
      )
    }
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
  // A made-up barcode (GTIN-13) on SEED-JKT-02 BLK 52 (this seed chain gives none).
  await admin(`UPDATE "Variant" SET gtin = '2009999990017' WHERE "tenantId" = $1 AND sku = 'SEED-JKT-02-BLK-52'`, [A.tenant])
  // The packing bench's tablet (made up), and a label printer of A1 with labels tall enough for the marks (the seed's is 100 × 50).
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, 'Test packing tablet', 'TABLET', 'ACTIVE', now())`, [DEVICE, A.tenant, A.companyA, A.siteA1])
  ids.printer = newId()
  await admin(
    `INSERT INTO "Printer" (id, "tenantId", "companyId", "siteId", code, name, kind, relay, "relayTarget", dpi, "labelWidthMm", "labelHeightMm") VALUES ($1, $2, $3, $4, 'LBL-MARKS', 'Test marks printer', 'LABEL_ZPL', 'FAKE', 'test-marks:9100', 203, 100, 150)`,
    [ids.printer, A.tenant, A.companyA, A.siteA1],
  )
  // And one with the scan labels' 100 × 50 stock: too small for the marks.
  ids.smallPrinter = newId()
  await admin(
    `INSERT INTO "Printer" (id, "tenantId", "companyId", "siteId", code, name, kind, relay, "relayTarget", dpi, "labelWidthMm", "labelHeightMm") VALUES ($1, $2, $3, $4, 'LBL-SMALL', 'Test small label printer', 'LABEL_ZPL', 'FAKE', 'test-small:9100', 203, 100, 50)`,
    [ids.smallPrinter, A.tenant, A.companyA, A.siteA1],
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

describe('packaging types, defaults and mark templates (LOG-008, LOG-013)', () => {
  it('keeps a carton type; the cost is a cost: dropped without the grain, refused from a writer without it', async () => {
    const created = await ok('warehouse', 'POST', '/shipping/packaging/types', { companyId: A.companyA, kind: 'CARTON', name: 'Test carton 50x40x30', innerLengthCm: '50', innerWidthCm: '40', innerHeightCm: '30', tareKg: '0.6', maxWeightKg: '20' }, 201)
    expect(created.type).toMatchObject({ kind: 'CARTON', name: 'Test carton 50x40x30', innerLengthCm: '50.00', tareKg: '0.6000', maxWeightKg: '20.0000', active: true })
    expect(created.type).not.toHaveProperty('cost')
    ids.testCarton = created.type.id
    const withCost = await call('warehouse', 'PATCH', `/shipping/packaging/types/${ids.testCarton}`, { cost: { perUnit: '1.10', currency: 'EUR' } })
    expect(withCost.statusCode).toBeGreaterThanOrEqual(400)
    const costed = await ok('costs', 'PATCH', `/shipping/packaging/types/${ids.testCarton}`, { version: 1, cost: { perUnit: '1.10', currency: 'EUR' } })
    expect(costed.type.cost).toEqual({ perUnit: '1.100000', currency: 'EUR' })
    const listed = (await ok('viewer', 'GET', `/shipping/packaging/types?companyId=${A.companyA}&kind=CARTON`)).types as Json[]
    expect(listed.map((type) => type.name)).toEqual(expect.arrayContaining(['Seed carton 60x40x40', 'Test carton 50x40x30']))
    expect(listed.every((type) => !('cost' in type))).toBe(true)
  })

  it('refuses a wrong type in words at its field, a second of the same name, and who may not keep them', async () => {
    const pallet = await refused('warehouse', 'POST', '/shipping/packaging/types', { companyId: A.companyA, kind: 'PALLET', name: 'Test pallet' }, 400)
    expect(pallet.issues).toEqual([{ path: 'body/palletKind', message: 'A pallet says its kind (EUR or OTHER).' }])
    expect((await refused('warehouse', 'POST', '/shipping/packaging/types', { companyId: A.companyA, kind: 'CARTON', name: 'Test carton 50x40x30' }, 409)).message).toBe('The company has a packaging type named "Test carton 50x40x30" already.')
    await refused('viewer', 'POST', '/shipping/packaging/types', { companyId: A.companyA, kind: 'CARTON', name: 'Viewer carton' }, 403)
    await refused('companyB', 'POST', '/shipping/packaging/types', { companyId: A.companyA, kind: 'CARTON', name: 'Other company carton' }, 404)
    await refused('packer', 'GET', '/shipping/packaging/types', undefined, 403)
  })

  it("keeps one live default per style run; a switched-off type is never a default's", async () => {
    const style = (await admin<{ id: string; sizeScaleId: string }>(`SELECT id, "sizeScaleId" FROM "Style" WHERE code = 'SEED-JKT-02' AND "tenantId" = $1`, [A.tenant]))[0]!
    ids.style = style.id
    const created = await ok('warehouse', 'POST', '/shipping/packaging/defaults', { companyId: A.companyA, packagingTypeId: ids.testCarton, styleId: style.id, sizeScaleId: style.sizeScaleId, fromSize: '52', toSize: '54' }, 201)
    expect(created.default).toMatchObject({ kind: 'CARTON', packagingTypeName: 'Test carton 50x40x30', style: { code: 'SEED-JKT-02' }, fromSize: '52', toSize: '54', active: true })
    expect((await refused('warehouse', 'POST', '/shipping/packaging/defaults', { companyId: A.companyA, packagingTypeId: packingA.packagingTypeIds.carton, styleId: style.id, sizeScaleId: style.sizeScaleId, fromSize: '52', toSize: '54' }, 409)).message).toMatch(/is live for this style or size run already/)
    const off = await ok('warehouse', 'POST', '/shipping/packaging/types', { companyId: A.companyA, kind: 'BOX', name: 'Test old box', active: false }, 201)
    expect((await refused('warehouse', 'POST', '/shipping/packaging/defaults', { companyId: A.companyA, packagingTypeId: off.type.id, styleId: style.id }, 400)).issues).toEqual([{ path: 'body/packagingTypeId', message: 'Choose a packaging type in use.' }])
    expect((await refused('warehouse', 'POST', '/shipping/packaging/defaults', { companyId: A.companyA, packagingTypeId: ids.testCarton, styleId: style.id, sizeScaleId: style.sizeScaleId, fromSize: '54', toSize: '50' }, 400)).issues).toEqual([{ path: 'body/toSize', message: 'The run goes from a size to one not before it.' }])
  })

  it("keeps the customer's mark template (one live per customer), and refuses a wrong field or language", async () => {
    expect((await refused('warehouse', 'POST', '/shipping/packaging/mark-templates', { companyId: A.companyA, partyId: A.brand, fields: ['SHIP_TO'], language: 'en' }, 409)).message).toBe('This customer has a live mark template already: change it, or switch it off first.')
    const changed = await ok('warehouse', 'PATCH', `/shipping/packaging/mark-templates/${packingA.markTemplateIds.brandP1}`, { fields: ['CARTON_NUMBER', 'CUSTOMER_ORDER', 'STYLE', 'SIZES', 'QUANTITY', 'BATCH', 'GROSS_WEIGHT', 'SHIP_TO'], language: 'en' })
    expect(changed.template).toMatchObject({ partyId: A.brand, party: { legalName: expect.any(String) }, language: 'en', fields: ['CARTON_NUMBER', 'CUSTOMER_ORDER', 'STYLE', 'SIZES', 'QUANTITY', 'BATCH', 'GROSS_WEIGHT', 'SHIP_TO'] })
    await refused('warehouse', 'PATCH', `/shipping/packaging/mark-templates/${packingA.markTemplateIds.brandP1}`, { language: 'ENG' }, 400)
    await refused('warehouse', 'PATCH', `/shipping/packaging/mark-templates/${packingA.markTemplateIds.brandP1}`, { fields: ['SHIP_TO', 'SHIP_TO'] }, 400)
    const listed = (await ok('viewer', 'GET', `/shipping/packaging/mark-templates?companyId=${A.companyA}&active=true`)).templates as Json[]
    expect(listed.map((template) => template.partyId).sort()).toEqual([A.brand, null].sort())
  })
})

describe('scan each garment into a carton (LOG-007, LOG-010; Rule 1)', () => {
  const url = () => `/shipping/packing/${ids.shipment}`

  it('starts with the size grid ordered against packed and no carton', async () => {
    const { shipment } = await ok('warehouse', 'POST', '/shipping/shipments', { salesOrderId: shippingA.quality.production.salesOrderId, lines: [{ workOrderSizeId: cell('BLK-52'), quantity: 2 }, { workOrderSizeId: cell('BLK-54'), quantity: 1 }] }, 201)
    ids.shipment = shipment.id
    ids.number = shipment.number
    const bench = await ok('packer', 'GET', `${url()}/cartons`)
    expect(bench.grid).toEqual([expect.objectContaining({ styleCode: 'SEED-JKT-02', colourwayCode: 'BLK', serialTracked: false, sizes: [expect.objectContaining({ size: '52', ordered: 2, packed: 0 }), expect.objectContaining({ size: '54', ordered: 1, packed: 0 })] })])
    expect(bench).toMatchObject({ cartons: [], openCartonId: null, hold: null, problems: ['NOT_SCANNED'] })
    expect(bench.packagingTypes.map((type: Json) => type.name)).toEqual(expect.arrayContaining(['Seed carton 60x40x40', 'Seed EUR pallet', 'Test carton 50x40x30']))
    expect(bench.packagingTypes.every((type: Json) => !('cost' in type) && type.kind !== 'POLYBAG')).toBe(true)
    // The default for SEED-JKT-02 size 52 (this test's run 52-54).
    expect(bench.suggestedPackagingTypeId).toBe(ids.testCarton)
  })

  it('takes a barcode, a batch label with its size and a SKU; the first scan opens a carton', async () => {
    const gtin52 = (await skuOf('SEED-JKT-02', 'BLK', '52')).gtin!
    const first = await ok('packer', 'POST', `${url()}/scan`, { code: gtin52 })
    expect(first.scan).toMatchObject({ kind: 'SKU', cellId: cell('BLK-52'), cartonSeq: 1, serialId: null, newCarton: true })
    ids.carton1 = first.scan.parcelId
    const batch = (await admin<{ batchNumber: string }>(`SELECT wo."batchNumber" FROM "WorkOrder" wo JOIN "WorkOrderSize" ws ON ws."workOrderId" = wo.id WHERE ws.id = $1`, [cell('BLK-52')]))[0]!.batchNumber
    expect((await refusedFor('packer', `${url()}/scan`, { code: batch }, 'SIZE_NEEDED')).message).toBe(`Batch ${batch} has BLK 52, BLK 54 left on this shipment: choose the colour and size.`)
    expect((await ok('packer', 'POST', `${url()}/scan`, { code: batch, cellId: cell('BLK-54') })).scan).toMatchObject({ kind: 'BATCH', cellId: cell('BLK-54'), parcelId: ids.carton1, newCarton: false })
    const third = await ok('packer', 'POST', `${url()}/scan`, { code: (await skuOf('SEED-JKT-02', 'BLK', '52')).sku.toLowerCase() })
    expect(third.scan).toMatchObject({ kind: 'SKU', cellId: cell('BLK-52'), parcelId: ids.carton1, newCarton: false })
    expect(third.bench.grid[0].sizes).toEqual([expect.objectContaining({ size: '52', ordered: 2, packed: 2 }), expect.objectContaining({ size: '54', ordered: 1, packed: 1 })])
    const carton = third.bench.cartons[0]
    expect(carton).toMatchObject({ id: ids.carton1, seq: 1, closed: false, garments: 3, packagingType: null })
    expect(carton.contents.map((content: Json) => [content.size, content.quantity, content.batchNumber])).toEqual([['52', 2, batch], ['54', 1, batch]])
    expect(third.bench.problems).toEqual(['CARTON_OPEN'])
    // W1's lines stay true: the cell's garments in carton 1 are one line in it.
    const lines = await admin<{ size: string; quantity: number; parcelId: string | null }>(`SELECT size, quantity, "parcelId" FROM "ShipmentLine" WHERE "shipmentId" = $1 ORDER BY size`, [ids.shipment])
    expect(lines).toEqual([{ size: '52', quantity: 2, parcelId: ids.carton1 }, { size: '54', quantity: 1, parcelId: ids.carton1 }])
  })

  it('refuses in words, by its code, a wrong style, colour or size, an unknown code and an extra piece', async () => {
    expect((await refusedFor('packer', `${url()}/scan`, { code: (await skuOf('SEED-JKT-01', 'BLK', '52')).sku }, 'WRONG_STYLE')).message).toBe('Style SEED-JKT-01 is not on this shipment.')
    expect((await refusedFor('packer', `${url()}/scan`, { code: (await skuOf('SEED-JKT-02', 'RED', '52')).sku }, 'WRONG_COLOUR')).message).toBe('SEED-JKT-02 in RED is not on this shipment.')
    expect((await refusedFor('packer', `${url()}/scan`, { code: (await skuOf('SEED-JKT-02', 'BLK', '50')).sku }, 'WRONG_SIZE')).message).toBe('SEED-JKT-02 BLK size 50 is not on this shipment.')
    await refusedFor('packer', `${url()}/scan`, { code: 'NOPE-0000' }, 'UNKNOWN_CODE')
    expect((await refusedFor('packer', `${url()}/scan`, { code: (await skuOf('SEED-JKT-02', 'BLK', '52')).sku }, 'EXTRA_PIECE')).message).toBe('All 2 of SEED-JKT-02 BLK size 52 on this shipment are in cartons already: this one is an extra piece.')
    const audits = await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "AuditLog" WHERE action = 'shipping.scanIntoCarton' AND "recordId" = $1`, [ids.shipment])
    expect(audits[0]!.n).toBe(3)
  })
})

describe('Close carton: its contents, packaging, weight, "n of N" and marks (LOG-010, LOG-013, LOG-008)', () => {
  const url = () => `/shipping/packing/${ids.shipment}`

  it('closes carton 1 in the default packaging, "1 of 1", and prints its marks in the customer\'s language on the label printer', async () => {
    const closed = await ok('packer', 'POST', `${url()}/cartons/${ids.carton1}/close`, { grossWeightKg: '9.5', printerId: ids.printer })
    expect(closed.closed).toEqual({ parcelId: ids.carton1, cartonNumber: 1, cartonCount: 1, packagingTypeId: ids.testCarton, garments: 3, warnings: [] })
    expect(closed.marks).toMatchObject({ printed: true, jobIds: [expect.any(String)], problem: null })
    expect(closed.bench.cartons[0]).toMatchObject({ closed: true, cartonNumber: 1, cartonCount: 1, marksCurrent: true, grossWeightKg: '9.5000', netWeightKg: '8.9000', packagingType: { name: 'Test carton 50x40x30' } })
    expect(closed.bench.problems).toEqual([])
    const job = (await admin<{ labelKind: string; recordType: string; scanId: string; zpl: string }>(`SELECT "labelKind", "recordType", "scanId", zpl FROM "PrintJob" WHERE id = $1`, [closed.marks.jobIds[0]]))[0]!
    expect(job).toMatchObject({ labelKind: 'CARTON', recordType: 'Parcel', scanId: `${ids.number}-1` })
    expect(job.zpl).toContain('Carton 1 of 1')
    expect(job.zpl).toContain('52 _C3_97 2 _C2_B7 54 _C3_97 1')
    expect(await admin(`SELECT 1 FROM "OutboxEvent" WHERE subject = $1 AND type = 'shipping.carton_packed'`, [ids.shipment])).toHaveLength(1)
    // A closed carton takes no more garments.
    await refusedFor('packer', `${url()}/scan`, { code: (await skuOf('SEED-JKT-02', 'BLK', '54')).sku, parcelId: ids.carton1 }, 'CARTON_CLOSED')
  })

  it('a second carton makes carton 1 "1 of 2" (its marks due); marks too tall for a small label say so; the due marks print', async () => {
    await ok('warehouse', 'POST', `/shipping/shipments/${ids.shipment}/lines`, { lines: [{ workOrderSizeId: cell('RED-50'), quantity: 1 }] })
    const second = await ok('packer', 'POST', `${url()}/scan`, { code: (await skuOf('SEED-JKT-02', 'RED', '50')).sku })
    expect(second.scan).toMatchObject({ cartonSeq: 2, newCarton: true })
    ids.carton2 = second.scan.parcelId
    expect(second.bench.cartons[0]).toMatchObject({ cartonNumber: 1, cartonCount: 2, marksCurrent: false })
    expect(second.bench.problems).toEqual(['CARTON_OPEN', 'MARKS_NOT_PRINTED'])
    // Closed, but its marks do not fit 100 × 50 labels: said in words, printed later.
    const closed = await ok('packer', 'POST', `${url()}/cartons/${ids.carton2}/close`, { packagingTypeId: packingA.packagingTypeIds.carton, grossWeightKg: '3.2', printerId: ids.smallPrinter })
    expect(closed.closed).toMatchObject({ cartonNumber: 2, cartonCount: 2, packagingTypeId: packingA.packagingTypeIds.carton })
    expect(closed.marks).toMatchObject({ printed: false, jobIds: [], problem: { code: 'validation_failed', message: expect.stringMatching(/^These marks need a label at least 76 mm wide and \d+ mm high/) } })
    const printed = await ok('packer', 'POST', `${url()}/cartons/marks/print`, { printerId: ids.printer }, 201)
    expect(printed.jobs.map((job: Json) => job.parcelId).sort()).toEqual([ids.carton1, ids.carton2].sort())
    expect((await ok('packer', 'GET', `${url()}/cartons`)).problems).toEqual([])
    expect((await refused('packer', 'POST', `${url()}/cartons/marks/print`, { printerId: ids.printer }, 409)).message).toBe("No carton's marks are due: close a carton first, or name the cartons to print again.")
  })

  it('a garment taken out goes back to its loose line and opens its carton again; scanned back, the carton closes again', async () => {
    const red50 = (await skuOf('SEED-JKT-02', 'RED', '50')).sku
    const out = await ok('packer', 'POST', `${url()}/cartons/${ids.carton2}/take-out`, { code: red50 })
    expect(out.takenOut).toMatchObject({ parcelId: ids.carton2, cartonSeq: 2, reopened: true })
    expect(out.bench.cartons[1]).toMatchObject({ closed: false, garments: 0, cartonNumber: null })
    expect(out.bench.problems).toEqual(['NOT_SCANNED'])
    await refusedFor('packer', `${url()}/cartons/${ids.carton1}/take-out`, { code: red50 }, 'NOT_IN_CARTON')
    await ok('packer', 'POST', `${url()}/scan`, { code: red50 })
    const closed = await ok('packer', 'POST', `${url()}/cartons/${ids.carton2}/close`, { printerId: ids.printer })
    expect(closed.closed).toMatchObject({ cartonNumber: 2, cartonCount: 2, packagingTypeId: packingA.packagingTypeIds.carton })
    expect(closed.marks.printed).toBe(true)
  })
})

describe('a hold stops packing; once released the shipment packs (LOG-017 rows of B-W2b-364, by the bench)', () => {
  it('refuses a scan into a held shipment with the reason in words; W1 refuses its pack in words, never a 500', async () => {
    const holdId = newId()
    const placedAt = new Date(Date.now() - 60_000)
    await database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, (client) =>
      client.shipmentHold.create({ data: { id: holdId, siteId: A.siteA1, partyId: A.brand, shipmentId: ids.shipment!, reason: 'BALANCE_UNPAID', placedAt }, select: { id: true } }),
    )
    const bench = await ok('packer', 'GET', `/shipping/packing/${ids.shipment}/cartons`)
    expect(bench.hold).toMatchObject({ reason: 'BALANCE_UNPAID' })
    expect((await refusedFor('packer', `/shipping/packing/${ids.shipment}/scan`, { code: 'ANY-CODE' }, 'ON_HOLD')).message).toBe('This shipment is on hold (the balance is not paid): nothing goes into its cartons, and it is not packed, until the hold is released.')
    const pack = await refused('packer', 'POST', `/shipping/packing/${ids.shipment}/pack`, {}, 409)
    expect(pack.message).toMatch(/hold/)
    await database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, (client) =>
      client.shipmentHold.update({ where: { id: holdId }, data: { releasedAt: new Date(), releaseWords: 'Paid (made-up test).' }, select: { id: true } }),
    )
    const packed = await ok('packer', 'POST', `/shipping/packing/${ids.shipment}/pack`, {})
    expect(packed.shipment).toMatchObject({ status: 'PACKED' })
    await refusedFor('packer', `/shipping/packing/${ids.shipment}/scan`, { code: 'ANY-CODE' }, 'NOT_DRAFT')
  })

  it("reads the cartons in the office (shipping.view), their marks as a PDF for any printer; the floor never reads the office's view", async () => {
    const cartons = await ok('viewer', 'GET', `/shipping/shipments/${ids.shipment}/cartons`)
    expect(cartons.cartons.map((carton: Json) => [carton.cartonNumber, carton.garments, carton.contents.map((content: Json) => `${content.size}x${content.quantity}`).join(' ')])).toEqual([
      [1, 3, '52x2 54x1'],
      [2, 1, '50x1'],
    ])
    await refused('packer', 'GET', `/shipping/shipments/${ids.shipment}/cartons`, undefined, 403)
    const response = await call('warehouse', 'POST', `/shipping/packing/${ids.shipment}/cartons/marks/pdf`, { parcelIds: [ids.carton1] })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.headers['content-type']).toMatch(/application\/pdf/)
    expect(response.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
  })
})

describe("a serial in its carton (LOG-003): W1's pack of a serial in no carton is a 409 in words, never a 500", () => {
  it('SH-0002: the serial packed by W1 lies in no carton; its scan puts it into its carton with when and who; then it packs', async () => {
    const shipmentId = packingA.shipmentId
    const serial = (await admin<{ id: string; serial: string }>(`SELECT id, serial FROM "GarmentSerial" WHERE "workOrderSizeId" = $1 AND status = 'RELEASED' AND "shipmentLineId" IS NULL ORDER BY serial LIMIT 1`, [shippingA.quality.serialCellId]))[0]!
    await ok('packer', 'POST', `/shipping/packing/${shipmentId}/serials`, { serial: serial.serial })
    await ok('packer', 'PATCH', `/shipping/packing/${shipmentId}/parcels/${packingA.parcelId}`, { grossWeightKg: '1.9' })
    const pack = await refused('packer', 'POST', `/shipping/packing/${shipmentId}/pack`, {}, 409)
    expect(pack).toMatchObject({ code: 'conflict', issues: [{ path: 'packing/SERIALS_NOT_IN_CARTONS' }] })
    expect(pack.message).toMatch(/^Each serial lies in the carton of its line: 1 serial\(s\) are in no carton/)
    expect((await ok('packer', 'GET', `/shipping/packing/${shipmentId}/cartons`)).problems).toContain('SERIALS_NOT_IN_CARTONS')

    const scanned = await ok('packer', 'POST', `/shipping/packing/${shipmentId}/scan`, { code: serial.serial, occurredAt: new Date(Date.now() - 120_000).toISOString() })
    expect(scanned.scan).toMatchObject({ kind: 'SERIAL', serialId: serial.id, parcelId: packingA.parcelId, newCarton: false })
    const row = (await admin<{ parcelId: string; packedById: string; packedAt: Date }>(`SELECT "parcelId", "packedById", "packedAt" FROM "GarmentSerial" WHERE id = $1`, [serial.id]))[0]!
    expect(row).toMatchObject({ parcelId: packingA.parcelId, packedById: A.operator })
    expect(Date.now() - row.packedAt.getTime()).toBeGreaterThan(60_000)
    expect(scanned.bench.cartons[0].contents[0].serials).toEqual([expect.objectContaining({ id: serial.id, serial: serial.serial })])
    // Its contents stay one garment: the scan gave the serial its carton, it did not count it twice.
    expect(scanned.bench.cartons[0].garments).toBe(1)
    await refusedFor('packer', `/shipping/packing/${shipmentId}/scan`, { code: serial.serial }, 'ALREADY_PACKED')
    expect((await ok('packer', 'POST', `/shipping/packing/${shipmentId}/pack`, {})).shipment).toMatchObject({ status: 'PACKED' })
  })
})

describe('a scan kept on the tablet while offline (floor-sync shipping.carton.scan)', () => {
  it('applies it through the bench; a wrong garment is refused with its code and words, final', async () => {
    const { shipment } = await ok('warehouse', 'POST', '/shipping/shipments', { salesOrderId: shippingA.quality.production.salesOrderId, lines: [{ workOrderSizeId: cell('RED-54'), quantity: 1 }] }, 201)
    let seq = 0
    const event = (code: string) => ({ clientEventId: `evt-${run}-${++keys}`, seq: ++seq, kind: 'shipping.carton.scan', occurredAt: new Date(Date.now() - 30_000).toISOString(), payload: { shipmentId: shipment.id, code } })
    const answer = await ok('packer', 'POST', '/floor/sync', { events: [event((await skuOf('SEED-JKT-01', 'BLK', '52')).sku), event((await skuOf('SEED-JKT-02', 'RED', '54')).sku)] })
    expect(answer.events).toEqual([
      expect.objectContaining({ kind: 'shipping.carton.scan', status: 'refused', refusal: expect.objectContaining({ code: 'WRONG_STYLE', message: 'Style SEED-JKT-01 is not on this shipment.', final: true }) }),
      expect.objectContaining({ kind: 'shipping.carton.scan', status: 'accepted', result: { type: 'Parcel', id: expect.any(String) } }),
    ])
    const bench = await ok('packer', 'GET', `/shipping/packing/${shipment.id}/cartons`)
    expect(bench.grid[0].sizes).toEqual([expect.objectContaining({ size: '54', ordered: 1, packed: 1 })])
  })
})
