import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
import { callerFor } from '../../../core/command'
import { brandKeeperHandler } from '../../../modules/production/brand/keeper'
import { findMarkers, markersOf, type Marker } from '../../../modules/production/testing/two-brands'
import { urgencyWorld, type UrgencyWorld } from '../../../modules/production/testing/urgency-world'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { freshGuard } from '../../auth/portal/testing/portal'
import { systemContext } from '../../outbox/system'
import { partnerFanOut, partnerFanOutEvents } from './fan-out'
import { unsubscribeKeyOf } from './mail'

/**
 * B-PR-31 — the customer is told of its own production (production plan §6 "Notifications" L15, 06-tree B.4 P-NOTIF; review fixes
 * R-41, R-51; the Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the
 * production unit, should be able to see it all. And manage it all as well.") on the local stack through the real app
 * (modules/production/testing/urgency-world.ts): brand A = the seeds' P1, brand B = the threads' second brand, both portals on,
 * urgency on, the production asks open. A's buyer (who sees production and approves) and A's finance person (orders, no
 * production), B's Production person, all signed in by code; office people with two-factor — the owner, a planner, a sales person.
 * The worker's fan-out runs here by hand on every partner event the outbox holds after the set-up (`fanOut`), with the full
 * envelope the relay hands it; a few keeper events are planted (`tell`) where the keeper's own run is tested elsewhere.
 *
 *   PW-18   A marks its own order urgent (and B its own): nobody is told — not A, not B
 *   PW-P07  our set back / lock / unlock: ONE notice per act and customer, to that customer's people who see production, of its own
 *           orders only ("and 1 more"); an event that names another customer's order tells nothing of it; B gets nothing of A
 *   PW-15   no notice names a person (who set back, who answered, who placed a hold), an amount or the office's series; params hold
 *           the customer's own numbers only; actorId is null
 *   and     the answer to a production ask (pause refused) and our counter-offer (urgent ask: production news; a change: order news,
 *           to the finance person too), the counter's task named by the customer's own order ("Counter-offer · #N"); on hold and
 *           resumed through the real hold routes and the keeper; a stage reached and a health worse (never the first, never stale);
 *           a problem reported on two orders answered in one order's conversation (one bell group); topic PRODUCTION, never mailed
 *           at once by default.
 *
 * Every name, address and number is made up. Run with `env -u FACTORY_REDIS_URL node scripts/factory/run-pg-tests.mjs
 * platform/portal/notifications`.
 */

let world: UrgencyWorld
const NS = 'pr31-production-notices'
type Json = Record<string, any>
type Office = Awaited<ReturnType<UrgencyWorld['officePerson']>>
type Portal = Awaited<ReturnType<UrgencyWorld['portalPerson']>>
let owner: Office
let planner: Office
let sales: Office
let alphaBuyer: Portal
let alphaFinance: Portal
let betaProduction: Portal
const orders = {} as Record<'a1' | 'a2' | 'a3' | 'a4' | 'b1' | 'b2' | 'so1', string>
let aMarkers: Marker[] = []
let officeWords: string[] = []

const admin = <R = Json>(sql: string, values: unknown[] = []) => world.admin<R>(sql, values)
const T = () => world.ids.tenantId
const TODAY = () => businessDate(world.h.clock.now())
const key = () => ({ headers: { 'idempotency-key': `pr31-${newId()}` } })
const system = () => callerFor(world.h.database, systemContext(T(), `test-${newId()}`))
const fanOutOptions = () => ({ clock: world.h.clock, unsubscribeKey: unsubscribeKeyOf(world.h.auth.secrets) })

