import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
import { freshGuard } from '../../../platform/auth/portal/testing/portal'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { findMarkers, markersOf, type Marker } from '../testing/two-brands'
import { urgencyWorld, type UrgencyWorld } from '../testing/urgency-world'

/**
 * B-PR-46a — a customer's bulk asks on My production and the office's answer to a batch as one group (production plan §3 "Bulk
 * asks: one request per order, one batch; one kind per batch; Approvals shows the batch as one group"; lead picks L25, L26; review
 * fixes R-50, R-51; the Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as
 * the production unit, should be able to see it all. And manage it all as well.") on the local stack through the real app
 * (../testing/urgency-world.ts): brand A = the seeds' P1 (urgency on, quota 3, two orders Urgent already), brand B = the threads'
 * second brand; both with the pause and resume asks open; A's buyer and B's Production person signed in by code; office people
 * with two-factor — a planner over every customer, a planner limited to B, a sales person.
 *
 *   PW-12 (asks part)  B's Ask N with A's order among its own: A's id is neither asked nor named (counted), A's order gets no
 *                      request; a batch holds ONE customer and ONE kind (the database's own check refuses another customer or
 *                      kind); B's Undo of A's batch and A's of B's: not found; B's planner does not reach A's batch; no answer B's
 *                      people got names anything of A
 *   Ask N              one request per order, one batch, one kind; the fields checked once (400); each order's own verdict (one
 *                      waiting already, not paused) in words; nothing asked: 409; a retry with the same key joins the same batch
 *                      and asks nothing twice; ONE order_change_request.batch_asked per batch, each asked naming the batch
 *   Undo               the batch's open requests withdrawn; again: nothing left (409)
 *   Mark urgent        over the quota the orders become "Urgent – asked" (RUSH) of one batch with the need-by date; the one inside
 *                      the quota at once
 *   the office         the batch read as one group; accepted as one (each through its kind's own accept: "Urgent – asked" as
 *                      urgent; a cancel through Sales'), each re-checked at its version; refused as one with words; the kind's
 *                      permission (Sales does not answer an urgent ask)
 *
 * Every name, address and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/production/brand-portal`.
 */

let world: UrgencyWorld
const NS = 'pr46a-bulk-asks'
type Json = Record<string, any>
type Office = Awaited<ReturnType<UrgencyWorld['officePerson']>>
type Portal = Awaited<ReturnType<UrgencyWorld['portalPerson']>>
let planner: Office
let plannerB: Office
let sales: Office
let buyerA: Portal
let productionB: Portal
let designerB: Portal
const A = {} as Record<'u1' | 'u2' | 'u3', string>
const B = {} as Record<'h1' | 'h2' | 'c1', string>
let aMarkers: Marker[] = []
const seenByB: { url: string; body: unknown }[] = []

const admin = <R = Json>(sql: string, values: unknown[] = []) => world.admin<R>(sql, values)
const freshKey = () => `pr46a-${newId()}`
const TODAY = () => businessDate(world.h.clock.now())

async function send(person: Office | Portal, method: 'GET' | 'POST', url: string, body?: unknown, key = freshKey()): Promise<{ status: number; body: Json }> {
  const answer = method === 'GET' ? await person.browser.send('GET', url) : await person.browser.send('POST', url, body, { headers: { 'idempotency-key': key } })
  if (person === productionB || person === designerB || person === plannerB) seenByB.push({ url, body: answer.body })
  return { status: answer.status, body: answer.body as Json }
}
async function ok(person: Office | Portal, method: 'GET' | 'POST', url: string, body?: unknown, key?: string): Promise<Json> {
  const answer = await send(person, method, url, body, key)
  expect(answer.status, `${method} ${url}: ${JSON.stringify(answer.body).slice(0, 600)}`).toBe(200)
  return answer.body
}
async function refused(person: Office | Portal, method: 'GET' | 'POST', url: string, body: unknown, status: number): Promise<Json> {
  const answer = await send(person, method, url, body)
  expect(answer.status, `${method} ${url}: ${JSON.stringify(answer.body).slice(0, 600)}`).toBe(status)
  return answer.body.error as Json
}

