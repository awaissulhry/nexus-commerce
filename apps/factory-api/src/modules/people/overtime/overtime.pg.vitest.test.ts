import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { callerFor } from '../../../core/command'
import { systemContext } from '../../../platform/outbox/system'
import { assertPersonDecides } from '../privacy/decide'
import { overtimeHandlers } from './jobs'
import { D, D1, D2, keysOf, local, MONTH, openWorld, pathsOf, type Json, type World } from './testing'

/**
 * Overtime worked and timesheets (B-W2b-42; MES-229, MES-230) through the app's real routes on a throwaway PostgreSQL 17:
 * overtime computed from the attendance days against the roster, by class; approved by a person, on an approved day,
 * before it is paid; timesheets approved by the lead, then HR. MANUAL clock events (no worker) count like any other.
 *
 * The law the tests name: Statuto dei Lavoratori (L. 300/1970) art. 4 c.2-3 — nothing of a person is read or written while
 * the site's ATTENDANCE gate is off; Owner answer W1 — no name or one person's minutes in a list, filter or total;
 * D.Lgs. 66/2003 art. 5 — overtime is never automatic; D.Lgs. 152/1997 art. 1-bis — a person decides, never about
 * themselves. Run with `node scripts/factory/run-pg-tests.mjs modules/people/overtime`.
 */

let w: World
const entriesUrl = () => `/people/overtime/entries?siteId=${w.T.siteA1}&from=${D}&to=${D2}`
const dayUrl = (id: string) => `/people/attendance/days/${id}`
const entryUrl = (id: string) => `/people/overtime/entries/${id}`
const sheetUrl = (id: string) => `/people/timesheets/${id}`

async function approveDay(employeeId: string, date = D): Promise<void> {
  const day = await w.day(employeeId, date)
  await w.ok('hr', 'POST', `${dayUrl(day.id)}/approve`, { version: day.version })
}

beforeAll(async () => {
  w = await openWorld('w2b42_overtime', 'w2b42-overtime')
  const { P, roster, clock } = w
  // P1: an afternoon to 22:00, out at 23:30: 90 minutes at night; back at 06:00 the next day: a short rest.
  await roster(P.P1!, D, [840, 1320])
  await roster(P.P1!, D1, [360, 840])
  await clock(P.P1!, 'IN', local('14:00'))
  await clock(P.P1!, 'OUT', local('23:30'))
  await clock(P.P1!, 'IN', local('06:00', D1))
  await clock(P.P1!, 'OUT', local('14:00', D1))
  // P2: a morning to 14:00, out at 16:00: 2 hours by day.
  await roster(P.P2!, D, [360, 840])
  await clock(P.P2!, 'IN', local('06:00'))
  P.P2out = await clock(P.P2!, 'OUT', local('16:00'))
  // P3: a day planned off, worked 4 hours: holiday overtime, and a NO_SHIFT anomaly to accept.
  await roster(P.P3!, D, null)
  await clock(P.P3!, 'IN', local('08:00'))
  await clock(P.P3!, 'OUT', local('12:00'))
}, 600_000)

afterAll(async () => {
  await w?.close()
}, 60_000)

describe('the legal gate: nothing of a person is read or computed while ATTENDANCE is off (Statuto dei Lavoratori art. 4 c.2-3)', () => {
  it('refuses every read in words', async () => {
    for (const url of [entriesUrl(), `/people/overtime/counts?siteId=${w.T.siteA1}`, `/people/timesheets?siteId=${w.T.siteA1}`]) {
      const error = await w.no('hr', 'GET', url, undefined, 409)
      expect(pathsOf(error)).toContain('gate/ATTENDANCE')
      expect(error.message).toContain('Statuto dei Lavoratori art. 4')
    }
    expect(pathsOf(await w.no('hr', 'POST', '/people/timesheets/prepare', { siteId: w.T.siteA1, month: MONTH }, 409))).toContain('gate/ATTENDANCE')
  })

  it('computes nothing', async () => {
    await w.pass(D)
    expect(await w.compute(w.P.P2!, D)).toBe(false)
    expect(await w.admin('SELECT id FROM "OvertimeEntry" WHERE "tenantId" = $1 AND "employeeId" = ANY($2)', [w.T.tenant, [w.P.P1, w.P.P2, w.P.P3]])).toEqual([])
  })
})

