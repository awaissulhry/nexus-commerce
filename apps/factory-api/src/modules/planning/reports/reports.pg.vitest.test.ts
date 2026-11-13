import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { daysFrom } from '@nexus/factory-domain/calendars/dates'
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
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'

/**
 * Planning reports (B-W2b-349; design planning.reports SCR-254; PLN-202, PLN-204, PLN-207) through the app's real routes on a
 * throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security is real), on the factory-db seeds'
 * made-up plant A1: line L1 and the work centres CUT, SEW, QC and PACK on their calendars; SEED-WO-0001 on v1 (published 15 Nov:
 * cutting 16 Nov, sewing on L1 the 17th, inspection and packing the 18th, until 11:00 UTC) and on the working plan; the DRAFT
 * SEED-WO-0002's sewing on L1 on the working plan only (19 Nov 08:00–10:00 UTC); SEED-WO-0003 released (it books load ahead).
 * Test data past the guards (their own steps' routes make it): SEED-WO-0001 finished 19 Nov (a day after v1's last bar), WO-0002
 * started and finished 19 Nov (on time against the working plan), a whole-garment bundle of WO-0001 reported at sewing on station
 * SEW-01 (line L1: 3 × 96.5 min) and at cutting on CUT-01 (work centre CUT: 3 × 14 min) on 18 Nov. The clock is Monday 30 Nov
 * 2026 10:00 UTC; every period is asked explicitly. SEED-JKT-01's revision is released (SEED-SO-0001 planned: the cover's
 * demand). Every name and number is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/planning/reports/`.
 */

const NS = 'w2b349-reports'
const NOW = new Date('2026-11-30T10:00:00.000Z')
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const siteA1 = idOf('site:A1')
const lineL1 = idOf('site:A1:line:L1')
const jkt01 = idOf('product:style:JKT-01')
const jkt01Rev = idOf('product:revision:JKT-01:1')

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

type Json = Record<string, any>
const grant = (permissions: string[]): Grant => ({ permissions: permissions as Permission[], companies: 'all', sites: 'all', parties: 'all' })
const office = (permissions: string[]): SessionContext => ({ audience: 'office', tenantId: T, actorId: newId(), grants: [grant(permissions)] }) as SessionContext
const SESSIONS: Record<string, SessionContext> = {
  planner: office(['planning.view', 'planning.reports.view']),
  plansOnly: office(['planning.view']),
  reportsOnly: office(['planning.reports.view']),
}
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await db.admin.query(sql, values)).rows as Row[]
/** Test data past the guards (replica mode: no trigger runs) on the admin login's one connection. */
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
const call = (session: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-test-session': session } })
async function ok(session: string, url: string): Promise<Json> {
  const response = await call(session, url)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
async function refused(session: string, url: string, status: number): Promise<Json> {
  const response = await call(session, url)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([name, item]) => [name, ...keysOf(item)]) : []
const PERIOD = `siteId=${siteA1}&from=2026-11-01&to=2026-11-30`
const workOrder = async (number: string) => (await admin<{ id: string; siteId: string }>('SELECT id, "siteId" FROM "WorkOrder" WHERE "tenantId" = $1 AND number = $2', [T, number]))[0]!
const operation = async (workOrderId: string, code: string) => (await admin<{ id: string }>('SELECT id FROM "WorkOrderOperation" WHERE "workOrderId" = $1 AND code = $2', [workOrderId, code]))[0]!.id
const station = async (code: string) => (await admin<{ id: string }>('SELECT id FROM "Station" WHERE "tenantId" = $1 AND "siteId" = $2 AND code = $3', [T, siteA1, code]))[0]!.id

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  db = await migratedDatabase('plan_reports')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: NS })
  await seedCalendar({ db: database, namespace: NS })
  await seedPlanning({ db: database, namespace: NS })
  await seedSchedule({ db: database, namespace: NS })
  // SEED-JKT-01's revision released: SEED-SO-0001 (18 Dec) is planned, so the cover has demand.
  await admin(`UPDATE "Style" SET status = 'ACTIVE' WHERE id = $1`, [jkt01])
  await admin(`UPDATE "StyleRevision" SET status = 'RELEASED', "releasedAt" = now(), "releasedById" = $2 WHERE id = $1`, [jkt01Rev, idOf('actor')])
  const wo1 = await workOrder('SEED-WO-0001')
  const wo2 = await workOrder('SEED-WO-0002')
  await force(`UPDATE "WorkOrder" SET status = 'COMPLETED', "completedAt" = '2026-11-19T15:00:00Z' WHERE id = $1`, [wo1.id])
  await force(`UPDATE "WorkOrder" SET status = 'COMPLETED', "releasedAt" = '2026-11-18T09:00:00Z', "startedAt" = '2026-11-19T08:30:00Z', "completedAt" = '2026-11-19T17:00:00Z' WHERE id = $1`, [wo2.id])
  const size = (await admin<{ id: string }>('SELECT id FROM "WorkOrderSize" WHERE "workOrderId" = $1 ORDER BY id LIMIT 1', [wo1.id]))[0]!.id
  const bundle = newId()
  await force(`INSERT INTO "Bundle" (id, "tenantId", "siteId", "workOrderId", "workOrderSizeId", code, quantity) VALUES ($1, $2, $3, $4, $5, 'W2B349-BN-1', 3)`, [bundle, T, wo1.siteId, wo1.id, size])
  for (const [code, stationCode] of [
    ['SEED-SEW-ASM', 'SEW-01'],
    ['SEED-CUT-LEA', 'CUT-01'],
  ] as const) {
    await force(
      `INSERT INTO "OperationScan" (id, "tenantId", "siteId", "workOrderId", "workOrderOperationId", "bundleId", kind, "goodQuantity", "stationId", "clientScanId", "deviceTime", "serverTime")
       VALUES ($1, $2, $3, $4, $5, $6, 'REPORT', 3, $7, $8, '2026-11-18T10:00:00Z', '2026-11-18T10:00:00Z')`,
      [newId(), T, wo1.siteId, wo1.id, await operation(wo1.id, code), bundle, await station(stationCode), `w2b349-${code}`],
    )
  }
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

