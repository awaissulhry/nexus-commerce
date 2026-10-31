import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPin } from '@nexus/factory-domain/auth/floor/pin'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../packages/factory-db/seed/numbering'
import { seed as seedPlant, type PlantSeed } from '../../../../../packages/factory-db/seed/plant'
import { seed as seedPrivacy } from '../../../../../packages/factory-db/seed/privacy'
import { seed as seedProduction } from '../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { callerFor } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../platform/auth/sessions/testing/harness'
import { fanOut } from '../../platform/notifications/fan-out'
import { systemContext } from '../../platform/outbox/system'
import { stationBlock } from './checks'

/**
 * The plant (B-W2a-35; QHS-162, QHS-178, QHS-184; Owner answer H1) on the local stack with the app's real routes: a
 * throwaway PostgreSQL 17 database from the migrations (the runtime logins: row-level security, the column grants and the
 * …_quality_plant_w2a_guards triggers are real), the factory-db seeds of two tenants up to the plant (plant A1 names
 * workers and its operator acknowledged the notice; the seeded lockstitch SEED-SEW-L1-01 at sewing station 1, the
 * clicking press SEED-CP-01 locked as unsafe with its PLANNED job, the cutting table SEED-CT-01 running beside it at
 * CUT-01; the production seed's SEED-WO-0001 in progress with its bundles), the numbering seed (MAINTENANCE_JOB series),
 * made-up tablets at SEW-01 (the reports), at CUT-01 and SEW-02 (the floor's scans: B-W2a-35b, a station whose machines
 * are all do-not-use takes no scan), and real people: a maintenance technician and a floor supervisor with two-factor, a
 * floor technician signed in by badge and PIN on an enrolled tablet. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/plant`.
 */

let h: Harness
let app: FastifyInstance
let plant: PlantSeed

const ns = { a: 'plant-a', b: 'plant-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const A = {
  tenant: idOf(ns.a, 'tenant'),
  actor: idOf(ns.a, 'actor'),
  companyA: idOf(ns.a, 'company:A'),
  companyB: idOf(ns.a, 'company:B'),
  siteA1: idOf(ns.a, 'site:A1'),
  siteB1: idOf(ns.a, 'site:B1'),
  sew1Station: idOf(ns.a, 'site:A1:station:SEW-01'),
  sew2Station: idOf(ns.a, 'site:A1:station:SEW-02'),
  b1Station: idOf(ns.a, 'site:B1:station:SEW-01'),
  cutStation: idOf(ns.a, 'site:A1:station:CUT-01'),
  operatorA1: idOf(ns.a, 'worker:A1:operator'),
  sewTablet: newId(),
  /** B-W2a-35b: made-up tablets that scan at the cutting table and at sewing station 2. */
  cutTablet: newId(),
  sew2Tablet: newId(),
  wo1: idOf(ns.a, 'production:work-order:WO-0001'),
  /** SEED-BN-0001 (1 garment): its sewing report was undone, its cutting never reported. */
  bundle1: idOf(ns.a, 'production:bundle:WO-0001:1'),
}
const B = { tenant: idOf(ns.b, 'tenant') }
const TENANT: TestTenant = { id: A.tenant, slug: ns.a, companies: [{ id: A.companyA, code: 'A' }, { id: A.companyB, code: 'B' }] }
const PIN = '482913'

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (tenantId: string, grants: Grant[], actorId: string = newId()): SessionContext => ({ audience: 'office', tenantId, actorId, grants })
const floor = (permissions: Permission[], deviceId: string = A.sewTablet): SessionContext => ({ audience: 'floor', tenantId: A.tenant, actorId: A.operatorA1, siteId: A.siteA1, deviceId, grants: [{ permissions, companies: [A.companyA], sites: [A.siteA1], parties: 'all' }] })
const MANAGE: Permission[] = ['plant.view', 'plant.machines.manage', 'plant.report', 'plant.requests.triage', 'plant.jobs.manage']
const SESSIONS: Record<string, SessionContext> = {
  manager: office(A.tenant, [grant(MANAGE)], A.actor),
  costs: office(A.tenant, [grant([...MANAGE, 'money.cost'])], A.actor),
  viewer: office(A.tenant, [grant(['plant.view'])]),
  companyA: office(A.tenant, [grant(MANAGE, [A.companyA])]),
  companyB: office(A.tenant, [grant(MANAGE, [A.companyB])]),
  otherTenant: office(B.tenant, [grant(MANAGE)]),
  operator: floor(['floor.work', 'plant.report']),
  noReport: floor(['floor.work']),
  cutScanner: floor(['floor.work', 'production.scan'], A.cutTablet),
  sew2Scanner: floor(['floor.work', 'production.scan'], A.sew2Tablet),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `t-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown, key?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key ?? freshKey() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const refusalOf = (error: Json): string => String(error.issues?.[0]?.path ?? '')
const fixOf = (error: Json): string => String(error.issues?.find((issue: Json) => issue.path === 'fix')?.message ?? '')
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : []
const valuesOf = (value: unknown): unknown[] => (Array.isArray(value) ? value.flatMap(valuesOf) : value && typeof value === 'object' ? Object.values(value).flatMap(valuesOf) : [value])
const machineRow = async (id: string) => (await admin<{ status: string; statusReason: string | null; version: number }>('SELECT status::text AS status, "statusReason", version FROM "Machine" WHERE id = $1', [id]))[0]!

// ---- real people (two-factor, the floor's PIN) -----------------------------------------------------------------------

interface Person {
  readonly id: string
  readonly browser: Browser
  readonly secret: string
}
const signedIn = async (email: string, role: string): Promise<Person> => {
  const user = await addUser(h, TENANT, { email, role })
  const browser = new Browser(h.app)
  const answer = await browser.signIn(TENANT.slug, user.email, user.password)
  if (answer.body.status !== 'signed_in') throw new Error(`sign-in ${email}: ${answer.status} ${JSON.stringify(answer.body)}`)
  return { id: user.id, browser, secret: await enrolTotp(h, browser) }
}
const stepped = (person: Person) => stepUp(h, person.browser, person.secret)
async function as(browser: Browser, method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await browser.send(method as 'POST', url, body, method === 'GET' ? {} : { headers: { 'idempotency-key': freshKey() } })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}
const roleIdOf = async (key: string) => (await admin<{ id: string }>('SELECT id::text FROM "Role" WHERE "tenantId" = $1::uuid AND key = $2', [A.tenant, key]))[0]!.id

let maintenance: Person
let supervisor: Person
let technicianId: string
let technicianTablet: Browser

/** An enrolled tablet at A1's sewing station 2 with a floor technician signed in by badge and PIN. */
async function technicianOnTablet(): Promise<{ workerId: string; tablet: Browser }> {
  await stepped(supervisor)
  const created = await supervisor.browser.post('/auth/floor/workers', { siteId: A.siteA1, displayName: 'Made-up Technician', locale: 'it', roleIds: [await roleIdOf('technician')] })
  if (created.status !== 200) throw new Error(`worker: ${created.status} ${JSON.stringify(created.body)}`)
  const badge = await supervisor.browser.post(`/auth/floor/workers/${created.body.id}/badges`)
  if (badge.status !== 200) throw new Error(`badge: ${badge.status} ${JSON.stringify(badge.body)}`)
  await admin('UPDATE "Worker" SET "pinHash" = $2 WHERE id = $1::uuid', [created.body.id, await hashPin(PIN, h.auth.pins, { logN: 12, r: 8, p: 1 })])
  const made = await supervisor.browser.post('/auth/floor/devices', { siteId: A.siteA1, stationId: A.sew2Station, name: `Maintenance tablet ${run}` })
  if (made.status !== 200) throw new Error(`enrol: ${made.status} ${JSON.stringify(made.body)}`)
  const tablet = new Browser(h.app)
  await tablet.get('/auth/csrf')
  const enrolled = await tablet.post('/floor/device/enrol', { code: made.body.enrolment.code, appVersion: '1.0.0' })
  if (enrolled.status !== 200) throw new Error(`exchange: ${enrolled.status} ${JSON.stringify(enrolled.body)}`)
  const signIn = await tablet.post('/floor/sign-in', { badgeCode: badge.body.code, pin: PIN })
  if (signIn.status !== 200) throw new Error(`floor sign-in: ${signIn.status} ${JSON.stringify(signIn.body)}`)
  return { workerId: created.body.id, tablet }
}

/** The worker's fan-out over the outbox rows of these types written since the mark; how many notifications it made. */
let mark = new Date(0)
async function fanOutSince(types: readonly string[]): Promise<number> {
  const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = ANY($2) AND "occurredAt" >= $3 ORDER BY "occurredAt", id`, [A.tenant, types, mark])
  let made = 0
  for (const row of rows) {
    const envelope = { eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload }
    made += await fanOut(callerFor(h.database, systemContext(A.tenant, `test-${row.id}`)), envelope)
  }
  mark = new Date()
  return made
}

