import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Actor, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { EVENT_CATALOGUE } from '@nexus/factory-domain/events/catalogue'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { liveMessageFor } from '@nexus/factory-domain/events/live'
import { raiseUntil } from '@nexus/factory-domain/production-brand/health'
import { partnerLiveViewFor } from '@nexus/factory-domain/portal/notifications/live'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { productionTwoBrands, twoBrandIds, twoBrandSessions, type OfficeSession, type ProductionTwoBrands } from '../testing/two-brands'
import { planKeep, type KeeperRow } from './keeper'

/**
 * B-PR-35 — the factory raises an order's health by hand (production plan §4 "Health"; review fix R-10, decision D3), and its wall
 * test: "office.p2 cannot write P1's health (404); portal.p2 never reads the note". The Owner rule 2026-11-16: "One brand must not
 * be able to see anything related to any other brand. But we, as the production unit, should be able to see it all. And manage it
 * all as well."
 *
 * On a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security, BrandOrderProduction's guard and
 * the partner role's hidden columns are real), the core, files, production and numbering seeds and the production two-brand harness
 * (brand A = the seeds' P1 with its new order, brand B = the threads' second brand with SEED-SO-B001; B-PR-15's production states of
 * both orders). The computed health the keeper would store (B-PR-17) is set on both rows by the test's admin pool (ON_TRACK), so a
 * raise is allowed; the refusals set it LATE, AT_RISK and none.
 *
 *   - raise (PUT): At risk with a curated reason and the office's one-line note; until the set day + 7; ONE
 *     brand_production.health_changed {byNote: true} in B's name, without the note (and B's portal live view of it: the chip only);
 *     a second raise replaces the reason and note and tells nothing new; the audit row on the production state keeps the note.
 *   - read (GET) with the note for the office; clear (DELETE): the computed health again, told once; a second clear is refused.
 *   - refusals in words: 400 (reason, note), 409 (late, at risk, nothing left, no production state yet, a stale version), 403 (seen,
 *     not managed); nothing written, nothing told.
 *   - the wall: office.p2 on A's order — GET, PUT, DELETE — "Sales order not found.", as an unknown id, nothing written or told;
 *     office.p1 the same on B's; office.all manages both. B's portal role reads the chip and the reason of its own row, never the
 *     note nor who raised it, never A's row.
 *   - the keeper (B-PR-17 planKeep, pure) drops what the raise wrote on its seventh day, or once the computed health changes.
 *
 * Every name and note is made up. Run with `env -u FACTORY_REDIS_URL node scripts/factory/run-pg-tests.mjs modules/production/brand/health`.
 */

const ns = 'pr2i-health'
const ids = twoBrandIds(ns)
const actorId = seedUuid(ns, 'actor')
const PERMISSIONS: Permission[] = ['workorders.view', 'workorders.manage', 'production.brand.manage']
const SESSIONS: Record<string, OfficeSession> = {
  ...twoBrandSessions(ids.tenantId, ids.a, ids.b, PERMISSIONS),
  // Sees every customer's production, manages none of it.
  'office.viewer': { audience: 'office', tenantId: ids.tenantId, actorId: newId(), grants: [{ permissions: ['workorders.view'], companies: 'all', sites: 'all', parties: 'all' }] },
}
const NOTE = 'Made-up: the lining supplier moved its delivery by a week.'
const today = businessDate(new Date())

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let w: ProductionTwoBrands
let orderA = ''
let orderB = ''

