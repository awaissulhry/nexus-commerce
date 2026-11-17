import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { ErrorReport } from '@nexus/factory-domain/observability/report'
import { addDays } from '@nexus/factory-domain/planning/buy'
import { REQUEST_NOTICE } from '@nexus/factory-domain/sales/portal-ordering/rules'
import { createErrorTracker, useErrorTracker } from '../../observability/tracker'
import { usePortalOptions } from '../../platform/auth/portal/service'
import { freshGuard } from '../../platform/auth/portal/testing/portal'
import type { EventHandler } from '../../platform/outbox/dispatch'
import { standardReasonsForNewTenants } from '../../platform/reasons/standard'
import type { SearchIndexer } from '../../platform/search/indexer'
import { indexNewTenants } from '../../platform/search/indexing'
import { everyHandler, searchIndexers, settler } from '../daily/testing/day'
import { addressesOf, asBrand, BRAND_ALPHA, BRAND_BETA, findMarkers, mailText, markersOf, setUpBrand, type BrandInWorld, type Seen } from '../portal/testing/two-brands'
import { admin, ok, person, QUIET, startWorld, type Person, type World } from '../testing/world'

/**
 * B-TH-021 — GOLDEN FLOW TH-1b: A CUSTOMER WRITES A REQUEST LIKE AN E-MAIL (threads plan TH-1b; §0 the brand wall; Owner rule
 * 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production unit, should be
 * able to see it all. And manage it all as well."). On the golden world (../testing/world.ts: every base seed, the real app and
 * sign-in, every outside provider FAKE) with the worker's handlers run in-process, through the HTTP routes:
 *
 *   S   the sales office makes P1 into Brand Alpha (customer A) and P3 into Brand Beta (customer B), each with its portal.
 *   T37 customer A sends a request from its portal — text only (subject, words, its PO, the day it wants the goods): its receipt
 *       says "Your request N", N its own count (its earlier requests + 1), never the office's series.
 *   G2  the office reads it in Incoming (sales.inquiries: the NEW tile, from the portal, the customer A), and so does the
 *       production manager — without prices or the prospect's contact, every answer held READ_ONLY.
 *   G4  the office asks for information: the question is a reply customer A reads in its portal ("We need something from you");
 *       customer A answers in its thread and the request is taken up again by itself (In progress / "Being reviewed").
 *   N24 a quote draft follows: the request QUOTED, the customer reads "Quote being prepared" and no quote number.
 *   W05 customer A's list reads "Your request N"; customer B's own request reads its own count, untouched by A's.
 *   L2-G17 the catalogue door's answer promises no time (confirmBy null; no "working day" in either language).
 *   T00 the name scan: every answer and mail customer B got holds nothing of customer A (A's request number, PO, words, ids).
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
const P = {} as Record<'sales' | 'manager', Person>
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
const PROMISE = /working day|giorno lavorativ|confirm by|confermiamo entro|entro il|within/i
const A = (method: 'GET' | 'POST', url: string, body?: unknown, status: number | null = 200) => asBrand(alpha, seen, method, url, body, status)
const B = (method: 'GET' | 'POST', url: string, body?: unknown, status: number | null = 200) => asBrand(beta, seen, method, url, body, status)
/** The office's own number of a request (INQ-…): the office reads it, a customer never (§0.5). */
const officeNumber = async (inquiryId: string) => (await admin<{ number: string }>(w, 'SELECT number FROM "Inquiry" WHERE id = $1', [inquiryId]))[0]!.number
const ownRequests = async (partyId: string) => (await admin<{ n: number }>(w, 'SELECT count(*)::int AS n FROM "Inquiry" WHERE "tenantId" = $1 AND "partyId" = $2', [w.tenant.id, partyId]))[0]!.n

