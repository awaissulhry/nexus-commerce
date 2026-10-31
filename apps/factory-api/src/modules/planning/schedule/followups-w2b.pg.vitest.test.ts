import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { daysFrom, plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { wipFor } from '../../production/scans/progress'
import { wipForMany } from '../capacity/wip'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCalendar } from '../../../../../../packages/factory-db/seed/calendar'
import { seed as seedPlanning } from '../../../../../../packages/factory-db/seed/planning'
import { seed as seedSchedule } from '../../../../../../packages/factory-db/seed/schedule'
import { seed as seedSubcontract } from '../../../../../../packages/factory-db/seed/subcontract'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'

/**
 * The planning follow-ups of B-W2b-20 through the app's real routes on a throwaway PostgreSQL 17 database from the
 * migrations (runtime login, row-level security and the guards real), on the factory-db seeds' made-up plant A1 (the
 * calendars: company A Monday to Friday with Italy's holidays, A1's site calendar, line L1's own two-shift calendar;
 * run 1 with its firm red leather; SEED-WO-0001 in progress on the working plan, the draft SEED-WO-0002, v1 published):
 *
 *   Z7:01  the run writes a carried firm line with firmCarriedFromId; it is made planned again, keeping it
 *   Z7:02  pegging and readiness need the material on the work order's scheduled start, else on its order line's date
 *   Z7:03  the board's 409s carry `refusal/<CODE>`; publish holds and skipped placements carry codes
 *   Z7:04  readiness per material with the day it is needed and its arrivals (the board and its popover)
 *   Z7:05  the customer and the style family on the board's work orders and the allocation cards
 *   Z7:06  a lane's calendar state (OWN, INHERITED, NONE) on capacity and the board
 *   Z7:09  bulk item parameters and bulk lanes, all or nothing
 *   Z7:10  the bulk WIP read equals the one-by-one read
 *   Z7:12  the exception list's age in the site's working days
 *
 * The clock is fixed at Monday 16 Nov 2026 09:00 UTC (10:00 at the plant). Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/planning/schedule/followups-w2b`.
 */

const NOW = new Date('2026-11-16T09:00:00.000Z')
const NS = 'w2b20-followups'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const siteA1 = idOf('site:A1')
const lineL1 = idOf('site:A1:line:L1')
const leather = idOf('product:item:leather')
const leatherBLK = idOf('product:item-colour:leather:BLK')
const leatherRED = idOf('product:item-colour:leather:RED')
const planner = newId()

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const PLANNER: Permission[] = [
  'planning.view',
  'planning.run',
  'planning.firm',
  'planning.exceptions.manage',
  'planning.schedule.manage',
  'planning.schedule.publish',
  'planning.items.manage',
  'planning.settings.manage',
  'workorders.view',
]
const SESSIONS: Record<string, SessionContext> = {
  planner: { audience: 'office', tenantId: T, actorId: planner, grants: [grant(PLANNER)] },
  viewer: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['planning.view', 'workorders.view'])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await db.admin.query(sql, values)).rows as Row[]
