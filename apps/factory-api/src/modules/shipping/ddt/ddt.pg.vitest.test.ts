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
import { seed as seedMoney, type MoneySeed } from '../../../../../../packages/factory-db/seed/money'
import type { ShippingSeed } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../../adapters/local-files/local'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { pdfFlatText } from '../../../platform/documents/testing/pdf-text'
import { storeGeneratedFile } from '../../../platform/files/files'
import { createFilesRuntime, useFiles, type FilesRuntime } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'

/**
 * The DDT (B-W1-47; LOG-054; DPR 472/1996; PLAN §4.7 stage 14-ship and its end check "DDT numbers have no gap") on the
 * local stack, with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login,
 * so row-level security, the grants and the …_quality_shipping_guards and …_numbering_guards triggers are real), the
 * factory-db seeds of two tenants (the DRAFT SH-0002 of the serial-tracked jacket, WO-0001's released garments, company
 * A's yearly DDT series), the local file store for the PDFs, and sessions from the test authenticator. The seed dates
 * its DDTs in late 2026: the series' last date is cleared so today's DDTs may follow. Every name and number is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs ddt`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string
let files: FilesRuntime
let seedA: ShippingSeed
let moneyA: MoneySeed

const ns = { a: 'ddt-a', b: 'ddt-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const A = { tenant: idOf(ns.a, 'tenant'), companyA: idOf(ns.a, 'company:A'), companyB: idOf(ns.a, 'company:B'), siteA1: idOf(ns.a, 'site:A1'), brand: idOf(ns.a, 'party:P1'), operator: idOf(ns.a, 'worker:A1:operator') }
const B = { tenant: idOf(ns.b, 'tenant'), companyA: idOf(ns.b, 'company:A') }
const YEAR = businessDate(new Date()).slice(0, 4)

const SHIPPING: Permission[] = ['shipping.view', 'shipping.manage', 'shipping.pack', 'shipping.ddt.issue', 'shipping.ddt.cancel']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  warehouse: office(A.tenant, [grant([...SHIPPING, 'files.read'])]),
  issuer: office(A.tenant, [grant(['shipping.view', 'shipping.ddt.issue'])]),
  viewer: office(A.tenant, [grant(['shipping.view'])]),
  uploader: office(A.tenant, [grant(['shipping.view', 'files.read', 'files.upload'])]),
  companyB: office(A.tenant, [grant(SHIPPING, [A.companyB])]),
  otherTenant: office(B.tenant, [grant(SHIPPING)]),
  partner: { audience: 'partner', tenantId: A.tenant, actorId: newId(), partyId: A.brand, grants: [grant(SHIPPING)] },
  packerA1: { audience: 'floor', tenantId: A.tenant, actorId: A.operator, siteId: A.siteA1, deviceId: newId(), grants: [{ permissions: [...SHIPPING], companies: [A.companyA], sites: [A.siteA1], parties: 'all' }] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: { 'x-test-session': session, ...(SESSIONS[session]?.audience === 'floor' && method !== 'GET' ? { 'idempotency-key': `ddt-test-${run}-${++keys}` } : {}) },
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

/** Company A's DDT series for this year (tenant A): its row and the number it gives next. */
const series = async () => (await admin<{ id: string; next: number }>(`SELECT id, "nextValue" AS next FROM "NumberSeries" WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = 'DDT' AND code = 'MAIN' AND "scopeKey" = $3`, [A.tenant, A.companyA, YEAR]))[0]!
const numbered = (value: number) => `${value}/${YEAR}`
const allocations = async (seriesId: string) => (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "NumberAllocation" WHERE "seriesId" = $1`, [seriesId]))[0]!.n
const liveDdts = async (shipmentId: string) => (await admin<{ number: string }>(`SELECT d.number FROM "Ddt" d WHERE d."shipmentId" = $1 AND NOT EXISTS (SELECT 1 FROM "DdtCancellation" x WHERE x."ddtId" = d.id) ORDER BY d.number`, [shipmentId])).map((row) => row.number)

/** Requests waiting on a lock (a row lock or a series lock) in this database. */
async function lockWaiters(count: number): Promise<void> {
  for (let tries = 0; ; tries++) {
    const n = (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`))[0]!.n
    if (n >= count) return
    if (tries > 250) throw new Error(`only ${n} request(s) waited on a lock`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Holds the series row's lock (as allocateNumber takes it) in another session until `release` is called. */
function holdSeries(seriesId: string) {
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  let locked!: () => void
  const holding = new Promise<void>((resolve) => (locked = resolve))
  const holder = database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, (client) =>
    client.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "NumberSeries" WHERE "id" = ${seriesId}::uuid FOR UPDATE`
        locked()
        await released
      },
      { timeout: 20_000 },
    ),
  )
  return { holding, release: async () => (release(), await holder) }
}

beforeAll(async () => {
  db = await migratedDatabase('ddt')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 12 } })
  for (const namespace of [ns.a, ns.b]) await seedCore({ db: database, namespace })
  // The money seed runs the shipping seed (and those it builds on), then adds invoices: a DRAFT TD24 names DDT 144/2026.
  moneyA = await seedMoney({ db: database, namespace: ns.a })
  seedA = moneyA.shipping
  await seedMoney({ db: database, namespace: ns.b })
  for (const [tenantId, companyId] of [
    [A.tenant, A.companyA],
    [B.tenant, B.companyA],
  ] as const) {
    // Made-up legal data (c.c. art. 2250), a SHIPMENT series (the numbering seed has one too), the tenant's FAKE file
    // store, and this year's DDT series (the seeded one when the year is 2026) with no last date.
    await admin(`UPDATE "Company" SET "vatNumber" = 'IT12345670009', "fiscalCode" = '12345670009', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyId])
    await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'SHIPMENT', 'MAIN', 'ALL', 'NEVER', 'SH-{N:5}', false) ON CONFLICT DO NOTHING`, [newId(), tenantId, companyId])
    await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'DDT', 'MAIN', $4, 'YEARLY', '{N}/{YYYY}', true) ON CONFLICT DO NOTHING`, [newId(), tenantId, companyId, YEAR])
    await admin(`UPDATE "NumberSeries" SET "lastIssuedDate" = NULL WHERE "tenantId" = $1 AND kind = 'DDT'`, [tenantId])
    if ((await admin(`SELECT 1 FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2'`, [tenantId])).length === 0) {
      await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenantId])
    }
  }
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-ddt-test-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  files = createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) })
  useFiles(files)
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
      logger: false,
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