async function send(person: Office | Portal, method: 'GET' | 'POST', url: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const answer = method === 'GET' ? await person.browser.send('GET', url) : await person.browser.send('POST', url, body, key())
  return { status: answer.status, body: answer.body as Json }
}
async function ok(person: Office | Portal, method: 'GET' | 'POST', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await send(person, method, url, body)
  expect(answer.status, `${method} ${url}: ${JSON.stringify(answer.body).slice(0, 600)}`).toBe(status)
  return answer.body
}
async function stepped(person: Office, url: string, body: unknown): Promise<Json> {
  await person.stepUp()
  return ok(person, 'POST', url, body)
}
async function office(method: 'GET' | 'POST', url: string, body?: unknown, status = 200): Promise<Json> {
  const response = await world.officeApp.inject({ method, url, headers: { 'x-test-session': 'office.all', ...(method === 'POST' ? { 'idempotency-key': `pr31-${newId()}` } : {}) }, ...(body === undefined ? {} : { payload: body as object }) })
  expect(response.statusCode, `${method} ${url}: ${response.body.slice(0, 600)}`).toBe(status)
  return response.json() as Json
}
/** The customer asks from its portal (B-PR-25's route). */
async function ask(person: Portal, orderId: string, body: Json): Promise<string> {
  return (await ok(person, 'POST', `/portal/sales-orders/${orderId}/change-requests`, body, 201)).request.id as string
}
const seqOf = async (orderId: string) => (await admin<{ seq: number | null }>('SELECT "customerSeq" AS seq FROM "SalesOrder" WHERE id = $1', [orderId]))[0]!.seq

// ---- the worker, by hand -------------------------------------------------------------------------------------------------------

interface OutboxRow {
  id: string
  type: string
  version: number
  context: string
  companyId: string | null
  siteId: string | null
  subject: string
  correlationId: string
  causationId: string | null
  source: string
  occurredAt: Date
  payload: Json
}
const OUTBOX_COLUMNS = 'id::text AS id, type, version, context, "companyId"::text AS "companyId", "siteId"::text AS "siteId", subject, "correlationId", "causationId", source, "occurredAt", payload'
const envelopeOf = (row: OutboxRow): EventEnvelope =>
  ({ eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: T(), companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload }) as EventEnvelope
