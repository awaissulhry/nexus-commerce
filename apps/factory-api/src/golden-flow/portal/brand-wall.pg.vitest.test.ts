import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { ErrorReport } from '@nexus/factory-domain/observability/report'
import { addDays } from '@nexus/factory-domain/planning/buy'
import { FakePaymentProvider } from '../../adapters/payment-fake/fake'
import { textOf } from '../../adapters/ses/fake'
import { createPaymentsRuntime, usePayments } from '../../modules/payments/online/runtime'
import { portalSendContract } from '../../modules/sales/safety-reports/contract'
import { createErrorTracker, useErrorTracker } from '../../observability/tracker'
import { useAbuseGuard } from '../../platform/abuse/guard'
import { useInbound } from '../../platform/inbound/providers'
import { usePortalOptions } from '../../platform/auth/portal/service'
import { freshGuard } from '../../platform/auth/portal/testing/portal'
import { addUser, Browser, enrolTotp, stepUp } from '../../platform/auth/sessions/testing/harness'
import { fakeScanner } from '../../platform/files/scan/fake'
import { useScanner } from '../../platform/files/scan/service'
import type { EventHandler } from '../../platform/outbox/dispatch'
import { standardReasonsForNewTenants } from '../../platform/reasons/standard'
import type { SearchIndexer } from '../../platform/search/indexer'
import { indexNewTenants } from '../../platform/search/indexing'
import { admin, announce, ok, pdf, person, putBytes, QUIET, startWorld, stepped, type Person, type World } from '../testing/world'
import { everyHandler, searchIndexers, settler } from '../daily/testing/day'
import { addressesOf, asBrand, BRAND_ALPHA, BRAND_BETA, findMarkers, mailText, markersOf, setUpBrand, viaBrandLink, type BrandInWorld, type Marker, type Seen } from './testing/two-brands'

/**
 * B-TH-002 — THE BRAND-WALL HARNESS (threads plan TH-0, §0; Owner rule 2026-11-16: "One brand must not be able to see anything
 * related to any other brand. But we, as the production unit, should be able to see it all. And manage it all as well."): two
 * brands in ONE factory, through the HTTP routes, on the W1 golden world (../testing/world.ts: every base seed, the real app and
 * sign-in, every outside provider FAKE) with the worker's handlers run in-process.
 *
 *   B   the sales office makes seeded customer P1 into Brand Alpha (brand A) and P3 into Brand Beta (brand B): names, contact,
 *       address, portal opened, each brand's admin signed in (./testing/two-brands.ts). Brand Alpha writes in its order's thread,
 *       gets its tech pack on the portal and by mail, sends a reorder request; Brand Beta gets a quote, accepts it by link into
 *       an order, writes in its thread, and the office shares its order with Beta's contact by link (brand B's link session).
 *   T02 every GET route whose manifest audiences include `partner` or `link` — found BY AUDIENCE in the app's route registry,
 *       never by path prefix, so every later route is in the sweep by itself — called as Brand Beta with Brand Alpha's ids
 *       (partner routes with Beta's portal session, link routes with Beta's link session): each answers "not found" (or another
 *       refusal) or holds nothing of Brand Alpha. A route with a path parameter the sweep has no ids for fails the step: name its
 *       ids below.
 *   T03 an office person limited to Brand Beta cannot open Brand Alpha's portal preview.
 *   T05 Brand Beta's orders, messages and notices never move Brand Alpha's Home numbers.
 *   T31 Brand Beta never receives a document of Brand Alpha by mail, portal or link.
 *   T33 a safety report's answer holds its number and words only.
 *   T00 the name scan: every answer, mail and link page Brand Beta got (and every one Brand Alpha got, the other way) holds none
 *       of the other brand's names, codes, numbers, file names, addresses or record ids.
 *   Z   no route answered 500 during the flow.
 *
 * The factory itself sees both (the office reads both brands' orders: the control). SQL only reads ids and asserts: no step is
 * made by SQL. Every name, address and figure is made up. Run with `node scripts/factory/golden-flow.mjs portal`.
 */

