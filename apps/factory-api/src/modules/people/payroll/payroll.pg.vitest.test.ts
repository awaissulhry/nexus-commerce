import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import ExcelJS from 'exceljs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { localInstant, plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { closePhrases } from '@nexus/factory-domain/people/close/rules'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedEmail } from '../../../../../../packages/factory-db/seed/email'
import { FakeSes, textOf, type FakeMail } from '../../../adapters/ses/fake'
import { sesMailAdapter } from '../../../adapters/ses/ses'
import { localFileStore } from '../../../adapters/local-files/local'
import { buildApp } from '../../../core/app'
import { testAuthenticator } from '../../../core/context'
import { LOCAL_COOKIE_SECRET, LOCAL_PIN_PEPPER } from '../../../env'
import { createOfficeAuth } from '../../../platform/auth/sessions/office-auth'
import { pdfFlatText } from '../../../platform/documents/testing/pdf-text'
import { createEmailRuntime, useEmail } from '../../../platform/email-out/service'
import { createFilesRuntime, useFiles } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { carriesLink, LINK_HEADER, LINK_UNAVAILABLE, linkAuthenticator } from '../../../platform/links/authenticator'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'
import { grant, HR, keysOf, openWorld, pathsOf, ROME, type Json, type World } from '../overtime/testing'

/**
 * The payroll export (B-W2b-54; MES-267, MES-268, MES-270 to MES-274) through the app's real routes on a throwaway PostgreSQL 17
 * (the runtime login: row-level security, the grants and the …_pay_w2b_guards are real; a local file store, FAKE R2; FAKE SES).
 * Every name, code and value is made up; the month is the latest whole month the seeds left empty, counted from the clock.
 *
 * What the tests name: Nexus does not run payroll: it makes a file for the labour consultant (GATE-PAYROLL); nothing reaches the
 * consultant broken (MES-272); a correction replaces the file and the old one is kept (MES-273); the file travels by an
 * expiring link whose downloads are logged, never as an attachment (MES-274; GDPR art. 32); Statuto dei Lavoratori art. 4 c.2
 * (the ATTENDANCE gate first); Owner answer W1 (no person's figure in a list). Run with
 * `node scripts/factory/run-pg-tests.mjs modules/people/payroll`.
 */

/** Runs once, between the draft and the number: the moment a correction can land while a file is being made. */
const hooks = vi.hoisted(() => ({ beforePut: null as null | (() => Promise<void>) }))
vi.mock('../../../platform/files/files', async (original) => {
  const actual = await original<typeof import('../../../platform/files/files')>()
  return {
    ...actual,
    putGeneratedFile: async (...args: Parameters<typeof actual.putGeneratedFile>) => {
      const hook = hooks.beforePut
      hooks.beforePut = null
      await hook?.()
      return actual.putGeneratedFile(...args)
    },
  }
})

let w: World
let linkApp: FastifyInstance
let redis: TestRedis
let connection: Redis
let filesRoot: string
let M: string
let D: string
/** B-W2b-163: the month of hours only whose file the link tests send (a file with amounts never goes by link). */
let hoursMonth: string
const ses = new FakeSes()

const NS = 'w2b54-payroll'
const WEB_ORIGIN = 'http://localhost:3200'
const CONSULTANT = 'studio.made-up@example.com'
const run = randomBytes(4).toString('hex')
let keys = 0

