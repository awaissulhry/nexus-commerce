import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedAndon, type AndonSeed } from '../../../../../packages/factory-db/seed/andon'
import { seed as seedFiles } from '../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction, type ProductionSeed } from '../../../../../packages/factory-db/seed/production'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { findMarkers, markersOf, productionTwoBrands, twoBrandIds, twoBrandSessions, type Marker, type ProductionTwoBrands } from './testing/two-brands'

/**
 * B-PR-04a (production plan §2, the brand wall; 06-tree §0.6 PW-06 "Floor now, Dispatch, Cutting, Bundles, Scrap, Calls …:
 * rep-B sees only B rows and no line/site totals that mix brands"; the step's wall test "PW-06 (bundles, scans, calls)"). Owner
 * rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production unit,
 * should be able to see it all. And manage it all as well."
 *
 * On the local stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login),
 * the core, files, production, numbering and line-signals seeds (brand A = the seeds' P1: its in-progress work order with its
 * cut, bundles, scans, a correction asked and a refused scan of no work order), the production two-brand harness
 * (./testing/two-brands.ts: brand B's work order and a mixed one made before the rule), and, written by the test's admin pool, a
 * refused scan and a help call on A's work order and a help call on B's. Sessions: `office.all` (every customer), `office.p1`
 * and `office.p2` (one customer each), the same permissions. Every refusal toward a person limited to B is the one an unknown
 * id gets; every answer B's person got is scanned for A's names, codes, numbers and ids. Every name and number is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/production/floor-wall`.
 */

const ns = 'pr04-floor-wall'
const ids = twoBrandIds(ns)
const PERMISSIONS: Permission[] = [
  'workorders.view',
  'workorders.manage',
  'production.bundles',
  'production.bundles.view',
  'production.bundles.findings',
  'production.scan',
  'production.scan.correct',
  'production.calls.view',
  'production.calls.answer',
  'production.calls.manage',
]
const SESSIONS: Record<string, SessionContext> = twoBrandSessions(ids.tenantId, ids.a, ids.b, PERMISSIONS)

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let w: ProductionTwoBrands
let seeded: ProductionSeed
let andon: AndonSeed
/** What must never reach brand B: A's markers and the mixed work order (it holds a cell of A's). */
let aMarkers: Marker[]
/** Rows the test wrote: a refused scan and a help call on A's work order, a help call on B's. */
const made = { refusalA: newId(), callA: newId(), callB: newId() }
let bundleCodeA: string

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'
interface Seen {
  readonly url: string
  readonly status: number
  readonly body: unknown
}
const seenByB: Seen[] = []
async function call(session: string, method: Method, url: string, payload?: unknown): Promise<{ status: number; body: Json; raw: string }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': newId() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
  const body = response.headers['content-type']?.toString().startsWith('application/json') ? (response.json() as Json) : {}
  if (session === 'office.p2') seenByB.push({ url: `${method} ${url}`, status: response.statusCode, body: Object.keys(body).length > 0 ? body : response.body })
  return { status: response.statusCode, body, raw: response.body }
}
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const answer = await call(session, method, url, payload)
  expect(answer.status, `${method} ${url}: ${answer.raw}`).toBe(status)
  return answer.body
}
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]

/**
 * B's person meets A's record as an unknown one: the same status (404) and the same words as the address with a fresh id (or a
 * made-up code) in its place. `a` is the part of the address (or body) that names A's record.
 */
async function asUnknown(method: Method, url: string, a: string, payload?: unknown, unknown: string = newId()): Promise<void> {
  const swap = (value: unknown) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value).replaceAll(a, unknown)))
  const ofA = await call('office.p2', method, url, payload)
  const ofUnknown = await call('office.p2', method, url.replaceAll(a, unknown), swap(payload))
  expect(ofA.status, `${method} ${url}: ${ofA.raw}`).toBe(404)
  expect(ofUnknown.status, `${method} ${url} (unknown): ${ofUnknown.raw}`).toBe(404)
  // Each answer names its own request (requestId): the rest is word for word the same.
  const words = (body: Json) => JSON.stringify({ ...body, error: { ...body.error, requestId: '<request>' } })
  expect(words(ofA.body).replaceAll(a, '<asked>')).toBe(words(ofUnknown.body).replaceAll(unknown, '<asked>'))
}

