import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { completeContext, testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { scheduleBoard } from '../../../platform/exports/sources/schedule-board'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCalendar } from '../../../../../../packages/factory-db/seed/calendar'
import { seed as seedPlanning } from '../../../../../../packages/factory-db/seed/planning'
import { seed as seedSchedule } from '../../../../../../packages/factory-db/seed/schedule'
import { seed as seedSubcontract } from '../../../../../../packages/factory-db/seed/subcontract'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'

/**
 * The board's record (B-W2b-329; PLN-133 status colours from the floor, PLN-149 every move logged with undo, PLN-154 day
 * sheets per line, the board as a sheet, published versions to read) through the app's real routes on a throwaway
 * PostgreSQL 17 database from the migrations (runtime login, row-level security and the guards real: ScheduleChange is
 * append-only, one undo per change), on the factory-db seeds' made-up plant A1: line L1, the work centres CUT, SEW, QC,
 * PACK, SEED-WO-0001 (7 jackets in progress; sewing reported for a bundle) on the working plan (cutting 16 Nov, sewing on
 * L1 17 Nov, final inspection and packing 18 Nov), the draft SEED-WO-0002 (sewing on L1 19 Nov), v1 published, the workshop
 * of the subcontract seed. The clock is fixed at Tuesday 10 Nov 2026 09:00 UTC (10:00 at the plant): before the real day
 * the guards compare "not in the future" with; the feed is read with `since=ALL` where the seeded v1 (published 15 Nov)
 * would hide it. Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs
 * modules/planning/schedule-log/`.
 */

const NOW = new Date('2026-11-10T09:00:00.000Z')
const NS = 'w2b329-record'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const siteA1 = idOf('site:A1')
const lineL1 = idOf('site:A1:line:L1')
const planner = newId()
const planner2 = newId()

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let workshopId: string

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
const key = () => `w2b329-${++keys}`
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
const board = (session = 'planner') => ok(session, 'GET', `/planning/schedule?siteId=${siteA1}&from=2026-11-09&to=2026-11-27&readiness=false`)
const feed = (query = '', session = 'planner') => ok(session, 'GET', `/planning/schedule/changes?siteId=${siteA1}&since=ALL${query}`)
const workOrderId = async (number: string) => (await admin<{ id: string }>('SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND number = $2', [T, number]))[0]!.id
const slotOf = async (number: string, code: string) =>
  (
    await admin<{ id: string; version: number; startAt: Date; endAt: Date; pinned: boolean }>(
      `SELECT s.id, s.version, s."startAt", s."endAt", s.pinned FROM "ScheduleSlot" s JOIN "WorkOrderOperation" o ON o.id = s."workOrderOperationId" JOIN "WorkOrder" w ON w.id = s."workOrderId"
        WHERE s."tenantId" = $1 AND s."planKind" = 'WORKING' AND w.number = $2 AND o.code = $3`,
      [T, number, code],
    )
  )[0]
/** A timing scan at an operation of SEED-WO-0001, as the tablet writes it (the seeded report's worker and device). */
async function timing(operationCode: string, kind: 'START' | 'PAUSE' | 'RESUME', at: string, pauseReasonCode: string | null = null) {
  const report = (await admin<Json>(`SELECT * FROM "OperationScan" WHERE "tenantId" = $1 AND kind = 'REPORT' AND "goodQuantity" = 2 ORDER BY "serverTime" LIMIT 1`, [T]))[0]!
  const [operation] = await admin<{ id: string }>(`SELECT o.id FROM "WorkOrderOperation" o JOIN "WorkOrder" w ON w.id = o."workOrderId" WHERE w."tenantId" = $1 AND w.number = 'SEED-WO-0001' AND o.code = $2`, [T, operationCode])
  await admin(
    `INSERT INTO "OperationScan" (id, "tenantId", "siteId", "workOrderId", "workOrderOperationId", "bundleId", kind, "pauseReasonCode", "workerId", "stationId", "deviceId", "clientScanId", "deviceTime", "serverTime", "createdById")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, $14)`,
    [newId(), T, report.siteId, report.workOrderId, operation!.id, report.bundleId, kind, pauseReasonCode, report.workerId, report.stationId, report.deviceId, `w2b329-${kind}-${at}`, new Date(at), report.createdById],
  )
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  db = await migratedDatabase('plan_sched_log')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: NS })
  await seedCalendar({ db: database, namespace: NS })
  await seedPlanning({ db: database, namespace: NS })
  await seedSchedule({ db: database, namespace: NS })
  const subcontract = await seedSubcontract({ db: database, namespace: NS })
  workshopId = (await admin<{ partyId: string }>('SELECT "partyId" FROM "Location" WHERE id = $1', [subcontract.locationId]))[0]!.partyId
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