const PAYROLL = ['people.payroll.view', 'people.payroll.records', 'people.payroll.manage'] as const
const ATTENDANCE_CLOSE = ['people.attendance.close', 'people.attendance.correct'] as const
const actorOfPayroll = (): string => (w.sessions.payroll as unknown as { actorId: string }).actorId
const monthUrl = (more = '') => `/people/payroll/month?companyId=${w.T.companyA}&month=${M}${more}`
const count = async (sql: string, values: unknown[]): Promise<number> => (await w.admin<{ n: number }>(`SELECT count(*)::int AS n ${sql}`, values))[0]!.n
const checkOf = (month: Json, code: string): Json => (month.checks as Json[]).find((check) => check.code === code)!
const mailsTo = (address: string): FakeMail[] => ses.mails.filter((mail) => mail.to.includes(address))
const tokenOf = (mail: FakeMail): string => decodeURIComponent(/#token=(\S+)/.exec(textOf(mail.raw))![1]!)
const asLink = (token: string | undefined, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  linkApp.inject({ method, url, headers: { ...(token === undefined ? {} : { [LINK_HEADER]: token }), ...(method === 'POST' ? { 'idempotency-key': `link-${run}-${++keys}` } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })

async function freeMonth(before?: string): Promise<string> {
  let day = plusDays(`${before ?? businessDate(new Date(), ROME).slice(0, 7)}-01`, -1)
  for (;;) {
    const month = day.slice(0, 7)
    const taken = await count(`FROM (SELECT "companyId", date FROM "AttendanceDay" UNION ALL SELECT "companyId", date FROM "RosterEntry" UNION ALL SELECT "companyId", month FROM "AttendanceMonthClose" UNION ALL SELECT "companyId", "periodStart" AS date FROM "PayPeriod") r WHERE to_char(date, 'YYYY-MM') = $1`, [month])
    if (taken === 0) return month
    day = plusDays(`${month}-01`, -1)
  }
}

const local = (hhmm: string, date = D): Date => {
  const [hour, minute] = hhmm.split(':').map(Number)
  return localInstant(date, hour! * 60 + minute!, ROME)
}

async function restOthers(date: string, working: readonly string[]): Promise<void> {
  const everyone = (await w.admin<{ id: string }>(`SELECT id FROM "Employee" WHERE "tenantId" = $1 AND "siteId" = $2`, [w.T.tenant, w.T.siteA1])).map((row) => row.id)
  for (const id of everyone) {
    if (!working.includes(id)) await w.roster(id, date, null)
    await w.roster(id, plusDays(date, 1), null)
  }
}

/** The gate (the shared world's gate starts 30 days before its own day: this month may be older). */
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

async function approve(employeeId: string): Promise<void> {
  const day = await w.day(employeeId, D)
  await w.ok('hr', 'POST', `/people/attendance/days/${day.id}/approve`, { version: day.version })
}

/** A LOCKED pay period of the month holding one typed adjustment of P1 (a statement approved, as the database asks). */
async function payPeriodWithEarnings(status: 'REVIEW' | 'LOCKED'): Promise<string> {
  const { T, P } = w
  const worker = newId()
  await w.admin(`UPDATE "Worker" SET "employeeId" = $1 WHERE id = $2`, [P.P1, T.worker])
  const periodId = newId()
  await w.admin(`INSERT INTO "PayPeriod" (id, "tenantId", "companyId", "periodStart", "periodEnd", status, "updatedAt") VALUES ($1, $2, $3, $4::date, $5::date, 'OPEN', now())`, [periodId, T.tenant, T.companyA, `${M}-01`, plusDays(`${plusDays(`${M}-28`, 7).slice(0, 7)}-01`, -1)])
  await w.admin(
    `INSERT INTO "EarningsEntry" (id, "tenantId", "companyId", "siteId", "payPeriodId", "employeeId", "workerId", "workDate", kind, amount, currency, reason, "idempotencyKey")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, 'ADJUSTMENT', 12345, 'EUR', 'Made-up adjustment', $9)`,
    [newId(), T.tenant, T.companyA, T.siteA1, periodId, P.P1, T.worker, D, `adjust:${worker}`],
  )
  const statement = newId()
  await w.admin(`INSERT INTO "WorkerStatement" (id, "tenantId", "companyId", "siteId", "payPeriodId", "employeeId", revision, status, summary, "earningsAmount", "makeUpAmount", currency, "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, 1, 'DRAFT', '{}'::jsonb, 12345, 0, 'EUR', now())`, [statement, T.tenant, T.companyA, T.siteA1, periodId, P.P1])
  const stamp = local('09:00', plusDays(D, 25))
  await w.admin(`UPDATE "PayPeriod" SET status = 'PREVIEW', "previewedAt" = $2, "previewedById" = $3 WHERE id = $1`, [periodId, stamp, T.actor])
  await w.admin(`UPDATE "PayPeriod" SET status = 'REVIEW', "reviewStartedAt" = $2, "reviewStartedById" = $3 WHERE id = $1`, [periodId, stamp, T.actor])
  await w.admin(`UPDATE "WorkerStatement" SET status = 'APPROVED', "approvedAt" = $2, "approvedById" = $3 WHERE id = $1`, [statement, stamp, T.actor])
  if (status === 'LOCKED') await lockPeriod(periodId)
  return periodId
}

const lockPeriod = (periodId: string) => w.admin(`UPDATE "PayPeriod" SET status = 'LOCKED', "lockedAt" = $2, "lockedById" = $3 WHERE id = $1`, [periodId, local('10:00', plusDays(D, 25)), w.T.actor])

async function codesFor(value: string): Promise<void> {
  const { codes } = await w.ok('payroll', 'GET', `/people/payroll/codes?companyId=${w.T.companyA}`)
  for (const code of codes.filter((row: Json) => row.inUse && row.providerCode === null)) {
    await w.ok('payroll', 'PUT', '/people/payroll/codes', { companyId: w.T.companyA, kind: code.kind, ourCode: code.ourCode, providerCode: `${value}${code.ourCode}`.slice(0, 6), ...(code.version ? { version: code.version } : {}) })
  }
}

beforeAll(async () => {
  w = await openWorld('w2b54_payroll', NS, (T) => ({
    payroll: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant([...HR, ...PAYROLL, ...ATTENDANCE_CLOSE, 'money.pay'])] },
    // The right, without the pay grain (the administrator's template).
    noGrain: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant([...PAYROLL])] },
    // The view alone (read-only).
    reader: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['people.payroll.view'])] },
    filesOnly: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['files.read', 'files.manage', 'people.payroll.view'])] },
    oneSite: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [{ permissions: [...PAYROLL], companies: [T.companyA], sites: [T.siteA1], parties: 'all' }] },
  }))
  await seedEmail({ db: w.database, namespace: NS })
  redis = testRedis()
  connection = redis.connect()
  filesRoot = mkdtempSync(join(tmpdir(), 'factory-payroll-files-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  const files = createFilesRuntime({ gateway, local: localFileStore({ root: filesRoot, environment: 'test' }) })
  useFiles(files)
  const neverSes = sesMailAdapter({ clientFor: () => { throw new Error('This test never calls SES; its accounts are FAKE.') } })
  useEmail(createEmailRuntime({ gateway, fake: ses, webOrigin: WEB_ORIGIN, ses: neverSes, files: files.storage }))
  await w.admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider IN ('R2', 'SES')`, [w.T.tenant])
  const year = businessDate(new Date(), ROME).slice(0, 4)
  await w.admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'PAYROLL_EXPORT', 'MAIN', $4, 'YEARLY', 'PAY-{YYYY}-{N:4}', false) ON CONFLICT DO NOTHING`, [newId(), w.T.tenant, w.T.companyA, year])
  const clock = { now: () => new Date() }
  const limits = { max: 10_000, timeWindowMs: 60_000 }
  const auth = createOfficeAuth({ database: w.database, environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET, pinPepper: LOCAL_PIN_PEPPER, webOrigin: WEB_ORIGIN, clock, mailer: { deliver: async () => {} }, rateLimits: { signIn: limits, resetRequest: limits, tokenUse: limits, codes: limits, linkUse: limits, floorSignIn: limits } })
  const links = linkAuthenticator({ database: w.database, clock })
  linkApp = await buildApp({ environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET, webOrigin: WEB_ORIGIN, rateLimit: limits }, { database: w.database, officeAuth: auth, clock, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => (carriesLink(request) ? links(request) : (w.sessions[String(request.headers['x-test-session'])] ?? null))), logger: false })

  M = await freeMonth()
  D = `${M}-10`
  const { P, roster, clock: clockIn } = w
  await restOthers(D, Object.values(P))
  // P1 and P4: a clean day. P2: two hours over. P3: planned, on holiday.
  for (const person of [P.P1!, P.P2!, P.P4!]) await roster(person, D, [360, 840])
  await roster(P.P3!, D, [360, 840])
  await clockIn(P.P1!, 'IN', local('06:00'))
  await clockIn(P.P1!, 'OUT', local('14:00'))
  await clockIn(P.P2!, 'IN', local('06:00'))
  await clockIn(P.P2!, 'OUT', local('16:00'))
  await clockIn(P.P4!, 'IN', local('06:00'))
  await clockIn(P.P4!, 'OUT', local('14:00'))
}, 600_000)

afterAll(async () => {
  useFiles(undefined)
  useEmail(undefined)
  await linkApp?.close()
  await w?.close()
  await connection?.quit()
  await redis?.cleanup()
  if (filesRoot) rmSync(filesRoot, { recursive: true, force: true })
}, 60_000)

describe('the legal gate (Statuto dei Lavoratori art. 4 c.2)', () => {
  it('reads nothing while ATTENDANCE is off', async () => {
    expect(pathsOf(await w.no('payroll', 'GET', monthUrl(), undefined, 409))).toContain('gate/ATTENDANCE')
    expect(pathsOf(await w.no('payroll', 'POST', '/people/payroll/preview', { companyId: w.T.companyA, month: M }, 409))).toContain('gate/ATTENDANCE')
    await w.no('oneSite', 'GET', `/people/payroll/codes?companyId=${w.T.companyB}`, undefined, 404)
  })
})

describe('the month before it is closed', () => {
  beforeAll(async () => {
    await openGate()
    await w.pass(D)
    await w.compute(w.P.P2!, D)
  })

  it('holds the export in words, and shows no figure to the view', async () => {
    const month = await w.ok('reader', 'GET', monthUrl())
    expect(month).toMatchObject({ state: 'NOT_EXPORTED', close: { state: 'OPEN', closeId: null }, latest: null, correction: null, actions: { export: { allowed: false }, preview: { allowed: false } } })
    expect(checkOf(month, 'MONTH_CLOSED')).toMatchObject({ blocking: true, passed: false, count: 1, place: 'ATTENDANCE' })
    expect(checkOf(month, 'DAYS_APPROVED').passed).toBe(false)
    expect(month.words).toContain('not exported')
    expect(month.toConfirm.join(' ')).toContain('sample')
    const keys = keysOf(month)
    for (const name of ['cells', 'employeeId', 'employeeCode', 'firstName', 'amount', 'quantity', 'minutes']) expect(keys).not.toContain(name)
  })

  it('opens the values only with the right', async () => {
    await w.no('reader', 'POST', '/people/payroll/preview', { companyId: w.T.companyA, month: M }, 403)
    await w.no('reader', 'POST', '/people/payroll/month/show', { companyId: w.T.companyA, month: M, code: 'EMPLOYEE_CODES' }, 403)
    await w.no('nobody', 'GET', monthUrl(), undefined, 403)
    await w.no('companyB', 'GET', monthUrl(), undefined, 403)
  })

  it('refuses an export with its checks in words, and writes nothing', async () => {
    const { layouts } = await w.ok('payroll', 'GET', `/people/payroll/layouts?companyId=${w.T.companyA}`)
    expect(layouts).toEqual([])
    const made = await w.ok('payroll', 'POST', '/people/payroll/layouts', { companyId: w.T.companyA, starter: 'GENERIC_CSV' }, 201)
    const error = await w.no('payroll', 'POST', '/people/payroll/exports', { companyId: w.T.companyA, month: M, layoutId: made.id }, 409)
    expect(pathsOf(error)).toEqual(expect.arrayContaining(['refusal/CHECKS_OPEN', 'check/MONTH_CLOSED', 'check/DAYS_APPROVED']))
    expect(error.message).toContain('is not closed')
    expect(await count(`FROM "PayrollExport" WHERE "tenantId" = $1`, [w.T.tenant])).toBe(0)
  })
})

