import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Redis } from 'ioredis'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { hashPin } from '@nexus/factory-domain/auth/floor/pin'
import { localInstant, plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedAndon } from '../../../../../../packages/factory-db/seed/andon'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPeople, type PeopleSeed } from '../../../../../../packages/factory-db/seed/people'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seed as seedProduction, type ProductionSeed } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../../adapters/local-files/local'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { readsThroughModule } from '../../../platform/files/owned'
import { createFilesRuntime, useFiles } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'
import { switchOnPerformance } from '../privacy/testing/performance-gate'

/**
 * Floor My day (B-W2b-68; MES-111, MES-112, MES-261; design floor.myday; c.c. art. 2101; GDPR art. 15; Statuto dei Lavoratori
 * art. 4; Owner answers F1, F2) through the app's real routes on a throwaway PostgreSQL 17 database from the migrations (the
 * runtime login: row-level security and the grants are real), with a real tablet and the worker signed in with a real PIN.
 * Facts the screens of other steps make (scans, the ledger, a statement, the switch) are written here as the replication role,
 * on today counted from the clock. Every name and figure is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/people/myday`.
 */

vi.setConfig({ testTimeout: 60_000 })

let h: Harness
let tablet: Browser
let production: ProductionSeed
let people: PeopleSeed
let redis: TestRedis
let connection: Redis
let filesRoot = ''

const NS = 'w2b68-myday'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const companyB = idOf('company:B')
const siteA1 = idOf('site:A1')
const lineL1 = idOf('site:A1:line:L1')
const sew1 = idOf('site:A1:station:SEW-01')
const operator = idOf('worker:A1:operator')
const lead = idOf('worker:A1:lead')
const TENANT: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'A' }, { id: companyB, code: 'B' }] }
const PIN = '573914'

const ROME = 'Europe/Rome'
const today = businessDate(new Date(), ROME)
const MONTH = today.slice(0, 7)
const local = (hhmm: string, date = today): Date => {
  const [hour, minute] = hhmm.split(':').map(Number)
  return localInstant(date, hour! * 60 + minute!, ROME)
}

type Json = Record<string, any>
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
/** Rows only other steps' guarded paths write: written as the replication role. */
const replica = (sql: string) => h.db.admin.query(`BEGIN; SET LOCAL session_replication_role = replica; ${sql}; COMMIT`)
const run = randomBytes(4).toString('hex')
let serial = 0
const keyed = () => ({ headers: { 'idempotency-key': `k-${run}-${++serial}` } })
const outbox = (type: string) => admin('SELECT subject, payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id', [T, type])

let workOrderId = ''
let sew = ''
let cell = ''
const employee = { a: '', b: '' }

async function bundle(quantity = 40): Promise<string> {
  const id = newId()
  await admin('INSERT INTO "Bundle" (id, "tenantId", "siteId", "workOrderId", "workOrderSizeId", code, quantity, "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, now())', [id, T, siteA1, workOrderId, cell, `T-${run}-${++serial}`, quantity])
  return id
}

interface ScanInput {
  readonly at: Date
  readonly workerId?: string
  readonly good?: number
  readonly scrap?: number
  readonly members?: readonly (readonly [string, string])[]
  readonly kind?: 'REPORT' | 'UNDO'
  readonly correctsId?: string
  readonly bundleId?: string
}

async function report(input: ScanInput): Promise<string> {
  const id = newId()
  const kind = input.kind ?? 'REPORT'
  const bundleId = input.bundleId ?? (await bundle(Math.max(40, input.good ?? 0)))
  await admin(
    `INSERT INTO "OperationScan" (id, "tenantId", "siteId", "workOrderId", "workOrderOperationId", "bundleId", kind, "correctsId", "goodQuantity", "scrapQuantity", "reworkQuantity", reason, "workerId", "stationId", "clientScanId", "deviceTime", "serverTime")
     VALUES ($1, $2, $3, $4, $5, $6, $7::"ScanKind", $8, $9, $10, 0, $11, $12, $13, $14, $15, $15)`,
    [id, T, siteA1, workOrderId, sew, bundleId, kind, input.correctsId ?? null, kind === 'UNDO' ? 0 : (input.good ?? 10), input.scrap ?? 0, kind === 'UNDO' ? 'Made-up reason' : null, input.workerId ?? operator, sew1, `scan-${run}-${++serial}`, input.at],
  )
  for (const [workerId, employeeId] of input.members ?? []) await admin('INSERT INTO "OperationScanMember" (id, "tenantId", "siteId", "scanId", "workerId", "employeeId") VALUES ($1, $2, $3, $4, $5, $6)', [newId(), T, siteA1, id, workerId, employeeId])
  return id
}

