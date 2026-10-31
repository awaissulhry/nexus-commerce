import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPin } from '@nexus/factory-domain/auth/floor/pin'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../auth/sessions/testing/harness'

/**
 * Offline conflicts go to the lead (B-W2b-52; MES-196; design floor.supervisor "Waiting for you") on the local stack with
 * the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime logins: row-level security
 * and the triggers are real), the factory-db seeds up to production (plant A1 names workers; its operator acknowledged
 * the worker notice; WO-0001 in progress with two bundles; bundle 2 reported at sewing by the seeded cutting tablet).
 * Made-up tablets at sewing stations 1 and 2 (both on line L1) send their queues through POST /floor/sync (the test
 * authenticator); the team leader signs in for real (badge and PIN) on a line tablet enrolled in LINE mode for L1, and
 * decides with the PIN. Every name and number is made up.
 */

let h: Harness
let app: FastifyInstance

const ns = 'conflicts-a'
const idOf = (key: string) => seedUuid(ns, key)
const A = {
  tenant: idOf('tenant'),
  actor: idOf('actor'),
  companyA: idOf('company:A'),
  companyB: idOf('company:B'),
  siteA1: idOf('site:A1'),
  line1: idOf('site:A1:line:L1'),
  cutStation: idOf('site:A1:station:CUT-01'),
  sew1Station: idOf('site:A1:station:SEW-01'),
  sew2Station: idOf('site:A1:station:SEW-02'),
  operatorA1: idOf('worker:A1:operator'),
  wo1: idOf('production:work-order:WO-0001'),
  bundle1: idOf('production:bundle:WO-0001:1'),
  bundle2: idOf('production:bundle:WO-0001:2'),
  cutTablet: newId(),
  sew1: newId(),
  sew2: newId(),
}
const TENANT: TestTenant = { id: A.tenant, slug: ns, companies: [{ id: A.companyA, code: 'A' }, { id: A.companyB, code: 'B' }] }
const PIN = '482913'

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const FLOOR: Permission[] = ['floor.work', 'production.scan']
const floor = (deviceId: string, permissions: Permission[] = FLOOR): SessionContext => ({ audience: 'floor', tenantId: A.tenant, actorId: A.operatorA1, siteId: A.siteA1, deviceId, grants: [{ permissions, companies: [A.companyA], sites: [A.siteA1], parties: 'all' }] })
const SESSIONS: Record<string, SessionContext> = {
  cut: floor(A.cutTablet),
  sew1: floor(A.sew1),
  sew2: floor(A.sew2),
  /** The operator on sewing tablet 1, without the lead's permission. */
  operator: floor(A.sew1),
  supervisor: { audience: 'office', tenantId: A.tenant, actorId: A.actor, grants: [grant(['floorsync.view', 'floorsync.discard'])] },
  companyB: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(['floorsync.view'], [A.companyB])] },
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `t-${run}-${++keys}`
let seq = 0
const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': freshKey() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function send(session: string, payload: Json): Promise<Json> {
  const event = { clientEventId: `cf-${run}-${++seq}`, seq, kind: 'production.scan.report', occurredAt: new Date(Date.parse('2026-11-18T08:00:00.000Z') + seq * 1000).toISOString(), payload }
  const response = await call(session, 'POST', '/floor/sync', { events: [event] })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().events[0]
}

let ops: { cut: string; sew: string }
let codes: { b1: string; b2: string }
let lead: { tablet: Browser; workerId: string; badgeCode: string }
const conflicts: { double: string; seeded: string; own: string } = { double: '', seeded: '', own: '' }

