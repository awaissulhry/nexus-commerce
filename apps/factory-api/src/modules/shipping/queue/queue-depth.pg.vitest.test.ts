import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { clockText, plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { weekdayOf } from '@nexus/factory-domain/shipping/queue/cutoff'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPacking } from '../../../../../../packages/factory-db/seed/packing'
import { seed as seedShipping, type ShippingSeed } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { systemContext } from '../../../platform/outbox/system'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { syncSystemHolds, systemHoldsHandler } from '../holds/system'

/**
 * The shipment queue in depth (B-W2b-386; LOG-005, LOG-017, LOG-018, LOG-110, LOG-120, FIN-079; follow-ups LQ1:01, LQ1:02;
 * Rule 1: the dispatch desk works the queue every day) on the local stack, with the app's real routes: a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security, the column grants, W1's shipping
 * triggers and B-W2b-364's …_packing_w2b_guards are real), the factory-db seeds up to packing, sessions from the test
 * authenticator, the system's holds through the real handler's work. Every name, number and date is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/shipping/queue`.
 *
 *   cut-offs    a site's carrier cut-offs saved as one table; a bad time refused at its field
 *   holds       placed with a reason and words; twice for one reason, OTHER without words, a scan into a held shipment
 *               refused; the desk releases its own kinds, only finance a credit hold; the holds list; the selection's Hold
 *   system      FIN-079: an open balance before shipping holds the shipment and the hold lifts itself once paid; a hold
 *               finance let go is not placed again for the same cause; LQ1:01: the customer's account hold holds a
 *               shipment drafted before it and lifts with it
 *   split       by carrier (the hold carried over, something must stay), by promise date (the rule), one day refused
 *   queue       ship today with its carrier cards and cut-offs on the site's clock; late, held, past the cut-off, at
 *               risk; the at-risk queue with the orders not planned yet; the ready list's ship-by day and risk
 *   search      by tracking number, order, customer PO, serial and carton code; an SSCC said not kept
 *   DDT         the customer's requirements on the shipping checklist become the DDT's remarks unless typed
 *   Today       the dispatch desk's SHIPMENT_AT_RISK rows
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let shippingA: ShippingSeed

const ns = 'queue-depth-a'
const idOf = (key: string) => seedUuid(ns, key)
const A = { tenant: idOf('tenant'), companyA: idOf('company:A'), companyB: idOf('company:B'), siteA1: idOf('site:A1'), actor: idOf('actor') }

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants })
const SHIPPING: Permission[] = ['shipping.view', 'shipping.manage', 'shipping.pack', 'shipping.settings.view', 'shipping.settings.manage', 'print.view', 'print.labels']
const SESSIONS: Record<string, SessionContext> = {
  warehouse: office([grant([...SHIPPING, 'shipping.holds.manage', 'home.view'])]),
  finance: office([grant(['shipping.view', 'shipping.holds.manage', 'shipping.holds.release'])]),
  viewer: office([grant(['shipping.view'])]),
  companyB: office([grant(['shipping.view', 'shipping.holds.manage'], [A.companyB])]),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
/** A write past the guards (made-up facts the seeds do not have). */
const asOwner = async (work: () => Promise<unknown>) => {
  await admin('SET session_replication_role = replica')
  try {
    await work()
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
let keys = 0
const run = randomBytes(4).toString('hex')
const key = () => `queue-depth-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': key() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const refusedFor = async (session: string, method: Method, url: string, payload: unknown, code: string) => {
  const error = await refused(session, method, url, payload, 409)
  expect(error.issues?.[0]?.path, error.message).toBe(`refusal/${code}`)
  return error
}

const system = () => callerFor(database, systemContext(A.tenant, `queue-depth-${run}`))
const ids = { blkLine: '', milestone: '', milestone2: '', party: '', partyHold: '', redLine: '', s1: '', s1b: '', s2: '', s2Number: '', s2b: '' }
const cells: Record<string, string> = {}
const cell = (name: string) => cells[name]!
let siteZone = 'Europe/Rome'
const today = () => businessDate(new Date(), siteZone)
/** A promise for an order line (its size, or every size), newer than any before it. */
const promise = async (orderLineId: string, size: string | null, date: string) =>
  asOwner(() =>
    admin(`INSERT INTO "PromiseRecord" (id, "tenantId", "salesOrderLineId", "partyId", size, "promisedDate", kind, reason, "promisedById", "promisedAt") SELECT $1, $2, l.id, l."partyId", $3, $4::date, 'RE_PROMISE', 'Test promise', $5, now() FROM "SalesOrderLine" l WHERE l.id = $6`, [newId(), A.tenant, size, date, A.actor, orderLineId]),
  )
const holdsOf = async (shipmentId: string) => (await ok('viewer', 'GET', `/shipping/shipments/${shipmentId}/holds`)).holds as Json

beforeAll(async () => {
  db = await migratedDatabase('queue_depth')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  shippingA = await seedShipping({ db: database, namespace: ns })
  await seedPacking({ db: database, namespace: ns })
  await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'SHIPMENT', 'MAIN', 'ALL', 'NEVER', 'SH-{N:5}', false) ON CONFLICT DO NOTHING`, [newId(), A.tenant, A.companyA])
  siteZone = (await admin<{ timezone: string }>(`SELECT timezone FROM "Site" WHERE id = $1`, [A.siteA1]))[0]!.timezone || 'Europe/Rome'
  // Made-up releases: what SEED-SO-0002 still orders of WO-0001 (BLK 52, BLK 54, RED 50, RED 54, one each) is released.
  const passed = (await admin<{ inspectionId: string; workOrderId: string }>(`SELECT "inspectionId", "workOrderId" FROM "QualityRelease" WHERE "workOrderSizeId" = $1 LIMIT 1`, [shippingA.quality.production.cellIds['BLK-52']]))[0]!
  for (const row of await admin<{ id: string; colour: string; size: string }>(`SELECT ws.id, c.code AS colour, ws.size FROM "WorkOrderSize" ws JOIN "Colourway" c ON c.id = ws."colourwayId" WHERE ws."workOrderId" = $1`, [passed.workOrderId])) cells[`${row.colour}-${row.size}`] = row.id
  await asOwner(async () => {
    for (const [n, name] of ['BLK-52', 'BLK-54', 'RED-50', 'RED-54'].entries()) {
      await admin(
        `INSERT INTO "QualityRelease" (id, "tenantId", "companyId", "siteId", "workOrderId", "workOrderSizeId", number, "inspectionId", quantity, "releasedAt", "signatureSha256") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, now() - interval '1 hour', $9)`,
        [newId(), A.tenant, A.companyA, A.siteA1, passed.workOrderId, cell(name), `TEST-REL-${n + 1}`, passed.inspectionId, 'a'.repeat(64)],
      )
    }
  })
  const lines = await admin<{ id: string; colour: string }>(`SELECT l.id, c.code AS colour FROM "SalesOrderLine" l JOIN "Colourway" c ON c.id = l."colourwayId" WHERE l."orderId" = $1`, [shippingA.quality.production.salesOrderId])
  ids.blkLine = lines.find((row) => row.colour === 'BLK')!.id
  ids.redLine = lines.find((row) => row.colour === 'RED')!.id
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

describe("a site's carrier cut-offs (LOG-018)", () => {
  it('saves the table at once and refuses a bad time at its field', async () => {
    const saved = await ok('warehouse', 'PUT', `/shipping/sites/${A.siteA1}/cut-offs`, { cutOffs: [{ carrierCode: 'test-express', weekday: 'MONDAY', time: '16:30' }, { carrierCode: 'test-express', weekday: 'SATURDAY', time: '11:00' }] })
    expect(saved.cutOffs.map((row: Json) => [row.carrierCode, row.weekday, row.time])).toEqual(expect.arrayContaining([['test-express', 'MONDAY', '16:30'], ['test-express', 'SATURDAY', '11:00']]))
    const bad = await refused('warehouse', 'PUT', `/shipping/sites/${A.siteA1}/cut-offs`, { cutOffs: [{ carrierCode: 'test-express', weekday: 'MONDAY', time: '25:00' }] }, 400)
    expect(bad.issues).toEqual([{ path: 'body/cutOffs/0/time', message: 'A time of day, HH:MM (24 hours).' }])
    await refused('viewer', 'PUT', `/shipping/sites/${A.siteA1}/cut-offs`, { cutOffs: [] }, 403)
    // Reading them is the shipping settings' (shipping.settings.view), not the shipments'.
    await refused('viewer', 'GET', `/shipping/sites/${A.siteA1}/cut-offs`, undefined, 403)
    expect((await ok('warehouse', 'GET', `/shipping/sites/${A.siteA1}/cut-offs`)).cutOffs).toHaveLength(saved.cutOffs.length)
  })
})

describe('hold and release a shipment (LOG-017)', () => {
  it('holds with a reason and words: it can no longer be packed', async () => {
    const { shipment } = await ok('warehouse', 'POST', '/shipping/shipments', { salesOrderId: shippingA.quality.production.salesOrderId, lines: [{ workOrderSizeId: cell('BLK-52'), quantity: 1 }, { workOrderSizeId: cell('BLK-54'), quantity: 1 }] }, 201)
    ids.s1 = shipment.id
    const placed = await ok('warehouse', 'POST', `/shipping/shipments/${ids.s1}/holds`, { reason: 'CUSTOMER_REQUEST', words: 'The customer asked us to wait for the rest of the order.' }, 201)
    expect(placed.holds).toMatchObject({ held: true, reasons: ['CUSTOMER_REQUEST'], mayPlace: true })
    expect(placed.holds.holds[0]).toMatchObject({ reason: 'CUSTOMER_REQUEST', inForce: true, bySystem: false, words: 'The customer asked us to wait for the rest of the order.' })
    await refusedFor('warehouse', 'POST', `/shipping/shipments/${ids.s1}/holds`, { reason: 'CUSTOMER_REQUEST' }, 'ALREADY_HELD')
    expect((await refused('warehouse', 'POST', `/shipping/shipments/${ids.s1}/holds`, { reason: 'OTHER', words: ' ' }, 400)).issues).toEqual([{ path: 'body/words', message: 'Say in words why the shipment is held.' }])
    const sku = (await admin<{ sku: string }>(`SELECT v.sku FROM "Variant" v JOIN "Style" s ON s.id = v."styleId" JOIN "Colourway" c ON c.id = v."colourwayId" WHERE s.code = 'SEED-JKT-02' AND c.code = 'BLK' AND v.size = '52' AND v."tenantId" = $1`, [A.tenant]))[0]!.sku
    await refusedFor('warehouse', 'POST', `/shipping/packing/${ids.s1}/scan`, { code: sku }, 'ON_HOLD')
    await refused('viewer', 'POST', `/shipping/shipments/${ids.s1}/holds`, { reason: 'QUALITY' }, 403)
    await refused('companyB', 'POST', `/shipping/shipments/${ids.s1}/holds`, { reason: 'QUALITY' }, 404)
    const events = await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'shipment.hold_placed' AND subject = $1`, [ids.s1])
    expect(events[0]!.n).toBe(1)
  })

  it('lets the desk release its own kinds, and only finance a credit hold, each with words', async () => {
    const credit = await ok('warehouse', 'POST', `/shipping/shipments/${ids.s1}/holds`, { reason: 'CREDIT', words: 'Waiting for finance.' }, 201)
    const creditHold = credit.holds.holds.find((row: Json) => row.reason === 'CREDIT')
    expect(creditHold.mayRelease).toBe(false)
    expect((await refusedFor('warehouse', 'POST', `/shipping/shipments/${ids.s1}/holds/${creditHold.id}/release`, { words: 'Looks fine.' }, 'MAY_NOT_RELEASE')).message).toMatch(/^Only finance/)
    expect((await refused('finance', 'POST', `/shipping/shipments/${ids.s1}/holds/${creditHold.id}/release`, { words: '' }, 400)).issues[0].path).toBe('body/words')
    const released = await ok('finance', 'POST', `/shipping/shipments/${ids.s1}/holds/${creditHold.id}/release`, { words: 'The customer paid the open invoice.' })
    expect(released.holds.reasons).toEqual(['CUSTOMER_REQUEST'])
    await refusedFor('finance', 'POST', `/shipping/shipments/${ids.s1}/holds/${creditHold.id}/release`, { words: 'Again.' }, 'NOT_IN_FORCE')
    const request = released.holds.holds.find((row: Json) => row.reason === 'CUSTOMER_REQUEST')
    const free = await ok('warehouse', 'POST', `/shipping/shipments/${ids.s1}/holds/${request.id}/release`, { words: 'The customer said ship it.' })
    expect(free.holds).toMatchObject({ held: false, reasons: [] })
    expect(free.holds.holds.map((row: Json) => [row.reason, row.inForce, row.releaseWords])).toEqual(expect.arrayContaining([['CREDIT', false, 'The customer paid the open invoice.'], ['CUSTOMER_REQUEST', false, 'The customer said ship it.']]))
  })

  it("holds several from the queue's selection (one that left is skipped), and lists holds without words or people", async () => {
    const many = await ok('warehouse', 'POST', '/shipping/holds', { shipmentIds: [ids.s1, shippingA.shipmentId], reason: 'QUALITY', words: 'A quality question on the batch.' }, 201)
    expect(many.placed.map((row: Json) => row.shipmentId)).toEqual([ids.s1])
    expect(many.skipped).toEqual([expect.objectContaining({ shipmentId: shippingA.shipmentId, code: 'NOT_OPEN' })])
    const list = await ok('viewer', 'GET', `/shipping/holds?siteId=${A.siteA1}`)
    expect(list.holds).toEqual([expect.objectContaining({ reason: 'QUALITY', inForce: true, bySystem: false, mayRelease: false, shipment: expect.objectContaining({ id: ids.s1 }) })])
    expect(Object.keys(list.holds[0])).not.toContain('words')
    expect(Object.keys(list.holds[0])).not.toContain('placedBy')
    await ok('warehouse', 'POST', `/shipping/shipments/${ids.s1}/holds/${many.placed[0].holdId}/release`, { words: 'Quality checked the batch.' })
  })
})

describe("the system's holds: the balance before shipping (FIN-079) and the account on hold (LQ1:01)", () => {
  it('holds while the balance before shipping is open and lifts itself once it is paid', async () => {
    ids.milestone = newId()
    await asOwner(() =>
      admin(`INSERT INTO "SalesOrderMilestone" (id, "tenantId", "companyId", "orderId", "partyId", seq, kind, amount, status, "createdAt") SELECT $1, o."tenantId", o."companyId", o.id, o."partyId", 990, 'BEFORE_SHIPPING', 10000, 'OPEN', now() - interval '1 day' FROM "SalesOrder" o WHERE o.id = $2`, [ids.milestone, shippingA.quality.production.salesOrderId]),
    )
    // The handler's work, as the worker runs it on the order's schedule event.
    await systemHoldsHandler().handle({ eventId: newId(), type: 'sales_order.schedule_changed', payload: { orderId: shippingA.quality.production.salesOrderId } } as never, { caller: system() } as never)
    const held = await holdsOf(ids.s1)
    expect(held.reasons).toEqual(['BALANCE_UNPAID'])
    const balance = held.holds.find((row: Json) => row.inForce)
    expect(balance).toMatchObject({ bySystem: true, placedBy: null, mayRelease: false })
    expect(balance.words).toMatch(/balance before shipping of order .* is not paid/)
    await refusedFor('warehouse', 'POST', `/shipping/shipments/${ids.s1}/holds/${balance.id}/release`, { words: 'Ship it.' }, 'MAY_NOT_RELEASE')
    // Nothing more to do: a second run writes nothing.
    expect(await syncSystemHolds(system(), [ids.s1])).toEqual({ placed: 0, lifted: 0 })
    await asOwner(() => admin(`UPDATE "SalesOrderMilestone" SET status = 'PAID', "paidAt" = now() WHERE id = $1`, [ids.milestone]))
    expect(await syncSystemHolds(system(), [ids.s1])).toEqual({ placed: 0, lifted: 1 })
    const lifted = (await holdsOf(ids.s1)).holds.find((row: Json) => row.id === balance.id)
    expect(lifted).toMatchObject({ inForce: false, releasedBySystem: true, releaseWords: 'The balance before shipping is paid or no longer due.' })
  })

  it('does not hold again for a cause finance let go', async () => {
    ids.milestone2 = newId()
    await asOwner(() =>
      admin(`INSERT INTO "SalesOrderMilestone" (id, "tenantId", "companyId", "orderId", "partyId", seq, kind, amount, status, "createdAt") SELECT $1, o."tenantId", o."companyId", o.id, o."partyId", 991, 'BEFORE_SHIPPING', 5000, 'OPEN', now() - interval '1 hour' FROM "SalesOrder" o WHERE o.id = $2`, [ids.milestone2, shippingA.quality.production.salesOrderId]),
    )
    expect(await syncSystemHolds(system(), [ids.s1])).toEqual({ placed: 1, lifted: 0 })
    const balance = (await holdsOf(ids.s1)).holds.find((row: Json) => row.inForce)
    await ok('finance', 'POST', `/shipping/shipments/${ids.s1}/holds/${balance.id}/release`, { words: 'The customer sent the bank receipt.' })
    expect(await syncSystemHolds(system(), [ids.s1])).toEqual({ placed: 0, lifted: 0 })
    await asOwner(() => admin(`UPDATE "SalesOrderMilestone" SET status = 'WAIVED', "statusNote" = 'Test' WHERE id = $1`, [ids.milestone2]))
  })

  it("holds a shipment drafted before the customer's account hold, and lifts it with the account hold", async () => {
    const party = (await admin<{ partyId: string }>(`SELECT "partyId" FROM "SalesOrder" WHERE id = $1`, [shippingA.quality.production.salesOrderId]))[0]!.partyId
    ids.party = party
    ids.partyHold = newId()
    await asOwner(() => admin(`INSERT INTO "PartyHold" (id, "tenantId", "partyId", "companyId", reason, words, "placedAt") VALUES ($1, $2, $3, $4, 'LEGAL', 'A made-up legal matter.', now())`, [ids.partyHold, A.tenant, party, A.companyA]))
    await systemHoldsHandler().handle({ eventId: newId(), type: 'party.hold_placed', payload: { partyId: party } } as never, { caller: system() } as never)
    const held = await holdsOf(ids.s1)
    expect(held.reasons).toEqual(['OTHER'])
    expect(held.holds.find((row: Json) => row.inForce).words).toMatch(/account is on hold \(a legal matter\)/)
    await asOwner(() => admin(`UPDATE "PartyHold" SET "releasedAt" = now(), "releaseWords" = 'Settled.' WHERE id = $1`, [ids.partyHold]))
    await systemHoldsHandler().handle({ eventId: newId(), type: 'party.hold_released', payload: { partyId: party } } as never, { caller: system() } as never)
    expect((await holdsOf(ids.s1)).held).toBe(false)
  })
})

describe('split one order into several shipments (LOG-005)', () => {
  it('moves garments onto a new shipment by carrier; its holds come along; something stays', async () => {
    const { shipment } = await ok('warehouse', 'POST', '/shipping/shipments', { salesOrderId: shippingA.quality.production.salesOrderId, lines: [{ workOrderSizeId: cell('RED-50'), quantity: 1 }, { workOrderSizeId: cell('RED-54'), quantity: 1 }] }, 201)
    ids.s2 = shipment.id
    ids.s2Number = shipment.number
    const preview = await ok('viewer', 'GET', `/shipping/shipments/${ids.s2}/split`)
    expect(preview).toMatchObject({ splittable: true, held: false, mayManage: false })
    const red54 = preview.lines.find((row: Json) => row.size === '54')
    const red50 = preview.lines.find((row: Json) => row.size === '50')
    expect(red54.movable).toBe(1)
    await ok('warehouse', 'POST', `/shipping/shipments/${ids.s2}/holds`, { reason: 'CUSTOMER_REQUEST', words: 'Hold both parts.' }, 201)
    expect((await refused('warehouse', 'POST', `/shipping/shipments/${ids.s2}/split`, { reason: 'CARRIER', lines: [{ lineId: red54.id, quantity: 1 }] }, 400)).issues[0].path).toBe('body/carrierCode')
    await refusedFor('warehouse', 'POST', `/shipping/shipments/${ids.s2}/split`, { reason: 'CUSTOMER_REQUEST', lines: [{ lineId: red54.id, quantity: 1 }, { lineId: red50.id, quantity: 1 }] }, 'NOTHING_STAYS')
    await refused('viewer', 'POST', `/shipping/shipments/${ids.s2}/split`, { reason: 'CARRIER', transportBy: 'SENDER', lines: [{ lineId: red54.id, quantity: 1 }] }, 403)
    const split = await ok('warehouse', 'POST', `/shipping/shipments/${ids.s2}/split`, { version: preview.version, reason: 'CARRIER', transportBy: 'SENDER', lines: [{ lineId: red54.id, quantity: 1 }] }, 201)
    ids.s2b = split.shipment.id
    expect(split.shipment).toMatchObject({ status: 'DRAFT', transportBy: 'SENDER', carrierCode: null, salesOrderId: shippingA.quality.production.salesOrderId })
    expect(split.shipment.lines.map((line: Json) => [line.size, line.quantity])).toEqual([['54', 1]])
    expect(split.from.lines.map((line: Json) => [line.size, line.quantity])).toEqual([['50', 1]])
    const row = (await admin<{ splitFromId: string; splitReason: string }>(`SELECT "splitFromId", "splitReason" FROM "Shipment" WHERE id = $1`, [ids.s2b]))[0]!
    expect(row).toEqual({ splitFromId: ids.s2, splitReason: 'CARRIER' })
    expect((await holdsOf(ids.s2b)).reasons).toEqual(['CUSTOMER_REQUEST'])
    for (const id of [ids.s2, ids.s2b]) {
      const hold = (await holdsOf(id)).holds.find((candidate: Json) => candidate.inForce)
      await ok('warehouse', 'POST', `/shipping/shipments/${id}/holds/${hold.id}/release`, { words: 'Go.' })
    }
  })

  it('splits by promise date (the earliest day stays), and refuses when every garment is promised for one day', async () => {
    await promise(ids.blkLine, '52', plusDays(today(), 3))
    await promise(ids.blkLine, '54', plusDays(today(), 10))
    const preview = await ok('viewer', 'GET', `/shipping/shipments/${ids.s1}/split`)
    expect(preview.rules[0]).toMatchObject({ rule: 'PROMISE_DATE', stays: plusDays(today(), 3), shipments: [expect.objectContaining({ shipBy: plusDays(today(), 10), garments: 1 })] })
    const split = await ok('warehouse', 'POST', `/shipping/shipments/${ids.s1}/split-by-rule`, { rule: 'PROMISE_DATE' }, 201)
    expect(split.shipments).toHaveLength(1)
    ids.s1b = split.shipments[0].id
    expect(split.shipments[0].lines.map((line: Json) => line.size)).toEqual(['54'])
    expect(split.from.lines.map((line: Json) => line.size)).toEqual(['52'])
    await refusedFor('warehouse', 'POST', `/shipping/shipments/${ids.s1}/split-by-rule`, { rule: 'PROMISE_DATE' }, 'ONE_DAY')
    const events = await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'shipment.split'`)
    expect(events[0]!.n).toBe(2)
  })
})

