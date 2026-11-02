import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { hashPin } from '@nexus/factory-domain/auth/floor/pin'
import { localInstant, plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { monthAfter } from '@nexus/factory-domain/people/earnings/rules'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedAndon } from '../../../../../../packages/factory-db/seed/andon'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPeople, type PeopleSeed } from '../../../../../../packages/factory-db/seed/people'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seed as seedProduction, type ProductionSeed } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { systemContext } from '../../../platform/outbox/system'
import { earnBundleNow, earningsHandlers } from './jobs'

/**
 * Earnings and pay periods (B-W2b-43; MES-256 the earnings ledger, MES-264 scans pay only while clocked in, MES-148 waiting
 * does not cut pay, MES-260 the period run, MES-261 the worker statement, MES-266 labour cost per piece, MES-304 the earnings
 * report; GATE-PIECE-PAY) through the app's real routes and the worker's handler on a throwaway PostgreSQL 17 database from
 * the migrations (the runtime login: row-level security, the grants and the …_pay_w2b_guards triggers are real), on the
 * seeds up to production, people and the help-call types (no pay seed: no switch, no scheme, no rate: this file makes its
 * own, in a month counted from the clock and far before every seeded date, so no seeded scan or attendance day is in it and
 * no date here can pass). Every figure and name is made up; none is any CCNL's. The law the tests name: c.c. art. 2100
 * (waiting is paid), art. 2101 c.3 (the statement of work done and pay), Statuto dei Lavoratori art. 4 (no per-person figure
 * in a list; piece pay rests on the PERFORMANCE gate). Run with `node scripts/factory/run-pg-tests.mjs modules/people/earnings`.
 */

vi.setConfig({ testTimeout: 60_000 })

let h: Harness
let app: FastifyInstance
let production: ProductionSeed
let people: PeopleSeed

const NS = 'w2b43-earnings'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const companyB = idOf('company:B')
const siteA1 = idOf('site:A1')
const lineL1 = idOf('site:A1:line:L1')
const sew1 = idOf('site:A1:station:SEW-01')
const operator = idOf('worker:A1:operator')
const lead = idOf('worker:A1:lead')
const opSew = idOf('product:operation:SEW')
const TENANT: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'A' }, { id: companyB, code: 'B' }] }
const PIN = '573914'

const ROME = 'Europe/Rome'
const today = businessDate(new Date(), ROME)
const MONTH = plusDays(today, -1200).slice(0, 7)
const NEXT = monthAfter(MONTH)
const AFTER = monthAfter(NEXT)
const D = `${MONTH}-10`
const D2 = `${MONTH}-11`
const D3 = `${MONTH}-12`
const local = (hhmm: string, date = D): Date => {
  const [hour, minute] = hhmm.split(':').map(Number)
  return localInstant(date, hour! * 60 + minute!, ROME)
}

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (grants: Grant[], actorId: string = newId()): SessionContext => ({ audience: 'office', tenantId: T, actorId, grants })
const PAY = 'money.pay' as Permission
const COST = 'money.cost' as Permission
const HR: Permission[] = ['people.earnings.view', 'people.earnings.records', 'people.earnings.manage', PAY]
const actors = { self: newId(), hr: newId() }
const SESSIONS: Record<string, SessionContext> = {
  hr: office([grant(HR)], actors.hr),
  hr2: office([grant(HR)]),
  self: office([grant(HR)], actors.self),
  managerNoPay: office([grant(['people.earnings.view', 'people.earnings.review'])]),
  viewerPay: office([grant(['people.earnings.view', PAY])]),
  recordsNoPay: office([grant(['people.earnings.view', 'people.earnings.records'])]),
  lead: office([grant(['people.earnings.view', 'people.earnings.review', 'people.figures.view'])], idOf('user:member')),
  finance: office([grant(['costing.view', COST])]),
  owner: office([grant(['costing.view', COST, PAY])]),
  companyB: office([grant(HR, [companyB])]),
  plain: office([grant(['home.view'])]),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const run = randomBytes(4).toString('hex')
let serial = 0
const key = () => `t-${run}-${++serial}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const refusalOf = (error: Json): string => String(error.issues?.[0]?.path ?? '')
const auditOf = (action: string) => admin('SELECT "recordId", before, after, reason FROM "AuditLog" WHERE "tenantId" = $1 AND action = $2 ORDER BY at, id', [T, action])
const outbox = (type: string) => admin('SELECT subject, payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id', [T, type])
const entriesOf = (employeeId: string) => admin('SELECT * FROM "EarningsEntry" WHERE "tenantId" = $1 AND "employeeId" = $2 ORDER BY "createdAt", id', [T, employeeId])
const holdOf = async (scanId: string) => (await admin('SELECT * FROM "HeldScan" WHERE "tenantId" = $1 AND "operationScanId" = $2', [T, scanId]))[0]
const caller = () => callerFor(h.database, systemContext(T, `earnings-${run}`))

const worker = { a: operator, b: lead, c: newId() }
const employee = { a: '', b: '', c: '' }
let workOrderId = ''
let sew = ''
let pack = ''
let cell = ''
let device = ''
let schemeId = ''
let sewRate = ''

/** A new bundle of the seeded work order: every scan of this file has its own. */
async function bundle(quantity = 10): Promise<string> {
  const id = newId()
  await admin('INSERT INTO "Bundle" (id, "tenantId", "siteId", "workOrderId", "workOrderSizeId", code, quantity, "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, now())', [id, T, siteA1, workOrderId, cell, `T-${run}-${++serial}`, quantity])
  return id
}

interface ScanInput {
  readonly bundleId: string
  readonly at: Date
  readonly workerId?: string
  readonly kind?: 'REPORT' | 'PARTIAL' | 'UNDO' | 'CORRECTION' | 'START'
  readonly good?: number
  readonly scrap?: number
  readonly rework?: number
  readonly correctsId?: string
  readonly operationId?: string
  readonly earn?: boolean
}

/** A scan as the tablet writes it, on the day it happened, then the worker's handler. */
async function scan(input: ScanInput): Promise<string> {
  const id = newId()
  const kind = input.kind ?? 'REPORT'
  const operationId = input.operationId ?? sew
  await admin(
    `INSERT INTO "OperationScan" (id, "tenantId", "siteId", "workOrderId", "workOrderOperationId", "bundleId", kind, "correctsId", "goodQuantity", "scrapQuantity", "reworkQuantity", reason, "approvedById", "workerId", "stationId", "clientScanId", "deviceTime", "serverTime")
     VALUES ($1, $2, $3, $4, $5, $6, $7::"ScanKind", $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17)`,
    [id, T, siteA1, workOrderId, operationId, input.bundleId, kind, input.correctsId ?? null, input.good ?? (kind === 'UNDO' || kind === 'START' ? 0 : 4), input.scrap ?? 0, input.rework ?? 0, kind === 'REPORT' || kind === 'PARTIAL' || kind === 'START' ? null : 'Made-up reason', kind === 'CORRECTION' ? actors.hr : null, input.workerId ?? operator, sew1, `scan-${run}-${++serial}`, input.at],
  )
  if (input.earn !== false) await earn(input.bundleId, operationId)
  return id
}
const earn = (bundleId: string, workOrderOperationId: string = sew) => earnBundleNow(caller(), { bundleId, workOrderOperationId, siteId: siteA1 })

async function clock(employeeId: string, kind: 'IN' | 'OUT' | 'BREAK_OUT' | 'BREAK_IN', at: Date, workerId: string | null = worker.a): Promise<string> {
  const id = newId()
  if (workerId) {
    await admin(
      `INSERT INTO "ClockEvent" (id, "tenantId", "companyId", "siteId", "employeeId", "workerId", "deviceId", kind, source, "occurredAt", "deviceTime", "receivedAt", flags, "clientEventId")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::"ClockEventKind", 'OFFLINE', $9, $9, $10, '{}'::"ClockEventFlag"[], $11)`,
      [id, T, companyA, siteA1, employeeId, workerId, device, kind, at, new Date(at.getTime() + 60_000), `clock-${run}-${++serial}`],
    )
  } else {
    // HR's entry: MANUAL, no floor worker and no tablet on it.
    await admin(
      `INSERT INTO "ClockEvent" (id, "tenantId", "companyId", "siteId", "employeeId", kind, source, "occurredAt", "receivedAt", flags, reason, "createdById")
       VALUES ($1, $2, $3, $4, $5, $6::"ClockEventKind", 'MANUAL', $7, now(), '{}'::"ClockEventFlag"[], 'Made-up fix', $8)`,
      [id, T, companyA, siteA1, employeeId, kind, at, actors.hr],
    )
  }
  return id
}

/** A day the attendance computed and a person approved. */
async function attendance(employeeId: string, date: string, ordinary: number, more: { readonly overtime?: number; readonly status?: 'OPEN' | 'APPROVED' } = {}): Promise<string> {
  const id = newId()
  await admin(
    `INSERT INTO "AttendanceDay" (id, "tenantId", "companyId", "siteId", "employeeId", date, status, "presentMinutes", "ordinaryMinutes", "overtimeMinutes", "computedAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6::date, 'OPEN', $7, $8, $9, now(), now())`,
    [id, T, companyA, siteA1, employeeId, date, ordinary + (more.overtime ?? 0), ordinary, more.overtime ?? 0],
  )
  if ((more.status ?? 'APPROVED') === 'APPROVED') await approveDay(id)
  return id
}

