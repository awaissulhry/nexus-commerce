import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPlanningDepth } from '../../../../../../packages/factory-db/seed/planning-depth'
import { seed as seedQuality } from '../../../../../../packages/factory-db/seed/quality'
import { seed as seedReturns } from '../../../../../../packages/factory-db/seed/returns'
import { seed as seedSales } from '../../../../../../packages/factory-db/seed/sales'
import { seed as seedSalesOrdersDepth } from '../../../../../../packages/factory-db/seed/sales-orders-depth'
import { seed as seedSalesPricing } from '../../../../../../packages/factory-db/seed/sales-pricing'
import { seed as seedSamples } from '../../../../../../packages/factory-db/seed/samples'
import { seed as seedShipping } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { serverClock } from '../../../core/time'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * One demand view and the production strategy per item (B-W2b-319; PLN-017, PLN-040, PLN-041, PLN-042, PLN-061; design
 * planning.demand, planning.mps sec:strategy) through the app's real routes and real sign-ins (the system roles synced to their
 * templates: the planner and the production manager keep the strategy, the buyer does not), on a throwaway PostgreSQL 17 database
 * from the migrations. Seeds (all made up): the orders SEED-SO-0001 (JKT-01 BLK 2/4/2, RED 1/2/1), SEED-SO-0002 (JKT-02 BLK 1/2/1,
 * RED 1/1/1; SEED-SH-0001 shipped BLK 50 × 1 and RED 52 × 1), SEED-SO-0003 (JKT-03 BLK 52 × 4; its shipment a draft), SEED-SO-0004
 * (JKT-05 BLK 50 × 2, 52 × 2 with a delivery schedule, no making site), SEED-SO-W39-02 (in production) and SEED-SO-W39-01 (waiting
 * for a yes: not demand); the quote SEED-Q-0004 (sent, valid until 20 Dec: JKT-01 RED 52 × 3); the fit round SEED-SR-0001 (requested:
 * JKT-01 BLK 52 × 1); on SEED-WO-0001 one garment in rework and one sleeve to cut again; SEED-JKT-02-BLK-52 made to stock at A1; the
 * returns SEED-RMA-0001 (authorised) and SEED-RMA-0002 (a repair).
 * Run with `env -u FACTORY_REDIS_URL node scripts/factory/run-pg-tests.mjs modules/planning/demand`.
 */

vi.setConfig({ testTimeout: 90_000 })

type Json = Record<string, any>
const NS = 'w2b319-demand'
const idOf = (key: string): string => seedUuid(NS, key)
const tenant = idOf('tenant')
const companyA = idOf('company:A')
const siteA = idOf('site:A1')

let h: Harness
let planner: Browser
let manager: Browser
let buyer: Browser
let salesPerson: Browser
let counter = 0
const key = (label = 'k'): string => `w2b319-${label}-${++counter}-${newId()}`
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!

type Method = 'GET' | 'POST' | 'PUT'
async function as(browser: Browser, method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await browser.send(method as never, url, method === 'GET' ? undefined : (body ?? {}), { headers: method === 'GET' ? {} : { 'idempotency-key': key() } })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}
const issuesOf = (body: Json): string[] => (body.error?.issues ?? []).map((issue: Json) => String(issue.path))

async function officeBrowser(seedTenant: TestTenant, email: string, role: string): Promise<Browser> {
  const user = await addUser(h, seedTenant, { email, role })
  const browser = new Browser(h.app)
  expect((await browser.signIn(NS, user.email, user.password)).status).toBe(200)
  await enrolTotp(h, browser)
  return browser
}

