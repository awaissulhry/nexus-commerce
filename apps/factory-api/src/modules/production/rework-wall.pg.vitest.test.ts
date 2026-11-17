import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedCostActuals, type CostActualsSeed } from '../../../../../packages/factory-db/seed/cost-actuals'
import { seed as seedCutting, type CuttingSeed } from '../../../../../packages/factory-db/seed/cutting'
import { seed as seedFiles } from '../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction, type ProductionSeed } from '../../../../../packages/factory-db/seed/production'
import { seed as seedSchedule, type ScheduleSeed } from '../../../../../packages/factory-db/seed/schedule'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { findMarkers, markersOf, productionTwoBrands, twoBrandIds, twoBrandSessions, type Marker, type ProductionTwoBrands } from './testing/two-brands'

/**
 * B-PR-05 (production plan §2, the brand wall; 06-tree §0.6 PW-06 "… Scrap …: rep-B sees only B rows and no line/site totals that
 * mix brands"; the step's wall test "PW-06 (rework, scrap, kits, picking, cost)"). Owner rule 2026-11-16: "One brand must not be
 * able to see anything related to any other brand. But we, as the production unit, should be able to see it all. And manage it
 * all as well."
 *
 * On the local stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login), the
 * core, files, production, numbering, schedule, cutting-room and cost seeds (brand A = the seeds' P1: its in-progress work order
 * with its scans, a scrap waiting over the limit, its kit and the hide issued to it, its rework and recut request, its recut
 * ticket, its garments sent to second quality, and a costed work order with its ledger) and the production two-brand harness
 * (./testing/two-brands.ts: brand B's work order and a mixed one made before the rule). Sessions: `office.all` (every customer),
 * `office.p1` and `office.p2` (one customer each), the same permissions. Every refusal toward a person limited to B is the one
 * an unknown id gets; every answer B's person got is scanned for A's names, codes, numbers and ids. Every name and number is
 * made up. Run with `node scripts/factory/run-pg-tests.mjs modules/production/rework-wall`.
 */

const ns = 'pr05-rework-wall'
const ids = twoBrandIds(ns)
const PERMISSIONS: Permission[] = [
  'workorders.view',
  'workorders.manage',
  'production.rework',
  'production.scrap',
  'production.scrap.view',
  'production.scrap.approve',
  'production.scrap.overLimit',
  'production.downgrade',
  'production.extraops.add',
  'production.finish',
  'production.serials',
  'production.cut',
  'production.cutting.view',
  'production.recuts',
  'inventory.issue',
  'inventory.stock.view',
  'inventory.reserve',
  'inventory.reverse',
  'costing.view',
  'costing.ledger.manage',
  // The cost grain: the costing reads show their money (the stock's value tile).
  'money.cost',
]
const SESSIONS: Record<string, SessionContext> = twoBrandSessions(ids.tenantId, ids.a, ids.b, PERMISSIONS)

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let w: ProductionTwoBrands
let seeded: ProductionSeed
let schedule: ScheduleSeed
let cutting: CuttingSeed
let costs: CostActualsSeed
/** What must never reach brand B: A's markers and the mixed work order (it holds a cell of A's). */
let aMarkers: Marker[]

type Json = Record<string, any>
type Method = 'GET' | 'POST'
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
const idsOf = (rows: Json[], key = 'id') => rows.map((row) => row[key] as string)

