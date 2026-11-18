import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { callerFor } from '../../../core/command'
import { freshGuard } from '../../../platform/auth/portal/testing/portal'
import { workOrders as workOrderExport } from '../../../platform/exports/sources/work-orders'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { findMarkers, markersOf, twoBrandSessions, type Marker } from '../testing/two-brands'
import { urgencyWorld, type UrgencyWorld } from '../testing/urgency-world'

/**
 * B-PR-33 — Production › Overview, the all-customers read, and PW-01 (06-tree §0.6: "Overview: rep-B tiles, brand rows, WIP and
 * urgent list hold only B; Total = B only; manager sees A and B"); the Owner rule 2026-11-16: "One brand must not be able to see
 * anything related to any other brand. But we, as the production unit, should be able to see it all. And manage it all as well."
 *
 * On the local stack through the real app (../testing/urgency-world.ts: brand A = the seeds' P1, brand B = the threads' second brand,
 * both portals on; the harness's work order of each brand and one MIXED work order made before the one-customer rule). The test adds,
 * through the real routes as `office.all`, work orders of brand B in every state the overview counts, and the stored facts they
 * rest on (the keeper's production state, as the keeper writes it; a gate on B's order):
 *
 *   hB   the harness's work order of B (SEED-SO-B001, 4 pieces), due in 30 days; its order waits on a gate   ON_TRACK, blocked by GATE
 *   B1   a new order of B, 2 pieces, due 3 days ago                                                               LATE
 *   B2   a new order of B waiting on the customer, 2 pieces, due in 10 days; its order supervised by Mia            BLOCKED (customer)
 *   B3   on B1's order, 2 pieces, due in 12 days, on a production hold                                            BLOCKED (hold)
 *   and  A asks to pause an order (HOLD), B asks to cancel another (CANCEL), each from its own portal
 *
 * Every number is checked against the Work orders list with the same filters (each number opens it, F-PR-04) and the Customer
 * requests tile against Home › Approvals' own rows (GET /home/today?kind=ORDER_CHANGE_REQUEST). Every answer `office.p2` (limited
 * to B) got is scanned for A's names, codes, numbers and ids. Every name and number is made up (example.com).
 * Run with `node scripts/factory/run-pg-tests.mjs modules/production/overview`.
 */

let world: UrgencyWorld
const NS = 'pr33-overview'
type Json = Record<string, any>
type Session = 'office.all' | 'office.p1' | 'office.p2'
type Office = Awaited<ReturnType<UrgencyWorld['officePerson']>>
let mia: Office
const B = { hB: '', b1: '', b2: '', b3: '' }
const orders = {} as Record<'a1' | 'b1' | 'b2' | 'b3', { orderId: string; lineId: string }>
let aMarkers: Marker[] = []
const seenByB: unknown[] = []

const today = () => businessDate(world.h.clock.now())
const day = (days: number) => plusDays(today(), days)
const admin = <R = Json>(sql: string, values: unknown[] = []) => world.admin<R>(sql, values)
const key = () => ({ headers: { 'idempotency-key': `pr33-${newId()}` } })

async function call(session: Session, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown): Promise<{ status: number; body: Json; raw: string }> {
  const response = await world.officeApp.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
  const body = response.headers['content-type']?.toString().startsWith('application/json') ? (response.json() as Json) : {}
  if (session === 'office.p2') seenByB.push(body)
  return { status: response.statusCode, body, raw: response.body }
}
async function ok(session: Session, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, status = 200): Promise<Json> {
  const answer = await call(session, method, url, payload)
  expect(answer.status, `${session} ${method} ${url}: ${answer.raw.slice(0, 500)}`).toBe(status)
  return answer.body
}
const overview = (session: Session, query = '') => ok(session, 'GET', `/production/overview${query}`)
const listIds = async (session: Session, query = ''): Promise<string[]> => ((await ok(session, 'GET', `/production/work-orders?limit=200${query}`)).workOrders as Json[]).map((row) => row.id as string)
const approvalsCount = async (session: Session): Promise<number> => (await ok(session, 'GET', '/home/today?kind=ORDER_CHANGE_REQUEST&limit=200')).total as number
const versionOf = async (workOrderId: string): Promise<number> => (await admin<{ version: number }>('SELECT version FROM "WorkOrder" WHERE id = $1', [workOrderId]))[0]!.version
const rowOf = (answer: Json, partyId: string): Json | undefined => (answer.customers as Json[]).find((entry) => entry.customer?.id === partyId)