const outbox = (type: string) => admin<OutboxRow>(`SELECT ${OUTBOX_COLUMNS} FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [T(), type])

/** Events the set-up made, and those already handed to the fan-out: never handed twice. */
const handled = new Set<string>()
/** The worker's fan-out over every partner event the outbox holds that it has not handled yet, oldest first. */
async function fanOut(): Promise<void> {
  const rows = await admin<OutboxRow>(`SELECT ${OUTBOX_COLUMNS} FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = ANY($2::text[]) ORDER BY "occurredAt", id`, [T(), partnerFanOutEvents()])
  for (const row of rows) {
    if (handled.has(row.id)) continue
    handled.add(row.id)
    await partnerFanOut(system(), envelopeOf(row) as never, fanOutOptions())
  }
}
/** A keeper event planted straight into the fan-out (the keeper's own run is keeper.pg's). */
async function tell(type: string, payload: Json): Promise<void> {
  const eventId = newId()
  await partnerFanOut(
    system(),
    { eventId, type, version: 1, context: 'production-brand', tenantId: T(), companyId: world.w.companyId, siteId: null, subject: eventId, correlationId: `test-${eventId}`, causationId: null, source: 'test', occurredAt: new Date().toISOString(), payload } as never,
    fanOutOptions(),
  )
}
/** The keeper's handler on the hold events the outbox holds that it has not followed yet (as the worker runs it). */
const kept = new Set<string>()
async function keepHolds(): Promise<void> {
  const keeper = brandKeeperHandler()
  for (const type of ['work_order_hold.placed', 'work_order_hold.lifted']) {
    for (const row of await outbox(type)) {
      if (kept.has(row.id)) continue
      kept.add(row.id)
      await keeper.handle(envelopeOf(row), { caller: system(), attempt: 1 })
    }
  }
}

// ---- what each person got ----------------------------------------------------------------------------------------------------

interface Notice {
  id: string
  userId: string
  partyId: string
  category: string
  eventType: string
  recordType: string
  recordId: string
  recordLabel: string
  messageKey: string
  params: Json
  anchor: string | null
  actorId: string | null
  groupKey: string | null
}
const NOTICE_COLUMNS = `id::text AS id, "userId"::text AS "userId", "partyId"::text AS "partyId", category::text AS category, "eventType", "recordType", "recordId"::text AS "recordId", "recordLabel", "messageKey", params, anchor, "actorId"::text AS "actorId", "groupKey"`
const noticesOf = (userId: string) => admin<Notice>(`SELECT ${NOTICE_COLUMNS} FROM "Notification" WHERE "userId" = $1 ORDER BY "createdAt", id`, [userId])
const looked = new Map<string, number>()
/** The notices a person got since the last look. */
async function fresh(person: Portal): Promise<Notice[]> {
  const all = await noticesOf(person.id)
  const from = looked.get(person.id) ?? 0
  looked.set(person.id, all.length)
  return all.slice(from)
}
const shortOf = (notice: Notice) => ({ messageKey: notice.messageKey, recordId: notice.recordId })

beforeAll(async () => {
  world = await urgencyWorld('pr31_production_notices', NS)
  // Both customers' production asks open (the limits card's list); their urgency is on already (the world's).
  await admin(`UPDATE "PortalSettings" SET "productionAskKinds" = '{HOLD,RESUME,SPLIT_SHIPMENT,SAMPLE_ROUND}', version = version + 1 WHERE "partyId" = ANY($1::uuid[])`, [[world.ids.a, world.ids.b]])
  for (const name of ['a1', 'a2', 'a3', 'a4'] as const) orders[name] = (await world.addOrder(world.ids.a, name.toUpperCase(), '2026-10-01')).orderId
  for (const name of ['b1', 'b2'] as const) orders[name] = (await world.addOrder(world.ids.b, name.toUpperCase(), '2026-10-02')).orderId
  orders.so1 = (await admin<{ id: string }>(`SELECT id::text AS id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SEED-SO-0001'`, [T()]))[0]!.id
  owner = await world.officePerson('oscar.owner@pr31-office.example.com', 'owner')
  planner = await world.officePerson('piera.planner@pr31-office.example.com', 'planner')
  sales = await world.officePerson('saul.sales@pr31-office.example.com', 'sales')
  alphaBuyer = await world.portalPerson('anna.buyer@pr31-brand-alpha.example.com', world.ids.a, ['customer-buyer', 'partner-approve'])
  alphaFinance = await world.portalPerson('franca.finance@pr31-brand-alpha.example.com', world.ids.a, ['customer-finance'])
  betaProduction = await world.portalPerson('bruno.production@pr31-brand-beta.example.com', world.ids.b, ['customer-production', 'partner-approve'])
  // The portal reads roles on the harness clock (each sign-in moves it 61 s on), the worker's fan-out on the server clock: every
  // person here is a reader to both.
  await world.replica([{ sql: `UPDATE "RoleAssignment" SET "validFrom" = now() - interval '1 day' WHERE "userId" = ANY($1::uuid[])`, values: [[alphaBuyer.id, alphaFinance.id, betaProduction.id]] }])
  aMarkers = [
    ...(await markersOf(world.h.db, world.ids.a)),
    { label: "A's work order", text: world.w.a.workOrderId },
    ...(['a1', 'a2', 'a3', 'a4', 'so1'] as const).map((name) => ({ label: `A's order ${name}`, text: orders[name] })),
  ]
  officeWords = (await admin<{ displayName: string; email: string; id: string }>('SELECT "displayName", email, id::text AS id FROM "User" WHERE id = ANY($1::uuid[])', [[owner.id, planner.id, sales.id]])).flatMap((row) => [row.displayName, row.email, row.id])
  // What the set-up made is not this test's news.
  for (const row of await admin<{ id: string }>('SELECT id::text AS id FROM "OutboxEvent" WHERE "tenantId" = $1', [T()])) handled.add(row.id)
  for (const person of [alphaBuyer, alphaFinance, betaProduction]) await fresh(person)
}, 600_000)

beforeEach(() => {
  freshGuard(world.h)
})

afterAll(async () => {
  await world?.close()
}, 60_000)

