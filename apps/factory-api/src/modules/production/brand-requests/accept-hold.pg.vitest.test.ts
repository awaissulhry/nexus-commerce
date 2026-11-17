import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { freshGuard } from '../../../platform/auth/portal/testing/portal'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { urgencyWorld, type UrgencyWorld } from '../testing/urgency-world'

/**
 * B-PR-27a — accepting a customer's pause and resume does the work (production plan §3 "Brand asks, we decide", "Legacy mixed work
 * order: accept is held ('answer by hand')"; 08-backend §4.2; the Owner rule 2026-11-16: "One brand must not be able to see
 * anything related to any other brand. But we, as the production unit, should be able to see it all. And manage it all as
 * well.") on the local stack through the real app (../testing/urgency-world.ts): brand A = the seeds' P1, brand B = the threads'
 * second brand, both portals on with the pause and resume open; A's buyer signed in by code; office people with two-factor — a
 * planner over every customer, a planner limited to B, a sales person — and the office test sessions.
 *
 *   wall     accepting A's pause holds only A's work orders: B's work orders (and the mixed one) keep their status and get no
 *            hold; every event the accept writes names A only; B's planner does not reach A's request (404)
 *   HOLD     a BRAND hold (the customer's pause, its ask named) on each open work order of the order; the work order ON_HOLD with
 *            the pause's words; the customer reads its pause (RESUME open); the office reads the hold
 *   RESUME   the pause lifted; a work order still held by our own production hold stays held under it
 *   by hand  a mixed work order, an order with no work order yet, a work order that also makes another order: refused in words,
 *            nothing written; a Sales kind is refused here in words
 *   counter  a pause the customer agreed with our counter-offer is accepted (carried out with the counter)
 *
 * Every name, address and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/production/brand-requests`.
 */

let world: UrgencyWorld
const NS = 'pr27a-accept-hold'
type Json = Record<string, any>
type Office = Awaited<ReturnType<UrgencyWorld['officePerson']>>
type Portal = Awaited<ReturnType<UrgencyWorld['portalPerson']>>
let planner: Office
let plannerB: Office
let sales: Office
let buyerA: Portal
const orders = {} as Record<'aHold' | 'aNone' | 'aShared' | 'aOther' | 'aCounter' | 'bHold', { orderId: string; number: string; lineId: string }>
const workOrders = {} as Record<'aHold' | 'aShared' | 'aCounter' | 'bHold', { id: string; number: string }>

const admin = <R = Json>(sql: string, values: unknown[] = []) => world.admin<R>(sql, values)
const key = () => ({ headers: { 'idempotency-key': `pr27a-${newId()}` } })

