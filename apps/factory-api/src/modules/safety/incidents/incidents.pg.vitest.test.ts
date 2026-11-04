import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPeople } from '../../../../../../packages/factory-db/seed/people'
import { seed as seedPlant, type PlantSeed } from '../../../../../../packages/factory-db/seed/plant'
import { seed as seedSafety, type SafetySeed } from '../../../../../../packages/factory-db/seed/safety'
import { seed as seedHealth, type HealthSeed } from '../../../../../../packages/factory-db/seed/health'
import { seed as seedPlantCare } from '../../../../../../packages/factory-db/seed/plantcare'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { SYSTEM_ACTOR_ID, testAuthenticator, type FloorContext, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { applyQueued } from '../../../platform/floor-sync/kinds'
import { ruleContext } from '../../../platform/notifications/fan-out'
import { systemContext } from '../../../platform/outbox/system'
import { hazardOnLock } from './handlers'
import { INCIDENT_RULES } from './notices'

/**
 * Incidents, near misses and hazards (B-W2b-125; QHS-265, QHS-268, QHS-270) on the local stack with the app's real routes: a
 * throwaway PostgreSQL 17 database from the migrations (the runtime logins: row-level security and the
 * …_protected_safety_w2b_guards triggers are real, the floor's report is written in the floor scope), the factory-db seeds of
 * one tenant up to the health pages (E1's cut from A1's cutting tablet with its INSURANCE filing DUE, the press's guard hazard,
 * a closed near miss), office and floor sessions from the test authenticator. Every name is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/safety/incidents`.
 */

let h: Harness
let database: Harness['database']
let app: FastifyInstance
let plant: PlantSeed
let safety: SafetySeed
let health: HealthSeed

const NS = 'w2b125-incidents'
const idOf = (key: string): string => seedUuid(NS, key)
const T = {
  tenant: idOf('tenant'),
  companyA: idOf('company:A'),
  companyB: idOf('company:B'),
  siteA1: idOf('site:A1'),
  siteB1: idOf('site:B1'),
  operator: idOf('worker:A1:operator'),
  lead: idOf('worker:A1:lead'),
  tablet: idOf('device:A1:cutting'),
  cutStation: idOf('site:A1:station:CUT-01'),
  otherTablet: newId(),
}
const OFFICER_ID = newId()
const HR_ID = newId()
const VIEWER_ID = newId()
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const floor = (workerId: string, deviceId: string): SessionContext => ({ audience: 'floor', tenantId: T.tenant, actorId: workerId, siteId: T.siteA1, deviceId, grants: [grant(['floor.work'], [T.companyA], [T.siteA1])] })
const OFFICER: Permission[] = ['safety.incidents.view', 'safety.incidents.report', 'safety.incidents.manage', 'safety.incidents.people', 'plant.view', 'plant.report', 'files.read', 'files.upload']
const SESSIONS: Record<string, SessionContext> = {
  officer: { audience: 'office', tenantId: T.tenant, actorId: OFFICER_ID, grants: [grant(OFFICER)] },
  hr: { audience: 'office', tenantId: T.tenant, actorId: HR_ID, grants: [grant(['safety.incidents.view', 'safety.incidents.report', 'safety.incidents.people'])] },
  viewer: { audience: 'office', tenantId: T.tenant, actorId: VIEWER_ID, grants: [grant(['safety.incidents.view', 'safety.incidents.report', 'files.read', 'files.upload'])] },
  companyB: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(OFFICER, [T.companyB])] },
  sales: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['quotes.view', 'files.read'])] },
  tablet: floor(T.operator, T.tablet),
  other: floor(T.lead, T.otherTablet),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const run = randomBytes(4).toString('hex')
