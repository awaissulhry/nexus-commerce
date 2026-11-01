import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { badgeCodeHash, newBadgeCode } from '@nexus/factory-domain/auth/floor/badge'
import { hashPin } from '@nexus/factory-domain/auth/floor/pin'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedLabour, type LabourSeed } from '../../../../../../packages/factory-db/seed/labour'
import { seed as seedTime } from '../../../../../../packages/factory-db/seed/time'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { DEVICE_COOKIE } from '../../../platform/auth/floor/cookies'
import { floorHash, mintSiteToken } from '../../../platform/auth/floor/tokens'
import { Browser, startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { runAutoClockOut } from './auto'

/**
 * Clock in and out (B-W2b-33; MES-223 clock in and out, MES-224 breaks, MES-227 automatic clock-out, MES-239 forgot badge,
 * MES-199 offline clock-in and clock-out) through the app's real routes, the real floor sign-in and the FLOOR database
 * role (row-level security, the grants and the …_time_w2b_guards triggers are real), on a throwaway PostgreSQL 17 from
 * the migrations with the factory-db seeds up to time and attendance and floor work: plant A1 (company A, names workers;
 * company A's September 2026 attendance is CLOSED), plant B1 (company B). Made-up tablets, badges and PINs. A1's
 * ATTENDANCE gate is switched on in the test (counsel's made-up opinion); B1's stays off. Every name and value is made up.
 *
 * The law the tests name: Statuto dei Lavoratori (L. 300/1970) art. 4 c.2-3 — attendance is recorded only where the site's
 * ATTENDANCE gate is on (the worker notice and the impact assessment on record); GDPR art. 9 — no biometrics: a badge, or a
 * name and PIN; D.Lgs. 66/2003 art. 8 — breaks fixed or clocked.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/people/clock`.
 */

let h: Harness
let labour: LabourSeed

const NS = 'w2b33-clock'
const idOf = (key: string) => seedUuid(NS, key)
const firstId = (key: string) => `00000000${idOf(key).slice(8)}`
const T = idOf('tenant')
const companyA = idOf('company:A')
const companyB = idOf('company:B')
const siteA1 = idOf('site:A1')
const siteB1 = idOf('site:B1')
const sew1 = idOf('site:A1:station:SEW-01')
const operator = idOf('worker:A1:operator')
const lead = idOf('worker:A1:lead')
const b1Operator = idOf('worker:B1:operator')
const e1 = firstId('people:employee:A1:1')
const e2 = idOf('people:employee:A1:2')
const e3 = idOf('people:employee:A1:3')
const eb1 = idOf('people:employee:B1:1')
const PIN = '583014'
const badges = { operator: newBadgeCode(), lead: newBadgeCode(), b1: newBadgeCode() }
const tablets = { kiosk: newId(), sew: newId(), lead: newId(), b1: newId(), board: newId(), phone: newId() }
const tokens: Record<keyof typeof tablets, string> = { kiosk: '', sew: '', lead: '', b1: '', board: '', phone: '' }
const lineL1 = idOf('site:A1:line:L1')

type Json = Record<string, any>
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const run = randomBytes(4).toString('hex')
let serial = 0
const evt = (name: string) => `clk-${run}-${name}-${++serial}`
const issuesOf = (body: Json): string[] => (body?.error?.issues ?? []).map((issue: { path: string }) => issue.path)
const clockRows = (employeeId: string) => admin('SELECT id, kind::text AS kind, source::text AS source, flags::text[] AS flags, "occurredAt", "deviceTime", "workerId", "deviceId", reason FROM "ClockEvent" WHERE "tenantId" = $1 AND "employeeId" = $2 ORDER BY "occurredAt", id', [T, employeeId])
/** The events of this test's tablets (the time seed has its own history for the seeded people). */
const fromTablets = async (employeeId: string) => (await clockRows(employeeId)).filter((row) => (Object.values(tablets) as string[]).includes(row.deviceId))
const outbox = (type: string, subject: string) => admin<{ payload: Json }>('SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 AND subject = $3 ORDER BY "occurredAt", id', [T, type, subject])
const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000)
const ROME = 'Europe/Rome'
/** Minutes from the local midnight in Rome (the seeded sites' time zone). */
const localMinute = (at: Date) => {
  const [hour, minute] = new Intl.DateTimeFormat('en-GB', { timeZone: ROME, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at).split(':').map(Number)
  return hour! * 60 + minute!
}

/** A tablet's browser: its device token, the CSRF cookie. */
async function tablet(name: keyof typeof tablets): Promise<Browser> {
  const browser = new Browser(h.app)
  browser.cookies.set(DEVICE_COOKIE, tokens[name])
  await browser.get('/auth/csrf')
  return browser
}

let kiosk: Browser
let sew: Browser
let leadTablet: Browser
let b1: Browser
let board: Browser
let phone: Browser

beforeAll(async () => {
  h = await startHarness('people_clock')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedTime({ db: h.database, namespace: NS })
  labour = await seedLabour({ db: h.database, namespace: NS })
  const device = (id: string, company: string, site: string, station: string | null, name: string, key: keyof typeof tablets) => {
    const token = mintSiteToken(T, site, id)
    tokens[key] = token.value
    return admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt", "tokenHash") VALUES ($1, $2, $3, $4, $5, $6, 'TABLET', 'ACTIVE', now(), $7)`, [id, T, company, site, station, name, floorHash(token.value)])
  }
  await device(tablets.kiosk, companyA, siteA1, null, 'Entrance kiosk', 'kiosk')
  await device(tablets.sew, companyA, siteA1, sew1, 'Sewing tablet 1', 'sew')
  await device(tablets.lead, companyA, siteA1, null, 'Lead tablet', 'lead')
  await device(tablets.b1, companyB, siteB1, null, 'B1 kiosk', 'b1')
  // B-W2b-52 device modes: A1's line board (DISPLAY) and the made-up team leader's own phone (PHONE).
  await device(tablets.board, companyA, siteA1, null, 'Line 1 board', 'board')
  await admin(`UPDATE "Device" SET mode = 'DISPLAY', "lineId" = $2 WHERE id = $1`, [tablets.board, lineL1])
  await device(tablets.phone, companyA, siteA1, null, 'Lead phone', 'phone')
  await admin(`UPDATE "Device" SET mode = 'PHONE', kind = 'HANDHELD', "personalWorkerId" = $2 WHERE id = $1`, [tablets.phone, lead])
  const pinHash = await hashPin(PIN, h.auth.pins, { logN: 12, r: 8, p: 1 })
  for (const [worker, code] of [[operator, badges.operator], [lead, badges.lead], [b1Operator, badges.b1]] as const) {
    await admin('UPDATE "Worker" SET "pinHash" = $2, "failedPinAttempts" = 0, "pinLockedUntil" = NULL WHERE id = $1', [worker, pinHash])
    await admin('UPDATE "Badge" SET "codeHash" = $2, status = \'ACTIVE\' WHERE "workerId" = $1', [worker, badgeCodeHash(code)])
  }
  kiosk = await tablet('kiosk')
  sew = await tablet('sew')
  leadTablet = await tablet('lead')
  b1 = await tablet('b1')
  board = await tablet('board')
  phone = await tablet('phone')
}, 600_000)

afterAll(async () => {
  await h?.close()
})

/** Switches A1's ATTENDANCE purpose on, as the Owner would with the notice and the impact assessment on record. */
async function openAttendanceAtA1(): Promise<void> {
  const notice = (await admin<{ id: string }>(`SELECT id FROM "PrivacyNotice" WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = 'WORKER_FLOOR' AND status = 'PUBLISHED'`, [T, companyA]))[0]!.id
  const dpia = (await admin<{ id: string }>(`SELECT id FROM "PrivacyDpia" WHERE "tenantId" = $1 AND "companyId" = $2 AND status = 'STORED'`, [T, companyA]))[0]!.id
  await admin(
    `INSERT INTO "PeopleLegalGate" (id, "tenantId", "companyId", "siteId", purpose, basis, "basisReference", "noticeId", "dpiaId", "switchedOnAt", "switchedOnById", "updatedAt")
     VALUES ($1, $2, $3, $4, 'ATTENDANCE', 'NOT_REQUIRED', 'SAMPLE - made-up counsel opinion (art. 4 c.2)', $5, $6, now() - interval '1 minute', $7, now())`,
    [newId(), T, companyA, siteA1, notice, dpia, idOf('actor')],
  )
}

describe('the legal gate: nothing is clocked or read while ATTENDANCE is off (Statuto dei Lavoratori art. 4 c.2-3)', () => {
  it('refuses a badge at the kiosk and the floor clock in words, and records nothing', async () => {
    const scan = await kiosk.post('/people/clock/scan', { clientEventId: evt('closed'), badgeCode: badges.operator })
    expect(scan.status, JSON.stringify(scan.body)).toBe(409)
    expect(issuesOf(scan.body)).toEqual(['gate/ATTENDANCE'])
    expect(scan.body.error.message).toContain('art. 4 c.2')
    const atB1 = await b1.post('/people/clock/scan', { clientEventId: evt('b1'), badgeCode: badges.b1 })
    expect(issuesOf(atB1.body)).toEqual(['gate/ATTENDANCE'])
    // The gate is asked before any credential: a wrong badge answers the same refusal, never a 401 that tells it apart.
    expect(issuesOf((await kiosk.post('/people/clock/scan', { clientEventId: evt('closed2'), badgeCode: newBadgeCode() })).body)).toEqual(['gate/ATTENDANCE'])
    expect(await fromTablets(e1)).toHaveLength(0)
    expect(await outbox('attendance.clock_event', e1)).toHaveLength(0)
    // The signed-in worker's own clock is closed too: neither read nor written.
    const signIn = await b1.post('/floor/sign-in', { badgeCode: badges.b1, pin: PIN })
    expect(signIn.status, JSON.stringify(signIn.body)).toBe(200)
    expect(issuesOf((await b1.get('/people/clock/floor')).body)).toEqual(['gate/ATTENDANCE'])
    expect(issuesOf((await b1.post('/people/clock/floor', { clientEventId: evt('b1-floor'), action: 'IN' })).body)).toEqual(['gate/ATTENDANCE'])
    expect(await fromTablets(eb1)).toHaveLength(0)
  })
})

describe('clocking at the kiosk: a badge, or a name and PIN (MES-223, MES-239; no biometrics, GDPR art. 9)', () => {
  beforeAll(async () => {
    await openAttendanceAtA1()
  })

  it('a badge alone clocks in at the server time; the same tablet event answers once; a second scan within a minute repeats it', async () => {
    const first = evt('in')
    const scan = await kiosk.post('/people/clock/scan', { clientEventId: first, badgeCode: badges.operator })
    expect(scan.status, JSON.stringify(scan.body)).toBe(201)
    expect(scan.body).toMatchObject({ repeated: false, event: { kind: 'IN', source: 'BADGE', flags: [], flagged: false }, clock: { state: 'IN', person: { workerId: operator, employeeId: e1 }, next: 'OUT' } })
    expect(scan.body.words).toMatch(/^Clocked in at \d\d:\d\d\.$/)
    expect(Math.abs(new Date(scan.body.event.occurredAt).getTime() - Date.now())).toBeLessThan(60_000)
    const again = await kiosk.post('/people/clock/scan', { clientEventId: first, badgeCode: badges.operator })
    expect(again.status).toBe(200)
    expect(again.body.event.id).toBe(scan.body.event.id)
    const twice = await kiosk.post('/people/clock/scan', { clientEventId: evt('in-twice'), badgeCode: badges.operator })
    expect(twice.status).toBe(200)
    expect(twice.body).toMatchObject({ repeated: true, event: { id: scan.body.event.id } })
    const rows = await fromTablets(e1)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'IN', source: 'BADGE', workerId: operator, deviceId: tablets.kiosk })
    // The person is the actor of their own command; the tablet is on the audit row; the code never is.
    const [audit] = await admin(`SELECT audience::text, "actorId"::text AS actor, "deviceId"::text AS device, after::text AS after FROM "AuditLog" WHERE action = 'people.clock' AND "recordId" = $1`, [rows[0]!.id])
    expect(audit).toMatchObject({ audience: 'FLOOR', actor: operator, device: tablets.kiosk })
    const [event] = await outbox('attendance.clock_event', e1)
    expect(event!.payload).toEqual({ clockEventId: rows[0]!.id, siteId: siteA1, employeeId: e1, kind: 'IN', source: 'BADGE', flagged: false })
  })

  it('refuses a wrong badge and a name without its PIN in one uniform way, counting a wrong PIN', async () => {
    const wrong = await kiosk.post('/people/clock/scan', { clientEventId: evt('wrong'), badgeCode: newBadgeCode() })
    expect(wrong.status).toBe(401)
    expect((await kiosk.post('/people/clock/scan', { clientEventId: evt('nopin'), workerId: lead })).status).toBe(400)
    const badPin = await kiosk.post('/people/clock/scan', { clientEventId: evt('badpin'), workerId: lead, pin: '000000' })
    expect(badPin.status).toBe(401)
    expect(badPin.body.error.message).toBe(wrong.body.error.message)
    expect((await admin('SELECT "failedPinAttempts" FROM "Worker" WHERE id = $1', [lead]))[0]!.failedPinAttempts).toBe(1)
    expect(await fromTablets(e2)).toHaveLength(0)
  })

  it('forgot the badge: name and PIN clock in, flagged for the team leader; the right PIN clears the wrong-PIN count', async () => {
    const scan = await kiosk.post('/people/clock/scan', { clientEventId: evt('forgot'), workerId: lead, pin: PIN })
    expect(scan.status, JSON.stringify(scan.body)).toBe(201)
    expect(scan.body).toMatchObject({ event: { kind: 'IN', source: 'NAME_PIN', flags: ['FORGOT_BADGE'], flagged: true }, clock: { state: 'IN', person: { workerId: lead, employeeId: e2 } } })
    expect((await admin('SELECT "failedPinAttempts" FROM "Worker" WHERE id = $1', [lead]))[0]!.failedPinAttempts).toBe(0)
    expect((await outbox('attendance.clock_event', e2))[0]!.payload).toMatchObject({ source: 'NAME_PIN', flagged: true })
  })

  it('follows the device modes (B-W2b-52): nobody clocks on a line board; a personal phone clocks only its own person', async () => {
    const onBoard = await board.post('/people/clock/scan', { clientEventId: evt('board'), badgeCode: badges.operator })
    expect(onBoard.status, JSON.stringify(onBoard.body)).toBe(403)
    expect(onBoard.body.error.message).toContain('line board')
    const otherOnPhone = await phone.post('/people/clock/scan', { clientEventId: evt('phone-other'), badgeCode: badges.operator })
    expect(otherOnPhone.status, JSON.stringify(otherOnPhone.body)).toBe(403)
    expect(otherOnPhone.body.error.message).toContain('one person')
    expect((await fromTablets(e1)).filter((row) => row.deviceId === tablets.board || row.deviceId === tablets.phone)).toHaveLength(0)
    // Its own person passes the mode and reaches the clock's own rules (breaks are fixed here: refused in words).
    const own = await phone.post('/people/clock/scan', { clientEventId: evt('phone-own'), badgeCode: badges.lead, action: 'BREAK_OUT' })
    expect(issuesOf(own.body)).toEqual(['refusal/BREAKS_FIXED', 'fix'])
  })

  it('never keeps a badge code or a PIN in a receipt, an audit row or an event', async () => {
    for (const secret of [badges.operator, badges.lead, PIN]) {
      const [counts] = await admin(
        `SELECT (SELECT count(*) FROM "AuditLog" WHERE "tenantId" = $1 AND (after::text LIKE $2 OR before::text LIKE $2))::int AS audit,
                (SELECT count(*) FROM "IdempotencyReceipt" WHERE "tenantId" = $1 AND response::text LIKE $2)::int AS receipts,
                (SELECT count(*) FROM "OutboxEvent" WHERE "tenantId" = $1 AND payload::text LIKE $2)::int AS events`,
        [T, `%${secret}%`],
      )
      expect(counts).toEqual({ audit: 0, receipts: 0, events: 0 })
    }
  })
})