/** The harness clock back to now, or just after the newest role assignment when that is later (a role must have started). */
async function settleClock(): Promise<void> {
  const [latest] = await admin<{ at: Date | null }>(w, 'SELECT max("validFrom") AS at FROM "RoleAssignment" WHERE "tenantId" = $1', [w.tenant.id])
  const target = Math.max(Date.now(), (latest?.at?.getTime() ?? 0) + 1000)
  console.info(`settleClock: harness ran ${Math.round((w.h.clock.now().getTime() - Date.now()) / 1000)} s ahead; now ${Math.round((target - Date.now()) / 1000)} s`)
  w.h.clock.set(new Date(target))
}

beforeAll(async () => {
  useErrorTracker(createErrorTracker({ sink: { kind: 'fake', send: (report) => void unexpected.push(report) }, source: 'api' }))
  w = await startWorld()
  w.h.clock.set(new Date())
  freshGuard(w.h)
  usePortalOptions({ answerFloorMs: 0 })
  indexers = await searchIndexers()
  handlers = everyHandler(indexers)
  settle = settler(w, handlers)
  P.sales = await person(w, 'sales', 'sales')
  P.manager = await person(w, 'manager', 'production_manager')
}, 1_200_000)

afterAll(async () => {
  usePortalOptions({})
  useErrorTracker(undefined)
  await w?.close()
}, 60_000)

