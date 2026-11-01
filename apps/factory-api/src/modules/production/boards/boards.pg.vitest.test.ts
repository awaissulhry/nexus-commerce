import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedAndon, type AndonSeed } from '../../../../../../packages/factory-db/seed/andon'
import { seed as seedCalendar } from '../../../../../../packages/factory-db/seed/calendar'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPlant } from '../../../../../../packages/factory-db/seed/plant'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { DEVICE_COOKIE } from '../../../platform/auth/floor/cookies'
import { floorHash, mintSiteToken } from '../../../platform/auth/floor/tokens'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'

/**
 * Line targets and boards (B-W2b-50; MES-084, MES-161, MES-162, MES-166, ANA-007) on the local stack with the app's real
 * routes: a throwaway PostgreSQL 17 database from the migrations (the runtime logins: row-level security, the column grants
 * and the …_floor_work_w2b_guards trigger on LineTarget are real), the factory-db seeds of two tenants up to the line's
 * signals (plant A1, line L1 with SEW-01 and SEW-02 on two shifts 06:00-22:00 with a break at 10:00; L1's targets of 17 Nov
 * with the team leader's BREAKDOWN reason at 10:00; the open maintenance call at SEW-02), the standard reason lists and the
 * plant. Whole-garment bundles of SEED-WO-0001 and their scans are written here as the floor writes them; a down machine
 * at SEW-01, a handover note of the day and made-up tablets: L1's line tablet, a station tablet and L1's line TV (a
 * DISPLAY device with its token). The clock is Friday 20 Nov 2026 10:20 UTC (11:20 at the plant). Every name and number
 * is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/production/boards`.
 */

const NOW = new Date('2026-11-20T10:20:00.000Z')
const DAY = '2026-11-20'

let h: Harness
let app: FastifyInstance
let andon: AndonSeed

