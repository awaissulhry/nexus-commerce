import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seed as seedShipping } from '../../../../../../packages/factory-db/seed/shipping'
import { seed as seedSubcontract } from '../../../../../../packages/factory-db/seed/subcontract' // B-OC-007: a workshop's job
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
// B-OP-025: Done on a production task from the order; a promise change closes a refused re-promise's follow-up.
import { wipTaskIdOf } from '../../product/changes/hooks'
import { changePromise } from './moves'
import { doneStillToDoTask } from './still-to-do'
// B-OC-005 (order changes tab R4a): the real Sales template's rights, as the role gives them.
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'

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
  await seedSubcontract({ db: h.database, namespace: NS }) // B-OC-007
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
      // B-OP-021: the ref carries the record's version (the act done in place sends it).
      expect.objectContaining({ kind: 'WORK_ORDER_CHANGE', ref: { type: 'WorkOrderChange', id: change.id, number: world.number, version: change.version }, waitingOn: 'PLANNER', mayAct: true, requestId: world.request, words: { en: `${world.number}: make 52 4 → 3`, it: `${world.number}: produci 52 4 → 3` } }),
    ])
    // Left as is: the only stored decision, with its words — the row is gone, the plan reads it.
    await declineChange(everyone(), change.id, { version: change.version, words: 'The customer takes the fourth one after all.' })
    expect((await stillToDo(everyone(), world.order)).rows).toEqual([])
    const plan = await applyPlan(everyone(), world.request, h.clock.now())
    expect(plan.next.find((step) => step.kind === 'LOWER_TO_ORDER')).toMatchObject({ state: 'LEFT_AS_IS', why: { en: 'Left as is: The customer takes the fourth one after all.' } })
  })

  it('extra pieces charged to the customer wait on the customer until it accepts the priced change; nothing waits for a leftover', async () => {
    // B-OP-012 (D1): the accepter holds workorders.manage — the lowering is carried out in Accept's own command (never below the
    // 3 cut), so no work-order change waits on planning; the extra pieces still say who they wait on.
    const charged = await inWork(3, 2)
    const accepted = await acceptRequest(everyone(), charged.request, { version: 1, extraOutcome: 'CHARGE' }, undefined, h.clock)
    expect(accepted.workOrders).toMatchObject({ applied: [{ workOrderId: charged.workOrder, route: 'LOWER_RELEASED', reprint: true }], waiting: [] })
    const rows = (await stillToDo(everyone(), charged.order)).rows
    expect(rows.map((row) => [row.kind, row.waitingOn])).toEqual([['EXTRA_PIECES', 'CUSTOMER']])
    expect(rows[0]).toMatchObject({ ref: { type: 'SalesOrderAmendment' }, mayAct: false, words: { en: '1 extra pieces charged: waiting for the customer to accept the priced change' } })
    // The customer's yes clears the order's wait (as orders/reacceptance does): the row closes.
    await h.db.admin.query('UPDATE "SalesOrder" SET "reapprovalNeededAt" = NULL, version = version + 1 WHERE id = $1', [charged.order])
    expect((await stillToDo(everyone(), charged.order)).rows).toEqual([])

    const leftover = await inWork(3, 2)
    await acceptRequest(everyone(), leftover.request, { version: 1, extraOutcome: 'LEFTOVER' }, undefined, h.clock)
    expect((await stillToDo(everyone(), leftover.order)).rows).toEqual([])
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

// ── B-OP-025 (order page plan N1; review R-12): Done on a production task from the order, by the task's own right ──
describe('B-OP-025: a production task is ticked off from the order only by its own right; a promise change closes a refused re-promise\'s follow-up', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  /** A released change order's REWORK line on the world's work order, and the task it left (its id derived, as the release makes it). */
  async function reworkTask(world: { workOrder: string; styleId: string }, assigneeId: string): Promise<string> {
    const workOrder = await one<{ siteId: string; companyId: string }>('SELECT "siteId"::text AS "siteId", "companyId"::text AS "companyId" FROM "WorkOrder" WHERE id = $1', [world.workOrder])
    const changeOrder = newId()
    const taskId = wipTaskIdOf(changeOrder, world.workOrder)
    await planted([
      { sql: `INSERT INTO "ChangeOrder" (id, "tenantId", "companyId", number, "styleId", "fromRevisionId", title, reason, "authorId", status, "releasedAt") VALUES ($1, $2, $3, $4, $5, $6, 'Made-up: new pocket', 'Made-up: the pocket moves.', $7, 'RELEASED', now())`, values: [changeOrder, T, workOrder.companyId, `ECO-T025-${changeOrder.slice(-6)}`, world.styleId, newId(), officeId] },
      { sql: `INSERT INTO "ChangeOrderItem" (id, "tenantId", "changeOrderId", seq, kind, "workOrderId", disposition) VALUES ($1, $2, $3, 10, 'WORK_IN_PROGRESS', $4, 'REWORK')`, values: [newId(), T, changeOrder, world.workOrder] },
      // op-fx3: as the release writes it (product/changes/hooks.ts): assigned to a person by the releaser, at a time — the tasks guard
      // refuses an assignee without who and when on the next write (planted rows skip the guards on insert only).
      { sql: `INSERT INTO "Task" (id, "tenantId", "companyId", "siteId", "partyId", title, "recordType", "recordId", "recordLabel", "assigneeId", "assignedById", "assignedAt", status, "createdById") VALUES ($1, $2, $3, $4, $5, 'Made-up: open the rework', 'WorkOrder', $6, 'WO', $7, $8, now(), 'OPEN', $8)`, values: [taskId, T, workOrder.companyId, workOrder.siteId, P1, world.workOrder, assigneeId, officeId] },
    ])
    return taskId
  }
  // B-OC-005 (order changes tab R4a; Owner D6): the right is production's — workorders.manage over the task's work order, or its
  // assignee. The real Sales template holds tasks.manage and workorders.view, never workorders.manage (the test once gave "Sales"
  // workorders.manage and no tasks.manage: the opposite of the role, so it pinned the wrong right).
  const SALES_TEMPLATE = templateOf('sales')!
  const realSales = () => caller([...SALES_TEMPLATE.permissions])
  const tasksOnly = () => caller(['orders.view', 'workorders.view', 'tasks.manage'] as Permission[])
  const production = () => caller(['orders.view', 'workorders.view', 'workorders.manage'] as Permission[])
  const taskOf = (taskId: string) => one<{ status: string; closedById: string | null; version: number }>('SELECT status::text AS status, "closedById"::text AS "closedById", version FROM "Task" WHERE id = $1', [taskId])
  const PRODUCTION_DOES_THIS = 'Production does this.'

  it('the real Sales template (orders.manage, tasks.manage, workorders.view; no workorders.manage) reads "Production does this" and is refused; workorders.manage without tasks.manage ticks it off', async () => {
    expect(SALES_TEMPLATE.permissions).toEqual(expect.arrayContaining(['orders.view', 'orders.manage', 'tasks.manage', 'workorders.view']))
    expect(SALES_TEMPLATE.permissions).not.toContain('workorders.manage')
    const world = await inWork(0, 4)
    const taskId = await reworkTask(world, newId())
    const row = (await stillToDo(realSales(), world.order)).rows.find((entry) => entry.kind === 'WORK_IN_PROGRESS_TASK')
    expect(row).toMatchObject({ ref: { type: 'Task', id: taskId, version: 1 }, mayAct: false, waitingOn: 'PLANNER' })
    const refusal = await thrown(doneStillToDoTask(realSales(), world.order, taskId, { version: 1 }))
    expect(refusal).toMatchObject({ code: 'forbidden', message: PRODUCTION_DOES_THIS, issues: [{ path: 'refusal/PRODUCTION_DOES_THIS', message: PRODUCTION_DOES_THIS }] })
    // tasks.manage alone (Warehouse, Finance, Buyer hold it too) is no longer the right: the same words, the same 403.
    expect((await stillToDo(tasksOnly(), world.order)).rows.find((entry) => entry.kind === 'WORK_IN_PROGRESS_TASK')).toMatchObject({ mayAct: false })
    expect(await thrown(doneStillToDoTask(tasksOnly(), world.order, taskId, { version: 1 }))).toMatchObject({ code: 'forbidden', message: PRODUCTION_DOES_THIS })
    expect((await taskOf(taskId)).status).toBe('OPEN')
    expect((await stillToDo(production(), world.order)).rows.find((entry) => entry.kind === 'WORK_IN_PROGRESS_TASK')).toMatchObject({ mayAct: true })
    const done = await doneStillToDoTask(production(), world.order, taskId, { version: 1 })
    expect(done).toEqual({ task: { id: taskId, status: 'DONE', version: 2 } })
    expect(await taskOf(taskId)).toMatchObject({ status: 'DONE', closedById: officeId })
    expect(await one(`SELECT after FROM "AuditLog" WHERE action = 'orders.stillToDoTaskDone' AND "recordId" = $1`, [world.order])).toMatchObject({ after: { taskId, workOrderId: world.workOrder, status: 'DONE' } })
    expect(await one(`SELECT after FROM "AuditLog" WHERE action = 'tasks.setStatus' AND "recordId" = $1`, [taskId])).toMatchObject({ after: { status: 'DONE' } })
    expect((await stillToDo(production(), world.order)).rows.filter((entry) => entry.kind === 'WORK_IN_PROGRESS_TASK')).toEqual([])
    // Done already: refused in the task's own words (never twice).
    expect((await thrown(doneStillToDoTask(production(), world.order, taskId, { version: 2 }))).code).toBe('conflict')
  })

  it('its assignee may, without tasks.manage; an old version is a conflict', async () => {
    const world = await inWork(0, 4)
    const taskId = await reworkTask(world, officeId)
    expect((await stillToDo(salesOnly(), world.order)).rows.find((entry) => entry.kind === 'WORK_IN_PROGRESS_TASK')).toMatchObject({ ref: null, mayAct: false })
    expect((await thrown(doneStillToDoTask(salesOnly(), world.order, taskId, { version: 3 }))).code).toBe('conflict')
    expect((await doneStillToDoTask(salesOnly(), world.order, taskId, { version: 1 })).task.status).toBe('DONE')
  })

  it('only this order\'s tasks: another order\'s task and an unknown id are "Task not found."; another customer\'s order is not found', async () => {
    const world = await inWork(0, 4)
    const other = await inWork(0, 4)
    const othersTask = await reworkTask(other, newId())
    const unknown = await thrown(doneStillToDoTask(production(), world.order, newId(), { version: 1 }))
    const walled = await thrown(doneStillToDoTask(production(), world.order, othersTask, { version: 1 }))
    expect(unknown).toMatchObject({ code: 'not_found', message: 'Task not found.' })
    expect([walled.code, walled.message]).toEqual([unknown.code, unknown.message])
    // A person who does not reach the work order (no workorders.view) and is not its assignee: as unknown.
    const ownTask = await reworkTask(world, newId())
    expect((await thrown(doneStillToDoTask(caller(['orders.view', 'tasks.manage'] as Permission[]), world.order, ownTask, { version: 1 }))).message).toBe('Task not found.')
    const beta = caller(['orders.view', 'workorders.view', 'tasks.manage'] as Permission[], [newId()])
    expect(await thrown(doneStillToDoTask(beta, world.order, ownTask, { version: 1 }))).toMatchObject({ code: 'not_found', message: 'Sales order not found.' })
    expect((await taskOf(ownTask)).status).toBe('OPEN')
  })

  it('the customer refused a new date: the follow-up stays while other lines change, and closes with the whole order\'s promise change (+ audit)', async () => {
    const world = await inWork(0, 4)
    const request = newId()
    await planted([
      { sql: `INSERT INTO "ApprovalRequest" (id, "tenantId", "companyId", "recordType", "recordId", "partyId", kind, question, "dueAt", status, "answeredAt", answer) VALUES ($1, $2, $3, 'SalesOrder', $4, $5, 'REPROMISE', 'Made-up: may line 10 move to a later date?', now() + interval '2 days', 'REFUSED', now(), 'Made-up: no, we need it.')`, values: [request, T, companyA, world.order, P1] },
      { sql: `INSERT INTO "Task" (id, "tenantId", "companyId", "partyId", title, "recordType", "recordId", "recordLabel", status) VALUES ($1, $2, $3, $4, 'Made-up: the customer refused the new date', 'SalesOrder', $5, 'SO', 'OPEN')`, values: [request, T, companyA, P1, world.order] },
    ])
    const later = new Date(h.clock.now().getTime() + 60 * 86_400_000).toISOString().slice(0, 10)
    const versionOf = async () => (await one<{ version: number }>('SELECT version FROM "SalesOrder" WHERE id = $1', [world.order])).version
    // A change of a line the refusal is not about (its ask names none here): the follow-up stays.
    await changePromise(salesOnly(), world.order, { version: await versionOf(), promiseDate: later, reason: 'Made-up: line 10 later.', lineIds: [world.line] })
    expect((await taskOf(request)).status).toBe('OPEN')
    // The whole order's new promise answers the refusal: closed in the same command, audited on the order.
    await changePromise(salesOnly(), world.order, { version: await versionOf(), promiseDate: later, reason: 'Made-up: we agree a new date with the customer.' })
    expect(await taskOf(request)).toMatchObject({ status: 'DONE', closedById: officeId })
    expect(await one(`SELECT after, reason FROM "AuditLog" WHERE action = 'orders.repromiseFollowUpsClosed' AND "recordId" = $1`, [world.order])).toMatchObject({ after: { taskIds: [request], lineIds: [] }, reason: 'Made-up: we agree a new date with the customer.' })
  })
})
// ── end B-OP-025 ──

// ── B-OC-006 / B-OC-007 (order changes tab R4b, R4c; 13-backend §3) ──
describe('B-OC-006 / B-OC-007: each row names the revision it comes from; a workshop row the work-order change it waits on', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('two revisions: each work-order change names its own amendment and number; rows of no revision say null', async () => {
    const world = await inWork(0, 3)
    await acceptRequest(salesOnly(), world.request, { version: 1 }, undefined, h.clock)
    const first = await one<{ id: string; amendmentId: string }>('SELECT id::text AS id, "amendmentId"::text AS "amendmentId" FROM "WorkOrderChange" WHERE "requestId" = $1', [world.request])
    const firstRevision = (await one<{ revision: number }>('SELECT revision FROM "SalesOrderAmendment" WHERE id = $1', [first.amendmentId])).revision
    // A second revision of the order (an office change: no request) with its own proposed change, planted whole as an import would.
    const second = { amendment: newId(), change: newId() }
    await planted([
      copy('SalesOrderAmendment', first.amendmentId, { id: second.amendment, revision: firstRevision + 1, reason: 'Made-up: the office lowers it again.', requestId: `T-OC006-${second.amendment.slice(-6)}`, depositRequestId: null }),
      copy('WorkOrderChange', first.id, { id: second.change, amendmentId: second.amendment, requestId: null, version: 1 }),
    ])
    // (The copy keeps the first one's time: the two may come in either order.)
    const rows = (await stillToDo(everyone(), world.order)).rows.filter((row) => row.kind === 'WORK_ORDER_CHANGE').sort((a, b) => (a.revision ?? 0) - (b.revision ?? 0))
    expect(rows.map((row) => [row.ref?.id, row.amendmentId, row.revision, row.requestId, row.waitsOn])).toEqual([
      [first.id, first.amendmentId, firstRevision, world.request, null],
      [second.change, second.amendment, firstRevision + 1, null, null],
    ])
    // A style change names no revision.
    const design = newId()
    const raised = newId()
    await planted([
      { sql: `INSERT INTO "OrderChangeRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, status, reason, "answeredAt", "answeredById", version) VALUES ($1, $2, $3, $4, $5, 'DESIGN', 'ACCEPTED', 'Made-up: move the logo.', now(), $6, 2)`, values: [design, T, companyA, P1, world.order, officeId] },
      { sql: `INSERT INTO "ChangeRequest" (id, "tenantId", "companyId", number, source, "partyId", "styleId", title, reason, status, "orderChangeRequestId") VALUES ($1, $2, $3, $4, 'CUSTOMER', $5, $6, 'Made-up: customer design change', 'Made-up: move the logo.', 'OPEN', $7)`, values: [raised, T, companyA, `CR-T006-${raised.slice(-6)}`, P1, world.styleId, design] },
    ])
    const style = (await stillToDo(everyone(), world.order)).rows.find((row) => row.kind === 'STYLE_CHANGE')
    expect(style).toMatchObject({ amendmentId: null, revision: null, waitsOn: null })
  })

  it('the workshop row waits on the proposed change of the same request on the same work order; for a reader who does not reach it: no change named', async () => {
    const world = await inWork(0, 3)
    const seeded = await one<{ id: string }>(`SELECT id::text AS id FROM "SubcontractOrder" WHERE "tenantId" = $1 AND number = 'SEED-SC-0001'`, [T])
    const job = newId()
    await planted([copy('SubcontractOrder', seeded.id, { id: job, number: `${world.number}-SC`, workOrderId: world.workOrder, status: 'ISSUED', version: 1 })])
    await acceptRequest(salesOnly(), world.request, { version: 1 }, undefined, h.clock)
    const change = await one<{ id: string }>(`SELECT id::text AS id FROM "WorkOrderChange" WHERE "requestId" = $1 AND status = 'PROPOSED'`, [world.request])
    const rows = (await stillToDo(everyone(), world.order)).rows
    expect(rows.find((row) => row.kind === 'TELL_WORKSHOP')).toMatchObject({ ref: { type: 'SubcontractOrder', id: job }, waitsOn: change.id, requestId: world.request, mayAct: false, amendmentId: null, revision: null })
    expect(rows.find((row) => row.kind === 'WORK_ORDER_CHANGE')).toMatchObject({ ref: { id: change.id }, waitsOn: null })
    // No workorders.view: the workshop row has no door and names no change (the work order is "a work order").
    const blind = (await stillToDo(salesOnly(), world.order)).rows.find((row) => row.kind === 'TELL_WORKSHOP')
    expect(blind).toMatchObject({ ref: null, waitsOn: null })
    // Declined ("Left as is"): the work order does not change, so there is no workshop to tell and nothing to wait on.
    const version = (await one<{ version: number }>('SELECT version FROM "WorkOrderChange" WHERE id = $1', [change.id])).version
    await declineChange(everyone(), change.id, { version, words: 'Made-up: left as is.' })
    expect((await stillToDo(everyone(), world.order)).rows.filter((row) => row.kind === 'TELL_WORKSHOP' || row.kind === 'WORK_ORDER_CHANGE')).toEqual([])
  })
})
// ── end B-OC-006 / B-OC-007 ──
