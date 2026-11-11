import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { manifestText } from '@nexus/factory-domain/compliance/techfiles/rules'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seed as seedTechfiles, type TechfilesSeed } from '../../../../../../packages/factory-db/seed/techfiles'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { pdfFlatText } from '../../../platform/documents/testing/pdf-text'
import { systemContext } from '../../../platform/outbox/system'
import { buildPack } from './build'

/**
 * Technical files (B-W2b-251; PRD-296, PRD-299, PRD-301, PRD-302, QHS-048, QHS-110) through the app's real routes on a
 * throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and B-W2b-218's techfiles guards
 * are real), the harness's FAKE file store, on the technical files seed (SEED-JKT-01's file ARCHIVED, SEED-JKT-02's OPEN with
 * mixed items and a signed risk assessment plus a draft, SEED-JKT-03's COMPLETE; production-control tests; packs). The quality
 * person who signs and sends uses the harness's real sign-in (two-factor, step-up). Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/compliance/techfiles`.
 */

let h: Harness
let app: FastifyInstance
let seeded: TechfilesSeed

const NS = 'w2b251-techfiles'
const idOf = (key: string): string => seedUuid(NS, key)
const T = { tenant: idOf('tenant'), companyA: idOf('company:A'), companyB: idOf('company:B'), jkt01: idOf('product:style:JKT-01') }
const TENANT: TestTenant = { id: T.tenant, slug: NS, companies: [{ id: T.companyA, code: 'A' }, { id: T.companyB, code: 'B' }] }
const KEEPER: Permission[] = ['compliance.certificates.view', 'compliance.techfiles.manage', 'files.read', 'files.upload']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  keeper: { audience: 'office', tenantId: T.tenant, actorId: idOf('actor'), grants: [grant(KEEPER)] },
  viewer: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['compliance.certificates.view'])] },
  companyB: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(KEEPER, [T.companyB])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