const requestsOf = (orderIds: readonly string[]) =>
  admin<{ id: string; orderId: string; partyId: string; kind: string; status: string; batchId: string | null; version: number }>(
    'SELECT id::text, "orderId"::text AS "orderId", "partyId"::text AS "partyId", kind::text, status::text, "batchId"::text AS "batchId", version FROM "OrderChangeRequest" WHERE "orderId" = ANY($1::uuid[]) ORDER BY "createdAt", id',
    [[...orderIds]],
  )
const outbox = (type: string) => admin<{ payload: Json }>('SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id', [world.ids.tenantId, type])
const urgencyOf = (orderId: string) =>
  admin<{ urgency: string; urgentRank: number | null; setBy: string | null }>(`SELECT urgency::text, "urgentRank", "urgencySetBy"::text AS "setBy" FROM "BrandOrderProduction" WHERE key = 'brand-production:' || $1::text`, [orderId]).then((rows) => rows[0]!)

beforeAll(async () => {
  world = await urgencyWorld('pr46a_bulk_asks', NS)
  await admin(`UPDATE "PortalSettings" SET "productionAskKinds" = '{HOLD,RESUME}', version = version + 1 WHERE "partyId" = ANY($1::uuid[])`, [[world.ids.a, world.ids.b]])
  for (const name of ['u1', 'u2', 'u3'] as const) A[name] = (await world.addOrder(world.ids.a, `BA-${name.toUpperCase()}`, '2026-10-01')).orderId
  for (const name of ['h1', 'h2', 'c1'] as const) B[name] = (await world.addOrder(world.ids.b, `BB-${name.toUpperCase()}`, '2026-10-02')).orderId
  planner = await world.officePerson('pia.planner@pr46a-office.example.com', 'planner')
  plannerB = await world.officePerson('ben.planner@pr46a-office.example.com', 'planner', [world.ids.b])
  sales = await world.officePerson('sara.sales@pr46a-office.example.com', 'sales')
  buyerA = await world.portalPerson('amy.buyer@pr46a-brand-alpha.example.com', world.ids.a, ['customer-buyer'])
  productionB = await world.portalPerson('bea.production@pr46a-brand-beta.example.com', world.ids.b, ['customer-production'])
  designerB = await world.portalPerson('dora.designer@pr46a-brand-beta.example.com', world.ids.b, ['customer-designer'])
  aMarkers = [
    ...(await markersOf(world.h.db, world.ids.a)),
    { label: "A's work order", text: world.w.a.workOrderNumber },
    { label: "A's order", text: world.w.production.urgent[0] },
    { label: "A's order", text: A.u1 },
    { label: "A's order", text: A.u2 },
    { label: "A's order", text: A.u3 },
  ]
}, 600_000)

beforeEach(() => {
  freshGuard(world.h)
})

afterAll(async () => {
  await world?.close()
}, 60_000)

