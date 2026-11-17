import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import { EVERY_PARTY_WORDS, type Permission } from '@nexus/factory-domain/core/permissions'
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../packages/factory-db/seed/auth'
import { seed as seedCutting, type CuttingSeed } from '../../../../../packages/factory-db/seed/cutting'
import { seed as seedFiles } from '../../../../../packages/factory-db/seed/files'
import { seed as seedInstructions, type InstructionsSeed } from '../../../../../packages/factory-db/seed/instructions'
import { seed as seedNumbering } from '../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../packages/factory-db/seed/production'
import { seed as seedRoles } from '../../../../../packages/factory-db/seed/roles'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { findMarkers, markersOf, productionTwoBrands, twoBrandIds, twoBrandSessions, type Marker, type ProductionTwoBrands } from './testing/two-brands'

/**
 * F-PR-02 (production plan §2 and §5; 06-tree A.0 "One customer filter … its options are the customers in the person's scope
 * only", A.5 "Customer column on Cutting, Bundles, Scrap, Work instructions; customer code on Dispatch"; the wall tests PW-02
 * and PW-06 on what the screens read). Owner rule 2026-11-16: "One brand must not be able to see anything related to any other
 * brand. But we, as the production unit, should be able to see it all. And manage it all as well."
 *
 * On the local stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login),
 * the core, auth, roles, files, production, numbering, cutting-room and instructions seeds (brand A = the seeds' P1), the
 * production two-brand harness (brand B's work order and a mixed one made before the rule) and, written by the test's admin
 * pool, a cut order of A's and B's cells and one of B's alone (copies of the seeds' rows). Sessions `office.all` (every
 * customer), `office.p1` / `office.p2` (one customer each), and `office.thin` (Work orders only, every customer).
 *
 *   - GET /production/customers?view=<page>: each page's options are the customers of the work orders the reader reaches with
 *     that page's permission (Work instructions also the brands of the styles), never another one; `everyCustomer` says
 *     whether the page's mixed views open.
 *   - Every list row the screens draw names its customer: cuts, cut orders (+ the record), bundles (the code only), scrap and
 *     rework, second quality, work instructions (the style's brand); Production reports narrow their style × size tables.
 *
 * Every answer B's person got is scanned for A's names, codes, numbers and ids. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/production/customer-filter`.
 */

const ns = 'fpr02-customer-filter'
const ids = twoBrandIds(ns)
const PERMISSIONS: Permission[] = [
  'workorders.view',
  // The harness makes each brand's draft through the real route.
  'workorders.manage',
  'production.cutting.view',
  'production.bundles.view',
  'production.scrap.view',
  'production.calls.view',
  'production.instructions.view',
  'production.reports.view',
  'production.dispatch.view',
]
const SESSIONS: Record<string, SessionContext> = {
  ...twoBrandSessions(ids.tenantId, ids.a, ids.b, PERMISSIONS),
  'office.thin': { audience: 'office', tenantId: ids.tenantId, actorId: newId(), grants: [{ permissions: ['workorders.view'], companies: 'all', sites: 'all', parties: 'all' }] },
}
const VIEWS = ['floor', 'work-orders', 'cutting', 'bundles', 'scrap', 'calls', 'instructions', 'reports', 'dispatch'] as const

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let w: ProductionTwoBrands
let cutting: CuttingSeed
let instructions: InstructionsSeed
let aMarkers: Marker[]
const made = { cutOrderMixed: newId(), cutOrderB: newId() }
const party = { a: { code: '', name: '' }, b: { code: '', name: '' } }

type Json = Record<string, any>
const seenByB: { readonly url: string; readonly body: unknown }[] = []
async function call(session: string, url: string): Promise<{ status: number; body: Json; raw: string }> {
  const response = await app.inject({ method: 'GET', url, headers: { 'x-test-session': session } })
  const body = response.headers['content-type']?.toString().startsWith('application/json') ? (response.json() as Json) : {}
  if (session === 'office.p2') seenByB.push({ url, body })
  return { status: response.statusCode, body, raw: response.body }
}
async function ok(session: string, url: string): Promise<Json> {
  const answer = await call(session, url)
  expect(answer.status, `GET ${url}: ${answer.raw}`).toBe(200)
  return answer.body
}
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
/** A work order's one customer as the rows must name it (null: none). */
async function partyOfWorkOrder(workOrderId: string): Promise<string | null> {
  return (await admin<{ partyId: string | null }>(`SELECT "partyId" FROM "WorkOrder" WHERE id = $1`, [workOrderId]))[0]!.partyId
}

