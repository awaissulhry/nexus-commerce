import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { freshGuard } from '../../../platform/auth/portal/testing/portal'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { KEEPER_EVENTS } from './keeper'
import { urgencyWorld, type UrgencyWorld } from '../testing/urgency-world'

/**
 * B-PR-22b — the customer's urgency in the office and the plan (production plan §3 "Set a customer's order back to Regular, lock,
 * unlock", "Brand-slot rule", §5 Customer card, Work orders, Planning board; review fixes R-45, R-46, R-48, R-69; the Owner rule
 * 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production unit, should be
 * able to see it all. And manage it all as well.") on the local stack through the real app (../testing/urgency-world.ts): brand
 * A = the seeds' P1 (SEED-SO-0002 Urgent 1st, a new order Urgent 2nd), brand B = the threads' second brand (SEED-SO-B001 locked at
 * Regular by us) with two more orders here (one Urgent 1st); office people signed in with two-factor — the owner (every customer),
 * a production manager limited to B, a planner limited to B (production.brand.manage, no override) — and the office test
 * sessions on the harness's second app for the reads.
 *
 *   PW-18   office.p2 (limited to B) cannot set back, lock or unlock A's urgency (A's id counted, never named; A's rows never
 *           change); the Customer card, the Work orders column and the board's chip show office.p2 only B's orders; Sales ›
 *           Orders' read-only column filters only what it reaches. Brand B's places in the backlog are identical before and after
 *           A marks (planning/backlog/backlog.pg.vitest.test.ts); A's mark recomputes no order of B (the keeper never follows
 *           urgency_changed: R-69); no event or audit row of A's names B, and the other way round
 *   and     step-up (no second person), per row outcomes, one audit row and one event per customer of a command (R-48), the lock's
 *           reason the customer reads, unlock, the switch off (marks dormant: no column, no chip), never a write of the office's
 *           levers.
 *
 * Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/production/brand`.
 */

let world: UrgencyWorld
const NS = 'pr22b-urgency'
type Json = Record<string, any>
const A = {} as { so2: string; alpha: string }
const B = {} as { locked: string; b2: string; b3: string }
const LOCK_REASON = 'Made-up: we wait for the deposit before this order may jump the queue.'
let owner: Awaited<ReturnType<UrgencyWorld['officePerson']>>
let managerB: Awaited<ReturnType<UrgencyWorld['officePerson']>>
let plannerB: Awaited<ReturnType<UrgencyWorld['officePerson']>>