describe("the signed-in worker's clock: your time today, breaks and clock-out (MES-223, MES-224)", () => {
  let codes: LabourSeed['codeIds']

  beforeAll(async () => {
    codes = labour.codeIds
    // Today's published shift for the operator, around now (typed by hand: its break is not placed).
    const now = new Date()
    const day = businessDate(now, ROME)
    const start = Math.max(0, localMinute(now) - 120)
    await admin(
      `INSERT INTO "RosterEntry" (id, "tenantId", "companyId", "siteId", "employeeId", date, kind, "shiftLabel", "startMinute", "endMinute", "breakMinutes", status, "publishedAt", "publishedById", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6::date, 'WORK', 'Test shift', $7, $8, 30, 'PUBLISHED', now(), $9, now())
       ON CONFLICT ("tenantId", "employeeId", date) DO UPDATE SET kind = 'WORK', "shiftLabel" = 'Test shift', "startMinute" = $7, "endMinute" = $8, "breakMinutes" = 30, status = 'PUBLISHED', "publishedAt" = now(), "publishedById" = $9, "shiftPatternId" = NULL`,
      [newId(), T, companyA, siteA1, e1, day, start, start + 480, idOf('actor')],
    )
    const signIn = await sew.post('/floor/sign-in', { badgeCode: badges.operator, pin: PIN })
    expect(signIn.status, JSON.stringify(signIn.body)).toBe(200)
  })

  it('shows your time today: clocked in at the kiosk, the shift, fixed breaks, the buttons', async () => {
    const state = await sew.get('/people/clock/floor')
    expect(state.status, JSON.stringify(state.body)).toBe(200)
    expect(state.body.clock).toMatchObject({ state: 'IN', person: { workerId: operator }, actions: ['OUT'], next: 'OUT', breaks: { mode: 'FIXED', next: null, due: null }, shift: { label: 'Test shift', source: 'ROSTER' }, autoClockOutAt: null })
    expect(state.body.clock.words).toMatch(/^In since \d\d:\d\d · \d+ min today$/)
    expect(state.body.clock.events.map((row: Json) => row.kind)).toEqual(['IN'])
  })

  it('fixed breaks are never clocked (D.Lgs. 66/2003 art. 8); clocked ones go out and back in; a wrong button is refused in words', async () => {
    const fixed = await sew.post('/people/clock/floor', { clientEventId: evt('break-fixed'), action: 'BREAK_OUT' })
    expect(fixed.status).toBe(409)
    expect(issuesOf(fixed.body)).toEqual(['refusal/BREAKS_FIXED', 'fix'])
    await admin('UPDATE "PeopleSettings" SET "fixedBreaks" = false WHERE id = $1', [companyA])
    const out = await sew.post('/people/clock/floor', { clientEventId: evt('break-out'), action: 'BREAK_OUT' })
    expect(out.status, JSON.stringify(out.body)).toBe(201)
    expect(out.body).toMatchObject({ event: { kind: 'BREAK_OUT', source: 'BADGE', flags: [] }, clock: { state: 'ON_BREAK', actions: ['BREAK_IN', 'OUT'], breaks: { mode: 'CLOCKED' } } })
    expect(issuesOf((await sew.post('/people/clock/floor', { clientEventId: evt('in-on-break'), action: 'IN' })).body)).toEqual(['refusal/ON_BREAK', 'fix'])
    // A tap again at once (no action: the badge's toggle) repeats the break, never ends it.
    expect((await sew.post('/people/clock/floor', { clientEventId: evt('toggle') })).body).toMatchObject({ repeated: true, event: { kind: 'BREAK_OUT' } })
    const back = await sew.post('/people/clock/floor', { clientEventId: evt('break-in'), action: 'BREAK_IN' })
    expect(back.body).toMatchObject({ event: { kind: 'BREAK_IN' }, clock: { state: 'IN' } })
  })

  it("clocking out ends the worker's running off-standard block and tells the steps that listen (clock.out)", async () => {
    const started = await sew.post('/production/offstandard/floor/start', { clientEventId: evt('cleaning'), codeId: codes.CLEANING })
    expect(started.status, JSON.stringify(started.body)).toBe(201)
    const out = await sew.post('/people/clock/floor', { clientEventId: evt('out'), action: 'OUT' })
    expect(out.status, JSON.stringify(out.body)).toBe(201)
    expect(out.body).toMatchObject({ event: { kind: 'OUT' }, clock: { state: 'OUT', actions: ['IN'] } })
    expect(out.body.words).toMatch(/^Clocked out at \d\d:\d\d\.$/)
    const [block] = await admin('SELECT status::text AS status, "endedAt" FROM "OffStandardEntry" WHERE id = $1', [started.body.block.id])
    expect(block!.endedAt).not.toBeNull()
    expect(block!.status).not.toBe('OPEN')
    const ended = await outbox('production.off_standard_ended', started.body.block.id)
    expect(ended.at(-1)!.payload.endedBy).toBe('CLOCK_OUT')
    const [clockOut] = await outbox('clock.out', e1)
    expect(clockOut!.payload).toEqual({ clockEventId: out.body.event.id, siteId: siteA1, employeeId: e1, workerId: operator, source: 'BADGE' })
    expect(issuesOf((await sew.post('/people/clock/floor', { clientEventId: evt('out-twice'), action: 'OUT' })).body)).toEqual(['refusal/NOT_IN', 'fix'])
  })

  it('a worker signed in by name and PIN clocks NAME_PIN, flagged FORGOT_BADGE', async () => {
    const signIn = await leadTablet.post('/floor/sign-in', { workerId: lead, pin: PIN })
    expect(signIn.status, JSON.stringify(signIn.body)).toBe(200)
    const out = await leadTablet.post('/people/clock/floor', { clientEventId: evt('lead-out'), action: 'OUT' })
    expect(out.status, JSON.stringify(out.body)).toBe(201)
    expect(out.body.event).toMatchObject({ kind: 'OUT', source: 'NAME_PIN', flags: ['FORGOT_BADGE'] })
  })
})

