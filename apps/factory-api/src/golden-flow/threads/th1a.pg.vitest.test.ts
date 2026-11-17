import ExcelJS from 'exceljs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { ErrorReport } from '@nexus/factory-domain/observability/report'
import { addDays } from '@nexus/factory-domain/planning/buy'
import { createErrorTracker, useErrorTracker } from '../../observability/tracker'
import { usePortalOptions } from '../../platform/auth/portal/service'
import { freshGuard } from '../../platform/auth/portal/testing/portal'
import { addUser, Browser, enrolTotp } from '../../platform/auth/sessions/testing/harness'
import { fakeScanner } from '../../platform/files/scan/fake'
import { useScanner } from '../../platform/files/scan/service'
import { decodeJpeg } from '../../platform/files/thumbs/codec/jpeg-decode'
import { encodeJpeg } from '../../platform/files/thumbs/codec/jpeg-encode'
import { SMALL_EDGE } from '../../platform/files/thumbs/small'
import type { EventHandler } from '../../platform/outbox/dispatch'
import { standardReasonsForNewTenants } from '../../platform/reasons/standard'
import type { SearchIndexer } from '../../platform/search/indexer'
import { indexNewTenants } from '../../platform/search/indexing'
import { everyHandler, searchIndexers, settler } from '../daily/testing/day'
import { BRAND_ALPHA, BRAND_BETA, findMarkers, markersOf, setUpBrand, type BrandInWorld } from '../portal/testing/two-brands'
import { admin, call, ok, person, putBytes, QUIET, sha256, startWorld, stepped, type Method, type Person, type World } from '../testing/world'

/**
 * B-TH-102 — GOLDEN FLOW TH-1a: THE ORDERS SHEET OF TWO CUSTOMERS (threads plan TH-1a, pictures 23 + 24; §0 the brand wall;
 * Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production unit,
 * should be able to see it all. And manage it all as well."). On the golden world (../testing/world.ts: every base seed, the real
 * app and sign-in, every outside provider FAKE) with the worker's handlers run in-process, through the HTTP routes:
 *
 *   S   the sales office makes P1 into Brand Alpha (customer A: the seed's orders SEED-SO-0001 and SEED-SO-0002, A's private-label
 *       jacket) and P3 into Brand Beta (customer B); the production manager makes Beta's private-label jacket BX-200 with a main
 *       picture whose small preview the worker's files.stripPictures job makes (B-TH-063), and an own-collection vest; sales types
 *       two orders of Beta's; finance invoices one in part (TD01 of 1 of 4 pieces) and the other in full.
 *   T17 the factory's sheet holds both customers' orders: Picture (the small preview, ≤ 320 px, behind the order's picture route),
 *       Brand (the label on the garment: Beta's name, our own collection, A's own label), Invoiced None / Part / All; the
 *       Customer switcher's counts equal the list's and the board's; Brand narrows the sheet.
 *   T30 an office person limited to customer A (a sales rep: RoleAssignment partyIds, given by the admin through the route):
 *       the sheet, the board, the switcher ("limited", A only), Brand B asked → nothing; Beta's picture → not found.
 *   T19 the rep's saved view of A, its export file and its Pin to Today count hold only customer A's orders.
 *   T00 the name scan: every answer and file the rep got holds nothing of Brand Beta.
 *   Z   no route answered 500 during the flow.
 *
 * SQL only reads ids and asserts: no step is made by SQL. Every name, address and figure is made up. Run with
 * `node scripts/factory/golden-flow.mjs threads`.
 */

let w: World
let handlers: readonly EventHandler[]
let indexers: readonly SearchIndexer[]
let settle: () => Promise<string[]>
type Json = Record<string, any>
const P = {} as Record<'owner' | 'admin' | 'sales' | 'manager' | 'finance', Person>
let alpha: BrandInWorld
let beta: BrandInWorld
/** What the API reported as unexpected (a 500) during the flow: none at the end. */
const unexpected: ErrorReport[] = []
const G = {} as Record<string, any>
const id = (key: string) => w.id(key)
const companyA = () => id('company:A')
const today = () => businessDate(new Date())
const P1 = () => id('party:P1')
const P3 = () => id('party:P3')