beforeAll(async () => {
  h = await startHarness('plant')
  for (const namespace of [ns.a, ns.b]) {
    await seedCore({ db: h.database, namespace })
    await seedPrivacy({ db: h.database, namespace })
    await seedProduction({ db: h.database, namespace })
    await seedNumbering({ db: h.database, namespace })
    const seeded = await seedPlant({ db: h.database, namespace })
    if (namespace === ns.a) plant = seeded
  }
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) =>
    applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }),
  )
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, 'Sewing tablet 1', 'TABLET', 'ACTIVE', now())`, [A.sewTablet, A.tenant, A.companyA, A.siteA1, A.sew1Station])
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, 'Cutting tablet 2', 'TABLET', 'ACTIVE', now())`, [A.cutTablet, A.tenant, A.companyA, A.siteA1, A.cutStation])
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, 'Sewing tablet 2', 'TABLET', 'ACTIVE', now())`, [A.sew2Tablet, A.tenant, A.companyA, A.siteA1, A.sew2Station])
  maintenance = await signedIn(`maintenance-${run}@example.test`, 'maintenance')
  supervisor = await signedIn(`supervisor-${run}@example.test`, 'floor_supervisor')
  const technician = await technicianOnTablet()
  technicianId = technician.workerId
  technicianTablet = technician.tablet
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

// ---- classes and symptoms ------------------------------------------------------------------------------------------------

describe('machine classes and symptoms (the whole group\'s)', () => {
  it('lists the seeded classes, adds the missing starter set once, and keeps the lists over every company only', async () => {
    const before = await ok('manager', 'GET', '/plant/classes')
    expect(before.classes.map((row: Json) => row.code)).toContain('LOCKSTITCH')
    expect(before.starterMissing).toContain('ELECTRICAL_FAULT')
    expect(before.canManage).toBe(true)
    const added = await ok('manager', 'POST', '/plant/starter')
    expect(added.added.classes).toContain('COMPRESSOR')
    expect(added.added.symptoms).toEqual(['ELECTRICAL_FAULT'])
    expect((await ok('manager', 'POST', '/plant/starter')).added).toEqual({ classes: [], symptoms: [] })
    expect((await ok('manager', 'GET', '/plant/classes')).starterMissing).toEqual([])
    // A role over company A only keeps no group list.
    expect((await no('companyA', 'POST', '/plant/classes', { code: 'OVERLOCK', labelIt: 'Taglia e cuci', labelEn: 'Overlock' }, 403)).message).toContain('every company')
  })

  it('makes, changes and retires a class and a symptom; a code is unique and without spaces', async () => {
    const made = (await ok('manager', 'POST', '/plant/classes', { code: `ovl_${run}`, labelIt: 'Taglia e cuci', labelEn: 'Overlock', icon: 'needle' }, 201)).class
    expect(made).toMatchObject({ code: `OVL_${run}`.toUpperCase(), active: true, machines: 0 })
    expect(refusalOf(await no('manager', 'POST', '/plant/classes', { code: 'two words', labelIt: 'x', labelEn: 'x' }, 400))).toBe('body/code')
    expect((await no('manager', 'POST', '/plant/classes', { code: `OVL_${run}`, labelIt: 'x', labelEn: 'x' }, 409)).message).toContain('taken')
    const symptom = (await ok('manager', 'POST', '/plant/symptoms', { code: `KNIFE_${run}`.toUpperCase(), classId: made.id, labelIt: 'Coltello spuntato', labelEn: 'Blunt knife', colour: '#D97706' }, 201)).symptom
    expect(symptom).toMatchObject({ classId: made.id, colour: '#d97706', unsafe: false })
    const changed = (await ok('manager', 'PATCH', `/plant/symptoms/${symptom.id}`, { version: 1, unsafe: true })).symptom
    expect(changed).toMatchObject({ unsafe: true, version: 2 })
    expect(await no('manager', 'PATCH', `/plant/symptoms/${symptom.id}`, { version: 1, active: false }, 409)).toMatchObject({ code: 'conflict' })
    const retired = (await ok('manager', 'PATCH', `/plant/classes/${made.id}`, { version: 1, active: false })).class
    expect(retired.active).toBe(false)
    const ofClass = (await ok('manager', 'GET', `/plant/symptoms?classId=${made.id}`)).symptoms.map((row: Json) => row.code)
    expect(ofClass).toEqual(expect.arrayContaining([`KNIFE_${run}`.toUpperCase(), 'WONT_START', 'GUARD_MISSING']))
    expect(ofClass).not.toContain('THREAD_BREAKS')
  })
})

// ---- the register (QHS-162) --------------------------------------------------------------------------------------------

let sew2: Json

describe('the machine register (QHS-162)', () => {
  it('registers a machine RUNNING at a station of its site; its tag number is unique; the cost needs the cost grain', async () => {
    const lockstitch = plant.classIds['LOCKSTITCH']!
    sew2 = (await ok('costs', 'POST', '/plant/machines', { siteId: A.siteA1, assetNumber: `t-${run}-sew2`, classId: lockstitch, make: 'Madeup', modelName: 'LS-200', year: 2022, stationId: A.sew2Station, purchaseCost: 210000 }, 201)).machine
    expect(sew2).toMatchObject({ assetNumber: `T-${run}-SEW2`.toUpperCase(), status: 'RUNNING', locked: false, station: { code: 'SEW-02' }, line: { code: expect.any(String) }, purchaseCost: 210000 })
    expect((await no('manager', 'POST', '/plant/machines', { siteId: A.siteA1, assetNumber: `T-${run}-SEW2`, classId: lockstitch }, 409)).message).toContain('taken')
    expect(refusalOf(await no('manager', 'POST', '/plant/machines', { siteId: A.siteA1, assetNumber: `T-${run}-X`, classId: lockstitch, stationId: A.b1Station }, 400))).toBe('body/stationId')
    expect(refusalOf(await no('manager', 'POST', '/plant/machines', { siteId: A.siteA1, assetNumber: 'two words', classId: lockstitch }, 400))).toBe('body/assetNumber')
    // Without the cost grain the cost is neither sent nor seen.
    expect((await call('manager', 'PATCH', `/plant/machines/${sew2.id}`, { version: 1, purchaseCost: 1 })).statusCode).toBe(403)
    const seen = (await ok('manager', 'GET', `/plant/machines/${sew2.id}`)).card.machine
    expect(keysOf(seen)).not.toContain('purchaseCost')
    const patched = (await ok('manager', 'PATCH', `/plant/machines/${sew2.id}`, { version: 1, serialNumber: ' SN-42 ', note: 'By the window.' })).machine
    expect(patched).toMatchObject({ serialNumber: 'SN-42', note: 'By the window.', version: 2 })
    const audit = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'plant.createMachine'`, [sew2.id])
    expect(audit[0]!.after.purchaseCost).toMatchObject({ $money: 'cost' })
    sew2 = patched
  })

  it('lists by site, tile, words and a scanned tag; counts the tiles; other companies and tenants see nothing', async () => {
    const all = await ok('manager', 'GET', `/plant/machines?siteId=${A.siteA1}`)
    expect(all.machines.map((row: Json) => row.assetNumber)).toEqual(expect.arrayContaining(['SEED-CP-01', 'SEED-SEW-L1-01', sew2.assetNumber]))
    expect((await ok('manager', 'GET', '/plant/machines?tile=DO_NOT_USE')).machines.map((row: Json) => row.assetNumber)).toEqual(['SEED-CP-01'])
    expect((await ok('manager', 'GET', `/plant/machines?code=${sew2.assetNumber.toLowerCase()}`)).machines).toHaveLength(1)
    expect((await ok('manager', 'GET', '/plant/machines?q=madeup')).machines.map((row: Json) => row.id)).toEqual([sew2.id])
    expect(await ok('manager', 'GET', `/plant/machines/counts?siteId=${A.siteA1}`)).toMatchObject({ tiles: { DO_NOT_USE: 1, DOWN: 0 }, locked: 1 })
    expect((await ok('companyB', 'GET', '/plant/machines')).machines).toEqual([])
    expect((await call('companyB', 'GET', `/plant/machines/${sew2.id}`)).statusCode).toBe(404)
    expect((await call('otherTenant', 'GET', `/plant/machines/${sew2.id}`)).statusCode).toBe(404)
    const record = await ok('viewer', 'GET', `/plant/machines/${plant.machineIds[1]}`)
    expect(record.card.machine).toMatchObject({ assetNumber: 'SEED-CP-01', status: 'DO_NOT_USE', locked: true })
    expect(record.history.map((job: Json) => job.number)).toEqual(['SEED-MJ-0001'])
    expect(record).toMatchObject({ canManage: false, canReport: false })
  })
})