describe('overtime computed from attendance against the roster', () => {
  beforeAll(async () => {
    await w.openGate()
    await w.pass(D)
  })

  it('makes one PENDING entry per class: by day, at night, on a day planned off', async () => {
    const { P } = w
    // The worker's handler, after attendance.day_changed.
    const [handler] = overtimeHandlers()
    const day = await w.day(P.P2!)
    const envelope = { eventId: newId(), type: 'attendance.day_changed', version: 1, context: 'people', tenantId: w.T.tenant, companyId: w.T.companyA, siteId: w.T.siteA1, subject: P.P2, correlationId: 'ot-test', causationId: null, occurredAt: new Date().toISOString(), payload: { dayId: day.id, siteId: w.T.siteA1, employeeId: P.P2, status: 'OPEN', change: 'COMPUTED' } }
    await handler!.handle(envelope as never, { caller: callerFor(w.database, systemContext(w.T.tenant, 'ot-handler')), attempt: 1 })
    await w.compute(P.P1!, D)
    await w.compute(P.P3!, D)
    expect(await w.entries(P.P2!)).toMatchObject({ DAY: { minutes: 120, status: 'PENDING', requestId: null } })
    expect(Object.keys(await w.entries(P.P1!))).toEqual(['NIGHT'])
    expect((await w.entries(P.P1!)).NIGHT).toMatchObject({ minutes: 90, status: 'PENDING' })
    expect((await w.entries(P.P3!)).HOLIDAY).toMatchObject({ minutes: 240, status: 'PENDING' })
  })

  it('writes nothing the second time, and never approves on its own (overtime is never automatic)', async () => {
    expect(await w.compute(w.P.P2!, D)).toBe(false)
    expect((await w.admin(`SELECT count(*)::int AS n FROM "OvertimeEntry" WHERE "tenantId" = $1 AND status <> 'PENDING' AND "employeeId" = ANY($2)`, [w.T.tenant, [w.P.P1, w.P.P2, w.P.P3]]))[0]!.n).toBe(0)
  })

  it('takes a MANUAL clock event (no worker, no tablet) like any other', async () => {
    const { P } = w
    await w.roster(P.P4!, D, [360, 840])
    await w.ok('hr', 'POST', '/people/attendance/entries', { employeeId: P.P4, date: D, in: local('06:00').toISOString(), out: local('15:30').toISOString(), reason: 'The tablet was down all day' }, 201)
    expect((await w.admin(`SELECT count(*)::int AS n FROM "ClockEvent" WHERE "employeeId" = $1 AND "workerId" IS NULL AND source = 'MANUAL'`, [P.P4]))[0]!.n).toBe(2)
    await w.compute(P.P4!, D)
    expect((await w.entries(P.P4!)).DAY).toMatchObject({ minutes: 90, status: 'PENDING' })
  })
})

