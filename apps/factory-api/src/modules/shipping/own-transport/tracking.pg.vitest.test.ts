import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { EVENT_CATALOGUE } from '@nexus/factory-domain/events/catalogue'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedShipping, type ShippingSeed } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { systemContext } from '../../../platform/outbox/system'
import { trackingLineOf, trackingNotes } from './tracking-notes'

/**
 * B-OP-030 (order page plan N5; review R-15) — a typed tracking number tells the office: PUT /shipping/shipments/:id/own-transport/tracking
 * (shipping.manage, as today) emits `shipment.tracking_changed` once per change — typed, corrected, cleared, also after the goods left —
 * and its handler `shipping.trackingNotes` writes ONE office-only system line on the order's thread per event. No mail to the customer.
 *
 * On the local stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level
 * security, the grants and the shipping guards are real), the core and shipping seeds (SEED-SH-0001 left with carrier labels for
 * SEED-SO-0002; SEED-SH-0002 a DRAFT for the same carrier for SEED-SO-0003, made to have left here), test sessions. Every name and
 * number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/shipping/own-transport`.
 */

const ns = 'op030-tracking'
const T = seedUuid(ns, 'tenant')
const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  desk: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['shipping.view', 'shipping.manage'])] },
  viewer: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['shipping.view'])] },
}

type Json = Record<string, any>
let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let seeded: ShippingSeed
let keys = 0
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'PUT' ? { 'idempotency-key': `op030-${++keys}-${newId()}` } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
const tracking = (shipmentId: string) => `/shipping/shipments/${shipmentId}/own-transport/tracking`
const versionOf = async (shipmentId: string) => (await admin<{ version: number }>(`SELECT version FROM "Shipment" WHERE id = $1`, [shipmentId]))[0]!.version
// op-fx2 (end check): the customer the live wall routes by is the payload's partyId (events/live.ts livePartiesOf); the outbox
// row's own "partyId" column is the WRITER's scope (a partner or link write), null for this office write.
const eventsOf = (shipmentId: string) => admin<{ id: string; type: string; payload: Json; partyId: string | null; rowPartyId: string | null }>(`SELECT id, type, payload, payload->>'partyId' AS "partyId", "partyId" AS "rowPartyId" FROM "OutboxEvent" WHERE type = 'shipment.tracking_changed' AND subject = $1 ORDER BY "occurredAt", id`, [shipmentId])
const linesOf = (orderId: string) =>
  admin<{ bodyText: string; direction: string; audience: string; authorKind: string }>(
    `SELECT m."bodyText", m.direction::text AS direction, m.audience::text AS audience, m."authorKind"::text AS "authorKind" FROM "Message" m JOIN "Thread" t ON t.id = m."threadId"
      WHERE t."recordType" = 'SalesOrder' AND t."recordId" = $1 AND m."authorKind" = 'SYSTEM' AND m."bodyText" LIKE '%SEED-SH-0002%' ORDER BY m.at, m.id`,
    [orderId],
  )
const system = () => callerFor(database, systemContext(T, newId()))
const notesOf = async (event: { id: string; type: string; payload: Json }) => trackingNotes(system(), { eventId: event.id, type: event.type, payload: event.payload })

