import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { localInstant, plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { lulCalendar } from '@nexus/factory-domain/people/close/lul'
import { closePhrases, lulDueBy } from '@nexus/factory-domain/people/close/rules'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedLabour } from '../../../../../../packages/factory-db/seed/labour'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../../adapters/local-files/local'
import { callerFor } from '../../../core/command'
import { pdfFlatText } from '../../../platform/documents/testing/pdf-text'
import { createFilesRuntime, useFiles } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { systemContext } from '../../../platform/outbox/system'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'
import { grant, HR, keysOf, openWorld, pathsOf, ROME, type Json, type World } from '../overtime/testing'
import { lulFactsOf } from './close'
import { renderLulPdf } from './lul-pdf'
import { placeOf, closeOfMonth } from './store'

/**
 * The month close, the LUL calendar, corrections and the attendance report (B-W2b-48; MES-231, MES-236, MES-303) through the
 * app's real routes on a throwaway PostgreSQL 17 (the runtime login: row-level security, the grants and the
 * …_time_w2b_guards are real; a local file store, FAKE R2). Every name and value is made up; the month is the latest whole
 * month the seeds left empty, counted from the clock.
 *
 * The law the tests name: D.L. 112/2008 art. 39 — the calendar of presence, by the end of the following month; Statuto dei
 * Lavoratori (L. 300/1970) art. 4 c.2-3 — nothing of a person is read or written while the site's ATTENDANCE gate is off;
 * Owner answers W1 (no name or one person's figure in a list, filter or total) and P1 (a typed phrase for the final month
 * close); D.Lgs. 152/1997 art. 1-bis — a person decides, never about themselves. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/people/close`.
 */

let w: World
let redis: TestRedis
let connection: Redis
let filesRoot: string
let M: string
let D: string
let D1: string
let D2: string
let closeId: string

const NS = 'w2b48-close'
const SITE_A2 = newId()
const local = (hhmm: string, date = D): Date => {
  const [hour, minute] = hhmm.split(':').map(Number)
  return localInstant(date, hour! * 60 + minute!, ROME)
}
const panelUrl = (month = M) => `/people/month-close?companyId=${w.T.companyA}&month=${month}`
const reportUrl = (more = '') => `/people/reports/attendance?siteId=${w.T.siteA1}&month=${M}${more}`
const phrase = (month = M) => closePhrases(month).en
const count = async (sql: string, values: unknown[]): Promise<number> => (await w.admin<{ n: number }>(`SELECT count(*)::int AS n ${sql}`, values))[0]!.n

async function freeMonth(before = `${businessDate(new Date(), ROME).slice(0, 7)}-01`): Promise<string> {
  let day = plusDays(before, -1)
  for (;;) {
    const month = day.slice(0, 7)
    const taken = await count(`FROM (SELECT "companyId", date FROM "AttendanceDay" UNION ALL SELECT "companyId", date FROM "RosterEntry" UNION ALL SELECT "companyId", month FROM "AttendanceMonthClose") r WHERE to_char(date, 'YYYY-MM') = $1`, [month])
    if (taken === 0) return month
    day = plusDays(`${month}-01`, -1)
  }
}

async function openGate(): Promise<void> {
  const { T } = w
  const notice = (await w.admin<{ id: string }>(`SELECT id FROM "PrivacyNotice" WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = 'WORKER_FLOOR' AND status = 'PUBLISHED'`, [T.tenant, T.companyA]))[0]!.id
  const dpia = (await w.admin<{ id: string }>(`SELECT id FROM "PrivacyDpia" WHERE "tenantId" = $1 AND "companyId" = $2 AND status = 'STORED'`, [T.tenant, T.companyA]))[0]!.id
  await w.admin(
    `INSERT INTO "PeopleLegalGate" (id, "tenantId", "companyId", "siteId", purpose, basis, "basisReference", "noticeId", "dpiaId", "switchedOnAt", "switchedOnById", "updatedAt")
     VALUES ($1, $2, $3, $4, 'ATTENDANCE', 'NOT_REQUIRED', 'SAMPLE - made-up counsel opinion (art. 4 c.2)', $5, $6, $8, $7, now())`,
    [newId(), T.tenant, T.companyA, T.siteA1, notice, dpia, T.actor, local('00:00', plusDays(D, -150))],
  )
}

/**
 * The scheduler's pass computes the day and the one after it. Everyone else rests on both, and the people working rest on the
 * second: a default shift would otherwise make a day of its own, in some months and not in others (the seeded shutdown).
 */
async function restOthers(date: string, working: readonly string[]): Promise<void> {
  const everyone = (await w.admin<{ id: string }>(`SELECT id FROM "Employee" WHERE "tenantId" = $1 AND "siteId" = $2`, [w.T.tenant, w.T.siteA1])).map((row) => row.id)
  for (const id of everyone) {
    if (!working.includes(id)) await w.roster(id, date, null)
    await w.roster(id, plusDays(date, 1), null)
  }
}

