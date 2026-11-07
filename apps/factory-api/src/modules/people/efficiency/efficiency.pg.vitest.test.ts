import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { localInstant, plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedLabour } from '../../../../../../packages/factory-db/seed/labour'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seed as seedSkills } from '../../../../../../packages/factory-db/seed/skills'
import { seed as seedTime } from '../../../../../../packages/factory-db/seed/time'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { addUser, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * Efficiency (B-W2b-44; MES-247, MES-250, MES-251, ANA-016, ANA-017) through the app's real routes on a throwaway PostgreSQL 17
 * from the migrations (runtime login: row-level security, the grants and the floor work guards are real), on the factory-db
 * seeds up to floor work and skills. A made-up week of plant A1 counted from the clock: five made-up people on a made-up line
 * E1 and one on a made-up line E2. Sewing is done by three of them and runs 30 % over its standard; cutting is done by one person
 * alone; packing is reported in one tap. Every name and value is made up.
 *
 * The law the tests name: Statuto dei Lavoratori (L. 300/1970) art. 4 and Owner answers W1, F2: per line and per operation,
 * never per person, no ranking; H3: one person's figures for the worker and HR, behind the PERFORMANCE legal gate, off by
 * default; ANA-075: a group under the minimum size shows nothing; c.c. art. 2101: a person decides about a standard, with a
 * reason; GDPR art. 5(1)(b). Run with `node scripts/factory/run-pg-tests.mjs modules/people/efficiency`.
 */

vi.setConfig({ testTimeout: 120_000 })

let h: Harness
let app: FastifyInstance

const NS = 'w2b44-efficiency'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const companyB = idOf('company:B')
const siteA1 = idOf('site:A1')
const seededStation = idOf('site:A1:station:SEW-01')
const lineE1 = newId()
const sew1 = newId()
const sew2 = newId()
const operator = idOf('worker:A1:operator')
const TENANT: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'A' }, { id: companyB, code: 'B' }] }
const ROME = 'Europe/Rome'
const today = businessDate(new Date(), ROME)
/**
 * The days the tests work on, counted from the clock. They are made-up lines' days (E1, E2): a seeded row, whatever its date,
 * falls on the seed's own line L1 and never on these.
 */
const D1 = plusDays(today, -12)
const D2 = plusDays(today, -11)
const D3 = plusDays(today, -10)
const FROM = plusDays(today, -14)
const TO = plusDays(today, -8)
const at = (date: string, hhmm: string) => {
  const [hour, minute] = hhmm.split(':').map(Number)
  return localInstant(date, hour! * 60 + minute!, ROME)
}

const VIEW: Permission[] = ['people.efficiency.view']
const REVIEW: Permission[] = ['people.efficiency.view', 'people.efficiency.review']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (grants: Grant[], actorId: string = newId()): SessionContext => ({ audience: 'office', tenantId: T, actorId, grants })
const SESSIONS: Record<string, SessionContext> = {
  viewer: office([grant(VIEW)]),
  reviewer: office([grant(REVIEW)]),
  companyB: office([grant(REVIEW, [companyB])]),
  noRight: office([grant(['workorders.view'])]),
  // Holds the permission through no named role: not HR.
  figuresOnly: office([grant(['people.figures.view'])]),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT'
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const run = randomBytes(4).toString('hex')
let serial = 0
const key = () => `e-${run}-${++serial}`
const call = (session: string, method: Method, url: string, payload?: unknown, idempotencyKey = key()) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': idempotencyKey }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const pathOf = (error: Json): string => String(error.issues?.[0]?.path ?? '')
const scope = `siteId=${siteA1}&from=${FROM}&to=${TO}`

const people: Record<string, { employee: string; worker: string; name: string }> = {}
const tablets: Record<string, string> = {}
let wo1 = ''
const ops: Record<string, { id: string; standard: number; routing: string; operationId: string }> = {}
let cell = ''

async function person(key: string, line: string | null): Promise<void> {
  const employee = newId()
  const worker = newId()
  const name = `Made-up ${key} ${run}`
  await admin(`INSERT INTO "Employee" (id, "tenantId", "companyId", "siteId", "firstName", "lastName", "displayName", "startDate", "homeLineId") VALUES ($1, $2, $3, $4, 'Made-up', $5, $6, '2026-01-05', $7)`, [employee, T, companyA, siteA1, key, name, line])
  await admin(`INSERT INTO "Worker" (id, "tenantId", "companyId", "siteId", "displayName", locale, status, "employeeId") VALUES ($1, $2, $3, $4, $5, 'it', 'ACTIVE', $6)`, [worker, T, companyA, siteA1, name, employee])
  await admin(
    `INSERT INTO "WorkerNoticeAck" (id, "tenantId", "siteId", "workerId", "noticeId", "noticeVersion", locale, "noticeSha256", channel, "deviceId", "deviceTime", "serverTime", "createdById")
     SELECT $1, "tenantId", "siteId", $2, "noticeId", "noticeVersion", locale, "noticeSha256", channel, "deviceId", now(), now(), $2 FROM "WorkerNoticeAck" WHERE "workerId" = $3 LIMIT 1`,
    [newId(), worker, operator],
  )
  people[key] = { employee, worker, name }
}

async function device(key: string, stationId: string): Promise<void> {
  tablets[key] = newId()
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, $6, 'TABLET', 'ACTIVE', now())`, [tablets[key], T, companyA, siteA1, stationId, `Tablet ${key} ${run}`])
}

async function bundle(pieces: number): Promise<string> {
  const id = newId()
  await admin(`INSERT INTO "Bundle" (id, "tenantId", "siteId", "workOrderId", "workOrderSizeId", code, quantity, "deviceId", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())`, [id, T, siteA1, wo1, cell, `E-${run}-${++serial}`, pieces, tablets.sew])
  return id
}

interface ScanRow {
  readonly bundleId: string
  readonly op: string
  readonly kind: string
  readonly who: string | null
  readonly station: string
  readonly tablet: string
  readonly when: Date
  readonly good?: number
  readonly corrects?: string
}

async function scan(row: ScanRow): Promise<string> {
  const id = newId()
  await admin(
    `INSERT INTO "OperationScan" (id, "tenantId", "siteId", "workOrderId", "workOrderOperationId", "bundleId", kind, "correctsId", "goodQuantity", reason, "workerId", "stationId", "deviceId", "clientScanId", "serverTime", "createdById")
     VALUES ($1, $2, $3, $4, $5, $6, $7::"ScanKind", $8, $9, $10, $11, $12, $13, $14, $15, $11)`,
    [id, T, siteA1, wo1, ops[row.op]!.id, row.bundleId, row.kind, row.corrects ?? null, row.good ?? 0, row.kind === 'UNDO' ? 'Made-up undo.' : null, row.who, row.station, row.tablet, `e-${id}`, row.when],
  )
  return id
}

/** A bundle started and finished at an operation by a person, in `minutes` per piece of work. */
async function timed(input: { op: string; who: string; station: string; tablet: string; day: string; start: string; minutes: number; pieces?: number; team?: readonly string[] }): Promise<{ bundleId: string; report: string }> {
  const pieces = input.pieces ?? 10
  const bundleId = await bundle(pieces)
  const from = at(input.day, input.start)
  const common = { bundleId, op: input.op, who: people[input.who]!.worker, station: input.station, tablet: input.tablet }
  const start = await scan({ ...common, kind: 'START', when: from })
  for (const member of input.team ?? []) await admin(`INSERT INTO "OperationScanMember" (id, "tenantId", "siteId", "scanId", "workerId", "employeeId") VALUES ($1, $2, $3, $4, $5, $6)`, [newId(), T, siteA1, start, people[member]!.worker, people[member]!.employee])
  const report = await scan({ ...common, kind: 'REPORT', when: new Date(from.getTime() + input.minutes * 60_000), good: pieces })
  return { bundleId, report }
}

async function attended(key: string, date: string, minutes: number, planned = minutes): Promise<void> {
  await admin(
    `INSERT INTO "AttendanceDay" (id, "tenantId", "companyId", "siteId", "employeeId", date, status, "plannedMinutes", "plannedStartMinute", "plannedEndMinute", "plannedLabel", "firstInAt", "lastOutAt", "presentMinutes", "ordinaryMinutes", "computedAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6::date, 'OPEN', $7, 360, $11, 'Shift', $8, $9, $10, $10, now(), now())`,
    [newId(), T, companyA, siteA1, people[key]!.employee, date, planned, at(date, '06:00'), at(date, '14:30'), minutes, 360 + planned],
  )
}

