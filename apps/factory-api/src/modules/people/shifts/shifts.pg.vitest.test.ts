import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPeople, type PeopleSeed } from '../../../../../../packages/factory-db/seed/people'
import { seed as seedTime } from '../../../../../../packages/factory-db/seed/time'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type FloorContext, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { answerOnFloor } from './floor'

/**
 * People › Shifts (B-W2b-32; MES-218, MES-222; D.Lgs. 66/2003 arts. 4, 5, 7, 8) on the local stack with the app's real
 * routes: a throwaway PostgreSQL 17 database from the migrations (the runtime logins: row-level security, the column grants
 * and the …_time_w2b_guards triggers are real), the factory-db seeds of one tenant up to time and attendance (plant A1:
 * E1 on the one-shift pattern, E2 its team's lead (the seed member's account), E3 an agency worker until 2026-12-31, E4
 * leaving on 2026-11-30; the law's working-time limits tenant-wide, A1's CCNL break of 15 minutes; every People purpose
 * OFF). Office sessions from the test authenticator; the tablet's answer through its command with the PIN stubbed (the
 * route's PIN is the floor step-up, tested in platform/auth/floor). Every name is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/people/shifts`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let people: PeopleSeed

const NS = 'w2b32-shifts'
const idOf = (key: string): string => seedUuid(NS, key)
const T = {
  tenant: idOf('tenant'),
  companyA: idOf('company:A'),
  companyB: idOf('company:B'),
  siteA1: idOf('site:A1'),
  siteB1: idOf('site:B1'),
  lineA1: idOf('site:A1:line:L1'),
  member: idOf('user:member'),
  pattern2T: idOf('calendar:pattern:2T'),
  pattern1T: idOf('calendar:pattern:1T'),
  workerE1: idOf('worker:A1:operator'),
  workerE2: idOf('worker:A1:lead'),
  deviceA1: idOf('device:A1:cutting'),
}

/** A clean March week of 2027 (no holiday), its next week, and the day after. */
const W = '2027-03-08'
const day = (offset: number) => plusDays(W, offset)

