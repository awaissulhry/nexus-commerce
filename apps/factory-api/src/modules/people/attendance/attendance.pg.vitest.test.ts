import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { localInstant, plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, fixedClock } from '@nexus/factory-domain/core/time'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPeople, type PeopleSeed } from '../../../../../../packages/factory-db/seed/people'
import { seed as seedTime } from '../../../../../../packages/factory-db/seed/time'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { systemContext } from '../../../platform/outbox/system'
import { attendanceHandlers, runAttendanceDays } from './jobs'

/**
 * Attendance days (B-W2b-37; MES-225 rounding, tolerance and grace, MES-226 anomalies, MES-228 absence codes, MES-233 who
 * is in now, MES-238 manual entry with a reason) through the app's real routes, on a throwaway PostgreSQL 17 from the
 * migrations (the runtime login: row-level security, the grants and the …_time_w2b_guards triggers are real), the
 * factory-db seeds of one tenant up to time and attendance (plant A1 of company A with line L1 in the sewing hall; every
 * People purpose OFF), and five made-up people of A1 (P1–P4 on line L1, P5 with no line) whose published roster puts them
 * on a 06:00–14:00 shift (30 minutes' break) five days ago. Clock events are written as a tablet would have (offline, with
 * the tablet time), the days computed by the scheduler's pass (runAttendanceDays) and the worker's handler. Office
 * sessions from the test authenticator. Every name and value is made up.
 *
 * The law the tests name: Statuto dei Lavoratori (L. 300/1970) art. 4 c.2-3 — nothing of a person is read or written
 * while the site's ATTENDANCE gate is off; Owner answer W1 / ANA-075 — no name or one person's minutes in a list, no group
 * under the minimum size; D.Lgs. 152/1997 art. 1-bis — a person decides, never about their own day; GDPR art. 9 — a
 * sickness is a code and a certificate's number. Run with `node scripts/factory/run-pg-tests.mjs modules/people/attendance`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let people: PeopleSeed

const NS = 'w2b37-attendance'
const idOf = (key: string): string => seedUuid(NS, key)
const T = {
  tenant: idOf('tenant'),
  companyA: idOf('company:A'),
  companyB: idOf('company:B'),
  siteA1: idOf('site:A1'),
  lineL1: idOf('site:A1:line:L1'),
  member: idOf('user:member'),
  worker: idOf('worker:A1:operator'),
  actor: idOf('actor'),
}
const ROME = 'Europe/Rome'
const D = plusDays(businessDate(new Date(), ROME), -5)
const local = (hhmm: string, date = D) => {
  const [hour, minute] = hhmm.split(':').map(Number)
  return localInstant(date, hour! * 60 + minute!, ROME)
}

const HR: Permission[] = ['people.attendance.view', 'people.attendance.manage', 'people.attendance.approve', 'people.attendance.settings', 'people.attendance.rollcall']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  hr: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(HR)] },
  hr2: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(HR)] },
  viewer: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['people.attendance.view'])] },
  lead: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['people.attendance.rollcall'])] },
  companyB: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(HR, [T.companyB])] },
  // The seed member's account: E2's record (a decision about E2 is their own).
  self: { audience: 'office', tenantId: T.tenant, actorId: T.member, grants: [grant(HR)] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await db.admin.query(sql, values)).rows as R[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `att-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': freshKey() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const pathsOf = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : []
const outbox = (type: string) => admin<{ payload: Json }>('SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id', [T.tenant, type])
const audits = (action: string) => admin<{ recordId: string; reason: string | null; after: Json }>('SELECT "recordId", reason, after FROM "AuditLog" WHERE "tenantId" = $1 AND action = $2 ORDER BY at, id', [T.tenant, action])
const findDay = async (employeeId: string, date = D): Promise<Json | undefined> => (await admin<Json>('SELECT * FROM "AttendanceDay" WHERE "tenantId" = $1 AND "employeeId" = $2 AND date = $3::date', [T.tenant, employeeId, date]))[0]
async function dayRow(employeeId: string, date = D): Promise<Json> {
  const row = await findDay(employeeId, date)
  if (!row) throw new Error(`no attendance day of ${employeeId} on ${date}`)
  return row
}
const dayUrl = (id: string) => `/people/attendance/days/${id}`
const P: Record<string, string> = {}
const DEVICE = newId()
let serial = 0

/** A clock event as a tablet would have recorded it (offline: the tablet time counts), or signed by name and PIN. */
async function clock(employeeId: string, kind: 'IN' | 'OUT' | 'BREAK_OUT' | 'BREAK_IN', at: Date, how: 'OFFLINE' | 'NAME_PIN' = 'OFFLINE'): Promise<string> {
  const id = newId()
  await admin(
    `INSERT INTO "ClockEvent" (id, "tenantId", "companyId", "siteId", "employeeId", "workerId", "deviceId", kind, source, "occurredAt", "deviceTime", "receivedAt", flags, "clientEventId")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::"ClockEventKind", $9::"ClockEventSource", $10, $10, $11, $12::"ClockEventFlag"[], $13)`,
    [id, T.tenant, T.companyA, T.siteA1, employeeId, T.worker, DEVICE, kind, how, at, how === 'NAME_PIN' ? at : new Date(at.getTime() + 60_000), how === 'NAME_PIN' ? ['FORGOT_BADGE'] : [], `att-${run}-${++serial}`],
  )
  return id
}