const ns = { a: 'boards-a', b: 'boards-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const A = {
  tenant: idOf(ns.a, 'tenant'),
  actor: idOf(ns.a, 'actor'),
  companyA: idOf(ns.a, 'company:A'),
  companyB: idOf(ns.a, 'company:B'),
  siteA1: idOf(ns.a, 'site:A1'),
  lineL1: idOf(ns.a, 'site:A1:line:L1'),
  sew1: idOf(ns.a, 'site:A1:station:SEW-01'),
  sew2: idOf(ns.a, 'site:A1:station:SEW-02'),
  cut1: idOf(ns.a, 'site:A1:station:CUT-01'),
  sewCentre: idOf(ns.a, 'site:A1:work-centre:SEW'),
  operator: idOf(ns.a, 'worker:A1:operator'),
  lead: idOf(ns.a, 'worker:A1:lead'),
  cuttingTablet: idOf(ns.a, 'device:A1:cutting'),
  lineTablet: newId(),
  stationTablet: newId(),
  tv: newId(),
}
const B = { tenant: idOf(ns.b, 'tenant') }

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (tenantId: string, grants: Grant[], actorId: string = newId()): SessionContext => ({ audience: 'office', tenantId, actorId, grants })
const floorAt = (deviceId: string, actorId: string, permissions: Permission[]): SessionContext => ({
  audience: 'floor',
  tenantId: A.tenant,
  actorId,
  siteId: A.siteA1,
  deviceId,
  grants: [{ permissions, companies: [A.companyA], sites: [A.siteA1], parties: 'all' }],
})
const ALL: Permission[] = ['production.boards.view', 'production.boards.targets', 'production.boards.reason']
const SESSIONS: Record<string, SessionContext> = {
  manager: office(A.tenant, [grant(ALL)], A.actor),
  planner: office(A.tenant, [grant(['production.boards.view', 'production.boards.targets'])]),
  viewer: office(A.tenant, [grant(['production.boards.view'])]),
  companyB: office(A.tenant, [grant(ALL, [A.companyB])]),
  otherTenant: office(B.tenant, [grant(ALL)]),
  lead: floorAt(A.lineTablet, A.lead, ['floor.work', 'floor.lead', 'production.boards.view', 'production.boards.reason']),
  operator: floorAt(A.stationTablet, A.operator, ['floor.work']),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `t-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown, key?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key ?? freshKey() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const refusalOf = (error: Json): string => String(error.issues?.[0]?.path ?? '')
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : []
/** Person words that must never travel on a board. */
const PERSON_KEYS = /^(workerId|employeeId|worker|caller|createdById|shortReasonById|seenById|userId|operator)$/i
const eventsOf = async (type: string, subject: string) => admin('SELECT payload FROM "OutboxEvent" WHERE type = $1 AND subject = $2 ORDER BY "occurredAt", id', [type, subject])
const auditOf = async (recordId: string) => admin('SELECT action, before, after FROM "AuditLog" WHERE "recordId" = $1 ORDER BY "at", id', [recordId])
const display = (token: string | null) => app.inject({ method: 'GET', url: '/production/boards/display', headers: token ? { cookie: `${DEVICE_COOKIE}=${token}` } : {} })

let wo1: string
const ops: Record<string, { id: string; code: string }> = {}
const bundles: Record<string, string> = {}
let tvToken: string
let stationToken: string

async function bundle(code: string, colourway: string, size: string, quantity: number): Promise<string> {
  const cell = (await admin<{ id: string }>(`SELECT s.id FROM "WorkOrderSize" s JOIN "Colourway" c ON c.id = s."colourwayId" WHERE s."workOrderId" = $1 AND c.code = $2 AND s.size = $3`, [wo1, colourway, size]))[0]!.id
  const id = newId()
  await admin(`INSERT INTO "Bundle" (id, "tenantId", "siteId", "workOrderId", "workOrderSizeId", code, quantity, "deviceId", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`, [id, A.tenant, A.siteA1, wo1, cell, code, quantity, A.cuttingTablet, new Date('2026-11-20T06:30:00Z')])
  return id
}

async function scan(row: { bundle: string; op: string; good?: number; scrap?: number; rework?: number; at: string; station: string }): Promise<string> {
  const id = newId()
  await admin(
    `INSERT INTO "OperationScan" (id, "tenantId", "siteId", "workOrderId", "workOrderOperationId", "bundleId", kind, "goodQuantity", "scrapQuantity", "reworkQuantity", "workerId", "stationId", "deviceId", "clientScanId", "deviceTime", "serverTime", "createdById")
     VALUES ($1, $2, $3, $4, $5, $6, 'REPORT', $7, $8, $9, $10, $11, $12, $13, $14, $14, $10)`,
    [id, A.tenant, A.siteA1, wo1, ops[row.op]!.id, bundles[row.bundle], row.good ?? 0, row.scrap ?? 0, row.rework ?? 0, A.operator, row.station, A.cuttingTablet, `w2b50-${id}`, new Date(row.at)],
  )
  return id
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  h = await startHarness('boards')
  for (const namespace of [ns.a, ns.b]) {
    await seedCore({ db: h.database, namespace })
    await seedReasons({ db: h.database, namespace })
    await seedCalendar({ db: h.database, namespace })
    const seeded = await seedAndon({ db: h.database, namespace })
    await seedPlant({ db: h.database, namespace })
    if (namespace === ns.a) andon = seeded
  }
  wo1 = (await admin<{ id: string }>('SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND number = $2', [A.tenant, 'SEED-WO-0001']))[0]!.id
  for (const row of await admin<{ id: string; code: string; kind: string }>(`SELECT o.id, o.code, c.kind::text FROM "WorkOrderOperation" o JOIN "WorkCentre" c ON c.id = o."workCentreId" WHERE o."workOrderId" = $1`, [wo1]))
    ops[row.kind === 'CUTTING' ? 'cut' : row.kind === 'SEWING' || row.kind === 'ASSEMBLY' ? 'sew' : row.kind === 'INSPECTION' ? 'qc' : 'pack'] = { id: row.id, code: row.code }
  bundles.a = await bundle('W2B50-A', 'BLK', '50', 6)
  bundles.b = await bundle('W2B50-B', 'BLK', '52', 2)
  bundles.c = await bundle('W2B50-C', 'RED', '50', 2)
  bundles.d = await bundle('W2B50-D', 'RED', '52', 1)
  bundles.e = await bundle('W2B50-E', 'BLK', '54', 3)
  // Friday 20 Nov: every bundle cut at CUT-01 (a station alone) at 07:00 Rome; then at L1's last operation (sewing): 08:10
  // six good, 09:20 two good, 10:30 one good and one to rework, 10:40 one scrapped (Rome). E is cut and not sewn yet.
  for (const [key, quantity] of [['a', 6], ['b', 2], ['c', 2], ['d', 1], ['e', 3]] as const) await scan({ bundle: key, op: 'cut', good: quantity, at: '2026-11-20T06:00:00Z', station: A.cut1 })
  await scan({ bundle: 'a', op: 'sew', good: 6, at: '2026-11-20T07:10:00Z', station: A.sew1 })
  await scan({ bundle: 'b', op: 'sew', good: 2, at: '2026-11-20T08:20:00Z', station: A.sew2 })
  await scan({ bundle: 'c', op: 'sew', good: 1, rework: 1, at: '2026-11-20T09:30:00Z', station: A.sew1 })
  await scan({ bundle: 'd', op: 'sew', scrap: 1, at: '2026-11-20T09:40:00Z', station: A.sew2 })
  // A machine down at SEW-01; the maintenance call of the seed is still open at SEW-02.
  const machineClass = (await admin<{ id: string }>(`SELECT id FROM "MachineClass" WHERE "tenantId" = $1 ORDER BY id LIMIT 1`, [A.tenant]))[0]!.id
  await admin(`INSERT INTO "Machine" (id, "tenantId", "companyId", "siteId", "assetNumber", "classId", "stationId", "workCentreId", status, "statusSince") VALUES ($1, $2, $3, $4, 'W2B50-SEW-01', $5, $6, $7, 'DOWN', $8)`, [newId(), A.tenant, A.companyA, A.siteA1, machineClass, A.sew1, A.sewCentre, NOW])
  // The team leader's handover note of the day (B-W2b-49 writes them; here as the floor would).
  await admin(`INSERT INTO "HandoverNote" (id, "tenantId", "siteId", "lineId", "shiftDate", "shiftLabel", topics, text, "createdAt", "updatedAt", "createdById") VALUES ($1, $2, $3, $4, $5, 'Morning', '{MACHINES}'::"HandoverTopic"[], 'SEW-01 waits for the technician.', $6, $6, $7)`, [newId(), A.tenant, A.siteA1, A.lineL1, new Date(`${DAY}T00:00:00Z`), new Date('2026-11-20T08:00:00Z'), A.lead])
  // Tablets: L1's line tablet, a station tablet, L1's TV (DISPLAY) — the last two with their device tokens.
  const tv = mintSiteToken(A.tenant, A.siteA1, A.tv)
  const station = mintSiteToken(A.tenant, A.siteA1, A.stationTablet)
  tvToken = tv.value
  stationToken = station.value
  const device = `INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", "lineId", mode, name, kind, status, "enrolledAt", "tokenHash") VALUES ($1, $2, $3, $4, $5, $6, $7::"DeviceMode", $8, 'TABLET', 'ACTIVE', now(), $9)`
  await admin(device, [A.lineTablet, A.tenant, A.companyA, A.siteA1, null, A.lineL1, 'LINE', 'Line 1 tablet', null])
  await admin(device, [A.stationTablet, A.tenant, A.companyA, A.siteA1, A.sew1, null, 'STATION', 'Sewing tablet 1', floorHash(station.value)])
  await admin(device, [A.tv, A.tenant, A.companyA, A.siteA1, null, A.lineL1, 'DISPLAY', 'Line 1 TV', floorHash(tv.value)])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database: h.database,
      officeAuth: h.auth,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
  vi.useRealTimers()
}, 60_000)