describe('schedule adherence (PLN-202)', { timeout: 60_000 }, () => {
  it('measures each finished work order against the plan the floor had when it started, per line and week', async () => {
    const answer = await ok('planner', `/planning/reports/adherence?${PERIOD}`)
    expect([answer.from, answer.to, answer.today, answer.site.code]).toEqual(['2026-11-01', '2026-11-30', '2026-11-30', 'A1'])
    expect(answer.weeks.map((week: Json) => week.key)).toEqual(['2026-W44', '2026-W45', '2026-W46', '2026-W47', '2026-W48', '2026-W49'])
    expect(answer.all).toEqual({ finished: 2, planned: 2, onTime: 1, late: 1, notPlanned: 0, onTimePct: '50.0', startedLate: 0, meanFinishDays: '0.5', meanStartDays: '0.0' })
    expect(answer.weeks.find((week: Json) => week.key === '2026-W47').figures.finished).toBe(2)
    expect(answer.weeks.find((week: Json) => week.key === '2026-W46').figures).toMatchObject({ finished: 0, onTimePct: null })
    // Both on L1: WO-0001 by its v1 sewing bar (no line allocated), WO-0002 by its working-plan bar.
    expect(answer.lines.map((row: Json) => row.line?.code ?? null)).toEqual(['L1'])
    expect(answer.complete).toBe(true)
    expect(keysOf(answer).some((name) => /cost|price|amount|worker|person/i.test(name))).toBe(false)
  })

  it('lists the work orders behind a bar, the latest first, with the plan each is measured against', async () => {
    const drill = await ok('planner', `/planning/reports/adherence/work-orders?${PERIOD}&lineId=${lineL1}&week=2026-W47`)
    expect(drill.line).toMatchObject({ id: lineL1, code: 'L1' })
    expect(drill.week).toEqual({ key: '2026-W47', from: '2026-11-16', to: '2026-11-22' })
    expect(drill.rows.map((row: Json) => [row.workOrder.number, row.state, row.startDays, row.finishDays, row.planned?.source, row.planned?.number])).toEqual([
      ['SEED-WO-0001', 'LATE', 0, 1, 'PUBLISHED', 1],
      ['SEED-WO-0002', 'ON_TIME', 0, 0, 'WORKING', null],
    ])
    expect(drill.rows[0]).toMatchObject({ planned: { startAt: '2026-11-16T08:00:00.000Z', endAt: '2026-11-18T11:00:00.000Z' }, actual: { startAt: '2026-11-16T09:00:00.000Z', finishAt: '2026-11-19T15:00:00.000Z' } })
    expect((await ok('planner', `/planning/reports/adherence/work-orders?${PERIOD}&state=LATE`)).rows.map((row: Json) => row.workOrder.number)).toEqual(['SEED-WO-0001'])
    expect((await ok('planner', `/planning/reports/adherence/work-orders?${PERIOD}&lineId=none`)).rows).toEqual([])
    // Another period: none finished.
    expect((await ok('planner', `/planning/reports/adherence?siteId=${siteA1}&from=2026-10-01&to=2026-10-31`)).all.finished).toBe(0)
  })

  it('refuses in words: a week outside the period, a line of no site of ours, a period after today, no right', async () => {
    expect((await refused('planner', `/planning/reports/adherence/work-orders?${PERIOD}&week=2026-W50`, 400)).message).toMatch(/A week of the period/)
    await refused('planner', `/planning/reports/adherence/work-orders?${PERIOD}&lineId=${newId()}`, 404)
    expect((await refused('planner', `/planning/reports/adherence?siteId=${siteA1}&from=2026-11-01&to=2026-12-01`, 400)).message).toMatch(/cannot end after today/)
    await refused('planner', `/planning/reports/adherence?${PERIOD}&extra=1`, 400)
    // planning.view alone: the page's permission is missing (403); the page's permission alone: the site is not planned (404).
    await refused('plansOnly', `/planning/reports/adherence?${PERIOD}`, 403)
    await refused('reportsOnly', `/planning/reports/adherence?${PERIOD}`, 404)
    await refused('planner', `/planning/reports/adherence?siteId=${newId()}&from=2026-11-01&to=2026-11-30`, 404)
  })
})

