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
import { shipmentOrderLineOf, shipmentOrderNotes, type ShipmentOrderNote } from './order-notes'

/**
 * B-CW-040 (customer Work tab plan §4; lead settle S10) — when orders go on a shipment or come off it, each order's OWN thread
 * gets ONE office-only system line: "On draft shipment SH-… with SO-…, SO-…." · "No longer on draft shipment SH-…." · "Shipment
 * SH-… was cancelled." — in the company's language; one line per event and order, one bell per event; nothing for the customer.
 *
 * On the local stack with the app's real routes, the set-up of its neighbour shipment-orders.pg.vitest.test.ts: a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security, the grants and the shipping guards are real),
 * the factory-db core and shipping seeds — Brand Alpha (the seeds' customer P1) with SEED-SO-0002 (one released garment free in
 * its cell BLK-52) and SEED-SO-0003 (one released jacket free) —, a copy of SEED-SO-0002 for Brand Alpha (SO-ALPHA-2) and one for
 * another customer, Brand Beta (SO-BETA-1; never named to anyone). The events are the real routes' own (read from the outbox) and
 * the handler's work is called as the system, as the worker calls it. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/shipping/shipments/order-notes`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string
let seedA: ShippingSeed

const ns = 'cw040-order-notes'
const idOf = (key: string) => seedUuid(ns, key)
const A = { tenant: idOf('tenant'), companyA: idOf('company:A'), siteA1: idOf('site:A1'), alpha: idOf('party:P1') }
const beta = newId()

const SHIPPING: Permission[] = ['shipping.view', 'shipping.manage', 'shipping.pack', 'shipping.settings.view', 'shipping.settings.manage']
const grant = (permissions: Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  warehouse: office([grant([...SHIPPING, 'orders.view', 'orders.manage', 'threads.read'])]),
  // An office person limited to Brand Beta: the reader of the wall.
  betaOnly: office([grant([...SHIPPING, 'orders.view', 'threads.read'], [beta])]),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
/** Past the guards (a made-up state the routes would not make: a third order's line, a packed shipment). */
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
const numberOfShipment = async (shipmentId: string): Promise<string> => (await admin<{ number: string }>(`SELECT number FROM "Shipment" WHERE id = $1`, [shipmentId]))[0]!.number
const ids = { alpha2: '', beta1: '' }
let locale: 'it' | 'en' = 'it'

/** The shipment's own events the handler reads, as the outbox holds them (oldest first). */
interface OutboxRow {
  readonly id: string
  readonly type: string
  readonly payload: Json
}
const eventsOf = (shipmentId: string) =>
  admin<OutboxRow>(`SELECT id::text AS id, type, payload FROM "OutboxEvent" WHERE subject = $1 AND type = ANY($2::text[]) ORDER BY "occurredAt", id`, [shipmentId, ['shipment.created', 'shipment.orders_changed', 'shipment.status_changed']])
const system = () => callerFor(database, systemContext(A.tenant, newId()))
/** The handler's work for one event, as the worker runs it. */
const notesOf = (event: OutboxRow) => shipmentOrderNotes(system(), { eventId: event.id, type: event.type, payload: event.payload })
/** The system lines of an order's own thread that name a shipment, oldest first. */
const linesOf = (salesOrderId: string, shipment: string) =>
  admin<{ id: string; bodyText: string; direction: string; audience: string; authorKind: string }>(
    `SELECT m.id::text AS id, m."bodyText", m.direction::text AS direction, m.audience::text AS audience, m."authorKind"::text AS "authorKind" FROM "Message" m JOIN "Thread" t ON t.id = m."threadId"
      WHERE t."recordType" = 'SalesOrder' AND t."recordId" = $1 AND m."authorKind" = 'SYSTEM' AND m."bodyText" LIKE '%' || $2 || '%' ORDER BY m.at, m.id`,
    [salesOrderId, shipment],
  )
const bodiesOf = async (salesOrderId: string, shipment: string): Promise<string[]> => (await linesOf(salesOrderId, shipment)).map((row) => row.bodyText)
/** The line the handler writes, in the company's language. */
const line = (shipment: string, kind: ShipmentOrderNote, siblings: readonly string[] = [], draft = true): string => shipmentOrderLineOf({ kind, shipment, draft, siblings }, locale)

