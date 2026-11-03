import { createHash, randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * The final inspection by plan (B-W2b-97; QHS-014 measurement charts, QHS-023 live accept/reject counter, QHS-049 final AQL
 * inspection, QHS-052 serial or batch check, QHS-053 made-to-measure final check, QHS-054 mandatory photo set) through the
 * app's real routes on a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security, W1's
 * Inspection_guard and B-W2b-76's Inspection_plan_guard, result and measurement guards are real), tenant A from EVERY seed
 * (FIN-JACKET v1 APPROVED: CE marking critical, chest 58 ± 1 cm, an instruction; AQL-STD the company default; SEED-WO-0001
 * in progress, batch-tracked; the files seed's FAKE R2 account behind the harness's local store). Office inspectors sign with
 * a fresh code (the harness's sign-in and step-up); the bench is a test floor session of the site's team leader (not a
 * maker). A second FINAL plan, a made-to-measure unit and the stop rule are written by SQL for the test (marked "planted").
 * Made-up words only. Run with `node scripts/factory/run-pg-tests.mjs modules/quality/final`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'final-plan'
const id = (key: string) => seedUuid(NS, key)
const firstId = (key: string) => `00000000${id(key).slice(8)}`
const A = {
  tenant: id('tenant'),
  companyA: id('company:A'),
  companyB: id('company:B'),
  siteA1: id('site:A1'),
  wo1: id('production:work-order:WO-0001'),
  wo2: firstId('production:work-order:WO-0002'),
  finJacket: firstId('inspection-plans:plan:FIN-JACKET'),
  vFinal1: id('inspection-plans:version:FIN-JACKET:1'),
  incoming: id('inspection-plans:plan:INC-LEATHER'),
  std: id('inspection-plans:aql:STD'),
  exm: firstId('inspection-plans:aql:EXM'),
  lead: id('worker:A1:lead'),
  operator: id('worker:A1:operator'),
  device: id('device:A1:cutting'),
  author: id('actor'),
  approver: id('inspection-plans:user:quality-manager'),
}
const TENANT: TestTenant = { id: A.tenant, slug: NS, companies: [{ id: A.companyA, code: 'A' }, { id: A.companyB, code: 'B' }] }

let h: Harness
let app: FastifyInstance
const grant = (permissions: readonly Permission[], scope: Partial<Grant> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })
const RECORD: Permission[] = ['quality.inspections.view', 'quality.inspections.record', 'files.read', 'files.upload']
const inspectorId = newId()
const SESSIONS: Record<string, SessionContext> = {
  inspector: { audience: 'office', tenantId: A.tenant, actorId: inspectorId, grants: [grant(RECORD)] },
  viewer: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(['quality.inspections.view'])] },
  companyB: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(RECORD, { companies: [A.companyB] })] },
  bench: { audience: 'floor', tenantId: A.tenant, actorId: A.lead, siteId: A.siteA1, deviceId: A.device, grants: [grant(['floor.work', 'quality.inspections.view', 'quality.inspections.record'], { companies: [A.companyA], sites: [A.siteA1] })] },
}

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `fp-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': freshKey() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json() as Json).error
}
const paths = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const events = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [A.tenant, type])).map((row) => row.payload)
const audits = async (recordId: string) => admin<{ action: string; after: Json; reason: string | null }>(`SELECT action, after, reason FROM "AuditLog" WHERE "tenantId" = $1 AND "recordType" = 'Inspection' AND "recordId" = $2 ORDER BY at, id`, [A.tenant, recordId])
const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex')
/** A write past the database's guards (the test's planted facts only: never what the test then proves). */
const force = async (sql: string) => {
  await h.db.admin.query(`BEGIN; SET LOCAL session_replication_role = replica; ${sql}; COMMIT;`)
}

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
async function as(person: Person, method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await person.browser.send(method as 'POST', url, body, { headers: { 'idempotency-key': freshKey() } })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}

let qa: Person
let finished = 0
const refs = { otherPlan: '', otherVersion: '', armour: '', office: '', photoPlan: '', w1: '', bench: '' }

/** A planted FINAL plan with an APPROVED version (FIXED sample) that applies to trousers only: never the suggestion for a jacket. */
async function plantOtherPlan(): Promise<{ planId: string; versionId: string }> {
  const planId = newId()
  const versionId = newId()
  await admin(`INSERT INTO "InspectionPlan" (id, "tenantId", "companyId", code, stage, name, "ownerId", "appliesTo") VALUES ($1, $2, $3, 'FIN-PHOTO', 'FINAL', 'Final with photos', $4, '[{"kind":"CATEGORY","value":"TROUSERS"}]')`, [planId, A.tenant, A.companyA, A.author])
  await admin(`INSERT INTO "InspectionPlanVersion" (id, "tenantId", "companyId", "planId", number, "authorId", "samplingMethod", "fixedSampleSize") VALUES ($1, $2, $3, $4, 1, $5, 'FIXED', 1)`, [versionId, A.tenant, A.companyA, planId, A.author])
  const check = (code: string, order: number, type: string, klass: string | null, mandatory: boolean, photo: boolean) =>
    admin(`INSERT INTO "InspectionPlanCheck" (id, "tenantId", "planVersionId", "sortOrder", code, "labelIt", "labelEn", type, "checkClass", mandatory, "photoRequired") VALUES ($1, $2, $3, $4, $5, $5, $6, $7::"InspectionCheckType", $8::"DefectClass", $9, $10)`, [
      newId(), A.tenant, versionId, order, code, code.charAt(0) + code.slice(1).toLowerCase(), type, klass, mandatory, photo,
    ])
  await check('CE_MARK', 10, 'PASS_FAIL', 'CRITICAL', true, false)
  await check('FRONT', 20, 'PHOTO', null, true, false)
  await check('LABEL', 30, 'PASS_FAIL', 'MINOR', false, true)
  await admin(`UPDATE "InspectionPlanVersion" SET status = 'APPROVED', "approvedById" = $2, "approvedAt" = now(), "approvalSha256" = repeat('a', 64) WHERE id = $1`, [versionId, A.approver])
  return { planId, versionId }
}

beforeAll(async () => {
  h = await startHarness('quality_final_plan')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE provider = 'R2'`)
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, clock: h.clock, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  qa = await signedIn('qa.plan@example.com', 'quality_inspector')
  // Planted: a bundle of two whole garments of SEED-WO-0001's size-52 cell (the seed's bundles are parts), reported good at
  // every operation, so two garments are finished (good at the final operation) and a lot of them is inspected through the routes.
  const [cell] = await admin<{ id: string }>(`SELECT id FROM "WorkOrderSize" WHERE "workOrderId" = $1 AND quantity = 2 ORDER BY id LIMIT 1`, [A.wo1])
  const bundleId = newId()
  await force(`INSERT INTO "Bundle" (id, "tenantId", "siteId", "workOrderId", "workOrderSizeId", code, quantity) VALUES ('${bundleId}', '${A.tenant}', '${A.siteA1}', '${A.wo1}', '${cell!.id}', 'PLANTED-BN-01', 2)`)
  for (const operation of await admin<{ id: string; seq: number }>(`SELECT id, seq FROM "WorkOrderOperation" WHERE "workOrderId" = $1 ORDER BY seq`, [A.wo1])) {
    await force(`INSERT INTO "OperationScan" (id, "tenantId", "siteId", "workOrderId", "workOrderOperationId", "bundleId", kind, "goodQuantity", "workerId", "clientScanId") VALUES ('${newId()}', '${A.tenant}', '${A.siteA1}', '${A.wo1}', '${operation.id}', '${bundleId}', 'REPORT', 2, '${A.operator}', 'planted-final-plan-${operation.seq}')`)
  }
  const bench = await ok('inspector', 'GET', '/quality/final/work-orders?number=SEED-WO-0001')
  finished = bench.workOrders[0].finished
  const other = await plantOtherPlan()
  refs.otherPlan = other.planId
  refs.otherVersion = other.versionId
  refs.armour = (await admin<{ id: string }>(`SELECT id FROM "DefectCode" WHERE "tenantId" = $1 AND code = 'ARMOUR-POCKET-MISSING'`, [A.tenant]))[0]!.id
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
})

