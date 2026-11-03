import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPlantCare, type PlantCareSeed } from '../../../../../../packages/factory-db/seed/plantcare'
import { seed as seedPlant, type PlantSeed } from '../../../../../../packages/factory-db/seed/plant'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import type { Clock } from '../../../core/time'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { fanOut } from '../../../platform/notifications/fan-out'
import { systemContext } from '../../../platform/outbox/system'
import { runEscalation } from './escalation'

/**
 * The requests and jobs in depth (B-W2b-96; QHS-179, QHS-180, QHS-181, QHS-183, QHS-189, QHS-190; Owner answer H1) on the
 * local stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime logins,
 * row-level security, the column grants and the …_plant_care_w2b_guards triggers are real), the factory-db seeds up to the
 * plant care seed (A1's routing: lockstitch → team L1-A, escalated to E2 after 10 minutes and E3 after 30; every other
 * class → E2, escalated to E3 after 15; A1's lock settings at H1), made-up tablets at SEW-01 (the station) and SEW-02 (the
 * technician), and a real maintenance lead with two-factor for the step-up. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/plant`.
 */

let h: Harness
let app: FastifyInstance
let plant: PlantSeed
let care: PlantCareSeed

const ns = 'plant-depth'
const idOf = (key: string) => seedUuid(ns, key)
const A = {
  tenant: idOf('tenant'),
  actor: idOf('actor'),
  companyA: idOf('company:A'),
  siteA1: idOf('site:A1'),
  sew1Station: idOf('site:A1:station:SEW-01'),
  sew2Station: idOf('site:A1:station:SEW-02'),
  operator: idOf('worker:A1:operator'),
  lead: idOf('worker:A1:lead'),
  e2: idOf('people:employee:A1:2'),
  e3: idOf('people:employee:A1:3'),
  teamL1A: idOf('people:team:A1:L1-A'),
  sewTablet: newId(),
  techTablet: newId(),
}
const TENANT: TestTenant = { id: A.tenant, slug: ns, companies: [{ id: A.companyA, code: 'A' }] }

const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (permissions: Permission[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: A.actor, grants: [grant(permissions)] })
const floor = (permissions: Permission[], actorId: string, deviceId: string): SessionContext => ({
  audience: 'floor',
  tenantId: A.tenant,
  actorId,
  siteId: A.siteA1,
  deviceId,
  grants: [{ permissions, companies: [A.companyA], sites: [A.siteA1], parties: 'all' }],
})
const MANAGE: Permission[] = ['plant.view', 'plant.machines.manage', 'plant.report', 'plant.requests.triage', 'plant.jobs.manage', 'plant.jobs.work', 'plant.settings.manage']
const SESSIONS: Record<string, SessionContext> = {
  manager: office(MANAGE),
  viewer: office(['plant.view']),
  station: floor(['floor.work', 'plant.report'], idOf('worker:A1:operator'), A.sewTablet),
  technician: floor(['floor.work', 'plant.report', 'plant.jobs.work'], idOf('worker:A1:lead'), A.techTablet),
  lead: floor(['floor.work', 'floor.lead', 'plant.report'], idOf('worker:A1:lead'), A.techTablet),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `d-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': freshKey() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const requestRow = async (id: string) => (await admin('SELECT status::text AS status, "acknowledgedByWorkerId", "onTheWayByWorkerId", "confirmedWorksAt", "confirmedWorksByWorkerId", "escalationLevel", "routedTeamId", "routedEmployeeId", "routingRuleId" FROM "MaintenanceRequest" WHERE id = $1', [id]))[0]!
const outbox = (type: string, subject: string) => admin(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 AND subject = $3 ORDER BY "occurredAt", id`, [A.tenant, type, subject])
const at = (date: Date): Clock => ({ now: () => date }) as Clock
const quiet = { info() {}, warn() {}, error() {} } as never

let sewMachine: string
let pressMachine: string
let tableMachine: string
let maintenance: { browser: Browser; secret: string }