let keys = 0
const fresh = () => `t-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown, key: string = fresh()) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<string[]> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json().error.issues ?? []).map((issue: Json) => String(issue.path))
}
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()

beforeAll(async () => {
  h = await startHarness('w2b125_incidents')
  database = h.database
  await seedCore({ db: database, namespace: NS })
  await seedAuth({ db: database, namespace: NS })
  await seedRoles({ db: database, namespace: NS })
  await seedFiles({ db: database, namespace: NS })
  await seedNumbering({ db: database, namespace: NS })
  await seedPeople({ db: database, namespace: NS })
  plant = await seedPlant({ db: database, namespace: NS })
  safety = await seedSafety({ db: database, namespace: NS })
  health = await seedHealth({ db: database, namespace: NS })
  await seedPlantCare({ db: database, namespace: NS })
  // The operator's employee record (the people seed links worker and employee).
  E1 = (await admin<{ employeeId: string }>(`SELECT "employeeId" FROM "Worker" WHERE id = $1`, [T.operator]))[0]!.employeeId
  E2 = (await admin<{ id: string }>(`SELECT id FROM "Employee" WHERE "companyId" = $1 AND "siteId" = $2 AND status = 'ACTIVE' AND id <> $3 ORDER BY id LIMIT 1`, [T.companyA, T.siteA1, E1]))[0]!.id
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [T.tenant])
  for (const [id, name] of [[OFFICER_ID, 'Made-up Officer'], [HR_ID, 'Made-up HR'], [VIEWER_ID, 'Made-up Viewer']] as const) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [id, T.tenant, `${id}@example.test`, name])
  }
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, 'Made-up other tablet', 'TABLET', 'ACTIVE', now())`, [T.otherTablet, T.tenant, T.companyA, T.siteA1])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

let E1: string
let E2: string
let named: Json
let anonymous: Json

