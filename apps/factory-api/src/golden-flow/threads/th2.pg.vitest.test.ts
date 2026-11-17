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
import { addressesOf, asBrand, BRAND_ALPHA, BRAND_BETA, findMarkers, mailText, markersOf, setUpBrand, type BrandInWorld, type Seen } from '../portal/testing/two-brands'
import { admin, announce, ok, pdf, person, putBytes, QUIET, startWorld, stepped, type Person, type World } from '../testing/world'

/**
 * B-TH-037 — GOLDEN FLOW TH-2: A REQUEST BECOMES AN ORDER (threads plan TH-2; §0 the brand wall; Owner rule 2026-11-16: "One brand
 * must not be able to see anything related to any other brand. But we, as the production unit, should be able to see it all. And
 * manage it all as well."). On the golden world (every base seed, the real app and sign-in, every outside provider FAKE) with the
 * worker's handlers run in-process, through the HTTP routes:
 *
 *   S   the sales office makes P1 into Brand Alpha (customer A) and P3 into Brand Beta (customer B), each with its portal; customer
 *       B gets a small credit limit and the company's rule "Orders over the credit limit" is switched on.
 *   G3  customer A's portal request (text only) gets its lines from the office and a file shared with A; Make order makes ONE order
 *       of A — CONFIRMED, the file carried to it (Use on…); A's portal reads "Order confirmed" with its own order number and the
 *       copied file on the order. Customer B's request becomes an order WAITING for approval (over its limit): said so to the
 *       office and to B ("waiting for our approval"), never "confirmed".
 *   L2-G18 the production manager makes a style draft from A's second request: a DRAFT style for A's own label, the request's
 *       file carried, the request still open and naming it.
 *   G10 unread per person: the office's counts of a page of records, the "New since your last visit" line, read marks; A's portal
 *       counts only what was shared with A, and its own read mark clears it.
 *   N1/N2 who answers and what waits: the request's assignee, waiting on the customer once asked; the order's maker; never in a
 *       portal answer (W08).
 *   T37 / T00 customer B finds none of A's requests, orders, files or style drafts by any door, and the name scan over everything B
 *       got (answers and mail) holds nothing of A.
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
const P = {} as Record<'owner' | 'sales' | 'manager', Person>
let alpha: BrandInWorld
let beta: BrandInWorld
const seen: Seen[] = []
const unexpected: ErrorReport[] = []
const G = {} as Record<string, any>
/** Each brand's portal person is its buyer (sends requests, orders from the catalogue) who may write in its threads. */
const BUYER = { roleKey: 'customer-buyer', capabilities: ['comment'] } as const
const id = (key: string) => w.id(key)
const companyA = () => id('company:A')
const P1 = () => id('party:P1')
const P3 = () => id('party:P3')
const today = () => businessDate(new Date())
const A = (method: 'GET' | 'POST', url: string, body?: unknown, status: number | null = 200) => asBrand(alpha, seen, method, url, body, status)
const B = (method: 'GET' | 'POST', url: string, body?: unknown, status: number | null = 200) => asBrand(beta, seen, method, url, body, status)
/** The office's own number of a request (INQ-…): the office reads it, a customer never (§0.5). */
const officeNumber = async (inquiryId: string) => (await admin<{ number: string }>(w, 'SELECT number FROM "Inquiry" WHERE id = $1', [inquiryId]))[0]!.number
const styleOf = async (code: string, colour: string) => {
  const style = (await admin<{ id: string; sizeScaleId: string }>(w, 'SELECT id, "sizeScaleId" FROM "Style" WHERE "tenantId" = $1 AND code = $2', [w.tenant.id, code]))[0]!
  const colourway = (await admin<{ id: string }>(w, 'SELECT id FROM "Colourway" WHERE "styleId" = $1 AND code = $2', [style.id, colour]))[0]!
  return { style: style.id, colourway: colourway.id, scale: style.sizeScaleId }
}

/** A file the office adds to a request, shared with the request's customer (its portal; sharing a file outside the office takes
 *  files.manage: the owner): announced, its bytes sent, completed. */
