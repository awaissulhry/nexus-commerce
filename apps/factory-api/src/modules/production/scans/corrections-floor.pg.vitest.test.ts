import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPin } from '@nexus/factory-domain/auth/floor/pin'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seed as seedProduction, type ProductionSeed } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { switchOnPerformance } from '../../people/privacy/testing/performance-gate'

/**
 * A team leader decides a correction on the tablet (B-W2b-83; MES-096; design floor.supervisor "Waiting for you", floor.operation
 * "correction": W2b, the Line view; c.c. art. 2101: the original stays) through the app's real routes on a throwaway PostgreSQL 17
 * database from the migrations (the runtime and floor logins: row-level security, the grants and the scan triggers are real), on
 * the factory-db seeds up to production: WO-0001 in progress at plant A1 (which names workers; its operator acknowledged the
 * notice), one correction waiting. A real team leader signs in with the PIN on an enrolled tablet: every decision signs. The law
 * the tests name: Statuto dei Lavoratori (L. 300/1970) art. 4: the waiting list names no person. Every name and number is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/production/scans/corrections-floor`.
 */

let h: Harness
let app: FastifyInstance
let seed: ProductionSeed
let tablet: Browser

const NS = 'w2b83-floor-corrections'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const companyB = idOf('company:B')
const siteA1 = idOf('site:A1')
const siteB1 = idOf('site:B1')
const operator = idOf('worker:A1:operator')
const lead = idOf('worker:A1:lead')
const device = idOf('device:A1:cutting')
const deviceB1 = idOf('device:B1:cutting')
const qcStation = idOf('site:A1:station:QC-01')
const cutStation = idOf('site:A1:station:CUT-01')
const sew2 = idOf('site:A1:station:SEW-02')
const OPERATOR_NAME = 'Seed Worker A1-1'
const TENANT: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'A' }, { id: companyB, code: 'B' }] }
const PIN = '482913'
const leadUser = newId()
const supervisorUser = newId()

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (grants: Grant[], actorId: string = newId()): SessionContext => ({ audience: 'office', tenantId: T, actorId, grants })
const floor = (actorId: string, permissions: Permission[], siteId = siteA1, deviceId = device, companyId = companyA): SessionContext => ({ audience: 'floor', tenantId: T, actorId, siteId, deviceId, grants: [grant(permissions, [companyId], [siteId])] })
const SESSIONS: Record<string, SessionContext> = {
  supervisor: office([grant(['workorders.view', 'production.scan.correct', 'production.scan'])], supervisorUser),
  operator: floor(operator, ['floor.work', 'production.scan']),
  /** The worker who took the scans, holding floor.lead: decides nothing of them. */
  operatorAsLead: floor(operator, ['floor.work', 'floor.lead']),
  lead: floor(lead, ['floor.work', 'floor.lead']),
  /** A team leader's session at the other site of the tenant. */
  leadB1: floor(idOf('worker:B1:operator'), ['floor.work', 'floor.lead'], siteB1, deviceB1, companyB),
}

type Json = Record<string, any>
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const run = randomBytes(4).toString('hex')
let serial = 0
const key = () => `t-${run}-${++serial}`
const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: 'GET' | 'POST', url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const refusalOf = (error: Json): string => String(error.issues?.[0]?.path ?? '')
const LIST = '/production/scans/floor/corrections'
const requestOf = (id: string) => admin('SELECT status::text, "decidedById", "decidedAt", "decisionNote", "correctionScanId", version FROM "ScanCorrectionRequest" WHERE id = $1', [id]).then((rows) => rows[0]!)
const decide = (requestId: string, act: 'approve' | 'refuse', body: Json, idempotencyKey = key()) => tablet.post(`${LIST}/${requestId}/${act}`, body, { headers: { 'idempotency-key': idempotencyKey } })
const atScan = <Answer,>(work: (client: Parameters<Parameters<Harness['database']['withScope']>[1]>[0]) => Promise<Answer>) => h.database.withScope({ audience: 'floor', tenantId: T, actorId: operator, siteId: siteA1 }, work)

