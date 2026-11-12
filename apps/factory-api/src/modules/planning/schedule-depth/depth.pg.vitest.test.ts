import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCalendar } from '../../../../../../packages/factory-db/seed/calendar'
import { seed as seedPlanning } from '../../../../../../packages/factory-db/seed/planning'
import { seed as seedSchedule } from '../../../../../../packages/factory-db/seed/schedule'
import { seed as seedSubcontract } from '../../../../../../packages/factory-db/seed/subcontract'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'

/**
 * Scheduling in depth (B-W2b-312; PLN-130 forward scheduling for late orders, PLN-134 moves that know the material, PLN-139
 * pinned operations, PLN-141 the backlog reschedule; design planning.board "What-if") through the app's real routes on a
 * throwaway PostgreSQL 17 database from the migrations (runtime login, row-level security and the guards real), on the
 * factory-db seeds' made-up plant A1: line L1 (two shifts), the work centres CUT, SEW, QC, PACK on the company's one shift,
 * SEED-WO-0001 (7 jackets in progress, due 4 Dec; its red leather comes with a firm planned order by 16 Nov) on the working
 * plan (cutting 16 Nov, sewing on L1 17 Nov, final inspection and packing 18 Nov), the draft SEED-WO-0002 (sewing on L1
 * 19 Nov), v1 published. The clock is fixed at Tuesday 10 Nov 2026 09:00 UTC (10:00 at the plant): before the real day the
 * guards compare "not in the future" with. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/planning/schedule-depth/`.
 */

const NOW = new Date('2026-11-10T09:00:00.000Z')
const NS = 'w2b312-depth'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const siteA1 = idOf('site:A1')
const planner = newId()
const planner2 = newId()

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const PLANNER: Permission[] = ['planning.view', 'planning.schedule.manage', 'planning.schedule.publish', 'planning.schedule.pin', 'workorders.view']
const SESSIONS: Record<string, SessionContext> = {
  planner: { audience: 'office', tenantId: T, actorId: planner, grants: [grant(PLANNER)] },
  planner2: { audience: 'office', tenantId: T, actorId: planner2, grants: [grant(PLANNER)] },
  manager: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['planning.view', 'planning.schedule.pin', 'workorders.view'])] },
  viewer: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['planning.view', 'workorders.view'])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await db.admin.query(sql, values)).rows as Row[]
