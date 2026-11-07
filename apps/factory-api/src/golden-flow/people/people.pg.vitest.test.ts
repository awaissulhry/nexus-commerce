import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { localInstant, plusDays } from '@nexus/factory-domain/calendars/dates'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { ErrorReport } from '@nexus/factory-domain/observability/report'
import { closePhrases } from '@nexus/factory-domain/people/close/rules'
import { monthAfter } from '@nexus/factory-domain/people/earnings/rules'
import { createErrorTracker, useErrorTracker } from '../../observability/tracker'
import type { Browser } from '../../platform/auth/sessions/testing/harness'
import type { EventHandler } from '../../platform/outbox/dispatch'
import { standardReasonsForNewTenants } from '../../platform/reasons/standard'
import type { SearchIndexer } from '../../platform/search/indexer'
import { indexNewTenants } from '../../platform/search/indexing'
import { admin, call, floorWorker, linkTokenSentTo, ok, person, QUIET, sha256, signOn, startWorld, stepped, tablet, type FloorWorker, type Person, type World } from '../testing/world'
import { assertEveryHandler, everyHandler, searchIndexers, settler } from '../daily/testing/day'

/**
 * The W2b-1 golden flow (B-W2b-72; design check I3): one shift on the floor and one month in People THROUGH THE HTTP ROUTES,
 * each act by the role that does it, on the seeded factory. People and floor records cross six modules (the clock, the labour
 * records, attendance, overtime and timesheets, the month close, pay, the payroll file); this suite proves two things:
 *
 *   1. A shift and a month agree across modules. Three people on line L1 work one day. What the clock, the scans, the
 *      off-standard blocks and the help call recorded comes back as the same minutes and pieces wherever a module shows them
 *      (`AGREED` below, worked out by hand): the attendance day, the overtime entry a person decided, the timesheet the lead then
 *      HR approved, the sealed LUL calendar, the report against production, the efficiency tiles, the earnings ledger, the
 *      statement, the locked pay period and the payroll file. Pay reads APPROVED OvertimeEntry rows only: two people stayed two
 *      hours, one had the overtime approved and one refused, and only the first is guaranteed those minutes. A closed day
 *      corrected leaves the seal alone and asks a correction export.
 *
 *      A  every purpose off: nothing is clocked or read; then the gates, the rates, piece pay, the skill, the roster, the cut
 *      B  the shift: clock in, dispatch with the qualification check, start / pause / resume / pieces so far / finish, a help
 *         call, off-standard time approved with the PIN, the others' one tap, clock out
 *      C  the day after: HR approves the days, a person decides the overtime, the line's day closes
 *      D  the month: the timesheets (lead then HR), the close with its phrase, the sealed LUL calendar
 *      E  the pay period: run, review, one statement each, locked with its phrase
 *      F  the payroll file: codes, checks, preview, sealed; it carries amounts, so it never goes by link (Owner 11-02, B-W2b-163):
 *         Send is refused in words and nothing is sent; HR opens the file (recorded) and hands it over another way
 *      G  a closed day corrected
 *
 *   2. The gate really closes (H, Statuto dei Lavoratori art. 4 c.1-2; Owner answer W1). The raw JSON of every read B-W2b-F3 and
 *      B-W2b-F4 closed is searched for every worker's id and name, and for the id and name of the employee behind them. With
 *      PERFORMANCE on each read must name somebody (or the test could not fail); with it off none may, and the answer says a
 *      person is on it; then on again and off again. With ATTENDANCE off the clock and the attendance reads refuse. With
 *      PERFORMANCE off piece pay is off: a scan pays nothing.
 *
 *      Out of scope, on the labour lawyer's list and left open on purpose (build notes B-W2b-F3, B-W2b-F4): GET /audit and
 *      /audit/:type/:id; quality signatures (/quality/inspections, /quality/releases, /quality/final, /quality/ncr); the floor
 *      lead's names on the floor's own reads (/production/calls/station, /floor/sync/conflicts, the lead's tablet lists);
 *      /production/calls/:id (a call for help, not a piece of work), /plant/*, /production/dispatch/* (assignment), and `deviceId`.
 *
 * The clock: every command's "now" is `Date`, pinned here with vi.useFakeTimers({ toFake: ['Date'] }): a shift of ten hours and
 * a month that ends need a clock that moves. The flow's month is the first whole month after today's and after every date the
 * seeds hold, and the days are counted from it (the 3rd, a Tuesday to Thursday from the 9th, the 3rd of the next month): away from
 * every month end, no national holiday, and no date here can pass. The harness clock (sessions, two-factor, presigned links) and
 * the database's own now() are not moved: only Date. The attendance cron is not run: days come from the worker's handlers, so
 * nobody else's default shift makes a day.
 *
 * World: the W1 golden world (../testing/world.ts: a throwaway PostgreSQL 17 database from the migrations, EVERY base seed plus the
 * W1 golden scenario, the real app with the real sign-in, every outside provider FAKE) and the W2a day's worker (../daily/testing/
 * day.ts: EVERY handler list of background.ts, run in-process by the real outbox relay). Each step is one test, in order. Every
 * name and figure is made up: the rates and the 9.00 an hour are the seeds' (seed/pay.ts), none is any CCNL's. Whole garments are
 * cut from SEED-HIDE-0001 by its one part ("Outer shell") with the area used: the seeds hold no other free leather. Run with
 * `node scripts/factory/golden-flow.mjs people`.
 */

let w: World
let handlers: readonly EventHandler[]
let indexers: readonly SearchIndexer[]
let settle: () => Promise<string[]>
type Role = 'owner' | 'hr' | 'supervisor' | 'manager'
const P = {} as Record<Role, Person>
type Json = Record<string, any>
type Who = 'one' | 'two' | 'three'
const WHO: readonly Who[] = ['one', 'two', 'three']
/** What the flow made, step by step. */
const G = {} as Record<string, any>
/** What the API reported as unexpected (a 500) during the flow: none at the end. */
const unexpected: ErrorReport[] = []
/** Every record the flow made: the end checks look for their audit rows. */
const made = new Set<string>()
const keep = (...ids: (string | undefined | null)[]) => ids.forEach((recordId) => recordId && made.add(recordId))
const ROME = 'Europe/Rome'
const id = (key: string) => w.id(key)
const siteA1 = () => id('site:A1')
const companyA = () => id('company:A')
const lineL1 = () => id('site:A1:line:L1')
const pathsOf = (error: Json): string[] => ((error?.issues ?? []) as Json[]).map((issue) => String(issue.path))

/**
 * The day as it must read everywhere, worked out by hand. The morning shift is 06:00-14:00 with 15 minutes' break, so 465 ordinary
 * minutes. Stayed until 16:00: 120 more. A piece of sewing pays 11.58 (96.5 standard minutes × 0.12) and earns 96.5 minutes.
 * Time off standard pays the person's average: 23.16 ÷ (585 − 30) minutes = 0.04173 a minute: 0.42 for 10 minutes, 0.83 for 20.
 * The guarantee is 9.00 an hour (0.15 a minute) on ordinary minutes plus APPROVED overtime; the make-up fills the gap.
 */
const AGREED: Record<Who, { readonly code: string; readonly present: number; readonly ordinary: number; readonly worked: number; readonly paidOvertime: number; readonly pieces: number; readonly earnedMinutes: string; readonly pieceAmount: number; readonly timeAmount: number; readonly earnings: number; readonly paidMinutes: number; readonly guaranteed: number; readonly makeUp: number }> = {
  one: { code: 'GOLD-001', present: 585, ordinary: 465, worked: 120, paidOvertime: 120, pieces: 2, earnedMinutes: '193.000', pieceAmount: 2316, timeAmount: 125, earnings: 2441, paidMinutes: 585, guaranteed: 8775, makeUp: 6334 },
  two: { code: 'GOLD-002', present: 585, ordinary: 465, worked: 120, paidOvertime: 0, pieces: 1, earnedMinutes: '96.500', pieceAmount: 1158, timeAmount: 0, earnings: 1158, paidMinutes: 465, guaranteed: 6975, makeUp: 5817 },
  three: { code: 'GOLD-003', present: 465, ordinary: 465, worked: 0, paidOvertime: 0, pieces: 1, earnedMinutes: '96.500', pieceAmount: 1158, timeAmount: 0, earnings: 1158, paidMinutes: 465, guaranteed: 6975, makeUp: 5817 },
}
const TOTAL = { present: 1635, ordinary: 1395, overtime: 120, earnedMinutes: '386.000', offStandard: 30, earnings: 4757, makeUp: 17968, pieces: 4 }

/** The flow's month and its days (all counted from the clock and the seeds, see the header). */
const DAYS = { month: '', setUp: '', shift: '', after: '', close: '' }
const minuteOf = (hhmm: string): number => {
  const [hour, minute] = hhmm.split(':').map(Number)
  return hour! * 60 + minute!
}
const local = (date: string, hhmm: string): Date => localInstant(date, minuteOf(hhmm), ROME)
/** Moves every command's "now" (Date). The harness clock and the database's now() stay. */
const clockAt = (date: string, hhmm: string): void => {
  vi.setSystemTime(local(date, hhmm))
}

/** The first whole month after this month and after every date the seeds hold: nothing of it can pass, and no seeded row is in it. */
async function monthOfTheFlow(): Promise<string> {
  const [row] = await admin<{ last: string }>(
    w,
    `SELECT to_char(max(d), 'YYYY-MM') AS last FROM (
       SELECT max(date) AS d FROM "AttendanceDay" UNION ALL SELECT max(date) FROM "RosterEntry" UNION ALL SELECT max("periodEnd") FROM "PayPeriod"
       UNION ALL SELECT max(coalesce("trialEndsOn", "effectiveFrom")) FROM "PieceRateVersion" UNION ALL SELECT max("validFrom") FROM "IncentiveScheme"
       UNION ALL SELECT max("workDate") FROM "OffStandardEntry" UNION ALL SELECT max("workDate") FROM "LabourDay"
     ) dates`,
  )
  const thisMonth = businessDate(new Date()).slice(0, 7)
  return monthAfter(row!.last > thisMonth ? row!.last : thisMonth)
}