// ---- a report from the station (QHS-178) --------------------------------------------------------------------------------

let threadRequest: Json

describe('a report from the station (QHS-178)', () => {
  it("shows the station's machines with their symptoms, and the scanned tag's machine of the site", async () => {
    const answer = await ok('operator', 'GET', `/plant/floor/machines?code=${sew2.assetNumber}`)
    expect(answer.station).toMatchObject({ code: 'SEW-01' })
    expect(answer.machines.map((row: Json) => row.assetNumber)).toEqual(['SEED-SEW-L1-01'])
    const codes = answer.machines[0].symptoms.map((row: Json) => row.code)
    expect(codes).toEqual(expect.arrayContaining(['THREAD_BREAKS', 'GUARD_MISSING', 'WONT_START']))
    expect(codes).not.toContain('TWO_HAND_CONTROL')
    expect(answer.found).toMatchObject({ id: sew2.id })
    expect(answer.words).toEqual({ blocked: false, message: null, fix: null })
    // No cost, no supplier on the floor.
    expect(answer.machines[0].purchaseCost ?? null).toBeNull()
    expect(answer.machines[0].supplier).toBeNull()
    expect((await call('noReport', 'GET', '/plant/floor/machines')).statusCode).toBe(403)
  })

  it('reports thread breaks with the machine down: one request (a resend answers once), the machine DOWN, the worker named only inside the record', async () => {
    const key = freshKey()
    const body = { assetNumber: 'seed-sew-l1-01', symptomId: plant.symptomIds['THREAD_BREAKS'], description: 'Breaks every few stitches.', down: true, occurredAt: new Date(Date.now() - 60_000).toISOString() }
    const sent = await ok('operator', 'POST', '/plant/requests', body, 201, key)
    expect(sent).toMatchObject({ replayed: false, machine: { status: 'DOWN' }, request: { status: 'NEW', unsafe: false, reportedBy: { kind: 'WORKER', id: null, name: null }, station: { code: 'SEW-01' } } })
    const again = await ok('operator', 'POST', '/plant/requests', body, 200, key)
    expect(again).toMatchObject({ replayed: true, request: { id: sent.request.id } })
    const [row] = await admin<{ reportedByWorkerId: string; deviceId: string; stationId: string }>('SELECT "reportedByWorkerId"::text, "deviceId"::text, "stationId"::text FROM "MaintenanceRequest" WHERE id = $1', [sent.request.id])
    expect(row).toEqual({ reportedByWorkerId: A.operatorA1, deviceId: A.sewTablet, stationId: A.sew1Station })
    expect((await machineRow(plant.machineIds[0])).statusReason).toContain('Thread breaks')
    // The office's list names no worker; the one record does.
    const queue = await ok('manager', 'GET', '/plant/requests?open=true')
    const listed = queue.requests.find((entry: Json) => entry.id === sent.request.id)
    expect(listed.reportedBy).toEqual({ kind: 'WORKER', id: null, name: null })
    expect(listed.duplicates).toBe(1)
    const record = await ok('manager', 'GET', `/plant/requests/${sent.request.id}`)
    expect(record.request.reportedBy).toMatchObject({ kind: 'WORKER', id: A.operatorA1, name: expect.stringMatching(/Seed Worker/) })
    expect(record.duplicates.map((entry: Json) => entry.id)).toEqual([plant.requestIds[0]])
    expect(record).toMatchObject({ canTriage: true, canSignSafe: false, card: { machine: { status: 'DOWN' } } })
    threadRequest = record.request
  })

  it('refuses words missing, a symptom of another class, a retired machine and another site', async () => {
    expect(refusalOf(await no('operator', 'POST', '/plant/requests', { machineId: plant.machineIds[0], symptomId: plant.symptomIds['OTHER'], down: false }, 409))).toBe('refusal/DETAIL_NEEDED')
    const other = await no('operator', 'POST', '/plant/requests', { machineId: plant.machineIds[0], symptomId: plant.symptomIds['TWO_HAND_CONTROL'], down: false }, 409)
    expect(refusalOf(other)).toBe('refusal/SYMPTOM_OTHER_CLASS')
    expect(fixOf(other)).toContain('Pick a symptom')
    expect((await call('operator', 'POST', '/plant/requests', { assetNumber: 'NO-SUCH-TAG', down: true })).statusCode).toBe(404)
    expect((await call('noReport', 'POST', '/plant/requests', { machineId: plant.machineIds[0], description: 'x', down: true })).statusCode).toBe(403)
  })

  it('merges the duplicate into the floor report, closes it solved: the machine runs again', async () => {
    const merged = await ok('manager', 'POST', `/plant/requests/${plant.requestIds[0]}/merge`, { version: 1, intoId: threadRequest.id })
    expect(merged.request).toMatchObject({ status: 'MERGED', mergedIntoId: threadRequest.id })
    expect(await ok('manager', 'GET', '/plant/requests/counts')).toMatchObject({ tiles: { DUPLICATES: 0, DOWN: 1 } })
    expect(refusalOf(await no('manager', 'POST', `/plant/requests/${plant.requestIds[0]}/close`, { version: 2, reason: 'NOT_A_FAULT' }, 409))).toBe('refusal/ALREADY_TRIAGED')
    expect(refusalOf(await no('manager', 'POST', `/plant/requests/${threadRequest.id}/close`, { version: 1, reason: 'OTHER' }, 400))).toBe('body/note')
    const closed = await ok('manager', 'POST', `/plant/requests/${threadRequest.id}/close`, { version: 1, reason: 'SOLVED_BY_OPERATOR' })
    expect(closed).toMatchObject({ request: { status: 'CLOSED', closeReason: 'SOLVED_BY_OPERATOR', closedBy: { kind: 'USER' } }, machine: { status: 'RUNNING' } })
    expect((await call('viewer', 'POST', `/plant/requests/${threadRequest.id}/acknowledge`, { version: 2 })).statusCode).toBe(403)
  })
})

