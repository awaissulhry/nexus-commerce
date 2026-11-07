import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPin } from '@nexus/factory-domain/auth/floor/pin'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addMonths } from '@nexus/factory-domain/safety/calendar/rules'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seed as seedHealth } from '../../../../../../packages/factory-db/seed/health'
import { seed as seedPeople, type PeopleSeed } from '../../../../../../packages/factory-db/seed/people'
import { seed as seedSafety, type SafetySeed } from '../../../../../../packages/factory-db/seed/safety'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * The training records (B-W2b-139; QHS-243, QHS-244, QHS-246, QHS-247, QHS-248) on the local stack: a throwaway PostgreSQL 17
 * database from the migrations (the runtime logins: row-level security and the training guards are real: a record is
 * append-only, an attendance signed by PIN only from a floor session with the person's own worker, a countersignature by PIN
 * only with the trainer's, a paper one only from the office), the real app. Tenant A from the factory-db seeds: A1's Cutter
 * (E1: general done at S0, specific-high expired), Machinist (E2 the trainer, E3); S1 open at A1 with E1's PIN attendance, SB
 * open at B1, S0 closed; E1's unsigned die-change entry. A real tablet at A1 with E2 (the team leader) signed in; E1 and E2
 * sign with their own PIN. Every name is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/safety/records`.
 */

let h: Harness
let app: FastifyInstance
let safety: SafetySeed
let people: PeopleSeed
let tablet: Browser

const NS = 'w2b139-records'
const idOf = (key: string): string => seedUuid(NS, key)
const T = {
  tenant: idOf('tenant'),
  companyA: idOf('company:A'),
  companyB: idOf('company:B'),
  siteA1: idOf('site:A1'),
  siteB1: idOf('site:B1'),
  e1Worker: idOf('worker:A1:operator'),
  e2Worker: idOf('worker:A1:lead'),
  device: idOf('device:A1:cutting'),
  pressClass: idOf('plant:class:CLICKING_PRESS'),
  postBedClass: idOf('plant:class:POST_BED'),
  press: idOf('plant:machine:SEED-CP-01'),
}
const TENANT: TestTenant = { id: T.tenant, slug: NS, companies: [{ id: T.companyA, code: 'A' }, { id: T.companyB, code: 'B' }] }
const PIN = '482913'
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const OFFICER: Permission[] = ['safety.view', 'safety.training.record', 'safety.instruction.record', 'files.upload']
const SESSIONS: Record<string, SessionContext> = {
  officer: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(OFFICER)] },
  viewer: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['safety.view'])] },
  preposto: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['safety.view', 'safety.instruction.record'])] },
  companyB: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(OFFICER, [T.companyB])] },
  authoriser: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['people.skills.view', 'people.authorisations.manage', 'safety.view'])] },
  sales: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['quotes.view'])] },
  floorE1: { audience: 'floor', tenantId: T.tenant, actorId: T.e1Worker, siteId: T.siteA1, deviceId: T.device, grants: [grant(['floor.work'], [T.companyA], [T.siteA1])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
let keys = 0
const key = () => `records-${++keys}-${newId()}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<string[]> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json().error.issues ?? []).map((issue: Json) => String(issue.path))
}
const floorPost = (url: string, body: unknown, idempotencyKey: string | null = key()) => tablet.post(url, body, idempotencyKey ? { headers: { 'idempotency-key': idempotencyKey } } : {})
const floorRefusal = (response: { body: Json }) => (response.body.error?.issues ?? []).map((issue: Json) => String(issue.path))
const today = businessDate(new Date())
const eventsOf = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [T.tenant, type])).map((row) => row.payload)
const auditOf = async (action: string) => admin<{ recordType: string; after: Json; reason: string | null }>(`SELECT "recordType", after, reason FROM "AuditLog" WHERE "tenantId" = $1 AND action = $2 ORDER BY at, id`, [T.tenant, action])

/** The session opened in the office for the floor's signatures (C below). */
let opened: Json

