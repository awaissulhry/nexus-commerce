import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { addDays, addMonths } from '@nexus/factory-domain/safety/calendar/rules'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedHealth } from '../../../../../../packages/factory-db/seed/health'
import { seed as seedPlantCare } from '../../../../../../packages/factory-db/seed/plantcare'
import { seed as seedPeople, type PeopleSeed } from '../../../../../../packages/factory-db/seed/people'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * The safety organisation, the RLS notice to INAIL and the safety calendar (B-W2b-120; QHS-224, QHS-226, QHS-227) on the
 * local stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login:
 * row-level security and the …_safety_w2b_guards triggers are real), the factory-db seeds of one tenant up to the health
 * pages and the plant care (company A's organisation with its RLS and notice FILED, company B's RLST with its notice
 * PENDING, typed deadlines, the DVR, training records, health visits, an INAIL filing DUE, statutory check plans), office
 * sessions from the test authenticator. Every name is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/safety`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let people: PeopleSeed

const NS = 'w2b120-safety'
const idOf = (key: string): string => seedUuid(NS, key)
const T = { tenant: idOf('tenant'), companyA: idOf('company:A'), companyB: idOf('company:B'), siteA1: idOf('site:A1'), siteB1: idOf('site:B1'), actor: idOf('actor'), store: idOf('files:account:r2') }
const OFFICER_ID = newId()
const OFFICER: Permission[] = ['safety.view', 'safety.organisation.manage', 'safety.calendar.manage', 'files.read', 'files.upload']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  officer: { audience: 'office', tenantId: T.tenant, actorId: OFFICER_ID, grants: [grant(OFFICER)] },
  viewer: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['safety.view'])] },
  companyB: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(OFFICER, [T.companyB])] },
  sales: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['quotes.view'])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await db.admin.query(sql, values)).rows as R[]
const run = randomBytes(4).toString('hex')
let keys = 0
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `t-${run}-${++keys}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const today = businessDate(new Date())
const eventsOf = async (type: string) => admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [T.tenant, type])