// ---- H1: unsafe at once, signed safe only by a technician (QHS-178, QHS-184) -----------------------------------------

describe('H1: anyone marks a machine unsafe at once; only a technician signs it safe', () => {
  let unsafe: Json
  let job: Json
  let blockedScan: Json

  it('an unsafe report locks the machine in the same transaction and says so at the station', async () => {
    mark = new Date()
    const sent = await ok('operator', 'POST', '/plant/requests', { machineId: sew2.id, symptomId: plant.symptomIds['GUARD_MISSING'], down: false }, 201)
    unsafe = sent.request
    expect(sent).toMatchObject({ machine: { status: 'DO_NOT_USE', locked: true }, request: { unsafe: true, locking: true } })
    expect(sent.words.message).toBe(`Machine ${sew2.assetNumber} is marked do not use (unsafe): do not work on it.`)
    // The station's only machine is SEW-02's: its work is blocked (the scans hook's words).
    const blocked = await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) => client.$transaction((tx) => stationBlock(tx, A.sew2Station)))
    expect(blocked?.message).toContain('do not use (unsafe)')
    expect(await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) => client.$transaction((tx) => stationBlock(tx, A.sew1Station)))).toBeNull()
    // The people who triage are told (ALERT); the reporter on the floor is no office user.
    expect(await fanOutSince(['maintenance_request.reported'])).toBeGreaterThanOrEqual(1)
    const told = await admin<{ category: string; messageKey: string; recordType: string }>(`SELECT category::text, "messageKey", "recordType" FROM "Notification" WHERE "userId" = $1 AND "eventType" = 'maintenance_request.reported'`, [maintenance.id])
    expect(told).toEqual([{ category: 'ALERT', messageKey: 'notifications.plant.unsafe', recordType: 'Machine' }])
  })

  it("B-W2a-35b: the station's scans are refused in its words while every machine there is do-not-use; one usable machine keeps a station working", async () => {
    const operations = await admin<{ id: string; seq: number }>('SELECT id::text, seq FROM "WorkOrderOperation" WHERE "workOrderId" = $1 ORDER BY seq', [A.wo1])
    const [cut, sew] = [operations.find((op) => op.seq === 10)!, operations.find((op) => op.seq === 20)!]
    // The cutting table (CUT-01): the seeded press is locked as unsafe, the cutting table beside it runs: the bundle is reported there.
    const cutScan = { clientScanId: `plant-${run}-cut-1`, bundleId: A.bundle1, workOrderOperationId: cut.id, good: 1 }
    const cutAnswer = await call('cutScanner', 'POST', '/production/scans', cutScan, cutScan.clientScanId)
    expect(cutAnswer.statusCode, cutAnswer.body).toBe(201)
    expect(cutAnswer.json().scan).toMatchObject({ goodQuantity: 1, operation: { seq: 10 } })
    // Sewing station 2: its only machine was just marked unsafe: refused in the station's words, not final (it may pass when sent again).
    blockedScan = { clientScanId: `plant-${run}-sew-1`, bundleId: A.bundle1, workOrderOperationId: sew.id, good: 1 }
    const answer = await call('sew2Scanner', 'POST', '/production/scans', blockedScan, blockedScan.clientScanId)
    expect(answer.statusCode, answer.body).toBe(409)
    const error = answer.json().error
    expect(refusalOf(error)).toBe('refusal/MACHINE_UNSAFE')
    expect(error.message).toBe(`Machine ${sew2.assetNumber} is marked do not use (unsafe): do not work on it.`)
    expect(fixOf(error)).toContain('signs it safe')
    expect(await admin('SELECT id FROM "OperationScan" WHERE "clientScanId" = $1', [blockedScan.clientScanId])).toEqual([])
  })

  it('is neither closed nor merged before the sign-safe; a job is made of it (P1, safety, numbered)', async () => {
    const closing = await no('manager', 'POST', `/plant/requests/${unsafe.id}/close`, { version: 1, reason: 'NOT_A_FAULT' }, 409)
    expect(refusalOf(closing)).toBe('refusal/LOCKED_UNSAFE')
    expect(fixOf(closing)).toContain('signs it safe')
    const made = await ok('manager', 'POST', `/plant/requests/${unsafe.id}/job`, { version: 1, assigneeWorkerId: technicianId }, 201)
    job = made.job
    expect(made.request).toMatchObject({ status: 'JOB_MADE', job: { id: job.id } })
    expect(job).toMatchObject({ status: 'NEW', priority: 'P1', type: 'SAFETY', source: 'REQUEST', number: expect.stringMatching(/^MJ-\d{4}-\d{4}$/), machine: { locked: true }, assignee: { kind: 'WORKER' } })
    // Not a technician: refused in words.
    expect(refusalOf(await no('manager', 'POST', '/plant/jobs', { machineId: sew2.id, type: 'CORRECTIVE', problem: 'x', assigneeWorkerId: A.operatorA1 }, 400))).toBe('body/assigneeWorkerId')
  })

  it("the technician's tablet lists the job, starts it (the locked machine stays do-not-use) and may not hand it back running", async () => {
    const mine = await as(technicianTablet, 'GET', '/plant/floor/jobs')
    expect(mine.jobs.map((entry: Json) => entry.id)).toContain(job.id)
    expect(mine.jobs.find((entry: Json) => entry.id === job.id)).toMatchObject({ ownership: 'MINE', assignee: { kind: 'WORKER', id: null, name: null } })
    const started = await as(technicianTablet, 'POST', `/plant/jobs/${job.id}/start`, { version: job.version })
    expect(started).toMatchObject({ job: { status: 'IN_PROGRESS' }, machine: { status: 'DO_NOT_USE', locked: true } })
    const handBack = await technicianTablet.send('POST', `/plant/jobs/${job.id}/hand-back`, { version: started.job.version, workDone: 'Refitted the guard.', machineAfter: 'RUNNING' }, { headers: { 'idempotency-key': freshKey() } })
    expect(handBack.status).toBe(409)
    expect(handBack.body.error.issues.map((issue: Json) => issue.path)).toEqual(['refusal/LOCKED_UNSAFE', 'fix'])
    job = started.job
  })

  it('signs it safe with the PIN (asked again after two minutes), then hands it back running; the office closes the job', async () => {
    h.clock.advance(3 * 60_000)
    const late = await technicianTablet.send('POST', `/plant/requests/${unsafe.id}/sign-safe`, { version: 2, note: 'Guard refitted and tested.' }, { headers: { 'idempotency-key': freshKey() } })
    expect(late.status).toBe(403)
    expect(late.body.error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
    expect((await technicianTablet.post('/floor/step-up', { pin: PIN })).status).toBe(200)
    const signed = await as(technicianTablet, 'POST', `/plant/requests/${unsafe.id}/sign-safe`, { version: 2, note: 'Guard refitted and tested.' })
    expect(signed).toMatchObject({ request: { signedSafe: { by: { kind: 'WORKER', id: null, name: null }, note: 'Guard refitted and tested.' }, locking: false }, machine: { status: 'UNDER_MAINTENANCE', locked: false } })
    const [row] = await admin<{ signedSafeByWorkerId: string }>('SELECT "signedSafeByWorkerId"::text FROM "MaintenanceRequest" WHERE id = $1', [unsafe.id])
    expect(row!.signedSafeByWorkerId).toBe(technicianId)
    // B-W2a-35b: signed safe, the machine is no longer do-not-use: the station takes the refused scan when it is sent again.
    const again = await call('sew2Scanner', 'POST', '/production/scans', blockedScan, blockedScan.clientScanId)
    expect(again.statusCode, again.body).toBe(201)
    expect(again.json().scan).toMatchObject({ clientScanId: blockedScan.clientScanId, goodQuantity: 1, operation: { seq: 20 } })
    expect(refusalOf((await technicianTablet.send('POST', `/plant/requests/${unsafe.id}/sign-safe`, { version: 3, note: 'Again.' }, { headers: { 'idempotency-key': freshKey() } })).body.error)).toBe('refusal/SIGNED_ALREADY')
    const back = await as(technicianTablet, 'POST', `/plant/jobs/${job.id}/hand-back`, { version: job.version, workDone: 'Refitted the guard.', machineAfter: 'RUNNING' })
    expect(back).toMatchObject({ job: { status: 'HANDED_BACK', handedBack: { machineAfter: 'RUNNING', by: { kind: 'WORKER' } } }, machine: { status: 'RUNNING' } })
    // The floor never closes a job.
    expect((await technicianTablet.send('POST', `/plant/jobs/${job.id}/close`, { version: back.job.version }, { headers: { 'idempotency-key': freshKey() } })).status).toBe(403)
    const closed = await ok('manager', 'POST', `/plant/jobs/${job.id}/close`, { version: back.job.version })
    expect(closed.job).toMatchObject({ status: 'CLOSED', closedBy: { kind: 'USER' } })
    const record = await ok('manager', 'GET', `/plant/jobs/${job.id}`)
    expect(record.job.handedBack.by).toMatchObject({ kind: 'WORKER', id: technicianId, name: 'Made-up Technician' })
    expect(record.requests.map((entry: Json) => entry.id)).toEqual([unsafe.id])
  })

  it('a technician in the office signs the seeded press safe with a fresh code; nobody else may', async () => {
    const [request] = await admin<{ version: number }>('SELECT version FROM "MaintenanceRequest" WHERE id = $1', [plant.requestIds[1]])
    const noCode = await maintenance.browser.send('POST', `/plant/requests/${plant.requestIds[1]}/sign-safe`, { version: request!.version, note: 'Guard checked.' }, { headers: { 'idempotency-key': freshKey() } })
    expect(noCode.status).toBe(403)
    expect(noCode.body.error.issues.map((issue: Json) => issue.path)).toContain('stepUp')
    expect((await supervisor.browser.send('POST', `/plant/requests/${plant.requestIds[1]}/sign-safe`, { version: request!.version, note: 'x' }, { headers: { 'idempotency-key': freshKey() } })).status).toBe(403)
    await stepped(maintenance)
    const signed = await as(maintenance.browser, 'POST', `/plant/requests/${plant.requestIds[1]}/sign-safe`, { version: request!.version, note: 'Guard checked, two-hand control tested.' })
    expect(signed).toMatchObject({ request: { status: 'JOB_MADE', signedSafe: { by: { kind: 'USER', id: maintenance.id } } }, machine: { assetNumber: 'SEED-CP-01', status: 'RUNNING', locked: false } })
  })

  it('the database holds the lock for every login: a floor write that runs a locked machine is refused at commit', async () => {
    const lock = (await ok('operator', 'POST', '/plant/requests', { machineId: sew2.id, symptomId: plant.symptomIds['GUARD_MISSING'], down: false }, 201)).request
    await expect(
      h.database.withScope({ audience: 'floor', tenantId: A.tenant, actorId: A.operatorA1, siteId: A.siteA1 }, (client) =>
        client.$transaction((tx) => tx.machine.update({ where: { id: sew2.id }, data: { status: 'RUNNING', statusSince: new Date(), statusReason: null }, select: { id: true } })),
      ),
    ).rejects.toThrow(/locked as unsafe/)
    expect((await machineRow(sew2.id)).status).toBe('DO_NOT_USE')
    expect(lock.locking).toBe(true)
  })
})

