import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { businessDate } from '@nexus/factory-domain/core/time'
import { PRICED_WORDS } from '@nexus/factory-domain/files/priced'
import type { ErrorReport } from '@nexus/factory-domain/observability/report'
import { addDays } from '@nexus/factory-domain/planning/buy'
import { BLIND_PRICE_WORDS } from '@nexus/factory-domain/sales/blind-price'
import { useServerClock } from '../../core/time' // B-CP-022 (fix wave cp-fx8)
import { createErrorTracker, useErrorTracker } from '../../observability/tracker'
import { useAbuseGuard } from '../../platform/abuse/guard'
import { usePortalOptions } from '../../platform/auth/portal/service'
import { freshGuard } from '../../platform/auth/portal/testing/portal'
import { addUser } from '../../platform/auth/sessions/testing/harness'
import { fakeScanner } from '../../platform/files/scan/fake'
import { useScanner } from '../../platform/files/scan/service'
import type { EventHandler } from '../../platform/outbox/dispatch'
import { standardReasonsForNewTenants } from '../../platform/reasons/standard'
import type { SearchIndexer } from '../../platform/search/indexer'
import { indexNewTenants } from '../../platform/search/indexing'
import { everyHandler, searchIndexers, settler } from '../daily/testing/day'
import { asBrand, BRAND_ALPHA, BRAND_BETA, findMarkers, markersOf, setUpBrand, type BrandInWorld, type Seen } from '../portal/testing/two-brands'
import { admin, ok, person, QUIET, startWorld, stepped, type Person, type World } from '../testing/world'
import {
  ALPHA_PEOPLE,
  alphaPeopleMarkers,
  as,
  brandNoPriceIn,
  givenPerson,
  invitePortalPerson,
  keysOf,
  liveMessagesOf,
  MONEY,
  NO_PRICE,
  noPriceIn,
  offerEveryRole,
  officeActor,
  officeLive,
  pathsOf,
  portalActor,
  portalLive,
  PRICE_HOLDERS,
  priceKeysIn,
  roleIdOf,
  SALES_AND_MANAGER,
  upload,
  WORDS,
  type AlphaNoPrice,
  type OfficeKey,
} from './world'

/**
 * B-CP-022 — THE MONEY-WALL SWEEP (customer page plan C4, O1–O3: "our prices are seen only by the Owner and the people he names";
 * design customer-page 11 §3; review E9; Owner rule 2026-11-16: "One brand must not be able to see anything related to any other
 * brand. But we, as the production unit, should be able to see it all. And manage it all as well."). ONE file, every persona of the
 * plan, on the golden world (../testing/world.ts: every base seed, the real app and sign-in, every outside provider FAKE) with the
 * worker's handlers run in-process, through the HTTP routes:
 *
 *   W   the world: Brand Alpha (P1) with its Buyer, Designer, Production person and Viewer; Brand Beta (P3) with its Buyer; the office
 *       people with their role templates, an "Accountant (prices)" role the Owner makes and gives, a Finance limited to Brand Beta, a
 *       Sales worker with a price role limited to Brand Alpha (follow-up 2); the money of SEED-SO-0002 (the customer's PO ticked
 *       "shows prices", the customer's price per line — one Equal, one Not equal —, its confirmation PDF, an Owner's note carrying the
 *       PO and a plain logo); Brand Beta's own order and PO.
 *   M   per surface, "as Sales worker" AND "as Production manager" (and Planner, Administrator, Factory designer), against the price
 *       holders (Owner, Accountant (prices), Finance):
 *       M01 API: the order read and the list rows carry no price key
 *       M02 API: the price check 403, the summary 403, the priceMatch term 403, a PUT body 403, a discount on a manual order 403
 *       M03 API: the office's read of a portal draft (M-CP-1): no Your price, no draft value
 *       M04 export: the four price-check columns left out AND named, the term refused in words
 *       M05 PDF / file: the confirmation by id 404, the ticked PO 404, the PRICED lock in lists, previews locked, the order's Files
 *           tab and the work order's Order files count it (never name it), the pack's priced part NOT_SHOWN
 *       M06 attach to a mail / note / reply "File not found."; a link refused in words
 *       M07 the audit and the dock timeline: no OrderBrandPrice row
 *       M08 live: brand_price_changed reaches price holders only
 *       M09 notification: the customer's price change alerts the Owner, nobody without prices
 *       M10 search: a priced file's name or an amount finds nothing
 *       M11 M-CP-2: Brand Alpha's Designer, Production person and Viewer read no price; its Buyer reads its own (O4)
 *       M12 M-CP-3: the office Factory designer sees no price anywhere
 *       M13 only the Owner gives a price role (Finance, Accountant (prices), the guest accountant's "Give access")
 *       M14 B-CP-026: the four blind Sales price acts are 403 in words
 *       M15 a priced file never reaches a floor
 *   B   the brand wall inside the sweep: Beta 404 on Alpha's price check (portal and office), Beta's summary never counts Alpha, a
 *       Beta PO cannot price an Alpha order, Beta's people open none of Alpha's priced files
 *   F02 follow-up 2 (Owner decides): a price role limited to Brand Alpha reading Brand Beta's rows — what the code does today
 *   T00 the name scan: nothing Brand Beta's people got names Brand Alpha
 *   Z   no route answered 500 during the sweep
 *
 * SQL only reads ids and asserts: no step is made by SQL. Every name, address, number and price is made up.
 * Run with `node scripts/factory/golden-flow.mjs money-wall`.
 */

let w: World
let handlers: readonly EventHandler[]
let indexers: readonly SearchIndexer[]
let settle: () => Promise<string[]>
/** B-CP-022 (fix wave cp-fx8): one call with the commands on the harness clock too (testing/world.ts oneClock, for that call only). */
async function onOneClock<T>(work: () => Promise<T>): Promise<T> {
  useServerClock(w.h.clock)
  try {
    return await work()
  } finally {
    useServerClock(undefined)
  }
}
type Json = Record<string, any>
const P = {} as Record<OfficeKey, Person>
/** Brand Alpha's people (its Buyer is its main portal person). */
const A = {} as Record<'buyer' | AlphaNoPrice, BrandInWorld>
let beta: BrandInWorld
/** Every answer a brand's portal person got: what the T00 scan reads. */
const seen: Seen[] = []
/** What the API reported as unexpected (a 500) during the sweep: none at the end. */
const unexpected: ErrorReport[] = []
const G = {} as Record<string, any>
const id = (key: string) => w.id(key)
const companyA = () => id('company:A')
const today = () => businessDate(new Date())
const P1 = () => id('party:P1')
const P3 = () => id('party:P3')
/** THE money order: Brand Alpha's SEED-SO-0002 (CONFIRMED), its two lines, its work order SEED-WO-0001. */
const SO2 = () => id('production:sales-order:SO-0002')
const LINE10 = () => id('production:sales-order:SO-0002:10')
const LINE20 = () => id('production:sales-order:SO-0002:20')
const WO1 = () => id('production:work-order:WO-0001')
/** The seeds' export to Switzerland (its papers are priced: the proforma, the commercial invoice, the pack). */
const EXPORT_SHIPMENT = () => `ffffffff${id('customs-export:shipment:SH-0003').slice(8)}`
const BROKER = () => `ffffffff${id('customs:party:broker').slice(8)}`
const JKT01 = () => id('product:style:JKT-01')
const JKT01_BLK = () => id('product:colourway:JKT-01:BLK')
const noPrice = () => NO_PRICE.map((key) => P[key])
const salesAndManager = () => SALES_AND_MANAGER.map((key) => P[key])
const holders = () => PRICE_HOLDERS.map((key) => P[key])
/** The export's columns: three plain ones and the four of the price check (export ids, B-CP-018). */
const EXPORT_COLUMNS = [
  { key: 'number', label: 'Number' },
  { key: 'customer', label: 'Customer' },
  { key: 'status', label: 'Status' },
  { key: 'ourPrice', label: 'Our price' },
  { key: 'brandPrice', label: "Customer's price" },
  { key: 'priceMatch', label: 'Price check' },
  { key: 'priceDiff', label: 'Difference' },
]
const PRICE_COLUMN_KEYS = ['brandPrice', 'ourPrice', 'priceDiff', 'priceMatch']