async function openGate(purpose: 'PERFORMANCE' | 'ATTENDANCE', leads = false): Promise<void> {
  const notice = (await admin<{ id: string }>(`SELECT id FROM "PrivacyNotice" WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = 'WORKER_FLOOR' AND status = 'PUBLISHED'`, [T, companyA]))[0]!.id
  const dpia = (await admin<{ id: string }>(`SELECT id FROM "PrivacyDpia" WHERE "tenantId" = $1 AND "companyId" = $2 AND status = 'STORED'`, [T, companyA]))[0]!.id
  await admin(
    `INSERT INTO "PeopleLegalGate" (id, "tenantId", "companyId", "siteId", purpose, basis, "basisReference", "basisCoversLeads", "leadsSeeFigures", "noticeId", "dpiaId", "switchedOnAt", "switchedOnById", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, 'SAMPLE - made-up basis for the test', $7, $7, $8, $9, now() - interval '1 minute', $10, now())`,
    [newId(), T, companyA, siteA1, purpose, purpose === 'PERFORMANCE' ? 'UNION_AGREEMENT' : 'NOT_REQUIRED', leads, notice, dpia, newId()],
  )
}

const closeGate = (purpose: 'PERFORMANCE' | 'ATTENDANCE') => admin(`UPDATE "PeopleLegalGate" SET "switchedOffAt" = now(), "switchedOffById" = "switchedOnById", "switchOffReason" = 'Made-up test closing.', "updatedAt" = now() WHERE "tenantId" = $1 AND "siteId" = $2 AND purpose = $3 AND "switchedOffAt" IS NULL`, [T, siteA1, purpose])

const audits = async (action: string, recordId: string) => admin('SELECT "actorId", reason, after FROM "AuditLog" WHERE "tenantId" = $1 AND action = $2 AND "recordId" = $3 ORDER BY at, id', [T, action, recordId])

/** No id or name of any person of the week anywhere in the answer. */
function expectNobody(answer: unknown): void {
  const text = JSON.stringify(answer)
  for (const { employee, worker, name } of Object.values(people)) {
    expect(text).not.toContain(employee)
    expect(text).not.toContain(worker)
    expect(text).not.toContain(name)
  }
}

let hrUser = ''
let leadUser = ''
let selfUser = ''
let lineL2 = ''
let stationL2 = ''