const sheetOf = (session: string, inspectionId: string) => ok(session, 'GET', `/quality/inspections/${inspectionId}/sheet`)

describe('which plan applies, and the opening on it (QHS-049)', () => {
  it("FIN-JACKET applies to the jacket by its category; the AQL plan of the lot from the customer's profile", async () => {
    expect(finished).toBeGreaterThanOrEqual(2)
    const view = await ok('inspector', 'GET', `/quality/final/work-orders/${A.wo1}/plans?lotSize=2`)
    expect(view.suggestedId).toBe(A.finJacket)
    expect(view.words).toBe('FIN-JACKET v1 applies because: category Jacket.')
    expect(view.plans.find((plan: Json) => plan.code === 'FIN-PHOTO')).toMatchObject({ matches: false, usable: false, because: null })
    expect(view.sampling).toMatchObject({ method: 'AQL_PROFILE', sampleSize: 2, named: false, chain: { profile: { code: 'AQL-EXM' }, source: 'CUSTOMER' } })
    // The bench reads the same.
    expect((await ok('bench', 'GET', `/quality/final/work-orders/${A.wo1}/plans`)).suggestedId).toBe(A.finJacket)
  })

  it('opens on the plan in force: the version frozen, the sample from the AQL profile inside the command, the counter at 0', async () => {
    const opened = await ok('inspector', 'POST', '/quality/inspections', { workOrderId: A.wo1, lotSize: 2, planId: A.finJacket }, 201)
    const inspection = opened.inspection
    refs.office = inspection.id
    expect(inspection).toMatchObject({ status: 'OPEN', planVersion: { id: A.vFinal1, code: 'FIN-JACKET', number: 1 }, aqlProfileId: A.exm, codeLetter: 'A', inspected: 0, checklist: [] })
    expect(inspection.plan).toMatchObject({ lotSize: 2, sampleSize: 2, inspectionLevel: 'II', acceptMajor: 0, acceptMinor: 0 })
    const [row] = await admin<{ planVersionId: string; checklist: Json[] }>(`SELECT "planVersionId", checklist FROM "Inspection" WHERE id = $1`, [inspection.id])
    expect(row!.planVersionId).toBe(A.vFinal1)
    expect(row!.checklist).toEqual([{ code: 'AQL_SAMPLE', ok: null, note: '0 of 2 inspected', inspected: 0 }])
    expect((await audits(inspection.id))[0]!.after).toMatchObject({ plan: 'FIN-JACKET v1 applies', sampling: 'CUSTOMER', profileCode: 'AQL-EXM' })
  })

  it('refuses another stage, a typed sample on an AQL plan, another plan without the reason; keeps the reason when given', async () => {
    expect(paths(await refused('inspector', 'POST', '/quality/inspections', { workOrderId: A.wo1, lotSize: 2, planId: A.incoming }, 400))).toEqual(['body/planId'])
    const typed = await refused('inspector', 'POST', '/quality/inspections', { workOrderId: A.wo1, lotSize: 2, planId: A.finJacket, sampleSize: 2, inspectionLevel: 'II', aqlMajor: '2.5', aqlMinor: '4.0', acceptMajor: 0, acceptMinor: 0 }, 400)
    expect(paths(typed)).toContain('body/sampleSize')
    const noReason = await refused('inspector', 'POST', '/quality/inspections', { workOrderId: A.wo1, lotSize: 2, planId: refs.otherPlan }, 400)
    expect(paths(noReason)).toEqual(['body/planReason'])
    expect(noReason.message).toContain('FIN-PHOTO is not the plan that applies to this work order (FIN-JACKET does)')
    expect(paths(await refused('inspector', 'POST', '/quality/inspections', { workOrderId: A.wo1, lotSize: 2, planId: A.finJacket, planReason: 'Because' }, 400))).toEqual(['body/planReason'])
    const opened = await ok('inspector', 'POST', '/quality/inspections', { workOrderId: A.wo1, lotSize: 2, planId: refs.otherPlan, planReason: 'Customer asked for the photo set on this lot.' }, 201)
    refs.photoPlan = opened.inspection.id
    expect(opened.inspection).toMatchObject({ planVersion: { code: 'FIN-PHOTO' }, aqlProfileId: null, codeLetter: null, plan: { sampleSize: 1, inspectionLevel: 'FIXED', acceptMajor: 0, acceptMinor: 0 } })
    expect((await audits(opened.inspection.id))[0]).toMatchObject({ reason: 'Customer asked for the photo set on this lot.', after: { plan: 'FIN-PHOTO v1 named instead of FIN-JACKET v1', sampling: 'FIXED' } })
    // W1's typed opening without a plan is unchanged.
    const w1 = await ok('inspector', 'POST', '/quality/inspections', { workOrderId: A.wo1, lotSize: 2, sampleSize: 2, inspectionLevel: 'II', aqlMajor: '2.5', aqlMinor: '4.0', acceptMajor: 0, acceptMinor: 0 }, 201)
    expect(w1.inspection).toMatchObject({ planVersion: null, aqlProfileId: null, inspected: null })
    refs.w1 = w1.inspection.id
  })

  it("W1's PATCH never retypes a sample from a profile or a plan, nor a plan's checklist; a note still saves", async () => {
    const before = (await ok('inspector', 'GET', `/quality/inspections/${refs.office}`)).inspection
    const retype = await refused('inspector', 'PATCH', `/quality/inspections/${refs.office}`, { version: before.version, acceptMajor: 1, sampleSize: 2 }, 409)
    expect(paths(retype)).toEqual(['refusal/PROFILE_BOUND', 'body/acceptMajor'])
    expect(retype.message).toContain('The sampling plan comes from the AQL profile (code letter A)')
    expect(paths(await refused('inspector', 'PATCH', `/quality/inspections/${refs.office}`, { version: before.version, checklist: [{ code: 'CE_MARK', ok: true }] }, 409))).toEqual(['refusal/PLAN_CHECKS', 'body/checklist'])
    const saved = await ok('inspector', 'PATCH', `/quality/inspections/${refs.office}`, { version: before.version, sampleSize: 2, note: 'Two from the first carton.' })
    expect(saved.inspection).toMatchObject({ note: 'Two from the first carton.', version: before.version + 1 })
    // The W1 inspection keeps its typed plan editable.
    const w1 = (await ok('inspector', 'GET', `/quality/inspections/${refs.w1}`)).inspection
    expect((await ok('inspector', 'PATCH', `/quality/inspections/${refs.w1}`, { version: w1.version, acceptMinor: 1 })).inspection.plan.acceptMinor).toBe(1)
  })
})