let w: World
let handlers: readonly EventHandler[]
let indexers: readonly SearchIndexer[]
let settle: () => Promise<string[]>
type Json = Record<string, any>
const P = {} as Record<'owner' | 'admin' | 'sales' | 'manager' | 'inspector', Person>
let alpha: BrandInWorld
let beta: BrandInWorld
/** Every answer a brand's portal person or link got: what the scan reads. */
const seen: Seen[] = []
/** What the API reported as unexpected (a 500) during the flow: none at the end. */
const unexpected: ErrorReport[] = []
const G = {} as Record<string, any>
const id = (key: string) => w.id(key)
const companyA = () => id('company:A')
const today = () => businessDate(new Date())
const P1 = () => id('party:P1')
const P3 = () => id('party:P3')

/** A file of a record through the real routes: announced (shared as asked), its bytes sent, completed. */
async function upload(who: Person, owner: Json, name: string): Promise<string> {
  const body = pdf(name)
  const announced = await ok(who, 'POST', '/files', { companyId: companyA(), kind: 'DOCUMENT', ...owner, ...announce(name, body) }, 201)
  await putBytes(w, announced, body)
  expect((await ok(who, 'POST', `/files/${announced.file.id}/complete`)).file.status).toBe('AVAILABLE')
  return announced.file.id as string
}

/** The token of the newest mail of a template to an address. */
function tokenOf(template: string, to: string): string {
  const mail = w.h.ses.mails.filter((entry) => entry.templateKey === template && entry.to.includes(to)).at(-1)
  if (!mail) throw new Error(`no ${template} mail to ${to} (mails: ${w.h.ses.mails.map((entry) => `${entry.templateKey} to ${entry.to.join(',')}`).join('; ')})`)
  const token = /#token=(\S+)/.exec(textOf(mail.raw))?.[1]
  if (!token) throw new Error(`the ${template} mail to ${to} holds no token`)
  return decodeURIComponent(token)
}

/** Brand Alpha's Home as its admin reads it: the counts by key, the waiting items and the badges. */
async function alphaHome(): Promise<Json> {
  const home = await asBrand(alpha, seen, 'GET', '/portal/home')
  return { counts: Object.fromEntries((home.counts as Json[]).map((count) => [count.key, count.value])), waiting: (home.waiting as Json[]).map((item) => item.id ?? item.key ?? JSON.stringify(item)), badges: home.badges }
}

// ---- T02: the sweep by audience ------------------------------------------------------------------------------------------------

/** A GET of the partner or link audience the sweep does not call, and why (each proven elsewhere). */
const NOT_SWEPT: Readonly<Record<string, string>> = {
  'GET /portal/live': 'a live stream (SSE) that never ends; another party’s live message is dropped: factory-domain portal/notifications/notifications.vitest.test.ts',
}

/** Brand Alpha's ids for every path parameter of the partner and link GETs (SQL reads only). */
async function alphaIds(): Promise<Record<string, string[]>> {
  const ids = async (sql: string, values: unknown[] = [P1()]) => (await admin<{ id: string }>(w, sql, values)).map((row) => row.id)
  const orders = await ids(`SELECT id::text AS id FROM "SalesOrder" WHERE "partyId" = $1 ORDER BY number`)
  return {
    orderId: orders,
    requestId: [
      ...(await ids(`SELECT id::text AS id FROM "ApprovalRequest" WHERE "partyId" = $1 ORDER BY id LIMIT 4`)),
      ...(await ids(`SELECT id::text AS id FROM "PortalOrderRequest" WHERE "partyId" = $1 ORDER BY id LIMIT 4`)),
    ],
    fileId: await ids(
      `SELECT id::text AS id FROM "StoredFile" WHERE "partyId" = $1 OR ("recordType" = 'SalesOrder' AND "recordId" = ANY($2::uuid[])) ORDER BY "partyId" NULLS LAST, id LIMIT 10`,
      [P1(), orders],
    ),
    userId: await ids(`SELECT id::text AS id FROM "User" WHERE "partyId" = $1 ORDER BY id LIMIT 3`),
    styleId: await ids(`SELECT id::text AS id FROM "Style" WHERE "brandPartyId" = $1 ORDER BY id LIMIT 3`),
    intentId: await ids(`SELECT id::text AS id FROM "PaymentIntent" WHERE "partyId" = $1 ORDER BY id LIMIT 3`),
    returnId: await ids(`SELECT id::text AS id FROM "ReturnAuthorisation" WHERE "partyId" = $1 ORDER BY id LIMIT 3`),
    complaintId: await ids(`SELECT id::text AS id FROM "Complaint" WHERE "partyId" = $1 ORDER BY id LIMIT 3`),
    repairId: await ids(`SELECT id::text AS id FROM "RepairOrder" WHERE "partyId" = $1 ORDER BY id LIMIT 3`),
    caseId: [
      ...(await ids(`SELECT id::text AS id FROM "ReturnAuthorisation" WHERE "partyId" = $1 ORDER BY id LIMIT 2`)),
      ...(await ids(`SELECT id::text AS id FROM "Complaint" WHERE "partyId" = $1 ORDER BY id LIMIT 2`)),
    ],
    caseType: ['RETURN', 'COMPLAINT'],
    // Supplier-side records (another party, not a brand): a customer's session is refused them as a kind, with any id.
    purchaseOrderId: await ids(`SELECT id::text AS id FROM "PurchaseOrder" WHERE "partyId" <> $1 ORDER BY id LIMIT 2`, [P3()]),
    shipNoticeId: await ids(`SELECT id::text AS id FROM "ShipNotice" WHERE "partyId" <> $1 ORDER BY id LIMIT 2`, [P3()]),
    subcontractOrderId: await ids(`SELECT id::text AS id FROM "SubcontractOrder" WHERE "partyId" <> $1 ORDER BY id LIMIT 2`, [P3()]),
    period: [today().slice(0, 7), today().slice(0, 4)],
  }
}