const itemOf = (panel: Json, item: string): Json => (panel.checklist as Json[]).find((entry) => entry.item === item)!
const dayUrl = (id: string) => `/people/attendance/days/${id}`
const approve = async (employeeId: string, date = D): Promise<void> => {
  const day = await w.day(employeeId, date)
  await w.ok('hr', 'POST', `${dayUrl(day.id)}/approve`, { version: day.version })
}
async function bytesOf(url: string): Promise<Buffer> {
  const response = await w.app.inject({ method: 'GET', url })
  expect(response.statusCode, response.body).toBe(200)
  return response.rawPayload
}

beforeAll(async () => {
  w = await openWorld('w2b48_close', NS, (T) => ({
    closer: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant([...HR, 'people.attendance.close', 'people.attendance.correct', 'people.attendance.lul', 'production.labour.view', 'production.labour.close', 'production.labour.reopen'])] },
    corrector: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant([...HR, 'people.attendance.correct'])] },
    // The seed actor, with the right to correct: linked below to P1's record, so P1's day is their own.
    selfCorrector: { audience: 'office', tenantId: T.tenant, actorId: T.actor, grants: [grant([...HR, 'people.attendance.correct'])] },
    filesOnly: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['files.read', 'files.manage', 'people.attendance.view'])] },
    oneSite: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [{ permissions: [...HR, 'people.attendance.close'], companies: [T.companyA], sites: [T.siteA1], parties: 'all' }] },
  }))
  redis = testRedis()
  connection = redis.connect()
  filesRoot = mkdtempSync(join(tmpdir(), 'factory-close-files-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: filesRoot, environment: 'test' }) }))
  M = await freeMonth()
  D = `${M}-10`
  D1 = plusDays(D, 1)
  D2 = plusDays(D, 2)
  const { P, roster, clock } = w
  // A second site of the company, attendance off and no day of this month there: it holds nothing, but a close is the company's.
  await w.admin(`INSERT INTO "Site" (id, "tenantId", "companyId", code, name, kind) VALUES ($1, $2, $3, 'A2-CLOSE', 'Made-up second plant', 'PLANT')`, [SITE_A2, w.T.tenant, w.T.companyA])
  await restOthers(D, Object.values(P))
  // P1: a clean morning. P2: two hours over. P3: planned, nobody came. P4: forgot to clock out.
  await roster(P.P1!, D, [360, 840])
  await clock(P.P1!, 'IN', local('06:00'))
  await clock(P.P1!, 'OUT', local('14:00'))
  await roster(P.P2!, D, [360, 840])
  await clock(P.P2!, 'IN', local('06:00'))
  await clock(P.P2!, 'OUT', local('16:00'))
  await roster(P.P3!, D, [360, 840])
  await roster(P.P4!, D, [360, 840])
  await clock(P.P4!, 'IN', local('06:00'))
}, 600_000)

afterAll(async () => {
  useFiles(undefined)
  await w?.close()
  await connection?.quit()
  await redis?.cleanup()
  if (filesRoot) rmSync(filesRoot, { recursive: true, force: true })
}, 60_000)

describe('the legal gate: nothing is read or closed while ATTENDANCE is off (Statuto dei Lavoratori art. 4 c.2-3)', () => {
  it('refuses every read in words', async () => {
    for (const url of [panelUrl(), `/people/month-close/months?companyId=${w.T.companyA}`, reportUrl(), `/people/reports/attendance/production?siteId=${w.T.siteA1}&month=${M}`, `/people/reports/attendance/people/${w.P.P1}?month=${M}`]) {
      const error = await w.no('closer', 'GET', url, undefined, 409)
      expect(pathsOf(error)).toContain('gate/ATTENDANCE')
      expect(error.message).toContain('Statuto dei Lavoratori art. 4')
    }
  })

  it('closes nothing', async () => {
    expect(pathsOf(await w.no('closer', 'POST', '/people/month-close', { companyId: w.T.companyA, month: M, phrase: phrase() }, 409))).toContain('gate/ATTENDANCE')
    expect(await count(`FROM "AttendanceMonthClose" WHERE "companyId" = $1 AND month = $2::date`, [w.T.companyA, `${M}-01`])).toBe(0)
  })
})