describe('B-TH-021 golden flow TH-1b: a request like an e-mail, from the portal to a quote draft, behind the brand wall', { timeout: 300_000 }, () => {
  it('S00 the world: the seeds drain; the search index is built', async () => {
    await standardReasonsForNewTenants({ database: w.h.database, log: QUIET })
    await indexNewTenants({ database: w.h.database, indexers, log: QUIET })
    await settle()
  })

  it('S01 the sales office makes P1 into Brand Alpha and P3 into Brand Beta, each with its portal', async () => {
    alpha = await setUpBrand(w, P.sales, BRAND_ALPHA, P1(), companyA(), BUYER)
    beta = await setUpBrand(w, P.sales, BRAND_BETA, P3(), companyA(), BUYER)
    await settle()
    // Each two-factor step moved the harness clock 30 s on, while a request is closed "not in the future" of the database's clock
    // (5 minutes of difference allowed): the clock goes back as far as every role given so far still holds (no step-up follows).
    await settleClock()
  })

  it('T37 customer A sends a request from its portal, text only: the receipt says “Your request N” (its own count), never the office series', async () => {
    expect((await A('GET', '/portal/inquiries/open')).open).toBe(true)
    const before = await ownRequests(P1())
    const sent = await A('POST', '/portal/inquiries', { subject: 'Made-up: ten team jackets for the spring', message: `${BRAND_ALPHA.message}\nWe need ten jackets, sizes 50 to 54.`, customerRef: BRAND_ALPHA.customerRef, wantedDate: addDays(today(), 40) }, 201)
    G.request = sent.request
    expect(sent.receipt.yourNumber).toMatchObject({ seq: before + 1, words: { en: `Your request ${before + 1}` } })
    expect(sent.receipt.words.en).toBe(`Received — Your request ${before + 1}.`)
    G.office = await officeNumber(G.request.id)
    expect(JSON.stringify(sent)).not.toContain(G.office)
    expect(sent.request).toMatchObject({ customerRef: BRAND_ALPHA.customerRef, source: 'PORTAL', state: { code: 'SENT' } })
    await settle()
    // The request's words are its thread's first message, by the customer.
    const thread = await A('GET', `/portal/threads/Inquiry/${G.request.id}`)
    expect(thread.messages.map((message: Json) => message.side)).toEqual(['PARTNER'])
    expect(thread.messages[0].body).toContain('ten jackets')
  })

  it('G2 the office reads it in Incoming (NEW, from the portal, customer A); the production manager too — no prices, every answer held READ_ONLY', async () => {
    const list = await ok(P.sales, 'GET', `/sales/inquiries?tile=NEW&source=PORTAL&partyId=${P1()}`)
    expect((list.rows as Json[]).map((row) => row.id)).toContain(G.request.id)
    const record = (await ok(P.sales, 'GET', `/sales/inquiries/${G.request.id}`)).inquiry
    expect(record).toMatchObject({ status: 'NEW', source: 'PORTAL', party: { id: P1() }, customerRef: BRAND_ALPHA.customerRef, actions: { askInfo: { allowed: true }, quote: { allowed: true } } })
    G.version = record.version
    const managers = await ok(P.manager, 'GET', '/sales/inquiries?tile=NEW')
    expect((managers.rows as Json[]).map((row) => row.id)).toContain(G.request.id)
    const theirs = (await ok(P.manager, 'GET', `/sales/inquiries/${G.request.id}`)).inquiry
    expect('targetUnitPrice' in theirs).toBe(false)
    expect(theirs.actions.quote).toMatchObject({ allowed: false, refusal: { code: 'READ_ONLY' } })
    expect(theirs.actions.askInfo).toMatchObject({ allowed: false, refusal: { code: 'READ_ONLY' } })
  })

  it('G4 the office asks for information: customer A reads the question and “We need something from you”; its answer takes the request up again', async () => {
    const assigned = await ok(P.sales, 'POST', `/sales/inquiries/${G.request.id}/assign`, { version: G.version, assigneeId: P.sales.id })
    const asked = await ok(P.sales, 'POST', `/sales/inquiries/${G.request.id}/ask-info`, { version: assigned.inquiry.version, message: { body: 'Made-up question: which colour, black or red?' } })
    expect(asked.inquiry.status).toBe('NEED_INFO')
    await settle()
    const waiting = (await A('GET', `/portal/inquiries/${G.request.id}`)).request
    expect(waiting.state).toMatchObject({ code: 'NEED_INFO', needsYou: true, words: { en: 'We need something from you' } })
    expect((await A('GET', '/portal/inquiries')).counts.needsYou).toBeGreaterThanOrEqual(1)
    const thread = await A('GET', `/portal/threads/Inquiry/${G.request.id}`)
    expect(thread.messages.map((message: Json) => message.body)).toContain('Made-up question: which colour, black or red?')
    await A('POST', `/portal/threads/Inquiry/${G.request.id}/messages`, { body: 'Made-up answer: black, please.' }, 201)
    await settle()
    expect((await ok(P.sales, 'GET', `/sales/inquiries/${G.request.id}`)).inquiry.status).toBe('ASSIGNED')
    expect((await A('GET', `/portal/inquiries/${G.request.id}`)).request.state).toMatchObject({ code: 'BEING_REVIEWED', words: { en: 'Being reviewed' } })
  })

  it('N24 a quote draft follows: the request QUOTED; the customer reads “Quote being prepared” and no quote number', async () => {
    const record = (await ok(P.sales, 'GET', `/sales/inquiries/${G.request.id}`)).inquiry
    const made = await ok(P.sales, 'POST', `/sales/inquiries/${G.request.id}/quote`, { version: record.version }, 201)
    expect(made.inquiry.status).toBe('QUOTED')
    G.quote = made.quote
    expect((await admin<{ status: string }>(w, 'SELECT status FROM "Quote" WHERE id = $1', [G.quote.id]))[0]!.status).toBe('DRAFT')
    await settle()
    const read = (await A('GET', `/portal/inquiries/${G.request.id}`)).request
    expect(read.state).toMatchObject({ code: 'QUOTE_BEING_PREPARED', open: true, words: { en: 'Quote being prepared' } })
    expect(read.made.quote).toBeNull()
    expect(JSON.stringify(read)).not.toContain(G.quote.number)
  })

  it('W05 customer A’s list reads “Your request N”; customer B’s own request reads its own count, untouched by A’s', async () => {
    const mine = (await A('GET', '/portal/inquiries?state=ALL')).rows as Json[]
    const row = mine.find((entry) => entry.id === G.request.id)!
    expect(row.yourNumber.words.en).toBe(`Your request ${G.request.yourNumber.seq}`)
    const before = await ownRequests(P3())
    const theirs = await B('POST', '/portal/inquiries', { subject: 'Made-up: a size chart question', message: BRAND_BETA.message, customerRef: BRAND_BETA.customerRef }, 201)
    expect(theirs.receipt.yourNumber.seq).toBe(before + 1)
    G.betaRequest = theirs.request
    await settle()
  })

  it('L2-G17 the catalogue door’s answer promises no time: confirmBy null, no “working day” in either language', async () => {
    expect(REQUEST_NOTICE.en).not.toMatch(PROMISE)
    const style = (await admin<{ id: string }>(w, 'SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = $2', [w.tenant.id, 'SEED-JKT-02']))[0]!
    const colourway = (await admin<{ id: string }>(w, 'SELECT id FROM "Colourway" WHERE "styleId" = $1 AND code = $2', [style.id, 'BLK']))[0]!
    const made = await A('POST', '/portal/order-requests', { source: 'PICKER', customerRef: BRAND_ALPHA.customerRef }, 201)
    const url = `/portal/order-requests/${made.request.id}`
    const added = await A('POST', `${url}/lines`, { version: made.request.version, lines: [{ styleId: style.id, colourwayId: colourway.id, sizes: [{ size: '50', quantity: 2 }] }] })
    const sent = await A('POST', `${url}/send`, { version: added.request.version })
    expect(sent.sent.confirmBy).toBeNull()
    for (const words of [sent.sent.words.en, sent.sent.words.it, sent.request.notice.en, sent.request.notice.it]) expect(words).not.toMatch(PROMISE)
    await settle()
  })

  it('T00 customer B looks for customer A’s request by every door it has — its list, the record, the thread, the search: nothing', async () => {
    await B('GET', '/portal/inquiries?state=ALL')
    await B('GET', `/portal/inquiries/${G.request.id}`, undefined, 404)
    await B('GET', `/portal/threads/Inquiry/${G.request.id}`, undefined, 404)
    for (const q of [G.office, BRAND_ALPHA.customerRef, 'ten team jackets']) await B('GET', `/portal/search?q=${encodeURIComponent(q)}`)
    await B('GET', '/portal/notifications')
    await B('GET', '/portal/threads')
    await B('GET', `/portal/inquiries/${G.betaRequest.id}`)
  })

  it('T00 the name scan: every answer and mail customer B got holds nothing of customer A', async () => {
    const markers = [...(await markersOf(w, BRAND_ALPHA, P1())), { label: 'request number', text: G.office as string }, { label: 'request id', text: G.request.id as string }]
    expect(markers.length).toBeGreaterThan(10)
    // A search answer repeats what was typed (Beta typed A's number and PO on purpose): its echo is left out of the scan.
    const bodyOf = (entry: Seen) => (entry.url.startsWith('/portal/search') && entry.body && typeof entry.body === 'object' ? { ...(entry.body as Json), query: null, words: null } : entry.body)
    const leaks = seen.filter((entry) => entry.who.startsWith('beta')).flatMap((entry) => findMarkers(bodyOf(entry), markers).map((found) => `${entry.method} ${entry.url} (${entry.status}): ${found}`))
    expect(leaks).toEqual([])
    const addresses = new Set(await addressesOf(w, beta))
    const mails = w.h.ses.mails.filter((mail) => [...mail.to, ...mail.cc, ...mail.bcc].some((address) => addresses.has(address.toLowerCase())))
    expect(mails.flatMap((mail) => findMarkers(mailText(mail.raw), markers).map((found) => `${mail.templateKey}: ${found}`))).toEqual([])
    expect(seen.filter((entry) => entry.who.startsWith('beta')).length).toBeGreaterThan(5)
  })

  it('Z no route answered 500 during the flow', async () => {
    await settle()
    expect(unexpected.map((report) => `${report.context.method} ${report.context.route}: ${report.name}: ${report.message} ${report.stack.slice(0, 3).join(' | ')}`)).toEqual([])
  })
})
