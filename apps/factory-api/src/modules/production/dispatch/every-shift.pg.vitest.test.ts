import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { REST_CARD, namedCardKey, wholeCardKey } from '@nexus/factory-domain/production/dispatch/rules'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCalendar } from '../../../../../../packages/factory-db/seed/calendar'
import { seed as seedPeople } from '../../../../../../packages/factory-db/seed/people'
import { seed as seedSchedule } from '../../../../../../packages/factory-db/seed/schedule'
import { seed as seedSkills } from '../../../../../../packages/factory-db/seed/skills'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'

/**
 * Dispatch every shift (B-W2b-49; MES-022, -023, -025 … -028, -031, -032, -033) through the app's real routes on a throwaway
 * PostgreSQL 17 database from the migrations (runtime and floor logins, row-level security and the …_floor_work_w2b_guards
 * triggers real), on the factory-db seeds' plant A1: v1 published (SEED-WO-0001 sewn on line L1 on the 17th), its people and
 * skills. The clock is fixed at Tuesday 17 Nov 2026 09:00 UTC (10:00 at the plant). Every name and number is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/production/dispatch`.
 */

const NOW = new Date('2026-11-17T09:00:00.000Z')
const DAY = '2026-11-17'
const NS = 'w2b49-dispatch'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const siteA1 = idOf('site:A1')
const siteA2 = newId()
const lineL1 = idOf('site:A1:line:L1')
const lineL2 = newId()
const sew1 = idOf('site:A1:station:SEW-01')
const sew2 = idOf('site:A1:station:SEW-02')
const sew3 = newId()
const qc1 = idOf('site:A1:station:QC-01')
const operator = idOf('worker:A1:operator')
const lead = idOf('worker:A1:lead')
const sewingTablet = newId()
const secondTablet = newId()

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let sewing: string
let cutting: string
let packing: string
let inspection: string

const OFFICE: Permission[] = ['production.dispatch.view', 'production.dispatch.manage', 'production.dispatch.handover', 'workorders.view']
const FLOOR: Permission[] = ['floor.work', 'floor.lead', 'production.dispatch.view', 'production.dispatch.manage', 'production.dispatch.handover']
const grant = (permissions: Permission[], sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies: 'all', sites, parties: 'all' })
const floorGrant = (permissions: Permission[]): Grant[] => [{ permissions, companies: [companyA], sites: [siteA1], parties: 'all' }]
const SESSIONS: Record<string, SessionContext> = {
  supervisor: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(OFFICE)] },
  viewer: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['production.dispatch.view', 'workorders.view'])] },
  elsewhere: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(OFFICE, [siteA2])] },
  noRight: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['workorders.view'])] },
  operatorTablet: { audience: 'floor', tenantId: T, actorId: operator, siteId: siteA1, deviceId: sewingTablet, grants: floorGrant(['floor.work']) },
  secondStation: { audience: 'floor', tenantId: T, actorId: lead, siteId: siteA1, deviceId: secondTablet, grants: floorGrant(['floor.work']) },
  leadTablet: { audience: 'floor', tenantId: T, actorId: lead, siteId: siteA1, deviceId: sewingTablet, grants: floorGrant(FLOOR) },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const run = randomBytes(4).toString('hex')