describe('offline clocking with the tablet time (MES-199)', () => {
  it("keeps a queued clock-in at the tablet's time, flagged when its clock looked wrong; a resend is a duplicate", async () => {
    const deviceTime = minutesFromNow(-20).toISOString()
    const sentAt = minutesFromNow(-10).toISOString()
    const id = evt('queued-in')
    const send = await sew.post('/floor/sync', { sentAt, events: [{ clientEventId: id, seq: 1, kind: 'people.clock.record', occurredAt: deviceTime, workerId: operator, payload: { action: 'IN' } }] })
    expect(send.status, JSON.stringify(send.body)).toBe(200)
    expect(send.body.events[0]).toMatchObject({ status: 'accepted', result: { type: 'ClockEvent' } })
    const [row] = await admin('SELECT source::text AS source, flags::text[] AS flags, "occurredAt", "deviceTime" FROM "ClockEvent" WHERE id = $1', [send.body.events[0].result.id])
    expect(row).toMatchObject({ source: 'OFFLINE', flags: ['CLOCK_SKEW'] })
    expect(new Date(row!.occurredAt).toISOString()).toBe(deviceTime)
    const again = await sew.post('/floor/sync', { events: [{ clientEventId: id, seq: 2, kind: 'people.clock.record', occurredAt: deviceTime, workerId: operator, payload: { action: 'IN' } }] })
    expect(again.body.events[0]).toMatchObject({ status: 'duplicate', result: { id: send.body.events[0].result.id } })
  })

  it('refuses a time in the future, a day of a closed month and a payload without its action, each in words', async () => {
    const send = await sew.post('/floor/sync', {
      events: [
        { clientEventId: evt('future'), seq: 1, kind: 'people.clock.record', occurredAt: minutesFromNow(30).toISOString(), workerId: operator, payload: { action: 'OUT' } },
        { clientEventId: evt('closed-month'), seq: 2, kind: 'people.clock.record', occurredAt: '2026-09-15T07:00:00.000Z', workerId: operator, payload: { action: 'IN' } },
        { clientEventId: evt('bad'), seq: 3, kind: 'people.clock.record', occurredAt: minutesFromNow(-5).toISOString(), workerId: operator, payload: {} },
      ],
    })
    expect(send.status, JSON.stringify(send.body)).toBe(200)
    expect(send.body.events.map((event: Json) => [event.status, event.refusal?.code, event.refusal?.final])).toEqual([
      ['refused', 'CLOCK_AHEAD', true],
      ['refused', 'MONTH_CLOSED', true],
      ['refused', 'BAD_EVENT', true],
    ])
    expect(send.body.events[0].refusal.message).toContain('ahead')
  })

  it('a badge scanned at the kiosk while offline is sent later with the tablet time; a name and PIN never are', async () => {
    const deviceTime = minutesFromNow(-3).toISOString()
    const scan = await kiosk.post('/people/clock/scan', { clientEventId: evt('kiosk-offline'), badgeCode: badges.operator, action: 'OUT', occurredAt: deviceTime, sentAt: new Date().toISOString() })
    expect(scan.status, JSON.stringify(scan.body)).toBe(201)
    expect(scan.body.event).toMatchObject({ kind: 'OUT', source: 'OFFLINE', flags: [], occurredAt: deviceTime })
    expect(scan.body.words).toMatch(/^Saved on this tablet at \d\d:\d\d \(tablet time\)\.$/)
    const name = await kiosk.post('/people/clock/scan', { clientEventId: evt('kiosk-offline-name'), workerId: lead, pin: PIN, action: 'IN', occurredAt: deviceTime })
    expect(name.status).toBe(400)
    expect(issuesOf(name.body)).toEqual(['occurredAt'])
  })
})

