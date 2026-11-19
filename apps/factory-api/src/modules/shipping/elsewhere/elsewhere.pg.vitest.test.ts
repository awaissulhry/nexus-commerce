import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { ELSEWHERE_WORDS, leftOn, nexusDdtWords, overrideLineOf } from '@nexus/factory-domain/shipping/elsewhere'
import { MULTI_ORDER_OFF } from '@nexus/factory-domain/shipping/shipments'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedShipping, type ShippingSeed } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * B-OP-032 (order page N5; R-2, R-9, R-10, R-23): "Record a shipment made elsewhere". On the local stack with the app's real
 * routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security, the column grants and
 * the …_order_page_guards are real), the factory-db shipping seed (Brand Alpha's SEED-SO-0002 with one released BLK 52 on no
 * shipment), a copy of SEED-SO-0002 for Alpha and one for another customer, Brand Beta (never named to anyone). Every name and
 * number is made up. Run with `node scripts/factory/run-pg-tests.mjs elsewhere`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let seedA: ShippingSeed

const ns = 'shipping-elsewhere'
const idOf = (key: string) => seedUuid(ns, key)
const A = { tenant: idOf('tenant'), companyA: idOf('company:A'), siteA1: idOf('site:A1'), alpha: idOf('party:P1') }
const beta = newId()

const BASE: Permission[] = ['shipping.view', 'shipping.manage', 'shipping.pack', 'shipping.ddt.issue', 'orders.view']
const grant = (permissions: Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  warehouse: office([grant(BASE)]),
  // R-9: a person who may release holds records over a customer hold with a reason.
  releaser: office([grant([...BASE, 'shipping.holds.release'])]),
  noDdt: office([grant(['shipping.view', 'shipping.manage'])]),
  viewer: office([grant(['shipping.view'])]),
  betaOnly: office([grant(BASE, [beta])]),
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
const call = (session: string, url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: { 'x-test-session': session }, payload: payload as object })
async function ok(session: string, url: string, payload: unknown, status = 200): Promise<Json> {
  const response = await call(session, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}

const so2 = () => seedA.quality.production.salesOrderId
const blk52 = () => seedA.quality.production.cellIds['BLK-52']
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
let counter = 0
/** A recording of one BLK 52 of SEED-SO-0002 that left a minute ago with a paper DDT of that day (a fresh number each time). */
const body = (over: Json = {}): Json => {
  const shippedAt = over.shippedAt ?? minutesAgo(1)
  return {
    salesOrderId: so2(),
    siteId: A.siteA1,
    lines: [{ workOrderSizeId: blk52(), quantity: 1 }],
    transportBy: 'CARRIER',
    carrierName: 'Demo Corriere',
    trackingNumber: 'DEMO-TRK-1',
    externalDdt: { number: `PAPER-${++counter}/2026`, date: leftOn(shippedAt) },
    ddtRequired: true,
    shippedAt,
    ...over,
  }
}
const orderId = async (number: string): Promise<string> => (await admin<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = $2`, [A.tenant, number]))[0]!.id
const ids: Record<string, string> = {}
const shipments = async () => (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "Shipment" WHERE "tenantId" = $1`, [A.tenant]))[0]!.n

