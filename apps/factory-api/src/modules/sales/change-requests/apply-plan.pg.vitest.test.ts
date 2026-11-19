import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seed as seedShipping } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { callerFor } from '../../../core/command'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { forgetProgress } from '../portal-orders/progress'
import { applyPlan } from './apply-plan'
import { acceptRequest } from './office'

/**
 * B-SA-045 — the review window's apply plan (sales page plan P5, P6', R1; 13-backend B4a) on the local stack: the factory-db seeds up
 * to shipping (SEED-SO-0002's line made by work order WO-0001 at plant A1), and per test an order of Brand Alpha (the seeds' customer
 * P1) in production, one line of 4 pieces of size 52 made by an IN_PROGRESS work order of which some are bundled, with an OPEN change
 * request to lower it — planted whole as an import would. The office through its functions (the routes' manifest is the live check's).
 * Brand Beta = a person limited to another customer. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/sales/change-requests/apply-plan`.
 */

let h: Harness
const NS = 'apply-plan-a'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')
let officeId: string

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
/** The customer's next own number (as the database gives one): a planted copy of an order never takes the copied order's. */
const nextCustomerSeq = async (orderId: string) => (await one<{ seq: number }>('SELECT coalesce(max(o."customerSeq"), 0) + 1 AS seq FROM "SalesOrder" o JOIN "SalesOrder" f ON f.id = $1 WHERE o."tenantId" = f."tenantId" AND o."companyId" = f."companyId" AND o."partyId" = f."partyId"', [orderId])).seq
const caller = (permissions: Permission[], parties: 'all' | string[] = 'all') => callerFor(h.database, { audience: 'office', tenantId: T, actorId: officeId, requestId: newId(), grants: [{ permissions, companies: 'all', sites: 'all', parties }] })
const sales = () => caller(['orders.view', 'orders.manage'])
const planner = () => caller(['orders.view', 'orders.manage', 'workorders.view', 'workorders.manage'])
const thrown = async (work: Promise<unknown>): Promise<Json> => {
  try {
    await work
  } catch (error) {
    return error as Json
  }
  throw new Error('expected a refusal')
}

/** Rows written whole, the database's rules off for them (as an import would). */
async function planted(rows: readonly { sql: string; values: unknown[] }[]): Promise<void> {
  await h.db.admin.query('BEGIN')
  try {
    await h.db.admin.query("SET LOCAL session_replication_role = 'replica'")
    for (const row of rows) await h.db.admin.query(row.sql, row.values)
    await h.db.admin.query('COMMIT')
  } catch (error) {
    await h.db.admin.query('ROLLBACK')
    throw error
  }
}
const copy = (table: string, from: string, over: Json) => ({ sql: `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, values: [JSON.stringify(over), from] })

let made = 0
/** An order in production of one line, 4 of size 52, made by an IN_PROGRESS work order of which `cut` are bundled; its request to go to `asked`. */
async function inWork(cut: number, asked: number) {
  const so2 = await one<{ id: string }>('SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = $2', [T, 'SEED-SO-0002'])
  const [line] = await admin<{ id: string; colourwayId: string }>('SELECT id::text AS id, "colourwayId"::text AS "colourwayId" FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq LIMIT 1', [so2.id])
  const [cell] = await admin<{ id: string; workOrderId: string }>('SELECT id::text AS id, "workOrderId"::text AS "workOrderId" FROM "WorkOrderSize" WHERE "salesOrderLineId" = $1 LIMIT 1', [line!.id])
  const ids = { order: newId(), line: newId(), workOrder: newId(), cell: newId(), request: newId() }
  const tag = `T-SA045-${++made}-${ids.order.slice(-4)}`
  await planted([
    copy('SalesOrder', so2.id, { id: ids.order, number: tag, status: 'IN_PRODUCTION', version: 1, reapprovalNeededAt: null, customerSeq: await nextCustomerSeq(so2.id) }),
    copy('SalesOrderLine', line!.id, { id: ids.line, orderId: ids.order, seq: 10, quantity: 4, closedShortQuantity: null, closedShortAt: null, closedShortById: null, closeShortReason: null, closedShortReasonCode: null, version: 1 }),
    { sql: `INSERT INTO "SalesOrderLineSize" (id, "tenantId", "lineId", "partyId", size, quantity) VALUES ($1, $2, $3, $4, '52', 4)`, values: [newId(), T, ids.line, P1] },
    copy('WorkOrder', cell!.workOrderId, { id: ids.workOrder, number: `${tag}-WO`, batchNumber: `${tag}-BT`, status: 'IN_PROGRESS', version: 1 }),
    copy('WorkOrderSize', cell!.id, { id: ids.cell, workOrderId: ids.workOrder, salesOrderLineId: ids.line, colourwayId: line!.colourwayId, size: '52', quantity: 4, version: 1 }),
    ...(cut > 0 ? [{ sql: `INSERT INTO "Bundle" (id, "tenantId", "siteId", "workOrderId", "workOrderSizeId", code, quantity) SELECT $1, "tenantId", "siteId", $2, $3, $4, $5 FROM "WorkOrderSize" WHERE id = $3::uuid`, values: [newId(), ids.workOrder, ids.cell, `${tag}-BN`, cut] }] : []),
    { sql: `INSERT INTO "OrderChangeRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, status, version) VALUES ($1, $2, $3, $4, $5, 'CHANGE', 'OPEN', 1)`, values: [ids.request, T, companyA, P1, ids.order] },
    { sql: `INSERT INTO "OrderChangeRequestLine" (id, "tenantId", "partyId", "requestId", "orderLineId", size, "quantityBefore", quantity) VALUES ($1, $2, $3, $4, $5, '52', 4, $6)`, values: [newId(), T, P1, ids.request, ids.line, asked] },
  ])
  // The rows are dated by the database's clock (now()): the harness clock catches up, so an answer is never before its ask.
  h.clock.set(new Date())
  return { ...ids, number: `${tag}-WO` }
}

