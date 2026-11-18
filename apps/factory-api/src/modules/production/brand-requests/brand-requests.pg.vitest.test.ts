import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
import { freshGuard } from '../../../platform/auth/portal/testing/portal'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { urgencyWorld, type UrgencyWorld } from '../testing/urgency-world'

/**
 * B-PR-26 — the factory answers its customers' requests (production plan §3 "Brand asks, we decide", "Who answers / sets",
 * "Money: a priced counter-offer is answered only by the brand's Buyer or Admin", "A partly shipped order may still ask to cancel
 * unshipped lines"; §5 Home › Approvals "the one place brand requests are answered"; lead picks L4, L26; review fixes R-05, R-32,
 * R-35; the Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the
 * production unit, should be able to see it all. And manage it all as well.") on the local stack through the real app
 * (../testing/urgency-world.ts): brand A = the seeds' P1, brand B = the threads' second brand, both portals on with the
 * production asks open; A's buyer and Production person, B's buyer signed in by code; office people with two-factor — a sales
 * person and a planner over every customer, a planner limited to B — and the office test sessions for the reads.
 *
 *   PW-H01   the office reads every customer's requests; a person limited to B reads only B's (the list, Today's rows)
 *   PW-H01b  a person limited to B opening A's request (?open=<A's request>: the record, its impact, a refusal, a counter) → 404
 *            in words that name nobody; a customer filter of A → 404
 *   and      refuse with words per kind's permission (403 in words otherwise); a priced counter-offer answered only by A's buyer
 *            (the Production role reads that a price may apply, no fee); yes → Sales' accept carries it out with the counter's
 *            date; no → the request withdrawn; a lapsed counter is refused, never accepted; a batch is one group; Today routes
 *            each kind to its people; a partly shipped order is asked to cancel what is left (closed short at the answer);
 *            B-PR-30a/b: a counter decided for the customer settles as their yes would; B-PR-40 (schema wave 5/5): that yes is
 *            put back while not carried out (the counter then LAPSED: the request refused in words, never accepted), never once
 *            carried out (APPLIED)
 *
 * Every name, address and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/production/brand-requests`.
 */

let world: UrgencyWorld
const NS = 'pr26-brand-requests'
type Json = Record<string, any>
type Office = Awaited<ReturnType<UrgencyWorld['officePerson']>>
type Portal = Awaited<ReturnType<UrgencyWorld['portalPerson']>>
let sales: Office
let planner: Office
let plannerB: Office
let manager: Office
let buyerA: Portal
let productionA: Portal
let buyerB: Portal
const orders = {} as Record<'a1' | 'a2' | 'a3' | 'a4' | 'a5' | 'a6' | 'a7' | 'a8' | 'a9' | 'b1' | 'so1', { orderId: string; lineId: string }>

const admin = <R = Json>(sql: string, values: unknown[] = []) => world.admin<R>(sql, values)
const TODAY = () => businessDate(world.h.clock.now())
const key = () => ({ headers: { 'idempotency-key': `pr26-${newId()}` } })

