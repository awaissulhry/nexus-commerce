import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedProductionSupervisor } from '../../../../../../packages/factory-db/seed/production-supervisor'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seed as seedShipping } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { callerFor } from '../../../core/command'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { fanOut } from '../../../platform/notifications/fan-out'
import { systemContext } from '../../../platform/outbox/system'
import { acceptRequest } from '../change-requests/office'
import { orderChangeNotes } from './change-notes'
import { whoWasTold } from './told'
import { toldChanges } from './told' // F-SA-244
// B-OC-009: a work-order change applied from planning speaks for its own line.
import { applyChange } from '../../production/work-order-changes/apply'

/**
 * B-SA-056 — who was told about one change of a sales order (sales page plan P8, R2, R8; 14-change-flow §5.2; review WP-1, WP-2), on
 * the local stack: the seeds up to shipping, P1's production supervisor and backup (limited to P1), a sales person of every customer,
 * and the second brand's planner (limited to Brand Beta). An accepted change of Alpha's order, the handler `sales.orderChangeNotes`
 * and the office bell's fan-out run as the worker does, then `GET /sales/orders/:orderId/told`:
 *
 *   GROUPS     office people by name, by why (supervisor or backup · follows the order · follows a work order); the person who
 *              acted and a person limited to another customer are never in it
 *   FLOOR      "Told the floor at hh:mm" and the work orders — never who or which station read it; no read state for anyone
 *   THE WALL   a person limited to Brand Beta reads "Sales order not found."; one without the conversation's read right, "Change
 *              not found."; an unknown change, the same words
 * Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/orders/told`.
 */

let h: Harness
const NS = 'sa056-told'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')
let officeId: string
let salesRep: string
let betaPartyId: string
let people: { supervisor: string; backup: string; betaPlanner: string }

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const caller = (permissions: Permission[], parties: 'all' | string[] = 'all', requestId = newId()) => callerFor(h.database, { audience: 'office', tenantId: T, actorId: officeId, requestId, grants: [{ permissions, companies: 'all', sites: 'all', parties }] })
const READER: Permission[] = ['orders.view', 'threads.read', 'workorders.view']
const thrown = async (work: Promise<unknown>): Promise<Json> => {
  try {
    await work
  } catch (error) {
    return error as Json
  }
  throw new Error('expected a refusal')
}

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

/** An order of Alpha in production: one line, 4 of size 52, made by an IN_PROGRESS work order; an OPEN request to lower it to 3. */
async function inWork() {
  const so2 = await one<{ id: string }>('SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = $2', [T, 'SEED-SO-0002'])
  const [line] = await admin<{ id: string; colourwayId: string }>('SELECT id::text AS id, "colourwayId"::text AS "colourwayId" FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq LIMIT 1', [so2.id])
  const [cell] = await admin<{ id: string; workOrderId: string }>('SELECT id::text AS id, "workOrderId"::text AS "workOrderId" FROM "WorkOrderSize" WHERE "salesOrderLineId" = $1 LIMIT 1', [line!.id])
  const ids = { order: newId(), line: newId(), workOrder: newId(), cell: newId(), request: newId() }
  const tag = `T-SA056-${ids.order.slice(-6)}`
  await planted([
    // The copy keeps no number of the customer's own: written with the database's rules off, the TH-1b trigger gives none ("Your order 12" is one per order).
    copy('SalesOrder', so2.id, { id: ids.order, number: tag, status: 'IN_PRODUCTION', version: 1, reapprovalNeededAt: null, customerSeq: null }),
    copy('SalesOrderLine', line!.id, { id: ids.line, orderId: ids.order, seq: 10, quantity: 4, closedShortQuantity: null, closedShortAt: null, closedShortById: null, closeShortReason: null, closedShortReasonCode: null, version: 1 }),
    { sql: `INSERT INTO "SalesOrderLineSize" (id, "tenantId", "lineId", "partyId", size, quantity) VALUES ($1, $2, $3, $4, '52', 4)`, values: [newId(), T, ids.line, P1] },
    copy('WorkOrder', cell!.workOrderId, { id: ids.workOrder, number: `${tag}-WO`, batchNumber: `${tag}-BT`, status: 'IN_PROGRESS', version: 1 }),
    copy('WorkOrderSize', cell!.id, { id: ids.cell, workOrderId: ids.workOrder, salesOrderLineId: ids.line, colourwayId: line!.colourwayId, size: '52', quantity: 4, version: 1 }),
    // Asked before the test's clock (the harness's, set once): the database holds an answer never earlier than its ask.
    { sql: `INSERT INTO "OrderChangeRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, status, version, "createdAt") VALUES ($1, $2, $3, $4, $5, 'CHANGE', 'OPEN', 1, $6)`, values: [ids.request, T, companyA, P1, ids.order, new Date(h.clock.now().getTime() - 60_000)] },
    { sql: `INSERT INTO "OrderChangeRequestLine" (id, "tenantId", "partyId", "requestId", "orderLineId", size, "quantityBefore", quantity) VALUES ($1, $2, $3, $4, $5, '52', 4, 3)`, values: [newId(), T, P1, ids.request, ids.line] },
  ])
  return { ...ids, number: `${tag}-WO` }
}

