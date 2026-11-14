import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayRange } from '@nexus/factory-domain/core/time'
import { seedUuid } from '../../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../../env'
import { startHarness, type Harness } from '../../../../platform/auth/sessions/testing/harness'

/**
 * The ready KPIs (B-W2b-429; ANA-013, ANA-014, ANA-015, ANA-020, ANA-021, ANA-023; follow-up KP2:01) on the local stack with the
 * app's real routes and EVERY factory-db seed (made up), some of its rows moved by the test into the last days (what the
 * floor, the shipping desk and the warehouse would have recorded): the facts rebuilt, each KPI's value read by the one
 * calculation, and its drill listing the same records with the filters it needs — the drill's totals equal the KPI's value
 * over the same period. Refusals: a person without the records' list or the money grain, a period that runs backwards, a
 * person without the KPI library. Run with `node scripts/factory/run-pg-tests.mjs modules/insights/kpis/drills`.
 */

type Json = Record<string, any>

// A rebuild reads 30 days of every company's records: more than the 5 s default on a loaded machine.
vi.setConfig({ testTimeout: 180_000 })

const SEED_DIR = fileURLToPath(new URL('../../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'insights-kpis429'
const T = seedUuid(NS, 'tenant')

const PEOPLE = { owner: newId(), planner: newId(), sales: newId(), narrow: newId(), production: newId(), buyer: newId(), finance: newId(), admin: newId() } as const
type Person = keyof typeof PEOPLE
const ROLE_OF: Record<Person, string> = { owner: 'owner', planner: 'planner', sales: 'sales', narrow: 'sales', production: 'production_manager', buyer: 'buyer', finance: 'finance', admin: 'admin' }
const SESSIONS: Record<string, SessionContext> = {}
const grantOf = (role: string, parties: Grant['parties'] = 'all'): Grant => {
  const template = templateOf(role)!
  return { permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties }
}

let h: Harness
let app: FastifyInstance
const run = randomBytes(4).toString('hex')
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
/** Made-up moves of seeded rows past their own guards (the test plants what the desks would have recorded). */
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await h.db.admin.query('SET session_replication_role = replica')
  try {
    await h.db.admin.query(sql, values)
  } finally {
    await h.db.admin.query('SET session_replication_role = DEFAULT')
  }
}

async function call(person: Person, url: string, method: 'GET' | 'POST' = 'GET', payload?: unknown) {
  const response = await app.inject({ method, url, headers: { 'x-test-session': person, ...(method === 'POST' ? { 'idempotency-key': `k429-${run}-${newId()}` } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
  return { status: response.statusCode, body: response.json() as Json }
}
async function ok(person: Person, url: string, method: 'GET' | 'POST' = 'GET', payload?: unknown): Promise<Json> {
  const answer = await call(person, url, method, payload)
  expect(answer.status, `${person} ${method} ${url}: ${JSON.stringify(answer.body).slice(0, 600)}`).toBe(200)
  return answer.body
}
async function no(person: Person, url: string, status: number): Promise<string[]> {
  const answer = await call(person, url)
  expect(answer.status, `${person} GET ${url}: ${JSON.stringify(answer.body).slice(0, 600)}`).toBe(status)
  return ((answer.body.error?.issues ?? []) as Json[]).map((issue) => issue.path)
}

const ZONE = 'Europe/Rome'
const today = () => businessDate(new Date(), ZONE)
const day = (back: number) => plusDays(today(), -back)
/** An instant of a day on the company's clock (minutes after its midnight). */
const at = (back: number, minute: number) => new Date(businessDayRange(day(back), ZONE).start.getTime() + minute * 60_000)
const span = (back: number) => `from=${day(back)}&to=${today()}`
const idOf = async (table: string, number: string) => (await admin<{ id: string }>(`SELECT id FROM "${table}" WHERE "tenantId" = $1 AND number = $2`, [T, number]))[0]!.id

/** The KPI's value over its current period, and the drill over the same period: the drill's totals say the same. */
async function sameAsKpi(person: Person, key: string, drill: string, extra = '', pick: (answer: Json) => string | null) {
  const value = await ok(person, `/insights/kpis/${key}/value?periods=1`)
  const answer = await ok(person, `${drill}?from=${value.period.from}&to=${value.period.to}${extra}`)
  expect(pick(answer), key).toBe(value.value === null ? null : String(value.value))
  return { value, answer }
}

beforeAll(async () => {
  h = await startHarness('insights_kpis429')
  h.clock.set(new Date())
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  // A person limited to another party than the seeded orders' customer.
  const customer = (await admin<{ partyId: string }>(`SELECT "partyId" FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SEED-SO-0003'`, [T]))[0]!.partyId
  const partyNarrow = (await admin<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND id <> $2 ORDER BY code LIMIT 1`, [T, customer]))[0]!.id
  for (const [person, role] of Object.entries(ROLE_OF) as Array<[Person, string]>) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [PEOPLE[person], T, `k429-${person}-${run}@example.com`, `Made-up ${person}`])
    SESSIONS[person] = { audience: 'office', tenantId: T, actorId: PEOPLE[person], grants: [grantOf(role, person === 'narrow' ? [partyNarrow] : 'all')] }
  }

  // --- Made-up recent history on the seeded rows -----------------------------------------------------------------------------
  const so2 = await idOf('SalesOrder', 'SEED-SO-0002')
  const so3 = await idOf('SalesOrder', 'SEED-SO-0003')
  const so1 = await idOf('SalesOrder', 'SEED-SO-0001')
  // SO-0002: ordered 10 days ago, first promised 4 days ago, promised again for 2 days ago; one garment of each line due (the
  // rest closed short), both left 3 days ago: late on the first promise, on time on the current one; shipped complete in 7 days.
  await force(`UPDATE "SalesOrder" SET "orderDate" = $2::date, "originalPromiseDate" = $3::date, "promiseDate" = $4::date WHERE id = $1`, [so2, day(10), day(4), day(2)])
  await force(`UPDATE "SalesOrderLine" SET "promiseDate" = NULL, "closedShortQuantity" = quantity - 1 WHERE "orderId" = $1`, [so2])
  await force(`UPDATE "SalesOrderLine" SET "costAmount" = 100000 WHERE "orderId" = $1 AND seq = 10`, [so2])
  await force(`UPDATE "SalesOrderLine" SET "costAmount" = 75000 WHERE "orderId" = $1 AND seq = 20`, [so2])
  await force(`UPDATE "Shipment" SET "shippedAt" = $2 WHERE "tenantId" = $1 AND number = 'SEED-SH-0001'`, [T, at(3, 8 * 60 + 5)])
  // SO-0003: ordered 8 days ago, promised for yesterday, nothing left yet: late on both promises.
  await force(`UPDATE "SalesOrder" SET "orderDate" = $2::date, "originalPromiseDate" = $3::date, "promiseDate" = $3::date WHERE id = $1`, [so3, day(8), day(1)])
  await force(`UPDATE "SalesOrderLine" SET "promiseDate" = NULL WHERE "orderId" = $1`, [so3])
  // SO-0001: ordered 5 days ago from a quote first sent 12 days ago (its promises stay in the future).
  await force(`UPDATE "SalesOrder" SET "orderDate" = $2::date WHERE id = $1`, [so1, day(5)])
  await force(`UPDATE "QuoteVersion" SET "sentAt" = $2 WHERE "quoteId" = (SELECT qv."quoteId" FROM "SalesOrder" o JOIN "QuoteVersion" qv ON qv.id = o."quoteVersionId" WHERE o.id = $1)`, [so1, at(12, 10 * 60)])
  // Work orders making SO-0002: WO-0004 released 8 days ago, started 7 days ago, completed and closed 6 days ago; WO-0001 released
  // and started 6 days ago, in progress. WO-0003 (SO-0003) released 2 days ago, not started.
  await force(`UPDATE "WorkOrder" SET "releasedAt" = $2, "startedAt" = $3, "completedAt" = $4, "closedAt" = $4 WHERE "tenantId" = $1 AND number = 'SEED-WO-0004'`, [T, at(8, 7 * 60), at(7, 7 * 60 + 30), at(6, 12 * 60)])
  await force(`UPDATE "WorkOrder" SET "releasedAt" = $2, "startedAt" = $3 WHERE "tenantId" = $1 AND number = 'SEED-WO-0001'`, [T, at(6, 10 * 60), at(6, 11 * 60)])
  await force(`UPDATE "WorkOrder" SET "releasedAt" = $2 WHERE "tenantId" = $1 AND number = 'SEED-WO-0003'`, [T, at(2, 11 * 60)])
  // The hide cut 3 days ago.
  await force(`UPDATE "CutLog" SET "serverTime" = $2 WHERE "tenantId" = $1`, [T, at(3, 9 * 60)])
  // Receipts: GR-0001 posted 2 days ago, GR-0002 posted yesterday, both against a line confirmed for 2 days ago.
  await force(`UPDATE "PurchaseOrderLine" SET "confirmedDate" = $2::date WHERE id IN (SELECT "purchaseOrderLineId" FROM "GoodsReceiptLine" l JOIN "GoodsReceipt" r ON r.id = l."receiptId" WHERE r."tenantId" = $1 AND r.number IN ('SEED-GR-0001', 'SEED-GR-0002'))`, [T, day(2)])
  await force(`UPDATE "GoodsReceipt" SET "postedAt" = $2 WHERE "tenantId" = $1 AND number = 'SEED-GR-0001'`, [T, at(2, 10 * 60)])
  await force(`UPDATE "GoodsReceipt" SET status = 'POSTED', "postedAt" = $2 WHERE "tenantId" = $1 AND number = 'SEED-GR-0002'`, [T, at(1, 10 * 60)])

  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  await ok('owner', '/insights/facts/rebuild', 'POST', { from: day(30), to: today() })
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('on-time in full (ANA-013)', () => {
  it('lists the lines due on their first promise, late or on time, by customer, site and month; the totals are the KPI', async () => {
    const drill = await ok('owner', `/insights/kpis/drills/otif?${span(20)}`)
    expect(drill).toMatchObject({ kpiKey: 'delivery.otif', promise: 'FIRST', period: { from: day(20), to: today() } })
    const mine = (drill.rows as Json[]).filter((row) => row.order.number === 'SEED-SO-0002' || row.order.number === 'SEED-SO-0003')
    expect(mine.map((row) => [row.order.number, row.seq, row.promise, row.outcome, row.lateDays, row.due, row.completeOn])).toEqual([
      ['SEED-SO-0002', 10, day(4), 'LATE', 1, 1, day(3)],
      ['SEED-SO-0002', 20, day(4), 'LATE', 1, 1, day(3)],
      ['SEED-SO-0003', 10, day(1), 'LATE', 1, 4, null],
    ])
    expect(drill.overall.due).toBe((drill.rows as Json[]).length)
    expect(drill.byMonth.reduce((total: number, row: Json) => total + row.due, 0)).toBe(drill.overall.due)
    expect(drill.byCustomer.reduce((total: number, row: Json) => total + row.due, 0)).toBe(drill.overall.due)
    expect(drill.bySite.reduce((total: number, row: Json) => total + row.due, 0)).toBe(drill.overall.due)
    await sameAsKpi('owner', 'delivery.otif', '/insights/kpis/drills/otif', '', (answer) => answer.overall.pct)
  })

  it('on the promise of now the re-promised lines are on time; filters by outcome, customer and priority', async () => {
    const drill = await ok('owner', `/insights/kpis/drills/otif?${span(20)}&promise=CURRENT`)
    const mine = (drill.rows as Json[]).filter((row) => row.order.number === 'SEED-SO-0002' || row.order.number === 'SEED-SO-0003')
    expect(mine.map((row) => [row.order.number, row.promise, row.outcome]).sort()).toEqual([
      ['SEED-SO-0002', day(2), 'ON_TIME'],
      ['SEED-SO-0002', day(2), 'ON_TIME'],
      ['SEED-SO-0003', day(1), 'LATE'],
    ])
    expect(drill.kpiKey).toBe('delivery.otif_current')
    const late = await ok('owner', `/insights/kpis/drills/otif?${span(20)}&promise=CURRENT&outcome=LATE`)
    expect((late.rows as Json[]).every((row) => row.outcome === 'LATE')).toBe(true)
    const customer = mine.find((row) => row.order.number === 'SEED-SO-0003')!.customer.id
    const one = await ok('owner', `/insights/kpis/drills/otif?${span(20)}&promise=CURRENT&partyId=${customer}`)
    expect((one.rows as Json[]).every((row) => row.customer.id === customer)).toBe(true)
    const priority = mine[0]!.priority
    expect(((await ok('owner', `/insights/kpis/drills/otif?${span(20)}&priority=${priority}`)).rows as Json[]).every((row) => row.priority === priority)).toBe(true)
    await sameAsKpi('owner', 'delivery.otif_current', '/insights/kpis/drills/otif', '&promise=CURRENT', (answer) => answer.overall.pct)
  })

  it('a person limited to another customer sees none of these lines; the KPI is computed on their own records', async () => {
    const drill = await ok('narrow', `/insights/kpis/drills/otif?${span(20)}`)
    expect((drill.rows as Json[]).map((row) => row.order.number)).not.toContain('SEED-SO-0003')
    expect((drill.rows as Json[]).map((row) => row.order.number)).not.toContain('SEED-SO-0002')
    expect((await ok('narrow', '/insights/kpis/delivery.otif/value?periods=1')).live).toBe(true)
  })
})

describe('lead times (ANA-014)', () => {
  it('quote to order, order to ship and order to start: each order with its days, the median and spread by product family', async () => {
    const ship = await ok('owner', `/insights/kpis/drills/lead-times?${span(20)}&kind=ORDER_TO_SHIP`)
    expect((ship.rows as Json[]).find((row) => row.order.number === 'SEED-SO-0002')).toMatchObject({ fromDay: day(10), toDay: day(3), days: 7 })
    const quote = await ok('owner', `/insights/kpis/drills/lead-times?${span(20)}&kind=QUOTE_TO_ORDER`)
    expect((quote.rows as Json[]).find((row) => row.order.number === 'SEED-SO-0001')).toMatchObject({ fromDay: day(12), toDay: day(5), days: 7 })
    const start = await ok('owner', `/insights/kpis/drills/lead-times?${span(20)}&kind=ORDER_TO_START`)
    const so2 = (start.rows as Json[]).find((row) => row.order.number === 'SEED-SO-0002')!
    expect(so2).toMatchObject({ fromDay: day(10), toDay: day(7), days: 3 })
    expect(start.families.reduce((total: number, row: Json) => total + row.orders, 0)).toBe(start.overall.orders)
    const family = start.families.find((row: Json) => row.family === so2.family)
    expect(family.medianDays).not.toBeNull()
    expect(((await ok('owner', `/insights/kpis/drills/lead-times?${span(20)}&kind=ORDER_TO_START&family=${so2.family}`)).rows as Json[]).every((row) => row.family === so2.family)).toBe(true)
    for (const [key, kind] of [['delivery.order_to_ship_days', 'ORDER_TO_SHIP'], ['sales.quote_to_order_days', 'QUOTE_TO_ORDER'], ['production.order_to_start_days', 'ORDER_TO_START']] as const) {
      await sameAsKpi('owner', key, '/insights/kpis/drills/lead-times', `&kind=${kind}`, (answer) => answer.overall.averageDays)
    }
  })
})

describe('work in progress with ageing (ANA-015)', () => {
  it('lists the work orders in work with their age and garments waiting per stage; the pieces and the age are the KPIs', async () => {
    const drill = await ok('owner', '/insights/kpis/drills/wip')
    const numbers = (drill.rows as Json[]).map((row) => row.workOrder.number)
    expect(numbers).toEqual(expect.arrayContaining(['SEED-WO-0001', 'SEED-WO-0003']))
    expect(numbers).not.toContain('SEED-WO-0004')
    expect((drill.rows as Json[]).find((row) => row.workOrder.number === 'SEED-WO-0001')).toMatchObject({ ageDays: 6, releasedOn: day(6) })
    expect((drill.rows as Json[]).find((row) => row.workOrder.number === 'SEED-WO-0003')).toMatchObject({ ageDays: 2, waitedDays: 2, band: 'D0_2' })
    const pieces = await ok('owner', '/insights/kpis/production.wip_pieces/value?periods=1&period=DAY')
    expect(String(drill.overall.pieces)).toBe(String(pieces.value))
    const age = await ok('owner', '/insights/kpis/production.wip_age_days/value?periods=1&period=DAY')
    const rows = drill.rows as Json[]
    const weighted = rows.reduce((total, row) => total + row.pieces * row.ageDays, 0) / rows.reduce((total, row) => total + row.pieces, 0)
    expect(age.value).toBe((Math.round(weighted * 10) / 10).toFixed(1))
    // The owner holds the cost grain: values at cost; the planner neither costing nor grain: no value.
    expect(drill.overall.currency).toBe('EUR')
    const planner = await ok('planner', '/insights/kpis/drills/wip')
    expect(planner.overall.value).toBeUndefined()
    expect((planner.rows as Json[]).every((row) => row.value === undefined)).toBe(true)
    // Filters: released in a week, waited at least N days, on no line.
    const week = rows.find((row) => row.workOrder.number === 'SEED-WO-0003')!.week
    expect(((await ok('owner', `/insights/kpis/drills/wip?week=${week}`)).rows as Json[]).every((row) => row.week === week)).toBe(true)
    expect(((await ok('owner', '/insights/kpis/drills/wip?minWaitDays=3')).rows as Json[]).map((row) => row.workOrder.number)).not.toContain('SEED-WO-0003')
    expect(((await ok('owner', '/insights/kpis/drills/wip?lineId=none')).rows as Json[]).every((row) => row.line === null)).toBe(true)
  })
})

describe('leather yield (ANA-020)', () => {
  it('lists the hides cut by grade, supplier lot and style; the totals are the KPI', async () => {
    const drill = await ok('owner', `/insights/kpis/drills/leather-yield?${span(20)}`)
    expect(drill.overall.hides).toBe(new Set((drill.rows as Json[]).map((row) => row.hide.id)).size)
    expect(drill.byGrade.reduce((total: number, row: Json) => total + Number(row.cutM2), 0)).toBeCloseTo(Number(drill.overall.cutM2), 3)
    expect(drill.byLot.reduce((total: number, row: Json) => total + Number(row.cutM2), 0)).toBeCloseTo(Number(drill.overall.cutM2), 3)
    await sameAsKpi('owner', 'production.leather_yield', '/insights/kpis/drills/leather-yield', '', (answer) => answer.overall.yieldPct)
    expect((await call('sales', `/insights/kpis/drills/leather-yield?${span(20)}`)).status).toBe(403)
  })
})

describe('margin quoted against actual (ANA-021)', () => {
  it('per order, customer and style on the garments that left with their cost of goods sold; the percents are the KPIs', async () => {
    const live = (await admin<{ total: string }>(
      `SELECT sum(e.amount)::text AS total FROM "CostOfSalesEntry" e JOIN "ShipmentLine" sl ON sl.id = e."shipmentLineId" JOIN "Shipment" s ON s.id = sl."shipmentId"
        WHERE e."tenantId" = $1 AND s.number = 'SEED-SH-0001' AND e."reversalOfId" IS NULL AND NOT EXISTS (SELECT 1 FROM "CostOfSalesEntry" r WHERE r."reversalOfId" = e.id)`,
      [T],
    ))[0]!.total
    const drill = await ok('finance', `/insights/kpis/drills/margin?${span(20)}`)
    const so2 = (drill.rows as Json[]).find((row) => row.order.number === 'SEED-SO-0002')!
    // One garment of each line: 160000 / 4 + 120000 / 3 = 80000; at order 100000 / 4 + 75000 / 3 = 50000.
    expect(so2).toMatchObject({ value: 80000, quotedCost: 50000, actualCost: Number(live), quotedMargin: 30000, quotedPct: '37.5' })
    expect(so2.actualPct).toBe((Math.round(((80000 - Number(live)) / 80000) * 1000) / 10).toFixed(1))
    expect(drill.byCustomer.length).toBeGreaterThan(0)
    expect(drill.byStyle.length).toBeGreaterThan(0)
    await sameAsKpi('finance', 'sales.margin_actual', '/insights/kpis/drills/margin', '', (answer) => answer.overall.actualPct)
    await sameAsKpi('finance', 'sales.margin_quoted', '/insights/kpis/drills/margin', '', (answer) => answer.overall.quotedPct)
    // Sales: margin and price, no cost: percents, no cost, no margin amount (with the price it would give the cost).
    const sales = (await ok('sales', `/insights/kpis/drills/margin?${span(20)}`)).rows.find((row: Json) => row.order.number === 'SEED-SO-0002')
    expect(sales).toMatchObject({ value: 80000, quotedPct: '37.5', quotedMargin: null, actualMargin: null })
    expect(sales.quotedCost).toBeUndefined()
    // No costing list, or no margin grain: refused in words.
    expect(await no('planner', `/insights/kpis/drills/margin?${span(20)}`, 403)).toEqual(['permission/costing.view'])
    expect(await no('production', `/insights/kpis/drills/margin?${span(20)}`, 403)).toEqual(['grain/margin'])
  })
})

describe('supplier on-time, shortages and cover (ANA-023)', () => {
  it('lists the receipt lines by supplier with their due day; the open shortages per work order; the cover of the leathers', async () => {
    const drill = await ok('buyer', `/insights/kpis/drills/supply?${span(20)}`)
    const mine = (drill.rows as Json[]).filter((row) => row.receipt.number === 'SEED-GR-0001' || row.receipt.number === 'SEED-GR-0002')
    expect(mine.map((row) => [row.receipt.number, row.due, row.postedOn, row.onTime, row.lateDays]).sort()).toEqual([
      ['SEED-GR-0001', day(2), day(2), true, 0],
      ['SEED-GR-0002', day(2), day(1), false, 1],
    ])
    expect(drill.bySupplier.reduce((total: number, row: Json) => total + row.received, 0)).toBe(drill.overall.received)
    expect(drill.shortages).not.toBeNull()
    expect(drill.cover).toMatchObject({ windowDays: 30 })
    await sameAsKpi('buyer', 'purchasing.supplier_on_time', '/insights/kpis/drills/supply', '', (answer) => answer.overall.pct)
    const category = mine[0]!.category
    expect(((await ok('buyer', `/insights/kpis/drills/supply?${span(20)}&category=${category}`)).rows as Json[]).every((row) => row.category === category)).toBe(true)
    const supplier = mine[0]!.supplier.id
    expect(((await ok('buyer', `/insights/kpis/drills/supply?${span(20)}&supplierId=${supplier}`)).rows as Json[]).every((row) => row.supplier.id === supplier)).toBe(true)
    // The warehouse-less finance desk has no purchasing list: refused.
    expect(await no('finance', `/insights/kpis/drills/supply?${span(20)}`, 403)).toEqual(['permission/purchasing.view'])
  })
})

describe('refusals in words', () => {
  it('a period that runs backwards or is too long, a person without the list or the library', async () => {
    expect(await no('owner', `/insights/kpis/drills/otif?from=${today()}&to=${day(3)}`, 400)).toEqual(['querystring/from'])
    expect(await no('owner', `/insights/kpis/drills/otif?from=${day(400)}&to=${today()}`, 400)).toEqual(['querystring/from'])
    expect(await no('owner', `/insights/kpis/drills/otif?from=${day(-3)}&to=${day(-5)}`, 400)).toEqual(['querystring/from'])
    expect(await no('buyer', `/insights/kpis/drills/otif?${span(20)}`, 403)).toEqual(['permission/orders.view'])
    expect((await call('admin', '/insights/kpis/drills/wip')).status).toBe(403)
    expect((await call('owner', '/insights/kpis/drills/wip?week=2026-46')).status).toBe(400)
  })

  it('names no person: no worker, operator or user field in any drill', async () => {
    for (const url of ['/insights/kpis/drills/otif', '/insights/kpis/drills/lead-times', '/insights/kpis/drills/wip', '/insights/kpis/drills/leather-yield', '/insights/kpis/drills/margin', '/insights/kpis/drills/supply']) {
      const text = JSON.stringify(await ok('owner', url))
      expect(text, url).not.toMatch(/"(worker|operator|cutter|user|person|employee)[A-Za-z]*"/i)
    }
  })
})