/** Brand Alpha's records for `:recordType/:recordId` (each record its thread names, its orders, the party itself). */
async function alphaRecords(orders: readonly string[]): Promise<[string, string][]> {
  const threads = await admin<{ type: string; id: string }>(w, `SELECT "recordType" AS type, "recordId"::text AS id FROM "Thread" WHERE "partyId" = $1 ORDER BY id`, [P1()])
  const pairs: [string, string][] = [...threads.map((row): [string, string] => [row.type, row.id]), ...orders.map((order): [string, string] => ['SalesOrder', order]), ['Party', P1()]]
  return [...new Map(pairs.map((pair) => [pair.join('/'), pair])).values()]
}

/**
 * Every URL the sweep calls for one route: each path parameter filled with Brand Alpha's ids (`:recordType/:recordId` as
 * pairs, `:caseType/:caseId` each type with each id), lists that read a record or a word by query given Brand Alpha's.
 */
function urlsFor(path: string, ids: Record<string, string[]>, records: readonly [string, string][], words: readonly string[]): string[] {
  const names = [...path.matchAll(/:(\w+)/g)].map((match) => match[1]!)
  let urls: string[] = [path]
  if (names.includes('recordType')) {
    urls = records.map(([type, recordId]) => path.replace(':recordType', type).replace(':recordId', recordId))
  }
  for (const name of names.filter((entry) => entry !== 'recordType' && entry !== 'recordId')) {
    const values = ids[name]
    if (!values) throw new Error(`the brand-wall sweep has no ids for :${name} (${path}): name Brand Alpha's ids for it in alphaIds()`)
    if (values.length === 0) throw new Error(`Brand Alpha has no record for :${name} (${path}): the sweep would prove nothing`)
    urls = urls.flatMap((url) => values.map((value) => url.replace(`:${name}`, value)))
  }
  // Lists that take the record or the words by query.
  if (path === '/files') return records.map(([type, recordId]) => `/files?recordType=${type}&recordId=${recordId}`)
  if (path === '/portal/search') return words.map((word) => `/portal/search?q=${encodeURIComponent(word)}`)
  return urls
}

/**
 * A search answer says back what was asked (`query`, folded, and its `words`): that echo is the reader's own typing, not another
 * brand's data, so the scan reads the answer without it (its groups, results and counts stay).
 */
function withoutEcho(url: string, body: unknown): unknown {
  if (!new URL(url, 'http://wall.example').searchParams.has('q') || !body || typeof body !== 'object' || Array.isArray(body)) return body
  return Object.fromEntries(Object.entries(body as Json).filter(([name]) => !['q', 'query', 'words'].includes(name)))
}