/** The scheduler's pass over the open sites (the cron's body), as it ran at noon the day after D (it computes D and D + 1). */
const pass = () => runAttendanceDays({ database, log: { info: () => undefined, warn: () => undefined, error: () => undefined } as never, clock: fixedClock(local('12:00', plusDays(D, 1))) })

beforeAll(async () => {
  db = await migratedDatabase('w2b37_attendance')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: NS })
  await seedTime({ db: database, namespace: NS })
  people = await seedPeople({ db: database, namespace: NS })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", name, kind, status, "enrolledAt", "tokenHash") VALUES ($1, $2, $3, $4, 'Made-up kiosk', 'TABLET', 'ACTIVE', now(), $5)`, [DEVICE, T.tenant, T.companyA, T.siteA1, `hash-${run}`])
  const names = [['P1', 'Alba', 'Uno', T.lineL1], ['P2', 'Bruno', 'Due', T.lineL1], ['P3', 'Carla', 'Tre', T.lineL1], ['P4', 'Dario', 'Quattro', T.lineL1], ['P5', 'Elsa', 'Cinque', null]] as const
  for (const [key, first, last, line] of names) {
    P[key] = newId()
    await admin(
      `INSERT INTO "Employee" (id, "tenantId", "companyId", "siteId", "firstName", "lastName", "displayName", "startDate", "homeLineId") VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-01-05', $8)`,
      [P[key], T.tenant, T.companyA, T.siteA1, first, `${last} (made up)`, `${first} ${last[0]}.`, line],
    )
    await admin(
      `INSERT INTO "RosterEntry" (id, "tenantId", "companyId", "siteId", "employeeId", date, kind, "shiftLabel", "startMinute", "endMinute", "breakMinutes", status, "publishedAt", "publishedById")
       VALUES ($1, $2, $3, $4, $5, $6::date, 'WORK', 'Morning', 360, 840, 30, 'PUBLISHED', now(), $7)`,
      [newId(), T.tenant, T.companyA, T.siteA1, P[key], D, T.actor],
    )
  }
  // Five days ago, as the tablets recorded it.
  await clock(P.P1!, 'IN', local('05:52'))
  await clock(P.P1!, 'OUT', local('14:20'))
  await clock(P.P2!, 'IN', local('06:00'))
  await clock(P.P4!, 'IN', local('06:00'), 'NAME_PIN')
  P.P4double = await clock(P.P4!, 'IN', local('06:05'))
  await clock(P.P4!, 'OUT', local('14:00'))
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