/** A Tuesday to Thursday from the 9th on: no national holiday falls there, in any month of any year. */
function shiftDayOf(month: string): string {
  for (let day = 9; ; day++) {
    const date = `${month}-${String(day).padStart(2, '0')}`
    if ([2, 3, 4].includes(new Date(`${date}T12:00:00.000Z`).getUTCDay())) return date
  }
}

/** The seeded work the floor goes on with: SEED-WO-0001. */
const S = () => ({
  wo: id('production:work-order:WO-0001'),
  blk50: id('production:WO-0001:cell:BLK:50'),
  blk52: id('production:WO-0001:cell:BLK:52'),
  blk54: id('production:WO-0001:cell:BLK:54'),
  leather: id('product:item:leather'),
})

/** Every read of a person's time at A1: refused while the ATTENDANCE gate is off, at the start and at the end of the flow. */
const attendanceReads = (): string[] => [
  `/people/attendance/days?siteId=${siteA1()}`,
  `/people/attendance/counts?siteId=${siteA1()}`,
  `/people/overtime/entries?siteId=${siteA1()}`,
  `/people/overtime/counts?siteId=${siteA1()}`,
  `/people/month-close?companyId=${companyA()}&month=${DAYS.month}`,
  `/people/reports/attendance?siteId=${siteA1()}&month=${DAYS.month}`,
  `/people/payroll/month?companyId=${companyA()}&month=${DAYS.month}`,
  `/people/employees/${G.employees.one}/attendance`,
  `/people/employees/${G.employees.one}/limits`,
]

const dayUrl = (who: Who) => `/people/attendance/days/${G.days[who].id}`
const money = (minor: number): string => (minor / 100).toFixed(2).replace('.', ',')
/** A file an office person opened (its 60-second link), as bytes. */
async function bytesOf(url: string): Promise<{ readonly raw: Buffer; readonly text: string }> {
  const answer = await w.h.app.inject({ method: 'GET', url })
  expect(answer.statusCode, answer.body).toBe(200)
  return { raw: answer.rawPayload, text: answer.body }
}
const scanAct = (device: Browser, path: string, body: Json, status = 201) => ok(device, 'POST', path, body, status, { 'idempotency-key': body.clientScanId })

/** Every worker and the employee behind them: what no closed read may hold. */
async function namesAndIds(): Promise<string[]> {
  const rows = await admin<{ worker: string; workerName: string; employee: string | null; display: string | null; full: string | null }>(
    w,
    `SELECT w.id::text AS worker, w."displayName" AS "workerName", e.id::text AS employee, e."displayName" AS display, e."firstName" || ' ' || e."lastName" AS full FROM "Worker" w LEFT JOIN "Employee" e ON e.id = w."employeeId" WHERE w."siteId" = $1`,
    [siteA1()],
  )
  return [...new Set(rows.flatMap((row) => [row.worker, row.workerName, row.employee, row.display, row.full]).filter((value): value is string => typeof value === 'string' && value !== ''))]
}

/** The reads B-W2b-F3 and B-W2b-F4 closed, each with the flag that says a person is on it. Read by the production manager. */
const gatedReads = (): readonly { readonly label: string; readonly url: string; readonly flag: string }[] => [
  { label: 'a correction asked (F3)', url: `/production/scans/corrections/${G.correctionId}`, flag: 'askedByHidden' },
  { label: 'a work order’s scans (F3)', url: `/production/scans/work-orders/${S().wo}/scans`, flag: 'workerHidden' },
  { label: 'a refused scan (F3)', url: `/production/scans/refusals/${G.scanRefusalId}`, flag: 'workerHidden' },
  { label: 'a flagged scan (F3)', url: `/production/guards/flags/${G.scan.a.id}`, flag: 'workerHidden' },
  { label: 'the steps ticked (F3)', url: `/production/checklists/work-orders/${S().wo}?bundleId=${G.seededBundleId}`, flag: 'byHidden' },
  { label: 'the cut log (F3)', url: `/production/cutting/work-orders/${S().wo}/cut-log`, flag: 'workerHidden' },
  { label: 'a hide’s cuts (F3)', url: `/inventory/hides/${G.hideId}`, flag: 'cutByHidden' },
  { label: 'a floor move in the ledger (F3)', url: `/inventory/ledger/${G.floorMoveId}`, flag: 'workerHidden' },
  { label: 'the evidence trail (F3)', url: `/quality/evidence?batch=${G.batch}`, flag: 'workerHidden' },
  { label: 'a refused floor action (F3)', url: `/floor-sync/refused/${G.refused.id}`, flag: 'workerHidden' },
  { label: 'a labour record (F3)', url: `/production/labour/records/${G.scan.a.id}`, flag: 'workerHidden' },
  { label: 'a dispute (F3)', url: `/production/labour/disputes/${G.dispute.id}`, flag: 'workerHidden' },
  { label: 'an off-standard block (F3)', url: `/production/offstandard/blocks/${G.block.id}`, flag: 'workerHidden' },
  { label: 'the record’s timeline (F4)', url: `/threads/WorkOrder/${S().wo}/timeline`, flag: 'actorHidden' },
  { label: 'the record’s thread (F4)', url: `/threads/WorkOrder/${S().wo}`, flag: 'authorHidden' },
  { label: 'the moves (F4)', url: `/inventory/moves?siteId=${siteA1()}&itemId=${S().leather}&limit=500`, flag: 'createdByHidden' },
  { label: 'the stock card (F4)', url: `/inventory/stock/card?siteId=${siteA1()}&itemId=${S().leather}`, flag: 'createdByHidden' },
  { label: 'the receipts (F4)', url: `/inventory/receipts?siteId=${siteA1()}`, flag: 'postedByHidden' },
  { label: 'a floor receipt (F4)', url: `/inventory/receipts/${G.receiptId}`, flag: 'postedByHidden' },
]

async function rawRead(url: string): Promise<string> {
  const answer = await call(P.manager.browser, 'GET', url)
  expect(answer.status, `${url}: ${answer.response.body}`).toBe(200)
  return answer.response.body
}

async function gateOpens(): Promise<void> {
  const needles = await namesAndIds()
  for (const { label, url, flag } of gatedReads()) {
    const raw = await rawRead(url)
    expect(needles.filter((needle) => raw.includes(needle)).length, `${label} names somebody with the gate on`).toBeGreaterThan(0)
    expect(raw, label).toContain(`"${flag}":false`)
    expect(raw, label).not.toContain(`"${flag}":true`)
  }
  const moves = (await ok(P.manager, 'GET', `/inventory/moves?siteId=${siteA1()}&createdById=${G.workers.one.id}`)).moves as Json[]
  expect(moves.length).toBeGreaterThan(0)
}

async function gateCloses(): Promise<void> {
  const needles = await namesAndIds()
  for (const { label, url, flag } of gatedReads()) {
    const raw = await rawRead(url)
    expect(needles.filter((needle) => raw.includes(needle)).join(', '), label).toBe('')
    expect(raw, `${label} says a person is on it`).toContain(`"${flag}":true`)
  }
  // The filter would say what the column hides.
  expect((await ok(P.manager, 'GET', `/inventory/moves?siteId=${siteA1()}&createdById=${G.workers.one.id}`)).moves).toEqual([])
  // One person's figures: refused before anything is read, for every id.
  for (const employeeId of Object.values(G.employees) as string[]) {
    const refused = await ok(P.owner, 'POST', `/people/efficiency/people/${employeeId}/figures`, { siteId: siteA1(), from: DAYS.shift, to: DAYS.shift, reason: 'PAY_QUERY' }, 409)
    expect(pathsOf(refused.error)).toContain('gate/PERFORMANCE')
  }
}

const gateVersion = async (purpose: 'ATTENDANCE' | 'PERFORMANCE'): Promise<number> => ((await ok(P.owner, 'GET', `/people/privacy/sites/${siteA1()}`)).purposes as Json[]).find((entry) => entry.purpose === purpose)!.gate.version

beforeAll(async () => {
  useErrorTracker(createErrorTracker({ sink: { kind: 'fake', send: (report) => void unexpected.push(report) }, source: 'api' }))
  w = await startWorld()
  indexers = await searchIndexers()
  handlers = everyHandler(indexers)
  settle = settler(w, handlers)
  DAYS.month = await monthOfTheFlow()
  DAYS.setUp = `${DAYS.month}-03`
  DAYS.shift = shiftDayOf(DAYS.month)
  DAYS.after = plusDays(DAYS.shift, 1)
  DAYS.close = `${monthAfter(DAYS.month)}-03`
  vi.useFakeTimers({ toFake: ['Date'], now: local(DAYS.setUp, '07:30') })
  for (const [key, role] of [
    ['owner', 'owner'],
    ['hr', ''],
    ['supervisor', 'floor_supervisor'],
    ['manager', 'production_manager'],
  ] as const) {
    P[key] = await person(w, key, role)
  }
}, 1_200_000)

afterAll(async () => {
  vi.useRealTimers()
  useErrorTracker(undefined)
  await w?.close()
}, 60_000)