// ---- jobs (QHS-184) ----------------------------------------------------------------------------------------------------

describe('maintenance jobs (QHS-184)', () => {
  it('makes a job by hand, assigns it to an office technician (who is told), plans, cancels; lists by tile and mine', async () => {
    mark = new Date()
    const made = (await ok('manager', 'POST', '/plant/jobs', { machineId: plant.machineIds[0], type: 'PREVENTIVE', problem: 'Oil and check the hook timing.', dueAt: new Date(Date.now() - 3_600_000).toISOString() }, 201)).job
    expect(made).toMatchObject({ status: 'NEW', priority: 'P2', source: 'MANUAL', overdue: true, assignee: null })
    const assigned = (await ok('manager', 'POST', '/plant/jobs/assign', { jobs: [{ id: made.id, version: made.version }], assigneeId: maintenance.id })).jobs[0]
    expect(assigned.assignee).toMatchObject({ kind: 'USER', id: maintenance.id })
    expect(await fanOutSince(['maintenance_job.assigned'])).toBe(1)
    const [told] = await admin<{ category: string; recordLabel: string }>(`SELECT category::text, "recordLabel" FROM "Notification" WHERE "userId" = $1 AND "eventType" = 'maintenance_job.assigned'`, [maintenance.id])
    expect(told).toEqual({ category: 'ASSIGNMENT', recordLabel: made.number })
    expect((await ok('manager', 'GET', '/plant/jobs?tile=OVERDUE')).jobs.map((entry: Json) => entry.id)).toContain(made.id)
    expect((await as(maintenance.browser, 'GET', '/plant/jobs?mine=true')).jobs.map((entry: Json) => entry.id)).toEqual([made.id])
    const counts = await ok('manager', 'GET', '/plant/jobs/counts')
    expect(counts.tiles).toMatchObject({ CLOSED_THIS_WEEK: 1, UNSAFE: expect.any(Number) })
    const planned = (await ok('manager', 'POST', `/plant/jobs/${made.id}/plan`, { version: assigned.version })).job
    expect(planned.status).toBe('PLANNED')
    const edited = (await ok('manager', 'PATCH', `/plant/jobs/${made.id}`, { version: planned.version, priority: 'P1', assigneeId: null })).job
    expect(edited).toMatchObject({ priority: 'P1', assignee: null })
    const cancelled = await ok('manager', 'POST', `/plant/jobs/${made.id}/cancel`, { version: edited.version, reason: 'Done with the next service.' })
    expect(cancelled.job).toMatchObject({ status: 'CANCELLED', cancelReason: 'Done with the next service.' })
    expect(refusalOf(await no('manager', 'POST', `/plant/jobs/${made.id}/plan`, { version: cancelled.job.version }, 409))).toBe('refusal/MOVE_NOT_ALLOWED')
    expect((await call('operator', 'POST', '/plant/jobs', { machineId: plant.machineIds[0], type: 'CORRECTIVE', problem: 'x' })).statusCode).toBe(403)
  })

  it("a floor technician works only the jobs given to them or to nobody; another's job is refused in words", async () => {
    const theirs = (await ok('manager', 'POST', '/plant/jobs', { machineId: plant.machineIds[0], type: 'CORRECTIVE', problem: 'Noise at speed.', assigneeId: maintenance.id }, 201)).job
    const answer = await technicianTablet.send('POST', `/plant/jobs/${theirs.id}/start`, { version: theirs.version }, { headers: { 'idempotency-key': freshKey() } })
    expect(answer.status).toBe(409)
    expect(answer.body.error.issues[0].path).toBe('refusal/NOT_YOUR_JOB')
    const card = await as(technicianTablet, 'GET', `/plant/jobs/${theirs.id}`)
    expect(card).toMatchObject({ canWork: false, canManage: false, job: { ownership: 'OTHER', assignee: { kind: 'USER', id: null, name: null } } })
    // Nothing on the floor names a person or carries money.
    expect(valuesOf(card)).not.toContain(maintenance.id)
    expect(keysOf(card).filter((key) => /cost|price|margin|wage/i.test(key))).toEqual([])
  })

  it('retires a machine only without open work; a retired tag reports nothing', async () => {
    const spare = (await ok('manager', 'POST', '/plant/machines', { siteId: A.siteA1, assetNumber: `T-${run}-OLD`, classId: plant.classIds['HEAT_PRESS'] }, 201)).machine
    const report = (await ok('manager', 'POST', '/plant/requests', { machineId: spare.id, description: 'Heats unevenly.', down: true }, 201)).request
    expect(refusalOf(await no('manager', 'POST', `/plant/machines/${spare.id}/retire`, { version: 2, reason: 'Replaced.' }, 409))).toBe('refusal/OPEN_WORK')
    await ok('manager', 'POST', `/plant/requests/${report.id}/close`, { version: 1, reason: 'NOT_A_FAULT', keepDown: true })
    const current = (await machineRow(spare.id)).version
    const retired = await ok('manager', 'POST', `/plant/machines/${spare.id}/retire`, { version: current, reason: 'Replaced by a new press.' })
    expect(retired.machine).toMatchObject({ status: 'RETIRED', statusReason: 'Retired: Replaced by a new press.' })
    expect(refusalOf(await no('manager', 'POST', '/plant/requests', { machineId: spare.id, description: 'x', down: true }, 409))).toBe('refusal/RETIRED')
    expect((await ok('manager', 'GET', '/plant/machines')).machines.map((row: Json) => row.id)).not.toContain(spare.id)
    expect((await ok('manager', 'GET', '/plant/machines?status=RETIRED')).machines.map((row: Json) => row.id)).toEqual([spare.id])
  })
})