/** Switches A1's ATTENDANCE purpose on, as the Owner would with the notice and the impact assessment on record. */
async function openAttendanceAtA1(): Promise<void> {
  const notice = (await admin<{ id: string }>(`SELECT id FROM "PrivacyNotice" WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = 'WORKER_FLOOR' AND status = 'PUBLISHED'`, [T.tenant, T.companyA]))[0]!.id
  const dpia = (await admin<{ id: string }>(`SELECT id FROM "PrivacyDpia" WHERE "tenantId" = $1 AND "companyId" = $2 AND status = 'STORED'`, [T.tenant, T.companyA]))[0]!.id
  await admin(
    `INSERT INTO "PeopleLegalGate" (id, "tenantId", "companyId", "siteId", purpose, basis, "basisReference", "noticeId", "dpiaId", "switchedOnAt", "switchedOnById", "updatedAt")
     VALUES ($1, $2, $3, $4, 'ATTENDANCE', 'NOT_REQUIRED', 'SAMPLE - made-up counsel opinion (art. 4 c.2)', $5, $6, $8, $7, now())`,
    [newId(), T.tenant, T.companyA, T.siteA1, notice, dpia, T.actor, local('00:00', plusDays(D, -1))],
  )
}

describe('the legal gate: nothing of a person is read or written while ATTENDANCE is off (Statuto dei Lavoratori art. 4 c.2-3)', () => {
  it('refuses every read and write in words, and the scheduler computes nothing', async () => {
    for (const [method, url, body] of [
      ['GET', `/people/attendance/days?siteId=${T.siteA1}`, undefined],
      ['GET', `/people/attendance/counts?siteId=${T.siteA1}`, undefined],
      ['GET', `/people/attendance/who-is-in?siteId=${T.siteA1}`, undefined],
      ['GET', `/people/employees/${P.P1}/attendance`, undefined],
      ['POST', '/people/attendance/roll-call', { siteId: T.siteA1 }],
      ['POST', '/people/attendance/entries', { employeeId: P.P5, date: D, in: local('06:00').toISOString(), reason: 'Forgot the badge at home' }],
    ] as const) {
      const error = await no('hr', method, url, body, 409)
      expect(pathsOf(error)).toContain('gate/ATTENDANCE')
      expect(error.message).toContain('Statuto dei Lavoratori art. 4')
    }
    await pass()
    expect(await findDay(P.P1!)).toBeUndefined()
  })

  it('keeps the settings and the absence codes readable (no person in them)', async () => {
    const codes = await ok('hr', 'GET', '/people/attendance/absence-codes')
    expect(codes.codes.map((code: Json) => code.code)).toEqual(expect.arrayContaining(['FER', 'MAL', 'ROL']))
    const settings = await ok('hr', 'GET', `/people/attendance/settings?companyId=${T.companyA}`)
    expect(settings.example[0]).toBe('A clock-in at 05:52 for a 06:00 shift counts from 06:00.')
  })
})