/** The rep limited to customer A: their browser and every answer they got (the T00 scan reads them). */
const rep = { seen: [] as { url: string; status: number; body: unknown }[] } as { browser: Browser; secret: string; id: string; seen: { url: string; status: number; body: unknown }[] }
async function asRep(method: Method, url: string, body?: unknown, status: number | null = 200): Promise<any> {
  const answer = await call(rep.browser, method, url, body)
  rep.seen.push({ url, status: answer.status, body: answer.body })
  if (status !== null) expect(answer.status, `rep ${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return answer.body
}

/** A made-up picture: gradients and a disc (a jacket's photo for the sheet), as a JPEG of `width` × `height`. */
function photo(width: number, height: number): Buffer {
  const data = new Uint8ClampedArray(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3
      data[at] = (x * 255) / width
      data[at + 1] = (y * 255) / height
      data[at + 2] = Math.hypot(x - width / 2, y - height / 2) < height / 4 ? 220 : 50
    }
  }
  return Buffer.from(encodeJpeg({ width, height, channels: 3, data }, 88))
}

/** The rows of the sheet as one reader sees it (the API's own terms; none: every row), by order number. */
async function sheet(who: Person | 'rep', query = ''): Promise<Map<string, Json>> {
  const url = `/sales/orders?limit=200${query ? `&${query}` : ''}`
  const answer = who === 'rep' ? await asRep('GET', url) : await ok(who, 'GET', url)
  return new Map((answer.orders as Json[]).map((row) => [row.number as string, row]))
}

/** A made-up style of the production manager (a jacket or a vest), its colourway, its first revision; `brandPartyId` its label. */
async function newStyle(code: string, name: string, brandPartyId: string | null): Promise<Json> {
  const { style } = await ok(
    P.manager,
    'POST',
    '/product/styles',
    {
      code,
      name,
      productType: 'JACKET',
      season: 'FW27',
      ...(brandPartyId ? { brandPartyId } : {}),
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

/** The file of an export job, run by the worker: its rows by heading (the header row is the one naming "Number"). */
async function fileRows(jobId: string, browserOf: (method: Method, url: string) => Promise<any>): Promise<{ rows: Record<string, string>[]; text: string }> {
  await settle()
  const job = (await browserOf('GET', `/exports/${jobId}`)).job
  expect(job.status, job.failureReason ?? '').toBe('DONE')
  const { download } = await browserOf('GET', `/exports/${jobId}/download`)
  const got = await w.h.app.inject({ method: 'GET', url: download.url, headers: download.headers })
  expect(got.statusCode).toBe(200)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(got.rawPayload as unknown as ArrayBuffer)
  const lines: string[][] = []
  workbook.worksheets[0]!.eachRow((row) => lines.push((row.values as unknown[]).slice(1).map((value) => String(value ?? ''))))
  const header = lines.findIndex((line) => line.includes('Number'))
  const heads = lines[header]!
  return { rows: lines.slice(header + 1).map((line) => Object.fromEntries(heads.map((head, index) => [head, line[index] ?? '']))), text: `${job.file?.name ?? ''}\n${workbook.worksheets[0]!.name}\n${JSON.stringify(lines)}` }
}
const EXPORT_COLUMNS = [
  { key: 'number', label: 'Number' },
  { key: 'customer', label: 'Customer' },
  { key: 'brand', label: 'Brand' },
  { key: 'picture', label: 'Picture' },
  { key: 'invoiced', label: 'Invoiced' },
  { key: 'status', label: 'Status' },
]

beforeAll(async () => {
  useErrorTracker(createErrorTracker({ sink: { kind: 'fake', send: (report) => void unexpected.push(report) }, source: 'api' }))
  w = await startWorld()
  // The portal's codes are refused by the database once past their end in REAL time: the harness clock starts at now.
  w.h.clock.set(new Date())
  freshGuard(w.h)
  usePortalOptions({ answerFloorMs: 0 })
  useScanner(fakeScanner())
  indexers = await searchIndexers()
  handlers = everyHandler(indexers)
  settle = settler(w, handlers)
  for (const [key, role] of [
    ['owner', 'owner'],
    ['admin', 'admin'],
    ['sales', 'sales'],
    ['manager', 'production_manager'],
    ['finance', 'finance'],
  ] as const) {
    P[key] = await person(w, key, role)
  }
}, 1_200_000)

afterAll(async () => {
  useScanner(undefined)
  usePortalOptions({})
  useErrorTracker(undefined)
  await w?.close()
}, 60_000)

describe('B-TH-102 golden flow TH-1a: the orders sheet of two customers, the switcher, the honest file, the wall', { timeout: 300_000 }, () => {
  it('S00 the world: the seeds drain; the search index is built', async () => {
    await standardReasonsForNewTenants({ database: w.h.database, log: QUIET })
    await indexNewTenants({ database: w.h.database, indexers, log: QUIET })
    await settle()
  })

  it('S01 the sales office makes P1 into Brand Alpha and P3 into Brand Beta (names, contact, address, portal)', async () => {
    alpha = await setUpBrand(w, P.sales, BRAND_ALPHA, P1(), companyA())
    beta = await setUpBrand(w, P.sales, BRAND_BETA, P3(), companyA())
    expect(alpha.partyId).toBe(P1())
    expect(beta.partyId).toBe(P3())
    await settle()
  })

  it('S02 the production manager makes Beta’s private-label jacket BX-200 with its main picture (the worker makes its small preview) and an own-collection vest', async () => {
    G.betaStyle = await newStyle('BX-200', 'Brand Beta city jacket (made up)', P3())
    G.ownStyle = await newStyle('TH1A-OWN-01', 'Own collection city vest (made up)', null)
    // The jacket's photo, a phone-sized JPEG (1200 × 1600): announced on the style, its bytes sent, completed.
    const body = photo(1200, 1600)
    const announced = await ok(P.manager, 'POST', '/files', { recordType: 'Style', recordId: G.betaStyle.id, kind: 'PHOTO', originalName: 'bx-200-front.jpg', contentType: 'image/jpeg', sizeBytes: body.length, sha256: sha256(body) }, 201)
    await putBytes(w, announced, body)
    expect((await ok(P.manager, 'POST', `/files/${announced.file.id}/complete`)).file.status).toBe('AVAILABLE')
    G.pictureFile = announced.file.id
    // file.available → the worker's files.stripPictures: the stripped copy and its ~320 px preview.
    expect(await settle()).toContain('file.available')
    const [stored] = await admin<{ thumbnailKey: string | null }>(w, 'SELECT "thumbnailKey" FROM "StoredFile" WHERE id = $1', [G.pictureFile])
    expect(stored!.thumbnailKey).not.toBeNull()
    const added = await ok(P.manager, 'POST', `/product/styles/${G.betaStyle.id}/pictures`, { fileId: G.pictureFile, kind: 'PHOTO' }, 201)
    const picture = (added.pictures.pictures as Json[]).find((entry) => entry.file.id === G.pictureFile)!
    // The first picture is the main one already: asked again, the same pictures (this once answered 500: no audit row).
    const main = await ok(P.manager, 'POST', `/product/styles/${G.betaStyle.id}/pictures/${picture.id}/main`, { version: picture.version })
    expect((main.pictures.pictures as Json[]).find((entry) => entry.file.id === G.pictureFile)).toMatchObject({ isMain: true })
    await settle()
  })

  it('S03 sales types Beta’s two orders: the jacket and the vest (two labels), and the jacket alone; finance invoices the first in part and the second in full', async () => {
    const colour = (style: Json) => style.colourways[0].id as string
    const first = await ok(P.sales, 'POST', '/sales/orders/manual', {
      companyId: companyA(),
      partyId: P3(),
      customerRef: BRAND_BETA.customerRef,
      promiseDate: addDays(today(), 40),
      depositPct: null,
      lines: [
        { styleId: G.betaStyle.id, colourwayId: colour(G.betaStyle), unitPrice: '80', sizes: [{ size: '50', quantity: 1 }, { size: '52', quantity: 3 }] },
        { styleId: G.ownStyle.id, colourwayId: colour(G.ownStyle), unitPrice: '30', sizes: [{ size: '52', quantity: 2 }] },
      ],
    }, 201)
    const second = await ok(P.sales, 'POST', '/sales/orders/manual', {
      companyId: companyA(),
      partyId: P3(),
      promiseDate: addDays(today(), 50),
      depositPct: null,
      lines: [{ styleId: G.betaStyle.id, colourwayId: colour(G.betaStyle), unitPrice: '80', sizes: [{ size: '52', quantity: 2 }] }],
    }, 201)
    G.betaPart = first.order
    G.betaAll = second.order
    await settle()
    // Finance: an immediate invoice (TD01) of 1 of the 4 jackets of the first order, and every piece of the second.
    const invoice = async (order: Json, pick: (line: Json) => number) => {
      const jacket = (line: Json) => line.styleId === G.betaStyle.id
      const lines = (order.lines as Json[]).filter((line) => pick(line) > 0).map((line) => ({ kind: 'GOODS', description: `${jacket(line) ? 'BX-200' : 'TH1A-OWN-01'} (made up)`, quantity: String(pick(line)), unitPrice: jacket(line) ? '80' : '30', salesOrderLineId: line.id }))
      const drafted = await ok(P.finance, 'POST', '/invoicing/invoices', { companyId: companyA(), buyerPartyId: P3(), docType: 'TD01', salesOrderId: order.id, lines }, 201)
      await stepped(w, P.finance)
      const issued = await ok(P.finance, 'POST', `/invoicing/invoices/${drafted.invoice.id}/issue`, { version: drafted.invoice.version })
      expect(issued.invoice.status).toBe('ISSUED')
      await settle()
      return issued.invoice
    }
    G.invoicePart = await invoice(G.betaPart, (line) => (line.styleId === G.betaStyle.id ? 1 : 0))
    G.invoiceAll = await invoice(G.betaAll, (line) => line.quantity as number)
  })

  it('T17 the factory’s sheet: both customers’ orders, Picture from the small preview, Brand on the garment, Invoiced None / Part / All', async () => {
    const rows = await sheet(P.owner)
    const part = rows.get(G.betaPart.number)!
    const all = rows.get(G.betaAll.number)!
    const seedOne = rows.get('SEED-SO-0001')!
    expect(seedOne.partyId).toBe(P1())
    // Brand: the label on the garment — Beta's name and our own collection on the first, A's own label on A's order.
    expect(part.brands).toEqual([{ partyId: P3(), name: BRAND_BETA.legalName, own: false }, { partyId: null, name: null, own: true }])
    expect(all.brands).toEqual([{ partyId: P3(), name: BRAND_BETA.legalName, own: false }])
    expect(seedOne.brands.map((brand: Json) => brand.name)).toContain(BRAND_ALPHA.legalName)
    // Invoiced by pieces on issued invoices: 1 of the 4 jackets (the vest not billed) is Part; every piece is All; A's None.
    expect(part.invoiced).toMatchObject({ state: 'PART', pieces: '1', toInvoice: 6 })
    expect(all.invoiced).toMatchObject({ state: 'ALL', pieces: '2', toInvoice: 2 })
    expect(seedOne.invoiced.state).toBe('NONE')
    expect(part.doors.invoices).toEqual({ count: 1, only: { id: G.invoicePart.id, number: G.invoicePart.number, docType: 'TD01' } })
    // Picture: the first line's style, its main picture with its small preview; "+1" for the vest.
    expect(part.picture).toEqual({ styleId: G.betaStyle.id, styleCode: 'BX-200', styleName: G.betaStyle.name, fileId: G.pictureFile, contentType: 'image/jpeg', small: true })
    expect(part.styleCount).toBe(2)
    const served = await ok(P.owner, 'GET', `/sales/orders/${G.betaPart.id}/picture`)
    expect(served.picture).toMatchObject({ fileId: G.pictureFile, small: { method: 'GET' } })
    const bytes = await w.h.app.inject({ method: 'GET', url: served.picture.small.url, headers: served.picture.small.headers })
    expect(bytes.statusCode).toBe(200)
    const small = decodeJpeg(new Uint8Array(bytes.rawPayload))
    expect(Math.max(small.width, small.height)).toBeLessThanOrEqual(SMALL_EDGE)
    expect(small.height).toBeGreaterThan(small.width)
    // Brand narrows the sheet: Beta's label → the orders that carry it (Beta's two); our own collection → those with an own style.
    const labelled = async (brand: string | null) =>
      (await admin<{ number: string }>(w, `SELECT DISTINCT o.number FROM "SalesOrder" o JOIN "SalesOrderLine" l ON l."orderId" = o.id JOIN "Style" st ON st.id = l."styleId" WHERE o."tenantId" = $1 AND st."brandPartyId" IS NOT DISTINCT FROM $2::uuid ORDER BY 1`, [w.tenant.id, brand])).map((row) => row.number)
    const betaLabel = await labelled(P3())
    expect(betaLabel).toEqual([G.betaPart.number, G.betaAll.number].sort())
    expect([...(await sheet(P.owner, `brand=${P3()}`)).keys()].sort()).toEqual(betaLabel)
    const own = await labelled(null)
    expect(own).toContain(G.betaPart.number)
    expect(own).not.toContain(G.betaAll.number)
    expect([...(await sheet(P.owner, 'brand=own')).keys()].sort()).toEqual(own)
  })

  it('T17 the Customer switcher: each customer with its open and late orders, the same numbers as the list and the board', async () => {
    const answer = await ok(P.sales, 'GET', '/sales/orders/customers?limit=200')
    expect(answer.limited).toBe(false)
    for (const partyId of [P1(), P3()]) {
      const line = (answer.customers as Json[]).find((entry) => entry.id === partyId)!
      expect(line, partyId).toBeDefined()
      const open = (await ok(P.sales, 'GET', `/sales/orders?limit=200&open=true&partyId=${partyId}`)).orders.length
      const late = (await ok(P.sales, 'GET', `/sales/orders?limit=200&late=true&partyId=${partyId}`)).orders.length
      const board = await ok(P.sales, 'GET', `/sales/orders/board?partyId=${partyId}`)
      expect(line.open).toBe(open)
      expect(line.late).toBe(late)
      expect((board.tiles as Json[]).find((tile) => tile.key === 'late')!.count).toBe(late)
    }
    expect((answer.customers as Json[]).find((entry) => entry.id === P3())).toMatchObject({ name: BRAND_BETA.legalName, open: 2 })
  })

  it('T30 the admin gives a sales rep the sales role for customer A only; the rep signs in', async () => {
    const user = await addUser(w.h, w.tenant, { email: 'th1a.rep@golden.example.com' })
    const sales = ((await ok(P.admin, 'GET', '/auth/roles')).roles as Json[]).find((role) => role.key === 'sales')!
    await stepped(w, P.admin)
    // From a minute ago: the worker reads the rep's rights on the server clock, while this world's harness clock (the routes')
    // has run ahead with every two-factor step — an assignment "from now" would not have started yet for the export job.
    const assignment = await ok(P.admin, 'POST', `/auth/users/${user.id}/roles`, { roleId: sales.id, allCompanies: true, partyIds: [P1()], validFrom: new Date(Date.now() - 60_000).toISOString(), reason: 'Account manager of Brand Alpha (made up)' })
    expect(assignment).toMatchObject({ partyIds: [P1()], live: true })
    rep.browser = new Browser(w.h.app)
    const signedIn = await rep.browser.signIn(w.tenant.slug, user.email, user.password)
    expect(signedIn.body?.status, JSON.stringify(signedIn.body)).toBe('signed_in')
    rep.secret = await enrolTotp(w.h, rep.browser)
    rep.id = user.id
  })

  it('T30 the rep’s sheet, board and switcher hold customer A only; Beta’s label and Beta’s picture give nothing', async () => {
    const rows = await sheet('rep')
    const ordersA = (await admin<{ number: string }>(w, 'SELECT number FROM "SalesOrder" WHERE "tenantId" = $1 AND "partyId" = $2 ORDER BY number', [w.tenant.id, P1()])).map((row) => row.number)
    expect([...rows.keys()].sort()).toEqual(ordersA)
    expect([...rows.values()].every((row) => row.partyId === P1())).toBe(true)
    const board = await asRep('GET', '/sales/orders/board')
    expect((board.byStatus as Json[]).reduce((sum, entry) => sum + entry.count, 0)).toBe(ordersA.length)
    const switcher = await asRep('GET', '/sales/orders/customers')
    expect(switcher).toMatchObject({ limited: true, total: 1 })
    expect(switcher.customers.map((entry: Json) => entry.id)).toEqual([P1()])
    expect((await sheet('rep', `brand=${P3()}`)).size).toBe(0)
    expect((await sheet('rep', `partyId=${P3()}`)).size).toBe(0)
    expect(await asRep('GET', `/sales/orders/board?partyId=${P3()}`)).toMatchObject({ tiles: expect.any(Array) })
    await asRep('GET', `/sales/orders/${G.betaPart.id}/picture`, undefined, 404)
    await asRep('GET', `/sales/orders/${G.betaPart.id}`, undefined, 404)
    G.ordersA = ordersA
  })

  it('T19 the rep’s saved view of customer A: its export file and its Pin to Today count hold only A’s orders; the office’s view of Beta is not listed', async () => {
    // The office's shared view of Beta's sheet: a rep limited to A never sees it, not even its name (B-TH-020).
    await ok(P.owner, 'POST', '/views', { listKey: 'sales.orders', name: 'Brand Beta - all orders', audience: 'EVERYONE', state: { query: `rows=all&party=${P3()}` } }, 201)
    const { view } = await asRep('POST', '/views', { listKey: 'sales.orders', name: 'Brand Alpha - all orders', state: { query: `rows=all&party=${P1()}` } }, 201)
    const listed = await asRep('GET', '/views?listKey=sales.orders')
    expect(JSON.stringify(listed)).not.toContain('Brand Beta')
    // The file of the view (and of "every customer" as the rep sees them): A's orders only.
    for (const [query, viewName] of [[`rows=all&party=${P1()}`, view.name], ['rows=all', undefined]] as const) {
      const { job } = await asRep('POST', '/exports', { listKey: 'sales.orders', format: 'XLSX', query, columns: EXPORT_COLUMNS, title: 'Orders', locale: 'en', ...(viewName ? { viewName } : {}) }, 201)
      const file = await fileRows(job.id, (method, url) => asRep(method, url))
      expect(file.rows.map((row) => row.Number).sort()).toEqual(G.ordersA)
      expect(new Set(file.rows.map((row) => row.Customer))).toEqual(new Set([BRAND_ALPHA.legalName]))
      for (const row of file.rows) expect((row.Brand ?? '').split(', ').filter((label) => label !== 'Own collection')).toEqual([BRAND_ALPHA.legalName])
      rep.seen.push({ url: `file of ${query}`, status: 200, body: file.text })
    }
    // Pin to Today: the view's count is A's orders.
    const followed = await asRep('PUT', `/notifications/following/views/${view.id}`, {})
    expect((followed.views as Json[]).find((entry) => entry.viewId === view.id)).toMatchObject({ count: G.ordersA.length, capped: false })
    // The factory's own file of every customer holds both (the control: the wall stands between customers, not before the office).
    const { job } = await ok(P.owner, 'POST', '/exports', { listKey: 'sales.orders', format: 'XLSX', query: 'rows=all', columns: EXPORT_COLUMNS, title: 'Orders', locale: 'en' }, 201)
    const office = await fileRows(job.id, (method, url) => ok(P.owner, method, url))
    expect(office.rows.map((row) => row.Number)).toEqual(expect.arrayContaining([G.betaPart.number, G.betaAll.number, 'SEED-SO-0001']))
    expect(office.rows.find((row) => row.Number === G.betaPart.number)).toMatchObject({ Invoiced: 'Part', Picture: 'BX-200 Brand Beta city jacket (made up) (+1)' })
  })

  it('T00 the name scan: every answer and file the rep got holds nothing of Brand Beta', async () => {
    const markers = await markersOf(w, BRAND_BETA, P3())
    expect(markers.length).toBeGreaterThan(10)
    const problems = rep.seen.flatMap((entry) => findMarkers(entry.body, markers).map((found) => `${entry.url} (${entry.status}): ${found}`))
    expect(problems).toEqual([])
    expect(rep.seen.length).toBeGreaterThan(10)
  })

  it('Z no route answered 500 during the flow', () => {
    expect(unexpected.map((report) => `${report.context.method} ${report.context.route}: ${report.name}: ${report.message} ${report.stack.slice(0, 3).join(' | ')}`)).toEqual([])
  })
})