describe('what must leave today and what is at risk (LOG-018, LOG-110)', () => {
  it('lists the shipments due with their carrier cards; late and held first; the rest not due', async () => {
    // RED 50 (S2) was due yesterday; RED 54 (S2b, our own van) is due today and on hold; BLK 52 and BLK 54 later.
    await promise(ids.redLine, '50', plusDays(today(), -1))
    await promise(ids.redLine, '54', today())
    const hold = await ok('warehouse', 'POST', `/shipping/shipments/${ids.s2b}/holds`, { reason: 'QUALITY' }, 201)
    const queue = await ok('viewer', 'GET', `/shipping/queue/today?siteId=${A.siteA1}`)
    expect(queue.site).toMatchObject({ siteId: A.siteA1, timeZone: siteZone, today: today() })
    // The worst first (LATE before HELD); other seeded shipments may be due too: only this test's are compared.
    const mine = (queue.shipments as Json[]).filter((row) => [ids.s1, ids.s1b, ids.s2, ids.s2b].includes(row.id))
    expect(mine.map((row) => [row.id, row.risk, row.shipBy])).toEqual([
      [ids.s2, 'LATE', plusDays(today(), -1)],
      [ids.s2b, 'HELD', today()],
    ])
    expect(mine[1]).toMatchObject({ held: true, holdReasons: ['QUALITY'], willMiss: true, carrierKey: 'SENDER', garments: 1 })
    expect(queue.tiles.held).toBeGreaterThanOrEqual(1)
    expect(queue.tiles.late).toBeGreaterThanOrEqual(1)
    expect(queue.tiles.notDue).toBeGreaterThanOrEqual(2)
    expect(queue.carriers.map((card: Json) => card.key)).toEqual(expect.arrayContaining(['SENDER', mine[0]!.carrierKey]))
    expect(queue.carriers.find((card: Json) => card.key === 'SENDER')).toMatchObject({ shipments: 1, toPack: 1, held: 1, willMiss: 1 })
    await ok('warehouse', 'POST', `/shipping/shipments/${ids.s2b}/holds/${hold.holdId}/release`, { words: 'Checked.' })
  })

  it("judges today's shipment by its cut-off on the site's clock", async () => {
    const queue = await ok('viewer', 'GET', `/shipping/queue/today?siteId=${A.siteA1}&warnMinutes=1440`)
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: siteZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date())
    const minute = Number(parts.find((part) => part.type === 'hour')!.value) * 60 + Number(parts.find((part) => part.type === 'minute')!.value)
    const s2b = () => ok('viewer', 'GET', `/shipping/queue/today?siteId=${A.siteA1}&warnMinutes=1440`).then((answer) => answer.shipments.find((row: Json) => row.id === ids.s2b))
    if (!queue.site.open) {
      // The site does not work today (its calendar): what is due today misses today's pickup.
      expect((await s2b()).risk).toBe('MISSED_CUT_OFF')
      return
    }
    if (minute < 10 || minute > 1400) return // too near midnight to set a cut-off on either side of now
    await asOwner(() => admin(`UPDATE "ShippingSettings" SET "cutOffTime" = $1 WHERE id = $2`, [clockText(minute + 30), A.siteA1]))
    const ahead = await s2b()
    expect(ahead).toMatchObject({ risk: 'AT_RISK', cutOff: { time: clockText(minute + 30), source: 'SITE', passed: false } })
    const calm = (await ok('viewer', 'GET', `/shipping/queue/today?siteId=${A.siteA1}&warnMinutes=15`)).shipments.find((row: Json) => row.id === ids.s2b)
    expect(calm.risk).toBe('DUE_TODAY')
    await asOwner(() => admin(`UPDATE "ShippingSettings" SET "cutOffTime" = $1 WHERE id = $2`, [clockText(minute - 5), A.siteA1]))
    expect(await s2b()).toMatchObject({ risk: 'MISSED_CUT_OFF', cutOff: { passed: true } })
    // A carrier's own cut-off on today's weekday wins over the site's default.
    const carrier = queue.shipments.find((row: Json) => row.id === ids.s2).carrierKey
    if (carrier !== 'none') {
      await ok('warehouse', 'PUT', `/shipping/sites/${A.siteA1}/cut-offs`, { cutOffs: [{ carrierCode: carrier, weekday: weekdayOf(today()), time: '23:59' }] })
      const card = (await ok('viewer', 'GET', `/shipping/queue/today?siteId=${A.siteA1}`)).carriers.find((row: Json) => row.key === carrier)
      expect(card.cutOff).toMatchObject({ time: '23:59', source: 'CARRIER' })
    }
  })

  it('the at-risk queue adds the orders whose released garments are due and on no shipment yet; the ready list says why', async () => {
    const serialOrder = (await admin<{ orderId: string; lineId: string }>(`SELECT s."salesOrderId" AS "orderId", l."salesOrderLineId" AS "lineId" FROM "Shipment" s JOIN "ShipmentLine" l ON l."shipmentId" = s.id WHERE s.id = $1`, [shippingA.draftShipmentId]))[0]!
    await promise(serialOrder.lineId, null, plusDays(today(), -2))
    const risk = await ok('viewer', 'GET', `/shipping/queue/at-risk?siteId=${A.siteA1}`)
    expect(risk.shipments.map((row: Json) => row.id)).toEqual(expect.arrayContaining([ids.s2]))
    expect(risk.shipments.every((row: Json) => ['LATE', 'HELD', 'MISSED_CUT_OFF', 'AT_RISK'].includes(row.risk))).toBe(true)
    expect(risk.notPlanned).toEqual(expect.arrayContaining([expect.objectContaining({ salesOrderId: serialOrder.orderId, risk: 'LATE', shipBy: plusDays(today(), -2), garments: 1 })]))
    const ready = await ok('viewer', 'GET', `/shipping/ready?siteId=${A.siteA1}`)
    const order = ready.orders.find((row: Json) => row.salesOrderId === serialOrder.orderId)
    expect(order).toMatchObject({ risk: 'LATE', shipBy: { day: plusDays(today(), -2), siteId: A.siteA1 } })
    expect(order.cells[0].shipBy).toBe(plusDays(today(), -2))
  })

  it("puts the late shipment on the dispatch desk's Today", async () => {
    const answer = await ok('warehouse', 'GET', '/home/today')
    const rows = (answer.items as Json[]).filter((item) => item.kind === 'SHIPMENT_AT_RISK')
    expect(rows.map((item) => item.record.id)).toEqual(expect.arrayContaining([ids.s2]))
    expect(rows.find((item) => item.record.id === ids.s2)).toMatchObject({ state: 'LATE', severity: 'HIGH' })
  })
})