beforeAll(async () => {
  h = await startHarness('efficiency')
  h.clock.set(new Date())
  for (const seed of [seedCore, seedPrivacy, seedTime, seedLabour, seedSkills]) await seed({ db: h.database, namespace: NS })
  wo1 = (await admin<{ id: string }>('SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND number = $2', [T, 'SEED-WO-0001']))[0]!.id
  const operations = await admin<{ id: string; seq: number; standardMinutes: string; routing: string; operationId: string }>(
    `SELECT o.id, o.seq, o."standardMinutes", r.id AS routing, r."operationId" FROM "WorkOrderOperation" o
     JOIN "WorkOrder" w ON w.id = o."workOrderId" JOIN "RoutingOperation" r ON r."revisionId" = o."styleRevisionId" AND r.seq = o."routingSeq" WHERE o."workOrderId" = $1`,
    [wo1],
  )
  for (const row of operations) ops[({ 10: 'cut', 20: 'sew', 30: 'qc', 40: 'pack' } as const)[row.seq as 10]] = { id: row.id, standard: Number(row.standardMinutes), routing: row.routing, operationId: row.operationId }
  cell = (await admin<{ id: string }>('SELECT id FROM "WorkOrderSize" WHERE "workOrderId" = $1 ORDER BY quantity DESC LIMIT 1', [wo1]))[0]!.id
  // Line E1 with two stations, line E2 with one (one person).
  const centre = (await admin<{ workCentreId: string }>('SELECT "workCentreId" FROM "Station" WHERE id = $1', [seededStation]))[0]!.workCentreId
  const line = (id: string, code: string) => admin(`INSERT INTO "Line" (id, "tenantId", "companyId", "siteId", code, name, "updatedAt") VALUES ($1, $2, $3, $4, $5, 'Made-up line', now())`, [id, T, companyA, siteA1, code])
  const station = (id: string, lineId: string, code: string) => admin(`INSERT INTO "Station" (id, "tenantId", "companyId", "siteId", "workCentreId", "lineId", code, name, "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, 'Made-up station', now())`, [id, T, companyA, siteA1, centre, lineId, code])
  lineL2 = newId()
  stationL2 = newId()
  await line(lineE1, 'E1')
  await line(lineL2, 'E2')
  await station(sew1, lineE1, 'E-01')
  await station(sew2, lineE1, 'E-02')
  await station(stationL2, lineL2, 'E-03')
  await device('sew', sew1)
  await device('sew2', sew2)
  await device('l2', stationL2)
  for (const name of ['A', 'B', 'C', 'D', 'T']) await person(name, lineE1)
  await person('Z', lineL2)
  // HR: a made-up custom role that People settings name; a team lead; the worker A as an office user.
  hrUser = (await addUser(h, TENANT, { email: `hr-${run}@example.test` })).id
  const roleId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
    await client.role.create({ data: { id: roleId, key: 'custom.hr', name: 'HR', permissions: ['people.figures.view'], grains: [], requireMfa: false, audience: 'OFFICE' } })
    await client.roleAssignment.create({ data: { id: newId(), userId: hrUser, roleId, allCompanies: false, companyIds: [companyA], siteIds: [], validFrom: new Date('2026-01-01T00:00:00.000Z') } })
  })
  await admin(`INSERT INTO "PeopleSettings" (id, "tenantId", "companyId", "figureRoleKeys", "updatedAt") VALUES ($1, $2, $1, ARRAY['custom.hr'], now()) ON CONFLICT (id) DO UPDATE SET "figureRoleKeys" = ARRAY['custom.hr']`, [companyA, T])
  SESSIONS.hr = office([grant(['people.figures.view'], [companyA])], hrUser)
  selfUser = (await addUser(h, TENANT, { email: `self-${run}@example.test` })).id
  await admin('UPDATE "Employee" SET "userId" = $2 WHERE id = $1', [people.A!.employee, selfUser])
  SESSIONS.self = office([grant(['people.figures.view'], [companyA])], selfUser)
  // The lead of a made-up team with B in it; the user is the employee D, who holds people.figures.view.
  leadUser = (await addUser(h, TENANT, { email: `lead-${run}@example.test` })).id
  await admin('UPDATE "Employee" SET "userId" = $2 WHERE id = $1', [people.D!.employee, leadUser])
  const team = newId()
  await admin(`INSERT INTO "Team" (id, "tenantId", "companyId", "siteId", "lineId", code, name, "updatedAt") VALUES ($1, $2, $3, $4, $5, 'E-T', 'Made-up team', now())`, [team, T, companyA, siteA1, lineE1])
  await admin(`INSERT INTO "TeamMember" (id, "tenantId", "siteId", "teamId", "employeeId", "isLead", since, "updatedAt") VALUES ($1, $2, $3, $4, $5, true, '2026-01-05', now())`, [newId(), T, siteA1, team, people.D!.employee])
  await admin(`INSERT INTO "TeamMember" (id, "tenantId", "siteId", "teamId", "employeeId", "isLead", since, "updatedAt") VALUES ($1, $2, $3, $4, $5, false, '2026-01-05', now())`, [newId(), T, siteA1, team, people.B!.employee])
  SESSIONS.lead = office([grant(['people.figures.view'], [companyA])], leadUser)
  // T is a trainee on sewing for the whole range; the skill is the operation's.
  const skill = newId()
  await admin(`INSERT INTO "Skill" (id, "tenantId", "companyId", code, name, kind, "operationId", "updatedAt") VALUES ($1, $2, $3, $4, 'Made-up sewing', 'OPERATION', $5, now())`, [skill, T, companyA, `E-${run}`, ops.sew!.operationId])
  await admin(`INSERT INTO "EmployeeSkill" (id, "tenantId", "siteId", "employeeId", "skillId", level, since, "assessedAt", "assessedById", "traineeUntil", "updatedAt") VALUES ($1, $2, $3, $4, $5, 'LEARNING', $6::date, now(), $7, $8::date, now())`, [newId(), T, siteA1, people.T!.employee, skill, FROM, newId(), today])

  // Sewing by A, B and C on E1: 30 % over the standard, one garment a bundle, on three days (C alone on D3).
  const sew = ops.sew!.standard * 1.3
  const sewing = { op: 'sew', pieces: 1, minutes: sew }
  await timed({ ...sewing, who: 'A', station: sew1, tablet: tablets.sew!, day: D1, start: '06:30' })
  await timed({ ...sewing, who: 'B', station: sew2, tablet: tablets.sew2!, day: D1, start: '06:30' })
  await timed({ ...sewing, who: 'C', station: sew1, tablet: tablets.sew!, day: D2, start: '06:30' })
  await timed({ ...sewing, who: 'A', station: sew2, tablet: tablets.sew2!, day: D2, start: '06:30' })
  await timed({ ...sewing, who: 'B', station: sew1, tablet: tablets.sew!, day: D2, start: '10:00' })
  await timed({ ...sewing, who: 'C', station: sew2, tablet: tablets.sew2!, day: D3, start: '06:30' })
  // A trainee's bundle, far off the standard: left out of the operation.
  await timed({ ...sewing, minutes: sew * 4, who: 'T', station: sew1, tablet: tablets.sew!, day: D3, start: '06:30' })
  // Cutting: D alone, off the standard: one person's figure.
  for (const start of ['06:30', '07:30', '08:30', '09:30', '10:30', '11:30']) await timed({ op: 'cut', who: 'D', station: sew1, tablet: tablets.sew!, day: D1, start, minutes: 10 })
  // Packing: one tap on E1, three people, no timing.
  for (const who of ['A', 'B', 'C']) await scan({ bundleId: await bundle(10), op: 'pack', kind: 'REPORT', who: people[who]!.worker, station: sew1, tablet: tablets.sew!, when: at(D1, '13:00'), good: 10 })
  // A report undone counts for nothing.
  const undone = await bundle(10)
  const report = await scan({ bundleId: undone, op: 'pack', kind: 'REPORT', who: people.A!.worker, station: sew1, tablet: tablets.sew!, when: at(D1, '13:10'), good: 10 })
  await scan({ bundleId: undone, op: 'pack', kind: 'UNDO', who: people.A!.worker, station: sew1, tablet: tablets.sew!, when: at(D1, '13:11'), corrects: report })
  // E2: Z alone.
  await timed({ ...sewing, who: 'Z', station: stationL2, tablet: tablets.l2!, day: D1, start: '06:30' })

  for (const name of ['A', 'B', 'C', 'D']) await attended(name, D1, 480)
  await attended('A', D2, 480)
  await attended('B', D2, 480, 600)
  await attended('C', D2, 480)
  await attended('T', D1, 480)
  await attended('Z', D1, 480)

  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

