import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { expect } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { localInstant, plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, fixedClock } from '@nexus/factory-domain/core/time'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPeople, type PeopleSeed } from '../../../../../../packages/factory-db/seed/people'
import { seed as seedTime } from '../../../../../../packages/factory-db/seed/time'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor, COMMAND_SETTINGS } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { systemContext } from '../../../platform/outbox/system'
import { runAttendanceDays } from '../attendance/jobs'
import { computeEntriesNow } from './jobs'

/**
 * The world of the overtime and limits PG tests (B-W2b-42): a throwaway PostgreSQL 17 from the migrations, the runtime login
 * (row-level security, the grants, the …_time_w2b_guards are real), the seeds of one tenant up to time and attendance
 * (plant A1 of company A, line L1, team L1-A led by E2, the seed member's account; every People purpose OFF), four made-up
 * people P1–P4 of L1-A, and a day D in the month before this one, so that month is over. Office sessions from the test
 * authenticator. Every name and value is made up.
 */

export type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'

export const ROME = 'Europe/Rome'
const today = businessDate(new Date(), ROME)
const firstOfThisMonth = `${today.slice(0, 7)}-01`
/** The month before this one (over: its timesheets can be approved). */
export const MONTH = plusDays(firstOfThisMonth, -1).slice(0, 7)
/** The day the tests work on, and the two after it. */
export const D = `${MONTH}-20`
export const D1 = plusDays(D, 1)
export const D2 = plusDays(D, 2)
export const local = (hhmm: string, date = D) => {
  const [hour, minute] = hhmm.split(':').map(Number)
  return localInstant(date, hour! * 60 + minute!, ROME)
}

export const HR: Permission[] = ['people.attendance.view', 'people.attendance.manage', 'people.attendance.approve', 'people.attendance.settings', 'people.overtime.review', 'people.timesheets.hr', 'people.limits.manage']
export const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })

export interface World {
  readonly db: MigratedDatabase
  readonly database: FactoryDatabase
  readonly app: FastifyInstance
  readonly people: PeopleSeed
  readonly T: { readonly tenant: string; readonly companyA: string; readonly companyB: string; readonly siteA1: string; readonly lineL1: string; readonly member: string; readonly worker: string; readonly actor: string }
  /** P1–P4: made-up employees of A1, members of team L1-A. */
  readonly P: Record<string, string>
  readonly sessions: Record<string, SessionContext>
  admin<R = Json>(sql: string, values?: unknown[]): Promise<R[]>
  ok(session: string, method: Method, url: string, payload?: unknown, status?: number): Promise<Json>
  no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json>
  /** The clock event a tablet would have recorded. */
  clock(employeeId: string, kind: 'IN' | 'OUT', at: Date): Promise<string>
  /** A published roster row (null window: a day off). */
  roster(employeeId: string, date: string, window: readonly [number, number] | null): Promise<void>
  /** The scheduler's pass as it ran at noon the day after `date`. */
  pass(date: string): Promise<void>
  /** The worker's handler for one person's day. */
  compute(employeeId: string, date: string): Promise<boolean>
  day(employeeId: string, date?: string): Promise<Json>
  /** A person's entries of a day, by class. */
  entries(employeeId: string, date?: string): Promise<Record<string, Json>>
  openGate(): Promise<void>
  closeGate(): Promise<void>
  close(): Promise<void>
}

const pathsOfError = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
export const pathsOf = pathsOfError
export const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : []

export async function openWorld(name: string, ns: string, extraSessions: (T: World['T']) => Record<string, SessionContext> = () => ({})): Promise<World> {
  const idOf = (key: string): string => seedUuid(ns, key)
  const T = { tenant: idOf('tenant'), companyA: idOf('company:A'), companyB: idOf('company:B'), siteA1: idOf('site:A1'), lineL1: idOf('site:A1:line:L1'), member: idOf('user:member'), worker: idOf('worker:A1:operator'), actor: idOf('actor') }
  const db = await migratedDatabase(name)
  const database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: ns })
  await seedTime({ db: database, namespace: ns })
  const people = await seedPeople({ db: database, namespace: ns })
  const sessions: Record<string, SessionContext> = {
    hr: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(HR)] },
    hr2: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(HR)] },
    manager: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['people.attendance.view', 'people.overtime.review', 'people.timesheets.lead'])] },
    viewer: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['people.attendance.view'])] },
    nobody: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['workorders.view'])] },
    // E2, the lead of team L1-A: the seed member's account.
    lead: { audience: 'office', tenantId: T.tenant, actorId: T.member, grants: [grant(['people.timesheets.team'])] },
    // Holds the permission, leads nobody.
    otherLead: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['people.timesheets.team'])] },
    // E2 again, with HR's rights: a decision about E2 is their own.
    self: { audience: 'office', tenantId: T.tenant, actorId: T.member, grants: [grant(HR)] },
    companyB: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(HR, [T.companyB])] },
    ...extraSessions(T),
  }
  const app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => sessions[String(request.headers['x-test-session'])] ?? null) },
  )
  const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await db.admin.query(sql, values)).rows as R[]
  const run = randomBytes(4).toString('hex')
  let keys = 0
  let serial = 0
  const device = newId()
  const call = (session: string, method: Method, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `ot-${run}-${++keys}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", name, kind, status, "enrolledAt", "tokenHash") VALUES ($1, $2, $3, $4, 'Made-up kiosk', 'TABLET', 'ACTIVE', now(), $5)`, [device, T.tenant, T.companyA, T.siteA1, `hash-${run}`])
  const P: Record<string, string> = {}
  for (const [key, first, last] of [['P1', 'Alba', 'Uno'], ['P2', 'Bruno', 'Due'], ['P3', 'Carla', 'Tre'], ['P4', 'Dario', 'Quattro']] as const) {
    P[key] = newId()
    await admin(`INSERT INTO "Employee" (id, "tenantId", "companyId", "siteId", "firstName", "lastName", "displayName", "startDate", "homeLineId") VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-01-05', $8)`, [P[key], T.tenant, T.companyA, T.siteA1, first, `${last} (made up)`, `${first} ${last[0]}.`, T.lineL1])
    await admin(`INSERT INTO "TeamMember" (id, "tenantId", "siteId", "teamId", "employeeId", "isLead", since) VALUES ($1, $2, $3, $4, $5, false, '2026-01-05')`, [newId(), T.tenant, T.siteA1, people.teamIds.a, P[key]])
  }
  const day = async (employeeId: string, date = D): Promise<Json> => {
    const row = (await admin('SELECT * FROM "AttendanceDay" WHERE "tenantId" = $1 AND "employeeId" = $2 AND date = $3::date', [T.tenant, employeeId, date]))[0]
    if (!row) throw new Error(`no attendance day of ${employeeId} on ${date}`)
    return row
  }
  return {
    db,
    database,
    app,
    people,
    T,
    P,
    sessions,
    admin,
    async ok(session, method, url, payload, status = 200) {
      const response = await call(session, method, url, payload)
      expect(response.statusCode, response.body).toBe(status)
      return response.json()
    },
    async no(session, method, url, payload, status) {
      const response = await call(session, method, url, payload)
      expect(response.statusCode, response.body).toBe(status)
      return response.json().error
    },
    async clock(employeeId, kind, at) {
      const id = newId()
      await admin(
        `INSERT INTO "ClockEvent" (id, "tenantId", "companyId", "siteId", "employeeId", "workerId", "deviceId", kind, source, "occurredAt", "deviceTime", "receivedAt", flags, "clientEventId")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::"ClockEventKind", 'OFFLINE', $9, $9, $10, '{}'::"ClockEventFlag"[], $11)`,
        [id, T.tenant, T.companyA, T.siteA1, employeeId, T.worker, device, kind, at, new Date(at.getTime() + 60_000), `ot-${run}-${++serial}`],
      )
      return id
    },
    async roster(employeeId, date, window) {
      await admin(
        `INSERT INTO "RosterEntry" (id, "tenantId", "companyId", "siteId", "employeeId", date, kind, "shiftLabel", "startMinute", "endMinute", "breakMinutes", status, "publishedAt", "publishedById")
         VALUES ($1, $2, $3, $4, $5, $6::date, $7::"RosterEntryKind", $8, $9, $10, $11, 'PUBLISHED', now(), $12)`,
        [newId(), T.tenant, T.companyA, T.siteA1, employeeId, date, window ? 'WORK' : 'OFF', window ? 'Shift' : null, window?.[0] ?? null, window?.[1] ?? null, window ? 30 : 0, T.actor],
      )
    },
    async pass(date) {
      await runAttendanceDays({ database, log: { info: () => undefined, warn: () => undefined, error: () => undefined } as never, clock: fixedClock(local('12:00', plusDays(date, 1))) })
    },
    compute: (employeeId, date) => computeEntriesNow(callerFor(database, systemContext(T.tenant, `ot-${run}`)), COMMAND_SETTINGS, T.tenant, employeeId, date),
    day,
    async entries(employeeId, date = D) {
      const rows = await admin('SELECT * FROM "OvertimeEntry" WHERE "tenantId" = $1 AND "employeeId" = $2 AND date = $3::date', [T.tenant, employeeId, date])
      return Object.fromEntries(rows.map((row) => [String(row.kind), row]))
    },
    async openGate() {
      const notice = (await admin<{ id: string }>(`SELECT id FROM "PrivacyNotice" WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = 'WORKER_FLOOR' AND status = 'PUBLISHED'`, [T.tenant, T.companyA]))[0]!.id
      const dpia = (await admin<{ id: string }>(`SELECT id FROM "PrivacyDpia" WHERE "tenantId" = $1 AND "companyId" = $2 AND status = 'STORED'`, [T.tenant, T.companyA]))[0]!.id
      await admin(
        `INSERT INTO "PeopleLegalGate" (id, "tenantId", "companyId", "siteId", purpose, basis, "basisReference", "noticeId", "dpiaId", "switchedOnAt", "switchedOnById", "updatedAt")
         VALUES ($1, $2, $3, $4, 'ATTENDANCE', 'NOT_REQUIRED', 'SAMPLE - made-up counsel opinion (art. 4 c.2)', $5, $6, $8, $7, now())`,
        [newId(), T.tenant, T.companyA, T.siteA1, notice, dpia, T.actor, local('00:00', plusDays(D, -30))],
      )
    },
    async closeGate() {
      await admin(`UPDATE "PeopleLegalGate" SET "switchedOffAt" = now(), "switchedOffById" = $2, "switchOffReason" = 'made-up test' WHERE "tenantId" = $1 AND "switchedOffAt" IS NULL`, [T.tenant, T.actor])
    },
    async close() {
      await app.close()
      await database.close()
      await db.close()
    },
  }
}