let targets: Record<number, { id: string; version: number }> = {}

describe('the hourly targets of a line (MES-084): line targets only, today or later', () => {
  it('sets the day’s hours in one command, once per Idempotency-Key, with an audit row each and one event', async () => {
    const body = { lineId: A.lineL1, date: DAY, hours: [8, 9, 10, 11].map((hour) => ({ hour, targetPieces: 6 })) }
    const key = freshKey()
    const answer = await ok('manager', 'PUT', '/production/boards/targets', body, key)
    expect(answer).toEqual({ line: { id: A.lineL1, code: 'L1', name: expect.any(String) }, day: DAY, set: [8, 9, 10, 11], removed: [], unchanged: [], total: 24 })
    expect(await ok('manager', 'PUT', '/production/boards/targets', body, key)).toEqual(answer)
    const rows = await admin<{ id: string; hour: number; targetPieces: number; version: number }>(`SELECT id, hour, "targetPieces", version FROM "LineTarget" WHERE "lineId" = $1 AND "workDate" = $2 ORDER BY hour`, [A.lineL1, DAY])
    expect(rows.map((row) => [row.hour, row.targetPieces])).toEqual([[8, 6], [9, 6], [10, 6], [11, 6]])
    targets = Object.fromEntries(rows.map((row) => [row.hour, { id: row.id, version: row.version }]))
    expect((await auditOf(targets[8]!.id))[0]).toMatchObject({ action: 'production.setLineTargets', after: { lineId: A.lineL1, workDate: DAY, hour: 8, targetPieces: 6 } })
    expect((await eventsOf('line_targets.changed', A.lineL1)).map((row) => row.payload)).toEqual([{ lineId: A.lineL1, workDate: DAY, set: [8, 9, 10, 11], removed: [] }])
  })

  it('reads the day as the office fills it: every working hour of L1’s calendar, its targets and versions', async () => {
    const day = await ok('manager', 'GET', `/production/boards/targets?lineId=${A.lineL1}&date=${DAY}`)
    expect(day).toMatchObject({ day: DAY, today: DAY, past: false, total: 24, canSet: true, shift: { label: 'Morning' } })
    expect(day.hours.map((hour: Json) => hour.hour)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21])
    expect(day.hours.find((hour: Json) => hour.hour === 10)).toMatchObject({ label: '10:00–11:00', workingMinutes: 45, target: { targetPieces: 6, version: 1 }, reasonGiven: false })
    expect(day.hours.find((hour: Json) => hour.hour === 12)).toMatchObject({ workingMinutes: 60, target: null })
    // A past day is history: read only, with the seed's reason at 10:00 on 17 Nov.
    const past = await ok('planner', 'GET', `/production/boards/targets?lineId=${A.lineL1}&date=2026-11-17`)
    expect(past).toMatchObject({ past: true, canSet: false, total: 24 })
    expect(past.hours.find((hour: Json) => hour.hour === 10)).toMatchObject({ reasonGiven: true })
    expect((await ok('viewer', 'GET', `/production/boards/targets?lineId=${A.lineL1}`)).canSet).toBe(false)
  })

  it('changes and removes hours at their version; the same pieces again are unchanged', async () => {
    const answer = await ok('planner', 'PUT', '/production/boards/targets', { lineId: A.lineL1, date: DAY, hours: [{ hour: 12, targetPieces: 7 }, { hour: 11, targetPieces: 6, version: 1 }, { hour: 13, targetPieces: null }] })
    expect(answer).toMatchObject({ set: [12], removed: [], unchanged: [11, 13], total: 31 })
    const removed = await ok('planner', 'PUT', '/production/boards/targets', { lineId: A.lineL1, date: DAY, hours: [{ hour: 12, targetPieces: null }] })
    expect(removed).toMatchObject({ set: [], removed: [12], total: 24 })
    expect((await eventsOf('line_targets.changed', A.lineL1)).at(-1)!.payload).toEqual({ lineId: A.lineL1, workDate: DAY, set: [], removed: [12] })
  })

  it('REFUSED: a past day, a stale version, an hour twice or out of the day; who may not set or see the line', async () => {
    expect(refusalOf(await no('manager', 'PUT', '/production/boards/targets', { lineId: A.lineL1, date: '2026-11-19', hours: [{ hour: 8, targetPieces: 6 }] }, 409))).toBe('refusal/PAST_DAY')
    expect(refusalOf(await no('manager', 'PUT', '/production/boards/targets', { lineId: A.lineL1, date: DAY, hours: [{ hour: 8, targetPieces: 7, version: 5 }] }, 409))).toBe('refusal/STALE')
    expect(refusalOf(await no('manager', 'PUT', '/production/boards/targets', { lineId: A.lineL1, date: DAY, hours: [{ hour: 8, targetPieces: 7 }, { hour: 8, targetPieces: 6 }] }, 400))).toBe('body/hours/1/hour')
    expect((await call('manager', 'PUT', '/production/boards/targets', { lineId: A.lineL1, date: DAY, hours: [{ hour: 24, targetPieces: 7 }] })).statusCode).toBe(400)
    expect((await call('viewer', 'PUT', '/production/boards/targets', { lineId: A.lineL1, date: DAY, hours: [{ hour: 8, targetPieces: 7 }] })).statusCode).toBe(403)
    expect((await call('companyB', 'PUT', '/production/boards/targets', { lineId: A.lineL1, date: DAY, hours: [{ hour: 8, targetPieces: 7 }] })).statusCode).toBe(404)
    expect((await call('otherTenant', 'GET', `/production/boards/targets?lineId=${A.lineL1}`)).statusCode).toBe(404)
    expect((await call('lead', 'PUT', '/production/boards/targets', { lineId: A.lineL1, date: DAY, hours: [{ hour: 8, targetPieces: 7 }] })).statusCode).toBe(403)
    // Nothing changed by the refusals.
    expect((await admin(`SELECT "targetPieces" FROM "LineTarget" WHERE id = $1`, [targets[8]!.id]))[0]).toEqual({ targetPieces: 6 })
  })
})