const sewEarned = (bundles: number) => ops.sew!.standard * bundles

describe('line efficiency (MES-247, ANA-017)', () => {
  it('Statuto art. 4 c.2: with the attendance purpose off the lines show what was earned and no attended minute', async () => {
    const answer = await ok('viewer', 'GET', `/people/efficiency?${scope}`)
    expect(answer.attendance.open).toBe(false)
    expect(answer.tiles.attendedMinutes).toBeNull()
    expect(answer.tiles.efficiency).toBeNull()
    expect(answer.words.join(' ')).toContain('art. 4 c.2')
    expect(Number(answer.tiles.earnedMinutes)).toBeGreaterThan(0)
    expect(answer.individual.available).toBe(false)
  })

  it('earned against attended and against planned, per line; trainee days out on both sides; the undone report counts nothing', async () => {
    await openGate('ATTENDANCE')
    const answer = await ok('viewer', 'GET', `/people/efficiency?${scope}&compare=previous`)
    const l1 = answer.lines.find((row: Json) => row.line?.code === 'E1')
    // Six bundles of sewing less the trainee's; six of cutting by D; three of packing; the undone one nothing.
    const earned = sewEarned(6) + 6 * 10 * ops.cut!.standard + 3 * 10 * ops.pack!.standard
    expect(Number(l1.figures.earnedMinutes)).toBeCloseTo(earned, 3)
    expect(l1.figures.attendedMinutes).toBe(String((4 + 3) * 480) + '.000')
    expect(l1.figures.plannedMinutes).toBe(String(4 * 480 + 2 * 480 + 600) + '.000')
    expect(l1.figures.efficiency).toBe(((earned / (7 * 480)) * 100).toFixed(1))
    expect(l1.people).toBe(4)
    expect(answer.traineeDaysLeftOut).toBeGreaterThanOrEqual(1)
    expect(answer.attendance.provisional).toBe(true)
    expect(answer.previous.tiles).toBeNull()
  })

  it('off-standard minutes come off the minutes on standard work, a rejected block does not', async () => {
    const code = (await admin<{ id: string }>('SELECT id FROM "OffStandardCode" WHERE "tenantId" = $1 AND "companyId" = $2 AND code = $3', [T, companyA, 'CLEANING']))[0]!.id
    const block = async (status: 'APPROVED' | 'REJECTED', minutes: number) => {
      const id = newId()
      const start = at(D1, '12:00')
      await admin(
        `INSERT INTO "OffStandardEntry" (id, "tenantId", "companyId", "siteId", "lineId", "workerId", "employeeId", "codeId", source, "workDate", "startedAt", "endedAt", status, "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'LEAD', $9::date, $10, $11, 'PENDING', now())`,
        [id, T, companyA, siteA1, lineE1, people.A!.worker, people.A!.employee, code, D1, start, new Date(start.getTime() + minutes * 60_000)],
      )
      if (status === 'APPROVED') await admin(`UPDATE "OffStandardEntry" SET status = 'APPROVED', "approvedAt" = now(), "approvedById" = $2 WHERE id = $1`, [id, newId()])
      else await admin(`UPDATE "OffStandardEntry" SET status = 'REJECTED', "rejectedAt" = now(), "rejectedById" = $2, "rejectReason" = 'Made-up.' WHERE id = $1`, [id, newId()])
    }
    await block('APPROVED', 60)
    await block('REJECTED', 45)
    const l1 = (await ok('viewer', 'GET', `/people/efficiency?${scope}`)).lines.find((row: Json) => row.line?.code === 'E1')
    expect(l1.figures.offStandardMinutes).toBe('60.000')
    expect(l1.figures.onStandardMinutes).toBe(String(7 * 480 - 60) + '.000')
    expect(Number(l1.figures.onStandardEfficiency)).toBeGreaterThan(Number(l1.figures.efficiency))
  })

  it('MES-238: a day HR entered by hand (a MANUAL clock event: no worker, no tablet) counts as attended', async () => {
    SESSIONS.hrAttendance = office([grant(['people.attendance.manage', 'people.attendance.view'])])
    const before = (await ok('viewer', 'GET', `/people/efficiency?${scope}`)).lines.find((row: Json) => row.line?.code === 'E1')
    const response = await call('hrAttendance', 'POST', '/people/attendance/entries', { employeeId: people.D!.employee, date: D2, in: at(D2, '06:00').toISOString(), out: at(D2, '10:00').toISOString(), reason: 'Forgot the badge, made-up.' })
    expect(response.statusCode, response.body).toBe(201)
    const events = await admin<{ workerId: string | null; source: string }>('SELECT "workerId", source FROM "ClockEvent" WHERE "tenantId" = $1 AND "employeeId" = $2', [T, people.D!.employee])
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((event) => event.source === 'MANUAL' && event.workerId === null)).toBe(true)
    const present = (await admin<{ presentMinutes: number }>('SELECT "presentMinutes" FROM "AttendanceDay" WHERE "employeeId" = $1 AND date = $2::date', [people.D!.employee, D2]))[0]!.presentMinutes
    expect(present).toBeGreaterThan(0)
    const after = (await ok('viewer', 'GET', `/people/efficiency?${scope}`)).lines.find((row: Json) => row.line?.code === 'E1')
    expect(Number(after.figures.attendedMinutes)).toBe(Number(before.figures.attendedMinutes) + present)
  })

  it('ANA-075: a line of one person shows nothing, and the total leaves it out: no working it out by subtraction', async () => {
    const answer = await ok('viewer', 'GET', `/people/efficiency?${scope}`)
    const l2 = answer.lines.find((row: Json) => row.line?.code === 'E2')
    expect(l2).toMatchObject({ tooFew: true, people: null, words: 'Too few people to show without identifying them' })
    expect(Object.values(l2.figures).every((value) => value === null)).toBe(true)
    expect(answer.hiddenGroups).toBeGreaterThanOrEqual(1)
    const l1 = answer.lines.find((row: Json) => row.line?.code === 'E1')
    expect(answer.tiles.earnedMinutes).toBe(l1.figures.earnedMinutes)
    expect(answer.tiles.attendedMinutes).toBe(l1.figures.attendedMinutes)
    expect(answer.words.join(' ')).toContain('left out of the totals')
  })

  it('Owner answer F2: one series per line; each day a group of its own: a day with too few people shows nothing', async () => {
    const answer = await ok('viewer', 'GET', `/people/efficiency/trend?${scope}`)
    const l1 = answer.lines.find((row: Json) => row.line?.code === 'E1')
    const day1 = l1.points.find((point: Json) => point.date === D1)
    expect(day1.tooFew).toBe(false)
    expect(Number(day1.efficiency)).toBeGreaterThan(0)
    // D3: C and the trainee reported; the trainee is out only with every person on a trainee day, and the two are still too few.
    const day3 = l1.points.find((point: Json) => point.date === D3)
    expect(day3).toMatchObject({ tooFew: true, efficiency: null, earnedMinutes: null, attendedMinutes: null })
    expect(Object.keys(answer.lines[0])).toEqual(['line', 'targetPercent', 'points'])
  })

  it('Owner answer W1: a person key in a filter or a group is refused in words, on every figures read', async () => {
    for (const path of ['', '/trend', '/operations', '/cycle-time']) {
      expect(pathOf(await no('viewer', 'GET', `/people/efficiency${path}?${scope}&employeeId=${people.A!.employee}`, undefined, 400))).toBe('query/filters/employeeId')
      expect(pathOf(await no('viewer', 'GET', `/people/efficiency${path}?${scope}&workerId=${people.A!.worker}`, undefined, 400))).toBe('query/filters/workerId')
      expect(pathOf(await no('viewer', 'GET', `/people/efficiency${path}?${scope}&groupBy=employeeId`, undefined, 400))).toBe('query/groupBy/employeeId')
    }
  })

  it('reach: another company\'s site is not found, a line of another site is not found, no right is a 403', async () => {
    await no('companyB', 'GET', `/people/efficiency?${scope}`, undefined, 404)
    await no('viewer', 'GET', `/people/efficiency?${scope}&lineId=${newId()}`, undefined, 404)
    await no('noRight', 'GET', `/people/efficiency?${scope}`, undefined, 403)
  })
})