beforeAll(async () => {
  h = await startHarness('w2b139_records')
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedHealth({ db: h.database, namespace: NS })
  safety = await seedSafety({ db: h.database, namespace: NS })
  people = await seedPeople({ db: h.database, namespace: NS })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  // The letterhead of the PDFs: company A's made-up legal data.
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT00000000000', "fiscalCode" = '00000000000', "reaOffice" = 'RM', "reaNumber" = '000000', address = '{"line1":"Via Finta 1","postalCode":"00100","city":"Roma","country":"IT"}'::jsonb WHERE id = $1`, [T.companyA])
  // A real tablet at A1 (the floor's own sign-in): E2's worker (the team leader, the trainer) signed in; E1 and E2 have a PIN.
  const pinHash = await hashPin(PIN, h.auth.pins, { logN: 12, r: 8, p: 1 })
  await admin('UPDATE "Worker" SET "pinHash" = $2, "failedPinAttempts" = 0, "pinLockedUntil" = NULL WHERE id = ANY($1::uuid[])', [[T.e1Worker, T.e2Worker], pinHash])
  const owner = await addUser(h, TENANT, { email: `owner-${newId().slice(-6)}@example.test`, role: 'owner' })
  const office = new Browser(h.app)
  const signed = await office.signIn(TENANT.slug, owner.email, owner.password)
  if (signed.body.status !== 'signed_in') throw new Error(`sign-in: ${signed.status} ${JSON.stringify(signed.body)}`)
  await stepUp(h, office, await enrolTotp(h, office))
  const made = await office.post('/auth/floor/devices', { siteId: T.siteA1, name: 'Made-up training tablet' })
  if (made.status !== 200) throw new Error(`enrol: ${made.status} ${JSON.stringify(made.body)}`)
  tablet = new Browser(h.app)
  await tablet.get('/auth/csrf')
  const enrolled = await tablet.post('/floor/device/enrol', { code: made.body.enrolment.code, appVersion: '1.0.0' })
  if (enrolled.status !== 200) throw new Error(`exchange: ${enrolled.status} ${JSON.stringify(enrolled.body)}`)
  const signIn = await tablet.post('/floor/sign-in', { workerId: T.e2Worker, pin: PIN })
  if (signIn.status !== 200) throw new Error(`floor sign-in: ${signIn.status} ${JSON.stringify(signIn.body)}`)
}, 1_500_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('sessions in the office (QHS-248; design people.skills "Record training … from the floor sign-off")', () => {
  it('lists the sessions of the sites in reach with their counts; the record names the attendances and the words signed', async () => {
    const list = await ok('officer', 'GET', '/safety/training/sessions')
    expect(list).toMatchObject({ canOpen: true, complete: true })
    const s1 = list.sessions.find((session: Json) => session.id === safety.sessionIds.open)
    expect(s1).toMatchObject({ status: 'OPEN', stopped: null, course: { code: 'SEED-SC-SPEC-HIGH' }, trainer: { name: 'Seed Employee Two' }, counts: { signed: 1, countersigned: 0, voided: 0 }, canRecord: true })
    expect(list.sessions.find((session: Json) => session.id === safety.sessionIds.closed)).toMatchObject({ status: 'CLOSED', stopped: 'This session was closed in the office: signing has stopped.', counts: { signed: 2, countersigned: 2 }, canRecord: false })
    expect((await ok('companyB', 'GET', '/safety/training/sessions')).sessions.map((session: Json) => session.id)).toEqual([safety.sessionIds.b1])
    expect((await ok('viewer', 'GET', '/safety/training/sessions')).canOpen).toBe(false)
    expect((await call('sales', 'GET', '/safety/training/sessions')).statusCode).toBe(403)
    const record = await ok('viewer', 'GET', `/safety/training/sessions/${safety.sessionIds.open}`)
    expect(record.attendances).toMatchObject([{ id: safety.attendanceIds.e1Open, employee: { id: people.employeeIds.e1, name: 'Seed Employee One' }, method: 'FLOOR_PIN', verifiable: true, countersign: null, languageUnderstood: null }])
    expect(record.statements.attendance.it).toMatch(/art\. 37/)
    expect(record.law).toEqual({ training: 'D.Lgs. 81/2008 art. 37', language: 'D.Lgs. 81/2008 art. 37 c.13' })
    expect((await call('companyB', 'GET', `/safety/training/sessions/${safety.sessionIds.open}`)).statusCode).toBe(404)
  })

  it('opens a session at a site (201) with a trainer of the company; refuses another company’s trainer and impossible hours; edits it', async () => {
    const body = { siteId: T.siteA1, courseId: safety.courseIds.specificHigh, heldOn: today, hours: '12', language: 'it', trainerEmployeeId: people.employeeIds.e2, location: 'Made-up room' }
    expect(await no('officer', 'POST', '/safety/training/sessions', { ...body, trainerEmployeeId: people.employeeIds.eb1 }, 409)).toEqual(['refusal/TRAINER_NOT_AVAILABLE', 'body/trainerEmployeeId'])
    expect(await no('officer', 'POST', '/safety/training/sessions', { ...body, hours: '30' }, 400)).toEqual(['body/hours'])
    expect((await call('viewer', 'POST', '/safety/training/sessions', body)).statusCode).toBe(403)
    opened = (await ok('officer', 'POST', '/safety/training/sessions', body, 201)).session
    expect(opened).toMatchObject({ status: 'OPEN', siteId: T.siteA1, companyId: T.companyA, trainer: { employeeId: people.employeeIds.e2, name: 'Seed Employee Two' }, hours: '12', version: 1, counts: { signed: 0 } })
    opened = (await ok('officer', 'PATCH', `/safety/training/sessions/${opened.id}`, { version: 1, hours: '8', location: 'Cutting room' })).session
    expect(opened).toMatchObject({ hours: '8', location: 'Cutting room', version: 2 })
  })
})

describe('expired training holds a machine authorisation (B-W2b-39 finding, kind AUTHORISATION, STRICT)', () => {
  it('the office says the clicking press asks an authorisation; Authorise a machine lists its course and says it is held', async () => {
    const [press] = await admin<{ version: number }>('SELECT version FROM "MachineClass" WHERE id = $1', [T.pressClass])
    expect((await ok('authoriser', 'PUT', `/people/skills/machine-classes/${T.pressClass}/authorisation-rule`, { version: press!.version, required: true })).machineClass.authorisationRequired).toBe(true)
    const prerequisites = await ok('authoriser', 'GET', `/people/skills/authorisations/prerequisites?employeeId=${people.employeeIds.e1}&machineClassId=${T.pressClass}`)
    expect(prerequisites).toMatchObject({ trainingValid: false, held: true, fitness: null, training: [{ courseId: safety.courseIds.specificHigh, withinDays: null, state: 'EXPIRED', dueOn: today }] })
    const authorised = await ok('authoriser', 'POST', '/people/skills/authorisations', { employeeId: people.employeeIds.e1, machineClassId: T.pressClass }, 201)
    expect(authorised).toMatchObject({ held: true, words: 'Authorised on Clicking press machines from today, held until Specific training, high risk is valid.' })
  })

  it('every caller gets it: the office check and the tablet hold E1 at the press, never overridable; the matrix says Held', async () => {
    const office = (await ok('authoriser', 'GET', `/people/skills/check?employeeId=${people.employeeIds.e1}&machineId=${T.press}`)).check
    expect(office).toMatchObject({ outcome: 'NOT_QUALIFIED', decision: 'HOLD', overridable: false })
    expect(office.findings).toMatchObject([{ code: 'TRAINING_EXPIRED', kind: 'AUTHORISATION', mode: 'STRICT', overridable: false, requirement: 'CLICKING_PRESS' }])
    expect(office.findings[0].message).toMatch(/^Seed Employee One's Specific training, high risk, which Clicking press machines ask, expired on \d{4}-\d{2}-\d{2}: the authorisation is held\.$/)
    // The floor reads the courses and the records in its own scope (no trainer, reason or note column).
    const floor = await ok('floorE1', 'GET', `/people/skills/floor/check?machineId=${T.press}`)
    expect(floor).toMatchObject({ check: { decision: 'HOLD', person: { name: 'Seed Worker A1-1' }, findings: [{ code: 'TRAINING_EXPIRED' }] }, guard: { mode: 'STRICT', overridable: false } })
    const matrix = await ok('authoriser', 'GET', `/people/skills/matrix?siteId=${T.siteA1}`)
    const e1 = matrix.rows.find((row: Json) => row.employeeId === people.employeeIds.e1)
    expect(e1.authorisations).toMatchObject([{ machineClassId: T.pressClass, state: 'AUTHORISED', held: true, heldBy: [safety.courseIds.specificHigh] }])
    expect(e1.trainings.find((cell: Json) => cell.courseId === safety.courseIds.specificHigh)).toMatchObject({ state: 'EXPIRED', needed: true, required: true, overdue: true })
    expect(matrix.tiles.authorisationsHeld).toBe(1)
    expect(matrix.tiles.trainingOverdue).toBeGreaterThanOrEqual(1)
    expect((await ok('authoriser', 'GET', `/people/skills/matrix?siteId=${T.siteA1}&tile=AUTHORISATIONS_HELD`)).rows.map((row: Json) => row.employeeId)).toEqual([people.employeeIds.e1])
  })
})

describe('attendance signed on the floor and the session closed (QHS-248, QHS-247; design floor.training "Training attendance")', () => {
  it('the tablet lists its site’s open sessions; E1 signs with their own PIN; a wrong PIN, twice, another site are refused', async () => {
    const list = await tablet.get('/safety/floor/training/sessions')
    expect(list.status).toBe(200)
    expect(list.body.sessions.map((session: Json) => session.id)).toEqual(expect.arrayContaining([safety.sessionIds.open, opened.id]))
    expect(list.body.sessions.map((session: Json) => session.id)).not.toContain(safety.sessionIds.b1)
    expect((await floorPost(`/safety/floor/training/sessions/${opened.id}/sign`, { workerId: T.e1Worker, pin: '000000' })).status).toBe(401)
    expect((await floorPost(`/safety/floor/training/sessions/${opened.id}/sign`, { workerId: T.e1Worker, pin: PIN }, null)).status).toBe(400)
    const signed = await floorPost(`/safety/floor/training/sessions/${opened.id}/sign`, { workerId: T.e1Worker, pin: PIN })
    expect(signed.status, JSON.stringify(signed.body)).toBe(200)
    expect(signed.body).toMatchObject({ attendance: { worker: { id: T.e1Worker, displayName: 'Seed Worker A1-1' }, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }, signed: 1, countersigned: 0 })
    const [row] = await admin('SELECT method, "signedByWorkerId", "signatureSha256", "deviceId" FROM "TrainingAttendance" WHERE id = $1', [signed.body.attendance.id])
    expect(row).toMatchObject({ method: 'FLOOR_PIN', signedByWorkerId: T.e1Worker, signatureSha256: signed.body.attendance.sha256 })
    expect(floorRefusal(await floorPost(`/safety/floor/training/sessions/${opened.id}/sign`, { workerId: T.e1Worker, pin: PIN }))).toEqual(['refusal/ATTENDED_ALREADY'])
    expect((await floorPost(`/safety/floor/training/sessions/${safety.sessionIds.b1}/sign`, { workerId: T.e1Worker, pin: PIN })).status).toBe(404)
    // The list fills ("1 signed").
    const session = await tablet.get(`/safety/floor/training/sessions/${opened.id}`)
    expect(session.body).toMatchObject({ session: { signed: 1, stopped: null }, attendances: [{ displayName: 'Seed Worker A1-1', method: 'FLOOR_PIN', countersigned: false }], trainer: { workerId: T.e2Worker, countersignsHere: true } })
  })

  it('only the trainer countersigns, with their own PIN and the language check; once', async () => {
    const [attendance] = await admin<{ id: string }>('SELECT id FROM "TrainingAttendance" WHERE "sessionId" = $1', [opened.id])
    const lines = [{ attendanceId: attendance!.id, languageUnderstood: true }]
    expect(floorRefusal(await floorPost(`/safety/floor/training/sessions/${opened.id}/countersign`, { workerId: T.e1Worker, pin: PIN, attendances: lines }))).toEqual(['refusal/NOT_THE_TRAINER'])
    const countersigned = await floorPost(`/safety/floor/training/sessions/${opened.id}/countersign`, { workerId: T.e2Worker, pin: PIN, attendances: lines })
    expect(countersigned.status, JSON.stringify(countersigned.body)).toBe(200)
    expect(countersigned.body).toMatchObject({ attendanceIds: [attendance!.id], trainer: { id: T.e2Worker }, signed: 1, countersigned: 1 })
    expect(floorRefusal(await floorPost(`/safety/floor/training/sessions/${opened.id}/countersign`, { workerId: T.e2Worker, pin: PIN, attendances: lines }))[0]).toBe('refusal/COUNTERSIGNED_ALREADY')
    const [row] = await admin('SELECT "countersignMethod", "countersignedByWorkerId", "languageUnderstood" FROM "TrainingAttendance" WHERE id = $1', [attendance!.id])
    expect(row).toEqual({ countersignMethod: 'FLOOR_PIN', countersignedByWorkerId: T.e2Worker, languageUnderstood: true })
  })

  it('the office records the paper sheet and countersigns it; once people signed, the day and hours stay; refusals in words', async () => {
    const paper = await ok('officer', 'POST', `/safety/training/sessions/${opened.id}/paper`, { employeeIds: [people.employeeIds.e3] })
    expect(paper).toMatchObject({ attendances: [{ employee: { id: people.employeeIds.e3 }, method: 'PAPER', verifiable: false }], scan: { recordType: 'TrainingSession', recordId: opened.id } })
    expect(await no('officer', 'POST', `/safety/training/sessions/${opened.id}/paper`, { employeeIds: [people.employeeIds.e3] }, 409)).toEqual(['refusal/ATTENDED_ALREADY', 'body/employeeIds/0'])
    expect(await no('officer', 'POST', `/safety/training/sessions/${opened.id}/paper`, { employeeIds: [people.employeeIds.eb1] }, 409)).toEqual(['refusal/PERSON_OTHER_COMPANY', 'body/employeeIds/0'])
    expect(await no('officer', 'PATCH', `/safety/training/sessions/${opened.id}`, { version: 2, hours: '6' }, 409)).toEqual(['refusal/SIGNED_ALREADY'])
    opened = (await ok('officer', 'PATCH', `/safety/training/sessions/${opened.id}`, { version: 2, note: 'Made-up note' })).session
    expect((await no('officer', 'POST', `/safety/training/sessions/${opened.id}/close`, { version: opened.version }, 409))[0]).toBe('refusal/NOT_COUNTERSIGNED')
    const countersigned = await ok('officer', 'POST', `/safety/training/sessions/${opened.id}/countersign`, { method: 'PAPER', attendances: [{ attendanceId: paper.attendances[0].id, languageUnderstood: false }] })
    expect(countersigned.attendances).toMatchObject([{ countersign: { method: 'PAPER', onFloor: false }, languageUnderstood: false }])
    expect((await no('officer', 'POST', `/safety/training/sessions/${opened.id}/close`, { version: opened.version, results: [{ attendanceId: paper.attendances[0].id, result: 'PASSED' }] }, 409))[0]).toBe('refusal/LANGUAGE_NOT_UNDERSTOOD')
  })

  it('closes: one record per countersigned attendance, valid until its day plus the course’s period; not understood is FAILED; signing stops with the reason', async () => {
    const closed = await ok('officer', 'POST', `/safety/training/sessions/${opened.id}/close`, { version: opened.version })
    expect(closed.session).toMatchObject({ status: 'CLOSED', stopped: 'This session was closed in the office: signing has stopped.' })
    const byPerson = new Map(closed.records.map((record: Json) => [record.employeeId, record]))
    expect(byPerson.get(people.employeeIds.e1)).toMatchObject({ result: 'PASSED', validUntil: addMonths(today, 60), languageChecked: true })
    expect(byPerson.get(people.employeeIds.e3)).toMatchObject({ result: 'FAILED', validUntil: null, languageChecked: true })
    const [note] = await admin<{ note: string }>('SELECT note FROM "TrainingRecord" WHERE "sessionId" = $1 AND "employeeId" = $2', [opened.id, people.employeeIds.e3])
    expect(note!.note).toMatch(/art\. 37 c\.13/)
    const onTablet = await tablet.get(`/safety/floor/training/sessions/${opened.id}`)
    expect(onTablet.body.session).toMatchObject({ status: 'CLOSED', stopped: 'This session was closed in the office: signing has stopped.' })
    expect(floorRefusal(await floorPost(`/safety/floor/training/sessions/${opened.id}/sign`, { workerId: T.e2Worker, pin: PIN }))).toEqual(['refusal/SESSION_STOPPED'])
    expect((await no('officer', 'POST', `/safety/training/sessions/${opened.id}/cancel`, { version: closed.session.version, reason: 'Too late' }, 409))[0]).toBe('refusal/SESSION_STOPPED')
    // SB at B1 is cancelled with the reason (nothing came from it).
    const sb = (await ok('officer', 'GET', `/safety/training/sessions/${safety.sessionIds.b1}`)).session
    expect((await ok('officer', 'POST', `/safety/training/sessions/${safety.sessionIds.b1}/cancel`, { version: sb.version, reason: 'The trainer is ill (made-up)' })).session).toMatchObject({ status: 'CANCELLED', stopped: 'This session was cancelled: The trainer is ill (made-up). Signing has stopped.' })
  })

  it('with the course valid again, the press works for E1 and the matrix no longer says Held', async () => {
    expect((await ok('authoriser', 'GET', `/people/skills/check?employeeId=${people.employeeIds.e1}&machineId=${T.press}`)).check).toMatchObject({ decision: 'ALLOW', findings: [] })
    const matrix = await ok('authoriser', 'GET', `/people/skills/matrix?siteId=${T.siteA1}`)
    expect(matrix.rows.find((row: Json) => row.employeeId === people.employeeIds.e1).authorisations).toMatchObject([{ held: false, heldBy: [] }])
    expect(matrix.tiles.authorisationsHeld).toBe(0)
  })
})

describe('a person’s records, training given elsewhere, corrections, the record’s PDF (QHS-243, QHS-247)', () => {
  it('the person’s Safety training: records newest first with corrections named, a due cell per course, the instruction entries', async () => {
    const card = await ok('viewer', 'GET', `/safety/training/people/${people.employeeIds.e1}`)
    expect(card).toMatchObject({ employee: { name: 'Seed Employee One', roleSheet: { code: 'CUT' } }, canRecord: false, canInstruct: false, certificate: { recordType: 'TrainingRecord', kind: 'CERTIFICATE', companyId: T.companyA } })
    const firstAid = card.records.filter((record: Json) => record.course.id === safety.courseIds.firstAid)
    expect(firstAid.map((record: Json) => [record.standing, record.correctedBy !== null, record.corrects?.reason ?? null])).toEqual([
      [true, false, 'The course ended two days later (made-up).'],
      [false, true, null],
    ])
    const fromSession = card.records.find((record: Json) => record.session?.id === opened.id)
    expect(fromSession).toMatchObject({ result: 'PASSED', validity: 'VALID', signed: { method: 'FLOOR_PIN', countersignMethod: 'FLOOR_PIN' } })
    expect(card.records.find((record: Json) => record.id === safety.recordIds.e1Expired)).toMatchObject({ validity: 'EXPIRED', certificates: [{ kind: 'CERTIFICATE' }] })
    expect(card.cells.find((cell: Json) => cell.courseId === safety.courseIds.specificHigh)).toMatchObject({ state: 'VALID', needed: true, overdue: false })
    expect(card.instruction.map((entry: Json) => entry.id)).toEqual(expect.arrayContaining([safety.instructionIds.unsigned, safety.instructionIds.signed]))
    expect((await call('companyB', 'GET', `/safety/training/people/${people.employeeIds.e1}`)).statusCode).toBe(404)
  })

  it('records training given elsewhere for several people (201); another valid-until asks its reason; never by a reader', async () => {
    const body = { courseId: safety.courseIds.firstAid, completedOn: today, hours: '12', trainerName: 'Made-up Provider', language: 'it', people: [{ employeeId: people.employeeIds.e3, result: 'PASSED', languageChecked: false }, { employeeId: people.employeeIds.e2, result: 'FAILED', languageChecked: true }] }
    expect(await no('officer', 'POST', '/safety/training/records', { ...body, people: [{ ...body.people[0], validUntil: addMonths(today, 12) }] }, 400)).toEqual(['body/people/0/validUntilReason'])
    expect((await call('viewer', 'POST', '/safety/training/records', body)).statusCode).toBe(403)
    const recorded = await ok('officer', 'POST', '/safety/training/records', body, 201)
    expect(recorded.records.map((record: Json) => [record.employeeId, record.result, record.validUntil, record.languageChecked]).sort()).toEqual(
      [
        [people.employeeIds.e3, 'PASSED', addMonths(today, 36), false],
        [people.employeeIds.e2, 'FAILED', null, true],
      ].sort(),
    )
    expect(recorded.certificate).toMatchObject({ recordType: 'TrainingRecord', kind: 'CERTIFICATE', recordIds: recorded.records.map((record: Json) => record.id) })
    // Records are append-only: the database refuses a change.
    await expect(h.database.withScope({ audience: 'office', tenantId: T.tenant, actorId: newId() }, (client) => client.trainingRecord.update({ where: { id: recorded.records[0].id }, data: { hours: '1' } }))).rejects.toThrow()
  })

  it('a correction is a new record naming the one it corrects; once; never the same; VOID when it never happened', async () => {
    const card = await ok('officer', 'GET', `/safety/training/people/${people.employeeIds.e3}`)
    const firstAid = card.records.find((record: Json) => record.course.id === safety.courseIds.firstAid && record.standing)
    expect(await no('officer', 'POST', `/safety/training/records/${firstAid.id}/correct`, { reason: 'Nothing (made-up)' }, 409)).toEqual(['refusal/NOTHING_CHANGES'])
    const corrected = await ok('officer', 'POST', `/safety/training/records/${firstAid.id}/correct`, { reason: 'The trainer checked the language after all (made-up)', languageChecked: true })
    expect(corrected).toMatchObject({ record: { corrects: { id: firstAid.id }, languageChecked: true, validUntil: firstAid.validUntil, standing: true }, corrected: { id: firstAid.id, correctedBy: corrected.record.id, standing: false } })
    expect(await no('officer', 'POST', `/safety/training/records/${firstAid.id}/correct`, { reason: 'Again', hours: '10' }, 409)).toEqual(['refusal/CORRECTED_ALREADY'])
    const e2 = (await ok('officer', 'GET', `/safety/training/people/${people.employeeIds.e2}`)).records.find((record: Json) => record.course.id === safety.courseIds.firstAid && record.result === 'FAILED')
    const voided = await ok('officer', 'POST', `/safety/training/records/${e2.id}/correct`, { reason: 'Never attended (made-up)', result: 'VOID' })
    expect(voided.record).toMatchObject({ result: 'VOID', hours: '0', standing: false, validity: null })
    // A day set apart from the refresher period, with its reason, stays when the correction keeps the day.
    const supervisor = (await ok('officer', 'GET', `/safety/training/people/${people.employeeIds.e2}`)).records.find((record: Json) => record.course.id === safety.courseIds.supervisor)
    expect(supervisor.validUntilReason).not.toBeNull()
    const kept = await ok('officer', 'POST', `/safety/training/records/${supervisor.id}/correct`, { reason: 'The course lasted 16 hours (made-up)', hours: '16' })
    expect(kept.record).toMatchObject({ hours: '16', validUntil: supervisor.validUntil, validUntilReason: supervisor.validUntilReason })
  })

  it('the record as the register keeps it, as a PDF made in memory', async () => {
    const response = await call('viewer', 'GET', `/safety/training/records/${safety.recordIds.e1Expired}/pdf?language=en`)
    expect(response.statusCode, response.body).toBe(200)
    expect(response.headers['content-type']).toMatch(/application\/pdf/)
    expect(response.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
    expect((await call('companyB', 'GET', `/safety/training/records/${safety.recordIds.e1Expired}/pdf`)).statusCode).toBe(404)
  })
})

describe('due and overdue (QHS-244; tiles "Training overdue", "Due in 60 days", "Language not checked"; the due list PDF)', () => {
  it('one row per person × course by name, why it is needed; tiles count over everyone in reach and the search never narrows them', async () => {
    const due = await ok('officer', 'GET', '/safety/training/due')
    expect(due).toMatchObject({ view: 'due', canRecord: true, law: 'D.Lgs. 81/2008 art. 37' })
    const e2Medium = due.rows.find((row: Json) => row.employee.id === people.employeeIds.e2 && row.courseId === safety.courseIds.specificMedium)
    expect(e2Medium).toMatchObject({ employee: { name: 'Seed Employee Two' }, state: 'NEEDED', why: 'ROLE', required: true })
    expect(due.rows.every((row: Json) => row.overdue || row.soon)).toBe(true)
    expect(due.tiles.overdue).toBe(due.rows.filter((row: Json) => row.overdue).length)
    const searched = await ok('officer', 'GET', '/safety/training/due?q=Agency')
    expect(new Set(searched.rows.map((row: Json) => row.employee.id))).toEqual(new Set([people.employeeIds.e3]))
    expect(searched.tiles).toEqual(due.tiles)
    // The language tile: E3's first aid (recorded without the check) was corrected; the corrected record holds with it.
    const language = await ok('officer', 'GET', '/safety/training/due?view=language')
    expect(language.rows.every((row: Json) => row.languageNotChecked)).toBe(true)
    expect((await ok('companyB', 'GET', '/safety/training/due?view=all')).rows.every((row: Json) => row.employee.companyId === T.companyB)).toBe(true)
    expect((await call('sales', 'GET', '/safety/training/due')).statusCode).toBe(403)
  })

  it('the due list as a PDF for the RSPP, on the company’s letterhead', async () => {
    const response = await call('officer', 'GET', `/safety/training/due/pdf?companyId=${T.companyA}&siteId=${T.siteA1}&language=it`)
    expect(response.statusCode, response.body).toBe(200)
    expect(response.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
  })
})

describe('the hands-on instruction register (QHS-246, QHS-247; design people.skills "Instruction register", SignBlock PIN)', () => {
  it('lists the register by name with how each entry was signed; a preposto adds an entry; refusals in words', async () => {
    const list = await ok('viewer', 'GET', `/safety/training/instruction?siteId=${T.siteA1}`)
    expect(list).toMatchObject({ canAdd: false, law: { instruction: 'D.Lgs. 81/2008 art. 37 c.5' } })
    expect(list.entries.find((entry: Json) => entry.id === safety.instructionIds.signed)).toMatchObject({ signed: { method: 'FLOOR_PIN', verifiable: true }, voided: null })
    expect((await ok('viewer', 'GET', `/safety/training/instruction?view=voided`)).entries.every((entry: Json) => entry.voided !== null)).toBe(true)
    const body = { employeeId: people.employeeIds.e3, task: 'Set the clicking press stroke safely (made-up)', machineId: T.press, instructorEmployeeId: people.employeeIds.e2, minutes: 20, language: 'it', languageChecked: true }
    expect(await no('preposto', 'POST', '/safety/training/instruction', { ...body, instructorEmployeeId: people.employeeIds.e3 }, 400)).toEqual(['body/instructorEmployeeId'])
    expect(await no('preposto', 'POST', '/safety/training/instruction', { ...body, machineClassId: T.postBedClass }, 409)).toEqual(['refusal/MACHINE_NOT_OF_CLASS', 'body/machineId'])
    expect((await call('viewer', 'POST', '/safety/training/instruction', body)).statusCode).toBe(403)
    const added = await ok('preposto', 'POST', '/safety/training/instruction', body, 201)
    expect(added.entry).toMatchObject({ employee: { id: people.employeeIds.e3 }, machineClass: { code: 'CLICKING_PRESS' }, machine: { assetNumber: 'SEED-CP-01' }, instructor: { name: 'Seed Employee Two' }, signed: null, canChange: true })
    const paper = await ok('preposto', 'POST', `/safety/training/instruction/${added.entry.id}/paper`, { version: 1 })
    expect(paper.entry.signed).toMatchObject({ method: 'PAPER', verifiable: false })
    expect(await no('preposto', 'POST', `/safety/training/instruction/${added.entry.id}/paper`, { version: 2 }, 409)).toEqual(['refusal/ENTRY_SIGNED'])
    const voided = await ok('preposto', 'POST', `/safety/training/instruction/${added.entry.id}/void`, { version: 2, reason: 'Typed for the wrong person (made-up)' })
    expect(voided.entry).toMatchObject({ voided: { reason: 'Typed for the wrong person (made-up)' }, canChange: false })
    expect(await no('preposto', 'POST', `/safety/training/instruction/${added.entry.id}/void`, { version: 3, reason: 'Again' }, 409)).toEqual(['refusal/ENTRY_VOIDED'])
  })

  it('on the floor: the scanned person’s unsigned entries, signed once with their own PIN; never by someone else', async () => {
    const pending = await floorPost('/safety/floor/training/instruction/pending', { workerId: T.e1Worker }, null)
    expect(pending.status, JSON.stringify(pending.body)).toBe(200)
    expect(pending.body).toMatchObject({ worker: { id: T.e1Worker }, entries: [{ id: safety.instructionIds.unsigned, machine: { assetNumber: 'SEED-CP-01' } }] })
    expect((await floorPost(`/safety/floor/training/instruction/${safety.instructionIds.unsigned}/sign`, { workerId: T.e2Worker, pin: PIN })).status).toBe(404)
    const signed = await floorPost(`/safety/floor/training/instruction/${safety.instructionIds.unsigned}/sign`, { workerId: T.e1Worker, pin: PIN })
    expect(signed.status, JSON.stringify(signed.body)).toBe(200)
    expect(signed.body.instruction).toMatchObject({ id: safety.instructionIds.unsigned, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(floorRefusal(await floorPost(`/safety/floor/training/instruction/${safety.instructionIds.unsigned}/sign`, { workerId: T.e1Worker, pin: PIN }))).toEqual(['refusal/ENTRY_SIGNED'])
    const [row] = await admin('SELECT "signMethod", "signedByWorkerId" FROM "InstructionRecord" WHERE id = $1', [safety.instructionIds.unsigned])
    expect(row).toEqual({ signMethod: 'FLOOR_PIN', signedByWorkerId: T.e1Worker })
    expect((await floorPost('/safety/floor/training/instruction/pending', { workerId: T.e1Worker }, null)).body.entries).toEqual([])
  })
})

describe('events and audit', () => {
  it('ids, counts, states and how; never a name; every write audited', async () => {
    const sessions = await eventsOf('training_session.changed')
    expect(sessions.map((payload) => payload.change)).toEqual(['OPENED', 'EDITED', 'EDITED', 'CLOSED', 'CANCELLED'])
    expect(sessions.find((payload) => payload.change === 'CLOSED')).toMatchObject({ sessionId: opened.id, records: 2 })
    expect((await eventsOf('training_attendance.changed')).map((payload) => [payload.change, payload.via])).toEqual([
      ['SIGNED', 'FLOOR'],
      ['COUNTERSIGNED', 'FLOOR'],
      ['PAPER', 'OFFICE'],
      ['COUNTERSIGNED', 'OFFICE'],
    ])
    expect((await eventsOf('training.recorded')).map((payload) => payload.way)).toEqual(['SESSION', 'OFFICE', 'CORRECTION', 'CORRECTION', 'CORRECTION'])
    expect((await eventsOf('instruction.changed')).map((payload) => [payload.change, payload.via])).toEqual([
      ['ADDED', 'OFFICE'],
      ['PAPER', 'OFFICE'],
      ['VOIDED', 'OFFICE'],
      ['SIGNED', 'FLOOR'],
    ])
    for (const type of ['training_session.changed', 'training_attendance.changed', 'training.recorded', 'instruction.changed']) expect(JSON.stringify(await eventsOf(type))).not.toMatch(/Seed|made-up/i)
    expect((await auditOf('safety.recordTraining')).map((row) => row.recordType)).toEqual(['TrainingRecord', 'TrainingRecord', 'TrainingRecord', 'TrainingRecord'])
    expect((await auditOf('safety.signAttendance'))[0]!.after).toMatchObject({ method: 'FLOOR_PIN', signedByWorkerId: T.e1Worker })
    expect((await auditOf('safety.voidInstruction'))[0]!.reason).toBe('Typed for the wrong person (made-up)')
    expect((await auditOf('people.setAuthorisationRule'))[0]!.after).toMatchObject({ authorisationRequired: true })
  })
})