describe('hour by hour (MES-161): pieces per hour against the line’s target, never per person', () => {
  it('counts the garments out of L1’s last operation per hour; short hours; the totals so far and the pace', async () => {
    const answer = await ok('manager', 'GET', `/production/boards/hourly?lineId=${A.lineL1}`)
    expect(answer).toMatchObject({ day: DAY, today: DAY, site: { id: A.siteA1, timeZone: 'Europe/Rome' } })
    const [l1] = answer.lines
    expect(l1.line.id).toBe(A.lineL1)
    expect(l1.shift).toMatchObject({ label: 'Morning' })
    const byHour = (hour: number) => l1.hours.find((row: Json) => row.hour === hour)
    expect(byHour(8)).toMatchObject({ state: 'OVER', done: 6, target: { targetPieces: 6 }, short: false, reason: null })
    expect(byHour(9)).toMatchObject({ state: 'OVER', done: 2, short: true })
    expect(byHour(10)).toMatchObject({ state: 'OVER', done: 1, short: true, workingMinutes: 45 })
    expect(byHour(11)).toMatchObject({ state: 'RUNNING', done: 0, short: false })
    expect(byHour(12)).toMatchObject({ state: 'LATER', target: null })
    // 6 + 6 + 6 over, a third of 11:00's 6: 20 so far; 9 done.
    expect(l1.totals).toMatchObject({ done: 9, target: 24, targetSoFar: 20, pace: 'BEHIND', shortHours: 2, paceLook: { tone: 'warning' } })
    expect(l1.canGiveReason).toBe(true)
    expect(answer.reasons.map((reason: Json) => reason.code)).toEqual(expect.arrayContaining(['BREAKDOWN', 'SETUP', 'OTHER']))
    // The whole site: every active line of A1.
    const site = await ok('viewer', 'GET', `/production/boards/hourly?siteId=${A.siteA1}`)
    expect(site.lines.map((line: Json) => line.line.code)).toContain('L1')
    expect(site.lines.find((line: Json) => line.line.code === 'L1').canGiveReason).toBe(false)
    // A past day: the seed's 17 Nov with its reason at 10:00 (code words and the lead's words; never who).
    const past = await ok('viewer', 'GET', `/production/boards/hourly?lineId=${A.lineL1}&date=2026-11-17`)
    expect(past.lines[0].hours.find((row: Json) => row.hour === 10).reason).toMatchObject({ code: 'BREAKDOWN', labelEn: 'Breakdown', note: expect.any(String) })
  })

  it('the team leader’s line tablet reads its own line by default; REFUSED: an operator, another company', async () => {
    const answer = await ok('lead', 'GET', '/production/boards/hourly')
    expect(answer.lines.map((line: Json) => line.line.id)).toEqual([A.lineL1])
    expect(answer.lines[0].totals.done).toBe(9)
    expect((await call('operator', 'GET', '/production/boards/hourly')).statusCode).toBe(403)
    expect((await call('companyB', 'GET', `/production/boards/hourly?lineId=${A.lineL1}`)).statusCode).toBe(404)
    expect((await call('companyB', 'GET', `/production/boards/hourly?siteId=${A.siteA1}`)).statusCode).toBe(404)
  })
})

