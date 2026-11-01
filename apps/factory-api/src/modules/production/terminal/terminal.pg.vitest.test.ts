import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedLabour } from '../../../../../../packages/factory-db/seed/labour'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seed as seedSkills } from '../../../../../../packages/factory-db/seed/skills'
import { seed as seedTime } from '../../../../../../packages/factory-db/seed/time'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { systemContext } from '../../../platform/outbox/system'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { pauseAtClockOut } from './clock-out'

/**
 * Operation timing on the tablet (B-W2b-40; MES-087 start, MES-088 pause with a reason, MES-089 resume, MES-091 hand back,
 * MES-092 pieces done so far, MES-094 team operation, MES-117 open work paused at clock-out) through the app's real routes
 * on a throwaway PostgreSQL 17 database from the migrations (runtime and floor logins: row-level security, the grants and
 * the …_floor_work_w2b_guards timing trigger are real), on the factory-db seeds up to people, time, skills and floor work:
 * plant A1 names workers (its operator acknowledged the worker notice; its team leader acknowledges it here), plant A1's
 * SEED-WO-0001 IN_PROGRESS with its routing 10 cut, 20 sew, 30 final inspection, 40 pack; made-up bundles of 20 garments
 * of its BLK 52 cell, made-up tablets at SEW-01, SEW-02 and CUT-01. Every name and value is made up.
 *
 * The law the tests name: Statuto dei Lavoratori (L. 300/1970) art. 4 — minutes per operation are records of work, never a
 * ranking: no worker or station in an event, another person's work is "another person", the office's minutes per
 * operation name nobody. Owner answer F3 — finishing is one tap: a REPORT needs no START.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/production/terminal`.
 */

let h: Harness
let app: FastifyInstance

const NS = 'w2b40-timing'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const siteA1 = idOf('site:A1')
const sew1 = idOf('site:A1:station:SEW-01')
const sew2 = idOf('site:A1:station:SEW-02')
const cut1 = idOf('site:A1:station:CUT-01')
const operator = idOf('worker:A1:operator')
const lead = idOf('worker:A1:lead')
const tablets = { sew: newId(), sew2: newId(), cut: newId() }

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const floor = (deviceId: string, actorId: string): SessionContext => ({
  audience: 'floor',
  tenantId: T,
  actorId,
  siteId: siteA1,
  deviceId,
  grants: [{ permissions: ['production.scan', 'floor.work'], companies: [companyA], sites: [siteA1], parties: 'all' }],
})
const SESSIONS: Record<string, SessionContext> = {
  op: floor(tablets.sew, operator),
  lead: floor(tablets.sew2, lead),
  opCut: floor(tablets.cut, operator),
  leadCut: floor(tablets.cut, lead),
  office: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['workorders.view'])] },
  noRight: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['production.offstandard.view'])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const run = randomBytes(4).toString('hex')
let serial = 0
const cid = (name: string) => `t-${run}-${name}-${++serial}`
const call = (session: string, method: Method, url: string, payload?: unknown) => app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const refusalOf = (error: Json): string => String(error.issues?.[0]?.path ?? '')
const outbox = async (type: string, subject: string) => admin('SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 AND subject = $3 ORDER BY "occurredAt", id', [T, type, subject])
const rowsOf = async (bundleId: string) => admin('SELECT id, kind::text AS kind, "pauseReasonCode", "workerId", "stationId", "deviceId", "goodQuantity", "deviceTime", "serverTime" FROM "OperationScan" WHERE "bundleId" = $1 ORDER BY "serverTime", id', [bundleId])

let wo1: string
const ops: Record<'cut' | 'sew' | 'qc' | 'pack', string> = { cut: '', sew: '', qc: '', pack: '' }
const bundles: string[] = []

async function bundle(code: string, quantity = 20): Promise<string> {
  const cell = (await admin<{ id: string }>(`SELECT s.id FROM "WorkOrderSize" s JOIN "Colourway" c ON c.id = s."colourwayId" WHERE s."workOrderId" = $1 AND c.code = 'BLK' AND s.size = '52'`, [wo1]))[0]!.id
  const id = newId()
  await admin(`INSERT INTO "Bundle" (id, "tenantId", "siteId", "workOrderId", "workOrderSizeId", code, quantity, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())`, [id, T, siteA1, wo1, cell, code, quantity])
  return id
}