describe('the code mapping (MES-271)', () => {
  it('lists our codes, unmapped first, and maps one with autosave', async () => {
    const { codes, unmapped } = await w.ok('reader', 'GET', `/people/payroll/codes?companyId=${w.T.companyA}`)
    expect(unmapped).toBe(codes.length)
    expect(codes.map((row: Json) => row.ourCode)).toEqual(expect.arrayContaining(['ORD', 'OT_DAY', 'NIGHT', 'PIECE', 'MAKE_UP', 'FER']))
    const made = await w.ok('payroll', 'PUT', '/people/payroll/codes', { companyId: w.T.companyA, kind: 'HOUR', ourCode: 'ORD', providerCode: 'ZZ01' })
    expect(made).toMatchObject({ ourCode: 'ORD', providerCode: 'ZZ01', version: 1, inUse: true })
    const after = await w.ok('reader', 'GET', `/people/payroll/codes?companyId=${w.T.companyA}`)
    expect(after.unmapped).toBe(unmapped - 1)
    expect(after.codes.at(-1)).toMatchObject({ providerCode: 'ZZ01' })
    const moved = await w.ok('payroll', 'PUT', '/people/payroll/codes', { companyId: w.T.companyA, kind: 'HOUR', ourCode: 'ORD', providerCode: 'ZZ02', version: 1 })
    expect(moved).toMatchObject({ providerCode: 'ZZ02', version: 2 })
    const audit = await w.admin(`SELECT before, after FROM "AuditLog" WHERE "recordType" = 'PayrollCodeMapping' AND "recordId" = $1 ORDER BY at DESC LIMIT 1`, [moved.id])
    expect(audit[0]).toMatchObject({ before: { providerCode: 'ZZ01' }, after: { providerCode: 'ZZ02' } })
  })

  it('refuses a stale version, a code of no kind of ours, and a caller without the right', async () => {
    await w.no('payroll', 'PUT', '/people/payroll/codes', { companyId: w.T.companyA, kind: 'HOUR', ourCode: 'ORD', providerCode: 'ZZ03', version: 1 }, 409)
    await w.no('payroll', 'PUT', '/people/payroll/codes', { companyId: w.T.companyA, kind: 'HOUR', ourCode: 'ORD', providerCode: 'ZZ03' }, 400)
    expect(pathsOf(await w.no('payroll', 'PUT', '/people/payroll/codes', { companyId: w.T.companyA, kind: 'EARNING', ourCode: 'MADE-UP', providerCode: 'X' }, 409))).toContain('refusal/NOT_OUR_CODE')
    await w.no('reader', 'PUT', '/people/payroll/codes', { companyId: w.T.companyA, kind: 'HOUR', ourCode: 'ORD', providerCode: 'X' }, 403)
  })
})

describe('the layouts (MES-268, MES-270)', () => {
  it('starts a Zucchetti layout as data, not confirmed in words, until a person records who confirmed it', async () => {
    const made = await w.ok('payroll', 'POST', '/people/payroll/layouts', { companyId: w.T.companyA, starter: 'ZUCCHETTI' }, 201)
    expect(made).toMatchObject({ name: 'Zucchetti import', format: 'FIXED_WIDTH', provider: 'Zucchetti', confirmed: false, status: 'ACTIVE' })
    expect(made.words).toContain('Not confirmed by the labour consultant')
    expect(made.note).toContain('made-up')
    const edited = await w.ok('payroll', 'PATCH', `/people/payroll/layouts/${made.id}`, { version: made.version, definition: { ...made.definition, companyCode: '000777' } })
    expect(edited.definition.companyCode).toBe('000777')
    const confirmed = await w.ok('payroll', 'PATCH', `/people/payroll/layouts/${made.id}`, { version: edited.version, confirmation: { on: D, by: 'Made-up consultant' } })
    expect(confirmed).toMatchObject({ confirmed: true, words: `Confirmed by Made-up consultant on ${D}.` })
    const renamed = await w.ok('payroll', 'PATCH', `/people/payroll/layouts/${made.id}`, { version: confirmed.version, note: 'Made-up note' })
    expect(renamed.confirmed).toBe(true)
    // A new record is a new layout: its confirmation does not carry over.
    const replaced = await w.ok('payroll', 'PATCH', `/people/payroll/layouts/${made.id}`, { version: renamed.version, definition: { columns: renamed.definition.columns.slice(0, 2), headerRow: false } })
    expect(replaced.confirmed).toBe(false)
    const archived = await w.ok('payroll', 'POST', `/people/payroll/layouts/${made.id}/archive`, { version: replaced.version })
    expect(archived.status).toBe('ARCHIVED')
    expect(pathsOf(await w.no('payroll', 'POST', `/people/payroll/layouts/${made.id}/archive`, { version: archived.version }, 409))).toContain('refusal/LAYOUT_ARCHIVED')
  })

  it('refuses a layout that could not be written, a taken name, and a stale edit', async () => {
    const company = { companyId: w.T.companyA }
    expect(pathsOf(await w.no('payroll', 'POST', '/people/payroll/layouts', { ...company, name: 'Made-up', format: 'FIXED_WIDTH', definition: { columns: [{ key: 'code' }] } }, 400))).toContain('body/definition/columns/0/width')
    await w.no('payroll', 'POST', '/people/payroll/layouts', company, 400)
    expect(pathsOf(await w.no('payroll', 'POST', '/people/payroll/layouts', { ...company, starter: 'GENERIC_CSV' }, 409))).toContain('refusal/NAME_TAKEN')
    await w.no('reader', 'POST', '/people/payroll/layouts', { ...company, starter: 'GENERIC_EXCEL' }, 403)
    const { layouts } = await w.ok('reader', 'GET', `/people/payroll/layouts?companyId=${w.T.companyA}`)
    const csv = layouts.find((row: Json) => row.name === 'Generic CSV')
    await w.no('payroll', 'PATCH', `/people/payroll/layouts/${csv.id}`, { version: csv.version + 5, name: 'Other' }, 409)
  })
})