describe('B-PR-46a Ask N (POST /portal/production/asks) and its Undo', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const batches = {} as { hold: string }

  it("PW-12: B's pause of its own orders with A's order among them — one request per own order, one batch, one kind; A's id neither asked nor named", async () => {
    const aBefore = await requestsOf([world.w.production.urgent[0]])
    const key = freshKey()
    const answer = await ok(productionB, 'POST', '/portal/production/asks', { orderIds: [B.h1, world.w.production.urgent[0], B.h2], kind: 'HOLD', reason: 'Made-up: our shop refit moves.' }, key)
    batches.hold = answer.batchId
    expect(answer).toMatchObject({ kind: 'HOLD', notFound: 1, replayed: false })
    expect(answer.results.map((row: Json) => [row.orderId, row.done, row.code])).toEqual([
      [B.h1, true, null],
      [B.h2, true, null],
    ])
    expect(answer.results[0].words).toEqual({ it: 'Richiesto: vi rispondiamo noi.', en: 'Asked: we answer you.' })
    expect(JSON.stringify(answer)).not.toContain(world.w.production.urgent[0])

    // The requests: one per own order, of B, of one kind and one batch; A's order got none.
    const rows = await requestsOf([B.h1, B.h2])
    expect(rows.map((row) => [row.orderId, row.partyId, row.kind, row.status, row.batchId])).toEqual([
      [B.h1, world.ids.b, 'HOLD', 'OPEN', batches.hold],
      [B.h2, world.ids.b, 'HOLD', 'OPEN', batches.hold],
    ])
    expect(await requestsOf([world.w.production.urgent[0]])).toEqual(aBefore)
    // The database keeps a batch to one customer and one kind (B-PR-23's check, asked here of this batch).
    const batchOk = (partyId: string, kind: string) => admin<{ ok: boolean }>('SELECT "factory_order_change_request_batch_ok"($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid) AS ok', [world.ids.tenantId, batches.hold, partyId, kind, newId()]).then((found) => found[0]!.ok)
    expect(await batchOk(world.ids.b, 'HOLD')).toBe(true)
    expect(await batchOk(world.ids.a, 'HOLD')).toBe(false)
    expect(await batchOk(world.ids.b, 'CANCEL')).toBe(false)

    // Each asked names the batch; the batch told ONCE, to the office only (B-PR-32's notice), naming B alone.
    const asked = (await outbox('order_change_request.asked')).filter((row) => row.payload.batchId === batches.hold)
    expect(asked.map((row) => row.payload.orderId).sort()).toEqual([B.h1, B.h2].sort())
    expect((await outbox('order_change_request.batch_asked')).filter((row) => row.payload.batchId === batches.hold).map((row) => row.payload)).toEqual([{ batchId: batches.hold, partyId: world.ids.b, kind: 'HOLD', count: 2 }])

    // A retry with the same key joins the same batch and asks nothing twice; no second batch_asked.
    const again = await ok(productionB, 'POST', '/portal/production/asks', { orderIds: [B.h1, world.w.production.urgent[0], B.h2], kind: 'HOLD', reason: 'Made-up: our shop refit moves.' }, key)
    expect(again).toMatchObject({ batchId: batches.hold, replayed: true })
    expect(again.results.map((row: Json) => row.requestId)).toEqual(answer.results.map((row: Json) => row.requestId))
    expect(await requestsOf([B.h1, B.h2])).toHaveLength(2)
    expect((await outbox('order_change_request.batch_asked')).filter((row) => row.payload.batchId === batches.hold)).toHaveLength(1)
  })

  it("each order's own verdict in words: a pause waits already, an order not paused cannot resume; nothing asked: 409", async () => {
    const twice = await refused(productionB, 'POST', '/portal/production/asks', { orderIds: [B.h1, B.h2], kind: 'HOLD', reason: 'Made-up: again.' }, 409)
    expect(twice.issues.map((issue: Json) => issue.path)).toEqual(['body/orderIds/0/WAITING', 'body/orderIds/1/WAITING'])
    expect(twice.message).toBe('Nothing was asked: see each order.')
    const resume = await refused(productionB, 'POST', '/portal/production/asks', { orderIds: [B.c1], kind: 'RESUME' }, 409)
    expect(resume.issues).toEqual([{ path: 'body/orderIds/0/NOT_PAUSED', message: 'The order is not paused' }])
    expect(await requestsOf([B.c1])).toEqual([])
  })

  it('the fields once for every order (400); urgent is never asked here; 51 orders or one named twice: 400; A’s id alone: 404; no ask right: 403', async () => {
    expect((await refused(productionB, 'POST', '/portal/production/asks', { orderIds: [B.c1], kind: 'HOLD' }, 400)).issues).toEqual([{ path: 'body/reason', message: 'Say why you want to pause, in a few words.' }])
    expect((await refused(productionB, 'POST', '/portal/production/asks', { orderIds: [B.c1], kind: 'CANCEL' }, 400)).issues).toEqual([{ path: 'body/reasonCode', message: 'Pick a reason.' }])
    expect((await refused(productionB, 'POST', '/portal/production/asks', { orderIds: [B.c1], kind: 'CANCEL', reasonCode: 'OTHER' }, 400)).issues).toEqual([{ path: 'body/reason', message: 'Say why in a few words.' }])
    expect((await refused(productionB, 'POST', '/portal/production/asks', { orderIds: [B.c1], kind: 'CANCEL', reasonCode: 'NO-SUCH-REASON' }, 400)).issues).toEqual([{ path: 'body/reasonCode', message: 'Pick one of the reasons offered.' }])
    await refused(productionB, 'POST', '/portal/production/asks', { orderIds: [B.c1], kind: 'RUSH' }, 400)
    await refused(productionB, 'POST', '/portal/production/asks', { orderIds: [B.c1, B.c1], kind: 'RESUME' }, 400)
    await refused(productionB, 'POST', '/portal/production/asks', { orderIds: Array.from({ length: 51 }, () => newId()), kind: 'RESUME' }, 400)
    const alone = await refused(productionB, 'POST', '/portal/production/asks', { orderIds: [A.u1], kind: 'HOLD', reason: 'Made-up.' }, 404)
    expect(alone.message).toBe('Order not found.')
    await refused(designerB, 'POST', '/portal/production/asks', { orderIds: [B.c1], kind: 'HOLD', reason: 'Made-up.' }, 403)
    expect(await requestsOf([B.c1, A.u1])).toEqual([])
  })

  it("PW-12: A's Undo of B's batch is not found; B's Undo withdraws the batch's open requests; again: nothing left (409)", async () => {
    const foreign = await refused(buyerA, 'POST', `/portal/production/asks/${batches.hold}/withdraw`, {}, 404)
    expect(foreign.message).toBe('These requests are not found.')
    expect((await refused(productionB, 'POST', `/portal/production/asks/${newId()}/withdraw`, {}, 404)).message).toBe('These requests are not found.')
    expect((await requestsOf([B.h1, B.h2])).map((row) => row.status)).toEqual(['OPEN', 'OPEN'])

    const undone = await ok(productionB, 'POST', `/portal/production/asks/${batches.hold}/withdraw`, {})
    expect(undone.results.map((row: Json) => [row.orderId, row.done, row.outcome])).toEqual([
      [B.h1, true, 'WITHDRAWN'],
      [B.h2, true, 'WITHDRAWN'],
    ])
    expect((await requestsOf([B.h1, B.h2])).map((row) => row.status)).toEqual(['WITHDRAWN', 'WITHDRAWN'])
    expect((await outbox('order_change_request.withdrawn')).filter((row) => [B.h1, B.h2].includes(row.payload.orderId))).toHaveLength(2)
    const again = await refused(productionB, 'POST', `/portal/production/asks/${batches.hold}/withdraw`, {}, 409)
    expect(again.issues.map((issue: Json) => issue.path)).toEqual(['batch/0/ALREADY', 'batch/1/ALREADY'])
  })
})