async function sharedFile(recordId: string, name: string): Promise<string> {
  const body = pdf(name)
  const announced = await ok(P.owner, 'POST', '/files', { recordType: 'Inquiry', recordId, companyId: companyA(), kind: 'DOCUMENT', ...announce(name, body), visibility: ['OFFICE', 'PARTNER'] }, 201)
  await putBytes(w, announced, body)
  expect((await ok(P.owner, 'POST', `/files/${announced.file.id}/complete`)).file.status).toBe('AVAILABLE')
  return announced.file.id
}

/** The office gives a portal request its lines (the customer wrote words only). */
async function withLines(inquiryId: string, lines: Json[]): Promise<Json> {
  const record = (await ok(P.sales, 'GET', `/sales/inquiries/${inquiryId}`)).inquiry
  return (await ok(P.sales, 'PATCH', `/sales/inquiries/${inquiryId}`, { version: record.version, lines })).inquiry
}

/**
 * The harness clock (a clock the test moves; each two-factor step moved it 30 s on) no later than real time before the first
 * request: a portal request is dated by the app's (harness) clock, while the office closes it on the server's — a request is
 * closed "not before it came and not in the future". It goes back no further than the newest role given (a role must have
 * started); real time catches up with it for the rest (the harness clock stands still while real time runs).
 */
async function settleClock(): Promise<void> {
  const [latest] = await admin<{ at: Date | null }>(w, 'SELECT max("validFrom") AS at FROM "RoleAssignment" WHERE "tenantId" = $1', [w.tenant.id])
  w.h.clock.set(new Date(Math.min(w.h.clock.now().getTime(), Math.max(Date.now(), (latest?.at?.getTime() ?? 0) + 1000))))
  const ahead = w.h.clock.now().getTime() - Date.now()
  if (ahead > 0) await new Promise((resolve) => setTimeout(resolve, ahead + 1000))
}