let keys = 0
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await db.admin.query(sql, values)).rows as Row[]
const call = (session: string, method: Method, url: string, payload?: unknown, key?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'POST' ? { 'idempotency-key': key ?? `dispatch-${run}-${++keys}` } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const paths = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const board = (session = 'supervisor', query = '') => ok(session, 'GET', `/production/dispatch/board?siteId=${siteA1}${query}`)
const stationOf = (answer: Json, id: string): Json => answer.lines.flatMap((line: Json) => line.stations).concat(answer.otherStations).find((station: Json) => station.id === id)
const loadOf = (answer: Json, id = lineL1): Json => answer.lines.find((line: Json) => line.id === id).load
const operationCard = (answer: Json, operationId: string): Json | undefined => [...answer.notAssigned, ...answer.lines.flatMap((line: Json) => line.stations.flatMap((station: Json) => station.cards)), ...answer.otherStations.flatMap((station: Json) => station.cards)].find((card: Json) => card.operation.id === operationId)
const assign = (body: Json, session = 'supervisor', status = 201) => ok(session, 'POST', '/production/dispatch/assignments', { date: DAY, ...body }, status)
const move = (body: Json, session = 'supervisor') => ok(session, 'POST', '/production/dispatch/moves', { date: DAY, ...body })
const rowsOfDay = () => admin(`SELECT * FROM "DispatchAssignment" WHERE "tenantId" = $1 AND "workDate" = $2::date`, [T, DAY])
/** The day's rows go: each scenario starts from the plan alone. */
const clearDay = () => admin(`DELETE FROM "DispatchAssignment" WHERE "tenantId" = $1`, [T])
const outbox = (type: string) => admin<{ payload: Json }>('SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id', [T, type])
const audits = (action: string) => admin<{ recordId: string; reason: string | null; after: Json }>('SELECT "recordId", reason, after FROM "AuditLog" WHERE "tenantId" = $1 AND action = $2 ORDER BY at, id', [T, action])
const setRule = (rule: 'FREE' | 'WARN' | 'STRICT') => admin(`UPDATE "ProductionSettings" SET "skippedOperationRule" = $1::"FloorRuleMode" WHERE id = $2`, [rule, siteA1])

async function employeeOf(workerId: string): Promise<string> {
  return (await admin<{ employeeId: string }>('SELECT "employeeId" FROM "Worker" WHERE id = $1', [workerId]))[0]!.employeeId
}

async function clockEvent(employeeId: string, workerId: string | null, kind: 'IN' | 'OUT', at: Date, source: 'OFFLINE' | 'MANUAL' = 'OFFLINE'): Promise<void> {
  const manual = source === 'MANUAL'
  await admin(
    `INSERT INTO "ClockEvent" (id, "tenantId", "companyId", "siteId", "employeeId", "workerId", "deviceId", kind, source, "occurredAt", "deviceTime", "receivedAt", flags, "clientEventId", reason, "createdById")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::"ClockEventKind", $9::"ClockEventSource", $10, $11, $10, '{}', $12, $13, $14)`,
    [newId(), T, companyA, siteA1, employeeId, workerId, manual ? null : sewingTablet, kind, source, at, manual ? null : at, manual ? null : `clock-${run}-${++keys}`, manual ? 'Forgot to clock out' : null, manual ? newId() : null],
  )
}

async function openAttendance(): Promise<void> {
  const notice = (await admin<{ id: string }>(`SELECT id FROM "PrivacyNotice" WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = 'WORKER_FLOOR' AND status = 'PUBLISHED'`, [T, companyA]))[0]!.id
  const dpia = (await admin<{ id: string }>(`SELECT id FROM "PrivacyDpia" WHERE "tenantId" = $1 AND "companyId" = $2 AND status = 'STORED'`, [T, companyA]))[0]!.id
  await admin(
    `INSERT INTO "PeopleLegalGate" (id, "tenantId", "companyId", "siteId", purpose, basis, "basisReference", "noticeId", "dpiaId", "switchedOnAt", "switchedOnById", "updatedAt")
     VALUES ($1, $2, $3, $4, 'ATTENDANCE', 'NOT_REQUIRED', 'SAMPLE - made-up counsel opinion (art. 4 c.2)', $5, $6, $7, $8, now())`,
    [newId(), T, companyA, siteA1, notice, dpia, new Date('2026-11-01T00:00:00.000Z'), newId()],
  )
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  db = await migratedDatabase('dispatch_shift')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: NS })
  await seedCalendar({ db: database, namespace: NS })
  await seedSchedule({ db: database, namespace: NS })
  await seedPeople({ db: database, namespace: NS })
  await seedSkills({ db: database, namespace: NS })
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, 'Sewing tablet 1', 'TABLET', 'ACTIVE', now())`, [sewingTablet, T, companyA, siteA1, sew1])
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, 'Sewing tablet 2', 'TABLET', 'ACTIVE', now())`, [secondTablet, T, companyA, siteA1, sew2])
  // A second line with a sewing station, for moves between lines.
  const centre = (await admin<{ workCentreId: string }>('SELECT "workCentreId" FROM "Station" WHERE id = $1', [sew1]))[0]!.workCentreId
  await admin(`INSERT INTO "Line" (id, "tenantId", "companyId", "siteId", code, name, status, "updatedAt") VALUES ($1, $2, $3, $4, 'L2', 'Made-up line two', 'ACTIVE', now())`, [lineL2, T, companyA, siteA1])
  await admin(`INSERT INTO "Station" (id, "tenantId", "companyId", "siteId", "lineId", "workCentreId", code, name, status, "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, 'SEW-03', 'Made-up station', 'ACTIVE', now())`, [sew3, T, companyA, siteA1, lineL2, centre])
  const postBed = (await admin<{ id: string }>(`SELECT id FROM "MachineClass" WHERE "tenantId" = $1 AND code = 'POST_BED'`, [T]))[0]!.id
  // The post-bed asks an authorisation, as the office says (B-W2b-139: MachineClass.authorisationRequired; the seed's
  // authorisation of E1 on it no longer keeps the class at A1).
  await admin(`UPDATE "MachineClass" SET "authorisationRequired" = true, version = version + 1, "updatedAt" = now() WHERE id = $1`, [postBed])
  await admin(`INSERT INTO "Machine" (id, "tenantId", "companyId", "siteId", "stationId", "classId", "assetNumber", status, "statusSince", "updatedAt") SELECT $1, "tenantId", "companyId", "siteId", $2, $3, 'MADE-UP-PB-01', 'RUNNING', now(), now() FROM "Station" WHERE id = $2`, [newId(), sew3, postBed])
  const operations = await admin<{ id: string; code: string; workOrderId: string }>(`SELECT o.id, o.code, o."workOrderId" FROM "WorkOrderOperation" o JOIN "WorkOrder" w ON w.id = o."workOrderId" WHERE o."tenantId" = $1 AND w.number = 'SEED-WO-0001' ORDER BY o.seq`, [T])
  sewing = operations.find((row) => row.code === 'SEED-SEW-ASM')!.id
  cutting = operations.find((row) => row.code === 'SEED-CUT-LEA')!.id
  packing = operations.at(-1)!.id
  inspection = operations.find((row) => row.code === 'SEED-FIN-QC')!.id
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
  vi.useRealTimers()
}, 60_000)