beforeAll(async () => {
  db = await migratedDatabase('pr04_floor_wall')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  await seedFiles({ db: database, namespace: ns })
  seeded = await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  andon = await seedAndon({ db: database, namespace: ns })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  w = await productionTwoBrands({ db, database, app, namespace: ns })
  expect(w.a.partyId).toBe(ids.a)
  expect(seeded.workOrderId).not.toBe(w.a.workOrderId)
  expect((await admin<{ partyId: string }>(`SELECT "partyId" FROM "WorkOrder" WHERE id = $1`, [seeded.workOrderId]))[0]!.partyId).toBe(ids.a)
  bundleCodeA = (await admin<{ code: string }>(`SELECT code FROM "Bundle" WHERE id = $1`, [seeded.bundleIds[0]]))[0]!.code
  // A refused scan of A's bundle (the seeded one names no work order: a code not of this site), and a help call on A's work
  // order (open: SENT) and a solved one on B's (the seeded calls name none): copies of the seeds' rows, re-pointed.
  await admin(
    `BEGIN;
     SET LOCAL session_replication_role = replica;
     INSERT INTO "FloorScanRefusal" SELECT (jsonb_populate_record(NULL::"FloorScanRefusal", to_jsonb(r) || jsonb_build_object('id', $1::text, 'clientScanId', 'pr04-refused-a', 'workOrderId', $2::text, 'bundleId', $3::text, 'scanned', $4::text))).* FROM "FloorScanRefusal" r WHERE r.id = $5;
     INSERT INTO "HelpCall" SELECT (jsonb_populate_record(NULL::"HelpCall", to_jsonb(c) || jsonb_build_object('id', $6::text, 'workOrderId', $2::text, 'bundleId', $3::text, 'clientEventId', NULL, 'status', 'SENT', 'seenAt', NULL, 'seenById', NULL, 'onTheWayAt', NULL, 'onTheWayById', NULL, 'solvedAt', NULL, 'solvedById', NULL, 'resolutionCode', NULL, 'resolutionNote', NULL))).* FROM "HelpCall" c WHERE c.id = $8;
     INSERT INTO "HelpCall" SELECT (jsonb_populate_record(NULL::"HelpCall", to_jsonb(c) || jsonb_build_object('id', $7::text, 'workOrderId', $9::text, 'bundleId', NULL, 'clientEventId', NULL))).* FROM "HelpCall" c WHERE c.id = $8;
     COMMIT;`.replace(/\$(\d)/g, (_match, n: string) => `'${[made.refusalA, seeded.workOrderId, seeded.bundleIds[0], bundleCodeA, seeded.refusalId, made.callA, made.callB, andon.callIds[0], w.b.workOrderId][Number(n) - 1]}'`),
  )
  aMarkers = [...(await markersOf(db, w.a.partyId)), { label: 'mixed work order', text: w.mixed.number }, { label: 'mixed work order', text: w.mixed.workOrderId }]
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

const idsOf = (rows: Json[], key = 'id') => rows.map((row) => row[key] as string)

describe('bundles behind the wall (PW-06 bundles)', { timeout: 60_000 }, () => {
  it('the production unit sees A’s bundles; a person limited to A sees them too; B’s person sees none, on every list', async () => {
    const list = async (session: string, query = '') => idsOf((await ok(session, 'GET', `/production/bundles?limit=200${query}`)).bundles)
    expect(await list('office.all')).toEqual(expect.arrayContaining([...seeded.bundleIds]))
    expect(await list('office.all', `&partyId=${ids.a}`)).toEqual(expect.arrayContaining([...seeded.bundleIds]))
    const ofA = (rows: string[]) => rows.filter((id) => (seeded.bundleIds as readonly string[]).includes(id))
    expect(ofA(await list('office.all', `&partyId=${ids.b}`))).toEqual([])
    expect(await list('office.p1')).toEqual(expect.arrayContaining([...seeded.bundleIds]))
    expect(ofA(await list('office.p2'))).toEqual([])
    expect(await list('office.p2', `&partyId=${ids.a}`)).toEqual([])
    expect(await list('office.p2', `&q=${bundleCodeA}`)).toEqual([])
    // The tiles and the stuck list count and list only what the reader reaches: no total that mixes customers.
    const tiles = async (session: string, query = '') => (await ok(session, 'GET', `/production/bundles/tiles${query}`)) as Json
    expect((await tiles('office.all')).active).toBeGreaterThan(0)
    expect(await tiles('office.p2')).toMatchObject({ active: 0, stuck: 0, ticketsReplacedToday: 0, onHold: 0, atSubcontractor: 0 })
    expect((await tiles('office.p1')).active).toBe((await tiles('office.all', `?partyId=${ids.a}`)).active)
    expect(idsOf((await ok('office.p2', 'GET', '/production/bundles/stuck')).bundles)).toEqual([])
    // The floor's "cut, not in bundles" list (office too): A's work order by its number for the production unit only.
    const waiting = async (session: string) => idsOf((await ok(session, 'GET', `/production/bundles/work-orders?number=SEED-WO-0001`)).workOrders)
    expect(await waiting('office.all')).toEqual([seeded.workOrderId])
    expect(await waiting('office.p1')).toEqual([seeded.workOrderId])
    expect(await waiting('office.p2')).toEqual([])
    expect(idsOf((await ok('office.p2', 'GET', `/production/bundles/work-orders?partyId=${ids.a}`)).workOrders)).toEqual([])
    // Findings: only those of the work orders reached (none seeded; the answers hold no A row either way).
    expect((await ok('office.p2', 'GET', '/production/bundles/findings')).findings).toEqual([])
    await ok('office.p2', 'GET', '/production/bundles/findings/summary')
  })

  it('A’s bundle, its work order’s bundle pages and A’s ticket are not found for B’s person, as unknown ones; writes too', async () => {
    const bundle = seeded.bundleIds[0]
    const before = (await admin(`SELECT status, code, "replacedCodes", version FROM "Bundle" WHERE id = $1`, [bundle]))[0]
    expect((await ok('office.all', 'GET', `/production/bundles/${bundle}`)).bundle.id).toBe(bundle)
    expect((await ok('office.p1', 'GET', `/production/bundles/${bundle}`)).bundle.id).toBe(bundle)
    await asUnknown('GET', `/production/bundles/${bundle}`, bundle)
    for (const path of ['', '/bundles', '/sets']) await asUnknown('GET', `/production/bundles/work-orders/${seeded.workOrderId}${path}`, seeded.workOrderId)
    await asUnknown('GET', `/production/bundles/scan?code=${bundleCodeA}`, bundleCodeA, undefined, 'SEED-BN-9990')
    await asUnknown('GET', `/production/scans/card?code=${bundleCodeA}`, bundleCodeA, undefined, 'SEED-BN-9990')
    await asUnknown('POST', `/production/bundles/${bundle}/reprint`, bundle, { reason: 'B was here' })
    await asUnknown('POST', `/production/bundles/${bundle}/void`, bundle, { reason: 'B was here' })
    expect((await admin(`SELECT status, code, "replacedCodes", version FROM "Bundle" WHERE id = $1`, [bundle]))[0]).toEqual(before)
  })
})

describe('scans, corrections, refused scans and checks behind the wall (PW-06 scans)', { timeout: 60_000 }, () => {
  it('a work order’s scans, WIP and traced components: A’s are not found for B’s person', async () => {
    expect((await ok('office.all', 'GET', `/production/scans/work-orders/${seeded.workOrderId}/scans`)).scans.length).toBeGreaterThan(0)
    for (const path of ['/scans', '/wip']) await asUnknown('GET', `/production/scans/work-orders/${seeded.workOrderId}${path}`, seeded.workOrderId)
    await asUnknown('GET', `/production/guards/work-orders/${seeded.workOrderId}/components`, seeded.workOrderId)
    await asUnknown('GET', `/production/guards/flags/${seeded.scanIds[2]}`, seeded.scanIds[2])
    expect((await ok('office.p2', 'GET', '/production/guards/flags')).flags).toEqual([])
    expect((await ok('office.p2', 'GET', `/production/guards/flags?partyId=${ids.a}`)).flags).toEqual([])
  })

  it('correction requests: A’s ask is listed for the production unit and A’s person only; not found for B’s person, read or decided', async () => {
    const list = async (session: string, query = '') => idsOf((await ok(session, 'GET', `/production/scans/corrections?limit=200${query}`)).requests)
    expect(await list('office.all')).toContain(seeded.correctionRequestId)
    expect(await list('office.all', `&partyId=${ids.a}`)).toContain(seeded.correctionRequestId)
    expect(await list('office.all', `&partyId=${ids.b}`)).toEqual([])
    expect(await list('office.p1')).toContain(seeded.correctionRequestId)
    expect(await list('office.p2')).toEqual([])
    expect(await list('office.p2', `&partyId=${ids.a}`)).toEqual([])
    expect((await ok('office.p1', 'GET', `/production/scans/corrections/${seeded.correctionRequestId}`)).request.id).toBe(seeded.correctionRequestId)
    await asUnknown('GET', `/production/scans/corrections/${seeded.correctionRequestId}`, seeded.correctionRequestId)
    await asUnknown('POST', `/production/scans/corrections/${seeded.correctionRequestId}/approve`, seeded.correctionRequestId, {})
    await asUnknown('POST', `/production/scans/corrections/${seeded.correctionRequestId}/refuse`, seeded.correctionRequestId, { note: 'B was here' })
    expect((await admin(`SELECT status FROM "ScanCorrectionRequest" WHERE id = $1`, [seeded.correctionRequestId]))[0]).toEqual({ status: 'PENDING' })
  })

  it('refused scans: one of A’s work order only for who reaches A; one of no work order (it names no customer) for everyone at the site', async () => {
    const list = async (session: string, query = '') => idsOf((await ok(session, 'GET', `/production/scans/refusals?all=true&limit=200${query}`)).refusals)
    expect(await list('office.all')).toEqual(expect.arrayContaining([made.refusalA, seeded.refusalId]))
    expect(await list('office.p1')).toEqual(expect.arrayContaining([made.refusalA, seeded.refusalId]))
    const ofB = await list('office.p2')
    expect(ofB).toContain(seeded.refusalId)
    expect(ofB).not.toContain(made.refusalA)
    expect(await list('office.all', `&partyId=${ids.a}`)).toEqual([made.refusalA])
    expect(await list('office.p2', `&partyId=${ids.a}`)).toEqual([])
    expect((await ok('office.p2', 'GET', `/production/scans/refusals/${seeded.refusalId}`)).refusal.id).toBe(seeded.refusalId)
    expect((await ok('office.p1', 'GET', `/production/scans/refusals/${made.refusalA}`)).refusal.id).toBe(made.refusalA)
    await asUnknown('GET', `/production/scans/refusals/${made.refusalA}`, made.refusalA)
    await asUnknown('POST', `/production/scans/refusals/${made.refusalA}/discard`, made.refusalA)
    expect((await admin(`SELECT "discardedAt" FROM "FloorScanRefusal" WHERE id = $1`, [made.refusalA]))[0]).toEqual({ discardedAt: null })
  })
})

describe('help calls behind the wall (PW-06 calls)', { timeout: 60_000 }, () => {
  it('a call on A’s work order: listed, opened and counted only for who reaches A; B’s person keeps the machine calls and its own', async () => {
    const list = async (session: string, query = '') => idsOf((await ok(session, 'GET', `/production/calls?view=all&limit=200${query}`)).calls)
    expect(await list('office.all')).toEqual(expect.arrayContaining([made.callA, made.callB, ...andon.callIds]))
    expect(await list('office.p1')).toEqual(expect.arrayContaining([made.callA, ...andon.callIds]))
    expect(await list('office.p1')).not.toContain(made.callB)
    const ofB = await list('office.p2')
    expect(ofB).toEqual(expect.arrayContaining([made.callB, ...andon.callIds]))
    expect(ofB).not.toContain(made.callA)
    expect(await list('office.all', `&partyId=${ids.a}`)).toEqual([made.callA])
    expect(await list('office.p2', `&partyId=${ids.a}`)).toEqual([])
    expect((await ok('office.p1', 'GET', `/production/calls/${made.callA}`)).call.id).toBe(made.callA)
    expect((await ok('office.p2', 'GET', `/production/calls/${made.callB}`)).call.id).toBe(made.callB)
    await asUnknown('GET', `/production/calls/${made.callA}`, made.callA)
    for (const step of ['seen', 'on-the-way', 'solve']) await asUnknown('POST', `/production/calls/${made.callA}/${step}`, made.callA, {})
    // The counts and a day by the hour count only the calls the reader reaches: no total that mixes customers.
    const counts = async (session: string, query = '') => (await ok(session, 'GET', `/production/calls/counts${query}`)).tiles as Json
    expect((await counts('office.all', `?partyId=${ids.a}`)).OPEN).toBe(1)
    expect((await counts('office.all')).OPEN - (await counts('office.p2')).OPEN).toBe(1)
    expect(Object.values(await counts('office.p2', `?partyId=${ids.a}`)).every((n) => n === 0)).toBe(true)
    const [sent] = await admin<{ day: string }>(`SELECT to_char("sentAt" AT TIME ZONE 'Europe/Rome', 'YYYY-MM-DD') AS day FROM "HelpCall" WHERE id = $1`, [made.callA])
    const total = async (session: string) => ((await ok(session, 'GET', `/production/calls/by-hour?siteId=${w.siteId}&date=${sent!.day}`)).hours as Json[]).reduce((sum, hour) => sum + (hour.calls as number), 0)
    expect((await total('office.all')) - (await total('office.p2'))).toBe(1)
    // The line's board: B's person sees the line's open calls it reaches only.
    const [{ lineId }] = (await admin<{ lineId: string }>(`SELECT "lineId" FROM "HelpCall" WHERE id = $1`, [made.callA])) as [{ lineId: string }]
    expect(idsOf((await ok('office.all', 'GET', `/production/calls/board?lineId=${lineId}`)).calls)).toContain(made.callA)
    const board = await ok('office.p2', 'GET', `/production/calls/board?lineId=${lineId}`)
    expect(idsOf(board.calls)).not.toContain(made.callA)
    expect((board.stations as Json[]).flatMap((station) => idsOf(station.calls))).not.toContain(made.callA)
    // The routing grid's counts of a type's calls: only the calls reached.
    const used = async (session: string) => ((await ok(session, 'GET', `/production/calls/types?siteId=${w.siteId}`)).types as Json[]).reduce((sum, type) => sum + (type.usedCount as number), 0)
    expect((await used('office.all')) - (await used('office.p2'))).toBe(1)
    expect((await admin(`SELECT "seenAt", status FROM "HelpCall" WHERE id = $1`, [made.callA]))[0]).toEqual({ seenAt: null, status: 'SENT' })
  })
})

describe('what B’s person was answered (T00 scan)', () => {
  it('no answer B’s person got names A: not its names, code, orders, references, work orders or ids', () => {
    expect(seenByB.length).toBeGreaterThan(30)
    const found = seenByB.flatMap((entry) => findMarkers(entry.body, aMarkers).map((marker) => `${entry.url} → ${marker}`))
    expect(found).toEqual([])
  })
})
