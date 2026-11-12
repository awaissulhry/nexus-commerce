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
 * The planning board (B-W2a-34; PLN-129 backward scheduling and latest safe start, PLN-131 the board, PLN-132 order and
 * resource views, PLN-147 publish to the floor, PLN-160 allocation to lines and workshops, MES-021 the dispatch list;
 * Owner answer P3) through the app's real routes on a throwaway PostgreSQL 17 database from the migrations (runtime
 * login, row-level security real), on the factory-db seeds' made-up plant A1: line L1 (8 people at 85 %, two shifts;
 * stations SEW-01/02 of the SEW work centre), the work centres on the company's one shift, workshop P2 with its location
 * A1-TERZ-P2, SEED-WO-0001 (7 jackets, in progress, due 4 Dec) and the draft SEED-WO-0002 (1 jacket), v1 published for
 * 16-20 Nov (from 06:00 on the 16th) and the working plan moved on since (sewing an hour later, WO-0002's sewing added).
 * The clock is fixed at Monday 16 Nov 2026 09:00 UTC (10:00 at the plant). Run with
 * `node scripts/factory/run-pg-tests.mjs modules/planning/schedule modules/production/dispatch`.
 */

const NOW = new Date('2026-11-16T09:00:00.000Z')
const NS = 'w2a34-schedule'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const siteA1 = idOf('site:A1')
const lineL1 = idOf('site:A1:line:L1')
const planner = newId()
const viewer = newId()
const deviceId = newId()

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let workshopId: string

const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  planner: { audience: 'office', tenantId: T, actorId: planner, grants: [grant(['planning.view', 'planning.schedule.manage', 'planning.schedule.publish', 'workorders.view'])] },
  viewer: { audience: 'office', tenantId: T, actorId: viewer, grants: [grant(['planning.view', 'workorders.view'])] },
  outsider: { audience: 'office', tenantId: T, actorId: viewer, grants: [grant(['planning.view'])] },
  floor: { audience: 'floor', tenantId: T, actorId: newId(), siteId: siteA1, deviceId, grants: [{ permissions: ['floor.work'], companies: [companyA], sites: [siteA1], parties: 'all' }] },
}