/** A made-up own-collection jacket for Brand Beta's order (the production manager's route, as the threads goldens make one). */
async function newStyle(code: string, name: string): Promise<Json> {
  const { style } = await ok(
    P.manager,
    'POST',
    '/product/styles',
    { code, name, productType: 'JACKET', season: 'FW27', sizeScaleId: id('product:size-scale:EU-JKT'), sizes: ['50', '52'], baseSize: '52', ppeCategory: 'NOT_PPE', colourways: [{ code: 'BLU', name: 'Blu', colourId: id('product:colour:RED') }], generateSkus: true },
    201,
  )
  await ok(P.manager, 'POST', `/product/styles/${style.id}/revisions`, { changeNote: `First revision of ${code}` }, 201)
  return style
}

/** The order's files a person reads on its Files tab (GET /sales/orders/:id/files): the ORDER group. */
async function orderGroup(who: Person): Promise<Json | null> {
  const answer = await as(who, 'GET', `/sales/orders/${SO2()}/files`)
  if (answer.status !== 200) {
    expect([403, 404], `${who.key}: ${JSON.stringify(answer.body).slice(0, 300)}`).toContain(answer.status)
    return null
  }
  return ((answer.body.groups as Json[]) ?? []).find((group) => group.key === 'ORDER') ?? null
}

/** A refusal in the money wall's words: 403 and "Shown to people who see prices." (the price check, the summary, the term). */
async function heldForPrices(who: Person, method: 'GET' | 'PUT' | 'POST', url: string, body?: unknown): Promise<Json> {
  const answer = await as(who, method, url, body)
  expect(answer.status, `${who.key} ${method} ${url}: ${JSON.stringify(answer.body).slice(0, 300)}`).toBe(403)
  return answer.body as Json
}

/** The blind price acts' hold: 403, refusal/BLIND_PRICE in words and the field it rests on, never an amount. */
async function blindHeld(who: Person, method: 'POST' | 'PUT', url: string, body: unknown, at: string): Promise<void> {
  const answer = await as(who, method, url, body)
  expect(answer.status, `${who.key} ${method} ${url}: ${JSON.stringify(answer.body).slice(0, 400)}`).toBe(403)
  expect(answer.body.error.message).toBe(BLIND_PRICE_WORDS.en)
  expect(answer.body.error.issues).toEqual([{ path: 'refusal/BLIND_PRICE', message: BLIND_PRICE_WORDS.en }, { path: at, message: BLIND_PRICE_WORDS.en }])
  expect(JSON.stringify(answer.body)).not.toMatch(/\d+[.,]\d{2}\b|€/)
}

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
    ['planner', 'planner'],
    ['finance', 'finance'],
    ['designer', 'designer'],
  ] as const) {
    P[key] = await person(w, key, role)
  }
}, 1_200_000)

afterAll(async () => {
  useScanner(undefined)
  useAbuseGuard(undefined)
  usePortalOptions({})
  useErrorTracker(undefined)
  await w?.close()
}, 60_000)