async function send(person: Office | Portal, method: 'GET' | 'POST', url: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const answer = method === 'GET' ? await person.browser.send('GET', url) : await person.browser.send('POST', url, body, key())
  return { status: answer.status, body: answer.body as Json }
}
async function ok(person: Office | Portal, url: string): Promise<Json> {
  const answer = await send(person, 'GET', url)
  expect(answer.status, `${url}: ${JSON.stringify(answer.body).slice(0, 500)}`).toBe(200)
  return answer.body
}
async function read(session: 'office.all' | 'office.p1' | 'office.p2', url: string, status = 200): Promise<Json> {
  const response = await world.officeApp.inject({ method: 'GET', url, headers: { 'x-test-session': session } })
  expect(response.statusCode, `${session} ${url}: ${response.body.slice(0, 500)}`).toBe(status)
  return response.json() as Json
}
/** The customer asks from its portal (the B-PR-25 route). */
async function ask(person: Portal, orderId: string, body: Json): Promise<Json> {
  const answer = await send(person, 'POST', `/portal/sales-orders/${orderId}/change-requests`, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(201)
  return answer.body.request as Json
}
const outbox = (type: string) => admin<{ payload: Json }>('SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id', [world.ids.tenantId, type])
const todayKeys = async (person: Office) => ((await ok(person, '/home/today?kind=ORDER_CHANGE_REQUEST&limit=200')).items as Json[]).map((item) => String(item.key))
const requestRow = (id: string) => admin<{ status: string; version: number; answer: string | null; counterApprovalId: string | null }>('SELECT status::text AS status, version, answer, "counterApprovalId"::text AS "counterApprovalId" FROM "OrderChangeRequest" WHERE id = $1', [id]).then((rows) => rows[0]!)

beforeAll(async () => {
  world = await urgencyWorld('pr26_brand_requests', NS)
  // Both customers' production asks open (the limits card's list); their urgency is on already (the world's).
  await admin(`UPDATE "PortalSettings" SET "productionAskKinds" = '{HOLD,RESUME,SPLIT_SHIPMENT,SAMPLE_ROUND}', version = version + 1 WHERE "partyId" = ANY($1::uuid[])`, [[world.ids.a, world.ids.b]])
  // B-PR-40: + a9, the counter carried out after a yes (APPLIED).
  for (const name of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'] as const) orders[name] = await world.addOrder(world.ids.a, name.toUpperCase(), '2026-10-01')
  orders.b1 = await world.addOrder(world.ids.b, 'B1', '2026-10-01')
  const so1 = (await admin<{ id: string; lineId: string }>(`SELECT o.id::text AS id, l.id::text AS "lineId" FROM "SalesOrder" o JOIN "SalesOrderLine" l ON l."orderId" = o.id WHERE o."tenantId" = $1 AND o.number = 'SEED-SO-0001' ORDER BY l.seq LIMIT 1`, [world.ids.tenantId]))[0]!
  orders.so1 = { orderId: so1.id, lineId: so1.lineId }
  sales = await world.officePerson('sara.sales@pr26-office.example.com', 'sales')
  planner = await world.officePerson('piero.planner@pr26-office.example.com', 'planner')
  plannerB = await world.officePerson('bianca.planner@pr26-office.example.com', 'planner', [world.ids.b])
  manager = await world.officePerson('marco.manager@pr26-office.example.com', 'production_manager')
  buyerA = await world.portalPerson('anna.buyer@pr26-brand-alpha.example.com', world.ids.a, ['customer-buyer', 'partner-approve'])
  productionA = await world.portalPerson('paolo.production@pr26-brand-alpha.example.com', world.ids.a, ['customer-production', 'partner-approve'])
  buyerB = await world.portalPerson('bea.buyer@pr26-brand-beta.example.com', world.ids.b, ['customer-buyer', 'partner-approve'])
}, 600_000)

beforeEach(() => {
  freshGuard(world.h)
})

afterAll(async () => {
  await world?.close()
})

describe('B-PR-26: the factory answers its customers’ requests', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const ids = {} as Record<'holdA' | 'cancelB' | 'rushA' | 'sampleA', string>

  it('PW-H01 / PW-H01b: every customer’s requests for the office; a person limited to B reads only B’s, and A’s is not found', async () => {
    ids.holdA = (await ask(buyerA, orders.a1.orderId, { kind: 'HOLD', note: 'Made-up: our store opening moved.' })).id
    ids.cancelB = (await ask(buyerB, orders.b1.orderId, { kind: 'CANCEL', reasonCode: 'LEAD_TIME' })).id
    // The office over every customer reads both, each with who answers its kind and what this reader may answer now.
    const all = await read('office.all', '/production/brand-requests')
    const byId = new Map((all.items as Json[]).map((item) => [item.id, item]))
    expect(byId.get(ids.holdA)).toMatchObject({ kind: 'HOLD', status: 'OPEN', party: { id: world.ids.a }, answeredWith: 'production.brand.manage', answeredIn: 'PRODUCTION', waitingOn: 'US', may: { accept: true, refuse: true, counter: true } })
    expect(byId.get(ids.cancelB)).toMatchObject({ kind: 'CANCEL', status: 'OPEN', party: { id: world.ids.b }, answeredWith: 'orders.manage', answeredIn: 'SALES' })
    expect(all.waitingByKind).toEqual(expect.arrayContaining([{ kind: 'HOLD', count: 1 }, { kind: 'CANCEL', count: 1 }]))
    // A planner over every customer may answer the pause, not the cancel (orders.manage is Sales').
    const plannerList = await ok(planner, '/production/brand-requests')
    const seen = new Map((plannerList.items as Json[]).map((item) => [item.id, item]))
    expect(seen.get(ids.holdA)?.may).toMatchObject({ refuse: true, counter: true, counterWithPrice: false })
    expect(seen.get(ids.cancelB)?.may).toMatchObject({ accept: false, refuse: false, counter: false })

    // PW-H01: limited to B, only B's.
    for (const list of [await read('office.p2', '/production/brand-requests?status=ALL'), await ok(plannerB, '/production/brand-requests?status=ALL')]) {
      const shown = (list.items as Json[]).map((item) => item.party.id)
      expect(shown).toContain(world.ids.b)
      expect(shown).not.toContain(world.ids.a)
      expect(JSON.stringify(list)).not.toContain(ids.holdA)
    }
    // PW-H01b: A's request opened by id (Approvals' ?open=) — not found, in words that name nobody.
    for (const url of [`/production/brand-requests/${ids.holdA}`, `/production/brand-requests/${ids.holdA}/impact`]) {
      const answer = await read('office.p2', url, 404)
      expect(JSON.stringify(answer)).not.toMatch(/Seed|Alpha|P1|HOLD/i)
    }
    expect((await send(plannerB, 'POST', `/production/brand-requests/${ids.holdA}/refuse`, { version: 1, answer: 'No.' })).status).toBe(404)
    expect((await send(plannerB, 'POST', `/production/brand-requests/${ids.holdA}/counter`, { version: 1, note: 'Next week?' })).status).toBe(404)
    expect((await requestRow(ids.holdA)).status).toBe('OPEN')
    // A customer filter of A: "Customer not found."
    expect((await read('office.p2', `/production/brand-requests?partyId=${world.ids.a}`, 404)).error.message).toBe('Customer not found.')
    // Today: the row of A's pause is not B's planner's; it is the planner's over every customer.
    expect((await todayKeys(plannerB)).some((value) => value.includes(ids.holdA))).toBe(false)
    expect((await todayKeys(planner)).some((value) => value.includes(ids.holdA))).toBe(true)
  })

  it('Today routes each kind to the people who answer it (plan §3)', async () => {
    ids.rushA = (await ask(buyerA, orders.a2.orderId, { kind: 'RUSH', note: 'Made-up: our season opens early.' })).id
    ids.sampleA = (await ask(buyerA, orders.a6.orderId, { kind: 'SAMPLE_ROUND', lineId: orders.a6.lineId, sampleKind: 'BRAND' })).id
    const plannerKeys = await todayKeys(planner)
    const salesKeys = await todayKeys(sales)
    const has = (keys: string[], id: string) => keys.some((value) => value.endsWith(`:${id}`))
    // production.brand.manage: urgent and pause; not a cancel, a sample round.
    expect([has(plannerKeys, ids.rushA), has(plannerKeys, ids.holdA), has(plannerKeys, ids.cancelB), has(plannerKeys, ids.sampleA)]).toEqual([true, true, false, false])
    // orders.manage and sales.samples.manage: the cancel and the sample round; not urgent, not a pause.
    expect([has(salesKeys, ids.rushA), has(salesKeys, ids.holdA), has(salesKeys, ids.cancelB), has(salesKeys, ids.sampleA)]).toEqual([false, false, true, true])
    const row = ((await ok(planner, '/home/today?kind=ORDER_CHANGE_REQUEST&limit=200')).items as Json[]).find((item) => String(item.key).endsWith(`:${ids.rushA}`))!
    expect(row).toMatchObject({ state: 'RUSH', category: 'APPROVAL', words: { sentence: { key: 'ORDER_CHANGE_REQUEST.RUSH' }, why: { key: 'why.ORDER_CHANGE_REQUEST.production_brand_manage' } } })
  })

  it('refuse: with words the customer reads, by the kind’s permission only; once', async () => {
    // Sales does not answer a pause (production.brand.manage): 403 in words.
    const forbidden = await send(sales, 'POST', `/production/brand-requests/${ids.holdA}/refuse`, { version: 1, answer: 'No.' })
    expect(forbidden.status).toBe(403)
    expect(forbidden.body.error.message).toMatch(/production\.brand\.manage/)
    expect((await send(planner, 'POST', `/production/brand-requests/${ids.holdA}/refuse`, { version: 1, answer: '   ' })).status).toBe(400)
    const refused = await send(planner, 'POST', `/production/brand-requests/${ids.holdA}/refuse`, { version: 1, answer: 'Made-up: the cutting is booked for this week; we cannot pause it.' })
    expect(refused.status, JSON.stringify(refused.body)).toBe(200)
    expect(refused.body.request).toMatchObject({ id: ids.holdA, status: 'REFUSED', answer: 'Made-up: the cutting is booked for this week; we cannot pause it.', waitingOn: null, may: { accept: false, refuse: false, counter: false } })
    expect((await outbox('order_change_request.answered')).map((row) => row.payload).find((payload) => payload.requestId === ids.holdA)).toEqual({ requestId: ids.holdA, orderId: orders.a1.orderId, partyId: world.ids.a, kind: 'HOLD', answer: 'REFUSED', amendmentId: null, orderCancelled: false })
    // The customer reads our words, never who answered.
    const mine = ((await ok(buyerA, `/portal/sales-orders/${orders.a1.orderId}/change-requests`)).items as Json[]).find((item) => item.id === ids.holdA)!
    expect(mine).toMatchObject({ status: 'REFUSED', answer: 'Made-up: the cutting is booked for this week; we cannot pause it.' })
    expect(JSON.stringify(mine)).not.toMatch(/piero|answeredBy/i)
    // Once: a second answer is refused in words.
    const again = await send(planner, 'POST', `/production/brand-requests/${ids.holdA}/refuse`, { version: 2, answer: 'Still no.' })
    expect(again.status).toBe(409)
    expect(again.body.error.issues[0].path).toBe('request/REFUSED')
  })

  it('money: a priced counter-offer only by a person with prices; the Production role reads that a price may apply and cannot answer it', async () => {
    const asked = addDays(TODAY(), 40)
    const offered = addDays(TODAY(), 55)
    const change = await ask(buyerA, orders.so1.orderId, { kind: 'CHANGE', requestedDate: asked, note: 'Made-up: we would like it earlier.' })
    // The planner sees no prices: no fee from them (the contract's money input, or the handler: 403).
    expect((await send(planner, 'POST', `/production/brand-requests/${ids.rushA}/counter`, { version: 1, fee: 1500 })).status).toBe(403)
    // Nothing offered: refused in words; a past date too.
    expect((await send(sales, 'POST', `/production/brand-requests/${change.id}/counter`, { version: 1 })).body.error.issues[0].message).toBe('Say what you offer instead: a date, a price or words.')
    expect((await send(sales, 'POST', `/production/brand-requests/${change.id}/counter`, { version: 1, date: addDays(TODAY(), -1) })).status).toBe(400)
    const countered = await send(sales, 'POST', `/production/brand-requests/${change.id}/counter`, { version: 1, date: offered, fee: 2500, note: 'Made-up: the earlier date needs overtime.' })
    expect(countered.status, JSON.stringify(countered.body)).toBe(200)
    expect(countered.body.request).toMatchObject({ status: 'COUNTERED', waitingOn: 'CUSTOMER', counter: { date: offered, fee: 2500, priced: true, state: 'WAITING' }, may: { accept: false, refuse: false, counter: false } })
    const approvalId = countered.body.approvalRequestId as string
    expect((await outbox('order_change_request.countered')).map((row) => row.payload).find((payload) => payload.requestId === change.id)).toEqual({ requestId: change.id, orderId: orders.so1.orderId, partyId: world.ids.a, kind: 'CHANGE', approvalRequestId: approvalId })
    // The question never names the amount.
    const question = (await admin<{ question: string; kind: string; recordType: string }>('SELECT question, kind::text AS kind, "recordType" FROM "ApprovalRequest" WHERE id = $1', [approvalId]))[0]!
    expect(question).toMatchObject({ kind: 'COUNTER_OFFER', recordType: 'OrderChangeRequest' })
    expect(question.question).not.toMatch(/2500|25[.,]00|€/)

    // The Production role (no price grain): reads the counter-offer and that a price applies; no fee anywhere; cannot answer.
    const page = await ok(productionA, `/portal/approvals/${approvalId}`)
    expect(page.may).toMatchObject({ answer: false, held: 'A price may apply: your buyer answers this counter-offer.' })
    expect(JSON.stringify(page)).not.toMatch(/2500|25[.,]00/)
    const refusedAnswer = await send(productionA, 'POST', `/portal/approvals/${approvalId}/answer`, { decision: 'APPROVED', typedName: 'Paolo Production', version: page.request.version })
    expect(refusedAnswer.status).toBe(403)
    // F-PR-14: the list says so too ("Waiting for your buyer" in Waiting for you); the buyer's list does not; never the amount.
    const productionList = await ok(productionA, '/portal/approvals')
    expect((productionList.items as Json[]).find((item) => item.id === approvalId)).toMatchObject({ kind: 'COUNTER_OFFER', waitingFor: null, waitingForBuyer: true })
    expect(JSON.stringify(productionList)).not.toMatch(/2500|25[.,]00/)
    expect(((await ok(buyerA, '/portal/approvals')).items as Json[]).find((item) => item.id === approvalId)).toMatchObject({ waitingForBuyer: false })
    const productionView = ((await ok(productionA, `/portal/sales-orders/${orders.so1.orderId}/change-requests`)).items as Json[]).find((item) => item.id === change.id)!
    expect(productionView.counter).toMatchObject({ priced: true, state: 'WAITING', date: offered })
    expect('fee' in productionView.counter).toBe(false)
    // The buyer reads the fee (prices) and may answer; the order page does not withdraw a countered request.
    const buyerView = ((await ok(buyerA, `/portal/sales-orders/${orders.so1.orderId}/change-requests`)).items as Json[]).find((item) => item.id === change.id)!
    expect(buyerView.counter).toMatchObject({ fee: 2500, priced: true, words: { en: 'Our counter-offer waits for your answer' } })
    expect((await send(buyerA, 'POST', `/portal/sales-orders/${orders.so1.orderId}/change-requests/${change.id}/withdraw`, { version: 2 })).status).toBe(409)
    expect((await ok(buyerA, `/portal/approvals/${approvalId}`)).may).toMatchObject({ answer: true })

    // Yes: the request stays COUNTERED (agreed) and comes back to Sales; its accept carries it out with the counter's date.
    const yes = await send(buyerA, 'POST', `/portal/approvals/${approvalId}/answer`, { decision: 'APPROVED', typedName: 'Anna Buyer', version: page.request.version })
    expect(yes.status, JSON.stringify(yes.body)).toBe(200)
    expect((await requestRow(change.id)).status).toBe('COUNTERED')
    expect((await outbox('order_change_request.counter_answered')).map((row) => row.payload).find((payload) => payload.requestId === change.id)).toMatchObject({ answer: 'ACCEPTED', kind: 'CHANGE' })
    const agreed = (await read('office.all', `/production/brand-requests/${change.id}`)).request
    expect(agreed).toMatchObject({ status: 'COUNTERED', waitingOn: 'US', counter: { state: 'AGREED' }, may: { accept: true, refuse: false, counter: false } })
    expect((await todayKeys(sales)).some((value) => value.endsWith(`:${change.id}`))).toBe(true)
    // Not refused after the yes; accepted by Sales (orders.manage), the order's date becomes the counter's.
    expect((await send(sales, 'POST', `/production/brand-requests/${change.id}/refuse`, { version: agreed.version, answer: 'No.' })).body.error.issues[0].path).toBe('request/COUNTER_AGREED')
    const accepted = await send(sales, 'POST', `/sales/change-requests/${change.id}/accept`, { version: agreed.version })
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)
    expect(accepted.body.request.status).toBe('ACCEPTED')
    expect((await admin<{ day: string }>(`SELECT to_char("requestedDate", 'YYYY-MM-DD') AS day FROM "SalesOrder" WHERE id = $1`, [orders.so1.orderId]))[0]!.day).toBe(offered)
  })

  it('no: an unpriced counter answered by the Production role withdraws the request; the customer’s words stay on the approval', async () => {
    const cancel = await ask(buyerA, orders.a3.orderId, { kind: 'CANCEL', reasonCode: 'LEAD_TIME' })
    const countered = await send(sales, 'POST', `/production/brand-requests/${cancel.id}/counter`, { version: 1, note: 'Made-up: we can cancel the second half only.' })
    expect(countered.status, JSON.stringify(countered.body)).toBe(200)
    expect(countered.body.request.counter).toMatchObject({ priced: false, note: 'Made-up: we can cancel the second half only.' })
    const approvalId = countered.body.approvalRequestId as string
    const page = await ok(productionA, `/portal/approvals/${approvalId}`)
    expect(page.may.answer).toBe(true)
    // F-PR-14: an unpriced counter waits for nobody in particular: the Production role answers it from Waiting for you.
    expect(((await ok(productionA, '/portal/approvals')).items as Json[]).find((item) => item.id === approvalId)).toMatchObject({ kind: 'COUNTER_OFFER', waitingForBuyer: false })
    const no = await send(productionA, 'POST', `/portal/approvals/${approvalId}/answer`, { decision: 'REFUSED', answer: 'Made-up: we need the whole order cancelled.', typedName: 'Paolo Production', version: page.request.version })
    expect(no.status, JSON.stringify(no.body)).toBe(200)
    expect((await requestRow(cancel.id)).status).toBe('WITHDRAWN')
    expect((await outbox('order_change_request.counter_answered')).map((row) => row.payload).find((payload) => payload.requestId === cancel.id)).toEqual({ requestId: cancel.id, orderId: orders.a3.orderId, partyId: world.ids.a, kind: 'CANCEL', answer: 'REFUSED' })
    const seen = ((await ok(buyerA, `/portal/sales-orders/${orders.a3.orderId}/change-requests`)).items as Json[]).find((item) => item.id === cancel.id)!
    expect(seen).toMatchObject({ status: 'WITHDRAWN', counter: { state: 'REFUSED' } })
    expect((await admin<{ answer: string }>('SELECT answer FROM "ApprovalRequest" WHERE id = $1', [approvalId]))[0]!.answer).toBe('Made-up: we need the whole order cancelled.')
    // The order was not cancelled.
    expect((await admin<{ status: string }>('SELECT status::text AS status FROM "SalesOrder" WHERE id = $1', [orders.a3.orderId]))[0]!.status).toBe('CONFIRMED')
  })

  it('a lapsed counter-offer is refused with words, never accepted; a resume is never countered', async () => {
    const countered = await send(planner, 'POST', `/production/brand-requests/${ids.rushA}/counter`, { version: 1, date: addDays(TODAY(), 20) })
    expect(countered.status, JSON.stringify(countered.body)).toBe(200)
    // Nobody answered by the due time (the sweep's expiry, planted).
    await world.replica([{ sql: `UPDATE "ApprovalRequest" SET status = 'EXPIRED', version = version + 1 WHERE id = $1`, values: [countered.body.approvalRequestId] }])
    const lapsed = (await ok(planner, `/production/brand-requests/${ids.rushA}`)).request
    expect(lapsed).toMatchObject({ status: 'COUNTERED', waitingOn: 'US', counter: { state: 'LAPSED' }, may: { accept: false, refuse: true, counter: false } })
    expect(((await ok(planner, '/home/today?kind=ORDER_CHANGE_REQUEST&limit=200')).items as Json[]).find((item) => String(item.key).endsWith(`:${ids.rushA}`))).toMatchObject({ state: 'COUNTER_LAPSED', words: { sentence: { key: 'ORDER_CHANGE_REQUEST.LAPSED' } } })
    expect((await send(planner, 'POST', `/production/brand-requests/${ids.rushA}/counter`, { version: lapsed.version, note: 'Again?' })).body.error.issues[0].path).toBe('request/COUNTER_LAPSED')
    const refused = await send(planner, 'POST', `/production/brand-requests/${ids.rushA}/refuse`, { version: lapsed.version, answer: 'Made-up: the plan is full until the date we offered.' })
    expect(refused.status, JSON.stringify(refused.body)).toBe(200)
    expect(refused.body.request.status).toBe('REFUSED')
  })

  it('a batch (one customer, one kind) reads as one group: the list by batch, one Today row', async () => {
    const batchId = newId()
    const at = world.h.clock.now()
    for (const name of ['a4', 'a5'] as const) {
      // Asked in the customer's own scope with one batch id, as the bulk ask writes them (B-PR-46a).
      await world.h.database.withScope({ audience: 'partner', tenantId: world.ids.tenantId, actorId: buyerA.id, partyId: world.ids.a }, (client) =>
        client.orderChangeRequest.create({ data: { id: newId(), companyId: world.w.companyId, partyId: world.ids.a, orderId: orders[name].orderId, kind: 'HOLD', reason: 'Made-up: the season is late.', batchId, createdAt: at, updatedAt: at, createdById: buyerA.id }, select: { id: true } }),
      )
    }
    const batch = await ok(planner, `/production/brand-requests?batchId=${batchId}`)
    expect(batch.items).toHaveLength(2)
    for (const item of batch.items as Json[]) expect(item).toMatchObject({ kind: 'HOLD', batchId, batch: { id: batchId, count: 2, waiting: 2 } })
    const record = await ok(planner, `/production/brand-requests/${(batch.items as Json[])[0]!.id}`)
    expect(record.batch).toHaveLength(1)
    const rows = ((await ok(planner, '/home/today?kind=ORDER_CHANGE_REQUEST&limit=200')).items as Json[]).filter((item) => String(item.key).endsWith(`:batch:${batchId}`))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ words: { sentence: { key: 'ORDER_CHANGE_REQUEST.BATCH_HOLD', params: { count: 2 } } } })
    // B's planner reads none of it.
    expect((await ok(plannerB, `/production/brand-requests?batchId=${batchId}`)).items).toEqual([])
  })

  it('the office impact: what the customer saw at Send and the same read now; the order’s work orders by the wall', async () => {
    const impact = await ok(sales, `/production/brand-requests/${ids.sampleA}/impact`)
    expect(impact.request).toMatchObject({ id: ids.sampleA, kind: 'SAMPLE_ROUND', status: 'OPEN' })
    expect(impact.now).toMatchObject({ kind: 'SAMPLE_ROUND', priced: false })
    expect(impact.cancelFee).toBeNull()
    expect(impact.workOrdersNotShown).toBe(0)
    expect((await read('office.p2', `/production/brand-requests/${ids.sampleA}/impact`, 404)).error.message).toBe('Change request not found.')
  })

  it('a partly shipped order is asked to cancel what is left; its accept closes those lines short (nothing shipped: refused in words)', async () => {
    await world.replica([{ sql: `UPDATE "SalesOrder" SET status = 'PARTLY_SHIPPED', version = version + 1 WHERE id = $1`, values: [orders.a7.orderId] }])
    const rules = await ok(buyerA, `/portal/sales-orders/${orders.a7.orderId}/change-requests/rules`)
    expect(rules.cancel.possible).toBe(true)
    expect(rules.change.code).toBe('NOT_ASKABLE')
    const cancel = await ask(buyerA, orders.a7.orderId, { kind: 'CANCEL', reasonCode: 'LEAD_TIME' })
    expect(cancel).toMatchObject({ kind: 'CANCEL', wholeOrder: true, status: 'OPEN' })
    // The accept closes the rest short (W2a's close of lines): an order that shipped nothing would be left empty, so it says no.
    const record = await ok(sales, `/sales/change-requests/${cancel.id}`)
    expect(record.preview).toMatchObject({ ok: false, cancel: null, problems: [{ path: 'body/lineIds', message: 'Nothing has shipped: closing every line would leave an empty order. Cancel the order instead.' }] })
  })

  it('B-PR-30a/b: a counter-offer decided for the customer settles as their yes; B-PR-40: the yes put back before our accept (then refused, never accepted), never once carried out', async () => {
    const counterOn = async (orderId: string) => {
      const cancel = await ask(buyerA, orderId, { kind: 'CANCEL', reasonCode: 'LEAD_TIME' })
      const countered = await send(sales, 'POST', `/production/brand-requests/${cancel.id}/counter`, { version: 1, note: 'Made-up: we cancel it now, the fabric goes back to stock.' })
      expect(countered.status, JSON.stringify(countered.body)).toBe(200)
      return { cancel, approvalId: countered.body.approvalRequestId as string }
    }
    const versionOf = async (approvalId: string) => (await admin<{ version: number }>('SELECT version FROM "ApprovalRequest" WHERE id = $1', [approvalId]))[0]!.version
    // Decided by us for the customer (production.brand.override, a fresh code): the settle takes it as the customer's yes.
    const decideFor = async (approvalId: string) => {
      await manager.stepUp()
      const decided = await send(manager, 'POST', `/approvals-out/${approvalId}/decide-for-party`, { version: await versionOf(approvalId), decision: 'APPROVED', typedName: 'Marco Manager', reason: 'Made-up: agreed with the customer on the phone.' })
      expect(decided.status, JSON.stringify(decided.body)).toBe(200)
    }
    const first = await counterOn(orders.a8.orderId)
    await decideFor(first.approvalId)
    expect((await requestRow(first.cancel.id)).status).toBe('COUNTERED')
    expect((await outbox('order_change_request.counter_answered')).map((row) => row.payload).find((payload) => payload.requestId === first.cancel.id)).toMatchObject({ answer: 'ACCEPTED' })
    expect((await ok(sales, `/production/brand-requests/${first.cancel.id}`)).request).toMatchObject({ counter: { state: 'AGREED' }, may: { accept: true, refuse: false } })
    // B-PR-40: the yes is put back while the request waits for our accept (only marked: nothing was carried out).
    await manager.stepUp()
    const putBack = await send(manager, 'POST', `/approvals-out/${first.approvalId}/reverse`, { version: await versionOf(first.approvalId), reason: 'Made-up: put back.' })
    expect(putBack.status, JSON.stringify(putBack.body)).toBe(200)
    expect(putBack.body).toMatchObject({ override: { outcome: 'DONE' }, effects: ['MARK_ONLY'] })
    // A yes put back is no yes: the counter lapsed, the request is ours to refuse in words and never to accept (the database too).
    const lapsed = (await ok(sales, `/production/brand-requests/${first.cancel.id}`)).request
    expect(lapsed).toMatchObject({ status: 'COUNTERED', waitingOn: 'US', counter: { state: 'LAPSED' }, may: { accept: false, refuse: true, counter: false } })
    const notAccepted = await send(sales, 'POST', `/sales/change-requests/${first.cancel.id}/accept`, { version: lapsed.version })
    expect(notAccepted.status).not.toBe(200)
    expect(notAccepted.body.error.issues[0].path).toBe('request/COUNTER_LAPSED')
    await expect(admin(`UPDATE "OrderChangeRequest" SET status = 'ACCEPTED', "answeredAt" = now(), "answeredById" = "counteredById", version = version + 1 WHERE id = $1`, [first.cancel.id])).rejects.toThrow(/a yes we did not put back/)
    const refused = await send(sales, 'POST', `/production/brand-requests/${first.cancel.id}/refuse`, { version: lapsed.version, answer: 'Made-up: we keep the order as it is.' })
    expect(refused.status, JSON.stringify(refused.body)).toBe(200)
    expect(await requestRow(first.cancel.id)).toMatchObject({ status: 'REFUSED', answer: 'Made-up: we keep the order as it is.' })
    // Put back once.
    await manager.stepUp()
    expect((await send(manager, 'POST', `/approvals-out/${first.approvalId}/reverse`, { version: await versionOf(first.approvalId), reason: 'Made-up: again.' })).body.error.issues.at(-1).path).toBe('refusal/REVERSED')

    // Carried out by Sales' accept: the yes can no longer be put back (APPLIED, B-PR-30b's rule).
    const second = await counterOn(orders.a9.orderId)
    await decideFor(second.approvalId)
    const accepted = await send(sales, 'POST', `/sales/change-requests/${second.cancel.id}/accept`, { version: (await requestRow(second.cancel.id)).version })
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)
    await manager.stepUp()
    const applied = await send(manager, 'POST', `/approvals-out/${second.approvalId}/reverse`, { version: await versionOf(second.approvalId), reason: 'Made-up: put back.' })
    expect(applied.status).toBe(409)
    expect(applied.body.error.issues.at(-1).path).toBe('refusal/APPLIED')
  })
})