/** B's person meets A's record as an unknown one: the same status (404) and words as the address with a fresh id (or code). */
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
  db = await migratedDatabase('pr05_rework_wall')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  await seedFiles({ db: database, namespace: ns })
  seeded = await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  schedule = await seedSchedule({ db: database, namespace: ns })
  cutting = await seedCutting({ db: database, namespace: ns })
  costs = await seedCostActuals({ db: database, namespace: ns })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  w = await productionTwoBrands({ db, database, app, namespace: ns })
  expect(w.a.partyId).toBe(ids.a)
  const parties = await admin<{ partyId: string }>(`SELECT DISTINCT "partyId" FROM "WorkOrder" WHERE id = ANY($1::uuid[])`, [[seeded.workOrderId, costs.workOrderId]])
  expect(parties).toEqual([{ partyId: ids.a }])
  aMarkers = [...(await markersOf(db, w.a.partyId)), { label: 'mixed work order', text: w.mixed.number }, { label: 'mixed work order', text: w.mixed.workOrderId }]
}, 420_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('rework, recuts and repair behind the wall (PW-06 rework)', { timeout: 60_000 }, () => {
  it('A’s rework: listed and opened only for who reaches A; not found for B’s person, read, moved or repaired', async () => {
    const list = async (session: string, query = '') => idsOf((await ok(session, 'GET', `/production/rework?limit=200${query}`)).rework)
    expect(await list('office.all')).toContain(schedule.reworkOrderId)
    expect(await list('office.p1')).toContain(schedule.reworkOrderId)
    expect(await list('office.all', `&partyId=${ids.a}`)).toContain(schedule.reworkOrderId)
    expect(await list('office.p2')).toEqual([])
    expect(await list('office.p2', `&partyId=${ids.a}`)).toEqual([])
    await ok('office.p1', 'GET', `/production/rework/${schedule.reworkOrderId}`)
    await asUnknown('GET', `/production/rework/${schedule.reworkOrderId}`, schedule.reworkOrderId)
    await asUnknown('POST', `/production/rework/${schedule.reworkOrderId}/cancel`, schedule.reworkOrderId, { version: 1, reason: 'B was here' })
    await asUnknown('GET', `/production/repair/${schedule.reworkOrderId}`, schedule.reworkOrderId)
    expect((await admin<{ status: string }>(`SELECT status FROM "ReworkOrder" WHERE id = $1`, [schedule.reworkOrderId]))[0]!.status).not.toBe('CANCELLED')
  })

  it('A’s recut ticket: listed only for who reaches A; its code and its void answer as unknown ones for B’s person', async () => {
    const list = async (session: string, query = '') => idsOf((await ok(session, 'GET', `/production/recut-tickets?view=all${query}`)).rows)
    expect(await list('office.all')).toContain(cutting.ticketIds.recut)
    expect(await list('office.p1')).toContain(cutting.ticketIds.recut)
    expect(await list('office.p2')).toEqual([])
    expect(await list('office.p2', `&partyId=${ids.a}`)).toEqual([])
    expect(idsOf((await ok('office.p2', 'GET', '/production/recut-tickets/waiting')).rows)).toEqual([])
    const [{ scanCode }] = (await admin<{ scanCode: string }>(`SELECT "scanCode" FROM "CutTicket" WHERE id = $1`, [cutting.ticketIds.recut])) as [{ scanCode: string }]
    await asUnknown('GET', `/production/recut-tickets/scan?code=${scanCode}`, scanCode, undefined, 'T-NO-SUCH-TICKET')
    await asUnknown('POST', `/production/recut-tickets/${cutting.ticketIds.recut}/void`, cutting.ticketIds.recut, { version: 1, reason: 'B was here' })
  })
})