beforeAll(async () => {
  db = await migratedDatabase('op030_tracking')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  seeded = await seedShipping({ db: database, namespace: ns })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
  // SEED-SH-0002 (a carrier, no label) has left: its number is typed afterwards, as a carrier booked by hand gives it.
  await admin(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE "Shipment" SET status = 'SHIPPED', "shippedAt" = now() - interval '1 day', "packedAt" = now() - interval '1 day' WHERE id = '${seeded.draftShipmentId}'; COMMIT;`)
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('B-OP-030: a typed tracking number tells the office, once per change', () => {
  const orderId = () => seeded.quality.serialSalesOrderId

  it('typed after the goods left: one shipment.tracking_changed, its live fields never the customer; ONE office line on the order’s thread', async () => {
    const answer = await call('desk', 'PUT', tracking(seeded.draftShipmentId), { version: await versionOf(seeded.draftShipmentId), trackingNumber: 'T-OP030-BRT-0001' })
    expect(answer.statusCode, answer.body).toBe(200)
    const [event] = await eventsOf(seeded.draftShipmentId)
    expect(event!.payload).toEqual({ shipmentId: seeded.draftShipmentId, number: 'SEED-SH-0002', status: 'SHIPPED', hasNumber: true, /* B-OP-034 */ hasLink: false, salesOrderIds: [orderId()], partyId: seedUuid(ns, 'party:P1') })
    // The wall: the customer's id is on the event (for the live wall) and never in a live field; the row is the office's.
    expect(event!.partyId).toBe(seedUuid(ns, 'party:P1'))
    expect(event!.rowPartyId).toBeNull()
    const definition = EVENT_CATALOGUE.definitions.find((entry) => entry.type === 'shipment.tracking_changed')!
    expect(definition.live?.fields).toEqual(['shipmentId', 'number', 'status', 'salesOrderIds'])
    expect(definition.live?.fields).not.toContain('partyId')
    const written = await notesOf(event!)
    expect(written).toEqual([{ orderId: orderId(), messageId: expect.any(String) }])
    const lines = await linesOf(orderId())
    expect(lines).toEqual([{ bodyText: trackingLineOf({ shipment: 'SEED-SH-0002', carrier: 'Seed Express', number: 'T-OP030-BRT-0001' }, 'it'), direction: 'INTERNAL_NOTE', audience: 'OFFICE', authorKind: 'SYSTEM' }])
    // The handler run again (a retry) writes nothing more.
    await notesOf(event!)
    expect(await linesOf(orderId())).toHaveLength(1)
  })

  it('the same number again changes nothing; cleared: one more event and one more line', async () => {
    const same = await call('desk', 'PUT', tracking(seeded.draftShipmentId), { version: await versionOf(seeded.draftShipmentId), trackingNumber: 'T-OP030-BRT-0001' })
    expect(same.statusCode, same.body).toBe(200)
    expect(await eventsOf(seeded.draftShipmentId)).toHaveLength(1)
    // B-OS-022 (os-fx3): the goods left, so clearing the number the customer could read says why.
    const cleared = await call('desk', 'PUT', tracking(seeded.draftShipmentId), { version: await versionOf(seeded.draftShipmentId), trackingNumber: null, reason: 'The carrier withdrew the booking.' })
    expect(cleared.statusCode, cleared.body).toBe(200)
    const events = await eventsOf(seeded.draftShipmentId)
    expect(events.map((event) => event.payload.hasNumber)).toEqual([true, false])
    await notesOf(events[1]!)
    expect((await linesOf(orderId())).map((line) => line.bodyText)).toEqual([
      trackingLineOf({ shipment: 'SEED-SH-0002', carrier: 'Seed Express', number: 'T-OP030-BRT-0001' }, 'it'),
      trackingLineOf({ shipment: 'SEED-SH-0002', carrier: 'Seed Express', number: null }, 'it'),
    ])
  })

  it('refused as today: a shipment with carrier labels (LABELLED), a person without shipping.manage (403); nothing emitted', async () => {
    const labelled = await call('desk', 'PUT', tracking(seeded.shipmentId), { version: await versionOf(seeded.shipmentId), trackingNumber: 'T-OP030-X' })
    expect(labelled.statusCode, labelled.body).toBe(409)
    expect((labelled.json() as Json).error.issues[0].path).toBe('refusal/LABELLED')
    const viewer = await call('viewer', 'PUT', tracking(seeded.draftShipmentId), { version: await versionOf(seeded.draftShipmentId), trackingNumber: 'T-OP030-Y' })
    expect(viewer.statusCode).toBe(403)
    expect(await eventsOf(seeded.shipmentId)).toEqual([])
    expect(await eventsOf(seeded.draftShipmentId)).toHaveLength(2)
  })

  it('the line’s words: the shipment, its carrier and the number (or cleared), in the company’s language', () => {
    expect(trackingLineOf({ shipment: 'SH-0012', carrier: 'BRT', number: '123' }, 'en')).toBe('Tracking for SH-0012 (BRT): 123')
    expect(trackingLineOf({ shipment: 'SH-0012', carrier: 'BRT', number: '123' }, 'it')).toBe('Tracciamento di SH-0012 (BRT): 123')
    expect(trackingLineOf({ shipment: 'SH-0012', carrier: null, number: null }, 'en')).toBe('Tracking number of SH-0012 cleared.')
    expect(trackingLineOf({ shipment: 'SH-0012', carrier: 'BRT', number: null }, 'it')).toBe('Numero di tracciamento di SH-0012 (BRT) cancellato.')
  })
})

// ── B-OP-034 (order page plan N5, set C): the tracking link typed beside the number (https only), also after the goods left ──
describe('B-OP-034: the typed tracking link', () => {
  const put = async (body: Json) => call('desk', 'PUT', tracking(seeded.draftShipmentId), { version: await versionOf(seeded.draftShipmentId), ...body })
  const LINK = 'https://track.example.com/T-OP034-0001'

  it('typed with its number after the goods left: kept, audited before / after, the event says hasLink', async () => {
    const before = (await eventsOf(seeded.draftShipmentId)).length
    const answer = await put({ trackingNumber: 'T-OP034-0001', trackingUrl: LINK })
    expect(answer.statusCode, answer.body).toBe(200)
    expect((answer.json() as Json).shipment).toMatchObject({ status: 'SHIPPED', manualTrackingNumber: 'T-OP034-0001', manualTrackingUrl: LINK })
    const events = await eventsOf(seeded.draftShipmentId)
    expect(events).toHaveLength(before + 1)
    expect(events.at(-1)!.payload).toMatchObject({ hasNumber: true, hasLink: true })
    const [audit] = await admin(`SELECT before, after FROM "AuditLog" WHERE action = 'shipping.typeTrackingNumber' AND "recordId" = $1 ORDER BY at DESC, id DESC LIMIT 1`, [seeded.draftShipmentId])
    expect(audit).toMatchObject({ after: { manualTrackingNumber: 'T-OP034-0001', manualTrackingUrl: LINK } })
    // The number again with no link field: the link stays.
    const kept = await put({ trackingNumber: 'T-OP034-0001' })
    expect((kept.json() as Json).shipment.manualTrackingUrl).toBe(LINK)
  })

  it('refused in words: no number, not https, a name or password in it; nothing changes', async () => {
    for (const [body, message] of [
      [{ trackingNumber: null, trackingUrl: LINK }, 'A tracking link is typed only with its tracking number.'],
      [{ trackingNumber: 'T-OP034-0001', trackingUrl: 'http://track.example.com/T-1' }, 'A tracking link is an https address of 1 to 500 characters on one line, with no name or password in it.'],
      [{ trackingNumber: 'T-OP034-0001', trackingUrl: 'https://someone:secret@track.example.com/T-1' }, 'A tracking link is an https address of 1 to 500 characters on one line, with no name or password in it.'],
    ] as const) {
      const refused = await put(body)
      expect(refused.statusCode, refused.body).toBe(400)
      expect((refused.json() as Json).error.issues).toEqual([{ path: 'body/trackingUrl', message }])
    }
    expect((await admin(`SELECT "manualTrackingUrl" FROM "Shipment" WHERE id = $1`, [seeded.draftShipmentId]))[0]).toEqual({ manualTrackingUrl: LINK })
  })

  it("a customer's own portal reads it (row-level security), another customer never; cleared with its number", async () => {
    const read = (partyId: string) => database.withScope({ audience: 'partner', tenantId: T, actorId: newId(), partyId }, (client) => client.shipment.findMany({ where: { id: seeded.draftShipmentId }, select: { manualTrackingUrl: true } }))
    expect(await read(seedUuid(ns, 'party:P1'))).toEqual([{ manualTrackingUrl: LINK }])
    expect(await read(newId())).toEqual([])
    const cleared = await put({ trackingNumber: null, reason: 'Typed on the wrong shipment.' }) // B-OS-022 (os-fx3): a seen number says why
    expect(cleared.statusCode, cleared.body).toBe(200)
    expect((cleared.json() as Json).shipment).toMatchObject({ manualTrackingNumber: null, manualTrackingUrl: null })
    expect((await eventsOf(seeded.draftShipmentId)).at(-1)!.payload).toMatchObject({ hasNumber: false, hasLink: false })
  })
})
// ── end B-OP-034 ──

// ---- B-OS-015, B-OS-016 (order shipments tab; Owner D5; 13-backend §2): the expected arrival typed by hand where no carrier feed
// tracks it; delivered by hand over a carrier's labels, with a reason (DELIVERED stays final; a later carrier event never moves it) ----
describe('B-OS-016, B-OS-015: the expected arrival by hand; delivered by hand over the carrier’s labels', () => {
  const send = (session: string, method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `os-s2-${++keys}-${newId()}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
  const eta = (shipmentId: string) => `/shipping/shipments/${shipmentId}/eta`
  const events = (shipmentId: string) => `/shipping/shipments/${shipmentId}/own-transport/events`
  const deliveriesOf = async (orderId: string) => ((await send('deskOrders', 'GET', `/sales/orders/${orderId}/deliveries`)).json() as Json).shipments as Json[]

  beforeAll(() => {
    SESSIONS.deskOrders = { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['shipping.view', 'shipping.manage', 'orders.view'])] }
  })

  it('B-OS-016: typed on SEED-SH-0002 (a carrier booked by hand), changed with a reason, Set by hand on the order; never where labels feed it', async () => {
    const sh2 = seeded.draftShipmentId
    const first = new Date(Date.now() + 3 * 86_400_000).toISOString()
    const typed = await send('desk', 'PUT', eta(sh2), { version: await versionOf(sh2), expectedDeliveryAt: first })
    expect(typed.statusCode, typed.body).toBe(200)
    expect((typed.json() as Json).shipment.expectedDeliveryAt).toBe(first)
    // The customer reads it now: a change says why.
    const later = new Date(Date.now() + 5 * 86_400_000).toISOString()
    const noReason = await send('desk', 'PUT', eta(sh2), { expectedDeliveryAt: later })
    expect(noReason.statusCode).toBe(400)
    expect((noReason.json() as Json).error.issues[0].path).toBe('body/reason')
    const changed = await send('desk', 'PUT', eta(sh2), { expectedDeliveryAt: later, reason: 'The truck was held at the border.' })
    expect(changed.statusCode, changed.body).toBe(200)
    expect(await admin(`SELECT before->>'expectedDeliveryAt' AS before, after->>'expectedDeliveryAt' AS after, reason FROM "AuditLog" WHERE "recordId" = $1 AND action = 'shipping.etaTyped' ORDER BY at, id`, [sh2])).toEqual([
      { before: null, after: first, reason: null },
      { before: first, after: later, reason: 'The truck was held at the border.' },
    ])
    // The order's deliveries read says it was set by hand.
    expect((await deliveriesOf(seeded.quality.serialSalesOrderId)).find((row) => row.id === sh2)).toMatchObject({ expectedDeliveryAt: later, etaByHand: true })
    // SEED-SH-0001's carrier labels feed its arrival: nothing to type; a viewer is refused.
    const fed = await send('desk', 'PUT', eta(seeded.shipmentId), { expectedDeliveryAt: later })
    expect(fed.statusCode).toBe(409)
    expect((fed.json() as Json).error.issues[0].path).toBe('refusal/CARRIER_FED')
    expect((await send('viewer', 'PUT', eta(sh2), { expectedDeliveryAt: null, reason: 'Not known any more.' })).statusCode).toBe(403)
  })

  it('B-OS-015: SEED-SH-0001 (carrier labels) delivered by hand with its reason; without one 400; other statuses stay the carrier’s', async () => {
    const sh1 = seeded.shipmentId
    const reason = 'The customer signed our own delivery note.'
    // The seed dates its journey ahead of the calendar: it left yesterday here (a typed delivery is never before the goods left).
    await admin(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE "Shipment" SET "shippedAt" = now() - interval '1 day', "packedAt" = now() - interval '2 days' WHERE id = '${sh1}'; COMMIT;`)
    const noReason = await send('desk', 'POST', events(sh1), { status: 'DELIVERED' })
    expect(noReason.statusCode).toBe(400)
    expect((noReason.json() as Json).error.issues[0].path).toBe('body/reason')
    const news = await send('desk', 'POST', events(sh1), { status: 'IN_TRANSIT', reason })
    expect(news.statusCode).toBe(409)
    expect((news.json() as Json).error.issues[0].path).toBe('refusal/CARRIER_TRACKED')
    expect((await send('viewer', 'POST', events(sh1), { status: 'DELIVERED', reason })).statusCode).toBe(403)
    // The shipment's view says the hand move is open (with a reason) while the carrier's news stays closed.
    const view = (await send('desk', 'GET', `/shipping/shipments/${sh1}/own-transport`)).json() as Json
    expect(view.may).toMatchObject({ status: { allowed: false, refusal: { code: 'CARRIER_TRACKED' } }, endByHand: { allowed: true }, eta: { allowed: false, refusal: { code: 'CARRIER_FED' } } })

    const delivered = await send('desk', 'POST', events(sh1), { version: await versionOf(sh1), status: 'DELIVERED', reason })
    expect(delivered.statusCode, delivered.body).toBe(201)
    expect((delivered.json() as Json).recorded.moved).toBe('DELIVERED')
    expect((delivered.json() as Json).shipment.status).toBe('DELIVERED')
    expect(await admin(`SELECT after->>'overrode' AS overrode, reason FROM "AuditLog" WHERE "recordId" = $1 AND action = 'shipping.trackingMove'`, [sh1])).toEqual([{ overrode: 'true', reason }])
    expect(await admin(`SELECT description FROM "TrackingEvent" WHERE "shipmentId" = $1 AND source = 'MANUAL' AND status = 'DELIVERED'`, [sh1])).toEqual([{ description: reason }])
    const row = () => deliveriesOf(seeded.quality.production.salesOrderId).then((rows) => rows.find((entry) => entry.id === sh1))
    expect(await row()).toMatchObject({ status: 'DELIVERED', deliveredVia: 'TYPED', byHand: { reason, overrode: true }, carrierLater: null })

    // The carrier reports later: appended, never a move (DELIVERED stays final); the read says what it said.
    await admin(
      `INSERT INTO "TrackingEvent" (id, "tenantId", "siteId", "partyId", "shipmentId", status, description, "occurredAt", "recordedAt", source, "externalEventId") SELECT $1, "tenantId", "siteId", "partyId", id, 'RETURNED', 'Made-up carrier words: back to sender.', now(), now() + interval '1 second', 'WEBHOOK', 'os-s2-later' FROM "Shipment" WHERE id = $2`,
      [newId(), sh1],
    )
    expect(await admin(`SELECT status::text AS status FROM "Shipment" WHERE id = $1`, [sh1])).toEqual([{ status: 'DELIVERED' }])
    expect(await row()).toMatchObject({ deliveredVia: 'TYPED', carrierLater: 'RETURNED' })
    const again = await send('desk', 'POST', events(sh1), { status: 'RETURNED', reason })
    expect(again.statusCode).toBe(409)
    expect((again.json() as Json).error.issues[0].path).toBe('refusal/ARRIVED')
  })
})
// ---- end B-OS-015, B-OS-016

// ---- B-OS-022 (order shipments 1/1; Owner D4; 13-backend §3): a tracking number typed by hand per parcel, in the one tracking
// command on the shipment's version. SEED-SH-0002 (left, a carrier booked by hand, its own number cleared above) travels in three
// parcels here: two are added past the guards (the command is what is tested). ----
describe('B-OS-022: a tracking number typed by hand per parcel', () => {
  const sh2 = () => seeded.draftShipmentId
  const parcelIds: string[] = []
  const LINK = 'https://track.example.com/AWB-OS022-0001'
  const put = async (body: Json, session = 'desk') => call(session, 'PUT', tracking(sh2()), { version: await versionOf(sh2()), ...body })
  const typedOf = () => admin<{ seq: number; number: string | null; url: string | null }>(`SELECT seq, "manualTrackingNumber" AS number, "manualTrackingUrl" AS url FROM "Parcel" WHERE "shipmentId" = $1 AND seq <= 3 ORDER BY seq`, [sh2()])
  const parcelAudits = () => admin<{ before: Json; after: Json; reason: string | null }>(`SELECT before, after, reason FROM "AuditLog" WHERE action = 'shipping.typeParcelTracking' AND "recordId"::text = $1 ORDER BY at, id`, [sh2()])
  const issuesOf = (answer: { json: () => unknown }) => (answer.json() as Json).error.issues as Json[]

  beforeAll(async () => {
    parcelIds.push(seeded.draftParcelId, newId(), newId())
    await admin(
      `BEGIN; SET LOCAL session_replication_role = replica;
       INSERT INTO "Parcel" (id, "tenantId", "siteId", "partyId", "shipmentId", seq) SELECT p.id::uuid, s."tenantId", s."siteId", s."partyId", s.id, p.seq FROM "Shipment" s, (VALUES ('${parcelIds[1]}', 2), ('${parcelIds[2]}', 3)) AS p(id, seq) WHERE s.id = '${sh2()}';
       COMMIT;`,
    )
  })

  it('three parcels typed after the goods left: one command, one audit row with every parcel before → after, the event counts them', async () => {
    const before = (await eventsOf(sh2())).length
    const answer = await put({
      parcels: [
        { parcelId: parcelIds[0], trackingNumber: 'AWB-OS022-0001', trackingUrl: LINK },
        { parcelId: parcelIds[1], trackingNumber: 'AWB-OS022-0002' },
        { parcelId: parcelIds[2], trackingNumber: ' AWB-OS022-0003 ' },
      ],
    })
    expect(answer.statusCode, answer.body).toBe(200)
    const view = answer.json() as Json
    // The shipment's own number is kept (none: cleared above); each parcel shows the number typed for it, none a label.
    expect(view.shipment.manualTrackingNumber).toBeNull()
    expect((view.parcels as Json[]).map((parcel) => [parcel.seq, parcel.label, parcel.typed, parcel.may.allowed])).toEqual([
      [1, null, { number: 'AWB-OS022-0001', url: LINK }, true],
      [2, null, { number: 'AWB-OS022-0002', url: null }, true],
      [3, null, { number: 'AWB-OS022-0003', url: null }, true],
    ])
    expect(await typedOf()).toEqual([
      { seq: 1, number: 'AWB-OS022-0001', url: LINK },
      { seq: 2, number: 'AWB-OS022-0002', url: null },
      { seq: 3, number: 'AWB-OS022-0003', url: null },
    ])
    const row = (seq: number, number: string | null, url: string | null) => ({ parcelId: parcelIds[seq - 1], seq, manualTrackingNumber: number, manualTrackingUrl: url })
    expect(await parcelAudits()).toEqual([
      {
        before: { parcels: [row(1, null, null), row(2, null, null), row(3, null, null)] },
        after: { parcels: [row(1, 'AWB-OS022-0001', LINK), row(2, 'AWB-OS022-0002', null), row(3, 'AWB-OS022-0003', null)] },
        reason: null,
      },
    ])
    const events = await eventsOf(sh2())
    expect(events).toHaveLength(before + 1)
    expect(events.at(-1)!.payload).toMatchObject({ status: 'SHIPPED', hasNumber: false, hasLink: false, parcels: 3 })
    // The office line on the order's thread names the parcels' numbers (the customer is not mailed).
    await notesOf(events.at(-1)!)
    const line = (await linesOf(seeded.quality.serialSalesOrderId)).at(-1)!
    expect(line.bodyText).toBe('Tracciamento di SEED-SH-0002 (Seed Express): collo 1: AWB-OS022-0001, collo 2: AWB-OS022-0002, collo 3: AWB-OS022-0003')
    expect(line.audience).toBe('OFFICE')
  })

  it('the order read shows each parcel TYPED (never live); the same numbers again change nothing', async () => {
    const { order } = (await call('deskOrders', 'GET', `/sales/orders/${seeded.quality.serialSalesOrderId}`)).json() as Json
    const row = (order.chain.shipments as Json[]).find((entry) => entry.id === sh2())!
    expect((row.parcels as Json[]).filter((parcel) => parcel.seq <= 3).map((parcel) => [parcel.seq, parcel.number, parcel.url, parcel.source, parcel.live])).toEqual([
      [1, 'AWB-OS022-0001', LINK, 'TYPED', false],
      [2, 'AWB-OS022-0002', null, 'TYPED', false],
      [3, 'AWB-OS022-0003', null, 'TYPED', false],
    ])
    const events = (await eventsOf(sh2())).length
    const same = await put({ parcels: [{ parcelId: parcelIds[1], trackingNumber: 'AWB-OS022-0002' }] })
    expect(same.statusCode, same.body).toBe(200)
    expect(await eventsOf(sh2())).toHaveLength(events)
    expect(await parcelAudits()).toHaveLength(1)
  })

  it('a number the customer could read changes or is cleared only with a reason; then audited with it', async () => {
    const changeOnly = await put({ parcels: [{ parcelId: parcelIds[1], trackingNumber: 'AWB-OS022-0020' }] })
    expect(changeOnly.statusCode, changeOnly.body).toBe(400)
    expect(issuesOf(changeOnly)[0]!.path).toBe('body/reason')
    const clearOnly = await put({ parcels: [{ parcelId: parcelIds[2], trackingNumber: null }], reason: 'no' })
    expect(clearOnly.statusCode, clearOnly.body).toBe(400)
    expect(issuesOf(clearOnly)[0]!.path).toBe('body/reason')
    expect((await typedOf()).map((parcel) => parcel.number)).toEqual(['AWB-OS022-0001', 'AWB-OS022-0002', 'AWB-OS022-0003'])
    const reason = 'The courier gave a new air waybill for the second parcel.'
    const changed = await put({ parcels: [{ parcelId: parcelIds[1], trackingNumber: 'AWB-OS022-0020' }, { parcelId: parcelIds[2], trackingNumber: null }], reason })
    expect(changed.statusCode, changed.body).toBe(200)
    expect((await typedOf()).map((parcel) => parcel.number)).toEqual(['AWB-OS022-0001', 'AWB-OS022-0020', null])
    expect((await parcelAudits()).at(-1)).toEqual({
      before: { parcels: [{ parcelId: parcelIds[1], seq: 2, manualTrackingNumber: 'AWB-OS022-0002', manualTrackingUrl: null }, { parcelId: parcelIds[2], seq: 3, manualTrackingNumber: 'AWB-OS022-0003', manualTrackingUrl: null }] },
      after: { parcels: [{ parcelId: parcelIds[1], seq: 2, manualTrackingNumber: 'AWB-OS022-0020', manualTrackingUrl: null }, { parcelId: parcelIds[2], seq: 3, manualTrackingNumber: null, manualTrackingUrl: null }] },
      reason,
    })
    expect((await eventsOf(sh2())).at(-1)!.payload).toMatchObject({ parcels: 2 })
  })

  it('os-fx3: the shipment’s own consignment number the customer could read changes or is cleared only with a reason; audited with it', async () => {
    const consignment = async () => (await admin<{ number: string | null }>(`SELECT "manualTrackingNumber" AS number FROM "Shipment" WHERE id = $1`, [sh2()]))[0]!.number
    const lastAudit = async () => (await admin<{ before: Json | null; after: Json; reason: string | null }>(`SELECT before, after, reason FROM "AuditLog" WHERE action = 'shipping.typeTrackingNumber' AND "recordId"::text = $1 ORDER BY at DESC, id DESC LIMIT 1`, [sh2()]))[0]!
    // Typed for the first time after the goods left: no reason asked (the customer read none).
    const first = await put({ trackingNumber: 'AWB-OS022-C001' })
    expect(first.statusCode, first.body).toBe(200)
    expect(await consignment()).toBe('AWB-OS022-C001')
    // Changed or cleared: refused at body/reason without a reason of 3 to 500 characters, in the parcel's words; nothing changes.
    const changeOnly = await put({ trackingNumber: 'AWB-OS022-C002' })
    expect(changeOnly.statusCode, changeOnly.body).toBe(400)
    expect(issuesOf(changeOnly)).toEqual([{ path: 'body/reason', message: 'The customer could read this tracking number: say why it changes (3 to 500 characters).' }])
    const clearShort = await put({ trackingNumber: null, reason: 'no' })
    expect(clearShort.statusCode, clearShort.body).toBe(400)
    expect(issuesOf(clearShort)[0]!.path).toBe('body/reason')
    // With parcels sent as well (none changing), the consignment number alone still asks it.
    const withParcels = await put({ trackingNumber: 'AWB-OS022-C002', parcels: [{ parcelId: parcelIds[0], trackingNumber: 'AWB-OS022-0001' }] })
    expect(withParcels.statusCode, withParcels.body).toBe(400)
    expect(issuesOf(withParcels)[0]!.path).toBe('body/reason')
    expect(await consignment()).toBe('AWB-OS022-C001')
    // The link alone changing is no new number: no reason.
    const link = await put({ trackingNumber: 'AWB-OS022-C001', trackingUrl: 'https://track.example.com/AWB-OS022-C001' })
    expect(link.statusCode, link.body).toBe(200)
    // With the reason: changed, and the reason kept on the shipment's one audit row with the number before → after.
    const reason = 'The forwarder re-issued the air waybill.'
    const changed = await put({ trackingNumber: 'AWB-OS022-C002', reason })
    expect(changed.statusCode, changed.body).toBe(200)
    expect(await consignment()).toBe('AWB-OS022-C002')
    expect(await lastAudit()).toEqual({
      before: { manualTrackingNumber: 'AWB-OS022-C001', manualTrackingUrl: 'https://track.example.com/AWB-OS022-C001' },
      after: { manualTrackingNumber: 'AWB-OS022-C002', manualTrackingUrl: 'https://track.example.com/AWB-OS022-C001' },
      reason,
    })
    // Cleared with a reason (the shipment's own number back to none, as the other cases here read it).
    const cleared = await put({ trackingNumber: null, reason: 'The forwarder cancelled the air waybill.' })
    expect(cleared.statusCode, cleared.body).toBe(200)
    expect(await consignment()).toBeNull()
    expect(await lastAudit()).toMatchObject({ after: { manualTrackingNumber: null, manualTrackingUrl: null }, reason: 'The forwarder cancelled the air waybill.' })
  })

  it('refused in words: a parcel with a label (a TEST one too) PARCEL_LABELLED, a shipment with carrier labels LABELLED, another shipment’s parcel 404, a viewer 403', async () => {
    const testParcel = newId()
    await admin(
      `BEGIN; SET LOCAL session_replication_role = replica;
       INSERT INTO "Parcel" (id, "tenantId", "siteId", "partyId", "shipmentId", seq, "carrierParcelId", "trackingNumber") SELECT '${testParcel}'::uuid, "tenantId", "siteId", "partyId", id, 4, 'test:os022-4.v1', 'TEST-OS022-0004' FROM "Shipment" WHERE id = '${sh2()}';
       COMMIT;`,
    )
    try {
      const labelled = await put({ parcels: [{ parcelId: testParcel, trackingNumber: 'AWB-OS022-0004' }] })
      expect(labelled.statusCode, labelled.body).toBe(409)
      expect(issuesOf(labelled)).toEqual([{ path: 'refusal/PARCEL_LABELLED', message: 'Parcel 4: This parcel carries a label: its number comes from the label, never typed.' }])
      // The view says so per parcel; the shipment's own number may still be typed (a TEST label is no carrier's).
      const view = (await call('desk', 'GET', `/shipping/shipments/${sh2()}/own-transport`)).json() as Json
      expect((view.parcels as Json[]).find((parcel) => parcel.seq === 4)).toMatchObject({ label: { number: 'TEST-OS022-0004', test: true, url: null }, typed: null, may: { allowed: false, refusal: { code: 'PARCEL_LABELLED' } } })
      expect(view.may.track.allowed).toBe(true)
    } finally {
      await admin(`BEGIN; SET LOCAL session_replication_role = replica; DELETE FROM "Parcel" WHERE id = '${testParcel}'; COMMIT;`)
    }
    const sh1 = await call('desk', 'PUT', tracking(seeded.shipmentId), { version: await versionOf(seeded.shipmentId), parcels: [{ parcelId: seeded.parcelIds[0], trackingNumber: 'AWB-OS022-X' }] })
    expect(sh1.statusCode, sh1.body).toBe(409)
    expect(issuesOf(sh1)[0]!.path).toBe('refusal/LABELLED')
    const elsewhere = await put({ parcels: [{ parcelId: seeded.parcelIds[0], trackingNumber: 'AWB-OS022-X' }] })
    expect(elsewhere.statusCode, elsewhere.body).toBe(404)
    expect((await put({ parcels: [{ parcelId: parcelIds[0], trackingNumber: null }], reason: 'Not this one after all.' }, 'viewer')).statusCode).toBe(403)
    const twice = await put({ parcels: [{ parcelId: parcelIds[0], trackingNumber: 'A' }, { parcelId: parcelIds[0], trackingNumber: 'B' }] })
    expect(twice.statusCode).toBe(400)
    expect(issuesOf(twice)[0]!.path).toBe('body/parcels/1/parcelId')
    expect((await typedOf()).map((parcel) => parcel.number)).toEqual(['AWB-OS022-0001', 'AWB-OS022-0020', null])
  })
})
// ---- end B-OS-022