describe('status colours from the floor (PLN-133)', () => {
  it('colours each bar by what the scans say: under way, not started, running, paused; on the board and the bar popover', async () => {
    const wo1 = await workOrderId('SEED-WO-0001')
    let answer = await board()
    const order = answer.workOrders.find((row: Json) => row.id === wo1)
    const sewOp = order.operations.find((operation: Json) => operation.code === 'SEED-SEW-ASM')
    const sew = answer.slots.find((slot: Json) => slot.operationId === sewOp.id)
    // A bundle reported at sewing, nothing being worked: under way.
    expect(sew.floor).toMatchObject({ state: 'RUNNING', of: 7, done: 7 - sewOp.remainingPieces, runningBundles: 0, pausedBundles: 0 })
    expect(sew.floor.words).toMatch(/^Under way: \d of 7 garments done; no bundle is being worked now\.$/)
    const qcOp = order.operations.find((operation: Json) => operation.code === 'SEED-FIN-QC')
    expect(answer.slots.find((slot: Json) => slot.operationId === qcOp.id).floor).toMatchObject({ state: 'NOT_STARTED', done: 0, of: 7, pct: 0 })
    // The draft's sewing: nothing on the floor.
    const wo2 = answer.workOrders.find((row: Json) => row.number === 'SEED-WO-0002')
    expect(answer.slots.find((slot: Json) => slot.workOrderId === wo2.id).floor).toMatchObject({ state: 'NOT_STARTED', of: 1 })
    // A bundle started at final inspection: running since then; paused: paused with its reason; resumed: running.
    await timing('SEED-FIN-QC', 'START', '2026-11-10T08:30:00.000Z')
    answer = await board()
    expect(answer.slots.find((slot: Json) => slot.operationId === qcOp.id).floor).toMatchObject({ state: 'RUNNING', runningBundles: 1, since: '2026-11-10T08:30:00.000Z', words: 'Running: 0 of 7 garments done, 1 bundle being worked since 09:30.' })
    await timing('SEED-FIN-QC', 'PAUSE', '2026-11-10T08:45:00.000Z', 'BREAK')
    const popover = await ok('viewer', 'GET', `/planning/schedule/work-orders/${wo1}`)
    const paused = popover.slots.find((slot: Json) => slot.operationId === qcOp.id).floor
    expect(paused).toMatchObject({ state: 'PAUSED', pausedBundles: 1, runningBundles: 0, since: '2026-11-10T08:45:00.000Z', pauseReasonCode: 'BREAK' })
    // Per bar only: no worker or station of the scans in the answer.
    const [report] = await admin<{ workerId: string | null; stationId: string | null }>(`SELECT "workerId", "stationId" FROM "OperationScan" WHERE "tenantId" = $1 AND kind = 'PAUSE'`, [T])
    for (const value of [report!.workerId, report!.stationId].filter((entry): entry is string => entry !== null)) expect(JSON.stringify(popover)).not.toContain(value)
    await timing('SEED-FIN-QC', 'RESUME', '2026-11-10T08:55:00.000Z')
    answer = await board()
    expect(answer.slots.find((slot: Json) => slot.operationId === qcOp.id).floor).toMatchObject({ state: 'RUNNING', runningBundles: 1, since: '2026-11-10T08:55:00.000Z' })
  })
})