/** A DRAFT work order of one cell of a line, due on `dueDate`, through the real route. */
async function workOrderOf(lineId: string, size: string, quantity: number, dueDate: string): Promise<string> {
  const { workOrder } = await ok('office.all', 'POST', '/production/work-orders', { siteId: world.w.siteId, dueDate, lines: [{ salesOrderLineId: lineId, sizes: [{ size, quantity }] }] }, 201)
  return workOrder.id as string
}

/** The customer asks from its portal (the B-PR-25 route). */
async function ask(person: Awaited<ReturnType<UrgencyWorld['portalPerson']>>, orderId: string, body: Json): Promise<string> {
  const answer = await person.browser.send('POST', `/portal/sales-orders/${orderId}/change-requests`, body, key())
  expect(answer.status, JSON.stringify(answer.body)).toBe(201)
  return (answer.body as Json).request.id as string
}

beforeAll(async () => {
  world = await urgencyWorld('pr33_overview', NS)
  const { a, b } = world.ids
  // Both customers' production asks open (the limits card's list).
  await admin(`UPDATE "PortalSettings" SET "productionAskKinds" = '{HOLD,RESUME,SPLIT_SHIPMENT,SAMPLE_ROUND}', version = version + 1 WHERE "partyId" = ANY($1::uuid[])`, [[a, b]])
  orders.a1 = await world.addOrder(a, 'A1', '2026-10-01')
  orders.b1 = await world.addOrder(b, 'B1', '2026-10-01')
  orders.b2 = await world.addOrder(b, 'B2', '2026-10-02')
  orders.b3 = await world.addOrder(b, 'B3', '2026-10-03')
  mia = await world.officePerson('mia.supervisor@pr33-office.example.com', 'production_manager')

  // hB: the harness's work order of B, due in 30 days; a gate waits on its order (SEED-SO-B001).
  B.hB = world.w.b.workOrderId
  await ok('office.all', 'PATCH', `/production/work-orders/${B.hB}`, { version: await versionOf(B.hB), dueDate: day(30) })
  await world.replica([
    {
      sql: 'INSERT INTO "OrderGate" ("id", "tenantId", "companyId", "partyId", "salesOrderId", "kind") VALUES ($1, $2, $3, $4, $5, \'LAB_PASSED\')',
      values: [newId(), world.ids.tenantId, world.w.companyId, b, world.w.b.salesOrderId],
    },
  ])
  // B1 late; B2 waiting on the customer and supervised by Mia; B3 held by us.
  B.b1 = await workOrderOf(orders.b1.lineId, '50', 2, day(-3))
  B.b2 = await workOrderOf(orders.b2.lineId, '50', 2, day(10))
  B.b3 = await workOrderOf(orders.b1.lineId, '52', 2, day(12))
  await world.replica([
    {
      sql: 'UPDATE "BrandOrderProduction" SET "waitingOn" = \'BRAND\', "waitingSince" = now(), "supervisorId" = $2, "supervisorAssignedAt" = now() WHERE key = $1',
      values: [`brand-production:${orders.b2.orderId}`, mia.id],
    },
  ])
  await ok('office.all', 'POST', `/production/work-orders/${B.b3}/holds`, { reasonCode: 'MATERIAL_MISSING' }, 201)

  // A asks to pause, B to cancel, each from its own portal.
  freshGuard(world.h)
  const buyerA = await world.portalPerson('anna.buyer@pr33-brand-alpha.example.com', a, ['customer-buyer', 'partner-approve'])
  freshGuard(world.h)
  const buyerB = await world.portalPerson('bea.buyer@pr33-brand-beta.example.com', b, ['customer-buyer', 'partner-approve'])
  freshGuard(world.h)
  await ask(buyerA, orders.a1.orderId, { kind: 'HOLD', note: 'Made-up: our store opening moved.' })
  freshGuard(world.h)
  await ask(buyerB, orders.b3.orderId, { kind: 'CANCEL', reasonCode: 'LEAD_TIME' })

  aMarkers = [...(await markersOf(world.h.db, a)), { label: 'mixed work order', text: world.w.mixed.number }, { label: 'mixed work order', text: world.w.mixed.workOrderId }, { label: 'brand A order', text: orders.a1.orderId }]
}, 600_000)

beforeEach(() => {
  freshGuard(world.h)
})

afterAll(async () => {
  await world?.close()
})