describe('the automatic clock-out at the shift end (MES-227)', () => {
  it("closes an open clock-in at the shift end plus the company's tolerance, once, with the rule in words; never where the gate is off", async () => {
    // E3 (made-up agency worker of A1) clocked in by the lead's manual entry 10 hours ago; her published shift ended
    // 2.5 hours ago. EB1 at B1 likewise, but B1's ATTENDANCE gate is off.
    const shiftStart = minutesFromNow(-630)
    const day = businessDate(shiftStart, ROME)
    const start = localMinute(shiftStart)
    const inAt = minutesFromNow(-600)
    for (const [employee, company, site] of [[e3, companyA, siteA1], [eb1, companyB, siteB1]] as const) {
      await admin(
        `INSERT INTO "RosterEntry" (id, "tenantId", "companyId", "siteId", "employeeId", date, kind, "shiftLabel", "startMinute", "endMinute", "breakMinutes", status, "publishedAt", "publishedById", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6::date, 'WORK', 'Early', $7, $8, 0, 'PUBLISHED', now(), $9, now())
         ON CONFLICT ("tenantId", "employeeId", date) DO UPDATE SET kind = 'WORK', "shiftLabel" = 'Early', "startMinute" = $7, "endMinute" = $8, "breakMinutes" = 0, status = 'PUBLISHED', "publishedAt" = now(), "publishedById" = $9, "shiftPatternId" = NULL`,
        [newId(), T, company, site, employee, day, start, start + 480, idOf('actor')],
      )
      await admin(`INSERT INTO "ClockEvent" (id, "tenantId", "companyId", "siteId", "employeeId", kind, source, "occurredAt", "receivedAt", reason) VALUES ($1, $2, $3, $4, $5, 'IN', 'MANUAL', $6, $6, 'SAMPLE - entered by the lead (badge at home)')`, [newId(), T, company, site, employee, inAt])
    }
    await admin('UPDATE "PeopleSettings" SET "autoClockOutAfterMinutes" = 15 WHERE id IN ($1, $2)', [companyA, companyB])
    const log = { info() {}, warn() {}, error() {} }
    const first = await runAutoClockOut({ database: h.database, log })
    expect(first.failed).toBe(0)
    const rows = await clockRows(e3)
    expect(rows.map((row) => [row.kind, row.source])).toEqual([['IN', 'MANUAL'], ['OUT', 'AUTO']])
    const expected = shiftStart.getTime() + (480 + 15) * 60_000
    expect(Math.abs(new Date(rows[1]!.occurredAt).getTime() - expected)).toBeLessThan(60_000)
    expect(rows[1]!.reason).toMatch(/^Automatic clock-out: shift "Early" ended \d\d:\d\d \+ 15 min \(People settings\)\./)
    expect((await outbox('clock.out', e3))[0]!.payload).toMatchObject({ source: 'AUTO', workerId: null, siteId: siteA1 })
    // B1's gate is off: its open clock-in stays open (nothing of a person is processed there).
    expect((await clockRows(eb1)).filter((row) => row.source === 'AUTO' && new Date(row.occurredAt).getTime() > inAt.getTime())).toHaveLength(0)
    // A second pass closes nothing more.
    await runAutoClockOut({ database: h.database, log })
    expect(await clockRows(e3)).toHaveLength(2)
  })
})
