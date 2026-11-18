import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import type { MigratedDatabase } from '@nexus/factory-db/testing'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { newId } from '@nexus/factory-domain/core/ids'
import { EVERY_PARTY_WORDS } from '@nexus/factory-domain/core/permissions'
// The factory-db seeding helpers are no package export: a test reads them where they live.
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { routesFiles } from '../../core/autoload'
import { buildApp } from '../../core/app'
import { testAuthenticator } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { useAbuseGuard } from '../../platform/abuse/guard'
import { startHarness, type Harness } from '../../platform/auth/sessions/testing/harness'
import type { Gateway } from '../../platform/gateway/gateway'
import { useGateway } from '../../platform/gateway/service'
import { customerTraces, type CustomerTraces } from './testing/customer-traces'
import { OWN_STYLE_CODE, productionTwoBrands, twoBrandIds, twoBrandSessions, walkWorkOrderRoutes, workOrderModels, type OfficeSession, type ProductionTwoBrands } from './testing/two-brands'
import { createWallSweep, EXEMPT, isOffice, UUID, type Finding, type Json, type Method } from './testing/wall-sweep'

/**
 * B-PR-10 — THE BRAND-WALL SWEEP (production plan §2 "Proof": "a sweep of every route, reads AND writes, that touches work
 * orders"; Appendix D PW-10 "writes with another brand's ids (bulk edit, Hold N, Release N, Travellers N, cut order)"). Owner rule
 * 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production unit, should be
 * able to see it all. And manage it all as well."
 *
 * 1. The manifest walker (./testing/two-brands.ts walkWorkOrderRoutes) lists EVERY route of any method whose handler reads
 *    WorkOrder, WorkOrderSize or a model that names one of them — from the schema, the routes files and the code, never a hand
 *    list. fix-pr-8: the sweep no longer stops there — it calls EVERY office route the app registers (its manifest audiences
 *    include office; the mail log and the stock card leaked while outside the walker's list); EXEMPT names each one left out
 *    and why (only a factory-wide route that refuses a person limited to some customers, or one that needs an outside service).
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
 * On the local stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login, on the
 * shared harness of platform/auth/sessions/testing), every seed file in name order (as `npm run seed`), the production two-brand
 * harness (A's and B's draft work orders through the real route, a mixed one made before the rule) and, fix-pr-8, the golden
 * production world's traces of A (./testing/customer-traces.ts: its portal people's sign-in mails, a mail from its order's
 * thread) beside the seeds' (its portal people, stock moves of its work orders, files, threads). Every name and number is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/production/brand-wall`.
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

// fix-pr-8: the seeds' owner, a real office person over every customer (a mail from a thread names its sender).
SESSIONS['office.owner'] = { audience: 'office', tenantId: ids.tenantId, actorId: seedUuid(ns, 'actor'), grants: [{ permissions: OFFICE_PERMISSIONS, companies: 'all', sites: 'all', parties: 'all' }] }

let h: Harness
let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let w: ProductionTwoBrands
let traces: CustomerTraces

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]

// ---- set-up ------------------------------------------------------------------------------------------------------------------

beforeAll(async () => {
  // fix-pr-8: the golden production world's harness (platform/auth/sessions/testing, urgency-world.ts's base): its sign-in
  // mails go through the e-mail runtime and its files to a local store, so A's people's mails are real rows.
  h = await startHarness('pr10_brand_wall')
  h.clock.set(new Date())
  db = h.db
  database = h.database
  // Every seed file in name order, as `npm run seed` (factory-db cli.ts): A (P1) owns records of every kind.
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: database, namespace: ns })
  }
  const plugins: FastifyPluginAsync[] = [sweeper.routeSpy]
  for (const file of routesFiles(SRC)) plugins.push(((await import(pathToFileURL(file).href)) as { default: FastifyPluginAsync }).default)
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET, rateLimit: { max: 1_000_000, perAddressMax: 1_000_000, timeWindowMs: 60_000 } },
    { database, officeAuth: h.auth, routes: plugins, authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  w = await productionTwoBrands({ db, database, app, namespace: ns })
  expect(w.a.partyId).toBe(ids.a)
  // fix-pr-8: the golden production world's traces of A beside the seeds' (A's people's sign-in mails, an order mail).
  traces = await customerTraces({ h, app, tenant: ns, companyCode: 'SCA', session: 'office.owner', partyId: ids.a, salesOrderId: w.a.salesOrderId })
  // For the sweep: the harness's own file store and mail (FAKE accounts: a file a route makes is kept in its temporary folder, a
  // mail goes to the fake mailbox — fix-pr-8: a route that makes a PDF is swept too), and no process gateway: a refusal answers
  // before it is reached; a route that reaches it is an outside service (EXEMPT names each one).
  useGateway(new Proxy({}, { get: () => () => { throw new Error('the sweep has no gateway') } }) as Gateway)
  await sweeper.prepare({ db, app, w, srcRoot: SRC, schemaDir: SCHEMA_DIR })
}, 900_000)

afterAll(async () => {
  useGateway(undefined)
  useAbuseGuard(undefined)
  await app?.close()
  await h?.close()
})

describe('B-PR-10 the brand-wall sweep', () => {
  it('the walker lists every route that reads a work order; the sweep calls every office route; the world holds every kind of A’s traces', () => {
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
    // fix-pr-8: every office route the app registers is swept, or EXEMPT with its reason — a route added later by itself.
    const swept = new Set([...sweeper.swept('read'), ...sweeper.swept('write')].map((route) => `${route.method} ${route.url}`))
    const office = [...sweeper.routes.values()].filter((route) => isOffice(route)).map((route) => `${route.method} ${route.url}`)
    expect(office.filter((key) => !swept.has(key) && !EXEMPT[key])).toEqual([])
    for (const key of Object.keys(EXEMPT)) expect(sweeper.routes.has(key), `EXEMPT ${key} is a registered route`).toBe(true)
    expect(swept.size).toBeGreaterThan(walked.length)
    // The golden production world's traces of A, here too: its portal people and their mails, stock moves of its work orders,
    // its files and threads (fix-pr-7 found the mail log and the stock card leaks only where they were).
    expect(traces).toEqual({ portalPeople: expect.any(Number), mails: expect.any(Number), stockMoves: expect.any(Number), files: expect.any(Number), threads: expect.any(Number) })
    for (const [kind, count] of Object.entries(traces)) expect(count, `A's ${kind}`).toBeGreaterThan(0)
    sweeper.report('summary', { officeRoutes: office.length, swept: swept.size, walked: walked.length, exempt: EXEMPT, traces, ambiguous: sweeper.ambiguous() })
  })

  it('every office GET, called by brand B with brand A ids: as unknown, empty or 403 EVERY_PARTY, never a word of A', async () => {
    const findings: Finding[] = []
    for (const route of sweeper.swept('read')) for (const variant of sweeper.variantsOf(route)) findings.push(...(await sweeper.sweep(route, variant)))
    const reads = sweeper.called.filter((call) => call.route.startsWith('GET '))
    sweeper.report('reads', { findings, failures: sweeper.failures, called: reads, unresolved: sweeper.unresolved() })
    const reached = reads.filter((call) => call.named > 0 && call.all !== null && call.all >= 200 && call.all < 300).length
    console.log(`B-PR-10 GET sweep: ${reads.length} calls; ${reached} named A's records the production unit reads`)
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

  // fix-pr-7 (found by the B-PR-36 golden flow's sweep: a person limited to B read the sign-in and order mails of A's people, their
  // records and addresses): the mail log and the blocked addresses are every customer's mail.
  it('fix-pr-7: the mail log and the blocked addresses need every customer', async () => {
    await everyCustomerOnly('/email/delivery')
    await everyCustomerOnly('/email/blocked')
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
    // fix-pr-7 (found by the B-PR-36 golden flow's sweep): a figure's explanation, the stock card, is the warehouse's too — the
    // issue of a hide to A's work order named A's work order number and the move to a person limited to B.
    const issued = (await admin<{ siteId: string; itemId: string }>(`SELECT m."siteId"::text AS "siteId", m."itemId"::text AS "itemId" FROM "StockMove" m JOIN "WorkOrder" o ON o.id = m."workOrderId" WHERE o."partyId" = $1 ORDER BY m.id LIMIT 1`, [ids.a]))[0]
    expect(issued, 'the seeds issue a hide to a work order of A').toBeDefined()
    await everyCustomerOnly(`/inventory/stock/card?siteId=${issued!.siteId}&itemId=${issued!.itemId}`)
    // B's own work order (the seeds' SEED-WO-B001, brand two's): its kit and pick list stay B's to work.
    const own = (await admin<{ id: string }>(`SELECT id FROM "WorkOrder" WHERE "partyId" = $1 AND status = 'IN_PROGRESS' LIMIT 1`, [ids.b]))[0]
    if (own) expect((await as('office.p2', 'GET', `/inventory/kits/${own.id}`)).status).toBe(200)
    const ofA = (await admin<{ id: string }>(`SELECT id FROM "WorkOrder" WHERE "partyId" = $1 AND status = 'IN_PROGRESS' LIMIT 1`, [ids.a]))[0]!
    expect((await as('office.p2', 'GET', `/inventory/kits/${ofA.id}`)).status).toBe(404)
  })

  // fix-pr-8: the write sweep runs last — it calls EVERY office write, so the named checks above read the world before it.
  it('PW-10: every office write, called by brand B with brand A ids, is refused as unknown and writes no row about A', async () => {
    const findings: Finding[] = []
    for (const route of sweeper.swept('write')) findings.push(...(await sweeper.sweep(route)))
    sweeper.report('writes', { findings, failures: sweeper.failures, called: sweeper.called.filter((call) => !call.route.startsWith('GET ')), unresolved: sweeper.unresolved() })
    expect(findings).toEqual([])
  }, 1_800_000)
})