describe('B-PR-33: the all-customers overview', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('a customer’s row: in production, late, at risk, blocked, waiting on, blocked by (hold, customer, gate), WIP by stage, requests', async () => {
    const answer = await overview('office.p2')
    const beta = rowOf(answer, world.ids.b)!
    expect(beta).toMatchObject({
      kind: 'CUSTOMER',
      customer: { id: world.ids.b },
      inProduction: { workOrders: 4, pieces: 10 },
      late: 1,
      atRisk: 0,
      blocked: 2,
      waitingOn: { US: 3, BRAND: 1, SUPPLIER: 0, WORKSHOP: 0 },
      blockedBy: { HOLD: 1, CUSTOMER: 1, MATERIAL: 0, GATE: 1, NEEDS_SPLIT: 0 },
      customerUrgent: 0,
      requests: { waiting: 1, toAnswer: 1 },
    })
    // Held work is WIP too (On hold only); drafts are Not released; nothing started yet.
    expect(beta.wip).toEqual({ stages: { NOT_RELEASED: 8, RELEASED: 0, CUTTING: 0, SEWING: 0, AT_WORKSHOP: 0, QUALITY: 0, FINISHED: 0, ON_HOLD: 2 }, sewingNotCounted: 0 })
    expect(answer.tiles).toEqual({ waitingOnUs: 3, waitingOnCustomer: 1, waitingOnSupplier: 0, waitingOnWorkshop: 0, late: 1, atRisk: 0, blocked: 2, customerRequests: 1 })
    expect(answer.requests.byKind).toEqual([{ kind: 'CANCEL', open: 1, countered: 0 }])
    // Most urgent: the late one, with its days, its customer and no supervisor set.
    expect(answer.mostUrgent).toMatchObject({ count: 1, nextCursor: null })
    expect(answer.mostUrgent.items).toHaveLength(1)
    expect(answer.mostUrgent.items[0]).toMatchObject({ id: B.b1, risk: { state: 'LATE', daysLate: 3 }, daysLate: 3, customer: { id: world.ids.b }, supervisor: 'NOT_SET', gate: false, waitingOn: { on: 'US' } })
    expect(answer.filter).toEqual({ siteId: null, partyId: null, supervisor: null })
  })

  it('every number is the Work orders list’s with the same filters (each number opens it)', async () => {
    for (const session of ['office.p2', 'office.all'] as const) {
      const answer = await overview(session)
      const { overall, tiles } = answer
      expect(overall.kind).toBe('ALL')
      expect((await listIds(session, '&open=true')).length, session).toBe(overall.inProduction.workOrders)
      expect((await listIds(session, '&risk=LATE')).length, session).toBe(tiles.late)
      expect((await listIds(session, '&risk=AT_RISK')).length, session).toBe(tiles.atRisk)
      expect((await listIds(session, '&risk=BLOCKED')).length, session).toBe(tiles.blocked)
      expect((await listIds(session, '&waitingOn=US')).length, session).toBe(tiles.waitingOnUs)
      expect((await listIds(session, '&waitingOn=BRAND')).length, session).toBe(tiles.waitingOnCustomer)
      for (const block of ['HOLD', 'CUSTOMER', 'MATERIAL'] as const) expect((await listIds(session, `&blockedBy=${block}`)).length, `${session} ${block}`).toBe(overall.blockedBy[block])
      expect((await listIds(session, '&gate=true&open=true')).length, session).toBe(overall.blockedBy.GATE)
      expect((await listIds(session, '&mixed=true&open=true')).length, session).toBe(overall.blockedBy.NEEDS_SPLIT)
      // F-PR-04: the "No customer" row (the work of no customer) opens the list's noCustomer filter.
      expect((await listIds(session, '&noCustomer=true&open=true')).length, session).toBe(answer.noCustomer?.inProduction.workOrders ?? 0)
      // Customer urgency: the list's F-PR-18 filter (Urgent counts only while the customer's switch is on).
      expect((await listIds(session, '&customerUrgency=URGENT&open=true')).length, session).toBe(overall.customerUrgent)
      expect((await listIds(session, `&open=true&partyId=${world.ids.b}`)).length, session).toBe(rowOf(answer, world.ids.b)!.inProduction.workOrders)
      // The Customer requests tile counts the very rows Home › Approvals shows this reader.
      expect(tiles.customerRequests, session).toBe(await approvalsCount(session))
      // The Total is the sum of the rows.
      const rows = [...(answer.customers as Json[]), ...(answer.mixed ? [answer.mixed] : []), ...(answer.noCustomer ? [answer.noCustomer] : [])]
      expect(rows.reduce((sum, row) => sum + row.inProduction.pieces, 0), session).toBe(overall.inProduction.pieces)
      expect(rows.reduce((sum, row) => sum + row.late, 0), session).toBe(overall.late)
    }
    // The gate and the split filters themselves: B's gated work order; the mixed one only for the production unit.
    expect(await listIds('office.p2', '&gate=true')).toEqual([B.hB])
    expect(await listIds('office.all', '&gate=true')).toEqual(expect.arrayContaining([B.hB, world.w.mixed.workOrderId]))
    expect(await listIds('office.all', '&mixed=true')).toEqual([world.w.mixed.workOrderId])
    expect(await listIds('office.p2', '&mixed=true')).toEqual([])
    // F-PR-04: the work of no customer never reaches a person limited to some customers; the mixed one is not "no customer".
    expect(await listIds('office.p2', '&noCustomer=true')).toEqual([])
    expect(await listIds('office.all', '&noCustomer=true')).not.toContain(world.w.mixed.workOrderId)
    // The export follows the screen.
    const sessions = twoBrandSessions(world.ids.tenantId, world.ids.a, world.ids.b, ['workorders.view'])
    const exported = async (session: Session, address: string) => (await workOrderExport.read(callerFor(world.h.database, { ...sessions[session], requestId: newId() } as never), workOrderExport.query(new URLSearchParams(address)), null, 200)).rows.map((row) => (row as Json).id as string)
    expect(await exported('office.all', 'view=all&mixed=true')).toEqual([world.w.mixed.workOrderId])
    expect(await exported('office.p2', 'view=all&gate=true')).toEqual([B.hB])
    expect(await exported('office.p2', 'view=all&noCustomer=true')).toEqual([]) // F-PR-04
  })

  it('Most urgent pages in the list’s risk sort with the count of all; a cursor of another list is refused in words', async () => {
    const first = await overview('office.all', '?limit=1')
    const count = first.mostUrgent.count as number
    expect(count).toBe(first.tiles.late + first.tiles.atRisk)
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const page: Json = await overview('office.all', `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      expect(page.mostUrgent.count).toBe(count)
      seen.push(...(page.mostUrgent.items as Json[]).map((row) => row.id as string))
      cursor = page.mostUrgent.nextCursor as string | null
      pages++
    } while (cursor && pages < 50)
    const byRisk = ((await ok('office.all', 'GET', '/production/work-orders?limit=200&sort=risk')).workOrders as Json[]).filter((row) => row.risk?.state === 'LATE' || row.risk?.state === 'AT_RISK').map((row) => row.id as string)
    expect(seen).toEqual(byRisk)
    expect(seen).toContain(B.b1)
    const wrong = await call('office.all', 'GET', '/production/overview?cursor=not-a-cursor')
    expect(wrong.status).toBe(400)
    expect(wrong.raw).toMatch(/start from the first page/)
  })

  it('the production unit sees every customer, the mixed work orders made before the rule, and the Total of all', async () => {
    const all = await overview('office.all')
    expect(all.everyCustomer).toBe(true)
    expect(rowOf(all, world.ids.a)).toBeDefined()
    expect(rowOf(all, world.ids.a)!.customerUrgent).toBeGreaterThanOrEqual(1)
    expect(rowOf(all, world.ids.a)!.requests.waiting).toBeGreaterThanOrEqual(1)
    // B's own row reads the same for the production unit as for B's person (the wall takes nothing from B's figures).
    const beta = await overview('office.p2')
    expect(rowOf(all, world.ids.b)).toEqual(rowOf(beta, world.ids.b))
    expect(all.mixed).toMatchObject({ kind: 'MIXED', customer: null, inProduction: { workOrders: 1, pieces: 2 }, blockedBy: { NEEDS_SPLIT: 1 }, requests: { waiting: 0, toAnswer: 0 } })
    expect(all.overall.inProduction.workOrders).toBeGreaterThan(beta.overall.inProduction.workOrders)
    const kinds = new Map((all.requests.byKind as Json[]).map((entry) => [entry.kind as string, entry]))
    expect(kinds.get('HOLD')?.open).toBeGreaterThanOrEqual(1)
    expect(kinds.get('CANCEL')?.open).toBeGreaterThanOrEqual(1)
    // One customer asked for: only that row, the same figures.
    const onlyB = await overview('office.all', `?partyId=${world.ids.b}`)
    expect(onlyB.customers).toEqual([rowOf(all, world.ids.b)])
    expect(onlyB.mixed).toBeNull()
    expect(onlyB.filter.partyId).toBe(world.ids.b)
    // One site (the harness's); an unknown site is not found.
    expect((await overview('office.all', `?siteId=${world.w.siteId}`)).overall.inProduction.workOrders).toBe((await listIds('office.all', `&open=true&siteId=${world.w.siteId}`)).length)
    expect((await call('office.all', 'GET', `/production/overview?siteId=${newId()}`)).status).toBe(404)
  })

  it('“Only mine”: the work orders and orders I supervise (their own supervisor, else the customer’s default)', async () => {
    const mine = await mia.browser.send('GET', '/production/overview?supervisor=me')
    expect(mine.status, JSON.stringify(mine.body).slice(0, 500)).toBe(200)
    const body = mine.body as Json
    expect(body.filter.supervisor).toBe('me')
    expect(body.customers).toHaveLength(1)
    expect(body.customers[0]).toMatchObject({ customer: { id: world.ids.b }, inProduction: { workOrders: 1, pieces: 2 }, blocked: 1, blockedBy: { CUSTOMER: 1 }, requests: { waiting: 0, toAnswer: 0 } })
    expect(body.overall.inProduction.workOrders).toBe(1)
    expect(body.mostUrgent.count).toBe(0)
    const list = await mia.browser.send('GET', '/production/work-orders?limit=200&supervisor=me')
    expect(((list.body as Json).workOrders as Json[]).map((row) => row.id)).toEqual([B.b2])
    // Without the filter the same person sees every customer (a production manager).
    const everything = (await mia.browser.send('GET', '/production/overview')).body as Json
    expect(everything.overall.inProduction.workOrders).toBeGreaterThan(1)
  })

  it('Floor now’s WIP counts held work orders with the total (siteWip)', async () => {
    const floor = await ok('office.p2', 'GET', '/production/scans/wip?limit=1')
    expect({ total: floor.total, held: floor.held }).toEqual({ total: 1, held: 1 })
    expect((floor.workOrders as Json[])[0]!.workOrder.id).toBe(B.b3)
  })
})

describe('PW-01: a person limited to customer B never meets customer A on the overview', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('tiles, customer rows, WIP and Most urgent hold only B; the Total is B’s alone; no mixed row; A’s filter is not found', async () => {
    for (const query of ['', '?limit=100', `?siteId=${world.w.siteId}`, `?partyId=${world.ids.b}`]) {
      const answer = await overview('office.p2', query)
      expect(answer.everyCustomer, query).toBe(false)
      expect((answer.customers as Json[]).map((entry) => entry.customer.id), query).toEqual([world.ids.b])
      expect(answer.mixed, query).toBeNull()
      expect(answer.noCustomer, query).toBeNull()
      // Total = B only: the same figures as B's own row (kind aside).
      const { kind: _row, customer: _who, ...beta } = rowOf(answer, world.ids.b)!
      const { kind, customer, ...overall } = answer.overall
      expect(kind).toBe('ALL')
      expect(customer).toBeNull()
      expect(overall, query).toEqual(beta)
      for (const item of answer.mostUrgent.items as Json[]) expect(item.partyId, query).toBe(world.ids.b)
      expect((answer.requests.byKind as Json[]).map((entry) => entry.kind), query).not.toContain('HOLD')
    }
    const refused = await call('office.p2', 'GET', `/production/overview?partyId=${world.ids.a}`)
    expect(refused.status).toBe(404)
    expect(refused.body.error.message).toBe('Customer not found.')
    // A person limited to A meets none of B's either.
    const alpha = await overview('office.p1')
    expect((alpha.customers as Json[]).map((entry) => entry.customer.id)).toEqual([world.ids.a])
    expect(JSON.stringify(alpha)).not.toContain(B.b1)
    expect(alpha.mixed).toBeNull()
  })

  it('nothing B’s person was answered names A (names, codes, numbers, references, ids)', async () => {
    await overview('office.p2', '?supervisor=me')
    expect(seenByB.length).toBeGreaterThan(10)
    const found = findMarkers(seenByB, aMarkers)
    expect(found, JSON.stringify(found)).toEqual([])
  })
})