beforeAll(async () => {
  h = await startHarness('terminal')
  h.clock.set(new Date())
  for (const seed of [seedCore, seedPrivacy, seedTime, seedLabour, seedReasons, seedSkills]) await seed({ db: h.database, namespace: NS })
  const device = (id: string, station: string, name: string) =>
    admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, $6, 'TABLET', 'ACTIVE', now())`, [id, T, companyA, siteA1, station, name])
  await device(tablets.sew, sew1, 'Sewing tablet W2B40-1')
  await device(tablets.sew2, sew2, 'Sewing tablet W2B40-2')
  await device(tablets.cut, cut1, 'Cutting tablet W2B40-3')
  // The team leader acknowledges the worker notice in force, as on a tablet (a copy of the operator's acknowledgement).
  await admin(
    `INSERT INTO "WorkerNoticeAck" (id, "tenantId", "siteId", "workerId", "noticeId", "noticeVersion", locale, "noticeSha256", channel, "deviceId", "deviceTime", "serverTime", "createdById")
     SELECT $1, "tenantId", "siteId", $2, "noticeId", "noticeVersion", locale, "noticeSha256", channel, "deviceId", now(), now(), $2 FROM "WorkerNoticeAck" WHERE "workerId" = $3 LIMIT 1`,
    [newId(), lead, operator],
  )
  wo1 = (await admin<{ id: string }>('SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND number = $2', [T, 'SEED-WO-0001']))[0]!.id
  for (const row of await admin<{ id: string; seq: number }>('SELECT id, seq FROM "WorkOrderOperation" WHERE "workOrderId" = $1', [wo1])) ops[({ 10: 'cut', 20: 'sew', 30: 'qc', 40: 'pack' } as const)[row.seq as 10]] = row.id
  for (let n = 1; n <= 6; n += 1) bundles.push(await bundle(`W2B40-BN-${n}-${run}`))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('start, pause with a reason, resume (MES-087, MES-088, MES-089)', () => {
  it('starts the bundle at the operation the station does next, once; a resend answers the first; the same id for another action is refused', async () => {
    const clientScanId = cid('start')
    const started = await ok('op', 'POST', '/production/terminal/start', { clientScanId, bundleId: bundles[0] }, 201)
    expect(started.scan).toMatchObject({ kind: 'START', bundleId: bundles[0], operation: { id: ops.sew, seq: 20 }, team: 0, stationId: sew1, deviceId: tablets.sew })
    expect(started.timing).toMatchObject({ state: 'RUNNING', mine: true, secondsBefore: 0, actions: ['PAUSE', 'PARTIAL', 'HAND_BACK'] })
    expect(started.words).toMatch(/^Started W2B40-BN-1-.* at Op 20\.$/)
    const again = await ok('op', 'POST', '/production/terminal/start', { clientScanId, bundleId: bundles[0] }, 200)
    expect(again.scan.id).toBe(started.scan.id)
    expect(refusalOf(await no('op', 'POST', '/production/terminal/pause', { clientScanId, bundleId: bundles[0], reasonCode: 'MATERIAL_WAIT' }, 409))).toBe('refusal/CLIENT_ID_REUSED')
    const rows = await rowsOf(bundles[0]!)
    expect(rows.map((row) => [row.kind, row.workerId, row.stationId])).toEqual([['START', operator, sew1]])
    // The event names the work, never the person or the station (Statuto art. 4).
    const [event] = await outbox('production.operation_timed', wo1)
    expect(event!.payload).toEqual({ workOrderId: wo1, number: 'SEED-WO-0001', siteId: siteA1, bundleId: bundles[0], scanId: started.scan.id, operationId: ops.sew, operationSeq: 20, kind: 'START', pauseReasonCode: null, pieces: 0, team: 0, postedBy: 'FLOOR' })
  })

  it('refuses a second start of running work, and another bundle while one runs (one job at a time)', async () => {
    expect(refusalOf(await no('op', 'POST', '/production/terminal/start', { clientScanId: cid('start2'), bundleId: bundles[0] }, 409))).toBe('refusal/ALREADY_RUNNING')
    const other = await no('op', 'POST', '/production/terminal/start', { clientScanId: cid('start-other'), bundleId: bundles[1] }, 409)
    expect(refusalOf(other)).toBe('refusal/OTHER_RUNNING')
    expect(other.message).toContain('one bundle at a time')
  })

  it('pauses only with an active code of the PAUSE list, never the system’s own; then resumes', async () => {
    expect(refusalOf(await no('op', 'POST', '/production/terminal/pause', { clientScanId: cid('p-unknown'), bundleId: bundles[0], reasonCode: 'NO_SUCH_REASON' }, 409))).toBe('refusal/PAUSE_REASON_UNKNOWN')
    expect(refusalOf(await no('op', 'POST', '/production/terminal/pause', { clientScanId: cid('p-system'), bundleId: bundles[0], reasonCode: 'CLOCK_OUT' }, 409))).toBe('refusal/PAUSE_REASON_SYSTEM')
    expect(refusalOf(await no('op', 'POST', '/production/terminal/pause', { clientScanId: cid('p-other'), bundleId: bundles[0], reasonCode: 'OTHER' }, 409))).toBe('refusal/NOTE_NEEDED')
    const paused = await ok('op', 'POST', '/production/terminal/pause', { clientScanId: cid('pause'), bundleId: bundles[0], reasonCode: 'MATERIAL_WAIT' }, 201)
    expect(paused.scan).toMatchObject({ kind: 'PAUSE', pauseReasonCode: 'MATERIAL_WAIT', operation: { seq: 20 } })
    expect(paused.timing).toMatchObject({ state: 'PAUSED', pauseReasonCode: 'MATERIAL_WAIT', pausedAtClockOut: false, actions: ['RESUME', 'PARTIAL', 'HAND_BACK'] })
    expect(paused.words).toMatch(/ at Op 20 paused\.$/)
    expect(refusalOf(await no('op', 'POST', '/production/terminal/pause', { clientScanId: cid('p-twice'), bundleId: bundles[0], reasonCode: 'MATERIAL_WAIT' }, 409))).toBe('refusal/ALREADY_PAUSED')
    const state = await ok('op', 'GET', `/production/terminal/state?bundleId=${bundles[0]}`)
    expect(state).toMatchObject({ operation: { id: ops.sew }, timing: { state: 'PAUSED', mine: true } })
    const resumed = await ok('op', 'POST', '/production/terminal/resume', { clientScanId: cid('resume'), bundleId: bundles[0] }, 201)
    expect(resumed.timing).toMatchObject({ state: 'RUNNING', mine: true })
    expect(refusalOf(await no('op', 'POST', '/production/terminal/resume', { clientScanId: cid('r-twice'), bundleId: bundles[0] }, 409))).toBe('refusal/ALREADY_RUNNING')
  })
})

describe('pieces so far, hand back and the one-tap finish (MES-092, MES-091; F3)', () => {
  it('another person’s open work is "another person" — never a name', async () => {
    const error = await no('lead', 'POST', '/production/terminal/pause', { clientScanId: cid('lead-pause'), bundleId: bundles[0], workOrderOperationId: ops.sew, reasonCode: 'BREAK' }, 409)
    expect(refusalOf(error)).toBe('refusal/OPEN_BY_OTHER')
    expect(error.message).toContain('Another person')
    expect(JSON.stringify(error)).not.toContain('Seed Worker')
    expect(refusalOf(await no('lead', 'POST', '/production/terminal/start', { clientScanId: cid('lead-start'), bundleId: bundles[0] }, 409))).toBe('refusal/OPEN_BY_OTHER')
    const seen = await ok('lead', 'GET', `/production/terminal/state?bundleId=${bundles[0]}&workOrderOperationId=${ops.sew}`)
    expect(seen.timing).toMatchObject({ state: 'RUNNING', mine: false, actions: [] })
  })

  it('reports the pieces done so far: the stretch closes and another person continues the bundle', async () => {
    const partial = await ok('op', 'POST', '/production/terminal/partial', { clientScanId: cid('partial'), bundleId: bundles[0], pieces: 8 }, 201)
    expect(partial.scan).toMatchObject({ kind: 'PARTIAL', pieces: 8 })
    expect(partial.timing).toMatchObject({ state: 'NOT_STARTED', piecesSoFar: 8, actions: ['START'] })
    // The lead takes the bundle on at the other sewing station.
    expect((await ok('lead', 'POST', '/production/terminal/start', { clientScanId: cid('lead-start2'), bundleId: bundles[0] }, 201)).timing).toMatchObject({ state: 'RUNNING', mine: true, piecesSoFar: 8 })
    expect(refusalOf(await no('lead', 'POST', '/production/terminal/partial', { clientScanId: cid('lead-partial'), bundleId: bundles[0], pieces: 12 }, 409))).toBe('refusal/PIECES_TOO_MANY')
    const handed = await ok('lead', 'POST', '/production/terminal/hand-back', { clientScanId: cid('hand-back'), bundleId: bundles[0] }, 201)
    expect(handed.scan.kind).toBe('HAND_BACK')
    expect(handed.words).toContain('the time is kept')
    expect(handed.timing).toMatchObject({ state: 'NOT_STARTED' })
  })

  it('finishing stays one tap (POST /production/scans): it ends the running stretch; a reported bundle starts no more', async () => {
    await ok('op', 'POST', '/production/terminal/start', { clientScanId: cid('start-again'), bundleId: bundles[0] }, 201)
    const report = await ok('op', 'POST', '/production/scans', { clientScanId: cid('report'), bundleId: bundles[0], good: 20 }, 201)
    expect(report.scan).toMatchObject({ kind: 'REPORT', goodQuantity: 20, operation: { seq: 20 } })
    expect((await ok('op', 'GET', `/production/terminal/state?bundleId=${bundles[0]}&workOrderOperationId=${ops.sew}`)).timing).toMatchObject({ state: 'REPORTED', actions: [] })
    expect(refusalOf(await no('op', 'POST', '/production/terminal/start', { clientScanId: cid('start-reported'), bundleId: bundles[0], workOrderOperationId: ops.sew }, 409))).toBe('refusal/ALREADY_REPORTED')
    // A bundle never started reports with one tap too.
    expect((await ok('op', 'POST', '/production/scans', { clientScanId: cid('report-direct'), bundleId: bundles[5], good: 20 }, 201)).scan.kind).toBe('REPORT')
  })

  it('the count readers leave the timing rows out: mine, the work order’s scans, WIP', async () => {
    const mine = await ok('op', 'GET', '/production/scans/mine')
    expect(JSON.stringify(mine)).not.toMatch(/"kind":"(START|PAUSE|RESUME|HAND_BACK|PARTIAL)"/)
    const scans = await ok('office', 'GET', `/production/scans/work-orders/${wo1}/scans?bundleId=${bundles[0]}`)
    expect(JSON.stringify(scans)).not.toMatch(/"kind":"(START|PAUSE|RESUME|HAND_BACK|PARTIAL)"/)
    expect(JSON.stringify(scans)).toContain('"kind":"REPORT"')
    await ok('office', 'GET', `/production/scans/work-orders/${wo1}/wip`)
  })

  it('the office reads minutes per operation of the work order, never per person', async () => {
    const answer = await ok('office', 'GET', `/production/terminal/work-orders/${wo1}/timing`)
    const sew = answer.operations.find((entry: Json) => entry.operation.seq === 20)
    expect(sew).toMatchObject({ stretches: 3, handedBack: 1, partials: 1, piecesSoFar: 8, running: 0, paused: 0 })
    expect(sew.pauses).toEqual([{ code: 'MATERIAL_WAIT', count: 1, minutes: expect.stringMatching(/^\d+\.\d{2}$/) }])
    expect(sew.timedMinutes).toMatch(/^\d+\.\d{2}$/)
    expect(JSON.stringify(answer)).not.toContain(operator)
    expect(JSON.stringify(answer)).not.toContain(lead)
    await no('noRight', 'GET', `/production/terminal/work-orders/${wo1}/timing`, undefined, 403)
  })
})

describe('a team operation from the tablet’s crew (MES-094)', () => {
  it('names the crew members asked on the start, and the report names the team', async () => {
    const crew = newId()
    await admin(`INSERT INTO "CrewSession" (id, "tenantId", "siteId", "deviceId", "startedAt", "updatedAt") VALUES ($1, $2, $3, $4, now() - interval '5 minutes', now())`, [crew, T, siteA1, tablets.sew])
    for (const [workerId, active] of [[operator, true], [lead, false]] as const) {
      await admin(`INSERT INTO "CrewMember" (id, "tenantId", "siteId", "crewSessionId", "workerId", "employeeId", active, "joinedAt", "updatedAt") SELECT $1, $2, $3, $4, $5, w."employeeId", $6, now() - interval '4 minutes', now() FROM "Worker" w WHERE w.id = $5`, [newId(), T, siteA1, crew, workerId, active])
    }
    expect(refusalOf(await no('op', 'POST', '/production/terminal/start', { clientScanId: cid('team-stranger'), bundleId: bundles[2], memberIds: [newId()] }, 409))).toBe('refusal/TEAM_NOT_IN_CREW')
    const started = await ok('op', 'POST', '/production/terminal/start', { clientScanId: cid('team-start'), bundleId: bundles[2], memberIds: [lead] }, 201)
    expect(started.scan.team).toBe(2)
    expect(started.timing.people).toBe(2)
    const members = await admin<{ workerId: string; employeeId: string | null }>('SELECT "workerId", "employeeId" FROM "OperationScanMember" WHERE "scanId" = $1 ORDER BY "workerId"', [started.scan.id])
    expect(members.map((row) => row.workerId).sort()).toEqual([lead, operator].sort())
    expect(members.every((row) => row.employeeId !== null)).toBe(true)
    const report = await ok('op', 'POST', '/production/scans', { clientScanId: cid('team-report'), bundleId: bundles[2], good: 20 }, 201)
    expect((await admin('SELECT "workerId" FROM "OperationScanMember" WHERE "scanId" = $1', [report.scan.id])).map((row) => row.workerId).sort()).toEqual([lead, operator].sort())
    await admin(`UPDATE "CrewMember" SET active = false, "leftAt" = now(), "updatedAt" = now() WHERE "crewSessionId" = $1`, [crew])
    await admin(`UPDATE "CrewSession" SET "endedAt" = now(), "endReason" = 'SIGNED_OUT', "updatedAt" = now() WHERE id = $1`, [crew])
  })
})

describe('the qualification check at the start (B-W2b-39; MES-024, MES-246)', () => {
  it('an authorisation missing on a kept machine class holds the start, never lifted; a skill missing only warns', async () => {
    // The cutting table becomes kept at A1: the team leader is authorised on it (made up).
    const tableClass = (await admin<{ id: string }>(`SELECT "classId" AS id FROM "Machine" WHERE "tenantId" = $1 AND "stationId" = $2 LIMIT 1`, [T, cut1]))[0]!.id
    const leadEmployee = (await admin<{ id: string }>('SELECT "employeeId" AS id FROM "Worker" WHERE id = $1', [lead]))[0]!.id
    await admin(`INSERT INTO "MachineAuthorisation" (id, "tenantId", "siteId", "employeeId", "machineClassId", "authorisedOn", "authorisedById", "createdAt", "updatedAt", "createdById") VALUES ($1, $2, $3, $4, $5, current_date - 30, $6, now(), now(), $6)`, [newId(), T, siteA1, leadEmployee, tableClass, idOf('actor')])
    const held = await no('opCut', 'POST', '/production/terminal/start', { clientScanId: cid('cut-held'), bundleId: bundles[3] }, 409)
    expect(refusalOf(held)).toBe('refusal/NOT_AUTHORISED')
    expect(await rowsOf(bundles[3]!)).toEqual([])
    const warned = await ok('leadCut', 'POST', '/production/terminal/start', { clientScanId: cid('cut-warned'), bundleId: bundles[3] }, 201)
    expect(warned.scan.operation.seq).toBe(10)
    expect(warned.qualification).toMatchObject({ mode: 'WARN' })
    await ok('leadCut', 'POST', '/production/terminal/hand-back', { clientScanId: cid('cut-back'), bundleId: bundles[3] }, 201)
  })
})

describe('open work paused at clock-out, and the next sign-in offers to continue (MES-117)', () => {
  it('pauses the person’s running work at the clock-out’s moment, once', async () => {
    // Times from the database's clock (the clock-out is a badge sent online: it counts at the server's time; a VM clock
    // that lags the host under load must not make the start look later than the clock-out).
    const dbNow = (await admin<{ now: Date }>('SELECT now() AS now'))[0]!.now
    await ok('op', 'POST', '/production/terminal/start', { clientScanId: cid('before-out'), bundleId: bundles[4], occurredAt: new Date(dbNow.getTime() - 10 * 60_000).toISOString() }, 201)
    const open = await ok('op', 'GET', '/production/terminal/open')
    expect(open.clockOutWarning).toMatch(/^Your open bundle W2B40-BN-5-.* will be paused\.$/)
    const employee = (await admin<{ id: string }>('SELECT "employeeId" AS id FROM "Worker" WHERE id = $1', [operator]))[0]!.id
    const clockEventId = newId()
    const [{ outAt }] = (await admin<{ outAt: Date }>(
      `INSERT INTO "ClockEvent" (id, "tenantId", "companyId", "siteId", "employeeId", "workerId", "deviceId", kind, source, "occurredAt", "deviceTime", "clientEventId", "createdById")
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'OUT', 'BADGE', now(), now(), $8, $6) RETURNING "occurredAt" AS "outAt"`,
      [clockEventId, T, companyA, siteA1, employee, operator, tablets.sew, `t-${run}-clock-out`],
    )) as [{ outAt: Date }]
    const caller = callerFor(h.database, systemContext(T, newId()))
    const payload = { clockEventId, siteId: siteA1, employeeId: employee, workerId: operator, source: 'BADGE' }
    expect(await pauseAtClockOut(caller, payload)).toEqual({ paused: 1, skipped: 0 })
    // Safe to repeat (the worker retries a job): nothing runs any more, nothing is written again.
    expect(await pauseAtClockOut(caller, payload)).toEqual({ paused: 0, skipped: 0 })
    const rows = await rowsOf(bundles[4]!)
    expect(rows.map((row) => [row.kind, row.pauseReasonCode, row.workerId, row.deviceId])).toEqual([
      ['START', null, operator, tablets.sew],
      ['PAUSE', 'CLOCK_OUT', operator, null],
    ])
    expect(new Date(rows[1]!.deviceTime).toISOString()).toBe(outAt.toISOString())
    const events = await outbox('production.operation_timed', wo1)
    expect(events.at(-1)!.payload).toMatchObject({ kind: 'PAUSE', pauseReasonCode: 'CLOCK_OUT', postedBy: 'SYSTEM', team: 0 })
  })

  it('the next sign-in offers "Continue bundle … at Op 20?"; continuing is a resume', async () => {
    const open = await ok('op', 'GET', '/production/terminal/open')
    expect(open.offer).toMatchObject({ bundleId: bundles[4], workOrderOperationId: ops.sew, words: expect.stringMatching(/^Continue bundle W2B40-BN-5-.* at Op 20\?$/) })
    expect(open.items).toEqual([expect.objectContaining({ bundleId: bundles[4], state: 'PAUSED', pausedAtClockOut: true })])
    expect(open.clockOutWarning).toBeNull()
    expect((await ok('op', 'POST', '/production/terminal/resume', { clientScanId: cid('continue'), bundleId: bundles[4] }, 201)).timing).toMatchObject({ state: 'RUNNING', mine: true })
  })
})

describe('offline: the timing kinds in the floor queue', () => {
  it('applies a queued pause with the tablet’s time and refuses one that does not fit, in words', async () => {
    const pausedAt = new Date(Date.now() - 30_000).toISOString()
    const answer = await ok('op', 'POST', '/floor/sync', {
      events: [
        { clientEventId: cid('q-pause'), seq: 1, kind: 'production.scan.pause', occurredAt: pausedAt, workerId: operator, payload: { bundleId: bundles[4], reasonCode: 'BREAK' } },
        { clientEventId: cid('q-pause2'), seq: 2, kind: 'production.scan.pause', occurredAt: pausedAt, workerId: operator, payload: { bundleId: bundles[4], reasonCode: 'BREAK' } },
      ],
    })
    expect(answer.events.map((event: Json) => event.status)).toEqual(['accepted', 'refused'])
    expect(answer.events[1].refusal).toMatchObject({ code: 'ALREADY_PAUSED', final: true })
    const pause = (await rowsOf(bundles[4]!)).at(-1)!
    expect(pause).toMatchObject({ kind: 'PAUSE', pauseReasonCode: 'BREAK', deviceId: tablets.sew })
    expect(new Date(pause.deviceTime).toISOString()).toBe(pausedAt)
  })
})