beforeAll(async () => {
  db = await migratedDatabase('fpr02_customers')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  for (const seed of [seedCore, seedAuth, seedRoles, seedFiles]) await seed({ db: database, namespace: ns })
  await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  cutting = await seedCutting({ db: database, namespace: ns })
  instructions = await seedInstructions({ db: database, namespace: ns })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  w = await productionTwoBrands({ db, database, app, namespace: ns })
  expect(w.a.partyId).toBe(ids.a)
  for (const [key, id] of [['a', w.a.partyId], ['b', w.b.partyId]] as const) {
    const row = (await admin<{ code: string; legalName: string; tradeName: string | null }>(`SELECT code, "legalName", "tradeName" FROM "Party" WHERE id = $1`, [id]))[0]!
    party[key] = { code: row.code, name: row.tradeName ?? row.legalName }
  }
  // A cut order of A's and B's cells and one of B's alone: copies of A's planned SEED-CO-0003 and its line (B's cell: size 50).
  const [cellB] = await admin<{ id: string }>(`SELECT id FROM "WorkOrderSize" WHERE "workOrderId" = $1 AND size = '50'`, [w.b.workOrderId])
  const v = { coM: made.cutOrderMixed, coB: made.cutOrderB, co3: cutting.cutOrderIds.planned, line3: cutting.lineIds.planned, b: w.b.workOrderId, cellB: cellB!.id }
  const q = (text: string) => text.replace(/@(\w+)/g, (_match, key: keyof typeof v) => `'${v[key]}'`)
  await admin(
    q(`BEGIN;
     SET LOCAL session_replication_role = replica;
     INSERT INTO "CutOrder" SELECT (jsonb_populate_record(NULL::"CutOrder", to_jsonb(o) || jsonb_build_object('id', @coM::text, 'number', 'T-FPR02-CO-MIX'))).* FROM "CutOrder" o WHERE o.id = @co3;
     INSERT INTO "CutOrder" SELECT (jsonb_populate_record(NULL::"CutOrder", to_jsonb(o) || jsonb_build_object('id', @coB::text, 'number', 'T-FPR02-CO-B'))).* FROM "CutOrder" o WHERE o.id = @co3;
     INSERT INTO "CutOrderLine" SELECT (jsonb_populate_record(NULL::"CutOrderLine", to_jsonb(l) || jsonb_build_object('id', gen_random_uuid(), 'cutOrderId', @coM::text))).* FROM "CutOrderLine" l WHERE l.id = @line3;
     INSERT INTO "CutOrderLine" SELECT (jsonb_populate_record(NULL::"CutOrderLine", to_jsonb(l) || jsonb_build_object('id', gen_random_uuid(), 'cutOrderId', @coM::text, 'seq', 20, 'workOrderId', @b::text, 'workOrderSizeId', @cellB::text))).* FROM "CutOrderLine" l WHERE l.id = @line3;
     INSERT INTO "CutOrderLine" SELECT (jsonb_populate_record(NULL::"CutOrderLine", to_jsonb(l) || jsonb_build_object('id', gen_random_uuid(), 'cutOrderId', @coB::text, 'workOrderId', @b::text, 'workOrderSizeId', @cellB::text))).* FROM "CutOrderLine" l WHERE l.id = @line3;
     COMMIT;`),
  )
  aMarkers = [...(await markersOf(db, w.a.partyId)), { label: 'mixed work order', text: w.mixed.number }, { label: 'mixed work order', text: w.mixed.workOrderId }]
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('GET /production/customers: the filter’s options (PW-02, PW-06)', { timeout: 60_000 }, () => {
  it('the production unit gets every customer in production on each page; a person limited to B gets B only, never A', async () => {
    for (const view of VIEWS) {
      const all = await ok('office.all', `/production/customers?view=${view}`)
      expect(all.everyCustomer, view).toBe(true)
      expect((all.customers as Json[]).map((row) => row.id), view).toEqual(expect.arrayContaining([w.a.partyId, w.b.partyId]))
      expect((all.customers as Json[]).find((row) => row.id === w.a.partyId), view).toEqual({ id: w.a.partyId, code: party.a.code, name: party.a.name })
      const b = await ok('office.p2', `/production/customers?view=${view}`)
      expect(b, view).toEqual({ customers: [{ id: w.b.partyId, code: party.b.code, name: party.b.name }], everyCustomer: false })
      const a = await ok('office.p1', `/production/customers?view=${view}`)
      expect((a.customers as Json[]).map((row) => row.id), view).toEqual([w.a.partyId])
      expect(a.everyCustomer, view).toBe(false)
    }
  })

  it('each page asks for its own permission; an unknown page is refused in words', async () => {
    expect((await ok('office.thin', '/production/customers?view=floor')).everyCustomer).toBe(true)
    for (const view of ['cutting', 'bundles', 'scrap', 'calls', 'instructions', 'reports', 'dispatch']) expect((await call('office.thin', `/production/customers?view=${view}`)).status, view).toBe(403)
    expect((await call('office.all', '/production/customers?view=sales')).status).toBe(400)
    expect((await call('office.all', '/production/customers')).status).toBe(400)
  })
})

describe('the rows the screens draw name their customer', { timeout: 60_000 }, () => {
  it('Cutting: each work order’s cut names its customer; the filter keeps one customer’s', async () => {
    const cuts = (await ok('office.all', '/production/cutting/cuts?view=all&limit=200')).cuts as Json[]
    expect(cuts.length).toBeGreaterThan(0)
    for (const row of cuts) {
      const partyId = await partyOfWorkOrder(row.workOrder.id)
      expect(row.customer?.id ?? null, row.workOrder.number).toBe(partyId)
      if (partyId === w.a.partyId) expect(row.customer).toEqual({ id: w.a.partyId, code: party.a.code, name: party.a.name })
    }
    const ofB = (await ok('office.all', `/production/cutting/cuts?view=all&limit=200&partyId=${w.b.partyId}`)).cuts as Json[]
    expect(ofB.filter((row) => row.customer?.id !== w.b.partyId)).toEqual([])
    expect(((await ok('office.p2', '/production/cutting/cuts?view=all&limit=200')).cuts as Json[]).filter((row) => row.customer?.id !== w.b.partyId)).toEqual([])
  })

  it('cut orders name every customer of their cells (list and record); a mixed one stays the production unit’s', async () => {
    const rows = async (session: string, query = '') => (await ok(session, `/production/cut-orders?view=all&limit=200${query}`)).rows as Json[]
    const all = await rows('office.all')
    const names = [party.a, party.b].sort((x, y) => x.name.localeCompare(y.name)).map((entry) => entry.name)
    expect((all.find((row) => row.id === made.cutOrderMixed)?.customers as Json[]).map((row) => row.name)).toEqual(names)
    expect(all.find((row) => row.id === made.cutOrderB)?.customers).toEqual([{ id: w.b.partyId, code: party.b.code, name: party.b.name }])
    expect(all.find((row) => row.id === cutting.cutOrderIds.planned)?.customers).toEqual([{ id: w.a.partyId, code: party.a.code, name: party.a.name }])
    expect(((await ok('office.all', `/production/cut-orders/${made.cutOrderMixed}`)).cutOrder.customers as Json[]).map((row) => row.id).sort()).toEqual([w.a.partyId, w.b.partyId].sort())
    // B's person: B's own cut order with B only; the mixed one is not theirs (B-PR-04b) and nothing names A.
    const ofB = await rows('office.p2')
    expect(ofB.map((row) => row.id)).toContain(made.cutOrderB)
    expect(ofB.map((row) => row.id)).not.toContain(made.cutOrderMixed)
    expect(ofB.flatMap((row) => row.customers as Json[]).filter((row) => row.id !== w.b.partyId)).toEqual([])
    expect((await ok('office.p2', `/production/cut-orders/${made.cutOrderB}`)).cutOrder.customers).toEqual([{ id: w.b.partyId, code: party.b.code, name: party.b.name }])
  })

  it('Bundles: each bundle carries its customer’s CODE, never the name', async () => {
    const bundles = (await ok('office.all', '/production/bundles?limit=200')).bundles as Json[]
    expect(bundles.length).toBeGreaterThan(0)
    for (const row of bundles) {
      const partyId = await partyOfWorkOrder(row.workOrder.id)
      expect(row.customerCode, row.code).toBe(partyId === w.a.partyId ? party.a.code : partyId === w.b.partyId ? party.b.code : null)
      expect(row).not.toHaveProperty('customer')
    }
    expect(JSON.stringify(bundles)).not.toContain(party.a.name)
    expect(((await ok('office.p2', '/production/bundles?limit=200')).bundles as Json[]).filter((row) => row.customerCode !== party.b.code)).toEqual([])
  })

  it('Scrap & rework: each row names its work order’s customer', async () => {
    const rows = (await ok('office.all', '/production/scrap?limit=500')).rows as Json[]
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.customer?.id ?? null, row.id).toBe(await partyOfWorkOrder(row.workOrder.id))
    expect(((await ok('office.all', `/production/scrap?limit=500&partyId=${w.b.partyId}`)).rows as Json[]).filter((row) => row.customer?.id !== w.b.partyId)).toEqual([])
    for (const row of (await ok('office.all', '/production/downgrades?limit=500')).downgrades as Json[]) expect(row.customer?.id ?? null).toBe(await partyOfWorkOrder(row.workOrder.id))
  })

  it('Work instructions: a private label names its customer, our own and every-style ones none; the filter keeps one customer’s', async () => {
    const listed = async (session: string, query = '') => (await ok(session, `/production/instructions${query}`)).instructions as Json[]
    const brand = (await admin<{ brandPartyId: string | null }>(`SELECT s."brandPartyId" FROM "WorkInstruction" i JOIN "Style" s ON s.id = i."styleId" WHERE i.id = $1`, [instructions.instructionIds.revision]))[0]!.brandPartyId
    expect(brand).toBe(w.a.partyId)
    const all = await listed('office.all')
    expect(all.find((row) => row.id === instructions.instructionIds.revision)?.customer).toEqual({ id: w.a.partyId, code: party.a.code, name: party.a.name })
    expect(all.find((row) => row.id === instructions.instructionIds.sewing)?.customer).toBeNull()
    expect((await listed('office.all', `?partyId=${w.a.partyId}`)).map((row) => row.id)).toEqual([instructions.instructionIds.revision])
    expect(await listed('office.all', `?partyId=${w.b.partyId}`)).toEqual([])
    expect(await listed('office.p2', `?partyId=${w.a.partyId}`)).toEqual([])
    expect((await listed('office.p2')).filter((row) => row.customer !== null)).toEqual([])
  })

  it('Production reports: the customer filter narrows the style × size tables only; a person limited to B reads the words', async () => {
    const day = async (query = '') => (await ok('office.all', `/production/reports/daily${query}`)) as Json
    const whole = await day()
    const ofA = await day(`?partyId=${w.a.partyId}`)
    const ofB = await day(`?partyId=${w.b.partyId}`)
    // The lanes' own figures stay the line's; A made everything the seeds scanned, B nothing yet.
    const figures = (answer: Json) => (answer.lanes as Json[]).map((lane) => [lane.id, lane.good, lane.scrap, lane.rework, lane.efficiencyPct])
    expect(figures(ofB)).toEqual(figures(whole))
    expect((ofB.lanes as Json[]).flatMap((lane) => lane.rows)).toEqual([])
    expect((ofA.lanes as Json[]).map((lane) => lane.rows)).toEqual((whole.lanes as Json[]).map((lane) => lane.rows))
    expect(ofA.totals).toEqual(whole.totals)
    const refused = await call('office.p2', `/production/reports/daily?partyId=${w.b.partyId}`)
    expect([refused.status, refused.body.error?.message]).toEqual([403, EVERY_PARTY_WORDS.en])
  })

  it('Dispatch: a person limited to B is told the board needs every customer (the floor screens keep the code)', async () => {
    const refused = await call('office.p2', `/production/dispatch/board?siteId=${w.siteId}`)
    expect([refused.status, refused.body.error?.message]).toEqual([403, EVERY_PARTY_WORDS.en])
  })
})

describe('what B’s person was answered (T00 scan)', () => {
  it('no answer B’s person got names A: not its names, code, orders, references, work orders or ids', () => {
    expect(seenByB.length).toBeGreaterThan(15)
    const found = seenByB.flatMap((entry) => findMarkers(entry.body, aMarkers).map((marker) => `${entry.url} → ${marker}`))
    expect(found).toEqual([])
  })
})