describe('the board (MES-023, MES-031; design production.dispatch)', () => {
  it('shows the published work with no station yet, the rules, and the load from the planned people while attendance is off', async () => {
    const answer = await board()
    expect(answer).toMatchObject({ day: DAY, today: DAY, past: false, version: { number: 1 }, rules: { sequence: 'WARN', scanSubject: 'WORKER', namesWorkers: true }, attendance: { open: false }, mayManage: true, mayWriteHandover: true, words: null })
    const card = operationCard(answer, sewing)!
    expect(card).toMatchObject({ key: REST_CARD, stationId: null, lineId: lineL1, workOrder: { number: 'SEED-WO-0001', rush: false }, whole: false, operators: [] })
    expect(card.pieces).toBeGreaterThan(0)
    expect(Number(card.minutes)).toBeCloseTo(card.pieces * Number(card.standardMinutes), 1)
    expect(['IN_STOCK', 'ON_THE_WAY', 'MISSING', 'NOT_KNOWN']).toContain(card.material.state)
    // B-W2b-88: the seed's BOM ties the lining and the protector to sewing, so the flag is sewing's own material.
    expect(card.material.scope).toBe('OPERATION')
    expect(card.material.words).toMatch(/this operation uses/)
    expect(card.parallel).toBeNull()
    const load = loadOf(answer)
    expect(load).toMatchObject({ source: 'PLANNED', sourceWords: 'Planned people: clock-in is not switched on at this site.', absent: null })
    expect(load.queuedMinutes).toBe(Math.round(Number(card.minutes)))
    expect(load.words).toContain('Queued ')
    expect(stationOf(answer, sew1)).toMatchObject({ code: 'SEW-01', cards: [], operators: [] })
  })

  it('refuses a line of no site, what the caller may not reach, and any filter by person', async () => {
    expect((await call('noRight', 'GET', `/production/dispatch/board?siteId=${siteA1}`)).statusCode).toBe(403)
    expect((await call('elsewhere', 'GET', `/production/dispatch/board?siteId=${siteA1}`)).statusCode).toBe(404)
    expect((await call('operatorTablet', 'GET', `/production/dispatch/board?siteId=${siteA1}`)).statusCode).toBe(403)
    expect((await call('supervisor', 'GET', `/production/dispatch/board?siteId=${siteA1}&workerId=${operator}`)).statusCode).toBe(400)
    expect((await call('supervisor', 'GET', `/production/dispatch/board?siteId=${siteA1}&lineId=${newId()}`)).statusCode).toBe(400)
  })
})

