import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedPlanningDepth, type PlanningDepthSeed } from '../seed/planning-depth'
import { seed as seedSchedule, type ScheduleSeed } from '../seed/schedule'
import { seed as seedSubcontract, type SubcontractSeed } from '../seed/subcontract'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * Planning in depth (W2b-5 schema wave 41/44, B-W2b-286, …_planning_depth_w2b_guards) on a database built from the migrations
 * and seeded, through the real login and the scoped client:
 *   - planned work and subcontract orders: the size run adds up, MAKE on a line, SUBCONTRACT to a workshop with its steps and
 *     kit date, firm and protected fields with who and when, made real once (then frozen), moved on only by a later run,
 *     removed only while plain;
 *   - action messages: each action's from and to, about a record of the run's site, decided once while the run is DONE;
 *   - the promise history: append-only, one first promise per line and size, a re-promise after it with why;
 *   - the board's change log: append-only, each kind with its parts, an undo once; pins that hold a slot where it is;
 *   - what-ifs: DRAFT, then applied or discarded once; a workshop's weekly capacity;
 *   - the new columns of item parameters, planning settings, runs, requirements (the hard peg), orders (the backlog rank),
 *     subcontract orders (the kit date) and work order operations (outside or back in).
 * The refusals are check_violation (23514), restrict_violation (23001) or a key's violation; their messages are read through
 * raw SQL.
 */

const NS = 'w2b-286-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let d: PlanningDepthSeed
let sch: ScheduleSeed
let sub: SubcontractSeed