const admin = <R = Json>(sql: string, values: unknown[] = []) => world.admin<R>(sql, values)
type Person = typeof owner
async function post(person: Person, url: string, body: unknown, options: { stepUp?: boolean } = {}): Promise<{ status: number; body: Json }> {
  if (options.stepUp !== false) await person.stepUp()
  const answer = await person.browser.send('POST', url, body, { headers: { 'idempotency-key': `pr22b-${newId()}` } })
  return { status: answer.status, body: answer.body as Json }
}
async function read(session: 'office.all' | 'office.p1' | 'office.p2', url: string, status = 200): Promise<Json> {
  const response = await world.officeApp.inject({ method: 'GET', url, headers: { 'x-test-session': session } })
  expect(response.statusCode, `${session} ${url}: ${response.body.slice(0, 500)}`).toBe(status)
  return response.json() as Json
}
async function state(orderId: string): Promise<Json> {
  return (
    await admin(
      `SELECT urgency::text, "urgentRank", "urgencySetBy"::text AS "setBy", "urgencySetById"::text AS "setById", "urgencyBatchId"::text AS "batchId",
              "urgencyLocked" AS locked, "urgencyLockReason" AS "lockReason", "urgencyLockedById"::text AS "lockedById", version
         FROM "BrandOrderProduction" WHERE key = $1`,
      [`brand-production:${orderId}`],
    )
  )[0]!
}
const states = async (orderIds: readonly string[]) => Promise.all(orderIds.map((orderId) => state(orderId)))
const levers = async () => ({
  orders: await admin(`SELECT id::text, priority, "priorityLevel"::text, "backlogRank" FROM "SalesOrder" WHERE "tenantId" = $1 ORDER BY id`, [world.ids.tenantId]),
  workOrders: await admin(`SELECT id::text, priority, rush FROM "WorkOrder" WHERE "tenantId" = $1 ORDER BY id`, [world.ids.tenantId]),
})
const audits = (batchId: string) => admin(`SELECT action, "recordId"::text AS "partyId", before, after, reason, audience::text FROM "AuditLog" WHERE "recordType" = 'Party' AND after->>'batchId' = $1`, [batchId])
const told = (batchId: string) => admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'brand_production.urgency_changed' AND payload->>'batchId' = $1`, [batchId])

beforeAll(async () => {
  world = await urgencyWorld('pr22b_urgency', NS)
  A.so2 = world.w.production.urgent[0]
  A.alpha = world.w.production.urgent[1]
  B.locked = world.w.production.locked
  B.b2 = (await world.addOrder(world.ids.b, 'B2', '2026-10-05')).orderId
  B.b3 = (await world.addOrder(world.ids.b, 'B3', '2026-10-06')).orderId
  // B marked b2 Urgent 1st (as its portal command leaves it).
  await admin(`UPDATE "BrandOrderProduction" SET urgency = 'URGENT', "urgentRank" = 1, "urgencySetAt" = now(), "urgencySetBy" = 'BRAND', "urgencyBatchId" = $2, version = version + 1 WHERE key = $1`, [`brand-production:${B.b2}`, newId()])
  owner = await world.officePerson('olga.owner@pr22b-office.example.com', 'owner')
  managerB = await world.officePerson('marco.manager@pr22b-office.example.com', 'production_manager', [world.ids.b])
  plannerB = await world.officePerson('paola.planner@pr22b-office.example.com', 'planner', [world.ids.b])
}, 480_000)

beforeEach(() => {
  freshGuard(world.h)
})

afterAll(async () => {
  await world?.close()
}, 60_000)

describe("B-PR-22b the customer's urgency in the office's reads (PW-18 read part)", { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it("Work orders: customerUrgency + urgentRank per row; the risk sort's tie; office.p2 reads only B's rows", async () => {
    const all = await read('office.all', '/production/work-orders?sort=risk&limit=100')
    const rowOf = (list: Json, id: string) => (list.workOrders as Json[]).find((row) => row.id === id)
    // A's work order makes A's 2nd urgent order; B's makes B's locked order (Regular); the mixed one has A's urgent order too.
    expect(rowOf(all, world.w.a.workOrderId)).toMatchObject({ customerUrgency: 'URGENT', urgentRank: 2 })
    expect(rowOf(all, world.w.b.workOrderId)).toMatchObject({ customerUrgency: 'REGULAR', urgentRank: null })
    expect(rowOf(all, world.w.mixed.workOrderId)).toMatchObject({ customerUrgency: 'URGENT', urgentRank: 2 })
    const limited = await read('office.p2', '/production/work-orders?sort=risk&limit=100')
    expect(rowOf(limited, world.w.a.workOrderId)).toBeUndefined()
    expect(rowOf(limited, world.w.mixed.workOrderId)).toBeUndefined()
    expect(rowOf(limited, world.w.b.workOrderId)).toMatchObject({ customerUrgency: 'REGULAR' })
    expect(JSON.stringify(limited)).not.toContain(world.w.a.workOrderId)
  })

  it('the planning board: the chip "Customer urgency: Urgent 2" on A\'s work order for the office; office.p2 sees only B\'s work orders and no chip of A', async () => {
    const all = await read('office.all', `/planning/schedule?siteId=${world.w.siteId}&readiness=false`)
    const chipOf = (board: Json, id: string) => (board.workOrders as Json[]).find((row) => row.id === id)?.customerUrgency
    expect(chipOf(all, world.w.a.workOrderId)).toEqual({ urgentRank: 2, words: { it: 'Urgenza cliente: Urgente 2', en: 'Customer urgency: Urgent 2' } })
    expect(chipOf(all, world.w.b.workOrderId)).toBeNull()
    const limited = await read('office.p2', `/planning/schedule?siteId=${world.w.siteId}&readiness=false`)
    expect((limited.workOrders as Json[]).some((row) => row.id === world.w.a.workOrderId)).toBe(false)
    expect(JSON.stringify(limited)).not.toContain('Customer urgency: Urgent 2')
  })

  it("Sales › Orders' read-only column (threads T10): A's urgent orders for the office; a filter of URGENT reaches only what the reader reaches", async () => {
    const urgent = await read('office.all', '/sales/orders?limit=200&customerUrgency=URGENT')
    expect((urgent.orders as Json[]).map((row) => row.id).sort()).toEqual([A.so2, A.alpha, B.b2].sort())
    const limited = await read('office.p2', '/sales/orders?limit=200&customerUrgency=URGENT')
    expect((limited.orders as Json[]).map((row) => row.id)).toEqual([B.b2])
  })

  it("the Customer card's list: B's open orders in B's own order, who set and locked each (office names); office.p2 cannot open A's (404)", async () => {
    const card = await read('office.all', `/production/brands/${world.ids.b}/urgency`)
    expect(card).toMatchObject({ customer: { id: world.ids.b }, urgency: { on: true, max: 2, dormant: null } })
    const orders = card.companies[0].orders as Json[]
    expect(orders[0]).toMatchObject({ id: B.b2, urgency: 'URGENT', counted: true, urgentRank: 1, setBy: 'BRAND' })
    expect(orders.find((order) => order.id === B.locked)).toMatchObject({ urgency: 'REGULAR', locked: true, lockReason: world.w.production.lockReason, setBy: 'FACTORY' })
    expect(card.companies[0].use).toMatchObject({ used: 1, max: 2, words: { en: '1 of 2 urgent used' } })
    const error = (await read('office.p2', `/production/brands/${world.ids.a}/urgency`, 404)).error
    expect(error.message).toBe('Customer not found.')
    const own = await read('office.p2', `/production/brands/${world.ids.b}/urgency`)
    expect(JSON.stringify(own)).not.toContain(A.so2)
    expect(JSON.stringify(own)).not.toContain(A.alpha)
  })
})

// ---- F-PR-18: the Work orders column's four states and its filter (production plan §5 "Work orders: … Customer urgency"; PW-06) ----
describe('F-PR-18 Work orders: the Customer urgency column (Urgent 2 / Urgent – asked / Regular / Set to regular by us) and its filter', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const rowOf = (list: Json, id: string) => (list.workOrders as Json[]).find((row) => row.id === id)
  const idsOf = (list: Json) => (list.workOrders as Json[]).map((row) => row.id as string)

  it("each row's state: A's work order Urgent 2, B's (its order locked at Regular by us) Set to regular by us; the export says the same words", async () => {
    const all = await read('office.all', '/production/work-orders?sort=risk&limit=100')
    expect(rowOf(all, world.w.a.workOrderId)).toMatchObject({ customerUrgency: 'URGENT', urgentRank: 2, urgencyState: 'URGENT' })
    expect(rowOf(all, world.w.b.workOrderId)).toMatchObject({ customerUrgency: 'REGULAR', urgentRank: null, urgencyState: 'SET_BACK' })
    expect(rowOf(all, world.w.mixed.workOrderId)).toMatchObject({ urgencyState: 'URGENT', urgentRank: 2 })
  })

  it('the filter keeps the rows of one state only (a computed filter: every page of the list, never the loaded rows only)', async () => {
    const setBack = await read('office.all', '/production/work-orders?customerUrgency=SET_BACK&limit=100')
    expect(idsOf(setBack)).toContain(world.w.b.workOrderId)
    expect(idsOf(setBack)).not.toContain(world.w.a.workOrderId)
    expect((setBack.workOrders as Json[]).every((row) => row.urgencyState === 'SET_BACK')).toBe(true)
    const urgent = await read('office.all', '/production/work-orders?customerUrgency=URGENT&sort=due&limit=100')
    expect(idsOf(urgent)).toEqual(expect.arrayContaining([world.w.a.workOrderId, world.w.mixed.workOrderId]))
    expect(idsOf(urgent)).not.toContain(world.w.b.workOrderId)
    await read('office.all', '/production/work-orders?customerUrgency=urgent', 400)
  })

  it('an open "Urgent – asked" (RUSH) on a Regular order makes its work order Urgent – asked; answered, it is not', async () => {
    const ask = newId()
    const [order] = await admin<{ companyId: string; partyId: string }>(`SELECT "companyId"::text, "partyId"::text FROM "SalesOrder" WHERE id = $1`, [B.locked])
    await world.replica([{ sql: `INSERT INTO "OrderChangeRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, status) VALUES ($1, $2, $3, $4, $5, 'RUSH', 'OPEN')`, values: [ask, world.ids.tenantId, order!.companyId, order!.partyId, B.locked] }])
    try {
      const all = await read('office.all', '/production/work-orders?sort=risk&limit=100')
      expect(rowOf(all, world.w.b.workOrderId)).toMatchObject({ customerUrgency: 'REGULAR', urgencyState: 'ASKED' })
      const asked = await read('office.all', '/production/work-orders?customerUrgency=ASKED&limit=100')
      expect(idsOf(asked)).toContain(world.w.b.workOrderId)
      expect((asked.workOrders as Json[]).every((row) => row.urgencyState === 'ASKED')).toBe(true)
    } finally {
      await world.replica([{ sql: `DELETE FROM "OrderChangeRequest" WHERE id = $1`, values: [ask] }])
    }
    expect(rowOf(await read('office.all', '/production/work-orders?sort=risk&limit=100'), world.w.b.workOrderId)).toMatchObject({ urgencyState: 'SET_BACK' })
  })

  it("PW-06: office.p2 (limited to B) filters only B's rows; A's urgent work orders are neither listed nor counted", async () => {
    const urgent = await read('office.p2', '/production/work-orders?customerUrgency=URGENT&limit=100')
    expect(idsOf(urgent)).not.toContain(world.w.a.workOrderId)
    expect(idsOf(urgent)).not.toContain(world.w.mixed.workOrderId)
    expect(JSON.stringify(urgent)).not.toContain(world.w.a.workOrderId)
    const setBack = await read('office.p2', '/production/work-orders?customerUrgency=SET_BACK&limit=100')
    expect(idsOf(setBack)).toContain(world.w.b.workOrderId)
    expect((setBack.workOrders as Json[]).every((row) => row.urgencyState === 'SET_BACK' && row.customer?.id === world.ids.b)).toBe(true)
  })
})
// ---- end F-PR-18

