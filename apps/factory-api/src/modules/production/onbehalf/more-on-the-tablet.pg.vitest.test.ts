import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPin, pinKeyring } from '@nexus/factory-domain/auth/floor/pin'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedLabour } from '../../../../../../packages/factory-db/seed/labour'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seed as seedSkills } from '../../../../../../packages/factory-db/seed/skills'
import { seed as seedTime } from '../../../../../../packages/factory-db/seed/time'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../../adapters/local-files/local'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET, LOCAL_PIN_PEPPER } from '../../../env'
import { createOfficeAuth } from '../../../platform/auth/sessions/office-auth'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { createFilesRuntime, useFiles } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'
import { switchOnPerformance } from '../../people/privacy/testing/performance-gate'

/**
 * More on the tablet (B-W2b-47; MES-099 scan on behalf, MES-100 several bundles, MES-101 + COL-017 comment, photo and short
 * clip, MES-102 steps in an operation, MES-086 an unplanned operation) through the app's real routes on a throwaway PostgreSQL
 * 17 database from the migrations (runtime and floor logins: row-level security, the grants and the triggers are real), on
 * the factory-db seeds: plant A1 names workers (its operator acknowledged the worker notice; its team leader acknowledges it
 * here), SEED-WO-0001 IN_PROGRESS with its routing 10 cut, 20 sew, 30 final inspection, 40 pack; made-up bundles of 20 garments
 * of its BLK 52 cell, made-up tablets at SEW-01 and SEW-02. Every name and value is made up.
 *
 * The law the tests name: Statuto dei Lavoratori (L. 300/1970) art. 4 — no worker in an event; a person is named only after
 * the notice; a site that records stations names nobody. GDPR art. 5(1)(c) — the reminder at the photo step. c.c. art. 2101 —
 * a report entered on behalf pays the person it names, and says who entered it. Owner answer F3 — finishing stays one tap.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/production/onbehalf`.
 */

let h: Harness
let app: FastifyInstance
let redis: TestRedis
let localRoot: string

const NS = 'w2b47-tablet'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const siteA1 = idOf('site:A1')
const sew1 = idOf('site:A1:station:SEW-01')
const sew2 = idOf('site:A1:station:SEW-02')
const operator = idOf('worker:A1:operator')
const lead = idOf('worker:A1:lead')
const secondLead = newId()
const notAcknowledged = newId()
const tablets = { sew: newId(), sew2: newId() }
const LEAD_PIN = '246810'

