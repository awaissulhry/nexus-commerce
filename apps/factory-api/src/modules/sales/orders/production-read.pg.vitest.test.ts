import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { findMarkers, markersOf, productionTwoBrands, twoBrandIds, twoBrandSessions, type Marker, type ProductionTwoBrands } from '../../production/testing/two-brands'
import { forgetProgress } from '../portal-orders/progress'
import { FINISH_SOURCES } from '@nexus/factory-domain/planning/promise-keep/risk' // F-SA-234b
import { SHARED_WORK_ORDER_WORDS } from './production-read' // B-OP-021
// B-OO-007: after production; the portal stays out of the office read.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { placeOf, waitingOn, type BlockerKind, type BlockerSub } from '@nexus/factory-domain/production-brand/waiting'

/**
 * B-SA-031 / B-SA-032 — the office's read of one sales order's production (`GET /sales/orders/:orderId/production`) and its
 * dates alone (`GET /sales/orders/:orderId/milestones`). Sales page plan P2, P3, P4, P16; 13-backend B1, B12; review WP-3. The
 * Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production unit,
 * should be able to see it all. And manage it all as well."
 *
 * On the local stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login), the
 * core, auth, roles, files, production and numbering seeds (Brand Alpha = the seeds' P1) and the production two-brand harness
 * (each brand's DRAFT work order of its own line; Brand Beta's on the threads' SEED-SO-B001 with its open issue; a work order
 * made before the one-customer rule with a cell of each brand). The test adds two more orders of Alpha, SO-A1 (40 pieces) and
 * SO-A2 (60), made by ONE work order of 100 pieces through the real route; a cut order that cuts SO-A1's cell with a cell of
 * Beta's work order; a raise of Alpha's health with an office note; a gate on Alpha's order. Sessions: `office.all` (every
 * customer), `office.p1` / `office.p2` (one customer each) with the production rights, and the Sales template's rights alone
 * (orders.view: no workorders.view, no planning.view) over every customer and over Alpha only. Every name is made up.
 *
 * Run with `node scripts/factory/run-pg-tests.mjs modules/sales/orders/production-read`.
 */

const ns = 'sa031-production-read'
const ids = twoBrandIds(ns)
const PERMISSIONS: Permission[] = ['orders.view', 'workorders.view', 'workorders.manage', 'quality.ncr.view', 'quality.inspections.view', 'planning.promise.view', 'threads.read']
const grant = (permissions: Permission[], parties: Grant['parties']): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const session = (...grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: ids.tenantId, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  ...twoBrandSessions(ids.tenantId, ids.a, ids.b, PERMISSIONS),
  // The Sales template's reach of production: orders.view alone.
  'sales.all': session(grant(['orders.view'], 'all')),
  'sales.p1': session(grant(['orders.view'], [ids.a])),
}
const B_SESSIONS = new Set(['office.p2'])

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let w: ProductionTwoBrands
let aMarkers: Marker[]
let bMarkers: Marker[]
const alpha = { so1: newId(), so2: newId(), line1: newId(), line2: newId(), workOrderId: '', workOrderNumber: '', cutOrder: newId(), gate: newId() }
const NOTE = 'T-SA031 office note: the leather supplier is two days late'

type Json = Record<string, any>
const seenByB: unknown[] = []
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const lit = (value: string): string => {
  if (!isUuid(value)) throw new Error(`not an id: ${value}`)
  return `'${value}'`
}
async function call(sessionName: string, url: string): Promise<{ status: number; body: Json; raw: string }> {
  const response = await app.inject({ method: 'GET', url, headers: { 'x-test-session': sessionName } })
  const body = response.headers['content-type']?.toString().startsWith('application/json') ? (response.json() as Json) : {}
  if (B_SESSIONS.has(sessionName)) seenByB.push(body)
  return { status: response.statusCode, body, raw: response.body }
}
async function ok(sessionName: string, url: string): Promise<Json> {
  const answer = await call(sessionName, url)
  expect(answer.status, `GET ${url}: ${answer.raw.slice(0, 600)}`).toBe(200)
  return answer.body
}
const production = (orderId: string, parts?: string) => `/sales/orders/${orderId}/production${parts ? `?parts=${parts}` : ''}`
const workOrderOf = (answer: Json, workOrderId: string): Json | undefined => (answer.work.workOrders as Json[]).find((row) => row.id === workOrderId)