describe('the checklist', () => {
  beforeAll(async () => {
    await openGate()
    await w.pass(D)
    await w.compute(w.P.P2!, D)
  })

  it('counts what blocks the close, says the deadline and holds the close', async () => {
    const panel = await w.ok('viewer', 'GET', panelUrl())
    expect(panel).toMatchObject({ state: 'OPEN', closeId: null, monthOver: true, corrections: 0, seal: null, actions: { close: false, seal: false, openLul: false } })
    expect(panel.due.by).toBe(lulDueBy(M))
    expect(panel.due.words).toContain(lulDueBy(M))
    expect(panel.days).toBe(4)
    expect(panel.sites.find((site: Json) => site.siteId === w.T.siteA1)).toMatchObject({ gateOpen: true })
    expect(itemOf(panel, 'DAYS_APPROVED')).toMatchObject({ left: 4, done: false })
    expect(itemOf(panel, 'ANOMALIES_CLEARED').left).toBeGreaterThanOrEqual(1)
    expect(itemOf(panel, 'ABSENCE_CODES')).toMatchObject({ left: 1 })
    expect(itemOf(panel, 'OVERTIME_DECIDED')).toMatchObject({ left: 1 })
    expect(itemOf(panel, 'PRODUCTION_DAYS')).toMatchObject({ left: 0, done: true })
    expect(panel.holds.map((hold: Json) => hold.code)).toEqual(expect.arrayContaining(['DAYS_APPROVED', 'ANOMALIES_CLEARED', 'ABSENCE_CODES', 'OVERTIME_DECIDED']))
    expect(panel.confirm.phrases.en).toBe(phrase())
    expect(panel.toConfirm.join(' ')).toContain('layout')
    expect(JSON.stringify(panel)).not.toContain('(made up)')
  })

  it('does not close a month that is not over', async () => {
    const month = businessDate(new Date(), ROME).slice(0, 7)
    const panel = await w.ok('viewer', 'GET', panelUrl(month))
    expect(panel.monthOver).toBe(false)
    expect(panel.holds.map((hold: Json) => hold.code)).toContain('MONTH_NOT_OVER')
  })

  it('needs the phrase typed, the permission, and a grant over every site of the company', async () => {
    expect(pathsOf(await w.no('closer', 'POST', '/people/month-close', { companyId: w.T.companyA, month: M, phrase: 'close it' }, 400))).toContain('body/phrase')
    await w.no('hr', 'POST', '/people/month-close', { companyId: w.T.companyA, month: M, phrase: phrase() }, 403)
    await w.no('companyB', 'GET', panelUrl(), undefined, 404)
    await w.no('oneSite', 'GET', panelUrl(), undefined, 404)
  })

  it('refuses the close while anything is left, listing every hold, and changes nothing', async () => {
    const error = await w.no('closer', 'POST', '/people/month-close', { companyId: w.T.companyA, month: M, phrase: phrase() }, 409)
    expect(pathsOf(error)).toEqual(expect.arrayContaining(['refusal/HELD', 'holds/DAYS_APPROVED', 'holds/ANOMALIES_CLEARED', 'holds/ABSENCE_CODES', 'holds/OVERTIME_DECIDED']))
    expect(await count(`FROM "AttendanceDay" WHERE "companyId" = $1 AND status = 'CLOSED' AND date = $2::date`, [w.T.companyA, D])).toBe(0)
    expect(await count(`FROM "AttendanceMonthClose" WHERE "companyId" = $1 AND month = $2::date`, [w.T.companyA, `${M}-01`])).toBe(0)
  })

  it('holds a month with days at a site whose gate is off', async () => {
    const earlier = plusDays(`${M}-01`, -1)
    const { T } = w
    await w.admin(`INSERT INTO "AttendanceDay" (id, "tenantId", "companyId", "siteId", "employeeId", date, status) VALUES ($1, $2, $3, $4, $5, $6::date, 'OPEN')`, [newId(), T.tenant, T.companyA, SITE_A2, w.P.P1, earlier])
    const panel = await w.ok('viewer', 'GET', panelUrl(earlier.slice(0, 7)))
    expect(panel.sites.find((site: Json) => site.siteId === SITE_A2)).toMatchObject({ gateOpen: false })
    expect(panel.holds.map((hold: Json) => hold.code)).toContain('GATE_OFF')
    expect((await w.ok('viewer', 'GET', panelUrl())).holds.map((hold: Json) => hold.code)).not.toContain('GATE_OFF')
  })

  it('counts a line day left open in Production › Labour, and a manual day not reviewed', async () => {
    const { T } = w
    const dayUrl2 = `/production/labour/days/${T.lineL1}/${D}`
    const closed = await w.ok('closer', 'POST', `${dayUrl2}/close`, {})
    await w.ok('closer', 'POST', `${dayUrl2}/reopen`, { version: closed.day.version, reason: 'A made-up late report' })
    expect(itemOf(await w.ok('viewer', 'GET', panelUrl()), 'PRODUCTION_DAYS')).toMatchObject({ left: 1, done: false })
    const again = await w.ok('closer', 'GET', dayUrl2)
    await w.ok('closer', 'POST', `${dayUrl2}/close`, { version: again.day.version })
    expect(itemOf(await w.ok('viewer', 'GET', panelUrl()), 'PRODUCTION_DAYS')).toMatchObject({ left: 0 })
  })

  it('clears as HR works: an absence coded, a clock-out added, overtime decided, days approved', async () => {
    const { P } = w
    const fer = (await w.admin<{ id: string }>(`SELECT id FROM "AbsenceCode" WHERE "tenantId" = $1 AND code = 'FER'`, [w.T.tenant]))[0]!.id
    const absent = await w.day(P.P3!, D)
    await w.ok('hr', 'POST', `${dayUrl(absent.id)}/absence`, { version: absent.version, codeId: fer })
    const forgot = await w.day(P.P4!, D)
    await w.ok('hr', 'POST', `${dayUrl(forgot.id)}/fix`, { version: forgot.version, action: { kind: 'ADD_EVENT', event: 'OUT', at: local('14:00').toISOString() }, reason: 'Forgot to clock out, the lead confirmed it' })
    const panel = await w.ok('viewer', 'GET', panelUrl())
    expect(itemOf(panel, 'MANUAL_REVIEWED')).toMatchObject({ left: 1, done: false })
    expect(itemOf(panel, 'ABSENCE_CODES')).toMatchObject({ left: 0, done: true })
    expect(itemOf(panel, 'ANOMALIES_CLEARED')).toMatchObject({ left: 0, done: true })
    for (const person of [P.P1!, P.P2!, P.P3!, P.P4!]) await approve(person)
    const entry = (await w.entries(P.P2!, D)).DAY!
    await w.ok('hr', 'POST', `/people/overtime/entries/${entry.id}/approve`, { version: entry.version })
  })
})