describe('planned against actual and cycle time (MES-250, ANA-016)', () => {
  it('per style and operation: person-minutes per piece against the standard; a trainee\'s bundle and one-tap reports not counted', async () => {
    const answer = await ok('viewer', 'GET', `/people/efficiency/operations?${scope}`)
    expect(answer.rule).toEqual({ tolerancePercent: 10, minBundles: 5 })
    const sew = answer.operations.find((row: Json) => row.routingOperationId === ops.sew!.routing)
    expect(sew.tooFew).toBe(false)
    expect(sew.figures.bundles).toBe(7)
    expect(sew.figures.pieces).toBe(7)
    expect(sew.standardMinutes).toBe(ops.sew!.standard.toFixed(3))
    expect(sew.figures.state).toBe('REVIEW')
    expect(Math.abs(Number(sew.figures.differencePercent) - 30)).toBeLessThan(1)
    expect(answer.traineeBundles).toBe(1)
    expect(answer.untimedReports).toBe(3)
    expect(answer.operations.some((row: Json) => row.routingOperationId === ops.pack!.routing)).toBe(false)
  })

  it('ANA-016 legal note: one person alone on an operation is one person\'s figure: the row and its sparkline stay empty', async () => {
    const answer = await ok('viewer', 'GET', `/people/efficiency/operations?${scope}`)
    const cut = answer.operations.find((row: Json) => row.routingOperationId === ops.cut!.routing)
    expect(cut).toMatchObject({ tooFew: true, people: null, series: [] })
    expect(cut.standardMinutes).toBe(ops.cut!.standard.toFixed(3))
    expect(Object.values(cut.figures).every((value) => value === null)).toBe(true)
    const detail = await ok('viewer', 'GET', `/people/efficiency/operations/${ops.cut!.routing}?${scope}`)
    expect(detail).toMatchObject({ tooFew: true, people: null, days: [] })
    expect(detail.figures.actualMinutes).toBeNull()
    expect(detail.review).toMatchObject({ reason: null, since: null })
  })

  it('a day of an operation with fewer people than the minimum shows nothing in the sparkline', async () => {
    const sew = (await ok('viewer', 'GET', `/people/efficiency/operations?${scope}`)).operations.find((row: Json) => row.routingOperationId === ops.sew!.routing)
    expect(sew.series.find((point: Json) => point.date === D2)).toMatchObject({ tooFew: false })
    // D3: C alone (the trainee's bundle is left out).
    expect(sew.series.find((point: Json) => point.date === D3)).toMatchObject({ tooFew: true, actualMinutes: null, differencePercent: null })
  })

  it('cycle time per operation, a group like any other; no person in it', async () => {
    const answer = await ok('viewer', 'GET', `/people/efficiency/cycle-time?${scope}`)
    const sew = answer.operations.find((row: Json) => row.operation.id === ops.sew!.operationId)
    expect(sew.tooFew).toBe(false)
    expect(sew.figures.bundles).toBe(7)
    expect(Number(sew.figures.cycleMinutesPerBundle)).toBeCloseTo(ops.sew!.standard * 1.3, 1)
    expect(sew.figures.cycleMinutesPerPiece).toBe(sew.figures.cycleMinutesPerBundle)
    expect(answer.operations.find((row: Json) => row.operation.id === ops.cut!.operationId)).toMatchObject({ tooFew: true, people: null })
  })

  it('Statuto art. 4: no answer of a figures route holds a person, and none ranks anybody', async () => {
    for (const path of ['', '/trend', '/operations', '/cycle-time']) expectNobody(await ok('viewer', 'GET', `/people/efficiency${path}?${scope}`))
    expectNobody(await ok('viewer', 'GET', `/people/efficiency/review?siteId=${siteA1}`))
    expectNobody(await ok('viewer', 'GET', `/people/efficiency/operations/${ops.sew!.routing}?${scope}`))
  })

  it('a filter narrows the group: sewing on line E2 stands on one person, so it shows nothing', async () => {
    const answer = await ok('viewer', 'GET', `/people/efficiency/operations?${scope}&lineId=${lineL2}`)
    expect(answer.operations).toHaveLength(1)
    expect(answer.operations[0]).toMatchObject({ tooFew: true, people: null })
  })
})