const targets = async (pieces: number, hours: readonly number[]) => {
  for (const hour of hours) await admin('INSERT INTO "LineTarget" (id, "tenantId", "siteId", "lineId", "workDate", hour, "targetPieces", "updatedAt") VALUES ($1, $2, $3, $4, $5::date, $6, $7, now()) ON CONFLICT DO NOTHING', [newId(), T, siteA1, lineL1, today, hour, pieces])
}

/** The tablet's clock moves past the PIN's two minutes, and the next read must ask it. */
const pinRunsOut = () => h.clock.set(new Date(h.clock.now().getTime() + 3 * 60_000))
const stepUp = async () => {
  const answer = await tablet.post('/floor/step-up', { pin: PIN })
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
}
const myDay = async (query = ''): Promise<Json> => {
  const answer = await tablet.get(`/people/myday${query}`)
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  return answer.body as Json
}

const period = { id: '', statement: '', draft: '' }
let closeGate: (() => Promise<void>) | null = null
const openGate = async () => {
  closeGate = await switchOnPerformance((sql, params) => h.db.admin.query(sql, params as unknown[]), { tenantId: T, companyId: companyA, siteId: siteA1, byId: newId() })
  // On since yesterday: a read at a fixed hour of today finds it on.
  await replica(`UPDATE "PeopleLegalGate" SET "switchedOnAt" = now() - interval '2 days' WHERE "siteId" = '${siteA1}' AND "switchedOffAt" IS NULL`)
}

/** Piece pay on from the first of last month, a period of this month, one entry each for two people, a statement each. */
async function startPiecePay(): Promise<void> {
  const first = `${MONTH}-01`
  await replica(`INSERT INTO "PiecePaySwitch" (id, "tenantId", "companyId", "siteId", state, "onFrom", "updatedAt") VALUES ('${siteA1}', '${T}', '${companyA}', '${siteA1}', 'ON', '${first}', now())`)
  period.id = newId()
  const lastDay = plusDays(`${plusDays(first, 32).slice(0, 7)}-01`, -1)
  await replica(`INSERT INTO "PayPeriod" (id, "tenantId", "companyId", "periodStart", "periodEnd", status, "updatedAt") VALUES ('${period.id}', '${T}', '${companyA}', '${first}', '${lastDay}', 'OPEN', now())`)
  const entry = (employeeId: string, workerId: string, amount: number) =>
    `INSERT INTO "EarningsEntry" (id, "tenantId", "companyId", "siteId", "payPeriodId", "employeeId", "workerId", "workDate", kind, pieces, amount, currency, "idempotencyKey") VALUES ('${newId()}', '${T}', '${companyA}', '${siteA1}', '${period.id}', '${employeeId}', '${workerId}', '${today}', 'SCAN', 10, ${amount}, 'EUR', 'scan:${newId()}')`
  await replica(`${entry(employee.a, operator, 1500)}; ${entry(employee.b, lead, 99900)}`)
  const summary = JSON.stringify({ currency: 'EUR', lines: [{ operationCode: 'SEW', operationName: 'Made-up sewing', pieces: 10, minutes: '15.000', rate: '1.500000', sharePct: null, amount: 1500 }], time: [], corrections: [], attendance: null, makeUp: null, held: { open: 0, counted: 0, notPaid: 0 }, disputes: { open: 0, answered: 0 }, defects: { scrap: 0, rework: 0 } })
  period.statement = newId()
  period.draft = newId()
  const statement = (id: string, employeeId: string, status: string, approved: boolean) =>
    `INSERT INTO "WorkerStatement" (id, "tenantId", "companyId", "siteId", "payPeriodId", "employeeId", revision, status, summary, "earningsAmount", "makeUpAmount", currency, "approvedAt", "approvedById", "updatedAt") VALUES ('${id}', '${T}', '${companyA}', '${siteA1}', '${period.id}', '${employeeId}', 1, '${status}', '${summary}'::jsonb, 1500, 0, 'EUR', ${approved ? 'now()' : 'NULL'}, ${approved ? `'${newId()}'` : 'NULL'}, now())`
  await replica(`${statement(period.statement, employee.a, 'APPROVED', true)}; ${statement(period.draft, employee.b, 'DRAFT', false)}`)
}