const follow = (userId: string, recordType: string, recordId: string) => admin(`INSERT INTO "RecordFollower" (id, "tenantId", "recordType", "recordId", "userId", reason, muted) VALUES ($1, $2, $3, $4, $5, 'CHOSE', false)`, [newId(), T, recordType, recordId, userId])

async function eventsOf(correlationId: string, type?: string): Promise<EventEnvelope[]> {
  const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND "correlationId" = $2 ${type ? 'AND type = $3' : ''} ORDER BY "occurredAt", id`, type ? [T, correlationId, type] : [T, correlationId])
  return rows.map((row) => ({ eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload }) as EventEnvelope)
}

/** The worker: the change's handler on every event of the command, then the office bell on every message it wrote. */
async function asTheWorker(correlationId: string): Promise<void> {
  for (const event of await eventsOf(correlationId)) await orderChangeNotes(callerFor(h.database, systemContext(T, correlationId)), event)
  for (const event of await eventsOf(correlationId, 'thread.message_posted')) await fanOut(callerFor(h.database, systemContext(T, `sa056-fan-${event.eventId}`)), event)
}

beforeAll(async () => {
  h = await startHarness('sa056_told')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedShipping({ db: h.database, namespace: NS })
  await seedReasons({ db: h.database, namespace: NS })
  const supervisors = await seedProductionSupervisor({ db: h.database, namespace: NS })
  people = { supervisor: supervisors.userIds.supervisor, backup: supervisors.userIds.backup, betaPlanner: supervisors.userIds.secondBrandPlanner }
  const actorId = newId()
  officeId = newId()
  salesRep = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    await client.user.create({ data: { id: officeId, email: 'otto.office@sa056.example', displayName: 'Otto Office', status: 'ACTIVE' }, select: { id: true } })
    await client.user.create({ data: { id: salesRep, email: 'sara.sales@sa056.example', displayName: 'Sara Sales', status: 'ACTIVE' }, select: { id: true } })
    const role = await client.role.findFirstOrThrow({ where: { key: 'sales', system: true }, select: { id: true } })
    await client.roleAssignment.create({ data: { id: newId(), userId: salesRep, roleId: role.id, allCompanies: true, partyIds: [], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
  })
  betaPartyId = (await one<{ partyId: string }>(`SELECT "partyIds"[1]::text AS "partyId" FROM "RoleAssignment" WHERE "userId" = $1 LIMIT 1`, [people.betaPlanner])).partyId
}, 300_000)

afterAll(async () => {
  await h?.close()
})

describe('B-SA-056: who was told about one change — never who read it', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('office people by name and why, the floor by when and which work order; never the actor, never another customer\'s person, no read state', async () => {
    const world = await inWork()
    await follow(people.supervisor, 'SalesOrder', world.order)
    await follow(salesRep, 'SalesOrder', world.order)
    await follow(people.betaPlanner, 'SalesOrder', world.order)
    await follow(people.backup, 'WorkOrder', world.workOrder)
    const correlation = newId()
    await acceptRequest(caller(['orders.view', 'orders.manage'], 'all', correlation), world.request, { version: 1 }, undefined, h.clock)
    await asTheWorker(correlation)

    const told = await whoWasTold(caller(READER), world.order, { batchId: correlation })
    expect(told.order).toEqual({ id: world.order, number: expect.any(String) })
    expect(told.change.batchId).toBe(correlation)
    const byWhy = Object.fromEntries(told.people.groups.map((group) => [group.why, group.people.map((person) => person.id).sort()]))
    expect(byWhy).toEqual({ SUPERVISOR: [people.supervisor, people.backup].sort(), FOLLOWS_ORDER: [salesRep] })
    expect(told.people.count).toBe(3)
    const everyone = told.people.groups.flatMap((group) => group.people.map((person) => person.id))
    expect(everyone).not.toContain(people.betaPlanner)
    expect(everyone).not.toContain(officeId)
    expect(told.floor).toMatchObject({ workOrders: [{ id: world.workOrder, number: world.number }], leftOut: 0 })
    expect(told.floor.at).not.toBeNull()
    expect(told.workshop).toEqual({ at: null, subcontractOrders: [], waiting: 0, leftOut: 0 })
    expect(JSON.stringify(told)).not.toMatch(/"(read|readAt|seen|seenAt|shown|offline)"/)

    // The same change found by its system line.
    const byLine = await whoWasTold(caller(READER), world.order, { messageId: told.change.messageId })
    expect(byLine.change).toEqual(told.change)
  })

  it('keeps to the wall: Beta-limited → "Sales order not found."; no conversation right or an unknown change → "Change not found."', async () => {
    const world = await inWork()
    const correlation = newId()
    await acceptRequest(caller(['orders.view', 'orders.manage'], 'all', correlation), world.request, { version: 1 }, undefined, h.clock)
    await asTheWorker(correlation)
    expect(await thrown(whoWasTold(caller(READER, [betaPartyId]), world.order, { batchId: correlation }))).toMatchObject({ message: 'Sales order not found.' })
    expect(await thrown(whoWasTold(caller(['orders.view']), world.order, { batchId: correlation }))).toMatchObject({ message: 'Change not found.' })
    expect(await thrown(whoWasTold(caller(READER), world.order, { batchId: newId() }))).toMatchObject({ message: 'Change not found.' })
    expect(await thrown(whoWasTold(caller(READER), world.order, {}))).toMatchObject({ message: 'Name the change.' })
  })
})

// ---- F-SA-244: the told lines of all the order's changes in one read (the system line cards, History's Told line, the Production
// tab's "Told the floor at hh:mm", Overview's "Told about changes: N people") — counts and times, never names, never who read anything.
describe('F-SA-244: the told lines of every change of the order, one read', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('names each change by its line and its request; counts the people once; the floor by when and which work order; no read state', async () => {
    const world = await inWork()
    await follow(people.supervisor, 'SalesOrder', world.order)
    await follow(salesRep, 'SalesOrder', world.order)
    await follow(people.betaPlanner, 'SalesOrder', world.order)
    const correlation = newId()
    await acceptRequest(caller(['orders.view', 'orders.manage'], 'all', correlation), world.request, { version: 1 }, undefined, h.clock)
    await asTheWorker(correlation)

    const single = await whoWasTold(caller(READER), world.order, { batchId: correlation })
    expect(single.change.requestId).toBe(world.request)

    const list = await toldChanges(caller(READER), world.order)
    expect(list.order.id).toBe(world.order)
    expect(list.changes).toHaveLength(1)
    const [change] = list.changes
    expect(change).toMatchObject({ batchId: correlation, messageId: single.change.messageId, requestId: world.request, eventType: 'order_change_request.answered', people: single.people.count })
    expect(change!.floor).toMatchObject({ workOrders: [{ id: world.workOrder, number: world.number }], leftOut: 0 })
    expect(change!.floor.at).not.toBeNull()
    expect(change!.workshop).toEqual({ at: null, told: 0, waiting: 0 })
    expect(list.people).toBe(single.people.count)
    // Counts only: no person's name or id, and nothing about reading.
    expect(JSON.stringify(list)).not.toContain(people.supervisor)
    expect(JSON.stringify(list)).not.toContain('Sara Sales')
    expect(JSON.stringify(list)).not.toMatch(/"(read|readAt|seen|seenAt|shown|offline)"/)
  })

  it('an order with no conversation yet: nothing told; the wall as Who was told', async () => {
    const world = await inWork()
    expect(await toldChanges(caller(READER), world.order)).toMatchObject({ people: 0, changes: [] })
    const correlation = newId()
    await acceptRequest(caller(['orders.view', 'orders.manage'], 'all', correlation), world.request, { version: 1 }, undefined, h.clock)
    await asTheWorker(correlation)
    expect(await thrown(toldChanges(caller(READER, [betaPartyId]), world.order))).toMatchObject({ message: 'Sales order not found.' })
    expect(await thrown(toldChanges(caller(['orders.view']), world.order))).toMatchObject({ message: 'Change not found.' })
    expect(await thrown(toldChanges(caller(READER), newId()))).toMatchObject({ message: 'Sales order not found.' })
  })
})
// ---- end F-SA-244

// ── B-OC-009 (order changes tab R5 + R7; 13-backend §4): each told line names what spoke for its change ──
describe('B-OC-009: the told read names what spoke for each change — ids and dates, a pause’s work order only when reached', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const PLANNER: Permission[] = ['orders.view', 'workorders.view', 'workorders.manage']

  it('the customer’s request it carried out (REQUEST), then the work-order change planning applied (WORK_ORDER_CHANGE, by its id)', async () => {
    const world = await inWork()
    await follow(people.supervisor, 'SalesOrder', world.order)
    const accepted = newId()
    // Sales accepts (no workorders.manage): the lowering waits for planning as a PROPOSED work-order change.
    await acceptRequest(caller(['orders.view', 'orders.manage'], 'all', accepted), world.request, { version: 1 }, undefined, h.clock)
    await asTheWorker(accepted)
    const change = await one<{ id: string; version: number }>(`SELECT id::text AS id, version FROM "WorkOrderChange" WHERE "requestId" = $1 AND status = 'PROPOSED'`, [world.request])
    const applied = newId()
    await applyChange(caller(PLANNER, 'all', applied), change.id, { version: change.version })
    await asTheWorker(applied)
    const list = await toldChanges(caller(READER), world.order)
    const byBatch = new Map(list.changes.map((entry) => [entry.batchId, entry]))
    expect(byBatch.get(accepted)?.speaker).toEqual({ kind: 'REQUEST', requestId: world.request })
    expect(byBatch.get(applied)).toMatchObject({ eventType: 'work_order_change.applied', speaker: { kind: 'WORK_ORDER_CHANGE', workOrderChangeId: change.id } })
  })

  it('a pause on the order’s work order: named for a reader who reaches it; for one who does not, no work order and counted in leftOut', async () => {
    const world = await inWork()
    const hold = newId()
    const correlation = newId()
    const placedAt = new Date(h.clock.now().getTime() - 1_000)
    await planted([
      { sql: `INSERT INTO "WorkOrderHold" (id, "tenantId", "companyId", "siteId", "workOrderId", kind, "reasonCode", status, "placedAt", "placedById") SELECT $1, "tenantId", "companyId", "siteId", id, 'PRODUCTION', 'OTHER', 'ACTIVE', $2, $3 FROM "WorkOrder" WHERE id = $4::uuid`, values: [hold, placedAt, officeId, world.workOrder] },
    ])
    // The worker's handler on the hold's event (as the hold command emits it), at the instant it was placed.
    const event = { eventId: newId(), type: 'work_order_hold.placed', version: 1, context: 'production', tenantId: T, companyId: companyA, siteId: null, subject: world.workOrder, correlationId: correlation, causationId: null, source: 'test', occurredAt: placedAt.toISOString(), payload: { holdId: hold, workOrderId: world.workOrder, kind: 'PRODUCTION' } } as unknown as EventEnvelope
    await orderChangeNotes(callerFor(h.database, systemContext(T, correlation)), event)
    const reader = (await toldChanges(caller(READER), world.order)).changes.find((entry) => entry.batchId === correlation)
    expect(reader?.speaker).toEqual({ kind: 'HOLD', hold: { placed: true, workOrder: { id: world.workOrder, number: world.number }, leftOut: 0 } })
    // No workorders.view: the pause is told, its work order is not named (counted).
    const blind = (await toldChanges(caller(['orders.view', 'threads.read']), world.order)).changes.find((entry) => entry.batchId === correlation)
    expect(blind?.speaker).toEqual({ kind: 'HOLD', hold: { placed: true, workOrder: null, leftOut: 1 } })
    expect(JSON.stringify(blind)).not.toContain(world.number)
    // A person limited to another customer reads nothing of the order (the unknown id's words).
    expect(await thrown(toldChanges(caller(READER, [betaPartyId]), world.order))).toMatchObject({ message: 'Sales order not found.' })
  })

  it('a line written before the row kept its speaker: speaker null (the web says the kind by its event words)', async () => {
    const world = await inWork()
    const correlation = newId()
    await acceptRequest(caller(['orders.view', 'orders.manage'], 'all', correlation), world.request, { version: 1 }, undefined, h.clock)
    await asTheWorker(correlation)
    const row = await one<{ id: string; after: Json }>(`SELECT id::text AS id, after FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'sales.orderChangeNotes' AND "recordId" = $2 AND after->>'written' = 'true'`, [T, world.order])
    expect(row.after.speaker).toBeDefined()
    const { speaker: _kept, ...older } = row.after
    const before = `T-OC009-old-${newId()}`
    await planted([copy('AuditLog', row.id, { id: newId(), requestId: before, after: older })])
    const old = (await toldChanges(caller(READER), world.order)).changes.find((entry) => entry.batchId === before)
    expect(old).toBeDefined()
    expect(old!.speaker).toBeNull()
  })
})
// ── end B-OC-009 ──
