import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { callerFor } from '../../../core/command'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { SITE_COLUMNS } from '../store'
import { capacityAnswer, capacityWorld, periodOf } from './service'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCalendar } from '../../../../../../packages/factory-db/seed/calendar'
import { seed as seedPlanning } from '../../../../../../packages/factory-db/seed/planning'
import { seed as seedSchedule } from '../../../../../../packages/factory-db/seed/schedule'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'

/**
 * Capacity & load (B-W2a-16; PLN-115 capacity per line and work centre, PLN-116 load in standard minutes) through the
 * app's real routes on a throwaway PostgreSQL 17 database from the migrations (runtime login, row-level security real),
 * on the factory-db seeds' made-up plant A1: line L1 on two shifts (8 people at 85 %, an extra Saturday on 7 Nov), the
 * work centres on the company's one shift (cutting 2 × 90 %, sewing 8 × 85 %, inspection and packing 1 × 100 %), and
 * SEED-WO-0001 (7 jackets, in progress) on the planning board's working plan: cutting on 16 Nov, sewing on L1 on the
 * 17th, inspection and packing on the 18th. Run with `node scripts/factory/run-pg-tests.mjs modules/planning`.
 */

const NS = 'w2a16-capacity'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const OTHER = newId()
const user = newId()
const siteA1 = idOf('site:A1')
const lineA1 = idOf('site:A1:line:L1')
const centre = (code: string) => idOf(`site:A1:work-centre:${code}`)

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const grant = (permissions: Grant['permissions'], scope: Partial<Grant> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })
const SESSIONS: Record<string, SessionContext> = {
  planner: { audience: 'office', tenantId: T, actorId: user, grants: [grant(['planning.view', 'planning.settings.manage'])] },
  viewer: { audience: 'office', tenantId: T, actorId: user, grants: [grant(['planning.view'])] },
  nobody: { audience: 'office', tenantId: T, actorId: user, grants: [grant(['sites.view'])] },
  other: { audience: 'office', tenantId: OTHER, actorId: user, grants: [grant(['planning.view'])] },
}