describe('rounding, tolerance and grace (MES-225)', () => {
  it('saves how clock events become hours, with the worked example, the version read and an audit row', async () => {
    await openAttendanceAtA1()
    const before = await ok('hr', 'GET', `/people/attendance/settings?companyId=${T.companyA}`)
    const body = { companyId: T.companyA, version: before.version, earlyClockInFromShiftStart: true, lateGraceMinutes: 5, overtimeUnitMinutes: 15, roundingMinutes: 0, autoClockOutAfterMinutes: null, fixedBreaks: true }
    expect(pathsOf(await no('hr', 'PUT', '/people/attendance/settings', { ...body, roundingMinutes: 10 }, 400)).length).toBeGreaterThan(0)
    await no('viewer', 'PUT', '/people/attendance/settings', body, 403)
    const saved = await ok('hr', 'PUT', '/people/attendance/settings', body)
    expect(saved).toMatchObject({ lateGraceMinutes: 5, version: (before.version ?? 0) + 1 })
    expect(saved.example[1]).toContain('06:05 still counts from 06:00')
    expect(await no('hr', 'PUT', '/people/attendance/settings', body, 409)).toMatchObject({ code: 'conflict' })
    expect((await outbox('people_settings.attendance_changed')).at(-1)?.payload).toEqual({ companyId: T.companyA, version: saved.version })
    await no('companyB', 'GET', `/people/attendance/settings?companyId=${T.companyA}`, undefined, 404)
  })

  it('computes the days from the clock events and the roster: early clock-in from the start, fixed break, overtime in units', async () => {
    const result = await pass()
    expect(result.failed).toBe(0)
    const p1 = await dayRow(P.P1!)
    expect(p1).toMatchObject({ status: 'OPEN', plannedLabel: 'Morning', plannedStartMinute: 360, plannedEndMinute: 840, plannedMinutes: 450, presentMinutes: 470, breakMinutes: 30, ordinaryMinutes: 450, overtimeMinutes: 15, manual: false })
    // A second pass writes nothing.
    expect((await pass()).computed).toBe(0)
  })
})

describe('the days: a list without names or minutes, one record with the name (Owner answer W1)', () => {
  it('lists the days of a site by state only, and refuses a person key in words', async () => {
    const p3Day = await dayRow(P.P3!)
    const list = await ok('viewer', 'GET', `/people/attendance/days?siteId=${T.siteA1}&from=${D}&to=${D}`)
    expect(list.days.length).toBeGreaterThanOrEqual(4)
    expect(keysOf(list.days)).not.toEqual(expect.arrayContaining(['name']))
    for (const key of ['employeeId', 'name', 'firstName', 'presentMinutes', 'ordinaryMinutes', 'overtimeMinutes']) expect(keysOf(list.days)).not.toContain(key)
    const p3 = list.days.find((day: Json) => day.id === p3Day.id)
    expect(p3).toMatchObject({ absence: 'MISSING', presence: false, planned: { startMinute: 360 }, anomalies: { open: 0 } })
    expect(pathsOf(await no('viewer', 'GET', `/people/attendance/days?siteId=${T.siteA1}&employeeId=${P.P1}`, undefined, 400))).toContain('query/filters/employeeId')
    expect(pathsOf(await no('viewer', 'GET', `/people/attendance/days?siteId=${T.siteA1}&groupBy=employeeId`, undefined, 400))).toContain('query/groupBy/employeeId')
    await no('companyB', 'GET', `/people/attendance/days?siteId=${T.siteA1}`, undefined, 404)
  })

  it('opens one day: the name, the events with their source, the minutes; the tiles count only groups of three or more', async () => {
    const p1 = await dayRow(P.P1!)
    const detail = await ok('viewer', 'GET', dayUrl(p1!.id))
    expect(detail).toMatchObject({ person: { name: 'Alba Uno (made up)' }, figures: { presentMinutes: 470, ordinaryMinutes: 450, overtimeMinutes: 15 }, anomalies: [], holds: [], actions: { approve: false, fix: false } })
    expect(detail.events.map((event: Json) => [event.kind, event.source, event.words])).toEqual([
      ['IN', 'OFFLINE', 'Kept on the tablet while offline (tablet time)'],
      ['OUT', 'OFFLINE', 'Kept on the tablet while offline (tablet time)'],
    ])
    const counts = await ok('viewer', 'GET', `/people/attendance/counts?siteId=${T.siteA1}&from=${D}&to=${D}`)
    expect(counts).toMatchObject({ tooFew: false, tiles: { openAnomalies: expect.any(Number), absencesWithoutCode: expect.any(Number) } })
    expect(counts.tiles.absencesWithoutCode).toBeGreaterThanOrEqual(1)
    expect(counts.tiles.openAnomalies).toBeGreaterThanOrEqual(3)
    const tiny = await ok('viewer', 'GET', `/people/attendance/counts?siteId=${T.siteA1}&lineId=${newId()}`)
    expect(tiny).toMatchObject({ people: null, tooFew: true, tiles: { openAnomalies: null, clockedInNow: null } })
  })
})