describe('the month closed', () => {
  let layoutId: string

  beforeAll(async () => {
    const { P, T } = w
    const { layouts } = await w.ok('reader', 'GET', `/people/payroll/layouts?companyId=${T.companyA}`)
    layoutId = layouts.find((row: Json) => row.name === 'Generic CSV').id
    const fer = (await w.admin<{ id: string }>(`SELECT id FROM "AbsenceCode" WHERE "tenantId" = $1 AND code = 'FER'`, [T.tenant]))[0]!.id
    const absent = await w.day(P.P3!, D)
    await w.ok('hr', 'POST', `/people/attendance/days/${absent.id}/absence`, { version: absent.version, codeId: fer })
    for (const person of [P.P1!, P.P2!, P.P3!, P.P4!]) await approve(person)
    const entry = (await w.entries(P.P2!, D)).DAY!
    await w.ok('hr', 'POST', `/people/overtime/entries/${entry.id}/approve`, { version: entry.version })
    await w.ok('payroll', 'POST', '/people/month-close', { companyId: T.companyA, month: M, phrase: closePhrases(M).en })
    // P4 is external: the file leaves them out.
    await w.admin(`UPDATE "Employee" SET kind = 'EXTERNAL', "employeeCode" = 'M004' WHERE id = $1`, [P.P4])
  })

  it('blocks on people with no code, lists them only with the right and records it', async () => {
    const month = await w.ok('reader', 'GET', monthUrl(`&layoutId=${layoutId}`))
    expect(month.close.state).toBe('CLOSED')
    expect(checkOf(month, 'MONTH_CLOSED').passed).toBe(true)
    expect(checkOf(month, 'EMPLOYEE_CODES')).toMatchObject({ blocking: true, passed: false, count: 3, words: '3 people have no employee code.' })
    expect(checkOf(month, 'AGENCY_LEFT_OUT')).toMatchObject({ blocking: false, passed: false, count: 1 })
    expect(month.people).toBe(3)
    const shown = await w.ok('noGrain', 'POST', '/people/payroll/month/show', { companyId: w.T.companyA, month: M, code: 'EMPLOYEE_CODES' })
    expect(shown).toMatchObject({ code: 'EMPLOYEE_CODES', place: 'EMPLOYEES' })
    expect(shown.people.map((row: Json) => row.name).sort()).toEqual(['Alba Uno (made up)', 'Bruno Due (made up)', 'Carla Tre (made up)'])
    expect(await count(`FROM "AuditLog" WHERE action = 'people.openPayrollCheck' AND "recordId" = $1`, [w.T.companyA])).toBe(1)
    const refused = await w.no('payroll', 'POST', '/people/payroll/exports', { companyId: w.T.companyA, month: M, layoutId }, 409)
    expect(pathsOf(refused)).toEqual(expect.arrayContaining(['refusal/CHECKS_OPEN', 'check/EMPLOYEE_CODES']))
  })

  it('blocks on codes nobody mapped, when the layout prints the provider code, and a layout of our codes may go', async () => {
    const { P } = w
    await w.admin(`UPDATE "Employee" SET "employeeCode" = CASE id WHEN $1::uuid THEN 'M001' WHEN $2::uuid THEN 'M002' ELSE 'M003' END WHERE id = ANY($3::uuid[])`, [P.P1, P.P2, [P.P1, P.P2, P.P3]])
    const month = await w.ok('reader', 'GET', monthUrl(`&layoutId=${layoutId}`))
    expect(checkOf(month, 'EMPLOYEE_CODES').passed).toBe(true)
    expect(checkOf(month, 'CODES_MAPPED')).toMatchObject({ blocking: true, passed: false })
    const shown = await w.ok('payroll', 'POST', '/people/payroll/month/show', { companyId: w.T.companyA, month: M, code: 'CODES_MAPPED' })
    expect(shown.codes.map((row: Json) => row.ourCode)).toEqual(expect.arrayContaining(['OT_DAY', 'FER']))
    expect(shown.people).toEqual([])
    const ours = await w.ok('payroll', 'POST', '/people/payroll/layouts', { companyId: w.T.companyA, name: 'Our codes', format: 'DELIMITED', definition: { columns: [{ key: 'employeeCode', header: 'Mat' }, { key: 'ourCode', header: 'Cod' }, { key: 'quantity', header: 'Ore' }] } }, 201)
    const check = checkOf(await w.ok('reader', 'GET', monthUrl(`&layoutId=${ours.id}`)), 'CODES_MAPPED')
    expect(check).toMatchObject({ blocking: false, passed: false })
    await codesFor('V')
    expect(checkOf(await w.ok('reader', 'GET', monthUrl(`&layoutId=${layoutId}`)), 'CODES_MAPPED').passed).toBe(true)
  })

  it('stops a value too long for a fixed-width column', async () => {
    const narrow = await w.ok('payroll', 'POST', '/people/payroll/layouts', { companyId: w.T.companyA, name: 'Narrow', format: 'FIXED_WIDTH', definition: { columns: [{ key: 'employeeCode', width: 2 }, { key: 'code', width: 6 }] } }, 201)
    const check = checkOf(await w.ok('reader', 'GET', monthUrl(`&layoutId=${narrow.id}`)), 'LAYOUT_FITS')
    expect(check).toMatchObject({ blocking: true, passed: false })
    expect(check.count).toBeGreaterThan(0)
  })

  it('refuses an export while the pay period is not locked', async () => {
    const period = await payPeriodWithEarnings('REVIEW')
    const month = await w.ok('reader', 'GET', monthUrl(`&layoutId=${layoutId}`))
    expect(month).toMatchObject({ piecePayOn: true, payPeriodId: period, carriesPay: true })
    expect(checkOf(month, 'PAY_PERIOD_LOCKED')).toMatchObject({ blocking: true, passed: false })
    expect(pathsOf(await w.no('payroll', 'POST', '/people/payroll/exports', { companyId: w.T.companyA, month: M, layoutId }, 409))).toContain('check/PAY_PERIOD_LOCKED')
    await lockPeriod(period)
    expect(checkOf(await w.ok('reader', 'GET', monthUrl(`&layoutId=${layoutId}`)), 'PAY_PERIOD_LOCKED').passed).toBe(true)
  })

  it('previews by employee code: hours for the right, amounts only with the pay grain, recorded', async () => {
    const hours = await w.ok('noGrain', 'POST', '/people/payroll/preview', { companyId: w.T.companyA, month: M })
    expect(hours.people.map((row: Json) => row.employeeCode)).toEqual(['M001', 'M002', 'M003'])
    expect(keysOf(hours)).not.toContain('amount')
    expect(keysOf(hours)).not.toContain('firstName')
    expect(hours.payShown).toBe(false)
    const pay = await w.ok('payroll', 'POST', '/people/payroll/preview', { companyId: w.T.companyA, month: M })
    const first = pay.people[0].cells
    expect(first.find((cell: Json) => cell.code === 'ORD')).toMatchObject({ kind: 'HOUR', unit: 'HOURS' })
    expect(first.find((cell: Json) => cell.code === 'ADJUSTMENT')).toMatchObject({ kind: 'EARNING', amount: 12345, currency: 'EUR' })
    expect(pay.people[1].cells.find((cell: Json) => cell.code === 'OT_DAY')).toMatchObject({ minutes: 120, quantity: '2.00' })
    expect(pay.people[2].cells.find((cell: Json) => cell.code === 'FER')).toMatchObject({ kind: 'ABSENCE' })
    expect(pay.sums.find((sum: Json) => sum.code === 'ADJUSTMENT')).toMatchObject({ amount: 12345, people: 1 })
    expect(pay.changes).toBeNull()
    expect(await count(`FROM "AuditLog" WHERE action = 'people.openPayrollPreview' AND "recordId" = $1`, [w.T.companyA])).toBe(2)
    const receipt = await w.admin(`SELECT response FROM "IdempotencyReceipt" WHERE "tenantId" = $1 AND scope = 'people.openPayrollPreview'`, [w.T.tenant])
    expect(receipt.length).toBeGreaterThan(0)
    expect(JSON.stringify(receipt)).not.toContain('M001')
  })

  it('asks the pay grain to make a file that carries amounts', async () => {
    const error = await w.no('noGrain', 'POST', '/people/payroll/exports', { companyId: w.T.companyA, month: M, layoutId }, 403)
    expect(error.message).toContain('pay grain')
  })
})