describe('assigning (MES-023: the qualification check, Owner rule W1)', () => {
  it('puts an operator on a station, in one command with its audit and event, and the board names them with their level', async () => {
    await clearDay()
    await move({ workOrderOperationId: sewing, from: REST_CARD, to: { stationId: sew1 } })
    const before = (await outbox('dispatch.assignment_changed')).length
    const { assignment, overridden } = await assign({ workerId: operator, stationId: sew1 }, 'supervisor')
    expect(assignment).toMatchObject({ kind: 'STATION_OPERATOR', stationId: sew1, lineId: lineL1, workerId: operator, day: DAY, version: 1 })
    expect(overridden).toBe(false)
    const rows = await rowsOfDay()
    expect(rows.find((row) => row.id === assignment.id)).toMatchObject({ employeeId: await employeeOf(operator), overrideReason: null, sequence: null })
    const events = await outbox('dispatch.assignment_changed')
    expect(events).toHaveLength(before + 1)
    expect(events.at(-1)!.payload).toEqual({ siteId: siteA1, workDate: DAY, change: 'ASSIGNED', assignmentIds: [assignment.id], lineIds: [lineL1], stationIds: [sew1], workOrderId: null, workOrderOperationId: null })
    expect((await audits('production.assignOperator')).at(-1)).toMatchObject({ recordId: assignment.id })
    const lane = stationOf(await board(), sew1)
    expect(lane.operators).toEqual([expect.objectContaining({ workerId: operator, name: expect.any(String), level: 'CAN_DO', levelLabel: 'Can do', trainee: false, presence: 'UNKNOWN', reassign: false })])
    expect(lane.cards[0].operators).toEqual([expect.objectContaining({ workerId: operator, level: 'CAN_DO' })])
    // Nothing about a person's work beside the name.
    expect(Object.keys(lane.operators[0]).sort()).toEqual(['assignmentId', 'kind', 'level', 'levelLabel', 'name', 'overridden', 'presence', 'reassign', 'trainee', 'version', 'words', 'workerId'])
  })

  it('answers a repeated key from its receipt and refuses the same person twice', async () => {
    await clearDay()
    const key = `dispatch-${run}-repeat`
    const first = await call('supervisor', 'POST', '/production/dispatch/assignments', { date: DAY, workerId: operator, stationId: sew2 }, key)
    expect(first.statusCode, first.body).toBe(201)
    const again = await call('supervisor', 'POST', '/production/dispatch/assignments', { date: DAY, workerId: operator, stationId: sew2 }, key)
    expect(again.statusCode, again.body).toBe(201)
    expect(again.json().assignment.id).toBe(first.json().assignment.id)
    expect(await rowsOfDay()).toHaveLength(1)
    expect(paths(await no('supervisor', 'POST', '/production/dispatch/assignments', { date: DAY, workerId: operator, stationId: sew2 }, 409))).toContain('refusal/ALREADY_ASSIGNED')
  })

  it('asks a reason for a missing skill, keeps it with who decided, and holds an authorisation whatever the reason', async () => {
    await clearDay()
    // The team lead keeps no cutting skill: at a WARN site (the default) a reason lets it go on.
    expect(paths(await no('supervisor', 'POST', '/production/dispatch/assignments', { date: DAY, workerId: lead, workOrderOperationId: cutting }, 409))).toContain('refusal/OVERRIDE_REASON_NEEDED')
    const { assignment, overridden } = await assign({ workerId: lead, workOrderOperationId: cutting, overrideReason: 'Covering for the morning' })
    expect(overridden).toBe(true)
    expect((await rowsOfDay()).find((entry) => entry.id === assignment.id)).toMatchObject({ overrideReason: 'Covering for the morning', overrideById: (SESSIONS.supervisor as { actorId: string }).actorId })
    expect((await audits('production.assignOperator')).at(-1)).toMatchObject({ reason: 'Covering for the morning' })
    // A post-bed machine at SEW-03: that class asks an authorisation, and the lead holds none.
    const held = await no('supervisor', 'POST', '/production/dispatch/assignments', { date: DAY, workerId: lead, stationId: sew3, overrideReason: 'Covering for the morning' }, 409)
    expect(paths(held)).toContain('refusal/NOT_AUTHORISED')
    expect((await assign({ workerId: operator, stationId: sew3 })).overridden).toBe(false)
    expect(paths(await no('supervisor', 'POST', '/production/dispatch/moves', { date: DAY, workOrderOperationId: sewing, from: REST_CARD, to: { stationId: sew3, workerId: lead } }, 409))).toContain('refusal/NOT_AUTHORISED')
    // The picker says the same before anyone drops anything.
    const picker = await ok('supervisor', 'GET', `/production/dispatch/operators?siteId=${siteA1}&stationId=${sew3}`)
    expect(picker.operators.find((person: Json) => person.workerId === lead)).toMatchObject({ decision: 'HOLD', overridable: false })
    expect(picker.operators.find((person: Json) => person.workerId === operator)).toMatchObject({ decision: 'ALLOW', words: null })
  })

  it('refuses a day that is over, another work centre, a station not of the site, a work order not released', async () => {
    await clearDay()
    expect(paths(await no('supervisor', 'POST', '/production/dispatch/assignments', { date: '2026-11-16', workerId: operator, stationId: sew1 }, 409))).toContain('refusal/PAST_DAY')
    expect(paths(await no('supervisor', 'POST', '/production/dispatch/assignments', { date: DAY, workerId: operator, stationId: qc1, workOrderOperationId: sewing }, 409))).toContain('refusal/WRONG_WORK_CENTRE')
    expect((await call('supervisor', 'POST', '/production/dispatch/assignments', { date: DAY, workerId: operator, stationId: newId() })).statusCode).toBe(404)
    expect((await call('supervisor', 'POST', '/production/dispatch/assignments', { date: DAY, workerId: operator })).statusCode).toBe(400)
    const draft = (await admin<{ id: string }>(`SELECT o.id FROM "WorkOrderOperation" o JOIN "WorkOrder" w ON w.id = o."workOrderId" WHERE o."tenantId" = $1 AND w.status = 'DRAFT' LIMIT 1`, [T]))[0]
    if (draft) expect(paths(await no('supervisor', 'POST', '/production/dispatch/assignments', { date: DAY, workerId: operator, workOrderOperationId: draft.id }, 409))).toContain('refusal/NOT_RELEASED')
    expect((await call('viewer', 'POST', '/production/dispatch/assignments', { date: DAY, workerId: operator, stationId: sew1 })).statusCode).toBe(403)
  })

  it('names nobody at a site whose floor records name the station', async () => {
    await clearDay()
    await admin(`UPDATE "ProductionSettings" SET "scanSubject" = 'STATION' WHERE id = $1`, [siteA1])
    try {
      expect(paths(await no('supervisor', 'POST', '/production/dispatch/assignments', { date: DAY, workerId: operator, stationId: sew1 }, 409))).toContain('refusal/SITE_NAMES_NO_WORKERS')
      expect(paths(await no('supervisor', 'GET', `/production/dispatch/operators?siteId=${siteA1}&stationId=${sew1}`, undefined, 409))).toContain('refusal/SITE_NAMES_NO_WORKERS')
      expect((await board()).rules).toMatchObject({ scanSubject: 'STATION', namesWorkers: false })
      expect((await ok('operatorTablet', 'GET', '/production/dispatch/mine')).entries).toEqual([])
      // Work can still be placed at a station.
      expect((await move({ workOrderOperationId: sewing, from: REST_CARD, to: { stationId: sew1 } })).moved.stationId).toBe(sew1)
    } finally {
      await admin(`UPDATE "ProductionSettings" SET "scanSubject" = 'WORKER' WHERE id = $1`, [siteA1])
    }
  })
})