const demand = (browser: Browser = planner, query = '') => as(browser, 'GET', `/planning/demand?siteId=${siteA}${query}`)
const rows = (query = '', browser: Browser = planner) => as(browser, 'GET', `/planning/demand/rows?siteId=${siteA}&limit=500${query}`)
const tileOf = (world: Json, layer: string): Json => world.tiles.find((tile: Json) => tile.layer === layer)
const rowOf = (world: Json, style: string, colourway: string | null): Json => world.rows.find((row: Json) => row.style.code === style && (row.colourway?.code ?? null) === colourway)
const today = () => businessDate(serverClock.now(), 'Europe/Rome')
// ---- B-W2b-F43: SEED-Q-0004 is valid until 20 Dec 2026 (seed/sales-pricing.ts q4ValidUntil). Its two sides are asked with the
// server's Date pinned to 09:00 UTC of its last valid day and of the day after (the harness's sign-in clock is apart), so both are
// checked whatever the real day is (they were checked by `today() <= '2026-12-20'`, one side a day).
const Q4_VALID_UNTIL = '2026-12-20'
const Q4_ENDED = '2026-12-21'
async function onDay<T>(day: string, read: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(`${day}T09:00:00.000Z`) })
  try {
    expect(today(), "the server's business day is the pinned one").toBe(day)
    return await read()
  } finally {
    vi.useRealTimers()
  }
}
// ---- end B-W2b-F43

let ids: { styles: Record<string, string>; colourways: Record<string, Record<string, string>>; items: Record<string, string>; orders: Record<string, string> }

beforeAll(async () => {
  h = await startHarness('planning_demand')
  h.clock.set(new Date())
  const context = { db: h.database, namespace: NS }
  await seedCore(context)
  await seedNumbering(context)
  await seedPlanningDepth(context)
  await seedSamples(context)
  await seedSales(context)
  await seedShipping(context)
  await seedQuality(context)
  await seedSalesPricing(context)
  await seedSalesOrdersDepth(context)
  await seedReturns(context)
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId }))
  const seedTenant: TestTenant = { id: tenant, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  planner = await officeBrowser(seedTenant, 'pia.planner@seed-a.example.com', 'planner')
  manager = await officeBrowser(seedTenant, 'pino.pm@seed-a.example.com', 'production_manager')
  buyer = await officeBrowser(seedTenant, 'bea.buyer@seed-a.example.com', 'buyer')
  salesPerson = await officeBrowser(seedTenant, 'sara.sales@seed-a.example.com', 'sales')
  const styles = await admin<{ id: string; code: string }>('SELECT id, code FROM "Style" WHERE "tenantId" = $1', [tenant])
  const colourways = await admin<{ id: string; styleId: string; code: string }>('SELECT id, "styleId", code FROM "Colourway" WHERE "tenantId" = $1', [tenant])
  const items = await admin<{ id: string; code: string }>('SELECT id, code FROM "Item" WHERE "tenantId" = $1', [tenant])
  const orders = await admin<{ id: string; number: string }>('SELECT id, number FROM "SalesOrder" WHERE "tenantId" = $1', [tenant])
  const styleCode = new Map(styles.map((row) => [row.id, row.code]))
  const byStyle: Record<string, Record<string, string>> = {}
  for (const row of colourways) (byStyle[styleCode.get(row.styleId)!] ??= {})[row.code] = row.id
  ids = {
    styles: Object.fromEntries(styles.map((row) => [row.code, row.id])),
    colourways: byStyle,
    items: Object.fromEntries(items.map((row) => [row.code, row.id])),
    orders: Object.fromEntries(orders.map((row) => [row.number, row.id])),
  }
}, 900_000)

afterAll(async () => {
  await h?.close()
}, 60_000)

/** What the open orders of company A still wait for, counted apart in SQL: ordered less shipped, not closed short. */
async function openOrderPieces(): Promise<number> {
  const open = `('CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED')`
  const ordered = await one<{ n: string }>(
    `SELECT COALESCE(SUM(z.quantity), 0)::text AS n FROM "SalesOrderLineSize" z JOIN "SalesOrderLine" l ON l.id = z."lineId" JOIN "SalesOrder" o ON o.id = l."orderId"
     WHERE o."companyId" = $1 AND o.status IN ${open} AND l."closedShortAt" IS NULL AND l.kind = 'SIZE_GRID'`,
    [companyA],
  )
  const shipped = await one<{ n: string }>(
    `SELECT COALESCE(SUM(sl.quantity), 0)::text AS n FROM "ShipmentLine" sl JOIN "Shipment" sh ON sh.id = sl."shipmentId" JOIN "SalesOrderLine" l ON l.id = sl."salesOrderLineId" JOIN "SalesOrder" o ON o.id = l."orderId"
     WHERE o."companyId" = $1 AND o.status IN ${open} AND sh.status IN ('SHIPPED', 'DELIVERED') AND l."closedShortAt" IS NULL`,
    [companyA],
  )
  return Number(ordered.n) - Number(shipped.n)
}