describe('the standard review (MES-251; c.c. art. 2101)', () => {
  const queueUrl = `/people/efficiency/review?siteId=${siteA1}`
  const decideUrl = (routing: string) => `/people/efficiency/review/${routing}/decide`

  it('off by more than the tolerance over enough bundles comes on the queue; one person alone stays off it, counted', async () => {
    const answer = await ok('viewer', 'GET', queueUrl)
    const entry = answer.queue.find((row: Json) => row.routingOperationId === ops.sew!.routing)
    expect(entry).toMatchObject({ reason: 'OFF_STANDARD', direction: 'OVER', lastDecision: null, tooFew: false })
    expect(entry.figures.bundles).toBe(7)
    expect(entry.since).toBeTruthy()
    expect(answer.queue.some((row: Json) => row.routingOperationId === ops.cut!.routing)).toBe(false)
    expect(answer.leftOut).toBe(1)
    expect(answer.count).toBe(answer.queue.length)
  })

  it("B-W2b-89: the company's limits decide the queue; reading and changing them ask their rights", async () => {
    const ruleUrl = `/people/efficiency/review/rule?companyId=${companyA}`
    const read = await ok('viewer', 'GET', ruleUrl)
    expect(read).toMatchObject({ companyId: companyA, tolerancePercent: 10, minBundles: 5, windowDays: 60, canManage: false })
    const body = { companyId: companyA, version: read.version, tolerancePercent: 40, minBundles: 5 }
    await no('viewer', 'PUT', '/people/efficiency/review/rule', body, 403)
    await no('companyB', 'PUT', '/people/efficiency/review/rule', body, 404)
    await no('noRight', 'GET', ruleUrl, undefined, 403)
    expect(pathOf(await no('reviewer', 'PUT', '/people/efficiency/review/rule', { ...body, tolerancePercent: 0 }, 400))).toBe('body/tolerancePercent')
    // Sewing is 30 % over its standard: a 40 % tolerance takes it off the queue.
    const loose = await ok('reviewer', 'PUT', '/people/efficiency/review/rule', body)
    expect(loose).toMatchObject({ tolerancePercent: 40, minBundles: 5, canManage: true })
    const queue = await ok('viewer', 'GET', queueUrl)
    expect(queue.rule).toEqual({ tolerancePercent: 40, minBundles: 5 })
    expect(queue.words[0]).toContain('more than 40% off')
    expect(queue.queue.some((row: Json) => row.routingOperationId === ops.sew!.routing)).toBe(false)
    expect((await ok('viewer', 'GET', `/people/efficiency/operations?${scope}`)).rule).toEqual({ tolerancePercent: 40, minBundles: 5 })
    // A read from before the change does not overwrite it unseen; back to 10 % it is on again.
    await no('reviewer', 'PUT', '/people/efficiency/review/rule', { ...body, tolerancePercent: 10 }, 409)
    await ok('reviewer', 'PUT', '/people/efficiency/review/rule', { ...body, version: loose.version, tolerancePercent: 10 })
    expect((await ok('viewer', 'GET', queueUrl)).queue.find((row: Json) => row.routingOperationId === ops.sew!.routing)).toMatchObject({ reason: 'OFF_STANDARD' })
    const events = await admin('SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2', [T, 'people_settings.review_changed'])
    expect(events.map((event) => event.payload)).toEqual([{ companyId: companyA, version: loose.version }, { companyId: companyA, version: loose.version + 1 }])
    const rows = await admin(`SELECT before, after FROM "AuditLog" WHERE "tenantId" = $1 AND "recordType" = 'PeopleSettings' AND "recordId" = $2 AND after ? 'standardReview' ORDER BY at, id`, [T, companyA])
    expect(rows.map((row) => row.after.standardReview)).toEqual([{ tolerancePercent: 40, minBundles: 5 }, { tolerancePercent: 10, minBundles: 5 }])
  })

  it('a decision is a person\'s, with a reason, and is refused to whoever only reads', async () => {
    const body = { siteId: siteA1, decision: 'KEEP', reason: 'Made-up: new thread this week.', basedOn: null }
    await no('viewer', 'POST', decideUrl(ops.sew!.routing), body, 403)
    expect(pathOf(await no('reviewer', 'POST', decideUrl(ops.sew!.routing), { ...body, reason: ' ' }, 400))).toBe('body/reason')
    expect(pathOf(await no('reviewer', 'POST', decideUrl(ops.sew!.routing), { ...body, decision: 'CHANGE' }, 400))).toBe('body/proposedMinutes')
    await no('companyB', 'POST', decideUrl(ops.sew!.routing), body, 404)
    await no('reviewer', 'POST', decideUrl(newId()), body, 404)
  })

  it('an operation too few people worked on cannot be decided: the decision would keep their figure', async () => {
    const error = await no('reviewer', 'POST', decideUrl(ops.cut!.routing), { siteId: siteA1, decision: 'KEEP', reason: 'Made-up.', basedOn: null }, 409)
    expect(pathOf(error)).toBe('refusal/TOO_FEW_PEOPLE')
  })

  it('INVESTIGATE stays on the queue; KEEP closes it; the decisions are written down with who and why, and the event names nobody', async () => {
    const routing = ops.sew!.routing
    await ok('reviewer', 'POST', decideUrl(routing), { siteId: siteA1, decision: 'INVESTIGATE', reason: 'Made-up: the thread changed.', basedOn: null })
    const during = (await ok('viewer', 'GET', queueUrl)).queue.find((row: Json) => row.routingOperationId === routing)
    expect(during.reason).toBe('INVESTIGATING')
    expect(during.lastDecision.decision).toBe('INVESTIGATE')
    // Someone working from an old read does not overrule it unseen.
    expect(pathOf(await no('reviewer', 'POST', decideUrl(routing), { siteId: siteA1, decision: 'KEEP', reason: 'Made-up.', basedOn: null }, 409))).toBe('refusal/REVIEW_MOVED')
    const change = await ok('reviewer', 'POST', decideUrl(routing), { siteId: siteA1, decision: 'CHANGE', reason: 'Made-up: method changed.', proposedMinutes: '110.000', basedOn: during.lastDecision.id })
    expect(change).toMatchObject({ decision: 'CHANGE', proposedMinutes: '110.000', style: { revisionId: during.revisionId } })
    expect(change.words[0]).toContain('new routing revision')
    expect((await ok('viewer', 'GET', queueUrl)).queue.some((row: Json) => row.routingOperationId === routing)).toBe(false)
    const rows = await audits('people.decideStandardReview', routing)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ reason: 'Made-up: method changed.', after: { decision: 'CHANGE', proposedMinutes: '110.000' } })
    expect(Number(rows[1]!.after.actualMinutes)).toBeGreaterThan(ops.sew!.standard)
    expectNobody(rows)
    const events = await admin('SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id', [T, 'standard_review.decided'])
    expect(events.map((event) => event.payload)).toEqual([expect.objectContaining({ decision: 'INVESTIGATE' }), expect.objectContaining({ decision: 'CHANGE' })])
    expectNobody(events)
    const detail = await ok('viewer', 'GET', `/people/efficiency/operations/${routing}?siteId=${siteA1}`)
    expect(detail.history.map((row: Json) => row.decision)).toEqual(['CHANGE', 'INVESTIGATE'])
    expect(detail.history[0]).toMatchObject({ reason: 'Made-up: method changed.', proposedMinutes: '110.000' })
    expect(detail.review).toMatchObject({ reason: null, lastDecision: { decision: 'CHANGE' } })
  })

  it('a decided operation does not come back on bundles older than the decision', async () => {
    const routing = ops.sew!.routing
    const sew = ops.sew!.standard * 1.3
    // Five more bundles off the standard, reported before the decision (the clock says yesterday).
    const yesterday = plusDays(today, -1)
    for (const [who, start] of [['A', '06:30'], ['B', '06:31'], ['C', '06:32'], ['B', '12:31'], ['C', '12:32']] as const) await timed({ op: 'sew', who, station: who === 'B' ? sew2 : sew1, tablet: who === 'B' ? tablets.sew2! : tablets.sew!, day: yesterday, start, minutes: sew, pieces: 1 })
    expect((await ok('viewer', 'GET', queueUrl)).queue.some((row: Json) => row.routingOperationId === routing)).toBe(false)
  })

  it('SEND puts an operation on the queue by hand, no reason needed', async () => {
    const routing = ops.sew!.routing
    const last = (await ok('viewer', 'GET', `/people/efficiency/operations/${routing}?siteId=${siteA1}`)).review.lastDecision
    await ok('reviewer', 'POST', decideUrl(routing), { siteId: siteA1, decision: 'SEND', basedOn: last.id })
    expect((await ok('viewer', 'GET', queueUrl)).queue.find((row: Json) => row.routingOperationId === routing)).toMatchObject({ reason: 'SENT', lastDecision: { decision: 'SEND' } })
  })
})

