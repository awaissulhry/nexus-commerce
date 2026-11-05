import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/safety/calendar/rules'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seed as seedHealth, type HealthSeed } from '../../../../../../packages/factory-db/seed/health'
import { seed as seedPeople, type PeopleSeed } from '../../../../../../packages/factory-db/seed/people'
import { seed as seedSafety, type SafetySeed } from '../../../../../../packages/factory-db/seed/safety'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor, COMMAND_SETTINGS } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { systemContext } from '../../../platform/outbox/system'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { dueListForTenant, visitOnRoleChange, visitsOnLeaving } from './jobs'

/**
 * Health surveillance (B-W2b-135; QHS-252, QHS-253, QHS-254, QHS-256) on the local stack: a throwaway PostgreSQL 17 database from
 * the migrations (the runtime login: row-level security and the health guards are real: a judgement is never changed but voided,
 * a return visit carries only the absence's length, the view log is append-only), the real app. Tenant A from the factory-db
 * seeds up to the health pages: A1's Cutter (E1; plan 12 months, the doctor named), Machinist (E2, E3; 24 months), B1's Machinist
 * (EB1; not needed); E1's periodic visit due in 20 days and a return visit 3 days late, E2's booked one, the judgements (E1 fit with
 * limits expiring in 20 days, E2 temporarily unfit for 10 days, E3 fit). Every name is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/safety/health`.
 */

let h: Harness
let app: FastifyInstance
let safety: SafetySeed
let people: PeopleSeed
let health: HealthSeed