describe('B-PR-31: the customer is told of its own production', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it("PW-18: a customer's own urgency marks tell nobody — not itself, not the other customer", async () => {
    await ok(alphaBuyer, 'POST', '/portal/production/urgency', { orderIds: [orders.a1], urgency: 'URGENT' })
    await ok(betaProduction, 'POST', '/portal/production/urgency', { orderIds: [orders.b1, orders.b2], urgency: 'URGENT' })
    const marks = (await outbox('brand_production.urgency_changed')).filter((row) => !handled.has(row.id)).map((row) => row.payload)
    expect(marks.map((payload) => [payload.partyId, payload.by, payload.change])).toEqual([
      [world.ids.a, 'BRAND', 'MARK'],
      [world.ids.b, 'BRAND', 'MARK'],
    ])
    await fanOut()
    for (const person of [alphaBuyer, alphaFinance, betaProduction]) expect(await fresh(person)).toEqual([])
  })

  it('PW-P07 / PW-15: our set back, lock and unlock — one notice per act to the people who see its production, its own orders only, "we", never a name', async () => {
    // B's two orders back to Regular in one act: ONE notice, the first order and "1 more".
    await stepped(owner, '/production/brand-orders/urgency/regular', { orderIds: [orders.b1, orders.b2], reason: 'Made-up: the planner needs these places for a sample run.', lock: false })
    // A's order locked at Regular; then unlocked.
    await stepped(owner, '/production/brand-orders/urgency/regular', { orderIds: [orders.a1], reason: 'Made-up: we wait for the deposit first.', lock: true })
    await fanOut()
    const toB = await fresh(betaProduction)
    expect(toB.map((notice) => notice.messageKey)).toEqual(['portal.production.set_regular'])
    // The first of the act's orders names the notice; the other is "1 more".
    const first = toB[0]!.recordId
    expect([orders.b1, orders.b2]).toContain(first)
    expect(toB[0]).toMatchObject({ partyId: world.ids.b, category: 'FOLLOWING', recordType: 'SalesOrder', recordLabel: `#${await seqOf(first)}`, params: { yourKind: 'ORDER', yourSeq: await seqOf(first), more: 1 }, actorId: null })
    const toA = await fresh(alphaBuyer)
    expect(toA.map(shortOf)).toEqual([{ messageKey: 'portal.production.locked', recordId: orders.a1 }])
    expect(toA[0]!.params).toEqual({ yourKind: 'ORDER', yourSeq: await seqOf(orders.a1), more: 0 })
    // The finance person sees no production: told nothing of it.
    expect(await fresh(alphaFinance)).toEqual([])

    await stepped(owner, '/production/brand-orders/urgency/unlock', { orderIds: [orders.a1] })
    await fanOut()
    expect((await fresh(alphaBuyer)).map(shortOf)).toEqual([{ messageKey: 'portal.production.unlocked', recordId: orders.a1 }])
    expect(await fresh(betaProduction)).toEqual([])

    // An act of ours naming B's order under A (a mistake the command never makes): A is told of its own order only, B of nothing.
    await tell('brand_production.urgency_changed', { partyId: world.ids.a, orderIds: [orders.b2, orders.a1], urgency: 'REGULAR', by: 'FACTORY', change: 'SET_BACK', locked: false, undo: false, asked: false, batchId: newId() })
    const forged = await fresh(alphaBuyer)
    expect(forged.map(shortOf)).toEqual([{ messageKey: 'portal.production.set_regular', recordId: orders.a1 }])
    expect(forged[0]!.params.more).toBe(0)
    expect(JSON.stringify(forged)).not.toContain(orders.b2)
    expect(await fresh(betaProduction)).toEqual([])
    // Our yes to its own "Urgent – asked" is its answer's news; with its urgency switched off, nothing either.
    await tell('brand_production.urgency_changed', { partyId: world.ids.a, orderIds: [orders.a1], urgency: 'URGENT', by: 'FACTORY', change: 'MARK', locked: false, undo: false, asked: true, batchId: newId() })
    await admin(`UPDATE "PortalSettings" SET "productionUrgencyOn" = false, version = version + 1 WHERE "partyId" = $1`, [world.ids.b])
    await tell('brand_production.urgency_changed', { partyId: world.ids.b, orderIds: [orders.b1], urgency: 'REGULAR', by: 'FACTORY', change: 'LOCK', locked: true, undo: false, asked: false, batchId: newId() })
    await admin(`UPDATE "PortalSettings" SET "productionUrgencyOn" = true, version = version + 1 WHERE "partyId" = $1`, [world.ids.b])
    expect(await fresh(alphaBuyer)).toEqual([])
    expect(await fresh(betaProduction)).toEqual([])
  })

  it('the answer to a production ask and our counter-offer: production news for its production people, a change countered is order news; the task names its own order', async () => {
    // A pause asked and refused.
    const hold = await ask(alphaBuyer, orders.a3, { kind: 'HOLD', note: 'Made-up: our store opening moved.' })
    await ok(planner, 'POST', `/production/brand-requests/${hold}/refuse`, { version: 1, answer: 'Made-up: the cutting is booked this week.' })
    // An urgent ask countered with another date.
    const rush = await ask(alphaBuyer, orders.a4, { kind: 'RUSH', note: 'Made-up: our season opens early.' })
    const rushCounter = await ok(planner, 'POST', `/production/brand-requests/${rush}/counter`, { version: 1, date: addDays(TODAY(), 20) })
    await fanOut()
    const toBuyer = await fresh(alphaBuyer)
    expect(toBuyer.filter((notice) => notice.eventType.startsWith('order_change_request.')).map((notice) => [notice.messageKey, notice.recordId, notice.anchor])).toEqual([
      ['portal.production.hold_refused', orders.a3, `change-request:${hold}`],
      ['portal.production.countered', orders.a4, `change-request:${rush}`],
    ])
    // "Waiting on you": the counter-offer's task, by the customer's own order — never the office's number it was asked with.
    const task = toBuyer.find((notice) => notice.messageKey === 'portal.task.opened')!
    expect(task).toMatchObject({ recordType: 'ApprovalRequest', recordId: rushCounter.approvalRequestId, category: 'ASSIGNMENT' })
    expect(task.recordLabel).toMatch(new RegExp(`^(Counter-offer|Controproposta) · #${await seqOf(orders.a4)}$`))
    // The finance person sees no production: neither answer reaches them (nor the task: it approves nothing).
    expect(await fresh(alphaFinance)).toEqual([])

    // A change asked and countered: order news (ORDERS) for every person who sees the orders.
    const change = await ask(alphaBuyer, orders.so1, { kind: 'CHANGE', requestedDate: addDays(TODAY(), 40), note: 'Made-up: we would like it earlier.' })
    await ok(sales, 'POST', `/production/brand-requests/${change}/counter`, { version: 1, date: addDays(TODAY(), 55) })
    await fanOut()
    expect((await fresh(alphaBuyer)).filter((notice) => notice.eventType === 'order_change_request.countered').map(shortOf)).toEqual([{ messageKey: 'portal.order.countered', recordId: orders.so1 }])
    expect((await fresh(alphaFinance)).map(shortOf)).toEqual([{ messageKey: 'portal.order.countered', recordId: orders.so1 }])
    expect(await fresh(betaProduction)).toEqual([])
  })

  it('on hold and resumed: our production hold on its own work order, through the real routes and the keeper', async () => {
    const placed = await office('POST', `/production/work-orders/${world.w.a.workOrderId}/holds`, { reasonCode: 'MATERIAL_MISSING', note: 'Made-up: the lining ships on Friday (office only).' }, 201)
    await keepHolds()
    await fanOut()
    const held = (await fresh(alphaBuyer)).filter((notice) => notice.eventType === 'brand_production.hold_changed')
    expect(held.map(shortOf)).toEqual([{ messageKey: 'portal.production.on_hold', recordId: world.w.a.salesOrderId }])
    // The office's note never reaches it; neither does B hear of A's hold.
    expect(JSON.stringify(held)).not.toContain('lining')
    expect(await fresh(betaProduction)).toEqual([])

    await office('POST', `/production/work-orders/${world.w.a.workOrderId}/holds/${placed.hold.id}/lift`, { version: placed.hold.version, reason: 'Made-up: the lining arrived.' })
    await keepHolds()
    await fanOut()
    expect((await fresh(alphaBuyer)).filter((notice) => notice.eventType === 'brand_production.hold_changed').map(shortOf)).toEqual([{ messageKey: 'portal.production.hold_lifted', recordId: world.w.a.salesOrderId }])
    expect(await fresh(betaProduction)).toEqual([])
    expect(await fresh(alphaFinance)).toEqual([])
  })

  it('a stage reached and a health worse: told while the order is there, never its first, never stale, never of another customer', async () => {
    const row = `brand-production:${orders.a2}`
    await world.replica([{ sql: `UPDATE "BrandOrderProduction" SET stage = 'CUTTING', health = 'AT_RISK', version = version + 1 WHERE key = $1`, values: [row] }])
    await tell('brand_production.stage_reached', { orderId: orders.a2, partyId: world.ids.a, stage: 'CUTTING', previous: 'PREPARING' })
    await tell('brand_production.health_changed', { orderId: orders.a2, partyId: world.ids.a, health: 'AT_RISK', previous: 'ON_TRACK', byNote: false })
    expect((await fresh(alphaBuyer)).map(shortOf)).toEqual([
      { messageKey: 'portal.production.cutting', recordId: orders.a2 },
      { messageKey: 'portal.production.at_risk', recordId: orders.a2 },
    ])
    // The first keep, a stage the order no longer shows, a health it no longer reads, a better one: nothing.
    await tell('brand_production.stage_reached', { orderId: orders.a2, partyId: world.ids.a, stage: 'SEWING', previous: null })
    await tell('brand_production.stage_reached', { orderId: orders.a2, partyId: world.ids.a, stage: 'SEWING', previous: 'CUTTING' })
    await tell('brand_production.health_changed', { orderId: orders.a2, partyId: world.ids.a, health: 'LATE', previous: 'AT_RISK', byNote: false })
    await tell('brand_production.health_changed', { orderId: orders.a2, partyId: world.ids.a, health: 'AT_RISK', previous: 'LATE', byNote: false })
    // B's order named under A: told to nobody; under B, to B only.
    await world.replica([{ sql: `UPDATE "BrandOrderProduction" SET stage = 'CUTTING', version = version + 1 WHERE key = $1`, values: [`brand-production:${orders.b2}`] }])
    await tell('brand_production.stage_reached', { orderId: orders.b2, partyId: world.ids.a, stage: 'CUTTING', previous: 'PREPARING' })
    expect(await fresh(alphaBuyer)).toEqual([])
    expect(await fresh(betaProduction)).toEqual([])
    await tell('brand_production.stage_reached', { orderId: orders.b2, partyId: world.ids.b, stage: 'CUTTING', previous: 'PREPARING' })
    expect((await fresh(betaProduction)).map(shortOf)).toEqual([{ messageKey: 'portal.production.cutting', recordId: orders.b2 }])
    expect(await fresh(alphaBuyer)).toEqual([])
    expect(await fresh(alphaFinance)).toEqual([])
  })

  it('a problem it reported on two orders, answered in one order’s conversation: "answered" and "answered in your order N", one bell group; an office issue tells nothing', async () => {
    const batchId = newId()
    const answeredAt = new Date()
    const issue = (orderId: string, source: 'BRAND' | 'OFFICE', batch: string | null) => ({
      sql: `INSERT INTO "ProductionIssue" (id, "tenantId", "companyId", "partyId", "recordType", "recordId", "salesOrderId", "taskId", "messageId", source, "batchId", status, "raisedAt", "dueDate", "answeredAt", version, "createdAt", "updatedAt")
            VALUES ($1, $2, $3, $4, 'SalesOrder', $5, $5, $6, $7, $8::"IssueSource", $9, 'ANSWERED', $10, $11, $10, 1, now(), now())`,
      values: [newId(), T(), world.w.companyId, world.ids.a, orderId, newId(), newId(), source, batch, answeredAt, TODAY()],
    })
    const rows = [issue(orders.a2, 'BRAND', batchId), issue(orders.a3, 'BRAND', batchId), issue(orders.a4, 'OFFICE', null)]
    await world.replica(rows)
    const [onA2, onA3, officeIssue] = rows.map((statement) => statement.values[0] as string)
    await tell('production_issue.answered', { issueId: onA2, partyId: world.ids.a, source: 'BRAND', salesOrderId: orders.a2, batchId, answeredInOrderId: orders.a2 })
    await tell('production_issue.answered', { issueId: onA3, partyId: world.ids.a, source: 'BRAND', salesOrderId: orders.a3, batchId, answeredInOrderId: orders.a2 })
    await tell('production_issue.answered', { issueId: officeIssue, partyId: world.ids.a, source: 'OFFICE', salesOrderId: orders.a4, batchId: null, answeredInOrderId: null })
    // Answered in B's order (never so): A's order reads "answered", never B's.
    await tell('production_issue.answered', { issueId: onA3, partyId: world.ids.a, source: 'BRAND', salesOrderId: orders.a3, batchId, answeredInOrderId: orders.b1 })
    const toA = await fresh(alphaBuyer)
    expect(toA.map((notice) => [notice.messageKey, notice.recordId])).toEqual([
      ['portal.production.problem_answered', orders.a2],
      ['portal.production.problem_answered_in', orders.a3],
      ['portal.production.problem_answered', orders.a3],
    ])
    expect(toA[1]!.params).toEqual({ yourKind: 'ORDER', yourSeq: await seqOf(orders.a3), inSeq: await seqOf(orders.a2) })
    expect(JSON.stringify(toA)).not.toContain(orders.b1)
    // One batch: one group in the bell, its sentence by the customer's own numbers.
    expect(new Set(toA.map((notice) => notice.groupKey)).size).toBe(1)
    const bell = await ok(alphaBuyer, 'GET', '/portal/notifications?limit=50')
    const group = (bell.items as Json[]).find((item) => item.group.ids.includes(toA[0]!.id))!
    expect(group.group.count).toBe(3)
    expect(group.sentence.en).toMatch(/^We answered the problem you reported on your order \d+/)
    expect(await fresh(betaProduction)).toEqual([])
  })

  it('PW-P07 / PW-15: every notice of this file names its own customer only, by its own numbers; no person, no amount, no office series; production news is not mailed at once', async () => {
    const people = [
      { person: alphaBuyer, partyId: world.ids.a },
      { person: alphaFinance, partyId: world.ids.a },
      { person: betaProduction, partyId: world.ids.b },
    ]
    const all = (await Promise.all(people.map(async ({ person, partyId }) => (await noticesOf(person.id)).map((notice) => ({ ...notice, partyOfUser: partyId }))))).flat()
    expect(all.length).toBeGreaterThan(10)
    const ALLOWED = new Set(['yourKind', 'yourSeq', 'more', 'inSeq', 'kind', 'taskId', 'dueAt'])
    for (const notice of all) {
      expect(notice.partyId, notice.messageKey).toBe(notice.partyOfUser)
      expect(notice.actorId, notice.messageKey).toBeNull()
      for (const name of Object.keys(notice.params ?? {})) expect(ALLOWED.has(name), `${notice.messageKey}.${name}`).toBe(true)
      expect(notice.recordLabel, notice.messageKey).not.toMatch(/SO-|T-URG-|WO-/)
      for (const word of officeWords) expect(JSON.stringify(notice), `${notice.messageKey} names ${word}`).not.toContain(word)
    }
    // B: nothing of A, in its rows or in its bell.
    const ofB = all.filter((notice) => notice.userId === betaProduction.id)
    expect(ofB.length).toBeGreaterThan(0)
    expect(findMarkers(ofB, aMarkers)).toEqual([])
    const bellB = await ok(betaProduction, 'GET', '/portal/notifications?limit=50')
    expect(findMarkers(bellB, aMarkers)).toEqual([])
    for (const word of officeWords) expect(JSON.stringify(bellB)).not.toContain(word)
    // A's bell: the sentences by its own numbers, never a person or the office's series.
    const bellA = await ok(alphaBuyer, 'GET', '/portal/notifications?limit=50')
    for (const item of bellA.items as Json[]) {
      expect(`${item.sentence.en} ${item.sentence.it}`).not.toMatch(/SO-|T-URG-|WO-/)
      for (const word of officeWords) expect(JSON.stringify(item)).not.toContain(word)
    }
    // Topic PRODUCTION is a daily summary by default: none of its notices was mailed at once.
    const production = all.filter((notice) => notice.messageKey.startsWith('portal.production.')).map((notice) => notice.id)
    expect(production.length).toBeGreaterThan(0)
    const mailed = await admin<{ n: string }>(`SELECT count(*)::text AS n FROM "NotificationDelivery" WHERE "notificationId" = ANY($1::uuid[]) AND channel = 'EMAIL'`, [production])
    expect(mailed[0]!.n).toBe('0')
    // The change countered is order news: mailed at once (or skipped for a mail of the record a moment ago), never left for a summary.
    const orderNews = all.filter((notice) => notice.messageKey === 'portal.order.countered').map((notice) => notice.id)
    const orderMails = await admin<{ n: string }>(`SELECT count(*)::text AS n FROM "NotificationDelivery" WHERE "notificationId" = ANY($1::uuid[]) AND channel = 'EMAIL'`, [orderNews])
    expect(Number(orderMails[0]!.n)).toBe(orderNews.length)
  })
})
