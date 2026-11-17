import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { freshGuard } from '../../../platform/auth/portal/testing/portal'
import type { Browser } from '../../../platform/auth/sessions/testing/harness'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { KEEPER_EVENTS } from '../brand/keeper'
import { findMarkers, markersOf, type Marker } from '../testing/two-brands'
import { urgencyWorld, type UrgencyWorld } from '../testing/urgency-world'

/**
 * B-PR-22a — the customer's urgency from its portal (production plan §3 "Customer urgency"; lead picks L17, L18, L20, L25; review
 * fixes R-48, R-49, R-61, R-65; the Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand.
 * But we, as the production unit, should be able to see it all. And manage it all as well.") on the local stack through the real
 * app and the real portal sign-in by code (../testing/urgency-world.ts): brand A = the seeds' P1 (SEED-SO-0002 and a new order
 * Urgent 1st and 2nd), brand B = the threads' second brand (SEED-SO-B001 locked at Regular by us) with three more orders here,
 * B's quota 2.
 *
 *   PW-11   B marks, drags or undoes with A's ids: a list is acted on only for B's own orders, A's ids only counted (never named);
 *           A's id alone is "Order not found."; A's rows never change; "n of max used" counts only B's open orders; no answer B
 *           gets carries an A name, number, code or id, a place in our plan or another customer's count
 *   +       B's Undo of A's batch (and of the harness's batch, which no audit row holds): not found, nothing changed
 *   and     the mark (at once inside the quota and before Cutting; over the quota or at Cutting "Ask us"; locked; back to Regular
 *           free), the live cut facts (a bundle made, never the stored stage: R-61), the drag and "Move to top" ("Mark urgent
 *           first"), the batch's audit "before" and Undo skipping rows changed since (R-49), one event + one audit row per command
 *           (the customer's own party: R-48), urgency off, a role without the right, never a write of the office's levers.
 *
 * Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/production/brand-portal`.
 */

let world: UrgencyWorld
const NS = 'pr22a-urgency'
type Json = Record<string, any>
const people = { alpha: 'ada.buyer@pr22a-alpha.example.com', beta: 'bea.production@pr22a-beta.example.com', betaDesigner: 'dora.designer@pr22a-beta.example.com' }
const browsers = {} as Record<keyof typeof people, Browser>
const personIds = {} as Record<keyof typeof people, string>
const B = {} as { locked: string; b2: string; b3: string; b4: string }
const A = {} as { so2: string; alpha: string }
const batches = {} as { mark: string; drag: string; undoDrag: string }
let aMarkers: Marker[] = []
const seenByB: { url: string; body: unknown }[] = []

const admin = <R = Json>(sql: string, values: unknown[] = []) => world.admin<R>(sql, values)

async function send(who: keyof typeof people, method: 'POST' | 'PUT', url: string, body: unknown): Promise<{ status: number; body: Json }> {
  const answer = await browsers[who].send(method, url, body, { headers: { 'idempotency-key': `pr22a-${newId()}` } })
  if (who !== 'alpha') seenByB.push({ url, body: answer.body })
  return { status: answer.status, body: answer.body as Json }
}
async function ok(who: keyof typeof people, method: 'POST' | 'PUT', url: string, body: unknown): Promise<Json> {
  const answer = await send(who, method, url, body)
  expect(answer.status, `${who} ${method} ${url}: ${JSON.stringify(answer.body).slice(0, 600)}`).toBe(200)
  return answer.body
}
async function refused(who: keyof typeof people, method: 'POST' | 'PUT', url: string, body: unknown, status: number): Promise<Json> {
  const answer = await send(who, method, url, body)
  expect(answer.status, `${who} ${method} ${url}: ${JSON.stringify(answer.body).slice(0, 600)}`).toBe(status)
  return answer.body.error as Json
}

/** An order's urgency as stored. */
async function state(orderId: string): Promise<Json> {
  return (
    await admin(`SELECT urgency::text, "urgentRank", "urgencySetBy"::text AS "setBy", "urgencySetById"::text AS "setById", "urgencyBatchId"::text AS "batchId", "urgencyLocked" AS locked, version FROM "BrandOrderProduction" WHERE key = $1`, [`brand-production:${orderId}`])
  )[0]!
}
const states = async (orderIds: readonly string[]) => Promise.all(orderIds.map((orderId) => state(orderId)))
/** The office's own levers on every order and work order: never written by a customer's urgency. */
const levers = async () => ({
  orders: await admin(`SELECT id::text, priority, "priorityLevel"::text, "backlogRank" FROM "SalesOrder" WHERE "tenantId" = $1 ORDER BY id`, [world.ids.tenantId]),
  workOrders: await admin(`SELECT id::text, priority, rush FROM "WorkOrder" WHERE "tenantId" = $1 ORDER BY id`, [world.ids.tenantId]),
})
const audits = (partyId: string, batchId: string) =>
  admin(`SELECT action, before, after, audience::text FROM "AuditLog" WHERE "recordType" = 'Party' AND "recordId" = $1 AND after->>'batchId' = $2 ORDER BY at, id`, [partyId, batchId])