type Json = Record<string, any>
type Method = 'GET' | 'PUT' | 'DELETE'
async function call(session: string, method: Method, url: string, payload?: unknown): Promise<{ status: number; body: Json; raw: string }> {
  const headers: Record<string, string> = method === 'GET' ? { 'x-test-session': session } : { 'x-test-session': session, 'idempotency-key': newId() }
  const response = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) })
  const body = response.headers['content-type']?.toString().startsWith('application/json') ? (response.json() as Json) : {}
  return { status: response.statusCode, body, raw: response.body }
}
async function ok(session: string, method: Method, url: string, payload?: unknown): Promise<Json> {
  const answer = await call(session, method, url, payload)
  expect(answer.status, `${method} ${url}: ${answer.raw.slice(0, 500)}`).toBe(200)
  return answer.body
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<string> {
  const answer = await call(session, method, url, payload)
  expect(answer.status, `${method} ${url}: ${answer.raw.slice(0, 500)}`).toBe(status)
  return String(answer.body.error?.message ?? answer.raw)
}
const healthUrl = (orderId: string) => `/production/brand-orders/${orderId}/health`
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
const stateOf = (orderId: string) =>
  one<Json>(`SELECT id, health::text AS health, "healthSet"::text AS "healthSet", "healthReasonCode"::text AS "reasonCode", "healthNote" AS note, "healthSetById" AS "setById", "healthSetUntil"::text AS until, version FROM "BrandOrderProduction" WHERE key = $1`, [`brand-production:${orderId}`])
const setComputed = (orderId: string, health: string | null) => admin(`UPDATE "BrandOrderProduction" SET health = $2::"BrandHealth", "healthAt" = now() WHERE key = $1`, [`brand-production:${orderId}`, health])

interface Told {
  readonly id: string
  readonly subject: string
  readonly payload: Json
  readonly envelope: EventEnvelope
}
async function told(): Promise<Told[]> {
  const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'brand_production.health_changed' ORDER BY "occurredAt", id`, [ids.tenantId])
  return rows.map((row) => ({
    id: row.id,
    subject: row.subject,
    payload: row.payload as Json,
    envelope: { eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload },
  }))
}
const toldSince = async (before: readonly Told[]): Promise<Told[]> => {
  const seen = new Set(before.map((event) => event.id))
  return (await told()).filter((event) => !seen.has(event.id))
}
/** A partner viewer of a customer with the production read (as the portal's live channel checks it). */
const partnerOf = (partyId: string): Actor => ({ audience: 'partner', tenantId: ids.tenantId, partyId, grants: [{ permissions: ['portal.production.view'], companies: 'all', sites: 'all', parties: [partyId] }] })

beforeAll(async () => {
  db = await migratedDatabase('pr2i_brand_health')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  await seedFiles({ db: database, namespace: ns })
  await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  w = await productionTwoBrands({ db, database, app, namespace: ns })
  expect(w.a.partyId).toBe(ids.a)
  expect(w.b.partyId).toBe(ids.b)
  orderA = w.a.salesOrderId
  orderB = w.b.salesOrderId
  // The computed health the keeper would have stored: on track.
  await setComputed(orderA, 'ON_TRACK')
  await setComputed(orderB, 'ON_TRACK')
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('the factory raises an order’s health to At risk (production.brand.manage)', { timeout: 60_000 }, () => {
  it('raise: At risk with a curated reason and the office’s note; the customer is told the chip and never the note', async () => {
    const before = await told()
    const version = (await stateOf(orderB)).version as number
    const { health } = await ok('office.all', 'PUT', healthUrl(orderB), { reasonCode: 'MATERIAL_LATE', note: `  ${NOTE}  ` })
    expect(health).toMatchObject({
      orderId: orderB,
      number: 'SEED-SO-B001',
      partyId: w.b.partyId,
      kept: true,
      computed: 'ON_TRACK',
      health: 'AT_RISK',
      reasonCode: 'MATERIAL_LATE',
      raise: { reasonCode: 'MATERIAL_LATE', note: NOTE, setBy: null, until: plusDays(today, 7), stands: true },
      waitingOn: 'US',
      version: version + 1,
    })
    expect(health.raise.until).toBe(raiseUntil(today))
    expect(await stateOf(orderB)).toMatchObject({ health: 'ON_TRACK', healthSet: 'AT_RISK', reasonCode: 'MATERIAL_LATE', note: NOTE, setById: SESSIONS['office.all']!.actorId, until: plusDays(today, 7) })

    const events = await toldSince(before)
    expect(events).toHaveLength(1)
    expect(events[0]!.subject).toBe(orderB)
    expect(events[0]!.payload).toEqual({ orderId: orderB, partyId: w.b.partyId, health: 'AT_RISK', previous: 'ON_TRACK', byNote: true })
    expect(JSON.stringify(events[0]!.envelope)).not.toContain('lining supplier')
    // B's portal live channel: the chip only; A's portal: nothing.
    const message = liveMessageFor(events[0]!.envelope, EVENT_CATALOGUE.get(events[0]!.envelope.type, events[0]!.envelope.version))!
    expect(partnerLiveViewFor(message, partnerOf(w.b.partyId), EVENT_CATALOGUE)?.fields).toEqual({ orderId: orderB, partyId: w.b.partyId, health: 'AT_RISK' })
    expect(partnerLiveViewFor(message, partnerOf(w.a.partyId), EVENT_CATALOGUE)).toBeNull()

    // The office's history keeps the note (the audit is the office's; the partner role reads none of it).
    const audit = await admin<{ after: Json; reason: string }>(`SELECT after, reason FROM "AuditLog" WHERE "recordType" = 'BrandOrderProduction' AND "recordId" = $1 AND action = 'production.raiseBrandHealth'`, [(await stateOf(orderB)).id])
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ after: { salesOrderId: orderB, raised: true, health: 'AT_RISK', reasonCode: 'MATERIAL_LATE', note: NOTE }, reason: 'Raised to At risk: MATERIAL_LATE.' })
  })

  it('the office reads it (the note too); a second raise replaces reason and note, starts its days again and tells nothing new', async () => {
    expect((await ok('office.p2', 'GET', healthUrl(orderB))).health).toMatchObject({ health: 'AT_RISK', reasonCode: 'MATERIAL_LATE', raise: { note: NOTE, stands: true } })
    const before = await told()
    const { health } = await ok('office.all', 'PUT', healthUrl(orderB), { reasonCode: 'CAPACITY' })
    expect(health).toMatchObject({ health: 'AT_RISK', reasonCode: 'CAPACITY', raise: { reasonCode: 'CAPACITY', note: null, until: plusDays(today, 7) } })
    expect(await toldSince(before)).toEqual([])
  })

  it('clear: the computed health counts again, told once; a second clear is refused in words', async () => {
    const before = await told()
    const { health } = await ok('office.all', 'DELETE', healthUrl(orderB))
    expect(health).toMatchObject({ computed: 'ON_TRACK', health: 'ON_TRACK', reasonCode: null, raise: null })
    expect(await stateOf(orderB)).toMatchObject({ healthSet: null, reasonCode: null, note: null, setById: null, until: null })
    const events = await toldSince(before)
    expect(events.map((event) => event.payload)).toEqual([{ orderId: orderB, partyId: w.b.partyId, health: 'ON_TRACK', previous: 'AT_RISK', byNote: true }])
    expect(await refused('office.all', 'DELETE', healthUrl(orderB), undefined, 409)).toMatch(/No raise stands on this order/)
  })

  it('refused in words: a reason not in the list, a note of two lines or too long (400); late, at risk, nothing left, no production state, a stale version (409); nothing written or told', async () => {
    const before = await told()
    const state = await stateOf(orderB)
    await refused('office.all', 'PUT', healthUrl(orderB), { reasonCode: 'EARLIER' }, 400)
    expect(await refused('office.all', 'PUT', healthUrl(orderB), { reasonCode: 'QUALITY', note: 'Made-up first line\nand a second one' }, 400)).toMatch(/one line/)
    await refused('office.all', 'PUT', healthUrl(orderB), { reasonCode: 'QUALITY', note: 'x'.repeat(201) }, 400)
    for (const [computed, words] of [['LATE', /already late/], ['AT_RISK', /already at risk/], [null, /Nothing is left to make/]] as const) {
      await setComputed(orderB, computed)
      expect(await refused('office.all', 'PUT', healthUrl(orderB), { reasonCode: 'QUALITY' }, 409), String(computed)).toMatch(words)
    }
    await setComputed(orderB, 'ON_TRACK')
    expect(await refused('office.all', 'PUT', healthUrl(orderB), { reasonCode: 'QUALITY', version: state.version - 1 }, 409)).toMatch(/changed since it was read/)
    expect(await refused('office.all', 'DELETE', `${healthUrl(orderB)}?version=${state.version - 1}`, undefined, 409)).toMatch(/changed since it was read/)
    // A confirmed order of B the keeper has not kept yet: no production state to raise.
    const fresh = newId()
    await database.withScope({ audience: 'office', tenantId: ids.tenantId, actorId }, (client) =>
      client.salesOrder.create({
        data: { id: fresh, companyId: w.companyId, partyId: w.b.partyId, number: `T-PR35-SO-${fresh.slice(-6)}`, customerRef: `T-PR35-PO-${fresh.slice(-6)}`, status: 'CONFIRMED', orderDate: new Date('2026-11-05T00:00:00.000Z'), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer' }, shipTo: { name: 'Made-up workshop' }, promiseDate: new Date('2026-12-18T00:00:00.000Z') },
        select: { id: true },
      }),
    )
    expect(await refused('office.all', 'PUT', healthUrl(fresh), { reasonCode: 'QUALITY' }, 409)).toMatch(/no production state yet/)
    expect((await ok('office.all', 'GET', healthUrl(fresh))).health).toMatchObject({ orderId: fresh, kept: false, computed: null, health: null, raise: null, version: null })
    expect(await stateOf(orderB)).toMatchObject({ healthSet: null, version: state.version })
    expect(await toldSince(before)).toEqual([])
  })

  it('a person who sees the customer’s production but does not manage it is forbidden to raise or clear; the read is open to it', async () => {
    await refused('office.viewer', 'PUT', healthUrl(orderB), { reasonCode: 'QUALITY' }, 403)
    await refused('office.viewer', 'DELETE', healthUrl(orderB), undefined, 403)
    expect((await ok('office.viewer', 'GET', healthUrl(orderB))).health).toMatchObject({ orderId: orderB, health: 'ON_TRACK' })
  })
})

describe('the wall: office.p2 cannot write P1’s health (404); portal.p2 never reads the note', { timeout: 60_000 }, () => {
  it('office.p2 on A’s order: GET, PUT and DELETE are not found, in the words of an unknown id; nothing written or told', async () => {
    const before = await told()
    const stateA = await stateOf(orderA)
    for (const orderId of [orderA, newId()]) {
      expect(await refused('office.p2', 'GET', healthUrl(orderId), undefined, 404)).toBe('Sales order not found.')
      expect(await refused('office.p2', 'PUT', healthUrl(orderId), { reasonCode: 'CAPACITY', note: 'Made-up: B was here.' }, 404)).toBe('Sales order not found.')
      expect(await refused('office.p2', 'DELETE', healthUrl(orderId), undefined, 404)).toBe('Sales order not found.')
    }
    // And the other way round: a person limited to A meets none of B's.
    expect(await refused('office.p1', 'PUT', healthUrl(orderB), { reasonCode: 'CAPACITY' }, 404)).toBe('Sales order not found.')
    expect(await stateOf(orderA)).toEqual(stateA)
    expect((await toldSince(before)).filter((event) => event.subject === orderA)).toEqual([])
    // The production unit manages both.
    expect((await ok('office.all', 'PUT', healthUrl(orderA), { reasonCode: 'TRANSPORT' })).health).toMatchObject({ partyId: w.a.partyId, health: 'AT_RISK' })
    expect((await ok('office.all', 'DELETE', healthUrl(orderA))).health).toMatchObject({ health: 'ON_TRACK', raise: null })
  })

  it('B’s portal role reads the chip and the reason of its own order — never the note, never who raised it, never A’s', async () => {
    await ok('office.all', 'PUT', healthUrl(orderA), { reasonCode: 'PLANNING', note: 'Made-up: A only, never for B.' })
    await ok('office.all', 'PUT', healthUrl(orderB), { reasonCode: 'MATERIAL_LATE', note: NOTE })
    const portalB = { audience: 'partner' as const, tenantId: ids.tenantId, actorId: w.second.userId, partyId: w.b.partyId }
    const rows = await database.withScope(portalB, (client) => client.$queryRawUnsafe<Json[]>(`SELECT "salesOrderId"::text AS "order", health::text AS health, "healthSet"::text AS raised, "healthReasonCode"::text AS reason FROM "BrandOrderProduction"`))
    expect(rows).toEqual([{ order: orderB, health: 'ON_TRACK', raised: 'AT_RISK', reason: 'MATERIAL_LATE' }])
    expect(JSON.stringify(rows)).not.toContain('lining supplier')
    for (const column of ['healthNote', 'healthSetById']) {
      await expect(database.withScope(portalB, (client) => client.$queryRawUnsafe(`SELECT "${column}" FROM "BrandOrderProduction" LIMIT 1`)), column).rejects.toThrow(/permission denied/)
    }
    expect(await database.withScope(portalB, (client) => client.$queryRawUnsafe<Json[]>(`SELECT id FROM "BrandOrderProduction" WHERE "salesOrderId" = '${orderA}'::uuid`))).toEqual([])
  })
})

describe('the keeper drops what the raise wrote (B-PR-17 planKeep, pure)', () => {
  const row = (until: string): KeeperRow => ({
    id: newId(),
    partyId: ids.b,
    salesOrderId: newId(),
    stage: 'PREPARING',
    health: 'ON_TRACK',
    healthSet: 'AT_RISK',
    healthReasonCode: 'CAPACITY',
    healthSetUntil: until,
    waitingOn: 'US',
    waitingSince: new Date('2026-11-10T08:00:00.000Z'),
    version: 3,
  })
  const keep = (at: string, computed: 'ON_TRACK' | 'NO_DATE') => {
    const kept = row(raiseUntil(today))
    return planKeep({ row: kept, target: { stage: 'PREPARING', computed, waiting: { on: 'US', since: kept.waitingSince } }, now: new Date(), today: at })!
  }

  it('it stands up to the sixth day, drops on the seventh (the customer is told by the drop), and drops at once when the computed health changes', () => {
    const standing = keep(plusDays(today, 6), 'ON_TRACK')
    expect(standing.data).toEqual({})
    expect(standing.healthChanged).toBeNull()
    expect(keep(plusDays(today, 7), 'ON_TRACK')).toMatchObject({ data: { raiseDropped: true }, healthChanged: { health: 'ON_TRACK', previous: 'AT_RISK', byNote: true } })
    expect(keep(plusDays(today, 1), 'NO_DATE')).toMatchObject({ data: { raiseDropped: true, health: 'NO_DATE' }, healthChanged: { health: 'NO_DATE', previous: 'AT_RISK', byNote: false } })
  })
})
