import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import { EVERY_PARTY_WORDS, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { callerFor } from '../../core/command'
import { actorOf, testAuthenticator, type OfficeContext, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { readMeasures } from '../insights/facts/reads'
import { workOrderHeld } from '../insights/sources/production'
import { findMarkers, markersOf, productionTwoBrands, twoBrandIds, twoBrandSessions, type Marker, type ProductionTwoBrands } from '../production/testing/two-brands'

/**
 * B-PR-07 (production plan §2, the brand wall: "A view that mixes brands (capacity, Line TV, daily report, board line totals)
 * needs access to every brand"; 06-tree §0.6 PW-06; the step's wall test: capacity, Line TV, daily report, board totals) on the
 * local stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login), the core,
 * files, production and numbering seeds, the production two-brand harness (../production/testing/two-brands.ts: brand A = the
 * seeds' P1, brand B = the threads' second brand, a work order each and a mixed one made before the rule) and one material plan
 * run (a planned order per customer for what stays open). Owner rule 2026-11-16: "One brand must not be able to see anything
 * related to any other brand. But we, as the production unit, should be able to see it all. And manage it all as well."
 *
 *   - a view that mixes customers (capacity, the heatmaps, the material plan and its messages, the line boards and the TV, the
 *     dispatch lists, board and paper, the daily and lines reports, yield, the cutting room, labour, off-standard time, the
 *     production measures): the production unit reads it; a person limited to brand B gets 403 in words that name no customer;
 *   - the planning board: brand B's person sees B's work orders, bars, tray and problems only, no line load and no capacity
 *     total (`loadWithheld` says why), and may not publish; readiness, shortages and planned orders hold B's rows only, and A's
 *     records answer as unknown ones (404);
 *   - every answer B's person got is scanned for A's names, codes, numbers and ids.
 *
 * Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/planning/brand-wall`.
 */

const ns = 'pr07-wall'
const ids = twoBrandIds(ns)
const PERMISSIONS: Permission[] = [
  'workorders.view',
  'workorders.manage',
  'workorders.release',
  'planning.view',
  'planning.run',
  'planning.schedule.manage',
  'planning.schedule.publish',
  'production.boards.view',
  'production.reports.view',
  'production.dispatch.view',
  'production.dispatch.manage',
  'production.cutting.view',
  'production.labour.view',
  'production.offstandard.view',
]
const SESSIONS: Record<string, SessionContext> = twoBrandSessions(ids.tenantId, ids.a, ids.b, PERMISSIONS)
const site = seedUuid(ns, 'site:A1')
const line = seedUuid(ns, 'site:A1:line:L1')

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let w: ProductionTwoBrands
let aMarkers: Marker[]

type Json = Record<string, any>
const seenByB: { url: string; status: number; body: unknown }[] = []
async function call(session: string, url: string, method: 'GET' | 'POST' = 'GET', payload?: unknown): Promise<{ status: number; body: Json; raw: string }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'POST' ? { 'idempotency-key': newId() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
  const body = response.headers['content-type']?.toString().startsWith('application/json') ? (response.json() as Json) : {}
  if (session === 'office.p2') seenByB.push({ url: `${method} ${url}`, status: response.statusCode, body: Object.keys(body).length > 0 ? body : response.body })
  return { status: response.statusCode, body, raw: response.body }
}
async function ok(session: string, url: string, method: 'GET' | 'POST' = 'GET', payload?: unknown, status = 200): Promise<Json> {
  const answer = await call(session, url, method, payload)
  expect(answer.status, `${url}: ${answer.raw}`).toBe(status)
  return answer.body
}
const officeOf = (session: string) => ({ ...SESSIONS[session]!, requestId: newId() }) as OfficeContext
const callerOf = (session: string) => callerFor(database, officeOf(session))

beforeAll(async () => {
  db = await migratedDatabase('pr07_brand_wall')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  await seedFiles({ db: database, namespace: ns })
  await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  w = await productionTwoBrands({ db, database, app, namespace: ns })
  aMarkers = [...(await markersOf(db, w.a.partyId)), { label: 'mixed work order', text: w.mixed.number }, { label: 'mixed work order', text: w.mixed.workOrderId }]
  // The material plan: a planned order per customer for what stays open on the harness's lines.
  await ok('office.all', '/planning/runs', 'POST', { siteId: site }, 201)
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

/** The views that mix customers: every one is the production unit's; a person limited to a customer is refused in words. */
const MIXED: readonly string[] = [
  `/planning/capacity?siteId=${site}`,
  `/planning/capacity/cell?siteId=${site}&laneKind=LINE&laneId=${line}&from=2026-11-16&to=2026-11-20`,
  `/planning/capacity/subcontractors?siteId=${site}`,
  `/planning/heatmap?siteId=${site}`,
  `/planning/runs/latest?siteId=${site}`,
  `/planning/runs`,
  `/planning/action-messages?siteId=${site}`,
  `/planning/schedule/publish?siteId=${site}`,
  `/planning/schedule/versions?siteId=${site}`,
  `/production/boards/tv?lineId=${line}`,
  `/production/boards/hourly?siteId=${site}`,
  `/production/boards/heatmap?siteId=${site}`,
  `/production/boards/targets?lineId=${line}`,
  `/production/reports/daily?siteId=${site}`,
  `/production/reports/lines?siteId=${site}`,
  `/production/dispatch?lineId=${line}`,
  `/production/dispatch/board?siteId=${site}`,
  `/production/dispatch/print/paper?lineId=${line}`,
  `/production/dispatch/handover?lineId=${line}`,
  `/production/yield?siteId=${site}`,
  `/production/cutboard?siteId=${site}`,
  `/production/cutboard/yield?siteId=${site}`,
  `/production/labour/inbox`,
  `/production/labour/counts`,
  `/production/labour/days`,
  `/production/offstandard/blocks`,
  `/production/offstandard/counts`,
]

describe('PW-06: a view that mixes customers needs every customer', { timeout: 120_000 }, () => {
  it('the production unit reads every one; a person limited to brand B gets 403 in words that name no customer', async () => {
    for (const url of MIXED) {
      await ok('office.all', url)
      const refused = await call('office.p2', url)
      expect(refused.status, `${url}: ${refused.raw}`).toBe(403)
      expect(refused.body.error?.message, url).toBe(EVERY_PARTY_WORDS.en)
    }
  })

  it('the planning board: B sees B’s work orders and tray only, no line load or capacity total, and may not publish', async () => {
    const all = await ok('office.all', `/planning/schedule?siteId=${site}`)
    const ofAll = (all.workOrders as Json[]).map((row) => row.id)
    expect(ofAll).toEqual(expect.arrayContaining([w.a.workOrderId, w.b.workOrderId, w.mixed.workOrderId]))
    expect(all.loadWithheld).toBeNull()
    expect((all.lanes as Json[]).filter((lane) => lane.kind !== 'WORKSHOP').every((lane) => Array.isArray(lane.cells))).toBe(true)

    const b = await ok('office.p2', `/planning/schedule?siteId=${site}`)
    expect((b.workOrders as Json[]).map((row) => row.id)).toEqual([w.b.workOrderId])
    expect((b.tray as Json[]).map((row) => row.workOrderId)).toEqual([w.b.workOrderId])
    expect(b.loadWithheld).toBe(EVERY_PARTY_WORDS.en)
    expect((b.lanes as Json[]).length).toBeGreaterThan(0)
    expect((b.lanes as Json[]).every((lane) => lane.cells === null)).toBe(true)
    expect((b.problems as Json[]).filter((problem) => problem.kind === 'OVERBOOKED')).toEqual([])
    expect((b.problems as Json[]).every((problem) => problem.workOrderId === null || problem.workOrderId === w.b.workOrderId)).toBe(true)
    expect((b.moreProblems as Json[]).every((problem) => problem.workOrderId === w.b.workOrderId)).toBe(true)
    expect((b.slots as Json[]).every((slot) => slot.workOrderId === w.b.workOrderId)).toBe(true)
    expect(b.plan).toMatchObject({ mayPublish: false, changesSincePublished: null })

    // The bar popover: A's work order and the mixed one are unknown to B; B's own opens.
    expect((await call('office.p2', `/planning/schedule/work-orders/${w.a.workOrderId}`)).status).toBe(404)
    expect((await call('office.p2', `/planning/schedule/work-orders/${w.mixed.workOrderId}`)).status).toBe(404)
    expect((await ok('office.p2', `/planning/schedule/work-orders/${w.b.workOrderId}`)).workOrder.id).toBe(w.b.workOrderId)
    expect((await ok('office.all', `/planning/schedule/work-orders/${w.a.workOrderId}`)).workOrder.id).toBe(w.a.workOrderId)
    // A bar placed by the tray takes room on shared lanes: every customer.
    const placed = await call('office.p2', '/planning/schedule/place-by-due-date', 'POST', { siteId: site, apply: false })
    expect(placed.status, placed.raw).toBe(403)
  })

  it('readiness and shortages hold B’s work orders only; A’s readiness answers as unknown', async () => {
    const all = await ok('office.all', `/planning/readiness?siteId=${site}`)
    expect((all.workOrders as Json[]).map((row) => row.workOrder.id)).toEqual(expect.arrayContaining([w.a.workOrderId, w.b.workOrderId, w.mixed.workOrderId]))
    const b = await ok('office.p2', `/planning/readiness?siteId=${site}`)
    expect((b.workOrders as Json[]).map((row) => row.workOrder.id)).toEqual([w.b.workOrderId])
    const asked = await ok('office.p2', `/planning/readiness?siteId=${site}&workOrderIds=${w.a.workOrderId},${w.b.workOrderId}`)
    expect((asked.workOrders as Json[]).map((row) => row.workOrder.id)).toEqual([w.b.workOrderId])
    expect((await call('office.p2', `/planning/work-orders/${w.a.workOrderId}/readiness`)).status).toBe(404)
    expect((await ok('office.p2', `/planning/work-orders/${w.b.workOrderId}/readiness`)).readiness.workOrder.id).toBe(w.b.workOrderId)
    const shortages = await ok('office.p2', `/planning/shortages?siteId=${site}`)
    expect((shortages.rows as Json[]).every((row) => row.workOrder.id === w.b.workOrderId)).toBe(true)
  })

  it('planned orders: B’s own only, its counts too; A’s planned order answers as unknown', async () => {
    const lineOf = (row: Json) => (row.demand as Json[]).map((entry) => entry.orderLineId as string)
    const all = (await ok('office.all', `/planning/planned-orders?siteId=${site}`)).plannedOrders as Json[]
    const ofA = all.find((row) => lineOf(row).includes(w.a.salesOrderLineId))
    const ofB = all.find((row) => lineOf(row).includes(w.b.salesOrderLineId))
    expect(ofA, JSON.stringify(all.map(lineOf))).toBeDefined()
    expect(ofB).toBeDefined()
    const b = await ok('office.p2', `/planning/planned-orders?siteId=${site}`)
    const mine = b.plannedOrders as Json[]
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every((row) => lineOf(row).length > 0 && lineOf(row).every((orderLine) => orderLine === w.b.salesOrderLineId))).toBe(true)
    expect(b.counts.make + b.counts.subcontract).toBe(mine.length)
    expect((await call('office.p2', `/planning/planned-orders/${ofA!.id}`)).status).toBe(404)
    expect((await ok('office.p2', `/planning/planned-orders/${ofB!.id}`)).plannedOrder.id).toBe(ofB!.id)
  })

  it('the production measures and Today’s held work orders: no figure of every customer, no A work order', async () => {
    const today = businessDate(new Date())
    const buckets = [{ from: today, to: today }]
    for (const session of ['office.p2', 'office.all'] as const) {
      const caller = callerOf(session)
      const reading = (await readMeasures(caller, actorOf(officeOf(session)), ['production.output_pieces'], buckets)).get('production.output_pieces')!
      if (session === 'office.p2') expect(reading.problem).toBe('NO_ACCESS')
      else expect(reading.problem).not.toBe('NO_ACCESS')
    }
    const held = async (session: string) => {
      const viewer = { actor: actorOf(officeOf(session)), personId: officeOf(session).actorId, today, now: new Date() }
      return (await workOrderHeld({ caller: callerOf(session), viewer })).candidates.map((candidate) => candidate.record.id)
    }
    const ofB = await held('office.p2')
    expect(ofB.every((id) => id === w.b.workOrderId)).toBe(true)
    const ofAll = await held('office.all')
    expect(ofAll.length).toBeGreaterThanOrEqual(ofB.length)
  })

  it('no answer brand B’s person got names anything of brand A', () => {
    expect(seenByB.length).toBeGreaterThan(MIXED.length)
    expect(findMarkers(seenByB, aMarkers)).toEqual([])
  })
})