// SH-0002 (seeded DRAFT, the serial-tracked jacket of SO-0003): packed here into two parcels, a serial each. SB: the
// last released BLK 52 of SO-0002, one parcel. The seeded SH-0001 left with DDT 144/2026 (143 cancelled).
const sh2 = () => seedA.draftShipmentId
const S: Record<string, string> = {}

describe('two packed shipments (the floor packs; LOG-039)', () => {
  it('packs SH-0002 into two weighed parcels with a serial each, and SB (a batch-tracked garment) into one', async () => {
    const [, second, third] = seedA.quality.serialIds
    const codes = Object.fromEntries((await admin<{ id: string; serial: string }>('SELECT id, serial FROM "GarmentSerial" WHERE id = ANY($1::uuid[])', [[second, third]])).map((row) => [row.id, row.serial]))
    S.serial2 = codes[second!]!
    S.serial3 = codes[third!]!
    const added = (await ok('warehouse', 'POST', `/shipping/shipments/${sh2()}/lines`, { lines: [{ workOrderSizeId: seedA.quality.serialCellId, quantity: 1 }] })).shipment
    const p2 = (await ok('warehouse', 'POST', `/shipping/packing/${sh2()}/parcels`, {}, 201)).parcelId
    const loose = added.lines.find((line: Json) => line.parcelId === null)
    await ok('warehouse', 'PUT', `/shipping/packing/${sh2()}/lines/${loose.id}/parcel`, { parcelId: p2 })
    await ok('warehouse', 'POST', `/shipping/packing/${sh2()}/serials`, { serial: S.serial2, parcelId: seedA.draftParcelId })
    await ok('warehouse', 'POST', `/shipping/packing/${sh2()}/serials`, { serial: S.serial3, parcelId: p2 })
    await ok('warehouse', 'PATCH', `/shipping/packing/${sh2()}/parcels/${seedA.draftParcelId}`, { grossWeightKg: '1.85' })
    await ok('warehouse', 'PATCH', `/shipping/packing/${sh2()}/parcels/${p2}`, { grossWeightKg: '2.15' })
    expect((await ok('warehouse', 'POST', `/shipping/packing/${sh2()}/pack`, {})).shipment).toMatchObject({ status: 'PACKED', garments: 2 })

    const sb = (await ok('warehouse', 'POST', '/shipping/shipments', { salesOrderId: seedA.quality.production.salesOrderId, lines: [{ workOrderSizeId: seedA.quality.production.cellIds['BLK-52'], quantity: 1 }] }, 201)).shipment
    S.sb = sb.id
    const parcel = (await ok('warehouse', 'POST', `/shipping/packing/${sb.id}/parcels`, { grossWeightKg: '2.5' }, 201)).parcelId
    await ok('warehouse', 'PUT', `/shipping/packing/${sb.id}/lines/${sb.lines[0].id}/parcel`, { parcelId: parcel })
    expect((await ok('warehouse', 'POST', `/shipping/packing/${sb.id}/pack`, {})).shipment.status).toBe('PACKED')
  })
})

