import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
import { freshGuard } from '../../../platform/auth/portal/testing/portal'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { urgencyWorld, type UrgencyWorld } from '../../production/testing/urgency-world'

/**
 * B-PR-27b — accepting a customer's "ship what is ready" (SPLIT_SHIPMENT) on Sales' accept (production plan §3 "Who answers / sets":
 * "Change, cancel, ship what is ready (on today's /sales/change-requests, which gains the split accept)"; 08-backend §4.2:
 * "SalesOrder.shipComplete = false + re-promise of the first part"; the Owner rule 2026-11-16: "One brand must not be able to see
 * anything related to any other brand. But we, as the production unit, should be able to see it all. And manage it all as well.")
 * on the local stack (../../production/testing/urgency-world.ts: brand A = the seeds' P1, brand B the threads' second brand):
 *
 *   accept   Sales (orders.manage): the order ships as ready (shipComplete false, audited), the first part's date proposed to sales
 *            for its sizes promised later (one re-promise per line, those sizes only); the request ACCEPTED; the customer reads
 *            that its order already ships in parts
 *   where    production's accept refuses it in words (it is Sales'); a Sales person limited to B does not reach it (404)
 *   wall     B's orders do not move
 *
 * Every name, address and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/change-requests`.
 */

let world: UrgencyWorld
const NS = 'pr27b-split'
type Json = Record<string, any>
type Office = Awaited<ReturnType<UrgencyWorld['officePerson']>>
type Portal = Awaited<ReturnType<UrgencyWorld['portalPerson']>>
let sales: Office
let salesB: Office
let planner: Office
let buyerA: Portal
const orders = {} as Record<'split' | 'b', { orderId: string; number: string; lineId: string }>

const admin = <R = Json>(sql: string, values: unknown[] = []) => world.admin<R>(sql, values)
const key = () => ({ headers: { 'idempotency-key': `pr27b-split-${newId()}` } })
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
const shipCompleteOf = (orderId: string) => admin<{ shipComplete: boolean; version: number }>('SELECT "shipComplete", version FROM "SalesOrder" WHERE id = $1', [orderId]).then((rows) => rows[0]!)

beforeAll(async () => {
  world = await urgencyWorld('pr27b_split', NS)
  await admin(`UPDATE "PortalSettings" SET "productionAskKinds" = '{HOLD,RESUME,SPLIT_SHIPMENT,SAMPLE_ROUND}', version = version + 1 WHERE "partyId" = ANY($1::uuid[])`, [[world.ids.a, world.ids.b]])
  orders.split = await world.addOrder(world.ids.a, 'SPLIT', '2026-10-01')
  orders.b = await world.addOrder(world.ids.b, 'SPLIT-B', '2026-10-01')
  // Both orders wait to ship as one (the quote's term, carried to the order).
  await world.replica([{ sql: `UPDATE "SalesOrder" SET "shipComplete" = true, version = version + 1 WHERE id = ANY($1::uuid[])`, values: [[orders.split.orderId, orders.b.orderId]] }])
  sales = await world.officePerson('sid.sales@pr27b-split-office.example.com', 'sales')
  salesB = await world.officePerson('sue.sales@pr27b-split-office.example.com', 'sales', [world.ids.b])
  planner = await world.officePerson('pat.planner@pr27b-split-office.example.com', 'planner')
  buyerA = await world.portalPerson('ann.buyer@pr27b-split-brand-alpha.example.com', world.ids.a, ['customer-buyer'])
}, 600_000)

beforeEach(() => {
  freshGuard(world.h)
})

afterAll(async () => {
  await world?.close()
})

describe('B-PR-27b: ship what is ready, accepted by Sales', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('the order ships as ready and the first part’s date goes to sales as its re-promise; elsewhere refused, B untouched', async () => {
    const first = addDays(TODAY(), 10)
    const asked = await send(buyerA, 'POST', `/portal/sales-orders/${orders.split.orderId}/change-requests`, { kind: 'SPLIT_SHIPMENT', cells: [{ lineId: orders.split.lineId, size: '50', quantity: 1 }], requestedDate: first })
    expect(asked.status, JSON.stringify(asked.body)).toBe(201)
    const id = asked.body.request.id as string
    const bBefore = await shipCompleteOf(orders.b.orderId)
    // Production's accept refuses it in words (Sales answers it); a Sales person limited to B does not reach it.
    const elsewhere = await send(planner, 'POST', `/production/brand-requests/${id}/accept`, { version: 1 })
    expect(elsewhere.status).toBe(409)
    expect(elsewhere.body.error.issues[0].path).toBe('request/SALES_ASK')
    expect((await send(salesB, 'POST', `/sales/change-requests/${id}/accept`, { version: 1 })).status).toBe(404)
    // Sales' list says it may answer it now.
    const listed = ((await ok(sales, '/sales/change-requests?status=OPEN')).items as Json[]).find((item) => item.id === id)!
    expect(listed).toMatchObject({ kind: 'SPLIT_SHIPMENT', mayAnswer: true })

    const accepted = await send(sales, 'POST', `/sales/change-requests/${id}/accept`, { version: 1, answer: 'Made-up: the first pieces go next week.' })
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)
    expect(accepted.body.request).toMatchObject({ status: 'ACCEPTED' })
    expect(accepted.body.split).toMatchObject({ shipComplete: false, proposals: [{ orderLineId: orders.split.lineId, sizes: [{ size: '50', from: '2026-12-20', to: first }] }], skipped: [] })
    expect((await shipCompleteOf(orders.split.orderId)).shipComplete).toBe(false)
    expect((await admin(`SELECT after FROM "AuditLog" WHERE action = 'orders.shipAsReady' AND "recordId" = $1`, [orders.split.orderId]))[0]).toMatchObject({ after: { shipComplete: false, requestId: id } })
    // Only the first part's size is re-promised (52 keeps its date).
    const proposal = (await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE action = 'planning.promise.propose' AND "recordId" = $1`, [orders.split.orderId]))[0]!
    expect(proposal.after.sizes).toEqual([{ size: '50', from: '2026-12-20', to: first }])
    expect((await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'order_change_request.answered' AND payload->>'requestId' = $1`, [id]))[0]!.payload).toMatchObject({ kind: 'SPLIT_SHIPMENT', answer: 'ACCEPTED', partyId: world.ids.a })
    // The customer: its order ships in parts already (no second split asked).
    const rules = await ok(buyerA, `/portal/sales-orders/${orders.split.orderId}/change-requests/rules`)
    expect((rules.asks as Json[]).find((entry) => entry.kind === 'SPLIT_SHIPMENT')).toMatchObject({ verdict: { possible: false, code: 'SHIPS_AS_READY' } })
    // B's order does not move.
    expect(await shipCompleteOf(orders.b.orderId)).toEqual(bBefore)
  })
})
