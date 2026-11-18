import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { newId } from '@nexus/factory-domain/core/ids'
import { EVERY_PARTY_WORDS } from '@nexus/factory-domain/core/permissions'
import { localFileStore } from '../../adapters/local-files/local'
import { routesFiles } from '../../core/autoload'
import { buildApp } from '../../core/app'
import { testAuthenticator } from '../../core/context'
import { LOCAL_COOKIE_SECRET, LOCAL_PIN_PEPPER } from '../../env'
import { createOfficeAuth } from '../../platform/auth/sessions/office-auth'
import { createEmailRuntime, useEmail } from '../../platform/email-out/service'
import { createFilesRuntime, useFiles } from '../../platform/files/service'
import type { Gateway } from '../../platform/gateway/gateway'
import { useGateway } from '../../platform/gateway/service'
import { OWN_STYLE_CODE, productionTwoBrands, twoBrandIds, twoBrandSessions, walkWorkOrderRoutes, workOrderModels, type OfficeSession, type ProductionTwoBrands } from './testing/two-brands'
import { createWallSweep, UUID, type Finding, type Json, type Method } from './testing/wall-sweep'

/**
 * B-PR-10 — THE BRAND-WALL SWEEP (production plan §2 "Proof": "a sweep of every route, reads AND writes, that touches work
 * orders"; Appendix D PW-10 "writes with another brand's ids (bulk edit, Hold N, Release N, Travellers N, cut order)"). Owner rule
 * 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production unit, should be
 * able to see it all. And manage it all as well."
 *
 * 1. The manifest walker (./testing/two-brands.ts walkWorkOrderRoutes) lists EVERY route of any method whose handler reads
 *    WorkOrder, WorkOrderSize or a model that names one of them — from the schema, the routes files and the code, never a hand
 *    list. The office routes among them are swept; EXEMPT names each one left out and why.
 * 2. Each swept route is called as `office.p2` — every office permission, limited to brand B — with brand A's ids in its address,
 *    its query and its body (A = the seeds' customer P1: every seed file runs, so A owns work orders in every state with their
 *    bundles, scans, cuts, inspections, holds, NCRs, CAPAs, shipments, returns, repairs, subcontract orders …), and again with
 *    a fresh id in place of each of A's (an unknown record):
 *      - A's answer is word for word the unknown one's (status and words; the request id and the asked ids aside), or a
 *        403 in EVERY_PARTY words: another customer's record is not found, a view that mixes customers needs every customer;
 *      - a write with A's ids is refused (never 2xx while the unknown one is refused) and writes no audit row about A;
 *      - no answer names anything of A (the threads' marker scan: names, codes, numbers, references, ids — the ids p2 itself
 *        sent are left out) — also on a route whose request names nothing of A (a list, a board, a report).
 *    The production unit (`office.all`, the same permissions, every customer) reads the same GET addresses: how many it reaches
 *    is printed (the sweep proves the wall on real records, not on ids that exist nowhere).
 * 3. The named leftovers of B-PR-04…09 (CAPA, the styles list, the subcontract orders' own list, the MPS screen, planning
 *    allocation, what-ifs, day sheets, the run log, the warehouse exports) have their own tests below, with each decision.
 *
 * On the local stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login), every
 * seed file in name order (as `npm run seed`), the production two-brand harness (A's and B's draft work orders through the real
 * route, a mixed one made before the rule). Every name and number is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/production/brand-wall`.
 */
 * B-PR-36: the sweep's engine (requests from the routes' own schemas, the comparison, the scan) lives in ./testing/wall-sweep.ts,
 * unchanged, so the production golden flow re-runs the same sweep on its own world at the end.
 */

const ns = 'pr10-brand-wall'
const ids = twoBrandIds(ns)
const SRC = fileURLToPath(new URL('../..', import.meta.url))
const SCHEMA_DIR = fileURLToPath(new URL('../../../../../packages/factory-db/prisma/schema', import.meta.url))
const SEED_DIR = fileURLToPath(new URL('../../../../../packages/factory-db/seed', import.meta.url))
/** Every permission an office role can hold, money grains included (the sweep reads every field there is). */
const OFFICE_PERMISSIONS = FACTORY_PERMISSIONS.all.filter((definition) => definition.link === undefined && definition.partner === undefined).map((definition) => definition.name)
const SESSIONS: Record<string, OfficeSession> = twoBrandSessions(ids.tenantId, ids.a, ids.b, OFFICE_PERMISSIONS)
const sweeper = createWallSweep({ ids, sessions: SESSIONS, reportPrefix: process.env.FACTORY_PR10_SWEEP_REPORT })

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let w: ProductionTwoBrands
let filesRoot: string | undefined

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]

// ---- set-up ------------------------------------------------------------------------------------------------------------------

