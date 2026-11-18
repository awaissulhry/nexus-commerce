import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { HEALTH_REASON_WORDS } from '@nexus/factory-domain/production-brand/words'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { workOrders as workOrderExport } from '../../../platform/exports/sources/work-orders'
import { findMarkers, markersOf, productionTwoBrands, twoBrandIds, twoBrandSessions, type Marker, type ProductionTwoBrands } from '../testing/two-brands'

/**
 * B-PR-34 — the work order list by risk, and PW-02 (06-tree §0.6: "Work orders list, counts, export file, search: rep-B gets only B;
 * ?brand=A → empty"); the Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as
 * the production unit, should be able to see it all. And manage it all as well."
 *
 * On a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the guards are real), the
 * core, files, production, numbering and reasons seeds and the production two-brand harness (brand A = the seeds' P1, brand B = the
 * threads' second brand; B-PR-15's production states). The test adds, through the app's real routes as `office.all`, work orders of
 * brand B in every risk — and the stored facts the risk reads: the keeper's production state of B's new orders (written in the
 * office scope, as the keeper writes it), one bar on the site's WORKING plan (the database's rules off for that one statement, as
 * the harness does):
 *
 *   A    the harness's work order of A, due 4 days ago                                 LATE (4 d)
 *   B1   the harness's work order of B (SEED-SO-B001), due in 20 days, planned to end in 30   AT_RISK (plan after due)
 *   B2   a new order of B waiting on the customer, due in 10 days                        BLOCKED (customer), waiting on BRAND
 *   B3   a new order of B, due in 5 days                                                 ON_TRACK
 *   B4   a new order of B raised to At risk by us (Capacity), due in 15 days               AT_RISK (raised)
 *   B5   on B3's order, due in 7 days, cancelled                                           no risk
 *   B6   on B3's order, due in 12 days, on a production hold                               BLOCKED (hold)
 *
 * Every answer `office.p2` (limited to B) gets is scanned for A's names, codes, numbers and ids. Every name and number is made up.
 * Run with `env -u FACTORY_REDIS_URL node scripts/factory/run-pg-tests.mjs modules/production/work-orders/work-orders-risk`.
 */

const ns = 'pr2i-risk'
const ids = twoBrandIds(ns)
const actorId = seedUuid(ns, 'actor')
const PERMISSIONS: Permission[] = ['workorders.view', 'workorders.manage', 'workorders.hold']
const SESSIONS: Record<string, SessionContext> = twoBrandSessions(ids.tenantId, ids.a, ids.b, PERMISSIONS)

const today = businessDate(new Date())
const day = (days: number) => plusDays(today, days)

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let w: ProductionTwoBrands
let aMarkers: Marker[]
const B = { b1: '', b2: '', b3: '', b4: '', b5: '', b6: '' }
const orders = { b2: '', b3: '', b4: '' }
const numbers = { b2: '' }
let alphaPo = ''

type Json = Record<string, any>
interface Seen {
  readonly url: string
  readonly body: unknown
}
const seenByB: Seen[] = []
async function call(session: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown): Promise<{ status: number; body: Json; raw: string }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
  const body = response.headers['content-type']?.toString().startsWith('application/json') ? (response.json() as Json) : {}
  if (session === 'office.p2') seenByB.push({ url: `${method} ${url}`, body })
  return { status: response.statusCode, body, raw: response.body }
}
async function ok(session: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, status = 200): Promise<Json> {
  const answer = await call(session, method, url, payload)
  expect(answer.status, `${method} ${url}: ${answer.raw.slice(0, 500)}`).toBe(status)
  return answer.body
}
const list = async (session: string, query = ''): Promise<Json> => ok(session, 'GET', `/production/work-orders?limit=200${query}`)
const listIds = async (session: string, query = ''): Promise<string[]> => ((await list(session, query)).workOrders as Json[]).map((row) => row.id as string)
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
const lit = (value: string): string => {
  if (!isUuid(value)) throw new Error(`not an id: ${value}`)
  return `'${value}'`
}
const callerOf = (session: string) => callerFor(database, { ...SESSIONS[session]!, requestId: newId() } as never)
const exportRows = async (session: string, address: string): Promise<Json[]> => {
  const page = await workOrderExport.read(callerOf(session), workOrderExport.query(new URLSearchParams(address)), null, 200)
  return page.rows as Json[]
}
const enWords = (code: string): string => workOrderExport.words!.en[code] ?? code
const versionOf = async (workOrderId: string): Promise<number> => (await one<{ version: number }>(`SELECT version FROM "WorkOrder" WHERE id = $1`, [workOrderId])).version