describe('the preview (no number used)', () => {
  it('says what the DDT of SH-0002 would say, field by field, and the number it would probably take', async () => {
    const before = await series()
    const preview = await ok('viewer', 'POST', `/shipping/shipments/${sh2()}/ddt/preview`, {})
    expect(preview.problems).toEqual([])
    expect(preview.expectedNumber).toBe(numbered(before.next))
    expect(preview.language).toBe('it')
    expect(preview.draft).toMatchObject({
      reason: 'SALE',
      transportBy: 'CARRIER',
      carrier: { name: 'Seed Express' },
      appearance: 'Scatole di cartone',
      packages: 2,
      grossWeightKg: '4.0000',
      sender: { name: expect.any(String), vatNumber: 'IT12345670009', fiscalCode: '12345670009', address: expect.objectContaining({ line1: 'Via Esempio 1' }) },
      recipient: { name: 'Seed Customer One S.r.l.', address: expect.objectContaining({ line1: 'Via Esempio 10' }) },
      destination: expect.objectContaining({ name: 'Seed Racing workshop', line1: 'Via Esempio 12' }),
      documentRefs: [expect.objectContaining({ kind: 'SALES_ORDER' }), { kind: 'CUSTOMER_ORDER', number: 'SEED-PO-91', date: null }],
    })
    expect(preview.draft.lines).toEqual([expect.objectContaining({ seq: 1, quantity: '2', uom: 'PCS', serials: [S.serial2, S.serial3].sort() })])
    expect(preview.draft.lines[0].description).toMatch(/taglia 52 \(DPI cat\. II/)

    const bad = await ok('viewer', 'POST', `/shipping/shipments/${sh2()}/ddt/preview`, { reason: 'TRANSFER', startAt: '2020-01-01T08:00:00Z', ship: true })
    expect(bad.problems.map((problem: Json) => problem.path)).toEqual(['body/reason', 'body/startAt'])

    const pdf = await call('viewer', 'POST', `/shipping/shipments/${sh2()}/ddt/preview/pdf`, {})
    expect(pdf.statusCode, pdf.body).toBe(200)
    expect(pdf.headers['content-type']).toBe('application/pdf')
    const text = pdfFlatText(pdf.rawPayload)
    expect(text).toContain('ESEMPIO - documento non valido')
    expect(text).toContain(numbered(before.next))
    expect((await series()).next).toBe(before.next)
    expect(await admin('SELECT 1 FROM "Ddt" WHERE "shipmentId" = $1', [sh2()])).toEqual([])
  })
})

describe('issuing (gapless per company and year)', () => {
  it('refuses a DDT with a missing field (400) or of a DRAFT shipment (409), and that uses no number', async () => {
    const before = await series()
    const missing = await refused('warehouse', 'POST', `/shipping/shipments/${sh2()}/ddt`, { reason: 'OTHER', appearance: ' ' }, 400)
    expect(missing.issues).toEqual([{ path: 'body/reasonText', message: 'Say the reason for the transport in words.' }])
    const draft = (await ok('warehouse', 'POST', '/shipping/shipments', { salesOrderId: seedA.quality.production.salesOrderId, siteId: A.siteA1 }, 201)).shipment
    expect((await refused('warehouse', 'POST', `/shipping/shipments/${draft.id}/ddt`, {}, 409)).message).toBe('The shipment is a DRAFT: pack it first (a DDT is issued for packed goods).')
    // Shipping with the DDT moves the shipment: shipping.manage too.
    expect((await refused('issuer', 'POST', `/shipping/shipments/${S.sb}/ddt`, { ship: true, carrier: { name: 'Seed Express' } }, 403)).code).toBe('forbidden')
    expect((await refused('viewer', 'POST', `/shipping/shipments/${S.sb}/ddt`, {}, 403)).code).toBe('forbidden')
    expect(await series()).toEqual(before)
    expect(await allocations(before.id)).toBe((await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "Ddt" WHERE "numberSeriesId" = $1`, [before.id]))[0]!.n)
  })

  it('issues SH-0002 and ships it in one command: the next number, SHIPPED, its serials SHIPPED, the PDF in the fiscal archive', async () => {
    const before = await series()
    const issued = await ok('warehouse', 'POST', `/shipping/shipments/${sh2()}/ddt`, { ship: true, netWeightKg: '3.2', freight: 'FREE', remarks: 'Fragile', internalNote: 'Driver collects at gate 2' }, 201)
    S.ddt1 = issued.ddt.id
    expect(issued.ddt).toMatchObject({ number: numbered(before.next), status: 'LIVE', shipmentId: sh2(), packages: 2, grossWeightKg: '4.0000', netWeightKg: '3.2000', freight: 'FREE', remarks: 'Fragile', cancellation: null })
    expect(issued.shipment).toMatchObject({ id: sh2(), status: 'SHIPPED' })
    expect(issued.pdfProblem).toBeNull()
    expect(issued.file).toMatchObject({ recordType: 'Ddt', recordId: S.ddt1, kind: 'FISCAL_ARCHIVE', status: 'AVAILABLE', contentType: 'application/pdf' })
    expect(issued.ddt.fileId).toBe(issued.file.id)

    expect(await admin(`SELECT status::text, "shippedAt" IS NOT NULL AS shipped FROM "Shipment" WHERE id = $1`, [sh2()])).toEqual([{ status: 'SHIPPED', shipped: true }])
    expect((await admin<{ status: string }>(`SELECT status::text FROM "GarmentSerial" WHERE "tenantId" = $1 AND serial = ANY($2::text[])`, [A.tenant, [S.serial2, S.serial3]])).map((row) => row.status)).toEqual(['SHIPPED', 'SHIPPED'])
    expect(await admin(`SELECT value, formatted, "recordType" FROM "NumberAllocation" WHERE "recordId" = $1`, [S.ddt1])).toEqual([{ value: before.next, formatted: numbered(before.next), recordType: 'Ddt' }])
    expect((await series()).next).toBe(before.next + 1)

    const [file] = await admin<{ legal: boolean; years: number; visibility: string[] }>(
      `SELECT "storageKey" LIKE 'legal/%' AS legal, extract(year FROM age("retainUntil", now()))::int AS years, visibility::text[] AS visibility FROM "StoredFile" WHERE id = $1`,
      [issued.file.id],
    )
    expect(file).toEqual({ legal: true, years: expect.any(Number), visibility: ['OFFICE', 'FLOOR'] })
    expect(file!.years).toBeGreaterThanOrEqual(9)
    const { download } = await ok('warehouse', 'GET', `/shipping/ddts/${S.ddt1}/pdf`)
    const fetched = await app.inject({ method: 'GET', url: download.url })
    expect(fetched.statusCode).toBe(200)
    const text = pdfFlatText(fetched.rawPayload)
    for (const words of [numbered(before.next), 'Seed Customer One S.r.l.', 'Seed Racing workshop', 'Seed Express', 'Scatole di cartone', 'Vendita', S.serial2!, S.serial3!, 'SEED-PO-91']) expect(text).toContain(words)
    expect(text).not.toContain('gate 2')

    const events = await admin<{ type: string; payload: Json }>(`SELECT type, payload FROM "OutboxEvent" WHERE subject = $1 AND type IN ('ddt.issued', 'shipment.status_changed') ORDER BY "occurredAt", id`, [sh2()])
    expect(events.filter((event) => event.type === 'ddt.issued').map((event) => event.payload)).toEqual([{ ddtId: S.ddt1, shipmentId: sh2(), number: numbered(before.next), documentDate: businessDate(new Date()), replacement: false, shipped: true }])
    expect(events.filter((event) => event.type === 'shipment.status_changed').map((event) => `${event.payload.from}>${event.payload.to}`).at(-1)).toBe('PACKED>SHIPPED')
    const audits = await admin<{ action: string; recordType: string }>(`SELECT action, "recordType" FROM "AuditLog" WHERE "requestId" = (SELECT "requestId" FROM "AuditLog" WHERE "recordId" = $1 AND action = 'shipping.issueDdt')`, [S.ddt1])
    expect(audits.map((row) => `${row.recordType} ${row.action}`).sort()).toEqual(['Ddt shipping.issueDdt', 'GarmentSerial shipping.shipSerial', 'GarmentSerial shipping.shipSerial', 'Shipment shipping.issueDdt', 'StoredFile documents.render'])
  })

  it('refuses a second live DDT for the shipment (409) and uses no number', async () => {
    const before = await series()
    expect((await refused('warehouse', 'POST', `/shipping/shipments/${sh2()}/ddt`, {}, 409)).message).toBe(`DDT ${numbered(before.next - 1)} is live for this shipment: cancel it first (a shipment has one live DDT).`)
    expect(await series()).toEqual(before)
    expect(await liveDdts(sh2())).toEqual([numbered(before.next - 1)])
  })

  it('the database keeps a DDT as issued: no update, no delete, for the runtime login and the owner alike', async () => {
    const asOffice = (work: (client: any) => Promise<unknown>) => database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, work)
    await expect(asOffice((client) => client.ddt.update({ where: { id: S.ddt1 }, data: { appearance: 'Pallet' }, select: { id: true } }))).rejects.toThrow()
    await expect(asOffice((client) => client.ddt.delete({ where: { id: S.ddt1 }, select: { id: true } }))).rejects.toThrow()
    await expect(admin(`UPDATE "Ddt" SET appearance = 'Pallet' WHERE id = $1`, [S.ddt1])).rejects.toThrow(/append-only/)
    await expect(admin(`DELETE FROM "Ddt" WHERE id = $1`, [S.ddt1])).rejects.toThrow(/append-only/)
    expect(await admin(`SELECT appearance FROM "Ddt" WHERE id = $1`, [S.ddt1])).toEqual([{ appearance: 'Scatole di cartone' }])
  })
})

describe('cancelling and replacing (a cancelled DDT keeps its number)', () => {
  it('cancels the DDT with its reason: the shipment stays SHIPPED and needs a replacement; once only', async () => {
    expect((await refused('viewer', 'POST', `/shipping/ddts/${S.ddt1}/cancel`, { reason: 'x' }, 403)).code).toBe('forbidden')
    expect((await refused('companyB', 'POST', `/shipping/ddts/${S.ddt1}/cancel`, { reason: 'x' }, 404)).code).toBe('not_found')
    const before = await series()
    const cancelled = await ok('warehouse', 'POST', `/shipping/ddts/${S.ddt1}/cancel`, { reason: 'Wrong appearance: two boxes, not a pallet.' })
    expect(cancelled.ddt).toMatchObject({ id: S.ddt1, status: 'CANCELLED', number: numbered(before.next - 1), cancellation: { reason: 'Wrong appearance: two boxes, not a pallet.' } })
    expect(cancelled.shipment).toMatchObject({ id: sh2(), status: 'SHIPPED', needsDdt: true })
    expect(cancelled).toMatchObject({ draftInvoiceIds: [], warning: null })
    expect((await refused('warehouse', 'POST', `/shipping/ddts/${S.ddt1}/cancel`, { reason: 'again' }, 409)).message).toBe('This DDT is cancelled already.')
    expect(await admin(`SELECT count(*)::int AS n FROM "DdtCancellation" WHERE "ddtId" = $1`, [S.ddt1])).toEqual([{ n: 1 }])
    await expect(admin(`UPDATE "DdtCancellation" SET reason = 'x' WHERE "ddtId" = $1`, [S.ddt1])).rejects.toThrow(/append-only/)
    expect(await admin(`SELECT action, reason FROM "AuditLog" WHERE "recordId" = $1 AND action = 'shipping.cancelDdt'`, [S.ddt1])).toEqual([{ action: 'shipping.cancelDdt', reason: 'Wrong appearance: two boxes, not a pallet.' }])
    expect(await series()).toEqual(before)
  })

  it('a packed shipment leaves only with a live DDT', async () => {
    const refusal = await refused('warehouse', 'POST', `/shipping/shipments/${S.sb}/ship`, {}, 409)
    expect(refusal.issues).toEqual([{ path: 'state', message: 'a live DDT (DPR 472/1996: issue the DDT first)' }])
  })

  it('two shipments issued at the same time take consecutive numbers, with no gap and no deadlock', async () => {
    const before = await series()
    const lock = holdSeries(before.id)
    await lock.holding
    const results = Promise.all([
      call('warehouse', 'POST', `/shipping/shipments/${sh2()}/ddt`, { appearance: 'Due scatole di cartone' }),
      call('warehouse', 'POST', `/shipping/shipments/${S.sb}/ddt`, { carrier: { name: 'Seed Express', vatNumber: 'IT00000000000' } }),
    ])
    await lockWaiters(2)
    await lock.release()
    const [replacement, first] = await results
    expect([replacement.statusCode, first.statusCode], `${replacement.body}\n${first.body}`).toEqual([201, 201])
    expect([replacement.json().ddt.number, first.json().ddt.number].sort()).toEqual([numbered(before.next), numbered(before.next + 1)].sort())
    expect((await series()).next).toBe(before.next + 2)
    // The replacement keeps the start of the transport that happened; SB stays PACKED until its goods leave.
    const [shipped] = await admin<{ shippedAt: Date }>(`SELECT "shippedAt" FROM "Shipment" WHERE id = $1`, [sh2()])
    expect(replacement.json().ddt.startAt).toBe(shipped!.shippedAt.toISOString())
    expect(replacement.json().shipment).toMatchObject({ status: 'SHIPPED' })
    expect(first.json().shipment).toMatchObject({ status: 'PACKED' })
    S.sbDdt = first.json().ddt.id
    const issued = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'ddt.issued' AND payload->>'ddtId' = $1`, [replacement.json().ddt.id])
    expect(issued[0]!.payload).toMatchObject({ replacement: true, shipped: false })
  })

  it('two issues of one shipment at once: one DDT and one number; the other waits on the shipment and is refused', async () => {
    await ok('warehouse', 'POST', `/shipping/ddts/${S.sbDdt}/cancel`, { reason: 'The carrier changed.' })
    const before = await series()
    const lock = holdSeries(before.id)
    await lock.holding
    const body = { carrier: { name: 'Seed Express' } }
    const results = Promise.all([call('warehouse', 'POST', `/shipping/shipments/${S.sb}/ddt`, body), call('warehouse', 'POST', `/shipping/shipments/${S.sb}/ddt`, body)])
    await lockWaiters(2)
    await lock.release()
    const responses = await results
    expect(responses.map((response) => response.statusCode).sort(), responses.map((response) => response.body).join('\n')).toEqual([201, 409])
    expect(await liveDdts(S.sb!)).toEqual([numbered(before.next)])
    expect((await series()).next).toBe(before.next + 1)
  })

  it('a DDT the database refuses after its number was taken uses no number: the counter rolls back with it', async () => {
    const [live] = await admin<{ id: string }>(`SELECT d.id FROM "Ddt" d WHERE d."shipmentId" = $1 AND NOT EXISTS (SELECT 1 FROM "DdtCancellation" x WHERE x."ddtId" = d.id)`, [S.sb])
    await ok('warehouse', 'POST', `/shipping/ddts/${live!.id}/cancel`, { reason: 'Reprinted with the right weight.' })
    const before = await series()
    const issued = await allocations(before.id)
    await admin(`CREATE FUNCTION "test_refuse_ddt"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."shipmentId" = '${S.sb}'::uuid THEN RAISE EXCEPTION 'test: the database refuses this DDT'; END IF; RETURN NEW; END $$`)
    await admin(`CREATE TRIGGER "Ddt_test_refuse" BEFORE INSERT ON "Ddt" FOR EACH ROW EXECUTE FUNCTION "test_refuse_ddt"()`)
    try {
      await refused('warehouse', 'POST', `/shipping/shipments/${S.sb}/ddt`, { carrier: { name: 'Seed Express' } }, 500)
    } finally {
      await admin(`DROP TRIGGER "Ddt_test_refuse" ON "Ddt"`)
      await admin(`DROP FUNCTION "test_refuse_ddt"()`)
    }
    expect(await series()).toEqual(before)
    expect(await allocations(before.id)).toBe(issued)
    const again = await ok('warehouse', 'POST', `/shipping/shipments/${S.sb}/ddt`, { carrier: { name: 'Seed Express' } }, 201)
    expect(again.ddt.number).toBe(numbered(before.next))
  })

  it('SB leaves later (two moments): PACKED → SHIPPED with its live DDT; a delivered shipment keeps its DDT', async () => {
    const shipped = (await ok('warehouse', 'POST', `/shipping/shipments/${S.sb}/ship`, {})).shipment
    expect(shipped).toMatchObject({ id: S.sb, status: 'SHIPPED' })
    expect(shipped.shippedAt).toEqual(expect.any(String))
    expect((await refused('warehouse', 'POST', `/shipping/shipments/${S.sb}/ship`, {}, 409)).code).toBe('invalid_state')
    expect((await refused('packerA1', 'POST', `/shipping/shipments/${S.sb}/ship`, {}, 403)).code).toBe('forbidden')
    // Delivery comes from tracking (B-W1-48): set here as the carrier's webhook would.
    await admin(`UPDATE "Shipment" SET status = 'DELIVERED', "deliveredAt" = now() WHERE id = $1`, [S.sb])
    const [live] = await liveDdts(S.sb!)
    const [row] = await admin<{ id: string }>(`SELECT id FROM "Ddt" WHERE number = $1 AND "shipmentId" = $2`, [live, S.sb])
    expect((await refused('warehouse', 'POST', `/shipping/ddts/${row!.id}/cancel`, { reason: 'late' }, 409)).message).toBe('The shipment is DELIVERED: its transport is over, so its DDT stays as issued.')
  })
})

describe('the PDF', () => {
  it('when the file store fails after the issue, the DDT stays issued and its PDF is printed again later', async () => {
    const [live] = await admin<{ id: string }>(`SELECT d.id FROM "Ddt" d WHERE d."shipmentId" = $1 AND NOT EXISTS (SELECT 1 FROM "DdtCancellation" x WHERE x."ddtId" = d.id)`, [sh2()])
    await ok('warehouse', 'POST', `/shipping/ddts/${live!.id}/cancel`, { reason: 'The carrier VAT number was missing.' })
    useFiles({ ...files, storage: { ...files.storage, put: async () => Promise.reject(new Error('the store is down')) } })
    let issued: Json
    try {
      issued = await ok('warehouse', 'POST', `/shipping/shipments/${sh2()}/ddt`, { carrier: { name: 'Seed Express', vatNumber: 'IT00000000000' } }, 201)
    } finally {
      useFiles(files)
    }
    expect(issued.file).toBeNull()
    expect(issued.pdfProblem).toBe(`The DDT is issued; its PDF could not be stored now. Print it again with POST /shipping/ddts/${issued.ddt.id}/pdf.`)
    expect((await refused('warehouse', 'GET', `/shipping/ddts/${issued.ddt.id}/pdf`, undefined, 404)).message).toMatch(/not stored yet/)
    expect((await refused('viewer', 'POST', `/shipping/ddts/${issued.ddt.id}/pdf`, undefined, 403)).code).toBe('forbidden')
    const printed = await ok('warehouse', 'POST', `/shipping/ddts/${issued.ddt.id}/pdf`, undefined, 201)
    expect(printed.file).toMatchObject({ recordId: issued.ddt.id, kind: 'FISCAL_ARCHIVE' })
    expect((await ok('warehouse', 'POST', `/shipping/ddts/${issued.ddt.id}/pdf`, undefined, 200)).file.id).toBe(printed.file.id)
    expect((await ok('viewer', 'GET', `/shipping/ddts/${issued.ddt.id}`)).ddt.fileId).toBe(printed.file.id)
  })

  it('the first stored print is the document: a later FISCAL_ARCHIVE file never replaces it (record, list, download); none is uploaded', async () => {
    const [live] = await admin<{ id: string }>(`SELECT d.id FROM "Ddt" d WHERE d."shipmentId" = $1 AND NOT EXISTS (SELECT 1 FROM "DdtCancellation" x WHERE x."ddtId" = d.id)`, [sh2()])
    const first = (await ok('viewer', 'GET', `/shipping/ddts/${live!.id}`)).ddt.fileId as string
    expect(first).toEqual(expect.any(String))
    // A later fiscal-archive file on the same DDT, the way only the API can make one (a generated file).
    const later = Buffer.from('%PDF-1.4\n% a later made-up print of the same DDT\n%%EOF\n')
    const caller = callerFor(database, { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [], requestId: newId() })
    const second = await storeGeneratedFile(files, caller, { companyId: A.companyA, recordType: 'Ddt', recordId: live!.id, kind: 'FISCAL_ARCHIVE', originalName: 'later.pdf', contentType: 'application/pdf', body: later })
    expect(second.id).not.toBe(first)
    expect((await ok('viewer', 'GET', `/shipping/ddts/${live!.id}`)).ddt.fileId).toBe(first)
    const listed = (await ok('viewer', 'GET', `/shipping/ddts?shipmentId=${sh2()}&status=LIVE`)).ddts as Json[]
    expect(listed.map((row) => [row.id, row.fileId])).toEqual([[live!.id, first]])
    const download = (await ok('warehouse', 'GET', `/shipping/ddts/${live!.id}/pdf`)).download
    const fetched = await app.inject({ method: 'GET', url: download.url })
    expect(fetched.statusCode).toBe(200)
    expect(fetched.rawPayload.equals(later)).toBe(false)
    // The generic upload route refuses a DDT's fiscal-archive file (platform/files/owned.ts); a scan of the signed copy is open.
    const announce = (kind: string) =>
      call('uploader', 'POST', '/files', { companyId: A.companyA, recordType: 'Ddt', recordId: live!.id, kind, originalName: 'ddt.pdf', contentType: 'application/pdf', sizeBytes: later.length, sha256: createHash('sha256').update(later).digest('hex') })
    const refusedUpload = await announce('FISCAL_ARCHIVE')
    expect(refusedUpload.statusCode).toBe(409)
    expect(refusedUpload.json().error.message).toMatch(/A FISCAL_ARCHIVE file of a Ddt is uploaded and confirmed only through its own route: POST \/shipping\/shipments\/:shipmentId\/ddt/)
    expect((await announce('ATTACHMENT')).statusCode).toBe(201)
  })
})

/**
 * Issues a TD24 invoice whose one line bills the goods of a DDT, as B-W1-51's issuing command will: DRAFT with its line,
 * the next number of company A's invoice series (its NumberAllocation row, the counter moved), then ISSUED. Made up.
 */
async function issueTd24(ddtId: string): Promise<string> {
  const invoiceId = newId()
  const actorId = newId()
  const seriesId = idOf(ns.a, 'series:A:INVOICE:MAIN:2026')
  const issueDate = '2026-12-01'
  const address = { street: 'Via Esempio', streetNumber: '10', postcode: '00000', city: 'Seedville', province: 'MI', country: 'IT' }
  return database.withScope({ audience: 'office', tenantId: A.tenant, actorId }, (client) =>
    client.$transaction(async (tx) => {
      const series = await tx.numberSeries.findUniqueOrThrow({ where: { id: seriesId }, select: { nextValue: true } })
      const number = `FT-2026-${String(series.nextValue).padStart(5, '0')}`
      await tx.invoice.create({
        data: {
          id: invoiceId,
          companyId: A.companyA,
          buyerPartyId: A.brand,
          docType: 'TD24',
          billTo: { kind: 'IT_BUSINESS', name: 'Seed Customer One S.r.l.', address },
          netTotal: 25000,
          vatTotal: 5500,
          grossTotal: 30500,
          vatSummary: [{ rate: '22.00', nature: null, legalRef: null, taxable: 25000, vat: 5500, rounding: 0 }],
        },
        select: { id: true },
      })
      await tx.invoiceLine.create({
        data: { id: newId(), invoiceId, buyerPartyId: A.brand, seq: 1, kind: 'GOODS', description: 'Seed jacket, size 52', quantity: '2.0000', uom: 'PZ', unitPrice: '125.000000', netAmount: 25000, vatRatePct: '22.00', ddtId },
        select: { id: true },
      })
      await tx.numberAllocation.create({
        data: { id: newId(), companyId: A.companyA, seriesId, kind: 'INVOICE', value: series.nextValue, formatted: number, documentDate: new Date(`${issueDate}T00:00:00.000Z`), recordType: 'Invoice', recordId: invoiceId, allocatedAt: new Date(), allocatedById: actorId, requestId: `ddt-test-${run}-invoice` },
        select: { id: true },
      })
      await tx.numberSeries.update({ where: { id: seriesId }, data: { nextValue: series.nextValue + 1, lastIssuedDate: new Date(`${issueDate}T00:00:00.000Z`) }, select: { id: true } })
      await tx.invoice.update({
        where: { id: invoiceId },
        data: { status: 'ISSUED', numberSeriesId: seriesId, number, year: 2026, issueDate: new Date(`${issueDate}T00:00:00.000Z`), issuedAt: new Date(), issuedById: actorId, partyId: A.brand, seller: { name: 'Seed Company A', vatNumber: 'IT12345670009', address } },
        select: { id: true },
      })
      return number
    }),
  )
}

describe('a DDT and its invoices (B-W1-51: the deferred invoice TD24 refers to its DDTs)', () => {
  it('a DDT that only DRAFT invoices name is cancelled, with those drafts named as a warning (the seeded TD24 of SH-0001)', async () => {
    const cancelled = await ok('warehouse', 'POST', `/shipping/ddts/${seedA.ddtId}/cancel`, { reason: 'The weight was wrong; reissued.' })
    expect(cancelled.ddt).toMatchObject({ id: seedA.ddtId, number: '144/2026', status: 'CANCELLED' })
    expect(cancelled.shipment).toMatchObject({ id: seedA.shipmentId, status: 'SHIPPED', needsDdt: true })
    expect(cancelled.draftInvoiceIds).toEqual([moneyA.draftInvoiceId])
    expect(cancelled.warning).toBe('1 draft invoice(s) name this DDT: they cannot be issued until their lines name the DDT that replaces it.')
    expect(await admin(`SELECT after->'draftInvoiceIds' AS drafts FROM "AuditLog" WHERE "recordId" = $1 AND action = 'shipping.cancelDdt'`, [seedA.ddtId])).toEqual([{ drafts: [moneyA.draftInvoiceId] }])
    const [live] = await admin<{ id: string }>(`SELECT d.id FROM "Ddt" d WHERE d."shipmentId" = $1 AND NOT EXISTS (SELECT 1 FROM "DdtCancellation" x WHERE x."ddtId" = d.id)`, [sh2()])
    S.sh2Live = live!.id
  })

  it('a DDT an ISSUED invoice bills is never cancelled: 409 naming the invoice, and nothing is written', async () => {
    const number = await issueTd24(S.sh2Live!)
    const refusal = await refused('warehouse', 'POST', `/shipping/ddts/${S.sh2Live}/cancel`, { reason: 'Wrong carrier.' }, 409)
    expect(refusal).toMatchObject({ code: 'invalid_state', message: `Invoice ${number} bills the goods of this DDT: an invoiced DDT stays as issued (a credit note corrects the invoice).` })
    expect(await admin(`SELECT count(*)::int AS n FROM "DdtCancellation" WHERE "ddtId" = $1`, [S.sh2Live])).toEqual([{ n: 0 }])
    expect((await ok('viewer', 'GET', `/shipping/ddts/${S.sh2Live}`)).ddt.status).toBe('LIVE')
  })
})

describe('reading, and the walls', () => {
  it('lists and reads DDTs within the grants', async () => {
    const listed = (await ok('viewer', 'GET', `/shipping/ddts?shipmentId=${sh2()}`)).ddts as Json[]
    expect(listed.map((row) => row.status)).toEqual(['LIVE', 'CANCELLED', 'CANCELLED'])
    expect(listed.every((row) => row.shipmentNumber === 'SEED-SH-0002' && row.recipientName === 'Seed Customer One S.r.l.')).toBe(true)
    expect(((await ok('viewer', 'GET', `/shipping/ddts?shipmentId=${sh2()}&status=LIVE`)).ddts as Json[]).map((row) => row.id)).toEqual([listed[0]!.id])
    const one = (await ok('viewer', 'GET', `/shipping/ddts/${S.ddt1}`)).ddt
    expect(one).toMatchObject({ id: S.ddt1, status: 'CANCELLED', internalNote: 'Driver collects at gate 2', sender: expect.any(Object), lines: [expect.objectContaining({ serials: [S.serial2, S.serial3].sort() })] })
  })

  it('tenant and company walls; floor and portal sessions are refused', async () => {
    expect((await ok('companyB', 'GET', '/shipping/ddts')).ddts).toEqual([])
    expect((await refused('companyB', 'GET', `/shipping/ddts/${S.ddt1}`, undefined, 404)).code).toBe('not_found')
    expect((await refused('otherTenant', 'GET', `/shipping/ddts/${S.ddt1}`, undefined, 404)).code).toBe('not_found')
    expect((await refused('otherTenant', 'POST', `/shipping/shipments/${sh2()}/ddt`, {}, 404)).code).toBe('not_found')
    expect(JSON.stringify(await ok('otherTenant', 'GET', '/shipping/ddts'))).not.toContain(S.ddt1)
    for (const session of ['partner', 'packerA1']) {
      expect((await refused(session, 'GET', '/shipping/ddts', undefined, 403)).code).toBe('forbidden')
      expect((await refused(session, 'GET', `/shipping/ddts/${S.ddt1}`, undefined, 403)).code).toBe('forbidden')
      expect((await refused(session, 'POST', `/shipping/shipments/${sh2()}/ddt/preview`, {}, 403)).code).toBe('forbidden')
      expect((await refused(session, 'POST', `/shipping/shipments/${sh2()}/ddt`, {}, 403)).code).toBe('forbidden')
      expect((await refused(session, 'POST', `/shipping/ddts/${S.ddt1}/cancel`, { reason: 'x' }, 403)).code).toBe('forbidden')
    }
  })

  it('the end check (PLAN §4.7): the DDT numbers of each company series period have no gap, each the number of one DDT', async () => {
    const rows = await admin<{ seriesId: string; start: number; next: number; values: number[]; numbers: string[]; ddts: number }>(
      `SELECT s.id AS "seriesId", s."startValue" AS start, s."nextValue" AS next,
              array_agg(a.value ORDER BY a.value) AS "values",
              array_agg(a.formatted ORDER BY a.value) AS numbers,
              (SELECT count(*)::int FROM "Ddt" d WHERE d."numberSeriesId" = s.id) AS ddts
         FROM "NumberSeries" s JOIN "NumberAllocation" a ON a."seriesId" = s.id
        WHERE s.kind = 'DDT' GROUP BY s.id`,
    )
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.values).toEqual(Array.from({ length: row.values.length }, (_, index) => row.start + index))
      expect(row.next).toBe(row.start + row.values.length)
      expect(row.ddts).toBe(row.values.length)
      const printed = await admin<{ number: string }>(`SELECT number FROM "Ddt" WHERE "numberSeriesId" = $1 ORDER BY number`, [row.seriesId])
      expect(printed.map((ddt) => ddt.number).sort()).toEqual([...row.numbers].sort())
    }
  })
})