describe('scrap, replacements, over-limit and second quality behind the wall (PW-06 scrap)', { timeout: 60_000 }, () => {
  it('the scrap list and its tiles hold only the rows of the work orders reached: no total that mixes customers', async () => {
    const rows = async (session: string, query = '') => ((await ok(session, 'GET', `/production/scrap?limit=500${query}`)).rows as Json[]).map((row) => row.workOrder.id as string)
    const ofAll = await rows('office.all')
    expect(ofAll).toContain(seeded.workOrderId)
    expect(await rows('office.p1')).toEqual(await rows('office.all', `&partyId=${ids.a}`))
    expect(await rows('office.p2')).toEqual([])
    expect(await rows('office.p2', `&partyId=${ids.a}`)).toEqual([])
    const tiles = (await ok('office.p2', 'GET', '/production/scrap')).tiles as Json
    expect(Object.values(tiles).every((n) => n === 0)).toBe(true)
    expect((await ok('office.p2', 'GET', '/production/scrap/over-limit')).rows).toEqual([])
  })

  it('replacements, a scrap over the limit and A’s downgrades: not found for B’s person, read or decided', async () => {
    const list = async (session: string, query = '') => idsOf((await ok(session, 'GET', `/production/replacements?limit=200${query}`)).replacements)
    expect(await list('office.all')).toContain(schedule.replacementRequestId)
    expect(await list('office.p1')).toContain(schedule.replacementRequestId)
    expect(await list('office.p2')).toEqual([])
    expect(await list('office.p2', `&partyId=${ids.a}`)).toEqual([])
    await ok('office.p1', 'GET', `/production/replacements/${schedule.replacementRequestId}`)
    await asUnknown('GET', `/production/replacements/${schedule.replacementRequestId}`, schedule.replacementRequestId)
    await asUnknown('POST', `/production/replacements/${schedule.replacementRequestId}/cancel`, schedule.replacementRequestId, { version: 1, reason: 'B was here' })
    await asUnknown('POST', `/production/scrap/over-limit/${seeded.overLimitScanId}/approve`, seeded.overLimitScanId, {})
    const many = await ok('office.p2', 'POST', '/production/scrap/over-limit/approve', { scanIds: [seeded.overLimitScanId] })
    expect(many).toMatchObject({ approved: [], held: [{ scanId: seeded.overLimitScanId, code: 'NOT_FOUND', message: 'Scan not found.' }] })
    // Second quality.
    const downgrades = async (session: string, query = '') => idsOf((await ok(session, 'GET', `/production/downgrades?limit=200${query}`)).downgrades)
    expect(await downgrades('office.all')).toEqual(expect.arrayContaining(Object.values(cutting.downgradeIds)))
    expect(await downgrades('office.p1')).toEqual(expect.arrayContaining(Object.values(cutting.downgradeIds)))
    const ofB = await ok('office.p2', 'GET', '/production/downgrades?limit=200')
    expect(ofB.downgrades).toEqual([])
    expect(ofB.garments).toEqual({ today: 0, period: 0 })
    await asUnknown('POST', `/production/downgrades/${cutting.downgradeIds.sku}/withdraw`, cutting.downgradeIds.sku, { version: 1, reason: 'B was here' })
    expect((await admin(`SELECT "voidedAt" FROM "GarmentDowngrade" WHERE id = $1`, [cutting.downgradeIds.sku]))[0]).toEqual({ voidedAt: null })
  })
})