describe('the bench records on the plan (QHS-014, QHS-023, QHS-052)', () => {
  it('results by check: the sheet says "1 of 2 checked"; an instruction, a measurement and a critical skipped in silence are refused', async () => {
    let sheet = await sheetOf('inspector', refs.office)
    expect(sheet.plan).toMatchObject({ code: 'FIN-JACKET', number: 1, samplingMethod: 'AQL_PROFILE' })
    expect(sheet.checks.map((check: Json) => [check.code, check.type, check.checkClass, check.takesResult])).toEqual([
      ['CE_MARK', 'PASS_FAIL', 'CRITICAL', true],
      ['CHEST', 'MEASUREMENT', 'MAJOR', true],
      ['READ', 'INSTRUCTION', null, false],
    ])
    const v = sheet.inspection.version
    const bad = await refused('inspector', 'PUT', `/quality/inspections/${refs.office}/results`, { version: v, results: [{ checkCode: 'CE_MARK', outcome: 'NOT_APPLICABLE' }, { checkCode: 'READ', outcome: 'PASS' }, { checkCode: 'CHEST', outcome: 'PASS', value: '58' }] }, 400)
    expect(paths(bad)).toEqual(['body/results/0/note', 'body/results/1/checkCode', 'body/results/2/checkCode'])
    expect(bad.issues[0].message).toContain('a safety check is never skipped in silence')
    sheet = await ok('inspector', 'PUT', `/quality/inspections/${refs.office}/results`, { version: v, results: [{ checkCode: 'CE_MARK', outcome: 'PASS' }] })
    expect(sheet.checksNow).toMatchObject({ answered: 1, outOf: 2, words: '1 of 2 checked · 0 failed · critical failed: none', mandatoryMissing: ['Chest half'] })
    expect(sheet.checks[0].results).toMatchObject([{ sampleIndex: 1, outcome: 'PASS', recordedBy: 'OFFICE', photos: [] }])
    expect(sheet.inspection.version).toBe(v + 1)
    // A stale version is refused.
    expect((await refused('inspector', 'PUT', `/quality/inspections/${refs.office}/results`, { version: v, results: [{ checkCode: 'CE_MARK', outcome: 'PASS' }] }, 409)).message).toMatch(/version/i)
  })

  it("the measurement chart: the plan's 58 ± 1 cm binds; a value out of tolerance in words; a point of the size chart typed whole", async () => {
    let sheet = await sheetOf('inspector', refs.office)
    const typedOver = await refused('inspector', 'PUT', `/quality/inspections/${refs.office}/measurements`, { version: sheet.inspection.version, measurements: [{ checkCode: 'CHEST', size: '52', measured: '58.4', nominal: '57', tolerance: '2' }] }, 400)
    expect(typedOver.message).toBe('The plan sets CHEST at 58 ± 1 cm: nothing else is typed.')
    expect(paths(await refused('inspector', 'PUT', `/quality/inspections/${refs.office}/measurements`, { version: sheet.inspection.version, measurements: [{ checkCode: 'CHEST', measured: '58.4' }] }, 400))).toEqual(['body/measurements/0/size'])
    sheet = await ok('inspector', 'PUT', `/quality/inspections/${refs.office}/measurements`, {
      version: sheet.inspection.version,
      measurements: [
        { checkCode: 'CHEST', size: '52', sampleIndex: 1, measured: '58.4' },
        { checkCode: 'CHEST', size: '54', sampleIndex: 2, measured: '59.8' },
        { pointCode: 'BACK-LENGTH', size: '52', measured: '70.2', nominal: '70', tolerance: '1' },
      ],
    })
    const chest = sheet.chart.points.find((point: Json) => point.checkCode === 'CHEST')
    expect(chest).toMatchObject({ source: 'PLAN', spec: '58 ± 1 cm' })
    expect(chest.values.map((value: Json) => [value.size, value.pass, value.words])).toEqual([
      ['52', true, 'within 58 ± 1 cm'],
      ['54', false, 'over by 0.8 cm'],
    ])
    expect(sheet.chart.points.find((point: Json) => point.pointCode === 'BACK-LENGTH')).toMatchObject({ source: 'TYPED', values: [{ pass: true }] })
    expect(sheet.chart.words).toBe('1 of 3 values out of tolerance')
    // The database wrote `pass`.
    expect((await admin<{ pass: boolean }>(`SELECT pass FROM "InspectionMeasurement" WHERE "inspectionId" = $1 AND size = '54'`, [refs.office]))[0]!.pass).toBe(false)
    expect(sheet.checksNow.failed).toEqual(['Chest half'])
    expect(sheet.result).toMatchObject({ resultNow: 'FAIL', byCountsOnly: false })
    expect(sheet.sign.pass.held).toBe(true)
    // Taken back: the chest of unit 2 again, within tolerance.
    sheet = await ok('inspector', 'PUT', `/quality/inspections/${refs.office}/measurements`, { version: sheet.inspection.version, measurements: [{ checkCode: 'CHEST', size: '54', sampleIndex: 2, measured: '58.9' }] })
    expect(sheet.chart.outOfTolerance).toBe(0)
  })

  it('the live counter: "+ one piece", never past the sample; a recorded message per write for the office and the bench', async () => {
    let sheet = await sheetOf('inspector', refs.office)
    sheet = await ok('inspector', 'POST', `/quality/inspections/${refs.office}/count`, { version: sheet.inspection.version, add: 1 })
    expect(sheet.counter).toMatchObject({ inspected: 1, sampleSize: 2, remaining: 1, verdict: 'open', words: '1 of 2 inspected', stop: { stop: false, source: 'PLAN' } })
    expect(paths(await refused('inspector', 'POST', `/quality/inspections/${refs.office}/count`, { version: sheet.inspection.version, inspected: 3 }, 400))).toEqual(['body/inspected'])
    sheet = await ok('inspector', 'POST', `/quality/inspections/${refs.office}/count`, { version: sheet.inspection.version, inspected: 2 })
    expect(sheet.counter).toMatchObject({ inspected: 2, verdict: 'accept' })
    const recorded = (await events('final_inspection.recorded')).filter((event) => event.inspectionId === refs.office)
    expect(recorded.map((event) => event.what)).toEqual(['RESULTS', 'MEASUREMENTS', 'MEASUREMENTS', 'COUNT', 'COUNT'])
    expect(recorded.at(-1)).toMatchObject({ inspected: 2, sampleSize: 2, verdict: 'accept', workOrderId: A.wo1 })
  })

  it('the batch check: the work order batch scanned once; another number fails the check', async () => {
    let sheet = await sheetOf('inspector', refs.office)
    expect(sheet.identity).toMatchObject({ mode: 'BATCH', batchNumber: 'SEED-BT-0001', done: false, ok: null })
    sheet = await ok('inspector', 'POST', `/quality/inspections/${refs.office}/identity`, { version: sheet.inspection.version, add: ['seed-bt-0009'] })
    expect(sheet.identity).toMatchObject({ done: true, ok: false, unknown: ['SEED-BT-0009'] })
    expect(sheet.result.reasons.join(' ')).toContain('Serial or batch check')
    sheet = await ok('inspector', 'POST', `/quality/inspections/${refs.office}/identity`, { version: sheet.inspection.version, remove: ['SEED-BT-0009'], add: ['SEED-BT-0001'] })
    expect(sheet.identity).toMatchObject({ done: true, ok: true, words: 'Batch SEED-BT-0001: checked.' })
    expect(paths(await refused('inspector', 'POST', `/quality/inspections/${refs.office}/identity`, { version: sheet.inspection.version, remove: ['NOPE'] }, 400))).toEqual(['body/remove/0'])
  })

  it('only its inspector records it; another company and a viewer are refused', async () => {
    const sheet = await sheetOf('viewer', refs.office)
    expect(sheet.may.record).toBe(false)
    await refused('viewer', 'POST', `/quality/inspections/${refs.office}/count`, { version: sheet.inspection.version, add: 1 }, 403)
    await refused('companyB', 'GET', `/quality/inspections/${refs.office}/sheet`, undefined, 404)
    // A W1 inspection has no plan's checks.
    const w1 = (await ok('inspector', 'GET', `/quality/inspections/${refs.w1}`)).inspection
    expect((await refused('inspector', 'POST', `/quality/inspections/${refs.w1}/count`, { version: w1.version, add: 1 }, 409)).message).toContain("W1's fixed checklist")
  })
})