describe('every move logged with who, when, from → to, undone while still ours (PLN-149)', () => {
  it('logs a move; the latest change of a bar is undone (by any planner) and goes back one change at a time; never twice', async () => {
    const sew = (await slotOf('SEED-WO-0001', 'SEED-SEW-ASM'))!
    const first = await ok('planner', 'PATCH', `/planning/schedule/slots/${sew.id}`, { version: sew.version, startAt: '2026-11-17T10:00:00.000Z' })
    let log = await feed(`&slotId=${sew.id}`)
    expect(log.entries).toHaveLength(1)
    const moved = log.entries[0]
    expect(moved).toMatchObject({ kind: 'MOVE', changedBy: { id: planner, name: 'Pia Planner' }, slotId: sew.id, onBoard: true, operation: { code: 'SEED-SEW-ASM' }, undo: { may: true, code: null, permission: 'planning.schedule.manage' } })
    expect(moved.from).toMatchObject({ lane: { kind: 'LINE', id: lineL1, code: 'L1' }, startAt: '2026-11-17T09:00:00.000Z', endAt: sew.endAt.toISOString() })
    expect(moved.to).toMatchObject({ lane: { kind: 'LINE', code: 'L1' }, startAt: '2026-11-17T10:00:00.000Z', endAt: first.slot.endAt })
    expect(moved.words).toMatch(/^Moved Op 20 Sew and assemble the body of SEED-WO-0001 from L1 · 17 Nov 10:00–\d\d:\d\d to L1 · 17 Nov 11:00–.+\.$/)
    // A note alone is no move: nothing logged.
    const noted = await ok('planner', 'PATCH', `/planning/schedule/slots/${sew.id}`, { version: first.slot.version, note: 'Use the black thread (made up).' })
    expect((await feed(`&slotId=${sew.id}`)).entries).toHaveLength(1)
    // Another planner moves it on: the first move is no longer the bar's latest.
    const second = await ok('planner2', 'PATCH', `/planning/schedule/slots/${sew.id}`, { version: noted.slot.version, startAt: '2026-11-17T12:00:00.000Z' })
    log = await feed(`&slotId=${sew.id}`)
    expect(log.entries.map((entry: Json) => [entry.kind, entry.changedBy.name, entry.undo.code])).toEqual([
      ['MOVE', 'Paolo Planner', null],
      ['MOVE', 'Pia Planner', 'CHANGED_SINCE'],
    ])
    expect(log.entries[1].undo.words).toMatch(/changed since: moved by Paolo Planner at 10 Nov 10:00\. Only the latest change of a bar is undone\.$/)
    const stale = await refused('planner', 'POST', `/planning/schedule/changes/${moved.id}/undo`, {}, 409)
    expect(codeOf(stale)).toBe('CHANGED_SINCE')
    // Pia undoes Paolo's move: the bar is back where Pia put it; the undo is logged and names what it undid.
    const undone = await ok('planner', 'POST', `/planning/schedule/changes/${log.entries[0].id}/undo`, {})
    expect(undone.slot).toMatchObject({ id: sew.id, startAt: '2026-11-17T10:00:00.000Z', endAt: first.slot.endAt, version: second.slot.version + 1 })
    expect(undone.undo).toMatchObject({ kind: 'UNDO', undoes: { id: log.entries[0].id, kind: 'MOVE' }, changedBy: { name: 'Pia Planner' }, from: { startAt: '2026-11-17T12:00:00.000Z' }, to: { startAt: '2026-11-17T10:00:00.000Z' }, undo: { may: false, code: 'NOT_UNDOABLE' } })
    expect(undone.undone).toMatchObject({ undoneBy: { changedBy: { name: 'Pia Planner' } }, undo: { code: 'ALREADY_UNDONE' } })
    expect(undone.undo.words).toMatch(/^Undid the move of Op 20 Sew and assemble the body of SEED-WO-0001: back on L1 · 17 Nov 11:00–/)
    // Never twice; an undo is not undone; and now Pia's own move is the bar's latest standing change again (⌘Z once more).
    expect(codeOf(await refused('planner2', 'POST', `/planning/schedule/changes/${log.entries[0].id}/undo`, {}, 409))).toBe('ALREADY_UNDONE')
    expect(codeOf(await refused('planner', 'POST', `/planning/schedule/changes/${undone.undo.id}/undo`, {}, 409))).toBe('NOT_UNDOABLE')
    log = await feed(`&slotId=${sew.id}`)
    expect(log.entries.map((entry: Json) => [entry.kind, entry.undo.code])).toEqual([
      ['UNDO', 'NOT_UNDOABLE'],
      ['MOVE', 'ALREADY_UNDONE'],
      ['MOVE', null],
    ])
    const back = await ok('planner2', 'POST', `/planning/schedule/changes/${moved.id}/undo`, {})
    expect(back.slot).toMatchObject({ startAt: '2026-11-17T09:00:00.000Z', endAt: sew.endAt.toISOString() })
    // The database keeps one undo per change, for every login.
    const [row] = await admin<{ id: string; planVersionId: string }>('SELECT id, "planVersionId" FROM "ScheduleChange" WHERE "tenantId" = $1 AND kind = $2 AND "undoesChangeId" = $3', [T, 'UNDO', moved.id])
    await expect(admin(`INSERT INTO "ScheduleChange" (id, "tenantId", "siteId", "planVersionId", kind, "slotId", "workOrderId", "undoesChangeId", "changedById", "changedAt") SELECT $1, "tenantId", "siteId", "planVersionId", 'UNDO', "slotId", "workOrderId", $2, "changedById", "changedAt" FROM "ScheduleChange" WHERE id = $3`, [newId(), moved.id, row!.id])).rejects.toThrow(/ScheduleChange_one_undo|duplicate key/)
    const audits = await admin<{ recordId: string; after: Json }>(`SELECT "recordId", after FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'planning.schedule.undo' ORDER BY at, id`, [T])
    expect(audits.map((audit) => [audit.recordId, audit.after.action])).toEqual([
      [log.entries[1].id, 'MOVE_BACK'],
      [moved.id, 'MOVE_BACK'],
    ])
    const events = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'planning.schedule_changed' AND payload->>'change' = 'UNDONE' ORDER BY "occurredAt", id`, [T])
    expect(events.map((event) => event.payload.slotIds)).toEqual([[sew.id], [sew.id]])
  })

  it('logs a pin and a removal; a pin is undone with the pin permission, a removal comes back on the same slot id', async () => {
    const pack = (await slotOf('SEED-WO-0001', 'SEED-PACK'))!
    await ok('planner', 'POST', `/planning/schedule/slots/${pack.id}/pin`, { version: pack.version, pinned: true })
    const [pin] = (await feed(`&slotId=${pack.id}&kinds=PIN`)).entries
    expect(pin).toMatchObject({ kind: 'PIN', from: null, to: null, undo: { may: true, permission: 'planning.schedule.pin' } })
    // A reader of plans may not undo it; the production manager (who pins) may.
    expect((await feed(`&slotId=${pack.id}`, 'viewer')).entries[0].undo).toMatchObject({ may: false, code: 'NO_PERMISSION' })
    await refused('viewer', 'POST', `/planning/schedule/changes/${pin.id}/undo`, {}, 403)
    const unpinned = await ok('manager', 'POST', `/planning/schedule/changes/${pin.id}/undo`, {})
    expect(unpinned.slot).toMatchObject({ pinned: false, pinnedAt: null })
    // Sent back to the tray, then put back: the same slot id at the same place.
    const now = (await slotOf('SEED-WO-0001', 'SEED-PACK'))!
    await ok('planner', 'POST', `/planning/schedule/slots/${pack.id}/remove`, { version: now.version })
    const [removal] = (await feed(`&slotId=${pack.id}`)).entries
    expect(removal).toMatchObject({ kind: 'REMOVE', onBoard: false, to: null, from: { lane: { kind: 'WORK_CENTRE', code: 'PACK' }, startAt: now.startAt.toISOString() }, undo: { may: true } })
    const putBack = await ok('planner', 'POST', `/planning/schedule/changes/${removal.id}/undo`, {})
    expect(putBack.slot).toMatchObject({ id: pack.id, startAt: now.startAt.toISOString(), endAt: now.endAt.toISOString(), pinned: false })
    expect(putBack.undo.words).toMatch(/^Undid sending Op 40 Pack of SEED-WO-0001 back to the tray: on PACK · 18 Nov /)
  })

  it('logs a placement and an allocation; a placement is taken off by its undo; a part taken off goes back on the allocation board', async () => {
    const wo2 = await workOrderId('SEED-WO-0002')
    const draftSew = (await slotOf('SEED-WO-0002', 'SEED-SEW-ASM'))!
    await ok('planner', 'POST', `/planning/schedule/slots/${draftSew.id}/remove`, { version: draftSew.version })
    const placed = await ok('planner', 'POST', '/planning/schedule/slots', { workOrderId: wo2, operationId: (await admin<{ id: string }>(`SELECT id FROM "WorkOrderOperation" WHERE "workOrderId" = $1 AND code = 'SEED-SEW-ASM'`, [wo2]))[0]!.id, lane: { kind: 'LINE', id: lineL1 }, startAt: '2026-11-19T09:00:00.000Z' }, 201)
    const [place] = (await feed(`&slotId=${placed.slot.id}`)).entries
    expect(place).toMatchObject({ kind: 'PLACE', from: null, to: { lane: { code: 'L1' }, startAt: '2026-11-19T09:00:00.000Z' } })
    const off = await ok('planner', 'POST', `/planning/schedule/changes/${place.id}/undo`, {})
    expect(off.slot).toBeNull()
    expect((await admin('SELECT id FROM "ScheduleSlot" WHERE id = $1', [placed.slot.id])).length).toBe(0)
    // The allocation board: a part at the workshop (PLACE), then taken off again (REMOVE): not undone here.
    const card = (await ok('planner', 'GET', `/planning/allocation?siteId=${siteA1}`)).cards.find((entry: Json) => entry.workOrder.id === wo2)
    const allocated = await ok('planner', 'PUT', `/planning/allocation/work-orders/${wo2}`, { version: card.workOrder.version, lineId: lineL1, parts: [{ lane: { kind: 'WORKSHOP', id: workshopId }, pieces: 1 }] })
    const part = (await feed(`&workOrderId=${wo2}&kinds=PLACE`)).entries.find((entry: Json) => entry.operation === null)
    expect(part).toMatchObject({ kind: 'PLACE', to: { lane: { kind: 'WORKSHOP', id: workshopId } } })
    await ok('planner', 'PUT', `/planning/allocation/work-orders/${wo2}`, { version: allocated.workOrder.version, lineId: lineL1, parts: [] })
    const [taken] = (await feed(`&slotId=${part.slotId}`)).entries
    expect(taken).toMatchObject({ kind: 'REMOVE', undo: { may: false, code: 'NOT_UNDOABLE' } })
    expect(codeOf(await refused('planner', 'POST', `/planning/schedule/changes/${taken.id}/undo`, {}, 409))).toBe('NOT_UNDOABLE')
  })

  it('logs a publish (no undo); the feed starts after the last version by default; filters by planner and kind', async () => {
    const before = await board()
    const published = await ok('planner', 'POST', '/planning/schedule/publish', { siteId: siteA1, version: before.plan.version, coversFrom: '2026-11-16', coversTo: '2026-11-20', effectiveFrom: NOW.toISOString() }, 201)
    const all = await feed('&kinds=PUBLISH')
    expect(all.entries[0]).toMatchObject({ kind: 'PUBLISH', slotId: null, workOrder: null, publishedVersion: { id: published.version.id, number: 2 }, undo: { may: false, code: 'NOT_UNDOABLE' }, words: 'Published v2 to the floor.' })
    expect(codeOf(await refused('planner', 'POST', `/planning/schedule/changes/${all.entries[0].id}/undo`, {}, 409))).toBe('NOT_UNDOABLE')
    // "No moves since v2".
    const since = await ok('viewer', 'GET', `/planning/schedule/changes?siteId=${siteA1}`)
    expect(since).toMatchObject({ since: { id: published.version.id, number: 2 }, entries: [], next: null })
    // One planner's changes ("Filter by planner"); pages by a cursor.
    const paolo = await feed(`&changedById=${planner2}`)
    expect(new Set(paolo.entries.map((entry: Json) => entry.changedBy.id))).toEqual(new Set([planner2]))
    const page = await feed('&limit=2')
    expect(page.entries).toHaveLength(2)
    const next = await feed(`&limit=2&cursor=${encodeURIComponent(page.next)}`)
    expect(next.entries[0].id).not.toBe(page.entries[1].id)
    expect(new Date(next.entries[0].changedAt).getTime()).toBeLessThanOrEqual(new Date(page.entries[1].changedAt).getTime())
    await refused('viewer', 'GET', `/planning/schedule/changes?siteId=${siteA1}&kinds=JUMP`, undefined, 400)
  })
})

describe('day sheets per line, the board as a sheet, a published version to read (PLN-154)', () => {
  it('prints the version the floor works to that day, per line, with the floor state; the working plan marked not published', async () => {
    const paper = await ok('viewer', 'GET', `/planning/schedule/day-sheets/paper?siteId=${siteA1}&date=2026-11-17&language=en`)
    expect(paper).toMatchObject({ title: 'Day sheet', fileName: 'Day sheet L1 2026-11-17.pdf' })
    expect(paper.sheets).toHaveLength(1)
    const [sheet] = paper.sheets
    expect(sheet).toMatchObject({ heading: expect.stringMatching(/^Line L1 · /), banner: null, empty: null })
    expect(sheet.facts.find((fact: Json) => fact.label === 'Plan').value).toMatch(/^v2, published 2026-11-10 10:00$/)
    expect(sheet.rows.map((row: Json) => [row.cells[0], row.cells[2]])).toEqual([['10:00', 'SEED-WO-0001']])
    // The bar's note rides with its operation.
    expect(sheet.rows[0].cells[4]).toBe('Op 20 Sew and assemble the body Note: Use the black thread (made up).')
    expect(sheet.rows[0].cells[8]).toMatch(/^Running \d\/7$/)
    expect(sheet.footer).toMatch(/^Total: \d pieces · [\d.]+ min · load [\d.]+% \(/)
    // The working plan on another day, a work centre too: marked, and the floor's version named.
    const centre = (await admin<{ id: string }>(`SELECT id FROM "WorkCentre" WHERE "tenantId" = $1 AND "siteId" = $2 AND code = 'QC'`, [T, siteA1]))[0]!.id
    const working = await ok('viewer', 'GET', `/planning/schedule/day-sheets/paper?siteId=${siteA1}&date=2026-11-18&plan=WORKING&lineIds=${lineL1}&workCentreIds=${centre}`)
    expect(working.sheets.map((entry: Json) => [entry.heading.split(' · ')[0], entry.banner, entry.rows.length])).toEqual([
      ['Linea L1', 'Piano di lavoro non ancora pubblicato al reparto: il reparto lavora con v2.', 0],
      ['Centro di lavoro QC', 'Piano di lavoro non ancora pubblicato al reparto: il reparto lavora con v2.', 1],
    ])
    expect(working.sheets[0].empty).toBe('Niente in programma su questa linea in questo giorno.')
    expect(working.sheets[1].rows[0].cells[8]).toBe('In corso 0/7')
    // No version covers a day: said in words; an unknown line: 404; a bad id: 400.
    const none = await refused('viewer', 'GET', `/planning/schedule/day-sheets/paper?siteId=${siteA1}&date=2026-12-21`, undefined, 404)
    expect(none.message).toBe('No published version covers 2026-12-21 at A1: publish the plan, or print the working plan.')
    await refused('viewer', 'GET', `/planning/schedule/day-sheets/paper?siteId=${siteA1}&lineIds=${newId()}`, undefined, 404)
    await refused('viewer', 'GET', `/planning/schedule/day-sheets/paper?siteId=${siteA1}&lineIds=L1`, undefined, 400)
    // The PDF, inline.
    const pdf = await call('viewer', 'GET', `/planning/schedule/day-sheets?siteId=${siteA1}&date=2026-11-17`)
    expect(pdf.statusCode).toBe(200)
    expect(pdf.headers['content-type']).toBe('application/pdf')
    expect(String(pdf.headers['content-disposition'])).toMatch(/^inline; filename="Foglio di giornata L1 2026-11-17\.pdf"/)
    expect(pdf.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  it('opens a published version read-only beside the working plan, and the board and a version as a sheet', async () => {
    const versions = (await ok('viewer', 'GET', `/planning/schedule/versions?siteId=${siteA1}`)).versions
    const v2 = versions.find((version: Json) => version.number === 2)
    const v1 = versions.find((version: Json) => version.number === 1)
    // Move the cutting after v2: the version's cutting bar is MOVED beside the working plan.
    const cut = (await slotOf('SEED-WO-0001', 'SEED-CUT-LEA'))!
    await ok('planner', 'PATCH', `/planning/schedule/slots/${cut.id}`, { version: cut.version, startAt: '2026-11-16T09:00:00.000Z' })
    const read = await ok('viewer', 'GET', `/planning/schedule/versions/${v2.id}/board`)
    expect(read).toMatchObject({ readOnly: true, floor: 'CURRENT', version: { number: 2, publishedBy: { name: 'Pia Planner' } } })
    const states = Object.fromEntries(read.slots.map((slot: Json) => [slot.operation.code, slot.working.state]))
    expect(states['SEED-CUT-LEA']).toBe('MOVED')
    expect(states['SEED-FIN-QC']).toBe('SAME')
    expect(read.slots.find((slot: Json) => slot.operation.code === 'SEED-CUT-LEA').working.slot).toMatchObject({ id: cut.id, startAt: '2026-11-16T09:00:00.000Z' })
    expect(read.slots.find((slot: Json) => slot.operation.code === 'SEED-FIN-QC')).toMatchObject({ laneCode: 'QC', workOrder: { number: 'SEED-WO-0001', style: { code: expect.any(String) } }, floor: { state: 'RUNNING' } })
    expect(read.compare).toMatchObject({ moved: 1, removed: 0 })
    expect(read.compare.words).toMatch(/^Since v2 the working plan has 1 moved, \d added, 0 removed on its days\.$/)
    expect((await ok('viewer', 'GET', `/planning/schedule/versions/${v1.id}/board`)).floor).toBe('REPLACED')
    // The working plan is no published version.
    await refused('viewer', 'GET', `/planning/schedule/versions/${(await board()).plan.id}/board`, undefined, 404)
    // The board's export source reads the board as the person sees it (a row per bar, in start order), or a version.
    const caller = callerFor(database, completeContext(SESSIONS.planner!, 'w2b329-export'))
    const query = scheduleBoard.query(new URLSearchParams(`site=${siteA1}&from=2026-11-16&to=2026-11-20`))
    const page = await scheduleBoard.read(caller, query, null, 1000, { locale: 'en' })
    const rows = page.rows as Json[]
    expect(rows.map((row) => row.startAt)).toEqual([...rows.map((row) => row.startAt)].sort())
    const words = (code: string) => scheduleBoard.words!.en[code] ?? code
    const qcRow = rows.find((row) => row.operation?.seq === 30)!
    expect(Object.fromEntries(Object.entries(scheduleBoard.columns).map(([column, spec]) => [column, spec.value(qcRow, words)]))).toMatchObject({ lane: expect.stringMatching(/^QC · .* · Work centre$/), operation: 'Op 30 Final inspection', floor: 'Running 0/7', pinned: 'No', workOrder: 'SEED-WO-0001' })
    const ofVersion = await scheduleBoard.read(caller, scheduleBoard.query(new URLSearchParams(`version=${v2.id}`)), null, 1000, { locale: 'it' })
    expect(ofVersion.rows).toHaveLength(read.slots.length)
  })
})