describe('anomalies with the rule that found them, fixes with a reason, approval by a person (MES-226, MES-238)', () => {
  it('a clock-in never closed is a missing clock-out; approving holds it; a fix with a reason clears it (FIXED, by whom, why)', async () => {
    const p2 = await dayRow(P.P2!)
    expect(p2.status).toBe('NEEDS_FIX')
    const detail = await ok('hr', 'GET', dayUrl(p2.id))
    expect(detail.anomalies).toEqual([expect.objectContaining({ kind: 'MISSING_CLOCK_OUT', ruleKey: 'people.clock.openLimit', resolution: null })])
    expect(detail.anomalies[0].rule).toContain('D.Lgs. 66/2003 art. 7')
    expect(pathsOf(await no('hr', 'POST', `${dayUrl(p2.id)}/approve`, { version: p2.version }, 409))).toContain('holds/ANOMALIES_OPEN')
    await no('hr', 'POST', `${dayUrl(p2.id)}/fix`, { version: p2.version, action: { kind: 'ADD_EVENT', event: 'OUT', at: local('14:00').toISOString() }, reason: '' }, 400)
    await no('viewer', 'POST', `${dayUrl(p2.id)}/fix`, { version: p2.version, action: { kind: 'ADD_EVENT', event: 'OUT', at: local('14:00').toISOString() }, reason: 'Forgot to clock out' }, 403)
    const fixed = await ok('hr', 'POST', `${dayUrl(p2.id)}/fix`, { version: p2.version, action: { kind: 'ADD_EVENT', event: 'OUT', at: local('14:00').toISOString() }, reasonCode: 'FORGOT_CLOCK_OUT', reason: 'Left at the shift end, confirmed by the lead' })
    expect(fixed).toMatchObject({ status: 'OPEN', manual: true, figures: { presentMinutes: 450, ordinaryMinutes: 450 }, words: ['Manual entries are marked in the LUL calendar.'] })
    expect(fixed.anomalies[0]).toMatchObject({ resolution: 'FIXED', resolutionNote: 'FORGOT_CLOCK_OUT: Left at the shift end, confirmed by the lead' })
    expect(fixed.events.at(-1)).toMatchObject({ kind: 'OUT', source: 'MANUAL', words: 'Entered by hand', reason: 'FORGOT_CLOCK_OUT: Left at the shift end, confirmed by the lead' })
    expect((await audits('people.manualClockEvent')).at(-1)?.reason).toBe('FORGOT_CLOCK_OUT: Left at the shift end, confirmed by the lead')
    // The manual clock-out pauses open work like any clock-out (B-W2b-40 listens to clock.out).
    expect((await outbox('clock.out')).at(-1)?.payload).toMatchObject({ employeeId: P.P2, source: 'MANUAL', workerId: null })
    const approved = await ok('hr', 'POST', `${dayUrl(p2.id)}/approve`, { version: fixed.version })
    expect(approved).toMatchObject({ status: 'APPROVED', holds: [{ code: 'ALREADY_APPROVED' }] })
  })

  it('a duplicate is voided (kept, marked void), a flagged event is accepted with a note, then the day is approved', async () => {
    const p4 = await dayRow(P.P4!)
    const detail = await ok('hr', 'GET', dayUrl(p4.id))
    expect(detail.anomalies.map((anomaly: Json) => anomaly.kind).sort()).toEqual(['DOUBLE_CLOCK_IN', 'FLAGGED_EVENT'])
    const voided = await ok('hr', 'POST', `${dayUrl(p4.id)}/fix`, { version: p4.version, action: { kind: 'VOID_EVENT', clockEventId: P.P4double }, reasonCode: 'DUPLICATE', reason: 'Badge scanned twice' })
    expect(voided.events.find((event: Json) => event.id === P.P4double)).toMatchObject({ voided: true })
    expect(voided.events.find((event: Json) => event.kind === 'VOID')).toMatchObject({ voidsEventId: P.P4double, source: 'MANUAL' })
    const flagged = voided.anomalies.find((anomaly: Json) => anomaly.kind === 'FLAGGED_EVENT')
    expect(voided.anomalies.find((anomaly: Json) => anomaly.kind === 'DOUBLE_CLOCK_IN')).toMatchObject({ resolution: 'FIXED' })
    expect(flagged).toMatchObject({ resolution: null })
    expect(await no('hr', 'POST', `${dayUrl(p4.id)}/fix`, { version: voided.version, action: { kind: 'VOID_EVENT', clockEventId: P.P4double }, reason: 'Again' }, 409)).toMatchObject({ code: 'conflict' })
    const accepted = await ok('hr', 'POST', `/people/attendance/anomalies/${flagged.id}/accept`, { note: 'The lead saw the person at the entrance' })
    expect(accepted).toMatchObject({ status: 'OPEN' })
    expect(accepted.anomalies.find((anomaly: Json) => anomaly.id === flagged.id)).toMatchObject({ resolution: 'ACCEPTED' })
    await ok('hr', 'POST', `${dayUrl(p4.id)}/approve`, { version: accepted.version })
    // An accepted anomaly is not raised again by a later computation.
    expect((await ok('hr', 'GET', dayUrl(p4.id))).anomalies.filter((anomaly: Json) => anomaly.resolution === null)).toEqual([])
  })

  it('a planned day nobody clocked in needs its absence code (MES-228): held, coded inline, approved in bulk', async () => {
    const p3 = await dayRow(P.P3!)
    const bulk = await ok('hr', 'POST', '/people/attendance/days/approve', { dayIds: [p3.id] })
    expect(bulk.held).toEqual([expect.objectContaining({ dayId: p3.id, codes: ['NO_ABSENCE_CODE'] })])
    const codes = await ok('hr', 'GET', '/people/attendance/absence-codes')
    const fer = codes.codes.find((code: Json) => code.code === 'FER')
    const mal = codes.codes.find((code: Json) => code.code === 'MAL')
    // A sickness needs only the certificate's number; a text is refused (GDPR art. 9).
    expect(pathsOf(await no('hr', 'POST', `${dayUrl(p3.id)}/absence`, { version: p3.version, codeId: mal.id }, 400))).toContain('body/documentRef')
    expect(pathsOf(await no('hr', 'POST', `${dayUrl(p3.id)}/absence`, { version: p3.version, codeId: mal.id, documentRef: 'flu and fever' }, 400))).toContain('body/documentRef')
    const coded = await ok('hr', 'POST', `${dayUrl(p3.id)}/absence`, { version: p3.version, codeId: fer.id })
    expect(coded).toMatchObject({ manual: false, figures: { absenceMinutes: 450 }, absences: [{ code: 'FER', minutes: 450, category: 'HOLIDAY' }], holds: [] })
    const again = await ok('hr', 'POST', '/people/attendance/days/approve', { dayIds: [p3.id] })
    expect(again).toMatchObject({ approved: [p3.id], held: [] })
    // A day with clock events changes only through Fix a day.
    const p1 = await dayRow(P.P1!)
    expect(pathsOf(await no('hr', 'POST', `${dayUrl(p1.id)}/absence`, { version: p1.version, codeId: fer.id }, 409))).toContain('refusal/HAS_CLOCK_EVENTS')
  })

  it('a manual entry for a day with nothing: with its reason, marked manual; never one\'s own day; reopening an approved day', async () => {
    await no('hr', 'POST', '/people/attendance/entries', { employeeId: P.P5, date: D, in: local('06:00').toISOString(), out: local('14:00').toISOString(), reason: 'x' }, 400)
    const response = await call('hr', 'POST', '/people/attendance/entries', { employeeId: P.P5, date: D, in: local('06:00').toISOString(), out: local('14:00').toISOString(), offSite: true, reasonCode: 'OFF_SITE', reason: 'At a customer fitting all day' })
    expect(response.statusCode, response.body).toBe(201)
    const entered = response.json()
    expect(entered).toMatchObject({ manual: true, status: 'OPEN', figures: { presentMinutes: 450 } })
    expect(entered.events.map((event: Json) => [event.source, event.offSite])).toEqual([['MANUAL', true], ['MANUAL', true]])
    expect(pathsOf(await no('self', 'POST', '/people/attendance/entries', { employeeId: people.employeeIds.e2, date: D, in: local('06:00').toISOString(), reason: 'My own forgotten clock-in' }, 409))).toContain('refusal/OWN_DAY')
    await no('hr', 'POST', '/people/attendance/entries', { employeeId: P.P5, date: D, in: new Date(Date.now() + 3_600_000).toISOString(), reason: 'In the future' }, 400)
    const p1 = await dayRow(P.P1!)
    const approved = await ok('hr2', 'POST', `${dayUrl(p1.id)}/approve`, { version: p1.version })
    expect(approved.status).toBe('APPROVED')
    await no('hr', 'POST', `${dayUrl(p1.id)}/reopen`, { version: approved.version, reason: '' }, 400)
    const reopened = await ok('hr', 'POST', `${dayUrl(p1.id)}/reopen`, { version: approved.version, reason: 'The person says the clock-out was later' })
    expect(reopened).toMatchObject({ status: 'OPEN', approvedAt: null })
    expect((await audits('people.reopenAttendanceDay')).at(-1)?.reason).toBe('The person says the clock-out was later')
  })

  it('emits ids and states only: no name, no time, no minutes', async () => {
    const changed = await outbox('attendance.day_changed')
    expect(changed.length).toBeGreaterThan(0)
    for (const { payload } of changed) expect(Object.keys(payload).sort()).toEqual(['change', 'dayId', 'employeeId', 'siteId', 'status'])
    const raised = await outbox('attendance.anomaly_raised')
    for (const { payload } of raised) expect(Object.keys(payload).sort()).toEqual(['anomalyId', 'dayId', 'employeeId', 'kind', 'siteId'])
    const p1 = await dayRow(P.P1!)
    const tab = await ok('viewer', 'GET', `/people/employees/${P.P1}/attendance?from=${D}&to=${D}`)
    expect(tab.days).toEqual([expect.objectContaining({ id: p1.id, figures: expect.objectContaining({ presentMinutes: 470 }) })])
  })
})