describe('SAFETY (Reg. (EU) 2016/425): a critical line always fails and is never downgraded', () => {
  it('a defect the library classes critical is never recorded milder', async () => {
    const sheet = await sheetOf('inspector', refs.office)
    const downgrade = await refused('inspector', 'PUT', `/quality/inspections/${refs.office}/defects`, { version: sheet.inspection.version, defects: [{ defectClass: 'MINOR', code: 'ARMOUR-POCKET-MISSING', defectCodeId: refs.armour, quantity: 1 }] }, 400)
    expect(paths(downgrade)).toEqual(['body/defects/0/defectClass'])
    expect(downgrade.issues[0].message).toBe('ARMOUR-POCKET-MISSING is critical in the defect library (a safety or compliance failure): it is recorded critical, never minor.')
  })

  it('a failed critical check fails the lot: no PASS, not even with a reason; the database refuses a PASSED row over it', async () => {
    let sheet = await sheetOf('inspector', refs.photoPlan)
    // Front does not apply on this garment (not a critical check: no reason needed); every mandatory check is then answered.
    sheet = await ok('inspector', 'PUT', `/quality/inspections/${refs.photoPlan}/results`, { version: sheet.inspection.version, results: [{ checkCode: 'CE_MARK', outcome: 'FAIL', note: 'CE mark missing on the label.' }, { checkCode: 'FRONT', outcome: 'NOT_APPLICABLE' }] })
    expect(sheet.checksNow.failedCritical).toEqual(['Ce_mark'])
    expect(sheet.result).toMatchObject({ resultNow: 'FAIL', byCountsOnly: false })
    expect(sheet.sign.pass.reasons[0]).toContain('A PASS over this FAIL is never signed')
    expect(sheet.counter.verdict).toBe('reject')
    // The decision route refuses a PASS over it before any code is asked (the step-up comes after every check).
    const pass = await refused('inspector', 'POST', `/quality/inspections/${refs.photoPlan}/decide`, { version: sheet.inspection.version, result: 'PASS', overrideReason: 'The customer agreed.' }, 400)
    expect(pass.issues.map((issue: Json) => issue.path)).toContain('body/result')
    // The database is the last word: a PASSED row is refused even with a checklist that says otherwise.
    await expect(
      admin(`UPDATE "Inspection" SET status = 'PASSED', "decidedAt" = now(), "signatureSha256" = repeat('b', 64), checklist = '[{"code":"CE_MARK","ok":true,"note":null}]'::jsonb WHERE id = $1`, [refs.photoPlan]),
    ).rejects.toThrow(/does not PASS on its plan: critical check CE_MARK failed/)
  })
})