/** The team leader signs in on an enrolled LINE tablet for L1 (the office enrols it with the mode, MES-181). */
async function leadOnLineTablet(): Promise<typeof lead> {
  const user = await addUser(h, TENANT, { email: `lead-office-${run}@example.test`, role: 'floor_supervisor' })
  const office = new Browser(h.app)
  const answer = await office.signIn(TENANT.slug, user.email, user.password)
  if (answer.body.status !== 'signed_in') throw new Error(`sign-in: ${answer.status} ${JSON.stringify(answer.body)}`)
  const secret = await enrolTotp(h, office)
  await stepUp(h, office, secret)
  const role = (await admin<{ id: string }>('SELECT id::text FROM "Role" WHERE "tenantId" = $1::uuid AND key = $2', [A.tenant, 'team_leader']))[0]!.id
  const worker = await office.post('/auth/floor/workers', { siteId: A.siteA1, displayName: 'Made-up Team Leader', locale: 'it', roleIds: [role] })
  if (worker.status !== 200) throw new Error(`worker: ${worker.status} ${JSON.stringify(worker.body)}`)
  const badge = await office.post(`/auth/floor/workers/${worker.body.id}/badges`)
  await admin('UPDATE "Worker" SET "pinHash" = $2 WHERE id = $1::uuid', [worker.body.id, await hashPin(PIN, h.auth.pins, { logN: 12, r: 8, p: 1 })])
  const made = await office.post('/auth/floor/devices', { siteId: A.siteA1, name: `Line 1 lead tablet ${run}`, mode: 'LINE', lineId: A.line1 })
  if (made.status !== 200) throw new Error(`enrol: ${made.status} ${JSON.stringify(made.body)}`)
  const tablet = new Browser(h.app)
  await tablet.get('/auth/csrf')
  const enrolled = await tablet.post('/floor/device/enrol', { code: made.body.enrolment.code, appVersion: '1.0.0' })
  if (enrolled.status !== 200) throw new Error(`exchange: ${enrolled.status} ${JSON.stringify(enrolled.body)}`)
  expect(enrolled.body).toMatchObject({ device: { mode: 'LINE' }, rules: { landing: 'LINE_VIEW' }, line: { id: A.line1 } })
  return { tablet, workerId: worker.body.id, badgeCode: badge.body.code }
}

const signInLead = async () => {
  const signed = await lead.tablet.post('/floor/sign-in', { badgeCode: lead.badgeCode, pin: PIN })
  expect(signed.status, JSON.stringify(signed.body)).toBe(200)
}
const asLead = (method: 'GET' | 'POST', url: string, body?: unknown) => lead.tablet.send(method, url, body, method === 'GET' ? {} : { headers: { 'idempotency-key': freshKey() } })