describe('search and history (LOG-120)', () => {
  it('finds by tracking number, order, customer PO, serial and carton code, and says an SSCC is not kept', async () => {
    const byTracking = await ok('viewer', 'GET', '/shipping/queue/search?q=SEEDTRACK0001')
    expect(byTracking.shipments.map((row: Json) => [row.id, row.matchedBy])).toEqual([[shippingA.shipmentId, ['TRACKING']]])
    const order = (await admin<{ number: string; customerRef: string | null }>(`SELECT number, "customerRef" FROM "SalesOrder" WHERE id = $1`, [shippingA.quality.production.salesOrderId]))[0]!
    const byOrder = await ok('viewer', 'GET', `/shipping/queue/search?q=${encodeURIComponent(order.number)}`)
    expect(byOrder.shipments.map((row: Json) => row.id)).toEqual(expect.arrayContaining([shippingA.shipmentId, ids.s1, ids.s2, ids.s2b, ids.s1b]))
    expect(byOrder.shipments.find((row: Json) => row.id === ids.s2b)).toMatchObject({ splitFrom: { id: ids.s2, reason: 'CARRIER' }, matchedBy: ['ORDER'] })
    if (order.customerRef) expect((await ok('viewer', 'GET', `/shipping/queue/search?q=${encodeURIComponent(order.customerRef)}`)).shipments[0].matchedBy).toContain('CUSTOMER_PO')
    // A serial packed on SH-0002 (W1's packing route).
    const serial = (await admin<{ serial: string }>(`SELECT gs.serial FROM "GarmentSerial" gs JOIN "ShipmentLine" sl ON sl."workOrderSizeId" = gs."workOrderSizeId" WHERE sl.id = $1 AND gs.status = 'RELEASED' AND gs."shipmentLineId" IS NULL ORDER BY gs.serial LIMIT 1`, [shippingA.draftLineId]))[0]!.serial
    await ok('warehouse', 'POST', `/shipping/packing/${shippingA.draftShipmentId}/serials`, { serial })
    const bySerial = await ok('viewer', 'GET', `/shipping/queue/search?q=${encodeURIComponent(serial.toLowerCase())}`)
    expect(bySerial.shipments).toEqual([expect.objectContaining({ id: shippingA.draftShipmentId, matchedBy: ['SERIAL'], matchedSerials: [serial] })])
    // A carton numbered "1 of 1" on S2 (its marks carry `<shipment number>-1`).
    const parcel = await ok('warehouse', 'POST', `/shipping/packing/${ids.s2}/parcels`, {}, 201)
    const parcelId = (parcel.parcels ?? parcel.packing?.parcels ?? [])[0]?.id ?? (await admin<{ id: string }>(`SELECT id FROM "Parcel" WHERE "shipmentId" = $1`, [ids.s2]))[0]!.id
    await asOwner(() => admin(`UPDATE "Parcel" SET "cartonNumber" = 1, "cartonCount" = 1 WHERE id = $1`, [parcelId]))
    const byCarton = await ok('viewer', 'GET', `/shipping/queue/search?q=${encodeURIComponent(`${ids.s2Number}-1`)}`)
    expect(byCarton.shipments).toEqual([expect.objectContaining({ id: ids.s2, matchedBy: ['CARTON'] })])
    const sscc = await ok('viewer', 'GET', `/shipping/queue/search?q=${encodeURIComponent('(00)123456789012345675')}`)
    expect(sscc).toMatchObject({ notKept: ['SSCC'], shipments: [] })
    expect((await refused('viewer', 'GET', '/shipping/queue/search?q=S', undefined, 400)).issues[0].path).toBe('query/q')
    // The history window: what left on the seed's day.
    const shipped = (await admin<{ day: string }>(`SELECT to_char("shippedAt" AT TIME ZONE 'Europe/Rome', 'YYYY-MM-DD') AS day FROM "Shipment" WHERE id = $1`, [shippingA.shipmentId]))[0]!.day
    const history = await ok('viewer', 'GET', `/shipping/queue/search?shippedFrom=${shipped}&shippedTo=${shipped}`)
    expect(history.shipments.map((row: Json) => row.id)).toEqual([shippingA.shipmentId])
  })
})

describe("the customer's requirements on the DDT (LQ1:02)", () => {
  it('prints the shipping checklist requirements as the remarks, unless the office types its own', async () => {
    await asOwner(() =>
      admin(`INSERT INTO "CustomerRequirement" (id, "tenantId", "partyId", kind, words, "appliesAt", active) VALUES ($1, $2, $3, 'DOCUMENT', 'Write our PO number on the DDT.', '{SHIPMENT}', true), ($4, $2, $3, 'PACKING', 'Fold each jacket in tissue.', '{PACKING}', true)`, [newId(), A.tenant, ids.party, newId()]),
    )
    const preview = await ok('viewer', 'POST', `/shipping/shipments/${shippingA.shipmentId}/ddt/preview`, {})
    expect(preview.draft.remarks).toBe('Write our PO number on the DDT.')
    expect((await ok('viewer', 'POST', `/shipping/shipments/${shippingA.shipmentId}/ddt/preview`, { remarks: 'Handle with care.' })).draft.remarks).toBe('Handle with care.')
    expect((await ok('viewer', 'POST', `/shipping/shipments/${shippingA.shipmentId}/ddt/preview`, { remarks: null })).draft.remarks).toBeNull()
  })
})