/** A made-up order of brand B with one goods line of the harness's own style (sizes 50 × 4, 52 × 4), as the office writes it. */
async function newOrderOfB(label: string): Promise<{ orderId: string; lineId: string; number: string }> {
  const orderId = newId()
  const lineId = newId()
  const number = `T-PR34-${label}-${orderId.slice(-6)}`
  const colourwayId = (await one<{ colourwayId: string }>(`SELECT "colourwayId" FROM "SalesOrderLine" WHERE id = $1`, [w.b.salesOrderLineId])).colourwayId
  await database.withScope({ audience: 'office', tenantId: ids.tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      await tx.salesOrder.create({
        data: { id: orderId, companyId: w.companyId, partyId: w.b.partyId, number, customerRef: `T-PR34-PO-${orderId.slice(-6)}`, status: 'CONFIRMED', orderDate: new Date('2026-11-05T00:00:00.000Z'), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer' }, shipTo: { name: 'Made-up workshop' }, promiseDate: new Date(`${day(40)}T00:00:00.000Z`) },
        select: { id: true },
      })
      await tx.salesOrderLine.create({
        data: { id: lineId, companyId: w.companyId, orderId, partyId: w.b.partyId, seq: 10, kind: 'SIZE_GRID', styleId: w.styleId, colourwayId, quantity: 8, unitPrice: '100.000000', netAmount: 80_000, vatRatePct: '22.00', vatAmount: 17_600 },
        select: { id: true },
      })
      await tx.salesOrderLineSize.createMany({ data: [['50', 4], ['52', 4]].map(([size, quantity]) => ({ id: newId(), lineId, partyId: w.b.partyId, size: size as string, quantity: quantity as number })) })
    }),
  )
  return { orderId, lineId, number }
}

/** A DRAFT work order of one cell of a line, due on `dueDate`, through the real route. */
async function workOrderOf(lineId: string, size: string, dueDate: string): Promise<string> {
  const { workOrder } = await ok('office.all', 'POST', '/production/work-orders', { siteId: w.siteId, dueDate, lines: [{ salesOrderLineId: lineId, sizes: [{ size, quantity: 1 }] }] }, 201)
  return workOrder.id as string
}

/** The keeper's production state of an order (as the keeper writes it, in the office scope). */
async function productionState(orderId: string, state: Json): Promise<void> {
  await database.withScope({ audience: 'office', tenantId: ids.tenantId, actorId }, (client) =>
    client.brandOrderProduction.create({ data: { id: newId(), companyId: w.companyId, partyId: w.b.partyId, salesOrderId: orderId, key: `brand-production:${orderId}`, stage: 'PREPARING', health: 'ON_TRACK', healthAt: new Date(), ...state }, select: { id: true } }),
  )
}

