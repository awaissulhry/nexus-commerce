import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission, ScopeSet } from '@nexus/factory-domain/core/permissions'
import type { Clock } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedComplianceRules } from '../../../../../../packages/factory-db/seed/compliance-rules'
import { seed as seedQualityLab } from '../../../../../../packages/factory-db/seed/quality-lab'
import { seed as seedSubstances, type SubstancesSeed } from '../../../../../../packages/factory-db/seed/substances'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../../adapters/local-files/local'
import { buildApp } from '../../../core/app'
import { callerFor, type CommandCaller } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET, LOCAL_PIN_PEPPER } from '../../../env'
import { createOfficeAuth } from '../../../platform/auth/sessions/office-auth'
import { createFilesRuntime, useFiles } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { systemContext } from '../../../platform/outbox/system'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'
import { reevaluateHandlers } from '../material-profiles/reevaluate'
import { useSubstancesClock } from '../substances/common'
import { declarationsTick, takePortalUpload } from './jobs'

/**
 * Material profiles, supplier declarations and test plans (B-W2b-256) on the local stack, through the app's real routes: a
 * throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and B-W2b-217's guards are
 * real), the core, compliance rules (markets IT, DE, FR, ES on), substances (ten substances, nine rules, two Candidate List
 * versions, four profiles, five declaration requests of P2 and P1, five test plans) and W1's lab seeds (the leather's lot
 * with its chromium VI result), sessions from the test authenticator, files on the local store behind the FAKE R2 account.
 * Every name, code, answer and person is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/compliance/declarations-asked`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'

const NS = 'w2b256-material-tests'
const idOf = (key: string): string => seedUuid(NS, key)
const tenant = idOf('tenant')
const companyA = idOf('company:A')
const partyP2 = idOf('party:P2')
const lotLeather = idOf('inventory:lot:LEA-01')

const VIEW = 'compliance.certificates.view'
const QUALITY: Permission[] = [VIEW, 'compliance.substances.manage', 'compliance.supplierDeclarations.manage', 'purchasing.supplierDocuments.review', 'quality.lots.view', 'quality.lots.test', 'files.upload', 'files.read', 'product.styles.view', 'product.materials.view']
const clock: Clock = { now: () => new Date('2026-11-10T09:00:00.000Z') }

interface Person {
  readonly permissions: readonly Permission[]
  readonly companies: ScopeSet
}
const PEOPLE: Record<string, Person> = {
  quality: { permissions: QUALITY, companies: 'all' },
  viewer: { permissions: [VIEW, 'quality.lots.view'], companies: 'all' },
}
const IDS: Record<string, string> = Object.fromEntries(Object.keys(PEOPLE).map((key) => [key, newId()]))
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, person]) => {
    const grant: Grant = { permissions: [...person.permissions], companies: person.companies, sites: 'all', parties: 'all' }
    return [key, { audience: 'office', tenantId: tenant, actorId: IDS[key]!, grants: [grant] }]
  }),
)

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string
let seed: SubstancesSeed

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': newId() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const paths = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const system = (): CommandCaller => callerFor(database, systemContext(tenant, newId()))
const eventsOf = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [tenant, type])).map((row) => row.payload)
const request = async (id: string) => (await ok('quality', 'GET', `/compliance/declarations-asked/${id}`)).request

/** A copy of a row with some columns changed (the owner login: the guards still speak). */
async function copyRow(table: string, id: string, changes: Json): Promise<void> {
  const [row] = await admin<{ row: Json }>(`SELECT to_jsonb(t) AS row FROM "${table}" t WHERE id = $1`, [id])
  await admin(`INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, [JSON.stringify({ ...row!.row, ...changes })])
}

beforeAll(async () => {
  db = await migratedDatabase('w2b256_mattests')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-material-tests-'))
  await seedCore({ db: database, namespace: NS })
  await seedComplianceRules({ db: database, namespace: NS })
  seed = await seedSubstances({ db: database, namespace: NS })
  await seedQualityLab({ db: database, namespace: NS })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE provider = 'R2'`)
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  useSubstancesClock(clock)
  // The office sign-in object: B-W2b-189's document acceptance runs on its clock; sessions stay the test authenticator's.
  const limits = { max: 10_000, timeWindowMs: 60_000 }
  const officeAuth = createOfficeAuth({
    database,
    environment: 'test',
    cookieSecret: LOCAL_COOKIE_SECRET,
    pinPepper: LOCAL_PIN_PEPPER,
    webOrigin: 'http://localhost:3200',
    clock,
    mailer: { deliver: async () => {} },
    rateLimits: { signIn: limits, resetRequest: limits, tokenUse: limits, codes: limits, linkUse: limits, floorSignIn: limits },
  })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, officeAuth, clock, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((req) => SESSIONS[String(req.headers['x-test-session'])] ?? null) },
  )
  // A fresh test database migrates under one server-wide lock: other worktrees' runs may hold it for minutes.
}, 600_000)

