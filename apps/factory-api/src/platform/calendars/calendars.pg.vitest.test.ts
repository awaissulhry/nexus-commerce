import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { callerFor } from '../../core/command'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { addWorkingDaysFor, supplierArrivalFor, workingCalendarsFor, workingMinutesFor } from './service'

/**
 * Business calendars and shift patterns (B-W2a-08; PLT-103, PLN-001, PLN-002) through the app's real routes on a
 * throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security is real). Made-up names
 * and codes only. Run with `node scripts/factory/run-pg-tests.mjs platform/calendars`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const tenantA = newId()
const tenantB = newId()
const companyA = newId()
const companyB = newId()
const site1 = newId()
const site2 = newId()
const line1 = newId()
const line3 = newId()
const centre1 = newId()
const supplier = newId()
const customer = newId()
const user = newId()

const grant = (permissions: Grant['permissions'], scope: Partial<Grant> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })
const KEEP = ['calendars.view', 'calendars.manage', 'calendars.suppliers.manage'] as const
const SESSIONS: Record<string, SessionContext> = {
  planner: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(KEEP)] },
  // A planner of plant 1 only: its site's calendars, never plant 2's; not the company's (it reaches every site).
  site1: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['calendars.view', 'calendars.manage'], { companies: [companyA], sites: [site1] })] },
  buyer: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['calendars.view', 'calendars.suppliers.manage'])] },
  viewer: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['calendars.view'])] },
  nobody: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['sites.view'])] },
  'planner-b': { audience: 'office', tenantId: tenantB, actorId: user, grants: [grant(KEEP)] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown, key?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const created = (session: string, url: string, payload: unknown, key?: string) => ok(session, 'POST', url, payload, 201, key)

// One shift 08:00-17:00 with a lunch hour; two shifts with a 15-minute break each; Monday to Friday.
const weekdays = [1, 2, 3, 4, 5]
const ONE_SHIFT = weekdays.flatMap((weekday) => [
  { weekday, kind: 'SHIFT', label: 'Day', startMinute: 480, endMinute: 1020 },
  { weekday, kind: 'BREAK', label: 'Lunch', startMinute: 720, endMinute: 780 },
])
const TWO_SHIFTS = weekdays.flatMap((weekday) => [
  { weekday, kind: 'SHIFT', label: 'Morning', startMinute: 360, endMinute: 840 },
  { weekday, kind: 'BREAK', label: 'Break', startMinute: 600, endMinute: 615 },
  { weekday, kind: 'SHIFT', label: 'Afternoon', startMinute: 840, endMinute: 1320 },
  { weekday, kind: 'BREAK', label: 'Break', startMinute: 1080, endMinute: 1095 },
])

const ids: Record<string, string> = {}

beforeAll(async () => {
  db = await migratedDatabase('platform_calendars')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  for (const [tenantId, slug] of [
    [tenantA, 'cal-a'],
    [tenantB, 'cal-b'],
  ] as const) {
    await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenantId, slug])
  }
  await admin(`INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, 'CALA', 'Calendari Prova S.r.l.')`, [companyA, tenantA])
  await admin(`INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, 'CALB', 'Altri Calendari S.r.l.')`, [companyB, tenantB])
  await admin(`INSERT INTO "Site" (id, "tenantId", "companyId", code, name, kind) VALUES ($1, $3, $4, 'P1', 'Stabilimento Uno', 'PLANT'), ($2, $3, $4, 'P2', 'Stabilimento Due', 'PLANT')`, [site1, site2, tenantA, companyA])
  await admin(`INSERT INTO "Line" (id, "tenantId", "companyId", "siteId", code, name) VALUES ($1, $3, $4, $5, 'L1', 'Linea 1'), ($2, $3, $4, $6, 'L3', 'Linea 3')`, [line1, line3, tenantA, companyA, site1, site2])
  await admin(`INSERT INTO "WorkCentre" (id, "tenantId", "companyId", "siteId", code, name, kind) VALUES ($1, $2, $3, $4, 'TAGLIO', 'Taglio', 'CUTTING')`, [centre1, tenantA, companyA, site1])
  await admin(`INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", roles) VALUES ($1, $3, $4, 'FORN1', 'ORGANISATION', 'Conceria Prova S.r.l.', '{SUPPLIER}'), ($2, $3, $4, 'CLI1', 'ORGANISATION', 'Cliente Prova S.r.l.', '{CUSTOMER}')`, [supplier, customer, tenantA, companyA])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 60_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('shift patterns (PLN-002)', () => {
  it('saves a pattern with its shifts and breaks in one command; the views count each weekday', async () => {
    const { pattern } = await created('planner', '/shift-patterns', { code: '1t', name: 'One shift', segments: ONE_SHIFT }, 'pattern-1t-key-0001')
    ids.oneShift = pattern.id
    // The same Idempotency-Key and request: the stored answer, not "the code is taken".
    expect((await created('planner', '/shift-patterns', { code: '1t', name: 'One shift', segments: ONE_SHIFT }, 'pattern-1t-key-0001')).pattern).toEqual(pattern)
    expect([pattern.code, pattern.companyId, pattern.summary, pattern.weeklyMinutes, pattern.shiftEnds, pattern.calendars]).toEqual(['1T', null, '08:00-17:00, Monday to Friday', 2400, ['17:00'], 0])
    expect(pattern.weekdays.find((day: Json) => day.weekday === 1)).toMatchObject({ minutes: 480, shifts: [{ label: 'Day', minutes: 480, breaks: [{ label: 'Lunch' }] }] })
    const two = await created('planner', '/shift-patterns', { code: '2T', name: 'Two shifts', segments: TWO_SHIFTS })
    ids.twoShifts = two.pattern.id
    expect(two.pattern.weeklyMinutes).toBe(5 * 930)
    const [audit] = await admin('SELECT action, after FROM "AuditLog" WHERE "recordId" = $1', [pattern.id])
    expect([audit!.action, audit!.after.segments.length]).toEqual(['calendars.createPattern', 10])
  })

  it('refuses what would count time twice, a taken code, and a tenant-wide pattern from a one-site planner', async () => {
    const overlap = await call('planner', 'POST', '/shift-patterns', { code: 'BAD', name: 'Bad', segments: [ONE_SHIFT[0], { weekday: 1, kind: 'SHIFT', startMinute: 900, endMinute: 1200 }] })
    expect(overlap.statusCode).toBe(400)
    expect(overlap.json().error.issues.map((issue: Json) => issue.path)).toEqual(['body/segments/1'])
    const outside = await call('planner', 'POST', '/shift-patterns', { code: 'BAD', name: 'Bad', segments: [ONE_SHIFT[0], { weekday: 1, kind: 'BREAK', startMinute: 1100, endMinute: 1110 }] })
    expect(outside.json().error.issues[0].message).toMatch(/not inside a shift/)
    expect((await call('planner', 'POST', '/shift-patterns', { code: '1T', name: 'Again', segments: ONE_SHIFT })).statusCode).toBe(409)
    expect((await call('site1', 'POST', '/shift-patterns', { code: 'S1', name: 'Plant one', segments: ONE_SHIFT })).statusCode).toBe(403)
    expect((await call('site1', 'POST', '/shift-patterns', { companyId: companyA, code: 'S1', name: 'Plant one', segments: ONE_SHIFT })).statusCode).toBe(403)
    expect((await call('viewer', 'POST', '/shift-patterns', { code: 'S1', name: 'Plant one', segments: ONE_SHIFT })).statusCode).toBe(403)
  })

  it('replaces the segments with the version read; a stale version is a conflict', async () => {
    const night = await created('planner', '/shift-patterns', { companyId: companyA, code: 'NIGHT', name: 'Nights', segments: [{ weekday: 1, kind: 'SHIFT', startMinute: 1320, endMinute: 1800 }] })
    ids.night = night.pattern.id
    const segments = weekdays.flatMap((weekday) => [
      { weekday, kind: 'SHIFT', label: 'Night', startMinute: 1320, endMinute: 1800 },
      { weekday, kind: 'BREAK', label: 'Break', startMinute: 1560, endMinute: 1590 },
    ])
    const { pattern } = await ok('planner', 'PUT', `/shift-patterns/${ids.night}/segments`, { version: 1, segments })
    expect([pattern.version, pattern.weeklyMinutes, pattern.shiftEnds, pattern.companyId]).toEqual([2, 5 * 450, ['06:00'], companyA])
    expect((await call('planner', 'PUT', `/shift-patterns/${ids.night}/segments`, { version: 1, segments })).statusCode).toBe(409)
    const { patterns } = await ok('viewer', 'GET', `/shift-patterns?companyId=${companyA}`)
    expect(patterns.map((row: Json) => row.code)).toEqual(['1T', '2T', 'NIGHT'])
    expect((await ok('planner-b', 'GET', '/shift-patterns')).patterns).toEqual([])
  })
})

describe('calendars of a company, a site, a line, a workshop and a supplier (PLT-103, PLN-001)', () => {
  it("makes the company's calendar only with a grant over all its sites, and loads Italy's holidays once", async () => {
    expect((await call('site1', 'POST', '/calendars', { scope: 'COMPANY', ownerId: companyA, shiftPatternId: ids.oneShift })).statusCode).toBe(403)
    const { calendar } = await created('planner', '/calendars', { scope: 'COMPANY', ownerId: companyA, shiftPatternId: ids.oneShift })
    ids.company = calendar.id
    expect([calendar.scope, calendar.companyId, calendar.siteId, calendar.name, calendar.workingWeekdays, calendar.shiftPattern.code, calendar.owner]).toEqual(['COMPANY', companyA, null, 'Calendari Prova S.r.l.', weekdays, '1T', { code: 'CALA', name: 'Calendari Prova S.r.l.' }])
    const loaded = await ok('planner', 'POST', `/calendars/${ids.company}/holidays`, { year: 2026 })
    expect([loaded.added.length, loaded.skipped.length, loaded.calendar.exceptions]).toEqual([12, 0, 12])
    expect(loaded.added.find((day: Json) => day.date === '2026-04-06')).toMatchObject({ kind: 'HOLIDAY', holidaySet: 'IT' })
    const again = await ok('planner', 'POST', `/calendars/${ids.company}/holidays`, { year: 2026 })
    expect([again.added.length, again.skipped.length]).toEqual([0, 12])
    // Audited as a load that found every date set; no event (nothing changed).
    const audits = await admin(`SELECT after FROM "AuditLog" WHERE action = 'calendars.loadHolidays' ORDER BY at`)
    expect(audits.map((row) => [row.after.added.length, row.after.skipped.length])).toEqual([
      [12, 0],
      [0, 12],
    ])
    expect((await admin(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'calendar.changed' AND subject = $1 AND payload->>'change' = 'DAYS_SET'`, [ids.company]))[0]!.n).toBe(1)
  })

  it("a site's planner makes and keeps its site's and lines' calendars, never another site's; one ACTIVE calendar per owner", async () => {
    const { calendar } = await created('site1', '/calendars', { scope: 'SITE', ownerId: site1, name: 'Stabilimento Uno' }, 'site1-calendar-0001')
    ids.site1 = calendar.id
    expect((await created('site1', '/calendars', { scope: 'SITE', ownerId: site1, name: 'Stabilimento Uno' }, 'site1-calendar-0001')).calendar).toEqual(calendar)
    expect([calendar.shiftPattern, calendar.companyId, calendar.siteId]).toEqual([null, companyA, site1])
    expect((await call('site1', 'POST', '/calendars', { scope: 'SITE', ownerId: site2 })).statusCode).toBe(404)
    expect((await call('site1', 'POST', '/calendars', { scope: 'SITE', ownerId: site1 })).statusCode).toBe(409)
    const two = await created('planner', '/calendars', { scope: 'SITE', ownerId: site2 })
    ids.site2 = two.calendar.id
    const line = await created('planner', '/calendars', { scope: 'LINE', ownerId: line3, shiftPatternId: ids.twoShifts })
    ids.line3 = line.calendar.id
    // A plant that works Saturdays: a new workshop calendar starts with the plant's week (the calendar above it).
    const sixDays = await ok('site1', 'PATCH', `/calendars/${ids.site1}`, { version: calendar.version, workingWeekdays: [1, 2, 3, 4, 5, 6] })
    expect(sixDays.calendar.workingWeekdays).toEqual([1, 2, 3, 4, 5, 6])
    const centre = await created('site1', '/calendars', { scope: 'WORK_CENTRE', ownerId: centre1, shiftPatternId: ids.twoShifts })
    expect(centre.calendar.workingWeekdays).toEqual([1, 2, 3, 4, 5, 6])
    await ok('site1', 'PATCH', `/calendars/${ids.site1}`, { version: sixDays.calendar.version, workingWeekdays: [1, 2, 3, 4, 5] })
    await ok('site1', 'PATCH', `/calendars/${centre.calendar.id}`, { version: centre.calendar.version, workingWeekdays: [1, 2, 3, 4, 5] })
    expect([centre.calendar.siteId, centre.calendar.workCentreId, centre.calendar.owner.code]).toEqual([site1, centre1, 'TAGLIO'])
    ids.centre1 = centre.calendar.id
  })

  it("a site's user sees its site's calendars and the company's it reads from, never plant 2's; other tenants see none", async () => {
    const mine = await ok('site1', 'GET', '/calendars')
    expect(mine.calendars.map((row: Json) => row.id).sort()).toEqual([ids.company, ids.site1, ids.centre1].sort())
    expect((await call('site1', 'GET', `/calendars/${ids.site2}`)).statusCode).toBe(404)
    expect((await call('site1', 'GET', `/calendars/${ids.line3}`)).statusCode).toBe(404)
    expect((await ok('viewer', 'GET', '/calendars')).calendars).toHaveLength(5)
    expect((await ok('planner-b', 'GET', '/calendars')).calendars).toEqual([])
    expect((await call('planner-b', 'GET', `/calendars/${ids.company}`)).statusCode).toBe(404)
    expect((await call('nobody', 'GET', '/calendars')).statusCode).toBe(403)
    const read = await ok('site1', 'GET', `/calendars/${ids.centre1}?from=2026-01-01&to=2026-12-31`)
    expect(read.above.map((row: Json) => row.scope)).toEqual(['SITE', 'COMPANY'])
  })

  it("a supplier's calendar is the buyer's; a customer gets none; it keeps no shifts of ours", async () => {
    expect((await call('site1', 'POST', '/calendars', { scope: 'SUPPLIER', ownerId: supplier })).statusCode).toBe(403)
    expect((await call('buyer', 'POST', '/calendars', { scope: 'SUPPLIER', ownerId: customer })).statusCode).toBe(400)
    expect((await call('buyer', 'POST', '/calendars', { scope: 'SUPPLIER', ownerId: supplier, shiftPatternId: ids.oneShift })).statusCode).toBe(400)
    const { calendar } = await created('buyer', '/calendars', { scope: 'SUPPLIER', ownerId: supplier })
    ids.supplier = calendar.id
    expect([calendar.partyId, calendar.companyId, calendar.owner.code]).toEqual([supplier, companyA, 'FORN1'])
    // The buyer keeps no plant calendar.
    expect((await call('buyer', 'POST', `/calendars/${ids.site1}/days`, { from: '2026-06-24', kind: 'HOLIDAY', name: 'Patrono' })).statusCode).toBe(403)
  })
})

describe('days: holidays, closures and extra working days', () => {
  it('sets a holiday and a closure range; a range over days already set is refused, each named, or replaced', async () => {
    const before = (await ok('site1', 'GET', `/calendars/${ids.site1}`)).calendar.version
    const holiday = await ok('site1', 'POST', `/calendars/${ids.site1}/days`, { from: '2026-06-24', kind: 'HOLIDAY', name: 'Santo patrono' }, 200, 'site1-patrono-0001')
    expect([holiday.days.length, holiday.replaced, holiday.calendar.version]).toEqual([1, 0, before + 1])
    // The same key and request: the stored answer, nothing written again.
    const replay = await ok('site1', 'POST', `/calendars/${ids.site1}/days`, { from: '2026-06-24', kind: 'HOLIDAY', name: 'Santo patrono' }, 200, 'site1-patrono-0001')
    expect(replay).toEqual(holiday)
    expect((await call('site1', 'POST', `/calendars/${ids.site1}/days`, { from: '2026-06-25', kind: 'HOLIDAY', name: 'Other' }, 'site1-patrono-0001')).statusCode).toBe(409)
    const closure = await ok('site1', 'POST', `/calendars/${ids.site1}/days`, { version: holiday.calendar.version, from: '2026-08-10', to: '2026-08-21', kind: 'CLOSURE', name: 'August shutdown' })
    expect(closure.days).toHaveLength(12)
    const clash = await call('site1', 'POST', `/calendars/${ids.site1}/days`, { from: '2026-08-20', to: '2026-08-24', kind: 'CLOSURE', name: 'Longer shutdown' })
    expect(clash.statusCode).toBe(409)
    expect(clash.json().error.issues.map((issue: Json) => issue.path)).toEqual(['body/days/2026-08-20', 'body/days/2026-08-21'])
    const replaced = await ok('site1', 'POST', `/calendars/${ids.site1}/days`, { from: '2026-08-20', to: '2026-08-24', kind: 'CLOSURE', name: 'Longer shutdown', replace: true })
    expect([replaced.days.length, replaced.replaced]).toEqual([5, 2])
    expect((await call('site1', 'POST', `/calendars/${ids.site1}/days`, { from: '2026-09-05', kind: 'CLOSURE', name: 'X', shiftPatternId: ids.oneShift })).statusCode).toBe(400)
    expect((await call('site1', 'POST', `/calendars/${ids.site1}/days`, { from: '2026-01-01', to: '2027-01-05', kind: 'CLOSURE', name: 'Too long' })).statusCode).toBe(400)
    expect((await call('site1', 'POST', `/calendars/${ids.site1}/days`, { version: before, from: '2026-09-07', kind: 'CLOSURE', name: 'Stale' })).statusCode).toBe(409)
    const [audit] = await admin(`SELECT before, after FROM "AuditLog" WHERE action = 'calendars.setDays' AND "recordId" = $1 ORDER BY at DESC LIMIT 1`, [ids.site1])
    expect(audit!.before.days).toEqual([{ from: '2026-08-20', to: '2026-08-21', kind: 'CLOSURE', name: 'August shutdown', shiftPatternId: null, note: null, holidaySet: null }])
    expect(audit!.after.days).toEqual([{ from: '2026-08-20', to: '2026-08-24', kind: 'CLOSURE', name: 'Longer shutdown', shiftPatternId: null, note: null, holidaySet: null }])
    const events = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'calendar.changed' AND subject = $1 ORDER BY "occurredAt", id`, [ids.site1])
    expect(events.map((row) => [row.payload.change, row.payload.from, row.payload.to, row.payload.days])).toEqual([
      ['CREATED', null, null, 0],
      ['EDITED', null, null, 0],
      ['EDITED', null, null, 0],
      ['DAYS_SET', '2026-06-24', '2026-06-24', 1],
      ['DAYS_SET', '2026-08-10', '2026-08-21', 12],
      ['DAYS_SET', '2026-08-20', '2026-08-24', 5],
    ])
  })

  it('an extra Saturday with its own pattern on a line, and days taken back', async () => {
    const sat = await created('planner', '/shift-patterns', { code: 'SAT-AM', name: 'Saturday morning', segments: [{ weekday: 6, kind: 'SHIFT', label: 'Morning', startMinute: 480, endMinute: 720 }] })
    ids.saturday = sat.pattern.id
    const { calendar } = await created('site1', '/calendars', { scope: 'LINE', ownerId: line1 })
    ids.line1 = calendar.id
    await ok('site1', 'POST', `/calendars/${ids.line1}/days`, { from: '2026-11-07', kind: 'WORKING', name: 'Extra Saturday', shiftPatternId: ids.saturday, note: 'Catch up' })
    await ok('site1', 'POST', `/calendars/${ids.line1}/days`, { from: '2026-11-14', kind: 'WORKING', name: 'Another Saturday' })
    const removed = await ok('site1', 'POST', `/calendars/${ids.line1}/days/remove`, { from: '2026-11-14', to: '2026-11-30' })
    expect(removed.removed).toEqual(['2026-11-14'])
    expect((await call('site1', 'POST', `/calendars/${ids.line1}/days/remove`, { from: '2026-11-14' })).statusCode).toBe(404)
    const read = await ok('site1', 'GET', `/calendars/${ids.line1}?from=2026-11-01&to=2026-11-30`)
    expect(read.days.map((day: Json) => [day.date, day.kind, day.shiftPattern?.code ?? null, day.note])).toEqual([['2026-11-07', 'WORKING', 'SAT-AM', 'Catch up']])
  })

  it("a supplier's closure across a month end", async () => {
    await ok('buyer', 'POST', `/calendars/${ids.supplier}/days`, { from: '2026-07-27', to: '2026-08-04', kind: 'CLOSURE', name: 'Summer closure' })
    expect((await call('buyer', 'POST', `/calendars/${ids.supplier}/days`, { from: '2026-09-05', kind: 'WORKING', name: 'Saturday', shiftPatternId: ids.saturday })).statusCode).toBe(400)
  })
})

describe('the questions: working time, working minutes, next working day, closed days, order by', () => {
  it("line 1 has its own calendar without a pattern: the company's one shift; the company's holiday and the site's patron saint close it", async () => {
    const week = await ok('site1', 'GET', `/calendars/working-time?lineId=${line1}&from=2026-06-01&to=2026-06-07`)
    expect([week.workingDays, week.minutes]).toEqual([4, 1920])
    expect(week.owner).toMatchObject({ scope: 'LINE', code: 'L1', siteId: site1, timeZone: 'Europe/Rome' })
    expect(week.owner.calendars.map((row: Json) => row.scope)).toEqual(['LINE', 'SITE', 'COMPANY'])
    expect(week.days[1]).toMatchObject({ date: '2026-06-02', reason: 'HOLIDAY', name: 'Festa della Repubblica', decidedBy: { scope: 'COMPANY' } })
    expect(week.days[0]).toMatchObject({ minutes: 480, pattern: { code: '1T', source: 'CALENDAR', calendarId: ids.company }, shifts: [{ start: '2026-06-01T06:00:00.000Z', end: '2026-06-01T15:00:00.000Z', minutes: 480 }] })
    const next = await ok('site1', 'GET', `/calendars/next-working-day?lineId=${line1}&after=2026-06-23`)
    expect(next.date).toBe('2026-06-25')
    const back = await ok('site1', 'GET', `/calendars/next-working-day?lineId=${line1}&after=2026-06-25&days=-1`)
    expect(back.date).toBe('2026-06-23')
    const saturday = await ok('site1', 'GET', `/calendars/working-time?lineId=${line1}&from=2026-11-07&to=2026-11-07`)
    expect(saturday.days[0]).toMatchObject({ reason: 'WORKING', minutes: 240, pattern: { code: 'SAT-AM', source: 'DAY' } })
  })

  it('a workshop on two shifts: a week with the shutdown, and the minutes between two times', async () => {
    const shutdown = await ok('site1', 'GET', `/calendars/working-time?workCentreId=${centre1}&from=2026-08-17&to=2026-08-28`)
    expect([shutdown.workingDays, shutdown.minutes]).toEqual([4, 4 * 930])
    const minutes = await ok('site1', 'GET', `/calendars/working-minutes?workCentreId=${centre1}&from=2026-06-01T08:00:00.000Z&to=2026-06-01T12:00:00.000Z`)
    // 10:00-14:00 local: the morning shift less its 10:00-10:15 break.
    expect(minutes.minutes).toBe(225)
    expect((await call('site1', 'GET', `/calendars/working-time?lineId=${line3}&from=2026-06-01&to=2026-06-07`)).statusCode).toBe(404)
    expect((await call('site1', 'GET', `/calendars/working-time?lineId=${line1}&siteId=${site1}&from=2026-06-01&to=2026-06-07`)).statusCode).toBe(400)
    expect((await call('site1', 'GET', `/calendars/working-time?lineId=${line1}&from=2026-01-01&to=2027-06-01`)).statusCode).toBe(400)
  })

  it("plant 2 has no calendar with days: its line reads the company's; without any calendar the default week", async () => {
    const plant2 = await ok('viewer', 'GET', `/calendars/working-time?siteId=${site2}&from=2026-08-14&to=2026-08-17`)
    expect(plant2.days.map((day: Json) => [day.date, day.reason, day.minutes])).toEqual([
      ['2026-08-14', 'WEEK', 480],
      ['2026-08-15', 'HOLIDAY', 0],
      ['2026-08-16', 'DAY_OFF', 0],
      ['2026-08-17', 'WEEK', 480],
    ])
    const other = await ok('planner-b', 'GET', `/calendars/working-time?companyId=${companyB}&from=2026-06-01&to=2026-06-07`)
    expect([other.workingDays, other.minutes, other.owner.calendars, other.days[1].pattern.source]).toEqual([5, 2400, [], 'DEFAULT'])
  })

  it("a supplier's closed days and the order-by date across them", async () => {
    const closed = await ok('buyer', 'GET', `/calendars/supplier-closed-days?partyId=${supplier}&from=2026-07-01&to=2026-08-31`)
    expect([closed.closedDays.length, closed.spans, closed.weeklyDaysOff, closed.calendar.id]).toEqual([9, [{ from: '2026-07-27', to: '2026-08-04', kind: 'CLOSURE', name: 'Summer closure', days: 9 }], [6, 7], ids.supplier])
    const orderBy = await ok('buyer', 'GET', `/calendars/supplier-order-by?partyId=${supplier}&needDate=2026-08-10&leadTimeDays=14`)
    expect([orderBy.orderBy, orderBy.skipped.length, orderBy.capped]).toEqual(['2026-07-18', 9, false])
    expect((await call('planner-b', 'GET', `/calendars/supplier-closed-days?partyId=${supplier}&from=2026-07-01&to=2026-08-31`)).statusCode).toBe(404)
  })

  it('the service answers other modules the same way, many owners at once', async () => {
    // Another module's read: its own client, no calendar permission asked.
    const caller = callerFor(database, { audience: 'office', tenantId: tenantA, actorId: user, requestId: 'calendars-test', grants: [] })
    const loaded = await caller.withClient((client) =>
      workingCalendarsFor(
        client,
        [
          { scope: 'LINE', id: line1 },
          { scope: 'LINE', id: line3 },
          { scope: 'SITE', id: site2 },
          { scope: 'LINE', id: newId() },
        ],
        { from: '2026-06-01', to: '2026-06-30' },
      ),
    )
    expect([...loaded.keys()].sort()).toEqual([`LINE:${line1}`, `LINE:${line3}`, `SITE:${site2}`].sort())
    expect(loaded.get(`LINE:${line3}`)!.calendar.layers.map((layer) => layer.scope)).toEqual(['LINE', 'SITE', 'COMPANY'])
    const minutes = await caller.withClient((client) => workingMinutesFor(client, { scope: 'LINE', id: line3 }, new Date('2026-06-01T04:00:00Z'), new Date('2026-06-02T04:00:00Z')))
    expect(minutes.minutes).toBe(930)
    // Ten working days after 31 July: five in the first week of August, then the plant's shutdown (10 to 24 August,
    // Ferragosto inside it) is skipped.
    const tenth = await caller.withClient((client) => addWorkingDaysFor(client, { scope: 'LINE', id: line1 }, '2026-07-31', 10))
    expect(tenth.date).toBe('2026-08-31')
    const arrival = await caller.withClient((client) => supplierArrivalFor(client, supplier, '2026-07-20', 14))
    expect(arrival.walk.date).toBe('2026-08-12')
  })
})

describe('edit and archive', () => {
  it('edits the working week and pattern with the version read; a stale one is a conflict', async () => {
    const { calendar } = await ok('site1', 'GET', `/calendars/${ids.line1}`)
    const edited = await ok('site1', 'PATCH', `/calendars/${ids.line1}`, { version: calendar.version, workingWeekdays: [6, 1, 2, 3, 4, 5, 5], shiftPatternId: ids.twoShifts })
    expect([edited.calendar.workingWeekdays, edited.calendar.shiftPattern.code]).toEqual([[1, 2, 3, 4, 5, 6], '2T'])
    expect((await call('site1', 'PATCH', `/calendars/${ids.line1}`, { version: calendar.version, name: 'Late' })).statusCode).toBe(409)
    expect((await call('site1', 'PATCH', `/calendars/${ids.line1}`, { version: edited.calendar.version, shiftPatternId: ids.night })).statusCode).toBe(200)
  })

  it('a pattern in use is not archived; an archived calendar is kept and changes no more; the owner gets a new one', async () => {
    const pattern = (await ok('planner', 'GET', `/shift-patterns/${ids.twoShifts}`)).pattern
    const refused = await call('planner', 'POST', `/shift-patterns/${ids.twoShifts}/archive`, { version: pattern.version })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error.issues.length).toBeGreaterThan(0)
    const { calendar } = await ok('planner', 'GET', `/calendars/${ids.line3}`)
    const archived = await ok('planner', 'POST', `/calendars/${ids.line3}/archive`, { version: calendar.version, reason: 'Line moved' }, 200, 'line3-archive-0001')
    expect(archived.calendar.status).toBe('ARCHIVED')
    expect(await ok('planner', 'POST', `/calendars/${ids.line3}/archive`, { version: calendar.version, reason: 'Line moved' }, 200, 'line3-archive-0001')).toEqual(archived)
    expect((await call('planner', 'POST', `/calendars/${ids.line3}/archive`, { version: archived.calendar.version })).statusCode).toBe(409)
    expect((await call('planner', 'POST', `/calendars/${ids.line3}/days`, { from: '2026-09-01', kind: 'CLOSURE', name: 'X' })).statusCode).toBe(409)
    const fresh = await created('planner', '/calendars', { scope: 'LINE', ownerId: line3 })
    expect(fresh.calendar.status).toBe('ACTIVE')
    const listed = await ok('viewer', 'GET', `/calendars?scope=LINE&includeArchived=true`)
    expect(listed.calendars.filter((row: Json) => row.lineId === line3).map((row: Json) => row.status).sort()).toEqual(['ACTIVE', 'ARCHIVED'])
    const sat = (await ok('planner', 'GET', `/shift-patterns/${ids.saturday}`)).pattern
    const gone = await ok('planner', 'POST', `/shift-patterns/${ids.saturday}/archive`, { version: sat.version })
    expect(gone.pattern.status).toBe('ARCHIVED')
    // A WORKING day that names it still counts (the pattern is kept), but no new use.
    expect((await call('site1', 'POST', `/calendars/${ids.line1}/days`, { from: '2026-11-21', kind: 'WORKING', name: 'Sat', shiftPatternId: ids.saturday })).statusCode).toBe(400)
  })
})