type Json = Record<string, any>
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await db.admin.query(sql, values)).rows as Row[]
const call = (session: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown, key?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const board = (query = 'from=2026-11-16&to=2026-11-20') => ok('planner', 'GET', `/planning/schedule?siteId=${siteA1}&${query}`)
const workingSlot = async (number: string, operationCode: string) =>
  (
    await admin<{ id: string; version: number }>(
      `SELECT s.id, s.version FROM "ScheduleSlot" s JOIN "WorkOrderOperation" o ON o.id = s."workOrderOperationId" JOIN "WorkOrder" w ON w.id = s."workOrderId"
        WHERE s."tenantId" = $1 AND s."planKind" = 'WORKING' AND w.number = $2 AND o.code = $3`,
      [T, number, operationCode],
    )
  )[0]!
const workOrderId = async (number: string) => (await admin<{ id: string }>('SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND number = $2', [T, number]))[0]!.id
const events = async (type: string) => admin<{ payload: Json }>('SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id', [T, type])
const audits = async (action: string) => admin<{ recordType: string; after: Json }>('SELECT "recordType", after FROM "AuditLog" WHERE "tenantId" = $1 AND action = $2', [T, action])

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  db = await migratedDatabase('planning_schedule')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: NS })
  await seedCalendar({ db: database, namespace: NS })
  await seedPlanning({ db: database, namespace: NS })
  await seedSchedule({ db: database, namespace: NS })
  const subcontract = await seedSubcontract({ db: database, namespace: NS })
  workshopId = (await admin<{ partyId: string }>('SELECT "partyId" FROM "Location" WHERE id = $1', [subcontract.locationId]))[0]!.partyId
  await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, $5)', [planner, T, 'pat@example.com', 'Pat Planner', 'ACTIVE'])
  const station = (await admin<{ id: string }>('SELECT id FROM "Station" WHERE "tenantId" = $1 AND code = $2', [T, 'SEW-01']))[0]!.id
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, 'Sewing tablet 1', 'TABLET', 'ACTIVE', now())`, [deviceId, T, companyA, siteA1, station])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 240_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
  vi.useRealTimers()
})

describe('the board: resource and order views, latest safe start (PLN-129, PLN-131, PLN-132)', () => {
  it('draws the lanes with their load, the working plan, every open work order with why it is late or in time, and the tray', async () => {
    const answer = await board()
    expect([answer.today, answer.bucket, answer.buckets.length]).toEqual(['2026-11-16', 'DAY', 5])
    expect(answer.lanes.map((lane: Json) => [lane.kind, lane.code])).toEqual([
      ['LINE', 'L1'],
      ['WORK_CENTRE', 'CUT'],
      ['WORK_CENTRE', 'PACK'],
      ['WORK_CENTRE', 'QC'],
      ['WORK_CENTRE', 'SEW'],
      ['WORKSHOP', expect.any(String)],
    ])
    const workshop = answer.lanes.find((lane: Json) => lane.kind === 'WORKSHOP')
    expect(workshop).toMatchObject({ id: workshopId, cells: null, location: { code: 'A1-TERZ-P2' } })
    const l1 = answer.lanes[0]
    expect(l1.cells.find((cell: Json) => cell.key === '2026-11-17')).toMatchObject({ availableMinutes: '6324.0', words: '8 people × 930 min × 85% efficiency × 1 day = 6,324 min.' })
    // The resource view: the working plan's five slots; the draft's bar books no capacity.
    expect(answer.slots).toHaveLength(5)
    const wo2 = await workOrderId('SEED-WO-0002')
    expect(answer.slots.find((slot: Json) => slot.workOrderId === wo2)).toMatchObject({ booksCapacity: false, lane: { kind: 'LINE', id: lineL1 } })
    // The order view: WO-0001 wholly on the board and in time; WO-0002 a draft with one bar of four.
    const wo1 = answer.workOrders.find((row: Json) => row.number === 'SEED-WO-0001')
    expect(wo1.schedule).toMatchObject({ status: 'ON_TIME', placed: 'ALL' })
    expect(wo1.schedule.words).toMatch(/^SEED-WO-0001 can start as late as .+ and still finish by 4 Dec 2026; the plan finishes it on 18 Nov /)
    expect(new Date(wo1.schedule.latestSafeStart).getTime()).toBeLessThan(new Date('2026-12-04T23:00:00Z').getTime())
    expect(wo1.schedule.latestFinish).toBe('2026-12-04T16:00:00.000Z')
    const sew = wo1.operations.find((operation: Json) => operation.code === 'SEED-SEW-ASM')
    expect(sew).toMatchObject({ lane: { kind: 'LINE', id: lineL1 }, standardMinutes: '96.500' })
    expect(sew.slotIds).toHaveLength(1)
    const draft = answer.workOrders.find((row: Json) => row.number === 'SEED-WO-0002')
    expect(draft).toMatchObject({ status: 'DRAFT', booksCapacity: false, schedule: { placed: 'PART' } })
    expect(answer.tray).toEqual([expect.objectContaining({ workOrderId: wo2, unplacedOperations: 3, chips: expect.arrayContaining(['DRAFT']) })])
    // The band: v1 published, what moved since on its days, Publish not held.
    expect(answer.plan).toMatchObject({ version: 1, published: { number: 1, coversFrom: '2026-11-16', coversTo: '2026-11-20' }, changesSincePublished: { moved: 1, added: 1, removed: 0, words: '1 moved, 1 added' }, mayChange: true, mayPublish: true, publishHeld: null })
    expect(answer.problems).toEqual([])
  })

  it('gives the bar popover: sizes, operations with their latest starts, its slots and lanes', async () => {
    const wo1 = await workOrderId('SEED-WO-0001')
    const detail = await ok('planner', 'GET', `/planning/schedule/work-orders/${wo1}`)
    expect(detail.sizes.reduce((sum: number, size: Json) => sum + size.quantity, 0)).toBe(7)
    expect(detail.slots).toHaveLength(4)
    expect(detail.workOrder.operations.map((operation: Json) => operation.code)).toEqual(['SEED-CUT-LEA', 'SEED-SEW-ASM', 'SEED-FIN-QC', 'SEED-PACK'])
    expect(detail.lanes.map((lane: Json) => lane.code).sort()).toEqual(['CUT', 'L1', 'PACK', 'QC'])
  })

  it('is read-only without planning.schedule.manage; another tenant sees no site', async () => {
    const answer = await ok('viewer', 'GET', `/planning/schedule?siteId=${siteA1}`)
    expect(answer.plan).toMatchObject({ mayChange: false, mayPublish: false, publishHeld: 'Publishing needs planning.schedule.publish at this site.' })
    const slot = await workingSlot('SEED-WO-0001', 'SEED-SEW-ASM')
    expect((await call('viewer', 'PATCH', `/planning/schedule/slots/${slot.id}`, { version: slot.version, startAt: '2026-11-17T09:00:00.000Z' })).statusCode).toBe(403)
  })
})

describe('moves into the shared working plan (PLN-131, Owner answer P3)', () => {
  it('moves a bar: a new end from the lane, the plan version up, audited, an event; a stale version names who moved it', async () => {
    const slot = await workingSlot('SEED-WO-0001', 'SEED-SEW-ASM')
    const moved = await ok('planner', 'PATCH', `/planning/schedule/slots/${slot.id}`, { version: slot.version, startAt: '2026-11-17T07:00:00.000Z' })
    expect(moved.slot).toMatchObject({ version: slot.version + 1, startAt: '2026-11-17T07:00:00.000Z', updatedBy: { id: planner, name: 'Pat Planner' }, overloadReason: null })
    // Sewing 7 jackets × 96.5 min on L1 (8 people at 85 %) takes 100 working minutes.
    expect(moved.slot.endAt).toBe('2026-11-17T08:40:00.000Z')
    expect(moved.planVersion).toBe(2)
    expect(moved.schedule).toMatchObject({ status: 'ON_TIME' })
    const stale = await call('planner', 'PATCH', `/planning/schedule/slots/${slot.id}`, { version: slot.version, startAt: '2026-11-17T08:00:00.000Z' })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error.message).toMatch(/^Moved by Pat Planner at 16 Nov 10:00 \(version \d+; you had version \d+\)\. Reload the board\.$/)
    expect((await events('planning.schedule_changed')).map((event) => event.payload.change)).toEqual(['MOVED'])
    expect((await audits('planning.schedule.move'))[0]).toMatchObject({ recordType: 'ScheduleSlot' })
  })

  it('refuses a bar on a lane that does not do its operation, in words', async () => {
    const slot = await workingSlot('SEED-WO-0001', 'SEED-CUT-LEA')
    const response = await call('planner', 'PATCH', `/planning/schedule/slots/${slot.id}`, { version: slot.version, lane: { kind: 'LINE', id: lineL1 } })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.message).toBe('Line 1 (A1) does Sewing; Op 10 Cut leather panels is done at Cutting.')
  })

  it('warns on an overbooked lane: refused without a reason, kept with one (the drop warning)', async () => {
    await admin('UPDATE "LineCapacity" SET operators = 1, "plannedEfficiencyPct" = 10 WHERE id = $1', [lineL1])
    const slot = await workingSlot('SEED-WO-0001', 'SEED-SEW-ASM')
    const refused = await call('planner', 'PATCH', `/planning/schedule/slots/${slot.id}`, { version: slot.version, startAt: '2026-11-18T07:00:00.000Z', endAt: '2026-11-18T15:00:00.000Z' })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error.message).toMatch(/would be at \d+\.\d% on 18 Nov 2026 \(\+\d+\.\d min over\)\. Keep it there with a reason, or choose another place\.$/)
    expect(refused.json().error.issues[0]).toEqual({ path: 'body/overloadReason', message: 'Say why it stays on the overbooked lane.' })
    const kept = await ok('planner', 'PATCH', `/planning/schedule/slots/${slot.id}`, { version: slot.version, startAt: '2026-11-18T07:00:00.000Z', endAt: '2026-11-18T15:00:00.000Z', overloadReason: 'Rush for the fair; two people from line 2 help.' })
    expect(kept.slot.overloadReason).toBe('Rush for the fair; two people from line 2 help.')
    expect(kept.over.length).toBeGreaterThan(0)
    const answer = await board()
    expect(answer.problems.filter((problem: Json) => problem.kind === 'OVERBOOKED').map((problem: Json) => problem.date)).toContain('2026-11-18')
    await admin('UPDATE "LineCapacity" SET operators = 8, "plannedEfficiencyPct" = 85 WHERE id = $1', [lineL1])
  })

  it('sends a bar back to the tray, then places the tray by due date: a preview, then one command', async () => {
    const wo2 = await workOrderId('SEED-WO-0002')
    const slot = await workingSlot('SEED-WO-0002', 'SEED-SEW-ASM')
    const removed = await ok('planner', 'POST', `/planning/schedule/slots/${slot.id}/remove`, { version: slot.version })
    expect(removed).toMatchObject({ removed: slot.id, workOrderId: wo2 })
    const preview = await ok('planner', 'POST', '/planning/schedule/place-by-due-date', { siteId: siteA1, workOrderIds: [wo2], apply: false })
    expect(preview).toMatchObject({ applied: false, overbooked: 0, skipped: [] })
    expect(preview.slots.map((entry: Json) => [entry.placedBy, entry.lane.kind])).toEqual([
      ['BACKWARD', 'WORK_CENTRE'],
      ['BACKWARD', 'WORK_CENTRE'],
      ['BACKWARD', 'WORK_CENTRE'],
      ['BACKWARD', 'WORK_CENTRE'],
    ])
    // Backward from the end of work on its due date (Friday 4 Dec, 17:00 at the plant): packing ends then.
    expect(preview.slots[3].endAt).toBe('2026-12-04T16:00:00.000Z')
    expect(await admin('SELECT 1 FROM "ScheduleSlot" WHERE "workOrderId" = $1 AND "planKind" = $2', [wo2, 'WORKING'])).toHaveLength(0)
    const stale = await call('planner', 'POST', '/planning/schedule/place-by-due-date', { siteId: siteA1, workOrderIds: [wo2], apply: true, version: 1 })
    expect(stale.statusCode).toBe(409)
    const applied = await ok('planner', 'POST', '/planning/schedule/place-by-due-date', { siteId: siteA1, workOrderIds: [wo2], apply: true, version: preview.planVersion })
    expect(applied).toMatchObject({ applied: true, overbooked: 0 })
    expect(applied.slots.map((entry: Json) => entry.endAt)).toEqual(preview.slots.map((entry: Json) => entry.endAt))
    expect(await admin('SELECT 1 FROM "ScheduleSlot" WHERE "workOrderId" = $1 AND "planKind" = $2', [wo2, 'WORKING'])).toHaveLength(4)
    const again = await call('planner', 'POST', '/planning/schedule/place-by-due-date', { siteId: siteA1, workOrderIds: [wo2], apply: true, version: applied.planVersion })
    expect([again.statusCode, again.json().error.message]).toEqual([409, 'Nothing to place: every operation with work left is on the board.'])
    expect((await events('planning.schedule_changed')).map((event) => event.payload.change)).toEqual(['MOVED', 'MOVED', 'REMOVED', 'PLACED_BY_DUE_DATE'])
  })
})

describe('publish to the floor (PLN-147, Owner answer P3)', () => {
  it('previews the next version: the next five working days, the diff, the checks', async () => {
    const preview = await ok('planner', 'GET', `/planning/schedule/publish?siteId=${siteA1}`)
    expect(preview).toMatchObject({ next: 2, previous: { number: 1 }, range: { coversFrom: '2026-11-17', coversTo: '2026-11-23', workingDays: 5, isDefault: true }, mayPublish: true, heldReason: null })
    expect(preview.diff).toMatchObject({ moved: 1, added: 0, removed: 0 })
    expect(preview.checks.map((check: Json) => [check.code, check.state])).toEqual([
      ['OVERBOOKED', 'PASS'],
      ['IN_THE_PAST', 'PASS'],
      ['MATERIAL_NOT_READY', expect.any(String)],
    ])
  })

  it('publishes v2 from now in one command; the floor sees only published plans; nothing changed is held', async () => {
    const before = await board()
    const stale = await call('planner', 'POST', '/planning/schedule/publish', { siteId: siteA1, version: before.plan.version - 1 })
    expect(stale.statusCode).toBe(409)
    const published = await ok('planner', 'POST', '/planning/schedule/publish', { siteId: siteA1, version: before.plan.version, effectiveFrom: NOW.toISOString(), note: 'Sewing moved to Tuesday morning.' }, 201)
    expect(published).toMatchObject({ version: { number: 2, coversFrom: '2026-11-17', coversTo: '2026-11-23', effectiveFrom: NOW.toISOString(), publishedBy: { id: planner, name: 'Pat Planner' } }, diff: { moved: 1, added: 0, removed: 0 } })
    const rows = await admin<{ n: number }>('SELECT count(*)::int AS n FROM "ScheduleSlot" WHERE "planVersionId" = $1', [published.version.id])
    expect(rows[0]!.n).toBe(published.slots)
    expect((await events('planning.schedule_published'))[0]!.payload).toMatchObject({ number: 2, moved: 1, coversFrom: '2026-11-17' })
    // A published version never changes (the triggers), and the floor never reads the working plan (the policies).
    await expect(admin('UPDATE "PlanVersion" SET note = $2 WHERE id = $1', [published.version.id, 'changed'])).rejects.toThrow(/never changes/)
    const floorSees = await database.withScope({ audience: 'floor', tenantId: T, actorId: newId(), siteId: siteA1 }, (client) => client.scheduleSlot.groupBy({ by: ['planKind'], _count: { _all: true } }))
    expect(floorSees.map((row) => row.planKind)).toEqual(['PUBLISHED'])
    const held = await ok('planner', 'GET', `/planning/schedule/publish?siteId=${siteA1}`)
    expect(held).toMatchObject({ mayPublish: false, heldReason: 'Nothing changed since v2 was published for 17 Nov 2026 to 23 Nov 2026.' })
    const again = await call('planner', 'POST', '/planning/schedule/publish', { siteId: siteA1, version: held.plan.version })
    expect(again.statusCode).toBe(409)
    const versions = await ok('planner', 'GET', `/planning/schedule/versions?siteId=${siteA1}`)
    expect(versions.versions.map((version: Json) => version.number)).toEqual([2, 1])
    const one = await ok('planner', 'GET', `/planning/schedule/versions/${published.version.id}`)
    expect(one.slots.length).toBe(published.slots)
  })
})

describe('the dispatch list reads the published plan (MES-021; the full checks: modules/production/dispatch)', () => {
  it('gives the floor its station queue from the version just published, and names no person (Statuto dei Lavoratori art. 4)', async () => {
    const station = await ok('floor', 'GET', '/production/dispatch/station')
    expect(station).toMatchObject({ target: { kind: 'STATION', code: 'SEW-01', line: { id: lineL1 } }, version: { number: 2 }, upcoming: null })
    expect(station.entries.map((entry: Json) => [entry.workOrder.number, entry.operation.code, entry.startAt])).toEqual([['SEED-WO-0001', 'SEED-SEW-ASM', '2026-11-18T07:00:00.000Z']])
    const names = (await admin<{ name: string }>('SELECT "displayName" AS name FROM "Worker" WHERE "tenantId" = $1', [T])).map((row) => row.name)
    expect(names.length).toBeGreaterThan(0)
    const texts = [JSON.stringify(await board()), JSON.stringify(station), JSON.stringify(await ok('planner', 'GET', `/planning/allocation?siteId=${siteA1}`))]
    for (const text of texts) for (const name of names) expect(text).not.toContain(name)
  })
})

describe('allocation to lines and workshops (PLN-160)', () => {
  it('allocates a work order to a line with part of it at a workshop, and the capacity counts the parts by garments', async () => {
    const wo1 = await workOrderId('SEED-WO-0001')
    const allocation = await ok('planner', 'GET', `/planning/allocation?siteId=${siteA1}`)
    expect(allocation.lanes.map((lane: Json) => [lane.kind, lane.code])).toEqual([
      ['LINE', 'L1'],
      ['WORKSHOP', expect.any(String)],
    ])
    expect(allocation.lanes[1]).toMatchObject({ id: workshopId, load: null, location: { code: 'A1-TERZ-P2' } })
    const card = allocation.cards.find((entry: Json) => entry.workOrder.id === wo1)
    expect(card).toMatchObject({ id: `${wo1}:LINE`, lane: null, pieces: 7, slot: null })
    const refused = await call('planner', 'PUT', `/planning/allocation/work-orders/${wo1}`, { version: card.workOrder.version, lineId: lineL1, parts: [{ lane: { kind: 'WORKSHOP', id: workshopId }, pieces: 9 }] })
    expect([refused.statusCode, refused.json().error.message]).toEqual([400, 'The parts name 9 garments; the work order has 7.'])
    const done = await ok('planner', 'PUT', `/planning/allocation/work-orders/${wo1}`, { version: card.workOrder.version, lineId: lineL1, parts: [{ lane: { kind: 'WORKSHOP', id: workshopId }, pieces: 2 }] })
    expect(done.workOrder).toMatchObject({ lineId: lineL1, version: card.workOrder.version + 1 })
    expect(done.cards.map((entry: Json) => [entry.lane?.kind ?? null, entry.pieces])).toEqual([
      ['LINE', 5],
      ['WORKSHOP', 2],
    ])
    expect((await admin<{ lineId: string }>('SELECT "lineId" FROM "WorkOrder" WHERE id = $1', [wo1]))[0]!.lineId).toBe(lineL1)
    const stale = await call('planner', 'PUT', `/planning/allocation/work-orders/${wo1}`, { version: card.workOrder.version, lineId: null, parts: [] })
    expect(stale.statusCode).toBe(409)
    const after = await ok('planner', 'GET', `/planning/allocation?siteId=${siteA1}`)
    expect(after.lanes.map((lane: Json) => lane.piecesBooked)).toEqual([5, 2])
    expect((await events('planning.schedule_changed')).at(-1)!.payload).toMatchObject({ change: 'ALLOCATED', workOrderIds: [wo1] })
    expect((await audits('planning.schedule.allocate'))[0]).toMatchObject({ recordType: 'WorkOrder', after: { lineId: lineL1 } })
  })
})