describe('photos of the results (QHS-054)', () => {
  async function photo(resultId: string, name: string): Promise<Json> {
    const body = Buffer.from(`made-up jpeg bytes ${name} ${newId()}`)
    const url = `/quality/inspections/${refs.photoPlan}/results/${resultId}/photos`
    const announced = await ok('inspector', 'POST', url, { originalName: name, contentType: 'image/jpeg', sizeBytes: body.length, sha256: sha(body) }, 201)
    expect(announced.file).toMatchObject({ kind: 'PHOTO', status: 'PENDING_UPLOAD' })
    const sent = await app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: body })
    expect(sent.statusCode, sent.body).toBe(200)
    const done = await ok('inspector', 'POST', `${url}/${announced.file.id}/complete`)
    expect(done.file).toMatchObject({ id: announced.file.id, status: 'AVAILABLE' })
    return done.file
  }

  it('the slots of the plan: Front missing, then taken; a "photo required" result holds every signature until its photo comes', async () => {
    let sheet = await sheetOf('inspector', refs.photoPlan)
    expect(sheet.photos).toMatchObject({ words: 'Front –', mandatoryMissing: [] })
    sheet = await ok('inspector', 'PUT', `/quality/inspections/${refs.photoPlan}/results`, { version: sheet.inspection.version, results: [{ checkCode: 'FRONT', outcome: 'PASS' }, { checkCode: 'LABEL', outcome: 'PASS' }] })
    expect(sheet.photos.waiting).toEqual(['Front', 'Photo with Label'])
    expect(sheet.sign.fail.reasons[0]).toContain('Take the photos the results need first')
    const front = sheet.checks.find((check: Json) => check.code === 'FRONT').results[0].id
    const label = sheet.checks.find((check: Json) => check.code === 'LABEL').results[0].id
    await photo(front, 'front.jpg')
    await photo(label, 'label.jpg')
    sheet = await sheetOf('inspector', refs.photoPlan)
    expect(sheet.photos).toMatchObject({ waiting: [], mandatoryMissing: [], words: 'Front ✓' })
    expect(sheet.photos.slots[0]).toMatchObject({ code: 'FRONT', state: 'TAKEN', photos: 1 })
    expect((await events('final_inspection.recorded')).filter((event) => event.inspectionId === refs.photoPlan && event.what === 'PHOTO')).toHaveLength(2)
  })
})