let keys = 0
const key = () => `w2b312-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const codeOf = (error: Json): string | null => (error.issues as { path: string }[] | undefined)?.find((issue) => issue.path.startsWith('refusal/'))?.path.slice('refusal/'.length) ?? null
const board = (session = 'planner') => ok(session, 'GET', `/planning/schedule?siteId=${siteA1}&from=2026-11-09&to=2026-11-27`)
const workOrderId = async (number: string) => (await admin<{ id: string }>('SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND number = $2', [T, number]))[0]!.id
const slotOf = async (number: string, code: string) =>
  (
    await admin<{ id: string; version: number; startAt: Date; endAt: Date; pinned: boolean }>(
      `SELECT s.id, s.version, s."startAt", s."endAt", s.pinned FROM "ScheduleSlot" s JOIN "WorkOrderOperation" o ON o.id = s."workOrderOperationId" JOIN "WorkOrder" w ON w.id = s."workOrderId"
        WHERE s."tenantId" = $1 AND s."planKind" = 'WORKING' AND w.number = $2 AND o.code = $3`,
      [T, number, code],
    )
  )[0]
const changes = async () => admin<{ kind: string; slotId: string; whatIfScenarioId: string | null; fromStartAt: Date | null; toStartAt: Date | null }>('SELECT kind, "slotId", "whatIfScenarioId", "fromStartAt", "toStartAt" FROM "ScheduleChange" WHERE "tenantId" = $1 ORDER BY "changedAt", id', [T])
const changeKinds = async () => (await admin<{ change: string }>(`SELECT payload->>'change' AS change FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'planning.schedule_changed' ORDER BY "occurredAt", id`, [T])).map((row) => row.change)
const audits = async (action: string) => admin<{ recordType: string; after: Json }>('SELECT "recordType", after FROM "AuditLog" WHERE "tenantId" = $1 AND action = $2 ORDER BY at, id', [T, action])

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  db = await migratedDatabase('planning_schedule_depth')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: NS })
  await seedCalendar({ db: database, namespace: NS })
  await seedPlanning({ db: database, namespace: NS })
  await seedSchedule({ db: database, namespace: NS })
  await seedSubcontract({ db: database, namespace: NS })
  await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, $5), ($6, $2, $7, $8, $5)', [planner, T, 'pia@example.com', 'Pia Planner', 'ACTIVE', planner2, 'paolo@example.com', 'Paolo Planner'])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 240_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
  vi.useRealTimers()
})

describe('moves that know the material (PLN-134)', () => {
  it("gives a work order's earliest start with material on the board, the check of a drop, a move's answer and the problems list", async () => {
    const answer = await board()
    const wo1 = answer.workOrders.find((row: Json) => row.number === 'SEED-WO-0001')
    // The red leather comes with the firm planned order on 16 Nov: work may start the day after, on the cutting lane's first shift.
    expect(wo1.materialStart).toMatchObject({ state: 'ARRIVES', arrives: '2026-11-16', startDay: '2026-11-17', setBy: { label: 'SEED-LEA-100 RED', source: 'FIRM' } })
    expect(new Date(wo1.materialStart.earliestStart).getTime()).toBeGreaterThanOrEqual(new Date('2026-11-16T23:00:00.000Z').getTime())
    expect(wo1.materialStart.words).toMatch(/^SEED-LEA-100 RED arrives 16 Nov \(a firm planned order\)\. Earliest start with material: 17 Nov \d\d:\d\d\.$/)
    // Its cutting bar starts on 16 Nov: material not in time, named on the board's problems with the bar.
    const cut = await slotOf('SEED-WO-0001', 'SEED-CUT-LEA')
    expect(answer.problems.find((problem: Json) => problem.kind === 'MATERIAL_NOT_IN_TIME')).toMatchObject({ workOrderId: wo1.id, slotId: cut!.id, date: '2026-11-17' })
    // The drop's check: earlier is warned with the start to snap to; on the day is in time.
    const early = await ok('viewer', 'GET', `/planning/schedule/work-orders/${wo1.id}/material?startAt=2026-11-16T13:00:00.000Z`)
    expect(early.check).toMatchObject({ state: 'ARRIVES', inTime: false, snapTo: wo1.materialStart.earliestStart })
    expect(early.check.words).toMatch(/^SEED-LEA-100 RED arrives 16 Nov \(a firm planned order\)\. Earliest start with material: 17 Nov /)
    const onTime = await ok('viewer', 'GET', `/planning/schedule/work-orders/${wo1.id}/material?startAt=2026-11-18T08:00:00.000Z`)
    expect(onTime.check).toMatchObject({ inTime: true, snapTo: null })
    expect(early.materials.find((material: Json) => material.label === 'SEED-LEA-100 RED')).toMatchObject({ word: 'REQUESTED', arrives: '2026-11-16', usableFrom: '2026-11-17' })
    // A move earlier than the material is not refused: its answer warns and offers the snap (on the sewing line's calendar).
    const sew = await slotOf('SEED-WO-0001', 'SEED-SEW-ASM')
    const moved = await ok('planner', 'PATCH', `/planning/schedule/slots/${sew!.id}`, { version: sew!.version, startAt: '2026-11-16T13:00:00.000Z' })
    expect(moved.material).toMatchObject({ state: 'ARRIVES', inTime: false, startAt: '2026-11-16T13:00:00.000Z' })
    expect(new Date(moved.material.snapTo).getTime()).toBeGreaterThanOrEqual(new Date('2026-11-16T23:00:00.000Z').getTime())
    // Snap to it: in time.
    const snapped = await ok('planner', 'PATCH', `/planning/schedule/slots/${sew!.id}`, { version: moved.slot.version, startAt: moved.material.snapTo })
    expect(snapped.material).toMatchObject({ inTime: true, snapTo: null })
    // Back where the seed has it, for what follows.
    await ok('planner', 'PATCH', `/planning/schedule/slots/${sew!.id}`, { version: snapped.slot.version, startAt: '2026-11-17T09:00:00.000Z' })
    // A work order the plan has no need for: nothing holds it.
    const wo2 = await ok('viewer', 'GET', `/planning/schedule/work-orders/${await workOrderId('SEED-WO-0002')}/material`)
    expect(wo2.materialStart.state).toMatch(/^(NOT_PLANNED|IN_HAND|ARRIVES)$/)
  })
})

describe('pinned operations (PLN-139)', () => {
  it('pins a bar where it is: a move and a removal are refused in words, a note is not; the log, the audit and the event', async () => {
    const pack = (await slotOf('SEED-WO-0001', 'SEED-PACK'))!
    const pinned = await ok('planner', 'POST', `/planning/schedule/slots/${pack.id}/pin`, { version: pack.version, pinned: true })
    expect(pinned.slot).toMatchObject({ id: pack.id, version: pack.version + 1, pinned: true, pinnedAt: NOW.toISOString(), pinnedBy: { id: planner, name: 'Pia Planner' } })
    const move = await refused('planner', 'PATCH', `/planning/schedule/slots/${pack.id}`, { version: pinned.slot.version, startAt: '2026-11-19T10:00:00.000Z' }, 409)
    expect(codeOf(move)).toBe('PINNED')
    expect(move.message).toBe('Op 40 Pack of SEED-WO-0001 is pinned by Pia Planner at 10 Nov 10:00: it stays on its lane and times; unpin it to move it.')
    const noted = await ok('planner', 'PATCH', `/planning/schedule/slots/${pack.id}`, { version: pinned.slot.version, note: 'Brand visit that morning (made up).' })
    expect(noted.slot).toMatchObject({ pinned: true, note: 'Brand visit that morning (made up).', startAt: pinned.slot.startAt })
    const removal = await refused('planner', 'POST', `/planning/schedule/slots/${pack.id}/remove`, { version: noted.slot.version }, 409)
    expect([codeOf(removal), removal.message]).toEqual(['PINNED', 'Op 40 Pack of SEED-WO-0001 is pinned by Pia Planner at 10 Nov 10:00: it stays on its lane and times; unpin it to send it back to the tray.'])
    expect(codeOf(await refused('planner', 'POST', `/planning/schedule/slots/${pack.id}/pin`, { version: noted.slot.version, pinned: true }, 409))).toBe('ALREADY_PINNED')
    // A stale version names who moved it.
    expect(codeOf(await refused('planner', 'POST', `/planning/schedule/slots/${pack.id}/pin`, { version: pack.version, pinned: false }, 409))).toBe('MOVED_BY')
    // The database holds the same rule for every login.
    await expect(admin(`UPDATE "ScheduleSlot" SET "startAt" = "startAt" + interval '1 hour', "endAt" = "endAt" + interval '1 hour' WHERE id = $1`, [pack.id])).rejects.toThrow(/is pinned/)
    expect((await changes()).filter((row) => row.kind === 'PIN').map((row) => row.slotId)).toEqual([pack.id])
    expect((await audits('planning.schedule.pin'))[0]).toMatchObject({ recordType: 'ScheduleSlot', after: { pinned: true } })
    expect(await changeKinds()).toContain('PINNED')
    // The board shows it.
    expect((await board()).slots.find((slot: Json) => slot.id === pack.id)).toMatchObject({ pinned: true, pinnedBy: { name: 'Pia Planner' } })
  })

  it('the production manager pins a whole work order (and moves nothing); the reader may not; unpin', async () => {
    const wo2 = await workOrderId('SEED-WO-0002')
    const all = await ok('manager', 'POST', `/planning/schedule/work-orders/${wo2}/pin`, { pinned: true })
    expect(all).toMatchObject({ workOrderId: wo2, pinned: true, changed: 1 })
    expect(all.slots.every((slot: Json) => slot.pinned)).toBe(true)
    expect(codeOf(await refused('manager', 'POST', `/planning/schedule/work-orders/${wo2}/pin`, { pinned: true }, 409))).toBe('NOTHING_TO_PIN')
    const sew = (await slotOf('SEED-WO-0002', 'SEED-SEW-ASM'))!
    await refused('manager', 'PATCH', `/planning/schedule/slots/${sew.id}`, { version: sew.version, startAt: '2026-11-19T09:00:00.000Z' }, 403)
    await refused('viewer', 'POST', `/planning/schedule/work-orders/${wo2}/pin`, { pinned: false }, 403)
    const back = await ok('manager', 'POST', `/planning/schedule/work-orders/${wo2}/pin`, { pinned: false })
    expect(back).toMatchObject({ changed: 1, pinned: false })
    expect((await changes()).filter((row) => row.kind === 'UNPIN').map((row) => row.slotId)).toEqual([sew.id])
  })

  it('a published version keeps the pins', async () => {
    const before = await board()
    const published = await ok('planner', 'POST', '/planning/schedule/publish', { siteId: siteA1, version: before.plan.version, coversFrom: '2026-11-16', coversTo: '2026-11-20', effectiveFrom: NOW.toISOString() }, 201)
    const version = await ok('viewer', 'GET', `/planning/schedule/versions/${published.version.id}`)
    expect(version.slots.find((slot: Json) => slot.operation?.code === 'SEED-PACK')).toMatchObject({ pinned: true, pinnedBy: { name: 'Pia Planner' } })
    expect(version.slots.find((slot: Json) => slot.operation?.code === 'SEED-FIN-QC')).toMatchObject({ pinned: false, pinnedBy: null })
  })
})

describe('forward scheduling for late orders (PLN-130)', () => {
  it('schedules a work order that cannot meet its date backwards from today on the lanes free time: a preview, then one command', async () => {
    const wo2 = await workOrderId('SEED-WO-0002')
    await admin('UPDATE "WorkOrder" SET "dueDate" = $2 WHERE id = $1', [wo2, '2026-11-09'])
    const preview = await ok('viewer', 'POST', '/planning/schedule/forward', { siteId: siteA1, apply: false })
    expect(preview).toMatchObject({ applied: false, mode: 'FORWARD', skipped: [], kept: [], overbooked: 0 })
    // WO-0001 can still meet 4 Dec backwards: only the late draft is scheduled forward.
    expect(preview.orders.map((order: Json) => order.number)).toEqual(['SEED-WO-0002'])
    // Every operation with work left, one after another from now: cutting, then its sewing bar moved, inspection, packing.
    expect(preview.moves.map((move: Json) => [move.operation.code, move.why])).toEqual([
      ['SEED-CUT-LEA', 'PLACED'],
      ['SEED-SEW-ASM', 'FORWARD'],
      ['SEED-FIN-QC', 'PLACED'],
      ['SEED-PACK', 'PLACED'],
    ])
    const starts = preview.moves.map((move: Json) => new Date(move.to.startAt).getTime())
    const ends = preview.moves.map((move: Json) => new Date(move.to.endAt).getTime())
    expect(starts[0]).toBeGreaterThanOrEqual(NOW.getTime())
    for (let index = 1; index < starts.length; index += 1) expect(starts[index]).toBeGreaterThanOrEqual(ends[index - 1])
    const order = preview.orders[0]
    expect(order).toMatchObject({ before: { status: 'LATE' }, after: { status: 'LATE' }, dueDate: '2026-11-09', finish: preview.moves[3].to.endAt, moves: 4 })
    expect(order.daysLate).toBeGreaterThanOrEqual(1)
    expect(order.words).toMatch(/^Scheduled forward from 10 Nov 10:00 on the lanes' free time, SEED-WO-0002 finishes .+, \d+ days? after its due date 9 Nov 2026\.$/)
    expect(preview.words).toBe("1 work order scheduled forward from today: 1 bar moves, 3 placed from the tray.")
    // A reader may preview, not apply; a stale version is refused.
    await refused('viewer', 'POST', '/planning/schedule/forward', { siteId: siteA1, apply: true, version: preview.planVersion }, 403)
    expect(codeOf(await refused('planner', 'POST', '/planning/schedule/forward', { siteId: siteA1, apply: true, version: preview.planVersion - 1 }, 409))).toBe('PLAN_CHANGED')
    const applied = await ok('planner', 'POST', '/planning/schedule/forward', { siteId: siteA1, apply: true, version: preview.planVersion })
    expect(applied).toMatchObject({ applied: true, planVersion: preview.planVersion + 1 })
    expect(applied.moves.map((move: Json) => move.to)).toEqual(preview.moves.map((move: Json) => move.to))
    const slots = await admin<{ code: string; startAt: Date }>(`SELECT o.code, s."startAt" FROM "ScheduleSlot" s JOIN "WorkOrderOperation" o ON o.id = s."workOrderOperationId" WHERE s."planKind" = 'WORKING' AND s."workOrderId" = $1 ORDER BY o.seq`, [wo2])
    expect(slots.map((slot) => [slot.code, slot.startAt.toISOString()])).toEqual(preview.moves.map((move: Json) => [move.operation.code, move.to.startAt]))
    expect((await changes()).filter((row) => row.kind === 'PLACE' || row.kind === 'MOVE').map((row) => row.kind).sort()).toEqual(['MOVE', 'PLACE', 'PLACE', 'PLACE'])
    expect((await audits('planning.schedule.forward'))[0]).toMatchObject({ recordType: 'PlanVersion' })
    expect((await changeKinds()).at(-1)).toBe('SCHEDULED_FORWARD')
    // Nothing moves a second time.
    const again = await refused('planner', 'POST', '/planning/schedule/forward', { siteId: siteA1, apply: true, version: applied.planVersion }, 409)
    expect([codeOf(again), again.message]).toEqual(['NOTHING_TO_RESCHEDULE', 'Nothing to move: SEED-WO-0002 is already where scheduling from today puts it.'])
  })
})

describe('reschedule the backlog (PLN-141)', () => {
  it('moves a bar left in the past into the first free time from its material day, keeps what still fits, and a pinned bar in the past stays', async () => {
    const cut = (await slotOf('SEED-WO-0001', 'SEED-CUT-LEA'))!
    const qc = (await slotOf('SEED-WO-0001', 'SEED-FIN-QC'))!
    await admin(`UPDATE "ScheduleSlot" SET "startAt" = '2026-11-09T08:00:00Z', "endAt" = '2026-11-09T10:00:00Z', version = version + 1 WHERE id = $1`, [cut.id])
    await admin(`UPDATE "ScheduleSlot" SET "startAt" = '2026-11-09T13:00:00Z', "endAt" = '2026-11-09T14:00:00Z', pinned = true, "pinnedAt" = '2026-11-09T12:00:00Z', "pinnedById" = $2, version = version + 1 WHERE id = $1`, [qc.id, planner])
    const shown = await board()
    expect(shown.problems.filter((problem: Json) => problem.kind === 'IN_THE_PAST').map((problem: Json) => problem.slotId).sort()).toEqual([cut.id, qc.id].sort())
    expect(shown.problems.find((problem: Json) => problem.slotId === qc.id).words).toMatch(/it is pinned \(unpin it to reschedule it\)\.$/)
    const preview = await ok('viewer', 'POST', '/planning/schedule/reschedule-backlog', { siteId: siteA1, apply: false })
    // The cutting goes to the first free time once the red leather is there (17 Nov); the sewing still fits after it and stays.
    expect(preview.moves.map((move: Json) => [move.slotId, move.why])).toEqual([[cut.id, 'PAST']])
    expect(new Date(preview.moves[0].to.startAt).getTime()).toBeGreaterThanOrEqual(new Date('2026-11-16T23:00:00.000Z').getTime())
    expect(preview.kept).toEqual([expect.objectContaining({ slotId: qc.id, code: 'PINNED_IN_THE_PAST' })])
    expect(preview.words).toBe('The backlog of 1 work order: 1 bar moves, 1 pinned bar stays.')
    const applied = await ok('planner', 'POST', '/planning/schedule/reschedule-backlog', { siteId: siteA1, apply: true, version: preview.planVersion })
    expect(applied.moves[0].to).toEqual(preview.moves[0].to)
    expect((await slotOf('SEED-WO-0001', 'SEED-CUT-LEA'))!.startAt.toISOString()).toBe(preview.moves[0].to.startAt)
    expect((await slotOf('SEED-WO-0001', 'SEED-FIN-QC'))!.startAt.toISOString()).toBe('2026-11-09T13:00:00.000Z')
    expect((await changes()).at(-1)).toMatchObject({ kind: 'MOVE', slotId: cut.id, fromStartAt: new Date('2026-11-09T08:00:00.000Z') })
    expect((await changeKinds()).at(-1)).toBe('BACKLOG_RESCHEDULED')
    expect(codeOf(await refused('planner', 'POST', '/planning/schedule/reschedule-backlog', { siteId: siteA1, apply: true, version: applied.planVersion }, 409))).toBe('NOTHING_TO_RESCHEDULE')
    // The pinned bar in the past back to where it was before (unpinned) for what follows.
    await ok('planner', 'POST', `/planning/schedule/slots/${qc.id}/pin`, { version: qc.version + 1, pinned: false })
  })
})

describe('what-if (design planning.board sec:whatif)', () => {
  it('tries moves privately, shows their effect, names what changed since, and applies the rest in one command', async () => {
    const made = await ok('planner', 'POST', '/planning/schedule/what-ifs', { siteId: siteA1, name: 'Inspection on Thursday (made up)' }, 201)
    expect(made.scenario).toMatchObject({ status: 'DRAFT', version: 1, moves: [], conflicts: 0, banner: 'What-if — nothing reaches the floor or other planners until you apply.' })
    const qc = (await slotOf('SEED-WO-0001', 'SEED-FIN-QC'))!
    const pack = (await slotOf('SEED-WO-0001', 'SEED-PACK'))!
    // A pinned bar is not moved, not even in a what-if.
    const pinnedTry = await refused('planner', 'PUT', `/planning/schedule/what-ifs/${made.scenario.id}/moves`, { version: 1, moves: [{ kind: 'MOVE', slotId: pack.id, startAt: '2026-11-19T10:00:00.000Z' }] }, 400)
    expect(pinnedTry.issues[0]).toMatchObject({ path: 'body/moves/0/slotId' })
    const tried = await ok('planner', 'PUT', `/planning/schedule/what-ifs/${made.scenario.id}/moves`, { version: 1, moves: [{ kind: 'MOVE', slotId: qc.id, startAt: '2026-11-19T13:00:00.000Z' }] })
    expect(tried.scenario).toMatchObject({ version: 2, conflicts: 0, moves: [{ kind: 'MOVE', slotId: qc.id, slotVersion: qc.version, number: 'SEED-WO-0001', conflict: null, to: { startAt: '2026-11-19T13:00:00.000Z' } }] })
    expect(tried.scenario.effect.orders.map((order: Json) => order.number)).toEqual(['SEED-WO-0001'])
    expect(tried.scenario.effect.words).toMatch(/^late orders \d+ → \d+ · overtime needed [\d.]+ → [\d.]+ h · QC load \d+% → \d+% · orders that move: 1$/)
    // Private: the working plan did not move, and another planner does not see it.
    expect((await slotOf('SEED-WO-0001', 'SEED-FIN-QC'))!.startAt.toISOString()).toBe(qc.startAt.toISOString())
    await refused('planner2', 'GET', `/planning/schedule/what-ifs/${made.scenario.id}`, undefined, 404)
    expect((await ok('planner2', 'GET', `/planning/schedule/what-ifs?siteId=${siteA1}`)).scenarios).toEqual([])
    expect((await ok('planner', 'GET', `/planning/schedule/what-ifs?siteId=${siteA1}`)).scenarios.map((row: Json) => [row.id, row.moves])).toEqual([[made.scenario.id, 1]])
    // Another planner moves the bar a minute later: the what-if names it, and Apply lists it.
    vi.setSystemTime(new Date(NOW.getTime() + 60_000))
    await ok('planner2', 'PATCH', `/planning/schedule/slots/${qc.id}`, { version: qc.version, startAt: '2026-11-18T09:00:00.000Z' })
    const seen = await ok('planner', 'GET', `/planning/schedule/what-ifs/${made.scenario.id}`)
    expect(seen.scenario).toMatchObject({ planChanged: true, conflicts: 1, moves: [{ conflict: { code: 'SLOT_MOVED' } }] })
    expect(seen.scenario.moves[0].conflict.words).toMatch(/^SEED-WO-0001: the bar was moved by Paolo Planner at 10 Nov 10:01 since you tried it\.$/)
    const clash = await refused('planner', 'POST', `/planning/schedule/what-ifs/${made.scenario.id}/apply`, { version: 2 }, 409)
    expect(codeOf(clash)).toBe('WHAT_IF_CONFLICTS')
    expect(clash.issues[0]).toMatchObject({ path: 'moves/0/SLOT_MOVED' })
    // Tried again with a new target: the bar is read again, no conflict.
    const retried = await ok('planner', 'PUT', `/planning/schedule/what-ifs/${made.scenario.id}/moves`, { version: 2, moves: [{ kind: 'MOVE', slotId: qc.id, startAt: '2026-11-19T14:00:00.000Z' }] })
    expect(retried.scenario).toMatchObject({ version: 3, conflicts: 0, moves: [{ slotVersion: qc.version + 1 }] })
    const applied = await ok('planner', 'POST', `/planning/schedule/what-ifs/${made.scenario.id}/apply`, { version: 3 })
    expect(applied).toMatchObject({ scenario: { status: 'APPLIED', version: 4 }, applied: 1, skipped: [] })
    expect((await slotOf('SEED-WO-0001', 'SEED-FIN-QC'))!.startAt.toISOString()).toBe('2026-11-19T14:00:00.000Z')
    expect((await changes()).at(-1)).toMatchObject({ kind: 'MOVE', slotId: qc.id, whatIfScenarioId: made.scenario.id })
    expect((await changeKinds()).at(-1)).toBe('WHAT_IF_APPLIED')
    expect((await audits('planning.whatif.apply'))[0]).toMatchObject({ recordType: 'WhatIfScenario', after: { status: 'APPLIED', applied: 1 } })
    // An applied what-if never changes.
    expect(codeOf(await refused('planner', 'POST', `/planning/schedule/what-ifs/${made.scenario.id}/apply`, { version: 4 }, 409))).toBe('WHAT_IF_CLOSED')
    expect(codeOf(await refused('planner', 'POST', `/planning/schedule/what-ifs/${made.scenario.id}/discard`, { version: 4 }, 409))).toBe('WHAT_IF_CLOSED')
  })

  it('throws a what-if away: discarded, nothing changed, no event', async () => {
    const before = (await changeKinds()).length
    const made = await ok('planner', 'POST', '/planning/schedule/what-ifs', { siteId: siteA1 }, 201)
    const sew = (await slotOf('SEED-WO-0002', 'SEED-SEW-ASM'))!
    await ok('planner', 'PUT', `/planning/schedule/what-ifs/${made.scenario.id}/moves`, { version: 1, moves: [{ kind: 'REMOVE', slotId: sew.id }] })
    const gone = await ok('planner', 'POST', `/planning/schedule/what-ifs/${made.scenario.id}/discard`, { version: 2 })
    expect(gone.scenario).toMatchObject({ status: 'DISCARDED', version: 3 })
    expect((await slotOf('SEED-WO-0002', 'SEED-SEW-ASM'))!.id).toBe(sew.id)
    expect((await changeKinds()).length).toBe(before)
    await refused('viewer', 'POST', '/planning/schedule/what-ifs', { siteId: siteA1 }, 403)
  })
})