beforeAll(async () => {
  forgetProgress()
  db = await migratedDatabase('sa031_prod_read')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  for (const seed of [seedCore, seedAuth, seedRoles, seedFiles]) await seed({ db: database, namespace: ns })
  await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  w = await productionTwoBrands({ db, database, app, namespace: ns })
  expect(w.a.partyId).toBe(ids.a)

  // Alpha's SO-A1 (40 pieces: 20 of 50, 20 of 52) and SO-A2 (60 of 54) of our own collection's jacket, made by ONE work order of
  // 100 pieces. A work order holds one cell per colourway and size (production/work-orders cells.ts clashProblems), so the two
  // orders' lines of the one colourway ask different sizes.
  const [harnessLine] = await admin<{ colourwayId: string; companyId: string }>(`SELECT "colourwayId", "companyId" FROM "SalesOrderLine" WHERE id = $1`, [w.a.salesOrderLineId])
  const actorId = seedUuid(ns, 'actor')
  const sizesOf: Readonly<Record<'A1' | 'A2', readonly (readonly [string, number])[]>> = { A1: [['50', 20], ['52', 20]], A2: [['54', 60]] }
  await database.withScope({ audience: 'office', tenantId: ids.tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      for (const [orderId, lineId, tag] of [[alpha.so1, alpha.line1, 'A1'], [alpha.so2, alpha.line2, 'A2']] as const) {
        const pieces = sizesOf[tag].reduce((sum, [, quantity]) => sum + quantity, 0)
        await tx.salesOrder.create({
          data: { id: orderId, companyId: harnessLine!.companyId, partyId: ids.a, number: `T-SA031-SO-${tag}`, customerRef: `T-SA031-PO-${tag}`, status: 'CONFIRMED', orderDate: new Date('2026-11-03T00:00:00.000Z'), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer' }, shipTo: { name: 'Made-up workshop' }, promiseDate: new Date('2026-12-20T00:00:00.000Z') },
          select: { id: true },
        })
        await tx.salesOrderLine.create({
          data: { id: lineId, companyId: harnessLine!.companyId, orderId, partyId: ids.a, seq: 10, kind: 'SIZE_GRID', styleId: w.styleId, colourwayId: harnessLine!.colourwayId, quantity: pieces, unitPrice: '100.000000', netAmount: pieces * 10_000, vatRatePct: '22.00', vatAmount: pieces * 2_200 },
          select: { id: true },
        })
        await tx.salesOrderLineSize.createMany({ data: sizesOf[tag].map(([size, quantity]) => ({ id: newId(), lineId, partyId: ids.a, size, quantity })) })
      }
    }),
  )
  const made = await app.inject({
    method: 'POST',
    url: '/production/work-orders',
    headers: { 'x-test-session': 'office.all' },
    payload: { siteId: w.siteId, lines: [{ salesOrderLineId: alpha.line1, sizes: [{ size: '50', quantity: 20 }, { size: '52', quantity: 20 }] }, { salesOrderLineId: alpha.line2, sizes: [{ size: '54', quantity: 60 }] }] },
  })
  expect(made.statusCode, made.body).toBe(201)
  ;({ id: alpha.workOrderId, number: alpha.workOrderNumber } = (made.json() as { workOrder: { id: string; number: string } }).workOrder)

  // A cut order that cuts SO-A1's size 50 with one of Beta's cells; Alpha's health raised by a person with an office note; a gate.
  const [cellA1] = await admin<{ id: string }>(`SELECT c.id FROM "WorkOrderSize" c WHERE c."workOrderId" = $1 AND c."salesOrderLineId" = $2 AND c.size = '50'`, [alpha.workOrderId, alpha.line1])
  const [cellB] = await admin<{ id: string }>(`SELECT id FROM "WorkOrderSize" WHERE "workOrderId" = $1 ORDER BY id LIMIT 1`, [w.b.workOrderId])
  const [item] = await admin<{ id: string }>(`SELECT id FROM "Item" WHERE "tenantId" = $1 ORDER BY id LIMIT 1`, [ids.tenantId])
  const today = businessDate(new Date())
  await admin(
    `BEGIN;
     SET LOCAL session_replication_role = replica;
     INSERT INTO "CutOrder" (id, "tenantId", "companyId", "siteId", number, kind, "itemId") VALUES (${lit(alpha.cutOrder)}, ${lit(ids.tenantId)}, ${lit(w.companyId)}, ${lit(w.siteId)}, 'T-SA031-CUT-1', 'FABRIC', ${lit(item!.id)});
     INSERT INTO "CutOrderLine" (id, "tenantId", "siteId", "cutOrderId", seq, "workOrderId", "workOrderSizeId", quantity) VALUES
       (${lit(newId())}, ${lit(ids.tenantId)}, ${lit(w.siteId)}, ${lit(alpha.cutOrder)}, 1, ${lit(alpha.workOrderId)}, ${lit(cellA1!.id)}, 20),
       (${lit(newId())}, ${lit(ids.tenantId)}, ${lit(w.siteId)}, ${lit(alpha.cutOrder)}, 2, ${lit(w.b.workOrderId)}, ${lit(cellB!.id)}, 2);
     UPDATE "BrandOrderProduction" SET health = 'ON_TRACK', "healthSet" = 'AT_RISK', "healthReasonCode" = 'MATERIAL_LATE', "healthNote" = '${NOTE}', "healthSetAt" = now(), "healthSetById" = ${lit(actorId)}, "healthSetUntil" = ('${today}'::date + 7) WHERE "salesOrderId" = ${lit(w.a.salesOrderId)};
     INSERT INTO "OrderGate" (id, "tenantId", "companyId", "partyId", "salesOrderId", kind, "targetDate") VALUES (${lit(alpha.gate)}, ${lit(ids.tenantId)}, ${lit(w.companyId)}, ${lit(ids.a)}, ${lit(w.a.salesOrderId)}, 'PP_SAMPLE', ('${today}'::date + 3));
     COMMIT;`,
  )

  aMarkers = [
    ...(await markersOf(db, ids.a)),
    { label: 'A order', text: w.a.salesOrderId },
    { label: 'A SO-A1', text: alpha.so1 },
    { label: 'A SO-A2', text: alpha.so2 },
    { label: 'A work order', text: alpha.workOrderId },
    { label: 'A work order number', text: alpha.workOrderNumber },
    { label: 'A note', text: NOTE },
  ]
  bMarkers = [...(await markersOf(db, ids.b)), { label: 'B order', text: w.b.salesOrderId }, { label: 'B work order', text: w.b.workOrderId }, { label: 'B work order number', text: w.b.workOrderNumber }]
}, 300_000)