describe('moving work (MES-027: every move has Undo; design floor.mywork "shows the new order of work")', () => {
  it('moves a card to another station, the two stations\' lists follow at once, and the answer puts it back', async () => {
    await clearDay()
    const toFirst = await move({ workOrderOperationId: sewing, from: REST_CARD, to: { stationId: sew1 } })
    expect(toFirst).toMatchObject({ moved: { key: wholeCardKey(`station:${sew1}`), whole: true, stationId: sew1, lineId: lineL1 }, warnings: [] })
    expect((await ok('operatorTablet', 'GET', '/production/dispatch/station')).entries.map((entry: Json) => entry.operation.id)).toEqual([sewing])
    const moved = await move({ workOrderOperationId: sewing, from: toFirst.moved.key, to: { stationId: sew2 } })
    expect(moved.undo).toMatchObject({ from: wholeCardKey(`station:${sew2}`), to: { stationId: sew1, unplaced: false } })
    expect((await ok('operatorTablet', 'GET', '/production/dispatch/station')).entries).toEqual([])
    const second = await ok('secondStation', 'GET', '/production/dispatch/station')
    expect(second.entries.map((entry: Json) => entry.operation.id)).toEqual([sewing])
    expect(second.entries[0]).toMatchObject({ sequence: expect.objectContaining({ rule: 'WARN' }) })
    const { date: _date, ...undo } = moved.undo
    await move(undo)
    expect(stationOf(await board(), sew1).cards.map((card: Json) => card.operation.id)).toEqual([sewing])
    const off = await move({ workOrderOperationId: sewing, from: wholeCardKey(`station:${sew1}`), to: { unplaced: true } })
    expect(off.moved.key).toBe(REST_CARD)
    expect(await rowsOfDay()).toEqual([])
    expect(operationCard(await board(), sewing)).toMatchObject({ key: REST_CARD, lineId: lineL1 })
  })

  it('moves to another line through its station, and the load follows the work', async () => {
    await clearDay()
    const before = await board()
    const minutes = loadOf(before).queuedMinutes
    const moved = await move({ workOrderOperationId: sewing, from: REST_CARD, to: { lineId: lineL2 } })
    expect(moved.moved).toMatchObject({ stationId: sew3, lineId: lineL2 })
    const after = await board()
    expect(loadOf(after).queuedMinutes).toBe(0)
    expect(loadOf(after, lineL2).queuedMinutes).toBe(minutes)
    expect(stationOf(after, sew3).cards).toHaveLength(1)
    expect(Math.round(Number(stationOf(after, sew3).queuedMinutes))).toBe(minutes)
    expect(paths(await no('supervisor', 'POST', '/production/dispatch/moves', { date: DAY, workOrderOperationId: inspection, from: REST_CARD, to: { lineId: lineL2 } }, 409))).toContain('refusal/LINE_DOES_NOT_DO')
  })

  it('moves some bundles of a card and they come back with the undo', async () => {
    await clearDay()
    const whole = await move({ workOrderOperationId: sewing, from: REST_CARD, to: { stationId: sew1 } })
    const card = stationOf(await board(), sew1).cards[0]
    expect(card.bundles.length).toBeGreaterThan(0)
    const bundle = card.bundles[0]
    const moved = await move({ workOrderOperationId: sewing, from: whole.moved.key, bundleIds: [bundle.id], to: { stationId: sew2 } })
    expect(moved.moved).toMatchObject({ key: namedCardKey(`station:${sew2}`, null), bundleIds: [bundle.id] })
    const answer = await board()
    expect(stationOf(answer, sew2).cards[0]).toMatchObject({ whole: false, bundles: [expect.objectContaining({ id: bundle.id })], pieces: bundle.garments })
    expect(stationOf(answer, sew2).cards[0].pieces + stationOf(answer, sew1).cards.reduce((sum: number, entry: Json) => sum + entry.pieces, 0)).toBe(card.pieces)
    const { date: _date, ...undo } = moved.undo
    await move(undo)
    const back = await board()
    expect(stationOf(back, sew2).cards).toEqual([])
    expect(stationOf(back, sew1).cards[0]).toMatchObject({ pieces: card.pieces })
    expect(await rowsOfDay()).toHaveLength(1)
  })

  it('shows a card back in Not assigned when its station is switched off', async () => {
    await clearDay()
    await move({ workOrderOperationId: sewing, from: REST_CARD, to: { stationId: sew2 } })
    await admin(`UPDATE "Station" SET status = 'ARCHIVED' WHERE id = $1`, [sew2])
    try {
      const answer = await board()
      expect(stationOf(answer, sew2)).toBeUndefined()
      expect(answer.notAssigned.find((card: Json) => card.operation.id === sewing)).toMatchObject({ key: wholeCardKey(`station:${sew2}`), lineId: lineL1 })
    } finally {
      await admin(`UPDATE "Station" SET status = 'ACTIVE' WHERE id = $1`, [sew2])
    }
  })

  it('refuses a card that changed since it was read, another work centre, a reassign at an old version', async () => {
    await clearDay()
    expect(paths(await no('supervisor', 'POST', '/production/dispatch/moves', { date: DAY, workOrderOperationId: sewing, from: wholeCardKey(`station:${sew1}`), to: { stationId: sew2 } }, 409))).toContain('refusal/MOVED_ALREADY')
    expect(paths(await no('supervisor', 'POST', '/production/dispatch/moves', { date: DAY, workOrderOperationId: sewing, from: REST_CARD, to: { stationId: qc1 } }, 409))).toContain('refusal/WRONG_WORK_CENTRE')
    expect((await call('supervisor', 'POST', '/production/dispatch/moves', { date: DAY, workOrderOperationId: sewing, from: REST_CARD, to: {} })).statusCode).toBe(400)
    expect((await call('leadTablet', 'POST', '/production/dispatch/moves', { date: DAY, workOrderOperationId: sewing, from: REST_CARD, to: { stationId: sew1 } })).statusCode).toBe(403)
    const { assignment } = await assign({ workerId: operator, stationId: sew1 })
    expect(paths(await no('supervisor', 'POST', `/production/dispatch/assignments/${assignment.id}/reassign`, { version: 9, workerId: lead }, 409))).toContain('refusal/STALE')
  })
})