beforeAll(async () => {
  db = await migratedDatabase('shipping-elsewhere')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  seedA = await seedShipping({ db: database, namespace: ns })
  // The company's legal data (the DDT routes read them before they refuse a shipment made elsewhere).
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT12345670009', "fiscalCode" = '12345670009', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [A.companyA])
  await admin(
    `INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'SHIPMENT', 'MAIN', 'ALL', 'NEVER', 'SH-{N:5}', false) ON CONFLICT DO NOTHING`,
    [newId(), A.tenant, A.companyA],
  )
  await admin(`INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", roles) VALUES ($1, $2, $3, 'BRAND-BETA', 'ORGANISATION', 'Brand Beta GmbH', '{CUSTOMER}')`, [beta, A.tenant, A.companyA])
  ids.beta1 = newId()
  await admin(
    `INSERT INTO "SalesOrder" SELECT (jsonb_populate_record(NULL::"SalesOrder", to_jsonb(o) || jsonb_build_object('id', $2::text, 'partyId', $3::text, 'number', 'SO-BETA-1', 'customerRef', NULL, 'customerSeq', NULL, 'quoteVersionId', NULL))).* FROM "SalesOrder" o WHERE o.id = $1`,
    [so2(), ids.beta1, beta],
  )
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('B-OP-032: the preview says what the recording would say, nothing written', () => {
  it('a released garment, a minute ago, with its paper DDT: no problem, the covering release, no hold, the DDT not used', async () => {
    const before = await shipments()
    const preview = await ok('viewer', '/shipping/shipments/elsewhere/preview', body())
    expect(preview.problems).toEqual([])
    expect(preview.order.id).toBe(so2())
    expect(preview.lines).toHaveLength(1)
    expect(preview.lines[0]).toMatchObject({ workOrderSizeId: blk52(), quantity: 1, shippable: 1, serialTracked: false })
    expect(preview.lines[0].releasedAt).not.toBeNull()
    expect(preview.earliest).toBe(preview.lines[0].releasedAt)
    expect(preview.holds).toEqual({ held: false, accountHold: null, creditHeld: false, mayRelease: false })
    expect([preview.ddtUsed, preview.ddtCitable]).toEqual([false, true])
    expect(await shipments()).toBe(before)
  })

  it('every rule in its code: the future, 61 days, before the release, more than released, no DDT, a DDT after the day it left', async () => {
    const codes = async (over: Json) => (await ok('viewer', '/shipping/shipments/elsewhere/preview', body(over))).problems.map((problem: Json) => problem.code)
    expect(await codes({ shippedAt: new Date(Date.now() + 3_600_000).toISOString() })).toContain('FUTURE')
    expect(await codes({ shippedAt: new Date(Date.now() - 61 * 86_400_000).toISOString() })).toContain('TOO_OLD')
    const releasedAt = (await ok('viewer', '/shipping/shipments/elsewhere/preview', body())).lines[0].releasedAt as string
    expect(await codes({ shippedAt: new Date(Date.parse(releasedAt) - 3_600_000).toISOString() })).toContain('BEFORE_RELEASE')
    expect(await codes({ lines: [{ workOrderSizeId: blk52(), quantity: 2 }] })).toEqual(['NOT_RELEASED'])
    expect(await codes({ externalDdt: null })).toEqual(['DDT_REQUIRED'])
    expect(await codes({ externalDdt: null, ddtRequired: false })).toEqual([])
    expect(await codes({ externalDdt: { number: 'PAPER-X', date: '2099-01-01' } })).toEqual(['DDT_AFTER_LEFT'])
  })
})

describe('B-OP-032: the wall, the rights, several orders', () => {
  it("another customer's person gets Alpha's order as an unknown one, on both routes", async () => {
    const unknown = await refused('warehouse', '/shipping/shipments/elsewhere/preview', body({ salesOrderId: newId() }), 404)
    const preview = await refused('betaOnly', '/shipping/shipments/elsewhere/preview', body(), 404)
    const record = await refused('betaOnly', '/shipping/shipments/elsewhere', body(), 404)
    expect([preview.message, record.message]).toEqual([unknown.message, unknown.message])
    expect(unknown.message).toBe('Sales order not found.')
  })

  it("Beta's order with Alpha's cell is refused as an unknown cell (the cell's customer is the order's)", async () => {
    const error = await refused('warehouse', '/shipping/shipments/elsewhere/preview', body({ salesOrderId: ids.beta1 }), 400)
    expect(error.issues).toContainEqual({ path: 'body/lines/0/workOrderSizeId', message: 'Not a work order cell.' })
  })

  it('recording needs shipping.manage and shipping.ddt.issue; a second order is held off (MULTI_ORDER_OFF)', async () => {
    const before = await shipments()
    expect((await call('viewer', '/shipping/shipments/elsewhere', body())).statusCode).toBe(403)
    expect((await refused('noDdt', '/shipping/shipments/elsewhere', body(), 403)).message).toBe("Recording the goods' paper DDT needs the right to issue DDTs too.")
    const other = (await admin<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND "partyId" = $2 AND id <> $3 AND status IN ('CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED') LIMIT 1`, [A.tenant, A.alpha, so2()]))[0]
    if (other) expect((await refused('warehouse', '/shipping/shipments/elsewhere', body({ salesOrderIds: [so2(), other.id] }), 409)).message).toBe(MULTI_ORDER_OFF)
    expect(await shipments()).toBe(before)
  })
})

describe('B-OP-032: one command — made elsewhere, its lines, SHIPPED at the time it left', () => {
  it('records it SHIPPED with packedAt = shippedAt, its paper DDT, origin ELSEWHERE; the events say from DRAFT; stock posts now (D5)', async () => {
    const asked = body({ shippedAt: minutesAgo(90) })
    const answer = await ok('warehouse', '/shipping/shipments/elsewhere', asked, 201)
    const shipment = answer.shipment
    ids.recorded = shipment.id
    ids.paper = asked.externalDdt.number
    ids.paperDate = asked.externalDdt.date
    expect(shipment).toMatchObject({ status: 'SHIPPED', origin: 'ELSEWHERE', externalDdt: { number: asked.externalDdt.number, date: asked.externalDdt.date }, salesOrderId: so2(), transportBy: 'CARRIER', carrierName: 'Demo Corriere' })
    expect(shipment.shippedAt).toBe(asked.shippedAt)
    expect(shipment.packedAt).toBe(asked.shippedAt)
    expect(shipment.lines).toHaveLength(1)
    const [row] = await admin<{ origin: string; ddtRequired: boolean; manualTrackingNumber: string | null }>(`SELECT origin::text AS origin, "ddtRequired", "manualTrackingNumber" FROM "Shipment" WHERE id = $1`, [shipment.id])
    expect(row).toEqual({ origin: 'ELSEWHERE', ddtRequired: true, manualTrackingNumber: 'DEMO-TRK-1' })
    const events = await admin<{ type: string; payload: Json }>(`SELECT type, payload FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id`, [shipment.id])
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['shipment.created', 'shipment.status_changed']))
    expect(events.find((event) => event.type === 'shipment.status_changed')!.payload).toMatchObject({ from: 'DRAFT', to: 'SHIPPED' })
    // The audit names both days: when it left, when it was recorded (stock and cost of sales post on the recording day).
    const [left] = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE action = 'shipping.left' AND "recordId" = $1`, [shipment.id])
    expect(left!.after).toMatchObject({ madeElsewhere: true, shippedAt: asked.shippedAt, holdsOverridden: false })
    expect(Date.parse(left!.after.recordedAt)).toBeGreaterThan(Date.parse(asked.shippedAt))
    const [recorded] = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE action = 'shipping.recordedElsewhere' AND "recordId" = $1`, [shipment.id])
    expect(recorded!.after).toMatchObject({ status: 'SHIPPED', externalDdt: { number: asked.externalDdt.number, date: asked.externalDdt.date }, holds: null })
    // PPE documents not on file never refuse it: they are the answer's warnings and a line on the order's thread.
    expect(recorded!.after.missingDocuments).toEqual(answer.warnings)
    const lines = await admin(`SELECT m."bodyText" FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordType" = 'SalesOrder' AND t."recordId" = $1 AND m."authorKind" = 'SYSTEM' AND m."bodyText" LIKE $2`, [so2(), `%${shipment.number}%`])
    expect(lines).toHaveLength(answer.warnings.length > 0 ? 1 : 0)
    // The garment is on it now: nothing more of the cell can be recorded.
    expect((await ok('viewer', '/shipping/shipments/elsewhere/preview', body())).problems.map((problem: Json) => problem.code)).toEqual(['NOT_RELEASED'])
  })

  it('Nexus issues no DDT of it: the issue and the preview say it left with its paper DDT', async () => {
    const words = nexusDdtWords({ number: ids.paper! })
    const issue = await refused('warehouse', `/shipping/shipments/${ids.recorded}/ddt`, {}, 409)
    expect(issue.message).toBe(words)
    expect(issue.issues).toEqual([{ path: 'refusal/NEXUS_DDT', message: words }])
    const preview = await ok('warehouse', `/shipping/shipments/${ids.recorded}/ddt/preview`, {})
    expect(preview.problems).toContainEqual({ path: 'refusal/NEXUS_DDT', message: words })
    expect(await admin(`SELECT 1 FROM "Ddt" WHERE "shipmentId" = $1`, [ids.recorded])).toEqual([])
  })

  it('R-10: one customer never records a paper DDT twice ("already recorded", no customer named); another customer may share it', async () => {
    // Another customer's shipment with the same paper DDT number and date: the key is per customer (made past the guards).
    await force(
      `INSERT INTO "Shipment" (id, "tenantId", "companyId", "siteId", "partyId", "salesOrderId", number, "shipTo", "transportBy", status, origin, "externalDdtNumber", "externalDdtDate", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, 'SH-BETA-PAPER', '{}'::jsonb, 'SENDER', 'DRAFT', 'ELSEWHERE', $7, $8::date, now(), now())`,
      [newId(), A.tenant, A.companyA, A.siteA1, beta, ids.beta1, ids.paper, ids.paperDate],
    )
    const preview = await ok('viewer', '/shipping/shipments/elsewhere/preview', body({ externalDdt: { number: ` ${ids.paper} `, date: ids.paperDate } }))
    expect(preview.ddtUsed).toBe(true)
    const again = await refused('warehouse', '/shipping/shipments/elsewhere', body({ externalDdt: { number: ids.paper, date: ids.paperDate } }), 409)
    expect(again.message).toBe(ELSEWHERE_WORDS.DDT_NUMBER_USED)
    expect(again.message).not.toMatch(/Alpha|Beta|P1/)
  })
})

describe('B-OP-032 (R-9): a customer on hold', () => {
  it('is refused in words; a person who may release holds records it with a reason, written on the order’s thread', async () => {
    // A fresh released garment of the cell for this test (the earlier one left): one more release, now.
    await force(
      `INSERT INTO "QualityRelease" (id, "tenantId", number, "companyId", "siteId", "workOrderId", "workOrderSizeId", "inspectionId", quantity, "certificateIds", "releasedById", "releasedAt", "signatureSha256", "createdAt", "createdById")
       SELECT $1, "tenantId", 'REL-ELSEWHERE-1', "companyId", "siteId", "workOrderId", "workOrderSizeId", "inspectionId", 1, "certificateIds", "releasedById", now() - interval '2 hours', "signatureSha256", now(), "createdById"
         FROM "QualityRelease" WHERE "workOrderSizeId" = $2 LIMIT 1`,
      [newId(), blk52()],
    )
    const holdId = newId()
    await admin(`INSERT INTO "PartyHold" (id, "tenantId", "partyId", "companyId", reason, words, "placedAt") VALUES ($1, $2, $3, $4, 'CREDIT', 'Overdue invoices: nothing ships until they are paid.', now())`, [holdId, A.tenant, A.alpha, A.companyA])
    try {
      const before = await shipments()
      const preview = await ok('releaser', '/shipping/shipments/elsewhere/preview', body())
      expect(preview.holds).toMatchObject({ held: true, mayRelease: true })
      const held = await refused('warehouse', '/shipping/shipments/elsewhere', body(), 409)
      expect(held.issues[0].path).toBe('refusal/HELD')
      const noReason = await refused('releaser', '/shipping/shipments/elsewhere', body(), 409)
      expect(noReason.issues[0].path).toBe('refusal/REASON_REQUIRED')
      expect(await shipments()).toBe(before)
      const reason = 'The van delivered it before the hold was placed'
      const answer = await ok('releaser', '/shipping/shipments/elsewhere', body({ holdReason: reason }), 201)
      const [recorded] = await admin<{ after: Json; reason: string | null }>(`SELECT after, reason FROM "AuditLog" WHERE action = 'shipping.recordedElsewhere' AND "recordId" = $1`, [answer.shipment.id])
      expect(recorded!.after.holds).toMatchObject({ reason })
      expect(recorded!.reason).toBe(reason)
      const [left] = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE action = 'shipping.left' AND "recordId" = $1`, [answer.shipment.id])
      expect(left!.after.holdsOverridden).toBe(true)
      const lines = await admin<{ bodyText: string }>(`SELECT m."bodyText" FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordType" = 'SalesOrder' AND t."recordId" = $1 AND m."authorKind" = 'SYSTEM' AND m.direction = 'INTERNAL_NOTE' AND m."bodyText" LIKE $2`, [so2(), `%${reason}%`])
      const locale = (await admin<{ locale: string }>(`SELECT locale FROM "Company" WHERE id = $1`, [A.companyA]))[0]!.locale === 'en' ? 'en' : 'it'
      expect(lines.map((line) => line.bodyText)).toEqual([overrideLineOf({ shipment: answer.shipment.number, reason, ddt: answer.shipment.externalDdt.number }, locale)])
      // No system hold is ever synced onto it (holds/system.ts skips a shipment made elsewhere).
      expect(await admin(`SELECT 1 FROM "ShipmentHold" WHERE "shipmentId" = $1`, [answer.shipment.id])).toEqual([])
    } finally {
      await admin(`UPDATE "PartyHold" SET "releasedAt" = now(), "releaseWords" = 'Test over' WHERE id = $1`, [holdId])
    }
  })
})
