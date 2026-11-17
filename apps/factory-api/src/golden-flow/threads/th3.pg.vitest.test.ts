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
import { admin, ok, person, QUIET, startWorld, type Person, type World } from '../testing/world'
import { DATABASE_FUTURE_MS, oneClock } from '../testing/world'

/**
 * B-TH-054 — GOLDEN FLOW TH-3: INCOMING OVER EVERY DOOR, AND THE COMPOSER IN DEPTH (threads plan TH-3; §0 the brand wall; Owner rule
 * 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production unit, should be able
 * to see it all. And manage it all as well."). On the golden world (every base seed, the real app and sign-in, every outside provider
 * FAKE) with the worker's handlers run in-process, through the HTTP routes:
 *
 *   S    the sales office makes P1 into Brand Alpha (customer A) and P3 into Brand Beta (customer B), each with its portal buyer.
 *   T5   ONE Incoming list (O-SAL-INQ-LIST) over customer A's portal request, its catalogue order and its change request on an
 *        order (B-TH-039): every kind on the ALL and OPEN tiles, each row naming its kind and customer.
 *   T7   a new customer from a prospect's phone request (B-TH-042), then answered by mail (Ask for info).
 *   G    decline with ONE message (B-TH-043): B's request declined with a reply B reads in its portal; "Not an order" sends nothing.
 *   G15  a reply A reads in its portal, with no mail (B-TH-044); undo send (B-TH-048): a mail on A's order taken back in its window —
 *        never sent, never read by A.
 *   N7   a price in the amount field of an office note (B-TH-049): sales (the price grain) reads it, the production manager the note
 *        without it, A neither.
 *   G19/G20 a correction of our portal reply, linked (A reads "corrected below"), a reply that names A's message, a task made from A's
 *        message (B-TH-050).
 *   N10  Customer replies (B-TH-047): A's message on its order waits on us, listed, and counted on Incoming.
 *   T37 / T00 customer B finds none of A's requests, catalogue orders, change requests, orders or messages by any door, and the name
 *        scan over everything B got (answers and mail) holds nothing of A.
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
/** Each brand's portal person is its buyer (sends requests, orders from the catalogue, asks changes) who may write in its threads. */
const BUYER = { roleKey: 'customer-buyer', capabilities: ['comment'] } as const
const PROSPECT = { name: 'Made-up Gina Gamma', company: 'Gamma Made-up Riders', email: 'gina@gamma-riders.example', lawfulBasis: 'LEGITIMATE_INTEREST' }
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
  const style = (await admin<{ id: string }>(w, 'SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = $2', [w.tenant.id, code]))[0]!
  const colourway = (await admin<{ id: string }>(w, 'SELECT id FROM "Colourway" WHERE "styleId" = $1 AND code = $2', [style.id, colour]))[0]!
  return { style: style.id, colourway: colourway.id }
}
const issuesOf = (answer: Json): Json[] => answer.error?.issues ?? []
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([name, item]) => [name, ...keysOf(item)]) : []
const mailsTo = (address: string) => w.h.ses.mails.filter((mail) => [...mail.to, ...mail.cc, ...mail.bcc].some((to) => to.toLowerCase() === address.toLowerCase()))