describe('Overtime to approve: a list with no name and no minutes (Owner answer W1)', () => {
  it('shows the state and a tone per limit, never a person or a figure', async () => {
    const list = await w.ok('viewer', 'GET', entriesUrl())
    expect(list.entries.length).toBeGreaterThanOrEqual(4)
    expect(list.entries[0]).toMatchObject({ siteId: w.T.siteA1, status: 'PENDING' })
    const keys = keysOf(list)
    for (const word of ['employeeId', 'name', 'displayName', 'minutes', 'firstName', 'lastName', 'values']) expect(keys).not.toContain(word)
    expect(JSON.stringify(list)).not.toContain('(made up)')
    // P1 came back after 6 h 30 of rest: the tone shows, the figure stays in the record.
    const row = (list.entries as Json[]).find((entry) => entry.class === 'NIGHT')!
    expect(row.checks).toEqual([
      { rule: 'OVERTIME_YEARLY_CAP', state: 'OK', level: 'WARN' },
      { rule: 'DAILY_REST', state: 'OVER', level: 'WARN' },
      { rule: 'WEEKLY_AVERAGE', state: 'OK', level: 'WARN' },
    ])
  })

  it('refuses a person as a filter or a group, in words', async () => {
    expect(pathsOf(await w.no('viewer', 'GET', `${entriesUrl()}&employeeId=${w.P.P1}`, undefined, 400))).toContain('query/filters/employeeId')
    expect(pathsOf(await w.no('viewer', 'GET', `${entriesUrl()}&groupBy=employeeId`, undefined, 400))).toContain('query/groupBy/employeeId')
  })

  it('filters by class and by planned, and pages', async () => {
    expect((await w.ok('viewer', 'GET', `${entriesUrl()}&class=HOLIDAY`)).entries).toHaveLength(1)
    const first = await w.ok('viewer', 'GET', `${entriesUrl()}&limit=1`)
    expect(first.entries).toHaveLength(1)
    const second = await w.ok('viewer', 'GET', `${entriesUrl()}&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)
    expect(second.entries[0].id).not.toBe(first.entries[0].id)
  })

  it('gives the tile for a group of the minimum size or more, nothing under it (ANA-075)', async () => {
    const site = await w.ok('viewer', 'GET', `/people/overtime/counts?siteId=${w.T.siteA1}&from=${D}&to=${D2}`)
    expect(site).toMatchObject({ tooFew: false, tiles: { waitingEntries: 4, waitingMinutes: 540, notPlanned: 4 } })
    const team = await w.admin<{ id: string }>(`INSERT INTO "Team" (id, "tenantId", "companyId", "siteId", code, name) VALUES ($1, $2, $3, $4, 'T-SMALL', 'Two people (made up)') RETURNING id`, [newId(), w.T.tenant, w.T.companyA, w.T.siteA1])
    const alone = newId()
    await w.admin(`INSERT INTO "Employee" (id, "tenantId", "companyId", "siteId", "firstName", "lastName", "displayName", "startDate") VALUES ($1, $2, $3, $4, 'Elsa', 'Sola (made up)', 'Elsa S.', '2026-01-05')`, [alone, w.T.tenant, w.T.companyA, w.T.siteA1])
    await w.admin(`INSERT INTO "TeamMember" (id, "tenantId", "siteId", "teamId", "employeeId", "isLead", since) VALUES ($1, $2, $3, $4, $5, false, '2026-02-02')`, [newId(), w.T.tenant, w.T.siteA1, team[0]!.id, alone])
    const small = await w.ok('viewer', 'GET', `/people/overtime/counts?siteId=${w.T.siteA1}&from=${D}&to=${D2}&teamId=${team[0]!.id}`)
    expect(small).toMatchObject({ people: null, tooFew: true, tiles: { waitingEntries: null, waitingMinutes: null, notPlanned: null } })
  })

  it('opens one record: the name, the minutes, the limits in words with the law', async () => {
    const entry = (await w.entries(w.P.P1!)).NIGHT!
    const record = await w.ok('viewer', 'GET', entryUrl(entry.id))
    expect(record).toMatchObject({ class: 'NIGHT', minutes: 90, status: 'PENDING', person: { name: 'Alba Uno (made up)' }, request: null, actions: { approve: false, reject: false, reopen: false } })
    expect(record.words[0]).toBe('Nobody planned this overtime: no planned request names it.')
    const rest = (record.checks as Json[]).find((check) => check.rule === 'DAILY_REST')!
    expect(rest).toMatchObject({ state: 'OVER', law: 'D.Lgs. 66/2003 art. 7', date: D1 })
    expect(rest.words).toContain('Rest 6 h 30 min between 23:30')
    expect(record.holds.map((hold: Json) => hold.code)).toEqual(['DAY_NOT_APPROVED'])
  })

  it('keeps a person out of reach: 404 for another company, 403 for no permission', async () => {
    const entry = (await w.entries(w.P.P1!)).NIGHT!
    await w.no('companyB', 'GET', entryUrl(entry.id), undefined, 404)
    await w.no('nobody', 'GET', entryUrl(entry.id), undefined, 403)
    await w.no('viewer', 'POST', `${entryUrl(entry.id)}/approve`, { version: 1 }, 403)
  })
})

describe('approved before pay, by a person', () => {
  it('holds an entry until its day is approved', async () => {
    const entry = (await w.entries(w.P.P2!)).DAY!
    const error = await w.no('hr', 'POST', `${entryUrl(entry.id)}/approve`, { version: entry.version }, 409)
    expect(pathsOf(error)).toEqual(expect.arrayContaining(['refusal/HELD', 'holds/DAY_NOT_APPROVED']))
  })

  it('a decision names a person: the system may compute, never decide (D.Lgs. 152/1997 art. 1-bis)', () => {
    expect(() => assertPersonDecides(systemContext(w.T.tenant, 'ot-test'), 'OVERTIME_DECISION')).toThrow(/made by a person/)
    expect(() => assertPersonDecides(systemContext(w.T.tenant, 'ot-test'), 'TIMESHEET_APPROVAL')).toThrow(/made by a person/)
  })

  it('approves on an approved day, with who and when, and tells no figure in the event', async () => {
    await approveDay(w.P.P2!)
    const entry = (await w.entries(w.P.P2!)).DAY!
    const stale = await w.no('hr', 'POST', `${entryUrl(entry.id)}/approve`, { version: entry.version + 3 }, 409)
    expect(stale.message).toContain('changed since you read it')
    const record = await w.ok('hr', 'POST', `${entryUrl(entry.id)}/approve`, { version: entry.version })
    expect(record).toMatchObject({ status: 'APPROVED', decision: { rejectReason: null }, actions: { approve: false, reopen: true } })
    expect((await w.entries(w.P.P2!)).DAY).toMatchObject({ status: 'APPROVED', approvedById: w.sessions.hr!.audience === 'office' ? (w.sessions.hr as Json).actorId : null })
    const events = await w.admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'overtime_entry.changed' ORDER BY "occurredAt", id`, [w.T.tenant])
    expect(events.at(-1)!.payload).toMatchObject({ entryId: entry.id, status: 'APPROVED', change: 'APPROVED', kind: 'DAY' })
    expect(keysOf(events.map((event) => event.payload))).not.toContain('minutes')
  })

  it('never decides about one’s own overtime', async () => {
    const e2 = w.people.employeeIds.e2
    await w.roster(e2, D, [360, 840])
    await w.clock(e2, 'IN', local('06:00'))
    await w.clock(e2, 'OUT', local('15:00'))
    await w.pass(D)
    await w.compute(e2, D)
    await approveDay(e2)
    const entry = (await w.entries(e2)).DAY!
    const error = await w.no('self', 'POST', `${entryUrl(entry.id)}/approve`, { version: entry.version }, 409)
    expect(pathsOf(error)).toContain('holds/OWN_OVERTIME')
    await w.ok('hr2', 'POST', `${entryUrl(entry.id)}/approve`, { version: entry.version })
  })

  it('rejects with a reason (not paid), and a decision can be taken back', async () => {
    const { P } = w
    await approveDay(P.P4!)
    const entry = (await w.entries(P.P4!)).DAY!
    await w.no('hr', 'POST', `${entryUrl(entry.id)}/reject`, { version: entry.version, reason: ' ' }, 400)
    const rejected = await w.ok('hr', 'POST', `${entryUrl(entry.id)}/reject`, { version: entry.version, reason: 'Clock-out forgotten, not worked' })
    expect(rejected).toMatchObject({ status: 'REJECTED', decision: { rejectReason: 'Clock-out forgotten, not worked' } })
    const pending = await w.ok('hr', 'POST', `${entryUrl(entry.id)}/reopen`, { version: rejected.version, reason: 'The lead confirms the hours' })
    expect(pending).toMatchObject({ status: 'PENDING', decision: { rejectReason: null } })
    const audit = await w.admin<{ reason: string }>(`SELECT reason FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'people.reopenOvertimeEntry' AND "recordId" = $2`, [w.T.tenant, entry.id])
    expect(audit[0]!.reason).toBe('The lead confirms the hours')
  })

  it('holds an approval a blocking limit breaks, with the law in words, until a person says why it stands', async () => {
    const { P, T } = w
    await w.ok('hr', 'PUT', '/people/limits', { companyId: T.companyA, siteId: T.siteA1, kind: 'OVERTIME_YEARLY_CAP', version: null, limitMinutes: 60, action: 'BLOCK', alertRoles: [], source: 'LAW', legalReference: 'D.Lgs. 66/2003 art. 5' })
    const entry = (await w.entries(P.P4!)).DAY!
    const error = await w.no('hr', 'POST', `${entryUrl(entry.id)}/approve`, { version: entry.version }, 409)
    expect(pathsOf(error)).toEqual(expect.arrayContaining(['refusal/LIMIT_BLOCKED', 'limits/OVERTIME_YEARLY_CAP']))
    expect(error.message).toContain('D.Lgs. 66/2003 art. 5')
    const done = await w.ok('hr', 'POST', `${entryUrl(entry.id)}/approve`, { version: entry.version, overrideReason: 'Worked on the urgent order, hours are due' })
    expect(done.status).toBe('APPROVED')
    const audit = await w.admin<{ reason: string }>(`SELECT reason FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'people.approveOvertimeEntry' AND "recordId" = $2`, [T.tenant, entry.id])
    expect(audit[0]!.reason).toBe('Worked on the urgent order, hours are due')
    const rule = (await w.admin<Json>(`SELECT id, version FROM "WorkingTimeRule" WHERE "tenantId" = $1 AND "siteId" = $2 AND kind = 'OVERTIME_YEARLY_CAP' AND status = 'ACTIVE'`, [T.tenant, T.siteA1]))[0]!
    await w.ok('hr', 'POST', `/people/limits/${rule.id}/archive`, { version: rule.version })
  })

  it('takes a decision back when a reopened day changes the figures: paid only on what a person saw', async () => {
    const { P } = w
    const entry = (await w.entries(P.P2!)).DAY!
    const day = await w.day(P.P2!)
    await w.ok('hr', 'POST', `${dayUrl(day.id)}/reopen`, { version: day.version, reason: 'The clock-out was an hour early' })
    const open = await w.day(P.P2!)
    await w.ok('hr', 'POST', `${dayUrl(day.id)}/fix`, { version: open.version, action: { kind: 'VOID_EVENT', clockEventId: P.P2out }, reason: 'Wrong clock-out' })
    const voided = await w.day(P.P2!)
    await w.ok('hr', 'POST', `${dayUrl(day.id)}/fix`, { version: voided.version, action: { kind: 'ADD_EVENT', event: 'OUT', at: local('15:00').toISOString() }, reason: 'The real clock-out' })
    expect(await w.compute(P.P2!, D)).toBe(true)
    expect((await w.entries(P.P2!)).DAY).toMatchObject({ id: entry.id, minutes: 60, status: 'PENDING', approvedById: null })
    expect((await w.admin(`SELECT id FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'people.takeBackOvertime' AND "recordId" = $2`, [w.T.tenant, entry.id])).length).toBe(1)
    await approveDay(P.P2!)
    const again = (await w.entries(P.P2!)).DAY!
    await w.ok('hr', 'POST', `${entryUrl(again.id)}/approve`, { version: again.version })
  })
})