describe('the worker computes a day after a clock event', () => {
  it('attendance.clock_event → the day of that person computed again', async () => {
    const later = await clock(P.P1!, 'IN', local('15:00'))
    await clock(P.P1!, 'OUT', local('16:00'))
    const [handler] = attendanceHandlers()
    const envelope = { eventId: newId(), type: 'attendance.clock_event', version: 1, context: 'people', tenantId: T.tenant, companyId: T.companyA, siteId: T.siteA1, subject: P.P1, correlationId: `att-${run}`, causationId: null, source: 'test', occurredAt: new Date().toISOString(), payload: { clockEventId: later, siteId: T.siteA1, employeeId: P.P1, kind: 'IN', source: 'OFFLINE', flagged: false } } as unknown as EventEnvelope
    await handler!.handle(envelope, { caller: callerFor(database, systemContext(T.tenant, `att-${run}`)), attempt: 1 })
    expect(await dayRow(P.P1!)).toMatchObject({ presentMinutes: 530 })
  })
})

describe('who is in now and the roll call (MES-233)', () => {
  it('counts per site, area and line, hides a group under the minimum, and records each roll call', async () => {
    const now = Date.now()
    for (const key of ['P1', 'P2', 'P3', 'P4', 'P5']) await clock(P[key]!, 'IN', new Date(now - 30 * 60_000))
    const view = await ok('lead', 'GET', `/people/attendance/who-is-in?siteId=${T.siteA1}`)
    expect(view.people).toBe(5)
    const sewing = view.areas.find((area: Json) => area.areaId === people.areaIds.sewing)
    expect(sewing).toMatchObject({ people: 4, lines: [{ lineId: T.lineL1, people: 4, tooFew: false }] })
    expect(view.areas.find((area: Json) => area.areaId === null)).toMatchObject({ people: null, tooFew: true, lines: [{ lineId: null, people: null, tooFew: true }] })
    expect(view.words).toBe('Too few people to show without identifying them')
    // Counts only: no person's id or name in the answer.
    expect(keysOf(view)).not.toContain('employeeId')
    expect(JSON.stringify(view)).not.toContain('made up')
    await no('viewer', 'POST', '/people/attendance/roll-call', { siteId: T.siteA1 }, 403)
    const roll = await ok('lead', 'POST', '/people/attendance/roll-call', { siteId: T.siteA1 })
    expect(roll.people).toBe(5)
    expect(roll.groups.flatMap((group: Json) => group.people.map((person: Json) => person.name))).toEqual(expect.arrayContaining(['Alba Uno (made up)', 'Elsa Cinque (made up)']))
    expect((await audits('people.attendanceRollCall')).at(-1)).toMatchObject({ recordId: T.siteA1, after: { people: 5, purpose: 'EVACUATION' } })
  })
})