describe('one person\'s figures (MES-247; Statuto art. 4 c.1; Owner answer H3)', () => {
  const url = (employeeId: string) => `/people/efficiency/people/${employeeId}/figures`
  const body = { siteId: siteA1, from: FROM, to: TO, reason: 'PAY_QUERY' }

  it('gate off (the default): no answer at all, and the same refusal for a person who exists and for one who does not', async () => {
    expect((await ok('viewer', 'GET', `/people/efficiency?${scope}`)).individual.available).toBe(false)
    const real = await no('hr', 'POST', url(people.A!.employee), body, 409)
    const invented = await no('hr', 'POST', url(newId()), body, 409)
    expect(pathOf(real)).toBe('gate/PERFORMANCE')
    expect({ code: invented.code, message: invented.message, issues: invented.issues }).toEqual({ code: real.code, message: real.message, issues: real.issues })
    expect(await audits('people.openPersonFigures', people.A!.employee)).toEqual([])
  })

  it('gate off: not even the worker, who reads their own on the floor once it is on', async () => {
    expect(pathOf(await no('self', 'POST', url(people.A!.employee), { siteId: siteA1 }, 409))).toBe('gate/PERFORMANCE')
  })

  it('no permission: refused before anything; another company\'s site is not found', async () => {
    await no('viewer', 'POST', url(people.A!.employee), body, 403)
    SESSIONS.hrB = office([grant(['people.figures.view'], [companyB])])
    await no('hrB', 'POST', url(people.A!.employee), body, 404)
  })

  it('gate on: HR with a purpose sees the days; the opening is recorded with who, whose, purpose and why', async () => {
    await openGate('PERFORMANCE')
    expect(pathOf(await no('hr', 'POST', url(people.A!.employee), { siteId: siteA1, from: FROM, to: TO }, 400))).toBe('body/reason')
    const answer = await ok('hr', 'POST', url(people.A!.employee), { ...body, note: 'Made-up: asked at the desk.' })
    expect(answer).toMatchObject({ as: 'FIGURE_ROLE', recorded: true, denominator: 'TIMED_MINUTES', person: { employeeId: people.A!.employee, name: people.A!.name } })
    const day1 = answer.days.find((day: Json) => day.date === D1)
    expect(Number(day1.efficiency)).toBeCloseTo(100 / 1.3, 0)
    expect(answer.words[0]).toContain('recorded')
    const rows = await audits('people.openPersonFigures', people.A!.employee)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actorId: hrUser, reason: 'Made-up: asked at the desk.', after: { purpose: 'PERFORMANCE', as: 'FIGURE_ROLE', reason: 'PAY_QUERY' } })
  })

  it('H3: nothing to compare with: no rank, no average, no other person, and not built on attended minutes (GDPR art. 5(1)(b))', async () => {
    const answer = await ok('hr', 'POST', url(people.B!.employee), body)
    const text = JSON.stringify(answer)
    for (const other of ['A', 'C', 'D', 'T', 'Z']) {
      expect(text).not.toContain(people[other]!.employee)
      expect(text).not.toContain(people[other]!.name)
    }
    expect(text).not.toMatch(/"(rank|average|percentile|target|attendedMinutes)"/i)
    expect(Object.keys(answer.days[0]).sort()).toEqual(['date', 'earnedMinutes', 'efficiency', 'offStandardMinutes', 'pieces', 'timedEarnedMinutes', 'timedMinutes'])
  })

  it('the worker reads their own without a reason', async () => {
    expect(await ok('self', 'POST', url(people.A!.employee), { siteId: siteA1, from: FROM, to: TO })).toMatchObject({ as: 'SELF' })
  })

  it('a person of nobody\'s business, and a person who does not exist, get the same refusal', async () => {
    const someone = await no('figuresOnly', 'POST', url(people.A!.employee), body, 403)
    const nobody = await no('figuresOnly', 'POST', url(newId()), body, 403)
    expect(pathOf(someone)).toBe('figures/NOT_ALLOWED')
    expect({ message: nobody.message, issues: nobody.issues }).toEqual({ message: someone.message, issues: someone.issues })
  })

  it('H3: a team lead is refused even where the site lets leads see figures', async () => {
    await closeGate('PERFORMANCE')
    await openGate('PERFORMANCE', true)
    expect(pathOf(await no('lead', 'POST', url(people.B!.employee), body, 403))).toBe('figures/NOT_ALLOWED')
    const lead = await ok('hr', 'POST', url(people.B!.employee), body)
    expect(lead.as).toBe('FIGURE_ROLE')
  })

  it('a trainee\'s days are left out and said; a team\'s work is not one person\'s', async () => {
    const trainee = await ok('hr', 'POST', url(people.T!.employee), body)
    expect(trainee.days).toEqual([])
    expect(trainee.leftOut.traineeDays).toBe(1)
    await timed({ op: 'sew', who: 'C', station: sew2, tablet: tablets.sew2!, day: D3, start: '12:00', minutes: 30, team: ['C', 'B'] })
    const shared = await ok('hr', 'POST', url(people.C!.employee), body)
    expect(shared.leftOut.sharedReports).toBe(1)
  })

  it('the figures are not kept in the idempotency receipt, and a repeated key after the gate closed gives nothing', async () => {
    const repeat = `e-${run}-repeat`
    expect((await call('hr', 'POST', url(people.C!.employee), body, repeat)).statusCode).toBe(200)
    const receipts = await admin('SELECT response FROM "IdempotencyReceipt" WHERE "tenantId" = $1 AND key = $2', [T, repeat])
    expect(receipts).toHaveLength(1)
    expect(JSON.stringify(receipts[0]!.response)).not.toMatch(/days|efficiency|earnedMinutes/)
    await closeGate('PERFORMANCE')
    const again = await call('hr', 'POST', url(people.C!.employee), body, repeat)
    expect(again.statusCode).toBe(409)
    expect(pathOf(again.json().error)).toBe('gate/PERFORMANCE')
  })

  it('a site that records stations has no person\'s figures', async () => {
    await openGate('PERFORMANCE')
    await admin(`UPDATE "ProductionSettings" SET "scanSubject" = 'STATION' WHERE id = $1`, [siteA1])
    expect(pathOf(await no('hr', 'POST', url(people.A!.employee), body, 409))).toBe('refusal/STATION_SITE')
    await admin(`UPDATE "ProductionSettings" SET "scanSubject" = 'WORKER' WHERE id = $1`, [siteA1])
  })
})

describe('the role templates', () => {
  it('nobody holds one person\'s figures by template; the manager decides the review, the supervisor reads', async () => {
    const { templateOf } = await import('@nexus/factory-domain/auth/roles/templates')
    expect(templateOf('production_manager')!.permissions).toEqual(expect.arrayContaining(['people.efficiency.view', 'people.efficiency.review']))
    expect(templateOf('floor_supervisor')!.permissions).toContain('people.efficiency.view')
    expect(templateOf('floor_supervisor')!.permissions).not.toContain('people.efficiency.review')
    for (const key of ['production_manager', 'floor_supervisor', 'admin']) expect(templateOf(key)!.permissions).not.toContain('people.figures.view')
  })
})