afterAll(async () => {
  useSubstancesClock(undefined)
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

describe('material profiles (PRD-303, PRD-314)', () => {
  it('lists every material with its profile, and confirms the protector (the evaluator writes the state in the same command)', async () => {
    const list = await ok('viewer', 'GET', '/compliance/material-profiles')
    expect(list.mayEdit).toBe(false)
    const row = (id: string) => list.profiles.find((entry: Json) => entry.material.id === id)
    expect(row(seed.itemIds.leather)).toMatchObject({ compositionConfirmed: true, tannageConfirmed: true, originCountry: 'IT' })
    expect(row(seed.itemIds.protector)).toMatchObject({ state: 'COMPLETE', compositionConfirmed: false, tannageConfirmed: null, originCountry: 'DE' })
    await refused('viewer', 'PATCH', `/compliance/material-profiles/${seed.itemIds.protector}`, { version: 1, compositionConfirmed: true }, 403)
    expect(paths(await refused('quality', 'PATCH', `/compliance/material-profiles/${seed.itemIds.lining}`, { version: 1, tannageConfirmed: true, originCountry: 'Italy' }, 400))).toEqual(['body/tannageConfirmed', 'body/originCountry'])
    const before = await ok('quality', 'GET', `/compliance/material-profiles/${seed.itemIds.protector}`)
    expect(before.profile.gaps).toContain('Composition: not confirmed against the evidence yet.')
    const edited = await ok('quality', 'PATCH', `/compliance/material-profiles/${seed.itemIds.protector}`, { version: before.profile.version, compositionConfirmed: true, originCountry: 'IT' })
    expect(edited.changed).toEqual(['COMPOSITION', 'ORIGIN'])
    expect(edited.profile).toMatchObject({ compositionConfirmed: true, originCountry: 'IT', compositionConfirmedBy: { id: IDS.quality } })
    expect(edited.profile.gaps).not.toContain('Composition: not confirmed against the evidence yet.')
    // The evaluator ran in the same command and owns the state: COMPLETE (seeded by hand) → INCOMPLETE (PAH has no evidence).
    expect(edited.profile).toMatchObject({ state: 'INCOMPLETE', evaluatedAt: '2026-11-10T09:00:00.000Z' })
    expect((await eventsOf('compliance_material_tests.profile_changed')).at(-1)).toMatchObject({ itemId: seed.itemIds.protector, changed: ['COMPOSITION', 'ORIGIN'], state: 'INCOMPLETE' })
    expect((await eventsOf('compliance_substances.profile_evaluated')).at(-1)).toMatchObject({ itemId: seed.itemIds.protector, previousState: 'COMPLETE', state: 'INCOMPLETE' })
    // A stale version: 409.
    await refused('quality', 'PATCH', `/compliance/material-profiles/${seed.itemIds.protector}`, { version: before.profile.version, note: 'Again.' }, 409)
  })
})

describe('supplier declarations (PRD-304)', () => {
  it('reviews per supplier and kind, then sends: a new request, one added to an open request, one already asked', async () => {
    const body = { materials: [{ itemId: seed.itemIds.leather, partyId: partyP2 }, { itemId: seed.itemIds.lining, partyId: partyP2 }], kinds: ['REACH_SVHC', 'RSL'], dueOn: '2026-12-01', reminderEveryDays: 7, channel: 'OFFICE' }
    const plan = await ok('quality', 'POST', '/compliance/declarations-asked', { ...body, dryRun: true })
    expect(plan.sent).toBe(false)
    const by = (kind: string) => plan.groups.find((group: Json) => group.kind === kind)
    // SEED-SD-0001 (SVHC, the July list, SENT) asks about the leather already: the lining joins it.
    expect(by('REACH_SVHC')).toMatchObject({ outcome: 'ADD', request: { number: 'SEED-SD-0001' }, materials: [{ itemId: seed.itemIds.lining }] })
    expect(by('RSL')).toMatchObject({ outcome: 'SEND', channel: 'OFFICE' })
    expect(await eventsOf('compliance_material_tests.declaration_asked')).toHaveLength(0)
    await refused('viewer', 'POST', '/compliance/declarations-asked', body, 403)
    expect(paths(await refused('quality', 'POST', '/compliance/declarations-asked', { ...body, channel: 'LINK', dueOn: '2026-11-01' }, 400))).toEqual(['body/dueOn', 'body/channel'])
    const sent = await ok('quality', 'POST', '/compliance/declarations-asked', body)
    expect(sent.counts).toEqual({ send: 1, add: 1, skip: 0 })
    const rsl = sent.groups.find((group: Json) => group.kind === 'RSL').request
    expect(rsl.number).toMatch(/^SD-2026-\d{4}$/)
    const made = await request(rsl.requestId)
    expect(made).toMatchObject({ status: 'SENT', shown: 'REQUESTED', channel: 'OFFICE', lines: 2, reminderEveryDays: 7, partnerTask: null })
    expect((await request(seed.requestIds.again)).lines).toBe(3)
    expect(await eventsOf('compliance_material_tests.declaration_extended')).toMatchObject([{ number: 'SEED-SD-0001', added: 1 }])
    // Asked again: the same supplier and kind are not asked twice.
    const again = await ok('quality', 'POST', '/compliance/declarations-asked', { ...body, kinds: ['RSL'], dryRun: true })
    expect(again.groups[0]).toMatchObject({ outcome: 'SKIP', why: `Already asked in ${rsl.number} (due, not answered yet).` })
  })

  it('asks in the portal (its upload task); the supplier\'s upload answers it; lines, then accepted with the document; the materials evaluated again', async () => {
    await admin(`UPDATE "PortalSettings" SET "portalOn" = true WHERE "partyId" = $1`, [partyP2])
    const sent = await ok('quality', 'POST', '/compliance/declarations-asked', { materials: [{ itemId: seed.itemIds.leather, partyId: partyP2 }], kinds: ['PFAS'], dueOn: '2026-11-30' })
    const group = sent.groups[0]
    expect(group).toMatchObject({ channel: 'PORTAL', outcome: 'SEND' })
    const asked = await request(group.request.requestId)
    expect(asked.partnerTask).toMatchObject({ status: 'OPEN' })
    const [task] = await admin<Json>(`SELECT kind, "recordType", "recordId", "sourceKey", "recordLabel" FROM "PartnerTask" WHERE id = $1`, [asked.partnerTask.id])
    expect(task).toMatchObject({ kind: 'UPLOAD_DOCUMENT', recordType: 'SupplierDeclarationRequest', recordId: asked.id, sourceKey: `SupplierDeclaration:${asked.id}` })
    expect(task!.recordLabel).toMatch(/PFAS-free/)
    // The supplier uploads its declaration against the task (B-W2b-189's portal: a copy of its waiting upload) and the task closes.
    const fileId = newId()
    const uploadId = newId()
    const [waiting] = await admin<Json>(`SELECT "fileId" FROM "SupplierDocumentUpload" WHERE id = $1`, [seed.uploadId])
    await copyRow('StoredFile', waiting!.fileId, { id: fileId, storageKey: `t/${tenant}/c/${companyA}/2026/${fileId}`, seriesId: null, versionNo: 1, status: 'AVAILABLE', availableAt: '2026-11-10T08:30:00.000Z' })
    await copyRow('SupplierDocumentUpload', seed.uploadId, { id: uploadId, fileId, taskId: asked.partnerTask.id, receivedAt: '2026-11-10T08:30:00.000Z', status: 'WAITING', version: 1, createdAt: '2026-11-10T08:30:00.000Z', updatedAt: '2026-11-10T08:30:00.000Z' })
    await admin(`UPDATE "PartnerTask" SET status = 'DONE', "closedAt" = '2026-11-10T09:30:00Z', version = version + 1 WHERE id = $1`, [asked.partnerTask.id])
    expect(await takePortalUpload(system(), fileId, newId())).toBe('ANSWERED')
    const answered = await request(asked.id)
    expect(answered).toMatchObject({ status: 'ANSWERED', shown: 'ANSWERED', file: { source: 'UPLOAD', uploadId, fileId }, upload: { status: 'WAITING' } })
    // Accepted only with every material answered.
    const open = await refused('quality', 'POST', `/compliance/declarations-asked/${asked.id}/accept`, { version: answered.version }, 409)
    expect(open.message).toMatch(/Record what the answer says for every material first/)
    expect(paths(await refused('quality', 'PUT', `/compliance/declarations-asked/${asked.id}/lines`, { version: answered.version, lines: [{ lineId: answered.lineRows[0].id, contains: true }] }, 400))).toEqual(['body/lines/0/substanceName', 'body/lines/0/aboveThreshold'])
    const lines = await ok('quality', 'PUT', `/compliance/declarations-asked/${asked.id}/lines`, { version: answered.version, lines: [{ lineId: answered.lineRows[0].id, contains: false }] })
    expect(lines.request).toMatchObject({ answeredLines: 1 })
    const accepted = await ok('quality', 'POST', `/compliance/declarations-asked/${asked.id}/accept`, { version: lines.request.version, validTo: '2027-11-30' })
    expect(accepted.request).toMatchObject({ status: 'ACCEPTED', shown: 'ACCEPTED', validTo: '2027-11-30', decidedBy: { name: 'Our office' } })
    // The supplier's document was accepted first (B-W2b-189: tagged a declaration, shared with the supplier).
    expect((await request(asked.id)).upload).toMatchObject({ status: 'ACCEPTED' })
    expect((await eventsOf('compliance_material_tests.declaration_decided')).at(-1)).toMatchObject({ requestId: asked.id, outcome: 'ACCEPTED', materials: 1 })
    expect((await eventsOf('compliance_substances.profile_evaluated')).at(-1)).toMatchObject({ itemId: seed.itemIds.leather })
  })

  it('refuses an answered declaration with why; reminds a waiting one in the portal; cancels and asks again; moves overdue ones', async () => {
    // SEED-SD-0004 (Cr VI, portal, ANSWERED by P2's waiting upload).
    const cr6 = await request(seed.requestIds.answered)
    expect(paths(await refused('quality', 'POST', `/compliance/declarations-asked/${cr6.id}/refuse`, { version: cr6.version, reason: 'no' }, 400))).toEqual(['body/reason'])
    const refusedOne = await ok('quality', 'POST', `/compliance/declarations-asked/${cr6.id}/refuse`, { version: cr6.version, reason: 'The statement does not name the article.' })
    expect(refusedOne.request).toMatchObject({ status: 'REFUSED', shown: 'REJECTED', refuseReason: 'The statement does not name the article.' })
    await refused('quality', 'POST', `/compliance/declarations-asked/${cr6.id}/remind`, { version: refusedOne.request.version }, 409)
    // SEED-SD-0003 (nickel, portal, OVERDUE, reminded once): its task is reminded.
    const nickel = await request(seed.requestIds.overdue)
    const reminded = await ok('quality', 'POST', `/compliance/declarations-asked/${nickel.id}/remind`, { version: nickel.version })
    expect(reminded.request).toMatchObject({ remindersSent: nickel.remindersSent + 1 })
    expect((await eventsOf('partner_task.reminded')).at(-1)).toMatchObject({ taskId: seed.taskId })
    // Asked again: the overdue one is withdrawn in the same command, the new one supersedes it with the same materials.
    const again = await ok('quality', 'POST', `/compliance/declarations-asked/${nickel.id}/ask-again`, { version: reminded.request.version, dueOn: '2026-12-15', channel: 'OFFICE' })
    expect(again.previous).toMatchObject({ number: 'SEED-SD-0003', status: 'CANCELLED' })
    expect(again.request).toMatchObject({ status: 'SENT', supersedesId: nickel.id, kind: 'NICKEL', lines: 1, channel: 'OFFICE' })
    expect((await request(nickel.id)).partnerTask).toMatchObject({ status: 'CANCELLED' })
    // The hourly job: a request still waiting after its due day moves OVERDUE (once).
    const late = newId()
    await admin(
      `INSERT INTO "SupplierDeclarationRequest" (id, "tenantId", "companyId", number, "partyId", kind, channel, "sentAt", "dueOn", "createdAt", "updatedAt") VALUES ($1, $2, $3, 'SEED-SD-0090', $4, 'OTHER', 'OFFICE', '2026-10-20T08:00:00Z', '2026-11-01', now(), now())`,
      [late, tenant, companyA, partyP2],
    )
    await admin(`INSERT INTO "SupplierDeclarationLine" (id, "tenantId", "partyId", "requestId", seq, "itemId", "articleLabel", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, 1, $5, 'Seed lining', now(), now())`, [newId(), tenant, partyP2, late, seed.itemIds.lining])
    const log = { info() {}, warn() {}, error() {} }
    const tick = await declarationsTick({ database, log, clock })
    expect(tick.overdue).toBeGreaterThanOrEqual(1)
    expect((await request(late)).status).toBe('OVERDUE')
    expect((await declarationsTick({ database, log, clock })).overdue).toBe(0)
    const list = await ok('viewer', 'GET', '/compliance/declarations-asked')
    expect(list.mayAsk).toBe(false)
    expect(list.counts.overdue).toBeGreaterThanOrEqual(1)
  })

  it('a database refusal answers 409 in words, never 500', async () => {
    // An SVHC declaration naming a substance that is not on the Candidate List: B-W2b-217's guard refuses it.
    const svhc = await request(seed.requestIds.again)
    const error = await refused('quality', 'PUT', `/compliance/declarations-asked/${svhc.id}/lines`, { version: svhc.version, lines: [{ lineId: svhc.lineRows[0].id, contains: true, aboveThreshold: true, substanceId: seed.substanceIds.nickel }] }, 409)
    expect(error.message).toMatch(/names an SVHC of the Candidate List/)
  })
})

describe('test plans (PRD-309)', () => {
  it('keeps the plan rules: a rule of its own test, off with the reason', async () => {
    const { plans } = await ok('viewer', 'GET', '/compliance/test-plans')
    expect(plans.map((plan: Json) => [plan.test, plan.switchedOn]).sort()).toEqual([['AZO', true], ['CR_VI', true], ['NICKEL', true], ['PAH', true], ['PFAS', false]])
    expect(paths(await refused('quality', 'POST', '/compliance/test-plans', { itemKind: 'TEXTILE', test: 'AZO', frequency: 'YEARLY', substanceRuleId: seed.ruleIds.nickel }, 400))).toEqual(['body/substanceRuleId'])
    await refused('viewer', 'POST', '/compliance/test-plans', { itemKind: 'TEXTILE', test: 'AZO', frequency: 'YEARLY' }, 403)
    const { plan } = await ok('quality', 'POST', '/compliance/test-plans', { itemKind: 'TEXTILE', test: 'AZO', frequency: 'YEARLY', substanceRuleId: seed.ruleIds.azo, method: 'EN ISO 14362-1' })
    expect(plan).toMatchObject({ test: 'AZO', frequencyWords: 'once a year', substanceRule: { key: 'REACH-XVII-43', limit: 'at most 30 mg/kg' }, switchedOn: true })
    expect(paths(await refused('quality', 'PUT', `/compliance/test-plans/${plan.id}/switch`, { version: plan.version, on: false }, 400))).toEqual(['body/reason'])
    const off = await ok('quality', 'PUT', `/compliance/test-plans/${plan.id}/switch`, { version: plan.version, on: false, reason: 'Until a textile style is sold in a market that asks for it.' })
    expect(off.plan).toMatchObject({ switchedOn: false })
    await refused('quality', 'PUT', `/compliance/test-plans/${plan.id}/switch`, { version: off.plan.version, on: false, reason: 'Again.' }, 409)
  })

  it('shows the tests due on the leather lot, records an azo result against its rule and the lot\'s due test is met', async () => {
    const due = await ok('viewer', 'GET', `/compliance/test-plans/lots/${lotLeather}`)
    expect(due.mayRecord).toBe(false)
    const status = (rows: Json[], test: string) => rows.find((row: Json) => row.test === test)?.status
    expect(status(due.due, 'CR_VI')).toBe('MET')
    expect(status(due.due, 'AZO')).toBe('DUE')
    expect((await ok('viewer', 'GET', '/compliance/test-plans/due')).lots.some((row: Json) => row.lot.id === lotLeather)).toBe(true)
    const pdf = Buffer.from('%PDF-1.4 made-up azo report')
    const announced = await ok('quality', 'POST', `/compliance/test-plans/lots/${lotLeather}/report`, { originalName: 'azo.pdf', contentType: 'application/pdf', sizeBytes: pdf.length, sha256: createHash('sha256').update(pdf).digest('hex') }, 201)
    expect((await app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: pdf })).statusCode).toBe(200)
    const body = { test: 'AZO', method: 'EN ISO 17234-1', valueMgKg: '8.5', lab: 'Seed Lab', testedOn: '2026-11-05', evidence: 'LOT_REPORT', fileId: announced.file.id }
    expect(paths(await refused('quality', 'POST', `/compliance/test-plans/lots/${lotLeather}/results`, { ...body, valueMgKg: null, belowDetectionLimit: true, detectionLimitMgKg: '50' }, 400))).toEqual(['body/detectionLimitMgKg'])
    await refused('viewer', 'POST', `/compliance/test-plans/lots/${lotLeather}/results`, body, 403)
    const recorded = await ok('quality', 'POST', `/compliance/test-plans/lots/${lotLeather}/results`, body, 201)
    expect(recorded).toMatchObject({ verdict: 'PASS', rule: { key: 'REACH-XVII-43' }, words: '8.5 mg/kg against at most 30 mg/kg (rule REACH-XVII-43): pass.' })
    expect(recorded.profile).not.toBeNull()
    const after = await ok('quality', 'GET', `/compliance/test-plans/lots/${lotLeather}`)
    expect(status(after.due, 'AZO')).toBe('MET')
    expect(after.results.find((row: Json) => row.test === 'AZO')).toMatchObject({ verdict: 'PASS', unit: 'mg/kg', limit: '30' })
    // W1's lot page stays chromium VI's.
    expect((await ok('quality', 'GET', `/quality/lots/${lotLeather}/results`)).results.every((row: Json) => row.test === 'CR_VI')).toBe(true)
  })

  it('a rule switched evaluates every profiled material again (the worker\'s handler)', async () => {
    const before = (await eventsOf('compliance_substances.profile_evaluated')).length
    const [handler] = reevaluateHandlers()
    await handler!.handle({ eventId: newId(), type: 'compliance_substances.rule_changed', version: 1, tenantId: tenant, companyId: null, siteId: null, subject: seed.ruleIds.pfas, correlationId: newId(), causationId: null, source: 'test', occurredAt: '2026-11-10T10:00:00.000Z', payload: {} } as never, { caller: system(), attempt: 1 })
    const profiled = (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "MaterialComplianceProfile" WHERE "tenantId" = $1`, [tenant]))[0]!.n
    expect((await eventsOf('compliance_substances.profile_evaluated')).length - before).toBe(profiled)
    // The same burst again: every profile was evaluated after it, nothing runs twice.
    await handler!.handle({ eventId: newId(), type: 'compliance_substances.rule_changed', version: 1, tenantId: tenant, companyId: null, siteId: null, subject: seed.ruleIds.pfas, correlationId: newId(), causationId: null, source: 'test', occurredAt: '2026-11-10T08:59:00.000Z', payload: {} } as never, { caller: system(), attempt: 1 })
    expect((await eventsOf('compliance_substances.profile_evaluated')).length - before).toBe(profiled)
  })
})