afterAll(async () => {
  forgetProgress()
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('B-SA-031 GET /sales/orders/:orderId/production — the order’s OWN pieces', { timeout: 60_000 }, () => {
  it('counts only the order’s own cells when one work order makes SO-A1 and SO-A2 of Alpha (40 of 100)', async () => {
    const answer = await ok('office.all', production(alpha.so1))
    expect(answer.order).toMatchObject({ id: alpha.so1, number: 'T-SA031-SO-A1', status: 'CONFIRMED' })
    expect(answer.parts).toEqual(['headline', 'lines', 'work', 'dates', 'quality', 'people', 'changes'])
    expect(answer.withheld).toEqual([])
    expect(answer.refreshSeconds).toBe(60)
    // The line: 40 ordered, 40 in work orders — never the work order's 100.
    expect(answer.lines).toHaveLength(1)
    expect(answer.lines[0]).toMatchObject({ lineId: alpha.line1, ordered: 40, inWorkOrders: 40, notInWorkOrders: false, shipped: 0 })
    expect(answer.lines[0].sizes.map((size: Json) => [size.size, size.ordered]).sort()).toEqual([['50', 20], ['52', 20]])
    // The work order with THIS order's share, and the other order of the same customer it also makes, by number.
    const row = workOrderOf(answer, alpha.workOrderId)!
    // A draft: nothing cut or sewn counted yet (null, never a made-up 0); nothing released by quality (0).
    expect(row.own).toEqual({ cells: 2, pieces: 40, cut: null, sewn: null, checked: 0 })
    expect(row.alsoMakes).toEqual({ orders: [{ id: alpha.so2, number: 'T-SA031-SO-A2' }], more: 0 })
    expect(row).toMatchObject({ number: alpha.workOrderNumber, status: 'DRAFT', sharedWithOtherCustomers: false })
    expect(JSON.stringify(answer)).not.toMatch(/"pieces":100\b/)
    // A cut order that also cuts Beta's cell: "cut together with other work" — no other id, number or count.
    expect(row.cutWithOtherWork).toBe(true)
    expect(findMarkers(answer, bMarkers)).toEqual([])
    expect(JSON.stringify(answer)).not.toContain('T-SA031-CUT-1')
    // Every word block carries both languages.
    expect(() => partsWords(answer)).not.toThrow()
    // SO-A2 reads its own 60.
    const other = await ok('office.all', production(alpha.so2, 'lines,work'))
    expect(other.lines[0]).toMatchObject({ ordered: 60, inWorkOrders: 60 })
    expect(workOrderOf(other, alpha.workOrderId)!.own.pieces).toBe(60)
    expect(other).not.toHaveProperty('headline')
  })

  it('headline: the plain stage, counts in work (no names), the health with its raise, who acts next in words, the promise, the urgencies', async () => {
    const answer = await ok('office.all', production(w.a.salesOrderId, 'headline'))
    expect(Object.keys(answer).sort()).toEqual(['asOf', 'headline', 'order', 'parts', 'refreshSeconds', 'withheld'])
    const headline = answer.headline
    expect(headline.stage === null || typeof headline.stage.words.en === 'string').toBe(true)
    expect(headline.inWork).toEqual({ bundles: expect.any(Number), pieces: expect.objectContaining({ cutting: expect.any(Number) }) })
    expect(headline.health).toMatchObject({ code: 'AT_RISK', computed: 'ON_TRACK', raise: { reasonCode: 'MATERIAL_LATE', note: NOTE } })
    expect(typeof headline.waiting.words.en).toBe('string')
    for (const blocker of headline.waiting.blockers) expect(typeof blocker.words.it).toBe('string')
    expect(headline.promise).toMatchObject({ date: '2026-12-18', moves: 0 })
    expect(headline.urgency.officePriority).toMatchObject({ level: 'NORMAL' })
    expect(Array.isArray(headline.holdNotes)).toBe(true)
    // Worker privacy: no person of the floor, no station, no per-person output.
    expect(JSON.stringify(answer)).not.toMatch(/worker|operator|station|displayName/i)
  })

  it('the parts by right: the Sales template reads lines, headline, dates and changes; work, people, the office notes, quality and the forecast are withheld (null), never empty', async () => {
    const answer = await ok('sales.all', production(w.a.salesOrderId))
    expect(answer.withheld).toEqual(['work', 'people', 'headline.notes', 'quality.issues', 'quality.ncrs', 'quality.final', 'dates.forecast'])
    expect(answer.work).toBeNull()
    expect(answer.people).toBeNull()
    expect(answer.quality).toEqual({ issues: null, ncrs: null, final: null })
    expect(answer.dates.forecast).toBeNull()
    expect(answer.headline.holdNotes).toBeNull()
    // The raise is read (the chip and its reason), never the office's note or who raised it.
    expect(answer.headline.health.raise).toMatchObject({ reasonCode: 'MATERIAL_LATE', note: null, by: null, at: null })
    expect(JSON.stringify(answer)).not.toContain(NOTE)
    // The pieces stay the order's own (like progress=true on the list).
    expect(answer.lines.length).toBeGreaterThan(0)
  })

  it('people: the supervisor, the backup, who answers the customer and the places — a site, a line or a workshop; never an operator, a count or an output', async () => {
    const answer = await ok('office.all', production(w.a.salesOrderId, 'people'))
    const people = answer.people
    expect(Object.keys(people).sort()).toEqual(['answersCustomer', 'backup', 'places', 'supervisor'])
    expect(people.places.length).toBeGreaterThan(0)
    for (const place of people.places) {
      expect(Object.keys(place).sort()).toEqual(['line', 'site', 'team', 'workshop'])
      if (place.team) expect(Object.keys(place.team).sort()).toEqual(['code', 'name'])
    }
    expect(keysOf(people).filter((key) => /count|output|worker|operator|member/i.test(key))).toEqual([])
  })

  it('changes: the customer’s requests still waiting on the order', async () => {
    const answer = await ok('office.all', production(w.a.salesOrderId, 'changes'))
    expect(Array.isArray(answer.changes.openRequests)).toBe(true)
    for (const request of answer.changes.openRequests) expect(Object.keys(request).sort()).toEqual(['batchId', 'id', 'kind', 'since', 'status'])
  })

  it('refuses an unknown part in words', async () => {
    const answer = await call('office.all', production(w.a.salesOrderId, 'lines,money'))
    expect([answer.status, answer.body.error?.message]).toEqual([400, "Not a part of the order's production."])
  })

  it('the brand wall: a Beta-limited person gets 404 on Alpha’s order, word for word the answer of an unknown id', async () => {
    const unknown = await call('office.p2', production(newId()))
    for (const url of [production(w.a.salesOrderId), production(alpha.so1, 'lines'), production(alpha.so2, 'headline')]) {
      const refused = await call('office.p2', url)
      expect([refused.status, refused.body.error?.message], url).toEqual([404, 'Sales order not found.'])
      expect(refused.body.error?.message).toBe(unknown.body.error?.message)
      expect(unknown.status).toBe(404)
    }
    // Beta's own order reads, and nothing of Alpha is in it (the mixed work order's Alpha cell, Alpha's orders, the cut order).
    const own = await ok('office.p2', production(w.b.salesOrderId))
    expect(findMarkers(own, aMarkers)).toEqual([])
  })
})

/** Every key of an answer, at every depth. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf)
  if (value && typeof value === 'object') return Object.entries(value as Json).flatMap(([key, inner]) => [key, ...keysOf(inner)])
  return []
}

/** Every word block of an answer has both languages. */
function partsWords(answer: Json): void {
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(walk)
    if (value && typeof value === 'object') {
      const object = value as Json
      if ('it' in object || 'en' in object) {
        if (typeof object.it !== 'string' || typeof object.en !== 'string') throw new Error(`words without both languages: ${JSON.stringify(object)}`)
      }
      Object.values(object).forEach(walk)
    }
  }
  walk(answer)
}

describe('B-SA-032 work, dates and quality: what is made together with other work lends nothing of another customer', { timeout: 60_000 }, () => {
  it('a work order made before the one-customer rule: shown and marked for an every-customer reader, counted (never named) for an Alpha-limited one — its Alpha cell still counts in the order’s own pieces', async () => {
    const all = await ok('office.all', production(w.a.salesOrderId, 'lines,work'))
    const mixed = workOrderOf(all, w.mixed.workOrderId)!
    expect(mixed).toMatchObject({ number: w.mixed.number, sharedWithOtherCustomers: true })
    // Beta's order is neither named nor counted in "also makes".
    expect(mixed.alsoMakes).toEqual({ orders: [], more: 0 })
    expect(all.work.workOrdersLeftOut).toBe(0)
    expect(findMarkers(all.work, bMarkers)).toEqual([])
    const limited = await ok('office.p1', production(w.a.salesOrderId, 'lines,work,people'))
    expect(workOrderOf(limited, w.mixed.workOrderId)).toBeUndefined()
    expect(limited.work.workOrdersLeftOut).toBe(1)
    expect(JSON.stringify(limited)).not.toContain(w.mixed.workOrderId)
    expect(JSON.stringify(limited)).not.toContain(w.mixed.number)
    // The order's own pieces: Alpha's size 54 cell on the mixed work order counts (2 + 2 + 1 = 5 of the 10 in work orders).
    expect(limited.lines.find((line: Json) => line.lineId === w.a.salesOrderLineId)).toMatchObject({ ordered: 10, inWorkOrders: 5 })
    expect(all.lines.find((line: Json) => line.lineId === w.a.salesOrderLineId)).toMatchObject({ inWorkOrders: 5 })
    expect(findMarkers(limited, bMarkers)).toEqual([])
  })

  it('dates: the Sales template (no planning.view) reads its order’s gates and milestones, read only — no action; the forecast only with planning.promise.view', async () => {
    const answer = await ok('sales.p1', production(w.a.salesOrderId, 'dates'))
    const gate = (answer.dates.gates as Json[]).find((row) => row.id === alpha.gate)
    expect(gate).toMatchObject({ kind: 'PP_SAMPLE', state: 'WAITING' })
    expect(gate).not.toHaveProperty('actions')
    expect(answer.dates).not.toHaveProperty('mayAddGate')
    expect((answer.dates.milestones as Json[]).map((row) => row.kind)).toEqual(expect.arrayContaining(['GATE', 'SHIP']))
    expect(answer.dates.planned).toEqual({ cutStart: null, sewStart: null, finish: null })
    expect(answer.withheld).toEqual(['dates.forecast'])
    expect(answer.dates.forecast).toBeNull()
    const full = await ok('office.all', production(w.a.salesOrderId, 'dates'))
    expect(Array.isArray(full.dates.forecast)).toBe(true)
    expect(full.withheld).toEqual([])
    // F-SA-234b: each line's forecast says what sets its day (the order page's by-line forecast reads it from here).
    for (const row of full.dates.forecast as Json[]) expect(FINISH_SOURCES as readonly unknown[]).toContain(row.source)
  })

  it('GET …/milestones is the dates part alone (orders.view); Beta-limited: 404 as an unknown order', async () => {
    const answer = await ok('sales.all', `/sales/orders/${w.a.salesOrderId}/milestones`)
    expect(Object.keys(answer).sort()).toEqual(['asOf', 'dates', 'order', 'withheld'])
    expect((answer.dates.gates as Json[]).map((row) => row.id)).toContain(alpha.gate)
    const unknown = await call('office.p2', `/sales/orders/${newId()}/milestones`)
    const refused = await call('office.p2', `/sales/orders/${w.a.salesOrderId}/milestones`)
    expect([refused.status, refused.body.error?.message]).toEqual([404, 'Sales order not found.'])
    expect(refused.body.error?.message).toBe(unknown.body.error?.message)
  })

  it('quality: the order’s own open issues and NCRs behind the wall; Beta’s order reads its harness issue', async () => {
    const answer = await ok('office.p2', production(w.b.salesOrderId, 'quality'))
    expect((answer.quality.issues as Json[]).map((issue) => issue.id)).toContain(w.production.issue.id)
    expect(Array.isArray(answer.quality.ncrs)).toBe(true)
    expect(Array.isArray(answer.quality.final)).toBe(true)
    expect(findMarkers(answer, aMarkers)).toEqual([])
    // Alpha's order has none of Beta's issues.
    const alphaAnswer = await ok('office.all', production(w.a.salesOrderId, 'quality'))
    expect((alphaAnswer.quality.issues as Json[]).map((issue) => issue.id)).not.toContain(w.production.issue.id)
  })

  it('nothing Beta’s person got names anything of Alpha', () => {
    expect(seenByB.length).toBeGreaterThan(0)
    for (const body of seenByB) expect(findMarkers(body, aMarkers)).toEqual([])
  })
})

// ── B-SA-043 (sales page plan R1; review P6-4): extra pieces told honestly, office only ──
describe('B-SA-043: the order’s lines name the pieces made extra per size (office only)', { timeout: 60_000 }, () => {
  it('a line lowered under what is already cut reads its extra pieces per size, in words', async () => {
    // Alpha's work order in progress, with 20 of SO-A1's size 50 on a cut order; SO-A1 now wants 15 of it (a change after cutting).
    await admin(
      `BEGIN;
       SET LOCAL session_replication_role = replica;
       UPDATE "WorkOrder" SET status = 'IN_PROGRESS', "releasedAt" = now(), "startedAt" = now() WHERE id = ${lit(alpha.workOrderId)};
       UPDATE "SalesOrderLineSize" SET quantity = 15 WHERE "lineId" = ${lit(alpha.line1)} AND size = '50';
       COMMIT;`,
    )
    forgetProgress()
    const answer = await ok('office.all', production(alpha.so1, 'lines'))
    const line = (answer.lines as Json[])[0]!
    expect(line).toMatchObject({ lineId: alpha.line1, madeExtra: 5 })
    expect((line.sizes as Json[]).find((size) => size.size === '50')).toMatchObject({ madeExtra: 5, madeExtraWords: { en: 'Made extra: 5 50', it: 'Fatti in più: 5 50' } })
    expect((line.sizes as Json[]).find((size) => size.size === '52')).toMatchObject({ madeExtra: 0, madeExtraWords: null })
  })
})
// ── end B-SA-043 ──

// ── B-OP-021 (order page plan N1; 13-backend §3 B4, B6; review R-11, R-16) ──
/**
 * What the order page acts on in place: each work order with its version, kind, release, priority, its cells of THIS order's lines
 * only and the reader's rights by can() over it — one made before the one-customer rule read-only, in words; the ONE waiting list:
 * each blocker names its record (a work order only for a reader who reaches it) and what a customer request waiting on us is (an
 * open request, a counter-offer agreed or lapsed, a reported problem). The test adds to SO-A1 an open request and two countered ones
 * (the customer agreed to one counter-offer, the other lapsed), and a plain production hold on the mixed work order.
 */
describe('B-OP-021: work orders with version, own cells and rights; the ONE waiting list names each record', { timeout: 60_000 }, () => {
  const ask = { open: newId(), agreed: newId(), lapsed: newId(), counterAgreed: newId(), counterLapsed: newId() }
  const hold = newId()

  beforeAll(async () => {
    SESSIONS['office.release'] = session(grant(['orders.view', 'workorders.view', 'workorders.release', 'workorders.hold'], 'all'))
    const actorId = seedUuid(ns, 'actor')
    const t = lit(ids.tenantId)
    const company = lit(w.companyId)
    const alphaParty = lit(ids.a)
    await admin(
      `BEGIN;
       SET LOCAL session_replication_role = replica;
       INSERT INTO "ApprovalRequest" (id, "tenantId", "companyId", "recordType", "recordId", "partyId", kind, question, "dueAt", status, "answeredAt") VALUES
         (${lit(ask.counterAgreed)}, ${t}, ${company}, 'OrderChangeRequest', ${lit(ask.agreed)}, ${alphaParty}, 'REVISED_ORDER', 'T-OP021 counter-offer (made up)', now() + interval '3 days', 'APPROVED', now() - interval '1 day'),
         (${lit(ask.counterLapsed)}, ${t}, ${company}, 'OrderChangeRequest', ${lit(ask.lapsed)}, ${alphaParty}, 'REVISED_ORDER', 'T-OP021 counter-offer (made up)', now() - interval '1 day', 'EXPIRED', NULL);
       INSERT INTO "OrderChangeRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, status, "createdAt", "counterApprovalId", "counteredAt") VALUES
         (${lit(ask.open)}, ${t}, ${company}, ${alphaParty}, ${lit(alpha.so1)}, 'CHANGE', 'OPEN', now() - interval '3 days', NULL, NULL),
         (${lit(ask.agreed)}, ${t}, ${company}, ${alphaParty}, ${lit(alpha.so1)}, 'CHANGE', 'COUNTERED', now() - interval '6 days', ${lit(ask.counterAgreed)}, now() - interval '5 days'),
         (${lit(ask.lapsed)}, ${t}, ${company}, ${alphaParty}, ${lit(alpha.so1)}, 'CHANGE', 'COUNTERED', now() - interval '6 days', ${lit(ask.counterLapsed)}, now() - interval '5 days');
       INSERT INTO "WorkOrderHold" (id, "tenantId", "companyId", "siteId", "workOrderId", kind, "reasonCode", status, "placedAt", "placedById")
         SELECT ${lit(hold)}, ${t}, "companyId", "siteId", id, 'PRODUCTION', 'OTHER', 'ACTIVE', now() - interval '1 day', ${lit(actorId)} FROM "WorkOrder" WHERE id = ${lit(w.mixed.workOrderId)};
       COMMIT;`,
    )
    forgetProgress()
  })

  it('a work order carries its version, kind, release and priority, and its cells of THIS order only (never SO-A2’s)', async () => {
    const answer = await ok('office.all', production(alpha.so1, 'work'))
    const row = workOrderOf(answer, alpha.workOrderId)!
    const [stored] = await admin<{ version: number; kind: string; priority: number; releasedAt: Date | null }>(`SELECT version, kind::text AS kind, priority, "releasedAt" FROM "WorkOrder" WHERE id = $1`, [alpha.workOrderId])
    expect(row).toMatchObject({ version: stored!.version, kind: stored!.kind, priority: stored!.priority, releasedAt: stored!.releasedAt ? stored!.releasedAt.toISOString() : null })
    const own = await admin<{ id: string; size: string; quantity: number }>(`SELECT id, size, quantity FROM "WorkOrderSize" WHERE "workOrderId" = $1 AND "salesOrderLineId" = $2 ORDER BY size`, [alpha.workOrderId, alpha.line1])
    expect((row.cells as Json[]).map((cell) => [cell.id, cell.size, cell.quantity]).sort()).toEqual(own.map((cell) => [cell.id, cell.size, cell.quantity]).sort())
    for (const cell of row.cells as Json[]) {
      expect(cell.salesOrderLineId).toBe(alpha.line1)
      expect(cell.cut === null || typeof cell.cut === 'number').toBe(true)
    }
    // SO-A2's cell of the same work order (its 54) is never one of SO-A1's.
    expect((row.cells as Json[]).map((cell) => cell.size)).not.toContain('54')
    const other = workOrderOf(await ok('office.all', production(alpha.so2, 'work')), alpha.workOrderId)!
    expect((other.cells as Json[]).map((cell) => [cell.salesOrderLineId, cell.size])).toEqual([[alpha.line2, '54']])
  })

  it('rights by can() over the work order: manage for the manager, release and hold for the release desk, nothing for the Sales template', async () => {
    const manager = workOrderOf(await ok('office.all', production(alpha.so1, 'work')), alpha.workOrderId)!
    expect(manager.rights).toEqual({ manage: true, release: false, hold: false, why: null })
    const desk = workOrderOf(await ok('office.release', production(alpha.so1, 'work')), alpha.workOrderId)!
    expect(desk.rights).toEqual({ manage: false, release: true, hold: true, why: null })
    // A person limited to Alpha reaches Alpha's own work order with the same rights.
    expect(workOrderOf(await ok('office.p1', production(alpha.so1, 'work')), alpha.workOrderId)!.rights).toEqual({ manage: true, release: false, hold: false, why: null })
  })

  it('a work order shared with other customers (R-11) is read-only from the order, in words; it shows only this order’s cells', async () => {
    const answer = await ok('office.all', production(w.a.salesOrderId, 'work'))
    const mixed = workOrderOf(answer, w.mixed.workOrderId)!
    expect(mixed.sharedWithOtherCustomers).toBe(true)
    expect(mixed.rights).toEqual({ manage: false, release: false, hold: false, why: SHARED_WORK_ORDER_WORDS })
    expect(SHARED_WORK_ORDER_WORDS).toEqual({ en: 'Shared with other customers: change it on its page.', it: 'Condiviso con altri clienti: cambialo dalla sua pagina.' })
    expect((mixed.cells as Json[]).length).toBeGreaterThan(0)
    for (const cell of mixed.cells as Json[]) expect(cell.salesOrderLineId).toBe(w.a.salesOrderLineId)
    expect(findMarkers(mixed, bMarkers)).toEqual([])
  })

  it('the ONE waiting list: an open request, an agreed and a lapsed counter-offer wait on us, each naming its request', async () => {
    const { headline } = await ok('office.all', production(alpha.so1, 'headline'))
    const brandRequests = (headline.waiting.blockers as Json[]).filter((blocker) => blocker.kind === 'BRAND_REQUEST')
    expect(brandRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ on: 'US', sub: 'REQUEST', ref: { type: 'OrderChangeRequest', id: ask.open } }),
        expect.objectContaining({ on: 'US', sub: 'COUNTER', ref: { type: 'OrderChangeRequest', id: ask.agreed } }),
        expect.objectContaining({ on: 'US', sub: 'COUNTER', ref: { type: 'OrderChangeRequest', id: ask.lapsed } }),
      ]),
    )
    expect(brandRequests).toHaveLength(3)
    // Every other kind names no sub.
    for (const blocker of headline.waiting.blockers as Json[]) if (blocker.kind !== 'BRAND_REQUEST') expect(blocker.sub).toBeNull()
  })

  it('a gate names its record; a hold names its work order only for a reader who reaches it; a reported problem names the issue', async () => {
    const all = (await ok('office.all', production(w.a.salesOrderId, 'headline'))).headline.waiting.blockers as Json[]
    expect(all).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'GATE', ref: { type: 'OrderGate', id: alpha.gate }, sub: null }), expect.objectContaining({ kind: 'NO_MOVE', on: 'US', ref: { type: 'WorkOrder', id: w.mixed.workOrderId }, sub: null })]))
    // A person limited to Alpha does not reach the mixed work order: the blocker stays (it waits on us), with no door to it.
    const limited = await ok('office.p1', production(w.a.salesOrderId, 'headline'))
    const held = (limited.headline.waiting.blockers as Json[]).filter((blocker) => blocker.kind === 'NO_MOVE')
    expect(held.some((blocker) => blocker.ref === null)).toBe(true)
    for (const blocker of held) expect(blocker.ref?.id).not.toBe(w.mixed.workOrderId)
    expect(JSON.stringify(limited)).not.toContain(w.mixed.workOrderId)
    // The Sales template reads no work order at all: no work order named either.
    const sales = await ok('sales.all', production(w.a.salesOrderId, 'headline'))
    expect((sales.headline.waiting.blockers as Json[]).filter((blocker) => blocker.ref?.type === 'WorkOrder')).toEqual([])
    // Beta's own order: its reported problem names the issue; nothing of Alpha, and no door to the mixed work order.
    const beta = await ok('office.p2', production(w.b.salesOrderId, 'headline'))
    expect(beta.headline.waiting.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'BRAND_REQUEST', on: 'US', sub: 'PROBLEM', ref: { type: 'ProductionIssue', id: w.production.issue.id, messageId: expect.any(String) /* F-OP-103: the message it was raised with */ } })]))
    expect(findMarkers(beta, aMarkers)).toEqual([])
    expect(JSON.stringify(beta)).not.toContain(w.mixed.workOrderId)
  })

  it('R-16: each line and each of its sizes says what shipped (the edit floor), already in the read', async () => {
    const answer = await ok('office.all', production(alpha.so1, 'lines'))
    for (const line of answer.lines as Json[]) {
      expect(typeof line.shipped).toBe('number')
      for (const size of line.sizes as Json[]) expect(typeof size.shipped).toBe('number')
      expect((line.sizes as Json[]).reduce((sum, size) => sum + size.shipped, 0)).toBe(line.shipped)
    }
  })
})
// ── end B-OP-021 ──