/** The office gives a portal request its lines (the customer wrote words only). */
async function withLines(inquiryId: string, lines: Json[]): Promise<Json> {
  const record = (await ok(P.sales, 'GET', `/sales/inquiries/${inquiryId}`)).inquiry
  return (await ok(P.sales, 'PATCH', `/sales/inquiries/${inquiryId}`, { version: record.version, lines })).inquiry
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

describe('B-TH-054 golden flow TH-3: Incoming over every door, the composer in depth, behind the brand wall', { timeout: 300_000 }, () => {
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

  it('T5 customer A comes by every door: a portal request, a catalogue order, and a change request on an order made for it', async () => {
    const sent = await A('POST', '/portal/inquiries', { subject: 'Made-up: twenty rain jackets', message: `${BRAND_ALPHA.message}\nTwenty rain jackets, black.`, customerRef: BRAND_ALPHA.customerRef, wantedDate: addDays(today(), 40) }, 201)
    G.request = sent.request
    // The catalogue door.
    const jacket = await styleOf('SEED-JKT-02', 'BLK')
    const made = await A('POST', '/portal/order-requests', { source: 'PICKER', customerRef: BRAND_ALPHA.customerRef }, 201)
    const url = `/portal/order-requests/${made.request.id}`
    const added = await A('POST', `${url}/lines`, { version: made.request.version, lines: [{ styleId: jacket.style, colourwayId: jacket.colourway, sizes: [{ size: '50', quantity: 2 }] }] })
    G.catalogue = (await A('POST', `${url}/send`, { version: added.request.version })).request
    // An order for A, made from a second request; A asks one more piece on it (the change door).
    // END CHECK (fix wave 3c): Brand Alpha orders with its purchase-order number (the order made from the request refuses without one).
    const second = await A('POST', '/portal/inquiries', { subject: 'Made-up: twelve team jackets', message: 'Made-up: twelve jackets in black.', customerRef: BRAND_ALPHA.customerRef }, 201)
    await settle()
    const lined = await withLines(second.request.id, [{ styleId: jacket.style, colourwayId: jacket.colourway, sizes: { '50': 4, '52': 4, '54': 4 } }])
    const ordered = await ok(P.sales, 'POST', `/sales/inquiries/${second.request.id}/order`, { version: lined.version, lines: [{ seq: 10, unitPrice: '165' }] }, 201)
    expect(ordered.order).toMatchObject({ status: 'CONFIRMED' })
    G.order = ordered.order
    await settle()
    const rules = await A('GET', `/portal/sales-orders/${G.order.id}/change-requests/rules`)
    const line = rules.lines[0]
    const size = (line.sizes as Json[]).find((entry) => entry.quantity > 0)!
    G.change = (await A('POST', `/portal/sales-orders/${G.order.id}/change-requests`, { kind: 'CHANGE', cells: [{ lineId: line.lineId, size: size.size, quantity: size.quantity + 1 }], note: 'Made-up: one more, please.' }, 201)).request
    await settle()
  })

  it('T5 ONE Incoming list holds all three doors of customer A on the ALL and OPEN tiles, each row naming its kind and customer', async () => {
    for (const tile of ['ALL', 'OPEN']) {
      const list = await ok(P.sales, 'GET', `/sales/incoming?tile=${tile}&partyId=${P1()}&limit=200`)
      const rows = list.rows as Json[]
      const kindOf = (rowId: string) => rows.find((row) => row.id === rowId)
      expect(kindOf(G.request.id), `${tile} request`).toMatchObject({ kind: 'REQUEST', key: `REQUEST:${G.request.id}`, party: { id: P1() } })
      expect(kindOf(G.catalogue.id), `${tile} catalogue order`).toMatchObject({ kind: 'CATALOGUE_ORDER', party: { id: P1() } })
      expect(kindOf(G.change.id), `${tile} change request`).toMatchObject({ kind: 'CHANGE_REQUEST', party: { id: P1() } })
      expect(list.kinds.REQUEST).toBeGreaterThan(0)
      expect(list.kinds.CATALOGUE_ORDER).toBeGreaterThan(0)
      expect(list.kinds.CHANGE_REQUEST).toBeGreaterThan(0)
    }
  })

  it('T7 a new customer from a prospect’s phone request, then answered by mail (Ask for info)', async () => {
    const { inquiry } = await ok(P.sales, 'POST', '/sales/inquiries', { companyId: companyA(), source: 'PHONE', prospect: PROSPECT, request: 'Made-up: ten jackets for a riding club.' }, 201)
    expect((await ok(P.sales, 'GET', `/sales/inquiries/${inquiry.id}/customer`)).candidates).toEqual([])
    const made = await ok(P.sales, 'POST', `/sales/inquiries/${inquiry.id}/customer`, { version: inquiry.version, make: {} })
    expect(made).toMatchObject({ made: 'CUSTOMER', party: { name: PROSPECT.company } })
    G.gamma = made.party.id
    const asked = await ok(P.sales, 'POST', `/sales/inquiries/${inquiry.id}/ask-info`, { version: made.inquiry.version, message: { body: 'Made-up question: which sizes does the club need?', /* END CHECK (fix wave 3c): a first mail on the thread names its subject */ subject: 'Made-up: your riding club jackets' } })
    expect(asked.inquiry.status).toBe('NEED_INFO')
    await settle()
    expect(mailsTo(PROSPECT.email).some((mail) => mailText(mail.raw).includes('which sizes does the club need'))).toBe(true)
  })

  it('G decline with ONE message: customer B reads our reply in its portal; “Not an order” sends nothing', async () => {
    const sent = await B('POST', '/portal/inquiries', { subject: 'Made-up: three team vests', message: BRAND_BETA.message, customerRef: BRAND_BETA.customerRef }, 201)
    G.betaRequest = sent.request
    await settle()
    const record = (await ok(P.sales, 'GET', `/sales/inquiries/${G.betaRequest.id}`)).inquiry
    expect(record.messageTo).toMatchObject({ via: 'PORTAL' })
    const declined = await ok(P.sales, 'POST', `/sales/inquiries/${G.betaRequest.id}/decline`, { version: record.version, reason: 'CAPACITY', message: { body: 'Made-up: we are full until spring, sorry.' } })
    expect(declined.inquiry.status).toBe('DECLINED')
    await settle()
    const theirs = await B('GET', `/portal/inquiries/${G.betaRequest.id}`)
    expect(theirs.request.state.code).toBe('DECLINED')
    expect(((await B('GET', `/portal/threads/Inquiry/${G.betaRequest.id}`)).messages as Json[]).map((message) => message.body)).toContain('Made-up: we are full until spring, sorry.')
    const other = await B('POST', '/portal/inquiries', { message: 'Made-up: just saying thanks.' }, 201)
    await settle()
    const otherRecord = (await ok(P.sales, 'GET', `/sales/inquiries/${other.request.id}`)).inquiry
    const nothing = await ok(P.sales, 'POST', `/sales/inquiries/${other.request.id}/decline`, { version: otherRecord.version, reason: 'NOT_AN_ORDER', message: { body: 'Made-up.' } }, 409)
    expect(issuesOf(nothing).map((issue) => issue.path)).toContain('refusal/SENDS_NOTHING')
  })

  it('G15 a reply customer A reads in its portal, with no mail; undo send: a mail taken back in its window is never sent, never read', async () => {
    const reply = await ok(P.sales, 'POST', `/threads/SalesOrder/${G.order.id}/replies`, { body: 'Made-up: your jackets leave on Friday.' }, 201)
    expect(reply.message).toMatchObject({ direction: 'OUTBOUND', audience: 'PARTNER', channel: 'PORTAL' })
    G.reply = reply.message.id
    expect(await admin(w, 'SELECT id FROM "EmailOutbound" WHERE "threadId" = $1 AND "messageId" = $2', [reply.thread.id, G.reply])).toEqual([])
    const mail = await ok(P.sales, 'POST', `/threads/SalesOrder/${G.order.id}/emails`, { to: [BRAND_ALPHA.contact.email], subject: 'Made-up: wrong price', body: 'Made-up: the price is wrong in this mail.' }, 201)
    expect(mail.email.undoUntil).toEqual(expect.any(String))
    const taken = await ok(P.sales, 'POST', `/threads/SalesOrder/${G.order.id}/emails/${mail.email.id}/undo`)
    expect(taken.email.status).toBe('WITHDRAWN')
    await settle()
    expect(mailsTo(BRAND_ALPHA.contact.email).filter((sent) => mailText(sent.raw).includes('the price is wrong in this mail'))).toEqual([])
    const portal = await A('GET', `/portal/threads/SalesOrder/${G.order.id}`)
    const bodies = (portal.messages as Json[]).map((message) => message.body)
    expect(bodies).toContain('Made-up: your jackets leave on Friday.')
    expect(bodies).not.toContain('Made-up: the price is wrong in this mail.')
  })

  it('N7 a price in the amount field: sales (the price grain) reads it, the production manager the note without it, customer A neither', async () => {
    const note = await ok(P.sales, 'POST', `/threads/SalesOrder/${G.order.id}/notes`, { body: 'Made-up: agreed by phone, see the amount.', amount: { value: 158_00, currency: 'EUR' } }, 201)
    expect(note.message.amount).toEqual({ value: 15800, currency: 'EUR' })
    G.amountNote = note.message.id
    const managers = ((await ok(P.manager, 'GET', `/threads/SalesOrder/${G.order.id}`)).messages as Json[]).find((message) => message.id === G.amountNote)
    expect(managers?.body).toBe('Made-up: agreed by phone, see the amount.')
    expect(Object.keys(managers ?? {})).not.toContain('amount')
    const portal = await A('GET', `/portal/threads/SalesOrder/${G.order.id}`)
    expect(JSON.stringify(portal)).not.toContain('agreed by phone')
    expect(keysOf(portal)).not.toContain('amount')
  })

  it('G19/G20 a correction of our portal reply (A reads “corrected below”), a reply naming A’s message, a task made from A’s message', async () => {
    const correction = await ok(P.sales, 'POST', `/threads/SalesOrder/${G.order.id}/replies`, { body: 'Made-up: correction — they leave on Monday.', correctsMessageId: G.reply }, 201)
    expect(correction.message.corrects).toMatchObject({ id: G.reply })
    const portal = (await A('GET', `/portal/threads/SalesOrder/${G.order.id}`)).messages as Json[]
    expect(portal.find((message) => message.id === G.reply)?.correctedBy).toMatchObject({ id: correction.message.id })
    expect(portal.find((message) => message.id === correction.message.id)?.corrects).toMatchObject({ id: G.reply })
    const asked = await A('POST', `/portal/threads/SalesOrder/${G.order.id}/messages`, { body: 'Made-up: can you add our logo on the sleeve?' }, 201)
    G.alphaAsk = asked.message.id
    await settle()
    const answered = await ok(P.sales, 'POST', `/threads/SalesOrder/${G.order.id}/replies`, { body: 'Made-up: yes, send us the logo.', replyToMessageId: G.alphaAsk }, 201)
    expect(answered.message.replyTo).toMatchObject({ id: G.alphaAsk, excerpt: 'Made-up: can you add our logo on the sleeve?' })
    const task = await ok(P.sales, 'POST', '/tasks', { title: 'Made-up: logo on the sleeve', record: { type: 'SalesOrder', id: G.order.id }, messageId: G.alphaAsk, assigneeId: null }, 201)
    expect(task.task.messageId).toBe(G.alphaAsk)
    await settle()
  })

  it('N10 Customer replies: customer A’s newest message on its order waits on us — listed, and counted on Incoming', async () => {
    await A('POST', `/portal/threads/SalesOrder/${G.order.id}/messages`, { body: 'Made-up: the logo is in the tech pack.' }, 201)
    await settle()
    const waiting = await ok(P.sales, 'GET', `/threads/waiting?side=CUSTOMER&partyId=${P1()}`)
    expect((waiting.rows as Json[]).find((row) => row.recordId === G.order.id)).toMatchObject({ recordType: 'SalesOrder', party: { id: P1() }, lastMessage: { excerpt: 'Made-up: the logo is in the tech pack.' } })
    const incoming = await ok(P.sales, 'GET', `/sales/incoming?partyId=${P1()}`)
    expect(incoming.counts.CUSTOMER_REPLIES).toBeGreaterThanOrEqual(1)
  })

  it('T37 customer B finds none of A’s requests, catalogue orders, change requests, orders or messages by any door', async () => {
    for (const url of [
      `/portal/inquiries/${G.request.id}`,
      `/portal/order-requests/${G.catalogue.id}`,
      `/portal/sales-orders/${G.order.id}`,
      `/portal/sales-orders/${G.order.id}/change-requests/rules`,
      `/portal/threads/Inquiry/${G.request.id}`,
      `/portal/threads/SalesOrder/${G.order.id}`,
    ]) await B('GET', url, undefined, 404)
    await B('POST', `/portal/threads/SalesOrder/${G.order.id}/messages`, { body: 'Made-up: not mine.' }, 404)
    await B('POST', `/portal/inquiries/${G.request.id}/withdraw`, { version: 1 }, 404)
    expect(((await B('POST', '/threads/unread', { records: [{ recordType: 'Inquiry', recordId: G.request.id }, { recordType: 'SalesOrder', recordId: G.order.id }] })).counts as Json[]).map((count) => count.newCount)).toEqual([0, 0])
    for (const q of [G.order.number, await officeNumber(G.request.id), BRAND_ALPHA.customerRef, 'logo on the sleeve']) await B('GET', `/portal/search?q=${encodeURIComponent(q)}`)
    await B('GET', '/portal/inquiries?state=ALL')
    await B('GET', '/portal/order-requests')
    await B('GET', '/portal/threads')
    await B('GET', '/portal/notifications')
  })

  it('T00 the name scan: nothing B got (answers and mail) holds a name, number, message or id of A', async () => {
    const markers = [
      ...(await markersOf(w, BRAND_ALPHA, P1())),
      { label: 'request number', text: await officeNumber(G.request.id) },
      { label: 'request id', text: G.request.id as string },
      { label: 'order number', text: G.order.number as string },
      { label: 'order id', text: G.order.id as string },
      { label: 'catalogue order id', text: G.catalogue.id as string },
      { label: 'change request id', text: G.change.id as string },
      { label: 'A’s message', text: 'logo on the sleeve' },
      { label: 'our reply to A', text: 'they leave on Monday' },
    ]
    // A search answer repeats what was typed (Beta typed A's numbers on purpose): its echo is left out of the scan. An unread count
    // answers each record asked, as asked (Beta asked for A's ids on purpose: 0, as for an id that does not exist): that echo is left
    // out of the scan, its counts are not.
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