/** A standing report of bundle 2 at final inspection (two good), as the operator's tablet writes it; what stood there is undone. */
async function reported(extra: { readonly createdById?: string; readonly workerId?: string | null } = {}): Promise<string> {
  const [standing] = await admin<{ id: string }>(
    `SELECT s.id FROM "OperationScan" s WHERE s."bundleId" = $1 AND s."workOrderOperationId" = $2 AND s.kind IN ('REPORT', 'CORRECTION') AND NOT EXISTS (SELECT 1 FROM "OperationScan" v WHERE v."correctsId" = s.id)`,
    [seed.bundleIds[1], seed.operationIds.qc],
  )
  if (standing) {
    const row = (await admin<{ workerId: string | null; stationId: string | null }>('SELECT "workerId", "stationId" FROM "OperationScan" WHERE id = $1', [standing.id]))[0]!
    await atScan((client) => client.operationScan.create({ data: { id: newId(), siteId: siteA1, workOrderId: seed.workOrderId, workOrderOperationId: seed.operationIds.qc, bundleId: seed.bundleIds[1], kind: 'UNDO', correctsId: standing.id, reason: 'Scanned in a hurry.', workerId: row.workerId, stationId: row.stationId, deviceId: device, clientScanId: `w2b83-${run}-${++serial}`, createdById: operator }, select: { id: true } }))
  }
  const id = newId()
  await atScan((client) =>
    client.operationScan.create({
      data: { id, siteId: siteA1, workOrderId: seed.workOrderId, workOrderOperationId: seed.operationIds.qc, bundleId: seed.bundleIds[1], kind: 'REPORT', goodQuantity: 2, workerId: extra.workerId === undefined ? operator : extra.workerId, stationId: qcStation, deviceId: device, clientScanId: `w2b83-${run}-${++serial}`, createdById: extra.createdById ?? operator },
      select: { id: true },
    }),
  )
  return id
}

/** A correction of that report, asked through the real route. */
async function asked(extra: Parameters<typeof reported>[0] = {}): Promise<{ scanId: string; requestId: string }> {
  const scanId = await reported(extra)
  const answer = await app.inject({ method: 'POST', url: `/production/scans/${scanId}/corrections`, headers: { 'x-test-session': 'operator' }, payload: { clientScanId: `ask-${run}-${++serial}`, good: 1, scrap: [{ reason: 'STAIN', quantity: 1 }], reason: 'One has a stain that does not clean off.' } })
  expect(answer.statusCode, answer.body).toBe(201)
  return { scanId, requestId: answer.json().request.id }
}