beforeAll(async () => {
  h = await startHarness('people_myday')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedPrivacy({ db: h.database, namespace: NS })
  production = await seedProduction({ db: h.database, namespace: NS })
  people = await seedPeople({ db: h.database, namespace: NS })
  await seedAndon({ db: h.database, namespace: NS })
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  workOrderId = production.workOrderId
  sew = production.operationIds.sew
  cell = Object.values(production.cellIds)[0]!
  employee.a = people.employeeIds.e1
  employee.b = people.employeeIds.e2
  // A colleague who acknowledged the notice too, and the company's legal data its statement's letterhead asks for.
  await admin('INSERT INTO "WorkerNoticeAck" (id, "tenantId", "siteId", "workerId", "noticeId", "noticeVersion", locale, "noticeSha256", channel, "deviceId", "deviceTime", "serverTime") SELECT gen_random_uuid(), a."tenantId", a."siteId", $1, a."noticeId", a."noticeVersion", a.locale, a."noticeSha256", a.channel, a."deviceId", a."deviceTime", a."serverTime" FROM "WorkerNoticeAck" a WHERE a."workerId" = $2', [lead, operator])
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT00000000000', "fiscalCode" = '00000000000', "reaOffice" = 'RM', "reaNumber" = '000000', address = '{"line1":"Via Finta 1","postalCode":"00100","city":"Roma","country":"IT"}'::jsonb WHERE id = $1`, [companyA])
  redis = testRedis()
  connection = redis.connect()
  filesRoot = mkdtempSync(join(tmpdir(), 'factory-myday-files-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: filesRoot, environment: 'test' }) }))
  const supervisor = await addUser(h, TENANT, { email: `supervisor-${run}@example.test`, role: 'floor_supervisor' })
  const browser = new Browser(h.app)
  const signedIn = await browser.signIn(TENANT.slug, supervisor.email, supervisor.password)
  if (signedIn.body.status !== 'signed_in') throw new Error(`sign-in: ${signedIn.status} ${JSON.stringify(signedIn.body)}`)
  const made = await browser.post('/auth/floor/devices', { siteId: siteA1, stationId: sew1, name: `Sewing tablet ${run}` })
  if (made.status !== 200) throw new Error(`enrol: ${made.status} ${JSON.stringify(made.body)}`)
  await admin('UPDATE "Worker" SET "pinHash" = $2 WHERE id = $1', [operator, await hashPin(PIN, h.auth.pins, { logN: 12, r: 8, p: 1 })])
  tablet = new Browser(h.app)
  await tablet.get('/auth/csrf')
  const enrolled = await tablet.post('/floor/device/enrol', { code: made.body.enrolment.code, appVersion: '1.0.0' })
  if (enrolled.status !== 200) throw new Error(`exchange: ${enrolled.status} ${JSON.stringify(enrolled.body)}`)
  const signed = await tablet.post('/floor/sign-in', { workerId: operator, pin: PIN })
  if (signed.status !== 200) throw new Error(`floor sign-in: ${signed.status} ${JSON.stringify(signed.body)}`)
}, 600_000)

afterEach(() => {
  vi.useRealTimers()
})

afterAll(async () => {
  useFiles(undefined)
  await connection?.quit().catch(() => undefined)
  await h?.close()
  if (filesRoot) rmSync(filesRoot, { recursive: true, force: true })
}, 60_000)

describe('the PIN again on a shared tablet (Owner answer F1)', () => {
  it('every figure asks it: past its two minutes the read answers 403 stepUp, and opens again with the PIN', async () => {
    await pinRunsOut()
    for (const path of ['/people/myday', `/people/myday/statements/${newId()}/pdf`]) {
      const refused = await tablet.get(path)
      expect(refused.status, path).toBe(403)
      expect(JSON.stringify(refused.body), path).toContain('stepUp')
    }
    const print = await tablet.post(`/people/myday/statements/${newId()}/print`, {}, keyed())
    expect(print.status).toBe(403)
    await stepUp()
    await myDay()
  })

  it('the badge asks no PIN and says no figure', async () => {
    await pinRunsOut()
    const answer = await tablet.get('/people/myday/answers')
    expect(answer.status).toBe(200)
    expect(Object.keys(answer.body as Json)).toEqual(['ids'])
    await stepUp()
  })
})

describe('Today: the worker\'s own records, whatever the gates (GDPR art. 15)', () => {
  it('pieces with the PERFORMANCE gate off, and no minute, no efficiency, no pace, no money', async () => {
    await report({ at: local('08:40'), good: 20, scrap: 2 })
    await report({ at: local('08:45'), good: 500, workerId: lead })
    const day = await myDay()
    expect(day).toMatchObject({ subject: 'WORKER', linked: true, today, month: MONTH, work: { pieces: 20, scrap: 2, reports: 1 }, performance: null, pay: null, paysToday: false })
  })

  it('an undone report counts for nothing', async () => {
    const bundleId = await bundle()
    const undone = await report({ at: local('08:50'), good: 7, bundleId })
    await report({ at: local('08:51'), kind: 'UNDO', correctsId: undone, bundleId })
    expect((await myDay()).work.pieces).toBe(20)
  })
})

describe('minutes and pace, only with the PERFORMANCE gate (Statuto dei Lavoratori art. 4 c.1)', () => {
  it('the worker\'s own pace against the line\'s target; the line\'s output is nowhere in the answer (Owner answer F2)', async () => {
    await openGate()
    await targets(30, [8, 9, 10, 11])
    // 11:30 at the site: everyone's clock but the database's is fixed for this read.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(local('11:30'))
    await report({ at: local('10:00'), good: 40 })
    const day = await myDay()
    expect(day.performance).toMatchObject({ traineeDay: false, sharedReports: 0, efficiency: null })
    expect(Number(day.performance.earnedMinutes)).toBeGreaterThan(0)
    const { pace } = day.performance
    expect(pace).toMatchObject({ line: { code: 'L1' }, done: 60, target: 120, targetSoFar: 105, hourTarget: 30, percent: 57, pace: 'BEHIND' })
    // Five hundred pieces of a colleague on the same line reach nobody's pace but theirs.
    expect(JSON.stringify(day)).not.toContain('500')
    expect(JSON.stringify(day)).not.toContain(lead)
    expect(JSON.stringify(day)).not.toContain(employee.b)
    expect(Object.keys(pace).sort()).toEqual(['done', 'hourTarget', 'line', 'look', 'pace', 'percent', 'target', 'targetSoFar'])
  })

  it('a report shared with someone is left out of the pace, and said', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(local('11:30'))
    await report({ at: local('10:30'), good: 5, members: [[operator, employee.a], [lead, employee.b]] })
    const day = await myDay()
    expect(day.work.pieces).toBe(65)
    expect(day.performance.pace.done).toBe(60)
    expect(day.performance.sharedReports).toBe(1)
  })

  it('a trainee day: pieces stand, no minutes against them', async () => {
    const skill = newId()
    const row = newId()
    await replica(`INSERT INTO "Skill" (id, "tenantId", code, name, kind, "updatedAt") VALUES ('${skill}', '${T}', 'MADE-UP', 'Made-up skill', 'OPERATION', now());
      INSERT INTO "EmployeeSkill" (id, "tenantId", "siteId", "employeeId", "skillId", level, since, "assessedAt", "assessedById", "traineeUntil", "updatedAt") VALUES ('${row}', '${T}', '${siteA1}', '${employee.a}', '${skill}', 'LEARNING', '${plusDays(today, -1)}', now(), '${newId()}', '${plusDays(today, 1)}', now())`)
    const day = await myDay()
    expect(day.performance).toMatchObject({ traineeDay: true, pace: { done: 0, pace: 'NO_TARGET' } })
    expect(day.work.pieces).toBe(65)
    await replica(`DELETE FROM "EmployeeSkill" WHERE id = '${row}'`)
  })

  it('off again: nothing computed, for a person who just read it', async () => {
    await closeGate!()
    expect((await myDay()).performance).toBeNull()
    await openGate()
  })
})

describe('money, only where piece pay covers the month, own record only (GATE-PIECE-PAY; pay grain)', () => {
  it('no switch: no money; the switch on: the worker\'s own entries, nobody else\'s', async () => {
    expect((await myDay()).pay).toBeNull()
    await startPiecePay()
    const day = await myDay()
    expect(day.paysToday).toBe(true)
    expect(day.pay).toMatchObject({ todayEarnings: 1500, periodEarnings: 1500, statement: { id: period.statement, status: 'APPROVED' } })
    expect(JSON.stringify(day)).not.toContain('99900')
  })

  it('a month the switch does not cover has no money', async () => {
    const day = await myDay(`?month=${plusDays(`${MONTH}-01`, -1).slice(0, 7)}`)
    expect(day.pay).toBeNull()
    expect(day.work.pieces).toBe(65)
  })
})

describe('my statement (c.c. art. 2101 c.3)', () => {
  it('a shared tablet keeps no PDF: refused in words; on the person\'s own phone it opens, as a PDF nobody stores', async () => {
    const refused = await tablet.get(`/people/myday/statements/${period.statement}/pdf`)
    expect(refused.status).toBe(409)
    expect(JSON.stringify(refused.body)).toContain('refusal/PHONE_ONLY')
    const device = (await admin<{ id: string }>('SELECT "deviceId" AS id FROM "FloorSession" WHERE "tenantId" = $1 AND "workerId" = $2 ORDER BY "startedAt" DESC LIMIT 1', [T, operator]))[0]!.id
    await replica(`UPDATE "Device" SET mode = 'PHONE', "stationId" = NULL, "personalWorkerId" = '${operator}' WHERE id = '${device}'`)
    const pdf = await tablet.get(`/people/myday/statements/${period.statement}/pdf`)
    expect(pdf.status).toBe(200)
    expect(String(pdf.response.headers['content-type'])).toContain('application/pdf')
    expect(pdf.response.headers['cache-control']).toBe('no-store')
    expect(await admin('SELECT id FROM "StoredFile" WHERE "recordType" = $1', ['WorkerStatement'])).toEqual([])
    await replica(`UPDATE "Device" SET mode = 'STATION', "stationId" = '${sew1}', "personalWorkerId" = NULL WHERE id = '${device}'`)
  })

  it('someone else\'s statement is not there, as one that never was', async () => {
    const theirs = await tablet.get(`/people/myday/statements/${period.draft}/pdf`)
    const none = await tablet.get(`/people/myday/statements/${newId()}/pdf`)
    expect(theirs.status).toBe(none.status)
    const printTheirs = await tablet.post(`/people/myday/statements/${period.draft}/print`, {}, keyed())
    const printNone = await tablet.post(`/people/myday/statements/${newId()}/print`, {}, keyed())
    expect(printTheirs.status).toBe(404)
    expect(printNone.status).toBe(404)
  })

  it('print: only with one office printer known, then in the worker\'s name, the file stored once and office only', async () => {
    const noPrinter = await tablet.post(`/people/myday/statements/${period.statement}/print`, {}, keyed())
    expect(noPrinter.status).toBe(409)
    expect(JSON.stringify(noPrinter.body)).toContain('refusal/NO_PRINTER')
    expect((await myDay()).printer).toBe(false)
    const printer = newId()
    await admin(`INSERT INTO "Printer" (id, "tenantId", "companyId", "siteId", code, name, kind, relay, "relayTarget", "updatedAt") VALUES ($1, $2, $3, $4, 'A4-OFFICE', 'Made-up office', 'A4_PDF', 'FAKE', 'office', now())`, [printer, T, companyA, siteA1])
    expect((await myDay()).printer).toBe(true)
    const first = await tablet.post(`/people/myday/statements/${period.statement}/print`, {}, keyed())
    expect(first.status, JSON.stringify(first.body)).toBe(201)
    expect(first.body).toMatchObject({ job: { status: 'QUEUED' }, printer: { code: 'A4-OFFICE' } })
    const job = (await admin('SELECT * FROM "PrintJob" WHERE id = $1', [(first.body as Json).job.id]))[0]!
    expect(job).toMatchObject({ recordType: 'WorkerStatement', recordId: period.statement, requestedById: operator, payloadKind: 'PDF' })
    expect(job.deviceId).toBeTruthy()
    const files = await admin('SELECT id, visibility FROM "StoredFile" WHERE "recordType" = $1 AND "recordId" = $2', ['WorkerStatement', period.statement])
    expect(files).toHaveLength(1)
    expect(String(files[0]!.visibility)).toContain('OFFICE')
    expect(String(files[0]!.visibility)).not.toContain('FLOOR')
    const second = await tablet.post(`/people/myday/statements/${period.statement}/print`, {}, keyed())
    expect(second.status).toBe(201)
    expect(await admin('SELECT id FROM "StoredFile" WHERE "recordType" = $1', ['WorkerStatement'])).toHaveLength(1)
    expect((await outbox('print.job_queued')).length).toBeGreaterThanOrEqual(2)
    // A file of one person's pay opens through nothing generic: files.read never reaches it.
    expect(readsThroughModule('WorkerStatement')).toBe(true)
  })

  it('two A4 printers: the tablet does not guess which stands in the office', async () => {
    await admin(`INSERT INTO "Printer" (id, "tenantId", "companyId", "siteId", code, name, kind, relay, "relayTarget", "updatedAt") VALUES ($1, $2, $3, $4, 'A4-DOCK', 'Made-up dock', 'A4_PDF', 'FAKE', 'dock', now())`, [newId(), T, companyA, siteA1])
    expect((await myDay()).printer).toBe(false)
    const refused = await tablet.post(`/people/myday/statements/${period.statement}/print`, {}, keyed())
    expect(JSON.stringify(refused.body)).toContain('refusal/NO_PRINTER')
  })

  it('a draft leaves no screen', async () => {
    await replica(`UPDATE "WorkerStatement" SET status = 'DRAFT', "approvedAt" = NULL, "approvedById" = NULL, "fileId" = NULL WHERE id = '${period.statement}'`)
    const refused = await tablet.post(`/people/myday/statements/${period.statement}/print`, {}, keyed())
    expect(refused.status).toBe(409)
    expect(JSON.stringify(refused.body)).toContain('refusal/NOT_APPROVED')
  })
})

describe('the badge on the tile: an answered dispute (design "a dispute answered → a badge on the My day tile")', () => {
  it('names the worker\'s own answered disputes only', async () => {
    const mine = await report({ at: local('09:00') })
    const raised = await tablet.post('/production/labour/floor/disputes', { clientEventId: `event-${run}-${++serial}`, recordType: 'OperationScan', recordId: mine, reason: 'WRONG_QUANTITY' }, keyed())
    expect(raised.status, JSON.stringify(raised.body)).toBe(201)
    const id = (raised.body as Json).dispute.id as string
    expect(((await tablet.get('/people/myday/answers')).body as Json).ids).toEqual([])
    await admin(`UPDATE "LabourDispute" SET status = 'UPHELD', answer = 'Made-up answer', "answeredAt" = now(), "answeredById" = $2 WHERE id = $1`, [id, newId()])
    const theirs = await report({ at: local('09:05'), workerId: lead })
    const other = newId()
    await replica(`INSERT INTO "LabourDispute" (id, "tenantId", "siteId", "workerId", "workDate", "recordType", "recordId", message, status, answer, "answeredAt", "updatedAt") SELECT '${other}', "tenantId", "siteId", '${lead}', "workDate", "recordType", '${theirs}', message, 'UPHELD', 'Made-up answer', now(), now() FROM "LabourDispute" WHERE id = '${id}'`)
    expect(((await tablet.get('/people/myday/answers')).body as Json).ids).toEqual([id])
  })
})

describe('a site that records stations (MES-278)', () => {
  it('names nobody: no personal day', async () => {
    await replica(`UPDATE "ProductionSettings" SET "scanSubject" = 'STATION' WHERE id = '${siteA1}'`)
    expect(await myDay()).toMatchObject({ subject: 'STATION', work: { pieces: 0 }, performance: null, pay: null })
    await replica(`UPDATE "ProductionSettings" SET "scanSubject" = 'WORKER' WHERE id = '${siteA1}'`)
  })
})
