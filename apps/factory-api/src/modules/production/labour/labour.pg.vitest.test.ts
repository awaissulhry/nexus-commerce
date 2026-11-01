import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPin } from '@nexus/factory-domain/auth/floor/pin'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedLabour, type LabourSeed } from '../../../../../../packages/factory-db/seed/labour'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seed as seedTime } from '../../../../../../packages/factory-db/seed/time'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * Labour records and corrections (B-W2b-45; MES-201 the labour record per scan, MES-202 the operator's daily sheet,
 * MES-203 close the day per line, MES-204 the changes to labour and attendance records, MES-205 workers see their own
 * records, MES-206 dispute an entry) through the app's real routes on a throwaway PostgreSQL 17 database from the
 * migrations (runtime and floor logins: row-level security, the grants and the …_floor_work_w2b_guards triggers are
 * real), on the factory-db seeds up to floor work and attendance: plant A1 names workers (its operator acknowledged the
 * notice), line L1's 16 Nov CLOSED, 17 Nov's waiting block PENDING with the operator's dispute UPHELD, an OPEN dispute of
 * the sewing report, a correction request waiting; the operator's 28 Oct attendance day with two open anomalies. The
 * cutting tablet is moved to show line L1 (a station-less LINE tablet, B-W2b-52), so the seeded reports are L1's. A real
 * operator signed in with the PIN on an enrolled tablet at SEW-01 for My day. Every name and value is made up. The law
 * the tests name: Statuto dei Lavoratori (L. 300/1970) art. 4 c.1 — no list, filter or total by person, one person's
 * figures only behind the site's PERFORMANCE legal gate (off by default); GDPR arts. 15-16 — the worker always reads and
 * disputes their own records. Run with `node scripts/factory/run-pg-tests.mjs modules/production/labour`.
 */

let h: Harness
let app: FastifyInstance
let labour: LabourSeed

const NS = 'w2b45-labour'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const companyB = idOf('company:B')
const siteA1 = idOf('site:A1')
const lineL1 = idOf('site:A1:line:L1')
const sew1 = idOf('site:A1:station:SEW-01')
const operator = idOf('worker:A1:operator')
const cuttingTablet = idOf('device:A1:cutting')
const OPERATOR_NAME = 'Seed Worker A1-1'
const TENANT: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'A' }, { id: companyB, code: 'B' }] }
const PIN = '573914'
const actors = { manager: newId(), supervisor: newId(), operatorUser: newId() }