describe('the bench (the floor)', () => {
  it('opens on the plan at its site, records a result and counts; reads its sheet in its language; never a person', async () => {
    const opened = await ok('bench', 'POST', '/quality/inspections', { workOrderId: A.wo1, lotSize: 2, planId: A.finJacket }, 201)
    refs.bench = opened.inspection.id
    expect(opened.inspection).toMatchObject({ planVersion: { code: 'FIN-JACKET' }, inspector: { kind: 'FLOOR', workerId: A.lead } })
    let sheet = await sheetOf('bench', refs.bench)
    sheet = await ok('bench', 'PUT', `/quality/inspections/${refs.bench}/results`, { version: sheet.inspection.version, results: [{ checkCode: 'CE_MARK', sampleIndex: 1, outcome: 'PASS' }] })
    expect(sheet.checks[0].results[0]).toMatchObject({ recordedBy: 'FLOOR' })
    sheet = await ok('bench', 'POST', `/quality/inspections/${refs.bench}/count`, { version: sheet.inspection.version, add: 1 })
    expect(sheet.counter.inspected).toBe(1)
    const [row] = await admin<{ recordedByWorkerId: string; deviceId: string; recordedById: string | null }>(`SELECT "recordedByWorkerId", "deviceId", "recordedById" FROM "InspectionCheckResult" WHERE "inspectionId" = $1`, [refs.bench])
    expect(row).toMatchObject({ recordedByWorkerId: A.lead, deviceId: A.device, recordedById: null })
    expect(JSON.stringify(sheet)).not.toMatch(/Seed Worker|displayName/)
    // Another bench inspector (the office here) does not record it.
    await refused('inspector', 'PUT', `/quality/inspections/${refs.bench}/results`, { version: sheet.inspection.version, results: [{ checkCode: 'CE_MARK', outcome: 'PASS' }] }, 403)
  })
})