beforeAll(async () => {
  h = await startHarness('plant_depth')
  await seedCore({ db: h.database, namespace: ns })
  await seedPrivacy({ db: h.database, namespace: ns })
  await seedProduction({ db: h.database, namespace: ns })
  await seedNumbering({ db: h.database, namespace: ns })
  plant = await seedPlant({ db: h.database, namespace: ns })
  care = await seedPlantCare({ db: h.database, namespace: ns })
  ;[sewMachine, pressMachine, tableMachine] = plant.machineIds
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, 'Sewing tablet 1', 'TABLET', 'ACTIVE', now())`, [A.sewTablet, A.tenant, A.companyA, A.siteA1, A.sew1Station])
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, 'Maintenance tablet', 'TABLET', 'ACTIVE', now())`, [A.techTablet, A.tenant, A.companyA, A.siteA1, A.sew2Station])
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [A.tenant])
  const user = await addUser(h, TENANT, { email: `maintenance-${run}@example.test`, role: 'maintenance' })
  const browser = new Browser(h.app)
  const signed = await browser.signIn(TENANT.slug, user.email, user.password)
  if (signed.body.status !== 'signed_in') throw new Error(`sign-in: ${signed.status} ${JSON.stringify(signed.body)}`)
  maintenance = { browser, secret: await enrolTotp(h, browser) }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

let sewRequest: Json
let tableRequest: Json
let job: Json