describe('sequence rules (MES-025)', () => {
  it("says on each entry what the site's rule makes of work that has not arrived", async () => {
    await clearDay()
    const tomorrow = '&date=2026-11-18'
    await setRule('STRICT')
    const held = operationCard(await board('supervisor', tomorrow), packing)!
    await setRule('WARN')
    const warned = operationCard(await board('supervisor', tomorrow), packing)!
    await setRule('FREE')
    const free = operationCard(await board('supervisor', tomorrow), packing)!
    await setRule('WARN')
    expect(held.state).toBe('WAITING_FOR_PREVIOUS')
    expect(held.sequence).toMatchObject({ rule: 'STRICT', state: 'HELD' })
    expect(held.sequence.words).toContain('strict sequence')
    expect(warned.sequence).toMatchObject({ rule: 'WARN', state: 'WARN' })
    expect(free.sequence).toMatchObject({ rule: 'FREE', state: 'CLEAR', words: null })
  })

  it('refuses a lane that puts an operation before the one it follows at a strict site, and warns at a warn site', async () => {
    await clearDay()
    const centre = (await admin<{ workCentreId: string }>('SELECT "workCentreId" FROM "Station" WHERE id = $1', [sew1]))[0]!.workCentreId
    const own = (await admin<{ workCentreId: string }>('SELECT "workCentreId" FROM "WorkOrderOperation" WHERE id = $1', [inspection]))[0]!.workCentreId
    // Two operations of one work order at one work centre (a frozen routing never gives the seeds that: the triggers step aside here).
    const centreOf = (value: string) => db.admin.query(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE "WorkOrderOperation" SET "workCentreId" = '${value}' WHERE id = '${inspection}'; COMMIT`)
    await centreOf(centre)
    try {
      const sewn = await move({ workOrderOperationId: sewing, from: REST_CARD, to: { stationId: sew1 } })
      expect(sewn.warnings).toEqual([])
      const later = await move({ workOrderOperationId: inspection, from: REST_CARD, to: { stationId: sew1 } })
      expect(later.warnings).toEqual([])
      await setRule('STRICT')
      const refused = await no('supervisor', 'POST', '/production/dispatch/moves', { date: DAY, workOrderOperationId: inspection, from: later.moved.key, to: { stationId: sew1 }, position: 1 }, 409)
      expect(paths(refused)).toContain('refusal/SEQUENCE_ORDER')
      expect(stationOf(await board(), sew1).cards.map((card: Json) => card.operation.id)).toEqual([sewing, inspection])
      await setRule('WARN')
      const warned = await move({ workOrderOperationId: inspection, from: later.moved.key, to: { stationId: sew1 }, position: 1 })
      expect(warned.warnings).toHaveLength(1)
      expect(stationOf(await board(), sew1).cards.map((card: Json) => card.operation.id)).toEqual([inspection, sewing])
      // The station's own list follows the lane.
      expect((await ok('operatorTablet', 'GET', '/production/dispatch/station')).entries.map((entry: Json) => entry.operation.id)).toEqual([inspection, sewing])
      await setRule('FREE')
      expect((await move({ workOrderOperationId: inspection, from: later.moved.key, to: { stationId: sew1 }, position: 2 })).warnings).toEqual([])
    } finally {
      await setRule('WARN')
      await centreOf(own)
    }
  })
})

describe('My work (MES-022) and the material flag (MES-026)', () => {
  it('lists what the day names them for across stations, and nobody else\'s', async () => {
    await clearDay()
    expect((await ok('operatorTablet', 'GET', '/production/dispatch/mine'))).toMatchObject({ entries: [], next: null, words: 'Nothing is assigned to you today. Scan a bundle to work on it.' })
    // The operator of a station has what the plan queues there, with no card moved.
    await assign({ workerId: operator, stationId: sew1 })
    const planned = await ok('operatorTablet', 'GET', '/production/dispatch/mine')
    expect(planned.entries.map((entry: Json) => [entry.operation.id, entry.station.id])).toEqual([[sewing, sew1]])
    await clearDay()
    await move({ workOrderOperationId: sewing, from: REST_CARD, to: { stationId: sew2 } })
    await assign({ workerId: operator, stationId: sew2 })
    const mine = await ok('operatorTablet', 'GET', '/production/dispatch/mine')
    expect(mine.entries.map((entry: Json) => [entry.operation.id, entry.station.id])).toEqual([[sewing, sew2]])
    expect(mine.entries[0]).toMatchObject({ current: false, material: expect.objectContaining({ state: expect.any(String), icon: expect.any(String) }), sequence: expect.objectContaining({ rule: 'WARN' }) })
    expect(mine.words).toBeNull()
    expect((await ok('secondStation', 'GET', '/production/dispatch/mine')).entries).toEqual([])
  })

  it('carries the flag and the rule on the W2a lists too', async () => {
    await clearDay()
    const list = await ok('operatorTablet', 'GET', '/production/dispatch/station')
    expect(list.entries[0]).toMatchObject({ workOrder: { number: 'SEED-WO-0001' }, material: expect.objectContaining({ word: expect.any(String) }), sequence: expect.objectContaining({ rule: 'WARN' }) })
    const office = await ok('supervisor', 'GET', `/production/dispatch?lineId=${lineL1}`)
    expect(office.entries[0].material).toEqual(list.entries[0].material)
  })
})

describe('absence-aware dispatch and the load from the clock (MES-028, MES-031, the legal gate)', () => {
  it('reads nothing of the clock while the ATTENDANCE gate is off', async () => {
    await clearDay()
    await assign({ workerId: operator, stationId: sew1 })
    const answer = await board()
    expect(stationOf(answer, sew1).operators[0]).toMatchObject({ presence: 'UNKNOWN', reassign: false, words: null })
    expect(answer.attendance.open).toBe(false)
    const picker = await ok('supervisor', 'GET', `/production/dispatch/operators?siteId=${siteA1}&stationId=${sew1}`)
    expect(picker).toMatchObject({ clockedOnly: false, attendance: { open: false } })
    expect(picker.operators.every((person: Json) => person.clockedIn === null && person.onBreak === null)).toBe(true)
  })

  it('flags work whose operator is not clocked in, offers it for reassignment, and the viewer sees no one\'s standing', async () => {
    await openAttendance()
    await clockEvent(await employeeOf(lead), lead, 'IN', new Date('2026-11-17T07:00:00.000Z'))
    const answer = await board()
    const lane = stationOf(answer, sew1)
    expect(lane.operators[0]).toMatchObject({ workerId: operator, presence: 'NOT_IN', reassign: true, words: 'Not clocked in: reassign this work.' })
    expect(lane.reassign).toBe(true)
    expect(stationOf(await board('viewer'), sew1).operators[0]).toMatchObject({ presence: null, reassign: false, words: null })
  })

  it('lists only the people clocked in, with their level and no output, and hides a line too small to count', async () => {
    const picker = await ok('supervisor', 'GET', `/production/dispatch/operators?siteId=${siteA1}&stationId=${sew1}&workOrderOperationId=${sewing}`)
    expect(picker).toMatchObject({ clockedOnly: true, attendance: { open: true } })
    expect(picker.operators.map((person: Json) => person.workerId)).toEqual([lead])
    expect(Object.keys(picker.operators[0]).sort()).toEqual(['clockedIn', 'decision', 'level', 'levelLabel', 'name', 'onBreak', 'onThisLine', 'overridable', 'trainee', 'words', 'workerId'])
    expect(picker.operators[0]).toMatchObject({ clockedIn: true, onBreak: false, onThisLine: true })
    // One person in on the line: under the minimum group, no count and no minutes from the clock.
    expect(loadOf(await board())).toMatchObject({ source: 'PLANNED', people: null, sourceWords: 'Planned people: too few are in on this line to show a count.' })
  })

  it('counts the minutes of the people clocked in once they are a group, and a clock-out typed in by HR names no worker', async () => {
    const operatorEmployee = await employeeOf(operator)
    await clockEvent(operatorEmployee, operator, 'IN', new Date('2026-11-17T07:05:00.000Z'))
    const third = (await admin<{ id: string }>(`SELECT id FROM "Employee" WHERE "tenantId" = $1 AND "siteId" = $2 AND status = 'ACTIVE' AND id NOT IN ($3, $4) ORDER BY id LIMIT 1`, [T, siteA1, operatorEmployee, await employeeOf(lead)]))[0]!.id
    await admin(`UPDATE "Employee" SET "homeLineId" = $1 WHERE id = $2`, [lineL1, third])
    await clockEvent(third, null, 'IN', new Date('2026-11-17T07:10:00.000Z'), 'MANUAL')
    const answer = await board()
    expect(stationOf(answer, sew1).operators[0]).toMatchObject({ presence: 'IN', reassign: false, words: null })
    const load = loadOf(answer)
    expect(load).toMatchObject({ source: 'CLOCKED_IN', people: 3, sourceWords: null })
    expect(load.availableMinutes).toBeGreaterThan(0)
    // HR types the clock-out: no worker id on the event, and the person is out all the same.
    await clockEvent(operatorEmployee, null, 'OUT', new Date('2026-11-17T08:30:00.000Z'), 'MANUAL')
    const after = await board()
    expect(stationOf(after, sew1).operators[0]).toMatchObject({ presence: 'NOT_IN', reassign: true })
    expect(loadOf(after)).toMatchObject({ source: 'PLANNED', people: null })
  })

  it("shows the team leader the station's Reassign with no name, and takes the reassign on the tablet", async () => {
    const line = await ok('leadTablet', 'GET', '/production/dispatch/floor/line')
    expect(line).toMatchObject({ line: { id: lineL1 }, day: DAY, mayManage: true, mayWriteHandover: true })
    expect(line.shift.length).toBeGreaterThan(0)
    const station = line.stations.find((entry: Json) => entry.id === sew1)
    // Owner answer F2: "nobody signed in", as a yes or no per station; this test's sessions have no row, so nobody is in.
    expect(line.stations.map((entry: Json) => entry.signedIn)).toEqual(line.stations.map(() => false))
    expect(station.reassign).toEqual([expect.objectContaining({ kind: 'STATION_OPERATOR', words: 'Not clocked in: reassign this work.' })])
    const names = (await admin<{ name: string }>('SELECT "displayName" AS name FROM "Worker" WHERE "tenantId" = $1', [T])).map((row) => row.name)
    const text = JSON.stringify(line)
    for (const name of names) expect(text).not.toContain(name)
    expect(text).not.toMatch(/workerId|employeeId|cost|price|margin|wage/i)
    const picker = await ok('leadTablet', 'GET', `/production/dispatch/operators?assignmentId=${station.reassign[0].assignmentId}`)
    expect(picker.operators.map((person: Json) => person.workerId)).toEqual([lead])
    const done = await ok('leadTablet', 'POST', `/production/dispatch/assignments/${station.reassign[0].assignmentId}/reassign`, { version: station.reassign[0].version, workerId: lead, overrideReason: 'Covering for the morning' })
    expect(done.assignment.workerId).toBe(lead)
    const row = (await rowsOfDay()).find((entry) => entry.id === done.assignment.id)!
    expect(row.employeeId).toBe(await employeeOf(lead))
    expect((await audits('production.reassignOperator')).at(-1)).toMatchObject({ recordId: done.assignment.id })
    const after = await ok('leadTablet', 'GET', '/production/dispatch/floor/line')
    expect(after.stations.find((entry: Json) => entry.id === sew1).reassign).toEqual([])
    expect((await outbox('dispatch.assignment_changed')).at(-1)!.payload.change).toBe('REASSIGNED')
    expect((await call('leadTablet', 'POST', `/production/dispatch/assignments/${done.assignment.id}/remove`, { version: done.assignment.version })).statusCode).toBe(403)
    expect((await call('operatorTablet', 'GET', '/production/dispatch/floor/line')).statusCode).toBe(403)
  })
})

describe('handover notes (MES-033)', () => {
  it('keeps one note per line and shift, edits it at its version, and never shows who wrote it', async () => {
    const first = await ok('leadTablet', 'POST', '/production/dispatch/handover', { lineId: lineL1, topics: ['MACHINES', 'HALF_DONE_BUNDLES'], text: 'Needle 3 bent; bundle 2 half done.' })
    expect(first).toMatchObject({ created: true, note: { lineId: lineL1, shiftDate: DAY, text: 'Needle 3 bent; bundle 2 half done.', version: 1 } })
    expect(first.note.topics.map((topic: Json) => topic.topic)).toEqual(['MACHINES', 'HALF_DONE_BUNDLES'])
    const again = await ok('supervisor', 'POST', '/production/dispatch/handover', { lineId: lineL1, shiftLabel: first.note.shiftLabel, topics: ['MACHINES'], text: 'Needle 3 replaced.', version: 1 })
    expect(again).toMatchObject({ created: false, note: { id: first.note.id, version: 2, text: 'Needle 3 replaced.' } })
    expect(paths(await no('leadTablet', 'POST', '/production/dispatch/handover', { lineId: lineL1, shiftLabel: first.note.shiftLabel, topics: ['OTHER'], version: 1 }, 409))).toContain('refusal/STALE')
    expect((await call('leadTablet', 'POST', '/production/dispatch/handover', { lineId: lineL1, topics: [] })).statusCode).toBe(400)
    expect((await call('operatorTablet', 'POST', '/production/dispatch/handover', { lineId: lineL1, topics: ['OTHER'] })).statusCode).toBe(403)
    const stored = (await admin('SELECT "deviceId", "createdById" FROM "HandoverNote" WHERE id = $1', [first.note.id]))[0]!
    expect(stored).toMatchObject({ deviceId: sewingTablet, createdById: lead })
    const list = await ok('supervisor', 'GET', `/production/dispatch/handover?lineId=${lineL1}`)
    expect(list).toMatchObject({ line: { id: lineL1 }, shift: first.note.shiftLabel, current: { id: first.note.id }, mayWrite: true })
    expect(JSON.stringify(list)).not.toContain(lead)
    expect((await outbox('dispatch.handover_written')).at(-1)!.payload).toEqual({ noteId: first.note.id, siteId: siteA1, lineId: lineL1, shiftDate: DAY, shiftLabel: first.note.shiftLabel, topics: ['MACHINES'], by: 'OFFICE' })
  })

  it('shows the next person what is new since their last session, not their own note', async () => {
    const fresh = await ok('operatorTablet', 'GET', '/production/dispatch/handover/new')
    expect(fresh.line).toMatchObject({ id: lineL1 })
    expect(fresh.notes.map((note: Json) => note.text)).toEqual(['Needle 3 replaced.'])
    expect((await ok('leadTablet', 'GET', '/production/dispatch/handover/new')).notes).toEqual([])
  })

  it('takes a note kept offline through the queue, once', async () => {
    const event = { clientEventId: `handover-${run}`, kind: 'andon.handover.write', seq: 1, occurredAt: '2026-11-17T08:00:00.000Z', payload: { lineId: lineL2, shiftLabel: 'A', topics: ['MATERIAL'], text: 'Thread on the way.' } }
    const first = await call('leadTablet', 'POST', '/floor/sync', { events: [event] })
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json().events[0]).toMatchObject({ clientEventId: event.clientEventId, status: 'accepted' })
    const repeat = await call('leadTablet', 'POST', '/floor/sync', { events: [event] })
    expect(repeat.json().events[0].status).toBe('duplicate')
    expect((await admin('SELECT text FROM "HandoverNote" WHERE "lineId" = $1', [lineL2]))).toEqual([{ text: 'Thread on the way.' }])
  })
})

describe('the printed list (MES-032)', () => {
  it('prints a line and a station, in words and as a PDF, for those who see the board', async () => {
    await clearDay()
    await move({ workOrderOperationId: sewing, from: REST_CARD, to: { stationId: sew1 } })
    await assign({ workerId: lead, stationId: sew1, overrideReason: 'Covering for the morning' })
    const paper = await ok('supervisor', 'GET', `/production/dispatch/print/paper?lineId=${lineL1}&language=en`)
    expect(paper).toMatchObject({ title: 'Dispatch list', heading: expect.stringContaining('Line'), empty: null })
    expect(paper.sections[0].title).toContain('SEW-01')
    expect(paper.sections[0].operators).toContain('Operators: ')
    expect(paper.sections[0].rows[0].cells[1]).toBe('SEED-WO-0001')
    const pdf = await call('supervisor', 'GET', `/production/dispatch/print?stationId=${sew1}`)
    expect(pdf.statusCode, pdf.body.slice(0, 300)).toBe(200)
    expect(pdf.headers['content-type']).toContain('application/pdf')
    expect(pdf.headers['cache-control']).toBe('no-store')
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
    expect((await call('leadTablet', 'GET', `/production/dispatch/print?lineId=${lineL1}`)).statusCode).toBe(200)
    expect((await call('noRight', 'GET', `/production/dispatch/print?lineId=${lineL1}`)).statusCode).toBe(403)
    expect((await call('supervisor', 'GET', '/production/dispatch/print')).statusCode).toBe(400)
    expect((await call('supervisor', 'GET', `/production/dispatch/print?lineId=${lineL1}&stationId=${sew1}`)).statusCode).toBe(400)
  })
})