const approveDay = (id: string) => admin(`UPDATE "AttendanceDay" SET status = 'APPROVED', "approvedAt" = now(), "approvedById" = $2 WHERE id = $1`, [id, actors.hr])

const approveBlock = (id: string) => admin(`UPDATE "OffStandardEntry" SET status = 'APPROVED', "approvedAt" = now(), "approvedById" = $2 WHERE id = $1`, [id, actors.hr])

async function block(input: { readonly employeeId: string; readonly workerId: string; readonly code: string; readonly date: string; readonly from: string; readonly to: string; readonly source?: 'FLOOR' | 'HELP_CALL'; readonly status?: 'APPROVED' | 'PENDING'; readonly helpCallId?: string }): Promise<string> {
  const id = newId()
  const code = (await admin<{ id: string }>('SELECT id FROM "OffStandardCode" WHERE "tenantId" = $1 AND "companyId" = $2 AND code = $3', [T, companyA, input.code]))[0]!.id
  const status = input.status ?? 'APPROVED'
  await admin(
    `INSERT INTO "OffStandardEntry" (id, "tenantId", "companyId", "siteId", "lineId", "stationId", "workerId", "employeeId", "codeId", source, "helpCallId", "workDate", "startedAt", "endedAt", status, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::"OffStandardSource", $11, $12::date, $13, $14, 'PENDING', now(), now())`,
    [id, T, companyA, siteA1, lineL1, sew1, input.workerId, input.employeeId, code, input.source ?? 'FLOOR', input.helpCallId ?? null, input.date, local(input.from, input.date), local(input.to, input.date)],
  )
  if (status === 'APPROVED') await approveBlock(id)
  return id
}

async function openGate(purpose: 'PERFORMANCE' | 'ATTENDANCE'): Promise<void> {
  const notice = (await admin<{ id: string }>(`SELECT id FROM "PrivacyNotice" WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = 'WORKER_FLOOR' AND status = 'PUBLISHED'`, [T, companyA]))[0]!.id
  const dpia = (await admin<{ id: string }>(`SELECT id FROM "PrivacyDpia" WHERE "tenantId" = $1 AND "companyId" = $2 AND status = 'STORED'`, [T, companyA]))[0]!.id
  await admin(
    `INSERT INTO "PeopleLegalGate" (id, "tenantId", "companyId", "siteId", purpose, basis, "basisReference", "basisCoversLeads", "leadsSeeFigures", "noticeId", "dpiaId", "switchedOnAt", "switchedOnById", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, 'SAMPLE - made-up basis for the test', $7, $7, $8, $9, $10, $11, now())`,
    [newId(), T, companyA, siteA1, purpose, purpose === 'PERFORMANCE' ? 'UNION_AGREEMENT' : 'NOT_REQUIRED', purpose === 'PERFORMANCE', notice, dpia, local('00:00', `${MONTH}-01`), actors.hr],
  )
}

/** Piece pay ON at A1 from the first day of the month: the scheme, the rates published before it, the legal switch. */
async function startPiecePay(): Promise<void> {
  await openGate('PERFORMANCE')
  const notice = (await admin<{ id: string }>(`SELECT id FROM "PrivacyNotice" WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = 'WORKER_FLOOR' AND status = 'PUBLISHED'`, [T, companyA]))[0]!.id
  const dpia = (await admin<{ id: string }>(`SELECT id FROM "PrivacyDpia" WHERE "tenantId" = $1 AND "companyId" = $2 AND status = 'STORED'`, [T, companyA]))[0]!.id
  const first = `${MONTH}-01`
  const before = local('08:00', plusDays(first, -2))
  schemeId = newId()
  await admin(`INSERT INTO "IncentiveScheme" (id, "tenantId", "companyId", name, kind, "guaranteedBasis", "guaranteedHourlyRate", "reworkOwnFault", "scrapOwnFault", "ownFaultRatePct", "validFrom", "updatedAt") VALUES ($1, $2, $3, 'Made-up piece rate', 'PIECE_RATE', 'CCNL_MINIMUM', 9, 'REDUCED_RATE', 'UNPAID', 50, $4::date, now())`, [schemeId, T, companyA, first])
  await admin(`UPDATE "IncentiveScheme" SET status = 'ACTIVE', "activatedAt" = now(), "activatedById" = $2 WHERE id = $1`, [schemeId, actors.hr])
  const table = newId()
  const version = newId()
  sewRate = newId()
  await admin(`INSERT INTO "PieceRateTable" (id, "tenantId", "companyId", "siteId", code, name, "updatedAt") VALUES ($1, $2, $3, $4, 'T-GENERAL', 'Made-up general rates', now())`, [table, T, companyA, siteA1])
  await admin(`INSERT INTO "PieceRateVersion" (id, "tenantId", "companyId", "siteId", "tableId", "versionNo", "changeReason", "effectiveFrom", "updatedAt") VALUES ($1, $2, $3, $4, $5, 1, 'NEW', $6::date, now())`, [version, T, companyA, siteA1, table, first])
  await admin(`INSERT INTO "PieceRateEntry" (id, "tenantId", "siteId", "versionId", "operationId", basis, "ratePerPiece", "updatedAt") VALUES ($1, $2, $3, $4, $5, 'FIXED', 1.5, now())`, [sewRate, T, siteA1, version, opSew])
  await admin(`INSERT INTO "RatePublication" (id, "tenantId", "companyId", "siteId", "versionId", "workerIds", "onFloor", printed, "publishedAt", "publishedById", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6::uuid[], true, false, $7, $8, now())`, [newId(), T, companyA, siteA1, version, [worker.a, worker.b, worker.c], before, actors.hr])
  await admin(`UPDATE "PieceRateVersion" SET status = 'PUBLISHED' WHERE id = $1`, [version])
  await admin(`INSERT INTO "PiecePaySwitch" (id, "tenantId", "companyId", "siteId", "updatedAt") VALUES ($1, $2, $3, $1, now())`, [siteA1, T, companyA])
  await admin(
    `UPDATE "PiecePaySwitch" SET state = 'ON', "ccnlName" = 'Made-up CCNL', "ccnlArticle" = 'art. 0', "workerNoticeId" = $2, "dpiaId" = $3, "consultantName" = 'Made-up consultant', "consultantAgreedOn" = $4::date, "schemeId" = $5, "onFrom" = $4::date, "switchedOnAt" = $6, "switchedOnById" = $7 WHERE id = $1`,
    [siteA1, notice, dpia, first, schemeId, local('00:00', first), actors.hr],
  )
}

let tablet: Browser