beforeAll(async () => {
  db = await migratedDatabase('cw040_order_notes')
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
  locale = (await admin<{ locale: string | null }>(`SELECT locale FROM "Company" WHERE id = $1`, [A.companyA]))[0]?.locale === 'en' ? 'en' : 'it'
  if ((await admin(`SELECT 1 FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2'`, [A.tenant])).length === 0) {
    await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), A.tenant])
  }
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-order-notes-test-'))
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

// The shared shipment of the cases below (made by the first, cancelled by the last but one).
const S = { id: '', number: '' }

describe('B-CW-040: orders on and off a shipment — one office line in each order\'s own thread', () => {
  it('made with two orders: shipment.created tells both, each naming the other; the change of the creation writes nothing; a retry writes nothing more; one bell batch', async () => {
    const made = (await ok('warehouse', 'POST', '/shipping/shipments', { salesOrderId: so2(), salesOrderIds: [so2(), so3()], siteId: A.siteA1, lines: [{ workOrderSizeId: cells().blk52, quantity: 1 }, { workOrderSizeId: cells().jacket, quantity: 1 }] }, 201)).shipment
    S.id = made.id as string
    S.number = await numberOfShipment(S.id)
    const events = await eventsOf(S.id)
    const created = events.find((event) => event.type === 'shipment.created')!
    const joined = events.find((event) => event.type === 'shipment.orders_changed')!
    expect(created.payload).toMatchObject({ shipmentId: S.id, number: S.number, salesOrderId: so2() })
    // The payload now says who came on, and that the change rides with the shipment's creation.
    expect(joined.payload).toMatchObject({ shipmentId: S.id, change: 'ADDED', salesOrderIds: [so2(), so3()], added: [so3()], atCreation: true })
    expect(joined.payload).not.toHaveProperty('removed')

    const written = await notesOf(created)
    expect(written.map((row) => row.orderId).sort()).toEqual([so2(), so3()].sort())
    expect(await bodiesOf(so2(), S.number)).toEqual([line(S.number, 'ON', ['SEED-SO-0003'])])
    expect(await bodiesOf(so3(), S.number)).toEqual([line(S.number, 'ON', ['SEED-SO-0002'])])
    // The settled words, in the company's language.
    expect(await bodiesOf(so2(), S.number)).toEqual([locale === 'it' ? `In spedizione in bozza ${S.number} con SEED-SO-0003.` : `On draft shipment ${S.number} with SEED-SO-0003.`])
    // An office-only note by the system: the customer never reads it.
    for (const row of [...(await linesOf(so2(), S.number)), ...(await linesOf(so3(), S.number))]) expect(row).toMatchObject({ direction: 'INTERNAL_NOTE', audience: 'OFFICE', authorKind: 'SYSTEM' })
    // The ADDED event of the same creation writes nothing: shipment.created told both orders.
    expect(await notesOf(joined)).toEqual([])
    // The handler run again (a retry) writes nothing more.
    await notesOf(created)
    expect(await bodiesOf(so2(), S.number)).toHaveLength(1)
    expect(await bodiesOf(so3(), S.number)).toHaveLength(1)
    // One bell per event: both lines carry the event's id as their batch.
    const posted = await admin<{ batch: string | null }>(`SELECT payload->>'batchId' AS batch FROM "OutboxEvent" WHERE type = 'thread.message_posted' AND payload->>'messageId' = ANY($1::text[])`, [written.map((row) => row.messageId)])
    expect(posted.map((row) => row.batch)).toEqual([created.id, created.id])
    // One audit row on each order, naming the event and the shipment — never a person.
    const audits = await admin<{ recordId: string; actorId: string | null; after: Json }>(`SELECT "recordId"::text AS "recordId", "actorId"::text AS "actorId", after FROM "AuditLog" WHERE action = 'shipping.orderNotes' AND "recordType" = 'SalesOrder' AND after->>'shipmentId' = $1`, [S.id])
    expect(audits.map((row) => row.recordId).sort()).toEqual([so2(), so3()].sort())
    for (const audit of audits) expect(audit.after).toMatchObject({ eventType: 'shipment.created', shipmentId: S.id, kind: 'ON', siblings: 1 })
  })

  it('an order taken off: "No longer on…" on that order only; joined again later: one line on the joiner, none on the order that stayed', async () => {
    const shipment = (await ok('warehouse', 'GET', `/shipping/shipments/${S.id}`)).shipment
    const jacket = (shipment.lines as Json[]).find((entry) => entry.workOrderSizeId === cells().jacket)!
    expect(jacket).toBeDefined()
    const after = (await ok('warehouse', 'DELETE', `/shipping/shipments/${S.id}/lines/${jacket.id}?version=${shipment.version}`)).shipment
    const removed = (await eventsOf(S.id)).find((event) => event.type === 'shipment.orders_changed' && event.payload.change === 'REMOVED')!
    // The orders after the change alone could not say who left: `removed` does.
    expect(removed.payload).toMatchObject({ change: 'REMOVED', salesOrderIds: [so2()], removed: [so3()] })
    expect(removed.payload).not.toHaveProperty('added')
    expect(removed.payload).not.toHaveProperty('atCreation')
    expect(await notesOf(removed)).toEqual([{ orderId: so3(), messageId: expect.any(String) }])
    expect(await bodiesOf(so3(), S.number)).toEqual([line(S.number, 'ON', ['SEED-SO-0002']), line(S.number, 'OFF')])
    expect((await bodiesOf(so3(), S.number)).at(-1)).toBe(locale === 'it' ? `Non più nella spedizione in bozza ${S.number}.` : `No longer on draft shipment ${S.number}.`)
    expect(await bodiesOf(so2(), S.number)).toHaveLength(1)

    await ok('warehouse', 'POST', `/shipping/shipments/${S.id}/lines`, { version: after.version, lines: [{ workOrderSizeId: cells().jacket, quantity: 1 }] })
    const again = (await eventsOf(S.id)).filter((event) => event.type === 'shipment.orders_changed' && event.payload.change === 'ADDED').at(-1)!
    expect(again.payload).toMatchObject({ change: 'ADDED', salesOrderIds: [so2(), so3()], added: [so3()] })
    expect(again.payload).not.toHaveProperty('atCreation')
    expect(await notesOf(again)).toEqual([{ orderId: so3(), messageId: expect.any(String) }])
    expect(await bodiesOf(so3(), S.number)).toEqual([line(S.number, 'ON', ['SEED-SO-0002']), line(S.number, 'OFF'), line(S.number, 'ON', ['SEED-SO-0002'])])
    // The order that stayed gets no line when another joins.
    expect(await bodiesOf(so2(), S.number)).toHaveLength(1)
  })

  it('three orders on one shipment: three lines, one in each order\'s thread, each naming the other two; the same event twice: still three', async () => {
    // A third order of Brand Alpha on the shipment, by a raw line past the guards (the seeds release garments of two orders only).
    const raw = newId()
    await force(
      `INSERT INTO "ShipmentLine" (id, "tenantId", "siteId", "partyId", "shipmentId", "workOrderId", "workOrderSizeId", "salesOrderLineId", size, quantity)
       SELECT $1, c."tenantId", c."siteId", s."partyId", s.id, c."workOrderId", c.id, (SELECT l.id FROM "SalesOrderLine" l WHERE l."orderId" = $4 ORDER BY l.seq LIMIT 1), c.size, 1 FROM "WorkOrderSize" c, "Shipment" s WHERE c.id = $2 AND s.id = $3`,
      [raw, cells().blk52, S.id, ids.alpha2],
    )
    try {
      const event: OutboxRow = { id: newId(), type: 'shipment.created', payload: { shipmentId: S.id } }
      const written = await notesOf(event)
      expect(written.map((row) => row.orderId).sort()).toEqual([so2(), so3(), ids.alpha2].sort())
      expect((await bodiesOf(so2(), S.number)).at(-1)).toBe(line(S.number, 'ON', ['SEED-SO-0003', 'SO-ALPHA-2']))
      expect((await bodiesOf(so3(), S.number)).at(-1)).toBe(line(S.number, 'ON', ['SEED-SO-0002', 'SO-ALPHA-2']))
      expect(await bodiesOf(ids.alpha2, S.number)).toEqual([line(S.number, 'ON', ['SEED-SO-0002', 'SEED-SO-0003'])])
      const counts = async () => [(await bodiesOf(so2(), S.number)).length, (await bodiesOf(so3(), S.number)).length, (await bodiesOf(ids.alpha2, S.number)).length]
      const before = await counts()
      await notesOf(event)
      expect(await counts()).toEqual(before)
      // One batch for the three lines of the one event.
      const posted = await admin<{ batch: string | null }>(`SELECT payload->>'batchId' AS batch FROM "OutboxEvent" WHERE type = 'thread.message_posted' AND payload->>'messageId' = ANY($1::text[])`, [written.map((row) => row.messageId)])
      expect(posted.map((row) => row.batch)).toEqual([event.id, event.id, event.id])
    } finally {
      await force(`DELETE FROM "ShipmentLine" WHERE id = $1`, [raw])
    }
  })

  it('alone on a shipment: no "with …"; "draft" is said only while the shipment is a draft', async () => {
    const alone = (await ok('warehouse', 'POST', '/shipping/shipments', { salesOrderId: so2(), siteId: A.siteA1 }, 201)).shipment
    const number = await numberOfShipment(alone.id as string)
    const created = (await eventsOf(alone.id as string)).find((event) => event.type === 'shipment.created')!
    expect(await notesOf(created)).toEqual([{ orderId: so2(), messageId: expect.any(String) }])
    expect(await bodiesOf(so2(), number)).toEqual([locale === 'it' ? `In spedizione in bozza ${number}.` : `On draft shipment ${number}.`])
    // Packed (a made-up state): a line written then says "shipment", not "draft shipment".
    await force(`UPDATE "Shipment" SET status = 'PACKED', "packedAt" = now() WHERE id = $1`, [alone.id])
    try {
      await notesOf({ id: newId(), type: 'shipment.orders_changed', payload: { shipmentId: alone.id, change: 'REMOVED', salesOrderIds: [so2()], removed: [so2()] } })
      expect((await bodiesOf(so2(), number)).at(-1)).toBe(line(number, 'OFF', [], false))
      expect((await bodiesOf(so2(), number)).at(-1)).not.toMatch(/draft|bozza/)
    } finally {
      await force(`UPDATE "Shipment" SET status = 'DRAFT', "packedAt" = NULL WHERE id = $1`, [alone.id])
    }
    const current = (await ok('warehouse', 'GET', `/shipping/shipments/${alone.id}`)).shipment
    await ok('warehouse', 'POST', `/shipping/shipments/${alone.id}/cancel`, { version: current.version, reason: 'Made-up: made for the test of one order alone.' })
  })

  it('the shipment cancelled: one line on each order it carried; any other status, and an event that cannot say who, write none', async () => {
    const shipment = (await ok('warehouse', 'GET', `/shipping/shipments/${S.id}`)).shipment
    await ok('warehouse', 'POST', `/shipping/shipments/${S.id}/cancel`, { version: shipment.version, reason: 'Made-up: the customer asked us to wait.' })
    const cancelled = (await eventsOf(S.id)).find((event) => event.type === 'shipment.status_changed' && event.payload.to === 'CANCELLED')!
    expect(cancelled).toBeDefined()
    expect((await notesOf(cancelled)).map((row) => row.orderId).sort()).toEqual([so2(), so3()].sort())
    for (const order of [so2(), so3()]) expect((await bodiesOf(order, S.number)).at(-1), order).toBe(locale === 'it' ? `La spedizione ${S.number} è stata annullata.` : `Shipment ${S.number} was cancelled.`)
    // A retry of the cancel's event writes nothing more.
    const counts = [(await bodiesOf(so2(), S.number)).length, (await bodiesOf(so3(), S.number)).length]
    await notesOf(cancelled)
    expect([(await bodiesOf(so2(), S.number)).length, (await bodiesOf(so3(), S.number)).length]).toEqual(counts)
    // Packed or unpacked is no news for an order's thread; an old event without `added` / `removed` cannot say who.
    expect(await notesOf({ id: newId(), type: 'shipment.status_changed', payload: { shipmentId: S.id, number: S.number, from: 'DRAFT', to: 'PACKED' } })).toEqual([])
    expect(await notesOf({ id: newId(), type: 'shipment.orders_changed', payload: { shipmentId: S.id, number: S.number, salesOrderIds: [so2(), so3()], change: 'ADDED' } })).toEqual([])
    expect(await notesOf({ id: newId(), type: 'shipment.packing_changed', payload: { shipmentId: S.id } })).toEqual([])
    expect(await notesOf({ id: newId(), type: 'shipment.created', payload: { shipmentId: newId() } })).toEqual([])
    expect([(await bodiesOf(so2(), S.number)).length, (await bodiesOf(so3(), S.number)).length]).toEqual(counts)
  })
})
