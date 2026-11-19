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
import { declineChange } from '../../production/work-order-changes/apply'
import { acceptRequest } from '../change-requests/office'
import { applyPlan } from '../change-requests/apply-plan'
import { forgetProgress } from '../portal-orders/progress'
import { orderProduction } from './production-read'

/**
 * B-SA-050 — the order's "Still to do" (sales page plan R1, P6; 13-backend B4; review C-8), computed from the records, on the local
 * stack: the factory-db seeds up to shipping (SEED-SO-0002's line made by work order WO-0001 at plant A1), and per test an order of
 * Brand Alpha (the seeds' customer P1) in production, one line of 4 pieces of size 52 made by an IN_PROGRESS work order of which some
 * are bundled, with an OPEN change request to lower it — planted whole as an import would. Each row closes when its record says so;
 * nothing is ticked by hand. Brand Beta = a person limited to another customer. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/sales/orders/still-to-do`.
 */

let h: Harness
const NS = 'still-to-do-a'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')
let officeId: string

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const caller = (permissions: Permission[], parties: 'all' | string[] = 'all') => callerFor(h.database, { audience: 'office', tenantId: T, actorId: officeId, requestId: newId(), grants: [{ permissions, companies: 'all', sites: 'all', parties }] })
const everyone = () => caller(['orders.view', 'orders.manage', 'workorders.view', 'workorders.manage', 'product.changes.view', 'product.changes.manage', 'money.price'] as Permission[])
const salesOnly = () => caller(['orders.view', 'orders.manage'])
const stillToDo = async (who = everyone(), orderId: string) => {
  forgetProgress()
  const answer = await orderProduction(who, orderId, { parts: 'changes' })
  return answer.changes!.stillToDo
}
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
  const [line] = await admin<{ id: string; colourwayId: string; styleId: string }>('SELECT id::text AS id, "colourwayId"::text AS "colourwayId", "styleId"::text AS "styleId" FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq LIMIT 1', [so2.id])
  const [cell] = await admin<{ id: string; workOrderId: string }>('SELECT id::text AS id, "workOrderId"::text AS "workOrderId" FROM "WorkOrderSize" WHERE "salesOrderLineId" = $1 LIMIT 1', [line!.id])
  const ids = { order: newId(), line: newId(), workOrder: newId(), cell: newId(), request: newId(), styleId: line!.styleId }
  const tag = `T-SA050-${++made}-${ids.order.slice(-4)}`
  await planted([
    // The copy keeps no number of the customer's own: written with the database's rules off, the TH-1b trigger gives none ("Your order 12" is one per order).
    copy('SalesOrder', so2.id, { id: ids.order, number: tag, status: 'IN_PRODUCTION', version: 1, reapprovalNeededAt: null, customerSeq: null }),
    copy('SalesOrderLine', line!.id, { id: ids.line, orderId: ids.order, seq: 10, quantity: 4, closedShortQuantity: null, closedShortAt: null, closedShortById: null, closeShortReason: null, closedShortReasonCode: null, version: 1 }),
    { sql: `INSERT INTO "SalesOrderLineSize" (id, "tenantId", "lineId", "partyId", size, quantity) VALUES ($1, $2, $3, $4, '52', 4)`, values: [newId(), T, ids.line, P1] },
    copy('WorkOrder', cell!.workOrderId, { id: ids.workOrder, number: `${tag}-WO`, batchNumber: `${tag}-BT`, status: 'IN_PROGRESS', version: 1 }),
    copy('WorkOrderSize', cell!.id, { id: ids.cell, workOrderId: ids.workOrder, salesOrderLineId: ids.line, colourwayId: line!.colourwayId, size: '52', quantity: 4, version: 1 }),
    ...(cut > 0 ? [{ sql: `INSERT INTO "Bundle" (id, "tenantId", "siteId", "workOrderId", "workOrderSizeId", code, quantity) SELECT $1, "tenantId", "siteId", $2, $3, $4, $5 FROM "WorkOrderSize" WHERE id = $3::uuid`, values: [newId(), ids.workOrder, ids.cell, `${tag}-BN`, cut] }] : []),
    // Asked before the test's clock (the harness's, set once): the database holds an answer never earlier than its ask.
    { sql: `INSERT INTO "OrderChangeRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, status, version, "createdAt") VALUES ($1, $2, $3, $4, $5, 'CHANGE', 'OPEN', 1, $6)`, values: [ids.request, T, companyA, P1, ids.order, new Date(h.clock.now().getTime() - 60_000)] },
    { sql: `INSERT INTO "OrderChangeRequestLine" (id, "tenantId", "partyId", "requestId", "orderLineId", size, "quantityBefore", quantity) VALUES ($1, $2, $3, $4, $5, '52', 4, $6)`, values: [newId(), T, P1, ids.request, ids.line, asked] },
  ])
  return { ...ids, number: `${tag}-WO` }
}

