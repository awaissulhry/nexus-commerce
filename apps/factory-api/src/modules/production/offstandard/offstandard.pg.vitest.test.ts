import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPin } from '@nexus/factory-domain/auth/floor/pin'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedAndon } from '../../../../../../packages/factory-db/seed/andon'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedLabour, type LabourSeed } from '../../../../../../packages/factory-db/seed/labour'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * Off-standard and indirect time (B-W2b-29; MES-155 codes with pay rules, MES-156 time with no bundle, MES-157 the lead's
 * approval, MES-158 indirect work codes) through the app's real routes on a throwaway PostgreSQL 17 database from the
 * migrations (runtime and floor logins: row-level security, the grants and the …_floor_work_w2b_guards triggers are
 * real), on the factory-db seeds up to floor work: plant A1 names workers (its operator acknowledged the notice, its team
 * leader has not), plant B1 (company B) names the station only; company A's codes WAIT_MATERIAL, WAIT_HELP, CLEANING,
 * TRAINING; the help-call types booking their waiting to WAIT_HELP; 17 Nov's waiting block PENDING, 16 Nov's cleaning
 * APPROVED, line L1's 16 Nov CLOSED. Made-up tablets at A1's SEW-01 and CUT-01 and at B1; a real team leader signed in
 * with the PIN on an enrolled tablet for the floor's approval. Every name and value is made up. The law the tests name:
 * Statuto dei Lavoratori (L. 300/1970) art. 4 — no list, filter or total by person; a worker's name only inside one
 * record, where the site records workers. Run with `node scripts/factory/run-pg-tests.mjs modules/production/offstandard`.
 */

let h: Harness
let app: FastifyInstance
let labour: LabourSeed

const NS = 'w2b29-offstd'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const companyB = idOf('company:B')
const siteA1 = idOf('site:A1')
const siteB1 = idOf('site:B1')
const lineL1 = idOf('site:A1:line:L1')
const sew1 = idOf('site:A1:station:SEW-01')
const sew2 = idOf('site:A1:station:SEW-02')
const cut1 = idOf('site:A1:station:CUT-01')
const b1Station = idOf('site:B1:station:SEW-01')
const operator = idOf('worker:A1:operator')
const lead = idOf('worker:A1:lead')
const OPERATOR_NAME = 'Seed Worker A1-1'
const TENANT: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'A' }, { id: companyB, code: 'B' }] }
const PIN = '482913'
const tablets = { sew: newId(), cut: newId(), sew2: newId(), b1: newId(), b1Loose: newId() }
const actors = { manager: newId(), supervisor: newId(), operatorUser: newId(), b1Worker: newId() }

