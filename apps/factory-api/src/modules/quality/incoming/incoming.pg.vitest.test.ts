import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
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
 * The incoming inspection of a lot, hide by hide (B-W2b-98; QHS-025, QHS-028, QHS-034, MES-054) through the app's real
 * routes on a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the
 * …_inspection_plans_w2b_guards and …_leather_stock_w2b_guards triggers are real), tenant A from EVERY seed (INC-LEATHER v1
 * approved on AQL-STD with its mandatory shade check; SEED-IIN-0001 OPEN on SEED-LOT-LEA-01; the cowhide's grades and black
 * shade groups; the LEATHER defects). Made-up lots of black hides in quarantine. The decision is signed through the
 * harness's real sign-in (an office quality inspector with two-factor, step-up); the other routes run as test sessions of
 * the same person, and as the A1 inspection tablet. Made-up words only.
 *   - scan a lot and open it: the plan that applies, ISO 2859-1's sample of whole hides; a second OPEN inspection refused;
 *   - hide by hide: area against the tannery (a HideMeasure naming the inspection), shade group, grade, marks; refusals;
 *     the found counts from the marks; the sample full; a hide taken out;
 *   - the plan checks; the decision split (failed sample: reject and sort), signed, the hides graded and marked, what
 *     comes next in words; a whole lot accepted on a clean sample; the floor at its own site; the list; a cancellation.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/quality/incoming`.
 */

type Json = Record<string, any>
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'incoming-a'
let h: Harness
let app: FastifyInstance
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `inc-${run}-${++keys}`

const id = (key: string) => seedUuid(NS, key)
const A = {
  tenant: id('tenant'),
  company: id('company:A'),
  companyB: id('company:B'),
  site: id('site:A1'),
  siteB: id('site:B1'),
  leather: id('product:item:leather'),
  leatherBLK: id('product:item-colour:leather:BLK'),
  worker: id('worker:A1:operator'),
  device: id('device:A1:cutting'),
  seededLot: '',
}
const TENANT: TestTenant = { id: A.tenant, slug: NS, companies: [{ id: A.company, code: 'SCA' }, { id: A.companyB, code: 'SCB' }] }

const grant = (permissions: readonly Permission[], scope: Partial<Grant> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })
const RECORD: Permission[] = ['quality.incoming.view', 'quality.incoming.record']
const SESSIONS: Record<string, SessionContext> = {}

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'
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
const MONEY = /cost|price|margin|amount|wage|valuation/i
const keysOf = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : [])

/** A made-up lot of black hides of 50 ft² each, in quarantine, received by someone else. */
async function addLot(name: string, count: number): Promise<{ lotId: string; code: string; hides: { id: string; code: string }[] }> {
  const lotId = newId()
  const code = `T-${run}-${name}`
  await admin(`INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "dyeBatch", "receivedAt", "createdById", "requiresCrViTest", "crViLimitMgKg", "crViStatus") VALUES ($1, $2, $3, $4, $5, $6, $7, '7731', now(), $8, true, '3.000', 'PENDING')`, [
    lotId,
    A.tenant,
    A.company,
    A.site,
    A.leather,
    A.leatherBLK,
    code,
    newId(),
  ])
  const hides: { id: string; code: string }[] = []
  for (let n = 1; n <= count; n++) {
    const hide = { id: newId(), code: `${code}-H${String(n).padStart(2, '0')}` }
    await admin(`INSERT INTO "Hide" (id, "tenantId", "siteId", "lotId", "itemId", code, area, "areaUom", "baseArea") VALUES ($1, $2, $3, $4, $5, $6, '50.0000', 'FT2', '50.0000')`, [hide.id, A.tenant, A.site, lotId, A.leather, hide.code])
    hides.push(hide)
  }
  return { lotId, code, hides }
}

let inspector: { id: string; browser: Browser; secret: string }
let lot12: Awaited<ReturnType<typeof addLot>>
let lot3: Awaited<ReturnType<typeof addLot>>
let lotFloor: Awaited<ReturnType<typeof addLot>>
let groups: Record<string, string>
let grades: Record<string, string>

beforeAll(async () => {
  h = await startHarness('quality_incoming')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  const user = await addUser(h, TENANT, { email: 'incoming.inspector@example.com', role: 'quality_inspector' })
  const browser = new Browser(h.app)
  const signed = await browser.signIn(TENANT.slug, user.email, user.password)
  if (signed.body.status !== 'signed_in') throw new Error(`sign-in: ${signed.status} ${JSON.stringify(signed.body)}`)
  inspector = { id: user.id, browser, secret: await enrolTotp(h, browser) }
  Object.assign(SESSIONS, {
    // The same office person as the harness's signed-in inspector (who signs with the step-up).
    keeper: { audience: 'office', tenantId: A.tenant, actorId: inspector.id, grants: [grant(RECORD)] },
    other: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(RECORD)] },
    viewer: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(['quality.incoming.view'])] },
    nobody: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(['sites.view'])] },
    bench: { audience: 'floor', tenantId: A.tenant, actorId: A.worker, siteId: A.site, deviceId: A.device, grants: [grant(['floor.work', ...RECORD], { companies: [A.company], sites: [A.site] })] },
    benchB: { audience: 'floor', tenantId: A.tenant, actorId: newId(), siteId: A.siteB, deviceId: newId(), grants: [grant(['floor.work', ...RECORD], { companies: [A.companyB], sites: [A.siteB] })] },
  } satisfies Record<string, SessionContext>)
  lot12 = await addLot('L12', 12)
  lot3 = await addLot('L3', 3)
  lotFloor = await addLot('LF', 3)
  A.seededLot = (await admin<{ id: string }>(`SELECT "lotId"::text AS id FROM "IncomingInspection" WHERE "tenantId" = $1 AND number = 'SEED-IIN-0001'`, [A.tenant]))[0]!.id
  groups = Object.fromEntries((await admin<{ id: string; label: string }>(`SELECT id::text, label FROM "ShadeGroup" WHERE "tenantId" = $1 AND "itemId" = $2 AND "lotId" IS NULL`, [A.tenant, A.leather])).map((row) => [row.label, row.id]))
  grades = Object.fromEntries((await admin<{ id: string; code: string }>(`SELECT id::text, code FROM "LeatherGrade" WHERE "tenantId" = $1`, [A.tenant])).map((row) => [row.code, row.id]))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

let main: Json

describe('scan the lot and open it', () => {
  it('says what opening would give, then opens on the plan that applies with the sample of whole hides', async () => {
    const scan = await ok('keeper', 'GET', `/quality/incoming/lots/${lot12.lotId}`)
    expect(scan.open).toBeNull()
    expect(scan.opening).toMatchObject({ plan: { code: 'INC-LEATHER', number: 1 }, lotSize: '12.0000', uom: 'HIDE', sampleSize: 5, words: { en: 'Inspect 5 of 12 hides', it: 'Controlla 5 pelli su 12' }, refusal: null })
    main = await ok('keeper', 'POST', '/quality/incoming', { lotId: lot12.lotId }, 201)
    expect(main.inspection).toMatchObject({ status: 'OPEN', lotSize: '12.0000', uom: 'HIDE', byHide: true, sampleSize: 5, codeLetter: 'B', inspectionLevel: 'II', acceptMajor: 0, acceptMinor: 0 })
    expect(main.inspection.number).toMatch(/^IIN-\d{4}-\d{4}$/)
    expect(main.sampling).toMatchObject({ method: 'AQL', profile: { code: 'AQL-STD' }, words: { en: 'Inspect 5 of 12 hides · 0 done' } })
    expect(main.plan).toMatchObject({ code: 'INC-LEATHER', number: 1 })
    expect(main.inspector).toEqual({ kind: 'OFFICE', name: 'incoming inspector', hidden: false })
    expect(main.yours).toBe(true)
    expect(main.candidates).toHaveLength(12)
    expect(main.choices.shadeGroups.map((group: Json) => group.label)).toEqual(expect.arrayContaining(['1', '2', '3']))
    expect(main.choices.hideDefects.map((defect: Json) => defect.code)).toEqual(expect.arrayContaining(['HIDE-SCAR', 'LOOSE-GRAIN']))
    expect(main.checks.map((check: Json) => check.code)).toEqual(['SHADE', 'THICKNESS'])
    expect(keysOf(main).filter((key) => MONEY.test(key))).toEqual([])
    expect(await events('incoming_inspection.opened')).toEqual([expect.objectContaining({ incomingInspectionId: main.inspection.id, lotId: lot12.lotId, lotSize: '12.0000', uom: 'HIDE', sampleSize: 5, postedBy: 'OFFICE' })])
  })

  it('refuses a second OPEN inspection of a lot, in words; and who may not open', async () => {
    const twice = await refused('other', 'POST', '/quality/incoming', { lotId: lot12.lotId }, 409)
    expect(twice.message).toBe(`Lot ${lot12.code} has an open incoming inspection already, ${main.inspection.number}: finish or cancel it first.`)
    expect((await refused('keeper', 'POST', '/quality/incoming', { lotId: A.seededLot }, 409)).message).toMatch(/has an open incoming inspection already, SEED-IIN-0001/)
    const seeded = await ok('keeper', 'GET', `/quality/incoming/lots/${A.seededLot}`)
    expect(seeded.open.inspection.number).toBe('SEED-IIN-0001')
    await refused('viewer', 'POST', '/quality/incoming', { lotId: lot3.lotId }, 403)
    await refused('nobody', 'GET', `/quality/incoming/lots/${lot3.lotId}`, undefined, 403)
    await refused('benchB', 'GET', `/quality/incoming/lots/${lot3.lotId}`, undefined, 404)
    expect(paths(await refused('keeper', 'POST', '/quality/incoming', { lotId: lot3.lotId, planId: newId() }, 400))).toEqual(['body/planId'])
  })
})

describe('hide by hide', () => {
  const put = (session: string, hideIndex: number, body: Json, status = 200) => (status === 200 ? ok(session, 'PUT', `/quality/incoming/${main.inspection.id}/hides/${lot12.hides[hideIndex]!.id}`, { version: main.inspection.version, ...body }) : refused(session, 'PUT', `/quality/incoming/${main.inspection.id}/hides/${lot12.hides[hideIndex]!.id}`, { version: main.inspection.version, ...body }, status))

  it('measures a hide against the tannery, sorts it into a shade group, grades it and accepts it', async () => {
    main = await put('keeper', 0, { measuredArea: '49.5', declaredArea: '50', areaUom: 'FT2', shadeGroupId: groups['1'], gradeId: grades['A'], decision: 'ACCEPTED' })
    expect(main.hides[0]).toMatchObject({ code: lot12.hides[0]!.code, seq: 1, measured: true, measuredArea: '49.5000', declaredArea: '50.0000', areaUom: 'FT2', areaCheck: { differencePercent: '-1.00', outcome: 'WITHIN' }, shadeGroup: { label: '1' }, grade: { code: 'A' }, decision: 'ACCEPTED' })
    expect(main.progress).toMatchObject({ done: 1, remaining: 4, accepted: 1 })
    expect(main.areaCheck).toMatchObject({ hides: 1, outcome: 'WITHIN', opensClaim: false, tolerancePercent: '2.00', toleranceFrom: 'DEFAULT' })
    const measures = await admin(`SELECT "measuredArea"::text AS area, "declaredArea"::text AS declared, "measuredById"::text AS by FROM "HideMeasure" WHERE "incomingInspectionId" = $1`, [main.inspection.id])
    expect(measures).toEqual([{ area: '49.5000', declared: '50.0000', by: inspector.id }])
    expect(await events('inventory.hide_measured')).toEqual(expect.arrayContaining([expect.objectContaining({ hideId: lot12.hides[0]!.id, outcome: 'WITHIN', moveId: null })]))
    // The hide itself takes its grade and shade only when the decision is signed.
    expect((await admin(`SELECT "gradeId" FROM "Hide" WHERE id = $1`, [lot12.hides[0]!.id]))[0]).toEqual({ gradeId: null })
  })

  it('marks defects and zones on the hide map; the found counts follow (a hide once, under its worst class)', async () => {
    main = await put('keeper', 1, {
      shadeGroupId: groups['2'],
      marks: [
        { kind: 'DEFECT', x: 0.41, y: 0.32, code: 'HIDE-SCAR', zone: 'B' },
        { kind: 'DEFECT', x: 0.7, y: 0.2, code: 'LOOSE-GRAIN' },
        { kind: 'ZONE', x: 0.5, y: 0.8, zone: 'C', outline: [{ x: 0.3, y: 0.7 }, { x: 0.7, y: 0.7 }, { x: 0.5, y: 0.95 }] },
      ],
      decision: 'REJECTED',
      note: 'Scar across the back (made up).',
    })
    expect(main.hides[1]).toMatchObject({ measured: false, measuredArea: '50.0000', worstClass: 'MAJOR', decision: 'REJECTED' })
    expect(main.hides[1].marks.map((mark: Json) => [mark.kind, mark.code, mark.defectClass])).toEqual([['DEFECT', 'HIDE-SCAR', 'MAJOR'], ['DEFECT', 'LOOSE-GRAIN', 'MINOR'], ['ZONE', null, null]])
    expect(main.inspection.found).toEqual({ critical: 0, major: 1, minor: 0 })
    expect(main.result).toMatchObject({ resultNow: 'FAIL', byCountsOnly: true, progress: { inspected: 2, sampleSize: 5 } })
  })

  it('refuses in words: a grade or group not of the article, a defect not in the library, a hide of another lot, a cut hide, a stale screen, another inspector', async () => {
    expect(paths(await put('keeper', 2, { gradeId: grades['D'] }, 400))).toEqual(['body/gradeId'])
    const lining = (await admin<{ id: string }>(`SELECT id::text FROM "ShadeGroup" WHERE "tenantId" = $1 AND "itemId" <> $2 LIMIT 1`, [A.tenant, A.leather]))[0]!.id
    expect((await put('keeper', 2, { shadeGroupId: lining }, 400)).message).toMatch(/of another article/)
    expect(paths(await put('keeper', 2, { marks: [{ kind: 'DEFECT', x: 0.1, y: 0.1, code: 'NOT-A-DEFECT' }] }, 400))).toEqual(['body/marks/0/code'])
    expect(paths(await put('keeper', 2, { marks: [{ kind: 'DEFECT', x: 1.4, y: 0.1, code: 'HIDE-SCAR' }] }, 400))).toEqual(['body/marks/0/x'])
    await refused('keeper', 'PUT', `/quality/incoming/${main.inspection.id}/hides/${lot3.hides[0]!.id}`, { version: main.inspection.version }, 404)
    await admin(`UPDATE "Hide" SET state = 'PARTLY_CUT' WHERE id = $1`, [lot12.hides[11]!.id])
    expect((await put('keeper', 11, { decision: 'ACCEPTED' }, 409)).message).toMatch(/whole hides only/)
    await refused('keeper', 'PUT', `/quality/incoming/${main.inspection.id}/hides/${lot12.hides[2]!.id}`, { version: main.inspection.version - 1, decision: 'ACCEPTED' }, 409)
    await refused('other', 'PUT', `/quality/incoming/${main.inspection.id}/hides/${lot12.hides[2]!.id}`, { version: main.inspection.version, decision: 'ACCEPTED' }, 403)
  })

  it('fills the sample, refuses a hide beyond it, takes one out', async () => {
    for (const index of [2, 3, 4]) main = await put('keeper', index, { decision: 'ACCEPTED' })
    expect(main.progress).toMatchObject({ done: 5, remaining: 0, accepted: 4, rejected: 1, undecided: 0 })
    expect((await put('keeper', 5, { decision: 'ACCEPTED' }, 409)).message).toBe('The sample is 5 hides: all are recorded. Take one out first.')
    main = await ok('keeper', 'DELETE', `/quality/incoming/${main.inspection.id}/hides/${lot12.hides[4]!.id}?version=${main.inspection.version}`)
    expect(main.progress.done).toBe(4)
    main = await put('keeper', 5, { decision: 'ACCEPTED' })
    expect(main.hides.map((hide: Json) => hide.seq)).toEqual([1, 2, 3, 4, 5])
  })
})

describe('the plan checks and the decision (QHS-034)', () => {
  it('answers the plan checks by type', async () => {
    const shade = main.checks.find((check: Json) => check.code === 'SHADE').id
    const thickness = main.checks.find((check: Json) => check.code === 'THICKNESS').id
    expect(paths(await refused('keeper', 'PUT', `/quality/incoming/${main.inspection.id}/results`, { version: main.inspection.version, results: [{ planCheckId: shade, outcome: 'PASS', value: '9' }] }, 400))).toEqual(['body/results/0/value'])
    expect(paths(await refused('keeper', 'PUT', `/quality/incoming/${main.inspection.id}/results`, { version: main.inspection.version, results: [{ planCheckId: thickness, outcome: 'PASS', value: '1.6' }] }, 400))).toEqual(['body/results/0/outcome'])
    main = await ok('keeper', 'PUT', `/quality/incoming/${main.inspection.id}/results`, { version: main.inspection.version, results: [{ planCheckId: shade, outcome: 'PASS', value: '1' }, { planCheckId: thickness, outcome: 'PASS', value: '1.25' }] })
    expect(main.checksNow.mandatoryMissing).toEqual([])
    expect(main.checks[0].answers).toEqual([expect.objectContaining({ sampleIndex: 1, outcome: 'PASS', value: '1' })])
  })

  it('refuses what does not add up, accepting outside a failed sample, the whole lot over a FAIL without a reason; asks the step-up', async () => {
    const url = `/quality/incoming/${main.inspection.id}/decide`
    expect(paths(await refused('keeper', 'POST', url, { version: main.inspection.version, accepted: '4', rejected: '1', toSort: '6' }, 400))).toEqual(['body/toSort'])
    expect((await refused('keeper', 'POST', url, { version: main.inspection.version, accepted: '11', rejected: '1', toSort: '0' }, 400)).message).toMatch(/^The sample fails/)
    expect(paths(await refused('keeper', 'POST', url, { version: main.inspection.version, accepted: '12', rejected: '0', toSort: '0' }, 400))).toEqual(expect.arrayContaining(['body/rejected']))
    const noCode = await inspector.browser.post(url, { version: main.inspection.version, accepted: '4', rejected: '1', toSort: '7' })
    expect(noCode.status).toBe(403)
    expect(noCode.body.error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
  })

  it('signs the split: the hides take their grade and shade, the marks stay with the hide, the lot waits for the quality role', async () => {
    await stepUp(h, inspector.browser, inspector.secret)
    const signed = await inspector.browser.post(`/quality/incoming/${main.inspection.id}/decide`, { version: main.inspection.version, accepted: '4', rejected: '1', toSort: '7' }, { headers: { 'idempotency-key': freshKey() } })
    expect(signed.status, JSON.stringify(signed.body)).toBe(200)
    main = signed.body
    expect(main.inspection).toMatchObject({ status: 'DECIDED', computedResult: 'FAIL', overrideReason: null, decision: { accepted: '4.0000', rejected: '1.0000', toSort: '7.0000' } })
    expect(main.inspection.signatureSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(main.next).toMatchObject({ step: 'SORT', lotStatus: 'QUARANTINE', lotRoute: `/quality/lots/${lot12.lotId}/release`, rejectedHides: [{ code: lot12.hides[1]!.code }] })
    expect(main.next.returnPrefill).toMatchObject({ kind: 'RETURN', foundAt: 'INSPECTION', from: { lotId: lot12.lotId, hideIds: [lot12.hides[1]!.id] } })
    expect(main.next.holdPrefill).toMatchObject({ subjectType: 'Hide', subjectIds: [lot12.hides[1]!.id] })
    expect(main.next.words.en).toMatch(/7 hides to sort/)
    expect(main.may).toEqual({ record: false, decide: false, cancel: false })
    const hide0 = (await admin(`SELECT grade, "gradeId"::text AS "gradeId", shade, "shadeGroupId"::text AS "shadeGroupId" FROM "Hide" WHERE id = $1`, [lot12.hides[0]!.id]))[0]
    expect(hide0).toEqual({ grade: 'A', gradeId: grades['A'], shade: '1', shadeGroupId: groups['1'] })
    const marks = await admin(`SELECT kind, x::text, "incomingInspectionId"::text AS inspection FROM "HideMark" WHERE "hideId" = $1 ORDER BY x`, [lot12.hides[1]!.id])
    expect(marks.map((mark) => [mark.kind, mark.x, mark.inspection])).toEqual([['DEFECT', '0.41000', main.inspection.id], ['ZONE', '0.50000', main.inspection.id], ['DEFECT', '0.70000', main.inspection.id]])
    expect((await admin(`SELECT "qualityStatus" FROM "Lot" WHERE id = $1`, [lot12.lotId]))[0]).toEqual({ qualityStatus: 'QUARANTINE' })
    expect(await events('incoming_inspection.decided')).toEqual([expect.objectContaining({ incomingInspectionId: main.inspection.id, computedResult: 'FAIL', accepted: '4.0000', rejected: '1.0000', toSort: '7.0000', next: 'SORT', overridden: false, postedBy: 'OFFICE' })])
    expect((await events('inventory.hide_graded')).filter((event) => event.lotId === lot12.lotId)).toHaveLength(2)
    // A signed inspection never changes.
    await refused('keeper', 'PUT', `/quality/incoming/${main.inspection.id}/hides/${lot12.hides[6]!.id}`, { version: main.inspection.version, decision: 'ACCEPTED' }, 409)
  })

  it('opens the sorting inspection of the rest once the first is decided, and cancels it with the reason', async () => {
    const sorting = await ok('bench', 'POST', '/quality/incoming', { lotId: lot12.lotId }, 201)
    expect(sorting.inspector).toEqual({ kind: 'FLOOR', name: null, hidden: false })
    expect(sorting.lot.supplier).toBeNull()
    expect(paths(await refused('bench', 'POST', `/quality/incoming/${sorting.inspection.id}/cancel`, { version: sorting.inspection.version, reason: 'no' }, 400))).toEqual(['body/reason'])
    const cancelled = await ok('bench', 'POST', `/quality/incoming/${sorting.inspection.id}/cancel`, { version: sorting.inspection.version, reason: 'Opened on the wrong pallet (made up).' })
    expect(cancelled.inspection).toMatchObject({ status: 'CANCELLED', cancelReason: 'Opened on the wrong pallet (made up).' })
    expect(await events('incoming_inspection.cancelled')).toEqual([expect.objectContaining({ incomingInspectionId: sorting.inspection.id, postedBy: 'FLOOR' })])
  })
})

describe('a clean lot, the floor, the list', () => {
  it('accepts the whole lot on a clean sample once the mandatory check is answered; next: the lot release', async () => {
    let clean = await ok('keeper', 'POST', '/quality/incoming', { lotId: lot3.lotId }, 201)
    expect(clean.inspection).toMatchObject({ sampleSize: 3, lotSize: '3.0000' })
    expect(clean.sampling.words.en).toBe('Inspect all 3 hides · 0 done')
    for (const hide of lot3.hides) clean = await ok('keeper', 'PUT', `/quality/incoming/${clean.inspection.id}/hides/${hide.id}`, { version: clean.inspection.version, decision: 'ACCEPTED', gradeId: grades['B'] })
    expect((await refused('keeper', 'POST', `/quality/incoming/${clean.inspection.id}/decide`, { version: clean.inspection.version, accepted: '3', rejected: '0', toSort: '0' }, 400)).message).toBe('Answer the mandatory checks before accepting the whole lot: Shade against the swatch.')
    const shade = clean.checks.find((check: Json) => check.code === 'SHADE').id
    clean = await ok('keeper', 'PUT', `/quality/incoming/${clean.inspection.id}/results`, { version: clean.inspection.version, results: [{ planCheckId: shade, outcome: 'PASS', value: '2' }] })
    await stepUp(h, inspector.browser, inspector.secret)
    const signed = await inspector.browser.post(`/quality/incoming/${clean.inspection.id}/decide`, { version: clean.inspection.version, accepted: '3', rejected: '0', toSort: '0' }, { headers: { 'idempotency-key': freshKey() } })
    expect(signed.status, JSON.stringify(signed.body)).toBe(200)
    expect(signed.body.inspection).toMatchObject({ status: 'DECIDED', computedResult: 'PASS', decision: { accepted: '3.0000' } })
    expect(signed.body.next).toMatchObject({ step: 'RELEASE', returnPrefill: null, holdPrefill: null })
    expect(signed.body.next.words.en).toContain('never the person who received it')
  })

  it('the inspection tablet records at its own site, never names a person, and checks the decision before the PIN', async () => {
    let bench = await ok('bench', 'POST', '/quality/incoming', { lotId: lotFloor.lotId }, 201)
    bench = await ok('bench', 'PUT', `/quality/incoming/${bench.inspection.id}/hides/${lotFloor.hides[0]!.id}`, { version: bench.inspection.version, measuredArea: '4.4', areaUom: 'M2', decision: 'ACCEPTED' })
    expect(bench.hides[0]).toMatchObject({ measured: true, measuredArea: '4.4000', areaUom: 'M2', areaCheck: { outcome: 'SHORT' } })
    const measure = (await admin(`SELECT "measuredById", "measuredByWorkerId"::text AS worker, "deviceId"::text AS device FROM "HideMeasure" WHERE "incomingInspectionId" = $1`, [bench.inspection.id]))[0]
    expect(measure).toEqual({ measuredById: null, worker: A.worker, device: A.device })
    expect(paths(await refused('bench', 'POST', `/quality/incoming/${bench.inspection.id}/decide`, { version: bench.inspection.version, accepted: '3', rejected: '0', toSort: '0' }, 400))).toEqual(expect.arrayContaining(['body/accepted']))
    await refused('benchB', 'GET', `/quality/incoming/${bench.inspection.id}`, undefined, 404)
    // The office sees the floor inspector's kind; the name only where the site's PERFORMANCE gate is open.
    const office = await ok('viewer', 'GET', `/quality/incoming/${bench.inspection.id}`)
    expect(office.inspector.kind).toBe('FLOOR')
    expect(office.may).toEqual({ record: false, decide: false, cancel: false })
  })

  it('lists the inspections the caller sees, newest first, with no person', async () => {
    const list = await ok('viewer', 'GET', `/quality/incoming?lotId=${lot12.lotId}`)
    expect(list.items.map((row: Json) => row.status)).toEqual(['CANCELLED', 'DECIDED'])
    expect(list.items[1]).toMatchObject({ number: main.inspection.number, done: 5, decision: { toSort: '7.0000' }, inspectorKind: 'OFFICE', lot: { code: lot12.code } })
    expect(keysOf(list).filter((key) => /name/i.test(key) && key !== 'name')).toEqual([])
    const open = await ok('bench', 'GET', '/quality/incoming?status=OPEN')
    expect(open.items.every((row: Json) => row.siteId === A.site)).toBe(true)
    expect((await ok('benchB', 'GET', '/quality/incoming')).items).toEqual([])
  })
})