describe('the reason of a short hour (MES-161 "Why was 10:00–11:00 short?")', () => {
  it('the team leader gives it on the floor once the hour is over: the code, the words, an audit row, an event', async () => {
    const answer = await ok('lead', 'POST', `/production/boards/targets/${targets[9]!.id}/reason`, { reasonCode: 'breakdown', note: 'Needle broke twice at SEW-02.', version: targets[9]!.version })
    expect(answer).toMatchObject({ targetId: targets[9]!.id, version: 2, hour: { hour: 9, short: true, reason: { code: 'BREAKDOWN', labelEn: 'Breakdown', note: 'Needle broke twice at SEW-02.' } } })
    const [row] = await admin(`SELECT "shortReasonCode", "shortNote", "shortReasonById", version FROM "LineTarget" WHERE id = $1`, [targets[9]!.id])
    expect(row).toEqual({ shortReasonCode: 'BREAKDOWN', shortNote: 'Needle broke twice at SEW-02.', shortReasonById: A.lead, version: 2 })
    expect((await auditOf(targets[9]!.id)).at(-1)).toMatchObject({ action: 'production.giveShortHourReason', before: { shortReasonCode: null }, after: { shortReasonCode: 'BREAKDOWN', done: 2, targetPieces: 6 } })
    expect((await eventsOf('line_target.reason_given', targets[9]!.id)).map((event) => event.payload)).toEqual([{ targetId: targets[9]!.id, lineId: A.lineL1, workDate: DAY, hour: 9, reasonCode: 'BREAKDOWN', by: 'FLOOR' }])
    // The office replaces it with an "Other" reason and words (the earlier one stays on its audit row).
    const office = await ok('manager', 'POST', `/production/boards/targets/${targets[9]!.id}/reason`, { reasonCode: 'OTHER', note: 'Thread ran out on the line.', version: 2 })
    expect(office.hour.reason).toMatchObject({ code: 'OTHER', note: 'Thread ran out on the line.' })
  })

  it('REFUSED: an hour that met its target, an hour not over, a code not in the list, "Other" without words, a stale version, an operator, the planner', async () => {
    expect(refusalOf(await no('lead', 'POST', `/production/boards/targets/${targets[8]!.id}/reason`, { reasonCode: 'SETUP', version: 1 }, 409))).toBe('refusal/NOT_SHORT')
    expect(refusalOf(await no('lead', 'POST', `/production/boards/targets/${targets[11]!.id}/reason`, { reasonCode: 'SETUP', version: 1 }, 409))).toBe('refusal/HOUR_NOT_OVER')
    expect(refusalOf(await no('lead', 'POST', `/production/boards/targets/${targets[10]!.id}/reason`, { reasonCode: 'NOT_A_REASON', version: 1 }, 409))).toBe('refusal/CODE_NOT_LISTED')
    expect(refusalOf(await no('lead', 'POST', `/production/boards/targets/${targets[10]!.id}/reason`, { reasonCode: 'OTHER', version: 1 }, 409))).toBe('refusal/NOTE_NEEDED')
    expect((await call('lead', 'POST', `/production/boards/targets/${targets[10]!.id}/reason`, { reasonCode: 'SETUP', version: 7 })).statusCode).toBe(409)
    expect((await call('operator', 'POST', `/production/boards/targets/${targets[10]!.id}/reason`, { reasonCode: 'SETUP', version: 1 })).statusCode).toBe(403)
    expect((await call('planner', 'POST', `/production/boards/targets/${targets[10]!.id}/reason`, { reasonCode: 'SETUP', version: 1 })).statusCode).toBe(403)
    expect((await call('companyB', 'POST', `/production/boards/targets/${targets[10]!.id}/reason`, { reasonCode: 'SETUP', version: 1 })).statusCode).toBe(404)
    // A floor write needs its Idempotency-Key (a queued tablet resends it).
    expect((await app.inject({ method: 'POST', url: `/production/boards/targets/${targets[10]!.id}/reason`, headers: { 'x-test-session': 'lead' }, payload: { reasonCode: 'SETUP', version: 1 } })).statusCode).toBe(400)
  })

  it('REFUSED: removing the target of an hour whose reason was given', async () => {
    expect(refusalOf(await no('manager', 'PUT', '/production/boards/targets', { lineId: A.lineL1, date: DAY, hours: [{ hour: 9, targetPieces: null }] }, 409))).toBe('refusal/REASON_GIVEN')
  })
})