describe('B-PR-22b the factory sets back, locks and unlocks (production.brand.override, step-up, no second person)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('asks a fresh code first: without one nothing is read or written', async () => {
    world.h.clock.advance(6 * 60_000)
    const before = await state(B.b2)
    const answer = await post(managerB, '/production/brand-orders/urgency/regular', { orderIds: [B.b2], reason: LOCK_REASON, lock: true }, { stepUp: false })
    expect(answer.status, JSON.stringify(answer.body)).toBe(403)
    expect(answer.body.error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
    expect(await state(B.b2)).toEqual(before)
  })

  it("PW-18: the manager limited to B sets back and locks [A's order, B's order]: only B's is changed, A's counted and never named; one audit row and one event of B", async () => {
    const before = await levers()
    const aBefore = await states([A.so2, A.alpha])
    const answer = await post(managerB, '/production/brand-orders/urgency/regular', { orderIds: [A.so2, B.b2], reason: LOCK_REASON, lock: true })
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(answer.body.results.map((row: Json) => [row.orderId, row.outcome, row.done])).toEqual([[B.b2, 'DONE', true]])
    expect(answer.body.notFound).toBe(1)
    expect(JSON.stringify(answer.body)).not.toContain(A.so2)
    expect(answer.body.batches).toHaveLength(1)
    const batchId = answer.body.batches[0].batchId
    expect(await state(B.b2)).toMatchObject({ urgency: 'REGULAR', urgentRank: null, setBy: 'FACTORY', setById: managerB.id, locked: true, lockReason: LOCK_REASON, lockedById: managerB.id, batchId })
    expect(await states([A.so2, A.alpha])).toEqual(aBefore)
    const rows = await audits(batchId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: 'production.brandUrgency.lock', partyId: world.ids.b, reason: LOCK_REASON, audience: 'OFFICE', after: { change: 'LOCK', locked: true, by: 'FACTORY' } })
    expect(rows[0]!.before.orders).toEqual([{ orderId: B.b2, urgency: 'URGENT', urgentRank: 1, locked: false, lockReason: null }])
    const events = await told(batchId)
    expect(events).toHaveLength(1)
    expect(events[0]!.payload).toMatchObject({ partyId: world.ids.b, orderIds: [B.b2], urgency: 'REGULAR', by: 'FACTORY', change: 'LOCK', locked: true, undo: false, asked: false })
    expect(await levers()).toEqual(before)
    // The keeper never follows urgency_changed: B's change recomputes no order of A (R-69).
    expect(KEEPER_EVENTS).not.toContain('brand_production.urgency_changed')
  })

  it("PW-18: only A's orders named by the manager limited to B: not found (404); the planner of B, who may not override, is refused (403); A unchanged", async () => {
    const aBefore = await states([A.so2, A.alpha])
    const foreign = await post(managerB, '/production/brand-orders/urgency/regular', { orderIds: [A.so2, A.alpha], reason: LOCK_REASON, lock: true })
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(404)
    expect(foreign.body.error.message).toBe('Sales order not found.')
    const unlocked = await post(managerB, '/production/brand-orders/urgency/unlock', { orderIds: [A.so2] })
    expect(unlocked.status).toBe(404)
    const planner = await post(plannerB, '/production/brand-orders/urgency/regular', { orderIds: [B.b3], reason: LOCK_REASON, lock: false })
    expect(planner.status, JSON.stringify(planner.body)).toBe(403)
    expect(await states([A.so2, A.alpha])).toEqual(aBefore)
  })

  it('the owner over both customers: one batch, one audit row and one event PER customer, each naming only its own orders (R-48); the rows that change nothing say why', async () => {
    const answer = await post(owner, '/production/brand-orders/urgency/regular', { orderIds: [A.alpha, B.b3, B.b2], reason: LOCK_REASON, lock: true })
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(answer.body.results.map((row: Json) => [row.orderId, row.outcome])).toEqual([
      [A.alpha, 'DONE'],
      [B.b3, 'DONE'],
      [B.b2, 'UNCHANGED'],
    ])
    expect(answer.body.results[2].words).toEqual({ it: "L'ordine è già bloccato su normale.", en: 'This order is locked at Regular already.' })
    const batches = answer.body.batches as Json[]
    expect(batches.map((batch) => batch.partyId).sort()).toEqual([world.ids.a, world.ids.b].sort())
    expect(new Set(batches.map((batch) => batch.batchId)).size).toBe(2)
    for (const batch of batches) {
      const rows = await audits(batch.batchId)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.partyId).toBe(batch.partyId)
      const events = await told(batch.batchId)
      expect(events).toHaveLength(1)
      expect(events[0]!.payload.partyId).toBe(batch.partyId)
      expect(events[0]!.payload.orderIds).toEqual(batch.partyId === world.ids.a ? [A.alpha] : [B.b3])
    }
    // A's list rewritten 1..n: SEED-SO-0002 stays 1st; its 2nd is Regular and locked now.
    expect(await state(A.so2)).toMatchObject({ urgency: 'URGENT', urgentRank: 1 })
    expect(await state(A.alpha)).toMatchObject({ urgency: 'REGULAR', urgentRank: null, locked: true, setBy: 'FACTORY', setById: owner.id })
    // The card names who locked it (office only).
    const card = await read('office.all', `/production/brands/${world.ids.a}/urgency`)
    expect((card.companies[0].orders as Json[]).find((order) => order.id === A.alpha)).toMatchObject({ locked: true, lockReason: LOCK_REASON, lockedBy: { id: owner.id } })
  })

  it('a set-back without lock; an unlock; a reason of two lines or none is refused (400)', async () => {
    const back = await post(owner, '/production/brand-orders/urgency/regular', { orderIds: [A.so2], reason: 'Made-up: the planner needs this place for a sample run.', lock: false })
    expect(back.status, JSON.stringify(back.body)).toBe(200)
    expect(await state(A.so2)).toMatchObject({ urgency: 'REGULAR', urgentRank: null, locked: false, setBy: 'FACTORY' })
    expect((await told(back.body.batches[0].batchId))[0]!.payload).toMatchObject({ change: 'SET_BACK', locked: false })
    const again = await post(owner, '/production/brand-orders/urgency/regular', { orderIds: [A.so2], reason: 'Made-up', lock: false })
    expect(again.status).toBe(409)
    expect(again.body.error.issues).toEqual([{ path: 'body/orderIds/0/UNCHANGED', message: 'The order is already regular.' }])

    const unlock = await post(managerB, '/production/brand-orders/urgency/unlock', { orderIds: [B.b2, B.b3] })
    expect(unlock.status, JSON.stringify(unlock.body)).toBe(200)
    expect(await state(B.b2)).toMatchObject({ locked: false, lockReason: null, lockedById: null, urgency: 'REGULAR' })
    expect((await told(unlock.body.batches[0].batchId))[0]!.payload).toMatchObject({ change: 'UNLOCK', locked: false, orderIds: expect.arrayContaining([B.b2, B.b3]) })
    const notLocked = await post(managerB, '/production/brand-orders/urgency/unlock', { orderIds: [B.b2] })
    expect(notLocked.status).toBe(409)
    expect(notLocked.body.error.issues[0].message).toBe('This order is not locked.')

    for (const reason of ['', 'Made-up\nsecond line']) {
      const refused = await post(owner, '/production/brand-orders/urgency/regular', { orderIds: [B.b2], reason, lock: true })
      expect(refused.status, JSON.stringify(refused.body)).toBe(400)
    }
  })

  it('switched off: the marks stay (dormant) but no column, chip or backlog place counts them; the card says so', async () => {
    // fix-pr-9: B's own mark names no office person (the set-back above left our manager on the row; the database's rule
    // 202611170701 refuses a BRAND mark set by an office person).
    await admin(`UPDATE "BrandOrderProduction" SET urgency = 'URGENT', "urgentRank" = 1, "urgencySetAt" = now(), "urgencySetBy" = 'BRAND', "urgencySetById" = NULL, "urgencyBatchId" = $2, version = version + 1 WHERE key = $1`, [`brand-production:${B.b3}`, newId()])
    await admin(`UPDATE "PortalSettings" SET "productionUrgencyOn" = false, version = version + 1 WHERE "partyId" = $1`, [world.ids.b])
    const card = await read('office.all', `/production/brands/${world.ids.b}/urgency`)
    expect(card.urgency).toMatchObject({ on: false, dormant: { en: '1 urgent mark is kept but not used while this is off.' } })
    expect((card.companies[0].orders as Json[]).find((order) => order.id === B.b3)).toMatchObject({ urgency: 'URGENT', counted: false })
    const urgent = await read('office.all', '/sales/orders?limit=200&customerUrgency=URGENT')
    expect((urgent.orders as Json[]).map((row) => row.id)).not.toContain(B.b3)
    expect(await state(B.b3)).toMatchObject({ urgency: 'URGENT', urgentRank: 1 })
  })
})