beforeAll(async () => {
  h = await startHarness('still_to_do')
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

describe('B-SA-050: Still to do, computed from the records — each row closes when its record says so', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('nothing before an accepted change; after it the proposed work-order change waits on planning, and closes when declined ("Left as is")', async () => {
    const world = await inWork(0, 3)
    expect(await stillToDo(everyone(), world.order)).toEqual({ rows: [], count: 0, workOrdersLeftOut: 0 })
    await acceptRequest(salesOnly(), world.request, { version: 1 }, undefined, h.clock)
    const change = await one<{ id: string; version: number }>('SELECT id::text AS id, version FROM "WorkOrderChange" WHERE "requestId" = $1', [world.request])
    const open = await stillToDo(everyone(), world.order)
    expect(open.rows).toEqual([
      expect.objectContaining({ kind: 'WORK_ORDER_CHANGE', ref: { type: 'WorkOrderChange', id: change.id, number: world.number }, waitingOn: 'PLANNER', mayAct: true, requestId: world.request, words: { en: `${world.number}: make 52 4 → 3`, it: `${world.number}: produci 52 4 → 3` } }),
    ])
    // Left as is: the only stored decision, with its words — the row is gone, the plan reads it.
    await declineChange(everyone(), change.id, { version: change.version, words: 'The customer takes the fourth one after all.' })
    expect((await stillToDo(everyone(), world.order)).rows).toEqual([])
    const plan = await applyPlan(everyone(), world.request, h.clock.now())
    expect(plan.next.find((step) => step.kind === 'LOWER_TO_ORDER')).toMatchObject({ state: 'LEFT_AS_IS', why: { en: 'Left as is: The customer takes the fourth one after all.' } })
  })

  it('extra pieces charged to the customer wait on the customer until it accepts the priced change; nothing waits for a leftover', async () => {
    const charged = await inWork(3, 2)
    await acceptRequest(everyone(), charged.request, { version: 1, extraOutcome: 'CHARGE' }, undefined, h.clock)
    const rows = (await stillToDo(everyone(), charged.order)).rows
    expect(rows.map((row) => [row.kind, row.waitingOn])).toEqual([
      ['WORK_ORDER_CHANGE', 'PLANNER'],
      ['EXTRA_PIECES', 'CUSTOMER'],
    ])
    expect(rows[1]).toMatchObject({ ref: { type: 'SalesOrderAmendment' }, mayAct: false, words: { en: '1 extra pieces charged: waiting for the customer to accept the priced change' } })
    // The customer's yes clears the order's wait (as orders/reacceptance does): the row closes.
    await h.db.admin.query('UPDATE "SalesOrder" SET "reapprovalNeededAt" = NULL, version = version + 1 WHERE id = $1', [charged.order])
    expect((await stillToDo(everyone(), charged.order)).rows.map((row) => row.kind)).toEqual(['WORK_ORDER_CHANGE'])

    const leftover = await inWork(3, 2)
    await acceptRequest(everyone(), leftover.request, { version: 1, extraOutcome: 'LEFTOVER' }, undefined, h.clock)
    expect((await stillToDo(everyone(), leftover.order)).rows.map((row) => row.kind)).toEqual(['WORK_ORDER_CHANGE'])
  })

  it('a design change\'s style change waits on product until its change order is released or it is refused', async () => {
    const world = await inWork(0, 4)
    const design = newId()
    const raised = newId()
    await planted([
      { sql: `INSERT INTO "OrderChangeRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, status, reason, "answeredAt", "answeredById", version) VALUES ($1, $2, $3, $4, $5, 'DESIGN', 'ACCEPTED', 'Move the logo to the left sleeve.', now(), $6, 2)`, values: [design, T, companyA, P1, world.order, officeId] },
      { sql: `INSERT INTO "OrderChangeRequestLine" (id, "tenantId", "partyId", "requestId", "orderLineId", size, "quantityBefore", quantity) VALUES ($1, $2, $3, $4, $5, NULL, 4, 4)`, values: [newId(), T, P1, design, world.line] },
      { sql: `INSERT INTO "ChangeRequest" (id, "tenantId", "companyId", number, source, "partyId", "styleId", title, reason, status, "orderChangeRequestId") VALUES ($1, $2, $3, $4, 'CUSTOMER', $5, $6, 'Customer design change · Move the logo to the left sleeve.', 'Move the logo to the left sleeve.', 'OPEN', $7)`, values: [raised, T, companyA, `CR-T050-${raised.slice(-6)}`, P1, world.styleId, design] },
    ])
    const rows = (await stillToDo(everyone(), world.order)).rows
    expect(rows).toEqual([expect.objectContaining({ kind: 'STYLE_CHANGE', ref: expect.objectContaining({ type: 'ChangeRequest', id: raised }), waitingOn: 'PRODUCT', mayAct: true, requestId: design })])
    await planted([{ sql: `UPDATE "ChangeRequest" SET status = 'REJECTED', "decidedAt" = now(), "decidedById" = $2, "decisionNote" = 'Not this season.' WHERE id = $1`, values: [raised, officeId] }])
    expect((await stillToDo(everyone(), world.order)).rows).toEqual([])
  })

  it('the wall: a work order the reader does not reach is "a work order", no door, counted; a person limited to Brand Beta does not reach the order', async () => {
    const world = await inWork(0, 3)
    await acceptRequest(salesOnly(), world.request, { version: 1 }, undefined, h.clock)
    const blind = await stillToDo(salesOnly(), world.order)
    expect(blind.rows).toEqual([expect.objectContaining({ kind: 'WORK_ORDER_CHANGE', ref: null, mayAct: false, words: { en: 'A work order: make 52 4 → 3', it: 'Un ordine di lavoro: produci 52 4 → 3' } })])
    expect(blind.workOrdersLeftOut).toBe(1)
    expect(JSON.stringify(blind)).not.toContain(world.number)
    const beta = caller(['orders.view', 'workorders.view'], [newId()])
    expect((await thrown(orderProduction(beta, world.order, { parts: 'changes' }))).code).toBe('not_found')
  })
})