describe('B-PR-46a Mark urgent: over the quota the orders become "Urgent – asked" of one batch', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const rush = {} as { batchId: string; requests: { id: string; orderId: string }[] }

  it('one at once inside the quota, two "Urgent – asked" with the need-by date, one batch; the batch told once', async () => {
    const needBy = addDays(TODAY(), 10)
    const answer = await ok(buyerA, 'POST', '/portal/production/urgency', { orderIds: [A.u1, A.u2, A.u3], urgency: 'URGENT', requestedDate: needBy })
    expect(answer.batchId).toEqual(expect.any(String))
    expect(answer.askBatchId).toEqual(expect.any(String))
    expect(answer.results.map((row: Json) => [row.orderId, row.outcome, row.done, row.asked === null])).toEqual([
      [A.u1, 'DONE', true, true],
      [A.u2, 'ASK_OVER_QUOTA', false, false],
      [A.u3, 'ASK_OVER_QUOTA', false, false],
    ])
    expect(answer.results[1].words.en).toBe('You have used your 3 urgent marks: sent to us as "Urgent – asked": we answer you.')
    expect(await urgencyOf(A.u1)).toMatchObject({ urgency: 'URGENT', urgentRank: 3, setBy: 'BRAND' })
    expect(await urgencyOf(A.u2)).toMatchObject({ urgency: 'REGULAR', urgentRank: null })

    const rows = await requestsOf([A.u2, A.u3])
    expect(rows.map((row) => [row.orderId, row.partyId, row.kind, row.status, row.batchId])).toEqual([
      [A.u2, world.ids.a, 'RUSH', 'OPEN', answer.askBatchId],
      [A.u3, world.ids.a, 'RUSH', 'OPEN', answer.askBatchId],
    ])
    const dates = await admin<{ day: string }>('SELECT to_char("requestedDate", \'YYYY-MM-DD\') AS day FROM "OrderChangeRequest" WHERE "batchId" = $1', [answer.askBatchId])
    expect(dates.map((row) => row.day)).toEqual([needBy, needBy])
    expect((await outbox('order_change_request.batch_asked')).filter((row) => row.payload.batchId === answer.askBatchId).map((row) => row.payload)).toEqual([{ batchId: answer.askBatchId, partyId: world.ids.a, kind: 'RUSH', count: 2 }])
    rush.batchId = answer.askBatchId
    rush.requests = rows.map((row) => ({ id: row.id, orderId: row.orderId }))
  })

  it('the office reads the batch as one group; B’s planner does not reach it; Sales does not answer an urgent ask', async () => {
    const group = await ok(planner, 'GET', `/production/brand-requests?batchId=${rush.batchId}`)
    expect(group.items.map((row: Json) => [row.orderId, row.kind, row.batch])).toEqual(rush.requests.map((request) => [request.orderId, 'RUSH', { id: rush.batchId, count: 2, waiting: 2 }]))
    const forB = await ok(plannerB, 'GET', `/production/brand-requests?batchId=${rush.batchId}`)
    expect(forB).toMatchObject({ items: [], count: 0 })
    const items = rush.requests.map((request) => ({ requestId: request.id, version: 1 }))
    const foreign = await refused(plannerB, 'POST', `/production/brand-requests/batches/${rush.batchId}/accept`, { items }, 404)
    expect(foreign.message).toBe('Customer requests not found.')
    expect((await refused(plannerB, 'POST', `/production/brand-requests/batches/${newId()}/accept`, { items }, 404)).message).toBe('Customer requests not found.')
    await refused(sales, 'POST', `/production/brand-requests/batches/${rush.batchId}/accept`, { items }, 403)
    // Nothing answered by the refusals.
    expect((await requestsOf([A.u2, A.u3])).map((row) => row.status)).toEqual(['OPEN', 'OPEN'])
  })

  it('accepted as one group: each through its own accept ("Accept as urgent"), each at its version; a retry replays; a fresh one finds them answered', async () => {
    const items = rush.requests.map((request) => ({ requestId: request.id, version: 1 }))
    const key = freshKey()
    const accepted = await ok(planner, 'POST', `/production/brand-requests/batches/${rush.batchId}/accept`, { items: [...items, { requestId: newId(), version: 1 }], answer: 'Made-up: agreed, both move up.' }, key)
    expect(accepted.notFound).toBe(1)
    expect(accepted.results.map((row: Json) => [row.orderId, row.done, row.problem])).toEqual(rush.requests.map((request) => [request.orderId, true, null]))
    expect(accepted.requests.map((row: Json) => row.status)).toEqual(['ACCEPTED', 'ACCEPTED'])
    expect(await urgencyOf(A.u2)).toMatchObject({ urgency: 'URGENT', urgentRank: 4, setBy: 'FACTORY' })
    expect(await urgencyOf(A.u3)).toMatchObject({ urgency: 'URGENT', urgentRank: 5, setBy: 'FACTORY' })
    expect((await outbox('order_change_request.answered')).filter((row) => rush.requests.some((request) => request.id === row.payload.requestId)).map((row) => row.payload.answer)).toEqual(['ACCEPTED', 'ACCEPTED'])

    const replay = await ok(planner, 'POST', `/production/brand-requests/batches/${rush.batchId}/accept`, { items: [...items, { requestId: newId(), version: 1 }], answer: 'Made-up: agreed, both move up.' }, key)
    expect(replay.results.map((row: Json) => row.done)).toEqual([true, true])
    const fresh = await refused(planner, 'POST', `/production/brand-requests/batches/${rush.batchId}/accept`, { items }, 409)
    expect(fresh.issues).toHaveLength(2)
  })
})

