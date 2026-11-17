import ExcelJS from 'exceljs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { ErrorReport } from '@nexus/factory-domain/observability/report'
import { addDays } from '@nexus/factory-domain/planning/buy'
import { createErrorTracker, useErrorTracker } from '../../observability/tracker'
import { usePortalOptions } from '../../platform/auth/portal/service'
import { freshGuard } from '../../platform/auth/portal/testing/portal'
import { fakeScanner } from '../../platform/files/scan/fake'
import { useScanner } from '../../platform/files/scan/service'
import type { EventHandler } from '../../platform/outbox/dispatch'
import { standardReasonsForNewTenants } from '../../platform/reasons/standard'
import type { SearchIndexer } from '../../platform/search/indexer'
import { indexNewTenants } from '../../platform/search/indexing'
import { everyHandler, searchIndexers, settler } from '../daily/testing/day'
import { addressesOf, asBrand, BRAND_ALPHA, BRAND_BETA, findMarkers, mailText, markersOf, setUpBrand, type BrandInWorld, type Marker, type Seen } from '../portal/testing/two-brands'
import { admin, call, ok, person, QUIET, startWorld, type Person, type World } from '../testing/world'
import { DATABASE_FUTURE_MS, oneClock } from '../testing/world'

/**
 * B-TH-064 — GOLDEN FLOW TH-4: THE CUSTOMER SHEET IN DEPTH (threads plan TH-4, B-TH-056 … B-TH-062; §0 the brand wall; Owner rule
 * 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production unit, should be able
 * to see it all. And manage it all as well."). On the golden world (every base seed, the real app and sign-in, every outside provider
 * FAKE) with the worker's handlers run in-process, through the HTTP routes:
 *
 *   S    the sales office makes P1 into Brand Alpha (customer A) and P3 into Brand Beta (customer B), each with its portal buyer; an
 *        order for each (A's from the seeded jacket, B's from a style made for its label).
 *   C1   the office makes a column for customer A only, one for customer B only, and one for every customer (a list of two finishes);
 *        the admin preview says which column every customer will see (B-TH-056).
 *   C2   values written on each order; B's column is no column of A's order (refused in words).
 *   SW   the sheet switched to customer A ("Customer ▾"): its columns hold A's own and the shared one, never B's; its rows are A's; the
 *        cf filter on A's column opens A's order only; a row never carries another customer's column.
 *   OV   the overall view grouped by customer with the server's totals (B-TH-058): every total of A's and B's group opens exactly the
 *        rows it counts (orders, pieces, late, at risk, invoiced, net); the totals of A's column alone are A's group only.
 *   CE   cells edited (B-TH-060): the order note and A's column on A's order, previewed and written (version moved, audited); A's column
 *        on B's order and B's column on A's order refused per row, nothing written; a stale version refused.
 *   T39  customer A's own sheet in its portal (B-TH-061): its own rows, its column and the shared one with only the finish its rows
 *        use, the values as written, never the office note; "Download all" as CSV and as Excel, written by the server, no export job.
 *   T17  customer B's portal sheet, its field read and its downloads: its own rows and column, its own finish only; nothing of A.
 *   T00  the name scan, both ways: nothing B got (answers, files and mail) holds a name, number, column, finish, value or id of A,
 *        and nothing A got holds one of B's.
 *   Z    no route answered 500 during the flow.
 *
 * SQL only reads ids and asserts: no step is made by SQL. Every name, address and figure is made up. Run with
 * `node scripts/factory/golden-flow.mjs threads`.
 */