beforeAll(async () => {
  useErrorTracker(createErrorTracker({ sink: { kind: 'fake', send: (report) => void unexpected.push(report) }, source: 'api' }))
  w = await startWorld()
  // The portal's codes are refused by the database once past their end in REAL time: the harness clock starts at now.
  w.h.clock.set(new Date())
  freshGuard(w.h)
  usePortalOptions({ answerFloorMs: 0 })
  useScanner(fakeScanner())
  // The FAKE card provider and the inbound ledger on the harness clock (the portal's payment pages read them).
  useInbound({ environment: 'test', secrets: w.h.secrets, clock: w.h.clock })
  usePayments(createPaymentsRuntime({ gateway: w.gateway, environment: 'test', fake: new FakePaymentProvider(w.h.clock) }))
  indexers = await searchIndexers()
  handlers = everyHandler(indexers)
  settle = settler(w, handlers)
  for (const [key, role] of [
    ['owner', 'owner'],
    ['admin', 'admin'],
    ['sales', 'sales'],
    ['manager', 'production_manager'],
    ['inspector', 'quality_inspector'],
  ] as const) {
    P[key] = await person(w, key, role)
  }
}, 1_200_000)

afterAll(async () => {
  usePayments(undefined)
  useInbound(undefined)
  useScanner(undefined)
  useAbuseGuard(undefined)
  usePortalOptions({})
  useErrorTracker(undefined)
  await w?.close()
}, 60_000)

