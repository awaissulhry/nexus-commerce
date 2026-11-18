import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { ASKED_ONLY_FROM_REPROMISE, CUSTOMER_ACCEPTED_ACTION, CUSTOMER_REFUSED_ACTION, NEWER_DATE_WORDS } from '@nexus/factory-domain/planning/promise-keep/brand-answer'
import { PROMISE_REASON_WORDS } from '@nexus/factory-domain/sales/portal-orders/promise' // fix-pr-5
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCalendar } from '../../../../../../packages/factory-db/seed/calendar'
import { callerFor } from '../../../core/command'
import { freshGuard } from '../../../platform/auth/portal/testing/portal'
import { systemContext } from '../../../platform/outbox/system'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { keeperPlanningContext, readOrderProductionFacts } from '../../production/brand/facts'
import { ordersOfEvent } from '../../production/brand/keeper'
import { urgencyWorld, type UrgencyWorld } from '../../production/testing/urgency-world'

/**
 * B-PR-28 — the customer answers a new promise date (production plan §3 "Brand alone: accept or refuse a new date", plain rule "A
 * brand's 'no' to a new date does not undo the date (capacity is shared). It sets 'waiting on us' and tells us."; 08-backend §4.3;
 * the Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production
 * unit, should be able to see it all. And manage it all as well.") on the local stack through the real app (the production
 * two-brand world of ../../production/testing/urgency-world.ts: brand A = the seeds' P1, brand B = the threads' second brand,
 * both portals on; the calendar seed for planning's working days):
 *
 *   ask       planning proposes a new date for brand A's order line (office.all); sales accepts it asking the customer
 *             (office.p1, `askBrand`): the promise is given as always and a REPROMISE approval waits on A's order (its question
 *             in A's words, its partner task); the order waits on the customer; the generic "Ask for approval" never offers or
 *             asks a new date
 *   refused   A's Production person refuses it with words in its portal: the date STANDS (its promise row stays), the words land
 *             on the order's thread, a follow-up task for A's supervisor (its id = the request's) — and the order waits on us
 *             until the task is closed; the proposal shows the answer
 *   accepted  a second new date accepted by A: the order's timeline says so; no follow-up
 *   newer     a newer date of the same line asked while one waits: the older question is withdrawn (its partner task too)
 *   PW-P05    brand B's portal lists only B's requests: A's request id → 404 to read and to answer; office.p2 (limited to B)
 *             reads neither A's request nor its proposal
 *
 * Every name, address and number is made up (example.com). Run with
 * `node scripts/factory/run-pg-tests.mjs modules/planning/promise-keep`.
 */

let world: UrgencyWorld
const NS = 'pr3e-repromise-brand'
type Json = Record<string, any>
type Person = Awaited<ReturnType<UrgencyWorld['portalPerson']>>
let anna: Person
let beatrice: Person
let owner: Awaited<ReturnType<UrgencyWorld['officePerson']>>
let sue: Awaited<ReturnType<UrgencyWorld['officePerson']>>
let order = { orderId: '', number: '', lineId: '' }
let today = ''
let refusedRequest = ''
let refusedProposal = ''
/** fix-pr-10: the question the first test asks. A later test that reads it fails in these words when the first one failed (before, it
 * called /portal/approvals/ with an empty id and read a 400). */
function firstQuestion(): string {
  expect(refusedRequest, 'the first test asks the new date this test reads (it failed: see above)').not.toBe('')
  return refusedRequest
}

const admin = <R = Json>(sql: string, values: unknown[] = []) => world.admin<R>(sql, values)
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const system = () => callerFor(world.h.database, systemContext(world.ids.tenantId, newId()))
const factsOf = (orderId: string) => system().withClient((client) => readOrderProductionFacts(client, keeperPlanningContext(world.ids.tenantId, 'test'), orderId, new Date(), { health: false }))
const outbox = (type: string) => admin<{ payload: Json }>('SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id', [world.ids.tenantId, type])