/** An AVAILABLE file of a record, written straight into the table (the files flow is tested in platform/files). */
async function fileOf(recordType: string, recordId: string, companyId = T.companyA): Promise<string> {
  const id = newId()
  await admin(
    `INSERT INTO "StoredFile" (id, "tenantId", "companyId", "recordType", "recordId", kind, "originalName", "contentType", "sizeBytes", sha256, "storeAccountId", "storageKey", status, visibility, "availableAt")
     VALUES ($1, $2, $3, $4, $5, 'DOCUMENT', $6, 'application/pdf', 100, $7, $8, $9, 'AVAILABLE', ARRAY['OFFICE']::"FileAudience"[], now())`,
    [id, T.tenant, companyId, recordType, recordId, `Made-up ${id.slice(-4)}.pdf`, createHash('sha256').update(id).digest('hex'), T.store, `t/${T.tenant}/c/${companyId}/2026/${newId()}`],
  )
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('w2b120_safety')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: NS })
  await seedAuth({ db: database, namespace: NS })
  await seedRoles({ db: database, namespace: NS })
  await seedFiles({ db: database, namespace: NS })
  people = await seedPeople({ db: database, namespace: NS })
  await seedHealth({ db: database, namespace: NS })
  await seedPlantCare({ db: database, namespace: NS })
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, 'made-up-officer@example.test', 'Made-up Officer', 'ACTIVE')`, [OFFICER_ID, T.tenant])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('the safety organisation (QHS-224)', () => {
  it('names who holds each role per company and site, the roles nobody holds, and the training from Skills', async () => {
    const org = await ok('officer', 'GET', '/safety/organisation')
    const roles = org.appointments.filter((row: Json) => row.companyId === T.companyA).map((row: Json) => row.role)
    expect(roles).toEqual(expect.arrayContaining(['EMPLOYER', 'RSPP', 'DOCTOR', 'RLS', 'SUPERVISOR', 'FIRST_AID']))
    // In role order: the employer first.
    expect(roles[0]).toBe('EMPLOYER')
    // E4's ASPP term ended 100 days ago: not listed unless asked.
    expect(org.appointments.some((row: Json) => row.role === 'ASPP')).toBe(false)
    expect((await ok('officer', 'GET', '/safety/organisation?ended=true')).appointments.some((row: Json) => row.role === 'ASPP' && row.ended)).toBe(true)
    const rls = org.appointments.find((row: Json) => row.role === 'RLS')
    expect(rls).toMatchObject({ appointee: { kind: 'EMPLOYEE', name: 'Seed Employee Two', email: null, phone: null }, signature: { method: 'OFFICE' }, law: 'D.Lgs. 81/2008 art. 47', training: { state: expect.stringMatching(/^(VALID|EXPIRED|NONE)$/) } })
    expect(org.appointments.find((row: Json) => row.role === 'RSPP')).toMatchObject({ appointee: { kind: 'OUTSIDE' }, training: { state: 'NOT_TRACKED' } })
    // Company A has no fire team at A1; company B has only its territorial RLS.
    expect(org.missing).toEqual(expect.arrayContaining([{ companyId: T.companyA, siteId: T.siteA1, role: 'FIRE_EMERGENCY' }, { companyId: T.companyB, siteId: null, role: 'RSPP' }, { companyId: T.companyB, siteId: null, role: 'DOCTOR' }]))
    expect(org.missing).not.toContainEqual({ companyId: T.companyB, siteId: null, role: 'RLS' })
    expect(org).toMatchObject({ canManage: true, canUpload: true, law: 'D.Lgs. 81/2008 art. 18 c.1 b; art. 28 c.2 e' })
    // A reader changes nothing; a role of company B sees company B only; a role without safety.view is refused.
    expect((await ok('viewer', 'GET', '/safety/organisation')).canManage).toBe(false)
    expect((await ok('companyB', 'GET', '/safety/organisation')).appointments.every((row: Json) => row.companyId === T.companyB)).toBe(true)
    expect((await call('sales', 'GET', '/safety/organisation')).statusCode).toBe(403)
  })

  it('appoints an RLS with its notice to INAIL in one command, and refuses what the law and the schema refuse', async () => {
    const base = { companyId: T.companyA, siteId: T.siteA1, fromDate: today }
    expect(await no('officer', 'POST', '/safety/appointments', { ...base, role: 'RLS', outsideName: 'Made-up Outsider' }, 409)).toEqual(['refusal/RLS_IS_EMPLOYEE', 'body/employeeId'])
    expect(await no('officer', 'POST', '/safety/appointments', { ...base, siteId: null, role: 'RLST', employeeId: people.employeeIds.e1 }, 409)).toContain('refusal/RLST_IS_OUTSIDE')
    expect(await no('officer', 'POST', '/safety/appointments', { ...base, role: 'RSPP', outsideName: 'Made-up Consultant', shiftPatternId: idOf('calendar:pattern:1T') }, 409)).toContain('refusal/SHIFT_ONLY_TEAMS')
    expect(await no('officer', 'POST', '/safety/appointments', { ...base, role: 'FIRST_AID', employeeId: people.employeeIds.eb1 }, 409)).toContain('refusal/PERSON_OTHER_COMPANY')
    expect(await no('officer', 'POST', '/safety/appointments', { ...base, role: 'FIRST_AID', employeeId: people.employeeIds.e5 }, 409)).toContain('refusal/PERSON_NOT_ACTIVE')
    expect(await no('officer', 'POST', '/safety/appointments', { ...base, role: 'FIRST_AID', employeeId: people.employeeIds.e1, untilDate: addDays(today, -1) }, 409)).toContain('refusal/ENDS_BEFORE_START')
    expect(await no('officer', 'POST', '/safety/appointments', { ...base, role: 'RSPP', outsideName: 'Made-up', noticeDueOn: today }, 400)).toContain('body/noticeDueOn')
    expect((await call('viewer', 'POST', '/safety/appointments', { ...base, role: 'FIRE_EMERGENCY', employeeId: people.employeeIds.e1 })).statusCode).toBe(403)

    const made = await ok('officer', 'POST', '/safety/appointments', { ...base, role: 'RLS', employeeId: people.employeeIds.e1 }, 201)
    expect(made.appointment).toMatchObject({ role: 'RLS', inForce: true, signature: null, letter: null, appointee: { name: 'Seed Employee One' } })
    expect(made.notice).toMatchObject({ status: 'PENDING', dueOn: today, appointee: 'Seed Employee One', appointedFrom: today })
    expect((await eventsOf('safety_appointment.changed')).map((event) => event.payload)).toContainEqual({ appointmentId: made.appointment.id, role: 'RLS', change: 'MADE', noticeId: made.notice.id })
    expect((await eventsOf('rls_notice.changed')).map((event) => event.payload)).toContainEqual({ noticeId: made.notice.id, appointmentId: made.appointment.id, change: 'CREATED' })
    expect(await no('officer', 'POST', '/safety/appointments', { ...base, role: 'RLS', employeeId: people.employeeIds.e1, fromDate: addDays(today, 5) }, 409)).toContain('refusal/ALREADY_APPOINTED')

    // A fire team member for the first shift: the missing role is filled.
    const fire = await ok('officer', 'POST', '/safety/appointments', { ...base, role: 'FIRE_EMERGENCY', employeeId: people.employeeIds.e2, shiftPatternId: idOf('calendar:pattern:1T') }, 201)
    expect(fire.notice).toBeNull()
    expect(fire.appointment.shift).toMatchObject({ code: '1T' })
    expect((await ok('officer', 'GET', '/safety/organisation')).missing).not.toContainEqual({ companyId: T.companyA, siteId: T.siteA1, role: 'FIRE_EMERGENCY' })

    // An RLST of company B already notified before it was recorded here: its notice is recorded FILED.
    const filed = await ok('officer', 'POST', '/safety/appointments', { companyId: T.companyB, role: 'RLST', outsideName: 'Made-up Territorial', fromDate: addDays(today, -3), noticeFiled: { filedOn: addDays(today, -1), reference: 'MADE-UP-001' } }, 201)
    expect(filed.notice).toMatchObject({ status: 'FILED', filedOn: addDays(today, -1), reference: 'MADE-UP-001', filedBy: 'Made-up Officer' })
  })

  it('records the appointee’s signature once (the typed name is the appointee’s; paper needs the letter) and ends a term', async () => {
    const made = await ok('officer', 'POST', '/safety/appointments', { companyId: T.companyA, siteId: T.siteA1, role: 'SUPERVISOR', employeeId: people.employeeIds.e1, fromDate: addDays(today, -30) }, 201)
    const id = made.appointment.id
    expect(await no('officer', 'POST', `/safety/appointments/${id}/sign`, { version: 1, method: 'OFFICE', signedName: 'Somebody Else' }, 409)).toEqual(['refusal/NAME_MISMATCH', 'body/signedName'])
    expect(await no('officer', 'POST', `/safety/appointments/${id}/sign`, { version: 1, method: 'PAPER', signedName: 'Seed Employee One' }, 409)).toContain('refusal/LETTER_MISSING')
    const signed = (await ok('officer', 'POST', `/safety/appointments/${id}/sign`, { version: 1, method: 'OFFICE', signedName: '  seed  EMPLOYEE one ' })).appointment
    expect(signed.signature).toMatchObject({ method: 'OFFICE', signedName: 'seed  EMPLOYEE one', signedBy: 'Made-up Officer' })
    expect(await no('officer', 'POST', `/safety/appointments/${id}/sign`, { version: signed.version, method: 'OFFICE', signedName: 'Seed Employee One' }, 409)).toContain('refusal/SIGNED_ALREADY')
    // A stale version is refused in words.
    expect((await call('officer', 'PATCH', `/safety/appointments/${id}`, { version: 1, note: 'x' })).statusCode).toBe(409)

    // A paper signature with the letter's scan on file.
    const team = await ok('officer', 'POST', '/safety/appointments', { companyId: T.companyA, siteId: T.siteA1, role: 'FIRST_AID', employeeId: people.employeeIds.e2, fromDate: addDays(today, -10) }, 201)
    await fileOf('SafetyAppointment', team.appointment.id)
    const paper = (await ok('officer', 'POST', `/safety/appointments/${team.appointment.id}/sign`, { version: 1, method: 'PAPER', signedName: 'Seed Employee Two' })).appointment
    expect(paper).toMatchObject({ signature: { method: 'PAPER' }, letter: { name: expect.stringMatching(/^Made-up/) } })

    expect(await no('officer', 'POST', `/safety/appointments/${id}/end`, { version: signed.version, untilDate: addDays(today, -31), endReason: 'Made-up' }, 409)).toContain('refusal/ENDS_BEFORE_START')
    const ended = (await ok('officer', 'POST', `/safety/appointments/${id}/end`, { version: signed.version, untilDate: addDays(today, -1), endReason: 'Moved to another line (made-up)' })).appointment
    expect(ended).toMatchObject({ inForce: false, ended: true, untilDate: addDays(today, -1), endReason: 'Moved to another line (made-up)' })
    expect(await no('officer', 'POST', `/safety/appointments/${id}/end`, { version: ended.version, untilDate: today, endReason: 'Again' }, 409)).toContain('refusal/ENDED')
    expect((await eventsOf('safety_appointment.changed')).map((event) => event.payload.change)).toEqual(expect.arrayContaining(['SIGNED', 'ENDED']))
  })
})

describe('the RLS notice to INAIL (QHS-226)', () => {
  it('records the filing (a manual send on the INAIL portal) with its reference, the due day confirmed, or a cancellation', async () => {
    const list = await ok('officer', 'GET', '/safety/rls-notices')
    expect(list.law).toBe('D.Lgs. 81/2008 art. 18 c.1 aa')
    const pending = list.notices.find((row: Json) => row.status === 'PENDING' && row.companyId === T.companyB && row.role === 'RLST')
    expect(list.notices[0].status).toBe('PENDING')
    expect(pending).toMatchObject({ appointee: 'Seed Territorial RLS (made-up)', canManage: true })
    expect(await no('officer', 'POST', `/safety/rls-notices/${pending.id}/file`, { version: pending.version, filedOn: addDays(today, 1), reference: 'X' }, 409)).toEqual(['refusal/FILED_IN_FUTURE', 'body/filedOn'])
    expect(await no('officer', 'POST', `/safety/rls-notices/${pending.id}/file`, { version: pending.version, filedOn: addDays(today, -400), reference: 'X' }, 409)).toContain('refusal/FILED_BEFORE_APPOINTMENT')
    expect((await call('viewer', 'POST', `/safety/rls-notices/${pending.id}/file`, { version: pending.version, filedOn: today, reference: 'X' })).statusCode).toBe(403)
    const due = (await ok('officer', 'POST', `/safety/rls-notices/${pending.id}/due`, { version: pending.version, dueOn: addDays(today, 7) })).notice
    expect(due.dueOn).toBe(addDays(today, 7))
    const done = (await ok('officer', 'POST', `/safety/rls-notices/${pending.id}/file`, { version: due.version, filedOn: today, reference: 'INAIL-MADE-UP-42' })).notice
    expect(done).toMatchObject({ status: 'FILED', filedOn: today, reference: 'INAIL-MADE-UP-42', receipt: null })
    await fileOf('RlsNotice', done.id, T.companyB)
    expect((await ok('officer', 'GET', '/safety/rls-notices?status=FILED')).notices.find((row: Json) => row.id === done.id).receipt).not.toBeNull()
    expect(await no('officer', 'POST', `/safety/rls-notices/${pending.id}/cancel`, { version: done.version, reason: 'Made-up' }, 409)).toContain('refusal/NOTICE_NOT_PENDING')
    expect((await eventsOf('rls_notice.changed')).map((event) => event.payload.change)).toEqual(expect.arrayContaining(['DUE_SET', 'FILED']))
  })
})

describe('the safety calendar (QHS-227)', () => {
  it('adds a deadline, asks for its evidence before done, and makes the next occurrence of a repeating one', async () => {
    const base = { companyId: T.companyA, siteId: T.siteA1, title: 'Periodic safety meeting (made-up)', kind: 'MEETING', dueOn: addDays(today, 3), repeatEvery: 1, repeatUnit: 'YEAR', evidenceRequired: true }
    expect(await no('officer', 'POST', '/safety/deadlines', { ...base, repeatUnit: null }, 400)).toContain('body/repeatUnit')
    expect(await no('officer', 'POST', '/safety/deadlines', { ...base, ownerId: newId() }, 409)).toEqual(['refusal/OWNER_NOT_ALLOWED', 'body/ownerId'])
    expect((await call('viewer', 'POST', '/safety/deadlines', base)).statusCode).toBe(403)
    const owners = (await ok('officer', 'GET', `/safety/deadlines/owners?companyId=${T.companyA}`)).owners
    expect(owners.map((owner: Json) => owner.id)).toContain(T.actor)
    const added = (await ok('officer', 'POST', '/safety/deadlines', { ...base, ownerId: T.actor }, 201)).deadline
    expect(added).toMatchObject({ status: 'OPEN', state: 'DUE_SOON', evidenceRequired: true, evidence: [], ownerId: T.actor, canManage: true })

    expect(await no('officer', 'POST', `/safety/deadlines/${added.id}/done`, { version: added.version }, 409)).toContain('refusal/EVIDENCE_MISSING')
    await fileOf('SafetyDeadline', added.id)
    const done = await ok('officer', 'POST', `/safety/deadlines/${added.id}/done`, { version: added.version, note: 'Minutes signed (made-up).' })
    expect(done.deadline).toMatchObject({ status: 'DONE', doneBy: 'Made-up Officer', doneNote: 'Minutes signed (made-up).', evidence: [expect.objectContaining({ name: expect.stringMatching(/^Made-up/) })] })
    expect(done.next).toMatchObject({ status: 'OPEN', dueOn: addMonths(addDays(today, 3), 12), previousId: added.id, evidence: [], title: base.title })
    expect(done.deadline.nextId).toBe(done.next.id)
    expect((await eventsOf('safety_deadline.changed')).map((event) => event.payload)).toContainEqual({ deadlineId: added.id, kind: 'MEETING', change: 'DONE', nextId: done.next.id })

    // A done deadline keeps everything but its note; the next one changes and is cancelled with the reason.
    expect(await no('officer', 'PATCH', `/safety/deadlines/${added.id}`, { version: done.deadline.version, title: 'Other' }, 409)).toContain('refusal/NOT_OPEN')
    expect((await ok('officer', 'PATCH', `/safety/deadlines/${added.id}`, { version: done.deadline.version, note: 'Filed in the binder (made-up).' })).deadline.note).toBe('Filed in the binder (made-up).')
    const moved = (await ok('officer', 'PATCH', `/safety/deadlines/${done.next.id}`, { version: done.next.version, dueOn: addDays(today, 360), evidenceRequired: false })).deadline
    expect(moved).toMatchObject({ dueOn: addDays(today, 360), evidenceRequired: false })
    const record = await ok('viewer', 'GET', `/safety/deadlines/${done.next.id}`)
    expect(record.earlier).toEqual([expect.objectContaining({ id: added.id, status: 'DONE' })])
    expect(record.deadline.canManage).toBe(false)
    const cancelled = (await ok('officer', 'POST', `/safety/deadlines/${done.next.id}/cancel`, { version: moved.version, reason: 'Merged with the yearly audit (made-up).' })).deadline
    expect(cancelled).toMatchObject({ status: 'CANCELLED', state: 'CANCELLED', nextId: null })
  })

  it('reads every source into one calendar, health visits and INAIL reports as counts only, and the tiles', async () => {
    const from = addDays(today, -60)
    const to = addDays(today, 330)
    const answer = await ok('officer', 'GET', `/safety/calendar?from=${from}&to=${to}`)
    expect(answer.failed).toEqual([])
    const kinds = new Set(answer.items.map((item: Json) => item.kind))
    for (const kind of ['DEADLINE', 'DVR_REVIEW', 'TRAINING_REFRESHER', 'HEALTH_VISIT', 'MACHINE_CHECK', 'INAIL_REPORT', 'RLS_NOTICE']) expect(kinds.has(kind), kind).toBe(true)
    for (const item of answer.items) expect(item.dueOn >= from && item.dueOn <= to, item.key).toBe(true)
    // In day order, each with its company and state.
    expect(answer.items.map((item: Json) => item.dueOn)).toEqual([...answer.items.map((item: Json) => item.dueOn)].sort())
    const visits = answer.items.filter((item: Json) => item.kind === 'HEALTH_VISIT')
    for (const visit of visits) {
      expect(visit).toMatchObject({ recordType: null, recordId: null, editable: false, law: 'D.Lgs. 81/2008 art. 41', source: { page: 'plant.health' } })
      expect(Object.keys(visit.params).sort()).toEqual(['booked', 'due'])
      expect(visit.count).toBeGreaterThan(0)
    }
    const inail = answer.items.find((item: Json) => item.kind === 'INAIL_REPORT')
    expect(inail).toMatchObject({ recordType: 'Incident', count: 1, params: { incident: expect.any(String) }, source: { page: 'plant.incidents' } })
    // No person anywhere near a health visit or an INAIL report.
    expect(JSON.stringify([...visits, inail])).not.toMatch(/Seed Employee|Seed Worker/)
    const check = answer.items.find((item: Json) => item.kind === 'MACHINE_CHECK')
    expect(check).toMatchObject({ recordType: 'MachineCheckPlan', source: { page: 'plant.preventive', parentType: 'Machine' }, params: { asset: expect.any(String), checkIt: expect.any(String) }, editable: false })
    const meeting = answer.items.find((item: Json) => item.kind === 'DEADLINE' && item.params.kind === 'MEETING' && item.state === 'DONE')
    expect(meeting).toMatchObject({ evidence: { required: true, onFile: true }, editable: false })
    // The new RLS's notice is still on its default day: "to confirm", never late.
    expect(answer.items.find((item: Json) => item.kind === 'RLS_NOTICE' && item.params.person === 'Seed Employee One')).toMatchObject({ state: 'TO_CONFIRM', toConfirm: true })

    // A window longer than 400 days is refused; a role of company B sees company B only.
    expect(await no('officer', 'GET', `/safety/calendar?from=${today}&to=${addDays(today, 401)}`, undefined, 400)).toContain('body/to')
    expect((await ok('companyB', 'GET', `/safety/calendar?from=${from}&to=${to}`)).items.every((item: Json) => item.companyId === T.companyB)).toBe(true)

    // What is still late from before the window comes with `late=true`.
    const late = await ok('officer', 'POST', '/safety/deadlines', { companyId: T.companyA, title: 'Fire extinguisher check (made-up)', kind: 'INSPECTION', dueOn: addDays(today, -100), evidenceRequired: false }, 201)
    const window = `from=${addDays(today, -10)}&to=${addDays(today, 30)}`
    expect((await ok('officer', 'GET', `/safety/calendar?${window}`)).items.some((item: Json) => item.recordId === late.deadline.id)).toBe(false)
    expect((await ok('officer', 'GET', `/safety/calendar?${window}&late=true`)).items.find((item: Json) => item.recordId === late.deadline.id)).toMatchObject({ state: 'OVERDUE', editable: true })

    const counts = await ok('officer', 'GET', '/safety/calendar/counts')
    const org = await ok('officer', 'GET', '/safety/organisation')
    const pending = (await ok('officer', 'GET', '/safety/rls-notices?status=PENDING')).notices.length
    expect(counts).toMatchObject({ rolesWithoutPerson: org.missing.length, rlsPending: pending, failed: [], today })
    expect(counts.overdue).toBeGreaterThanOrEqual(1)
    expect((await ok('viewer', 'GET', '/safety/calendar/counts')).overdue).toBe(counts.overdue)
  })
})