beforeAll(async () => {
  db = await migratedDatabase('pr10_brand_wall')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  // Every seed file in name order, as `npm run seed` (factory-db cli.ts): A (P1) owns records of every kind.
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: database, namespace: ns })
  }
  // Files on the local store (the wall answers before any byte is read); its gateway is never reached by a refusal.
  filesRoot = mkdtempSync(join(tmpdir(), 'factory-pr10-sweep-'))
  const noGateway = new Proxy({}, { get: () => () => { throw new Error('the sweep has no gateway') } }) as Gateway
  const files = createFilesRuntime({ gateway: noGateway, local: localFileStore({ root: filesRoot, environment: 'test' }) })
  useFiles(files)
  // The process's gateway and mail: a refusal answers before either is reached; a call that reaches them is an outside call.
  useGateway(noGateway)
  useEmail(createEmailRuntime({ gateway: noGateway, fake: null, webOrigin: 'http://localhost:3901', files: files.storage }))
  const officeAuth = createOfficeAuth({ database, environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET, pinPepper: LOCAL_PIN_PEPPER, webOrigin: 'http://localhost:3901', mailer: { deliver: async () => {} } })
  const plugins: FastifyPluginAsync[] = [sweeper.routeSpy]
  for (const file of routesFiles(SRC)) plugins.push(((await import(pathToFileURL(file).href)) as { default: FastifyPluginAsync }).default)
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET, rateLimit: { max: 1_000_000, perAddressMax: 1_000_000, timeWindowMs: 60_000 } },
    { database, officeAuth, routes: plugins, authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  w = await productionTwoBrands({ db, database, app, namespace: ns })
  expect(w.a.partyId).toBe(ids.a)
  await sweeper.prepare({ db, app, w, srcRoot: SRC, schemaDir: SCHEMA_DIR })
}, 900_000)