describe('reporting from a tablet in three taps (QHS-265)', () => {
  it('reports an injury with the worker and the tablet, numbered from the company’s series, the person written but never read back', async () => {
    const key = fresh()
    const answer = await ok('tablet', 'POST', '/safety/floor/incidents', { kind: 'INJURY', here: true, language: 'en', people: [{ who: 'ME', involvement: 'INJURED', bodyParts: ['HAND'], bodySide: 'LEFT', nature: 'CUT', firstAidGiven: true }] }, 201, key)
    named = answer.incident
    expect(named).toMatchObject({ number: expect.stringMatching(/^INC-\d{4}-\d{4}$/), kind: 'INJURY', status: 'OPEN', anonymous: false })
    const [row] = await admin(`SELECT "reportedVia"::text AS via, "reporterAnonymous", "reportedByWorkerId", "deviceId", "stationId", what FROM "Incident" WHERE id = $1`, [named.id])
    expect(row).toEqual({ via: 'FLOOR', reporterAnonymous: false, reportedByWorkerId: T.operator, deviceId: T.tablet, stationId: T.cutStation, what: 'Someone was hurt (reported from a tablet).' })
    expect(await admin(`SELECT "employeeId", involvement::text AS involvement FROM "IncidentPerson" WHERE "incidentId" = $1`, [named.id])).toEqual([{ employeeId: E1, involvement: 'INJURED' }])
    // The audit row names the worker and the tablet, and the people only as counts.
    const [audit] = await admin(`SELECT "actorId", "deviceId", after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'safety.reportIncident'`, [named.id])
    expect(audit).toMatchObject({ actorId: T.operator, deviceId: T.tablet, after: { people: 1, injured: 1 } })
    expect(JSON.stringify(audit!.after)).not.toContain(E1)
    // The same key answers the same report.
    expect((await ok('tablet', 'POST', '/safety/floor/incidents', { kind: 'INJURY', here: true, language: 'en', people: [{ who: 'ME', involvement: 'INJURED', bodyParts: ['HAND'], bodySide: 'LEFT', nature: 'CUT', firstAidGiven: true }] }, 200, key)).incident.id).toBe(named.id)
  })

  it('sends a hazard without a name: no worker and no tablet in any row it leaves (audit, number ledger, receipt, event)', async () => {
    const key = `${T.tablet}.${newId()}`
    anonymous = (await ok('tablet', 'POST', '/safety/floor/incidents', { kind: 'HAZARD', anonymous: true, place: 'Made-up stairs to the mezzanine' }, 201, key)).incident
    expect(anonymous).toMatchObject({ kind: 'HAZARD', anonymous: true })
    const [row] = await admin(`SELECT "reporterAnonymous", "reportedByWorkerId", "deviceId", "createdById", "reportedVia"::text AS via FROM "Incident" WHERE id = $1`, [anonymous.id])
    expect(row).toEqual({ reporterAnonymous: true, reportedByWorkerId: null, deviceId: null, createdById: null, via: 'FLOOR' })
    const audits = await admin(`SELECT "actorId", "deviceId", "requestId", "idempotencyKey", audience::text AS audience FROM "AuditLog" WHERE "recordId" = $1`, [anonymous.id])
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ actorId: SYSTEM_ACTOR_ID, deviceId: SYSTEM_ACTOR_ID, audience: 'FLOOR', idempotencyKey: expect.stringMatching(/^anon\./) })
    expect(audits[0]!.idempotencyKey).not.toContain(T.tablet)
    const sameRequest = await admin(`SELECT "actorId", "deviceId" FROM "AuditLog" WHERE "requestId" = $1`, [audits[0]!.requestId])
    expect(sameRequest.every((other) => other.actorId !== T.operator && other.deviceId !== T.tablet)).toBe(true)
    expect(await admin(`SELECT "allocatedById" FROM "NumberAllocation" WHERE "recordId" = $1`, [anonymous.id])).toEqual([{ allocatedById: SYSTEM_ACTOR_ID }])
    const receipts = await admin(`SELECT key, "actorId", "siteId" FROM "IdempotencyReceipt" WHERE scope = 'safety.reportIncident' AND key = $1`, [audits[0]!.idempotencyKey])
    expect(receipts).toEqual([{ key: audits[0]!.idempotencyKey, actorId: SYSTEM_ACTOR_ID, siteId: T.siteA1 }])
    const [event] = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'incident.reported' AND subject = $1`, [anonymous.id])
    expect(event!.payload).toEqual({ incidentId: anonymous.id, number: anonymous.number, kind: 'HAZARD', reportedVia: 'FLOOR', anonymous: true, fromRequestId: null })
    // A resend with the same key answers from the same receipt.
    expect((await ok('tablet', 'POST', '/safety/floor/incidents', { kind: 'HAZARD', anonymous: true, place: 'Made-up stairs to the mezzanine' }, 200, key)).incident.id).toBe(anonymous.id)
  })

  it('refuses an injury without a name, a report without a name that names people, and one kept in the queue', async () => {
    expect(await no('tablet', 'POST', '/safety/floor/incidents', { kind: 'INJURY', anonymous: true, here: true }, 409)).toContain('refusal/ANONYMOUS_INJURY')
    expect(await no('tablet', 'POST', '/safety/floor/incidents', { kind: 'NEAR_MISS', anonymous: true, here: true, people: [{ who: 'OUTSIDE', outsideName: 'Made-up visitor', involvement: 'INVOLVED' }] }, 409)).toContain('refusal/ANONYMOUS_NAMES_NOBODY')
    expect(await no('tablet', 'POST', '/safety/floor/incidents', { kind: 'HAZARD' }, 409)).toContain('refusal/WHERE_MISSING')
    expect(await no('tablet', 'POST', '/safety/floor/incidents', { kind: 'HAZARD', place: 'x', people: [{ who: 'ME', involvement: 'INJURED' }] }, 409)).toContain('refusal/INJURED_NOT_INJURY')
    const caller = callerFor(database, { ...(SESSIONS.tablet as FloorContext), requestId: newId() })
    const refused = await applyQueued(caller, { clientEventId: newId(), kind: 'safety.incident.report', payload: { kind: 'HAZARD', anonymous: true, place: 'x' } }, { key: `${T.tablet}.${newId()}` })
    expect(refused).toMatchObject({ status: 'refused', refusal: { code: 'ANONYMOUS_NOT_QUEUED' } })
    const queued = await applyQueued(caller, { clientEventId: newId(), kind: 'safety.incident.report', occurredAt: hoursAgo(1), payload: { kind: 'NEAR_MISS', here: true, language: 'it' } }, { key: `${T.tablet}.${newId()}` })
    expect(queued).toMatchObject({ status: 'accepted', result: { type: 'Incident' } })
  })

  it('tells the tablet "seen by safety" for its own report only, and lets it add photos within 30 minutes', async () => {
    expect((await ok('tablet', 'GET', `/safety/floor/incidents/${named.id}`)).incident).toMatchObject({ id: named.id, seenAt: null })
    expect((await call('other', 'GET', `/safety/floor/incidents/${named.id}`)).statusCode).toBe(404)
    // A report without a name is read by its id (nothing names its tablet).
    expect((await ok('other', 'GET', `/safety/floor/incidents/${anonymous.id}`)).incident.id).toBe(anonymous.id)
    const photo = { originalName: 'made-up-guard.jpg', contentType: 'image/jpeg', sizeBytes: 1000, sha256: 'a'.repeat(64) }
    const upload = await ok('tablet', 'POST', `/safety/floor/incidents/${named.id}/photos`, photo, 201)
    const [file] = await admin(`SELECT visibility::text[] AS visibility, "floorSiteId", "recordType", status::text AS status FROM "StoredFile" WHERE id = $1`, [upload.file.id])
    expect(file).toEqual({ visibility: ['OFFICE'], floorSiteId: null, recordType: 'Incident', status: 'PENDING_UPLOAD' })
    expect((await call('other', 'POST', `/safety/floor/incidents/${named.id}/photos`, photo)).statusCode).toBe(404)
    // The seeded cut was reported two days ago: the office adds its photos now.
    expect(await no('tablet', 'POST', `/safety/floor/incidents/${health.incidentIds.cut}/photos`, photo, 409)).toContain('refusal/PHOTO_WINDOW')
    // The generic files routes never reach an incident's file.
    expect((await call('officer', 'GET', `/files/${upload.file.id}`)).statusCode).toBe(404)
    expect((await call('officer', 'POST', '/files', { companyId: T.companyA, recordType: 'Incident', recordId: named.id, kind: 'PHOTO', ...photo })).statusCode).toBe(409)
  })

  it('gives the tablet the emergency number, the first aiders in force and "here: this station"', async () => {
    const start = await ok('tablet', 'GET', '/safety/floor/incidents/start')
    expect(start.emergency.number).toBe('112')
    expect(start.emergency.firstAiders.length).toBeGreaterThan(0)
    expect(start.here.station.id).toBe(T.cutStation)
    expect(start.areas.length).toBeGreaterThan(0)
  })
})

describe('the record, anonymised, and the protected people (QHS-270)', () => {
  it('shows everyone with the view what, where and the deadlines, the people as a count, the reporter hidden while the site names no workers', async () => {
    const record = (await ok('viewer', 'GET', `/safety/incidents/${named.id}`)).incident
    expect(record).toMatchObject({ number: named.number, kind: 'INJURY', people: { count: 1, injured: 1, canOpen: false }, canManage: false, canPeople: false, reporter: { kind: 'WORKER', name: null, hidden: true } })
    expect(JSON.stringify(record)).not.toContain(E1)
    expect((await ok('viewer', 'GET', `/safety/incidents/${anonymous.id}`)).incident.reporter).toEqual({ kind: 'ANONYMOUS', name: null, hidden: false, device: null })
    expect(await no('viewer', 'POST', `/safety/incidents/${named.id}/people/open`, undefined, 403)).toEqual([])
    expect((await call('sales', 'GET', '/safety/incidents')).statusCode).toBe(403)
    expect((await ok('companyB', 'GET', '/safety/incidents')).incidents.every((row: Json) => row.companyId === T.companyB)).toBe(true)
  })

  it('records every view of the people and the filings (who, whose, when) before it shows them, and keeps no value in a receipt', async () => {
    const opened = await ok('officer', 'POST', `/safety/incidents/${named.id}/people/open`)
    expect(opened.people).toEqual([expect.objectContaining({ involvement: 'INJURED', employee: { id: E1, name: expect.any(String) }, bodyParts: ['HAND'], bodySide: 'LEFT', nature: 'CUT', firstAidGiven: true })])
    const views = await admin(`SELECT "recordType"::text AS type, "recordId", "employeeId", what::text AS what, "viewerId" FROM "ProtectedView" WHERE "viewerId" = $1`, [OFFICER_ID])
    expect(views).toEqual([{ type: 'INCIDENT_PERSON', recordId: opened.people[0].id, employeeId: E1, what: 'OPEN', viewerId: OFFICER_ID }])
    const shown = await ok('officer', 'POST', '/safety/incidents/people', { incidentIds: [named.id, health.incidentIds.cut] })
    expect(shown.incidents).toHaveLength(2)
    expect((await admin(`SELECT count(*)::int AS n FROM "ProtectedView" WHERE "viewerId" = $1 AND "recordType" = 'INCIDENT_PEOPLE_LIST'`, [OFFICER_ID]))[0]!.n).toBe(1)
    const receipts = await admin(`SELECT response::text AS response FROM "IdempotencyReceipt" WHERE scope LIKE 'safety.%'`)
    expect(receipts.some((row) => row.response.includes('HAND') || row.response.includes('"CUT"'))).toBe(false)
  })

  it('lets the safety roles correct the people while the incident is open, never a value in the answer or the audit row', async () => {
    const person = (await ok('officer', 'POST', `/safety/incidents/${named.id}/people`, { involvement: 'INVOLVED', outsideName: 'Made-up contractor' }, 201)).person
    expect(person).toEqual({ id: expect.any(String), version: 1 })
    expect(await no('officer', 'POST', `/safety/incidents/${anonymous.id}/people`, { involvement: 'INJURED', outsideName: 'Made-up visitor' }, 409)).toContain('refusal/INJURED_NOT_INJURY')
    expect(await no('officer', 'POST', `/safety/incidents/${named.id}/people`, { involvement: 'INVOLVED', employeeId: E1 }, 409)).toContain('refusal/PERSON_TWICE')
    await ok('officer', 'POST', `/safety/incidents/${named.id}/people/${person.id}/remove`, { version: 1 })
    const [audit] = await admin(`SELECT after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'safety.addIncidentPerson'`, [person.id])
    expect(JSON.stringify(audit!.after)).not.toContain('Made-up contractor')
  })
})

describe('the INAIL deadline (QHS-268; D.Lgs. 81/2008 art. 18 c.1 r)', () => {
  let personId: string
  let statistical: Json

  it('opens the filing an absence calls for, starts the 48-hour clock at the certificate and keeps three reminders', async () => {
    personId = (await ok('officer', 'POST', `/safety/incidents/${named.id}/people/open`)).people[0].id
    expect(await no('officer', 'POST', `/safety/incidents/${named.id}/filings`, { incidentPersonId: personId, expectedAbsenceDays: 0 }, 409)).toContain('refusal/NO_FILING_NEEDED')
    const added = await ok('hr', 'POST', `/safety/incidents/${named.id}/filings`, { incidentPersonId: personId, expectedAbsenceDays: 2 }, 201)
    statistical = added.filings[0]
    expect(statistical).toMatchObject({ status: 'WAITING_CERTIFICATE', dueAt: null })
    expect(JSON.stringify(added)).not.toMatch(/STATISTICAL|INSURANCE/)
    const received = new Date().toISOString()
    const due = await ok('hr', 'PATCH', `/safety/incidents/${named.id}/filings/${statistical.id}`, { version: 1, certificateReference: 'MADE-UP-CERT-1', certificateReceivedAt: received })
    expect(due.filing).toMatchObject({ status: 'DUE', dueAt: new Date(new Date(received).getTime() + 48 * 3_600_000).toISOString() })
    const timers = await admin(`SELECT "timerKey", status::text AS status FROM "DueTimer" WHERE "recordType" = 'InailFiling' AND "recordId" = $1 ORDER BY "fireAt"`, [statistical.id])
    expect(timers).toEqual([
      { timerKey: 'INAIL_FILING_DUE:-24h', status: 'PENDING' },
      { timerKey: 'INAIL_FILING_DUE:-4h', status: 'PENDING' },
      { timerKey: 'INAIL_FILING_DUE', status: 'PENDING' },
    ])
    // The record and the tiles count down, anonymised (no type, no person).
    const record = (await ok('viewer', 'GET', `/safety/incidents/${named.id}`)).incident
    expect(record.inail.deadlines.find((deadline: Json) => deadline.id === statistical.id)).toMatchObject({ state: 'DUE', countdown: { hoursLeft: 47, under24h: false, late: false } })
    expect(record.inail.rule).toMatchObject({ law: 'D.Lgs. 81/2008 art. 18 c.1 r', statisticalFromDays: 1, insuranceAboveDays: 3, hoursAfterCertificate: 48 })
    expect((await ok('viewer', 'GET', '/safety/incidents/rules')).reminders.hoursBefore).toEqual([24, 4, 0])
    // The seeded INSURANCE filing of the cut (certificate yesterday 09:00 UTC) is the band's nearest deadline.
    const counts = await ok('viewer', 'GET', '/safety/incidents/counts')
    expect(counts.next).toMatchObject({ number: expect.any(String), countdown: { late: false } })
    expect(counts.tiles.inailOpen).toBeGreaterThanOrEqual(2)
  })

  it('adds the insurance report when the absence grows past three days; holds the close while a filing waits', async () => {
    const grown = await ok('hr', 'PATCH', `/safety/incidents/${named.id}/filings/${statistical.id}`, { version: 2, expectedAbsenceDays: 6 })
    expect(grown.added).toEqual([expect.objectContaining({ status: 'WAITING_CERTIFICATE' })])
    expect(await no('officer', 'POST', `/safety/incidents/${named.id}/close`, { version: (await ok('officer', 'GET', `/safety/incidents/${named.id}`)).incident.version }, 409)).toContain('refusal/FILING_WAITING')
    const filings = (await ok('officer', 'POST', `/safety/incidents/${named.id}/filings/open`)).filings
    expect(filings.map((filing: Json) => filing.type).sort()).toEqual(['INSURANCE', 'STATISTICAL'])
    expect((await admin(`SELECT count(*)::int AS n FROM "ProtectedView" WHERE "viewerId" = $1 AND "recordType" = 'INAIL_FILING'`, [OFFICER_ID]))[0]!.n).toBe(2)
    const insurance = filings.find((filing: Json) => filing.type === 'INSURANCE')
    await ok('hr', 'POST', `/safety/incidents/${named.id}/filings/${insurance.id}/not-needed`, { version: insurance.version })
  })

  it('records the filing sent on the INAIL portal with its protocol number; its reminders stop', async () => {
    expect(await no('hr', 'POST', `/safety/incidents/${named.id}/filings/${statistical.id}/file`, { version: 3, filedAt: new Date(Date.now() + 3_600_000).toISOString(), protocolNumber: 'MADE-UP-1' }, 409)).toContain('refusal/FILED_IN_FUTURE')
    const filed = await ok('hr', 'POST', `/safety/incidents/${named.id}/filings/${statistical.id}/file`, { version: 3, filedAt: new Date().toISOString(), protocolNumber: 'MADE-UP-PROT-1' })
    expect(filed.filing).toMatchObject({ status: 'FILED' })
    expect((await admin(`SELECT status::text AS status FROM "DueTimer" WHERE "recordId" = $1`, [statistical.id])).every((row) => row.status === 'CANCELLED')).toBe(true)
    expect(await no('hr', 'PATCH', `/safety/incidents/${named.id}/filings/${statistical.id}`, { version: 4, actualAbsenceDays: 3 }, 409)).toContain('refusal/FILING_FILED')
  })

  it('folds the passed reminders of a certificate recorded late into one that fires at once, and tells the people who keep the filings', async () => {
    // A second injury: its certificate came 45 hours ago (3 hours left): one reminder at once, one at the deadline.
    const injury = (await ok('officer', 'POST', '/safety/incidents', { companyId: T.companyA, siteId: T.siteA1, kind: 'INJURY', occurredAt: hoursAgo(50), what: 'Made-up burn at the press.', machineId: plant.machineIds[1], people: [{ involvement: 'INJURED', employeeId: E2, bodyParts: ['ARM'], nature: 'BURN' }] }, 201)).incident
    const person = (await ok('officer', 'POST', `/safety/incidents/${injury.id}/people/open`)).people[0]
    const filing = (await ok('hr', 'POST', `/safety/incidents/${injury.id}/filings`, { incidentPersonId: person.id, expectedAbsenceDays: 2, certificateReceivedAt: hoursAgo(45) }, 201)).filings[0]
    const timers = await admin(`SELECT id, "timerKey", "fireAt" FROM "DueTimer" WHERE "recordId" = $1 ORDER BY "fireAt"`, [filing.id])
    expect(timers.map((timer) => timer.timerKey)).toEqual(['INAIL_FILING_DUE:-4h', 'INAIL_FILING_DUE'])
    expect(new Date(timers[0]!.fireAt).getTime()).toBeLessThanOrEqual(Date.now())
    // The fan-out of the fired reminder: the owner (every permission) is told, in words naming the incident and the time only.
    const systemCaller = callerFor(database, systemContext(T.tenant, newId()))
    await admin(`UPDATE "DueTimer" SET status = 'FIRED', "firedAt" = now(), version = version + 1 WHERE id = $1`, [timers[0]!.id])
    const drafts = await systemCaller.withClient((client) => client.$transaction((tx) => INCIDENT_RULES[1]!.drafts(ruleContext(tx, T.tenant, new Date()), { timerId: timers[0]!.id, timerKey: 'INAIL_FILING_DUE:-4h', ruleId: null, recordType: 'InailFiling', recordId: filing.id })))
    expect(drafts.length).toBeGreaterThan(0)
    expect(drafts[0]).toMatchObject({ category: 'ALERT', messageKey: 'notifications.safety.inailDue', record: { type: 'Incident', id: injury.id, label: injury.number } })
    expect(JSON.stringify(drafts)).not.toMatch(/STATISTICAL|ARM|BURN/)
    // Filed: nobody is told any more.
    await ok('hr', 'POST', `/safety/incidents/${injury.id}/filings/${filing.id}/file`, { version: 1, filedAt: new Date().toISOString(), protocolNumber: 'MADE-UP-PROT-2' })
    const after = await systemCaller.withClient((client) => client.$transaction((tx) => INCIDENT_RULES[1]!.drafts(ruleContext(tx, T.tenant, new Date()), { timerId: timers[0]!.id, timerKey: 'INAIL_FILING_DUE:-4h', ruleId: null, recordType: 'InailFiling', recordId: filing.id })))
    expect(after).toEqual([])
  })
})

describe('actions become a job, a measure or a training session in one step; close and reopen', () => {
  it('makes each linked record with the incident as its source, and holds the close while an action is open', async () => {
    const guard = health.incidentIds.pressGuard
    const version = (await ok('officer', 'GET', `/safety/incidents/${guard}`)).incident.version
    const job = (await ok('officer', 'POST', `/safety/incidents/${guard}/actions`, { title: 'Refit the press guard', make: { into: 'MAINTENANCE_JOB' } }, 201)).action
    expect(job.madeInto).toBe('MAINTENANCE_JOB')
    expect(await admin(`SELECT source::text AS source, type::text AS type, "machineId" FROM "MaintenanceJob" WHERE id = $1`, [job.recordId])).toEqual([{ source: 'INCIDENT', type: 'SAFETY', machineId: plant.machineIds[1] }])
    const measure = (await ok('officer', 'POST', `/safety/incidents/${guard}/actions`, { title: 'Interlock on the press guard', make: { into: 'RISK_MEASURE', risk: 'Made-up crushing at the press' } }, 201)).action
    expect(await admin(`SELECT source::text AS source, "sourceRecordType", "sourceRecordId", "assessmentId" FROM "RiskMeasure" WHERE id = $1`, [measure.recordId])).toEqual([{ source: 'INCIDENT', sourceRecordType: 'Incident', sourceRecordId: guard, assessmentId: safety.assessmentId }])
    const plain = (await ok('officer', 'POST', `/safety/incidents/${guard}/actions`, { title: 'Brief the cutters' }, 201)).action
    const training = (await ok('officer', 'POST', `/safety/incidents/${guard}/actions/${plain.id}/make`, { version: 1, make: { into: 'TRAINING_SESSION', courseId: safety.courseIds.specificHigh, heldOn: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10), hours: '2', language: 'it', trainerName: 'Made-up Trainer' } })).action
    expect(await admin(`SELECT status::text AS status, "siteId" FROM "TrainingSession" WHERE id = $1`, [training.recordId])).toEqual([{ status: 'OPEN', siteId: T.siteA1 }])
    expect(await no('officer', 'POST', `/safety/incidents/${guard}/actions/${plain.id}/make`, { version: 2, make: { into: 'RISK_MEASURE' } }, 409)).toContain('refusal/MADE_ALREADY')
    expect(await no('officer', 'POST', `/safety/incidents/${guard}/close`, { version }, 409)).toContain('refusal/ACTIONS_OPEN')
    // A technician named on the job asks plant.jobs.manage: the officer holds none.
    expect((await call('officer', 'POST', `/safety/incidents/${guard}/actions`, { title: 'x', make: { into: 'MAINTENANCE_JOB', assigneeId: OFFICER_ID } })).statusCode).toBe(403)
    for (const action of [job, measure]) await ok('officer', 'POST', `/safety/incidents/${guard}/actions/${action.id}/done`, { version: 1, evidenceNote: 'Made-up evidence' })
    await ok('officer', 'POST', `/safety/incidents/${guard}/actions/${plain.id}/cancel`, { version: 2, reason: 'Made-up: briefed at the meeting' })
    const closed = await ok('officer', 'POST', `/safety/incidents/${guard}/close`, { version })
    expect(closed.incident.status).toBe('CLOSED')
    expect(await no('officer', 'PATCH', `/safety/incidents/${guard}`, { version: closed.incident.version, severity: 'NONE' }, 409)).toContain('refusal/NOT_OPEN')
    expect((await ok('officer', 'POST', `/safety/incidents/${guard}/reopen`, { version: closed.incident.version })).incident.status).toBe('OPEN')
  })

  it('marks it seen by safety once, tells the site’s tablets, and lets only the safety roles do it', async () => {
    expect((await call('viewer', 'POST', `/safety/incidents/${named.id}/seen`)).statusCode).toBe(403)
    const seen = await ok('officer', 'POST', `/safety/incidents/${named.id}/seen`)
    expect(seen.incident.first).toBe(true)
    expect((await ok('officer', 'POST', `/safety/incidents/${named.id}/seen`)).incident).toMatchObject({ first: false, seenAt: seen.incident.seenAt })
    expect((await ok('tablet', 'GET', `/safety/floor/incidents/${named.id}`)).incident.seenAt).toBe(seen.incident.seenAt)
    expect(await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'incident.seen' AND subject = $1`, [named.id])).toHaveLength(1)
  })
})