describe('B-PR-46a the office refuses a batch as one group; a cancel batch accepted through Sales', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it("B's planner refuses B's pause batch with words; rush the floor is refused on it; every request REFUSED", async () => {
    const asked = await ok(productionB, 'POST', '/portal/production/asks', { orderIds: [B.h1, B.h2], kind: 'HOLD', reason: 'Made-up: a second time.' })
    const items = (await requestsOf([B.h1, B.h2])).filter((row) => row.batchId === asked.batchId).map((row) => ({ requestId: row.id, version: row.version }))
    expect(items).toHaveLength(2)
    expect((await refused(plannerB, 'POST', `/production/brand-requests/batches/${asked.batchId}/accept`, { items, rushFloor: true }, 400)).message).toBe('Rush the floor is only for a batch of "Urgent – asked".')
    await refused(plannerB, 'POST', `/production/brand-requests/batches/${asked.batchId}/refuse`, { items, answer: '   ' }, 400)
    const done = await ok(plannerB, 'POST', `/production/brand-requests/batches/${asked.batchId}/refuse`, { items, answer: 'Made-up: we cannot pause these this week.' })
    expect(done.results.map((row: Json) => [row.done, row.words])).toEqual([
      [true, { it: 'Rifiutata.', en: 'Refused.' }],
      [true, { it: 'Rifiutata.', en: 'Refused.' }],
    ])
    expect((await requestsOf([B.h1, B.h2])).filter((row) => row.batchId === asked.batchId).map((row) => row.status)).toEqual(['REFUSED', 'REFUSED'])
    // The production unit sees it all: the planner over every customer reads the same group.
    expect((await ok(planner, 'GET', `/production/brand-requests?batchId=${asked.batchId}&status=ALL`)).items).toHaveLength(2)
  })

  it('a cancel batch: asked with a reason, accepted as one by Sales (orders.manage) through its own accept: the order cancelled', async () => {
    const asked = await ok(productionB, 'POST', '/portal/production/asks', { orderIds: [B.c1], kind: 'CANCEL', reasonCode: 'LEAD_TIME' })
    const [row] = (await requestsOf([B.c1])).filter((entry) => entry.batchId === asked.batchId)
    expect(row).toMatchObject({ kind: 'CANCEL', status: 'OPEN' })
    // Production's planner does not answer a cancel (orders.manage): 403 in words.
    await refused(plannerB, 'POST', `/production/brand-requests/batches/${asked.batchId}/accept`, { items: [{ requestId: row!.id, version: 1 }] }, 403)
    const accepted = await ok(sales, 'POST', `/production/brand-requests/batches/${asked.batchId}/accept`, { items: [{ requestId: row!.id, version: 1 }] })
    expect(accepted.results[0]).toMatchObject({ done: true, words: { en: 'Accepted.' }, problem: null })
    expect((await admin<{ status: string }>('SELECT status::text FROM "SalesOrder" WHERE id = $1', [B.c1]))[0]!.status).toBe('CANCELLED')
  })
})

describe('B-PR-46a PW-12: nothing of A in any answer B got', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it("scans every answer B's people got for A's names, codes, numbers and ids", () => {
    expect(seenByB.length).toBeGreaterThan(10)
    for (const seen of seenByB) expect(findMarkers(seen.body, aMarkers), seen.url).toEqual([])
  })
})