describe('B-CP-022 the money wall: every persona, every surface, as Sales worker and as Production manager; the brand wall inside it', { timeout: 300_000 }, () => {
  it('W00 the world: the seeds drain; the search index is built', async () => {
    await standardReasonsForNewTenants({ database: w.h.database, log: QUIET })
    await indexNewTenants({ database: w.h.database, indexers, log: QUIET })
    await settle()
  })

  it('W01 the brands: P1 is Brand Alpha (its Buyer, Designer, Production person and Viewer, each signed in by code), P3 is Brand Beta (its Buyer)', async () => {
    A.buyer = await setUpBrand(w, P.sales, BRAND_ALPHA, P1(), companyA(), { roleKey: 'customer-buyer', capabilities: ['comment', 'upload'] })
    beta = await setUpBrand(w, P.sales, BRAND_BETA, P3(), companyA(), { roleKey: 'customer-buyer', capabilities: ['comment', 'upload'] })
    await offerEveryRole(w, P.sales, P1())
    A.designer = await invitePortalPerson(w, P.sales, A.buyer, ALPHA_PEOPLE.designer, 'customer-designer', companyA())
    A.production = await invitePortalPerson(w, P.sales, A.buyer, ALPHA_PEOPLE.production, 'customer-production', companyA())
    A.viewer = await invitePortalPerson(w, P.sales, A.buyer, ALPHA_PEOPLE.viewer, 'customer-viewer', companyA())
    for (const who of Object.values(A)) expect(await asBrand(who, seen, 'GET', '/portal/me')).toMatchObject({ party: { id: P1() } })
    expect(await asBrand(beta, seen, 'GET', '/portal/me')).toMatchObject({ party: { id: P3() } })
    await settle()
  })

  it('W02 the office people: the Owner makes "Accountant (prices)" and gives it; the Administrator gives roles without prices; a Finance limited to Brand Beta; a Sales worker with a price role limited to Brand Alpha', async () => {
    // A role that sees prices only (O2/O3: the Owner makes it; two-factor always).
    await stepped(w, P.owner)
    const accountantRole = await ok(P.owner, 'POST', '/auth/roles', { key: 'accountant_prices', name: 'Accountant (prices)', permissions: ['home.view', 'parties.view', 'orders.view', 'files.read', 'audit.read', 'threads.read', 'views.export'], grains: ['price'], requireMfa: true })
    G.accountantRoleId = accountantRole.id as string
    // A role without prices that sends file links (the Owner makes it; the Administrator gives it to the Sales worker and the Production manager).
    await stepped(w, P.owner)
    const linksRole = await ok(P.owner, 'POST', '/auth/roles', { key: 'links_sender', name: 'Links sender', permissions: ['links.view', 'links.manage'] })
    for (const who of [P.sales, P.manager]) {
      await stepped(w, P.admin)
      await ok(P.admin, 'POST', `/auth/users/${who.id}/roles`, { roleId: linksRole.id, allCompanies: true })
    }
    G.financeRoleId = await roleIdOf(P.admin, 'finance')
    G.salesRoleId = await roleIdOf(P.admin, 'sales')
    P.accountant = await givenPerson(w, 'accountant', [{ by: P.owner, roleId: G.accountantRoleId }])
    P.betaFinance = await givenPerson(w, 'betaFinance', [{ by: P.owner, roleId: G.financeRoleId, partyIds: [P3()] }])
    P.alphaPriced = await givenPerson(w, 'alphaPriced', [
      { by: P.admin, roleId: G.salesRoleId },
      { by: P.owner, roleId: G.accountantRoleId, partyIds: [P1()] },
    ])
    // Who holds the price grain, as each session says it.
    for (const who of holders()) expect((await ok(who, 'GET', '/auth/office/me')).permissions, who.key).toContain('money.price')
    for (const who of noPrice()) {
      const permissions = (await ok(who, 'GET', '/auth/office/me')).permissions as string[]
      for (const grain of ['money.price', 'money.margin']) expect(permissions, `${who.key} holds ${grain}`).not.toContain(grain)
    }
  })

  it('W03 the money of SEED-SO-0002: the customer’s PO ticked "shows prices", the customer’s price per line (one Equal, one Not equal), its confirmation PDF, the Owner’s note; Brand Beta’s own order and PO', async () => {
    // The customer's PO, ticked at upload (shared with Alpha's portal and its links), and a plain logo beside it.
    const po = await upload(w, P.owner, companyA(), { recordType: 'SalesOrder', recordId: SO2(), visibility: ['OFFICE', 'PARTNER', 'LINK'], partyId: P1(), priced: true }, MONEY.alphaPo)
    expect(po).toMatchObject({ priced: true, originalName: MONEY.alphaPo })
    G.po = po.id as string
    G.poVersion = po.version as number
    G.logo = (await upload(w, P.owner, companyA(), { recordType: 'SalesOrder', recordId: SO2(), visibility: ['OFFICE', 'PARTNER'], partyId: P1() }, MONEY.logo)).id as string
    // The customer's price: line 10 at our own line total from its PO (Equal), line 20 a line total 10.00 under ours (Not equal).
    const before = await ok(P.owner, 'GET', `/sales/orders/${SO2()}/price-check`)
    const line = (lineId: string) => (before.lines as Json[]).find((entry) => entry.lineId === lineId)!
    G.ours10 = line(LINE10()).ourAmount as number
    G.ours20 = line(LINE20()).ourAmount as number
    const check = await ok(P.owner, 'PUT', `/sales/orders/${SO2()}/brand-prices`, {
      currency: before.currency,
      rows: [
        { lineId: LINE10(), netAmount: G.ours10, source: 'CUSTOMER_PO', sourceFileId: G.po, note: MONEY.priceNote },
        { lineId: LINE20(), netAmount: G.ours20 - 1_000, source: 'OFFICE' },
      ],
    })
    const after = (lineId: string) => (check.lines as Json[]).find((entry) => entry.lineId === lineId)!
    expect(after(LINE10())).toMatchObject({ priceMatch: 'EQUAL', priceDiff: 0 })
    expect(after(LINE20())).toMatchObject({ priceMatch: 'NOT_EQUAL', priceDiff: 1_000, brandAmount: G.ours20 - 1_000 })
    expect(check.total).toMatchObject({ priceMatch: 'NOT_EQUAL', priceNotEqualLines: 1 })
    G.row10 = after(LINE10()).row
    G.row20 = after(LINE20()).row
    G.brandAmount20 = G.ours20 - 1_000
    // Its confirmation PDF, made by the Owner: born priced.
    const confirmation = await ok(P.owner, 'POST', `/sales/orders/${SO2()}/confirmation`, {}, 201)
    G.confirmation = confirmation.fileId as string
    expect((await admin<{ priced: boolean }>(w, 'SELECT priced FROM "StoredFile" WHERE id = $1', [G.confirmation]))[0]!.priced).toBe(true)
    // The Owner's office note carries both files (a price holder may attach a priced one); the search indexes the message.
    const note = await ok(P.owner, 'POST', `/threads/SalesOrder/${SO2()}/notes`, { body: MONEY.ownerNote, attachments: [G.po, G.logo] }, 201)
    G.note = note.message.id as string
    // Brand Beta's own order (typed by the Owner, with its prices) and its own PO on it.
    G.betaStyle = await newStyle('MW-OWN-01', 'Own collection city jacket (made up)')
    const betaOrder = await ok(P.owner, 'POST', '/sales/orders/manual', { companyId: companyA(), partyId: P3(), customerRef: MONEY.betaRef, promiseDate: addDays(today(), 45), depositPct: null, lines: [{ styleId: G.betaStyle.id, colourwayId: G.betaStyle.colourways[0].id, unitPrice: '80', sizes: [{ size: '52', quantity: 3 }] }] }, 201)
    G.betaOrder = betaOrder.order.id as string
    G.betaPo = (await upload(w, P.owner, companyA(), { recordType: 'SalesOrder', recordId: G.betaOrder, visibility: ['OFFICE', 'PARTNER'], partyId: P3() }, MONEY.betaPo)).id as string
    await settle()
  })

  it('M01 API: the order read and the list rows — the price holders read our prices and the check; Sales worker, Production manager, Planner, Administrator and Factory designer read no price key', async () => {
    for (const who of holders()) {
      const order = (await ok(who, 'GET', `/sales/orders/${SO2()}`)).order
      expect(order, who.key).toHaveProperty('netAmount')
    }
    const owners = ((await ok(P.owner, 'GET', `/sales/orders?partyId=${P1()}&limit=200`)).orders as Json[]).find((row) => row.id === SO2())!
    expect(owners).toMatchObject({ priceMatch: 'NOT_EQUAL', priceNotEqualLines: 1, priceDiff: 1_000 })
    for (const who of noPrice()) {
      const order = await noPriceIn(who, `/sales/orders/${SO2()}`)
      const list = await noPriceIn(who, `/sales/orders?partyId=${P1()}&limit=200`)
      if (list) expect(((list.orders as Json[]) ?? []).map((row) => row.id), who.key).toContain(SO2())
      // As Sales worker and as Production manager the order itself is read (orders.view): only its money is left out.
      if (SALES_AND_MANAGER.includes(who.key as OfficeKey)) {
        expect(order, `${who.key} reads the order`).not.toBeNull()
        expect(list, `${who.key} reads the list`).not.toBeNull()
      }
    }
  })

  it('M02 API: the price check, the summary, the priceMatch term, a PUT body and a discount — 403 in words for every person without prices, nothing written; the price holders read them', async () => {
    for (const who of holders()) {
      const check = await ok(who, 'GET', `/sales/orders/${SO2()}/price-check`)
      expect(check.total, who.key).toMatchObject({ priceMatch: 'NOT_EQUAL' })
    }
    expect((await ok(P.owner, 'GET', `/sales/brand-prices/summary?partyId=${P1()}`)).priceNotEqualCount).toBeGreaterThanOrEqual(1)
    expect(((await ok(P.owner, 'GET', `/sales/orders?partyId=${P1()}&priceMatch=NOT_EQUAL&limit=200`)).orders as Json[]).map((row) => row.id)).toContain(SO2())
    const rowsBefore = await admin(w, `SELECT id, version FROM "OrderBrandPrice" WHERE "salesOrderId" = $1 ORDER BY id`, [SO2()])
    // Who reads the order (orders.view: Sales worker, Production manager, Factory designer) is refused in the money wall's words; who
    // does not reach it at all (Planner, Administrator) is refused by right (403) or as an unknown order (404). Never a figure.
    const reaches = new Set<OfficeKey>(['sales', 'manager', 'designer'])
    for (const who of noPrice()) {
      for (const [method, url, body] of [
        ['GET', `/sales/orders/${SO2()}/price-check`, undefined],
        ['GET', `/sales/brand-prices/summary?partyId=${P1()}`, undefined],
        ['PUT', `/sales/orders/${SO2()}/brand-prices`, { rows: [{ lineId: LINE20(), netAmount: G.ours20, source: 'OFFICE', version: G.row20.version }] }],
        ['POST', `/sales/orders/${SO2()}/brand-prices/from-request`, {}],
      ] as const) {
        const answer = await as(who, method, url, body)
        if (reaches.has(who.key as OfficeKey)) expect(answer.status, `${who.key} ${method} ${url}: ${JSON.stringify(answer.body).slice(0, 300)}`).toBe(403)
        else expect([403, 404], `${who.key} ${method} ${url}`).toContain(answer.status)
        expect(priceKeysIn(answer.body), `${who.key} ${method} ${url}`).toEqual([])
      }
    }
    // The term on the list and on its overall totals: refused in words to whoever reads the list without prices.
    for (const who of salesAndManager()) {
      const term = await heldForPrices(who, 'GET', `/sales/orders?partyId=${P1()}&priceMatch=NOT_EQUAL`)
      expect(term.error.message, who.key).toBe(WORDS.notAPriceHolder)
      expect(term.error.message).toBe((await heldForPrices(who, 'GET', `/sales/orders/summary?partyId=${P1()}&priceMatch=NOT_EQUAL`)).error.message)
      expect((await heldForPrices(who, 'GET', `/sales/orders/${SO2()}/price-check`)).error.message, who.key).toBe(WORDS.notAPriceHolder)
    }
    // A discount typed by a Sales worker on a manual order: refused by its field (the price grain), nothing made; the Production
    // manager makes no order at all.
    const manual = (discount: boolean) => ({ companyId: companyA(), partyId: P1(), customerRef: 'MW-DISCOUNT-1', promiseDate: addDays(today(), 60), depositPct: null, lines: [{ styleId: JKT01(), colourwayId: JKT01_BLK(), sizes: [{ size: '50', quantity: 2 }], ...(discount ? { discountPct: '10' } : {}) }] })
    const discount = await as(P.sales, 'POST', '/sales/orders/manual', manual(true))
    expect(discount.status, JSON.stringify(discount.body)).toBe(403)
    expect(pathsOf(discount.body)).toContain('lines/0/discountPct')
    expect((await as(P.manager, 'POST', '/sales/orders/manual', manual(true))).status).toBe(403)
    expect(await admin(w, `SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND "customerRef" = 'MW-DISCOUNT-1'`, [w.tenant.id])).toEqual([])
    // Nothing moved.
    expect(await admin(w, `SELECT id, version FROM "OrderBrandPrice" WHERE "salesOrderId" = $1 ORDER BY id`, [SO2()])).toEqual(rowsBefore)
  })

  it('M03 API: the office reads Brand Alpha’s portal draft (M-CP-1) — the Owner sees its Your price and value; a Sales worker and a Production manager read neither', async () => {
    // Brand Alpha's Buyer drafts an order with Your price (a catalogue line and a line in its own words).
    const style = (await admin<{ id: string }>(w, `SELECT id::text AS id FROM "Style" WHERE "tenantId" = $1 AND code = 'SEED-JKT-02'`, [w.tenant.id]))[0]!.id
    const black = (await admin<{ id: string }>(w, `SELECT id::text AS id FROM "Colourway" WHERE "styleId" = $1 AND code = 'BLK'`, [style]))[0]!.id
    let draft = (await asBrand(A.buyer, seen, 'POST', '/portal/order-requests', { customerRef: MONEY.draftRef }, 201)).request
    const url = `/portal/order-requests/${draft.id}`
    draft = (await asBrand(A.buyer, seen, 'POST', `${url}/lines`, { version: draft.version, lines: [{ styleId: style, colourwayId: black, sizes: [{ size: '50', quantity: 2 }], brandUnitPrice: '400' }] })).request
    draft = (await asBrand(A.buyer, seen, 'POST', `${url}/custom-lines`, { version: draft.version, line: { kind: 'DESCRIBED', description: MONEY.draftWords, quantity: 3, brandUnitPrice: '390' } })).request
    G.draft = draft
    G.draftUrl = url
    G.draftCustomLine = draft.customLines[0].id as string
    await settle()
    // The Owner: the draft's value on its row, Your price on its lines.
    const owners = ((await ok(P.owner, 'GET', `/sales/order-requests?status=DRAFT&partyId=${P1()}`)).requests as Json[]).find((row) => row.id === draft.id)!
    expect(typeof owners.draft.draftValueAmount).toBe('number')
    expect(keysOf((await ok(P.owner, 'GET', `/sales/order-requests/${draft.id}`)).request)).toContain('brandUnitPrice')
    // As Sales worker / as Production manager (and the others without prices): no value, no Your price, part 6 not counted.
    for (const who of noPrice()) {
      const list = await noPriceIn(who, `/sales/order-requests?status=DRAFT&partyId=${P1()}`)
      if (list) {
        const row = ((list.requests as Json[]) ?? []).find((entry) => entry.id === draft.id)
        if (row) expect(row.draft, who.key).not.toHaveProperty('draftValueAmount')
      }
      await noPriceIn(who, `/sales/order-requests/${draft.id}`)
    }
    expect(await noPriceIn(P.sales, `/sales/order-requests/${draft.id}`), 'the Sales worker reads the draft').not.toBeNull()
  })

  it('M04 export: as Sales worker the four price-check columns are left out of the file AND named; the term is refused in words; the Owner’s file carries them', async () => {
    const asked = (who: Person, query: string) => as(who, 'POST', '/exports', { listKey: 'sales.orders', format: 'XLSX', query, columns: EXPORT_COLUMNS, title: 'Orders', locale: 'en' })
    const owners = await asked(P.owner, `rows=all&party=${P1()}`)
    expect(owners.status, JSON.stringify(owners.body)).toBe(201)
    const jobs: Record<string, string> = { owner: owners.body.job.id }
    for (const who of salesAndManager()) {
      const refused = await asked(who, `rows=all&party=${P1()}&priceMatch=NOT_EQUAL`)
      expect(refused.status, `${who.key}: ${JSON.stringify(refused.body)}`).toBe(403)
      const made = await asked(who, `rows=all&party=${P1()}`)
      if (made.status === 403) continue // no views.export: no file at all
      expect(made.status, `${who.key}: ${JSON.stringify(made.body)}`).toBe(201)
      expect(refused.body.error.message, who.key).toBe(WORDS.notAPriceHolder)
      jobs[who.key] = made.body.job.id
    }
    expect(jobs.sales, 'the Sales worker exports the list').toBeDefined()
    await settle()
    for (const [key, jobId] of Object.entries(jobs)) {
      const job = (await ok(P[key as OfficeKey], 'GET', `/exports/${jobId}`)).job
      expect(job.status, `${key}: ${job.failureReason ?? ''}`).toBe('DONE')
      const omitted = ((job.omitted ?? []) as Json[]).map((column) => column.key).sort()
      if (key === 'owner') expect(omitted).toEqual([])
      else expect(omitted, key).toEqual(PRICE_COLUMN_KEYS)
    }
  })

  it('M05 PDF / file: the confirmation and the ticked PO are 404 by id (file, download, preview), locked in the record’s list, left out of previews, counted on the order’s Files tab and on the work order’s Order files, NOT_SHOWN in the pack', async () => {
    for (const who of noPrice()) {
      for (const fileId of [G.confirmation, G.po]) {
        for (const url of [`/files/${fileId}`, `/files/${fileId}/download`, `/files/${fileId}/preview`]) {
          const answer = await as(who, 'GET', url)
          expect([answer.status, answer.body?.error?.message], `${who.key} ${url}`).toEqual([404, WORDS.fileNotFound])
          expect(JSON.stringify(answer.body)).not.toContain(MONEY.alphaPo)
        }
      }
      // The record's list: the priced files counted and locked, never named; the plain logo named.
      const listed = await as(who, 'GET', `/files?recordType=SalesOrder&recordId=${SO2()}`)
      if (listed.status === 200) {
        const files = (listed.body.files ?? []) as Json[]
        expect(JSON.stringify(files), who.key).not.toContain(MONEY.alphaPo)
        for (const fileId of [G.po, G.confirmation]) {
          const entry = files.find((file) => file.id === fileId)
          if (entry) expect(entry, `${who.key} ${fileId}`).toMatchObject({ locked: 'PRICED', originalName: '' })
        }
      } else expect([403, 404], who.key).toContain(listed.status)
    }
    // The price holders open them.
    for (const who of holders()) expect((await ok(who, 'GET', `/files/${G.po}`)).file, who.key).toMatchObject({ id: G.po, originalName: MONEY.alphaPo, priced: true })
    // The order's Files tab: as Sales worker and as Production manager left out, counted, never named; open 404; no preview.
    for (const who of salesAndManager()) {
      const group = await orderGroup(who)
      if (!group) continue
      expect(group.pricedLeftOut, who.key).toBeGreaterThanOrEqual(1)
      expect(((group.files ?? []) as Json[]).map((file) => file.id), who.key).not.toContain(G.po)
      expect(JSON.stringify(group)).not.toContain(MONEY.alphaPo)
      const open = await as(who, 'POST', `/sales/orders/${SO2()}/files/${G.po}/open`, {})
      expect([open.status, open.body?.error?.message], who.key).toEqual([404, WORDS.fileNotFound])
      const previews = await as(who, 'POST', `/sales/orders/${SO2()}/files/previews`, { fileIds: [G.po, G.logo] })
      expect(previews.status, JSON.stringify(previews.body)).toBe(200)
      expect(((previews.body.previews ?? []) as Json[]).map((preview) => preview.fileId), who.key).not.toContain(G.po)
    }
    expect(await orderGroup(P.sales), 'the Sales worker reads the order’s files').not.toBeNull()
    const ownersGroup = (await orderGroup(P.owner))!
    expect(ownersGroup.pricedLeftOut).toBe(0)
    expect(((ownersGroup.files ?? []) as Json[]).map((file) => file.id)).toContain(G.po)
    // The work order's "Order files" (production): the priced files counted (pricedLeftOut), never named, opening is the unknown 404.
    for (const who of [P.manager, P.planner, P.sales]) {
      const answer = await as(who, 'GET', `/production/work-orders/${WO1()}/order-files`)
      if (answer.status !== 200) {
        expect([403, 404], `${who.key}: ${JSON.stringify(answer.body).slice(0, 200)}`).toContain(answer.status)
        continue
      }
      const group = ((answer.body.groups ?? []) as Json[]).find((entry) => entry.order?.id === SO2())!
      expect(group, `${who.key}: the order’s group`).toBeDefined()
      expect(group.pricedLeftOut, who.key).toBeGreaterThanOrEqual(1)
      expect(JSON.stringify(answer.body), who.key).not.toContain(G.po)
      expect(JSON.stringify(answer.body), who.key).not.toContain(MONEY.alphaPo)
      const open = await as(who, 'POST', `/production/work-orders/${WO1()}/order-files/${G.po}/open`, {})
      expect([open.status, open.body?.error?.message], who.key).toEqual([404, WORDS.fileNotFound])
    }
    expect((await as(P.manager, 'GET', `/production/work-orders/${WO1()}/order-files`)).status, 'the Production manager reads the work order’s files').toBe(200)
    // The pack of the seeds' export: its priced papers made by the Owner; the pack shows them NOT_SHOWN to whoever sees no price.
    for (const [url, body] of [
      [`/shipping/shipments/${EXPORT_SHIPMENT()}/export/declaration`, { brokerPartyId: BROKER() }],
      [`/shipping/shipments/${EXPORT_SHIPMENT()}/packing-list`, {}],
      [`/shipping/shipments/${EXPORT_SHIPMENT()}/export/commercial-invoice`, { language: 'en' }],
      ['/shipping/proformas', { recordType: 'Shipment', recordId: EXPORT_SHIPMENT(), language: 'en' }],
      [`/shipping/shipments/${EXPORT_SHIPMENT()}/pack`, { print: false }],
    ] as const) {
      const made = await as(P.owner, 'POST', url, body)
      expect([200, 201], `${url}: ${JSON.stringify(made.body).slice(0, 300)}`).toContain(made.status)
    }
    for (const who of salesAndManager()) {
      const answer = await as(who, 'GET', `/shipping/shipments/${EXPORT_SHIPMENT()}/pack`)
      if (answer.status !== 200) {
        expect([403, 404], who.key).toContain(answer.status)
        continue
      }
      for (const kind of ['PROFORMA', 'COMMERCIAL_INVOICE']) expect(((answer.body.parts ?? []) as Json[]).find((part) => part.kind === kind), `${who.key} ${kind}`).toMatchObject({ state: 'NOT_SHOWN' })
    }
    const ownersPack = await ok(P.owner, 'GET', `/shipping/shipments/${EXPORT_SHIPMENT()}/pack`)
    expect(((ownersPack.parts ?? []) as Json[]).find((part) => part.kind === 'PROFORMA')).toMatchObject({ state: 'READY' })
  })

  it('M06 attach to a mail, an office note or a portal reply: "File not found." for a person without prices (nothing queued); a link of it is refused in words; the Owner’s go', async () => {
    const NOT_FOUND = { path: 'body/attachments/0', message: WORDS.fileNotFound }
    const outbound = async () => (await admin<{ n: number }>(w, 'SELECT count(*)::int AS n FROM "EmailOutbound" WHERE "tenantId" = $1', [w.tenant.id]))[0]!.n
    for (const who of salesAndManager()) {
      const before = await outbound()
      const mail = await as(who, 'POST', `/threads/SalesOrder/${SO2()}/emails`, { to: [BRAND_ALPHA.contact.email], subject: 'Your order', body: 'Here is the paper you sent us.', attachments: [G.po] })
      if (mail.status !== 403) {
        expect(mail.status, `${who.key}: ${JSON.stringify(mail.body)}`).toBe(400)
        expect(mail.body.error.issues, who.key).toContainEqual(NOT_FOUND)
      }
      expect(JSON.stringify(mail.body)).not.toContain(MONEY.alphaPo)
      expect(await outbound(), who.key).toBe(before)
      const note = await as(who, 'POST', `/threads/SalesOrder/${SO2()}/notes`, { body: 'Forwarding the paper to the pattern room.', attachments: [G.po] })
      expect(note.status, `${who.key}: ${JSON.stringify(note.body)}`).toBe(400)
      expect(note.body.error.issues, who.key).toEqual([NOT_FOUND])
      // B-CP-022 (fix wave cp-fx8): the portal reply on ONE clock, as in production. This flow's commands run on the server clock, the
      // office sign-in, the portal and the invitations on the harness clock, which every two-factor act moves 30 s on (about 13 minutes
      // ahead by here): Brand Alpha's portal roles are dated by it, so at the server's instant nobody of Alpha held one yet and the
      // reply was refused NO_PORTAL before its attachment was read. Refused, the call writes nothing.
      const reply = await onOneClock(() => as(who, 'POST', `/threads/SalesOrder/${SO2()}/replies`, { body: 'Made-up: the paper you sent us.', attachments: [G.po] }))
      expect([400, 403], `${who.key}: ${JSON.stringify(reply.body)}`).toContain(reply.status)
      if (reply.status === 400) expect(reply.body.error.issues, who.key).toContainEqual(NOT_FOUND)
      // A link of it (both hold links.manage through "Links sender", a role without prices): refused in words, the file never named.
      const link = await as(who, 'POST', '/links/files', { purpose: 'DOCUMENT_VIEW', companyId: companyA(), partyId: P1(), email: BRAND_ALPHA.contact.email, send: false, fileIds: [G.po] })
      expect(link.status, `${who.key}: ${JSON.stringify(link.body)}`).toBe(409)
      expect(link.body.error.issues, who.key).toEqual([
        { path: 'refusal/PRICED_BY_LINK', message: PRICED_WORDS.byLink.en },
        { path: 'body/fileIds/0', message: PRICED_WORDS.byLink.en },
      ])
      expect(JSON.stringify(link.body)).not.toContain(MONEY.alphaPo)
    }
    // The plain logo goes with a Sales worker's note; nothing links the priced PO yet.
    expect((await as(P.sales, 'POST', `/threads/SalesOrder/${SO2()}/notes`, { body: 'The logo, for the pattern room.', attachments: [G.logo] })).status).toBe(201)
    expect(await admin(w, 'SELECT 1 FROM "LinkFile" WHERE "fileId" = $1', [G.po])).toEqual([])
    // The Owner's mail carries it.
    const before = await outbound()
    await ok(P.owner, 'POST', `/threads/SalesOrder/${SO2()}/emails`, { to: [BRAND_ALPHA.contact.email], subject: 'Your order', body: 'Here is the paper you sent us.', attachments: [G.po] }, 201)
    expect(await outbound()).toBe(before + 1)
    await settle()
  })

  it('M07 the audit and the dock timeline: no OrderBrandPrice row for a person without prices (the history is the price holders’)', async () => {
    for (const who of noPrice()) {
      for (const url of [`/audit/OrderBrandPrice/${SO2()}`, `/audit?recordType=OrderBrandPrice&recordId=${SO2()}`]) {
        const answer = await as(who, 'GET', url)
        if (answer.status === 403) continue // no audit.read: no history at all
        expect(answer.status, `${who.key} ${url}`).toBe(200)
        expect(answer.body.entries, `${who.key} ${url}`).toEqual([])
      }
      const timeline = await as(who, 'GET', `/threads/SalesOrder/${SO2()}/timeline?kinds=change`)
      if (timeline.status === 403) continue
      expect(timeline.status, who.key).toBe(200)
      const text = JSON.stringify(timeline.body)
      expect(text, who.key).not.toContain('brandPrices.')
      expect(text, who.key).not.toContain(G.row20.id)
      expect(text, who.key).not.toContain(MONEY.priceNote)
    }
    for (const who of salesAndManager()) expect((await as(who, 'GET', `/audit/OrderBrandPrice/${SO2()}`)).status, `${who.key} holds audit.read`).toBe(200)
    const history = (await ok(P.owner, 'GET', `/audit/OrderBrandPrice/${SO2()}`)).entries as Json[]
    expect(history.map((entry) => entry.action)).toEqual(expect.arrayContaining(['brandPrices.set']))
    // The order's own history names no customer's price either (for the Owner too: it is a history of its own).
    expect(JSON.stringify((await ok(P.owner, 'GET', `/audit/SalesOrder/${SO2()}`)).entries)).not.toContain('brandPrices.')
  })

  it('M08 live: sales_order.brand_price_changed reaches the price holders only — never a person without prices, never a brand’s portal', async () => {
    const live = await liveMessagesOf(w, 'sales_order.brand_price_changed', SO2())
    expect(live.length).toBeGreaterThanOrEqual(1)
    for (const { row, message } of live) {
      expect(Object.keys(row.payload).sort()).toEqual(['orderId', 'partyId'])
      expect(message, 'the event has a live rule').not.toBeNull()
      for (const who of noPrice()) expect(officeLive(message!, await officeActor(w, who)), `${who.key} live`).toBeNull()
      for (const who of holders()) expect(officeLive(message!, await officeActor(w, who))?.fields, `${who.key} live`).toEqual({ orderId: SO2() })
      for (const partyId of [P1(), P3()]) expect(portalLive(message!, portalActor(w, partyId)), `portal of ${partyId}`).toBeNull()
    }
  })

  it('M09 notification: Brand Alpha’s Buyer changes its price in the portal — ONE alert for the Owner, no row for anyone without prices, no amount', async () => {
    const before = await ok(A.buyer.browser, 'GET', `/portal/sales-orders/${SO2()}/price-check`)
    const line20 = (before.lines as Json[]).find((entry) => entry.lineId === LINE20())!
    // The factory's row is replaced by the customer's own (delete + insert): still 5.00 under ours.
    await asBrand(A.buyer, seen, 'PUT', `/portal/sales-orders/${SO2()}/brand-prices`, { rows: [{ lineId: LINE20(), netAmount: G.ours20 - 500, version: line20.row.version }] })
    G.brandAmount20 = G.ours20 - 500
    await settle()
    const rows = await admin<{ userId: string; params: Json; recordId: string }>(
      w,
      `SELECT "userId"::text AS "userId", params, "recordId"::text AS "recordId" FROM "Notification" WHERE "tenantId" = $1 AND "messageKey" = 'notifications.priceCheck.customerChanged' AND "recordId" = $2`,
      [w.tenant.id, SO2()],
    )
    expect(rows.map((row) => row.userId)).toContain(P.owner.id)
    for (const who of noPrice()) expect(rows.map((row) => row.userId), who.key).not.toContain(who.id)
    for (const row of rows) expect(row.params).toEqual({ orderId: SO2() })
    expect(JSON.stringify(rows)).not.toContain(String((G.ours20 - 500) / 100))
    // Nobody without prices is told of the price at all (no price-check notice of any kind on this order).
    const anyPriceNotice = await admin<{ userId: string }>(w, `SELECT "userId"::text AS "userId" FROM "Notification" WHERE "tenantId" = $1 AND "recordId" = $2 AND "messageKey" LIKE 'notifications.priceCheck.%'`, [w.tenant.id, SO2()])
    for (const who of noPrice()) expect(anyPriceNotice.map((row) => row.userId), who.key).not.toContain(who.id)
  })

  it('M10 search: a priced file’s name and an amount of the customer’s price find nothing; the plain file’s name finds its message', async () => {
    const search = async (who: Person, q: string, type = '') => {
      const answer = await as(who, 'GET', `/search?q=${encodeURIComponent(q)}${type ? `&type=${type}` : ''}`)
      expect(answer.status, `${who.key} search ${q}: ${JSON.stringify(answer.body).slice(0, 200)}`).toBe(200)
      return (answer.body.results ?? []) as Json[]
    }
    for (const who of [...salesAndManager(), P.owner]) {
      expect(await search(who, MONEY.alphaPoToken, 'Message'), `${who.key}: the priced name`).toEqual([])
      const byAmount = await search(who, ((G.brandAmount20 as number) / 100).toFixed(2))
      expect(byAmount.map((result) => result.recordId), `${who.key}: the amount`).not.toContain(SO2())
      expect(byAmount.filter((result) => result.recordType === 'OrderBrandPrice'), who.key).toEqual([])
    }
    expect((await search(P.owner, MONEY.logoToken, 'Message')).map((result) => result.recordId)).toContain(G.note)
  })

  it('M11 M-CP-2: Brand Alpha’s Designer, Production person and Viewer read no price (the order, its check, the draft, the priced PO); its Buyer reads its own prices and the check (O4)', async () => {
    const check = await asBrand(A.buyer, seen, 'GET', `/portal/sales-orders/${SO2()}/price-check`)
    expect(check).toMatchObject({ orderId: SO2(), mayWrite: { allowed: true } })
    expect(check.total).toHaveProperty('ourPrice')
    expect((await asBrand(A.buyer, seen, 'GET', `/files/${G.po}`)).file).toMatchObject({ id: G.po, originalName: MONEY.alphaPo })
    for (const key of Object.keys(ALPHA_PEOPLE) as AlphaNoPrice[]) {
      const who = A[key]
      const read = await asBrand(who, seen, 'GET', `/portal/sales-orders/${SO2()}/price-check`, undefined, 403)
      expect(priceKeysIn(read), key).toEqual([])
      await asBrand(who, seen, 'PUT', `/portal/sales-orders/${SO2()}/brand-prices`, { rows: [{ lineId: LINE10(), unitPrice: '1' }] }, 403)
      await brandNoPriceIn(who, seen, key, `/portal/sales-orders/${SO2()}`)
      await brandNoPriceIn(who, seen, key, G.draftUrl)
      const file = await asBrand(who, seen, 'GET', `/files/${G.po}`, undefined, 404)
      expect(file.error.message, key).toBe(WORDS.fileNotFound)
    }
    expect((await asBrand(A.viewer, seen, 'GET', `/portal/sales-orders/${SO2()}/price-check`, undefined, 403)).error.message).toBe(WORDS.portalNoPrices)
    // The Designer fills drafts but never types Your price (the grain filter: 403 even for one line).
    const draft = await asBrand(A.designer, seen, 'GET', G.draftUrl)
    expect(JSON.stringify(draft)).not.toMatch(/"(brandUnitPrice|unitPriceShown|draftValueAmount)":/)
    await asBrand(A.designer, seen, 'PUT', `${G.draftUrl}/custom-lines/${G.draftCustomLine}`, { version: draft.request.version, brandUnitPrice: '90' }, 403)
  })

  it('M12 M-CP-3: the office Factory designer sees no price anywhere — the order, the list, the price check, the priced files, the draft', async () => {
    const designer = P.designer
    expect((await ok(designer, 'GET', '/auth/office/me')).permissions).toEqual(expect.arrayContaining(['orders.view', 'files.read', 'threads.read']))
    expect(await noPriceIn(designer, `/sales/orders/${SO2()}`)).not.toBeNull()
    expect(await noPriceIn(designer, `/sales/orders?partyId=${P1()}&limit=200`)).not.toBeNull()
    await heldForPrices(designer, 'GET', `/sales/orders/${SO2()}/price-check`)
    for (const fileId of [G.po, G.confirmation]) expect((await as(designer, 'GET', `/files/${fileId}`)).status).toBe(404)
    await noPriceIn(designer, `/sales/order-requests/${G.draft.id}`)
    // Its own thread reads: the Owner's note shows the priced PO locked, never named.
    const thread = await as(designer, 'GET', `/threads/SalesOrder/${SO2()}`)
    expect(thread.status).toBe(200)
    expect(JSON.stringify(thread.body)).not.toContain(MONEY.alphaPo)
  })

  it('M13 only the Owner gives a price role: the Administrator is refused Finance and "Accountant (prices)" (assign and invite), Finance is refused the guest accountant’s "Give access"; nothing is written', async () => {
    const target = await addUser(w.h, w.tenant, { email: 'mw.price.target@golden.example.com' })
    for (const roleId of [G.financeRoleId, G.accountantRoleId]) {
      await stepped(w, P.admin)
      const refused = await as(P.admin, 'POST', `/auth/users/${target.id}/roles`, { roleId, allCompanies: true })
      expect(refused.status, JSON.stringify(refused.body)).toBe(403)
      expect(refused.body.error.issues).toEqual([{ path: 'roleId/onlyOwnerGivesPrices', message: WORDS.onlyOwner }])
      await stepped(w, P.admin)
      const invited = await as(P.admin, 'POST', '/auth/invitations', { email: `mw.invite.${roleId.slice(-12)}@golden.example.com`, displayName: 'Made-up invite', roles: [{ roleId, allCompanies: true }] })
      expect(invited.status, JSON.stringify(invited.body)).toBe(403)
      expect(pathsOf(invited.body)).toEqual(['roles/0/roleId/onlyOwnerGivesPrices'])
    }
    expect(((await ok(P.owner, 'GET', `/auth/users/${target.id}/roles`)).assignments as Json[]).length).toBe(0)
    expect((await admin<{ n: number }>(w, `SELECT count(*)::int AS n FROM "User" WHERE email LIKE 'mw.invite.%'`))[0]!.n).toBe(0)
    // A role without prices is given as before (the Administrator); the Owner gives the price role.
    await stepped(w, P.admin)
    expect((await as(P.admin, 'POST', `/auth/users/${target.id}/roles`, { roleId: G.salesRoleId, allCompanies: true })).status).toBe(200)
    await stepped(w, P.owner)
    expect((await as(P.owner, 'POST', `/auth/users/${target.id}/roles`, { roleId: G.accountantRoleId, allCompanies: true })).status).toBe(200)
    // Finance (a price role itself) does not give the guest accountant access: the Owner's only (Owner O3).
    const consultant = id('party:CONSULTANT')
    const email = 'mw.guest.accountant@golden.example.com'
    await stepped(w, P.finance)
    const guest = await as(P.finance, 'POST', '/accounting/accountants', { companyId: companyA(), partyId: consultant, email, displayName: 'Made-up Accountant', locale: 'it', accessUntil: new Date(Date.now() + 200 * 86_400_000).toISOString() })
    expect(guest.status, JSON.stringify(guest.body)).toBe(403)
    expect(guest.body.error.issues).toEqual([{ path: 'roleKey/onlyOwnerGivesPrices', message: WORDS.onlyOwner }])
    expect((await admin<{ n: number }>(w, 'SELECT count(*)::int AS n FROM "User" WHERE email = $1', [email]))[0]!.n).toBe(0)
  })

  it('M14 B-CP-026: the four blind Sales price acts are 403 in words — a priced template’s lines, options that move a price, accepting a priced counter-offer, deciding a return’s credit', async () => {
    // 1. A quote template whose line holds a typed price: the Owner makes it; the Sales worker's replace would wipe the price.
    const plainLine = { seq: 10, section: 'Jackets', styleId: JKT01(), colourwayId: JKT01_BLK(), sizes: { '50': 2, '52': 1 } }
    const template = (await ok(P.owner, 'POST', '/sales/quote-templates', { companyId: companyA(), name: 'Made-up priced kit MW', lines: [{ ...plainLine, unitPrice: '399' }] }, 201)).template
    await blindHeld(P.sales, 'PUT', `/sales/quote-templates/${template.id}/lines`, { version: template.version, lines: [plainLine] }, 'body/lines')
    expect((await admin<{ unitPrice: string }>(w, 'SELECT "unitPrice"::text AS "unitPrice" FROM "QuoteTemplateLine" WHERE "templateId" = $1', [template.id])).map((row) => row.unitPrice)).toEqual(['399.000000'])
    // 2. An accepted order line's options (SEED-SO-0004): what the options add moves — held with or without keepPrice.
    const value = async (group: string, code: string) => (await admin<{ id: string }>(w, `SELECT v.id::text AS id FROM "OptionValue" v JOIN "OptionGroup" g ON g.id = v."groupId" WHERE g."tenantId" = $1 AND g.code = $2 AND v.code = $3`, [w.tenant.id, group, code]))[0]!.id
    const [liner, armour, name] = [await value('SEED-OG-LINER', 'YES'), await value('SEED-OG-ARMOUR', 'STD'), await value('SEED-OG-NAME', 'NAME')]
    const so4 = (await admin<{ orderId: string; lineId: string }>(w, `SELECT o.id::text AS "orderId", l.id::text AS "lineId" FROM "SalesOrder" o JOIN "SalesOrderLine" l ON l."orderId" = o.id WHERE o."tenantId" = $1 AND o.number = 'SEED-SO-0004' ORDER BY l.seq LIMIT 1`, [w.tenant.id]))[0]!
    const optionsUrl = `/sales/orders/${so4.orderId}/lines/${so4.lineId}`
    const view = await ok(P.sales, 'GET', `${optionsUrl}/configurator`)
    const more = [{ valueId: liner }, { valueId: armour }, { valueId: name, text: 'VERDI' }]
    await blindHeld(P.sales, 'PUT', `${optionsUrl}/options`, { version: view.document.version, picks: more, keepPrice: true }, 'body/keepPrice')
    // 3. A priced counter-offer: Brand Alpha asks a design change of its own-label jacket; the Owner counters with a fee; the Sales
    // worker's accept would agree a price it cannot see.
    // B-CP-026 (fix wave cp-fx8): a customer's design ask is off until its production card opens it (B-SA-005b; the sales-page flow's
    // S0): the Owner opens it for Brand Alpha first — else Alpha's ask is refused NOT_OPEN before any price is in play.
    await stepped(w, P.owner)
    const card = await ok(P.owner, 'GET', `/partners/${P1()}/production`)
    expect((await ok(P.owner, 'PUT', `/partners/${P1()}/production`, { productionAskKinds: ['DESIGN'], version: card.production.version })).production.askKinds).toEqual(['DESIGN'])
    const asked = (await asBrand(A.buyer, seen, 'POST', `/portal/sales-orders/${SO2()}/change-requests`, { kind: 'DESIGN', note: 'Made-up: a darker yellow piping on the collar.', lineIds: [LINE10()] }, 201)).request
    await stepped(w, P.owner)
    const countered = (await ok(P.owner, 'POST', `/production/brand-requests/${asked.id}/counter`, { version: asked.version, fee: 15_000, note: 'Made-up: possible with a fee for the new piping.' })).request
    expect(countered).toMatchObject({ status: 'COUNTERED' })
    await blindHeld(P.sales, 'POST', `/sales/change-requests/${asked.id}/accept`, { version: countered.version, answer: 'Made-up: agreed.' }, 'request/counterFee')
    expect((await admin<{ status: string }>(w, 'SELECT status::text AS status FROM "OrderChangeRequest" WHERE id = $1', [asked.id]))[0]!.status).toBe('COUNTERED')
    // 4. A return's credit (SEED-RMA-0001): received and graded by the Owner; the Sales worker's credit decision is held.
    const rma = (await admin<{ id: string }>(w, `SELECT id::text AS id FROM "ReturnAuthorisation" WHERE "tenantId" = $1 AND number = 'SEED-RMA-0001'`, [w.tenant.id]))[0]!.id
    let record = (await ok(P.sales, 'GET', `/sales/returns/${rma}`)).return
    const lineId = record.lines[0].id as string
    record = (await ok(P.owner, 'POST', `/sales/returns/${rma}/receipts`, { version: record.version, parcels: 1, parcelCondition: 'INTACT', lines: [{ lineId, quantity: 1 }] }, 201)).return
    record = (await ok(P.owner, 'POST', `/sales/returns/${rma}/grades`, { version: record.version, lines: [{ lineId, grade: 'NEW', cause: 'NO_FAULT' }] })).return
    await blindHeld(P.sales, 'POST', `/sales/returns/${rma}/decisions`, { version: record.version, lines: [{ lineId, disposition: 'CREDIT_ONLY', goodsOutcome: 'SCRAP' }] }, 'body/lines/0/disposition')
    expect((await admin<{ disposition: string | null }>(w, 'SELECT disposition::text AS disposition FROM "ReturnLine" WHERE id = $1', [lineId]))[0]!.disposition).toBeNull()
  })

  it('M15 a priced file never reaches a floor: an upload ticked "shows prices" for a floor and a floor share of the priced PO are refused in words', async () => {
    const floorUpload = await as(P.owner, 'POST', '/files', { companyId: companyA(), kind: 'DOCUMENT', recordType: 'SalesOrder', recordId: SO2(), visibility: ['FLOOR'], floorSiteId: id('site:A1'), priced: true, originalName: 'MW priced for the floor.pdf', contentType: 'application/pdf', sizeBytes: 64, sha256: 'a'.repeat(64) })
    expect(floorUpload.status, JSON.stringify(floorUpload.body)).toBe(400)
    expect(floorUpload.body.error.issues).toContainEqual({ path: 'body/priced', message: PRICED_WORDS.floor.en })
    const current = (await admin<{ version: number }>(w, 'SELECT version FROM "StoredFile" WHERE id = $1', [G.po]))[0]!.version
    const share = await as(P.owner, 'PUT', `/files/${G.po}/visibility`, { visibility: ['FLOOR', 'PARTNER'], floorSiteId: id('site:A1'), partyId: P1(), version: current })
    expect(share.status, JSON.stringify(share.body)).toBe(400)
    expect(share.body.error.issues).toContainEqual({ path: 'body/visibility', message: PRICED_WORDS.floor.en })
    expect((await admin<{ visibility: string[] }>(w, 'SELECT visibility::text[] AS visibility FROM "StoredFile" WHERE id = $1', [G.po]))[0]!.visibility).not.toContain('FLOOR')
  })

  it('B01 the brand wall inside the sweep: Brand Beta gets Alpha’s price check as an unknown order, its summary never counts Alpha, a Beta PO never prices an Alpha order, Beta opens none of Alpha’s priced files', async () => {
    const unknown = '0190f0e2-7a7a-7000-8000-00000000abcd'
    // The portal: Beta's Buyer on Alpha's order = an unknown order (the same words), nothing written.
    for (const orderId of [SO2(), unknown]) {
      expect((await asBrand(beta, seen, 'GET', `/portal/sales-orders/${orderId}/price-check`, undefined, 404)).error.message).toBe(WORDS.orderNotFound)
      expect((await asBrand(beta, seen, 'PUT', `/portal/sales-orders/${orderId}/brand-prices`, { rows: [{ lineId: LINE10(), unitPrice: '1' }] }, 404)).error.message).toBe(WORDS.orderNotFound)
    }
    expect((await asBrand(beta, seen, 'GET', `/files/${G.po}`, undefined, 404)).error.message).toBe(WORDS.fileNotFound)
    await asBrand(beta, seen, 'GET', G.draftUrl, undefined, 404)
    // The office: a price holder limited to Brand Beta (Finance) — Alpha's summary and price check as unknown ones; its own summary
    // counts Beta's orders only.
    const theirs = await as(P.betaFinance, 'GET', `/sales/brand-prices/summary?partyId=${P1()}`)
    const none = await as(P.betaFinance, 'GET', `/sales/brand-prices/summary?partyId=${unknown}`)
    expect([theirs.status, theirs.body.error?.message]).toEqual([404, WORDS.customerNotFound])
    expect({ code: theirs.body.error.code, message: theirs.body.error.message }).toEqual({ code: none.body.error.code, message: none.body.error.message })
    expect((await as(P.betaFinance, 'GET', `/sales/orders/${SO2()}/price-check`)).status).toBe(404)
    const betaOrders = (await admin<{ n: number }>(w, 'SELECT count(*)::int AS n FROM "SalesOrder" WHERE "tenantId" = $1 AND "partyId" = $2', [w.tenant.id, P3()]))[0]!.n
    expect(await ok(P.betaFinance, 'GET', `/sales/brand-prices/summary?partyId=${P3()}`)).toEqual({ partyId: P3(), priceNotEqualCount: 0, priceMissingCount: betaOrders })
    expect(((await ok(P.betaFinance, 'GET', '/sales/orders?priceMatch=NO_BRAND_PRICE&limit=200')).orders as Json[]).map((row) => row.id)).not.toContain(SO2())
    // A Beta PO never prices an Alpha order (400 at the field, its name unsaid); the Beta file stays unpriced.
    const current = await ok(P.owner, 'GET', `/sales/orders/${SO2()}/price-check`)
    const row10 = (current.lines as Json[]).find((entry) => entry.lineId === LINE10())!.row
    const refused = await as(P.owner, 'PUT', `/sales/orders/${SO2()}/brand-prices`, { rows: [{ lineId: LINE10(), netAmount: row10.netAmount, source: 'CUSTOMER_PO', sourceFileId: G.betaPo, version: row10.version }] })
    expect(refused.status, JSON.stringify(refused.body)).toBe(400)
    expect(refused.body.error.issues).toEqual([{ path: 'body/rows/0/sourceFileId', message: WORDS.notAFileOfThisOrder }])
    expect(JSON.stringify(refused.body)).not.toContain(MONEY.betaPo)
    expect((await admin<{ priced: boolean }>(w, 'SELECT priced FROM "StoredFile" WHERE id = $1', [G.betaPo]))[0]!.priced).toBe(false)
    // The factory sees both (the control): the Owner reads Beta's order beside Alpha's.
    expect(((await ok(P.owner, 'GET', `/sales/orders?partyId=${P1()}&limit=200`)).orders as Json[]).map((row) => row.id)).toContain(SO2())
    expect(((await ok(P.owner, 'GET', `/sales/orders?partyId=${P3()}&limit=200`)).orders as Json[]).map((row) => row.id)).toContain(G.betaOrder)
  })

  it('F02 follow-up 2 (Owner decides): a Sales worker with a price role limited to Brand Alpha — what the code does today on Brand Beta’s rows', async () => {
    const who = P.alphaPriced
    // Its own customer's money: the check of Alpha's order opens (the price role reaches Alpha).
    expect((await ok(who, 'GET', `/sales/orders/${SO2()}/price-check`)).total).toMatchObject({ priceMatch: 'NOT_EQUAL' })
    // Brand Beta's order by its own door: the price check is refused (the price grain is not held over Beta).
    const beta = await as(who, 'GET', `/sales/orders/${G.betaOrder}/price-check`)
    expect([beta.status, beta.body.error?.message]).toEqual([403, WORDS.notAPriceHolder])
    // follow-up 2: Owner decides — the list's price columns read the SESSION's grain (heldGrains, like paid / balance): today a
    // price role limited to Brand Alpha also sees our price and the check on Brand Beta's rows it reaches through Sales. Written as
    // the code does it now; if the Owner picks "per customer", these two lines flip to `not.toHaveProperty`.
    const row = ((await ok(who, 'GET', `/sales/orders?partyId=${P3()}&limit=200`)).orders as Json[]).find((entry) => entry.id === G.betaOrder)!
    expect(row).toBeDefined()
    expect(row).toHaveProperty('netAmount') // follow-up 2: Owner decides
    expect(row).toHaveProperty('priceMatch') // follow-up 2: Owner decides
  })

  it('T00 the name scan: nothing Brand Beta’s people got names Brand Alpha (its names, codes, numbers, files, people, the draft’s words, record ids)', async () => {
    const markers = [...(await markersOf(w, BRAND_ALPHA, P1())), ...alphaPeopleMarkers()]
    const betaSaw = seen.filter((entry) => entry.who.startsWith('beta'))
    expect(betaSaw.length).toBeGreaterThan(5)
    const found = betaSaw.flatMap((entry) => findMarkers(entry.body, markers).map((marker) => `${entry.method} ${entry.url} → ${marker}`))
    expect(found).toEqual([])
    // The other way: nothing Brand Alpha's people got names Brand Beta.
    const betaMarkers = await markersOf(w, BRAND_BETA, P3())
    const alphaSaw = seen.filter((entry) => entry.who.startsWith('alpha'))
    expect(alphaSaw.flatMap((entry) => findMarkers(entry.body, betaMarkers).map((marker) => `${entry.method} ${entry.url} → ${marker}`))).toEqual([])
  })

  it('Z no route answered 500 during the sweep', () => {
    expect(unexpected.map((report) => `${report.context.method} ${report.context.route}: ${report.name}: ${report.message} ${report.stack.slice(0, 3).join(' | ')}`)).toEqual([])
  })
})