describe('made to measure (QHS-053), planted', () => {
  it("the rider's profile gives the nominal point by point; the tolerance is typed; never the rider's name", async () => {
    const profile = (await admin<{ id: string; measurements: Json }>(`SELECT p.id, p.measurements FROM "MeasurementProfile" p JOIN "WorkOrderSize" c ON c."partyId" = p."partyId" WHERE c."workOrderId" = $1 ORDER BY p.revision DESC LIMIT 1`, [A.wo2]))[0]!
    // Planted: SEED-WO-0002 becomes one made-to-measure unit in progress, and an OPEN inspection of it on FIN-JACKET v1.
    await force(`UPDATE "WorkOrder" SET status = 'IN_PROGRESS', kind = 'MADE_TO_MEASURE', "batchNumber" = 'SEED-BT-MTM1', "releasedAt" = now() WHERE id = '${A.wo2}'; UPDATE "WorkOrderSize" SET "measurementProfileId" = '${profile.id}' WHERE "workOrderId" = '${A.wo2}'`)
    const inspectionId = newId()
    await admin(
      `INSERT INTO "Inspection" (id, "tenantId", "companyId", "siteId", "workOrderId", number, "lotSize", "sampleSize", "inspectionLevel", "aqlMajor", "aqlMinor", "acceptMajor", "acceptMinor", "inspectorUserId", "createdById", "planVersionId", checklist)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 1, 'II', 2.5, 4.0, 0, 0, $7, $7, $8, '[{"code":"AQL_SAMPLE","ok":null,"note":"0 of 1 inspected","inspected":0}]'::jsonb)`,
      [inspectionId, A.tenant, A.companyA, A.siteA1, A.wo2, `T-INS-${inspectionId.slice(0, 8)}`, inspectorId, A.vFinal1],
    )
    let sheet = await sheetOf('inspector', inspectionId)
    const sleeve = profile.measurements.sleeve.value as string
    expect(sheet.chart.madeToMeasure).toMatchObject({ garmentType: 'JACKET', size: '52' })
    expect(sheet.chart.madeToMeasure.points.map((point: Json) => point.code)).toEqual(['chest', 'waist', 'sleeve'])
    expect(sheet.chart.points.find((point: Json) => point.pointCode === 'sleeve')).toMatchObject({ source: 'PROFILE', tolerance: null })
    expect(JSON.stringify(sheet)).not.toMatch(/Rider/)
    const noTolerance = await refused('inspector', 'PUT', `/quality/inspections/${inspectionId}/measurements`, { version: sheet.inspection.version, measurements: [{ pointCode: 'sleeve', measured: '65' }] }, 400)
    expect(paths(noTolerance)).toEqual(['body/measurements/0/tolerance'])
    sheet = await ok('inspector', 'PUT', `/quality/inspections/${inspectionId}/measurements`, { version: sheet.inspection.version, measurements: [{ pointCode: 'sleeve', measured: (Number(sleeve) + 0.4).toFixed(1), tolerance: '1' }, { pointCode: 'waist', measured: '200', tolerance: '1' }] })
    const values = (await admin<{ pointCode: string; nominal: string; pass: boolean; size: string; planCheckId: string | null }>(`SELECT "pointCode", nominal::text, pass, size, "planCheckId" FROM "InspectionMeasurement" WHERE "inspectionId" = $1 ORDER BY "pointCode"`, [inspectionId]))
    expect(values).toEqual([
      { pointCode: 'sleeve', nominal: Number(sleeve).toFixed(3), pass: true, size: '52', planCheckId: null },
      { pointCode: 'waist', nominal: Number(profile.measurements.waist.value).toFixed(3), pass: false, size: '52', planCheckId: null },
    ])
    expect(sheet.chart.points.find((point: Json) => point.pointCode === 'waist').values[0].words).toMatch(/^over by /)
  })
})