const MANAGE: Permission[] = ['people.shifts.view', 'people.shifts.manage', 'people.overtime.manage', 'people.overtime.approve']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  manager: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(MANAGE)] },
  viewer: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['people.shifts.view'])] },
  companyB: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(MANAGE, [T.companyB])] },
  // The seed member's account: E2's record, the lead of team L1-A (E1, E2, E3).
  lead: { audience: 'office', tenantId: T.tenant, actorId: T.member, grants: [grant(['people.shifts.view', 'people.shifts.team', 'people.overtime.manage'])] },
  floorE1: { audience: 'floor', tenantId: T.tenant, actorId: T.workerE1, siteId: T.siteA1, deviceId: T.deviceA1, grants: [{ permissions: ['floor.work'], companies: [T.companyA], sites: [T.siteA1], parties: 'all' }] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await db.admin.query(sql, values)).rows as R[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `t-${run}-${++keys}`
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
const rowOf = (roster: Json, employeeId: string): Json => roster.rows.find((row: Json) => row.employeeId === employeeId)
const cellOf = (roster: Json, employeeId: string, date: string): Json => rowOf(roster, employeeId).cells.find((cell: Json) => cell.date === date)
const roster = (session = 'manager', from = W, to = day(6)) => ok(session, 'GET', `/people/shifts/roster?siteId=${T.siteA1}&from=${from}&to=${to}`)
const eventsOf = async (type: string) => admin(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [T.tenant, type])
const afternoon = { kind: 'WORK', patternId: T.pattern2T, label: 'Afternoon' }
const morning = { kind: 'WORK', patternId: T.pattern2T, label: 'Morning' }

beforeAll(async () => {
  db = await migratedDatabase('w2b32_shifts')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: NS })
  await seedTime({ db: database, namespace: NS })
  people = await seedPeople({ db: database, namespace: NS })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('the roster sheet (MES-218)', () => {
  it('shows people × days: the default shift faint, the calendar, the limits in force, the choices, people per shift', async () => {
    const sheet = await roster()
    // E3's agency contract ended on 2026-12-31, E5 left: not in a March 2027 roster. E4 is leaving (no shift after 30 Nov).
    expect(sheet.rows.map((row: Json) => row.employeeId).sort()).toEqual([people.employeeIds.e1, people.employeeIds.e2, people.employeeIds.e4].sort())
    expect(rowOf(sheet, people.employeeIds.e1)).toMatchObject({ line: { id: T.lineA1 }, team: { code: 'L1-A' }, isLead: false, defaultPattern: { code: '1T' }, canEdit: true })
    expect(rowOf(sheet, people.employeeIds.e2)).toMatchObject({ isLead: true })
    expect(cellOf(sheet, people.employeeIds.e1, W)).toMatchObject({ source: 'DEFAULT', value: { kind: 'WORK', shift: { label: 'Day', startMinute: 480, endMinute: 1020, breakMinutes: 60 } }, entry: null, open: true, absence: null, warnings: [] })
    expect(cellOf(sheet, people.employeeIds.e1, day(5))).toMatchObject({ source: 'DEFAULT', value: { kind: 'OFF' }, open: false })
    expect(cellOf(sheet, people.employeeIds.e4, W)).toMatchObject({ source: 'NONE', value: null, issue: 'AFTER_LAST_DAY' })
    expect(rowOf(sheet, people.employeeIds.e4).lastWorkingDay).toBe('2026-11-30')
    expect(sheet.sites).toHaveLength(1)
    expect(sheet.sites[0]).toMatchObject({ site: { id: T.siteA1 }, timeZone: 'Europe/Rome', absences: { shown: false, words: expect.stringMatching(/Statuto dei Lavoratori art\. 4 c\.2-3/) } })
    expect(sheet.sites[0].days.map((entry: Json) => entry.open)).toEqual([true, true, true, true, true, false, false])
    const rules = Object.fromEntries(sheet.sites[0].rules.map((rule: Json) => [rule.kind, rule]))
    expect(rules.DAILY_REST).toMatchObject({ limitMinutes: 660, action: 'WARN', legalReference: 'D.Lgs. 66/2003 art. 7', scope: 'TENANT' })
    expect(rules.BREAK_AFTER).toMatchObject({ breakMinutes: 15, source: 'CCNL', scope: 'SITE' })
    expect(rules.WEEKLY_AVERAGE).toMatchObject({ limitMinutes: 2880, referenceMonths: 4 })
    expect(sheet.choices.find((choice: Json) => choice.patternCode === '1T')).toMatchObject({ label: 'Day', key: 'D' })
    expect(sheet.choices.find((choice: Json) => choice.patternCode === '2T' && choice.label === 'Afternoon')).toMatchObject({ key: 'A', breakMinutes: 15 })
    expect(sheet.footer.find((entry: Json) => entry.lineId === T.lineA1 && entry.date === W)).toMatchObject({ shifts: [{ label: 'Day', people: 2 }], off: 0, none: 0 })
    expect(sheet.canEdit).toBe('ALL')
    // A roster is planning: no pay, attendance or efficiency figure anywhere in it.
    expect(keysOf(sheet).filter((key) => /pay|wage|efficien|clock|present|earn|piece/i.test(key))).toEqual([])
  })

  it('reads only for a viewer; a lead edits their team; another company sees nothing of A1', async () => {
    expect((await roster('viewer')).canEdit).toBe('NONE')
    const lead = await roster('lead')
    expect(lead.canEdit).toBe('TEAM')
    expect(rowOf(lead, people.employeeIds.e1).canEdit).toBe(true)
    expect(rowOf(lead, people.employeeIds.e4).canEdit).toBe(false)
    expect((await call('companyB', 'GET', `/people/shifts/roster?siteId=${T.siteA1}&from=${W}&to=${day(6)}`)).statusCode).toBe(404)
    expect(pathsOf(await no('manager', 'GET', `/people/shifts/roster?siteId=${T.siteA1}&from=${W}&to=${day(42)}`, undefined, 400))).toEqual(['querystring/to'])
  })

  let tuesday: Json
  it('sets cells (DRAFT) with the rest warning in words; a second write on the read version is refused', async () => {
    const written = await ok('manager', 'POST', '/people/shifts/roster/cells', {
      cells: [
        { employeeId: people.employeeIds.e1, date: W, version: null, set: afternoon },
        { employeeId: people.employeeIds.e1, date: day(1), version: null, set: morning, note: 'Order for the trade fair' },
      ],
    })
    expect(written.warnings).toBe(1)
    const [monday, tue] = written.cells.map((entry: Json) => entry.cell)
    expect(monday).toMatchObject({ source: 'ROSTER', value: { shift: { label: 'Afternoon', startMinute: 840, endMinute: 1320 }, patternId: T.pattern2T }, entry: { status: 'DRAFT', version: 1 }, fallback: { kind: 'WORK', shift: { label: 'Day' } } })
    expect(tue.entry).toMatchObject({ status: 'DRAFT', note: 'Order for the trade fair' })
    expect(tue.warnings).toEqual([expect.objectContaining({ rule: 'DAILY_REST', level: 'WARN', words: 'Rest 8 h between 22:00 (8 Mar) and 06:00 — minimum 11 h (D.Lgs. 66/2003 art. 7)', law: 'D.Lgs. 66/2003 art. 7', isNew: false })])
    tuesday = tue
    // Someone else's view of Monday (no row) is stale now.
    const stale = await no('lead', 'POST', '/people/shifts/roster/cells', { cells: [{ employeeId: people.employeeIds.e1, date: W, version: null, set: morning }] }, 409)
    expect(pathsOf(stale)).toEqual(['body/cells/0'])
    expect((await eventsOf('shift.assigned')).at(-1)!.payload).toMatchObject({ siteId: T.siteA1, employeeIds: [people.employeeIds.e1], from: W, to: day(1), cells: 2, change: 'SET' })
    const audit = await admin(`SELECT action, after FROM "AuditLog" WHERE "recordType" = 'Employee' AND "recordId" = $1 AND action = 'people.setRosterCells'`, [people.employeeIds.e1])
    expect(audit.at(-1)!.after.roster).toEqual([{ date: W, before: 'default', after: 'Afternoon 14:00-22:00' }, { date: day(1), before: 'default', after: 'Morning 06:00-14:00' }])
  })

  it('refuses a shift after a leaver\'s last day, a person a lead does not lead, a reader, a typed window that makes no sense', async () => {
    expect(pathsOf(await no('manager', 'POST', '/people/shifts/roster/cells', { cells: [{ employeeId: people.employeeIds.e4, date: W, version: null, set: morning }] }, 409))).toEqual(['refusal/AFTER_LAST_DAY', 'body/cells/0'])
    expect((await no('lead', 'POST', '/people/shifts/roster/cells', { cells: [{ employeeId: people.employeeIds.e4, date: W, version: null, set: { kind: 'OFF' } }] }, 403)).message).toMatch(/people\.shifts\.team/)
    expect((await call('viewer', 'POST', '/people/shifts/roster/cells', { cells: [{ employeeId: people.employeeIds.e1, date: day(2), version: null, set: { kind: 'OFF' } }] })).statusCode).toBe(403)
    expect(pathsOf(await no('manager', 'POST', '/people/shifts/roster/cells', { cells: [{ employeeId: people.employeeIds.e1, date: day(2), version: null, set: { kind: 'WORK', startMinute: 600, endMinute: 500 } }] }, 400))).toEqual(['body/cells/0/set/endMinute'])
    expect(pathsOf(await no('manager', 'POST', '/people/shifts/roster/cells', { cells: [{ employeeId: people.employeeIds.e1, date: day(2), version: null, set: { kind: 'WORK', patternId: T.pattern2T, label: 'Night' } }] }, 400))).toEqual(['body/cells/0/set/label'])
    // The lead plans their own team: a typed night shift, then back.
    const night = await ok('lead', 'POST', '/people/shifts/roster/cells', { cells: [{ employeeId: people.employeeIds.e1, date: day(4), version: null, set: { kind: 'WORK', label: 'Night', startMinute: 1320, endMinute: 1800, breakMinutes: 30 } }] })
    expect(night.cells[0].cell).toMatchObject({ value: { shift: { label: 'Night', startMinute: 1320, endMinute: 1800 }, patternId: null } })
    await ok('lead', 'POST', '/people/shifts/roster/cells', { cells: [{ employeeId: people.employeeIds.e1, date: day(4), version: 1, set: null }] })
  })

  it('holds a write that brings a new warning whose rule blocks (People settings), in words', async () => {
    const ruleId = newId()
    await admin(`INSERT INTO "WorkingTimeRule" (id, "tenantId", "companyId", "siteId", kind, "limitMinutes", action, "alertRoles", source, "legalReference") VALUES ($1, $2, $3, $4, 'DAILY_REST', 660, 'BLOCK', '{}', 'CCNL', 'CCNL example art. 7')`, [ruleId, T.tenant, T.companyA, T.siteA1])
    const held = await no('manager', 'POST', '/people/shifts/roster/cells', {
      cells: [
        { employeeId: people.employeeIds.e1, date: day(2), version: null, set: afternoon },
        { employeeId: people.employeeIds.e1, date: day(3), version: null, set: morning },
      ],
    }, 409)
    expect(pathsOf(held)).toEqual(['refusal/LIMIT_BLOCKED', `limits/${people.employeeIds.e1}/${day(3)}`])
    expect(held.message).toMatch(/Rest 8 h between 22:00 \(10 Mar\) and 06:00 — minimum 11 h \(CCNL example art\. 7\)/)
    // The warning that was already there (Monday → Tuesday) does not hold an unrelated write.
    await ok('manager', 'POST', '/people/shifts/roster/cells', { cells: [{ employeeId: people.employeeIds.e2, date: day(2), version: null, set: { kind: 'OFF' } }] })
    await admin(`UPDATE "WorkingTimeRule" SET status = 'ARCHIVED' WHERE id = $1`, [ruleId])
  })

  it('clears a cell back to the default shift, then publishes the range: the workers read it; a published cell changed stays published', async () => {
    const cleared = await ok('manager', 'POST', '/people/shifts/roster/cells', { cells: [{ employeeId: people.employeeIds.e1, date: W, version: 1, set: null }] })
    expect(cleared.cells[0].cell).toMatchObject({ source: 'DEFAULT', entry: null, value: { shift: { label: 'Day' } } })
    expect((await eventsOf('shift.assigned')).at(-1)!.payload.change).toBe('CLEARED')
    const published = await ok('manager', 'POST', '/people/shifts/roster/publish', { siteId: T.siteA1, from: W, to: day(6) })
    expect(published).toMatchObject({ published: 2, people: 2 })
    const sheet = await roster()
    expect(cellOf(sheet, people.employeeIds.e1, day(1)).entry).toMatchObject({ status: 'PUBLISHED', version: tuesday.entry.version + 1 })
    expect((await eventsOf('roster.published')).at(-1)!.payload).toMatchObject({ siteId: T.siteA1, cells: 2, change: 'PUBLISHED' })
    // A lead publishes only their team; nothing left as a draft here.
    expect(await ok('lead', 'POST', '/people/shifts/roster/publish', { siteId: T.siteA1, from: W, to: day(6) })).toMatchObject({ published: 0 })
    const changed = await ok('manager', 'POST', '/people/shifts/roster/cells', { cells: [{ employeeId: people.employeeIds.e1, date: day(1), version: tuesday.entry.version + 1, set: { kind: 'WORK', patternId: T.pattern1T, label: 'Day' } }] })
    expect(changed.cells[0].cell.entry).toMatchObject({ status: 'PUBLISHED' })
    expect((await eventsOf('roster.published')).at(-1)!.payload).toMatchObject({ cells: 1, change: 'SET', from: day(1) })
    expect((await call('viewer', 'POST', '/people/shifts/roster/publish', { siteId: T.siteA1, from: W, to: day(6) })).statusCode).toBe(403)
  })

  it('assigns a shift to many people over a range: the preview lists the changes and the days left, the apply writes them', async () => {
    const body = { employeeIds: [people.employeeIds.e1, people.employeeIds.e3], from: day(7), to: day(13), set: morning }
    const preview = await ok('manager', 'POST', '/people/shifts/roster/assign/preview', body)
    expect(preview.changes).toHaveLength(5)
    expect(preview.changes[0]).toMatchObject({ employeeId: people.employeeIds.e1, date: day(7), from: { shift: { label: 'Day' } }, fromSource: 'DEFAULT', to: { shift: { label: 'Morning' } }, toSource: 'ROSTER' })
    expect(preview.skipped.map((entry: Json) => `${entry.name}|${entry.why}`).sort()).toEqual([...Array(7).fill('Seed Agency Worker|NOT_EMPLOYED'), 'Seed Employee One|CLOSED', 'Seed Employee One|CLOSED'].sort())
    expect(preview).toMatchObject({ blocked: 0, people: 1, absences: { shown: false } })
    const applied = await ok('manager', 'POST', '/people/shifts/roster/assign', body)
    expect(applied).toMatchObject({ changed: 5, people: 1, skipped: 9 })
    expect((await ok('manager', 'POST', '/people/shifts/roster/assign/preview', body)).changes).toHaveLength(0)
    expect((await eventsOf('shift.assigned')).at(-1)!.payload).toMatchObject({ change: 'ASSIGNED', cells: 5, from: day(7), to: day(11) })
    // Back to the default for two days.
    expect(await ok('manager', 'POST', '/people/shifts/roster/assign', { employeeIds: [people.employeeIds.e1], from: day(10), to: day(11), set: null })).toMatchObject({ changed: 2 })
    // A lead assigns only within their team (E4 is in none).
    expect((await no('lead', 'POST', '/people/shifts/roster/assign', { employeeIds: [people.employeeIds.e4], from: day(7), to: day(7), set: { kind: 'OFF' } }, 403)).message).toMatch(/Seed Office Clerk/)
  })

  it('copies last week onto a week: the preview lists the cells that change, the apply makes the week like the last', async () => {
    const preview = await ok('manager', 'POST', '/people/shifts/roster/copy-week/preview', { siteId: T.siteA1, week: day(7) })
    const sheetBefore = await roster('manager', W, day(13))
    expect(preview.changes.length).toBeGreaterThan(0)
    expect(preview.changes.every((change: Json) => change.date >= day(7) && change.date <= day(13))).toBe(true)
    const applied = await ok('manager', 'POST', '/people/shifts/roster/copy-week', { siteId: T.siteA1, week: day(7) })
    expect(applied.changed).toBe(preview.changes.length)
    const sheet = await roster('manager', W, day(13))
    for (const employeeId of [people.employeeIds.e1, people.employeeIds.e2]) {
      for (let offset = 0; offset < 7; offset++) {
        const source = cellOf(sheetBefore, employeeId, day(offset))
        const target = cellOf(sheet, employeeId, day(offset + 7))
        expect([target.source === 'ROSTER', target.value], `${employeeId} ${day(offset + 7)}`).toEqual([source.source === 'ROSTER', source.source === 'ROSTER' ? source.value : target.value])
      }
    }
    expect(pathsOf(await no('manager', 'POST', '/people/shifts/roster/copy-week/preview', { siteId: T.siteA1, week: day(8) }, 400))).toEqual(['body/week'])
    expect((await eventsOf('shift.assigned')).at(-1)!.payload.change).toBe('COPIED')
  })
})

describe('planned overtime by agreement (MES-222; D.Lgs. 66/2003 art. 5)', () => {
  let request: Json
  it('makes a draft for a date and line with the people to ask, each with the limit checks; a leaver is not asked', async () => {
    expect(pathsOf(await no('manager', 'POST', '/people/overtime-requests', { siteId: T.siteA1, lineId: T.lineA1, date: day(2), minutes: 120, reason: 'Trade fair order', employeeIds: [people.employeeIds.e1, people.employeeIds.e4] }, 409))).toEqual(['refusal/AFTER_LAST_DAY', 'body/employeeIds/1'])
    const made = await ok('manager', 'POST', '/people/overtime-requests', { siteId: T.siteA1, lineId: T.lineA1, date: day(2), minutes: 120, reason: 'Trade fair order', employeeIds: [people.employeeIds.e1, people.employeeIds.e2] }, 201)
    request = made.request
    expect(made.request).toMatchObject({ status: 'DRAFT', stage: 'DRAFT', line: { id: T.lineA1 }, minutes: 120, counts: { asked: 2, agreed: 0, pending: 2 } })
    expect(made.people.map((person: Json) => person.answer)).toEqual(['PENDING', 'PENDING'])
    expect(made).toMatchObject({ canManage: true, canApprove: true })
    expect((await eventsOf('overtime_request.changed')).at(-1)!.payload).toMatchObject({ requestId: request.id, change: 'CREATED', asked: 2 })
    // The picker's check: E2 has an afternoon on Wednesday? No: OFF; E1 the default day, 2 hours after it.
    const checked = await ok('manager', 'POST', '/people/overtime-requests/check', { siteId: T.siteA1, date: day(2), startMinute: 1260, minutes: 300, employeeIds: [people.employeeIds.e1] })
    expect(checked.people[0].checks.map((warning: Json) => warning.rule)).toContain('DAILY_REST')
    expect(pathsOf(await no('manager', 'POST', '/people/overtime-requests', { siteId: T.siteA1, date: '2020-01-06', minutes: 60, reason: 'Past', employeeIds: [people.employeeIds.e1] }, 400))).toEqual(['body/date'])
  })

  it('asks the people; nobody agreed yet so it is not approved; the lead records a spoken yes (OFFICE)', async () => {
    const asked = await ok('manager', 'POST', `/people/overtime-requests/${request.id}/ask`, { version: request.version })
    expect(asked.request).toMatchObject({ status: 'ASKED', stage: 'ASKED', askedAt: expect.any(String) })
    expect((await eventsOf('overtime.asked')).at(-1)!.payload).toMatchObject({ requestId: request.id, date: day(2) })
    expect(pathsOf(await no('manager', 'POST', `/people/overtime-requests/${request.id}/approve`, { version: asked.request.version }, 409))).toEqual(['refusal/NOT_APPROVE'])
    const e2 = asked.people.find((person: Json) => person.employeeId === people.employeeIds.e2)
    const told = await ok('lead', 'POST', `/people/overtime-requests/${request.id}/answers/${e2.agreementId}`, { version: e2.version, answer: 'AGREED' })
    expect(told.request).toMatchObject({ status: 'ASKED', stage: 'AGREED', counts: { agreed: 1, pending: 1 } })
    expect(told.people.find((person: Json) => person.employeeId === people.employeeIds.e2)).toMatchObject({ answer: 'AGREED', via: 'OFFICE', recordedBy: expect.any(String) })
    expect((await eventsOf('overtime.answered')).at(-1)!.payload).toMatchObject({ answer: 'AGREED', via: 'OFFICE', agreed: 1, asked: 2 })
    request = told.request
  })

  it("the worker answers on the tablet: sees their ask, agrees, takes it back, agrees again; nobody answers for another", async () => {
    const mine = await ok('floorE1', 'GET', '/people/floor/my-shifts?days=7')
    expect(mine.employeeId).toBe(people.employeeIds.e1)
    const ask = mine.asks.find((entry: Json) => entry.requestId === request.id)
    expect(ask).toMatchObject({ date: day(2), minutes: 120, reason: 'Trade fair order', stage: 'AGREED', answer: 'PENDING', canAnswer: true })
    const floor = (workerId: string): FloorContext => ({ audience: 'floor', tenantId: T.tenant, actorId: workerId, siteId: T.siteA1, deviceId: T.deviceA1, grants: SESSIONS.floorE1!.grants, requestId: `t-${newId()}` })
    const signed: string[] = []
    const sign = () => void signed.push('pin')
    const yes = await answerOnFloor(callerFor(database, floor(T.workerE1)), ask.agreementId, { version: ask.version, answer: 'AGREED' }, freshKey(), sign)
    expect(yes.ask).toMatchObject({ answer: 'AGREED', stage: 'AGREED' })
    const back = await answerOnFloor(callerFor(database, floor(T.workerE1)), ask.agreementId, { version: yes.ask.version, answer: 'DECLINED' }, freshKey(), sign)
    const again = await answerOnFloor(callerFor(database, floor(T.workerE1)), ask.agreementId, { version: back.ask.version, answer: 'AGREED' }, freshKey(), sign)
    expect(again.ask.answer).toBe('AGREED')
    expect(signed).toHaveLength(3)
    const stored = (await admin(`SELECT answer::text, "answeredVia"::text AS via, "workerId", "deviceId", "answeredById" FROM "OvertimeAgreement" WHERE id = $1`, [ask.agreementId]))[0]!
    expect(stored).toEqual({ answer: 'AGREED', via: 'FLOOR', workerId: T.workerE1, deviceId: T.deviceA1, answeredById: null })
    expect((await eventsOf('overtime.answered')).at(-1)!.payload).toMatchObject({ via: 'FLOOR', agreed: 2 })
    // E2's worker answering E1's ask: not found; E2's own ask the lead recorded: changed by the lead only.
    await expect(answerOnFloor(callerFor(database, floor(T.workerE2)), ask.agreementId, { version: again.ask.version, answer: 'DECLINED' }, freshKey(), sign)).rejects.toMatchObject({ code: 'not_found' })
    const record = await ok('manager', 'GET', `/people/overtime-requests/${request.id}`)
    const e2 = record.people.find((person: Json) => person.employeeId === people.employeeIds.e2)
    await expect(answerOnFloor(callerFor(database, floor(T.workerE2)), e2.agreementId, { version: e2.version, answer: 'DECLINED' }, freshKey(), sign)).rejects.toMatchObject({ issues: [expect.objectContaining({ path: 'refusal/ANSWERED_IN_OFFICE' })] })
    // The route signs with the PIN (requireFloorStepUp, after its own checks): this test app has no floor sign-in, so the
    // answer is refused and stays as it was (the live check signs on a real tablet).
    expect((await call('floorE1', 'POST', `/people/floor/overtime-asks/${ask.agreementId}/answer`, { version: again.ask.version, answer: 'DECLINED' })).statusCode).toBeGreaterThanOrEqual(400)
    expect((await admin(`SELECT answer::text FROM "OvertimeAgreement" WHERE id = $1`, [ask.agreementId]))[0]!.answer).toBe('AGREED')
  })

  it('approves once people agreed (ASKED → AGREED → APPROVED); the answers then stay; the roster shows the planned hours', async () => {
    const record = await ok('manager', 'GET', `/people/overtime-requests/${request.id}`)
    expect((await call('lead', 'POST', `/people/overtime-requests/${request.id}/approve`, { version: record.request.version })).statusCode).toBe(403)
    const approved = await ok('manager', 'POST', `/people/overtime-requests/${request.id}/approve`, { version: record.request.version })
    expect(approved.request).toMatchObject({ status: 'APPROVED', stage: 'APPROVED', approvedBy: null, counts: { agreed: 2 } })
    const statuses = await admin(`SELECT after FROM "AuditLog" WHERE action = 'people.approveOvertime' AND "recordId" = $1`, [request.id])
    expect(statuses[0]!.after).toMatchObject({ status: 'APPROVED' })
    const e1 = approved.people.find((person: Json) => person.employeeId === people.employeeIds.e1)
    const floor: FloorContext = { audience: 'floor', tenantId: T.tenant, actorId: T.workerE1, siteId: T.siteA1, deviceId: T.deviceA1, grants: SESSIONS.floorE1!.grants, requestId: 't-approved' }
    await expect(answerOnFloor(callerFor(database, floor), e1.agreementId, { version: e1.version, answer: 'DECLINED' }, freshKey(), () => {})).rejects.toMatchObject({ issues: [expect.objectContaining({ path: 'refusal/NOT_ANSWER' })] })
    const sheet = await roster()
    expect(cellOf(sheet, people.employeeIds.e1, day(2)).overtime).toEqual([expect.objectContaining({ requestId: request.id, minutes: 120, stage: 'APPROVED', answer: 'AGREED' })])
    const list = await ok('viewer', 'GET', `/people/overtime-requests?siteId=${T.siteA1}&from=${W}&to=${day(13)}`)
    expect(list.requests.find((entry: Json) => entry.id === request.id)).toMatchObject({ stage: 'APPROVED', counts: { asked: 2, agreed: 2 }, checks: { warn: expect.any(Number), block: 0 } })
    expect((await eventsOf('overtime_request.changed')).at(-1)!.payload).toMatchObject({ change: 'APPROVED', agreed: 2 })
  })

  it('adds and takes off people, cancels with a reason; a blocking yearly cap holds the ask', async () => {
    const made = await ok('manager', 'POST', '/people/overtime-requests', { siteId: T.siteA1, date: day(3), startMinute: 1020, minutes: 60, reason: 'Samples', employeeIds: [people.employeeIds.e1] }, 201)
    const added = await ok('manager', 'POST', `/people/overtime-requests/${made.request.id}/people`, { version: made.request.version, add: [people.employeeIds.e2] })
    expect(added.request.counts.asked).toBe(2)
    const removed = await ok('manager', 'POST', `/people/overtime-requests/${made.request.id}/people`, { version: added.request.version, remove: [people.employeeIds.e1] })
    expect(removed.people.map((person: Json) => person.employeeId)).toEqual([people.employeeIds.e2])
    const edited = await ok('manager', 'PATCH', `/people/overtime-requests/${made.request.id}`, { version: removed.request.version, minutes: 90 })
    expect(edited.request.minutes).toBe(90)
    const cancelled = await ok('manager', 'POST', `/people/overtime-requests/${made.request.id}/cancel`, { version: edited.request.version, reason: 'The customer moved the date' })
    expect(cancelled.request).toMatchObject({ status: 'CANCELLED', cancelReason: 'The customer moved the date' })
    expect(pathsOf(await no('manager', 'POST', `/people/overtime-requests/${made.request.id}/ask`, { version: cancelled.request.version }, 409))).toEqual(['refusal/NOT_ASK'])

    const capId = newId()
    await admin(`INSERT INTO "WorkingTimeRule" (id, "tenantId", "companyId", "siteId", kind, "limitMinutes", action, "alertRoles", source, "legalReference") VALUES ($1, $2, $3, $4, 'OVERTIME_YEARLY_CAP', 150, 'BLOCK', '{}', 'CCNL', 'CCNL example art. 5')`, [capId, T.tenant, T.companyA, T.siteA1])
    const held = await no('manager', 'POST', '/people/overtime-requests', { siteId: T.siteA1, date: day(4), minutes: 60, reason: 'Over the cap', employeeIds: [people.employeeIds.e1], ask: true }, 409)
    expect(pathsOf(held)).toEqual(['refusal/LIMIT_BLOCKED', `limits/${people.employeeIds.e1}/${day(4)}`])
    expect(held.message).toMatch(/Planned overtime in 2027 would be 3 h — at most 2 h 30 min a year \(CCNL example art\. 5\)/)
    // The draft (not asked) is kept apart: nothing was written by the held request.
    expect((await admin(`SELECT count(*)::int AS n FROM "OvertimeRequest" WHERE reason = 'Over the cap'`))[0]!.n).toBe(0)
    await admin(`UPDATE "WorkingTimeRule" SET status = 'ARCHIVED' WHERE id = $1`, [capId])
    expect((await call('viewer', 'POST', '/people/overtime-requests', { siteId: T.siteA1, date: day(4), minutes: 60, reason: 'No right', employeeIds: [people.employeeIds.e1] })).statusCode).toBe(403)
  })
})

describe('the worker\'s own shifts on the tablet, and absences behind the ATTENDANCE gate', () => {
  it('shows the worker their published shift and their default shift, never a draft', async () => {
    const today = businessDate(new Date())
    const soon = plusDays(today, 3)
    const later = plusDays(today, 4)
    await ok('manager', 'POST', '/people/shifts/roster/cells', { cells: [{ employeeId: people.employeeIds.e1, date: soon, version: null, set: morning }, { employeeId: people.employeeIds.e1, date: later, version: null, set: afternoon }] })
    await ok('manager', 'POST', '/people/shifts/roster/publish', { siteId: T.siteA1, from: soon, to: soon, employeeIds: [people.employeeIds.e1] })
    const mine = await ok('floorE1', 'GET', '/people/floor/my-shifts?days=7')
    expect(mine.days).toHaveLength(7)
    expect(mine.days.find((entry: Json) => entry.date === soon)).toMatchObject({ source: 'ROSTER', value: { shift: { label: 'Morning' } } })
    // The afternoon is a draft: the worker still sees the shift in force.
    expect(mine.days.find((entry: Json) => entry.date === later).source).not.toBe('ROSTER')
    expect(keysOf(mine).filter((key) => /note|publishedBy|createdBy|askedBy/i.test(key))).toEqual([])
  })

  it('reads absences only where the site\'s ATTENDANCE gate is open; a sickness shows as absent, with no code', async () => {
    const codes = Object.fromEntries((await admin(`SELECT code, id FROM "AbsenceCode" WHERE "tenantId" = $1`, [T.tenant])).map((row) => [row.code, row.id]))
    await admin(`INSERT INTO "AbsenceEntry" (id, "tenantId", "companyId", "employeeId", date, "codeId", minutes) VALUES ($1, $2, $3, $4, $5, $6, 480), ($7, $2, $3, $8, $9, $10, 480)`, [newId(), T.tenant, T.companyA, people.employeeIds.e2, day(15), codes.FER, newId(), people.employeeIds.e1, day(16), codes.MAL])
    const closed = await roster('manager', day(14), day(20))
    expect(cellOf(closed, people.employeeIds.e2, day(15)).absence).toBeNull()
    const gate = (await admin(`SELECT "companyId", "noticeId", "dpiaId", "switchedOnById" FROM "PeopleLegalGate" WHERE "siteId" = $1 AND purpose = 'ATTENDANCE' LIMIT 1`, [T.siteA1]))[0]!
    await admin(`INSERT INTO "PeopleLegalGate" (id, "tenantId", "companyId", "siteId", purpose, basis, "basisReference", "noticeId", "dpiaId", "switchedOnAt", "switchedOnById") VALUES ($1, $2, $3, $4, 'ATTENDANCE', 'NOT_REQUIRED', 'Made-up counsel opinion', $5, $6, now(), $7)`, [newId(), T.tenant, gate.companyId, T.siteA1, gate.noticeId, gate.dpiaId, gate.switchedOnById])
    const open = await roster('manager', day(14), day(20))
    expect(open.sites[0].absences).toEqual({ shown: true, words: null })
    expect(cellOf(open, people.employeeIds.e2, day(15)).absence).toEqual({ kind: 'HOLIDAY', code: 'FER', minutes: 480 })
    expect(cellOf(open, people.employeeIds.e1, day(16)).absence).toEqual({ kind: 'ABSENT', code: null, minutes: 480 })
    // Assign lists the absence as a conflict and leaves the day.
    const preview = await ok('manager', 'POST', '/people/shifts/roster/assign/preview', { employeeIds: [people.employeeIds.e2], from: day(15), to: day(15), set: morning })
    expect(preview).toMatchObject({ changes: [], skipped: [expect.objectContaining({ date: day(15), why: 'ABSENT' })], absences: { shown: true } })
  })
})