beforeAll(async () => {
  h = await startHarness('apply_plan')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedShipping({ db: h.database, namespace: NS })
  await seedReasons({ db: h.database, namespace: NS })
  const actorId = newId()
  officeId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    await client.user.create({ data: { id: officeId, email: 'otto.office@seed-a.example', displayName: 'Otto Office', status: 'ACTIVE' }, select: { id: true } })
  })
}, 240_000)

afterAll(async () => {
  await h?.close()
})

describe('B-SA-045: the apply plan of a request, before and after Accept', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('before Accept: this Accept to do, the work order lowered after it, the cut pieces beyond the new figure as extra pieces with three unpicked outcomes', async () => {
    forgetProgress()
    const world = await inWork(3, 2)
    const plan = await applyPlan(planner(), world.request, h.clock.now())
    expect(plan.request).toMatchObject({ id: world.request, kind: 'CHANGE', status: 'OPEN', orderId: world.order })
    expect(plan.next.map((step) => [step.seq, step.kind, step.state])).toEqual([
      [1, 'AMEND', 'TO_DO'],
      [2, 'LOWER_TO_ORDER', 'TO_DO'],
    ])
    expect(plan.next[0]).toMatchObject({ team: 'SALES', mayDoNow: true })
    expect(plan.next[1]).toMatchObject({ team: 'PLANNER', mayDoNow: false, workOrder: { id: world.workOrder, number: world.number }, cells: [{ seq: 10, size: '52', from: 4, to: 2 }], extra: 1, ref: null })
    // R1, Round 4: the extra pieces start unpicked; charging needs the price grain this reader lacks; scrapping its own approval.
    expect(plan.extra).toMatchObject({ total: 1, chosen: null, needsOutcome: true, pieces: [{ lineId: world.line, seq: 10, size: '52', count: 1 }] })
    expect(plan.extra.outcomes.map((option) => [option.outcome, option.needs, option.mayChoose])).toEqual([
      ['CHARGE', 'PRICE_GRAIN', false],
      ['LEFTOVER', null, true],
      ['SCRAP', 'SCRAP_APPROVAL', true],
    ])
    // On the floor now: the order's own cell only — ordered, asked, in work orders, cut (bundled), and the bundle in work.
    expect(plan.withheld).toEqual([])
    expect(plan.floor).toMatchObject({ cells: [{ lineId: world.line, seq: 10, size: '52', ordered: 4, asked: 2, inWorkOrders: 4, cut: 3 }], inWork: { bundles: 1 }, workOrdersLeftOut: 0 })
  })

  it('after Accept: this Accept done, the lowering PROPOSED as its WorkOrderChange (the planner may apply it), the outcome recorded', async () => {
    forgetProgress()
    const world = await inWork(3, 2)
    await acceptRequest(sales(), world.request, { version: 1, extraOutcome: 'LEFTOVER' }, undefined, h.clock)
    const change = await one<{ id: string }>('SELECT id::text AS id FROM "WorkOrderChange" WHERE "requestId" = $1', [world.request])
    const plan = await applyPlan(planner(), world.request, h.clock.now())
    expect(plan.request.status).toBe('ACCEPTED')
    expect(plan.next.map((step) => [step.kind, step.state])).toEqual([
      ['AMEND', 'DONE'],
      ['LOWER_TO_ORDER', 'PROPOSED'],
    ])
    expect(plan.next[1]).toMatchObject({ ref: { type: 'WorkOrderChange', id: change.id }, mayDoNow: true, workOrder: { id: world.workOrder } })
    expect(plan.extra).toMatchObject({ total: 1, chosen: 'LEFTOVER', needsOutcome: false, words: null })
    // A reader without workorders.manage reads it, may not act on it.
    const reader = await applyPlan(caller(['orders.view', 'workorders.view']), world.request, h.clock.now())
    expect(reader.next[1]).toMatchObject({ state: 'PROPOSED', mayDoNow: false })
  })

  it('without workorders.view: no floor figures (withheld, never zeros) and the work order is counted, never named', async () => {
    forgetProgress()
    const world = await inWork(1, 3)
    const plan = await applyPlan(sales(), world.request, h.clock.now())
    expect(plan.floor).toBeNull()
    expect(plan.withheld).toEqual(['floor'])
    expect(plan.workOrdersLeftOut).toBe(1)
    expect(plan.next[1]).toMatchObject({ kind: 'LOWER_TO_ORDER', workOrder: null, person: null, words: { en: 'A work order: make 52 4 → 3' } })
    expect(JSON.stringify(plan)).not.toContain(world.number)
  })

  it('the wall: a person limited to Brand Beta gets the words of an unknown request (404), as for an id that does not exist', async () => {
    const world = await inWork(0, 3)
    const beta = caller(['orders.view', 'orders.manage', 'workorders.view'], [newId()])
    const unknown = await thrown(applyPlan(planner(), newId(), h.clock.now()))
    const walled = await thrown(applyPlan(beta, world.request, h.clock.now()))
    expect(walled).toMatchObject({ code: 'not_found', message: 'Change request not found.' })
    expect(walled.message).toBe(unknown.message)
  })
})