beforeAll(async () => {
  h = await startHarness('w2b83_floor_fix')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  // The floor's readiness for the real ask (the DPIA and the worker notice in force).
  await seedPrivacy({ db: h.database, namespace: NS })
  seed = await seedProduction({ db: h.database, namespace: NS })
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  // The seed's bundle 2 stands at sewing, not at cutting (its cut report was undone): the rules want the operation before it.
  await atScan((client) => client.operationScan.create({ data: { id: newId(), siteId: siteA1, workOrderId: seed.workOrderId, workOrderOperationId: seed.operationIds.cut, bundleId: seed.bundleIds[1], kind: 'REPORT', goodQuantity: 2, workerId: operator, stationId: cutStation, deviceId: device, clientScanId: `w2b83-${run}-cut`, createdById: operator }, select: { id: true } }))
  // A real team leader on a real tablet: every decision signs with the PIN.
  const manager = await addUser(h, TENANT, { email: `supervisor-${run}@example.test`, role: 'floor_supervisor' })
  const browser = new Browser(h.app)
  const signedIn = await browser.signIn(TENANT.slug, manager.email, manager.password)
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
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('what waits for the team leader', () => {
  it('lists the site’s open requests with what, where and old → new counts: never who (art. 4), nothing a floor role may not read', async () => {
    const { rows, refusalTiles } = await ok('lead', 'GET', LIST)
    const row = rows.find((entry: Json) => entry.id === seed.correctionRequestId)
    expect(row).toMatchObject({ version: 1, operation: { seq: 20 }, recorded: { good: 2, scrap: 0, rework: 0 }, asked: { good: 1, scrap: 1, rework: 0 }, own: false })
    expect(row.bundle.code).toBeTruthy()
    expect(row.station).not.toBeNull()
    expect(refusalTiles.map((tile: Json) => tile.code)).toEqual(['RECORDED_RIGHT', 'COUNTS_WRONG', 'WRONG_REPORT', 'OTHER'])
    expect(JSON.stringify(rows)).not.toContain(OPERATOR_NAME)
    expect(JSON.stringify(rows)).not.toContain(operator)
  })

  it('opens one record: the asker’s words, the reasons and who took the scan, the name and no figure about them', async () => {
    const { request } = await ok('lead', 'GET', `${LIST}/${seed.correctionRequestId}`)
    expect(request).toMatchObject({ status: 'PENDING', person: OPERATOR_NAME, reason: 'One sleeve set has a stain that does not clean off.', reasons: [{ kind: 'SCRAP', code: 'STAIN', quantity: 1 }], recordedReasons: [] })
    expect(request.reasons[0].labelEn).toBe('Stain')
    expect(Object.keys(request).filter((name) => /minutes|pace|earned|rate|target|efficiency/i.test(name))).toEqual([])
  })

  it('a site that records the station only names nobody', async () => {
    await admin(`UPDATE "ProductionSettings" SET "scanSubject" = 'STATION' WHERE id = $1`, [siteA1])
    const scanId = await reported({ workerId: null })
    const requestId = newId()
    await atScan((client) => client.scanCorrectionRequest.create({ data: { id: requestId, siteId: siteA1, workOrderId: seed.workOrderId, bundleId: seed.bundleIds[1], workOrderOperationId: seed.operationIds.qc, scanId, goodQuantity: 1, reworkQuantity: 1, reason: 'Counted again.', stationId: qcStation, deviceId: device, clientRequestId: `ask-${run}-${++serial}`, createdById: operator }, select: { id: true } }))
    await admin(`UPDATE "ProductionSettings" SET "scanSubject" = 'WORKER' WHERE id = $1`, [siteA1])
    expect((await ok('lead', 'GET', `${LIST}/${requestId}`)).request.person).toBeNull()
  })

  it('needs floor.lead; another site’s lead does not reach it, and the office does not use these routes', async () => {
    expect((await call('operator', 'GET', LIST)).statusCode).toBe(403)
    expect((await ok('leadB1', 'GET', LIST)).rows).toEqual([])
    expect((await call('leadB1', 'GET', `${LIST}/${seed.correctionRequestId}`)).statusCode).toBe(404)
    expect((await call('supervisor', 'GET', LIST)).statusCode).toBe(403)
  })
})

describe('four eyes: the lead cannot decide their own (MES-096)', () => {
  it('the worker who took the scan and asked: held on the list, refused in words before any PIN, approving or refusing', async () => {
    const { requestId } = await asked()
    expect((await ok('operatorAsLead', 'GET', LIST)).rows.find((row: Json) => row.id === requestId).own).toBe(true)
    expect((await ok('lead', 'GET', LIST)).rows.find((row: Json) => row.id === requestId).own).toBe(false)
    const approve = await call('operatorAsLead', 'POST', `${LIST}/${requestId}/approve`, { version: 1 })
    expect(approve.statusCode, approve.body).toBe(409)
    expect(refusalOf(approve.json().error)).toBe('refusal/SELF_APPROVAL')
    const refusal = await call('operatorAsLead', 'POST', `${LIST}/${requestId}/refuse`, { version: 1, reason: 'RECORDED_RIGHT' })
    expect(refusal.statusCode, refusal.body).toBe(409)
    expect(refusalOf(refusal.json().error)).toBe('refusal/SELF_APPROVAL')
    expect(await requestOf(requestId)).toMatchObject({ status: 'PENDING', version: 1 })
  })

  it('reads the office account in the system scope: a lead whose account wrote the scan is held, though the database compares ids only', async () => {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, "updatedAt") VALUES ($1, $2, $3, 'Made-up Lead (office)', 'ACTIVE', now())`, [leadUser, T, `lead-${run}@example.test`])
    await admin('UPDATE "Worker" SET "userId" = $2 WHERE id = $1', [lead, leadUser])
    const { requestId } = await asked({ createdById: leadUser })
    expect((await ok('lead', 'GET', LIST)).rows.find((row: Json) => row.id === requestId).own).toBe(true)
    for (const [act, body] of [['approve', { version: 1 }], ['refuse', { version: 1, reason: 'RECORDED_RIGHT' }]] as const) {
      const answer = await call('lead', 'POST', `${LIST}/${requestId}/${act}`, body)
      expect(answer.statusCode, answer.body).toBe(409)
      expect(refusalOf(answer.json().error)).toBe('refusal/SELF_APPROVAL')
    }
    await admin('UPDATE "Worker" SET "userId" = NULL WHERE id = $1', [lead])
  })

  it('the office is held the same way, in words, for a refusal too', async () => {
    const { requestId } = await asked()
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, "updatedAt") VALUES ($1, $2, $3, 'Made-up Supervisor', 'ACTIVE', now())`, [supervisorUser, T, `office-${run}@example.test`])
    await admin('UPDATE "Worker" SET "userId" = $2 WHERE id = $1', [operator, supervisorUser])
    const answer = await call('supervisor', 'POST', `/production/scans/corrections/${requestId}/refuse`, { note: 'Not this one.' })
    expect(answer.statusCode, answer.body).toBe(409)
    expect(refusalOf(answer.json().error)).toBe('refusal/SELF_APPROVAL')
    await admin('UPDATE "Worker" SET "userId" = NULL WHERE id = $1', [operator])
  })
})