describe('from a planned request: the worker agreed, a person approved, and DONE once it is decided', () => {
  it('links the entry, shows what was asked, and closes the request', async () => {
    const { P, T } = w
    const requestId = newId()
    await w.admin(`INSERT INTO "OvertimeRequest" (id, "tenantId", "companyId", "siteId", date, minutes, reason, status) VALUES ($1, $2, $3, $4, $5::date, 60, 'Made-up rush', 'DRAFT')`, [requestId, T.tenant, T.companyA, T.siteA1, D2])
    await w.admin(`INSERT INTO "OvertimeAgreement" (id, "tenantId", "siteId", "requestId", "employeeId", answer) VALUES ($1, $2, $3, $4, $5, 'PENDING')`, [newId(), T.tenant, T.siteA1, requestId, P.P3])
    await w.admin(`UPDATE "OvertimeRequest" SET status = 'ASKED', "askedAt" = now(), "askedById" = $2 WHERE id = $1`, [requestId, T.actor])
    await w.admin(`UPDATE "OvertimeAgreement" SET answer = 'AGREED', "answeredAt" = now(), "answeredVia" = 'OFFICE', "answeredById" = $2 WHERE "requestId" = $1`, [requestId, T.actor])
    await w.admin(`UPDATE "OvertimeRequest" SET status = 'AGREED' WHERE id = $1`, [requestId])
    await w.admin(`UPDATE "OvertimeRequest" SET status = 'APPROVED', "approvedAt" = now(), "approvedById" = $2 WHERE id = $1`, [requestId, T.actor])
    await w.roster(P.P3!, D2, [360, 840])
    await w.clock(P.P3!, 'IN', local('06:00', D2))
    await w.clock(P.P3!, 'OUT', local('16:00', D2))
    await w.pass(D2)
    await w.compute(P.P3!, D2)
    const entry = (await w.entries(P.P3!, D2)).DAY!
    expect(entry).toMatchObject({ minutes: 120, requestId })
    await approveDay(P.P3!, D2)
    const record = await w.ok('hr', 'GET', entryUrl(entry.id))
    expect(record).toMatchObject({ request: { id: requestId, minutes: 60, status: 'APPROVED' }, beyondRequestMinutes: 60 })
    expect((await w.ok('viewer', 'GET', `${entriesUrl()}&planned=true`)).entries.map((row: Json) => row.id)).toEqual([entry.id])
    await w.ok('hr', 'POST', `${entryUrl(entry.id)}/approve`, { version: entry.version })
    expect((await w.admin(`SELECT status FROM "OvertimeRequest" WHERE id = $1`, [requestId]))[0]).toMatchObject({ status: 'DONE' })
    const events = await w.admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'overtime_request.changed'`, [T.tenant])
    expect(events.map((event) => event.payload.change)).toContain('DONE')
  })
})

describe('timesheets: the lead, then HR, nobody their own', () => {
  let sheets: Record<string, string>

  beforeAll(async () => {
    // P4's absence on the day after, kept for the lead's view of it.
    const codes = await w.ok('hr', 'GET', '/people/attendance/absence-codes')
    const sick = (codes.codes as Json[]).find((code) => code.code === 'MAL')!
    await w.ok('hr', 'POST', '/people/attendance/entries', { employeeId: w.P.P4, date: D1, absence: { codeId: sick.id, minutes: 480, documentRef: 'PROT-1' }, reason: 'Certificate received' }, 201)
    const day = await w.day(w.P.P4!, D1)
    await w.ok('hr', 'POST', `${dayUrl(day.id)}/approve`, { version: day.version })
  })

  it('HR prepares a month for the people with attendance, once', async () => {
    const first = await w.ok('hr', 'POST', '/people/timesheets/prepare', { siteId: w.T.siteA1, month: MONTH })
    expect(first.created).toBeGreaterThanOrEqual(5)
    expect(await w.ok('hr', 'POST', '/people/timesheets/prepare', { siteId: w.T.siteA1, month: MONTH })).toMatchObject({ created: 0 })
    await w.no('lead', 'POST', '/people/timesheets/prepare', { siteId: w.T.siteA1, month: MONTH }, 403)
    const rows = await w.admin<{ id: string; employeeId: string }>(`SELECT id, "employeeId" FROM "TimesheetApproval" WHERE "tenantId" = $1 AND "periodStart" = $2::date`, [w.T.tenant, `${MONTH}-01`])
    sheets = Object.fromEntries(rows.map((row) => [row.employeeId, row.id]))
    expect(sheets[w.P.P2!]).toBeDefined()
  })

  it('lists states only: no name, no minutes; a lead sees the teams they lead; a person key is refused', async () => {
    const all = await w.ok('hr', 'GET', `/people/timesheets?siteId=${w.T.siteA1}&month=${MONTH}`)
    expect(all.timesheets.length).toBeGreaterThanOrEqual(5)
    expect(all).toMatchObject({ canPrepare: true })
    const keys = keysOf(all)
    for (const word of ['name', 'employeeId', 'displayName', 'presentMinutes', 'minutes']) expect(keys).not.toContain(word)
    expect(JSON.stringify(all)).not.toContain('(made up)')
    const led = await w.ok('lead', 'GET', `/people/timesheets?siteId=${w.T.siteA1}&month=${MONTH}`)
    expect(led.timesheets.map((row: Json) => row.id)).toEqual(expect.arrayContaining([sheets[w.P.P2!]]))
    expect(led.timesheets.map((row: Json) => row.id)).not.toContain(sheets[w.people.employeeIds.e2])
    expect(led).toMatchObject({ canPrepare: false })
    expect((await w.ok('otherLead', 'GET', `/people/timesheets?siteId=${w.T.siteA1}&month=${MONTH}`)).timesheets).toEqual([])
    expect(pathsOf(await w.no('hr', 'GET', `/people/timesheets?siteId=${w.T.siteA1}&employeeId=${w.P.P2}`, undefined, 400))).toContain('query/filters/employeeId')
  })

  it('shows HR the hours; shows a lead the days, no minutes, and an absence with no code (GDPR art. 9)', async () => {
    const id = sheets[w.P.P4!]!
    const hr = await w.ok('hr', 'GET', sheetUrl(id))
    expect(hr).toMatchObject({ figuresShown: true, person: { name: 'Dario Quattro (made up)' }, status: 'PENDING', stage: 'LEAD' })
    expect(hr.summary).toMatchObject({ daysPresent: 1, overtimeApprovedMinutes: 90 })
    expect((hr.days as Json[]).find((day) => day.date === D1)).toMatchObject({ absent: true, absences: [{ code: 'MAL', category: 'SICKNESS', minutes: 480 }] })
    const lead = await w.ok('lead', 'GET', sheetUrl(id))
    expect(lead).toMatchObject({ figuresShown: false, summary: null, person: { name: 'Dario Quattro (made up)' } })
    expect((lead.days as Json[]).find((day) => day.date === D1)).toMatchObject({ absent: true, figures: null, absences: null, overtime: null })
    expect(JSON.stringify(lead)).not.toContain('MAL')
    expect(JSON.stringify(lead)).not.toContain('PROT-1')
    expect(lead.words[0]).toContain('The hours stay with HR')
    // Holds no permission over this person's team, and is no reader: not told.
    await w.no('otherLead', 'GET', sheetUrl(id), undefined, 404)
    await w.no('companyB', 'GET', sheetUrl(id), undefined, 404)
  })

  it('holds the lead while a day is open or overtime waits, in words', async () => {
    const id = sheets[w.P.P1!]!
    const sheet = await w.ok('hr', 'GET', sheetUrl(id))
    const error = await w.no('manager', 'POST', `${sheetUrl(id)}/lead-approve`, { version: sheet.version }, 409)
    expect(pathsOf(error)).toEqual(expect.arrayContaining(['refusal/HELD', 'holds/DAYS_OPEN', 'holds/OVERTIME_PENDING']))
  })

  it('goes lead → HR, two people, and refuses the wrong person at each step', async () => {
    const id = sheets[w.P.P2!]!
    const sheet = await w.ok('hr', 'GET', sheetUrl(id))
    expect(sheet).toMatchObject({ actions: { leadApprove: false, hrApprove: false } })
    await w.no('otherLead', 'POST', `${sheetUrl(id)}/lead-approve`, { version: sheet.version }, 404)
    await w.no('viewer', 'POST', `${sheetUrl(id)}/lead-approve`, { version: sheet.version }, 403)
    await w.no('lead', 'POST', `${sheetUrl(id)}/hr-approve`, { version: sheet.version }, 403)
    const held = await w.no('hr', 'POST', `${sheetUrl(id)}/hr-approve`, { version: sheet.version }, 409)
    expect(pathsOf(held)).toContain('holds/WRONG_STAGE')
    const led = await w.ok('lead', 'POST', `${sheetUrl(id)}/lead-approve`, { version: sheet.version })
    expect(led).toMatchObject({ status: 'LEAD_APPROVED', stage: 'HR', figuresShown: false })
    const done = await w.ok('hr', 'POST', `${sheetUrl(id)}/hr-approve`, { version: led.version })
    expect(done).toMatchObject({ status: 'APPROVED', stage: 'DONE', figuresShown: true })
    expect(keysOf((await w.admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type LIKE 'timesheet.%'`, [w.T.tenant])).map((row) => row.payload))).not.toContain('minutes')
  })

  it('never lets the same person give both approvals, in words before the database refuses', async () => {
    const id = sheets[w.P.P4!]!
    const sheet = await w.ok('hr', 'GET', sheetUrl(id))
    w.sessions.both = { ...w.sessions.hr!, grants: [...(w.sessions.hr as Json).grants, ...(w.sessions.manager as Json).grants], actorId: newId() } as never
    const led = await w.ok('both', 'POST', `${sheetUrl(id)}/lead-approve`, { version: sheet.version })
    const held = await w.no('both', 'POST', `${sheetUrl(id)}/hr-approve`, { version: led.version }, 409)
    expect(pathsOf(held)).toContain('holds/SAME_PERSON')
    await w.ok('hr', 'POST', `${sheetUrl(id)}/hr-approve`, { version: led.version })
  })

  it('nobody approves their own timesheet', async () => {
    const id = sheets[w.people.employeeIds.e2]!
    const sheet = await w.ok('self', 'GET', sheetUrl(id))
    w.sessions.selfManager = { ...w.sessions.self!, grants: [...(w.sessions.manager as Json).grants] } as never
    const error = await w.no('selfManager', 'POST', `${sheetUrl(id)}/lead-approve`, { version: sheet.version }, 409)
    expect(pathsOf(error)).toContain('holds/OWN_TIMESHEET')
  })

  it('freezes what it covers: a day or a decision moves only after it is sent back, with the reason', async () => {
    const id = sheets[w.P.P2!]!
    const day = await w.day(w.P.P2!)
    expect(pathsOf(await w.no('hr', 'POST', `${dayUrl(day.id)}/reopen`, { version: day.version, reason: 'Another fix' }, 409))).toContain('refusal/TIMESHEET_APPROVED')
    const entry = (await w.entries(w.P.P2!)).DAY!
    expect(pathsOf(await w.no('hr', 'POST', `${entryUrl(entry.id)}/reopen`, { version: entry.version, reason: 'Another look' }, 409))).toContain('refusal/TIMESHEET_APPROVED')
    const sheet = await w.ok('hr', 'GET', sheetUrl(id))
    await w.no('hr', 'POST', `${sheetUrl(id)}/send-back`, { version: sheet.version, reason: ' ' }, 400)
    await w.no('lead', 'POST', `${sheetUrl(id)}/send-back`, { version: sheet.version, reason: 'Hours look wrong' }, 403)
    const back = await w.ok('hr', 'POST', `${sheetUrl(id)}/send-back`, { version: sheet.version, reason: 'The lead asked to look again' })
    expect(back).toMatchObject({ status: 'PENDING', stage: 'LEAD', lead: { approvedBy: null }, hr: { approvedBy: null }, returned: { reason: 'The lead asked to look again' } })
    await w.ok('hr', 'POST', `${dayUrl(day.id)}/reopen`, { version: day.version, reason: 'Another fix' })
    await approveDay(w.P.P2!)
  })

  it('stops at the gate too: switched off, a read and an approval are refused', async () => {
    const id = sheets[w.P.P3!]!
    await w.closeGate()
    expect(pathsOf(await w.no('hr', 'GET', sheetUrl(id), undefined, 409))).toContain('gate/ATTENDANCE')
    expect(pathsOf(await w.no('manager', 'POST', `${sheetUrl(id)}/lead-approve`, { version: 1 }, 409))).toContain('gate/ATTENDANCE')
    const entry = (await w.entries(w.P.P1!)).NIGHT!
    expect(pathsOf(await w.no('hr', 'POST', `${entryUrl(entry.id)}/approve`, { version: entry.version }, 409))).toContain('gate/ATTENDANCE')
  })
})