describe('the utilisation trend (PLN-204)', { timeout: 60_000 }, () => {
  it('earns per line and work centre what happened, and shows the plan’s load ahead as Capacity & load counts it', async () => {
    const answer = await ok('planner', `/planning/reports/utilisation?${PERIOD}&ahead=2`)
    expect(answer.weeks.map((week: Json) => [week.key, week.actual, week.ahead])).toEqual([
      ['2026-W44', true, false],
      ['2026-W45', true, false],
      ['2026-W46', true, false],
      ['2026-W47', true, false],
      ['2026-W48', true, false],
      ['2026-W49', true, true],
      ['2026-W50', false, true],
    ])
    expect(answer.lanes.slice(0, 6).map((lane: Json) => [lane.kind, lane.code])).toEqual([
      ['PLANT', null],
      ['LINE', 'L1'],
      ['WORK_CENTRE', 'CUT'],
      ['WORK_CENTRE', 'PACK'],
      ['WORK_CENTRE', 'QC'],
      ['WORK_CENTRE', 'SEW'],
    ])
    const cell = (code: string | null, week: string) => answer.lanes.find((lane: Json) => lane.code === code && lane.kind !== 'WORKSHOP').cells.find((entry: Json) => entry.key === week)
    expect(cell('L1', '2026-W47')).toMatchObject({ earnedMinutes: '289.5', booked: null, capacity: null, loadPct: null, band: 'UNKNOWN' })
    expect(cell('CUT', '2026-W47').earnedMinutes).toBe('42.0')
    expect(cell('SEW', '2026-W47').earnedMinutes).toBe('0.0')
    // The utilisation is earned ÷ the minutes its people were there.
    for (const code of ['L1', 'CUT']) {
      const entry = cell(code, '2026-W47')
      expect(Number(entry.availableMinutes)).toBeGreaterThan(0)
      expect(entry.utilisationPct).toBe(((Number(entry.earnedMinutes) / Number(entry.availableMinutes)) * 100).toFixed(1))
    }
    // The plant is every lane together.
    const plant = cell(null, '2026-W47')
    expect(plant.earnedMinutes).toBe('331.5')
    const lanes = answer.lanes.filter((lane: Json) => lane.kind === 'LINE' || lane.kind === 'WORK_CENTRE')
    expect(Number(plant.availableMinutes)).toBeCloseTo(lanes.reduce((total: number, lane: Json) => total + Number(lane.cells.find((entry: Json) => entry.key === '2026-W47').availableMinutes), 0), 1)
    // Ahead: the same numbers as Capacity & load for those weeks.
    const capacity = await ok('planner', `/planning/capacity?siteId=${siteA1}&from=2026-11-30&to=2026-12-13&bucket=WEEK`)
    for (const lane of capacity.lanes) {
      for (const week of ['2026-W49', '2026-W50']) {
        const theirs = lane.cells.find((entry: Json) => entry.key === week)
        expect(cell(lane.code, week), `${lane.code} ${week}`).toMatchObject({ booked: theirs.bookedMinutes, capacity: theirs.availableMinutes, loadPct: theirs.loadPct })
      }
    }
    expect(cell('L1', '2026-W45')).toMatchObject({ booked: null, loadPct: null })
    expect(keysOf(answer).some((name) => /cost|price|amount|worker|person|station/i.test(name))).toBe(false)
  })

  it('lists the work orders behind a point: what earned it, and what books the load ahead', async () => {
    const past = await ok('planner', `/planning/reports/utilisation/work-orders?${PERIOD}&laneKind=LINE&laneId=${lineL1}&week=2026-W47`)
    expect(past.lane).toMatchObject({ kind: 'LINE', code: 'L1' })
    expect(past.booked).toBeNull()
    expect(past.earned).toMatchObject({ minutes: '289.5', more: 0 })
    expect(past.earned.rows.map((row: Json) => [row.workOrder.number, row.operation.code, row.lane.code, row.garments, row.minutes])).toEqual([['SEED-WO-0001', 'SEED-SEW-ASM', 'L1', 3, '289.5']])
    const plant = await ok('planner', `/planning/reports/utilisation/work-orders?${PERIOD}&laneKind=PLANT&week=2026-W47`)
    expect(plant.earned.minutes).toBe('331.5')
    const ahead = await ok('planner', `/planning/reports/utilisation/work-orders?${PERIOD}&ahead=2&laneKind=PLANT&week=2026-W50`)
    expect(ahead.earned).toBeNull()
    const trend = await ok('planner', `/planning/reports/utilisation?${PERIOD}&ahead=2`)
    expect(ahead.booked.minutes).toBe(trend.lanes[0].cells.find((entry: Json) => entry.key === '2026-W50').booked)
    await refused('planner', `/planning/reports/utilisation/work-orders?${PERIOD}&laneKind=LINE&week=2026-W47`, 400)
    await refused('planner', `/planning/reports/utilisation/work-orders?${PERIOD}&laneKind=LINE&laneId=${lineL1}&week=2027-W05`, 400)
    await refused('planner', `/planning/reports/utilisation/work-orders?${PERIOD}&laneKind=LINE&laneId=${newId()}&week=2026-W47`, 404)
    await refused('planner', `/planning/reports/utilisation?${PERIOD}&ahead=13`, 400)
  })
})