describe('the export (MES-267)', () => {
  let exportId: string
  let layoutId: string
  let dataFile: Json
  let token: string
  let linkId: string
  let latestId: string
  // B-W2b-163: a file with amounts never goes by link (Owner, 11-02): the link part runs on a month of hours only.
  let sentId: string
  let sentData: Json
  const exportKey = `export-${run}`
  const makeWithKey = (payload: Json) => w.app.inject({ method: 'POST', url: '/people/payroll/exports', headers: { 'x-test-session': 'payroll', 'idempotency-key': exportKey }, payload })

  it('makes the file: numbered, its files stored, its seal, its checks, and no figure in the record', async () => {
    const { layouts } = await w.ok('reader', 'GET', `/people/payroll/layouts?companyId=${w.T.companyA}`)
    layoutId = layouts.find((row: Json) => row.name === 'Generic CSV').id
    const first = await makeWithKey({ companyId: w.T.companyA, month: M, layoutId, note: 'Made-up note' })
    expect(first.statusCode, first.body).toBe(201)
    const made = first.json()
    exportId = made.id
    expect(made).toMatchObject({ status: 'EXPORTED', revision: 1, correctionOfId: null, carriesPay: true, sentTo: [], downloadedAt: null, changed: null, note: 'Made-up note', layout: { name: 'Generic CSV', format: 'DELIMITED', confirmed: true } })
    expect(made.number).toMatch(/^PAY-\d{4}-\d{4}$/)
    expect(made.seal).toMatch(/^[0-9a-f]{64}$/)
    expect(made.files.map((file: Json) => [file.seq, file.kind, file.format])).toEqual([[1, 'DATA', 'CSV'], [2, 'SUMMARY', 'PDF']])
    dataFile = made.files[0]
    expect(dataFile.sha256).toBe(made.seal)
    expect(dataFile.rowCount).toBeGreaterThan(3)
    expect(made.checks.find((check: Json) => check.code === 'AGENCY_LEFT_OUT')).toMatchObject({ passed: false, count: 1, words: expect.stringContaining('left out') })
    expect(keysOf(made)).not.toContain('values')
    const row = (await w.admin(`SELECT * FROM "PayrollExport" WHERE id = $1`, [exportId]))[0]!
    expect(row).toMatchObject({ status: 'EXPORTED', exportedById: actorOfPayroll() })
    expect(row.payPeriodId).not.toBeNull()
    expect(JSON.stringify(row.layoutSnapshot)).toContain('Matricola')
    expect(row.values.every((value: Json) => !('employeeId' in value) && !('name' in value))).toBe(true)
    const events = await w.admin(`SELECT type, payload FROM "OutboxEvent" WHERE type = 'payroll_export.exported' AND payload->>'exportId' = $1`, [exportId])
    expect(events).toHaveLength(1)
    expect(events[0]!.payload).toMatchObject({ month: M, revision: 1, people: 3 })
    expect(keysOf(events[0]!.payload)).not.toContain('employeeCode')
  })

  it('writes the file by employee code, in the layout, and the bytes hash to the seal', async () => {
    const opened = await w.ok('payroll', 'POST', `/people/payroll/exports/${exportId}/files/${dataFile.id}/open`, {})
    expect(opened).toMatchObject({ fileId: dataFile.id, sha256: dataFile.sha256 })
    const text = (await readStored(dataFile.id)).toString('utf8')
    expect(text.split('\r\n')[0]).toBe('﻿Matricola;Voce;Quantita;Importo')
    expect(text).toContain('M001;')
    expect(text).toContain(';123,45')
    expect(text).not.toContain('Alba')
    expect(text).not.toContain('M004')
    expect(await count(`FROM "AuditLog" WHERE action = 'people.openPayrollFile' AND "recordId" = $1`, [exportId])).toBe(1)
    const { files } = await w.ok('reader', 'GET', `/people/payroll/exports/${exportId}`)
    const summary = pdfFlatText(await readStored(files[1].id))
    expect(summary).toContain('Riepilogo paghe')
    expect(summary).toContain('Matricola M001')
    expect(summary).toContain('123,45 EUR')
    expect(summary).toContain('Persone di agenzia o esterne non comprese: 1')
    expect(summary).not.toContain('Alba')
  })

  it('hides the file from the generic routes and from anyone without the right or the grain', async () => {
    const data = dataFile.id
    await w.no('filesOnly', 'GET', `/files/${data}`, undefined, 404)
    await w.no('filesOnly', 'GET', `/files/${data}/download`, undefined, 404)
    const list = await w.ok('filesOnly', 'GET', `/files?recordType=PayrollExport&recordId=${exportId}`)
    expect(list.files).toEqual([])
    await w.no('reader', 'POST', `/people/payroll/exports/${exportId}/files/${data}/open`, {}, 403)
    expect((await w.no('noGrain', 'POST', `/people/payroll/exports/${exportId}/files/${data}/open`, {}, 403)).message).toContain('pay grain')
    await w.no('reader', 'POST', `/people/payroll/exports/${exportId}/values`, {}, 403)
  })

  it('shows what it sent per employee code, to the right alone, recorded; amounts with the grain', async () => {
    const values = await w.ok('noGrain', 'POST', `/people/payroll/exports/${exportId}/values`, {})
    expect(values.people.map((row: Json) => row.employeeCode)).toEqual(['M001', 'M002', 'M003'])
    expect(keysOf(values)).not.toContain('amount')
    const full = await w.ok('payroll', 'POST', `/people/payroll/exports/${exportId}/values`, {})
    expect(full.people[0].cells.find((cell: Json) => cell.code === 'ADJUSTMENT').amount).toBe(12345)
    expect(await count(`FROM "AuditLog" WHERE action = 'people.openPayrollValues' AND "recordId" = $1`, [exportId])).toBe(2)
  })

  it('lists exports with no figure, and the view reads the month as exported', async () => {
    const { rows } = await w.ok('reader', 'GET', `/people/payroll/exports?companyId=${w.T.companyA}`)
    expect(rows.map((row: Json) => row.id)).toEqual([exportId])
    expect(rows[0]).toMatchObject({ month: M, revision: 1, madeBy: { id: actorOfPayroll() } })
    const keys = keysOf(rows)
    for (const name of ['cells', 'employeeCode', 'amount', 'quantity']) expect(keys).not.toContain(name)
    const month = await w.ok('reader', 'GET', monthUrl())
    expect(month).toMatchObject({ state: 'EXPORTED', correction: { people: 0, values: 0, corrections: 0 }, latest: { id: exportId }, actions: { correct: { allowed: false } } })
    expect(month.words).toContain('v1')
  })

  it('refuses a second first export, and cancels nothing exported', async () => {
    expect(pathsOf(await w.no('payroll', 'POST', '/people/payroll/exports', { companyId: w.T.companyA, month: M, layoutId }, 409))).toContain('refusal/ALREADY_EXPORTED')
    const { version } = await w.ok('reader', 'GET', `/people/payroll/exports/${exportId}`)
    expect(pathsOf(await w.no('payroll', 'POST', `/people/payroll/exports/${exportId}/cancel`, { version, reason: 'Made-up reason' }, 409))).toContain('refusal/NOT_DRAFT')
  })

  it('answers a repeat of the same request from the same export', async () => {
    const again = await makeWithKey({ companyId: w.T.companyA, month: M, layoutId, note: 'Made-up note' })
    expect(again.statusCode, again.body).toBe(201)
    expect(again.json().id).toBe(exportId)
    expect(await count(`FROM "PayrollExport" WHERE "tenantId" = $1 AND "periodStart" = $2::date`, [w.T.tenant, `${M}-01`])).toBe(1)
    expect(await count(`FROM "NumberAllocation" WHERE "recordType" = 'PayrollExport' AND "recordId" = $1`, [exportId])).toBe(1)
  })

  it('refuses to send a file with amounts: pay figures never go by link (Owner, 11-02; B-W2b-163), and writes nothing', async () => {
    const refused = await w.no('payroll', 'POST', `/people/payroll/exports/${exportId}/send`, { email: CONSULTANT }, 409)
    expect(pathsOf(refused)).toContain('refusal/PAY_FIGURES')
    expect(refused.message).toContain('pay figures never go by link')
    expect(await count(`FROM "OneOffLink" WHERE "recordId" = $1`, [exportId])).toBe(0)
    expect(mailsTo(CONSULTANT)).toHaveLength(0)
  })

  it('sends a file of hours only by a secure link: no attachment, no token in any answer or row, a mail on the FAKE provider', async () => {
    ;({ id: sentId, data: sentData, month: hoursMonth } = await hoursOnlyExport(layoutId))
    await w.no('reader', 'POST', `/people/payroll/exports/${sentId}/send`, { email: CONSULTANT }, 403)
    const answer = await sendAs(sentId)
    expect(answer).toMatchObject({ link: { email: CONSULTANT, maxUses: 10 }, withdrawn: [], delivery: 'SENT' })
    linkId = answer.link.id
    const mail = mailsTo(CONSULTANT).at(-1)!
    expect(mail.raw).not.toContain('Content-Disposition: attachment')
    token = tokenOf(mail)
    expect(textOf(mail.raw)).toContain('Ogni scaricamento viene registrato')
    expect(textOf(mail.raw)).not.toContain('123,45')
    const text = JSON.stringify(answer) + JSON.stringify(await w.admin(`SELECT * FROM "OneOffLink" WHERE id = $1`, [linkId])) + JSON.stringify(await w.admin(`SELECT after FROM "AuditLog" WHERE "recordId" IN ($1, $2)`, [linkId, sentId])) + JSON.stringify(await w.admin(`SELECT payload FROM "OutboxEvent" WHERE type LIKE 'payroll_export.%'`)) + JSON.stringify(await w.admin(`SELECT * FROM "EmailOutbound" WHERE "recordType" = 'PayrollExport'`))
    expect(text).not.toContain(token)
    const link = (await w.admin(`SELECT * FROM "OneOffLink" WHERE id = $1`, [linkId]))[0]!
    expect(link).toMatchObject({ purpose: 'DOCUMENT_VIEW', recordType: 'PayrollExport', recordId: sentId, partyId: sentId, email: CONSULTANT, maxUses: 10 })
    const days = Math.round((new Date(link.expiresAt).getTime() - Date.now()) / 86_400_000)
    expect(days).toBe(7)
    const record = await w.ok('reader', 'GET', `/people/payroll/exports/${sentId}`)
    expect(record.sentTo).toEqual([CONSULTANT])
    expect(record.links[0]).toMatchObject({ id: linkId, state: 'LIVE', uses: 0, downloads: [] })
  })

  it('refuses terms past its limits and an address that bounced', async () => {
    await w.no('payroll', 'POST', `/people/payroll/exports/${sentId}/send`, { email: CONSULTANT, expiresInDays: 90 }, 400)
    await w.no('payroll', 'POST', `/people/payroll/exports/${sentId}/send`, { email: CONSULTANT, maxUses: 21 }, 400)
    const { address } = (await w.admin<{ address: string }>(`SELECT address FROM "Suppression" WHERE "tenantId" = $1 AND "liftedAt" IS NULL LIMIT 1`, [w.T.tenant]))[0]!
    expect(pathsOf(await w.no('payroll', 'POST', `/people/payroll/exports/${sentId}/send`, { email: address }, 409))).toContain('refusal/SUPPRESSED')
  })

  it('lets the consultant read the list and download: each download a counted use, logged, on the record', async () => {
    const page = await asLink(token, 'GET', '/people/payroll/link/files')
    expect(page.statusCode, page.body).toBe(200)
    expect(page.json()).toMatchObject({ month: hoursMonth, revision: 1, link: { usesLeft: 10 } })
    expect(page.json().files.map((file: Json) => file.kind)).toEqual(['DATA', 'SUMMARY'])
    const got = await asLink(token, 'POST', `/people/payroll/link/files/${sentData.id}/download`, {})
    expect(got.statusCode, got.body).toBe(200)
    expect(got.json()).toMatchObject({ fileId: sentData.id, usesLeft: 9 })
    expect(got.json().download.url).toBeTruthy()
    const link = (await w.admin(`SELECT uses FROM "OneOffLink" WHERE id = $1`, [linkId]))[0]!
    expect(link.uses).toBe(1)
    expect(await count(`FROM "LinkEvidence" WHERE "linkId" = $1 AND action = 'OPENED' AND "useNumber" = 1`, [linkId])).toBe(1)
    const record = await w.ok('reader', 'GET', `/people/payroll/exports/${sentId}`)
    expect(record.downloadedAt).not.toBeNull()
    expect(record.links[0]).toMatchObject({ uses: 1, downloads: [{ fileId: sentData.id }] })
    expect((await w.admin(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'payroll_export.downloaded' AND payload->>'exportId' = $1`, [sentId]))[0]!.n).toBe(1)
  })

  it('opens nothing else for that link: not another file, not the generic routes, not an office read', async () => {
    const other = newId()
    expect((await asLink(token, 'POST', `/people/payroll/link/files/${other}/download`, {})).statusCode).toBe(404)
    expect((await asLink(token, 'GET', `/files/${sentData.id}`)).statusCode).toBe(404)
    expect((await asLink(token, 'GET', `/people/payroll/exports/${sentId}`)).statusCode).toBe(403)
  })

  it('withdraws a link: it opens nothing from then on, with the one answer of every dead link', async () => {
    const second = await sendAs(sentId, 'other.studio@example.com')
    const mail = mailsTo('other.studio@example.com').at(-1)!
    const secondToken = tokenOf(mail)
    await w.no('reader', 'POST', `/people/payroll/exports/${sentId}/links/${second.link.id}/withdraw`, {}, 403)
    const withdrawn = await w.ok('payroll', 'POST', `/people/payroll/exports/${sentId}/links/${second.link.id}/withdraw`, { reason: 'Sent to the wrong studio' })
    expect(withdrawn).toMatchObject({ id: second.link.id, state: 'REVOKED' })
    const dead = await asLink(secondToken, 'GET', '/people/payroll/link/files')
    expect(dead.statusCode).toBe(404)
    expect(dead.json().error.message).toBe(LINK_UNAVAILABLE)
    expect(pathsOf(await w.no('payroll', 'POST', `/people/payroll/exports/${sentId}/links/${second.link.id}/withdraw`, {}, 409))).toContain('refusal/LINK_NOT_LIVE')
  })

  it('replaces the older live link when it sends to the same address again', async () => {
    const again = await sendAs(sentId)
    expect(again.withdrawn).toEqual([linkId])
    expect((await asLink(token, 'GET', '/people/payroll/link/files')).statusCode).toBe(404)
    linkId = again.link.id
    token = tokenOf(mailsTo(CONSULTANT).at(-1)!)
    expect((await asLink(token, 'GET', '/people/payroll/link/files')).statusCode).toBe(200)
  })

  it('stops the link of a file that a correction replaces', async () => {
    const day = await w.day(w.P.P2!, `${hoursMonth}-10`)
    await w.ok('payroll', 'POST', `/people/attendance/days/${day.id}/corrections`, { kind: 'ORDINARY', minutesBefore: day.ordinaryMinutes, minutesAfter: day.ordinaryMinutes - 15, reason: 'Made-up correction of the hours month' }, 201)
    const v2 = await w.ok('payroll', 'POST', '/people/payroll/exports', { companyId: w.T.companyA, month: hoursMonth, correctionOfId: sentId }, 201)
    expect(v2).toMatchObject({ revision: 2, correctionOfId: sentId, carriesPay: false })
    expect((await asLink(token, 'GET', '/people/payroll/link/files')).statusCode).toBe(404)
    expect((await w.ok('reader', 'GET', `/people/payroll/exports/${sentId}`)).links.every((link: Json) => link.state !== 'LIVE')).toBe(true)
    sentId = v2.id
  })

  describe('a closed day corrected afterwards (MES-273)', () => {
    let correctionId: string

    it('says the month has a correction pending, here and on the close panel', async () => {
      const { P, T } = w
      const day = await w.day(P.P1!, D)
      const before = day.ordinaryMinutes as number
      await w.ok('payroll', 'POST', `/people/attendance/days/${day.id}/corrections`, { kind: 'ORDINARY', minutesBefore: before, minutesAfter: before - 30, reason: 'Made-up late correction' }, 201)
      const month = await w.ok('reader', 'GET', monthUrl())
      expect(month).toMatchObject({ state: 'CORRECTION_PENDING', correction: { people: 1, values: 1, corrections: 1 } })
      expect(month.words).toContain('correction pending: 1 person, 1 value')
      expect(keysOf(month.correction)).not.toContain('employeeCode')
      const panel = await w.ok('payroll', 'GET', `/people/month-close?companyId=${T.companyA}&month=${M}`)
      expect(panel).toMatchObject({ corrections: 1, payrollCorrectionsPending: 1 })
    })

    it('previews what changed, from → to', async () => {
      const preview = await w.ok('payroll', 'POST', '/people/payroll/preview', { companyId: w.T.companyA, month: M })
      expect(preview.changes).toMatchObject({ people: 1, values: 1 })
      expect(preview.changes.rows[0]).toMatchObject({ employeeCode: 'M001', code: 'ORD', change: 'CHANGED' })
      expect(preview.changes.rows[0].fromQuantity).not.toBe(preview.changes.rows[0].toQuantity)
    })

    it('names the month latest file, and refuses a first export or a stale one', async () => {
      expect(pathsOf(await w.no('payroll', 'POST', '/people/payroll/exports', { companyId: w.T.companyA, month: M, layoutId, correctionOfId: newId() }, 409))).toContain('refusal/NOT_LATEST')
    })

    it('makes v2: the whole month, numbered, naming v1; v1 is kept and its link stops', async () => {
      const v1 = await w.ok('reader', 'GET', `/people/payroll/exports/${exportId}`)
      const made = await w.ok('payroll', 'POST', '/people/payroll/exports', { companyId: w.T.companyA, month: M, correctionOfId: exportId }, 201)
      correctionId = made.id
      expect(made).toMatchObject({ status: 'EXPORTED', revision: 2, correctionOfId: exportId, changed: { people: 1, values: 1 }, layout: { name: 'Generic CSV' } })
      expect(made.number).not.toBe(v1.number)
      expect(made.words).toContain('replaces')
      const kept = await w.ok('reader', 'GET', `/people/payroll/exports/${exportId}`)
      expect(kept).toMatchObject({ status: 'EXPORTED', correctedById: correctionId, seal: v1.seal })
      // It carries amounts: it never went by link (B-W2b-163); the hours month shows a correction stopping a link.
      expect(kept.links).toEqual([])
      const values = await w.ok('payroll', 'POST', `/people/payroll/exports/${correctionId}/values`, {})
      expect(values.changes).toMatchObject({ people: 1, values: 1 })
      expect(values.people).toHaveLength(3)
    })

    it('clears the pending mark, and sends only the latest file', async () => {
      const month = await w.ok('reader', 'GET', monthUrl())
      expect(month).toMatchObject({ state: 'EXPORTED', correction: { people: 0, values: 0, corrections: 0 }, latest: { id: correctionId, revision: 2 } })
      expect((await w.ok('payroll', 'GET', `/people/month-close?companyId=${w.T.companyA}&month=${M}`)).payrollCorrectionsPending).toBe(0)
      expect(pathsOf(await w.no('payroll', 'POST', `/people/payroll/exports/${exportId}/send`, { email: CONSULTANT }, 409))).toContain('refusal/REPLACED')
      expect((await w.ok('reader', 'GET', `/people/payroll/exports/${exportId}`)).actions).toMatchObject({ send: { allowed: false }, correct: { allowed: false } })
    })

    it('leaves nothing pending for a correction the file cannot carry: a person left out of it', async () => {
      const day = await w.day(w.P.P4!, D)
      await w.ok('payroll', 'POST', `/people/attendance/days/${day.id}/corrections`, { kind: 'ORDINARY', minutesBefore: day.ordinaryMinutes, minutesAfter: day.ordinaryMinutes - 5, reason: 'Made-up correction of an external' }, 201)
      const month = await w.ok('reader', 'GET', monthUrl())
      expect(month).toMatchObject({ state: 'EXPORTED', correction: { people: 0, values: 0, corrections: 0 } })
      expect((await w.ok('payroll', 'GET', `/people/month-close?companyId=${w.T.companyA}&month=${M}`)).payrollCorrectionsPending).toBe(0)
    })

    it('refuses a correction with nothing to correct, unless the file changes layout', async () => {
      expect(pathsOf(await w.no('payroll', 'POST', '/people/payroll/exports', { companyId: w.T.companyA, month: M, correctionOfId: correctionId }, 409))).toContain('refusal/NOTHING_CHANGED')
      const { layouts } = await w.ok('reader', 'GET', `/people/payroll/layouts?companyId=${w.T.companyA}`)
      const fixed = await w.ok('payroll', 'POST', '/people/payroll/layouts', { companyId: w.T.companyA, name: 'Zucchetti second', starter: 'ZUCCHETTI' }, 201)
      expect(layouts.length).toBeGreaterThan(0)
      const v3 = await w.ok('payroll', 'POST', '/people/payroll/exports', { companyId: w.T.companyA, month: M, correctionOfId: correctionId, layoutId: fixed.id }, 201)
      expect(v3).toMatchObject({ revision: 3, changed: { people: 0, values: 0 }, layout: { format: 'FIXED_WIDTH', provider: 'Zucchetti', confirmed: false } })
      expect(v3.layout.words).toContain('Not confirmed')
      expect(v3.files[0]).toMatchObject({ kind: 'DATA', format: 'TXT', contentType: 'text/plain' })
      expect(v3.checks.find((check: Json) => check.code === 'LAYOUT_NOT_CONFIRMED')).toMatchObject({ passed: false, blocking: false })
      const stored = (await readStored(v3.files[0].id)).toString('latin1').split('\r\n')
      expect(stored[0]!.length).toBe(43)
      latestId = v3.id
    })

    it('refuses a file whose figures moved while it was being made, and leaves a draft to cancel', async () => {
      const { P } = w
      const dayOfP2 = await w.day(P.P2!, D)
      await w.ok('payroll', 'POST', `/people/attendance/days/${dayOfP2.id}/corrections`, { kind: 'ORDINARY', minutesBefore: dayOfP2.ordinaryMinutes, minutesAfter: dayOfP2.ordinaryMinutes - 10, reason: 'Made-up first correction' }, 201)
      hooks.beforePut = async () => {
        await w.ok('payroll', 'POST', `/people/attendance/days/${dayOfP2.id}/corrections`, { kind: 'NIGHT', minutesBefore: dayOfP2.nightMinutes, minutesAfter: dayOfP2.nightMinutes + 15, reason: 'Made-up correction landing meanwhile' }, 201)
      }
      const error = await w.no('payroll', 'POST', '/people/payroll/exports', { companyId: w.T.companyA, month: M, correctionOfId: latestId }, 409)
      expect(pathsOf(error)).toContain('refusal/CHANGED_WHILE_MAKING')
      const { rows } = await w.ok('reader', 'GET', `/people/payroll/exports?companyId=${w.T.companyA}&year=${M.slice(0, 4)}`)
      const draft = rows.find((row: Json) => row.status === 'DRAFT')
      expect(draft).toMatchObject({ number: null, revision: 4, correctionOfId: latestId })
      const record = await w.ok('reader', 'GET', `/people/payroll/exports/${draft.id}`)
      expect(record.actions).toMatchObject({ send: { allowed: false }, open: { allowed: false } })
      expect((await w.ok('payroll', 'GET', `/people/payroll/exports/${draft.id}`)).actions.cancel.allowed).toBe(true)
      const cancelled = await w.ok('payroll', 'POST', `/people/payroll/exports/${draft.id}/cancel`, { version: draft.version, reason: 'Made-up reason' })
      expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'Made-up reason' })
      expect(pathsOf(await w.no('payroll', 'POST', `/people/payroll/exports/${draft.id}/cancel`, { version: cancelled.version, reason: 'Made-up reason' }, 409))).toContain('refusal/NOT_DRAFT')
    })

    it('writes the file as a workbook when the layout says so, numbers as numbers', async () => {
      const excel = await w.ok('payroll', 'POST', '/people/payroll/layouts', { companyId: w.T.companyA, starter: 'GENERIC_EXCEL' }, 201)
      const v4 = await w.ok('payroll', 'POST', '/people/payroll/exports', { companyId: w.T.companyA, month: M, correctionOfId: latestId, layoutId: excel.id }, 201)
      expect(v4).toMatchObject({ revision: 4, changed: { people: 1 } })
      expect(v4.files[0]).toMatchObject({ kind: 'DATA', format: 'XLSX' })
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load((await readStored(v4.files[0].id)) as unknown as ArrayBuffer)
      const sheet = workbook.worksheets[0]!
      expect(sheet.getRow(1).getCell(1).value).toBe('Matricola')
      expect(sheet.getRow(2).getCell(1).value).toBe('M001')
      expect(typeof sheet.getRow(2).getCell(5).value).toBe('number')
    })
  })
})

describe('a leaver (MES-214)', () => {
  it('flags the person on the file and ticks their payroll step, naming the export', async () => {
    const { P, T } = w
    const month = (await w.admin<{ m: string }>(`SELECT to_char(($1::date - interval '1 month'), 'YYYY-MM') AS m`, [`${M}-01`]))[0]!.m
    const date = `${month}-10`
    await restLeaverMonth(date)
    const caseId = newId()
    await w.admin(`INSERT INTO "LeaverCase" (id, "tenantId", "employeeId", "lastWorkingDay", status, "startedAt", "startedById") VALUES ($1, $2, $3, $4::date, 'OPEN', now(), $5)`, [caseId, T.tenant, P.P2, date, T.actor])
    const stepId = newId()
    await w.admin(`INSERT INTO "LeaverStep" (id, "tenantId", "caseId", kind, seq, automatic) VALUES ($1, $2, $3, 'PAYROLL_FLAGGED', 1, true)`, [stepId, T.tenant, caseId])
    await w.ok('payroll', 'POST', '/people/month-close', { companyId: T.companyA, month, phrase: closePhrases(month).en })
    const { layouts } = await w.ok('reader', 'GET', `/people/payroll/layouts?companyId=${T.companyA}`)
    const layoutId = layouts.find((row: Json) => row.name === 'Generic CSV').id
    const read = await w.ok('reader', 'GET', `/people/payroll/month?companyId=${T.companyA}&month=${month}&layoutId=${layoutId}`)
    expect(checkOf(read, 'LEAVERS')).toMatchObject({ blocking: false, passed: false, count: 1 })
    const made = await w.ok('payroll', 'POST', '/people/payroll/exports', { companyId: T.companyA, month, layoutId }, 201)
    expect(made.status).toBe('EXPORTED')
    const step = (await w.admin(`SELECT status, "recordType", "recordId", "doneById" FROM "LeaverStep" WHERE id = $1`, [stepId]))[0]!
    expect(step).toMatchObject({ status: 'DONE', recordType: 'PayrollExport', recordId: made.id, doneById: null })
  })
})

describe('the legal gate closed afterwards (Statuto dei Lavoratori art. 4 c.2)', () => {
  it('opens no value, no file and no link any more', async () => {
    // The latest file of the hours month (a file with amounts never goes by link: B-W2b-163).
    const { rows } = await w.ok('reader', 'GET', `/people/payroll/exports?companyId=${w.T.companyA}&year=${hoursMonth.slice(0, 4)}`)
    const row = rows.find((entry: Json) => entry.status === 'EXPORTED' && entry.month === hoursMonth && entry.correctedById === null)
    const { files } = await w.ok('reader', 'GET', `/people/payroll/exports/${row.id}`)
    const sent = await sendAs(row.id, 'last.studio@example.com')
    const token = tokenOf(mailsTo('last.studio@example.com').at(-1)!)
    expect(sent.delivery).toBe('SENT')
    expect((await asLink(token, 'GET', '/people/payroll/link/files')).statusCode).toBe(200)
    await w.closeGate()
    expect(pathsOf(await w.no('payroll', 'POST', `/people/payroll/exports/${row.id}/values`, {}, 409))).toContain('gate/ATTENDANCE')
    expect(pathsOf(await w.no('payroll', 'POST', `/people/payroll/exports/${row.id}/files/${files[0].id}/open`, {}, 409))).toContain('gate/ATTENDANCE')
    expect(pathsOf(await w.no('payroll', 'POST', `/people/payroll/exports/${row.id}/send`, { email: CONSULTANT }, 409))).toContain('gate/ATTENDANCE')
    const dead = await asLink(token, 'POST', `/people/payroll/link/files/${files[0].id}/download`, {})
    expect(dead.statusCode).toBe(404)
    expect(dead.json().error.message).toBe(LINK_UNAVAILABLE)
    expect((await w.admin(`SELECT uses FROM "OneOffLink" WHERE id = $1`, [sent.link.id]))[0]!.uses).toBe(0)
  })
})

const readStored = async (fileId: string): Promise<Buffer> => {
  const { storageKey } = (await w.admin<{ storageKey: string }>(`SELECT "storageKey" FROM "StoredFile" WHERE id = $1`, [fileId]))[0]!
  const { readFileSync } = await import('node:fs')
  return readFileSync(join(filesRoot, storageKey))
}

async function sendAs(exportId: string, email = CONSULTANT): Promise<Json> {
  const answer = await linkApp.inject({ method: 'POST', url: `/people/payroll/exports/${exportId}/send`, headers: { 'x-test-session': 'payroll', 'idempotency-key': `send-${run}-${++keys}` }, payload: { email } })
  expect(answer.statusCode, answer.body).toBe(201)
  return answer.json()
}

/**
 * A month of hours only (B-W2b-163: pay figures never go by link, so the link tests send this one): the free month before
 * the leaver's, P2 works one clean day, the month is closed and exported (no pay period: no amount).
 */
async function hoursOnlyExport(layoutId: string): Promise<{ id: string; data: Json; month: string }> {
  const leaverMonth = plusDays(`${M}-01`, -1).slice(0, 7)
  const month = await freeMonth(leaverMonth)
  await restLeaverMonth(`${month}-10`)
  await w.ok('payroll', 'POST', '/people/month-close', { companyId: w.T.companyA, month, phrase: closePhrases(month).en })
  const made = await w.ok('payroll', 'POST', '/people/payroll/exports', { companyId: w.T.companyA, month, layoutId }, 201)
  expect(made.carriesPay).toBe(false)
  return { id: made.id, data: made.files[0], month }
}

/** The leaver's month: P2 works one clean day; nobody else has a day. */
async function restLeaverMonth(date: string): Promise<void> {
  const { P } = w
  await restOthers(date, [P.P2!])
  await w.roster(P.P2!, date, [360, 840])
  await w.clock(P.P2!, 'IN', local('06:00', date))
  await w.clock(P.P2!, 'OUT', local('14:00', date))
  await w.pass(date)
  await w.compute(P.P2!, date)
  const day = await w.day(P.P2!, date)
  await w.ok('hr', 'POST', `/people/attendance/days/${day.id}/approve`, { version: day.version })
}