let keys = 0
const key = () => `w2b20-${NOW.getTime()}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown, idempotencyKey?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload, method === 'GET' ? undefined : key())
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload, method === 'GET' ? undefined : key())
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const codeOf = (error: Json): string | null => (error.issues as { path: string }[] | undefined)?.find((issue) => issue.path.startsWith('refusal/'))?.path.slice('refusal/'.length) ?? null
const workOrderId = async (number: string) => (await admin<{ id: string }>('SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND number = $2', [T, number]))[0]!.id
const runPlan = () => ok('planner', 'POST', '/planning/runs', { siteId: siteA1 }, 201)
const latest = () => ok('planner', 'GET', `/planning/runs/latest?siteId=${siteA1}`)
const lineOf = (plan: Json, itemId: string, itemColourId: string | null): Json => {
  const line = (plan.lines as Json[]).find((entry) => entry.item.id === itemId && (entry.colour?.id ?? null) === itemColourId)
  expect(line, `no line for ${itemId} ${itemColourId}`).toBeDefined()
  return line!
}
const board = (session = 'planner') => ok(session, 'GET', `/planning/schedule?siteId=${siteA1}&from=2026-11-16&to=2026-11-20`)
/** The earliest start of a work order's bars on the working plan, as the plant's day (null: not on the board). */
const scheduledStart = async (workOrder: string): Promise<string | null> => {
  const [row] = await admin<{ start: Date | null }>(`SELECT min("startAt") AS start FROM "ScheduleSlot" WHERE "tenantId" = $1 AND "planKind" = 'WORKING' AND "workOrderId" = $2`, [T, workOrder])
  return row?.start ? businessDate(row.start, 'Europe/Rome') : null
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  db = await migratedDatabase('plan_followups_w2b')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: NS })
  await seedCalendar({ db: database, namespace: NS })
  await seedPlanning({ db: database, namespace: NS })
  await seedSchedule({ db: database, namespace: NS })
  await seedSubcontract({ db: database, namespace: NS })
  await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, $5)', [planner, T, 'pia@example.com', 'Pia Planner', 'ACTIVE'])
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
}, 60_000)

describe('Z7:12 the exception list in working days', () => {
  it("says each exception's age in the site's working days beside the calendar days", async () => {
    const list = await ok('planner', 'GET', `/planning/exceptions?siteId=${siteA1}&status=NEW,ACKNOWLEDGED`)
    expect(list.exceptions.length).toBeGreaterThan(0)
    for (const row of list.exceptions as Json[]) {
      const first = businessDate(new Date(row.firstSeenAt), 'Europe/Rome')
      // Company A works Monday to Friday; nothing closes between the seeds' run 1 (30 Oct) and today (Ognissanti is a Sunday).
      let weekdays = 0
      for (let day = plusDays(first, 1); day <= '2026-11-16'; day = plusDays(day, 1)) if (![0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay())) weekdays += 1
      expect([row.ageDays, row.ageWorkingDays]).toEqual([daysFrom(first, '2026-11-16'), weekdays])
      expect(row.ageWorkingDays).toBeLessThan(row.ageDays)
    }
  })
})

describe('Z7:01 a carried firm line is made planned again', () => {
  it('the run carries the seeded firm order with firmCarriedFromId; unfirm clears the six columns and keeps it; the next run does not carry it', async () => {
    const seededRed = (await admin<{ id: string }>(`SELECT id FROM "MaterialRequirement" WHERE "tenantId" = $1 AND "itemColourId" = $2 AND "firmedAt" IS NOT NULL`, [T, leatherRED]))[0]!.id
    await runPlan()
    const red = lineOf(await latest(), leather, leatherRED)
    expect(red.firm).toMatchObject({ baseQuantity: '210.0000', carried: true })
    expect(await admin(`SELECT "firmCarriedFromId" FROM "MaterialRequirement" WHERE id = $1`, [red.id])).toEqual([{ firmCarriedFromId: seededRed }])
    const { line } = await ok('planner', 'POST', `/planning/requirements/${red.id}/unfirm`, { version: red.version })
    expect(line.firm).toBeNull()
    expect(await admin(`SELECT "firmCarriedFromId", "firmedAt", "firmQuantity", "firmBaseQuantity", "firmDate", "firmSupplierId", "firmedById" FROM "MaterialRequirement" WHERE id = $1`, [red.id])).toEqual([
      { firmCarriedFromId: seededRed, firmedAt: null, firmQuantity: null, firmBaseQuantity: null, firmDate: null, firmSupplierId: null, firmedById: null },
    ])
    // The column is history: nobody changes it, even by hand (the B-W2b-02 guard).
    await expect(admin(`UPDATE "MaterialRequirement" SET "firmCarriedFromId" = NULL WHERE id = $1`, [red.id])).rejects.toThrow()
    await runPlan()
    const next = lineOf(await latest(), leather, leatherRED)
    expect(next.firm).toBeNull()
    expect(await admin(`SELECT "firmCarriedFromId" FROM "MaterialRequirement" WHERE id = $1`, [next.id])).toEqual([{ firmCarriedFromId: null }])
  })
})

describe('Z7:02, Z7:04 need dates from the scheduled start; readiness per material with arrival dates', () => {
  it("needs WO-0001's material on its first bar's day (not its order line's 4 Dec), in readiness, the shortage list and the run's pegging", async () => {
    const wo1 = await workOrderId('SEED-WO-0001')
    const start = await scheduledStart(wo1)
    expect(start).not.toBeNull()
    expect(start! < '2026-12-04').toBe(true)
    const { readiness } = await ok('viewer', 'GET', `/planning/work-orders/${wo1}/readiness`)
    expect(readiness.materials.length).toBeGreaterThan(0)
    for (const material of readiness.materials as Json[]) {
      expect(material.neededOn).toBe(start)
      expect(Array.isArray(material.arrivals)).toBe(true)
      for (const arrival of material.arrivals as Json[]) expect(['IN_TIME', 'LATE', 'OVERDUE']).toContain(arrival.state)
    }
    const { rows } = await ok('viewer', 'GET', `/planning/shortages?siteId=${siteA1}`)
    for (const row of (rows as Json[]).filter((entry) => entry.workOrder.id === wo1)) expect(row.neededBy).toBe(start)
    await runPlan()
    const { demands } = await ok('viewer', 'GET', `/planning/pegging?siteId=${siteA1}&workOrderId=${wo1}`)
    expect(demands.length).toBeGreaterThan(0)
    expect(new Set((demands as Json[]).filter((demand) => demand.workOrder?.id === wo1).map((demand) => demand.demandDate))).toEqual(new Set([start]))
    // The board's work order and its popover carry the same materials (per component, with arrivals).
    const answer = await board('viewer')
    const onBoard = (answer.workOrders as Json[]).find((row) => row.id === wo1)!
    expect(onBoard.readiness.materials.map((material: Json) => [material.label, material.word, material.neededOn])).toEqual(readiness.materials.map((material: Json) => [material.label, material.word, material.neededOn]))
    const popover = await ok('viewer', 'GET', `/planning/schedule/work-orders/${wo1}`)
    expect(popover.workOrder.readiness.materials[0]).toMatchObject({ neededOn: start, arrivals: readiness.materials[0].arrivals })
  })
})

describe('Z7:05, Z7:06 customer and family; lanes without a calendar', () => {
  it('names the customer and the style family on the board and the allocation cards', async () => {
    const wo1 = await workOrderId('SEED-WO-0001')
    const [customer] = await admin<{ id: string; code: string }>(`SELECT DISTINCT p.id, p.code FROM "WorkOrderSize" s JOIN "Party" p ON p.id = s."partyId" WHERE s."workOrderId" = $1`, [wo1])
    const [style] = await admin<{ productType: string }>(`SELECT st."productType" FROM "WorkOrder" w JOIN "Style" st ON st.id = w."styleId" WHERE w.id = $1`, [wo1])
    const answer = await board('viewer')
    const onBoard = (answer.workOrders as Json[]).find((row) => row.id === wo1)!
    expect(onBoard).toMatchObject({ family: style!.productType, customer: { id: customer!.id, code: customer!.code }, customers: [{ id: customer!.id, code: customer!.code }] })
    const allocation = await ok('viewer', 'GET', `/planning/allocation?siteId=${siteA1}`)
    const card = (allocation.cards as Json[]).find((entry) => entry.workOrder.id === wo1)!
    expect(card.workOrder).toMatchObject({ family: style!.productType, customer: { id: customer!.id } })
  })

  it("tells a lane with its own calendar, one that follows the site's or company's, and one with none apart", async () => {
    const state = (lanes: Json[]) => Object.fromEntries(lanes.filter((lane) => lane.kind !== 'WORKSHOP').map((lane) => [lane.code, lane.calendarState ?? lane.calendar?.state]))
    const capacity = await ok('viewer', 'GET', `/planning/capacity?siteId=${siteA1}&from=2026-11-16&to=2026-11-20&bucket=DAY`)
    expect(state(capacity.lanes)).toEqual({ L1: 'OWN', CUT: 'INHERITED', PACK: 'INHERITED', QC: 'INHERITED', SEW: 'INHERITED' })
    const answer = await board('viewer')
    expect(state(answer.lanes)).toEqual({ L1: 'OWN', CUT: 'INHERITED', PACK: 'INHERITED', QC: 'INHERITED', SEW: 'INHERITED' })
    expect((answer.lanes as Json[]).find((lane) => lane.kind === 'WORKSHOP')?.calendar ?? null).toBeNull()
    expect((answer.lanes as Json[]).find((lane) => lane.code === 'L1')!.calendar.calendars.map((calendar: Json) => calendar.scope)).toEqual(['LINE', 'SITE', 'COMPANY'])
  })
})

describe('Z7:03 stable codes for the board', () => {
  it('a refused move, a stale slot, a held publish and a placement skipped each carry their code', async () => {
    const wo1 = await workOrderId('SEED-WO-0001')
    const cutting = (await admin<{ id: string; version: number; workOrderOperationId: string; workCentreId: string }>(
      `SELECT s.id, s.version, s."workOrderOperationId", o."workCentreId" FROM "ScheduleSlot" s JOIN "WorkOrderOperation" o ON o.id = s."workOrderOperationId" WHERE s."tenantId" = $1 AND s."planKind" = 'WORKING' AND s."workOrderId" = $2 AND o.code LIKE '%CUT%'`,
      [T, wo1],
    ))[0]!
    // Cutting onto the sewing line: the line does not do it.
    const doesNot = await refused('planner', 'PATCH', `/planning/schedule/slots/${cutting.id}`, { version: cutting.version, lane: { kind: 'LINE', id: lineL1 } }, 409)
    expect(codeOf(doesNot)).toBe('LANE_DOES_NOT')
    // A stale version: MOVED_BY (with when, as before).
    const stale = await refused('planner', 'PATCH', `/planning/schedule/slots/${cutting.id}`, { version: cutting.version + 7, startAt: '2026-11-17T08:00:00.000Z' }, 409)
    expect(codeOf(stale)).toBe('MOVED_BY')
    expect((stale.issues as Json[]).some((issue) => issue.path === 'updatedAt')).toBe(true)
    // A second bar for the same operation: ALREADY_ON_BOARD.
    const twice = await refused('planner', 'POST', '/planning/schedule/slots', { workOrderId: wo1, operationId: cutting.workOrderOperationId, lane: { kind: 'WORK_CENTRE', id: cutting.workCentreId }, startAt: '2026-11-18T08:00:00.000Z' }, 409)
    expect(codeOf(twice)).toBe('ALREADY_ON_BOARD')
    // Publish the default days, then again: NOTHING_CHANGED, as the board's band says it.
    const plan = (await board()).plan
    await ok('planner', 'POST', '/planning/schedule/publish', { siteId: siteA1, version: plan.version }, 201)
    const band = (await board()).plan
    expect(band.publishHold).toMatchObject({ code: 'NOTHING_CHANGED', previousVersion: band.published.number })
    expect(band.publishHeld).toMatch(/^Nothing changed since v/)
    const preview = await ok('planner', 'GET', `/planning/schedule/publish?siteId=${siteA1}`)
    expect([preview.heldCode, preview.hold?.code, preview.mayPublish]).toEqual(['NOTHING_CHANGED', 'NOTHING_CHANGED', false])
    const again = await refused('planner', 'POST', '/planning/schedule/publish', { siteId: siteA1, version: band.version }, 409)
    expect(codeOf(again)).toBe('NOTHING_CHANGED')
    // Days with nothing on them: NOTHING_ON_DAYS (a Sunday in the August shutdown).
    const empty = await ok('planner', 'GET', `/planning/schedule/publish?siteId=${siteA1}&coversFrom=2026-11-29&coversTo=2026-11-29`)
    expect(empty.heldCode).toBe('NOTHING_ON_DAYS')
    // Someone who may not publish: NO_PERMISSION.
    expect((await board('viewer')).plan.publishHold).toMatchObject({ code: 'NO_PERMISSION' })
    // A placement preview that leaves work orders out says why with a code.
    const proposal = await ok('planner', 'POST', '/planning/schedule/place-by-due-date', { siteId: siteA1, workOrderIds: [wo1, newId()], apply: false })
    expect(proposal.skipped.find((entry: Json) => entry.operationId === null && entry.code === 'NOT_OPEN')).toBeDefined()
    for (const entry of proposal.skipped as Json[]) expect(['NOT_OPEN', 'ON_HOLD', 'NO_DUE_DATE', 'LANE_NOT_ACTIVE', 'NO_WORKING_TIME']).toContain(entry.code)
  })
})

describe('Z7:09 bulk routes for item parameters and lanes', () => {
  it('creates, changes and removes item parameters of many rows in one command; one bad row refuses them all', async () => {
    const rows = await ok('planner', 'GET', `/planning/item-parameters?siteId=${siteA1}&configured=true&limit=50`)
    const all = (rows.items as Json[]).flatMap((entry) => entry.parameters as Json[])
    const protector = all.find((row) => row.method === 'REORDER_POINT')!
    const lining = all.find((row) => row.method === 'MIN_MAX')!
    // One problem in row 2 (a reorder point without a lot size): nothing is saved, every problem is named.
    const bad = await refused(
      'planner',
      'POST',
      '/planning/item-parameters/bulk',
      { siteId: siteA1, changes: [{ itemId: leather, itemColourId: leatherBLK, method: 'ORDERS', safetyLeadTimeDays: 3 }, { itemPlanningId: lining.id, version: lining.version, method: 'REORDER_POINT', reorderPoint: '40' }] },
      400,
    )
    expect((bad.issues as Json[]).every((issue) => issue.path.startsWith('body/changes/1/'))).toBe(true)
    expect(await admin(`SELECT count(*)::int AS n FROM "ItemPlanning" WHERE "tenantId" = $1 AND "itemColourId" = $2`, [T, leatherBLK])).toEqual([{ n: 0 }])
    // A stale row: 409, nothing saved.
    await refused('planner', 'POST', '/planning/item-parameters/bulk', { siteId: siteA1, changes: [{ itemId: leather, itemColourId: leatherBLK, method: 'ORDERS' }, { itemPlanningId: protector.id, version: protector.version + 3, safetyLeadTimeDays: 2 }] }, 409)
    expect(await admin(`SELECT count(*)::int AS n FROM "ItemPlanning" WHERE "tenantId" = $1 AND "itemColourId" = $2`, [T, leatherBLK])).toEqual([{ n: 0 }])
    const saved = await ok('planner', 'POST', '/planning/item-parameters/bulk', {
      siteId: siteA1,
      changes: [
        { itemId: leather, itemColourId: leatherBLK, method: 'ORDERS', safetyLeadTimeDays: 3 },
        { itemId: leather, itemColourId: leatherRED, method: 'ORDERS', buyLeadTimeDays: 21 },
        { itemPlanningId: protector.id, version: protector.version, safetyLeadTimeDays: 2 },
        { itemPlanningId: lining.id, version: lining.version, note: lining.note ?? null },
      ],
    })
    expect(saved.changes.map((entry: Json) => [entry.index, entry.kind])).toEqual([
      [0, 'CREATED'],
      [1, 'CREATED'],
      [2, 'EDITED'],
      [3, 'UNCHANGED'],
    ])
    expect(saved.changes[2].parameters).toMatchObject({ safetyLeadTimeDays: 2, version: protector.version + 1 })
    expect(await admin(`SELECT payload->>'change' AS change FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'planning.item_parameters_changed' ORDER BY "occurredAt", id`, [T])).toEqual([{ change: 'CREATED' }, { change: 'CREATED' }, { change: 'EDITED' }])
    expect((await admin(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'planning.bulkItemParameters'`, [T]))[0]!.n).toBe(3)
    // "Plan 2 by defaults": the two new rows removed in one command.
    const removed = await ok('planner', 'POST', '/planning/item-parameters/bulk', { siteId: siteA1, remove: saved.changes.slice(0, 2).map((entry: Json) => ({ itemPlanningId: entry.parameters.id, version: entry.parameters.version })) })
    expect(removed.removed.map((entry: Json) => entry.itemColourId).sort()).toEqual([leatherBLK, leatherRED].sort())
    await refused('viewer', 'POST', '/planning/item-parameters/bulk', { siteId: siteA1, remove: [{ itemPlanningId: protector.id, version: protector.version + 1 }] }, 403)
  })

  it('sets the same efficiency on several lanes in one command, with their versions; 250 % is refused at the lane', async () => {
    const lanes = await ok('planner', 'GET', `/planning/lanes?siteId=${siteA1}`)
    const l1 = (lanes.lines as Json[]).find((lane) => lane.code === 'L1')!
    const sew = (lanes.workCentres as Json[]).find((lane) => lane.code === 'SEW')!
    const qc = (lanes.workCentres as Json[]).find((lane) => lane.code === 'QC')!
    const bad = await refused('planner', 'PATCH', '/planning/lanes', { siteId: siteA1, lanes: [{ kind: 'LINE', id: l1.id, plannedEfficiencyPct: '90' }, { kind: 'WORK_CENTRE', id: sew.id, plannedEfficiencyPct: '250' }] }, 400)
    expect(bad.issues.map((issue: Json) => issue.path)).toEqual(['body/lanes/1/plannedEfficiencyPct'])
    const saved = await ok('planner', 'PATCH', '/planning/lanes', {
      siteId: siteA1,
      lanes: [
        { kind: 'LINE', id: l1.id, version: l1.capacity.version, plannedEfficiencyPct: '90' },
        { kind: 'WORK_CENTRE', id: sew.id, version: sew.capacity.version, plannedEfficiencyPct: '90', people: 6 },
        { kind: 'WORK_CENTRE', id: qc.id, plannedEfficiencyPct: qc.capacity?.plannedEfficiencyPct ?? qc.effective.efficiencyPct },
      ],
    })
    expect(saved.lanes.map((entry: Json) => [entry.lane.code, entry.lane.effective.efficiencyPct, entry.changed])).toEqual([
      ['L1', '90.00', ['plannedEfficiencyPct']],
      ['SEW', '90.00', ['plannedEfficiencyPct', 'people']],
      ['QC', qc.effective.efficiencyPct, qc.capacity ? [] : ['plannedEfficiencyPct']],
    ])
    expect((await admin(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'planning.capacity_changed'`, [T]))[0]!.n).toBe(qc.capacity ? 2 : 3)
    // The versions read are checked: the old one is stale now.
    await refused('planner', 'PATCH', '/planning/lanes', { siteId: siteA1, lanes: [{ kind: 'LINE', id: l1.id, version: l1.capacity.version, plannedEfficiencyPct: '85' }] }, 409)
    await refused('viewer', 'PATCH', '/planning/lanes', { siteId: siteA1, lanes: [{ kind: 'LINE', id: l1.id, plannedEfficiencyPct: '85' }] }, 403)
  })
})

describe('Z7:10 the bulk WIP read', () => {
  it('equals the one-by-one read of every work order of the tenant', async () => {
    const rows = await admin<{ id: string; siteId: string }>('SELECT id, "siteId" FROM "WorkOrder" WHERE "tenantId" = $1 ORDER BY number', [T])
    expect(rows.length).toBeGreaterThan(1)
    await database.withScope({ audience: 'office', tenantId: T, actorId: planner }, async (client) => {
      const many = await wipForMany(client, rows.map((row) => row.id))
      for (const row of rows) expect(many.get(row.id)).toEqual(await wipFor(client, { id: row.id, siteId: row.siteId }))
      expect((await wipForMany(client, [])).size).toBe(0)
    })
  })
})

describe('Z7:06 a lane with no calendar at all', () => {
  it('says NONE when neither the lane, its site nor its company has a calendar (the planning default week)', async () => {
    await admin(`UPDATE "WorkCalendar" SET status = 'ARCHIVED' WHERE "tenantId" = $1 AND scope IN ('SITE', 'COMPANY') AND status = 'ACTIVE'`, [T])
    const capacity = await ok('viewer', 'GET', `/planning/capacity?siteId=${siteA1}&from=2026-11-16&to=2026-11-20&bucket=DAY`)
    const states = Object.fromEntries((capacity.lanes as Json[]).map((lane) => [lane.code, [lane.calendarState, lane.calendars.length]]))
    expect(states).toEqual({ L1: ['OWN', 1], CUT: ['NONE', 0], PACK: ['NONE', 0], QC: ['NONE', 0], SEW: ['NONE', 0] })
    // The default week still gives working time: a day with none is never the reason for NONE.
    expect(Number((capacity.lanes as Json[]).find((lane) => lane.code === 'CUT')!.cells[0].workingMinutes)).toBeGreaterThan(0)
  })
})