// One step may take a while on a loaded machine (a step renders PDFs, runs the worker).
describe('the W2b-1 golden flow: a shift on the floor and a month in People through the HTTP routes', { timeout: 180_000 }, () => {
  it('00 the world: the worker runs every handler list of background.ts; the seeds drain; the clock stands in a month no seed reached', async () => {
    assertEveryHandler()
    await standardReasonsForNewTenants({ database: w.h.database, log: QUIET })
    await indexNewTenants({ database: w.h.database, indexers, log: QUIET })
    await settle()
    expect(businessDate(new Date()).slice(0, 7)).toBe(DAYS.month)
    expect(await admin(w, 'SELECT count(*)::int AS n FROM "PayPeriod" WHERE "periodStart" >= $1::date', [`${DAYS.month}-01`])).toEqual([{ n: 0 }])
  })

  // ---- A: every purpose off, then the set-up -----------------------------------------------------------------------------------------

  it('A01 the owner gives HR a custom role with the pay grain (no template holds it)', async () => {
    await stepped(w, P.owner)
    const role = await ok(P.owner, 'POST', '/auth/roles', {
      key: 'people_office',
      name: 'People office',
      permissions: ['people.view', 'people.employees.manage', 'people.attendance.view', 'people.attendance.manage', 'people.attendance.approve', 'people.attendance.close', 'people.attendance.correct', 'people.attendance.lul', 'people.overtime.review', 'people.timesheets.hr', 'people.shifts.view', 'people.shifts.manage', 'people.skills.view', 'people.skills.manage', 'people.piecerates.view', 'people.piecerates.manage', 'people.earnings.view', 'people.earnings.records', 'people.earnings.manage', 'people.payroll.view', 'people.payroll.records', 'people.payroll.manage'],
      grains: ['pay'],
    })
    await ok(P.owner, 'POST', `/auth/users/${P.hr.id}/roles`, { roleId: role.id, allCompanies: true })
    await ok(P.hr, 'GET', `/people/employees?siteId=${siteA1()}`)
  })

  it('A02 the supervisor enrols a kiosk and the tablets, five floor workers with a badge and a PIN; HR makes each an employee of line L1, with a code', async () => {
    const operator = id('role:operator')
    G.kiosk = await tablet(w, P.supervisor, siteA1(), undefined as unknown as string, 'Golden kiosk')
    G.tablets = {
      one: await tablet(w, P.supervisor, siteA1(), id('site:A1:station:SEW-01'), 'Golden sewing 1'),
      two: await tablet(w, P.supervisor, siteA1(), id('site:A1:station:SEW-02'), 'Golden sewing 2'),
      three: await tablet(w, P.supervisor, siteA1(), id('site:A1:station:SEW-02'), 'Golden sewing 2b'),
      lead: await tablet(w, P.supervisor, siteA1(), id('site:A1:station:SEW-01'), 'Golden lead tablet'),
      cutter: await tablet(w, P.supervisor, siteA1(), id('site:A1:station:CUT-01'), 'Golden cutting'),
    } as Record<string, Browser>
    G.workers = {} as Record<string, FloorWorker>
    G.pins = { one: '481537', two: '592648', three: '603759', lead: '714860', cutter: '825971' }
    G.employees = {} as Record<string, string>
    for (const [key, name, role, code] of [
      ['one', 'Alba Uno', operator, AGREED.one.code],
      ['two', 'Bruno Due', operator, AGREED.two.code],
      ['three', 'Carla Tre', operator, AGREED.three.code],
      ['lead', 'Dario Capo', id('role:team_leader'), 'GOLD-004'],
      ['cutter', 'Elia Taglio', id('role:cutting_operator'), 'GOLD-005'],
    ] as const) {
      const worker = await floorWorker(w, P.supervisor, siteA1(), name, role)
      await signOn(G.tablets[key], worker, G.pins[key])
      G.workers[key] = worker
      const answer = await ok(P.hr, 'POST', '/people/employees/from-worker', { workerId: worker.id, employeeCode: code, homeLineId: lineL1(), contract: 'FULL_TIME', weeklyMinutes: 2400 }, 201)
      expect(answer.employee).toMatchObject({ employeeCode: code })
      G.employees[key] = answer.employee.id
      keep(worker.id, answer.employee.id)
    }
    await settle()
  })

  it('A03 every purpose off: the tablet says the clock is closed, a badge records nothing, and every read of a person’s time refuses in words (Statuto art. 4 c.2)', async () => {
    expect(await ok(G.kiosk, 'GET', '/people/clock/tablet')).toEqual({ open: false })
    const scan = await ok(G.kiosk, 'POST', '/people/clock/scan', { clientEventId: 'gold-closed-1', badgeCode: G.workers.one.badgeCode }, 409)
    expect(pathsOf(scan.error)).toEqual(['gate/ATTENDANCE'])
    expect(scan.error.message).toContain('art. 4')
    for (const url of attendanceReads()) expect(pathsOf((await ok(P.hr, 'GET', url, undefined, 409)).error), url).toContain('gate/ATTENDANCE')
    expect(await admin(w, 'SELECT count(*)::int AS n FROM "ClockEvent" WHERE "employeeId" = ANY($1::uuid[])', [Object.values(G.employees)])).toEqual([{ n: 0 }])
  })

  it('A04 the owner switches ATTENDANCE and PERFORMANCE on at A1 with a fresh code, each on its recorded basis; a read follows at once', async () => {
    const base = `/people/privacy/sites/${siteA1()}/purposes`
    await stepped(w, P.owner)
    await ok(P.owner, 'POST', `${base}/ATTENDANCE/switch-on`, { basis: { kind: 'NOT_REQUIRED', reference: 'SAMPLE - made-up counsel opinion (art. 4 c.2)' }, reason: 'Badge clock-in starts at A1 (made up).' })
    await stepped(w, P.owner)
    await ok(P.owner, 'POST', `${base}/PERFORMANCE/switch-on`, { reason: 'Piece pay rests on the made-up union agreement.' })
    expect(await ok(G.kiosk, 'GET', '/people/clock/tablet')).toEqual({ open: true })
    expect((await ok(P.hr, 'GET', `/people/attendance/days?siteId=${siteA1()}`)).days).toEqual([])
    await settle()
  })

  it('A05 piece pay starts from the set-up day: the earning codes mapped, the rates told to every active worker, every precondition met, a fresh code', async () => {
    const { codes } = await ok(P.hr, 'GET', `/people/payroll/codes?companyId=${companyA()}`)
    for (const code of (codes as Json[]).filter((row) => row.kind === 'EARNING' && row.providerCode === null)) {
      await ok(P.hr, 'PUT', '/people/payroll/codes', { companyId: companyA(), kind: code.kind, ourCode: code.ourCode, providerCode: `E${code.ourCode}`.slice(0, 6), ...(code.version ? { version: code.version } : {}) })
    }
    const { tables } = await ok(P.hr, 'GET', `/people/piece-rates/tables?siteId=${siteA1()}`)
    const [table] = tables as Json[]
    expect(table!.table.code).toBe('JKT-02')
    expect(table!.current).toMatchObject({ versionNo: 1, status: 'PUBLISHED' })
    const before = await ok(P.hr, 'GET', `/people/piece-rates/sites/${siteA1()}/switch`)
    expect((before.preconditions as Json[]).filter((item) => !item.met).map((item) => item.code)).toEqual(['RATES_PUBLISHED'])
    const published = await ok(P.hr, 'POST', `/people/piece-rates/versions/${table!.current.id}/publish`, { version: table!.current.version, onFloor: true }, 201)
    expect(published.version.id).toBe(table!.current.id)
    const view = await ok(P.hr, 'GET', `/people/piece-rates/sites/${siteA1()}/switch`)
    expect((view.preconditions as Json[]).filter((item) => !item.met)).toEqual([])
    expect(view).toMatchObject({ state: 'OFF', canStart: true, canSwitch: false })
    await ok(P.hr, 'POST', `/people/piece-rates/sites/${siteA1()}/switch/start`, { version: view.version, onFrom: DAYS.setUp, reason: 'Not mine to start.' }, 403)
    await stepped(w, P.owner)
    const started = await ok(P.owner, 'POST', `/people/piece-rates/sites/${siteA1()}/switch/start`, { version: view.version, onFrom: DAYS.setUp, reason: 'Agreed with the made-up union and the labour consultant.' })
    expect(started).toMatchObject({ state: 'ON', onFrom: DAYS.setUp })
    await settle()
  })

  it('A06 HR records who can sew and publishes the morning shift of the day; the cutter cuts three cells of SEED-WO-0001 and bundles them', async () => {
    const { skills } = await ok(P.hr, 'GET', `/people/skills?companyId=${companyA()}`)
    const sewing = (skills as Json[]).find((skill) => skill.operation?.id === id('product:operation:SEW'))
    expect(sewing, JSON.stringify(skills)).toBeTruthy()
    for (const key of ['one', 'two']) await ok(P.hr, 'POST', '/people/skills/levels', { employeeId: G.employees[key], skillId: sewing!.id, level: 'CAN_DO' })
    const morning = { kind: 'WORK', patternId: id('calendar:pattern:2T'), label: 'Morning' }
    const written = await ok(P.hr, 'POST', '/people/shifts/roster/cells', { cells: WHO.map((key) => ({ employeeId: G.employees[key], date: DAYS.shift, version: null, set: morning })) })
    expect(written.cells).toHaveLength(3)
    await ok(P.hr, 'POST', '/people/shifts/roster/publish', { siteId: siteA1(), from: DAYS.shift, to: DAYS.shift })
    const { wo, blk50, blk52, blk54 } = S()
    const cut = await ok(
      G.tablets.cutter,
      'POST',
      `/production/cutting/work-orders/${wo}/cuts`,
      {
        clientEventId: 'gold-cut-shells',
        code: 'SEED-HIDE-0001',
        lines: [blk52, blk50, blk54].map((workOrderSizeId, index) => ({ workOrderSizeId, parts: [{ part: 'Outer shell', pieces: index === 0 ? 2 : 1 }] })),
        area: { area: '20' },
      },
      201,
    )
    expect(cut.hide.state).toBe('PARTLY_CUT')
    G.hideId = cut.hide.id
    const { bundles } = await ok(
      G.tablets.cutter,
      'POST',
      `/production/bundles/work-orders/${wo}/bundles`,
      { cells: [{ workOrderSizeId: blk52, quantities: [2] }, { workOrderSizeId: blk50, quantities: [1] }, { workOrderSizeId: blk54, quantities: [1] }], printerId: id('print:printer:A1:LBL') },
      201,
    )
    expect((bundles as Json[]).map((bundle) => [bundle.part, bundle.quantity])).toEqual([[null, 2], [null, 1], [null, 1]])
    G.bundles = { a: bundles[0], b: bundles[1], c: bundles[2] }
    keep(...(bundles as Json[]).map((bundle) => bundle.id))
    const { operations, workOrder } = await ok(G.tablets.cutter, 'GET', `/production/bundles/work-orders/${wo}`)
    G.sewOp = (operations as Json[]).find((operation) => operation.code === 'SEED-SEW-ASM')
    G.batch = workOrder.batchNumber
    await settle()
  })

  // ---- B: the shift ---------------------------------------------------------------------------------------------------------------

  it('B01 06:00 three people badge in at the kiosk: the clock records the server’s time and each sees their own day', async () => {
    clockAt(DAYS.shift, '06:00')
    for (const key of WHO) {
      const clocked = await ok(G.kiosk, 'POST', '/people/clock/scan', { clientEventId: `gold-in-${key}`, badgeCode: G.workers[key].badgeCode }, 201)
      expect(clocked.event).toMatchObject({ kind: 'IN', source: 'BADGE', occurredAt: local(DAYS.shift, '06:00').toISOString(), flagged: false })
      expect(clocked.clock).toMatchObject({ state: 'IN', person: { employeeId: G.employees[key] }, shift: { label: 'Morning', source: 'ROSTER' } })
      keep(clocked.event.id)
    }
    await settle()
  })

  it('B02 06:30 the supervisor dispatches: the qualification check passes who can sew and asks a reason for who cannot; My work names it', async () => {
    clockAt(DAYS.shift, '06:30')
    const sew1 = id('site:A1:station:SEW-01')
    const sew2 = id('site:A1:station:SEW-02')
    const { operators } = await ok(P.supervisor, 'GET', `/production/dispatch/operators?siteId=${siteA1()}&date=${DAYS.shift}&stationId=${sew1}&workOrderOperationId=${G.sewOp.id}`)
    const of = (workerId: string) => (operators as Json[]).find((operator) => operator.workerId === workerId)
    expect(of(G.workers.one.id)).toMatchObject({ level: 'CAN_DO', clockedIn: true, decision: 'ALLOW' })
    expect(of(G.workers.three.id)).toMatchObject({ level: null, clockedIn: true, decision: 'WARN' })
    const assign = (key: Who, stationId: string, bundle: string, more: Json = {}, status = 201) =>
      ok(P.supervisor, 'POST', '/production/dispatch/assignments', { date: DAYS.shift, workerId: G.workers[key].id, stationId, workOrderOperationId: G.sewOp.id, bundleIds: [G.bundles[bundle].id], ...more }, status)
    expect((await assign('one', sew1, 'a')).overridden).toBe(false)
    expect((await assign('two', sew2, 'b')).overridden).toBe(false)
    expect(pathsOf((await assign('three', sew2, 'c', {}, 409)).error)).toContain('refusal/OVERRIDE_REASON_NEEDED')
    expect((await assign('three', sew2, 'c', { overrideReason: 'She learns on this bundle, the lead stays beside her.' })).overridden).toBe(true)
    const mine = await ok(G.tablets.one, 'GET', '/production/dispatch/mine')
    expect(JSON.stringify(mine)).toContain(G.sewOp.id)
    await settle()
  })

  it('B03 07:00 to 09:30 the first worker starts, pauses, resumes, says how many so far, starts again and finishes: the rows time the work, and the report pays what the partial did not', async () => {
    const device = G.tablets.one as Browser
    const bundle = { code: G.bundles.a.code, workOrderOperationId: G.sewOp.id }
    clockAt(DAYS.shift, '07:00')
    const started = await scanAct(device, '/production/terminal/start', { ...bundle, clientScanId: 'gold-a-start' })
    expect(started).toMatchObject({ qualification: null, override: null, timing: { state: 'RUNNING', mine: true } })
    clockAt(DAYS.shift, '08:00')
    expect((await scanAct(device, '/production/terminal/pause', { ...bundle, clientScanId: 'gold-a-pause', reasonCode: 'MATERIAL_WAIT' })).timing.state).toBe('PAUSED')
    clockAt(DAYS.shift, '08:10')
    expect((await scanAct(device, '/production/terminal/resume', { ...bundle, clientScanId: 'gold-a-resume' })).timing.state).toBe('RUNNING')
    clockAt(DAYS.shift, '09:00')
    expect((await scanAct(device, '/production/terminal/partial', { ...bundle, clientScanId: 'gold-a-partial', pieces: 1 })).timing.piecesSoFar).toBe(1)
    // Pieces so far close a stretch: starting again is what makes the report a timed one (a one-tap report has no timing, Owner answer F3).
    clockAt(DAYS.shift, '09:05')
    expect((await scanAct(device, '/production/terminal/start', { ...bundle, clientScanId: 'gold-a-start-2' })).timing).toMatchObject({ state: 'RUNNING', piecesSoFar: 1 })
    clockAt(DAYS.shift, '09:30')
    const { scan } = await scanAct(device, '/production/scans', { ...bundle, clientScanId: 'gold-a-report', good: 2 })
    expect(scan).toMatchObject({ kind: 'REPORT', goodQuantity: 2 })
    G.scan = { a: scan }
    keep(scan.id)
    await settle()
  })

  it('B04 10:00 a help call: the waiting starts by itself, the team leader comes, the station solves it, and ten minutes are booked', async () => {
    clockAt(DAYS.shift, '10:00')
    const device = G.tablets.one as Browser
    const station = await ok(device, 'GET', '/production/calls/station')
    const tile = (station.tiles as Json[]).find((entry) => entry.type.code === 'MATERIAL')
    const sent = await ok(device, 'POST', '/production/calls/station', { typeId: tile!.type.id, clientEventId: 'gold-call-1', note: 'Black thread' }, 201)
    expect(sent.call).toMatchObject({ status: 'SENT', waitingBooked: true, waiting: { code: 'WAIT_HELP', status: 'OPEN' }, caller: { name: 'Alba Uno' } })
    G.call = sent.call
    keep(sent.call.id)
    await settle()
    clockAt(DAYS.shift, '10:02')
    await ok(G.tablets.lead, 'POST', `/production/calls/${G.call.id}/on-the-way`, {})
    clockAt(DAYS.shift, '10:10')
    const solved = await ok(device, 'POST', `/production/calls/station/${G.call.id}/solve`, {})
    expect(solved.call).toMatchObject({ status: 'SOLVED', times: { responseSeconds: 120, resolveSeconds: 600 }, waiting: { code: 'WAIT_HELP', status: 'APPROVED', endedAt: local(DAYS.shift, '10:10').toISOString() } })
    await settle()
  })

  it('B05 10:30 off-standard time: the worker taps a tile, ends it, and the team leader approves it with the PIN', async () => {
    clockAt(DAYS.shift, '10:30')
    const device = G.tablets.one as Browser
    const { codes } = await ok(device, 'GET', '/production/offstandard/floor')
    const code = (codes as Json[]).find((entry) => entry.code === 'WAIT_MATERIAL')
    await ok(device, 'POST', '/production/offstandard/floor/start', { clientEventId: 'gold-off-1', codeId: code!.id }, 201)
    clockAt(DAYS.shift, '10:50')
    const { block } = await ok(device, 'POST', '/production/offstandard/floor/end', { clientEventId: 'gold-off-2' })
    expect(block).toMatchObject({ status: 'PENDING', minutes: 20 })
    G.block = block
    keep(block.id)
    await settle()
    const lead = G.tablets.lead as Browser
    const { blocks } = await ok(lead, 'GET', '/production/offstandard/floor/lead')
    const waiting = (blocks as Json[]).find((entry) => entry.id === block.id)!
    await ok(lead, 'POST', '/floor/step-up', { pin: G.pins.lead })
    expect((await ok(lead, 'POST', `/production/offstandard/floor/lead/${waiting.id}/approve`, { version: waiting.version })).block.status).toBe('APPROVED')
    await settle()
  })

  it('B06 11:00 the others finish a bundle with one tap; the one with no level starts first and hears the warning', async () => {
    clockAt(DAYS.shift, '10:55')
    const warned = await scanAct(G.tablets.three, '/production/terminal/start', { clientScanId: 'gold-c-start', code: G.bundles.c.code, workOrderOperationId: G.sewOp.id })
    expect(warned.qualification).toMatchObject({ mode: 'WARN' })
    clockAt(DAYS.shift, '11:00')
    for (const [key, device, bundle] of [['b', G.tablets.two, G.bundles.b], ['c', G.tablets.three, G.bundles.c]] as const) {
      const { scan } = await scanAct(device, '/production/scans', { clientScanId: `gold-${key}-report`, code: bundle.code, workOrderOperationId: G.sewOp.id, good: bundle.quantity })
      G.scan[key] = scan
      keep(scan.id)
    }
    await settle()
  })

  it('B07 the clock-outs: one leaves on time, two stay two hours; the worker’s handlers make the days and the overtime; the clock and My day read as the day will', async () => {
    clockAt(DAYS.shift, '14:00')
    await ok(G.kiosk, 'POST', '/people/clock/scan', { clientEventId: 'gold-out-three', badgeCode: G.workers.three.badgeCode }, 201)
    clockAt(DAYS.shift, '16:00')
    for (const key of ['one', 'two'] as const) await ok(G.kiosk, 'POST', '/people/clock/scan', { clientEventId: `gold-out-${key}`, badgeCode: G.workers[key].badgeCode }, 201)
    const handled = await settle()
    expect(handled.filter((type) => type === 'attendance.day_changed')).toHaveLength(3)
    expect(handled.filter((type) => type === 'overtime_entry.changed')).toHaveLength(2)
    for (const key of WHO) expect((await ok(G.tablets[key], 'GET', '/people/clock/floor')).clock.minutes, key).toMatchObject({ worked: AGREED[key].present, breaks: 15 })
    const device = G.tablets.one as Browser
    await ok(device, 'POST', '/floor/step-up', { pin: G.pins.one })
    const mine = await ok(device, 'GET', '/people/myday')
    expect(mine).toMatchObject({ linked: true, work: { pieces: AGREED.one.pieces, reports: 1 }, paysToday: true })
    expect(Number(mine.performance.earnedMinutes)).toBe(Number(AGREED.one.earnedMinutes))
    // 07:00-08:00, 08:10-09:00, 09:05-09:30: the pause and the gap between the stretches left out.
    expect(Number(mine.performance.timedMinutes)).toBe(135)
    expect(Number(mine.performance.offStandardMinutes)).toBe(30)
  })

  // ---- C: the day after -------------------------------------------------------------------------------------------------------------

  it('C01 the day after: the list names nobody; each record holds the agreed minutes; overtime waits for the approved day; then a person decides it', async () => {
    clockAt(DAYS.after, '09:00')
    const list = await ok(P.hr, 'GET', `/people/attendance/days?siteId=${siteA1()}&from=${DAYS.shift}&to=${DAYS.shift}`)
    expect(list.days).toHaveLength(3)
    const shown = JSON.stringify(list)
    for (const name of ['Alba', 'Bruno', 'Carla', 'presentMinutes']) expect(shown).not.toContain(name)
    G.days = {} as Record<Who, Json>
    for (const key of WHO) {
      const [row] = await admin<{ id: string }>(w, 'SELECT id FROM "AttendanceDay" WHERE "employeeId" = $1 AND date = $2::date', [G.employees[key], DAYS.shift])
      G.days[key] = await ok(P.hr, 'GET', `/people/attendance/days/${row!.id}`)
      keep(row!.id)
      expect(G.days[key].person.employeeCode).toBe(AGREED[key].code)
      expect(G.days[key].figures).toMatchObject({ presentMinutes: AGREED[key].present, breakMinutes: 15, ordinaryMinutes: AGREED[key].ordinary, overtimeMinutes: AGREED[key].worked, nightMinutes: 0, holidayMinutes: 0, absenceMinutes: 0 })
      expect(G.days[key].planned).toMatchObject({ label: 'Morning', minutes: AGREED[key].ordinary })
    }
    const { entries } = await ok(P.hr, 'GET', `/people/overtime/entries?siteId=${siteA1()}&from=${DAYS.shift}&to=${DAYS.shift}`)
    expect(entries).toHaveLength(2)
    expect(JSON.stringify(entries)).not.toContain('minutes')
    G.entries = {} as Record<string, Json>
    for (const entry of entries as Json[]) {
      const record = await ok(P.hr, 'GET', `/people/overtime/entries/${entry.id}`)
      expect(record).toMatchObject({ class: 'DAY', minutes: 120, status: 'PENDING' })
      G.entries[record.person.employeeId === G.employees.one ? 'one' : 'two'] = record
      keep(entry.id)
    }
    const early = await ok(P.manager, 'POST', `/people/overtime/entries/${G.entries.one.id}/approve`, { version: G.entries.one.version }, 409)
    expect(pathsOf(early.error)).toContain('holds/DAY_NOT_APPROVED')
    for (const key of WHO) expect((await ok(P.hr, 'POST', `${dayUrl(key)}/approve`, { version: G.days[key].version })).status).toBe('APPROVED')
    expect((await ok(P.manager, 'POST', `/people/overtime/entries/${G.entries.one.id}/approve`, { version: G.entries.one.version })).status).toBe('APPROVED')
    expect((await ok(P.manager, 'POST', `/people/overtime/entries/${G.entries.two.id}/reject`, { version: G.entries.two.version, reason: 'Nobody asked for it: the bundle was done by eleven.' })).status).toBe('REJECTED')
    await settle()
  })

  it('C02 the line’s day closes; its labour records, the WIP, the timing and the efficiency tiles hold the same pieces and minutes', async () => {
    const url = `/production/labour/days/${lineL1()}/${DAYS.shift}`
    expect((await ok(P.manager, 'GET', url)).day).toMatchObject({ state: 'READY', records: 3, blockers: [], canClose: true })
    const closed = await ok(P.manager, 'POST', `${url}/close`, {})
    expect(closed.day).toMatchObject({ state: 'CLOSED', canReopen: true })
    keep(closed.day.labourDayId)
    for (const [bundle, key] of [['a', 'one'], ['b', 'two'], ['c', 'three']] as const) {
      const { record } = await ok(P.manager, 'GET', `/production/labour/records/${G.scan[bundle].id}`)
      expect(record).toMatchObject({ state: 'STANDING', workDate: DAYS.shift, reported: { good: AGREED[key].pieces }, counts: { good: AGREED[key].pieces }, earnedMinutes: AGREED[key].earnedMinutes, worker: { id: G.workers[key].id }, workerHidden: false })
    }
    const wip = await ok(P.manager, 'GET', `/production/scans/work-orders/${S().wo}/wip`)
    expect((wip.operations as Json[]).find((operation) => operation.code === 'SEED-SEW-ASM')).toMatchObject({ good: TOTAL.pieces })
    const timing = await ok(P.manager, 'GET', `/production/terminal/work-orders/${S().wo}/timing`)
    const sewing = (timing.operations as Json[]).find((entry) => entry.operation.code === 'SEED-SEW-ASM')
    // The first worker's 135 minutes (B07) and the five minutes from the third worker's start to their report.
    expect(sewing).toMatchObject({ timedMinutes: '140.00', stretches: 3, partials: 1, pauses: [{ code: 'MATERIAL_WAIT', count: 1, minutes: '10.00' }] })
    expect(JSON.stringify(timing)).not.toContain('Alba')
    const efficiency = await ok(P.owner, 'GET', `/people/efficiency?siteId=${siteA1()}&from=${DAYS.shift}&to=${DAYS.shift}`)
    expect(efficiency.tiles).toMatchObject({ earnedMinutes: TOTAL.earnedMinutes, attendedMinutes: `${TOTAL.present}.000`, offStandardMinutes: `${TOTAL.offStandard}.000` })
    await settle()
  })

  // ---- D: the month -----------------------------------------------------------------------------------------------------------------

  it('D01 the month is over: HR prepares the timesheets, the lead approves first, then HR; the record says what was approved and refused', async () => {
    clockAt(DAYS.close, '09:00')
    expect(await ok(P.hr, 'POST', '/people/timesheets/prepare', { siteId: siteA1(), month: DAYS.month })).toMatchObject({ created: 3, existing: 0 })
    const { timesheets } = await ok(P.hr, 'GET', `/people/timesheets?siteId=${siteA1()}&month=${DAYS.month}`)
    expect(timesheets).toHaveLength(3)
    expect(JSON.stringify(timesheets)).not.toContain('Alba')
    const first = (timesheets as Json[])[0]!
    expect(pathsOf((await ok(P.hr, 'POST', `/people/timesheets/${first.id}/hr-approve`, { version: first.version }, 409)).error)).toContain('holds/WRONG_STAGE')
    for (const row of timesheets as Json[]) {
      const lead = await ok(P.manager, 'POST', `/people/timesheets/${row.id}/lead-approve`, { version: row.version })
      await ok(P.hr, 'POST', `/people/timesheets/${row.id}/hr-approve`, { version: lead.version })
      const record = await ok(P.hr, 'GET', `/people/timesheets/${row.id}`)
      const key = WHO.find((entry) => AGREED[entry].code === record.person.employeeCode)!
      const agreed = AGREED[key]
      expect(record).toMatchObject({
        status: 'APPROVED',
        stage: 'DONE',
        figuresShown: true,
        summary: { daysPresent: 1, presentMinutes: agreed.present, ordinaryMinutes: agreed.ordinary, overtimeApprovedMinutes: agreed.paidOvertime, overtimePendingMinutes: 0, overtimeRejectedMinutes: agreed.worked - agreed.paidOvertime },
      })
      keep(row.id)
    }
    await settle()
  })

  it('D02 the month closes with its phrase, the LUL calendar is sealed and holds the same hours; overtime refused is on no calendar', async () => {
    const panelUrl = `/people/month-close?companyId=${companyA()}&month=${DAYS.month}`
    const panel = await ok(P.hr, 'GET', panelUrl)
    expect(panel).toMatchObject({ state: 'OPEN', monthOver: true, days: 3, holds: [], actions: { close: true } })
    expect((panel.checklist as Json[]).every((item) => item.done)).toBe(true)
    expect(panel.due.by.slice(0, 7)).toBe(monthAfter(DAYS.month))
    expect(pathsOf((await ok(P.hr, 'POST', '/people/month-close', { companyId: companyA(), month: DAYS.month, phrase: 'close it' }, 400)).error)).toContain('body/phrase')
    const closed = await ok(P.hr, 'POST', '/people/month-close', { companyId: companyA(), month: DAYS.month, phrase: closePhrases(DAYS.month).en })
    expect(closed).toMatchObject({ state: 'CLOSED', seal: { sealed: true } })
    G.close = closed
    keep(closed.closeId)
    for (const key of WHO) expect((await ok(P.hr, 'GET', dayUrl(key))).status).toBe('CLOSED')
    await ok(P.manager, 'POST', `/people/month-close/${closed.closeId}/lul/open`, { format: 'PDF' }, 403)
    const opened = await ok(P.hr, 'POST', `/people/month-close/${closed.closeId}/lul/open`, { format: 'CSV' })
    const { text } = await bytesOf(opened.download.url)
    for (const key of WHO) expect(text).toMatch(new RegExp(`${AGREED[key].code};[^;]*;EMPLOYEE;${DAYS.shift};ORDINARIE;;7,75;${AGREED[key].ordinary};NO`))
    expect(text).toMatch(new RegExp(`${AGREED.one.code};[^;]*;EMPLOYEE;${DAYS.shift};STRAORDINARIO_DIURNO;;2,00;120;NO`))
    expect(text).not.toMatch(new RegExp(`${AGREED.two.code};.*STRAORDINARIO`))
    const pdf = await ok(P.hr, 'POST', `/people/month-close/${closed.closeId}/lul/open`, { format: 'PDF' })
    G.lulBytes = (await bytesOf(pdf.download.url)).raw
    expect(sha256(G.lulBytes)).toBe(closed.seal.sha256)
    await settle()
  })

  // ---- E: the pay period --------------------------------------------------------------------------------------------------------------

  it('E01 the pay period runs and goes to review: the scans were paid as they came; paid time and the make-up are booked now, on approved overtime only', async () => {
    const opened = await ok(P.hr, 'POST', '/people/pay-periods', { companyId: companyA(), month: DAYS.month })
    expect(opened).toMatchObject({ period: { status: 'OPEN', people: 3, earnings: TOTAL.earnings - AGREED.one.timeAmount, makeUp: 0 } })
    G.periodId = opened.period.id
    keep(G.periodId)
    const run = await ok(P.hr, 'POST', `/people/pay-periods/${G.periodId}/run`, { version: opened.period.version })
    expect(run.period).toMatchObject({ status: 'PREVIEW', statements: { draft: 3 } })
    const review = await ok(P.hr, 'POST', `/people/pay-periods/${G.periodId}/review`, { version: run.period.version })
    expect(review.period).toMatchObject({ status: 'REVIEW', people: 3, earnings: TOTAL.earnings, makeUp: TOTAL.makeUp, heldOpen: 0, disputesOpen: 0 })
    expect(review.lines).toEqual([expect.objectContaining({ people: 3, pieces: `${TOTAL.pieces}.000`, earnings: TOTAL.earnings, makeUp: TOTAL.makeUp })])
    await settle()
  })

  it('E02 one statement each: the same pieces, minutes and money; the overtime nobody approved guarantees nothing; HR approves them all and locks with the phrase', async () => {
    const { statements } = await ok(P.hr, 'GET', `/people/pay-periods/${G.periodId}/statements`)
    expect(statements).toHaveLength(3)
    expect(JSON.stringify(statements)).not.toContain('Alba')
    G.statements = {} as Record<Who, Json>
    for (const row of statements as Json[]) {
      const statement = await ok(P.hr, 'POST', `/people/statements/${row.id}/open`, {})
      const key = WHO.find((entry) => AGREED[entry].code === statement.person.code)!
      const agreed = AGREED[key]
      expect(statement).toMatchObject({
        status: 'DRAFT',
        lines: [{ operationCode: 'SEED-SEW-ASM', pieces: agreed.pieces, minutes: agreed.earnedMinutes, rate: '11.58', amount: agreed.pieceAmount }],
        attendance: { ordinaryMinutes: agreed.ordinary, approvedOvertimeMinutes: agreed.paidOvertime },
        makeUp: { minutes: agreed.paidMinutes, rate: '0.15', guaranteed: agreed.guaranteed, earned: agreed.earnings, amount: agreed.makeUp },
        earningsAmount: agreed.earnings,
        makeUpAmount: agreed.makeUp,
        held: { open: 0 },
        stale: false,
      })
      if (key === 'one') expect(statement.time).toMatchObject([{ code: 'WAIT_HELP', minutes: '10.000', amount: 42 }, { code: 'WAIT_MATERIAL', minutes: '20.000', amount: 83 }])
      else expect(statement.time).toEqual([])
      await ok(P.hr, 'POST', `/people/statements/${row.id}/approve`, { version: row.version })
      G.statements[key] = statement
      keep(row.id)
    }
    const detail = await ok(P.hr, 'GET', `/people/pay-periods/${G.periodId}`)
    expect(detail).toMatchObject({ lockPhrase: `LOCK ${DAYS.month}`, period: { statements: { draft: 0, approved: 3 } }, actions: { lock: { allowed: true } } })
    await ok(P.hr, 'POST', `/people/pay-periods/${G.periodId}/lock`, { version: detail.period.version, phrase: 'lock it' }, 409)
    const locked = await ok(P.hr, 'POST', `/people/pay-periods/${G.periodId}/lock`, { version: detail.period.version, phrase: detail.lockPhrase })
    expect(locked.period).toMatchObject({ status: 'LOCKED', earnings: TOTAL.earnings, makeUp: TOTAL.makeUp })
    await settle()
  })

  it('E03 the ledger, the report and the worker’s own My day hold what the statement holds; the ledger names nobody', async () => {
    const { entries } = await ok(P.hr, 'GET', `/people/earnings/ledger?periodId=${G.periodId}`)
    const sum = (kind: string) => (entries as Json[]).filter((entry) => entry.kind === kind).reduce((total, entry) => total + entry.amount, 0)
    expect(sum('SCAN')).toBe(AGREED.one.pieceAmount + AGREED.two.pieceAmount + AGREED.three.pieceAmount)
    expect(sum('OFF_STANDARD')).toBe(AGREED.one.timeAmount)
    expect(sum('MAKE_UP')).toBe(TOTAL.makeUp)
    expect((entries as Json[]).filter((entry) => entry.kind === 'SCAN').reduce((total, entry) => total + entry.pieces, 0)).toBe(TOTAL.pieces)
    const shown = JSON.stringify(entries)
    for (const needle of ['Alba', G.employees.one, G.workers.one.id]) expect(shown).not.toContain(needle)
    // The one list that names people: the recorded report per worker, for HR with the pay grain.
    const report = await ok(P.hr, 'POST', '/people/reports/earnings/by-worker', { companyId: companyA(), from: DAYS.month })
    for (const key of WHO) {
      const row = (report.workers as Json[]).find((entry) => entry.code === AGREED[key].code)!
      expect(row).toMatchObject({ employeeId: G.employees[key], earnings: AGREED[key].earnings, makeUp: AGREED[key].makeUp })
      expect(Number(row.pieces)).toBe(AGREED[key].pieces)
    }
    const device = G.tablets.one as Browser
    await ok(device, 'POST', '/floor/step-up', { pin: G.pins.one })
    const mine = await ok(device, 'GET', `/people/myday?month=${DAYS.month}`)
    expect(mine.pay.statement).toMatchObject({ status: 'APPROVED', earningsAmount: AGREED.one.earnings, makeUpAmount: AGREED.one.makeUp })
  })

  // ---- F: the payroll file -------------------------------------------------------------------------------------------------------------

  it('F01 the payroll checks: held while a code has no provider code; every code mapped; the preview shows the agreed minutes and money, by code, never a name', async () => {
    const { layouts } = await ok(P.hr, 'GET', `/people/payroll/layouts?companyId=${companyA()}`)
    G.layoutId = (layouts as Json[])[0]!.id
    const monthUrl = `/people/payroll/month?companyId=${companyA()}&month=${DAYS.month}&layoutId=${G.layoutId}`
    const held = await ok(P.hr, 'GET', monthUrl)
    expect(held).toMatchObject({ state: 'NOT_EXPORTED', close: { state: 'CLOSED' }, piecePayOn: true, people: 3 })
    expect(held.blocking).toBe(1)
    expect((held.checks as Json[]).filter((check) => check.blocking && !check.passed).map((check) => check.code)).toEqual(['CODES_MAPPED'])
    const refused = await ok(P.hr, 'POST', '/people/payroll/exports', { companyId: companyA(), month: DAYS.month, layoutId: G.layoutId }, 409)
    expect(pathsOf(refused.error)).toContain('check/CODES_MAPPED')
    const { codes } = await ok(P.hr, 'GET', `/people/payroll/codes?companyId=${companyA()}`)
    for (const code of (codes as Json[]).filter((row) => row.inUse && row.providerCode === null)) {
      await ok(P.hr, 'PUT', '/people/payroll/codes', { companyId: companyA(), kind: code.kind, ourCode: code.ourCode, providerCode: `P${code.ourCode}`.slice(0, 6), ...(code.version ? { version: code.version } : {}) })
    }
    expect((await ok(P.hr, 'GET', monthUrl)).blocking).toBe(0)
    const preview = await ok(P.hr, 'POST', '/people/payroll/preview', { companyId: companyA(), month: DAYS.month })
    expect(preview.payShown).toBe(true)
    for (const key of WHO) {
      const agreed = AGREED[key]
      const { cells } = (preview.people as Json[]).find((row) => row.employeeCode === agreed.code)!
      const cell = (code: string) => (cells as Json[]).find((entry) => entry.code === code)
      expect(cell('ORD')).toMatchObject({ minutes: agreed.ordinary, quantity: (agreed.ordinary / 60).toFixed(2) })
      if (agreed.paidOvertime > 0) expect(cell('OT_DAY')).toMatchObject({ minutes: agreed.paidOvertime })
      else expect(cell('OT_DAY')).toBeUndefined()
      expect(cell('PIECE')).toMatchObject({ quantity: String(agreed.pieces), amount: agreed.pieceAmount })
      expect(cell('MAKE_UP')).toMatchObject({ quantity: (agreed.paidMinutes / 60).toFixed(2), amount: agreed.makeUp })
      if (agreed.timeAmount > 0) expect(cell('OFF_STANDARD')).toMatchObject({ quantity: '0.50', amount: agreed.timeAmount })
    }
    expect(JSON.stringify(preview)).not.toContain('Alba')
    await settle()
  })

  it('F02 the file is sealed and numbered, holds the same figures and no name; it carries amounts, so Send by link is refused in words and nothing is sent or written (Owner 11-02)', async () => {
    const exported = await ok(P.hr, 'POST', '/people/payroll/exports', { companyId: companyA(), month: DAYS.month, layoutId: G.layoutId }, 201)
    expect(exported).toMatchObject({ revision: 1, status: 'EXPORTED', payPeriodId: G.periodId })
    expect(exported.number).toMatch(new RegExp(`^PAY-${DAYS.close.slice(0, 4)}-\\d{4}$`))
    G.export = exported
    keep(exported.id)
    const data = (exported.files as Json[]).find((file) => file.kind === 'DATA')!
    expect(data.sha256).toBe(exported.seal)
    const opened = await ok(P.hr, 'POST', `/people/payroll/exports/${exported.id}/files/${data.id}/open`, {})
    const { raw, text } = await bytesOf(opened.download.url)
    expect(sha256(raw)).toBe(exported.seal)
    for (const key of WHO) {
      const agreed = AGREED[key]
      expect(text).toContain(`${agreed.code};ESEMPIO-310;${agreed.pieces},00;${money(agreed.pieceAmount)}`)
      expect(text).toContain(`${agreed.code};EMAKE_;${String((agreed.paidMinutes / 60).toFixed(2)).replace('.', ',')};${money(agreed.makeUp)}`)
    }
    expect(text).toContain(`${AGREED.one.code};POT_DA;2,00;`)
    expect(text).not.toContain(`${AGREED.two.code};POT_DA`)
    for (const name of ['Alba', 'Bruno', 'Carla']) expect(text).not.toContain(name)
    // B-W2b-163: pay figures never go by link (Owner, 11-02). The month pays by the piece, so its file carries amounts: the
    // Send is refused in words and writes nothing; HR hands over the file it opened above (that opening is recorded).
    const refused = await ok(P.hr, 'POST', `/people/payroll/exports/${exported.id}/send`, { email: 'studio.made-up@example.com' }, 409)
    expect(pathsOf(refused.error)).toContain('refusal/PAY_FIGURES')
    expect(refused.error.message).toContain('pay figures never go by link')
    await settle()
    expect(() => linkTokenSentTo(w, 'studio.made-up@example.com')).toThrow('no link mail')
    expect(await admin(w, 'SELECT count(*)::int AS n FROM "OneOffLink" WHERE "recordId" = $1', [exported.id])).toEqual([{ n: 0 }])
    expect(await admin(w, 'SELECT count(*)::int AS n FROM "EmailOutbound" WHERE "recordId" = $1', [exported.id])).toEqual([{ n: 0 }])
    expect(await admin(w, `SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'payroll_export.sent' AND payload->>'exportId' = $1`, [exported.id])).toEqual([{ n: 0 }])
    expect((await ok(P.hr, 'GET', `/people/payroll/exports/${exported.id}`)).links).toEqual([])
    expect(await admin(w, `SELECT count(*)::int AS n FROM "AuditLog" WHERE action = 'people.openPayrollFile' AND "recordId" = $1`, [exported.id])).toEqual([{ n: 1 }])
  })

  // ---- G: a closed day corrected -----------------------------------------------------------------------------------------------------

  it('G01 a closed day is corrected: the closed figure and the seal stay, the report differs in one cell, and the payroll asks a correction', async () => {
    clockAt(DAYS.close, '11:00')
    const url = `${dayUrl('three')}/corrections`
    const record = await ok(P.hr, 'GET', url)
    expect(record).toMatchObject({ status: 'CLOSED', differs: false, closedFigures: { ordinaryMinutes: 465 }, actions: { correct: true } })
    const stale = await ok(P.hr, 'POST', url, { kind: 'ORDINARY', minutesBefore: 1, minutesAfter: 450, reason: 'Read before someone changed it.' }, 409)
    expect(pathsOf(stale.error)).toContain('refusal/CHANGED')
    const corrected = await ok(P.hr, 'POST', url, { kind: 'ORDINARY', minutesBefore: 465, minutesAfter: 450, reason: 'Left a quarter of an hour early, the lead confirmed it.' }, 201)
    expect(corrected).toMatchObject({ differs: true, closedFigures: { ordinaryMinutes: 465 }, figuresNow: { ordinaryMinutes: 450 } })
    await settle()
    const panel = await ok(P.hr, 'GET', `/people/month-close?companyId=${companyA()}&month=${DAYS.month}`)
    expect(panel).toMatchObject({ state: 'CLOSED', corrections: 1, payrollCorrectionsPending: 1, seal: { sha256: G.close.seal.sha256 } })
    const pdf = await ok(P.hr, 'POST', `/people/month-close/${G.close.closeId}/lul/open`, { format: 'PDF' })
    expect((await bytesOf(pdf.download.url)).raw.equals(G.lulBytes)).toBe(true)
    const report = await ok(P.hr, 'GET', `/people/reports/attendance?siteId=${siteA1()}&month=${DAYS.month}`)
    expect(report.groups).toEqual([expect.objectContaining({ code: 'L1', people: 3, figures: expect.objectContaining({ ordinaryMinutes: TOTAL.ordinary - 15, presentMinutes: TOTAL.present, overtimeDayMinutes: TOTAL.overtime }) })])
    expect(report.match).toMatchObject({ state: 'DIFFERS', cells: 1 })
    expect((await ok(P.hr, 'GET', `/people/reports/attendance/differences?siteId=${siteA1()}&month=${DAYS.month}`)).cells).toEqual([expect.objectContaining({ dayId: G.days.three.id, kind: 'ORDINARY' })])
    const production = await ok(P.hr, 'GET', `/people/reports/attendance/production?siteId=${siteA1()}&month=${DAYS.month}`)
    expect(production.lines).toEqual([expect.objectContaining({ people: 3, figures: expect.objectContaining({ attendedMinutes: TOTAL.present, productionMinutes: TOTAL.earnedMinutes, offStandardMinutes: TOTAL.offStandard, gapMinutes: '1219.000' }) })])
    expect((await ok(P.hr, 'GET', `/people/reports/attendance/people/${G.employees.three}?month=${DAYS.month}`)).figures).toMatchObject({ ordinaryMinutes: 450, presentMinutes: 465 })
    const month = await ok(P.hr, 'GET', `/people/payroll/month?companyId=${companyA()}&month=${DAYS.month}&layoutId=${G.layoutId}`)
    expect(month).toMatchObject({ state: 'CORRECTION_PENDING', correction: { people: 1, values: 1 } })
  })

  it('G02 v2 replaces v1: the corrected figure and nothing else moves, pay stands as locked, v1 is kept; v2 carries amounts too and never goes by link', async () => {
    const preview = await ok(P.hr, 'POST', '/people/payroll/preview', { companyId: companyA(), month: DAYS.month })
    expect(preview.changes).toMatchObject({ people: 1, values: 1 })
    const v2 = await ok(P.hr, 'POST', '/people/payroll/exports', { companyId: companyA(), month: DAYS.month, correctionOfId: G.export.id }, 201)
    expect(v2).toMatchObject({ revision: 2, status: 'EXPORTED', correctionOfId: G.export.id, changed: { people: 1, values: 1 } })
    keep(v2.id)
    const data = (v2.files as Json[]).find((file) => file.kind === 'DATA')!
    const opened = await ok(P.hr, 'POST', `/people/payroll/exports/${v2.id}/files/${data.id}/open`, {})
    const { text } = await bytesOf(opened.download.url)
    expect(text).toContain(`${AGREED.three.code};ESEMPIO-001;7,50;`)
    expect(text).toContain(`${AGREED.three.code};EMAKE_;7,75;${money(AGREED.three.makeUp)}`)
    expect((await ok(P.hr, 'GET', `/people/payroll/month?companyId=${companyA()}&month=${DAYS.month}&layoutId=${G.layoutId}`)).state).toBe('EXPORTED')
    expect((await ok(P.hr, 'GET', `/people/payroll/exports/${G.export.id}`)).status).toBe('EXPORTED')
    expect(pathsOf((await ok(P.hr, 'POST', `/people/payroll/exports/${G.export.id}/send`, { email: 'studio.made-up@example.com' }, 409)).error)).toContain('refusal/REPLACED')
    expect(pathsOf((await ok(P.hr, 'POST', `/people/payroll/exports/${v2.id}/send`, { email: 'studio.made-up@example.com' }, 409)).error)).toContain('refusal/PAY_FIGURES')
    expect(await admin(w, 'SELECT count(*)::int AS n FROM "OneOffLink" WHERE "recordType" = $1 AND "recordId" = ANY($2::uuid[])', ['PayrollExport', [G.export.id, v2.id]])).toEqual([{ n: 0 }])
    await settle()
  })

  // ---- H: the gate really closes -------------------------------------------------------------------------------------------------------

  it('H01 the records the gate must hide: a floor note, a refused action, a dispute, a floor receipt, a cut to correct, a seeded correction request', async () => {
    clockAt(DAYS.close, '12:00')
    const { wo, blk52 } = S()
    const { tiles } = await ok(G.tablets.one, 'GET', '/production/floor-notes/tiles')
    await ok(G.tablets.one, 'POST', `/production/floor-notes/work-orders/${wo}`, { clientEventId: 'gold-note-1', tileCode: tiles[0].code, note: 'The thread ran out twice.' }, 201)
    const refused = await ok(G.tablets.two, 'POST', '/floor/sync', { events: [{ clientEventId: 'gold-sync-refused', seq: 1, kind: 'production.scan.report', occurredAt: new Date().toISOString(), workerId: G.workers.two.id, payload: { code: 'NOT-A-BUNDLE-1', good: 1 } }] })
    expect(refused.events[0].status).toBe('refused')
    G.refused = refused.events[0].refusal
    const scanRefusals = (await ok(P.manager, 'GET', `/production/scans/refusals?siteId=${siteA1()}`)).refusals as Json[]
    G.scanRefusalId = scanRefusals.find((row) => row.clientScanId === 'gold-sync-refused')!.id
    await ok(G.tablets.two, 'POST', '/floor/step-up', { pin: G.pins.two })
    G.dispute = (await ok(G.tablets.two, 'POST', '/production/labour/floor/disputes', { clientEventId: 'gold-dispute-1', recordType: 'OperationScan', recordId: G.scan.b.id, reason: 'OTHER', message: 'One piece was not mine.' }, 201)).dispute
    const { orders } = await ok(G.tablets.one, 'GET', '/inventory/receiving/orders')
    const order = (orders as Json[]).find((row) => row.number === 'SEED-PO-0001')!
    const expected = await ok(G.tablets.one, 'GET', `/inventory/receiving/orders/${order.id}`)
    const leather = (expected.lines as Json[]).find((line) => line.item.tracking === 'HIDE')!
    const received = await ok(G.tablets.one, 'POST', `/inventory/receiving/orders/${order.id}/receipts`, { version: expected.order.version, printerId: null, lines: [{ purchaseOrderLineId: leather.id, lots: [{ hides: [{ area: '30.0' }] }] }] }, 201)
    G.receiptId = received.receipt.id
    const { moves } = await ok(P.manager, 'GET', `/inventory/moves?siteId=${siteA1()}&createdById=${G.workers.one.id}`)
    expect(moves.length).toBeGreaterThan(0)
    G.floorMoveId = moves[0].id
    const recut = await ok(G.tablets.cutter, 'POST', `/production/cutting/work-orders/${wo}/cuts`, { clientEventId: 'gold-cut-recut', code: 'SEED-HIDE-0001', lines: [{ workOrderSizeId: blk52, parts: [{ part: 'Recut', pieces: 1 }] }], area: { area: '1' } }, 201)
    G.recut = recut.cut
    const [asked] = (await ok(P.manager, 'GET', `/production/scans/corrections?status=PENDING&workOrderId=${wo}`)).requests as Json[]
    G.correctionId = asked!.id
    G.seededBundleId = asked!.bundleId
    await settle()
  })

  it('H02 with PERFORMANCE on, every read closed by B-W2b-F3 and F4 names somebody (or this suite could not fail)', async () => {
    await gateOpens()
  })

  it('H03 PERFORMANCE off: no worker’s id or name in the raw JSON of any of them, and each says a person is on it; the switch-off takes no code and stops piece pay', async () => {
    const off = await ok(P.owner, 'POST', `/people/privacy/sites/${siteA1()}/purposes/PERFORMANCE/switch-off`, { version: await gateVersion('PERFORMANCE'), reason: 'The made-up agreement ended.' })
    expect(off).toMatchObject({ change: 'SWITCHED_OFF', changed: true })
    await gateCloses()
    const corrected = await ok(P.manager, 'POST', `/production/cutting/cuts/${G.recut.id}/correct`, { reason: 'Cut against the wrong cell.' }, 201)
    expect(corrected.reversal).toMatchObject({ workerId: null, workerHidden: true })
    expect(await ok(P.hr, 'GET', `/people/piece-rates/sites/${siteA1()}/switch`)).toMatchObject({ state: 'OFF', offFrom: DAYS.close })
    await settle()
  })

  it('H04 piece pay off: a scan is recorded, and nothing is paid or held', async () => {
    clockAt(DAYS.close, '13:00')
    const before = await admin(w, 'SELECT count(*)::int AS n FROM "EarningsEntry"')
    await ok(G.kiosk, 'POST', '/people/clock/scan', { clientEventId: 'gold-in-after', badgeCode: G.workers.one.badgeCode }, 201)
    clockAt(DAYS.close, '13:10')
    const { scan } = await scanAct(G.tablets.one, '/production/scans', { clientScanId: 'gold-after-report', code: 'SEED-BN-0001', workOrderOperationId: G.sewOp.id, good: 1 })
    expect(scan).toMatchObject({ kind: 'REPORT', goodQuantity: 1 })
    await settle()
    expect(await admin(w, 'SELECT count(*)::int AS n FROM "EarningsEntry"')).toEqual(before)
    expect(await admin(w, 'SELECT count(*)::int AS n FROM "HeldScan" WHERE "operationScanId" = $1', [scan.id])).toEqual([{ n: 0 }])
    const device = G.tablets.one as Browser
    await ok(device, 'POST', '/floor/step-up', { pin: G.pins.one })
    expect(await ok(device, 'GET', '/people/myday')).toMatchObject({ performance: null, paysToday: false, work: { pieces: 1 } })
    clockAt(DAYS.close, '13:20')
    await ok(G.kiosk, 'POST', '/people/clock/scan', { clientEventId: 'gold-out-after', badgeCode: G.workers.one.badgeCode }, 201)
    await settle()
  })

  it('H05 PERFORMANCE on again with a fresh code: the names come back', async () => {
    await stepped(w, P.owner)
    await ok(P.owner, 'POST', `/people/privacy/sites/${siteA1()}/purposes/PERFORMANCE/switch-on`, { reason: 'A new made-up agreement.' })
    await gateOpens()
    await settle()
  })

  it('H06 PERFORMANCE off again: the same reads close again', async () => {
    await ok(P.owner, 'POST', `/people/privacy/sites/${siteA1()}/purposes/PERFORMANCE/switch-off`, { version: await gateVersion('PERFORMANCE'), reason: 'The new agreement was withdrawn (made up).' })
    await gateCloses()
    await settle()
  })

  it('H07 ATTENDANCE off: the clock and every attendance read refuse in words, and a badge records nothing', async () => {
    const before = await admin(w, 'SELECT count(*)::int AS n FROM "ClockEvent"')
    await ok(P.owner, 'POST', `/people/privacy/sites/${siteA1()}/purposes/ATTENDANCE/switch-off`, { version: await gateVersion('ATTENDANCE'), reason: 'The made-up opinion lapsed.' })
    expect(await ok(G.kiosk, 'GET', '/people/clock/tablet')).toEqual({ open: false })
    expect(pathsOf((await ok(G.kiosk, 'POST', '/people/clock/scan', { clientEventId: 'gold-closed-2', badgeCode: G.workers.one.badgeCode }, 409)).error)).toEqual(['gate/ATTENDANCE'])
    expect(pathsOf((await ok(G.tablets.one, 'GET', '/people/clock/floor', undefined, 409)).error)).toEqual(['gate/ATTENDANCE'])
    for (const url of attendanceReads()) expect(pathsOf((await ok(P.hr, 'GET', url, undefined, 409)).error), url).toContain('gate/ATTENDANCE')
    expect(await admin(w, 'SELECT count(*)::int AS n FROM "ClockEvent"')).toEqual(before)
    await settle()
  })

  // ---- Z: the end checks ----------------------------------------------------------------------------------------------------------------

  it('Z1 every record the flow made has its audit rows; the people events fired; the worker never retried; no route answered 500; the outbox is empty', async () => {
    const ids = [...made]
    const audited = new Set((await admin<{ recordId: string }>(w, 'SELECT DISTINCT "recordId"::text AS "recordId" FROM "AuditLog" WHERE "recordId" = ANY($1::uuid[])', [ids])).map((row) => row.recordId))
    expect(ids.filter((recordId) => !audited.has(recordId))).toEqual([])
    const events = new Set((await admin<{ type: string }>(w, 'SELECT DISTINCT type FROM "OutboxEvent" WHERE "tenantId" = $1', [w.tenant.id])).map((row) => row.type))
    for (const type of ['attendance.clock_event', 'clock.out', 'attendance.day_changed', 'overtime_entry.changed', 'timesheet.prepared', 'timesheet.changed', 'attendance.month_closed', 'attendance.lul_sealed', 'attendance.day_corrected', 'earnings.recorded', 'pay_period.changed', 'worker_statement.changed', 'payroll_export.exported', 'production.operation_timed', 'piece_pay.switched']) {
      expect(events.has(type), type).toBe(true)
    }
    // B-W2b-163: the month's files carry amounts, so none went by link (F02, G02).
    for (const type of ['payroll_export.sent', 'payroll_export.downloaded']) expect(events.has(type), type).toBe(false)
    expect(w.retried).toEqual([])
    expect(unexpected.map((report) => `${report.context.method} ${report.context.route}: ${report.name}: ${report.message} ${report.stack.slice(0, 3).join(' | ')}`)).toEqual([])
    expect(await admin(w, `SELECT type, status::text AS status FROM "OutboxEvent" WHERE "tenantId" = $1 AND status <> 'PUBLISHED'`, [w.tenant.id])).toEqual([])
  })
})