// ---- the record's thread ------------------------------------------------------------------------------------------------

describe("the records' threads", () => {
  it('machines, requests and jobs take internal notes of their company and site', async () => {
    await as(maintenance.browser, 'POST', `/threads/Machine/${sew2.id}/notes`, { body: 'Guard bracket ordered.' }, 201)
    const [thread] = await admin<{ companyId: string; siteId: string }>(`SELECT "companyId"::text, "siteId"::text FROM "Thread" WHERE "recordType" = 'Machine' AND "recordId" = $1`, [sew2.id])
    expect(thread).toEqual({ companyId: A.companyA, siteId: A.siteA1 })
    expect((await maintenance.browser.get(`/threads/MaintenanceJob/${plant.jobId}`)).status).toBe(200)
    expect((await maintenance.browser.get(`/threads/MaintenanceRequest/${plant.requestIds[1]}`)).status).toBe(200)
  })
})

// ---- the office screens' pickers (B-W2a-53) ------------------------------------------------------------------------------

describe("the office screens' pickers (B-W2a-53)", () => {
  it('places: the sites the person reaches, each with its active lines, work centres and stations; other companies and tenants see none', async () => {
    const all = await ok('manager', 'GET', '/plant/places')
    const a1 = all.sites.find((site: Json) => site.id === A.siteA1)
    expect(a1).toBeDefined()
    expect(a1.stations.map((station: Json) => station.code)).toEqual(expect.arrayContaining(['SEW-01', 'SEW-02', 'CUT-01']))
    expect(a1.stations.every((station: Json) => typeof station.workCentreId === 'string')).toBe(true)
    expect(a1.workCentres.length).toBeGreaterThan(0)
    expect(all.sites.map((site: Json) => site.id)).toContain(A.siteB1)
    // Company B only: A's sites are not offered.
    expect((await ok('companyB', 'GET', '/plant/places')).sites.map((site: Json) => site.id)).toEqual([A.siteB1])
    expect((await ok('otherTenant', 'GET', '/plant/places')).sites.map((site: Json) => site.id)).not.toContain(A.siteA1)
  })

  it('technicians: the office users who work maintenance jobs at the site and, for whoever sees floor workers, its floor technicians', async () => {
    const lead = await as(maintenance.browser, 'GET', `/plant/technicians?siteId=${A.siteA1}`)
    expect(lead.floorListed).toBe(true)
    expect(lead.technicians[0]).toMatchObject({ kind: 'USER', id: maintenance.id, me: true })
    expect(lead.technicians).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'WORKER', id: technicianId, name: 'Made-up Technician' })]))
    // The floor supervisor holds no plant.jobs.work: never offered.
    expect(lead.technicians.map((entry: Json) => entry.id)).not.toContain(supervisor.id)
    // Without workers.view no floor worker is listed (the office users still are).
    const manager = await ok('manager', 'GET', `/plant/technicians?siteId=${A.siteA1}`)
    expect(manager.floorListed).toBe(false)
    expect(manager.technicians.map((entry: Json) => entry.kind)).not.toContain('WORKER')
    expect(manager.technicians.map((entry: Json) => entry.id)).toContain(maintenance.id)
    // plant.view alone may not pick a technician; another tenant or an unknown site finds nothing.
    await no('viewer', 'GET', `/plant/technicians?siteId=${A.siteA1}`, undefined, 403)
    await no('otherTenant', 'GET', `/plant/technicians?siteId=${A.siteA1}`, undefined, 404)
    await no('manager', 'GET', `/plant/technicians?siteId=${newId()}`, undefined, 404)
  })
})