let w: World
let handlers: readonly EventHandler[]
let indexers: readonly SearchIndexer[]
let settle: () => Promise<string[]>
type Json = Record<string, any>
const P = {} as Record<'owner' | 'sales' | 'manager', Person>
let alpha: BrandInWorld
let beta: BrandInWorld
const seen: Seen[] = []
const unexpected: ErrorReport[] = []
const G = {} as Record<string, any>
/** Each brand's portal person is its buyer: it reads its orders and their sheet, with prices (portal.salesOrders.view). */
const BUYER = { roleKey: 'customer-buyer', capabilities: ['comment'] } as const
/** The columns of this flow (made-up words; codes apart from the seeded order fields). */
const COLUMN = {
  alpha: { code: 'th4_alpha_lining', labelEn: 'Alpha lining (made up)', labelIt: 'Fodera Alpha (inventata)' },
  beta: { code: 'th4_beta_hanger', labelEn: 'Beta hanger (made up)', labelIt: 'Gruccia Beta (inventata)' },
  shared: { code: 'th4_finish', labelEn: 'Finish (made up)', labelIt: 'Finitura (inventata)' },
} as const
const FINISH = {
  alpha: { code: 'ALPHA_GOLD', labelEn: 'Alpha gold (made up)', labelIt: 'Oro Alpha (inventato)' },
  beta: { code: 'BETA_SILVER', labelEn: 'Beta silver (made up)', labelIt: 'Argento Beta (inventato)' },
} as const
const VALUE = { alpha: 'Made-up AL-11', alphaEdited: 'Made-up AL-12', beta: 'Made-up BH-22' } as const
const NOTE = 'Made-up: pack the Alpha jackets by size.'
const id = (key: string) => w.id(key)
const companyA = () => id('company:A')
const P1 = () => id('party:P1')
const P3 = () => id('party:P3')
const today = () => businessDate(new Date())
const A = (method: 'GET' | 'POST', url: string, body?: unknown, status: number | null = 200) => asBrand(alpha, seen, method, url, body, status)
const B = (method: 'GET' | 'POST', url: string, body?: unknown, status: number | null = 200) => asBrand(beta, seen, method, url, body, status)
const versionOf = async (orderId: string) => (await admin<{ version: number }>(w, 'SELECT version FROM "SalesOrder" WHERE id = $1', [orderId]))[0]!.version
const valueOf = async (orderId: string, code: string) => (await admin<{ value: unknown }>(w, 'SELECT v.value FROM "CustomFieldValue" v JOIN "CustomField" f ON f.id = v."fieldId" WHERE v."recordId" = $1 AND f.code = $2', [orderId, code]))[0]?.value ?? null
const ordersOf = async (partyId: string) => new Set((await admin<{ id: string }>(w, 'SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND "partyId" = $2', [w.tenant.id, partyId])).map((row) => row.id))
const exportJobs = async () => (await admin<{ n: number }>(w, 'SELECT count(*)::int AS n FROM "ExportJob" WHERE "tenantId" = $1', [w.tenant.id]))[0]!.n
const query = (filter: Record<string, string>) => new URLSearchParams(filter).toString()

/** Every row a door's filter opens (one page of the list holds them all). */
async function opened(filter: Record<string, string>): Promise<Json[]> {
  const answer = await ok(P.sales, 'GET', `/sales/orders?limit=200&${query(filter)}`)
  expect(answer.nextCursor, `one page holds every row of ${query(filter)}`).toBeNull()
  return answer.orders as Json[]
}

/** Every door of one figures block opens exactly what it counts: rows, or the sum of their pieces and nets (B-TH-058). */
async function expectDoorsExact(figures: Json, label: string): Promise<void> {
  const sum = (rows: Json[], key: string) => rows.reduce((total, row) => total + Number(row[key] ?? 0), 0)
  const check = async (name: string, door: Json, measure: (rows: Json[]) => number) => {
    if (door.filter === null) {
      expect(door.count, `${label} ${name}: a door without a filter counts nothing`).toBe(0)
      return
    }
    expect(measure(await opened(door.filter)), `${label} ${name}`).toBe(door.count)
  }
  await check('orders', figures.orders, (rows) => rows.length)
  await check('pieces.ordered', figures.pieces.ordered, (rows) => sum(rows, 'units'))
  await check('pieces.shipped', figures.pieces.shipped, (rows) => sum(rows, 'shippedUnits'))
  await check('pieces.open', figures.pieces.open, (rows) => sum(rows, 'openUnits'))
  await check('late', figures.late, (rows) => rows.length)
  await check('atRisk', figures.atRisk, (rows) => rows.length)
  for (const state of ['NONE', 'PART', 'ALL']) await check(`invoiced.${state}`, figures.invoiced[state], (rows) => rows.length)
  for (const entry of (figures.net ?? []) as Json[]) {
    if (entry.filter === null) continue
    const rows = await opened(entry.filter)
    expect(new Set(rows.map((row) => row.currency)), `${label} net ${entry.currency}: its rows are of its currency`).toEqual(new Set(rows.length > 0 ? [entry.currency] : []))
    expect(sum(rows, 'netAmount'), `${label} net ${entry.currency}`).toBe(entry.amount)
  }
}

