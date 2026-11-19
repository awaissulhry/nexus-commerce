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
    const cleared = await call('desk', 'PUT', tracking(seeded.draftShipmentId), { version: await versionOf(seeded.draftShipmentId), trackingNumber: null })
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
    const cleared = await put({ trackingNumber: null })
    expect(cleared.statusCode, cleared.body).toBe(200)
    expect((cleared.json() as Json).shipment).toMatchObject({ manualTrackingNumber: null, manualTrackingUrl: null })
    expect((await eventsOf(seeded.draftShipmentId)).at(-1)!.payload).toMatchObject({ hasNumber: false, hasLink: false })
  })
})
// ── end B-OP-034 ──