describe('routing at the report and escalation by the clock (QHS-179)', () => {
  it('routes a lockstitch request to its team and any other to the fallback technician, in the request itself', async () => {
    sewRequest = (await ok('station', 'POST', '/plant/requests', { machineId: sewMachine, description: 'Thread keeps breaking on the bobbin', down: false }, 201)).request
    // The floor sees where it went by kind only: no name, no id.
    expect(sewRequest.routing).toMatchObject({ routedTo: { kind: 'TEAM', id: null, name: null }, ruleId: null, escalationLevel: 0 })
    expect(await requestRow(sewRequest.id)).toMatchObject({ routingRuleId: care.ruleIds.lockstitch, routedTeamId: A.teamL1A, routedEmployeeId: null })
    const record = await ok('manager', 'GET', `/plant/requests/${sewRequest.id}`)
    expect(record.request.routing.routedTo).toMatchObject({ kind: 'TEAM', id: A.teamL1A, name: 'L1-A Line 1 team' })
    expect(record.trail.map((entry: Json) => entry.kind)).toEqual(['REPORTED', 'ROUTED'])
    tableRequest = (await ok('manager', 'POST', '/plant/requests', { machineId: tableMachine, description: 'Blade guard rattles', down: false }, 201)).request
    expect(await requestRow(tableRequest.id)).toMatchObject({ routingRuleId: care.ruleIds.fallback, routedEmployeeId: A.e2, routedTeamId: null })
    expect(tableRequest.routing.routedTo).toMatchObject({ kind: 'TECHNICIAN', id: null })
  })

  it('escalates a request nobody acknowledged to level 1, then 2, never twice for one level, with its event and notice', async () => {
    const reported = new Date(sewRequest.reportedAt)
    expect((await runEscalation({ database: h.database, log: quiet, clock: at(new Date(reported.getTime() + 9 * 60_000)) })).escalated).toBe(0)
    expect((await runEscalation({ database: h.database, log: quiet, clock: at(new Date(reported.getTime() + 11 * 60_000)) })).escalated).toBe(1)
    expect((await requestRow(sewRequest.id)).escalationLevel).toBe(1)
    expect((await runEscalation({ database: h.database, log: quiet, clock: at(new Date(reported.getTime() + 12 * 60_000)) })).escalated).toBe(0)
    // At +31 minutes the sewing request reaches level 2 (E3) and the cutting table's its first (fallback: 15 → E3).
    expect((await runEscalation({ database: h.database, log: quiet, clock: at(new Date(reported.getTime() + 31 * 60_000)) })).escalated).toBe(2)
    expect((await requestRow(sewRequest.id)).escalationLevel).toBe(2)
    const events = await outbox('maintenance_request.escalated', sewRequest.id)
    expect(events.map((row) => [row.payload.level, row.payload.escalatedToId])).toEqual([
      [1, A.e2],
      [2, A.e3],
    ])
    expect((await outbox('maintenance_request.escalated', tableRequest.id)).map((row) => row.payload.escalatedToId)).toEqual([A.e3])
    // The fan-out runs for it (the escalated person's office account, when they see the plant).
    const [row] = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'maintenance_request.escalated' AND subject = $2 ORDER BY "occurredAt" LIMIT 1`, [A.tenant, sewRequest.id])
    const made = await fanOut(callerFor(h.database, systemContext(A.tenant, `test-${row!.id}`)), { eventId: row!.id, type: row!.type, tenantId: row!.tenantId, companyId: row!.companyId, siteId: row!.siteId, subject: row!.subject, payload: row!.payload } as never)
    expect(made).toBeGreaterThanOrEqual(0)
    const record = await ok('manager', 'GET', `/plant/requests/${sewRequest.id}`)
    expect(record.request.routing).toMatchObject({ escalationLevel: 2 })
    expect(record.trail.map((entry: Json) => entry.kind)).toContain('ESCALATED')
  })
})

describe('the requester sees progress, the one-screen close, the line lead confirms (QHS-180, QHS-190)', () => {
  it('the technician sees the requests routed to them first, acknowledges once and is on the way once', async () => {
    const queue = (await ok('technician', 'GET', '/plant/floor/queue')).requests
    const mine = queue.find((entry: Json) => entry.request.id === sewRequest.id)
    expect(mine).toMatchObject({ toMe: true, canAcknowledge: true, canGo: true })
    expect(queue[0].toMe).toBe(true)
    const acknowledged = (await ok('technician', 'POST', `/plant/floor/requests/${sewRequest.id}/acknowledge`, {})).request
    expect(acknowledged).toMatchObject({ status: 'ACKNOWLEDGED', progress: { step: 'ACKNOWLEDGED' } })
    expect((await requestRow(sewRequest.id)).acknowledgedByWorkerId).toBe(A.lead)
    expect(refusalOf(await no('technician', 'POST', `/plant/floor/requests/${sewRequest.id}/acknowledge`, {}, 409))).toBe('refusal/ALREADY_ACKNOWLEDGED')
    expect((await ok('technician', 'POST', `/plant/floor/requests/${sewRequest.id}/on-the-way`, {})).request.progress.step).toBe('ON_THE_WAY')
    expect(refusalOf(await no('technician', 'POST', `/plant/floor/requests/${sewRequest.id}/on-the-way`, {}, 409))).toBe('refusal/ON_THE_WAY_ALREADY')
    // The station reads its request's progress; nobody is named on the floor.
    const station = (await ok('station', 'GET', '/plant/floor/requests')).requests.find((row: Json) => row.id === sewRequest.id)
    expect(station.progress).toMatchObject({ step: 'ON_THE_WAY', onTheWayBy: { kind: 'WORKER', id: null, name: null }, canConfirm: false })
    expect(refusalOf(await no('station', 'POST', `/plant/floor/requests/${sewRequest.id}/works`, {}, 409))).toBe('refusal/NOT_FIXED_YET')
    // A person without plant.jobs.work is never on the way.
    expect(await no('station', 'POST', `/plant/floor/requests/${sewRequest.id}/on-the-way`, {}, 403)).toMatchObject({ code: 'forbidden' })
    expect((await outbox('maintenance_request.progressed', sewRequest.id)).map((row) => row.payload.step)).toEqual(['ON_THE_WAY'])
  })

  it('hands back on one screen (action, failure code, minutes counted), the station confirms, the line lead confirms once', async () => {
    const current = (await ok('manager', 'GET', `/plant/requests/${sewRequest.id}`)).request
    job = (await ok('manager', 'POST', `/plant/requests/${sewRequest.id}/job`, { version: current.version }, 201)).job
    job = (await ok('technician', 'POST', `/plant/jobs/${job.id}/start`, { version: job.version })).job
    expect(refusalOf(await no('technician', 'POST', `/plant/jobs/${job.id}/hand-back`, { version: job.version, machineAfter: 'RUNNING' }, 400))).toBe('body/workDone')
    expect(refusalOf(await no('technician', 'POST', `/plant/jobs/${job.id}/hand-back`, { version: job.version, action: 'ADJUSTED', failureCode: 'worn part', machineAfter: 'RUNNING' }, 400))).toBe('body/failureCode')
    const record = await ok('technician', 'GET', `/plant/jobs/${job.id}`)
    expect(record.close).toMatchObject({ canHandBack: true, runningHeld: false })
    job = (await ok('technician', 'POST', `/plant/jobs/${job.id}/hand-back`, { version: job.version, action: 'REPLACED_PART', workDone: 'new bobbin case', failureCode: 'WORN_PART', machineAfter: 'RUNNING' })).job
    expect(job.handedBack).toMatchObject({ workDone: 'Replaced a part: new bobbin case', failureCode: 'WORN_PART', machineAfter: 'RUNNING' })
    expect(job.handedBack.minutesSpent).toBeGreaterThanOrEqual(0)
    const confirmed = (await ok('station', 'POST', `/plant/floor/requests/${sewRequest.id}/works`, {})).request
    expect(confirmed.progress).toMatchObject({ step: 'WORKS', worksBy: { kind: 'WORKER', id: null, name: null } })
    // A1 names workers and its operator acknowledged the notice: the confirmation names the operator, in the database.
    expect(await requestRow(sewRequest.id)).toMatchObject({ confirmedWorksByWorkerId: A.operator })
    expect(refusalOf(await no('station', 'POST', `/plant/floor/requests/${sewRequest.id}/works`, {}, 409))).toBe('refusal/WORKS_CONFIRMED')
    expect(await no('station', 'POST', `/plant/floor/jobs/${job.id}/confirm`, {}, 403)).toMatchObject({ code: 'forbidden' })
    const lead = (await ok('lead', 'POST', `/plant/floor/jobs/${job.id}/confirm`, {})).job
    expect(lead.leadConfirmed).toMatchObject({ by: { kind: 'WORKER', id: null, name: null } })
    expect(refusalOf(await no('lead', 'POST', `/plant/floor/jobs/${job.id}/confirm`, {}, 409))).toBe('refusal/LEAD_CONFIRMED')
    const office = await ok('manager', 'GET', `/plant/jobs/${job.id}`)
    expect(office.job.leadConfirmed.by).toMatchObject({ kind: 'WORKER', id: A.lead })
    expect(office.canConfirm).toBe(false)
    job = office.job
  })
})

let looseRequest: Json

describe('triage and duplicate merge (QHS-181)', () => {
  it('shows the possible duplicates with a suggested target and merges all or none; every reporter follows the target', async () => {
    looseRequest = (await ok('station', 'POST', '/plant/requests', { machineId: sewMachine, description: 'Needle bar loose', down: false }, 201)).request
    const groups = (await ok('manager', 'GET', `/plant/requests/duplicates?siteId=${A.siteA1}`)).groups
    const group = groups.find((entry: Json) => entry.machine.id === sewMachine)
    // The seed's thread-breaks report is dated later in the month than today's: the oldest comes first.
    expect(group.requests.map((row: Json) => row.id).sort()).toEqual([plant.requestIds[0], looseRequest.id].sort())
    // The machine's open job (handed back, not closed) is the suggestion.
    expect(group.suggested).toMatchObject({ kind: 'JOB', job: { id: job.id } })
    expect(group.words).toMatch(/^2 requests on /)
    const seedRequest = (await ok('manager', 'GET', `/plant/requests/${plant.requestIds[0]}`)).request
    // A request of another machine refuses the whole merge.
    expect(refusalOf(await no('manager', 'POST', '/plant/requests/merge', { requests: [{ id: looseRequest.id, version: looseRequest.version }, { id: tableRequest.id, version: 1 }], intoId: seedRequest.id }, 400))).toBe('body/requests/1')
    const merged = await ok('manager', 'POST', '/plant/requests/merge', { requests: [{ id: looseRequest.id, version: looseRequest.version }], intoId: seedRequest.id })
    expect(merged.requests[0]).toMatchObject({ status: 'MERGED', mergedIntoId: seedRequest.id })
    const joined = await ok('manager', 'POST', '/plant/requests/merge', { requests: [{ id: seedRequest.id, version: merged.target.version }], intoJobId: job.id })
    expect(joined.requests[0]).toMatchObject({ status: 'JOB_MADE', job: { id: job.id } })
    // The merged request follows the one it joined: its job is handed back, so its reporter may confirm.
    const followed = (await ok('station', 'GET', `/plant/floor/requests/${looseRequest.id}`)).request
    expect(followed.progress).toMatchObject({ step: 'FIXED', canConfirm: true })
  })

  it('the station confirms from its offline queue (floor-sync kind plant.request.progress)', async () => {
    const sent = await ok('station', 'POST', '/floor/sync', { events: [{ clientEventId: `works-${run}`, seq: 1, kind: 'plant.request.progress', occurredAt: new Date().toISOString(), payload: { requestId: looseRequest.id, step: 'WORKS_AGAIN' } }] })
    expect(sent.events[0]).toMatchObject({ status: 'accepted', result: { type: 'MaintenanceRequest', id: looseRequest.id } })
    expect((await requestRow(looseRequest.id)).confirmedWorksAt).not.toBeNull()
    const again = await ok('station', 'POST', '/floor/sync', { events: [{ clientEventId: `works-${run}`, seq: 1, kind: 'plant.request.progress', occurredAt: new Date().toISOString(), payload: { requestId: looseRequest.id, step: 'WORKS_AGAIN' } }] })
    expect(again.events[0].status).toBe('duplicate')
  })
})

let lockRequest: Json

describe('the unsafe lock from the office (QHS-183) and photos and voice notes (QHS-189)', () => {
  it('locks the machine from a request: a new unsafe request of the office, the machine do-not-use, the source joined, a hazard report asked', async () => {
    const plain = (await ok('manager', 'POST', '/plant/requests', { machineId: sewMachine, description: 'Belt cover cracked', down: false }, 201)).request
    const locked = await ok('manager', 'POST', `/plant/requests/${plain.id}/lock`, { version: plain.version, note: 'cover may fly off' }, 201)
    lockRequest = locked.lock
    expect(locked).toMatchObject({ joined: true, from: { status: 'MERGED', mergedIntoId: lockRequest.id }, machine: { status: 'DO_NOT_USE', locked: true } })
    expect(lockRequest).toMatchObject({ unsafe: true, locking: true, reportedBy: { kind: 'USER' } })
    expect(lockRequest.description).toBe('Locked as unsafe from the office after the report "Belt cover cracked": cover may fly off')
    expect((await outbox('maintenance_request.locked', lockRequest.id)).map((row) => row.payload)).toEqual([expect.objectContaining({ fromRequestId: plain.id, hazardReport: true, by: 'OFFICE' })])
    expect(refusalOf(await no('manager', 'POST', `/plant/requests/${lockRequest.id}/lock`, { version: lockRequest.version }, 409))).toBe('refusal/LOCKED_ALREADY')
    const locks = (await ok('manager', 'GET', `/plant/requests/locks?siteId=${A.siteA1}`)).locks
    expect(locks.map((row: Json) => row.machine.id)).toEqual(expect.arrayContaining([sewMachine, pressMachine]))
    // The job's record shows the machine's lock (the job is the machine's, handed back before the lock).
    expect((await ok('manager', 'GET', `/plant/jobs/${job.id}`)).lock).toMatchObject({ request: { id: lockRequest.id }, reason: expect.stringContaining('Marked unsafe') })
    // A viewer never locks.
    expect(await no('viewer', 'POST', `/plant/requests/${lockRequest.id}/lock`, { version: lockRequest.version }, 403)).toMatchObject({ code: 'forbidden' })
  })

  it('adds a photo from the station and a voice note from the technician, through the file store; the floor looks at them', async () => {
    const bytes = Buffer.from(`made-up photo ${run}`)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const announced = await ok('station', 'POST', `/plant/requests/${lockRequest.id}/files`, { kind: 'PHOTO', originalName: 'guard.jpg', contentType: 'image/jpeg', sizeBytes: bytes.length, sha256 }, 201)
    expect((await app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: bytes })).statusCode).toBe(200)
    expect((await ok('station', 'POST', `/plant/requests/${lockRequest.id}/files/${announced.file.id}/complete`)).file).toMatchObject({ status: 'AVAILABLE', kind: 'PHOTO', visibility: ['OFFICE', 'FLOOR'] })
    const floorView = await ok('station', 'GET', `/plant/floor/requests/${lockRequest.id}`)
    expect(floorView.files).toEqual([expect.objectContaining({ id: announced.file.id, kind: 'PHOTO', category: null })])
    expect((await ok('station', 'GET', `/plant/floor/files/${announced.file.id}/download`)).download.method).toBe('GET')
    expect((await ok('manager', 'GET', `/plant/requests/${lockRequest.id}`)).request.photos).toBe(1)

    const voice = Buffer.from(`made-up voice ${run}`)
    const note = await ok('technician', 'POST', `/plant/jobs/${job.id}/files`, { kind: 'AUDIO', category: 'BEFORE_WORK', originalName: 'note.webm', contentType: 'audio/webm', sizeBytes: voice.length, sha256: createHash('sha256').update(voice).digest('hex') }, 201)
    await app.inject({ method: 'PUT', url: note.upload.url, headers: note.upload.headers, payload: voice })
    await ok('technician', 'POST', `/plant/jobs/${job.id}/files/${note.file.id}/complete`)
    // A voice note carries no before / after tag (only a photo does).
    expect((await ok('manager', 'GET', `/plant/jobs/${job.id}`)).files).toEqual([expect.objectContaining({ kind: 'AUDIO', category: null })])
    // A merged request takes no more files; nor does a closed job.
    const merged = (await ok('manager', 'GET', `/plant/requests/${looseRequest.id}`)).request
    expect(refusalOf(await no('station', 'POST', `/plant/requests/${merged.id}/files`, { kind: 'PHOTO', originalName: 'x.jpg', contentType: 'image/jpeg', sizeBytes: 3, sha256 }, 409))).toBe('refusal/FILES_CLOSED')
    const closed = (await ok('manager', 'POST', `/plant/jobs/${job.id}/close`, { version: (await ok('manager', 'GET', `/plant/jobs/${job.id}`)).job.version })).job
    expect(closed.status).toBe('CLOSED')
    expect(refusalOf(await no('technician', 'POST', `/plant/jobs/${job.id}/files`, { kind: 'AUDIO', originalName: 'y.webm', contentType: 'audio/webm', sizeBytes: 3, sha256 }, 409))).toBe('refusal/FILES_CLOSED')
  })
})

describe('a site\'s plant settings: routing and the unsafe lock (QHS-179, QHS-183)', () => {
  it('lists the rules in order with their words, previews, adds, reorders, switches a used rule off and deletes an unused one', async () => {
    const listed = await ok('manager', 'GET', `/plant/settings/routing?siteId=${A.siteA1}`)
    expect(listed.rules.map((rule: Json) => rule.id)).toEqual([care.ruleIds.lockstitch, care.ruleIds.fallback])
    expect(listed.rules[0].words).toContain('goes to L1-A Line 1 team; not acknowledged in 10 min →')
    expect(listed.rules[1].requests).toBeGreaterThanOrEqual(2)
    const preview = await ok('manager', 'GET', `/plant/settings/routing/preview?siteId=${A.siteA1}&machineId=${pressMachine}`)
    expect(preview.rule.id).toBe(care.ruleIds.fallback)
    expect(preview.words).toMatch(/goes to .+; not acknowledged in 15 min →/)
    const press = (await admin<{ classId: string }>('SELECT "classId" FROM "Machine" WHERE id = $1', [pressMachine]))[0]!.classId
    expect(refusalOf(await no('manager', 'POST', '/plant/settings/routing', { siteId: A.siteA1, machineClassId: press, teamId: A.teamL1A, escalateAgainAfterMinutes: 5, escalateAgainToId: A.e3 }, 400))).toBe('body/escalateAgainAfterMinutes')
    const added = (await ok('manager', 'POST', '/plant/settings/routing', { siteId: A.siteA1, machineClassId: press, technicianId: A.e3, push: false }, 201)).rules
    const made = added.find((rule: Json) => rule.machineClass?.id === press)
    expect(made).toMatchObject({ seq: 2, target: { kind: 'TECHNICIAN', id: A.e3 }, push: false, requests: 0 })
    const ordered = (await ok('manager', 'POST', '/plant/settings/routing/order', { siteId: A.siteA1, rules: [made, ...added.filter((rule: Json) => rule.id !== made.id)].map((rule: Json) => ({ id: rule.id, version: rule.version })) })).rules
    expect(ordered[0].id).toBe(made.id)
    expect(refusalOf(await no('manager', 'POST', '/plant/settings/routing/order', { siteId: A.siteA1, rules: [{ id: made.id, version: 2 }] }, 409))).toBe('refusal/ORDER_INCOMPLETE')
    expect((await ok('manager', 'GET', `/plant/settings/routing/preview?siteId=${A.siteA1}&machineId=${pressMachine}`)).rule.id).toBe(made.id)
    const fallback = ordered.find((rule: Json) => rule.id === care.ruleIds.fallback)
    expect((await ok('manager', 'POST', `/plant/settings/routing/${fallback.id}/remove`, { version: fallback.version })).outcome).toBe('SWITCHED_OFF')
    const fresh = ordered.find((rule: Json) => rule.id === made.id)
    const removed = await ok('manager', 'POST', `/plant/settings/routing/${made.id}/remove`, { version: fresh.version })
    expect(removed.outcome).toBe('DELETED')
    expect(removed.rules.map((rule: Json) => [rule.id, rule.active])).toEqual([
      [care.ruleIds.lockstitch, true],
      [care.ruleIds.fallback, false],
    ])
    expect(await no('viewer', 'POST', '/plant/settings/routing', { siteId: A.siteA1, teamId: A.teamL1A }, 403)).toMatchObject({ code: 'forbidden' })
    expect((await outbox('plant_settings.changed', A.siteA1)).map((row) => row.payload.change)).toEqual(['ADDED', 'ORDERED', 'CHANGED', 'REMOVED'])
  })

  it('holds Owner answer H1, and switching the hazard report off asks for a fresh code', async () => {
    const lock = await ok('manager', 'GET', `/plant/settings/lock?siteId=${A.siteA1}`)
    expect(lock).toMatchObject({ lockBy: 'ANYONE_AT_STATION', signSafeBy: 'TECHNICIANS', hazardReportOnLock: true, version: 1, canManage: true })
    expect(refusalOf(await no('manager', 'PUT', '/plant/settings/lock', { siteId: A.siteA1, version: 1, lockBy: 'LEADS_AND_TECHNICIANS' }, 409))).toBe('refusal/H1_HELD')
    expect(refusalOf(await no('manager', 'PUT', '/plant/settings/lock', { siteId: A.siteA1, version: 1, signSafeBy: 'TECHNICIANS_AND_SAFETY_OFFICER' }, 409))).toBe('refusal/H1_HELD')
    // A test session has no fresh code: the loosening is refused before anything is written.
    expect((await call('manager', 'PUT', '/plant/settings/lock', { siteId: A.siteA1, version: 1, hazardReportOnLock: false })).statusCode).not.toBe(200)
    expect((await admin('SELECT "hazardReportOnLock", version FROM "PlantSettings" WHERE id = $1', [A.siteA1]))[0]).toMatchObject({ hazardReportOnLock: true, version: 1 })
    await stepUp(h, maintenance.browser, maintenance.secret)
    const off = await maintenance.browser.send('PUT' as 'POST', '/plant/settings/lock', { siteId: A.siteA1, version: 1, hazardReportOnLock: false }, { headers: { 'idempotency-key': freshKey() } })
    expect(off.status, JSON.stringify(off.body)).toBe(200)
    expect(off.body).toMatchObject({ hazardReportOnLock: false, version: 2 })
    // Tightening again needs no code.
    expect(await ok('manager', 'PUT', '/plant/settings/lock', { siteId: A.siteA1, version: 2, hazardReportOnLock: true })).toMatchObject({ hazardReportOnLock: true, version: 3 })
  })
})