type Json = Record<string, any>
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await db.admin.query(sql, values)).rows as Row[]
const call = (session: string, method: 'GET' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, url: string): Promise<Json> {
  const response = await call(session, 'GET', url)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
const capacity = (query: string) => ok('viewer', `/planning/capacity?siteId=${siteA1}&${query}`)
const lane = (answer: Json, code: string) => answer.lanes.find((row: Json) => row.code === code)
const cell = (answer: Json, code: string, key: string) => lane(answer, code).cells.find((row: Json) => row.key === key)
const slotOf = async (operationCode: string) =>
  (
    await admin<{ id: string }>(
      `SELECT s.id FROM "ScheduleSlot" s JOIN "WorkOrderOperation" o ON o.id = s."workOrderOperationId" JOIN "WorkOrder" w ON w.id = s."workOrderId"
        WHERE s."tenantId" = $1 AND s."planKind" = 'WORKING' AND w.number = 'SEED-WO-0001' AND o.code = $2`,
      [T, operationCode],
    )
  )[0]!.id

beforeAll(async () => {
  db = await migratedDatabase('planning_capacity')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: NS })
  await seedCalendar({ db: database, namespace: NS })
  await seedPlanning({ db: database, namespace: NS })
  await seedSchedule({ db: database, namespace: NS })
  await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [OTHER, 'w2a16-capacity-other'])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('capacity per line and work centre (PLN-115)', () => {
  it('counts people × working minutes × efficiency from the calendars, and says how', async () => {
    const answer = await capacity('from=2026-11-16&to=2026-11-22&bucket=DAY')
    expect([answer.from, answer.to, answer.bucket, answer.buckets.length]).toEqual(['2026-11-16', '2026-11-22', 'DAY', 7])
    expect(answer.lanes.map((row: Json) => [row.kind, row.code])).toEqual([
      ['LINE', 'L1'],
      ['WORK_CENTRE', 'CUT'],
      ['WORK_CENTRE', 'PACK'],
      ['WORK_CENTRE', 'QC'],
      ['WORK_CENTRE', 'SEW'],
    ])
    const l1 = lane(answer, 'L1')
    expect(l1).toMatchObject({ people: 8, peopleSource: 'CAPACITY', efficiencyPct: '85.00', efficiencySource: 'LANE', pattern: { code: '2T', source: 'CALENDAR' }, does: [{ id: centre('SEW'), code: 'SEW' }] })
    expect(l1.calendars.map((calendar: Json) => calendar.scope)).toEqual(['LINE', 'SITE', 'COMPANY'])
    expect(cell(answer, 'L1', '2026-11-16')).toMatchObject({ workingDays: 1, workingMinutes: '930.0', minutesPerDay: '930.0', availableMinutes: '6324.0', words: '8 people × 930 min × 85% efficiency × 1 day = 6,324 min.' })
    expect(cell(answer, 'L1', '2026-11-21')).toMatchObject({ workingDays: 0, availableMinutes: '0.0', loadPct: null, words: 'No working time in these days.' })
    expect(cell(answer, 'CUT', '2026-11-16')).toMatchObject({ availableMinutes: '864.0', people: 2, efficiencyPct: '90.00', words: '2 stations × 480 min × 90% efficiency × 1 day = 864 min.' })
    expect(lane(answer, 'CUT').pattern).toMatchObject({ code: '1T', source: 'CALENDAR' })
    // Week buckets: the extra Saturday on L1's calendar (a morning, 240 min) makes six days of different length.
    const weeks = await capacity('from=2026-11-02&to=2026-11-15&bucket=WEEK')
    expect(cell(weeks, 'L1', '2026-W45')).toMatchObject({ workingDays: 6, workingMinutes: '4890.0', minutesPerDay: null, availableMinutes: '33252.0', words: '8 people × 4,890 min over 6 days × 85% efficiency = 33,252 min.' })
    expect(cell(weeks, 'CUT', '2026-W45')).toMatchObject({ workingDays: 5, availableMinutes: '4320.0' })
    // A holiday of the company's calendar closes the line too; it is listed with its name.
    const december = await capacity('from=2026-12-07&to=2026-12-13&bucket=WEEK')
    expect(cell(december, 'L1', '2026-W50')).toMatchObject({ workingDays: 4, closedDays: [{ date: '2026-12-08', reason: 'HOLIDAY', name: 'Immacolata Concezione' }] })
    expect(cell(december, 'L1', '2026-W50').words).toMatch(/× 4 days = 25,296 min\. Closed: 2026-12-08 \(Immacolata Concezione\)\.$/)
  })

  it("buckets the plan's way (days, weeks, months to the site's horizon) and refuses a period it cannot answer", async () => {
    const plan = await capacity('from=2026-11-18&bucket=PLAN')
    expect([plan.from, plan.to, plan.buckets[0].key, plan.buckets[12].key, plan.buckets.at(-1).key]).toEqual(['2026-11-18', '2027-05-16', '2026-11-18', '2026-W49', '2027-05'])
    expect(lane(plan, 'L1').cells).toHaveLength(plan.buckets.length)
    for (const query of ['from=2026-11-20&to=2026-11-19', 'from=2026-01-01&to=2028-01-31']) {
      const refused = await call('viewer', 'GET', `/planning/capacity?siteId=${siteA1}&${query}`)
      expect([refused.statusCode, refused.json().error.issues[0].path]).toEqual([400, 'querystring/to'])
    }
    expect((await call('nobody', 'GET', `/planning/capacity?siteId=${siteA1}`)).statusCode).toBe(403)
    expect((await call('other', 'GET', `/planning/capacity?siteId=${siteA1}`)).statusCode).toBe(404)
    expect((await call('viewer', 'GET', `/planning/capacity/cell?siteId=${siteA1}&laneKind=LINE&laneId=${centre('CUT')}&from=2026-11-16&to=2026-11-16`)).statusCode).toBe(404)
  })
})