/** Every text cell of a workbook's first sheet, row by row. */
async function workbookRows(bytes: Buffer): Promise<string[][]> {
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(bytes as unknown as ArrayBuffer)
  const rows: string[][] = []
  book.worksheets[0]!.eachRow((row) => rows.push((row.values as unknown[]).slice(1).map((value) => (value === null || value === undefined ? '' : value instanceof Date ? value.toISOString().slice(0, 10) : String(value)))))
  return rows
}

/** A brand's "Download all (Excel)": read through its own session, its cells kept for the name scan (a zip cannot be scanned). */
async function excelOf(brand: BrandInWorld, locale: 'it' | 'en'): Promise<string[][]> {
  const url = `/portal/sales-orders/sheet/download?chip=ALL&format=XLSX&locale=${locale}`
  const answer = await call(brand.browser, 'GET', url)
  expect(answer.status, url).toBe(200)
  expect(String(answer.response.headers['content-type'])).toContain('spreadsheetml')
  expect(String(answer.response.headers['content-disposition'])).toMatch(/^attachment; filename="[^"]+\.xlsx"/)
  const rows = await workbookRows(answer.response.rawPayload)
  seen.push({ who: `${brand.fixture.key} portal`, method: 'GET', url, status: answer.status, body: rows })
  return rows
}

/** A made-up style of the production manager for a label, its colourway and first revision. */
async function newStyle(code: string, name: string, brandPartyId: string): Promise<Json> {
  const { style } = await ok(
    P.manager,
    'POST',
    '/product/styles',
    {
      code,
      name,
      productType: 'JACKET',
      season: 'FW27',
      brandPartyId,
      sizeScaleId: id('product:size-scale:EU-JKT'),
      sizes: ['50', '52'],
      baseSize: '52',
      ppeCategory: 'NOT_PPE',
      colourways: [{ code: 'BLU', name: 'Blu', colourId: id('product:colour:RED') }],
      generateSkus: true,
    },
    201,
  )
  await ok(P.manager, 'POST', `/product/styles/${style.id}/revisions`, { changeNote: `First revision of ${code}` }, 201)
  return style
}

// th3b follow-up 6: ONE clock; the database's own "not in the future" checks (5 minutes) still read its clock.
function clockWithinDatabase(): void {
  const ahead = w.h.clock.now().getTime() - Date.now()
  expect(ahead, `the harness clock runs ${Math.round(ahead / 1000)} s ahead of the database's`).toBeLessThan(DATABASE_FUTURE_MS)
}

beforeAll(async () => {
  useErrorTracker(createErrorTracker({ sink: { kind: 'fake', send: (report) => void unexpected.push(report) }, source: 'api' }))
  w = await startWorld()
  w.h.clock.set(new Date())
  oneClock(w)
  freshGuard(w.h)
  usePortalOptions({ answerFloorMs: 0 })
  useScanner(fakeScanner())
  indexers = await searchIndexers()
  handlers = everyHandler(indexers)
  settle = settler(w, handlers)
  P.owner = await person(w, 'owner', 'owner')
  P.sales = await person(w, 'sales', 'sales')
  P.manager = await person(w, 'manager', 'production_manager')
}, 1_200_000)

afterAll(async () => {
  useScanner(undefined)
  usePortalOptions({})
  useErrorTracker(undefined)
  await w?.close()
}, 60_000)