// ── F-SA-241 (14-change-flow §3.2 item 6): the bundles in work per work-order step ("Finish what is started" / "Stop now") ──
describe('F-SA-241: the bundles in work of each work order a step changes', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('counts the ACTIVE bundles on the step’s own cells of a work order the reader reaches; none of the other steps carries a count', async () => {
    forgetProgress()
    const world = await inWork(3, 2)
    const plan = await applyPlan(planner(), world.request, h.clock.now())
    expect(plan.next.map((step) => [step.kind, step.bundles])).toEqual([
      ['AMEND', null],
      ['LOWER_TO_ORDER', 1],
    ])
  })

  it('nothing bundled: 0, never null, for a work order the reader reaches', async () => {
    forgetProgress()
    const world = await inWork(0, 3)
    const plan = await applyPlan(planner(), world.request, h.clock.now())
    expect(plan.next.find((step) => step.kind === 'LOWER_TO_ORDER')?.bundles).toBe(0)
  })

  it('the wall: a work order the reader does not reach is never counted (null), its number never said', async () => {
    forgetProgress()
    const world = await inWork(1, 3)
    const plan = await applyPlan(sales(), world.request, h.clock.now())
    expect(plan.next[1]).toMatchObject({ kind: 'LOWER_TO_ORDER', workOrder: null, bundles: null })
    expect(JSON.stringify(plan)).not.toContain(world.number)
  })
})
// ── end F-SA-241 ──