describe('absence codes with their LUL code (MES-228)', () => {
  it('adds the standard list once, keeps codes unique, edits the LUL code, archives and refuses an archived code', async () => {
    const standard = await ok('hr', 'POST', '/people/attendance/absence-codes/standard', { companyId: null })
    expect(standard.skipped).toEqual(expect.arrayContaining(['FER', 'MAL']))
    expect(standard.added.map((code: Json) => code.code)).toEqual(expect.arrayContaining(['EXF', 'MAT', 'CPA']))
    expect((await ok('hr', 'POST', '/people/attendance/absence-codes/standard', { companyId: null })).added).toEqual([])
    await no('companyB', 'POST', '/people/attendance/absence-codes', { companyId: null, code: 'GRP', labelI18n: { it: 'Gruppo' }, category: 'OTHER', paid: true }, 403)
    const created = await ok('hr', 'POST', '/people/attendance/absence-codes', { companyId: T.companyA, code: 'VIS', labelI18n: { it: 'Visita medica aziendale', en: 'Company medical visit' }, category: 'OTHER', paid: true }, 201)
    expect(pathsOf(await no('hr', 'POST', '/people/attendance/absence-codes', { companyId: T.companyA, code: 'VIS', labelI18n: { it: 'Doppio' }, category: 'OTHER', paid: true }, 409))).toContain('refusal/CODE_TAKEN')
    const edited = await ok('hr', 'PATCH', `/people/attendance/absence-codes/${created.id}`, { version: created.version, lulCode: 'VM1' })
    expect(edited).toMatchObject({ lulCode: 'VM1' })
    const archived = await ok('hr', 'POST', `/people/attendance/absence-codes/${created.id}/archive`, { version: edited.version })
    expect(archived.status).toBe('ARCHIVED')
    const p5 = await dayRow(P.P5!)
    expect(pathsOf(await no('hr', 'POST', `${dayUrl(p5.id)}/fix`, { version: p5.version, action: { kind: 'SET_ABSENCE', codeId: created.id, minutes: 60 }, reason: 'A visit in the morning' }, 409))).toContain('refusal/CODE_ARCHIVED')
    expect((await outbox('absence_code.changed')).map(({ payload }) => payload.change)).toEqual(expect.arrayContaining(['STANDARD', 'CREATED', 'EDITED', 'ARCHIVED']))
  })
})
