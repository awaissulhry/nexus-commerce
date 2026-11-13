import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import type { SeedContext } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * A DRAFT work order whose operations are on the planning board (B-W2a-F3): the release, the cells, the revision and a
 * repair's steps never answer a 500 and never take a bar off the board silently. Through the app's real routes on a
 * throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security, the …_production_guards
 * and …_production_w2a_guards triggers and ScheduleSlot's foreign key to its operation are real), with EVERY factory-db
 * seed in name order (as `npm run seed` writes them): the DRAFT SEED-WO-0002 (BLK 52 × 1, its four operations cut 10,
 * sew 20, final inspection 30, pack 40 stored by the seed) with its sewing on line L1 in plant A1's WORKING plan (19 Nov,
 * 09:00 at the plant), SEED-REP-0001 (RECEIVED) and style SEED-JKT-02 revision 1 RELEASED. On top: a made-up CONFIRMED
 * order of SEED-JKT-02 BLK that fixes no revision. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs work-orders/scheduled-drafts`.
 *
 * B-W2b-F39 (Owner decision 2026-11-13): the board's change log (B-W2b-329, ScheduleChange, append-only) names the operation
 * of every bar placed, moved or sent back to the tray by id with its own copy (seq, name), no foreign key: so a bar sent
 * back to the tray lets its operation leave again (B-W2a-F3's "send it back to the tray, then …"), and the log still names
 * it, by its copy, "no longer on the work order"; a change of it is never undone (409 OPERATION_GONE in words).
 */

const NS = 'w2a-f3-scheduled-drafts'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const lineL1 = idOf('site:A1:line:L1')
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed/', import.meta.url))
const PERMISSIONS: Permission[] = ['workorders.view', 'workorders.manage', 'workorders.release', 'planning.view', 'planning.schedule.manage', 'product.bom.view', 'product.bom.manage', 'product.styles.view', 'product.settings.manage']
const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  planner: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(PERMISSIONS)] },
}

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await db.admin.query(sql, values)).rows as Row[]
const call = (method: Method, url: string, payload?: unknown) => app.inject({ method, url, headers: { 'x-test-session': 'planner' }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}

type Op = { id: string; seq: number; routingSeq: number; name: string }
const workOrderOf = async (number: string) => (await admin<{ id: string; status: string; version: number; styleRevisionId: string }>(`SELECT id, status, version, "styleRevisionId" FROM "WorkOrder" WHERE "tenantId" = $1 AND number = $2`, [T, number]))[0]!
const opsOf = (workOrderId: string) => admin<Op>(`SELECT id, seq, "routingSeq", name FROM "WorkOrderOperation" WHERE "workOrderId" = $1 ORDER BY seq`, [workOrderId])
const slotsOf = (workOrderId: string) =>
  admin<{ id: string; planKind: string; operationId: string | null; version: number }>(`SELECT id, "planKind", "workOrderOperationId" AS "operationId", version FROM "ScheduleSlot" WHERE "workOrderId" = $1 ORDER BY "startAt", id`, [workOrderId])
// B-W2b-F39: the changes of the board's record that name an operation, the latest first (as the API orders them), with the
// copy of the operation each keeps (its seq and name when the change was written).
const changesOf = (operationId: string) =>
  admin<{ id: string; kind: string; seq: number | null; name: string | null }>(`SELECT id, kind::text AS kind, "operationSeq" AS seq, "operationName" AS name FROM "ScheduleChange" WHERE "workOrderOperationId" = $1 ORDER BY "changedAt" DESC, id DESC`, [operationId])
/** SEED-WO-0002's stored operations copied onto a draft, as the seed stores a draft spec; how many rows were copied. */
async function copySeedOperations(workOrderId: string): Promise<number> {
  const result = await db.admin.query(
    `INSERT INTO "WorkOrderOperation" (id, "tenantId", "siteId", "workOrderId", "styleRevisionId", seq, "routingSeq", code, name, "standardMinutes", "scanRequired", "workCentreId")
     SELECT gen_random_uuid(), o."tenantId", o."siteId", $1, o."styleRevisionId", o.seq, o."routingSeq", o.code, o.name, o."standardMinutes", o."scanRequired", o."workCentreId" FROM "WorkOrderOperation" o WHERE o."workOrderId" = $2`,
    [workOrderId, (await workOrderOf('SEED-WO-0002')).id],
  )
  return result.rowCount ?? 0
}
const release = (workOrderId: string, version: number) => call('POST', `/production/work-orders/${workOrderId}/release`, { version, materialOverride: { reason: 'The rest of the leather arrives next week (made up).' } })
const tray = 'Send it back to the tray on the planning board (Planning › Planning board)'

/** A made-up CONFIRMED order of SEED-JKT-02 BLK to the brand P1 at company A that fixes no revision. */
let orders = 0
async function madeUpOrder(sizes: Record<string, number>): Promise<string> {
  const orderId = newId()
  const lineId = newId()
  const pieces = Object.values(sizes).reduce((sum, quantity) => sum + quantity, 0)
  await database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, (client) =>
    client.$transaction(async (tx) => {
      await tx.salesOrder.create({
        data: {
          id: orderId,
          companyId: companyA,
          partyId: idOf('party:P1'),
          number: `F3-SO-${++orders}`,
          status: 'CONFIRMED',
          orderDate: new Date('2026-10-20T00:00:00.000Z'),
          taxMode: 'IT_B2B',
          billTo: { legalName: 'Made-up customer' },
          shipTo: { name: 'Made-up workshop' },
          promiseDate: new Date('2026-12-10T00:00:00.000Z'),
          depositRequired: false,
        },
        select: { id: true },
      })
      await tx.salesOrderLine.create({
        data: {
          id: lineId,
          companyId: companyA,
          orderId,
          partyId: idOf('party:P1'),
          seq: 10,
          kind: 'SIZE_GRID',
          styleId: idOf('production:style:JKT-02'),
          colourwayId: idOf('production:colourway:JKT-02:BLK'),
          quantity: pieces,
          unitPrice: '100.000000',
          netAmount: pieces * 10_000,
          vatRatePct: '22.00',
          vatAmount: pieces * 2_200,
          siteId: null,
        },
        select: { id: true },
      })
      await tx.salesOrderLineSize.createMany({ data: Object.entries(sizes).map(([size, quantity]) => ({ id: newId(), lineId, partyId: idOf('party:P1'), size, quantity })) })
    }),
  )
  return lineId
}

beforeAll(async () => {
  db = await migratedDatabase('scheduled_drafts')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  // Every seed in name order, as `npm run seed` writes them (packages/factory-db/src/cli.ts): the seed case itself.
  const context: SeedContext = { db: database, namespace: NS }
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: SeedContext) => Promise<unknown> }
    await module.seed(context)
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('B-W2a-F3: a draft whose operations are on the planning board', () => {
  let seeded: Op[] = []
  let seedSlot = ''
  // B-W2b-F39: the second copy of SEED-WO-0002's sewing (test 3), and the made-up draft whose copy left on its release (test 5).
  let seedExtra = ''
  let released: { workOrder: { id: string; number: string }; extra: string; sewName: string } | null = null

  it('the seed case: SEED-WO-0002 is a DRAFT with four stored operations, its sewing on line L1 in the working plan', async () => {
    const wo = await workOrderOf('SEED-WO-0002')
    expect(wo.status).toBe('DRAFT')
    seeded = await opsOf(wo.id)
    expect(seeded.map((op) => op.routingSeq)).toEqual([10, 20, 30, 40])
    const slots = await slotsOf(wo.id)
    expect(slots).toEqual([expect.objectContaining({ planKind: 'WORKING', operationId: seeded[1]!.id })])
    seedSlot = slots[0]!.id
  })

  it('changing its cells keeps its operations and their bar (only the planned materials go)', async () => {
    const wo = await workOrderOf('SEED-WO-0002')
    const lineId = await madeUpOrder({ '50': 1 })
    const { workOrder } = await ok('PUT', `/production/work-orders/${wo.id}/cells`, { version: wo.version, cells: [{ salesOrderLineId: lineId, size: '50', quantity: 1 }] })
    expect(workOrder).toMatchObject({ status: 'DRAFT', pieces: 2 })
    expect(await opsOf(wo.id)).toEqual(seeded)
    expect((await slotsOf(wo.id)).map((slot) => [slot.id, slot.operationId])).toEqual([[seedSlot, seeded[1]!.id]])
    expect(await admin(`SELECT count(*)::int AS n FROM "WorkOrderMaterial" WHERE "workOrderId" = $1`, [wo.id])).toEqual([{ n: 0 }])
  })

  it('an operation the release would take away while a bar books it: refused in words naming the bar, nothing changes; sent back to the tray, it goes', async () => {
    const wo = await workOrderOf('SEED-WO-0002')
    const sew = seeded[1]!
    // A second copy of the sewing step (a stored draft spec may hold one; the release keeps one operation per step),
    // with a bar of its own in the working plan a day after the seed's.
    const extra = newId()
    await admin(
      `INSERT INTO "WorkOrderOperation" (id, "tenantId", "siteId", "workOrderId", "styleRevisionId", seq, "routingSeq", code, name, "standardMinutes", "scanRequired", "workCentreId")
       SELECT $1, "tenantId", "siteId", "workOrderId", "styleRevisionId", 25, "routingSeq", code, name, "standardMinutes", "scanRequired", "workCentreId" FROM "WorkOrderOperation" WHERE id = $2`,
      [extra, sew.id],
    )
    const bar = newId()
    await admin(
      `INSERT INTO "ScheduleSlot" (id, "tenantId", "siteId", "planVersionId", "planKind", "workOrderId", "workOrderOperationId", "lineId", "startAt", "endAt", minutes)
       SELECT $1, "tenantId", "siteId", "planVersionId", "planKind", "workOrderId", $2, "lineId", "startAt" + interval '1 day', "endAt" + interval '1 day', minutes FROM "ScheduleSlot" WHERE id = $3`,
      [bar, extra, seedSlot],
    )
    const response = await release(wo.id, wo.version)
    expect(response.statusCode, response.body).toBe(409)
    const error = response.json().error
    const words = `Op 25 ${sew.name} on line L1 from 20 Nov 09:00 (working plan)`
    expect(error).toMatchObject({
      code: 'conflict',
      message: `The release would take away an operation of work order SEED-WO-0002 that the planning board books: ${words}. ${tray}, then release it.`,
      issues: [{ path: `scheduleSlots/WORKING/${bar}`, message: words }],
    })
    expect((await workOrderOf('SEED-WO-0002')).status).toBe('DRAFT')
    expect((await opsOf(wo.id)).map((op) => op.id)).toEqual([seeded[0]!.id, sew.id, extra, seeded[2]!.id, seeded[3]!.id])
    expect((await slotsOf(wo.id)).map((slot) => slot.id)).toEqual([seedSlot, bar])

    await ok('POST', `/planning/schedule/slots/${bar}/remove`, { version: 1 })
    expect((await slotsOf(wo.id)).map((slot) => slot.id)).toEqual([seedSlot])
    // B-W2b-F39: the board's record names the copy by its own copy of it (its bar came in by SQL: no PLACE).
    expect(await changesOf(extra)).toEqual([{ id: expect.any(String), kind: 'REMOVE', seq: 25, name: sew.name }])
    seedExtra = extra
  })

  it('the release keeps the row of every step that stays: 200 RELEASED, the bar still names a live operation of its step, now a booking', async () => {
    const wo = await workOrderOf('SEED-WO-0002')
    const response = await release(wo.id, wo.version)
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().workOrder).toMatchObject({ status: 'RELEASED' })
    // The four steps keep their rows (ids), the second copy of sewing went (no bar named it any more).
    const ops = await opsOf(wo.id)
    expect(ops).toEqual(seeded)
    const slots = await slotsOf(wo.id)
    expect(slots).toEqual([expect.objectContaining({ id: seedSlot, planKind: 'WORKING', operationId: seeded[1]!.id, version: 1 })])
    const [audit] = await admin<{ before: Json }>(`SELECT before FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'workorders.release' AND "recordId" = $2`, [T, wo.id])
    expect(audit!.before).toMatchObject({ status: 'DRAFT', draftSpec: { operations: 1, materials: 0, kept: 4 } })
    // The board draws the same bar, now booking capacity (released work does).
    const site = idOf('site:A1')
    const board = await ok('GET', `/planning/schedule?siteId=${site}&from=2026-11-16&to=2026-11-20`)
    expect((board.slots as Json[]).filter((slot) => slot.workOrderId === wo.id)).toEqual([expect.objectContaining({ id: seedSlot, operationId: seeded[1]!.id, booksCapacity: true })])
    // B-W2b-F39: the copy left its work order; the board's record still names it, by its copy.
    expect(ops.map((op) => op.id)).not.toContain(seedExtra)
    expect(await changesOf(seedExtra)).toEqual([{ id: expect.any(String), kind: 'REMOVE', seq: 25, name: seeded[1]!.name }])
  })

  it('B-W2b-F39: a copy of a step placed through the board: the release refuses while its bar books it; sent back to the tray, the release goes and the record keeps both changes by their copy', async () => {
    // A draft from the made-up order with SEED-WO-0002's operations stored as the seed stores a draft spec, and a second copy
    // of its sewing (seq 25) that the release would take away, placed on line L1 through the board (the record logs it).
    const lineId = await madeUpOrder({ '52': 1 })
    const { workOrder } = await ok('POST', '/production/work-orders', { siteId: idOf('site:A1'), lines: [{ salesOrderLineId: lineId, sizes: [{ size: '52', quantity: 1 }] }] }, 201)
    const copied = await copySeedOperations(workOrder.id)
    const sew = (await opsOf(workOrder.id)).find((op) => op.routingSeq === 20)!
    const extra = newId()
    await admin(
      `INSERT INTO "WorkOrderOperation" (id, "tenantId", "siteId", "workOrderId", "styleRevisionId", seq, "routingSeq", code, name, "standardMinutes", "scanRequired", "workCentreId")
       SELECT $1, "tenantId", "siteId", "workOrderId", "styleRevisionId", 25, "routingSeq", code, name, "standardMinutes", "scanRequired", "workCentreId" FROM "WorkOrderOperation" WHERE id = $2`,
      [extra, sew.id],
    )
    const before = await opsOf(workOrder.id)
    expect(before).toHaveLength(copied + 1)
    const placed = await ok('POST', '/planning/schedule/slots', { workOrderId: workOrder.id, operationId: extra, lane: { kind: 'LINE', id: lineL1 }, startAt: '2026-11-25T08:00:00.000Z', overloadReason: 'Made-up reason to keep it there.' }, 201)
    const bar = placed.slot.id as string
    const current = await workOrderOf(workOrder.number)

    // While the bar books it: refused naming the bar, with B-W2a-F3's Send it back to the tray, then release it.
    const booked = await release(workOrder.id, current.version)
    expect(booked.statusCode, booked.body).toBe(409)
    const words = `Op 25 ${sew.name} on line L1 from 25 Nov 09:00 (working plan)`
    expect(booked.json().error).toMatchObject({
      code: 'conflict',
      message: `The release would take away an operation of work order ${workOrder.number} that the planning board books: ${words}. ${tray}, then release it.`,
      issues: [{ path: `scheduleSlots/WORKING/${bar}`, message: words }],
    })
    expect(await workOrderOf(workOrder.number)).toMatchObject({ status: 'DRAFT', version: current.version })
    expect(await opsOf(workOrder.id)).toEqual(before)

    // Sent back to the tray: the release goes (it was a 500, then a refusal), the copy leaves, the other steps keep their rows.
    await ok('POST', `/planning/schedule/slots/${bar}/remove`, { version: 1 })
    const response = await release(workOrder.id, current.version)
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().workOrder).toMatchObject({ status: 'RELEASED' })
    expect(await opsOf(workOrder.id)).toEqual(before.filter((op) => op.id !== extra))
    // The board's record keeps both changes of the copy, each with its copy of the operation.
    expect(await changesOf(extra)).toEqual([
      { id: expect.any(String), kind: 'REMOVE', seq: 25, name: sew.name },
      { id: expect.any(String), kind: 'PLACE', seq: 25, name: sew.name },
    ])
    released = { workOrder: { id: workOrder.id, number: workOrder.number }, extra, sewName: sew.name }
  })

  it("B-W2b-F39: the board's Changes list names the operation that left by its copy, and its changes are not undone (409 in words)", async () => {
    const { workOrder, extra, sewName } = released!
    const what = `Op 25 ${sewName} of ${workOrder.number} (no longer on the work order)`
    const words = `${what}: the record keeps this change, but it is not undone.`
    const feed = await ok('GET', `/planning/schedule/changes?siteId=${idOf('site:A1')}&since=ALL&workOrderId=${workOrder.id}`)
    const gone = { id: extra, seq: 25, code: null, name: sewName, onWorkOrder: false }
    expect(feed.entries).toEqual([
      expect.objectContaining({ kind: 'REMOVE', onBoard: false, operation: gone, undo: { may: false, code: 'OPERATION_GONE', permission: 'planning.schedule.manage', words }, words: expect.stringMatching(new RegExp(`^Sent ${what.replace(/[()]/g, '\\$&')} back to the tray from L1 · 25 Nov 09:00`)) }),
      expect.objectContaining({ kind: 'PLACE', onBoard: false, operation: gone, undo: expect.objectContaining({ may: false, code: 'OPERATION_GONE' }), words: expect.stringMatching(/^Placed Op 25 .+ \(no longer on the work order\) on L1 · 25 Nov 09:00/) }),
    ])
    const [remove] = feed.entries as Json[]
    const error = await refused('POST', `/planning/schedule/changes/${remove!.id}/undo`, {}, 409)
    expect(error).toMatchObject({ code: 'conflict', message: words, issues: [{ path: 'refusal/OPERATION_GONE' }] })
    // Nothing changed: no undo in the record, no bar on the board.
    expect((await changesOf(extra)).map((change) => change.kind)).toEqual(['REMOVE', 'PLACE'])
    expect(await slotsOf(workOrder.id)).toEqual([])
  })

  it("a repair's steps: one left out while a bar books it is refused naming the bar; a step that stays keeps its row and its bar; sent back to the tray, it is left out", async () => {
    const repair = (await admin<{ id: string }>(`SELECT id FROM "RepairOrder" WHERE "tenantId" = $1 AND number = 'SEED-REP-0001'`, [T]))[0]!.id
    const { workOrder } = await ok('POST', '/production/work-orders/repairs', { repairOrderId: repair, routingSeqs: [20, 30] }, 201)
    const [sew, qc] = await opsOf(workOrder.id)
    expect([sew!.routingSeq, qc!.routingSeq]).toEqual([20, 30])
    const placed = await ok('POST', '/planning/schedule/slots', { workOrderId: workOrder.id, operationId: sew!.id, lane: { kind: 'LINE', id: lineL1 }, startAt: '2026-11-23T08:00:00.000Z', overloadReason: 'Made-up reason to keep it there.' }, 201)
    const bar = placed.slot.id as string

    const error = await refused('PUT', `/production/work-orders/${workOrder.id}/repair-steps`, { routingSeqs: [30] }, 409)
    const words = `Op 20 ${sew!.name} on line L1 from 23 Nov 09:00 (working plan)`
    expect(error).toMatchObject({
      code: 'conflict',
      message: `Leaving out these steps would take away an operation of work order ${workOrder.number} that the planning board books: ${words}. ${tray}, then change the steps.`,
      issues: [{ path: `scheduleSlots/WORKING/${bar}`, message: words }],
    })
    expect(await opsOf(workOrder.id)).toEqual([sew, qc])

    const changed = await ok('PUT', `/production/work-orders/${workOrder.id}/repair-steps`, { routingSeqs: [10, 20] })
    expect((changed.workOrder.spec.operations as Json[]).map((op) => op.routingSeq)).toEqual([10, 20])
    const after = await opsOf(workOrder.id)
    expect(after.map((op) => op.routingSeq)).toEqual([10, 20])
    expect(after[1]!.id).toBe(sew!.id)
    expect((await slotsOf(workOrder.id)).map((slot) => [slot.id, slot.operationId])).toEqual([[bar, sew!.id]])

    // B-W2b-F39: sent back to the tray on the board, sewing is left out (it was a 500, then a refusal); the board's record keeps
    // its changes, each with the copy of sewing as it was then (its place moved with the steps).
    await ok('POST', `/planning/schedule/slots/${bar}/remove`, { version: (await slotsOf(workOrder.id))[0]!.version })
    const left = await ok('PUT', `/production/work-orders/${workOrder.id}/repair-steps`, { routingSeqs: [10] })
    expect((left.workOrder.spec.operations as Json[]).map((op) => op.routingSeq)).toEqual([10])
    expect(await opsOf(workOrder.id)).toEqual([after[0]])
    expect(await changesOf(sew!.id)).toEqual([
      { id: expect.any(String), kind: 'REMOVE', seq: after[1]!.seq, name: sew!.name },
      { id: expect.any(String), kind: 'PLACE', seq: sew!.seq, name: sew!.name },
    ])
  })

  it('changing the revision of a draft whose operations a bar books: refused naming the bar; sent back to the tray, it changes', async () => {
    // A draft from the made-up order (it fixes no revision: the style's released revision 1), its draft spec stored as
    // the seed stores one (no route stores the operations of a size run before its release), its sewing on line L1.
    const lineId = await madeUpOrder({ '54': 1 })
    const { workOrder } = await ok('POST', '/production/work-orders', { siteId: idOf('site:A1'), lines: [{ salesOrderLineId: lineId, sizes: [{ size: '54', quantity: 1 }] }] }, 201)
    // As many as were copied (SEED-WO-0002's four; the count is not this test's subject).
    const copied = await copySeedOperations(workOrder.id)
    const sew = (await opsOf(workOrder.id)).find((op) => op.routingSeq === 20)!
    const placed = await ok('POST', '/planning/schedule/slots', { workOrderId: workOrder.id, operationId: sew.id, lane: { kind: 'LINE', id: lineL1 }, startAt: '2026-11-24T08:00:00.000Z', overloadReason: 'Made-up reason to keep it there.' }, 201)
    const bar = placed.slot.id as string
    const revision1 = (await workOrderOf(workOrder.number)).styleRevisionId
    // B-W2b-221: SEED-JKT-02 is IN_PRODUCTION, whose default edit rule asks a change order for a new revision; this test is about
    // the planning board, so the tenant lets a style in production take a new revision directly (the rule B-W2b-221's live check used).
    const tenantSettings = (await ok('GET', '/product/settings')).settings
    await ok('PUT', '/product/settings', { companyId: null, ...(tenantSettings.version ? { version: tenantSettings.version } : {}), editRules: { IN_PRODUCTION: 'NEW_REVISION' }, reason: 'A made-up test: a new revision without a change order.' })
    const copy = await ok('POST', `/product/styles/${idOf('production:style:JKT-02')}/revisions/${revision1}/copy`, { changeNote: 'A made-up second revision.' }, 201)
    const revision2 = copy.bom.revision.id as string

    const current = await workOrderOf(workOrder.number)
    const error = await refused('PATCH', `/production/work-orders/${workOrder.id}`, { version: current.version, styleRevisionId: revision2 }, 409)
    const words = `Op 20 ${sew.name} on line L1 from 24 Nov 09:00 (working plan)`
    expect(error).toMatchObject({
      code: 'conflict',
      message: `Changing the revision would take away an operation of work order ${workOrder.number} that the planning board books: ${words}. ${tray}, then change the revision.`,
      issues: [{ path: `scheduleSlots/WORKING/${bar}`, message: words }],
    })
    expect(await workOrderOf(workOrder.number)).toMatchObject({ styleRevisionId: revision1, version: current.version })
    expect((await opsOf(workOrder.id)).length).toBe(copied)

    await ok('POST', `/planning/schedule/slots/${bar}/remove`, { version: 1 })
    const changed = await ok('PATCH', `/production/work-orders/${workOrder.id}`, { version: current.version, styleRevisionId: revision2 })
    expect(changed.workOrder.revision).toMatchObject({ id: revision2, revision: 2, status: 'DRAFT' })
    expect(await opsOf(workOrder.id)).toEqual([])
    // B-W2b-F39: the board's record keeps sewing's changes by their copy (it was a 500, then a refusal).
    expect(await changesOf(sew.id)).toEqual([
      { id: expect.any(String), kind: 'REMOVE', seq: 20, name: sew.name },
      { id: expect.any(String), kind: 'PLACE', seq: 20, name: sew.name },
    ])
  })
})