describe('material cover and projected stock-outs (PLN-207)', { timeout: 120_000 }, () => {
  it('says each material’s days of cover and stock-out day, as the Projected stock pop-up counts it', async () => {
    const answer = await ok('planner', `/planning/reports/cover?siteId=${siteA1}`)
    expect(answer.horizon).toEqual({ from: '2026-11-30', to: '2027-02-28', weeks: 13, days: 91 })
    expect(answer.rows.length).toBeGreaterThan(0)
    expect(answer.counts.materials).toBe(answer.rows.length + answer.more)
    const order = ['SHORT_NOW', 'STOCK_OUT', 'BELOW_SAFETY', 'COVERED']
    const ranks = answer.rows.map((row: Json) => order.indexOf(row.state))
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks)
    for (const row of answer.rows) {
      if (row.stockOutOn) expect(row.daysOfCover, row.item.code).toBe(daysFrom(answer.today, row.stockOutOn))
      else expect(row.daysOfCover).toBeNull()
      // The pop-up's profile of the same material agrees: on hand, the first short week, and the day lies in that week.
      const profile = await ok('planner', `/planning/item-profile?siteId=${siteA1}&itemId=${row.item.id}&itemColourId=${row.colour?.id ?? 'none'}`)
      expect([row.onHand, row.firstShort], row.item.code).toEqual([profile.onHand, profile.firstShort])
      const week = profile.rows.find((entry: Json) => entry.key === profile.firstShort)
      if (row.stockOutOn && week?.from) expect(row.stockOutOn >= week.from && row.stockOutOn <= week.to, row.item.code).toBe(true)
      expect(row.openPurchases.orders).toBeLessThanOrEqual(row.openPurchases.lines)
    }
    const short = await ok('planner', `/planning/reports/cover?siteId=${siteA1}&weeks=4`)
    expect(short.horizon).toMatchObject({ to: '2026-12-27', weeks: 4 })
    expect(keysOf(answer).some((name) => /cost|price|amount|worker|person|customer/i.test(name))).toBe(false)
  })

  it('refuses a horizon over a year, and a caller without the page’s permission', async () => {
    await refused('planner', `/planning/reports/cover?siteId=${siteA1}&weeks=53`, 400)
    await refused('plansOnly', `/planning/reports/cover?siteId=${siteA1}`, 403)
    await refused('reportsOnly', `/planning/reports/cover?siteId=${siteA1}`, 404)
  })
})