async function send(person: Office | Portal, method: 'GET' | 'POST', url: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const answer = method === 'GET' ? await person.browser.send('GET', url) : await person.browser.send('POST', url, body, key())
  return { status: answer.status, body: answer.body as Json }
}
async function ok(person: Office | Portal, url: string): Promise<Json> {
  const answer = await send(person, 'GET', url)
  expect(answer.status, `${url}: ${JSON.stringify(answer.body).slice(0, 500)}`).toBe(200)
  return answer.body
}
/** As the office over every customer (the test session), for the setup and the reads. */
async function office(method: 'GET' | 'POST', url: string, payload?: unknown): Promise<{ status: number; body: Json }> {
  const response = await world.officeApp.inject({ method, url, headers: { 'x-test-session': 'office.all', 'idempotency-key': `pr27a-${newId()}` }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) })
  return { status: response.statusCode, body: response.json() as Json }
}
/** The customer asks from its portal (the B-PR-25 route). */
async function ask(person: Portal, orderId: string, body: Json): Promise<Json> {
  const answer = await send(person, 'POST', `/portal/sales-orders/${orderId}/change-requests`, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(201)
  return answer.body.request as Json
}
/** A DRAFT work order of these order lines (the real route), as the office makes them. */
async function workOrderOf(lines: readonly { salesOrderLineId: string; sizes: { size: string; quantity: number }[] }[]): Promise<{ id: string; number: string }> {
  const made = await office('POST', '/production/work-orders', { siteId: world.w.siteId, lines })
  expect(made.status, JSON.stringify(made.body)).toBe(201)
  return { id: made.body.workOrder.id as string, number: made.body.workOrder.number as string }
}
const outbox = (type: string) => admin<{ payload: Json }>('SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id', [world.ids.tenantId, type])
const requestRow = (id: string) => admin<{ status: string; version: number; answer: string | null }>('SELECT status::text AS status, version, answer FROM "OrderChangeRequest" WHERE id = $1', [id]).then((rows) => rows[0]!)
const workOrderRow = (id: string) =>
  admin<{ status: string; holdReason: string | null; holdRecordType: string | null; holdRecordId: string | null; heldFromStatus: string | null; version: number }>(
    'SELECT status::text AS status, "holdReason", "holdRecordType", "holdRecordId"::text AS "holdRecordId", "heldFromStatus"::text AS "heldFromStatus", version FROM "WorkOrder" WHERE id = $1',
    [id],
  ).then((rows) => rows[0]!)
const holdsOf = (workOrderIds: readonly string[]) =>
  admin<{ id: string; workOrderId: string; kind: string; status: string; reasonCode: string; requestId: string | null; partyId: string | null; liftReason: string | null }>(
    'SELECT id::text AS id, "workOrderId"::text AS "workOrderId", kind::text AS kind, status::text AS status, "reasonCode", "requestId"::text AS "requestId", "partyId"::text AS "partyId", "liftReason" FROM "WorkOrderHold" WHERE "workOrderId" = ANY($1::uuid[]) ORDER BY "placedAt", id',
    [[...workOrderIds]],
  )
/** B's side as it stands (its work orders' status and holds, the mixed work order's): must not move when A's ask is accepted. */
const brandBSide = async () => ({
  workOrders: await admin('SELECT id::text AS id, status::text AS status, version FROM "WorkOrder" WHERE id = ANY($1::uuid[]) ORDER BY id', [[workOrders.bHold.id, world.w.b.workOrderId, world.w.mixed.workOrderId]]),
  holds: await holdsOf([workOrders.bHold.id, world.w.b.workOrderId, world.w.mixed.workOrderId]),
})
/** The tenant's outbox ids now (a mark), and the events written after it (the rows not in the mark). */
const outboxMark = async () => new Set((await admin<{ id: string }>('SELECT id::text AS id FROM "OutboxEvent" WHERE "tenantId" = $1', [world.ids.tenantId])).map((row) => row.id))
const eventsSince = async (mark: ReadonlySet<string>) =>
  (await admin<{ id: string; type: string; payload: Json }>('SELECT id::text AS id, type, payload FROM "OutboxEvent" WHERE "tenantId" = $1 ORDER BY "occurredAt", id', [world.ids.tenantId])).filter((row) => !mark.has(row.id))

beforeAll(async () => {
  world = await urgencyWorld('pr27a_accept_hold', NS)
  // Both customers' pause and resume open (the limits card's list).
  await admin(`UPDATE "PortalSettings" SET "productionAskKinds" = '{HOLD,RESUME,SPLIT_SHIPMENT,SAMPLE_ROUND}', version = version + 1 WHERE "partyId" = ANY($1::uuid[])`, [[world.ids.a, world.ids.b]])
  for (const name of ['aHold', 'aNone', 'aShared', 'aOther', 'aCounter'] as const) orders[name] = await world.addOrder(world.ids.a, name.toUpperCase(), '2026-10-01')
  orders.bHold = await world.addOrder(world.ids.b, 'BHOLD', '2026-10-01')
  const both = [{ size: '50', quantity: 2 }, { size: '52', quantity: 2 }]
  workOrders.aHold = await workOrderOf([{ salesOrderLineId: orders.aHold.lineId, sizes: both }])
  workOrders.aCounter = await workOrderOf([{ salesOrderLineId: orders.aCounter.lineId, sizes: both }])
  workOrders.bHold = await workOrderOf([{ salesOrderLineId: orders.bHold.lineId, sizes: both }])
  // One work order of two of A's orders (one customer, as the rule allows): a pause of one would stop the other.
  workOrders.aShared = await workOrderOf([
    { salesOrderLineId: orders.aShared.lineId, sizes: [{ size: '50', quantity: 2 }] },
    { salesOrderLineId: orders.aOther.lineId, sizes: [{ size: '52', quantity: 2 }] },
  ])
  planner = await world.officePerson('piera.planner@pr27a-office.example.com', 'planner')
  plannerB = await world.officePerson('bruno.planner@pr27a-office.example.com', 'planner', [world.ids.b])
  sales = await world.officePerson('silvia.sales@pr27a-office.example.com', 'sales')
  buyerA = await world.portalPerson('alba.buyer@pr27a-brand-alpha.example.com', world.ids.a, ['customer-buyer', 'partner-approve'])
}, 600_000)

beforeEach(() => {
  freshGuard(world.h)
})

afterAll(async () => {
  await world?.close()
})

describe('B-PR-27a: accepting a pause and a resume does the work', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const ids = {} as Record<'hold' | 'resume', string>

  it('wall: accepting A’s pause holds only A’s work orders; B’s stay as they were, and B’s planner does not reach the request', async () => {
    ids.hold = (await ask(buyerA, orders.aHold.orderId, { kind: 'HOLD', note: 'Made-up: our store opening moved by a month.' })).id
    const before = await brandBSide()
    // B's planner: A's request is not found (in words that name nobody); Sales: not its kind to answer (403 in words).
    const unseen = await send(plannerB, 'POST', `/production/brand-requests/${ids.hold}/accept`, { version: 1 })
    expect(unseen.status).toBe(404)
    expect(JSON.stringify(unseen.body)).not.toMatch(/T-URG|Alpha|P1|store opening/i)
    const forbidden = await send(sales, 'POST', `/production/brand-requests/${ids.hold}/accept`, { version: 1 })
    expect(forbidden.status).toBe(403)
    expect(forbidden.body.error.message).toMatch(/production\.brand\.manage/)
    expect((await requestRow(ids.hold)).status).toBe('OPEN')

    const since = await outboxMark()
    const accepted = await send(planner, 'POST', `/production/brand-requests/${ids.hold}/accept`, { version: 1, answer: 'Made-up: paused from today; tell us when to go on.' })
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)
    expect(accepted.body.request).toMatchObject({ id: ids.hold, kind: 'HOLD', status: 'ACCEPTED', answer: 'Made-up: paused from today; tell us when to go on.', waitingOn: null, may: { accept: false, refuse: false, counter: false } })
    expect(accepted.body.done).toMatchObject({ kind: 'HOLD', paused: [{ id: workOrders.aHold.id, number: workOrders.aHold.number, status: 'ON_HOLD', changed: true }], resumed: [] })
    expect(accepted.body.done.words.en).toContain(workOrders.aHold.number)

    // A's work order: ON_HOLD under the customer's pause, in the pause's words (never a code, never the customer's name).
    const [hold] = await holdsOf([workOrders.aHold.id])
    expect(hold).toMatchObject({ kind: 'BRAND', status: 'ACTIVE', reasonCode: 'CUSTOMER_PAUSE', requestId: ids.hold, partyId: world.ids.a })
    expect(await workOrderRow(workOrders.aHold.id)).toMatchObject({ status: 'ON_HOLD', holdReason: "Paused at the customer's request", holdRecordType: 'WorkOrderHold', holdRecordId: hold!.id, heldFromStatus: 'DRAFT' })
    // B's work orders and the mixed one: untouched.
    expect(await brandBSide()).toEqual(before)
    // Every event of the accept names A only; the request's answer, the hold, the work order's move.
    const written = await eventsSince(since)
    expect(written.map((row) => row.type)).toEqual(expect.arrayContaining(['order_change_request.answered', 'work_order_hold.placed', 'workorder.status_changed']))
    for (const row of written) if ('partyId' in row.payload) expect(row.payload.partyId, row.type).toBe(world.ids.a)
    expect(JSON.stringify(written)).not.toContain(workOrders.bHold.id)
    expect(JSON.stringify(written)).not.toContain(world.w.mixed.workOrderId)
    expect(written.find((row) => row.type === 'order_change_request.answered')!.payload).toEqual({ requestId: ids.hold, orderId: orders.aHold.orderId, partyId: world.ids.a, kind: 'HOLD', answer: 'ACCEPTED', amendmentId: null, orderCancelled: false })
    expect(written.find((row) => row.type === 'work_order_hold.placed')!.payload).toMatchObject({ workOrderId: workOrders.aHold.id, kind: 'BRAND', requestId: ids.hold, partyId: world.ids.a })

    // The office reads the pause on the work order; the customer reads its pause (it may ask to resume now, not to pause again).
    const listed = await office('GET', `/production/work-orders/${workOrders.aHold.id}/holds`)
    expect(listed.status).toBe(200)
    expect(listed.body.holds[0]).toMatchObject({ kind: 'BRAND', status: 'ACTIVE', reason: "Paused at the customer's request", requestId: ids.hold })
    const rules = await ok(buyerA, `/portal/sales-orders/${orders.aHold.orderId}/change-requests/rules`)
    const asks = new Map((rules.asks as Json[]).map((entry) => [entry.kind, entry]))
    expect(asks.get('RESUME')).toMatchObject({ verdict: { possible: true } })
    expect(asks.get('HOLD')).toMatchObject({ verdict: { possible: false, code: 'PAUSED' } })
    const mine = ((await ok(buyerA, `/portal/sales-orders/${orders.aHold.orderId}/change-requests`)).items as Json[]).find((item) => item.id === ids.hold)!
    expect(mine).toMatchObject({ status: 'ACCEPTED', answer: 'Made-up: paused from today; tell us when to go on.' })
    expect(JSON.stringify(mine)).not.toMatch(/piera|answeredBy/i)
    // Once: accepted again → refused in words.
    const again = await send(planner, 'POST', `/production/brand-requests/${ids.hold}/accept`, { version: 2 })
    expect(again.status).toBe(409)
    expect(again.body.error.issues[0].path).toBe('request/ACCEPTED')
  })

  it('RESUME lifts the pause; a work order still held by our own production hold stays held under it, then goes back', async () => {
    // Our own production hold beside the customer's pause (the one dialog's production reason).
    const ours = await office('POST', `/production/work-orders/${workOrders.aHold.id}/holds`, { reasonCode: 'MATERIAL_MISSING', note: 'Made-up: the lining is late.' })
    expect(ours.status, JSON.stringify(ours.body)).toBe(201)
    const ourHoldId = ours.body.hold.id as string
    ids.resume = (await ask(buyerA, orders.aHold.orderId, { kind: 'RESUME' })).id
    const before = await brandBSide()
    const since = await outboxMark()
    const accepted = await send(planner, 'POST', `/production/brand-requests/${ids.resume}/accept`, { version: 1 })
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)
    expect(accepted.body.request).toMatchObject({ kind: 'RESUME', status: 'ACCEPTED' })
    // Lifted, but the work order stays held under our production hold.
    expect(accepted.body.done).toMatchObject({ kind: 'RESUME', paused: [], resumed: [{ id: workOrders.aHold.id, status: 'ON_HOLD', changed: false }] })
    const holds = await holdsOf([workOrders.aHold.id])
    expect(holds.find((row) => row.kind === 'BRAND')).toMatchObject({ status: 'LIFTED', liftReason: `Resumed at the customer's request (${orders.aHold.number}).` })
    expect(holds.find((row) => row.kind === 'PRODUCTION')).toMatchObject({ status: 'ACTIVE' })
    expect(await workOrderRow(workOrders.aHold.id)).toMatchObject({ status: 'ON_HOLD', holdRecordType: 'WorkOrderHold', holdRecordId: ourHoldId, holdReason: 'Material missing' })
    expect((await eventsSince(since)).find((row) => row.type === 'work_order_hold.lifted')!.payload).toMatchObject({ workOrderId: workOrders.aHold.id, kind: 'BRAND', requestId: ids.hold, partyId: world.ids.a })
    expect(await brandBSide()).toEqual(before)
    // The customer's pause is off (it may pause again); our hold lifted, the work order goes back to DRAFT.
    const rules = await ok(buyerA, `/portal/sales-orders/${orders.aHold.orderId}/change-requests/rules`)
    expect((rules.asks as Json[]).find((entry) => entry.kind === 'RESUME')).toMatchObject({ verdict: { possible: false, code: 'NOT_PAUSED' } })
    expect(await holdsOf([workOrders.aHold.id])).toHaveLength(2)
    const hold = (await admin<{ version: number }>('SELECT version FROM "WorkOrderHold" WHERE id = $1', [ourHoldId]))[0]!
    const lifted = await office('POST', `/production/work-orders/${workOrders.aHold.id}/holds/${ourHoldId}/lift`, { version: hold.version, reason: 'Made-up: the lining came in.' })
    expect(lifted.status, JSON.stringify(lifted.body)).toBe(200)
    expect((await workOrderRow(workOrders.aHold.id)).status).toBe('DRAFT')
  })

  it('answered by hand: a mixed work order, no work order yet, a work order that also makes another order — refused in words, nothing written', async () => {
    const before = await brandBSide()
    // A's harness order: its own work order and the mixed one made before the one-customer rule (it also makes B's pieces).
    const mixed = await ask(buyerA, world.w.a.salesOrderId, { kind: 'HOLD', note: 'Made-up: hold it, please.' })
    const refused = await send(planner, 'POST', `/production/brand-requests/${mixed.id}/accept`, { version: 1 })
    expect(refused.status).toBe(409)
    expect(refused.body.error.issues[0].path).toBe('request/MIXED')
    expect(refused.body.error.message).toContain(world.w.mixed.number)
    expect(refused.body.error.message).toMatch(/answer by hand/)
    expect(await holdsOf([world.w.a.workOrderId, world.w.mixed.workOrderId])).toEqual([])
    // No work order yet: nothing to pause.
    const none = await ask(buyerA, orders.aNone.orderId, { kind: 'HOLD', note: 'Made-up: wait for us.' })
    const empty = await send(planner, 'POST', `/production/brand-requests/${none.id}/accept`, { version: 1 })
    expect(empty.status).toBe(409)
    expect(empty.body.error.issues[0].path).toBe('request/NO_WORK')
    // A work order that also makes another of A's orders: that order would stop too.
    const shared = await ask(buyerA, orders.aShared.orderId, { kind: 'HOLD', note: 'Made-up: hold this one only.' })
    const both = await send(planner, 'POST', `/production/brand-requests/${shared.id}/accept`, { version: 1 })
    expect(both.status).toBe(409)
    expect(both.body.error.issues[0].path).toBe('request/SHARED')
    expect(both.body.error.message).toContain(workOrders.aShared.number)
    expect(await holdsOf([workOrders.aShared.id])).toEqual([])
    for (const id of [mixed.id, none.id, shared.id]) expect(await requestRow(id)).toMatchObject({ status: 'OPEN', version: 1 })
    expect(await brandBSide()).toEqual(before)
    // The office still refuses it with words (B-PR-26's route): answered by hand.
    expect((await send(planner, 'POST', `/production/brand-requests/${none.id}/refuse`, { version: 1, answer: 'Made-up: nothing is in work yet; we start only when you tell us.' })).status).toBe(200)
  })

  it('a Sales kind is refused here in words; a pause the customer agreed with our counter-offer is carried out', async () => {
    const cancel = await ask(buyerA, orders.aOther.orderId, { kind: 'CANCEL', reasonCode: 'LEAD_TIME' })
    const elsewhere = await send(planner, 'POST', `/production/brand-requests/${cancel.id}/accept`, { version: 1 })
    expect(elsewhere.status).toBe(409)
    expect(elsewhere.body.error.issues[0].path).toBe('request/SALES_ASK')

    const pause = await ask(buyerA, orders.aCounter.orderId, { kind: 'HOLD', note: 'Made-up: please pause now.' })
    const countered = await send(planner, 'POST', `/production/brand-requests/${pause.id}/counter`, { version: 1, note: 'Made-up: we pause after this week’s cutting.' })
    expect(countered.status, JSON.stringify(countered.body)).toBe(200)
    // Not accepted while the customer has not answered.
    expect((await send(planner, 'POST', `/production/brand-requests/${pause.id}/accept`, { version: 2 })).body.error.issues[0].path).toBe('request/COUNTER_WAITING')
    const approvalId = countered.body.approvalRequestId as string
    const page = await ok(buyerA, `/portal/approvals/${approvalId}`)
    expect((await send(buyerA, 'POST', `/portal/approvals/${approvalId}/answer`, { decision: 'APPROVED', typedName: 'Alba Buyer', version: page.request.version })).status).toBe(200)
    const agreed = (await ok(planner, `/production/brand-requests/${pause.id}`)).request
    expect(agreed).toMatchObject({ status: 'COUNTERED', counter: { state: 'AGREED' }, may: { accept: true } })
    const accepted = await send(planner, 'POST', `/production/brand-requests/${pause.id}/accept`, { version: agreed.version })
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)
    expect(accepted.body.request.status).toBe('ACCEPTED')
    expect(accepted.body.done.paused).toEqual([expect.objectContaining({ id: workOrders.aCounter.id, changed: true })])
    const audit = (await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE action = 'production.acceptCustomerRequest' AND "recordId" = $1`, [pause.id]))[0]!
    expect(audit.after).toMatchObject({ status: 'ACCEPTED', kind: 'HOLD', withCounter: approvalId })
    expect((await outbox('order_change_request.answered')).map((row) => row.payload).find((payload) => payload.requestId === pause.id)).toMatchObject({ answer: 'ACCEPTED', kind: 'HOLD' })
  })
})