// ---- the floor's offline queue (B-W2a-73) ------------------------------------------------------------------------------

describe("a report saved on the tablet first (B-W2a-73: the floor's queue, kind plant.report)", () => {
  it('arrives through the floor sync once, at the tablet’s time, naming the machine and never a person; a refused one says why', async () => {
    let seq = 0
    const event = (payload: Json) => ({ clientEventId: `ev-${run}-${++seq}`, seq, kind: 'plant.report', occurredAt: new Date(Date.now() - 120_000).toISOString(), workerId: A.operatorA1, payload })
    const sync = async (list: Json[]) => (await ok('operator', 'POST', '/floor/sync', { events: list }, 200)).events as Json[]
    const noise = event({ assetNumber: 'seed-sew-l1-01', symptomId: plant.symptomIds['NOISE'], down: false })
    const [first] = await sync([noise])
    expect(first).toMatchObject({ clientEventId: noise.clientEventId, status: 'accepted', result: { type: 'MaintenanceRequest' }, refusal: null })
    const [again] = await sync([noise])
    expect(again).toMatchObject({ status: 'duplicate', result: first!.result })
    const rows = await admin<{ id: string; reportedAt: Date; deviceId: string; symptomId: string }>('SELECT id::text, "reportedAt", "deviceId"::text, "symptomId"::text FROM "MaintenanceRequest" WHERE id = $1', [first!.result.id])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ deviceId: A.sewTablet, symptomId: plant.symptomIds['NOISE'] })
    expect(new Date(rows[0]!.reportedAt).toISOString()).toBe(noise.occurredAt)
    const [ledger] = await admin<{ kind: string; resultType: string; resultId: string }>('SELECT kind, "resultType", "resultId"::text FROM "FloorSyncEvent" WHERE "clientEventId" = $1', [noise.clientEventId])
    expect(ledger).toEqual({ kind: 'plant.report', resultType: 'MaintenanceRequest', resultId: first!.result.id })
    // "Other" without words: refused for good, in the plant's words, kept on the tablet's refused list (the tag, no person).
    const other = event({ assetNumber: 'SEED-SEW-L1-01', symptomId: plant.symptomIds['OTHER'], down: true })
    const [refused] = await sync([other])
    expect(refused).toMatchObject({ status: 'refused', refusal: { code: 'DETAIL_NEEDED', final: true } })
    expect(refused!.refusal.fix).toContain('Write what you see')
    const [kept] = await admin<{ code: string; summary: Json }>('SELECT code, summary FROM "FloorRefusedAction" WHERE "clientEventId" = $1', [other.clientEventId])
    expect(kept).toEqual({ code: 'DETAIL_NEEDED', summary: { code: 'SEED-SEW-L1-01' } })
    // A tablet whose person may not report: refused by the kind's permission.
    const [denied] = (await ok('noReport', 'POST', '/floor/sync', { events: [event({ machineId: plant.machineIds[0], description: 'Smoke.', down: true })] }, 200)).events as Json[]
    expect(denied).toMatchObject({ status: 'refused' })
  })
})