describe('a machine locked as unsafe opens a hazard report when the site asks for one', () => {
  it('opens one hazard, from the system, linked to the request; never twice; nothing when the site does not ask', async () => {
    const reported = await ok('officer', 'POST', '/plant/requests', { machineId: plant.machineIds[2], unsafe: true, down: false, description: 'Made-up loose blade cover' }, 201)
    const requestId = reported.request.id
    const system = callerFor(database, systemContext(T.tenant, newId()))
    const payload = { requestId, machineId: plant.machineIds[2], assetNumber: reported.machine.assetNumber }
    expect(await hazardOnLock(system, { ...payload, hazardReport: false })).toBeNull()
    const incidentId = await hazardOnLock(system, { ...payload, hazardReport: true })
    expect(incidentId).not.toBeNull()
    const [row] = await admin(`SELECT kind::text AS kind, "reportedVia"::text AS via, "reportedById", "maintenanceRequestId", "machineId", "immediateAction" FROM "Incident" WHERE id = $1`, [incidentId])
    expect(row).toMatchObject({ kind: 'HAZARD', via: 'OFFICE', reportedById: SYSTEM_ACTOR_ID, maintenanceRequestId: requestId, machineId: plant.machineIds[2] })
    expect(await hazardOnLock(system, { ...payload, hazardReport: true })).toBeNull()
    expect((await ok('viewer', 'GET', `/safety/incidents/${incidentId}`)).incident.reporter.kind).toBe('SYSTEM')
  })
})