const OPERATOR: Permission[] = ['production.scan', 'floor.work']
const LEAD: Permission[] = ['production.scan', 'floor.work', 'floor.lead', 'production.scan.behalf', 'production.extraops.add']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const floor = (deviceId: string, actorId: string, permissions: Permission[]): SessionContext => ({ audience: 'floor', tenantId: T, actorId, siteId: siteA1, deviceId, grants: [{ permissions, companies: [companyA], sites: [siteA1], parties: 'all' }] })
const SESSIONS: Record<string, SessionContext> = {
  op: floor(tablets.sew, operator, OPERATOR),
  lead: floor(tablets.sew2, lead, LEAD),
  otherOnLeadTablet: floor(tablets.sew2, secondLead, OPERATOR),
  office: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['workorders.view', 'threads.read', 'files.read', 'production.labour.view'])] },
  manager: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['workorders.view', 'production.extraops.add'])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT'
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const run = randomBytes(4).toString('hex')
let serial = 0
const cid = (name: string) => `t-${run}-${name}-${++serial}`
const call = (session: string, method: Method, url: string, payload?: unknown, key: string | null = cid('key')) => app.inject({ method, url, headers: { 'x-test-session': session, ...(key && method === 'POST' && !(payload && typeof payload === 'object' && ('clientScanId' in payload || 'clientEventId' in payload || 'report' in payload)) ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const scanRow = async (id: string) => (await admin('SELECT kind::text AS kind, "workerId", "stationId", "deviceId", "createdById", reason, "goodQuantity" FROM "OperationScan" WHERE id = $1', [id]))[0]!

let wo: string
const ops: Record<'cut' | 'sew' | 'qc' | 'pack', string> = { cut: '', sew: '', qc: '', pack: '' }

async function bundle(quantity = 20): Promise<string> {
  const cell = (await admin<{ id: string }>(`SELECT s.id FROM "WorkOrderSize" s JOIN "Colourway" c ON c.id = s."colourwayId" WHERE s."workOrderId" = $1 AND c.code = 'BLK' AND s.size = '52'`, [wo]))[0]!.id
  const id = newId()
  await admin(`INSERT INTO "Bundle" (id, "tenantId", "siteId", "workOrderId", "workOrderSizeId", code, quantity, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())`, [id, T, siteA1, wo, cell, `W2B47-BN-${++serial}-${run}`, quantity])
  return id
}

/** Writes the sewing step's instructions on the seed's released routing (the revision's guard is off for this set-up only). */
async function stepsAtSewing(instructions: string | null): Promise<void> {
  await admin(`ALTER TABLE "RoutingOperation" DISABLE TRIGGER "RoutingOperation_revision_guard"`)
  await admin(`UPDATE "RoutingOperation" r SET instructions = $2 FROM "WorkOrderOperation" o WHERE o.id = $1 AND r."revisionId" = o."styleRevisionId" AND r.seq = o."routingSeq"`, [ops.sew, instructions])
  await admin(`ALTER TABLE "RoutingOperation" ENABLE TRIGGER "RoutingOperation_revision_guard"`)
}

/** Lets a site record the station only, around one test. */
async function atStationSite(work: () => Promise<void>): Promise<void> {
  await admin(`UPDATE "ProductionSettings" SET "scanSubject" = 'STATION' WHERE id = $1`, [siteA1])
  try {
    await work()
  } finally {
    await admin(`UPDATE "ProductionSettings" SET "scanSubject" = 'WORKER' WHERE id = $1`, [siteA1])
  }
}

beforeAll(async () => {
  h = await startHarness('tablet')
  h.clock.set(new Date())
  for (const seed of [seedCore, seedPrivacy, seedTime, seedLabour, seedReasons, seedSkills]) await seed({ db: h.database, namespace: NS })
  const device = (id: string, station: string, name: string) => admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, $6, 'TABLET', 'ACTIVE', now())`, [id, T, companyA, siteA1, station, name])
  await device(tablets.sew, sew1, 'Sewing tablet W2B47-1')
  await device(tablets.sew2, sew2, 'Sewing tablet W2B47-2')
  const worker = (id: string, name: string) => admin(`INSERT INTO "Worker" (id, "tenantId", "companyId", "siteId", "displayName", locale, "employeeCode", status) VALUES ($1, $2, $3, $4, $5, 'it', $6, 'ACTIVE')`, [id, T, companyA, siteA1, name, `W2B47-${name}`])
  await worker(secondLead, 'Second Lead')
  await worker(notAcknowledged, 'No Notice')
  // The team leaders acknowledge the worker notice in force, as on a tablet (a copy of the operator's acknowledgement).
  for (const person of [lead, secondLead]) {
    await admin(
      `INSERT INTO "WorkerNoticeAck" (id, "tenantId", "siteId", "workerId", "noticeId", "noticeVersion", locale, "noticeSha256", channel, "deviceId", "deviceTime", "serverTime", "createdById")
       SELECT $1, "tenantId", "siteId", $2, "noticeId", "noticeVersion", locale, "noticeSha256", channel, "deviceId", now(), now(), $2 FROM "WorkerNoticeAck" WHERE "workerId" = $3 LIMIT 1`,
      [newId(), person, operator],
    )
  }
  const keyring = pinKeyring(LOCAL_PIN_PEPPER)
  for (const person of [lead, secondLead]) await admin(`UPDATE "Worker" SET "pinHash" = $2, "pinChangedAt" = now() WHERE id = $1`, [person, await hashPin(LEAD_PIN, keyring)])
  // The second team leader's floor role holds the override (their own right, read by verifyOverride).
  await admin(`INSERT INTO "WorkerRole" (id, "tenantId", "siteId", "workerId", "roleId", "grantedById") SELECT $1, "tenantId", "siteId", $2, "roleId", "grantedById" FROM "WorkerRole" WHERE "workerId" = $3`, [newId(), secondLead, lead])
  wo = (await admin<{ id: string }>('SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND number = $2', [T, 'SEED-WO-0001']))[0]!.id
  for (const row of await admin<{ id: string; seq: number }>('SELECT id, seq FROM "WorkOrderOperation" WHERE "workOrderId" = $1', [wo])) ops[({ 10: 'cut', 20: 'sew', 30: 'qc', 40: 'pack' } as const)[row.seq as 10]] = row.id
  await admin(`UPDATE "ProductionSettings" SET "skippedOperationRule" = 'FREE', "quantityGuard" = 'FREE' WHERE id = $1`, [siteA1])
  if ((await admin(`SELECT 1 FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2'`, [T])).length === 0) {
    await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), T])
  }
  redis = testRedis()
  const connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-tablet-test-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  const limits = { max: 10_000, timeWindowMs: 60_000 }
  const officeAuth = createOfficeAuth({
    database: h.database,
    environment: 'test',
    cookieSecret: LOCAL_COOKIE_SECRET,
    pinPepper: LOCAL_PIN_PEPPER,
    webOrigin: 'http://127.0.0.1:3547',
    mailer: { deliver: async () => {} },
    rateLimits: { signIn: limits, resetRequest: limits, tokenUse: limits, codes: limits, linkUse: limits, floorSignIn: limits },
  })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET, rateLimit: limits },
    { database: h.database, officeAuth, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await h?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

const entry = (bundleId: string, extra: Json = {}) => ({ clientScanId: cid('behalf'), bundleId, good: 20, stationId: sew1, workerId: operator, reasonCode: 'BADGE_MISSING', workOrderOperationId: ops.sew, ...extra })

describe('scan on behalf (MES-099)', () => {
  it('offers the stations, the people who may be named and the reasons, to a team leader only', async () => {
    const options = await ok('lead', 'GET', '/production/on-behalf/options')
    expect(options.subject).toBe('WORKER')
    expect(options.stations.map((row: Json) => row.id)).toEqual(expect.arrayContaining([sew1, sew2]))
    expect(options.people.map((row: Json) => row.id)).toContain(operator)
    expect(options.people.map((row: Json) => row.id)).not.toContain(lead)
    expect(options.people.map((row: Json) => row.id)).not.toContain(notAcknowledged)
    expect(options.reasons.find((row: Json) => row.code === 'OTHER')).toMatchObject({ needsNote: true })
    expect((await call('op', 'GET', '/production/on-behalf/options')).statusCode).toBe(403)
    expect((await call('op', 'POST', '/production/on-behalf/report', entry(await bundle()))).statusCode).toBe(403)
  })

  it('names the person and the station picked; the team leader stays who entered it, on the record and its mark', async () => {
    const bundleId = await bundle()
    const body = entry(bundleId, { reasonCode: 'TABLET_DOWN' })
    const answer = await ok('lead', 'POST', '/production/on-behalf/report', body, 201)
    expect(answer.replayed).toBe(false)
    expect(answer.scan).toMatchObject({ kind: 'REPORT', bundleId, stationId: sew1, deviceId: tablets.sew2, goodQuantity: 20, reason: 'Entered by the team leader: The tablet was not working' })
    expect(await scanRow(answer.scan.id)).toMatchObject({ workerId: operator, createdById: lead, stationId: sew1, deviceId: tablets.sew2 })
    // A resend answers the first; the same id for another person is another entry.
    expect((await ok('lead', 'POST', '/production/on-behalf/report', body, 200)).scan.id).toBe(answer.scan.id)
    expect(refusalOf(await no('lead', 'POST', '/production/on-behalf/report', { ...body, workerId: secondLead }, 409))).toBe('refusal/CLIENT_ID_REUSED')
    // The event names the work, never the person (Statuto art. 4); who entered it stays in the audit log.
    // The labour record says who entered it (c.c. art. 2101); a report the worker took themself does not.
    expect((await ok('office', 'GET', `/production/labour/records/${answer.scan.id}`)).record.enteredByLead).toBe(true)
    const own = await ok('op', 'POST', '/production/scans', { clientScanId: cid('own'), bundleId: await bundle(), good: 20, workOrderOperationId: ops.sew }, 201)
    expect((await ok('office', 'GET', `/production/labour/records/${own.scan.id}`)).record.enteredByLead).toBe(false)
    const events = await outbox('production.scan_entered_on_behalf', wo)
    expect(events.at(-1)!.payload).toEqual({ workOrderId: wo, number: 'SEED-WO-0001', siteId: siteA1, bundleId, scanId: answer.scan.id, operationId: ops.sew, reasonCode: 'TABLET_DOWN' })
    const [audit] = await admin('SELECT "actorId", reason, after FROM "AuditLog" WHERE "recordType" = $1 AND "recordId" = $2 AND action = $3', ['OperationScan', answer.scan.id, 'production.scanEnteredOnBehalf'])
    expect(audit).toMatchObject({ actorId: lead, reason: 'Entered by the team leader: The tablet was not working' })
    expect(audit!.after).toMatchObject({ workerId: operator, stationId: sew1, reasonCode: 'TABLET_DOWN' })
  })

  it('refuses in words: no person, oneself, someone not here, someone before the notice, "Other" without words, another site’s station', async () => {
    const bundleId = await bundle()
    expect(refusalOf(await no('lead', 'POST', '/production/on-behalf/report', entry(bundleId, { workerId: undefined }), 409))).toBe('refusal/BEHALF_PERSON_NEEDED')
    expect(refusalOf(await no('lead', 'POST', '/production/on-behalf/report', entry(bundleId, { workerId: lead }), 409))).toBe('refusal/BEHALF_SELF')
    expect(refusalOf(await no('lead', 'POST', '/production/on-behalf/report', entry(bundleId, { workerId: newId() }), 409))).toBe('refusal/BEHALF_PERSON_UNKNOWN')
    const notice = await no('lead', 'POST', '/production/on-behalf/report', entry(bundleId, { workerId: notAcknowledged }), 409)
    expect(refusalOf(notice)).toBe('refusal/BEHALF_NO_NOTICE')
    expect(notice.message).not.toContain('No Notice')
    expect(refusalOf(await no('lead', 'POST', '/production/on-behalf/report', entry(bundleId, { reasonCode: 'OTHER' }), 409))).toBe('refusal/BEHALF_NOTE_MISSING')
    expect(refusalOf(await no('lead', 'POST', '/production/on-behalf/report', entry(bundleId, { stationId: newId() }), 409))).toBe('refusal/BEHALF_STATION_UNKNOWN')
    expect((await admin('SELECT count(*)::int AS n FROM "OperationScan" WHERE "bundleId" = $1', [bundleId]))[0]!.n).toBe(0)
  })

  it('a site that records the station names the station picked and nobody, the person refused', async () => {
    const bundleId = await bundle()
    await atStationSite(async () => {
      expect(refusalOf(await no('lead', 'POST', '/production/on-behalf/report', entry(bundleId), 409))).toBe('refusal/BEHALF_NAMES_NOBODY')
      expect((await ok('lead', 'GET', '/production/on-behalf/options')).people).toEqual([])
      const answer = await ok('lead', 'POST', '/production/on-behalf/report', entry(bundleId, { workerId: undefined }), 201)
      expect(await scanRow(answer.scan.id)).toMatchObject({ workerId: null, createdById: null, stationId: sew1 })
    })
  })

  it('leaves the person’s running off-standard block alone: the entry says what was done, not what they do now', async () => {
    const code = (await admin<{ id: string }>(`SELECT id FROM "OffStandardCode" WHERE "tenantId" = $1 AND code = 'CLEANING'`, [T]))[0]!.id
    const started = await ok('op', 'POST', '/production/offstandard/floor/start', { clientEventId: cid('block'), codeId: code }, 201)
    await ok('lead', 'POST', '/production/on-behalf/report', entry(await bundle()), 201)
    expect((await admin('SELECT "endedAt" FROM "OffStandardEntry" WHERE id = $1', [started.block.id]))[0]!.endedAt).toBeNull()
    await ok('op', 'POST', '/production/offstandard/floor/end', { clientEventId: cid('block-end') })
  })

  it('every check still holds it; another team leader overrides with their PIN, never the one who entered it (four eyes)', async () => {
    const bundleId = await bundle()
    await admin(`UPDATE "ProductionSettings" SET "skippedOperationRule" = 'STRICT' WHERE id = $1`, [siteA1])
    try {
      const body = entry(bundleId)
      expect(refusalOf(await no('lead', 'POST', '/production/on-behalf/report', body, 409))).toBe('refusal/PREVIOUS_NOT_REPORTED')
      const sign = { report: body, overrideReasonCode: 'EARLIER_LATE' }
      expect(refusalOf(await no('lead', 'POST', '/production/on-behalf/override', { ...sign, lead: { workerId: lead, pin: LEAD_PIN } }, 409))).toBe('refusal/OVERRIDE_SELF')
      const answer = await ok('lead', 'POST', '/production/on-behalf/override', { ...sign, lead: { workerId: secondLead, pin: LEAD_PIN } }, 201)
      expect(await scanRow(answer.scan.id)).toMatchObject({ workerId: operator, createdById: lead })
      expect((await admin('SELECT after FROM "AuditLog" WHERE "recordId" = $1 AND action = $2', [answer.scan.id, 'production.scanGuardOverridden']))[0]!.after).toMatchObject({ leadWorkerId: secondLead, reasonCode: 'EARLIER_LATE' })
    } finally {
      await admin(`UPDATE "ProductionSettings" SET "skippedOperationRule" = 'FREE' WHERE id = $1`, [siteA1])
    }
  })

  it('the team leader takes back their entry right after it; someone without the right on that tablet may not', async () => {
    const answer = await ok('lead', 'POST', '/production/on-behalf/report', entry(await bundle()), 201)
    expect(refusalOf(await no('otherOnLeadTablet', 'POST', `/production/scans/${answer.scan.id}/undo`, { clientScanId: cid('undo-other') }, 409))).toBe('refusal/NOT_YOURS')
    const undone = await ok('lead', 'POST', `/production/scans/${answer.scan.id}/undo`, { clientScanId: cid('undo') }, 201)
    expect(await scanRow(undone.scan.id)).toMatchObject({ kind: 'UNDO', workerId: operator, createdById: lead })
  })
})

describe('several bundles at once (MES-100)', () => {
  it('finishes the stack with one tap: each bundle its own report; a refused one stays out and stops nothing; a resend is answered', async () => {
    const [first, second] = [await bundle(), await bundle()]
    const reported = await bundle()
    await ok('op', 'POST', '/production/scans', { clientScanId: cid('before'), bundleId: reported, good: 20, workOrderOperationId: ops.sew }, 201)
    const items = [
      { clientScanId: cid('stack-1'), bundleId: first, good: 19, scrap: [{ reason: 'STAIN', quantity: 1 }], workOrderOperationId: ops.sew },
      { clientScanId: cid('stack-2'), bundleId: reported, good: 20, workOrderOperationId: ops.sew },
      { clientScanId: cid('stack-3'), code: 'NOT-A-BUNDLE', good: 20 },
      { clientScanId: cid('stack-4'), bundleId: second, good: 20, workOrderOperationId: ops.sew },
    ]
    const answer = await ok('op', 'POST', '/production/several-bundles/finish', { items })
    expect(answer.items.map((item: Json) => item.status)).toEqual(['accepted', 'refused', 'refused', 'accepted'])
    expect(answer.items[1].refusal.code).toBe('ALREADY_REPORTED')
    expect(answer.items[2].refusal.code).toBe('UNKNOWN_BUNDLE')
    expect(answer).toMatchObject({ finished: 2, refused: 2, good: 39, scrap: 1, rework: 0, words: '2 bundles finished · 39 good · 1 scrap · 2 refused' })
    const again = await ok('op', 'POST', '/production/several-bundles/finish', { items: [items[0], items[3]] })
    expect(again.items.map((item: Json) => item.status)).toEqual(['duplicate', 'duplicate'])
    expect(again.items[0].scan.id).toBe(answer.items[0].scan.id)
    expect((await call('op', 'POST', '/production/several-bundles/finish', { items: [items[0], items[0]] })).statusCode).toBe(400)
  })

  it('reports past a running stretch without touching it (one job at a time stands, a report needs no START)', async () => {
    const [running, other] = [await bundle(), await bundle()]
    await ok('op', 'POST', '/production/terminal/start', { clientScanId: cid('start'), bundleId: running, workOrderOperationId: ops.sew }, 201)
    const answer = await ok('op', 'POST', '/production/several-bundles/finish', { items: [{ clientScanId: cid('past'), bundleId: other, good: 20, workOrderOperationId: ops.sew }] })
    expect(answer.finished).toBe(1)
    expect((await ok('op', 'GET', `/production/terminal/state?bundleId=${running}&workOrderOperationId=${ops.sew}`)).timing.state).toBe('RUNNING')
    await ok('op', 'POST', '/production/scans', { clientScanId: cid('end'), bundleId: running, good: 20, workOrderOperationId: ops.sew }, 201)
  })
})

describe('steps in an operation (MES-102)', () => {
  const tick = (bundleId: string, stepCode: string, extra: Json = {}) => ({ clientEventId: cid('tick'), bundleId, workOrderOperationId: ops.sew, stepCode, ...extra })
  const state = (session: string, bundleId: string) => ok(session, 'GET', `/production/checklists/state?bundleId=${bundleId}&workOrderOperationId=${ops.sew}`)
  const report = (bundleId: string, extra: Json = {}) => ({ clientScanId: cid('finish'), bundleId, good: 20, workOrderOperationId: ops.sew, ...extra })

  beforeAll(() => stepsAtSewing('Sew the collar to the neck line.\n[ ] TRIM_THREADS Trim the threads\n[ ] CHECK_SEAM Check the seam\n[o] POCKET_ZIP Close the pocket zip'), 60_000)
  afterAll(() => stepsAtSewing(null), 60_000)

  it('shows the steps from the operation’s instructions; Finish waits for the required ones, in words; both outcomes count', async () => {
    const bundleId = await bundle()
    expect(await state('op', bundleId)).toMatchObject({ operation: { id: ops.sew, seq: 20 }, open: 2, steps: [{ code: 'TRIM_THREADS', required: true, tick: null }, { code: 'CHECK_SEAM', required: true, tick: null }, { code: 'POCKET_ZIP', required: false, tick: null }] })
    const held = await no('op', 'POST', '/production/scans', report(bundleId), 409)
    expect(refusalOf(held)).toBe('refusal/CHECKLIST_OPEN')
    expect(held.message).toMatch(/2 steps are not ticked yet \(Trim the threads, Check the seam\)/)
    const first = await ok('op', 'POST', '/production/checklists/tick', tick(bundleId, 'TRIM_THREADS'), 201)
    expect(first.checklist.open).toBe(1)
    expect(first.tick).toMatchObject({ stepCode: 'TRIM_THREADS', outcome: 'DONE' })
    const [row] = await admin('SELECT "workerId", "employeeId", "stationId", "deviceId" FROM "OperationChecklistResult" WHERE id = $1', [first.tick.id])
    expect(row).toMatchObject({ workerId: operator, stationId: sew1, deviceId: tablets.sew })
    await ok('op', 'POST', '/production/checklists/tick', tick(bundleId, 'CHECK_SEAM', { outcome: 'NOT_APPLICABLE' }), 201)
    expect((await ok('op', 'POST', '/production/scans', report(bundleId), 201)).scan.kind).toBe('REPORT')
    // After the report the steps are closed.
    expect(refusalOf(await no('op', 'POST', '/production/checklists/tick', tick(bundleId, 'POCKET_ZIP'), 409))).toBe('refusal/CHECKLIST_REPORTED')
  })

  it('a resend answers the first; the same outcome again writes nothing; another outcome stands from now on, the wrong tick stays on the record', async () => {
    const bundleId = await bundle()
    const body = tick(bundleId, 'TRIM_THREADS')
    const first = await ok('op', 'POST', '/production/checklists/tick', body, 201)
    expect((await ok('op', 'POST', '/production/checklists/tick', body, 200)).tick.id).toBe(first.tick.id)
    expect(refusalOf(await no('op', 'POST', '/production/checklists/tick', { ...body, stepCode: 'CHECK_SEAM' }, 409))).toBe('refusal/CLIENT_ID_REUSED')
    expect((await ok('op', 'POST', '/production/checklists/tick', tick(bundleId, 'TRIM_THREADS'), 200)).tick.id).toBe(first.tick.id)
    const changed = await ok('op', 'POST', '/production/checklists/tick', tick(bundleId, 'TRIM_THREADS', { outcome: 'NOT_APPLICABLE' }), 201)
    expect(changed.checklist.steps[0].tick).toMatchObject({ outcome: 'NOT_APPLICABLE', mine: true })
    expect((await admin('SELECT count(*)::int AS n FROM "OperationChecklistResult" WHERE "bundleId" = $1', [bundleId]))[0]!.n).toBe(2)
    const events = await outbox('production.checklist_step_ticked', wo)
    expect(events.at(-1)!.payload).toEqual({ workOrderId: wo, number: 'SEED-WO-0001', siteId: siteA1, bundleId, operationId: ops.sew, stepCode: 'TRIM_THREADS', outcome: 'NOT_APPLICABLE', open: 1 })
    expect(refusalOf(await no('op', 'POST', '/production/checklists/tick', tick(bundleId, 'NO_SUCH_STEP'), 409))).toBe('refusal/CHECKLIST_STEP_UNKNOWN')
  })

  it('who and when: "another person" on an operator’s tablet, the name on a team leader’s and inside the office’s one record', async () => {
    const bundleId = await bundle()
    await ok('lead', 'POST', '/production/checklists/tick', tick(bundleId, 'TRIM_THREADS'), 201)
    expect((await state('op', bundleId)).steps[0].tick).toMatchObject({ mine: false, by: null })
    expect((await state('lead', bundleId)).steps[0].tick).toMatchObject({ mine: true, by: 'Seed Worker A1-2' })
    await ok('op', 'POST', '/production/checklists/tick', tick(bundleId, 'CHECK_SEAM'), 201)
    expect((await state('lead', bundleId)).steps[1].tick).toMatchObject({ mine: false, by: 'Seed Worker A1-1' })
    // Gate off (the default): each tick says a person is on it, never who (art. 4 c.1). Gate on: the name.
    const closed = await ok('office', 'GET', `/production/checklists/work-orders/${wo}?bundleId=${bundleId}`)
    expect(closed.operations[0].ticks.every((row: Json) => row.by === null && row.byHidden === true)).toBe(true)
    expect(JSON.stringify(closed)).not.toContain('Seed Worker')
    const gateOff = await switchOnPerformance(admin, { tenantId: T, companyId: companyA, siteId: siteA1, byId: newId() })
    const record = await ok('office', 'GET', `/production/checklists/work-orders/${wo}?bundleId=${bundleId}`)
    await gateOff()
    expect(record.operations).toHaveLength(1)
    expect(record.operations[0]).toMatchObject({ operation: { id: ops.sew }, open: 0 })
    expect(record.operations[0].ticks.map((row: Json) => [row.stepCode, row.outcome, row.by, row.station])).toEqual([
      ['TRIM_THREADS', 'DONE', 'Seed Worker A1-2', 'SEW-02'],
      ['CHECK_SEAM', 'DONE', 'Seed Worker A1-1', 'SEW-01'],
    ])
  })

  it('an entry on behalf and a stack wait for the steps too; a site that records the station ticks by the station', async () => {
    const bundleId = await bundle()
    expect(refusalOf(await no('lead', 'POST', '/production/on-behalf/report', entry(bundleId), 409))).toBe('refusal/CHECKLIST_OPEN')
    const stack = await ok('op', 'POST', '/production/several-bundles/finish', { items: [report(bundleId)] })
    expect(stack.items[0].refusal.code).toBe('CHECKLIST_OPEN')
    await atStationSite(async () => {
      const ticked = await ok('op', 'POST', '/production/checklists/tick', tick(bundleId, 'TRIM_THREADS'), 201)
      expect((await admin('SELECT "workerId", "stationId", "createdById" FROM "OperationChecklistResult" WHERE id = $1', [ticked.tick.id]))[0]).toEqual({ workerId: null, stationId: sew1, createdById: null })
    })
  })

})

describe('a comment or a photo from the floor (MES-101, COL-017)', () => {
  const bytes = Buffer.from(`made-up picture ${run}`)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const announced = (extra: Json = {}) => ({ originalName: 'collar.jpg', contentType: 'image/jpeg', sizeBytes: bytes.length, sha256, ...extra })
  const base = () => `/production/floor-notes/work-orders/${wo}`
  async function photo(session = 'op'): Promise<string> {
    const answer = await ok(session, 'POST', `${base()}/files`, announced(), 201)
    expect(answer.reminder).toMatchObject({ code: 'NO_FACES', en: 'Keep faces out of the picture.' })
    const sent = await app.inject({ method: 'PUT', url: answer.upload.url, headers: answer.upload.headers, payload: bytes })
    expect(sent.statusCode, sent.body).toBeLessThan(300)
    return (await ok(session, 'POST', `${base()}/files/${answer.file.id}/complete`)).file.id
  }
  const note = (extra: Json = {}) => ({ clientEventId: cid('note'), tileCode: 'STITCHING_DIFFERS', ...extra })

  it('gives the tiles and the reminder the photo step shows', async () => {
    const answer = await ok('op', 'GET', '/production/floor-notes/tiles')
    expect(answer.tiles.map((tile: Json) => tile.code)).toContain('MATERIAL_DIFFERS')
    expect(answer.reminder.en).toBe('Keep faces out of the picture.')
    expect(answer.limits).toEqual({ noteMax: 500, filesPerNote: 4, clipSeconds: 15 })
  })

  it('posts the tile, the words and the photo to the work order’s thread, by the worker; the office reads it there; a resend is one note', async () => {
    const bundleId = await bundle()
    const fileId = await photo()
    const body = note({ note: 'Left sleeve', fileIds: [fileId], bundleId, workOrderOperationId: ops.sew })
    const posted = await ok('op', 'POST', base(), body, 201)
    expect(posted.files).toBe(1)
    const [message] = await admin('SELECT "authorKind"::text AS kind, "authorId", "authorName", "bodyText", "attachmentFileIds", audience::text AS audience, "forFloor" FROM "Message" WHERE id = $1', [posted.messageId])
    expect(message).toMatchObject({ kind: 'WORKER', authorId: operator, authorName: 'Seed Worker A1-1', audience: 'OFFICE', attachmentFileIds: [fileId], forFloor: true })
    expect(message!.bodyText).toMatch(/^Stitching differs \(W2B47-BN-.* at Op 20 .*\): Left sleeve$/)
    expect((await ok('op', 'POST', base(), body, 200)).messageId).toBe(posted.messageId)
    const thread = await ok('office', 'GET', `/threads/WorkOrder/${wo}`)
    expect(thread.messages.some((row: Json) => row.id === posted.messageId)).toBe(true)
    const [file] = await admin('SELECT kind::text AS kind, "recordType", "floorSiteId", visibility::text[] AS visibility FROM "StoredFile" WHERE id = $1', [fileId])
    expect(file).toMatchObject({ kind: 'PHOTO', recordType: 'WorkOrder', floorSiteId: siteA1, visibility: ['OFFICE', 'FLOOR'] })
  })

  it('takes a clip of up to 15 seconds and nothing longer, nothing that is not a picture or a clip', async () => {
    const clip = announced({ originalName: 'seam.mp4', contentType: 'video/mp4', durationSeconds: 15 })
    expect((await ok('op', 'POST', `${base()}/files`, clip, 201)).file.contentType).toBe('video/mp4')
    expect((await no('op', 'POST', `${base()}/files`, { ...clip, durationSeconds: 16 }, 400)).issues[0].path).toBe('body/durationSeconds')
    expect((await no('op', 'POST', `${base()}/files`, { ...clip, durationSeconds: undefined }, 400)).issues[0].path).toBe('body/durationSeconds')
    expect((await no('op', 'POST', `${base()}/files`, announced({ originalName: 'page.html', contentType: 'text/html' }), 400)).issues[0].path).toBe('body/contentType')
  })

  it('refuses "Other" with nothing to show and a file of another record; names the station where the site records it', async () => {
    expect((await no('op', 'POST', base(), note({ tileCode: 'OTHER' }), 400)).message).toMatch(/few words/)
    expect((await no('op', 'POST', base(), note({ fileIds: [newId()] }), 400)).issues[0].path).toBe('body/attachments/0')
    const posted = await atStation()
    expect((await admin('SELECT "authorKind"::text AS kind, "authorId", "authorName" FROM "Message" WHERE id = $1', [posted.messageId]))[0]).toEqual({ kind: 'SYSTEM', authorId: null, authorName: 'SEW-01' })
  })
  async function atStation(): Promise<Json> {
    let answer: Json = {}
    await atStationSite(async () => {
      answer = await ok('op', 'POST', base(), note(), 201)
    })
    return answer
  }
})

describe('an unplanned operation (MES-086)', () => {
  const base = () => `/production/extra-operations/work-orders/${wo}`
  let extra: { id: string; code: string }
  let planned: { id: string }

  beforeAll(async () => {
    extra = { id: newId(), code: `W2B47-EXTRA-${run}` }
    await admin(`INSERT INTO "Operation" (id, "tenantId", "companyId", code, name, "workCentreKind", "standardMinutes", status, "updatedAt") VALUES ($1, $2, $3, $4, 'Extra bar tack', 'SEWING', 1.5, 'ACTIVE', now())`, [extra.id, T, companyA, extra.code])
    planned = (await admin<{ id: string }>(`SELECT r."operationId" AS id FROM "RoutingOperation" r JOIN "WorkOrderOperation" o ON r."revisionId" = o."styleRevisionId" AND r.seq = o."routingSeq" WHERE o.id = $1`, [ops.sew]))[0]!
  }, 60_000)

  it('offers the library’s operations the routing does not have, and the reasons, to the team leader', async () => {
    const choices = await ok('lead', 'GET', `${base()}/choices`)
    expect(choices.workOrder.number).toBe('SEED-WO-0001')
    expect(choices.operations.map((row: Json) => row.id)).toContain(extra.id)
    expect(choices.operations.map((row: Json) => row.id)).not.toContain(planned.id)
    expect(choices.reasons.map((row: Json) => row.code)).toContain('QUALITY_FIX')
    expect((await call('op', 'GET', `${base()}/choices`)).statusCode).toBe(403)
  })

  it('adds it with a reason, on the tablet or in the office; the record says where, the event names nobody; a resend is one', async () => {
    const key = cid('extra-key')
    const body = { operationId: extra.id, reasonCode: 'QUALITY_FIX' }
    const send = () => app.inject({ method: 'POST', url: base(), headers: { 'x-test-session': 'lead', 'idempotency-key': key }, payload: body })
    const first = await send()
    expect(first.statusCode, first.body).toBe(201)
    expect(first.json()).toMatchObject({ operation: { id: extra.id, code: extra.code, name: 'Extra bar tack', workCentreKind: 'SEWING' }, reasonCode: 'QUALITY_FIX', reason: 'To fix a defect', addedOn: 'FLOOR' })
    expect((await send()).statusCode).toBe(200)
    await ok('manager', 'POST', base(), { operationId: extra.id, reasonCode: 'OTHER', note: 'A second pass' }, 201)
    const list = await ok('office', 'GET', base())
    expect(list.added.map((row: Json) => [row.operation.code, row.reason, row.addedOn])).toEqual([
      [extra.code, 'To fix a defect', 'FLOOR'],
      [extra.code, 'Other (say why): A second pass', 'OFFICE'],
    ])
    expect((await ok('lead', 'GET', `${base()}/choices`)).added).toHaveLength(2)
    const events = await outbox('production.extra_operation_added', wo)
    expect(events[0]!.payload).toEqual({ workOrderId: wo, number: 'SEED-WO-0001', siteId: siteA1, recordId: first.json().id, operationId: extra.id, code: extra.code, reasonCode: 'QUALITY_FIX' })
  })

  it('refuses in words: an operation of the routing, "Other" without words, not of the library; never touches the frozen routing', async () => {
    const before = (await admin('SELECT count(*)::int AS n FROM "WorkOrderOperation" WHERE "workOrderId" = $1', [wo]))[0]!.n
    expect((await no('lead', 'POST', base(), { operationId: planned.id, reasonCode: 'QUALITY_FIX' }, 409)).message).toMatch(/routing already/)
    expect((await no('lead', 'POST', base(), { operationId: extra.id, reasonCode: 'OTHER' }, 409)).message).toMatch(/few words/)
    expect((await no('lead', 'POST', base(), { operationId: newId(), reasonCode: 'QUALITY_FIX' }, 409)).message).toMatch(/not an active operation/)
    expect((await admin('SELECT count(*)::int AS n FROM "WorkOrderOperation" WHERE "workOrderId" = $1', [wo]))[0]!.n).toBe(before)
  })
})

describe('from the floor’s queue (B-W2b-47 kinds)', () => {
  it('applies an entry on behalf, a tick and a comment, each once; the entry needs the team leader’s right', async () => {
    await stepsAtSewing('[ ] TRIM_THREADS Trim the threads')
    try {
      const bundleId = await bundle()
      const event = (kind: string, seq: number, payload: Json) => ({ clientEventId: cid('event'), seq, kind, occurredAt: new Date().toISOString(), workerId: lead, payload })
      const events = [
        event('production.checklist.tick', 1, { bundleId, workOrderOperationId: ops.sew, stepCode: 'TRIM_THREADS' }),
        event('production.scan.onBehalf', 2, { bundleId, workOrderOperationId: ops.sew, good: 20, stationId: sew1, workerId: operator, reasonCode: 'CALLED_AWAY' }),
        event('production.floorNote.post', 3, { workOrderId: wo, tileCode: 'DAMAGED', bundleId, note: 'From the queue' }),
      ]
      const send = () => ok('lead', 'POST', '/floor/sync', { events })
      const first = await send()
      expect(first.events.map((row: Json) => row.status), JSON.stringify(first.events)).toEqual(['accepted', 'accepted', 'accepted'])
      expect((await send()).events.map((row: Json) => row.status)).toEqual(['duplicate', 'duplicate', 'duplicate'])
      expect((await admin(`SELECT count(*)::int AS n FROM "OperationScan" WHERE "bundleId" = $1 AND kind = 'REPORT'`, [bundleId]))[0]!.n).toBe(1)
      const refused = await ok('op', 'POST', '/floor/sync', { events: [{ ...event('production.scan.onBehalf', 1, { bundleId, good: 20, stationId: sew1, workerId: lead, reasonCode: 'CALLED_AWAY' }), workerId: operator }] })
      expect(refused.events[0].status).toBe('refused')
    } finally {
      await stepsAtSewing(null)
    }
  })
})