const events = (batchId: string) => admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'brand_production.urgency_changed' AND payload->>'batchId' = $1 ORDER BY "occurredAt", id`, [batchId])

beforeAll(async () => {
  world = await urgencyWorld('pr22a_urgency', NS)
  A.so2 = world.w.production.urgent[0]
  A.alpha = world.w.production.urgent[1]
  B.locked = world.w.production.locked
  B.b2 = (await world.addOrder(world.ids.b, 'B2', '2026-10-05')).orderId
  B.b3 = (await world.addOrder(world.ids.b, 'B3', '2026-10-06')).orderId
  B.b4 = (await world.addOrder(world.ids.b, 'B4', '2026-10-07')).orderId
  const alpha = await world.portalPerson(people.alpha, world.ids.a, ['customer-buyer'])
  const beta = await world.portalPerson(people.beta, world.ids.b, ['customer-production'])
  const designer = await world.portalPerson(people.betaDesigner, world.ids.b, ['customer-designer'])
  browsers.alpha = alpha.browser
  browsers.beta = beta.browser
  browsers.betaDesigner = designer.browser
  personIds.alpha = alpha.id
  personIds.beta = beta.id
  personIds.betaDesigner = designer.id
  aMarkers = [
    ...(await markersOf(world.h.db, world.ids.a)),
    { label: "A's work order", text: world.w.a.workOrderNumber },
    { label: "A's work order", text: world.w.a.workOrderId },
    { label: 'mixed work order', text: world.w.mixed.number },
    { label: "A's urgent order", text: A.so2 },
    { label: "A's urgent order", text: A.alpha },
  ]
}, 480_000)

beforeEach(() => {
  freshGuard(world.h)
})

afterAll(async () => {
  await world?.close()
}, 60_000)

describe('B-PR-22a the customer marks its orders Urgent or Regular (POST /portal/production/urgency)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it("PW-11: B's list with A's id: only B's own orders are marked, A's id is counted and never named; one audit row, one event; no office lever written", async () => {
    const before = await levers()
    const aBefore = await states([A.so2, A.alpha])
    const answer = await ok('beta', 'POST', '/portal/production/urgency', { orderIds: [B.b2, A.alpha, B.b3], urgency: 'URGENT' })
    batches.mark = answer.batchId
    expect(answer.results.map((row: Json) => [row.orderId, row.outcome, row.done, row.urgency, row.urgentRank])).toEqual([
      [B.b2, 'DONE', true, 'URGENT', 1],
      [B.b3, 'DONE', true, 'URGENT', 2],
    ])
    expect(answer.notFound).toBe(1)
    expect(answer.use).toMatchObject({ used: 2, max: 2, agreed: 0, left: 0, over: false, words: { en: '2 of 2 urgent used' } })
    expect(JSON.stringify(answer)).not.toContain(A.alpha)

    // The rows: Urgent by the customer's own person, stamped with the batch; A's rows not touched.
    expect(await state(B.b2)).toMatchObject({ urgency: 'URGENT', urgentRank: 1, setBy: 'BRAND', setById: personIds.beta, batchId: batches.mark })
    expect(await state(B.b3)).toMatchObject({ urgency: 'URGENT', urgentRank: 2, setBy: 'BRAND', setById: personIds.beta, batchId: batches.mark })
    expect(await states([A.so2, A.alpha])).toEqual(aBefore)

    // One audit row (the customer's own party) with the state before (R-49), one event naming only B's orders (R-48).
    const rows = await audits(world.ids.b, batches.mark)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: 'portal.production.urgency', after: { partyId: world.ids.b, by: 'BRAND', change: 'MARK', undo: false } })
    expect(rows[0]!.before.orders).toEqual(expect.arrayContaining([{ orderId: B.b2, urgency: 'REGULAR', urgentRank: null }, { orderId: B.b3, urgency: 'REGULAR', urgentRank: null }]))
    expect(rows[0]!.before.orders).toHaveLength(2)
    const told = await events(batches.mark)
    expect(told).toHaveLength(1)
    expect(told[0]!.payload).toMatchObject({ partyId: world.ids.b, urgency: 'URGENT', by: 'BRAND', change: 'MARK', locked: false, undo: false, asked: false })
    expect([...told[0]!.payload.orderIds].sort()).toEqual([B.b2, B.b3].sort())

    // Never the office's levers: priority, priorityLevel, backlogRank, WorkOrder.priority, rush.
    expect(await levers()).toEqual(before)
  })

  it('over the quota: refused in words ("Ask us"); locked by us: the reason it reads; nothing changes', async () => {
    const over = await refused('beta', 'POST', '/portal/production/urgency', { orderIds: [B.b4], urgency: 'URGENT' }, 409)
    expect(over.issues).toEqual([{ path: 'body/orderIds/0/ASK_OVER_QUOTA', message: 'You have used your 2 urgent marks: ask us to make it urgent.' }])
    expect(await state(B.b4)).toMatchObject({ urgency: 'REGULAR', urgentRank: null, setBy: null })
    const locked = await refused('beta', 'POST', '/portal/production/urgency', { orderIds: [B.locked], urgency: 'URGENT' }, 409)
    expect(locked.issues[0]).toEqual({ path: 'body/orderIds/0/LOCKED', message: `Set to Regular by us: ${world.w.production.lockReason}` })
    // Back to Regular of an order that is Regular: the same already (refused, in words).
    const same = await refused('beta', 'POST', '/portal/production/urgency', { orderIds: [B.b4], urgency: 'REGULAR' }, 409)
    expect(same.issues[0]).toEqual({ path: 'body/orderIds/0/UNCHANGED', message: 'The order is already regular.' })
  })

  it("PW-11: A's id alone is an unknown order (404) for Urgent and Regular; an id named twice or 51 ids are refused (400)", async () => {
    const aBefore = await states([A.so2, A.alpha])
    for (const urgency of ['URGENT', 'REGULAR']) {
      const error = await refused('beta', 'POST', '/portal/production/urgency', { orderIds: [A.so2], urgency }, 404)
      expect(error.message).toBe('Order not found.')
    }
    expect(await states([A.so2, A.alpha])).toEqual(aBefore)
    await refused('beta', 'POST', '/portal/production/urgency', { orderIds: [B.b4, B.b4], urgency: 'URGENT' }, 400)
    await refused('beta', 'POST', '/portal/production/urgency', { orderIds: Array.from({ length: 51 }, () => newId()), urgency: 'URGENT' }, 400)
  })

  it('a portal role without portal.production.urgency is refused (403); A\'s buyer naming B\'s order finds nothing (404)', async () => {
    await refused('betaDesigner', 'POST', '/portal/production/urgency', { orderIds: [B.b4], urgency: 'URGENT' }, 403)
    const bBefore = await state(B.b4)
    await refused('alpha', 'POST', '/portal/production/urgency', { orderIds: [B.b4], urgency: 'URGENT' }, 404)
    expect(await state(B.b4)).toEqual(bBefore)
  })
})

describe("B-PR-22a the customer's Urgent list (PUT /portal/production/urgent-order)", { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('orders its Urgent list (the drag): the moved rows get the batch; one audit row and one event (ORDER)', async () => {
    const answer = await ok('beta', 'PUT', '/portal/production/urgent-order', { orderIds: [B.b3, B.b2] })
    batches.drag = answer.batchId
    expect(answer.results.map((row: Json) => [row.orderId, row.urgentRank])).toEqual([
      [B.b3, 1],
      [B.b2, 2],
    ])
    expect(await state(B.b3)).toMatchObject({ urgency: 'URGENT', urgentRank: 1, batchId: batches.drag, setBy: 'BRAND' })
    expect(await state(B.b2)).toMatchObject({ urgency: 'URGENT', urgentRank: 2, batchId: batches.drag })
    const rows = await audits(world.ids.b, batches.drag)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: 'portal.production.urgentOrder', after: { change: 'ORDER' } })
    expect(rows[0]!.before.orders).toEqual(expect.arrayContaining([{ orderId: B.b2, urgency: 'URGENT', urgentRank: 1 }, { orderId: B.b3, urgency: 'URGENT', urgentRank: 2 }]))
    expect((await events(batches.drag))[0]!.payload).toMatchObject({ partyId: world.ids.b, urgency: 'URGENT', change: 'ORDER' })
  })

  it('"Move to top" on a Regular order: "Mark urgent first"; the same order again: nothing to change', async () => {
    const regular = await refused('beta', 'PUT', '/portal/production/urgent-order', { orderIds: [B.b4, B.b3, B.b2] }, 409)
    expect(regular.issues).toEqual(expect.arrayContaining([{ path: 'body/orderIds/0', message: 'Mark urgent first' }]))
    const same = await refused('beta', 'PUT', '/portal/production/urgent-order', { orderIds: [B.b3, B.b2] }, 409)
    expect(same.message).toBe('Nothing to change: your urgent orders are in this order already.')
  })

  it("PW-11: A's id in B's list is \"Order not found.\" at its place, never named; A's rows never move", async () => {
    const aBefore = await states([A.so2, A.alpha])
    const error = await refused('beta', 'PUT', '/portal/production/urgent-order', { orderIds: [B.b3, B.b2, A.alpha] }, 409)
    expect(error.issues).toEqual([{ path: 'body/orderIds/2', message: 'Order not found.' }])
    expect(JSON.stringify(error)).not.toContain(A.alpha)
    expect(await states([A.so2, A.alpha])).toEqual(aBefore)
  })
})

describe('B-PR-22a Undo of a batch (POST /portal/production/urgency/undo; R-49)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it("puts the drag back from its audit row's before; the mark's batch is then left as it is (its rows changed since)", async () => {
    const undone = await ok('beta', 'POST', '/portal/production/urgency/undo', { batchId: batches.drag })
    batches.undoDrag = undone.batchId
    expect(undone.undone).toBe(batches.drag)
    expect(await state(B.b2)).toMatchObject({ urgency: 'URGENT', urgentRank: 1, batchId: batches.undoDrag })
    expect(await state(B.b3)).toMatchObject({ urgency: 'URGENT', urgentRank: 2, batchId: batches.undoDrag })
    expect((await audits(world.ids.b, batches.undoDrag))[0]).toMatchObject({ action: 'portal.production.urgencyUndo', after: { undo: true, undoOf: batches.drag, change: 'ORDER' } })
    expect((await events(batches.undoDrag))[0]!.payload).toMatchObject({ undo: true, change: 'ORDER', partyId: world.ids.b })

    // The mark's rows were changed since (the drag, then its undo): nothing is put back.
    const stale = await refused('beta', 'POST', '/portal/production/urgency/undo', { batchId: batches.mark }, 409)
    expect(stale.message).toBe('Nothing was undone: every order changed since.')
    expect(await state(B.b2)).toMatchObject({ urgency: 'URGENT', urgentRank: 1 })
  })

  it('back to Regular is free, and its Undo puts the order back at its old place', async () => {
    const regular = await ok('beta', 'POST', '/portal/production/urgency', { orderIds: [B.b2], urgency: 'REGULAR' })
    expect(await state(B.b2)).toMatchObject({ urgency: 'REGULAR', urgentRank: null, batchId: regular.batchId })
    expect(await state(B.b3)).toMatchObject({ urgency: 'URGENT', urgentRank: 1 })
    await ok('beta', 'POST', '/portal/production/urgency/undo', { batchId: regular.batchId })
    expect(await state(B.b2)).toMatchObject({ urgency: 'URGENT', urgentRank: 1 })
    expect(await state(B.b3)).toMatchObject({ urgency: 'URGENT', urgentRank: 2 })
  })

  it("PW-11: B's Undo of A's batch (and of the harness's batch, kept in no audit row) is not found; nothing of A changes; A undoes its own", async () => {
    const aMark = await ok('alpha', 'POST', '/portal/production/urgency', { orderIds: [A.alpha], urgency: 'REGULAR' })
    const aAfterMark = await states([A.so2, A.alpha])
    expect(aAfterMark[1]).toMatchObject({ urgency: 'REGULAR', setById: personIds.alpha })
    const bBefore = await states([B.b2, B.b3, B.b4, B.locked])
    for (const batchId of [aMark.batchId, world.w.production.batchId, newId()]) {
      const error = await refused('beta', 'POST', '/portal/production/urgency/undo', { batchId }, 404)
      expect(error.message).toBe('This change is not found: nothing to undo.')
    }
    expect(await states([A.so2, A.alpha])).toEqual(aAfterMark)
    // A's own mark changed none of B's rows (no recompute of another customer's orders: R-69).
    expect(await states([B.b2, B.b3, B.b4, B.locked])).toEqual(bBefore)
    expect(KEEPER_EVENTS).not.toContain('brand_production.urgency_changed')
    // A undoes its own batch: back to Urgent at its old place.
    await ok('alpha', 'POST', '/portal/production/urgency/undo', { batchId: aMark.batchId })
    expect(await state(A.alpha)).toMatchObject({ urgency: 'URGENT', urgentRank: 2 })
  })
})

describe('B-PR-22a the mark reads LIVE cut facts (R-61) and the switch (R-46)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('a bundle made on the order: "Ask us" (cutting has started) though the stored stage still says Preparing; a stored Cutting with no cut: at once', async () => {
    await ok('beta', 'POST', '/portal/production/urgency', { orderIds: [B.b3], urgency: 'REGULAR' })
    // B's locked order unlocked here (as our unlock would), and a bundle made of one of its work order's cells.
    await admin(`UPDATE "BrandOrderProduction" SET "urgencyLocked" = false, "urgencyLockReason" = NULL, "urgencyLockedAt" = NULL, "urgencyLockedById" = NULL, version = version + 1 WHERE key = $1`, [`brand-production:${B.locked}`])
    const cell = (await admin<{ id: string; siteId: string }>('SELECT id::text, "siteId"::text FROM "WorkOrderSize" WHERE "workOrderId" = $1 ORDER BY size LIMIT 1', [world.w.b.workOrderId]))[0]!
    await world.replica([{ sql: 'INSERT INTO "Bundle" (id, "tenantId", "siteId", "workOrderId", "workOrderSizeId", code, quantity) VALUES ($1, $2, $3, $4, $5, $6, 2)', values: [newId(), world.ids.tenantId, cell.siteId, world.w.b.workOrderId, cell.id, `T-PR22A-BN-${newId().slice(-6)}`] }])
    expect((await admin<{ stage: string }>('SELECT stage::text FROM "BrandOrderProduction" WHERE key = $1', [`brand-production:${B.locked}`]))[0]!.stage).toBe('PREPARING')
    const cut = await refused('beta', 'POST', '/portal/production/urgency', { orderIds: [B.locked], urgency: 'URGENT' }, 409)
    expect(cut.issues[0]).toEqual({ path: 'body/orderIds/0/ASK_CUT', message: 'Cutting has started on this order: ask us to make it urgent.' })

    await admin(`UPDATE "BrandOrderProduction" SET stage = 'CUTTING', "stageAt" = now(), version = version + 1 WHERE key = $1`, [`brand-production:${B.b4}`])
    const atOnce = await ok('beta', 'POST', '/portal/production/urgency', { orderIds: [B.b4], urgency: 'URGENT' })
    expect(atOnce.results[0]).toMatchObject({ orderId: B.b4, outcome: 'DONE', urgency: 'URGENT', urgentRank: 2 })
  })

  it('urgency off: the mark, the drag and an Undo are refused in words; the marks stay', async () => {
    await admin(`UPDATE "PortalSettings" SET "productionUrgencyOn" = false, version = version + 1 WHERE "partyId" = $1`, [world.ids.b])
    try {
      const marked = await refused('beta', 'POST', '/portal/production/urgency', { orderIds: [B.b3], urgency: 'URGENT' }, 409)
      expect(marked.issues[0]).toEqual({ path: 'body/orderIds/0/URGENCY_OFF', message: 'Urgent marks are not open for your orders.' })
      const dragged = await refused('beta', 'PUT', '/portal/production/urgent-order', { orderIds: [B.b4, B.b2] }, 409)
      expect(dragged.message).toBe('Urgent marks are not open for your orders.')
      expect(await state(B.b2)).toMatchObject({ urgency: 'URGENT', urgentRank: 1 })
      expect(await state(B.b4)).toMatchObject({ urgency: 'URGENT', urgentRank: 2 })
    } finally {
      await admin(`UPDATE "PortalSettings" SET "productionUrgencyOn" = true, version = version + 1 WHERE "partyId" = $1`, [world.ids.b])
    }
  })
})

describe('B-PR-22a PW-11: nothing of A in any answer B got', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it("scans every answer B's people got for A's names, codes, numbers and ids; none names a place in our plan or a count of others", () => {
    expect(seenByB.length).toBeGreaterThan(10)
    for (const seen of seenByB) {
      expect(findMarkers(seen.body, aMarkers), seen.url).toEqual([])
      expect(JSON.stringify(seen.body), seen.url).not.toMatch(/"(position|rulePosition|backlogRank|priorityLevel|workOrderId)"/)
    }
  })
})