beforeAll(async () => {
  db = await migratedDatabase('pr2i_risk_list')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  await seedFiles({ db: database, namespace: ns })
  await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  await seedReasons({ db: database, namespace: ns })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  w = await productionTwoBrands({ db, database, app, namespace: ns })
  expect(w.a.partyId).toBe(ids.a)
  expect(w.b.partyId).toBe(ids.b)
  alphaPo = (await one<{ customerRef: string }>(`SELECT "customerRef" FROM "SalesOrder" WHERE id = $1`, [w.a.salesOrderId])).customerRef

  // A late; B1 due in 20 days and planned to end in 30.
  await ok('office.all', 'PATCH', `/production/work-orders/${w.a.workOrderId}`, { version: await versionOf(w.a.workOrderId), dueDate: day(-4) })
  await ok('office.all', 'PATCH', `/production/work-orders/${w.b.workOrderId}`, { version: await versionOf(w.b.workOrderId), dueDate: day(20) })
  B.b1 = w.b.workOrderId
  const site = w.siteId
  const line = seedUuid(ns, 'site:A1:line:L1')
  const working = (await admin<{ id: string }>(`SELECT id FROM "PlanVersion" WHERE "siteId" = $1 AND kind = 'WORKING'`, [site]))[0]?.id ?? newId()
  await db.admin.query(
    `BEGIN;
     SET LOCAL session_replication_role = replica;
     INSERT INTO "PlanVersion" ("id", "tenantId", "companyId", "siteId", "kind") SELECT ${lit(working)}, ${lit(w.tenantId)}, ${lit(w.companyId)}, ${lit(site)}, 'WORKING' WHERE NOT EXISTS (SELECT 1 FROM "PlanVersion" WHERE id = ${lit(working)});
     INSERT INTO "ScheduleSlot" ("id", "tenantId", "siteId", "planVersionId", "planKind", "workOrderId", "lineId", "startAt", "endAt", "minutes") VALUES (${lit(newId())}, ${lit(w.tenantId)}, ${lit(site)}, ${lit(working)}, 'WORKING', ${lit(B.b1)}, ${lit(line)}, '${day(29)}T08:00:00.000Z', '${day(30)}T10:00:00.000Z', 120);
     COMMIT;`,
  )

  // B's new orders and their production states: waiting on the customer; on us; on us and raised to At risk by us.
  const o2 = await newOrderOfB('B2')
  const o3 = await newOrderOfB('B3')
  const o4 = await newOrderOfB('B4')
  orders.b2 = o2.orderId
  orders.b3 = o3.orderId
  orders.b4 = o4.orderId
  numbers.b2 = o2.number
  await productionState(o2.orderId, { waitingOn: 'BRAND', waitingSince: new Date('2026-11-10T08:00:00.000Z') })
  await productionState(o3.orderId, { waitingOn: 'US', waitingSince: new Date('2026-11-10T08:00:00.000Z') })
  await productionState(o4.orderId, { waitingOn: 'US', waitingSince: new Date('2026-11-10T08:00:00.000Z'), healthSet: 'AT_RISK', healthReasonCode: 'CAPACITY', healthNote: 'Made-up: line 2 is short of people this week.', healthSetAt: new Date(), healthSetById: actorId, healthSetUntil: new Date(`${day(7)}T00:00:00.000Z`) })
  B.b2 = await workOrderOf(o2.lineId, '50', day(10))
  B.b3 = await workOrderOf(o3.lineId, '50', day(5))
  B.b4 = await workOrderOf(o4.lineId, '50', day(15))
  B.b5 = await workOrderOf(o3.lineId, '52', day(7))
  B.b6 = await workOrderOf(o3.lineId, '50', day(12))
  await ok('office.all', 'POST', `/production/work-orders/${B.b5}/cancel`, { version: await versionOf(B.b5), reason: 'Made-up: not needed any more.' })
  await ok('office.all', 'POST', `/production/work-orders/${B.b6}/holds`, { reasonCode: 'MATERIAL_MISSING' }, 201)

  aMarkers = [...(await markersOf(db, w.a.partyId)), { label: 'mixed work order', text: w.mixed.number }, { label: 'mixed work order', text: w.mixed.workOrderId }]
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('risk and waiting on per row (B-PR-34)', { timeout: 60_000 }, () => {
  it('each row says its risk and what its order waits on, from what is stored', async () => {
    const { workOrders } = await list('office.p2')
    const row = (id: string) => (workOrders as Json[]).find((entry) => entry.id === id)!
    expect(row(B.b1).risk).toEqual({ state: 'AT_RISK', daysLate: null, plannedEnd: day(30), planAfterDue: true, raised: null, blockedBy: null })
    expect(row(B.b1).waitingOn).toEqual({ on: 'US', since: '2026-10-29T08:20:00.000Z' })
    expect(row(B.b2).risk).toMatchObject({ state: 'BLOCKED', blockedBy: 'CUSTOMER', raised: null })
    expect(row(B.b2).waitingOn).toEqual({ on: 'BRAND', since: '2026-11-10T08:00:00.000Z' })
    expect(row(B.b3).risk).toMatchObject({ state: 'ON_TRACK', blockedBy: null, planAfterDue: false, plannedEnd: null })
    expect(row(B.b4).risk).toMatchObject({ state: 'AT_RISK', raised: 'CAPACITY', planAfterDue: false })
    expect(row(B.b5)).toMatchObject({ status: 'CANCELLED', risk: null, waitingOn: null })
    expect(row(B.b6)).toMatchObject({ status: 'ON_HOLD', risk: { state: 'BLOCKED', blockedBy: 'HOLD' }, waitingOn: { on: 'US' } })
    // The production unit: A's late work order with its days.
    const all = await list('office.all')
    expect((all.workOrders as Json[]).find((entry) => entry.id === w.a.workOrderId)).toMatchObject({ risk: { state: 'LATE', daysLate: 4 }, waitingOn: { on: 'US' } })
  })

  it('sort=risk: late, at risk, blocked, on track, finished — each by due date; sort=due by due date; newest stays the default', async () => {
    expect(await listIds('office.p2', '&sort=risk')).toEqual([B.b4, B.b1, B.b2, B.b6, B.b3, B.b5])
    expect(await listIds('office.p2', '&sort=due')).toEqual([B.b3, B.b5, B.b2, B.b6, B.b4, B.b1])
    expect(await listIds('office.p2')).toEqual([...Object.values(B)].sort().reverse())
    expect(await listIds('office.p2', '&sort=newest')).toEqual([...Object.values(B)].sort().reverse())
    // Every customer's rows in one risk order for the production unit (ranks never go back).
    const rank = (row: Json) => (row.risk === null ? 4 : ['LATE', 'AT_RISK', 'BLOCKED', 'ON_TRACK'].indexOf(row.risk.state))
    const ranks = ((await list('office.all', '&sort=risk')).workOrders as Json[]).map(rank)
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y))
    expect(ranks[0]).toBe(0)
  })

  it('pages a computed sort with its own cursor; a cursor of another sort is refused in words', async () => {
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const page: Json = await ok('office.p2', 'GET', `/production/work-orders?sort=risk&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      seen.push(...(page.workOrders as Json[]).map((row) => row.id as string))
      cursor = page.nextCursor as string | null
      if (cursor) expect(cursor.startsWith('risk~')).toBe(true)
      pages++
    } while (cursor && pages < 10)
    expect(pages).toBe(3)
    expect(seen).toEqual([B.b4, B.b1, B.b2, B.b6, B.b3, B.b5])
    const first = await ok('office.p2', 'GET', '/production/work-orders?sort=risk&limit=2')
    const wrong = await call('office.p2', 'GET', `/production/work-orders?sort=due&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)
    expect(wrong.status).toBe(400)
    expect(wrong.raw).toMatch(/start from the first page/)
    expect((await call('office.p2', 'GET', `/production/work-orders?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)).status).toBe(400)
    // Newest first still pages by the last id.
    const newest = await ok('office.p2', 'GET', '/production/work-orders?limit=2')
    expect(isUuid(newest.nextCursor)).toBe(true)
    expect(((await ok('office.p2', 'GET', `/production/work-orders?limit=2&cursor=${newest.nextCursor}`)).workOrders as Json[]).length).toBe(2)
  })

  it('filters by what it waits on, its risk and what blocks it (open work orders)', async () => {
    expect(await listIds('office.p2', '&waitingOn=BRAND')).toEqual([B.b2])
    expect(await listIds('office.p2', '&waitingOn=US&sort=due')).toEqual([B.b3, B.b6, B.b4, B.b1])
    expect(await listIds('office.p2', '&risk=AT_RISK&sort=risk')).toEqual([B.b4, B.b1])
    expect(await listIds('office.p2', '&risk=LATE')).toEqual([])
    expect(await listIds('office.p2', '&blockedBy=HOLD')).toEqual([B.b6])
    expect(await listIds('office.p2', '&blockedBy=CUSTOMER')).toEqual([B.b2])
    expect(await listIds('office.all', '&risk=LATE')).toContain(w.a.workOrderId)
    expect((await call('office.p2', 'GET', '/production/work-orders?sort=sideways')).status).toBe(400)
    expect((await call('office.p2', 'GET', '/production/work-orders?waitingOn=SOMEONE')).status).toBe(400)
  })

  it('the tiles count at risk and waiting on the customer over the open work orders', async () => {
    expect((await ok('office.p2', 'GET', '/production/work-orders/counts')).counts).toMatchObject({ late: 0, onHold: 1, atRisk: 2, waitingOnCustomer: 1 })
    expect((await ok('office.all', 'GET', `/production/work-orders/counts?partyId=${w.b.partyId}`)).counts).toMatchObject({ late: 0, atRisk: 2, waitingOnCustomer: 1 })
    expect((await ok('office.all', 'GET', `/production/work-orders/counts?partyId=${w.a.partyId}`)).counts.late).toBeGreaterThanOrEqual(1)
  })

  it('search finds a customer, its orders’ number and customer PO', async () => {
    // SEED-SO-B001's PO: B1, and the mixed work order made before the rule (a cell of that order) for the production unit only.
    expect((await listIds('office.all', `&q=${encodeURIComponent('SEED-B-PO-1')}`)).sort()).toEqual([B.b1, w.mixed.workOrderId].sort())
    expect(await listIds('office.p2', `&q=${encodeURIComponent('SEED-B-PO-1')}`)).toEqual([B.b1])
    expect(await listIds('office.all', `&q=${encodeURIComponent(numbers.b2)}`)).toEqual([B.b2])
    const byName = await listIds('office.all', `&q=${encodeURIComponent('Seed Brand Two')}`)
    expect(byName.sort()).toEqual([...Object.values(B)].sort())
    const byAlphaPo = await listIds('office.all', `&q=${encodeURIComponent(alphaPo)}`)
    expect(byAlphaPo).toContain(w.a.workOrderId)
    for (const id of Object.values(B)) expect(byAlphaPo).not.toContain(id)
  })

  it('the export writes the same: the sort, the filters and the risk, waiting-on and blocked-by cells in words', async () => {
    const rows = await exportRows('office.p2', 'view=all&sort=risk')
    expect(rows.map((row) => row.id)).toEqual([B.b4, B.b1, B.b2, B.b6, B.b3, B.b5])
    const cell = (column: string, id: string, from = rows) => workOrderExport.columns[column]!.value(from.find((row) => row.id === id), enWords)
    expect(cell('risk', B.b1)).toBe('At risk')
    expect(cell('risk', B.b4)).toBe(`At risk · raised: ${HEALTH_REASON_WORDS.CAPACITY.en}`)
    expect(cell('risk', B.b5)).toBeNull()
    expect(cell('waitingOn', B.b2)).toBe('Waiting on the customer')
    expect(cell('blockedBy', B.b2)).toBe('Customer')
    expect(cell('blockedBy', B.b6)).toBe('Hold')
    expect((await exportRows('office.p2', 'view=all&waitingOn=BRAND')).map((row) => row.id)).toEqual([B.b2])
    const all = await exportRows('office.all', 'view=all&risk=LATE')
    expect(cell('risk', w.a.workOrderId, all)).toBe('Late · 4 d')
    expect(Object.keys(workOrderExport.words!.it).sort()).toEqual(Object.keys(workOrderExport.words!.en).sort())
    expect(() => workOrderExport.query(new URLSearchParams('sort=sideways'))).toThrow(/not known/)
    expect(() => workOrderExport.query(new URLSearchParams('risk=MAYBE'))).toThrow(/not known/)
  })
})

describe('PW-02: a person limited to customer B never meets customer A', { timeout: 60_000 }, () => {
  it('list (every sort and filter), counts, export and search hold only B; A’s customer filter is empty', async () => {
    for (const query of ['', '&sort=risk', '&sort=due', '&waitingOn=US', '&risk=LATE', '&risk=AT_RISK', '&blockedBy=HOLD', '&blockedBy=CUSTOMER']) {
      const rows = (await list('office.p2', query)).workOrders as Json[]
      for (const row of rows) expect(row.partyId, `${query}: ${row.number}`).toBe(w.b.partyId)
      expect(rows.map((row) => row.id), query).not.toContain(w.a.workOrderId)
      expect(rows.map((row) => row.id), query).not.toContain(w.mixed.workOrderId)
    }
    for (const query of ['', '&sort=risk', '&sort=due', '&risk=LATE', '&waitingOn=US']) expect(await listIds('office.p2', `&partyId=${w.a.partyId}${query}`), query).toEqual([])
    expect((await ok('office.p2', 'GET', `/production/work-orders/counts?partyId=${w.a.partyId}`)).counts).toEqual({ draft: 0, released: 0, inProgress: 0, completed: 0, open: 0, late: 0, onHold: 0, atRisk: 0, waitingOnCustomer: 0, mine: 0 /* B-PR-42a */ })
    for (const term of ['Seed Racing', 'SEED-C1', alphaPo, w.a.workOrderNumber]) expect(await listIds('office.p2', `&q=${encodeURIComponent(term)}`), term).toEqual([])
    expect(await exportRows('office.p2', `view=all&sort=risk&party=${w.a.partyId}`)).toEqual([])
    for (const row of await exportRows('office.p2', 'view=all&sort=risk')) expect(row.partyId).toBe(w.b.partyId)
    // A person limited to A meets none of B's either.
    for (const id of await listIds('office.p1', '&sort=risk')) expect(Object.values(B)).not.toContain(id)
  })

  it('nothing B’s person was answered names A (names, codes, numbers, references, ids)', async () => {
    await ok('office.p2', 'GET', '/production/work-orders?sort=risk&limit=2') // fix-pr-3: one page of 2 (list() already asks limit=200)
    expect(seenByB.length).toBeGreaterThan(10)
    const found = findMarkers(seenByB.map((seen) => seen.body), aMarkers)
    expect(found, JSON.stringify(found)).toEqual([])
  })
})

describe('a raise past its days no longer counts (B-PR-35 on the list)', { timeout: 60_000 }, () => {
  it('B4 reads on track once its raise reached its last day, before the keeper drops it', async () => {
    await admin(`UPDATE "BrandOrderProduction" SET "healthSetUntil" = $2::date WHERE key = $1`, [`brand-production:${orders.b4}`, today])
    const { workOrders } = await list('office.p2', '&sort=risk')
    expect((workOrders as Json[]).find((row) => row.id === B.b4)!.risk).toMatchObject({ state: 'ON_TRACK', raised: null })
    expect(await listIds('office.p2', '&risk=AT_RISK')).toEqual([B.b1])
  })
})