beforeAll(async () => {
  h = await startHarness('people_earnings')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedPrivacy({ db: h.database, namespace: NS })
  production = await seedProduction({ db: h.database, namespace: NS })
  people = await seedPeople({ db: h.database, namespace: NS })
  await seedAndon({ db: h.database, namespace: NS })
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  workOrderId = production.workOrderId
  sew = production.operationIds.sew
  pack = production.operationIds.pack
  cell = Object.values(production.cellIds)[0]!
  device = production.deviceId
  employee.a = people.employeeIds.e1
  employee.b = people.employeeIds.e2
  employee.c = newId()
  // Everyone on the floor here acknowledged the worker notice; the third is a made-up worker of the same line.
  await admin(`INSERT INTO "Employee" (id, "tenantId", "companyId", "siteId", "firstName", "lastName", "displayName", "startDate", "homeLineId", "updatedAt") VALUES ($1, $2, $3, $4, 'Carla', 'Tre (made up)', 'Carla T.', '2020-01-06', $5, now())`, [employee.c, T, companyA, siteA1, lineL1])
  await admin(`INSERT INTO "Worker" (id, "tenantId", "companyId", "siteId", "employeeId", "displayName", locale, "pinHash", status, "updatedAt") VALUES ($1, $2, $3, $4, $5, 'Carla T.', 'it', 'x', 'ACTIVE', now())`, [worker.c, T, companyA, siteA1, employee.c])
  await admin('INSERT INTO "WorkerNoticeAck" (id, "tenantId", "siteId", "workerId", "noticeId", "noticeVersion", locale, "noticeSha256", channel, "deviceId", "deviceTime", "serverTime") SELECT gen_random_uuid(), a."tenantId", a."siteId", w.id, a."noticeId", a."noticeVersion", a.locale, a."noticeSha256", a.channel, a."deviceId", a."deviceTime", a."serverTime" FROM "WorkerNoticeAck" a CROSS JOIN (VALUES ($1::uuid), ($2::uuid)) AS w(id) WHERE a."workerId" = $3', [worker.b, worker.c, operator])
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, "updatedAt") VALUES ($1, $2, $3, 'Made-up Operator (office)', 'ACTIVE', now())`, [actors.self, T, `operator-${run}@example.test`])
  await admin('UPDATE "Employee" SET "userId" = $2 WHERE id = $1', [employee.a, actors.self])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
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

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('GATE-PIECE-PAY: closed by default', () => {
  it('a scan at a site whose switch never went ON writes nothing: no entry, no hold, no period', async () => {
    const bundleId = await bundle()
    const scanId = await scan({ bundleId, at: local('10:00'), earn: false })
    expect(await earn(bundleId)).toBe(false)
    expect(await entriesOf(employee.a)).toEqual([])
    expect(await holdOf(scanId)).toBeUndefined()
    expect(await admin('SELECT id FROM "PayPeriod" WHERE "tenantId" = $1', [T])).toEqual([])
    await startPiecePay()
    await openGate('ATTENDANCE')
  })

  it('names the handlers the worker runs', () => {
    expect(earningsHandlers().map((handler) => handler.name)).toEqual(['people.earningsFromScan', 'people.heldScansAfterClock'])
  })
})

describe('the earnings ledger and held scans (MES-256, MES-264)', () => {
  let held = ''
  let heldScan = ''
  let heldBundle = ''

  it('a scan by a worker clocked in pays once, at its rate, however often the event comes', async () => {
    await clock(employee.a, 'IN', local('06:00'))
    await clock(employee.a, 'OUT', local('14:00'))
    const bundleId = await bundle()
    const scanId = await scan({ bundleId, at: local('10:00'), good: 4 })
    expect(await earn(bundleId)).toBe(false)
    const rows = (await entriesOf(employee.a)).filter((row) => row.operationScanId === scanId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'SCAN', pieces: 4, amount: 600, currency: 'EUR', rateEntryId: sewRate, idempotencyKey: `scan:${scanId}`, workerId: operator })
    expect(String(rows[0]!.rate)).toBe('1.500000')
    const event = (await outbox('earnings.recorded')).at(-1)!
    expect(event.payload).toEqual({ siteId: siteA1, bundleId, added: 1, reversed: 0, held: 0, released: 0 })
  })

  it('the ledger is append-only: no login changes or removes an entry', async () => {
    await expect(admin('UPDATE "EarningsEntry" SET amount = 1 WHERE "tenantId" = $1', [T])).rejects.toThrow(/append/i)
    await expect(admin('DELETE FROM "EarningsEntry" WHERE "tenantId" = $1', [T])).rejects.toThrow(/append/i)
  })

  it('a scan after the clock-out is held, pays nothing, and the list names nobody', async () => {
    heldBundle = await bundle()
    heldScan = await scan({ bundleId: heldBundle, at: local('15:00'), good: 3 })
    const hold = (await holdOf(heldScan))!
    held = hold.id
    expect(hold).toMatchObject({ status: 'OPEN', reason: 'NOT_CLOCKED_IN', employeeId: employee.a, key: `held:${heldScan}` })
    expect((await entriesOf(employee.a)).filter((row) => row.operationScanId === heldScan)).toEqual([])
    const list = await ok('managerNoPay', 'GET', `/people/held-scans?periodId=${hold.payPeriodId}`)
    expect(list.held.map((row: Json) => row.id)).toContain(held)
    expect(JSON.stringify(list)).not.toContain('Seed Employee')
    expect(JSON.stringify(list)).not.toContain(employee.a)
    expect(JSON.stringify(list)).not.toContain(operator)
  })

  it('refuses a list by person, in the words of the Owner answer', async () => {
    const error = await no('hr', 'GET', `/people/held-scans?employeeId=${employee.a}`, undefined, 400)
    expect(refusalOf(error)).toBe('query/filters/employeeId')
  })

  it('one record names the worker only for those with the right', async () => {
    const hr = await ok('hr', 'GET', `/people/held-scans/${held}`)
    expect(hr).toMatchObject({ day: D, peopleShown: true, canCount: false, voided: false })
    expect(hr.people).toEqual([{ employeeId: employee.a, name: 'Seed Employee One', clockedIn: false }])
    const manager = await ok('managerNoPay', 'GET', `/people/held-scans/${held}`)
    expect(manager).toMatchObject({ peopleShown: false, people: [] })
    await no('companyB', 'GET', `/people/held-scans/${held}`, undefined, 404)
  })

  it('"count it" needs the attendance fix first; a MANUAL clock event (no floor worker) is the fix, and the scan pays', async () => {
    const version = (await holdOf(heldScan))!.version
    const refused = await no('hr', 'POST', `/people/held-scans/${held}/count`, { version }, 409)
    expect(refusalOf(refused)).toBe('refusal/NOT_CLOCKED_IN_YET')
    const manual = await clock(employee.a, 'IN', local('14:30'), null)
    await clock(employee.a, 'OUT', local('15:30'), null)
    expect((await ok('hr', 'GET', `/people/held-scans/${held}`)).canCount).toBe(true)
    const answer = await ok('hr', 'POST', `/people/held-scans/${held}/count`, { version, note: 'Clocked in late' })
    expect(answer).toMatchObject({ status: 'COUNTED', resolution: { fixRecordType: 'ClockEvent', fixRecordId: manual } })
    const paid = (await entriesOf(employee.a)).filter((row) => row.operationScanId === heldScan)
    expect(paid).toHaveLength(1)
    expect(paid[0]).toMatchObject({ kind: 'SCAN', pieces: 3, amount: 450, heldScanId: held })
    expect((await auditOf('people.countHeldScan')).at(-1)).toMatchObject({ recordId: held, after: { status: 'COUNTED' } })
  })

  it('a decided hold is final', async () => {
    const version = (await holdOf(heldScan))!.version
    expect(refusalOf(await no('hr', 'POST', `/people/held-scans/${held}/not-paid`, { version, reason: 'Made-up reason' }, 409))).toBe('refusal/DECIDED')
  })

  it('a scan during a break is held as such; "do not pay" says why and pays nothing', async () => {
    await clock(employee.a, 'IN', local('06:00', D2))
    await clock(employee.a, 'BREAK_OUT', local('10:00', D2))
    await clock(employee.a, 'BREAK_IN', local('10:30', D2))
    await clock(employee.a, 'OUT', local('14:00', D2))
    const scanId = await scan({ bundleId: await bundle(), at: local('10:10', D2), good: 2 })
    const hold = (await holdOf(scanId))!
    expect(hold).toMatchObject({ reason: 'ON_BREAK', status: 'OPEN' })
    await no('hr', 'POST', `/people/held-scans/${hold.id}/not-paid`, { version: hold.version, reason: 'x' }, 400)
    await ok('hr', 'POST', `/people/held-scans/${hold.id}/not-paid`, { version: hold.version, reason: 'Made-up: the worker was on a break' })
    expect(await holdOf(scanId)).toMatchObject({ status: 'NOT_PAID', resolutionNote: 'Made-up: the worker was on a break', resolvedById: actors.hr })
    expect((await entriesOf(employee.a)).filter((row) => row.operationScanId === scanId)).toEqual([])
  })

  it('nobody decides their own hold', async () => {
    const bundleId = await bundle()
    const scanId = await scan({ bundleId, at: local('20:00', D2) })
    const hold = (await holdOf(scanId))!
    expect(refusalOf(await no('self', 'POST', `/people/held-scans/${hold.id}/not-paid`, { version: hold.version, reason: 'Made-up reason' }, 409))).toBe('refusal/OWN_RECORD')
    await ok('hr', 'POST', `/people/held-scans/${hold.id}/not-paid`, { version: hold.version, reason: 'Made-up reason' })
  })

  it('a late clock event releases a held scan by itself, when the handler looks again', async () => {
    const bundleId = await bundle()
    const scanId = await scan({ bundleId, at: local('07:00', D3), good: 2 })
    expect(await holdOf(scanId)).toMatchObject({ status: 'OPEN' })
    await clock(employee.a, 'IN', local('06:00', D3))
    await clock(employee.a, 'OUT', local('14:00', D3))
    const handler = earningsHandlers().find((item) => item.name === 'people.heldScansAfterClock')!
    await handler.handle({ eventId: newId(), tenantId: T, siteId: siteA1, type: 'attendance.day_changed', payload: { employeeId: employee.a, dayId: newId() } } as never, { caller: caller() } as never)
    expect(await holdOf(scanId)).toMatchObject({ status: 'COUNTED', fixRecordType: 'ClockEvent' })
    expect((await entriesOf(employee.a)).filter((row) => row.operationScanId === scanId)).toHaveLength(1)
  })

  it('an undone scan is reversed, a corrected one reversed and paid anew: never edited', async () => {
    const bundleId = await bundle()
    const first = await scan({ bundleId, at: local('08:00', D3), good: 4 })
    await scan({ bundleId, at: local('08:01', D3), kind: 'UNDO', correctsId: first })
    const rows = (await entriesOf(employee.a)).filter((row) => row.operationScanId === first)
    expect(rows.map((row) => [row.kind, row.pieces, row.amount])).toEqual([['SCAN', 4, 600], ['SCAN', -4, -600]])
    expect(rows[1]).toMatchObject({ reversalOfId: rows[0]!.id, idempotencyKey: `reverse:${rows[0]!.id}` })
    const other = await bundle()
    const reported = await scan({ bundleId: other, at: local('09:00', D3), good: 4 })
    const corrected = await scan({ bundleId: other, at: local('09:30', D3), kind: 'CORRECTION', correctsId: reported, good: 3 })
    const lines = (await entriesOf(employee.a)).filter((row) => row.operationScanId === reported || row.operationScanId === corrected)
    expect(lines.map((row) => [row.operationScanId === reported, row.pieces, row.amount])).toEqual([[true, 4, 600], [true, -4, -600], [false, 3, 450]])
    expect(lines[2]).toMatchObject({ idempotencyKey: `scan:${corrected}` })
  })

  it('a report pays what the partial did not; own-fault rework follows the scheme, scrap unpaid', async () => {
    const bundleId = await bundle()
    await clock(employee.b, 'IN', local('06:00', D3), worker.b)
    await clock(employee.b, 'OUT', local('14:00', D3), worker.b)
    await scan({ bundleId, at: local('09:30', D3), kind: 'START', workerId: worker.b, earn: false })
    const partial = await scan({ bundleId, at: local('10:00', D3), kind: 'PARTIAL', good: 3, workerId: worker.b, earn: false })
    const report = await scan({ bundleId, at: local('11:00', D3), good: 8, rework: 1, scrap: 1 })
    const rows = (await admin('SELECT "operationScanId", kind, pieces, rate, amount, "idempotencyKey" FROM "EarningsEntry" WHERE "tenantId" = $1 AND "operationScanId" = ANY($2::uuid[]) ORDER BY amount DESC', [T, [partial, report]])).map((row) => [row.idempotencyKey, row.pieces, row.amount])
    expect(rows).toEqual([[`scan:${report}`, 5, 750], [`scan:${partial}`, 3, 450], [`rework:${report}`, 1, 75]])
  })

  it('a partial reaches the ledger by its own event; a start or a pause is time, never pieces', async () => {
    await clock(employee.b, 'IN', local('06:00', D2), worker.b)
    await clock(employee.b, 'OUT', local('14:00', D2), worker.b)
    const bundleId = await bundle()
    await scan({ bundleId, at: local('09:30', D2), kind: 'START', workerId: worker.b, earn: false })
    const partial = await scan({ bundleId, at: local('10:00', D2), kind: 'PARTIAL', good: 2, workerId: worker.b, earn: false })
    const handler = earningsHandlers().find((item) => item.name === 'people.earningsFromScan')!
    const timed = (kind: string) => ({ eventId: newId(), tenantId: T, siteId: siteA1, type: 'production.operation_timed', payload: { bundleId, operationId: sew, kind } })
    await handler.handle(timed('PAUSE') as never, { caller: caller() } as never)
    expect(await admin('SELECT id FROM "EarningsEntry" WHERE "operationScanId" = $1', [partial])).toEqual([])
    await handler.handle(timed('PARTIAL') as never, { caller: caller() } as never)
    expect(await admin('SELECT kind::text, pieces, amount FROM "EarningsEntry" WHERE "operationScanId" = $1', [partial])).toEqual([{ kind: 'SCAN', pieces: 2, amount: 300 }])
  })

  it('a scan with no rate in force pays nothing and is told', async () => {
    const bundleId = await bundle()
    const scanId = await scan({ bundleId, at: local('09:00', D3), operationId: pack, good: 2 })
    expect((await entriesOf(employee.a)).filter((row) => row.operationScanId === scanId)).toEqual([])
  })
})

describe('where the clocked-in rule cannot be read', () => {
  it('the scheme can leave it off: nothing is held', async () => {
    await admin('ALTER TABLE "IncentiveScheme" DISABLE TRIGGER USER')
    await admin('UPDATE "IncentiveScheme" SET "payOnlyWhileClockedIn" = false WHERE id = $1', [schemeId])
    const scanId = await scan({ bundleId: await bundle(), at: local('21:00', D2), good: 1, workerId: worker.c })
    await admin('UPDATE "IncentiveScheme" SET "payOnlyWhileClockedIn" = true WHERE id = $1', [schemeId])
    await admin('ALTER TABLE "IncentiveScheme" ENABLE TRIGGER USER')
    expect(await holdOf(scanId)).toBeUndefined()
    expect((await entriesOf(employee.c)).filter((row) => row.operationScanId === scanId)).toHaveLength(1)
  })

  it('with the ATTENDANCE gate off there is no clock to read, and pay is not withheld', async () => {
    await admin(`UPDATE "PeopleLegalGate" SET "switchedOffAt" = now(), "switchedOffById" = $2, "switchOffReason" = 'made-up test' WHERE "tenantId" = $1 AND "siteId" = $3 AND purpose = 'ATTENDANCE' AND "switchedOffAt" IS NULL`, [T, actors.hr, siteA1])
    const scanId = await scan({ bundleId: await bundle(), at: local('22:00', D2), good: 1, workerId: worker.c })
    await openGate('ATTENDANCE')
    expect(await holdOf(scanId)).toBeUndefined()
    expect((await entriesOf(employee.c)).filter((row) => row.operationScanId === scanId)).toHaveLength(1)
  })
})

describe('the pay period (MES-260), the statement (MES-261) and waiting (MES-148)', () => {
  let periodId = ''
  let version = 0
  let waitingBlock = ''
  let cleaningBlock = ''
  let pendingDay = ''
  let pendingBlock = ''
  let overtimePending = ''
  const refresh = async () => {
    const row = await ok('hr', 'GET', `/people/pay-periods/${periodId}`)
    version = row.period.version
    return row
  }

  it('a period opens once per month, and only for those who may run it', async () => {
    const row = (await admin<{ id: string }>('SELECT id FROM "PayPeriod" WHERE "tenantId" = $1 AND "companyId" = $2 AND "periodStart" = $3::date', [T, companyA, `${MONTH}-01`]))[0]!
    periodId = row.id
    const again = await ok('hr', 'POST', '/people/pay-periods', { companyId: companyA, month: MONTH })
    expect(again).toMatchObject({ created: false, period: { id: periodId, status: 'OPEN' } })
    const made = await ok('hr', 'POST', '/people/pay-periods', { companyId: companyA, month: AFTER }, 201)
    expect(made).toMatchObject({ created: true, period: { month: AFTER, status: 'OPEN' } })
    await no('managerNoPay', 'POST', '/people/pay-periods', { companyId: companyA, month: NEXT }, 403)
    await no('companyB', 'GET', `/people/pay-periods/${periodId}`, undefined, 404)
    expect(refusalOf(await no('hr', 'POST', `/people/pay-periods/${made.period.id}/review`, { version: made.period.version }, 409))).toBe('refusal/WRONG_STATE')
  })

  it('the facts of the month: attendance, overtime, a team scan, waiting', async () => {
    await attendance(employee.a, D, 480, { overtime: 60 })
    await attendance(employee.a, D2, 480)
    await attendance(employee.a, D3, 420, { overtime: 120 })
    await attendance(employee.b, D3, 240)
    await attendance(employee.c, D3, 480)
    pendingDay = await attendance(employee.c, D2, 60, { status: 'OPEN' })
    const approved = newId()
    await admin(`INSERT INTO "OvertimeEntry" (id, "tenantId", "companyId", "siteId", "employeeId", date, kind, minutes, "updatedAt") VALUES ($1, $2, $3, $4, $5, $6::date, 'DAY', 60, now())`, [approved, T, companyA, siteA1, employee.a, D])
    await admin(`UPDATE "OvertimeEntry" SET status = 'APPROVED', "approvedAt" = now(), "approvedById" = $2 WHERE id = $1`, [approved, actors.hr])
    overtimePending = newId()
    await admin(`INSERT INTO "OvertimeEntry" (id, "tenantId", "companyId", "siteId", "employeeId", date, kind, minutes, "updatedAt") VALUES ($1, $2, $3, $4, $5, $6::date, 'DAY', 120, now())`, [overtimePending, T, companyA, siteA1, employee.a, D3])
    // A team of two by hours present: 240 and 480 minutes.
    await admin('ALTER TABLE "IncentiveScheme" DISABLE TRIGGER USER')
    await admin(`UPDATE "IncentiveScheme" SET kind = 'TEAM_INCENTIVE', "teamSplit" = 'HOURS_PRESENT' WHERE id = $1`, [schemeId])
    await admin('ALTER TABLE "IncentiveScheme" ENABLE TRIGGER USER')
    await clock(employee.c, 'IN', local('06:00', D3), worker.c)
    await clock(employee.c, 'OUT', local('14:00', D3), worker.c)
    const bundleId = await bundle()
    const teamScan = await scan({ bundleId, at: local('12:00', D3), good: 6, workerId: worker.b, earn: false })
    for (const [workerId, employeeId] of [[worker.b, employee.b], [worker.c, employee.c]] as const) await admin('INSERT INTO "OperationScanMember" (id, "tenantId", "siteId", "scanId", "workerId", "employeeId") VALUES ($1, $2, $3, $4, $5, $6)', [newId(), T, siteA1, teamScan, workerId, employeeId])
    await earn(bundleId)
    expect((await admin('SELECT id FROM "EarningsEntry" WHERE "operationScanId" = $1', [teamScan]))).toEqual([])
    // Waiting on a help call, under a code somebody set to unpaid: 30 minutes. Plain unpaid time: nothing. Base: guaranteed.
    await admin(`UPDATE "OffStandardCode" SET "payRule" = 'UNPAID' WHERE "tenantId" = $1 AND code IN ('WAIT_HELP', 'TRAINING')`, [T])
    const andon = (await admin<{ id: string }>('SELECT id FROM "HelpCall" WHERE "tenantId" = $1 AND "siteId" = $2 LIMIT 1', [T, siteA1]))[0]!
    waitingBlock = await block({ employeeId: employee.b, workerId: worker.b, code: 'WAIT_HELP', date: D3, from: '09:00', to: '09:30', source: 'HELP_CALL', helpCallId: andon.id })
    await block({ employeeId: employee.b, workerId: worker.b, code: 'TRAINING', date: D3, from: '10:00', to: '11:00' })
    cleaningBlock = await block({ employeeId: employee.b, workerId: worker.b, code: 'CLEANING', date: D3, from: '11:00', to: '11:20' })
    pendingBlock = await block({ employeeId: employee.c, workerId: worker.c, code: 'WAIT_MATERIAL', date: D3, from: '08:00', to: '08:10', status: 'PENDING' })
  })

  it('the run is a preview: statements are drafted, and only scans stand in the ledger', async () => {
    await refresh()
    const answer = await ok('hr', 'POST', `/people/pay-periods/${periodId}/run`, { version })
    expect(answer.period.status).toBe('PREVIEW')
    expect(answer.run.people).toBeGreaterThanOrEqual(3)
    const kinds = await admin<{ kind: string }>('SELECT DISTINCT kind::text FROM "EarningsEntry" WHERE "payPeriodId" = $1', [periodId])
    expect(kinds.map((row) => row.kind)).toEqual(['SCAN'])
    const statements = await ok('hr', 'GET', `/people/pay-periods/${periodId}/statements`)
    expect(statements.statements.length).toBeGreaterThanOrEqual(3)
    expect(JSON.stringify(statements)).not.toContain('Seed Employee')
    expect(JSON.stringify(statements)).not.toContain(employee.a)
    expect(statements.statements.every((row: Json) => row.status === 'DRAFT')).toBe(true)
  })

  it('the review waits for the month to be over and for everything that moves the pay', async () => {
    const detail = await refresh()
    const blocking = detail.checks.filter((check: Json) => check.blocking).map((check: Json) => check.code)
    expect(blocking).toEqual(expect.arrayContaining(['DAYS_OPEN', 'OVERTIME_PENDING', 'BLOCKS_WAITING']))
    expect(detail.actions.startReview.allowed).toBe(false)
    const refused = await no('hr', 'POST', `/people/pay-periods/${periodId}/review`, { version }, 409)
    expect(refusalOf(refused)).toBe('refusal/CHECKS_OPEN')
    expect(refused.message).toContain('only approved overtime is paid')
    await approveDay(pendingDay)
    await approveBlock(pendingBlock)
    await admin(`UPDATE "OvertimeEntry" SET status = 'REJECTED', "rejectedAt" = now(), "rejectedById" = $2, "rejectReason" = 'Made-up reason' WHERE id = $1`, [overtimePending, actors.hr])
    const thisMonth = await ok('hr', 'POST', '/people/pay-periods', { companyId: companyA, month: today.slice(0, 7) }, 201)
    const run = await ok('hr', 'POST', `/people/pay-periods/${thisMonth.period.id}/run`, { version: thisMonth.period.version })
    expect(refusalOf(await no('hr', 'POST', `/people/pay-periods/${thisMonth.period.id}/review`, { version: run.period.version }, 409))).toBe('refusal/NOT_OVER')
  })

  it('starting the review books the shares, the paid time and the make-up', async () => {
    await refresh()
    await ok('hr', 'POST', `/people/pay-periods/${periodId}/review`, { version })
    const rowsB = await entriesOf(employee.b)
    const c = await entriesOf(employee.c)
    // The team's 6 pieces × 1.50 = 9.00, split 240 : 480.
    expect(rowsB.find((row) => row.kind === 'TEAM_SPLIT')).toMatchObject({ pieces: 6, amount: 300, idempotencyKey: expect.stringMatching(/^team:/) })
    expect(String(rowsB.find((row) => row.kind === 'TEAM_SPLIT')!.sharePct)).toBe('33.3333')
    expect(c.find((row) => row.kind === 'TEAM_SPLIT')).toMatchObject({ amount: 600 })
    // MES-148: 30 minutes of waiting at the average, whatever the code says; the unpaid hour pays nothing; cleaning at the guarantee.
    const time = rowsB.filter((row) => row.kind === 'OFF_STANDARD')
    expect(time.map((row) => row.sourceId).sort()).toEqual([cleaningBlock, waitingBlock].sort())
    const waited = time.find((row) => row.sourceId === waitingBlock)!
    expect(String(waited.minutes)).toBe('30.000')
    // B earned 10.50 (7.50 of pieces, 3.00 of the team) on 240 − 110 minutes: 0.080769 a minute.
    expect(String(waited.rate)).toBe('0.080769')
    expect(waited.amount).toBe(242)
    expect(time.find((row) => row.sourceId === cleaningBlock)).toMatchObject({ amount: 300 })
    // Make-up: 240 minutes at 9.00/h = 36.00, less 10.50 + 2.42 + 3.00.
    const makeUpB = rowsB.find((row) => row.kind === 'MAKE_UP')!
    expect(makeUpB).toMatchObject({ amount: 3600 - 1592 })
    expect(String(makeUpB.minutes)).toBe('240.000')
    expect(String(makeUpB.rate)).toBe('0.150000')
  })

  it('overtime pays only once approved: never AttendanceDay.overtimeMinutes', async () => {
    const rowsA = await entriesOf(employee.a)
    const earned = rowsA.filter((row) => row.kind === 'SCAN' && row.correctsPeriodId === null).reduce((total, row) => total + Number(row.amount), 0)
    const makeUp = rowsA.find((row) => row.kind === 'MAKE_UP')!
    // 480 + 60 approved + 480 + 420: the 120 minutes of the third day nobody approved do not count.
    expect(String(makeUp.minutes)).toBe('1440.000')
    expect(makeUp.amount).toBe(21600 - earned)
  })

  it('a statement opens one at a time, recorded, with the right; a lead with no legal basis gets nothing', async () => {
    const list = (await ok('hr', 'GET', `/people/pay-periods/${periodId}/statements`)).statements as Json[]
    const row = (await admin<{ id: string }>('SELECT id FROM "WorkerStatement" WHERE "payPeriodId" = $1 AND "employeeId" = $2', [periodId, employee.b]))[0]!
    expect(list.map((item) => item.id)).toContain(row.id)
    const opened = await ok('hr', 'POST', `/people/statements/${row.id}/open`, {})
    expect(opened).toMatchObject({ person: { employeeId: employee.b }, status: 'DRAFT', openedAs: 'HR', stale: false, makeUpAmount: 2008 })
    expect(opened.lines.map((line: Json) => [line.operationCode, line.pieces, line.amount, line.sharePct])).toEqual(expect.arrayContaining([[expect.any(String), 5, 750, null], [expect.any(String), 6, 300, '33.3333']]))
    expect(opened.time.map((line: Json) => [line.code, line.minutes, line.amount]).sort()).toEqual([['CLEANING', '20.000', 300], ['WAIT_HELP', '30.000', 242]])
    expect(opened.makeUp).toMatchObject({ minutes: 240, guaranteed: 3600, amount: 2008 })
    expect((await auditOf('people.openWorkerStatement')).at(-1)).toMatchObject({ recordId: row.id, after: { employeeId: employee.b, as: 'HR' } })
    await no('managerNoPay', 'POST', `/people/statements/${row.id}/open`, {}, 404)
    await no('recordsNoPay', 'POST', `/people/statements/${row.id}/open`, {}, 404)
    await no('companyB', 'POST', `/people/statements/${row.id}/open`, {}, 404)
  })

  it('nobody approves their own statement; one that no longer matches the ledger is refused; a draft stops the lock', async () => {
    const own = (await admin<{ id: string; version: number }>('SELECT id, version FROM "WorkerStatement" WHERE "payPeriodId" = $1 AND "employeeId" = $2', [periodId, employee.a]))[0]!
    expect(refusalOf(await no('self', 'POST', `/people/statements/${own.id}/approve`, { version: own.version }, 409))).toBe('refusal/OWN_RECORD')
    await no('managerNoPay', 'POST', `/people/statements/${own.id}/approve`, { version: own.version }, 403)
    const detail = await refresh()
    expect(refusalOf(await no('hr', 'POST', `/people/pay-periods/${periodId}/lock`, { version, phrase: detail.lockPhrase }, 409))).toBe('refusal/STATEMENTS_OPEN')
    // A late offline scan of the month, after the statements were made.
    await clock(employee.c, 'IN', local('06:00', D2), worker.c)
    await clock(employee.c, 'OUT', local('14:00', D2), worker.c)
    const late = await scan({ bundleId: await bundle(), at: local('13:00', D2), good: 2, workerId: worker.c })
    expect((await entriesOf(employee.c)).filter((row) => row.operationScanId === late)).toHaveLength(1)
    const stale = (await admin<{ id: string; version: number }>('SELECT id, version FROM "WorkerStatement" WHERE "payPeriodId" = $1 AND "employeeId" = $2', [periodId, employee.c]))[0]!
    expect(refusalOf(await no('hr', 'POST', `/people/statements/${stale.id}/approve`, { version: stale.version }, 409))).toBe('refusal/STATEMENT_STALE')
  })

  it('taken back and run again: the make-up moves by a reversal and a new entry, and every statement approves', async () => {
    await refresh()
    await no('hr', 'POST', `/people/pay-periods/${periodId}/review/back`, { version, reason: 'x' }, 400)
    await ok('hr', 'POST', `/people/pay-periods/${periodId}/review/back`, { version, reason: 'A late scan arrived (made up)' })
    await refresh()
    await ok('hr', 'POST', `/people/pay-periods/${periodId}/run`, { version })
    await refresh()
    await ok('hr', 'POST', `/people/pay-periods/${periodId}/review`, { version })
    const rowsC = await entriesOf(employee.c)
    const makeUps = rowsC.filter((row) => row.kind === 'MAKE_UP')
    expect(makeUps.map((row) => row.amount)).toEqual([makeUps[0]!.amount, -makeUps[0]!.amount, makeUps[2]!.amount])
    expect(makeUps[2]!.amount).toBeLessThan(makeUps[0]!.amount)
    expect(makeUps[2]).toMatchObject({ idempotencyKey: expect.stringMatching(/#2$/) })
    // A lead reviews one statement: pieces and minutes, no money, recorded. It tells HR; it stops nothing.
    const statementA = (await admin<{ id: string; version: number }>(`SELECT id, version FROM "WorkerStatement" WHERE "payPeriodId" = $1 AND "employeeId" = $2 AND status = 'DRAFT'`, [periodId, employee.a]))[0]!
    await no('lead', 'POST', `/people/statements/${statementA.id}/open`, {}, 400)
    const seen = await ok('lead', 'POST', `/people/statements/${statementA.id}/open`, { reason: 'PAY_QUERY' })
    expect(seen).toMatchObject({ openedAs: 'LEAD', person: { employeeId: employee.a } })
    expect(seen.lines.length).toBeGreaterThan(0)
    expect(seen.lines[0].pieces).toEqual(expect.any(Number))
    expect(seen.lines.every((line: Json) => line.rate === undefined && line.amount === undefined)).toBe(true)
    expect(seen.earningsAmount).toBeUndefined()
    expect(seen.makeUp.amount).toBeUndefined()
    expect((await auditOf('people.openPersonFigures')).at(-1)).toMatchObject({ recordId: employee.a, after: { as: 'LEAD', reason: 'PAY_QUERY' } })
    const reviewed = await ok('lead', 'POST', `/people/statements/${statementA.id}/lead-review`, { version: statementA.version, note: 'Pieces look right' })
    expect(reviewed.leadReview).toMatchObject({ note: 'Pieces look right' })
    await no('hr', 'POST', `/people/statements/${statementA.id}/lead-review`, { version: statementA.version + 1 }, 403)
    await no('managerNoPay', 'POST', `/people/statements/${statementA.id}/lead-review`, { version: statementA.version + 1 }, 404)
    expect((await ok('hr', 'GET', `/people/pay-periods/${periodId}/statements`)).statements.find((row: Json) => row.id === statementA.id)).toMatchObject({ leadReviewed: true })
    // 540 minutes at 9.00/h: pieces, shares, paid time and make-up land on the guarantee exactly.
    expect(rowsC.reduce((total, row) => total + Number(row.amount), 0)).toBe(8100)
    const live = await admin<{ id: string; version: number }>(`SELECT id, version FROM "WorkerStatement" WHERE "payPeriodId" = $1 AND status <> 'SUPERSEDED'`, [periodId])
    for (const row of live) await ok('hr', 'POST', `/people/statements/${row.id}/approve`, { version: row.version })
    expect((await ok('hr', 'GET', `/people/pay-periods/${periodId}/statements`)).statements.every((row: Json) => row.status === 'APPROVED' && !row.stale)).toBe(true)
  })

  it('the lock is typed, by a person, and final', async () => {
    const detail = await refresh()
    expect(detail.lockPhrase).toBe(`LOCK ${MONTH}`)
    expect(refusalOf(await no('hr', 'POST', `/people/pay-periods/${periodId}/lock`, { version, phrase: 'LOCK' }, 409))).toBe('refusal/WRONG_PHRASE')
    const locked = await ok('hr', 'POST', `/people/pay-periods/${periodId}/lock`, { version, phrase: detail.lockPhrase, note: 'Made-up note' })
    expect(locked.period).toMatchObject({ status: 'LOCKED', lockNote: 'Made-up note' })
    expect((await outbox('pay_period.changed')).at(-1)!.payload).toMatchObject({ periodId, status: 'LOCKED', change: 'LOCKED' })
    expect(refusalOf(await no('hr', 'POST', `/people/pay-periods/${periodId}/run`, { version: locked.period.version }, 409))).toBe('refusal/WRONG_STATE')
  })

  it('after the lock a change is a new entry in a later period that names it', async () => {
    const before = await entriesOf(employee.c)
    const late = await scan({ bundleId: await bundle(), at: local('13:30', D2), good: 2, workerId: worker.c })
    const entry = (await entriesOf(employee.c)).find((row) => row.operationScanId === late)!
    expect(entry).toMatchObject({ correctsPeriodId: periodId, amount: 300 })
    expect(entry.payPeriodId).not.toBe(periodId)
    const month = (await admin<{ m: string }>(`SELECT to_char("periodStart", 'YYYY-MM') AS m FROM "PayPeriod" WHERE id = $1`, [entry.payPeriodId]))[0]!.m
    expect(month).toBe(AFTER)
    expect((await entriesOf(employee.c)).length).toBe(before.length + 1)
    // Undone: the reversal goes the same way.
    await scan({ bundleId: entry.bundleId ?? (await admin<{ bundleId: string }>('SELECT "bundleId" FROM "OperationScan" WHERE id = $1', [late]))[0]!.bundleId, at: local('13:31', D2), kind: 'UNDO', correctsId: late, workerId: worker.c })
    const reversed = (await entriesOf(employee.c)).find((row) => row.reversalOfId === entry.id)!
    expect(reversed).toMatchObject({ correctsPeriodId: periodId, payPeriodId: entry.payPeriodId, amount: -300 })
    // A block decided after the lock: paid in the later run, at the guaranteed rate, naming the month.
    const decided = await block({ employeeId: employee.c, workerId: worker.c, code: 'CLEANING', date: D2, from: '10:00', to: '10:40' })
    const later = (await admin<{ version: number }>('SELECT version FROM "PayPeriod" WHERE id = $1', [entry.payPeriodId]))[0]!
    await ok('hr', 'POST', `/people/pay-periods/${entry.payPeriodId}/run`, { version: later.version })
    const statement = (await admin<{ id: string; earningsAmount: number }>(`SELECT id, "earningsAmount" FROM "WorkerStatement" WHERE "payPeriodId" = $1 AND "employeeId" = $2 AND status = 'DRAFT'`, [entry.payPeriodId, employee.c]))[0]!
    const opened = await ok('hr', 'POST', `/people/statements/${statement.id}/open`, {})
    expect(opened.corrections.map((row: Json) => [row.kind, row.month, row.amount])).toEqual(expect.arrayContaining([['SCAN', MONTH, 300], ['SCAN', MONTH, -300], ['OFF_STANDARD', MONTH, 600]]))
    expect(decided).toEqual(expect.any(String))
    // A make-up of the locked month taken back: a correction here, never a negative make-up of this month.
    const lockedMakeUp = (await entriesOf(employee.c)).filter((row) => row.kind === 'MAKE_UP' && row.payPeriodId === periodId).at(-1)!
    await ok('hr', 'POST', `/people/earnings/entries/${lockedMakeUp.id}/correct`, { reason: 'Made-up: agreed with the consultant' })
    const version2 = (await admin<{ version: number }>('SELECT version FROM "PayPeriod" WHERE id = $1', [entry.payPeriodId]))[0]!
    const rerun = await ok('hr', 'POST', `/people/pay-periods/${entry.payPeriodId}/run`, { version: version2.version })
    await ok('hr', 'POST', `/people/pay-periods/${entry.payPeriodId}/review`, { version: rerun.period.version })
    const reopened = await ok('hr', 'POST', `/people/statements/${statement.id}/open`, {})
    expect(reopened).toMatchObject({ periodStatus: 'REVIEW', stale: false, makeUpAmount: 0 })
    expect(reopened.corrections.map((row: Json) => [row.kind, row.month, row.amount])).toEqual(expect.arrayContaining([['MAKE_UP', MONTH, -lockedMakeUp.amount]]))
  })
})

describe('corrections and the ledger (MES-256)', () => {
  it('the ledger grid is for those with the right, names nobody and refuses a filter by person', async () => {
    const page = await ok('hr', 'GET', `/people/earnings/ledger?kind=SCAN&limit=20&lineId=${lineL1}`)
    expect(page.entries.length).toBeGreaterThan(0)
    expect(JSON.stringify(page)).not.toContain(employee.a)
    expect(JSON.stringify(page)).not.toContain('Seed Employee')
    expect(page.entries[0]).toMatchObject({ kind: 'SCAN', rate: expect.any(String), amount: expect.any(Number), operation: { code: expect.any(String) } })
    expect(refusalOf(await no('hr', 'GET', `/people/earnings/ledger?employeeId=${employee.a}`, undefined, 400))).toBe('query/filters/employeeId')
    expect(refusalOf(await no('hr', 'GET', '/people/earnings/ledger?groupBy=employeeId', undefined, 400))).toBe('query/groupBy/employeeId')
    await no('recordsNoPay', 'GET', '/people/earnings/ledger', undefined, 403)
    await no('managerNoPay', 'GET', '/people/earnings/ledger', undefined, 403)
  })

  it('"correct" reverses the entry and adds a line with the reason; a later run does not pay it twice', async () => {
    await clock(employee.a, 'IN', local('06:00', `${NEXT}-05`))
    await clock(employee.a, 'OUT', local('14:00', `${NEXT}-05`))
    const scanId = await scan({ bundleId: await bundle(), at: local('10:00', `${NEXT}-05`), good: 2 })
    const paid = (await entriesOf(employee.a)).find((row) => row.operationScanId === scanId)!
    const record = await ok('hr', 'GET', `/people/earnings/entries/${paid.id}`)
    expect(record).toMatchObject({ person: { employeeId: employee.a }, canCorrect: true, kind: 'SCAN', amount: 300 })
    await no('hr', 'POST', `/people/earnings/entries/${paid.id}/correct`, { reason: 'x' }, 400)
    expect(refusalOf(await no('self', 'POST', `/people/earnings/entries/${paid.id}/correct`, { reason: 'Made-up reason' }, 409))).toBe('refusal/OWN_RECORD')
    await no('managerNoPay', 'POST', `/people/earnings/entries/${paid.id}/correct`, { reason: 'Made-up reason', amount: 100 }, 403)
    const corrected = await ok('hr', 'POST', `/people/earnings/entries/${paid.id}/correct`, { reason: 'Made-up: the wrong rate', amount: 250 })
    expect(corrected).toMatchObject({ canCorrect: false, reversedById: expect.any(String) })
    const rows = await entriesOf(employee.a)
    expect(rows.find((row) => row.reversalOfId === paid.id)).toMatchObject({ amount: -300, idempotencyKey: `correct:${paid.id}`, reason: 'Made-up: the wrong rate' })
    expect(rows.find((row) => row.sourceId === paid.id)).toMatchObject({ kind: 'ADJUSTMENT', amount: 250, sourceType: 'EarningsEntry' })
    expect(refusalOf(await no('hr', 'POST', `/people/earnings/entries/${paid.id}/correct`, { reason: 'Made-up reason' }, 409))).toBe('refusal/ALREADY_REVERSED')
    expect(refusalOf(await no('hr', 'POST', `/people/earnings/entries/${rows.find((row) => row.reversalOfId === paid.id)!.id}/correct`, { reason: 'Made-up reason' }, 409))).toBe('refusal/IS_REVERSAL')
    const bundleId = (await admin<{ bundleId: string }>('SELECT "bundleId" FROM "OperationScan" WHERE id = $1', [scanId]))[0]!.bundleId
    await earn(bundleId)
    expect((await entriesOf(employee.a)).filter((row) => row.operationScanId === scanId)).toHaveLength(2)
  })

  it('an adjustment says why, needs the pay grain and a floor sign-in at the site', async () => {
    const body = { employeeId: employee.a, siteId: siteA1, workDate: `${NEXT}-06`, amount: -500, reason: 'Made-up advance' }
    await no('hr', 'POST', '/people/earnings/adjustments', { ...body, reason: 'x' }, 400)
    await no('managerNoPay', 'POST', '/people/earnings/adjustments', body, 403)
    const made = await ok('hr', 'POST', '/people/earnings/adjustments', body, 201)
    expect(made).toMatchObject({ kind: 'ADJUSTMENT', amount: -500, reason: 'Made-up advance', person: { employeeId: employee.a } })
    expect(refusalOf(await no('hr', 'POST', '/people/earnings/adjustments', { ...body, employeeId: people.employeeIds.e4 }, 409))).toBe('refusal/NO_WORKER')
  })

  it('a make-up a person corrected stays as they left it: the run does not pay it again, and the statement still matches', async () => {
    await attendance(employee.a, `${NEXT}-05`, 120)
    const row = (await admin<{ id: string; version: number }>('SELECT id, version FROM "PayPeriod" WHERE "tenantId" = $1 AND "periodStart" = $2::date', [T, `${NEXT}-01`]))[0]!
    const previewed = await ok('hr', 'POST', `/people/pay-periods/${row.id}/run`, { version: row.version })
    const reviewed = await ok('hr', 'POST', `/people/pay-periods/${row.id}/review`, { version: previewed.period.version })
    const paid = (await entriesOf(employee.a)).find((entry) => entry.kind === 'MAKE_UP' && entry.payPeriodId === row.id)!
    expect(paid.amount).toBe(1800)
    await ok('hr', 'POST', `/people/earnings/entries/${paid.id}/correct`, { reason: 'Made-up: agreed with the consultant', amount: 1000 })
    const back = await ok('hr', 'POST', `/people/pay-periods/${row.id}/review/back`, { version: reviewed.period.version, reason: 'A correction was made (made up)' })
    const again = await ok('hr', 'POST', `/people/pay-periods/${row.id}/run`, { version: back.period.version })
    await ok('hr', 'POST', `/people/pay-periods/${row.id}/review`, { version: again.period.version })
    const makeUps = (await entriesOf(employee.a)).filter((entry) => entry.kind === 'MAKE_UP' && entry.payPeriodId === row.id)
    expect(makeUps.map((entry) => entry.amount)).toEqual([1800, -1800])
    const statement = (await admin<{ id: string; makeUpAmount: number; version: number }>(`SELECT id, "makeUpAmount", version FROM "WorkerStatement" WHERE "payPeriodId" = $1 AND "employeeId" = $2 AND status = 'DRAFT'`, [row.id, employee.a]))[0]!
    expect(statement.makeUpAmount).toBe(0)
    const opened = await ok('hr', 'POST', `/people/statements/${statement.id}/open`, {})
    expect(opened).toMatchObject({ stale: false, makeUpAmount: 0 })
    await ok('hr', 'POST', `/people/statements/${statement.id}/approve`, { version: statement.version })
  })

  it('the employee\'s Pay tab: one person\'s statements, with the right', async () => {
    const tab = await ok('hr', 'GET', `/people/employees/${employee.a}/statements`)
    expect(tab.statements.map((row: Json) => row.month)).toEqual(expect.arrayContaining([MONTH, NEXT]))
    expect(tab.statements[0]).toMatchObject({ currency: 'EUR', earningsAmount: expect.any(Number) })
    await no('recordsNoPay', 'GET', `/people/employees/${employee.a}/statements`, undefined, 403)
    await no('managerNoPay', 'GET', `/people/employees/${employee.a}/statements`, undefined, 403)
  })

  it('the tiles count, and name nobody', async () => {
    const tiles = await ok('managerNoPay', 'GET', `/people/earnings/counts?companyId=${companyA}`)
    expect(tiles).toMatchObject({ heldOpen: expect.any(Number), disputesOpen: expect.any(Number) })
    await no('plain', 'GET', `/people/earnings/counts?companyId=${companyA}`, undefined, 403)
  })
})

describe('a team scan with someone not clocked in', () => {
  it('holds the whole scan on its worker; the record shows who', async () => {
    const day = `${NEXT}-09`
    await clock(employee.a, 'IN', local('06:00', day))
    await clock(employee.a, 'OUT', local('14:00', day))
    const bundleId = await bundle()
    const scanId = await scan({ bundleId, at: local('10:00', day), good: 2, earn: false })
    for (const [workerId, employeeId] of [[worker.a, employee.a], [worker.c, employee.c]] as const) await admin('INSERT INTO "OperationScanMember" (id, "tenantId", "siteId", "scanId", "workerId", "employeeId") VALUES ($1, $2, $3, $4, $5, $6)', [newId(), T, siteA1, scanId, workerId, employeeId])
    await earn(bundleId)
    const hold = (await holdOf(scanId))!
    expect(hold).toMatchObject({ status: 'OPEN', reason: 'NOT_CLOCKED_IN', employeeId: employee.a })
    const record = await ok('hr', 'GET', `/people/held-scans/${hold.id}`)
    expect(record.people.map((person: Json) => [person.employeeId, person.clockedIn]).sort()).toEqual([[employee.a, true], [employee.c, false]].sort())
    expect(record.canCount).toBe(false)
  })
})

describe('the worker sees their own pay on the floor (c.c. art. 2101 c.3)', () => {
  it('their own statement and figures, with the PIN; the floor reads no pay table itself', async () => {
    const answer = await tablet.get(`/people/earnings/floor/mine?month=${MONTH}`)
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    const body = answer.body as Json
    expect(body).toMatchObject({ subject: 'WORKER', month: MONTH, status: 'LOCKED', statement: { status: 'APPROVED' } })
    expect(body.periodEarnings).toBeGreaterThan(0)
    expect(body.statement.lines.length).toBeGreaterThan(0)
    expect(JSON.stringify(body)).not.toContain(employee.b)
    expect(JSON.stringify(body)).not.toContain(employee.c)
  })

  it('a month with no period answers empty', async () => {
    const answer = await tablet.get('/people/earnings/floor/mine?month=2001-01')
    expect(answer.body).toMatchObject({ subject: 'WORKER', status: null, statement: null, periodEarnings: 0 })
  })
})

describe('the earnings report (MES-304) and labour cost per piece (MES-266)', () => {
  it('per line for people.earnings.view with the pay grain: nobody named, a small group shows nothing', async () => {
    const report = await ok('viewerPay', 'GET', `/people/reports/earnings?companyId=${companyA}&from=${MONTH}`)
    expect(report.lines.length).toBeGreaterThan(0)
    const line = report.lines.find((row: Json) => row.line?.id === lineL1)
    expect(line).toMatchObject({ tooFew: false, people: 3, makeUpSharePct: expect.any(String) })
    expect(line.earnings).toBeGreaterThan(0)
    expect(line.makeUp).toBeGreaterThan(0)
    expect(JSON.stringify(report)).not.toContain(employee.a)
    await admin(`INSERT INTO "PeopleSettings" (id, "tenantId", "companyId", "minimumGroupSize", "updatedAt") VALUES ($1, $2, $1, 10, now()) ON CONFLICT (id) DO UPDATE SET "minimumGroupSize" = 10`, [companyA, T])
    const small = await ok('viewerPay', 'GET', `/people/reports/earnings?companyId=${companyA}&from=${MONTH}`)
    expect(small.lines.find((row: Json) => row.line?.id === lineL1)).toMatchObject({ tooFew: true, people: null, pieces: null })
    expect(small.words).toEqual(['Too few people to show without identifying them'])
    const period = await ok('viewerPay', 'GET', '/people/pay-periods')
    expect(period.periods.find((row: Json) => row.month === MONTH)).toMatchObject({ tooFew: true })
    expect(period.periods.find((row: Json) => row.month === MONTH).earnings).toBeNull()
    await admin(`UPDATE "PeopleSettings" SET "minimumGroupSize" = 3 WHERE id = $1`, [companyA])
  })

  it('needs the pay grain: "Needs the wages grain" in the design', async () => {
    await no('managerNoPay', 'GET', `/people/reports/earnings?companyId=${companyA}&from=${MONTH}`, undefined, 403)
    const list = await ok('managerNoPay', 'GET', '/people/pay-periods')
    const row = list.periods.find((item: Json) => item.month === MONTH)
    expect(row.status).toBe('LOCKED')
    expect(row.earnings).toBeUndefined()
    expect(row.makeUp).toBeUndefined()
    expect(list.payShown).toBe(false)
    const detail = await ok('managerNoPay', 'GET', `/people/pay-periods/${row.id}`)
    expect(detail.lines.every((line: Json) => line.earnings === undefined && line.pieces === null)).toBe(true)
  })

  it('per worker only with the right, and the opening is recorded', async () => {
    await no('viewerPay', 'POST', '/people/reports/earnings/by-worker', { companyId: companyA, from: MONTH }, 403)
    await no('recordsNoPay', 'POST', '/people/reports/earnings/by-worker', { companyId: companyA, from: MONTH }, 403)
    const report = await ok('hr', 'POST', '/people/reports/earnings/by-worker', { companyId: companyA, from: MONTH })
    expect(report.workers.map((row: Json) => row.employeeId)).toEqual(expect.arrayContaining([employee.a, employee.b, employee.c]))
    expect(report.workers.find((row: Json) => row.employeeId === employee.b)).toMatchObject({ name: 'Seed Employee Two', makeUp: 2008 })
    expect((await auditOf('people.openEarningsByWorker')).at(-1)).toMatchObject({ recordId: companyA, after: { from: MONTH, people: expect.any(Number) } })
  })

  it('labour cost per piece against the costing: cost for finance, what the rates paid only with the pay grain too', async () => {
    const scanRow = (await admin<{ id: string; workOrderId: string; occurred: Date }>(`SELECT s.id, s."workOrderId", s."serverTime" AS occurred FROM "OperationScan" s JOIN "EarningsEntry" e ON e."operationScanId" = s.id WHERE e."employeeId" = $1 AND e.kind = 'SCAN' AND s."goodQuantity" = 3 AND s.kind = 'REPORT' LIMIT 1`, [employee.a]))[0]!
    await admin(`INSERT INTO "LabourRate" (id, "tenantId", "companyId", "workCentreKind", "costPerMinute", "validFrom", "updatedAt") SELECT $1, $2, $3, wc.kind, 0.2, '2000-01-01', now() FROM "WorkOrderOperation" o JOIN "WorkCentre" wc ON wc.id = o."workCentreId" WHERE o.id = $4`, [newId(), T, companyA, sew])
    await admin(`INSERT INTO "WorkOrderCostEntry" (id, "tenantId", "companyId", "siteId", "workOrderId", kind, "occurredAt", minutes, "unitCost", amount, currency, "costingMethod", "operationScanId", "idempotencyKey") VALUES ($1, $2, $3, $4, $5, 'LABOUR', $6, 30, 0.2, 600, 'EUR', 'UNDECIDED', $7, $8)`, [newId(), T, companyA, siteA1, workOrderId, scanRow.occurred, scanRow.id, `scan:${scanRow.id}`])
    const url = `/people/earnings/labour-cost?companyId=${companyA}&from=${MONTH}-01&to=${MONTH}-28`
    const finance = await ok('finance', 'GET', url)
    const row = finance.rows.find((item: Json) => item.labourCost === 600)
    expect(row).toMatchObject({ pieces: 3, labourCostPerPiece: '2', style: { id: production.styleId } })
    expect(row.costingPerPiece).toEqual(expect.any(String))
    expect(row.paidPerPiece).toBeUndefined()
    expect(JSON.stringify(finance)).not.toContain(employee.a)
    const owner = await ok('owner', 'GET', url)
    const full = owner.rows.find((item: Json) => item.labourCost === 600)
    // The rate is 1.50; a reworked piece at half of it brings the average down a little.
    expect(Number(full.paidPerPiece)).toBeGreaterThan(1.4)
    expect(Number(full.paidPerPiece)).toBeLessThanOrEqual(1.5)
    await no('managerNoPay', 'GET', url, undefined, 403)
  })
})

describe('GATE-PIECE-PAY: off again', () => {
  it('after the window a scan pays nothing; late work of the window is still paid (pay owed is never withheld)', async () => {
    const off = `${NEXT}-15`
    await admin(`UPDATE "PiecePaySwitch" SET state = 'OFF', "offFrom" = $2::date, "switchedOffAt" = $3, "switchedOffById" = $4, "offReason" = 'Made-up: the legal gate was switched off' WHERE id = $1`, [siteA1, off, local('00:00', off), actors.hr])
    const day = `${NEXT}-20`
    await clock(employee.a, 'IN', local('06:00', day))
    await clock(employee.a, 'OUT', local('14:00', day))
    const after = await scan({ bundleId: await bundle(), at: local('10:00', day), good: 2 })
    expect((await entriesOf(employee.a)).filter((row) => row.operationScanId === after)).toEqual([])
    const lateDay = `${NEXT}-12`
    await clock(employee.a, 'IN', local('06:00', lateDay))
    await clock(employee.a, 'OUT', local('14:00', lateDay))
    const late = await scan({ bundleId: await bundle(), at: local('10:00', lateDay), good: 2 })
    expect((await entriesOf(employee.a)).find((row) => row.operationScanId === late)).toMatchObject({ kind: 'SCAN', amount: 300 })
    await expect(admin(`INSERT INTO "EarningsEntry" (id, "tenantId", "companyId", "siteId", "payPeriodId", "employeeId", "workerId", "workDate", kind, minutes, rate, amount, "idempotencyKey") SELECT $1, "tenantId", "companyId", "siteId", "payPeriodId", "employeeId", "workerId", $2::date, 'MAKE_UP', 10, 0.15, 150, $3 FROM "EarningsEntry" WHERE "employeeId" = $4 AND "payPeriodId" = (SELECT id FROM "PayPeriod" WHERE "periodStart" = $5::date) LIMIT 1`, [newId(), day, `direct-${run}`, employee.a, `${NEXT}-01`])).rejects.toThrow(/piece pay is not ON/)
  })
})