afterAll(async () => {
  useFiles(undefined)
  useGateway(undefined)
  useEmail(undefined)
  if (filesRoot) rmSync(filesRoot, { recursive: true, force: true })
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('B-PR-10 the brand-wall sweep', () => {
  it('the walker lists every route that reads a work order, from the manifests and the code', () => {
    const walked = sweeper.walked()
    const keys = new Set(walked.map((route) => route.key))
    // Every route it lists is a registered route with a manifest entry; every registered route was looked at.
    for (const route of walked) expect(sweeper.routes.has(route.key), route.key).toBe(true)
    const everyRoute = walkWorkOrderRoutes({ srcRoot: SRC, schemaDir: SCHEMA_DIR, all: true })
    for (const key of sweeper.routes.keys()) if (!['GET /health', 'GET /ready'].includes(key) && !key.includes('/local-files')) expect(everyRoute.some((route) => route.key === key), key).toBe(true)
    // The models: WorkOrder, WorkOrderSize and their children.
    const names = workOrderModels(SCHEMA_DIR).map((model) => model.name)
    for (const name of ['WorkOrder', 'WorkOrderSize', 'Bundle', 'OperationScan', 'CutLog', 'Inspection', 'ShipmentLine', 'ScheduleSlot', 'SubcontractOrder']) expect(names).toContain(name)
    // Routes it must find, whatever the code's layout.
    for (const key of ['GET /production/work-orders/:workOrderId', 'GET /production/work-orders/travellers', 'POST /views/bulk/apply', 'POST /quality/holds', 'POST /production/cut-orders', 'GET /quality/capa', 'GET /purchasing/subcontracting/orders', 'GET /planning/allocation', 'GET /planning/schedule/day-sheets']) expect(keys.has(key), key).toBe(true)
    sweeper.report('walked', walked.map((route) => ({ key: route.key, file: route.file, via: route.via, audiences: sweeper.routes.get(route.key)?.manifest.audiences ?? null })))
  })

  it('every GET that reads a work order, called by brand B with brand A ids: as unknown, empty or 403 EVERY_PARTY, never a word of A', async () => {
    const findings: Finding[] = []
    for (const route of sweeper.swept('read')) for (const variant of sweeper.variantsOf(route)) findings.push(...(await sweeper.sweep(route, variant)))
    const reads = sweeper.called.filter((call) => call.route.startsWith('GET '))
    sweeper.report('reads', { findings, failures: sweeper.failures, called: reads, unresolved: sweeper.unresolved() })
    const reached = reads.filter((call) => call.named > 0 && call.all !== null && call.all >= 200 && call.all < 300).length
    console.log(`B-PR-10 GET sweep: ${reads.length} calls; ${reached} named A's records the production unit reads`)
    expect(findings).toEqual([])
  }, 1_800_000)

  it('PW-10: every write that reads a work order, called by brand B with brand A ids, is refused as unknown and writes no row about A', async () => {
    const findings: Finding[] = []
    for (const route of sweeper.swept('write')) findings.push(...(await sweeper.sweep(route)))
    sweeper.report('writes', { findings, failures: sweeper.failures, called: sweeper.called.filter((call) => !call.route.startsWith('GET ')), unresolved: sweeper.unresolved() })
    expect(findings).toEqual([])
  }, 1_800_000)

  // ---- the named leftovers of B-PR-04…09, each with its decision ----------------------------------------------------------------

  /** One call as a session, its status and body (the sweep's answers are not needed here). */
  const as = async (session: string, method: Method, url: string, payload?: unknown): Promise<{ status: number; body: Json }> => {
    const response = await app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': newId() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
    let body: Json = {}
    try {
      body = response.json() as Json
    } catch {
      body = {}
    }
    return { status: response.statusCode, body }
  }
  const everyCustomerOnly = async (url: string, method: Method = 'GET', payload?: unknown, everyCustomerReads = method === 'GET'): Promise<void> => {
    const limited = await as('office.p2', method, url, payload)
    expect([limited.status, limited.body.error?.message], `${method} ${url}`).toEqual([403, EVERY_PARTY_WORDS.en])
    if (everyCustomerReads) expect((await as('office.all', method, url, payload)).status, `${method} ${url} (every customer)`).toBe(200)
  }
  const idsIn = (body: unknown): Set<string> => new Set(JSON.stringify(body).match(UUID) ?? [])

  it('CAPA: a CAPA of another customer, or one answering another customer’s NCR, is neither listed nor found', async () => {
    const hidden = await admin<{ id: string }>(
      `SELECT c.id FROM "Capa" c WHERE c."customerId" = $1
       UNION SELECT s."capaId" FROM "CapaSource" s JOIN "Nonconformance" n ON n.id = s."recordId" JOIN "WorkOrder" o ON o.id = n."workOrderId" WHERE s."recordType" = 'Nonconformance' AND o."partyId" = $1`,
      [ids.a],
    )
    expect(hidden.length, 'the seeds hold a CAPA of A’s').toBeGreaterThan(0)
    const listed = idsIn((await as('office.p2', 'GET', '/quality/capa?view=all')).body)
    const all = idsIn((await as('office.all', 'GET', '/quality/capa?view=all')).body)
    for (const { id } of hidden) {
      expect(listed.has(id), `CAPA ${id} listed to brand B`).toBe(false)
      expect(all.has(id), `CAPA ${id} listed to the production unit`).toBe(true)
      expect((await as('office.p2', 'GET', `/quality/capa/${id}`)).status).toBe(404)
      expect((await as('office.all', 'GET', `/quality/capa/${id}`)).status).toBe(200)
    }
  })

  it('the styles list: another customer’s private-label styles are neither listed nor found; our own collection stays everyone’s', async () => {
    const privateOfA = await admin<{ id: string; code: string }>(`SELECT id, code FROM "Style" WHERE "brandPartyId" = $1 AND "tenantId" = $2`, [ids.a, ids.tenantId])
    expect(privateOfA.length).toBeGreaterThan(0)
    const ofB = (await as('office.p2', 'GET', `/product/styles?status=ALL&brandPartyId=${ids.a}`)).body
    const ofAll = (await as('office.all', 'GET', `/product/styles?status=ALL&brandPartyId=${ids.a}`)).body
    expect((ofB.styles as unknown[]).length).toBe(0)
    for (const style of privateOfA) {
      expect(idsIn(ofB).has(style.id), style.code).toBe(false)
      expect(idsIn(ofAll).has(style.id), style.code).toBe(true)
      expect((await as('office.p2', 'GET', `/product/styles/${style.id}`)).status).toBe(404)
    }
    expect(idsIn((await as('office.p2', 'GET', `/product/styles?status=ALL&q=${OWN_STYLE_CODE}`)).body).has(w.styleId), 'our own collection').toBe(true)
  })

  it('the subcontract orders’ own list: an order for another customer’s work order is hidden even from a person who reaches its workshop', async () => {
    const orders = await admin<{ id: string; partyId: string }>(`SELECT s.id, s."partyId" FROM "SubcontractOrder" s JOIN "WorkOrder" o ON o.id = s."workOrderId" WHERE o."partyId" = $1`, [ids.a])
    expect(orders.length).toBeGreaterThan(0)
    // A person limited to brand B AND the workshops: the workshop dimension alone let A's orders through.
    SESSIONS['office.p2w'] = { ...SESSIONS['office.p2']!, grants: [{ permissions: OFFICE_PERMISSIONS, companies: 'all', sites: 'all', parties: [ids.b, ...new Set(orders.map((order) => order.partyId))] }] }
    const listed = idsIn((await as('office.p2w', 'GET', '/purchasing/subcontracting/orders?open=false&limit=200')).body)
    for (const order of orders) {
      expect(listed.has(order.id)).toBe(false)
      expect((await as('office.p2w', 'GET', `/purchasing/subcontracting/orders/${order.id}`)).status).toBe(404)
      expect((await as('office.all', 'GET', `/purchasing/subcontracting/orders/${order.id}`)).status).toBe(200)
    }
  })

  // ── fix-pr-3 ──
  it('approvals: a request on what we buy from customer A (A also supplies) is neither listed nor found by brand B; the production unit reads it', async () => {
    // The seeds' PO2 is a draft purchase order to the brand P1 (= A) for its own branded protectors, waiting for a yes.
    const tasks = await admin<{ id: string }>(`SELECT t.id FROM "ApprovalTask" t JOIN "PurchaseOrder" p ON p.id = t."recordId" WHERE t."recordType" = 'PurchaseOrder' AND p."partyId" = $1 AND t."tenantId" = $2`, [ids.a, ids.tenantId])
    expect(tasks.length, 'the seeds hold a request on a purchase order to A').toBeGreaterThan(0)
    const limited = await as('office.p2', 'GET', '/approvals/tasks?status=ALL&limit=200')
    const all = await as('office.all', 'GET', '/approvals/tasks?status=ALL&limit=200')
    expect([limited.status, all.status]).toEqual([200, 200])
    expect(sweeper.scanForA(JSON.stringify(limited.body))).toEqual([])
    for (const { id } of tasks) {
      expect(idsIn(limited.body).has(id), `request ${id} listed to brand B`).toBe(false)
      expect(idsIn(all.body).has(id), `request ${id} listed to the production unit`).toBe(true)
      expect((await as('office.p2', 'GET', `/approvals/tasks/${id}`)).status).toBe(404)
      expect((await as('office.all', 'GET', `/approvals/tasks/${id}`)).status).toBe(200)
    }
  })
  // ── end fix-pr-3 ──

  it('the MPS screen, planning allocation, what-ifs, day sheets and the run log need every customer; the change list shows only reached work orders', async () => {
    await everyCustomerOnly(`/planning/strategy?siteId=${w.siteId}`)
    await everyCustomerOnly(`/planning/allocation?siteId=${w.siteId}`)
    await everyCustomerOnly(`/planning/allocation/workshops?siteId=${w.siteId}`)
    await everyCustomerOnly(`/planning/schedule/what-ifs?siteId=${w.siteId}`)
    await everyCustomerOnly(`/planning/schedule/day-sheets/paper?siteId=${w.siteId}`, 'GET', undefined, false)
    const run = (await admin<{ id: string }>(`SELECT id FROM "PlanningRun" WHERE "siteId" = $1 ORDER BY "startedAt" DESC LIMIT 1`, [w.siteId]))[0]
    if (run) await everyCustomerOnly(`/planning/runs/${run.id}/log`)
    const changes = (await as('office.p2', 'GET', `/planning/schedule/changes?siteId=${w.siteId}`)).body
    expect(sweeper.scanForA(JSON.stringify(changes))).toEqual([])
  })

  it('the warehouse is one stock for every customer: its ledger, stock and their exports need every customer; a work order’s own kit stays its customer’s', async () => {
    await everyCustomerOnly(`/inventory/ledger?siteId=${w.siteId}`)
    await everyCustomerOnly(`/inventory/stock?siteId=${w.siteId}`)
    await everyCustomerOnly(`/inventory/reservations?siteId=${w.siteId}`)
    await everyCustomerOnly(`/inventory/remnants?siteId=${w.siteId}`)
    const body = (listKey: string) => ({ listKey, format: 'CSV', query: `site=${w.siteId}`, columns: [{ key: 'when', label: 'When' }], title: 'Warehouse', locale: 'en' })
    for (const listKey of ['warehouse.moves', 'warehouse.stock', 'warehouse.lots', 'warehouse.hides', 'warehouse.locations']) {
      const refused = await as('office.p2', 'POST', '/exports', body(listKey))
      expect([refused.status, refused.body.error?.message], listKey).toEqual([403, EVERY_PARTY_WORDS.en])
    }
    // B's own work order (the seeds' SEED-WO-B001, brand two's): its kit and pick list stay B's to work.
    const own = (await admin<{ id: string }>(`SELECT id FROM "WorkOrder" WHERE "partyId" = $1 AND status = 'IN_PROGRESS' LIMIT 1`, [ids.b]))[0]
    if (own) expect((await as('office.p2', 'GET', `/inventory/kits/${own.id}`)).status).toBe(200)
    const ofA = (await admin<{ id: string }>(`SELECT id FROM "WorkOrder" WHERE "partyId" = $1 AND status = 'IN_PROGRESS' LIMIT 1`, [ids.a]))[0]!
    expect((await as('office.p2', 'GET', `/inventory/kits/${ofA.id}`)).status).toBe(404)
  })
})