describe('one demand view: the tiles and the time-phased rows (PLN-017, PLN-040, PLN-041, PLN-042)', () => {
  it('counts every open piece of the site by layer: orders less what shipped, quotes likely to win apart, samples, remakes; the W3 layers unknown', async () => {
    const world = await demand()
    expect(world.site).toMatchObject({ id: siteA, code: 'A1' })
    expect(world.horizon).toMatchObject({ kind: 'WEEK', weeks: 26 })
    expect(world.horizon.buckets).toHaveLength(26)
    expect(world.tiles.map((tile: Json) => tile.layer)).toEqual(['ORDERS', 'QUOTES', 'MTM', 'SAMPLES', 'REMAKES', 'BRANDS', 'FORECAST'])
    expect(tileOf(world, 'BRANDS')).toEqual({ layer: 'BRANDS', known: false, pieces: null, sources: null, pastDue: null, undated: null, later: null, unplanned: null })
    // Orders: what the confirmed lines still wait for (SEED-SO-W39-01 waits for a yes; SEED-SH-0002 is a draft: neither counts).
    expect(tileOf(world, 'ORDERS')).toMatchObject({ known: true, pieces: await openOrderPieces(), unplanned: 0 })
    // SEED-SO-0004 size 50: one on the 15 Jan delivery, the other on no day (its line, its order: no date).
    expect(tileOf(world, 'ORDERS').undated).toBe(1)
    // The quote is likely to win while it is valid (20 Dec), and is never bought for.
    // ---- B-W2b-F43: on its last valid day and on the day after, whatever the real day.
    expect(tileOf(await onDay(Q4_VALID_UNTIL, () => demand()), 'QUOTES')).toMatchObject({ pieces: 3, unplanned: 3 })
    expect(tileOf(await onDay(Q4_ENDED, () => demand()), 'QUOTES')).toMatchObject({ pieces: 0, unplanned: 0 })
    // ---- end B-W2b-F43
    expect(tileOf(world, 'MTM')).toMatchObject({ pieces: 0, sources: 0 })
    expect(tileOf(world, 'SAMPLES')).toMatchObject({ pieces: 1, sources: 1, unplanned: 1 })
    expect(tileOf(world, 'REMAKES')).toMatchObject({ pieces: 2, sources: 2, unplanned: 2 })
    expect(world.unplaced).toEqual({ orderLines: 0, quoteLines: 0, sampleRounds: 0 })
    expect(world.truncated).toBe(false)
  })

  it('makes a row per style and colourway opened to sizes, with the strategy of its SKUs; quotes never in the firm total', async () => {
    const world = await demand()
    const jkt02Blk = rowOf(world, 'SEED-JKT-02', 'BLK')
    // 1/2/1 ordered, size 50 shipped: 52 × 2, 54 × 1; the rework and the recut of SEED-WO-0001 (BLK 52).
    expect(jkt02Blk.totals).toEqual({ ORDERS: 3, QUOTES: 0, MTM: 0, SAMPLES: 0, REMAKES: 2, firm: 5 })
    expect(jkt02Blk.sizes.map((size: Json) => [size.size, size.totals.firm])).toEqual([
      ['52', 4],
      ['54', 1],
    ])
    expect(jkt02Blk.strategy).toBe('MAKE_TO_STOCK')
    const jkt01Red = rowOf(world, 'SEED-JKT-01', 'RED')
    // ---- B-W2b-F43: its quote on its last valid day and on the day after (never in the firm total), whatever the real day.
    expect(jkt01Red.totals).toMatchObject({ ORDERS: 4, firm: 4 })
    expect(rowOf(await onDay(Q4_VALID_UNTIL, () => demand()), 'SEED-JKT-01', 'RED').totals).toMatchObject({ ORDERS: 4, QUOTES: 3, firm: 4 })
    expect(rowOf(await onDay(Q4_ENDED, () => demand()), 'SEED-JKT-01', 'RED').totals).toMatchObject({ ORDERS: 4, QUOTES: 0, firm: 4 })
    // ---- end B-W2b-F43
    expect(jkt01Red.strategy).toBe('MAKE_TO_ORDER')
    const jkt01Blk = rowOf(world, 'SEED-JKT-01', 'BLK')
    expect(jkt01Blk.totals).toMatchObject({ ORDERS: 8, SAMPLES: 1, firm: 9 })
    // Sparse cells: only buckets with a piece, each with the layers and the firm total.
    for (const cell of jkt01Blk.cells) expect(cell.firm).toBe(cell.ORDERS + cell.MTM + cell.SAMPLES + cell.REMAKES)
    expect(world.rows.map((row: Json) => `${row.style.code} ${row.colourway?.code ?? '*'}`)).toEqual([...world.rows.map((row: Json) => `${row.style.code} ${row.colourway?.code ?? '*'}`)].sort())
    // Months, and a style asked by its code.
    const months = await demand(planner, '&bucket=MONTH&weeks=13')
    expect(months.horizon).toMatchObject({ kind: 'MONTH', weeks: 13 })
    for (const bucket of months.horizon.buckets) expect(bucket.key).toMatch(/^\d{4}-\d{2}$/)
    const one02 = await demand(planner, '&q=jkt-02')
    expect(one02.rows.map((row: Json) => row.style.code)).toEqual(['SEED-JKT-02', 'SEED-JKT-02'])
  })

  it('reads only with planning.view at the site: sales does not plan', async () => {
    const refused = await as(salesPerson, 'GET', `/planning/demand?siteId=${siteA}`, undefined, 403)
    expect(refused.error.code).toBe('forbidden')
    await as(salesPerson, 'GET', `/planning/demand/rows?siteId=${siteA}`, undefined, 403)
    await as(salesPerson, 'GET', `/planning/strategy?siteId=${siteA}`, undefined, 403)
    // The production manager reads it (planning.view).
    expect((await demand(manager)).tiles).toHaveLength(7)
  })
})