describe('the decision on a plan (W1 computes from the checklist written from the results)', () => {
  it('a PASS signed with every check, the batch, the whole sample: the checklist is the results by code; computed PASS', async () => {
    const opened = await as(qa, 'POST', '/quality/inspections', { workOrderId: A.wo1, lotSize: 2, planId: A.finJacket }, 201)
    const inspectionId = opened.inspection.id
    let v = opened.inspection.version
    v = (await as(qa, 'PUT', `/quality/inspections/${inspectionId}/results`, { version: v, results: [{ checkCode: 'CE_MARK', outcome: 'PASS' }] })).inspection.version
    v = (await as(qa, 'PUT', `/quality/inspections/${inspectionId}/measurements`, { version: v, measurements: [{ checkCode: 'CHEST', size: '52', measured: '58.3' }] })).inspection.version
    // Not yet: the sample and the batch.
    const early = await as(qa, 'POST', `/quality/inspections/${inspectionId}/decide`, { version: v, result: 'PASS' }, 400)
    expect(early.error.issues.map((issue: Json) => issue.path)).toEqual(['body/identity', 'body/inspected'])
    v = (await as(qa, 'POST', `/quality/inspections/${inspectionId}/identity`, { version: v, add: ['SEED-BT-0001'] })).inspection.version
    v = (await as(qa, 'POST', `/quality/inspections/${inspectionId}/count`, { version: v, inspected: 2 })).inspection.version
    await stepUp(h, qa.browser, qa.secret)
    const decided = (await as(qa, 'POST', `/quality/inspections/${inspectionId}/decide`, { version: v, result: 'PASS' })).inspection
    expect(decided).toMatchObject({ status: 'PASSED', computed: { result: 'PASS' }, overridden: false, planVersion: { code: 'FIN-JACKET' }, inspected: 2 })
    const [row] = await admin<{ checklist: Json[]; computedResult: string }>(`SELECT checklist, "computedResult" FROM "Inspection" WHERE id = $1`, [inspectionId])
    expect(row!.computedResult).toBe('PASS')
    expect(row!.checklist.map((entry) => [entry.code, entry.ok])).toEqual([
      ['CE_MARK', true],
      ['CHEST', true],
      ['AQL_SAMPLE', null],
      ['IDENTITY', true],
    ])
    expect(decided.checklist.map((entry: Json) => entry.code)).toEqual(['CE_MARK', 'CHEST'])
  })

  it('a FAIL before the whole sample: refused while the rule is "finish the sample"; signed once the rule stops at the reject number and the sample rejects', async () => {
    // FIN-JACKET v1 says "finish the sample" itself (stopAtReject false); the planted FIN-PHOTO leaves it to the quality settings.
    const opened = await as(qa, 'POST', '/quality/inspections', { workOrderId: A.wo1, lotSize: 2, planId: refs.otherPlan, planReason: 'Made-up reason: photo set asked for this lot.' }, 201)
    const inspectionId = opened.inspection.id
    expect(opened.inspection.plan.sampleSize).toBe(1)
    const v = (await as(qa, 'PUT', `/quality/inspections/${inspectionId}/defects`, { version: opened.inspection.version, defects: [{ defectClass: 'CRITICAL', code: 'ARMOUR-POCKET-MISSING', defectCodeId: refs.armour, quantity: 1 }] })).inspection.version
    await stepUp(h, qa.browser, qa.secret)
    const finish = await as(qa, 'POST', `/quality/inspections/${inspectionId}/decide`, { version: v, result: 'FAIL' }, 400)
    expect(finish.error.issues.map((issue: Json) => issue.path)).toEqual(['body/inspected'])
    expect(finish.error.message).toContain('Finish the whole sample (the quality setting of the group)')
    // Planted: the tenant's quality setting stops at the reject number.
    await admin(`UPDATE "QualitySettings" SET "stopAtRejectNumber" = true WHERE id = $1`, [A.tenant])
    const sheet = await as(qa, 'GET', `/quality/inspections/${inspectionId}/sheet`)
    expect(sheet.counter).toMatchObject({ inspected: 0, verdict: 'reject', stop: { stop: true, source: 'TENANT' } })
    expect(sheet.sign.fail).toEqual({ held: false, reasons: [] })
    const decided = (await as(qa, 'POST', `/quality/inspections/${inspectionId}/decide`, { version: v, result: 'FAIL' })).inspection
    expect(decided).toMatchObject({ status: 'FAILED', computed: { result: 'FAIL' }, inspected: 0 })
    await admin(`UPDATE "QualitySettings" SET "stopAtRejectNumber" = false WHERE id = $1`, [A.tenant])
  })
})