async function office(session: 'office.all' | 'office.p1' | 'office.p2', method: 'GET' | 'POST', url: string, status = 200, body?: unknown): Promise<Json> {
  const response = await world.officeApp.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'POST' ? { 'idempotency-key': `pr3e-${newId()}` } : {}) }, ...(method === 'POST' ? { payload: (body ?? {}) as object } : {}) })
  expect(response.statusCode, `${session} ${method} ${url}: ${response.body.slice(0, 600)}`).toBe(status)
  return response.json() as Json
}
async function as(browser: Person['browser'], method: 'GET' | 'POST', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await browser.send(method as never, url, method === 'GET' ? undefined : (body ?? {}), { headers: method === 'GET' ? {} : { 'idempotency-key': `pr3e-${newId()}` } })
  expect(answer.status, `${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return answer.body as Json
}

/** Planning proposes a new date for a size of the order's line; sales (another person) accepts it, asking the customer. */
async function newDateAsked(size: string, days: number): Promise<{ proposalId: string; requestId: string; to: string }> {
  const to = plusDays(today, days)
  const { proposal } = await office('office.all', 'POST', `/planning/promises/order-lines/${order.lineId}/re-promise`, 200, { sizes: [{ size, date: to }], reasonCode: 'CAPACITY' })
  const accepted = await office('office.p1', 'POST', `/planning/promises/re-promises/${proposal.id}/accept`, 200, { tell: false, askBrand: true })
  expect(accepted).toMatchObject({ told: false, proposal: { state: 'ACCEPTED', customerAnswer: { state: 'WAITING' } }, brandAsk: { requestId: expect.any(String) } })
  return { proposalId: proposal.id, requestId: accepted.brandAsk.requestId, to }
}

beforeAll(async () => {
  world = await urgencyWorld('pr3e_repromise_brand', NS)
  await seedCalendar({ db: world.h.database, namespace: NS })
  today = businessDate(new Date(), 'Europe/Rome')
  owner = await world.officePerson('olga.owner@pr3e-office.example.com', 'owner')
  sue = await world.officePerson('sue.supervisor@pr3e-office.example.com', 'production_manager')
  anna = await world.portalPerson('anna.production@brand-alpha.example.com', world.ids.a, ['customer-production', 'partner-approve'])
  beatrice = await world.portalPerson('beatrice.buyer@brand-beta.example.com', world.ids.b, ['customer-buyer', 'partner-approve'])
  // Brand A's order of one goods line at the world's plant, promised for 20 Dec (addOrder); Sue supervises brand A's orders.
  order = await world.addOrder(world.ids.a, 'RP', '2026-11-01')
  await world.replica([{ sql: 'UPDATE "SalesOrderLine" SET "siteId" = $1 WHERE id = $2', values: [world.w.siteId, order.lineId] }])
  await admin('UPDATE "PortalSettings" SET "productionSupervisorId" = $1, "productionSupervisorSetAt" = now(), version = version + 1 WHERE id = $2', [sue.id, world.ids.a])
}, 600_000)

beforeEach(() => {
  freshGuard(world.h)
})

afterAll(async () => {
  await world?.close()
}, 60_000)

describe('B-PR-28 sales accepts a new date asking the customer', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('the date is given as always and a REPROMISE question waits on the order: in the customer’s words, its task, the order waits on it', async () => {
    const asked = await newDateAsked('50', 30)
    refusedRequest = asked.requestId
    refusedProposal = asked.proposalId
    // The promise is given (the date stands, whatever the answer): the RE_PROMISE row of size 50.
    expect(await one<{ n: number }>(`SELECT count(*)::int AS n FROM "PromiseRecord" WHERE "salesOrderLineId" = $1 AND size = '50' AND kind = 'RE_PROMISE' AND "promisedDate" = $2::date`, [order.lineId, asked.to])).toEqual({ n: 1 })
    // The question: a REPROMISE on the sales order, the customer's, OPEN; its partner task and link; one event.
    const request = await one(`SELECT kind::text AS kind, "recordType", "recordId", "partyId", status::text AS status, question FROM "ApprovalRequest" WHERE id = $1`, [asked.requestId])
    expect(request).toMatchObject({ kind: 'REPROMISE', recordType: 'SalesOrder', recordId: order.orderId, partyId: world.ids.a, status: 'OPEN' })
    expect(request.question).toMatch(new RegExp(`(New date for order|Nuova data per l'ordine) ${order.number}`))
    expect(await one<{ n: number }>(`SELECT count(*)::int AS n FROM "PartnerTask" WHERE "sourceKey" = $1 AND status = 'OPEN'`, [`ApprovalRequest:${asked.requestId}`])).toEqual({ n: 1 })
    expect(await one<{ n: number }>(`SELECT count(*)::int AS n FROM "OneOffLink" WHERE purpose = 'APPROVAL' AND "recordId" = $1 AND "revokedAt" IS NULL`, [asked.requestId])).toEqual({ n: 1 })
    expect((await outbox('approval_request.asked')).map((row) => row.payload).filter((payload) => payload.requestId === asked.requestId)).toEqual([
      expect.objectContaining({ kind: 'REPROMISE', recordType: 'SalesOrder', recordId: order.orderId, partyId: world.ids.a, files: 0 }),
    ])
    // The order waits on the customer while the question is open.
    expect((await factsOf(order.orderId))!.waiting.on).toBe('BRAND')
  })

  it('the generic "Ask for approval" never offers or asks a new date (refused in words)', async () => {
    firstQuestion() // fix-pr-10
    const record = await as(owner.browser, 'GET', `/approvals-out?recordType=SalesOrder&recordId=${order.orderId}`)
    expect(record.kinds).not.toContain('REPROMISE')
    expect((record.requests as Json[]).map((entry) => entry.id)).toContain(refusedRequest)
    const refused = await as(owner.browser, 'POST', '/approvals-out', { kind: 'REPROMISE', recordType: 'SalesOrder', recordId: order.orderId, question: 'Made-up: accept the new date?', send: false }, 409)
    expect(refused.error.message).toBe(ASKED_ONLY_FROM_REPROMISE)
  })

  it('wall (PW-P05): brand B lists only its own requests; A’s request id → 404 to read and to answer; office.p2 reads neither', async () => {
    firstQuestion() // fix-pr-10
    const list = await as(beatrice.browser, 'GET', '/portal/approvals')
    expect((list.items as Json[]).map((item) => item.id)).not.toContain(refusedRequest)
    expect(JSON.stringify(list)).not.toContain(order.number)
    await as(beatrice.browser, 'GET', `/portal/approvals/${refusedRequest}`, undefined, 404)
    await as(beatrice.browser, 'POST', `/portal/approvals/${refusedRequest}/answer`, { decision: 'REFUSED', answer: 'Made-up.', typedName: 'Beatrice Beta', version: 1 }, 404)
    await office('office.p2', 'GET', `/approvals-out/${refusedRequest}`, 404)
    await office('office.p2', 'GET', `/planning/promises/re-promises/${refusedProposal}`, 404)
    expect((await one<{ status: string }>('SELECT status::text AS status FROM "ApprovalRequest" WHERE id = $1', [refusedRequest])).status).toBe('OPEN')
  })

  it('A refuses with words: the date stands, its words on the order’s thread, a follow-up task for A’s supervisor; the order waits on us', async () => {
    firstQuestion() // fix-pr-10
    const before = await one<{ n: number }>('SELECT count(*)::int AS n FROM "PromiseRecord" WHERE "salesOrderLineId" = $1', [order.lineId])
    const page = await as(anna.browser, 'GET', `/portal/approvals/${refusedRequest}`)
    expect(page.request).toMatchObject({ kind: 'REPROMISE', status: 'OPEN' })
    expect(page.may).toMatchObject({ answer: true, withChanges: false })
    expect((page.content.facts as Json[]).map((fact) => fact.label)).toEqual(['Order', 'Line', 'Size 50', 'Reason', 'Please note'])
    // fix-pr-5: the reason it reads is the customer's curated list (sales/portal-orders PROMISE_REASON_WORDS: "Production capacity"
    // for the CAPACITY asked here), never a figure of ours; the rest names no minutes, lane, load, capacity or other customer.
    const shown = JSON.stringify(page).replaceAll(PROMISE_REASON_WORDS.CAPACITY.en, '').replaceAll(PROMISE_REASON_WORDS.CAPACITY.it, '')
    expect(shown).not.toMatch(/\bminutes\b|\blanes?\b|\bload\b|capacity|Brand Beta|SEED-SO-B/i)
    // A refusal says why (the engine's rule).
    await as(anna.browser, 'POST', `/portal/approvals/${refusedRequest}/answer`, { decision: 'REFUSED', answer: '', typedName: 'Anna Alpha', version: 1 }, 400)
    await as(anna.browser, 'POST', `/portal/approvals/${refusedRequest}/answer`, { decision: 'REFUSED', answer: 'Too late for our shop opening.', typedName: 'Anna Alpha', version: 1 })

    // The date stands: no promise row went or came.
    expect(await one<{ n: number }>('SELECT count(*)::int AS n FROM "PromiseRecord" WHERE "salesOrderLineId" = $1', [order.lineId])).toEqual(before)
    // Their words on the order's thread (the engine's settle).
    const message = await one<{ n: number }>(`SELECT count(*)::int AS n FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordType" = 'SalesOrder' AND t."recordId" = $1 AND m."bodyText" LIKE '%Too late for our shop opening.%'`, [order.orderId])
    expect(message.n).toBe(1)
    // The follow-up for us: its id is the request's, on the order, Sue's (the bell: task.assigned), open.
    const task = await one(`SELECT "recordType", "recordId", "assigneeId", status::text AS status, title, description FROM "Task" WHERE id = $1`, [refusedRequest])
    expect(task).toMatchObject({ recordType: 'SalesOrder', recordId: order.orderId, assigneeId: sue.id, status: 'OPEN', title: `The customer did not accept the new date: ${order.number} line 10` })
    expect(task.description).toContain('Their words: “Too late for our shop opening.”')
    expect((await outbox('task.assigned')).map((row) => row.payload).find((payload) => payload.taskId === refusedRequest)).toMatchObject({ assigneeId: sue.id, recordType: 'SalesOrder', recordId: order.orderId })
    expect((await admin<{ action: string }>('SELECT action FROM "AuditLog" WHERE "recordType" = $1 AND "recordId" = $2', ['SalesOrder', order.orderId])).map((row) => row.action)).toContain(CUSTOMER_REFUSED_ACTION)
    // The order waits on us while the follow-up is open, since the answer; the keeper follows the task's events.
    const answeredAt = (await one<{ at: Date }>('SELECT "answeredAt" AS at FROM "ApprovalRequest" WHERE id = $1', [refusedRequest])).at
    expect((await factsOf(order.orderId))!.waiting).toEqual({ on: 'US', since: answeredAt })
    const event = { type: 'task.created', payload: { taskId: refusedRequest, recordType: 'SalesOrder', recordId: order.orderId, assigneeId: sue.id } }
    expect(await system().withClient((client) => ordersOfEvent(client, event))).toEqual({ orderIds: [order.orderId], hold: null })
    expect(await system().withClient((client) => ordersOfEvent(client, { ...event, payload: { ...event.payload, taskId: newId() } }))).toEqual({ orderIds: [], hold: null })
    // Planning's proposal shows the answer.
    const proposal = await office('office.all', 'GET', `/planning/promises/re-promises/${refusedProposal}`)
    expect(proposal.customerAnswer).toMatchObject({ requestId: refusedRequest, state: 'REFUSED', answer: 'Too late for our shop opening.', typedName: 'Anna Alpha', followUp: { taskId: refusedRequest, status: 'OPEN' } })
    // Handled (the task closed): the order no longer waits on us for it.
    await admin(`UPDATE "Task" SET status = 'DONE', "closedAt" = now(), "closedById" = $2, version = version + 1 WHERE id = $1`, [refusedRequest, sue.id])
    expect((await factsOf(order.orderId))!.waiting.since).toBeNull()
  })

  it('A accepts a second new date: the order’s timeline says so, no follow-up; a newer date of the same line withdraws the older question', async () => {
    const accepted = await newDateAsked('52', 35)
    await as(anna.browser, 'POST', `/portal/approvals/${accepted.requestId}/answer`, { decision: 'APPROVED', typedName: 'Anna Alpha', version: 1 })
    expect((await admin<{ action: string }>('SELECT action FROM "AuditLog" WHERE "recordType" = $1 AND "recordId" = $2', ['SalesOrder', order.orderId])).map((row) => row.action)).toContain(CUSTOMER_ACCEPTED_ACTION)
    expect(await admin('SELECT id FROM "Task" WHERE id = $1', [accepted.requestId])).toEqual([])
    expect((await office('office.all', 'GET', `/planning/promises/re-promises/${accepted.proposalId}`)).customerAnswer).toMatchObject({ requestId: accepted.requestId, state: 'ACCEPTED', followUp: null })

    // Two newer dates of size 50 in a row: the first question is withdrawn by the second (its task cancelled, its link revoked).
    const first = await newDateAsked('50', 40)
    const second = await newDateAsked('50', 45)
    expect(await one(`SELECT status::text AS status, "withdrawReason" AS reason FROM "ApprovalRequest" WHERE id = $1`, [first.requestId])).toEqual({ status: 'WITHDRAWN', reason: NEWER_DATE_WORDS })
    expect(await one<{ status: string }>(`SELECT status::text AS status FROM "PartnerTask" WHERE "sourceKey" = $1`, [`ApprovalRequest:${first.requestId}`])).toEqual({ status: 'CANCELLED' })
    expect(await one<{ n: number }>(`SELECT count(*)::int AS n FROM "OneOffLink" WHERE "recordId" = $1 AND "revokedAt" IS NULL`, [first.requestId])).toEqual({ n: 0 })
    expect((await one<{ status: string }>('SELECT status::text AS status FROM "ApprovalRequest" WHERE id = $1', [second.requestId])).status).toBe('OPEN')
    expect((await as(anna.browser, 'GET', '/portal/approvals')).items.map((item: Json) => item.id)).toEqual(expect.arrayContaining([second.requestId]))
    expect((await as(anna.browser, 'GET', '/portal/approvals')).items.map((item: Json) => item.id)).not.toContain(first.requestId)
  })
})