describe('B-TH-002 the brand wall: two brands in one factory, every partner and link GET by audience, the name scan', { timeout: 300_000 }, () => {
  it('B00 the world: the seeds drain; the search index is built', async () => {
    await standardReasonsForNewTenants({ database: w.h.database, log: QUIET })
    await indexNewTenants({ database: w.h.database, indexers, log: QUIET })
    await settle()
  })

  it('B01 the sales office makes P1 into Brand Alpha and P3 into Brand Beta (names, contact, address), opens both portals; each brand’s admin signs in by code', async () => {
    alpha = await setUpBrand(w, P.sales, BRAND_ALPHA, P1(), companyA())
    beta = await setUpBrand(w, P.sales, BRAND_BETA, P3(), companyA())
    expect(await asBrand(alpha, seen, 'GET', '/portal/me')).toMatchObject({ party: { id: P1() } })
    expect(await asBrand(beta, seen, 'GET', '/portal/me')).toMatchObject({ party: { id: P3() } })
    await settle()
  })

  it('B02 Brand Alpha’s day: it writes in SEED-SO-0001’s thread; the office puts its tech pack on the order, shared with Alpha’s portal, and mails it to Alpha’s contact; Alpha sends a reorder request with its own reference', async () => {
    const so1 = id('sales:SO1')
    const so2 = id('production:sales-order:SO-0002')
    await asBrand(alpha, seen, 'POST', `/portal/threads/SalesOrder/${so1}/messages`, { body: BRAND_ALPHA.message }, 201)
    G.alphaFile = await upload(P.owner, { recordType: 'SalesOrder', recordId: so1, visibility: ['OFFICE', 'PARTNER'], partyId: P1() }, BRAND_ALPHA.fileName)
    await ok(P.sales, 'POST', `/threads/SalesOrder/${so1}/emails`, { to: [BRAND_ALPHA.contact.email], subject: 'Your tech pack', body: 'Here is the tech pack of AX-100.', attachments: [G.alphaFile] }, 201)
    let request = (await asBrand(alpha, seen, 'POST', '/portal/order-requests', { source: 'REORDER', customerRef: BRAND_ALPHA.customerRef }, 201)).request
    request = (await asBrand(alpha, seen, 'POST', `/portal/order-requests/${request.id}/reorder`, { version: request.version, orderId: so2 })).request
    G.alphaRequest = (await asBrand(alpha, seen, 'POST', `/portal/order-requests/${request.id}/send`, { version: request.version })).request
    await settle()
    // Brand Alpha's Home after its own day: what brand B's day must not move (T05).
    G.alphaHome = await alphaHome()
  })

  it('B03 Brand Beta’s day: the production manager makes its own private-label jacket; the office drafts it a quote, shares the quote with Beta’s contact by link (brand B’s link session) and asks Beta to approve the artwork; Beta writes on the shared quote', async () => {
    // Brand Beta's own private-label jacket (not a protective garment), its sizes as SKUs, its first revision.
    const { style } = await ok(
      P.manager,
      'POST',
      '/product/styles',
      {
        code: 'BX-200',
        name: 'Brand Beta city jacket (made up)',
        productType: 'JACKET',
        season: 'FW27',
        brandPartyId: P3(),
        sizeScaleId: id('product:size-scale:EU-JKT'),
        sizes: ['50', '52'],
        baseSize: '52',
        ppeCategory: 'NOT_PPE',
        colourways: [{ code: 'BLU', name: 'Blu', colourId: id('product:colour:RED') }],
        generateSkus: true,
      },
      201,
    )
    G.betaStyle = style
    await ok(P.manager, 'POST', `/product/styles/${style.id}/revisions`, { changeNote: 'First revision of the Brand Beta city jacket' }, 201)
    // A draft quote of Beta's (its own reference); the office keeps it to cost.
    let { quote } = await ok(P.sales, 'POST', '/sales/quotes', { companyId: companyA(), partyId: P3(), customerRef: BRAND_BETA.customerRef, promiseDate: addDays(today(), 60) }, 201)
    ;({ quote } = await ok(P.sales, 'POST', `/sales/quotes/${quote.id}/lines`, { version: quote.version, styleId: style.id, colourwayId: style.colourways[0].id, sizes: [{ size: '52', quantity: 4 }], unitPrice: '80' }, 201))
    G.betaQuote = quote
    // Beta's size chart on its quote, shared with Beta's portal and links; the quote shared with Beta's contact by link (a
    // tenant-wide style is shared on its quote or order).
    G.betaFile = await upload(P.owner, { recordType: 'Quote', recordId: quote.id, visibility: ['OFFICE', 'PARTNER', 'LINK'], partyId: P3() }, BRAND_BETA.fileName)
    const shared = await ok(P.owner, 'POST', '/shares', { recordType: 'Quote', recordId: quote.id, email: BRAND_BETA.contact.email, permissions: ['COMMENT'], expiresAt: new Date(Date.now() + 20 * 86_400_000).toISOString(), send: true, language: 'en' }, 201)
    expect(shared.share).toMatchObject({ state: 'LIVE' })
    await settle()
    G.betaLink = tokenOf('shares.invite', BRAND_BETA.contact.email)
    expect(await viaBrandLink(w, beta, G.betaLink, seen, 'GET', '/link/share?language=en')).toMatchObject({ record: { type: 'Quote' } })
    await viaBrandLink(w, beta, G.betaLink, seen, 'POST', '/link/share/messages', { body: BRAND_BETA.message }, 201)
    // B-TH-004 (T24): an invite or a request on Beta's quote to Alpha's contact is refused in words without "Send outside this
    // customer" (the office reads whose the address is); nothing is made, nothing mailed.
    const mailsBefore = w.h.ses.mails.length
    const wrongShare = await ok(P.owner, 'POST', '/shares', { recordType: 'Quote', recordId: quote.id, email: BRAND_ALPHA.contact.email, permissions: ['VIEW'], send: true, language: 'en' }, 409)
    expect(wrongShare.error.issues).toEqual([expect.objectContaining({ path: 'refusal/OTHER_PARTY' }), { path: 'body/email', message: `${BRAND_ALPHA.contact.email} belongs to ${BRAND_ALPHA.tradeName}.` }])
    const wrongAsk = await ok(P.owner, 'POST', '/approvals-out', { kind: 'ARTWORK', recordType: 'Quote', recordId: quote.id, email: BRAND_ALPHA.contact.email, question: 'Please approve the artwork of BX-200.', fileIds: [G.betaFile], send: true, language: 'en' }, 409)
    expect(wrongAsk.error.issues[0]).toMatchObject({ path: 'refusal/OTHER_PARTY' })
    await settle()
    expect(w.h.ses.mails.slice(mailsBefore).filter((mail) => mail.to.includes(BRAND_ALPHA.contact.email))).toEqual([])
    // The office asks Beta to approve the jacket's artwork on its quote: a task and a notice for Beta's portal.
    await ok(P.owner, 'POST', '/approvals-out', { kind: 'ARTWORK', recordType: 'Quote', recordId: quote.id, email: BRAND_BETA.contact.email, question: 'Please approve the artwork of BX-200.', fileIds: [G.betaFile], send: true, language: 'en' }, 201)
    await settle()
    // The factory sees both brands (the control: the wall stands between brands, never in front of the office).
    expect(JSON.stringify(await ok(P.sales, 'GET', `/sales/quotes?partyId=${P3()}`))).toContain(BRAND_BETA.customerRef)
    expect(JSON.stringify(await ok(P.sales, 'GET', '/sales/orders'))).toContain('SEED-SO-0001')
  })

  it('T02 every GET of the partner or link audience, found by audience in the route registry, called as Brand Beta with Brand Alpha’s ids: refused or empty of Brand Alpha', async () => {
    const ids = await alphaIds()
    const records = await alphaRecords(ids.orderId!)
    const markers = await markersOf(w, BRAND_ALPHA, P1())
    const words = [BRAND_ALPHA.tradeName, BRAND_ALPHA.code, BRAND_ALPHA.customerRef, 'SEED-SO-0001', ...(G.alphaRequest?.number ? [G.alphaRequest.number] : [])]
    const routes = w.h.app.factoryRouteManifest
      .routes()
      .filter(([key, entry]) => key.startsWith('GET ') && entry.audiences !== 'public' && (entry.audiences.includes('partner') || entry.audiences.includes('link')))
    // Not vacuous: the registry holds the portal, link, file, thread and field routes the plan names.
    const keys = routes.map(([key]) => key)
    expect(keys).toEqual(expect.arrayContaining(['GET /portal/sales-orders/:orderId', 'GET /files/:fileId', 'GET /files/:fileId/download', 'GET /threads/:recordType/:recordId', 'GET /fields/portal/:recordType/:recordId', 'GET /link/share', 'GET /payments/link/pay']))
    const problems: string[] = []
    const called = new Set<string>()
    const statuses: Record<string, number> = {}
    const judge = (key: string, who: string, url: string, status: number, body: unknown) => {
      statuses[status] = (statuses[status] ?? 0) + 1
      if (status >= 500) problems.push(`${who} ${url}: ${status} ${JSON.stringify(body).slice(0, 300)}`)
      const found = findMarkers(withoutEcho(url, body), markers)
      if (found.length > 0) problems.push(`${who} ${url} (${status}) holds Brand Alpha’s ${found.join(', ')}`)
      called.add(key)
    }
    for (const [key, entry] of routes) {
      if (NOT_SWEPT[key]) continue
      const audiences = entry.audiences as readonly string[]
      for (const url of urlsFor(key.slice(4), ids, records, words)) {
        if (audiences.includes('partner')) {
          const body = await asBrand(beta, seen, 'GET', url, undefined, null)
          judge(key, 'beta portal', url, seen.at(-1)!.status, body)
        }
        if (audiences.includes('link')) {
          const body = await viaBrandLink(w, beta, G.betaLink, seen, 'GET', url, undefined, null)
          judge(key, 'beta link', url, seen.at(-1)!.status, body)
        }
      }
    }
    expect(problems).toEqual([])
    expect(keys.filter((key) => !called.has(key) && !NOT_SWEPT[key])).toEqual([])
    // Brand Alpha's own record answers its own portal (the control: the sweep's ids are real).
    expect(await asBrand(alpha, seen, 'GET', `/portal/sales-orders/${id('sales:SO1')}`)).toMatchObject({ order: { number: 'SEED-SO-0001' } })
    G.statuses = statuses
  })

  it('T03 an office person limited to Brand Beta cannot open Brand Alpha’s portal preview (not found); Brand Beta’s opens', async () => {
    const email = 'limited.beta@golden.example.com'
    const user = await addUser(w.h, w.tenant, { email })
    const roles = (await ok(P.admin, 'GET', '/auth/roles')).roles as Json[]
    const sales = roles.find((role) => role.key === 'sales')!
    await stepped(w, P.admin)
    await ok(P.admin, 'POST', `/auth/users/${user.id}/roles`, { roleId: sales.id, allCompanies: true, partyIds: [P3()] })
    const browser = new Browser(w.h.app)
    const signedIn = await browser.signIn(w.tenant.slug, user.email, user.password)
    expect(signedIn.body?.status, JSON.stringify(signedIn.body)).toBe('signed_in')
    const secret = await enrolTotp(w.h, browser)
    await stepUp(w.h, browser, secret)
    const refused = await browser.send('POST', `/partners/${P1()}/preview`, { companyId: companyA() }, { headers: { 'idempotency-key': `bw-preview-a-${Date.now()}` } })
    expect(refused.status, JSON.stringify(refused.body)).toBe(404)
    expect(findMarkers(refused.body, await markersOf(w, BRAND_ALPHA, P1()))).toEqual([])
    const own = await browser.send('POST', `/partners/${P3()}/preview`, { companyId: companyA() }, { headers: { 'idempotency-key': `bw-preview-b-${Date.now()}` } })
    expect(own.status, JSON.stringify(own.body)).toBe(200)
  })

  it('T05 Brand Beta’s jacket, quote, message, task and notices never moved Brand Alpha’s Home numbers', async () => {
    await settle()
    expect(await alphaHome()).toEqual(G.alphaHome)
    // Not vacuous: Brand Beta's own Home counts what waits for it (the artwork to approve).
    const home = await asBrand(beta, seen, 'GET', '/portal/home')
    expect((home.counts as Json[]).some((count) => typeof count.value === 'number' && count.value > 0)).toBe(true)
  })

  it('T31 Brand Beta never receives a document of Brand Alpha: not in its documents, not by mail, not by link; Alpha’s own reaches Alpha', async () => {
    const alphaMarkers = await markersOf(w, BRAND_ALPHA, P1())
    for (const url of ['/portal/customer-documents', '/portal/customer-documents/conformity', '/portal/threads', '/portal/tasks', `/files?recordType=Quote&recordId=${G.betaQuote.id}`]) {
      expect(findMarkers(await asBrand(beta, seen, 'GET', url), alphaMarkers), url).toEqual([])
    }
    for (const url of ['/link/share', '/link/share/messages', `/threads/Quote/${G.betaQuote.id}`]) {
      expect(findMarkers(await viaBrandLink(w, beta, G.betaLink, seen, 'GET', url, undefined, null), alphaMarkers), url).toEqual([])
    }
    const betaAddresses = new Set(await addressesOf(w, beta))
    const toBeta = w.h.ses.mails.filter((mail) => [...mail.to, ...mail.cc, ...mail.bcc].some((address) => betaAddresses.has(address.toLowerCase())))
    expect(toBeta.length).toBeGreaterThan(0)
    expect(toBeta.flatMap((mail) => findMarkers(mailText(mail.raw), alphaMarkers).map((found) => `${mail.templateKey} to ${mail.to.join(',')}: ${found}`))).toEqual([])
    // The control: Alpha's mail carried its tech pack, and Alpha's portal lists the file on its order.
    const toAlpha = w.h.ses.mails.filter((mail) => mail.to.includes(BRAND_ALPHA.contact.email))
    expect(toAlpha.some((mail) => mailText(mail.raw).includes(BRAND_ALPHA.fileName))).toBe(true)
    expect(JSON.stringify(await asBrand(alpha, seen, 'GET', `/files?recordType=SalesOrder&recordId=${id('sales:SO1')}`))).toContain(BRAND_ALPHA.fileName)
  })

  it('T33 the safety reports: Brand Beta’s door answers words only; once the company takes reports (its notice published, the switch on), a report of Brand Alpha’s is never met by Brand Beta, and a portal report answers its own number and words only', async () => {
    const alphaMarkers = await markersOf(w, BRAND_ALPHA, P1())
    expect(findMarkers(await asBrand(beta, seen, 'GET', '/portal/safety-reports/status'), alphaMarkers)).toEqual([])
    // The office opens the door as Admin › Privacy does: the safety-report notice published, then the company's switch.
    let notice = (await ok(P.admin, 'POST', '/privacy/notices', { companyId: companyA(), kind: 'SAFETY_REPORT', label: '2026-11', copyTexts: false }, 201)).notice
    for (const [locale, body] of Object.entries({ it: 'Informativa (inventata) sulle segnalazioni di sicurezza.', en: 'Made-up notice about safety reports.' })) {
      notice = (await ok(P.admin, 'PUT', `/privacy/notices/${notice.id}/texts/${locale}`, { body, version: notice.version })).notice
    }
    await stepped(w, P.admin)
    await ok(P.admin, 'POST', `/privacy/notices/${notice.id}/publish`, { version: notice.version })
    // The switch is kept on the company's own sales settings: saved as they stand (Sales › Settings).
    const rules = (await ok(P.owner, 'GET', `/sales/settings?companyId=${companyA()}`)).settings
    if (rules.company === null) {
      const { marginFloorPct, discountLimitPct, defaultValidityDays, defaultDepositPct } = rules.inForce
      await stepped(w, P.owner)
      await ok(P.owner, 'PUT', '/sales/settings', { companyId: companyA(), marginFloorPct, discountLimitPct, defaultValidityDays, ...(defaultDepositPct === null ? {} : { defaultDepositPct }) })
    }
    await stepped(w, P.admin)
    await ok(P.admin, 'PUT', '/privacy/safety-report-form', { companyId: companyA(), on: true })
    const status = await asBrand(beta, seen, 'GET', '/portal/safety-reports/status')
    expect(status).toMatchObject({ open: true })
    expect(findMarkers(status, alphaMarkers)).toEqual([])
    const publicStatus = await w.h.app.inject({ method: 'GET', url: '/public/safety-reports/status', remoteAddress: '198.51.100.9' })
    expect(findMarkers(publicStatus.body, alphaMarkers)).toEqual([])
    // A report the office files for Brand Alpha (from a mail, its garment's serial): the factory sees it; Brand Beta's portal
    // never meets its number — not in a search, a notice, a task or its returns.
    const report = (await ok(P.inspector, 'POST', '/sales/safety-reports', { companyId: companyA(), source: 'MAIL', partyId: P1(), serial: 'SEED-SN-0002', whatHappened: 'Made-up: the collar zip of AX-100 came loose.', wornAsIntended: true, injured: false, reporter: { name: 'Made-up Rider', email: 'rider.wall@example.com' } }, 201)).report
    expect(JSON.stringify(await ok(P.inspector, 'GET', '/sales/safety-reports'))).toContain(report.number)
    const number: Marker[] = [{ label: 'safety report', text: report.number }, { label: 'safety report', text: report.id }]
    for (const url of [`/portal/search?q=${encodeURIComponent(report.number)}`, '/portal/notifications', '/portal/tasks', '/portal/returns', '/portal/complaints', '/portal/safety-reports/status']) {
      const body = await asBrand(beta, seen, 'GET', url, undefined, null)
      expect(findMarkers(withoutEcho(url, body), number), url).toEqual([])
    }
    // What a portal report answers (the contract): its own number and words, the photo window — never another record.
    const answer = portalSendContract.response[201].shape
    expect(Object.keys(answer).sort()).toEqual(['photos', 'report', 'sent'])
    expect(Object.keys(answer.report.shape).sort()).toEqual(['id', 'number'])
    expect(Object.keys(answer.sent.shape).sort()).toEqual(['number', 'words'])
    expect(Object.keys(answer.photos.shape).sort()).toEqual(['max', 'mayUpload', 'until'])
  })

  it('T00 the name scan: no answer, mail or link page Brand Beta got holds a name, code, number, file name, address or id of Brand Alpha — nor the other way round', async () => {
    const alphaMarkers: Marker[] = await markersOf(w, BRAND_ALPHA, P1())
    const betaMarkers: Marker[] = await markersOf(w, BRAND_BETA, P3())
    expect(alphaMarkers.length).toBeGreaterThan(20)
    expect(betaMarkers.length).toBeGreaterThan(10)
    const leaks = (who: string, markers: readonly Marker[]) =>
      seen.filter((entry) => entry.who.startsWith(who)).flatMap((entry) => findMarkers(withoutEcho(entry.url, entry.body), markers).map((found) => `${entry.who} ${entry.method} ${entry.url} (${entry.status}): ${found}`))
    expect(leaks('beta', alphaMarkers)).toEqual([])
    expect(leaks('alpha', betaMarkers)).toEqual([])
    const mailsTo = async (brand: BrandInWorld) => {
      const addresses = new Set(await addressesOf(w, brand))
      return w.h.ses.mails.filter((mail) => [...mail.to, ...mail.cc, ...mail.bcc].some((address) => addresses.has(address.toLowerCase())))
    }
    expect((await mailsTo(beta)).flatMap((mail) => findMarkers(mailText(mail.raw), alphaMarkers).map((found) => `${mail.templateKey}: ${found}`))).toEqual([])
    expect((await mailsTo(alpha)).flatMap((mail) => findMarkers(mailText(mail.raw), betaMarkers).map((found) => `${mail.templateKey}: ${found}`))).toEqual([])
    // What the scan read, to prove it read them all: both brands' portal answers, Beta's link pages, and both brands' mails.
    expect(new Set(seen.map((entry) => entry.who))).toEqual(new Set(['alpha portal', 'beta portal', 'beta link']))
    expect(seen.filter((entry) => entry.who.startsWith('beta')).length).toBeGreaterThan(100)
  })

  it('Z1 no route answered 500 during the flow', async () => {
    await settle()
    expect(unexpected.map((report) => `${report.context.method} ${report.context.route}: ${report.name}: ${report.message} ${report.stack.slice(0, 3).join(' | ')}`)).toEqual([])
  })
})