describe('load in standard minutes (PLN-116)', () => {
  it("books the frozen routing's standard minutes × the garments still to do, where and when the board placed them", async () => {
    const answer = await capacity('from=2026-11-16&to=2026-11-22&bucket=DAY')
    // SEED-WO-0001: 7 jackets; cutting 14 min, sewing 96.5, inspection 8, packing 3.5 a garment; nothing whole done yet.
    expect(cell(answer, 'CUT', '2026-11-16')).toMatchObject({ bookedMinutes: '98.0', scheduledMinutes: '98.0', loadPct: '11.3' })
    expect(cell(answer, 'L1', '2026-11-17')).toMatchObject({ bookedMinutes: '675.5', scheduledMinutes: '675.5', loadPct: '10.7', overMinutes: '0.0' })
    expect(cell(answer, 'SEW', '2026-11-17')).toMatchObject({ bookedMinutes: '675.5', loadPct: '20.7' })
    expect(cell(answer, 'QC', '2026-11-18')).toMatchObject({ bookedMinutes: '56.0', loadPct: '11.7' })
    expect(cell(answer, 'PACK', '2026-11-18')).toMatchObject({ bookedMinutes: '24.5' })
    // The draft SEED-WO-0002 on the board's working plan books nothing (its routing is not frozen yet).
    expect(cell(answer, 'L1', '2026-11-19').bookedMinutes).toBe('0.0')
    expect(lane(answer, 'L1').overall).toEqual({ availableMinutes: '31620.0', bookedMinutes: '675.5', loadPct: '2.1', overMinutes: '0.0' })
    expect(answer.workOrdersWithoutLine).toBe(0)
    // The cell's orders: the operation, its minutes and share, the board's slot.
    const detail = await ok('viewer', `/planning/capacity/cell?siteId=${siteA1}&laneKind=LINE&laneId=${lineA1}&from=2026-11-17&to=2026-11-17`)
    expect(detail).toMatchObject({ availableMinutes: '6324.0', bookedMinutes: '675.5', loadPct: '10.7', words: '8 people × 930 min × 85% efficiency × 1 day = 6,324 min.' })
    expect(detail.orders).toEqual([
      {
        workOrder: expect.objectContaining({ number: 'SEED-WO-0001', status: 'IN_PROGRESS', dueDate: '2026-12-04', style: expect.objectContaining({ code: 'SEED-JKT-02' }) }),
        operation: expect.objectContaining({ code: 'SEED-SEW-ASM', standardMinutes: '96.500' }),
        pieces: 7,
        minutes: '675.5',
        sharePct: '100.0',
        placedBy: 'SLOT',
        slot: { id: await slotOf('SEED-SEW-ASM'), startAt: '2026-11-17T09:00:00.000Z', endAt: '2026-11-17T17:00:00.000Z' },
      },
    ])
    // Per line, work centre and work order only: no person anywhere in the answers.
    expect(JSON.stringify(answer) + JSON.stringify(detail)).not.toMatch(/worker|displayName|actorId|operator/i)
  })

  it('says at a glance which lanes are over this week and what is free in the next four (the tiles)', async () => {
    const tiles = async () =>
      callerFor(database, { audience: 'office', tenantId: T, actorId: user, grants: [grant(['planning.view'])], requestId: 'capacity-tiles' }).withClient(async (client) => {
        const site = (await client.site.findUnique({ where: { id: siteA1 }, select: SITE_COLUMNS }))!
        const period = periodOf(null, '2026-11-18', { from: '2026-11-16', to: '2026-11-22', bucket: 'WEEK' })
        return capacityAnswer(await capacityWorld(client, site, period, '2026-11-18'), period).tiles
      })
    expect(await tiles()).toMatchObject({ lanesOverThisWeek: 0, mostLoadedThisWeek: { kind: 'WORK_CENTRE', id: centre('SEW'), code: 'SEW', loadPct: '4.1' } })
    // Cutting planned with one table at 1 %: 24 minutes a week for 98 booked.
    const patched = await call('planner', 'PATCH', `/planning/work-centres/${centre('CUT')}/capacity`, { version: 1, units: 1, plannedEfficiencyPct: '1' })
    expect(patched.statusCode, patched.body).toBe(200)
    const over = await tiles()
    expect(over).toMatchObject({ lanesOverThisWeek: 1, mostLoadedThisWeek: { code: 'CUT', loadPct: '408.3' } })
    expect(Number.parseFloat(over.freeMinutesNext4Weeks.lines)).toBeGreaterThan(0)
    expect(cell(await capacity('from=2026-11-16&to=2026-11-22&bucket=WEEK'), 'CUT', '2026-W47')).toMatchObject({ availableMinutes: '24.0', bookedMinutes: '98.0', loadPct: '408.3', overMinutes: '74.0' })
  })

  it('places an operation the board does not hold on its due date, and on the line the work order is allocated to', async () => {
    await admin('DELETE FROM "ScheduleSlot" WHERE id = $1', [await slotOf('SEED-FIN-QC')])
    const week = await capacity('from=2026-11-30&to=2026-12-06&bucket=WEEK')
    expect(cell(week, 'QC', '2026-W49')).toMatchObject({ bookedMinutes: '56.0', scheduledMinutes: '0.0' })
    const detail = await ok('viewer', `/planning/capacity/cell?siteId=${siteA1}&laneKind=WORK_CENTRE&laneId=${centre('QC')}&from=2026-12-04&to=2026-12-04`)
    expect(detail.orders.map((order: Json) => [order.operation.code, order.minutes, order.placedBy, order.slot])).toEqual([['SEED-FIN-QC', '56.0', 'DUE_DATE', null]])
    // Sewing off the board: on no line until the work order is allocated to L1, which sews (its stations' work centre).
    await admin('DELETE FROM "ScheduleSlot" WHERE id = $1', [await slotOf('SEED-SEW-ASM')])
    const loose = await capacity('from=2026-11-30&to=2026-12-06&bucket=WEEK')
    expect([cell(loose, 'L1', '2026-W49').bookedMinutes, cell(loose, 'SEW', '2026-W49').bookedMinutes, loose.workOrdersWithoutLine]).toEqual(['0.0', '675.5', 1])
    await admin(`UPDATE "WorkOrder" SET "lineId" = $2 WHERE "tenantId" = $1 AND number = 'SEED-WO-0001'`, [T, lineA1])
    const allocated = await capacity('from=2026-11-30&to=2026-12-06&bucket=WEEK')
    expect([cell(allocated, 'L1', '2026-W49').bookedMinutes, allocated.workOrdersWithoutLine]).toEqual(['675.5', 0])
    // Due before the period: not in a bucket, said apart.
    expect(lane(await capacity('from=2026-12-07&to=2026-12-13&bucket=WEEK'), 'QC').unplaced).toEqual({ pastDueMinutes: '56.0', undatedMinutes: '0.0' })
  })

  it('books nothing for a work order on hold, and counts it', async () => {
    await admin(`UPDATE "WorkOrder" SET status = 'ON_HOLD', "heldFromStatus" = 'IN_PROGRESS', "holdReason" = 'Waiting for the customer', "heldAt" = now(), "heldById" = $2 WHERE "tenantId" = $1 AND number = 'SEED-WO-0001'`, [T, user])
    const held = await capacity('from=2026-11-16&to=2026-12-06&bucket=WEEK')
    expect(held.lanes.map((row: Json) => [row.code, row.overall.bookedMinutes, row.heldWorkOrders])).toEqual([
      ['L1', '0.0', 1],
      ['CUT', '0.0', 1],
      ['PACK', '0.0', 1],
      ['QC', '0.0', 1],
      ['SEW', '0.0', 1],
    ])
  })
})