describe('the WIP heat map (MES-162): bundles per operation across lines', () => {
  it('puts each waiting bundle at its next operation on its line, with levels and the pile word', async () => {
    const map = await ok('manager', 'GET', `/production/boards/heatmap?siteId=${A.siteA1}`)
    expect(map).toMatchObject({ site: { id: A.siteA1 }, stuckLimitHours: 4, capped: false })
    const codes = map.columns.map((column: Json) => column.code)
    expect(codes).toContain(ops.qc!.code)
    const l1 = map.rows.find((row: Json) => row.line?.id === A.lineL1)
    const qc = l1.cells[codes.indexOf(ops.qc!.code)]
    // A, B, C and D were reported at sewing on L1's stations: they wait at the inspection (11 pieces).
    expect(qc).toMatchObject({ bundles: 4, pieces: 11, level: 'HIGH' })
    // E is cut (at a station alone) and not sewn: it waits at sewing on its work order's allocated line, else on no line.
    const lineId = (await admin<{ lineId: string | null }>('SELECT "lineId" FROM "WorkOrder" WHERE id = $1', [wo1]))[0]!.lineId
    const eRow = map.rows.find((row: Json) => (row.line?.id ?? null) === lineId)
    expect(eRow.cells[codes.indexOf(ops.sew!.code)].bundles).toBeGreaterThanOrEqual(1)
    expect(keysOf(map).filter((key) => PERSON_KEYS.test(key))).toEqual([])
    expect((await call('lead', 'GET', `/production/boards/heatmap?siteId=${A.siteA1}`)).statusCode).toBe(403)
    expect((await call('companyB', 'GET', `/production/boards/heatmap?siteId=${A.siteA1}`)).statusCode).toBe(404)
  })
})