let keys = 0
const key = () => `tf-${++keys}-${newId()}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const today = businessDate(new Date())
const eventsOf = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [T.tenant, type])).map((row) => row.payload)
const pointOf = (record: Json, point: string) => record.points.find((entry: Json) => entry.point === point)

interface Person {
  readonly id: string
  readonly browser: Browser
  readonly secret: string
}
let quality: Person
async function asPerson(method: 'GET' | 'POST', url: string, body: unknown, status: number): Promise<Json> {
  const answer = await quality.browser.send(method, url, body, { headers: { 'idempotency-key': key() } })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}

beforeAll(async () => {
  h = await startHarness('w2b251_techfiles')
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  seeded = await seedTechfiles({ db: h.database, namespace: NS })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [T.tenant])
  // The system roles as the templates hold them now (compliance.techfiles.* for the quality inspector).
  await h.database.withScope({ audience: 'office', tenantId: T.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
  const user = await addUser(h, TENANT, { email: 'quality.techfiles@example.com', role: 'quality_inspector' })
  const browser = new Browser(h.app)
  const answer = await browser.signIn(TENANT.slug, user.email, user.password)
  if ((answer.body as Json)?.status !== 'signed_in') throw new Error(`sign-in: ${answer.status} ${JSON.stringify(answer.body)}`)
  quality = { id: user.id, browser, secret: await enrolTotp(h, browser) }
}, 1_500_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

let jkt01File: Json

describe('technical files and the Annex III checklist (PRD-296)', () => {
  it('lists the files with their checklist, risk, tests and conformity per batch, and the tiles', async () => {
    const list = await ok('viewer', 'GET', '/compliance/techfiles')
    const byNumber = Object.fromEntries(list.files.map((row: Json) => [row.number, row]))
    expect(byNumber['SEED-TF-0001']).toMatchObject({ status: 'ARCHIVED', retainUntil: '2036-10-20', retention: 'KEPT' })
    expect(byNumber['SEED-TF-0002']).toMatchObject({ status: 'OPEN', style: { code: 'SEED-JKT-02' }, certificate: { status: expect.any(String) }, risk: { revision: 2, status: 'DRAFT' }, may: { manage: false } })
    expect(byNumber['SEED-TF-0002'].annex).toMatchObject({ outOf: 13, done: 4 })
    expect(byNumber['SEED-TF-0003']).toMatchObject({ status: 'COMPLETE', annex: { done: 13, missingItems: 0 } })
    expect(list.tiles).toMatchObject({ complete: 1 })
    expect(list.tiles.withItemsMissing).toBeGreaterThanOrEqual(1)
    expect(list.mayCreate).toBe(false)
    expect((await ok('viewer', 'GET', '/compliance/techfiles?tile=COMPLETE')).files.map((row: Json) => row.number)).toEqual(['SEED-TF-0003'])
    // Another company's person sees none of company A's files, and finds none by id.
    expect((await ok('companyB', 'GET', '/compliance/techfiles')).files).toEqual([])
    await no('companyB', 'GET', `/compliance/techfiles/${seeded.technicalFileIds.open}`, undefined, 404)
  })

  it('shows a file point by point with its evidence resolved, and says why it cannot be completed', async () => {
    const record = await ok('viewer', 'GET', `/compliance/techfiles/${seeded.technicalFileIds.open}`)
    expect(record.points.map((entry: Json) => entry.letter)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm'])
    expect(pointOf(record, 'A_DESCRIPTION')).toMatchObject({ law: 'Reg. (EU) 2016/425 Annex III (a)', state: 'REVIEWED' })
    expect(pointOf(record, 'J_PRODUCTION_CONTROL').state).toBe('MISSING')
    expect(pointOf(record, 'L_SINGLE_UNIT').state).toBe('NOT_APPLICABLE')
    const evidence = record.points.flatMap((entry: Json) => entry.items).find((item: Json) => item.evidence)?.evidence
    expect(evidence).toMatchObject({ label: expect.any(String), state: expect.any(String) })
    expect(record.completeProblems.map((issue: Json) => issue.path)).toContain('points/J_PRODUCTION_CONTROL')
  })

  it('opens one live file per style, numbered, with the obvious evidence linked (never reviewed by the system)', async () => {
    const jkt02 = (await admin<{ styleId: string }>('SELECT "styleId" FROM "TechnicalFile" WHERE id = $1', [seeded.technicalFileIds.open]))[0]!.styleId
    const refused = await no('keeper', 'POST', '/compliance/techfiles', { styleId: jkt02 }, 409)
    expect(refused.message).toMatch(/has technical file SEED-TF-0002 \(OPEN\)/)
    // SEED-JKT-01 is every company's: its company is said; its old file is archived, so a new one opens.
    expect((await no('keeper', 'POST', '/compliance/techfiles', { styleId: T.jkt01 }, 400)).issues[0].path).toBe('body/companyId')
    await no('viewer', 'POST', '/compliance/techfiles', { styleId: T.jkt01, companyId: T.companyA }, 403)
    jkt01File = await ok('keeper', 'POST', '/compliance/techfiles', { styleId: T.jkt01, companyId: T.companyA, keeperId: idOf('actor') })
    expect(jkt01File.file).toMatchObject({ number: expect.stringMatching(/^TF-\d{4}$/), status: 'OPEN', style: { code: 'SEED-JKT-01', ppeCategory: 'CATEGORY_II' }, keeper: { id: idOf('actor') } })
    expect(pointOf(jkt01File, 'A_DESCRIPTION').items[0]).toMatchObject({ state: 'LINKED', evidence: { kind: 'RECORD', recordType: 'Style', state: 'CURRENT' } })
    expect(pointOf(jkt01File, 'D_DRAWINGS').items[0].evidence.recordType).toBe('StyleRevision')
    expect(pointOf(jkt01File, 'F_STANDARDS').items.map((item: Json) => item.evidence.recordType)).toContain('Certificate')
    expect(pointOf(jkt01File, 'B_RISK_ASSESSMENT').items).toMatchObject([{ state: 'MISSING', evidence: null }])
    expect(jkt01File.points.every((entry: Json) => entry.items.length >= 1)).toBe(true)
    expect(jkt01File.points.flatMap((entry: Json) => entry.items).some((item: Json) => item.state === 'REVIEWED')).toBe(false)
    expect((await eventsOf('technical_file.changed')).at(-1)).toMatchObject({ number: jkt01File.file.number, change: 'CREATED', status: 'OPEN' })
  })

  it('links, reviews and marks points not applicable; refuses evidence of another style and a review without evidence', async () => {
    const id = jkt01File.file.id
    const a = pointOf(jkt01File, 'A_DESCRIPTION').items[0]
    const j = pointOf(jkt01File, 'J_PRODUCTION_CONTROL').items[0]
    // Another style's record is not this file's evidence.
    const otherRevision = (await admin<{ id: string }>(`SELECT r.id FROM "StyleRevision" r JOIN "Style" s ON s.id = r."styleId" WHERE s."tenantId" = $1 AND s.code = 'SEED-JKT-02' LIMIT 1`, [T.tenant]))[0]!.id
    expect((await no('keeper', 'PATCH', `/compliance/techfiles/${id}/items/${j.id}`, { version: j.version, recordType: 'StyleRevision', recordId: otherRevision }, 400)).message).toMatch(/another style/)
    expect((await no('keeper', 'PATCH', `/compliance/techfiles/${id}/items/${j.id}`, { version: j.version, recordType: 'Invoice', recordId: newId() }, 400)).message).toMatch(/is not evidence/)
    expect((await no('keeper', 'PATCH', `/compliance/techfiles/${id}/items/${j.id}`, { version: j.version, state: 'REVIEWED' }, 400)).issues[0].path).toBe('body/state')
    expect((await no('keeper', 'PATCH', `/compliance/techfiles/${id}/items/${j.id}`, { version: j.version, state: 'NOT_APPLICABLE' }, 400)).issues[0].path).toBe('body/note')
    let record = await ok('keeper', 'PATCH', `/compliance/techfiles/${id}/items/${a.id}`, { version: a.version, state: 'REVIEWED' })
    expect(pointOf(record, 'A_DESCRIPTION')).toMatchObject({ state: 'REVIEWED', items: [{ reviewedBy: { id: idOf('actor') } }] })
    // A second piece of evidence of point (j): an empty row, then the file's own risk assessment would go to (b).
    const added = await ok('keeper', 'POST', `/compliance/techfiles/${id}/items`, { point: 'J_PRODUCTION_CONTROL' })
    expect(pointOf(added.record, 'J_PRODUCTION_CONTROL').items.map((item: Json) => item.seq)).toEqual([1, 2])
    record = await ok('keeper', 'DELETE', `/compliance/techfiles/${id}/items/${added.itemId}?version=1`)
    expect(pointOf(record, 'J_PRODUCTION_CONTROL').items).toHaveLength(1)
    expect((await eventsOf('technical_file.item_changed')).map((event) => event.change)).toEqual(expect.arrayContaining(['REVIEWED', 'ADDED', 'REMOVED']))
  })

  it('completes only when every point is reviewed or not applicable, then refuses changes until reopened (409 in words, never 500)', async () => {
    const id = jkt01File.file.id
    let record = await ok('viewer', 'GET', `/compliance/techfiles/${id}`)
    const refused = await no('keeper', 'POST', `/compliance/techfiles/${id}/complete`, { version: record.file.version }, 409)
    expect(refused.issues.length).toBeGreaterThan(1)
    // Review what is linked; the rest (no evidence on the seed) is marked not applicable with why.
    for (const entry of record.points) {
      for (const item of entry.items) {
        const body = item.evidence ? { version: item.version, state: 'REVIEWED' } : { version: item.version, state: 'NOT_APPLICABLE', note: 'Made-up: not part of this check.' }
        if (item.state === 'REVIEWED') continue
        record = await ok('keeper', 'PATCH', `/compliance/techfiles/${id}/items/${item.id}`, body)
      }
    }
    // A category II style is complete only with its certificate: one that covers the style.
    expect(record.completeProblems.map((issue: Json) => issue.path)).toEqual(['certificateId'])
    expect((await no('keeper', 'PATCH', `/compliance/techfiles/${id}`, { version: record.file.version, certificateId: idOf('compliance:certificate:PRO-300') }, 400)).issues[0].path).toBe('body/certificateId')
    record = await ok('keeper', 'PATCH', `/compliance/techfiles/${id}`, { version: record.file.version, certificateId: idOf('compliance:certificate:JKT-01') })
    expect(record.completeProblems).toEqual([])
    record = await ok('keeper', 'POST', `/compliance/techfiles/${id}/complete`, { version: record.file.version })
    expect(record.file).toMatchObject({ status: 'COMPLETE', annex: { done: 13 }, completedBy: { id: idOf('actor') } })
    // The database refuses an item change on a COMPLETE file: a 409 in its words.
    const item = pointOf(record, 'G_OTHER_SPECIFICATIONS').items[0]
    const db = await no('keeper', 'PATCH', `/compliance/techfiles/${id}/items/${item.id}`, { version: item.version, note: 'Made-up change.' }, 409)
    expect(db.message).toMatch(/only while it is OPEN/)
    await no('keeper', 'POST', `/compliance/techfiles/${id}/reopen`, { version: record.file.version, reason: 'no' }, 400)
    record = await ok('keeper', 'POST', `/compliance/techfiles/${id}/reopen`, { version: record.file.version, reason: 'Made-up: the label changed.' })
    expect(record.file.status).toBe('OPEN')
    record = await ok('keeper', 'POST', `/compliance/techfiles/${id}/complete`, { version: record.file.version })
    jkt01File = record
  })

  it('offers the style\'s records and files as evidence, the point\'s first', async () => {
    const { options } = await ok('viewer', 'GET', `/compliance/techfiles/${jkt01File.file.id}/evidence-options?point=F_STANDARDS`)
    expect(options[0].points).toContain('F_STANDARDS')
    expect(options.some((option: Json) => option.recordType === 'Style' && option.linked)).toBe(true)
  })
})

describe('the product risk assessment (PRD-301)', () => {
  let assessment: Json
  it('drafts a revision, writes its hazards per row, refuses a wrong zone', async () => {
    const id = jkt01File.file.id
    let risk = await ok('keeper', 'POST', `/compliance/techfiles/${id}/risk`, { classReasoning: 'Made-up: AA, abrasion and impact zones tested.' })
    assessment = risk.assessments[0]
    expect(assessment).toMatchObject({ revision: 1, status: 'DRAFT', rows: [] })
    await no('keeper', 'POST', `/compliance/techfiles/${id}/risk`, {}, 409)
    expect((await no('keeper', 'POST', `/compliance/techfiles/${id}/risk/${assessment.id}/rows`, { hazard: 'ABRASION', garmentZone: 'Left Shoulder', intendedUse: 'Road riding', control: 'Leather 1.2 mm', residualRisk: 'LOW' }, 400)).issues[0].path).toBe('body/garmentZone')
    risk = await ok('keeper', 'POST', `/compliance/techfiles/${id}/risk/${assessment.id}/rows`, { hazard: 'ABRASION', garmentZone: 'shoulder', intendedUse: 'Road riding', foreseeableMisuse: 'Worn open', control: 'Leather 1.2 mm, double seams', standardClause: 'EN 17092-3:2020 6.3', residualRisk: 'LOW' })
    const row = risk.assessments[0].rows[0]
    risk = await ok('keeper', 'PATCH', `/compliance/techfiles/${id}/risk/${assessment.id}/rows/${row.id}`, { version: row.version, residualRisk: 'NEGLIGIBLE' })
    expect(risk.assessments[0].rows[0]).toMatchObject({ seq: 1, residualRisk: 'NEGLIGIBLE', garmentZone: 'shoulder' })
    assessment = risk.assessments[0]
  })

  it('is signed by the signer with a fresh code; the complete file goes back to OPEN and its point (b) follows', async () => {
    const id = jkt01File.file.id
    const url = `/compliance/techfiles/${id}/risk/${assessment.id}/sign`
    // The keeper (manage only) may not sign; the quality person needs a fresh code first.
    await no('keeper', 'POST', url, { version: assessment.version, name: 'Made-up Quality', function: 'Quality manager' }, 403)
    expect((await asPerson('POST', url, { version: assessment.version, name: 'Made-up Quality', function: 'Quality manager' }, 403)).error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
    await stepUp(h, quality.browser, quality.secret)
    const signed = await asPerson('POST', url, { version: assessment.version, name: 'Made-up Quality', function: 'Quality manager' }, 200)
    expect(signed.reopened).toBe(true)
    expect(signed.assessments[0]).toMatchObject({ status: 'SIGNED', signedByName: 'Made-up Quality', signedByFunction: 'Quality manager', signedBy: { id: quality.id } })
    const record = await ok('viewer', 'GET', `/compliance/techfiles/${id}`)
    expect(record.file.status).toBe('OPEN')
    expect(pointOf(record, 'B_RISK_ASSESSMENT').items.find((item: Json) => item.evidence?.recordType === 'ProductRiskAssessment')).toMatchObject({ state: 'LINKED', evidence: { recordId: assessment.id, state: 'CURRENT' } })
    // A signed revision changes no more (the database's words, 409).
    const row = signed.assessments[0].rows[0]
    expect((await no('keeper', 'PATCH', `/compliance/techfiles/${id}/risk/${assessment.id}/rows/${row.id}`, { version: row.version, residualRisk: 'LOW' }, 409)).message).toMatch(/changes? no more/)
    expect((await eventsOf('technical_file.risk_changed')).map((event) => event.change)).toEqual(expect.arrayContaining(['CREATED', 'ROWS', 'SIGNED']))
    jkt01File = record
  })
})

describe('production-control tests, conformity to type, kept ten years (QHS-048, PRD-302, QHS-110)', () => {
  let jkt02 = ''
  let workOrder = ''
  it('plans a test every batch, records it once, keeps it ten years', async () => {
    jkt02 = (await admin<{ styleId: string }>('SELECT "styleId" FROM "TechnicalFile" WHERE id = $1', [seeded.technicalFileIds.open]))[0]!.styleId
    workOrder = (await admin<{ id: string }>(`SELECT id FROM "WorkOrder" WHERE "styleId" = $1 AND "companyId" = $2 AND kind IN ('SIZE_GRID', 'MADE_TO_MEASURE') AND status NOT IN ('DRAFT', 'CANCELLED') ORDER BY "createdAt" LIMIT 1`, [jkt02, T.companyA]))[0]!.id
    const planned = await ok('keeper', 'POST', '/compliance/production-tests', { styleId: jkt02, companyId: T.companyA, workOrderId: workOrder, test: 'SEAM_STRENGTH', frequency: 'EVERY_BATCH', dueOn: today, sample: 'Made-up: size 52, three pieces' })
    expect(planned.test).toMatchObject({ result: null, frequency: 'EVERY_BATCH', workOrder: { id: workOrder }, retention: 'NOT_SET' })
    const url = `/compliance/production-tests/${planned.test.id}/record`
    expect((await no('keeper', 'POST', url, { version: planned.test.version, result: 'FAIL', testedOn: '2099-01-01', testedBy: 'Made-up Lab' }, 400)).issues.map((issue: Json) => issue.path)).toEqual(['body/testedOn', 'body/resultNote'])
    const recorded = await ok('keeper', 'POST', url, { version: planned.test.version, result: 'PASS', testedOn: today, testedBy: 'Made-up Lab', reportNumber: 'MU-001' })
    const kept = `${Number(today.slice(0, 4)) + 10}${today.slice(4)}`
    expect(recorded.test).toMatchObject({ result: 'PASS', testedOn: today, retainUntil: today.endsWith('02-29') ? recorded.test.retainUntil : kept, retention: 'KEPT' })
    await no('keeper', 'POST', url, { version: recorded.test.version, result: 'PASS', testedOn: today, testedBy: 'Made-up Lab' }, 409)
    // Not removed before its keep-until day (the API says it; the database would too).
    expect((await no('keeper', 'DELETE', `/compliance/production-tests/${planned.test.id}?version=${recorded.test.version}`, undefined, 409)).message).toMatch(/kept until/)
    expect((await eventsOf('technical_file.test_changed')).map((event) => event.change)).toEqual(expect.arrayContaining(['PLANNED', 'RECORDED']))
  })

  it("takes a lab report only through the test's own routes, then names it with the result, kept as long (B-W2b-278)", async () => {
    const planned = (await ok('keeper', 'POST', '/compliance/production-tests', { styleId: jkt02, companyId: T.companyA, workOrderId: workOrder, test: 'TEAR_STRENGTH', frequency: 'EVERY_BATCH', dueOn: today })).test
    const url = `/compliance/production-tests/${planned.id}/report`
    const report = Buffer.from('%PDF-1.4\n% made-up lab report\n%%EOF\n')
    const announce = { originalName: 'made-up-lab-report.pdf', contentType: 'application/pdf', sizeBytes: report.length, sha256: createHash('sha256').update(report).digest('hex') }
    // The generic files routes reach neither a test's files nor an evidence pack's (platform/files/owned.ts): a 409 naming the route.
    const generic = await call('keeper', 'POST', '/files', { companyId: T.companyA, recordType: 'ProductionControlTest', recordId: planned.id, kind: 'CERTIFICATE', ...announce })
    expect(generic.statusCode, generic.body).toBe(409)
    expect(generic.json().error.message).toContain('POST /compliance/production-tests/:testId/report')
    const packFile = await call('keeper', 'POST', '/files', { companyId: T.companyA, recordType: 'EvidencePack', recordId: seeded.packIds.built, kind: 'DOCUMENT', ...announce })
    expect(packFile.statusCode, packFile.body).toBe(409)
    expect(packFile.json().error.message).toContain('made by the API, never uploaded')
    // Refused: a report that is no PDF or picture (400), a person who does not keep the tests (403).
    expect((await no('keeper', 'POST', url, { ...announce, originalName: 'report.csv', contentType: 'text/csv' }, 400)).issues.map((issue: Json) => issue.path)).toEqual(['body/contentType'])
    await no('viewer', 'POST', url, announce, 403)
    const announced = await call('keeper', 'POST', url, announce)
    expect(announced.statusCode, announced.body).toBe(201)
    const { file, upload } = announced.json() as { file: Json; upload: { url: string; headers: Record<string, string> } }
    expect(file).toMatchObject({ recordType: 'ProductionControlTest', recordId: planned.id, kind: 'CERTIFICATE', status: 'PENDING_UPLOAD', companyId: T.companyA })
    const sent = await app.inject({ method: 'PUT', url: upload.url, headers: upload.headers, payload: report })
    expect(sent.statusCode, sent.body).toBe(200)
    // Confirmed only by the test's route too; another test's id finds no such file.
    expect((await call('keeper', 'POST', `/files/${file.id}/complete`)).statusCode).toBe(409)
    await no('keeper', 'POST', `/compliance/production-tests/${seeded.testIds.due}/report/${file.id}/complete`, undefined, 404)
    expect((await ok('keeper', 'POST', `${url}/${file.id}/complete`)).file).toMatchObject({ id: file.id, status: 'AVAILABLE' })
    const recorded = (await ok('keeper', 'POST', `/compliance/production-tests/${planned.id}/record`, { version: planned.version, result: 'PASS', testedOn: today, testedBy: 'Made-up Lab', reportNumber: 'MU-002', labReportFileId: file.id })).test
    expect(recorded.labReportFile).toMatchObject({ id: file.id, name: 'made-up-lab-report.pdf', sha256: announce.sha256 })
    const [kept] = await admin<{ retainUntil: Date }>('SELECT "retainUntil" FROM "StoredFile" WHERE id = $1', [file.id])
    expect(kept!.retainUntil.toISOString().slice(0, 10)).toBe(recorded.retainUntil)
    // A recorded test takes no other report: its report was named with the result.
    expect((await no('keeper', 'POST', url, announce, 409)).message).toMatch(/recorded already/)
  })

  it('shows conformity to type per batch and the plan of periodic tests', async () => {
    const production = await ok('viewer', 'GET', `/compliance/techfiles/${seeded.technicalFileIds.open}/production`)
    const batch = production.batches.find((row: Json) => row.workOrder.id === workOrder)
    expect(batch).toBeDefined()
    expect(batch.tests.map((test: Json) => test.test)).toContain('SEAM_STRENGTH')
    expect(['COMPLETE', 'MISSING', 'FAILED', 'IN_PROGRESS']).toContain(batch.evidence.state)
    expect(production.plan.some((entry: Json) => entry.test === 'SEAM_STRENGTH' && entry.frequency === 'EVERY_BATCH')).toBe(true)
    expect(production.tests.length).toBeGreaterThan(0)
    const reports = await ok('viewer', 'GET', `/compliance/techfiles/${seeded.technicalFileIds.open}/test-reports`)
    expect(reports.reports.some((row: Json) => row.source === 'CONTROL_TEST' && row.reportNumber === 'MU-001')).toBe(true)
  })
})

describe('evidence packs (PRD-299)', () => {
  let packId = ''
  it('builds a pack for an authority: every document with its SHA-256, the fingerprint, the PDF and the ZIP', async () => {
    const id = jkt01File.file.id
    await no('viewer', 'POST', `/compliance/techfiles/${id}/packs`, { purpose: 'AUTHORITY', language: 'de', recipient: 'Made-up authority', scope: { kind: 'STYLE' } }, 403)
    expect((await no('keeper', 'POST', `/compliance/techfiles/${id}/packs`, { purpose: 'AUTHORITY', language: 'de', recipient: 'Made-up authority', scope: { kind: 'BATCHES', batchNumbers: ['NO-SUCH-BATCH'] } }, 400)).issues[0].path).toMatch(/scope/)
    const asked = await ok('keeper', 'POST', `/compliance/techfiles/${id}/packs`, { purpose: 'AUTHORITY', language: 'de', recipient: 'Made-up market surveillance authority', scope: { kind: 'STYLE' }, include: ['TECHFILE_INDEX', 'RISK_ASSESSMENT', 'PRODUCTION_CONTROL', 'INSPECTIONS', 'LABELS'] })
    packId = asked.pack.id
    expect(asked.pack).toMatchObject({ status: 'BUILDING', number: expect.stringMatching(/^EP-\d{4}-\d{4}$/), contents: null })
    expect((await eventsOf('technical_file.pack_requested')).at(-1)).toMatchObject({ packId, purpose: 'AUTHORITY' })
    expect(await buildPack(callerFor(h.database, systemContext(T.tenant, newId())), packId, { files: h.files })).toBe('built')
    const { pack } = await ok('viewer', 'GET', `/compliance/evidence-packs/${packId}`)
    expect(pack).toMatchObject({ status: 'BUILT', retention: 'KEPT', pdf: { name: `${pack.number}.pdf` }, zip: { name: `${pack.number}.zip` } })
    expect(pack.contents.map((entry: Json) => entry.title)).toEqual(['Technical file index (Annex III)', 'Product risk assessment revision 1', 'Production-control tests', 'Final inspections and releases', 'Labels and print records'])
    const manifest = manifestText(pack.number, pack.contents)
    expect(pack.fingerprint).toBe(createHash('sha256').update(manifest).digest('hex'))
    // The ZIP holds the manifest and the PDF; the PDF says what a pack never holds.
    const zipRow = (await admin<{ storeAccountId: string; storageKey: string; sizeBytes: number }>('SELECT "storeAccountId", "storageKey", "sizeBytes" FROM "StoredFile" WHERE id = $1', [pack.zip.id]))[0]!
    const system = callerFor(h.database, systemContext(T.tenant, newId()))
    const zip = (await h.files.storage.read(system, zipRow.storeAccountId, zipRow.storageKey, zipRow.sizeBytes))!
    expect(zip.subarray(0, 4).toString('hex')).toBe('504b0304')
    expect(zip.includes(Buffer.from('SHA256SUMS.txt'))).toBe(true)
    // B-W2b-278 (FU4:01): the ZIP is a DOCUMENT file made through putGeneratedFile, like the PDF.
    expect((await admin('SELECT kind::text AS kind, "contentType", status::text AS status FROM "StoredFile" WHERE id = $1', [pack.zip.id]))[0]).toEqual({ kind: 'DOCUMENT', contentType: 'application/zip', status: 'AVAILABLE' })
    const pdfRow = (await admin<{ storeAccountId: string; storageKey: string; sizeBytes: number }>('SELECT "storeAccountId", "storageKey", "sizeBytes" FROM "StoredFile" WHERE id = $1', [pack.pdf.id]))[0]!
    const pdf = (await h.files.storage.read(system, pdfRow.storeAccountId, pdfRow.storageKey, pdfRow.sizeBytes))!
    const text = pdfFlatText(pdf)
    expect(text).toContain('Costs, prices and wages are never included.')
    expect(text).toContain(pack.number)
    expect((await admin('SELECT kind, language FROM "GeneratedDocument" WHERE "recordId" = $1', [packId]))[0]).toMatchObject({ kind: 'EVIDENCE_PACK', language: 'en' })
    // A built pack is kept ten years: not removed.
    expect((await no('keeper', 'DELETE', `/compliance/evidence-packs/${packId}?version=${pack.version}`, undefined, 409)).message).toMatch(/kept until/)
  })

  it('fails in words when a document is not in the file store as kept, and a failed pack may be removed', async () => {
    const asked = await ok('keeper', 'POST', `/compliance/techfiles/${seeded.technicalFileIds.complete}/packs`, { purpose: 'CUSTOMER', language: 'it', recipient: 'Made-up customer', scope: { kind: 'STYLE' }, include: ['DOC'] })
    expect(await buildPack(callerFor(h.database, systemContext(T.tenant, newId())), asked.pack.id, { files: h.files })).toBe('failed')
    const { pack } = await ok('viewer', 'GET', `/compliance/evidence-packs/${asked.pack.id}`)
    expect(pack).toMatchObject({ status: 'FAILED', may: { share: false } })
    expect(pack.failureReason).toMatch(/file store did not give/)
    await ok('keeper', 'DELETE', `/compliance/evidence-packs/${asked.pack.id}?version=${pack.version}`)
  })

  it('goes to the recipient by a DOCUMENT_VIEW link with a password and an end date (a fresh code), which can be withdrawn', async () => {
    const party = (await admin<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND status = 'ACTIVE' AND ("companyId" IS NULL OR "companyId" = $2) ORDER BY code LIMIT 1`, [T.tenant, T.companyA]))[0]!.id
    const expiresOn = businessDate(new Date(h.clock.now().getTime() + 30 * 24 * 60 * 60 * 1000))
    const body = { partyId: party, email: 'made-up.authority@example.com', password: 'made-up-pass-2026', expiresOn }
    await no('keeper', 'POST', `/compliance/evidence-packs/${packId}/link`, body, 403)
    await stepUp(h, quality.browser, quality.secret)
    expect((await asPerson('POST', `/compliance/evidence-packs/${packId}/link`, { ...body, password: 'short' }, 400)).error.issues[0].path).toBe('body/password')
    const shared = await asPerson('POST', `/compliance/evidence-packs/${packId}/link`, body, 200)
    expect(shared.url).toMatch(/\/l/)
    expect(shared.pack.links).toMatchObject([{ id: shared.linkId, email: 'made-up.authority@example.com', password: true, state: 'LIVE', opens: 0 }])
    const link = (await admin<{ purpose: string; passwordHash: string | null; recordType: string }>('SELECT purpose, "passwordHash", "recordType" FROM "OneOffLink" WHERE id = $1', [shared.linkId]))[0]!
    expect(link).toMatchObject({ purpose: 'DOCUMENT_VIEW', recordType: 'StoredFile' })
    expect(link.passwordHash).not.toBeNull()
    expect((await admin('SELECT "fileId" FROM "LinkFile" WHERE "linkId" = $1 ORDER BY position', [shared.linkId])).map((row: Json) => row.fileId)).toEqual([shared.pack.pdf.id, shared.pack.zip.id])
    const withdrawn = await asPerson('POST', `/compliance/evidence-packs/${packId}/links/${shared.linkId}/withdraw`, { reason: 'Made-up: sent to the wrong office.' }, 200)
    expect(withdrawn.pack.links[0].state).toBe('REVOKED')
    expect((await eventsOf('technical_file.pack_changed')).map((event) => event.change)).toEqual(expect.arrayContaining(['BUILT', 'FAILED', 'SHARED', 'LINK_WITHDRAWN', 'REMOVED']))
    // The tile counts the authority pack sent this year.
    expect((await ok('viewer', 'GET', '/compliance/techfiles')).tiles.authorityPacksSentThisYear).toBe(1)
  })

  it('archives a file with its reason, kept ten years and frozen', async () => {
    const record = await ok('viewer', 'GET', `/compliance/techfiles/${jkt01File.file.id}`)
    await no('keeper', 'POST', `/compliance/techfiles/${jkt01File.file.id}/archive`, { version: record.file.version, reason: 'Made-up: left the market.', retainUntil: '2030-01-01' }, 400)
    const archived = await ok('keeper', 'POST', `/compliance/techfiles/${jkt01File.file.id}/archive`, { version: record.file.version, reason: 'Made-up: left the market.' })
    expect(archived.file).toMatchObject({ status: 'ARCHIVED', archiveReason: 'Made-up: left the market.', retention: 'KEPT' })
    await no('keeper', 'PATCH', `/compliance/techfiles/${jkt01File.file.id}`, { version: archived.file.version, keeperId: null }, 409)
  })
})