describe('the team leader decides with the PIN (c.c. art. 2101: the original stays)', () => {
  let signed: { scanId: string; requestId: string }

  it('asks the PIN once the step-up window passed: nothing is written until it is proved', async () => {
    signed = await asked()
    const { requestId } = signed
    h.clock.advance(3 * 60_000)
    for (const [act, body] of [['approve', { version: 1 }], ['refuse', { version: 1, reason: 'RECORDED_RIGHT' }]] as const) {
      const late = await decide(requestId, act, body)
      expect(late.status).toBe(403)
      expect((late.body as Json).error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
    }
    expect(await requestOf(requestId)).toMatchObject({ status: 'PENDING', decidedById: null })
    const proved = await tablet.post('/floor/step-up', { pin: PIN })
    expect(proved.status, JSON.stringify(proved.body)).toBe(200)
  })

  it('approves: the CORRECTION scan posts in the same command, by the lead, with the old scan’s worker and station; the original stays', async () => {
    const { requestId, scanId } = signed
    const idempotency = key()
    const approved = await decide(requestId, 'approve', { version: 1 }, idempotency)
    expect(approved.status, JSON.stringify(approved.body)).toBe(201)
    const answer = approved.body as Json
    expect(answer).toEqual({ id: requestId, status: 'APPROVED', correctionScanId: expect.any(String) })
    expect(await requestOf(requestId)).toMatchObject({ status: 'APPROVED', decidedById: lead, correctionScanId: answer.correctionScanId, version: 2 })
    const [scan] = await admin('SELECT kind::text, "correctsId", "goodQuantity", "scrapQuantity", "workerId", "stationId", "approvedById", "createdById", "deviceId", reason FROM "OperationScan" WHERE id = $1', [answer.correctionScanId])
    expect(scan).toEqual({ kind: 'CORRECTION', correctsId: scanId, goodQuantity: 1, scrapQuantity: 1, workerId: operator, stationId: qcStation, approvedById: lead, createdById: lead, deviceId: null, reason: 'One has a stain that does not clean off.' })
    expect(await admin('SELECT "reasonCode", quantity FROM "OperationScanDefect" WHERE "scanId" = $1', [answer.correctionScanId])).toEqual([{ reasonCode: 'STAIN', quantity: 1 }])
    expect(await admin('SELECT id FROM "OperationScan" WHERE id = $1', [scanId])).toHaveLength(1)
    const audit = await admin(`SELECT "recordType", "actorId", audience::text AS audience FROM "AuditLog" WHERE action = 'production.approveScanCorrection' AND ("recordId" = $1 OR "recordId" = $2) ORDER BY "recordType"`, [answer.correctionScanId, requestId])
    expect(audit.map((row) => [row.recordType, row.actorId, row.audience])).toEqual([
      ['OperationScan', lead, 'FLOOR'],
      ['ScanCorrectionRequest', lead, 'FLOOR'],
    ])
    const [recorded] = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'production.scan_recorded' AND payload->>'scanId' = $1`, [answer.correctionScanId])
    expect(recorded!.payload).toMatchObject({ kind: 'CORRECTION', postedBy: 'FLOOR', goodQuantity: 1, scrapQuantity: 1 })
    const [decided] = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'production.scan_correction_decided' AND payload->>'requestId' = $1`, [requestId])
    expect(decided!.payload).toMatchObject({ decision: 'APPROVED', correctionScanId: answer.correctionScanId })
    expect(Object.keys(decided!.payload as Json).filter((name) => /worker|lead|person|name/i.test(name))).toEqual([])
    expect((await ok('lead', 'GET', LIST)).rows.map((row: Json) => row.id)).not.toContain(requestId)
    // The answer lost, the same key again: the first answer, nothing twice, no refusal of one's own act.
    const repeat = await decide(requestId, 'approve', { version: 1 }, idempotency)
    expect(repeat.status, JSON.stringify(repeat.body)).toBe(201)
    expect(repeat.body).toEqual(answer)
    expect(await admin(`SELECT id FROM "OperationScan" WHERE "correctsId" = $1`, [scanId])).toHaveLength(1)
    // Another key: decided already, in words; no PIN is asked for it.
    const again = await decide(requestId, 'refuse', { version: 2, reason: 'RECORDED_RIGHT' })
    expect(again.status).toBe(409)
    expect(refusalOf((again.body as Json).error)).toBe('refusal/DECIDED_ALREADY')
  })

  it('refuses with a reason tile; Other asks for the lead’s words; no scan is written', async () => {
    const { requestId } = await asked()
    const none = await decide(requestId, 'refuse', { version: 1, reason: 'OTHER' })
    expect(none.status).toBe(400)
    expect((none.body as Json).error.issues[0].path).toBe('body/note')
    const unknown = await decide(requestId, 'refuse', { version: 1, reason: 'BECAUSE' })
    expect(unknown.status).toBe(400)
    const refused = await decide(requestId, 'refuse', { version: 1, reason: 'OTHER', note: 'The stain cleans off with the right product.' })
    expect(refused.status, JSON.stringify(refused.body)).toBe(201)
    expect(refused.body).toEqual({ id: requestId, status: 'REFUSED', correctionScanId: null })
    expect(await requestOf(requestId)).toMatchObject({ status: 'REFUSED', decidedById: lead, decisionNote: 'Other: The stain cleans off with the right product.', correctionScanId: null })
    const second = await asked()
    expect((await decide(second.requestId, 'refuse', { version: 1, reason: 'COUNTS_WRONG' })).status).toBe(201)
    expect(await requestOf(second.requestId)).toMatchObject({ status: 'REFUSED', decisionNote: 'The new counts are wrong' })
    const [event] = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'production.scan_correction_decided' AND payload->>'requestId' = $1`, [requestId])
    expect(event!.payload).toMatchObject({ decision: 'REFUSED', correctionScanId: null })
  })

  it('refuses in words what cannot stand any more: the report was undone since; a stale version', async () => {
    const { requestId } = await asked()
    const stale = await decide(requestId, 'approve', { version: 9 })
    expect(stale.status).toBe(409)
    expect(await requestOf(requestId)).toMatchObject({ status: 'PENDING' })
    await reported()
    const voided = await decide(requestId, 'approve', { version: 1 })
    expect(voided.status, JSON.stringify(voided.body)).toBe(409)
    expect(refusalOf((voided.body as Json).error)).toBe('refusal/TARGET_VOIDED')
    expect((voided.body as Json).error.issues[1]).toMatchObject({ path: 'fix' })
    expect((await decide(requestId, 'refuse', { version: 1, reason: 'WRONG_REPORT' })).status).toBe(201)
  })
})

describe('the office keeps deciding', () => {
  it('approves one on its own route; the tablet’s list loses it, and the lead’s tap says it was decided', async () => {
    const { requestId } = await asked()
    const row = (await ok('lead', 'GET', LIST)).rows.find((entry: Json) => entry.id === requestId)
    expect(row).toBeTruthy()
    const approved = await ok('supervisor', 'POST', `/production/scans/corrections/${requestId}/approve`, { note: 'Seen the jacket' }, 201)
    expect(approved.request).toMatchObject({ status: 'APPROVED', decisionNote: 'Seen the jacket' })
    expect((await ok('lead', 'GET', LIST)).rows.map((entry: Json) => entry.id)).not.toContain(requestId)
    const late = await decide(requestId, 'approve', { version: row.version })
    expect(late.status).toBe(409)
    expect(refusalOf((late.body as Json).error)).toBe('refusal/DECIDED_ALREADY')
    expect((await ok('supervisor', 'GET', `/production/scans/corrections/${requestId}`)).request).toMatchObject({ decidedById: supervisorUser, decidedByHidden: false })
  })

  it('reads a floor decision behind the gate: the team leader’s id is kept back while PERFORMANCE is off, its one record shows it on', async () => {
    const { requestId } = await asked()
    expect((await decide(requestId, 'approve', { version: 1 })).status).toBe(201)
    const closed = (await ok('supervisor', 'GET', `/production/scans/corrections/${requestId}`)).request
    expect(closed).toMatchObject({ status: 'APPROVED', decidedById: null, decidedByHidden: true, askedBy: null, askedByHidden: true })
    const off = await switchOnPerformance(admin, { tenantId: T, companyId: companyA, siteId: siteA1, byId: supervisorUser })
    expect((await ok('supervisor', 'GET', `/production/scans/corrections/${requestId}`)).request).toMatchObject({ decidedById: lead, decidedByHidden: false })
    await off()
  })
})
