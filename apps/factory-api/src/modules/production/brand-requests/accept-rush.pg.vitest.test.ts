import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
import { freshGuard } from '../../../platform/auth/portal/testing/portal'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { urgencyWorld, type UrgencyWorld } from '../testing/urgency-world'

/**
 * B-PR-27b — accepting a customer's "Urgent – asked" and another sample round does the work (production plan §3 "Brand-slot rule":
 * "Putting an order ahead of other brands stays our act: accept its 'Urgent – asked' ('Accept as urgent' or 'Accept and rush the
 * floor')", "4 of 3 · 1 agreed with us"; 08-backend §4.2; lead picks L18, L19; review fixes R-40, R-64; the Owner rule 2026-11-16:
 * "One brand must not be able to see anything related to any other brand. But we, as the production unit, should be able to see it
 * all. And manage it all as well.") on the local stack through the real app (../testing/urgency-world.ts): brand A = the seeds' P1
 * (urgency on, quota 3, two orders Urgent already), brand B = the threads' second brand; A's buyer signed in by code; office people
 * with two-factor — a planner over every customer, a planner limited to B, a sales person.
 *
 *   PW-11 (ask part)  accepting A's ask touches no B row, no B urgent rank and no B backlog place (B's production state, its
 *                     orders' levers and its work orders are as they were); every event names A only
 *   as urgent         Urgent by us, LAST in A's own Urgent list, over the quota: "4 of 3 · 2 agreed with us"; never the office's
 *                     levers (priority, level, backlog rank, rush); the date asked proposed to sales as the re-promise
 *   rush the floor    the planner's rush lever on A's own work orders (workorder.priority_changed), a mixed one left alone in words;
 *                     nothing to rush: refused in words
 *   refused           locked at Regular by us, the customer's urgency off: in words, nothing written; a counter's agreed date is
 *                     the one proposed
 *   sample round      a round of the kind asked, for A, named on the request; by sales.samples.manage only
 *
 * Every name, address and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/production/brand-requests`.
 */

let world: UrgencyWorld
const NS = 'pr27b-accept-rush'
type Json = Record<string, any>
type Office = Awaited<ReturnType<UrgencyWorld['officePerson']>>
type Portal = Awaited<ReturnType<UrgencyWorld['portalPerson']>>
let planner: Office
let plannerB: Office
let sales: Office
let buyerA: Portal
const orders = {} as Record<'urgent' | 'over' | 'floor' | 'none' | 'locked' | 'off' | 'counter' | 'sample' | 'b', { orderId: string; number: string; lineId: string }>
let floorWorkOrder: { id: string; number: string }

const admin = <R = Json>(sql: string, values: unknown[] = []) => world.admin<R>(sql, values)
const key = () => ({ headers: { 'idempotency-key': `pr27b-${newId()}` } })
const TODAY = () => businessDate(world.h.clock.now())