beforeAll(async () => {
  h = await startHarness('floor_conflicts')
  await seedCore({ db: h.database, namespace: ns })
  await seedPrivacy({ db: h.database, namespace: ns })
  await seedProduction({ db: h.database, namespace: ns })
  await seedNumbering({ db: h.database, namespace: ns })
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) =>
    applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }),
  )
  for (const [deviceId, stationId, name] of [
    [A.cutTablet, A.cutStation, 'Made-up cutting tablet 2'],
    [A.sew1, A.sew1Station, 'Made-up sewing tablet 1'],
    [A.sew2, A.sew2Station, 'Made-up sewing tablet 2'],
  ] as const) {
    await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, $6, 'TABLET', 'ACTIVE', now())`, [deviceId, A.tenant, A.companyA, A.siteA1, stationId, name])
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  const operations = await admin<{ id: string; seq: number }>('SELECT id::text, seq FROM "WorkOrderOperation" WHERE "workOrderId" = $1 ORDER BY seq', [A.wo1])
  ops = { cut: operations.find((op) => op.seq === 10)!.id, sew: operations.find((op) => op.seq === 20)!.id }
  const bundles = await admin<{ id: string; code: string }>('SELECT id::text, code FROM "Bundle" WHERE id = ANY($1::uuid[])', [[A.bundle1, A.bundle2]])
  codes = { b1: bundles.find((row) => row.id === A.bundle1)!.code, b2: bundles.find((row) => row.id === A.bundle2)!.code }
  lead = await leadOnLineTablet()

  // Bundle 1: cut on the second cutting tablet, sewn on sewing tablet 1, then reported again on sewing tablet 2 (offline).
  expect((await send('cut', { code: codes.b1, good: 1, workOrderOperationId: ops.cut })).status).toBe('accepted')
  expect((await send('sew1', { code: codes.b1, good: 1, workOrderOperationId: ops.sew })).status).toBe('accepted')
  const double = await send('sew2', { code: codes.b1, good: 1, workOrderOperationId: ops.sew })
  expect(double).toMatchObject({ status: 'refused', refusal: { code: 'ALREADY_REPORTED' } })
  conflicts.double = double.refusal.id
  // Bundle 2: reported at sewing by the seeded cutting tablet; sewing tablet 2 reports it with other counts.
  const seeded = await send('sew2', { code: codes.b2, good: 1, workOrderOperationId: ops.sew })
  expect(seeded).toMatchObject({ status: 'refused', refusal: { code: 'ALREADY_REPORTED' } })
  conflicts.seeded = seeded.refusal.id
  // Sewing tablet 1 scans bundle 1 again: its own double scan, the operator's refusal, never the lead's.
  const own = await send('sew1', { code: codes.b1, good: 1, workOrderOperationId: ops.sew })
  expect(own).toMatchObject({ status: 'refused', refusal: { code: 'ALREADY_REPORTED' } })
  conflicts.own = own.refusal.id
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('the lead sees the conflicts of the line (MES-196)', { timeout: 60_000 }, () => {
  it('lists both conflicts on L1 with both reports side by side, never a worker; the tablet\'s own double scan is not one', async () => {
    await signInLead()
    const answer = await asLead('GET', '/floor/sync/conflicts')
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(answer.body.line).toMatchObject({ id: A.line1, code: 'L1' })
    const ids = answer.body.conflicts.map((row: Json) => row.id)
    expect(ids).toEqual([conflicts.double, conflicts.seeded])
    expect(ids).not.toContain(conflicts.own)
    const double = answer.body.conflicts[0]
    expect(double).toMatchObject({
      kind: 'DOUBLE_REPORT',
      state: 'OPEN',
      look: { icon: 'git-compare', tone: 'warning' },
      bundle: { id: A.bundle1, code: codes.b1 },
      operation: { id: ops.sew, seq: 20 },
      refused: { deviceId: A.sew2, deviceName: 'Made-up sewing tablet 2', station: { code: 'SEW-02' }, good: 1, scrap: 0, rework: 0 },
      recorded: { deviceId: A.sew1, deviceName: 'Made-up sewing tablet 1', station: { code: 'SEW-01' }, corrected: false, good: 1 },
      sentToOfficeAt: null,
    })
    expect(answer.body.decisions.map((row: Json) => [row.decision, row.signs, row.reasons.map((reason: Json) => reason.code)])).toEqual([
      ['KEEP_RECORDED', true, ['SAME_WORK', 'SCANNED_TWICE', 'WRONG_TABLET']],
      ['SEND_TO_OFFICE', false, ['COUNTS_WRONG', 'OTHER_STATION']],
    ])
    // Statuto dei Lavoratori art. 4 (Owner answer W1): no worker in the list.
    expect(JSON.stringify(answer.body)).not.toMatch(/workerId|Made-up Operator|refusedBy|recordedBy/)
  })

  it('one conflict names its two reporters, where the site names workers (inside this one record)', async () => {
    const one = await asLead('GET', `/floor/sync/conflicts/${conflicts.double}`)
    expect(one.status).toBe(200)
    expect(one.body.conflict.refusedBy).toMatchObject({ id: A.operatorA1 })
    expect(one.body.conflict.recordedBy).toMatchObject({ id: A.operatorA1 })
    expect((await asLead('GET', `/floor/sync/conflicts/${conflicts.own}`)).status).toBe(404)
    expect((await asLead('GET', `/floor/sync/conflicts/${newId()}`)).status).toBe(404)
  })

  it('another line shows none of them; a line of no site of the tablet is a 400; an operator without floor.lead sees nothing', async () => {
    const other = newId()
    await admin(`INSERT INTO "Line" (id, "tenantId", "companyId", "siteId", code, name) VALUES ($1, $2, $3, $4, 'L9', 'Made-up line 9')`, [other, A.tenant, A.companyA, A.siteA1])
    expect((await asLead('GET', `/floor/sync/conflicts?lineId=${other}`)).body.conflicts).toEqual([])
    expect((await asLead('GET', `/floor/sync/conflicts?lineId=${newId()}`)).status).toBe(400)
    expect((await call('operator', 'GET', '/floor/sync/conflicts')).statusCode).toBe(403)
  })
})

describe('the lead decides (MES-196)', { timeout: 60_000 }, () => {
  it('SEND_TO_OFFICE: the refused report should stand; it stays open with the office, announced, kept on its history; once', async () => {
    const before = (await asLead('GET', `/floor/sync/conflicts/${conflicts.seeded}`)).body.conflict
    expect((await asLead('POST', `/floor/sync/conflicts/${conflicts.seeded}/decide`, { decision: 'SEND_TO_OFFICE', reason: 'SAME_WORK', version: before.version })).status).toBe(400)
    expect((await asLead('POST', `/floor/sync/conflicts/${conflicts.seeded}/decide`, { decision: 'SEND_TO_OFFICE', reason: 'COUNTS_WRONG', version: before.version + 1 })).status).toBe(409)
    const sent = await asLead('POST', `/floor/sync/conflicts/${conflicts.seeded}/decide`, { decision: 'SEND_TO_OFFICE', reason: 'COUNTS_WRONG', version: before.version })
    expect(sent.status, JSON.stringify(sent.body)).toBe(200)
    expect(sent.body).toMatchObject({ decision: 'SEND_TO_OFFICE', status: 'OPEN', state: 'WITH_OFFICE' })
    expect((await asLead('POST', `/floor/sync/conflicts/${conflicts.seeded}/decide`, { decision: 'SEND_TO_OFFICE', reason: 'COUNTS_WRONG', version: before.version })).status).toBe(200)
    const audits = await admin(`SELECT reason, audience::text FROM "AuditLog" WHERE "recordType" = 'FloorRefusedAction' AND "recordId" = $1 AND action = 'floorsync.conflictToOffice'`, [conflicts.seeded])
    expect(audits).toEqual([{ reason: 'The team leader asks the office to let this report stand: the counts recorded first are wrong.', audience: 'FLOOR' }])
    const events = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'floor.conflict_sent_to_office' AND subject = $1`, [conflicts.seeded])
    expect(events).toEqual([{ payload: { refusedId: conflicts.seeded, deviceId: A.sew2, kind: 'DOUBLE_REPORT', reason: 'COUNTS_WRONG' } }])
    const [row] = await admin(`SELECT status::text FROM "FloorRefusedAction" WHERE id = $1`, [conflicts.seeded])
    expect(row).toEqual({ status: 'OPEN' })
    const list = (await asLead('GET', '/floor/sync/conflicts')).body.conflicts as Json[]
    expect(list.map((item) => [item.id, item.state])).toEqual([
      [conflicts.double, 'OPEN'],
      [conflicts.seeded, 'WITH_OFFICE'],
    ])
    expect(list[1]!.sentToOfficeAt).not.toBeNull()
    expect(((await asLead('GET', '/floor/sync/conflicts?state=OPEN')).body.conflicts as Json[]).map((item) => item.id)).toEqual([conflicts.double])
    // The office sees it with the office, in its scope only.
    const office = await call('supervisor', 'GET', '/floor-sync/conflicts?state=WITH_OFFICE')
    expect(office.statusCode, office.body).toBe(200)
    expect(office.json().conflicts.map((item: Json) => [item.id, item.siteId])).toEqual([[conflicts.seeded, A.siteA1]])
    expect((await call('companyB', 'GET', '/floor-sync/conflicts')).json().conflicts).toEqual([])
  })

  it('KEEP_RECORDED: a signing act (the PIN); the refused report is discarded with the lead\'s reason, the scan module\'s record with it', async () => {
    const before = (await asLead('GET', `/floor/sync/conflicts/${conflicts.double}`)).body.conflict
    // Three minutes after the sign-in's PIN: the PIN again first.
    h.clock.advance(3 * 60_000)
    const held = await asLead('POST', `/floor/sync/conflicts/${conflicts.double}/decide`, { decision: 'KEEP_RECORDED', reason: 'SAME_WORK', version: before.version })
    expect(held.status).toBe(403)
    expect(held.body.error.issues[0].path).toBe('stepUp')
    expect((await lead.tablet.post('/floor/step-up', { pin: PIN })).status).toBe(200)
    expect((await asLead('POST', `/floor/sync/conflicts/${conflicts.double}/decide`, { decision: 'KEEP_RECORDED', reason: 'COUNTS_WRONG', version: before.version })).status).toBe(400)
    const kept = await asLead('POST', `/floor/sync/conflicts/${conflicts.double}/decide`, { decision: 'KEEP_RECORDED', reason: 'SAME_WORK', version: before.version })
    expect(kept.status, JSON.stringify(kept.body)).toBe(200)
    expect(kept.body).toMatchObject({ decision: 'KEEP_RECORDED', status: 'DISCARDED', state: 'CLOSED' })
    const [row] = await admin(`SELECT status::text, "discardedBy"::text, "discardReason", "moduleRefusalId"::text FROM "FloorRefusedAction" WHERE id = $1`, [conflicts.double])
    expect(row).toMatchObject({ status: 'DISCARDED', discardedBy: 'FLOOR', discardReason: 'The team leader kept the report recorded first: both tablets reported the same work.' })
    const [scanRefusal] = await admin(`SELECT "discardedAt" FROM "FloorScanRefusal" WHERE id = $1`, [row!.moduleRefusalId])
    expect(scanRefusal!.discardedAt).not.toBeNull()
    // The recorded report stands untouched (the seed's first one was undone); nothing of sewing tablet 2's was recorded.
    expect(await admin(`SELECT "deviceId"::text AS "deviceId", count(*)::int AS n FROM "OperationScan" WHERE "bundleId" = $1 AND "workOrderOperationId" = $2 AND kind = 'REPORT' AND "deviceId" = ANY($3::uuid[]) GROUP BY 1`, [A.bundle1, ops.sew, [A.sew1, A.sew2]])).toEqual([{ deviceId: A.sew1, n: 1 }])
    expect(((await asLead('GET', '/floor/sync/conflicts')).body.conflicts as Json[]).map((item) => item.id)).toEqual([conflicts.seeded])
    expect((await asLead('GET', `/floor/sync/conflicts/${conflicts.double}`)).status).toBe(404)
  })
})