describe('B-TH-064 golden flow TH-4: the customer sheet — a column for one customer, honest totals, cells, the portal sheet — behind the brand wall', { timeout: 300_000 }, () => {
  it('S00 the world: the seeds drain; the search index is built', async () => {
    await standardReasonsForNewTenants({ database: w.h.database, log: QUIET })
    await indexNewTenants({ database: w.h.database, indexers, log: QUIET })
    await settle()
  })

  it('S01 Brand Alpha (P1) and Brand Beta (P3) with their portals, each with its buyer', async () => {
    alpha = await setUpBrand(w, P.sales, BRAND_ALPHA, P1(), companyA(), BUYER)
    beta = await setUpBrand(w, P.sales, BRAND_BETA, P3(), companyA(), BUYER)
    await settle()
    clockWithinDatabase()
  }, 900_000)

  it('S02 an order for each customer: A’s from the seeded jacket, B’s from a style made for its own label', async () => {
    const ordered = await ok(P.sales, 'POST', '/sales/orders/manual', {
      companyId: companyA(),
      partyId: P1(),
      customerRef: BRAND_ALPHA.customerRef,
      promiseDate: addDays(today(), 40),
      depositPct: null,
      lines: [{ styleId: id('product:style:JKT-01'), colourwayId: id('product:colourway:JKT-01:BLK'), sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 3 }] }],
    }, 201)
    expect(ordered.order).toMatchObject({ status: 'CONFIRMED' })
    G.orderA = ordered.order
    const style = await newStyle('TH4-BETA-01', 'Made-up Beta team jacket', P3())
    const theirs = await ok(P.sales, 'POST', '/sales/orders/manual', {
      companyId: companyA(),
      partyId: P3(),
      customerRef: BRAND_BETA.customerRef,
      promiseDate: addDays(today(), 50),
      depositPct: null,
      lines: [{ styleId: style.id, colourwayId: style.colourways[0].id, unitPrice: '80', sizes: [{ size: '52', quantity: 4 }] }],
    }, 201)
    G.orderB = theirs.order
    await settle()
  })

  it('C1 a column for customer A only, one for customer B only, one for every customer; the preview says which every customer sees', async () => {
    const list = (await ok(P.owner, 'POST', '/fields/picklists', { code: 'th4_finish_list', labelIt: 'Finiture (inventate)', labelEn: 'Finishes (made up)' }, 201)).picklist
    for (const finish of [FINISH.alpha, FINISH.beta]) await ok(P.owner, 'POST', `/fields/picklists/${list.id}/values`, finish, 201)
    const made = async (body: Json) => (await ok(P.owner, 'POST', '/fields', { recordType: 'ORDER', type: 'TEXT', shownInPortal: true, ...body }, 201)).field
    G.alphaField = await made({ ...COLUMN.alpha, partyId: P1() })
    G.betaField = await made({ ...COLUMN.beta, partyId: P3() })
    G.sharedField = await made({ ...COLUMN.shared, type: 'SELECT', picklistId: list.id })
    expect(G.alphaField).toMatchObject({ code: COLUMN.alpha.code, columnId: `cf:${COLUMN.alpha.code}`, partyId: P1(), shownInPortal: true })
    expect(G.betaField).toMatchObject({ code: COLUMN.beta.code, partyId: P3() })
    expect(G.sharedField).toMatchObject({ code: COLUMN.shared.code, partyId: null })
    const editor = (await ok(P.owner, 'GET', '/fields/editor?recordType=ORDER')).fields as Json[]
    const row = (code: string) => editor.find((field) => field.code === code)
    expect(row(COLUMN.alpha.code)).toMatchObject({ partyId: P1(), partyName: BRAND_ALPHA.tradeName, portalNotice: null })
    expect(row(COLUMN.beta.code)).toMatchObject({ partyId: P3(), portalNotice: null })
    // "Every customer will see this column name": the shared column shown in the portal.
    expect(row(COLUMN.shared.code)).toMatchObject({ partyId: null, portalNotice: 'EVERY_CUSTOMER' })
  })

  it('C2 values on each order; customer B’s column is no column of A’s order — refused in words', async () => {
    const onA = await ok(P.sales, 'PUT', `/fields/values/ORDER/${G.orderA.id}`, { values: [{ code: COLUMN.alpha.code, value: VALUE.alpha, version: null }, { code: COLUMN.shared.code, value: FINISH.alpha.code, version: null }] })
    expect(onA.set).toEqual([COLUMN.alpha.code, COLUMN.shared.code])
    const onB = await ok(P.sales, 'PUT', `/fields/values/ORDER/${G.orderB.id}`, { values: [{ code: COLUMN.beta.code, value: VALUE.beta, version: null }, { code: COLUMN.shared.code, value: FINISH.beta.code, version: null }] })
    expect(onB.set).toEqual([COLUMN.beta.code, COLUMN.shared.code])
    const refused = await ok(P.sales, 'PUT', `/fields/values/ORDER/${G.orderA.id}`, { values: [{ code: COLUMN.beta.code, value: 'Made-up: not theirs', version: null }] }, 400)
    expect(refused.error.issues[0]).toEqual({ path: 'body/values/0/code', message: `No custom field ${COLUMN.beta.code} on this order.` })
    expect(await valueOf(G.orderA.id, COLUMN.beta.code)).toBeNull()
  })

  it('SW the sheet switched to customer A: A’s own column and the shared one, never B’s; A’s rows; the cf filter on A’s column opens A’s order', async () => {
    const columnsOf = async (partyId: string) => ((await ok(P.sales, 'GET', `/fields?recordType=ORDER&partyId=${partyId}`)).fields as Json[]).map((field) => field.code)
    const forA = await columnsOf(P1())
    expect(forA).toEqual(expect.arrayContaining([COLUMN.alpha.code, COLUMN.shared.code]))
    expect(forA).not.toContain(COLUMN.beta.code)
    const forB = await columnsOf(P3())
    expect(forB).toEqual(expect.arrayContaining([COLUMN.beta.code, COLUMN.shared.code]))
    expect(forB).not.toContain(COLUMN.alpha.code)
    const rows = await opened({ partyId: P1() })
    expect(rows.map((row) => row.id)).toContain(G.orderA.id)
    expect(new Set(rows.map((row) => row.partyId))).toEqual(new Set([P1()]))
    // The cells of the rows: keyed by code; a row never carries another customer's column.
    const cells = (await ok(P.sales, 'POST', '/fields/rows/ORDER', { ids: [G.orderA.id, G.orderB.id] })).rows as Json[]
    const cellsOf = (orderId: string) => cells.find((row) => row.id === orderId)!.values as Json
    expect(cellsOf(G.orderA.id)[COLUMN.alpha.code]).toMatchObject({ value: VALUE.alpha })
    expect(Object.keys(cellsOf(G.orderA.id))).not.toContain(COLUMN.beta.code)
    expect(cellsOf(G.orderB.id)[COLUMN.beta.code]).toMatchObject({ value: VALUE.beta })
    expect(Object.keys(cellsOf(G.orderB.id))).not.toContain(COLUMN.alpha.code)
    // The cf filter (screen = file): A's column holds a value on A's order only.
    expect((await opened({ cf: `${COLUMN.alpha.code}:*` })).map((row) => row.id)).toEqual([G.orderA.id])
    expect((await opened({ cf: `${COLUMN.shared.code}:${FINISH.beta.code}` })).map((row) => row.id)).toEqual([G.orderB.id])
  })

  it('OV the overall view grouped by customer: every total of A’s and B’s group opens exactly the rows it counts', async () => {
    const view = await ok(P.sales, 'GET', '/sales/orders/summary?group=party')
    expect(view.limited).toBe(false)
    const groupOf = (partyId: string) => (view.groups as Json[]).find((group) => group.partyId === partyId)
    expect(groupOf(P1())).toMatchObject({ code: BRAND_ALPHA.code })
    expect(groupOf(P3())).toMatchObject({ code: BRAND_BETA.code })
    for (const [label, partyId] of [['A', P1()], ['B', P3()]] as const) {
      const group = groupOf(partyId)!
      expect(group.figures.orders.filter).toMatchObject({ partyId })
      await expectDoorsExact(group.figures, `group ${label}`)
    }
    expect(groupOf(P3())!.figures.pieces.ordered.count).toBe(4)
    // The totals of A's column alone: A's group only, and its door opens A's order.
    const column = await ok(P.sales, 'GET', `/sales/orders/summary?group=party&${query({ cf: `${COLUMN.alpha.code}:*` })}`)
    expect((column.groups as Json[]).map((group) => group.partyId)).toEqual([P1()])
    expect(column.all.orders.count).toBe(1)
    expect(column.groups[0].figures.orders.filter).toMatchObject({ cf: `${COLUMN.alpha.code}:*`, partyId: P1() })
    await expectDoorsExact(column.groups[0].figures, 'A’s column')
  })

  it('CE cells edited: the note and A’s column on A’s order, written and audited; the wrong customer’s column refused per row; a stale version refused', async () => {
    const before = { a: await versionOf(G.orderA.id), b: await versionOf(G.orderB.id) }
    const shown = await ok(P.sales, 'POST', '/views/bulk/preview', { listKey: 'sales.orders', ids: [G.orderA.id, G.orderB.id], changes: { note: NOTE, [`cf:${COLUMN.alpha.code}`]: VALUE.alphaEdited } })
    const rowOf = (orderId: string) => (shown.rows as Json[]).find((row) => row.id === orderId)!
    expect(rowOf(G.orderA.id)).toMatchObject({ label: G.orderA.number, version: before.a, refusal: null })
    expect(rowOf(G.orderA.id).changes).toEqual(expect.arrayContaining([expect.objectContaining({ field: `cf:${COLUMN.alpha.code}`, now: VALUE.alpha, next: VALUE.alphaEdited })]))
    // A's column is no column of B's order.
    expect(rowOf(G.orderB.id).refusal).toEqual({ code: 'invalid', field: `cf:${COLUMN.alpha.code}`, status: null })
    const results = (await ok(P.sales, 'POST', '/views/bulk/apply', { listKey: 'sales.orders', rows: [{ id: G.orderA.id, version: before.a, changes: { note: NOTE, [`cf:${COLUMN.alpha.code}`]: VALUE.alphaEdited } }] })).results as Json[]
    expect(results[0]).toMatchObject({ id: G.orderA.id, ok: true, version: before.a + 1, after: { note: NOTE, [`cf:${COLUMN.alpha.code}`]: VALUE.alphaEdited } })
    expect((await admin<{ internalNote: string }>(w, 'SELECT "internalNote" FROM "SalesOrder" WHERE id = $1', [G.orderA.id]))[0]!.internalNote).toBe(NOTE)
    expect(await valueOf(G.orderA.id, COLUMN.alpha.code)).toBe(VALUE.alphaEdited)
    const audits = await admin<{ actorId: string }>(w, `SELECT "actorId" FROM "AuditLog" WHERE "recordId" = $1 AND action = 'sales.orders.editCells' ORDER BY at, id`, [G.orderA.id])
    expect(audits.map((row) => row.actorId)).toEqual([P.sales.id])
    // B's column on A's order, B's own on B's: A's row refused, B's written; nothing on A.
    const mixed = (await ok(P.sales, 'POST', '/views/bulk/apply', {
      listKey: 'sales.orders',
      rows: [
        { id: G.orderA.id, version: before.a + 1, changes: { [`cf:${COLUMN.beta.code}`]: 'Made-up BH-99' } },
        { id: G.orderB.id, version: before.b, changes: { [`cf:${COLUMN.beta.code}`]: 'Made-up BH-23' } },
      ],
    })).results as Json[]
    expect(mixed.map((result) => [result.ok, result.refusal?.code ?? null])).toEqual([[false, 'invalid'], [true, null]])
    expect(await valueOf(G.orderA.id, COLUMN.beta.code)).toBeNull()
    expect(await valueOf(G.orderB.id, COLUMN.beta.code)).toBe('Made-up BH-23')
    G.betaValue = 'Made-up BH-23'
    // A stale version: refused, nothing written.
    const stale = (await ok(P.sales, 'POST', '/views/bulk/apply', { listKey: 'sales.orders', rows: [{ id: G.orderA.id, version: before.a, changes: { note: 'Made-up: too late' } }] })).results as Json[]
    expect(stale[0]).toMatchObject({ ok: false, refusal: { code: 'stale' } })
    expect((await admin<{ internalNote: string }>(w, 'SELECT "internalNote" FROM "SalesOrder" WHERE id = $1', [G.orderA.id]))[0]!.internalNote).toBe(NOTE)
    await settle()
  })

  it('T39 customer A’s own sheet in its portal: its rows, its column and the shared one with its own finish only, never the office note', async () => {
    const sheet = await A('GET', '/portal/sales-orders/sheet?chip=ALL&limit=200')
    const own = await ordersOf(P1())
    const orders = (sheet.items as Json[]).filter((item) => item.kind === 'ORDER')
    expect(orders.map((item) => item.id)).toContain(G.orderA.id)
    for (const item of orders) expect(own.has(item.id), `${item.id} is A’s`).toBe(true)
    const codes = (sheet.columns as Json[]).map((column) => column.code)
    expect(codes).toEqual(expect.arrayContaining([COLUMN.alpha.code, COLUMN.shared.code]))
    expect(codes).not.toContain(COLUMN.beta.code)
    expect((sheet.columns as Json[]).find((column) => column.code === COLUMN.shared.code)!.options).toEqual([FINISH.alpha])
    const mine = orders.find((item) => item.id === G.orderA.id)!
    expect(mine.number).toBeNull()
    expect(mine.values[`cf:${COLUMN.alpha.code}`]).toMatchObject({ value: VALUE.alphaEdited })
    expect(mine.values[`cf:${COLUMN.shared.code}`]).toMatchObject({ value: FINISH.alpha.code, wordsEn: FINISH.alpha.labelEn })
    expect(JSON.stringify(sheet)).not.toContain(NOTE)
    // The order's own portal field read: the fields for every customer or A, only the finish A's order uses.
    const fields = await A('GET', `/fields/portal/ORDER/${G.orderA.id}`)
    expect((fields.fields as Json[]).map((field) => field.code)).toEqual(expect.arrayContaining([COLUMN.alpha.code, COLUMN.shared.code]))
    expect((fields.fields as Json[]).find((field) => field.code === COLUMN.shared.code)!.picklist.values.map((value: Json) => value.code)).toEqual([FINISH.alpha.code])
  })

  it('T39 “Download all”: every row of A as CSV and as Excel, written by the server in A’s scope — never the export job', async () => {
    const jobs = await exportJobs()
    const csv = (await A('GET', '/portal/sales-orders/sheet/download?chip=ALL&format=CSV&locale=en')) as string
    expect(csv).toContain(COLUMN.alpha.labelEn)
    expect(csv).toContain(VALUE.alphaEdited)
    expect(csv).toContain(BRAND_ALPHA.customerRef)
    expect(csv).not.toContain(NOTE)
    const rows = await excelOf(alpha, 'it')
    expect(rows.some((row) => row.includes('Il vostro ordine n.'))).toBe(true)
    expect(rows.flat()).toEqual(expect.arrayContaining([COLUMN.alpha.labelIt, VALUE.alphaEdited]))
    expect(await exportJobs()).toBe(jobs)
  })

  it('T17 customer B’s sheet, field read and downloads: its own rows, its column, its own finish; nothing of A — A’s order not found', async () => {
    const sheet = await B('GET', '/portal/sales-orders/sheet?chip=ALL&limit=200')
    const own = await ordersOf(P3())
    const orders = (sheet.items as Json[]).filter((item) => item.kind === 'ORDER')
    expect(orders.map((item) => item.id)).toContain(G.orderB.id)
    for (const item of orders) expect(own.has(item.id), `${item.id} is B’s`).toBe(true)
    const codes = (sheet.columns as Json[]).map((column) => column.code)
    expect(codes).toEqual(expect.arrayContaining([COLUMN.beta.code, COLUMN.shared.code]))
    expect(codes).not.toContain(COLUMN.alpha.code)
    expect((sheet.columns as Json[]).find((column) => column.code === COLUMN.shared.code)!.options).toEqual([FINISH.beta])
    expect(orders.find((item) => item.id === G.orderB.id)!.values[`cf:${COLUMN.beta.code}`]).toMatchObject({ value: G.betaValue })
    const fields = await B('GET', `/fields/portal/ORDER/${G.orderB.id}`)
    expect((fields.fields as Json[]).map((field) => field.code)).not.toContain(COLUMN.alpha.code)
    await B('GET', `/fields/portal/ORDER/${G.orderA.id}`, undefined, 404)
    await B('GET', `/portal/sales-orders/${G.orderA.id}`, undefined, 404)
    for (const chip of ['OPEN', 'ALL']) await B('GET', `/portal/sales-orders/sheet?chip=${chip}&limit=200`)
    const csv = (await B('GET', '/portal/sales-orders/sheet/download?chip=ALL&format=CSV&locale=en')) as string
    expect(csv).toContain(G.betaValue)
    await excelOf(beta, 'en')
    for (const q of [G.orderA.number as string, BRAND_ALPHA.customerRef, VALUE.alphaEdited]) await B('GET', `/portal/search?q=${encodeURIComponent(q)}`)
    await B('GET', '/portal/sales-orders')
  })

  it('T00 the name scan, both ways: nothing B got holds a name, number, column, finish, value or id of A — nor A anything of B', async () => {
    const ofAlpha: Marker[] = [
      ...(await markersOf(w, BRAND_ALPHA, P1())),
      { label: 'A’s order id', text: G.orderA.id as string },
      { label: 'A’s order number', text: G.orderA.number as string },
      { label: 'A’s column code', text: COLUMN.alpha.code },
      { label: 'A’s column (en)', text: COLUMN.alpha.labelEn },
      { label: 'A’s column (it)', text: COLUMN.alpha.labelIt },
      { label: 'A’s finish', text: FINISH.alpha.code },
      { label: 'A’s finish (en)', text: FINISH.alpha.labelEn },
      { label: 'A’s finish (it)', text: FINISH.alpha.labelIt },
      { label: 'A’s value', text: VALUE.alpha },
      { label: 'A’s value edited', text: VALUE.alphaEdited },
      { label: 'the office note on A’s order', text: NOTE },
    ]
    // The other way: what this flow made of B's (its order, column, finish and values) is in none of A's answers.
    const ofBeta: Marker[] = [
      { label: 'B’s order id', text: G.orderB.id as string },
      { label: 'B’s order number', text: G.orderB.number as string },
      { label: 'B’s column code', text: COLUMN.beta.code },
      { label: 'B’s column (en)', text: COLUMN.beta.labelEn },
      { label: 'B’s column (it)', text: COLUMN.beta.labelIt },
      { label: 'B’s finish', text: FINISH.beta.code },
      { label: 'B’s finish (en)', text: FINISH.beta.labelEn },
      { label: 'B’s finish (it)', text: FINISH.beta.labelIt },
      { label: 'B’s value', text: VALUE.beta },
      { label: 'B’s value edited', text: G.betaValue as string },
    ]
    // A search answer repeats what was typed (Beta typed A's numbers on purpose): its echo is left out of the scan.
    const bodyOf = (entry: Seen) => (entry.url.startsWith('/portal/search') && entry.body && typeof entry.body === 'object' ? { ...(entry.body as Json), query: null, words: null } : entry.body)
    const leaks = (who: string, markers: readonly Marker[]) =>
      seen.filter((entry) => entry.who.startsWith(who)).flatMap((entry) => findMarkers(bodyOf(entry), markers).map((found) => `${who}: ${entry.method} ${entry.url} (${entry.status}): ${found}`))
    expect(leaks('beta', ofAlpha)).toEqual([])
    expect(leaks('alpha', ofBeta)).toEqual([])
    for (const [brand, markers] of [[beta, ofAlpha], [alpha, ofBeta]] as const) {
      const addresses = new Set(await addressesOf(w, brand))
      const mails = w.h.ses.mails.filter((mail) => [...mail.to, ...mail.cc, ...mail.bcc].some((address) => addresses.has(address.toLowerCase())))
      expect(mails.flatMap((mail) => findMarkers(mailText(mail.raw), markers).map((found) => `${brand.fixture.key} ${mail.templateKey}: ${found}`))).toEqual([])
    }
    expect(seen.filter((entry) => entry.who.startsWith('beta')).length).toBeGreaterThan(8)
  })

  it('Z no route answered 500 during the flow', async () => {
    await settle()
    expect(unexpected.map((report) => `${report.context.method} ${report.context.route}: ${report.name}: ${report.message} ${report.stack.slice(0, 3).join(' | ')}`)).toEqual([])
  })
})