async function send(person: Office | Portal, method: 'GET' | 'POST', url: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const answer = method === 'GET' ? await person.browser.send('GET', url) : await person.browser.send('POST', url, body, key())
  return { status: answer.status, body: answer.body as Json }
}
async function ok(person: Office | Portal, url: string): Promise<Json> {
  const answer = await send(person, 'GET', url)
  expect(answer.status, `${url}: ${JSON.stringify(answer.body).slice(0, 500)}`).toBe(200)
  return answer.body
}
async function ask(person: Portal, orderId: string, body: Json): Promise<Json> {
  const answer = await send(person, 'POST', `/portal/sales-orders/${orderId}/change-requests`, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(201)
  return answer.body.request as Json
}
async function accept(person: Office, requestId: string, body: Json, status = 200): Promise<Json> {
  const answer = await send(person, 'POST', `/production/brand-requests/${requestId}/accept`, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}
const requestRow = (id: string) => admin<{ status: string; version: number; sampleRoundId: string | null }>('SELECT status::text AS status, version, "sampleRoundId"::text AS "sampleRoundId" FROM "OrderChangeRequest" WHERE id = $1', [id]).then((rows) => rows[0]!)
const urgencyOf = (orderId: string) =>
  admin<{ urgency: string; urgentRank: number | null; urgencySetBy: string | null; urgencySetById: string | null; version: number }>(
    `SELECT urgency::text AS urgency, "urgentRank", "urgencySetBy"::text AS "urgencySetBy", "urgencySetById"::text AS "urgencySetById", version FROM "BrandOrderProduction" WHERE "salesOrderId" = $1 AND key = 'brand-production:' || $1::text`,
    [orderId],
  ).then((rows) => rows[0]!)
/** The office's own levers of an order (never written by an accept as urgent). */
const leversOf = (orderId: string) => admin<{ priority: number; priorityLevel: string | null; backlogRank: number | null }>('SELECT priority, "priorityLevel"::text AS "priorityLevel", "backlogRank" FROM "SalesOrder" WHERE id = $1', [orderId]).then((rows) => rows[0]!)
/** B's whole side: its production state, its orders' levers, its work orders — must not move when A's ask is accepted. */
const brandBSide = async () => ({
  production: await admin('SELECT id::text AS id, urgency::text AS urgency, "urgentRank", "urgencyBatchId"::text AS "batchId", version FROM "BrandOrderProduction" WHERE "partyId" = $1 ORDER BY id', [world.ids.b]),
  orders: await admin('SELECT id::text AS id, priority, "priorityLevel"::text AS "priorityLevel", "backlogRank", "shipComplete", version FROM "SalesOrder" WHERE "partyId" = $1 ORDER BY id', [world.ids.b]),
  workOrders: await admin('SELECT id::text AS id, priority, rush, status::text AS status, version FROM "WorkOrder" WHERE "partyId" = $1 OR id = $2 ORDER BY id', [world.ids.b, world.w.mixed.workOrderId]),
})
const outboxMark = async () => new Set((await admin<{ id: string }>('SELECT id::text AS id FROM "OutboxEvent" WHERE "tenantId" = $1', [world.ids.tenantId])).map((row) => row.id))
const eventsSince = async (mark: ReadonlySet<string>) =>
  (await admin<{ id: string; type: string; payload: Json }>('SELECT id::text AS id, type, payload FROM "OutboxEvent" WHERE "tenantId" = $1 ORDER BY "occurredAt", id', [world.ids.tenantId])).filter((row) => !mark.has(row.id))
/** The re-promises proposed on an order (the audit rows of planning's propose). */
const proposalsOf = (orderId: string) => admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE action = 'planning.promise.propose' AND "recordType" = 'SalesOrder' AND "recordId" = $1 ORDER BY at, id`, [orderId])

beforeAll(async () => {
  world = await urgencyWorld('pr27b_accept_rush', NS)
  await admin(`UPDATE "PortalSettings" SET "productionAskKinds" = '{HOLD,RESUME,SPLIT_SHIPMENT,SAMPLE_ROUND}', version = version + 1 WHERE "partyId" = ANY($1::uuid[])`, [[world.ids.a, world.ids.b]])
  for (const name of ['urgent', 'over', 'floor', 'none', 'locked', 'off', 'counter', 'sample'] as const) orders[name] = await world.addOrder(world.ids.a, `R-${name.toUpperCase()}`, '2026-10-01')
  orders.b = await world.addOrder(world.ids.b, 'R-B', '2026-10-01')
  const made = await world.officeApp.inject({ method: 'POST', url: '/production/work-orders', headers: { 'x-test-session': 'office.all' }, payload: { siteId: world.w.siteId, lines: [{ salesOrderLineId: orders.floor.lineId, sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 2 }] }] } })
  expect(made.statusCode, made.body).toBe(201)
  floorWorkOrder = (made.json() as { workOrder: { id: string; number: string } }).workOrder
  planner = await world.officePerson('pia.planner@pr27b-office.example.com', 'planner')
  plannerB = await world.officePerson('ben.planner@pr27b-office.example.com', 'planner', [world.ids.b])
  sales = await world.officePerson('sara.sales@pr27b-office.example.com', 'sales')
  buyerA = await world.portalPerson('amy.buyer@pr27b-brand-alpha.example.com', world.ids.a, ['customer-buyer', 'partner-approve'])
}, 600_000)

beforeEach(() => {
  freshGuard(world.h)
})

afterAll(async () => {
  await world?.close()
})

describe('B-PR-27b: accepting "Urgent – asked" and another sample round does the work', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('PW-11 (ask part) / Accept as urgent: Urgent by us, last in A’s own list, past the quota; the date proposed to sales; B untouched', async () => {
    const wanted = addDays(TODAY(), 12)
    const rush = await ask(buyerA, orders.urgent.orderId, { kind: 'RUSH', requestedDate: wanted, note: 'Made-up: our season opens early.' })
    const bBefore = await brandBSide()
    const leversBefore = await leversOf(orders.urgent.orderId)
    // B's planner does not reach A's ask; Sales does not answer a rush (production.brand.manage).
    expect((await send(plannerB, 'POST', `/production/brand-requests/${rush.id}/accept`, { version: 1 })).status).toBe(404)
    expect((await send(sales, 'POST', `/production/brand-requests/${rush.id}/accept`, { version: 1 })).status).toBe(403)

    const mark = await outboxMark()
    const accepted = await accept(planner, rush.id, { version: 1, answer: 'Made-up: agreed, we move it up.' })
    expect(accepted.request).toMatchObject({ kind: 'RUSH', status: 'ACCEPTED' })
    // A had two Urgent orders (quota 3): this one is the third, last in A's own list, agreed with us.
    expect(accepted.done).toMatchObject({ kind: 'RUSH', urgency: { urgency: 'URGENT', urgentRank: 3, already: false, use: { used: 3, max: 3, agreed: 1, over: false, words: { en: '3 of 3 · 1 agreed with us' } } }, rushed: [], rushSkipped: null })
    expect(await urgencyOf(orders.urgent.orderId)).toMatchObject({ urgency: 'URGENT', urgentRank: 3, urgencySetBy: 'FACTORY', urgencySetById: planner.id })
    // The date asked, proposed to sales as the re-promise of every open size promised later (the order's 20 Dec).
    expect(accepted.done.repromise.proposals).toEqual([expect.objectContaining({ orderLineId: orders.urgent.lineId, sizes: [{ size: '50', from: '2026-12-20', to: wanted }, { size: '52', from: '2026-12-20', to: wanted }] })])
    const [proposal] = await proposalsOf(orders.urgent.orderId)
    expect(proposal!.after).toMatchObject({ orderLineId: orders.urgent.lineId, reasonCode: 'YOUR_CHANGE' })
    expect((await admin('SELECT "recordType", "recordId"::text AS "recordId" FROM "Task" WHERE id = $1', [proposal!.after.proposalId]))[0]).toEqual({ recordType: 'SalesOrder', recordId: orders.urgent.orderId })

    // Never the office's levers; no rush of the floor.
    expect(await leversOf(orders.urgent.orderId)).toEqual(leversBefore)
    const written = await eventsSince(mark)
    expect(written.map((row) => row.type)).not.toContain('workorder.priority_changed')
    expect(written.find((row) => row.type === 'brand_production.urgency_changed')!.payload).toMatchObject({ partyId: world.ids.a, orderIds: [orders.urgent.orderId], urgency: 'URGENT', by: 'FACTORY', change: 'MARK', locked: false, undo: false, asked: true })
    for (const row of written) if ('partyId' in row.payload) expect(row.payload.partyId, row.type).toBe(world.ids.a)
    // PW-11 (ask part): no B row, no B urgent rank, no B backlog place moved.
    expect(await brandBSide()).toEqual(bBefore)

    // A fourth, over the quota (no date asked: nothing proposed, in words).
    const over = await ask(buyerA, orders.over.orderId, { kind: 'RUSH', note: 'Made-up: this one too.' })
    const second = await accept(planner, over.id, { version: 1 })
    expect(second.done.urgency).toMatchObject({ urgentRank: 4, use: { used: 4, max: 3, agreed: 2, over: true, words: { en: '4 of 3 · 2 agreed with us' } } })
    expect(second.done.repromise).toMatchObject({ proposals: [], skipped: [{ orderLineId: orders.over.lineId, words: { en: 'The customer asked no date: the promise stands until planning proposes a new one.' } }] })
    expect(await brandBSide()).toEqual(bBefore)
  })

  it('Accept and rush the floor: the planner’s rush lever on A’s own work orders; a mixed one is left alone; nothing to rush is refused', async () => {
    const rush = await ask(buyerA, orders.floor.orderId, { kind: 'RUSH', requestedDate: addDays(TODAY(), 15) })
    const mark = await outboxMark()
    const accepted = await accept(planner, rush.id, { version: 1, rushFloor: true })
    expect(accepted.done).toMatchObject({ urgency: { urgency: 'URGENT' }, rushed: [{ id: floorWorkOrder.id, number: floorWorkOrder.number, changed: true }], rushSkipped: null })
    expect((await admin<{ rush: boolean }>('SELECT rush FROM "WorkOrder" WHERE id = $1', [floorWorkOrder.id]))[0]!.rush).toBe(true)
    expect((await eventsSince(mark)).find((row) => row.type === 'workorder.priority_changed')!.payload).toMatchObject({ workOrderId: floorWorkOrder.id, partyId: world.ids.a, rush: true, previousRush: false })

    // A's harness order: Urgent already (it asks with a need-by date), its own work order and the mixed one made before the rule.
    const bBefore = await brandBSide()
    const harness = await ask(buyerA, world.w.a.salesOrderId, { kind: 'RUSH', requestedDate: addDays(TODAY(), 20) })
    const both = await accept(planner, harness.id, { version: 1, rushFloor: true })
    expect(both.done.urgency).toMatchObject({ urgency: 'URGENT', already: true, urgentRank: 2 })
    expect(both.done.rushed).toEqual([expect.objectContaining({ id: world.w.a.workOrderId, changed: true })])
    expect(both.done.rushSkipped.en).toContain(world.w.mixed.number)
    expect((await admin<{ rush: boolean }>('SELECT rush FROM "WorkOrder" WHERE id = $1', [world.w.mixed.workOrderId]))[0]!.rush).toBe(false)
    expect(await brandBSide()).toEqual(bBefore)

    // No work order yet: nothing to rush, refused in words, nothing written.
    const none = await ask(buyerA, orders.none.orderId, { kind: 'RUSH' })
    const refused = await accept(planner, none.id, { version: 1, rushFloor: true }, 409)
    expect(refused.error.issues[0].path).toBe('request/NOTHING_TO_RUSH')
    expect(await requestRow(none.id)).toMatchObject({ status: 'OPEN', version: 1 })
    expect((await urgencyOf(orders.none.orderId)).urgency).toBe('REGULAR')
    // rushFloor names only an "Urgent – asked".
    const pause = await ask(buyerA, orders.none.orderId, { kind: 'HOLD', note: 'Made-up: hold it.' })
    expect((await accept(planner, pause.id, { version: 1, rushFloor: true }, 400)).error.issues[0].path).toBe('body/rushFloor')
  })

  it('refused in words, nothing written: locked at Regular by us, the customer’s urgency off; an agreed counter’s date is the one proposed', async () => {
    const locked = await ask(buyerA, orders.locked.orderId, { kind: 'RUSH' })
    // We locked it at Regular after it was asked (the Customer card's lock, planted).
    await world.replica([{ sql: `UPDATE "BrandOrderProduction" SET "urgencyLocked" = true, "urgencyLockReason" = 'Made-up: waits for its deposit.', "urgencyLockedAt" = now(), "urgencyLockedById" = $2::uuid, "urgencySetBy" = 'FACTORY', "urgencySetById" = $2::uuid, "urgencySetAt" = now(), version = version + 1 WHERE "salesOrderId" = $1::uuid`, values: [orders.locked.orderId, planner.id] }])
    const lockedAnswer = await accept(planner, locked.id, { version: 1 }, 409)
    expect(lockedAnswer.error.issues[0].path).toBe('request/LOCKED')
    expect((await urgencyOf(orders.locked.orderId)).urgency).toBe('REGULAR')

    const off = await ask(buyerA, orders.off.orderId, { kind: 'RUSH' })
    await admin(`UPDATE "PortalSettings" SET "productionUrgencyOn" = false, version = version + 1 WHERE "partyId" = $1`, [world.ids.a])
    try {
      expect((await accept(planner, off.id, { version: 1 }, 409)).error.issues[0].path).toBe('request/URGENCY_OFF')
    } finally {
      await admin(`UPDATE "PortalSettings" SET "productionUrgencyOn" = true, version = version + 1 WHERE "partyId" = $1`, [world.ids.a])
    }
    for (const id of [locked.id, off.id]) expect(await requestRow(id)).toMatchObject({ status: 'OPEN', version: 1 })

    // Our counter-offer's date, agreed by the customer, is the date proposed to sales.
    const wanted = addDays(TODAY(), 8)
    const offered = addDays(TODAY(), 14)
    const rush = await ask(buyerA, orders.counter.orderId, { kind: 'RUSH', requestedDate: wanted })
    const countered = await send(planner, 'POST', `/production/brand-requests/${rush.id}/counter`, { version: 1, date: offered })
    expect(countered.status, JSON.stringify(countered.body)).toBe(200)
    const approvalId = countered.body.approvalRequestId as string
    const page = await ok(buyerA, `/portal/approvals/${approvalId}`)
    expect((await send(buyerA, 'POST', `/portal/approvals/${approvalId}/answer`, { decision: 'APPROVED', typedName: 'Amy Buyer', version: page.request.version })).status).toBe(200)
    const agreed = (await ok(planner, `/production/brand-requests/${rush.id}`)).request
    const accepted = await accept(planner, rush.id, { version: agreed.version })
    expect(accepted.done.repromise.proposals[0].sizes).toEqual([{ size: '50', from: '2026-12-20', to: offered }, { size: '52', from: '2026-12-20', to: offered }])
  })

  it('another sample round: a round of the kind asked for A, named on the request; by sales.samples.manage only', async () => {
    const asked = await ask(buyerA, orders.sample.orderId, { kind: 'SAMPLE_ROUND', lineId: orders.sample.lineId, sampleKind: 'SIZE_SET', note: 'Made-up: one of each size, please.' })
    // The planner reads sample rounds, does not ask for them.
    expect((await send(planner, 'POST', `/production/brand-requests/${asked.id}/accept`, { version: 1 })).status).toBe(403)
    const mark = await outboxMark()
    const accepted = await accept(sales, asked.id, { version: 1 })
    expect(accepted.request.status).toBe('ACCEPTED')
    expect(accepted.done).toMatchObject({ kind: 'SAMPLE_ROUND', sampleRound: { kind: 'SIZE_SET', number: expect.any(String) } })
    const roundId = accepted.done.sampleRound.id as string
    const round = (await admin<{ kind: string; partyId: string; styleId: string; cells: Json[]; instructions: string }>('SELECT kind::text AS kind, "partyId"::text AS "partyId", "styleId"::text AS "styleId", cells, instructions FROM "SampleRound" WHERE id = $1', [roundId]))[0]!
    const colourway = (await admin<{ colourwayId: string }>('SELECT "colourwayId"::text AS "colourwayId" FROM "SalesOrderLine" WHERE id = $1', [orders.sample.lineId]))[0]!.colourwayId
    expect(round).toMatchObject({ kind: 'SIZE_SET', partyId: world.ids.a, styleId: world.w.styleId, cells: [{ colourwayId: colourway, size: '50', quantity: 1 }, { colourwayId: colourway, size: '52', quantity: 1 }] })
    expect(round.instructions).toContain('one of each size')
    expect((await requestRow(asked.id)).sampleRoundId).toBe(roundId)
    expect((await eventsSince(mark)).find((row) => row.type === 'sample_round.requested')!.payload).toMatchObject({ sampleRoundId: roundId, kind: 'SIZE_SET', partyId: world.ids.a })
  })
})