beforeAll(async () => {
  useErrorTracker(createErrorTracker({ sink: { kind: 'fake', send: (report) => void unexpected.push(report) }, source: 'api' }))
  w = await startWorld()
  w.h.clock.set(new Date())
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

describe('B-TH-037 golden flow TH-2: a request becomes an order, a style draft, unread, owner and waiting, behind the brand wall', { timeout: 300_000 }, () => {
  it('S00 the world: the seeds drain; the search index is built', async () => {
    await standardReasonsForNewTenants({ database: w.h.database, log: QUIET })
    await indexNewTenants({ database: w.h.database, indexers, log: QUIET })
    await settle()
  })

  it('S01 Brand Alpha (P1) and Brand Beta (P3) with their portals; Beta gets a small credit limit and the credit rule is switched on', async () => {
    alpha = await setUpBrand(w, P.sales, BRAND_ALPHA, P1(), companyA(), BUYER)
    beta = await setUpBrand(w, P.sales, BRAND_BETA, P3(), companyA(), BUYER)
    await stepped(w, P.owner)
    const rules = (await ok(P.owner, 'GET', '/approvals/rules?kind=CREDIT_OVERRIDE')).rules as Json[]
    const rule = rules.find((entry) => entry.kind === 'CREDIT_OVERRIDE' && entry.companyId === companyA())!
    await ok(P.owner, 'PUT', `/approvals/rules/${rule.id}`, { version: rule.version, active: true })
    await stepped(w, P.owner)
    await ok(P.owner, 'PUT', `/sales/credit/limits/${P3()}/${companyA()}`, { amount: 100, currency: 'EUR', reason: 'Made-up: a new customer starts small.' })
    // Our own collection's vest (no brand: any customer orders it), its SKUs made at once, by the production manager.
    const { style } = await ok(P.manager, 'POST', '/product/styles', { code: 'TH2-OWN-01', name: 'Own collection team vest (made up)', productType: 'VEST', season: 'FW27', sizeScaleId: id('product:size-scale:EU-JKT'), sizes: ['50', '52'], baseSize: '52', ppeCategory: 'NOT_PPE', colourways: [{ code: 'GRY', name: 'Grigio', colourId: id('product:colour:RED') }], generateSkus: true }, 201)
    await ok(P.manager, 'POST', `/product/styles/${style.id}/revisions`, { changeNote: 'First revision of TH2-OWN-01' }, 201)
    await settle()
    // Each two-factor step moved the harness clock 30 s on, while a request is closed "not in the future" of the database's clock
    // (5 minutes of difference allowed): the clock goes back as far as every role given so far still holds (no step-up follows).
    await settleClock()
  }, 900_000)

  it('G3 customer A’s portal request gets its lines and a shared file; Make order: ONE order of A, CONFIRMED, the file carried', async () => {
    const sent = await A('POST', '/portal/inquiries', { subject: 'Made-up: twelve team jackets', message: `${BRAND_ALPHA.message}\nTwelve jackets in black, as the sketch.`, customerRef: BRAND_ALPHA.customerRef, wantedDate: addDays(today(), 45) }, 201)
    G.request = sent.request
    await settle()
    G.file = await sharedFile(G.request.id, BRAND_ALPHA.fileName)
    const jacket = await styleOf('SEED-JKT-02', 'BLK')
    const lined = await withLines(G.request.id, [{ styleId: jacket.style, colourwayId: jacket.colourway, sizes: { '50': 4, '52': 4, '54': 4 } }])
    expect(lined.actions.order).toEqual({ allowed: true, refusal: null })
    const made = await ok(P.sales, 'POST', `/sales/inquiries/${G.request.id}/order`, { version: lined.version, lines: [{ seq: 10, unitPrice: '165' }] }, 201)
    expect(made.order).toMatchObject({ status: 'CONFIRMED', waitsFor: null })
    expect(made.said.en).toContain('is confirmed')
    expect(made.inquiry).toMatchObject({ status: 'ORDERED', order: { id: made.order.id, status: 'CONFIRMED' } })
    expect(made.files.carried).toEqual([{ sourceFileId: G.file, fileId: expect.any(String), name: BRAND_ALPHA.fileName }])
    G.order = made.order
    expect((await admin<Json>(w, 'SELECT "partyId", "customerRef" FROM "SalesOrder" WHERE id = $1', [G.order.id]))[0]).toEqual({ partyId: P1(), customerRef: BRAND_ALPHA.customerRef })
    expect((await admin<Json>(w, 'SELECT "partyId", "sourceFileId" FROM "StoredFile" WHERE id = $1', [made.files.carried[0].fileId]))[0]).toEqual({ partyId: P1(), sourceFileId: G.file })
    await settle()
  })

  it('G3 customer A reads “Order confirmed” with its own order number, and the carried file on its order', async () => {
    const read = (await A('GET', `/portal/inquiries/${G.request.id}`)).request
    expect(read.state).toMatchObject({ code: 'ORDER_CONFIRMED', words: { en: 'Order confirmed' } })
    expect(read.made.order).toMatchObject({ id: G.order.id, yourNumber: { words: { en: expect.stringMatching(/^Your order \d+$/) } } })
    const files = (await A('GET', `/files?recordType=SalesOrder&recordId=${G.order.id}`)).files as Json[]
    expect(files.map((file) => file.originalName)).toEqual([BRAND_ALPHA.fileName])
    const news = (await A('GET', '/portal/notifications')).items as Json[]
    expect(news.some((item) => item.record.id === G.order.id && /is confirmed/.test(item.sentence.en))).toBe(true)
  })

  it('G3 customer B’s request becomes an order WAITING for approval (over its limit): said so to the office and to B, never “confirmed”', async () => {
    const sent = await B('POST', '/portal/inquiries', { subject: 'Made-up: three team vests', message: BRAND_BETA.message, customerRef: BRAND_BETA.customerRef }, 201)
    G.betaRequest = sent.request
    await settle()
    const liner = await styleOf('TH2-OWN-01', 'GRY')
    const lined = await withLines(G.betaRequest.id, [{ styleId: liner.style, colourwayId: liner.colourway, sizes: { '52': 3 } }])
    const made = await ok(P.sales, 'POST', `/sales/inquiries/${G.betaRequest.id}/order`, { version: lined.version, lines: [{ seq: 10, unitPrice: '60' }] }, 201)
    expect(made.order).toMatchObject({ status: 'PENDING_APPROVAL', waitsFor: 'CREDIT' })
    expect(made.said.en).toContain('waits for approval')
    G.betaOrder = made.order
    await settle()
    const read = (await B('GET', `/portal/inquiries/${G.betaRequest.id}`)).request
    expect(read.state).toMatchObject({ code: 'ORDER_WAITING', words: { en: 'Order waiting for approval' } })
    const news = ((await B('GET', '/portal/notifications')).items as Json[]).filter((item) => item.record.id === G.betaOrder.id)
    expect(news.length).toBeGreaterThan(0)
    for (const item of news) expect(item.sentence.en).not.toMatch(/is confirmed/)
  })

  it('L2-G18 the production manager makes a style draft from A’s second request: A’s own label, the file carried, the request still open', async () => {
    const sent = await A('POST', '/portal/inquiries', { subject: 'Made-up: a new design with our logo', message: 'Made-up: a racing jacket with our logo on the back.' }, 201)
    G.second = sent.request
    await settle()
    const file = await sharedFile(G.second.id, 'Made-up Alpha logo sketch.pdf')
    const record = (await ok(P.manager, 'GET', `/sales/inquiries/${G.second.id}`)).inquiry
    expect(record.actions.styleDraft).toEqual({ allowed: true, refusal: null })
    const jacket = await styleOf('SEED-JKT-02', 'BLK')
    const made = await ok(P.manager, 'POST', `/sales/inquiries/${G.second.id}/style-draft`, { version: record.version, code: 'TH2-AX-LOGO', productType: 'JACKET', sizeScaleId: jacket.scale, sizes: ['50', '52'], baseSize: '52', ppeCategory: 'NOT_PPE', fileIds: [file] }, 201)
    expect(made.style).toMatchObject({ code: 'TH2-AX-LOGO', status: 'DRAFT', name: 'Made-up: a new design with our logo' })
    expect(made.files.carried.map((entry: Json) => entry.name)).toEqual(['Made-up Alpha logo sketch.pdf'])
    expect((await admin<Json>(w, 'SELECT "brandPartyId", "companyId" FROM "Style" WHERE id = $1', [made.style.id]))[0]).toEqual({ brandPartyId: P1(), companyId: companyA() })
    expect(made.inquiry).toMatchObject({ status: 'NEW', styleDrafts: [{ id: made.style.id, code: 'TH2-AX-LOGO' }] })
    G.style = made.style
    await settle()
  })

  it('G10 unread per person (office): a page’s counts in one read, the “New since your last visit” line, the read mark', async () => {
    const records = [{ recordType: 'Inquiry', recordId: G.request.id }, { recordType: 'Inquiry', recordId: G.second.id }, { recordType: 'SalesOrder', recordId: G.order.id }]
    const before = (await ok(P.sales, 'POST', '/threads/unread', { records })).counts as Json[]
    expect(before.map((count) => count.recordId)).toEqual(records.map((record) => record.recordId))
    expect(before[0]!.newCount).toBeGreaterThan(0)
    expect((await ok(P.sales, 'POST', `/threads/Inquiry/${G.request.id}/read`, {})).reading).toMatchObject({ newCount: 0, firstNewMessageId: null })
    const posted = await A('POST', `/portal/threads/Inquiry/${G.request.id}/messages`, { body: 'Made-up: thank you, can the order ship by the 20th?' }, 201)
    await settle()
    expect(((await ok(P.sales, 'POST', '/threads/unread', { records: [records[0]] })).counts as Json[])[0]!.newCount).toBe(1)
    expect((await ok(P.sales, 'GET', `/threads/Inquiry/${G.request.id}`)).reading).toMatchObject({ newCount: 1, firstNewMessageId: posted.message.id })
    // The production manager's own count is his: Sales reading it moved nothing of his.
    expect(((await ok(P.manager, 'POST', '/threads/unread', { records: [records[0]] })).counts as Json[])[0]!.newCount).toBeGreaterThan(1)
  })

  it('G10 customer A counts only what was shared with it; our question is new to it until it reads it', async () => {
    const record = (await ok(P.sales, 'GET', `/sales/inquiries/${G.second.id}`)).inquiry
    const assigned = await ok(P.sales, 'POST', `/sales/inquiries/${G.second.id}/assign`, { version: record.version, assigneeId: P.sales.id })
    await ok(P.sales, 'POST', `/sales/inquiries/${G.second.id}/ask-info`, { version: assigned.inquiry.version, message: { body: 'Made-up question: where does the logo go?' } })
    await settle()
    const conversations = (await A('GET', '/portal/threads')).conversations as Json[]
    expect(conversations.find((entry) => entry.record.id === G.second.id)?.newCount).toBe(1)
    const read = await A('GET', `/portal/threads/Inquiry/${G.second.id}`)
    expect(read.reading.newCount).toBe(1)
    expect(read.messages.find((message: Json) => message.id === read.reading.firstNewMessageId)?.body).toBe('Made-up question: where does the logo go?')
    expect((await A('POST', `/portal/threads/Inquiry/${G.second.id}/read`, {})).reading).toMatchObject({ newCount: 0 })
    expect(((await A('GET', '/portal/threads')).conversations as Json[]).find((entry) => entry.record.id === G.second.id)?.newCount).toBe(0)
  })

  it('N1/N2 who answers and what waits: the request’s assignee, waiting on the customer once asked; the order’s maker; never in a portal answer', async () => {
    const request = (await ok(P.sales, 'GET', `/threads/Inquiry/${G.second.id}`)).head
    expect(request).toMatchObject({ owner: { id: P.sales.id, source: 'ASSIGNEE' }, waiting: { on: 'CUSTOMER', amber: false, thresholdDays: 1 } })
    const order = (await ok(P.sales, 'GET', `/threads/SalesOrder/${G.order.id}`)).head
    expect(order.owner).toMatchObject({ id: P.sales.id, source: 'MAKER' })
    const portal = await A('GET', `/threads/Inquiry/${G.second.id}`)
    expect(portal.head).toBeUndefined()
    expect(JSON.stringify(await A('GET', `/portal/threads/Inquiry/${G.second.id}`))).not.toContain('ASSIGNEE')
  })

  it('T37 customer B finds none of A’s requests, orders, files or style drafts by any door', async () => {
    for (const url of [`/portal/inquiries/${G.request.id}`, `/portal/inquiries/${G.second.id}`, `/portal/threads/Inquiry/${G.request.id}`, `/portal/threads/SalesOrder/${G.order.id}`]) await B('GET', url, undefined, 404)
    const files = await B('GET', `/files?recordType=SalesOrder&recordId=${G.order.id}`, undefined, null)
    expect(JSON.stringify(files)).not.toContain(BRAND_ALPHA.fileName)
    expect(((await B('POST', '/threads/unread', { records: [{ recordType: 'Inquiry', recordId: G.request.id }, { recordType: 'SalesOrder', recordId: G.order.id }] })).counts as Json[]).map((count) => count.newCount)).toEqual([0, 0])
    for (const q of [G.order.number, await officeNumber(G.request.id), 'TH2-AX-LOGO', BRAND_ALPHA.customerRef]) await B('GET', `/portal/search?q=${encodeURIComponent(q)}`)
    await B('GET', '/portal/inquiries?state=ALL')
    await B('GET', '/portal/threads')
    await B('GET', '/portal/notifications')
  })

  it('§0.5 counts do not leak: customer B’s notices, mail and search hits name its own numbers only — never INQ-, QT- or SO-', async () => {
    const SERIES = /(?<![A-Za-z0-9])(?:SEED-)?(?:INQ|QT|SO)-[0-9A-Z-]*\d/
    const news = (await B('GET', '/portal/notifications')).items as Json[]
    expect(news.length).toBeGreaterThan(0)
    expect(news.filter((item) => SERIES.test(JSON.stringify(item))).map((item) => item.sentence.en)).toEqual([])
    expect(news.find((item) => item.record.id === G.betaRequest.id)?.record.label).toMatch(/^#\d+$/)
    const hits = await B('GET', `/portal/search?q=${encodeURIComponent(BRAND_BETA.customerRef)}`)
    const results = (hits.groups as Json[]).flatMap((group) => group.results as Json[])
    expect(results.map((result) => result.recordId)).toEqual(expect.arrayContaining([G.betaRequest.id, G.betaOrder.id]))
    for (const result of results) expect(result.ourRef ?? '').not.toMatch(SERIES)
    expect(SERIES.test(JSON.stringify({ ...hits, query: null, words: null }))).toBe(false)
    const addresses = new Set(await addressesOf(w, beta))
    const mails = w.h.ses.mails.filter((mail) => mail.templateKey === 'portal.notification' && mail.to.some((address) => addresses.has(address.toLowerCase())))
    expect(mails.length).toBeGreaterThan(0)
    expect(mails.filter((mail) => SERIES.test(mailText(mail.raw))).map((mail) => mail.templateKey)).toEqual([])
    // The office keeps both: its own answers name the series.
    expect((await ok(P.sales, 'GET', `/sales/inquiries/${G.betaRequest.id}`)).inquiry.number).toMatch(/^INQ-/)
  })

  it('T00 the name scan: nothing B got (answers and mail) holds a name, number, file or id of A', async () => {
    const markers = [
      ...(await markersOf(w, BRAND_ALPHA, P1())),
      { label: 'request number', text: await officeNumber(G.request.id) },
      { label: 'second request number', text: await officeNumber(G.second.id) },
      { label: 'order number', text: G.order.number as string },
      { label: 'style draft', text: 'TH2-AX-LOGO' },
      { label: 'style draft id', text: G.style.id as string },
      { label: 'logo file', text: 'Made-up Alpha logo sketch.pdf' },
    ]
    // A search answer repeats what was typed (Beta typed A's numbers on purpose): its echo is left out of the scan.
    // An unread count answers each record asked, as asked (Beta asked for A's ids on purpose: 0, as for an id that does not exist):
    // that echo is left out of the scan, its counts are not.
    const bodyOf = (entry: Seen) =>
      entry.url.startsWith('/portal/search') && entry.body && typeof entry.body === 'object'
        ? { ...(entry.body as Json), query: null, words: null }
        : entry.url === '/threads/unread' && entry.body && typeof entry.body === 'object'
          ? ((entry.body as Json).counts as Json[]).map((count) => ({ newCount: count.newCount, lastAt: count.lastAt }))
          : entry.body
    const leaks = seen.filter((entry) => entry.who.startsWith('beta')).flatMap((entry) => findMarkers(bodyOf(entry), markers).map((found) => `${entry.method} ${entry.url} (${entry.status}): ${found}`))
    expect(leaks).toEqual([])
    const addresses = new Set(await addressesOf(w, beta))
    const mails = w.h.ses.mails.filter((mail) => [...mail.to, ...mail.cc, ...mail.bcc].some((address) => addresses.has(address.toLowerCase())))
    expect(mails.flatMap((mail) => findMarkers(mailText(mail.raw), markers).map((found) => `${mail.templateKey}: ${found}`))).toEqual([])
    expect(seen.filter((entry) => entry.who.startsWith('beta')).length).toBeGreaterThan(10)
  })

  it('Z no route answered 500 during the flow', async () => {
    await settle()
    expect(unexpected.map((report) => `${report.context.method} ${report.context.route}: ${report.name}: ${report.message} ${report.stack.slice(0, 3).join(' | ')}`)).toEqual([])
  })
})