describe('extra operations, completion, serials, picking and kits behind the wall (PW-06 kits, picking)', { timeout: 60_000 }, () => {
  it('A’s work order’s extra operations, finished reports and serials: not found for B’s person', async () => {
    await ok('office.p1', 'GET', `/production/extra-operations/work-orders/${seeded.workOrderId}`)
    for (const url of [
      `/production/extra-operations/work-orders/${seeded.workOrderId}`,
      `/production/extra-operations/work-orders/${seeded.workOrderId}/choices`,
      `/production/work-orders/${seeded.workOrderId}/finished`,
      `/production/serials/work-orders/${seeded.workOrderId}`,
      `/production/serials/work-orders/${seeded.workOrderId}/serials`,
    ]) {
      await asUnknown('GET', url, seeded.workOrderId)
    }
    await asUnknown('GET', `/production/serials/scan?code=SEED-WO-0001`, 'SEED-WO-0001', undefined, 'T-NO-SUCH-WO')
  })

  it('picking and pick lists: only the work orders reached; A’s pick list, sheet and issue answer as unknown ones', async () => {
    const pick = async (session: string, query = '') => idsOf((await ok(session, 'GET', `/inventory/picking/work-orders?number=SEED-WO-0001${query}`)).workOrders)
    expect(await pick('office.all')).toEqual([seeded.workOrderId])
    expect(await pick('office.p1')).toEqual([seeded.workOrderId])
    expect(await pick('office.p2')).toEqual([])
    expect(idsOf((await ok('office.p2', 'GET', `/inventory/picking/work-orders?partyId=${ids.a}`)).workOrders)).toEqual([])
    await ok('office.p1', 'GET', `/inventory/picking/work-orders/${seeded.workOrderId}`)
    await asUnknown('GET', `/inventory/picking/work-orders/${seeded.workOrderId}`, seeded.workOrderId)
    await asUnknown('GET', `/inventory/picking/pick-lists/sheet?workOrderIds=${seeded.workOrderId}`, seeded.workOrderId)
    await asUnknown('POST', `/inventory/picking/moves/${seeded.issueMoveId}/reverse`, seeded.issueMoveId, { note: 'B was here' })
    const lists = async (session: string) => ((await ok(session, 'GET', `/inventory/picking/pick-lists?limit=200`)).rows as Json[]).map((row) => row.workOrder.id as string)
    expect(await lists('office.all')).toContain(seeded.workOrderId)
    expect(await lists('office.p1')).toContain(seeded.workOrderId)
    expect(await lists('office.p2')).not.toContain(seeded.workOrderId)
    expect((await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "StockMove" WHERE "reversalOfId" = $1`, [seeded.issueMoveId]))[0]!.n).toBe(0)
  })
})

describe('the work order’s cost reads behind the wall (PW-06 cost)', { timeout: 60_000 }, () => {
  it('cost rows, a work order’s cost and the ledger: only the work orders reached; the stock’s value only with every customer', async () => {
    const rows = async (session: string, query = '') => ((await ok(session, 'GET', `/costing/work-orders?limit=100${query}`)).rows as Json[]).map((row) => row.workOrder.id as string)
    const ofA = [seeded.workOrderId, costs.workOrderId]
    const all = await rows('office.all')
    expect(all.filter((id) => ofA.includes(id)).length).toBeGreaterThan(0)
    expect(await rows('office.p1')).toEqual(await rows('office.all', `&partyId=${ids.a}`))
    expect((await rows('office.p2')).filter((id) => ofA.includes(id))).toEqual([])
    expect(await rows('office.p2', `&partyId=${ids.a}`)).toEqual([])
    const tiles = async (session: string) => (await ok(session, 'GET', '/costing/work-orders?limit=1')).tiles as Json
    expect((await tiles('office.all')).stockValue).not.toBeNull()
    expect((await tiles('office.p2')).stockValue).toBeNull()
    expect((await tiles('office.p1')).stockValue).toBeNull()
    await ok('office.p1', 'GET', `/costing/work-orders/${costs.workOrderId}`)
    await asUnknown('GET', `/costing/work-orders/${costs.workOrderId}`, costs.workOrderId)
    await asUnknown('POST', `/costing/work-orders/${costs.workOrderId}/post`, costs.workOrderId)
    const ledger = async (session: string, query = '') => ((await ok(session, 'GET', `/costing/ledger?limit=200${query}`)).entries as Json[])
    const entries = await ledger('office.all', `&workOrderId=${costs.workOrderId}`)
    expect(entries.length).toBeGreaterThan(0)
    expect((await ledger('office.p1', `&workOrderId=${costs.workOrderId}`)).length).toBe(entries.length)
    expect(await ledger('office.p2', `&workOrderId=${costs.workOrderId}`)).toEqual([])
    expect(await ledger('office.p2', `&partyId=${ids.a}`)).toEqual([])
    const entryId = entries[0]!.id as string
    await asUnknown('POST', `/costing/entries/${entryId}/reverse`, entryId, { reason: 'B was here' })
  })
})

describe('what B’s person was answered (T00 scan)', () => {
  it('no answer B’s person got names A: not its names, code, orders, references, work orders or ids', () => {
    expect(seenByB.length).toBeGreaterThan(20)
    const found = seenByB.flatMap((entry) => findMarkers(entry.body, aMarkers).map((marker) => `${entry.url} → ${marker}`))
    expect(found).toEqual([])
  })
})