const NS = 'w2b135-health'
const idOf = (key: string): string => seedUuid(NS, key)
const T = { tenant: idOf('tenant'), companyA: idOf('company:A'), companyB: idOf('company:B'), siteA1: idOf('site:A1'), actor: idOf('actor') }
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const HR: Permission[] = ['people.view', 'people.employees.manage', 'people.leavers.manage', 'safety.view', 'safety.health.view', 'safety.health.manage', 'safety.health.views', 'files.upload', 'files.read']
const ACTORS = { hr: newId(), doctor: newId(), officer: newId(), production: newId(), viewer: newId(), hrB: newId() }
const SESSIONS: Record<string, SessionContext> = {
  hr: { audience: 'office', tenantId: T.tenant, actorId: ACTORS.hr, grants: [grant(HR)] },
  doctor: { audience: 'office', tenantId: T.tenant, actorId: ACTORS.doctor, grants: [grant(['safety.view', 'safety.health.view', 'safety.health.manage', 'safety.health.plans'])] },
  officer: { audience: 'office', tenantId: T.tenant, actorId: ACTORS.officer, grants: [grant(['safety.view', 'safety.health.plans', 'safety.rolesheets.manage', 'safety.organisation.manage', 'files.upload', 'files.read'])] },
  // People › Skills: authorises machines, reads fit yes or no only.
  production: { audience: 'office', tenantId: T.tenant, actorId: ACTORS.production, grants: [grant(['people.view', 'people.skills.view', 'people.authorisations.manage', 'safety.view'])] },
  // Every read the read-only template holds of this area: the safety pages, people, files.
  viewer: { audience: 'office', tenantId: T.tenant, actorId: ACTORS.viewer, grants: [grant(['safety.view', 'people.view', 'files.read'])] },
  hrB: { audience: 'office', tenantId: T.tenant, actorId: ACTORS.hrB, grants: [grant(HR, [T.companyB])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
let keys = 0
const key = () => `health-${++keys}-${newId()}`
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
const today = businessDate(new Date())
const views = (viewerId: string) => admin<Json>(`SELECT "recordType"::text AS "recordType", "recordId", "employeeId", what::text AS what, "companyId" FROM "ProtectedView" WHERE "tenantId" = $1 AND "viewerId" = $2 ORDER BY "viewedAt", id`, [T.tenant, viewerId])
const system = () => callerFor(h.database, systemContext(T.tenant, `health-test-${newId()}`))

beforeAll(async () => {
  h = await startHarness('w2b135_health')
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  health = await seedHealth({ db: h.database, namespace: NS })
  safety = await seedSafety({ db: h.database, namespace: NS })
  people = await seedPeople({ db: h.database, namespace: NS })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 1_500_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('the protected page (QHS-256: HR and the doctor read; every view recorded; GDPR art. 9)', () => {
  it('says who sees it and that live use waits for the doctor, and counts what is due without naming anyone; others are refused', async () => {
    const frame = await ok('hr', 'GET', '/safety/health')
    expect(frame).toMatchObject({
      today,
      privacy: { words: { en: 'Protected · HR and the occupational doctor · every view recorded' }, viewLog: true },
      liveUse: { en: expect.stringContaining('Live use waits for the company doctor') },
      hint: { en: expect.stringContaining('Never the medical reason') },
      tiles: { overdue: 1, dueIn30: 2, beforeTask: 0, returnVisits: 1, unfitEnding: 1 },
      can: { manage: true, plans: false, views: true },
    })
    expect(JSON.stringify(frame)).not.toMatch(/Seed |employeeId/)
    expect((await ok('doctor', 'GET', '/safety/health')).can).toEqual({ manage: true, plans: true, views: false })
    // Counts only: nothing recorded.
    expect(await views(ACTORS.hr)).toEqual([])
    for (const session of ['viewer', 'officer', 'production']) expect((await call(session, 'GET', '/safety/health')).statusCode).toBe(403)
  })

  it('lists the plans per role to every safety reader (no person in a plan); the safety officer and the doctor set how often, never whether', async () => {
    const plans = (await ok('viewer', 'GET', '/safety/health/plans')).plans
    expect(plans.map((plan: Json) => [plan.site.code, plan.role.code, plan.needed, plan.frequencyMonths, plan.doctorSet, plan.people, plan.canEdit])).toEqual([
      ['A1', 'CUT', true, 12, true, 1, false],
      ['A1', 'SEW', true, 24, true, 2, false],
      ['B1', 'SEW-B', false, null, false, 1, false],
    ])
    expect(plans[0].risks).toEqual(['Noise exposure'])
    const sew = plans[1]
    const edited = await ok('officer', 'PATCH', `/safety/health/plans/${sew.id}`, { version: sew.version, frequencyMonths: 36 })
    expect(edited).toMatchObject({ changed: true, plan: { frequencyMonths: 36, setOn: today, version: sew.version + 1, canEdit: true } })
    expect(await no('officer', 'PATCH', `/safety/health/plans/${plans[2].id}`, { version: plans[2].version, frequencyMonths: 12 }, 409)).toEqual(['refusal/PLAN_NOT_NEEDED', 'body/frequencyMonths'])
    expect(await no('doctor', 'PATCH', `/safety/health/plans/${sew.id}`, { version: sew.version + 1, doctorAppointmentId: safety.appointmentIds.rspp }, 409)).toEqual(['refusal/NOT_A_DOCTOR', 'body/doctorAppointmentId'])
    expect((await call('hr', 'PATCH', `/safety/health/plans/${sew.id}`, { version: sew.version + 1, frequencyMonths: 12 })).statusCode).toBe(403)
    const [event] = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'health_plan.changed'`, [T.tenant])
    expect(event!.payload).toEqual({ planId: sew.id, roleSheetId: safety.roleSheetIds.machinist, change: 'EDITED', fields: ['frequencyMonths', 'setOn'] })
  })

  it('shows the due list with names only after the view is recorded; another company sees none and records none', async () => {
    const list = await ok('hr', 'POST', '/safety/health/visits/list', {})
    expect(list.visits.map((visit: Json) => [visit.employee.id, visit.type, visit.status, visit.state])).toEqual([
      [people.employeeIds.e1, 'RETURN_AFTER_ABSENCE', 'DUE', 'OVERDUE'],
      [people.employeeIds.e1, 'PERIODIC', 'DUE', 'DUE_SOON'],
      [people.employeeIds.e2, 'PERIODIC', 'BOOKED', 'BOOKED'],
    ])
    // The list carries no absence length (open the visit) and no judgement.
    expect(JSON.stringify(list)).not.toMatch(/absenceDays|outcome|taskLimits/)
    expect(await views(ACTORS.hr)).toEqual([{ recordType: 'HEALTH_VISIT_LIST', recordId: null, employeeId: null, what: 'LIST', companyId: T.companyA }])
    expect(await ok('hrB', 'POST', '/safety/health/visits/list', {})).toMatchObject({ visits: [], recorded: false })
    expect(await views(ACTORS.hrB)).toEqual([])
    expect((await call('viewer', 'POST', '/safety/health/visits/list', {})).statusCode).toBe(403)
    const print = await ok('doctor', 'POST', '/safety/health/visits/print', { companyId: T.companyA })
    expect(print.visits.map((visit: Json) => [visit.employee.id, visit.type, visit.risks[0]])).toEqual([
      [people.employeeIds.e1, 'RETURN_AFTER_ABSENCE', 'Noise exposure'],
      [people.employeeIds.e1, 'PERIODIC', 'Noise exposure'],
      [people.employeeIds.e2, 'PERIODIC', 'Upper limbs (repetitive movements)'],
    ])
    expect(await views(ACTORS.doctor)).toEqual([{ recordType: 'HEALTH_VISIT_LIST', recordId: null, employeeId: null, what: 'PRINT', companyId: T.companyA }])
  })

  it('opens one visit: the absence’s length only, recorded with whose it is; out of reach it is not found', async () => {
    const opened = await ok('hr', 'POST', `/safety/health/visits/${health.visitIds.e1Return}/open`)
    expect(opened.visit).toMatchObject({ type: 'RETURN_AFTER_ABSENCE', absenceDays: 75, employee: { id: people.employeeIds.e1 }, state: 'OVERDUE', risks: ['Noise exposure'] })
    expect((await views(ACTORS.hr)).at(-1)).toEqual({ recordType: 'HEALTH_VISIT', recordId: health.visitIds.e1Return, employeeId: people.employeeIds.e1, what: 'OPEN', companyId: T.companyA })
    expect((await call('hrB', 'POST', `/safety/health/visits/${health.visitIds.e1Return}/open`)).statusCode).toBe(404)
    expect((await call('hr', 'POST', `/safety/health/visits/${newId()}/open`)).statusCode).toBe(404)
  })
})

describe('the visits (QHS-253; art. 41 c.2)', () => {
  let planned: Json
  it('proposes what nobody planned, plans it in one command, refuses a second open one, a short absence and a role that needs no visits', async () => {
    const visits = await ok('hr', 'POST', '/safety/health/visits/list', {})
    const e1Due = visits.visits.find((visit: Json) => visit.employee.id === people.employeeIds.e1 && visit.type === 'PERIODIC')
    const e1Return = visits.visits.find((visit: Json) => visit.type === 'RETURN_AFTER_ABSENCE')
    await ok('hr', 'POST', `/safety/health/visits/${e1Return.id}/cancel`, { version: e1Return.version, reason: 'MISTAKE' })
    await ok('hr', 'POST', `/safety/health/visits/${e1Due.id}/cancel`, { version: e1Due.version, reason: 'REPLACED' })
    const proposals = await ok('hr', 'POST', '/safety/health/visits/proposals', {})
    expect(proposals.proposals.map((row: Json) => [row.employee.id, row.role.code, row.type, row.doctorSet])).toEqual([[people.employeeIds.e1, 'CUT', 'PERIODIC', true]])
    expect(proposals.proposals[0].dueOn <= addDays(today, 20)).toBe(true)
    expect((await views(ACTORS.hr)).at(-1)).toMatchObject({ recordType: 'HEALTH_VISIT_LIST', what: 'LIST' })
    const item = { employeeId: people.employeeIds.e1, type: 'PERIODIC', dueOn: proposals.proposals[0].dueOn }
    planned = (await ok('hr', 'POST', '/safety/health/visits/plan', { items: [item] }, 201)).visits[0]
    expect(planned).toMatchObject({ version: 1, status: 'DUE' })
    expect(await no('hr', 'POST', '/safety/health/visits/plan', { items: [item] }, 409)).toEqual(['refusal/OPEN_VISIT_EXISTS', 'body/items/0/type'])
    expect(await no('hr', 'POST', '/safety/health/visits/plan', { items: [{ employeeId: people.employeeIds.e3, type: 'RETURN_AFTER_ABSENCE', dueOn: today, absenceDays: 50 }] }, 400)).toEqual(['body/items/0/absenceDays'])
    expect(await no('hr', 'POST', '/safety/health/visits/plan', { items: [{ employeeId: people.employeeIds.eb1, type: 'PREVENTIVE', dueOn: today }] }, 409)).toEqual(['refusal/PLAN_NOT_NEEDED', 'body/items/0/type'])
    expect((await call('viewer', 'POST', '/safety/health/visits/plan', { items: [item] })).statusCode).toBe(403)
    // The audit rows name the visit and the change, never the person, the type or a reason.
    const audits = await admin<{ after: Json; recordType: string }>(`SELECT after, "recordType" FROM "AuditLog" WHERE "tenantId" = $1 AND action IN ('safety.planHealthVisit', 'safety.cancelHealthVisit')`, [T.tenant])
    expect(audits.length).toBe(3)
    expect(JSON.stringify(audits)).not.toMatch(/PERIODIC|RETURN|MISTAKE|REPLACED|employee/i)
  })

  it('books "for 14 Nov" with a place (never in the past), unbooks and books again; the events carry the id and the state only', async () => {
    expect(await no('hr', 'POST', '/safety/health/visits/book', { visits: [{ id: planned.id, version: 1 }], bookedOn: addDays(today, -1) }, 409)).toEqual(['refusal/BOOKED_IN_PAST', 'body/bookedOn'])
    const booked = (await ok('hr', 'POST', '/safety/health/visits/book', { visits: [{ id: planned.id, version: 1 }], bookedOn: addDays(today, 1), bookedPlace: 'Made-up clinic, room 2' })).visits[0]
    expect(booked).toEqual({ id: planned.id, version: 2, status: 'BOOKED' })
    const unbooked = (await ok('doctor', 'POST', `/safety/health/visits/${planned.id}/unbook`, { version: 2 })).visits[0]
    expect(unbooked).toEqual({ id: planned.id, version: 3, status: 'DUE' })
    expect(await no('hr', 'POST', `/safety/health/visits/${planned.id}/unbook`, { version: 3 }, 409)).toEqual(['refusal/VISIT_NOT_BOOKED'])
    await ok('hr', 'POST', '/safety/health/visits/book', { visits: [{ id: planned.id, version: 3 }], bookedOn: today })
    const [row] = await admin(`SELECT status::text AS status, "bookedOn"::text AS "bookedOn", "bookedPlace", "bookedById" FROM "HealthVisit" WHERE id = $1`, [planned.id])
    expect(row).toEqual({ status: 'BOOKED', bookedOn: today, bookedPlace: null, bookedById: ACTORS.hr })
    const payloads = (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'health_visit.changed'`, [T.tenant])).map((event) => event.payload)
    expect(payloads).toContainEqual({ visitId: planned.id, change: 'BOOKED', status: 'BOOKED', by: 'OFFICE' })
    for (const payload of payloads) expect(Object.keys(payload).sort()).toEqual(['by', 'change', 'status', 'visitId'])
  })
})

describe('the judgements (QHS-254: fitness only, no clinical data; art. 41 c.6)', () => {
  let judgementId: string
  it('records the outcome and the task limits only (a medical reason is refused in words), with its visit done in the same command', async () => {
    const visit = (await admin<{ id: string; version: number }>(`SELECT id, version FROM "HealthVisit" WHERE "employeeId" = $1 AND status = 'BOOKED'`, [people.employeeIds.e1]))[0]!
    const body = { employeeId: people.employeeIds.e1, visitId: visit.id, outcome: 'FIT_WITH_LIMITS', taskLimits: 'Ernia del disco: niente sollevamento oltre 10 kg', judgedOn: today, expiresOn: addDays(today, 365) }
    const refused = await call('hr', 'POST', '/safety/health/judgements', body)
    expect(refused.statusCode).toBe(400)
    expect(refused.json().error).toMatchObject({ message: expect.stringContaining('Never the medical reason'), issues: [{ path: 'body/taskLimits' }] })
    const recorded = await ok('doctor', 'POST', '/safety/health/judgements', { ...body, taskLimits: 'No lifting over 10 kg; ear defenders at the press.' }, 201)
    judgementId = recorded.judgement.id
    expect(recorded).toEqual({ judgement: { id: judgementId, version: 1 }, visit: { id: visit.id, version: visit.version + 1, status: 'DONE' }, replayed: false })
    const [row] = await admin(`SELECT "doctorAppointmentId", outcome::text AS outcome FROM "FitnessJudgement" WHERE id = $1`, [judgementId])
    // No doctor named: the company's occupational doctor in force.
    expect(row).toEqual({ doctorAppointmentId: safety.appointmentIds.doctor, outcome: 'FIT_WITH_LIMITS' })
    expect(await no('hr', 'POST', '/safety/health/judgements', { ...body, taskLimits: 'No lifting.' }, 409)).toEqual(['refusal/VISIT_JUDGED', 'body/visitId'])
    expect(await no('hr', 'POST', '/safety/health/judgements', { employeeId: people.employeeIds.e2, visitId: visit.id, outcome: 'FIT', judgedOn: today }, 409)).toEqual(['refusal/VISIT_OTHER_PERSON', 'body/visitId'])
    expect(await no('hr', 'POST', '/safety/health/judgements', { employeeId: people.employeeIds.e3, outcome: 'UNFIT', judgedOn: today, expiresOn: addDays(today, 10) }, 400)).toEqual(['body/expiresOn'])
    const audits = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'safety.recordFitnessJudgement'`, [T.tenant])
    expect(audits).toEqual([{ after: { change: 'RECORDED', fromVisit: true } }])
  })

  it('lists judgements anonymised; showing the page’s rows and opening one records a view per judgement', async () => {
    const list = await ok('hr', 'GET', `/safety/health/judgements?companyId=${T.companyA}`)
    expect(JSON.stringify(list)).not.toMatch(/outcome|taskLimits|unfitUntil|employee|Seed /)
    expect(list.judgements.find((row: Json) => row.id === judgementId)).toMatchObject({ judgedOn: today, state: 'IN_FORCE', fromVisit: true, hasCopy: false })
    expect(list.judgements.find((row: Json) => row.id === health.judgementIds.e1Limits).state).toBe('SUPERSEDED')
    expect(list.judgements.find((row: Json) => row.id === health.judgementIds.e3Voided).state).toBe('VOIDED')
    // One person (the Employee › Safety tab): still anonymised.
    const e2 = await ok('hr', 'GET', `/safety/health/judgements?employeeId=${people.employeeIds.e2}`)
    expect(e2.judgements.map((row: Json) => [row.id, row.state])).toEqual([[health.judgementIds.e2Unfit, 'EXPIRING']])
    const before = (await views(ACTORS.hr)).length
    const shown = await ok('hr', 'POST', '/safety/health/judgements/show', { judgementIds: [judgementId, health.judgementIds.e2Unfit] })
    expect(shown.judgements.map((row: Json) => [row.employee.id, row.outcome, row.unfitUntil !== null])).toEqual([
      [people.employeeIds.e1, 'FIT_WITH_LIMITS', false],
      [people.employeeIds.e2, 'TEMPORARILY_UNFIT', true],
    ])
    // One view per row shown, in the same command (the same moment: their order is not kept).
    const shownViews = (await views(ACTORS.hr)).slice(before)
    expect(shownViews).toHaveLength(2)
    expect(shownViews).toEqual(expect.arrayContaining([
      { recordType: 'FITNESS_JUDGEMENT', recordId: judgementId, employeeId: people.employeeIds.e1, what: 'OPEN', companyId: T.companyA },
      { recordType: 'FITNESS_JUDGEMENT', recordId: health.judgementIds.e2Unfit, employeeId: people.employeeIds.e2, what: 'OPEN', companyId: T.companyA },
    ]))
    const opened = await ok('doctor', 'POST', `/safety/health/judgements/${judgementId}/open`)
    expect(opened.judgement).toMatchObject({ taskLimits: 'No lifting over 10 kg; ear defenders at the press.', doctor: { id: safety.appointmentIds.doctor }, visit: { type: 'PERIODIC', doneOn: today }, voided: null })
    expect((await call('hrB', 'POST', `/safety/health/judgements/${judgementId}/open`)).statusCode).toBe(404)
    expect((await ok('hrB', 'POST', '/safety/health/judgements/show', { judgementIds: [judgementId] })).recorded).toBe(false)
  })

  it('keeps the copy as the office’s own file, through this module only', async () => {
    const pdf = { originalName: 'made-up-judgement.pdf', contentType: 'application/pdf', sizeBytes: 2000, sha256: 'b'.repeat(64) }
    const upload = await ok('hr', 'POST', `/safety/health/judgements/${judgementId}/copy`, pdf, 201)
    const [file] = await admin(`SELECT visibility::text[] AS visibility, "floorSiteId", "partyId", "recordType", kind::text AS kind FROM "StoredFile" WHERE id = $1`, [upload.file.id])
    expect(file).toEqual({ visibility: ['OFFICE'], floorSiteId: null, partyId: null, recordType: 'FitnessJudgement', kind: 'DOCUMENT' })
    // The generic files routes neither take nor show a judgement's copy.
    const generic = await call('officer', 'POST', '/files', { companyId: T.companyA, recordType: 'FitnessJudgement', recordId: judgementId, kind: 'DOCUMENT', ...pdf })
    expect(generic.statusCode, generic.body).toBe(409)
    expect(generic.body).toContain('/safety/health/judgements/:judgementId/copy')
    expect((await ok('officer', 'GET', `/files?recordType=FitnessJudgement&recordId=${judgementId}`)).files ?? []).toEqual([])
    expect((await call('viewer', 'POST', `/safety/health/judgements/${judgementId}/copy`, pdf)).statusCode).toBe(403)
  })

  it('voids a judgement on the wrong person (its limits cleared), once; it is never changed', async () => {
    const voided = await ok('hr', 'POST', `/safety/health/judgements/${judgementId}/void`, { version: 1, reason: 'WRONG_PERSON' })
    expect(voided.judgement).toEqual({ id: judgementId, version: 2 })
    expect(await admin(`SELECT "taskLimits", "voidReason"::text AS "voidReason" FROM "FitnessJudgement" WHERE id = $1`, [judgementId])).toEqual([{ taskLimits: null, voidReason: 'WRONG_PERSON' }])
    expect(await no('hr', 'POST', `/safety/health/judgements/${judgementId}/void`, { version: 2, reason: 'DUPLICATE' }, 409)).toEqual(['refusal/JUDGEMENT_VOIDED'])
    const events = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'fitness_judgement.changed' ORDER BY "occurredAt"`, [T.tenant])
    expect(events.map((event) => event.payload)).toEqual([{ judgementId, change: 'RECORDED' }, { judgementId, change: 'VOIDED' }])
  })
})

describe('fit yes or no for "Authorise a machine", and who looked', () => {
  it('answers a boolean only, the check recorded without its answer', async () => {
    expect(await ok('production', 'POST', `/safety/health/people/${people.employeeIds.e2}/fitness`)).toEqual({ employeeId: people.employeeIds.e2, fit: false, today })
    expect(await ok('production', 'POST', `/safety/health/people/${people.employeeIds.e3}/fitness`)).toEqual({ employeeId: people.employeeIds.e3, fit: true, today })
    // E1's newest is voided: the seed's fit with limits (expiring in 20 days) is the one in force again.
    expect((await ok('production', 'POST', `/safety/health/people/${people.employeeIds.e1}/fitness`)).fit).toBe(true)
    const audits = await admin<{ after: Json; recordId: string }>(`SELECT after, "recordId" FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'safety.checkFitness' ORDER BY at`, [T.tenant])
    expect(audits.map((row) => row.after)).toEqual([{ asked: 'FIT_YES_NO' }, { asked: 'FIT_YES_NO' }, { asked: 'FIT_YES_NO' }])
    expect((await call('hr', 'POST', `/safety/health/people/${people.employeeIds.e2}/fitness`)).statusCode).toBe(403)
  })

  it('shows HR who looked at a person’s records and who checked their fitness; the lists of a company; nobody else', async () => {
    const e1 = await ok('hr', 'GET', `/safety/health/views?employeeId=${people.employeeIds.e1}`)
    expect(e1.views.filter((row: Json) => row.viewer.id === ACTORS.hr).map((row: Json) => [row.recordType, row.what])).toEqual(expect.arrayContaining([['HEALTH_VISIT', 'OPEN'], ['FITNESS_JUDGEMENT', 'OPEN']]))
    expect(e1.views.some((row: Json) => row.viewer.id === ACTORS.doctor && row.recordType === 'FITNESS_JUDGEMENT')).toBe(true)
    expect(e1.fitnessChecks.map((row: Json) => row.viewer.id)).toEqual([ACTORS.production])
    const record = await ok('hr', 'GET', `/safety/health/views?recordType=HEALTH_VISIT&recordId=${health.visitIds.e1Return}`)
    expect(record.views.map((row: Json) => [row.viewer.id, row.what])).toEqual([[ACTORS.hr, 'OPEN']])
    const lists = await ok('hr', 'GET', `/safety/health/views?companyId=${T.companyA}&lists=true`)
    // The due list twice, the proposals (names beside "needs a visit") and the doctor's print (beside the seed's print).
    const mine = new Set(Object.values(ACTORS))
    expect(lists.views.filter((row: Json) => mine.has(row.viewer.id)).map((row: Json) => row.what).sort()).toEqual(['LIST', 'LIST', 'LIST', 'PRINT'])
    expect(lists.views.every((row: Json) => row.recordType === 'HEALTH_VISIT_LIST' && row.employee === null)).toBe(true)
    expect((await call('doctor', 'GET', `/safety/health/views?employeeId=${people.employeeIds.e1}`)).statusCode).toBe(403)
    expect((await call('hrB', 'GET', `/safety/health/views?employeeId=${people.employeeIds.e1}`)).statusCode).toBe(404)
    expect(await no('hr', 'GET', `/safety/health/views?recordType=HEALTH_VISIT`, undefined, 400)).toEqual(['query'])
  })
})

describe('the due list builds itself, only from plans the doctor set (live use waits for the doctor)', () => {
  it('a return after more than 60 days of sickness: only where the ATTENDANCE gate is open, the absence’s length only', async () => {
    const codeId = newId()
    await admin(`INSERT INTO "AbsenceCode" (id, "tenantId", code, "labelI18n", category, paid, "updatedAt") VALUES ($1, $2, 'MALT', '{"it":"Malattia (prova)","en":"Sickness (test)"}', 'SICKNESS', true, now())`, [codeId, T.tenant])
    let lastAbsent = ''
    for (let d = 80; d >= 2; d--) {
      const day = addDays(today, -d)
      const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay()
      if (weekday === 0 || weekday === 6) continue
      lastAbsent = day
      await admin(`INSERT INTO "AbsenceEntry" (id, "tenantId", "companyId", "employeeId", date, "codeId", minutes, "documentRef", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, 480, 'PROT-0001', now())`, [newId(), T.tenant, T.companyA, people.employeeIds.e3, day, codeId])
    }
    const returnsOf = () => admin<Json>(`SELECT "absenceDays", "dueOn"::text AS "dueOn", status::text AS status, "planId" FROM "HealthVisit" WHERE "employeeId" = $1 AND type = 'RETURN_AFTER_ABSENCE'`, [people.employeeIds.e3])
    const log = { info: () => undefined, error: () => undefined, warn: () => undefined } as never
    await dueListForTenant(system(), COMMAND_SETTINGS, log, T.tenant)
    expect(await returnsOf()).toEqual([])
    const notice = (await admin<{ id: string }>(`SELECT id FROM "PrivacyNotice" WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = 'WORKER_FLOOR' AND status = 'PUBLISHED'`, [T.tenant, T.companyA]))[0]!.id
    const dpia = (await admin<{ id: string }>(`SELECT id FROM "PrivacyDpia" WHERE "tenantId" = $1 AND "companyId" = $2 AND status = 'STORED'`, [T.tenant, T.companyA]))[0]!.id
    await admin(
      `INSERT INTO "PeopleLegalGate" (id, "tenantId", "companyId", "siteId", purpose, basis, "basisReference", "noticeId", "dpiaId", "switchedOnAt", "switchedOnById", "updatedAt")
       VALUES ($1, $2, $3, $4, 'ATTENDANCE', 'NOT_REQUIRED', 'SAMPLE - made-up counsel opinion (art. 4 c.2)', $5, $6, now() - interval '1 day', $7, now())`,
      [newId(), T.tenant, T.companyA, T.siteA1, notice, dpia, T.actor],
    )
    await dueListForTenant(system(), COMMAND_SETTINGS, log, T.tenant)
    const made = await returnsOf()
    expect(made).toHaveLength(1)
    // Due the day after the last absent day (before going back to work).
    expect(made[0]).toMatchObject({ status: 'DUE', dueOn: addDays(lastAbsent, 1), planId: health.planIds.machinist })
    expect(made[0]!.absenceDays).toBeGreaterThan(60)
    // Once per absence: a second pass plans nothing more.
    await dueListForTenant(system(), COMMAND_SETTINGS, log, T.tenant)
    expect(await returnsOf()).toHaveLength(1)
  })

  it('a role change asks a change-of-task visit from a plan the doctor set, and nothing from a plan without its doctor', async () => {
    await admin(`UPDATE "Employee" SET "roleSheetId" = $2 WHERE id = $1`, [people.employeeIds.e2, safety.roleSheetIds.cutter])
    const settings = COMMAND_SETTINGS
    const eventId = newId()
    expect(await visitOnRoleChange(system(), settings, { employeeId: people.employeeIds.e2, fromRoleSheetId: safety.roleSheetIds.machinist, toRoleSheetId: safety.roleSheetIds.cutter }, eventId)).toBe(true)
    expect(await visitOnRoleChange(system(), settings, { employeeId: people.employeeIds.e2, fromRoleSheetId: safety.roleSheetIds.machinist, toRoleSheetId: safety.roleSheetIds.cutter }, newId())).toBe(false)
    expect(await admin(`SELECT type::text AS type, "dueOn"::text AS "dueOn", "roleSheetId", "planId" FROM "HealthVisit" WHERE "employeeId" = $1 AND type = 'CHANGE_OF_TASK'`, [people.employeeIds.e2])).toEqual([{ type: 'CHANGE_OF_TASK', dueOn: today, roleSheetId: safety.roleSheetIds.cutter, planId: health.planIds.cutter }])
    // The machinist plan without its doctor: nothing plans itself.
    const plan = (await ok('officer', 'GET', '/safety/health/plans')).plans.find((row: Json) => row.role.code === 'SEW')
    await ok('officer', 'PATCH', `/safety/health/plans/${plan.id}`, { version: plan.version, doctorAppointmentId: null })
    await admin(`UPDATE "Employee" SET "roleSheetId" = $2 WHERE id = $1`, [people.employeeIds.e1, safety.roleSheetIds.machinist])
    expect(await visitOnRoleChange(system(), settings, { employeeId: people.employeeIds.e1, fromRoleSheetId: safety.roleSheetIds.cutter, toRoleSheetId: safety.roleSheetIds.machinist }, newId())).toBe(false)
    await admin(`UPDATE "Employee" SET "roleSheetId" = $2 WHERE id = $1`, [people.employeeIds.e1, safety.roleSheetIds.cutter])
  })

  it('a leaving plans the end-of-employment visit the plan asks; the leaver step names it once it took place', async () => {
    const plan = (await ok('officer', 'GET', '/safety/health/plans')).plans.find((row: Json) => row.role.code === 'CUT')
    await ok('doctor', 'PATCH', `/safety/health/plans/${plan.id}`, { version: plan.version, endOfEmploymentVisit: true })
    const lastWorkingDay = addDays(today, 30)
    const leaver = (await ok('hr', 'POST', `/people/employees/${people.employeeIds.e1}/leaving`, { lastWorkingDay, exitVisit: true }, 201)).leaver
    expect(await visitsOnLeaving(system(), COMMAND_SETTINGS, 'leaver.started', { caseId: leaver.id, employeeId: people.employeeIds.e1 }, newId())).toBe(1)
    const opened = await ok('hr', 'POST', `/people/leavers/${leaver.id}/exit-visit/open`)
    expect(opened).toMatchObject({ planAsks: true, recorded: true, step: { status: 'OPEN' }, visits: [{ dueOn: lastWorkingDay, status: 'DUE' }] })
    const visit = opened.visits[0]
    expect((await views(ACTORS.hr)).at(-1)).toMatchObject({ recordType: 'HEALTH_VISIT', recordId: visit.id, what: 'OPEN' })
    expect(await no('hr', 'POST', `/people/leavers/${leaver.id}/steps/${opened.step.id}/exit-visit`, { version: opened.step.version, visitId: visit.id }, 409)).toEqual(['refusal/EXIT_VISIT_NOT_DONE', 'body/visitId'])
    await ok('hr', 'POST', `/safety/health/visits/${visit.id}/done`, { version: visit.version, doneOn: today })
    const stepped = (await ok('hr', 'POST', `/people/leavers/${leaver.id}/steps/${opened.step.id}/exit-visit`, { version: opened.step.version, visitId: visit.id })).leaver
    expect(stepped.steps.find((step: Json) => step.kind === 'EXIT_VISIT')).toMatchObject({ status: 'DONE', recordType: 'HealthVisit', recordId: visit.id })
    // Without the health permission the step is refused in words (whether a person needs a visit is protected).
    expect((await call('production', 'POST', `/people/leavers/${leaver.id}/exit-visit/open`)).statusCode).toBe(403)
  })
})