describe('one demand view: the rows with their source, and what makes a number', () => {
  it('lists every piece with its source, in day order, the undated last', async () => {
    const list = await rows()
    const dates = list.rows.map((row: Json) => row.date)
    const firstUndated = dates.indexOf(null)
    expect(dates.slice(0, firstUndated === -1 ? dates.length : firstUndated)).toEqual([...dates.slice(0, firstUndated === -1 ? dates.length : firstUndated)].sort())
    if (firstUndated !== -1) expect(dates.slice(firstUndated).every((date: string | null) => date === null)).toBe(true)
    expect(list.pieces).toBe(list.rows.reduce((sum: number, row: Json) => sum + row.pieces, 0))
    const rework = list.rows.find((row: Json) => row.kind === 'REWORK')
    expect(rework).toMatchObject({ layer: 'REMAKES', source: { recordType: 'ReworkOrder', number: 'SEED-WO-0001', mayOpen: true }, workOrder: { number: 'SEED-WO-0001' }, size: '52', pieces: 1, status: 'OPEN', planned: false, date: '2026-12-04' })
    const recut = list.rows.find((row: Json) => row.kind === 'RECUT')
    expect(recut).toMatchObject({ source: { recordType: 'WorkOrder', number: 'SEED-WO-0001' }, part: 'sleeve', status: 'OPEN', planned: false })
    const sample = list.rows.find((row: Json) => row.kind === 'SAMPLE_ROUND')
    expect(sample).toMatchObject({ layer: 'SAMPLES', source: { recordType: 'SampleRound', number: 'SEED-SR-0001', mayOpen: true }, sampleKind: 'FIT', status: 'REQUESTED', date: '2026-11-16', planned: false, style: { code: 'SEED-JKT-01' }, colourway: { code: 'BLK' } })
    expect(sample.party).toMatchObject({ code: expect.any(String), name: expect.any(String) })
    // SEED-SO-0002 line 10: size 50 shipped, 52 and 54 still wait.
    expect(list.rows.filter((row: Json) => row.source.number === 'SEED-SO-0002' && row.source.line === 10).map((row: Json) => [row.size, row.pieces])).toEqual([
      ['52', 2],
      ['54', 1],
    ])
    // SEED-SO-0004: by its delivery schedule, the rest on no day.
    expect(list.rows.filter((row: Json) => row.source.number === 'SEED-SO-0004').map((row: Json) => [row.size, row.date, row.pieces, row.bucket === 'NONE'])).toEqual([
      ['50', '2027-01-15', 1, false],
      ['52', '2027-01-29', 2, false],
      ['50', null, 1, true],
    ])
    expect(list.rows.some((row: Json) => row.source.number === 'SEED-SO-W39-01')).toBe(false)
    // ---- B-W2b-F43: the quote's row on its last valid day and on the day after, whatever the real day.
    const quoteOn = async (day: string) => (await onDay(day, () => rows())).rows.find((row: Json) => row.kind === 'QUOTE_LINE')
    // The planner holds no quotes.view: the row says it cannot be opened from here.
    expect(await quoteOn(Q4_VALID_UNTIL)).toMatchObject({ layer: 'QUOTES', source: { recordType: 'Quote', number: 'SEED-Q-0004', line: 10, mayOpen: false }, validUntil: Q4_VALID_UNTIL, size: '52', pieces: 3, date: null, planned: false })
    expect(await quoteOn(Q4_ENDED)).toBeUndefined()
    // ---- end B-W2b-F43
    // Never money: no price, cost or amount in any row.
    expect(JSON.stringify(list.rows)).not.toMatch(/price|cost|amount|margin/i)
  })

  it('answers the cell popover: the cell’s sources per kind, in words', async () => {
    const world = await demand()
    const jkt02Blk = rowOf(world, 'SEED-JKT-02', 'BLK')
    const bucket = (await rows(`&styleId=${ids.styles['SEED-JKT-02']}&kind=REWORK`)).rows[0].bucket
    const cell = await rows(`&styleId=${ids.styles['SEED-JKT-02']}&colourwayId=${ids.colourways['SEED-JKT-02']!['BLK']}&cell=${bucket}`)
    expect(cell.kinds).toEqual([
      { kind: 'ORDER_LINE', sources: 1, pieces: 3 },
      { kind: 'REWORK', sources: 1, pieces: 1 },
      { kind: 'RECUT', sources: 1, pieces: 1 },
    ])
    expect(cell.words).toEqual({ en: '1 order, 1 rework, 1 recut', it: '1 ordine, 1 rilavorazione, 1 ritaglio' })
    expect(cell.pieces).toBe(jkt02Blk.cells.find((entry: Json) => entry.bucket === bucket).firm)
    // One size; the layer; the made-to-measure units (none yet).
    expect((await rows(`&styleId=${ids.styles['SEED-JKT-02']}&size=54`)).pieces).toBe(2)
    expect((await rows(`&styleId=${ids.styles['SEED-JKT-02']}&colourwayId=${ids.colourways['SEED-JKT-02']!['RED']}&size=54`)).pieces).toBe(1)
    expect((await rows('&layer=SAMPLES')).rows.map((row: Json) => row.source.number)).toEqual(['SEED-SR-0001'])
    expect((await rows('&madeToMeasure=true')).rows).toEqual([])
    expect((await rows('&q=SEED-WO-0001')).rows.map((row: Json) => row.kind).sort()).toEqual(['RECUT', 'REWORK'])
  })

  it('pages by the last row’s key and refuses a cell or a filter it cannot read, in words', async () => {
    const all = await rows()
    const first = await as(planner, 'GET', `/planning/demand/rows?siteId=${siteA}&limit=2`)
    expect(first.rows.map((row: Json) => row.key)).toEqual(all.rows.slice(0, 2).map((row: Json) => row.key))
    expect(first.nextCursor).toBe(first.rows[1].key)
    const second = await as(planner, 'GET', `/planning/demand/rows?siteId=${siteA}&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)
    expect(second.rows.map((row: Json) => row.key)).toEqual(all.rows.slice(2, 4).map((row: Json) => row.key))
    expect(second.kinds).toEqual(all.kinds)
    expect(issuesOf(await as(planner, 'GET', `/planning/demand/rows?siteId=${siteA}&cell=tomorrow`, undefined, 400))).toEqual(['querystring/cell'])
    expect(issuesOf(await as(planner, 'GET', `/planning/demand/rows?siteId=${siteA}&size=52&madeToMeasure=true`, undefined, 400))).toEqual(['querystring/size'])
    expect(issuesOf(await as(planner, 'GET', `/planning/demand/rows?siteId=${siteA}&cursor=gone`, undefined, 400))).toEqual(['querystring/cursor'])
  })

  it('counts the replacement order of a return as a remake, never also as an order', async () => {
    const before = await demand()
    const rma = await one<{ id: string; number: string }>('SELECT id, number FROM "ReturnAuthorisation" WHERE "tenantId" = $1 AND number = $2', [tenant, 'SEED-RMA-0001'])
    // Made up for the test: SEED-SO-0004 becomes the replacement order of SEED-RMA-0001 (same company and customer).
    await admin('UPDATE "ReturnAuthorisation" SET "replacementOrderId" = $2 WHERE id = $1', [rma.id, ids.orders['SEED-SO-0004']])
    try {
      const after = await demand()
      expect(tileOf(after, 'ORDERS').pieces).toBe(tileOf(before, 'ORDERS').pieces - 4)
      expect(tileOf(after, 'REMAKES').pieces).toBe(tileOf(before, 'REMAKES').pieces + 4)
      expect(tileOf(after, 'REMAKES').unplanned).toBe(tileOf(before, 'REMAKES').unplanned)
      const replacement = (await rows('&kind=RETURN_REPLACEMENT')).rows
      expect(replacement.map((row: Json) => [row.source.number, row.origin, row.planned])).toEqual(Array(3).fill(['SEED-SO-0004', { recordType: 'ReturnAuthorisation', recordId: rma.id, number: 'SEED-RMA-0001' }, true]))
    } finally {
      await admin('UPDATE "ReturnAuthorisation" SET "replacementOrderId" = NULL WHERE id = $1', [rma.id])
    }
  })
})

describe('the production strategy per item (PLN-061)', () => {
  const list = (query = '', browser: Browser = planner) => as(browser, 'GET', `/planning/strategy?siteId=${siteA}${query}`)
  const itemIn = (page: Json, code: string): Json => page.items.find((entry: Json) => entry.item.code === code)

  it('lists the finished garments and components with their strategy: make to order by default', async () => {
    const page = await list()
    expect(page.items.map((entry: Json) => entry.item.code)).toEqual(['SEED-CMP-500', 'SEED-JKT-02-BLK-52'])
    expect(itemIn(page, 'SEED-CMP-500')).toMatchObject({ item: { kind: 'COMPONENT' }, strategy: 'MAKE_TO_ORDER', set: false, rows: [], sku: null, lastChange: null })
    expect(itemIn(page, 'SEED-JKT-02-BLK-52')).toMatchObject({ item: { kind: 'FINISHED' }, strategy: 'MAKE_TO_STOCK', set: true, sku: { style: { code: 'SEED-JKT-02' }, colourway: { code: 'BLK' }, size: '52' }, rows: [{ stored: 'MAKE_TO_STOCK', version: 1, colour: null }] })
    expect(page.hint.en).toMatch(/Make to order waits for a customer order/)
    expect((await list('&strategy=MAKE_TO_STOCK')).items.map((entry: Json) => entry.item.code)).toEqual(['SEED-JKT-02-BLK-52'])
    expect((await list('&strategy=MAKE_TO_ORDER')).items.map((entry: Json) => entry.item.code)).toEqual(['SEED-CMP-500'])
    expect((await list('&set=false&kind=COMPONENT')).items.map((entry: Json) => entry.item.code)).toEqual(['SEED-CMP-500'])
    expect((await list(`&styleId=${ids.styles['SEED-JKT-02']}`)).items.map((entry: Json) => entry.item.code)).toEqual(['SEED-JKT-02-BLK-52'])
    expect((await list(`&itemIds=${ids.items['SEED-CMP-500']}`)).items).toHaveLength(1)
    // The buyer reads it (planning.view) but may not change it.
    expect((await list('', buyer)).items).toHaveLength(2)
  })

  it('sets one item’s strategy (the cell’s autosave): a row made with the defaults, audited with its reason, announced', async () => {
    const cmp = ids.items['SEED-CMP-500']!
    const saved = await as(planner, 'PUT', `/planning/strategy/items/${cmp}`, { siteId: siteA, strategy: 'ASSEMBLE_TO_ORDER', reason: 'Liners kept ready, fitted when the order comes (made up).' })
    expect(saved).toMatchObject({ change: 'CREATED', from: 'MAKE_TO_ORDER', replayed: false, row: { stored: 'ASSEMBLE_TO_ORDER', strategy: 'ASSEMBLE_TO_ORDER', version: 1, colour: null } })
    const rowId = saved.row.itemPlanningId
    expect(await one('SELECT method, strategy, "safetyStock" FROM "ItemPlanning" WHERE id = $1', [rowId])).toEqual({ method: 'ORDERS', strategy: 'ASSEMBLE_TO_ORDER', safetyStock: null })
    const audits = await admin<{ action: string; reason: string | null; after: Json }>('SELECT action, reason, after FROM "AuditLog" WHERE "recordId" = $1 ORDER BY at, id', [rowId])
    expect(audits).toEqual([{ action: 'planning.setProductionStrategy', reason: 'Liners kept ready, fitted when the order comes (made up).', after: { itemId: cmp, itemColourId: null, method: 'ORDERS', strategy: 'ASSEMBLE_TO_ORDER' } }])
    const events = await admin<{ type: string; payload: Json }>('SELECT type, payload FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [rowId])
    expect(events).toEqual([{ type: 'planning.item_parameters_changed', payload: { itemPlanningId: rowId, siteId: siteA, itemId: cmp, itemColourId: null, method: 'ORDERS', change: 'CREATED' } }])
    const listed = itemIn(await list(), 'SEED-CMP-500')
    expect(listed).toMatchObject({ strategy: 'ASSEMBLE_TO_ORDER', set: true, lastChange: { from: 'MAKE_TO_ORDER', to: 'ASSEMBLE_TO_ORDER', reason: 'Liners kept ready, fitted when the order comes (made up).', by: { name: 'pia planner' } } })
    // The same strategy again writes nothing.
    expect(await as(planner, 'PUT', `/planning/strategy/items/${cmp}`, { siteId: siteA, strategy: 'ASSEMBLE_TO_ORDER', version: 1 })).toMatchObject({ change: 'UNCHANGED', row: { version: 1 } })
    expect(await admin('SELECT id FROM "AuditLog" WHERE "recordId" = $1', [rowId])).toHaveLength(1)
  })

  it('refuses in words: a changed row, a row made meanwhile, a material, a planner’s colleague without the permission', async () => {
    const cmp = ids.items['SEED-CMP-500']!
    expect((await as(planner, 'PUT', `/planning/strategy/items/${cmp}`, { siteId: siteA, strategy: 'MAKE_TO_STOCK', version: 7 }, 409)).error.message).toMatch(/version|changed/i)
    expect((await as(planner, 'PUT', `/planning/strategy/items/${cmp}`, { siteId: siteA, strategy: 'MAKE_TO_STOCK' }, 409)).error.message).toMatch(/SEED-CMP-500 got its planning at this site since you looked/)
    const leather = await as(planner, 'PUT', `/planning/strategy/items/${ids.items['SEED-LEA-100']}`, { siteId: siteA, strategy: 'MAKE_TO_STOCK' }, 400)
    expect(leather.error.message).toBe('SEED-LEA-100 is a leather material: only finished garments and components we make have a production strategy.')
    expect(issuesOf(leather)).toEqual(['body/itemId'])
    await as(buyer, 'PUT', `/planning/strategy/items/${cmp}`, { siteId: siteA, strategy: 'MAKE_TO_STOCK', version: 1 }, 403)
    expect(issuesOf(await as(planner, 'PUT', `/planning/strategy/items/${cmp}`, { siteId: siteA, strategy: 'MAKE_TO_STOCK', version: 1, reason: '   ' }, 400))).toEqual(['body/reason'])
    expect((await one('SELECT strategy, version FROM "ItemPlanning" WHERE "itemId" = $1 AND "siteId" = $2', [cmp, siteA]))).toEqual({ strategy: 'ASSEMBLE_TO_ORDER', version: 1 })
  })

  it('changes many in ONE command (the review), all or nothing; the demand view shows the new strategy; Undo sends `from` back', async () => {
    const jkt = ids.items['SEED-JKT-02-BLK-52']!
    const cmp = ids.items['SEED-CMP-500']!
    // A material among them: nothing is written, every problem answered at once.
    const refused = await as(manager, 'POST', '/planning/strategy/bulk', { siteId: siteA, items: [{ itemId: ids.items['SEED-LEA-110'], strategy: 'MAKE_TO_STOCK' }, { itemId: jkt, strategy: 'MAKE_TO_ORDER', version: 1 }] }, 400)
    expect(issuesOf(refused)).toEqual(['body/items/0/itemId'])
    expect(issuesOf(await as(manager, 'POST', '/planning/strategy/bulk', { siteId: siteA, items: [{ itemId: jkt, strategy: 'MAKE_TO_ORDER', version: 1 }, { itemId: jkt, strategy: 'MAKE_TO_STOCK', version: 1 }] }, 400))).toEqual(['body/items'])
    expect((await one('SELECT strategy FROM "ItemPlanning" WHERE "itemId" = $1', [jkt])).strategy).toBe('MAKE_TO_STOCK')
    const done = await as(manager, 'POST', '/planning/strategy/bulk', { siteId: siteA, reason: 'The spring plan: made to order (made up).', items: [{ itemId: jkt, strategy: 'MAKE_TO_ORDER', version: 1 }, { itemId: cmp, strategy: 'ASSEMBLE_TO_ORDER', version: 1 }] })
    expect(done.changed).toBe(1)
    expect(done.changes.map((change: Json) => [change.index, change.change, change.from, change.to, change.row.version])).toEqual([
      [0, 'EDITED', 'MAKE_TO_STOCK', 'MAKE_TO_ORDER', 2],
      [1, 'UNCHANGED', 'ASSEMBLE_TO_ORDER', 'ASSEMBLE_TO_ORDER', 1],
    ])
    expect(rowOf(await demand(), 'SEED-JKT-02', 'BLK').strategy).toBe('MAKE_TO_ORDER')
    const audits = await admin<{ action: string; reason: string | null; before: Json; after: Json }>('SELECT action, reason, before, after FROM "AuditLog" WHERE "recordId" = $1 ORDER BY at, id', [done.changes[0].row.itemPlanningId])
    expect(audits.at(-1)).toEqual({ action: 'planning.setProductionStrategy', reason: 'The spring plan: made to order (made up).', before: { strategy: 'MAKE_TO_STOCK' }, after: { strategy: 'MAKE_TO_ORDER' } })
    // Undo: the review sends each `from` back at the version it got.
    const undone = await as(manager, 'POST', '/planning/strategy/bulk', { siteId: siteA, items: [{ itemId: jkt, strategy: done.changes[0].from, version: done.changes[0].row.version }] })
    expect(undone.changes[0]).toMatchObject({ change: 'EDITED', from: 'MAKE_TO_ORDER', to: 'MAKE_TO_STOCK', row: { version: 3 } })
    expect(rowOf(await demand(), 'SEED-JKT-02', 'BLK').strategy).toBe('MAKE_TO_STOCK')
    // A stale version in a bulk change: 409, nothing written.
    await as(manager, 'POST', '/planning/strategy/bulk', { siteId: siteA, items: [{ itemId: jkt, strategy: 'MAKE_TO_ORDER', version: 1 }] }, 409)
    expect((await one('SELECT version FROM "ItemPlanning" WHERE "itemId" = $1', [jkt])).version).toBe(3)
  })
})