// ── B-OO-007 (order overview plan §6, §5; review F11; N10b) ──
/**
 * Nothing is "now" once production is over: a shipped (ALL_DONE) or cancelled (STOPPED) order reads no health and no hold or date
 * wait — a customer's open problem still waits on us. The test gives Beta's order a health, a gate (a date) and a production hold on
 * its own work order (a hold), then sets its status to SHIPPED and to CANCELLED by hand (the guards off: only the read is under test)
 * and puts it back. The customer's portal reads the keeper's row and its own reader: the office read changes neither (the row is the
 * same before and after; no portal module imports the office read). "Moved N×": an order with no promise gets its first one through
 * the real route (0 moves), then a second (1 move).
 */
describe('B-OO-007: after production no health and no hold or date wait (requests stay); a first promise is not a move', { timeout: 60_000 }, () => {
  const beta = { gate: newId(), hold: newId(), status: '', closedAt: null as Date | null, cancelReason: null as string | null }
  const unpromised = { id: newId(), number: 'T-OO007-SO-P' }
  const keeperRow = async () => (await admin(`SELECT stage::text AS stage, "stageAt", health::text AS health, "waitingOn"::text AS "waitingOn", "waitingSince", version FROM "BrandOrderProduction" WHERE "salesOrderId" = $1`, [w.b.salesOrderId]))[0]
  const setBetaStatus = async (status: string, closedAt: Date | null, cancelReason: string | null) => {
    await admin(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE "SalesOrder" SET status = '${status}', "closedAt" = ${closedAt ? `'${closedAt.toISOString()}'` : 'NULL'}, "cancelReason" = ${cancelReason ? `'${cancelReason.replace(/'/g, "''")}'` : 'NULL'} WHERE id = ${lit(w.b.salesOrderId)}; COMMIT;`)
    forgetProgress()
  }
  const isProblem = (blocker: Json) => blocker.kind === 'BRAND_REQUEST' && blocker.sub === 'PROBLEM' && blocker.ref?.id === w.production.issue.id
  const placeOfRow = (blocker: Json) => placeOf({ kind: blocker.kind as BlockerKind, sub: (blocker.sub ?? null) as BlockerSub | null })

  beforeAll(async () => {
    SESSIONS['office.manage'] = session(grant(['orders.view', 'orders.manage', 'workorders.view'], 'all'))
    const [order] = await admin<{ status: string; closedAt: Date | null; cancelReason: string | null }>(`SELECT status::text AS status, "closedAt", "cancelReason" FROM "SalesOrder" WHERE id = $1`, [w.b.salesOrderId])
    Object.assign(beta, { status: order!.status, closedAt: order!.closedAt, cancelReason: order!.cancelReason })
    await admin(
      `BEGIN;
       SET LOCAL session_replication_role = replica;
       UPDATE "BrandOrderProduction" SET health = 'ON_TRACK' WHERE "salesOrderId" = ${lit(w.b.salesOrderId)};
       INSERT INTO "OrderGate" (id, "tenantId", "companyId", "partyId", "salesOrderId", kind, "targetDate")
         SELECT ${lit(beta.gate)}, "tenantId", "companyId", "partyId", id, 'LAB_PASSED', (current_date + 10) FROM "SalesOrder" WHERE id = ${lit(w.b.salesOrderId)};
       INSERT INTO "WorkOrderHold" (id, "tenantId", "companyId", "siteId", "workOrderId", kind, "reasonCode", status, "placedAt", "placedById")
         SELECT ${lit(beta.hold)}, "tenantId", "companyId", "siteId", id, 'PRODUCTION', 'OTHER', 'ACTIVE', now() - interval '1 day', ${lit(seedUuid(ns, 'actor'))} FROM "WorkOrder" WHERE id = ${lit(w.b.workOrderId)};
       COMMIT;`,
    )
    // An order of Alpha with no promise yet (its first one comes through the route below).
    const [owner] = await admin<{ companyId: string }>(`SELECT "companyId" FROM "SalesOrder" WHERE id = $1`, [alpha.so1])
    await database.withScope({ audience: 'office', tenantId: ids.tenantId, actorId: seedUuid(ns, 'actor') }, (client) =>
      client.salesOrder.create({
        data: { id: unpromised.id, companyId: owner!.companyId, partyId: ids.a, number: unpromised.number, customerRef: 'T-OO007-PO-P', status: 'CONFIRMED', orderDate: new Date('2026-11-03T00:00:00.000Z'), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer' }, shipTo: { name: 'Made-up workshop' } },
        select: { id: true },
      }),
    )
    forgetProgress()
  })

  afterAll(async () => {
    if (beta.status) await setBetaStatus(beta.status, beta.closedAt, beta.cancelReason)
  })

  it('while in production Beta’s order reads its health, its hold, its date and the customer’s open problem', async () => {
    const { headline } = await ok('office.all', production(w.b.salesOrderId, 'headline'))
    expect(headline.health).toMatchObject({ code: 'ON_TRACK' })
    const blockers = headline.waiting.blockers as Json[]
    expect(blockers).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'GATE', ref: { type: 'OrderGate', id: beta.gate } }), expect.objectContaining({ kind: 'NO_MOVE', ref: { type: 'WorkOrder', id: w.b.workOrderId } })]))
    expect(blockers.some(isProblem)).toBe(true)
    expect(new Set(blockers.map(placeOfRow))).toEqual(new Set(['HOLD', 'DATE', 'REQUEST']))
  })

  for (const [status, closed] of [['SHIPPED', false], ['CANCELLED', true]] as const) {
    it(`${status}: no health, no hold or date blocker; the customer’s open problem still waits on us; who acts next is the one rule over what still waits`, async () => {
      const before = await keeperRow()
      await setBetaStatus(status, closed ? new Date() : null, closed ? 'Made-up: the customer withdrew the order.' : null)
      const answer = await ok('office.all', production(w.b.salesOrderId, 'headline'))
      expect(answer.order.status).toBe(status)
      const { headline } = answer
      expect(headline.health).toBeNull()
      const blockers = headline.waiting.blockers as Json[]
      for (const blocker of blockers) expect(placeOfRow(blocker), JSON.stringify(blocker)).toBe('REQUEST')
      expect(blockers.find((blocker) => blocker.ref?.id === beta.gate)).toBeUndefined()
      expect(blockers.filter((blocker) => blocker.kind === 'NO_MOVE' || blocker.kind === 'BRAND_PAUSE' || blocker.kind === 'QUALITY_HOLD')).toEqual([])
      expect(blockers.filter(isProblem)).toHaveLength(1)
      const rule = waitingOn(blockers.map((blocker) => ({ kind: blocker.kind as BlockerKind, since: blocker.since ? new Date(blocker.since) : null })))
      expect({ on: headline.waiting.on, since: headline.waiting.since }).toEqual({ on: rule.on, since: rule.since ? rule.since.toISOString() : null })
      expect(headline.waiting.on).toBe(blockers.some((blocker) => blocker.on === 'BRAND') ? 'BRAND' : 'US')
      // The stage the work had reached stays (the office says "work had reached …"); the customer's history row is untouched.
      expect(await keeperRow()).toEqual(before)
      await setBetaStatus(beta.status, beta.closedAt, beta.cancelReason)
    })
  }

  it('the portal does not read the office read: no portal module imports it (production-contract is the office’s, routes.ts)', () => {
    const root = fileURLToPath(new URL('../../..', import.meta.url))
    const sources = (readdirSync(root, { recursive: true }) as string[]).filter((path) => path.endsWith('.ts') && !/\.(vitest\.)?test\.ts$/.test(path))
    const importers = sources.filter((path) => /from\s+'(?:\.\/|[^']*\/orders\/)production-(?:contract|read)'/.test(readFileSync(join(root, path), 'utf8'))).map((path) => path.split('\\').join('/')).sort()
    expect(importers).toContain('modules/sales/orders/routes.ts')
    expect(importers.filter((path) => /portal/.test(path))).toEqual([])
  })

  it('a first promise is not a move: 0 after the first, 1 after the second (the audit keeps both)', async () => {
    const later = (days: number) => businessDate(new Date(Date.now() + days * 86_400_000))
    const [stored] = await admin<{ version: number }>(`SELECT version FROM "SalesOrder" WHERE id = $1`, [unpromised.id])
    const promise = async (version: number, promiseDate: string, reason: string) => {
      const answer = await app.inject({ method: 'PUT', url: `/sales/orders/${unpromised.id}/promise`, headers: { 'x-test-session': 'office.manage' }, payload: { version, promiseDate, reason } })
      expect(answer.statusCode, answer.body).toBe(200)
      return (answer.json() as { order: { version: number } }).order.version
    }
    const none = (await ok('office.all', production(unpromised.id, 'headline'))).headline.promise
    expect(none).toMatchObject({ date: null, first: null, moved: false, moves: 0 })
    const version = await promise(stored!.version, later(30), 'Made-up: the first promise.')
    const firstRead = (await ok('office.all', production(unpromised.id, 'headline'))).headline.promise
    expect(firstRead).toMatchObject({ date: later(30), first: later(30), moved: false, moves: 0, slipDays: 0 })
    await promise(version, later(37), 'Made-up: the lining comes a week late.')
    const secondRead = (await ok('office.all', production(unpromised.id, 'headline'))).headline.promise
    expect(secondRead).toMatchObject({ date: later(37), first: later(30), moved: true, moves: 1, slipDays: 7 })
    const audits = await admin<{ n: string }>(`SELECT count(*)::text AS n FROM "AuditLog" WHERE "recordType" = 'SalesOrder' AND "recordId" = $1 AND action = 'orders.changePromise'`, [unpromised.id])
    expect(audits[0]!.n).toBe('2')
  })
})
// ── end B-OO-007 ──