const key = (name: string): string => seedUuid(NS, name)
const A = {
  company: key('company:A'),
  site: key('site:A1'),
  line: key('site:A1:line:L1'),
  P1: key('party:P1'),
  P2: key('party:P2'),
  run: key('supply:run:1'),
  so1: key('sales:SO1'),
  so1Blk: key('sales:SO1:line:10'),
  so1Red: key('sales:SO1:line:20'),
  so2Blk: key('production:sales-order:SO-0002:10'),
  redLeather: key('supply:run:1:2'),
  blkLeather: key('supply:run:1:1'),
  poLeather: key('supply:PO1:10'),
  slotSew: key('schedule:slot:A1:working:sew'),
  slotPack: key('schedule:slot:A1:working:pack'),
}
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: A.site })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const one = async (text: string, values: unknown[] = []) => (await admin(text, values))[0]!
/** INSERT a copy of row `id` of `table` with `changes` (a jsonb object of columns). */
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) =>
  run(scope, `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, JSON.stringify(changes), id)
/** UPDATE row `id` of `table`: `set` is the SET list. */
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const remove = (scope: FactoryScope, table: string, id: string) => run(scope, `DELETE FROM "${table}" WHERE id = $1::uuid`, id)
const now = () => new Date().toISOString()
const later = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()

beforeAll(async () => {
  db = await migratedDatabase('planningdepthw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  d = await seedPlanningDepth({ db: factory, namespace: NS })
  // Run twice: the new seed is idempotent.
  await seedPlanningDepth({ db: factory, namespace: NS })
  sch = await seedSchedule({ db: factory, namespace: NS })
  sub = await seedSubcontract({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the seed', () => {
  it('writes each new table once and the new columns of earlier rows', async () => {
    const counts = await one(
      `SELECT (SELECT count(*) FROM "PlannedWorkOrder")::int AS planned, (SELECT count(*) FROM "MrpActionMessage")::int AS messages,
              (SELECT count(*) FROM "PromiseRecord")::int AS promises, (SELECT count(*) FROM "ScheduleChange")::int AS changes,
              (SELECT count(*) FROM "WhatIfScenario")::int AS whatifs, (SELECT count(*) FROM "SubcontractorCapacity")::int AS capacity,
              (SELECT count(*) FROM "ScheduleSlot" WHERE pinned)::int AS pinned, (SELECT count(*) FROM "MaterialRequirement" WHERE "orderSpecific")::int AS pegged`,
    )
    expect(counts).toEqual({ planned: 3, messages: 3, promises: 3, changes: 5, whatifs: 2, capacity: 2, pinned: 0, pegged: 1 })
    expect(await one(`SELECT "kitDueAt" IS NOT NULL AS kit FROM "SubcontractOrder" WHERE id = $1`, [sub.orderId])).toEqual({ kit: true })
    expect(await admin(`SELECT "backlogRank" FROM "SalesOrder" WHERE "backlogRank" IS NOT NULL ORDER BY "backlogRank"`)).toEqual([{ backlogRank: 1 }, { backlogRank: 2 }])
  })

  it('keeps the floor out of every new table', async () => {
    for (const table of ['PlannedWorkOrder', 'MrpActionMessage', 'PromiseRecord', 'ScheduleChange', 'WhatIfScenario', 'SubcontractorCapacity']) {
      await expect(sql(floor(), `SELECT 1 FROM "${table}" LIMIT 1`)).rejects.toThrow(/permission denied/)
    }
  })
})

describe('planned work and subcontract orders', () => {
  const make = () => d.plannedWorkOrderIds.make
  const fresh = (changes: Record<string, unknown>) =>
    copyRow(office(), 'PlannedWorkOrder', make(), { id: randomUUID(), protectedFields: [], protectedAt: null, protectedById: null, ...changes })

  it('adds the size run up to its quantity, each size once, whole garments', async () => {
    expect(await fresh({})).toBe(1)
    await expect(fresh({ quantity: 5 })).rejects.toThrow(/makes 4 garments, the sum of its size run \(not 5\)/)
    await expect(fresh({ sizes: [{ size: '50', quantity: 1 }, { size: '50', quantity: 3 }] })).rejects.toThrow(/names size 50 twice/)
    await expect(fresh({ sizes: [{ size: '50', quantity: 0 }], quantity: 0 })).rejects.toThrow(/whole garments from 1/)
    await expect(fresh({ sizes: [{ size: '50', quantity: 1.5 }], quantity: 1 })).rejects.toThrow(/whole garments from 1/)
    await expect(fresh({ sizes: [], quantity: 0 })).rejects.toThrow(/a size run of 1 to 200 sizes/)
    await expect(fresh({ startDate: '2026-12-12' })).rejects.toThrow(/starts on or before its due date/)
    await expect(fresh({ status: 'CONVERTED' })).rejects.toThrow(/starts PLANNED/)
  })

  it('puts a MAKE on a line and a SUBCONTRACT on an ACTIVE workshop with its steps and kit date', async () => {
    await expect(fresh({ partyId: A.P2 })).rejects.toThrow(/is a MAKE \(on a line of its site, or none\) or a SUBCONTRACT/)
    await expect(fresh({ kitDueAt: now() })).rejects.toThrow(/is a MAKE/)
    await expect(fresh({ kind: 'SUBCONTRACT', partyId: A.P2, lineId: null, operationSeqs: [20, 20] })).rejects.toThrow(/each once from 1/)
    await expect(fresh({ kind: 'SUBCONTRACT', partyId: A.P2, lineId: null, kitDueAt: '2026-12-12T08:00:00.000Z' })).rejects.toThrow(/the kit leaving by its due date/)
    // P1 is a customer, not a workshop.
    await expect(fresh({ kind: 'SUBCONTRACT', partyId: A.P1, lineId: null })).rejects.toThrow(/an ACTIVE workshop \(a party with the SUBCONTRACTOR role\)/)
    expect(await fresh({ kind: 'SUBCONTRACT', partyId: A.P2, lineId: null, operationSeqs: [20], kitDueAt: '2026-12-01T07:00:00.000Z' })).toBe(1)
  })

  it('keeps firm and protected fields with who and when; a run never undoes them, nor moves an order back to an older run', async () => {
    await expect(update(office(), 'PlannedWorkOrder', make(), `"protectedFields" = ARRAY['dueDate', 'quantity']`)).rejects.toThrow(/protects only its sizes, startDate, dueDate/)
    await expect(update(office(), 'PlannedWorkOrder', make(), `"protectedFields" = ARRAY['dueDate', 'dueDate']`)).rejects.toThrow(/each once/)
    await expect(update(office(), 'PlannedWorkOrder', make(), `"protectedAt" = NULL`)).rejects.toThrow(/with who and when/)
    await expect(update(office(), 'PlannedWorkOrder', make(), `firm = true`)).rejects.toThrow(/firm exactly with when/)
    await expect(update(office(), 'PlannedWorkOrder', make(), `kind = 'SUBCONTRACT'`)).rejects.toThrow(/site, kind, style, colourway and creation .* never change/)
    // An older run of the site: a copy of run 1 started a day before it.
    const older = randomUUID()
    expect(await copyRow(office(), 'PlanningRun', A.run, { id: older, status: 'DONE', startedAt: '2026-10-01T08:00:00.000Z', finishedAt: '2026-10-01T08:05:00.000Z', createdAt: now(), updatedAt: now() })).toBe(1)
    await expect(update(office(), 'PlannedWorkOrder', make(), `"runId" = $2::uuid`, older)).rejects.toThrow(/moved on by a later run of its site, never back/)
    // Reset to plan: nothing protected, then it may be removed (a plain proposal).
    expect(await update(office(), 'PlannedWorkOrder', make(), `"protectedFields" = '{}', "protectedAt" = NULL, "protectedById" = NULL, version = version + 1`)).toBe(1)
    await expect(remove(office(), 'PlannedWorkOrder', d.plannedWorkOrderIds.subcontract)).rejects.toThrow(/removed only while PLANNED, not firm and with nothing protected/)
    const plain = randomUUID()
    expect(await copyRow(office(), 'PlannedWorkOrder', make(), { id: plain })).toBe(1)
    expect(await remove(office(), 'PlannedWorkOrder', plain)).toBe(1)
    // Protected again, as the seed has it.
    expect(await update(office(), 'PlannedWorkOrder', make(), `"protectedFields" = ARRAY['dueDate'], "protectedAt" = now(), "protectedById" = $2::uuid, version = version + 1`, a.actorId)).toBe(1)
  })

  it('is made real once, as a work order of its own style (and its workshop\'s subcontract order), then frozen', async () => {
    const converted = d.plannedWorkOrderIds.converted
    await expect(update(office(), 'PlannedWorkOrder', converted, `"dueDate" = "dueDate" + 1`)).rejects.toThrow(/was made real \(work order .*\); it never changes/)
    await expect(remove(office(), 'PlannedWorkOrder', converted)).rejects.toThrow(/removed only while PLANNED/)
    expect(await update(office(), 'PlannedWorkOrder', converted, `note = 'Made real on the Monday (made-up).'`)).toBe(1)
    // A planned JKT-01 order made real as WO-0002 (a JKT-02 work order): refused.
    const wo2 = (await one(`SELECT "workOrderId"::text AS id FROM "PlannedWorkOrder" WHERE id = $1`, [converted])).id as string
    const other = randomUUID()
    expect(await copyRow(office(), 'PlannedWorkOrder', make(), { id: other, protectedFields: [], protectedAt: null, protectedById: null })).toBe(1)
    await expect(update(office(), 'PlannedWorkOrder', other, `status = 'CONVERTED', "workOrderId" = $2::uuid, "convertedAt" = now()`, wo2)).rejects.toThrow(/as a work order of its own style/)
    await expect(update(office(), 'PlannedWorkOrder', other, `status = 'CONVERTED'`)).rejects.toThrow(/CONVERTED exactly with the work order made from it/)
    // A SUBCONTRACT made real names its subcontract order too.
    await expect(
      update(office(), 'PlannedWorkOrder', d.plannedWorkOrderIds.subcontract, `status = 'CONVERTED', "workOrderId" = $2::uuid, "convertedAt" = now()`, sch.production.workOrderId),
    ).rejects.toThrow(/a SUBCONTRACT also with its subcontract order/)
  })
})

describe('action messages', () => {
  const first = () => d.actionMessageIds[0]
  let seq = 100
  const fresh = (changes: Record<string, unknown>) => copyRow(office(), 'MrpActionMessage', first(), { id: randomUUID(), seq: seq++, ...changes })

  it('says each action with its from and to, in the right direction', async () => {
    expect(await fresh({})).toBe(1)
    await expect(fresh({ toDate: '2026-11-21' })).rejects.toThrow(/EXPEDITE and DEFER move a date earlier or later/)
    await expect(fresh({ action: 'DEFER' })).rejects.toThrow(/has the wrong from and to/)
    expect(await fresh({ action: 'DEFER', toDate: '2026-11-25' })).toBe(1)
    await expect(fresh({ action: 'INCREASE', fromDate: null, toDate: null, fromQuantity: '10', toQuantity: '8', uom: 'PCS' })).rejects.toThrow(/has the wrong from and to/)
    await expect(fresh({ action: 'INCREASE', fromDate: null, toDate: null, fromQuantity: '10', toQuantity: '12' })).rejects.toThrow(/has the wrong from and to/)
    expect(await fresh({ action: 'INCREASE', fromDate: null, toDate: null, fromQuantity: '10', toQuantity: '12', uom: 'FT2' })).toBe(1)
    await expect(fresh({ action: 'DECREASE', fromDate: null, toDate: null, fromQuantity: '10', toQuantity: '0', uom: 'FT2' })).rejects.toThrow(/above 0/)
    await expect(fresh({ action: 'NEW', fromDate: null, toDate: '2026-11-30' })).rejects.toThrow(/NEW says how much by when/)
    expect(await fresh({ action: 'CANCEL', toDate: null })).toBe(1)
    await expect(fresh({ message: ' ' })).rejects.toThrow(/says what to do in 1 to 2000 characters/)
    await expect(fresh({ facts: [] })).rejects.toThrow(/keeps its facts as an object/)
    await expect(fresh({ status: 'DONE', decidedAt: now() })).rejects.toThrow(/is written OPEN/)
  })

  it('is about a record of its run\'s site, of a known kind', async () => {
    await expect(fresh({ recordType: 'Invoice' })).rejects.toThrow(/about a PurchaseOrderLine, WorkOrder, SubcontractOrder, PlannedWorkOrder or MaterialRequirement, not a Invoice/)
    await expect(fresh({ recordId: randomUUID() })).rejects.toThrow(/which is not one of its run's site/)
    expect(await fresh({ recordType: 'MaterialRequirement', recordId: A.redLeather })).toBe(1)
  })

  it('is decided once (DONE or IGNORED, with when), its facts never change, and it is never deleted', async () => {
    const id = randomUUID()
    expect(await fresh({ id })).toBe(1)
    await expect(update(office(), 'MrpActionMessage', id, `"toDate" = '2026-11-15'`)).rejects.toThrow(/only its decision is written/)
    await expect(update(office(), 'MrpActionMessage', id, `status = 'DONE'`)).rejects.toThrow(/DONE or IGNORED exactly with when/)
    expect(await update(office(), 'MrpActionMessage', id, `status = 'DONE', "decidedAt" = now(), "decidedById" = $2::uuid, version = version + 1`, a.actorId)).toBe(1)
    await expect(update(office(), 'MrpActionMessage', id, `status = 'IGNORED'`)).rejects.toThrow(/is DONE; it never changes/)
    await expect(remove(office(), 'MrpActionMessage', id)).rejects.toThrow(/permission denied/)
    await expect(admin(`DELETE FROM "MrpActionMessage" WHERE id = $1`, [id])).rejects.toThrow(/is kept, never deleted/)
    await expect(admin(`TRUNCATE "MrpActionMessage"`)).rejects.toThrow(/TRUNCATE on "MrpActionMessage" is refused/)
  })
})

describe('the promise history', () => {
  const promise = (changes: Record<string, unknown>) =>
    copyRow(office(), 'PromiseRecord', d.promiseIds.rePromise, { id: randomUUID(), promisedAt: now(), customerToldAt: null, createdAt: now(), ...changes })

  it('keeps one first promise per line and size; a re-promise follows it, with why', async () => {
    expect(await promise({ promisedDate: '2026-12-29' })).toBe(1)
    await expect(promise({ kind: 'FIRST', size: null })).rejects.toThrow(/PromiseRecord_one_first|unique/i)
    expect(await promise({ kind: 'FIRST', size: '50', reasonCode: null, reason: null })).toBe(1)
    await expect(promise({ kind: 'FIRST', size: '50', reasonCode: null, reason: null })).rejects.toThrow(/PromiseRecord_one_first|unique/i)
    await expect(promise({ reasonCode: null, reason: null })).rejects.toThrow(/says why \(a reason code or words\)/)
    await expect(promise({ reasonCode: 'late leather' })).rejects.toThrow(/keeps its reason code \(A-Z, 0-9, _\)/)
    await expect(promise({ size: '58' })).rejects.toThrow(/size 58, which is not in the size grid of its line/)
    await expect(promise({ promisedDate: '2026-10-01' })).rejects.toThrow(/a day before its order's date/)
    await expect(promise({ promisedAt: later(2) })).rejects.toThrow(/promised and told not in the future/)
    await expect(promise({ planVersionId: null })).rejects.toThrow(/its plan version with its site \(both or neither\)/)
    // A line with a first promise for every size takes a re-promise of one size; a line with none waits for its first.
    expect(await promise({ salesOrderLineId: A.so1Blk, size: '52' })).toBe(1)
    await expect(promise({ salesOrderLineId: A.so2Blk, size: '52' })).rejects.toThrow(/follows the first promise of its line and size/)
    expect(await promise({ salesOrderLineId: A.so2Blk, size: '52', kind: 'FIRST', reasonCode: null, reason: null })).toBe(1)
    expect(await promise({ salesOrderLineId: A.so2Blk, size: '52' })).toBe(1)
  })

  it('is written once: never changed, removed or truncated, by any login', async () => {
    await expect(update(office(), 'PromiseRecord', d.promiseIds.rePromise, `"promisedDate" = '2026-12-30'`)).rejects.toThrow(/permission denied/)
    await expect(admin(`UPDATE "PromiseRecord" SET "promisedDate" = '2026-12-30' WHERE id = $1`, [d.promiseIds.rePromise])).rejects.toThrow(/written once and never changed or removed \(append-only\)/)
    await expect(admin(`DELETE FROM "PromiseRecord" WHERE id = $1`, [d.promiseIds.firstRed])).rejects.toThrow(/append-only/)
    await expect(admin(`TRUNCATE "PromiseRecord"`)).rejects.toThrow(/TRUNCATE on "PromiseRecord" is refused/)
  })
})

describe('the board: changes, pins, what-ifs', () => {
  const change = (changes: Record<string, unknown>) => copyRow(office(), 'ScheduleChange', d.scheduleChangeIds.move, { id: randomUUID(), changedAt: now(), createdAt: now(), ...changes })
  const noSides = { fromLineId: null, fromStartAt: null, fromEndAt: null, toLineId: null, toStartAt: null, toEndAt: null }

  it('logs each kind of change with its parts, on the site\'s working plan', async () => {
    expect(await change({})).toBe(1)
    await expect(change({ toEndAt: '2026-11-17T08:00:00.000Z' })).rejects.toThrow(/each side \(from, to\) whole or not at all/)
    await expect(change({ toWorkCentreId: randomUUID() })).rejects.toThrow(/each side \(from, to\) whole or not at all/)
    await expect(change({ toStartAt: '2026-11-17T08:00:00.000Z', toEndAt: '2026-11-17T16:00:00.000Z' })).rejects.toThrow(/MOVE goes from one place to another/)
    await expect(change({ kind: 'PLACE' })).rejects.toThrow(/PLACE goes to a lane/)
    expect(await change({ kind: 'PLACE', fromLineId: null, fromStartAt: null, fromEndAt: null })).toBe(1)
    expect(await change({ kind: 'REMOVE', toLineId: null, toStartAt: null, toEndAt: null })).toBe(1)
    await expect(change({ kind: 'PIN' })).rejects.toThrow(/PIN and UNPIN name the slot only/)
    expect(await change({ kind: 'UNPIN', ...noSides })).toBe(1)
    await expect(change({ kind: 'PUBLISH', ...noSides })).rejects.toThrow(/PUBLISH names the published version and no slot/)
    expect(await change({ kind: 'PUBLISH', ...noSides, slotId: null, workOrderId: null, workOrderOperationId: null, publishedVersionId: sch.publishedPlanId })).toBe(1)
    await expect(change({ planVersionId: sch.publishedPlanId })).rejects.toThrow(/of its site's WORKING plan/)
    await expect(change({ reason: ' ' })).rejects.toThrow(/keeps its reason in at most 2000 characters/)
    await expect(change({ changedAt: later(1) })).rejects.toThrow(/made not in the future/)
  })

  it('undoes a change once, of the same plan and slot, never a publish', async () => {
    const undo = (changes: Record<string, unknown>) =>
      change({ kind: 'UNDO', undoesChangeId: d.scheduleChangeIds.move, fromStartAt: '2026-11-17T09:00:00.000Z', fromEndAt: '2026-11-17T17:00:00.000Z', toStartAt: '2026-11-17T08:00:00.000Z', toEndAt: '2026-11-17T16:00:00.000Z', ...changes })
    await expect(undo({ slotId: A.slotPack })).rejects.toThrow(/undoes a change of the same plan and slot/)
    await expect(undo({ undoesChangeId: d.scheduleChangeIds.publish })).rejects.toThrow(/undoes a change of the same plan and slot/)
    await expect(undo({ undoesChangeId: null })).rejects.toThrow(/UNDO names the change it undoes/)
    expect(await undo({})).toBe(1)
    await expect(undo({})).rejects.toThrow(/ScheduleChange_one_undo|unique/i)
    // The undo of a pin puts back nothing but the pin.
    expect(await change({ kind: 'UNDO', ...noSides, slotId: A.slotPack, workOrderOperationId: sch.production.operationIds.pack, undoesChangeId: d.scheduleChangeIds.pin })).toBe(1)
  })

  it('is written once: never changed, removed or truncated', async () => {
    await expect(update(office(), 'ScheduleChange', d.scheduleChangeIds.move, `reason = 'x'`)).rejects.toThrow(/permission denied/)
    await expect(admin(`UPDATE "ScheduleChange" SET reason = 'x' WHERE id = $1`, [d.scheduleChangeIds.move])).rejects.toThrow(/append-only/)
    await expect(admin(`DELETE FROM "ScheduleChange" WHERE id = $1`, [d.scheduleChangeIds.place])).rejects.toThrow(/append-only/)
    await expect(admin(`TRUNCATE "ScheduleChange"`)).rejects.toThrow(/TRUNCATE on "ScheduleChange" is refused/)
  })

  it('holds a pinned slot where it is until it is unpinned; the pin has its time', async () => {
    const moveTo = (start: string) => update(office(), 'ScheduleSlot', A.slotPack, `"startAt" = $2::timestamptz, "endAt" = $2::timestamptz + interval '1 hour', version = version + 1`, start)
    expect(await update(office(), 'ScheduleSlot', A.slotPack, `pinned = true, "pinnedAt" = now(), "pinnedById" = $2::uuid, version = version + 1`, a.actorId)).toBe(1)
    await expect(moveTo('2026-11-18T12:00:00.000Z')).rejects.toThrow(/is pinned; it stays on its lane and times until it is unpinned/)
    await expect(update(office(), 'ScheduleSlot', A.slotPack, `"pinnedAt" = NULL`)).rejects.toThrow(/pinned exactly with when/)
    expect(await update(office(), 'ScheduleSlot', A.slotPack, `pinned = false, "pinnedAt" = NULL, "pinnedById" = NULL, version = version + 1`)).toBe(1)
    expect(await moveTo('2026-11-18T12:00:00.000Z')).toBe(1)
    await expect(update(office(), 'ScheduleSlot', A.slotSew, `pinned = true, "pinnedAt" = $2::timestamptz`, later(1))).rejects.toThrow(/not in the future/)
    expect(await update(office(), 'ScheduleSlot', A.slotSew, `pinned = true, "pinnedAt" = now(), "pinnedById" = $2::uuid, version = version + 1`, a.actorId)).toBe(1)
    // A published slot never changes (W2a), the pin included.
    const published = (await one(`SELECT id::text AS id FROM "ScheduleSlot" WHERE "planVersionId" = $1 LIMIT 1`, [sch.publishedPlanId])).id as string
    await expect(update(office(), 'ScheduleSlot', published, `pinned = true, "pinnedAt" = now()`)).rejects.toThrow(/published version; it never changes/)
  })

  it('keeps a what-if DRAFT while its moves change, then applies or discards it once', async () => {
    const draft = d.whatIfIds.draft
    await expect(copyRow(office(), 'WhatIfScenario', draft, { id: randomUUID(), status: 'APPLIED', appliedAt: now() })).rejects.toThrow(/starts as a DRAFT/)
    await expect(update(office(), 'WhatIfScenario', draft, `moves = '{"slotId": "x"}'::jsonb`)).rejects.toThrow(/a list of at most 500 moves/)
    expect(await update(office(), 'WhatIfScenario', draft, `moves = moves || '[{"slotId": "s2"}]'::jsonb, version = version + 1`)).toBe(1)
    await expect(update(office(), 'WhatIfScenario', draft, `"ownerId" = $2::uuid`, randomUUID())).rejects.toThrow(/site, owner, base and creation of what-if .* never change/)
    await expect(update(office(), 'WhatIfScenario', draft, `status = 'APPLIED'`)).rejects.toThrow(/APPLIED or DISCARDED exactly with when/)
    expect(await update(office(), 'WhatIfScenario', draft, `status = 'APPLIED', "appliedAt" = now(), "appliedById" = $2::uuid, version = version + 1`, a.actorId)).toBe(1)
    await expect(update(office(), 'WhatIfScenario', draft, `name = 'again'`)).rejects.toThrow(/is APPLIED; it never changes/)
    await expect(update(office(), 'WhatIfScenario', d.whatIfIds.discarded, `status = 'DRAFT', "discardedAt" = NULL`)).rejects.toThrow(/is DISCARDED; it never changes/)
    await expect(admin(`DELETE FROM "WhatIfScenario" WHERE id = $1`, [draft])).rejects.toThrow(/is kept, never deleted/)
  })
})

describe('a workshop\'s capacity', () => {
  const capacity = (changes: Record<string, unknown>) => copyRow(office(), 'SubcontractorCapacity', d.capacityIds[0], { id: randomUUID(), ...changes })

  it('is of a workshop, 1 to 1 000 000 a week, until a day not before its first', async () => {
    expect(await capacity({ workCentreKind: 'FINISHING', unit: 'PIECES', perWeek: 120 })).toBe(1)
    await expect(capacity({ partyId: A.P1 })).rejects.toThrow(/is of a workshop \(a party with the SUBCONTRACTOR role\)/)
    await expect(capacity({ perWeek: 0 })).rejects.toThrow(/takes 1 to 1 000 000 a week/)
    await expect(capacity({ validTo: '2026-10-01' })).rejects.toThrow(/until a day not before its first/)
    await expect(update(office(), 'SubcontractorCapacity', d.capacityIds[0], `"partyId" = $2::uuid`, A.P1)).rejects.toThrow(/workshop and creation of capacity .* never change/)
    expect(await update(office(), 'SubcontractorCapacity', d.capacityIds[1], `"perWeek" = 80, version = version + 1`)).toBe(1)
    const typo = randomUUID()
    expect(await capacity({ id: typo })).toBe(1)
    expect(await remove(office(), 'SubcontractorCapacity', typo)).toBe(1)
  })
})

describe('the new columns of earlier tables', () => {
  it('sizes orders by the item\'s lot sizing, with scrap, yield and delays in range; plan level and strategy for made items only', async () => {
    const ip = d.itemPlanningId
    const set = (text: string) => update(office(), 'ItemPlanning', ip, text)
    await expect(set(`"lotSizing" = 'PERIOD'`)).rejects.toThrow(/by PERIOD exactly with its days \(1 to 366\)/)
    await expect(set(`"fixedLotQty" = 0`)).rejects.toThrow(/FIXED exactly with the lot quantity \(above 0\)/)
    expect(await set(`"lotSizing" = 'PERIOD', "fixedLotQty" = NULL, "lotPeriodDays" = 14, version = version + 1`)).toBe(1)
    expect(await set(`"lotSizing" = 'MIN_MAX', "lotPeriodDays" = NULL, "minOrderQty" = 6, "maxOrderQty" = 24, version = version + 1`)).toBe(1)
    // W2a's routes write the method and the order limits: never refused by these rules (the lot sizing is read with ORDERS).
    expect(await set(`method = 'MANUAL', "maxOrderQty" = NULL, version = version + 1`)).toBe(1)
    await expect(set(`"scrapPct" = 100`)).rejects.toThrow(/scrap of 0 to under 100 %/)
    await expect(set(`"yieldPct" = 0`)).rejects.toThrow(/a yield above 0 to 100 %/)
    await expect(set(`"delayDays" = 400`)).rejects.toThrow(/a delay of 0 to 366 days/)
    await expect(set(`phantom = true`)).rejects.toThrow(/make only a COMPONENT a phantom/)
    // The leather is a material: no plan level, no strategy.
    const leather = (await one(`SELECT id::text AS id FROM "ItemPlanning" i WHERE i."itemId" = (SELECT id FROM "Item" WHERE kind = 'LEATHER' ORDER BY code LIMIT 1) LIMIT 1`)).id as string
    await expect(update(office(), 'ItemPlanning', leather, `strategy = 'MAKE_TO_STOCK'`)).rejects.toThrow(/only to a made item \(FINISHED or COMPONENT\), not a LEATHER/)
    expect(await update(office(), 'ItemPlanning', leather, `"scrapPct" = 3, "yieldPct" = 92, "delayDays" = 2, version = version + 1`)).toBe(1)
  })

  it('splits a size run by groups of sizes only with its groups', async () => {
    const settings = A.site
    const set = (text: string) => update(office(), 'PlanningSettings', settings, text)
    await expect(set(`"sizeRunRule" = 'SIZE_GROUPS'`)).rejects.toThrow(/2 to 20 for SIZE_GROUPS/)
    await expect(set(`"sizeRunRule" = 'SIZE_GROUPS', "sizeGroups" = '[["50","52"],["52","54"]]'`)).rejects.toThrow(/each size code .* in one group only/)
    await expect(set(`"sizeRunRule" = 'SIZE_GROUPS', "sizeGroups" = '[["50","52"],[]]'`)).rejects.toThrow(/lists 1 to 50 size codes/)
    expect(await set(`"sizeRunRule" = 'SIZE_GROUPS', "sizeGroups" = '[["46","48","50"],["52","54","56"]]', version = version + 1`)).toBe(1)
    await expect(set(`"sizeRunRule" = 'ONE_GRID'`)).rejects.toThrow(/no size groups for ONE_GRID/)
    expect(await set(`"sizeRunRule" = 'ONE_GRID', "sizeGroups" = '[]', version = version + 1`)).toBe(1)
  })

  it('keeps a run\'s inputs as an object, frozen once the run is no longer RUNNING (W1)', async () => {
    await expect(update(office(), 'PlanningRun', A.run, `inputs = '{"horizonWeeks": 26}'`)).rejects.toThrow(/is DONE; only its status and note change/)
    const running = randomUUID()
    await expect(
      copyRow(office(), 'PlanningRun', A.run, { id: running, status: 'RUNNING', finishedAt: null, startedAt: now(), createdAt: now(), updatedAt: now(), inputs: [] }),
    ).rejects.toThrow(/keeps what it read as an object/)
    expect(await copyRow(office(), 'PlanningRun', A.run, { id: running, status: 'RUNNING', finishedAt: null, startedAt: now(), createdAt: now(), updatedAt: now(), inputs: { horizonWeeks: 26 } })).toBe(1)
    expect(await update(office(), 'PlanningRun', running, `status = 'DONE', "finishedAt" = now(), inputs = inputs || '{"orderLines": 2}'::jsonb, version = version + 1`)).toBe(1)
  })

  it('hard-pegs a requirement to one of its order lines while it is OPEN; ORDERED, the peg is fixed', async () => {
    await expect(update(office(), 'MaterialRequirement', A.redLeather, `"reservedForLineId" = NULL`)).rejects.toThrow(/order-specific exactly with the order line \(and its party\)/)
    await expect(update(office(), 'MaterialRequirement', A.redLeather, `"reservedForLineId" = $2::uuid`, A.so1Blk)).rejects.toThrow(/only to an order line it was planned for/)
    expect(await update(office(), 'MaterialRequirement', A.redLeather, `"orderSpecific" = false, "reservedForLineId" = NULL, "reservedForPartyId" = NULL, version = version + 1`)).toBe(1)
    expect(await update(office(), 'MaterialRequirement', A.redLeather, `"orderSpecific" = true, "reservedForLineId" = $2::uuid, "reservedForPartyId" = $3::uuid, version = version + 1`, A.so1Red, A.P1)).toBe(1)
    // The black leather is ORDERED: its peg is fixed; the numbers of a requirement never change (W1).
    await expect(
      update(office(), 'MaterialRequirement', A.blkLeather, `"orderSpecific" = true, "reservedForLineId" = $2::uuid, "reservedForPartyId" = $3::uuid`, A.so1Blk, A.P1),
    ).rejects.toThrow(/is ORDERED; its hard peg to an order line is fixed/)
    await expect(update(office(), 'MaterialRequirement', A.redLeather, `"grossQuantity" = 1`)).rejects.toThrow(/never change/)
  })

  it('ranks the backlog from 1', async () => {
    await expect(update(office(), 'SalesOrder', A.so1, `"backlogRank" = 0`)).rejects.toThrow(/a place in the backlog from 1 to 1 000 000, or none/)
    expect(await update(office(), 'SalesOrder', A.so1, `"backlogRank" = 3, version = version + 1`)).toBe(1)
    expect(await update(office(), 'SalesOrder', A.so1, `"backlogRank" = NULL, version = version + 1`)).toBe(1)
  })

  it('times the kit of a subcontract order between its date and the day the goods are due back; a term of the DRAFT order', async () => {
    await expect(update(office(), 'SubcontractOrder', sub.orderId, `"kitDueAt" = '2026-11-27T07:00:00Z'`)).rejects.toThrow(/leaves on or after the order's date and by the day the goods are due back/)
    await expect(update(office(), 'SubcontractOrder', sub.orderId, `"kitDueAt" = '2026-11-15T07:00:00Z'`)).rejects.toThrow(/leaves on or after the order's date/)
    expect(await update(office(), 'SubcontractOrder', sub.orderId, `"kitDueAt" = '2026-11-18T07:00:00Z', version = version + 1`)).toBe(1)
    // W2a's routes move the order's dates without meeting this rule (the planning module keeps the kit in step).
    expect(await update(office(), 'SubcontractOrder', sub.orderId, `"expectedBackDate" = '2026-11-17', version = version + 1`)).toBe(1)
  })

  it('sends one operation of a released work order outside and back in; nothing else of it changes', async () => {
    const sew = sch.production.operationIds.sew
    await expect(update(office(), 'WorkOrderOperation', sew, `"subcontractOrderId" = $2::uuid`, sub.orderId)).rejects.toThrow(/names a subcontract order only while it is done outside/)
    expect(await update(office(), 'WorkOrderOperation', sew, `outsourced = true, "subcontractOrderId" = $2::uuid, version = version + 1`, sub.orderId)).toBe(1)
    await expect(update(office(), 'WorkOrderOperation', sew, `"standardMinutes" = 1`)).rejects.toThrow(/its operations are frozen \(MES-005\)/)
    // A cancelled subcontract order is never named.
    const cancelled = randomUUID()
    expect(
      await copyRow(office(), 'SubcontractOrder', sub.orderId, { id: cancelled, number: `SEED-SC-${cancelled.slice(0, 6)}`, kitDueAt: null, createdAt: now(), updatedAt: now() }),
    ).toBe(1)
    expect(await update(office(), 'SubcontractOrder', cancelled, `status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'Made in-house (made-up).', version = version + 1`)).toBe(1)
    await expect(update(office(), 'WorkOrderOperation', sew, `"subcontractOrderId" = $2::uuid`, cancelled)).rejects.toThrow(/goes out with a subcontract order that is not CANCELLED/)
    // Back in.
    expect(await update(office(), 'WorkOrderOperation', sew, `outsourced = false, "subcontractOrderId" = NULL, version = version + 1`)).toBe(1)
  })
})
