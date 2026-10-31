import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedAuth } from '../seed/auth'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedTime, type TimeSeed } from '../seed/time'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels } from './ownership'
import { FLOOR_ROLE, PARTNER_ROLE, RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * W2b schema wave 5/7 (time and attendance) beyond the generated isolation tests, on a database built from the
 * migrations and seeded, through the real login and the scoped client (…_time_w2b_guards):
 *   - the walls: the office keeps every table; a tablet records and reads its site's clock events, reads its published
 *     roster, the asks from ASKED on and which months are closed (never the LUL file), answers an ask only as the
 *     worker; the portal reads nothing; no column holds biometric data;
 *   - clock events are append-only for every login; the floor's sources, the office's MANUAL, AUTO and VOID shapes;
 *   - roster cells, overtime asks and answers (by agreement, D.Lgs. 66/2003 art. 5), attendance days and their
 *     anomalies, absences, overtime entries (paid only once approved), timesheets (the lead, then HR);
 *   - the month close: closed only once its days are closed, nothing open or waiting; nothing written into a closed
 *     month again; the LUL calendar sealed once; corrections of a closed day append-only, each from the figure now;
 *   - working-time limits: one ACTIVE per scope and kind;
 *   - the seeds are idempotent and tell their story.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through raw SQL.
 */

const NS = 'w2b7-a'
const DENIED = /permission denied/
const RLS = /row-level security/
const UNIQUE = /duplicate key|unique/i
const FILES = new Set(['time.prisma'])
const TABLES = [
  'RosterEntry',
  'OvertimeRequest',
  'OvertimeAgreement',
  'ClockEvent',
  'AttendanceDay',
  'AttendanceAnomaly',
  'AbsenceCode',
  'AbsenceEntry',
  'OvertimeEntry',
  'TimesheetApproval',
  'AttendanceMonthClose',
  'AttendanceCorrection',
  'WorkingTimeRule',
] as const
/** What a tablet (factory_floor_runtime) may do on each table; every other table is the office's alone. */
const FLOOR_ACCESS: Readonly<Record<string, readonly string[]>> = {
  RosterEntry: ['select'],
  OvertimeRequest: ['select'],
  OvertimeAgreement: ['select', 'update'],
  ClockEvent: ['select', 'insert'],
  AttendanceMonthClose: ['select'],
}

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let time: TimeSeed

const key = (name: string): string => seedUuid(NS, name)
const A = {
  companyA: key('company:A'),
  companyB: key('company:B'),
  siteA: key('site:A1'),
  siteB: key('site:B1'),
  lineA: key('site:A1:line:L1'),
  operatorWorker: key('worker:A1:operator'),
  leadWorker: key('worker:A1:lead'),
  deviceA: key('device:A1:cutting'),
  store: key('files:account:r2'),
  hr: key('user:member'),
}

const office = (actorId: string = a.actorId): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: A.operatorWorker, siteId: A.siteA })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const count = async (table: string) => Number((await admin(`SELECT count(*) AS n FROM "${table}" WHERE "tenantId" = $1`, [a.tenantId]))[0]!.n)
const insertSql = (table: string, row: Record<string, unknown>): [string, string] => {
  const columns = Object.keys(row)
    .map((column) => `"${column}"`)
    .join(', ')
  return [`INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row)]
}
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => run(scope, ...insertSql(table, row))
/** Sets columns of one row: `set` is column → value, written as jsonb so every type casts. */
const update = (scope: FactoryScope, table: string, id: string, set: Record<string, unknown>) => {
  const columns = Object.keys(set)
  const assignments = columns.map((column) => `"${column}" = r."${column}"`).join(', ')
  return run(scope, `UPDATE "${table}" t SET ${assignments} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb) r WHERE t.id = $2::uuid`, JSON.stringify(set), id)
}
const remove = (scope: FactoryScope, table: string, id: string) => run(scope, `DELETE FROM "${table}" WHERE id = $1::uuid`, id)
const now = () => new Date().toISOString()
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const tag = () => randomUUID().slice(0, 8)
/** A person the seeds do not know (a fresh Employee id), so a test's rows never meet the seeded ones. */
const person = () => randomUUID()

beforeAll(async () => {
  db = await migratedDatabase('timew2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  await seedAuth({ db: factory, namespace: NS })
  time = await seedTime({ db: factory, namespace: NS })
}, 120_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

// --- rows as the People steps write them ----------------------------------------------------------------------------

const tabletEvent = (extra: Record<string, unknown> = {}): Record<string, unknown> => {
  const at = now()
  return {
    id: randomUUID(),
    companyId: A.companyA,
    siteId: A.siteA,
    employeeId: time.employees.operator,
    workerId: A.operatorWorker,
    deviceId: A.deviceA,
    kind: 'IN',
    source: 'BADGE',
    occurredAt: at,
    deviceTime: at,
    clientEventId: `test-${tag()}`,
    ...extra,
  }
}
const officeEvent = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  companyId: A.companyA,
  siteId: A.siteA,
  employeeId: time.employees.operator,
  kind: 'IN',
  source: 'MANUAL',
  occurredAt: ago(60),
  reason: 'Clocked in at the gate; the tablet was off.',
  ...extra,
})
const dayRow = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  companyId: A.companyA,
  siteId: A.siteA,
  employeeId: person(),
  date: '2026-10-20',
  ...extra,
})
const anomalyRow = (dayId: string, employeeId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  companyId: A.companyA,
  employeeId,
  dayId,
  kind: 'NO_SHIFT',
  ruleKey: 'time.roster.none',
  ...extra,
})
const requestRow = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  companyId: A.companyA,
  siteId: A.siteA,
  lineId: A.lineA,
  date: '2026-11-12',
  minutes: 60,
  reason: 'A test ask.',
  ...extra,
})
const agreementRow = (requestId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  siteId: A.siteA,
  requestId,
  employeeId: person(),
  ...extra,
})
const asked = () => ({ status: 'ASKED', askedAt: now(), askedById: a.actorId })
const officeYes = () => ({ answer: 'AGREED', answeredAt: now(), answeredVia: 'OFFICE', answeredById: a.actorId })

// --- the seeds and the walls ----------------------------------------------------------------------------------------

describe('the seeds and the walls', () => {
  it('the seeds are idempotent: a second run writes nothing new', async () => {
    const before = await Promise.all(TABLES.map(count))
    await seedTime({ db: factory, namespace: NS })
    expect(await Promise.all(TABLES.map(count))).toEqual(before)
    expect(before.every((n) => n > 0)).toBe(true)
  })

  it('the office keeps every table; a tablet only what the floor needs; the portal nothing', async () => {
    const models = classifiedModels(loadSchema(), loadOwnership()).filter(({ model }) => FILES.has(model.file))
    expect(models.map(({ model }) => model.name).sort()).toEqual([...TABLES].sort())
    for (const { model, ownership } of models) {
      expect(ownership.access[PARTNER_ROLE], model.name).toBeUndefined()
      expect(ownership.access.factory_runtime, model.name).toBeDefined()
      expect([...(ownership.access[FLOOR_ROLE]?.privileges ?? [])].sort(), model.name).toEqual([...(FLOOR_ACCESS[model.name] ?? [])].sort())
      if (!FLOOR_ACCESS[model.name]) await expect(sql(floor(), `SELECT id FROM "${model.table}" LIMIT 1`), model.name).rejects.toThrow(DENIED)
    }
  })

  it('every personal table names its person, and no column holds biometric data (GDPR art. 9: a badge or a name and PIN only)', async () => {
    const columns = await admin(`SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1::text[])`, [[...TABLES]])
    expect(columns.filter((column) => /finger|face|biometric|photo|retina|iris|template|geo|gps|latitude/i.test(String(column.c)))).toEqual([])
    const personal = TABLES.filter((table) => !['OvertimeRequest', 'AbsenceCode', 'AttendanceMonthClose', 'WorkingTimeRule'].includes(table))
    for (const table of personal) expect(columns.some((column) => column.t === table && column.c === 'employeeId'), table).toBe(true)
  })

  it('a tablet reads its own site’s published roster and the asks from ASKED on, and which months are closed but not their file', async () => {
    const roster = await sql(floor(), `SELECT status::text AS status, "siteId"::text AS site FROM "RosterEntry"`)
    expect(roster.length).toBe(9)
    expect(new Set(roster.map((row) => `${row.status}@${row.site}`))).toEqual(new Set([`PUBLISHED@${A.siteA}`]))
    await expect(sql(floor(), `SELECT note FROM "RosterEntry" LIMIT 1`)).rejects.toThrow(DENIED)
    const asks = await sql(floor(), `SELECT id::text AS id, status::text AS status FROM "OvertimeRequest"`)
    expect(asks).toEqual([{ id: time.requestIds.agreed, status: 'AGREED' }])
    const answers = await sql(floor(), `SELECT id::text AS id FROM "OvertimeAgreement" ORDER BY id`)
    expect(answers.map((row) => row.id).sort()).toEqual([time.agreementIds.draft, time.agreementIds.operator, time.agreementIds.lead].sort())
    const closes = await sql(floor(), `SELECT to_char(month, 'YYYY-MM') AS month, status::text AS status FROM "AttendanceMonthClose" ORDER BY month`)
    expect(closes).toEqual([
      { month: '2026-09', status: 'CLOSED' },
      { month: '2026-10', status: 'OPEN' },
    ])
    await expect(sql(floor(), `SELECT "lulFileId" FROM "AttendanceMonthClose" LIMIT 1`)).rejects.toThrow(DENIED)
    const events = await sql(floor(), `SELECT DISTINCT "siteId"::text AS site FROM "ClockEvent"`)
    expect(events).toEqual([{ site: A.siteA }])
  })

  it('the seeded week tells its story: an approved day, one to fix, overtime by agreement, a closed September sealed', async () => {
    const days = await sql(office(), `SELECT id::text AS id, status::text AS status, manual FROM "AttendanceDay" WHERE "employeeId" = $1::uuid ORDER BY date`, time.employees.operator)
    expect(days.map((row) => row.status)).toEqual(['CLOSED', 'CLOSED', 'APPROVED', 'NEEDS_FIX', 'OPEN'])
    expect(days.at(-1)!.manual).toBe(true)
    const open = await sql(office(), `SELECT kind::text AS kind FROM "AttendanceAnomaly" WHERE "dayId" = $1::uuid AND "resolvedAt" IS NULL ORDER BY kind::text`, time.dayIds.operator28)
    expect(open.map((row) => row.kind)).toEqual(['FLAGGED_EVENT', 'MISSING_CLOCK_OUT'])
    const answers = await sql(office(), `SELECT answer::text AS answer, "answeredVia"::text AS via FROM "OvertimeAgreement" WHERE "requestId" = $1::uuid ORDER BY answer`, time.requestIds.agreed)
    expect(answers).toEqual([
      { answer: 'AGREED', via: 'FLOOR' },
      { answer: 'DECLINED', via: 'OFFICE' },
    ])
    const [september] = await sql(office(), `SELECT status::text AS status, "lulSha256" AS sha, "lulFileId"::text AS file FROM "AttendanceMonthClose" WHERE id = $1::uuid`, time.monthCloseIds.september)
    expect(september).toMatchObject({ status: 'CLOSED', file: time.lulFileId })
    expect(String(september!.sha)).toMatch(/^[0-9a-f]{64}$/)
    const [rules] = await sql(office(), `SELECT count(*)::int AS n FROM "WorkingTimeRule" WHERE status = 'ACTIVE' AND action = 'WARN'`)
    expect(rules!.n).toBe(7)
  })
})

// --- clock events ---------------------------------------------------------------------------------------------------

describe('clock events', () => {
  it('are append-only for every login, the owner included', async () => {
    const id = time.clockIds.firstIn
    await expect(run(office(), `UPDATE "ClockEvent" SET reason = 'x' WHERE id = $1::uuid`, id)).rejects.toThrow(DENIED)
    await expect(run(office(), `DELETE FROM "ClockEvent" WHERE id = $1::uuid`, id)).rejects.toThrow(DENIED)
    await expect(run(floor(), `DELETE FROM "ClockEvent" WHERE id = $1::uuid`, id)).rejects.toThrow(DENIED)
    await expect(admin(`UPDATE "ClockEvent" SET reason = 'x' WHERE id = $1`, [id])).rejects.toThrow(/append-only: UPDATE on "ClockEvent" is refused/)
    await expect(admin(`DELETE FROM "ClockEvent" WHERE id = $1`, [id])).rejects.toThrow(/append-only: DELETE/)
    // An anomaly names a clock event: the truncate names both, and the clock events' trigger refuses it first.
    await expect(admin(`TRUNCATE "ClockEvent", "AttendanceAnomaly"`)).rejects.toThrow(/append-only: TRUNCATE on "ClockEvent"/)
  })

  it('a tablet records a badge clock-in on its own site at the server’s time; a repeat of its event id is refused; never another site or an office source', async () => {
    const event = tabletEvent()
    expect(await insert(floor(), 'ClockEvent', event)).toBe(1)
    await expect(insert(floor(), 'ClockEvent', { ...tabletEvent(), clientEventId: event.clientEventId })).rejects.toThrow(UNIQUE)
    await expect(insert(floor(), 'ClockEvent', tabletEvent({ siteId: A.siteB, companyId: A.companyB, workerId: null, deviceId: null }))).rejects.toThrow()
    await expect(insert(floor(), 'ClockEvent', tabletEvent({ siteId: A.siteB, companyId: A.companyB, workerId: key('worker:B1:operator'), deviceId: key('device:B1:cutting') }))).rejects.toThrow(RLS)
    await expect(insert(floor(), 'ClockEvent', officeEvent())).rejects.toThrow(/a tablet records badge, name-and-PIN and offline clock events only/)
  })

  it('checks each floor source: forgot badge flagged, online at the server’s time, offline at the tablet’s and never ahead', async () => {
    await expect(insert(floor(), 'ClockEvent', tabletEvent({ source: 'NAME_PIN' }))).rejects.toThrow(/flagged FORGOT_BADGE/)
    expect(await insert(floor(), 'ClockEvent', tabletEvent({ source: 'NAME_PIN', flags: ['FORGOT_BADGE'] }))).toBe(1)
    await expect(insert(floor(), 'ClockEvent', tabletEvent({ flags: ['FORGOT_BADGE'] }))).rejects.toThrow(/signed with a badge/)
    await expect(insert(floor(), 'ClockEvent', tabletEvent({ flags: ['CLOCK_SKEW', 'CLOCK_SKEW'] }))).rejects.toThrow(/names a flag twice/)
    const earlier = ago(10)
    await expect(insert(floor(), 'ClockEvent', tabletEvent({ occurredAt: earlier, deviceTime: earlier }))).rejects.toThrow(/was sent online: it counts at the server/)
    expect(await insert(floor(), 'ClockEvent', tabletEvent({ source: 'OFFLINE', occurredAt: earlier, deviceTime: earlier, flags: ['CLOCK_SKEW'] }))).toBe(1)
    await expect(insert(floor(), 'ClockEvent', tabletEvent({ source: 'OFFLINE', occurredAt: earlier, deviceTime: ago(11) }))).rejects.toThrow(/counts at the tablet/)
    const ahead = new Date(Date.now() + 30 * 60_000).toISOString()
    await expect(insert(floor(), 'ClockEvent', tabletEvent({ source: 'OFFLINE', occurredAt: ahead, deviceTime: ahead }))).rejects.toThrow(/never in the future/)
    await expect(insert(floor(), 'ClockEvent', tabletEvent({ deviceId: null }))).rejects.toThrow(/with the worker, the tablet, the tablet's time and its event id/)
    await expect(insert(floor(), 'ClockEvent', tabletEvent({ reason: 'x' }))).rejects.toThrow(/carries no reason/)
  })

  it('the office records MANUAL events with a reason, the automatic clock-out, and work outside the plant on a manual one only', async () => {
    expect(await insert(office(), 'ClockEvent', officeEvent())).toBe(1)
    await expect(insert(office(), 'ClockEvent', officeEvent({ reason: ' ' }))).rejects.toThrow(/event says why/)
    await expect(insert(office(), 'ClockEvent', officeEvent({ deviceId: A.deviceA }))).rejects.toThrow(/has no worker, tablet/)
    await expect(insert(office(), 'ClockEvent', officeEvent({ source: 'AUTO', kind: 'IN' }))).rejects.toThrow(/automatic event .* is a clock-out/)
    expect(await insert(office(), 'ClockEvent', officeEvent({ source: 'AUTO', kind: 'OUT', reason: 'Shift end + 15 min' }))).toBe(1)
    await expect(insert(office(), 'ClockEvent', officeEvent({ source: 'AUTO', kind: 'OUT', offSite: true }))).rejects.toThrow(/only a manual clock-in or clock-out is work outside the plant/)
    expect(await insert(office(), 'ClockEvent', officeEvent({ offSite: true, reason: 'Trade fair stand' }))).toBe(1)
    await expect(insert(office(), 'ClockEvent', officeEvent({ occurredAt: new Date(Date.now() + 3_600_000).toISOString() }))).rejects.toThrow(/never in the future/)
  })

  it('a VOID voids an earlier event of the same person, at its time, once; never a void', async () => {
    const target = officeEvent({ employeeId: person(), occurredAt: ago(90) })
    expect(await insert(office(), 'ClockEvent', target)).toBe(1)
    const voidOf = (extra: Record<string, unknown> = {}) => officeEvent({ employeeId: target.employeeId, kind: 'VOID', occurredAt: target.occurredAt, voidsEventId: target.id, reason: 'Typed twice.', ...extra })
    await expect(insert(office(), 'ClockEvent', voidOf({ occurredAt: ago(5) }))).rejects.toThrow(/voids a clock-in, clock-out or break \(not a VOID\), at its time/)
    await expect(insert(office(), 'ClockEvent', voidOf({ kind: 'OUT' }))).rejects.toThrow(/only a VOID event does/)
    await expect(insert(office(), 'ClockEvent', voidOf({ employeeId: person() }))).rejects.toThrow(/foreign key/)
    const first = voidOf()
    expect(await insert(office(), 'ClockEvent', first)).toBe(1)
    await expect(insert(office(), 'ClockEvent', voidOf())).rejects.toThrow(UNIQUE)
    await expect(insert(office(), 'ClockEvent', voidOf({ voidsEventId: first.id }))).rejects.toThrow(/not a VOID/)
  })

  it('an event dated in a closed month of its company is refused, also from a tablet’s offline queue', async () => {
    await expect(insert(office(), 'ClockEvent', officeEvent({ occurredAt: '2026-09-15T06:00:00.000Z' }))).rejects.toThrow(/in a closed month of its company/)
    const september = '2026-09-30T05:00:00.000Z'
    await expect(insert(floor(), 'ClockEvent', tabletEvent({ source: 'OFFLINE', occurredAt: september, deviceTime: september }))).rejects.toThrow(/in a closed month of its company/)
  })
})

// --- the roster -----------------------------------------------------------------------------------------------------

describe('roster cells', () => {
  const cell = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: randomUUID(),
    companyId: A.companyA,
    siteId: A.siteA,
    employeeId: person(),
    date: '2026-11-09',
    kind: 'WORK',
    shiftPatternId: key('calendar:pattern:2T'),
    shiftLabel: 'Morning',
    startMinute: 360,
    endMinute: 840,
    breakMinutes: 15,
    ...extra,
  })

  it('a shift has its window and a shorter break, a day off none, a publication who and when', async () => {
    await expect(insert(office(), 'RosterEntry', cell({ startMinute: null }))).rejects.toThrow(/has its window/)
    await expect(insert(office(), 'RosterEntry', cell({ startMinute: 1300, endMinute: 2800 }))).rejects.toThrow(/has its window/)
    await expect(insert(office(), 'RosterEntry', cell({ breakMinutes: 480 }))).rejects.toThrow(/break of cell .* shorter than its shift/)
    await expect(insert(office(), 'RosterEntry', cell({ kind: 'OFF' }))).rejects.toThrow(/is a day off: no shift, window or break/)
    expect(await insert(office(), 'RosterEntry', cell({ kind: 'OFF', shiftPatternId: null, shiftLabel: null, startMinute: null, endMinute: null, breakMinutes: 0 }))).toBe(1)
    await expect(insert(office(), 'RosterEntry', cell({ status: 'PUBLISHED' }))).rejects.toThrow(/wrong publication/)
    // A night shift runs past midnight.
    const night = cell({ shiftLabel: 'Night', startMinute: 1320, endMinute: 1800, breakMinutes: 30 })
    expect(await insert(office(), 'RosterEntry', night)).toBe(1)
    expect(await update(office(), 'RosterEntry', night.id as string, { status: 'PUBLISHED', publishedAt: now(), publishedById: a.actorId })).toBe(1)
    await expect(update(office(), 'RosterEntry', night.id as string, { date: '2026-11-10' })).rejects.toThrow(/never change/)
    expect(await remove(office(), 'RosterEntry', night.id as string)).toBe(1)
  })

  it('takes its shift from an ACTIVE pattern; nothing is planned or removed in a closed month', async () => {
    const archived = randomUUID()
    await insert(office(), 'ShiftPattern', { id: archived, code: `OLD-${tag()}`, name: 'Old pattern', status: 'ARCHIVED' })
    await expect(insert(office(), 'RosterEntry', cell({ shiftPatternId: archived }))).rejects.toThrow(/ACTIVE pattern/)
    await expect(insert(office(), 'RosterEntry', cell({ date: '2026-09-28' }))).rejects.toThrow(/in a closed month/)
  })
})

// --- overtime asks and answers --------------------------------------------------------------------------------------

describe('overtime requests and answers', () => {
  it('a request is asked, agreed by somebody, approved and done; what it asks is fixed once asked; never deleted', async () => {
    const request = requestRow()
    const id = request.id as string
    await expect(insert(office(), 'OvertimeRequest', { ...requestRow(), status: 'ASKED', askedAt: now(), askedById: a.actorId })).rejects.toThrow(/starts as a DRAFT/)
    await expect(insert(office(), 'OvertimeRequest', requestRow({ minutes: 800 }))).rejects.toThrow(/asks 1 to 720 minutes/)
    expect(await insert(office(), 'OvertimeRequest', request)).toBe(1)
    const yes = agreementRow(id)
    const no = agreementRow(id)
    expect(await insert(office(), 'OvertimeAgreement', yes)).toBe(1)
    expect(await insert(office(), 'OvertimeAgreement', no)).toBe(1)
    await expect(update(office(), 'OvertimeRequest', id, { status: 'ASKED' })).rejects.toThrow(/wrong ask/)
    expect(await update(office(), 'OvertimeRequest', id, asked())).toBe(1)
    await expect(update(office(), 'OvertimeRequest', id, { minutes: 90 })).rejects.toThrow(/no longer changes/)
    await expect(update(office(), 'OvertimeRequest', id, { status: 'AGREED' })).rejects.toThrow(/only once somebody agreed/)
    expect(await update(office(), 'OvertimeAgreement', yes.id as string, officeYes())).toBe(1)
    expect(await update(office(), 'OvertimeAgreement', no.id as string, { answer: 'DECLINED', answeredAt: now(), answeredVia: 'OFFICE', answeredById: a.actorId })).toBe(1)
    expect(await update(office(), 'OvertimeRequest', id, { status: 'AGREED' })).toBe(1)
    await expect(update(office(), 'OvertimeAgreement', yes.id as string, { answer: 'DECLINED' })).rejects.toThrow(/last yes of request/)
    await expect(update(office(), 'OvertimeRequest', id, { status: 'APPROVED' })).rejects.toThrow(/wrong approval/)
    expect(await update(office(), 'OvertimeRequest', id, { status: 'APPROVED', approvedAt: now(), approvedById: A.hr })).toBe(1)
    await expect(update(office(), 'OvertimeAgreement', no.id as string, officeYes())).rejects.toThrow(/its answers do not change/)
    await expect(insert(office(), 'OvertimeAgreement', agreementRow(id))).rejects.toThrow(/nobody more is asked/)
    expect(await update(office(), 'OvertimeRequest', id, { status: 'DONE', doneAt: now() })).toBe(1)
    await expect(update(office(), 'OvertimeRequest', id, { status: 'CANCELLED', cancelledAt: now(), cancelReason: 'x' })).rejects.toThrow(/is DONE; it never changes/)
    await expect(remove(office(), 'OvertimeRequest', id)).rejects.toThrow(DENIED)
    await expect(admin(`DELETE FROM "OvertimeRequest" WHERE id = $1`, [id])).rejects.toThrow(/cancelled, never deleted/)
  })

  it('a tablet records the worker’s own answer and nothing else; a draft ask is not answered', async () => {
    const request = requestRow()
    await insert(office(), 'OvertimeRequest', request)
    const ask = agreementRow(request.id as string, { employeeId: time.employees.operator })
    await insert(office(), 'OvertimeAgreement', ask)
    const floorYes = { answer: 'AGREED', answeredAt: now(), answeredVia: 'FLOOR', workerId: A.operatorWorker, deviceId: A.deviceA }
    await expect(update(floor(), 'OvertimeAgreement', ask.id as string, floorYes)).rejects.toThrow(/is DRAFT; its answers do not change/)
    await update(office(), 'OvertimeRequest', request.id as string, asked())
    await expect(update(floor(), 'OvertimeAgreement', ask.id as string, { ...floorYes, deviceId: null })).rejects.toThrow(/when and how it came/)
    await expect(update(floor(), 'OvertimeAgreement', ask.id as string, officeYes())).rejects.toThrow(/records the worker's own answer \(FLOOR\)/)
    await expect(update(floor(), 'OvertimeAgreement', ask.id as string, { ...floorYes, createdById: A.operatorWorker })).rejects.toThrow(/never change|own answer/)
    expect(await update(floor(), 'OvertimeAgreement', ask.id as string, floorYes)).toBe(1)
    expect(await update(floor(), 'OvertimeAgreement', ask.id as string, { answer: 'DECLINED', answeredAt: now() })).toBe(1)
    // The seeded draft ask (5 November): its request is out of the tablet's sight, so it is not answered.
    await expect(update(floor(), 'OvertimeAgreement', time.agreementIds.draft, floorYes)).rejects.toThrow(/is DRAFT; its answers do not change/)
  })

  it('an answer starts PENDING; only a person who has not answered is taken off a request still asked', async () => {
    const request = requestRow()
    await insert(office(), 'OvertimeRequest', request)
    await expect(insert(office(), 'OvertimeAgreement', agreementRow(request.id as string, officeYes()))).rejects.toThrow(/starts PENDING/)
    const pending = agreementRow(request.id as string)
    const answered = agreementRow(request.id as string)
    await insert(office(), 'OvertimeAgreement', pending)
    await insert(office(), 'OvertimeAgreement', answered)
    await update(office(), 'OvertimeRequest', request.id as string, asked())
    await update(office(), 'OvertimeAgreement', answered.id as string, officeYes())
    await expect(update(office(), 'OvertimeAgreement', pending.id as string, { answeredVia: 'OFFICE' })).rejects.toThrow(/is PENDING: nobody answered yet/)
    expect(await remove(office(), 'OvertimeAgreement', pending.id as string)).toBe(1)
    await expect(remove(office(), 'OvertimeAgreement', answered.id as string)).rejects.toThrow(/stays/)
  })
})

// --- attendance days and anomalies ----------------------------------------------------------------------------------

describe('attendance days and anomalies', () => {
  it('a day starts OPEN or NEEDS_FIX, with minutes in a day, a planned shift whole or none, in an open month', async () => {
    await expect(insert(office(), 'AttendanceDay', dayRow({ status: 'APPROVED', approvedAt: now(), approvedById: a.actorId }))).rejects.toThrow(/starts OPEN or NEEDS_FIX/)
    await expect(insert(office(), 'AttendanceDay', dayRow({ date: '2026-09-15' }))).rejects.toThrow(/in a closed month/)
    await expect(insert(office(), 'AttendanceDay', dayRow({ presentMinutes: 1500 }))).rejects.toThrow(/0 to 1440/)
    await expect(insert(office(), 'AttendanceDay', dayRow({ plannedStartMinute: 360 }))).rejects.toThrow(/planned shift/)
    await expect(insert(office(), 'AttendanceDay', dayRow({ firstInAt: '2026-10-20T15:00:00Z', lastOutAt: '2026-10-20T05:00:00Z' }))).rejects.toThrow(/not after its last clock-out/)
    expect(await insert(office(), 'AttendanceDay', dayRow({ plannedLabel: 'Morning', plannedStartMinute: 360, plannedEndMinute: 840, plannedMinutes: 465 }))).toBe(1)
  })

  it('is approved once its anomalies are resolved; approved, its figures wait for a reopen; manual stays manual', async () => {
    const day = dayRow({ status: 'NEEDS_FIX' })
    const dayId = day.id as string
    await insert(office(), 'AttendanceDay', day)
    const anomaly = anomalyRow(dayId, day.employeeId as string)
    await insert(office(), 'AttendanceAnomaly', anomaly)
    const approve = { status: 'APPROVED', approvedAt: now(), approvedById: a.actorId }
    await expect(update(office(), 'AttendanceDay', dayId, approve)).rejects.toThrow(/has 1 anomaly still open/)
    await expect(update(office(), 'AttendanceAnomaly', anomaly.id as string, { resolution: 'ACCEPTED', resolvedAt: now(), resolvedById: a.actorId })).rejects.toThrow(/ACCEPTED with why the day stands/)
    expect(await update(office(), 'AttendanceAnomaly', anomaly.id as string, { resolution: 'ACCEPTED', resolvedAt: now(), resolvedById: a.actorId, resolutionNote: 'Worked from the warehouse.' })).toBe(1)
    expect(await update(office(), 'AttendanceDay', dayId, { ...approve, manual: true })).toBe(1)
    await expect(update(office(), 'AttendanceDay', dayId, { presentMinutes: 400 })).rejects.toThrow(/APPROVED; its figures change only once it is reopened/)
    await expect(insert(office(), 'AttendanceAnomaly', anomalyRow(dayId, day.employeeId as string))).rejects.toThrow(/reopen it before an anomaly is raised/)
    await expect(update(office(), 'AttendanceDay', dayId, { status: 'OPEN' })).rejects.toThrow(/wrong approval or close/)
    expect(await update(office(), 'AttendanceDay', dayId, { status: 'OPEN', approvedAt: null, approvedById: null, presentMinutes: 400 })).toBe(1)
    await expect(update(office(), 'AttendanceDay', dayId, { manual: false })).rejects.toThrow(/stays marked manual/)
    await expect(update(office(), 'AttendanceDay', dayId, { date: '2026-10-21' })).rejects.toThrow(/never change/)
    await expect(remove(office(), 'AttendanceDay', dayId)).rejects.toThrow(DENIED)
    await expect(admin(`DELETE FROM "AttendanceDay" WHERE id = $1`, [dayId])).rejects.toThrow(/never deleted/)
  })

  it('an anomaly is of its day’s company and resolved once; what it found never changes; never deleted', async () => {
    const day = dayRow()
    await insert(office(), 'AttendanceDay', day)
    await expect(insert(office(), 'AttendanceAnomaly', anomalyRow(day.id as string, day.employeeId as string, { companyId: A.companyB }))).rejects.toThrow(/of its day's company/)
    await expect(insert(office(), 'AttendanceAnomaly', anomalyRow(day.id as string, person()))).rejects.toThrow(/foreign key/)
    await expect(insert(office(), 'AttendanceAnomaly', anomalyRow(day.id as string, day.employeeId as string, { detail: [1, 2] }))).rejects.toThrow(/detail is an object/)
    const anomaly = anomalyRow(day.id as string, day.employeeId as string)
    await insert(office(), 'AttendanceAnomaly', anomaly)
    await expect(update(office(), 'AttendanceAnomaly', anomaly.id as string, { resolution: 'FIXED', resolvedAt: now() })).rejects.toThrow(/by whom/)
    expect(await update(office(), 'AttendanceAnomaly', anomaly.id as string, { resolution: 'CLEARED', resolvedAt: now() })).toBe(1)
    await expect(update(office(), 'AttendanceAnomaly', anomaly.id as string, { resolutionNote: 'later' })).rejects.toThrow(/is resolved \(CLEARED\); it never changes/)
    await expect(update(office(), 'AttendanceAnomaly', anomaly.id as string, { kind: 'LONG_DAY' })).rejects.toThrow(/what anomaly .* found never changes/)
    await expect(remove(office(), 'AttendanceAnomaly', anomaly.id as string)).rejects.toThrow(DENIED)
    await expect(admin(`DELETE FROM "AttendanceAnomaly" WHERE id = $1`, [anomaly.id])).rejects.toThrow(/never deleted/)
  })
})

// --- absences, overtime entries, timesheets -------------------------------------------------------------------------

describe('absences, overtime entries and timesheets', () => {
  it('an absence takes an active code of its company or the tenant, for 1 to 1440 minutes, in an open month', async () => {
    const entry = (extra: Record<string, unknown> = {}) => ({ id: randomUUID(), companyId: A.companyA, employeeId: person(), date: '2026-11-03', codeId: time.absenceCodeIds.FER, minutes: 465, ...extra })
    await expect(insert(office(), 'AbsenceEntry', entry({ minutes: 0 }))).rejects.toThrow(/1 to 1440 minutes/)
    await expect(insert(office(), 'AbsenceEntry', entry({ documentRef: ' ' }))).rejects.toThrow(/document reference or none/)
    await expect(insert(office(), 'AbsenceEntry', entry({ date: '2026-09-21' }))).rejects.toThrow(/in a closed month/)
    const archived = randomUUID()
    await insert(office(), 'AbsenceCode', { id: archived, code: `X${tag()}`, labelI18n: { it: 'Vecchio', en: 'Old' }, category: 'OTHER', paid: false, status: 'ARCHIVED' })
    await expect(insert(office(), 'AbsenceEntry', entry({ codeId: archived }))).rejects.toThrow(/archived; use an active one/)
    const companyB = randomUUID()
    await insert(office(), 'AbsenceCode', { id: companyB, companyId: A.companyB, code: `B${tag()}`, labelI18n: { it: 'Solo B' }, category: 'OTHER', paid: true })
    await expect(insert(office(), 'AbsenceEntry', entry({ codeId: companyB }))).rejects.toThrow(/code of its company or a tenant-wide one/)
    const sick = entry({ codeId: time.absenceCodeIds.MAL, documentRef: 'PROTOCOL-SEED-0001' })
    expect(await insert(office(), 'AbsenceEntry', sick)).toBe(1)
    await expect(update(office(), 'AbsenceEntry', sick.id, { date: '2026-11-04' })).rejects.toThrow(/never change/)
    expect(await update(office(), 'AbsenceEntry', sick.id, { minutes: 240 })).toBe(1)
    expect(await remove(office(), 'AbsenceEntry', sick.id)).toBe(1)
    await expect(remove(office(), 'AbsenceEntry', time.absenceIds.septemberHoliday)).rejects.toThrow(/in a closed month/)
  })

  it('an absence code names itself in Italian; its code never changes; archived, never deleted', async () => {
    await expect(insert(office(), 'AbsenceCode', { id: randomUUID(), code: `N${tag()}`, labelI18n: { en: 'No Italian' }, category: 'OTHER', paid: false })).rejects.toThrow(/name in Italian/)
    await expect(update(office(), 'AbsenceCode', time.absenceCodeIds.FER as string, { code: 'HOL' })).rejects.toThrow(/never change/)
    expect(await update(office(), 'AbsenceCode', time.absenceCodeIds.FER as string, { lulCode: 'FE' })).toBe(1)
    await expect(remove(office(), 'AbsenceCode', time.absenceCodeIds.FER as string)).rejects.toThrow(DENIED)
    await expect(admin(`DELETE FROM "AbsenceCode" WHERE id = $1`, [time.absenceCodeIds.FER])).rejects.toThrow(/archived, never deleted/)
  })

  it('overtime is PENDING until approved or rejected (with why); decided, it waits for the decision to be taken back', async () => {
    const entry = { id: randomUUID(), companyId: A.companyA, siteId: A.siteA, employeeId: person(), date: '2026-10-22', kind: 'NIGHT', minutes: 60 }
    await expect(insert(office(), 'OvertimeEntry', { ...entry, status: 'APPROVED', approvedAt: now(), approvedById: A.hr })).rejects.toThrow(/starts PENDING/)
    await expect(insert(office(), 'OvertimeEntry', { ...entry, requestId: time.requestIds.draft })).rejects.toThrow(/a request that was asked/)
    expect(await insert(office(), 'OvertimeEntry', entry)).toBe(1)
    await expect(update(office(), 'OvertimeEntry', entry.id, { status: 'APPROVED' })).rejects.toThrow(/wrong decision/)
    expect(await update(office(), 'OvertimeEntry', entry.id, { status: 'APPROVED', approvedAt: now(), approvedById: A.hr })).toBe(1)
    await expect(update(office(), 'OvertimeEntry', entry.id, { minutes: 90 })).rejects.toThrow(/change only once the decision is taken back/)
    await expect(update(office(), 'OvertimeEntry', entry.id, { status: 'REJECTED', rejectedAt: now(), rejectedById: A.hr, rejectReason: 'x' })).rejects.toThrow(/cannot move from APPROVED to REJECTED/)
    await expect(remove(office(), 'OvertimeEntry', entry.id)).rejects.toThrow(/only a pending one is removed/)
    expect(await update(office(), 'OvertimeEntry', entry.id, { status: 'PENDING', approvedAt: null, approvedById: null })).toBe(1)
    await expect(update(office(), 'OvertimeEntry', entry.id, { status: 'REJECTED', rejectedAt: now(), rejectedById: A.hr })).rejects.toThrow(/wrong decision/)
    expect(await update(office(), 'OvertimeEntry', entry.id, { status: 'REJECTED', rejectedAt: now(), rejectedById: A.hr, rejectReason: 'Not asked.' })).toBe(1)
    expect(await update(office(), 'OvertimeEntry', entry.id, { status: 'PENDING', rejectedAt: null, rejectedById: null, rejectReason: null })).toBe(1)
    expect(await remove(office(), 'OvertimeEntry', entry.id)).toBe(1)
  })

  it('a timesheet is approved by the lead, then by HR, two people; sent back with why, its approvals cleared', async () => {
    const sheet = { id: randomUUID(), companyId: A.companyA, employeeId: person(), periodStart: '2026-11-02', periodEnd: '2026-11-08' }
    await expect(insert(office(), 'TimesheetApproval', { ...sheet, periodEnd: '2026-12-01' })).rejects.toThrow(/inside one calendar month/)
    expect(await insert(office(), 'TimesheetApproval', sheet)).toBe(1)
    await expect(update(office(), 'TimesheetApproval', sheet.id, { status: 'APPROVED', hrApprovedAt: now(), hrApprovedById: A.hr })).rejects.toThrow(/cannot move from PENDING to APPROVED/)
    expect(await update(office(), 'TimesheetApproval', sheet.id, { status: 'LEAD_APPROVED', leadApprovedAt: now(), leadApprovedById: a.actorId })).toBe(1)
    await expect(update(office(), 'TimesheetApproval', sheet.id, { status: 'APPROVED', hrApprovedAt: now(), hrApprovedById: a.actorId })).rejects.toThrow(/approved by two people/)
    expect(await update(office(), 'TimesheetApproval', sheet.id, { status: 'APPROVED', hrApprovedAt: now(), hrApprovedById: A.hr })).toBe(1)
    const cleared = { leadApprovedAt: null, leadApprovedById: null, hrApprovedAt: null, hrApprovedById: null }
    await expect(update(office(), 'TimesheetApproval', sheet.id, { status: 'PENDING', ...cleared })).rejects.toThrow(/sent back with when, by whom and why/)
    expect(await update(office(), 'TimesheetApproval', sheet.id, { status: 'PENDING', ...cleared, returnedAt: now(), returnedById: A.hr, returnReason: 'Wednesday is missing.' })).toBe(1)
    await expect(update(office(), 'TimesheetApproval', sheet.id, { returnReason: 'Changed.' })).rejects.toThrow(/changes only when it is sent back/)
    await expect(remove(office(), 'TimesheetApproval', sheet.id)).rejects.toThrow(DENIED)
    await expect(admin(`DELETE FROM "TimesheetApproval" WHERE id = $1`, [sheet.id])).rejects.toThrow(/never deleted/)
    await expect(update(office(), 'TimesheetApproval', time.timesheetIds.september, { status: 'PENDING', leadApprovedAt: null, leadApprovedById: null, hrApprovedAt: null, hrApprovedById: null, returnedAt: now(), returnedById: A.hr, returnReason: 'x' })).rejects.toThrow(/in a closed month/)
  })
})

// --- the month close and corrections --------------------------------------------------------------------------------

describe('the month close', () => {
  it('closes only once every day is closed by it, nothing open or waiting; then nothing is written into the month again; the LUL calendar is sealed once', async () => {
    const employeeId = person()
    const close = { id: randomUUID(), companyId: A.companyB, month: '2026-08-01' }
    const closeId = close.id
    await expect(insert(office(), 'AttendanceMonthClose', { ...close, month: '2026-08-02' })).rejects.toThrow(/by its first day/)
    expect(await insert(office(), 'AttendanceMonthClose', close)).toBe(1)
    const day = { id: randomUUID(), companyId: A.companyB, siteId: A.siteB, employeeId, date: '2026-08-01', presentMinutes: 480, ordinaryMinutes: 480 }
    await insert(office(), 'AttendanceDay', day)
    const closeIt = { status: 'CLOSED', closedAt: now(), closedById: A.hr }
    await expect(update(office(), 'AttendanceMonthClose', closeId, closeIt)).rejects.toThrow(/1 attendance day\(s\) of 2026-08 are not closed/)
    await expect(update(office(), 'AttendanceDay', day.id, { status: 'CLOSED', monthCloseId: closeId, closedAt: now() })).rejects.toThrow(/cannot move from OPEN to CLOSED/)
    await update(office(), 'AttendanceDay', day.id, { status: 'APPROVED', approvedAt: now(), approvedById: a.actorId })
    await expect(update(office(), 'AttendanceDay', day.id, { status: 'CLOSED', monthCloseId: time.monthCloseIds.october, closedAt: now() })).rejects.toThrow(/closed by the close of its own month/)
    expect(await update(office(), 'AttendanceDay', day.id, { status: 'CLOSED', monthCloseId: closeId, closedAt: now() })).toBe(1)
    const overtime = { id: randomUUID(), companyId: A.companyB, siteId: A.siteB, employeeId, date: '2026-08-01', kind: 'DAY', minutes: 30 }
    await insert(office(), 'OvertimeEntry', overtime)
    await expect(update(office(), 'AttendanceMonthClose', closeId, closeIt)).rejects.toThrow(/1 overtime entry of 2026-08 still wait for approval/)
    await update(office(), 'OvertimeEntry', overtime.id, { status: 'APPROVED', approvedAt: now(), approvedById: A.hr })
    await expect(update(office(), 'AttendanceMonthClose', closeId, { status: 'CLOSED' })).rejects.toThrow(/wrong close/)
    expect(await update(office(), 'AttendanceMonthClose', closeId, closeIt)).toBe(1)

    // Nothing is written into a closed month: a clock event, a day, an absence, overtime, a roster cell, a timesheet.
    await expect(insert(office(), 'ClockEvent', officeEvent({ companyId: A.companyB, siteId: A.siteB, employeeId, occurredAt: '2026-08-03T08:00:00.000Z' }))).rejects.toThrow(/closed month/)
    await expect(update(office(), 'AttendanceDay', day.id, { presentMinutes: 470 })).rejects.toThrow(/is CLOSED \(its month is closed\)/)
    await expect(insert(office(), 'AttendanceDay', { ...day, id: randomUUID(), employeeId: person(), status: 'OPEN', date: '2026-08-02' })).rejects.toThrow(/closed month/)
    await expect(insert(office(), 'AbsenceEntry', { id: randomUUID(), companyId: A.companyB, employeeId, date: '2026-08-02', codeId: time.absenceCodeIds.FER, minutes: 480 })).rejects.toThrow(/closed month/)
    await expect(update(office(), 'OvertimeEntry', overtime.id, { status: 'PENDING', approvedAt: null, approvedById: null })).rejects.toThrow(/closed month/)
    await expect(insert(office(), 'RosterEntry', { id: randomUUID(), companyId: A.companyB, siteId: A.siteB, employeeId, date: '2026-08-03', kind: 'OFF' })).rejects.toThrow(/closed month/)
    await expect(insert(office(), 'TimesheetApproval', { id: randomUUID(), companyId: A.companyB, employeeId, periodStart: '2026-08-01', periodEnd: '2026-08-31' })).rejects.toThrow(/closed month/)

    // The LUL calendar: a stored file of this close, with its SHA-256, sealed once.
    const sha = createHash('sha256').update(`lul ${closeId}`).digest('hex')
    const file = (recordId: string) => ({
      id: randomUUID(),
      companyId: A.companyB,
      recordType: 'AttendanceMonthClose',
      recordId,
      kind: 'DOCUMENT',
      originalName: 'LUL 2026-08.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1024,
      sha256: sha,
      storeAccountId: A.store,
      storageKey: `t/${a.tenantId}/c/${A.companyB}/2026/${randomUUID()}`,
      status: 'AVAILABLE',
      availableAt: now(),
    })
    const other = file(time.monthCloseIds.september)
    await insert(office(), 'StoredFile', other)
    await expect(update(office(), 'AttendanceMonthClose', closeId, { lulFileId: other.id, lulSha256: sha })).rejects.toThrow(/an AVAILABLE stored file of this close/)
    const lul = file(closeId)
    await insert(office(), 'StoredFile', lul)
    await expect(update(office(), 'AttendanceMonthClose', closeId, { lulFileId: lul.id })).rejects.toThrow(/comes with its SHA-256/)
    expect(await update(office(), 'AttendanceMonthClose', closeId, { lulFileId: lul.id, lulSha256: sha })).toBe(1)
    await expect(update(office(), 'AttendanceMonthClose', closeId, { lulFileId: other.id, lulSha256: sha })).rejects.toThrow(/sealed once/)
    await expect(update(office(), 'AttendanceMonthClose', closeId, { note: 'Reopened?' })).rejects.toThrow(/it never changes but for its LUL calendar/)
    await expect(remove(office(), 'AttendanceMonthClose', closeId)).rejects.toThrow(/never reopened or deleted/)
  })

  it('an OPEN close is abandoned (deleted); a month waits for its anomalies', async () => {
    const abandoned = { id: randomUUID(), companyId: A.companyB, month: '2027-01-01' }
    await insert(office(), 'AttendanceMonthClose', abandoned)
    expect(await remove(office(), 'AttendanceMonthClose', abandoned.id)).toBe(1)
    // October (company A) has open days and anomalies.
    await expect(update(office(), 'AttendanceMonthClose', time.monthCloseIds.october, { status: 'CLOSED', closedAt: now(), closedById: A.hr })).rejects.toThrow(/not closed by close/)
  })
})

describe('corrections of a closed day', () => {
  const correction = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: randomUUID(),
    companyId: A.companyA,
    employeeId: time.employees.operator,
    dayId: time.dayIds.september29,
    monthCloseId: time.monthCloseIds.september,
    kind: 'ORDINARY',
    minutesBefore: 465,
    minutesAfter: 450,
    reason: 'Left 15 minutes early.',
    ...extra,
  })

  it('are append-only for every login, the owner included', async () => {
    const id = time.correctionIds.first
    await expect(run(office(), `UPDATE "AttendanceCorrection" SET reason = 'x' WHERE id = $1::uuid`, id)).rejects.toThrow(DENIED)
    await expect(run(office(), `DELETE FROM "AttendanceCorrection" WHERE id = $1::uuid`, id)).rejects.toThrow(DENIED)
    await expect(admin(`UPDATE "AttendanceCorrection" SET reason = 'x' WHERE id = $1`, [id])).rejects.toThrow(/append-only: UPDATE on "AttendanceCorrection" is refused/)
    await expect(admin(`DELETE FROM "AttendanceCorrection" WHERE id = $1`, [id])).rejects.toThrow(/append-only: DELETE/)
    await expect(admin(`TRUNCATE "AttendanceCorrection"`)).rejects.toThrow(/append-only: TRUNCATE/)
  })

  it('correct only a CLOSED day, each from the figure now (the latest correction’s, else the closed value)', async () => {
    await expect(insert(office(), 'AttendanceCorrection', correction({ dayId: time.dayIds.operator27 }))).rejects.toThrow(/corrects a CLOSED day/)
    await expect(insert(office(), 'AttendanceCorrection', correction({ reason: ' ' }))).rejects.toThrow(/says why/)
    await expect(insert(office(), 'AttendanceCorrection', correction({ minutesAfter: 465 }))).rejects.toThrow(/changes a figure/)
    await expect(insert(office(), 'AttendanceCorrection', correction({ kind: 'ABSENCE' }))).rejects.toThrow(/names an absence code exactly when/)
    // The seeded chain on the 29th: 465 → 435 → 465, so the figure now is 465.
    await expect(insert(office(), 'AttendanceCorrection', correction({ minutesBefore: 435 }))).rejects.toThrow(/starts from the figure now \(465 minutes\), not 435/)
    expect(await insert(office(), 'AttendanceCorrection', correction())).toBe(1)
    await expect(insert(office(), 'AttendanceCorrection', correction({ minutesAfter: 440 }))).rejects.toThrow(/figure now \(450 minutes\)/)
    expect(await insert(office(), 'AttendanceCorrection', correction({ minutesBefore: 450, minutesAfter: 455 }))).toBe(1)
    // The other figures start from the closed day: its presence, the approved overtime of a class, an absence code's minutes.
    expect(await insert(office(), 'AttendanceCorrection', correction({ kind: 'PRESENT', minutesBefore: 468, minutesAfter: 470 }))).toBe(1)
    expect(await insert(office(), 'AttendanceCorrection', correction({ kind: 'OVERTIME_DAY', minutesBefore: 0, minutesAfter: 30 }))).toBe(1)
    const absence = { dayId: time.dayIds.september30, kind: 'ABSENCE', absenceCodeId: time.absenceCodeIds.FER }
    await expect(insert(office(), 'AttendanceCorrection', correction({ ...absence, minutesBefore: 0, minutesAfter: 240 }))).rejects.toThrow(/figure now \(465 minutes\)/)
    expect(await insert(office(), 'AttendanceCorrection', correction({ ...absence, minutesBefore: 465, minutesAfter: 240 }))).toBe(1)
    expect(await insert(office(), 'AttendanceCorrection', correction({ dayId: time.dayIds.september30, kind: 'ABSENCE', absenceCodeId: time.absenceCodeIds.ROL, minutesBefore: 0, minutesAfter: 225 }))).toBe(1)
  })
})

// --- working-time limits --------------------------------------------------------------------------------------------

describe('working-time limits', () => {
  const rule = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: randomUUID(),
    kind: 'DAILY_REST',
    limitMinutes: 660,
    legalReference: 'D.Lgs. 66/2003 art. 7',
    ...extra,
  })

  it('one ACTIVE rule per scope and kind; a site’s rule names its company; the shapes of each kind', async () => {
    await expect(insert(office(), 'WorkingTimeRule', rule())).rejects.toThrow(/WorkingTimeRule_one_active/)
    expect(await insert(office(), 'WorkingTimeRule', rule({ status: 'ARCHIVED' }))).toBe(1)
    expect(await insert(office(), 'WorkingTimeRule', rule({ companyId: A.companyB }))).toBe(1)
    expect(await insert(office(), 'WorkingTimeRule', rule({ companyId: A.companyB, siteId: A.siteB, action: 'BLOCK', source: 'CCNL' }))).toBe(1)
    await expect(insert(office(), 'WorkingTimeRule', rule({ siteId: A.siteB, status: 'ARCHIVED' }))).rejects.toThrow(/a site's rule names its company/)
    await expect(insert(office(), 'WorkingTimeRule', rule({ breakMinutes: 10, status: 'ARCHIVED' }))).rejects.toThrow(/BREAK_AFTER rule only/)
    await expect(insert(office(), 'WorkingTimeRule', rule({ kind: 'BREAK_AFTER', limitMinutes: 360, status: 'ARCHIVED' }))).rejects.toThrow(/BREAK_AFTER rule only/)
    await expect(insert(office(), 'WorkingTimeRule', rule({ kind: 'WEEKLY_AVERAGE', limitMinutes: 2880, referenceMonths: 13, status: 'ARCHIVED' }))).rejects.toThrow(/reference period \(1 to 12 months\)/)
    await expect(insert(office(), 'WorkingTimeRule', rule({ referenceMonths: 4, status: 'ARCHIVED' }))).rejects.toThrow(/belongs to the weekly average only/)
    await expect(insert(office(), 'WorkingTimeRule', rule({ limitMinutes: 0, status: 'ARCHIVED' }))).rejects.toThrow(/limit above 0/)
    await expect(insert(office(), 'WorkingTimeRule', rule({ legalReference: ' ', status: 'ARCHIVED' }))).rejects.toThrow(/names the law it applies/)
    await expect(insert(office(), 'WorkingTimeRule', rule({ alertRoles: ['owner', 'owner'], status: 'ARCHIVED' }))).rejects.toThrow(/whom it alerts once each/)
  })

  it('its scope and kind never change; archived, never deleted', async () => {
    const daily = time.ruleIds.DAILY_REST as string
    await expect(update(office(), 'WorkingTimeRule', daily, { kind: 'WEEKLY_REST' })).rejects.toThrow(/never change/)
    await expect(update(office(), 'WorkingTimeRule', daily, { companyId: A.companyA })).rejects.toThrow(/never change/)
    expect(await update(office(), 'WorkingTimeRule', daily, { action: 'BLOCK', alertRoles: ['owner'] })).toBe(1)
    await expect(remove(office(), 'WorkingTimeRule', daily)).rejects.toThrow(DENIED)
    await expect(admin(`DELETE FROM "WorkingTimeRule" WHERE id = $1`, [daily])).rejects.toThrow(/archived, never deleted/)
  })
})