const LABOUR: Permission[] = ['production.labour.view', 'production.labour.close', 'production.labour.reopen', 'production.labour.answer']
const OFFSTD: Permission[] = ['production.offstandard.view', 'production.offstandard.approve']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (grants: Grant[], actorId: string = newId()): SessionContext => ({ audience: 'office', tenantId: T, actorId, grants })
const SESSIONS: Record<string, SessionContext> = {
  manager: office([grant([...LABOUR, ...OFFSTD])], actors.manager),
  supervisor: office([grant(['production.labour.view', 'production.labour.close', 'production.labour.answer', ...OFFSTD])], actors.supervisor),
  viewer: office([grant(['production.labour.view'])]),
  companyB: office([grant(LABOUR, [companyB])]),
  noRight: office([grant(['workorders.view'])]),
  operatorUser: office([grant(['production.labour.view', 'production.labour.answer'])], actors.operatorUser),
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
const outbox = async (type: string, subject: string) => admin('SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 AND subject = $3 ORDER BY "occurredAt", id', [T, type, subject])
const codeId = async (code: string) => (await admin<{ id: string }>('SELECT id FROM "OffStandardCode" WHERE "tenantId" = $1 AND "companyId" = $2 AND code = $3', [T, companyA, code]))[0]!.id
const at = (iso: string) => new Date(iso).toISOString()

async function openGate(purpose: 'PERFORMANCE' | 'ATTENDANCE'): Promise<void> {
  const notice = (await admin<{ id: string }>(`SELECT id FROM "PrivacyNotice" WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = 'WORKER_FLOOR' AND status = 'PUBLISHED'`, [T, companyA]))[0]!.id
  const dpia = (await admin<{ id: string }>(`SELECT id FROM "PrivacyDpia" WHERE "tenantId" = $1 AND "companyId" = $2 AND status = 'STORED'`, [T, companyA]))[0]!.id
  await admin(
    `INSERT INTO "PeopleLegalGate" (id, "tenantId", "companyId", "siteId", purpose, basis, "basisReference", "noticeId", "dpiaId", "switchedOnAt", "switchedOnById", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, 'SAMPLE - made-up basis for the test', $7, $8, now() - interval '1 minute', $9, now())`,
    [newId(), T, companyA, siteA1, purpose, purpose === 'PERFORMANCE' ? 'UNION_AGREEMENT' : 'NOT_REQUIRED', notice, dpia, actors.manager],
  )
}

let hrUserId = ''
let tablet: Browser
const tabletPost = (url: string, body: unknown) => tablet.post(url, body, { headers: { 'idempotency-key': key() } })

beforeAll(async () => {
  h = await startHarness('labour')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedPrivacy({ db: h.database, namespace: NS })
  labour = await seedLabour({ db: h.database, namespace: NS })
  await seedTime({ db: h.database, namespace: NS })
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  // The cutting tablet shows line L1 (a LINE tablet at no station): the seeded reports it sent are L1's.
  await admin(`UPDATE "Device" SET "stationId" = NULL, mode = 'LINE', "lineId" = $2 WHERE id = $1`, [cuttingTablet, lineL1])
  // The operator is also a made-up office user, the employee E1's.
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, "updatedAt") VALUES ($1, $2, $3, 'Made-up Operator (office)', 'ACTIVE', now())`, [actors.operatorUser, T, `operator-${run}@example.test`])
  await admin('UPDATE "Worker" SET "userId" = $2 WHERE id = $1', [operator, actors.operatorUser])
  await admin('UPDATE "Employee" SET "userId" = $2 WHERE id = (SELECT "employeeId" FROM "Worker" WHERE id = $1)', [operator, actors.operatorUser])
  // HR: a made-up custom role that may open one person's figures (named in People settings later), over company A.
  hrUserId = (await addUser(h, TENANT, { email: `hr-${run}@example.test` })).id
  const roleId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
    await client.role.create({ data: { id: roleId, key: 'custom.hr', name: 'HR', permissions: ['people.figures.view', 'production.labour.view'], grains: [], requireMfa: false, audience: 'OFFICE' } })
    await client.roleAssignment.create({ data: { id: newId(), userId: hrUserId, roleId, allCompanies: false, companyIds: [companyA], siteIds: [], validFrom: new Date('2026-10-01T00:00:00.000Z') } })
  })
  SESSIONS.hr = office([grant(['people.figures.view', 'production.labour.view'], [companyA])], hrUserId)
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  // A tablet at SEW-01 (line L1), enrolled by a floor supervisor; the operator signs in with the PIN (My day's step-up).
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

describe('the labour record per scan with its minutes (MES-201)', () => {
  it('answers what stands of a report, its standard minutes earned, its correction waiting and its dispute; never who while the gate is off', async () => {
    const [undoneId, undoId, standingId] = labour.production.scanIds
    const record = (await ok('viewer', 'GET', `/production/labour/records/${standingId}`)).record
    expect(record).toMatchObject({ scanId: standingId, state: 'STANDING', workDate: '2026-11-17', counts: { good: 2, scrap: 0, rework: 0 }, earnedMinutes: '193.000', operation: { seq: 20, standardMinutes: '96.5' }, line: { id: lineL1, code: 'L1' }, correctionsWaiting: 1, worker: null, workerHidden: true })
    expect(record.disputes).toEqual([expect.objectContaining({ id: labour.disputeIds[0], status: 'OPEN' })])
    expect(JSON.stringify(record)).not.toContain(OPERATOR_NAME)
    // An undo voids it: nothing of it counts; its undo answers the same record.
    const undone = (await ok('viewer', 'GET', `/production/labour/records/${undoId}`)).record
    expect(undone).toMatchObject({ scanId: undoneId, state: 'UNDONE', standingScanId: null, counts: { good: 0 }, earnedMinutes: '0.000', reported: { good: 1 } })
    expect(undone.steps).toEqual([expect.objectContaining({ scanId: undoId, kind: 'UNDO', reason: 'Scanned the wrong bundle.' })])
    await no('companyB', 'GET', `/production/labour/records/${standingId}`, undefined, 404)
    await no('noRight', 'GET', `/production/labour/records/${standingId}`, undefined, 403)
  })
})

describe('one queue and its tiles, never who (design "To decide")', () => {
  it('lists the correction waiting, the open dispute and the waiting block, oldest first, with no person; the tiles count them', async () => {
    const answer = await ok('viewer', 'GET', `/production/labour/inbox?siteId=${siteA1}`)
    const byKind = (kind: string) => answer.items.filter((item: Json) => item.kind === kind)
    expect(byKind('CORRECTION')).toEqual([expect.objectContaining({ line: expect.objectContaining({ id: lineL1 }), workDate: '2026-11-17', recordId: labour.production.scanIds[2], named: true })])
    expect(byKind('CORRECTION')[0].changes.length).toBeGreaterThan(0)
    expect(byKind('DISPUTE').map((item: Json) => item.id)).toEqual([labour.disputeIds[0]])
    expect(byKind('OFF_STANDARD').map((item: Json) => item.id)).toContain(labour.blockIds[0])
    const text = JSON.stringify(answer)
    expect(text).not.toContain(OPERATOR_NAME)
    expect(text).not.toContain(operator)
    expect(text).not.toMatch(/workerId|employeeId|"worker"/)
    const counts = await ok('viewer', 'GET', `/production/labour/counts?siteId=${siteA1}`)
    expect(counts).toMatchObject({ corrections: byKind('CORRECTION').length, disputes: byKind('DISPUTE').length, offStandard: byKind('OFF_STANDARD').length })
    expect((await ok('viewer', 'GET', `/production/labour/inbox?kind=DISPUTE`)).items.every((item: Json) => item.kind === 'DISPUTE')).toBe(true)
    await no('noRight', 'GET', '/production/labour/inbox', undefined, 403)
    expect((await ok('companyB', 'GET', '/production/labour/inbox')).items).toEqual([])
  })
})

describe("closing a line's day (MES-203)", () => {
  let typed: Json

  it("shows each line's day with what holds it, in words: blocks to code, corrections, disputes, attendance anomalies", async () => {
    const days = (await ok('viewer', 'GET', `/production/labour/days?siteId=${siteA1}&from=2026-11-15&to=2026-11-18`)).days as Json[]
    const of = (day: string) => days.find((row) => row.line.id === lineL1 && row.workDate === day)
    expect(of('2026-11-16')).toMatchObject({ state: 'CLOSED', labourDayId: labour.labourDayId })
    expect(of('2026-11-17')).toMatchObject({ state: 'OPEN', records: 2, offStandard: { coded: false, left: 1 }, anomalies: 2 })
    expect(of('2026-11-17')!.blockers.map((row: Json) => [row.kind, row.count])).toEqual([
      ['OFF_STANDARD_WAITING', 1],
      ['CORRECTION_WAITING', 1],
      ['DISPUTE_OPEN', 1],
    ])
    expect(JSON.stringify(days)).not.toContain(OPERATOR_NAME)
    await no('viewer', 'GET', `/production/labour/days?from=2026-01-01&to=2026-12-31`, undefined, 400)
  })

  it('holds the close while a block waits and attendance anomalies are open; closes once they are cleared (feeds pay)', async () => {
    // The office types a waiting block for the operator on 28 Oct (made up), the day the operator's attendance has two open anomalies.
    typed = (await ok('manager', 'POST', '/production/offstandard/blocks', { siteId: siteA1, codeId: await codeId('WAIT_MATERIAL'), workerId: operator, stationId: sew1, startedAt: at('2026-10-28T10:00:00Z'), endedAt: at('2026-10-28T10:20:00Z') }, 201)).block
    const held = (await ok('viewer', 'GET', `/production/labour/days/${lineL1}/2026-10-28`)).day
    expect(held).toMatchObject({ state: 'OPEN', canClose: false, offStandard: { coded: false, left: 1 } })
    expect(held.blockers.map((row: Json) => [row.kind, row.count])).toEqual([
      ['OFF_STANDARD_WAITING', 1],
      ['ATTENDANCE_ANOMALY', 2],
    ])
    const refused = await no('supervisor', 'POST', `/production/labour/days/${lineL1}/2026-10-28/close`, {}, 409)
    expect(refusalOf(refused)).toBe('refusal/HELD')
    expect(refused.message).toBe('The day 2026-10-28 of line L1 closes once its off-standard time is coded and its anomalies are cleared: 1 off-standard block waiting for approval, 2 attendance anomalies to fix.')
    await ok('supervisor', 'POST', `/production/offstandard/blocks/${typed.id}/approve`, { version: typed.version })
    // The attendance anomalies are fixed (People › Attendance, B-W2b-37: made up here).
    await admin(`UPDATE "AttendanceAnomaly" SET resolution = 'FIXED', "resolvedAt" = now(), "resolvedById" = $2, version = version + 1 WHERE "tenantId" = $1 AND "resolvedAt" IS NULL AND "dayId" IN (SELECT id FROM "AttendanceDay" WHERE date = '2026-10-28')`, [T, actors.manager])
    const ready = (await ok('supervisor', 'GET', `/production/labour/days/${lineL1}/2026-10-28`)).day
    expect(ready).toMatchObject({ state: 'READY', canClose: true, canReopen: false, blockers: [] })
    await no('viewer', 'POST', `/production/labour/days/${lineL1}/2026-10-28/close`, {}, 403)
    await no('companyB', 'POST', `/production/labour/days/${lineL1}/2026-10-28/close`, {}, 404)
    const closed = (await ok('supervisor', 'POST', `/production/labour/days/${lineL1}/2026-10-28/close`, { note: 'Line day checked.' })).day
    expect(closed).toMatchObject({ state: 'CLOSED', closedBy: { id: actors.supervisor }, note: 'Line day checked.', canClose: false, history: [expect.objectContaining({ change: 'CLOSED' })] })
    expect((await outbox('labour_day.closed', closed.labourDayId))[0]!.payload).toEqual({ labourDayId: closed.labourDayId, siteId: siteA1, lineId: lineL1, workDate: '2026-10-28' })
    expect(refusalOf(await no('supervisor', 'POST', `/production/labour/days/${lineL1}/2026-10-28/close`, {}, 409))).toBe('refusal/ALREADY_CLOSED')
    expect(refusalOf(await no('supervisor', 'POST', `/production/labour/days/${lineL1}/2027-01-04/close`, {}, 409))).toBe('refusal/NOT_YET')
    // Nothing of the closed day's blocks changes now (off-standard's own refusal, the same rule).
    expect(refusalOf(await no('manager', 'POST', `/production/offstandard/blocks/${typed.id}/reopen`, { version: typed.version + 1, reason: 'Check it again.' }, 409))).toBe('refusal/DAY_CLOSED')
  })
})

describe('the worker reads their own records and disputes one (MES-205, MES-206; GDPR arts. 15-16)', () => {
  let raised: Json

  it("shows the operator's reports, blocks, disputes and changes, whatever the gate says; the minutes only behind it", async () => {
    const mine = await tablet.get('/production/labour/floor/mine?from=2026-11-16&to=2026-11-17')
    expect(mine.status, JSON.stringify(mine.body)).toBe(200)
    const body = mine.body as Json
    expect(body).toMatchObject({ subject: 'WORKER', minutesShown: false })
    expect(body.records.map((row: Json) => [row.scanId, row.state, row.minutes, row.disputable])).toEqual([
      [labour.production.scanIds[0], 'UNDONE', null, false],
      [labour.production.scanIds[2], 'STANDING', null, true],
    ])
    expect(body.records[1].dispute).toEqual({ id: labour.disputeIds[0], status: 'OPEN' })
    expect(body.blocks.map((row: Json) => [row.id, row.status])).toEqual([
      [labour.blockIds[1], 'APPROVED'],
      [labour.blockIds[0], 'PENDING'],
    ])
    expect(body.disputes.map((row: Json) => row.status).sort()).toEqual(['OPEN', 'UPHELD'])
    expect(body.edits).toEqual([expect.objectContaining({ id: labour.labourEditId, disputeId: labour.disputeIds[1], changes: [expect.objectContaining({ field: 'startedAt' })] })])
    expect(body.reasons.OperationScan).toEqual(['WRONG_QUANTITY', 'NOT_ME', 'WRONG_OPERATION', 'OTHER'])
  })

  it('disputes their own block after the day closed (once: a second tap answers it); refuses an undone report', async () => {
    const answer = await tabletPost('/production/labour/floor/disputes', { clientEventId: `dispute-${run}-1`, recordType: 'OffStandardEntry', recordId: (await admin<{ id: string }>(`SELECT id FROM "OffStandardEntry" WHERE "tenantId" = $1 AND "workDate" = '2026-10-28' AND "workerId" = $2`, [T, operator]))[0]!.id, reason: 'WRONG_TIME', message: 'I waited until 10:15, not 10:20.' })
    expect(answer.status, JSON.stringify(answer.body)).toBe(201)
    raised = (answer.body as Json).dispute
    expect(raised).toMatchObject({ status: 'OPEN', reason: 'WRONG_TIME', words: 'I waited until 10:15, not 10:20.', workDate: '2026-10-28' })
    const stored = (await admin('SELECT "workerId", "employeeId", "lineId", message, "deviceId" FROM "LabourDispute" WHERE id = $1', [raised.id]))[0]!
    expect(stored).toMatchObject({ workerId: operator, lineId: lineL1, message: 'WRONG_TIME: I waited until 10:15, not 10:20.' })
    expect(stored.employeeId).not.toBeNull()
    expect((await outbox('labour_dispute.raised', raised.id))[0]!.payload).toEqual({ disputeId: raised.id, siteId: siteA1, lineId: lineL1, workDate: '2026-10-28', recordType: 'OffStandardEntry' })
    const again = await tabletPost('/production/labour/floor/disputes', { clientEventId: `dispute-${run}-2`, recordType: 'OffStandardEntry', recordId: raised.recordId, reason: 'OTHER', message: 'Again.' })
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ existing: true, dispute: { id: raised.id } })
    const undone = await tabletPost('/production/labour/floor/disputes', { clientEventId: `dispute-${run}-3`, recordType: 'OperationScan', recordId: labour.production.scanIds[0], reason: 'NOT_ME' })
    expect(undone.status).toBe(409)
    expect((undone.body as Json).error.issues[0].path).toBe('refusal/NOT_DISPUTABLE')
    const wrongTile = await tabletPost('/production/labour/floor/disputes', { clientEventId: `dispute-${run}-4`, recordType: 'OperationScan', recordId: labour.production.scanIds[2], reason: 'WRONG_CODE' })
    expect(wrongTile.status).toBe(400)
  })

  it("is answered by the team leader or HR, never by the worker; an upheld block dispute corrects it once its day is reopened", async () => {
    const office = (await ok('supervisor', 'GET', `/production/labour/disputes/${raised.id}`)).dispute
    expect(office).toMatchObject({ status: 'OPEN', reason: 'WRONG_TIME', worker: null, workerHidden: true, raisedOn: 'FLOOR', canAnswer: true, own: false, record: { code: 'WAIT_MATERIAL', status: 'APPROVED' } })
    expect(JSON.stringify(office)).not.toContain(OPERATOR_NAME)
    // The worker's own office user never answers it.
    expect((await ok('operatorUser', 'GET', `/production/labour/disputes/${raised.id}`)).dispute).toMatchObject({ own: true, canAnswer: false })
    expect(refusalOf(await no('operatorUser', 'POST', `/production/labour/disputes/${raised.id}/answer`, { version: office.version, outcome: 'REJECTED', answer: 'No.' }, 409))).toBe('refusal/OWN_DISPUTE')
    const correction = { version: office.record.version, endedAt: at('2026-10-28T10:15:00Z') }
    // The day is closed (closed days feed pay): reopened first, with a reason.
    expect(refusalOf(await no('supervisor', 'POST', `/production/labour/disputes/${raised.id}/answer`, { version: office.version, outcome: 'UPHELD', answer: 'Right: 10:15.', correction }, 409))).toBe('refusal/DAY_CLOSED')
    await no('supervisor', 'POST', `/production/labour/days/${lineL1}/2026-10-28/reopen`, { version: 2, reason: 'A dispute is upheld.' }, 403)
    const day = (await ok('viewer', 'GET', `/production/labour/days/${lineL1}/2026-10-28`)).day
    await no('manager', 'POST', `/production/labour/days/${lineL1}/2026-10-28/reopen`, { version: day.version, reason: ' ' }, 400)
    const reopened = (await ok('manager', 'POST', `/production/labour/days/${lineL1}/2026-10-28/reopen`, { version: day.version, reason: 'A dispute is upheld.' })).day
    expect(reopened).toMatchObject({ state: 'OPEN', reopenedBy: { id: actors.manager }, reopenReason: 'A dispute is upheld.', closedAt: null })
    expect(reopened.history.map((row: Json) => row.change)).toEqual(['CLOSED', 'REOPENED'])
    expect(await outbox('labour_day.reopened', reopened.labourDayId)).toHaveLength(1)
    // A report's counts change through its correction, never here.
    expect(refusalOf(await no('supervisor', 'POST', `/production/labour/disputes/${labour.disputeIds[0]}/answer`, { version: 1, outcome: 'UPHELD', answer: 'Yes.', correction: { version: 1, endedAt: at('2026-10-28T10:15:00Z') } }, 400))).toBe('body/correction')
    const upheld = (await ok('supervisor', 'POST', `/production/labour/disputes/${raised.id}/answer`, { version: office.version, outcome: 'UPHELD', answer: 'Right: 10:15.', correction })).dispute
    expect(upheld).toMatchObject({ status: 'UPHELD', answer: 'Right: 10:15.', answeredBy: { id: actors.supervisor }, canAnswer: false, record: { endedAt: '2026-10-28T10:15:00.000Z' } })
    expect(upheld.edits).toEqual([expect.objectContaining({ by: expect.objectContaining({ id: actors.supervisor }), changes: [{ field: 'endedAt', from: '2026-10-28T10:20:00.000Z', to: '2026-10-28T10:15:00.000Z' }] })])
    const edit = (await admin('SELECT "disputeId", "createdById", before, after FROM "LabourEdit" WHERE "recordId" = $1', [raised.recordId]))[0]!
    expect(edit).toMatchObject({ disputeId: raised.id, createdById: actors.supervisor, before: { endedAt: '2026-10-28T10:20:00.000Z' }, after: { endedAt: '2026-10-28T10:15:00.000Z' } })
    expect((await outbox('labour_dispute.answered', raised.id))[0]!.payload).toEqual({ disputeId: raised.id, siteId: siteA1, lineId: lineL1, workDate: '2026-10-28', outcome: 'UPHELD', corrected: true })
    expect(refusalOf(await no('supervisor', 'POST', `/production/labour/disputes/${raised.id}/answer`, { version: upheld.version, outcome: 'REJECTED', answer: 'No.' }, 409))).toBe('refusal/DISPUTE_NOT_OPEN')
    // The worker sees the answer and the change on their records.
    const mine = (await tablet.get('/production/labour/floor/mine?from=2026-10-28&to=2026-10-28')).body as Json
    expect(mine.disputes.find((row: Json) => row.id === raised.id)).toMatchObject({ status: 'UPHELD', answer: 'Right: 10:15.' })
    expect(mine.edits.some((row: Json) => row.disputeId === raised.id)).toBe(true)
    // The seeded open dispute of the report is rejected in words.
    const seeded = (await ok('supervisor', 'GET', `/production/labour/disputes/${labour.disputeIds[0]}`)).dispute
    expect(seeded).toMatchObject({ recordType: 'OperationScan', reason: null, record: { counts: { good: 2 }, status: 'STANDING' } })
    expect((await ok('supervisor', 'POST', `/production/labour/disputes/${seeded.id}/answer`, { version: seeded.version, outcome: 'REJECTED', answer: 'The stain was found at sewing.' })).dispute).toMatchObject({ status: 'REJECTED' })
    // The day closes again once nothing is left open.
    expect((await ok('supervisor', 'POST', `/production/labour/days/${lineL1}/2026-10-28/close`, {})).day.state).toBe('CLOSED')
  })

  it('withdraws their own open dispute once', async () => {
    const block = (await ok('manager', 'POST', '/production/offstandard/blocks', { siteId: siteA1, codeId: await codeId('CLEANING'), workerId: operator, stationId: sew1, startedAt: at('2026-10-29T14:00:00Z'), endedAt: at('2026-10-29T14:15:00Z') }, 201)).block
    const made = await tabletPost('/production/labour/floor/disputes', { clientEventId: `dispute-${run}-5`, recordType: 'OffStandardEntry', recordId: block.id, reason: 'WRONG_CODE' })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const id = (made.body as Json).dispute.id
    const withdrawn = await tabletPost(`/production/labour/floor/disputes/${id}/withdraw`, { clientEventId: `withdraw-${run}-1` })
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200)
    expect((withdrawn.body as Json).dispute).toMatchObject({ status: 'WITHDRAWN' })
    const twice = await tabletPost(`/production/labour/floor/disputes/${id}/withdraw`, { clientEventId: `withdraw-${run}-2` })
    expect(twice.status).toBe(409)
    expect((await outbox('labour_dispute.withdrawn', id)).length).toBe(1)
  })
})

describe('every change keeps before and after, who, when and why (MES-204)', () => {
  it('reads labour edits as one timeline naming who changed them, never whose record; attendance only behind its gate', async () => {
    const edits = (await ok('viewer', 'GET', `/production/labour/edits?siteId=${siteA1}`)).edits as Json[]
    expect(edits.find((row) => row.id === labour.labourEditId)).toMatchObject({ kind: 'LABOUR_EDIT', recordType: 'OffStandardEntry', disputeId: labour.disputeIds[1], named: true, changes: [expect.objectContaining({ field: 'startedAt' })] })
    expect(edits.some((row) => row.kind === 'LABOUR_EDIT' && row.by?.id === actors.supervisor && row.changes[0]?.field === 'endedAt')).toBe(true)
    expect(JSON.stringify(edits)).not.toContain(OPERATOR_NAME)
    // The seeded clock events typed and voided by hand (October): none while the attendance purpose is off.
    expect((await ok('viewer', 'GET', `/production/labour/edits?siteId=${siteA1}&from=2026-10-01&to=2026-10-31&kind=CLOCK_EDIT`)).edits).toEqual([])
    await openGate('ATTENDANCE')
    const clock = (await ok('viewer', 'GET', `/production/labour/edits?siteId=${siteA1}&from=2026-10-01&to=2026-10-31&kind=CLOCK_EDIT`)).edits as Json[]
    expect(clock.length).toBeGreaterThan(0)
    expect(clock.every((row) => row.kind === 'CLOCK_EDIT' && row.reason && row.named && row.line === null)).toBe(true)
    expect((await ok('viewer', 'GET', `/production/labour/edits?lineId=${lineL1}&from=2026-10-01&to=2026-10-31&kind=CLOCK_EDIT`)).edits).toEqual([])
  })
})

describe("the operator's daily sheet, one person inside one record (MES-202; Statuto art. 4 c.1)", () => {
  const employee = async () => (await admin<{ employeeId: string }>('SELECT "employeeId" FROM "Worker" WHERE id = $1', [operator]))[0]!.employeeId

  it("refuses everyone while the site's PERFORMANCE gate is off, in words; behind it, HR opens it with a reason, logged", async () => {
    const e1 = await employee()
    const closed = await no('hr', 'POST', '/production/labour/sheets', { employeeId: e1, workDate: '2026-11-17', reason: 'PAY_QUERY' }, 409)
    expect(refusalOf(closed)).toBe('gate/PERFORMANCE')
    expect(refusalOf(await no('operatorUser', 'POST', '/production/labour/sheets', { employeeId: e1, workDate: '2026-11-17' }, 409))).toBe('gate/PERFORMANCE')
    await openGate('PERFORMANCE')
    // HR not named in People settings yet: not allowed.
    expect(refusalOf(await no('hr', 'POST', '/production/labour/sheets', { employeeId: e1, workDate: '2026-11-17', reason: 'PAY_QUERY' }, 403))).toBe('figures/NOT_ALLOWED')
    await admin(`UPDATE "PeopleSettings" SET "figureRoleKeys" = ARRAY['custom.hr'], version = version + 1 WHERE id = $1`, [companyA])
    expect(refusalOf(await no('hr', 'POST', '/production/labour/sheets', { employeeId: e1, workDate: '2026-11-17' }, 400))).toBe('body/reason')
    await no('viewer', 'POST', '/production/labour/sheets', { employeeId: e1, workDate: '2026-11-17', reason: 'PAY_QUERY' }, 404)
    const opened = await ok('hr', 'POST', '/production/labour/sheets', { employeeId: e1, workDate: '2026-11-17', reason: 'PAY_QUERY' })
    expect(opened).toMatchObject({ person: { employeeId: e1, name: OPERATOR_NAME }, as: 'FIGURE_ROLE', recorded: true, attendanceShown: true })
    expect(opened.sheet).toMatchObject({ workDate: '2026-11-17', pieces: { good: 2, scrap: 0, rework: 0 }, records: 1, productionMinutes: '193.000', offStandard: { minutes: 25, byCode: [expect.objectContaining({ code: 'WAIT_MATERIAL', minutes: 25, blocks: 1 })] } })
    expect(opened.sheet.exceptions.map((row: Json) => row.kind)).toEqual(['CORRECTION_WAITING', 'BLOCK_WAITING', 'RECORD_UNDONE'])
    expect(opened.records.map((row: Json) => row.state)).toEqual(['UNDONE', 'STANDING'])
    expect(opened.words[0]).toMatch(/This view is logged/)
    expect(JSON.stringify(opened.sheet)).not.toMatch(/pct|percent|efficien|pace|target|rank/i)
    const audit = await admin(`SELECT "actorId", "recordId", after FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'people.openPersonFigures' AND "recordId" = $2`, [T, e1])
    expect(audit).toEqual([expect.objectContaining({ actorId: hrUserId, after: expect.objectContaining({ purpose: 'PERFORMANCE', as: 'FIGURE_ROLE', reason: 'PAY_QUERY' }) })])
    // The worker opens their own, no reason asked.
    expect((await ok('operatorUser', 'POST', '/production/labour/sheets', { employeeId: e1, workDate: '2026-11-17' })).as).toBe('SELF')
  })

  it('names the worker on one record and shows the minutes on My day once the gate is on', async () => {
    expect((await ok('viewer', 'GET', `/production/labour/records/${labour.production.scanIds[2]}`)).record).toMatchObject({ worker: { id: operator, name: OPERATOR_NAME }, workerHidden: false })
    const mine = (await tablet.get('/production/labour/floor/mine?from=2026-11-17&to=2026-11-17')).body as Json
    expect(mine).toMatchObject({ minutesShown: true, words: [] })
    expect(mine.records.find((row: Json) => row.scanId === labour.production.scanIds[2]).minutes).toBe('193.000')
  })

  it('asks the PIN again on the tablet once the step-up window has passed (My day)', async () => {
    h.clock.advance(3 * 60_000)
    const late = await tablet.get('/production/labour/floor/mine')
    expect(late.status).toBe(403)
    expect((late.body as Json).error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
  })
})