const ALL: Permission[] = ['production.offstandard.view', 'production.offstandard.codes', 'production.offstandard.approve']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (grants: Grant[], actorId: string = newId()): SessionContext => ({ audience: 'office', tenantId: T, actorId, grants })
const floor = (deviceId: string, actorId: string, permissions: Permission[] = ['floor.work'], site = siteA1, company = companyA): SessionContext => ({
  audience: 'floor',
  tenantId: T,
  actorId,
  siteId: site,
  deviceId,
  grants: [{ permissions, companies: [company], sites: [site], parties: 'all' }],
})
const SESSIONS: Record<string, SessionContext> = {
  manager: office([grant(ALL)], actors.manager),
  supervisor: office([grant(['production.offstandard.view', 'production.offstandard.approve'])], actors.supervisor),
  viewer: office([grant(['production.offstandard.view'])]),
  companyB: office([grant(ALL, [companyB])]),
  elsewhere: office([grant(ALL, 'all', [siteB1])]),
  operatorUser: office([grant(['production.offstandard.view', 'production.offstandard.approve'])], actors.operatorUser),
  noRight: office([grant(['workorders.view'])]),
  otherTenant: { audience: 'office', tenantId: newId(), actorId: newId(), grants: [grant(ALL)] },
  sew: floor(tablets.sew, operator),
  cut: floor(tablets.cut, operator, ['floor.work', 'production.scan']),
  leadNotAck: floor(tablets.sew2, lead),
  b1: floor(tablets.b1, actors.b1Worker, ['floor.work'], siteB1, companyB),
  b1Loose: floor(tablets.b1Loose, actors.b1Worker, ['floor.work'], siteB1, companyB),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const run = randomBytes(4).toString('hex')
let serial = 0
const key = () => `t-${run}-${++serial}`
const evt = (name: string) => `evt-${run}-${name}`
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
const block = async (id: string) => (await admin('SELECT *, status::text AS status, source::text AS source, "workDate"::text AS day FROM "OffStandardEntry" WHERE id = $1', [id]))[0]!
const codeId = async (company: string, code: string) => (await admin<{ id: string }>('SELECT id FROM "OffStandardCode" WHERE "tenantId" = $1 AND "companyId" = $2 AND code = $3', [T, company, code]))[0]!.id
const outbox = async (type: string, subject: string) => admin('SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 AND subject = $3 ORDER BY "occurredAt", id', [T, type, subject])
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
/** Started in the last half hour (the seeded blocks are dated later in November). */
const fresh = (row: Json) => row.startedAt > minutesAgo(30) && row.startedAt <= new Date().toISOString()

let codes: Record<'WAIT_MATERIAL' | 'WAIT_HELP' | 'CLEANING' | 'TRAINING', string>

beforeAll(async () => {
  h = await startHarness('offstandard')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedPrivacy({ db: h.database, namespace: NS })
  labour = await seedLabour({ db: h.database, namespace: NS })
  await seedAndon({ db: h.database, namespace: NS })
  codes = labour.codeIds
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  const device = (id: string, company: string, site: string, station: string | null, name: string) =>
    admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, $6, 'TABLET', 'ACTIVE', now())`, [id, T, company, site, station, name])
  await device(tablets.sew, companyA, siteA1, sew1, 'Sewing tablet 1')
  await device(tablets.cut, companyA, siteA1, cut1, 'Cutting tablet 2')
  await device(tablets.sew2, companyA, siteA1, sew2, 'Sewing tablet 2')
  await device(tablets.b1, companyB, siteB1, b1Station, 'B1 sewing tablet')
  await device(tablets.b1Loose, companyB, siteB1, null, 'B1 spare tablet')
  // The operator is also an office user (a made-up one): that user never decides the operator's time.
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, "updatedAt") VALUES ($1, $2, $3, 'Made-up Operator (office)', 'ACTIVE', now())`, [actors.operatorUser, T, `operator-${run}@example.test`])
  await admin('UPDATE "Worker" SET "userId" = $2 WHERE id = $1', [operator, actors.operatorUser])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('off-standard and indirect codes with their pay rules (MES-155, MES-158)', () => {
  it("lists the company's codes with their kind, pay rule, approval and the help calls that book to them", async () => {
    const answer = await ok('manager', 'GET', `/production/offstandard/codes?companyId=${companyA}`)
    expect(answer.canManage).toBe(true)
    const byCode = new Map(answer.codes.map((row: Json) => [row.code, row]))
    expect(byCode.get('WAIT_MATERIAL')).toMatchObject({ kind: 'OFF_STANDARD', payRule: 'AVERAGE', needsApproval: true, active: true })
    expect(byCode.get('CLEANING')).toMatchObject({ kind: 'INDIRECT', payRule: 'BASE', needsApproval: false })
    expect(byCode.get('TRAINING')).toMatchObject({ kind: 'INDIRECT', payRule: 'AVERAGE', needsApproval: true })
    expect((byCode.get('WAIT_HELP') as Json).callTypes).toEqual(['MAINTENANCE', 'MATERIAL', 'TEAM_LEADER'])
    expect((byCode.get('WAIT_MATERIAL') as Json).usedCount).toBeGreaterThanOrEqual(1)
    expect((await ok('viewer', 'GET', '/production/offstandard/codes')).canManage).toBe(false)
  })

  it('adds an indirect code, refuses a taken code and words that do not draw, and keeps it per company', async () => {
    const made = await ok('manager', 'POST', '/production/offstandard/codes', { companyId: companyA, code: 'samples', kind: 'INDIRECT', payRule: 'BASE', needsApproval: false, labelIt: 'Campionatura', labelEn: 'Samples', labelI18n: { ro: 'Mostre' }, icon: 'shirt', colour: '#15A34A' }, 201)
    expect(made.code).toMatchObject({ code: 'SAMPLES', kind: 'INDIRECT', payRule: 'BASE', needsApproval: false, colour: '#15a34a', labelI18n: { ro: 'Mostre' }, sortOrder: 50, usedCount: 0, active: true })
    expect((await outbox('production.off_standard_code_changed', made.code.id))[0]!.payload).toEqual({ companyId: companyA, codeId: made.code.id, code: 'SAMPLES', change: 'CREATED' })
    const taken = await no('manager', 'POST', '/production/offstandard/codes', { companyId: companyA, code: 'SAMPLES', kind: 'INDIRECT', payRule: 'BASE', labelIt: 'x', labelEn: 'x' }, 400)
    expect(taken.issues.map((issue: Json) => issue.path)).toEqual(['body/code'])
    const drawn = await no('manager', 'POST', '/production/offstandard/codes', { companyId: companyA, code: 'MEETING', kind: 'INDIRECT', payRule: 'BASE', labelIt: 'Riunione', labelEn: 'Meeting', icon: 'rocket' }, 400)
    expect(drawn.issues.map((issue: Json) => issue.path)).toEqual(['body/icon'])
    await no('viewer', 'POST', '/production/offstandard/codes', { companyId: companyA, code: 'MEETING', kind: 'INDIRECT', payRule: 'BASE', labelIt: 'Riunione', labelEn: 'Meeting' }, 403)
    await no('companyB', 'POST', '/production/offstandard/codes', { companyId: companyA, code: 'MEETING', kind: 'INDIRECT', payRule: 'BASE', labelIt: 'Riunione', labelEn: 'Meeting' }, 404)
    // The same code in another company is another code.
    await ok('companyB', 'POST', '/production/offstandard/codes', { companyId: companyB, code: 'SAMPLES', kind: 'INDIRECT', payRule: 'UNPAID', labelIt: 'Campionatura', labelEn: 'Samples' }, 201)
  })

  it('changes a pay rule and the approval with the version read, on record before → after; the kind never changes', async () => {
    const samples = await codeId(companyA, 'SAMPLES')
    const changed = await ok('manager', 'PATCH', `/production/offstandard/codes/${samples}`, { version: 1, payRule: 'UNPAID', needsApproval: true })
    expect(changed.code).toMatchObject({ payRule: 'UNPAID', needsApproval: true, version: 2 })
    const audit = await admin<{ before: Json; after: Json }>(`SELECT before, after FROM "AuditLog" WHERE "recordType" = 'OffStandardCode' AND "recordId" = $1 AND action = 'production.offStandardCodeEdit'`, [samples])
    expect(audit).toEqual([{ before: { payRule: 'BASE', needsApproval: false }, after: { payRule: 'UNPAID', needsApproval: true } }])
    expect((await no('manager', 'PATCH', `/production/offstandard/codes/${samples}`, { version: 1, payRule: 'AVERAGE' }, 409)).issues[0].path).toBe('version')
    expect(refusalOf(await no('manager', 'PATCH', `/production/offstandard/codes/${samples}`, { version: 2, kind: 'OFF_STANDARD' }, 409))).toBe('refusal/KIND_FIXED')
    await no('viewer', 'PATCH', `/production/offstandard/codes/${samples}`, { version: 2, labelEn: 'Sampling' }, 403)
  })

  it('refuses to set a code inactive while help calls book their waiting to it; sets another inactive (never deleted)', async () => {
    const waitHelp = (await ok('manager', 'GET', `/production/offstandard/codes?companyId=${companyA}`)).codes.find((row: Json) => row.code === 'WAIT_HELP')
    const booked = await no('manager', 'PATCH', `/production/offstandard/codes/${waitHelp.id}`, { version: waitHelp.version, active: false }, 409)
    expect(refusalOf(booked)).toBe('refusal/BOOKED_BY_CALLS')
    expect(booked.message).toMatch(/MAINTENANCE, MATERIAL, TEAM_LEADER/)
    const samples = await codeId(companyA, 'SAMPLES')
    expect((await ok('manager', 'PATCH', `/production/offstandard/codes/${samples}`, { version: 2, active: false })).code.active).toBe(false)
    expect((await outbox('production.off_standard_code_changed', samples)).map((row) => row.payload.change)).toEqual(['CREATED', 'EDITED', 'DEACTIVATED'])
  })
})

describe('time with no bundle on the floor (MES-156, MES-158)', () => {
  let cleaning: Json
  let waiting: Json

  it("shows the tablet the site's subject, its station and line, and the active tiles in their order (no pay rule)", async () => {
    const state = await ok('sew', 'GET', '/production/offstandard/floor')
    expect(state).toMatchObject({ subject: 'WORKER', station: { code: 'SEW-01', line: { id: lineL1, code: 'L1' } }, running: null })
    expect(state.codes.map((row: Json) => row.code)).toEqual(['WAIT_MATERIAL', 'WAIT_HELP', 'CLEANING', 'TRAINING'])
    expect(JSON.stringify(state)).not.toMatch(/payRule/)
  })

  it('starts a tile once (a resend or a second tap answers the same block), naming the worker and their employee', async () => {
    const started = await ok('sew', 'POST', '/production/offstandard/floor/start', { codeId: codes.CLEANING, clientEventId: evt('clean-1') }, 201)
    cleaning = started.block
    expect(started).toMatchObject({ block: { status: 'OPEN', code: { code: 'CLEANING', kind: 'INDIRECT' }, endedAt: null }, ended: null })
    const row = await block(cleaning.id)
    const employee = (await admin<{ employeeId: string }>('SELECT "employeeId" FROM "Worker" WHERE id = $1', [operator]))[0]!.employeeId
    expect(row).toMatchObject({ workerId: operator, employeeId: employee, stationId: sew1, lineId: lineL1, source: 'FLOOR', deviceId: tablets.sew, createdById: operator, day: businessDate(new Date()) })
    expect((await ok('sew', 'POST', '/production/offstandard/floor/start', { codeId: codes.CLEANING, clientEventId: evt('clean-1') })).block.id).toBe(cleaning.id)
    expect((await ok('sew', 'POST', '/production/offstandard/floor/start', { codeId: codes.CLEANING, clientEventId: evt('clean-2') })).block.id).toBe(cleaning.id)
    expect((await admin('SELECT id FROM "OffStandardEntry" WHERE "workerId" = $1 AND status = $2', [operator, 'OPEN'])).length).toBe(1)
  })

  it('another tile ends the running one in the same command (a code with no approval is approved as it ends)', async () => {
    const switched = await ok('sew', 'POST', '/production/offstandard/floor/start', { codeId: codes.WAIT_MATERIAL, clientEventId: evt('wait-1') }, 201)
    waiting = switched.block
    expect(switched.ended).toMatchObject({ id: cleaning.id, status: 'APPROVED' })
    expect(await block(cleaning.id)).toMatchObject({ status: 'APPROVED', approvedById: null })
    expect((await outbox('production.off_standard_ended', cleaning.id))[0]!.payload).toMatchObject({ endedBy: 'SWITCH', status: 'APPROVED', code: 'CLEANING' })
    expect((await ok('sew', 'GET', '/production/offstandard/floor')).running).toMatchObject({ id: waiting.id, code: { code: 'WAIT_MATERIAL' } })
  })

  it('ends the running block: waiting for the team leader; nothing to end is refused in words, a resend answers', async () => {
    const endKey = evt('end-1')
    const ended = await ok('sew', 'POST', '/production/offstandard/floor/end', { clientEventId: endKey })
    expect(ended.block).toMatchObject({ id: waiting.id, status: 'PENDING' })
    expect((await ok('sew', 'POST', '/production/offstandard/floor/end', { clientEventId: endKey })).block.id).toBe(waiting.id)
    const none = await no('sew', 'POST', '/production/offstandard/floor/end', { clientEventId: evt('end-2') }, 409)
    expect(refusalOf(none)).toBe('refusal/NONE_RUNNING')
  })

  it('refuses an inactive tile, and a worker who has not acknowledged the notice (Statuto art. 4 c.3)', async () => {
    const samples = await codeId(companyA, 'SAMPLES')
    expect(refusalOf(await no('sew', 'POST', '/production/offstandard/floor/start', { codeId: samples, clientEventId: evt('samples-1') }, 409))).toBe('refusal/CODE_INACTIVE')
    const notAcknowledged = await no('leadNotAck', 'POST', '/production/offstandard/floor/start', { codeId: codes.CLEANING, clientEventId: evt('lead-1') }, 409)
    expect(notAcknowledged.message).toMatch(/notice/)
    expect((await admin('SELECT id FROM "OffStandardEntry" WHERE "workerId" = $1', [lead])).length).toBe(0)
  })

  it('scanning a bundle returns to standard: the running block ends at the scan, in the scan’s own command', async () => {
    const started = await ok('cut', 'POST', '/production/offstandard/floor/start', { codeId: codes.CLEANING, clientEventId: evt('clean-cut') }, 201)
    const clientScanId = `scan-${run}-hook`
    const scan = await app.inject({ method: 'POST', url: '/production/scans', headers: { 'x-test-session': 'cut', 'idempotency-key': clientScanId }, payload: { bundleId: labour.production.bundleIds[0], workOrderOperationId: labour.production.operationIds.cut, good: 1, clientScanId } })
    expect([200, 201], scan.body).toContain(scan.statusCode)
    expect(await block(started.block.id)).toMatchObject({ status: 'APPROVED' })
    expect((await outbox('production.off_standard_ended', started.block.id))[0]!.payload).toMatchObject({ endedBy: 'SCAN' })
    expect((await ok('cut', 'GET', '/production/offstandard/floor')).running).toBeNull()
  })

  it('starts only while no bundle runs (MES-156), in words before the database would refuse it', async () => {
    const bundle2 = labour.production.bundleIds[1]
    const insertScan = (kind: string) =>
      admin(
        `INSERT INTO "OperationScan" (id, "tenantId", "siteId", "workOrderId", "workOrderOperationId", "bundleId", kind, "workerId", "deviceId", "clientScanId", "serverTime", "createdById")
         VALUES ($1, $2, $3, $4, $5, $6, $7::"ScanKind", $8, $9, $10, now(), $8)`,
        [newId(), T, siteA1, labour.production.workOrderId, labour.production.operationIds.pack, bundle2, kind, operator, tablets.sew, `timing-${run}-${kind}`],
      )
    await insertScan('START')
    expect(refusalOf(await no('sew', 'POST', '/production/offstandard/floor/start', { codeId: codes.WAIT_MATERIAL, clientEventId: evt('busy-1') }, 409))).toBe('refusal/BUNDLE_RUNNING')
    await insertScan('HAND_BACK')
  })

  it('names the station and nobody at a site that records the station only', async () => {
    const waitWork = await ok('companyB', 'POST', '/production/offstandard/codes', { companyId: companyB, code: 'WAIT_WORK', kind: 'OFF_STANDARD', payRule: 'AVERAGE', needsApproval: true, labelIt: 'Attesa lavoro', labelEn: 'Waiting for work' }, 201)
    const state = await ok('b1', 'GET', '/production/offstandard/floor')
    expect(state).toMatchObject({ subject: 'STATION', running: null })
    expect(state.codes.map((row: Json) => row.code)).toEqual(['SAMPLES', 'WAIT_WORK'])
    const started = await ok('b1', 'POST', '/production/offstandard/floor/start', { codeId: waitWork.code.id, clientEventId: evt('b1-1') }, 201)
    expect(await block(started.block.id)).toMatchObject({ workerId: null, employeeId: null, stationId: b1Station, createdById: null })
    expect((await ok('b1', 'POST', '/production/offstandard/floor/end', { clientEventId: evt('b1-2') })).block.status).toBe('PENDING')
    const record = await ok('companyB', 'GET', `/production/offstandard/blocks/${started.block.id}`)
    expect(record.block).toMatchObject({ worker: null, named: false, station: { id: b1Station }, canDecide: true })
    // A tablet at no station cannot say which station: refused in words.
    const loose = await no('b1Loose', 'POST', '/production/offstandard/floor/start', { codeId: waitWork.code.id, clientEventId: evt('b1-3') }, 409)
    expect(loose.message).toMatch(/station/)
  })

  it("queues a start and an end on the tablet's offline queue, applied once (a resend is a duplicate)", async () => {
    const events = [
      { clientEventId: evt('q-start'), seq: 1, kind: 'production.offStandard.start', occurredAt: new Date(Date.now() - 1000).toISOString(), payload: { codeId: codes.TRAINING } },
      { clientEventId: evt('q-end'), seq: 2, kind: 'production.offStandard.end', payload: {} },
    ]
    const sent = await ok('sew', 'POST', '/floor/sync', { events })
    expect(sent.events.map((row: Json) => row.status)).toEqual(['accepted', 'accepted'])
    expect(sent.events[0].result).toMatchObject({ type: 'OffStandardEntry' })
    const training = await block(sent.events[0].result.id)
    expect(training).toMatchObject({ status: 'PENDING', clientEventId: evt('q-start') })
    expect(training.deviceTime).not.toBeNull()
    const again = await ok('sew', 'POST', '/floor/sync', { events })
    expect(again.events.map((row: Json) => row.status)).toEqual(['duplicate', 'duplicate'])
  })
})

describe("the lead's approval in the office (MES-157)", () => {
  let waiting: Json
  let training: Json

  it('lists the waiting blocks oldest first, per line, station and code: never who (Statuto art. 4; Owner answers W1, F2)', async () => {
    const answer = await ok('supervisor', 'GET', `/production/offstandard/blocks?siteId=${siteA1}&status=PENDING`)
    expect(answer.blocks.length).toBeGreaterThanOrEqual(3)
    waiting = answer.blocks.find((row: Json) => row.code.code === 'WAIT_MATERIAL' && row.source === 'FLOOR' && fresh(row))
    training = answer.blocks.find((row: Json) => row.code.code === 'TRAINING')
    expect(waiting).toMatchObject({ status: 'PENDING', named: true, line: { code: 'L1' }, station: { code: 'SEW-01' }, unusual: [] })
    const starts = answer.blocks.map((row: Json) => row.startedAt)
    expect(starts).toEqual([...starts].sort())
    const text = JSON.stringify(answer)
    expect(text).not.toContain(OPERATOR_NAME)
    expect(text).not.toContain(operator)
    expect(text).not.toMatch(/workerId|employeeId|"worker"/)
    expect((await ok('supervisor', 'GET', `/production/offstandard/blocks?kind=INDIRECT`)).blocks.every((row: Json) => row.code.kind === 'INDIRECT')).toBe(true)
    const counts = await ok('supervisor', 'GET', `/production/offstandard/counts?siteId=${siteA1}`)
    expect(counts.pending).toBe(answer.blocks.length)
    expect(counts.normal + counts.unusual).toBe(counts.pending)
  })

  it("names the worker only on the block's own record, and only behind the site's PERFORMANCE legal gate (art. 4 c.1)", async () => {
    // The gate is off (the default): the record says a person is on it, never who.
    const closed = (await ok('supervisor', 'GET', `/production/offstandard/blocks/${waiting.id}`)).block
    expect(closed).toMatchObject({ worker: null, workerHidden: true, named: true, canDecide: true })
    expect(JSON.stringify(closed)).not.toContain(OPERATOR_NAME)
    // The site records its basis (made up): the gate is on, one record names its worker.
    const notice = (await admin<{ id: string }>(`SELECT id FROM "PrivacyNotice" WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = 'WORKER_FLOOR' AND status = 'PUBLISHED'`, [T, companyA]))[0]!.id
    const dpia = (await admin<{ id: string }>(`SELECT id FROM "PrivacyDpia" WHERE "tenantId" = $1 AND "companyId" = $2 AND status = 'STORED'`, [T, companyA]))[0]!.id
    await admin(
      `INSERT INTO "PeopleLegalGate" (id, "tenantId", "companyId", "siteId", purpose, basis, "basisReference", "noticeId", "dpiaId", "switchedOnAt", "switchedOnById", "updatedAt")
       VALUES ($1, $2, $3, $4, 'PERFORMANCE', 'UNION_AGREEMENT', 'SAMPLE - made-up agreement for the test', $5, $6, now(), $7, now())`,
      [newId(), T, companyA, siteA1, notice, dpia, actors.manager],
    )
    const record = (await ok('supervisor', 'GET', `/production/offstandard/blocks/${waiting.id}`)).block
    expect(record).toMatchObject({ worker: { id: operator, name: OPERATOR_NAME }, workerHidden: false, own: false, canDecide: true, edits: [] })
    const mine = (await ok('operatorUser', 'GET', `/production/offstandard/blocks/${waiting.id}`)).block
    expect(mine).toMatchObject({ own: true, canDecide: false })
    expect(refusalOf(await no('operatorUser', 'POST', `/production/offstandard/blocks/${waiting.id}/approve`, { version: waiting.version }, 409))).toBe('refusal/OWN_TIME')
  })

  it('approves with the version read, once; the decision is on record and on the live inbox', async () => {
    expect((await no('supervisor', 'POST', `/production/offstandard/blocks/${waiting.id}/approve`, { version: waiting.version + 5 }, 409)).issues[0].path).toBe('version')
    const approved = (await ok('supervisor', 'POST', `/production/offstandard/blocks/${waiting.id}/approve`, { version: waiting.version })).block
    expect(approved).toMatchObject({ status: 'APPROVED', approvedBy: { id: actors.supervisor }, canDecide: false })
    expect((await block(waiting.id)).approvedById).toBe(actors.supervisor)
    expect((await outbox('production.off_standard_decided', waiting.id))[0]!.payload).toMatchObject({ status: 'APPROVED', decidedOn: 'OFFICE', bulk: false })
    expect(refusalOf(await no('supervisor', 'POST', `/production/offstandard/blocks/${waiting.id}/approve`, { version: approved.version }, 409))).toBe('refusal/NOT_PENDING')
    await no('viewer', 'POST', `/production/offstandard/blocks/${waiting.id}/reject`, { version: approved.version, reason: 'x' }, 403)
    await no('sew', 'GET', '/production/offstandard/blocks', undefined, 403)
  })

  it('rejects with a reason, reopens with a reason and its labour edit (MES-204)', async () => {
    const seeded = labour.blockIds[0]
    const record = (await ok('supervisor', 'GET', `/production/offstandard/blocks/${seeded}`)).block
    expect(record.edits).toHaveLength(1)
    await no('supervisor', 'POST', `/production/offstandard/blocks/${seeded}/reject`, { version: record.version }, 400)
    const rejected = (await ok('supervisor', 'POST', `/production/offstandard/blocks/${seeded}/reject`, { version: record.version, reason: 'The lining trolley was full: no wait.' })).block
    expect(rejected).toMatchObject({ status: 'REJECTED', rejectReason: 'The lining trolley was full: no wait.', rejectedBy: { id: actors.supervisor } })
    const reopened = (await ok('supervisor', 'POST', `/production/offstandard/blocks/${seeded}/reopen`, { version: rejected.version, reason: 'The worker showed the empty trolley photo.' })).block
    expect(reopened).toMatchObject({ status: 'PENDING', rejectedAt: null, rejectReason: null })
    expect(reopened.edits).toHaveLength(2)
    expect(reopened.edits[1]).toMatchObject({ reason: 'The worker showed the empty trolley photo.', before: { status: 'REJECTED' }, after: { status: 'PENDING' }, by: { id: actors.supervisor } })
    expect(refusalOf(await no('supervisor', 'POST', `/production/offstandard/blocks/${seeded}/reopen`, { version: reopened.version, reason: 'again' }, 409))).toBe('refusal/NOT_DECIDED')
  })

  it("corrects a waiting block's code with its labour edit; refuses overlapping times and a decided block", async () => {
    const overlap = await no('supervisor', 'POST', `/production/offstandard/blocks/${training.id}/correct`, { version: training.version, reason: 'Started earlier.', startedAt: minutesAgo(10) }, 409)
    expect(refusalOf(overlap)).toBe('refusal/OVERLAPS')
    const corrected = (await ok('supervisor', 'POST', `/production/offstandard/blocks/${training.id}/correct`, { version: training.version, reason: 'It was waiting for material, not training.', codeId: codes.WAIT_MATERIAL })).block
    expect(corrected).toMatchObject({ code: { code: 'WAIT_MATERIAL' }, status: 'PENDING', unusual: ['CHANGED'] })
    expect(corrected.edits[0]).toMatchObject({ before: { codeId: codes.TRAINING }, after: { codeId: codes.WAIT_MATERIAL } })
    expect((await admin('SELECT id FROM "LabourEdit" WHERE "recordId" = $1', [training.id])).length).toBe(1)
    expect(refusalOf(await no('supervisor', 'POST', `/production/offstandard/blocks/${waiting.id}/correct`, { version: 99, reason: 'x', codeId: codes.TRAINING }, 409))).toMatch(/version|refusal/)
    const approved = await block(waiting.id)
    expect(refusalOf(await no('supervisor', 'POST', `/production/offstandard/blocks/${waiting.id}/correct`, { version: approved.version, reason: 'x', codeId: codes.TRAINING }, 409))).toBe('refusal/NOT_PENDING')
  })

  it("refuses to touch a block of a line's CLOSED day (closed days feed pay; MES-203)", async () => {
    const cleaned = await block(labour.blockIds[1])
    const closed = await no('supervisor', 'POST', `/production/offstandard/blocks/${cleaned.id}/reopen`, { version: cleaned.version, reason: 'Check it again.' }, 409)
    expect(refusalOf(closed)).toBe('refusal/DAY_CLOSED')
    expect(closed.message).toMatch(/2026-11-16 of line L1/)
  })

  it('takes a block typed afterwards (never approved with others), in the site’s words about whom it names', async () => {
    const span = { startedAt: minutesAgo(180), endedAt: minutesAgo(170) }
    const typed = (await ok('manager', 'POST', '/production/offstandard/blocks', { siteId: siteA1, codeId: codes.TRAINING, workerId: operator, stationId: sew1, ...span, note: 'Safety training on the new press.' }, 201)).block
    expect(typed).toMatchObject({ status: 'PENDING', source: 'LEAD', unusual: ['TYPED_AFTERWARDS'], worker: { id: operator }, line: { code: 'L1' }, minutes: 10 })
    expect((await no('manager', 'POST', '/production/offstandard/blocks', { siteId: siteA1, codeId: codes.TRAINING, stationId: sew1, ...span }, 400)).issues[0].path).toBe('body/workerId')
    expect(refusalOf(await no('manager', 'POST', '/production/offstandard/blocks', { siteId: siteA1, codeId: codes.TRAINING, workerId: operator, ...span }, 409))).toBe('refusal/OVERLAPS')
    const future = await no('manager', 'POST', '/production/offstandard/blocks', { siteId: siteA1, codeId: codes.TRAINING, workerId: operator, startedAt: new Date(Date.now() + 3_600_000).toISOString(), endedAt: new Date(Date.now() + 7_200_000).toISOString() }, 400)
    expect(future.issues.map((issue: Json) => issue.path)).toContain('body/startedAt')
    expect((await no('companyB', 'POST', '/production/offstandard/blocks', { siteId: siteB1, codeId: await codeId(companyB, 'WAIT_WORK'), workerId: operator, stationId: b1Station, ...span }, 400)).issues[0].path).toBe('body/workerId')
    await no('companyB', 'POST', '/production/offstandard/blocks', { siteId: siteA1, codeId: codes.TRAINING, workerId: operator, ...span }, 404)
  })

  it('approves the normal blocks at once; the unusual and the decided ones are skipped and say why', async () => {
    await ok('sew', 'POST', '/production/offstandard/floor/start', { codeId: codes.WAIT_MATERIAL, clientEventId: evt('bulk-1') }, 201)
    await ok('sew', 'POST', '/production/offstandard/floor/start', { codeId: codes.TRAINING, clientEventId: evt('bulk-2') }, 201)
    await ok('sew', 'POST', '/production/offstandard/floor/end', { clientEventId: evt('bulk-3') })
    const normal = (await ok('supervisor', 'GET', `/production/offstandard/blocks?siteId=${siteA1}&normal=true`)).blocks
    const recent = normal.filter(fresh)
    expect(recent.map((row: Json) => row.code.code).sort()).toEqual(['TRAINING', 'WAIT_MATERIAL'])
    const typed = (await ok('supervisor', 'GET', `/production/offstandard/blocks?siteId=${siteA1}&status=PENDING`)).blocks.find((row: Json) => row.source === 'LEAD')
    const decided = await block(waiting.id)
    const answer = await ok('supervisor', 'POST', '/production/offstandard/blocks/approve', { blocks: [...recent.map((row: Json) => ({ id: row.id, version: row.version })), { id: typed.id, version: typed.version }, { id: waiting.id, version: decided.version }] })
    expect([...answer.approved].sort()).toEqual(recent.map((row: Json) => row.id).sort())
    expect(answer.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: typed.id, code: 'UNUSUAL', unusual: ['TYPED_AFTERWARDS'] }),
        expect.objectContaining({ id: waiting.id, code: 'NOT_PENDING' }),
      ]),
    )
    for (const row of recent) expect((await outbox('production.off_standard_decided', row.id))[0]!.payload).toMatchObject({ status: 'APPROVED', bulk: true })
  })

  it('ends a block left running from the office: now, or when it really ended with why', async () => {
    const started = (await ok('sew', 'POST', '/production/offstandard/floor/start', { codeId: codes.CLEANING, clientEventId: evt('forgot-1') }, 201)).block
    await no('supervisor', 'POST', `/production/offstandard/blocks/${started.id}/end`, { version: started.version, endedAt: new Date().toISOString() }, 400)
    const ended = (await ok('supervisor', 'POST', `/production/offstandard/blocks/${started.id}/end`, { version: started.version, endedAt: new Date().toISOString(), reason: 'The worker forgot to tap Done.' })).block
    expect(ended).toMatchObject({ status: 'APPROVED' })
    expect((await outbox('production.off_standard_ended', started.id))[0]!.payload).toMatchObject({ endedBy: 'LEAD' })
    expect(refusalOf(await no('supervisor', 'POST', `/production/offstandard/blocks/${started.id}/end`, { version: ended.version }, 409))).toBe('refusal/NOT_RUNNING')
  })

  it('keeps every reader to its scope', async () => {
    await no('elsewhere', 'GET', `/production/offstandard/blocks/${waiting.id}`, undefined, 404)
    expect((await ok('elsewhere', 'GET', '/production/offstandard/blocks')).blocks.every((row: Json) => row.siteId === siteB1)).toBe(true)
    await no('otherTenant', 'GET', `/production/offstandard/blocks/${waiting.id}`, undefined, 404)
    expect((await ok('otherTenant', 'GET', '/production/offstandard/codes')).codes).toEqual([])
    await no('noRight', 'GET', '/production/offstandard/blocks', undefined, 403)
    await no('noRight', 'GET', '/production/offstandard/codes', undefined, 403)
  })

  it('puts no person in an event (Statuto art. 4): ids of blocks, lines, stations and codes only', async () => {
    const rows = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type LIKE 'production.off_standard_%'`, [T])
    expect(rows.length).toBeGreaterThan(10)
    const text = JSON.stringify(rows)
    expect(text).not.toContain(operator)
    expect(text).not.toContain(OPERATOR_NAME)
    expect(text).not.toMatch(/workerId|employeeId|note/)
  })
})

describe("the team leader's approval on the tablet, with the PIN (MES-157)", () => {
  let tablet: Browser

  beforeAll(async () => {
    const supervisor = await addUser(h, TENANT, { email: `supervisor-${run}@example.test`, role: 'floor_supervisor' })
    const browser = new Browser(h.app)
    const signedIn = await browser.signIn(TENANT.slug, supervisor.email, supervisor.password)
    if (signedIn.body.status !== 'signed_in') throw new Error(`sign-in: ${signedIn.status} ${JSON.stringify(signedIn.body)}`)
    const made = await browser.post('/auth/floor/devices', { siteId: siteA1, stationId: sew2, name: `Line tablet ${run}` })
    if (made.status !== 200) throw new Error(`enrol: ${made.status} ${JSON.stringify(made.body)}`)
    await admin('UPDATE "Worker" SET "pinHash" = $2 WHERE id = $1', [lead, await hashPin(PIN, h.auth.pins, { logN: 12, r: 8, p: 1 })])
    tablet = new Browser(h.app)
    await tablet.get('/auth/csrf')
    const enrolled = await tablet.post('/floor/device/enrol', { code: made.body.enrolment.code, appVersion: '1.0.0' })
    if (enrolled.status !== 200) throw new Error(`exchange: ${enrolled.status} ${JSON.stringify(enrolled.body)}`)
    const leadIn = await tablet.post('/floor/sign-in', { workerId: lead, pin: PIN })
    if (leadIn.status !== 200) throw new Error(`floor sign-in: ${leadIn.status} ${JSON.stringify(leadIn.body)}`)
  }, 120_000)

  it("lists the site's waiting blocks for the team leader, never who; approves one with the PIN just proved", async () => {
    const list = await tablet.get('/production/offstandard/floor/lead')
    expect(list.status, JSON.stringify(list.body)).toBe(200)
    const rows = (list.body as Json).blocks as Json[]
    expect(rows.length).toBeGreaterThan(0)
    expect(JSON.stringify(rows)).not.toContain(OPERATOR_NAME)
    const target = rows.find((row) => row.source === 'FLOOR' && !row.own) ?? rows.find((row) => !row.own)!
    const approved = await tablet.post(`/production/offstandard/floor/lead/${target.id}/approve`, { version: target.version }, { headers: { 'idempotency-key': key() } })
    expect(approved.status, JSON.stringify(approved.body)).toBe(200)
    expect((approved.body as Json).block).toMatchObject({ id: target.id, status: 'APPROVED' })
    expect(await block(target.id)).toMatchObject({ status: 'APPROVED', approvedById: lead })
    expect((await outbox('production.off_standard_decided', target.id)).at(-1)!.payload).toMatchObject({ decidedOn: 'FLOOR' })
  })

  it('asks the PIN again once the step-up window has passed (a signing act)', async () => {
    h.clock.advance(3 * 60_000)
    const rows = ((await tablet.get('/production/offstandard/floor/lead')).body as Json).blocks as Json[]
    const target = rows.find((row) => !row.own)!
    const late = await tablet.post(`/production/offstandard/floor/lead/${target.id}/reject`, { version: target.version, reason: 'Not a real wait.' }, { headers: { 'idempotency-key': key() } })
    expect(late.status).toBe(403)
    expect((late.body as Json).error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
    expect((await block(target.id)).status).toBe('PENDING')
  })
})
