import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { callerFor } from '../../core/command'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { supplierCalendarsFor } from './service'

/**
 * B-W2b-20 (B-W2a-08 and B-W2a-59 gaps; B-W2b-03's column) through the app's real routes on a throwaway PostgreSQL 17
 * database from the migrations (the runtime login: row-level security is real): one closure on several calendars in
 * one command (an owner without a calendar gets one), the days of an archived calendar copied into its successor, and
 * a supplier calendar's own time zone. Made-up names and codes only. Run with
 * `node scripts/factory/run-pg-tests.mjs platform/calendars`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const tenant = newId()
const company = newId()
const site1 = newId()
const site2 = newId()
const line1 = newId()
const line2 = newId()
const supplier = newId()
const supplier2 = newId()
const user = newId()

const grant = (permissions: Grant['permissions'], scope: Partial<Grant> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })
const KEEP = ['calendars.view', 'calendars.manage', 'calendars.suppliers.manage'] as const
const SESSIONS: Record<string, SessionContext> = {
  planner: { audience: 'office', tenantId: tenant, actorId: user, grants: [grant(KEEP)] },
  // A planner of plant 1 only: it sees the company's calendar (its site reads from it) but cannot keep it.
  site1: { audience: 'office', tenantId: tenant, actorId: user, grants: [grant(['calendars.view', 'calendars.manage'], { companies: [company], sites: [site1] })] },
  buyer: { audience: 'office', tenantId: tenant, actorId: user, grants: [grant(['calendars.view', 'calendars.suppliers.manage'])] },
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
const daysOf = async (calendarId: string) => (await admin<{ date: string }>(`SELECT to_char(date, 'YYYY-MM-DD') AS date FROM "CalendarDay" WHERE "calendarId" = $1 ORDER BY date`, [calendarId])).map((row) => row.date)
const versionOf = async (calendarId: string) => (await admin<{ version: number }>('SELECT version FROM "WorkCalendar" WHERE id = $1', [calendarId]))[0]!.version

const ids: Record<string, string> = {}

beforeAll(async () => {
  db = await migratedDatabase('calendars_w2b')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenant, 'cal-w2b'])
  await admin(`INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, 'CALW', 'Calendari Nuovi S.r.l.')`, [company, tenant])
  await admin(`INSERT INTO "Site" (id, "tenantId", "companyId", code, name, kind) VALUES ($1, $3, $4, 'P1', 'Stabilimento Uno', 'PLANT'), ($2, $3, $4, 'P2', 'Stabilimento Due', 'PLANT')`, [site1, site2, tenant, company])
  await admin(`INSERT INTO "Line" (id, "tenantId", "companyId", "siteId", code, name) VALUES ($1, $3, $4, $5, 'L1', 'Linea 1'), ($2, $3, $4, $5, 'L2', 'Linea 2')`, [line1, line2, tenant, company, site1])
  await admin(
    `INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", roles) VALUES ($1, $3, $4, 'FORN-PK', 'ORGANISATION', 'Tannery Example Pvt', '{SUPPLIER}'), ($2, $3, $4, 'FORN-IT', 'ORGANISATION', 'Fornitore Esempio S.r.l.', '{SUPPLIER}')`,
    [supplier, supplier2, tenant, company],
  )
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
  ids.company = (await created('planner', '/calendars', { scope: 'COMPANY', ownerId: company })).calendar.id
  ids.site1 = (await created('planner', '/calendars', { scope: 'SITE', ownerId: site1, workingWeekdays: [1, 2, 3, 4, 5, 6] })).calendar.id
  ids.site2 = (await created('planner', '/calendars', { scope: 'SITE', ownerId: site2 })).calendar.id
}, 60_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('one closure on several calendars in one command (B-W2a-59 gap)', () => {
  it('closes a site and a line without a calendar of its own: the line gets one, with the site\'s week', async () => {
    const before = await versionOf(ids.site1!)
    const body = { targets: [{ calendarId: ids.site1 }, { scope: 'LINE', ownerId: line1 }], from: '2026-08-10', to: '2026-08-14', kind: 'CLOSURE', name: 'August shutdown', note: 'Whole plant' }
    const answer = await ok('planner', 'POST', '/calendars/days', body, 200, 'closure-many-0001')
    expect(answer.calendars.map((entry: Json) => [entry.calendar.scope, entry.days.length, entry.replaced, entry.created])).toEqual([
      ['SITE', 5, 0, false],
      ['LINE', 5, 0, true],
    ])
    ids.line1 = answer.calendars[1].calendar.id
    expect([answer.calendars[1].calendar.lineId, answer.calendars[1].calendar.workingWeekdays, answer.calendars[1].calendar.name]).toEqual([line1, [1, 2, 3, 4, 5, 6], 'Linea 1'])
    expect(answer.calendars[0].calendar.version).toBe(before + 1)
    expect(answer.calendars[0].days[0]).toMatchObject({ date: '2026-08-10', kind: 'CLOSURE', name: 'August shutdown', note: 'Whole plant' })
    // The same key and request: the stored answer, nothing written again.
    expect(await ok('planner', 'POST', '/calendars/days', body, 200, 'closure-many-0001')).toEqual(answer)
    const audits = await admin(`SELECT action, "recordId", after FROM "AuditLog" WHERE action IN ('calendars.setDays', 'calendars.create') AND "recordId" = ANY($1::uuid[]) ORDER BY at, id`, [[ids.site1, ids.line1]])
    expect(audits.filter((row) => row.action === 'calendars.setDays').map((row) => [row.recordId, row.after.days, row.after.calendars])).toEqual([
      [ids.site1, [{ from: '2026-08-10', to: '2026-08-14', kind: 'CLOSURE', name: 'August shutdown', shiftPatternId: null, note: 'Whole plant', holidaySet: null }], 2],
      [ids.line1, [{ from: '2026-08-10', to: '2026-08-14', kind: 'CLOSURE', name: 'August shutdown', shiftPatternId: null, note: 'Whole plant', holidaySet: null }], 2],
    ])
    // The site's calendar was made before (POST /calendars); the line's by the closure.
    expect(audits.filter((row) => row.action === 'calendars.create').map((row) => row.recordId)).toEqual([ids.site1, ids.line1])
    const events = await admin(`SELECT subject, payload FROM "OutboxEvent" WHERE type = 'calendar.changed' AND subject = ANY($1::text[]) ORDER BY "occurredAt", id`, [[ids.site1, ids.line1]])
    expect(events.map((row) => [row.subject, row.payload.change, row.payload.from, row.payload.days])).toEqual([
      [ids.site1, 'CREATED', null, 0],
      [ids.line1, 'CREATED', null, 0],
      [ids.site1, 'DAYS_SET', '2026-08-10', 5],
      [ids.line1, 'DAYS_SET', '2026-08-10', 5],
    ])
  })

  it('days already set on any calendar refuse the whole closure, each named per target; replace takes them', async () => {
    const body = { targets: [{ calendarId: ids.site1 }, { scope: 'LINE', ownerId: line1 }, { calendarId: ids.site2 }], from: '2026-08-13', to: '2026-08-17', kind: 'CLOSURE', name: 'Longer shutdown' }
    const clash = await call('planner', 'POST', '/calendars/days', body)
    expect(clash.statusCode).toBe(409)
    expect(clash.json().error.code).toBe('conflict')
    expect(clash.json().error.issues.map((issue: Json) => issue.path)).toEqual(['body/targets/0/days/2026-08-13', 'body/targets/0/days/2026-08-14', 'body/targets/1/days/2026-08-13', 'body/targets/1/days/2026-08-14'])
    expect(clash.json().error.message).toMatch(/4 days .* on 2 calendars/)
    expect(await daysOf(ids.site2!)).toEqual([])
    const replaced = await ok('planner', 'POST', '/calendars/days', { ...body, replace: true })
    expect(replaced.calendars.map((entry: Json) => [entry.days.length, entry.replaced, entry.created])).toEqual([
      [5, 2, false],
      [5, 2, false],
      [5, 0, false],
    ])
    expect(await daysOf(ids.site2!)).toEqual(['2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16', '2026-08-17'])
  })

  it('refuses a calendar the person may not keep (403 naming it), nothing written; a stale version; one calendar twice', async () => {
    const before = await versionOf(ids.site1!)
    const refused = await call('site1', 'POST', '/calendars/days', { targets: [{ calendarId: ids.site1 }, { calendarId: ids.company }], from: '2026-09-07', kind: 'HOLIDAY', name: 'Fiera' })
    expect(refused.statusCode).toBe(403)
    expect(refused.json().error.message).toMatch(/^Target 2 \(Calendari Nuovi S\.r\.l\.\): .*every site of the company/)
    expect(await versionOf(ids.site1!)).toBe(before)
    expect((await daysOf(ids.site1!)).includes('2026-09-07')).toBe(false)
    // Another plant's calendar is not even seen by plant 1's planner.
    expect((await call('site1', 'POST', '/calendars/days', { targets: [{ calendarId: ids.site2 }], from: '2026-09-07', kind: 'HOLIDAY', name: 'Fiera' })).statusCode).toBe(404)
    const stale = await call('planner', 'POST', '/calendars/days', { targets: [{ calendarId: ids.site1, version: before - 1 }, { calendarId: ids.site2 }], from: '2026-09-07', kind: 'HOLIDAY', name: 'Fiera' })
    expect(stale.statusCode).toBe(409)
    expect((await daysOf(ids.site2!)).includes('2026-09-07')).toBe(false)
    const named = await call('planner', 'POST', '/calendars/days', { targets: [{ calendarId: ids.site1 }, { calendarId: ids.site1 }], from: '2026-09-07', kind: 'HOLIDAY', name: 'Fiera' })
    expect([named.statusCode, named.json().error.issues[0].path]).toEqual([400, 'body/targets/1'])
    const same = await call('planner', 'POST', '/calendars/days', { targets: [{ calendarId: ids.line1 }, { scope: 'LINE', ownerId: line1 }], from: '2026-09-07', kind: 'HOLIDAY', name: 'Fiera' })
    expect([same.statusCode, same.json().error.issues[0].path]).toEqual([400, 'body/targets/1'])
    const shape = await call('planner', 'POST', '/calendars/days', { targets: [{ calendarId: ids.site1 }], from: '2026-09-07', kind: 'CLOSURE', name: 'X', shiftPatternId: newId() })
    expect([shape.statusCode, shape.json().error.issues[0].path]).toEqual([400, 'body/targets/0/shiftPatternId'])
  })
})

describe('copying the days of an archived calendar into its successor (B-W2a-08 gap)', () => {
  it('copies each day as it was; a day whose pattern is archived is skipped and named', async () => {
    const sat = await created('planner', '/shift-patterns', { code: 'SAT', name: 'Saturday', segments: [{ weekday: 6, kind: 'SHIFT', label: 'Morning', startMinute: 480, endMinute: 720 }] })
    const old = await created('planner', '/shift-patterns', { code: 'SAT-OLD', name: 'Old Saturday', segments: [{ weekday: 6, kind: 'SHIFT', label: 'Morning', startMinute: 420, endMinute: 660 }] })
    const source = (await created('planner', '/calendars', { scope: 'LINE', ownerId: line2 })).calendar
    await ok('planner', 'POST', `/calendars/${source.id}/holidays`, { year: 2026 })
    await ok('planner', 'POST', `/calendars/${source.id}/days`, { from: '2026-12-12', kind: 'WORKING', name: 'Extra Saturday', shiftPatternId: sat.pattern.id, note: 'Catch up' })
    await ok('planner', 'POST', `/calendars/${source.id}/days`, { from: '2026-12-19', kind: 'WORKING', name: 'Old Saturday', shiftPatternId: old.pattern.id })
    await ok('planner', 'POST', `/shift-patterns/${old.pattern.id}/archive`, { version: old.pattern.version })
    const archived = (await ok('planner', 'POST', `/calendars/${source.id}/archive`, { version: (await ok('planner', 'GET', `/calendars/${source.id}`)).calendar.version, reason: 'Line moved to two shifts' })).calendar
    expect(archived.status).toBe('ARCHIVED')
    const successor = (await created('planner', '/calendars', { scope: 'LINE', ownerId: line2 })).calendar
    ids.line2 = successor.id
    const copy = await ok('planner', 'POST', `/calendars/${successor.id}/copy-days`, { version: successor.version, fromCalendarId: source.id, from: '2026-12-01', to: '2026-12-31' }, 200, 'copy-line2-0001')
    expect(copy.days.map((day: Json) => [day.date, day.kind, day.holidaySet, day.shiftPattern?.code ?? null, day.note])).toEqual([
      ['2026-12-08', 'HOLIDAY', 'IT', null, null],
      ['2026-12-12', 'WORKING', null, 'SAT', 'Catch up'],
      ['2026-12-25', 'HOLIDAY', 'IT', null, null],
      ['2026-12-26', 'HOLIDAY', 'IT', null, null],
    ])
    expect(copy.skipped).toEqual([{ date: '2026-12-19', name: 'Old Saturday', reason: 'PATTERN_ARCHIVED', words: '2026-12-19 (Old Saturday) is not copied: its shift pattern is archived.' }])
    expect([copy.replaced, copy.calendar.version, copy.calendar.exceptions]).toEqual([0, successor.version + 1, 4])
    expect(await ok('planner', 'POST', `/calendars/${successor.id}/copy-days`, { version: successor.version, fromCalendarId: source.id, from: '2026-12-01', to: '2026-12-31' }, 200, 'copy-line2-0001')).toEqual(copy)
    const [audit] = await admin(`SELECT before, after FROM "AuditLog" WHERE action = 'calendars.copyDays' AND "recordId" = $1`, [successor.id])
    expect([audit!.after.fromCalendarId, audit!.after.from, audit!.after.to, audit!.after.days.length, audit!.after.skipped, audit!.before.days]).toEqual([source.id, '2026-12-01', '2026-12-31', 4, [{ date: '2026-12-19', reason: 'PATTERN_ARCHIVED' }], []])
    const [event] = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'calendar.changed' AND subject = $1 AND payload->>'change' = 'DAYS_SET'`, [successor.id])
    expect([event!.payload.from, event!.payload.to, event!.payload.days]).toEqual(['2026-12-08', '2026-12-26', 4])
  })

  it('dates already set refuse the copy, each named, unless replaced; a calendar never copies itself or a supplier\'s', async () => {
    const source = (await ok('planner', 'GET', `/calendars?scope=LINE&includeArchived=true`)).calendars.find((row: Json) => row.lineId === line2 && row.status === 'ARCHIVED')
    const clash = await call('planner', 'POST', `/calendars/${ids.line2}/copy-days`, { fromCalendarId: source.id, from: '2026-12-01', to: '2026-12-31' })
    expect(clash.statusCode).toBe(409)
    expect(clash.json().error.issues.map((issue: Json) => issue.path)).toEqual(['body/days/2026-12-08', 'body/days/2026-12-12', 'body/days/2026-12-25', 'body/days/2026-12-26'])
    const replaced = await ok('planner', 'POST', `/calendars/${ids.line2}/copy-days`, { fromCalendarId: source.id, from: '2026-12-01', to: '2026-12-31', replace: true })
    expect([replaced.days.length, replaced.replaced]).toEqual([4, 4])
    expect((await call('planner', 'POST', `/calendars/${ids.line2}/copy-days`, { fromCalendarId: ids.line2 })).statusCode).toBe(400)
    const supplierCalendar = (await created('buyer', '/calendars', { scope: 'SUPPLIER', ownerId: supplier2 })).calendar
    await ok('buyer', 'POST', `/calendars/${supplierCalendar.id}/days`, { from: '2026-12-24', to: '2027-01-06', kind: 'CLOSURE', name: 'Winter closure' })
    const mixed = await call('planner', 'POST', `/calendars/${ids.line2}/copy-days`, { fromCalendarId: supplierCalendar.id })
    expect([mixed.statusCode, mixed.json().error.issues[0].path]).toEqual([400, 'body/fromCalendarId'])
    expect((await call('planner', 'POST', `/calendars/${ids.line2}/copy-days`, { fromCalendarId: source.id, from: '2027-02-01', to: '2027-02-28' })).statusCode).toBe(404)
    expect((await call('planner', 'POST', `/calendars/${ids.line2}/copy-days`, { fromCalendarId: source.id, from: '2026-01-01', to: '2028-06-01' })).statusCode).toBe(400)
    // The buyer keeps no line calendar.
    expect((await call('buyer', 'POST', `/calendars/${ids.line2}/copy-days`, { fromCalendarId: source.id })).statusCode).toBe(403)
  })
})

describe("a supplier calendar's own time zone (B-W2b-03's column)", () => {
  it("is kept only on a supplier's calendar and only for a zone we know; the questions say the date there", async () => {
    const { calendar } = await created('buyer', '/calendars', { scope: 'SUPPLIER', ownerId: supplier, timeZone: 'Asia/Karachi' })
    expect([calendar.timeZone, calendar.scope]).toEqual(['Asia/Karachi', 'SUPPLIER'])
    ids.supplier = calendar.id
    const site = await call('planner', 'PATCH', `/calendars/${ids.site1}`, { version: await versionOf(ids.site1!), timeZone: 'Europe/Rome' })
    expect([site.statusCode, site.json().error.issues[0].path]).toEqual([400, 'body/timeZone'])
    expect((await call('planner', 'POST', '/calendars', { scope: 'LINE', ownerId: newId(), timeZone: 'Europe/Rome' })).statusCode).toBe(404)
    const unknown = await call('buyer', 'PATCH', `/calendars/${ids.supplier}`, { version: calendar.version, timeZone: 'Mars/Olympus' })
    expect([unknown.statusCode, unknown.json().error.issues[0].path]).toEqual([400, 'body/timeZone'])
    const cleared = await ok('buyer', 'PATCH', `/calendars/${ids.supplier}`, { version: calendar.version, timeZone: null })
    expect(cleared.calendar.timeZone).toBeNull()
    const again = await ok('buyer', 'PATCH', `/calendars/${ids.supplier}`, { version: cleared.calendar.version, timeZone: 'Asia/Karachi' })
    expect(again.calendar.timeZone).toBe('Asia/Karachi')
    const [audit] = await admin(`SELECT before, after FROM "AuditLog" WHERE action = 'calendars.edit' AND "recordId" = $1 ORDER BY at DESC LIMIT 1`, [ids.supplier])
    expect([audit!.before.timeZone, audit!.after.timeZone]).toEqual([null, 'Asia/Karachi'])
    await ok('buyer', 'POST', `/calendars/${ids.supplier}/days`, { from: '2026-07-27', to: '2026-08-04', kind: 'CLOSURE', name: 'Summer closure' })

    const orderBy = await ok('buyer', 'GET', `/calendars/supplier-order-by?partyId=${supplier}&needDate=2026-08-10&leadTimeDays=14`)
    expect([orderBy.orderBy, orderBy.timeZone, orderBy.skipped.length]).toEqual(['2026-07-18', 'Asia/Karachi', 9])
    // The order-by day ends at midnight in Karachi (UTC+5): 19:00 UTC the same day.
    expect(orderBy.orderByEndsAt).toBe('2026-07-18T19:00:00.000Z')
    expect(orderBy.supplierToday).toBe(businessDate(new Date(), 'Asia/Karachi'))
    const closed = await ok('buyer', 'GET', `/calendars/supplier-closed-days?partyId=${supplier}&from=2026-07-01&to=2026-08-31`)
    expect([closed.timeZone, closed.closedDays.length]).toEqual(['Asia/Karachi', 9])
    // A supplier with a calendar but no zone of its own, and the service other modules call: Europe/Rome.
    const italian = await ok('buyer', 'GET', `/calendars/supplier-order-by?partyId=${supplier2}&needDate=2026-08-10&leadTimeDays=14`)
    expect([italian.timeZone, italian.orderByEndsAt]).toEqual(['Europe/Rome', '2026-07-27T22:00:00.000Z'])
    const caller = callerFor(database, { audience: 'office', tenantId: tenant, actorId: user, requestId: 'calendars-w2b-test', grants: [] })
    const loaded = await caller.withClient((client) => supplierCalendarsFor(client, [supplier, supplier2], { from: '2026-07-01', to: '2026-08-31' }))
    expect([loaded.get(supplier)!.timeZone, loaded.get(supplier2)!.timeZone, loaded.get(supplier)!.calendar!.timeZone]).toEqual(['Asia/Karachi', 'Europe/Rome', 'Asia/Karachi'])
  })
})