describe('the close', () => {
  it('keeps timesheets a note, never a hold (the design has no such item)', async () => {
    await w.ok('hr', 'POST', '/people/timesheets/prepare', { siteId: w.T.siteA1, month: M })
    const panel = await w.ok('closer', 'GET', panelUrl())
    expect(panel.notes.map((note: Json) => note.note)).toContain('TIMESHEETS_NOT_APPROVED')
    expect(panel.holds).toEqual([])
    expect(panel.actions.close).toBe(true)
  })

  it('locks every day in one command, seals the calendar and says so', async () => {
    const answer = await w.ok('closer', 'POST', '/people/month-close', { companyId: w.T.companyA, month: M, phrase: closePhrases(M).it })
    closeId = answer.closeId
    expect(answer).toMatchObject({ state: 'CLOSED', actions: { close: false, seal: false, openLul: true } })
    expect(answer.seal).toMatchObject({ sealed: true })
    expect(answer.seal.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(await count(`FROM "AttendanceDay" WHERE "companyId" = $1 AND date >= $2::date AND date < ($2::date + interval '1 month') AND (status <> 'CLOSED' OR "monthCloseId" <> $3)`, [w.T.companyA, `${M}-01`, closeId])).toBe(0)
    const row = (await w.admin(`SELECT * FROM "AttendanceMonthClose" WHERE id = $1`, [closeId]))[0]!
    expect(row).toMatchObject({ status: 'CLOSED', lulSha256: answer.seal.sha256 })
    const audit = await w.admin(`SELECT action, after FROM "AuditLog" WHERE "recordType" = 'AttendanceMonthClose' AND "recordId" = $1 ORDER BY at`, [closeId])
    expect(audit.map((entry) => entry.action)).toEqual(['people.closeAttendanceMonth', 'people.sealLulCalendar'])
    expect(audit[0]!.after).toMatchObject({ days: 4, month: M, timesheetsOpen: 4 })
    const events = await w.admin(`SELECT type, payload FROM "OutboxEvent" WHERE type LIKE 'attendance.%' AND payload->>'closeId' = $1`, [closeId])
    expect(events.map((event) => event.type).sort()).toEqual(['attendance.lul_sealed', 'attendance.month_closed'])
    expect(keysOf(events.map((event) => event.payload))).not.toContain('employeeId')
    expect((await w.ok('viewer', 'GET', `/people/month-close/months?companyId=${w.T.companyA}`)).months.find((entry: Json) => entry.month === M)).toMatchObject({ state: 'CLOSED', sealed: true })
  })

  it('stays closed: closing again is refused, and a day of it changes no other way', async () => {
    const { P } = w
    expect(pathsOf(await w.no('closer', 'POST', '/people/month-close', { companyId: w.T.companyA, month: M, phrase: phrase() }, 409))).toContain('holds/ALREADY_CLOSED')
    const day = await w.day(P.P1!, D)
    expect(pathsOf(await w.no('hr', 'POST', `${dayUrl(day.id)}/reopen`, { version: day.version, reason: 'Trying after the close' }, 409))).toContain('refusal/DAY_CLOSED')
    expect(pathsOf(await w.no('hr', 'POST', '/people/attendance/entries', { employeeId: P.P1, date: D1, in: local('06:00', D1).toISOString(), out: local('14:00', D1).toISOString(), reason: 'Trying after the close' }, 409))).toContain('refusal/MONTH_CLOSED')
    await expect(w.admin(`UPDATE "AttendanceDay" SET "ordinaryMinutes" = 1 WHERE id = $1`, [day.id])).rejects.toThrow(/CLOSED/)
    await expect(w.clock(P.P1!, 'IN', local('06:00', D2))).rejects.toThrow(/closed month/)
  })

  it('leaves the timesheets as they are, for good', async () => {
    const sheet = (await w.admin(`SELECT id, version FROM "TimesheetApproval" WHERE "employeeId" = $1 AND "periodStart" = $2::date`, [w.P.P1, `${M}-01`]))[0]!
    expect(pathsOf(await w.no('manager', 'POST', `/people/timesheets/${sheet.id}/lead-approve`, { version: sheet.version }, 409))).toContain('holds/MONTH_CLOSED')
  })
})

describe('a store that is down at the close', () => {
  it('leaves the month closed and unsealed, says so, and seals it later; an OPEN close row is taken up', async () => {
    const { P, T } = w
    const month = await freeMonth(`${plusDays(`${M}-01`, -1).slice(0, 7)}-01`)
    const date = `${month}-15`
    await w.admin(`INSERT INTO "AttendanceMonthClose" (id, "tenantId", "companyId", month, status) VALUES ($1, $2, $3, $4::date, 'OPEN')`, [newId(), T.tenant, T.companyA, `${month}-01`])
    await restOthers(date, [P.P1!])
    await w.roster(P.P1!, date, [360, 840])
    await w.clock(P.P1!, 'IN', local('06:00', date))
    await w.clock(P.P1!, 'OUT', local('14:00', date))
    await w.pass(date)
    const rows = await w.admin<{ id: string; version: number }>(`SELECT id, version FROM "AttendanceDay" WHERE "companyId" = $1 AND date >= $2::date AND date < ($2::date + interval '1 month')`, [T.companyA, `${month}-01`])
    for (const row of rows) await w.ok('hr', 'POST', `${dayUrl(row.id)}/approve`, { version: row.version })
    await w.admin(`UPDATE "IntegrationAccount" SET status = 'DISABLED' WHERE "tenantId" = $1 AND provider = 'R2'`, [T.tenant])
    const answer = await w.ok('closer', 'POST', '/people/month-close', { companyId: T.companyA, month, phrase: phrase(month) })
    expect(answer).toMatchObject({ state: 'CLOSED', actions: { seal: true, openLul: false } })
    expect(answer.seal).toMatchObject({ sealed: false, sha256: null, fileId: null })
    expect(await count(`FROM "AttendanceMonthClose" WHERE "companyId" = $1 AND month = $2::date`, [T.companyA, `${month}-01`])).toBe(1)
    expect((await w.no('closer', 'POST', `/people/month-close/${answer.closeId}/lul/open`, {}, 409)).message).toContain('not sealed')
    const report = await w.ok('viewer', 'GET', `/people/reports/attendance?siteId=${T.siteA1}&month=${month}`)
    expect(report.match.state).toBe('NOT_SEALED')
    await w.admin(`UPDATE "IntegrationAccount" SET status = 'ACTIVE' WHERE "tenantId" = $1 AND provider = 'R2'`, [T.tenant])
    const sealed = await w.ok('closer', 'POST', `/people/month-close/${answer.closeId}/seal`, undefined)
    expect(sealed.seal).toMatchObject({ sealed: true })
    expect(sealed.seal.sha256).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('the LUL calendar', () => {
  it('is out of reach of the generic file routes, whoever holds files.read', async () => {
    const row = (await w.admin(`SELECT "lulFileId" FROM "AttendanceMonthClose" WHERE id = $1`, [closeId]))[0]!
    await w.no('filesOnly', 'GET', `/files/${row.lulFileId}`, undefined, 404)
    await w.no('filesOnly', 'GET', `/files/${row.lulFileId}/download`, undefined, 404)
    const list = await w.ok('filesOnly', 'GET', `/files?recordType=AttendanceMonthClose&recordId=${closeId}`)
    expect(list.files).toEqual([])
    const stored = await w.admin(`SELECT "contentType", kind, visibility::text[] AS visibility, "retainUntil" FROM "StoredFile" WHERE "recordType" = 'AttendanceMonthClose' AND "recordId" = $1 ORDER BY "contentType"`, [closeId])
    expect(stored.map((file) => file.contentType)).toEqual(['application/pdf', 'text/csv'])
    expect(stored[0]).toMatchObject({ kind: 'DOCUMENT', visibility: ['OFFICE'] })
    expect((stored[0]!.retainUntil as Date).getTime()).toBeGreaterThan(Date.now() + 4 * 365 * 86_400_000)
  })

  it('opens with its own permission, each opening recorded', async () => {
    await w.no('viewer', 'POST', `/people/month-close/${closeId}/lul/open`, {}, 403)
    const answer = await w.ok('closer', 'POST', `/people/month-close/${closeId}/lul/open`, {})
    const panel = await w.ok('closer', 'GET', panelUrl())
    expect(answer).toMatchObject({ format: 'PDF', sha256: panel.seal.sha256 })
    expect(answer.fileName).toMatch(/^LUL_.*\.pdf$/)
    const pdf = await bytesOf(answer.download.url)
    expect(createHash('sha256').update(pdf).digest('hex')).toBe(panel.seal.sha256)
    const text = pdfFlatText(pdf)
    expect(text).toContain('Calendario delle presenze')
    expect(text).toContain('Alba Uno')
    expect(text).toContain('consulente del lavoro')
    expect(await count(`FROM "AuditLog" WHERE action = 'people.openLulCalendar' AND "recordId" = $1`, [closeId])).toBe(1)
  })

  it('gives the same figures as a CSV, approved overtime only, the manual day marked', async () => {
    const answer = await w.ok('closer', 'POST', `/people/month-close/${closeId}/lul/open`, { format: 'CSV' })
    expect(answer.format).toBe('CSV')
    const text = (await bytesOf(answer.download.url)).toString('utf8')
    expect(text).toContain(`Alba Uno (made up);EMPLOYEE;${D};ORDINARIE`)
    expect(text).toContain(`Bruno Due (made up);EMPLOYEE;${D};STRAORDINARIO_DIURNO;;2,00;120;NO`)
    expect(text).toContain(`Carla Tre (made up);EMPLOYEE;${D};ASSENZA;FER`)
    expect(text).toMatch(new RegExp(`Dario Quattro \\(made up\\);EMPLOYEE;${D};ORDINARIE;;[0-9,]+;[0-9]+;SI`))
  })

  it('is what the closed figures say: made again, the bytes are the sealed ones', async () => {
    const db = callerFor(w.database, systemContext(w.T.tenant, 'seal-check'))
    const sha = await db.withClient(async (client) => {
      const place = (await placeOf(client, w.T.companyA))!
      const close = (await closeOfMonth(client, w.T.companyA, M))!
      return createHash('sha256').update(await renderLulPdf(lulCalendar(await lulFactsOf(client, place, close)))).digest('hex')
    })
    expect(sha).toBe((await w.ok('closer', 'GET', panelUrl())).seal.sha256)
  })

  it('refuses a second seal', async () => {
    expect(pathsOf(await w.no('closer', 'POST', `/people/month-close/${closeId}/seal`, undefined, 409))).toContain('refusal/ALREADY_SEALED')
  })
})

describe('correcting a closed day', () => {
  let day: Json
  let closed: Json

  beforeAll(async () => {
    day = await w.day(w.P.P1!, D)
    closed = await w.ok('viewer', 'GET', `${dayUrl(day.id)}/corrections`)
  })

  it('reads the closed figures in one record, with the person', async () => {
    expect(closed).toMatchObject({ status: 'CLOSED', closeId, differs: false, corrections: [], actions: { correct: false } })
    expect(closed.person.name).toContain('Alba Uno')
    expect((await w.ok('corrector', 'GET', `${dayUrl(day.id)}/corrections`)).actions.correct).toBe(true)
  })

  it('needs its permission, a reason and the figure read', async () => {
    const body = { kind: 'ORDINARY', minutesBefore: closed.closedFigures.ordinaryMinutes, minutesAfter: 420, reason: 'Left an hour early, the lead confirmed it' }
    await w.no('hr', 'POST', `${dayUrl(day.id)}/corrections`, body, 403)
    expect(pathsOf(await w.no('corrector', 'POST', `${dayUrl(day.id)}/corrections`, { ...body, reason: ' ' }, 400))).toContain('body/reason')
    expect(pathsOf(await w.no('corrector', 'POST', `${dayUrl(day.id)}/corrections`, { ...body, kind: 'ABSENCE' }, 400))).toContain('body/absenceCodeId')
    expect(pathsOf(await w.no('corrector', 'POST', `${dayUrl(day.id)}/corrections`, { ...body, minutesBefore: 1 }, 409))).toContain('refusal/CHANGED')
    expect(pathsOf(await w.no('corrector', 'POST', `${dayUrl(day.id)}/corrections`, { ...body, minutesAfter: body.minutesBefore }, 409))).toContain('refusal/NO_CHANGE')
  })

  it('adds an entry and never touches the closed day or the seal', async () => {
    const before = await w.ok('closer', 'GET', panelUrl())
    const answer = await w.ok('corrector', 'POST', `${dayUrl(day.id)}/corrections`, { kind: 'ORDINARY', minutesBefore: closed.closedFigures.ordinaryMinutes, minutesAfter: 420, reason: 'Left an hour early, the lead confirmed it' }, 201)
    expect(answer.figuresNow.ordinaryMinutes).toBe(420)
    expect(answer.closedFigures.ordinaryMinutes).toBe(closed.closedFigures.ordinaryMinutes)
    expect(answer.differs).toBe(true)
    expect(answer.corrections).toHaveLength(1)
    expect(answer.corrections[0]).toMatchObject({ kind: 'ORDINARY', minutesAfter: 420, reason: 'Left an hour early, the lead confirmed it' })
    expect((await w.day(w.P.P1!, D)).ordinaryMinutes).toBe(closed.closedFigures.ordinaryMinutes)
    const after = await w.ok('closer', 'GET', panelUrl())
    expect(after.seal.sha256).toBe(before.seal.sha256)
    expect(after.corrections).toBe(1)
    const events = await w.admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'attendance.day_corrected' AND payload->>'dayId' = $1`, [day.id])
    expect(events).toHaveLength(1)
    expect(keysOf(events[0]!.payload)).not.toContain('reason')
    expect(keysOf(events[0]!.payload)).not.toContain('minutesAfter')
    const audit = (await w.admin(`SELECT reason FROM "AuditLog" WHERE action = 'people.correctClosedDay' ORDER BY at DESC LIMIT 1`))[0]!
    expect(audit.reason).toBe('Left an hour early, the lead confirmed it')
  })

  it('corrects an absence with a code of the company, from zero', async () => {
    const rol = (await w.admin<{ id: string }>(`SELECT id FROM "AbsenceCode" WHERE "tenantId" = $1 AND code = 'ROL'`, [w.T.tenant]))[0]!.id
    const answer = await w.ok('corrector', 'POST', `${dayUrl(day.id)}/corrections`, { kind: 'ABSENCE', absenceCodeId: rol, minutesBefore: 0, minutesAfter: 30, reason: 'The permit was never entered' }, 201)
    expect(answer.figuresNow.absences).toEqual([expect.objectContaining({ code: 'ROL', minutes: 30 })])
    expect(pathsOf(await w.no('corrector', 'POST', `${dayUrl(day.id)}/corrections`, { kind: 'ABSENCE', absenceCodeId: newId(), minutesBefore: 0, minutesAfter: 30, reason: 'Not a code we have' }, 409))).toContain('refusal/NO_SUCH_CODE')
  })

  it('is never on your own day, and only on a closed one', async () => {
    const { T } = w
    const own = newId()
    await w.admin(`INSERT INTO "AttendanceDay" (id, "tenantId", "companyId", "siteId", "employeeId", date, status) VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, 'OPEN')`, [own, T.tenant, T.companyA, T.siteA1, w.P.P1])
    expect(pathsOf(await w.no('corrector', 'POST', `${dayUrl(own)}/corrections`, { kind: 'NIGHT', minutesBefore: 0, minutesAfter: 30, reason: 'An open day is fixed' }, 409))).toContain('refusal/NOT_CLOSED')
    await w.admin(`UPDATE "Employee" SET "userId" = $2 WHERE id = $1`, [w.P.P1, T.actor])
    expect(pathsOf(await w.no('selfCorrector', 'POST', `${dayUrl(day.id)}/corrections`, { kind: 'NIGHT', minutesBefore: 0, minutesAfter: 30, reason: 'My own closed day' }, 409))).toContain('refusal/OWN_DAY')
    await w.admin(`UPDATE "Employee" SET "userId" = NULL WHERE id = $1`, [w.P.P1])
  })

  it('lists a month\'s corrections with no name and no figure', async () => {
    const list = await w.ok('viewer', 'GET', `/people/month-close/${closeId}/corrections`)
    expect(list.corrections).toHaveLength(2)
    const keys = keysOf(list)
    for (const word of ['employeeId', 'name', 'minutesAfter', 'minutesBefore', 'reason']) expect(keys).not.toContain(word)
  })
})

describe('the attendance report (MES-303)', () => {
  it('shows a line, never a person, with the figures as they stand', async () => {
    const report = await w.ok('viewer', 'GET', reportUrl())
    expect(report.groupBy).toBe('line')
    expect(report.final).toBe(true)
    expect(report.groups).toHaveLength(1)
    const group = report.groups[0]
    expect(group).toMatchObject({ id: w.T.lineL1, people: 4, tooFew: false })
    expect(group.figures.overtimeDayMinutes).toBe(120)
    expect(group.figures.absences.map((entry: Json) => entry.code).sort()).toEqual(['FER', 'ROL'])
    const keys = keysOf(report)
    for (const word of ['employeeId', 'firstName', 'lastName', 'displayName', 'employeeCode']) expect(keys).not.toContain(word)
    expect(JSON.stringify(report)).not.toContain('Alba')
    expect((await w.ok('viewer', 'GET', reportUrl('&groupBy=team'))).groups[0]).toMatchObject({ people: 4, tooFew: false })
  })

  it('refuses a person as a filter or a group, in words', async () => {
    expect(pathsOf(await w.no('viewer', 'GET', reportUrl(`&employeeId=${w.P.P1}`), undefined, 400))).toContain('query/filters/employeeId')
    expect(pathsOf(await w.no('viewer', 'GET', reportUrl('&groupBy=employeeId'), undefined, 400))).toContain('query/groupBy/employeeId')
  })

  it('says it differs from the closed LUL, where, and that a correction put back matches again', async () => {
    const report = await w.ok('viewer', 'GET', reportUrl())
    expect(report.match).toMatchObject({ state: 'DIFFERS', cells: 2 })
    const list = await w.ok('viewer', 'GET', `/people/reports/attendance/differences?siteId=${w.T.siteA1}&month=${M}`)
    expect(list.cells.map((cell: Json) => cell.kind).sort()).toEqual(['ABSENCE', 'ORDINARY'])
    expect(keysOf(list)).not.toContain('nowMinutes')
    const day = await w.day(w.P.P1!, D)
    const rol = (await w.admin<{ id: string }>(`SELECT id FROM "AbsenceCode" WHERE "tenantId" = $1 AND code = 'ROL'`, [w.T.tenant]))[0]!.id
    await w.ok('corrector', 'POST', `${dayUrl(day.id)}/corrections`, { kind: 'ABSENCE', absenceCodeId: rol, minutesBefore: 30, minutesAfter: 0, reason: 'Entered on the wrong person' }, 201)
    await w.ok('corrector', 'POST', `${dayUrl(day.id)}/corrections`, { kind: 'ORDINARY', minutesBefore: 420, minutesAfter: day.ordinaryMinutes, reason: 'The lead took it back' }, 201)
    expect((await w.ok('viewer', 'GET', reportUrl())).match).toMatchObject({ state: 'MATCHES', cells: 0 })
  })

  it('says an open month has nothing to match yet', async () => {
    const month = businessDate(new Date(), ROME).slice(0, 7)
    const report = await w.ok('viewer', 'GET', `/people/reports/attendance?siteId=${w.T.siteA1}&month=${month}`)
    expect(report.match.state).toBe('NOT_CLOSED')
    expect(report.final).toBe(false)
  })

  it('hides a group under the minimum size, and a sum that would give it away', async () => {
    await w.admin(`UPDATE "Employee" SET "homeLineId" = NULL WHERE id = $1`, [w.P.P4])
    const report = await w.ok('viewer', 'GET', reportUrl())
    expect(report.groups).toHaveLength(2)
    const hidden = report.groups.find((group: Json) => group.id === null)
    expect(hidden).toMatchObject({ people: null, tooFew: true, figures: null })
    expect(hidden.words).toContain('Too few people')
    expect(report.summary).toBeNull()
    await w.admin(`UPDATE "Employee" SET "homeLineId" = $2 WHERE id = $1`, [w.P.P4, w.T.lineL1])
    expect((await w.ok('viewer', 'GET', reportUrl())).summary).toMatchObject({ people: 4 })
  })

  it('opens one person\'s month as one record, approved overtime and absences by code', async () => {
    const record = await w.ok('viewer', 'GET', `/people/reports/attendance/people/${w.P.P2}?month=${M}`)
    expect(record.person.name).toContain('Bruno Due')
    expect(record).toMatchObject({ monthState: 'CLOSED', daysShown: 1, differs: false })
    expect(record.figures.overtimeDayMinutes).toBe(120)
    await w.no('nobody', 'GET', `/people/reports/attendance/people/${w.P.P2}?month=${M}`, undefined, 403)
  })
})

describe('attended against production minutes, per line (MES-236)', () => {
  let month: string

  beforeAll(async () => {
    await seedLabour({ db: w.database, namespace: NS })
    // The seeded reports were made on the cutting tablet: it shows line L1 (a station-less LINE tablet), so they are L1's.
    await w.admin(`UPDATE "Device" SET "stationId" = NULL, mode = 'LINE', "lineId" = $2 WHERE id = $1`, [seedUuid(NS, 'device:A1:cutting'), w.T.lineL1])
    const scan = (await w.admin<{ at: Date }>(`SELECT "serverTime" AS at FROM "OperationScan" WHERE kind = 'REPORT' ORDER BY "serverTime" DESC LIMIT 1`))[0]!
    const date = businessDate(scan.at, ROME)
    month = date.slice(0, 7)
    // The people of the line that month.
    for (const person of Object.values(w.P)) {
      await w.admin(`INSERT INTO "AttendanceDay" (id, "tenantId", "companyId", "siteId", "employeeId", date, status, "presentMinutes", "ordinaryMinutes") VALUES ($1, $2, $3, $4, $5, $6::date, 'OPEN', 450, 450) ON CONFLICT DO NOTHING`, [newId(), w.T.tenant, w.T.companyA, w.T.siteA1, person, date])
    }
  })

  it('sets the minutes attended beside the standard minutes earned and the coded time: no person, no scan of a person', async () => {
    const answer = await w.ok('viewer', 'GET', `/people/reports/attendance/production?siteId=${w.T.siteA1}&month=${month}`)
    const row = (answer.lines as Json[]).find((entry) => entry.line.id === w.T.lineL1)!
    expect(row).toMatchObject({ people: 4, tooFew: false })
    expect(row.figures.attendedMinutes).toBe(1800)
    expect(Number(row.figures.productionMinutes)).toBeGreaterThan(0)
    expect(Number(row.figures.gapMinutes)).toBeCloseTo(1800 - Number(row.figures.productionMinutes) - row.figures.offStandardMinutes, 3)
    const keys = keysOf(answer)
    for (const word of ['employeeId', 'workerId', 'name_', 'firstName', 'scanId']) expect(keys).not.toContain(word)
  })

  it('hides a line under the minimum size', async () => {
    await w.admin(`UPDATE "Employee" SET "homeLineId" = NULL WHERE id = ANY($1)`, [[w.P.P3, w.P.P4]])
    const answer = await w.ok('viewer', 'GET', `/people/reports/attendance/production?siteId=${w.T.siteA1}&month=${month}`)
    expect((answer.lines as Json[]).find((entry) => entry.line.id === w.T.lineL1)).toMatchObject({ people: null, tooFew: true, figures: null })
    expect(answer.summary).toBeNull()
    await w.admin(`UPDATE "Employee" SET "homeLineId" = $2 WHERE id = ANY($1)`, [[w.P.P3, w.P.P4], w.T.lineL1])
  })
})

describe('after the gate goes off', () => {
  it('refuses the calendar and a correction, in words: the people on it are not read', async () => {
    await w.closeGate()
    const day = await w.day(w.P.P2!, D)
    expect(pathsOf(await w.no('closer', 'POST', `/people/month-close/${closeId}/lul/open`, {}, 409))).toContain('gate/ATTENDANCE')
    expect(pathsOf(await w.no('corrector', 'GET', `${dayUrl(day.id)}/corrections`, undefined, 409))).toContain('gate/ATTENDANCE')
    expect(pathsOf(await w.no('corrector', 'POST', `${dayUrl(day.id)}/corrections`, { kind: 'NIGHT', minutesBefore: 0, minutesAfter: 30, reason: 'While the gate is off' }, 409))).toContain('gate/ATTENDANCE')
  })
})