describe('the line TV board (ANA-007, MES-166): line totals only, nobody signed in', () => {
  let preview: Json

  it('the office previews L1’s board: output and hours, stations by colour, shape and word, WIP, DHU, the note', async () => {
    preview = await ok('viewer', 'GET', `/production/boards/tv?lineId=${A.lineL1}`)
    expect(preview).toMatchObject({ line: { id: A.lineL1, code: 'L1' }, day: DAY, shift: { label: 'Morning' } })
    expect(preview.output).toMatchObject({ done: 9, target: 24, targetSoFar: 20, pace: 'BEHIND', shortHours: 2 })
    // The code's words of a reason on the TV; never the typed words.
    expect(preview.output.hours.find((hour: Json) => hour.hour === 9)).toMatchObject({ done: 2, targetPieces: 6, short: true, reason: { code: 'OTHER' } })
    expect(preview.output.hours.find((hour: Json) => hour.hour === 9).reason.note).toBeUndefined()
    expect(preview.stations).toEqual([
      expect.objectContaining({ id: A.sew1, code: 'SEW-01', state: 'MACHINE_DOWN', machineDown: true, look: { icon: 'alert-octagon', tone: 'danger', shape: 'OCTAGON' } }),
      expect.objectContaining({ id: A.sew2, code: 'SEW-02', state: 'CALLING', call: 'CALLING', machineDown: false, look: expect.objectContaining({ shape: 'TRIANGLE' }) }),
    ])
    expect(preview.wip).toMatchObject({ bundles: 4, pieces: 11, stuck: 0, capped: false })
    expect(preview.wip.operations.find((operation: Json) => operation.code === ops.qc!.code)).toMatchObject({ bundles: 4, level: 'HIGH' })
    // DHU: 1 scrapped + 1 to rework over 9 good + 1 scrapped = 20.0.
    expect(preview.quality).toEqual({ dhu: '20.0', defects: 2, units: 10 })
    expect(preview.note).toMatchObject({ shiftLabel: 'Morning', topics: ['MACHINES'], text: 'SEW-01 waits for the technician.' })
  })

  it('a signed-in line tablet reads its own line; the display reads the same board with its device token alone', async () => {
    const lead = await ok('lead', 'GET', '/production/boards/tv')
    expect(lead.line.id).toBe(A.lineL1)
    const response = await display(tvToken)
    expect(response.statusCode, response.body).toBe(200)
    const board = response.json()
    expect(board.device).toEqual({ id: A.tv, name: 'Line 1 TV', mode: 'DISPLAY' })
    const { device: _device, asOf: _asOf, ...rest } = board
    const { asOf: _previewAsOf, ...shown } = preview
    expect(rest).toEqual(shown)
  })

  it('names nobody and carries no money; REFUSED: no device, a station tablet, a revoked board, an operator', async () => {
    const workers = (await admin<{ name: string }>('SELECT "displayName" AS name FROM "Worker" WHERE "tenantId" = $1', [A.tenant])).map((row) => row.name)
    expect(workers.length).toBeGreaterThan(0)
    const text = JSON.stringify([(await display(tvToken)).json(), preview, await ok('manager', 'GET', `/production/boards/hourly?lineId=${A.lineL1}`)])
    for (const name of workers) expect(text).not.toContain(name)
    expect(text).not.toMatch(/cost|price|margin|wage|amount/i)
    expect(keysOf(JSON.parse(text)).filter((key) => PERSON_KEYS.test(key))).toEqual([])
    expect((await display(null)).statusCode).toBe(401)
    expect((await display(`${A.tenant}.${A.siteA1}.${A.tv}.${'A'.repeat(26)}`)).statusCode).toBe(401)
    const station = await display(stationToken)
    expect(station.statusCode, station.body).toBe(409)
    expect(refusalOf(station.json().error)).toBe('refusal/NOT_A_BOARD')
    expect((await call('operator', 'GET', '/production/boards/tv')).statusCode).toBe(403)
    expect((await call('companyB', 'GET', `/production/boards/tv?lineId=${A.lineL1}`)).statusCode).toBe(404)
    await admin(`UPDATE "Device" SET status = 'REVOKED', "tokenHash" = NULL, "revokedAt" = now() WHERE id = $1`, [A.tv])
    expect((await display(tvToken)).statusCode).toBe(401)
    expect(andon.targetIds).toHaveLength(4)
  })
})
